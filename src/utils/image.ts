// 画像ピクセルデータの共通処理（純粋ロジック、React 非依存）。
//
// 解析各層（imageLoader・centroid・contour・slot）は RGBA の ImageData を走査し、
// いずれも「α>0 をアクリル、α=0 を透明とみなす」という同一の判定規則に依存する。
// この規則としきい値をここへ一元化することで、各モジュールで規則がズレるのを防ぐ。
//
// 走査そのものは各モジュールの用途（重心の 1 次モーメント・行スパン・輪郭マスク）で
// 最適な形が異なるため、ここでは「1 画素の判定」と「全体で使い回す前処理」だけを
// 提供し、ホットループの構造（行オフセットのホイスト等）は呼び出し側に委ねる。

/**
 * アクリルとみなす α のしきい値。SPEC の「α=0 を透明・α>0 をアクリル」に対応し、
 * 境界は「これより大きい」（> 0）で判定する。将来しきい値を上げる（薄い縁を無視する
 * 等）拡張はこの定数と isAcrylicAlpha の変更だけで全モジュールへ波及させられる。
 */
export const ACRYLIC_ALPHA_THRESHOLD = 0;

/** α 値がアクリル（充填）とみなせるか。α>0 の判定規則を全モジュールで共有する。 */
export function isAcrylicAlpha(alpha: number): boolean {
  return alpha > ACRYLIC_ALPHA_THRESHOLD;
}

/**
 * α>0（アクリルとみなす）ピクセルが 1 つでも存在するか。
 * 全透明画像は重心・差込口の計算対象が無く解析不能なため、上流（読み込み時）で弾く。
 * 最初の 1 つを見つけた時点で打ち切るので、通常画像では即座に判定できる。
 */
export function hasVisiblePixels(imageData: ImageData): boolean {
  const { data } = imageData;
  // RGBA の 4 番目（α）のみを走査する。範囲内アクセスだが noUncheckedIndexedAccess
  // 下では number | undefined になるため ?? で 0 に丸めて判定する。
  for (let i = 3; i < data.length; i += 4) {
    if (isAcrylicAlpha(data[i] ?? 0)) {
      return true;
    }
  }
  return false;
}

/**
 * α>0 を 1（充填）とする 1 バイト/画素のマスクを作る。
 *
 * 輪郭追跡のように 1 画素あたり 8 近傍を何度も参照する処理では、RGBA から都度 α を
 * 読むよりこの 1 バイト表現を引く方がキャッシュ効率が良く、3000px 級でも実用的な
 * 速度を保てる。RGBA を 1 パスで畳んで返す。
 */
export function buildAlphaMask(imageData: ImageData): Uint8Array {
  const { data, width, height } = imageData;
  const total = width * height;
  const mask = new Uint8Array(total);
  for (let p = 0; p < total; p++) {
    mask[p] = isAcrylicAlpha(data[p * 4 + 3] ?? 0) ? 1 : 0;
  }
  return mask;
}
