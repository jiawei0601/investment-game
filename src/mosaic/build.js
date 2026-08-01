// build.js — M(mosaic) row generator: 馬賽克模式的 dailyRows 產生器
// (ADR 0009, docs/SPEC.md §2 「馬賽克模式」).
//
// Pure function, zero engine/UI coupling: buildMosaicRows({attempt, dailyRows,
// monthsTarget, sampling}) -> {rows, meta}. `rows` has the exact same shape
// as data/daily/TX.json's rows (date/open/high/low/close/volume/contract,
// +settle iff the source dailyRows carries a settle field at all) and is fed
// straight into src/game/session.js's createSession({dailyRows: rows, ...})
// unmodified — mosaic is "just" a dailyRows producer, session/margin/behavior
// are zero-touched (ADR 0009 §2).
//
// Determinism (AGENTS.md 種子慣例): every draw in this module comes from a
// single createRng(buildSeed('mosaic', attempt, 'splice')) stream, consumed
// in a fixed order (start-index draw, then per splice-block: regime draw
// (markov only) -> source-month draw). Never Math.random(). Same attempt ->
// byte-identical output; different attempt -> (virtually certainly)
// different output.
//
// Shape of the algorithm (ADR 0009 §決策 1-3):
//   1. 種子抽起始日 (leaves ~60 real trading days of lookback context before
//      it for the chart, and >=300 real trading days of tail room — soft
//      constraint, relaxed automatically on small fixtures/tests).
//   2. 暖示段：~21 real trading days copied verbatim from that start index.
//   3. 拼接段：repeatedly splice a whole historical month-block (scaled by a
//      single anchor multiplier per block, so the block's own internal shape
//      — its log-return structure — survives untouched) until warmup+spliced
//      length >= monthsTarget * ~21 trading days.
//   4. Month-block sampling defaults to a regime-conditioned Markov chain
//      (coordinator revision, 2026-08-02: uniform sampling breaks real
//      up/down-run dynamics — a market that was falling doesn't have a flat
//      25% chance of falling again next block) — see pickNextRegime below.
//      `sampling: 'uniform'` is kept for A/B comparison in tests only.
import { buildSeed, createRng } from '../engine/rng.js';
import { isSettlementDay } from '../margin/index.js';

