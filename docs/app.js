// ============================================================
// FAERS ADR 嫌疑藥排序 — 靜態（純前端）分析引擎
// Version: 2.4.0  |  License: MIT  |  教學/練習用途，非臨床決策工具
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
    VERSION: '2.4.0',
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
    ],
    // ── 疑似藥比例（輔助指標；不參與排序）──────────────────────
    SP_LIMIT: 100,           // 每組藥+ADR 最多抽樣通報數（最近通報，依 receivedate 排序）
    SP_MIN_VALID: 10,        // 有效分母低於此值標示「樣本少」
    SP_MAX_BYTES: 40000000,  // 解壓後回應位元組上限；超過即報錯，不截斷計算
    SP_TIMEOUT_MS: 60000,    // Pages：每次嘗試期限（送出→body 解析完成）
    SP_RETRY_DELAY: 2000,    // 429／5xx／網路／逾時重試前等待；整次操作最多 2 次嘗試
    SP_CACHE_TTL: 3600,      // GAS CacheService 摘要快取秒數
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
    if (!startDate || !onsetDate) return { days: null, weight: 1, flag: '缺日期·未加權', status: 'missing' };
    var s = new Date(startDate), o = new Date(onsetDate);
    if (isNaN(s) || isNaN(o))     return { days: null, weight: 1, flag: '日期格式錯誤·未加權', status: 'invalid' };
    var days = Math.round((o - s) / 86400000);
    if (days < 0) return { days: days, weight: 0, flag: '症狀早於用藥·排除', status: 'before' };

    var band = CONFIG.TEMPORAL_BANDS.find(function (b) { return days <= b.maxDays; });
    var weight = band.weight, flag = band.label + '·用藥中', status = 'on';

    if (stopDate) {
      var st = new Date(stopDate);
      if (!isNaN(st)) {
        var gap = Math.round((o - st) / 86400000);
        if (gap > 0) {
          var dec = CONFIG.POST_STOP_DECAY.find(function (x) { return gap <= x.maxGap; });
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

  // ============================================================
  // 疑似藥比例（Suspect Drug Proportion）— 純函式（v2.4.0 起）
  // 探索性輔助指標：抽樣通報中，目標藥被通報者標記為 Suspect(1)/Interacting(3) 的比例。
  // Suspect 是通報者的角色判定，非因果；本指標不納入綜合分數、不影響排序與解讀文字。
  // ⚠ 同步維護：Code.gs 與 docs/app.js 各一份，邏輯須一致（tests/suspect-*.test.js 比對兩端輸出）。
  // 規則來源：.ai-review/plan.md §5 D3（條目辨識）、D4（通報分類）、D5（摘要）、§7（回應判定）。
  // ============================================================
  var SP_SALTS = ['HYDROCHLORIDE', 'HCL', 'SODIUM', 'POTASSIUM', 'CALCIUM', 'MAGNESIUM', 'SULFATE', 'PHOSPHATE',
    'ACETATE', 'MALEATE', 'MESYLATE', 'TARTRATE', 'CITRATE', 'SUCCINATE', 'FUMARATE', 'BESYLATE', 'BROMIDE',
    'CHLORIDE', 'HYDROBROMIDE', 'DIHYDRATE', 'MONOHYDRATE', 'ANHYDROUS'];

  function _spTokens(s) {
    if (typeof s !== 'string') return null;
    var t = s.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
    return t ? t.split(' ') : [];
  }
  function _spIsSalt(t) { return SP_SALTS.indexOf(t) > -1; }
  function _spStrArr(x) {
    return Array.isArray(x) ? x.filter(function (e) { return typeof e === 'string' && e.trim() !== ''; }) : [];
  }
  // 複方訊號：AND / WITH / + / 逗號 / 字母間斜線（數字間斜線如 500MG/5ML 不算）
  function _spCombo(s) { return /\bAND\b|\bWITH\b|\+|,|[A-Z]\s*\/\s*[A-Z]/.test(String(s).toUpperCase()); }

  // 本列比對器：正規化模式每列決定一次（STRIP：去鹽後仍有 token；FULL：藥名全由鹽類組成）
  function _spMatcher(drugName) {
    var base = _spTokens(_clean(drugName)) || [];
    var strip = base.filter(function (x) { return !_spIsSalt(x); }).length > 0;
    function moiety(s) {
      var t = _spTokens(s);
      if (t === null) return null;
      if (!strip) return t.join(' ');
      var r = t.filter(function (x) { return !_spIsSalt(x); });
      return r.length ? r.join(' ') : '#' + t.join(' ');      // 去鹽後為空：保留完整 tokens，不刪除該元素
    }
    var M = base.length ? moiety(_clean(drugName)) : '';
    return {
      mode: strip ? 'STRIP' : 'FULL',
      M: M,
      moiety: moiety,
      exact: function (v) { return M !== '' && moiety(v) === M; },
      hit: function (v) {
        var t = _spTokens(v);
        return M !== '' && t !== null && t.length > 0 && (' ' + t.join(' ') + ' ').indexOf(' ' + M + ' ') > -1;
      }
    };
  }

  // D3：單一 patient.drug[] 條目 → { cls: none|ambiguous|combo|target, rule: 決策表列號 }
  function _spClassifyEntry(d, m) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) return { cls: 'none', rule: 1 };
    var of = (d.openfda && typeof d.openfda === 'object' && !Array.isArray(d.openfda)) ? d.openfda : {};
    var GN = _spStrArr(of.generic_name), BN = _spStrArr(of.brand_name);
    var MP = (typeof d.medicinalproduct === 'string' && d.medicinalproduct.trim() !== '') ? [d.medicinalproduct] : [];
    if (!GN.concat(BN, MP).some(m.hit)) return { cls: 'none', rule: 1 };
    if (!GN.length) return { cls: 'ambiguous', rule: 2 };      // 無協調 generic：名稱相等不足以確認單方
    if (GN.some(_spCombo)) return { cls: 'combo', rule: 3 };
    var set = {};
    GN.forEach(function (g) { set[m.moiety(g)] = true; });
    if (Object.keys(set).length > 1) return { cls: 'combo', rule: 4 };
    if (GN.every(m.exact)) return { cls: 'target', rule: 5 };
    if (BN.some(m.exact)) return { cls: 'target', rule: 6 };
    return { cls: 'ambiguous', rule: 7 };
  }

  // 有效角色只認字串 "1"/"2"/"3" 或數字 1/2/3；其餘（含 true、"1 "、陣列）皆無效 → 0
  function _spRole(v) {
    if (v === '1' || v === 1) return 1;
    if (v === '2' || v === 2) return 2;
    if (v === '3' || v === 3) return 3;
    return 0;
  }
  var SP_ROLE_RANK = { 1: 3, 3: 2, 2: 1 };                     // 優先順序 Suspect > Interacting > Concomitant
  var SP_ROLE_CAT = { 1: 'suspect', 3: 'interacting', 2: 'concomitant' };

  // D4：單份通報 → { cat, entries }；entries 為所有 hit 候選條目（稽核用）
  function _spClassifyReport(r, m) {
    var drugs = (r && typeof r === 'object' && !Array.isArray(r) && r.patient && typeof r.patient === 'object' &&
      Array.isArray(r.patient.drug)) ? r.patient.drug : [];
    var entries = [], best = 0, hasTarget = false, hasCombo = false, hasAmb = false;
    drugs.forEach(function (d) {
      var c = _spClassifyEntry(d, m);
      if (c.cls === 'none') return;
      var role = _spRole(d.drugcharacterization);
      var of = (d.openfda && typeof d.openfda === 'object') ? d.openfda : {};
      entries.push({ cls: c.cls, rule: c.rule, role: role, rawRole: d.drugcharacterization === undefined ? null : d.drugcharacterization,
        generic_name: _spStrArr(of.generic_name), brand_name: _spStrArr(of.brand_name),
        medicinalproduct: typeof d.medicinalproduct === 'string' ? d.medicinalproduct : null });
      if (c.cls === 'target') {
        hasTarget = true;
        if (role && (!best || SP_ROLE_RANK[role] > SP_ROLE_RANK[best])) best = role;
      } else if (c.cls === 'combo') hasCombo = true;
      else hasAmb = true;
    });
    var cat = hasTarget ? (best ? SP_ROLE_CAT[best] : 'invalidRole')
      : hasCombo ? 'combo' : hasAmb ? 'ambiguous' : 'unmatched';
    return { cat: cat, entries: entries };
  }

  // 合法日曆日期 YYYYMMDD → 'YYYY-MM-DD'；否則 null
  function _spDate(s) {
    if (typeof s !== 'string' || !/^\d{8}$/.test(s)) return null;
    var y = +s.slice(0, 4), mo = +s.slice(4, 6), d = +s.slice(6, 8);
    var dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  }

  // D5：抽樣通報陣列 → 計數摘要（不含 drug/reaction/fetchedAt）
  function computeSuspectProportion(reports, drugName) {
    var list = Array.isArray(reports) ? reports : [];
    var m = _spMatcher(drugName);
    var n = { suspect: 0, interacting: 0, concomitant: 0, invalidRole: 0, combo: 0, ambiguous: 0, unmatched: 0 };
    var from = null, to = null;
    list.forEach(function (r) {
      n[_spClassifyReport(r, m).cat]++;
      var dt = (r && typeof r === 'object') ? _spDate(r.receivedate) : null;
      if (dt) {
        if (from === null || dt < from) from = dt;
        if (to === null || dt > to) to = dt;
      }
    });
    var valid = n.suspect + n.interacting + n.concomitant;
    return {
      sampled: list.length, valid: valid,
      suspect: n.suspect, interacting: n.interacting, concomitant: n.concomitant,
      invalidRole: n.invalidRole, combo: n.combo, ambiguous: n.ambiguous, unmatched: n.unmatched,
      pct: valid ? Math.round((n.suspect + n.interacting) / valid * 100) : null,
      lowSample: valid >= 1 && valid < CONFIG.SP_MIN_VALID,
      periodFrom: from, periodTo: to
    };
  }

  function _spSummary(drug, reaction, results) {
    var s = computeSuspectProportion(results, drug);
    var out = { drug: drug, reaction: reaction };
    Object.keys(s).forEach(function (k) { out[k] = s[k]; });
    out.sampleMode = 'recent-receivedate';
    out.fetchedAt = new Date().toISOString();
    return out;
  }

  // §7 錯誤決策表（單次嘗試，傳輸層已處理網路例外與逾時）
  // → {kind:'ok',results} | {kind:'empty'} | {kind:'retry',reason,status} | {kind:'error',reason,status}
  function _spClassifyResponse(status, tooLarge, text) {
    if (status === 429) return { kind: 'retry', reason: 'ratelimit', status: status };
    if (status >= 500 && status <= 599) return { kind: 'retry', reason: 'server', status: status };
    if (status === 404) {
      try {
        var e = JSON.parse(text);
        if (e && e.error && e.error.code === 'NOT_FOUND') return { kind: 'empty' };
      } catch (err) { /* 非 JSON 的 404 → 視為錯誤 */ }
      return { kind: 'error', reason: 'http', status: status };
    }
    if (status !== 200) return { kind: 'error', reason: 'http', status: status };
    if (tooLarge) return { kind: 'error', reason: 'toolarge', status: status };
    var j;
    try { j = JSON.parse(text); } catch (err) { return { kind: 'error', reason: 'format', status: status }; }
    if (!j || typeof j !== 'object' || j.error || !Array.isArray(j.results)) return { kind: 'error', reason: 'format', status: status };
    if (!j.results.length) return { kind: 'empty' };
    return { kind: 'ok', results: j.results };
  }

  // 使用者可見錯誤訊息：不含 API key 或請求 URL
  function _spErrorMessage(reason, status) {
    switch (reason) {
      case 'network': return '網路錯誤，無法連線 openFDA';
      case 'timeout': return '逾時（' + Math.round(CONFIG.SP_TIMEOUT_MS / 1000) + 's）';
      case 'ratelimit': return 'openFDA 限速，請稍後重試或設定 API Key';
      case 'server': return 'openFDA 伺服器錯誤 HTTP ' + status;
      case 'http': return 'openFDA 回應 HTTP ' + status;
      case 'toolarge': return '回應過大（超過 ' + Math.round(CONFIG.SP_MAX_BYTES / 1000000) + ' MB）';
      case 'format': return '回應格式異常';
      default: return '疑似藥比例查詢失敗';
    }
  }

  // UTF-8 位元組數是否超過上限（僅在無法取得原始位元組時使用；字元數先做上下界快篩）
  function _spUtf8Over(text, cap) {
    var n = text.length;
    if (n > cap) return true;
    if (n * 3 <= cap) return false;
    var bytes = 0;
    for (var i = 0; i < n; i++) {
      var c = text.charCodeAt(i);
      if (c < 0x80) bytes += 1;
      else if (c < 0x800) bytes += 2;
      else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < n) { bytes += 4; i++; }
      else bytes += 3;
      if (bytes > cap) return true;
    }
    return false;
  }

  // 查詢身分 key（無歧義；不做大小寫等額外正規化）
  function _spKey(drug, reaction) { return JSON.stringify([_clean(drug), _clean(reaction)]); }

  // 抽樣查詢 URL：與 analyzeADR 的 a（藥∩症狀）同一 search 表達式
  function _spUrl(drug, reaction, apiKey) {
    var url = CONFIG.ENDPOINT + '?search=' + _drugTok(drug) + '+AND+' + _tok('patient.reaction.reactionmeddrapt', reaction) +
      '&limit=' + CONFIG.SP_LIMIT + '&sort=receivedate:desc';
    if (apiKey) url += '&api_key=' + encodeURIComponent(apiKey);
    return url;
  }


  // ── 疑似藥比例：Pages 傳輸（逐列按需；記憶體快取＋同 key 併發合併）──
  // 錯誤不入快取；錯誤訊息不含 API key 或 URL。
  var _spCache = new Map(), _spInflight = new Map();
  var SP_TIMEOUT = {};                                       // 逾時哨兵

  async function _spAttempt(url) {
    var ms = CONFIG.SP_TIMEOUT_MS, start = Date.now(), timer = null, ctrl = null;
    try { ctrl = new AbortController(); } catch (e) { ctrl = null; }
    var expired = new Promise(function (resolve) {
      timer = setTimeout(function () {
        if (ctrl) { try { ctrl.abort(); } catch (e) { /* ignore */ } }
        resolve(SP_TIMEOUT);
      }, ms);
    });
    try {
      var resp = await Promise.race([fetch(url, ctrl ? { signal: ctrl.signal } : {}), expired]);
      if (resp === SP_TIMEOUT) return { kind: 'retry', reason: 'timeout' };
      var buf = await Promise.race([resp.arrayBuffer(), expired]);
      if (buf === SP_TIMEOUT) return { kind: 'retry', reason: 'timeout' };
      var tooLarge = buf.byteLength > CONFIG.SP_MAX_BYTES;
      var text = (resp.status === 200 && tooLarge) ? '' : new TextDecoder('utf-8').decode(buf);
      var c = _spClassifyResponse(resp.status, tooLarge, text);
      if (Date.now() - start > ms) return { kind: 'retry', reason: 'timeout' };   // JSON.parse 不可中斷：完成後檢查期限
      return c;
    } catch (e) {
      return { kind: 'retry', reason: 'network' };
    } finally {
      clearTimeout(timer);
    }
  }

  async function _spRun(drug, reaction) {
    var url = _spUrl(drug, reaction, _apiKey());
    var last = null;
    for (var attempt = 1; attempt <= 2; attempt++) {
      if (attempt > 1) await _sleep(CONFIG.SP_RETRY_DELAY);
      var r = await _spAttempt(url);
      if (r.kind === 'ok' || r.kind === 'empty') {
        return { success: true, data: _spSummary(drug, reaction, r.kind === 'ok' ? r.results : []) };
      }
      last = r;
      if (r.kind !== 'retry') break;
    }
    return { success: false, error: _spErrorMessage(last.reason, last.status), reason: last.reason };
  }

  function suspectProportion(drug, reaction) {
    var d = String(drug === null || drug === undefined ? '' : drug).trim();
    var rx = String(reaction === null || reaction === undefined ? '' : reaction).trim();
    if (!_clean(d) || !_clean(rx)) return Promise.resolve({ success: false, error: '藥品與症狀不得為空' });
    var key = _spKey(d, rx);
    if (_spCache.has(key)) return Promise.resolve({ success: true, data: _spCache.get(key), cached: true });
    if (_spInflight.has(key)) return _spInflight.get(key);
    var p = _spRun(d, rx).then(function (res) {
      _spInflight.delete(key);
      if (res.success) _spCache.set(key, res.data);
      return res;
    }, function () {
      _spInflight.delete(key);
      return { success: false, error: '疑似藥比例計算失敗（系統錯誤）', reason: 'internal' };
    });
    _spInflight.set(key, p);
    return p;
  }

  // 稽核輸出（live 整合驗收用）：與 computeSuspectProportion 同一分類函式，逐報列出候選條目與裁決
  function _spAudit(reports, drugName) {
    var m = _spMatcher(drugName);
    return (Array.isArray(reports) ? reports : []).map(function (r) {
      var c = _spClassifyReport(r, m);
      return { safetyreportid: r && r.safetyreportid, receivedate: r && r.receivedate, cat: c.cat, entries: c.entries };
    });
  }

  // ── 主進入點（async）；回傳形狀同 Code.gs.analyzeADR ───────────────
  // payload = { reaction, onsetDate, drugs:[{name,startDate,stopDate,nameInfo?}] }
  // nameInfo（選用）：前端藥名選取紀錄，僅透傳供解讀，不影響查詢字串與統計
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
          interpretation: generateInterpretation([], _meta(reaction, N, 0)),
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
          temporalFlag: temp.flag, temporalStatus: temp.status, composite: composite,
          nameInfo: _nameInfo(d.nameInfo)
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
      var meta = _meta(reaction, N, nEvent);
      return { success: true, data: { meta: meta, results: results,
        interpretation: generateInterpretation(results, meta) } };

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
    clearApiKey: clearApiKey,
    generateInterpretation: generateInterpretation,
    // 測試用（不改變行為）：讓 tests/ 以相同輸入比對兩端數學
    _stats: _stats,
    _temporal: _temporal,
    // 疑似藥比例（輔助指標；不參與 analyzeADR）
    suspectProportion: suspectProportion,
    computeSuspectProportion: computeSuspectProportion,
    _spClassifyResponse: _spClassifyResponse,
    _spErrorMessage: _spErrorMessage,
    _spUtf8Over: _spUtf8Over,
    _spKey: _spKey,
    _spUrl: _spUrl,
    _spAudit: _spAudit,
    // 測試用：僅允許覆寫 SP_* 設定（縮短逾時等）
    _spSetConfig: function (o) { Object.keys(o || {}).forEach(function (k) { if (/^SP_/.test(k)) CONFIG[k] = o[k]; }); },
    _spResetCache: function () { _spCache.clear(); _spInflight.clear(); }
  };

})(typeof window !== 'undefined' ? window : this);
