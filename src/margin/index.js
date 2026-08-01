// index.js — public API barrel for the M3 margin engine.
// See products.js / core.js / trading.js / settlement.js / calendar.js
// for implementation and per-function contract notes.

export { PRODUCTS, TAX_RATE, ROLLOVER_SLIPPAGE_DEFAULT, roundTWD } from './products.js';
export {
  createAccount,
  computeMargin,
  deposit,
  withdraw,
  equityOf,
  unrealizedPL,
  positionsInitialReq,
  positionsMaintenanceReq,
} from './core.js';
export { open, close, rollover } from './trading.js';
export { markToMarket, checkIntraday, checkAtPrice, pickLiquidationTarget } from './settlement.js';
export { isSettlementDay } from './calendar.js';