export function buildMosaicRows({ attempt, dailyRows, monthsTarget = 6, sampling = 'markov' }) {
  if (!Array.isArray(dailyRows) || dailyRows.length === 0) {
    throw new Error('buildMosaicRows: dailyRows must be a non-empty array');
  }
  // 台指期史上有極少數真實「補假交易日」落在週六（TAIFEX 颱風假等順延補
  // 上的盤，data/daily/TX.json 裡就有 2017-06-03、2017-09-30 兩筆）。馬賽克
  // 模式的日期序列本質上是抽象的交易日曆標籤（拼接段甚至跟當天真實 OHLC
  // 完全脫鉤），不是要求玩家去經歷歷史特例，所以這裡整套只在「平日」子集
  // 上運作（月塊分組／起始日抽樣／暖示照抄／日期序列延伸），讓「日期嚴格
  // 遞增且無週末」對整條輸出序列恆成立，而不是「幾乎恆成立」。真實對局模
  // 式（劇本／無限）不經過這個模組，完全不受影響。
  const sorted = [...dailyRows]
    .filter((r) => !isWeekendDate(r.date))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const rng = createRng(buildSeed('mosaic', attempt, 'splice'));

  const hasSettleField = sorted.some((r) => typeof r.settle === 'number');

  // ---- month-block bookkeeping (built once, over the FULL history — the
  // splice pool is "全部歷史月份", not just what's after the start date) ----
  const monthMap = groupByMonth(sorted);
  const monthKeysSorted = [...monthMap.keys()].sort();
  const eligibleKeys = monthKeysSorted.filter((k) => monthMap.get(k).length >= 15);
  if (eligibleKeys.length === 0) {
    throw new Error('buildMosaicRows: no eligible month blocks (>=15 trading days) in dailyRows');
  }

  const statsByMonth = new Map(monthKeysSorted.map((k) => [k, computeMonthStats(monthMap.get(k))]));
  const volMedian = median(eligibleKeys.map((k) => statsByMonth.get(k).dailyStd));
  const regimeByMonth = new Map(monthKeysSorted.map((k) => [k, classifyRegime(statsByMonth.get(k), volMedian)]));

  const poolByRegime = { up_calm: [], up_vol: [], down_calm: [], down_vol: [] };
  for (const k of eligibleKeys) poolByRegime[regimeByMonth.get(k)].push(k);

  const matrix = buildTransitionMatrix(monthKeysSorted, regimeByMonth);

  // ---- 1. pick start index ----
  const minStart = Math.min(60, Math.max(0, sorted.length - 1));
  let maxStart = sorted.length - 300;
  if (maxStart < minStart) maxStart = Math.max(minStart, sorted.length - 1);
  const idx = minStart + Math.floor(rng() * (maxStart - minStart + 1));
  const startDate = sorted[idx].date;

  // ---- 2. warmup: real trading days copied verbatim ----
  const warmupCount = Math.min(21, sorted.length - idx);
  const warmupRows = sorted.slice(idx, idx + warmupCount).map((r) => normalizeRealRow(r, hasSettleField));

  // ---- 3. splice loop ----
  const targetLen = monthsTarget * 21;
  const lastWarmup = warmupRows[warmupRows.length - 1];
  let dateCursorIdx = idx + warmupCount;
  let prevDate = lastWarmup.date;
  let anchorPrice = lastWarmup.close;
  let contractCursor = parseContract(lastWarmup.contract);
  let prevSourceMonth = null;
  // 初始體制＝暖示月（起始日所在真實月份）的體制；若該月份因故未落在
  // regimeByMonth（理論上不會，monthMap 覆蓋 sorted 的每個月）就退回第一個
  // 有資格抽樣的月份的體制，純粹是防禦寫法。
  let currentRegime = regimeByMonth.get(monthKey(startDate)) ?? regimeByMonth.get(eligibleKeys[0]);

  const sourceMonths = [];
  const splicedRows = [];
  let total = warmupRows.length;

  while (total < targetLen) {
    let pool;
    let nextRegime = null;
    if (sampling === 'markov') {
      nextRegime = pickNextRegime(rng, matrix, currentRegime);
      pool = poolByRegime[nextRegime];
      if (!pool || pool.length === 0) pool = eligibleKeys; // fallback for thin/small fixtures
    } else {
      pool = eligibleKeys;
    }

    const candidates = pool.length > 1 && prevSourceMonth ? pool.filter((k) => k !== prevSourceMonth) : pool;
    const pick = candidates[Math.floor(rng() * candidates.length)];
    prevSourceMonth = pick;
    if (sampling === 'markov') currentRegime = nextRegime;
    sourceMonths.push(pick);

    const sourceRows = monthMap.get(pick);
    const blockFirstOpen = sourceRows[0].open;

    for (const r of sourceRows) {
      const scale = (x) => anchorPrice * (x / blockFirstOpen);
      let o = Math.round(scale(r.open));
      let h = Math.round(scale(r.high));
      let l = Math.round(scale(r.low));
      let c = Math.round(scale(r.close));
      h = Math.max(h, o, c);
      l = Math.min(l, o, c);

      let date;
      if (dateCursorIdx < sorted.length) {
        date = sorted[dateCursorIdx].date;
        dateCursorIdx++;
      } else {
        date = nextWeekday(prevDate);
      }

      if (isSettlementDay(prevDate)) contractCursor = incMonth(contractCursor);
      const contract = formatContract(contractCursor);

      const row = { date, open: o, high: h, low: l, close: c, volume: r.volume, contract };
      if (hasSettleField) row.settle = Math.round(scale(r.settle ?? r.close));

      splicedRows.push(row);
      prevDate = date;
    }

    anchorPrice = splicedRows[splicedRows.length - 1].close;
    total += sourceRows.length;
  }

  const rows = [...warmupRows, ...splicedRows];
  const meta = { startDate, warmupEndIndex: warmupRows.length, sourceMonths };
  return { rows, meta };
}

// ------------------------------------------------------------------ helpers

function monthKey(dateStr) {
  return dateStr.slice(0, 7);
}

