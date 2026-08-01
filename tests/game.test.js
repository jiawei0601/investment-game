// tests/game.test.js — M4 game session layer test suite (AGENTS.md 測試慣例).
// Run with: node --test tests/game.test.js
//
// Uses the real data/daily/TX.json skeleton for two windows:
//   - 2020-03 (COVID crash): exercises forced liquidation + monthly income.
//   - 2017-03 (calm "平淡關" period): exercises settlement-day rollover
//     without any liquidation noise, so the rollover event itself is
//     unambiguous.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createSession, queueOrder, advanceDay, applyShock } from '../src/game/index.js';
import { PLAN_FIELDS } from '../src/behavior/index.js';

const TX_PATH = fileURLToPath(new URL('../data/daily/TX.json', import.meta.url));
const TX = JSON.parse(readFileSync(TX_PATH, 'utf8'));
const ROWS = TX.rows;

const PLAN = Object.freeze({
  goal: 'stable_return',
  maxDrawdown: 20,
  stopLossRule: 'fixed_points',
  stopLossParams: { points: 300 },
  addRule: 'no_add',
  marginUsageCap: 50,
  overnight: 'allowed',
});

// Replays the cash-affecting event types only (mirrors exactly the cash
// arithmetic src/margin/{trading,core}.js perform) to independently verify
// session.account.cash — proves no money is silently created or destroyed
// across the whole day-by-day pipeline (open/close/rollover/checkIntraday/
// margin-call enforcement/monthly income all funnel through the same
// margin-engine primitives, so this is a real conservation check, not a
// tautology).
function replayCash(initialCash, events) {
  let cash = initialCash;
  for (const ev of events) {
    switch (ev.type) {
      case 'open':
        cash -= ev.fee + ev.tax;
        break;
      case 'close':
      case 'force_liquidation':
        cash += ev.realizedPL - ev.fee - ev.tax;
        break;
      case 'rollover':
        cash += ev.realizedPL - ev.cost;
        break;
      case 'deposit':
        cash += ev.amount;
        break;
      case 'withdraw':
        cash -= ev.amount;
        break;
      case 'shock':
        cash -= ev.amount;
        break;
      default:
        break; // 'cost', 'intraday', 'risk_snapshot', markers, etc. carry no independent cash effect
    }
  }
  return cash;
}

// ---------------------------------------------------------------------
// Scenario A: 2020-03 crash, 20 trading days (2020-03-02..2020-03-27) —
// covers all three things the M4 integration test is required to exercise
// in the same run: a forced-liquidation case (the TX long opened on day 0
// gets margin-called out during the crash), the 2020-03-18 settlement-day
// rollover (a fresh TMF re-entry queued right after the liquidation is
// observed, sized to survive to the settlement date), and the first-
// trading-day-of-month income deposit (day 0 itself).
function runCrashScenario() {
  let session = createSession({
    levelId: 'pandemic',
    attempt: 1,
    startDate: '2020-03-02',
    endDate: '2020-03-27',
    initialCash: 300000,
    plan: PLAN,
    monthlyIncome: 20000,
    dailyRows: ROWS,
  });

  session = queueOrder(session, {
    kind: 'market',
    product: 'TX',
    side: 1,
    lots: 1,
    thesis: '疫情初期急跌後預期反彈，博一個技術性回補',
  });

  let reentered = false;
  for (let i = 0; i < 20 && !session.finished; i++) {
    session = advanceDay(session);
    const liquidatedAlready = session.events.some((e) => e.type === 'force_liquidation');
    if (liquidatedAlready && !reentered && session.account.positions.length === 0) {
      // Small TMF re-entry to carry a position across the 2020-03-18
      // settlement day so the rollover path gets exercised in this same run.
      session = queueOrder(session, {
        kind: 'market',
        product: 'TMF',
        side: -1,
        lots: 1,
        thesis: '崩盤趨勢未歇，小台微台部位測試持有過結算日',
      });
      reentered = true;
    }
  }
  return session;
}

test('game session: 2020-03 crash run — 20 trading days advance cleanly', () => {
  const session = runCrashScenario();
  assert.equal(session.cursor, 20);
  assert.ok(session.finished === false || session.cursor === session.rows.length);
});

