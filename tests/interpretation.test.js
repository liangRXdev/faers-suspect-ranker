'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, loadGas, read } = require('./_load');

const app = loadApp();
const gas = loadGas();
const J = (x) => JSON.parse(JSON.stringify(x));   // 跨 vm context 比對用
const META = { reaction: 'Thrombocytopenia', N: 20000000, nEvent: 80000 };

function r(o) {
  return Object.assign({
    a: 100, nDrug: 10000, rorLow: 1, rorHigh: 1, prr: 1, chi2: 10, signal: true, signalBasis: 'ROR+PRR',
    haldane: false, latencyDays: 5, temporalWeight: 1, temporalFlag: '急性窗 (≤90d)·用藥中', temporalStatus: 'on'
  }, o);
}
const comp = (w, ror) => Math.round(w * (ror > 1 ? Math.log(ror) : 0) * 1000) / 1000;

// 兩端（Code.gs / docs/app.js）輸出必須完全一致；回傳 app 端結果
function interp(results, meta) {
  const a = J(app.generateInterpretation(results, meta));
  const g = J(gas.generateInterpretation(results, meta));
  assert.deepEqual(a, g, 'Code.gs 與 docs/app.js 的 generateInterpretation 輸出不一致');
  return a;
}
function noCausalClaims(text) {
  assert.ok(!/最可能(造成|導致|引起)|致病機率為|風險(較|最)高/.test(text), '出現因果/風險語言：' + text);
}

const SPEC = [
  r({ drug: 'Cefepime', ror: 7.08, rorLow: 6.56, rorHigh: 7.64, prr: 6.84, latencyDays: 7, composite: comp(1, 7.08), rank: 1 }),
  r({ drug: 'Vancomycin', ror: 5.52, rorLow: 5.1, rorHigh: 5.97, prr: 5.38, latencyDays: 4, composite: comp(1, 5.52), rank: 2 }),
  r({ drug: 'Fluconazole', ror: 5.49, rorLow: 5.0, rorHigh: 6.02, prr: 5.35, latencyDays: 4, composite: comp(1, 5.49), rank: 3 })
];

test('規格範例：3 藥均達門檻、權重均 1.0 → 指出時序未改變排序、由 ROR 決定', () => {
  const out = interp(SPEC, META);
  const t = out.text;
  assert.match(t, /共納入 3 項藥品，均達到目前設定的 FAERS 不相稱性訊號門檻/);
  assert.match(t, /Cefepime 的探索性排序分數（綜合分數）最高（1\.957），主要來自 ROR 7\.08（95% CI 6\.56–7\.64）/);
  assert.match(t, /3 項藥品均於症狀出現前（或當日）開始使用（潛伏期 4–7 天），且時間權重均為 1\.0，因此時序權重並未改變本次排序；此排名實際上由 ROR 大小決定/);
  assert.match(t, /並非針對「Thrombocytopenia」的 ADR-specific latency/);
  assert.match(t, /不是發生風險、相對風險，也不是個案因果機率/);
  assert.equal(out.sections.length, 3);
  assert.deepEqual(out.sections.map((s) => s.key), ['signal', 'temporal', 'limits']);
  assert.ok(t.includes('本結果僅用於 ADR 候選藥品優先檢視。FAERS 不相稱性訊號不等於個案因果關係；排序分數不是致病機率。'));
  assert.equal(out.sections[1].items.length, 0, '權重相同時不應列出順位變化');
  noCausalClaims(t);
});

test('權重不同且排序改變 → 列出 ROR-only 與綜合排序差異', () => {
  const res = [
    r({ drug: 'DrugB', ror: 3, rorLow: 2.5, rorHigh: 3.6, temporalWeight: 1, composite: comp(1, 3), rank: 1 }),
    r({ drug: 'DrugA', ror: 6, rorLow: 5, rorHigh: 7.2, temporalWeight: 0.3, latencyDays: 200,
        temporalFlag: '慢性 (>180d)·用藥中', composite: comp(0.3, 6), rank: 2 })
  ];
  const out = interp(res, META);
  assert.match(out.text, /下列藥品的綜合分數受時序權重調降：DrugA（權重 0\.3，慢性 \(>180d\)·用藥中）/);
  assert.deepEqual(out.sections[1].items, ['DrugB：ROR 排序第 2 → 綜合排序第 1', 'DrugA：ROR 排序第 1 → 綜合排序第 2']);
  assert.ok(!/時序權重並未改變本次排序/.test(out.text));
});

