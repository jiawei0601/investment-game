// tests/report.test.js — M7 battle report + profile test suite (AGENTS.md 測試慣例).
// Run with: node --test tests/report.test.js
//
// Uses the real data/daily/TX.json skeleton, 2020-03 window (same convention
// as tests/game.test.js), sized so the violations produced are deterministic
// from the real price series rather than relying on random-path luck:
//   - 2020-03-02 open TX SHORT 1 lot @ 11011 (thesis required, fresh open).
//   - 2020-03-03 add TX SHORT 1 lot @ 11313 — price rose, which is adverse
//     for a short, and plan.addRule='no_add' -> deterministically produces
//     one martingale_add violation.
//   - The same day's intraday path also touches the fixed_points stop
//     (entry 11011, 300pt -> trigger 11311) without the position being
//     closed -> deterministically produces one bag_holding violation too.
//   - 2020-03-04 just advances the session to completion (finished=true).
// Verified once against real data before writing these assertions (see
// HANDOFF/PR notes) — not a guess.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createSession, queueOrder, advanceDay } from '../src/game/index.js';
import { buildReport, updateProfile, createProfile } from '../src/report/index.js';

const TX_PATH = fileURLToPath(new URL('../data/daily/TX.json', import.meta.url));
const TX = JSON.parse(readFileSync(TX_PATH, 'utf8'));
const ROWS = TX.rows;

const PLAN = Object.freeze({
  goal: 'stable_return',
  maxDrawdown: 20,
  stopLossRule: 'fixed_points',
  stopLossParams: { points: 300 },
  addRule: 'no_add',
  marginUsageCap: 50,
  overnight: 'allowed',
});

const CONTRADICTORY_PLAN = Object.freeze({
  goal: 'stable_return',
  maxDrawdown: 10,
  stopLossRule: 'fixed_points',
  stopLossParams: { points: 300 },
  addRule: 'martingale_add',
  marginUsageCap: 30,
  overnight: 'allowed',
});

function runMartingaleScenario(attempt = 4) {
  let session = createSession({
    levelId: 'pandemic',
    attempt,
    startDate: '2020-03-02',
    endDate: '2020-03-04',
    initialCash: 1500000,
    plan: PLAN,
    monthlyIncome: 0,
    dailyRows: ROWS,
  });
  session = queueOrder(session, { kind: 'market', product: 'TX', side: -1, lots: 1, thesis: '測試：放空避險' });
  session = advanceDay(session); // 2020-03-02: fresh open

  session = queueOrder(session, { kind: 'market', product: 'TX', side: -1, lots: 1, thesis: '加碼（不應該，addRule=no_add）' });
  session = advanceDay(session); // 2020-03-03: adverse add -> martingale_add; stop touched -> bag_holding

  session = advanceDay(session); // 2020-03-04: finish
  return session;
}

function priorProfileEntry(attempt, martingaleCount) {
  return {
    levelId: 'pandemic',
    attempt,
    startDate: '2020-01-01',
    endDate: '2020-01-05',
    score: 80,
    counts: {
      bag_holding: 0,
      bag_holding_continued: 0,
      unplanned_trade: 0,
      risk_out_of_control: 0,
      thesis_drift: 0,
      martingale_add: martingaleCount,
    },
  };
}

