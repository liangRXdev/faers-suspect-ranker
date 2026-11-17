# 任務：規格層獨立審查 第 2 輪（動工前，唯讀）

你是獨立覆審員，只審**規格**（下方 plan v0.2 全文），不審程式碼、不寫程式碼。
**唯讀模式：禁止寫入或修改任何檔案，只輸出報告文字。** 不要給程式碼實作建議。
可讀 repo 既有檔案核對現況；可讀 `.ai-review/plan-review.md`（第 1 輪你的輸出）與 `.ai-review/plan-verdict.md`（主持人判定）。

v0.1 經第 1 輪審查後大幅修訂（辨識決策表、摘要契約、controller、錯誤決策表、G0 門檻）。
**本輪聚焦：v0.2 新內容本身是否正確、自洽、可測**；不要重提已在 plan-verdict 判定或使用者已定案的事項，
除非你能指出 v0.2 的修法本身有錯。注意主持人實證：openFDA `openfda.generic_name` 是條目對到之所有仿單的聯集（非成分清單）。

## 專案前提

### (a) 架構限制與刻意取捨
- 教學用 FAERS ADR 嫌疑藥排序工具；兩套引擎刻意並存：GAS（Code.gs + Index.html，API key 在 PropertiesService）與 GitHub Pages 純前端（docs/app.js + docs/index.html，key 在 localStorage）。無 bundler、GAS 無 import → 邏輯各放一份，以測試比對兩端輸出。這不是缺陷。
- 只依賴 `api.fda.gov/drug/event.json`；不新增後端、資料庫、npm 相依（含 jsdom/Playwright）、框架。測試零依賴（node --test + vm）。
- 使用者已決策：按需逐列載入；複方不進分母；兩版都做；valid<10 顯示比例＋樣本少、valid=0 資料不足；PS/SS 不可得只寫文件。
- 前端規範：禁 innerHTML 注入、禁 alert、觸控 ≥44px、不得用因果語言。

### (b) 威脅模型與風險權重
- 無病患資料；唯一機密為使用者自備 openFDA API key。
- 最怕：把目標藥誤判為 Suspect、不同成分誤合併、失敗偽裝成 0% 或空結果；被解讀為因果；悄悄改到既有 ROR/PRR/排序。
- 寧可顯示「資料不足／無法確認」，不可推估。

## 要求產出四個區塊

每項：**嚴重度 / 問題 / 為什麼現在不修之後會更貴 / 建議修法**
嚴重度（發現越晚越貴）：Blocker 方向錯整段重來／High 改架構或資料模型／Medium 多寫改程式不動架構／Low 文件命名。

1. 需求與邊界缺漏（特別檢查 D3 決策表的每一列：是否有輸入會落到兩列或沒有列、moiety/exact 定義在不去鹽模式下是否自洽、A8/A9 每個案例依決策表推導的結果是否與規格寫的預期一致——逐案推導給出結論）
2. 架構風險
3. 驗證策略缺口（針對 §8 每條：什麼弱化實作能通過但功能壞掉？）
4. 更簡單的替代方案

規則：不要新增目標/非目標以外的需求；必要時標 `[新增需求]` 並說明具體可觀察後果。與架構限制衝突須明說並改提相容作法。

---

# 規格全文（.ai-review/plan.md v0.2）

# 規格：疑似藥比例（Suspect Drug Proportion）輔助指標

- 版本：v0.2（2026-11-17）— v0.1 經 Codex 審查修訂，見文末修訂紀錄
- Repo：faers-suspect-ranker（base: main bdf4360，分支 feat/suspect-proportion）
- 目標版本號：2.3.0 → 2.4.0

## 1. 目標

在排序結果表格新增「疑似藥比例」欄，針對每列「藥品＋ADR」，從 openFDA FAERS 依 FDA 首次收件日（`receivedate`）最近的通報抽樣（最多 100 筆），
計算目標藥品在該通報 `patient.drug[]` 中被標記為 Suspect(1) 或 Interacting(3) 的比例：

```
pct = round((suspect + interacting) / (suspect + interacting + concomitant) × 100)
```

分母僅計入「可確認為目標單方藥品」且「角色為有效 1/2/3」的通報（每份通報至多計 1 次）。
**無法確認就排除並顯示理由，不推估。** 不以降低 unmatched 為目標。
定位：ADR 訊號探索與臨床判讀的輔助資訊，**非 ADR 發生率、非因果機率**。

