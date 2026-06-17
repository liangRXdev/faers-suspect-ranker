# ⚠️ DISCLAIMER — 免責聲明

> **English summary:** This software is provided for **EDUCATIONAL AND TRAINING
> PURPOSES ONLY**. It is **NOT** a medical device, **NOT** a diagnostic tool,
> and **MUST NOT** be used to make, support, or replace any clinical decision.
> No warranty of any kind. Use at your own risk.

---

## 本工具的定位

本專案是一個**教學與練習用**的展示工具，目的在於說明：

- FAERS / OpenFDA 開放資料如何用於**藥物不良反應（ADR）訊號偵測**；
- 不相稱性分析（ROR / PRR）的計算與判讀；
- Naranjo / WHO-UMC 等因果評估量表的操作邏輯。

它的存在是為了**學習藥物安全方法學**，不是為了在真實病人身上做決策。

## 明確的「不是什麼」

本工具**不是**以下任何一種：

- ❌ 醫療器材（medical device）
- ❌ 臨床決策支援系統（CDSS）
- ❌ 診斷工具
- ❌ 因果關係的最終裁定者
- ❌ 取代藥師、醫師或藥物安全專責人員專業判斷的依據

## 方法學上的根本限制（使用前必讀）

| 限制 | 說明 |
|---|---|
| **訊號 ≠ 因果** | ROR / PRR 是不相稱性「訊號」，無法證明因果關係 |
| **無分母** | FAERS 為自願通報，無暴露人數分母，**不能計算發生率或風險** |
| **通報偏差** | 存在 notoriety bias、Weber effect、適應症混淆、重複通報等系統性偏差 |
| **資料延遲** | FAERS 季更，資料約落後 3 個月以上 |
| **時序加權為啟發式** | 潛伏期帶與停藥衰減係數為簡化假設，未納入個別藥物藥動學 |
| **量表為輔助** | Naranjo / WHO-UMC 結果取決於輸入品質，且本工具題目為精簡改寫版 |

## 責任歸屬

- 本軟體依 **MIT License** 以「**現狀（AS IS）**」提供，**不附任何明示或默示擔保**，
  包括但不限於適售性、特定用途適用性。
- 對於因使用或無法使用本軟體所導致的任何直接、間接、附帶或衍生損害，
  作者與貢獻者**不負任何責任**。
- 使用者須自行確認其使用方式符合所在地之法規、機構政策與專業倫理。

## 第三方資料與授權

- **OpenFDA / FAERS**：美國 FDA 公開資料，使用須遵守
  [openFDA Terms of Service](https://open.fda.gov/terms/)。資料「現狀」提供，FDA 不保證其正確性。
- **MedDRA®**：為 IFPMA 代表 ICH 之註冊商標，由 MSSO 維護。
  PT 術語清單受授權保護；本 repo **不內含**完整 MedDRA 清單，僅含少量範例。
  正式使用請自行取得 MedDRA 授權。
- **Naranjo Scale**、**WHO-UMC system**：為已發表之標準量表，本工具以自行精簡之
  中文版實作，計分與分級依原始文獻；正式文件請對照原文。

---

**若你不同意上述任一條款，請勿使用本軟體。**
**使用本軟體即表示你已閱讀、理解並接受本免責聲明。**
