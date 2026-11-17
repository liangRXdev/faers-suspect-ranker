'use strict';
// 疑似藥比例 live 整合（plan §8 E1）：實際打 openFDA，僅在 LIVE=1 時執行。
//   LIVE=1 node --test tests/live/suspect.live.test.js
// 經受驗引擎（docs/app.js 的 suspectProportion）取得摘要；另以同一 URL 取原始通報，用引擎的 _spAudit
// 輸出逐報稽核表到 .ai-review/live-audit/，供人工核對。不斷言特定百分比。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadApp, ROOT } = require('../_load');

const LIVE = process.env.LIVE === '1';
const CASES = [
  ['CARBAMAZEPINE', 'Stevens-Johnson syndrome'], ['CARBAMAZEPINE', 'Toxic epidermal necrolysis'],
  ['VANCOMYCIN', 'Stevens-Johnson syndrome'], ['VANCOMYCIN', 'Toxic epidermal necrolysis']
];
const OUT = path.join(ROOT, '.ai-review', 'live-audit');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (x) => JSON.parse(JSON.stringify(x));

test('E1 live：Carbamazepine／Vancomycin × SJS／TEN', { skip: !LIVE && '設定 LIVE=1 才執行' }, async () => {
  fs.mkdirSync(OUT, { recursive: true });
  let httpCount = 0;
  const app = loadApp({ fetch: (u, i) => { httpCount++; return fetch(u, i); } });
  const rows = [];
  for (const [drug, rx] of CASES) {
    const t0 = Date.now();
    const before = httpCount;
    const res = await app.suspectProportion(drug, rx);
    const ms = Date.now() - t0;
    assert.equal(res.success, true, drug + ' × ' + rx + '：' + res.error);
    const s = res.data;
    const sum = s.suspect + s.interacting + s.concomitant + s.invalidRole + s.combo + s.ambiguous + s.unmatched;
    assert.equal(sum, s.sampled); assert.ok(s.sampled <= 100); assert.ok(s.valid >= 1);
    assert.equal(s.valid === 0, s.pct === null);
    const n1 = httpCount - before;
    const again = await app.suspectProportion(drug, rx);
    assert.equal(again.cached, true); assert.equal(httpCount - before, n1, '第二次呼叫 0 次 HTTP');

    // 稽核：同一 URL 取原始通報，以引擎同一分類函式輸出逐報裁決
    await sleep(1800);
    const r = await fetch(app._spUrl(drug, rx, ''));
    const buf = Buffer.from(await r.arrayBuffer());
    const reports = JSON.parse(buf.toString('utf8')).results;
    const audit = app._spAudit(reports, drug);
    const recount = J(app.computeSuspectProportion(reports, drug));
    const file = path.join(OUT, drug + '__' + rx.replace(/\W+/g, '_') + '.json');
    fs.writeFileSync(file, JSON.stringify({ drug, reaction: rx, fetchedAt: new Date().toISOString(), summary: s, recount, bytes: buf.length, ms, audit }, null, 1));
    rows.push({ drug, rx, sampled: s.sampled, valid: s.valid, S: s.suspect, I: s.interacting, C: s.concomitant, invalid: s.invalidRole,
      combo: s.combo, ambiguous: s.ambiguous, unmatched: s.unmatched, pct: s.pct, period: s.periodFrom + '～' + s.periodTo,
      bytes: buf.length, ms, recountSame: ['suspect', 'interacting', 'concomitant', 'invalidRole', 'combo', 'ambiguous', 'unmatched'].every((k) => recount[k] === s[k]) });
    await sleep(1800);
  }
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(rows, null, 1));
  console.table(rows);
});
