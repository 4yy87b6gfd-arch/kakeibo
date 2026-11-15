"use strict";
/* =====================================================================
 * ふたりの家計簿（移行版）
 * - データ形式は移行元バックアップJSON（format: "futari-kakeibo", version 1）と互換。
 * - 認証は Firebase Authentication（メール/パスワード）。家族パスワードを
 *   固定の内部メールアドレス（FAMILY_EMAIL）と組み合わせて使う。
 *   パスワード自体はデータ側に保存しない。
 * - データ同期は Firestore の単一ドキュメント households/family に全状態を保存。
 *   localStorage はオフライン用のキャッシュ/ミラーとして併用する。
 *   保存は saveData() 経由に寄せてある（ミラー即時＋Firestoreへデバウンス送信）。
 * - 同期状態表示は renderSyncStatus() と #sync-status 要素。
 * - Firebase SDK は CDN の ES モジュールを動的 import() で読み込む。
 *   読み込みに失敗しても画面が真っ白にならないよう、失敗時は
 *   localStorage のキャッシュで閲覧のみ可能なフォールバックに入る。
 * ===================================================================== */

// ▼▼▼ Firebase設定（プロジェクト kakeibo-e246c）▼▼▼
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBLlI5uM2E5nxATXubYmW5lNn6IiwY3n00",
  authDomain: "kakeibo-e246c.firebaseapp.com",
  projectId: "kakeibo-e246c",
  storageBucket: "kakeibo-e246c.firebasestorage.app",
  messagingSenderId: "560350020102",
  appId: "1:560350020102:web:e44a066049ab83a0e3b987"
};
// ▲▲▲ Firebase設定 ▲▲▲

/* 家族パスワードと組み合わせる固定の内部メールアドレス。
 * Firestore のセキュリティルールもこのメールアドレスを前提にする。 */
const FAMILY_EMAIL = "kakeibo.family@kakeibo-e246c.firebaseapp.com";
/* 全状態を保存する Firestore ドキュメント */
const HOUSEHOLD_COLLECTION = "households";
const HOUSEHOLD_DOC_ID = "family";
/* Firebase JS SDK のバージョン（CDNで実在確認済み：全モジュール HTTP 200） */
const FB_SDK_VERSION = "11.10.0";
const FB_SDK_BASE = "https://www.gstatic.com/firebasejs/" + FB_SDK_VERSION + "/";

const LS_DATA_KEY = "futari_kakeibo_data_v1";
const LS_DEVICE_ID_KEY = "futari_kakeibo_device_id";
const LS_ACCOUNT_HINT_KEY = "futari_kakeibo_account_hint";
const CLOUD_SAVE_DEBOUNCE_MS = 800;

/* ---------------- データアダプター（localStorage ミラー） ----------------
 * storageAdapter は localStorage への読み書き専用（オフライン用キャッシュ/ミラー）。
 * アプリからの保存は必ず saveData() 経由で行い、ミラー保存に加えて
 * ログイン中は Firestore へもデバウンス送信する。 */
const storageAdapter = {
  load() {
    try {
      const raw = localStorage.getItem(LS_DATA_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.error("load failed", e);
      return null;
    }
  },
  save(data) {
    try {
      localStorage.setItem(LS_DATA_KEY, JSON.stringify(data));
    } catch (e) {
      console.error("save failed", e);
      alert("保存に失敗しました（容量不足の可能性があります）");
    }
  }
};
function loadData() { return storageAdapter.load(); }
function saveData() {
  if (!state.data) return;
  storageAdapter.save(state.data);
  scheduleCloudSave();
}

/* ---------------- Firebase（認証＋同期）の状態 ----------------
 * sync.status: boot（起動中） / local（SDK読み込み失敗・閲覧のみ） /
 *   signedout（未ログイン） / connecting（ログイン直後・初回スナップショット待ち） /
 *   syncing（同期中） / synced（同期済み） / error（同期エラー） */
const sync = {
  fb: null,               // { authApi, fsApi, auth, db, docRef }
  loadFailed: false,
  user: null,
  status: "boot",
  lastSyncedAt: null,     // 最後に同期が確認できた時刻（ms）
  lastRemoteUpdatedAt: 0, // 最後に受理したリモートの updatedAt
  firstSnapshotDone: false,
  unsubscribe: null,
  saveTimer: null,
  pendingRemote: null     // 入力フォーム編集中に届いたリモート状態（適用を保留）
};
let offlineViewing = false; // SDK読み込み失敗時にキャッシュ閲覧へ入ったかどうか

/* 端末ごとのランダムID。Firestoreドキュメントの writer に載せ、自己エコーの判別に使う。 */
function deviceId() {
  let id = null;
  try { id = localStorage.getItem(LS_DEVICE_ID_KEY); } catch (e) { /* ignore */ }
  if (!id) {
    id = uid();
    try { localStorage.setItem(LS_DEVICE_ID_KEY, id); } catch (e) { /* ignore */ }
  }
  return id;
}

/* 同期状態表示（#sync-status） */
function renderSyncStatus() {
  const el = document.getElementById("sync-status");
  if (!el) return;
  switch (sync.status) {
    case "local": el.textContent = "オフライン（閲覧のみ）"; break;
    case "signedout": el.textContent = "未ログイン"; break;
    case "connecting": el.textContent = "同期中…"; break;
    case "syncing": el.textContent = "同期中…"; break;
    case "error": el.textContent = "同期エラー"; break;
    case "synced": {
      if (sync.lastSyncedAt) {
        const d = new Date(sync.lastSyncedAt);
        const hh = String(d.getHours()).padStart(2, "0");
        const mm = String(d.getMinutes()).padStart(2, "0");
        el.textContent = "同期済み " + hh + ":" + mm;
      } else {
        el.textContent = "同期済み";
      }
      break;
    }
    default: el.textContent = "接続中…";
  }
}

/* Firebase SDK を CDN の ES モジュールとして動的に読み込む。
 * 失敗した場合は例外を投げ、呼び出し側（init）でフォールバックする。 */
async function loadFirebaseSDK() {
  const [appM, authM, fsM] = await Promise.all([
    import(FB_SDK_BASE + "firebase-app.js"),
    import(FB_SDK_BASE + "firebase-auth.js"),
    import(FB_SDK_BASE + "firebase-firestore.js")
  ]);
  const app = appM.initializeApp(FIREBASE_CONFIG);
  const auth = authM.getAuth(app); // 永続化はデフォルト（ローカル）を使用
  const db = fsM.getFirestore(app);
  return {
    authApi: authM,
    fsApi: fsM,
    auth,
    db,
    docRef: fsM.doc(db, HOUSEHOLD_COLLECTION, HOUSEHOLD_DOC_ID)
  };
}

/* Firebase Auth のエラーを日本語メッセージに変換する（純粋関数・テスト対象） */
function authErrorMessage(e) {
  const code = e && e.code ? String(e.code) : "";
  switch (code) {
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
    case "auth/invalid-login-credentials":
      return "パスワードが違います。";
    case "auth/email-already-in-use":
      return "このパスワードは既に別の端末で設定済みの可能性があります。ログインを試してください。";
    case "auth/weak-password":
      return "パスワードは6文字以上にしてください。";
    case "auth/network-request-failed":
      return "通信エラーが発生しました。接続を確認してもう一度お試しください。";
    case "auth/too-many-requests":
      return "試行回数が多すぎます。しばらく待ってからもう一度お試しください。";
    case "auth/requires-recent-login":
      return "安全のため再ログインが必要です。一度ログアウトしてログインし直してから操作してください。";
    case "auth/operation-not-allowed":
      return "ログイン方式が有効になっていません（Firebaseコンソールでメール/パスワード認証を有効化してください）。";
    default:
      return "エラーが発生しました" + (code ? "（" + code + "）" : "") + "。";
  }
}

/* リモートスナップショットへの対応を決める（純粋関数・テスト対象）
 * 戻り値: "ignore"（データなし） / "self"（自分の書き込みのエコー） /
 *         "stale"（受理済みより古い） / "apply"（状態を差し替える） */
function remoteApplyDecision(remote, myDeviceId, lastSeenUpdatedAt) {
  if (!remote || typeof remote !== "object" || !remote.state) return "ignore";
  if (remote.writer && remote.writer === myDeviceId) return "self";
  if ((Number(remote.updatedAt) || 0) <= (Number(lastSeenUpdatedAt) || 0)) return "stale";
  return "apply";
}

/* ローカルの変更を Firestore へ送る（デバウンス付き）。
 * 未ログイン・初回スナップショット前・SDK未接続のときは何もしない
 * （localStorage ミラーには保存済みなので、データ自体は端末に残る）。 */
function scheduleCloudSave() {
  if (!sync.fb || !sync.user || !sync.firstSnapshotDone || !state.data) return;
  sync.status = "syncing";
  renderSyncStatus();
  clearTimeout(sync.saveTimer);
  sync.saveTimer = setTimeout(pushToCloud, CLOUD_SAVE_DEBOUNCE_MS);
}
async function pushToCloud() {
  if (!sync.fb || !sync.user || !state.data) return;
  const payload = {
    state: JSON.parse(JSON.stringify(state.data)),
    updatedAt: Date.now(),
    writer: deviceId()
  };
  delete payload.state.auth; // 念のため（パスワード類はクラウドに載せない）
  try {
    await sync.fb.fsApi.setDoc(sync.fb.docRef, payload);
    sync.lastRemoteUpdatedAt = payload.updatedAt;
    sync.lastSyncedAt = payload.updatedAt;
    sync.status = "synced";
  } catch (e) {
    console.error("cloud save failed", e);
    sync.status = "error";
  }
  renderSyncStatus();
}

/* Firestore の購読開始（ログイン後に呼ぶ） */
function subscribeHousehold() {
  if (!sync.fb || sync.unsubscribe) return;
  sync.unsubscribe = sync.fb.fsApi.onSnapshot(sync.fb.docRef, (snap) => {
    sync.firstSnapshotDone = true;
    if (!snap.exists()) {
      /* ドキュメントがまだ無い初回。空の初期状態を勝手にアップロードして
       * 既存データを上書きしない。ドキュメントは、ログイン後にユーザーが
       * JSONをインポート（または編集を保存）した時点で saveData 経由で作られる。 */
      sync.status = "synced";
      renderSyncStatus();
      return;
    }
    const remote = snap.data();
    const decision = remoteApplyDecision(remote, deviceId(), sync.lastRemoteUpdatedAt);
    if (decision === "self") {
      sync.lastRemoteUpdatedAt = Number(remote.updatedAt) || sync.lastRemoteUpdatedAt;
      sync.lastSyncedAt = Number(remote.updatedAt) || sync.lastSyncedAt;
    } else if (decision === "apply") {
      sync.lastRemoteUpdatedAt = Number(remote.updatedAt) || 0;
      sync.lastSyncedAt = Number(remote.updatedAt) || Date.now();
      applyRemoteState(remote.state);
    }
    sync.status = "synced";
    renderSyncStatus();
  }, (e) => {
    console.error("snapshot error", e);
    sync.firstSnapshotDone = true;
    sync.status = "error";
    renderSyncStatus();
  });
}
function unsubscribeHousehold() {
  if (sync.unsubscribe) {
    try { sync.unsubscribe(); } catch (e) { /* ignore */ }
    sync.unsubscribe = null;
  }
  sync.firstSnapshotDone = false;
  sync.pendingRemote = null;
  clearTimeout(sync.saveTimer);
}

/* リモート状態の適用。入力フォームの編集中は適用を保留し、入力を壊さない。 */
function isEntryDirty() {
  if (state.tab !== "entry") return false;
  if (state.entry.editingId || state.entry.amountStr) return true;
  const note = document.getElementById("entry-note");
  return !!(note && note.value);
}
function applyRemoteState(remoteState) {
  if (isEntryDirty()) {
    sync.pendingRemote = remoteState;
    toast("別の端末で更新されました（入力が終わったら反映します）");
    return;
  }
  doApplyRemoteState(remoteState);
}
function doApplyRemoteState(remoteState) {
  const clean = normalizeData(JSON.parse(JSON.stringify(remoteState)));
  delete clean.auth;
  state.data = clean;
  storageAdapter.save(state.data); // ミラーのみ更新する（クラウドへは送り返さない）
  renderTab();
}
function maybeApplyPendingRemote() {
  if (sync.pendingRemote && !isEntryDirty()) {
    const r = sync.pendingRemote;
    sync.pendingRemote = null;
    doApplyRemoteState(r);
  }
}

/* ---------------- ユーティリティ ---------------- */
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const yen = (n) => "¥" + Math.round(Number(n) || 0).toLocaleString("ja-JP");
const uid = () => (window.crypto && crypto.randomUUID)
  ? crypto.randomUUID()
  : "id-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);

/* 月キー "YYYY-MM" の操作 */
function monthKeyOf(date) {
  const y = date.getFullYear(), m = String(date.getMonth() + 1).padStart(2, "0");
  return y + "-" + m;
}
function currentMonthKey() { return monthKeyOf(new Date()); }
function addMonths(key, delta) {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return monthKeyOf(d);
}
function monthLabel(key) {
  const [y, m] = key.split("-").map(Number);
  return y + "年" + m + "月";
}
function todayStr() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { t.hidden = true; }, 2200);
}

