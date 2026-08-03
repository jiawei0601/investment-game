"""M1 擴充管線 — 補齊 TAIFEX 官方年度檔 1998-2009（供未來擴充遊戲時間範圍備用），
並將官方結算價（settle）回填進 data/daily/TX.json。

背景：docs/SPEC.md §1 已更新，M3 逐日洗價改用結算價；FinMind 建置的 TX.json 沒有結算價
欄位，需要從 TAIFEX 官方年度檔取得。與 tools/crosscheck_taifex.py 共用下載／解析／近月
拼接函式，確保邏輯一致。

本腳本做兩件事：

1. **1998-2009 備用資料**：TAIFEX 年度行情下載回溯上限為 1998。下載這些年度檔、用與
   tools/crosscheck_taifex.py 相同的近月拼接規則（third_wednesday／front_month_contract）
   建立近月連續序列，輸出 data/daily/TX-pre2010.json（schema 同 TX.json，多一個 settle
   欄位）。**遊戲現行時間範圍仍是 2010 起（AGENTS.md／SPEC.md 未變），這份資料純粹備用，
   不接進遊戲。** 哪個年份下載或解析失敗，記在輸出檔的 "parse_failures"，不強湊。

2. **TX.json 就地補 settle 欄位**：重用 data/_raw_taifex/ 內 2010-2026 的官方原始檔
   （tools/crosscheck_taifex.py 執行時已下載，檔案還在磁碟上）建立官方近月序列，取每列的
   官方結算價，用日期比對後把 settle 併入 TX.json 每一列（append 在既有欄位之後，
   不改動其餘欄位與列序）。**不重新下載 2010-2026 資料**——避免同一天內重複打 TAIFEX，
   crosscheck_taifex.py 剛跑過且驗證過 100% 對齊，原始檔案仍然有效。若磁碟上找不到某年度
   /月份的原始檔，會重新下載補齊（見 _ensure_raw_files_2010plus()）。

用法：
    python tools/backfill_pre2010_and_settle.py

輸出：
    data/daily/TX-pre2010.json      1998-2009 官方近月連續日K（含 settle），供未來擴充備用
    data/_tx_settle_patch.json      TX.json 要補的 settle 欄位（date -> settle 對照表 + 統計），
                                     **本腳本不直接改 data/daily/TX.json**——套用是否 in-place
                                     覆蓋既有資料需要使用者在對話中明確確認，見
                                     tools/apply_settle_patch.py。
"""
from __future__ import annotations

import json
import re
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from crosscheck_taifex import (  # noqa: E402
    RAW_DIR,
    TX_JSON_PATH,
    REPO_ROOT,
    download_annual,
    download_month,
    read_csv_text,
    parse_tx_rows,
    build_official_series,
)

PRE2010_START_YEAR = 1998
PRE2010_END_YEAR = 2009  # inclusive；TX.json 起於 2010-01-04
PRE2010_JSON_PATH = REPO_ROOT / "data" / "daily" / "TX-pre2010.json"

ANNUAL_RE = re.compile(r"^(\d{4})_fut\.zip$")
MONTHLY_RE = re.compile(r"^(\d{4})(\d{2})_fut\.csv$")


# ---------------------------------------------------------------------------
# 1998-2009 備用資料
# ---------------------------------------------------------------------------

