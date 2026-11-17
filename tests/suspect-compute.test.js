'use strict';
// 疑似藥比例：計算正確性（plan §8 A1–A15）。每案先各端對人工裁決預期，再比對兩端逐欄相同。
// fixture 未列欄位一律缺漏；條目簡記 {gn, bn, mp, r}，r 不給＝無 drugcharacterization 欄位。
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, loadGas } = require('./_load');

const J = (x) => JSON.parse(JSON.stringify(x));
const app = loadApp();
const gas = loadGas();
const ZERO = { sampled: 0, valid: 0, suspect: 0, interacting: 0, concomitant: 0, invalidRole: 0, combo: 0, ambiguous: 0, unmatched: 0,
  pct: null, lowSample: false, periodFrom: null, periodTo: null };

function entry(e) {
  const d = {};
  if ('mp' in e) d.medicinalproduct = e.mp;
  if ('r' in e) d.drugcharacterization = e.r;
  if (e.gn || e.bn) { d.openfda = {}; if (e.gn) d.openfda.generic_name = e.gn; if (e.bn) d.openfda.brand_name = e.bn; }
  return d;
}
let seq = 0;
function rep(entries, extra) {
  return Object.assign({ safetyreportid: 'R' + (++seq), patient: { drug: entries.map(entry) } }, extra || {});
}
// 兩端計算並比對：回傳 app 端結果
function both(reports, drug) {
  const a = J(app.computeSuspectProportion(reports, drug));
  const g = J(gas.computeSuspectProportion(reports, drug));
  assert.deepEqual(g, a, '兩端輸出必須逐欄相同：' + drug);
  return a;
}
function expectSummary(reports, drug, partial) {
  const got = both(reports, drug);
  const want = Object.assign({}, ZERO, partial);
  if (want.sampled === undefined || partial.sampled === undefined) want.sampled = reports.length;
  assert.deepEqual(got, want, drug);
  return got;
}
// 單一條目分類（經通報層級反推）：target 以角色 1 觀察
function entryClass(drug, e) {
  const s = both([rep([Object.assign({ r: '1' }, e)])], drug);
  if (s.suspect === 1) return 'target';
  if (s.combo === 1) return 'combo';
  if (s.ambiguous === 1) return 'ambiguous';
  if (s.unmatched === 1) return 'none';
  return 'unexpected:' + JSON.stringify(s);
}
const CBZ = (r) => ({ gn: ['CARBAMAZEPINE'], r });

test('A1 角色型別：字串、數字、混合皆正確；1/3/2 各一報 → 67%', () => {
  const sets = { 字串: ['1', '3', '2'], 數字: [1, 3, 2], 混合: ['1', 3, 2] };
  for (const [name, roles] of Object.entries(sets)) {
    expectSummary(roles.map((r) => rep([CBZ(r)])), 'CARBAMAZEPINE',
      { valid: 3, suspect: 1, interacting: 1, concomitant: 1, pct: 67, lowSample: true });
    assert.ok(name);
  }
  expectSummary([1, '1', 1].map((r) => rep([CBZ(r)])), 'CARBAMAZEPINE', { valid: 3, suspect: 3, pct: 100, lowSample: true });
});

test('A2 全為 Concomitant → pct 0（非 null），顯示由 UI 測 D2', () => {
  expectSummary([2, 2, 2, 2].map((r) => rep([CBZ(r)])), 'CARBAMAZEPINE', { valid: 4, concomitant: 4, pct: 0, lowSample: true });
});

test('A3 S/I 混合與同報重複', () => {
  const base = ['1', '3', '3', '2'].map((r) => rep([CBZ(r)]));
  expectSummary(base, 'CARBAMAZEPINE', { valid: 4, suspect: 1, interacting: 2, concomitant: 1, pct: 75, lowSample: true });
  const more = base.concat([rep([CBZ('2'), CBZ('2'), CBZ('1')])]);
  expectSummary(more, 'CARBAMAZEPINE', { valid: 5, suspect: 2, interacting: 2, concomitant: 1, pct: 80, lowSample: true });
});

test('A4 反例：同報他藥為 Suspect／Interacting，不得把目標算成 Suspect', () => {
  const other = (r) => ({ gn: ['PHENYTOIN'], mp: 'DILANTIN', r });
  const cases = [[other('1'), CBZ('2')], [CBZ('2'), other('1')], [other('3'), CBZ('2')], [CBZ('2'), other('3')]];
  for (const c of cases) {
    expectSummary([rep(c)], 'CARBAMAZEPINE', { valid: 1, concomitant: 1, pct: 0, lowSample: true });
  }
});

