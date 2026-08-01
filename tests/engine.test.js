// tests/engine.test.js — M2 statistical + unit test suite for the
// brownian-bridge intraday generator (AGENTS.md 測試慣例 / SPEC §1, ADR 0008).
// Run with: node --test tests/engine.test.js  (Node built-in test runner,
// zero dependencies, per project convention: no build step / no deps).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildSeed, createRng } from '../src/engine/rng.js';
import { generateIntraday, BARS_PER_DAY } from '../src/engine/intraday.js';

const TX_PATH = fileURLToPath(new URL('../data/daily/TX.json', import.meta.url));
const TX = JSON.parse(readFileSync(TX_PATH, 'utf8'));
const ROWS = TX.rows;

const PRICE_TOL = (price) => 1e-9 * price;

function pickSample(targetCount) {
  const byDate = new Map(ROWS.map((r) => [r.date, r]));
  const forced = ROWS.filter(
    (r) => r.date.startsWith('2020-03') || r.date.startsWith('2024-08')
  );
  const forcedDates = new Set(forced.map((r) => r.date));
  const remainingSlots = Math.max(0, targetCount - forced.length);
  const stride = Math.max(1, Math.floor(ROWS.length / remainingSlots));
  const sampled = [...forced];
  for (let i = 0; i < ROWS.length && sampled.length < targetCount; i += stride) {
    const r = ROWS[i];
    if (!forcedDates.has(r.date)) sampled.push(r);
  }
  // De-dupe defensively, keep deterministic order by date.
  const uniq = [...new Map(sampled.map((r) => [r.date, r])).values()];
  uniq.sort((a, b) => (a.date < b.date ? -1 : 1));
  return uniq.map((r) => byDate.get(r.date));
}

const SAMPLE_DAYS = pickSample(200);

function assertHardConstraints(row, bars, label) {
  assert.equal(bars.length, BARS_PER_DAY, `${label}: expected 60 bars`);
  assert.equal(bars[0].o, row.open, `${label}: open mismatch`);
  assert.equal(bars[BARS_PER_DAY - 1].c, row.close, `${label}: close mismatch`);

  let maxH = -Infinity;
  let minL = Infinity;
  for (let i = 0; i < bars.length; i++) {
    maxH = Math.max(maxH, bars[i].h);
    minL = Math.min(minL, bars[i].l);
    assert.ok(bars[i].h >= bars[i].o && bars[i].h >= bars[i].c, `${label}: bar ${i} h below body`);
    assert.ok(bars[i].l <= bars[i].o && bars[i].l <= bars[i].c, `${label}: bar ${i} l above body`);
    if (i > 0) {
      assert.ok(
        Math.abs(bars[i - 1].c - bars[i].o) <= PRICE_TOL(row.close),
        `${label}: bar ${i - 1}->${i} not contiguous (c=${bars[i - 1].c}, o=${bars[i].o})`
      );
    }
  }
  assert.ok(
    Math.abs(maxH - row.high) <= PRICE_TOL(row.high),
    `${label}: max(h)=${maxH} !== real high=${row.high}`
  );
  assert.ok(
    Math.abs(minL - row.low) <= PRICE_TOL(row.low),
    `${label}: min(l)=${minL} !== real low=${row.low}`
  );
}

// ---------------------------------------------------------------------------
// 1. Determinism
// ---------------------------------------------------------------------------

test('rng: same seed produces identical draw sequence', () => {
  const rngA = createRng('level1|1|2020-03-16');
  const rngB = createRng('level1|1|2020-03-16');
  const seqA = Array.from({ length: 20 }, () => rngA());
  const seqB = Array.from({ length: 20 }, () => rngB());
  assert.deepEqual(seqA, seqB);
});

test('rng: different seeds produce different draw sequences', () => {
  const rngA = createRng('level1|1|2020-03-16');
  const rngB = createRng('level1|2|2020-03-16');
  const seqA = Array.from({ length: 20 }, () => rngA());
  const seqB = Array.from({ length: 20 }, () => rngB());
  assert.notDeepEqual(seqA, seqB);
});

test('generateIntraday: same seed -> byte-identical output (determinism)', () => {
  const row = ROWS.find((r) => r.date === '2020-03-16');
  const seed = buildSeed('epidemic', 1, row.date);
  const barsA = generateIntraday(row, seed);
  const barsB = generateIntraday(row, seed);
  assert.deepEqual(barsA, barsB);
});

