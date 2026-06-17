# FAERS ADR Ranker（教學版）

> 從 FAERS 開放資料反向查詢多重用藥的**嫌疑藥排序**：
> 反向查詢（症狀 → 藥）＋ ROR/PRR 不相稱性分析 ＋ 本地時序加權，
> 並可對單一藥品進行 Naranjo / WHO-UMC 因果評分。

> ## ⚠️ 僅供教學 / 練習用途
> 本工具**不是醫療器材，不是診斷工具，不得用於任何臨床決策**。
> 訊號偵測 ≠ 因果。使用前**務必閱讀** [DISCLAIMER.md](./DISCLAIMER.md)。

---

## 這是什麼

多重用藥情境下，當病人出現某不良反應，藥師需逐一比對「哪一顆藥最可能是元兇」。
傳統「藥 → 症狀」查詢無法直接回答。本工具改用 **症狀 → 藥** 的反向查詢，
對病人用藥清單中的每顆藥計算不相稱性與時序合理性，輸出嫌疑藥排名。

技術上僅依賴單一 OpenFDA endpoint（`/drug/event.json`）。提供兩種部署：
**GitHub Pages 純前端版**（瀏覽器直接查詢，零後端）或 **Google Apps Script（GAS）版**。

### 臨床動機：先問「這是不是處方瀑布」

老年與多重用藥族群的 ADR 常以「跌倒、混亂、水腫、便秘」等**像老化的症狀**呈現，
易被當成新疾病而再加一顆藥，形成**處方瀑布（prescribing cascade）**。
看到新症狀時，Rochon & Gurwitz（*Lancet* 2017）建議先問三件事：

1. 這個新症狀，**是不是前一個藥的不良反應**？（而不是急著加藥）
2. 引發的「起始藥」**真的還需要嗎**？能否換更安全替代或減量？
3. 繼續用起始藥的**利弊**為何？與病人共享決策。

本工具把第 1 問操作化：用 **症狀 → 藥** 的反向查詢，對清單中每顆藥同時看
「群體不相稱性訊號」與「個案時序合理性」，協助把可疑的起始藥排到前面——
**作為討論起點，不是因果定論**。

## 功能

- **反向查詢**：以症狀（MedDRA PT）為條件，對每顆藥取 2×2 列聯表
- **不相稱性**：ROR（含 95% CI）、PRR、Yates χ²，Haldane-Anscombe 零格校正
- **訊號判定**：a≥3 且（ROR 下界 > 1）或（PRR≥2 且 χ²≥4）
- **時序加權**：依潛伏期分帶；停藥後發生（dechallenge）再乘衰減
- **可拖曳時序軸**：甘特式視覺化各藥用藥區間 vs 症狀發生日
- **個案因果評分**：Naranjo + WHO-UMC，並以時序資料智慧預填
- **症狀輸入**：少量範例 PT + **OpenFDA 即時動態建議**（不內嵌完整 MedDRA 清單）

## 架構

```
┌─ Index.html ──────────────┐      ┌─ Code.gs (GAS) ───────────────┐
│ 前端 (vanilla JS + BS5)   │  ←→  │ analyzeADR() 主進入點          │
│ · PT 搜尋 / 動態建議       │      │ · _stats()  ROR/PRR/χ²         │
│ · 可拖曳時序軸             │      │ · _temporal() 時序+dechallenge │
│ · Naranjo/WHO-UMC 面板     │      │ · CacheService 快取 + 節流     │
└───────────────────────────┘      │ · PropertiesService 存 API key │
                                    └────────────────────────────────┘
                                                  │ 單一 endpoint
                                                  ▼
                                    api.fda.gov/drug/event.json
```

> 純前端版為等價鏡像：`docs/app.js` 取代 `Code.gs`（以 `fetch` + 記憶體快取 + `localStorage`
> 取代 `UrlFetchApp` + `CacheService` + `PropertiesService`），`docs/index.html` 為 UI。

## 部署方式（二選一）

