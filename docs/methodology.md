# Methodology — 方法學說明

> 本文件說明計算邏輯與其文獻依據，供學習與審閱。**訊號 ≠ 因果**，請併讀 `DISCLAIMER.md`。

## 1. 反向查詢（Symptom → Drug）

傳統「藥 → 症狀」無法回答多重用藥下「哪顆藥是元兇」。本工具改以症狀為查詢條件，
對病人清單中每顆藥取 2×2 列聯表。所有計數來自單一 endpoint
`api.fda.gov/drug/event.json`，僅讀 `meta.results.total`。

| 格 | 定義 | 查詢 |
|---|---|---|
| a | 藥 ∩ 症狀 | `search=drug:"X"+AND+reaction:"S"` |
| a+b | 該藥總通報 | `search=drug:"X"` |
| a+c | 該症狀總通報 | `search=reaction:"S"` |
| N | 全庫總通報 | 無 search |

藥名以 `generic_name` OR `brand_name` OR `medicinalproduct` 三欄聯集查詢，
降低品牌/學名不一致造成的低估。

## 2. 不相稱性指標

- **ROR**（Reporting Odds Ratio）= ad / bc
  - 95% CI = exp( ln(ROR) ± 1.96 × √(1/a + 1/b + 1/c + 1/d) )
  - 參考：van Puijenbroek EP, et al. *Pharmacoepidemiol Drug Saf*. 2002.
- **PRR**（Proportional Reporting Ratio）= [a/(a+b)] / [c/(c+d)]
  - 參考：Evans SJW, et al. *Pharmacoepidemiol Drug Saf*. 2001.
- **χ²**：2×2，採 Yates 連續性校正。
- **零格校正**：任一格為 0 時，四格各 +0.5（Haldane-Anscombe），避免除零並穩定 CI。

### 訊號判定門檻

`a ≥ 3` 且 [ ROR 95% 下界 > 1 ] 或 [ PRR ≥ 2 且 χ² ≥ 4 ]。
（對齊 EVDAS / 常見 PRR 訊號準則的精神；閾值集中於 `CONFIG`，可依需求調整。）

## 3. 時序加權（本地）

`latency = onset − start`（天）。

| 條件 | 權重 | 說明 |
|---|---|---|
| latency < 0 | 0 | 症狀早於用藥 → 排除 |
| 0–90d | 1.0 | 急性窗 |
| 91–180d | 0.6 | 亞急性 |
| > 180d | 0.3 | 慢性 |

**Dechallenge（停藥後發生）**：`onset > stop` 時，潛伏期權重再乘衰減：

| 停藥間隔 | 衰減係數 |
|---|---|
| ≤ 7d | × 0.7 |
| 8–30d | × 0.4 |
| > 30d | × 0.1 |

> ⚠ 此為**啟發式**：未納入個別藥物半衰期；遲發型反應（如部分 DILI、遲發過敏）
> 仍可能在停藥後出現。係數集中於 `CONFIG.POST_STOP_DECAY`，可依科別調整。

### 綜合排序分數

`composite = temporalWeight × ln(ROR)`（ROR ≤ 1 計 0）。
時序排除（weight=0）者沉底。**此分數僅供排序，非機率、非因果強度。**

## 4. 個案因果評估

- **Naranjo ADR Probability Scale**：10 題，計分分級
  確定 ≥9、很可能 5–8、可能 1–4、存疑 ≤0。
  參考：Naranjo CA, et al. *Clin Pharmacol Ther*. 1981;30(2):239-45.
- **WHO-UMC system**：Certain / Probable / Possible / Unlikely / Conditional / Unassessable，
  依準則由評估者判斷；本工具提供建議分類，最終由臨床確認。
  參考：The Use of the WHO-UMC System for Standardised Case Causality Assessment, Uppsala Monitoring Centre.
