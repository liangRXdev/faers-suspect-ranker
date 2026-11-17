# 規格：疑似藥比例（Suspect Drug Proportion）輔助指標

- 版本：v0.3（2026-11-17）— 經 Codex 兩輪規格審查修訂，見文末修訂紀錄
- Repo：faers-suspect-ranker（base: main bdf4360，分支 feat/suspect-proportion）
- 目標版本號：2.3.0 → 2.4.0

## 1. 目標

在排序結果表格新增「疑似藥比例」欄，針對每列「藥品＋ADR」，從 openFDA FAERS 依 FDA 首次收件日（`receivedate`）最近的通報抽樣（最多 100 筆），
計算目標藥品在該通報 `patient.drug[]` 中被標記為 Suspect(1) 或 Interacting(3) 的比例：

```
pct = round((suspect + interacting) / (suspect + interacting + concomitant) × 100)
```

分母僅計入「可確認為目標單方藥品」且「角色為有效 1/2/3」的通報（每份通報至多計 1 次）。
**無法確認就排除並顯示理由，不推估。** 不以降低 unmatched/ambiguous 為目標。
定位：ADR 訊號探索與臨床判讀的輔助資訊，**非 ADR 發生率、非因果機率**。

## 2. 非目標（本次不做）

- N1：不改 ROR、PRR、χ²、時序加權、綜合分數、排序演算法、`analyzeADR` 回傳、`generateInterpretation` 輸出（含文字）。
- N2：比例不納入綜合分數、不影響排序、不寫入規則式解讀文字。
- N3：不區分 PS／SS（openFDA `drugcharacterization` 只有 1/2/3，無 FAERS ASCII 的 `role_cod`）；僅在文件說明。
- N4：不做隨機抽樣、不做全量統計、不做 FAERS 重複通報（case 版本／跨廠商重複）去重。
- N5：不新增後端服務、資料庫、bundler、框架、npm 相依（含 jsdom/Playwright）；不新增資料源（仍只用 `api.fda.gov/drug/event.json`）。
- N6：不自動載入所有列；不做「全部載入」按鈕。
- N7：不用 RxNorm／成分展開；不建完整鹽類字典（僅 D3 列出的有限 SALTS）；不以 `medicinalproduct` 自由文字確認成分。
- N8：不持久化結果（Pages 記憶體快取；GAS CacheService 只存計算摘要，TTL 1h），不存原始通報。
- N9：不做跨使用者或跨 GAS 執行的全域請求排程／鎖；無法取消已送出的 GAS 執行。

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

| 藥品 | total | 抽樣 | S | I | C | 期間 |
|---|---|---|---|---|---|---|
| CARBAMAZEPINE | 956 | 100 | 87 | 2 | 11 | 2024-03～2026-09 |
| VANCOMYCIN | 652 | 100 | 70 | 0 | 30 | 2023-11～2026-09 |

（以 v0.2 原型規則計；v0.3 刪除 MP 確認路徑後，預期 VANCOMYCIN 1 報轉為 ambiguous。實作後以 E1 重測。）

- 回應大小（觀察值，非上限）：未壓縮約 15 MB／100 筆；gzip 約 5.6 MB；單筆通報最多 329 個 drug 條目。openFDA 無欄位投影。
- **`openfda.generic_name` 是該條目對到之所有仿單的聯集，不是成分清單**：VANCOMYCIN 條目 90 次為
  `["VANCOMYCIN HYDROCHLORIDE","VANCOMYCIN"]`。以「陣列多元素＝複方」判定會把 82/100 誤判為 combo。
- 僅靠「無 generic_name 條目」才命中目標的通報：1/200。
- 同報重複：CARBAMAZEPINE 11、VANCOMYCIN 8；同報角色衝突（1/2）：VANCOMYCIN 2。

## 5. 架構決策與理由

- D1 按需載入（每列按鈕）。理由：單次 ~5.6 MB gzip；使用者決定（N6）。
- D2 抽樣查詢＝`_drugTok(name)+AND+reactionmeddrapt:"reaction"`（與 ROR 的 `a` 同一表達式）＋`limit=100&sort=receivedate:desc`，
  無其他 search 條件。不用 `skip` 偽隨機。UI 標「最近通報抽樣（依 FDA 首次收件日）」。
  **搜尋只決定抽樣，不代表條目已確認**；本地辨識是獨立且較保守的規則，不宣稱等價於 openFDA analyzer。
