// 外形（輪郭）抽出：α>0 領域の外周を 1 本の閉ポリゴンとして取り出す。
//
// 用途はオーバーレイの「外形（半透明）」描画と SVG エクスポートの外形線。
// Moore 近傍追跡（Moore-Neighbor Tracing）に Jacob の停止条件を組み合わせ、
// ラスタ走査で最初に見つかる充填ピクセルを起点に外周を時計回りにたどる。
// React には依存しない純粋ロジック。
//
// 設計判断：
//  - しきい値は imageLoader・centroid と同じ「α>0 を充填」。座標系は画像左上
//    原点・下方向 +Y。
//  - 入力は RGBA ではなく事前構築済みの α ビットマスク（Uint8Array）。追跡は 1 画素
//    あたり最大 8 近傍を何度も参照するため、RGBA から都度 α を読むよりキャッシュ効率
//    が良い。マスク構築（buildAlphaMask）は呼び出し側（pipeline）が重心走査と共有する
//    ため、ここでは受け取るだけにして α 判定の全画素走査が二重にならないようにする。
//  - 現状は単一輪郭（最初に見つかる連結成分の外周）を返す。穴あき・複数輪郭は
//    型（Contour[]）ごと将来拡張する前提で、ここでは単一 Contour に留める。

import type { Contour, Point } from '@/model/types';

/**
 * 時計回り（下方向 +Y）8 近傍のインデックス → オフセット。
 * 0:E 1:SE 2:S 3:SW 4:W 5:NW 6:N 7:NE の順。追跡は「直前の空きセルの次」から
 * この順に走査して最初の充填セルを見つける。switch で必ず確定値を返すことで、
 * 配列添字経由の undefined（noUncheckedIndexedAccess）を避ける。
 */
function offsetAt(index: number): Point {
  switch (index & 7) {
    case 0:
      return { x: 1, y: 0 };
    case 1:
      return { x: 1, y: 1 };
    case 2:
      return { x: 0, y: 1 };
    case 3:
      return { x: -1, y: 1 };
    case 4:
      return { x: -1, y: 0 };
    case 5:
      return { x: -1, y: -1 };
    case 6:
      return { x: 0, y: -1 };
    default:
      return { x: 1, y: -1 };
  }
}

/**
 * 近傍オフセット (dx, dy) を上記インデックスへ逆変換する。
 * 進入元セル（backtrack）が中心から見てどの方向かを求め、走査開始位置に使う。
 * (0,0) は呼ばれない前提。
 */
function directionIndex(dx: number, dy: number): number {
  switch ((dy + 1) * 3 + (dx + 1)) {
    case 5:
      return 0;
    case 8:
      return 1;
    case 7:
      return 2;
    case 6:
      return 3;
    case 3:
      return 4;
    case 0:
      return 5;
    case 1:
      return 6;
    case 2:
      return 7;
    default:
      return 0;
  }
}

/** ラスタ走査で最初の充填ピクセル（最上行・その中で最左）を探す。 */
function findStart(mask: Uint8Array, width: number, height: number): Point | null {
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      if (mask[rowOffset + x] === 1) {
        return { x, y };
      }
    }
  }
  return null;
}

/** Moore 追跡の 1 ステップの結果。次の外周画素と、その進入元（空きセル）。 */
interface TraceStep {
  nx: number;
  ny: number;
  backX: number;
  backY: number;
}

/**
 * 中心 (bx,by) の周りを、進入元 (cx,cy) の次から時計回りに走査し、
 * 最初に見つかった充填ピクセルを次の外周画素として返す。
 * その直前に調べた（空きの）セルが新たな進入元 backtrack になる。
 * 充填近傍が皆無なら孤立点として null を返す。
 */
function findNextBoundary(
  bx: number,
  by: number,
  cx: number,
  cy: number,
  isFilled: (x: number, y: number) => boolean,
): TraceStep | null {
  const startIndex = directionIndex(cx - bx, cy - by);
  for (let k = 1; k <= 8; k++) {
    const index = (startIndex + k) & 7;
    const offset = offsetAt(index);
    const nx = bx + offset.x;
    const ny = by + offset.y;
    if (isFilled(nx, ny)) {
      // 直前（時計回りで 1 つ手前）の空きセルを次回の進入元とする。
      const back = offsetAt((index + 7) & 7);
      return { nx, ny, backX: bx + back.x, backY: by + back.y };
    }
  }
  return null;
}

/**
 * α>0 領域の外形ポリゴン（ピクセル座標系）を抽出する。
 *
 * 入力は事前構築済みの α マスク（1=充填）と、その寸法。起点は上・左が空きである
 * ことが保証されるため、西（左）から進入したとみなして追跡を始める。停止は Jacob の
 * 条件：起点 b0 へ戻り、かつ次の一歩が最初の一歩 b1 と一致したとき閉じる。これにより
 * 起点を通過するだけの場合と、真に一周した場合を区別でき、頂点の重複なく閉ポリゴンを
 * 得られる。
 *
 * 全透明（充填なし）は空配列を返す。呼び出し側で解析不能として扱えるようにする。
 */
export function extractContour(mask: Uint8Array, width: number, height: number): Contour {
  const isFilled = (x: number, y: number): boolean =>
    x >= 0 && x < width && y >= 0 && y < height && mask[y * width + x] === 1;

  const start = findStart(mask, width, height);
  if (!start) {
    return [];
  }

  const b0 = start;
  // 進入元は西の空きセル。ここから時計回りに最初の外周画素を探す。
  const firstStep = findNextBoundary(b0.x, b0.y, b0.x - 1, b0.y, isFilled);
  if (!firstStep) {
    // 孤立 1 画素。外形はその点のみ。
    return [{ x: b0.x, y: b0.y }];
  }

  const boundary: Point[] = [{ x: b0.x, y: b0.y }];
  const b1: Point = { x: firstStep.nx, y: firstStep.ny };

  let bx = firstStep.nx;
  let by = firstStep.ny;
  let cx = firstStep.backX;
  let cy = firstStep.backY;

  // 異常形状でも無限ループしないための上限。外周長は全画素周長を超えない。
  const maxSteps = width * height * 4 + 8;
  for (let step = 0; step < maxSteps; step++) {
    const next = findNextBoundary(bx, by, cx, cy, isFilled);
    // Jacob の停止条件：起点に戻り、次の一歩が最初の一歩と一致したら一周完了。
    if (bx === b0.x && by === b0.y && next && next.nx === b1.x && next.ny === b1.y) {
      break;
    }
    boundary.push({ x: bx, y: by });
    if (!next) {
      // 追跡が行き止まり（通常は起こらない）。得られた分で打ち切る。
      break;
    }
    cx = next.backX;
    cy = next.backY;
    bx = next.nx;
    by = next.ny;
  }

  return boundary;
}
