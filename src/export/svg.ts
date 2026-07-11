// SVG エクスポート（純粋ロジック、React / DOM 非依存）。
//
// AnalysisResult を実寸(mm)座標系の SVG 文字列へ変換する。SPEC のエクスポート指定
// どおり「外形・差込口・台座」の 3 要素のみを描き、支持範囲・重心・鉛直線などの
// プレビュー専用オーバーレイは含めない。ダウンロード（Blob 生成・a要素クリック）は
// DOM 依存の副作用のため本モジュールには置かず、呼び出し側（App）に委ねる。こうして
// 生成ロジックを純粋に保つことで、テスト容易性と将来の WebAssembly 置き換えに備える。
//
// 座標系：解析と同じくピクセル左上原点・下方向 +Y を維持し、mmPerPixel で mm へ
// 換算する。SVG の user unit を mm と 1:1 に対応させる（width/height に "mm" を付し、
// viewBox の数値をそのまま mm とみなす）ため、印刷・CAD 取り込み時に実寸となる。

import type { AnalysisResult, Point } from '@/model/types';
import { closedCurvePathData } from '@/utils/curve';

/** 図形を配置する余白(mm)。viewBox の外周に取り、線が縁で切れないようにする。 */
const MARGIN_MM = 5;

/**
 * mm 値を SVG 属性向けの短い文字列へ整える。
 * 浮動小数の桁あふれ（0.1 + 0.2 = 0.30000…）で属性が肥大するのを防ぐため小数
 * 3 桁で丸め、末尾の余分な 0 を Number 経由で落とす。3 桁 = 1μm 相当で実用十分。
 */
function fmt(value: number): string {
  return Number(value.toFixed(3)).toString();
}

/** 軸平行な矩形の左上原点・寸法（mm）。 */
interface RectMm {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 描画する 3 要素の幾何を mm 座標で束ねた中間表現。
 * viewBox 算出（全要素を包む境界）と SVG 文字列化の双方がこれを入力にすることで、
 * 座標変換を 1 箇所（buildGeometry）へ集約し、要素追加時の座標系ずれを防ぐ。
 */
interface SvgGeometry {
  /** 外形（輪郭）ポリゴンの頂点列（mm）。 */
  contour: readonly Point[];
  /** 差込口（前面図の縦帯、mm）。 */
  slot: RectMm;
  /** 台座（フィギュア足元へ置く実寸の footprint、mm）。 */
  base: RectMm;
}

/**
 * 解析結果を mm 座標の描画幾何へ変換する。
 *
 * 外形と差込口はプレビュー（render/overlay）と同じ前面図として mm 換算する。
 * 台座は前面図に現れない奥行(depthMm)を持つため、実寸の footprint（幅×奥行）を
 * フィギュア足元（画像下端 = physicalSize.height）に上辺を合わせて下方向へ描く。
 * これにより幅・奥行の両方を実寸のまま 1 枚の図へ載せられる。
 */
function buildGeometry(result: AnalysisResult): SvgGeometry {
  const { mmPerPixel, physicalSize, contour, slot, base } = result;

  // フィギュア足元＝画像下端の実寸 Y。差込口の下端・台座の上辺の基準線になる。
  const baselineYMm = physicalSize.height;

  const contourMm = contour.map((p) => ({ x: p.x * mmPerPixel, y: p.y * mmPerPixel }));

  // 差込口（ツメ）：中心 X・幅は mm を直接使い、縦は上端 yPixel から下端 bottomYPixel
  // （カットライン足元）までの帯（overlay と同義）。拡張後の外形と一体でカットされる。
  const slotYMm = slot.yPixel * mmPerPixel;
  const slotBottomYMm = slot.bottomYPixel * mmPerPixel;
  const slotRect: RectMm = {
    x: slot.centerXMm - slot.widthMm / 2,
    y: slotYMm,
    width: slot.widthMm,
    height: Math.max(0, slotBottomYMm - slotYMm),
  };

  // 台座：差込口中心を軸に左右対称。上辺を足元に合わせ、奥行ぶん下へ伸ばす。
  const baseRect: RectMm = {
    x: slot.centerXMm - base.widthMm / 2,
    y: baselineYMm,
    width: base.widthMm,
    height: base.depthMm,
  };

  return { contour: contourMm, slot: slotRect, base: baseRect };
}

/** 全要素を包む境界（mm）に余白を足した viewBox 矩形を求める。 */
function computeViewBox(geometry: SvgGeometry): RectMm {
  const xs: number[] = [];
  const ys: number[] = [];

  for (const p of geometry.contour) {
    xs.push(p.x);
    ys.push(p.y);
  }
  for (const rect of [geometry.slot, geometry.base]) {
    xs.push(rect.x, rect.x + rect.width);
    ys.push(rect.y, rect.y + rect.height);
  }

  const minX = Math.min(...xs) - MARGIN_MM;
  const minY = Math.min(...ys) - MARGIN_MM;
  const maxX = Math.max(...xs) + MARGIN_MM;
  const maxY = Math.max(...ys) + MARGIN_MM;

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** 矩形を SVG rect 要素文字列へ変換する。 */
function rectElement(rect: RectMm, attrs: string): string {
  return `<rect x="${fmt(rect.x)}" y="${fmt(rect.y)}" width="${fmt(rect.width)}" height="${fmt(rect.height)}" ${attrs} />`;
}

/**
 * 解析結果から実寸(mm)座標系の SVG ドキュメント文字列を生成する。
 *
 * 線幅は viewBox の対角に比例させ、拡大率に依らず見やすい太さを保つ（下限あり）。
 * 塗りは持たせず輪郭線のみとし、レーザー加工などで各要素を判別しやすいよう外形・
 * 差込口・台座を色分けする（overlay の配色に合わせて認知負荷を下げる）。
 */
export function generateSvg(result: AnalysisResult): string {
  const geometry = buildGeometry(result);
  const viewBox = computeViewBox(geometry);

  // 線幅は図全体の対角の 0.3%。極小図でも消えないよう 0.2mm を下限にする。
  const diagonal = Math.hypot(viewBox.width, viewBox.height);
  const strokeWidth = Math.max(0.2, diagonal * 0.003);
  const strokeAttr = `stroke-width="${fmt(strokeWidth)}"`;

  const viewBoxAttr = `${fmt(viewBox.x)} ${fmt(viewBox.y)} ${fmt(viewBox.width)} ${fmt(viewBox.height)}`;

  // 外形（カットライン）は折れ線ではなく曲線補完した path（C コマンド）で出力する（SPEC 要件）。
  const contourEl =
    `<path d="${closedCurvePathData(geometry.contour, fmt)}" ` +
    `fill="none" stroke="#374151" ${strokeAttr} />`;
  const slotEl = rectElement(geometry.slot, `fill="none" stroke="#2563eb" ${strokeAttr}`);
  const baseEl = rectElement(geometry.base, `fill="none" stroke="#16a34a" ${strokeAttr}`);

  // width/height に "mm" を付け、viewBox の数値を mm と 1:1 対応させて実寸出力とする。
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
      `width="${fmt(viewBox.width)}mm" height="${fmt(viewBox.height)}mm" ` +
      `viewBox="${viewBoxAttr}">`,
    '  <title>Daiza 台座設計図（実寸 mm）</title>',
    `  <g fill="none" stroke-linejoin="round">`,
    `    ${contourEl}`,
    `    ${slotEl}`,
    `    ${baseEl}`,
    '  </g>',
    '</svg>',
    '',
  ].join('\n');
}
