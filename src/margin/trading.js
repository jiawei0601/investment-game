// trading.js — open / close / rollover (M3 margin engine, SPEC.md §4).
//
// Position model: at most one position per product (net position). Opening
// on the same side as an existing position merges lots with a lot-weighted
// average entry price. Opening on the opposite side nets against the held
// lots first (realizing P&L on the offset portion, charged as a close),
// then — if the new order's lots exceed what was held — opens the residual
// as a fresh position on the new side (charged as an open, margin-checked
// on its own). This is the standard "反手" (reversal) behavior.
//
// Funds check (SPEC: "檢查可用資金 ≥ 所需原始保證金＋費稅，不足回 rejected"):
// available cash for a new/larger position = account equity at the trade
// price, minus the initial-margin requirement of every OTHER product's
// position (also marked at the trade price) — i.e. margin is not a
// separate locked bucket, it's re-derived from current price every time.

import { PRODUCTS, assertProduct, taxPerLot, feePerLot, roundTWD, ROLLOVER_SLIPPAGE_DEFAULT } from './products.js';
import { computeMargin, equityOf, positionsInitialReq, positionsMaintenanceReq, withLedger } from './core.js';

function costEvent(date, product, category, fee, tax) {
  return { type: 'cost', date, product, category, fee, tax, total: fee + tax };
}

// Shared funds check for opening/growing a position in `product` to
// `newTotalLots`, where only `incrementalLots` are actually being traded
// (and therefore charged fee/tax) right now.
function checkFunds(account, product, newTotalLots, incrementalLots, price, options) {
  const fee = feePerLot(product, options) * incrementalLots;
  const tax = taxPerLot(price, product) * incrementalLots;
  const cost = fee + tax;
  const marginForThis = computeMargin(price, product).initial * newTotalLots;
  const otherPositions = account.positions.filter((p) => p.product !== product);
  const otherReq = positionsInitialReq(otherPositions, price);
  const equity = equityOf(account, price);
  const available = equity - otherReq;
  const required = marginForThis + cost;
  return { ok: available >= required, fee, tax, cost, marginForThis, available, required };
}

function rejectedOpen(account, date, product, side, lots, price, check) {
  const ev = {
    type: 'rejected',
    date,
    action: 'open',
    reason: 'insufficient_funds',
    product,
    side,
    lots,
    price,
    required: check.required,
    available: check.available,
  };
  return { account: withLedger(account, [ev]), events: [ev] };
}

// openFresh/openMerge/openReversal are module-private (not exported).
// open() already validates `product` before dispatching to any of them,
// but each also re-asserts it directly (assertProduct is cheap) so that if
// one is ever called from a new path that skips open()'s own check, an
// invalid product still fails loudly here rather than propagating silently.
function openFresh(account, { date, product, side, lots, price }, options) {
  assertProduct(product);
  const check = checkFunds(account, product, lots, lots, price, options);
  if (!check.ok) return rejectedOpen(account, date, product, side, lots, price, check);

  const newCash = account.cash - check.cost;
  const newPositions = [...account.positions, { product, side, lots, entryPrice: price, openDate: date }];
  const events = [
    { type: 'open', date, product, side, lots, price, fee: check.fee, tax: check.tax, marginRequired: check.marginForThis },
    costEvent(date, product, 'open', check.fee, check.tax),
  ];
  return { account: withLedger({ ...account, cash: newCash, positions: newPositions }, events), events };
}

function openMerge(account, existing, { date, product, side, lots, price }, options) {
  assertProduct(product);
  const combinedLots = existing.lots + lots;
  const check = checkFunds(account, product, combinedLots, lots, price, options);
  if (!check.ok) return rejectedOpen(account, date, product, side, lots, price, check);

  const avgEntry = roundTWD((existing.entryPrice * existing.lots + price * lots) / combinedLots);
  const newCash = account.cash - check.cost;
  const newPositions = account.positions.map((p) =>
    p.product === product ? { ...p, lots: combinedLots, entryPrice: avgEntry } : p
  );
  const events = [
    { type: 'open', date, product, side, lots, price, fee: check.fee, tax: check.tax, marginRequired: check.marginForThis },
    costEvent(date, product, 'open', check.fee, check.tax),
  ];
  return { account: withLedger({ ...account, cash: newCash, positions: newPositions }, events), events };
}

function openReversal(account, existing, { date, product, side, lots, price }, options) {
  assertProduct(product);
  const closeLots = Math.min(existing.lots, lots);
  const openLots = lots - closeLots;

  const fee = feePerLot(product, options) * closeLots;
  const tax = taxPerLot(price, product) * closeLots;
  const realizedPL = roundTWD((price - existing.entryPrice) * existing.side * PRODUCTS[product].mult * closeLots);
  const cost = fee + tax;
  const remaining = existing.lots - closeLots;
  const positionsAfterClose = remaining > 0
    ? account.positions.map((p) => (p.product === product ? { ...p, lots: remaining } : p))
    : account.positions.filter((p) => p.product !== product);

  const closeEvents = [
    { type: 'close', date, product, lots: closeLots, price, fee, tax, realizedPL },
    costEvent(date, product, 'close', fee, tax),
  ];
  let working = withLedger({ ...account, cash: account.cash + realizedPL - cost, positions: positionsAfterClose }, closeEvents);
  let events = closeEvents;

  if (openLots > 0) {
    const openResult = openFresh(working, { date, product, side, lots: openLots, price }, options);
    working = openResult.account;
    events = events.concat(openResult.events);
  }

  return { account: working, events };
}