- D3 條目辨識。
  - 定義：
    - `tokens(s)`：字串轉大寫、非 `[A-Z0-9]` 轉空白、依空白切分。非字串輸入視為缺漏。
    - `SALTS`（有限）：HYDROCHLORIDE, HCL, SODIUM, POTASSIUM, CALCIUM, MAGNESIUM, SULFATE, PHOSPHATE, ACETATE, MALEATE, MESYLATE,
      TARTRATE, CITRATE, SUCCINATE, FUMARATE, BESYLATE, BROMIDE, CHLORIDE, HYDROBROMIDE, DIHYDRATE, MONOHYDRATE, ANHYDROUS。
    - **本列正規化模式**（每次計算決定一次，D3 所有比較共用）：`tokens(_clean(name))` 去除 SALTS 後若非空 → `STRIP`，否則 → `FULL`
      （例：`POTASSIUM CHLORIDE`、`MAGNESIUM SULFATE` 為 FULL）。
    - `moiety(s)`：STRIP 模式＝`tokens(s)` 去除 SALTS 後以單一空白連接；**若結果為空，改用完整 tokens 並加前綴 `#`**（不刪除該元素）；
      FULL 模式＝完整 tokens 以空白連接。`M = moiety(_clean(name))`。
    - `exact(v)` ⇔ `moiety(v) === M`。
    - `hit(v)` ⇔ `' '+tokens(v).join(' ')+' '` 包含 `' '+M+' '`（STRIP 模式下 M 為去鹽 token 串）。
    - `combo(s)` ⇔ `tokens` 前的原字串（大寫）含 ` AND `、` WITH `、`+`、`,`，或符合 `[A-Z]\s*/\s*[A-Z]`。
    - `GN` = `openfda.generic_name` 中的非空字串元素；`BN` = `openfda.brand_name` 中的非空字串元素；`MP` = 字串型 `medicinalproduct`。
  - 決策表（依序，第一個成立者決定）：

    | # | 條件 | 條目分類 |
    |---|---|---|
    | 1 | GN、BN、MP 皆無 `hit` | none |
    | 2 | GN 為空 | ambiguous（無協調 generic，無法確認單方；例：MP `JANUMET`、MP `Vancomycin Hydrochloride`） |
    | 3 | GN 任一元素 `combo` | combo |
    | 4 | `{moiety(g) : g∈GN}` 集合大小 > 1 | combo |
    | 5 | GN 每個元素 `exact` | target |
    | 6 | 某 BN 元素 `exact`（商品名查詢；此時 GN 已確認為單一主成分） | target |
    | 7 | 其餘 | ambiguous（例：INSULIN→INSULIN GLARGINE） |
- D4 通報層級分類（每份通報恰一類）：
  1. 有 target 條目 → 取 target 條目中有效角色（字串 `"1"|"2"|"3"` 或數字 `1|2|3`；其餘型別與值皆無效）最高優先者
     **1 > 3 > 2** → `suspect | interacting | concomitant`；所有 target 條目角色皆無效 → `invalidRole`。同報 combo/ambiguous 條目不影響。
  2. 無 target、有 combo 條目 → `combo`
  3. 無 target/combo、有 ambiguous → `ambiguous`
  4. 其餘（含 report 非物件、`patient`/`drug` 缺漏或非陣列、空陣列、drug 元素非物件、只有 none 條目）→ `unmatched`
- D5 共同摘要契約（兩端相同，亦為快取值）：
  `{ drug, reaction, sampled, valid, suspect, interacting, concomitant, invalidRole, combo, ambiguous, unmatched, pct, lowSample,
     periodFrom, periodTo, sampleMode:'recent-receivedate', fetchedAt }`
  - `sampled = 七類總和 = results.length`；`valid = S+I+C`；`valid=0 ⇔ pct=null`；`lowSample = 1≤valid<CONFIG.SP_MIN_VALID(10)`
  - `periodFrom/To` = **sampled 全體**中合法日曆日期（8 碼 `YYYYMMDD` 且為實際存在的日期）之最舊/最新，輸出 `YYYY-MM-DD`；皆無 → `null`
  - empty ⇔ `sampled=0`（404 NOT_FOUND 或 200＋`results=[]`）：各類 0、`pct=null`、期間 null
