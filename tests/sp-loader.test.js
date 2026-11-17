'use strict';
// 疑似藥比例前端 controller（plan §8 D1–D7）：以 vm 載入 HTML 內 <sp-loader> 區塊（實際程式），假時鐘控制排程。
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const { read } = require('./_load');

const BEGIN = '// <sp-loader:begin>', END = '// <sp-loader:end>';
function block(file) {
  const h = read(file);
  const i = h.indexOf(BEGIN), j = h.indexOf(END);
  if (i < 0 || j < 0) throw new Error('sp-loader block not found in ' + file);
  return h.slice(i, j + END.length);
}
function loadSP(extra) {
  const ctx = Object.assign({ Promise, JSON, Math, Date, Object, String, Number, isFinite }, extra || {});
  vm.createContext(ctx);
  vm.runInContext(block('Index.html') + '\nthis.SPLoader = SPLoader;', ctx, { filename: 'sp-loader' });
  return ctx.SPLoader;
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

// 假時鐘
function clock() {
  let t = 0, id = 0;
  const timers = [];
  return {
    now: () => t,
    setTimeout: (fn, ms) => { timers.push({ id: ++id, at: t + ms, fn }); return id; },
    clearTimeout: (x) => { const k = timers.findIndex((q) => q.id === x); if (k > -1) timers.splice(k, 1); },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        if (!timers.length || timers[0].at > end) break;
        const q = timers.shift(); t = q.at; q.fn(); await flush();
      }
      t = end; await flush();
    }
  };
}
// 可控 transport：每次呼叫回一個待決 Promise
function deferredTransport() {
  const calls = [];
  const fn = (drug, reaction) => new Promise((resolve) => calls.push({ drug, reaction, resolve }));
  return { fn, calls };
}
const SUM = (o) => Object.assign({ sampled: 100, valid: 100, suspect: 87, interacting: 2, concomitant: 11, invalidRole: 0, combo: 0,
  ambiguous: 0, unmatched: 0, pct: 89, lowSample: false, periodFrom: '2024-03-11', periodTo: '2026-09-28' }, o || {});

function setup(opts) {
  opts = opts || {};
  const SP = loadSP();
  const c = clock();
  const t = deferredTransport();
  const changes = [];
  const ctl = SP.create({ transport: t.fn, sleepMs: () => opts.sleep || 1800, now: c.now, setTimeout: c.setTimeout,
    clearTimeout: c.clearTimeout, watchdogMs: opts.watchdog || 0, onChange: (k) => changes.push(k) });
  return { SP, c, t, ctl, changes };
}
const RX = 'Stevens-Johnson syndrome';

test('D1 只查被點的列；同時至多 1 個工作；前一工作結束後間隔 ≥ sleepMs 才開始下一個', async () => {
  const { c, t, ctl } = setup();
  assert.equal(ctl.request('Carbamazepine', RX), true);
  assert.equal(ctl.request('Phenytoin', RX), true);
  assert.equal(ctl.get('Carbamazepine', RX).status, 'queued');
  await c.advance(0);
  assert.equal(t.calls.length, 1);
  assert.deepEqual([t.calls[0].drug, t.calls[0].reaction], ['Carbamazepine', RX]);
  assert.equal(ctl.get('Carbamazepine', RX).status, 'loading');
  assert.equal(ctl.get('Phenytoin', RX).status, 'queued');
  assert.equal(ctl.get('Allopurinol', RX).status, 'idle', '未點的列維持 idle');
  assert.equal(ctl.request('Carbamazepine', RX), false, 'loading 中再點不新增');
  assert.equal(ctl.request('Phenytoin', RX), false, 'queued 中再點不新增');
  await c.advance(5000);
  assert.equal(t.calls.length, 1, '前一工作未結束，不得開始下一個');
  t.calls[0].resolve({ success: true, data: SUM() });
  await flush();
  await c.advance(1799);
  assert.equal(t.calls.length, 1, '結束後未滿 sleepMs');
  await c.advance(1);
  assert.equal(t.calls.length, 2);
  assert.equal(t.calls[1].drug, 'Phenytoin');
});

