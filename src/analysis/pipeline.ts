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
import { computeCentroidFromMask, toCentroid, type CentroidPixel } from '@/analysis/centroid';
import { extractContour } from '@/analysis/contour';
import { computeMmPerPixel, computePhysicalSize } from '@/analysis/scale';
import { findSlot } from '@/analysis/slot';
import { computeStability } from '@/analysis/stability';
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
 */
export interface ImageAnalysis {
  /** アクリル（α>0）ピクセルの重心（ピクセル座標）と個数。mm 換算前。 */
  centroid: CentroidPixel;
  /** 外形（輪郭）ポリゴン（ピクセル座標）。 */
  contour: Contour;
}

/** 第 1 相の成否。成功なら画像不変量、失敗なら型付きエラー（透明画像）。 */
export type ImageAnalysisOutcome =
  { ok: true; value: ImageAnalysis } | { ok: false; error: AnalysisError };

/** 型付きエラーを組み立てる小ヘルパー。 */
function makeError(kind: PipelineErrorKind): AnalysisError {
  return { kind, message: ERROR_MESSAGES[kind] };
}

/** エラー結果（第 2 相用）を組み立てる小ヘルパー。 */
function fail(kind: PipelineErrorKind): AnalysisOutcome {
  return { ok: false, error: makeError(kind) };
}

/**
 * 第 1 相：画像だけから重心（ピクセル）と外形を求める。
 *
 * α マスクは重心走査と輪郭抽出が共有する唯一の前処理なので、ここで 1 回だけ構築して
 * 両者へ渡す。これにより 3000px 級でも α 判定の全画素走査を 1 回にまとめられる。
 * この相はパラメータに依存しないため、画像が変わった時だけ実行すれば足りる。
 *
 * α>0 が皆無（＝重心が取れない／外形が空）なら透明画像として型付きエラーを返す。
 * 本来 imageLoader が読み込み段階で弾くが、防御的に検査する。
 */
export function analyzeImage(image: FigureImage): ImageAnalysisOutcome {
  const { imageData, width, height } = image;

  // α マスク：重心・輪郭が共有する画像不変の前処理。1 回だけ構築する。
  const mask = buildAlphaMask(imageData);

  // 重心は差込口・台座・転倒角すべての基準。α>0 が皆無なら透明画像として扱う。
  const centroid = computeCentroidFromMask(mask, width, height);
  if (!centroid) {
    return { ok: false, error: makeError('transparentImage') };
  }

  // 外形はオーバーレイ・SVG 用。重心が取れていれば通常は空にならないが、防御的に検査。
  const contour = extractContour(mask, width, height);
  if (contour.length === 0) {
    return { ok: false, error: makeError('transparentImage') };
  }

  return { ok: true, value: { centroid, contour } };
}

/**
 * 第 2 相：画像不変量（analyzeImage の結果）とパラメータから解析結果一式を求める。
 *
 * スケール（mm/px）をまず確定し、以降の幾何はすべてピクセル座標で計算して結果の
 * 段で mm へ換算する。各ステップの null は「その段で計算不能」を意味し、意味の近い
 * エラー種別へ写して早期に返す。全段を通れば AnalysisResult を組み立てて返す。
 *
 * ここに残るのはパラメータ依存の軽量計算のみ（差込口探索は下端付近の数行で決着する
 * ため実質軽量）。重い全画素走査は analyzeImage 側に集約済みで、パラメータ変更では
 * 再実行されない。
 */
export function runAnalysis(
  image: FigureImage,
  imageAnalysis: ImageAnalysis,
  params: AnalysisParameters,
): AnalysisOutcome {
  const { imageData, width, height } = image;
  const { centroid: centroidPixel, contour } = imageAnalysis;

  // スケールが出せないと以降の実寸計算がすべて破綻する。UI の入力制約下では起きない
  // が、防御的に検査し、計算不能として扱う（下流へ NaN を伝播させない）。
  const mmPerPixel = computeMmPerPixel(params.figureHeightMm, height);
  if (!Number.isFinite(mmPerPixel) || mmPerPixel <= 0) {
    return fail('baseCalculationFailed');
  }

  // ピクセル重心へ mm 座標を付与。走査済みの結果に対する軽量な写像。
  const centroid = toCentroid(centroidPixel, mmPerPixel);

  const slot = findSlot(imageData, centroid, params.slotWidthMm, mmPerPixel);
  if (!slot) {
    return fail('slotPlacementFailed');
  }

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
      contour,
      centroid,
      slot,
      base,
      stability,
    },
  };
}
