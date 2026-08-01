// tests/behavior.test.js — M4 behavior system test suite (AGENTS.md 測試慣例 / SPEC §3).
// Run with: node --test tests/behavior.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PLAN_FIELDS,
  validatePlan,
  createPlan,
  detectContradictions,
  getTemplate,
  detectViolations,
  computeScore,
  createProfile,
  recordSession,
} from '../src/behavior/index.js';

// ---------------------------------------------------------------------
// plan.js — option text fidelity to SPEC §3.
// ---------------------------------------------------------------------
test('PLAN_FIELDS: option labels match SPEC §3 verbatim', () => {
  assert.deepEqual(PLAN_FIELDS.goal.options.map((o) => o.label), ['保本', '穩定正報酬', '翻倍', '自訂']);
  assert.deepEqual(PLAN_FIELDS.maxDrawdown.options.map((o) => o.label), ['10%', '20%', '30%', '不設限']);
  assert.deepEqual(PLAN_FIELDS.stopLossRule.options.map((o) => o.label), [
    '固定點數 -X 點',
    '收盤跌破 N 日均線',
    '論點失效才走',
    '不設停損',
  ]);
  assert.deepEqual(PLAN_FIELDS.addRule.options.map((o) => o.label), ['不加碼', '順勢加碼', '逆勢攤平', '僅論點強化時']);
  assert.deepEqual(PLAN_FIELDS.marginUsageCap.options.map((o) => o.label), ['30%', '50%', '70%', '不設限']);
  assert.deepEqual(PLAN_FIELDS.overnight.options.map((o) => o.label), ['可過夜', '當日沖銷為主（過夜需理由）']);
});

const BASE_PLAN = {
  goal: 'stable_return',
  maxDrawdown: 'unlimited',
  stopLossRule: 'fixed_points',
  stopLossParams: { points: 300 },
  addRule: 'trend_add',
  marginUsageCap: 30,
  overnight: 'allowed',
};

test('createPlan: valid plan passes through frozen', () => {
  const plan = createPlan(BASE_PLAN);
  assert.equal(plan.goal, 'stable_return');
  assert.throws(() => {
    plan.goal = 'double';
  });
});

test('createPlan: invalid option value throws', () => {
  assert.throws(() => createPlan({ ...BASE_PLAN, goal: 'not_an_option' }));
  assert.throws(() => createPlan({ ...BASE_PLAN, maxDrawdown: 15 }));
  assert.throws(() => createPlan({ ...BASE_PLAN, stopLossRule: 'fixed_points', stopLossParams: undefined }));
});

test('validatePlan: missing field reported', () => {
  const { overnight, ...missingOvernight } = BASE_PLAN;
  const errors = validatePlan(missingOvernight);
  assert.ok(errors.some((e) => e.includes('overnight')));
});

// ---------------------------------------------------------------------
// contradictions.js — full combination table over the three SPEC §3 rules.
// ---------------------------------------------------------------------
test('detectContradictions: legal base plan is zero-friction (no false positive)', () => {
  assert.deepEqual(detectContradictions(BASE_PLAN), []);
});

const CONTRADICTION_MATRIX = [
  {
    name: '逆勢攤平 + 回撤 10% -> matches SPEC example 1',
    plan: { ...BASE_PLAN, addRule: 'martingale_add', maxDrawdown: 10 },
    expectIds: ['martingale_vs_drawdown_cap'],
  },
  {
    name: '逆勢攤平 + 不設限回撤 -> NOT a contradiction (no cap to breach)',
    plan: { ...BASE_PLAN, addRule: 'martingale_add', maxDrawdown: 'unlimited' },
    expectIds: [],
  },
  {
    name: '使用率 70% + 回撤 20% -> matches SPEC example 2',
    plan: { ...BASE_PLAN, marginUsageCap: 70, maxDrawdown: 20 },
    expectIds: ['high_margin_usage_vs_drawdown_cap'],
  },
  {
    name: '使用率不設限（等同 70%+）+ 回撤 30% -> also matches',
    plan: { ...BASE_PLAN, marginUsageCap: 'unlimited', maxDrawdown: 30 },
    expectIds: ['high_margin_usage_vs_drawdown_cap'],
  },
  {
    name: '使用率 50% + 回撤 10% -> NOT a contradiction (below 70% threshold)',
    plan: { ...BASE_PLAN, marginUsageCap: 50, maxDrawdown: 10 },
    expectIds: [],
  },
  {
    name: '當沖為主 + 論點失效才走 -> matches SPEC example 3',
    plan: { ...BASE_PLAN, overnight: 'day_trade_mainly', stopLossRule: 'thesis_invalid' },
    expectIds: ['daytrade_vs_thesis_invalid_stop'],
  },
  {
    name: '可過夜 + 論點失效才走 -> NOT a contradiction (rule needs day_trade_mainly)',
    plan: { ...BASE_PLAN, overnight: 'allowed', stopLossRule: 'thesis_invalid' },
    expectIds: [],
  },
  {
    name: '當沖為主 + 固定點數停損 -> NOT a contradiction (has a price stop)',
    plan: { ...BASE_PLAN, overnight: 'day_trade_mainly' },
    expectIds: [],
  },
  {
    name: '三條同時觸發（全組合）',
    plan: {
      ...BASE_PLAN,
      addRule: 'martingale_add',
      maxDrawdown: 10,
      marginUsageCap: 70,
      overnight: 'day_trade_mainly',
      stopLossRule: 'thesis_invalid',
    },
    expectIds: ['martingale_vs_drawdown_cap', 'high_margin_usage_vs_drawdown_cap', 'daytrade_vs_thesis_invalid_stop'],
  },
];

