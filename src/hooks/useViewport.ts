// プレビューのビュー操作（ホイールズーム・ドラッグパン・Fit・100%）を司る hook。
//
// ここで扱うのは「画像をどう見せるか」という純粋な表示状態だけで、解析結果や
// アプリ状態（model/state）とは独立している。オーバーレイの幾何は画像ピクセル
// 座標のまま（render/overlay）で、本 hook が与える平行移動 + 拡大の 1 つの
// アフィン変換を stage 要素へ適用することで、画像とオーバーレイをまとめて拡縮・
// 移動させる。座標系を 1 か所（この変換）に集約することで、解析ロジックは表示
// 操作の影響を一切受けない。
//
// 変換は screen = scale * content + (tx, ty) の相似変換。transformOrigin を左上
// (0,0) に固定し、CSS の `translate(tx,ty) scale(scale)` として stage に渡す。

import { useCallback, useEffect, useRef, useState } from 'react';

import { clamp } from '@/utils/geometry';

/** 拡大率の下限・上限。極端な値で操作不能になるのを防ぐ安全域。 */
const MIN_SCALE = 0.02;
const MAX_SCALE = 64;

/**
 * ホイール 1 ノッチあたりの拡大係数の基数。deltaY に対して指数を取ることで、
 * 拡大・縮小の見た目の速さを対称にする（×k と ÷k が同じ操作量になる）。
 */
const WHEEL_ZOOM_BASE = 1.0015;

/** ズームボタン 1 クリックあたりの倍率。 */
const BUTTON_ZOOM_FACTOR = 1.25;

/** stage に適用する相似変換。scale は拡大率、(tx, ty) は画面座標での平行移動。 */
export interface ViewportTransform {
  readonly scale: number;
  readonly tx: number;
  readonly ty: number;
}

interface Size {
  readonly width: number;
  readonly height: number;
}

const IDENTITY: ViewportTransform = { scale: 1, tx: 0, ty: 0 };

export interface UseViewportResult {
  /** 表示領域（overflow-hidden なビューポート）の ref。サイズ計測とイベント基準に使う。 */
  readonly containerRef: React.RefObject<HTMLDivElement | null>;
  /** 現在の変換。stage の CSS transform に反映する。 */
  readonly transform: ViewportTransform;
  /** ドラッグパン中フラグ。カーソル表示の切り替えに使う。 */
  readonly isPanning: boolean;
  readonly onPointerDown: (event: React.PointerEvent) => void;
  readonly onPointerMove: (event: React.PointerEvent) => void;
  readonly onPointerUp: (event: React.PointerEvent) => void;
  /** コンテンツ全体が収まるよう中央寄せでフィットさせる。 */
  readonly fit: () => void;
  /** 等倍（1 コンテンツ px = 1 画面 px）で中央寄せ表示する。 */
  readonly actualSize: () => void;
  /** ビューポート中心を基準に拡大／縮小する（ズームボタン用）。 */
  readonly zoomIn: () => void;
  readonly zoomOut: () => void;
}

/** コンテンツをビューポートへ収める変換（縦横比維持・中央寄せ）。 */
function computeFit(container: Size, content: Size): ViewportTransform {
  const scale = clamp(
    Math.min(container.width / content.width, container.height / content.height),
    MIN_SCALE,
    MAX_SCALE,
  );
  return {
    scale,
    tx: (container.width - content.width * scale) / 2,
    ty: (container.height - content.height * scale) / 2,
  };
}

/** 等倍（scale=1）でコンテンツを中央寄せする変換。 */
function computeActual(container: Size, content: Size): ViewportTransform {
  return {
    scale: 1,
    tx: (container.width - content.width) / 2,
    ty: (container.height - content.height) / 2,
  };
}

/**
 * ビューポート内の固定点 (px, py) を保ったまま拡大率を nextScale へ変える。
 * ホイールズームでカーソル直下の画像点が動かないようにするための基本演算。
 */
function zoomAround(
  prev: ViewportTransform,
  px: number,
  py: number,
  nextScale: number,
): ViewportTransform {
  const clamped = clamp(nextScale, MIN_SCALE, MAX_SCALE);
  const ratio = clamped / prev.scale;
  return {
    scale: clamped,
    tx: px - (px - prev.tx) * ratio,
    ty: py - (py - prev.ty) * ratio,
  };
}

/**
 * プレビューのズーム/パン状態を管理する。
 *
 * コンテンツ寸法（画像の自然サイズ）が変わったら自動でフィットさせる。ホイール
 * イベントはブラウザのページスクロールを抑止するため、React の passive な
 * onWheel ではなくネイティブの非 passive リスナとして購読する。
 */
