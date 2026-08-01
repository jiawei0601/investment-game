// session.js — M4 game session layer: the state machine that strings
// together M2 (generateIntraday), M3 (margin engine) and the M4 behavior
// system into one day-by-day playthrough (SPEC.md §2 "按日推進", §4).
//
// Immutable-update style, same convention as src/margin (M3): every exported
// function takes a `session` and returns a *new* session object; nothing is
// mutated in place. `createSession(...)` builds the initial session;
// `queueOrder(session, order)` appends a player instruction; `advanceDay(session)`
// processes exactly one trading day and returns the next session (with a
// freshly recomputed event log / violations / score); `applyShock(session, ...)`
// is the cash-shock interface M5 calls explicitly (SPEC §4 "現金流 = C").
//
// ---------------------------------------------------------------------------
// Event stream contract (session.events, append-only, this is the data M7's
// battle report and src/behavior/violations.js both consume):
//   Every event emitted by the margin engine (open/close/rollover/settle/
//   margin_call/force_liquidation/cost/rejected/deposit/withdraw) is copied
//   into session.events verbatim, in the exact order the margin engine
//   returned them, *except* 'open' events get one extra field
//   (`marginUsageRatioAtEntry` — src/margin's public barrel doesn't compute
//   a ratio for the caller, only the raw equity/margin-requirement building
//   blocks the game layer combines itself), and every event produced during
//   the single intraday knot walk (see runIntradaySession below) gets a
//   `knotIndex` field spliced in so the whole day's slice of session.events
//   can be checked for knotIndex monotonicity (tests/game.test.js does this).
//   Game-layer-only event types added on top: 'thesis', 'intraday',
//   'day_close', 'overnight_hold', 'risk_snapshot', 'order_filled',
//   'margin_call_enforcement', 'shock'. Shapes match what
//   src/behavior/violations.js documents at the top of that file.
//
// ---------------------------------------------------------------------------
// Single-timeline intraday walk (runIntradaySession): player stop/limit
// fills and the margin engine's own forced-liquidation checks share ONE
// knot-by-knot loop (knotIndex 0 -> knots.length-1). At each knot: any
// one-shot market/close orders fire first (only at knotIndex 0, "次一 knot
// 成交"), then any persistent stop/limit order whose trigger price is
// touched *at this knot* fires, and only after both of those does
// checkAtPrice() (src/margin/settlement.js's single-price liquidation entry
// point) run at that same price. This guarantees knotIndex never goes
// backwards across the day's event slice — a player fill and a market-
// driven liquidation can never appear out of the true time order they
// happened in, which a two-pass "run all orders, then re-sweep the whole
// day" design could produce.
//
// Pre-market margin-call enforcement (enforceMarginCall, SPEC §4「追繳執行
// 者」) happens *before* today's knot walk even starts (it prices off
// yesterday's settle, not today's path), so its events are tagged
// knotIndex: -1 — strictly before knot 0, preserving the same monotonicity
// guarantee across the enforcement -> knot-walk -> end-of-day boundary.
//
// Known simplification (documented rather than hidden — this is an M4-scope
// MVP, not a full order-matching simulator): settlement-day rollover uses
// `oldPrice = newPrice = settle` (or the settle-fallback close).
// data/daily/TX.json is already a single spliced continuous front-month
// series (see TX-rolls.json for the underlying contract-switch price gaps,
// which this module intentionally does not consume — SPEC §4 pins rollover
// cost to the fixed slippage/fee/tax model, not to reproducing the
// historical contract gap).

import { generateIntraday } from '../engine/intraday.js';
import { buildSeed, createRng } from '../engine/rng.js';
import {
  PRODUCTS,
  createAccount,
  deposit,
  open,
  close,
  rollover,
  markToMarket,
  checkAtPrice,
  pickLiquidationTarget,
  equityOf,
  unrealizedPL,
  positionsInitialReq,
  isSettlementDay,
} from '../margin/index.js';
import { detectViolations } from '../behavior/violations.js';
import { computeScore } from '../behavior/score.js';

function monthOf(dateStr) {
  return dateStr.slice(0, 7); // 'YYYY-MM'
}