def build_pre2010() -> dict:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    all_records = []
    parse_failures = []
    downloaded_years = []

    for year in range(PRE2010_START_YEAR, PRE2010_END_YEAR + 1):
        try:
            path = download_annual(year)
        except Exception as e:
            parse_failures.append({"year": year, "reason": f"download_failed: {e}"})
            print(f"[fail] pre2010 annual {year}: {e}", file=sys.stderr)
            continue
        if path is None:
            parse_failures.append({"year": year, "reason": "no_annual_zip_returned"})
            print(f"[warn] pre2010 annual {year} 無年度檔可下", file=sys.stderr)
            continue
        downloaded_years.append(year)
        print(f"[ok] pre2010 annual {year} -> {path.name}", file=sys.stderr)
        try:
            text = read_csv_text(path)
            rows = parse_tx_rows(text)
        except Exception as e:
            parse_failures.append({"year": year, "reason": f"parse_failed: {e}"})
            print(f"[fail] pre2010 parse {year}: {e}", file=sys.stderr)
            continue
        if not rows:
            parse_failures.append({"year": year, "reason": "parsed_zero_tx_rows"})
            print(f"[warn] pre2010 {year} 解析出 0 筆 TX 列", file=sys.stderr)
            continue
        all_records.extend(rows)

    official_rows, roll_mismatches, settlement_day_proxy_dates = build_official_series(all_records)

    rows_out = [{
        "date": r["date"], "open": r["open"], "high": r["high"], "low": r["low"],
        "close": r["close"], "volume": r["volume"], "contract": r["contract"],
        "settle": r["settlement"],
    } for r in official_rows]

    null_price_days = sum(1 for r in rows_out if r["open"] is None)
    null_settle_days = sum(1 for r in rows_out if r["settle"] is None)

    return {
        "instrument": "TX",
        "session": "day",
        "note": ("1998-2009 TAIFEX 官方近月連續日K，供未來擴充遊戲時間範圍備用；"
                 "遊戲現行時間範圍仍是 2010 起（見 AGENTS.md），本檔未被遊戲讀取。"),
        "rows": rows_out,
        "downloaded_years": downloaded_years,
        "settlement_day_proxy_count": len(settlement_day_proxy_dates),
        "parse_failures": parse_failures,
        "null_price_days": null_price_days,
        "null_settle_days": null_settle_days,
        "roll_rule_mismatches_count": len(roll_mismatches),
    }


SETTLE_PATCH_PATH = REPO_ROOT / "data" / "_tx_settle_patch.json"


# ---------------------------------------------------------------------------
# TX.json settle 補丁（本腳本只算、只寫 patch 檔，不動 TX.json 本體——
# in-place 覆蓋 canonical 資料需要使用者在對話中明確確認）
# ---------------------------------------------------------------------------

def _ensure_raw_files_2010plus(today: date) -> list[Path]:
    """優先重用磁碟上既有的 2010-2026 官方原始檔；缺的年份/月份才重新下載。"""
    paths: list[Path] = []
    current_year = today.year

    for year in range(2010, current_year):
        p = RAW_DIR / f"{year}_fut.zip"
        if p.exists():
            paths.append(p)
            continue
        print(f"[refetch] annual {year}（磁碟上找不到，重新下載）", file=sys.stderr)
        new_p = download_annual(year)
        if new_p is not None:
            paths.append(new_p)

    for month in range(1, 13):
        if date(current_year, month, 1) > today:
            break
        p = RAW_DIR / f"{current_year}{month:02d}_fut.csv"
        if p.exists():
            paths.append(p)
            continue
        print(f"[refetch] monthly {current_year}-{month:02d}（磁碟上找不到，重新下載）",
              file=sys.stderr)
        new_p = download_month(current_year, month, today)
        if new_p is not None:
            paths.append(new_p)

    return paths