兩種模式共用同一套統計與時序邏輯，差別只在「查詢由誰送出」與「API Key 存哪」：

| | GitHub Pages（純前端） | Google Apps Script（GAS） |
|---|---|---|
| 後端 | 無，瀏覽器直接打 OpenFDA | GAS Web App |
| 程式 | `docs/index.html` + `docs/app.js` | `Code.gs` + `Index.html` |
| API Key | 瀏覽器 `localStorage`（本機，使用者自備） | `PropertiesService`（伺服器端） |
| 適用 | 教學展示、快速試用、零維運 | 機構內部署、集中管理 Key |

> ⚠ 無 bundler，故統計數學在兩端各有一份。**改任一端的公式或閾值，另一端須同步改**
> （`Code.gs` ↔ `docs/app.js`），並更新 `docs/methodology.md`。

### A. GitHub Pages 靜態部署

1. Fork / clone 本 repo。
2. Settings → Pages → Source 選 **Deploy from a branch**，branch = `main`、資料夾 = **`/docs`**，存檔。
3. 數分鐘後造訪 `https://<你的帳號>.github.io/<repo>/`。
4. （選用）在介面「API Key 設定」貼上免費 [OpenFDA key](https://open.fda.gov/apis/authentication/)，
   僅存於你的瀏覽器 localStorage，不上傳任何第三方。

> 本機預覽：`cd docs && python -m http.server` 後開 `http://localhost:8000`
> （需透過 HTTP 而非 `file://`，否則 `fetch` 會被 CORS 擋）。

### B. 部署（Google Apps Script）

1. 建立新的 GAS 專案，新增兩個檔：
   - `Code.gs`（貼上本 repo 的 `Code.gs`）
   - `Index.html`（檔名須為 **`Index`**，對應 `createTemplateFromFile('Index')`）
2. （選用但建議）取得免費 [OpenFDA API key](https://open.fda.gov/apis/authentication/)，
   於工具介面的「API Key 設定」儲存，或在「專案設定 → 指令碼屬性」新增 `OPENFDA_API_KEY`。
   無 key 限速 40 req/min，有 key 240 req/min。
3. 「部署 → 新增部署作業 → 網頁應用程式」。
4. **每次改碼後，需重新部署為「新版本」**（僅存檔不會更新線上版本）。

## 使用

1. 輸入觀察到的不良反應（英文 MedDRA PT；可用動態建議協助）與發生日期。
2. 逐筆輸入病人用藥（藥名、起始日、停用日 / 仍在用）。
3. 執行分析 → 取得嫌疑藥排序。
4. 點任一藥的「評分」→ 進行 Naranjo / WHO-UMC 因果評估。

## MedDRA 授權須知

本 repo **刻意不內嵌完整 MedDRA PT 清單**（`Index.html` 內 `PT_DB` 僅含範例），
因 MedDRA 術語受 MSSO 授權。你有兩個選擇：

- **完全依賴 OpenFDA 動態建議**（FAERS reaction 詞彙本身公開），不需本地清單；或
- 取得 MedDRA 授權後，自行擴充 `PT_DB` 陣列（建議放在不公開的分支或私有部署）。

## 限制與正確判讀

請見 [DISCLAIMER.md](./DISCLAIMER.md) 與 [docs/methodology.md](./docs/methodology.md)。
核心原則：**訊號 ≠ 因果、FAERS 無分母、時序加權為啟發式**。

## 授權

- 程式碼：**MIT License**（見 [LICENSE](./LICENSE)）。
  若你偏好含專利條款的授權，可改用 Apache-2.0。
- 第三方資料（OpenFDA / MedDRA / Naranjo / WHO-UMC）授權見 DISCLAIMER。

## 貢獻

歡迎 issue / PR。提交前請閱讀 [CLAUDE.md](./CLAUDE.md)（專案規則，亦供 AI 協作工具參考），
並確認**未提交任何 API key、PII 或完整 MedDRA 清單**。