- **ALDEN**（SJS/TEN 專用，多藥競爭）：僅在症狀為 Stevens-Johnson syndrome / toxic
  epidermal necrolysis 時提供，**不適用 DRESS／AGEP**。每藥計 6 步，中間分 = 各步加總，
  再經步驟6 競爭調整為最終分。參考：Sassolas B, et al. *Clin Pharmacol Ther*. 2010;88(1):60-8.

#### ALDEN 點值（依 Sassolas 2010；理論範圍 −12～+10）

| 步驟 | 選項 → 點值 |
|---|---|
| 1 延遲（用藥→症狀） | 5–28d **+3**、29–56d **+2**、1–4d **+1**、>56d **−1**、用藥晚於症狀 **−3**；rechallenge 陽性時窗調整為 1–4d **+3**、5–56d **+1** |
| 2 藥物仍在體內 | Definite **0**、Doubtful **−1**、Excluded **−3**（本工具：未填 t½ 以停藥天數簡化預填，填 t½ 改用 `5×t½`，可手動覆寫） |
| 3 Pre/Rechallenge | 同藥→SJS/TEN **+4**、同藥→他反應或類似藥→SJS/TEN **+2**、類似藥→他反應 **+1**、無接觸 **0**、同藥無反應 **−2** |
| 4 Dechallenge | 已停藥/不知 **0**、病程中續用未惡化 **−2** |
| 5 Notoriety | Strongly **+3**、Associated **+2**、Suspect **+1**、Unknown **0**、Not suspected **−1**（UI 旁顯示本工具 FAERS ROR 供參考，不自動代入） |
| 6 其他病因 | 若存在他藥中間分 >3 且**高於**本藥，本藥最終分 **−1** |

分級：**≥6** Very probable、**4–5** Probable、**2–3** Possible、**0–1** Unlikely、**<0** Very unlikely。

> ⚠ ALDEN 為 SJS/TEN 之**已驗證**演算法（與 EuroSCAR r=0.90），與本工具其他啟發式時序加權
> 不同層級。本工具步驟2 採簡化實作（見上），Notoriety 與 Pre/Rechallenge 仰賴使用者輸入；
> 結果僅供教學與個案討論，**請對照原始量表全文核對**。

> 本工具的 Naranjo / WHO-UMC 題目為**自行精簡之中文版**，計分與分級依原始文獻；
> 正式文件請對照原始量表全文。

## 5. 與既有方法學的關係（定位本工具）

本工具的「時序加權 + 不相稱性排序」是**簡化的教學模型**，並非新方法。理解它與下列
已驗證方法的對應與差距，有助於正確判讀與後續延伸。

### 5.1 個案因果：本工具時序加權 vs. ALDEN 的結構化時序窗

ALDEN（ALgorithm for Drug causality in Epidermal Necrolysis，SJS/TEN 專用）對「給藥→發病」
延遲採**結構化、含負分排除**的分帶，並以**半衰期**判斷停藥後藥物是否仍在體內：

| 面向 | 本工具（啟發式） | ALDEN（已驗證，SJS/TEN） |
|---|---|---|
| 時序分帶 | ≤90d=1.0 / 91–180d=0.6 / >180d=0.3 | 5–28d=+3 / 1–4d=+1 / 29–56d=+2 / >56d=−1 / index 後用藥=−3 |
| 停藥後處理 | 固定衰減係數（0.7/0.4/0.1） | 以 `5 × t½` 判斷藥物是否清除，再給 Doubtful/Excluded |
| 競爭多藥 | 各藥獨立計分後排序 | **步驟 6**：若任一藥 intermediate>3，其餘各藥 −1（"另有更可能原因"） |
| 驗證 | 無（教學示意） | 與 EuroSCAR 金標準 r=0.90 |

> 啟示：本工具的 `POST_STOP_DECAY` 可在取得藥物 `t½` 時改採「`5×t½` 內仍計權、之後快速
> 衰減」的藥動學感知版本；多藥情境也可引入 ALDEN 式的競爭調整。二者均屬**可選延伸**，
> 若實作須在本文件標註並沿用 §4 的計分變更規則。
> 參考：Sassolas B, et al. *Clin Pharmacol Ther*. 2010;88(1):60-8.