test('generateIntraday: different attempt (replay seed) -> different output', () => {
  const row = ROWS.find((r) => r.date === '2020-03-16');
  const seedAttempt1 = buildSeed('epidemic', 1, row.date);
  const seedAttempt2 = buildSeed('epidemic', 2, row.date);
  const barsA = generateIntraday(row, seedAttempt1);
  const barsB = generateIntraday(row, seedAttempt2);
  assert.notDeepEqual(barsA, barsB);
});

test('generateIntraday: log-space anchors — bar[0].o and bar[59].c pin to log(O)->log(C) endpoints', () => {
  const row = ROWS.find((r) => r.date === '2017-05-02');
  const seed = buildSeed('flat', 1, row.date);
  const bars = generateIntraday(row, seed);
  assert.equal(bars[0].o, row.open);
  assert.equal(bars[BARS_PER_DAY - 1].c, row.close);
});

// ---------------------------------------------------------------------------
// 1b. Seed hygiene (AGENTS.md 種子慣例): '|' is the field separator, so no
// part of the seed may contain it.
// ---------------------------------------------------------------------------

test('buildSeed: throws when levelId contains the "|" field separator', () => {
  assert.throws(() => buildSeed('epi|demic', 1, '2020-03-16'), /must not contain/);
});

test('buildSeed: throws when date contains the "|" field separator', () => {
  assert.throws(() => buildSeed('epidemic', 1, '2020-03|16'), /must not contain/);
});

test('buildSeed: ordinary levelId/attempt/date pass through unchanged', () => {
  assert.equal(buildSeed('epidemic', 1, '2020-03-16'), 'epidemic|1|2020-03-16');
});

// ---------------------------------------------------------------------------
// 1c. RNG distributional sanity — chi-square goodness-of-fit on the first
// draw's decile bucket across many independent seeds. Not a full PRNG
// battery (cyrb128+sfc32 are cited public-domain algorithms, ADR 0008: "不
// 要動"), just a smoke test that seed hashing doesn't introduce an obvious
// skew.
// ---------------------------------------------------------------------------

test('rng: first-draw decile distribution passes a chi-square uniformity check', () => {
  const N = 20000;
  const buckets = new Array(10).fill(0);
  for (let i = 0; i < N; i++) {
    const rng = createRng(`chi2|${i}|2020-01-01`);
    const x = rng();
    const b = Math.min(9, Math.max(0, Math.floor(x * 10)));
    buckets[b]++;
  }
  const expected = N / 10;
  let chi2 = 0;
  for (const c of buckets) chi2 += ((c - expected) * (c - expected)) / expected;
  // df=9; critical value at alpha=0.001 is 27.88. Use a generous margin
  // above that to avoid flakiness while still catching a real skew.
  console.log(`chi2 uniformity: ${chi2.toFixed(3)} (buckets=${JSON.stringify(buckets)})`);
  assert.ok(chi2 < 35, `chi-square statistic ${chi2} indicates non-uniform first draws`);
});

// ---------------------------------------------------------------------------
// 2. OHLC reconstruction — 200-day sample (fast) and full 4062-day dataset
// (ADR 0008 requires a full-dataset scan with zero violations, not just a
// sample).
// ---------------------------------------------------------------------------

test(`generateIntraday: OHLC reconstruction holds exactly across ${SAMPLE_DAYS.length} sampled trading days`, () => {
  assert.ok(SAMPLE_DAYS.length >= 190, 'sample should be close to the requested 200 days');
  let failures = 0;
  for (const row of SAMPLE_DAYS) {
    const seed = buildSeed('m2-ohlc-check', 1, row.date);
    const bars = generateIntraday(row, seed);
    try {
      assertHardConstraints(row, bars, row.date);
    } catch (err) {
      failures++;
      console.error(err.message);
    }
  }
  assert.equal(failures, 0, `${failures}/${SAMPLE_DAYS.length} days failed OHLC reconstruction`);
});

test(`generateIntraday: hard-constraint scan across the full ${ROWS.length}-day dataset — 0 violations`, () => {
  let failures = 0;
  const failedDates = [];
  for (const row of ROWS) {
    const seed = buildSeed('m2-full-scan', 1, row.date);
    const bars = generateIntraday(row, seed);
    try {
      assertHardConstraints(row, bars, row.date);
    } catch (err) {
      failures++;
      failedDates.push(row.date);
    }
  }
  console.log(`full-dataset hard-constraint scan: ${failures}/${ROWS.length} failures`);
  assert.equal(
    failures,
    0,
    `${failures}/${ROWS.length} days failed hard constraints: ${failedDates.slice(0, 10).join(', ')}`
  );
});

