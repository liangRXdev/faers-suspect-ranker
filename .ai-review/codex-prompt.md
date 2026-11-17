# 任務：規格層獨立審查（動工前，唯讀）

你是獨立覆審員，只審**規格**（下方 plan 全文），不審程式碼、不寫程式碼。
**唯讀模式：禁止寫入或修改任何檔案，只輸出報告文字。** 不要給程式碼實作建議。
你可以讀 repo 內既有檔案（Code.gs、docs/app.js、docs/index.html、Index.html、tests/、README.md、docs/methodology.md、CLAUDE.md）以核對規格對現況的描述是否正確。

## 專案前提

### (a) 架構限制與刻意取捨
- 教學用 FAERS ADR 嫌疑藥排序工具；兩套引擎刻意並存：GAS（Code.gs + Index.html，API key 在 PropertiesService）與 GitHub Pages 純前端（docs/app.js + docs/index.html，key 在 localStorage）。無 bundler、GAS 無 import → 邏輯只能各放一份，以測試比對兩端輸出（既有 generateInterpretation 即此模式）。這不是缺陷。
- 只依賴 `api.fda.gov/drug/event.json` 做統計；不新增後端、資料庫、npm 相依、框架。
- 測試零依賴（node --test + vm 載入），無 lint、無 CI 測試 workflow。
- 使用者已決策（不要重新爭論）：按需逐列載入（不做全部載入、不自動載入）；複方列為無法確認不進分母；兩版都做；valid<10 顯示比例＋「樣本少」、valid=0 顯示資料不足；PS/SS 不可得只寫文件。
- 前端規範：禁 innerHTML 注入、禁 alert、觸控 ≥44px、不得用因果語言。

### (b) 威脅模型與風險權重
- 無病患資料、無 PII 收集；唯一機密是使用者自備的 openFDA API key（不可外洩於 log/URL 以外的地方、不可硬編碼）。
- 最怕的失敗：(1) 數字誤導臨床判讀——把目標藥誤判為 Suspect（例如因同報其他藥為 Suspect）、不同成分誤合併、把失敗或逾時偽裝成 0% 或空結果；(2) 被解讀為因果或發生率；(3) 悄悄改到既有 ROR/PRR/排序行為（教學結果已被使用）。
- 誤報 vs 漏報：寧可顯示「資料不足／無法確認」，不可推估比例。

## 要求產出四個區塊

每項格式：**嚴重度 / 問題 / 為什麼現在不修之後會更貴 / 建議修法**

嚴重度軸＝「發現得越晚越貴」：
- **Blocker** — 方向錯，寫完要整段重來
- **High** — 要改架構或資料模型
- **Medium** — 要多寫／改程式，但不動架構
- **Low** — 文件或命名層級

1. **需求與邊界缺漏** — 未定義的失敗路徑、邊界值、空資料、外部 API 非 200、併發／重入
2. **架構風險** — 選型是否會撞到已聲明的平台限制（尤其 GAS 處理 ~15 MB JSON、openFDA 回應大小、比對語意與 openFDA 搜尋語意不一致導致 unmatched）；哪個決策最難回頭
3. **驗證策略缺口** — 針對 §8 **每一條驗收條件**回答：什麼樣的弱化實作能讓這條通過、但功能其實是壞的？答得出來者即缺口，請提出堵死該弱化版本的改寫斷言。特別找「涵蓋各種案例但沒指名反例類別」與「驗證某物而非某性質」。
4. **更簡單的替代方案** — 是否 over-engineering；能否用更少元件達成同樣邊界

規則：
- 不要新增「目標與非目標」以外的需求。若真心認為某缺漏必要，標注 `[新增需求]` 並說明不做的具體可觀察後果。
- 若建議與已聲明的架構限制衝突，須明說衝突並改提相容作法。
- 若規格對現有程式碼或 openFDA 行為的描述有誤，請具體指出（檔案/欄位）。

---

# 規格全文（.ai-review/plan.md）

# 規格：疑似藥比例（Suspect Drug Proportion）輔助指標

- 版本：v0.1（2026-11-17）
- Repo：faers-suspect-ranker（base: main bdf4360，分支 feat/suspect-proportion）
- 目標版本號：2.3.0 → 2.4.0

