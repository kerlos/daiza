// 解析パイプラインの React バインディング。
//
// analysis/pipeline.ts の二相解析を、アプリ状態（画像・パラメータ）の変化へ接続する。
// SPEC の「パラメータ変更時は 解析 → 状態更新 → 再描画 を即時実行」を満たす唯一の
// 駆動点であり、ロジック自体は持たず「いつ解析を回し、結果をどう dispatch するか」だけを
// 担う（useAppState が reducer を React へ繋ぐのと同じ責務分離）。
//
// 大画像フリーズ対策（SPEC「重い解析でメインスレッドを塞がない」）として、重い第 1 相
// （analyzeImage：全画素走査・外形抽出、O(W×H)）は Web Worker で実行する。ImageData の
// ArrayBuffer は Transferable として Worker へ転送（コピーなし）し、解析後に転送で返して
// もらう。往復の間メインスレッド側の imageData は detach されるため、戻ったバッファから
// ImageData を復元して state へ差し戻す（restoreImageData）。この復元では FigureImage.id を
// 据え置くことで、参照変化を新規読み込みと誤認して第 1 相を再投入するループを防ぐ。
//
// パラメータのみ変更の第 2 相（runAnalysis：軽量）は Worker を跨がずメインスレッドで
// 即時計算する（「オーバーレイのみの更新で済む場合は画像解析全体を再実行しない」）。

import { useEffect, useRef, useState } from 'react';

import type { AnalysisWorkerRequest, AnalysisWorkerResponse } from '@/analysis/analysis.worker';
import { analyzeImage, runAnalysis, type ImageAnalysis } from '@/analysis/pipeline';
import type { AppStateActions } from '@/hooks/useAppState';
import { toUnexpectedError } from '@/model/errors';
import type { AppState } from '@/model/state';

/**
 * 確定した第 1 相結果と、それがどの画像に属するか（FigureImage.id）。
 * 画像とパラメータが噛み合った時だけ第 2 相を回すため、結果に「どの画像のものか」を
 * 添えて保持する。Worker 応答は非同期に届くので、届いた時点の画像との整合を id で照合する。
 */
interface Phase1 {
  forId: number;
  value: ImageAnalysis;
}

/**
 * 画像またはパラメータが変わるたびに解析を実行し、結果／エラーを状態へ反映する。
 *
 * 第 1 相（重い走査）は Worker で非同期実行し、その結果を Phase1 として保持する。
 * 第 2 相（軽量）は image・第 1 相結果・parameters が揃うたびメインスレッドで即時計算する。
 * reducer は setImage / updateParameters の時点で result を陳腐化（null 化）するため、
 * この hook はそれを埋め直す役割を持つ。二相とも想定内の失敗は型付き結果で返るが、
 * 想定外の例外（バグ等）はここで捕捉して UI 表示可能なエラーへ写し、白画面クラッシュを防ぐ。
 */
