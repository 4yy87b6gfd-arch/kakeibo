"use strict";
/* インポーター検証テスト
 * app.js をブラウザ環境スタブ付きで読み込み、実際の parseImportJSON / 集計関数を
 * 移行元バックアップJSONに対して実行して件数を検証する。
 * 実行: node test/import-test.js */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const appSrc = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const backupPath = path.join(__dirname, "..", "..", "hidden_files", "kakeibo-backup-2026-11-13.json");
const backupText = fs.readFileSync(backupPath, "utf8");

/* ブラウザ環境の最小スタブ（app.js のトップレベル実行に必要なものだけ） */
const store = new Map();
const ctx = {
  console,
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  },
  document: {
    addEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({})
  },
  alert: () => {},
  setTimeout, clearTimeout
};
ctx.window = { crypto: require("crypto").webcrypto };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(appSrc, ctx, { filename: "app.js" });

const run = (code) => vm.runInContext(code, ctx);

/* --- インポート検証 --- */
ctx.__backupText = backupText;
const res = run("parseImportJSON(__backupText)");
assert.strictEqual(res.ok, true, "インポートが成功すること: " + (res.error || ""));
console.log("months    =", res.stats.months);
console.log("entries   =", res.stats.entries);
console.log("categories=", res.stats.categories);
assert.strictEqual(res.stats.months, 25, "months は 25");
assert.strictEqual(res.stats.entries, 331, "entries 合計は 331");
assert.strictEqual(res.stats.categories, 33, "categories は 33");

/* --- 集計の健全性チェック --- */
run("__data = null");
ctx.__resData = res.data;
run("state.data = __resData");
const novKey = "2026-11";
const novTotal = run(`totalOf(findMonth("${novKey}"), "expense")`);
assert.ok(novTotal > 0, "2026-11 の支出合計が正であること");
const rows = run(`rolledUpRows(findMonth("${novKey}"), "expense")`);
const rolledSum = rows.reduce((a, r) => a + r.amount, 0);
assert.strictEqual(rolledSum, novTotal, "ロールアップ後の合計が元の支出合計と一致すること（二重計上なし）");
console.log("2026-11 支出合計 =", novTotal, "／ ロールアップ行数 =", rows.length);

/* pendingGroups が最新の月から引き継がれていること */
const pg = run("Object.keys(state.data.settings.pendingGroups).length");
assert.ok(pg > 0, "pendingGroups が初期化されていること");
console.log("pendingGroups キー数 =", pg);

/* pendingGroups の中身：expense-15〜21 の7件がすべて expense-14（その他）へ集計されること */
const pgObj = run("state.data.settings.pendingGroups");
const pgKeys = Object.keys(pgObj).sort();
assert.deepStrictEqual(pgKeys,
  ["expense-15", "expense-16", "expense-17", "expense-18", "expense-19", "expense-20", "expense-21"],
  "pendingGroups のキーは expense-15〜21 の7件であること");
assert.ok(pgKeys.every(k => pgObj[k] === "expense-14"),
  "pendingGroups の集計先はすべて expense-14（その他）であること");
console.log("pendingGroups 集計先 = すべて expense-14（その他）");

/* --- 口座（資産）機能の検証 --- */
const accCount = run("state.data.accounts.length");
assert.strictEqual(accCount, 0, "移行データに口座は無く、accounts は空配列で初期化されること");
run('state.data.accounts.push({ id: "acc-test", name: "テスト口座", balance: 10000, updatedAt: null })');
run('adjustAccountBalance({ accountId: "acc-test", categoryId: "expense-0", amount: 1500 }, 1)');
assert.strictEqual(run('accountById("acc-test").balance'), 8500, "支出は残高を減らすこと");
run('adjustAccountBalance({ accountId: "acc-test", categoryId: "income-0", amount: 3000 }, 1)');
assert.strictEqual(run('accountById("acc-test").balance'), 11500, "収入は残高を増やすこと");
run('adjustAccountBalance({ accountId: "acc-test", categoryId: "expense-0", amount: 1500 }, -1)');
assert.strictEqual(run('accountById("acc-test").balance'), 13000, "取り消し（sign=-1）で残高が戻ること");
run('adjustAccountBalance({ accountId: null, categoryId: "expense-0", amount: 999 }, 1)');
assert.strictEqual(run('accountById("acc-test").balance'), 13000, "口座未指定の記録は残高に影響しないこと");
run('adjustAccountBalance({ accountId: "acc-missing", categoryId: "expense-0", amount: 999 }, 1)');
assert.strictEqual(run('accountById("acc-test").balance'), 13000, "存在しない口座への反映は無視されること");
console.log("口座残高の連動チェック OK");

