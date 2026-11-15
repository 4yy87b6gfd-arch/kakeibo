"use strict";
/* Firebase接続まわりの単体検証
 * app.js をブラウザ環境スタブ付きで読み込み、純粋関数（エラーメッセージ変換・
 * リモート適用判定）と、Firebase API をフェイクに差し替えた認証分岐・
 * 同期ロジック（自己エコー抑制・デバウンス保存・リモート差し替え）を検証する。
 * 実行: node test/firebase-test.js */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const appSrc = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const backupPath = path.join(__dirname, "..", "..", "hidden_files", "kakeibo-backup-2026-11-13.json");
const backupText = fs.readFileSync(backupPath, "utf8");

/* ブラウザ環境の最小スタブ。querySelector / getElementById は共有ダミー要素を返す */
function makeEl() {
  return {
    textContent: "", innerHTML: "", value: "", hidden: false, disabled: false, checked: false,
    classList: { toggle: () => {}, add: () => {}, remove: () => {} },
    addEventListener: () => {},
    querySelector: () => makeEl(),
    querySelectorAll: () => []
  };
}
const sharedEl = makeEl();
const store = new Map();
const ctx = {
  console,
  crypto: require("crypto").webcrypto,
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  },
  document: {
    addEventListener: () => {},
    querySelector: () => sharedEl,
    querySelectorAll: () => [],
    getElementById: () => sharedEl,
    createElement: () => makeEl()
  },
  alert: () => {},
  confirm: () => true,
  setTimeout, clearTimeout
};
ctx.window = { crypto: require("crypto").webcrypto };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(appSrc, ctx, { filename: "app.js" });
const run = (code) => vm.runInContext(code, ctx);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  /* --- 設定値 --- */
  assert.strictEqual(run("FIREBASE_CONFIG.projectId"), "kakeibo-e246c");
  assert.strictEqual(run("FIREBASE_CONFIG.authDomain"), "kakeibo-e246c.firebaseapp.com");
  assert.strictEqual(run("FAMILY_EMAIL"), "kakeibo.family@kakeibo-e246c.firebaseapp.com");
  assert.ok(run("FB_SDK_BASE").includes("firebasejs/"), "SDKはCDNから読む");
  console.log("設定値 OK");

  /* --- authErrorMessage（純粋関数） --- */
  const msg = (code) => run(`authErrorMessage({ code: ${JSON.stringify(code)} })`);
  assert.strictEqual(msg("auth/invalid-credential"), "パスワードが違います。");
  assert.strictEqual(msg("auth/wrong-password"), "パスワードが違います。");
  assert.strictEqual(msg("auth/user-not-found"), "パスワードが違います。");
  assert.ok(msg("auth/email-already-in-use").includes("別の端末で設定済み"));
  assert.ok(msg("auth/email-already-in-use").includes("ログインを試してください"));
  assert.ok(msg("auth/weak-password").includes("6文字以上"));
  assert.ok(msg("auth/network-request-failed").includes("通信エラー"));
  assert.ok(msg("auth/something-else").includes("auth/something-else"), "未知コードはコード付きで表示");
  assert.ok(run("authErrorMessage(null)").length > 0, "エラーオブジェクトなしでも文言を返す");
  console.log("authErrorMessage OK");

  /* --- remoteApplyDecision（純粋関数：自己エコー抑制・鮮度判定） --- */
  const decide = (remote, me, seen) => {
    ctx.__remote = remote;
    return run(`remoteApplyDecision(__remote, ${JSON.stringify(me)}, ${seen})`);
  };
  assert.strictEqual(decide(null, "devA", 0), "ignore");
  assert.strictEqual(decide({}, "devA", 0), "ignore");
  assert.strictEqual(decide({ state: {}, writer: "devA", updatedAt: 100 }, "devA", 0), "self", "自分の書き込みはエコーとして無視");
  assert.strictEqual(decide({ state: {}, writer: "devB", updatedAt: 100 }, "devA", 100), "stale", "受理済みと同じ時刻は古い");
  assert.strictEqual(decide({ state: {}, writer: "devB", updatedAt: 50 }, "devA", 100), "stale");
  assert.strictEqual(decide({ state: {}, writer: "devB", updatedAt: 200 }, "devA", 100), "apply", "他端末の新しい更新は適用");
  console.log("remoteApplyDecision OK");

  /* --- normalizeData が auth（パスワードハッシュ）を除去すること --- */
  const withAuth = JSON.parse(backupText);
  withAuth.auth = { passwordHash: "deadbeef" };
  ctx.__withAuthText = JSON.stringify(withAuth);
  const res = run("parseImportJSON(__withAuthText)");
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.data.auth, undefined, "取り込み時に auth は除去される");
  console.log("auth除去 OK");

  /* --- データ準備（実バックアップを state に載せる） --- */
  ctx.__resData = res.data;
  run("state.data = __resData");

  /* --- deviceId の安定性 --- */
  const d1 = run("deviceId()");
  const d2 = run("deviceId()");
  assert.ok(d1 && d1 === d2, "deviceId は端末ごとに固定");
  console.log("deviceId OK:", d1.slice(0, 8) + "…");

  /* --- 認証フロー分岐（Firebase Auth をフェイクに差し替え） --- */
  ctx.__authBehavior = "ok";
  run(`sync.fb = {
    authApi: {
      createUserWithEmailAndPassword: async () => {
        if (__authBehavior === "inuse") { const e = new Error("x"); e.code = "auth/email-already-in-use"; throw e; }
        return { user: { uid: "u1" } };
      },
      signInWithEmailAndPassword: async () => {
        if (__authBehavior === "badpass") { const e = new Error("x"); e.code = "auth/invalid-credential"; throw e; }
        return { user: { uid: "u1" } };
      },
      signOut: async () => {},
      updatePassword: async () => {},
      onAuthStateChanged: () => {}
    },
    fsApi: { setDoc: async () => {}, onSnapshot: () => () => {}, doc: () => ({}) },
    auth: {}, db: {}, docRef: {}
  }`);
  sharedEl.value = "secret1"; // 入力欄（共有ダミー）に6文字以上のパスワードが入っている状態

  // 新規作成が成功する分岐
  ctx.__authBehavior = "ok";
  store.delete("futari_kakeibo_account_hint");
  await run("setupPassword()");
  assert.strictEqual(store.get("futari_kakeibo_account_hint"), "1", "新規作成成功でヒントが保存される");

  // 既に使われている分岐 → ログイン画面へ誘導する文言が出る
  ctx.__authBehavior = "inuse";
  sharedEl.textContent = "";
  await run("setupPassword()");
  assert.ok(sharedEl.textContent.includes("既に設定済みです"), "email-already-in-use でログイン誘導文言: " + sharedEl.textContent);

  // ログイン失敗分岐 → 「パスワードが違います」
  // （email-already-in-use 分岐でパスワード欄がクリアされるため入れ直す）
  ctx.__authBehavior = "badpass";
  sharedEl.value = "secret1";
  sharedEl.textContent = "";
  await run("tryLogin()");
  assert.strictEqual(sharedEl.textContent, "パスワードが違います。");

  // ログイン成功分岐
  ctx.__authBehavior = "ok";
  store.delete("futari_kakeibo_account_hint");
  await run("tryLogin()");
  assert.strictEqual(store.get("futari_kakeibo_account_hint"), "1", "ログイン成功でヒントが保存される");
  console.log("認証フロー分岐 OK");

  /* --- 同期：初回スナップショット前はクラウドへ送らない --- */
  ctx.__captured = null;
  run(`sync.fb.fsApi.setDoc = async (ref, payload) => { __captured = payload; }`);
  run("sync.user = { uid: 'u1' }");
  run("sync.firstSnapshotDone = false");
  run("saveData()");
  await sleep(1000);
  assert.strictEqual(ctx.__captured, null, "firstSnapshotDone 前は push しない（初期状態の誤アップロード防止）");

  /* --- 同期：デバウンス保存で正しいペイロードが送られる --- */
  run("sync.firstSnapshotDone = true");
  run("saveData()");
  await sleep(1100);
  const payload = ctx.__captured;
  assert.ok(payload, "setDoc が呼ばれること");
  assert.strictEqual(payload.writer, d1, "writer は自端末ID");
  assert.strictEqual(typeof payload.updatedAt, "number");
  assert.strictEqual(payload.state.format, "futari-kakeibo");
  assert.strictEqual(payload.state.auth, undefined, "クラウドに auth を載せない");
  assert.strictEqual(decide(payload, d1, 0), "self", "自分の保存は自己エコーとして判定される");
  assert.strictEqual(run("sync.lastRemoteUpdatedAt"), payload.updatedAt, "受理済み updatedAt が進む");
  console.log("クラウド保存 OK");

  /* --- リモート差し替え：他端末の新しい状態が state とミラーに反映される --- */
  const remoteState = JSON.parse(backupText);
  remoteState.settings.members = ["健人", "知尋", "テスト"];
  ctx.__remoteState = remoteState;
  run("state.tab = 'home'");
  run("doApplyRemoteState(__remoteState)");
  assert.deepStrictEqual(Array.from(run("state.data.settings.members")), ["健人", "知尋", "テスト"]);
  const mirrored = JSON.parse(store.get("futari_kakeibo_data_v1"));
  assert.deepStrictEqual(mirrored.settings.members, ["健人", "知尋", "テスト"], "ミラーにも反映される");
  console.log("リモート差し替え OK");

  /* --- 入力編集中はリモート適用を保留し、入力を守る --- */
  const remoteState2 = JSON.parse(backupText);
  remoteState2.settings.members = ["健人"];
  ctx.__remoteState2 = remoteState2;
  run("state.tab = 'entry'");
  run("state.entry.amountStr = '500'"); // 入力途中
  run("applyRemoteState(__remoteState2)");
  assert.deepStrictEqual(Array.from(run("state.data.settings.members")), ["健人", "知尋", "テスト"], "編集中は差し替えない");
  assert.ok(run("sync.pendingRemote") !== null, "保留に回る");
  run("state.entry.amountStr = ''"); // 入力完了
  run("state.tab = 'home'");
  run("maybeApplyPendingRemote()");
  assert.deepStrictEqual(Array.from(run("state.data.settings.members")), ["健人"], "入力後に保留分が反映される");
  console.log("編集中の保留 OK");

  console.log("\nすべての検証に合格しました。");
}

main().catch((e) => { console.error(e); process.exit(1); });
