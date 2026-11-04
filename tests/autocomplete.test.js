'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSuggest, suggestBlock, read } = require('./_load');

const J = (x) => JSON.parse(JSON.stringify(x));
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));

// 依 2026-11 實測 openFDA / RxNav 回應節錄
const NDC = {
  'generic_name:vanco*': [
    { term: 'Vancomycin Hydrochloride', count: 77 }, { term: 'VANCOMYCIN HYDROCHLORIDE', count: 42 },
    { term: 'vancomycin hydrochloride', count: 41 }, { term: 'Vancomycin', count: 15 },
    { term: 'Vancomycin HCL', count: 3 }, { term: 'Vancomycin Hydrochloride, Lyophilized', count: 1 }
  ],
  'brand_name:vanco*': [
    { term: 'Vancomycin Hydrochloride', count: 92 }, { term: 'Vancomycin', count: 9 },
    { term: 'Vancomycin Hydrochloride for Oral Solution', count: 4 }, { term: 'Vancocin', count: 2 }
  ],
  'brand_name.exact:"Vancocin"': [{ term: 'vancomycin hydrochloride', count: 2 }],
  'generic_name:zosy*': null,
  'brand_name:zosy*': [{ term: 'Zosyn', count: 3 }, { term: 'Zosyn in Galaxy Containers', count: 3 }],
  'brand_name.exact:"Zosyn"': [{ term: 'Piperacillin and Tazobactam', count: 3 }],
  'brand_name.exact:"Zosyn in Galaxy Containers"': [{ term: 'Piperacillin and Tazobactam', count: 3 }],
  'generic_name:cefep*': [{ term: 'Cefepime', count: 15 }, { term: 'CEFEPIME HYDROCHLORIDE', count: 5 }, { term: 'Cefepime Hydrochloride', count: 5 }],
  'brand_name:cefep*': [{ term: 'Cefepime', count: 10 }],
  'generic_name:vancomycn*': null, 'brand_name:vancomycn*': null
};
const RX = {
  'approximateTerm.json?term=vancomycn': { approximateGroup: { candidate: [
    { rxcui: '11124', rank: '1', source: 'USP', name: 'Vancomycin' }, { rxcui: '11124', rank: '1', source: 'GS' },
    { rxcui: '1187337', rank: '3', source: 'RXNORM', name: 'Vancocin Pill' }] } },
  'rxcui/11124/properties.json': { properties: { rxcui: '11124', name: 'vancomycin', tty: 'IN' } },
  'rxcui/1187337/properties.json': { properties: { rxcui: '1187337', name: 'Vancocin Pill', tty: 'DFG' } }
};

// 路由式假 transport：回傳 { fetchJson, calls }；delay(url) 可控延遲；fail(url) 可回錯誤型別
function mockTransport(opt) {
  opt = opt || {};
  const calls = [];
  const fetchJson = (url, signal) => {
    calls.push({ url, signal });
    return new Promise((resolve, reject) => {
      const done = () => {
        if (signal && signal.aborted) { const e = new Error('abort'); e.type = 'abort'; return reject(e); }
        const ft = opt.fail && opt.fail(url);
        if (ft) { const e = new Error(ft); e.type = ft; return reject(e); }
        if (url.startsWith('https://api.fda.gov/drug/ndc.json')) {
          const k = Object.keys(NDC).find((key) => url.includes('search=' + key.replace(/"(.*)"/, (m, p) => '"' + encodeURIComponent(p) + '"') + '&'));
          return resolve({ results: k && NDC[k] ? NDC[k] : [] });
        }
        const rk = Object.keys(RX).find((key) => url.includes(key));
        resolve(rk ? RX[rk] : {});
      };
      const d = opt.delay ? opt.delay(url) : 0;
      if (d) {
        const t = setTimeout(done, d);
        if (signal) signal.addEventListener('abort', () => { clearTimeout(t); done(); });
      } else done();
    });
  };
  return { fetchJson, calls };
}
const fresh = () => ({ blockedUntil: 0, cache: new Map() });

test('區塊一致：Index.html 與 docs/index.html 的 DrugSuggest 逐字相同', () => {
  assert.equal(suggestBlock('Index.html'), suggestBlock('docs/index.html'));
});

