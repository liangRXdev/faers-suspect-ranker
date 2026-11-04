'use strict';
// 回歸測試：ROR/PRR/χ² 與時序權重不因本次改動而改變；autocomplete 的 nameInfo 不影響查詢字串與統計
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, loadGas } = require('./_load');

const J = (x) => JSON.parse(JSON.stringify(x));
const gas = loadGas();

// golden：由 v2.2.0（本次改動前，commit e1992a6）之 docs/app.js 計算
const STATS_GOLDEN = [
  { in: [5, 120, 4000, 1000000], out: { a: 5, ror: 10.84, rorLow: 4.42, rorHigh: 26.55, prr: 10.43, chi2: 33.8, signal: true, signalBasis: 'ROR+PRR', haldane: false } },
  { in: [0, 50, 300, 900000], out: { a: 0, ror: 29.64, rorLow: 1.82, rorHigh: 481.56, prr: 29.36, chi2: 0, signal: false, signalBasis: 'a<3', haldane: true } },
  { in: [12, 12, 500, 800000], out: { a: 12, ror: 40916.1, rorLow: 2419.06, rorHigh: 692056.24, prr: 1574.66, chi2: 17675.1, signal: true, signalBasis: 'ROR+PRR', haldane: true } },
  { in: [3, 1000, 2000, 20000000], out: { a: 3, ror: 30.13, rorLow: 9.69, rorHigh: 93.66, prr: 30.04, chi2: 57.6, signal: true, signalBasis: 'ROR+PRR', haldane: false } },
  { in: [40, 500, 5000, 10000], out: { a: 40, ror: 0.08, rorLow: 0.06, rorHigh: 0.11, prr: 0.15, chi2: 369.6, signal: false, signalBasis: '未達閾值', haldane: false } }
];
const TEMPORAL_GOLDEN = [
  { in: ['2026-01-01', null, '2026-01-08'], out: { days: 7, weight: 1, flag: '急性窗 (≤90d)·用藥中' }, status: 'on' },
  { in: ['2026-01-10', null, '2026-01-08'], out: { days: -2, weight: 0, flag: '症狀早於用藥·排除' }, status: 'before' },
  { in: [null, null, '2026-01-08'], out: { days: null, weight: 1, flag: '缺日期·未加權' }, status: 'missing' },
  { in: ['bad', null, '2026-01-08'], out: { days: null, weight: 1, flag: '日期格式錯誤·未加權' }, status: 'invalid' },
  { in: ['2025-06-01', null, '2026-01-08'], out: { days: 221, weight: 0.3, flag: '慢性 (>180d)·用藥中' }, status: 'on' },
  { in: ['2026-01-01', '2026-01-05', '2026-01-08'], out: { days: 7, weight: 0.7, flag: '停藥後 3d (停藥≤7d)' }, status: 'post' },
  { in: ['2026-01-01', '2026-01-05', '2026-01-25'], out: { days: 24, weight: 0.4, flag: '停藥後 20d (停藥8–30d)' }, status: 'post' },
  { in: ['2025-10-01', '2025-11-01', '2026-01-08'], out: { days: 99, weight: 0.06, flag: '停藥後 68d (停藥>30d)' }, status: 'post' }
];

test('_stats 與改動前 golden 完全一致（兩端）', () => {
  const app = loadApp();
  for (const c of STATS_GOLDEN) {
    assert.deepEqual(J(app._stats(...c.in)), c.out, 'app.js ' + c.in);
    assert.deepEqual(J(gas._stats(...c.in)), c.out, 'Code.gs ' + c.in);
  }
});

test('_temporal 權重/天數/flag 與 golden 一致，僅新增 status 欄位（兩端）', () => {
  const app = loadApp();
  for (const c of TEMPORAL_GOLDEN) {
    for (const [name, fn] of [['app.js', app._temporal], ['Code.gs', gas._temporal]]) {
      const o = J(fn(...c.in));
      assert.equal(o.status, c.status, name + ' status ' + c.in);
      delete o.status;
      assert.deepEqual(o, c.out, name + ' ' + c.in);
    }
  }
});

// 假 OpenFDA：依 search 字串回傳固定 total，並記錄所有 URL
function fakeFetch(log) {
  return async (url) => {
    log.push(url);
    const s = decodeURIComponent(url);
    let total = 20000000;                                         // N
    if (s.includes('reactionmeddrapt')) total = 80000;           // 症狀
    if (s.includes('generic_name')) total = s.includes('reactionmeddrapt') ? 900 : 120000;
    if (s.toLowerCase().includes('zzz')) total = 0;
    if (total === 0) return { json: async () => ({ error: { code: 'NOT_FOUND', message: 'No matches found!' } }) };
    return { json: async () => ({ meta: { results: { total } } }) };
  };
}

test('analyzeADR：nameInfo 不改變查詢 URL、統計與排名；回傳含 interpretation', async () => {
  const base = { reaction: 'Thrombocytopenia', onsetDate: '2026-01-08',
    drugs: [{ name: 'Vancomycin', startDate: '2026-01-04', stopDate: null }, { name: 'Cefepime', startDate: '2026-01-01', stopDate: null }] };
  const withInfo = J(base);
  withInfo.drugs[0].nameInfo = { displayName: 'Vancomycin — Generic', queryName: 'Vancomycin', source: 'openfda-ndc', kind: 'generic', verified: true, evil: '<x>' };
  withInfo.drugs[1].nameInfo = { queryName: 'Cefepime', source: 'manual', kind: 'manual', verified: false };

  const logA = [], logB = [];
  const resA = await loadApp({ instantTimers: true, fetch: fakeFetch(logA) }).analyzeADR(base);
  const resB = await loadApp({ instantTimers: true, fetch: fakeFetch(logB) }).analyzeADR(withInfo);
  assert.equal(resA.success, true, resA.error);
  assert.deepEqual(logA, logB, '查詢 URL 必須相同');
  const strip = (res) => J(res.data.results).map((x) => { delete x.nameInfo; return x; });
  assert.deepEqual(strip(resA), strip(resB), '統計與排名必須相同');
  assert.equal(resA.data.results[0].nameInfo, null);
  assert.deepEqual(J(resB.data.results.find((x) => x.drug === 'Vancomycin').nameInfo),
    { displayName: 'Vancomycin — Generic', source: 'openfda-ndc', queryName: 'Vancomycin', kind: 'generic', verified: true },
    'nameInfo 僅保留白名單欄位');
  assert.ok(resB.data.interpretation && resB.data.interpretation.sections.length === 3);
  assert.match(resB.data.interpretation.text, /未經建議清單確認、以輸入文字原樣查詢 FAERS：Cefepime/);
});

test('analyzeADR：症狀查無通報 → results 空、解讀不報錯', async () => {
  const res = await loadApp({ instantTimers: true, fetch: fakeFetch([]) })
    .analyzeADR({ reaction: 'Zzz nonexistent', onsetDate: null, drugs: [{ name: 'X' }] });
  assert.equal(res.success, true);
  assert.equal(res.data.results.length, 0);
  assert.match(res.data.interpretation.text, /本次分析未產生藥品結果/);
});