// ---------------------------------------------------------------------------
// 3. Parkinson volatility consistency — ADR 0008 decision 3: mean ratio must
// fall in [0.9, 1.1] (tightened from the pre-review [0.7, 1.3]), and the
// per-day guard is a proportion bound (ratio>2.5 in <0.5% of days) rather
// than a hard per-day cap.
// ---------------------------------------------------------------------------

function parkinsonSigma(high, low) {
  return Math.log(high / low) / (2 * Math.sqrt(Math.log(2)));
}

function realizedSigma(bars) {
  // Realized volatility of the generated knot path: sqrt(sum of squared
  // log-returns) across all 60 bar-to-bar closes, comparable to the
  // day-level Parkinson sigma estimate.
  let sumSq = 0;
  let prev = bars[0].o;
  for (const bar of bars) {
    const r = Math.log(bar.c / prev);
    sumSq += r * r;
    prev = bar.c;
  }
  return Math.sqrt(sumSq);
}

function computeRatios(rows, seedTag) {
  const ratios = [];
  for (const row of rows) {
    if (row.high === row.low) continue; // flat day: sigma target is 0, ratio undefined
    const seed = buildSeed(seedTag, 1, row.date);
    const bars = generateIntraday(row, seed);
    const target = parkinsonSigma(row.high, row.low);
    const realized = realizedSigma(bars);
    ratios.push({ date: row.date, ratio: realized / target });
  }
  return ratios;
}

test('generateIntraday: realized/target Parkinson sigma mean ratio within [0.9, 1.1] over 200 sampled days', () => {
  const ratios = computeRatios(SAMPLE_DAYS, 'm2-vol-check');
  const avgRatio = ratios.reduce((a, b) => a + b.ratio, 0) / ratios.length;
  const over25 = ratios.filter((r) => r.ratio > 2.5);
  console.log(`Parkinson ratio (200-day sample): avg=${avgRatio.toFixed(3)}`);
  assert.ok(
    avgRatio >= 0.9 && avgRatio <= 1.1,
    `average realized/target sigma ratio ${avgRatio} outside [0.9, 1.1]`
  );
  assert.ok(
    over25.length / ratios.length < 0.005,
    `${over25.length}/${ratios.length} days have ratio>2.5 (>=0.5%): ${JSON.stringify(over25)}`
  );
});

test(`generateIntraday: realized/target Parkinson sigma mean ratio within [0.9, 1.1] over the full ${ROWS.length}-day dataset`, () => {
  const ratios = computeRatios(ROWS, 'm2-vol-full-scan');
  const avgRatio = ratios.reduce((a, b) => a + b.ratio, 0) / ratios.length;
  const over25 = ratios.filter((r) => r.ratio > 2.5);
  const over25Pct = (100 * over25.length) / ratios.length;
  console.log(
    `Parkinson ratio (full ${ratios.length}-day dataset): avg=${avgRatio.toFixed(4)}, ` +
      `ratio>2.5: ${over25.length} (${over25Pct.toFixed(3)}%)`
  );
  assert.ok(
    avgRatio >= 0.9 && avgRatio <= 1.1,
    `average realized/target sigma ratio ${avgRatio} outside [0.9, 1.1]`
  );
  assert.ok(
    over25.length / ratios.length < 0.005,
    `${over25.length}/${ratios.length} (${over25Pct.toFixed(3)}%) days have ratio>2.5 (>=0.5%)`
  );
});

// ---------------------------------------------------------------------------
// 4. Boundary cases
// ---------------------------------------------------------------------------

test('boundary: 一字線 (O=H=L=C) day produces 60 flat bars', () => {
  const row = { date: '2099-01-01', open: 10000, high: 10000, low: 10000, close: 10000 };
  const seed = buildSeed('boundary', 1, row.date);
  const bars = generateIntraday(row, seed);
  assert.equal(bars.length, BARS_PER_DAY);
  for (const bar of bars) {
    assert.equal(bar.o, 10000);
    assert.equal(bar.h, 10000);
    assert.equal(bar.l, 10000);
    assert.equal(bar.c, 10000);
  }
});