test('A5 同報同一目標多筆紀錄只計一次', () => {
  const r = rep([{ gn: ['CARBAMAZEPINE'], r: '2' }, { gn: ['CARBAMAZEPINE'], bn: ['TEGRETOL'], mp: 'TEGRETOL', r: '2' },
    { gn: ['CARBAMAZEPINE'], mp: 'carbamazepine.', r: '2' }]);
  expectSummary([r], 'CARBAMAZEPINE', { valid: 1, concomitant: 1, pct: 0, lowSample: true });
  // 商品名查詢：僅 D3 #6（brand exact）可導出 target
  const t = rep([{ gn: ['CARBAMAZEPINE'], bn: ['TEGRETOL'], r: '2' }, { gn: ['CARBAMAZEPINE'], bn: ['TEGRETOL'], r: '2' }]);
  expectSummary([t], 'TEGRETOL', { valid: 1, concomitant: 1, pct: 0, lowSample: true });
});

test('A6 角色衝突優先順序 1>3>2，與排列無關；target 優先於同報 combo/ambiguous', () => {
  const perms = (arr) => arr.length <= 1 ? [arr] : arr.flatMap((x, i) => perms(arr.slice(0, i).concat(arr.slice(i + 1))).map((p) => [x].concat(p)));
  const INVALID = { gn: ['CARBAMAZEPINE'] };   // 無角色欄
  const cases = [
    [[CBZ('2'), CBZ('1')], 'suspect'], [[CBZ('2'), CBZ('3')], 'interacting'], [[CBZ('3'), CBZ('1')], 'suspect'],
    [[CBZ('2'), CBZ('3'), CBZ('1')], 'suspect'], [[INVALID, CBZ('2')], 'concomitant'], [[INVALID, Object.assign({}, INVALID, { r: '9' })], 'invalidRole'],
    [[CBZ('2'), { gn: ['CARBAMAZEPINE AND LAMOTRIGINE'], r: '1' }], 'concomitant'],
    [[CBZ('2'), { gn: ['CARBAMAZEPINE EPOXIDE'], r: '1' }], 'concomitant'],
    [[INVALID, { gn: ['CARBAMAZEPINE AND LAMOTRIGINE'], r: '1' }], 'invalidRole']
  ];
  for (const [entries, cat] of cases) {
    for (const p of perms(entries)) {
      const s = both([rep(p)], 'CARBAMAZEPINE');
      assert.equal(s[cat], 1, cat + ' ' + JSON.stringify(p));
      assert.equal(s.sampled, 1);
    }
  }
});

test('A7 無效角色值不進有效分母', () => {
  const bad = [undefined, null, '', '4', 0, true, [1], {}, '1 '];
  for (const v of bad) {
    const e = { gn: ['CARBAMAZEPINE'] };
    if (v !== undefined) e.r = v;
    expectSummary([rep([e])], 'CARBAMAZEPINE', { invalidRole: 1 });
  }
});

test('A8 別名與鹽類：皆為 target', () => {
  assert.equal(entryClass('VANCOMYCIN', { gn: ['VANCOMYCIN HYDROCHLORIDE', 'VANCOMYCIN'] }), 'target');
  assert.equal(entryClass('VANCOMYCIN', { gn: ['VANCOMYCIN HYDROCHLORIDE'], mp: 'VANCOCIN' }), 'target');
  assert.equal(entryClass('VANCOMYCIN', { gn: ['VANCOMYCIN'], bn: ['VANCOCIN', 'FIRVANQ'], mp: 'Vancomycin (1,000 and 1,250 mg)' }), 'target');
  assert.equal(entryClass('VANCOMYCIN HYDROCHLORIDE', { gn: ['VANCOMYCIN'] }), 'target');
  assert.equal(entryClass('FIRVANQ', { gn: ['VANCOMYCIN HYDROCHLORIDE'], bn: ['VANCOCIN', 'FIRVANQ'] }), 'target');
  assert.equal(entryClass('TEGRETOL', { gn: ['CARBAMAZEPINE'], bn: ['EPITOL', 'TEGRETOL'] }), 'target');
  assert.equal(entryClass('Vancomycin', { gn: ['vancomycin hydrochloride'] }), 'target', '大小寫不影響');
});