export function useAnalysis(state: AppState, actions: AppStateActions): void {
  const { image, parameters } = state;

  // 確定済みの第 1 相結果。Worker 応答（非同期）で埋まる。
  const [phase1, setPhase1] = useState<Phase1 | null>(null);

  // Worker は 1 度だけ生成し、その onmessage から常に最新の actions を触れるよう ref 経由にする。
  // ref の更新はレンダー中ではなく effect で行う（レンダー中の ref 書き換えは避ける）。
  const actionsRef = useRef(actions);
  useEffect(() => {
    actionsRef.current = actions;
  }, [actions]);

  const workerRef = useRef<Worker | null>(null);
  // 現在有効なリクエスト世代。新規投入で ++ し、古い応答（別画像の結果）を弾く鍵にする。
  const requestIdRef = useRef(0);
  // 直近に Worker へ投げた画像 id。restore による参照変化で第 1 相を再投入しないための番兵。
  const lastPostedIdRef = useRef<number | null>(null);

  // Worker の生成と応答処理（マウント時 1 回）。応答で第 1 相結果を確定し、転送で戻った
  // バッファから ImageData を復元して state へ差し戻す。
  useEffect(() => {
    let worker: Worker | null = null;
    try {
      // Vite はこの静的な new URL を解析して Worker をバンドルする（相対パス指定が必要）。
      worker = new Worker(new URL('../analysis/analysis.worker.ts', import.meta.url), {
        type: 'module',
      });
    } catch {
      // Worker 非対応環境ではメインスレッド同期解析へフォールバックする（下の投入 effect）。
      workerRef.current = null;
      return;
    }

    worker.onmessage = (event: MessageEvent<AnalysisWorkerResponse>) => {
      const { requestId, outcome, buffer, width, height } = event.data;
      // 世代不一致は古い画像の応答。転送で戻ったバッファは破棄（GC）し、状態は触らない。
      if (requestId !== requestIdRef.current) {
        return;
      }
      const acts = actionsRef.current;
      // detach 済みのメインスレッド側 imageData を、戻ったバッファから復元して差し戻す。
      // これで第 2 相の差込口探索や Preview の再描画が有効な画素を参照できる。
      const imageData = new ImageData(new Uint8ClampedArray(buffer), width, height);
      acts.restoreImageData(imageData);

      if (outcome.ok) {
        // どの画像の応答かは、世代一致が保証する（新規投入があれば requestId が進む）。
        setPhase1({ forId: lastPostedIdRef.current ?? -1, value: outcome.value });
      } else {
        // 第 1 相の失敗（透明画像等）はそのまま提示。第 2 相は回さない。
        acts.failAnalysis(outcome.error);
        setPhase1(null);
      }
    };

    worker.onerror = () => {
      // Worker 内の想定外エラー。握り潰さず UI へ出し、解析中のまま固まらせない。
      actionsRef.current.failAnalysis(
        toUnexpectedError(new Error('解析ワーカーでエラーが発生しました。')),
      );
    };

    workerRef.current = worker;
    return () => {
      worker?.terminate();
      workerRef.current = null;
    };
  }, []);

  // 第 1 相の投入：新規画像のときだけ Worker へ走査を依頼する。
  useEffect(() => {
    if (!image) {
      // 画像なし。進行中の応答を無効化する（世代を進めて古い応答を弾く）。第 1 相結果は
      // 明示クリアしない：画像 id は単調増加のため、下の第 2 相ガード（forId 照合）が
      // 陳腐化した結果を自然に無視する。
      lastPostedIdRef.current = null;
      requestIdRef.current++;
      return;
    }
    // restore による参照変化（id 据え置き）は再投入しない。既に解析済み／解析中。
    if (image.id === lastPostedIdRef.current) {
      return;
    }

    lastPostedIdRef.current = image.id;
    const requestId = ++requestIdRef.current;
    actions.startAnalysis();

    const worker = workerRef.current;
    if (!worker) {
      // フォールバック：Worker 非対応時のみメインスレッドで同期解析する（従来挙動）。
      // 転送しないので imageData は有効なまま、復元も不要。setState を effect 本体から
      // 逃がしつつ 'analyzing' を一度描画させるため次タスクへ遅延し、切替済みなら破棄する。
      const targetImage = image;
      const timer = setTimeout(() => {
        if (requestId !== requestIdRef.current) {
          return;
        }
        const outcome = analyzeImage(targetImage);
        if (outcome.ok) {
          setPhase1({ forId: targetImage.id, value: outcome.value });
        } else {
          actionsRef.current.failAnalysis(outcome.error);
        }
      }, 0);
      return () => clearTimeout(timer);
    }

    // ImageData の buffer を転送して Worker へ委譲する。転送後この imageData は detach され、
    // Worker から復元バッファが戻る（restore）まではメインスレッドで画素を触らない。
    const buffer = image.imageData.data.buffer;
    const request: AnalysisWorkerRequest = {
      requestId,
      buffer,
      width: image.width,
      height: image.height,
    };
    worker.postMessage(request, [buffer]);
  }, [image, actions]);

  // 第 2 相：画像・第 1 相結果・パラメータが揃うたびに軽量計算して結果を確定する。
  // restore（image 参照更新）や第 1 相確定（phase1 更新）、パラメータ変更で再実行される。
  useEffect(() => {
    // 第 1 相が未確定、または結果が現在の画像に属さない（投入直後で応答待ち）なら回さない。
    if (!image || !phase1 || phase1.forId !== image.id) {
      return;
    }

    try {
      const outcome = runAnalysis(image, phase1.value, parameters);
      if (outcome.ok) {
        actions.succeedAnalysis(outcome.result);
      } else {
        actions.failAnalysis(outcome.error);
      }
    } catch (cause) {
      // 型付き結果で表せない予期しない失敗。握り潰さずエラー状態として提示する。
      actions.failAnalysis(toUnexpectedError(cause));
    }
  }, [image, phase1, parameters, actions]);
}