## 1. 目標

在排序結果表格新增「疑似藥比例」欄，針對每列「藥品＋ADR」，從 openFDA FAERS 最近通報抽樣（最多 100 筆），
計算目標藥品在該通報 `patient.drug[]` 中被標記為 Suspect(1) 或 Interacting(3) 的比例：

```
pct = (suspect + interacting) / (suspect + interacting + concomitant) × 100
```

分母僅計入「成功辨識為目標單方藥品」且「角色為 1/2/3」的通報（每份通報至多計 1 次）。
定位：ADR 訊號探索與臨床判讀的輔助資訊，**非 ADR 發生率、非因果機率**。

## 2. 非目標（本次不做）

- N1：不改 ROR、PRR、χ²、時序加權、綜合分數、排序演算法、`generateInterpretation` 輸出（含文字）。
- N2：比例不納入綜合分數、不影響排序、不寫入規則式解讀文字。
- N3：不區分 PS／SS（openFDA `drugcharacterization` 只有 1/2/3，無 FAERS ASCII 的 `role_cod`）；僅在文件說明。
- N4：不做隨機抽樣、不做全量統計、不做 FAERS 重複通報（case 版本／跨廠商重複）去重。
- N5：不新增後端服務、資料庫、bundler、框架或 npm 相依；不新增資料源（仍只用 `api.fda.gov/drug/event.json`）。
- N6：不自動載入所有列；不做「全部載入」按鈕。
- N7：不嘗試用 RxNorm／成分展開把商品名對應到其他品名（沿用現有查詢字串語意）。
- N8：不持久化結果（Pages 版僅記憶體快取；GAS 版 CacheService 只存計數，TTL 1h）。

## 3. 現有架構（事實）

- 兩套引擎、兩套前端，邏輯須同步：
  - GAS：`Code.gs`（後端，`UrlFetchApp`、`CacheService`、API key 在 `PropertiesService`）＋ `Index.html`（`google.script.run`）
  - Pages：`docs/app.js`（瀏覽器直接 fetch openFDA，key 在 localStorage）＋ `docs/index.html`
- 現有查詢：每藥 2 次 `limit=1` 取 `meta.results.total`（nDrug、a）；藥名 token：
  `(patient.drug.openfda.generic_name:"X" OR patient.drug.openfda.brand_name:"X" OR patient.drug.medicinalproduct:"X")`
- 節流：無 key 1800ms、有 key 300ms／call（openFDA 40 vs 240 req/min）。
- 測試：`node --test tests/*.test.js`，零依賴，以 vm 載入兩端；已有 golden 鎖 `_stats`/`_temporal`，
  `generateInterpretation` 兩端輸出比對。無 lint、無 CI 測試 workflow（僅 GitHub Pages 部署）。
- 前端規範：禁止 innerHTML 注入、禁 alert、觸控 ≥44px、沿用 CSS 變數、不用因果語言。

## 4. 實測（2026-11-17，openFDA，reaction = Stevens-Johnson syndrome，limit=100，sort=receivedate:desc）

| 藥品 | total | 抽樣 | 對應成功 | S | I | C | 同報重複 | 角色衝突 | 期間 |
|---|---|---|---|---|---|---|---|---|---|
| CARBAMAZEPINE | 956 | 100 | 100 | 87 | 2 | 11 | 11 | 0 | 2024-03～2026-09 |
| VANCOMYCIN | 652 | 100 | 100 | 68(+2 衝突 1/2) | 0 | 30 | 8 | 2 | 2023-11～2026-09 |

- 回應大小：未壓縮約 15 MB／100 筆；gzip 約 5.6 MB；單筆通報最多 329 個 drug 條目。openFDA 無欄位投影。
- 對應來源：Carbamazepine 有 20 筆通報僅靠 openfda 欄位對上（medicinalproduct 不含字串）；
  Vancomycin medicinalproduct 出現 `VANCOMYCIN`、`VANCOMYCIN HYDROCHLORIDE`、`Vancomycin (1,000 and 1,250 mg)`。

## 5. 架構決策與理由