test('權重不同但順位未變 → 明確說明未改變', () => {
  const res = [
    r({ drug: 'X', ror: 9, rorLow: 7, rorHigh: 11, temporalWeight: 1, composite: comp(1, 9), rank: 1 }),
    r({ drug: 'Y', ror: 2, rorLow: 1.5, rorHigh: 2.6, temporalWeight: 0.6, latencyDays: 120, temporalFlag: '亞急性 (91–180d)·用藥中', composite: comp(0.6, 2), rank: 2 })
  ];
  const out = interp(res, META);
  assert.match(out.text, /雖時間權重不同，但與僅依 ROR 排序相比，各藥順位未改變/);
});

test('缺少日期 → 不宣稱時序合理', () => {
  const allMissing = SPEC.map((x) => Object.assign({}, x, {
    latencyDays: null, temporalFlag: '缺日期·未加權', temporalStatus: 'missing'
  }));
  const t1 = interp(allMissing, META).text;
  assert.match(t1, /所有藥品均缺少有效的用藥起始日或症狀發生日/);
  assert.match(t1, /不應解讀為時間關係合理/);
  assert.ok(!/於症狀出現前/.test(t1));
  assert.ok(!/ADR-specific latency/.test(t1), '無有效時序時不應描述時間窗套用');

  const partial = [SPEC[0], Object.assign({}, SPEC[1], { latencyDays: null, temporalFlag: '日期格式錯誤·未加權', temporalStatus: 'invalid' }), SPEC[2]];
  const t2 = interp(partial, META).text;
  assert.match(t2, /Vancomycin 缺少有效日期（日期格式錯誤·未加權），時序權重以 1\.0 暫計（未加權），時間關係無法充分評估/);
  assert.ok(!/3 項藥品均於症狀出現前/.test(t2));

  // 舊版結果（無 temporalStatus 欄位）以 flag 推斷，結果相同
  const legacy = allMissing.map((x) => { const y = Object.assign({}, x); delete y.temporalStatus; return y; });
  assert.equal(interp(legacy, META).text, t1);
});

test('症狀早於用藥 → 註明不符初始假設，但不宣稱已排除', () => {
  const res = [SPEC[0], r({ drug: 'Heparin', ror: 20, rorLow: 18, rorHigh: 22, latencyDays: -3, temporalWeight: 0,
    temporalFlag: '症狀早於用藥·排除', temporalStatus: 'before', composite: 0, rank: 2 })];
  const t = interp(res, META).text;
  assert.match(t, /Heparin 的症狀日期早於開始用藥：時間順序不符合「該藥引發本次事件」的初始假設/);
  assert.match(t, /不宜據此在所有臨床情境下排除該藥/);
  noCausalClaims(t);
});

test('全部時序排除 → 綜合分數不具鑑別資訊', () => {
  const res = SPEC.map((x, i) => Object.assign({}, x, { latencyDays: -1, temporalWeight: 0, temporalStatus: 'before',
    temporalFlag: '症狀早於用藥·排除', composite: 0, rank: i + 1 }));
  const t = interp(res, META).text;
  assert.match(t, /所有藥品的時序權重均為 0（症狀日期早於開始用藥），綜合分數皆為 0，本次排序不具鑑別資訊/);
  assert.ok(!/探索性排序分數（綜合分數）最高/.test(t));
});

test('停藥後發生 → 說明衰減係數', () => {
  const res = [r({ drug: 'Linezolid', ror: 8, rorLow: 7, rorHigh: 9, latencyDays: 7, temporalWeight: 0.7,
    temporalFlag: '停藥後 3d (停藥≤7d)', temporalStatus: 'post', composite: comp(0.7, 8), rank: 1 })];
  const t = interp(res, META).text;
  assert.match(t, /Linezolid（停藥後 3d \(停藥≤7d\)，權重 0\.7） 於停藥後才出現症狀，已套用停藥後衰減係數/);
  assert.match(t, /此藥於症狀出現前（或當日）開始使用（潛伏期 7 天），且時間權重為 0\.7/);
});

test('ROR ≤1 → 不誤稱正向訊號', () => {
  const res = [
    r({ drug: 'Metformin', ror: 0.8, rorLow: 0.6, rorHigh: 1.05, prr: 0.81, signal: false, signalBasis: '未達閾值', composite: 0, rank: 1 }),
    r({ drug: 'Amlodipine', ror: 1, rorLow: 0.9, rorHigh: 1.1, prr: 1, signal: false, signalBasis: '未達閾值', composite: 0, rank: 2 })
  ];
  const t = interp(res, META).text;
  assert.match(t, /均未達到目前設定的 FAERS 不相稱性訊號門檻/);
  assert.match(t, /Metformin、Amlodipine 的 ROR ≤1（0\.8、1）：FAERS 中與此症狀的通報未呈現不相稱偏高，不應視為正向訊號/);
  assert.match(t, /所有藥品的綜合分數皆為 0/);
  assert.ok(!/最高/.test(t));
});