## 2. 非目標（本次不做）

- N1：不改 ROR、PRR、χ²、時序加權、綜合分數、排序演算法、`analyzeADR` 回傳、`generateInterpretation` 輸出（含文字）。
- N2：比例不納入綜合分數、不影響排序、不寫入規則式解讀文字。
- N3：不區分 PS／SS（openFDA `drugcharacterization` 只有 1/2/3，無 FAERS ASCII 的 `role_cod`）；僅在文件說明。
- N4：不做隨機抽樣、不做全量統計、不做 FAERS 重複通報（case 版本／跨廠商重複）去重。
- N5：不新增後端服務、資料庫、bundler、框架、npm 相依（含 jsdom/Playwright）；不新增資料源（仍只用 `api.fda.gov/drug/event.json`）。
- N6：不自動載入所有列；不做「全部載入」按鈕。
- N7：不用 RxNorm／成分展開把商品名對應到其他品名；不建完整鹽類／劑型字典（僅 §5 D3 列出的有限清單）。
- N8：不持久化結果（Pages 記憶體快取；GAS CacheService 只存計算摘要，TTL 1h），不存原始通報。
- N9：不做跨使用者的全域請求排程。

## 3. 現有架構（事實）

- 兩套引擎、兩套前端，邏輯須同步：
  - GAS：`Code.gs`（`UrlFetchApp`、`CacheService`、API key 在 `PropertiesService`）＋ `Index.html`（`google.script.run`）
  - Pages：`docs/app.js`（瀏覽器直接 fetch openFDA，key 在 localStorage）＋ `docs/index.html`
