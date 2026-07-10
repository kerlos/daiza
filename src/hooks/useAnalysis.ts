// 解析パイプラインの React バインディング。
//
// analysis/pipeline.ts の純粋な二相解析を、アプリ状態（画像・パラメータ）の変化へ
// 接続する。SPEC の「パラメータ変更時は 解析 → 状態更新 → 再描画 を即時実行」を
// 満たす唯一の駆動点であり、ロジック自体は持たず「いつ解析を回し、結果をどう
// dispatch するか」だけを担う（useAppState が reducer を React へ繋ぐのと同じ責務分離）。
//
// パフォーマンス（SPEC「オーバーレイのみの更新で済む場合は画像解析全体を再実行
// しない」）のため、重い第 1 相（analyzeImage：全画素走査）は画像単位で useMemo に
// メモ化し、パラメータ変更では再実行しない。パラメータに依存する軽量な第 2 相
// （runAnalysis）だけを effect で回して結果を更新する。

import { useEffect, useMemo } from 'react';

import { analyzeImage, runAnalysis } from '@/analysis/pipeline';
import type { AppStateActions } from '@/hooks/useAppState';
import { toUnexpectedError } from '@/model/errors';
import type { AppState } from '@/model/state';

/**
 * 画像またはパラメータが変わるたびに解析を実行し、結果／エラーを状態へ反映する。
 *
 * 第 1 相（analyzeImage）は画像だけに依存する O(W×H) の重い走査なので、image を
 * 依存に持つ useMemo に載せ、パラメータ変更では再計算されないようにする。これが
 * 「パラメータ変更＝オーバーレイのみ更新」を成立させる要（3000px 級での快適動作の肝）。
 *
 * effect 側は第 1 相の結果とパラメータから第 2 相（runAnalysis：軽量）を回す。
 * reducer は setImage / updateParameters の時点で result を陳腐化（null 化）するため、
 * この effect はそれを埋め直す役割を持つ。依存は image・memo 済みの imageAnalysis・
 * parameters の参照（更新アクションが新しい参照を作る）と、安定参照の actions。
 * startAnalysis 自体は参照を変えないため、ここから再解析ループには入らない。
 *
 * 画像未読み込み時は解析対象が無いので何もしない。二相とも同期・純粋関数で、想定内の
 * 失敗は例外ではなく型付き結果で返る。ただし想定外の例外（バグ等）はどの段でも起こり
 * 得るため、ここで捕捉して UI 表示可能なエラーへ写し、React のレンダリングを巻き込む
 * クラッシュ（白画面）を防ぐ（SPEC のクラッシュ防止要件）。
 */
export function useAnalysis(state: AppState, actions: AppStateActions): void {
  const { image, parameters } = state;

  // 第 1 相：画像だけに依存する重い走査。画像が変わった時だけ実行する。
  const imageAnalysis = useMemo(() => (image ? analyzeImage(image) : null), [image]);

  useEffect(() => {
    if (!image || !imageAnalysis) {
      return;
    }

    // 解析開始を明示。現状 runAnalysis は同期で完結するため 'analyzing' はほぼ即座に
    // 'ready'/'error' へ置き換わるが、将来 Web Worker 等で非同期化する際の接続点を残す。
    actions.startAnalysis();

    // 第 1 相が失敗（透明画像等）なら、そのエラーをそのまま提示して終了する。
    if (!imageAnalysis.ok) {
      actions.failAnalysis(imageAnalysis.error);
      return;
    }

    try {
      const outcome = runAnalysis(image, imageAnalysis.value, parameters);
      if (outcome.ok) {
        actions.succeedAnalysis(outcome.result);
      } else {
        actions.failAnalysis(outcome.error);
      }
    } catch (cause) {
      // 型付き結果で表せない予期しない失敗。握り潰さずエラー状態として提示する。
      actions.failAnalysis(toUnexpectedError(cause));
    }
  }, [image, imageAnalysis, parameters, actions]);
}