- D6 兩端各一份純函式 `computeSuspectProportion(reports, drugName)`（Code.gs、docs/app.js），回傳 D5 去除 drug/reaction/fetchedAt 外的欄位；
  測試要求**每端先各自符合人工裁決預期**，再比對兩端逐欄相同。
- D7 Pages 傳輸：`FAERSApp.suspectProportion(drug, reaction)` → Promise<{success, data|error}>，含 fetch、重試、解析、D5 組裝；
  記憶體 Map 快取＋in-flight Promise 合併（同 key 併發只 fetch 一次）；失敗不入快取。
- D8 GAS 傳輸：`suspectProportion(drug, reaction)` 回傳同結構；CacheService 存 D5 摘要 JSON（<1 KB），key `sp1_`+md5(查詢身分 key)，TTL 3600s。
  不承諾跨 GAS 執行的 in-flight 合併（由前端 controller 的同 key 不重複排隊保證）。
- D9 查詢身分 key＝`JSON.stringify([_clean(drug), _clean(reaction)])`（無歧義、不做大小寫或其他正規化）。
- D10 前端 controller（`<sp-loader:begin/end>` 區塊，兩份 HTML 逐字相同，以 vm 測試，仿 drug-suggest 模式）：
  - 區塊內含 transport 選擇：存在 `google.script.run` → GAS 包裝（Promise 化 success/failure handler）；否則 → `FAERSApp.suspectProportion`。
    vm 測試以 stub 注入 `google.script.run` 或 `FAERSApp`，測的即實際包裝程式。
  - 單一佇列：同時至多 1 個「前端有效工作」；相鄰工作啟動間隔 ≥ sleepMs（無 key 1800／有 key 300）。
  - 同 key 在 queued 或 loading 時再次請求 → 不新增工作。
  - 狀態以查詢身分 key 保存：`idle | queued | loading | done | empty | error`；列渲染時依自身 key 取狀態；
    done/empty/error 重繪保留原狀態。
  - 每次工作帶遞增 token；回寫時若該 key 已有較新 token，舊結果丟棄。
  - GAS watchdog：150s 未回 → 該 key `error`「逾時」，**釋放佇列**讓下一工作開始；之後晚到結果丟棄。
    文件明載：watchdog 只結束前端等待，伺服器端 GAS 執行可能仍在進行並佔用配額。
- D11 不改 `analyzeADR` 契約；比例狀態只存在 controller，不寫回 `data.results`。

## 6. 平台限制

- openFDA：官方現值無 key 240 req/min、1,000 req/day（每 IP）；有 key 240 req/min、120,000 req/day。
  本工具沿用既有保守節流（1800/300ms）。`limit` 上限 1000。
- GAS：單次執行 6 分鐘；UrlFetchApp 回應 50 MB 上限；CacheService 單值 100 KB。大回應 fetch＋parse＋遍歷耗時未證實 → G0。
- 回應大小無上限保證 → `CONFIG.SP_MAX_BYTES = 40,000,000`（**解壓後 body 位元組數**：Pages 以 `resp.arrayBuffer().byteLength`、
  GAS 以 `resp.getContent().length`），在 JSON 解析前檢查。
- `JSON.parse` 無法中斷：解析完成後檢查是否已超過該次嘗試期限，超過即 timeout，不發布摘要。

## 7. 資料流與失敗行為

1. 主分析完成（ROR/PRR 表格已呈現，不受影響）。每列「疑似藥比例」欄初始為「載入」按鈕。
2. 點擊 → controller 排隊（`queued`「排隊中」）→ 出佇列 `loading`（「載入中」，按鈕 disabled）。
3. 平台生命週期：
   - Pages：每次嘗試從送出 HTTP 到 body 讀完並解析完成上限 60s（AbortController 涵蓋 fetch 與 body 讀取，解析後再檢查期限）；
     排隊不計；整次操作最多 2 次嘗試（共用預算），重試前等待 2s。
   - GAS：伺服器端以同一錯誤決策表處理（最多 2 次嘗試、間隔 2s，`Utilities.sleep`），不設 HTTP timeout（依平台）；前端 watchdog 150s（D10）。
