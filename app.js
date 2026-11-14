"use strict";
/* =====================================================================
 * ふたりの家計簿（移行版・プレビュー）
 * - データ形式は移行元バックアップJSON（format: "futari-kakeibo", version 1）と互換。
 * - データの読み書きはアダプター（storageAdapter）に分離している。
 *   将来 Firebase Firestore に差し替える場合は、FIREBASE_CONFIG を設定し、
 *   storageAdapter の load/save を Firestore 実装に置き換えること。
 * - 同期状態表示の差し替えポイント: renderSyncStatus() と #sync-status 要素。
 * ===================================================================== */

// ▼▼▼ Firebase差し替えポイント ▼▼▼
// Firestore導入時にプロジェクト設定をここへ入れる（null の間はローカル保存のみ）。
const FIREBASE_CONFIG = null;
// ▲▲▲ Firebase差し替えポイント ▲▲▲

const LS_DATA_KEY = "futari_kakeibo_data_v1";
const LS_AUTH_TS_KEY = "futari_kakeibo_auth_ts";
const AUTH_KEEP_MS = 30 * 24 * 60 * 60 * 1000; // 端末ログイン保持 約30日

/* ---------------- データアダプター ----------------
 * loadData()/saveData() は必ずこのアダプター経由で呼ぶ。
 * Firestore化する場合は storageAdapter の中身だけを差し替える。 */
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
function saveData() { if (state.data) storageAdapter.save(state.data); }

/* 同期状態表示（Firestore導入時はここで「同期済み HH:MM」等に差し替える） */
function renderSyncStatus() {
  const el = document.getElementById("sync-status");
  if (!el) return;
  el.textContent = FIREBASE_CONFIG ? "同期済み" : "ローカル保存";
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
/* SHA-256（secure context用）。使えない環境向けに簡易ハッシュへフォールバック */
async function sha256(text) {
  if (window.crypto && crypto.subtle) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
  }
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return "fallback-" + (h2 >>> 0).toString(16) + (h1 >>> 0).toString(16);
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
 *               entries: [...], closed, incomeComplete, imported, ... } ],
 *   auth: { passwordHash }  // ローカル専用（エクスポート時は除外する）
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
    auth: null
  };
}

const state = {
  data: null,
  tab: "home",
  home: { month: currentMonthKey(), kind: "expense", expanded: {} },
  history: { month: currentMonthKey(), catId: "", kind: "", member: "" },
  entry: { kind: "expense", amountStr: "", member: "共通", catId: null, editingId: null, editingMonth: null },
  compare: { baseMonth: currentMonthKey(), againstMonth: addMonths(currentMonthKey(), -1), kind: "expense" },
  settings: { month: currentMonthKey() }
};

function categories() { return state.data.settings.categories; }
function categoryById(id) { return categories().find(c => c.id === id) || null; }
function members() { return state.data.settings.members; }

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

/* ---------------- 認証（家族パスワード） ---------------- */
function isAuthFresh() {
  const ts = Number(localStorage.getItem(LS_AUTH_TS_KEY) || 0);
  return ts > 0 && (Date.now() - ts) < AUTH_KEEP_MS;
}
function markAuthed() { localStorage.setItem(LS_AUTH_TS_KEY, String(Date.now())); }
function logout() {
  localStorage.removeItem(LS_AUTH_TS_KEY);
  location.reload();
}
function showGate() {
  $("#gate").hidden = false;
  $("#app").hidden = true;
  const hasPass = !!(state.data && state.data.auth && state.data.auth.passwordHash);
  $("#gate-setup").hidden = hasPass;
  $("#gate-login").hidden = !hasPass;
}
function showApp() {
  $("#gate").hidden = true;
  $("#app").hidden = false;
  renderSyncStatus();
  renderTab();
}
async function setupPassword() {
  const p1 = $("#setup-pass1").value, p2 = $("#setup-pass2").value;
  const err = $("#setup-error");
  if (!p1 || p1.length < 4) { err.textContent = "4文字以上のパスワードにしてください。"; return; }
  if (p1 !== p2) { err.textContent = "確認用パスワードが一致しません。"; return; }
  state.data.auth = { passwordHash: await sha256(p1) };
  saveData();
  markAuthed();
  toast("パスワードを設定しました");
  showApp();
}
async function tryLogin() {
  const p = $("#login-pass").value;
  const err = $("#login-error");
  const hash = await sha256(p);
  if (state.data.auth && hash === state.data.auth.passwordHash) {
    markAuthed();
    showApp();
  } else {
    err.textContent = "パスワードが違います。";
  }
}

