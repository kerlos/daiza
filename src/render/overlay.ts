// オーバーレイ描画モデルの構築（純粋ロジック、React / SVG 非依存）。
//
// AnalysisResult を「プレビュー上に重ねる図形の集合」へ変換する。ここでは
// 幾何（ピクセル座標系の図形）だけを決め、色・線種などの見た目は描画層
// （components/Preview の SVG）に委ねる。こう分離しておくことで、将来
// 描画先を Canvas / WebGL へ差し替えても図形定義をそのまま再利用できる。
//
// 座標系は入力画像のピクセル座標（左上原点・下方向 +Y）で統一する。プレビューは
// この座標をそのまま viewBox にとった SVG で描くため、ズーム/パン（TODO 9）は
// SVG 側の座標変換だけで完結し、本モジュールは影響を受けない。

import type { AnalysisResult, Point } from '@/model/types';

/** 外形（半透明の塗り）。ピクセル座標の頂点列。 */
export interface OverlayPolygon {
  readonly role: 'contour';
  readonly points: readonly Point[];
}

/** 重心マーカー（赤丸）。半径はピクセル単位。 */
export interface OverlayCircle {
  readonly role: 'centroid';
  readonly center: Point;
  readonly radius: number;
}

/** 差込口（青矩形）／台座（緑矩形）。左上原点 (x, y) と幅・高さ。 */
export interface OverlayRect {
  readonly role: 'slot' | 'base';
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 支持範囲（オレンジ線）／重心からの鉛直線（点線）。 */
export interface OverlaySegment {
  readonly role: 'support' | 'plumb';
  readonly from: Point;
  readonly to: Point;
}

/**
 * プレビューへ重ねる図形一式。
 * 描画層はこの構造体の各要素を role に応じたスタイルで SVG 化するだけでよい。
 */
export interface OverlayShapes {
  readonly contour: OverlayPolygon;
  readonly centroid: OverlayCircle;
  readonly slot: OverlayRect;
  readonly base: OverlayRect;
  readonly support: OverlaySegment;
  readonly plumb: OverlaySegment;
}

/**
 * 重心マーカーの半径。
 * 画像解像度に比例させ、3000px 級でも豆粒にならないようにしつつ、下限も設けて
 * 小さな画像で消えないようにする。ズーム時に画面上で一定サイズへ保つ調整は
 * 表示操作（TODO 9）側の責務とし、ここでは画像基準の素直な大きさを与える。
 */
function centroidRadius(width: number, height: number): number {
  return Math.max(3, Math.min(width, height) * 0.01);
}

/**
 * 台座（緑矩形）の見かけの縦厚み。
 * 前面図における台座の縦寸法は現段階のモデルに存在しないため、画像高さに対する
 * 小さな一定割合で模式的に描く。台座の実寸モデル化（TODO 11 以降）で置き換える。
 */
function baseBandHeight(height: number): number {
  return Math.max(2, height * 0.015);
}

/**
 * 解析結果からオーバーレイ図形一式を構築する。
 *
 * mm 座標で保持している値（台座幅・支持範囲）は mmPerPixel で割ってピクセル座標へ
 * 戻す。支持範囲・台座・支持線は画像最下端を共通のベースラインとして配置し、
 * 重心の鉛直線をそのベースラインまで下ろすことで「重心の真下が支持範囲内か」を
 * 目視できるようにする。
 */
export function buildOverlayShapes(result: AnalysisResult): OverlayShapes {
  const { imageSize, mmPerPixel, contour, centroid, slot, base } = result;
  const width = imageSize.width;
  const height = imageSize.height;

  // 支持範囲・台座・鉛直線の基準となる画像最下端。
  const baselineY = height;

  const slotRect: OverlayRect = {
    role: 'slot',
    x: slot.centerXPixel - slot.widthPixel / 2,
    y: slot.yPixel,
    width: slot.widthPixel,
    // フィギュア下端から差込 Y までの縦帯として可視化する。差込口探索（TODO 10）が
    // 下端付近に yPixel を置くため、下端までの範囲を差込口の位置として示す。
    height: Math.max(0, baselineY - slot.yPixel),
  };

  // 台座幅は実寸(mm)。ピクセルへ戻し、差込口中心に合わせて左右対称に配置する。
  const baseWidthPixel = base.widthMm / mmPerPixel;
  const band = baseBandHeight(height);
  const baseRect: OverlayRect = {
    role: 'base',
    x: slot.centerXPixel - baseWidthPixel / 2,
    y: baselineY - band,
    width: baseWidthPixel,
    height: band,
  };

  // 支持範囲（オレンジ線）：mm 座標の左右端をピクセルへ戻した水平線分。
  const support: OverlaySegment = {
    role: 'support',
    from: { x: base.supportLeftMm / mmPerPixel, y: baselineY },
    to: { x: base.supportRightMm / mmPerPixel, y: baselineY },
  };

  // 重心からの鉛直線（点線）：重心の真下がどこに落ちるかを支持範囲と対比させる。
  const plumb: OverlaySegment = {
    role: 'plumb',
    from: { x: centroid.pixel.x, y: centroid.pixel.y },
    to: { x: centroid.pixel.x, y: baselineY },
  };

  return {
    contour: { role: 'contour', points: contour },
    centroid: {
      role: 'centroid',
      center: centroid.pixel,
      radius: centroidRadius(width, height),
    },
    slot: slotRect,
    base: baseRect,
    support,
    plumb,
  };
}