function rowsBetween(dailyRows, startDate, endDate) {
  return dailyRows.filter((r) => r.date >= startDate && r.date <= endDate).sort((a, b) => (a.date < b.date ? -1 : 1));
}

// SPEC §4: 每局最多一次的現金衝擊事件，觸發時機偏好回撤最深十分位日，
// 用種子 RNG（不用 Math.random，AGENTS.md 種子慣例）。回撤在此定義為 level
// 骨架本身（真實日K收盤）從其歷史高點算起的百分比——這是開局就能算好的
// 量，不需要玩家實際打法。
function pickShockDayIndex(rows, seed) {
  if (rows.length === 0) return -1;
  let peak = rows[0].close;
  const drawdowns = rows.map((r, i) => {
    peak = Math.max(peak, r.close);
    const dd = peak > 0 ? (peak - r.close) / peak : 0;
    return { i, dd };
  });
  const sorted = [...drawdowns].sort((a, b) => b.dd - a.dd);
  const decileCount = Math.max(1, Math.ceil(sorted.length * 0.1));
  const pool = sorted.slice(0, decileCount);
  const rng = createRng(`${seed}|shock`);
  const pick = Math.floor(rng() * pool.length);
  return pool[Math.min(pick, pool.length - 1)].i;
}

export function createSession({ levelId, attempt, startDate, endDate, initialCash, plan, monthlyIncome = 0, dailyRows }) {
  const rows = rowsBetween(dailyRows, startDate, endDate);
  if (rows.length === 0) {
    throw new Error(`createSession: no trading days between ${startDate} and ${endDate}`);
  }
  const account = createAccount({ cash: initialCash });
  const shockSeed = buildSeed(levelId, attempt, `${startDate}..${endDate}`);

  return Object.freeze({
    levelId,
    attempt,
    plan,
    monthlyIncome,
    rows,
    cursor: 0,
    account,
    orderQueue: [],
    events: [],
    pendingMarginCall: null,
    lastSettlePrice: rows[0].open,
    lastIncomeMonth: null,
    peakEquity: initialCash,
    settleFallbackWarned: false,
    shockDayIndex: pickShockDayIndex(rows, shockSeed),
    shockUsed: false,
    violations: [],
    score: 100,
    scoreCounts: {
      bag_holding: 0,
      bag_holding_continued: 0,
      unplanned_trade: 0,
      risk_out_of_control: 0,
      thesis_drift: 0,
      martingale_add: 0,
    },
    finished: false,
  });
}

// 玩家指令佇列。market/close 是一次性指令（下一次 advanceDay 的第一個 knot
// 成交後即消耗掉）；stop/limit 是持續掛單（留在佇列直到觸價或被
// cancelOrder 取消）；overnight_reason 是一次性的過夜理由（套用到下一次
// advanceDay 當天的收盤過夜檢查）。
export function queueOrder(session, order) {
  return { ...session, orderQueue: [...session.orderQueue, { id: `${session.orderQueue.length}-${session.cursor}`, ...order }] };
}

export function cancelOrder(session, orderId) {
  return { ...session, orderQueue: session.orderQueue.filter((o) => o.id !== orderId) };
}

function requireThesisIfNewOrReversal(account, order) {
  const existing = account.positions.find((p) => p.product === order.product);
  const isFreshOrReversal = !existing || existing.side !== order.side;
  if (isFreshOrReversal && !(typeof order.thesis === 'string' && order.thesis.trim().length > 0)) {
    throw new Error(
      `advanceDay: market order opening/reversing ${order.product} requires a non-empty thesis ` +
        `("一句話：為什麼是現在、為什麼是這個方向？")`
    );
  }
}

function tagOpenEventsWithMarginRatio(events, accountBeforeTrade, price) {
  return events.map((ev) => {
    if (ev.type !== 'open') return ev;
    const equity = equityOf(accountBeforeTrade, price);
    const ratio = equity > 0 ? ev.marginRequired / equity : Infinity;
    return { ...ev, marginUsageRatioAtEntry: ratio };
  });
}