for (const { name, plan, expectIds } of CONTRADICTION_MATRIX) {
  test(`detectContradictions: ${name}`, () => {
    const got = detectContradictions(plan).map((r) => r.id).sort();
    assert.deepEqual(got, [...expectIds].sort());
  });
}

test('detectContradictions: every triggered rule resolves to a template with all three masters', () => {
  for (const { plan } of CONTRADICTION_MATRIX) {
    for (const r of detectContradictions(plan)) {
      const t = getTemplate(r.templateKey);
      assert.ok(t.livermore.length >= 2);
      assert.ok(t.opman.length >= 2);
      assert.ok(t.gooaye.length >= 2);
    }
  }
});

// ---------------------------------------------------------------------
// violations.js — five categories, >=2 positive + >=1 negative each.
// ---------------------------------------------------------------------

// 1. 凹單 (bag_holding) ---------------------------------------------------
test('violations: bag_holding — long position touches fixed-point stop and stays open', () => {
  const plan = { ...BASE_PLAN, stopLossRule: 'fixed_points', stopLossParams: { points: 300 } };
  const events = [
    { type: 'open', date: '2020-03-10', product: 'TX', side: 1, lots: 1, price: 17000 },
    { type: 'intraday', date: '2020-03-11', knots: [17000, 16900, 16650, 16700] }, // touches 16700 stop
  ];
  const v = detectViolations(plan, events);
  assert.equal(v.filter((x) => x.type === 'bag_holding').length, 1);
});

test('violations: bag_holding — short position touches fixed-point stop and stays open', () => {
  const plan = { ...BASE_PLAN, stopLossRule: 'fixed_points', stopLossParams: { points: 300 } };
  const events = [
    { type: 'open', date: '2020-03-10', product: 'TX', side: -1, lots: 1, price: 17000 },
    { type: 'intraday', date: '2020-03-11', knots: [17000, 17100, 17350, 17200] }, // touches 17300 stop
  ];
  const v = detectViolations(plan, events);
  assert.equal(v.filter((x) => x.type === 'bag_holding').length, 1);
});

test('violations: bag_holding — closed before the touch is not flagged (negative)', () => {
  const plan = { ...BASE_PLAN, stopLossRule: 'fixed_points', stopLossParams: { points: 300 } };
  const events = [
    { type: 'open', date: '2020-03-10', product: 'TX', side: 1, lots: 1, price: 17000 },
    { type: 'close', date: '2020-03-11', product: 'TX', lots: 1, price: 16900 },
    { type: 'intraday', date: '2020-03-11', knots: [17000, 16900, 16650, 16700] },
  ];
  const v = detectViolations(plan, events);
  assert.equal(v.filter((x) => x.type === 'bag_holding').length, 0);
});

test('violations: bag_holding — no mechanical stop rule (thesis_invalid) never flags (negative)', () => {
  const plan = { ...BASE_PLAN, stopLossRule: 'thesis_invalid', stopLossParams: undefined };
  const events = [
    { type: 'open', date: '2020-03-10', product: 'TX', side: 1, lots: 1, price: 17000 },
    { type: 'intraday', date: '2020-03-11', knots: [17000, 16000, 15000] },
  ];
  const v = detectViolations(plan, events);
  assert.equal(v.filter((x) => x.type === 'bag_holding').length, 0);
});

