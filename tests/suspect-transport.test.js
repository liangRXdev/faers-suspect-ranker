'use strict';
// 疑似藥比例：API 與傳輸（plan §7 錯誤決策表、§8 B1–B9）。Pages 與 GAS 各自斷言。
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const crypto = require('crypto');
const { loadApp, loadGas } = require('./_load');

const SENTINEL = 'SENTINELKEY1234567890abcd';
const ENDPOINT_FRAG = 'api.fda.gov/drug/event.json?';
const REPORT = { safetyreportid: '1', receivedate: '20260101', patient: { drug: [{ openfda: { generic_name: ['CARBAMAZEPINE'] }, drugcharacterization: '1' }] } };
const OK_BODY = JSON.stringify({ meta: {}, results: [REPORT] });
const NF_BODY = JSON.stringify({ error: { code: 'NOT_FOUND', message: 'No matches found!' } });
const tick = () => new Promise((r) => setTimeout(r, 0));

// ── Pages harness ──────────────────────────────────────────
function bodyBuf(body) { const b = Buffer.from(body, 'utf8'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
function resp(status, body) { return { status, arrayBuffer: async () => bodyBuf(body) }; }
const NEVER = () => new Promise(() => {});
// steps：每次 fetch 依序取一個：Response 物件、'network'（reject）、'hang'（永不 resolve）、函式
function pages(steps, opts) {
  opts = opts || {};
  const calls = [];
  const fetch = (url, init) => {
    calls.push({ url, t: Date.now(), init });
    const s = steps.length ? steps.shift() : resp(200, OK_BODY);
    if (s === 'network') return Promise.reject(new Error('TypeError: Failed to fetch ' + url));
    if (s === 'hang') return NEVER();
    if (typeof s === 'function') return s(url);
    return Promise.resolve(s);
  };
  const logs = [];
  const extra = Object.assign({
    console: { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) }
  }, opts.extra || {});
  if (opts.key) extra.localStorage = { getItem: () => opts.key, setItem() {}, removeItem() {} };
  const app = loadApp({ fetch, extra });
  app._spSetConfig(Object.assign({ SP_TIMEOUT_MS: 60, SP_RETRY_DELAY: 15 }, opts.config || {}));
  return { app, calls, logs };
}
const SP = (h, drug, rx) => h.app.suspectProportion(drug || 'Carbamazepine', rx || 'Stevens-Johnson syndrome');

// ── GAS harness ────────────────────────────────────────────
function gResp(status, body) { return { getResponseCode: () => status, getContentText: () => body }; }
function gas(steps, opts) {
  opts = opts || {};
  const calls = [], sleeps = [], puts = [];
  const store = new Map();
  const logs = [];
  const ctx = loadGas({
    console: { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) },
    CacheService: { getScriptCache: () => ({ get: (k) => (store.has(k) ? store.get(k) : null), put: (k, v, ttl) => { puts.push({ k, ttl }); store.set(k, v); } }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => opts.key || null }) },
    UrlFetchApp: { fetch: (url, o) => {
      calls.push({ url, o });
      const s = steps.length ? steps.shift() : gResp(200, OK_BODY);
      if (s === 'network') throw new Error('Exception: Address unavailable: ' + url);
      return s;
    } },
    Utilities: {
      sleep: (ms) => sleeps.push(ms), DigestAlgorithm: { MD5: 'md5' },
      computeDigest: (a, s) => Array.from(crypto.createHash('md5').update(String(s)).digest()).map((b) => (b > 127 ? b - 256 : b))
    }
  });
  if (opts.config) vm.runInContext('Object.assign(CONFIG, ' + JSON.stringify(opts.config) + ')', ctx);
  return { g: ctx, calls, sleeps, puts, store, logs };
}
const GSP = (h, drug, rx) => JSON.parse(JSON.stringify(h.g.suspectProportion(drug || 'Carbamazepine', rx || 'Stevens-Johnson syndrome')));

const ZERO_COUNTS = { sampled: 0, valid: 0, suspect: 0, interacting: 0, concomitant: 0, invalidRole: 0, combo: 0, ambiguous: 0, unmatched: 0,
  pct: null, lowSample: false, periodFrom: null, periodTo: null };
