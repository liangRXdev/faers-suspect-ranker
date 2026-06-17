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

## 5. 已知偏差與限制

- FAERS 為自願通報：無分母，**不能計算發生率或風險**。
- Notoriety bias、Weber effect、適應症混淆、重複通報。
- `medicinalproduct` 為自由文本；成分正規化僅部分緩解。
- 資料季更，約落後 3 個月以上。
- 群體訊號（ROR/PRR）與個案因果（Naranjo/WHO-UMC）為**互補**，不可互相取代。
