// 重心計算：カットラインが囲む領域を均一密度とみなし、面積モーメントで重心を求める。
//
// 解析パイプラインの中核の一つ。差込口探索（重心の真下）・台座幅（重心が支持
// 範囲内か）・転倒角（重心高さ）はすべてこの重心を基準に計算するため、他の
// 幾何計算に先立って確定させる。React には依存しない純粋ロジック。
//
// SPEC「カットライン」節に従い、外形は不透明境界そのものではなく余白オフセット＋
// 平滑化を施したカットラインとし、重心もこのカットラインが囲む領域に対して求める。
// 領域を均一密度とみなすと、面積モーメントによる重心はピクセル平均 Cx=Σx/N,
// Cy=Σy/N（N＝領域の画素数）の連続版に等しく、SPEC の重心定義と整合する。

import type { Centroid, Point } from '@/model/types';
import { pixelPointToMm } from '@/analysis/scale';

/**
 * 重心のピクセル座標成分（実寸換算前）。
 *
 * ピクセル座標での重心は mm/px スケール（＝フィギュア高さパラメータ）に依存しない
 * ため、mm 換算と分離して保持する。カットライン自体は余白パラメータに依存するので
 * 重心計算は第 2 相（pipeline.runAnalysis）で行うが、mm 換算だけはさらに toCentroid で
 * 切り出し、スケールのみ変化した場合の再利用余地を残す。
 */
export interface CentroidPixel {
  pixel: Point;
  pixelCount: number;
}

/**
 * 閉ポリゴン（カットライン）が囲む領域の重心（ピクセル座標）を面積モーメントで求める。
 *
 * 多角形の重心公式（0 次モーメント＝面積、1 次モーメント＝面積×重心）を 1 パスで
 * 累積する。均一密度の領域重心なので、SPEC の Cx=Σx/N, Cy=Σy/N を「囲む領域全体」に
 * 対して評価したものに等しい。並び向き（CW/CCW）は符号として現れるが、比を取る過程で
 * 打ち消されるため向きに依らず正しい重心が得られる。pixelCount には領域面積(px²)を持たせる。
 *
 * 面積がほぼ 0（頂点数不足・一直線など退化形状）の場合は面積重心が定義できないため、
 * 頂点座標の平均で代用する。頂点が皆無なら計算対象が無いので null を返し、呼び出し側が
 * 例外なくエラー表示へマッピングできるようにする。
 */
export function polygonCentroid(polygon: readonly Point[]): CentroidPixel | null {
  const n = polygon.length;
  if (n === 0) {
    return null;
  }

  let doubleArea = 0;
  let cxAcc = 0;
  let cyAcc = 0;
  for (let i = 0; i < n; i++) {
    const p = polygon[i];
    const q = polygon[(i + 1) % n];
    if (!p || !q) {
      continue;
    }
    const cross = p.x * q.y - q.x * p.y;
    doubleArea += cross;
    cxAcc += (p.x + q.x) * cross;
    cyAcc += (p.y + q.y) * cross;
  }

  // 面積が消える退化形状は面積重心が発散するため、頂点平均へフォールバックする。
  if (Math.abs(doubleArea) < 1e-9) {
    let sumX = 0;
    let sumY = 0;
    for (const point of polygon) {
      sumX += point.x;
      sumY += point.y;
    }
    return { pixel: { x: sumX / n, y: sumY / n }, pixelCount: 0 };
  }

  return {
    // 重心 = 1 次モーメント / (3×2×面積)。doubleArea = 2×面積 なので 3×doubleArea で割る。
    pixel: { x: cxAcc / (3 * doubleArea), y: cyAcc / (3 * doubleArea) },
    pixelCount: Math.abs(doubleArea) / 2,
  };
}

/**
 * ピクセル重心へ実寸(mm)座標を付与して完成形の Centroid にする。
 *
 * mm 換算はスケール（mm/px）に依存する軽量な写像で、パラメータ変更のたびに
 * やり直しても支障がない。面積重心の算出（polygonCentroid）とは分離し、
 * ここではその結果を受けて mm を足すだけに留める。
 */
export function toCentroid(base: CentroidPixel, mmPerPixel: number): Centroid {
  return {
    pixel: base.pixel,
    // 実寸座標は結果表示用。ピクセル座標を単一の換算規則（scale）で変換する。
    mm: pixelPointToMm(base.pixel, mmPerPixel),
    pixelCount: base.pixelCount,
  };
}