function assertEmptySummary(d) {
  for (const [k, v] of Object.entries(ZERO_COUNTS)) assert.equal(d[k], v, k);
  assert.equal(d.sampleMode, 'recent-receivedate');
}

// ── B1 ─────────────────────────────────────────────────────
test('B1 Pages：僅 404+NOT_FOUND 與 200+[] 為 empty，且 empty 會快取', async () => {
  let h = pages([resp(404, NF_BODY)]);
  let r = await SP(h);
  assert.equal(r.success, true); assertEmptySummary(r.data);
  r = await SP(h);
  assert.equal(r.success, true); assert.equal(h.calls.length, 1, '已快取：不再發請求');

  h = pages([resp(200, JSON.stringify({ results: [] }))]);
  r = await SP(h); assert.equal(r.success, true); assertEmptySummary(r.data);

  for (const body of ['<html>Not Found</html>', JSON.stringify({ error: { code: 'BAD_REQUEST' } })]) {
    h = pages([resp(404, body)]);
    r = await SP(h);
    assert.equal(r.success, false); assert.equal(r.reason, 'http'); assert.match(r.error, /HTTP 404/);
    assert.equal(h.calls.length, 1, '404 非 NOT_FOUND 不重試');
  }
});

test('B1 GAS：同上', () => {
  let h = gas([gResp(404, NF_BODY)]);
  let r = GSP(h); assert.equal(r.success, true); assertEmptySummary(r.data);
  r = GSP(h); assert.equal(r.cached, true); assert.equal(h.calls.length, 1);
  h = gas([gResp(404, '<html/>')]);
  r = GSP(h); assert.equal(r.success, false); assert.equal(r.reason, 'http'); assert.equal(h.calls.length, 1);
  h = gas([gResp(200, '{"results":[]}')]);
  r = GSP(h); assert.equal(r.success, true); assertEmptySummary(r.data);
});

// ── B2 ─────────────────────────────────────────────────────
test('B2 Pages：429／5xx／網路 重試一次、共用預算、間隔 ≥ SP_RETRY_DELAY、失敗不快取', async () => {
  const seqs = [
    [[resp(429, '{}'), resp(429, '{}')], false, /限速/],
    [[resp(500, '{}'), resp(503, '{}')], false, /伺服器錯誤 HTTP 503/],
    [['network', 'network'], false, /網路錯誤/],
    [[resp(429, '{}'), resp(500, '{}')], false, /伺服器錯誤 HTTP 500/],
    [[resp(429, '{}'), resp(200, OK_BODY)], true],
    [[resp(502, '{}'), resp(200, OK_BODY)], true],
    [['network', resp(200, OK_BODY)], true]
  ];
  for (const [steps, ok, msg] of seqs) {
    const h = pages(steps.slice());
    const r = await SP(h);
    assert.equal(h.calls.length, 2, '恰 2 次嘗試');
    assert.ok(h.calls[1].t - h.calls[0].t >= 15, '重試間隔');
    assert.equal(r.success, ok);
    if (ok) { assert.equal(r.data.sampled, 1); assert.equal(r.data.suspect, 1); assert.equal(r.data.pct, 100); }
    else {
      assert.match(r.error, msg);
      await SP(h);                                   // 失敗未快取：再次呼叫會重打（stub 預設回 200）
      assert.equal(h.calls.length, 3);
    }
  }
});

test('B2 Pages：預設重試延遲為 2000ms、逾時為 60s', async () => {
  const delays = [];
  const steps = [resp(429, '{}'), resp(200, OK_BODY)];
  const app = loadApp({
    fetch: () => Promise.resolve(steps.shift()),
    extra: { setTimeout: (fn, ms) => { delays.push(ms); return setTimeout(fn, ms === 2000 ? 0 : ms); } }
  });
  const r = await app.suspectProportion('Carbamazepine', 'SJS');
  assert.equal(r.success, true);
  assert.ok(delays.includes(2000), '重試前等待 2000ms：' + delays);
  assert.ok(delays.includes(60000), '每次嘗試期限 60000ms：' + delays);
  assert.equal(app._spErrorMessage('timeout'), '逾時（60s）');
});

