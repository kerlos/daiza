// プレビューの実寸(mm)グリッド（2D）。
//
// ルーラー（components/Ruler）と同じ目盛り列（render/ruler の buildRulerTicks）を使い、
// その位置へビューポートいっぱいの線を引くだけの presentational な層。目盛りロジックを
// 共有することで、格子は必ずルーラーの目盛りと一致し、ズームに応じた間隔の切り替え
// （1 / 5 / 10 / 50 / 100mm）もルーラーと同時に起きる。
//
// ルーラーと同じく、ビューポートに固定表示して transform から線の位置を算出する
// （stage の transform を受けない）。stage より背面に敷くため、透明 PNG の抜けた部分に
// 方眼紙のように透けて見え、絵柄・オーバーレイを覆い隠さない。pointer-events は持たない
// ので、ドラッグパン・ホイールズームを妨げない。

import { useMemo } from 'react';

import type { ViewportTransform } from '@/hooks/useViewport';
import type { Point } from '@/model/types';
import { buildRulerTicks } from '@/render/ruler';

/** 線の不透明度。副目盛り < 主目盛り < 原点軸の順に強め、原点（接地面・重心）を読み取れるようにする。 */
const MINOR_OPACITY = 0.2;
const MAJOR_OPACITY = 0.4;
const AXIS_OPACITY = 0.7;

export interface GridProps {
  /** ビューポート（プレビュー領域）の実サイズ(px)。 */
  width: number;
  height: number;
  /** 現在のズーム/パン変換。格子の間隔・画面上の位置はここから導く。 */
  transform: ViewportTransform;
  /** スケール換算係数(mm/px)。格子を実寸(mm)にするために必要。 */
  mmPerPixel: number;
  /** 実寸座標系の原点（0, 0）に対応する画像ピクセル座標。 */
  origin: Point;
}

export function Grid({ width, height, transform, mmPerPixel, origin }: GridProps) {
  // ルーラーと同一の 1 次式（screen = originPx + direction × mm × pxPerMm）で位置を出す。
  const pxPerMm = transform.scale / mmPerPixel;
  const originScreenX = transform.tx + transform.scale * origin.x;
  const originScreenY = transform.ty + transform.scale * origin.y;

  // 垂直側は direction = -1（実寸 Y は上を正）。ルーラーと同じ呼び出しにすることで、
  // 描かれる格子線とルーラーの目盛りが 1 対 1 に対応する。
  const verticalLines = useMemo(
    () => buildRulerTicks(width, originScreenX, pxPerMm),
    [width, originScreenX, pxPerMm],
  );
  const horizontalLines = useMemo(
    () => buildRulerTicks(height, originScreenY, pxPerMm, -1),
    [height, originScreenY, pxPerMm],
  );

  // スケール未確定（mmPerPixel が NaN 等）なら実寸の格子を描けない。
  if (!(pxPerMm > 0)) {
    return null;
  }

  const opacityOf = (mm: number, major: boolean): number =>
    mm === 0 ? AXIS_OPACITY : major ? MAJOR_OPACITY : MINOR_OPACITY;

  return (
    <svg
      width={width}
      height={height}
      className="text-muted-foreground pointer-events-none absolute inset-0"
      aria-hidden
    >
      {verticalLines.map((tick) => (
        <line
          key={`v${tick.mm}`}
          x1={tick.position}
          x2={tick.position}
          y1={0}
          y2={height}
          stroke="currentColor"
          strokeWidth={1}
          strokeOpacity={opacityOf(tick.mm, tick.major)}
        />
      ))}
      {horizontalLines.map((tick) => (
        <line
          key={`h${tick.mm}`}
          x1={0}
          x2={width}
          y1={tick.position}
          y2={tick.position}
          stroke="currentColor"
          strokeWidth={1}
          strokeOpacity={opacityOf(tick.mm, tick.major)}
        />
      ))}
    </svg>
  );
}
