# TEAM POST STUDIO

チームのInstagram投稿を「投稿リスト → 編集 → プレビュー → 投稿」まで行うWebアプリです。

## 公開URL

- https://club-attendance-system-phi.vercel.app/instacraft （CRAQUES HUB 管理画面の「instaCRAFT」アイコンから開く）
- 本体は GitHub Pages（https://holamigos27.github.io/instacraft/ ・リポジトリ holamigos27/instacraft）に置き、
  出欠システムの `next.config.mjs` の rewrite で同じドメインの `/instacraft` に表示しています。
- 更新は、このフォルダで変更を commit して `git push` するだけです（1〜2分で反映）。出欠システムの再デプロイは不要です。

## 起動（ローカル）

`start.bat` をダブルクリック（または `python server.py`）→ ブラウザで http://localhost:8765/ が開きます。
PhotoCraft / VectorCraft は WebAssembly アプリのため、`index.html` を直接開くのではなく必ずこのローカルサーバー経由で使ってください。

## 構成

| パス | 内容 |
|---|---|
| `index.html` | アプリ本体（投稿リスト・クイック編集・スライド管理・プレビュー・投稿） |
| `editors/photocraft/` | [PhotoCraft](https://github.com/storytold/photocraft) web v0.15.1（MIT / Apache-2.0）。日本語UI用に BIZ UDPGothic（OFL）を埋め込んだ独自ビルド。変更点は `TEAMPOST-PATCH.diff` |
| `editors/vectorcraft/` | [VectorCraft](https://github.com/storytold/vectorcraft) web v0.16.0（MIT / Apache-2.0） |
| `server.py` / `start.bat` | ローカルサーバー |

投稿データはブラウザの IndexedDB、連携設定は localStorage に保存されます（このPCのこのブラウザ内のみ）。

## エディタ連携

- **PhotoCraft**：「スライドNを開く」で表示中のスライドを読み込み。編集後 `ファイル › 書き出し › PNG としてクイック書き出し` で自動的に取り込まれ、置換／新規スライド追加を選べます。表示言語は初回に日本語へ設定されます（PhotoCraftの環境設定で変更可）。

### PhotoCraft 日本語版の再ビルド

公式Web版は日本語訳を持っていますが、UI用の日本語フォントを含まないため文字が表示されません。
本プロジェクトの版は公式ソース v0.15.1 に `TEAMPOST-PATCH.diff`（Web版でも craft-fonts を埋め込めるようにする変更）を当て、BIZ UDPGothic を埋め込んで Docker でビルドしたものです。

```
git clone --branch v0.15.1 https://github.com/storytold/photocraft.git
cd photocraft && git apply <このフォルダ>/editors/photocraft/TEAMPOST-PATCH.diff
# jpfonts/fonts/manifest.txt と BIZUDPGothic-Regular.ttf（storytold/craft-fonts）を配置
docker build --target export --output type=local,dest=out .
```
- **VectorCraft**：「スライドNを開く」で読み込み、「書き出してスライドに反映」で取り込み（`window.vectorcraft` API を使用）。

## Instagram への投稿

画面右上「連携設定」で以下を入力します（手順ガイドは設定画面内にあります）。

- Instagram Graph API：IGユーザーID、長期アクセストークン（`instagram_content_publish` 権限）
- Cloudinary：Cloud name と Unsigned upload preset（Instagram が画像を取得するための公開URLに使用）

フィードは 4:5〜1.91:1・最大10枚のカルーセル（スライドの並び順で投稿）、9:16 はストーリーズとして投稿できます。
未設定でも「全画像を保存（番号付きZIP）＋本文コピー」で手動投稿できます。