function groupByMonth(sortedRows) {
  const map = new Map();
  for (const r of sortedRows) {
    const k = monthKey(r.date);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

function normalizeRealRow(r, hasSettleField) {
  const row = { date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume, contract: r.contract };
  if (hasSettleField) row.settle = typeof r.settle === 'number' ? r.settle : r.close;
  return row;
}

// 月統計：月對數報酬（塊首開->塊尾收）＋ 月內日對數報酬標準差（樣本標準
// 差，n-1；區塊天數 >=2 恆成立，因為呼叫端只對 groupByMonth 產出的真實月份
// 呼叫，最短的真實月至少有數個交易日）。
function computeMonthStats(rows) {
  const monthLogReturn = Math.log(rows[rows.length - 1].close / rows[0].open);
  const dailyLogReturns = [];
  for (let i = 1; i < rows.length; i++) {
    dailyLogReturns.push(Math.log(rows[i].close / rows[i - 1].close));
  }
  const dailyStd = stddev(dailyLogReturns);
  return { monthLogReturn, dailyStd };
}

function stddev(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function classifyRegime(stats, volMedian) {
  const sign = stats.monthLogReturn >= 0 ? 'up' : 'down';
  const vol = stats.dailyStd >= volMedian ? 'vol' : 'calm';
  return `${sign}_${vol}`;
}

const REGIME_STATES = ['up_calm', 'up_vol', 'down_calm', 'down_vol'];

function isNextCalendarMonth(a, b) {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return ay * 12 + am + 1 === by * 12 + bm;
}

// 4x4 轉移矩陣：只計真實相鄰月（跨資料缺口不算），Laplace +1 平滑後逐列歸
// 一化。用「全部」真實月份（不限於 eligibleKeys）算轉移動態本身，抽樣池
// （eligibleKeys）是另一件事——避免因為排除掉的殘月，扭曲了真實世界的體制
// 轉移機率。
function buildTransitionMatrix(monthKeysSorted, regimeByMonth) {
  const counts = REGIME_STATES.map(() => REGIME_STATES.map(() => 1));
  for (let i = 0; i < monthKeysSorted.length - 1; i++) {
    const a = monthKeysSorted[i];
    const b = monthKeysSorted[i + 1];
    if (!isNextCalendarMonth(a, b)) continue;
    const ra = regimeByMonth.get(a);
    const rb = regimeByMonth.get(b);
    counts[REGIME_STATES.indexOf(ra)][REGIME_STATES.indexOf(rb)]++;
  }
  return counts.map((row) => {
    const sum = row.reduce((a, b) => a + b, 0);
    return row.map((v) => v / sum);
  });
}

function pickNextRegime(rng, matrix, currentRegime) {
  const rowIdx = Math.max(0, REGIME_STATES.indexOf(currentRegime));
  const probs = matrix[rowIdx];
  const draw = rng();
  let cum = 0;
  for (let i = 0; i < REGIME_STATES.length; i++) {
    cum += probs[i];
    if (draw <= cum) return REGIME_STATES[i];
  }
  return REGIME_STATES[REGIME_STATES.length - 1];
}

function parseContract(str) {
  return { y: Number(String(str).slice(0, 4)), m: Number(String(str).slice(4, 6)) };
}

function incMonth({ y, m }) {
  const nm = m + 1;
  return nm > 12 ? { y: y + 1, m: 1 } : { y, m: nm };
}

function formatContract({ y, m }) {
  return `${y}${String(m).padStart(2, '0')}`;
}

function isWeekendDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 || dow === 6;
}

// 日期軸延伸：真實 dailyRows 的日期序列先用（正常情況下 300 個交易日的尾端
// 保留量足夠涵蓋大多數局長），只有真的用盡時才用「跳過週六日的下一個平
// 日」規則合成——不處理國定假日順延，與 src/margin/calendar.js 的
// isSettlementDay 簡化假設一致（同一份簡化，不多開一套規則）。
function nextWeekday(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  let date = new Date(Date.UTC(y, m - 1, d));
  do {
    date = new Date(date.getTime() + 86400000);
  } while (date.getUTCDay() === 0 || date.getUTCDay() === 6);
  const yy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

// 測試專用匯出：不是穩定公開 API，只是讓 tests/mosaic.test.js 能直接對
// buildMosaicRows() 內部用到的「月統計/體制分類/轉移矩陣」三個純函數單獨
// 驗證（例如「轉移矩陣每列和＝1」），不用整個反推 buildMosaicRows 的完整
// 輸出。
export const _internals = {
  monthKey,
  groupByMonth,
  computeMonthStats,
  classifyRegime,
  buildTransitionMatrix,
  median,
  REGIME_STATES,
  isWeekendDate,
};