4. 錯誤決策表（每次嘗試依序判定，第一個成立者決定；兩端相同）：

   | # | 條件 | 可重試 | 結果（重試用盡或不可重試時） | 快取 |
   |---|---|---|---|---|
   | 1 | 傳輸例外（無 HTTP 回應） | 是 | error「網路錯誤，無法連線 openFDA」（不捏造狀態碼） | 否 |
   | 2 | 嘗試逾時（Pages） | 是 | error「逾時（60s）」 | 否 |
   | 3 | status 429 | 是 | error「openFDA 限速，請稍後重試或設定 API Key」 | 否 |
   | 4 | status 5xx | 是 | error「openFDA 伺服器錯誤 HTTP {status}」 | 否 |
   | 5 | status 404，body 可解析且 `error.code==='NOT_FOUND'` | 否 | empty 摘要 | 是 |
   | 6 | 其他非 200 status | 否 | error「openFDA 回應 HTTP {status}」 | 否 |
   | 7 | 200，body > SP_MAX_BYTES | 否 | error「回應過大」 | 否 |
   | 8 | 200，body 非 JSON／截斷／含 `error`／`results` 非陣列 | 否 | error「回應格式異常」 | 否 |
   | 9 | 200，`results` 為陣列 | — | `results.length=0` → empty；否則 done（D5） | 是 |

   - 第 2 次嘗試的結果依同表判定，不重置預算。
   - 所有錯誤訊息、console、回傳物件**不得含 API key 或完整請求 URL**。
   - error 狀態顯示「重試」按鈕；重試重新排隊並開始新的 2 次預算。
5. 顯示：
   - `valid ≥ 10`：`89% (n=100)`（n = valid）
   - `1 ≤ valid < 10`：`67% (n=3)` ＋ 小字「樣本少」
   - `valid = 0`（done 但全排除，或 empty）：「資料不足」；仍可展開細項（empty 細項註明「查無通報」）
6. 展開細項（點擊切換，非僅 hover）：抽樣數、有效分母、Suspect、Interacting、Concomitant、角色缺漏／無效、複方（排除）、
   無法確認成分（排除）、無法對應、抽樣期間、「最近通報抽樣（依 FDA 首次收件日，非隨機）」；固定說明文字：
   「疑似藥比例表示抽樣 FAERS 通報中，目標藥物被標記為 Suspect 或 Interacting 的比例，並非 ADR 發生率或因果機率。」
   及限制：通報者判定非因果；最多 100 筆非全量；notoriety bias／通報習慣／適應症影響；不可據兩藥比例差判定相對致病機率；
   不納入綜合分數；藥物角色為通報層級，同報多 ADR 時不針對單一 ADR；PS/SS 不可區分；缺協調 generic 名稱的條目一律排除。
7. 重新執行主分析／重繪 → 列依自身 key 從 controller 取狀態；換 ADR 後舊 key 晚到結果只更新舊 key 狀態。

## 8. 驗收條件（可證偽）

測試皆零依賴（node:test + vm）。標「兩端」者對 Code.gs 與 docs/app.js 各自斷言人工裁決預期，再斷言兩端輸出逐欄相同。
fixture 中未列出的欄位一律**缺漏**；每案預期為唯一值。

### G. 動工前可行性門檻

- G0：在實際 GAS（使用者部署之測試版本）以**冷快取**對 CARBAMAZEPINE×SJS 與「§4 候選中回應位元組最大者」執行 `suspectProportion`，
  需實際完成 100 筆抽樣並回傳成功摘要；記錄回應位元組、耗時、終態於 `.ai-review/g0-feasibility.md`；Pages 同查詢耗時一併記錄。
  GAS 若無法在 150s 內完成或觸發配額錯誤 → 停下交使用者決策（不得自行降低 limit 或截斷）。
  實作順序：純函式＋GAS 後端完成 → G0 → 通過才接 GAS UI。

### A. 計算正確性（`computeSuspectProportion`，兩端）

條目簡記：`{gn:[...], bn:[...], mp:'...', r:角色}`。

- A1：三組 fixture（全字串、全數字、混合），各含角色 1、3、2 各一報（目標條目 `{gn:['CARBAMAZEPINE'], r:…}`）→ 每組 S1/I1/C1、valid 3、pct 67。
  另三報皆 1 → S3、pct 100。