### 5.2 族群時序：與 PSSA 的同源思維

處方序列對稱分析（**Prescription Sequence Symmetry Analysis, PSSA**）以「用藥與事件的
**先後順序對稱性**」在族群層級偵測藥源性事件（處方瀑布），核心同樣是**時序方向**——
與本工具「latency<0 即排除」是同一邏輯的不同尺度（族群 vs. 個案）。
本工具的反向查詢（症狀→藥）即呼應「先問新症狀是不是前一個藥造成的」之臨床反射。
參考：Rochon PA, Gurwitz JH. *Lancet*. 2017;389:1778-80（prescribing cascade）。

### 5.3 群體訊號 ↔ 個案因果可串接，而非平行

ROR/PRR 等群體訊號可直接作為個案因果評估中「藥物 notoriety（已知風險強度）」的客觀證據。
例如文獻已用 FAERS ROR 佐證 notoriety（如 vancomycin SJS 之 FAERS ROR ≈ 9.7、linezolid ≈ 3.5）。
本工具在因果面板中以 FAERS 訊號**預填** Naranjo Q1／WHO-UMC「已知反應」即基於此串接；
但**預填必可被覆寫**，且訊號強度不等於個案因果成立。

## 6. 已知偏差與限制

- FAERS 為自願通報：無分母，**不能計算發生率或風險**。
- Notoriety bias、Weber effect、適應症混淆、重複通報。
- `medicinalproduct` 為自由文本；成分正規化僅部分緩解。
- 資料季更，約落後 3 個月以上。
- 群體訊號（ROR/PRR）與個案因果（Naranjo/WHO-UMC）為**互補**，不可互相取代。
- 本工具時序加權與停藥衰減為**啟發式**，未達 ALDEN 等已驗證演算法的嚴謹度（見 §5.1）。

## 7. 本次分析解讀（規則式，Exploratory Interpretation）

`generateInterpretation(results, meta)` 為純函式（`Code.gs` 與 `docs/app.js` 各一份，測試比對輸出逐字一致），
只讀既有分析輸出，**不重新查詢 FAERS、不改統計、不呼叫 LLM**。輸出純文字段落，前端以 `textContent` 呈現。

| 段落 | 規則 |
|---|---|
| A. 訊號摘要 | 症狀、藥品數、達門檻數；綜合排序第一者之 ROR（95% CI）、PRR、綜合分數。ROR≤1 明示「非正向訊號」；ROR>1 但 CI 下界≤1 標示不確定性；附 ROR 定義（非風險／非因果機率） |
| B. 時序貢獻 | 權重全同 → 「時序未改變排序，由 ROR 決定」；權重不同 → 列出被調降者；缺日期/格式錯誤 → 「時間關係無法充分評估」；症狀早於用藥 → 「不符初始假設，但不宜宣稱在所有情境下已排除」；停藥後 → 說明衰減；有有效時序時聲明為通用時間窗、非 ADR-specific latency |
| C. 判讀限制 | 固定文字（不隨資料變動） |

**排名比較**：綜合排序沿用既有 `rank`（同分沿用輸入順序，與表格一致）；ROR-only 對照排序用**同一候選集合**，
同分依 95% CI 下界、再依綜合排序順位打破平手。兩者不同的藥品逐一列出。

> 措辭禁區：不寫「最可能造成」「風險較高」「致病機率」；排序第一只代表優先檢視順序。

為判斷時序狀態，`_temporal` 回傳新增 `status`（`on` / `post` / `before` / `missing` / `invalid`）；
權重、天數與 flag 文字**不變**（tests/engine.test.js 以改動前 golden 值驗證）。

## 8. 藥名輸入輔助（Autocomplete）

