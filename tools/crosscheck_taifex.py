"""TAIFEX 官方期貨每日交易行情 vs data/daily/TX.json（FinMind 建置）交叉驗證。

**本腳本只做下載＋比對，不改動 data/daily/TX.json。** 是否切換正典來源由人工判斷。

資料來源：TAIFEX 官方下載專區 https://www.taifex.com.tw/cht/3/dlFutDailyMarketView
- 完整年度：POST https://www.taifex.com.tw/cht/3/futDataDown  down_type=2&his_year=YYYY
  → 回傳 zip（內含 {year}_fut.csv，全商品、BIG5 編碼）。
- 當年度（尚未收工、無年度檔可下）：down_type=1&commodity_id=TX&queryStartDate=...&queryEndDate=...
  （官網限制單次查詢區間 ≤ 1 個月，故逐月分批下載，且此端點已直接篩到 TX 商品）。

近月連續拼接規則與 tools/README.md／tools/fetch_m1.py 的 front_month_contract() 完全一致
（結算日＝當月第三個週三，結算日當天仍用當月合約，次一交易日起切換到下月合約），
以確保跟 TX.json 比較時邏輯基準相同、差異只反映資料源本身的不同。

用法：
    python tools/crosscheck_taifex.py

輸出：
    data/_raw_taifex/*.zip, *.csv   原始下載檔（不進版控，見 .gitignore）
    data/_taifex_crosscheck.json    比對報告
"""
from __future__ import annotations

import csv
import io
import json
import sys
import time
import zipfile
from datetime import date, timedelta
from pathlib import Path

import requests

REPO_ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = REPO_ROOT / "data" / "_raw_taifex"
TX_JSON_PATH = REPO_ROOT / "data" / "daily" / "TX.json"
OUT_PATH = REPO_ROOT / "data" / "_taifex_crosscheck.json"

DOWN_URL = "https://www.taifex.com.tw/cht/3/futDataDown"
HEADERS = {"User-Agent": "Mozilla/5.0 (crosscheck script; investment-game repo)"}
MIN_INTERVAL_SEC = 1.0
MAX_RETRIES = 2
TIMEOUT = 30

START_YEAR = 2010  # 對齊 TX.json 起始日 2010-01-04

# TAIFEX 年度檔欄位隨年份增修，共觀察到三種欄位數（16／17／19 欄），詳見下方
# parse_tx_rows() 的處理註解：
#   2010-2014：16 欄，無「是否因訊息面暫停交易」「交易時段」「價差對單式委託成交量」。
#   2015-2016：17 欄，多了「是否因訊息面暫停交易」，仍無 session 欄。
#   2017 起　：19 欄，補上「交易時段」「價差對單式委託成交量」。
# 核心 16 欄（所有年度皆有、位置固定）：
CORE_COLS = [
    "date", "contract_code", "expiry", "open", "high", "low", "close",
    "chg", "chg_pct", "volume", "settlement", "oi", "bid", "ask",
    "hist_high", "hist_low",
]
SESSION_COL_INDEX = 17  # 僅 19 欄格式才有意義

_last_call = 0.0


# ---------------------------------------------------------------------------
# 下載
# ---------------------------------------------------------------------------

def _throttled_post(payload: dict) -> requests.Response:
    global _last_call
    wait = MIN_INTERVAL_SEC - (time.monotonic() - _last_call)
    if wait > 0:
        time.sleep(wait)
    last_exc = None
    for attempt in range(MAX_RETRIES + 1):
        try:
            resp = requests.post(DOWN_URL, data=payload, headers=HEADERS, timeout=TIMEOUT)
            resp.raise_for_status()
            _last_call = time.monotonic()
            return resp
        except requests.RequestException as e:
            last_exc = e
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"下載失敗（重試 {MAX_RETRIES} 次仍失敗）payload={payload}: {last_exc}")


def download_annual(year: int) -> Path | None:
    path = RAW_DIR / f"{year}_fut.zip"
    resp = _throttled_post({"down_type": "2", "his_year": str(year)})
    if resp.content[:2] != b"PK":
        # 該年度沒有年度檔（例如尚未收工的當年度），視為需要走月度下載
        return None
    path.write_bytes(resp.content)
    return path