- A2：4 報目標皆 2 → concomitant=valid=sampled=4、其餘 0、pct=0（非 null）；格式化顯示「0% (n=4)」。
- A3：角色 1,3,3,2（各一報）→ S1/I2/C1、pct 75；再加一報目標 (2,2,1) → S2/I2/C1、valid 5、pct 80。
- A4（他藥角色）：同報他藥 `{gn:['PHENYTOIN'], r:1}`＋目標 r:2；他藥 r:3＋目標 r:2；他藥排在目標前與後 → 四種皆 concomitant。
- A5（重複條目去重）：查 `CARBAMAZEPINE`，同報三個 target 條目 `{gn:['CARBAMAZEPINE'], r:2}`、
  `{gn:['CARBAMAZEPINE'], bn:['TEGRETOL'], mp:'TEGRETOL', r:2}`、`{gn:['CARBAMAZEPINE'], mp:'carbamazepine.', r:2}` → concomitant 恰 1、sampled 1。
  另：查 `TEGRETOL`，同報 `{gn:['CARBAMAZEPINE'], bn:['TEGRETOL'], r:2}` ×2（僅 #6 可導出 target）→ concomitant 恰 1。
- A6（D4 優先）：同報目標 (2,1)→suspect；(2,3)→interacting；(3,1)→suspect；(2,3,1)→suspect；(無效,2)→concomitant；(無效,無效)→invalidRole；
  target(r:2)＋combo 條目 → concomitant；target(r:2)＋ambiguous 條目 → concomitant；target(無效)＋combo → invalidRole；
  每組所有排列結果相同。
- A7（無效角色）：缺欄、`null`、`""`、`"4"`、`0`、`true`、`[1]`、`{}`、`"1 "` → 皆無效；單獨出現 → invalidRole，不進 valid。
- A8（別名，皆應 target）：查 `VANCOMYCIN`：
  (a) `{gn:['VANCOMYCIN HYDROCHLORIDE','VANCOMYCIN']}` → target（#5）
  (b) `{gn:['VANCOMYCIN HYDROCHLORIDE'], mp:'VANCOCIN'}` → target（#5）
  (c) `{gn:['VANCOMYCIN'], bn:['VANCOCIN','FIRVANQ'], mp:'Vancomycin (1,000 and 1,250 mg)'}` → target（#5；mp 不影響）
  (d) 查 `VANCOMYCIN HYDROCHLORIDE`（STRIP，M=VANCOMYCIN）對 `{gn:['VANCOMYCIN']}` → target（hit 用 M，#5）
  (e) 查 `FIRVANQ` 對 `{gn:['VANCOMYCIN HYDROCHLORIDE'], bn:['VANCOCIN','FIRVANQ']}` → target（第 2 元素 BN exact，#6）
  查 `TEGRETOL` 對 `{gn:['CARBAMAZEPINE'], bn:['EPITOL','TEGRETOL']}` → target（#6）。
- A9（具名反例：皆不得進 valid；分類唯一）：
  1. 查 `INSULIN`，`{gn:['INSULIN GLARGINE']}` → ambiguous（#7）
  2. 查 `AMOXICILLIN`，`{gn:['AMOXICILLIN AND CLAVULANATE POTASSIUM']}` → combo（#3）
  3. 查 `AMOXICILLIN`，`{gn:['AMOXICILLIN','CLAVULANATE POTASSIUM']}` → combo（#4，集合 {AMOXICILLIN, CLAVULANATE}）
  4. 查 `AMOXICILLIN`，`{gn:['AMOXICILLIN','SODIUM CHLORIDE']}` → combo（#4，集合 {AMOXICILLIN, #SODIUM CHLORIDE}）
  5. 查 `AMOXICILLIN`，`{mp:'AMOXICILLIN (WITH CLAVULANATE POTASSIUM)'}` → ambiguous（#2）
  6. 查 `HYDROCODONE`，`{mp:'HYDROCODONE/APAP'}` → ambiguous（#2）
  7. 查 `SULFAMETHOXAZOLE`，`{gn:['SULFAMETHOXAZOLE AND TRIMETHOPRIM'], mp:'BACTRIM'}` → combo（#3）
  8. 查 `IRON`，`{mp:'IRONWOOD EXTRACT'}` → none（#1）→ 通報 unmatched
  9. 查 `ESTRADIOL`，`{gn:['ESTRADIOL VALERATE']}` → ambiguous（#7；VALERATE 不在 SALTS，保守漏配）
  10. 查 `METFORMIN`，`{gn:['SITAGLIPTIN AND METFORMIN HYDROCHLORIDE'], bn:['JANUMET']}` → combo（#3）
  11. 查 `JANUMET`，`{mp:'JANUMET'}` → ambiguous（#2；名稱相等≠單方）
  12. 查 `LITHIUM`，`{gn:['LITHIUM CARBONATE']}` → ambiguous（#7；保守漏配）
  13. 查 `VANCOMYCIN`，`{mp:'Vancomycin Hydrochloride'}` → ambiguous（#2；live 1/200 案例型態）
  14. 查 `POTASSIUM CHLORIDE`（FULL），`{gn:['POTASSIUM CHLORIDE']}` → target；`{gn:['POTASSIUM CITRATE']}` → none
  15. 查 `MAGNESIUM SULFATE`（FULL），`{gn:['MAGNESIUM SULFATE','SODIUM CHLORIDE']}` → combo（#4，FULL 集合大小 2）
  已知「保守漏配」（#9、#12、#13 類）列為限制；已知「誤納入」不得以文件豁免。