export function open(account, { date, product, side, lots, price }, options = {}) {
  assertProduct(product);
  if (!Number.isInteger(lots) || lots <= 0) throw new Error('open: lots must be a positive integer');
  if (side !== 1 && side !== -1) throw new Error('open: side must be +1 or -1');

  const existing = account.positions.find((p) => p.product === product);
  if (!existing) return openFresh(account, { date, product, side, lots, price }, options);
  if (existing.side === side) return openMerge(account, existing, { date, product, side, lots, price }, options);
  return openReversal(account, existing, { date, product, side, lots, price }, options);
}

export function close(account, { date, product, lots, price }, options = {}) {
  assertProduct(product);
  const existing = account.positions.find((p) => p.product === product);
  if (!existing || !Number.isInteger(lots) || lots <= 0 || lots > existing.lots) {
    const ev = {
      type: 'rejected',
      date,
      action: 'close',
      reason: !existing ? 'no_position' : 'insufficient_lots',
      product,
      lots,
      price,
    };
    return { account: withLedger(account, [ev]), events: [ev] };
  }

  const fee = feePerLot(product, options) * lots;
  const tax = taxPerLot(price, product) * lots;
  const realizedPL = roundTWD((price - existing.entryPrice) * existing.side * PRODUCTS[product].mult * lots);
  const cost = fee + tax;
  const remaining = existing.lots - lots;
  const newPositions = remaining > 0
    ? account.positions.map((p) => (p.product === product ? { ...p, lots: remaining } : p))
    : account.positions.filter((p) => p.product !== product);

  const events = [
    { type: 'close', date, product, lots, price, fee, tax, realizedPL },
    costEvent(date, product, 'close', fee, tax),
  ];
  return { account: withLedger({ ...account, cash: account.cash + realizedPL - cost, positions: newPositions }, events), events };
}

// 結算日對所有部位平舊開新：滑價 1.5 點（可覆寫）＋雙邊費稅。
// newEntryPrice = newPrice + side*slippage（多單買貴、空單賣便宜，滑價永遠不利於玩家）。
// SPEC §4 釘死：轉倉**必然執行、不做資金檢查**（reject 會讓部位留在已到期
// 合約上，曝險比轉倉本身更糟）。轉倉後若權益（以 newPrice 洗價——新倉剛
// 開時 entryPrice 已含滑價，用 newPrice 才能看出滑價造成的立即帳面虧損）
// 低於維持保證金，立即補一個 margin_call 事件，算法與 markToMarket 同一套。
export function rollover(account, { date, oldPrice, newPrice }, options = {}) {
  if (account.positions.length === 0) return { account: withLedger(account, []), events: [] };

  const slippage = options.slippage ?? ROLLOVER_SLIPPAGE_DEFAULT;
  let cash = account.cash;
  const newPositions = [];
  const events = [];

  for (const pos of account.positions) {
    const mult = PRODUCTS[pos.product].mult;
    const fee = feePerLot(pos.product, options);
    const closeTax = taxPerLot(oldPrice, pos.product);
    const realizedPL = roundTWD((oldPrice - pos.entryPrice) * pos.side * mult * pos.lots);
    const newEntryPrice = newPrice + pos.side * slippage;
    const openTax = taxPerLot(newEntryPrice, pos.product);

    const totalFee = fee * 2 * pos.lots;
    const totalTax = (closeTax + openTax) * pos.lots;
    const cost = totalFee + totalTax;
    cash += realizedPL - cost;

    newPositions.push({ ...pos, entryPrice: newEntryPrice, openDate: date });
    events.push({
      type: 'rollover',
      date,
      product: pos.product,
      side: pos.side,
      lots: pos.lots,
      oldPrice,
      newPrice,
      slippage,
      newEntryPrice,
      realizedPL,
      fee: totalFee,
      tax: totalTax,
      cost,
    });
    events.push(costEvent(date, pos.product, 'rollover', totalFee, totalTax));
  }

  const newAccount = { ...account, cash, positions: newPositions };
  const equity = equityOf(newAccount, newPrice);
  const maintenanceRequired = positionsMaintenanceReq(newPositions, newPrice);
  if (equity < maintenanceRequired) {
    const initialRequired = positionsInitialReq(newPositions, newPrice);
    const requiredTopUp = roundTWD(initialRequired - equity);
    events.push({
      type: 'margin_call',
      date,
      equity,
      maintenanceRequired,
      initialRequired,
      requiredTopUp,
    });
  }

  return { account: withLedger(newAccount, events), events };
}
