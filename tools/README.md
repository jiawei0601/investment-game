# tools/ — M1 資料管線

`fetch_m1.py` 抓取 → `validate_m1.py` 驗證。兩支腳本皆可重跑，重跑會整批覆蓋 `data/` 下的
輸出檔（非增量 upsert）。

## 執行

```bash
python tools/fetch_m1.py       # 抓取，寫入 data/daily/TX.json、data/daily/TX-rolls.json、
                                # data/chips.json、data/macro.json、data/_tx_cross_check_report.json
python tools/validate_m1.py    # 驗證，印出摘要，exit code 0=全綠 1=有失敗
```

依賴：`requests`、`certifi`（皆為常見套件，`pip install requests certifi`）。

## 憑證（token）

**絕不寫進本 repo 任何檔案**，一律環境變數或外部 `.env` 讀取（`_finmind_token()` 於
`fetch_m1.py`）。解析順序：

1. 環境變數 `FINMIND_TOKEN`
2. 環境變數 `FINMIND_API_TOKEN`
3. 本 repo 根目錄 `.env` 的 `FINMIND_TOKEN=` 一行（本 repo 目前未建立此檔，供未來使用；
   若建立，記得加進 `.gitignore`）
4. 姊妹專案 `C:\CLAUDE\investing\tw-stock-db\.env` 的 `FINMIND_TOKEN=` 一行（沿用該專案
   既有排程的 token，純讀取不落地本 repo；邏輯比照該專案
   `collectors/macro_tw.py::_finmind_token()`）

皆無則以空 token 呼叫 FinMind——`TaiwanFuturesDaily` 與
`TaiwanFuturesInstitutionalInvestors` 都是 Free 層資料集，無 token 也能查詢完整歷史，
只是速率限制較嚴（實測本管線一次性抓取全歷史約數秒完成，未觸發限流）。

免費層速率限制處理：每次 FinMind 請求 timeout=30 秒，失敗重試最多 2 次（指數退避）；
連續收到 402/429 超過 600 秒會拋 `RateLimitAbort` 中止整支腳本（見 `fetch_m1.py` 的
`_note_rate_limit_hit()`），需人工確認額度後重跑。

## 資料源

| 資料 | 來源 | 說明 |
|---|---|---|
| TX 日K | FinMind `TaiwanFuturesDaily`（data_id=TX，Free） | 只取 `trading_session=="position"`（日盤）；`after_market` 為盤後/夜盤時段（結算價與未沖銷部位皆為 0，不納入，符合 ADR 0007）。 |
| 期貨三大法人籌碼 | FinMind `TaiwanFuturesInstitutionalInvestors`（data_id=TX，Free） | 實測資料起始 2018-06-05（早於此無資料，非本管線缺漏，FinMind 該資料集本身即從此日起提供，**不是** 2010-01 起，已於下方「已知資料缺陷」註明）。 |
| 台灣央行重貼現率 | 中央銀行 OpenData `webF1.csv`（`set_id=6022`，`https://www.cbc.gov.tw/Public/Data/opendata/webF1.csv`，BIG5 編碼，免金鑰） | 原始資料是「調整日誌」（每次利率調整一列），非月頻時序，`fetch_m1.py` 轉成月頻：每月取「月底時已生效」的最新一次調整值（forward-fill）。 |
| 台灣 CPI 年增率 | 行政院主計總處 消費者物價「基本分類指數」XML（`ws.dgbas.gov.tw`，免金鑰） | 篩選 `Item="總指數(指數基期：民國110年=100)"`、`TYPE="年增率(%)"`，官方已算好的年增率直接採用，不重複計算。 |
| 台灣失業率 | 行政院主計總處「人力資源調查失業率」XML（`ws.dgbas.gov.tw`，免金鑰） | 取 `總計_Total_百分比` 欄位（不分性別/年齡/教育程度）。 |
| 美國聯邦基金利率 | FRED `fredgraph.csv?id=FEDFUNDS`（免金鑰） | 月頻，`FEDFUNDS` 為月平均值。 |

### ws.dgbas.gov.tw 憑證鏈問題

`ws.dgbas.gov.tw` 伺服器只送 leaf 憑證、缺中繼 CA（`TWCA Secure SSL Certification
Authority`），瀏覽器/curl 能過是因為作業系統信任庫本身快取了這張中繼憑證，Python
`requests`／`certifi` 的獨立信任庫沒有快取、直接請求會 `SSLCertVerificationError`。
`fetch_m1.py` 的 `_dgbas_verify_bundle()` 會下載該中繼憑證（leaf 憑證 Authority
Information Access 擴充欄位指到的網址）補進 `certifi` 內建信任庫組成暫存合併 bundle，
不使用 `verify=False`。此邏輯與 URL 沿用 `tw-stock-db/collectors/macro_tw.py` 既有實作
（已實測可行）。

## 近月連續拼接規則（釘死，改動前先讀 SPEC.md §1）

對每個交易日 `d`：

1. 算出 `d` 所在月份的結算日 = 該月第三個週三（`third_wednesday(d.year, d.month)`）。
2. 若 `d <= 該月結算日`：前月合約（front month）= 當月合約。
3. 若 `d > 該月結算日`：前月合約 = 下月合約。

即「結算日當天仍用當月合約，次一交易日起切換到下月合約」。`TX.json` 每列的 `contract`
欄位即該日採用的合約月份（`YYYYMM`）。`TX-rolls.json` 記錄每次合約切換的
`{date, from_contract, to_contract, price_gap}`，`price_gap = 新合約當日開盤 - 舊合約前一
交易日收盤`。

