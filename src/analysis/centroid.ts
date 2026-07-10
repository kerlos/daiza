// 重心計算：α>0 を均一密度とみなし、画像モーメントで重心を求める。
//
// 解析パイプラインの中核の一つ。差込口探索（重心の真下）・台座幅（重心が支持
// 範囲内か）・転倒角（重心高さ）はすべてこの重心を基準に計算するため、他の
// 幾何計算に先立って確定させる。React には依存しない純粋ロジック。
//
// SPEC の定義：
//   Cx = Σx / N,  Cy = Σy / N   （α>0 のピクセル座標の平均）
// これは「各アクリルピクセルの密度を 1 とみなした 0 次・1 次モーメント」に等しい。

import type { Centroid, Point } from '@/model/types';
import { pixelPointToMm } from '@/analysis/scale';

/**
 * 重心のピクセル座標成分（実寸換算前の画像不変量）。
 *
 * ピクセル走査の結果は mm/px スケール（＝フィギュア高さパラメータ）に依存しない
 * ため、mm 換算と分離して保持する。これにより「画像が変わった時だけ走査し、
 * パラメータ変更では mm 換算だけをやり直す」二相構成（pipeline）を可能にする。
 */
export interface CentroidPixel {
  pixel: Point;
  pixelCount: number;
}

/**
 * α マスクからアクリル（α>0）ピクセルの重心（ピクセル座標）を求める。
 *
 * 1 パス走査で個数 N（0 次モーメント）と座標和 Σx, Σy（1 次モーメント）を
 * 累積し、最後に平均を取る。密度は一律 1 のため重み付けは不要で、この単純和で
 * SPEC の Cx=Σx/N, Cy=Σy/N がそのまま得られる。
 *
 * 入力は RGBA ではなく事前構築済みの 1 バイト/画素マスク（buildAlphaMask）。輪郭
 * 抽出と同じマスクを共有することで、3000px 級でも α 判定の全画素走査を 1 回に
 * まとめられ、内側ループは連続メモリの 1 バイト読み＋加算だけに保てる。行オフセットは
 * 外側で更新する。
 *
 * 全透明（N=0）は本来 imageLoader が読み込み段階で弾くが、単体でも安全に扱える
 * よう null を返し、呼び出し側が例外なくエラー表示へマッピングできるようにする。
 */
export function computeCentroidFromMask(
  mask: Uint8Array,
  width: number,
  height: number,
): CentroidPixel | null {
  let sumX = 0;
  let sumY = 0;
  let count = 0;

  for (let y = 0; y < height; y++) {
    // 行頭のマスクオフセット。内側ループでは列分だけ加算する。
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      // マスクは α>0 を 1 に畳んだ 1 バイト値。noUncheckedIndexedAccess 下では
      // number | undefined になるため ?? 0 で丸めてから判定する。
      if ((mask[rowOffset + x] ?? 0) === 1) {
        sumX += x;
        sumY += y;
        count++;
      }
    }
  }

  if (count === 0) {
    return null;
  }

  return {
    pixel: { x: sumX / count, y: sumY / count },
    pixelCount: count,
  };
}

/**
 * ピクセル重心へ実寸(mm)座標を付与して完成形の Centroid にする。
 *
 * mm 換算はスケール（mm/px）に依存する軽量な写像で、パラメータ変更のたびに
 * やり直しても支障がない。重いピクセル走査（computeCentroidFromMask）とは分離し、
 * ここではその結果を受けて mm を足すだけに留める。
 */
export function toCentroid(base: CentroidPixel, mmPerPixel: number): Centroid {
  return {
    pixel: base.pixel,
    // 実寸座標は結果表示用。ピクセル座標を単一の換算規則（scale）で変換する。
    mm: pixelPointToMm(base.pixel, mmPerPixel),
    pixelCount: base.pixelCount,
  };
}
