// 差込口配置：差込口（ツメ）中心を「重心X + 差込口オフセット」に置く。
//
// アクリルフィギュアは下端の「ツメ」を台座のスリット（差込口）へ挿し込む。SPEC の
// 改訂により、差込口は画像最下部の充填スパンから探索するのではなく、
//
//   差込口中心 X = 重心X + 差込口オフセット
//
// で決める。ツメは基本的に重心の真下へ置き、左右方向の微調整だけをオフセットで行う。
//
// ツメの縦位置は「カットライン（アクリル外形）の最下端＝足元」に下端を合わせる。ツメが
// 本体（既存カットライン）から離れている（差込口X の位置でカットラインが足元まで届いて
// いない）場合は、呼び出し側（pipeline）が analysis/contour の attachSlotTab でカットラインを
// 下方向へ拡張して一体化する。ここではその判断材料となる縦帯（上端・下端）を返す。
//
// React には依存しない純粋ロジック。座標は画像左上原点・下方向 +Y。

import type { Centroid, Contour, SlotResult } from '@/model/types';
import { pixelLengthToMm } from '@/analysis/scale';

/** ツメ縦帯の最小表示高さを決める、カットライン縦幅に対する割合。 */
const MIN_TAB_BAND_RATIO = 0.03;

/** カットラインの縦方向レンジ（最上端・最下端 Y、ピクセル）。 */
interface VerticalExtent {
  minY: number;
  maxY: number;
}

/** カットライン頂点列の Y レンジを 1 パスで求める（spread を避け巨大頂点列でも安全）。 */
function verticalExtent(contour: Contour): VerticalExtent {
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of contour) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minY, maxY };
}

/**
 * X 区間 [xL, xR] における、カットライン下辺の最も深い（Y 最大）位置を求める。
 *
 * 区間内の頂点に加え、区間端の垂直線 x=xL / x=xR とカットラインの交点も考慮する
 * （差込口幅が狭く区間内に頂点が無い場合を取りこぼさないため）。この値が足元
 * （カットライン最下端）から離れているほど、ツメは本体から浮いており拡張が要る。
 */
function deepestBoundaryInRange(contour: Contour, xL: number, xR: number): number {
  let deepest = Number.NEGATIVE_INFINITY;

  // 区間内の頂点。
  for (const p of contour) {
    if (p.x >= xL && p.x <= xR && p.y > deepest) {
      deepest = p.y;
    }
  }

  // 区間端の垂直線との交点（辺が区間端をまたぐ箇所）。
  const n = contour.length;
  for (let i = 0; i < n; i++) {
    const a = contour[i];
    const b = contour[(i + 1) % n];
    if (!a || !b) continue;
    for (const x of [xL, xR]) {
      // 半開区間で straddle 判定し、共有頂点での二重計上を避ける。
      const straddles = (a.x <= x && x < b.x) || (b.x <= x && x < a.x);
      if (!straddles) continue;
      const t = (x - a.x) / (b.x - a.x);
      const y = a.y + t * (b.y - a.y);
      if (y > deepest) deepest = y;
    }
  }

  return deepest;
}

/**
 * 差込口（ツメ）位置を決める。
 *
 * 中心 X は「重心X + 差込口オフセット」。縦は、下端をカットライン最下端（足元）へ、
 * 上端を差込口X 区間でカットラインが届いている深さ（deepest）に合わせる。ツメが足元まで
 * 届いていない（deepest が足元より浅い）場合は縦帯がその隙間を可視化し、届いている場合は
 * 帯が潰れないよう最小高さを確保する。実際のカットライン拡張は呼び出し側が担う。
 *
 * スケールが不正（mmPerPixel が非有限・非正）／差込口幅が不正／カットラインが退化
 * （3 頂点未満）な場合は配置不能として null を返し、slotPlacementFailed へマッピングさせる。
 */
export function findSlot(
  contour: Contour,
  centroid: Centroid,
  slotWidthMm: number,
  slotOffsetMm: number,
  mmPerPixel: number,
): SlotResult | null {
  if (contour.length < 3) {
    return null;
  }

  const slotWidthPixel = slotWidthMm / mmPerPixel;
  const offsetPixel = slotOffsetMm / mmPerPixel;
  if (!Number.isFinite(slotWidthPixel) || slotWidthPixel <= 0 || !Number.isFinite(offsetPixel)) {
    return null;
  }

  // SPEC の定義どおり、差込口中心は重心の真下（重心X）＋左右オフセット。
  const centerXPixel = centroid.pixel.x + offsetPixel;
  const xL = centerXPixel - slotWidthPixel / 2;
  const xR = centerXPixel + slotWidthPixel / 2;

  const { minY, maxY } = verticalExtent(contour);
  // 足元＝カットライン最下端。ツメの下端はここへ合わせる。
  const footY = maxY;

  // 差込口X 区間でカットラインが届いている深さ。区間がカットラインの外なら
  // 交点も頂点も無く -∞ になるため、足元まで浮いている扱い（上端=足元-最小帯）にする。
  const deepest = deepestBoundaryInRange(contour, xL, xR);

  // 縦帯が潰れて見えなくならないよう、カットライン縦幅に応じた最小高さを確保する。
  const minBandPx = Math.max(4, (maxY - minY) * MIN_TAB_BAND_RATIO);
  const attachY = Number.isFinite(deepest) ? deepest : footY;
  const yPixel = Math.min(attachY, footY - minBandPx);

  return {
    centerXPixel,
    yPixel,
    bottomYPixel: footY,
    widthPixel: slotWidthPixel,
    // 中心 X はピクセル座標の位置。原点 0 起点なので長さ換算と同じ乗算でよい。
    centerXMm: pixelLengthToMm(centerXPixel, mmPerPixel),
    // 幅は与えられた実寸値をそのまま保持し、往復換算による丸め誤差を避ける。
    widthMm: slotWidthMm,
  };
}
