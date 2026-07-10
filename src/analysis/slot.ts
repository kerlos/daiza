// 差込口探索：画像最下部から、差込口幅が完全に収まる範囲を探して位置を決める。
//
// アクリルフィギュアは下端の「タブ」を台座のスリット（差込口）へ挿し込む。
// スリットを切る位置には、差込口幅ぶんのアクリルが隙間なく存在していなければ
// タブが痩せて折れてしまう。そこで「差込口幅が連続した充填領域に完全に収まる」
// ことを候補の必要条件とする。React には依存しない純粋ロジック。
//
// SPEC の定義：
//  - 画像最下部から探索する（＝できるだけ下端でタブを取る）。
//  - 差込口幅が完全に収まる範囲のみ候補とする。
//  - 候補が複数あるときは「重心の真下に最も近い位置」を採用する。
//
// しきい値は imageLoader・centroid・contour と同じ「α>0 を充填」で統一する。

import type { Centroid, SlotResult } from '@/model/types';
import { pixelLengthToMm } from '@/analysis/scale';
import { clamp } from '@/utils/geometry';
import { isAcrylicAlpha } from '@/utils/image';

/** 1 行内で連続して充填されている列の範囲（両端 inclusive のピクセル列番号）。 */
interface Span {
  start: number;
  end: number;
}

/**
 * 指定行の充填スパン（α>0 が連続する区間）を左から順に列挙する。
 * 行を 1 パス走査し、充填の立ち上がり／立ち下がりで区間を確定する。差込口は
 * 「途切れのない一続きの材料」に収める必要があるため、連結した区間の単位で扱う。
 */
function filledSpansInRow(data: Uint8ClampedArray, width: number, y: number): Span[] {
  const spans: Span[] = [];
  const rowOffset = y * width * 4;
  // 充填ラン開始列。-1 は「現在ラン外」を表す番兵。
  let runStart = -1;
  for (let x = 0; x < width; x++) {
    // α（RGBA の 4 番目）のみ参照。noUncheckedIndexedAccess 下では
    // number | undefined になるため ?? 0 で丸めて判定する。α>0 の規則は共有する。
    const alpha = data[rowOffset + x * 4 + 3] ?? 0;
    if (isAcrylicAlpha(alpha)) {
      if (runStart < 0) runStart = x;
    } else if (runStart >= 0) {
      spans.push({ start: runStart, end: x - 1 });
      runStart = -1;
    }
  }
  // 行末で開いたままのランを閉じる。
  if (runStart >= 0) {
    spans.push({ start: runStart, end: width - 1 });
  }
  return spans;
}

/**
 * 指定行のスパン群から、差込口幅が収まる中心のうち targetX に最も近いものを返す。
 *
 * 充填列 x は連続座標で区間 [x, x+1) を占めるとみなす。スパン [start, end] は
 * [start, end+1) を占め、その幅は (end - start + 1) 画素。差込口幅 w が収まるのは
 * 幅 ≥ w のスパンで、そのとき中心の可動範囲は [start + w/2, (end+1) - w/2]。
 * 「重心の真下（targetX）に最も近い位置」を採るため、各スパンで targetX を可動
 * 範囲へクランプし、距離が最小の中心を選ぶ。収まるスパンが無ければ null。
 */
function bestCenterInRow(spans: Span[], slotWidthPixel: number, targetX: number): number | null {
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const span of spans) {
    const spanWidth = span.end - span.start + 1;
    // 幅が差込口幅に満たないスパンは、そもそも完全に収まらないので候補外。
    if (spanWidth < slotWidthPixel) {
      continue;
    }
    const lo = span.start + slotWidthPixel / 2;
    const hi = span.end + 1 - slotWidthPixel / 2;
    const center = clamp(targetX, lo, hi);
    const distance = Math.abs(center - targetX);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = center;
    }
  }
  return best;
}

/**
 * 差込口位置を探索する。
 *
 * 画像下端の行から上へ走査し、差込口幅が完全に収まるスパンを持つ「最初（最も下）」の
 * 行を採用する。これにより SPEC の「画像最下部から探索」を満たしつつ、下端が
 * 細く尖って幅が足りない場合は必要なだけ上の行へ後退する。採用行の中では重心の
 * 真下に最も近い中心を選ぶ。
 *
 * 透明行（スパンなし）は自然にスキップされるため、フィギュア下方に紛れた孤立
 * ノイズも幅不足として読み飛ばせる。どの行でも収まらなければ配置不可として null を
 * 返し、呼び出し側が slotPlacementFailed としてエラー表示へマッピングできるようにする。
 */
export function findSlot(
  imageData: ImageData,
  centroid: Centroid,
  slotWidthMm: number,
  mmPerPixel: number,
): SlotResult | null {
  const { data, width, height } = imageData;

  // 差込口幅をピクセルへ換算。mmPerPixel が NaN/0 の異常時は探索不能として弾く。
  const slotWidthPixel = slotWidthMm / mmPerPixel;
  if (!Number.isFinite(slotWidthPixel) || slotWidthPixel <= 0) {
    return null;
  }

  const targetX = centroid.pixel.x;
  for (let y = height - 1; y >= 0; y--) {
    const spans = filledSpansInRow(data, width, y);
    if (spans.length === 0) {
      continue;
    }
    const center = bestCenterInRow(spans, slotWidthPixel, targetX);
    if (center !== null) {
      return {
        centerXPixel: center,
        yPixel: y,
        widthPixel: slotWidthPixel,
        // 中心 X はピクセル座標の位置。原点 0 起点なので長さ換算と同じ乗算でよい。
        centerXMm: pixelLengthToMm(center, mmPerPixel),
        // 幅は与えられた実寸値をそのまま保持し、往復換算による丸め誤差を避ける。
        widthMm: slotWidthMm,
      };
    }
  }

  return null;
}