// ---------------------------------------------------------------------
// Skeleton: all 8 required headings present.
// ---------------------------------------------------------------------
test('buildReport: contains all 8 required section headings', () => {
  const session = runMartingaleScenario();
  const report = buildReport(session, { profileHistory: [] });
  assert.match(report, /## 1\. 標頭/);
  assert.match(report, /## 2\. 開局作戰計畫/);
  assert.match(report, /## 3\. 逐筆交易時間軸/);
  assert.match(report, /## 4\. 保證金壓力軌跡/);
  assert.match(report, /## 5\. 違背統計/);
  assert.match(report, /## 6\. 行為分/);
  assert.match(report, /## 7\. 歷次對照/);
  assert.match(report, /## 8\. 複盤指引/);
});

// ---------------------------------------------------------------------
// Header section: level/attempt/date range/cash facts, sourced correctly.
// ---------------------------------------------------------------------
test('buildReport: header reports level, attempt, date range, and cash facts', () => {
  const session = runMartingaleScenario(4);
  const report = buildReport(session, { profileHistory: [] });
  assert.match(report, /關卡：pandemic/);
  assert.match(report, /第幾次玩：第 4 次/);
  assert.match(report, /區間：2020-03-02 ~ 2020-03-04/);
  assert.match(report, /起始資金：NT\$ 1,500,000/);
  // 報酬只是事實陳述，不應出現任何評分字眼（分數/評分）在該行
  const returnLine = report.split('\n').find((l) => l.includes('報酬'));
  assert.ok(returnLine);
  assert.doesNotMatch(returnLine, /行為分\s*[:：]\s*\d/);
});

// ---------------------------------------------------------------------
// Plan section: six fields rendered + contradiction detection.
// ---------------------------------------------------------------------
test('buildReport: plan section renders all six PLAN_FIELDS with Chinese labels, no contradiction', () => {
  const session = runMartingaleScenario();
  const report = buildReport(session, { profileHistory: [] });
  assert.match(report, /目標：穩定正報酬/);
  assert.match(report, /最大回撤（權益數）：20%/);
  assert.match(report, /停損規則：固定點數 -X 點/);
  assert.match(report, /加碼規則：不加碼/);
  assert.match(report, /保證金使用率上限：50%/);
  assert.match(report, /持倉過夜：可過夜/);
  assert.match(report, /無（零摩擦直接開局，或已修正至無矛盾）/);
});

test('buildReport: plan section flags a contradictory plan with the template quote', () => {
  let session = createSession({
    levelId: 'pandemic',
    attempt: 1,
    startDate: '2020-03-02',
    endDate: '2020-03-02',
    initialCash: 1500000,
    plan: CONTRADICTORY_PLAN,
    monthlyIncome: 0,
    dailyRows: ROWS,
  });
  const report = buildReport(session, { profileHistory: [] });
  assert.match(report, /⚠ 逆勢攤平會持續放大虧損部位的曝險/);
  assert.match(report, /未知（session 未提供此欄位/); // planModified fallback, honestly documented
});

test('buildReport: options.planModified / options.contradictionsAtStart override the fallback wording', () => {
  let session = createSession({
    levelId: 'pandemic',
    attempt: 1,
    startDate: '2020-03-02',
    endDate: '2020-03-02',
    initialCash: 1500000,
    plan: PLAN,
    monthlyIncome: 0,
    dailyRows: ROWS,
  });
  const report = buildReport(session, { profileHistory: [], planModified: true, contradictionsAtStart: [] });
  assert.match(report, /玩家是否修改計畫\*\*：是/);
  assert.match(report, /開局當時偵測到的版本/);
});

// ---------------------------------------------------------------------
// Trade timeline: violation markers land on the correct row, not others.
// ---------------------------------------------------------------------
test('buildReport: trade timeline marks the adverse-add row with both violation types, not the fresh-open row', () => {
  const session = runMartingaleScenario();
  const report = buildReport(session, { profileHistory: [] });
  const lines = report.split('\n');
  const freshOpenRow = lines.find((l) => l.includes('2020-03-02') && l.includes('開倉 空'));
  const addRow = lines.find((l) => l.includes('2020-03-03') && l.includes('開倉 空'));
  assert.ok(freshOpenRow);
  assert.ok(addRow);
  assert.doesNotMatch(freshOpenRow, /⚠/);
  assert.match(addRow, /⚠/);
  assert.match(addRow, /凹單/);
  assert.match(addRow, /攤平加碼/);
  assert.match(freshOpenRow, /測試：放空避險/); // thesis attached to the correct open row
  assert.match(addRow, /加碼（不應該，addRule=no_add）/);
});

// ---------------------------------------------------------------------
// Violation stats + score section consistency.
// ---------------------------------------------------------------------
test('buildReport: violation stats table and score section match session.scoreCounts/session.score', () => {
  const session = runMartingaleScenario();
  const report = buildReport(session, { profileHistory: [] });
  assert.match(report, /\| 凹單 \| 1 \| -15 \| -15 \|/);
  assert.match(report, /\| 攤平加碼 \| 1 \| -20 \| -20 \|/);
  assert.match(report, /本局行為分：\*\*65 \/ 100\*\*/);
  assert.equal(session.score, 65);
});

// ---------------------------------------------------------------------
// History section (§7): trend curve + "N 局未改善" flag, selective per type.
// ---------------------------------------------------------------------
test('buildReport: history section flags martingale_add as unimproved across 3 prior + current, but not bag_holding', () => {
  const session = runMartingaleScenario(4);
  const profileHistory = [priorProfileEntry(1, 1), priorProfileEntry(2, 1), priorProfileEntry(3, 1)];
  const report = buildReport(session, { profileHistory });
  assert.match(report, /連續 3 局未改善/);
  assert.match(report, /⚠ \*\*攤平加碼\*\*：最近 3 局每一局都出現，尚未改掉/);
  // bag_holding only appears in the current session (prior entries are all 0) -> must NOT be flagged
  assert.doesNotMatch(report, /⚠ \*\*凹單\*\*：最近 3 局每一局都出現/);
});

test('buildReport: history section reports insufficient data when profileHistory is short', () => {
  const session = runMartingaleScenario();
  const report = buildReport(session, { profileHistory: [priorProfileEntry(1, 1)] });
  assert.match(report, /資料不足 3 局，尚無法判斷/);
});

// ---------------------------------------------------------------------
// GLM 終審：## 7 歷次對照去重 — profileHistory 可能已經被呼叫端用
// updateProfile() 寫入本局（先存檔、再出報告的典型順序），此時 profileHistory
// 裡會已經有一筆 (levelId, attempt) 與本局相同的紀錄；buildReport 一律用自己
// 算的 currentHistoryEntry(session) 代表本局那一筆，profileHistory 裡同
// (levelId, attempt) 的紀錄要被濾掉，不能讓本局出現兩次。
// ---------------------------------------------------------------------
function countOccurrences(text, needle) {
  return (text.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
}

test('buildReport: history section — profileHistory NOT containing the current session shows it exactly once', () => {
  const session = runMartingaleScenario(4);
  const profileHistory = [priorProfileEntry(1, 1), priorProfileEntry(2, 1), priorProfileEntry(3, 1)];
  const report = buildReport(session, { profileHistory });
  assert.equal(countOccurrences(report, '| pandemic | 4 |'), 1);
  assert.equal(countOccurrences(report, '（本局）'), 1);
});

test('buildReport: history section — profileHistory ALREADY containing the current session (levelId+attempt) still shows it exactly once', () => {
  const session = runMartingaleScenario(4);
  const alreadySavedCurrent = {
    levelId: session.levelId,
    attempt: session.attempt,
    startDate: session.rows[0].date,
    endDate: session.rows[Math.max(0, session.cursor - 1)].date,
    score: session.score,
    counts: session.scoreCounts,
  };
  const profileHistory = [priorProfileEntry(1, 1), priorProfileEntry(2, 1), priorProfileEntry(3, 1), alreadySavedCurrent];
  const report = buildReport(session, { profileHistory });
  assert.equal(countOccurrences(report, '| pandemic | 4 |'), 1);
  assert.equal(countOccurrences(report, '（本局）'), 1);
  // Row count check: the curve table body must have exactly 4 data rows
  // (3 distinct prior attempts + 1 current), not 5 — the duplicate must be
  // dropped, not merely hidden.
  const curveTableRows = report
    .split('\n')
    .filter((l) => /^\| \d+ \| pandemic \|/.test(l));
  assert.equal(curveTableRows.length, 4);
});

// ---------------------------------------------------------------------
// Purity: same input -> same output, and session is never mutated.
// ---------------------------------------------------------------------
test('buildReport: pure function — identical input produces byte-identical output', () => {
  const session = runMartingaleScenario();
  const a = buildReport(session, { profileHistory: [priorProfileEntry(1, 1)] });
  const b = buildReport(session, { profileHistory: [priorProfileEntry(1, 1)] });
  assert.equal(a, b);
});

test('buildReport: does not mutate the session it is given', () => {
  const session = runMartingaleScenario();
  const before = JSON.stringify(session);
  buildReport(session, { profileHistory: [] });
  assert.equal(JSON.stringify(session), before);
});

// ---------------------------------------------------------------------
// updateProfile: accumulates finished sessions, ignores unfinished ones.
// ---------------------------------------------------------------------
test('updateProfile: accumulates a finished session using session.score/session.scoreCounts', () => {
  const session = runMartingaleScenario(4);
  let profile = createProfile();
  profile = updateProfile(profile, session);
  assert.equal(profile.sessions.length, 1);
  assert.equal(profile.sessions[0].levelId, 'pandemic');
  assert.equal(profile.sessions[0].attempt, 4);
  assert.equal(profile.sessions[0].score, session.score);
  assert.deepEqual(profile.sessions[0].counts, session.scoreCounts);
});

test('updateProfile: two finished sessions accumulate to two profile entries', () => {
  const s1 = runMartingaleScenario(1);
  const s2 = runMartingaleScenario(2);
  let profile = createProfile();
  profile = updateProfile(profile, s1);
  profile = updateProfile(profile, s2);
  assert.equal(profile.sessions.length, 2);
  assert.deepEqual(profile.sessions.map((s) => s.attempt), [1, 2]);
});

test('updateProfile: an unfinished (mid-abandoned) session is not recorded — SPEC §9-4 no mid-save interlock', () => {
  const session = runMartingaleScenario();
  const unfinished = { ...session, finished: false };
  let profile = createProfile();
  profile = updateProfile(profile, unfinished);
  assert.equal(profile.sessions.length, 0);
});

test('updateProfile: pure function — does not mutate profile or session', () => {
  const session = runMartingaleScenario();
  const profileBefore = createProfile();
  const profileSnapshot = JSON.stringify(profileBefore);
  const sessionSnapshot = JSON.stringify(session);
  updateProfile(profileBefore, session);
  assert.equal(JSON.stringify(profileBefore), profileSnapshot);
  assert.equal(JSON.stringify(session), sessionSnapshot);
});