test('boundary: 跳空巨量日 2024-08-05 (real data, L=C gap-down day)', () => {
  const row = ROWS.find((r) => r.date === '2024-08-05');
  assert.ok(row, 'fixture day 2024-08-05 must exist in TX.json');
  assert.equal(row.low, row.close, 'sanity: this fixture is expected to have L=C');
  const seed = buildSeed('crash', 1, row.date);
  const bars = generateIntraday(row, seed);
  assertHardConstraints(row, bars, '2024-08-05');
});

test('boundary: synthetic H=O day (high occurs at the open)', () => {
  const row = { date: '2099-02-01', open: 10500, high: 10500, low: 10200, close: 10350 };
  const seed = buildSeed('boundary', 1, row.date);
  const bars = generateIntraday(row, seed);
  assertHardConstraints(row, bars, 'H=O synthetic');
});

test('boundary: synthetic L=C day (low occurs at the close)', () => {
  const row = { date: '2099-02-02', open: 10500, high: 10700, low: 10200, close: 10200 };
  const seed = buildSeed('boundary', 1, row.date);
  const bars = generateIntraday(row, seed);
  assertHardConstraints(row, bars, 'L=C synthetic');
});

test('boundary: synthetic H=C day (high occurs at the close)', () => {
  const row = { date: '2099-02-03', open: 10200, high: 10700, low: 10100, close: 10700 };
  const seed = buildSeed('boundary', 1, row.date);
  const bars = generateIntraday(row, seed);
  assertHardConstraints(row, bars, 'H=C synthetic');
});

test('boundary: synthetic L=O day (low occurs at the open)', () => {
  const row = { date: '2099-02-04', open: 10100, high: 10700, low: 10100, close: 10500 };
  const seed = buildSeed('boundary', 1, row.date);
  const bars = generateIntraday(row, seed);
  assertHardConstraints(row, bars, 'L=O synthetic');
});

// ---------------------------------------------------------------------------
// 5. Rejection sampling + shrink-sigma fallback (ADR 0008 decision 2:
// replaces the old clip-to-flatline fallback).
// ---------------------------------------------------------------------------

test('rejection sampling: normal volatility still reconstructs OHLC exactly (accept-path coverage)', () => {
  const row = ROWS.find((r) => r.date === '2020-03-19'); // COVID low, high realized vol day
  const seed = buildSeed('rejection-normal', 1, row.date);
  const bars = generateIntraday(row, seed);
  assertHardConstraints(row, bars, '2020-03-19 (normal sigma)');
});

test('shrink fallback: extreme sigmaMultiplier forces the retry budget to exhaust, hard constraints still hold', () => {
  const row = ROWS.find((r) => r.date === '2020-03-19');
  const seed = buildSeed('rejection-extreme', 1, row.date);
  // sigmaMultiplier this large makes every one of the 50 rejection-sampling
  // attempts breach the [low, high] bound almost surely at the initial
  // sigma, forcing the shrink-and-retry fallback branch. The generator must
  // still satisfy every hard constraint even when shrinking kicks in.
  const bars = generateIntraday(row, seed, { sigmaMultiplier: 200 });
  assertHardConstraints(row, bars, '2020-03-19 (sigmaMultiplier=200, shrink forced)');
});

function maxConsecutiveBoundaryPin(row, bars) {
  // A "flatline platform" = consecutive bars whose body AND wick collapse
  // onto exactly the day's high or low (the old clip-fallback defect).
  let consec = 0;
  let maxConsec = 0;
  for (const bar of bars) {
    const pinned =
      bar.h === bar.l && (bar.h === row.low || bar.h === row.high);
    if (pinned) {
      consec++;
      maxConsec = Math.max(maxConsec, consec);
    } else {
      consec = 0;
    }
  }
  return maxConsec;
}

test('shrink fallback: known former-clip days (2020-05-14, 2017-01-23, 2010-06-03, 2015-10-29) produce no boundary flatline platform', () => {
  const byDate = new Map(ROWS.map((r) => [r.date, r]));
  const dates = ['2020-05-14', '2017-01-23', '2010-06-03', '2015-10-29'];
  for (const date of dates) {
    const row = byDate.get(date);
    assert.ok(row, `fixture day ${date} must exist in TX.json`);
    const seed = buildSeed('clip-case-check', 1, date);
    const bars = generateIntraday(row, seed);
    assertHardConstraints(row, bars, date);
    const maxConsec = maxConsecutiveBoundaryPin(row, bars);
    assert.ok(maxConsec <= 3, `${date}: ${maxConsec} consecutive bars pinned to the boundary`);
  }
});

