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

> 本工具的量表題目為**自行精簡之中文版**，計分與分級依原始文獻；
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