test('game session: 2020-03 crash run — liquidation, settlement rollover, and monthly income all occur', () => {
  const session = runCrashScenario();
  const types = session.events.map((e) => e.type);
  assert.ok(types.includes('force_liquidation'), 'expected at least one force_liquidation event during the crash');
  assert.ok(types.includes('deposit'), 'expected monthly income deposit on the first trading day');
  const rolloverEvents = session.events.filter((e) => e.type === 'rollover');
  assert.equal(rolloverEvents.length, 1);
  assert.equal(rolloverEvents[0].date, '2020-03-18');
  assert.equal(rolloverEvents[0].product, 'TMF');
});

test('game session: 2020-03 crash run — event stream order is causally sane per day', () => {
  const session = runCrashScenario();
  // Day 0's slice: the day's intraday knot path is generated first, player
  // orders (thesis/open) fill against knots[0], then the day ends with
  // settle -> risk_snapshot.
  const day0 = session.events.filter((e) => e.date === '2020-03-02');
  const idx = (t) => day0.findIndex((e) => e.type === t);
  assert.ok(idx('intraday') < idx('thesis'));
  assert.ok(idx('thesis') < idx('open'));
  assert.ok(idx('open') < idx('settle'));
  assert.ok(idx('settle') < idx('risk_snapshot'));
});

test('game session: 2020-03 crash run — cash conservation holds across the whole event stream', () => {
  const session = runCrashScenario();
  const expectedCash = replayCash(300000, session.events);
  assert.equal(session.account.cash, expectedCash);
});

test('game session: 2020-03 crash run — behavior score/violations are recomputed and internally consistent', () => {
  const session = runCrashScenario();
  assert.ok(session.score >= 0 && session.score <= 100);
  const total = Object.values(session.scoreCounts).reduce((a, b) => a + b, 0);
  assert.equal(total, session.violations.length);
});

// Asserts knotIndex never goes backwards within any single day's slice of
// the event stream (coordinator fix #2: player order fills and margin-
// engine forced liquidation now share one single-pass knot walk instead of
// two separate passes, specifically to rule out this kind of time reversal).
// Events without a knotIndex field (settle/rollover/deposit/risk_snapshot/
// overnight_hold/etc.) are skipped — only events tagged with a knotIndex are
// checked against each other, in the order they appear in the stream.
function assertKnotIndexMonotonicPerDay(events) {
  const byDate = new Map();
  for (const e of events) {
    if (typeof e.knotIndex !== 'number') continue;
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e.knotIndex);
  }
  for (const [date, indices] of byDate) {
    for (let i = 1; i < indices.length; i++) {
      assert.ok(
        indices[i] >= indices[i - 1],
        `knotIndex went backwards on ${date}: ${indices[i - 1]} -> ${indices[i]} (full sequence: ${indices.join(',')})`
      );
    }
  }
}

test('game session: 2020-03 crash run — knotIndex is monotonic non-decreasing within every day', () => {
  const session = runCrashScenario();
  assertKnotIndexMonotonicPerDay(session.events);
});

