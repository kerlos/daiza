// 絵柄画像のラスタライズ（DOM 依存のアダプタ層）。
//
// エクスポートに絵柄を埋め込むには元 PNG の画素が要るが、解析用の ImageData は
// Worker へ transfer 済みで手元に残らない（model/pixelStore）。長期保持されているのは
// プレビュー描画用の ImageBitmap だけなので、これを canvas へ描き直して PNG を作る。
//
// canvas は DOM API のため、純粋に保ちたい export/svg・export/ai からは切り離し、
// 「ImageBitmap → PNG バイト列 / data URL」の変換だけをこのモジュールへ隔離する。
// これにより各生成器は「すでに PNG になったもの」を受け取るだけで済む。

/** ImageBitmap を原寸の 2D canvas へ描き直す。α はそのまま保たれる。 */
function drawToCanvas(bitmap: ImageBitmap): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('canvas の 2D コンテキストを取得できませんでした。');
  }
  ctx.drawImage(bitmap, 0, 0);

  return canvas;
}

/** canvas を PNG の Blob へ。toBlob はコールバック API なので Promise へ包む。 */
function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('画像の PNG 変換に失敗しました。'));
      }
    }, 'image/png');
  });
}

/** 絵柄を PNG（α 保持）のバイト列にする。.ai（PDF）への埋め込み用。 */
export async function bitmapToPngBytes(bitmap: ImageBitmap): Promise<Uint8Array> {
  const blob = await canvasToPngBlob(drawToCanvas(bitmap));
  return new Uint8Array(await blob.arrayBuffer());
}

/** 絵柄を PNG の data URL にする。SVG の <image href> 用。 */
export function bitmapToPngDataUrl(bitmap: ImageBitmap): string {
  // SVG は文字列なので data URL が要る。canvas から直接 base64 化できる toDataURL を使う。
  return drawToCanvas(bitmap).toDataURL('image/png');
}
