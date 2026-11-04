// ============================================================
// FAERS 多重用藥 ADR 嫌疑藥排序工具（開源教學版 / Educational）
// Version: 2.3.0  |  Author: liangRXdev  |  License: MIT
// ⚠ 教學/練習用途，非臨床決策工具 — 詳見 DISCLAIMER.md
// 方法：反向查詢 (症狀→藥) + ROR/PRR 不相稱性分析 + 本地時序加權
// Guideline ref: EVDAS disproportionality criteria; van Puijenbroek 2002 (ROR)
// ⚠ 訊號偵測 ≠ 因果；FAERS 為自願通報，無分母、有通報偏差
// ============================================================

const CONFIG = {
  VERSION: '2.3.0',
  ENDPOINT: 'https://api.fda.gov/drug/event.json',
  MAX_DRUGS: 10,           // 防止 GAS 6 分鐘逾時（有 key 10 顆 ≈ 6s，無 key ≈ 36s）
  CACHE_TTL_LONG: 21600,  // N、症狀總數：6h（FAERS 季更，變化極慢）
  CACHE_TTL_SHORT: 3600,  // 藥-症狀交集：1h
  MIN_REPORTS: 3,          // 訊號最低通報數 (a≥3)
  // ── 速率限制緩衝 ───────────────────────────────────────────
  // OpenFDA: 無 key=40 req/min, 有 key=240 req/min
  // 安全間隔 = (60000/limit) × 1.2 (20% buffer)
  SLEEP_NO_KEY: 1800,      // ms，無 key 時每次 API call 後等待
  SLEEP_WITH_KEY: 300,     // ms，有 key 時每次 API call 後等待
  // ── 時序加權帶 ─────────────────────────────────────────────
  TEMPORAL_BANDS: [
    { maxDays: 90,       weight: 1.0, label: '急性窗 (≤90d)' },
    { maxDays: 180,      weight: 0.6, label: '亞急性 (91–180d)' },
    { maxDays: Infinity, weight: 0.3, label: '慢性 (>180d)' }
  ],
  // ── 停藥後衰減（dechallenge）：症狀發生於停藥之後時，依間隔衰減 ──
  // 啟發式；未納入個別藥物半衰期，遲發型反應（如 DILI、遲發過敏）仍可能
  POST_STOP_DECAY: [
    { maxGap: 7,        factor: 0.7, label: '停藥≤7d' },
    { maxGap: 30,       factor: 0.4, label: '停藥8–30d' },
    { maxGap: Infinity, factor: 0.1, label: '停藥>30d' }
  ]
};

