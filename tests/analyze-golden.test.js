'use strict';
// 回歸（plan §8 C2/C3）：新版兩端 analyzeADR 對固定假資料的完整回傳（含 interpretation、N）
// 必須與 bdf4360（功能前）凍結的 golden 逐欄相同；HTTP 次數（冷／熱快取）亦相同。
// golden 由 tests/tools/gen-analyze-golden.js 以 bdf4360 原始碼產生，不得以目前工作樹重產。
const test = require('node:test');
const assert = require('node:assert/strict');
const { read } = require('./_load');
const { SCENARIOS, runAll, loadAppFrom, loadGasFrom, strip } = require('./_analyze_harness');
const GOLDEN = require('./fixtures/analyze-golden.json');

test('golden 來源為 bdf4360，涵蓋全部情境', () => {
  assert.equal(GOLDEN.base, 'bdf4360');
  assert.equal(GOLDEN.app.length, SCENARIOS.length);
  assert.equal(GOLDEN.gas.length, SCENARIOS.length);
});

test('C2/C3 兩端 analyzeADR 輸出與 HTTP 次數等於 bdf4360 golden', async () => {
  const now = await runAll(read('docs/app.js'), read('Code.gs'));
  for (const side of ['app', 'gas']) {
    now[side].forEach((s, i) => {
      const g = GOLDEN[side][i];
      assert.equal(s.name, g.name);
      assert.deepEqual(s.cold, g.cold, side + ' ' + s.name + ' cold');
      assert.deepEqual(s.hot, g.hot, side + ' ' + s.name + ' hot');
      assert.equal(s.httpCold, g.httpCold, side + ' ' + s.name + ' HTTP（冷）');
      assert.equal(s.httpHot, g.httpHot, side + ' ' + s.name + ' HTTP（熱）');
    });
  }
});

test('C2 疑似藥比例查詢進行中／完成後再跑 analyzeADR，結果仍等於 golden', async () => {
  const realSetTimeout = setTimeout;
  let release;
  const spGate = new Promise((r) => { release = r; });
  const log = [];
  const app = loadAppFrom(read('docs/app.js'), log, {
    // 節流 sleep 立即執行；疑似藥比例的 60s 期限用真計時器（測試結束前會完成並清除）
    setTimeout: (fn, ms) => (ms >= 60000 ? realSetTimeout(fn, ms) : (fn(), 0)),
    clearTimeout,
    AbortController, TextDecoder,
    wrapFetch: (base) => (url, init) => {
      if (String(url).includes('limit=100')) {
        return spGate.then(() => ({ status: 200, arrayBuffer: async () => new TextEncoder().encode('{"results":[]}').buffer }));
      }
      return base(url, init);
    }
  });
  const sc = SCENARIOS[0];
  const pending = app.suspectProportion('Vancomycin', sc.payload.reaction);
  const during = strip(await app.analyzeADR(JSON.parse(JSON.stringify(sc.payload))));
  const analyzeCalls = log.filter((u) => !String(u).includes('limit=100')).length;
  assert.deepEqual(during, GOLDEN.app[0].cold, '比例查詢進行中');
  release();
  const sp = await pending;
  assert.equal(sp.success, true);
  const after = strip(await app.analyzeADR(JSON.parse(JSON.stringify(sc.payload))));
  assert.deepEqual(after, GOLDEN.app[0].hot, '比例查詢完成後');
  assert.equal(analyzeCalls, GOLDEN.app[0].httpCold, 'analyzeADR 的 HTTP 次數不受影響');

  // GAS：先呼叫 suspectProportion（同一 CacheService），再跑 analyzeADR
  const glog = [];
  const g = loadGasFrom(read('Code.gs'), glog);
  g.suspectProportion('Vancomycin', sc.payload.reaction);
  const nSp = glog.length;
  const gres = strip(g.analyzeADR(JSON.parse(JSON.stringify(sc.payload))));
  assert.deepEqual(gres, GOLDEN.gas[0].cold);
  assert.equal(glog.length - nSp, GOLDEN.gas[0].httpCold);
});

test('C3 解讀文字不含疑似藥比例相關字樣', () => {
  for (const side of ['app', 'gas']) {
    for (const s of GOLDEN[side]) assert.doesNotMatch(s.cold.data.interpretation.text, /疑似藥|Suspect Drug Proportion|suspect proportion/i);
  }
});
