// 台座サイズ計算：支持多角形の考え方で、ユーザー指定の台座幅・奥行の妥当性を検査する。
//
// アクリルフィギュアは差込口（スリット）へタブを挿して自立する。左右方向の
// 転倒に抗するのは台座の横幅、前後方向に抗するのは奥行であり、その台座の接地範囲＝
// 「支持範囲」に重心の鉛直投影が収まっていれば静的には倒れない（支持多角形の考え方）。
// 幅・奥行はいずれもユーザーが実寸で指定するため、本モジュールは指定値が成立するか
// （重心を支えられるか・スリットを内包できるか）を検査するだけで、寸法は作らない。
// React には依存しない純粋ロジック。
//
// SPEC の定義：
//  - 最低条件：重心が支持範囲内。
//  - 台座幅・台座奥行はユーザー指定値をそのまま実寸とする。
//  - 必要幅を下回る幅、スリットを内包できない奥行は台座計算不可とする。
//
// 最低条件は「倒れない」の臨界（台座端が重心の真下にちょうど届く）を表すだけで、
// 余裕の大きさは含まない。どれだけ余裕があるかは stability が返す転倒角で示す
// （台座端がちょうど重心の真下なら 0°、幅・奥行を広げるほど大きくなる）。
//
// 座標系：台座は差込口中心（slot.centerXMm）を軸に左右対称へ配置する。差込口は
// フィギュアのタブ位置＝重心の真下に最も近い位置に置かれるため、台座もそこを中心に
// 取るのが物理的に自然で、overlay の緑矩形（slot 中心対称で描画）とも一致する。
// 奥行方向は台座の奥行中心が原点で、スリットはそこから slot.depthOffsetMm ずれた位置。

import type { AnalysisParameters, BaseResult, Centroid, Contour, SlotResult } from '@/model/types';

/**
 * 台座上面 Y（ピクセル）を求める。
 *
 * SPEC「アクリル板と台座の上下関係」の不変条件（板の最下端 ≦ 台座上面）を成立させる
 * ための基準線。カットライン余白を大きく取ると外形は画像下端より下へ広がるため、
 * 基準は「画像下端」ではなく**カットラインの最下端**に取る。そこへ持ち上げ量を足した
 * 位置を台座上面とし、持ち上げ量 0 なら板の下端と台座上面がちょうど接する（Y は下方向 +）。
 *
 * 退化入力（空のカットライン・不正な持ち上げ量／スケール）では NaN を返し、
 * 呼び出し側で台座計算不可として弾けるようにする。
 */
export function computeBaseTopYPixel(
  contour: Contour,
  plateLiftMm: number,
  mmPerPixel: number,
): number {
  if (!Number.isFinite(plateLiftMm) || plateLiftMm < 0 || !(mmPerPixel > 0)) {
    return Number.NaN;
  }
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of contour) {
    if (p.y > maxY) {
      maxY = p.y;
    }
  }
  if (!Number.isFinite(maxY)) {
    return Number.NaN;
  }
  return maxY + plateLiftMm / mmPerPixel;
}

/**
 * 台座サイズを計算する。
 *
 * 台座幅・奥行はユーザー指定値（params.baseWidthMm / baseDepthMm）をそのまま実寸として採る。
 * 差込口中心を軸に左右対称な矩形台座を想定するため、支持範囲は 差込口中心 ± 台座幅/2 になる。
 *
 * 必要幅は**指定幅の検査**にだけ使う。重心が差込口中心から水平に offset だけずれていると
 * き、重心を支持範囲へ収める最小幅は 2×offset（台座端がちょうど重心の真下に届く幅）。
 * さらにスリットを内包できる必要があるため差込口幅も下限に取る。指定幅がこの必要幅に
 * 満たなければ台座計算不可（null）とし、UI で台座幅を広げるよう促す。倒れにくさの余裕は
 * ここでは判定せず、転倒角（stability）を見て台座幅・奥行を決めてもらう。
 *
 * 奥行の検査は上面図での**スリットの内包**：スリットは幅 = 板厚（ツメ深さ）で、台座の奥行
 * 中心から slot.depthOffsetMm ずれた位置に切る。板厚/2 + |前後オフセット| が 奥行/2 を
 * 超えるとスリットが台座の縁を割ってしまうため、台座計算不可とする。これは同時に
 * 「ツメが台座を貫通しない（ツメ深さ ≦ 台座奥行）」という SPEC の要件も満たす。
 *
 * 重心高さは台座上面（接地面）から測る（SPEC「重心高さは台座上面を基準」）。台座上面は
 * カットライン最下端 + 持ち上げ量で決まるため、画像下端ではなく baseTopYMm を基準にする。
 *
 * 失敗（null）を返すのは、入力が不正（非有限・台座幅／奥行が非正）な場合と、最低条件
 * 「重心が支持範囲内」（＋スリット内包）を満たせなかった場合。呼び出し側はこれを
 * baseCalculationFailed としてエラー表示へマッピングする。
 */
export function computeBase(
  centroid: Centroid,
  slot: SlotResult,
  params: AnalysisParameters,
  baseTopYMm: number,
): BaseResult | null {
  const { baseWidthMm, baseDepthMm, slotWidthMm } = params;

  // 実寸(mm)座標での重心 X・差込口中心 X。以降の幾何はすべて mm で完結する。
  const centroidXMm = centroid.mm.x;
  const slotCenterXMm = slot.centerXMm;

  // 不正値を下流へ伝播させない。
  if (
    !Number.isFinite(centroidXMm) ||
    !Number.isFinite(slotCenterXMm) ||
    !Number.isFinite(slotWidthMm) ||
    !Number.isFinite(baseWidthMm) ||
    !Number.isFinite(baseDepthMm) ||
    !Number.isFinite(baseTopYMm) ||
    !Number.isFinite(slot.tabDepthMm) ||
    !Number.isFinite(slot.depthOffsetMm) ||
    baseWidthMm <= 0 ||
    baseDepthMm <= 0
  ) {
    return null;
  }

  // 重心の差込口中心からの水平ずれ。台座を対称に取るとき、片側がこれを覆えば
  // 反対側は自動的に覆われるため、支持幅の必要量はこの片側ずれで決まる。
  const offsetMm = Math.abs(centroidXMm - slotCenterXMm);

  // 必要幅：最低条件（重心が支持範囲内＝幅 2×offset）。加えてスリットを内包できるよう
  // 差込口幅を下限に取る（切り欠きが台座からはみ出さない床）。
  const requiredWidthMm = Math.max(2 * offsetMm, slotWidthMm);

  // 台座幅はユーザー指定値そのもの。必要幅に届かない指定は自立を保証できないため、
  // 黙って広げず台座計算不可として返し、UI で台座幅・オフセットの見直しを促す。
  if (baseWidthMm < requiredWidthMm) {
    return null;
  }

  // 必要奥行：上面図でスリット（幅 = 板厚）が台座に収まる最小の奥行。前後オフセットで
  // スリットが縁へ寄るほど、その両側を覆うために奥行が要る。
  const requiredDepthMm = slot.tabDepthMm + 2 * Math.abs(slot.depthOffsetMm);
  if (baseDepthMm < requiredDepthMm) {
    return null;
  }

  const widthMm = baseWidthMm;
  const halfWidthMm = widthMm / 2;

  const supportLeftMm = slotCenterXMm - halfWidthMm;
  const supportRightMm = slotCenterXMm + halfWidthMm;

  return {
    widthMm,
    depthMm: baseDepthMm,
    topYMm: baseTopYMm,
    supportLeftMm,
    supportRightMm,
  };
}