test('學名前綴 vanco：prefix wildcard、鹽類分列、商品名附成分、學名劑型不當商品名', async () => {
  const { DS } = loadSuggest();
  const m = mockTransport();
  const res = J(await DS.search('vanco', { fetchJson: m.fetchJson }));
  assert.equal(res.status, 'ok');
  assert.ok(m.calls.some((c) => c.url.includes('search=generic_name:vanco*&count=generic_name.exact')));
  const names = res.items.map((i) => i.name + ' — ' + i.label);
  assert.deepEqual(names, [
    'Vancomycin — Generic',
    'Vancomycin Hydrochloride — Ingredient / Salt form',
    'Vancomycin Hydrochloride, Lyophilized — Ingredient / Salt form',
    'Vancocin — Brand (Vancomycin Hydrochloride)'
  ]);
  assert.ok(res.items.length <= DS.CONFIG.MAX_ITEMS);
  // HCL 與 Hydrochloride 為同一鹽類寫法 → 合併（計數加總）；Vancomycin（無鹽）獨立
  assert.equal(res.items[1].count, 77 + 42 + 41 + 3);
  assert.equal(res.items.find((i) => i.kind === 'brand').brandName, 'Vancocin');
});

test('商品名 zosy：保留商品名為 queryName，不自動轉成分；標示複方', async () => {
  const { DS } = loadSuggest();
  const res = J(await DS.search('zosy', { fetchJson: mockTransport().fetchJson }));
  assert.equal(res.status, 'ok');
  const z = res.items.find((i) => i.name === 'Zosyn');
  assert.equal(z.kind, 'brand');
  assert.equal(z.label, 'Brand (Piperacillin and Tazobactam) · 複方/多成分');
  const info = J(DS.toNameInfo(z));
  assert.equal(info.queryName, 'Zosyn');
  assert.equal(info.brandName, 'Zosyn');
  assert.equal(info.genericName, 'Piperacillin and Tazobactam');
  assert.equal(info.verified, true);
});

test('cefep 前綴 → Cefepime 排第一', async () => {
  const { DS } = loadSuggest();
  const res = J(await DS.search('cefep', { fetchJson: mockTransport().fetchJson }));
  assert.equal(res.items[0].name, 'Cefepime');
  assert.equal(res.items[1].kind, 'salt');
});

test('拼字錯誤 vancomycn → RxNorm 近似建議，排除劑型層級；不自動採用', async () => {
  const { DS } = loadSuggest();
  const res = J(await DS.search('vancomycn', { fetchJson: mockTransport().fetchJson }));
  assert.equal(res.status, 'ok');
  assert.equal(res.fuzzy, true);
  assert.deepEqual(res.items.map((i) => [i.name, i.source, i.rxcui]), [['Vancomycin', 'rxnorm-approx', '11124']]);
  assert.match(res.items[0].label, /^RxNorm 近似 · Generic \(IN\)$/);
  // 未點選前，輸入的錯字仍為「未確認」
  assert.deepEqual(J(DS.unconfirmedNames([{ name: 'vancomycn', sel: null }])), ['vancomycn']);
});

test('少於 3 個英文字母 / 非英文 → 不送出查詢', async () => {
  const { DS } = loadSuggest();
  const m = mockTransport();
  for (const q of ['va', '萬古黴素', '12 3', '  v-a ']) {
    const res = await DS.search(q, { fetchJson: m.fetchJson });
    assert.equal(res.status, 'idle');
  }
  assert.equal(m.calls.length, 0);
});

