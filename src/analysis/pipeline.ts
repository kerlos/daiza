// 解析パイプライン：各解析ステップを 1 本の流れへ束ねる純粋オーケストレータ。
//
// パフォーマンス要件（SPEC「オーバーレイのみの更新で済む場合は画像解析全体を再実行
// しない」）のため、パイプラインを 2 相に分ける：
//
//   analyzeImage … 画像だけに依存する重い走査（α マスク構築・重心のピクセル走査・
//                  外形抽出）。O(W×H) で 3000px 級では最も重い。画像が変わった時だけ実行。
//   runAnalysis  … パラメータに依存する軽量計算（mm/px スケール・mm 換算・差込口・
//                  台座・転倒角）。安全率スライダー等の変更ごとに呼ばれる。
//
// こう分けることで、パラメータ変更のたびに毎回全画素を再走査する無駄を無くし、
// hooks/useAnalysis 側で analyzeImage の結果を画像単位でメモ化できるようにする。
// いずれも React には依存しない純粋ロジックとし、この合成を hooks/useAnalysis が
// 「画像・パラメータの変化 → 状態更新 → 再描画」へ接続する（責務分離）。
//
// 各ステップは失敗を null で表す純粋関数として実装済みなので、ここでは順に呼び、
// null を初めて踏んだ段階に応じたエラー種別へマッピングして早期に返す。例外で
// クラッシュさせず、UI がメッセージ表示へ落とせる形（AnalysisError）で失敗を伝える。

import { computeBase } from '@/analysis/base';
import { polygonCentroid, toCentroid } from '@/analysis/centroid';
import { attachSlotTab, buildCutline, extractContours } from '@/analysis/contour';
import { computeMmPerPixel, computePhysicalSize } from '@/analysis/scale';
import { findSlot } from '@/analysis/slot';
import { computeStability } from '@/analysis/stability';
import { simplifyPolyline } from '@/utils/geometry';
import type {
  AnalysisError,
  AnalysisErrorKind,
  AnalysisParameters,
  AnalysisResult,
  Contour,
  FigureImage,
  Size,
} from '@/model/types';
import { buildAlphaMask } from '@/utils/image';

/**
 * 外形間引き（Douglas–Peucker）の許容ずれ（ピクセル）。
 * 「元の境界線からこの距離までのずれは許して頂点を落とす」閾値。1px は原寸表示・
 * ズーム時でもほぼ視認できず、SVG カットラインでも mm 換算で無視できる微小量（例：
 * 高さ160mm/3000px なら約0.05mm）。一方で数万点を約 5〜7% まで削減でき、描画を軽くする。
 */
const CONTOUR_SIMPLIFY_EPSILON_PX = 1;

/**
 * パイプライン段で発生し得るエラー種別。
 * 読み込み系（imageLoadFailed / unsupportedImage）は前段の imageLoader が担うため、
 * ここではアクリル領域欠如・差込口配置不可・台座計算不可の 3 種のみを扱う。
 */
type PipelineErrorKind = Extract<
  AnalysisErrorKind,
  'transparentImage' | 'slotPlacementFailed' | 'baseCalculationFailed'
>;

/** UI へ提示するエラーメッセージ（日本語）。 */
const ERROR_MESSAGES: Record<PipelineErrorKind, string> = {
  transparentImage:
    'アクリル領域（α>0）が見つからないため解析できません。透明でないPNG画像を選択してください。',
  slotPlacementFailed:
    '差込口を配置できる位置が見つかりません。差込口幅を小さくするか、下端に十分な幅のある画像を使用してください。',
  baseCalculationFailed:
    '台座サイズを計算できません。安全率やフィギュア高さなどのパラメータを見直してください。',
};

/** 解析の成否。成功なら結果一式、失敗なら型付きエラー。 */
export type AnalysisOutcome =
  { ok: true; result: AnalysisResult } | { ok: false; error: AnalysisError };

