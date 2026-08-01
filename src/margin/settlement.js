// settlement.js — markToMarket (真實日K逐日洗價) and checkIntraday
// (生成日內細路徑逐點盤中強平) for the M3 margin engine (SPEC.md §4, §9-1/§9-5).
//
// These two functions are the module's only price-consuming entry points
// besides open/close/rollover, and they are deliberately kept price-source
// agnostic: markToMarket takes whatever `settle` the caller passes (game
// layer is responsible for passing the real daily settle price) and
// checkIntraday takes whatever `knots` array the caller passes — per SPEC
// §4, this is the *fine* generated intraday path (301 points covering the
// full session, not the 60 aggregated 5-minute bars), so wicks participate
// in the margin-call check. This module never reads the static data
// directory or calls into src/engine/ itself — enforcing the "觸價判定只認
// 生成日內層、逐日結算認真實日K" separation is the caller's job, verified
// by tests that show neither function does any file I/O or imports from
// src/engine/. Both functions validate their price input(s) are finite
// numbers and throw otherwise, so a caller accidentally passing bar objects
// or NaN fails loudly instead of silently disabling liquidation.

import { PRODUCTS } from './products.js';
import { taxPerLot, feePerLot, roundTWD } from './products.js';
import { equityOf, positionsInitialReq, positionsMaintenanceReq, unrealizedPL, withLedger } from './core.js';

// 每日結算：權益數 < 全部部位維持保證金 → margin_call 事件，附 requiredTopUp
// （補到「原始保證金」水位，業界慣例：追繳補的是原始保證金而非僅補到維持線，
// 於此註明以便之後若要改規則可一眼找到）。不移動 cash（本模型不做逐日變動
// 保證金現金結算，已實現損益只在 close/rollover/強平當下才進 cash，見 core.js 頭註）。
export function markToMarket(account, { date, settle }) {
  if (!Number.isFinite(settle)) {
    throw new Error(`markToMarket: settle must be a finite number, got ${JSON.stringify(settle)}`);
  }

  const equity = equityOf(account, settle);
  const maintenanceRequired = positionsMaintenanceReq(account.positions, settle);
  const events = [{ type: 'settle', date, settle, equity, maintenanceRequired }];

  if (account.positions.length > 0 && equity < maintenanceRequired) {
    const initialRequired = positionsInitialReq(account.positions, settle);
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

  return { account: withLedger(account, events), events };
}

// 強平排序鍵（SPEC §4 釘死）：**每口**未實現虧損最大者優先 —— 用
// unrealizedPL(p)/p.lots 而非總額比較，避免「口數多的部位總額大就先被
// 沒收」的懲罰性排序（例：TX 1 口 vs TMF 25 口同樣跌 1000 點，TX 每口賠
// 20 萬遠比 TMF 每口賠 1 萬慘，理應先砍 TX；用總額排序會先錯砍 TMF 一路砍
// 到六口）。平手（每口損益剛好相等）→ 乘數大者優先；再平手 → 開倉較早者
// 優先。現金為負但所有部位都在賺錢時，同一條規則自然會選到「每口獲利最少」
// 的部位強制實現獲利（SPEC：「現金為負而部位皆獲利時，同一機制會強平獲利
// 部位以實現獲利回補」）——不是分支特例，就是同一個比較鍵的自然結果。
function pickLiquidationTarget(positions, price) {
  let best = positions[0];
  let bestKey = unrealizedPL(best, price) / best.lots;
  for (let i = 1; i < positions.length; i++) {
    const p = positions[i];
    const key = unrealizedPL(p, price) / p.lots;
    if (isHigherLiquidationPriority(key, p, bestKey, best)) {
      best = p;
      bestKey = key;
    }
  }
  return best;
}

function isHigherLiquidationPriority(key, p, bestKey, best) {
  if (key < bestKey) return true;
  if (key > bestKey) return false;
  const pMult = PRODUCTS[p.product].mult;
  const bestMult = PRODUCTS[best.product].mult;
  if (pMult !== bestMult) return pMult > bestMult;
  return p.openDate < best.openDate;
}

// 盤中強平：對 knots（生成日內細路徑，逐點，含影線）逐點計算權益，跌破
// 維持保證金 → 依 pickLiquidationTarget 排序砍倉，一次一口，砍完重新評估
// （可能換到另一個部位、可能同一部位繼續砍），直到權益回到維持保證金以
// 上，或部位全部平完為止（現金即使仍是負值，只要沒有部位可砍就停手——
// 帳戶可以留在負權益狀態，這是刻意的：M3 不做超額追繳或帳戶凍結，那是
// 遊戲層的敘事，不是保證金引擎的機制）。
export function checkIntraday(account, { date, knots }, options = {}) {
  if (!Array.isArray(knots)) {
    throw new Error('checkIntraday: knots must be an array of finite numbers');
  }
  for (let i = 0; i < knots.length; i++) {
    if (!Number.isFinite(knots[i])) {
      throw new Error(`checkIntraday: knots[${i}] must be a finite number, got ${JSON.stringify(knots[i])}`);
    }
  }

  let working = account;
  const events = [];

  for (let knotIndex = 0; knotIndex < knots.length; knotIndex++) {
    const price = knots[knotIndex];
    let equity = equityOf(working, price);
    let maintenanceRequired = positionsMaintenanceReq(working.positions, price);

    while (working.positions.length > 0 && equity < maintenanceRequired) {
      const target = pickLiquidationTarget(working.positions, price);
      const targetTotalPL = unrealizedPL(target, price);
      const reason = targetTotalPL >= 0 ? 'profit_realization' : 'loss';

      const fee = feePerLot(target.product, options);
      const tax = taxPerLot(price, target.product);
      const lotPL = roundTWD((price - target.entryPrice) * target.side * PRODUCTS[target.product].mult);
      const remaining = target.lots - 1;
      const newPositions = remaining > 0
        ? working.positions.map((p) => (p === target ? { ...p, lots: remaining } : p))
        : working.positions.filter((p) => p !== target);

      working = { ...working, cash: working.cash + lotPL - fee - tax, positions: newPositions };

      const equityAfter = equityOf(working, price);
      events.push({
        type: 'force_liquidation',
        date,
        knotIndex,
        product: target.product,
        side: target.side,
        lots: 1,
        price,
        realizedPL: lotPL,
        fee,
        tax,
        reason,
        equityAfter,
      });
      events.push({ type: 'cost', date, product: target.product, category: 'force_liquidation', fee, tax, total: fee + tax });

      equity = equityAfter;
      maintenanceRequired = positionsMaintenanceReq(working.positions, price);
    }
  }

  return { account: withLedger(working, events), events };
}
