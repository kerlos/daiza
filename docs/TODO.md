# TODO（Daiza 実装タスク）

`docs/SPEC.md` の実装手順・仕様に基づくタスク一覧。上から順に進める想定。

## 1. 環境構築

- [x] Vite + React + TypeScript プロジェクトを初期化
- [x] TypeScript strict mode を有効化
- [x] ESLint + Prettier を設定（warningゼロ運用）
- [x] Tailwind CSS を導入
- [x] shadcn/ui を導入（`components.json`・`cn`ユーティリティ・テーマトークンを整備。個別コンポーネントは必要時に追加）
- [x] Vite の `base` を `/daiza/` に設定（GitHub Pages 用）
- [x] GitHub Pages へのデプロイ手順／ワークフローを整備（`.github/workflows/deploy.yml`）
- [x] `src/` のディレクトリ構成を作成（components / analysis / render / export / model / hooks / utils）

## 2. 型・状態基盤

- [x] `model/types.ts` に画像・解析結果・パラメータの型を定義
- [x] `model/state.ts` にアプリ状態の初期値・型を定義
- [x] React Hooks による状態管理を実装（Redux 等は使わない）

## 3. UIレイアウト

- [x] 左右2ペイン構成の `App.tsx` を作成
- [x] `components/LeftPanel.tsx`：各種入力コントロールを配置
- [x] `components/Preview.tsx`：画像プレビュー領域
- [x] `components/ResultPanel.tsx`：解析結果一覧
- [x] レスポンシブ対応（画面幅が狭い場合は上下配置へ切替）

## 4. PNG読み込み

- [x] `analysis/imageLoader.ts`：PNG読み込みと `ImageData` 取得
- [x] ドラッグ＆ドロップ対応
- [x] ファイル選択対応
- [x] RGBA判定（α=0を透明、α>0をアクリルとみなす）
- [x] 画像はブラウザ内のみで処理（外部送信しない）

## 5. パラメータ入力

- [x] フィギュア高さ(mm) 入力
- [x] 板厚(mm) 入力（例: 2/3/5mm）＝標準値プリセット＋カスタム入力（Select）
- [x] 差込口幅(mm) 入力（例: 5/6/7）＝標準値プリセット＋カスタム入力（Select）
- [x] 安全率スライダー（1.0〜2.0、初期値1.3）
- [x] 台座余白（左右余白 0〜30mm）

## 6. スケール計算

- [x] フィギュア高さ(mm)と画像高さ(px)から `mm_per_pixel` を算出

## 7. 重心計算

- [x] `analysis/centroid.ts`：α>0を均一密度とみなし画像モーメントで重心 `Cx=Σx/N`, `Cy=Σy/N`
- [x] `analysis/contour.ts`：外形（輪郭）抽出

## 8. プレビュー・オーバーレイ描画

- [x] `render/overlay.ts`：オーバーレイ描画ロジック
- [x] 外形（半透明）
- [x] 重心（赤丸）
- [x] 差込口（青矩形）
- [x] 台座（緑矩形）
- [x] 支持範囲（オレンジ線）
- [x] 重心からの鉛直線（点線）
- [x] すべてリアルタイム更新

## 9. 表示操作

- [x] ホイールズーム
- [x] ドラッグパン
- [x] Fit表示
- [x] 100%表示

## 10. 差込口探索

- [x] `analysis/slot.ts`：画像最下部から探索し、差込口幅が完全に収まる範囲のみ候補化
- [x] 複数候補時は重心真下に最も近い位置を採用

## 11. 台座サイズ計算

- [x] `analysis/base.ts`：支持多角形の考え方で台座幅を算出
- [x] 「重心が支持範囲内」を最低条件とする
- [x] 安全率を掛けて推奨台座幅を計算
- [x] 推奨奥行を算出

## 12. 転倒シミュレーション

- [x] `analysis/stability.ts`／`render/simulation.ts`：転倒角 `θ = atan(支持端距離 / 重心高さ)`
- [x] 左右それぞれの転倒角を計算・表示

## 13. 解析パイプライン統合

- [x] `hooks/useAnalysis.ts`：解析→状態更新→再描画のパイプラインを束ねる
- [x] `utils/geometry.ts` / `utils/image.ts` の共通処理を実装

## 14. 結果表示

- [x] 画像サイズ／実寸／重心座標(mm)
- [x] 差込口中心／差込口幅
- [x] 推奨台座幅／推奨奥行
- [x] 転倒角(左)／転倒角(右)／安全率

## 15. SVGエクスポート

- [x] `export/svg.ts`：外形・差込口・台座を含むSVGを実寸(mm)座標系で生成
- [x] ブラウザからのダウンロードを実装

## 16. エラーハンドリング

- [x] PNG読み込み失敗
- [x] 非対応画像
- [x] 透明画像
- [x] 差込口が配置不可
- [x] 台座計算不可
- [x] 例外によるクラッシュを防止（UI上へ分かりやすく表示）

## 17. パフォーマンス最適化

- [x] `useMemo` / `useCallback` による不要な再計算の抑制
- [x] オーバーレイのみの再描画（画像解析全体を再実行しない）
- [x] 3000px程度の画像でも快適に動作することを確認

## 18. リファクタリング・品質

- [x] UI・画像処理・物理計算・描画の分離を再確認（`analysis`/`render`/`export`/`model`/`utils` に React 依存なし。未配線だった `render/simulation.ts` を `Preview` の転倒シミュレーション表示へ配線しデッドコードを解消）
- [x] `any` 型の排除（`src/` に `any` ゼロ）
- [x] ESLint warningゼロ／Prettier準拠を確認（`npm run lint`／`format:check`／`tsc -b`／`build` すべて通過）
- [x] 「なぜその処理が必要か」を中心としたコメント整備

## 将来拡張（バックログ）

- [ ] 複数差込口
- [ ] 円形台座
- [ ] 楕円台座
- [ ] 任意形状台座
- [ ] 金属スタンド対応
- [ ] アクリル以外の素材
- [ ] 密度マップ
- [ ] パーツ分割
- [ ] 複数PNG同時計算
- [ ] PWA化 / WebAssembly置き換え
