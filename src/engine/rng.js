// rng.js — deterministic seed hashing + pseudo-random number generator
// for the intraday generation engine (M2).
//
// Rule (AGENTS.md 種子慣例 / SPEC §1): game logic must never call
// Date.now() or Math.random() directly. All randomness must flow through
// a seed string -> hash -> deterministic RNG pipeline defined here.
//
// Algorithms used (cited per M2 backlog requirement):
//   - hash:  cyrb128  (Bryc, public domain) — string -> four 32-bit ints,
//            used to seed the PRNG state.
//   - PRNG:  sfc32    (Small Fast Counter RNG, Chris Doty-Humphrey,
//            public domain) — 128-bit state, period >= 2^127, passes
//            PractRand/BigCrush in practice, fast in JS.
// Both are the standard public-domain algorithms (e.g. as circulated in the
// "bryc/6c95376103719a19ff5cbc17e4c3f66c" gist), not a byte-for-byte port of
// any single reference snippet. Notably, this sfc32 folds the counter word
// `d` into the output `t` *after* incrementing it (`d = d+1` before
// `t = t+d`), whereas the commonly-circulated reference folds in the
// pre-increment `d`. That is a one-step phase shift in the output sequence,
// not a period or quality defect (opus M2 review, 2026-08-02: confirmed by
// independent inspection, still full-period and passes the distribution
// checks in tests/engine.test.js) — verified independently, not assumed
// correct by virtue of resembling the reference implementation.

/**
 * cyrb128: hash an arbitrary string into four 32-bit unsigned integers.
 * @param {string} str
 * @returns {[number, number, number, number]}
 */
export function cyrb128(str) {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

/**
 * sfc32: build a deterministic RNG function from four 32-bit state words.
 * Returns a closure `() => number` producing floats in [0, 1).
 */
export function sfc32(a, b, c, d) {
  let sa = a >>> 0;
  let sb = b >>> 0;
  let sc = c >>> 0;
  let sd = d >>> 0;
  return function next() {
    sa >>>= 0;
    sb >>>= 0;
    sc >>>= 0;
    sd >>>= 0;
    let t = (sa + sb) | 0;
    sa = sb ^ (sb >>> 9);
    sb = (sc + (sc << 3)) | 0;
    sc = (sc << 21) | (sc >>> 11);
    sd = (sd + 1) | 0;
    t = (t + sd) | 0;
    sc = (sc + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/**
 * Build the canonical seed string per AGENTS.md / SPEC §1:
 *   seed = hash(關卡ID, 第幾次玩, 日期)  ->  "{levelId}|{attempt}|{date}"
 *
 * `|` is the field separator, so none of the parts may contain it — a
 * levelId (or attempt/date) with an embedded `|` would silently shift the
 * field boundaries and could collide two logically-different seeds onto the
 * same string.
 */
export function buildSeed(levelId, attempt, date) {
  for (const [name, value] of [
    ['levelId', levelId],
    ['attempt', attempt],
    ['date', date],
  ]) {
    if (String(value).includes('|')) {
      throw new Error(`buildSeed: ${name} must not contain '|' (got ${JSON.stringify(value)})`);
    }
  }
  return `${levelId}|${attempt}|${date}`;
}

/**
 * Create a deterministic RNG from a seed string. Same seed string always
 * produces the same sequence of draws; different seed strings (almost
 * certainly) produce different sequences.
 * @param {string} seed
 * @returns {() => number} function returning floats in [0, 1)
 */
export function createRng(seed) {
  const [a, b, c, d] = cyrb128(String(seed));
  const rand = sfc32(a, b, c, d);
  // Warm up the generator (standard practice for sfc32) to shed any
  // weak correlation in the first few outputs from the hash seeding.
  for (let i = 0; i < 15; i++) rand();
  return rand;
}

/**
 * Standard normal sample via Box-Muller transform, drawn from a
 * deterministic rng() function (see createRng).
 */
export function gaussian(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
