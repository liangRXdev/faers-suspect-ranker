# 規格審查判定（plan v0.1 → v0.2）

- 日期：2026-11-17；對象：`.ai-review/plan-review.md`（Codex thread 01a1e8c7）
- 統計：**接受 37／部分接受 9／拒絕 1（範圍蔓延 1）**，共 47 項

## 主持人實證（判定依據）

收緊辨識規則原型以 §4 同一批 live 樣本重跑（scratchpad 原型，非實作）：

| 規則 | CARBAMAZEPINE | VANCOMYCIN |
|---|---|---|
| v0.1 token-phrase | S87/I2/C11，valid 100 | S68/C30/衝突2，valid 100 |
| Codex 建議「generic_name 多元素＝複方」 | — | **combo 82、valid 18（誤判）** |
| v0.2 決策表（主成分集合，見 plan §5 D3） | S87/I2/C11，valid 100，89% | S70/C30，valid 100，70%；ambiguous 0 |

發現：openFDA `openfda.generic_name` 是**該條目對到的所有仿單之聯集**（例：`["VANCOMYCIN HYDROCHLORIDE","VANCOMYCIN"]` 出現 90 次），
不是成分清單。故「多元素即複方」本身是會誤判的規則；正確判準為「去鹽後主成分集合大小」。

## 判定表

| # | 項目 | 嚴重度 | 判定 | 理由 |
|---|------|--------|------|------|
| 1 | 1.1 token-phrase≠同一成分（INSULIN→INSULIN GLARGINE）；A9 允許誤判入分母 | Blocker | 部分接受 | 問題屬實，修法採納（定義「確認單方」證據、ambiguous 排除、A9 不得豁免誤納入）。嚴重度改 High：尚未寫碼，屬資料模型修正非方向錯。其「多元素 generic＝複方」子主張經實測為誤判（見上），改用主成分集合。 |
| 2 | 1.2 D4 欄位分支未封閉 | Medium | 接受 | 改為 D3 決策表，含 brand-only、空陣列、型別錯、generic 與 MP 矛盾。 |
| 3 | 1.3 重繪／換 ADR 後舊結果回寫錯列 | Medium | 接受 | 結果以查詢身分（drug+reaction）歸屬，列只顯示與自身身分相符的狀態；過期請求不得覆蓋較新狀態。 |
| 4 | 1.4 60s 起訖不明 | Medium | 部分接受 | Pages：每次嘗試從送出到 body 解析完成 60s（同一 AbortController）；排隊不計。GAS：不依賴未經本 repo 驗證的 `timeoutSeconds`，改前端 watchdog 150s → error，晚到結果忽略。 |
| 5 | 1.5 錯誤分類不完整 | Medium | 接受 | 補錯誤決策表；元素結構異常的通報計入 sampled 並分類為 unmatched（不靜默刪除）。 |
| 6 | 1.6 API key 可能經錯誤訊息外洩 | Medium | 接受 | 既有威脅模型的驗證；新增 B8 sentinel key 斷言。 |
| 7 | 2.1 GAS 處理 15 MB 未證實可行 | High | 接受 | 新增 G0 可行性門檻（GAS 實機 fetch+parse 實測）與回應大小上限明確失敗；G0 失敗時 GAS 版顯示明確錯誤，交使用者決策，不靜默減量。 |
| 8 | 2.2 快取只存計數無法還原期間 | High | 接受 | 改「只存計算摘要」，摘要含期間（sampled 全體 receivedate 最舊/最新）。 |
| 9 | 2.3 本地比對≠openFDA analyzer；_clean 與快取鍵 | Medium | 接受 | 刪除「可找回同一條目」保證；查詢、比對、快取鍵皆用 `_clean(name)`；快取鍵不做額外正規化。 |
| 10 | 2.4 序列≠節流；GAS 併發 | Medium | 接受 | 單一前端佇列（兩版 HTML 共用同一 controller 區塊），請求與重試間隔 ≥ sleepMs。 |
| 11 | 2.5 平台事實校正 | Low | 接受 | rate limit 註明官方現值、保留既有保守設定；receivedate＝FDA 首次收件日；無 `.github/workflows`。 |
| 12 | A1 角色型別 | Medium | 接受 | 字串、數字、混合。 |
| 13 | A2 0% 完整斷言 | Medium | 接受 | |
| 14 | A3 與 A6 交叉 | Medium | 接受 | |
| 15 | A4 他藥為 1／3 | Medium | 接受 | |
| 16 | A5 跨欄命中去重 | Medium | 接受 | |
| 17 | A6 三角色＋無效混合＋排列 | Medium | 接受 | |
| 18 | A7 布林／物件不得轉型 | Medium | 接受 | |
| 19 | A8 非首元素命中 | Medium | 接受 | |
| 20 | A9 具名反例 | Blocker | 部分接受 | 併入 #1；反例清單採納，但「多元素 generic」的預期依實測改為：同主成分多元素＝target、不同主成分＝combo。 |
| 21 | A10 無 drug／空 drug | Medium | 接受 | |
| 22 | A11 守恆測試假安全 | Medium | 部分接受 | 保留隨機不變式，加「新增他藥不改結果、重複目標不改結果」性質；主驗收力量放具名 fixture（同 4.3）。 |
| 23 | A12 UI n 等於有效計數總和 | Medium | 接受 | |
| 24 | A13 兩端同錯 | Medium | 接受 | 每端先對人工裁決預期，再兩端比對。 |
| 25 | B1 僅 NOT_FOUND 為 empty | Medium | 接受 | |
| 26 | B2 重試間隔與終態 | Medium | 接受 | |
| 27 | B3 body 階段停滯 | Medium | 接受 | |
| 28 | B4 非法 JSON／非陣列／200+error | Medium | 接受 | |
| 29 | B5 快取鍵隔離 reaction | Medium | 接受 | |
| 30 | B6 完整 URL 解析 | Medium | 接受 | |
| 31 | B7 GAS 對應 B1–B4 | Medium | 接受 | |
| 32 | C1 不得 skip/放鬆 | Medium | 接受 | |
| 33 | C2 兩端對照 bdf4360 | Medium | 接受 | 以凍結的 bdf4360 輸出作 golden（測試不依賴 git 執行期）。 |
| 34 | C3 解讀完整不變 | Medium | 接受 | |
| 35 | C4 autocomplete 區塊對照基準 | Low | 拒絕—範圍蔓延 | 本次不動 autocomplete；既有「兩份逐字相同」測試已足，無可觀察後果。 |
| 36 | D1 只查被點列 | Medium | 接受 | 於 controller 層測。 |
| 37 | D2 狀態轉移與 valid 0/1/9/10 | Medium | 接受 | |
| 38 | D3 細項取值正確 | Medium | 部分接受 | 欄值正確性在 controller／格式化純函式層自動測；DOM 呈現手動驗收（repo 無 DOM 測試設施，零依賴原則不引入 jsdom/Playwright）。 |
| 39 | D4 375px 實際點擊 | Medium | 部分接受 | 手動驗收（瀏覽器 375px 截圖）記錄於驗收文件，不自動化。 |
| 40 | D5 loading 中重繪、換 ADR | Medium | 接受 | 同 #3，在 controller 層測。 |
| 41 | D6 兩版各走完整路徑 | Medium | 部分接受 | controller 以注入 transport 測兩版（fetch／google.script.run 包裝）；GAS 實機僅 G0＋一次手動 smoke，需使用者部署。 |
| 42 | E1 live 只驗守恆 | High | 部分接受 | 加人工稽核：每組 live 結果輸出逐筆稽核表（safetyreportid、目標條目原文、角色、分類理由），主持人逐筆核對 ≥20 筆/組並記錄；嚴重度 Medium（驗收程序，不動架構）。 |
| 43 | F1 文件逐項核對 | Low | 接受 | |
| 44 | F2 執行期可見版本 | Low | 接受 | |
| 45 | 4.1 搜尋決定抽樣、本地決定可確認 | Medium | 接受 | 即 v0.2 D3 方向。 |
| 46 | 4.2 最小共同摘要 | Low | 接受 | 即 #8。 |
| 47 | 4.3 具名 fixture 優先 | Low | 部分接受 | 同 #22。 |

