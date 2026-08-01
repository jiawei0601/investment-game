"""M1 資料驗證腳本 — 讀 data/daily/TX.json、data/daily/TX-rolls.json、data/chips.json、
data/macro.json 跑過驗收條件，印出結果摘要。任何一項失敗都不會中止腳本本身（方便一次看完
全部問題），但腳本結尾會用 exit code 反映整體成敗（0=全綠, 1=有失敗）。

用法：
    python tools/validate_m1.py
"""
from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

import requests

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"
DAILY_DIR = DATA_DIR / "daily"

FINMIND_URL = "https://api.finmindtrade.com/api/v4/data"


def load(path: Path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def fetch_trading_calendar(start_date: str, end_date: str) -> set[str]:
    """用 TaiwanStockPrice(TAIEX) 的交易日當作台股/台指期日盤交易日曆對照。"""
    resp = requests.get(FINMIND_URL, params={
        "dataset": "TaiwanStockPrice", "data_id": "TAIEX",
        "start_date": start_date, "end_date": end_date,
    }, timeout=60)
    payload = resp.json()
    if payload.get("status") != 200:
        raise RuntimeError(f"TaiwanStockPrice/TAIEX: {payload.get('msg')}")
    return {row["date"] for row in payload.get("data") or []}


def main() -> int:
    ok = True
    print("=" * 70)
    print("M1 資料驗證")
    print("=" * 70)

    # -------------------------------------------------------------- TX.json
    tx = load(DAILY_DIR / "TX.json")
    tx_rows = tx["rows"]
    tx_dates = [r["date"] for r in tx_rows]
    print(f"\n[TX.json] {len(tx_rows)} 筆, {tx_dates[0]} ~ {tx_dates[-1]}")

    # 缺日檢查：對照 TAIEX 交易日曆
    calendar = fetch_trading_calendar(tx_dates[0], tx_dates[-1])
    tx_date_set = set(tx_dates)
    missing = sorted(calendar - tx_date_set)
    extra = sorted(tx_date_set - calendar)
    print(f"  對照 TAIEX 交易日曆：{len(calendar)} 個交易日")
    if missing:
        print(f"  缺日 {len(missing)} 筆（TAIEX 有交易但 TX.json 沒有）:")
        for d in missing[:30]:
            print(f"    - {d}")
        if len(missing) > 30:
            print(f"    ... 另有 {len(missing) - 30} 筆")
        ok = False
    else:
        print("  缺日檢查：全綠（無缺口）")
    if extra:
        print(f"  額外日 {len(extra)} 筆（TX.json 有但 TAIEX 交易日曆沒有，通常是期貨盤特有）:")
        for d in extra[:10]:
            print(f"    - {d}")

    # OHLC 合法性
    ohlc_violations = []
    for r in tx_rows:
        o, h, l, c, v = r["open"], r["high"], r["low"], r["close"], r["volume"]
        if not (o > 0 and h > 0 and l > 0 and c > 0):
            ohlc_violations.append((r["date"], "非正值"))
            continue
        if h < max(o, c) or l > min(o, c) or h < l:
            ohlc_violations.append((r["date"], f"OHLC不合法 O={o} H={h} L={l} C={c}"))
        if v <= 0:
            ohlc_violations.append((r["date"], f"成交量異常 volume={v}"))
    if ohlc_violations:
        print(f"  OHLC 合法性：{len(ohlc_violations)} 筆違反")
        for d, reason in ohlc_violations[:20]:
            print(f"    - {d}: {reason}")
        ok = False
    else:
        print("  OHLC 合法性：全綠")

    # ------------------------------------------------------------ TX-rolls
    rolls = load(DAILY_DIR / "TX-rolls.json")["rolls"]
    n_years = (date.fromisoformat(tx_dates[-1]) - date.fromisoformat(tx_dates[0])).days / 365.25
    expected_rolls_lo, expected_rolls_hi = int(n_years * 11), int(n_years * 13)
    print(f"\n[TX-rolls.json] {len(rolls)} 次 roll，涵蓋約 {n_years:.1f} 年 "
          f"(預期約每年 12 次，合理範圍 [{expected_rolls_lo}, {expected_rolls_hi}])")
    if not (expected_rolls_lo <= len(rolls) <= expected_rolls_hi):
        print("  roll 頻率：超出合理範圍，需人工核對")
        ok = False
    else:
        print("  roll 頻率：合理")

    # ------------------------------------------------------------- 交叉檢核
    report_path = DATA_DIR / "_tx_cross_check_report.json"
    if report_path.exists():
        report = load(report_path)
        rate = report["mismatch_rate"]
        print(f"\n[近月拼接交叉檢核] 不一致 {report['mismatch_count']}/{report['total_days']} "
              f"({rate:.2%})")
        if rate > 0.03:
            print("  超過 3% 門檻，需人工核對（見任務指示：應停下回報）")
            ok = False
        else:
            print("  在 3% 門檻內（結算週前後少量不一致屬正常）")

    # ----------------------------------------------------------- chips.json
    chips = load(DATA_DIR / "chips.json")
    chips_rows = chips["rows"]
    chips_dates = {r["date"] for r in chips_rows}
    print(f"\n[chips.json] {len(chips_rows)} 筆, "
          f"{min(chips_dates)} ~ {max(chips_dates)}" if chips_rows else "\n[chips.json] 空")
    overlap = chips_dates & tx_date_set
    align_rate = len(overlap) / len(chips_dates) if chips_dates else 0
    print(f"  與 TX.json 日期對齊率：{align_rate:.2%} ({len(overlap)}/{len(chips_dates)})")
    if align_rate < 0.98:
        print("  對齊率偏低，需人工核對")
        ok = False
    missing_fields = [r["date"] for r in chips_rows
                       if not all(k in r for k in ("dealer_net", "it_net", "fini_net"))]
    if missing_fields:
        print(f"  欄位缺漏 {len(missing_fields)} 筆")
        ok = False
    else:
        print("  三大法人欄位齊全：全綠")

    # ----------------------------------------------------------- macro.json
    macro = load(DATA_DIR / "macro.json")
    series = macro["series"]
    print(f"\n[macro.json] {len(series)} 條序列")
    expected_series = {"tw_discount_rate", "tw_cpi_yoy", "tw_unemployment_rate", "us_fedfunds"}
    missing_series = expected_series - set(series.keys())
    if missing_series:
        print(f"  缺序列: {missing_series}")
        ok = False
    for key in sorted(series.keys()):
        rows = series[key]["rows"]
        span = f"{rows[0]['date']} ~ {rows[-1]['date']}" if rows else "(空)"
        print(f"  {key}: {len(rows)} 筆, {span}")
        if not rows:
            ok = False

    print("\n" + "=" * 70)
    print("驗證結果：全綠" if ok else "驗證結果：有失敗項目，見上方明細")
    print("=" * 70)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
