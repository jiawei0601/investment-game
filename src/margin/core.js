// core.js — account shape, margin formula, deposit/withdraw, and the
// shared equity/margin-requirement math used by trading.js + settlement.js
// (M3 margin engine, SPEC.md §4 pinned formulas).
//
// Account shape: { cash, positions, ledger }
//   cash      — settled cash balance (deposits/withdrawals, realized P&L,
//               fees/tax, rollover cost). Unrealized P&L is NEVER folded
//               into cash automatically (no daily variation-margin cash
//               settlement in this simplified model) — it only affects
//               `cash` at the moment a position is closed/rolled/liquidated.
//   positions — array of at most one entry per product: {product, side,
//               lots, entryPrice, openDate}. side is +1 (long) or -1 (short).
//   ledger    — append-only history of every event this account has ever
//               produced (the "紀錄簿" required by the M3 contract).
//
// Every exported function here (and in trading.js / settlement.js) is pure:
// it never mutates its `account` argument and always returns a new object.

import { PRODUCTS, assertProduct, roundTWD } from './products.js';

export function createAccount({ cash }) {
  return { cash, positions: [], ledger: [] };
}

// 保證金（近似制，SPEC §4 釘死）：原始＝price×乘數×0.10、維持＝原始×0.75。
export function computeMargin(price, product) {
  assertProduct(product);
  const initial = roundTWD(price * PRODUCTS[product].mult * 0.1);
  const maintenance = roundTWD(initial * 0.75);
  return { initial, maintenance };
}

export function unrealizedPL(position, price) {
  const mult = PRODUCTS[position.product].mult;
  return roundTWD((price - position.entryPrice) * position.side * mult * position.lots);
}

export function equityOf(account, price) {
  let pl = 0;
  for (const p of account.positions) pl += unrealizedPL(p, price);
  return account.cash + pl;
}

export function positionsInitialReq(positions, price) {
  let req = 0;
  for (const p of positions) req += computeMargin(price, p.product).initial * p.lots;
  return req;
}

export function positionsMaintenanceReq(positions, price) {
  let req = 0;
  for (const p of positions) req += computeMargin(price, p.product).maintenance * p.lots;
  return req;
}

function appendLedger(account, events) {
  return events.length ? [...account.ledger, ...events] : account.ledger;
}

export function withLedger(account, events) {
  return { ...account, ledger: appendLedger(account, events) };
}

export function deposit(account, { date, amount }) {
  if (!(amount > 0)) throw new Error('deposit: amount must be positive');
  const newCash = account.cash + amount;
  const ev = { type: 'deposit', date, amount, cashAfter: newCash };
  return { account: withLedger({ ...account, cash: newCash }, [ev]), events: [ev] };
}

export function withdraw(account, { date, amount }) {
  if (!(amount > 0)) throw new Error('withdraw: amount must be positive');
  if (amount > account.cash) {
    const ev = {
      type: 'rejected',
      date,
      action: 'withdraw',
      reason: 'insufficient_cash',
      amount,
      cash: account.cash,
    };
    return { account: withLedger(account, [ev]), events: [ev] };
  }
  const newCash = account.cash - amount;
  const ev = { type: 'withdraw', date, amount, cashAfter: newCash };
  return { account: withLedger({ ...account, cash: newCash }, [ev]), events: [ev] };
}
