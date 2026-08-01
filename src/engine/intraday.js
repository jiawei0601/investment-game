// intraday.js — brownian-bridge intraday 5-minute bar generator (M2).
//
// Given a real daily OHLC bar (the "skeleton", M1 data) and a seed string,
// deterministically generates 60 five-minute bars covering the TX day
// session (08:45-13:45), plus the 301-point fine knot path they were
// aggregated from, such that:
//   - bars[0].o        === open
//   - bars[59].c        === close
//   - max(bars[*].h)    === high   (exact)
//   - min(bars[*].l)    === low    (exact)
//   - bars[i].c         === bars[i+1].o  for all i (no gaps)
//   - knots[0] === open, knots[300] === close, max(knots) === high,
//     min(knots) === low, knots[i*5..i*5+5] is bar i's source span.
//   - same seed -> byte-identical output; different seed -> different path.
//
// Touch-price judgment (stop-loss, liquidation, margin) must walk `knots`,
// not just bar h/l: a bar's h/l already reflects its own 5-knot span, but
// only `knots` gives per-5-minute-tick granularity across the whole day
// (SPEC.md §1/§4: 所有觸價判定以生成日內層為準).
//
// Algorithm (SPEC.md §1, ADR 0008 — supersedes the ADR-0008-flagged parts of
// the original M2 backlog spec):
//   1. Work in log-price space; anchor both ends to log(open) -> log(close).
//   2. Decide where (which bar boundary, 0..60) the day's H and L are
//      attained, and their relative order — unless O or C already equals H
//      or L, in which case that anchor is pinned to t=0 / t=60 (handles
//      gap/edge days without forcing spurious randomness). When free, the
//      (idxH, idxL) pair is drawn from a weight table proportional to the
//      Brownian-bridge conditional density of the path passing through
//      (logH, logL) at those two bar-boundary times — NOT uniformly random
//      (ADR 0008 decision 1: uniform 50/50 placement produces H/L orderings
//      with real-world probability <5% on ~30% of days).
//   3. Stitch 2-3 Brownian bridge segments between the resulting ordered
//      anchor points (open, [H|L in resolved order], close). Each segment's
//      per-step variance is recalibrated from the day's Parkinson estimate,
//      accounting for the extra "forced swing" variance that a segment
//      spanning open->extreme or extreme->extreme carries relative to a
//      plain 2-point day bridge (ADR 0008 decision 3: naively reusing the
//      whole-day per-step sigma on every segment inflates realized
//      volatility ~19%).
//   4. Each segment is generated at 5x sub-bar resolution (SUBSTEPS_PER_BAR)
//      so bars carry natural wicks instead of pure-body candles (ADR 0008
//      decision 4). Each segment is sampled via rejection sampling: build a
//      free Gaussian random walk, bridge-correct it to hit the segment's
//      end anchor exactly, and reject (retry) if any interior point
//      breaches the day's [low, high] bounds. If the retry budget is
//      exhausted, shrink that segment's sigma (not: clip to a flat line —
//      ADR 0008 decision 2, clipping produced multi-hour flatlines pinned
//      to the boundary on ~1% of days) and retry with a fresh budget,
//      repeating until accepted. Because [low, high] is a convex interval
//      containing both segment endpoints, shrinking sigma toward 0
//      guarantees eventual acceptance (the sigma=0 straight line trivially
//      satisfies the bound).
//   5. Round the continuous knot path to the 1-point tick size, forcing the
//      anchor knots (open/close/high/low, at their bar-boundary x5 fine
//      index) back to their exact integer values so rounding noise can
//      never violate the hard OHLC-reconstruction constraints.
//   6. Aggregate every 5 consecutive fine knots into one 5-minute bar
//      (o/c = first/last knot, h/l = max/min across the 5-knot span).

import { createRng, gaussian } from './rng.js';