test('D2 狀態轉移與顯示格式', async () => {
  const { SP, c, t, ctl } = setup();
  ctl.request('A', RX); await c.advance(0);
  t.calls[0].resolve({ success: false, error: 'openFDA 限速，請稍後重試或設定 API Key' }); await flush();
  assert.deepEqual([ctl.get('A', RX).status, ctl.get('A', RX).error], ['error', 'openFDA 限速，請稍後重試或設定 API Key']);
  assert.equal(ctl.request('A', RX), true, 'error 可重試');
  await c.advance(1800);
  t.calls[1].resolve({ success: true, data: SUM() }); await flush();
  assert.equal(ctl.get('A', RX).status, 'done');

  ctl.request('B', RX); await c.advance(1800);
  t.calls[2].resolve({ success: true, data: SUM({ sampled: 0, valid: 0, suspect: 0, interacting: 0, concomitant: 0, pct: null }) }); await flush();
  assert.equal(ctl.get('B', RX).status, 'empty', 'sampled=0 → empty');
  ctl.request('C', RX); await c.advance(1800);
  t.calls[3].resolve({ success: true, data: SUM({ sampled: 5, valid: 0, suspect: 0, interacting: 0, concomitant: 0, combo: 5, pct: null }) }); await flush();
  assert.equal(ctl.get('C', RX).status, 'done', 'sampled>0 且 valid=0 → done（顯示資料不足）');

  const f = (o) => JSON.parse(JSON.stringify(SP.format(SUM(o))));
  assert.deepEqual(f({ valid: 0, suspect: 0, interacting: 0, concomitant: 0, pct: null }), { text: '資料不足', insufficient: true, low: false, n: 0 });
  assert.deepEqual(f({ valid: 1, suspect: 1, interacting: 0, concomitant: 0, pct: 100, lowSample: true }), { text: '100% (n=1)', insufficient: false, low: true, n: 1 });
  assert.deepEqual(f({ valid: 9, suspect: 6, interacting: 0, concomitant: 3, pct: 67, lowSample: true }), { text: '67% (n=9)', insufficient: false, low: true, n: 9 });
  assert.deepEqual(f({ valid: 10, suspect: 3, interacting: 0, concomitant: 7, pct: 30, lowSample: false }), { text: '30% (n=10)', insufficient: false, low: false, n: 10 });
  assert.deepEqual(f({ valid: 4, suspect: 0, interacting: 0, concomitant: 4, pct: 0, lowSample: true }), { text: '0% (n=4)', insufficient: false, low: true, n: 4 });
  assert.equal(f({ valid: 5, suspect: 5, interacting: 0, concomitant: 0, pct: 100, lowSample: 'yes' }).low, false, 'lowSample 僅接受布林 true');
  // A12：n 取自 S+I+C，不讀 sampled
  assert.equal(SP.format(SUM({ sampled: 47, valid: 42, suspect: 20, interacting: 5, concomitant: 17, pct: 60 })).text, '60% (n=42)');
  assert.equal(SP.format(SUM({ sampled: 50, valid: 10, suspect: 3, interacting: 0, concomitant: 7, pct: 30 })).text, '30% (n=10)');
});

