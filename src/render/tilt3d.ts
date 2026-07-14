// 3D プレビューの傾け（転倒シミュレーション）の姿勢モデル。純粋ロジック（React / three 非依存）。
//
// 傾けは「方位角 φ の向きへ、傾き量 θ だけ倒す」の 2 値で表す。φ の規約は解析と共通で
// **右 0°・前 90°・左 180°・後 270°**、方向ベクトルは d = (cos φ, sin φ)（台座ローカル座標。
// x = 右正、y = 前正 ＝ 3D シーンの Z）。
//
// ■ 支点（回転軸）
// 支点は footprint 凸包を**法線 d の直線で支えたときの支持直線**（接触辺、または接触点での接線）
// である。すなわち ⟨p, d⟩ = h(d) を満たす直線であり、h は転倒角と同じ支持関数（analysis/stability）。
// 台座の bbox の端から取ってはならない：円・楕円では斜め方向の「bbox の角」が footprint の外側の
// 点になり、そこを軸に回すと台座が床から浮く。
//
// ■ 回転
// 軸 a まわりの微小回転で +Y は a × ŷ = (−a_z, 0, a_x) へ動く。これを d = (dx, 0, dy) に一致させると
// a = (dy, 0, −dx)、回転角は +θ。φ=0（右）では a=(0,0,−1)・+θ ＝ 「Z 軸まわり −θ」、φ=90（前）では
// a=(1,0,0)・+θ ＝ 「X 軸まわり +θ」となり、4 方向のみを扱っていた従来の実装と一致する。

import { supportDistance, supportValue, tippingAngleDeg } from '@/analysis/stability';
import type { Point } from '@/model/types';
import type { Vec3 } from '@/render/scene3d';
import { degToRad } from '@/utils/geometry';

/**
 * 支持直線に「接している」とみなす許容差の比率（台座の代表寸法に対する相対値）。
 * 折れ線化・凸包の計算誤差で、辺の 2 頂点の ⟨v,d⟩ がわずかにずれるため、絶対値では判定しない。
 */
const CONTACT_EPSILON_RATIO = 1e-6;

/** 接触点が 1 点のとき（円・楕円の接線）に描く支点線の長さ（台座の代表寸法に対する比率）。 */
const TANGENT_LENGTH_RATIO = 0.25;

/** 傾けの計算に必要な台座の幾何一式（すべて台座ローカル座標 mm）。 */
export interface Tilt3dModel {
  /** footprint の凸包。支持範囲＝支点はここで決まる（凹みは接地の支持範囲を広げない）。 */
  readonly hull: readonly Point[];
  /** 重心の鉛直投影 g（analysis/base の centroidProjection と同一定義）。 */
  readonly groundCentroid: Point;
  /** 台座上面（接地面）から測った重心高さ(mm)。転倒角の分母。 */
  readonly centroidHeightMm: number;
  /** 台座の代表寸法(mm)。許容差と接線の長さの基準に使う。 */
  readonly spanMm: number;
  /** 全方位で最小の転倒角(度)と、その方位角(度)。「最悪方位へ」の一発操作に使う。 */
  readonly minTippingDeg: number;
  readonly worstAzimuthDeg: number;
}

/** ある方位・傾き量における姿勢（シーン座標 mm。原点 = 接地面上の footprint 中心）。 */
export interface Tilt3dPose {
  /** 回転軸上の点（支持直線の足）。接地面上なので Y = 0。 */
  readonly pivot: Vec3;
  /** 回転軸の向き（単位ベクトル。支持直線と同じ向き）。 */
  readonly axis: Vec3;
  /** axis まわりの回転角(ラジアン)。 */
  readonly angleRad: number;
  /** この方位の転倒角(度)。 */
  readonly limitDeg: number;
  /** 転倒角を超えているか（＝この角度では倒れる）。 */
  readonly falling: boolean;
  /** 支点のハイライト線分（接触辺、または接触点での接線）。 */
  readonly edge: readonly [Vec3, Vec3];
}