- D1 按需載入（每列按鈕）。理由：單次查詢 ~5.6 MB gzip，10 藥 ~56 MB；自動載入會吃流量與 rate limit。
  不選「全部載入」：使用者已決定（N6）。
- D2 抽樣查詢＝現有 `_drugTok(name) AND reactionmeddrapt:"reaction"`，加 `limit=100&sort=receivedate:desc`。
  理由：與 ROR 的 `a` 計數同一母體，避免第二套查詢語意。不選 `skip` 隨機：openFDA 無隨機排序，偽隨機會誤導。
  UI 一律標「最近通報抽樣」。
- D3 條目層級比對（target matching）：對每個 `patient.drug[]` 條目，將查詢字串與
  `openfda.generic_name[]`、`openfda.brand_name[]`、`medicinalproduct` 做 **token-phrase** 比對
  （大寫、非英數轉空白、以空白分界的連續 token 子序列相等）。理由：模擬 openFDA 對 quoted phrase 的語意，
  使「被搜尋到的通報」中能找回同一條目。不選 substring：`IRON` 會誤配 `IRONWOOD`類。不選完全相等：
  會漏掉鹽類（VANCOMYCIN HYDROCHLORIDE）。
- D4 複方排除：配到的條目若為複方 → 該條目不算目標單方，計入 `combo`。判定：
  有 `openfda.generic_name` 者，任一 generic_name 含分隔符（` AND `、`,`、`/`、`+`、` WITH `）即複方；
  無 openfda 者，以 `medicinalproduct` 去除括號內容後判斷同一組分隔符。
  理由：使用者決定「不同有效成分不可合併」。不選「另列複方比例」：UI 複雜度。
- D5 通報層級角色：同報內目標單方條目多筆 → 取優先順序 **1 > 3 > 2**（Suspect > Interacting > Concomitant）
  的最高者；有效角色只認字串/數字 `"1"|"2"|"3"`。若所有目標條目角色皆缺漏／無效 → `invalidRole`。
  若同報同時有單方目標條目與複方條目 → 只用單方條目決定角色（不計 combo）。
  理由：避免重複計數；「曾被列為 Suspect」較能反映通報者判定。此規則寫入 methodology 並有測試。
- D6 每份通報歸入且僅歸入一類：`suspect | interacting | concomitant | invalidRole | combo | unmatched`。
  `sampled = 六類總和 = results.length`；`valid = suspect+interacting+concomitant`；`valid=0 → pct=null`。
- D7 兩端各一份純函式 `computeSuspectProportion(reports, drugName)`（Code.gs、docs/app.js），
  以測試比對兩端輸出逐欄相同（沿用 generateInterpretation 的同步模式）。
  不選共用檔：無 bundler、GAS 無 import。
- D8 GAS：新增 `suspectProportion(drug, reaction)`（前端 `google.script.run` 呼叫），回傳與 Pages 版相同結構；
  CacheService 只存計數 JSON（< 1 KB，遠低於 100 KB 限制），key 前綴 `sp1_`，TTL 1h。
- D9 Pages：記憶體 Map 快取（key = 正規化 drug + reaction），in-flight Promise 合併；同時最多 1 個比例請求（佇列）。
- D10 不改 `analyzeADR` 回傳契約；比例為獨立呼叫，結果掛在前端每列 state，不寫回 `data.results`。

## 6. 平台限制

- openFDA：無 key 40 req/min、1000 req/day；有 key 240 req/min、120000 req/day。`limit` 上限 1000。
  404＋`NOT_FOUND` = 無結果；429 = 限速；5xx 偶發。
- GAS：單次執行 6 分鐘；UrlFetchApp 回應 50 MB 上限；CacheService 單值 100 KB；JSON.parse 15 MB 在 GAS 可行但慢（需實測）。
- GitHub Pages：純靜態，無伺服器端快取。
- 醫院網路：大回應可能慢或被代理截斷 → timeout 必須明確回報。

## 7. 資料流與失敗行為