test('D3 細項列取值正確、計數總和＝抽樣數、說明文字固定', () => {
  const SP = loadSP();
  const a = SUM({ sampled: 47, valid: 42, suspect: 20, interacting: 5, concomitant: 17, invalidRole: 2, combo: 1, ambiguous: 1, unmatched: 1 });
  const b = SUM({ sampled: 3, valid: 0, suspect: 0, interacting: 0, concomitant: 0, combo: 3, periodFrom: null, periodTo: null, pct: null });
  const ra = Object.fromEntries(SP.detailRows(a)), rb = Object.fromEntries(SP.detailRows(b));
  assert.equal(ra['抽樣通報數'], '47'); assert.equal(ra['有效分母（S+I+C）'], '42');
  assert.equal(ra['Suspect（疑似藥）'], '20'); assert.equal(ra['Interacting（交互作用藥）'], '5'); assert.equal(ra['Concomitant（併用藥）'], '17');
  assert.equal(ra['角色缺漏或無效（排除）'], '2'); assert.equal(ra['複方（排除）'], '1'); assert.equal(ra['成分無法確認（排除）'], '1');
  assert.equal(ra['未對應到目標藥（排除）'], '1'); assert.equal(ra['抽樣期間（FDA 收件日）'], '2024-03-11 ～ 2026-09-28');
  const sum = (r) => ['Suspect（疑似藥）', 'Interacting（交互作用藥）', 'Concomitant（併用藥）', '角色缺漏或無效（排除）', '複方（排除）',
    '成分無法確認（排除）', '未對應到目標藥（排除）'].reduce((s, k) => s + Number(r[k]), 0);
  assert.equal(sum(ra), 47); assert.equal(sum(rb), 3);
  assert.equal(rb['抽樣期間（FDA 收件日）'], '—');
  assert.equal(SP.NOTE, '疑似藥比例表示抽樣 FAERS 通報中，目標藥物被標記為 Suspect 或 Interacting 的比例，並非 ADR 發生率或因果機率。');
  const lim = SP.LIMITS.join('\n');
  for (const re of [/非隨機/, /100 筆/, /notoriety bias/, /不可用兩藥比例差/, /通報層級/, /PS／SS/, /不納入綜合分數/, /不代表已確認因果/]) assert.match(lim, re);
});

test('D5 重繪不重送、換 ADR 隔離、watchdog 釋放佇列並丟棄晚到結果、重試後舊結果不覆蓋', async () => {
  const { c, t, ctl } = setup({ watchdog: 150000 });
  ctl.request('Vanco', 'SJS'); await c.advance(0);
  assert.equal(ctl.request('Vanco', 'SJS'), false);           // 重繪時列只呼叫 get；再點不新增
  ctl.request('Vanco', 'TEN');                                // 換 ADR：不同 key
  assert.equal(ctl.get('Vanco', 'TEN').status, 'queued');
  await c.advance(150000);                                    // watchdog
  assert.equal(ctl.get('Vanco', 'SJS').status, 'error');
  assert.match(ctl.get('Vanco', 'SJS').error, /150 秒/);
  await c.advance(1800);
  assert.equal(t.calls.length, 2, 'watchdog 後下一工作開始');
  assert.equal(t.calls[1].reaction, 'TEN');
  t.calls[0].resolve({ success: true, data: SUM({ pct: 1 }) }); await flush();
  assert.equal(ctl.get('Vanco', 'SJS').status, 'error', '晚到結果不翻轉終態');
  assert.equal(ctl.get('Vanco', 'TEN').status, 'loading', '不影響其他 key');
  t.calls[1].resolve({ success: true, data: SUM() }); await flush();
  assert.equal(ctl.get('Vanco', 'TEN').status, 'done');
  assert.equal(ctl.request('Vanco', 'TEN'), false, 'done 重繪不重送');
  // 同 key 重試：新請求完成後，舊（watchdog 前）結果早已被丟棄；再驗新結果正確寫入
  ctl.request('Vanco', 'SJS'); await c.advance(1800);
  t.calls[2].resolve({ success: true, data: SUM({ pct: 55 }) }); await flush();
  assert.equal(ctl.get('Vanco', 'SJS').data.pct, 55);
  // transport 同步拋例外 → error，佇列不卡住
  const s2 = setup();
  const SP2 = s2.SP;
  const ctl2 = SP2.create({ transport: () => { throw new Error('x'); }, sleepMs: () => 0, now: s2.c.now, setTimeout: s2.c.setTimeout,
    clearTimeout: s2.c.clearTimeout, watchdogMs: 0 });
  ctl2.request('A', RX); ctl2.request('B', RX);
  await s2.c.advance(0); await s2.c.advance(0);
  assert.equal(ctl2.get('A', RX).status, 'error'); assert.equal(ctl2.get('B', RX).status, 'error');
});