/* ---------------- データモデル ----------------
 * data = {
 *   format: "futari-kakeibo", version: 1, exportedAt,
 *   settings: { schemaVersion, title, members: [名前, 名前], revision,
 *               categories: [{id, name, kind: "expense"|"income", color, archived}],
 *               keywords: {},
 *               pendingGroups: { 子カテゴリID: 親カテゴリID }  // 新規月にのみ反映する集計設定
 *             },
 *   months: [ { month: "YYYY-MM", budgets: {catId: 金額}, groups: {子ID: 親ID},
 *               entries: [...], closed, incomeComplete, imported, ... } ]
 *   ※ パスワードは Firebase Auth で管理し、データ内には持たない。
 *     旧データや移行用JSONに auth が含まれていても normalizeData で除去する。
 *   accounts: [{ id, name, balance, updatedAt, isMain, type }]  // 口座と現在残高（手動管理）
 *     type は種別: "bank"（銀行口座）/ "cash"（現金）/ "emoney"（電子マネー）/ "prepaid"（チャージ式）。
 *     isMain が true の口座は最大1つ。収入入力の初期選択になる「メイン口座」。
 *   entries の accountId（任意）: その記録が増減させる口座のID。
 *     記録の保存・編集・削除に合わせて adjustAccountBalance で残高を増減させる。
 *   transfers: [{ id, date, fromId, toId, amount, note, createdAt }]  // 口座間の移動（振替）
 *     収支には数えず、2口座の残高を adjustTransferBalance で移すだけ。
 *   goals: [{ id, kind, name, target, saved, createdAt }]  // 貯金目標と借金
 *     kind: "save"（貯金目標）/ "debt"（借金）。save は target=目標金額・saved=確保済み、
 *     debt は target=借入総額・saved=返済済み。どちらも口座残高そのものは変えない。
 * } */
function emptyData() {
  return {
    format: "futari-kakeibo",
    version: 1,
    exportedAt: null,
    settings: {
      schemaVersion: 1,
      title: "ふたりの家計簿",
      members: ["健人", "知尋"],
      revision: 1,
      categories: [
        { id: "expense-0", name: "食費", kind: "expense", color: "#7796a4", archived: false },
        { id: "expense-1", name: "日用品", kind: "expense", color: "#84996c", archived: false },
        { id: "expense-2", name: "その他", kind: "expense", color: "#bd7865", archived: false },
        { id: "income-0", name: "給与", kind: "income", color: "#4f7867", archived: false }
      ],
      keywords: {},
      pendingGroups: {}
    },
    months: [],
    accounts: [],
    transfers: [],
    goals: []
  };
}

const state = {
  data: null,
  tab: "home",
  home: { month: currentMonthKey(), kind: "expense", expanded: {} },
  history: { month: currentMonthKey(), catId: "", kind: "", member: "", accountId: "" },
  entry: { kind: "expense", amountStr: "", member: "共通", catId: null, accountId: null, editingId: null, editingMonth: null },
  compare: { baseMonth: currentMonthKey(), againstMonth: addMonths(currentMonthKey(), -1), kind: "expense" },
  transfer: { fromId: null, toId: null },
  entryReturn: null,
  settings: { month: currentMonthKey() }
};

function categories() { return state.data.settings.categories; }
function categoryById(id) { return categories().find(c => c.id === id) || null; }
function members() { return state.data.settings.members; }

/* ---------------- 口座（資産） ---------------- */
function accounts() { return state.data.accounts || []; }
function accountById(id) { return accounts().find(a => a.id === id) || null; }
/* 記録1件が口座残高へ与える影響を加える（sign: 1=反映 / -1=取り消し）。
 * 収入は残高を増やし、支出は減らす。口座未指定・口座が無い場合は何もしない。
 * 記録の保存・編集・削除のたびに呼び、残高を収支と一致させる。 */
function adjustAccountBalance(entryLike, sign) {
  if (!entryLike || !entryLike.accountId) return;
  const acc = accountById(entryLike.accountId);
  if (!acc) return;
  const cat = categoryById(entryLike.categoryId);
  const kind = cat ? cat.kind : "expense";
  const amt = Number(entryLike.amount) || 0;
  if (!amt) return;
  acc.balance = (Number(acc.balance) || 0) + sign * (kind === "income" ? amt : -amt);
  acc.updatedAt = new Date().toISOString();
}
/* メイン口座（収入の入金先の初期選択）。未指定なら null */
function mainAccount() { return accounts().find(a => a.isMain) || null; }
/* 口座間の移動（振替）1件を残高へ加える（sign: 1=反映 / -1=取り消し）。
 * 移動元を減らし、移動先を増やす。収支の集計には影響しない。 */
function transfers() { return state.data.transfers || []; }
function adjustTransferBalance(t, sign) {
  if (!t) return;
  const amt = Number(t.amount) || 0;
  if (!amt) return;
  const from = accountById(t.fromId);
  const to = accountById(t.toId);
  const now = new Date().toISOString();
  if (from) { from.balance = (Number(from.balance) || 0) - sign * amt; from.updatedAt = now; }
  if (to) { to.balance = (Number(to.balance) || 0) + sign * amt; to.updatedAt = now; }
}
/* ---------------- 貯金目標のヘルパー ---------------- */
function goals() { return state.data.goals; }
function goalById(id) { return goals().find(g => g.id === id) || null; }
/* 進捗率（0〜100の整数）。目標額が0なら、貯まっていれば100・なければ0 */
function goalProgress(g) {
  const target = Number(g.target) || 0;
  const saved = Number(g.saved) || 0;
  if (target <= 0) return saved > 0 ? 100 : 0;
  return Math.min(100, Math.floor(saved / target * 100));
}
/* 口座の種別。資産タブでは種別ごとに一覧を分けて表示する */
const ACCOUNT_TYPES = [
  { id: "bank", label: "銀行口座" },
  { id: "cash", label: "現金" },
  { id: "emoney", label: "電子マネー" },
  { id: "prepaid", label: "チャージ式" }
];
function accountTypeLabel(type) {
  const t = ACCOUNT_TYPES.find(x => x.id === type);
  return t ? t.label : "銀行口座";
}
/* 口座の <option> 群（種別ごとに optgroup で分ける）。selectedId が選択状態になる */
function accountOptionsGrouped(selectedId) {
  return ACCOUNT_TYPES.map(t => {
    const list = accounts().filter(a => (a.type || "bank") === t.id);
    if (!list.length) return "";
    return `<optgroup label="${t.label}">` + list.map(a =>
      `<option value="${esc(a.id)}" ${selectedId === a.id ? "selected" : ""}>${esc(a.name)}（残高 ${esc(yen(a.balance))}）</option>`).join("") + `</optgroup>`;
  }).join("");
}

function findMonth(key) {
  return state.data.months.find(m => m.month === key) || null;
}
/* 直近（その月以前で最も新しい）既存月を返す */
function latestMonthAtOrBefore(key) {
  const sorted = state.data.months.map(m => m.month).filter(k => k <= key).sort();
  return sorted.length ? findMonth(sorted[sorted.length - 1]) : null;
}
/* 月を取得。なければ作る（予算は直近の月から引き継ぎ、集計関係は pendingGroups をスナップショット） */
function ensureMonth(key) {
  let m = findMonth(key);
  if (m) return m;
  const prev = latestMonthAtOrBefore(addMonths(key, -1)) ||
    state.data.months.slice().sort((a, b) => a.month < b.month ? -1 : 1)[0] || null;
  m = {
    month: key,
    revision: 1,
    budgets: prev ? Object.assign({}, prev.budgets) : {},
    groups: Object.assign({}, state.data.settings.pendingGroups || {}),
    entries: [],
    closed: false,
    incomeComplete: false,
    imported: false,
    updatedAt: new Date().toISOString()
  };
  state.data.months.push(m);
  state.data.months.sort((a, b) => a.month < b.month ? -1 : 1);
  return m;
}
/* 月の状態: "closed"=完了 / "active"=入力中 / "none"=未確定（データなし） */
function monthStatus(key) {
  const m = findMonth(key);
  if (!m) return "none";
  if (m.closed) return "closed";
  return "active";
}
function statusLabel(st) {
  return st === "closed" ? "完了" : st === "active" ? "入力中" : "未確定";
}

/* カテゴリー別合計（ロールアップ前）: { catId: 金額 } */
function sumByCategory(monthObj, kind) {
  const sums = {};
  if (!monthObj) return sums;
  for (const e of monthObj.entries) {
    const cat = categoryById(e.categoryId);
    if (!cat || cat.kind !== kind) continue;
    sums[e.categoryId] = (sums[e.categoryId] || 0) + (Number(e.amount) || 0);
  }
  return sums;
}
function totalOf(monthObj, kind) {
  const sums = sumByCategory(monthObj, kind);
  return Object.values(sums).reduce((a, b) => a + b, 0);
}
function totalByMember(monthObj, kind, member) {
  if (!monthObj) return 0;
  let t = 0;
  for (const e of monthObj.entries) {
    const cat = categoryById(e.categoryId);
    if (cat && cat.kind === kind && e.member === member) t += Number(e.amount) || 0;
  }
  return t;
}
/* ロールアップ適用後の行リストを作る。
 * 返り値: [{ cat, amount, budget, children: [{cat, amount}] }]（金額0かつ予算0のものは除く） */
function rolledUpRows(monthObj, kind) {
  const sums = sumByCategory(monthObj, kind);
  const groups = (monthObj && monthObj.groups) || {};
  const childToParent = {};
  for (const [child, parent] of Object.entries(groups)) {
    const cc = categoryById(child), pc = categoryById(parent);
    if (cc && pc && cc.kind === kind && pc.kind === kind && child !== parent) childToParent[child] = parent;
  }
  const rows = new Map();
  const ensureRow = (cat) => {
    if (!rows.has(cat.id)) rows.set(cat.id, { cat, amount: 0, budget: 0, children: [] });
    return rows.get(cat.id);
  };
  for (const cat of categories()) {
    if (cat.kind !== kind) continue;
    const amt = sums[cat.id] || 0;
    const budget = monthObj && monthObj.budgets ? (monthObj.budgets[cat.id] || 0) : 0;
    if (childToParent[cat.id]) {
      const parentRow = ensureRow(categoryById(childToParent[cat.id]));
      parentRow.amount += amt;
      parentRow.budget += budget;
      if (amt !== 0) parentRow.children.push({ cat, amount: amt });
    } else {
      const row = ensureRow(cat);
      row.amount += amt;
      row.budget += budget;
    }
  }
  return Array.from(rows.values())
    .filter(r => r.amount !== 0 || r.budget !== 0)
    .sort((a, b) => b.amount - a.amount);
}

/* ---------------- 認証（家族パスワード = Firebase Auth） ----------------
 * 家族パスワードは、固定の内部メール FAMILY_EMAIL と組み合わせて
 * Firebase Authentication のメール/パスワード認証で照合する。
 * ログイン状態の保持は Firebase Auth のローカル永続化（デフォルト）に任せる。 */