| 層 | 來源 | 用法 |
|---|---|---|
| Primary | openFDA Drug NDC `/drug/ndc.json` | `search=generic_name:<prefix>*` 與 `brand_name:<prefix>*`，以 `count=*.exact` 聚合取不重複名稱；商品名再以 `brand_name.exact` 查其 `generic_name` 標示成分 |
| Secondary | RxNorm `approximateTerm` + `rxcui/{id}/properties` | NDC 前綴查無結果時提供拼字近似建議；只保留 TTY = IN / PIN / MIN / BN |

- **不自動採用**：Enter 未以方向鍵選中時不選取；RxNorm 近似建議標示「請確認」。只有使用者點選後才記錄為已確認。
- **不合併**：去重只合併大小寫、空白與 `HCl ≡ hydrochloride`；不同鹽類、複方、商品名各自保留並標示類別。
- **查詢相容性**：分析仍以輸入框文字（即選定之 `queryName`）原樣套用既有三欄 OR 查詢；**不做同義詞展開**，
  商品名／複方不自動轉為單一成分。選取紀錄（`displayName / genericName / brandName / source / rxcui / queryName`）
  以 `nameInfo` 透傳，只用於解讀與複製紀錄，不參與統計。
- **未驗證藥名**：未從建議選取者執行前顯示 inline 提醒，明確確認後才以原文字查詢，並在結果與解讀中標示。
- **效能／降級**：≥3 英文字母、debounce 350 ms、AbortController + 序號丟棄晚到回應、6 s timeout、
  記憶體快取 10 分鐘（上限 100 筆，錯誤不快取）、HTTP 429 後冷卻 60 秒；任何失敗皆保留手動輸入。
- **部署一致性**：兩 API 皆回 `Access-Control-Allow-Origin: *`，GAS（HtmlService iframe）與 Pages 皆由瀏覽器直接呼叫，
  共用同一份程式（`<drug-suggest:begin/end>` 區塊，兩版 HTML 逐字相同，測試比對），不經 `google.script.run`、不消耗 UrlFetch 配額。
- **取捨**：openFDA 無 key 時有每日請求上限，故 typeahead 不帶 key、以快取與冷卻節流；NDC 名稱為 SPL 標示文字，
  與 FAERS `openfda.*` 欄位同源但不保證涵蓋 `medicinalproduct` 自由文字的所有寫法。

## 9. 疑似藥比例（Suspect Drug Proportion，輔助指標，v2.4.0）

探索性輔助資訊，**不是**發生率、因果機率或已驗證的因果評估；**不納入綜合分數、不影響排序與規則式解讀**。
規格與審查紀錄：`.ai-review/plan.md`（v0.3）、`plan-review.md`、`plan-verdict.md`；實測與人工稽核：`.ai-review/acceptance.md`。

### 9.1 定義

```
pct = round((Suspect + Interacting) / (Suspect + Interacting + Concomitant) × 100)
```

openFDA `patient.drug[].drugcharacterization`：1 = Suspect、2 = Concomitant、3 = Interacting。
openFDA 不提供 FAERS ASCII 的 `role_cod`，**無法區分 PS／SS**。

### 9.2 抽樣

- 查詢＝`_drugTok(name) AND patient.reaction.reactionmeddrapt:"reaction"`（與 ROR 的 `a` 相同）＋`limit=100&sort=receivedate:desc`。
- `receivedate` 為 FDA **首次**收到通報的日期 → 「最近通報抽樣」，**非隨機**；顯示抽樣期間（全部抽樣通報的最早～最晚合法日期）。
- 不做重複通報（case 版本、跨廠商）去重。

### 9.3 條目辨識（每個 `patient.drug[]` 條目，依序判定）

