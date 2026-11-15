# ふたりの家計簿（移行版）

ChatGPT Sites で作った家計簿アプリ「ふたりの家計簿」の移行版です。
素の HTML / CSS / JavaScript の静的Webアプリで、GitHub Pages にそのまま置いて配信できます。
認証とデータ同期には Firebase（Authentication / Firestore）を使い、SDK は CDN から読み込みます。

> ⚠️ 切り替え直前には、現行アプリから最新のJSONバックアップを書き出して取り込んでください。
> 取り込みは、ログインした状態で行うとそのまま同期先（Firestore）に保存されます。

## ファイル構成

| ファイル | 内容 |
|---|---|
| `index.html` | 画面の骨格（パスワードゲート・5タブ・モーダル・トースト） |
| `styles.css` | モバイルファーストのスタイル |
| `app.js` | アプリ本体（データ層・Firebase認証/同期・各タブの描画・入出力） |
| `test/import-test.js` | インポーターの検証テスト（Node.js） |
| `test/firebase-test.js` | Firebase接続まわりの単体検証（Node.js、SDKはフェイクで代用） |

## ローカルでの確認方法

```bash
cd app
python3 -m http.server 8000
# ブラウザで http://localhost:8000/ を開く
```

## データと保存先

- データ形式は移行元バックアップJSON（`format: "futari-kakeibo"`, version 1）と互換です。
- 保存先は Firestore の単一ドキュメント `households/family`（全状態をまとめて保存）で、
  ふたりのスマホで同じデータを共有・同期します。変更はデバウンス（800ms）して送信し、
  相手端末の変更は購読（onSnapshot）で自動反映されます。
- localStorage はオフライン用のキャッシュ/ミラーとして併用します。
  Firebase SDK の読み込みに失敗した環境では、ゲート画面から「オフラインで閲覧する」で
  キャッシュの閲覧のみ可能です（編集しても同期されません）。
- 設定タブの「すべてのデータを保存（JSON）」で書き出し、「バックアップ（JSON）から復元」で取り込めます。

## 認証（家族パスワード）

- 家族パスワードは Firebase Authentication のメール/パスワード認証で照合します。
  内部的には固定メール `kakeibo.family@kakeibo-e246c.firebaseapp.com` と
  入力されたパスワードの組み合わせです（`app.js` の `FAMILY_EMAIL`）。
- パスワードは6文字以上が必要です。パスワード自体はデータ側に保存しません
  （書き出しJSONにも含めません。取り込みJSONに含まれていても無視します）。
- ログイン状態は Firebase Auth のローカル永続化で保持されます。
  設定タブの「この端末からログアウト」は Auth のサインアウトに接続しています。
- 前提：Firebaseコンソールで「Authentication → メール/パスワード」を有効化し、
  Firestore のセキュリティルールを `households/family` に対して
  上記メールアドレスのログイン中ユーザーのみ read/write 可に設定してください
  （ルールはコードには含めず、コンソールで管理します）。

## Firebase SDK

- バージョン **11.10.0** をピン留めし、`https://www.gstatic.com/firebasejs/11.10.0/` から
  ES モジュール（firebase-app / firebase-auth / firebase-firestore）を動的 `import()` で読み込みます。
  プロジェクト設定は `app.js` 冒頭の `FIREBASE_CONFIG` です。

## 検証

```bash
node --check app.js          # 構文チェック
node test/import-test.js     # バックアップJSONの取り込み検証（25か月・331件・33カテゴリー）
node test/firebase-test.js   # 認証分岐・同期ロジック（自己エコー抑制/リモート差し替え）の検証
```
