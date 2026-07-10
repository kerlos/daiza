// 画像プレビュー領域。
//
// 役割は 5 つ：(1) 読み込み済み画像を Canvas に等倍で描く、(2) 解析結果があれば
// SVG オーバーレイ（外形・重心・差込口・台座・支持範囲・鉛直線）を画像へ重ねる、
// (3) 転倒シミュレーション（左右の限界姿勢）をトグルで重ね描く、(4) PNG のドラッグ
// ＆ドロップを受け付ける、(5) ホイールズーム・ドラッグパン・Fit・100% の表示操作を
// 提供する（TODO 9）。
//
// 図形の幾何は render/overlay.ts・render/simulation.ts（いずれも純粋ロジック）が
// 画像ピクセル座標で算出し、本コンポーネントは role ごとの見た目（色・線種）を与えて
// SVG 化する。ズーム/パンの座標変換は useViewport が持つ 1 つのアフィン変換に集約し、
// Canvas と SVG を内包する stage 要素へまとめて適用する。これにより画像とオーバーレイ
// は常に一致して拡縮・移動する。オーバーレイの線幅・マーカー半径だけは scale で割って、
// ズームしても画面上で一定サイズに保つ。

import { useEffect, useMemo, useRef, useState } from 'react';

import { ImageOff, Maximize2, Minus, Plus, RotateCw, Scan } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { buildOverlayShapes } from '@/render/overlay';
import { buildSimulationShapes } from '@/render/simulation';
import { useViewport } from '@/hooks/useViewport';
import type { AnalysisResult, FigureImage } from '@/model/types';
import { cn } from '@/lib/utils';
import { radToDeg } from '@/utils/geometry';

export interface PreviewProps {
  /** 読み込み済み画像。未読み込みなら null。 */
  image: FigureImage | null;
  /** 直近の解析結果。あればオーバーレイを描画する。未解析・失敗時は null。 */
  result?: AnalysisResult | null;
  /** ドロップされた PNG ファイルを通知する。未指定ならドロップは受け付けない。 */
  onImageFile?: (file: File) => void;
}

