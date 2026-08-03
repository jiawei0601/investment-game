"""將 data/_tx_settle_patch.json（由 tools/backfill_pre2010_and_settle.py 算出）套用到
data/daily/TX.json，就地新增 settle 欄位（append 在既有欄位之後，不動既有欄位與列序、
不動列序）。

**這支腳本會覆蓋 data/daily/TX.json（canonical 遊戲資料），屬不可逆的本機資料變更。**
執行前請確認：
1. 已看過 data/_tx_settle_patch.json 的統計摘要（settle 覆蓋率、|settle-close| 分佈）。
2. 使用者已在對話中明確同意套用（覆蓋現有 TX.json；工作區若不乾淨，建議先自行備份或
   confirm git status 乾淨可隨時 checkout 復原）。

用法：
    python tools/apply_settle_patch.py
"""
from __future__ import annotations

import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
TX_JSON_PATH = REPO_ROOT / "data" / "daily" / "TX.json"
PATCH_PATH = REPO_ROOT / "data" / "_tx_settle_patch.json"


def main() -> int:
    patch = json.loads(PATCH_PATH.read_text(encoding="utf-8"))
    settle_by_date = patch["settle_by_date"]

    tx = json.loads(TX_JSON_PATH.read_text(encoding="utf-8"))
    rows = tx["rows"]

    applied = 0
    for row in rows:
        settle = settle_by_date.get(row["date"])
        row["settle"] = settle  # append，不動既有欄位與列序
        if settle is not None:
            applied += 1

    TX_JSON_PATH.write_text(json.dumps(tx, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"已套用 settle 欄位: {applied}/{len(rows)} 列，寫回 {TX_JSON_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