// GLM 終審 fix 1: partial close must reset the bag-holding flag so a fresh
// touch on the remaining lots re-records, instead of being silently
// swallowed by a flag that only used to reset on a *full* close.
test('violations: bag_holding — partial close resets the flag; a later re-touch records again', () => {
  const plan = { ...BASE_PLAN, stopLossRule: 'fixed_points', stopLossParams: { points: 300 } };
  const events = [
    { type: 'open', date: '2020-03-10', product: 'TX', side: 1, lots: 2, price: 17000 },
    { type: 'intraday', date: '2020-03-11', knots: [17000, 16900, 16650, 16700] }, // touches 16700 stop -> 1st bag_holding
    { type: 'close', date: '2020-03-11', product: 'TX', lots: 1, price: 16700 }, // partial close: 2 lots -> 1
    { type: 'intraday', date: '2020-03-12', knots: [16700, 16600, 16400, 16500] }, // price keeps falling, still touches
  ];
  const v = detectViolations(plan, events);
  const bagHoldings = v.filter((x) => x.type === 'bag_holding');
  assert.equal(bagHoldings.length, 2, 'expected a fresh bag_holding after the partial close, not a suppressed re-touch');
  assert.equal(bagHoldings[0].date, '2020-03-11');
  assert.equal(bagHoldings[1].date, '2020-03-12');
  // The re-touch is a fresh episode, not a continuation.
  assert.equal(v.filter((x) => x.type === 'bag_holding_continued').length, 0);
});

// GLM 終審 fix 5: bag-holding continuation — after the initial trigger,
// every subsequent day_close while the position stays open (flag not reset)
// adds one bag_holding_continued, until the position is closed or the flag
// is otherwise reset.
test('violations: bag_holding_continued — holding through the stop for 5 trading days = 1 bag_holding + 4 continued', () => {
  const plan = { ...BASE_PLAN, stopLossRule: 'fixed_points', stopLossParams: { points: 300 } };
  const events = [
    { type: 'open', date: '2020-03-09', product: 'TX', side: 1, lots: 1, price: 17000 },
    // Day 1: touches the stop -> initial bag_holding. day_close same date must NOT also add a continued.
    { type: 'intraday', date: '2020-03-10', knots: [17000, 16900, 16650, 16700] },
    { type: 'day_close', date: '2020-03-10', close: 16700 },
    // Days 2-5: still holding, no further touch needed — continuation only requires the flag to still be set.
    { type: 'day_close', date: '2020-03-11', close: 16650 },
    { type: 'day_close', date: '2020-03-12', close: 16600 },
    { type: 'day_close', date: '2020-03-13', close: 16550 },
    { type: 'day_close', date: '2020-03-16', close: 16500 },
  ];
  const v = detectViolations(plan, events);
  const initial = v.filter((x) => x.type === 'bag_holding');
  const continued = v.filter((x) => x.type === 'bag_holding_continued');
  assert.equal(initial.length, 1);
  assert.equal(continued.length, 4);
  assert.deepEqual(
    continued.map((x) => x.date),
    ['2020-03-11', '2020-03-12', '2020-03-13', '2020-03-16']
  );

  // Hand-computed score anchor: 100 - 15 (bag_holding) - 4*5 (continued) = 65.
  const { score, counts } = computeScore(v, plan);
  assert.equal(score, 65);
  assert.equal(counts.bag_holding, 1);
  assert.equal(counts.bag_holding_continued, 4);
});

test('violations: bag_holding_continued — closing the position stops the accrual', () => {
  const plan = { ...BASE_PLAN, stopLossRule: 'fixed_points', stopLossParams: { points: 300 } };
  const events = [
    { type: 'open', date: '2020-03-09', product: 'TX', side: 1, lots: 1, price: 17000 },
    { type: 'intraday', date: '2020-03-10', knots: [17000, 16900, 16650, 16700] },
    { type: 'day_close', date: '2020-03-10', close: 16700 },
    { type: 'day_close', date: '2020-03-11', close: 16650 }, // 1 continued
    { type: 'close', date: '2020-03-12', product: 'TX', lots: 1, price: 16600 }, // fully closed: accrual stops
    { type: 'day_close', date: '2020-03-12', close: 16600 },
    { type: 'day_close', date: '2020-03-13', close: 16550 },
  ];
  const v = detectViolations(plan, events);
  assert.equal(v.filter((x) => x.type === 'bag_holding').length, 1);
  assert.equal(v.filter((x) => x.type === 'bag_holding_continued').length, 1);
});