test('A9 具名反例：不得進入有效分母（人工裁決，每案唯一分類）', () => {
  const cases = [
    ['INSULIN', { gn: ['INSULIN GLARGINE'] }, 'ambiguous'],                                  // 共有 token 的不同成分
    ['AMOXICILLIN', { gn: ['AMOXICILLIN AND CLAVULANATE POTASSIUM'] }, 'combo'],
    ['AMOXICILLIN', { gn: ['AMOXICILLIN', 'CLAVULANATE POTASSIUM'] }, 'combo'],              // 多元素、不同主成分
    ['AMOXICILLIN', { gn: ['AMOXICILLIN', 'SODIUM CHLORIDE'] }, 'combo'],                    // 去鹽後為空的元素不得被刪除
    ['AMOXICILLIN', { mp: 'AMOXICILLIN (WITH CLAVULANATE POTASSIUM)' }, 'ambiguous'],         // 無 generic
    ['HYDROCODONE', { mp: 'HYDROCODONE/APAP' }, 'ambiguous'],
    ['SULFAMETHOXAZOLE', { gn: ['SULFAMETHOXAZOLE AND TRIMETHOPRIM'], mp: 'BACTRIM' }, 'combo'],
    ['IRON', { mp: 'IRONWOOD EXTRACT' }, 'none'],                                            // token 前綴不算命中
    ['ESTRADIOL', { gn: ['ESTRADIOL VALERATE'] }, 'ambiguous'],                              // 保守漏配（已知限制）
    ['METFORMIN', { gn: ['SITAGLIPTIN AND METFORMIN HYDROCHLORIDE'], bn: ['JANUMET'] }, 'combo'],
    ['JANUMET', { mp: 'JANUMET' }, 'ambiguous'],                                             // 名稱相等≠單方
    ['LITHIUM', { gn: ['LITHIUM CARBONATE'] }, 'ambiguous'],                                 // 保守漏配（已知限制）
    ['VANCOMYCIN', { mp: 'Vancomycin Hydrochloride' }, 'ambiguous'],                         // live 1/200 型態
    ['POTASSIUM CHLORIDE', { gn: ['POTASSIUM CHLORIDE'] }, 'target'],                        // FULL 模式
    ['POTASSIUM CHLORIDE', { gn: ['POTASSIUM CITRATE'] }, 'none'],
    ['MAGNESIUM SULFATE', { gn: ['MAGNESIUM SULFATE', 'SODIUM CHLORIDE'] }, 'combo'],
    // generic 內的複方分隔符逐一覆蓋（D3 #3）；數字間斜線不算複方
    ['SULFAMETHOXAZOLE', { gn: ['SULFAMETHOXAZOLE + TRIMETHOPRIM'] }, 'combo'],
    ['HYDROCODONE', { gn: ['HYDROCODONE/ACETAMINOPHEN'] }, 'combo'],
    ['HYDROCODONE', { gn: ['HYDROCODONE BITARTRATE, ACETAMINOPHEN'] }, 'combo'],
    ['AMOXICILLIN', { gn: ['AMOXICILLIN WITH CLAVULANATE'] }, 'combo'],
    ['AMOXICILLIN', { gn: ['AMOXICILLIN 500MG/5ML'] }, 'ambiguous']
  ];
  for (const [drug, e, want] of cases) {
    assert.equal(entryClass(drug, e), want, drug + ' ← ' + JSON.stringify(e));
  }
});

test('A10 結構異常的通報計入抽樣、歸 unmatched、不拋例外', () => {
  const reports = [null, 'x', 42, {}, { patient: null }, { patient: { drug: 'X' } }, { patient: { drug: [] } },
    { patient: { drug: [null, 'str', 7] } }, rep([{ gn: ['PHENYTOIN'], r: '1' }])];
  expectSummary(reports, 'CARBAMAZEPINE', { unmatched: reports.length });
  expectSummary('not-array', 'CARBAMAZEPINE', { sampled: 0 });
});

