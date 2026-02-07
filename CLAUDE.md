# KENBAN-viewer (検版ビューアー)

## プロジェクト概要
2つの画像ファイル（TIFF/PSD/PDF）を比較して差分を検出する検版支援デスクトップアプリ。
Tauri 2 + React + TypeScript + Rust で構成。

## 技術スタック
- **フロントエンド**: React + TypeScript + Tailwind CSS (Vite)
- **バックエンド**: Rust (Tauri 2)
- **画像処理**: `image` crate v0.25 (tiff/png/jpeg), `psd` crate v0.3, `rayon` v1.10
- **PDF**: pdfjs-dist (JS側), pdf-lib, jsPDF

## ディレクトリ構成
- `src/App.tsx` - メインUIコンポーネント（5000行超の単一ファイル）
- `src/components/` - GDriveFolderBrowser, ScreenshotEditor
- `src-tauri/src/lib.rs` - Rustバックエンド（Tauriコマンド）
- `src-tauri/Cargo.toml` - Rust依存関係
- `src/globals.css` - グローバルスタイル

## ビルド・開発
```bash
npm install
npm run tauri dev      # 開発サーバー起動
npm run tauri build    # リリースビルド
cargo check            # Rustのみコンパイルチェック（src-tauri/内で実行）
```

## バージョン管理
バージョンは以下の2箇所を同時に更新する:
- `package.json` の `version`
- `src-tauri/tauri.conf.json` の `version`

## 比較モード
- **tiff-tiff**: TIFF同士の比較（シンプル差分）
- **psd-psd**: PSD同士の比較（シンプル差分）
- **pdf-pdf**: PDF同士の比較（ページ単位、JS側で差分計算）
- **psd-tiff (混合)**: PSD→TIFF出力の検証（ヒートマップ差分、JSON cropBounds必要）

## Rustコマンド (invoke)
- `parse_psd` - PSDファイルのデコード
- `decode_and_resize_image` - 画像デコード＋リサイズ（並列ビュー用）
- `preload_images` - 画像プリロード
- `open_pdf_in_mojiq` - MojiQアプリでPDFを開く
- `open_file_with_default_app` - デフォルトアプリで開く
- `list_files_in_folder` - フォルダ内ファイル一覧
- `save_screenshot` - スクリーンショット保存

## Cargo.toml最適化
- `[profile.dev] opt-level = 2` - dev buildでも画像処理を最適化
- `[profile.dev.package.image]` / `[profile.dev.package.psd]` に `opt-level = 3`
- release: `opt-level = 3`, `lto = "thin"`, `codegen-units = 1`

## UI設計
- カラートーン: ダークテーマ (neutral系)、アクセントはモード別に色分け
- ドロップゾーン: border-dashed スタイル、大きめのクリック/ドロップ領域
- ガイド色: シアン (#00e5ff / #00bcd4)
- マーカー: シアン円 + 番号バッジ

## 自動更新
- tauri-plugin-updater 使用
- GitHub Releases から latest.json を参照
- productName は ASCII (`KENBAN-viewer`) でないと latest.json 生成が壊れる

## 注意事項
- App.tsx が巨大（5000行超）なので編集時は行番号を確認すること
- `processingRef` → `processingCountRef` 等のリファクタリング時は参照箇所を全検索
- ファイルの `filePath` プロパティ (FileWithPath) はTauri経由のドロップ時のみ設定される
