#!/usr/bin/env python3
"""M6 事件卡 — 檢查工序（黑名單比對 + LLM 複審）。

可獨立執行，掃描 `data/events/*.json` 現有卡片並印報告（不會呼叫生成、不會改檔案）：

    python tools/check_events.py                 # 掃全部年份
    python tools/check_events.py --year 2020      # 只掃某年
    python tools/check_events.py --no-llm         # 只跑黑名單，不打 LLM（省額度）

也被 `tools/gen_events.py` 當模組 import，共用同一份黑名單與複審邏輯，
確保「生成時的檢查」與「事後重跑的檢查」永遠是同一套規則。
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
EVENTS_DIR = REPO / "data" / "events"

# ---------------------------------------------------------------------------
# 黑名單：後見之明措辭
#
# 這是 SPEC.md §5「事件卡」與 HANDOFF.md 雷區明訂的第一道防線。詞條選取原則：
#   - 只收「暗示說話者已知道後續發展」的詞（時間定位詞、歷史定位詞、因果回溯詞）。
#   - 不收「當時就可能出現的強度形容詞」（例如「重挫」「大跌」單獨出現不算，
#     因為當月觀察者也可能用這些詞描述已發生的當月行情）。
#   - 中英文皆收（避免卡片夾雜英文後見之明詞逃過比對）。
# 命中任一詞（不分詞性、不分句子位置）即判定該卡不通過，需重生成。
# ---------------------------------------------------------------------------
BLACKLIST = [
    # 歷史定位 / 「這是最大最快」型
    "開端", "史上最大", "史上最快", "史上僅見", "百年一遇", "史上第一次",
    "空前", "絕後", "空前絕後", "劃時代", "里程碑", "轉捩點", "成為轉折",
    "揭開序幕", "拉開序幕", "前夕", "風暴前", "暴風雨前", "山雨欲來",
    # 因果回溯 / 「後來才知道」型
    "隨後", "事後證明", "事後看來", "事後才知道", "後來證明", "後來才發現",
    "回頭看", "回過頭看", "回顧來看", "如今看來", "現在看來", "多年後",
    "多年後證實", "日後", "後續發展證實", "最終導致", "最終演變成",
    "最終被視為", "一語成讖", "埋下伏筆", "預示著", "預告了", "為...揭開",
    "後見之明",
    # 明確跨期敘事詞（把當月寫成某段歷史區間的一部分）
    "這波熊市", "這波多頭行情的頂點", "牛市的終點", "熊市的起點",
    "泡沫破裂的開始", "崩盤的第一天",
    # 英文對應詞（防止卡片夾英文逃過中文比對）
    "in hindsight", "would later", "turned out to be", "the beginning of",
    "marked the start", "little did", "would go on to",
]


def check_blacklist_hit(text: str) -> list[str]:
    """回傳文字中命中的黑名單詞（可能多個）。"""
    hits = []
    for term in BLACKLIST:
        if term.lower() in text.lower():
            hits.append(term)
    return hits


def check_card_blacklist(card: dict) -> list[str]:
    """對單張卡的 title+body 做黑名單比對，回傳命中詞列表（空=通過）。"""
    combined = f"{card.get('title', '')}\n{card.get('body', '')}"
    return check_blacklist_hit(combined)


# ---------------------------------------------------------------------------
# LLM 複審：把卡片丟回外包管道，問是否含後見之明資訊/措辭。
# ---------------------------------------------------------------------------
REVIEW_SYSTEM = (
    "你是嚴格的歷史財經內容稽核員。你的唯一任務：判斷一段「宣稱寫於某個歷史月份」"
    "的市場觀察文字，是否洩漏了只有該月份「之後」才可能知道的資訊、措辭或定位詞"
    "（例如把當下事件定位為某段歷史的「起點」「開端」「轉捩點」，或使用「後來」"
    "「事後證明」「回顧」之類回溯語氣，或直接寫出該月份之後才發生的具體後續發展）。"
    "只要能讓一個「活在那個當下、看不到未來」的讀者察覺『這是穿越者寫的』，就算不通過。"
    "不要因為用詞聳動、語氣悲觀樂觀而判定不通過——那不是後見之明，是當時就可能有的情緒。"
    "只輸出 JSON，不要任何其他文字、不要 markdown code fence。"
)


def build_review_prompt(month: str, cards: list[dict]) -> str:
    lines = [
        f"以下是宣稱寫於 {month} 月初（該月月初市場觀察者視角）的事件卡，逐張判定。",
        "對每一張卡輸出 {\"id\": 卡片id, \"flagged\": true/false, \"reason\": \"理由（若flagged=false可簡短寫'通過'）\"}",
        "輸出格式：一個 JSON 陣列，不要有其他文字。",
        "",
    ]
    for c in cards:
        lines.append(json.dumps({
            "id": c.get("id"),
            "title": c.get("title"),
            "body": c.get("body"),
        }, ensure_ascii=False))
    return "\n".join(lines)


def _extract_json(text: str) -> str:
    """LLM 常會用 ```json ... ``` 包起來，或前後夾雜說明文字，這裡盡量抽出純 JSON。"""
    text = text.strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if fence:
        return fence.group(1).strip()
    # 找第一個 [ 或 { 到最後一個 ] 或 } 之間的內容
    start_candidates = [i for i in (text.find("["), text.find("{")) if i != -1]
    if not start_candidates:
        return text
    start = min(start_candidates)
    end_candidates = [i for i in (text.rfind("]"), text.rfind("}")) if i != -1]
    end = max(end_candidates) if end_candidates else len(text) - 1
    return text[start:end + 1]


def call_llm(prompt: str, system: str, model_script: str = "ask-nim.py") -> str:
    script_path = Path("C:/CLAUDE/tools") / model_script
    # Windows 環境用 python 直譯執行，避免 shebang 相依
    proc = subprocess.run(
        [sys.executable, str(script_path), "--system", system],
        input=prompt.encode("utf-8"),
        capture_output=True,
        timeout=300,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"{model_script} 失敗 (exit={proc.returncode}): "
            f"{proc.stderr.decode('utf-8', 'replace')[:500]}"
        )
    return proc.stdout.decode("utf-8", "replace")


# ---------------------------------------------------------------------------
# 雙管道容錯：NIM 主力 -> DeepSeek 備援，各自可重試；連續失敗達上限就中止整個
# 執行（不空轉），由呼叫方（gen_events.py 的批次迴圈）捕捉 TooManyFailures 停下回報。
# ---------------------------------------------------------------------------
class LLMCallFailure(RuntimeError):
    """單次呼叫：NIM 與 DeepSeek 都失敗（含各自重試後）。"""


class TooManyFailures(LLMCallFailure):
    """連續 MAX_CONSECUTIVE_FAILURES 次呼叫都雙管道失敗，呼叫方應立即停止、不要繼續空轉。"""


MAX_CONSECUTIVE_FAILURES = 5
_consecutive_failures = 0


def call_llm_dual(
    prompt: str,
    system: str,
    retries_per_channel: int = 1,
    backoff_sec: float = 5.0,
) -> str:
    """依序嘗試 NIM -> DeepSeek，每個管道最多嘗試 retries_per_channel+1 次（含重試間隔）。
    兩管道皆失敗時累計「連續失敗次數」，達 MAX_CONSECUTIVE_FAILURES 就拋 TooManyFailures；
    未達上限則拋 LLMCallFailure（呼叫方可視情況跳過本次、繼續下一項）。任何一次成功即歸零計數。
    """
    global _consecutive_failures
    last_err: Exception | None = None
    for script in ("ask-nim.py", "ask-deepseek.py"):
        for attempt in range(retries_per_channel + 1):
            try:
                result = call_llm(prompt, system, script)
                _consecutive_failures = 0
                return result
            except Exception as e:  # noqa: BLE001
                last_err = e
                if attempt < retries_per_channel:
                    time.sleep(backoff_sec)
    _consecutive_failures += 1
    msg = f"NIM 與 DeepSeek 皆失敗（連續第 {_consecutive_failures} 次）：{last_err}"
    if _consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
        raise TooManyFailures(
            f"連續 {_consecutive_failures} 次呼叫兩管道皆失敗，達上限 {MAX_CONSECUTIVE_FAILURES}，停止執行。最後錯誤：{last_err}"
        )
    raise LLMCallFailure(msg)


def llm_review_batch(month: str, cards: list[dict]) -> dict[str, dict]:
    """回傳 {card_id: {"flagged": bool, "reason": str}}。"""
    if not cards:
        return {}
    prompt = build_review_prompt(month, cards)
    # 空回應/非法 JSON 視同該次呼叫失敗（LLM 偶發回空字串，2026-08-02 全量跑實測），
    # 重試最多 3 次；仍失敗走 LLMCallFailure（呼叫端可跳過該月續跑），不再炸整條鏈。
    parsed = None
    last_err: Exception | None = None
    for _parse_attempt in range(3):
        raw = call_llm_dual(prompt, REVIEW_SYSTEM)
        json_text = _extract_json(raw)
        try:
            parsed = json.loads(json_text)
            break
        except json.JSONDecodeError as e:
            last_err = e
            time.sleep(2.0)
    if parsed is None:
        global _consecutive_failures
        _consecutive_failures += 1
        raise LLMCallFailure(f"LLM 複審連續回傳非合法 JSON/空回應：{last_err}")
    result = {}
    for item in parsed:
        cid = item.get("id")
        if cid is None:
            continue
        result[cid] = {
            "flagged": bool(item.get("flagged", False)),
            "reason": item.get("reason", ""),
        }
    return result


# ---------------------------------------------------------------------------
# 獨立掃描模式（掃 data/events/*.json 現況，不生成不修改）
# ---------------------------------------------------------------------------

def load_year_file(year: int) -> dict:
    path = EVENTS_DIR / f"{year}.json"
    if not path.exists():
        return {"year": year, "months": {}}
    return json.loads(path.read_text(encoding="utf-8"))


def scan(years: list[int] | None, run_llm: bool) -> int:
    if years is None:
        years = sorted(
            int(p.stem) for p in EVENTS_DIR.glob("*.json")
            if p.stem.isdigit()
        )
    total_cards = 0
    total_blacklist_hits = 0
    total_llm_flags = 0
    for year in years:
        data = load_year_file(year)
        months = data.get("months", {})
        for month, cards in sorted(months.items()):
            for card in cards:
                total_cards += 1
                hits = check_card_blacklist(card)
                if hits:
                    total_blacklist_hits += 1
                    print(f"[BLACKLIST] {month} {card.get('id')}: 命中 {hits}")
            if run_llm and cards:
                try:
                    verdicts = llm_review_batch(month, cards)
                except TooManyFailures:
                    raise
                except Exception as e:
                    print(f"[ERROR] {month} LLM 複審失敗：{e}")
                    continue
                for cid, v in verdicts.items():
                    if v["flagged"]:
                        total_llm_flags += 1
                        print(f"[LLM-FLAG] {month} {cid}: {v['reason']}")
    print(f"\n--- 掃描完成：{total_cards} 張卡，黑名單命中 {total_blacklist_hits} 張，"
          f"LLM 複審打回 {total_llm_flags if run_llm else 'N/A（--no-llm）'} 張 ---")
    return 0 if (total_blacklist_hits == 0 and total_llm_flags == 0) else 1


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except AttributeError:
            pass
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--year", type=int, default=None, help="只掃指定年份")
    parser.add_argument("--no-llm", action="store_true", help="只跑黑名單比對，不打 LLM 複審")
    args = parser.parse_args()
    years = [args.year] if args.year else None
    try:
        return scan(years, run_llm=not args.no_llm)
    except TooManyFailures as e:
        print(f"[ABORT] {e}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
