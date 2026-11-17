// analyzeADR 回歸基準的共用 harness（C2）：以固定假 OpenFDA 跑兩端 analyzeADR，
// 收集完整回傳（排除 queriedAt）與冷／熱快取的 HTTP 次數。
// 供 tools/gen-analyze-golden.js（以 bdf4360 原始碼產生 golden）與 analyze-golden.test.js 共用。
'use strict';
const vm = require('vm');
const crypto = require('crypto');

// 依 search 字串回傳固定 total（與藥名、症狀相關，製造一般／同分／零通報）
function totalFor(search) {
  const s = decodeURIComponent(search || '').toLowerCase();
  if (!s) return 20000000;                                   // N
  const hasEvt = s.includes('reactionmeddrapt');
  if (s.includes('zzz')) return 0;
  const drug = (s.match(/generic_name:"([^"]+)"/) || [])[1];
  if (!drug) return hasEvt ? 80000 : 20000000;               // 症狀總數
  const table = {
    vancomycin: [120000, 900], cefepime: [90000, 1500], tiezero: [50000, 600], tieone: [50000, 600],
    lowror: [400000, 200], absent: [30000, 0]
  };
  const row = table[drug] || [10000, 10];
  return hasEvt ? row[1] : row[0];
}

const SCENARIOS = [
  { name: '一般 2 藥', payload: { reaction: 'Thrombocytopenia', onsetDate: '2026-01-08',
    drugs: [{ name: 'Vancomycin', startDate: '2026-01-04', stopDate: null }, { name: 'Cefepime', startDate: '2026-01-01', stopDate: null }] } },
  { name: '多藥含 a=0 與 ROR<1', payload: { reaction: 'Thrombocytopenia', onsetDate: '2026-01-08',
    drugs: [{ name: 'LowROR', startDate: '2025-12-01', stopDate: null }, { name: 'Absent', startDate: '2026-01-01', stopDate: null },
      { name: 'Vancomycin', startDate: '2025-06-01', stopDate: '2025-12-01' }, { name: 'Cefepime' }] } },
  { name: '症狀零通報', payload: { reaction: 'Zzz nonexistent', onsetDate: null, drugs: [{ name: 'Vancomycin' }] } },
  { name: '時序排除', payload: { reaction: 'Thrombocytopenia', onsetDate: '2026-01-08',
    drugs: [{ name: 'Vancomycin', startDate: '2026-01-10', stopDate: null }, { name: 'Cefepime', startDate: '2026-01-01', stopDate: null }] } },
  { name: '時序排除者與零分藥同分（須沉底）', payload: { reaction: 'Thrombocytopenia', onsetDate: '2026-01-08',
    drugs: [{ name: 'Vancomycin', startDate: '2026-01-10', stopDate: null }, { name: 'LowROR', startDate: '2026-01-01', stopDate: null }] } },
  { name: '同分', payload: { reaction: 'Thrombocytopenia', onsetDate: '2026-01-08',
    drugs: [{ name: 'TieZero', startDate: '2026-01-01' }, { name: 'TieOne', startDate: '2026-01-01' }] } }
];

function searchOf(url) {
  const m = String(url).match(/[?&]search=([^&]*)/);
  return m ? m[1] : '';
}

// Pages 引擎（docs/app.js 原始碼字串）
// extra（選用）：覆寫 ctx 屬性；extra.wrapFetch(base) 可包裝假 fetch（C2 測疑似藥比例並行時用）
function loadAppFrom(src, log, extra) {
  extra = extra || {};
  const ctx = {
    console, Promise, Map, Date, Math, JSON,
    setTimeout: (fn) => { fn(); return 0; }, clearTimeout() {},
    localStorage: { getItem: () => '', setItem() {}, removeItem() {} },
    fetch: async (url) => {
      log.push(url);
      const t = totalFor(searchOf(url));
      if (t === 0) return { status: 404, json: async () => ({ error: { code: 'NOT_FOUND', message: 'No matches found!' } }) };
      return { status: 200, json: async () => ({ meta: { results: { total: t } } }) };
    }
  };
  if (extra.wrapFetch) ctx.fetch = extra.wrapFetch(ctx.fetch);
  Object.keys(extra).forEach((k) => { if (k !== 'wrapFetch') ctx[k] = extra[k]; });
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: 'app.js' });
  return ctx.FAERSApp;
}

// GAS 引擎（Code.gs 原始碼字串）；GAS 服務以記憶體假物件替代
function loadGasFrom(src, log) {
  const store = new Map();
  const ctx = {
    console, Math, Date, JSON,
    CacheService: { getScriptCache: () => ({ get: (k) => (store.has(k) ? store.get(k) : null), put: (k, v) => { store.set(k, v); } }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    UrlFetchApp: { fetch: (url) => {
      log.push(url);
      const t = totalFor(searchOf(url));
      const body = t === 0 ? { error: { code: 'NOT_FOUND', message: 'No matches found!' } } : { meta: { results: { total: t } } };
      return { getContentText: () => JSON.stringify(body), getResponseCode: () => (t === 0 ? 404 : 200) };
    } },
    Utilities: {
      sleep() {},
      DigestAlgorithm: { MD5: 'md5' },
      computeDigest: (alg, s) => Array.from(crypto.createHash('md5').update(String(s)).digest()).map((b) => (b > 127 ? b - 256 : b))
    }
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: 'Code.gs' });
  return ctx;
}

function strip(res) {
  const o = JSON.parse(JSON.stringify(res));
  if (o && o.data && o.data.meta) delete o.data.meta.queriedAt;
  return o;
}

// 每個情境：新引擎實例 → 冷跑一次、熱跑一次（同實例），記錄輸出與 HTTP 次數
async function runAll(appSrc, gasSrc) {
  const out = { app: [], gas: [] };
  for (const sc of SCENARIOS) {
    const logA = [];
    const app = loadAppFrom(appSrc, logA);
    const coldA = strip(await app.analyzeADR(JSON.parse(JSON.stringify(sc.payload))));
    const nColdA = logA.length;
    const hotA = strip(await app.analyzeADR(JSON.parse(JSON.stringify(sc.payload))));
    out.app.push({ name: sc.name, cold: coldA, hot: hotA, httpCold: nColdA, httpHot: logA.length - nColdA });

    const logG = [];
    const gas = loadGasFrom(gasSrc, logG);
    const coldG = strip(gas.analyzeADR(JSON.parse(JSON.stringify(sc.payload))));
    const nColdG = logG.length;
    const hotG = strip(gas.analyzeADR(JSON.parse(JSON.stringify(sc.payload))));
    out.gas.push({ name: sc.name, cold: coldG, hot: hotG, httpCold: nColdG, httpHot: logG.length - nColdG });
  }
  return out;
}

module.exports = { SCENARIOS, runAll, loadAppFrom, loadGasFrom, strip, totalFor };
