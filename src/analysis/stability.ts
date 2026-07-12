// 転倒シミュレーション：左右方向・前後方向それぞれの転倒角を求める。
//
// 台座に立ったフィギュアは、外力で傾けられると支持範囲の「端」を支点に回転して
// 倒れる。ある方向へ倒れ始める限界は、重心の鉛直投影がその支点の真上に到達した
// 瞬間であり、そこまでに必要な傾き角が「転倒角」＝その方向の転倒に対する余裕を表す。
// 角が大きいほど倒れにくい。React には依存しない純粋ロジック。
//
// SPEC の定義：
//   θ = atan(支持端距離 / 重心高さ)
//   ・支持端距離：重心の鉛直投影から、倒れる側の支持端までの水平距離。
//   ・重心高さ ：台座上面（接地面）から測った重心の高さ。
//   左右・前後それぞれについて計算する。
//
// 左右は前面図で完結する：base.ts が確定した支持範囲（supportLeftMm / supportRightMm）と
// 台座上面（topYMm）をそのまま使い、台座計算と同じ基準で角度を出す。
//
// 前後は画像に写らない奥行方向なので、幾何を 1 本の軸として組み立てる。台座の奥行中心を
// 原点にとると支持端は ±奥行/2、薄板は台座のスリットへ差し込まれるので重心の奥行位置は
// スリット中心（slot.depthOffsetMm）そのものになる。重心高さは左右と同じ値（重心は板の
// 面内にあり、奥行方向へ傾けても高さは変わらない）を使う。

import type { BaseResult, Centroid, SlotResult, StabilityResult } from '@/model/types';
import { radToDeg } from '@/utils/geometry';

/**
 * 転倒角を左右・前後それぞれ計算する。
 *
 * 左へ倒れる支点は支持範囲の左端 supportLeftMm、右へ倒れる支点は右端
 * supportRightMm。重心の鉛直投影 centroidXMm から各支点までの水平距離を分子、
 * 重心高さ centroidHeightMm を分母に取り、θ = atan(距離 / 高さ) を度で返す。
 * 前後の支点は台座の前縁・後縁（奥行中心 ± 奥行/2）で、重心の奥行位置は
 * スリット中心（slot.depthOffsetMm）。
 *
 * 重心高さは base.ts と同一の式（台座上面 topYMm − 重心の mm-y）。台座上面は
 * カットライン最下端 + 持ち上げ量で決まるため、画像下端ではなくこの線を基準にする。
 *
 * null を返すのは、入力が非有限か、重心高さが正でない場合。重心が接地面上
 * （高さ 0）だと分母が 0 になり atan が定義できない（幾何的にも自立し得ない）ため、
 * 台座計算失敗と同様に呼び出し側でエラー扱いできるよう null とする。
 *
 * なお安定な構成では重心は支持範囲内にあり（左右は台座幅の検査、前後はスリット内包の
 * 検査を base.ts が通している）、4 方向とも距離は非負になるため転倒角も非負で得られる。
 */
export function computeStability(
  centroid: Centroid,
  slot: SlotResult,
  base: BaseResult,
): StabilityResult | null {
  const centroidXMm = centroid.mm.x;
  const { supportLeftMm, supportRightMm, depthMm, topYMm } = base;
  const depthOffsetMm = slot.depthOffsetMm;

  // 台座上面（接地面）から測った重心高さ。base.ts と同じ導出。左右・前後で共通。
  const centroidHeightMm = topYMm - centroid.mm.y;

  // 不正値・ゼロ除算を下流へ伝播させない。高さが正でなければ角度は定義できない。
  if (
    !Number.isFinite(centroidXMm) ||
    !Number.isFinite(supportLeftMm) ||
    !Number.isFinite(supportRightMm) ||
    !Number.isFinite(depthMm) ||
    !Number.isFinite(depthOffsetMm) ||
    !Number.isFinite(centroidHeightMm) ||
    centroidHeightMm <= 0
  ) {
    return null;
  }

  // 各支点までの水平距離。支持範囲内なら左右いずれも非負になる。
  const distanceLeftMm = centroidXMm - supportLeftMm;
  const distanceRightMm = supportRightMm - centroidXMm;

  // 前後：奥行中心を原点に、重心（＝スリット中心）から前縁 +奥行/2・後縁 −奥行/2 までの距離。
  const halfDepthMm = depthMm / 2;
  const distanceFrontMm = halfDepthMm - depthOffsetMm;
  const distanceBackMm = halfDepthMm + depthOffsetMm;

  return {
    tippingAngleLeftDeg: tippingAngleDeg(distanceLeftMm, centroidHeightMm),
    tippingAngleRightDeg: tippingAngleDeg(distanceRightMm, centroidHeightMm),
    tippingAngleFrontDeg: tippingAngleDeg(distanceFrontMm, centroidHeightMm),
    tippingAngleBackDeg: tippingAngleDeg(distanceBackMm, centroidHeightMm),
  };
}

/** θ = atan(支持端距離 / 重心高さ) を度で返す。SPEC の定義そのもの。 */
function tippingAngleDeg(distanceMm: number, heightMm: number): number {
  return radToDeg(Math.atan(distanceMm / heightMm));
}
