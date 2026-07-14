// 方位角(度)の正規化と表示。
//
// 方位角の規約は全体で共通：**右 0°・前 90°・左 180°・後 270°**（SPEC「最小転倒角」）。
// 方向ベクトルは d = (cos φ, sin φ)（y が前）。結果パネルの最悪方位と 3D の傾け方向で
// 同じ語彙を使うため、8 方位ラベルはここに 1 つだけ置く。

/** 45° 刻みの 8 方位ラベル。添字は方位角 / 45 を丸めたもの。 */
const AZIMUTH_LABELS = ['右', '右前', '前', '左前', '左', '左後', '後', '右後'] as const;

/** 方位角を 0〜360°（360 は 0）へ正規化する。 */
export function normalizeAzimuth(azimuthDeg: number): number {
  return ((azimuthDeg % 360) + 360) % 360;
}

/**
 * 方位角(度)を「135°（左前）」の形へ整える。
 * 45° 刻みの 8 方位へ最近傍で丸めた目安ラベルを添える（正確な角度は数値で示す）。
 */
export function formatAzimuth(azimuthDeg: number): string {
  const normalized = normalizeAzimuth(azimuthDeg);
  const index = Math.round(normalized / 45) % 8;
  return `${normalized.toFixed(0)}°（${AZIMUTH_LABELS[index]}）`;
}