/**
 * 画像だけに依存する解析（第 1 相）の成果物。
 * パラメータに一切依存しないため、画像が同じである限り再計算不要。useAnalysis が
 * 画像単位でメモ化し、パラメータ変更時は runAnalysis の入力として使い回す。
 *
 * 重心はカットライン（余白・平滑化パラメータ依存）が囲む領域に対して求めるため、
 * この相では確定できない。ここでは不透明境界の生の外形だけを返し、カットライン化と
 * 重心計算は第 2 相（runAnalysis）が担う。
 */
export interface ImageAnalysis {
  /**
   * 不透明領域（α>0）の生の外形（輪郭）ポリゴン群（ピクセル座標）。カットライン化前。
   * 分離した複数パーツは各 1 閉ポリゴンとして並ぶ（SPEC「複数パーツの包絡」）。カットライン化
   * （余白オフセット・union・平滑化）は第 2 相（runAnalysis）がこの全パーツから 1 枚へまとめる。
   */
  contours: Contour[];
}

/** 第 1 相の成否。成功なら画像不変量、失敗なら型付きエラー（透明画像）。 */
export type ImageAnalysisOutcome =
  { ok: true; value: ImageAnalysis } | { ok: false; error: AnalysisError };

/**
 * 第 1 相が必要とする画像データの最小形。
 * ファイル名・id 等の付随情報には依存しないため、Web Worker 側が転送バッファから
 * この形だけを組み立てて解析できるよう、FigureImage より狭い型で受ける。
 */
export type ImagePixels = Pick<FigureImage, 'imageData' | 'width' | 'height'>;

/** 型付きエラーを組み立てる小ヘルパー。 */
function makeError(kind: PipelineErrorKind): AnalysisError {
  return { kind, message: ERROR_MESSAGES[kind] };
}

/** エラー結果（第 2 相用）を組み立てる小ヘルパー。 */
function fail(kind: PipelineErrorKind): AnalysisOutcome {
  return { ok: false, error: makeError(kind) };
}

/**
 * 第 1 相：画像だけから不透明領域の生の外形を求める。
 *
 * α マスクを 1 回だけ構築して輪郭抽出へ渡す（3000px 級でも α 判定の全画素走査を 1 回に
 * まとめる）。この相はパラメータに依存しないため、画像が変わった時だけ実行すれば足りる。
 * カットライン化（余白オフセット・平滑化）と重心計算はパラメータ依存なので第 2 相で行う。
 *
 * α>0 が皆無（＝外形が空）なら透明画像として型付きエラーを返す。本来 imageLoader が
 * 読み込み段階で弾くが、防御的に検査する。
 */
export function analyzeImage(image: ImagePixels): ImageAnalysisOutcome {
  const { imageData, width, height } = image;

  // α マスク：輪郭抽出の画像不変な前処理。1 回だけ構築する。
  const mask = buildAlphaMask(imageData);

  // 分離した複数パーツもすべて抽出する（SPEC「複数パーツの包絡」の前段）。連結成分ごとに 1 閉ポリゴン。
  const rawContours = extractContours(mask, width, height);

  // Moore 追跡は境界ピクセル 1 個 = 1 頂点で、3000px 級では数万点になる。これをそのまま
  // 描画・SVG 化するとメインスレッド（描画・ズーム/パン時の再描画）を固める。ここで各パーツを
  // Douglas–Peucker で間引き、見た目をほぼ保ったまま 1 桁以上削減しておく。間引いた外形は第 2 相の
  // カットライン化（オフセット・union・平滑化）の素性の良い入力にもなる。間引きで 3 頂点未満へ
  // 潰れた極小パーツは以降の面積計算・union に無意味なので捨てる。
  const contours = rawContours
    .map((c) => simplifyPolyline(c, CONTOUR_SIMPLIFY_EPSILON_PX))
    .filter((c) => c.length >= 3);

  // 有効なパーツが皆無＝アクリル領域が無い（全透明）。差込口・台座・転倒角の基準が取れないため弾く。
  if (contours.length === 0) {
    return { ok: false, error: makeError('transparentImage') };
  }

  return { ok: true, value: { contours } };
}

