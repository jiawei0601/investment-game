// index.js — public API barrel for the M4 behavior system.
// See plan.js / contradictions.js / templates.js / violations.js / score.js /
// profile.js for implementation and per-function contract notes.

export { PLAN_FIELDS, validatePlan, createPlan } from './plan.js';
export { CONTRADICTION_RULES, detectContradictions } from './contradictions.js';
export { TEMPLATES, getTemplate } from './templates.js';
export { detectViolations } from './violations.js';
export { VIOLATION_WEIGHTS, computeScore } from './score.js';
export { createProfile, recordSession } from './profile.js';
