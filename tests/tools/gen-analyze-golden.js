// 產生 analyzeADR 回歸基準（C2）：一律以 bdf4360（疑似藥比例功能前）的原始碼計算，
// 結果寫入 tests/fixtures/analyze-golden.json。用法：node tests/tools/gen-analyze-golden.js
// ⚠ 不得改用目前工作樹的原始碼產生——那會讓基準追認新行為。
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { runAll } = require('../_analyze_harness');

const BASE = 'bdf4360';
const ROOT = path.join(__dirname, '..', '..');
const show = (p) => execFileSync('git', ['show', BASE + ':' + p], { cwd: ROOT, encoding: 'utf8' }).replace(/\r\n/g, '\n');

(async () => {
  const out = await runAll(show('docs/app.js'), show('Code.gs'));
  out.base = BASE;
  const file = path.join(ROOT, 'tests', 'fixtures', 'analyze-golden.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(JSON.stringify(out, null, 1) + '\n', 'utf8'));
  console.log('wrote', file, 'scenarios', out.app.length);
})().catch((e) => { console.error(e); process.exit(1); });