test('A11 性質：守恆、valid=0⇔null、加入 none 條目或複製 target 不改結果（固定 seed）', () => {
  let s = 20261117;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const pool = [CBZ('1'), CBZ('2'), CBZ('3'), { gn: ['CARBAMAZEPINE'] }, { gn: ['CARBAMAZEPINE AND LAMOTRIGINE'], r: '1' },
    { gn: ['CARBAMAZEPINE EPOXIDE'], r: '1' }, { mp: 'CARBAMAZEPINE', r: '1' }, { gn: ['PHENYTOIN'], r: '1' }];
  const NONE = [{ gn: ['PHENYTOIN'], r: '1' }, { mp: 'CARBAMAZEPINEX', r: '3' }, { gn: ['LAMOTRIGINE'], r: '2' }];
  for (let k = 0; k < 25; k++) {
    const reps = Array.from({ length: 1 + Math.floor(rnd() * 12) }, () => rep(Array.from({ length: Math.floor(rnd() * 4) }, () => pick(pool))));
    const a = both(reps, 'CARBAMAZEPINE');
    const sum = a.suspect + a.interacting + a.concomitant + a.invalidRole + a.combo + a.ambiguous + a.unmatched;
    assert.equal(sum, a.sampled); assert.equal(a.sampled, reps.length);
    assert.equal(a.valid === 0, a.pct === null);
    if (a.valid > 0) assert.ok(Number.isInteger(a.pct) && a.pct >= 0 && a.pct <= 100);
    // 加入 none 條目
    const i = Math.floor(rnd() * reps.length);
    const withNone = J(reps); withNone[i].patient.drug.push(entry(pick(NONE)));
    assert.deepEqual(both(withNone, 'CARBAMAZEPINE'), a, '加入 none 條目不得改變結果');
    // 複製已存在的 target 條目（同角色）
    const dup = J(reps);
    const tIdx = dup.findIndex((r) => r.patient.drug.some((d) => d.openfda && JSON.stringify(d.openfda.generic_name) === '["CARBAMAZEPINE"]'));
    if (tIdx > -1) {
      const t = dup[tIdx].patient.drug.find((d) => d.openfda && JSON.stringify(d.openfda.generic_name) === '["CARBAMAZEPINE"]');
      dup[tIdx].patient.drug.push(J(t));
      assert.deepEqual(both(dup, 'CARBAMAZEPINE'), a, '複製 target 條目不得改變結果');
    }
  }
});

test('A12 有效分母 n 不固定 100：47 報 → sampled 47、valid 42、pct 60', () => {
  const reps = [].concat(
    Array.from({ length: 20 }, () => rep([CBZ('1')])), Array.from({ length: 5 }, () => rep([CBZ('3')])),
    Array.from({ length: 17 }, () => rep([CBZ('2')])), Array.from({ length: 2 }, () => rep([{ gn: ['CARBAMAZEPINE'] }])),
    [rep([{ gn: ['CARBAMAZEPINE AND LAMOTRIGINE'], r: '1' }])], [rep([{ gn: ['CARBAMAZEPINE EPOXIDE'], r: '1' }])],
    [rep([{ gn: ['PHENYTOIN'], r: '1' }])]);
  expectSummary(reps, 'CARBAMAZEPINE', { sampled: 47, valid: 42, suspect: 20, interacting: 5, concomitant: 17,
    invalidRole: 2, combo: 1, ambiguous: 1, unmatched: 1, pct: 60 });
});

test('A14 抽樣期間取自全體 sampled 的合法日曆日期', () => {
  const reps = [rep([CBZ('1')], { receivedate: '20250101' }), rep([{ gn: ['PHENYTOIN'] }], { receivedate: '20240311' }),
    rep([{ gn: ['CARBAMAZEPINE AND LAMOTRIGINE'] }], { receivedate: '20260928' }), rep([CBZ('2')]),
    rep([CBZ('2')], { receivedate: '2024' }), rep([CBZ('2')], { receivedate: '20240230' }), rep([CBZ('2')], { receivedate: '20241301' }),
    rep([CBZ('2')], { receivedate: 20230101 })];
  const s = both(reps, 'CARBAMAZEPINE');
  assert.equal(s.periodFrom, '2024-03-11');
  assert.equal(s.periodTo, '2026-09-28');
  const none = both([rep([CBZ('1')], { receivedate: '20240230' }), rep([CBZ('1')])], 'CARBAMAZEPINE');
  assert.equal(none.periodFrom, null); assert.equal(none.periodTo, null);
});

test('A15 lowSample 邊界：valid 0/1/9/10', () => {
  for (const [n, low] of [[0, false], [1, true], [9, true], [10, false]]) {
    const reps = Array.from({ length: n }, () => rep([CBZ('1')])).concat([rep([{ gn: ['PHENYTOIN'] }])]);
    const s = both(reps, 'CARBAMAZEPINE');
    assert.equal(s.valid, n); assert.equal(s.lowSample, low, 'valid ' + n);
    assert.equal(s.pct, n ? 100 : null);
  }
});

test('空藥名或純符號 → 全部 unmatched，不誤配', () => {
  const reps = [rep([CBZ('1')]), rep([{ mp: '***', r: '1' }])];
  expectSummary(reps, '***', { unmatched: 2 });
  expectSummary(reps, '', { unmatched: 2 });
});