def download_month(year: int, month: int, today: date) -> Path | None:
    start = date(year, month, 1)
    if start > today:
        return None
    end = (date(year, month + 1, 1) - timedelta(days=1)) if month < 12 else date(year, 12, 31)
    if end > today:
        end = today
    payload = {
        "down_type": "1",
        "commodity_id": "TX",
        "commodity_id2": "",
        "queryStartDate": start.strftime("%Y/%m/%d"),
        "queryEndDate": end.strftime("%Y/%m/%d"),
    }
    resp = _throttled_post(payload)
    path = RAW_DIR / f"{year}{month:02d}_fut.csv"
    path.write_bytes(resp.content)
    return path


def download_all(today: date) -> tuple[list[Path], list[int]]:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []
    failed_years: list[int] = []
    current_year = today.year

    for year in range(START_YEAR, current_year):
        try:
            p = download_annual(year)
            if p is not None:
                paths.append(p)
                print(f"[ok] annual {year} -> {p.name}", file=sys.stderr)
            else:
                # 沒有年度檔（不應發生於已結束年度，記錄失敗供人工確認）
                failed_years.append(year)
                print(f"[warn] annual {year} 無年度檔可下（非預期，記錄）", file=sys.stderr)
        except Exception as e:
            failed_years.append(year)
            print(f"[fail] annual {year}: {e}", file=sys.stderr)

    # 當年度：逐月下載（官網無年度檔可下，且單次查詢區間限制 <=1 個月）
    for month in range(1, 13):
        if date(current_year, month, 1) > today:
            break
        try:
            p = download_month(current_year, month, today)
            if p is not None:
                paths.append(p)
                print(f"[ok] monthly {current_year}-{month:02d} -> {p.name}", file=sys.stderr)
        except Exception as e:
            failed_years.append(current_year * 100 + month)
            print(f"[fail] monthly {current_year}-{month:02d}: {e}", file=sys.stderr)

    return paths, failed_years


# ---------------------------------------------------------------------------
# 解析
# ---------------------------------------------------------------------------