/**
 * 第 2 相：画像不変量（analyzeImage の結果）とパラメータから解析結果一式を求める。
 *
 * スケール（mm/px）をまず確定し、以降の幾何はすべてピクセル座標で計算して結果の
 * 段で mm へ換算する。各ステップの null は「その段で計算不能」を意味し、意味の近い
 * エラー種別へ写して早期に返す。全段を通れば AnalysisResult を組み立てて返す。
 *
 * ここに残るのはパラメータ依存の軽量計算のみ（差込口は重心X＋オフセットで直接決まり、
 * カットラインのツメ拡張も頂点数に比例した軽い処理）。重い全画素走査は analyzeImage 側に
 * 集約済みで、パラメータ変更では再実行されない。
 */
export function runAnalysis(
  image: FigureImage,
  imageAnalysis: ImageAnalysis,
  params: AnalysisParameters,
): AnalysisOutcome {
  const { width, height } = image;
  const { contours: rawContours } = imageAnalysis;

  // スケールが出せないと以降の実寸計算がすべて破綻する。UI の入力制約下では起きない
  // が、防御的に検査し、計算不能として扱う（下流へ NaN を伝播させない）。
  const mmPerPixel = computeMmPerPixel(params.figureHeightMm, height);
  if (!Number.isFinite(mmPerPixel) || mmPerPixel <= 0) {
    return fail('baseCalculationFailed');
  }

  // 生の外形を余白ぶん外側へオフセットし平滑化した「カットライン」を確定する。以降の
  // 重心・台座・オーバーレイ・SVG はすべてこのカットライン（が囲む領域）を外形として扱う。
  // 余白 mm はスケールでピクセルへ換算する（解析はピクセル座標で完結させる）。
  const marginPx = params.cutLineMarginMm / mmPerPixel;
  // 分離パーツ連結部の最小幅もスケールでピクセルへ換算する（解析はピクセル座標で完結）。
  const minBridgeWidthPx = params.minBridgeWidthMm / mmPerPixel;
  const contour = buildCutline(
    rawContours,
    marginPx,
    params.cutLineSmoothing,
    minBridgeWidthPx,
  );

  // 重心はカットラインが囲む領域の面積重心。差込口・台座・転倒角の基準になる。
  const centroidPixel = polygonCentroid(contour);
  if (!centroidPixel) {
    return fail('baseCalculationFailed');
  }
  const centroid = toCentroid(centroidPixel, mmPerPixel);

  // 差込口中心は重心の真下＋オフセット。縦位置はカットライン足元を基準に決める。
  const slot = findSlot(contour, centroid, params.slotWidthMm, params.slotOffsetMm, mmPerPixel);
  if (!slot) {
    return fail('slotPlacementFailed');
  }

  // ツメが本体から離れている場合はカットラインを足元まで下方向へ拡張して一体化する。
  // 以降 result.contour（オーバーレイ・SVG が参照）はこの拡張後の外形になる。
  const finalContour = attachSlotTab(
    contour,
    slot.centerXPixel - slot.widthPixel / 2,
    slot.centerXPixel + slot.widthPixel / 2,
    slot.bottomYPixel,
  );

  const base = computeBase(centroid, slot, params);
  if (!base) {
    return fail('baseCalculationFailed');
  }

  // 転倒角の失敗（重心高さ 0 等）も、幾何的に自立し得ない＝台座計算不可の一種として扱う。
  const stability = computeStability(centroid, base, params);
  if (!stability) {
    return fail('baseCalculationFailed');
  }

  const imageSize: Size = { width, height };
  return {
    ok: true,
    result: {
      imageSize,
      physicalSize: computePhysicalSize(imageSize, mmPerPixel),
      mmPerPixel,
      contour: finalContour,
      centroid,
      slot,
      base,
      stability,
    },
  };
}