---

# 第 2 輪判定（plan v0.2 → v0.3）

- 統計：**接受 43／部分接受 1／拒絕 0**，共 44 項（無 Blocker；High 1）
- 主持人實證：§4 兩組 live 樣本中，僅靠「無 generic_name 條目」才命中目標的通報為 **1/200**（VANCOMYCIN 1、CARBAMAZEPINE 0）。
  據此將缺 generic 路徑整段改為 ambiguous，代價可忽略且刪除 D3 #7–#9、FORMS 清單、括號解析。

| # | 項目 | 嚴重度 | 判定 | 理由 |
|---|------|--------|------|------|
| R2-1 | 1.1 缺 generic 時名稱相等≠單方（JANUMET） | High | 接受 | 採最保守修法：無 generic_name 條目一律 ambiguous；MP 僅用於候選 hit。live 影響 1/200。 |
| R2-2 | 1.2 不去鹽模式與 #3／exact 定義衝突 | Medium | 接受 | 每列先定單一正規化模式（STRIP／FULL），D3 全部比較共用 `moiety()`。 |
| R2-3 | 1.3 去鹽後空結果處理 | Medium | 接受 | 空 moiety 元素以完整 tokens 作集合鍵（不刪除），故必使集合 >1 或 exact 失敗。 |
| R2-4 | 1.4 A11「加他藥不變」與 ambiguous 衝突 | Medium | 接受 | 限定新增條目依 D3 為 none；pct 範圍斷言限 valid>0。 |
| R2-5 | A8/A9 案例輸入與預期不唯一；#1 hit 用 T 致含鹽查詢反向漏配 | Medium | 接受 | 每案列完整三欄、唯一分類；hit 改用 moiety 子序列。 |
| R2-6 | 2.1 錯誤決策表無優先順序／兜底 | Medium | 接受 | 改為依序判定表；整次操作共用 2 次嘗試預算；empty＝sampled 0（含 200＋`results=[]`）。 |
| R2-7 | 2.2 GAS watchdog／server timeout／同時一個 混用 | Medium | 接受 | 分平台寫生命週期；watchdog 後釋放前端佇列，明文「無法取消的 GAS 執行可能仍在跑」。 |
| R2-8 | 2.3 B5 把 in-flight 合併套到 GAS | Medium | 接受 | B5 拆層。 |
| R2-9 | 2.4 `|` 分隔 key 可碰撞 | Medium | 接受 | key＝`JSON.stringify([_clean(drug), _clean(reaction)])`。 |
| R2-10 | 2.5 位元組單位與解析期限 | Medium | 部分接受 | 單位定為解壓後 body 位元組，先檢查再 parse。解析期限：`JSON.parse` 無法中斷，改為 parse 後檢查是否超過期限，超過即 timeout error、不發布摘要。 |
| R2-11 | G0 冷請求、以位元組選最大 | Medium | 接受 | |
| R2-12 | A1 角色 2/3 型別 | Medium | 接受 | |
| R2-13 | A5 各條目僅指定路徑可導出 target | Medium | 接受 | MP 已不能導出 target，改為 generic 路徑與 brand 路徑。 |
| R2-14 | A6 target＋combo/ambiguous 並存 | Medium | 接受 | |
| R2-15 | A8 完整輸入 | Medium | 接受 | |
| R2-16 | A9 完整欄位、唯一分類、JANUMET 反例 | Medium | 接受 | |
| R2-17 | A10 report 本身 null | Medium | 接受 | |
| R2-18 | A11 | Medium | 接受 | 同 R2-4。 |
| R2-19 | A12 明列數值 | Low | 接受 | |
| R2-20 | A13 涵蓋 A14/A15 | Medium | 接受 | |
| R2-21 | A14 合法日曆日期、期間來自非 valid 通報 | Medium | 接受 | |
| R2-22 | B1 完整空摘要＋快取 | Medium | 接受 | |
| R2-23 | B2 5xx／網路／混合序列共用預算 | Medium | 接受 | |
| R2-24 | B3 timeout→200；GAS 改驗 watchdog | Medium | 接受 | |
| R2-25 | B4 與 status 組合 | Medium | 接受 | |
| R2-26 | B5 分層＋queued 去重 | Medium | 接受 | |
| R2-27 | B6 有 key 路徑 | Medium | 接受 | |
| R2-28 | B7 GAS 各自斷言 | Medium | 接受 | |
| R2-29 | B8 不含完整 URL | Medium | 接受 | |
| R2-30 | B9 位元組、多位元組、等於上限 | Medium | 接受 | |
| R2-31 | C1 不弱化斷言 | Low | 接受 | |
| R2-32 | C2 N 納入、並行主分析序列 | Medium | 接受 | |
| R2-33 | D1 多列排程與間隔 | Medium | 接受 | |
| R2-34 | D2 empty vs valid=0 done | Medium | 接受 | |
| R2-35 | D3 手動驗收兩列逐欄 | Medium | 接受 | |
| R2-36 | D4 兩版分別記錄 | Low | 接受 | |
| R2-37 | D5 watchdog 後佇列續行、終態重繪保留 | Medium | 接受 | |
| R2-38 | D6 用實際 HTML transport 包裝 | Medium | 接受 | transport 包裝放入 `<sp-loader>` 區塊內（依 `google.script` 存在與否選擇），vm 測試即測實際程式。 |
| R2-39 | D7 兩版手動點擊完成 | Medium | 接受 | |
| R2-40 | E1 稽核表含全部候選條目、分類來自受驗引擎 | Medium | 接受 | |
| R2-41 | F1 語意核對 | Low | 接受 | |
| R2-42 | 4.1 單一正規化模式 | Medium | 接受 | 同 R2-2。 |
| R2-43 | 4.2 共同契約限摘要與終態 | Medium | 接受 | 同 R2-7。 |
| R2-44 | 4.3 證據不足直接 ambiguous | Medium | 接受 | 同 R2-1。 |

是否重審：v0.3 的變更為**收斂**（刪除 MP 確認路徑、釐清定義、拆平台契約），未引入新元件或新資料流；不重跑第 3 輪。
