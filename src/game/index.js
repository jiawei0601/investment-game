// index.js — public API barrel for the M4 game session layer.
// See session.js for implementation and contract notes.

export { createSession, queueOrder, cancelOrder, advanceDay, applyShock, isShockDay } from './session.js';
