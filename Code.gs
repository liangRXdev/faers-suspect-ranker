// ============================================================
// FAERS 多重用藥 ADR 嫌疑藥排序工具（開源教學版 / Educational）
// Version: 2.2.0  |  Author: liangRXdev  |  License: MIT
// ⚠ 教學/練習用途，非臨床決策工具 — 詳見 DISCLAIMER.md
// 方法：反向查詢 (症狀→藥) + ROR/PRR 不相稱性分析 + 本地時序加權
// Guideline ref: EVDAS disproportionality criteria; van Puijenbroek 2002 (ROR)
// ⚠ 訊號偵測 ≠ 因果；FAERS 為自願通報，無分母、有通報偏差
// ============================================================

const CONFIG = {
  VERSION: '2.2.0',
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
// payload = { reaction, onsetDate, drugs:[{name,startDate}] }
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
        temporalFlag: temp.flag, composite
      }));
    }

    // ── Step 3：排序 ───────────────────────────────────────────
    results.sort((x, y) => {
      const xExcl = x.temporalWeight === 0, yExcl = y.temporalWeight === 0;
      if (xExcl !== yExcl) return xExcl ? 1 : -1;
      return y.composite - x.composite;
    });
    results.forEach((r, i) => { r.rank = i + 1; });

    return { success: true, data: { meta: _meta(reaction, N, nEvent), results } };

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
  if (!startDate || !onsetDate) return { days: null, weight: 1, flag: '缺日期·未加權' };
  const s = new Date(startDate), o = new Date(onsetDate);
  if (isNaN(s) || isNaN(o))     return { days: null, weight: 1, flag: '日期格式錯誤·未加權' };
  const days = Math.round((o - s) / 86400000);
  if (days < 0) return { days: days, weight: 0, flag: '症狀早於用藥·排除' };

  const band = CONFIG.TEMPORAL_BANDS.find(b => days <= b.maxDays);
  let weight = band.weight, flag = band.label + '·用藥中';

  // 停藥後發生症狀 → dechallenge 衰減
  if (stopDate) {
    const st = new Date(stopDate);
    if (!isNaN(st)) {
      const gap = Math.round((o - st) / 86400000);
      if (gap > 0) {
        const dec = CONFIG.POST_STOP_DECAY.find(x => gap <= x.maxGap);
        weight = _round(weight * dec.factor, 2);
        flag = '停藥後 ' + gap + 'd (' + dec.label + ')';
      }
    }
  }
  return { days: days, weight: weight, flag: flag };
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