test(`shrink fallback: no day in the full ${ROWS.length}-day dataset produces a >3-bar boundary flatline platform`, () => {
  let flatlineDays = 0;
  const flatlineDates = [];
  for (const row of ROWS) {
    if (row.open === row.high && row.high === row.low && row.low === row.close) continue; // genuine 一字線, not a defect
    const seed = buildSeed('flatline-full-scan', 1, row.date);
    const bars = generateIntraday(row, seed);
    if (maxConsecutiveBoundaryPin(row, bars) > 3) {
      flatlineDays++;
      flatlineDates.push(row.date);
    }
  }
  console.log(`full-dataset flatline scan: ${flatlineDays}/${ROWS.length} days`);
  assert.equal(
    flatlineDays,
    0,
    `${flatlineDays} day(s) produced a boundary flatline platform: ${flatlineDates.slice(0, 10).join(', ')}`
  );
});

test('generateIntraday: throws on invalid OHLC (low > open)', () => {
  assert.throws(() => {
    generateIntraday({ open: 100, high: 110, low: 105, close: 108 }, 'bad|1|2099-01-01');
  }, /OHLC invariant violated/);
});

// ---------------------------------------------------------------------------
// 6. H/L placement & ordering distribution (ADR 0008 decision 1) — the core
// fix under review. Uniform 50/50 placement is wrong; the conditional
// Brownian-bridge weighting must reproduce strongly skewed probabilities on
// trend days.
// ---------------------------------------------------------------------------

// Draw n pseudo-random, non-linearly-related attempt tokens from an
// independent meta-RNG (rather than using the trial counter 1..n directly
// as the "attempt" field). This rules out any residual PRNG-sequence
// correlation across adjacent trials showing up as a spurious pattern in
// the H/L-ordering statistics — even though cyrb128's avalanche hashing
// should already scramble linearly-adjacent seed strings independently
// (GLM review 2026-08-02, finding 4).
function metaSeededAttemptTokens(n, metaTag) {
  const metaRng = createRng(`meta|${metaTag}`);
  const tokens = new Array(n);
  for (let i = 0; i < n; i++) {
    tokens[i] = Math.floor(metaRng() * 4294967296).toString(36);
  }
  return tokens;
}

function firstHProbability(row, n, seedTag) {
  const attempts = metaSeededAttemptTokens(n, seedTag);
  let firstH = 0;
  for (const attempt of attempts) {
    const seed = buildSeed(seedTag, attempt, row.date);
    const bars = generateIntraday(row, seed);
    let idxH = -1;
    let idxL = -1;
    for (let i = 0; i < bars.length; i++) {
      if (idxH === -1 && bars[i].h === row.high) idxH = i;
      if (idxL === -1 && bars[i].l === row.low) idxL = i;
    }
    if (idxH < idxL) firstH++;
  }
  return firstH / n;
}

test('H/L ordering: 2010-03-17 (open near low, close near high) — P(H first) ~ 0', () => {
  const row = ROWS.find((r) => r.date === '2010-03-17');
  assert.ok(row, 'fixture day 2010-03-17 must exist in TX.json');
  const p = firstHProbability(row, 2000, 'anchor-2010-03-17');
  console.log(`P(H first) for 2010-03-17 = ${p}`);
  assert.ok(p < 0.05, `expected P(H first) ~0 for an open-low/close-high day, got ${p}`);
});

test('H/L ordering: 2010-01-20 (open near high, close near low) — P(H first) ~ 1', () => {
  const row = ROWS.find((r) => r.date === '2010-01-20');
  assert.ok(row, 'fixture day 2010-01-20 must exist in TX.json');
  const p = firstHProbability(row, 2000, 'anchor-2010-01-20');
  console.log(`P(H first) for 2010-01-20 = ${p}`);
  assert.ok(p > 0.95, `expected P(H first) ~1 for an open-high/close-low day, got ${p}`);
});