// ── B3 ─────────────────────────────────────────────────────
test('B3 Pages：fetch 停滯、body 停滯、逾時→逾時 → error 逾時，無快取', async () => {
  const hangBody = () => Promise.resolve({ status: 200, arrayBuffer: NEVER });
  for (const steps of [['hang', 'hang'], [hangBody, hangBody], ['hang', hangBody]]) {
    const h = pages(steps.slice());
    const r = await SP(h);
    assert.equal(r.success, false); assert.equal(r.reason, 'timeout'); assert.match(r.error, /逾時/);
    assert.equal(h.calls.length, 2);
    assert.ok(h.calls[0].init && h.calls[0].init.signal, '傳入 AbortSignal');
    assert.equal(h.calls[0].init.signal.aborted, true, '逾時後中止請求');
    await SP(h); assert.equal(h.calls.length, 3, '逾時結果不入快取（再次呼叫會重打）');
  }
});

test('B3 Pages：逾時→200 成功', async () => {
  const h = pages(['hang', resp(200, OK_BODY)]);
  const r = await SP(h);
  assert.equal(r.success, true); assert.equal(h.calls.length, 2); assert.equal(r.data.suspect, 1);
});

test('B3 Pages：解析完成時已超過期限 → 逾時（不發布摘要）；晚到結果不翻轉終態', async () => {
  let now = 1e12;
  const FakeDate = function (...a) { return a.length ? new Date(...a) : new Date(now); };
  FakeDate.now = () => now; FakeDate.UTC = Date.UTC; FakeDate.prototype = Date.prototype;
  const slow = () => Promise.resolve({ status: 200, arrayBuffer: async () => { now += 1000; return bodyBuf(OK_BODY); } });
  let release;
  const late = () => new Promise((res) => { release = () => res(resp(200, OK_BODY)); });
  const h = pages([slow, late], { extra: { Date: FakeDate } });
  const p = SP(h);
  const r = await p;
  assert.equal(r.success, false); assert.equal(r.reason, 'timeout');
  release(); await tick(); await tick();
  assert.equal((await p).success, false, '終態不變');
  h.calls.length = 0;
  const r2 = await SP(h);                              // 新請求（預設回 200）
  assert.equal(h.calls.length, 1, '未被晚到結果寫入快取');
  assert.equal(r2.success, true);
});

// ── B4 ─────────────────────────────────────────────────────
test('B4 Pages：狀態碼優先於 body 格式；200 格式異常不重試', async () => {
  let h = pages([resp(429, '<html>'), resp(429, '<html>')]);
  let r = await SP(h); assert.equal(h.calls.length, 2); assert.equal(r.reason, 'ratelimit');
  h = pages([resp(500, '<html>'), resp(200, OK_BODY)]);
  r = await SP(h); assert.equal(h.calls.length, 2); assert.equal(r.success, true);
  for (const body of ['not json', OK_BODY.slice(0, 30), JSON.stringify({ error: { code: 'X' }, results: [REPORT] }), JSON.stringify({ results: {} })]) {
    h = pages([resp(200, body)]);
    r = await SP(h);
    assert.equal(r.success, false); assert.equal(r.reason, 'format'); assert.equal(r.error, '回應格式異常');
    assert.equal(h.calls.length, 1);
  }
  h = pages([resp(403, '{}')]);
  r = await SP(h); assert.equal(r.reason, 'http'); assert.match(r.error, /HTTP 403/); assert.equal(h.calls.length, 1);
});

// ── B5 ─────────────────────────────────────────────────────
test('B5 Pages：同 key 併發只 fetch 一次；不同 drug/reaction 隔離；失敗可重打', async () => {
  let release;
  const gate = () => new Promise((res) => { release = () => res(resp(200, OK_BODY)); });
  const h = pages([gate]);
  const ps = [SP(h), SP(h), SP(h, '  Carbamazepine  ')];
  await tick();
  assert.equal(h.calls.length, 1);
  release();
  const rs = await Promise.all(ps);
  assert.ok(rs.every((r) => r.success));
  await SP(h, 'Carbamazepine', 'Toxic epidermal necrolysis');
  await SP(h, 'Tegretol', 'Stevens-Johnson syndrome');
  assert.equal(h.calls.length, 3);
  assert.equal(h.app._spKey('A|B', 'C') === h.app._spKey('A', 'B|C'), false, 'key 無歧義');
});

