// 幾何・数値の共通処理（純粋ロジック、React 非依存）。
//
// 台座計算・転倒角・表示操作など複数の層で繰り返し現れる素朴な数値演算
// （クランプ・度⇔ラジアン変換）をここへ集約する。各所で個別に定義すると、
// 定数の取り違えや符号の食い違いが生まれやすいため、単純でも一元化しておく。

import type { Point } from '@/model/types';

/**
 * 値を [min, max] の範囲へ収める。min ≤ max は呼び出し側で保証する前提。
 * スライダー値の正規化や、差込口中心の可動範囲への丸めなどで共有する。
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 点列を Douglas–Peucker 法で間引く（形状を保ったまま頂点数を削減する）。
 *
 * Moore 追跡が返す外形は「境界ピクセル 1 個につき 1 頂点」で、3000px 級では数万点に
 * なる。これをそのまま SVG polygon にすると描画・文字列化がメインスレッドを固め、
 * ズーム/パンのたびに再描画されて実用に耐えない。直線上に並ぶ冗長な頂点を落とし、
 * 折れ（曲率）の大きい頂点だけを残すことで、見た目をほぼ変えずに 1 桁以上削減できる。
 *
 * epsilon は「元の線からの許容ずれ（ピクセル）」。これを超える最遠点を残して区間を
 * 再帰的に分割する。巨大入力での再帰スタック溢れを避けるため明示スタックで反復実装し、
 * 距離は平方比較（sqrt 省略）でホットループを軽く保つ。始点・終点は常に残す。
 */
export function simplifyPolyline(points: readonly Point[], epsilon: number): Point[] {
  const n = points.length;
  // 2 点以下は間引く余地がない。epsilon 非正なら削減しない（呼び出し側の無効化用）。
  if (n < 3 || epsilon <= 0) {
    return points.slice();
  }

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const eps2 = epsilon * epsilon;

  // [start, end] 区間を積み、区間内の最遠点が閾値超なら残して二分する。
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length > 0) {
    const range = stack.pop();
    if (!range) {
      break;
    }
    const [a, b] = range;
    const pa = points[a];
    const pb = points[b];
    if (!pa || !pb) {
      continue;
    }
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const len2 = dx * dx + dy * dy;

    let maxDist2 = -1;
    let farthest = -1;
    for (let i = a + 1; i < b; i++) {
      const pi = points[i];
      if (!pi) {
        continue;
      }
      const px = pi.x - pa.x;
      const py = pi.y - pa.y;
      // 線分 pa→pb への垂線距離の平方。len2=0（両端一致）は端点距離で代替する。
      const dist2 = len2 === 0 ? px * px + py * py : (px * dy - py * dx) ** 2 / len2;
      if (dist2 > maxDist2) {
        maxDist2 = dist2;
        farthest = i;
      }
    }

    // 最遠点が許容ずれを超えるなら残し、その点で区間を分割して両側を続行する。
    if (farthest > 0 && maxDist2 > eps2) {
      keep[farthest] = 1;
      stack.push([a, farthest], [farthest, b]);
    }
  }

  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    if (keep[i] === 1) {
      const p = points[i];
      if (p) {
        out.push(p);
      }
    }
  }
  return out;
}

/**
 * 点群の凸包（Andrew の monotone chain 法）を単純多角形として返す。
 *
 * カットライン生成で「余白を加えても分離したままの複数パーツ」を 1 枚のアクリルへまとめる
 * 際の包絡線（外周）に使う。凸包はすべての点を内側に含む最小の凸多角形で、内部の隙間で
 * 本体が分断されない単純多角形を必ず与えるため、包絡線として破綻しない。
 *
 * x→y の辞書順に整列し、下側・上側の鎖を外積符号で構築する。3 点未満は包絡の意味が無い
 * ため入力の複製をそのまま返す。頂点は反時計回り（画像の y 下向き座標では時計回り）で並ぶが、
 * 下流（面積重心・平滑化・SVG）は並び向きに依存しないため問題ない。
 */
export function convexHull(points: readonly Point[]): Point[] {
  const n = points.length;
  if (n < 3) {
    return points.slice();
  }

  const sorted = points.slice().sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));

  // 直前 2 点と候補点の外積。右折（時計回り）なら中間点を捨てて凸性を保つ。
  const cross = (o: Point, a: Point, b: Point): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const build = (pts: readonly Point[]): Point[] => {
    const chain: Point[] = [];
    for (const p of pts) {
      while (chain.length >= 2) {
        const a = chain[chain.length - 2];
        const b = chain[chain.length - 1];
        if (a && b && cross(a, b, p) <= 0) {
          chain.pop();
        } else {
          break;
        }
      }
      chain.push(p);
    }
    return chain;
  };

  const lower = build(sorted);
  const upper = build(sorted.slice().reverse());
  // 各鎖の末尾は他方の先頭と重複するため落として連結し、閉多角形の頂点列にする。
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** 度をラジアンへ変換する。三角関数（Math.tan 等）へ渡す前段で使う。 */
export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** ラジアンを度へ変換する。atan の結果を人へ見せる角度（転倒角）へ直す際に使う。 */
export function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}