- 現有查詢：每藥 2 次 `limit=1` 取 `meta.results.total`（冷快取時；命中不送 HTTP）；藥名 token `_drugTok(name)`：
  `(patient.drug.openfda.generic_name:"X" OR patient.drug.openfda.brand_name:"X" OR patient.drug.medicinalproduct:"X")`，
  X = `_clean(name)`（移除 `"`、`\`、trim）。
- 節流：無 key 1800ms、有 key 300ms／call（本工具保守設定；官方現值見 §6）。
- 測試：`node --test tests/*.test.js`，零依賴，vm 載入兩端；golden 鎖 `_stats`/`_temporal`；`generateInterpretation` 兩端輸出比對；
  HTML 內 `<drug-suggest:begin/end>` 區塊以 vm 抽出測試且兩份逐字相同。
- 無 lint、repo 內無 `.github/workflows`（GitHub Pages 由 repo 設定直接部署）。
- 前端規範：禁止 innerHTML 注入、禁 alert、觸控 ≥44px、沿用 CSS 變數、不用因果語言。

## 4. 實測（2026-11-17，openFDA，reaction = Stevens-Johnson syndrome，limit=100，sort=receivedate:desc）

| 藥品 | total | 抽樣 | v0.2 規則：S | I | C | combo | ambiguous | unmatched | pct | 期間 |
|---|---|---|---|---|---|---|---|---|---|---|
| CARBAMAZEPINE | 956 | 100 | 87 | 2 | 11 | 0 | 0 | 0 | 89% | 2024-03～2026-09 |
| VANCOMYCIN | 652 | 100 | 70 | 0 | 30 | 0 | 0 | 0 | 70% | 2023-11～2026-09 |

- 回應大小（觀察值，非上限）：未壓縮約 15 MB／100 筆；gzip 約 5.6 MB；單筆通報最多 329 個 drug 條目。openFDA 無欄位投影。
- **`openfda.generic_name` 是該條目對到之所有仿單的聯集，不是成分清單**：VANCOMYCIN 條目 90 次為
  `["VANCOMYCIN HYDROCHLORIDE","VANCOMYCIN"]`。以「陣列多元素＝複方」判定會把 82/100 誤判為 combo。
- 同報重複：CARBAMAZEPINE 11、VANCOMYCIN 8；同報角色衝突（1/2）：VANCOMYCIN 2。

## 5. 架構決策與理由

- D1 按需載入（每列按鈕）。理由：單次 ~5.6 MB gzip；使用者決定（N6）。
- D2 抽樣查詢＝`_drugTok(name)+AND+reactionmeddrapt:"reaction"`（與 ROR 的 `a` 同一表達式）＋`limit=100&sort=receivedate:desc`，
  無其他 search 條件。理由：同一母體。不用 `skip` 偽隨機。UI 標「最近通報抽樣（依 FDA 首次收件日）」。
  **搜尋只決定抽樣，不代表條目已確認**；本地辨識是獨立且較保守的規則，不宣稱等價於 openFDA analyzer。
- D3 條目辨識決策表。記號：`T = tokens(_clean(name))`；`tokens(s)` = 大寫、非英數轉空白、切分；
  `SALTS` = 有限鹽類/水合清單（HYDROCHLORIDE, HCL, SODIUM, POTASSIUM, CALCIUM, MAGNESIUM, SULFATE, PHOSPHATE, ACETATE,
  MALEATE, MESYLATE, TARTRATE, CITRATE, SUCCINATE, FUMARATE, BESYLATE, BROMIDE, CHLORIDE, HYDROBROMIDE, DIHYDRATE, MONOHYDRATE, ANHYDROUS）；
  `FORMS` = 有限劑型/單位清單（TABLET(S), TAB(S), CAPSULE(S), CAP, INJECTION, INJ, ORAL, SOLUTION, SUSPENSION, IV, INTRAVENOUS,
  XR, ER, CR, SR, EXTENDED, RELEASE, POWDER, FOR, USP, MG, G, MCG, ML, IU, UNIT(S)）；
  `moiety(s)` = `tokens(s)` 移除 SALTS 後的 token 串；`M = moiety(_clean(name))`（若 M 為空——藥名全由 SALTS 組成，如 `POTASSIUM CHLORIDE`、`MAGNESIUM SULFATE`——則本列改用「不去鹽」模式：moiety 一律取完整 tokens，比對要求完整 tokens 相等）；
  `exact(v, allowForms)` = `moiety(v)`（allowForms 時再移除 FORMS 與「數字開頭 token」）與 M 完全相等；
  `combo(s)` = 含 ` AND `、` WITH `、`+`、`,`、或「字母/字母」斜線（數字/數字斜線如 `500MG/5ML` 不算）；
  `hit` = 任一欄位 tokens 以連續子序列含 T（候選，不代表確認）。
  只接受字串型欄位值；非字串、空字串、空陣列視為欄位缺漏。

  | # | 條件（依序判定，第一個成立者決定） | 條目分類 |
  |---|---|---|
  | 1 | 三欄皆無 hit | none |
  | 2 | 有 generic_name，且任一元素 `combo` | combo |
  | 3 | 有 generic_name，去 SALTS 後主成分集合大小 >1 | combo |
  | 4 | 有 generic_name，且每個元素皆 `exact(·, false)` | target |
  | 5 | 有 generic_name，且某 brand_name `exact(·, false)`（商品名查詢），且 #2/#3 不成立 | target |
  | 6 | 有 generic_name，其餘 | ambiguous（例：INSULIN→INSULIN GLARGINE） |
  | 7 | 無 generic_name：medicinalproduct 的括號段若含 FORMS/數字/AND/OR 以外的字母 token | ambiguous（例：`AMOXICILLIN (WITH CLAVULANATE)`） |
  | 8 | 無 generic_name：移除純劑量括號段後 `combo` | combo |
  | 9 | 無 generic_name：移除後 `exact(·, true)`，或某 brand_name `exact(·, false)` | target |
  | 10 | 其餘 | ambiguous |

  generic 與 MP 矛盾時以 generic_name 為準（openFDA 已協調欄位），MP 僅在無 generic 時使用。
- D4 通報層級分類（每份通報恰一類）：
  1. 有 target 條目 → 取 target 條目中有效角色（`"1"|"2"|"3"` 或數字 1/2/3；布林、物件、陣列、其他值皆無效）的最高優先者
     **1 > 3 > 2** → `suspect | interacting | concomitant`；所有 target 條目角色皆無效 → `invalidRole`。
     同報另有 combo/ambiguous 條目時不影響（已確認單方優先）。
  2. 無 target、有 combo 條目 → `combo`
  3. 無 target/combo、有 ambiguous → `ambiguous`
  4. 其餘（含 `patient`/`drug` 缺漏、非陣列、空陣列、元素為 null）→ `unmatched`
  理由：避免重複計數；不因他藥角色誤判；無法確認者不進分母。
- D5 共同摘要契約（兩端相同，亦為快取值）：
  `{ drug, reaction, sampled, valid, suspect, interacting, concomitant, invalidRole, combo, ambiguous, unmatched, pct, lowSample,
     periodFrom, periodTo, sampleMode:'recent-receivedate', fetchedAt }`
  - `sampled = 七類總和 = results.length`；`valid = S+I+C`；`valid=0 ⇔ pct=null`；`lowSample = 1≤valid<CONFIG.SP_MIN_VALID(10)`
  - `periodFrom/To` = sampled 全體中合法 8 碼 `receivedate` 的最舊/最新（`YYYY-MM-DD`）；皆缺 → `null`
  - empty（NOT_FOUND）：`sampled=0`、各類 0、`pct=null`、期間 null
- D6 兩端各一份純函式 `computeSuspectProportion(reports, drugName)`（Code.gs、docs/app.js），回傳 D5 去除 drug/reaction/fetchedAt 外的欄位；
  以測試要求**每端先各自符合人工裁決的預期**，再比對兩端逐欄相同。
- D7 Pages 傳輸：`FAERSApp.suspectProportion(drug, reaction)` → Promise<{success, data|error}>，內含 fetch、重試、解析與 D5 組裝；
  記憶體 Map 快取（key = `_clean(drug)+'|'+_clean(reaction)`，不做大小寫或其他正規化）＋ in-flight Promise 合併；失敗不入快取。
- D8 GAS 傳輸：`suspectProportion(drug, reaction)` 回傳同結構；CacheService 存 D5 摘要 JSON（<1 KB），key `sp1_`+md5(同上 key)，TTL 3600s。
- D9 前端 controller（`<sp-loader:begin/end>` 區塊，兩份 HTML 逐字相同，以 vm 測試，仿 drug-suggest 模式）：
  - 注入 transport（Pages：`FAERSApp.suspectProportion`；GAS：`google.script.run` Promise 包裝）
  - 單一佇列，同時 1 個請求；相鄰請求（含重試由 transport 內部處理）啟動間隔 ≥ sleepMs（無 key 1800／有 key 300）
  - 狀態以查詢身分 key 保存：`idle | queued | loading | done | empty | error`；列渲染時依自身 key 取狀態
  - 每次請求帶遞增 token；回寫時若該 key 已有較新 token 或已為終態成功，舊結果丟棄
  - GAS watchdog：150s 未回 → `error`「逾時」，之後晚到結果丟棄（不翻轉終態）
- D10 不改 `analyzeADR` 契約；比例狀態只存在 controller，不寫回 `data.results`。

## 6. 平台限制

- openFDA：官方現值無 key 240 req/min、1,000 req/day（每 IP）；有 key 240 req/min、120,000 req/day。
  本工具沿用既有保守節流（1800/300ms）。`limit` 上限 1000。404＋`NOT_FOUND` = 無結果；429 = 限速；5xx 偶發。
- GAS：單次執行 6 分鐘；UrlFetchApp 回應 50 MB 上限；CacheService 單值 100 KB；`google.script.run` 回傳值需可序列化。
  **大回應 fetch＋JSON.parse＋遍歷在 GAS 的耗時未證實** → G0 門檻。
- 回應大小無上限保證（`limit` 限通報數不限位元組）→ 設 `CONFIG.SP_MAX_BYTES = 40 MB`，超過即 error「回應過大」，不截斷計算。
- GitHub Pages：純靜態。醫院網路：大回應可能慢 → 逾時明確回報。

## 7. 資料流與失敗行為

1. 主分析完成（ROR/PRR 表格已呈現，不受影響）。每列「疑似藥比例」欄初始為「載入」按鈕。
2. 點擊 → controller 以 key 排隊（`queued`，顯示「排隊中」）→ 出佇列 `loading`（按鈕 disabled、顯示「載入中」）。
3. 時間契約：
   - Pages：每次嘗試從送出 HTTP 到 body 讀完並解析完成，上限 60s（同一 AbortController 涵蓋 fetch 與 `resp.text()`）；排隊時間不計；
     最多 2 次嘗試，間隔 2s；最壞約 122s 進終態。
   - GAS：伺服器端不另設 timeout（依平台）；前端 watchdog 150s。
4. 錯誤決策表（兩端一致；Pages 由 fetch 層、GAS 由 UrlFetchApp 層實作）：

   | 情況 | 重試 | 終態 | 快取 |
   |---|---|---|---|
   | 200 且 body 為 JSON、`results` 為陣列、無 `error` | — | done/empty | 是 |
   | 404 且 body 可解析、`error.code==='NOT_FOUND'` | 否 | empty | 是 |
   | 其他 404、400、401、403 | 否 | error「openFDA 回應 HTTP {status}」 | 否 |
   | 429 | 是（2s 後 1 次） | 仍 429 → error「openFDA 限速，請稍後重試或設定 API Key」 | 否 |
   | 5xx | 是（2s 後 1 次） | error「openFDA 伺服器錯誤 HTTP {status}」 | 否 |
   | 網路錯誤（無 status） | 是（2s 後 1 次） | error「網路錯誤，無法連線 openFDA」（不捏造狀態碼） | 否 |
   | 逾時 | 是（1 次） | error「逾時（60s）」 | 否 |
   | body 非 JSON／截斷／200 帶 `error`／`results` 非陣列 | 否 | error「回應格式異常」 | 否 |
   | body > SP_MAX_BYTES | 否 | error「回應過大」 | 否 |

   - `results` 元素結構異常（null、無 patient、drug 非陣列）→ 該通報計入 sampled，分類 unmatched（不靜默刪除）。
   - 所有錯誤訊息、console、回傳物件不得含 API key 或完整請求 URL。
   - error 狀態顯示「重試」按鈕；重試重新排隊。
5. 成功 → D5 摘要 → 快取 → 顯示：
   - `valid ≥ 10`：`89% (n=100)`（n = valid）
   - `1 ≤ valid < 10`：`67% (n=3)` ＋ 小字「樣本少」
   - `valid = 0`：「資料不足」（含 empty；仍可展開細項）
6. 展開細項（點擊切換，非僅 hover）：抽樣數、有效分母、Suspect、Interacting、Concomitant、角色缺漏／無效、複方（排除）、
   無法確認成分（排除）、無法對應、抽樣期間、「最近通報抽樣（依 FDA 首次收件日，非隨機）」；固定說明文字：
   「疑似藥比例表示抽樣 FAERS 通報中，目標藥物被標記為 Suspect 或 Interacting 的比例，並非 ADR 發生率或因果機率。」
   及限制：通報者判定非因果；最多 100 筆非全量；notoriety bias／通報習慣／適應症影響；不可據兩藥比例差判定相對致病機率；
   不納入綜合分數；藥物角色為通報層級，同報多 ADR 時不針對單一 ADR；PS/SS 不可區分。
7. 重新執行主分析／重繪 → 列依自身 key 從 controller 取狀態：快取命中直接顯示；loading 中顯示載入中且不新增請求；
   換 ADR 後舊 key 的晚到結果只更新舊 key 狀態，不影響新表格。

## 8. 驗收條件（可證偽）

測試皆零依賴（node:test + vm）。標「兩端」者對 Code.gs 與 docs/app.js 各自斷言人工裁決預期，再斷言兩端輸出逐欄相同。

### G. 動工前可行性門檻

- G0：在實際 GAS（使用者部署之測試版本）以 CARBAMAZEPINE×SJS 與一組最大回應（樣本中 drug 數最多者）執行 `suspectProportion`，
  記錄回應位元組、耗時、終態於 `.ai-review/g0-feasibility.md`；並於瀏覽器（Pages）記錄同查詢耗時。
  GAS 若無法在 150s 內完成或觸發配額錯誤 → 停下交使用者決策（不得自行降低 limit 或截斷）。G0 未過不接 GAS UI。

### A. 計算正確性（`computeSuspectProportion`，兩端）

- A1：3 份通報目標角色皆為 1，分別以字串 `"1"`、數字 `1`、混合三組 fixture → 各為 suspect=valid=sampled=3、其餘 0、pct=100。
- A2：k=4 份目標皆 2 → concomitant=valid=sampled=4、其餘 0、pct=0（非 null）；格式化顯示「0% (n=4)」。
- A3：角色 1,3,3,2（各一報）→ S1/I2/C1、pct 75；再加入一報目標 (2,2,1) 重複 → S2/I2/C1、valid 5、pct 80。
- A4（反例：他藥角色）：同報他藥為 1、目標為 2；他藥為 3、目標為 2；他藥分別排在目標前與後 → 四種皆 concomitant。
- A5（跨欄去重）：同報目標三條目分別經 generic／brand／medicinalproduct 命中、角色皆 2 → concomitant 恰 1、sampled 1。
- A6（衝突）：同報目標 (2,1)→suspect、(2,3)→interacting、(3,1)→suspect、(2,3,1)→suspect、(無效,2)→concomitant、(無效,無效)→invalidRole；
  每組所有排列結果相同。
- A7（無效角色）：缺欄、`null`、`""`、`"4"`、`0`、`true`、`[1]`、`{}`、`"1 "`（含空白）→ 皆無效，單獨出現時 invalidRole，不進 valid。
- A8（別名）：查 `VANCOMYCIN`：
  (a) `generic_name=["VANCOMYCIN HYDROCHLORIDE","VANCOMYCIN"]` → target；
  (b) 無 openfda、MP `Vancomycin Hydrochloride` → target；
  (c) 無 openfda、MP `Vancomycin (1,000 and 1,250 mg)` → target（括號劑量不判 combo）；
  (d) MP 為商品名、`generic_name=["VANCOMYCIN HYDROCHLORIDE"]` → target；
  (e) 命中值位於 brand_name 陣列第 2 個元素 → 正確處理；
  (f) 查 `VANCOMYCIN HYDROCHLORIDE`（使用者輸入含鹽）對 (a) 條目 → target。
  查 `TEGRETOL`：`brand_name=["EPITOL","TEGRETOL"]`、`generic_name=["CARBAMAZEPINE"]` → target。
- A9（具名反例：不得誤納入 valid）——每案註記人工裁決；預期為 combo/ambiguous/none 者對 valid 貢獻必須為 0：
  1. 查 `INSULIN`，`generic_name=["INSULIN GLARGINE"]` → ambiguous
  2. 查 `AMOXICILLIN`，`generic_name=["AMOXICILLIN AND CLAVULANATE POTASSIUM"]` → combo
  3. 查 `AMOXICILLIN`，`generic_name=["AMOXICILLIN","CLAVULANATE POTASSIUM"]` → combo（主成分集合 2）
  4. 查 `AMOXICILLIN`，無 openfda、MP `AMOXICILLIN (WITH CLAVULANATE POTASSIUM)` → ambiguous
  5. 查 `HYDROCODONE`，無 openfda、MP `HYDROCODONE/APAP` → combo
  6. 查 `SULFAMETHOXAZOLE`，MP `SULFAMETHOXAZOLE + TRIMETHOPRIM` → combo
  7. 查 `IRON`，MP `IRONWOOD EXTRACT` → none（token 不同）
  8. 查 `ESTRADIOL`，`generic_name=["ESTRADIOL VALERATE"]`（VALERATE 不在 SALTS）→ ambiguous（保守漏配，列為已知限制）
  9. 查 `METFORMIN`，`brand_name=["JANUMET"]`、`generic_name=["SITAGLIPTIN AND METFORMIN HYDROCHLORIDE"]` → combo
  10. 查 `LITHIUM`，MP `LITHIUM CARBONATE 300MG` → ambiguous（CARBONATE 不在 SALTS；保守漏配）
  11. 查 `AMOXICILLIN`，MP `AMOXICILLIN 500MG/5ML ORAL SUSPENSION` → target（數字斜線不判 combo）
  12. 查 `POTASSIUM CHLORIDE`（全鹽名，不去鹽模式），`generic_name=["POTASSIUM CHLORIDE"]` → target；`generic_name=["POTASSIUM CITRATE"]` → none 或 ambiguous，不得 target；
      查 `MAGNESIUM SULFATE`，`generic_name=["MAGNESIUM SULFATE","SODIUM CHLORIDE"]`→ combo 或 ambiguous，不得 target
  已知「保守漏配」（#8、#10 類）可列為限制；已知「誤納入」不得以文件豁免。
- A10（無法對應）：通報 `patient` 缺、`drug` 非陣列、`drug=[]`、元素 null、只有他藥 → 各為 unmatched、sampled 計入、不拋例外。
- A11（性質）：固定 seed 產生 ≥20 組 fixture，每組斷言：七類總和＝sampled＝reports.length；`valid=0⇔pct===null`；0≤pct≤100 整數；
  在任一通報加入一個非目標他藥（任意角色）結果不變；複製一個已存在的目標條目（同角色）結果不變。
- A12：47 報 = S20/I5/C17/invalidRole 2/combo 1/ambiguous 1/unmatched 1 → sampled 47、valid 42、pct 60；
  格式化純函式輸出含 `n=42`，且 n 取自 S+I+C（以 valid 欄位竄改測試確認不是讀 sampled）。
- A13：A1–A12 全部 fixture 兩端輸出逐欄相同（含 periodFrom/To、lowSample）。
- A14（期間）：receivedate 含 `"20240311"`、`"20260928"`、缺漏、`"2024"`（不合法）→ periodFrom `2024-03-11`、periodTo `2026-09-28`；全缺 → null。
- A15（lowSample 邊界）：valid 0/1/9/10 → lowSample false/true/true/false；pct null/數值/數值/數值。

### B. API 與傳輸（stub transport，兩端）

- B1：404＋可解析 `NOT_FOUND` → empty 摘要；404＋HTML body、404＋其他 code → error，且非 empty。
- B2：429→429 → 恰 2 次呼叫、第 2 次距第 1 次 ≥2s（可注入時鐘）、error 含「限速」、無快取；429→200 → done 且摘要正確。
- B3：(i) fetch 不 resolve；(ii) headers 已回但 body 不 resolve；(iii) 第一次逾時第二次也逾時 → 各於已定義期限（測試注入縮短）進 error「逾時」；
  不產生數值摘要、不入快取；之後晚到的 resolve 不改變終態。
- B4：非法 JSON、截斷 JSON、200 帶 `error`、`results` 為物件 → error「回應格式異常」。
- B5：同 key 三次（含併發）→ fetch 1 次；同 drug 不同 reaction、同 reaction 不同 drug → 各自 fetch；失敗後再呼叫會重打；
  GAS stub CacheService 驗證 TTL 參數 3600 與 key 含 reaction。
- B6：解析實際請求 URL：`search` 參數恰為既有 `_drugTok(drug)+'+AND+'+_tok(reaction 欄位, reaction)` 字串（與 analyzeADR 的 `a` 查詢相同），
  `limit=100`、`sort=receivedate:desc`，無其他 search；含特殊字元藥名（`A"B\C`）時與既有 `_clean` 一致；無 key 不帶 `api_key`。
- B7：GAS `suspectProportion` 對 B1–B4 對應情境（UrlFetchApp stub）回傳相同終態分類；UrlFetchApp 拋例外 → `{success:false}` 且訊息不含捏造狀態碼。
- B8（機密）：key 設為 sentinel `SENTINELKEY1234567890abcd`，走網路錯誤（例外訊息內含完整 URL）、HTTP 500、解析失敗、GAS 例外 →
  回傳物件 JSON、console 輸出攔截、錯誤訊息皆不含 sentinel。
- B9：body 長度 > SP_MAX_BYTES（測試注入小值）→ error「回應過大」，不計算。

### C. 不影響既有行為

- C1：既有 tests 檔案的 test 案例數與斷言不減少、無 `skip`/`todo`；`_stats`/`_temporal` golden 值不變。
- C2：以 bdf4360 版兩端 `analyzeADR` 對固定 stub 序列（含：一般、多藥、零通報、時序排除、同分）產生的完整回傳凍結為 golden（N/queriedAt 外逐欄），
  新版兩端輸出相同；且 analyzeADR 期間 HTTP 呼叫次數與 bdf4360 相同（冷快取與熱快取各一次）。另在 suspectProportion 執行後再跑 analyzeADR，結果仍等於 golden。
- C3：C2 golden 中的 `interpretation`（sections 與 text）完全相同。
- C4：兩份 HTML 的 `<drug-suggest>` 區塊仍逐字相同（既有測試）。

### D. UI controller（vm 測 `<sp-loader>` 區塊）與手動驗收

- D1：3 列表格，點第 2 列 → transport 恰被呼叫 1 次且參數為第 2 列 drug+reaction；其他列狀態仍 idle；loading 中再點不新增呼叫。
- D2：狀態轉移 idle→queued→loading→done/empty/error；error→重試→done；顯示格式化對 valid 0/1/9/10、valid>0 且 pct=0 逐一斷言輸出文字與 lowSample。
- D3：兩列不同摘要，細項格式化純函式輸出的每個欄值對應正確列；計數總和＝抽樣數；含 `<img>` 形狀的藥名只出現在文字欄位（DOM 以 textContent 建構，手動驗收確認）。
- D4（手動）：375px 寬實機/瀏覽器截圖，驗證表格可橫捲、細項可展開可讀、載入/重試/展開按鈕觸控 ≥44px；走錯誤路徑無 alert。結果記錄於驗收文件。
- D5：loading 中重繪不新增呼叫；done 重繪不新增呼叫；ADR A loading 中改查 ADR B 後 A 晚到 → B 列狀態不受影響；同 key 重試後舊請求晚到不覆蓋新結果。
- D6：controller 以 Pages transport 與 GAS transport（`google.script.run` stub：success/failure handler）各走：done、empty、error、transport failure、watchdog 逾時、重試。
  GAS 實機手動 smoke 一次（需使用者部署），記錄於驗收文件。
- D7：兩份 HTML 的 `<sp-loader>` 區塊逐字相同；兩版表格皆有「疑似藥比例」欄。

### E. 整合（live，`LIVE=1` 手動）

- E1：CARBAMAZEPINE、VANCOMYCIN × `Stevens-Johnson syndrome`、`Toxic epidermal necrolysis`（4 組），經 Pages 引擎路徑：
  斷言 A11 不變式、`sampled ≤ 100`、`valid ≥ 1`；**不斷言特定百分比**。
  每組輸出逐筆稽核表（safetyreportid、目標條目原文欄位、角色、分類與理由）；主持人人工核對每組 ≥20 筆（含所有非 S/I/C 類），
  記錄於 `.ai-review/acceptance.md`，發現誤分類即為失敗。記錄回應大小與耗時、快取命中第二次呼叫 0 次 HTTP。
  live 樣本中未出現的反例類別不得宣稱已驗證，由 A9 fixture 覆蓋。

### F. 文件

- F1：README.md、README.zh-TW.md、docs/methodology.md、DISCLAIMER.md 皆含：公式與有效分母定義、D3 辨識決策表摘要、D4 優先順序、
  combo/ambiguous 排除、最近通報抽樣（receivedate）、PS/SS 不可得、§7.6 限制、請求量與流量（標「實測估計」）；中英文語意一致。
- F2：Code.gs、docs/app.js 的 CONFIG.VERSION 與檔頭為 2.4.0；兩版畫面頁尾顯示 2.4.0。

## 9. 後續版本（不在本次）

- 擴充 SALTS（VALERATE、CARBONATE 等）以減少保守漏配——需逐一人工驗證不造成誤合併。

## 10. 修訂紀錄

| 版本 | 變更 | 依據（plan-verdict #） |
|---|---|---|
| v0.2 | 新增 D3 條目辨識決策表（確認單方、ambiguous 類、主成分集合判 combo）；目標加「無法確認即排除」 | #1、#2、#20、#45 |
| v0.2 | 新增 §4 實測：generic_name 為仿單聯集，多元素≠複方 | #1（主持人實證） |
| v0.2 | 結果歸屬以查詢身分 key＋請求 token；D9 controller 區塊 | #3、#40 |
| v0.2 | 時間契約（Pages 每次嘗試 60s 含 body；GAS watchdog 150s） | #4 |
| v0.2 | 錯誤決策表、結構異常通報計入 unmatched、SP_MAX_BYTES | #5、#7 |
| v0.2 | API key 不入錯誤訊息；B8 | #6 |
| v0.2 | G0 GAS 可行性門檻 | #7 |
| v0.2 | D5 共同摘要契約（含期間）、快取存摘要 | #8、#46 |
| v0.2 | 刪除「模擬 analyzer」保證；查詢/比對/快取鍵用 `_clean` | #9 |
| v0.2 | 單一前端佇列＋間隔（兩版共用） | #10 |
| v0.2 | 平台事實校正（rate limit 官方值、receivedate 語意、無 workflows） | #11 |
| v0.2 | 驗收 A1–A15、B1–B9、C1–C4、D1–D7、E1、F1–F2 依審查改寫 | #12–#34、#36–#44、#47 |
| v0.2 | 拒絕：C4 對照基準區塊（範圍蔓延） | #35 |
| v0.2 | 主持人自查：比對改為兩側去鹽後主成分相等（含鹽輸入不漏配）；全鹽名藥品走不去鹽模式；A8(f)、A9#12 | 自查（非 Codex 項目） |