export function Preview({ image, result, onImageFile }: PreviewProps) {
  // ドラッグ中はドロップ可能であることを視覚的に示すためのフラグ。
  const [isDragOver, setIsDragOver] = useState(false);
  // 転倒シミュレーション（左右の限界姿勢）の表示切替。常時重ねると主オーバーレイが
  // 埋もれるため、必要な時だけ見せられるようトグルにする（初期は非表示）。
  const [showSimulation, setShowSimulation] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 読み込みハンドラが無ければ D&D は無効。ハンドラの有無で振る舞いを分ける。
  const dropEnabled = Boolean(onImageFile);

  // 表示操作（ズーム/パン/Fit/100%）。コンテンツ寸法（画像の自然サイズ）を渡す。
  const {
    containerRef,
    transform,
    isPanning,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    fit,
    actualSize,
    zoomIn,
    zoomOut,
  } = useViewport(image?.width ?? null, image?.height ?? null);

  // 画像が変わったときだけ Canvas へ等倍で描き直す。putImageData は等倍描画のため
  // Canvas 要素は自然解像度で持ち、拡縮は stage の transform に委ねる。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) {
      return;
    }
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }
    ctx.putImageData(image.imageData, 0, 0);
  }, [image]);

  // オーバーレイ図形は解析結果が変わったときだけ再構築する（不要な再計算の抑制）。
  const overlay = useMemo(() => (result ? buildOverlayShapes(result) : null), [result]);

  // 転倒姿勢も同様に結果が変わったときだけ再構築する。トグル OFF でも構築コストは
  // 軽い（支点 2 点の算出のみ）ため result を唯一の依存とし、描画側で表示を出し分ける。
  const simulation = useMemo(() => (result ? buildSimulationShapes(result) : null), [result]);

  // 線幅・半径・破線は「画像 px を stage の scale で割った値」で指定することで、
  // 拡縮後の画面上サイズを一定に保つ（stage 側で scale 倍されるため相殺される）。
  const s = transform.scale;

  return (
    <div
      ref={containerRef}
      className={cn(
        'bg-muted/30 relative flex flex-1 touch-none items-center justify-center overflow-hidden rounded-lg border',
        // ドラッグ中は境界を強調してドロップ対象であることを明示する。
        isDragOver && 'border-primary bg-primary/10',
        // パン操作のためのカーソル表現（画像がある時のみ）。
        image && (isPanning ? 'cursor-grabbing' : 'cursor-grab'),
      )}
      onPointerDown={image ? onPointerDown : undefined}
      onPointerMove={image ? onPointerMove : undefined}
      onPointerUp={image ? onPointerUp : undefined}
      onPointerCancel={image ? onPointerUp : undefined}
      onDragOver={
        dropEnabled
          ? (event) => {
              // preventDefault しないとブラウザがファイルを開いてしまい drop が発火しない。
              event.preventDefault();
              setIsDragOver(true);
            }
          : undefined
      }
      onDragLeave={dropEnabled ? () => setIsDragOver(false) : undefined}
      onDrop={
        dropEnabled
          ? (event) => {
              event.preventDefault();
              setIsDragOver(false);
              // 複数ドロップされても先頭のみ扱う（単一画像前提）。
              const file = event.dataTransfer.files?.[0];
              if (file) {
                onImageFile?.(file);
              }
            }
          : undefined
      }
    >
      {image ? (
        <>
          {/* stage：画像の自然サイズを持つ箱。左上原点で transform を適用し、内包する
              Canvas と SVG をまとめて拡縮・移動する。両者は同一の箱を満たすため常に重なる。 */}
          <div
            className="absolute top-0 left-0 origin-top-left"
            style={{
              width: image.width,
              height: image.height,
              transform: `translate(${transform.tx}px, ${transform.ty}px) scale(${s})`,
            }}
          >
            <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
            {overlay && (
              <svg
                className="pointer-events-none absolute inset-0 h-full w-full"
                viewBox={`0 0 ${image.width} ${image.height}`}
              >
                {/* 転倒シミュレーション（限界姿勢）。主オーバーレイに埋もれないよう
                    最背面へ薄く描く。各方向とも支点まわりに外形を転倒角ぶん傾け、
                    重心が支点の真上に載る「倒れる直前」の姿を示す。 */}
                {showSimulation &&
                  simulation &&
                  [simulation.left, simulation.right].map((pose) => (
                    <g
                      key={pose.role}
                      // 符号付き回転量はラジアンで持つため度へ直して rotate に渡す。
                      transform={`rotate(${radToDeg(pose.angleRad)} ${pose.pivot.x} ${pose.pivot.y})`}
                    >
                      <polygon
                        points={overlay.contour.points.map((p) => `${p.x},${p.y}`).join(' ')}
                        fill="rgba(249, 115, 22, 0.08)"
                        stroke="rgba(249, 115, 22, 0.5)"
                        strokeWidth={1 / s}
                        strokeDasharray={`${4 / s} ${3 / s}`}
                      />
                      {/* 重心→支点の線。回転後は鉛直になり、重心が支点の真上へ載る
                          （＝その方向の転倒限界）ことを可視化する。 */}
                      <line
                        x1={overlay.centroid.center.x}
                        y1={overlay.centroid.center.y}
                        x2={pose.pivot.x}
                        y2={pose.pivot.y}
                        stroke="rgba(249, 115, 22, 0.7)"
                        strokeWidth={1 / s}
                      />
                      <circle
                        cx={overlay.centroid.center.x}
                        cy={overlay.centroid.center.y}
                        r={overlay.centroid.radius / s}
                        fill="rgba(249, 115, 22, 0.85)"
                      />
                    </g>
                  ))}

                {/* 外形（半透明）。塗りで領域を、細線で輪郭を示す。 */}
                <polygon
                  points={overlay.contour.points.map((p) => `${p.x},${p.y}`).join(' ')}
                  fill="rgba(148, 163, 184, 0.25)"
                  stroke="rgba(100, 116, 139, 0.8)"
                  strokeWidth={1 / s}
                />

                {/* 台座（緑矩形）。差込口・支持範囲より背面に置くため先に描く。 */}
                <rect
                  x={overlay.base.x}
                  y={overlay.base.y}
                  width={overlay.base.width}
                  height={overlay.base.height}
                  fill="rgba(34, 197, 94, 0.25)"
                  stroke="rgb(22, 163, 74)"
                  strokeWidth={1.5 / s}
                />

                {/* 差込口（青矩形）。 */}
                <rect
                  x={overlay.slot.x}
                  y={overlay.slot.y}
                  width={overlay.slot.width}
                  height={overlay.slot.height}
                  fill="rgba(37, 99, 235, 0.25)"
                  stroke="rgb(37, 99, 235)"
                  strokeWidth={1.5 / s}
                />

                {/* 支持範囲（オレンジ線）。 */}
                <line
                  x1={overlay.support.from.x}
                  y1={overlay.support.from.y}
                  x2={overlay.support.to.x}
                  y2={overlay.support.to.y}
                  stroke="rgb(249, 115, 22)"
                  strokeWidth={3 / s}
                  strokeLinecap="round"
                />

                {/* 重心からの鉛直線（点線）。支持範囲と対比させて転倒余裕を目視する。 */}
                <line
                  x1={overlay.plumb.from.x}
                  y1={overlay.plumb.from.y}
                  x2={overlay.plumb.to.x}
                  y2={overlay.plumb.to.y}
                  stroke="rgba(239, 68, 68, 0.9)"
                  strokeWidth={1.5 / s}
                  strokeDasharray={`${6 / s} ${4 / s}`}
                />

                {/* 重心（赤丸）。最前面へ置いて他図形に埋もれないようにする。 */}
                <circle
                  cx={overlay.centroid.center.x}
                  cy={overlay.centroid.center.y}
                  r={overlay.centroid.radius / s}
                  fill="rgb(239, 68, 68)"
                  stroke="white"
                  strokeWidth={1.5 / s}
                />
              </svg>
            )}
          </div>

          {/* 表示操作コントロール。stage の上（右下）へ重ねる。ボタン操作でパンが
              誤発火しないよう、ここでの pointerdown はコンテナへ伝播させない。 */}
          <div
            className="absolute right-2 bottom-2 flex items-center gap-1 rounded-md border bg-background/80 p-1 shadow-sm backdrop-blur"
            onPointerDown={(event) => event.stopPropagation()}
          >
            {/* 転倒シミュレーション表示切替。解析結果が無い間は対象が無いので無効化。 */}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setShowSimulation((v) => !v)}
              disabled={!simulation}
              className={cn(showSimulation && 'text-primary bg-primary/10')}
              title="転倒シミュレーション"
              aria-label="転倒シミュレーション"
              aria-pressed={showSimulation}
            >
              <RotateCw />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={zoomOut} title="縮小" aria-label="縮小">
              <Minus />
            </Button>
            {/* 現在の拡大率。クリックで 100% 表示に合わせる。 */}
            <Button
              variant="ghost"
              size="sm"
              className="min-w-14 tabular-nums"
              onClick={actualSize}
              title="100%表示"
            >
              {Math.round(s * 100)}%
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={zoomIn} title="拡大" aria-label="拡大">
              <Plus />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={actualSize}
              title="100%表示"
              aria-label="100%表示"
            >
              <Scan />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={fit}
              title="全体表示（Fit）"
              aria-label="全体表示"
            >
              <Maximize2 />
            </Button>
          </div>
        </>
      ) : (
        <div className="text-muted-foreground flex flex-col items-center gap-2 text-center">
          <ImageOff className="size-10 opacity-50" />
          <p className="text-sm">
            {isDragOver
              ? 'ここにドロップ'
              : 'PNG画像をドラッグ＆ドロップ、または読み込んでください'}
          </p>
        </div>
      )}
    </div>
  );
}