/** 方位角(度) → 単位方向ベクトル (dx, dy)。y は前が正。 */
function direction(azimuthDeg: number): readonly [number, number] {
  const rad = degToRad(azimuthDeg);
  return [Math.cos(rad), Math.sin(rad)];
}

/** その方位へ倒すときの転倒角(度)。φ = 0/90/180/270 では stability の左右前後と一致する。 */
export function tiltLimitDeg(model: Tilt3dModel, azimuthDeg: number): number {
  const [dx, dy] = direction(azimuthDeg);
  return tippingAngleDeg(
    supportDistance(model.hull, model.groundCentroid, dx, dy),
    model.centroidHeightMm,
  );
}

/**
 * 方位角 φ・傾き量 θ の姿勢を組み立てる。
 *
 * 支点は凸包の支持直線 ⟨p, d⟩ = h(d)。接触が辺なら実際の接触辺を、1 点なら（円・楕円のように
 * 接線が 1 点で触れる場合）その点を中心とした短い接線を、支点ハイライト用に返す。
 */
export function tiltPose(model: Tilt3dModel, azimuthDeg: number, tiltDeg: number): Tilt3dPose {
  const { hull, groundCentroid: g, centroidHeightMm } = model;
  const [dx, dy] = direction(azimuthDeg);

  const supportMm = supportValue(hull, dx, dy);
  // 支持直線の足（原点から直線へ下ろした垂線の足）。直線は pivot + t × axis で表せる。
  const pivot: Vec3 = [supportMm * dx, 0, supportMm * dy];
  const axis: Vec3 = [dy, 0, -dx];

  const distanceMm = supportMm - (g.x * dx + g.y * dy);
  const limitDeg = tippingAngleDeg(distanceMm, centroidHeightMm);

  return {
    pivot,
    axis,
    angleRad: degToRad(tiltDeg),
    limitDeg,
    falling: tiltDeg > limitDeg,
    edge: contactEdge(model, dx, dy, supportMm, pivot),
  };
}

/**
 * 支持直線と凸包の接触部（支点として床に触れている線分）。
 *
 * 接触している頂点は ⟨v, d⟩ = h(d) を満たす＝すべて支持直線上に載るので、そのまま軸方向の
 * 両端を結べば接触辺になる。頂点が 1 つしか無い（点接触）ときは線分にならないため、その点を
 * 中心に軸方向へ伸ばした短い接線を返す（支点の位置と向きを目で追えるようにするための表示）。
 */
function contactEdge(
  model: Tilt3dModel,
  dx: number,
  dy: number,
  supportMm: number,
  pivot: Vec3,
): readonly [Vec3, Vec3] {
  const epsilon = Math.max(model.spanMm, 1) * CONTACT_EPSILON_RATIO;

  // 軸方向（= 支持直線の向き (dy, −dx)）の位置で接触頂点の両端を取る。
  let min: Point | null = null;
  let max: Point | null = null;
  let minT = Number.POSITIVE_INFINITY;
  let maxT = Number.NEGATIVE_INFINITY;
  for (const v of model.hull) {
    if (v.x * dx + v.y * dy < supportMm - epsilon) continue;
    const t = v.x * dy - v.y * dx;
    if (t < minT) {
      minT = t;
      min = v;
    }
    if (t > maxT) {
      maxT = t;
      max = v;
    }
  }

  if (min && max && maxT - minT > epsilon) {
    return [
      [min.x, 0, min.y],
      [max.x, 0, max.y],
    ];
  }

  // 点接触（円・楕円の接線）。接触点は支持直線上にあるので、そこから軸方向へ均等に伸ばす。
  const center: Vec3 = min ? [min.x, 0, min.y] : pivot;
  const half = (Math.max(model.spanMm, 1) * TANGENT_LENGTH_RATIO) / 2;
  return [
    [center[0] - dy * half, 0, center[2] + dx * half],
    [center[0] + dy * half, 0, center[2] - dx * half],
  ];
}
