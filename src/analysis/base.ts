// 台座サイズ計算：支持多角形の考え方で推奨台座幅・奥行を求める。
//
// アクリルフィギュアは差込口（スリット）へタブを挿して自立する。左右方向の
// 転倒に抗するのは台座の横幅であり、その台座の接地範囲＝「支持範囲」に重心の
// 鉛直投影が収まっていれば静的には倒れない（支持多角形の考え方）。本モジュールは
// この最低条件を満たしつつ、安全率と余白を織り込んだ推奨台座幅、および前後方向の
// 安定を担保する推奨奥行を算出する。React には依存しない純粋ロジック。
//
// SPEC の定義：
//  - 最低条件：重心が支持範囲内。
//  - 安全率を掛けて推奨台座幅を計算する。
//  - 推奨奥行を算出する。
//
// 座標系：台座は差込口中心（slot.centerXMm）を軸に左右対称へ配置する。差込口は
// フィギュアのタブ位置＝重心の真下に最も近い位置に置かれるため、台座もそこを中心に
// 取るのが物理的に自然で、overlay の緑矩形（slot 中心対称で描画）とも一致する。

import type { AnalysisParameters, BaseResult, Centroid, SlotResult } from '@/model/types';
import { degToRad } from '@/utils/geometry';

/**
 * 推奨奥行を決める前後方向の目標転倒角(度)。
 * 薄板フィギュアの重心は板の面内にあり、前後方向には台座中心の真上へ落ちる。
 * よって前後の静的安定はどんな奥行でも成立するが、外乱に耐える余裕として
 * 「重心高さに対しこの角度まで傾けても倒れない」奥行を確保する。アプリが左右
 * 転倒に用いるのと同じ θ=atan(支持端距離 / 重心高さ) の関係を前後へ流用する。
 */
const DEPTH_TARGET_TIPPING_ANGLE_DEG = 15;

/** 上記目標角の tan。奥行 = 2 × 重心高さ × tan(目標角) の係数として使う。 */
const DEPTH_ANGLE_TAN = Math.tan(degToRad(DEPTH_TARGET_TIPPING_ANGLE_DEG));

/**
 * スリットを切るために台座奥行が最低限必要な、板厚に対する倍率。
 * 差込口は板厚ぶんの溝＋その前後を支える壁が要る。前後それぞれに板厚ぶんの壁を
 * 見込み、板厚の 3 倍を製造上の下限とする（重心高さ由来の推奨値がこれを下回る
 * 小さなフィギュアでも、スリットが成立する奥行を割らないようにするための床）。
 */
const SLOT_WALL_FACTOR = 3;

/**
 * 台座サイズを計算する。
 *
 * 差込口中心を軸に左右対称な矩形台座を想定する。重心が差込口中心から水平に
 * offset だけずれているとき、その重心を支持範囲へ収める最小の台座幅は 2×offset
 * （台座端がちょうど重心の真下に届く幅）。SPEC どおりこれに安全率を掛けて推奨幅の
 * 核とし、スリットを内包するため差込口幅を下限に取り、最後に左右余白を足す。
 *
 * 奥行は前後方向の安定（DEPTH_TARGET_TIPPING_ANGLE_DEG）を満たす footing と、
 * スリット加工上の下限（板厚基準）の大きい方を採る。
 *
 * 失敗（null）を返すのは、入力が不正（非有限・安全率が非正）な場合と、最低条件
 * 「重心が支持範囲内」を満たせなかった場合。呼び出し側はこれを
 * baseCalculationFailed としてエラー表示へマッピングする。
 */
export function computeBase(
  centroid: Centroid,
  slot: SlotResult,
  params: AnalysisParameters,
): BaseResult | null {
  const { safetyFactor, baseMarginMm, slotWidthMm, thicknessMm, figureHeightMm } = params;

  // 実寸(mm)座標での重心 X・差込口中心 X。以降の幾何はすべて mm で完結する。
  const centroidXMm = centroid.mm.x;
  const slotCenterXMm = slot.centerXMm;

  // 不正値を下流へ伝播させない。安全率は正でなければ「最小幅×安全率」が破綻する。
  if (
    !Number.isFinite(centroidXMm) ||
    !Number.isFinite(slotCenterXMm) ||
    !Number.isFinite(slotWidthMm) ||
    !Number.isFinite(baseMarginMm) ||
    !Number.isFinite(safetyFactor) ||
    safetyFactor <= 0
  ) {
    return null;
  }

  // 重心の差込口中心からの水平ずれ。台座を対称に取るとき、片側がこれを覆えば
  // 反対側は自動的に覆われるため、支持幅の必要量はこの片側ずれで決まる。
  const offsetMm = Math.abs(centroidXMm - slotCenterXMm);

  // 支持幅の核：最小幅(2×offset)に安全率を掛ける。ただしスリットを内包できるよう
  // 差込口幅を下限とする（重心が中心真上＝offset≈0 でも台座が消えないための床）。
  const supportWidthCore = Math.max(2 * offsetMm * safetyFactor, slotWidthMm);

  // 左右余白を加えた実台座幅。余白ぶんも実体のある材料なので支持範囲に含める。
  const widthMm = supportWidthCore + 2 * baseMarginMm;
  const halfWidthMm = widthMm / 2;

  const supportLeftMm = slotCenterXMm - halfWidthMm;
  const supportRightMm = slotCenterXMm + halfWidthMm;

  // 最低条件の明示ガード：重心が支持範囲内に収まること。安全率≥1・余白≥0 なら
  // 構成上必ず満たされるが、範囲外の入力（安全率<1 等）で破れうるため検査する。
  if (centroidXMm < supportLeftMm || centroidXMm > supportRightMm) {
    return null;
  }

  // 重心高さ（台座接地面＝画像下端からの高さ）。mmPerPixel は
  // figureHeightMm / imageHeight なので、画像下端は実寸で figureHeightMm に対応する。
  const centroidHeightMm = Math.max(0, figureHeightMm - centroid.mm.y);

  const depthMm = Math.max(2 * centroidHeightMm * DEPTH_ANGLE_TAN, thicknessMm * SLOT_WALL_FACTOR);

  return {
    widthMm,
    depthMm,
    supportLeftMm,
    supportRightMm,
  };
}
