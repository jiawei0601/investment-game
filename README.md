# 台指期行為訓練遊戲

以真實台指期貨日 K 資料為基礎的投資行為訓練工具。玩家需要先寫下作戰計畫，再在大台（TX）、小台（MTX）與微台（TMF）之間做交易；系統會依照保證金、交易成本、追繳、強平、轉倉與行為違背記錄結果。

這不是即時行情或投資建議。遊戲的目的，是讓玩家在可重播、可複盤的歷史行情中練習風險控制與交易紀律。

## 目前功能

- 2010 年起的台指期近月連續日 K 資料。
- 日 K 對應的確定性日內 5 分 K 回放；相同關卡、attempt 與指令會產生相同路徑。
- 大台 TX、小台 MTX、微台 TMF，分別計算乘數、保證金、手續費與期交稅。
- 四個固定劇本：疫情、熊市、平淡、閃崩。
- 無限模式：以種子抽取起點，自訂遊玩長度。
- 馬賽克模式：隨機起點，先保留一段真實暖示，再從其他歷史月份按市場體制拼接行情，降低玩家依記憶猜行情的可能。
- 開局作戰計畫、矛盾警告、論點強制輸入與五類行為違背判定。
- 播放／暫停與 0.5、1、2、5、10 根 K 棒／秒的播放速率；遇到追繳、強平、轉倉或 Modal 會自動暫停。
- K 線圖水平價位線：可點擊 K 線帶入價格、建立多條標線並刪除。
- 結算後產生 Markdown 戰報與 `profile.json`；支援 File System Access API，其他環境使用下載回退。
- 劇本模式顯示事件卡；馬賽克模式刻意隱藏事件卡與籌碼副圖。

## 快速開始

本專案是零建置的靜態網頁，不需要 npm 或 bundler。不要直接用 `file://` 開啟 `index.html`，因為 ES module 與 `fetch()` 會受到瀏覽器的跨來源限制。

### Windows PowerShell

需要 Python 3。使用 Windows Python Launcher 時：

```powershell
cd C:\CLAUDE\investment-game
py -3 tools\serve.py 8000
```

如果 `python` 已加入 PATH，也可以使用：

```powershell
python tools\serve.py 8000
```

接著開啟 <http://localhost:8000/>。若 8000 已被占用，可改用其他埠，例如：

```powershell
py -3 tools\serve.py 8123
```

### macOS／Linux

```bash
python3 tools/serve.py 8000
```

伺服器會停用快取，修改 HTML、JavaScript 或 CSS 後重新整理即可看到最新內容。按 `Ctrl+C` 停止伺服器。

## 遊戲流程

1. 選擇劇本、無限模式或馬賽克模式。
2. 輸入起始資金，填寫六欄位作戰計畫。
3. 若計畫出現矛盾，閱讀三位交易大師的提醒，選擇修改或記錄「堅持原計畫」。
4. 進入遊戲後，開新倉或反手交易必須填寫論點；可選擇市價單、停損單或限價單。
5. 使用「下一天」逐日推進，或按「播放」自動推進。播放中的「下一天」會先暫停，再推進一天。
6. 在 K 線圖上點擊價格可帶入水平線輸入框；標線只作交易記號，不會改變成交或強平邏輯。
7. 追繳、強平、結算日轉倉等重要事件會自動暫停播放，讓玩家先處理狀況。
8. 結束遊戲後保存戰報；未完成的局不會寫入跨局 `profile.json` 紀錄。

## 劇本與資料範圍

| 模式 | 行情來源 | 特色 |
| --- | --- | --- |
| 疫情 | 2020-01 ～ 2020-06 | 崩盤中的槓桿存活 |
| 熊市 | 2022-01 ～ 2022-10 | 無明確底部的陰跌與凹單 |
| 平淡 | 2017-03 ～ 2017-08 | 低波動與交易成本控制 |
| 閃崩 | 2024-05 ～ 2024-10 | 2024-08-05 大跌與隔夜風險 |
| 無限模式 | 真實資料隨機起點 | 自訂遊玩長度 |
| 馬賽克模式 | 真實月份重新抽樣、縮放與拼接 | 避免用歷史記憶預測下一段 |

## 真實資料與已知限制

- `data/daily/TX.json` 是遊戲目前使用的台指期近月連續日 K 資料；實際最後日期以資料檔為準。
- `data/chips.json` 的免費歷史資料從 2018-06-05 起；更早的 TAIFEX 三大法人資料需要付費申購，因此更早日期不顯示籌碼副圖。
- `data/macro.json` 是月頻總經資料，主要供資料與研究層使用；目前遊戲 UI 不把基本面作為交易提示。
- 事件卡必須通過黑名單掃描與複審流程；事件卡只在可用月份顯示，不能當作未來行情的預知資訊。
- `TX.json` 目前可能沒有 `settle` 欄位；遊戲層會以當日 `close` 作為回退值並留下 warning。官方結算價回填資料仍需另外審核後再套用。
- 日內 K 棒是以當日 OHLC 的條件分佈生成，不是官方逐筆成交資料；日內回放仍精確錨定當日開、高、低、收。
- File System Access API 需要 Chromium 系瀏覽器與安全來源（`localhost` 或 HTTPS）。不符合條件時，遊戲會提供檔案下載回退。

## 測試

目前測試使用 Node.js 內建 test runner，不需要安裝 npm 套件。Windows PowerShell 可執行：

```powershell
$testFiles = Get-ChildItem -LiteralPath tests -Filter '*.test.js' | ForEach-Object { $_.FullName }
node --test $testFiles
```

macOS／Linux 或 bash：

```bash
node --test tests/*.test.js
```

UI JavaScript 語法檢查：

```bash
node --check src/ui/app.js
node --check src/ui/modal.js
```

完整回歸測試涵蓋日內生成、保證金、遊戲會話、行為判定、馬賽克、戰報與存檔邏輯。測試會掃描完整日 K 資料集，執行時間可能比一般單元測試長。

## 目錄

```text
index.html              靜態網頁入口
src/ui/                 UI 控制器、圖表、播放、水平價位線與存檔
src/game/               遊戲會話與逐日／逐 knot 時序
src/behavior/           作戰計畫、矛盾偵測、違背判定與行為分
src/engine/             日 K 到日內 K 的確定性生成引擎
src/margin/             TX／MTX／TMF 保證金與交易會計
src/mosaic/             馬賽克模式的歷史月份抽樣與拼接
src/report/             Markdown 戰報與玩家檔案組裝
data/                   日 K、籌碼、總經與事件卡資料
vendor/                 lightweight-charts 靜態資源
styles/                 UI 樣式
tools/                  資料管線、驗證工具與 Python 靜態伺服器
reports/                執行期戰報輸出目錄
```

## 靜態部署

本專案沒有建置步驟，只要把 repo 根目錄作為靜態網站根目錄即可部署到 GitHub Pages 或其他靜態主機。部署後請確認 `data/`、`src/`、`vendor/` 與 `styles/` 一起上線，且網站使用 HTTPS；不要把 `index.html` 放在子目錄後卻改變相對路徑。

## 相關文件

- `docs/SPEC.md`：遊戲規格與驗收條件，唯一真相源。
- `HANDOFF.md`：目前進度、已知限制與交接資訊。
- `AGENTS.md`：跨 agent 工作規則。
- `tools/README.md`：資料來源、schema、抓取與驗證說明。
- `vendor/README.md`：lightweight-charts 版本與來源。
