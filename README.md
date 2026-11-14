# ふたりの家計簿（移行版・プレビュー）

ChatGPT Sites で作った家計簿アプリ「ふたりの家計簿」の移行版です。
外部ライブラリ・CDNに依存しない、素の HTML / CSS / JavaScript の静的Webアプリで、
GitHub Pages にそのまま置いて配信できます。

> ⚠️ 現在はプレビュー段階です。構築期間中の入力先は現行アプリのみとし、
> 切り替え直前に現行アプリから最新のJSONバックアップを書き出して取り込みます。

## ファイル構成

| ファイル | 内容 |
|---|---|
| `index.html` | 画面の骨格（パスワードゲート・5タブ・モーダル・トースト） |
| `styles.css` | モバイルファーストのスタイル |
| `app.js` | アプリ本体（データ層・認証・各タブの描画・入出力） |
| `test/import-test.js` | インポーターの検証テスト（Node.js） |

## ローカルでの確認方法

```bash
cd app
python3 -m http.server 8000
# ブラウザで http://localhost:8000/ を開く
```

## データと保存先

- データ形式は移行元バックアップJSON（`format: "futari-kakeibo"`, version 1）と互換です。
- 現在の保存先はブラウザの localStorage（端末ごと）です。
  設定タブの「すべてのデータを保存（JSON）」で書き出し、「バックアップ（JSON）から復元」で取り込めます。
- 家族パスワードは SHA-256 ハッシュでデータ側に保存され、端末のログイン保持は約30日です。
  （書き出しJSONにはパスワード情報を含めません）

## Firebase（ふたりでの同期）への移行ポイント

`app.js` の冒頭にある `const FIREBASE_CONFIG = null;` に設定を入れ、
データアダプター（`storageAdapter` の `load` / `save`）を Firestore 実装に差し替えると、
ふたりのスマホで同じデータを共有できる構成に移行できます。
同期状態表示は `renderSyncStatus()` とヘッダーの `#sync-status` 要素が差し替えポイントです。

## 検証

```bash
node --check app.js        # 構文チェック
node test/import-test.js   # バックアップJSONの取り込み検証（25か月・331件・33カテゴリー）
```
