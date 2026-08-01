// index.js — public API barrel for the M7 battle report + profile layer.
// See report.js (buildReport, markdown schema documented at top of file)
// and profile.js (updateProfile) for implementation and contract notes.

export { buildReport } from './report.js';
export { updateProfile, createProfile } from './profile.js';