test('D5 key 與引擎一致：_clean 規則、無歧義', () => {
  const SP = loadSP();
  assert.equal(SP.key('  Carbamazepine ', RX), SP.key('Carbamazepine', RX));
  assert.equal(SP.key('A"B\\C', RX), JSON.stringify(['ABC', RX]));
  assert.notEqual(SP.key('A|B', 'C'), SP.key('A', 'B|C'));
  const { loadApp } = require('./_load');
  const app = loadApp();
  for (const [d, r] of [['  Carbamazepine ', RX], ['A"B\\C', 'x'], ['A|B', 'C']]) assert.equal(SP.key(d, r), app._spKey(d, r));
});

test('D6 transport 選擇：GAS（google.script.run，含 watchdog）與 Pages（FAERSApp）', async () => {
  const SP = loadSP();
  // GAS stub
  const runCalls = [];
  function runner() {
    let ok, fail;
    const r = {
      withSuccessHandler(f) { ok = f; return r; },
      withFailureHandler(f) { fail = f; return r; },
      suspectProportion(d, x) { runCalls.push({ d, x, ok, fail }); }
    };
    return r;
  }
  const gEnv = { google: { script: { get run() { return runner(); } } }, setTimeout, clearTimeout };
  const gd = SP.defaults(gEnv, null);
  assert.equal(gd.watchdogMs, 150000);
  const p1 = gd.transport('Vanco', 'SJS');
  assert.deepEqual([runCalls[0].d, runCalls[0].x], ['Vanco', 'SJS']);
  runCalls[0].ok({ success: true, data: SUM() });
  assert.equal((await p1).success, true);
  const p2 = gd.transport('Vanco', 'TEN');
  runCalls[1].fail(new Error('Exception: https://api.fda.gov/drug/event.json?api_key=SECRET'));
  const r2 = await p2;
  assert.equal(r2.success, false); assert.doesNotMatch(r2.error, /api_key|SECRET|api\.fda/);
  // Pages stub
  const fa = []; const pEnv = { FAERSApp: { suspectProportion: (d, x) => { fa.push([d, x]); return Promise.resolve({ success: true, data: SUM() }); } }, setTimeout, clearTimeout };
  const pd = SP.defaults(pEnv, null);
  assert.equal(pd.watchdogMs, 0);
  assert.equal((await pd.transport('Vanco', 'SJS')).success, true);
  assert.deepEqual(fa, [['Vanco', 'SJS']]);
  // 節流間隔依 key 狀態
  assert.equal(pd.sleepMs(), 1800); SP.setHasKey(true); assert.equal(pd.sleepMs(), 300); SP.setHasKey('yes'); assert.equal(pd.sleepMs(), 1800);
});

test('D7 兩版 HTML 的 sp-loader 區塊逐字相同；兩版表格都有疑似藥比例欄並接上 controller', () => {
  assert.equal(block('Index.html'), block('docs/index.html'));
  for (const f of ['Index.html', 'docs/index.html']) {
    const h = read(f);
    assert.match(h, /'綜合分數','因果評估','疑似藥比例'\]/);
    assert.match(h, /spPaint\(spE\);/); assert.match(h, /tr\.appendChild\(asTd\);\r?\n\s*tr\.appendChild\(spTd\);/);
    assert.match(h, /tbl\.appendChild\(det\);/);
    assert.doesNotMatch(block(f), /innerHTML|alert\(/);
  }
});
