"""M1 資料管線 — 抓取 TX 近月連續日K、期貨三大法人籌碼、台美總經，輸出靜態 JSON。

可重跑更新至最新交易日；重跑會整批覆蓋輸出檔（非增量 upsert），因為資料量小
（TX 日K約 4,000 根、籌碼約 2,000 列、總經四條序列各數百列），整批覆蓋最簡單也最不會
留下殘影。

用法：
    python tools/fetch_m1.py

輸出：
    data/daily/TX.json         台指期近月連續日K（日盤）
    data/daily/TX-rolls.json   近月合約轉倉紀錄
    data/chips.json            期貨三大法人籌碼（未沖銷部位淨額）
    data/macro.json            台美總經四條序列

token：見 tools/README.md「憑證」一節。一律讀環境變數，絕不寫進 repo。
"""
from __future__ import annotations

import csv
import io
import json
import os
import ssl
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta
from pathlib import Path

import certifi
import requests

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"
DAILY_DIR = DATA_DIR / "daily"

FINMIND_URL = "https://api.finmindtrade.com/api/v4/data"
FINMIND_MIN_INTERVAL = 1.0
MAX_RETRIES = 2
RATE_LIMIT_WINDOW_SEC = 600

START_DATE = "2010-01-01"
CBC_DISCOUNT_RATE_CSV = "https://www.cbc.gov.tw/Public/Data/opendata/webF1.csv"
DGBAS_CPI_XML = "https://ws.dgbas.gov.tw/001/Upload/461/relfile/11525/230555/pr0101a1m.xml"
DGBAS_UNEMPLOYMENT_XML = "https://ws.dgbas.gov.tw/001/Upload/461/relfile/11525/230038/mp0101a07.xml"
FRED_FEDFUNDS_CSV = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=FEDFUNDS"
TWCA_INTERMEDIATE_CERT_URL = "http://sslserver.twca.com.tw/cacert/secure_sha2_2023G3.crt"

_dgbas_verify_bundle_cache: bool | str | None = None
_rate_limit_first_hit: float | None = None
_last_finmind_call = 0.0


# ---------------------------------------------------------------------------
# token / http plumbing
# ---------------------------------------------------------------------------

