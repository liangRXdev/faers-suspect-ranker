# 驗收紀錄：疑似藥比例（plan v0.3）

- 分支：feat/suspect-proportion（base bdf4360）
- 日期：2026-11-17
- 狀態：自動化 A/B/C/D、live E1、Pages 手動驗收完成；PR #2 已 merge（559ed74），Pages 2.4.0 上線；**G0 功能性通過，精確冷請求耗時未量測**（見文末）

## 自動化測試

`node --test tests/*.test.js` → **74 pass / 0 fail**（既有 32 + 新增 42）

| 檔案 | 驗收條件 | 案例 |
|---|---|---|
| tests/suspect-compute.test.js | A1–A15（兩端各自對人工預期，再逐欄比對） | 15 |
| tests/suspect-transport.test.js | B1–B9＋兩端回應判定一致 | 16 |
| tests/analyze-golden.test.js | C2、C3（golden 由 bdf4360 原始碼產生，6 情境） | 4 |
| tests/sp-loader.test.js | D1、D2、D3（值）、D5、D6、D7（vm 載入 HTML 實際區塊） | 7 |
| 既有 engine / interpretation / autocomplete | C1、C4 | 32（未修改斷言） |

### 變異測試（兩端同步注入同一錯誤，避免「兩端比對」本身就讓測試轉紅）

| 範圍 | 變異數 | 抓到 | 存活與處理 |
|---|---|---|---|
| A 計算（Code.gs＋app.js 共用純函式） | 16 | 16 | 首輪存活「combo 不檢查 +」→ 補 generic 內 `+`、`/`、`,`、`WITH`、數字斜線案例；「去鹽空結果刪除」為等價變異，改測真正危險的「濾掉只剩鹽類元素」 |
| B 傳輸（Pages / GAS） | 19 | 19 | 首輪存活「GAS 外層 catch 外洩例外訊息」→ B8 測試原本在 fetch 就失敗、沒走到外層 catch，已修正並斷言確實走到 |
| C2 回歸 | 3 | 3 | 首輪存活「GAS 排序不沉底時序排除」→ 新增「時序排除者與零分藥同分」情境（從 bdf4360 重產 golden） |
| D controller（兩份 HTML） | 13 | 11 | 存活 2 個皆為等價變異：token 檢查（同 key 只在已 settle 的 error 後可重送，無法並存）、lowSample 寬鬆（後端只回布林）；後者仍補斷言 |

## E1 live（2026-11-17，openFDA 無 key，`LIVE=1 node --test tests/live/suspect.live.test.js`）

| 藥品 × 症狀 | sampled | valid | S | I | C | 排除 | pct | 期間（receivedate） | 回應位元組 | 耗時 |
|---|---|---|---|---|---|---|---|---|---|---|
| CARBAMAZEPINE × SJS | 100 | 100 | 87 | 2 | 11 | 0 | 89% | 2024-03-11～2026-09-28 | 15,293,270 | 3.3 s |
| CARBAMAZEPINE × TEN | 100 | 100 | 89 | 1 | 10 | 0 | 90% | 2023-10-29～2026-09-28 | 12,022,790 | 1.4 s |
| VANCOMYCIN × SJS | 100 | 99 | 70 | 0 | 29 | ambiguous 1 | 71% | 2023-11-03～2026-09-30 | 16,745,441 | 1.6 s |
| VANCOMYCIN × TEN | 100 | 99 | 60 | 5 | 34 | ambiguous 1 | 66% | 2024-04-26～2026-09-30 | **31,406,620** | 2.4 s |

- A11 不變式、`sampled ≤ 100`、`valid ≥ 1` 皆成立；第二次呼叫 0 次 HTTP（記憶體快取）。
- 受驗引擎摘要與「同一 URL 重新抓取＋同一分類函式重算」七類計數完全一致（recountSame=true）。
- 參考網站 89%／70% 不作為斷言；本次 CARBAMAZEPINE×SJS 89%、VANCOMYCIN×SJS 71%（1 筆無協調學名的紀錄依規則排除）。
- **VANCOMYCIN×TEN 回應 31.4 MB**，已達 SP_MAX_BYTES（40 MB）的 78%，且接近 GAS UrlFetchApp 50 MB 上限 → G0 以此組作為最大回應測試。

### 人工稽核（主持人逐筆核對；稽核表：`.ai-review/live-audit/*.json`）

每組核對 ≥20 筆，含全部非 S/I/C、全部角色衝突、全部 Interacting、全部同報多筆目標條目的通報：