export function useViewport(
  contentWidth: number | null,
  contentHeight: number | null,
): UseViewportResult {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [transform, setTransform] = useState<ViewportTransform>(IDENTITY);
  const [isPanning, setIsPanning] = useState(false);

  // イベントハンドラ（安定参照）から最新値を参照するための ref 群。これらを ref に
  // 逃がすことで、リスナを張り直さずに済ませる。ref の更新は「描画中の書き込み」を
  // 避けるため effect 内で行う。
  const transformRef = useRef(transform);
  useEffect(() => {
    transformRef.current = transform;
  }, [transform]);
  const containerSizeRef = useRef<Size | null>(null);
  const contentRef = useRef<Size | null>(null);

  // コンテンツ寸法ごとに一度だけ自動フィットしたかを記録する。ウィンドウ
  // リサイズのたびに再フィットしてユーザーのズームを破棄しないための番人。
  const fittedRef = useRef(false);

  const applyFit = useCallback(() => {
    const container = containerSizeRef.current;
    const content = contentRef.current;
    if (!container || !content) {
      return;
    }
    setTransform(computeFit(container, content));
  }, []);

  const applyActual = useCallback(() => {
    const container = containerSizeRef.current;
    const content = contentRef.current;
    if (!container || !content) {
      return;
    }
    setTransform(computeActual(container, content));
  }, []);

  const zoomAtCenter = useCallback((factor: number) => {
    const container = containerSizeRef.current;
    if (!container || !contentRef.current) {
      return;
    }
    setTransform((prev) =>
      zoomAround(prev, container.width / 2, container.height / 2, prev.scale * factor),
    );
  }, []);

  const zoomIn = useCallback(() => zoomAtCenter(BUTTON_ZOOM_FACTOR), [zoomAtCenter]);
  const zoomOut = useCallback(() => zoomAtCenter(1 / BUTTON_ZOOM_FACTOR), [zoomAtCenter]);

  // コンテンツ寸法が変わったら、最新寸法を ref へ反映し、次の計測時に自動フィット
  // させるため印をリセットする。すでにサイズが分かっていれば即フィットする。
  useEffect(() => {
    contentRef.current =
      contentWidth != null && contentHeight != null
        ? { width: contentWidth, height: contentHeight }
        : null;
    fittedRef.current = false;
    if (containerSizeRef.current && contentRef.current) {
      applyFit();
      fittedRef.current = true;
    }
  }, [contentWidth, contentHeight, applyFit]);

  // ビューポートのサイズを追跡し、初回計測時に（まだなら）自動フィットする。
  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) {
        return;
      }
      containerSizeRef.current = { width: rect.width, height: rect.height };
      if (!fittedRef.current && contentRef.current) {
        applyFit();
        fittedRef.current = true;
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [applyFit]);

  // ホイールズーム：カーソル直下の点を固定して拡縮する。ページスクロールを
  // 止める必要があるため非 passive のネイティブリスナで購読する。
  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }
    const handleWheel = (event: WheelEvent) => {
      if (!contentRef.current) {
        return;
      }
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const cursorX = event.clientX - rect.left;
      const cursorY = event.clientY - rect.top;
      const factor = Math.pow(WHEEL_ZOOM_BASE, -event.deltaY);
      setTransform((prev) => zoomAround(prev, cursorX, cursorY, prev.scale * factor));
    };
    element.addEventListener('wheel', handleWheel, { passive: false });
    return () => element.removeEventListener('wheel', handleWheel);
  }, []);

  // ドラッグパン：pointerdown 時点の変換と開始座標を控え、移動量を加算する。
  const panRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startTx: number;
    startTy: number;
  } | null>(null);

  const onPointerDown = useCallback((event: React.PointerEvent) => {
    // 主ボタン（左クリック／単一タッチ）のみパン開始。コンテンツ未読み込み時は無効。
    if (event.button !== 0 || !contentRef.current) {
      return;
    }
    const element = containerRef.current;
    if (!element) {
      return;
    }
    // ポインタキャプチャで、ビューポート外へドラッグしても move/up を取りこぼさない。
    element.setPointerCapture(event.pointerId);
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startTx: transformRef.current.tx,
      startTy: transformRef.current.ty,
    };
    setIsPanning(true);
  }, []);

  const onPointerMove = useCallback((event: React.PointerEvent) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) {
      return;
    }
    const dx = event.clientX - pan.startX;
    const dy = event.clientY - pan.startY;
    // パン中は scale を変えず平行移動のみ更新する。
    setTransform((prev) => ({ ...prev, tx: pan.startTx + dx, ty: pan.startTy + dy }));
  }, []);

  const onPointerUp = useCallback((event: React.PointerEvent) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) {
      return;
    }
    containerRef.current?.releasePointerCapture(event.pointerId);
    panRef.current = null;
    setIsPanning(false);
  }, []);

  return {
    containerRef,
    transform,
    isPanning,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    fit: applyFit,
    actualSize: applyActual,
    zoomIn,
    zoomOut,
  };
}