// Step 0（SPEC §4「追繳執行者」）：昨天結算/轉倉若發出 margin_call 而玩家
// 沒有補足資金，今天開盤前先按強平排序砍到「原始保證金」滿足為止（比
// checkIntraday 的維持保證金門檻更嚴——這是追繳補到位的定義，非強平的定
// 義，兩者刻意不同）。
//
// 預期行為（GLM 終審 fix 3，補註解不改邏輯）：在極端行情下，若價格持續朝
// 不利方向惡化，equity（隨每次砍倉重算）可能永遠追不上 required（原始保
// 證金需求，同樣隨剩餘部位與當前價格重算），這個 while 迴圈會一路砍到
// account.positions.length === 0 才停手（迴圈條件本身保證：沒部位可砍就沒
// 東西再讓 equity 惡化，一定終止）。這是數學上的唯一結局，不是 bug：SPEC
// §4 明文「M3 不做超額追繳或帳戶凍結」——保證金引擎（以及套用同一套規則的
// 這個追繳執行者）本來就不負責在權益歸零之後生出更多資金，只負責把部位砍
// 到符合規則要求的狀態，砍光就是這條規則在缺錢缺到底時唯一能做的事。
function enforceMarginCall(session, priceForEnforcement, date) {
  if (!session.pendingMarginCall) return { account: session.account, events: [] };
  let account = session.account;
  const events = [];
  let equity = equityOf(account, priceForEnforcement);
  let required = positionsInitialReq(account.positions, priceForEnforcement);

  while (account.positions.length > 0 && equity < required) {
    const target = pickLiquidationTarget(account.positions, priceForEnforcement);
    const result = close(account, { date, product: target.product, lots: 1, price: priceForEnforcement });
    account = result.account;
    // Keep the original 'close' event untouched (violations.js's position
    // replay relies on type==='close' to track open lots) and additionally
    // tag this batch with a distinct 'margin_call_enforcement' marker event
    // so the battle report / tests can tell forced-enforcement closes apart
    // from a player-initiated close. knotIndex: -1 — this happens before
    // today's knot walk even starts (priced off yesterday's settle), so it
    // sorts strictly before knotIndex 0 in the monotonicity check.
    events.push(...result.events.map((ev) => ({ ...ev, knotIndex: -1 })));
    const closeEv = result.events.find((ev) => ev.type === 'close');
    if (closeEv) {
      events.push({
        type: 'margin_call_enforcement',
        date,
        knotIndex: -1,
        product: closeEv.product,
        lots: closeEv.lots,
        price: closeEv.price,
        realizedPL: closeEv.realizedPL,
      });
    }
    equity = equityOf(account, priceForEnforcement);
    required = positionsInitialReq(account.positions, priceForEnforcement);
  }

  return { account, events };
}

