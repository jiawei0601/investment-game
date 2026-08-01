#!/usr/bin/env python3
"""M6 事件卡生成管線 — 試產批（四個劇本關卡涵蓋的 28 個月）。

用法：
    python tools/gen_events.py                       # 生成試產批預設 28 個月，已存在月份自動跳過（冪等）
    python tools/gen_events.py --months 2020-01,2020-02
    python tools/gen_events.py --force                # 忽略已存在，強制重生成指定（或預設）月份
    python tools/gen_events.py --rounds 3              # 檢查不過重生成的最大輪數（預設 3，對應驗收條件）

每月流程：
    1. 呼叫 LLM 生成該月 2-3 張事件卡（JSON）。
    2. 黑名單比對 + LLM 複審（見 tools/check_events.py）。
    3. 不通過的卡帶著打回理由重生成，最多 --rounds 輪。
    4. 仍不過的卡寫入 data/events/_rejected.json 並記原因，不進入最終月份卡池。

輸出：
    data/events/YYYY.json      按年彙整，{"year": 2020, "months": {"2020-01": [cards...]}}
    data/events/_rejected.json 淘汰卡與原因（累加式，即使沒有淘汰也會被寫入為空陣列，證明跑過）
    data/events/_gen_log.json  生成與複審過程紀錄（可追溯），每次執行附加一筆 run 記錄

外包管道：優先 tools/ask-nim.py（NIM，DeepSeek v4 模型），失敗時退回 tools/ask-deepseek.py。
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_events import (  # noqa: E402
    BLACKLIST,
    call_llm,
    check_card_blacklist,
    llm_review_batch,
    _extract_json,
)

REPO = Path(__file__).resolve().parent.parent
EVENTS_DIR = REPO / "data" / "events"
REJECTED_PATH = EVENTS_DIR / "_rejected.json"
LOG_PATH = EVENTS_DIR / "_gen_log.json"

# 四個劇本關卡涵蓋的月份範圍（SPEC.md §2「劇本制 4 關」）
TRIAL_SCENARIOS = {
    "疫情": ("2020-01", "2020-06"),
    "熊市": ("2022-01", "2022-10"),
    "平淡": ("2017-03", "2017-08"),
    "閃崩": ("2024-05", "2024-10"),
}

CATEGORIES = ["macro", "intl", "tw_market", "industry", "policy"]


def months_in_range(start: str, end: str) -> list[str]:
    y0, m0 = map(int, start.split("-"))
    y1, m1 = map(int, end.split("-"))
    out = []
    y, m = y0, m0
    while (y, m) <= (y1, m1):
        out.append(f"{y:04d}-{m:02d}")
        m += 1
        if m > 12:
            m = 1
            y += 1
    return out


def default_trial_months() -> list[str]:
    seen = []
    for _, (s, e) in TRIAL_SCENARIOS.items():
        for mo in months_in_range(s, e):
            if mo not in seen:
                seen.append(mo)
    return seen


# ---------------------------------------------------------------------------
# 生成 prompt
# ---------------------------------------------------------------------------
GEN_SYSTEM = (
    "你是一位資深財經編輯，專長是重建歷史某個月份「當下」的市場觀察視角，"
    "服務對象是台灣期貨/股票交易者。你被嚴格禁止使用任何後見之明——"
    "你只能寫出「站在那個月月初，尚不知道後續發展」的人會看到、會寫的內容。"
    "你只輸出 JSON，不要 markdown code fence、不要任何其他說明文字。"
)

BLACKLIST_HINT = "、".join(BLACKLIST[:20]) + " 等"

GEN_RULES = f"""
【鐵則，違反視為失敗】
1. 口吻＝「{{month}} 月初的市場觀察者」。只能使用該時點之前已公開的資訊。
2. 禁止後見之明：不可暗示後續發展、不可用歷史定位詞（如「開端」「史上最大」「轉捩點」）、
   不可用回溯語氣（如「後來」「事後證明」「回顧」）。黑名單詞舉例（不限於此）：{BLACKLIST_HINT}
3. 反例（絕對禁止的寫法）：「這是史上最快熊市的開端」
   正例（正確的寫法）：「亞洲部分工廠傳出停工，市場影響尚待評估」
4. 立場需貼合台灣市場：台股/台指期交易者當時會看到的新聞。國際事件只收「對台股有影響」的。
5. 允許部分卡是「雜訊」——當時看起來重要、事後不重要的事，這是特性不是缺陷，不要每張卡都寫得
   像「重大轉折」，那本身就是後見之明的心理痕跡。
6. body 需 60-150 字繁體中文，具體、有台灣市場的溫度感（提及台股/台指期/相關類股反應），
   不要寫成教科書式的中性陳述。
