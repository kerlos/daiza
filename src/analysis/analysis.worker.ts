// 第 1 相解析（重い全画素走査）を担う Web Worker。
//
// フリーズ対策（SPEC「重い解析でメインスレッドを塞がない」）の要。α マスク構築・
// 重心走査・外形抽出という O(W×H) の処理をメインスレッドから切り離し、UI の描画・
// 入力を止めないようにする。計算量そのものは減らさないため解析精度は原寸のまま。
//
// 解析ロジック自体は analysis/pipeline の純粋関数（analyzeImage）を再利用する。この
// Worker は「メッセージ受け渡し」と「転送バッファから ImageData を組み立てる」ことだけを
// 担い、ドメインロジックは持たない（レイヤ分離の維持）。

import { analyzeImage, type ImageAnalysisOutcome } from '@/analysis/pipeline';

/** メインスレッド → Worker：解析対象の RGBA バッファと寸法。 */
export interface AnalysisWorkerRequest {
  /** リクエストの世代番号。応答の取り違え（古い画像の結果の混入）を防ぐために往復させる。 */
  requestId: number;
  /** RGBA ピクセルの ArrayBuffer。Transferable として転送される（コピーなし）。 */
  buffer: ArrayBuffer;
  width: number;
  height: number;
}

/** Worker → メインスレッド：第 1 相の成否と、返送する RGBA バッファ。 */
export interface AnalysisWorkerResponse {
  requestId: number;
  outcome: ImageAnalysisOutcome;
  /**
   * 受け取った RGBA バッファをそのまま転送で返す。メインスレッド側は転送で detach
   * されているため、第 2 相（差込口探索）や再描画で使えるよう ImageData を復元する。
   */
  buffer: ArrayBuffer;
  /** バッファから ImageData を復元するための寸法。 */
  width: number;
  height: number;
}

// Worker のグローバルスコープ。tsconfig の lib は DOM のため、DOM lib の `self`（Window）
// とは postMessage のシグネチャが異なる。WebWorker lib を足すと DOM lib とグローバル
// 定義が衝突するため、ここでは使う API だけを持つ最小 interface へキャストして受ける。
interface WorkerScope {
  onmessage: ((event: MessageEvent<AnalysisWorkerRequest>) => void) | null;
  postMessage(message: AnalysisWorkerResponse, transfer: Transferable[]): void;
}
const ctx = self as unknown as WorkerScope;

ctx.onmessage = (event: MessageEvent<AnalysisWorkerRequest>) => {
  const { requestId, buffer, width, height } = event.data;

  // Uint8ClampedArray は buffer を共有する（コピーしない）。この ImageData を解析後は
  // 破棄し、buffer だけを転送で返す。
  const imageData = new ImageData(new Uint8ClampedArray(buffer), width, height);
  const outcome = analyzeImage({ imageData, width, height });

  // buffer を転送リストへ入れてメインスレッドへ返却する（往復ともコピーなし）。
  const response: AnalysisWorkerResponse = { requestId, outcome, buffer, width, height };
  ctx.postMessage(response, [buffer]);
};