test('B5 GAS：快取命中不打 HTTP；TTL 3600；key 含 reaction 且無歧義', () => {
  const h = gas([]);
  GSP(h); GSP(h);
  assert.equal(h.calls.length, 1);
  assert.equal(h.puts[0].ttl, 3600);
  assert.match(h.puts[0].k, /^sp1_[0-9a-f]{32}$/);
  GSP(h, 'Carbamazepine', 'Toxic epidermal necrolysis');
  assert.equal(h.calls.length, 2);
  GSP(h, 'A|B', 'C'); GSP(h, 'A', 'B|C');
  assert.equal(new Set(h.puts.map((p) => p.k)).size, 4);
});

// ── B6 ─────────────────────────────────────────────────────
test('B6 請求 URL 與 analyzeADR 的 a 查詢同一 search 表達式（有／無 key、特殊字元）', async () => {
  const expectSearch = (drug, rx) => {
    const v = drug.replace(/["\\]/g, '').trim();
    const tok = '(' + ['patient.drug.openfda.generic_name:"' + v + '"', 'patient.drug.openfda.brand_name:"' + v + '"',
      'patient.drug.medicinalproduct:"' + v + '"'].map(encodeURIComponent).join('+OR+') + ')';
    return tok + '+AND+' + encodeURIComponent('patient.reaction.reactionmeddrapt:"' + rx.replace(/["\\]/g, '').trim() + '"');
  };
  for (const [key, drug] of [[null, 'Carbamazepine'], [SENTINEL, 'A"B\\C']]) {
    const h = pages([], { key });
    await SP(h, drug, 'Stevens-Johnson syndrome');
    const g = gas([], { key });
    GSP(g, drug, 'Stevens-Johnson syndrome');
    for (const url of [h.calls[0].url, g.calls[0].url]) {
      assert.ok(url.startsWith('https://api.fda.gov/drug/event.json?'));
      const q = url.slice(url.indexOf('?') + 1).split('&');
      const kv = Object.fromEntries(q.map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]));
      assert.equal(kv.search, expectSearch(drug, 'Stevens-Johnson syndrome'));
      assert.equal(kv.limit, '100'); assert.equal(kv.sort, 'receivedate:desc');
      assert.equal(q.filter((p) => p.startsWith('search=')).length, 1);
      if (key) assert.equal(kv.api_key, key); else assert.equal('api_key' in kv, false);
    }
  }
});

// ── B7 ─────────────────────────────────────────────────────
test('B7 GAS：決策表各列終態、嘗試次數、sleep 參數；例外不捏造狀態碼', () => {
  const cases = [
    [['network', 'network'], false, 'network', 2],
    [[gResp(429, '{}'), gResp(429, '{}')], false, 'ratelimit', 2],
    [[gResp(500, '<html>'), gResp(200, OK_BODY)], true, null, 2],
    [[gResp(429, '{}'), gResp(500, '{}')], false, 'server', 2],
    [[gResp(404, NF_BODY)], true, null, 1],
    [[gResp(403, '{}')], false, 'http', 1],
    [[gResp(200, 'not json')], false, 'format', 1],
    [[gResp(200, JSON.stringify({ results: {} }))], false, 'format', 1]
  ];
  for (const [steps, ok, reason, n] of cases) {
    const h = gas(steps.slice());
    const r = GSP(h);
    assert.equal(r.success, ok, JSON.stringify(steps));
    assert.equal(h.calls.length, n);
    assert.deepEqual(h.sleeps, n === 2 ? [2000] : []);
    if (!ok) { assert.equal(r.reason, reason); assert.equal(h.puts.length, 0); }
    if (reason === 'network') assert.doesNotMatch(r.error, /\d{3}/);
    assert.equal(h.calls[0].o.muteHttpExceptions, true);
  }
});

// ── B8 ─────────────────────────────────────────────────────
test('B8 機密：錯誤路徑的回傳、訊息、console 不含 API key 或請求 URL', async () => {
  const outputs = [];
  for (const steps of [['network', 'network'], [resp(500, 'x'), resp(500, 'x')], [resp(200, 'not json')]]) {
    const h = pages(steps, { key: SENTINEL });
    outputs.push(JSON.stringify(await SP(h)), h.logs.join('\n'));
  }
  const throwingFetch = () => { throw new Error('boom ' + 'https://' + ENDPOINT_FRAG + 'api_key=' + SENTINEL); };
  const h2 = pages([throwingFetch], { key: SENTINEL });
  outputs.push(JSON.stringify(await SP(h2)), h2.logs.join('\n'));
  for (const steps of [['network', 'network'], [gResp(500, 'x'), gResp(500, 'x')], [gResp(200, 'not json')]]) {
    const g = gas(steps, { key: SENTINEL });
    outputs.push(JSON.stringify(GSP(g)), g.logs.join('\n'));
  }
  const g2 = gas([], { key: SENTINEL });
  // fetch 正常回 200，讓流程走到 _spSummary 並在其中拋出含 URL/key 的例外 → 驗證外層 catch 不外洩
  vm.runInContext('_spSummary = function () { throw new Error("leak https://' + ENDPOINT_FRAG + 'api_key=' + SENTINEL + '"); }', g2.g);
  const r2 = GSP(g2);
  assert.equal(r2.reason, 'internal', '確實走到外層 catch');
  outputs.push(JSON.stringify(r2));
  for (const o of outputs) {
    assert.equal(o.includes(SENTINEL), false, o);
    assert.equal(o.includes(ENDPOINT_FRAG), false, o);
  }
});

// ── B9 ─────────────────────────────────────────────────────
test('B9 位元組上限：等於上限通過、+1 失敗；多位元組以位元組計（兩端）', async () => {
  const L = Buffer.byteLength(OK_BODY, 'utf8');
  let h = pages([resp(200, OK_BODY)], { config: { SP_MAX_BYTES: L } });
  assert.equal((await SP(h)).success, true);
  h = pages([resp(200, OK_BODY)], { config: { SP_MAX_BYTES: L - 1 } });
  let r = await SP(h); assert.equal(r.reason, 'toolarge'); assert.equal(h.calls.length, 1);

  const mb = JSON.stringify({ results: [REPORT], note: '中中中中中中' });
  const chars = mb.length, bytes = Buffer.byteLength(mb, 'utf8');
  assert.ok(bytes > chars);
  h = pages([resp(200, mb)], { config: { SP_MAX_BYTES: chars } });
  r = await SP(h); assert.equal(r.reason, 'toolarge', '字元數未超但位元組超');

  let g = gas([gResp(200, OK_BODY)], { config: { SP_MAX_BYTES: L } });
  assert.equal(GSP(g).success, true);
  g = gas([gResp(200, OK_BODY)], { config: { SP_MAX_BYTES: L - 1 } });
  assert.equal(GSP(g).reason, 'toolarge');
  g = gas([gResp(200, mb)], { config: { SP_MAX_BYTES: chars } });
  assert.equal(GSP(g).reason, 'toolarge');
  g = gas([gResp(200, mb)], { config: { SP_MAX_BYTES: bytes } });
  assert.equal(GSP(g).success, true);
  // 代理字元（4 位元組）
  const app = loadApp();
  assert.equal(app._spUtf8Over('😀', 4), false); assert.equal(app._spUtf8Over('😀', 3), true);
});

test('兩端回應判定與錯誤訊息一致', () => {
  const app = loadApp(); const g = loadGas();
  const J = (x) => JSON.parse(JSON.stringify(x));
  const inputs = [[429, false, ''], [500, false, ''], [599, false, ''], [404, false, NF_BODY], [404, false, 'x'], [418, false, OK_BODY],
    [200, true, OK_BODY], [200, false, 'x'], [200, false, '{"results":[]}'], [200, false, OK_BODY], [200, false, 'null']];
  for (const i of inputs) assert.deepEqual(J(g._spClassifyResponse(...i)), J(app._spClassifyResponse(...i)), String(i));
  for (const [reason, status] of [['network'], ['timeout'], ['ratelimit', 429], ['server', 502], ['http', 403], ['toolarge', 200], ['format', 200], ['x']]) {
    assert.equal(g._spErrorMessage(reason, status), app._spErrorMessage(reason, status));
  }
});

test('空藥名或空症狀：不發請求', async () => {
  const h = pages([]);
  assert.equal((await h.app.suspectProportion('  ', 'SJS')).success, false);
  assert.equal((await h.app.suspectProportion('X', '""')).success, false);
  assert.equal(h.calls.length, 0);
  const g = gas([]);
  assert.equal(g.g.suspectProportion('', 'SJS').success, false);
  assert.equal(g.calls.length, 0);
});