"""

SCHEMA_HINT = """
【輸出格式，務必是合法 JSON，不要多餘文字】
{
  "month": "YYYY-MM",
  "cards": [
    {
      "id": "YYYY-MM-1",
      "category": "macro|intl|tw_market|industry|policy",
      "title": "十五字以內標題",
      "body": "60-150字繁體中文內文",
      "source_hint": "這類新聞當時可能出現在哪個版面/媒體類型（例如：財經日報頭版、路透即時、央行新聞稿）"
    }
  ]
}
"""


def build_gen_prompt(month: str, n_cards: int) -> str:
    return (
        f"請生成 {month} 這個月的事件卡，共 {n_cards} 張，類別盡量分散於"
        f"{', '.join(CATEGORIES)} 之中（不強求每類都有，依當月真實新聞量而定）。\n"
        + GEN_RULES.replace("{month}", month)
        + SCHEMA_HINT
    )


def build_single_regen_prompt(month: str, category: str, old_card: dict, reason: str) -> str:
    return (
        f"以下是 {month} 的一張事件卡草稿，被稽核打回，原因：「{reason}」。\n"
        f"原草稿：{json.dumps(old_card, ensure_ascii=False)}\n\n"
        f"請針對同一月份、同一類別（{category}）重寫一張新的事件卡（內容可以換一個不同的具體事件，"
        f"不必修補原句子，重新想一個真正符合當時視角、不含打回理由所指問題的事件）。\n"
        + GEN_RULES.replace("{month}", month)
        + "\n【輸出格式，只回單張卡的 JSON，不要陣列、不要多餘文字】\n"
        + '{"id": "' + old_card.get("id", f"{month}-x") + '", "category": "' + category
        + '", "title": "...", "body": "...", "source_hint": "..."}'
    )


def generate_month_cards(month: str, n_cards: int = 3) -> list[dict]:
    prompt = build_gen_prompt(month, n_cards)
    try:
        raw = call_llm(prompt, GEN_SYSTEM, "ask-nim.py")
    except Exception:
        raw = call_llm(prompt, GEN_SYSTEM, "ask-deepseek.py")
    parsed = json.loads(_extract_json(raw))
    cards = parsed.get("cards", [])
    # 補正 id：若模型沒照格式給，強制重編號避免衝突
    fixed = []
    for i, c in enumerate(cards, 1):
        c = dict(c)
        c.setdefault("id", f"{month}-{i}")
        if not str(c["id"]).startswith(month):
            c["id"] = f"{month}-{i}"
        fixed.append(c)
    return fixed


def regenerate_single_card(month: str, old_card: dict, reason: str) -> dict:
    category = old_card.get("category", "tw_market")
    prompt = build_single_regen_prompt(month, category, old_card, reason)
    try:
        raw = call_llm(prompt, GEN_SYSTEM, "ask-nim.py")
    except Exception:
        raw = call_llm(prompt, GEN_SYSTEM, "ask-deepseek.py")
    parsed = json.loads(_extract_json(raw))
    parsed.setdefault("id", old_card.get("id"))
    return parsed


# ---------------------------------------------------------------------------
# 存取 data/events/*.json
# ---------------------------------------------------------------------------

def load_year_file(year: int) -> dict:
    path = EVENTS_DIR / f"{year}.json"
    if not path.exists():
        return {"year": year, "months": {}}
    return json.loads(path.read_text(encoding="utf-8"))


def save_year_file(year: int, data: dict) -> None:
    path = EVENTS_DIR / f"{year}.json"
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2, sort_keys=False) + "\n",
        encoding="utf-8",
    )


def month_already_done(month: str) -> bool:
    year = int(month[:4])
    data = load_year_file(year)
    cards = data.get("months", {}).get(month)
    return bool(cards)


def load_rejected() -> list[dict]:
    if REJECTED_PATH.exists():
        return json.loads(REJECTED_PATH.read_text(encoding="utf-8"))
    return []


def save_rejected(items: list[dict]) -> None:
    REJECTED_PATH.write_text(
        json.dumps(items, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def append_log(entry: dict) -> None:
    log = []
    if LOG_PATH.exists():
        log = json.loads(LOG_PATH.read_text(encoding="utf-8"))
    log.append(entry)
    LOG_PATH.write_text(json.dumps(log, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


# ---------------------------------------------------------------------------
# 單月：生成 -> 檢查 -> 重生成迴圈
# ---------------------------------------------------------------------------

def process_month(month: str, max_rounds: int, stats: dict) -> list[dict]:
    print(f"[gen] {month} ...", flush=True)
    cards = generate_month_cards(month)
    stats["generated"] += len(cards)
    rejected_this_month = []

    for round_no in range(1, max_rounds + 1):
        # 1) 黑名單
        blacklist_fail = {}
        for c in cards:
            hits = check_card_blacklist(c)
            if hits:
                blacklist_fail[c["id"]] = f"黑名單命中：{hits}"
        stats["blacklist_hits"] += len(blacklist_fail)

        # 2) LLM 複審（黑名單已未過的卡也一起丟，反正要重生成，跳過省一次呼叫也可以；
        #    這裡選擇仍然送審，方便完整記錄該卡所有問題）
        try:
            verdicts = llm_review_batch(month, cards)
        except Exception as e:
            print(f"  [warn] {month} round {round_no} LLM 複審失敗，視為全數需人工複核：{e}")
            verdicts = {}
        llm_fail = {cid: v["reason"] for cid, v in verdicts.items() if v["flagged"]}
        stats["llm_flags"] += len(llm_fail)

        fail_reasons = {}
        for cid, reason in blacklist_fail.items():
            fail_reasons[cid] = reason
        for cid, reason in llm_fail.items():
            fail_reasons[cid] = (fail_reasons.get(cid, "") + f"；LLM複審：{reason}").strip("；")

        if not fail_reasons:
            print(f"  [ok] {month} round {round_no}：{len(cards)} 張全數通過")
            break

        print(f"  [round {round_no}] {month} 有 {len(fail_reasons)} 張待重生成：{list(fail_reasons)}")
        if round_no == max_rounds:
            # 最後一輪仍不過 -> 淘汰
            for c in list(cards):
                if c["id"] in fail_reasons:
                    rejected_this_month.append({
                        "id": c["id"],
                        "month": month,
                        "card": c,
                        "reason": fail_reasons[c["id"]],
                        "rounds_tried": max_rounds,
                        "rejected_at": dt.datetime.now().isoformat(timespec="seconds"),
                    })
            cards = [c for c in cards if c["id"] not in fail_reasons]
            stats["rejected"] += len(rejected_this_month)
            break

        # 重生成
        new_cards = []
        for c in cards:
            if c["id"] in fail_reasons:
                try:
                    new_c = regenerate_single_card(month, c, fail_reasons[c["id"]])
                    stats["regenerated"] += 1
                    new_cards.append(new_c)
                except Exception as e:
                    print(f"  [error] 重生成 {c['id']} 失敗：{e}，本輪保留原卡待下輪")
                    new_cards.append(c)
            else:
                new_cards.append(c)
        cards = new_cards

    stats["rounds_used"] = max(stats.get("rounds_used", 0), round_no)
    stats["final_pass"] += len(cards)

    if rejected_this_month:
        all_rejected = load_rejected()
        all_rejected.extend(rejected_this_month)
        save_rejected(all_rejected)

    return cards


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except AttributeError:
            pass
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--months", default=None, help="逗號分隔月份清單，如 2020-01,2020-02；預設=試產批 28 個月")
    parser.add_argument("--force", action="store_true", help="忽略已存在的月份，強制重生成")
    parser.add_argument("--rounds", type=int, default=3, help="檢查不過重生成的最大輪數（預設 3）")
    parser.add_argument("--n-cards", type=int, default=3, help="每月生成張數上限（實際 2-3 張，模型可能少給）")
    args = parser.parse_args()

    EVENTS_DIR.mkdir(parents=True, exist_ok=True)
    if not REJECTED_PATH.exists():
        save_rejected([])  # 保證 _rejected.json 一定存在，即使沒有淘汰也佐證跑過

    months = args.months.split(",") if args.months else default_trial_months()

    stats = {
        "generated": 0, "blacklist_hits": 0, "llm_flags": 0,
        "regenerated": 0, "rejected": 0, "final_pass": 0, "rounds_used": 0,
        "months_processed": 0, "months_skipped": 0,
    }

    run_started = dt.datetime.now().isoformat(timespec="seconds")

    for month in months:
        if not args.force and month_already_done(month):
            print(f"[skip] {month} 已存在，跳過（冪等；用 --force 強制重生成）")
            stats["months_skipped"] += 1
            continue
        cards = process_month(month, args.rounds, stats)
        stats["months_processed"] += 1

        year = int(month[:4])
        data = load_year_file(year)
        data.setdefault("months", {})[month] = cards
        save_year_file(year, data)

    append_log({
        "run_started": run_started,
        "run_finished": dt.datetime.now().isoformat(timespec="seconds"),
        "months_requested": months,
        "force": args.force,
        "max_rounds": args.rounds,
        "stats": stats,
    })

    print("\n=== 統計 ===")
    for k, v in stats.items():
        print(f"  {k}: {v}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