記號：`tokens` = 大寫、非英數轉空白後切分；SALTS = 有限鹽類／水合清單
（HYDROCHLORIDE, HCL, SODIUM, POTASSIUM, CALCIUM, MAGNESIUM, SULFATE, PHOSPHATE, ACETATE, MALEATE, MESYLATE, TARTRATE, CITRATE,
SUCCINATE, FUMARATE, BESYLATE, BROMIDE, CHLORIDE, HYDROBROMIDE, DIHYDRATE, MONOHYDRATE, ANHYDROUS）。
每列決定一次正規化模式：查詢名去鹽後仍有字 → STRIP（比對主成分）；否則（如 POTASSIUM CHLORIDE）→ FULL（比對完整名稱）。
STRIP 模式下去鹽後為空的元素保留完整名稱，不刪除。

| # | 條件 | 分類 |
|---|---|---|
| 1 | generic／brand／medicinalproduct 皆不含查詢主成分（以完整 token 為單位） | 無關 |
| 2 | 無 `openfda.generic_name` | **成分無法確認**（名稱相等≠單方） |
| 3 | 任一 generic_name 含 AND／WITH／+／逗號／字母間斜線 | 複方 |
| 4 | generic_name 去鹽後主成分不只一種 | 複方 |
| 5 | 每個 generic_name 去鹽後皆等於查詢主成分 | **目標藥** |
| 6 | 某 brand_name 等於查詢（商品名查詢） | **目標藥** |
| 7 | 其餘（如 INSULIN → INSULIN GLARGINE） | 成分無法確認 |

`openfda.generic_name` 是該條目對到之**所有仿單的聯集**（例：`["VANCOMYCIN HYDROCHLORIDE","VANCOMYCIN"]`），
不是成分清單，故以「去鹽後主成分集合」判斷複方，而非陣列長度（以長度判斷會把 82/100 筆 Vancomycin 誤判為複方）。

### 9.4 通報分類（每份通報恰一類）

1. 有目標藥條目 → 取其中有效角色（字串 "1"/"2"/"3" 或數字 1/2/3）的最高優先者 **Suspect > Interacting > Concomitant**；
   皆無效 → 角色無效（排除）。同報的複方／無法確認條目不影響。
2. 無目標藥、有複方 → 複方（排除）
3. 無目標藥／複方、有無法確認 → 成分無法確認（排除）
4. 其餘（含結構異常）→ 未對應（排除）

有效分母＝Suspect＋Interacting＋Concomitant；為 0 時不計算比例（顯示「資料不足」）；1–9 標示「樣本少」。

### 9.5 API 與失敗處理

| 情況 | 重試 | 結果 |
|---|---|---|
| 網路錯誤、逾時（Pages 每次 60 s）、429、5xx | 2 s 後 1 次（整次操作最多 2 次） | 錯誤＋重試鈕 |
| 404 且 `NOT_FOUND`，或 200 且 `results=[]` | 否 | 查無通報（資料不足） |
| 其他非 200、200 格式異常、回應 > 40 MB | 否 | 錯誤（不截斷計算、不顯示 0%） |

- 錯誤不快取；錯誤訊息不含 API key 或請求 URL。
- GAS 版前端等待上限 150 s：只結束前端等待並讓下一列開始，**無法中止已送出的伺服器端執行**（仍佔配額）。
- 一次只跑一個比例請求，前一個結束後間隔 1.8 s（無 key）／0.3 s（有 key）才開始下一個。

### 9.6 已知限制

- Suspect／Interacting 是通報者判定，非因果；受 notoriety bias、通報習慣、適應症與用藥情境影響。
- 不可用兩藥比例差（如 89% vs 70%）判定相對致病機率；藥物角色為通報層級，同報多 ADR 時不針對單一 ADR。
- **保守漏配**：SALTS 以外的酯類／鹽類（如 ESTRADIOL VALERATE、LITHIUM CARBONATE）與缺協調學名的紀錄會被排除，分母因此變小；
  實測 Carbamazepine／Vancomycin × SJS／TEN 四組中排除 0–1 筆（2026-11-17）。
- 回應量大（實測未壓縮 12–31 MB／100 筆），醫院網路下可能需數秒至數十秒。
