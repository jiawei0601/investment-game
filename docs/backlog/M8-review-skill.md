# M8 複盤 skill

## 目標

實作 `/複盤` 指令，讀取 M7 產出的戰報 `.md`，依序（或並行）呼叫三位既有大師 perspective skill（Livermore、謝孟恭、Dalio）給出評語，完成「遊戲本體零 AI、複盤走戰報回 Claude Code」這條路徑的最後一段（SPEC §7、ADR 0005）。

## 依賴

M7（需要戰報 `.md` 格式定案，且需要實際跑出至少一份真實戰報樣本用於開發與測試）。

## 驗收條件

- [ ] `/複盤` skill 可讀取 `reports/` 下指定的戰報 `.md`，並正確解析其 schema（依 M7 產出格式，不臆測欄位）
- [ ] skill 依序或並行呼叫既有三個 perspective skill：Livermore（停損執行／紀律）、謝孟恭（部位管理／凹單／心態）、Dalio（驅動因子分散／賭單一情境），各自針對戰報內容給出評語
- [ ] 三位評語聚焦各自專長領域，需人工抽查至少 3 份實際戰報的輸出，確認評語有具體引用戰報中的違背紀錄，不是泛用套話
- [ ] skill 觸發方式與使用者既有 12 位大師 perspective skill 的慣例一致（YAML frontmatter 含清楚的 when-to-use 觸發描述）
- [ ] 明確排除 Buffett／Graham／Lynch 於此 skill v1 範圍內（因無基本面資料，依 ADR 0005／0006），skill 說明文字需寫清楚這是刻意排除而非遺漏
- [ ] skill 檔案存放於使用者慣用 skill 目錄（`~/.claude/skills/`），存放與命名方式與現有 12 位大師 skill 一致，以利未來擴充第 13、14 位

## 建議派工模型

`sonnet`。此 skill 本質是整合三個既有 perspective skill 的協調層，撰寫方式依循 `write-a-skill` 慣例，不需要重新蒸餾新人格（那是 `nuwa-skill` 的工作），`sonnet` 足以完成骨架與整合邏輯；若評語品質經人工抽查後發現三位大師語氣混淆或評語空泛，再考慮加一輪 `opus` review 調整 prompt，不需要一開始就用高階模型。