def _decode(raw: bytes) -> str:
    for enc in ("big5", "cp950"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("big5", errors="replace")


def read_csv_text(path: Path) -> str:
    raw = path.read_bytes()
    if raw[:2] == b"PK":
        zf = zipfile.ZipFile(io.BytesIO(raw))
        raw = zf.read(zf.namelist()[0])
    return _decode(raw)


def _num(s: str) -> float | None:
    s = s.strip()
    if s in ("", "-"):
        return None
    return float(s)


def _int(s: str) -> int:
    """成交量欄位：早期年度檔（如 1998）無成交時記為 "-"，晚期年度檔記為 "0"，兩者統一視為 0。"""
    s = s.strip()
    if s in ("", "-"):
        return 0
    return int(s)


def parse_tx_rows(text: str) -> list[dict]:
    """回傳只含契約代碼 TX、日盤（一般）交易時段、單一月合約（排除價差組合）的列。

    2017 年起的 19 欄格式有明確的「交易時段」欄（一般／盤後），排除盤後列。
    2016 年以前的年度檔（16 或 17 欄）本身就只有一列／契約／日期（無盤後列，因為
    當時的年度下載檔尚未拆出盤後時段），視同全部即為日盤資料，不需要也無法用
    session 欄過濾。
    """
    lines = [l for l in text.splitlines() if l.strip()]
    if not lines:
        return []
    reader = csv.reader(lines[1:])  # 跳過表頭
    out = []
    for parts in reader:
        if len(parts) < len(CORE_COLS):
            continue
        rec = dict(zip(CORE_COLS, parts))
        if rec["contract_code"].strip() != "TX":
            continue
        if len(parts) > SESSION_COL_INDEX:
            session = parts[SESSION_COL_INDEX].strip()
            if session != "一般":
                continue
        expiry = rec["expiry"].strip()
        if not (len(expiry) == 6 and expiry.isdigit()):
            continue  # 排除跨月價差組合，如 "202606/202609"
        # 早期年度檔日期未必零填（如 "2010/1/4"），統一轉成 YYYY-MM-DD 供 date.fromisoformat 使用
        y_s, m_s, d_s = rec["date"].strip().split("/")
        date_str = f"{int(y_s):04d}-{int(m_s):02d}-{int(d_s):02d}"
        out.append({
            "date": date_str,
            "contract": expiry,
            "open": _num(rec["open"]),
            "high": _num(rec["high"]),
            "low": _num(rec["low"]),
            "close": _num(rec["close"]),
            "settlement": _num(rec["settlement"]),
            "volume": _int(rec["volume"]),
        })
    return out


# ---------------------------------------------------------------------------
# 近月連續拼接（與 tools/fetch_m1.py::front_month_contract 邏輯一致）
# ---------------------------------------------------------------------------

def third_wednesday(year: int, month: int) -> date:
    d = date(year, month, 1)
    wednesdays = []
    while d.month == month:
        if d.weekday() == 2:
            wednesdays.append(d)
        d += timedelta(days=1)
    return wednesdays[2]


def front_month_contract(d: date) -> str:
    settlement = third_wednesday(d.year, d.month)
    if d <= settlement:
        y, m = d.year, d.month
    else:
        y, m = (d.year + 1, 1) if d.month == 12 else (d.year, d.month + 1)
    return f"{y:04d}{m:02d}"


def build_official_series(
    all_records: list[dict],
) -> tuple[list[dict], list[dict], list[str]]:
    """回傳 (official_rows, roll_rule_mismatches, settlement_day_proxy_dates)。

    第三個回傳值是已知的 TAIFEX 資料特性造成的修補清單：合約在「自己的最後交易日」
    （即當月結算日）當天，官方日檔的「結算價」欄位觀察到固定回報 0（非缺漏標記
    "-"，是不合理的字面 0——指數期貨結算價不可能是 0）。這是因為當天该合約已用另一套
    「到期結算價」（依標的指數到期日均價計算）現金結算，例行的「每日結算價」欄位對
    已無留倉部位的到期契約不再有意義，故顯示 0。2005-2007 年的官方檔在同一情況下仍
    回報一個非零值（且該值等於收盤價），研判日結算價在正常交易日本來就等於／貼近
    收盤價；故此處的處理是：偵測到這個字面 0（且當天確實有成交、非真無交易）時，
    以當日收盤價頂替，並記錄該日期供回報稽核，而非把不可能的 0 留在最終資料裡。"""
    by_date: dict[str, dict[str, dict]] = {}
    for rec in all_records:
        by_date.setdefault(rec["date"], {})[rec["contract"]] = rec

    mismatches = []
    settlement_day_proxy_dates = []
    official_rows = []
    for date_str in sorted(by_date.keys()):
        d = date.fromisoformat(date_str)
        contracts_today = by_date[date_str]
        front = front_month_contract(d)

        row = contracts_today.get(front)
        if row is None:
            available = sorted(contracts_today.keys())
            if not available:
                continue
            fallback = available[0]
            mismatches.append({
                "date": date_str, "reason": "front_month_missing",
                "expected_contract": front, "used_contract": fallback,
            })
            row = contracts_today[fallback]
            front = fallback

        if row["settlement"] == 0.0 and row["open"] is not None:
            row = {**row, "settlement": row["close"]}
            settlement_day_proxy_dates.append(date_str)

        official_rows.append(row)

        traded_contracts = {cd: r for cd, r in contracts_today.items() if r["volume"]}
        if traded_contracts:
            vol_max_cd = max(traded_contracts, key=lambda cd: traded_contracts[cd]["volume"])
            if vol_max_cd != front:
                mismatches.append({
                    "date": date_str, "reason": "volume_max_mismatch",
                    "roll_rule_contract": front, "volume_max_contract": vol_max_cd,
                })

    return official_rows, mismatches, settlement_day_proxy_dates


# ---------------------------------------------------------------------------
# 比對
# ---------------------------------------------------------------------------

FIELDS = ["open", "high", "low", "close", "volume"]
EPS = 1e-6


def crosscheck(official_rows: list[dict], finmind_rows: list[dict]) -> dict:
    official_by_date = {r["date"]: r for r in official_rows}
    finmind_by_date = {r["date"]: r for r in finmind_rows}

    official_dates = set(official_by_date)
    finmind_dates = set(finmind_by_date)
    common_dates = sorted(official_dates & finmind_dates)
    only_official = sorted(official_dates - finmind_dates)
    only_finmind = sorted(finmind_dates - official_dates)

    exact_match_days = 0
    contract_mismatch_days = 0
    official_no_trade_days = 0
    field_diff_days = {f: 0 for f in FIELDS}
    field_abs_diffs = {f: [] for f in FIELDS}
    contract_mismatch_examples = []
    field_diff_examples = {f: [] for f in FIELDS}

    for date_str in common_dates:
        o = official_by_date[date_str]
        f = finmind_by_date[date_str]

        if o["contract"] != f["contract"]:
            contract_mismatch_days += 1
            if len(contract_mismatch_examples) < 50:
                contract_mismatch_examples.append({
                    "date": date_str, "official_contract": o["contract"],
                    "finmind_contract": f["contract"],
                })
            continue

        if o["open"] is None:
            official_no_trade_days += 1
            continue

        row_diffs = {}
        for field in FIELDS:
            ov, fv = o[field], f[field]
            if ov is None or fv is None:
                continue
            diff = ov - fv
            if abs(diff) > EPS:
                field_diff_days[field] += 1
                field_abs_diffs[field].append(abs(diff))
                row_diffs[field] = {"official": ov, "finmind": fv, "diff": diff}
                if len(field_diff_examples[field]) < 50:
                    field_diff_examples[field].append({
                        "date": date_str, "official": ov, "finmind": fv, "diff": diff,
                    })

        if not row_diffs:
            exact_match_days += 1

    def _stats(diffs: list[float]) -> dict:
        if not diffs:
            return {"count": 0, "mean_abs": None, "max_abs": None}
        return {
            "count": len(diffs),
            "mean_abs": round(sum(diffs) / len(diffs), 4),
            "max_abs": round(max(diffs), 4),
        }

    return {
        "total_official_days": len(official_dates),
        "total_finmind_days": len(finmind_dates),
        "common_days": len(common_dates),
        "only_in_official_dates": only_official,
        "only_in_finmind_dates": only_finmind,
        "exact_match_days": exact_match_days,
        "exact_match_rate": round(exact_match_days / len(common_dates), 4) if common_dates else None,
        "contract_mismatch_days": contract_mismatch_days,
        "official_no_trade_days": official_no_trade_days,
        "field_diff_days": field_diff_days,
        "field_diff_stats": {f: _stats(field_abs_diffs[f]) for f in FIELDS},
        "contract_mismatch_examples": contract_mismatch_examples,
        "field_diff_examples": field_diff_examples,
    }


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main() -> int:
    today = date.today()

    paths, failed_years = download_all(today)
    if not paths:
        print("[fatal] 沒有任何檔案下載成功", file=sys.stderr)
        return 1

    all_records: list[dict] = []
    for p in paths:
        text = read_csv_text(p)
        all_records.extend(parse_tx_rows(text))

    official_rows, roll_mismatches, settlement_day_proxy_dates = build_official_series(all_records)

    tx_json = json.loads(TX_JSON_PATH.read_text(encoding="utf-8"))
    finmind_rows = tx_json["rows"]

    report = crosscheck(official_rows, finmind_rows)
    report["download_failed_years_or_months"] = failed_years
    report["official_roll_rule_mismatches"] = {
        "count": len(roll_mismatches),
        "examples": roll_mismatches[:50],
    }
    report["official_total_records_parsed"] = len(all_records)
    report["settlement_day_proxy_dates"] = {
        "count": len(settlement_day_proxy_dates),
        "note": ("結算日當天該合約官方「結算價」欄位回報字面 0（到期結算改用另一套依標的"
                 "指數均價計算的到期結算價，例行日結算價欄位對已到期契約不再更新），"
                 "已以當日收盤價頂替，見 build_official_series() docstring。"),
        "dates": settlement_day_proxy_dates,
    }

    OUT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"完全一致天數: {report['exact_match_days']}/{report['common_days']} "
          f"({report['exact_match_rate']:.2%})" if report["exact_match_rate"] is not None
          else "無共同日期可比對", file=sys.stderr)
    print(f"合約不一致天數: {report['contract_mismatch_days']}", file=sys.stderr)
    print(f"官方無成交天數: {report['official_no_trade_days']}", file=sys.stderr)
    print(f"報告已寫入 {OUT_PATH}", file=sys.stderr)
    if failed_years:
        print(f"下載失敗（年/月）: {failed_years}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