def _finmind_token() -> str:
    """FinMind API token 解析順序：
    1. 環境變數 FINMIND_TOKEN
    2. 環境變數 FINMIND_API_TOKEN
    3. 本 repo 根目錄 .env 的 FINMIND_TOKEN= 一行（本 repo 目前未建立此檔，供未來使用）
    4. 既有姊妹專案 C:\\CLAUDE\\investing\\tw-stock-db\\.env 的 FINMIND_TOKEN= 一行
       （沿用該專案已在跑的排程慣例，見 tools/README.md；純讀取不落地本 repo）
    皆無則回空字串 —— TaiwanFuturesDaily / TaiwanFuturesInstitutionalInvestors
    是 FinMind Free 層資料集，無 token 亦可查詢，只是速率限制較嚴。
    """
    for var in ("FINMIND_TOKEN", "FINMIND_API_TOKEN"):
        token = os.environ.get(var, "").strip()
        if token:
            return token
    candidates = [
        REPO_ROOT / ".env",
        Path(r"C:\CLAUDE\investing\tw-stock-db\.env"),
    ]
    for env_path in candidates:
        try:
            with open(env_path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("FINMIND_TOKEN="):
                        return line.split("=", 1)[1].strip().strip('"').strip("'")
        except OSError:
            continue
    return ""


def _dgbas_verify_bundle() -> bool | str:
    """ws.dgbas.gov.tw 憑證鏈不完整（只送 leaf 憑證），組 certifi 內建信任庫 + TWCA
    缺的中繼憑證的暫存合併 bundle。邏輯與 URL 沿用 tw-stock-db/collectors/macro_tw.py
    的 _dgbas_verify_bundle()（已實測可行）。失敗則回退 True（沿用預設信任庫）。"""
    global _dgbas_verify_bundle_cache
    if _dgbas_verify_bundle_cache is not None:
        return _dgbas_verify_bundle_cache
    try:
        resp = requests.get(TWCA_INTERMEDIATE_CERT_URL, timeout=10)
        resp.raise_for_status()
        pem = ssl.DER_cert_to_PEM_cert(resp.content)
        with open(certifi.where(), encoding="ascii") as f:
            base_bundle = f.read()
        fd, path = tempfile.mkstemp(suffix=".pem", prefix="dgbas_ca_bundle_")
        with os.fdopen(fd, "w", encoding="ascii") as f:
            f.write(base_bundle)
            f.write("\n")
            f.write(pem)
        _dgbas_verify_bundle_cache = path
    except Exception:
        _dgbas_verify_bundle_cache = True
    return _dgbas_verify_bundle_cache


class RateLimitAbort(RuntimeError):
    pass


def _note_rate_limit_hit() -> None:
    global _rate_limit_first_hit
    now = time.time()
    if _rate_limit_first_hit is None:
        _rate_limit_first_hit = now
        return
    if now - _rate_limit_first_hit > RATE_LIMIT_WINDOW_SEC:
        raise RateLimitAbort(
            f"連續 402/429 超過 {RATE_LIMIT_WINDOW_SEC} 秒，停止抓取，請稍後重跑 fetch_m1.py"
        )


def _clear_rate_limit() -> None:
    global _rate_limit_first_hit
    _rate_limit_first_hit = None


def fetch_finmind(dataset: str, data_id: str | None = None,
                   start_date: str = START_DATE, end_date: str | None = None) -> list[dict]:
    """呼叫 FinMind v4 API，回傳 data 陣列。402/429 節流退避重試（最多 MAX_RETRIES 次），
    600 秒內持續 402/429 直接中止整支腳本（RateLimitAbort）。"""
    global _last_finmind_call
    params: dict = {"dataset": dataset, "start_date": start_date}
    if data_id:
        params["data_id"] = data_id
    if end_date:
        params["end_date"] = end_date
    token = _finmind_token()
    if token:
        params["token"] = token

    last_error = None
    for attempt in range(MAX_RETRIES + 1):
        elapsed = time.time() - _last_finmind_call
        if elapsed < FINMIND_MIN_INTERVAL:
            time.sleep(FINMIND_MIN_INTERVAL - elapsed)
        _last_finmind_call = time.time()
        try:
            resp = requests.get(FINMIND_URL, params=params, timeout=30)
        except requests.RequestException as e:
            last_error = e
            time.sleep(2 ** attempt)
            continue
        if resp.status_code in (402, 429):
            _note_rate_limit_hit()
            last_error = RuntimeError(f"{dataset}: HTTP {resp.status_code}")
            time.sleep(5 * (attempt + 1))
            continue
        _clear_rate_limit()
        try:
            payload = resp.json()
        except ValueError as e:
            raise RuntimeError(f"{dataset}: 回應非 JSON: {e}") from e
        if payload.get("status") != 200:
            raise RuntimeError(f"{dataset}/{data_id}: {payload.get('msg')}")
        return payload.get("data") or []
    raise RuntimeError(f"{dataset}/{data_id}: 重試 {MAX_RETRIES} 次後仍失敗: {last_error}")


def fetch_csv(url: str, encoding: str = "utf-8-sig", verify=True) -> list[list[str]]:
    resp = requests.get(url, timeout=30, verify=verify)
    resp.raise_for_status()
    text = resp.content.decode(encoding)
    return list(csv.reader(io.StringIO(text)))


def fetch_xml(url: str, verify=True) -> ET.Element:
    resp = requests.get(url, timeout=30, verify=verify)
    resp.raise_for_status()
    return ET.fromstring(resp.content)


# ---------------------------------------------------------------------------
# TX 近月連續日K
# ---------------------------------------------------------------------------

def third_wednesday(year: int, month: int) -> date:
    d = date(year, month, 1)
    wednesdays = []
    while d.month == month:
        if d.weekday() == 2:  # Monday=0 ... Wednesday=2
            wednesdays.append(d)
        d += timedelta(days=1)
    return wednesdays[2]


def front_month_contract(d: date) -> str:
    """近月連續拼接規則：結算日（當月第三個週三）當天仍用當月合約，
    次一交易日起切換到下月合約。"""
    settlement = third_wednesday(d.year, d.month)
    if d <= settlement:
        y, m = d.year, d.month
    else:
        y, m = (d.year + 1, 1) if d.month == 12 else (d.year, d.month + 1)
    return f"{y:04d}{m:02d}"


def build_tx_series() -> tuple[dict, dict, dict]:
    """回傳 (tx_json, rolls_json, cross_check_report)。"""
    today = datetime.now().strftime("%Y-%m-%d")
    raw = fetch_finmind("TaiwanFuturesDaily", data_id="TX", start_date=START_DATE, end_date=today)

    # 只留日盤（trading_session == "position"）與單一月合約（contract_date 純 6 位數字，
    # 排除跨月價差組合如 "202401/202402"）。
    by_date: dict[str, dict[str, dict]] = {}
    for row in raw:
        if row.get("trading_session") != "position":
            continue
        cd = row.get("contract_date", "")
        if not (len(cd) == 6 and cd.isdigit()):
            continue
        by_date.setdefault(row["date"], {})[cd] = row

    dates_sorted = sorted(by_date.keys())

    tx_rows = []
    rolls = []
    cross_check_mismatches = []
    prev_contract = None
    prev_row = None  # 前一交易日採用的合約列（用於算 roll price_gap）

    for date_str in dates_sorted:
        d = date.fromisoformat(date_str)
        contracts_today = by_date[date_str]
        front = front_month_contract(d)

        row = contracts_today.get(front)
        if row is None:
            # 罕見缺口（例如該合約當天真的沒有成交列）：以資料中最接近的最小月份合約代替，
            # 並記錄進 mismatch 報告供人工核對。
            available = sorted(contracts_today.keys())
            if not available:
                continue
            fallback = available[0]
            cross_check_mismatches.append({
                "date": date_str, "reason": "front_month_missing",
                "expected_contract": front, "used_contract": fallback,
            })
            row = contracts_today[fallback]
            front = fallback

        o, h, l, c = float(row["open"]), float(row["max"]), float(row["min"]), float(row["close"])
        vol = int(row["volume"])

        tx_rows.append({
            "date": date_str, "open": o, "high": h, "low": l, "close": c,
            "volume": vol, "contract": front,
        })

        if prev_contract is not None and front != prev_contract:
            gap = round(o - prev_row["close"], 2) if prev_row else None
            rolls.append({
                "date": date_str, "from_contract": prev_contract,
                "to_contract": front, "price_gap": gap,
            })
        prev_contract = front
        prev_row = row

        # 交叉檢核：當日成交量最大的單一月合約
        vol_max_cd = max(contracts_today, key=lambda cd: contracts_today[cd].get("volume", 0))
        if vol_max_cd != front:
            cross_check_mismatches.append({
                "date": date_str, "reason": "volume_max_mismatch",
                "roll_rule_contract": front, "volume_max_contract": vol_max_cd,
            })

    mismatch_rate = len(cross_check_mismatches) / len(tx_rows) if tx_rows else 0.0

    tx_json = {"instrument": "TX", "session": "day", "rows": tx_rows}
    rolls_json = {"rolls": rolls}
    report = {
        "total_days": len(tx_rows),
        "mismatch_count": len(cross_check_mismatches),
        "mismatch_rate": mismatch_rate,
        "mismatches": cross_check_mismatches,
        "roll_count": len(rolls),
    }
    return tx_json, rolls_json, report


# ---------------------------------------------------------------------------
# 期貨三大法人籌碼
# ---------------------------------------------------------------------------

INSTITUTION_KEY_MAP = {
    "自營商": "dealer_net",
    "投信": "it_net",
    "外資": "fini_net",
}


def build_chips_series() -> tuple[dict, str]:
    today = datetime.now().strftime("%Y-%m-%d")
    raw = fetch_finmind("TaiwanFuturesInstitutionalInvestors", data_id="TX",
                         start_date=START_DATE, end_date=today)
    by_date: dict[str, dict] = {}
    earliest = None
    for row in raw:
        name = row.get("institutional_investors")
        key = INSTITUTION_KEY_MAP.get(name)
        if key is None:
            continue
        d = row["date"]
        if earliest is None or d < earliest:
            earliest = d
        net = int(row.get("long_open_interest_balance_volume", 0)) - int(
            row.get("short_open_interest_balance_volume", 0))
        by_date.setdefault(d, {"date": d})[key] = net

    rows = [by_date[d] for d in sorted(by_date.keys())]
    return {"rows": rows}, earliest or START_DATE


# ---------------------------------------------------------------------------
# 台美總經
# ---------------------------------------------------------------------------

def build_tw_discount_rate() -> list[dict]:
    """央行重貼現率，來源 CBC webF1.csv（調整日誌，BIG5 編碼）。
    轉成月頻序列：每月取「該月月底時生效」的重貼現率（forward-fill 最近一次調整）。"""
    rows = fetch_csv(CBC_DISCOUNT_RATE_CSV, encoding="big5")
    changes = []  # (date, rate)
    for r in rows[1:]:
        if not r or len(r) < 2:
            continue
        parts = r[0].split("/")
        if len(parts) != 3:
            continue
        try:
            yy, mm, dd = int(parts[0]), int(parts[1]), int(parts[2])
            rate = float(r[1])
        except ValueError:
            continue
        changes.append((date(yy, mm, dd), rate))
    changes.sort(key=lambda x: x[0])

    out = []
    start = date(2010, 1, 1)
    end = date.today()
    cur = date(start.year, start.month, 1)
    while cur <= end:
        # 月底時已生效的最新一次調整
        month_end = date(cur.year, 12, 31) if cur.month == 12 else date(cur.year, cur.month + 1, 1) - timedelta(days=1)
        applicable = [rate for chg_date, rate in changes if chg_date <= month_end]
        if applicable:
            out.append({"date": f"{cur.year:04d}-{cur.month:02d}", "value": applicable[-1]})
        cur = date(cur.year + 1, 1, 1) if cur.month == 12 else date(cur.year, cur.month + 1, 1)
    return out


def build_tw_cpi_yoy() -> list[dict]:
    """CPI 年增率，來源 DGBAS 消費者物價「基本分類指數」XML，
    篩選 Item=總指數、TYPE=年增率(%)，官方已算好的年增率直接採用。"""
    root = fetch_xml(DGBAS_CPI_XML, verify=_dgbas_verify_bundle())
    target_item = "總指數(指數基期：民國110年=100)"
    target_type = "年增率(%)"
    out = []
    for obs in root.findall("Obs"):
        item_el, type_el = obs.find("Item"), obs.find("TYPE")
        period_el, value_el = obs.find("TIME_PERIOD"), obs.find("Item_VALUE")
        if item_el is None or type_el is None or period_el is None or value_el is None:
            continue
        if item_el.text != target_item or type_el.text != target_type:
            continue
        value_s = (value_el.text or "").strip()
        if not value_s:
            continue
        m = period_el.text or ""
        if len(m) != 7 or m[4] != "M":
            continue
        year, month = m[:4], m[5:7]
        if f"{year}-{month}" < "2010-01":
            continue
        try:
            out.append({"date": f"{year}-{month}", "value": float(value_s)})
        except ValueError:
            continue
    out.sort(key=lambda r: r["date"])
    return out


def build_tw_unemployment_rate() -> list[dict]:
    """失業率（總計），來源 DGBAS 人力資源調查失業率 XML。"""
    root = fetch_xml(DGBAS_UNEMPLOYMENT_XML, verify=_dgbas_verify_bundle())
    out = []
    for row in root.findall("失業率"):
        period_el = row.find("年月別_Year_and_month")
        value_el = row.find("總計_Total_百分比")
        if period_el is None or value_el is None:
            continue
        period = (period_el.text or "").strip()
        if len(period) != 7 or period[4] != "M":
            continue
        year, month = period[:4], period[5:7]
        if f"{year}-{month}" < "2010-01":
            continue
        value_s = (value_el.text or "").strip()
        if not value_s:
            continue
        try:
            out.append({"date": f"{year}-{month}", "value": float(value_s)})
        except ValueError:
            continue
    out.sort(key=lambda r: r["date"])
    return out


def build_us_fedfunds() -> list[dict]:
    """美國聯邦基金利率(月頻，FEDFUNDS)，來源 FRED fredgraph.csv，免金鑰。"""
    rows = fetch_csv(FRED_FEDFUNDS_CSV, encoding="utf-8-sig")
    out = []
    for r in rows[1:]:
        if not r or len(r) < 2:
            continue
        d, v = r[0].strip(), r[1].strip()
        if len(d) != 10 or v in ("", "."):
            continue
        ym = d[:7]
        if ym < "2010-01":
            continue
        try:
            out.append({"date": ym, "value": float(v)})
        except ValueError:
            continue
    out.sort(key=lambda r: r["date"])
    return out


def build_macro() -> dict:
    return {
        "series": {
            "tw_discount_rate": {
                "name": "台灣央行重貼現率",
                "unit": "%",
                "source": "中央銀行 OpenData webF1.csv (set_id=6022)",
                "rows": build_tw_discount_rate(),
            },
            "tw_cpi_yoy": {
                "name": "台灣CPI年增率",
                "unit": "%",
                "source": "行政院主計總處 消費者物價基本分類指數 XML (ws.dgbas.gov.tw)",
                "rows": build_tw_cpi_yoy(),
            },
            "tw_unemployment_rate": {
                "name": "台灣失業率",
                "unit": "%",
                "source": "行政院主計總處 人力資源調查失業率 XML (ws.dgbas.gov.tw)",
                "rows": build_tw_unemployment_rate(),
            },
            "us_fedfunds": {
                "name": "美國聯邦基金利率(月頻)",
                "unit": "%",
                "source": "FRED fredgraph.csv?id=FEDFUNDS",
                "rows": build_us_fedfunds(),
            },
        }
    }


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)