**已知限制**：結算日固定假設為「當月第三個週三」，未處理該日恰逢國定假日而順延的極少數
情況（TAIFEX 實際規則是遇假日順延至次一營業日）。交叉檢核（見下）用來抓出這類邊緣案例。

### 交叉檢核

對每個交易日，另外取「當日成交量最大的單一月合約」（排除跨月價差組合，如
`"202401/202402"`）作為對照拼法。兩法不一致的日期記錄進
`data/_tx_cross_check_report.json`（`mismatches` 陣列，含 `reason`：
`volume_max_mismatch` 為不同拼法選到不同合約、`front_month_missing` 為當日找不到規則指定
的合約列改用可得合約的罕見情形）。實測不一致率 **2.09%**（85/4062，多集中在結算週前後，
屬預期內的正常現象——近月與次近月合約在結算前幾天成交量常互相交叉），在驗收要求的 3% 門檻內。

## Schema

### `data/daily/TX.json`

```json
{
  "instrument": "TX",
  "session": "day",
  "rows": [
    {"date": "2010-01-04", "open": 8203.0, "high": 8211.0, "low": 8101.0,
     "close": 8166.0, "volume": 84131, "contract": "201001"}
  ]
}
```

`rows` 依 `date` 升冪排序。

### `data/daily/TX-rolls.json`

```json
{
  "rolls": [
    {"date": "2010-01-21", "from_contract": "201001", "to_contract": "201002",
     "price_gap": -30.0}
  ]
}
```

### `data/chips.json`

```json
{
  "rows": [
    {"date": "2018-06-05", "dealer_net": -2207, "it_net": -24417, "fini_net": 47717}
  ]
}
```

三個 `*_net` 欄位是「未沖銷部位淨額（口數）」= `long_open_interest_balance_volume -
short_open_interest_balance_volume`（FinMind 原始欄位），**不是**當日成交量差
（`long_deal_volume - short_deal_volume`）。選未沖銷部位淨額是因為它代表法人「目前留倉的
方向性曝險」，比單日成交增減更貼近籌碼面判讀（OPMAN/謝孟恭視角常用的「三大法人淨部位」
即此口徑）。`dealer_net`=自營商、`it_net`=投信、`fini_net`=外資。

### `data/macro.json`

```json
{
  "series": {
    "tw_discount_rate": {
      "name": "台灣央行重貼現率", "unit": "%",
      "source": "中央銀行 OpenData webF1.csv (set_id=6022)",
      "rows": [{"date": "2010-01", "value": 1.25}]
    }
  }
}
```

四條序列固定 key：`tw_discount_rate`、`tw_cpi_yoy`、`tw_unemployment_rate`、
`us_fedfunds`。`rows` 為月頻，`date` 格式 `YYYY-MM`，依日期升冪排序。

## 已知資料缺陷清單

1. **`chips.json` 起始日 2018-06-05**，晚於 SPEC 期望的 2010-01。已實測確認
   FinMind `TaiwanFuturesInstitutionalInvestors` 資料集本身即從此日起才提供資料（無論
   `start_date` 參數填多早，回傳資料都是從 2018-06-05 開始），非本管線抓取邏輯缺漏。
   2010-01 ~ 2018-06 期間若需要籌碼資訊，需另尋來源。
   **2026-08-01 已完整調查免費回補管道，全數不可行，勿重跑這輪調查**：
   - TAIFEX 官網查詢（`futContractsDate`）：僅提供「交易日前三年」滾動範圍，頁面明文歷史資料需付費申購（E-Data Shop 公開資料申購表，人工線上申請、非腳本可完成）。
   - data.gov.tw 鏡像（dataset 11596）：僅當日快照，非歷史累積。
   - openapi.taifex.com.tw 對應端點：不接受日期參數，僅當日快照。
   - FinMind `TaiwanFuturesOpenInterestLargeTraders`（大額交易人，語意亦不同）：需 Sponsor 付費層。
   剩餘選項＝TAIFEX E-Data Shop 或 TEJ/CMoney 付費申購後人工餵入（schema 已固定，屆時寫一支合併腳本即可）。
   另：本輪已用 TAIFEX 官網 2026-07-31 實測數值逐欄核對，確認 chips.json 三欄位語意＝
   「未平倉餘額多空淨額（口數）」（自營 -2,377／投信 85,325 完全吻合），非交易口數淨額。
2. **近月拼接與交叉檢核有 2.09%（85/4062 天）不一致**，列於
   `data/_tx_cross_check_report.json`，多數落在每月結算週前後（近月/次近月合約成交量
   交叉的正常現象），少數為 `front_month_missing`（極早期資料某些月份合約掛牌天數較短）。
   未做逐筆人工核對每一筆，但已在 3% 驗收門檻內。
3. **結算日簡化為「當月第三個週三」**，未特別處理國定假日順延的情況（見上「已知限制」）。
4. **央行重貼現率月頻化採 forward-fill**（月底生效值代表整月），若某月中發生利率調整，
   月初與月中的實際利率會與該月標記值不同（該月標記為月底值）。

## 可重跑性

`fetch_m1.py` 全部從頭抓取並整批覆蓋輸出檔，非增量更新。全歷史抓取實測數秒內完成
（`TaiwanFuturesDaily` 一次請求回傳 6 萬多列，`TaiwanFuturesInstitutionalInvestors`
一次請求回傳約 6 千列），未觸發速率限制，因此不需要分批查詢或斷點續傳。