export const BARS_PER_DAY = 60;
const SUBSTEPS_PER_BAR = 5;
const FINE_STEPS = BARS_PER_DAY * SUBSTEPS_PER_BAR;
const MAX_REJECTION_ATTEMPTS = 50;
const SIGMA_SHRINK_FACTOR = 0.7;
const MAX_SHRINK_LEVELS = 40; // 0.7^40 ~ 8e-7 of the original sigma: for a
// convex bound and endpoints already inside it, acceptance is guaranteed
// well before this many levels; it exists only as a hard ceiling.
const MIN_SEGMENT_VARIANCE_FRACTION = 0.05; // floor so a heavily-recalibrated
// segment still gets a visible wick instead of collapsing to a dead line.

function parkinsonSigma(high, low) {
  if (high <= low) return 0;
  return Math.log(high / low) / (2 * Math.sqrt(Math.log(2)));
}

// ---------------------------------------------------------------------------
// Brownian bridge marginal statistics, in bar-index time units (0..N).
// varRate is the per-bar-step variance rate (sigmaStep^2 in the pre-ADR0008
// vocabulary): Var(bridge(t)) = varRate * t * (N-t) / N.
// ---------------------------------------------------------------------------

function bridgeMean(t, N, logO, logC) {
  return logO + (t / N) * (logC - logO);
}

function bridgeVar(t, N, varRate) {
  return (varRate * t * (N - t)) / N;
}

function bridgeCov(t1, t2, N, varRate) {
  // requires t1 <= t2
  return (varRate * t1 * (N - t2)) / N;
}

function logNormalDensity1D(x, mean, variance) {
  if (variance <= 0) return x === mean ? Infinity : -Infinity;
  const d = x - mean;
  return -0.5 * ((d * d) / variance) - 0.5 * Math.log(2 * Math.PI * variance);
}

function logBivariateNormalDensity(x, y, muX, muY, varX, varY, cov) {
  const det = varX * varY - cov * cov;
  // Near-singular covariance (det too small or non-positive): treat as a
  // very-unlikely-but-not-impossible candidate rather than -Infinity, so it
  // doesn't get silently dropped if every other candidate is equally
  // degenerate (GLM review 2026-08-02, finding 3).
  if (!(det > 1e-300)) return -1e300;
  const dx = x - muX;
  const dy = y - muY;
  const invDet = 1 / det;
  const quad = invDet * (varY * dx * dx - 2 * cov * dx * dy + varX * dy * dy);
  if (!Number.isFinite(quad)) return -1e300;
  const logDensity = -0.5 * quad - Math.log(2 * Math.PI) - 0.5 * Math.log(det);
  return Number.isFinite(logDensity) ? logDensity : -1e300;
}

/**
 * Weighted draw over items = [{key, logWeight}], numerically stable via a
 * max-subtraction before exponentiating. Consumes exactly one rng() draw
 * (two draws only in the zero-probability all-degenerate fallback path).
 *
 * Two degenerate cases handled explicitly (GLM review 2026-08-02, finding 1):
 *   - logWeight === Infinity (variance<=0 and the target exactly equals the
 *     mean, e.g. a near-zero-amplitude day): that candidate is the only
 *     mathematically valid one — pick it directly instead of letting
 *     Number.isFinite() zero it out.
 *   - total === 0 (every candidate numerically underflowed to zero weight):
 *     fall back to a uniform draw over all candidates instead of silently
 *     always returning the last item in the list.
 */
function weightedChoiceFromLogWeights(items, rng) {
  const infinite = items.filter((it) => it.logWeight === Infinity);
  if (infinite.length > 0) {
    const idx = infinite.length === 1 ? 0 : Math.min(infinite.length - 1, Math.floor(rng() * infinite.length));
    return infinite[idx].key;
  }

  let maxLog = -Infinity;
  for (const it of items) if (it.logWeight > maxLog) maxLog = it.logWeight;
  const weights = new Array(items.length);
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    const lw = items[i].logWeight;
    const w = Number.isFinite(lw) ? Math.exp(lw - maxLog) : 0;
    weights[i] = w;
    total += w;
  }
  if (!(total > 0) || !Number.isFinite(total)) {
    const idx = Math.min(items.length - 1, Math.floor(rng() * items.length));
    return items[idx].key;
  }
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i].key;
  }
  return items[items.length - 1].key;
}