// ---------------------------------------------------------------------
// Interleaving case (coordinator fix #3): a constructed day where BOTH a
// player-placed stop order and the margin engine's own forced liquidation
// trigger on the same day, using the real 2020-03-12 crash bar. Verified
// empirically against src/margin's checkAtPrice directly before writing
// this test (see the investigation notes in HANDOFF/PR description): with
// TX+MTX both opened 1 lot long at 2020-03-11's open (10979) and
// initialCash=320000 (enough for both opens to clear the funds check), an
// MTX stop order at triggerPrice=10500 first touches at knotIndex=112
// (price 10497) with no liquidation before that point; after the stop
// closes MTX, the remaining lone TX position still breaches maintenance
// later in the same day at knotIndex=172 (price 10281) and gets force-
// liquidated. This is the exact scenario the single-pass knot walk
// (runIntradaySession) exists to order correctly.
// ---------------------------------------------------------------------
test('game session: interleaving — player stop fill and forced liquidation on the same day fire in correct knot order', () => {
  let session = createSession({
    levelId: 'pandemic',
    attempt: 1,
    startDate: '2020-03-11',
    endDate: '2020-03-13',
    initialCash: 320000,
    plan: PLAN,
    monthlyIncome: 0,
    dailyRows: ROWS,
  });

  session = queueOrder(session, { kind: 'market', product: 'TX', side: 1, lots: 1, thesis: '測試交錯情境：TX 部位' });
  session = queueOrder(session, { kind: 'market', product: 'MTX', side: 1, lots: 1, thesis: '測試交錯情境：MTX 部位' });
  session = queueOrder(session, { kind: 'stop', product: 'MTX', lots: 1, triggerPrice: 10500 });

  session = advanceDay(session); // 2020-03-11: both positions open at knots[0] (=10979)
  session = advanceDay(session); // 2020-03-12: the crash day — both triggers fire

  const day = session.events.filter((e) => e.date === '2020-03-12');
  const stopFill = day.find((e) => e.type === 'order_filled' && e.orderKind === 'stop');
  const forcedLiq = day.find((e) => e.type === 'force_liquidation');

  assert.ok(stopFill, 'expected the MTX stop order to fill on 2020-03-12');
  assert.ok(forcedLiq, 'expected TX to be force-liquidated later the same day');
  assert.equal(stopFill.product, 'MTX');
  assert.equal(forcedLiq.product, 'TX');
  assert.equal(stopFill.knotIndex, 112);
  assert.equal(forcedLiq.knotIndex, 172);
  assert.ok(stopFill.knotIndex < forcedLiq.knotIndex, 'the stop fill must be recorded before the later forced liquidation');

  // The event *array order* must match the knot order too, not just the
  // knotIndex values (i.e. no re-sorting/buffering — this is a true single
  // pass): the stop fill's index in the array must precede the liquidation's.
  assert.ok(day.indexOf(stopFill) < day.indexOf(forcedLiq));

  // After the stop closed MTX, only TX remains to be liquidated — MTX must
  // not appear in any force_liquidation event that day.
  assert.equal(day.some((e) => e.type === 'force_liquidation' && e.product === 'MTX'), false);

  assertKnotIndexMonotonicPerDay(session.events);
});

// ---------------------------------------------------------------------
// Scenario B: 2017-03 calm period — settlement-day rollover in isolation.
// ---------------------------------------------------------------------
function runRolloverScenario() {
  let session = createSession({
    levelId: 'flat_market',
    attempt: 1,
    startDate: '2017-03-01',
    endDate: '2017-03-24',
    initialCash: 2000000,
    plan: PLAN,
    monthlyIncome: 0,
    dailyRows: ROWS,
  });

  session = queueOrder(session, {
    kind: 'market',
    product: 'TX',
    side: 1,
    lots: 1,
    thesis: '低波動盤整，順勢小部位持有測試轉倉流程',
  });

  for (let i = 0; i < 12 && !session.finished; i++) {
    session = advanceDay(session);
  }
  return session;
}

test('game session: 2017-03 calm run — settlement-day rollover fires exactly on 2017-03-15', () => {
  const session = runRolloverScenario();
  const rolloverEvents = session.events.filter((e) => e.type === 'rollover');
  assert.equal(rolloverEvents.length, 1);
  assert.equal(rolloverEvents[0].date, '2017-03-15');
  assert.equal(session.events.some((e) => e.type === 'force_liquidation'), false);
});

test('game session: 2017-03 calm run — cash conservation holds', () => {
  const session = runRolloverScenario();
  const expectedCash = replayCash(2000000, session.events);
  assert.equal(session.account.cash, expectedCash);
});

// ---------------------------------------------------------------------
// Determinism: same levelId/attempt + same instruction sequence -> byte-
// identical event stream (ADR 0002/0008 reproducibility contract extends to
// the game layer, not just the raw M2 generator).
// ---------------------------------------------------------------------
test('game session: determinism — identical seed + identical orders -> identical event stream', () => {
  const build = () => {
    let session = createSession({
      levelId: 'pandemic',
      attempt: 1,
      startDate: '2020-03-02',
      endDate: '2020-03-27',
      initialCash: 300000,
      plan: PLAN,
      monthlyIncome: 20000,
      dailyRows: ROWS,
    });
    session = queueOrder(session, {
      kind: 'market',
      product: 'TX',
      side: 1,
      lots: 1,
      thesis: '疫情初期急跌後預期反彈，博一個技術性回補',
    });
    for (let i = 0; i < 20 && !session.finished; i++) session = advanceDay(session);
    return session;
  };

  const a = build();
  const b = build();
  assert.equal(JSON.stringify(a.events), JSON.stringify(b.events));
  assert.equal(a.score, b.score);
  assert.deepEqual(a.scoreCounts, b.scoreCounts);
});