// ---------- Web App / Sidebar 進入點 ----------
function doGet(e) {
  const t = HtmlService.createTemplateFromFile('Index');
  t.VERSION = CONFIG.VERSION;
  return t.evaluate()
    .setTitle('FAERS 多重用藥 ADR 嫌疑藥排序')
    // GAS 在 iframe 內渲染，HTML 的 <link rel=icon> 無效；只能用 setFaviconUrl 指向外部 PNG（取自 Pages）
    .setFaviconUrl('https://liangrxdev.github.io/faers-suspect-ranker/favicon-32.png')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
function onOpen() {
  SpreadsheetApp.getUi().createMenu('FDA小幫手')
    .addItem('啟動 ADR 嫌疑藥排序', 'showSidebar').addToUi();
}
function showSidebar() {
  const t = HtmlService.createTemplateFromFile('Index');
  t.VERSION = CONFIG.VERSION;
  SpreadsheetApp.getUi().showSidebar(
    t.evaluate().setTitle('ADR 嫌疑藥排序').setWidth(420)
  );
}

// ============================================================
// API Key 管理（供前端呼叫）
// ============================================================
function saveApiKey(key) {
  if (!key || !String(key).trim()) throw new Error('API Key 不得為空');
  const clean = String(key).replace(/[^\w\-]/g, '');   // 僅允許英數與連字號
  if (clean.length < 20) throw new Error('API Key 格式異常（長度不足）');
  PropertiesService.getScriptProperties().setProperty('OPENFDA_API_KEY', clean);
  return { success: true, msg: 'Key 已儲存（末4碼：…' + clean.slice(-4) + '）' };
}
function clearApiKey() {
  PropertiesService.getScriptProperties().deleteProperty('OPENFDA_API_KEY');
  return { success: true, msg: 'API Key 已清除' };
}
function getApiKeyStatus() {
  const k = _apiKey();
  if (!k) return { hasKey: false, label: '未設定（限速 40 req/min）' };
  return { hasKey: true, label: '已設定（末4碼：…' + k.slice(-4) + '，限速 240 req/min）' };
}

// ============================================================
// 主進入點：前端呼叫
// payload = { reaction, onsetDate, drugs:[{name,startDate,stopDate,nameInfo?}] }
// nameInfo（選用）：前端藥名選取紀錄，僅透傳供解讀，不影響查詢字串與統計
// ============================================================
function analyzeADR(payload) {
  try {
    _validate(payload);
    const reaction  = String(payload.reaction).trim();
    const sleepMs   = _apiKey() ? CONFIG.SLEEP_WITH_KEY : CONFIG.SLEEP_NO_KEY;

    // ── Step 1：共用分母，僅 2 次 call（快取後後續查詢跳過）──────
    const N      = _cachedFetch('N',   null, CONFIG.CACHE_TTL_LONG, sleepMs);
    const nEvent = _cachedFetch('evt', _tok('patient.reaction.reactionmeddrapt', reaction),
                                CONFIG.CACHE_TTL_LONG, sleepMs);

    if (nEvent === 0) {
      return { success: true, data: {
        meta: _meta(reaction, N, 0), results: [],
        interpretation: generateInterpretation([], _meta(reaction, N, 0)),
        note: `FAERS 查無症狀「${reaction}」之通報（請確認為英文 MedDRA PT）`
      }};
    }

    // ── Step 2：每顆藥序列化查詢，查前等待 sleepMs ──────────────
    const drugList = payload.drugs.slice(0, CONFIG.MAX_DRUGS);
    const results  = [];

    for (const d of drugList) {
      const drug  = String(d.name).trim();
      // nDrug 與 a 各需一次 fetch（若快取命中則不計入 rate limit）
      const nDrug = _cachedFetch('drug', _drugTok(drug), CONFIG.CACHE_TTL_LONG, sleepMs);
      const a     = _cachedFetch('a',
        _drugTok(drug) + '+AND+' + _tok('patient.reaction.reactionmeddrapt', reaction),
        CONFIG.CACHE_TTL_SHORT, sleepMs);

      const stat      = _stats(a, nDrug, nEvent, N);
      const temp      = _temporal(d.startDate, d.stopDate, payload.onsetDate);
      const rorComp   = stat.ror > 1 ? Math.log(stat.ror) : 0;
      const composite = _round(temp.weight * rorComp, 3);

      results.push(Object.assign({ drug, nDrug }, stat, {
        latencyDays: temp.days, temporalWeight: temp.weight,
        temporalFlag: temp.flag, temporalStatus: temp.status, composite,
        nameInfo: _nameInfo(d.nameInfo)
      }));
    }

    // ── Step 3：排序 ───────────────────────────────────────────
    results.sort((x, y) => {
      const xExcl = x.temporalWeight === 0, yExcl = y.temporalWeight === 0;
      if (xExcl !== yExcl) return xExcl ? 1 : -1;
      return y.composite - x.composite;
    });
    results.forEach((r, i) => { r.rank = i + 1; });

    const meta = _meta(reaction, N, nEvent);
    return { success: true, data: { meta, results, interpretation: generateInterpretation(results, meta) } };

  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ============================================================
// 統計核心：2×2 列聯表 → ROR(95%CI) / PRR / χ²（Yates 校正）
// Haldane-Anscombe +0.5 校正（任一格為 0 時啟動）
// ============================================================
function _stats(a, nDrug, nEvent, N) {
  let b = Math.max(nDrug - a, 0);
  let c = Math.max(nEvent - a, 0);
  let d = Math.max(N - a - b - c, 0);

  let A = a, B = b, C = c, D = d, haldane = false;
  if (A === 0 || B === 0 || C === 0 || D === 0) {
    A += .5; B += .5; C += .5; D += .5; haldane = true;
  }

  const ror     = (A * D) / (B * C);
  const se      = Math.sqrt(1/A + 1/B + 1/C + 1/D);
  const lnRor   = Math.log(ror);
  const rorLow  = Math.exp(lnRor - 1.96 * se);
  const rorHigh = Math.exp(lnRor + 1.96 * se);
  const prr     = (A / (A + B)) / (C / (C + D));

  const tot  = A + B + C + D;
  const chi2 = tot * Math.pow(Math.abs(A*D - B*C) - tot/2, 2) /
               ((A+B) * (C+D) * (A+C) * (B+D));

  const signalROR = a >= CONFIG.MIN_REPORTS && rorLow > 1;
  const signalPRR = a >= CONFIG.MIN_REPORTS && prr >= 2 && chi2 >= 4;
  const signal    = signalROR || signalPRR;

  return {
    a, ror: _round(ror, 2), rorLow: _round(rorLow, 2), rorHigh: _round(rorHigh, 2),
    prr: _round(prr, 2), chi2: _round(chi2, 1), signal,
    signalBasis: signal
      ? [signalROR ? 'ROR' : '', signalPRR ? 'PRR' : ''].filter(Boolean).join('+')
      : (a < CONFIG.MIN_REPORTS ? `a<${CONFIG.MIN_REPORTS}` : '未達閾值'),
    haldane
  };
}

// ============================================================
// 時序加權（本地計算，臨床輸入）
// latency = 症狀日 − 用藥起始日；另依停藥日判斷 dechallenge
// ============================================================
function _temporal(startDate, stopDate, onsetDate) {
  if (!startDate || !onsetDate) return { days: null, weight: 1, flag: '缺日期·未加權', status: 'missing' };
  const s = new Date(startDate), o = new Date(onsetDate);
  if (isNaN(s) || isNaN(o))     return { days: null, weight: 1, flag: '日期格式錯誤·未加權', status: 'invalid' };
  const days = Math.round((o - s) / 86400000);
  if (days < 0) return { days: days, weight: 0, flag: '症狀早於用藥·排除', status: 'before' };

  const band = CONFIG.TEMPORAL_BANDS.find(b => days <= b.maxDays);
  let weight = band.weight, flag = band.label + '·用藥中', status = 'on';

  // 停藥後發生症狀 → dechallenge 衰減
  if (stopDate) {
    const st = new Date(stopDate);
    if (!isNaN(st)) {
      const gap = Math.round((o - st) / 86400000);
      if (gap > 0) {
        const dec = CONFIG.POST_STOP_DECAY.find(x => gap <= x.maxGap);
        weight = _round(weight * dec.factor, 2);
        flag = '停藥後 ' + gap + 'd (' + dec.label + ')'; status = 'post';
      }
    }
  }
  return { days: days, weight: weight, flag: flag, status: status };
}

// ============================================================
// 本次分析解讀（Exploratory Interpretation）— 規則式文字，不呼叫 LLM
// 純函式：只讀既有分析輸出（results/meta），不重新查詢 FAERS、不改統計。
// 回傳純文字段落；前端一律以 textContent 呈現（藥名不經 HTML 解析）。
// ⚠ 同步維護：Code.gs 與 docs/app.js 各一份，邏輯須逐字一致（tests/ 會比對輸出）。
// 措辭規則：不得宣稱個案因果；ROR 不是風險/機率；排序分數不是致病機率。
// ============================================================
var INTERP_LIMITS = '本結果僅用於 ADR 候選藥品優先檢視。FAERS 不相稱性訊號不等於個案因果關係；' +
  '排序分數不是致病機率。仍須結合疾病、檢驗趨勢、既往用藥史、共同用藥、停藥反應與適當的因果評估工具進行獨立判讀。';

function generateInterpretation(results, meta) {
  var list = Array.isArray(results) ? results.filter(function (r) { return r && typeof r === 'object'; }) : [];
  var reaction = (meta && meta.reaction) ? String(meta.reaction) : '（未提供）';
  var sections = [];

  function num(x) { var v = Number(x); return isFinite(v) ? v : null; }
  function fmtW(w) { var s = String(w); return s.indexOf('.') < 0 ? s + '.0' : s; }
  function fmtC(c) { var v = num(c); return v === null ? '—' : v.toFixed(3); }
  function names(arr) { return arr.map(function (x) { return x.r.drug; }).join('、'); }
  function status(r) {
    if (r.temporalStatus) return r.temporalStatus;
    var f = String(r.temporalFlag || '');
    if (r.temporalWeight === 0 && r.latencyDays !== null && r.latencyDays < 0) return 'before';
    if (r.latencyDays === null || r.latencyDays === undefined) return f.indexOf('格式') > -1 ? 'invalid' : 'missing';
    if (f.indexOf('停藥後') === 0) return 'post';
    return 'on';
  }

  if (!list.length) {
    sections.push({ key: 'signal', title: 'A. FAERS 訊號摘要', paragraphs: [
      '本次分析未產生藥品結果（例如 FAERS 查無症狀「' + reaction + '」之通報，或未輸入藥品），因此不提供訊號摘要與排序解讀。'
    ], items: [] });
    sections.push({ key: 'limits', title: 'C. 臨床判讀限制', paragraphs: [INTERP_LIMITS], items: [] });
    return _interpPack(sections);
  }

  // ── 排名：綜合排序沿用既有 rank（無 rank 時用輸入順序）；
  //    ROR-only 排序用同一候選集合，同分依 ROR 下界 → 綜合排序順位 打破平手 ──
  var rows = list.map(function (r, i) { return { r: r, i: i, st: status(r) }; });
  var byComp = rows.slice().sort(function (x, y) {
    var rx = num(x.r.rank), ry = num(y.r.rank);
    rx = rx === null ? x.i + 1 : rx; ry = ry === null ? y.i + 1 : ry;
    return (rx - ry) || (x.i - y.i);
  });
  byComp.forEach(function (x, k) { x.compRank = k + 1; });
  var byRor = rows.slice().sort(function (x, y) {
    var a = num(x.r.ror), b = num(y.r.ror);
    a = a === null ? -Infinity : a; b = b === null ? -Infinity : b;
    if (b !== a) return b - a;
    var la = num(x.r.rorLow), lb = num(y.r.rorLow);
    la = la === null ? -Infinity : la; lb = lb === null ? -Infinity : lb;
    if (lb !== la) return lb - la;
    return x.compRank - y.compRank;
  });
  byRor.forEach(function (x, k) { x.rorRank = k + 1; });

  // ── A. 訊號摘要 ───────────────────────────────────────────
  var n = rows.length;
  var sig = rows.filter(function (x) { return x.r.signal === true; });
  var A = [];
  var sigPhrase = sig.length === n ? (n === 1 ? '達到' : '均達到')
    : sig.length === 0 ? (n === 1 ? '未達到' : '均未達到')
    : '其中 ' + sig.length + ' 項達到';
  A.push('症狀「' + reaction + '」：本次分析共納入 ' + n + ' 項藥品，' + sigPhrase +
    '目前設定的 FAERS 不相稱性訊號門檻（a≥3，且 ROR 95% CI 下界>1，或 PRR≥2 且 χ²≥4）。');

  var top = byComp[0].r;
  var anyPositive = rows.some(function (x) { return num(x.r.composite) > 0; });
  var allExcl = rows.every(function (x) { return x.r.temporalWeight === 0; });
  if (anyPositive) {
    A.push(top.drug + ' 的探索性排序分數（綜合分數）最高（' + fmtC(top.composite) + '），主要來自 ROR ' + top.ror +
      '（95% CI ' + top.rorLow + '–' + top.rorHigh + '）' + (top.haldane ? '†' : '') + '，PRR ' + top.prr +
      (top.signal ? '，達訊號門檻（' + top.signalBasis + '）' : '，但未達訊號門檻（' + top.signalBasis + '）') +
      '。排序第一僅代表優先檢視順序，不代表此藥為本次 ADR 的成因。');
  } else if (allExcl) {
    A.push('所有藥品的時序權重均為 0（症狀日期早於開始用藥），綜合分數皆為 0，本次排序不具鑑別資訊。');
  } else {
    A.push('所有藥品的綜合分數皆為 0（ROR≤1 或時序權重為 0），本次排序不具鑑別資訊；表格順位僅反映同分時的輸入順序。');
  }
  var low = rows.filter(function (x) { var v = num(x.r.ror); return v !== null && v <= 1; });
  if (low.length) {
    A.push(names(low) + ' 的 ROR ≤1（' + low.map(function (x) { return x.r.ror; }).join('、') +
      '）：FAERS 中與此症狀的通報未呈現不相稱偏高，不應視為正向訊號（亦不代表該藥與此症狀無關）。');
  }
  var unsure = rows.filter(function (x) {
    var v = num(x.r.ror), l = num(x.r.rorLow);
    return v !== null && l !== null && v > 1 && l <= 1 && !x.r.signal;
  });
  if (unsure.length) {
    A.push(names(unsure) + ' 的 ROR 點估計 >1，但 95% CI 下界 ≤1 且未達訊號門檻，統計不確定性高。');
  }
  if (rows.some(function (x) { return x.r.haldane; })) {
    A.push('† 表示 2×2 表含零格，已採 Haldane-Anscombe +0.5 校正，數值穩定性較低。');
  }
  var unverified = rows.filter(function (x) { return x.r.nameInfo && x.r.nameInfo.verified === false; });
  if (unverified.length) {
    A.push('下列藥名未經建議清單確認、以輸入文字原樣查詢 FAERS：' + names(unverified) +
      '。拼寫或命名差異可能使通報計數偏低。');
  }
  var brands = rows.filter(function (x) { return x.r.nameInfo && x.r.nameInfo.kind === 'brand'; });
  if (brands.length) {
    A.push(names(brands) + ' 以商品名查詢（generic/brand/medicinalproduct 三欄文字比對），未自動展開為成分名；' +
      '同成分其他品名的通報可能未納入。');
  }
  A.push('註：ROR（Reporting Odds Ratio，報告勝算比）反映自願通報資料中的通報比例不相稱程度，' +
    '不是發生風險、相對風險，也不是個案因果機率。');
  sections.push({ key: 'signal', title: 'A. FAERS 訊號摘要', paragraphs: A, items: [] });

  // ── B. 時序資訊與排序貢獻 ─────────────────────────────────
  var B = [], items = [];
  var missing = rows.filter(function (x) { return x.st === 'missing' || x.st === 'invalid'; });
  var before = rows.filter(function (x) { return x.st === 'before'; });
  var post = rows.filter(function (x) { return x.st === 'post'; });
  var valid = rows.filter(function (x) { return x.st === 'on' || x.st === 'post'; });

  if (missing.length === n) {
    B.push('所有藥品均缺少有效的用藥起始日或症狀發生日（時序權重以 1.0 暫計、未加權），時間關係無法評估；' +
      '本次排序完全由 ROR 決定，不應解讀為時間關係合理。');
  } else if (missing.length) {
    B.push(names(missing) + ' 缺少有效日期（' + missing.map(function (x) { return x.r.temporalFlag; }).join('、') +
      '），時序權重以 1.0 暫計（未加權），時間關係無法充分評估，不應解讀為時間關係合理。');
  }
  if (before.length) {
    B.push(names(before) + ' 的症狀日期早於開始用藥：時間順序不符合「該藥引發本次事件」的初始假設，' +
      '綜合分數以權重 0 計並沉底；但不宜據此在所有臨床情境下排除該藥（例如日期記錄誤差、先前曾使用同藥或同類藥）。');
  }
  if (post.length) {
    B.push(post.map(function (x) { return x.r.drug + '（' + x.r.temporalFlag + '，權重 ' + fmtW(x.r.temporalWeight) + '）'; }).join('、') +
      ' 於停藥後才出現症狀，已套用停藥後衰減係數（啟發式，未納入個別藥物半衰期）。');
  }

  var weights = rows.map(function (x) { return num(x.r.temporalWeight); });
  var allSame = weights.every(function (w) { return w === weights[0]; });
  if (allSame && weights[0] !== 0 && missing.length !== n) {
    var lead = '';
    if (valid.length === n) {
      var lat = valid.map(function (x) { return num(x.r.latencyDays); });
      lead = (n === 1 ? '此藥' : n + ' 項藥品均') + '於症狀出現前（或當日）開始使用（潛伏期 ' +
        Math.min.apply(null, lat) + (n > 1 ? '–' + Math.max.apply(null, lat) : '') + ' 天），且';
    }
    B.push(lead + (n === 1 ? '時間權重為 ' : '時間權重均為 ') + fmtW(weights[0]) +
      '，因此時序權重並未改變本次排序；此排名實際上由 ROR 大小決定。');
  } else if (!allSame) {
    var maxW = Math.max.apply(null, weights);
    var down = rows.filter(function (x) { return num(x.r.temporalWeight) < maxW; });
    B.push('各藥時間權重不一致，下列藥品的綜合分數受時序權重調降：' +
      down.map(function (x) { return x.r.drug + '（權重 ' + fmtW(x.r.temporalWeight) + '，' + x.r.temporalFlag + '）'; }).join('、') + '。');
  }

  var changed = byComp.filter(function (x) { return x.rorRank !== x.compRank; });
  if (changed.length) {
    B.push('與僅依 ROR 排序（同一候選集合；ROR 同分依 95% CI 下界、再依綜合排序順位）相比，下列藥品順位不同' +
      '（綜合分數同分者沿用輸入順序）：');
    changed.forEach(function (x) {
      items.push(x.r.drug + '：ROR 排序第 ' + x.rorRank + ' → 綜合排序第 ' + x.compRank);
    });
  } else if (!allSame) {
    B.push('雖時間權重不同，但與僅依 ROR 排序相比，各藥順位未改變。');
  }

  if (valid.length) {
    var bands = (CONFIG.TEMPORAL_BANDS || []).map(function (b) { return b.label + '=' + fmtW(b.weight); }).join('、');
    B.push('時序分帶採本工具通用時間窗（' + bands + '；停藥後另乘衰減），並非針對「' + reaction +
      '」的 ADR-specific latency，尚未依不同致病機轉評估特定潛伏期。');
  }
  sections.push({ key: 'temporal', title: 'B. 時序資訊與排序貢獻', paragraphs: B, items: items });

  // ── C. 臨床判讀限制（固定文字）───────────────────────────
  sections.push({ key: 'limits', title: 'C. 臨床判讀限制', paragraphs: [INTERP_LIMITS], items: [] });
  return _interpPack(sections);
}

function _interpPack(sections) {
  var text = sections.map(function (s) {
    return [s.title].concat(s.paragraphs, s.items.map(function (t) { return '・' + t; })).join('\n');
  }).join('\n\n');
  return { method: 'rule-based', sections: sections, text: text };
}

// 前端傳入的藥名來源資訊（autocomplete 選取紀錄）；白名單＋長度上限，僅供解讀/紀錄，不參與統計
function _nameInfo(info) {
  if (!info || typeof info !== 'object') return null;
  var out = {};
  ['displayName', 'genericName', 'brandName', 'source', 'rxcui', 'queryName', 'kind'].forEach(function (k) {
    if (info[k] !== null && info[k] !== undefined && info[k] !== '') out[k] = String(info[k]).slice(0, 160);
  });
  out.verified = info.verified === true;
  return out;
}

// ============================================================
// API 查詢層：快取優先，miss 才打 HTTP；miss 後 sleep 節流
// ============================================================
function _cachedFetch(type, searchExpr, ttl, sleepMs) {
  const cache = CacheService.getScriptCache();
  const key   = 'f2_' + type + '_' + _md5(String(searchExpr));  // 'f2_' 前綴避免舊快取衝突
  const hit   = cache.get(key);
  if (hit !== null) return Number(hit);       // 快取命中：不計速率

  // Cache miss → 實際打 HTTP 前先 sleep（首次 N 不 sleep，後續才需要）
  if (sleepMs > 0 && type !== 'N') Utilities.sleep(sleepMs);
  const val = _faersTotal(searchExpr);
  cache.put(key, String(val), ttl);
  return val;
}

function _faersTotal(searchExpr) {
  let url = CONFIG.ENDPOINT + '?limit=1';
  if (searchExpr) url += '&search=' + searchExpr;
  const k = _apiKey();
  if (k) url += '&api_key=' + encodeURIComponent(k);

  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const json = JSON.parse(resp.getContentText());
  if (json.error) {
    if (json.error.code === 'NOT_FOUND') return 0;
    throw new Error('OpenFDA: ' + json.error.message);
  }
  return (json.meta && json.meta.results) ? json.meta.results.total : 0;
}

// ── 藥名正規化：generic / brand / medicinalproduct 三欄 OR ──
function _drugTok(name) {
  const v = _clean(name);
  return '(' + [
    'patient.drug.openfda.generic_name:"' + v + '"',
    'patient.drug.openfda.brand_name:"' + v + '"',
    'patient.drug.medicinalproduct:"' + v + '"'
  ].map(encodeURIComponent).join('+OR+') + ')';
}
function _tok(field, value) { return encodeURIComponent(field + ':"' + _clean(value) + '"'); }
function _clean(s) { return String(s).replace(/["\\]/g, '').trim(); }

// ── 工具函式 ──────────────────────────────────────────────────
function _validate(p) {
  if (!p || !p.reaction || !String(p.reaction).trim())
    throw new Error('請輸入症狀（英文 MedDRA PT）');
  if (!p.drugs || !p.drugs.length)
    throw new Error('請至少輸入一項藥品');
  if (p.drugs.length > CONFIG.MAX_DRUGS)
    throw new Error(`藥品數上限為 ${CONFIG.MAX_DRUGS} 項`);
  p.drugs.forEach(d => {
    if (!d.name || !String(d.name).trim()) throw new Error('藥品名稱不得為空');
  });
}
function _meta(reaction, N, nEvent) {
  return {
    reaction, N, nEvent,
    queriedAt: new Date().toISOString(),
    dataLag: 'FAERS 資料約落後 3 個月以上（季更）'
  };
}
function _apiKey() {
  return PropertiesService.getScriptProperties().getProperty('OPENFDA_API_KEY') || '';
}
function _round(x, n) { const f = Math.pow(10, n); return Math.round(x * f) / f; }
function _md5(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s)
    .map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
}
