// 幾何・数値の共通処理（純粋ロジック、React 非依存）。
//
// 台座計算・転倒角・表示操作など複数の層で繰り返し現れる素朴な数値演算
// （クランプ・度⇔ラジアン変換）をここへ集約する。各所で個別に定義すると、
// 定数の取り違えや符号の食い違いが生まれやすいため、単純でも一元化しておく。

/**
 * 値を [min, max] の範囲へ収める。min ≤ max は呼び出し側で保証する前提。
 * スライダー値の正規化や、差込口中心の可動範囲への丸めなどで共有する。
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 度をラジアンへ変換する。三角関数（Math.tan 等）へ渡す前段で使う。 */
export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** ラジアンを度へ変換する。atan の結果を人へ見せる角度（転倒角）へ直す際に使う。 */
export function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}
