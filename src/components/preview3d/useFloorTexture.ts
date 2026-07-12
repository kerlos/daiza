// 床テクスチャの選択状態（テクスチャなし / 木目サンプル / ユーザーがアップロードした画像）。
//
// 3D プレビュー内だけで完結する表示状態であり、解析・パラメータには一切影響しない。
// 画像のデコードは createImageBitmap（ローカル完結）で行い、**外部へは一切送信しない**
// （完全クライアントサイドの制約は 3D でも同じ。SPEC）。
//
// **既定はテクスチャなし（無地の床）**。木目サンプルはバンドル済みアセット
// （src/assets/textures/wood.png）で、ユーザーが選んだときに初めて取得する。参照しているのは
// 3D チャンクだけなので、2D 利用時はもちろん、3D でも木目を選ぶまでダウンロードされない。

import { useCallback, useRef, useState } from 'react';

import woodTextureUrl from '@/assets/textures/wood.png';

/** 床テクスチャの出所。 */
export type FloorTextureSource = 'wood' | 'custom' | 'none';

export interface FloorTexture {
  readonly source: FloorTextureSource;
  /** アップロード画像のファイル名（表示用）。木目・なしのときは null。 */
  readonly name: string | null;
  /** 床へ貼るデコード済み画像。読み込み中・テクスチャなしでは null。 */
  readonly image: ImageBitmap | null;
  /** 読み込み失敗のメッセージ。失敗しても直前の床はそのまま残す。 */
  readonly error: string | null;
  readonly loading: boolean;
  /** 同梱の木目サンプルを床に貼る。 */
  readonly selectWood: () => void;
  /** ユーザーが選んだ画像ファイルを床に貼る。 */
  readonly selectFile: (file: File) => void;
  /** テクスチャを外して無地の床にする（既定）。 */
  readonly clear: () => void;
}

const WOOD_ERROR = '木目のサンプルテクスチャを読み込めませんでした。';
const FILE_ERROR = '画像を読み込めませんでした。PNG・JPEG などの画像ファイルを選んでください。';

interface FloorTextureState {
  source: FloorTextureSource;
  name: string | null;
  image: ImageBitmap | null;
  error: string | null;
  loading: boolean;
}

export function useFloorTexture(): FloorTexture {
  // 既定は無地の床（テクスチャなし）。取得すべきものが無いので loading も立てない。
  const [state, setState] = useState<FloorTextureState>({
    source: 'none',
    name: null,
    image: null,
    error: null,
    loading: false,
  });

  // 読み込みの世代。非同期のデコードが追い越された（＝別のテクスチャが選ばれた）場合に、
  // 遅れて届いた結果を捨てるための鍵。
  const requestRef = useRef(0);
  // 現在表示中の ImageBitmap。差し替え時に前の 1 枚を閉じるためだけに持つ。
  const imageRef = useRef<ImageBitmap | null>(null);

  /**
   * 読み込み結果を反映する。前の ImageBitmap は数 MB を掴んだままなので明示的に閉じる。
   *
   * 閉じるのは**差し替えた瞬間だけ**に限り、effect のクリーンアップやアンマウントでは閉じない。
   * StrictMode の二重マウントではクリーンアップが「まだ使っている画像」に対して走るため、
   * そこで閉じると次のタイル再生成（グリッド切替）で drawImage が失敗する。アンマウント時の
   * 1 枚は GC に委ねる。
   */
  const apply = useCallback(
    (token: number, source: FloorTextureSource, name: string | null, image: ImageBitmap | null) => {
      if (token !== requestRef.current) {
        // 追い越された結果。表示には使わないので、そのまま解放する。
        image?.close();
        return;
      }
      const previous = imageRef.current;
      imageRef.current = image;
      previous?.close();
      setState({ source, name, image, error: null, loading: false });
    },
    [],
  );

  /** 失敗を反映する。床は直前の状態のまま残し、メッセージだけを添える。 */
  const fail = useCallback((token: number, error: string) => {
    if (token !== requestRef.current) {
      return;
    }
    setState((previous) => ({ ...previous, error, loading: false }));
  }, []);

  /** 世代を進める（＝進行中の読み込みを無効化する）。state には触れない。 */
  const nextToken = useCallback((): number => {
    const token = requestRef.current + 1;
    requestRef.current = token;
    return token;
  }, []);

  /** 次の読み込みを開始する（世代を進め、読み込み中にする）。 */
  const begin = useCallback((): number => {
    const token = nextToken();
    setState((previous) => ({ ...previous, error: null, loading: true }));
    return token;
  }, [nextToken]);

  /** 同梱の木目サンプルを取得して貼る。 */
  const selectWood = useCallback(() => {
    const token = begin();
    void (async () => {
      try {
        // 同一オリジンのバンドル済みアセットを取りに行くだけ（外部通信ではない）。
        const response = await fetch(woodTextureUrl);
        if (!response.ok) {
          throw new Error(`status ${response.status}`);
        }
        apply(token, 'wood', null, await createImageBitmap(await response.blob()));
      } catch {
        fail(token, WOOD_ERROR);
      }
    })();
  }, [apply, begin, fail]);

  const selectFile = useCallback(
    (file: File) => {
      const token = begin();
      void (async () => {
        try {
          const bitmap = await createImageBitmap(file);
          if (bitmap.width === 0 || bitmap.height === 0) {
            bitmap.close();
            throw new Error('empty image');
          }
          apply(token, 'custom', file.name, bitmap);
        } catch {
          fail(token, FILE_ERROR);
        }
      })();
    },
    [apply, begin, fail],
  );

  const clear = useCallback(() => {
    // 世代を進めてから反映する（読み込み中の画像があれば、それを捨てる）。
    apply(nextToken(), 'none', null, null);
  }, [apply, nextToken]);

  return { ...state, selectWood, selectFile, clear };
}