/* --- 口座間の移動（振替）とメイン口座の検証 --- */
run('state.data.accounts.push({ id: "acc-sub", name: "生活費口座", balance: 0, updatedAt: null, isMain: false })');
run('state.data.accounts.find(a => a.id === "acc-test").isMain = true');
assert.strictEqual(run('mainAccount().id'), "acc-test", "メイン口座が取得できること");
assert.strictEqual(run('state.data.transfers.length'), 0, "transfers は空配列で初期化されること");
run('adjustTransferBalance({ fromId: "acc-test", toId: "acc-sub", amount: 5000 }, 1)');
assert.strictEqual(run('accountById("acc-test").balance'), 8000, "移動元が減ること（13000-5000）");
assert.strictEqual(run('accountById("acc-sub").balance'), 5000, "移動先が増えること");
run('adjustTransferBalance({ fromId: "acc-test", toId: "acc-sub", amount: 5000 }, -1)');
assert.strictEqual(run('accountById("acc-test").balance'), 13000, "取り消しで移動元が戻ること");
assert.strictEqual(run('accountById("acc-sub").balance'), 0, "取り消しで移動先が戻ること");
const norm = run('normalizeData({ settings: { members: ["健人", "知尋"], categories: [], keywords: {} }, months: [], accounts: [{ id: "a1", name: "A", balance: 1, isMain: true }, { id: "a2", name: "B", balance: 2, isMain: true }], transfers: [{ id: "t1", fromId: "a1", toId: "a2", amount: 100 }, { id: "t2", fromId: "a1", toId: "a1", amount: 100 }] })');
assert.strictEqual(norm.accounts.filter(a => a.isMain).length, 1, "メイン口座は1つだけに正規化されること");
assert.strictEqual(norm.transfers.length, 1, "移動元と移動先が同じ振替は落とされること");
console.log("振替・メイン口座チェック OK");

/* --- 口座の種別の検証 --- */
assert.strictEqual(norm.accounts[0].type, "bank", "種別が無い口座は銀行口座として正規化されること");
const norm2 = run('normalizeData({ settings: { members: ["健人", "知尋"], categories: [], keywords: {} }, months: [], accounts: [{ id: "e1", name: "PayPay", balance: 500, type: "emoney" }, { id: "e2", name: "謎の財布", balance: 0, type: "xxx" }] })');
assert.strictEqual(norm2.accounts[0].type, "emoney", "電子マネーの種別が保持されること");
assert.strictEqual(norm2.accounts[1].type, "bank", "不正な種別は銀行口座に正規化されること");
assert.strictEqual(run('accountTypeLabel("prepaid")'), "チャージ式", "種別ラベルが引けること");
console.log("口座の種別チェック OK");

/* --- 履歴の口座フィルターの検証 --- */
run('state.data = normalizeData({ settings: { members: ["健人", "知尋"], categories: [{ id: "c1", name: "食費", kind: "expense" }], keywords: {} }, months: [], accounts: [{ id: "a1", name: "山口家現金", balance: 0, type: "cash" }, { id: "a2", name: "銀行", balance: 0, type: "bank" }] })');
const histResult = run(`(() => {
  const m = { key: "2026-11", entries: [
    { id: "h1", date: "2026-11-03", categoryId: "c1", amount: 1000, member: "共通", accountId: "a1" },
    { id: "h2", date: "2026-11-02", categoryId: "c1", amount: 2000, member: "共通", accountId: "a2" },
    { id: "h3", date: "2026-11-01", categoryId: "c1", amount: 3000, member: "共通" }
  ] };
  state.history.accountId = "a1";
  const byAccount = filteredEntries(m).map(e => e.id).join(",");
  state.history.accountId = "__none__";
  const noAccount = filteredEntries(m).map(e => e.id).join(",");
  state.history.accountId = "";
  const all = filteredEntries(m).length;
  return byAccount + "|" + noAccount + "|" + all;
})()`);
assert.strictEqual(histResult, "h1|h3|3", "口座フィルター（指定口座／指定なし／全て）が効くこと");
console.log("履歴の口座フィルターチェック OK");

