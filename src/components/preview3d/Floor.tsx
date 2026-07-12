// 3D プレビューの床（スタジオ風の設置面）。
//
// 床は「タイル 1 枚のテクスチャ（render/texture3d の buildFloorTexture）を実寸で敷き詰めた
// 1 枚の**不透明**メッシュ」として描く。テクスチャ画像（既定は木目、ユーザー画像へ差し替え可）と
// 実寸グリッドを同じタイルへ焼き込むのは、透明なグリッド面を重ねるとアクリル越しに消えるため
// （three の transmission の制約。render/texture3d の冒頭注記を参照）。

import { useEffect, useMemo } from 'react';

import { useThree } from '@react-three/fiber';

import { buildTiledTexture } from '@/components/preview3d/geometry3d';
import { FLOOR_TILE_MM, buildFloorTexture } from '@/render/texture3d';

/** 床の色（テクスチャなしのとき）。商品写真のスタジオを模した無彩色（SPEC「背景は単色」）。 */
const FLOOR_COLOR = '#dfe4ea';

/**
 * 床の Y(mm)。接地影（ContactShadows）は接地面（Y=0）に置いた上向きカメラで撮るため、
 * 床そのものがそのカメラに写り込む（＝画面全体が影になる）のを避けて、わずかに下へ沈める。
 * 0.2mm は数十〜数百 mm のフィギュアに対して視認できない差。
 */
const FLOOR_Y_MM = -0.2;

/** 床の一辺(mm)。画角を埋めれば十分なので、被写体より十分大きい固定値でよい。 */
const FLOOR_SIZE_MM = 4000;

/** 床の異方性フィルタの上限。これ以上は見た目が変わらないわりにサンプリング費用が増える。 */
const MAX_FLOOR_ANISOTROPY = 8;

export interface FloorProps {
  /** 床へ貼るテクスチャ画像。null なら無地（[[FLOOR_COLOR]]）。 */
  image: ImageBitmap | null;
  /** 実寸グリッドを表示するか。 */
  grid: boolean;
}

export function Floor({ image, grid }: FloorProps) {
  const maxAnisotropy = useThree((state) => state.gl.capabilities.getMaxAnisotropy());
  const anisotropy = Math.min(MAX_FLOOR_ANISOTROPY, maxAnisotropy);

  // タイルの再生成はテクスチャ画像・グリッド切替・デバイス能力が変わったときだけ。
  // R3F は props で渡したテクスチャを破棄しないため、差し替え時の解放は自分で行う。
  const texture = useMemo(
    () =>
      buildTiledTexture(
        buildFloorTexture(image, { background: FLOOR_COLOR, grid }),
        FLOOR_SIZE_MM / FLOOR_TILE_MM,
        anisotropy,
      ),
    [image, grid, anisotropy],
  );
  useEffect(() => () => texture.dispose(), [texture]);

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, FLOOR_Y_MM, 0]}>
      <planeGeometry args={[FLOOR_SIZE_MM, FLOOR_SIZE_MM]} />
      {/* 色は常に白。下地色・グリッド・テクスチャはすべてタイル側に焼き込んである
          （map を外さない理由は render/texture3d の buildFloorTexture を参照）。
          艶消しにして被写体のアクリルを引き立てる。 */}
      <meshStandardMaterial map={texture} color="#ffffff" roughness={0.9} metalness={0} />
    </mesh>
  );
}
