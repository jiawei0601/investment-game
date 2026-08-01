// autoplay.js — pure decision logic for M5's play/pause auto-advance timer.
// Kept separate from app.js's DOM wiring specifically so it's unit-testable
// with `node --test` (no browser/DOM needed) — app.js is the only consumer:
// it owns the actual setInterval/clearInterval and always routes every tick
// through the existing handleAdvanceDay() function (same code path as the
// manual "下一天" button — this module never re-implements day-advance
// logic, it only decides "should the timer keep going after this tick").

// Event types that must interrupt autoplay so the player can read what just
// happened before more days roll past: forced liquidation, a fresh margin
// call, a margin call getting enforced (auto-liquidated) at open, and
// settlement-day rollover.
const AUTO_PAUSE_EVENT_TYPES = new Set(['force_liquidation', 'margin_call', 'margin_call_enforcement', 'rollover']);

/**
 * Given the slice of session.events a single advanceDay() call just
 * produced, decide whether the autoplay timer should stop itself.
 * Pure function: no DOM, no timers, no session mutation.
 * @param {Array<{type: string}>} newEvents
 * @returns {boolean}
 */
export function shouldAutoPauseForEvents(newEvents) {
  if (!Array.isArray(newEvents)) return false;
  return newEvents.some((e) => AUTO_PAUSE_EVENT_TYPES.has(e?.type));
}

// Selectable playback rates (K 棒／秒). Kept as a named export so app.js's
// <select> options and this module's ms-per-tick math never drift apart.
export const AUTOPLAY_RATES = Object.freeze([0.5, 1, 2, 5, 10]);

export function msPerTick(rate) {
  const r = AUTOPLAY_RATES.includes(rate) ? rate : 1;
  return Math.round(1000 / r);
}
