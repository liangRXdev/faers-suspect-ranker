# CLAUDE.md — 專案規則（供 Claude Code / AI 協作工具）

本檔定義本專案的開發規則與約束。AI 協作工具在修改本 repo 前**必須**遵守。
人類貢獻者也應視此為 contributing guideline。

## 0. 專案一句話

教學用的 FAERS ADR 嫌疑藥排序工具：GAS 後端（單一 OpenFDA endpoint）+ vanilla JS 前端，
做反向查詢、ROR/PRR 不相稱性、時序加權、Naranjo/WHO-UMC 因果評分。

## 1. 不可踰越的紅線（HARD CONSTRAINTS）

1. **絕不硬編碼 API key 或任何憑證。** 一律走 `PropertiesService`。
   提交前掃描 `git log -p` 確認歷史無殘留。VITE_/env 內聯亦禁止。
2. **絕不內嵌完整 MedDRA PT 清單。** `PT_DB` 只能是少量範例（< 30 條）。
   完整清單受 MSSO 授權，靠 OpenFDA 動態建議補足。
3. **絕不移除或弱化醫療免責。** `DISCLAIMER.md`、結果區的判讀限制 `.notice`、
   方法說明 `details.method` 必須保留。本工具定位為「教學/練習用，非臨床決策」。
4. **絕不把訊號呈現為因果。** ROR/PRR/綜合分數一律標示為「訊號偵測」「排序輔助」，
   不得用「風險」「致病機率」等因果語言。
5. **絕不收集或上傳 PII。** 不寫入可識別個資；日期/藥名僅用於即時計算，不落地儲存。
6. **量表計分規則不可隨意更動。** Naranjo 點值與分級（≥9/5-8/1-4/≤0）、
   WHO-UMC 類別定義依原始文獻；若調整須在 `docs/methodology.md` 標註並附引用。

## 2. 架構約定

- 後端 `Code.gs`：所有商業邏輯（查詢、統計、時序）。前端 `Index.html`：UI 與互動。
  **不混置**：HTML 不放統計邏輯，`.gs` 不放 DOM 操作。
- 前後端介面契約：`analyzeADR(payload)` →
  `payload = { reaction, onsetDate, drugs:[{name, startDate, stopDate}] }`，
  回傳 `{ success, data:{ meta, results:[...] } }` 或 `{ success:false, error }`。
  **改任一端的欄位名，必須同步改另一端**，並更新 §6 的驗證。
- 僅依賴單一 endpoint `api.fda.gov/drug/event.json`。新增資料源前先評估是否真的必要。
- 無建置步驟（no bundler）。前端為純 vanilla JS + CDN 載入的 Bootstrap 5，可直接貼進 GAS。

## 3. GAS 專屬注意事項（踩過的坑）

- **改碼後必須重新部署「新版本」**，僅存檔不會更新線上 Web App。
- **template literal 內避免巢狀引號 / inline `onclick`**：一律用
  `document.createElement` + `addEventListener`，否則可能整頁解析失敗（只剩 header）。
- 陣列在 GAS 會以 Java 物件參考儲存；跨層傳遞用 `JSON.stringify` / `join`。
- Google Sheets 取回的是 `Date` 物件，需轉字串再用。
- 昂貴的外部請求（如本專案的 FAERS 總數）走 `CacheService`，並做 sleep 節流
  （無 key 1800ms、有 key 300ms；快取命中不 sleep）。
- 正確部署 URL 格式：`https://script.google.com/macros/s/.../exec`。

## 4. 統計正確性規則

- 2×2：`a`=藥∩症狀、`a+b`=藥總數、`a+c`=症狀總數、`N`=全庫；
  `b,c,d` 由減法得，並 `max(…,0)` 防資料落差導致負值。
- 任一格為 0 → Haldane-Anscombe +0.5 校正，並在 UI 標 `†`。
- `ROR = ad/bc`；95% CI = `exp(ln(ROR) ± 1.96·√(1/a+1/b+1/c+1/d))`。
- `PRR = [a/(a+b)] / [c/(c+d)]`；χ² 用 Yates 校正。
- 訊號門檻：`a≥3` 且（ROR 下界>1）或（PRR≥2 且 χ²≥4）。`MIN_REPORTS` 等閾值集中在 `CONFIG`。

## 5. 時序與因果規則

- `_temporal(start, stop, onset)`：`latency = onset − start`。
  `latency<0` → weight 0（症狀早於用藥，排除）。
  停藥後（`onset>stop`）→ 潛伏期帶權重 × `POST_STOP_DECAY` 衰減係數。
- 所有時序帶與衰減係數**集中在 `CONFIG`**（`TEMPORAL_BANDS`、`POST_STOP_DECAY`），
  並在註解標明「啟發式、可調整」。改數值須同步更新前端 `details.method` 文字與 `docs`。
- Naranjo/WHO-UMC 為**個案**評估，與 FAERS **群體**訊號互補；UI 須維持兩者區隔的措辭。
- 智慧預填（由時序資料帶入量表）必須**可被使用者覆寫**，且標註「請依病歷核對」。

## 6. 設計系統（必須沿用）

- 色票（CSS variables）：`--bg-primary:#F5F0E8`（MUJI 暖米）、`--accent:#3D7A8A`、
  `--danger:#C0392B`、`--success:#27AE60`、`--warning:#E67E22`。
- 字體：Noto Sans TC（介面）、JetBrains Mono（數字 `.num`）。
- 觸控目標 ≥ 44px；**禁用漸層**與裝飾性反模式；圓角用既有 `--radius-*`。
- **回饋用 inline 元素，不用 `alert()`**（錯誤走 `#errMsg`，成功走按鈕文字切換）。
- 動態內容一律 `textContent` / `createElement`，**不得用 `innerHTML` 注入使用者輸入**
  （高亮等少數例外須先 escape）。

## 7. 提交前自我檢查（CI 心法）

```bash
# 1) 抽出 <script> 做語法檢查（移除 GAS scriptlet）
node -e "const fs=require('fs');let h=fs.readFileSync('Index.html','utf8');\
let m=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)];\
let js=m.map(x=>x[1]).join('\n;\n').replace(/<\?=[\s\S]*?\?>/g,'\"X\"');\
new Function(js);console.log('JS OK');"

# 2) 前後端欄位契約一致（payload / result 欄位名）
grep -n "startDate\|stopDate\|onsetDate\|reaction" Code.gs Index.html

# 3) 機敏掃描
grep -rni "api_key\s*=\|apikey\s*=\|Bearer " . || echo "no hardcoded keys"
git log -p | grep -i "api_key" || echo "history clean"

# 4) 紅線檢查：PT_DB 不可過長、機構名不可殘留
node -e "const h=require('fs').readFileSync('Index.html','utf8');\
console.log('PT entries:',(h.match(/{pt:'/g)||[]).length);"  # 應 < 30
```

## 8. 工作風格

- 偏好**小而精準的增量修改**，非整檔重寫（除非整合需要完整檔）。
- 每次改動要能對應到一個明確的臨床或技術理由。
- 不確定臨床語意時，**先問再改**，勿自行放寬安全相關措辭。
- 新增外部 CDN 依賴前，考量醫院防火牆封鎖風險（可加 SRI 或改本地化）。

## 9. 名詞對照（避免誤用）

| 用語 | 正確語意 |
|---|---|
| 訊號 (signal) | 不相稱性偵測結果，**非因果** |
| 綜合分數 | 排序輔助分數，**非機率** |
| dechallenge | 停藥後反應變化 |
| 嫌疑藥 (suspect drug) | 待評估對象，**非確定致病藥** |