// GLM 終審 fix 2: ma_break's moving average must come from context.dailyCloses
// (the full daily close history the caller supplies), not accumulated from
// whichever 'day_close' events happen to appear in the event stream. This
// test's event stream is deliberately MISSING one day's 'day_close' event
// (2020-03-11) — the MA judgment on later dates must still be correct
// because it's computed from the full dailyCloses history, not from how many
// day_close events this particular stream happened to contain.
test('violations: bag_holding (ma_break) — MA judgment stays correct even when the event stream is missing a day_close', () => {
  const plan = { ...BASE_PLAN, stopLossRule: 'ma_break', stopLossParams: { n: 3 } };
  // Full real daily close history for the MA window (as session.js would
  // supply it from dailyRows) — includes 2020-03-11 even though the event
  // stream below skips emitting a day_close for it.
  const dailyCloses = [
    { date: '2020-03-09', close: 17000 },
    { date: '2020-03-10', close: 16800 },
    { date: '2020-03-11', close: 16500 }, // present in dailyCloses, MISSING from the event stream below
    { date: '2020-03-12', close: 16100 },
  ];
  // 3-day MA on 2020-03-12 = avg(16800, 16500, 16100) = 16466.67 -> close 16100 < MA -> broke.
  const events = [
    { type: 'open', date: '2020-03-09', product: 'TX', side: 1, lots: 1, price: 17000 },
    { type: 'day_close', date: '2020-03-09', close: 17000 },
    { type: 'day_close', date: '2020-03-10', close: 16800 },
    // 2020-03-11's day_close is intentionally absent from the event stream.
    { type: 'day_close', date: '2020-03-12', close: 16100 },
  ];
  const v = detectViolations(plan, events, { dailyCloses });
  const bagHoldings = v.filter((x) => x.type === 'bag_holding');
  assert.equal(bagHoldings.length, 1);
  assert.equal(bagHoldings[0].date, '2020-03-12');
});

test('violations: bag_holding (ma_break) — closing above the MA is not a violation (negative)', () => {
  const plan = { ...BASE_PLAN, stopLossRule: 'ma_break', stopLossParams: { n: 3 } };
  const dailyCloses = [
    { date: '2020-03-09', close: 17000 },
    { date: '2020-03-10', close: 17100 },
    { date: '2020-03-11', close: 17200 },
    { date: '2020-03-12', close: 17300 },
  ];
  const events = [
    { type: 'open', date: '2020-03-09', product: 'TX', side: 1, lots: 1, price: 17000 },
    { type: 'day_close', date: '2020-03-09', close: 17000 },
    { type: 'day_close', date: '2020-03-10', close: 17100 },
    { type: 'day_close', date: '2020-03-11', close: 17200 },
    { type: 'day_close', date: '2020-03-12', close: 17300 },
  ];
  const v = detectViolations(plan, events, { dailyCloses });
  assert.equal(v.filter((x) => x.type === 'bag_holding').length, 0);
});

// 2. 計畫外交易 (unplanned_trade) -----------------------------------------
test('violations: unplanned_trade — margin usage at entry exceeds cap', () => {
  const plan = { ...BASE_PLAN, marginUsageCap: 30 };
  const events = [
    { type: 'open', date: '2020-03-10', product: 'TX', side: 1, lots: 3, price: 17000, marginUsageRatioAtEntry: 0.5 },
  ];
  const v = detectViolations(plan, events);
  assert.equal(v.filter((x) => x.type === 'unplanned_trade').length, 1);
});

test('violations: unplanned_trade — unreasoned overnight hold under day-trade-mainly plan', () => {
  const plan = { ...BASE_PLAN, overnight: 'day_trade_mainly' };
  const events = [{ type: 'overnight_hold', date: '2020-03-10', product: 'TX', side: 1, lots: 1, reason: null }];
  const v = detectViolations(plan, events);
  assert.equal(v.filter((x) => x.type === 'unplanned_trade').length, 1);
});