- A10（無法對應）：report 為 `null`／字串；`patient` 缺；`drug` 非陣列；`drug=[]`；drug 元素 `null`；只有他藥 → 各為 unmatched、sampled 計入、不拋例外。
- A11（性質）：固定 seed 產生 ≥20 組 fixture，每組斷言：七類總和＝sampled＝reports.length；`valid=0⇔pct===null`；
  `valid>0` 時 pct 為 0–100 整數；在任一通報加入一個**依 D3 為 none** 的條目（任意角色）結果不變；
  複製已存在的 target 條目（同角色）結果不變。
- A12：47 報 = S20/I5/C17/invalidRole 2/combo 1/ambiguous 1/unmatched 1 → sampled 47、valid 42、pct 60；
  格式化純函式輸入 `{sampled:47, valid:42, suspect:20, interacting:5, concomitant:17,…}` 輸出含 `n=42` 且不含 `n=47`；
  另以 `{sampled:50, valid:10, suspect:3, interacting:0, concomitant:7}` 輸出 `30% (n=10)`。
- A13：A1–A12、A14、A15 全部 fixture 兩端輸出逐欄相同。
- A14（期間，兩端）：sampled 中最早日期 `20240311` 與最晚 `20260928` 分別出現在 unmatched 與 combo 通報；另含缺漏、`"2024"`、`"20240230"`、`"20241301"` →
  periodFrom `2024-03-11`、periodTo `2026-09-28`；全不合法 → null。
- A15（lowSample 邊界，兩端）：valid 0/1/9/10 → lowSample false/true/true/false；pct null/數值/數值/數值。

### B. API 與傳輸（stub，兩端各自斷言）

- B1：404＋`NOT_FOUND` → 完整 D5 空摘要（各類 0、pct null、期間 null）；再次呼叫零 HTTP（已快取）。
  404＋HTML body、404＋其他 code → error（非 empty）。200＋`results=[]` → empty。
- B2：序列 429→429、500→500、網路→網路 → 各恰 2 次、間隔 ≥2s（注入時鐘）、對應 error 訊息、無快取；
  429→200、500→200、網路→200 → done 且摘要正確；429→500 → 2 次後 error「伺服器錯誤」（預算共用，不出現第 3 次）。
- B3（Pages）：(i) fetch 不 resolve；(ii) headers 回但 body 不 resolve；(iii) 逾時→逾時；(iv) 逾時→200；(v) 解析完成時已超過期限
  → (i)–(iii)、(v) 於期限（注入縮短）後 error「逾時」、無數值摘要、無快取，晚到 resolve 不改終態；(iv) done 且 fetch 2 次。
- B4：429＋HTML body → 依 #3 重試；500＋HTML → 依 #4；200＋非法 JSON、截斷 JSON、200＋`error`、`results` 為物件 → error「回應格式異常」、不重試。
- B5：Pages 傳輸：同 key 三次併發 → fetch 1 次；同 drug 不同 reaction、同 reaction 不同 drug → 各自 fetch；失敗後再呼叫會重打。
  GAS：CacheService stub 命中時 UrlFetchApp 0 次；put 的 TTL 為 3600、key 由 D9 key 產生（`["A|B","C"]` 與 `["A","B|C"]` 不同 key）。
- B6：有 key 與無 key 兩情境解析實際請求 URL：`search` 恰為 `_drugTok(drug)+'+AND+'+_tok('patient.reaction.reactionmeddrapt', reaction)`，
  `limit=100`、`sort=receivedate:desc`，無其他 search；含 `A"B\C` 時與 `_clean` 一致；有 key 時 `api_key` 值正確、無 key 時不帶。