test('game session: determinism — a different attempt number changes the generated intraday path', () => {
  const buildWithAttempt = (attempt) => {
    let session = createSession({
      levelId: 'pandemic',
      attempt,
      startDate: '2020-03-02',
      endDate: '2020-03-05',
      initialCash: 300000,
      plan: PLAN,
      monthlyIncome: 0,
      dailyRows: ROWS,
    });
    for (let i = 0; i < 3 && !session.finished; i++) session = advanceDay(session);
    return session;
  };
  const a = buildWithAttempt(1);
  const b = buildWithAttempt(2);
  const knotsA = a.events.find((e) => e.type === 'intraday').knots;
  const knotsB = b.events.find((e) => e.type === 'intraday').knots;
  assert.notDeepEqual(knotsA, knotsB);
});

// ---------------------------------------------------------------------
// Sanity: session refuses to advance past the end, and rejects a fresh
// open without a thesis (SPEC §3 "強制詢問" requirement enforced in code).
// ---------------------------------------------------------------------
test('game session: advanceDay throws once the session is finished', () => {
  let session = createSession({
    levelId: 'flat_market',
    attempt: 1,
    startDate: '2017-03-01',
    endDate: '2017-03-03',
    initialCash: 2000000,
    plan: PLAN,
    monthlyIncome: 0,
    dailyRows: ROWS,
  });
  while (!session.finished) session = advanceDay(session);
  assert.throws(() => advanceDay(session));
});

test('game session: a fresh-open market order without a thesis is rejected', () => {
  let session = createSession({
    levelId: 'flat_market',
    attempt: 1,
    startDate: '2017-03-01',
    endDate: '2017-03-03',
    initialCash: 2000000,
    plan: PLAN,
    monthlyIncome: 0,
    dailyRows: ROWS,
  });
  session = queueOrder(session, { kind: 'market', product: 'TX', side: 1, lots: 1 }); // no thesis
  assert.throws(() => advanceDay(session), /thesis/);
});

test('PLAN_FIELDS sanity: the shared behavior plan used here still matches SPEC option shape', () => {
  assert.ok(PLAN_FIELDS.stopLossRule.options.some((o) => o.value === PLAN.stopLossRule));
});

// ---------------------------------------------------------------------
// GLM 終審 fix 4: applyShock must not let the new session's account share a
// mutable `positions` array with the old session — mutating the new
// session's positions array must never leak back into the old one.
// ---------------------------------------------------------------------
test('game session: applyShock — mutating the new session afterward does not corrupt the old session', () => {
  let session = createSession({
    levelId: 'pandemic',
    attempt: 1,
    startDate: '2020-03-02',
    endDate: '2020-03-05',
    initialCash: 300000,
    plan: PLAN,
    monthlyIncome: 0,
    dailyRows: ROWS,
  });
  session = queueOrder(session, { kind: 'market', product: 'TX', side: 1, lots: 1, thesis: '測試 applyShock 不可變性' });
  session = advanceDay(session); // opens the TX position

  const before = session;
  const beforePositionsLength = before.account.positions.length;
  assert.equal(beforePositionsLength, 1);

  const after = applyShock(before, { date: '2020-03-03', amount: 50000 });
  assert.notEqual(after, before); // genuinely a new session object
  assert.equal(after.account.cash, before.account.cash - 50000);

  // Directly mutate the *new* session's positions array (the kind of bug a
  // shared-reference implementation would let leak backwards).
  after.account.positions.push({ product: 'MTX', side: 1, lots: 99, entryPrice: 1, openDate: '2020-03-03' });

  assert.equal(after.account.positions.length, 2);
  assert.equal(before.account.positions.length, beforePositionsLength, 'old session must be unaffected by mutating the new session\'s positions array');
  assert.equal(before.account.positions.length, 1);
});