/* ---------------- タブ切替 ---------------- */
function switchTab(tab) {
  state.tab = tab;
  $$(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  ["home", "history", "entry", "compare", "settings"].forEach(t => {
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
  return `<button class="entry-row" data-edit-entry="${esc(e.id)}" data-entry-month="${esc(monthKeyForEntry)}">
    <span class="cat-dot" style="background:${cat ? cat.color : "#ccc"}"></span>
    <span class="entry-main">
      <span class="entry-note">${esc(note)}</span><br>
      <span class="entry-meta">${esc(dateLabel)} ・ ${cat ? esc(cat.name) : "?"} ・ ${esc(e.member || "共通")}${e.recurring ? " ・ 固定費" : ""}</span>
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
      <div class="row between" style="margin-top:10px">
        <span class="muted small">表示中の合計</span>
        <span class="small">収入 <b class="amount-income">${esc(yen(inc))}</b> ／ 支出 <b class="amount-expense">${esc(yen(exp))}</b></span>
      </div>
      <button class="btn small block" id="hist-csv" style="margin-top:10px">この一覧をCSVでダウンロード</button>
    </div>
    <div class="card">
      ${list.length ? list.map(e => `<div class="row" style="gap:0">
          <div style="flex:1">${entryRowHTML(e, key)}</div>
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
    editingId: e.id,
    editingMonth: monthKey
  };
  $("#entry-date") && ($("#entry-date").value = e.date || (monthKey + "-01"));
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
function renderEntry() {
  $("#tab-entry").innerHTML = `
    <div class="card">
      <div class="seg">
        <button data-kind="expense" class="${state.entry.kind === "expense" ? "on expense-on" : ""}">支出</button>
        <button data-kind="income" class="${state.entry.kind === "income" ? "on income-on" : ""}">収入</button>
      </div>
      <div id="entry-form-body"></div>
    </div>`;
  $$("#tab-entry .seg button").forEach(b => b.addEventListener("click", () => {
    state.entry.kind = b.dataset.kind;
    state.entry.catId = null;
    renderEntry();
  }));
  renderEntryForm();
}
function renderEntryForm() {
  const body = $("#entry-form-body");
  if (!body) return;
  const st = state.entry;
  const amt = st.amountStr ? Number(st.amountStr) : 0;
  const cats = categories().filter(c => c.kind === st.kind && (!c.archived || c.id === st.catId));
  if (!st.catId || !cats.some(c => c.id === st.catId)) st.catId = cats.length ? cats[0].id : null;
  const memberLabel = st.kind === "income" ? "収入の対象者" : "使った人";
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
      <div class="chips" id="entry-member-chips">
        ${["共通"].concat(members()).map(n =>
          `<button class="chip ${st.member === n ? "on" : ""}" data-member="${esc(n)}">${esc(n)}</button>`).join("")}
      </div>
    </div>
    <div class="field">
      <label>カテゴリー</label>
      <div class="chips">
        ${cats.map(c => `<button class="chip ${st.catId === c.id ? "on" : ""}" data-cat="${esc(c.id)}">
          <span class="cat-dot" style="background:${c.color}"></span>${esc(c.name)}${c.archived ? "（非表示）" : ""}</button>`).join("") || `<span class="muted">カテゴリーがありません（設定から追加できます）</span>`}
      </div>
    </div>
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
  $$("#entry-member-chips [data-member]").forEach(b => b.addEventListener("click", () => {
    st.member = b.dataset.member;
    $$("#entry-member-chips [data-member]").forEach(x => x.classList.toggle("on", x.dataset.member === st.member));
  }));
  $$("#entry-form-body [data-cat]").forEach(b => b.addEventListener("click", () => {
    st.catId = b.dataset.cat;
    $$("#entry-form-body [data-cat]").forEach(x => x.classList.toggle("on", x.dataset.cat === st.catId));
  }));
  const cancelBtn = $("#entry-cancel-edit");
  if (cancelBtn) cancelBtn.addEventListener("click", () => {
    resetEntryState();
    renderEntry();
    const n = $("#entry-note"); if (n) n.value = "";
    const d = $("#entry-date"); if (d) d.value = todayStr();
  });
  const delBtn = $("#entry-delete");
  if (delBtn) delBtn.addEventListener("click", () => {
    if (!confirm("この記録を削除しますか？")) return;
    deleteEntry(st.editingMonth, st.editingId);
    resetEntryState();
    toast("削除しました");
    renderEntry();
  });
  $("#entry-save").addEventListener("click", saveEntryFromForm);
}
function resetEntryState() {
  state.entry = { kind: state.entry.kind, amountStr: "", member: "共通", catId: null, editingId: null, editingMonth: null };
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
      const newMonthKey = dateVal ? dateVal.slice(0, 7) : st.editingMonth;
      e.amount = amount; e.categoryId = st.catId; e.member = st.member;
      e.note = note; e.recurring = recurring;
      e.date = dateVal || e.date || null;
      if (newMonthKey !== st.editingMonth) {
        m.entries = m.entries.filter(x => x.id !== e.id);
        ensureMonth(newMonthKey).entries.push(e);
      }
      m.updatedAt = new Date().toISOString();
    }
    saveData();
    resetEntryState();
    toast("更新しました");
    renderEntry();
    const n = $("#entry-note"); if (n) n.value = "";
    return;
  }
  const monthKey = dateVal ? dateVal.slice(0, 7) : currentMonthKey();
  const m = ensureMonth(monthKey);
  m.entries.push({
    id: uid(),
    date: dateVal || null,
    categoryId: st.catId,
    amount,
    member: st.member,
    note,
    recurring,
    source: "manual",
    createdAt: new Date().toISOString()
  });
  m.updatedAt = new Date().toISOString();
  saveData();
  st.amountStr = "";
  const n2 = $("#entry-note"); if (n2) n2.value = "";
  const r2 = $("#entry-recurring"); if (r2) r2.checked = false;
  renderEntryForm();
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
  d.settings = d.settings || {};
  d.settings.members = Array.isArray(d.settings.members) && d.settings.members.length ? d.settings.members : ["健人", "知尋"];
  d.settings.categories = d.settings.categories || [];
  d.settings.keywords = d.settings.keywords || {};
  d.months = (d.months || []).map(m => Object.assign(
    { budgets: {}, groups: {}, entries: [], closed: false, incomeComplete: false, imported: false }, m));
  d.months.sort((a, b) => a.month < b.month ? -1 : 1);
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
    const msg = `バックアップを取り込みますか？\n（${res.stats.months}か月・記録${res.stats.entries}件・カテゴリー${res.stats.categories}件）\n今のローカルデータは置き換えられます。`;
    if (!confirm(msg)) return;
    const keepAuth = state.data ? state.data.auth : null;
    state.data = res.data;
    state.data.auth = keepAuth; // パスワードは端末側の設定を保持する
    saveData();
    toast("バックアップを取り込みました");
    state.home.month = currentMonthKey();
    state.history.month = currentMonthKey();
    renderTab();
  };
  reader.readAsText(file);
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
    return `<div class="set-row" data-cat-row="${esc(c.id)}">
      <span class="cat-dot" style="background:${c.color}"></span>
      <input type="text" class="grow" data-f="name" value="${esc(c.name)}">
      <select data-f="parent" title="集計先（新しい月から反映）">${parentOptions(c, parent)}</select>
      <label class="switch" title="表示ON/OFF"><input type="checkbox" data-f="visible" ${c.archived ? "" : "checked"}><i></i></label>
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
      <div class="field"><input type="password" id="pass-new1" placeholder="新しいパスワード" autocomplete="new-password"></div>
      <div class="field"><input type="password" id="pass-new2" placeholder="新しいパスワード（確認）" autocomplete="new-password"></div>
      <button class="btn block" id="change-pass">パスワードを変更</button>
    </div>

    <button class="btn danger block" id="logout-btn">この端末からログアウト</button>
    <p class="muted small" style="text-align:center; margin-top:14px">ふたりの家計簿（移行版プレビュー）／ データはこの端末のブラウザに保存されています</p>`;

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
    if (!p1 || p1.length < 4) { toast("4文字以上のパスワードにしてください"); return; }
    if (p1 !== p2) { toast("確認用パスワードが一致しません"); return; }
    state.data.auth = { passwordHash: await sha256(p1) };
    saveData();
    toast("パスワードを変更しました");
    renderSettings();
  });
  $("#logout-btn").addEventListener("click", () => {
    if (confirm("この端末からログアウトしますか？（データは消えません）")) logout();
  });
}

/* ---------------- 初期化 ---------------- */
function init() {
  state.data = loadData();
  if (!state.data) {
    state.data = emptyData();
    saveData();
  } else {
    state.data = normalizeData(state.data);
  }
  $$(".tab-btn").forEach(b => b.addEventListener("click", () => switchTab(b.dataset.tab)));
  $("#modal-backdrop").addEventListener("click", (ev) => { if (ev.target.id === "modal-backdrop") closeModal(); });
  $("#setup-btn").addEventListener("click", setupPassword);
  $("#login-btn").addEventListener("click", tryLogin);
  $("#login-pass").addEventListener("keydown", (ev) => { if (ev.key === "Enter") tryLogin(); });
  $("#import-file").addEventListener("change", (ev) => {
    if (ev.target.files && ev.target.files[0]) importFromFile(ev.target.files[0]);
    ev.target.value = "";
  });
  const hasPass = !!(state.data.auth && state.data.auth.passwordHash);
  if (hasPass && isAuthFresh()) showApp();
  else showGate();
}
document.addEventListener("DOMContentLoaded", init);
