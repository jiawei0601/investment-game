# vendor/ — third-party static assets

零建置專案（AGENTS.md）：第三方 JS 一律下載成單檔放這裡，用 `<script type="module">` 直接 import，不走 npm/bundler。

## lightweight-charts.4.1.3.standalone.production.mjs

- **套件**：[TradingView lightweight-charts](https://github.com/tradingview/lightweight-charts)
- **版本**：`4.1.3`
- **來源**：`https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.mjs`
  （官方發布的 "standalone" ESM build，所有依賴已打包進單一檔案，`import { createChart } from '...'` 即可用，不需要
  額外的 module resolution/bundler。與非 `standalone` 版本的差異：`standalone` 版把 `fancy-canvas` 等內部依賴一起
  打包進來，一般（非 standalone）版仍需要 import map 解析裸模組名稱，在零建置環境下會直接失敗。）
- **授權**：Apache License 2.0（檔案內建授權標頭）
- **用途**：`src/ui/chart.js` 是唯一 import 這個檔案的地方（日K主圖／日內回放圖／結算權益曲線圖共用同一份）。

版本升級：直接重新下載對應版本號的同一個檔名模式（`lightweight-charts.<version>.standalone.production.mjs`），
更新 `src/ui/chart.js` 的 import 路徑，並更新本檔的版本號記錄。
