// data.js — M5 UI static data loading (AGENTS.md 資料慣例: 一切靜態 JSON, fetch
// 不打外部 API). Missing per-year event files must be skipped gracefully
// ("事件卡全量還在生成中" per the M5 task brief) — a 404 on data/events/YYYY.json
// is not an error, it just means that year has no cards yet.

async function fetchJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`fetchJson: ${path} -> HTTP ${res.status}`);
  return res.json();
}

// Loads the three always-required datasets. chips.json/macro.json are
// allowed to be structurally present-but-thin (chips only starts 2018-06-05,
// see tools/README.md) — they are NOT allowed to be entirely missing (M1 is
// done), so a fetch failure here is a real error, unlike the per-year event
// files below.
export async function loadCoreData() {
  const [tx, chips, macro] = await Promise.all([
    fetchJson('data/daily/TX.json'),
    fetchJson('data/chips.json'),
    fetchJson('data/macro.json'),
  ]);
  return { dailyRows: tx.rows, chipsRows: chips.rows, macro };
}

const eventsCache = new Map(); // year (string) -> parsed file | null (missing)

async function loadEventsYear(year) {
  if (eventsCache.has(year)) return eventsCache.get(year);
  let data = null;
  try {
    data = await fetchJson(`data/events/${year}.json`);
  } catch {
    data = null; // year file not generated yet — skip, not an error (AGENTS.md)
  }
  eventsCache.set(year, data);
  return data;
}

// Returns the array of event cards for one 'YYYY-MM' month, or [] if that
// year's file doesn't exist yet or has no cards for that month.
export async function loadEventsForMonth(monthStr) {
  const year = monthStr.slice(0, 4);
  const yearData = await loadEventsYear(year);
  return yearData?.months?.[monthStr] ?? [];
}

export function chipsForDate(chipsRows, date) {
  return chipsRows.find((r) => r.date === date) ?? null;
}
