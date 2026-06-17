// ============================================================
// FAERS ADR 嫌疑藥排序 — 靜態（純前端）分析引擎
// Version: 2.2.0  |  License: MIT  |  教學/練習用途，非臨床決策工具
// ------------------------------------------------------------
// 本檔是 Code.gs 的瀏覽器移植版：直接以 fetch 打 OpenFDA（支援 CORS），
// 不需任何後端。API key 存於瀏覽器 localStorage（使用者自備、不上傳第三方）。
//
// ⚠ 同步維護提醒：統計與時序數學（_stats / _temporal / CONFIG 閾值）與
//   根目錄 Code.gs 必須保持一致。改任一邊的公式或閾值，另一邊也要同步改，
//   並更新 docs/methodology.md。（無 bundler，故無法共用同一份原始碼。）
// ⚠ 訊號偵測 ≠ 因果；FAERS 為自願通報，無分母、有通報偏差。
// ============================================================

(function (global) {
  'use strict';

  var CONFIG = {
    VERSION: '2.2.0',
    ENDPOINT: 'https://api.fda.gov/drug/event.json',
    MAX_DRUGS: 10,
    MIN_REPORTS: 3,             // 訊號最低通報數 (a≥3)
    // 速率限制緩衝（OpenFDA: 無 key=40/min、有 key=240/min；安全間隔 ≈ 60000/limit × 1.2）
    SLEEP_NO_KEY: 1800,
    SLEEP_WITH_KEY: 300,
    // 時序加權帶（啟發式，可調整）
    TEMPORAL_BANDS: [
      { maxDays: 90,       weight: 1.0, label: '急性窗 (≤90d)' },
      { maxDays: 180,      weight: 0.6, label: '亞急性 (91–180d)' },
      { maxDays: Infinity, weight: 0.3, label: '慢性 (>180d)' }
    ],
    // 停藥後衰減（dechallenge）；啟發式，未納入個別藥物半衰期
    POST_STOP_DECAY: [
      { maxGap: 7,        factor: 0.7, label: '停藥≤7d' },
      { maxGap: 30,       factor: 0.4, label: '停藥8–30d' },
      { maxGap: Infinity, factor: 0.1, label: '停藥>30d' }
    ]
  };

  var LS_KEY = 'faers_openfda_api_key';

  // ── API Key 管理（localStorage；對齊 Code.gs 的回傳格式）────────
  function _apiKey() {
    try { return localStorage.getItem(LS_KEY) || ''; } catch (e) { return ''; }
  }
  function saveApiKey(key) {
    if (!key || !String(key).trim()) throw new Error('API Key 不得為空');
    var clean = String(key).replace(/[^\w\-]/g, '');   // 僅允許英數與連字號
    if (clean.length < 20) throw new Error('API Key 格式異常（長度不足）');
    localStorage.setItem(LS_KEY, clean);
    return { success: true, msg: 'Key 已儲存於本機瀏覽器（末4碼：…' + clean.slice(-4) + '）' };
  }
  function clearApiKey() {
    localStorage.removeItem(LS_KEY);
    return { success: true, msg: 'API Key 已自本機清除' };
  }
  function getApiKeyStatus() {
    var k = _apiKey();
    if (!k) return { hasKey: false, label: '未設定（限速 40 req/min）' };
    return { hasKey: true, label: '已設定（末4碼：…' + k.slice(-4) + '，限速 240 req/min）' };
  }

  // ── 工具 ──────────────────────────────────────────────────────
  function _round(x, n) { var f = Math.pow(10, n); return Math.round(x * f) / f; }
  function _clean(s) { return String(s).replace(/["\\]/g, '').trim(); }
  function _tok(field, value) { return encodeURIComponent(field + ':"' + _clean(value) + '"'); }
  function _drugTok(name) {
    var v = _clean(name);
    return '(' + [
      'patient.drug.openfda.generic_name:"' + v + '"',
      'patient.drug.openfda.brand_name:"' + v + '"',
      'patient.drug.medicinalproduct:"' + v + '"'
    ].map(encodeURIComponent).join('+OR+') + ')';
  }
  function _sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function _validate(p) {
    if (!p || !p.reaction || !String(p.reaction).trim())
      throw new Error('請輸入症狀（英文 MedDRA PT）');
    if (!p.drugs || !p.drugs.length)
      throw new Error('請至少輸入一項藥品');
    if (p.drugs.length > CONFIG.MAX_DRUGS)
      throw new Error('藥品數上限為 ' + CONFIG.MAX_DRUGS + ' 項');
    p.drugs.forEach(function (d) {
      if (!d.name || !String(d.name).trim()) throw new Error('藥品名稱不得為空');
    });
  }
  function _meta(reaction, N, nEvent) {
    return {
      reaction: reaction, N: N, nEvent: nEvent,
      queriedAt: new Date().toISOString(),
      dataLag: 'FAERS 資料約落後 3 個月以上（季更）'
    };
  }

  // ── 統計核心：2×2 → ROR(95%CI)/PRR/χ²（Yates）；Haldane +0.5 零格校正 ──
  // 與 Code.gs._stats 數學一致
  function _stats(a, nDrug, nEvent, N) {
    var b = Math.max(nDrug - a, 0);
    var c = Math.max(nEvent - a, 0);
    var d = Math.max(N - a - b - c, 0);

    var A = a, B = b, C = c, D = d, haldane = false;
    if (A === 0 || B === 0 || C === 0 || D === 0) {
      A += 0.5; B += 0.5; C += 0.5; D += 0.5; haldane = true;
    }

    var ror     = (A * D) / (B * C);
    var se      = Math.sqrt(1 / A + 1 / B + 1 / C + 1 / D);
    var lnRor   = Math.log(ror);
    var rorLow  = Math.exp(lnRor - 1.96 * se);
    var rorHigh = Math.exp(lnRor + 1.96 * se);
    var prr     = (A / (A + B)) / (C / (C + D));

    var tot  = A + B + C + D;
    var chi2 = tot * Math.pow(Math.abs(A * D - B * C) - tot / 2, 2) /
               ((A + B) * (C + D) * (A + C) * (B + D));

    var signalROR = a >= CONFIG.MIN_REPORTS && rorLow > 1;
    var signalPRR = a >= CONFIG.MIN_REPORTS && prr >= 2 && chi2 >= 4;
    var signal    = signalROR || signalPRR;

    return {
      a: a, ror: _round(ror, 2), rorLow: _round(rorLow, 2), rorHigh: _round(rorHigh, 2),
      prr: _round(prr, 2), chi2: _round(chi2, 1), signal: signal,
      signalBasis: signal
        ? [signalROR ? 'ROR' : '', signalPRR ? 'PRR' : ''].filter(Boolean).join('+')
        : (a < CONFIG.MIN_REPORTS ? ('a<' + CONFIG.MIN_REPORTS) : '未達閾值'),
      haldane: haldane
    };
  }

  // ── 時序加權（本地計算）；與 Code.gs._temporal 一致 ──────────────
  function _temporal(startDate, stopDate, onsetDate) {
    if (!startDate || !onsetDate) return { days: null, weight: 1, flag: '缺日期·未加權' };
    var s = new Date(startDate), o = new Date(onsetDate);
    if (isNaN(s) || isNaN(o))     return { days: null, weight: 1, flag: '日期格式錯誤·未加權' };
    var days = Math.round((o - s) / 86400000);
    if (days < 0) return { days: days, weight: 0, flag: '症狀早於用藥·排除' };

    var band = CONFIG.TEMPORAL_BANDS.find(function (b) { return days <= b.maxDays; });
    var weight = band.weight, flag = band.label + '·用藥中';

    if (stopDate) {
      var st = new Date(stopDate);
      if (!isNaN(st)) {
        var gap = Math.round((o - st) / 86400000);
        if (gap > 0) {
          var dec = CONFIG.POST_STOP_DECAY.find(function (x) { return gap <= x.maxGap; });
          weight = _round(weight * dec.factor, 2);
          flag = '停藥後 ' + gap + 'd (' + dec.label + ')';
        }
      }
    }
    return { days: days, weight: weight, flag: flag };
  }

  // ── 查詢層：記憶體快取優先，miss 才打 HTTP；miss 後 sleep 節流 ─────
  // 快取僅存於本次工作階段（記憶體 Map），不落地、不含個資。
  var _cache = new Map();
  async function _cachedFetch(type, searchExpr, sleepMs) {
    var key = type + '|' + (searchExpr || '');
    if (_cache.has(key)) return _cache.get(key);   // 命中：不計速率
    if (sleepMs > 0 && type !== 'N') await _sleep(sleepMs);
    var val = await _faersTotal(searchExpr);
    _cache.set(key, val);
    return val;
  }

  async function _faersTotal(searchExpr) {
    var url = CONFIG.ENDPOINT + '?limit=1';
    if (searchExpr) url += '&search=' + searchExpr;
    var k = _apiKey();
    if (k) url += '&api_key=' + encodeURIComponent(k);

    var resp = await fetch(url);                    // OpenFDA 對 NOT_FOUND 回 404＋error body
    var json = await resp.json();
    if (json.error) {
      if (json.error.code === 'NOT_FOUND') return 0;
      throw new Error('OpenFDA: ' + json.error.message);
    }
    return (json.meta && json.meta.results) ? json.meta.results.total : 0;
  }

  // ── 主進入點（async）；回傳形狀同 Code.gs.analyzeADR ───────────────
  // payload = { reaction, onsetDate, drugs:[{name,startDate,stopDate}] }
  // onProgress(pct, label, note) 為選用回呼，用於 UI 進度條
  async function analyzeADR(payload, onProgress) {
    function prog(pct, label, note) { if (typeof onProgress === 'function') onProgress(pct, label, note); }
    try {
      _validate(payload);
      var reaction = String(payload.reaction).trim();
      var sleepMs  = _apiKey() ? CONFIG.SLEEP_WITH_KEY : CONFIG.SLEEP_NO_KEY;
      var drugList = payload.drugs.slice(0, CONFIG.MAX_DRUGS);
      var totalSteps = 2 + drugList.length * 2;     // N + evt + (nDrug + a)×藥
      var step = 0;
      function tick(label, note) {
        step++;
        prog(Math.min(Math.round(step / totalSteps * 100), 99), label, note);
      }

      // Step 1：共用分母
      tick('查詢全庫總數…');
      var N = await _cachedFetch('N', null, sleepMs);
      tick('查詢症狀通報數…', '症狀「' + reaction + '」');
      var nEvent = await _cachedFetch('evt',
        _tok('patient.reaction.reactionmeddrapt', reaction), sleepMs);

      if (nEvent === 0) {
        prog(100, '完成');
        return { success: true, data: {
          meta: _meta(reaction, N, 0), results: [],
          note: 'FAERS 查無症狀「' + reaction + '」之通報（請確認為英文 MedDRA PT）'
        }};
      }

      // Step 2：逐藥查詢
      var results = [];
      for (var i = 0; i < drugList.length; i++) {
        var d = drugList[i];
        var drug = String(d.name).trim();
        tick('查詢藥品通報數…', drug + '（' + (i + 1) + '/' + drugList.length + '）');
        var nDrug = await _cachedFetch('drug', _drugTok(drug), sleepMs);
        tick('查詢藥×症狀交集…', drug + '（' + (i + 1) + '/' + drugList.length + '）');
        var a = await _cachedFetch('a',
          _drugTok(drug) + '+AND+' + _tok('patient.reaction.reactionmeddrapt', reaction), sleepMs);

        var stat = _stats(a, nDrug, nEvent, N);
        var temp = _temporal(d.startDate, d.stopDate, payload.onsetDate);
        var rorComp = stat.ror > 1 ? Math.log(stat.ror) : 0;
        var composite = _round(temp.weight * rorComp, 3);

        results.push(Object.assign({ drug: drug, nDrug: nDrug }, stat, {
          latencyDays: temp.days, temporalWeight: temp.weight,
          temporalFlag: temp.flag, composite: composite
        }));
      }

      // Step 3：排序（時序排除者沉底，其餘依綜合分數）
      results.sort(function (x, y) {
        var xExcl = x.temporalWeight === 0, yExcl = y.temporalWeight === 0;
        if (xExcl !== yExcl) return xExcl ? 1 : -1;
        return y.composite - x.composite;
      });
      results.forEach(function (r, idx) { r.rank = idx + 1; });

      prog(100, '完成');
      return { success: true, data: { meta: _meta(reaction, N, nEvent), results: results } };

    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ── 對外介面（供 docs/index.html 呼叫）──────────────────────────
  global.FAERSApp = {
    VERSION: CONFIG.VERSION,
    analyzeADR: analyzeADR,
    getApiKeyStatus: getApiKeyStatus,
    saveApiKey: saveApiKey,
    clearApiKey: clearApiKey
  };

})(typeof window !== 'undefined' ? window : this);