/**
 * Resolve the bar-boundary indices (0..N) where the day's H and L are
 * attained (ADR 0008 decision 1). When both are free, draws jointly from a
 * weight table over ordered pairs (k != m) proportional to the bivariate
 * Brownian-bridge density of hitting (logH, logL) at (min,max) of (k,m) in
 * the correct time order — covering both k<m (H first) and m<k (L first).
 * When only one is free (the other pinned to the open/close anchor), draws
 * from the corresponding 1D bridge marginal instead.
 */
function sampleHLAnchors({ rng, N, logO, logC, logH, logL, forcedH, forcedL, varRate }) {
  if (forcedH !== null && forcedL !== null) {
    return { idxH: forcedH, idxL: forcedL };
  }

  if (forcedH !== null) {
    const items = [];
    for (let m = 1; m < N; m++) {
      const mean = bridgeMean(m, N, logO, logC);
      const variance = bridgeVar(m, N, varRate);
      items.push({ key: m, logWeight: logNormalDensity1D(logL, mean, variance) });
    }
    return { idxH: forcedH, idxL: weightedChoiceFromLogWeights(items, rng) };
  }

  if (forcedL !== null) {
    const items = [];
    for (let k = 1; k < N; k++) {
      const mean = bridgeMean(k, N, logO, logC);
      const variance = bridgeVar(k, N, varRate);
      items.push({ key: k, logWeight: logNormalDensity1D(logH, mean, variance) });
    }
    return { idxH: weightedChoiceFromLogWeights(items, rng), idxL: forcedL };
  }

  const items = [];
  for (let k = 1; k < N; k++) {
    for (let m = 1; m < N; m++) {
      if (k === m) continue;
      const t1 = Math.min(k, m);
      const t2 = Math.max(k, m);
      const target1 = k < m ? logH : logL; // value the bridge must hit at the earlier time
      const target2 = k < m ? logL : logH; // value the bridge must hit at the later time
      const mu1 = bridgeMean(t1, N, logO, logC);
      const mu2 = bridgeMean(t2, N, logO, logC);
      const var1 = bridgeVar(t1, N, varRate);
      const var2 = bridgeVar(t2, N, varRate);
      const cov = bridgeCov(t1, t2, N, varRate);
      const logWeight = logBivariateNormalDensity(target1, target2, mu1, mu2, var1, var2, cov);
      items.push({ key: [k, m], logWeight });
    }
  }
  const [idxH, idxL] = weightedChoiceFromLogWeights(items, rng);
  return { idxH, idxL };
}

/**
 * Sample one free Gaussian random walk from logStart and bridge-correct it
 * (standard construction: bridge(t) = W(t) - (t/T)*(W(T) - logEnd)) so the
 * final point lands exactly on logEnd.
 */
function buildBridgeSegment(rng, logStart, logEnd, steps, sigmaStep) {
  const bridged = new Array(steps + 1);
  if (!(sigmaStep > 0) || !Number.isFinite(sigmaStep)) {
    // Degenerate sigma (zero, negative, NaN, or Infinity — e.g. the
    // MAX_SHRINK_LEVELS ceiling fallback explicitly passes 0): there is no
    // randomness to draw, so return the deterministic straight line
    // directly. This also forecloses gaussian(rng) * sigmaStep ever
    // producing NaN (0 * Infinity) if sigmaStep were ever non-finite
    // upstream (GLM review 2026-08-02, finding 2).
    for (let i = 0; i <= steps; i++) {
      bridged[i] = logStart + (i / steps) * (logEnd - logStart);
    }
    return bridged;
  }
  const walk = new Array(steps + 1);
  walk[0] = logStart;
  for (let i = 1; i <= steps; i++) {
    walk[i] = walk[i - 1] + gaussian(rng) * sigmaStep;
  }
  const drift = walk[steps] - logEnd;
  for (let i = 0; i <= steps; i++) {
    bridged[i] = walk[i] - (i / steps) * drift;
  }
  return bridged;
}

/**
 * Rejection-sample a bridge segment inside [logL, logH]. On retry-budget
 * exhaustion, shrink sigma and retry with a fresh budget instead of
 * clipping (ADR 0008 decision 2). [logL, logH] is convex and both endpoints
 * already lie inside it, so shrinking sigma toward 0 guarantees eventual
 * acceptance.
 */
