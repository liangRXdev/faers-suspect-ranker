// 測試載入器：零依賴（Node ≥18 內建 node:test / vm）
// 以 vm 載入兩端引擎（docs/app.js、Code.gs）與 HTML 內嵌的 DrugSuggest 區塊，
// 不需 bundler，也不需 GAS 執行環境（只呼叫純函式）。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

// docs/app.js → FAERSApp（timers 可替換：測 analyzeADR 時跳過節流 sleep）
function loadApp(opts) {
  opts = opts || {};
  const ctx = {
    console, Promise, Map, Date, Math, JSON,
    setTimeout: opts.instantTimers ? (fn) => { fn(); return 0; } : setTimeout,
    clearTimeout,
    localStorage: { getItem: () => '', setItem() {}, removeItem() {} },
    fetch: opts.fetch
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('docs/app.js'), ctx, { filename: 'docs/app.js' });
  return ctx.FAERSApp;
}

// Code.gs → 全域函式（GAS 服務以空殼替代；純函式不會呼叫到）
function loadGas() {
  const ctx = { console, Math, Date, JSON, CacheService: {}, PropertiesService: {}, UrlFetchApp: {}, Utilities: {} };
  vm.createContext(ctx);
  vm.runInContext(read('Code.gs'), ctx, { filename: 'Code.gs' });
  return ctx;
}

const BEGIN = '// <drug-suggest:begin>';
const END = '// <drug-suggest:end>';
function suggestBlock(file) {
  const h = read(file);
  const i = h.indexOf(BEGIN), j = h.indexOf(END);
  if (i < 0 || j < 0) throw new Error('drug-suggest block not found in ' + file);
  return h.slice(i, j + END.length);
}

// DrugSuggest（取自 Index.html；docs 版逐字相同另有測試）
function loadSuggest(extra) {
  const ctx = Object.assign({
    console, Promise, Map, Date, Math, JSON, setTimeout, clearTimeout, AbortController,
    encodeURIComponent, Object, Error
  }, extra || {});
  vm.createContext(ctx);
  vm.runInContext(suggestBlock('Index.html') + '\nthis.DrugSuggest = DrugSuggest;', ctx, { filename: 'drug-suggest' });
  return { DS: ctx.DrugSuggest, ctx };
}

module.exports = { read, loadApp, loadGas, loadSuggest, suggestBlock, ROOT };
