// polygon-clipping の型補正（モジュール拡張）。
//
// polygon-clipping は同梱 d.ts が「名前付きエクスポート（union 等）」を宣言する一方、
// 実体（ESM ビルド）は default エクスポート 1 つ（{ union, intersection, xor, difference }）
// しか持たない。verbatimModuleSyntax 下では TS の interop 合成が効かないため、名前付き
// import は実行時に undefined となり、default import は同梱 d.ts に default が無く型エラーになる。
//
// そこで同名モジュールへ default エクスポートを宣言マージで補い、`import pc from 'polygon-clipping'`
// を型・実行時とも成立させる。Polygon / MultiPolygon は同梱 d.ts の公開型を参照する。
declare module 'polygon-clipping' {
  const polygonClipping: {
    union(geom: Polygon | MultiPolygon, ...geoms: (Polygon | MultiPolygon)[]): MultiPolygon;
    intersection(geom: Polygon | MultiPolygon, ...geoms: (Polygon | MultiPolygon)[]): MultiPolygon;
    xor(geom: Polygon | MultiPolygon, ...geoms: (Polygon | MultiPolygon)[]): MultiPolygon;
    difference(
      subjectGeom: Polygon | MultiPolygon,
      ...clipGeoms: (Polygon | MultiPolygon)[]
    ): MultiPolygon;
  };
  export default polygonClipping;
}
