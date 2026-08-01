# 台指期行為訓練遊戲

自用投資行為訓練工具。規格見 `docs/SPEC.md`（唯一真相源）；跨 agent 交接看 `HANDOFF.md` / `AGENTS.md`。

## 怎麼玩

零建置、零 npm。用 ES modules（`<script type="module">`），直接開 `index.html` 在多數瀏覽器會因為
`fetch()`/module CORS 限制而失敗，請先起一個最簡單的靜態伺服器：

```bash
python tools/serve.py        # 預設 port 8000
# 或
python -m http.server 8000
```

然後瀏覽器開 `http://localhost:8000/`。目標環境是 Windows + Chrome/Edge（File System Access API 儲存戰報
需要 Chromium 系瀏覽器；其他瀏覽器會自動改成觸發檔案下載，見 `docs/SPEC.md` §7）。

## 目錄

```
index.html            入口頁面
src/ui/                M5 遊戲 UI（本檔案負責的範圍）
src/game/               遊戲會話狀態機（M4）
src/behavior/            開局計畫／矛盾偵測／違背比對／行為分（M4）
src/engine/               生成日內引擎（M2）
src/margin/                保證金引擎（M3）
data/                  靜態資料（日K／籌碼／總經／事件卡）
vendor/                第三方靜態資源（lightweight-charts，見 vendor/README.md）
styles/                CSS
tools/                 開發期資料管線（Python，不隨遊戲執行）；serve.py 是唯一遊戲執行期會用到的
reports/               戰報輸出（.gitignore，執行期產生）
```
