// tests/margin.test.js — M3 margin engine test suite (AGENTS.md 測試慣例 / SPEC §4).
// Run with: node --test tests/margin.test.js  (Node built-in test runner,
// zero dependencies, per project convention: no build step / no deps).
//
// All expected money figures below are hand-computed from the pinned
// formulas (SPEC §4): initial margin = price*mult*0.10, maintenance =
// initial*0.75, tax = round(price*mult*0.00002) per lot per side, fee =
// PRODUCTS[product].fee per lot per side (see src/margin/products.js
// header for the roundTWD rounding rule used throughout).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  PRODUCTS,
  createAccount,
  computeMargin,
  open,
  close,
  rollover,
  markToMarket,
  checkIntraday,
  deposit,
  withdraw,
  isSettlementDay,
} from '../src/margin/index.js';

const MARGIN_DIR = fileURLToPath(new URL('../src/margin/', import.meta.url));

function snapshot(account) {
  return JSON.parse(JSON.stringify(account));
}

// ---------------------------------------------------------------------
// Structural boundary: the margin engine must be self-contained — no
// reads of data/ or src/engine/ (M3's share of the SPEC §9-1/§9-5
// "唯一真相層" lock: it only ever prices what the caller hands it).
// ---------------------------------------------------------------------
test('boundary: src/margin/*.js never imports src/engine/ or reads data/ files', () => {
  const files = readdirSync(MARGIN_DIR).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 0);
  for (const f of files) {
    const text = readFileSync(MARGIN_DIR + f, 'utf8');
    assert.ok(!/from ['"].*engine/.test(text), `${f} must not import src/engine/`);
    assert.ok(!/readFileSync|require\(['"]fs|from ['"]fs|from ['"]node:fs/.test(text), `${f} must not do file I/O`);
    assert.ok(!/data\//.test(text), `${f} must not reference data/`);
  }
});

// ---------------------------------------------------------------------
// computeMargin — pinned formula at three different index levels.
// ---------------------------------------------------------------------
test('computeMargin: initial = price*mult*0.10, maintenance = initial*0.75', () => {
  assert.deepEqual(computeMargin(17000, 'TX'), { initial: 340000, maintenance: 255000 });
  assert.deepEqual(computeMargin(17000, 'MTX'), { initial: 85000, maintenance: 63750 });
  assert.deepEqual(computeMargin(17000, 'TMF'), { initial: 17000, maintenance: 12750 });
  // different index level -> margin floats with it
  assert.deepEqual(computeMargin(20000, 'TX'), { initial: 400000, maintenance: 300000 });
});

// ---------------------------------------------------------------------
// Fee/tax exact anchors — three hand-computed examples, one per product.
// ---------------------------------------------------------------------
test('open: fee/tax anchor — TX price=17000 lots=2', () => {
  const acct = createAccount({ cash: 1000000 });
  const { events } = open(acct, { date: '2024-01-02', product: 'TX', side: 1, lots: 2, price: 17000 });
  const openEv = events.find((e) => e.type === 'open');
  assert.equal(openEv.fee, 120); // 60 * 2
  assert.equal(openEv.tax, 136); // round(17000*200*0.00002)=68, *2
  assert.equal(openEv.marginRequired, 680000); // 340000 * 2
});

test('open: fee/tax anchor — MTX price=17000 lots=3', () => {
  const acct = createAccount({ cash: 1000000 });
  const { events } = open(acct, { date: '2024-01-02', product: 'MTX', side: 1, lots: 3, price: 17000 });
  const openEv = events.find((e) => e.type === 'open');
  assert.equal(openEv.fee, 90); // 30 * 3
  assert.equal(openEv.tax, 51); // round(17000*50*0.00002)=17, *3
  assert.equal(openEv.marginRequired, 255000); // 85000 * 3
});

test('open: fee/tax anchor — TMF price=17000 lots=5', () => {
  const acct = createAccount({ cash: 1000000 });
  const { events } = open(acct, { date: '2024-01-02', product: 'TMF', side: 1, lots: 5, price: 17000 });
  const openEv = events.find((e) => e.type === 'open');
  assert.equal(openEv.fee, 60); // 12 * 5
  assert.equal(openEv.tax, 15); // round(17000*10*0.00002)=3, *5
  assert.equal(openEv.marginRequired, 85000); // 17000 * 5
});

test('open: fee override via options', () => {
  const acct = createAccount({ cash: 1000000 });
  const { events } = open(acct, { date: '2024-01-02', product: 'TX', side: 1, lots: 1, price: 17000 }, { fee: 100 });
  const openEv = events.find((e) => e.type === 'open');
  assert.equal(openEv.fee, 100);
});

// ---------------------------------------------------------------------
// 多空雙向 + 混合口數的權益計算 (long TX + short MTX simultaneously).
// ---------------------------------------------------------------------
test('equity: mixed long/short across products with different multipliers/lots', () => {
  let acct = createAccount({ cash: 1000000 });
  ({ account: acct } = open(acct, { date: '2024-01-02', product: 'TX', side: 1, lots: 1, price: 17000 }));
  assert.equal(acct.cash, 999872); // 1,000,000 - (60+68)
  ({ account: acct } = open(acct, { date: '2024-01-02', product: 'MTX', side: -1, lots: 2, price: 17000 }));
  assert.equal(acct.cash, 999778); // 999,872 - (60+34)

  const { events } = markToMarket(acct, { date: '2024-01-03', settle: 17100 });
  const settleEv = events.find((e) => e.type === 'settle');
  // TX long1: +100*200=+20000 ; MTX short2: -100*50*2=-10000 ; cash 999778
  assert.equal(settleEv.equity, 1009778);
  assert.ok(!events.some((e) => e.type === 'margin_call'));
});

// ---------------------------------------------------------------------
// markToMarket -> margin_call -> requiredTopUp, and resolution next day.
// ---------------------------------------------------------------------
test('markToMarket: equity below maintenance triggers margin_call with correct requiredTopUp', () => {
  let acct = createAccount({ cash: 400000 });
  ({ account: acct } = open(acct, { date: '2024-01-02', product: 'TX', side: 1, lots: 1, price: 17000 }));
  assert.equal(acct.cash, 399872);

  const { events } = markToMarket(acct, { date: '2024-01-03', settle: 15000 });
  const settleEv = events.find((e) => e.type === 'settle');
  const callEv = events.find((e) => e.type === 'margin_call');
  assert.equal(settleEv.equity, -128); // 399872 - 400000
  assert.ok(callEv, 'expected a margin_call event');
  assert.equal(callEv.maintenanceRequired, 225000);
  assert.equal(callEv.initialRequired, 300000);
  assert.equal(callEv.requiredTopUp, 300128); // 300000 - (-128)
});

test('markToMarket: topping up cash next day clears the margin_call', () => {
  let acct = createAccount({ cash: 400000 });
  ({ account: acct } = open(acct, { date: '2024-01-02', product: 'TX', side: 1, lots: 1, price: 17000 }));
  ({ account: acct } = markToMarket(acct, { date: '2024-01-03', settle: 15000 }));
  ({ account: acct } = deposit(acct, { date: '2024-01-04', amount: 300128 }));
  assert.equal(acct.cash, 700000);

  const { events } = markToMarket(acct, { date: '2024-01-04', settle: 15000 });
  assert.ok(!events.some((e) => e.type === 'margin_call'));
  assert.equal(events.find((e) => e.type === 'settle').equity, 300000);
});

// ---------------------------------------------------------------------
// 盤中強平順序：三部位不同虧損，驗證虧損最大者優先，且砍到剛好回維持線就停。
// ---------------------------------------------------------------------
test('checkIntraday: liquidates the worst-loss position first, stops once equity clears maintenance', () => {
  let acct = createAccount({ cash: 460000 });
  ({ account: acct } = open(acct, { date: '2024-01-02', product: 'TX', side: 1, lots: 1, price: 17000 }));
  ({ account: acct } = open(acct, { date: '2024-01-02', product: 'MTX', side: 1, lots: 1, price: 17000 }));
  ({ account: acct } = open(acct, { date: '2024-01-02', product: 'TMF', side: 1, lots: 1, price: 17000 }));
  assert.equal(acct.cash, 459810);

  const { account: after, events } = checkIntraday(acct, { date: '2024-01-03', knots: [16000] });
  const liqs = events.filter((e) => e.type === 'force_liquidation');
  assert.equal(liqs.length, 1);
  assert.equal(liqs[0].product, 'TX'); // -200,000 loss, worst of the three
  assert.equal(liqs[0].realizedPL, -200000);
  assert.equal(liqs[0].fee, 60);
  assert.equal(liqs[0].tax, 64); // round(16000*200*0.00002)
  assert.equal(after.cash, 259686);
  assert.deepEqual(
    after.positions.map((p) => p.product).sort(),
    ['MTX', 'TMF']
  );
});

// ---------------------------------------------------------------------
// 強平連鎖：單一部位多口，一口砍不夠，逐口繼續砍直到回到維持線之上。
// ---------------------------------------------------------------------
test('checkIntraday: chains through multiple lots of the same position when one cut is not enough', () => {
  let acct = createAccount({ cash: 1050000 });
  ({ account: acct } = open(acct, { date: '2024-01-02', product: 'TX', side: 1, lots: 3, price: 17000 }));
  assert.equal(acct.cash, 1049616);

  const { account: after, events } = checkIntraday(acct, { date: '2024-01-03', knots: [15500] });
  const liqs = events.filter((e) => e.type === 'force_liquidation');
  assert.equal(liqs.length, 3);
  for (const ev of liqs) {
    assert.equal(ev.product, 'TX');
    assert.equal(ev.lots, 1);
    assert.equal(ev.realizedPL, -300000);
    assert.equal(ev.fee, 60);
    assert.equal(ev.tax, 62); // round(15500*200*0.00002)
  }
  assert.equal(after.positions.length, 0);
  assert.equal(after.cash, 149250);
});

// ---------------------------------------------------------------------
// 現金歸零的極端案例：全部部位砍完後權益仍為負值 — 定義為停手，不繼續、不丟例外。
// ---------------------------------------------------------------------
test('checkIntraday: extreme crash leaves negative cash/equity after full liquidation, and stops cleanly', () => {
  let acct = createAccount({ cash: 340200 });
  ({ account: acct } = open(acct, { date: '2024-01-02', product: 'TX', side: 1, lots: 1, price: 17000 }));
  assert.equal(acct.cash, 340072);

  const { account: after, events } = checkIntraday(acct, { date: '2024-01-03', knots: [10000] });
  const liqs = events.filter((e) => e.type === 'force_liquidation');
  assert.equal(liqs.length, 1);
  assert.equal(after.positions.length, 0);
  assert.equal(after.cash, -1060028); // negative equity accepted, not clamped/thrown
  assert.equal(after.cash, liqs[0].equityAfter);

  // downstream markToMarket must not throw and must not raise a margin_call
  // against a flat book, even though equity is still negative.
  const { events: mtmEvents } = markToMarket(after, { date: '2024-01-04', settle: 10000 });
  assert.ok(!mtmEvents.some((e) => e.type === 'margin_call'));
});

// ---------------------------------------------------------------------
// 轉倉會計：平舊開新，cash 變化 = 價差（此例為 0）± 滑價費稅。
// ---------------------------------------------------------------------
test('rollover: cash change equals realized price-diff minus slippage+fee+tax', () => {
  let acct = createAccount({ cash: 400000 });
  ({ account: acct } = open(acct, { date: '2024-08-01', product: 'TX', side: 1, lots: 1, price: 17000 }));
  assert.equal(acct.cash, 399872);

  const { account: after, events } = rollover(acct, { date: '2024-08-21', oldPrice: 17000, newPrice: 17200 });
  assert.ok(isSettlementDay('2024-08-21'));
  const rollEv = events.find((e) => e.type === 'rollover');
  assert.equal(rollEv.realizedPL, 0); // oldPrice === entryPrice
  assert.equal(rollEv.newEntryPrice, 17201.5); // 17200 + side(1)*1.5 slippage
  assert.equal(rollEv.fee, 120); // 60 * 2 legs
  assert.equal(rollEv.tax, 137); // round(17000*200*.00002)=68 + round(17201.5*200*.00002)=69
  assert.equal(rollEv.cost, 257);
  assert.equal(after.cash, 399615); // 399872 + 0 - 257
  assert.equal(after.positions[0].entryPrice, 17201.5);
});

test('rollover: no-op (empty events) when account is flat', () => {
  const acct = createAccount({ cash: 100000 });
  const { account: after, events } = rollover(acct, { date: '2024-08-21', oldPrice: 17000, newPrice: 17200 });
  assert.equal(events.length, 0);
  assert.equal(after.cash, 100000);
});

// ---------------------------------------------------------------------
// Rejected paths.
// ---------------------------------------------------------------------
test('open: rejected when available funds are below required initial margin + cost', () => {
  const acct = createAccount({ cash: 1000 });
  const { account: after, events } = open(acct, { date: '2024-01-02', product: 'TX', side: 1, lots: 1, price: 17000 });
  assert.equal(events[0].type, 'rejected');
  assert.equal(events[0].reason, 'insufficient_funds');
  assert.equal(after.cash, 1000);
  assert.equal(after.positions.length, 0);
});

test('close: rejected on no position and on insufficient lots', () => {
  const flat = createAccount({ cash: 100000 });
  const r1 = close(flat, { date: '2024-01-02', product: 'TX', lots: 1, price: 17000 });
  assert.equal(r1.events[0].type, 'rejected');
  assert.equal(r1.events[0].reason, 'no_position');

  let acct = createAccount({ cash: 400000 });
  ({ account: acct } = open(acct, { date: '2024-01-02', product: 'TX', side: 1, lots: 1, price: 17000 }));
  const r2 = close(acct, { date: '2024-01-03', product: 'TX', lots: 2, price: 17000 });
  assert.equal(r2.events[0].type, 'rejected');
  assert.equal(r2.events[0].reason, 'insufficient_lots');
});

test('withdraw: rejected when amount exceeds cash', () => {
  const acct = createAccount({ cash: 100 });
  const { account: after, events } = withdraw(acct, { date: '2024-01-02', amount: 200 });
  assert.equal(events[0].type, 'rejected');
  assert.equal(events[0].reason, 'insufficient_cash');
  assert.equal(after.cash, 100);
});

test('deposit/withdraw: normal path updates cash and emits typed events', () => {
  let acct = createAccount({ cash: 1000 });
  ({ account: acct } = deposit(acct, { date: '2024-01-02', amount: 500 }));
  assert.equal(acct.cash, 1500);
  const { account: after, events } = withdraw(acct, { date: '2024-01-03', amount: 300 });
  assert.equal(after.cash, 1200);
  assert.equal(events[0].type, 'withdraw');
});

// ---------------------------------------------------------------------
// Immutability: every operation returns a new object, original untouched.
// ---------------------------------------------------------------------
test('immutability: open/close/deposit/withdraw/markToMarket/checkIntraday/rollover never mutate their input account', () => {
  let acct = createAccount({ cash: 1000000 });
  ({ account: acct } = open(acct, { date: '2024-01-02', product: 'TX', side: 1, lots: 2, price: 17000 }));
  ({ account: acct } = open(acct, { date: '2024-01-02', product: 'MTX', side: -1, lots: 1, price: 17000 }));

  const before = snapshot(acct);

  open(acct, { date: '2024-01-03', product: 'TMF', side: 1, lots: 1, price: 17000 });
  assert.deepEqual(acct, before, 'open() mutated its input');

  close(acct, { date: '2024-01-03', product: 'TX', lots: 1, price: 17100 });
  assert.deepEqual(acct, before, 'close() mutated its input');

  deposit(acct, { date: '2024-01-03', amount: 100 });
  assert.deepEqual(acct, before, 'deposit() mutated its input');

  withdraw(acct, { date: '2024-01-03', amount: 100 });
  assert.deepEqual(acct, before, 'withdraw() mutated its input');

  markToMarket(acct, { date: '2024-01-03', settle: 15000 });
  assert.deepEqual(acct, before, 'markToMarket() mutated its input');

  checkIntraday(acct, { date: '2024-01-03', knots: [17000, 16000, 15000] });
  assert.deepEqual(acct, before, 'checkIntraday() mutated its input');

  rollover(acct, { date: '2024-08-21', oldPrice: 17000, newPrice: 17200 });
  assert.deepEqual(acct, before, 'rollover() mutated its input');
});

// ---------------------------------------------------------------------
// isSettlementDay anchors (第三個週三，不處理假日順延).
// ---------------------------------------------------------------------
test('isSettlementDay: known anchor dates', () => {
  assert.equal(isSettlementDay('2024-08-21'), true); // 3rd Wed of Aug 2024
  assert.equal(isSettlementDay('2020-03-18'), true); // 3rd Wed of Mar 2020
});

test('isSettlementDay: non-anchor dates are false', () => {
  assert.equal(isSettlementDay('2024-08-14'), false); // 2nd Wednesday
  assert.equal(isSettlementDay('2024-08-28'), false); // 4th Wednesday
  assert.equal(isSettlementDay('2024-08-20'), false); // Tuesday, not Wednesday at all
});

// ---------------------------------------------------------------------
// Sanity: product table matches the pinned contract.
// ---------------------------------------------------------------------
test('PRODUCTS: multipliers and default fees match the pinned contract', () => {
  assert.deepEqual(PRODUCTS.TX, { mult: 200, fee: 60 });
  assert.deepEqual(PRODUCTS.MTX, { mult: 50, fee: 30 });
  assert.deepEqual(PRODUCTS.TMF, { mult: 10, fee: 12 });
});

// =======================================================================
// Review round (GLM full review + opus 強平窄審) fixes below.
// =======================================================================

// ---------------------------------------------------------------------
// Fix 1 — opus regression: liquidation ranking must be PER-LOT loss, not
// total. TX 1 lot vs TMF 25 lots, same 1000-point drop: TX's per-lot loss
// (-200,000) is far worse than TMF's per-lot loss (-10,000), even though
// TMF's total loss (-250,000) is larger than TX's total (-200,000). Total-
// based ranking would wrongly pick TMF first and need several lot-cuts;
// per-lot ranking cuts exactly the 1 TX lot and stops.
// ---------------------------------------------------------------------
test('checkIntraday: ranks by per-lot loss, not total — TX 1 lot beats TMF 25 lots', () => {
  let acct = createAccount({ cash: 800000 });
  ({ account: acct } = open(acct, { date: '2024-01-02', product: 'TX', side: 1, lots: 1, price: 17000 }));
  ({ account: acct } = open(acct, { date: '2024-01-02', product: 'TMF', side: 1, lots: 25, price: 17000 }));
  assert.equal(acct.cash, 799497);

  const { account: after, events } = checkIntraday(acct, { date: '2024-01-03', knots: [16000] });
  const liqs = events.filter((e) => e.type === 'force_liquidation');
  assert.equal(liqs.length, 1, 'per-lot ranking should need exactly one cut (the TX lot)');
  assert.equal(liqs[0].product, 'TX');
  assert.equal(after.positions.length, 1);
  assert.equal(after.positions[0].product, 'TMF');
  assert.equal(after.positions[0].lots, 25);
  assert.equal(after.cash, 599373);
});

// ---------------------------------------------------------------------
// Fix 1 (tie-break) — equal per-lot loss -> larger multiplier liquidated
// first, and the result must not depend on which position was opened
// first (insertion order into account.positions).
// ---------------------------------------------------------------------
function buildTiedAccount(openOrder) {
  let acct = createAccount({ cash: 600000 });
  const openTX = () => ({ account: acct } = open(acct, { date: '2024-01-02', product: 'TX', side: 1, lots: 1, price: 17000 }));
  const openMTX = () => ({ account: acct } = open(acct, { date: '2024-01-02', product: 'MTX', side: 1, lots: 1, price: 20000 }));
  if (openOrder === 'TX-first') {
    openTX();
    openMTX();
  } else {
    openMTX();
    openTX();
  }
  return acct;
}

test('checkIntraday: tie on per-lot loss resolved by larger multiplier, regardless of open order (MTX opened first)', () => {
  const acct = buildTiedAccount('MTX-first');
  const { account: after, events } = checkIntraday(acct, { date: '2024-01-03', knots: [16000] });
  const liqs = events.filter((e) => e.type === 'force_liquidation');
  assert.equal(liqs.length, 1);
  assert.equal(liqs[0].product, 'TX'); // TX mult=200 > MTX mult=50, both tied at -200,000/lot
  assert.equal(after.positions.length, 1);
  assert.equal(after.positions[0].product, 'MTX');
});

test('checkIntraday: tie on per-lot loss resolved by larger multiplier, regardless of open order (TX opened first)', () => {
  const acct = buildTiedAccount('TX-first');
  const { account: after, events } = checkIntraday(acct, { date: '2024-01-03', knots: [16000] });
  const liqs = events.filter((e) => e.type === 'force_liquidation');
  assert.equal(liqs.length, 1);
  assert.equal(liqs[0].product, 'TX');
  assert.equal(after.positions.length, 1);
  assert.equal(after.positions[0].product, 'MTX');
});

// ---------------------------------------------------------------------
// Fix 2 — input validation: settle / knots must be finite numbers.
// ---------------------------------------------------------------------
test('markToMarket: throws on non-finite settle instead of silently no-op', () => {
  const acct = createAccount({ cash: 100000 });
  assert.throws(() => markToMarket(acct, { date: '2024-01-03', settle: NaN }), /finite number/);
  assert.throws(() => markToMarket(acct, { date: '2024-01-03', settle: undefined }), /finite number/);
});

test('checkIntraday: throws on a knots array containing non-numbers (e.g. bar objects) instead of silently disabling liquidation', () => {
  let acct = createAccount({ cash: 340200 });
  ({ account: acct } = open(acct, { date: '2024-01-02', product: 'TX', side: 1, lots: 1, price: 17000 }));

  // The exact failure opus reproduced: passing M2 bar objects instead of
  // a flat price array must fail loudly, not produce zero events.
  const barsInsteadOfKnots = [{ t: 0, o: 17000, h: 17000, l: 10000, c: 10000 }];
  assert.throws(() => checkIntraday(acct, { date: '2024-01-03', knots: barsInsteadOfKnots }), /finite number/);
  assert.throws(() => checkIntraday(acct, { date: '2024-01-03', knots: [17000, NaN, 16000] }), /finite number/);
  assert.throws(() => checkIntraday(acct, { date: '2024-01-03', knots: 'not-an-array' }), /finite number/);
});

// ---------------------------------------------------------------------
// Fix 3 — reversal funds check must use post-close-leg cash. Equity is
// just barely enough to close the held short, but not enough to also
// fund a large reversal into a big long — must reject the whole order's
// open leg (the close leg still executes; reversal is not atomic in this
// engine, see trading.js openReversal).
// ---------------------------------------------------------------------
test('open: reversal is rejected on the open leg when equity barely covers the close but not the new side', () => {
  let acct = createAccount({ cash: 600300 });
  ({ account: acct } = open(acct, { date: '2024-01-02', product: 'TX', side: -1, lots: 1, price: 17000 }));

  // price runs hard against the short; closing it will realize a huge loss
  const { account: after, events } = open(acct, { date: '2024-01-05', product: 'TX', side: 1, lots: 6, price: 20000 });
  const closeEv = events.find((e) => e.type === 'close');
  const rejectEv = events.find((e) => e.type === 'rejected');
  assert.ok(closeEv, 'the offsetting close leg should still execute');
  assert.equal(closeEv.realizedPL, -600000);
  assert.ok(rejectEv, 'the residual open leg should be rejected');
  assert.equal(rejectEv.reason, 'insufficient_funds');
  assert.equal(after.positions.length, 0, 'no new position opened after the rejected residual leg');
  // 600300 - 128(cost of the initial short open) = 600172 ; then the close
  // leg: 600172 - 600000(loss) - 60(fee) - 80(tax) = 32.
  assert.equal(after.cash, 32);
});

// ---------------------------------------------------------------------
// Fix 4 — rollover never rejects, but appends a margin_call (same shape
// as markToMarket's) when post-rollover equity — marked at newPrice, so
// the embedded slippage loss counts — falls below maintenance.
// ---------------------------------------------------------------------
test('rollover: always executes, and appends margin_call when post-rollover equity dips below maintenance', () => {
  let acct = createAccount({ cash: 400000 });
  ({ account: acct } = open(acct, { date: '2024-01-02', product: 'TX', side: 1, lots: 1, price: 17000 }));
  assert.equal(acct.cash, 399872);

  // settlement-day price has crashed hard against the long since entry
  const { account: after, events } = rollover(acct, { date: '2024-08-21', oldPrice: 15200, newPrice: 15200 });
  const rollEv = events.find((e) => e.type === 'rollover');
  const callEv = events.find((e) => e.type === 'margin_call');

  assert.ok(rollEv, 'rollover must still execute (never rejected)');
  assert.equal(after.positions.length, 1, 'position rolled forward, not dropped');
  assert.equal(after.cash, 39630);
  assert.ok(callEv, 'expected a margin_call after the rollover');
  assert.equal(callEv.equity, 39330);
  assert.equal(callEv.maintenanceRequired, 228000);
  assert.equal(callEv.initialRequired, 304000);
  assert.equal(callEv.requiredTopUp, 264670);
});

// ---------------------------------------------------------------------
// Fix 5 — profitable positions can still be force-liquidated when cash is
// deeply negative; the event's `reason` field must distinguish this from
// an ordinary loss-driven liquidation.
// ---------------------------------------------------------------------
test('checkIntraday: force-liquidating a profitable position is tagged reason="profit_realization"', () => {
  let acct = createAccount({ cash: 470000 });
  ({ account: acct } = open(acct, { date: '2024-01-02', product: 'TX', side: 1, lots: 1, price: 17000 }));
  ({ account: acct } = open(acct, { date: '2024-01-02', product: 'MTX', side: -1, lots: 1, price: 17000 }));
  assert.equal(acct.cash, 469825);

  // extreme crash: TX long gets crushed, MTX short profits hugely
  const { account: after, events } = checkIntraday(acct, { date: '2024-01-03', knots: [5000] });
  const liqs = events.filter((e) => e.type === 'force_liquidation');
  assert.equal(liqs.length, 2);

  assert.equal(liqs[0].product, 'TX');
  assert.equal(liqs[0].reason, 'loss');
  assert.equal(liqs[0].realizedPL, -2400000);

  assert.equal(liqs[1].product, 'MTX');
  assert.equal(liqs[1].reason, 'profit_realization');
  assert.equal(liqs[1].realizedPL, 600000);

  assert.equal(after.positions.length, 0);
  assert.equal(after.cash, -1330290);
});

// ---------------------------------------------------------------------
// Fix 6 — internal open helpers reject an unknown product defensively,
// independent of open()'s own up-front assertProduct call.
// ---------------------------------------------------------------------
test('open/close: unknown product throws immediately (assertProduct guard)', () => {
  const acct = createAccount({ cash: 100000 });
  assert.throws(() => open(acct, { date: '2024-01-02', product: 'BTC', side: 1, lots: 1, price: 100 }), /unknown product/);
  assert.throws(() => close(acct, { date: '2024-01-02', product: 'BTC', lots: 1, price: 100 }), /unknown product/);
});