/* --- 履歴の振替フィルターの検証 --- */
run('state.data = normalizeData({ settings: { members: ["健人", "知尋"], categories: [], keywords: {} }, months: [], accounts: [{ id: "a1", name: "山口家現金", balance: 0, type: "cash" }, { id: "a2", name: "銀行", balance: 0, type: "bank" }], transfers: [{ id: "t1", date: "2026-11-05", fromId: "a2", toId: "a1", amount: 5000, note: "引き出し" }, { id: "t2", date: "2026-10-05", fromId: "a2", toId: "a1", amount: 3000 }] })');
const trResult = run(`(() => {
  state.history.accountId = "";
  const nov = filteredTransfers("2026-11").map(t => t.id).join(",");
  state.history.accountId = "a1";
  const byAccount = filteredTransfers("2026-11").length;
  state.history.accountId = "__none__";
  const none = filteredTransfers("2026-11").length;
  state.history.accountId = "";
  return nov + "|" + byAccount + "|" + none;
})()`);
assert.strictEqual(trResult, "t1|1|0", "振替フィルター（月／口座／指定なし）が効くこと");
console.log("履歴の振替フィルターチェック OK");

/* --- 貯金目標の検証 --- */
const gnorm = run('normalizeData({ settings: { members: ["健人", "知尋"], categories: [], keywords: {} }, months: [], goals: [{ id: "g1", name: "太陽光＆蓄電池", target: 3499100, saved: 436950 }, { id: "g2", name: "", target: 100, saved: 0 }, { id: "g3", name: "マイナス", target: -5, saved: -10 }] })');
assert.strictEqual(gnorm.goals.length, 2, "名前のない目標は落とされること");
assert.strictEqual(gnorm.goals[1].target, 0, "負の目標金額は0に丸められること");
assert.strictEqual(gnorm.goals[1].saved, 0, "負の貯金額は0に丸められること");
assert.strictEqual(run('goalProgress({ target: 200, saved: 50 })'), 25, "進捗率が計算できること");
assert.strictEqual(run('goalProgress({ target: 100, saved: 125 })'), 100, "進捗率は100で頭打ちになること");
assert.strictEqual(run('goalProgress({ target: 0, saved: 0 })'), 0, "目標0・貯金0は0%");
assert.strictEqual(run('goalProgress({ target: 0, saved: 10 })'), 100, "目標0で貯金があれば100%");
assert.strictEqual(run('normalizeData({ settings: { members: [], categories: [], keywords: {} }, months: [] }).goals.length'), 0, "goals が無いデータでは空配列になること");
assert.strictEqual(gnorm.goals[0].kind, "save", "種別が無い目標は貯金目標として正規化されること");
const gnorm2 = run('normalizeData({ settings: { members: [], categories: [], keywords: {} }, months: [], goals: [{ id: "d1", name: "住宅ローン", kind: "debt", target: 4000000, saved: 100000 }, { id: "d2", name: "x", kind: "xxx", target: 1, saved: 0 }] })');
assert.strictEqual(gnorm2.goals[0].kind, "debt", "借金の種別が保持されること");
assert.strictEqual(gnorm2.goals[1].kind, "save", "不正な種別は貯金目標に正規化されること");
run("state.data = " + JSON.stringify(gnorm2));
assert.strictEqual(run('goalsOfKind("debt").length'), 1, "借金だけを絞り込めること");
assert.strictEqual(run('debtRemaining()'), 3900000, "借金の残り合計が計算できること");
console.log("貯金目標チェック OK");

/* --- 不正データの検証 --- */
const bad = run('parseImportJSON("{\\"format\\":\\"other\\"}")');
assert.strictEqual(bad.ok, false, "形式が違うJSONは拒否されること");

console.log("\nすべての検証に合格しました。");
