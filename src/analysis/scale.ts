// スケール計算：フィギュア高さ(mm)と画像高さ(px)から mm/px 換算係数を求める。
//
// 解析パイプライン（重心・差込口・台座…）はすべてピクセル座標で計算し、
// 結果表示・SVG 生成の段でここで得た mmPerPixel を掛けて実寸へ変換する。
// スケールの定義を一箇所へ集約することで、各層が同じ換算規則を共有する。
//
// React には依存しない純粋ロジック。

import type { Point, Size } from '@/model/types';

/**
 * mm/px 換算係数を求める。
 *
 * SPEC の定義どおり「フィギュア高さ(mm)を画像高さ(px)で割る」ことで、
 * 1 ピクセルが実寸で何 mm に相当するかを得る。高さを基準にするのは、
 * フィギュア高さがユーザーの与える唯一の実寸情報だからである。
 *
 * 前提：figureHeightMm・imageHeightPixels はいずれも正。上流の
 * PARAMETER_CONSTRAINTS（高さ ≥ 1）と画像読み込み（高さ > 0）で保証される。
 * 万一 0 以下が来た場合はゼロ除算・不正値を下流へ伝播させないため、
 * 計算不能を示す NaN を返し、呼び出し側で弾けるようにする。
 */
export function computeMmPerPixel(figureHeightMm: number, imageHeightPixels: number): number {
  if (figureHeightMm <= 0 || imageHeightPixels <= 0) {
    return Number.NaN;
  }
  return figureHeightMm / imageHeightPixels;
}

/** ピクセル長を実寸(mm)へ換算する。 */
export function pixelLengthToMm(lengthPixel: number, mmPerPixel: number): number {
  return lengthPixel * mmPerPixel;
}

/** ピクセル座標の点を実寸(mm)座標へ換算する。 */
export function pixelPointToMm(pointPixel: Point, mmPerPixel: number): Point {
  return {
    x: pointPixel.x * mmPerPixel,
    y: pointPixel.y * mmPerPixel,
  };
}

/** 画像のピクセル寸法を実寸(mm)寸法へ換算する。 */
export function computePhysicalSize(imageSize: Size, mmPerPixel: number): Size {
  return {
    width: imageSize.width * mmPerPixel,
    height: imageSize.height * mmPerPixel,
  };
}