def main() -> int:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    DAILY_DIR.mkdir(parents=True, exist_ok=True)

    print("[1/4] TX 近月連續日K + 轉倉清單 ...")
    try:
        tx_json, rolls_json, report = build_tx_series()
    except RateLimitAbort as e:
        print(f"中止：{e}", file=sys.stderr)
        return 1
    write_json(DAILY_DIR / "TX.json", tx_json)
    write_json(DAILY_DIR / "TX-rolls.json", rolls_json)
    print(f"  {report['total_days']} 個交易日, roll {report['roll_count']} 次, "
          f"交叉檢核不一致 {report['mismatch_count']} 筆 "
          f"({report['mismatch_rate']:.2%})")
    write_json(DATA_DIR / "_tx_cross_check_report.json", report)

    print("[2/4] 期貨三大法人籌碼 ...")
    try:
        chips_json, earliest = build_chips_series()
    except RateLimitAbort as e:
        print(f"中止：{e}", file=sys.stderr)
        return 1
    write_json(DATA_DIR / "chips.json", chips_json)
    print(f"  {len(chips_json['rows'])} 個交易日, 起始 {earliest}")

    print("[3/4] 台美總經 ...")
    macro_json = build_macro()
    write_json(DATA_DIR / "macro.json", macro_json)
    for key, series in macro_json["series"].items():
        rows = series["rows"]
        span = f"{rows[0]['date']} ~ {rows[-1]['date']}" if rows else "(空)"
        print(f"  {key}: {len(rows)} 筆, {span}")

    print("[4/4] 完成。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