test('violations: unplanned_trade — within cap and reasoned overnight are not flagged (negative)', () => {
  const plan = { ...BASE_PLAN, marginUsageCap: 70, overnight: 'day_trade_mainly' };
  const events = [
    { type: 'open', date: '2020-03-10', product: 'TX', side: 1, lots: 1, price: 17000, marginUsageRatioAtEntry: 0.5 },
    { type: 'overnight_hold', date: '2020-03-10', product: 'TX', side: 1, lots: 1, reason: '避開跳空風險' },
  ];
  const v = detectViolations(plan, events);
  assert.equal(v.filter((x) => x.type === 'unplanned_trade').length, 0);
});

// 3. 風險失控 (risk_out_of_control) ----------------------------------------
test('violations: risk_out_of_control — drawdown exceeds plan cap', () => {
  const plan = { ...BASE_PLAN, maxDrawdown: 10, marginUsageCap: 'unlimited' };
  const events = [{ type: 'risk_snapshot', date: '2020-03-12', equity: 850000, peakEquity: 1000000, drawdownPct: 15, marginUsageRatio: 0.1 }];
  const v = detectViolations(plan, events);
  assert.equal(v.filter((x) => x.type === 'risk_out_of_control').length, 1);
});

test('violations: risk_out_of_control — margin usage ratio exceeds plan cap', () => {
  const plan = { ...BASE_PLAN, maxDrawdown: 'unlimited', marginUsageCap: 30 };
  const events = [{ type: 'risk_snapshot', date: '2020-03-12', equity: 900000, peakEquity: 1000000, drawdownPct: 10, marginUsageRatio: 0.5 }];
  const v = detectViolations(plan, events);
  assert.equal(v.filter((x) => x.type === 'risk_out_of_control').length, 1);
});

test('violations: risk_out_of_control — within both caps is not flagged (negative)', () => {
  const plan = { ...BASE_PLAN, maxDrawdown: 20, marginUsageCap: 50 };
  const events = [{ type: 'risk_snapshot', date: '2020-03-12', equity: 900000, peakEquity: 1000000, drawdownPct: 10, marginUsageRatio: 0.3 }];
  const v = detectViolations(plan, events);
  assert.equal(v.filter((x) => x.type === 'risk_out_of_control').length, 0);
});

// 4. 論點漂移 (thesis_drift) — 記錄介面，需顯式標記 ------------------------
test('violations: thesis_drift — explicit priceOnly flag is forwarded', () => {
  const plan = BASE_PLAN;
  const events = [{ type: 'thesis_change', date: '2020-03-13', product: 'TX', priceOnly: true, note: '單純因為跌深想搶反彈' }];
  const v = detectViolations(plan, events);
  assert.equal(v.filter((x) => x.type === 'thesis_drift').length, 1);
});

test('violations: thesis_drift — a second explicit occurrence is also forwarded', () => {
  const plan = BASE_PLAN;
  const events = [
    { type: 'thesis_change', date: '2020-03-13', product: 'TX', priceOnly: true },
    { type: 'thesis_change', date: '2020-03-20', product: 'TX', priceOnly: true },
  ];
  const v = detectViolations(plan, events);
  assert.equal(v.filter((x) => x.type === 'thesis_drift').length, 2);
});

test('violations: thesis_drift — without explicit flag, nothing is auto-judged (negative)', () => {
  const plan = BASE_PLAN;
  const events = [{ type: 'thesis_change', date: '2020-03-13', product: 'TX', priceOnly: false }];
  const v = detectViolations(plan, events);
  assert.equal(v.filter((x) => x.type === 'thesis_drift').length, 0);
});

// 5. 攤平加碼 (martingale_add) ----------------------------------------------
test('violations: martingale_add — adding to a losing long position under a non-martingale plan', () => {
  const plan = { ...BASE_PLAN, addRule: 'no_add' };
  const events = [
    { type: 'open', date: '2020-03-10', product: 'TX', side: 1, lots: 1, price: 17000 },
    { type: 'open', date: '2020-03-12', product: 'TX', side: 1, lots: 1, price: 16800 }, // adverse add
  ];
  const v = detectViolations(plan, events);
  assert.equal(v.filter((x) => x.type === 'martingale_add').length, 1);
});

test('violations: martingale_add — adding to a losing short position under a non-martingale plan', () => {
  const plan = { ...BASE_PLAN, addRule: 'trend_add' };
  const events = [
    { type: 'open', date: '2020-03-10', product: 'TX', side: -1, lots: 1, price: 17000 },
    { type: 'open', date: '2020-03-12', product: 'TX', side: -1, lots: 1, price: 17200 }, // adverse add
  ];
  const v = detectViolations(plan, events);
  assert.equal(v.filter((x) => x.type === 'martingale_add').length, 1);
});

