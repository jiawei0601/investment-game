#!/usr/bin/env python3
"""M6 事件卡生成管線 — 全量批（2010-01 ~ 2026-07，約 600 張）。

用法：
    python tools/gen_events.py                          # 生成試產批預設 28 個月，已存在月份自動跳過（冪等）
    python tools/gen_events.py --months 2020-01,2020-02
    python tools/gen_events.py --range 2010-01:2011-12   # 生成連續月份區間（全量批分批用）
    python tools/gen_events.py --force                   # 忽略已存在，強制重生成指定（或預設）月份
    python tools/gen_events.py --rounds 3                 # 每月檢查不過重生成的最大輪數（預設 3）
    python tools/gen_events.py --recheck-all --rounds 5   # 對現有全部卡片獨立重掃+修正，直到收斂或達輪數上限
    python tools/gen_events.py --sample-review 30 --seed 42
                                                           # 跨年份分層隨機抽樣寫入 data/events/_review_sample_30.md
    python tools/gen_events.py --anchors-file data/events/_anchors.json --range 2025-07:2026-07 --force
                                                           # 有錨點的月份生成時附上真實事件清單，強制基於事實改寫；
                                                           # 無錨點的月份完全不受影響（向後相容）

每月流程：
    1. 呼叫 LLM 生成該月 2-3 張事件卡（JSON）。
    2. 黑名單比對 + LLM 複審（見 tools/check_events.py）。
    3. 不通過的卡帶著打回理由重生成，最多 --rounds 輪。
    4. 仍不過的卡寫入 data/events/_rejected.json 並記原因，不進入最終月份卡池。

輸出：
    data/events/YYYY.json           按年彙整，{"year": 2020, "months": {"2020-01": [cards...]}}
    data/events/_rejected.json      淘汰卡與原因（累加式，即使沒有淘汰也會被寫入為空陣列，證明跑過）
    data/events/_gen_log.json       生成與複審過程紀錄（可追溯），每次執行附加一筆 run 記錄
    data/events/_review_sample_30.md 給使用者人工複核用的抽樣（--sample-review 產生，AI 不可自行核銷此驗收項）

外包管道：優先 tools/ask-nim.py（NIM，DeepSeek v4 模型），失敗時退回 tools/ask-deepseek.py，
兩管道皆失敗且連續達 5 次會中止整個執行（見 check_events.py 的 TooManyFailures），不空轉。
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_events import (  # noqa: E402
    BLACKLIST,
    LLMCallFailure,
    TooManyFailures,
    call_llm_dual,
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

# ---------------------------------------------------------------------------
# 錨點注入（--anchors-file）：對某些月份附上真實事件清單，強制生成結果
# 基於清單改寫，禁止自創清單外的宏觀數據方向。無錨點的月份不受影響（向後相容）。
# 格式見 data/events/_anchors.json：{"YYYY-MM": [{"date","event","source"}, ...]}
# ---------------------------------------------------------------------------

def load_anchors_file(path: str | Path) -> dict:
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"錨點檔不存在：{p}")
    data = json.loads(p.read_text(encoding="utf-8"))
    data.pop("_meta", None)
    return data


def format_anchors_block(anchors: list[dict] | None) -> str:
    """把某月的錨點清單格式化成 prompt 區塊；無錨點回傳空字串（向後相容，行為不變）。"""
    if not anchors:
        return ""
    lines = ["\n【本月真實事件錨點——鐵則，違反視為失敗】",
             "以下是這個月已查證的真實事件清單（含日期、事件摘要、來源）。你生成的事件卡：",
             "  a. 必須基於清單中的真實事實改寫成當時口吻的新聞式敘述；",
             "  b. 禁止自創清單外的宏觀數據（利率水準、價格漲跌方向、經濟數據等）——這些只能取自清單；",
             "  c. 允許用清單事件的市場氛圍做合理延伸（例如台股/台指期/相關類股的合理反應），"
             "但延伸方向不可與清單事件的方向相反（清單說降息就不能寫成升息、清單說上漲就不能寫成下跌）。",
             "清單："]
    for a in anchors:
        lines.append(f"  - [{a.get('date', '')}] {a.get('event', '')}（來源：{a.get('source', '')}）")
    return "\n".join(lines) + "\n"


def build_gen_prompt(month: str, n_cards: int, anchors: list[dict] | None = None) -> str:
    return (
        f"請生成 {month} 這個月的事件卡，共 {n_cards} 張，類別盡量分散於"
        f"{', '.join(CATEGORIES)} 之中（不強求每類都有，依當月真實新聞量而定）。\n"
        + GEN_RULES.replace("{month}", month)
        + format_anchors_block(anchors)
        + SCHEMA_HINT
    )


def build_single_regen_prompt(
    month: str, category: str, old_card: dict, reason: str, anchors: list[dict] | None = None
) -> str:
    return (
        f"以下是 {month} 的一張事件卡草稿，被稽核打回，原因：「{reason}」。\n"
        f"原草稿：{json.dumps(old_card, ensure_ascii=False)}\n\n"
        f"請針對同一月份、同一類別（{category}）重寫一張新的事件卡（內容可以換一個不同的具體事件，"
        f"不必修補原句子，重新想一個真正符合當時視角、不含打回理由所指問題的事件）。\n"
        + GEN_RULES.replace("{month}", month)
        + format_anchors_block(anchors)
        + "\n【輸出格式，只回單張卡的 JSON，不要陣列、不要多餘文字】\n"
        + '{"id": "' + old_card.get("id", f"{month}-x") + '", "category": "' + category
        + '", "title": "...", "body": "...", "source_hint": "..."}'
    )


def generate_month_cards(month: str, n_cards: int = 3, anchors: list[dict] | None = None) -> list[dict]:
    prompt = build_gen_prompt(month, n_cards, anchors)
    raw = call_llm_dual(prompt, GEN_SYSTEM)
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


def regenerate_single_card(
    month: str, old_card: dict, reason: str, anchors: list[dict] | None = None
) -> dict:
    category = old_card.get("category", "tw_market")
    prompt = build_single_regen_prompt(month, category, old_card, reason, anchors)
    raw = call_llm_dual(prompt, GEN_SYSTEM)
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

def process_month(
    month: str, max_rounds: int, stats: dict, anchors: list[dict] | None = None
) -> list[dict]:
    print(f"[gen] {month} ..." + (f"（含 {len(anchors)} 條錨點）" if anchors else ""), flush=True)
    cards = generate_month_cards(month, anchors=anchors)
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
        except TooManyFailures:
            raise  # 連續失敗達上限，交給呼叫方（main 的月份迴圈）停止整個執行
        except LLMCallFailure as e:
            print(f"  [warn] {month} round {round_no} LLM 複審失敗（未達連續失敗上限），本輪僅靠黑名單比對：{e}")
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
                    new_c = regenerate_single_card(month, c, fail_reasons[c["id"]], anchors=anchors)
                    stats["regenerated"] += 1
                    new_cards.append(new_c)
                except TooManyFailures:
                    raise
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


def parse_range(spec: str) -> list[str]:
    """'2010-01:2011-12' -> ['2010-01', ..., '2011-12']"""
    start, end = spec.split(":")
    return months_in_range(start.strip(), end.strip())


# ---------------------------------------------------------------------------
# 全量重掃收斂：對 data/events/ 下所有現有卡片做獨立黑名單+LLM複審，有問題就
# 重生成，重複直到「連續一輪 0 命中 0 打回」或達 max_rounds 上限（不自動淘汰
# 卡片——這是跨月一致性複查，不是單月生成迴圈，達上限仍未收斂則回報待人工介入）。
# ---------------------------------------------------------------------------

def recheck_all(max_rounds: int, anchors_map: dict | None = None) -> int:
    anchors_map = anchors_map or {}
    years = sorted(
        int(p.stem) for p in EVENTS_DIR.glob("*.json") if p.stem.isdigit()
    )
    if not years:
        print("[recheck] data/events/ 下沒有任何年度檔案，無事可做")
        return 0

    for round_no in range(1, max_rounds + 1):
        print(f"\n[recheck round {round_no}] 掃描 {len(years)} 個年份...", flush=True)
        total_hits = 0
        still_flagged = []
        for year in years:
            data = load_year_file(year)
            months = data.get("months", {})
            year_changed = False
            for month, cards in sorted(months.items()):
                fail_reasons = {}
                for c in cards:
                    hits = check_card_blacklist(c)
                    if hits:
                        fail_reasons[c["id"]] = f"黑名單命中：{hits}"
                try:
                    verdicts = llm_review_batch(month, cards)
                except TooManyFailures:
                    raise
                except LLMCallFailure as e:
                    print(f"  [warn] {month} 複審失敗（未達連續失敗上限），本輪僅靠黑名單：{e}")
                    verdicts = {}
                for cid, v in verdicts.items():
                    if v.get("flagged"):
                        fail_reasons[cid] = (
                            fail_reasons.get(cid, "") + f"；LLM複審：{v['reason']}"
                        ).strip("；")

                if not fail_reasons:
                    continue

                total_hits += len(fail_reasons)
                print(f"  [fix] {month}: {list(fail_reasons)}")
                month_anchors = anchors_map.get(month)
                new_cards = []
                for c in cards:
                    if c["id"] in fail_reasons:
                        try:
                            nc = regenerate_single_card(
                                month, c, fail_reasons[c["id"]], anchors=month_anchors
                            )
                            new_cards.append(nc)
                        except TooManyFailures:
                            raise
                        except Exception as e:
                            print(f"    [error] 重生成 {c['id']} 失敗，保留原卡：{e}")
                            new_cards.append(c)
                            still_flagged.append((month, c["id"], fail_reasons[c["id"]]))
                    else:
                        new_cards.append(c)
                months[month] = new_cards
                year_changed = True
            if year_changed:
                data["months"] = months
                save_year_file(year, data)

        append_log({
            "phase": "recheck_all",
            "round": round_no,
            "timestamp": dt.datetime.now().isoformat(timespec="seconds"),
            "total_hits_this_round": total_hits,
            "unresolved_after_regen": still_flagged,
        })

        if total_hits == 0:
            print(f"\n[recheck] round {round_no}：連續一輪 0 命中 0 打回，收斂完成。")
            return 0

    print(f"\n[recheck] 已達 {max_rounds} 輪上限仍未完全收斂，需人工介入，"
          f"詳見 data/events/_gen_log.json 最後幾筆 phase=recheck_all 紀錄。")
    return 1


# ---------------------------------------------------------------------------
# 30 張人工複核抽樣（跨年份分層、種子可重現）——只產出待複核清單，
# AI 不可自行核銷 M6 backlog「30 張人工複核」這條驗收項。
# ---------------------------------------------------------------------------

def write_review_sample(n: int, seed: int) -> Path:
    years = sorted(
        int(p.stem) for p in EVENTS_DIR.glob("*.json") if p.stem.isdigit()
    )
    pool_by_year: dict[int, list[tuple[str, dict]]] = {}
    for year in years:
        data = load_year_file(year)
        items = []
        for month, cards in sorted(data.get("months", {}).items()):
            for c in cards:
                items.append((month, c))
        if items:
            pool_by_year[year] = items

    eligible_years = sorted(pool_by_year)
    rng = random.Random(seed)

    quotas = {y: 1 for y in eligible_years}
    remaining = n - len(eligible_years)
    order = eligible_years[:]
    rng.shuffle(order)
    i = 0
    safety = 0
    while remaining > 0 and eligible_years and safety < 100000:
        y = order[i % len(order)]
        if quotas[y] < len(pool_by_year[y]):
            quotas[y] += 1
            remaining -= 1
        i += 1
        safety += 1

    selected: list[tuple[int, str, dict]] = []
    for y in eligible_years:
        k = min(quotas[y], len(pool_by_year[y]))
        picks = rng.sample(pool_by_year[y], k)
        for month, card in picks:
            selected.append((y, month, card))
    selected.sort(key=lambda t: (t[0], t[1], str(t[2].get("id", ""))))

    lines = [
        f"# M6 事件卡人工複核抽樣（{len(selected)} 張）",
        "",
        f"- 抽樣種子（seed）：`{seed}`",
        f"- 抽樣方式：跨年份分層——涵蓋 {len(eligible_years)} 個年份，每年至少 1 張，"
        f"其餘名額以種子洗牌年份順序後輪流分配；年內用 `random.Random(seed).sample()` 無放回抽取。"
        f"用同一 seed 重跑 `python tools/gen_events.py --sample-review {n} --seed {seed}` 可重現這份清單"
        f"（前提是 data/events/ 底層資料未變動）。",
        "",
        "**本檔案僅供人工複核使用，AI 不可自行核銷 M6 backlog 的「30 張人工複核」驗收項**——"
        "複核人、複核日期、複核結果、有無打回需由使用者填寫。",
        "",
        "## 複核紀錄（使用者填寫）",
        "",
        "- 複核人：____",
        "- 複核日期：____",
        "- 複核張數：____ / " + str(len(selected)),
        "- 打回張數與理由：____",
        "",
        "## 抽樣卡片",
        "",
    ]
    for y, month, card in selected:
        lines.append(f"### {month} — {card.get('id')}（{card.get('category')}）")
        lines.append("")
        lines.append(f"**{card.get('title', '')}**")
        lines.append("")
        lines.append(card.get("body", ""))
        lines.append("")
        lines.append(f"*source_hint：{card.get('source_hint', '')}*")
        lines.append("")
        lines.append("- [ ] 通過")
        lines.append("- [ ] 打回（理由：____）")
        lines.append("")
        lines.append("---")
        lines.append("")

    path = EVENTS_DIR / "_review_sample_30.md"
    path.write_text("\n".join(lines), encoding="utf-8")
    print(f"[sample] 已寫入 {path}（{len(selected)} 張，跨 {len(eligible_years)} 個年份，種子={seed}）")
    return path


# ---------------------------------------------------------------------------
# 單卡修正重生成（--fix-card）：針對人工複核已指出問題的特定卡片，帶著明確修正
# 指示重生成，只動這一張卡，同月份其他卡片不受影響。
# ---------------------------------------------------------------------------

def fix_cards(specs: list[str], anchors_map: dict) -> int:
    touched_months: set[str] = set()
    for spec in specs:
        try:
            month, card_id, reason = spec.split(":", 2)
        except ValueError:
            print(f"[error] --fix-card 格式錯誤，需為 'YYYY-MM:card-id:修正指示'：{spec!r}")
            return 1
        year = int(month[:4])
        data = load_year_file(year)
        cards = data.get("months", {}).get(month)
        if not cards:
            print(f"[error] {month} 在 data/events/{year}.json 中不存在，無法修正 {card_id}")
            return 1
        idx = next((i for i, c in enumerate(cards) if c.get("id") == card_id), None)
        if idx is None:
            print(f"[error] {month} 中找不到卡片 id={card_id}")
            return 1
        old_card = cards[idx]
        print(f"[fix-card] {month} {card_id}：{reason}")
        try:
            new_card = regenerate_single_card(
                month, old_card, reason, anchors=anchors_map.get(month)
            )
        except TooManyFailures as e:
            print(f"\n[ABORT] {e}")
            return 3
        except Exception as e:
            print(f"[error] {month} {card_id} 修正失敗：{e}")
            return 1
        new_card.setdefault("id", card_id)
        cards[idx] = new_card
        data["months"][month] = cards
        save_year_file(year, data)
        touched_months.add(month)
        print(f"  [ok] {month} {card_id} 已重生成並存回")

    append_log({
        "phase": "fix_cards",
        "timestamp": dt.datetime.now().isoformat(timespec="seconds"),
        "specs": specs,
        "touched_months": sorted(touched_months),
    })
    return 0


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except AttributeError:
            pass
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--months", default=None, help="逗號分隔月份清單，如 2020-01,2020-02；預設=試產批 28 個月")
    parser.add_argument("--range", dest="range_spec", default=None,
                         help="連續月份區間，如 2010-01:2011-12（全量批分批用，含頭尾）")
    parser.add_argument("--force", action="store_true", help="忽略已存在的月份，強制重生成")
    parser.add_argument("--rounds", type=int, default=3, help="檢查不過重生成的最大輪數（預設 3）")
    parser.add_argument("--n-cards", type=int, default=3, help="每月生成張數上限（實際 2-3 張，模型可能少給）")
    parser.add_argument("--recheck-all", action="store_true",
                         help="不生成新月份，改對 data/events/ 現有全部卡片獨立重掃+修正，直到收斂")
    parser.add_argument("--sample-review", type=int, default=None, metavar="N",
                         help="寫出 N 張跨年份分層抽樣到 data/events/_review_sample_30.md（配合 --seed）")
    parser.add_argument("--seed", type=int, default=42, help="--sample-review 用的隨機種子（預設 42）")
    parser.add_argument("--anchors-file", default=None, metavar="PATH",
                         help="真實事件錨點 JSON 檔路徑（如 data/events/_anchors.json）。"
                              "生成/重生成時，對有錨點的月份會附上清單並要求基於清單事實改寫，"
                              "禁止自創清單外宏觀數據；沒有錨點的月份行為不變（向後相容）。")
    parser.add_argument("--fix-card", action="append", default=None, metavar="MONTH:ID:REASON",
                         help="單卡修正重生成：格式 'YYYY-MM:card-id:修正指示'，用管線內既有單卡重生成路徑"
                              "（regenerate_single_card）依自訂理由重寫指定卡片並存回原月份，"
                              "其餘同月份卡片不動。可重複此參數修多張（跨月份亦可）。")
    args = parser.parse_args()

    EVENTS_DIR.mkdir(parents=True, exist_ok=True)
    if not REJECTED_PATH.exists():
        save_rejected([])  # 保證 _rejected.json 一定存在，即使沒有淘汰也佐證跑過

    anchors_map: dict = {}
    if args.anchors_file:
        anchors_map = load_anchors_file(args.anchors_file)
        print(f"[anchors] 已載入 {args.anchors_file}，涵蓋 {len(anchors_map)} 個月份")

    if args.sample_review is not None:
        write_review_sample(args.sample_review, args.seed)
        return 0

    if args.fix_card:
        return fix_cards(args.fix_card, anchors_map)

    if args.recheck_all:
        try:
            return recheck_all(args.rounds, anchors_map=anchors_map)
        except TooManyFailures as e:
            print(f"\n[ABORT] {e}")
            append_log({
                "phase": "recheck_all_abort",
                "timestamp": dt.datetime.now().isoformat(timespec="seconds"),
                "error": str(e),
            })
            print("已達連續失敗上限，停止執行，不空轉。重跑 --recheck-all 會從頭重掃"
                  "（已修正的卡片不受影響，只有還沒掃到/還沒修好的部分會重試）。")
            return 3

    if args.range_spec:
        months = parse_range(args.range_spec)
    elif args.months:
        months = args.months.split(",")
    else:
        months = default_trial_months()

    stats = {
        "generated": 0, "blacklist_hits": 0, "llm_flags": 0,
        "regenerated": 0, "rejected": 0, "final_pass": 0, "rounds_used": 0,
        "months_processed": 0, "months_skipped": 0, "months_failed": [],
    }

    run_started = dt.datetime.now().isoformat(timespec="seconds")
    aborted = False
    abort_reason = None

    for month in months:
        if not args.force and month_already_done(month):
            print(f"[skip] {month} 已存在，跳過（冪等；用 --force 強制重生成）")
            stats["months_skipped"] += 1
            continue
        try:
            cards = process_month(month, args.rounds, stats, anchors=anchors_map.get(month))
        except TooManyFailures as e:
            print(f"\n[ABORT] {month} 處理中：{e}")
            aborted = True
            abort_reason = str(e)
            break
        except Exception as e:
            print(f"[error] {month} 生成失敗（單次錯誤，非連續失敗上限，跳過此月，之後可重跑補上）：{e}")
            stats["months_failed"].append(month)
            continue
        stats["months_processed"] += 1

        year = int(month[:4])
        data = load_year_file(year)
        data.setdefault("months", {})[month] = cards
        save_year_file(year, data)

    append_log({
        "run_started": run_started,
        "run_finished": dt.datetime.now().isoformat(timespec="seconds"),
        "months_requested": months,
        "range": args.range_spec,
        "force": args.force,
        "max_rounds": args.rounds,
        "stats": stats,
        "aborted": aborted,
        "abort_reason": abort_reason,
    })

    print("\n=== 統計 ===")
    for k, v in stats.items():
        print(f"  {k}: {v}")
    if aborted:
        print("\n已達連續失敗上限，停止執行，不空轉。已完成月份已寫入，重跑同一個 --range 會自動跳過"
              "已完成月份、從中斷點續跑。")
        return 4
    return 0


if __name__ == "__main__":
    sys.exit(main())