- B7（GAS）：UrlFetchApp stub 覆蓋決策表 #1、#3–#9 → 終態分類、嘗試次數、`Utilities.sleep` 參數與 Pages 一致；
  UrlFetchApp 拋例外 → `{success:false}` 且訊息不含狀態碼。
- B8（機密）：key＝`SENTINELKEY1234567890abcd`，走網路錯誤（例外訊息內含完整 URL）、HTTP 500、解析失敗、GAS 例外 →
  回傳物件 JSON、攔截的 console 輸出、錯誤訊息皆不含 sentinel，也不含 `api.fda.gov/drug/event.json?`。
- B9：body 位元組數＝上限 → 通過；上限＋1 → error「回應過大」不解析；多位元組內容（中文字）其字元數 < 上限但位元組數 > 上限 → error。

### C. 不影響既有行為

- C1：既有 tests 檔案的案例與斷言不刪除、不放寬（預期值、比較方式不變），無 `skip`/`todo`；`_stats`/`_temporal` golden 值不變。
- C2：以 bdf4360 版兩端 `analyzeADR` 對固定 stub 序列（一般、多藥、零通報、時序排除、同分）產生的完整回傳凍結為 golden（僅排除 `queriedAt`；N 納入），
  新版兩端輸出相同；analyzeADR 期間 HTTP 次數與 bdf4360 相同（冷、熱快取各一）；
  另：suspectProportion 執行中（未完成）啟動 analyzeADR，以及完成後再跑 analyzeADR，結果皆等於 golden。
- C3：C2 golden 的 `interpretation`（sections 與 text）完全相同。
- C4：兩份 HTML 的 `<drug-suggest>` 區塊仍逐字相同（既有測試）。

### D. UI controller（vm 測 `<sp-loader>` 區塊，實際 transport 包裝）與手動驗收

- D1：3 列；依序快速點第 1、3 列 → 同時有效工作數 ≤1、順序 1→3、第 2 次啟動距第 1 次結束 ≥ sleepMs；第 2 列始終 idle；
  第 1 列 queued/loading 時再點 → transport 呼叫數不變。
- D2：狀態轉移 idle→queued→loading→done/empty/error；error→重試→done；
  sampled=0 → empty；sampled>0 且 valid=0 → done 且顯示「資料不足」；valid 1/9/10 與 valid>0 且 pct=0 的輸出文字與 lowSample 逐一斷言。
- D3：兩列不同摘要的細項格式化輸出各欄值對應正確列、計數總和＝抽樣數。手動驗收：兩版實際 DOM 兩列逐欄核對，含 `<img src=x>` 藥名只顯示為文字。
- D4（手動）：Pages、GAS 兩版分別於 375px 寬：表格可橫捲、細項可展開可讀、載入/重試/展開按鈕實測觸控 ≥44px；走錯誤路徑無 alert。記錄於 `.ai-review/acceptance.md`。
- D5：loading 中重繪不新增呼叫；done/empty/error 重繪保留狀態不新增呼叫；ADR A loading 中改查 ADR B，A 晚到 → B 列不受影響；
  同 key 重試後舊請求晚到不覆蓋新結果；GAS watchdog 逾時後下一個排隊工作會開始，舊結果晚到被丟棄。
- D6：以 `FAERSApp` stub 與 `google.script.run` stub（success/failure handler）分別走：done、empty、error、transport failure、重試；
  GAS 另測 watchdog；Pages 的 60s 期限由 B3 覆蓋。GAS 實機手動 smoke（需使用者部署）：記錄輸入、終態、摘要。
- D7：兩份 HTML 的 `<sp-loader>` 區塊逐字相同；兩版手動驗收皆從表格實際點擊完成載入與細項展開，並看到頁尾版本 2.4.0。

### E. 整合（live，`LIVE=1` 手動）