test('debounce：快速連續輸入只查最後一次', async () => {
  const { DS } = loadSuggest();
  const m = mockTransport();
  const ups = [];
  const s = DS.createSearcher({ fetchJson: m.fetchJson, debounceMs: 30, state: fresh(), onUpdate: (u) => ups.push(J(u)) });
  s.input('van'); s.input('vanc'); s.input('vanco');
  await tick(80);
  assert.ok(m.calls.every((c) => /vanco[*"]|Vancocin/.test(decodeURIComponent(c.url))), JSON.stringify(m.calls.map((c) => c.url)));
  assert.equal(ups.filter((u) => u.status === 'ok').length, 1);
});

test('race condition：舊查詢較慢晚到 → 被 abort 並丟棄，只保留最新結果', async () => {
  const { DS } = loadSuggest();
  const m = mockTransport({ delay: (url) => (url.includes('vanco') ? 60 : 5) });
  const ups = [];
  const s = DS.createSearcher({ fetchJson: m.fetchJson, debounceMs: 0, state: fresh(), onUpdate: (u) => ups.push(J(u)) });
  s.input('vanco');
  await tick(10);                // vanco 已送出、尚未回來
  s.input('cefep');
  await tick(120);
  const done = ups.filter((u) => u.status !== 'loading');
  assert.equal(done.length, 1);
  assert.equal(done[0].query, 'cefep');
  assert.ok(m.calls.filter((c) => c.url.includes('vanco')).every((c) => c.signal.aborted), '舊請求應被 abort');
});

test('快取：相同查詢第二次不打 API', async () => {
  const { DS } = loadSuggest();
  const m = mockTransport();
  const st = fresh(), ups = [];
  const s = DS.createSearcher({ fetchJson: m.fetchJson, debounceMs: 0, state: st, onUpdate: (u) => ups.push(J(u)) });
  s.input('cefep'); await tick(20);
  const n = m.calls.length;
  s.input('CEFEP'); await tick(20);
  assert.equal(m.calls.length, n);
  assert.equal(ups[ups.length - 1].status, 'ok');
});

test('網路失敗 → status=error（可手動輸入）；429 → rate_limited 並冷卻不再送出', async () => {
  const { DS } = loadSuggest();
  const err = mockTransport({ fail: () => 'error' });
  const r1 = J(await DS.search('vanco', { fetchJson: err.fetchJson }));
  assert.deepEqual([r1.status, r1.items.length], ['error', 0]);

  const lim = mockTransport({ fail: () => 'rate_limited' });
  const st = fresh(), ups = [];
  const s = DS.createSearcher({ fetchJson: lim.fetchJson, debounceMs: 0, state: st, onUpdate: (u) => ups.push(J(u)) });
  s.input('vanco'); await tick(20);
  assert.equal(ups[ups.length - 1].status, 'rate_limited');
  assert.ok(st.blockedUntil > Date.now());
  const n = lim.calls.length;
  s.input('cefep'); await tick(20);
  assert.equal(lim.calls.length, n, '冷卻期間不應再送出請求');
  assert.equal(ups[ups.length - 1].status, 'rate_limited');
  assert.equal(st.cache.size, 0, '錯誤結果不快取');
});

test('預設 fetchJson：429 / NOT_FOUND / 網路錯誤 / timeout 的對應', async () => {
  const mk = (impl) => loadSuggest({ fetch: impl }).DS;
  const e429 = await mk(async () => ({ status: 429, ok: false, json: async () => ({}) })).fetchJson('u').catch((e) => e.type);
  assert.equal(e429, 'rate_limited');
  const nf = await mk(async () => ({ status: 404, ok: false, json: async () => ({ error: { code: 'NOT_FOUND' } }) })).fetchJson('u');
  assert.deepEqual(J(nf), { results: [] });
  const net = await mk(async () => { throw new TypeError('Failed to fetch'); }).fetchJson('u').catch((e) => e.type);
  assert.equal(net, 'error');
  const DS = mk((url, init) => new Promise((res, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))));
  DS.CONFIG.TIMEOUT_MS = 20;
  assert.equal(await DS.fetchJson('u').catch((e) => e.type), 'timeout');
  const ac = new AbortController();
  const p = DS.fetchJson('u', ac.signal).catch((e) => e.type);
  ac.abort();
  assert.equal(await p, 'abort');
});

test('選定後再修改文字 → 清除確認狀態', () => {
  const { DS } = loadSuggest();
  const sel = DS.toNameInfo({ name: 'Vancomycin', label: 'Generic', kind: 'generic', source: 'openfda-ndc', genericName: 'Vancomycin' });
  assert.equal(DS.stillConfirmed(sel, 'Vancomycin'), true);
  assert.equal(DS.stillConfirmed(sel, ' Vancomycin '), true);
  assert.equal(DS.stillConfirmed(sel, 'Vancomycinx'), false);
  assert.equal(DS.stillConfirmed(sel, 'vancomycin'), false, '大小寫改動也視為修改');
  assert.deepEqual(J(DS.unconfirmedNames([{ name: 'Vancomycinx', sel }])), ['Vancomycinx']);
});

test('複方與鹽類不被錯誤合併', () => {
  const { DS } = loadSuggest();
  const terms = J(DS.dedupeTerms([
    { term: 'Piperacillin and Tazobactam', count: 25 }, { term: 'Piperacillin', count: 7 },
    { term: 'Piperacillin Sodium', count: 3 }, { term: 'PIPERACILLIN SODIUM,TAZOBACTAM SODIUM', count: 9 },
    { term: 'Amoxicillin', count: 272 }, { term: 'Amoxicillin and Clavulanate Potassium', count: 183 },
    { term: 'Metoprolol Tartrate', count: 50 }, { term: 'Metoprolol Succinate', count: 40 }
  ], null));
  assert.equal(terms.length, 8, '8 個不同成分/鹽類/複方須各自保留');
  const kinds = Object.fromEntries(terms.map((t) => [t.term, DS.classify(t.term)]));
  assert.equal(kinds['Piperacillin and Tazobactam'], 'combo');
  assert.equal(kinds['Piperacillin Sodium,tazobactam Sodium'] || kinds['Piperacillin Sodium,Tazobactam Sodium'], 'combo');
  assert.equal(kinds['Piperacillin'], 'generic');
  assert.equal(kinds['Piperacillin Sodium'], 'salt');
  assert.equal(kinds['Amoxicillin and Clavulanate Potassium'], 'combo');
  assert.equal(kinds['Metoprolol Tartrate'], 'salt');
  assert.equal(DS.classify('Vancomycin Hydrochloride, Lyophilized'), 'salt', '描述字逗號不是複方');
  assert.equal(DS.classify('Amoxicillin/Clav Pot'), 'combo');
});

test('手動輸入：未確認時列為待確認；明確確認後可執行但仍標示 verified=false', () => {
  const { DS } = loadSuggest();
  assert.deepEqual(J(DS.unconfirmedNames([{ name: 'MyDrugX', sel: null, manualConfirmed: false }])), ['MyDrugX']);
  assert.deepEqual(J(DS.unconfirmedNames([{ name: 'MyDrugX', sel: null, manualConfirmed: true }])), []);
  const info = J(DS.manualInfo(' MyDrugX ', true));
  assert.deepEqual([info.queryName, info.source, info.verified, info.manualConfirmed], ['MyDrugX', 'manual', false, true]);
  // 執行按鈕：兩版 HTML 皆在未確認時先顯示 inline 提醒（不用 alert）
  for (const f of ['Index.html', 'docs/index.html']) {
    const h = read(f);
    assert.match(h, /if\(pending\.length\)\{ showUnverified\(pending\); return; \}/, f);
    assert.match(h, /id="confirmUnverifiedBtn"/, f);
    assert.ok(!/\balert\(/.test(h.replace(/onerror=alert\(1\)/g, '')), f + ' 不得使用 alert()');
  }
});

// ── DOM 互動（最小假 DOM）：Enter 不自動選第一筆、方向鍵+Enter 選取、修改後清除確認 ──
function fakeDom() {
  function el(tag) {
    const e = { tag, children: [], listeners: {}, attrs: {}, hidden: false, className: '', value: '', _text: '',
      classList: { toggle(c, on) { e['cls_' + c] = on; } },
      setAttribute(k, v) { e.attrs[k] = v; }, scrollIntoView() {},
      addEventListener(t, fn) { (e.listeners[t] = e.listeners[t] || []).push(fn); },
      appendChild(c) { e.children.push(c); return c; },
      fire(t, ev) { (e.listeners[t] || []).forEach((fn) => fn(Object.assign({ preventDefault() {}, key: '' }, ev))); }
    };
    Object.defineProperty(e, 'textContent', { get() { return e._text; }, set(v) { e._text = String(v); if (v === '') e.children = []; } });
    return e;
  }
  const document = { activeElement: null, createElement: el };
  return { document, el };
}

test('DOM：Enter 不自動採用第一筆；↓+Enter 選取後確認；再修改即清除', async () => {
  const { document, el } = fakeDom();
  const m = mockTransport();
  const { DS } = loadSuggest({ document });
  const inp = el('input'), dd = el('div'), st = el('div');
  document.activeElement = inp;
  const ctl = DS.attach(inp, { dropdown: dd, status: st, onChange() {} });
  // 先以假 transport 取得結果並放入共用快取 → input 事件命中快取、同步 render（不需真網路）
  inp.value = 'vanco';
  DS._shared.cache.set('vanco', { t: Date.now(), v: await DS.search('vanco', { fetchJson: m.fetchJson }) });
  inp.fire('input');                                  // 命中快取 → 同步 render
  assert.equal(dd.hidden, false);
  assert.ok(dd.children.length >= 2);
  inp.fire('keydown', { key: 'Enter' });               // 未用方向鍵選中 → 不採用
  assert.equal(ctl.isConfirmed(), false);
  assert.equal(inp.value, 'vanco');
  inp.fire('keydown', { key: 'ArrowDown' });
  inp.fire('keydown', { key: 'Enter' });
  assert.equal(inp.value, 'Vancomycin');
  assert.equal(ctl.isConfirmed(), true);
  assert.equal(J(ctl.nameInfo()).source, 'openfda-ndc');
  assert.match(st.textContent, /已確認：Vancomycin — Generic/);
  inp.value = 'Vancomycin X';
  inp.fire('input');
  assert.equal(ctl.isConfirmed(), false);
  assert.equal(J(ctl.nameInfo()).verified, false);
  assert.match(st.textContent, /未驗證藥名/);
  ctl.confirmManual();
  assert.equal(ctl.isConfirmed(), true);
  assert.equal(J(ctl.nameInfo()).manualConfirmed, true);
  ctl.destroy();
});
