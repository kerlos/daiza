// キーホルダーモードの解析ロジック（純粋関数）。
//
// カットライン（輪郭）の上部にリング穴を開け、穴縁とカットラインの間に
// 最低 1.5 mm の余裕を保つようクランプ・失敗判定する。アクリル本体は
// 水平オフセットで回転させず、穴の位置だけを動かす。

import type { Centroid, Contour, KeychainResult, Point } from '@/model/types';
import { distanceToSegment, pointInPolygon } from '@/utils/geometry';

/** 穴縁とカットラインの間の最小余裕(mm)。grilling で確定。 */
export const KEYCHAIN_HOLE_MARGIN_MM = 1.5;

/** 輪郭のバウンディングボックス。 */
interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function contourBBox(contour: Contour): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of contour) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** 点が閉多角形の内部にあるか（境界含む）。ピクセル座標。 */
function isInsideContour(point: Point, contour: Contour): boolean {
  return pointInPolygon(point, contour, 0);
}

/**
 * 点から多角形輪郭までの最短距離（内部なら正、外部なら負）。
 * 内部に近い辺までの距離を正で返し、外部なら境界までの距離を負で返す。
 */
function signedDistanceToContour(point: Point, contour: Contour): number {
  const inside = isInsideContour(point, contour);
  let minDist = Infinity;
  const n = contour.length;
  for (let i = 0; i < n; i++) {
    const a = contour[i];
    const b = contour[(i + 1) % n];
    if (!a || !b) continue;
    const d = distanceToSegment(point, a, b);
    if (d < minDist) minDist = d;
  }
  return inside ? minDist : -minDist;
}

/**
 * 穴中心を輪郭内部に収まるようクランプする。
 * まずはバウンディングボックス内に押し込み、さらに輪郭内部に近い位置へ
 * 必要に応じて微調整する（簡易的な「輪郭内への押し戻し」）。
 */
/**
 * リング穴の配置を計算する。
 *
 * 既定位置は (重心 X, カットライン bbox の上端)。ユーザー指定の水平オフセットを加え、
 * 穴縁がカットラインから 1.5 mm 以上離れるようクランプする。クランプ後も余裕が
 * 取れなければ null を返す（holePlacementFailed）。
 */
export function computeKeychainHole(
  contour: Contour,
  centroid: Centroid,
  holeDiameterMm: number,
  holePaddingMm: number,
  holeOffsetXMm: number,
  mmPerPixel: number,
): { center: Point; radiusPx: number; marginValid: boolean } | null {
  const bbox = contourBBox(contour);
  const radiusMm = holeDiameterMm / 2;
  const radiusPx = radiusMm / mmPerPixel;
  const marginPx = KEYCHAIN_HOLE_MARGIN_MM / mmPerPixel;

  // 目標とする余裕 = 半径 + 1.5 mm
  const requiredPx = radiusPx + marginPx;

  // 穴は「重心 X + 水平オフセット」の真上に置き、上端からの余裕で下げる。
  // 上端ギリギリでは余裕が 0 なので、最低でも requiredPx だけ下げる。
  const targetX = centroid.pixel.x + holeOffsetXMm / mmPerPixel;
  const paddingPx = holePaddingMm / mmPerPixel;
  let center: Point = { x: targetX, y: bbox.minY + requiredPx + paddingPx };

  // 目標位置が既に安全ならそのまま使う。安全でなければ下方向へ最小限移動して探す。
  // この探索はユーザーの余裕指定を尊重し、無理に最も高い位置へ戻さない。
  if (signedDistanceToContour(center, contour) < requiredPx) {
    const maxY = bbox.minY + (bbox.maxY - bbox.minY) * 0.5;
    let found = false;
    for (let y = center.y + 0.5; y <= maxY; y += 0.5) {
      const candidate = { x: targetX, y };
      if (signedDistanceToContour(candidate, contour) >= requiredPx) {
        center = candidate;
        found = true;
        break;
      }
    }
    if (!found) {
      return null;
    }
  }

  // 水平方向のクランプ：重心 X から左右に動かして余裕を維持する。
  let leftLimit = -Infinity;
  let rightLimit = Infinity;
  const searchRange = bbox.maxX - bbox.minX;
  if (searchRange > 0) {
    // 左方向の限界を探す
    let lo = center.x;
    let hi = center.x - searchRange;
    for (let iter = 0; iter < 20; iter++) {
      const mid = (lo + hi) / 2;
      const d = signedDistanceToContour({ x: mid, y: center.y }, contour);
      if (d >= requiredPx) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    leftLimit = lo;

    // 右方向の限界を探す
    lo = center.x;
    hi = center.x + searchRange;
    for (let iter = 0; iter < 20; iter++) {
      const mid = (lo + hi) / 2;
      const d = signedDistanceToContour({ x: mid, y: center.y }, contour);
      if (d >= requiredPx) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    rightLimit = lo;
  }

  const clampedX = Math.max(leftLimit, Math.min(rightLimit, targetX));
  center = { x: clampedX, y: center.y };

  // 最終確認
  const finalDistance = signedDistanceToContour(center, contour);
  if (finalDistance < requiredPx - 1e-6) {
    return null;
  }

  return { center, radiusPx, marginValid: true };
}

/**
 * キーホルダーモードの結果一式を組み立てる。
 *
 * 呼び出し側は既にカットライン・重心が確定していることを前提とする。
 */
export function buildKeychainResult(
  contour: Contour,
  centroid: Centroid,
  holeDiameterMm: number,
  holePaddingMm: number,
  holeOffsetXMm: number,
  mmPerPixel: number,
): KeychainResult | null {
  const hole = computeKeychainHole(
    contour,
    centroid,
    holeDiameterMm,
    holePaddingMm,
    holeOffsetXMm,
    mmPerPixel,
  );
  if (!hole) {
    return null;
  }

  return {
    holeCenterPixel: hole.center,
    holeCenterMm: { x: hole.center.x * mmPerPixel, y: hole.center.y * mmPerPixel },
    holeRadiusMm: holeDiameterMm / 2,
    // 水平オフセットでアクリル全体を回転させないよう、回転は 0 に固定。
    rotationDeg: 0,
    rotatedCentroidPixel: centroid.pixel,
    rotatedCentroidMm: centroid.mm,
    rotatedContour: contour,
  };
}