- E1：CARBAMAZEPINE、VANCOMYCIN × `Stevens-Johnson syndrome`、`Toxic epidermal necrolysis`（4 組），呼叫受驗引擎（docs/app.js）：
  斷言 A11 不變式、`sampled ≤ 100`、`valid ≥ 1`；**不斷言特定百分比**。
  受驗引擎另提供稽核輸出（同一份分類結果，非另寫分類器）：每報 safetyreportid、所有 hit 候選條目的 GN/BN/MP 原文、各條目 D3 分類與列號、
  角色、通報分類。主持人人工核對每組 ≥20 筆（含全部非 S/I/C 通報與全部角色衝突通報），記錄於 `.ai-review/acceptance.md`；發現誤分類即失敗。
  記錄回應位元組、耗時、第二次呼叫 0 次 HTTP。live 未出現的反例類別不得宣稱已驗證（由 A9 覆蓋）。

### F. 文件

- F1：README.md、README.zh-TW.md、docs/methodology.md、DISCLAIMER.md 依 D3／D4／D5 逐項核對語意（不只關鍵字）：公式與有效分母、
  辨識規則摘要（含「缺協調 generic 一律排除」「名稱相等不等於單方」）、角色優先順序、combo/ambiguous 排除、最近通報抽樣（receivedate）、
  PS/SS 不可得、§7.6 限制、請求量與流量（標「實測估計」）、GAS watchdog 不會中止伺服器執行；中英文語意一致。
- F2：Code.gs、docs/app.js 的 CONFIG.VERSION 與檔頭為 2.4.0；兩版畫面頁尾顯示 2.4.0（D7 手動確認）。

## 9. 後續版本（不在本次）

- 擴充 SALTS（VALERATE、CARBONATE 等）以減少保守漏配——需逐一人工驗證不造成誤合併。
- 無 generic 條目的 MP 確認（需可靠單方證據來源）。

## 10. 修訂紀錄

| 版本 | 變更 | 依據（plan-verdict #） |
|---|---|---|
| v0.2 | D3 條目辨識決策表、ambiguous 類、主成分集合判 combo；目標加「無法確認即排除」 | #1、#2、#20、#45 |
| v0.2 | §4 實測：generic_name 為仿單聯集，多元素≠複方 | #1 |
| v0.2 | 查詢身分 key＋請求 token；controller 區塊 | #3、#40 |
| v0.2 | 時間契約、錯誤決策表、SP_MAX_BYTES、key 不外洩、G0、D5 摘要、`_clean` 一致、單一佇列、平台事實校正 | #4–#11、#46 |
| v0.2 | 驗收依審查改寫；拒絕 C4 基準對照（範圍蔓延） | #12–#44、#47；#35 |
| v0.2 | 自查：兩側去鹽比主成分；全鹽名不去鹽模式 | 自查 |
| v0.3 | 無 generic_name 條目一律 ambiguous，刪除 MP 確認路徑（#7–#9、FORMS、括號解析）；live 影響 1/200 | R2-1、R2-44 |
| v0.3 | 單一正規化模式（STRIP/FULL）供 D3 全部比較；空 moiety 以 `#`＋完整 tokens 保留；hit 改用 M | R2-2、R2-3、R2-5、R2-42 |
| v0.3 | A8/A9 每案完整欄位與唯一分類；新增 JANUMET、AMOXICILLIN＋SODIUM CHLORIDE 等反例 | R2-5、R2-15、R2-16 |
| v0.3 | A11 限定 none 條目、pct 斷言限 valid>0 | R2-4、R2-18 |
| v0.3 | 錯誤決策表改依序判定、共用 2 次預算、empty＝sampled 0 | R2-6 |
| v0.3 | 平台生命週期分寫；watchdog 釋放佇列、伺服器執行可能續跑 | R2-7、R2-43 |
| v0.3 | B5 拆 Pages／GAS；key 改 JSON.stringify | R2-8、R2-9 |
| v0.3 | 位元組定義、parse 後檢查期限 | R2-10 |
| v0.3 | G0 冷請求、位元組最大；A/B/C/D/E/F 各條依第 2 輪改寫 | R2-11–R2-41 |
| v0.3.1（實作） | §6 GAS 位元組量測改為由 `getContentText('UTF-8')` 計算 UTF-8 位元組（`_spUtf8Over`：字元數上下界快篩，必要時逐字計算），不用 `getContent().length`——15–31 MB 的 Java byte[] 轉 JS 陣列成本過高；語意不變（解壓後 body 位元組），B9 兩端涵蓋 | 實作期決定 |
| v0.3.1（實作） | §8 D1 間隔定義採較嚴格者：「前一工作**結束**到下一工作開始 ≥ sleepMs」（D10 原寫啟動間隔） | 實作期決定 |