def compute_settle_patch(today: date) -> dict:
    """算出 TX.json 每列對應的官方 settle，寫成獨立 patch 檔（date -> settle 對照表 +
    統計），**不寫回 TX.json**。是否套用（in-place 覆蓋 canonical 資料）留給使用者決定，
    套用方式見 tools/apply_settle_patch.py。"""
    paths = _ensure_raw_files_2010plus(today)

    all_records = []
    for p in paths:
        text = read_csv_text(p)
        all_records.extend(parse_tx_rows(text))

    official_rows, _, settlement_day_proxy_dates = build_official_series(all_records)
    settle_by_date = {r["date"]: r["settlement"] for r in official_rows}

    tx_rows = json.loads(TX_JSON_PATH.read_text(encoding="utf-8"))["rows"]

    settle_map = {}
    missing_dates = []
    abs_diffs = []
    exact_equal = 0
    for row in tx_rows:
        settle = settle_by_date.get(row["date"])
        settle_map[row["date"]] = settle
        if settle is None:
            missing_dates.append(row["date"])
        else:
            diff = abs(settle - row["close"])
            abs_diffs.append(diff)
            if diff < 1e-9:
                exact_equal += 1

    diffs_sorted = sorted(abs_diffs)
    n = len(diffs_sorted)

    def _pct(p: float) -> float | None:
        if n == 0:
            return None
        idx = min(n - 1, int(p * n))
        return round(diffs_sorted[idx], 2)

    return {
        "note": ("date -> settle 對照表，用來就地補進 data/daily/TX.json 每一列的 settle "
                 "欄位（append 在既有欄位之後，不動既有欄位與列序）。本檔本身不是遊戲讀取"
                 "的資料，只是待套用的補丁；套用前需使用者在對話中明確確認（見 "
                 "tools/apply_settle_patch.py 開頭說明）。"),
        "settle_by_date": settle_map,
        "total_rows": len(tx_rows),
        "settle_filled": len(tx_rows) - len(missing_dates),
        "settle_missing": len(missing_dates),
        "missing_dates": missing_dates,
        "settle_eq_close_days": exact_equal,
        "settlement_day_proxy_count": len(settlement_day_proxy_dates),
        "settlement_day_proxy_note": ("結算日當天該合約官方結算價欄位回報字面 0（不合理，"
                                       "已知 TAIFEX 資料特性，見 crosscheck_taifex.py::"
                                       "build_official_series docstring），已以當日收盤價"
                                       "頂替，計入下方 abs_diff_stats 時這些日的 diff=0。"),
        "abs_diff_stats": {
            "count": n,
            "mean": round(sum(diffs_sorted) / n, 2) if n else None,
            "median_p50": _pct(0.50),
            "p90": _pct(0.90),
            "p99": _pct(0.99),
            "max": round(diffs_sorted[-1], 2) if n else None,
        },
    }


def main() -> int:
    today = date.today()

    print("=== 1998-2009 備用資料 (TX-pre2010.json) ===", file=sys.stderr)
    pre2010 = build_pre2010()
    PRE2010_JSON_PATH.write_text(json.dumps(pre2010, ensure_ascii=False, indent=2),
                                  encoding="utf-8")
    print(f"下載成功年份: {pre2010['downloaded_years']}", file=sys.stderr)
    print(f"解析失敗: {pre2010['parse_failures']}", file=sys.stderr)
    print(f"寫入 {PRE2010_JSON_PATH}（{len(pre2010['rows'])} 列）", file=sys.stderr)

    print("\n=== TX.json settle 補丁（不動 TX.json 本體） ===", file=sys.stderr)
    settle_report = compute_settle_patch(today)
    print(f"settle 覆蓋: {settle_report['settle_filled']}/{settle_report['total_rows']}",
          file=sys.stderr)
    print(f"settle==close 天數: {settle_report['settle_eq_close_days']}", file=sys.stderr)
    print(f"|settle-close| 分佈: {settle_report['abs_diff_stats']}", file=sys.stderr)
    if settle_report["missing_dates"]:
        print(f"settle 缺漏日期: {settle_report['missing_dates']}", file=sys.stderr)

    SETTLE_PATCH_PATH.write_text(json.dumps(settle_report, ensure_ascii=False, indent=2),
                                  encoding="utf-8")
    print(f"\nsettle 補丁已寫入 {SETTLE_PATCH_PATH}（TX.json 本體未被修改，"
          f"套用需使用者明確確認，見 tools/apply_settle_patch.py）", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