function sampleBridgeSegmentWithinBounds(rng, logStart, logEnd, steps, sigmaStep, logL, logH) {
  let sigma = sigmaStep;
  for (let level = 0; level < MAX_SHRINK_LEVELS; level++) {
    for (let attempt = 0; attempt < MAX_REJECTION_ATTEMPTS; attempt++) {
      const candidate = buildBridgeSegment(rng, logStart, logEnd, steps, sigma);
      let inBounds = true;
      for (let i = 0; i <= steps; i++) {
        if (candidate[i] < logL - 1e-12 || candidate[i] > logH + 1e-12) {
          inBounds = false;
          break;
        }
      }
      if (inBounds) return candidate;
    }
    sigma *= SIGMA_SHRINK_FACTOR;
  }
  // Ceiling reached (should not happen given the convexity guarantee above):
  // fall back to sigma=0, i.e. buildBridgeSegment's explicit degenerate
  // branch (straight line, no rng draws), which trivially satisfies the
  // bound. This is the one well-defined terminal outcome of the shrink
  // ladder — it never clips and never loops unboundedly.
  return buildBridgeSegment(rng, logStart, logEnd, steps, 0);
}

/**
 * Recalibrate a segment's per-bar-step variance rate so that its expected
 * contribution to the day's realized (bar-close) volatility matches its
 * proportional share of the whole-day Parkinson estimate, instead of
 * reusing the naive whole-day per-step rate on every segment (ADR 0008
 * decision 3). Derivation: for a bar-granularity bridge segment of length
 * tSeg with per-step variance rate v, E[sum of squared bar-close
 * increments] = v*(tSeg-1) + (deltaLog^2)/tSeg. Solving for v so that this
 * equals the proportional target vBar*tSeg gives the formula below.
 */
function recalibratedSegmentVarRate(vBar, tSeg, deltaLog) {
  if (tSeg <= 1) return vBar; // single-bar segment: bar close is the anchor
  // jump itself, fixed regardless of sub-bar path — no recalibration needed
  // or possible at the bar-close level.
  const naiveTotal = vBar * tSeg;
  const driftShare = (deltaLog * deltaLog) / tSeg;
  const vSeg = (naiveTotal - driftShare) / (tSeg - 1);
  return Math.max(vSeg, vBar * MIN_SEGMENT_VARIANCE_FRACTION);
}

/**
 * Generate the 60 intraday 5-minute bars for one trading day, plus the
 * underlying 301-point fine knot path they were aggregated from.
 *
 * The fine knot path is the touch-price ground truth: margin/liquidation
 * logic must walk `knots` (not just bar h/l) so that a wick that pierces the
 * maintenance line intraday and recovers by the bar's close still triggers
 * (SPEC.md §1/§4: "所有觸價判定...以生成日內層為準"). `bars` is a display
 * aggregation of the same path — the two are never independently generated.
 *
 * @param {{open:number, high:number, low:number, close:number}} dayOHLC
 * @param {string} seedString - canonical seed, e.g. buildSeed(levelId, attempt, date)
 * @param {{sigmaMultiplier?: number}} [options] - test-only hook: scale the
 *        per-step volatility to force the rejection-sampling shrink fallback
 *        (SPEC/backlog requirement: "可用極端波動率參數強制觸發 shrink 分支").
 *        Never used by production game code (defaults to 1).
 * @returns {{
 *   bars: {t:number,o:number,h:number,l:number,c:number}[],
 *   knots: number[]
 * }} bars = 60 five-minute bars; knots = the 301 fine-resolution prices
 *   (index 0 = open, index 300 = close, index i*5 = bar i's open / bar
 *   (i-1)'s close) that bars was aggregated from — same seed, same call,
 *   byte-identical on repeat.
 */