test('H/L ordering: open-low/close-high days skew toward "H last" across a real-data sample', () => {
  // General directional check (not just the two named anchor days): among
  // sampled days where open sits closer to the low and close sits closer to
  // the high than the reverse, the conditional model should, on average,
  // place the low before the high far more often than chance.
  const candidates = SAMPLE_DAYS.filter((r) => {
    if (r.high === r.low) return false;
    const range = r.high - r.low;
    const openNearLow = (r.open - r.low) / range < 0.15;
    const closeNearHigh = (r.high - r.close) / range < 0.15;
    return openNearLow && closeNearHigh;
  }).slice(0, 15);
  assert.ok(candidates.length >= 5, `expected at least 5 open-low/close-high sample days, got ${candidates.length}`);
  let belowHalfCount = 0;
  for (const row of candidates) {
    const p = firstHProbability(row, 300, `dir-check-${row.date}`);
    if (p < 0.5) belowHalfCount++;
  }
  assert.ok(
    belowHalfCount / candidates.length >= 0.8,
    `expected most open-low/close-high days to have P(H first) < 0.5, got ${belowHalfCount}/${candidates.length}`
  );
});

test('H/L ordering: open-high/close-low days skew toward "H first" across a real-data sample', () => {
  const candidates = SAMPLE_DAYS.filter((r) => {
    if (r.high === r.low) return false;
    const range = r.high - r.low;
    const openNearHigh = (r.high - r.open) / range < 0.15;
    const closeNearLow = (r.close - r.low) / range < 0.15;
    return openNearHigh && closeNearLow;
  }).slice(0, 15);
  assert.ok(candidates.length >= 5, `expected at least 5 open-high/close-low sample days, got ${candidates.length}`);
  let aboveHalfCount = 0;
  for (const row of candidates) {
    const p = firstHProbability(row, 300, `dir-check2-${row.date}`);
    if (p > 0.5) aboveHalfCount++;
  }
  assert.ok(
    aboveHalfCount / candidates.length >= 0.8,
    `expected most open-high/close-low days to have P(H first) > 0.5, got ${aboveHalfCount}/${candidates.length}`
  );
});

// ---------------------------------------------------------------------------
// 7. Natural wicks (ADR 0008 decision 4) — bars must not all be pure bodies,
// and the day's extreme wick must actually touch the real H/L.
// ---------------------------------------------------------------------------

test('generateIntraday: bars carry natural wicks (not all pure-body candles) across sampled days', () => {
  let daysWithAnyWick = 0;
  let barsWithWick = 0;
  let totalBars = 0;
  for (const row of SAMPLE_DAYS) {
    const seed = buildSeed('wick-check', 1, row.date);
    const bars = generateIntraday(row, seed);
    let dayHasWick = false;
    for (const bar of bars) {
      totalBars++;
      const hasWick = bar.h > Math.max(bar.o, bar.c) || bar.l < Math.min(bar.o, bar.c);
      if (hasWick) {
        barsWithWick++;
        dayHasWick = true;
      }
    }
    if (dayHasWick) daysWithAnyWick++;
  }
  const wickBarPct = (100 * barsWithWick) / totalBars;
  console.log(
    `wick coverage: ${daysWithAnyWick}/${SAMPLE_DAYS.length} days with >=1 wick bar, ` +
      `${wickBarPct.toFixed(1)}% of bars have a wick`
  );
  assert.ok(
    daysWithAnyWick / SAMPLE_DAYS.length > 0.9,
    'expected the large majority of days to have at least one wick bar'
  );
  assert.ok(wickBarPct > 20, `expected a meaningful fraction of bars to carry wicks, got ${wickBarPct}%`);
});

test('generateIntraday: the extreme bar wick touches the real day H/L exactly (not just the body)', () => {
  for (const row of SAMPLE_DAYS) {
    if (row.high === row.low) continue;
    const seed = buildSeed('wick-touch-check', 1, row.date);
    const bars = generateIntraday(row, seed);
    const touchesH = bars.some((b) => b.h === row.high);
    const touchesL = bars.some((b) => b.l === row.low);
    assert.ok(touchesH, `${row.date}: no bar's h reaches the real high`);
    assert.ok(touchesL, `${row.date}: no bar's l reaches the real low`);
  }
});

// ---------------------------------------------------------------------------
// 8. Degenerate-day robustness (GLM review 2026-08-02, findings 1-3): days
// with zero or near-zero variance are exactly where logNormalDensity1D can
// return Infinity, logBivariateNormalDensity's determinant can collapse
// toward 0, and buildBridgeSegment can be asked to walk with sigma=0. Each
// case below must survive 500 distinct seeds with no throw, no NaN anywhere
// in the output, and all hard constraints intact.
// ---------------------------------------------------------------------------