1. 使用者完成主分析（ROR/PRR 表格已呈現，不受影響）。
2. 點某列「載入」→ 該列狀態 `loading`（按鈕 disabled、顯示進度文字）。
3. Pages：`fetch(url, {signal})`，timeout 60s（AbortController）；GAS：`UrlFetchApp.fetch(muteHttpExceptions)`。
4. 回應處理：
   - HTTP 404 且 `error.code==='NOT_FOUND'` → `sampled=0`，狀態 `empty`（「資料不足（無通報）」）
   - 429 → 退避 2s 重試 1 次，仍 429 → 狀態 `error`，訊息「openFDA 限速，請稍後重試或設定 API Key」
   - 5xx／網路錯誤 → 退避重試 1 次，仍失敗 → `error`（訊息含 HTTP 狀態）
   - timeout → `error`「逾時（60s）」；不可回傳 0 或空結果偽裝成功
   - 200 但 JSON 結構異常（無 `results` 陣列）→ `error`「回應格式異常」
   - 錯誤狀態提供「重試」按鈕；錯誤結果不寫入快取
5. 成功 → `computeSuspectProportion` → 寫快取 → 狀態 `done`：
   - `valid ≥ 10`：`89% (n=100)`
   - `1 ≤ valid < 10`：`67% (n=3)` ＋ 小字「樣本少」（門檻 `CONFIG.SP_MIN_VALID = 10`）
   - `valid = 0`：「資料不足」（仍可展開細項，例如全為複方或無法對應）
6. 展開細項（點擊，非僅 hover，以支援手機）：抽樣數、有效分母、Suspect、Interacting、Concomitant、
   角色缺漏／無效、複方（排除）、無法對應、抽樣期間（最舊～最新 receivedate）、「最近通報抽樣」標示、
   固定說明文字：「疑似藥比例表示抽樣 FAERS 通報中，目標藥物被標記為 Suspect 或 Interacting 的比例，並非 ADR 發生率或因果機率。」
   及限制：通報者判定非因果；最多 100 筆非全量；notoriety bias／通報習慣／適應症影響；不可跨藥比較致病機率；不納入綜合分數；
   藥物角色為通報層級，同報多 ADR 時不針對單一 ADR。
7. 重新執行主分析 → 表格重繪；快取命中的列直接顯示結果（不重打 API），未載入的列回到按鈕狀態。

## 8. 驗收條件（可證偽）

### A. 計算正確性（`computeSuspectProportion`，兩端）

- A1：fixture 為 3 份通報、目標皆為 1 → `{suspect:3, valid:3, pct:100}`。
- A2：目標皆為 2 → `pct:0`（不是 null、不是「資料不足」）。
- A3：S/I 混合（1,3,3,2）→ suspect 1、interacting 2、concomitant 1、pct 75。
- A4（反例：他藥為 Suspect）：同報中**其他藥**為 1、目標為 2 → 計為 concomitant。
  斷言：若實作改為「通報內任一藥為 1 即算 suspect」，此測試必須失敗。
- A5（重複）：同報目標出現 3 次（2,2,2）→ concomitant 恰為 1、sampled 為 1。
- A6（衝突優先順序）：同報目標 (2,1) → suspect；(2,3) → interacting；(3,1) → suspect；順序顛倒輸入結果相同。
- A7（缺漏）：目標條目無 `drugcharacterization` 或值為 `"4"`、`""`、`null` → invalidRole，且不進 valid。
  同報目標 (缺漏, 2) → concomitant（有效角色優先於缺漏）。
- A8（別名／拼寫）：查詢 `VANCOMYCIN` 須配到 medicinalproduct `Vancomycin Hydrochloride`、`VANCOMYCIN (1,000 and 1,250 mg)`、
  以及 medicinalproduct 為商品名但 `openfda.generic_name=["VANCOMYCIN HYDROCHLORIDE"]` 的條目。
  查詢商品名 `TEGRETOL` 須配到 `openfda.brand_name=["TEGRETOL"]` 條目。
- A9（反例：不可誤合併）：查詢 `IRON` 不可配到 `IRONWOOD`類 token 前綴；查詢 `AMOXICILLIN` 遇
  `openfda.generic_name=["AMOXICILLIN AND CLAVULANATE POTASSIUM"]` → combo（不進 valid）；
  查詢 `ESTRADIOL` 不可配到 `NORETHINDRONE` 單方條目（不同 token）。
  **至少 5 筆「規則會誤判」的已知邊界案例**列於測試並註記人工裁決（例如 medicinalproduct 無 openfda 且為自由文字、
  商品名同時是複方、括號內含 AND 的劑量描述、`+` 分隔、斜線劑量 `500MG/5ML`），若規則判錯則斷言目前行為並在 methodology 標為已知限制。