export function generateIntraday(dayOHLC, seedString, options = {}) {
  const { open, high, low, close } = dayOHLC;
  const sigmaMultiplier = options.sigmaMultiplier ?? 1;

  if (!(low <= open && open <= high && low <= close && close <= high && low <= high)) {
    throw new Error(
      `generateIntraday: OHLC invariant violated O=${open} H=${high} L=${low} C=${close}`
    );
  }

  const N = BARS_PER_DAY;
  const rng = createRng(seedString);

  // Flat day (一字線): nothing to generate, every bar and every fine knot
  // sits at the same price.
  if (open === high && high === low && low === close) {
    const bars = [];
    for (let i = 0; i < N; i++) {
      bars.push({ t: i, o: open, h: open, l: open, c: open });
    }
    const knots = new Array(FINE_STEPS + 1).fill(open);
    return { bars, knots };
  }

  const logO = Math.log(open);
  const logC = Math.log(close);
  const logH = Math.log(high);
  const logL = Math.log(low);

  // Resolve anchor bar-boundary positions (0..N) for the day's H and L.
  const forcedH = open === high ? 0 : close === high ? N : null;
  const forcedL = open === low ? 0 : close === low ? N : null;

  const sigmaDay = parkinsonSigma(high, low) * sigmaMultiplier;
  const vBar = (sigmaDay * sigmaDay) / N; // naive per-bar-step variance rate

  let idxH = forcedH;
  let idxL = forcedL;
  if (idxH === null || idxL === null) {
    const sampled = sampleHLAnchors({
      rng,
      N,
      logO,
      logC,
      logH,
      logL,
      forcedH,
      forcedL,
      varRate: vBar,
    });
    idxH = sampled.idxH;
    idxL = sampled.idxL;
  }

  // Ordered, de-duplicated anchor list (open, H, L, close by time).
  const anchorMap = new Map();
  anchorMap.set(0, logO);
  anchorMap.set(N, logC);
  anchorMap.set(idxH, logH);
  anchorMap.set(idxL, logL);
  const anchors = [...anchorMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, logp]) => ({ t, logp }));

  // Fine-resolution knot path (5 sub-steps per bar) so bars carry natural
  // wicks; anchors still land exactly on bar boundaries (t * SUBSTEPS_PER_BAR).
  const knots = new Array(FINE_STEPS + 1);
  for (const { t, logp } of anchors) knots[t * SUBSTEPS_PER_BAR] = logp;

  for (let seg = 0; seg < anchors.length - 1; seg++) {
    const start = anchors[seg];
    const end = anchors[seg + 1];
    const tSeg = end.t - start.t;
    const fineStart = start.t * SUBSTEPS_PER_BAR;
    const fineEnd = end.t * SUBSTEPS_PER_BAR;
    const fineSteps = fineEnd - fineStart;
    if (fineSteps <= 1) continue; // adjacent fine knots, nothing interior to fill

    const vSeg = recalibratedSegmentVarRate(vBar, tSeg, end.logp - start.logp);
    const sigmaFineStep = Math.sqrt(vSeg / SUBSTEPS_PER_BAR);

    const candidate = sampleBridgeSegmentWithinBounds(
      rng,
      start.logp,
      end.logp,
      fineSteps,
      sigmaFineStep,
      logL,
      logH
    );
    for (let i = 1; i < fineSteps; i++) {
      knots[fineStart + i] = candidate[i];
    }
  }

  // Discretize to the 1-point tick size, then force exact anchor values so
  // floating-point/log-exp rounding noise can never violate the hard
  // reconstruction constraints.
  const rounded = knots.map((v) => Math.round(Math.exp(v)));
  rounded[0] = open;
  rounded[FINE_STEPS] = close;
  rounded[idxH * SUBSTEPS_PER_BAR] = high;
  rounded[idxL * SUBSTEPS_PER_BAR] = low;
  for (let i = 0; i <= FINE_STEPS; i++) {
    rounded[i] = Math.min(high, Math.max(low, rounded[i]));
  }

  // Aggregate every 5 consecutive fine knots into one 5-minute bar.
  const bars = [];
  for (let i = 0; i < N; i++) {
    const fStart = i * SUBSTEPS_PER_BAR;
    const fEnd = fStart + SUBSTEPS_PER_BAR;
    const o = rounded[fStart];
    const c = rounded[fEnd];
    let h = -Infinity;
    let l = Infinity;
    for (let j = fStart; j <= fEnd; j++) {
      if (rounded[j] > h) h = rounded[j];
      if (rounded[j] < l) l = rounded[j];
    }
    bars.push({ t: i, o, h, l, c });
  }
  return { bars, knots: rounded };
}
