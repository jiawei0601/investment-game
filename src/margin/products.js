// products.js — product table, tax rate, and shared money-rounding rule
// for the M3 margin engine (SPEC.md §4, docs/backlog/M3-matching-and-accounting.md).
//
// Rounding rule (documented once here, applies to every money amount the
// margin engine produces: margin, fee, tax, realized/unrealized P&L):
//   roundTWD(x) = round-half-away-from-zero to the nearest integer TWD.
//   i.e. positive amounts round the normal way; negative amounts are
//   rounded by magnitude then re-signed, so -0.5 -> -1, not -0 or 0.
//   All monetary fields returned by this module's functions are integers.
//   Point/price values themselves (e.g. rollover slippage of 1.5 points)
//   are NOT forced to integers — only money (NT$) amounts are.

export const PRODUCTS = Object.freeze({
  TX: Object.freeze({ mult: 200, fee: 60 }),
  MTX: Object.freeze({ mult: 50, fee: 30 }),
  TMF: Object.freeze({ mult: 10, fee: 12 }),
});

// 期交稅：契約價值 × 十萬分之二，單邊（每次成交、每口都課一次：開倉一次、平倉一次）。
export const TAX_RATE = 0.00002;

// 轉倉固定滑價（點），SPEC §4：1-2 點，預設 1.5，可由 rollover() options 覆寫。
export const ROLLOVER_SLIPPAGE_DEFAULT = 1.5;

export function roundTWD(x) {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

export function assertProduct(product) {
  if (!Object.prototype.hasOwnProperty.call(PRODUCTS, product)) {
    throw new Error(`margin: unknown product "${product}" (expected TX/MTX/TMF)`);
  }
}

// 契約價值（單口）＝ price × 乘數。
export function contractValue(price, product) {
  assertProduct(product);
  return price * PRODUCTS[product].mult;
}

// 單口單邊期交稅（已四捨五入為整數台幣）。
export function taxPerLot(price, product) {
  return roundTWD(contractValue(price, product) * TAX_RATE);
}

// 單口單邊手續費，預設取商品表，可由 options.fee 覆寫。
export function feePerLot(product, options = {}) {
  assertProduct(product);
  return options.fee ?? PRODUCTS[product].fee;
}
