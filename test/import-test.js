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

/* --- 不正データの検証 --- */
const bad = run('parseImportJSON("{\\"format\\":\\"other\\"}")');
assert.strictEqual(bad.ok, false, "形式が違うJSONは拒否されること");

console.log("\nすべての検証に合格しました。");