- 所有 target 條目皆經 D3 #5（generic_name 去鹽後與查詢主成分完全相等），無商品名或自由文字誤確認。
- 角色衝突：25080764、23287599（同報 Vancomycin 1＋2）→ suspect，符合 1>3>2。
- 同報重複：例 27137878（Vancomycin 19 筆角色 2）→ concomitant 恰計 1。
- ambiguous 3 筆：23600604 `Vancomycin (1,000 and 1,250 mg)`、25187800 `Vancomycin for Injection` ×2（皆無 openfda.generic_name）→ 依 D3 #2 保守排除，符合規格。
- Interacting 8 筆（CBZ 3、VAN 5）皆為 target＋角色 "3"。
- 未發現誤分類。live 樣本未出現 combo、名稱相近的不同成分等反例類別，**不宣稱已以 live 驗證**，由 A9 fixture 覆蓋。

## 手動驗收

### Pages 版（本機靜態伺服器＋Chrome，2026-11-17，實際打 openFDA）

| 條件 | 結果 |
|---|---|
| D7 表格欄位 | 12 欄，「疑似藥比例」為最後一欄；頁尾 v2.4.0 |
| D2 四態（實際點擊） | 不存在藥名 → 資料不足（empty，細項註明查無通報）；CARBAMAZEPINE → `89% (n=100)`；VANCOMYCIN → `71% (n=99)`；排隊中／載入中有顯示；模擬限速 → 錯誤文字＋重試鈕 |
| D3 實際 DOM | 兩列細項各自正確；藥名 `<img src=x onerror=…>` 只顯示為文字（0 個 img、未執行）；valid=2 顯示「50% (n=2)」＋「樣本少」 |
| D4 桌機（卡片 756px） | 所有新按鈕 44px 高；錯誤文字換行（欄寬 157px）；細項 2 欄網格可讀 |
| D4 375px（同源 iframe 模擬，視窗縮放對擴充功能無效） | 頁面本身無橫向溢出；表格在 296px 可視區內橫捲（原本 11 欄就已超寬 748>716，非本次造成）；細項內容 sticky 固定於可視區（左右 31–318px），表格捲到最右仍可直接閱讀；按鈕 49×44、74×44 |
| 無 alert | 錯誤路徑全為 inline |

驗收中修正（皆屬視覺，不涉計算）：
1. 新欄位原插在「因果評估」前，把既有按鈕再往右推 120px → 改為最後一欄，取消 `min-width`。
2. 錯誤訊息被 `nowrap` 撐到 205px → 允許換行（9rem）。
3. 375px 下細項跨整表寬（704px）需橫捲閱讀 → 細項內容 `position:sticky; left` 並限寬於可視區。

截圖：`C:\Users\liang\AppData\Local\Temp\claude-chrome-screenshots-qAj80z\`（暫存，未入 repo）

### GAS 版實機（Web App，使用者部署之 v2.4.0，2026-11-17，有 API Key）

| 條件 | 結果 |
|---|---|
| G0 最大回應 VANCOMYCIN×TEN（Pages 實測 31.4 MB） | **通過（功能性）**：經 google.script.run 完成並回 66% (n=99)，未觸發 150s watchdog、無配額錯誤 |
| G0 CARBAMAZEPINE×TEN | 90% (n=100) |
| 與 Pages live 一致性 | VANCOMYCIN×TEN 細項逐欄相同：sampled 100、valid 99、S60／I5／C34、成分無法確認 1、期間 2024-04-26～2026-09-30 |
| D6/D7 GAS 版（Web App 桌機） | 表格最後一欄「疑似藥比例」；排隊→載入→完成；細項展開正常；頁尾 v2.4.0 |

**未完成／限制（明列）**：
- **精確冷請求耗時未量測**：未確認該次是否為冷快取（CacheService 1h），只能確定在 150s 內完成。若需數字，於 GAS 編輯器執行暫時性 `g0Feasibility()`（先 `cache.remove` 再計時）。
- 載入期間 Chrome 擴充功能截圖連續 3 次逾時（renderer 無回應約 1.5 分鐘），使用者確認頁面本身正常可操作；推測為分頁在背景時截圖受阻，未重現、未歸因於程式。
- GAS 版錯誤／重試路徑與 sidebar（420px）寬度未實機測試（錯誤路徑由 B7、D6 自動化測試覆蓋）。

## 後續：結果表免橫向捲動（2026-11-17，使用者要求）

- 方案（使用者選定）：桌機版面上限 780→1000px；視窗 <1000px 時每顆藥改直式卡片（欄名取自 `data-label`，「#」顯示為「排名」）。欄位、數值與順序不變，未動任何計算。
- 實測（Pages，本機 Chrome，同源 iframe 固定寬度）：
  - 1040px：表格 936px＝可用寬度 936px，無橫捲；細項正常
  - 375px：卡片 296px＝可用寬度，無橫捲、整頁無溢出；時序標籤與說明同列靠右；細項接在卡片下方、可讀
  - 首次將切換點設 720px 時，934px 視窗下表格 897 > 855 仍需橫捲 → 改 1000px
- GAS sidebar（420px）會套用卡片版面（同一 CSS），未實機截圖。
