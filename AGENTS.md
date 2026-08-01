# AGENTS.md — 專案統一規則（Claude Code 與 Antigravity 共用）

> Claude Code 透過 CLAUDE.md（內含 @AGENTS.md）讀本檔；Antigravity 原生讀本檔。
> 一份規則，兩邊共用，不分叉。

## 專案定位

自用投資行為訓練工具：用真實市場數據模擬「當下的你」——資訊不完整、不可回溯、帶情緒做決定——並診斷「你說的」與「你做的」之間的落差。不是預測訓練器、選股回測器、公開娛樂遊戲。唯一真相源是 `docs/SPEC.md`，任何規則衝突以它為準。

## 專案慣例
- 語言 / 框架：遊戲本體=原生 JS（或極簡框架）＋ [lightweight-charts](https://github.com/tradingview/lightweight-charts)，零後端、無建置步驟，開 `index.html` 即可玩。Python 僅用於開發期資料管線（`tools/`：抓月K、FRED 總經、事件卡生成），不隨遊戲執行。
- 資料慣例：所有遊戲用資料一律靜態 JSON 進 repo（`data/monthly/*.json`、`data/macro.json`、`data/events/*.json`），不即時打外部 API。
- 種子慣例：任何生成式內容（日K、日內視覺層）的隨機性必須來自**純函數種子** `seed = hash(關卡ID, 第幾次玩, 標的, 年月)`。**禁止在遊戲邏輯中直接呼叫 `Date.now()` 或 `Math.random()`**——一律先用種子餵一個確定性 RNG，再從該 RNG 取值。違反此條會直接打破 ADR 0002 的可重現性與 ADR 0003 的 B2 重玩機制。
- 成交判定慣例：買賣、停損、結算**只認日K層**資料。日內視覺層（分鐘級走勢）純顯示、lazy 生成，程式碼層級不得被撮合模組讀取或呼叫（ADR 0002、SPEC §9-5）。
- 風格 / 命名：目前無既定 lint/style 工具，新增時於本節補充，不要各 agent 各自套規則。

## 測試慣例
- M2 生成引擎（布朗橋日K）需具備**統計性質測試**，至少涵蓋：
  - 生成日K的月聚合（月初開盤/月末收盤/月內最高/月內最低）須精確還原對應月K的真實 OHLC。
  - 由生成日K反推的 Parkinson 波動率，與由真實月K H/L 算出的目標波動率，誤差需落在明訂容忍界內。
  - 同一種子重複生成兩次，輸出完全一致（確定性測試）。
- 其餘模組（撮合帳務、矛盾偵測、違背比對）以規則邏輯的單元測試為主，不需統計檢定，但矛盾偵測需覆蓋 SPEC §3 列出的矛盾範例組合。
- 詳細驗收條件見 `docs/backlog/` 各里程碑檔案。

## 修改規格前
- **先讀 `docs/SPEC.md` §9 決策互鎖**，五條任何一條被打破都是連鎖失效（重玩機制、B2 評分、地雷股防呆、無中途存檔、日內視覺層隔離）。不確定是否牴觸互鎖時，先在 `docs/adr/` 新增一條 ADR 記錄權衡，不要直接改 SPEC.md 或默默繞過既有機制。

## 跨 agent 交接紀律
- repo 是唯一真相來源；交接資訊一律寫進 repo，不可只留私有記憶（Claude memory / Antigravity KI）。
- 交出前：測試綠 → commit 乾淨（絕不交髒工作區）→ 更新 HANDOFF.md → 更新 issue。
- 接手前：clean tree + pull → 讀 HANDOFF.md / issue / git log / 本檔 → 先複述現況與下一步再動手。
- 架構決策寫 docs/adr/；任務狀態走 issues。