// 單一時序 knot 迴圈：玩家掛單成交與 M3 的強平檢查（checkAtPrice）共用同一
// 個逐 knot 迴圈，兩者依實際觸發的 knot 順序交錯寫入事件流，knotIndex 全程
// 不會倒流。market/close/overnight_reason 是一次性單，只在 knotIndex===0
// 消耗（「次一 knot 成交」）；stop/limit 是持續單，逐 knot 掃描第一次觸價，
// 沒觸發就留在佇列跨日持續掛著。每個 knot 處理完當下所有的單之後，才呼叫
// 一次 checkAtPrice——順序是「這個 knot 的成交先發生，才輪到用成交後的部位
// 狀態去檢查保證金是否足夠」，這正是要修正的時序倒流問題的核心。
function runIntradaySession(account, orderQueue, knots, date) {
  let working = account;
  const events = [];
  const overnightReasons = {};
  const oneShot = orderQueue.filter((o) => o.kind !== 'stop' && o.kind !== 'limit');
  let pending = orderQueue.filter((o) => o.kind === 'stop' || o.kind === 'limit');

  for (let knotIndex = 0; knotIndex < knots.length; knotIndex++) {
    const price = knots[knotIndex];

    if (knotIndex === 0) {
      for (const order of oneShot) {
        if (order.kind === 'market') {
          requireThesisIfNewOrReversal(working, order);
          const accountBefore = working;
          if (order.thesis) events.push({ type: 'thesis', date, knotIndex, product: order.product, thesis: order.thesis });
          const result = open(working, { date, product: order.product, side: order.side, lots: order.lots, price });
          working = result.account;
          events.push(...tagOpenEventsWithMarginRatio(result.events, accountBefore, price).map((ev) => ({ ...ev, knotIndex })));
        } else if (order.kind === 'close') {
          const result = close(working, { date, product: order.product, lots: order.lots, price });
          working = result.account;
          events.push(...result.events.map((ev) => ({ ...ev, knotIndex })));
        } else if (order.kind === 'overnight_reason') {
          overnightReasons[order.product] = order.reason;
        }
      }
    }

    // Persistent stop/limit orders: fire the first ones touched at this
    // exact knot (partial-lot fills clamp to whatever's still held).
    const stillPending = [];
    for (const order of pending) {
      const pos = working.positions.find((p) => p.product === order.product);
      if (!pos) continue; // nothing left to close, drop the now-orphaned order
      const touched = pos.side === 1 ? price <= order.triggerPrice : price >= order.triggerPrice;
      if (touched) {
        const lots = Math.min(order.lots, pos.lots);
        const result = close(working, { date, product: order.product, lots, price });
        working = result.account;
        events.push(
          ...result.events.map((ev) => ({ ...ev, knotIndex })),
          { type: 'order_filled', date, knotIndex, orderKind: order.kind, product: order.product, lots, price }
        );
      } else {
        stillPending.push(order);
      }
    }
    pending = stillPending;

    // Margin engine's own forced-liquidation check, same price point, run
    // *after* this knot's order fills so it sees the post-fill positions.
    const liq = checkAtPrice(working, { date, price, knotIndex });
    working = liq.account;
    events.push(...liq.events);
  }

  return { account: working, events, orderQueue: pending, overnightReasons };
}

export function advanceDay(session) {
  if (session.finished) throw new Error('advanceDay: session already finished');
  const row = session.rows[session.cursor];
  const date = row.date;

  let events = [];

  // Step 0: margin call enforcement from yesterday, priced at yesterday's
  // settle (before today's own intraday path exists).
  const enforcement = enforceMarginCall(session, session.lastSettlePrice, date);
  let account = enforcement.account;
  events.push(...enforcement.events);
  let pendingMarginCall = enforcement.events.length ? null : session.pendingMarginCall;

  // Step 1: generate today's intraday knots (M2), deterministic per SPEC
  // seed convention.
  const seed = buildSeed(session.levelId, session.attempt, date);
  const { knots } = generateIntraday({ open: row.open, high: row.high, low: row.low, close: row.close }, seed);
  events.push({ type: 'intraday', date, knots });
  events.push({ type: 'day_close', date, close: row.close });

  // Step 2+3 combined: single knot-by-knot walk interleaving player order
  // fills with margin-engine forced-liquidation checks in true time order
  // (see runIntradaySession header comment above).
  const orderResult = runIntradaySession(account, session.orderQueue, knots, date);
  account = orderResult.account;
  events.push(...orderResult.events);

  // Step 4: daily settle (real daily K, per SPEC §9-1 the *only* settle
  // price source — settle field is expected but may be absent in the M1
  // skeleton pending the settle-column confirmation; fall back to close and
  // warn exactly once per session).
  let settleFallbackWarned = session.settleFallbackWarned;
  let settle = row.settle;
  if (typeof settle !== 'number') {
    settle = row.close;
    if (!settleFallbackWarned) {
      events.push({ type: 'warning', date, code: 'settle_fallback_to_close', detail: 'row.settle missing, using row.close (settle 套用待確認)' });
      settleFallbackWarned = true;
    }
  }
  const mtm = markToMarket(account, { date, settle });
  account = mtm.account;
  events.push(...mtm.events);
  if (mtm.events.some((e) => e.type === 'margin_call')) {
    pendingMarginCall = mtm.events.find((e) => e.type === 'margin_call');
  }

  // Step 5: settlement day -> automatic rollover (SPEC §4, 必然執行不做資金
  // 檢查). Continuous spliced series -> oldPrice = newPrice = settle.
  if (isSettlementDay(date) && account.positions.length > 0) {
    const roll = rollover(account, { date, oldPrice: settle, newPrice: settle });
    account = roll.account;
    events.push(...roll.events);
    const rollMarginCall = roll.events.find((e) => e.type === 'margin_call');
    if (rollMarginCall) pendingMarginCall = rollMarginCall;
  }

  // Step 6: monthly income on the first trading day of a new month.
  let lastIncomeMonth = session.lastIncomeMonth;
  const month = monthOf(date);
  if (session.monthlyIncome > 0 && month !== lastIncomeMonth) {
    const dep = deposit(account, { date, amount: session.monthlyIncome });
    account = dep.account;
    events.push(...dep.events);
    lastIncomeMonth = month;
  }

  // Step 7: risk snapshot (drawdown / margin usage), post everything above.
  const equity = equityOf(account, settle);
  const peakEquity = Math.max(session.peakEquity, equity);
  const drawdownPct = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;
  const initialReq = positionsInitialReq(account.positions, settle);
  const marginUsageRatio = equity > 0 ? initialReq / equity : account.positions.length > 0 ? Infinity : 0;
  events.push({ type: 'risk_snapshot', date, equity, peakEquity, drawdownPct, marginUsageRatio });

  // Step 8: overnight-hold bookkeeping for whatever's still open at day end.
  for (const p of account.positions) {
    events.push({
      type: 'overnight_hold',
      date,
      product: p.product,
      side: p.side,
      lots: p.lots,
      reason: orderResult.overnightReasons[p.product] ?? null,
    });
  }

  const allEvents = [...session.events, ...events];
  // dailyCloses 直接從 session.rows（level 的完整日線骨架）供給，不靠事件
  // 流的 'day_close' 事件累積 —— 解耦 MA 停損計算與事件流完整性（GLM 終審
  // fix 2）：即使某天的 'day_close' 事件因故沒進 allEvents，其餘日子的 MA
  // 值仍然正確。
  const dailyCloses = session.rows.map((r) => ({ date: r.date, close: r.close }));
  const violations = detectViolations(session.plan, allEvents, { dailyCloses });
  const { score, counts } = computeScore(violations, session.plan);

  const cursor = session.cursor + 1;
  const finished = cursor >= session.rows.length;

  return {
    ...session,
    account,
    cursor,
    events: allEvents,
    orderQueue: orderResult.orderQueue,
    pendingMarginCall,
    lastSettlePrice: settle,
    lastIncomeMonth,
    peakEquity,
    settleFallbackWarned,
    violations,
    score,
    scoreCounts: counts,
    finished,
  };
}