async function logout() {
  if (sync.fb) {
    try { await sync.fb.authApi.signOut(sync.fb.auth); }
    catch (e) { console.error("signOut failed", e); }
  }
  location.reload();
}
/* ゲート表示。mode: "setup" | "login"（省略時はこの端末の履歴から推定する） */
function showGate(mode) {
  $("#gate").hidden = false;
  $("#app").hidden = true;
  const m = mode || (localStorage.getItem(LS_ACCOUNT_HINT_KEY) ? "login" : "setup");
  $("#gate-setup").hidden = m !== "setup";
  $("#gate-login").hidden = m !== "login";
  const off = $("#gate-offline");
  if (off) off.hidden = !sync.loadFailed;
}
function showApp() {
  $("#gate").hidden = true;
  $("#app").hidden = false;
  renderSyncStatus();
  renderTab();
}
/* Firebase Auth の状態変化（ログイン/ログアウト）を受ける */
function handleAuthState(user) {
  sync.user = user || null;
  if (sync.user) {
    offlineViewing = false;
    sync.status = "connecting";
    renderSyncStatus();
    showApp();
    subscribeHousehold();
  } else {
    unsubscribeHousehold();
    sync.status = sync.loadFailed ? "local" : "signedout";
    renderSyncStatus();
    if (!offlineViewing) showGate();
  }
}
async function setupPassword() {
  const p1 = $("#setup-pass1").value, p2 = $("#setup-pass2").value;
  const err = $("#setup-error");
  const btn = $("#setup-btn");
  if (!sync.fb) { err.textContent = "オフラインのため設定できません。接続を確認してもう一度お試しください。"; return; }
  if (!p1 || p1.length < 6) { err.textContent = "パスワードは6文字以上にしてください。"; return; }
  if (p1 !== p2) { err.textContent = "確認用パスワードが一致しません。"; return; }
  btn.disabled = true;
  try {
    await sync.fb.authApi.createUserWithEmailAndPassword(sync.fb.auth, FAMILY_EMAIL, p1);
    localStorage.setItem(LS_ACCOUNT_HINT_KEY, "1");
    toast("パスワードを設定しました");
    /* 以後の画面遷移は handleAuthState が行う */
  } catch (e) {
    console.error("createUser failed", e);
    if (e && e.code === "auth/email-already-in-use") {
      localStorage.setItem(LS_ACCOUNT_HINT_KEY, "1");
      err.textContent = authErrorMessage(e);
      showGate("login");
      $("#login-error").textContent = "この家族パスワードは既に設定済みです。設定したパスワードでログインしてください。";
      const lp = $("#login-pass"); if (lp) lp.value = "";
    } else {
      err.textContent = authErrorMessage(e);
    }
  } finally {
    btn.disabled = false;
  }
}
async function tryLogin() {
  const p = $("#login-pass").value;
  const err = $("#login-error");
  const btn = $("#login-btn");
  if (!sync.fb) { err.textContent = "オフラインのためログインできません。接続を確認するか、下の「オフラインで閲覧する」をお使いください。"; return; }
  if (!p) { err.textContent = "パスワードを入力してください。"; return; }
  if (p.length < 6) { err.textContent = "パスワードは6文字以上です。入力内容を確認してください。"; return; }
  btn.disabled = true;
  try {
    await sync.fb.authApi.signInWithEmailAndPassword(sync.fb.auth, FAMILY_EMAIL, p);
    localStorage.setItem(LS_ACCOUNT_HINT_KEY, "1");
    /* 以後の画面遷移は handleAuthState が行う */
  } catch (e) {
    console.error("signIn failed", e);
    err.textContent = authErrorMessage(e);
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- タブ切替 ---------------- */
function switchTab(tab) {
  state.tab = tab;
  if (tab !== "entry") maybeApplyPendingRemote();
  $$(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  ["home", "history", "entry", "compare", "assets", "goals", "settings"].forEach(t => {
    $("#tab-" + t).hidden = t !== tab;
  });
  renderTab();
}
function renderTab() {
  if (!state.data) return;
  if (state.tab === "home") renderHome();
  else if (state.tab === "history") renderHistory();
  else if (state.tab === "entry") renderEntry();
  else if (state.tab === "compare") renderCompare();
  else if (state.tab === "assets") renderAssets();
  else if (state.tab === "goals") renderGoals();
  else if (state.tab === "settings") renderSettings();
}

/* ---------------- モーダル ---------------- */
function openModal(html) {
  $("#modal-box").innerHTML = html;
  $("#modal-backdrop").hidden = false;
}
function closeModal() { $("#modal-backdrop").hidden = true; $("#modal-box").innerHTML = ""; }

/* ---------------- 今月タブ ---------------- */
function monthNavHTML(current, prefix) {
  const st = monthStatus(current);
  return `<div class="month-nav">
    <button class="nav-btn" data-act="${prefix}-prev" aria-label="前月">‹</button>
    <div>${esc(monthLabel(current))}<span class="badge ${st === "closed" ? "closed" : ""}">${statusLabel(st)}</span></div>
    <button class="nav-btn" data-act="${prefix}-next" aria-label="翌月">›</button>
  </div>`;
}
function donutSVG(rows, size) {
  const total = rows.reduce((a, r) => a + r.amount, 0);
  const cx = size / 2, cy = size / 2, r = size / 2 - 4, ir = r * 0.62;
  if (total <= 0) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="${cx}" cy="${cy}" r="${(r + ir) / 2}" fill="none" stroke="#eee5d6" stroke-width="${r - ir}"/>
      <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle" font-size="12" fill="#8a8378">記録なし</text></svg>`;
  }
  let angle = -Math.PI / 2;
  let paths = "";
  for (const row of rows) {
    const frac = row.amount / total;
    const a2 = angle + frac * Math.PI * 2;
    const large = frac > 0.5 ? 1 : 0;
    const x1 = cx + r * Math.cos(angle), y1 = cy + r * Math.sin(angle);
    const x2 = cx + r * Math.cos(a2), y2 = cy + r * Math.sin(a2);
    const x3 = cx + ir * Math.cos(a2), y3 = cy + ir * Math.sin(a2);
    const x4 = cx + ir * Math.cos(angle), y4 = cy + ir * Math.sin(angle);
    if (frac >= 0.9999) {
      paths += `<circle cx="${cx}" cy="${cy}" r="${(r + ir) / 2}" fill="none" stroke="${row.cat.color}" stroke-width="${r - ir}"/>`;
    } else {
      paths += `<path d="M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} L ${x3} ${y3} A ${ir} ${ir} 0 ${large} 0 ${x4} ${y4} Z" fill="${row.cat.color}"/>`;
    }
    angle = a2;
  }
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${paths}
    <text x="${cx}" y="${cy - 8}" text-anchor="middle" font-size="11" fill="#8a8378">合計</text>
    <text x="${cx}" y="${cy + 12}" text-anchor="middle" font-size="13" font-weight="700" fill="#33302b">${esc(yen(total))}</text></svg>`;
}
function entryRowHTML(e, monthKeyForEntry) {
  const cat = categoryById(e.categoryId);
  const kind = cat ? cat.kind : "expense";
  const dateLabel = e.date ? e.date.slice(5).replace("-", "/") : "日付なし";
  const note = e.note || (cat ? cat.name : "（不明なカテゴリー）");
  const acc = e.accountId ? accountById(e.accountId) : null;
  return `<button class="entry-row" data-edit-entry="${esc(e.id)}" data-entry-month="${esc(monthKeyForEntry)}">
    <span class="cat-dot" style="background:${cat ? cat.color : "#ccc"}"></span>
    <span class="entry-main">
      <span class="entry-note">${esc(note)}</span>
      <span class="entry-meta">${esc(dateLabel)} ・ ${cat ? esc(cat.name) : "?"} ・ ${esc(e.member || "共通")}${e.recurring ? " ・ 固定費" : ""}${acc ? " ・ 🏦" + esc(acc.name) : ""}</span>
    </span>
    <span class="entry-amount ${kind === "income" ? "amount-income" : "amount-expense"}">${kind === "income" ? "+" : "−"}${esc(yen(e.amount))}</span>
  </button>`;
}
function renderHome() {
  const key = state.home.month;
  const m = findMonth(key);
  const prev = findMonth(addMonths(key, -1));
  const incTotal = totalOf(m, "income");
  const expTotal = totalOf(m, "expense");
  const prevExpTotal = totalOf(prev, "expense");
  const budgetTotal = m ? Object.entries(m.budgets || {})
    .filter(([cid]) => { const c = categoryById(cid); return c && c.kind === "expense"; })
    .reduce((a, [, v]) => a + (Number(v) || 0), 0) : 0;
  const budgetLeft = budgetTotal - expTotal;
  const budgetPct = budgetTotal > 0 ? Math.min(100, Math.round(expTotal / budgetTotal * 100)) : 0;
  const rows = rolledUpRows(m, state.home.kind);
  const donutRows = rolledUpRows(m, "expense").filter(r => r.amount > 0);
  const recent = m ? m.entries.slice().sort((a, b) =>
    String(b.date || "").localeCompare(String(a.date || "")) ||
    String(b.createdAt || "").localeCompare(String(a.createdAt || ""))).slice(0, 8) : [];
  const memberRows = members().map(name => {
    const v = totalByMember(m, "income", name);
    return `<div class="row between"><span>${esc(name)}</span><b>${esc(yen(v))}</b></div>`;
  }).join("");
  const commonInc = totalByMember(m, "income", "共通");
  const accs = accounts();
  const accTotal = accs.reduce((a, x) => a + (Number(x.balance) || 0), 0);

  $("#tab-home").innerHTML = `
    ${monthNavHTML(key, "home")}
    <div class="card">
      <div class="row between">
        <h3 style="margin:0">今月の収支</h3>
        ${m && m.closed
          ? `<button class="btn small" data-act="reopen-month">入力中に戻す</button>`
          : `<button class="btn small primary" data-act="close-month">入力完了にする</button>`}
      </div>
      <div style="margin-top:10px">
        <div class="row between"><span class="muted">収入</span><span class="big-amount amount-income">${esc(yen(incTotal))}</span></div>
        ${memberRows}
        ${commonInc ? `<div class="row between"><span>共通</span><b>${esc(yen(commonInc))}</b></div>` : ""}
        <div class="row between" style="margin-top:6px"><span class="muted">支出（積立貯金を含む）</span><span class="big-amount amount-expense">${esc(yen(expTotal))}</span></div>
        <div class="row between"><span class="muted small">前月の支出</span><span class="small">${esc(yen(prevExpTotal))}</span></div>
        <div class="row between" style="margin-top:6px"><span class="muted">差し引き</span><b>${esc(yen(incTotal - expTotal))}</b></div>
      </div>
    </div>

    ${accs.length ? `<div class="card">
      <div class="row between">
        <h3 style="margin:0">口座の残高</h3>
        <button class="btn small" data-act="goto-assets">資産タブで管理</button>
      </div>
      <div class="row between" style="margin-top:8px"><span class="muted">合計</span><b>${esc(yen(accTotal))}</b></div>
      ${accs.slice(0, 4).map(a => `<div class="row between"><span>🏦 ${esc(a.name)}</span><span>${esc(yen(a.balance))}</span></div>`).join("")}
    </div>` : ""}

    ${goalsOfKind("save").length ? `<div class="card">
      <div class="row between">
        <h3 style="margin:0">貯金目標</h3>
        <button class="btn small" data-act="goto-goals">目標タブで管理</button>
      </div>
      ${goalsOfKind("save").slice(0, 3).map(g => { const pct = goalProgress(g); return `<div style="margin-top:8px">
        <div class="row between"><span>🎯 ${esc(g.name)}</span><span class="small">${esc(yen(g.saved))} ／ ${esc(yen(g.target))}（${pct}%）</span></div>
        <div class="bar" style="margin-top:4px"><i style="width:${pct}%"></i></div>
      </div>`; }).join("")}
    </div>` : ""}

    ${goalsOfKind("debt").length ? `<div class="card">
      <div class="row between">
        <h3 style="margin:0">借金</h3>
        <button class="btn small" data-act="goto-goals">目標タブで管理</button>
      </div>
      <div class="row between" style="margin-top:8px"><span class="muted">残りの借金</span><b class="amount-expense">${esc(yen(debtRemaining()))}</b></div>
      ${goalsOfKind("debt").slice(0, 3).map(g => { const pct = goalProgress(g); return `<div style="margin-top:8px">
        <div class="row between"><span>💳 ${esc(g.name)}</span><span class="small">残り ${esc(yen(Math.max(0, (Number(g.target) || 0) - (Number(g.saved) || 0))))}（返済 ${pct}%）</span></div>
        <div class="bar" style="margin-top:4px"><i style="width:${pct}%"></i></div>
      </div>`; }).join("")}
    </div>` : ""}

    <div class="card">
      <h3>今月の予算</h3>
      ${budgetTotal > 0 ? `
        <div class="row between"><span class="muted">残り使用可能額</span><span class="big-amount ${budgetLeft < 0 ? "over" : ""}">${esc(yen(budgetLeft))}</span></div>
        <div class="row between small muted"><span>支出予算 ${esc(yen(budgetTotal))}</span><span>使用済み ${esc(yen(expTotal))}（${budgetPct}%）</span></div>
        <div class="bar" style="margin-top:8px"><i class="${budgetLeft < 0 ? "over-bar" : ""}" style="width:${budgetPct}%"></i></div>`
      : `<p class="muted">予算が設定されていません。設定タブから予算を編集できます。</p>`}
    </div>

    <div class="card">
      <div class="row between">
        <h3 style="margin:0">カテゴリー別</h3>
        <div class="seg" style="width:150px">
          <button data-act="home-kind" data-kind="expense" class="${state.home.kind === "expense" ? "on expense-on" : ""}">支出</button>
          <button data-act="home-kind" data-kind="income" class="${state.home.kind === "income" ? "on income-on" : ""}">収入</button>
        </div>
      </div>
      <div style="margin-top:6px">
      ${rows.length ? rows.map(r => {
        const pct = r.budget > 0 ? Math.min(100, Math.round(r.amount / r.budget * 100)) : 0;
        const diff = r.budget - r.amount;
        const expanded = !!state.home.expanded[r.cat.id];
        return `<div class="cat-row">
          <div class="row">
            <span class="cat-dot" style="background:${r.cat.color}"></span>
            <span class="cat-name">${esc(r.cat.name)}</span>
            ${r.children.length ? `<button class="btn small" data-act="toggle-children" data-cat="${esc(r.cat.id)}">${expanded ? "内訳を閉じる" : "内訳"} <span class="expand-mark">${expanded ? "▲" : "▼"}</span></button>` : ""}
            <span class="cat-amount">${esc(yen(r.amount))}</span>
          </div>
          ${r.budget > 0 ? `
            <div class="cat-sub"><span>予算 ${esc(yen(r.budget))}</span><span class="${diff < 0 ? "over" : ""}">${diff < 0 ? "超過 " + esc(yen(-diff)) : "残り " + esc(yen(diff))}</span></div>
            <div class="bar" style="margin-top:4px"><i class="${diff < 0 ? "over-bar" : ""}" style="width:${pct}%;background:${r.cat.color}"></i></div>` : ""}
          ${expanded ? `<div class="cat-children">
            ${r.amount - r.children.reduce((a, c) => a + c.amount, 0) !== 0 ? `<div class="cat-child"><span>${esc(r.cat.name)}（直接）</span><span>${esc(yen(r.amount - r.children.reduce((a, c) => a + c.amount, 0)))}</span></div>` : ""}
            ${r.children.map(c => `<div class="cat-child"><span>${esc(c.cat.name)}</span><span>${esc(yen(c.amount))}</span></div>`).join("")}
          </div>` : ""}
        </div>`;
      }).join("") : `<p class="empty">この月の記録はまだありません</p>`}
      </div>
    </div>

    <div class="card">
      <h3>支出のバランス</h3>
      <div class="donut-wrap">
        ${donutSVG(donutRows, 150)}
        <div class="donut-legend">
          ${donutRows.slice(0, 8).map(r => `<div class="row"><span class="cat-dot" style="background:${r.cat.color}"></span><span class="grow" style="flex:1">${esc(r.cat.name)}</span><b>${esc(yen(r.amount))}</b></div>`).join("") || `<span class="muted">支出の記録がありません</span>`}
        </div>
      </div>
    </div>

    <div class="card">
      <div class="row between">
        <h3 style="margin:0">最近の記録</h3>
        <button class="btn small" data-act="copy-fixed">固定費を前月からコピー</button>
      </div>
      <div style="margin-top:4px">
      ${recent.length ? recent.map(e => entryRowHTML(e, key)).join("") : `<p class="empty">記録がありません。下の「入力」から追加できます</p>`}
      </div>
    </div>`;

  $$("#tab-home [data-act]").forEach(btn => btn.addEventListener("click", () => {
    const act = btn.dataset.act;
    if (act === "home-prev") { state.home.month = addMonths(key, -1); renderHome(); }
    else if (act === "home-next") { state.home.month = addMonths(key, 1); renderHome(); }
    else if (act === "close-month") { ensureMonth(key).closed = true; saveData(); toast("入力完了にしました"); renderHome(); }
    else if (act === "reopen-month") { ensureMonth(key).closed = false; saveData(); renderHome(); }
    else if (act === "home-kind") { state.home.kind = btn.dataset.kind; renderHome(); }
    else if (act === "toggle-children") {
      const id = btn.dataset.cat;
      state.home.expanded[id] = !state.home.expanded[id];
      renderHome();
    }
    else if (act === "goto-assets") { switchTab("assets"); }
    else if (act === "goto-goals") { switchTab("goals"); }
    else if (act === "copy-fixed") openCopyFixed(key);
  }));
  bindEntryEditButtons($("#tab-home"));
}

/* ---------------- 固定費を前月からコピー ---------------- */
function openCopyFixed(targetKey) {
  const prevKey = addMonths(targetKey, -1);
  const prev = findMonth(prevKey);
  const target = ensureMonth(targetKey);
  const candidates = prev ? prev.entries.filter(e => e.recurring) : [];
  if (!candidates.length) {
    openModal(`<h3>固定費のコピー</h3>
      <p class="muted">${esc(monthLabel(prevKey))} に「翌月のコピー候補」の記録がありませんでした。</p>
      <button class="btn block" data-close>閉じる</button>`);
    bindModalClose();
    return;
  }
  openModal(`<h3>固定費を前月からコピー</h3>
    <p class="muted">${esc(monthLabel(prevKey))} の固定費を ${esc(monthLabel(targetKey))} に登録します。コピーする項目を選んでください。</p>
    ${candidates.map((e, i) => {
      const cat = categoryById(e.categoryId);
      const already = target.entries.some(t => t.categoryId === e.categoryId && t.amount === e.amount && t.note === e.note);
      return `<label class="check-row">
        <input type="checkbox" data-copy-idx="${i}" ${already ? "" : "checked"}>
        <span class="cat-dot" style="background:${cat ? cat.color : "#ccc"}"></span>
        <span style="flex:1">${esc(e.note || (cat ? cat.name : ""))} <span class="muted small">${cat ? esc(cat.name) : ""} ・ ${esc(e.member || "共通")}</span></span>
        <b>${esc(yen(e.amount))}</b>
        ${already ? `<span class="small muted">登録済みの可能性</span>` : ""}
      </label>`;
    }).join("")}
    <div class="row" style="margin-top:14px; gap:8px">
      <button class="btn" data-close style="flex:1">やめる</button>
      <button class="btn primary" id="copy-fixed-btn" style="flex:2">選んだ項目をコピー</button>
    </div>`);
  bindModalClose();
  $("#copy-fixed-btn").addEventListener("click", () => {
    const picked = $$("#modal-box [data-copy-idx]").filter(c => c.checked).map(c => candidates[Number(c.dataset.copyIdx)]);
    const now = new Date().toISOString();
    for (const e of picked) {
      let date = null;
      if (e.date) {
        const day = e.date.slice(8, 10);
        date = targetKey + "-" + day;
      }
      target.entries.push({
        id: uid(), date, categoryId: e.categoryId, amount: e.amount,
        member: e.member || "共通", note: e.note || "", recurring: true,
        source: "manual", createdAt: now
      });
    }
    saveData();
    closeModal();
    toast(picked.length + "件コピーしました");
    renderTab();
  });
}
function bindModalClose() {
  $$("#modal-box [data-close]").forEach(b => b.addEventListener("click", closeModal));
}

/* ---------------- 履歴タブ ---------------- */
function filteredEntries(monthObj) {
  if (!monthObj) return [];
  const h = state.history;
  return monthObj.entries.filter(e => {
    const cat = categoryById(e.categoryId);
    if (h.catId && e.categoryId !== h.catId) return false;
    if (h.kind && (!cat || cat.kind !== h.kind)) return false;
    if (h.member && (e.member || "共通") !== h.member) return false;
    if (h.accountId === "__none__" && e.accountId) return false;
    if (h.accountId && h.accountId !== "__none__" && e.accountId !== h.accountId) return false;
    return true;
  }).sort((a, b) =>
    String(b.date || "9999").localeCompare(String(a.date || "9999")) ||
    String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}
function renderHistory() {
  const key = state.history.month;
  const m = findMonth(key);
  const list = filteredEntries(m);
  const inc = list.filter(e => { const c = categoryById(e.categoryId); return c && c.kind === "income"; })
    .reduce((a, e) => a + (Number(e.amount) || 0), 0);
  const exp = list.filter(e => { const c = categoryById(e.categoryId); return c && c.kind === "expense"; })
    .reduce((a, e) => a + (Number(e.amount) || 0), 0);
  const catOptions = categories().map(c =>
    `<option value="${esc(c.id)}" ${state.history.catId === c.id ? "selected" : ""}>${esc(c.name)}${c.archived ? "（非表示）" : ""}</option>`).join("");
  /* 口座フィルター：選んだ口座が消えていたら絞り込みを解除する */
  const accs = accounts();
  if (state.history.accountId && state.history.accountId !== "__none__" &&
      !accs.some(a => a.id === state.history.accountId)) state.history.accountId = "";

  $("#tab-history").innerHTML = `
    ${monthNavHTML(key, "hist")}
    <div class="card">
      <div class="row between">
        <h3 style="margin:0">記録の一覧</h3>
        <span class="muted">${list.length}件</span>
      </div>
      <div class="filter-grid" style="margin-top:10px">
        <select id="flt-cat"><option value="">全カテゴリー</option>${catOptions}</select>
        <select id="flt-kind">
          <option value="" ${state.history.kind === "" ? "selected" : ""}>収支すべて</option>
          <option value="expense" ${state.history.kind === "expense" ? "selected" : ""}>支出</option>
          <option value="income" ${state.history.kind === "income" ? "selected" : ""}>収入</option>
        </select>
        <select id="flt-member">
          <option value="" ${state.history.member === "" ? "selected" : ""}>全員</option>
          <option value="共通" ${state.history.member === "共通" ? "selected" : ""}>共通</option>
          ${members().map(n => `<option value="${esc(n)}" ${state.history.member === n ? "selected" : ""}>${esc(n)}</option>`).join("")}
        </select>
      </div>
      ${accs.length ? `<div style="margin-top:8px">
        <select id="flt-account" style="width:100%">
          <option value="" ${state.history.accountId === "" ? "selected" : ""}>全ての口座・財布</option>
          ${accountOptionsGrouped(state.history.accountId)}
          <option value="__none__" ${state.history.accountId === "__none__" ? "selected" : ""}>口座の指定なし</option>
        </select>
      </div>` : ""}
      <div class="row between" style="margin-top:10px">
        <span class="muted small">表示中の合計</span>
        <span class="small">収入 <b class="amount-income">${esc(yen(inc))}</b> ／ 支出 <b class="amount-expense">${esc(yen(exp))}</b></span>
      </div>
      <button class="btn small block" id="hist-csv" style="margin-top:10px">この一覧をCSVでダウンロード</button>
    </div>
    <div class="card">
      ${list.length ? list.map(e => `<div class="row" style="gap:0">
          <div style="flex:1;min-width:0">${entryRowHTML(e, key)}</div>
          <button class="entry-del" data-del-entry="${esc(e.id)}" data-entry-month="${esc(key)}" title="削除">🗑</button>
        </div>`).join("")
        : `<p class="empty">条件に合う記録がありません</p>`}
    </div>`;

  $$("#tab-history [data-act]").forEach(btn => btn.addEventListener("click", () => {
    if (btn.dataset.act === "hist-prev") { state.history.month = addMonths(key, -1); renderHistory(); }
    else if (btn.dataset.act === "hist-next") { state.history.month = addMonths(key, 1); renderHistory(); }
  }));
  $("#flt-cat").addEventListener("change", (ev) => { state.history.catId = ev.target.value; renderHistory(); });
  $("#flt-kind").addEventListener("change", (ev) => { state.history.kind = ev.target.value; renderHistory(); });
  $("#flt-member").addEventListener("change", (ev) => { state.history.member = ev.target.value; renderHistory(); });
  const fltAcc = $("#flt-account");
  if (fltAcc) fltAcc.addEventListener("change", (ev) => { state.history.accountId = ev.target.value; renderHistory(); });
  $("#hist-csv").addEventListener("click", () => downloadCSV(list, key));
  bindEntryEditButtons($("#tab-history"));
  $$("#tab-history [data-del-entry]").forEach(b => b.addEventListener("click", () => {
    if (!confirm("この記録を削除しますか？")) return;
    deleteEntry(b.dataset.entryMonth, b.dataset.delEntry);
    toast("削除しました");
    renderHistory();
  }));
}

/* ---------------- 記録の編集・削除（共通） ---------------- */
function deleteEntry(monthKey, entryId) {
  const m = findMonth(monthKey);
  if (!m) return;
  const target = m.entries.find(e => e.id === entryId);
  if (target) adjustAccountBalance(target, -1); // 口座残高への反映を取り消す
  m.entries = m.entries.filter(e => e.id !== entryId);
  m.updatedAt = new Date().toISOString();
  saveData();
}
function bindEntryEditButtons(root) {
  $$("[data-edit-entry]", root).forEach(b => b.addEventListener("click", () => {
    openEntryEditor(b.dataset.entryMonth, b.dataset.editEntry);
  }));
}
/* 記録タップ → 入力タブのフォームで編集 */
function openEntryEditor(monthKey, entryId) {
  const m = findMonth(monthKey);
  const e = m ? m.entries.find(x => x.id === entryId) : null;
  if (!e) return;
  const cat = categoryById(e.categoryId);
  state.entry = {
    kind: cat ? cat.kind : "expense",
    amountStr: String(e.amount || ""),
    member: e.member || "共通",
    catId: e.categoryId,
    accountId: e.accountId || null,
    editingId: e.id,
    editingMonth: monthKey
  };
  $("#entry-date") && ($("#entry-date").value = e.date || (monthKey + "-01"));
  if (state.tab !== "entry") state.entryReturn = state.tab; // 編集後に戻る先を覚える
  switchTab("entry");
  const dateEl = $("#entry-date");
  if (dateEl) dateEl.value = e.date || "";
  const noteEl = $("#entry-note");
  if (noteEl) noteEl.value = e.note || "";
  const recEl = $("#entry-recurring");
  if (recEl) recEl.checked = !!e.recurring;
  renderEntryForm();
  toast("記録を編集中");
}

/* ---------------- 入力タブ ---------------- */
/* 編集を終えて、編集を開いたタブへ戻る（戻り先が無ければ入力タブに留まる） */
function backFromEntryEdit() {
  const dest = state.entryReturn;
  resetEntryState();
  state.entryReturn = null;
  if (dest && dest !== "entry") switchTab(dest);
  else renderEntry();
}
function renderEntry() {
  $("#tab-entry").innerHTML = `
    ${state.entry.editingId ? `<div style="margin-bottom:10px"><button class="btn small" id="entry-back">← ${state.entryReturn === "home" ? "今月" : "履歴"}へ戻る</button></div>` : ""}
    <div class="card">
      <div class="seg">
        <button data-kind="expense" class="${state.entry.kind === "expense" ? "on expense-on" : ""}">支出</button>
        <button data-kind="income" class="${state.entry.kind === "income" ? "on income-on" : ""}">収入</button>
        <button data-kind="transfer" class="${state.entry.kind === "transfer" ? "on" : ""}">振替</button>
      </div>
      <div id="entry-form-body"></div>
    </div>
    <div id="transfer-history"></div>`;
  $$("#tab-entry .seg button").forEach(b => b.addEventListener("click", () => {
    state.entry.kind = b.dataset.kind;
    state.entry.catId = null;
    renderEntry();
  }));
  const backBtn = $("#entry-back");
  if (backBtn) backBtn.addEventListener("click", backFromEntryEdit);
  if (state.entry.kind === "transfer") renderTransferForm();
  else renderEntryForm();
}
/* ---------------- 振替フォーム（入力タブ） ----------------
 * 口座・財布のあいだの移動（引き出し・電子マネーのチャージ・生活費の移動など）。
 * 収支には数えず、残高だけを移す。 */
function renderTransferForm() {
  const body = $("#entry-form-body");
  if (!body) return;
  const accs = accounts();
  const hist = $("#transfer-history");
  if (accs.length < 2) {
    body.innerHTML = `<p class="muted" style="margin-top:12px">振替には口座・財布が2つ以上必要です。資産タブで銀行口座・現金・電子マネーなどを追加してください。</p>
      <button class="btn block" id="entry-tr-goto-assets" style="margin-top:10px">資産タブで口座を追加</button>`;
    $("#entry-tr-goto-assets").addEventListener("click", () => switchTab("assets"));
    if (hist) hist.innerHTML = "";
    return;
  }
  const ts = state.transfer;
  const mainAcc = mainAccount();
  if (!ts.fromId || !accs.some(a => a.id === ts.fromId)) ts.fromId = mainAcc ? mainAcc.id : accs[0].id;
  if (!ts.toId || !accs.some(a => a.id === ts.toId) || ts.toId === ts.fromId) {
    const alt = accs.find(a => a.id !== ts.fromId);
    ts.toId = alt ? alt.id : accs[0].id;
  }
  const st = state.entry;
  const amt = st.amountStr ? Number(st.amountStr) : 0;
  body.innerHTML = `
    <div class="amount-display ${amt === 0 ? "zero" : ""}">${esc(yen(amt))}</div>
    <div class="keypad">
      ${["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "⌫"].map(k =>
        `<button data-key="${k}">${k}</button>`).join("")}
    </div>
    <div class="field">
      <label>移動元</label>
      <select id="entry-tr-from">${accountOptionsGrouped(ts.fromId)}</select>
    </div>
    <div class="field">
      <label>移動先</label>
      <select id="entry-tr-to">${accountOptionsGrouped(ts.toId)}</select>
    </div>
    <div class="field">
      <label>日付</label>
      <input type="date" id="entry-tr-date" value="${esc($("#entry-tr-date") ? $("#entry-tr-date").value : todayStr())}">
    </div>
    <div class="field">
      <label>メモ（任意）</label>
      <input type="text" id="entry-tr-note" placeholder="例：ATMで引き出し／PayPayにチャージ" value="${esc($("#entry-tr-note") ? $("#entry-tr-note").value : "")}">
    </div>
    <button class="btn primary block" id="entry-tr-save">振替を記録</button>
    <p class="muted small" style="margin-top:8px">振替は収支に数えません（口座・財布の残高だけが動きます）。</p>`;

  $$("#entry-form-body [data-key]").forEach(b => b.addEventListener("click", () => {
    const k = b.dataset.key;
    if (k === "C") st.amountStr = "";
    else if (k === "⌫") st.amountStr = st.amountStr.slice(0, -1);
    else if (st.amountStr.replace(/^0+/, "").length < 9) st.amountStr = (st.amountStr + k).replace(/^0+(?=\d)/, "");
    const disp = $("#entry-form-body .amount-display");
    const v = st.amountStr ? Number(st.amountStr) : 0;
    disp.textContent = yen(v);
    disp.classList.toggle("zero", v === 0);
  }));
  $("#entry-tr-from").addEventListener("change", (ev) => { ts.fromId = ev.target.value; });
  $("#entry-tr-to").addEventListener("change", (ev) => { ts.toId = ev.target.value; });
  $("#entry-tr-save").addEventListener("click", () => {
    const amount = st.amountStr ? Number(st.amountStr) : 0;
    if (!amount || amount <= 0) { toast("金額を入力してください"); return; }
    if (ts.fromId === ts.toId) { toast("移動元と移動先が同じです"); return; }
    const t = {
      id: uid(), date: $("#entry-tr-date").value || todayStr(),
      fromId: ts.fromId, toId: ts.toId, amount,
      note: $("#entry-tr-note").value.trim(),
      createdAt: new Date().toISOString()
    };
    transfers().push(t);
    adjustTransferBalance(t, 1);
    saveData();
    st.amountStr = "";
    toast("振替を記録しました");
    renderEntry();
    maybeApplyPendingRemote();
  });
  renderTransferHistory();
}
function renderTransferHistory() {
  const wrap = $("#transfer-history");
  if (!wrap) return;
  const recent = transfers().slice().sort((a, b) =>
    String(b.date || "").localeCompare(String(a.date || "")) ||
    String(b.createdAt || "").localeCompare(String(a.createdAt || ""))).slice(0, 10);
  wrap.innerHTML = `<div class="card">
    <h3>最近の振替</h3>
    ${recent.length ? recent.map(t => {
      const from = accountById(t.fromId), to = accountById(t.toId);
      const dateLabel = t.date ? t.date.slice(5).replace("-", "/") : "日付なし";
      return `<div class="row" style="padding:7px 0; border-bottom:1px solid var(--line)">
        <div style="flex:1; min-width:0">
          <div class="row between"><span style="font-weight:600">${esc(from ? from.name : "（削除された口座）")} → ${esc(to ? to.name : "（削除された口座）")}</span><b>${esc(yen(t.amount))}</b></div>
          <div class="muted small">${esc(dateLabel)}${t.note ? " ・ " + esc(t.note) : ""}</div>
        </div>
        <button class="entry-del" data-tr-del="${esc(t.id)}" title="削除">🗑</button>
      </div>`;
    }).join("") : `<p class="empty">振替の記録はまだありません</p>`}
  </div>`;
  $$("#transfer-history [data-tr-del]").forEach(b => b.addEventListener("click", () => {
    if (!confirm("この振替の記録を削除しますか？（残高も元に戻ります）")) return;
    const t = transfers().find(x => x.id === b.dataset.trDel);
    if (!t) return;
    adjustTransferBalance(t, -1);
    state.data.transfers = transfers().filter(x => x.id !== t.id);
    saveData();
    toast("振替の記録を削除しました");
    renderEntry();
  }));
}
function renderEntryForm() {
  const body = $("#entry-form-body");
  if (!body) return;
  const st = state.entry;
  const amt = st.amountStr ? Number(st.amountStr) : 0;
  const cats = categories().filter(c => c.kind === st.kind && (!c.archived || c.id === st.catId));
  if (!st.catId || !cats.some(c => c.id === st.catId)) st.catId = cats.length ? cats[0].id : null;
  const memberLabel = st.kind === "income" ? "収入の対象者" : "使った人";
  /* 選択中メンバーが現在のメンバー一覧にない場合（改名前の記録の編集など）も選択肢に含める */
  const memberOptions = ["共通"].concat(members());
  if (st.member && !memberOptions.includes(st.member)) memberOptions.push(st.member);
  const accs = accounts();
  /* 収入は原則メイン口座に入るので、新規の収入入力ではメイン口座を初期選択にする
   * （あとから別の口座・財布へ移すときは入力タブの「振替」で記録する） */
  const mainAcc = mainAccount();
  if (!st.editingId && st.kind === "income" && !st.accountId && mainAcc) st.accountId = mainAcc.id;
  body.innerHTML = `
    ${st.editingId ? `<p class="muted small" style="margin-top:10px">記録を編集中（${esc(monthLabel(st.editingMonth))}） <button class="btn small" id="entry-cancel-edit">編集をやめる</button></p>` : ""}
    <div class="amount-display ${amt === 0 ? "zero" : ""}">${esc(yen(amt))}</div>
    <div class="keypad">
      ${["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "⌫"].map(k =>
        `<button data-key="${k}">${k}</button>`).join("")}
    </div>
    <div class="field">
      <label>日付</label>
      <input type="date" id="entry-date" value="${esc($("#entry-date") ? $("#entry-date").value : todayStr())}">
    </div>
    <div class="field">
      <label>${memberLabel}</label>
      <select id="entry-member">
        ${memberOptions.map(n =>
          `<option value="${esc(n)}" ${st.member === n ? "selected" : ""}>${esc(n)}</option>`).join("")}
      </select>
    </div>
    <div class="field">
      <label>カテゴリー</label>
      ${cats.length ? `<select id="entry-cat">
        ${cats.map(c => `<option value="${esc(c.id)}" ${st.catId === c.id ? "selected" : ""}>${esc(c.name)}${c.archived ? "（非表示）" : ""}</option>`).join("")}
      </select>` : `<span class="muted">カテゴリーがありません（設定から追加できます）</span>`}
    </div>
    ${accs.length ? `<div class="field">
      <label>${st.kind === "income" ? "入金先の口座（任意：選ぶと残高に反映されます）" : "支出元の口座・財布（任意：選ぶと残高に反映されます）"}</label>
      <select id="entry-account">
        <option value="" ${!st.accountId ? "selected" : ""}>指定なし</option>
        ${accountOptionsGrouped(st.accountId)}
        ${st.accountId && !accs.some(a => a.id === st.accountId) ? `<option value="${esc(st.accountId)}" selected>（削除された口座）</option>` : ""}
      </select>
    </div>` : ""}
    <div class="field">
      <label>メモ（任意：お店・品目など）</label>
      <input type="text" id="entry-note" placeholder="例：スーパーで食材" value="${esc($("#entry-note") ? $("#entry-note").value : "")}">
    </div>
    <label class="check-row">
      <input type="checkbox" id="entry-recurring" ${$("#entry-recurring") && $("#entry-recurring").checked ? "checked" : ""}>
      毎月の記録として、翌月のコピー候補にする
    </label>
    <button class="btn primary block" id="entry-save" style="margin-top:12px">${st.editingId ? "更新する" : "保存する"}</button>
    ${st.editingId ? `<button class="btn danger block" id="entry-delete" style="margin-top:8px">この記録を削除</button>` : ""}`;

  $$("#entry-form-body [data-key]").forEach(b => b.addEventListener("click", () => {
    const k = b.dataset.key;
    if (k === "C") st.amountStr = "";
    else if (k === "⌫") st.amountStr = st.amountStr.slice(0, -1);
    else if (st.amountStr.replace(/^0+/, "").length < 9) st.amountStr = (st.amountStr + k).replace(/^0+(?=\d)/, "");
    const disp = $("#entry-form-body .amount-display");
    const v = st.amountStr ? Number(st.amountStr) : 0;
    disp.textContent = yen(v);
    disp.classList.toggle("zero", v === 0);
  }));
  $("#entry-member").addEventListener("change", (ev) => { st.member = ev.target.value; });
  const catSel = $("#entry-cat");
  if (catSel) catSel.addEventListener("change", (ev) => { st.catId = ev.target.value; });
  const accSel = $("#entry-account");
  if (accSel) accSel.addEventListener("change", (ev) => { st.accountId = ev.target.value || null; });
  const cancelBtn = $("#entry-cancel-edit");
  if (cancelBtn) cancelBtn.addEventListener("click", backFromEntryEdit);
  const delBtn = $("#entry-delete");
  if (delBtn) delBtn.addEventListener("click", () => {
    if (!confirm("この記録を削除しますか？")) return;
    deleteEntry(st.editingMonth, st.editingId);
    backFromEntryEdit();
    toast("削除しました");
  });
  $("#entry-save").addEventListener("click", saveEntryFromForm);
}
function resetEntryState() {
  state.entry = { kind: state.entry.kind, amountStr: "", member: "共通", catId: null, accountId: null, editingId: null, editingMonth: null };
}
function saveEntryFromForm() {
  const st = state.entry;
  const amount = st.amountStr ? Number(st.amountStr) : 0;
  if (!amount || amount <= 0) { toast("金額を入力してください"); return; }
  if (!st.catId) { toast("カテゴリーを選んでください"); return; }
  const dateVal = $("#entry-date").value || "";
  const note = $("#entry-note").value.trim();
  const recurring = $("#entry-recurring").checked;

  if (st.editingId) {
    const m = findMonth(st.editingMonth);
    const e = m ? m.entries.find(x => x.id === st.editingId) : null;
    if (e) {
      const before = { accountId: e.accountId || null, categoryId: e.categoryId, amount: e.amount };
      const newMonthKey = dateVal ? dateVal.slice(0, 7) : st.editingMonth;
      e.amount = amount; e.categoryId = st.catId; e.member = st.member;
      e.note = note; e.recurring = recurring;
      e.date = dateVal || e.date || null;
      if (st.accountId) e.accountId = st.accountId; else delete e.accountId;
      adjustAccountBalance(before, -1); // 変更前の残高への影響を取り消してから
      adjustAccountBalance(e, 1);       // 変更後の内容で反映し直す
      if (newMonthKey !== st.editingMonth) {
        m.entries = m.entries.filter(x => x.id !== e.id);
        ensureMonth(newMonthKey).entries.push(e);
      }
      m.updatedAt = new Date().toISOString();
    }
    saveData();
    backFromEntryEdit();
    toast("更新しました");
    maybeApplyPendingRemote();
    return;
  }
  const monthKey = dateVal ? dateVal.slice(0, 7) : currentMonthKey();
  const m = ensureMonth(monthKey);
  const newEntry = {
    id: uid(),
    date: dateVal || null,
    categoryId: st.catId,
    amount,
    member: st.member,
    note,
    recurring,
    source: "manual",
    createdAt: new Date().toISOString()
  };
  if (st.accountId) newEntry.accountId = st.accountId;
  m.entries.push(newEntry);
  adjustAccountBalance(newEntry, 1);
  m.updatedAt = new Date().toISOString();
  saveData();
  /* 登録後はプルダウン類を先頭に戻す（金額・メモ・固定費チェックもクリア）。
   * 日付は連続して入力する都合でそのまま残す。収入の入金先は renderEntryForm が
   * メイン口座を初期選択し直す（「収入はメイン口座に入る」ルール） */
  const n2 = $("#entry-note"); if (n2) n2.value = "";
  const r2 = $("#entry-recurring"); if (r2) r2.checked = false;
  resetEntryState(); // kind は維持。member=共通 / catId=null（=先頭のカテゴリー）/ accountId=null
  renderEntryForm();
  maybeApplyPendingRemote();
  toast(monthLabel(monthKey) + "に保存しました");
}

/* ---------------- 比較タブ ---------------- */
function barChartSVG(items, w, h) {
  /* items: [{label, income, expense, status}] */
  const max = Math.max(1, ...items.flatMap(i => [i.income, i.expense]));
  const padB = 34, padT = 14;
  const chartH = h - padB - padT;
  const groupW = w / items.length;
  const barW = Math.min(22, groupW / 2 - 8);
  let s = "";
  items.forEach((it, i) => {
    const gx = i * groupW + groupW / 2;
    const ih = (it.income / max) * chartH, eh = (it.expense / max) * chartH;
    s += `<rect x="${gx - barW - 3}" y="${padT + chartH - ih}" width="${barW}" height="${ih}" rx="3" fill="#4f7867"/>`;
    s += `<rect x="${gx + 3}" y="${padT + chartH - eh}" width="${barW}" height="${eh}" rx="3" fill="#b0603f"/>`;
    s += `<text x="${gx}" y="${h - 18}" text-anchor="middle" font-size="11" fill="#33302b">${esc(it.label)}</text>`;
    s += `<text x="${gx}" y="${h - 4}" text-anchor="middle" font-size="9" fill="#8a8378">${esc(statusLabel(it.status))}</text>`;
  });
  s += `<line x1="0" y1="${padT + chartH}" x2="${w}" y2="${padT + chartH}" stroke="#e9e2d8"/>`;
  return `<svg width="100%" viewBox="0 0 ${w} ${h}">${s}</svg>
    <div class="row" style="gap:14px; font-size:12px">
      <span><span class="cat-dot" style="background:#4f7867; display:inline-block"></span> 収入</span>
      <span><span class="cat-dot" style="background:#b0603f; display:inline-block"></span> 支出</span>
      <span class="muted">最大 ${esc(yen(max))}</span>
    </div>`;
}
function renderCompare() {
  const base = state.compare.baseMonth;
  const against = state.compare.againstMonth;
  const keys = [];
  for (let i = 5; i >= 0; i--) keys.push(addMonths(base, -i));
  const items = keys.map(k => {
    const m = findMonth(k);
    return { label: (Number(k.split("-")[1])) + "月", income: totalOf(m, "income"), expense: totalOf(m, "expense"), status: monthStatus(k) };
  });
  const baseM = findMonth(base), agM = findMonth(against);
  const kind = state.compare.kind;
  const baseSums = sumByCategory(baseM, kind);
  const agSums = sumByCategory(agM, kind);
  const catIds = new Set([...Object.keys(baseSums), ...Object.keys(agSums)]);
  const cmpRows = Array.from(catIds).map(id => {
    const cat = categoryById(id);
    const b = baseSums[id] || 0, a = agSums[id] || 0;
    const diff = b - a;
    const pct = a !== 0 ? Math.round(diff / Math.abs(a) * 100) : null;
    return { cat, b, a, diff, pct };
  }).filter(r => r.cat && (r.b !== 0 || r.a !== 0)).sort((x, y) => y.b - x.b);
  const monthOptions = (sel) => {
    const all = new Set(state.data.months.map(m => m.month));
    all.add(currentMonthKey()); all.add(base); all.add(against);
    return Array.from(all).sort().map(k =>
      `<option value="${k}" ${k === sel ? "selected" : ""}>${esc(monthLabel(k))}（${statusLabel(monthStatus(k))}）</option>`).join("");
  };

  $("#tab-compare").innerHTML = `
    ${monthNavHTML(base, "cmp")}
    <div class="card">
      <h3>直近6か月の推移</h3>
      ${barChartSVG(items, 340, 190)}
      <p class="muted small" style="margin-top:8px">※ 未確定の月の差額は、まだ記録が途中です。節約額と区別して見てください。</p>
    </div>
    <div class="card">
      <div class="row between">
        <h3 style="margin:0">カテゴリーごとの比較</h3>
        <div class="seg" style="width:150px">
          <button data-act="cmp-kind" data-kind="expense" class="${kind === "expense" ? "on expense-on" : ""}">支出</button>
          <button data-act="cmp-kind" data-kind="income" class="${kind === "income" ? "on income-on" : ""}">収入</button>
        </div>
      </div>
      <div class="field" style="margin-top:10px">
        <label>比較する月（この月と比べる）</label>
        <select id="cmp-against">${monthOptions(against)}</select>
      </div>
      <div class="row small muted" style="padding:4px 0">
        <span style="flex:1">カテゴリー</span><span style="width:86px; text-align:right">${esc(monthLabel(base).slice(5))}</span>
        <span style="width:86px; text-align:right">増減</span>
      </div>
      ${cmpRows.length ? cmpRows.map(r => `
        <div class="cat-row">
          <div class="row">
            <span class="cat-dot" style="background:${r.cat.color}"></span>
            <span class="cat-name">${esc(r.cat.name)}</span>
            <span class="cat-amount">${esc(yen(r.b))}</span>
          </div>
          <div class="cat-sub">
            <span>${esc(monthLabel(against).slice(5))}は ${esc(yen(r.a))}</span>
            <span class="${r.diff > 0 ? (kind === "expense" ? "over" : "amount-income") : ""}">${r.diff > 0 ? "+" : ""}${esc(yen(r.diff))}${r.pct !== null ? `（${r.diff > 0 ? "+" : ""}${r.pct}%）` : ""}</span>
          </div>
        </div>`).join("") : `<p class="empty">比較できる記録がありません</p>`}
    </div>`;

  $$("#tab-compare [data-act]").forEach(btn => btn.addEventListener("click", () => {
    if (btn.dataset.act === "cmp-prev") { state.compare.baseMonth = addMonths(base, -1); renderCompare(); }
    else if (btn.dataset.act === "cmp-next") { state.compare.baseMonth = addMonths(base, 1); renderCompare(); }
    else if (btn.dataset.act === "cmp-kind") { state.compare.kind = btn.dataset.kind; renderCompare(); }
  }));
  $("#cmp-against").addEventListener("change", (ev) => { state.compare.againstMonth = ev.target.value; renderCompare(); });
}

/* ---------------- エクスポート / インポート ---------------- */
function exportableData() {
  const copy = JSON.parse(JSON.stringify(state.data));
  delete copy.auth; // パスワードハッシュは書き出しに含めない
  copy.exportedAt = new Date().toISOString();
  return copy;
}
function downloadFile(name, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}
function entriesToCSV(list, monthKeyFor) {
  const head = ["月", "日付", "収支", "カテゴリー", "人", "メモ", "金額", "固定費"];
  const q = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  const lines = [head.map(q).join(",")];
  for (const e of list) {
    const cat = categoryById(e.categoryId);
    lines.push([
      monthKeyFor(e), e.date || "", cat ? (cat.kind === "income" ? "収入" : "支出") : "",
      cat ? cat.name : "", e.member || "共通", e.note || "", e.amount || 0, e.recurring ? "○" : ""
    ].map(q).join(","));
  }
  return "﻿" + lines.join("\r\n");
}
function downloadCSV(list, monthKey) {
  const csv = entriesToCSV(list, () => monthKey);
  downloadFile(`kakeibo-${monthKey}.csv`, csv, "text/csv");
}
/* インポートJSONの検証と正規化（Nodeテストからも検証する純粋関数） */
function parseImportJSON(text) {
  let obj;
  try { obj = JSON.parse(text); } catch (e) { return { ok: false, error: "JSONとして読み込めませんでした" }; }
  if (!obj || obj.format !== "futari-kakeibo") return { ok: false, error: "ふたりの家計簿のバックアップ形式ではありません" };
  if (!obj.settings || !Array.isArray(obj.settings.categories)) return { ok: false, error: "カテゴリー情報が見つかりません" };
  if (!Array.isArray(obj.months)) return { ok: false, error: "月次データが見つかりません" };
  const data = normalizeData(obj);
  const stats = {
    months: data.months.length,
    categories: data.settings.categories.length,
    entries: data.months.reduce((a, m) => a + (m.entries ? m.entries.length : 0), 0)
  };
  return { ok: true, data, stats };
}
function normalizeData(data) {
  const d = data;
  delete d.auth; // パスワードハッシュは Auth 管理に移行したため、データ側では保持しない
  d.settings = d.settings || {};
  d.settings.members = Array.isArray(d.settings.members) && d.settings.members.length ? d.settings.members : ["健人", "知尋"];
  d.settings.categories = d.settings.categories || [];
  d.settings.keywords = d.settings.keywords || {};
  d.months = (d.months || []).map(m => Object.assign(
    { budgets: {}, groups: {}, entries: [], closed: false, incomeComplete: false, imported: false }, m));
  d.months.sort((a, b) => a.month < b.month ? -1 : 1);
  /* 口座（資産）：無いデータでは空配列にし、壊れた要素は落とす */
  d.accounts = (Array.isArray(d.accounts) ? d.accounts : [])
    .filter(a => a && a.id && a.name)
    .map(a => ({
      id: String(a.id), name: String(a.name),
      balance: Number(a.balance) || 0, updatedAt: a.updatedAt || null,
      isMain: !!a.isMain,
      type: ["bank", "cash", "emoney", "prepaid"].includes(a.type) ? a.type : "bank"
    }));
  /* メイン口座は最大1つ（複数あれば先頭だけ残す） */
  let mainSeen = false;
  for (const a of d.accounts) {
    if (a.isMain) {
      if (mainSeen) a.isMain = false;
      else mainSeen = true;
    }
  }
  /* 口座間の移動（振替）：無いデータでは空配列にし、壊れた要素は落とす */
  d.transfers = (Array.isArray(d.transfers) ? d.transfers : [])
    .filter(t => t && t.id && t.fromId && t.toId && t.fromId !== t.toId && (Number(t.amount) || 0) > 0)
    .map(t => ({
      id: String(t.id), date: t.date || null,
      fromId: String(t.fromId), toId: String(t.toId),
      amount: Number(t.amount) || 0, note: String(t.note || ""),
      createdAt: t.createdAt || null
    }));
  /* 貯金目標・借金：無いデータでは空配列にし、壊れた要素は落とす。金額は0以上の整数に丸める */
  d.goals = (Array.isArray(d.goals) ? d.goals : [])
    .filter(g => g && g.id && String(g.name || "").trim())
    .map(g => ({
      id: String(g.id), name: String(g.name),
      kind: g.kind === "debt" ? "debt" : "save",
      target: Math.max(0, Math.round(Number(g.target) || 0)),
      saved: Math.max(0, Math.round(Number(g.saved) || 0)),
      createdAt: g.createdAt || null
    }));
  /* 集計設定（pendingGroups）がなければ、最新の月のgroupsを現在の設定として引き継ぐ */
  if (!d.settings.pendingGroups) {
    const latest = d.months.length ? d.months[d.months.length - 1] : null;
    d.settings.pendingGroups = latest ? Object.assign({}, latest.groups || {}) : {};
  }
  return d;
}
function importFromFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const res = parseImportJSON(String(reader.result || ""));
    if (!res.ok) { alert("読み込めませんでした：" + res.error); return; }
    const msg = `バックアップを取り込みますか？\n（${res.stats.months}か月・記録${res.stats.entries}件・カテゴリー${res.stats.categories}件）\n今のデータは置き換えられます（ログイン中は同期先にも反映されます）。`;
    if (!confirm(msg)) return;
    state.data = res.data; // 取り込みJSONにパスワード情報が含まれていても無視する（Authで管理）
    saveData();
    toast("バックアップを取り込みました");
    state.home.month = currentMonthKey();
    state.history.month = currentMonthKey();
    renderTab();
  };
  reader.readAsText(file);
}

/* ---------------- 資産タブ（口座・残高の手動管理） ---------------- */
/* ---------------- 貯金目標・借金タブ ----------------
 * 目標（kind: "save"）と借金（kind: "debt"）を同じ仕組みで管理する。
 *   save: target=目標金額、saved=いま確保している金額（口座残高の取り分け目安）
 *   debt: target=借入総額、saved=返済済みの金額
 * どちらも進捗率 = saved / target。ここでの金額操作は口座残高そのものを
 * 変えない（実際の入出金は収支の記録や「振替」で別に記録する）。 */
const GOAL_KIND_LABELS = {
  save: { icon: "🎯", add: "貯める", sub: "取り崩す", done: "達成🎉",
          totalLabel: "目標金額", savedLabel: "いま貯まっている金額", restWord: "あと",
          nameLabel: "目標の名前", addToast: "貯金に加えました", subToast: "取り崩しました" },
  debt: { icon: "💳", add: "返済する", sub: "返済を戻す", done: "完済🎉",
          totalLabel: "借入総額", savedLabel: "返済済みの金額", restWord: "残り",
          nameLabel: "借金の名前", addToast: "返済を記録しました", subToast: "返済を戻しました" }
};
function goalsOfKind(kind) { return goals().filter(g => (g.kind || "save") === kind); }
/* 借金の残り合計（返済済みが総額を超えた分は0止め） */
function debtRemaining() {
  const debts = goalsOfKind("debt");
  const total = debts.reduce((s, g) => s + (Number(g.target) || 0), 0);
  const paid = debts.reduce((s, g) => s + (Number(g.saved) || 0), 0);
  return Math.max(0, total - paid);
}
function goalRowHTML(g) {
  const L = GOAL_KIND_LABELS[g.kind || "save"];
  const pct = goalProgress(g);
  const target = Number(g.target) || 0, saved = Number(g.saved) || 0;
  const done = target > 0 && saved >= target;
  return `<div class="account-row">
    <div class="row between">
      <span class="cat-name">${L.icon} ${esc(g.name)}${done ? ` <span class="badge closed">${L.done}</span>` : ""}</span>
      <span class="cat-amount">${pct}%</span>
    </div>
    <div class="bar" style="margin-top:6px"><i style="width:${pct}%"></i></div>
    <div class="row between" style="margin-top:4px">
      <span class="muted small">${esc(yen(saved))} ／ ${esc(yen(target))}（${L.restWord} ${esc(yen(Math.max(0, target - saved)))}）</span>
      <span class="row">
        <button class="btn small" data-goal-add="${esc(g.id)}">${L.add}</button>
        <button class="btn small" data-goal-edit="${esc(g.id)}">編集</button>
      </span>
    </div>
  </div>`;
}
function renderGoals() {
  const saves = goalsOfKind("save"), debts = goalsOfKind("debt");
  const sum = (list, k) => list.reduce((s, g) => s + (Number(g[k]) || 0), 0);
  $("#tab-goals").innerHTML = `
    <div class="card">
      <h3>🎯 貯金目標</h3>
      <div class="row between"><span class="muted">貯めた合計</span><span class="big-amount">${esc(yen(sum(saves, "saved")))}</span></div>
      <div class="row between" style="margin-top:2px"><span class="muted">目標の合計</span><span>${esc(yen(sum(saves, "target")))}</span></div>
      <p class="muted small" style="margin-top:8px">目標ごとに「いま貯まっている金額」を管理します。ここの金額は口座残高の中での取り分け（目安）で、口座の残高そのものは変わりません。実際に別口座へお金を移すときは、入力タブの「振替」で記録してください。</p>
      <div style="margin-top:6px">
      ${saves.length ? saves.map(goalRowHTML).join("") : `<p class="empty">目標がまだありません。下から追加できます</p>`}
      </div>
    </div>
    <div class="card">
      <h3>目標を追加</h3>
      <div class="field">
        <label>目標の名前</label>
        <input type="text" id="new-goal-name" placeholder="例：旅行資金">
      </div>
      <div class="field">
        <label>目標金額（円）</label>
        <input type="number" id="new-goal-target" inputmode="numeric" placeholder="0">
      </div>
      <div class="field">
        <label>いま貯まっている金額（円）</label>
        <input type="number" id="new-goal-saved" inputmode="numeric" placeholder="0">
      </div>
      <button class="btn primary block" id="add-goal">目標を追加</button>
    </div>
    <div class="card">
      <h3>💳 借金</h3>
      <div class="row between"><span class="muted">残りの借金</span><span class="big-amount amount-expense">${esc(yen(debtRemaining()))}</span></div>
      <div class="row between" style="margin-top:2px"><span class="muted">借入総額</span><span>${esc(yen(sum(debts, "target")))}</span></div>
      <div class="row between" style="margin-top:2px"><span class="muted">返済済み</span><span>${esc(yen(sum(debts, "saved")))}</span></div>
      <p class="muted small" style="margin-top:8px">借金ごとに返済の進み具合を管理します。ここでは進捗だけを記録し、口座残高は変わりません。実際の返済は支出として記録してください。</p>
      <div style="margin-top:6px">
      ${debts.length ? debts.map(goalRowHTML).join("") : `<p class="empty">借金がまだありません。下から追加できます</p>`}
      </div>
    </div>
    <div class="card">
      <h3>借金を追加</h3>
      <div class="field">
        <label>借金の名前</label>
        <input type="text" id="new-debt-name" placeholder="例：住宅ローン">
      </div>
      <div class="field">
        <label>借入総額（円）</label>
        <input type="number" id="new-debt-target" inputmode="numeric" placeholder="0">
      </div>
      <div class="field">
        <label>すでに返済した金額（円）</label>
        <input type="number" id="new-debt-saved" inputmode="numeric" placeholder="0">
      </div>
      <button class="btn primary block" id="add-debt">借金を追加</button>
    </div>`;

  $("#add-goal").addEventListener("click", () => {
    const name = $("#new-goal-name").value.trim();
    if (!name) { toast("目標の名前を入力してください"); return; }
    goals().push({ id: uid(), kind: "save", name,
      target: Math.max(0, Math.round(Number($("#new-goal-target").value) || 0)),
      saved: Math.max(0, Math.round(Number($("#new-goal-saved").value) || 0)),
      createdAt: new Date().toISOString() });
    saveData();
    toast("目標を追加しました");
    renderGoals();
  });
  $("#add-debt").addEventListener("click", () => {
    const name = $("#new-debt-name").value.trim();
    if (!name) { toast("借金の名前を入力してください"); return; }
    goals().push({ id: uid(), kind: "debt", name,
      target: Math.max(0, Math.round(Number($("#new-debt-target").value) || 0)),
      saved: Math.max(0, Math.round(Number($("#new-debt-saved").value) || 0)),
      createdAt: new Date().toISOString() });
    saveData();
    toast("借金を追加しました");
    renderGoals();
  });
  $$("#tab-goals [data-goal-add]").forEach(b => b.addEventListener("click", () => {
    const g = goalById(b.dataset.goalAdd);
    if (g) openGoalSaveModal(g);
  }));
  $$("#tab-goals [data-goal-edit]").forEach(b => b.addEventListener("click", () => {
    const g = goalById(b.dataset.goalEdit);
    if (g) openGoalEditModal(g);
  }));
}
/* 目標へ貯める／借金を返済するモーダル（saved の増減だけ。口座残高は変えない） */
function openGoalSaveModal(goal) {
  const L = GOAL_KIND_LABELS[goal.kind || "save"];
  const rest = Math.max(0, (Number(goal.target) || 0) - (Number(goal.saved) || 0));
  openModal(`
    <h3>${L.icon} ${esc(goal.name)}</h3>
    <p class="muted small">${goal.kind === "debt"
      ? `返済済み ${esc(yen(goal.saved))} ／ 総額 ${esc(yen(goal.target))}（残り ${esc(yen(rest))}・${goalProgress(goal)}%）`
      : `現在 ${esc(yen(goal.saved))} ／ 目標 ${esc(yen(goal.target))}（${goalProgress(goal)}%）`}</p>
    <div class="field">
      <label>金額（円）</label>
      <input type="number" id="goal-amt" inputmode="numeric" placeholder="0">
    </div>
    <div class="row" style="gap:8px">
      <button class="btn" id="goal-sub" style="flex:1">${L.sub}</button>
      <button class="btn primary" id="goal-add" style="flex:2">${L.add}</button>
    </div>
    <button class="btn block" data-close style="margin-top:10px">やめる</button>`);
  $$("#modal-box [data-close]").forEach(b => b.addEventListener("click", closeModal));
  const readAmt = () => Math.round(Number($("#goal-amt").value) || 0);
  $("#goal-add").addEventListener("click", () => {
    const amt = readAmt();
    if (!amt || amt <= 0) { toast("金額を入力してください"); return; }
    goal.saved = (Number(goal.saved) || 0) + amt;
    saveData();
    closeModal();
    toast(L.addToast);
    renderTab();
  });
  $("#goal-sub").addEventListener("click", () => {
    const amt = readAmt();
    if (!amt || amt <= 0) { toast("金額を入力してください"); return; }
    goal.saved = Math.max(0, (Number(goal.saved) || 0) - amt);
    saveData();
    closeModal();
    toast(L.subToast);
    renderTab();
  });
}
/* 目標・借金の編集モーダル（種類の切り替え、名前・総額・進んだ金額の直接修正と削除） */
function openGoalEditModal(goal) {
  const L = GOAL_KIND_LABELS[goal.kind || "save"];
  openModal(`
    <h3>${L.icon} 編集</h3>
    <div class="field">
      <label>種類</label>
      <select id="goal-kind-input">
        <option value="save" ${(goal.kind || "save") === "save" ? "selected" : ""}>🎯 貯金目標</option>
        <option value="debt" ${goal.kind === "debt" ? "selected" : ""}>💳 借金</option>
      </select>
    </div>
    <div class="field">
      <label id="goal-name-label">${L.nameLabel}</label>
      <input type="text" id="goal-name-input" value="${esc(goal.name)}">
    </div>
    <div class="field">
      <label id="goal-target-label">${L.totalLabel}（円）</label>
      <input type="number" id="goal-target-input" inputmode="numeric" value="${esc(goal.target)}">
    </div>
    <div class="field">
      <label id="goal-saved-label">${L.savedLabel}（円）</label>
      <input type="number" id="goal-saved-input" inputmode="numeric" value="${esc(goal.saved)}">
    </div>
    <div class="row" style="gap:8px">
      <button class="btn" data-close style="flex:1">やめる</button>
      <button class="btn primary" id="goal-save" style="flex:2">保存</button>
    </div>
    <button class="btn danger block" id="goal-del" style="margin-top:14px">この項目を削除する</button>`);
  $$("#modal-box [data-close]").forEach(b => b.addEventListener("click", closeModal));
  $("#goal-kind-input").addEventListener("change", (ev) => {
    const nl = GOAL_KIND_LABELS[ev.target.value];
    $("#goal-name-label").textContent = nl.nameLabel;
    $("#goal-target-label").textContent = nl.totalLabel + "（円）";
    $("#goal-saved-label").textContent = nl.savedLabel + "（円）";
  });
  $("#goal-save").addEventListener("click", () => {
    const name = $("#goal-name-input").value.trim();
    if (!name) { toast("名前を入力してください"); return; }
    goal.kind = $("#goal-kind-input").value;
    goal.name = name;
    goal.target = Math.max(0, Math.round(Number($("#goal-target-input").value) || 0));
    goal.saved = Math.max(0, Math.round(Number($("#goal-saved-input").value) || 0));
    saveData();
    closeModal();
    toast("保存しました");
    renderTab();
  });
  $("#goal-del").addEventListener("click", () => {
    if (!confirm(`「${goal.name}」を削除しますか？`)) return;
    state.data.goals = goals().filter(g => g.id !== goal.id);
    saveData();
    closeModal();
    toast("削除しました");
    renderTab();
  });
}

function renderAssets() {
  const accs = accounts();
  const total = accs.reduce((a, x) => a + (Number(x.balance) || 0), 0);
  const accountRow = (a) => `
        <div class="account-row">
          <div class="row between">
            <span class="cat-name">🏦 ${esc(a.name)}${a.isMain ? ` <span class="badge closed">⭐メイン</span>` : ""}</span>
            <span class="cat-amount">${esc(yen(a.balance))}</span>
          </div>
          <div class="row between" style="margin-top:4px">
            <span class="muted small">${a.updatedAt ? "更新 " + esc(String(a.updatedAt).slice(0, 10).replace(/-/g, "/")) : ""}</span>
            <span class="row">
              <button class="btn small" data-acc-balance="${esc(a.id)}">残高を更新</button>
              <button class="btn small" data-acc-edit="${esc(a.id)}">編集</button>
            </span>
          </div>
        </div>`;
  $("#tab-assets").innerHTML = `
    <div class="card">
      <h3>口座の残高</h3>
      <div class="row between"><span class="muted">合計</span><span class="big-amount">${esc(yen(total))}</span></div>
      <p class="muted small" style="margin-top:8px">銀行口座との自動連携はできないため、残高はここで手動管理します。支出・収入の入力で口座を選ぶと、その口座の残高が自動で増減します。実際の残高とズレたときは「残高を更新」で合わせてください。口座間の移動（振替）の入力は「入力」タブからできます。</p>
    </div>
    <div class="card">
      <h3>口座の一覧</h3>
      ${accs.length ? ACCOUNT_TYPES.map(t => {
        const list = accs.filter(a => (a.type || "bank") === t.id);
        if (!list.length) return "";
        const subtotal = list.reduce((s, a) => s + (Number(a.balance) || 0), 0);
        return `<div class="row between" style="margin-top:8px"><span style="font-weight:700">${t.label}</span><span class="muted small">小計 ${esc(yen(subtotal))}</span></div>` +
          list.map(accountRow).join("");
      }).join("") : `<p class="empty">口座がまだありません。下から追加できます</p>`}
    </div>
    <div class="card">
      <h3>口座を追加</h3>
      <div class="field">
        <label>口座名</label>
        <input type="text" id="new-acc-name" placeholder="例：ゆうちょ銀行／PayPay">
      </div>
      <div class="field">
        <label>種別</label>
        <select id="new-acc-type">
          ${ACCOUNT_TYPES.map(t => `<option value="${t.id}">${t.label}</option>`).join("")}
        </select>
      </div>
      <div class="field">
        <label>今の残高（円）</label>
        <input type="number" id="new-acc-balance" inputmode="numeric" placeholder="0">
      </div>
      <button class="btn primary block" id="add-account">口座を追加</button>
    </div>`;

  $$("#tab-assets [data-acc-balance]").forEach(b => b.addEventListener("click", () => {
    const acc = accountById(b.dataset.accBalance);
    if (acc) openAccountBalanceModal(acc);
  }));
  $$("#tab-assets [data-acc-edit]").forEach(b => b.addEventListener("click", () => {
    const acc = accountById(b.dataset.accEdit);
    if (acc) openAccountEditModal(acc);
  }));
  $("#add-account").addEventListener("click", () => {
    const name = $("#new-acc-name").value.trim();
    if (!name) { toast("口座名を入力してください"); return; }
    const bal = Number($("#new-acc-balance").value) || 0;
    const type = $("#new-acc-type").value;
    accounts().push({ id: uid(), name, balance: Math.round(bal), updatedAt: new Date().toISOString(), isMain: false, type });
    saveData();
    toast("口座を追加しました");
    renderAssets();
  });
}
/* 残高を実際の金額に合わせるモーダル */
function openAccountBalanceModal(acc) {
  openModal(`<h3>残高を更新</h3>
    <p class="muted">🏦 ${esc(acc.name)} の実際の残高を入力してください（今の表示は ${esc(yen(acc.balance))}）。</p>
    <div class="field">
      <label>残高（円）</label>
      <input type="number" id="acc-balance-input" inputmode="numeric" value="${Number(acc.balance) || 0}">
    </div>
    <div class="row" style="gap:8px">
      <button class="btn" data-close style="flex:1">やめる</button>
      <button class="btn primary" id="acc-balance-save" style="flex:2">この残高にする</button>
    </div>`);
  bindModalClose();
  $("#acc-balance-save").addEventListener("click", () => {
    const v = Number($("#acc-balance-input").value);
    if (!isFinite(v)) { toast("金額を入力してください"); return; }
    acc.balance = Math.round(v);
    acc.updatedAt = new Date().toISOString();
    saveData();
    closeModal();
    toast("残高を更新しました");
    renderAssets();
  });
}
/* 口座名の編集と削除のモーダル */
function openAccountEditModal(acc) {
  openModal(`<h3>口座を編集</h3>
    <div class="field">
      <label>口座名</label>
      <input type="text" id="acc-name-input" value="${esc(acc.name)}">
    </div>
    <div class="field">
      <label>種別</label>
      <select id="acc-type-input">
        ${ACCOUNT_TYPES.map(t => `<option value="${t.id}" ${(acc.type || "bank") === t.id ? "selected" : ""}>${t.label}</option>`).join("")}
      </select>
    </div>
    <div class="row" style="gap:8px">
      <button class="btn" data-close style="flex:1">やめる</button>
      <button class="btn primary" id="acc-name-save" style="flex:2">保存</button>
    </div>
    ${acc.isMain
      ? `<p class="muted small" style="margin-top:14px">⭐ この口座がメイン口座です（収入入力のとき、入金先として最初に選ばれます）。</p>`
      : `<button class="btn block" id="acc-set-main" style="margin-top:14px">⭐ メイン口座にする（収入の入金先）</button>`}
    <button class="btn danger block" id="acc-delete" style="margin-top:16px">この口座を削除</button>
    <p class="muted small">口座を削除しても過去の記録は消えません（記録に付いていた口座の表示だけ外れます）。</p>`);
  bindModalClose();
  $("#acc-name-save").addEventListener("click", () => {
    const name = $("#acc-name-input").value.trim();
    if (!name) { toast("口座名を入力してください"); return; }
    acc.name = name;
    acc.type = $("#acc-type-input").value;
    saveData();
    closeModal();
    toast("口座を保存しました");
    renderAssets();
  });
  const mainBtn = $("#acc-set-main");
  if (mainBtn) mainBtn.addEventListener("click", () => {
    for (const a of accounts()) a.isMain = a.id === acc.id;
    saveData();
    closeModal();
    toast("メイン口座にしました");
    renderAssets();
  });
  $("#acc-delete").addEventListener("click", () => {
    if (!confirm("口座「" + acc.name + "」を削除しますか？（過去の記録は消えません）")) return;
    state.data.accounts = accounts().filter(a => a.id !== acc.id);
    saveData();
    closeModal();
    toast("口座を削除しました");
    renderAssets();
  });
}

/* ---------------- 設定タブ ---------------- */
function renderSettings() {
  const key = state.settings.month;
  const m = findMonth(key);
  const expenseCats = categories().filter(c => c.kind === "expense");
  const COLOR_PALETTE = ["#4f7867", "#b88359", "#7796a4", "#aa8d9b", "#a29a6a", "#6f8d8a", "#bd7865", "#84996c"];
  const parentOptions = (cat, selectedParent) => {
    const parents = categories().filter(p => p.kind === cat.kind && p.id !== cat.id);
    return `<option value="">独立（集計しない）</option>` + parents.map(p =>
      `<option value="${esc(p.id)}" ${selectedParent === p.id ? "selected" : ""}>${esc(p.name)} に集計</option>`).join("");
  };
  const catRow = (c) => {
    const parent = (state.data.settings.pendingGroups || {})[c.id] || "";
    return `<div class="cat-set-row" data-cat-row="${esc(c.id)}">
      <div class="row">
        <span class="cat-dot" style="background:${c.color}"></span>
        <input type="text" class="grow" data-f="name" value="${esc(c.name)}">
        <label class="switch" title="表示ON/OFF"><input type="checkbox" data-f="visible" ${c.archived ? "" : "checked"}><i></i></label>
      </div>
      <div class="row" style="margin-top:6px">
        <span class="muted small" style="flex:none">集計先</span>
        <select data-f="parent" class="grow" title="集計先（新しい月から反映）">${parentOptions(c, parent)}</select>
      </div>
    </div>`;
  };

  $("#tab-settings").innerHTML = `
    <div class="card">
      <h3>今月の予算を編集</h3>
      ${monthNavHTML(key, "set")}
      <p class="muted small">予算は月ごとに保存されます。新しい月は、直近の月の予算を自動で引き継ぎます。</p>
      ${expenseCats.map(c => `
        <div class="set-row">
          <span class="cat-dot" style="background:${c.color}"></span>
          <span class="grow">${esc(c.name)}${c.archived ? ` <span class="muted small">（非表示）</span>` : ""}</span>
          <input type="number" class="budget-input" data-budget="${esc(c.id)}" inputmode="numeric"
            value="${m && m.budgets && m.budgets[c.id] ? m.budgets[c.id] : ""}" placeholder="0">
        </div>`).join("")}
      <button class="btn primary block" id="save-budgets" style="margin-top:12px">${esc(monthLabel(key))}の予算を保存</button>
    </div>

    <div class="card">
      <h3>カテゴリーの設定</h3>
      <p class="muted small">名前の変更・表示ON/OFFはすぐ反映されます。集計先の変更は<strong>新しく作られる月から</strong>反映され、既存の月の集計は変わりません。</p>
      <p class="muted small" style="margin-bottom:2px">支出カテゴリー</p>
      ${categories().filter(c => c.kind === "expense").map(catRow).join("")}
      <p class="muted small" style="margin:10px 0 2px">収入カテゴリー</p>
      ${categories().filter(c => c.kind === "income").map(catRow).join("")}
      <button class="btn primary block" id="save-categories" style="margin-top:12px">カテゴリー設定を保存</button>
      <div style="border-top:1px solid var(--line); margin-top:14px; padding-top:12px">
        <div class="field">
          <label>新しいカテゴリー名</label>
          <input type="text" id="new-cat-name" placeholder="例：サブスク">
        </div>
        <div class="filter-grid" style="grid-template-columns:1fr 1fr">
          <select id="new-cat-kind"><option value="expense">支出</option><option value="income">収入</option></select>
          <select id="new-cat-parent"><option value="">集計先：独立</option></select>
        </div>
        <button class="btn block" id="add-category" style="margin-top:10px">カテゴリーを追加</button>
      </div>
    </div>

    <div class="card">
      <h3>家族の設定</h3>
      ${members().map((n, i) => `
        <div class="set-row"><span class="muted">メンバー${i + 1}</span>
          <input type="text" class="grow" data-member-idx="${i}" value="${esc(n)}"></div>`).join("")}
      <button class="btn block" id="save-members" style="margin-top:10px">表示名を保存</button>
      <p class="muted small">※ 表示名は今後の表示に使われます。過去の記録に残っている名前はそのままです。</p>
    </div>

    <div class="card">
      <h3>バックアップ／復元</h3>
      <button class="btn block" id="export-json">すべてのデータを保存（JSON）</button>
      <button class="btn block" id="export-csv" style="margin-top:8px">記録をCSVで書き出す（全期間）</button>
      <button class="btn block" id="import-json" style="margin-top:8px">バックアップ（JSON）から復元</button>
      <p class="muted small">JSONには全期間の記録・予算・カテゴリーが含まれます。切り替え直前には、現行アプリから最新のJSONを書き出して取り込んでください。</p>
    </div>

    <div class="card">
      <h3>パスワード</h3>
      <p class="muted small">家族パスワードはFirebaseで管理しています（6文字以上）。変更すると、ふたりの端末に効きます。</p>
      <div class="field"><input type="password" id="pass-new1" placeholder="新しいパスワード" autocomplete="new-password"></div>
      <div class="field"><input type="password" id="pass-new2" placeholder="新しいパスワード（確認）" autocomplete="new-password"></div>
      <button class="btn block" id="change-pass">パスワードを変更</button>
    </div>

    <button class="btn danger block" id="logout-btn">この端末からログアウト</button>
    <p class="muted small" style="text-align:center; margin-top:14px">ふたりの家計簿（移行版）／ データはFirestoreに同期され、この端末にも控えが保存されます</p>`;

  $$("#tab-settings [data-act]").forEach(btn => btn.addEventListener("click", () => {
    if (btn.dataset.act === "set-prev") { state.settings.month = addMonths(key, -1); renderSettings(); }
    else if (btn.dataset.act === "set-next") { state.settings.month = addMonths(key, 1); renderSettings(); }
  }));
  $("#save-budgets").addEventListener("click", () => {
    const target = ensureMonth(key);
    $$("#tab-settings [data-budget]").forEach(inp => {
      const v = Number(inp.value);
      if (v > 0) target.budgets[inp.dataset.budget] = v;
      else delete target.budgets[inp.dataset.budget];
    });
    target.updatedAt = new Date().toISOString();
    saveData();
    toast("予算を保存しました");
  });
  $("#save-categories").addEventListener("click", () => {
    const groups = Object.assign({}, state.data.settings.pendingGroups || {});
    $$("#tab-settings [data-cat-row]").forEach(rowEl => {
      const id = rowEl.dataset.catRow;
      const cat = categoryById(id);
      if (!cat) return;
      const name = rowEl.querySelector('[data-f="name"]').value.trim();
      if (name) cat.name = name;
      cat.archived = !rowEl.querySelector('[data-f="visible"]').checked;
      const parent = rowEl.querySelector('[data-f="parent"]').value;
      if (parent) groups[id] = parent; else delete groups[id];
    });
    state.data.settings.pendingGroups = groups;
    saveData();
    toast("カテゴリー設定を保存しました（集計先は新しい月から反映）");
    renderSettings();
  });
  const refreshNewCatParents = () => {
    const kind = $("#new-cat-kind").value;
    $("#new-cat-parent").innerHTML = `<option value="">集計先：独立</option>` +
      categories().filter(c => c.kind === kind).map(c => `<option value="${esc(c.id)}">${esc(c.name)} に集計</option>`).join("");
  };
  $("#new-cat-kind").addEventListener("change", refreshNewCatParents);
  refreshNewCatParents();
  $("#add-category").addEventListener("click", () => {
    const name = $("#new-cat-name").value.trim();
    if (!name) { toast("カテゴリー名を入力してください"); return; }
    const kind = $("#new-cat-kind").value;
    const same = categories().filter(c => c.kind === kind);
    let maxN = -1;
    for (const c of same) {
      const mm = /^.*-(\d+)$/.exec(c.id);
      if (mm) maxN = Math.max(maxN, Number(mm[1]));
    }
    const id = kind + "-" + (maxN + 1);
    const color = COLOR_PALETTE[categories().length % COLOR_PALETTE.length];
    categories().push({ id, name, kind, color, archived: false });
    const parent = $("#new-cat-parent").value;
    if (parent) {
      state.data.settings.pendingGroups = state.data.settings.pendingGroups || {};
      state.data.settings.pendingGroups[id] = parent;
    }
    saveData();
    toast("カテゴリーを追加しました");
    renderSettings();
  });
  $("#save-members").addEventListener("click", () => {
    $$("#tab-settings [data-member-idx]").forEach(inp => {
      const v = inp.value.trim();
      if (v) state.data.settings.members[Number(inp.dataset.memberIdx)] = v;
    });
    saveData();
    toast("表示名を保存しました");
  });
  $("#export-json").addEventListener("click", () => {
    downloadFile("futari-kakeibo-backup.json", JSON.stringify(exportableData(), null, 2), "application/json");
  });
  $("#export-csv").addEventListener("click", () => {
    const all = [];
    for (const mo of state.data.months) for (const e of mo.entries) all.push({ e, mk: mo.month });
    const csv = entriesToCSV(all.map(x => x.e), (e) => {
      const found = all.find(x => x.e === e);
      return found ? found.mk : "";
    });
    downloadFile("futari-kakeibo-records.csv", csv, "text/csv");
  });
  $("#import-json").addEventListener("click", () => $("#import-file").click());
  $("#change-pass").addEventListener("click", async () => {
    const p1 = $("#pass-new1").value, p2 = $("#pass-new2").value;
    if (!p1 || p1.length < 6) { toast("パスワードは6文字以上にしてください"); return; }
    if (p1 !== p2) { toast("確認用パスワードが一致しません"); return; }
    if (!sync.fb || !sync.user) { toast("ログイン中のみパスワードを変更できます"); return; }
    try {
      await sync.fb.authApi.updatePassword(sync.user, p1);
      toast("パスワードを変更しました");
      renderSettings();
    } catch (e) {
      console.error("updatePassword failed", e);
      toast(authErrorMessage(e));
    }
  });
  $("#logout-btn").addEventListener("click", () => {
    if (confirm("この端末からログアウトしますか？（データは消えません）")) logout();
  });
}

/* ---------------- 初期化 ---------------- */
async function init() {
  state.data = loadData();
  if (!state.data) {
    state.data = emptyData();
    storageAdapter.save(state.data);
  } else {
    state.data = normalizeData(state.data);
    storageAdapter.save(state.data); // auth除去など正規化の結果をミラーへ反映する
  }
  $$(".tab-btn").forEach(b => b.addEventListener("click", () => switchTab(b.dataset.tab)));
  $("#modal-backdrop").addEventListener("click", (ev) => { if (ev.target.id === "modal-backdrop") closeModal(); });
  $("#setup-btn").addEventListener("click", setupPassword);
  $("#login-btn").addEventListener("click", tryLogin);
  $("#login-pass").addEventListener("keydown", (ev) => { if (ev.key === "Enter") tryLogin(); });
  $("#to-login-btn").addEventListener("click", () => showGate("login"));
  $("#to-setup-btn").addEventListener("click", () => showGate("setup"));
  $("#offline-view-btn").addEventListener("click", () => {
    offlineViewing = true;
    sync.status = "local";
    showApp();
    toast("オフライン閲覧中（編集しても同期されません）");
  });
  $("#import-file").addEventListener("change", (ev) => {
    if (ev.target.files && ev.target.files[0]) importFromFile(ev.target.files[0]);
    ev.target.value = "";
  });
  /* まずゲートを表示しておき（真っ白防止）、Firebase の起動を試みる。
   * ログイン済みなら handleAuthState がアプリ画面へ切り替える。 */
  showGate();
  renderSyncStatus();
  try {
    sync.fb = await loadFirebaseSDK();
    sync.fb.authApi.onAuthStateChanged(sync.fb.auth, handleAuthState);
  } catch (e) {
    console.error("Firebase SDK load failed", e);
    sync.loadFailed = true;
    sync.status = "local";
    renderSyncStatus();
    showGate(); // オフライン閲覧の入口を表示する
  }
}
document.addEventListener("DOMContentLoaded", init);