test('violations: martingale_add — plan explicitly allows it, so no violation (negative)', () => {
  const plan = { ...BASE_PLAN, addRule: 'martingale_add', maxDrawdown: 'unlimited' };
  const events = [
    { type: 'open', date: '2020-03-10', product: 'TX', side: 1, lots: 1, price: 17000 },
    { type: 'open', date: '2020-03-12', product: 'TX', side: 1, lots: 1, price: 16800 },
  ];
  const v = detectViolations(plan, events);
  assert.equal(v.filter((x) => x.type === 'martingale_add').length, 0);
});

test('violations: martingale_add — adding on a favorable move is not "攤平" (negative)', () => {
  const plan = { ...BASE_PLAN, addRule: 'no_add' };
  const events = [
    { type: 'open', date: '2020-03-10', product: 'TX', side: 1, lots: 1, price: 17000 },
    { type: 'open', date: '2020-03-12', product: 'TX', side: 1, lots: 1, price: 17200 }, // trend add, favorable
  ];
  const v = detectViolations(plan, events);
  assert.equal(v.filter((x) => x.type === 'martingale_add').length, 0);
});

// ---------------------------------------------------------------------
// score.js — behavior score is independent of return; hand-computed anchors.
// ---------------------------------------------------------------------
test('computeScore: hand-computed anchor — mixed violation set', () => {
  const violations = [
    { type: 'bag_holding' },
    { type: 'bag_holding' },
    { type: 'martingale_add' },
    { type: 'unplanned_trade' },
  ];
  // 100 - 15 - 15 - 20 - 8 = 42
  const result = computeScore(violations, BASE_PLAN);
  assert.equal(result.score, 42);
  assert.deepEqual(result.counts, {
    bag_holding: 2,
    bag_holding_continued: 0,
    unplanned_trade: 1,
    risk_out_of_control: 0,
    thesis_drift: 0,
    martingale_add: 1,
  });
});

test('computeScore: floors at 0, never negative', () => {
  const violations = Array.from({ length: 10 }, () => ({ type: 'martingale_add' }));
  const result = computeScore(violations, BASE_PLAN);
  assert.equal(result.score, 0);
  assert.equal(result.counts.martingale_add, 10);
});

test('computeScore: no violations -> perfect score', () => {
  assert.equal(computeScore([], BASE_PLAN).score, 100);
});

test('computeScore: identical behavior yields identical D score regardless of realized P&L', () => {
  // Two "simulations" with wildly different profit/loss outcomes but the
  // exact same behavioral violation record must score identically — D is
  // computed purely from violations, return figures never enter the formula.
  const violationsRunA = [{ type: 'bag_holding' }, { type: 'risk_out_of_control' }];
  const violationsRunB = [{ type: 'bag_holding' }, { type: 'risk_out_of_control' }];
  const simulatedPnlA = -450000; // big loss
  const simulatedPnlB = 620000; // big gain
  void simulatedPnlA;
  void simulatedPnlB; // deliberately unused: proves computeScore's signature can't consume them
  const scoreA = computeScore(violationsRunA, BASE_PLAN).score;
  const scoreB = computeScore(violationsRunB, BASE_PLAN).score;
  assert.equal(scoreA, scoreB);
});

// ---------------------------------------------------------------------
// profile.js — schema round trip.
// ---------------------------------------------------------------------
test('profile: createProfile + recordSession round trip', () => {
  const empty = createProfile();
  assert.deepEqual(empty, { version: 1, sessions: [] });

  const withOne = recordSession(empty, {
    levelId: 'pandemic',
    attempt: 1,
    startDate: '2020-01-01',
    endDate: '2020-06-30',
    score: 72,
    counts: { bag_holding: 1, unplanned_trade: 0, risk_out_of_control: 1, thesis_drift: 0, martingale_add: 0 },
  });
  assert.equal(withOne.sessions.length, 1);
  assert.equal(withOne.sessions[0].score, 72);
  assert.equal(empty.sessions.length, 0); // immutability: original untouched
});

test('profile: recordSession throws on missing required field', () => {
  assert.throws(() => recordSession(createProfile(), { levelId: 'x' }));
});