// SPEC §4「現金流 = C」的衝擊事件介面：M4 只提供機制與「哪天適合觸發」的
// 判斷（session.shockDayIndex，開局時已用種子 RNG 算好），實際何時呼叫由
// 呼叫端（M5 UI）決定；每局最多套用一次。
export function applyShock(session, { date, amount }) {
  if (session.shockUsed) return session;
  // deposit()/withdraw() (src/margin/core.js) only accept positive amounts
  // and withdraw() rejects if cash is insufficient — a cash shock must be
  // able to push cash negative (that's the point: it forces a margin call
  // on the next advanceDay if positions can't absorb it), so this pulls
  // straight from cash directly rather than routing through withdraw().
  const newCash = session.account.cash - amount;
  const ev = { type: 'shock', date, amount, cashAfter: newCash };
  // Fix 4 (GLM 終審): explicitly copy `positions` into a fresh array instead
  // of relying on the spread's shared reference to session.account.positions.
  // applyShock doesn't itself mutate positions, but every other update path
  // in this module treats every field of a "new" account/session as safe to
  // mutate independently of the old one — sharing the positions array here
  // would be the one silent exception, and a future caller that pushes onto
  // the new session's positions array (instead of going through open/close)
  // would corrupt the old session too. Explicit copy keeps the invariant
  // "new session and old session never share a mutable array" true
  // everywhere, not just almost everywhere.
  const account = {
    ...session.account,
    cash: newCash,
    positions: [...session.account.positions],
    ledger: [...session.account.ledger, ev],
  };
  return { ...session, account, shockUsed: true, events: [...session.events, ev] };
}

export function isShockDay(session) {
  return session.cursor === session.shockDayIndex;
}

export { unrealizedPL };