function assertNoNaN(bars, label) {
  for (const bar of bars) {
    for (const field of ['o', 'h', 'l', 'c']) {
      assert.ok(Number.isFinite(bar[field]), `${label}: bar.${field}=${bar[field]} is not a finite number`);
    }
  }
}

function assertSurvives500Seeds(row, seedTag) {
  const tokens = metaSeededAttemptTokens(500, seedTag);
  for (const token of tokens) {
    const seed = buildSeed(seedTag, token, row.date);
    let bars;
    assert.doesNotThrow(() => {
      bars = generateIntraday(row, seed);
    }, `${seedTag}/${row.date}/${token}: generateIntraday threw unexpectedly`);
    assertHardConstraints(row, bars, `${seedTag}/${row.date}/${token}`);
    assertNoNaN(bars, `${seedTag}/${row.date}/${token}`);
  }
}

test('degenerate day: real 一字線 (2025-04-07, limit day) survives 500 seeds — no throw, no NaN, hard constraints hold', () => {
  const row = ROWS.find((r) => r.date === '2025-04-07');
  assert.ok(row, 'fixture day 2025-04-07 must exist in TX.json');
  assert.equal(row.open, row.high, 'sanity: expected a real 一字線 fixture');
  assert.equal(row.low, row.close, 'sanity: expected a real 一字線 fixture');
  assertSurvives500Seeds(row, 'degenerate-flat-2025-04-07');
});

test('degenerate day: real 一字線 (2025-04-10, limit day) survives 500 seeds — no throw, no NaN, hard constraints hold', () => {
  const row = ROWS.find((r) => r.date === '2025-04-10');
  assert.ok(row, 'fixture day 2025-04-10 must exist in TX.json');
  assert.equal(row.open, row.high, 'sanity: expected a real 一字線 fixture');
  assert.equal(row.low, row.close, 'sanity: expected a real 一字線 fixture');
  assertSurvives500Seeds(row, 'degenerate-flat-2025-04-10');
});

test('degenerate day: synthetic 一字線 (O=H=L=C) survives 500 seeds — no throw, no NaN, hard constraints hold', () => {
  const row = { date: '2099-03-01', open: 10000, high: 10000, low: 10000, close: 10000 };
  assertSurvives500Seeds(row, 'degenerate-flat-synthetic');
});

test('degenerate day: 1-point amplitude (H-L=1) survives 500 seeds — no throw, no NaN, hard constraints hold', () => {
  // With H-L=1 the only two integer prices available are L and H themselves,
  // so O and C are necessarily each pinned to one of them — this exercises
  // the near-zero-variance segment path (tiny Parkinson sigma, recalibrated
  // segment variance near its floor) without any interior anchor sampling.
  const row = { date: '2099-03-02', open: 10000, high: 10001, low: 10000, close: 10001 };
  assertSurvives500Seeds(row, 'degenerate-1point');
});

test('degenerate day: 1-point amplitude (H-L=1), O=H and C=L, survives 500 seeds', () => {
  const row = { date: '2099-03-03', open: 10001, high: 10001, low: 10000, close: 10000 };
  assertSurvives500Seeds(row, 'degenerate-1point-reverse');
});

test('degenerate day: H==O and L==C (both extremes forced, no anchor sampling) survives 500 seeds', () => {
  const row = { date: '2099-03-04', open: 10000, high: 10000, low: 9800, close: 9800 };
  assertSurvives500Seeds(row, 'degenerate-both-forced');
});

test('degenerate day: sigmaMultiplier=0 (forced zero variance on an otherwise normal day) survives 500 seeds', () => {
  // Defensive coverage for the buildBridgeSegment(sigmaStep<=0) branch via
  // the public options hook, on a day that is NOT itself flat/degenerate.
  const row = ROWS.find((r) => r.date === '2020-03-19');
  const tokens = metaSeededAttemptTokens(500, 'degenerate-zero-sigma');
  for (const token of tokens) {
    const seed = buildSeed('degenerate-zero-sigma', token, row.date);
    let bars;
    assert.doesNotThrow(() => {
      bars = generateIntraday(row, seed, { sigmaMultiplier: 0 });
    }, `degenerate-zero-sigma/${row.date}/${token}: generateIntraday threw unexpectedly`);
    assertHardConstraints(row, bars, `degenerate-zero-sigma/${row.date}/${token}`);
    assertNoNaN(bars, `degenerate-zero-sigma/${row.date}/${token}`);
  }
});