test('ROR>1 但 CI 下界 ≤1、未達門檻 → 標示不確定性', () => {
  const res = [r({ drug: 'Z', ror: 1.4, rorLow: 0.8, rorHigh: 2.4, prr: 1.4, signal: false, signalBasis: '未達閾值', composite: comp(1, 1.4), rank: 1 })];
  const t = interp(res, META).text;
  assert.match(t, /Z 的 ROR 點估計 >1，但 95% CI 下界 ≤1 且未達訊號門檻/);
  assert.match(t, /但未達訊號門檻（未達閾值）/);
});

test('沒有分析結果 → 不產生錯誤文字、不拋例外', () => {
  for (const args of [[[], META], [null, null], [undefined, undefined], [[null, 3], { reaction: 'Rash' }]]) {
    const out = interp(args[0], args[1]);
    assert.deepEqual(out.sections.map((s) => s.key), ['signal', 'limits']);
    assert.match(out.text, /本次分析未產生藥品結果/);
    assert.ok(!/undefined|NaN|null/.test(out.text), out.text);
  }
});

test('分數相同 → 穩定排序（輸入陣列順序不影響解讀）', () => {
  const a = r({ drug: 'Alpha', ror: 4, rorLow: 3, rorHigh: 5, composite: comp(1, 4), rank: 1 });
  const b = r({ drug: 'Beta', ror: 4, rorLow: 3, rorHigh: 5, composite: comp(1, 4), rank: 2 });
  const c = r({ drug: 'Gamma', ror: 4, rorLow: 3.5, rorHigh: 4.6, composite: comp(1, 4), rank: 3 });
  const t1 = interp([a, b, c], META);
  const t2 = interp([c, b, a], META);
  assert.equal(t1.text, t2.text);
  // ROR 同分 → 先比 95% CI 下界（Gamma 較高）→ 再依綜合排序順位
  assert.deepEqual(t1.sections[1].items, [
    'Alpha：ROR 排序第 2 → 綜合排序第 1', 'Beta：ROR 排序第 3 → 綜合排序第 2', 'Gamma：ROR 排序第 1 → 綜合排序第 3'
  ]);
  // 完全相同（含 CI）→ 無順位變化
  const t3 = interp([a, b], META);
  assert.equal(t3.sections[1].items.length, 0);
});

test('藥名含 HTML → 輸出為純文字（不加任何標記），前端以 textContent 呈現', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const res = [r({ drug: evil, ror: 3, rorLow: 2, rorHigh: 4, composite: comp(1, 3), rank: 1, haldane: true })];
  const out = interp(res, { reaction: '<script>x</script>' });
  assert.ok(out.text.includes(evil), '藥名應原樣保留為文字');
  const stripped = out.text.split(evil).join('').split('<script>x</script>').join('');
  assert.ok(!/<[a-z\/!]/i.test(stripped), '解讀產生器不得自行輸出 HTML 標記');
  for (const f of ['Index.html', 'docs/index.html']) {
    const h = read(f);
    const fn = h.slice(h.indexOf('function renderInterpretation'), h.indexOf('\n}\n', h.indexOf('function renderInterpretation')));
    assert.ok(fn.length > 50, f + ' 缺 renderInterpretation');
    assert.ok(!/innerHTML/.test(fn), f + ' renderInterpretation 不得使用 innerHTML');
    assert.match(fn, /textContent=p/);
  }
});

test('未驗證藥名與商品名查詢 → 解讀中註明', () => {
  const res = [
    r({ drug: 'vancomycn', ror: 3, rorLow: 2, rorHigh: 4, composite: comp(1, 3), rank: 1, nameInfo: { verified: false, kind: 'manual' } }),
    r({ drug: 'Zosyn', ror: 2, rorLow: 1.5, rorHigh: 2.7, composite: comp(1, 2), rank: 2, nameInfo: { verified: true, kind: 'brand' } })
  ];
  const t = interp(res, META).text;
  assert.match(t, /未經建議清單確認、以輸入文字原樣查詢 FAERS：vancomycn/);
  assert.match(t, /Zosyn 以商品名查詢.*未自動展開為成分名/);
});