- A10（無法對應）：通報中無任何條目配得到目標 → unmatched，不進 valid。
- A11（不變式）：任意 fixture 下 `suspect+interacting+concomitant+invalidRole+combo+unmatched === sampled === reports.length`；
  `valid=0 ⇔ pct===null`；pct 四捨五入至整數且 0≤pct≤100。以 ≥20 份隨機產生的 fixture（固定 seed）驗證。
- A12（n 非固定 100）：47 份通報、其中 5 份 unmatched → `sampled:47, valid:42`，顯示字串含 `n=42`。
- A13（兩端一致）：同一組 fixture（含 A1–A12 全部）餵 Code.gs 與 docs/app.js，輸出 JSON 逐欄相同。

### B. API 與狀態

- B1：fetch stub 回 404 NOT_FOUND → `sampled:0`、狀態 empty，不丟例外。
- B2：stub 回 429 兩次 → 恰好呼叫 2 次後回 error，訊息含「限速」；stub 第一次 429、第二次 200 → 成功。
- B3：stub 永不 resolve → 60s（測試中以可注入的 timeout 縮短）後回 error「逾時」，**不得**回傳 sampled:0。
- B4：stub 回 200 但無 `results` → error「回應格式異常」。
- B5：同一 drug+reaction 連續呼叫 3 次（含併發）→ fetch 恰被呼叫 1 次；失敗結果不入快取（失敗後再呼叫會重打）。
- B6：查詢 URL 含現有 `_drugTok(name)` 與 reaction token、`limit=100`、`sort=receivedate:desc`；有 key 時帶 `api_key`。
- B7：GAS `suspectProportion` 對 HTTP 非 200（非 NOT_FOUND）不可靜默 return，須回 `{success:false,error}`。

### C. 不影響既有行為

- C1：既有 `tests/*.test.js` 全綠，`_stats`/`_temporal` golden 不改一個值。
- C2：`analyzeADR` 對同一 stub 序列的回傳（results、rank、composite、interpretation.text）與改動前 commit 的輸出逐字相同；
  且 `analyzeADR` 期間 fetch 呼叫次數不變（不得偷偷觸發比例查詢）。
- C3：`generateInterpretation` 輸出不含「疑似藥比例」字樣。
- C4：兩份 HTML 的 `<drug-suggest>` 區塊仍逐字相同（既有測試）。

### D. UI

- D1：表格新增「疑似藥比例」欄；未載入時為按鈕「載入」，按下前不發任何請求。
- D2：顯示 loading／done／empty／error 四態；error 有重試鈕。
- D3：展開細項含 §7.6 全部欄位與固定說明文字；全部以 textContent/createElement 建構。
- D4：手機寬度（375px）表格可橫向捲動閱讀，按鈕觸控 ≥44px；不使用 alert。
- D5：重新渲染（例如切換其他 UI）不重打 API；快取命中直接顯示。
- D6：兩版 HTML（Index.html、docs/index.html）皆有此欄；GAS 版走 `google.script.run.suspectProportion`。

### E. 整合（live，手動，`LIVE=1`）

- E1：CARBAMAZEPINE、VANCOMYCIN × `Stevens-Johnson syndrome`（另跑 `Toxic epidermal necrolysis`）：
  斷言 `sampled ≤ 100`、A11 不變式成立、`valid ≥ 1`、unmatched 比例 < 20%；**不斷言**特定百分比。
  記錄實測值於 `.ai-review/` 驗收紀錄。

### F. 文件

- F1：README（英／繁中）、`docs/methodology.md`、`DISCLAIMER.md` 說明定義、公式、角色優先順序、複方排除、最近通報抽樣、
  PS/SS 不可得、§7.6 限制、openFDA 請求量與流量（~5.6 MB gzip／次）。
- F2：版本號 2.4.0（Code.gs、docs/app.js CONFIG.VERSION 與檔頭）。

## 9. 後續版本（不在本次）

- （待審查後補）
