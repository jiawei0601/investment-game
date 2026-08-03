// app.js — M5 UI orchestrator (docs/backlog/M5-ui.md). One-page state
// machine: 開局(setup) -> 主畫面(play) -> 結算(settlement), plus two modals
// that can appear during setup (矛盾警告) and during play (論點強制輸入 /
// 日內回放).
//
// AGENTS.md "遊戲邏輯零重複實作" rule as applied here: every STATE CHANGE
// (open/close/advance/queue/cancel) flows through src/game's session API
// (createSession/queueOrder/cancelOrder/advanceDay) — this file never
// mutates account/positions/cash itself. The few places that import pure
// functions from src/margin (computeMargin/equityOf/positionsInitialReq/
// unrealizedPL/isSettlementDay/PRODUCTS) are READ-ONLY DISPLAY math (pre-
// trade margin preview, per-position unrealized P&L, "is tomorrow
// settlement day" banner) — reusing the canonical formula instead of
// re-deriving it, never a second implementation and never a decision point
// (queueOrder never checks funds; only advanceDay's call into src/margin's
// open() actually accepts/rejects a trade). See HANDOFF/PR notes for why
// this reads as "duplication" under a naive grep for those names and why
// that's the correct tradeoff (reuse > copy-pasting the 10% margin formula
// into src/ui).

import { createSession, queueOrder, cancelOrder, advanceDay } from '../game/index.js';
import { generateIntraday } from '../engine/intraday.js';
import { buildSeed, createRng } from '../engine/rng.js';
import { PLAN_FIELDS, validatePlan, detectContradictions, getTemplate } from '../behavior/index.js';
import { PRODUCTS, computeMargin, equityOf, positionsInitialReq, unrealizedPL, isSettlementDay } from '../margin/index.js';
// src/report (M7) landed while this milestone was in progress — buildReport/
// updateProfile/createProfile are the real thing now, not a stub.
import { buildReport, updateProfile, createProfile } from '../report/index.js';
import { loadCoreData, loadEventsForMonth, chipsForDate } from './data.js';
import { LEVELS, INFINITE_LEVEL, MOSAIC_LEVEL, findLevel } from './levels.js';
import { buildMosaicRows } from '../mosaic/index.js';
import { shouldAutoPauseForEvents, AUTOPLAY_RATES, msPerTick } from './autoplay.js';
import { createDailyChart, createIntradayChart, createEquityChart } from './chart.js';
import {
  isFsaSupported,
  getSavedDirHandle,
  pickAndSaveDirHandle,
  readExistingProfile,
  writeReportFiles,
  downloadFallback,
} from './fsa.js';
import { closeModal, installModalKeyboardSupport, isModalOpen, openModal } from './modal.js';

const PRODUCT_LABEL = { TX: '大台 TX', MTX: '小台 MTX', TMF: '微台 TMF' };
const MASTER_LABEL = { livermore: 'Livermore', opman: 'OPMAN 胖叔', gooaye: '謝孟恭' };
const VIOLATION_LABEL = {
  bag_holding: '凹單（首次）',
  bag_holding_continued: '凹單（持續未平）',
  unplanned_trade: '計畫外交易',
  risk_out_of_control: '風險失控',
  thesis_drift: '論點漂移',
  martingale_add: '攤平加碼',
};
const INFINITE_SAVE_KEY = 'ig_infinite_save';

const state = {
  dailyRows: [],
  chipsRows: [],
  level: null,
  session: null,
  chart: null,
  intradayChart: null,
  equityChart: null,
  infiniteStart: null,
  infiniteEnd: null,
  // 馬賽克模式（ADR 0009）：meta 是 buildMosaicRows() 回傳的 {startDate,
  // warmupEndIndex, sourceMonths} 之中「UI 用得到的那部分」——只有 startDate
  // 拿來算圖表暖示前 60 天的真實脈絡（見 enterPlayScreen），warmupEndIndex/
  // sourceMonths 刻意不對 UI 呈現（規格：不標示暖示/拼接邊界）。
  mosaicMeta: null,
  // { timerId, rate }：自動播放計時器活在 UI 層本身（不是遊戲邏輯的一部
  // 分），rate 選項/ms 換算共用 autoplay.js 的 AUTOPLAY_RATES/msPerTick，
  // 絕不把 setInterval 的時鐘值傳進 session/engine 任何參數（AGENTS.md
  // Date.now()/Math.random() 禁令只管遊戲邏輯路徑，這裡單純是畫面節奏）。
  autoplay: { timerId: null, rate: 1 },
  pendingPlan: null,
  pendingContradictions: null,
  pendingMarketOrder: null,
  // Captured once per setup flow so buildReport's options.contradictionsAtStart
  // / options.planModified (src/report/report.js §2) can report "開局當時"
  // instead of falling back to re-detecting contradictions against the
  // final plan at report-build time. Reset in selectLevel().
  contradictionsAtStart: [],
  planModified: false,
  // 結算自動存檔（使用者第一局實玩回饋：差點忘記按「儲存戰報」）。
  // reportSaved: 這一局戰報是否已經寫入/下載成功（自動或手動皆算）——
  // 「回開局畫面」的離開防呆看這個欄位。autoSaveInFlight: 進結算畫面當下
  // 嘗試自動存檔的那個短暫視窗，true 期間鎖住「回開局畫面」（規格第 4
  // 點：自動存檔成功後才可按），非自動存檔路徑（手動模式）不會設這個。
  // 兩者都在 goToSettlement()/resetToSetup() 重置，跟 session 生命週期同步。
  reportSaved: false,
  autoSaveInFlight: false,
};

const $ = (id) => document.getElementById(id);

function fmtMoney(n) {
  if (!Number.isFinite(n)) return '-';
  return new Intl.NumberFormat('zh-Hant-TW').format(Math.round(n));
}

function monthOf(dateStr) {
  return dateStr.slice(0, 7);
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((el) => {
    el.hidden = el.id !== id;
  });
}

// --------------------------------------------------------------- attempt bookkeeping
// Reproducibility (M5 acceptance: "同關卡同 attempt 重玩，日K與日內回放完全
// 一致") rides entirely on src/engine's seed determinism (buildSeed/createRng,
// already covered by tests/engine.test.js + tests/game.test.js) — this UI
// layer's only job is to hand createSession a stable integer per level per
// playthrough, via localStorage instead of Date.now()/Math.random() (AGENTS.md
// seed convention).
function peekNextAttempt(levelId) {
  return Number(localStorage.getItem(`ig_attempt_${levelId}`) || '0') + 1;
}
function commitAttempt(levelId, n) {
  localStorage.setItem(`ig_attempt_${levelId}`, String(n));
}

// --------------------------------------------------------------- setup screen

function renderLevelCards() {
  const grid = $('level-select');
  grid.innerHTML = '';
  for (const level of [...LEVELS, INFINITE_LEVEL, MOSAIC_LEVEL]) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'level-card';
    card.dataset.levelId = level.id;
    card.setAttribute('aria-pressed', 'false');
    const title = document.createElement('h4');
    title.textContent = level.name;
    const range = document.createElement('div');
    range.className = 'level-range';
    range.textContent = level.range;
    const goal = document.createElement('div');
    goal.className = 'level-goal';
    goal.textContent = level.goal;
    card.append(title, range, goal);
    card.addEventListener('click', () => selectLevel(level));
    grid.appendChild(card);
  }
}

function selectLevel(level) {
  state.level = level;
  state.infiniteStart = null;
  state.infiniteEnd = null;
  state.mosaicMeta = null;
  state.contradictionsAtStart = [];
  state.planModified = false;
  document.querySelectorAll('.level-card').forEach((c) => {
    const selected = c.dataset.levelId === level.id;
    c.classList.toggle('selected', selected);
    c.setAttribute('aria-pressed', String(selected));
  });
  $('setup-form-title').textContent = level.name;
  $('setup-form-goal').textContent = level.goal;
  $('infinite-options').hidden = level.id !== INFINITE_LEVEL.id;
  $('infinite-range-label').textContent = '';
  if ($('mosaic-options')) $('mosaic-options').hidden = level.id !== MOSAIC_LEVEL.id;
  if (level.id === INFINITE_LEVEL.id) checkInfiniteResume();
  $('setup-form').hidden = false;
}

// 局長輸入框（月）只有馬賽克模式需要（buildMosaicRows 的 monthsTarget），
// 沒有對應的 index.html 靜態元素——用 JS 動態建、插到 infinite-options 旁邊
// （跟 infinite-options 同一個 field-row 慣例），只建立一次。
function ensureMosaicOptionsUI() {
  if ($('mosaic-options')) return;
  const div = document.createElement('div');
  div.id = 'mosaic-options';
  div.className = 'field-row';
  div.hidden = true;
  div.innerHTML = `
    <label>局長（月）
      <input type="number" id="mosaic-months" min="1" max="24" step="1" value="6" />
    </label>
    <span class="hint">起始日／拼接月份皆由種子決定，開局當下即定案（同 attempt 重玩一致）。</span>
  `;
  $('infinite-options').insertAdjacentElement('afterend', div);
}

function checkInfiniteResume() {
  const btn = $('infinite-resume-btn');
  btn.hidden = !localStorage.getItem(INFINITE_SAVE_KEY);
}

function addMonthsClamped(dateStr, months, maxDateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + months, d));
  const end = dt.toISOString().slice(0, 10);
  return end > maxDateStr ? maxDateStr : end;
}

function randomizeInfiniteStart() {
  const months = Number($('infinite-months').value) || 6;
  const attempt = peekNextAttempt(INFINITE_LEVEL.id);
  const seed = buildSeed(INFINITE_LEVEL.id, attempt, `start-pick-${months}`);
  const rng = createRng(seed);
  const rows = state.dailyRows;
  const maxStartIdx = Math.max(0, rows.length - 15); // leave >=15 trading days to play
  const idx = Math.floor(rng() * (maxStartIdx + 1));
  const startDate = rows[idx].date;
  const endDate = addMonthsClamped(startDate, months, rows[rows.length - 1].date);
  state.infiniteStart = startDate;
  state.infiniteEnd = endDate;
  $('infinite-range-label').textContent = `${startDate} → ${endDate}`;
}

function optionToFormValue(field, domValue) {
  const opt = PLAN_FIELDS[field].options.find((o) => String(o.value) === domValue);
  return opt ? opt.value : domValue;
}

function renderPlanFields() {
  const container = $('plan-fields');
  container.querySelectorAll('.plan-field-row').forEach((el) => el.remove());
  for (const [field, def] of Object.entries(PLAN_FIELDS)) {
    const row = document.createElement('div');
    row.className = 'plan-field-row';
    const label = document.createElement('label');
    label.textContent = def.label;
    const select = document.createElement('select');
    select.id = `plan-${field}`;
    for (const opt of def.options) {
      const o = document.createElement('option');
      o.value = String(opt.value);
      o.textContent = opt.label;
      select.appendChild(o);
    }
    label.appendChild(select);
    row.appendChild(label);
    container.appendChild(row);
  }
  const paramsRow = document.createElement('div');
  paramsRow.className = 'plan-field-row';
  paramsRow.id = 'stoploss-params-row';
  container.appendChild(paramsRow);

  function renderStopParams() {
    const rule = $('plan-stopLossRule').value;
    paramsRow.innerHTML = '';
    if (rule === 'fixed_points') {
      paramsRow.innerHTML = '<label>停損點數 X<input type="number" id="plan-stop-points" min="10" step="10" value="200"></label>';
    } else if (rule === 'ma_break') {
      paramsRow.innerHTML = '<label>均線天數 N<input type="number" id="plan-stop-n" min="1" step="1" value="20"></label>';
    }
  }
  $('plan-stopLossRule').addEventListener('change', renderStopParams);
  renderStopParams();
}

function collectPlanFromForm() {
  const plan = {};
  for (const field of Object.keys(PLAN_FIELDS)) {
    plan[field] = optionToFormValue(field, $(`plan-${field}`).value);
  }
  if (plan.stopLossRule === 'fixed_points') {
    plan.stopLossParams = { points: Number($('plan-stop-points').value) };
  } else if (plan.stopLossRule === 'ma_break') {
    plan.stopLossParams = { n: Number($('plan-stop-n').value) };
  }
  return plan;
}

function createMasterQuoteBlock(templateKey) {
  const block = document.createElement('div');
  block.className = 'master-quote-block';
  const templates = getTemplate(templateKey);
  for (const [master, lines] of Object.entries(templates)) {
    const heading = document.createElement('h4');
    heading.textContent = MASTER_LABEL[master] ?? master;
    block.appendChild(heading);
    for (const line of lines) {
      const quote = document.createElement('p');
      quote.textContent = `「${line}」`;
      block.appendChild(quote);
    }
  }
  return block;
}

function showContradictionModal(contradictions) {
  const list = $('contradiction-list');
  list.replaceChildren();
  for (const contradiction of contradictions) {
    const block = document.createElement('div');
    block.className = 'contradiction-block';
    const reason = document.createElement('p');
    reason.className = 'contradiction-reason';
    reason.textContent = contradiction.reason;
    block.append(reason, createMasterQuoteBlock(contradiction.templateKey));
    list.appendChild(block);
  }
  openModal($('contradiction-modal'), {
    initialFocus: '#contradiction-revise',
    onEscape: reviseContradiction,
  });
}

function reviseContradiction() {
  state.planModified = true;
  closeModal($('contradiction-modal'));
  state.pendingPlan = null;
  state.pendingContradictions = null;
}

function handleStartGameSubmit(e) {
  e.preventDefault();
  if (!state.level) {
    alert('請先選一個關卡');
    return;
  }
  if (state.level.id === INFINITE_LEVEL.id && !state.infiniteStart) {
    alert('無限模式請先按「用種子隨機起點」');
    return;
  }
  const plan = collectPlanFromForm();
  const errors = validatePlan(plan);
  if (errors.length) {
    alert(`計畫格式錯誤：\n${errors.join('\n')}`);
    return;
  }
  const contradictions = detectContradictions(plan);
  if (contradictions.length === 0) {
    startSessionFlow(plan);
  } else {
    if (state.contradictionsAtStart.length === 0) state.contradictionsAtStart = contradictions; // capture first occurrence only
    state.pendingPlan = plan;
    state.pendingContradictions = contradictions;
    showContradictionModal(contradictions);
  }
}

async function startSessionFlow(plan) {
  const cash = Number($('cash-input').value);
  const income = Number($('income-input').value) || 0;
  if (!(cash > 0)) {
    alert('起始資金需為正數');
    return;
  }
  let startDate = state.level.startDate;
  let endDate = state.level.endDate;
  if (state.level.id === INFINITE_LEVEL.id) {
    startDate = state.infiniteStart;
    endDate = state.infiniteEnd;
  }
  const attempt = peekNextAttempt(state.level.id);

  // 馬賽克模式（ADR 0009）：dailyRows 換成 buildMosaicRows() 產出的拼接序
  // 列，startDate/endDate 直接取那份序列本身的頭尾——createSession 的
  // rowsBetween 只是原樣把整份序列篩回來（已排序、含頭含尾），session/margin/
  // behavior 完全不知道自己吃到的是拼接資料，這正是 ADR 0009「mosaic 只是
  // dailyRows 產生器」的意思。
  let mosaicDailyRows = state.dailyRows;
  if (state.level.id === MOSAIC_LEVEL.id) {
    const monthsTarget = Number($('mosaic-months')?.value) || 6;
    let built;
    try {
      built = buildMosaicRows({ attempt, dailyRows: state.dailyRows, monthsTarget });
    } catch (err) {
      alert(`無法開局：${err.message}`);
      return;
    }
    mosaicDailyRows = built.rows;
    startDate = built.rows[0].date;
    endDate = built.rows[built.rows.length - 1].date;
    state.mosaicMeta = built.meta;
  }

  let session;
  try {
    session = createSession({
      levelId: state.level.id,
      attempt,
      startDate,
      endDate,
      initialCash: cash,
      plan,
      monthlyIncome: income,
      dailyRows: mosaicDailyRows,
    });
  } catch (err) {
    alert(`無法開局：${err.message}`);
    return;
  }
  commitAttempt(state.level.id, attempt);
  state.session = session;
  await enterPlayScreen();
}

// --------------------------------------------------------------- play screen

function isMosaicMode() {
  return state.level?.id === MOSAIC_LEVEL.id;
}

// 馬賽克模式圖表起點要往前補真實資料（規格「圖表起始顯示暖示前 60 天脈
// 絡」）——只補顯示用，不進 session.rows，不可點擊回放（openIntradayModal
// 本來就只認 playedDates 內的日期，多出來的脈絡天數自然是唯讀）。
function mosaicContextRows() {
  if (!state.mosaicMeta) return [];
  const idx = state.dailyRows.findIndex((r) => r.date === state.mosaicMeta.startDate);
  if (idx <= 0) return [];
  return state.dailyRows.slice(Math.max(0, idx - 60), idx);
}

async function enterPlayScreen() {
  showScreen('screen-play');
  if (state.chart) state.chart.destroy();
  state.chart = createDailyChart($('daily-chart'));
  state.chart.onDayClick(openIntradayModal);
  // 點圖表任一處只把價格填進標線輸入框（僅填入，不直接建線——coordinator
  // 規格第 1 點：避免誤觸就直接畫線）。
  state.chart.onPriceClick((price) => {
    $('priceline-input').value = Math.round(price);
  });
  const rowsSoFar = state.session.rows.slice(0, state.session.cursor);
  const mosaic = isMosaicMode();
  const chartRows = mosaic ? [...mosaicContextRows(), ...rowsSoFar] : rowsSoFar;
  // ADR 0009 資訊層歸零：馬賽克模式全程不顯示籌碼副圖（傳空陣列，
  // chart.js 的 setData 在 chipsPoints 為空時本來就會把 chipsSeries 收起
  // 來，不需要另開一套隱藏邏輯）。
  state.chart.setData(chartRows, mosaic ? [] : state.chipsRows);
  // 下單面板的 select/input/button 是靜態元素（initOrderPanel 只在 init()
  // 跑一次接好監聽器，不像改版前的商品卡是每局重建 DOM），這裡只需要用
  // 新 session 的價格/資金重算一次試算數字。
  updateMarginPreview();
  renderHeader();
  renderAccountPanel();
  renderPositionsTable();
  renderOrderQueue();
  updateOrderFormVisibility();
  // ADR 0009 資訊層歸零：事件卡面板整個藏起來，且從第一天就不打
  // loadEventsForMonth——馬賽克的合成日曆日期即使剛好落在某個真實年月，
  // 那個月的事件卡內容跟拼接段的行情完全對不上，寧可不 fetch 也不要讓玩
  // 家看到不相干的新聞。
  $('events-panel').hidden = mosaic;
  if (!mosaic) {
    const anchorRow = state.session.rows[Math.max(state.session.cursor - 1, 0)];
    await loadAndRenderMonthEvents(monthOf(anchorRow.date));
  }
  renderPriceLineList(); // 新 session 的圖表是全新的，這裡清單重置成「尚未標記」（除非 resumeInfiniteProgress 隨後補回）
  updateSettlementWarning();
}

function latestRiskSnapshot(session) {
  for (let i = session.events.length - 1; i >= 0; i--) {
    if (session.events[i].type === 'risk_snapshot') return session.events[i];
  }
  return null;
}

function renderHeader() {
  const s = state.session;
  const snap = latestRiskSnapshot(s);
  const cursorRow = s.rows[Math.max(s.cursor - 1, 0)];
  const equity = snap ? snap.equity : s.account.cash;
  const marginRatio = snap ? snap.marginUsageRatio : 0;
  const dd = snap ? snap.drawdownPct : 0;
  const overCap = s.plan.marginUsageCap !== 'unlimited' && marginRatio * 100 > s.plan.marginUsageCap;
  const overDD = s.plan.maxDrawdown !== 'unlimited' && dd > s.plan.maxDrawdown;

  $('play-level-name').innerHTML = `<b>${state.level.name}</b> #${s.attempt}`;
  $('play-date').innerHTML = `${s.cursor === 0 ? '尚未開始' : cursorRow.date}（第 ${s.cursor}/${s.rows.length} 天）`;
  $('play-cash').innerHTML = `現金 <b>${fmtMoney(s.account.cash)}</b>`;
  $('play-equity').innerHTML = `權益 <b class="${equity >= 0 ? 'positive' : 'negative'}">${fmtMoney(equity)}</b>`;
  $('play-margin-ratio').innerHTML = `保證金使用率 <b class="${overCap ? 'negative' : ''}">${(marginRatio * 100).toFixed(1)}%</b>`;
  $('play-drawdown').innerHTML = `回撤 <b class="${overDD ? 'negative' : ''}">${dd.toFixed(1)}%</b>`;
}

// Dedicated 帳戶狀態 panel (side column) — same underlying numbers as the
// header bar, laid out as a fuller key/value breakdown, plus the one thing
// the header bar has no room for: a standing 追繳 (margin call) warning that
// stays visible until it's cleared (session.pendingMarginCall is non-null
// from the moment markToMarket/rollover raises it until enforceMarginCall
// clears it at the start of the next advanceDay — see src/game/session.js).
function renderAccountPanel() {
  const s = state.session;
  const snap = latestRiskSnapshot(s);
  const price = s.lastSettlePrice;
  const equity = snap ? snap.equity : s.account.cash;
  const marginRatio = snap ? snap.marginUsageRatio : 0;
  const dd = snap ? snap.drawdownPct : 0;
  const initialReq = positionsInitialReq(s.account.positions, price);
  const overCap = s.plan.marginUsageCap !== 'unlimited' && marginRatio * 100 > s.plan.marginUsageCap;
  const overDD = s.plan.maxDrawdown !== 'unlimited' && dd > s.plan.maxDrawdown;

  const rows = [
    ['現金', fmtMoney(s.account.cash), ''],
    ['權益', fmtMoney(equity), equity >= 0 ? 'positive' : 'negative'],
    ['已用原始保證金', fmtMoney(initialReq), ''],
    ['保證金使用率', `${(marginRatio * 100).toFixed(1)}%（計畫上限 ${s.plan.marginUsageCap === 'unlimited' ? '不設限' : s.plan.marginUsageCap + '%'}）`, overCap ? 'negative' : ''],
    ['權益峰值', fmtMoney(s.peakEquity), ''],
    ['回撤', `${dd.toFixed(1)}%（計畫上限 ${s.plan.maxDrawdown === 'unlimited' ? '不設限' : s.plan.maxDrawdown + '%'}）`, overDD ? 'negative' : ''],
  ];
  $('account-panel-body').innerHTML = rows.map(([k, v, cls]) => `<dt>${k}</dt><dd class="${cls}">${v}</dd>`).join('');

  const warnEl = $('account-panel-margin-call');
  if (s.pendingMarginCall) {
    if (!warnEl) {
      const div = document.createElement('div');
      div.id = 'account-panel-margin-call';
      div.className = 'banner banner-danger';
      div.textContent = `追繳中：需補繳約 ${fmtMoney(s.pendingMarginCall.requiredTopUp)}，次一交易日開盤前若未補足資金將依規則砍倉。`;
      $('account-panel').appendChild(div);
    } else {
      warnEl.textContent = `追繳中：需補繳約 ${fmtMoney(s.pendingMarginCall.requiredTopUp)}，次一交易日開盤前若未補足資金將依規則砍倉。`;
    }
  } else if (warnEl) {
    warnEl.remove();
  }
}

function renderPositionsTable() {
  const tbody = $('positions-table-body');
  tbody.innerHTML = '';
  const s = state.session;
  const price = s.lastSettlePrice;
  const needOvernightReason = s.plan.overnight === 'day_trade_mainly';
  for (const p of s.account.positions) {
    const pl = unrealizedPL(p, price);
    const tr = document.createElement('tr');
    const reasonCell = needOvernightReason
      ? `<input type="text" class="overnight-reason-input" data-product="${p.product}" placeholder="計畫外過夜需填理由" />`
      : '（計畫允許過夜）';
    tr.innerHTML = `
      <td>${PRODUCT_LABEL[p.product]}</td>
      <td>${p.side === 1 ? '多' : '空'}</td>
      <td>${p.lots}</td>
      <td>${p.entryPrice.toFixed(0)}</td>
      <td class="${pl >= 0 ? 'positive' : 'negative'}">${fmtMoney(pl)}</td>
      <td>${reasonCell}</td>
    `;
    tbody.appendChild(tr);
  }
}

// 商品下拉＋單一組共用欄位（方向/口數/單別）取代原本三張商品卡（使用者
// 第一局實玩回饋：三張卡太占空間）。切換商品下拉即時重算保證金試算，
// queueOrder 帶的 product 就是下拉當下選中的值——不改任何遊戲邏輯路徑,
// 送單/試算邏輯與改版前完全一樣，只是從「每商品一份 DOM/一份函式呼叫」
// 收斂成「一份 DOM，讀取當下選中的 product」。
function initOrderPanel() {
  const select = $('order-product');
  select.innerHTML = Object.keys(PRODUCTS)
    .map((product) => `<option value="${product}">${PRODUCT_LABEL[product]}（NT$${PRODUCTS[product].mult}/點・手續費 NT$${PRODUCTS[product].fee}/口）</option>`)
    .join('');
  select.addEventListener('change', updateMarginPreview);
  $('order-lots').addEventListener('input', updateMarginPreview);
  $('order-kind').addEventListener('change', updateOrderFormVisibility);
  $('order-submit-btn').addEventListener('click', () => handleOrderSubmit($('order-product').value));
  updateOrderFormVisibility();
}

function updateOrderFormVisibility() {
  const kind = $('order-kind').value;
  $('order-side-label').hidden = kind !== 'market';
  $('order-trigger-label').hidden = !(kind === 'stop' || kind === 'limit');
  updateMarginPreview();
}

// Display-only preview (see file header note): reuses src/margin's own
// computeMargin/equityOf/positionsInitialReq instead of re-deriving the 10%
// formula in the UI. The *actual* funds check still lives entirely inside
// src/margin/trading.js's open() — this preview can never itself accept or
// reject a trade, queueOrder() always queues regardless of what this shows.
function updateMarginPreview() {
  const el = $('order-preview');
  if (!el) return;
  // initOrderPanel() calls this once at page-load time (via
  // updateOrderFormVisibility) before any game has started — state.session
  // is still null then, so bail out instead of touching s.lastSettlePrice.
  if (!state.session) {
    el.textContent = '';
    el.classList.remove('insufficient');
    return;
  }
  const product = $('order-product').value;
  const kind = $('order-kind').value;
  if (kind !== 'market') {
    el.textContent = kind === 'close' ? '市價平倉，不需額外保證金。' : '掛單觸價後才成交，成交當下另行結算。';
    el.classList.remove('insufficient');
    return;
  }
  const lots = Number($('order-lots').value) || 0;
  const s = state.session;
  const price = s.lastSettlePrice;
  const margin = computeMargin(price, product);
  const requiredForThis = margin.initial * lots;
  const equity = equityOf(s.account, price);
  const otherPositions = s.account.positions.filter((p) => p.product !== product);
  const available = equity - positionsInitialReq(otherPositions, price);
  const ok = available >= requiredForThis;
  el.textContent = `每口原始保證金 ${fmtMoney(margin.initial)}・共需 ${fmtMoney(requiredForThis)} ／ 目前可用資金約 ${fmtMoney(available)}`;
  el.classList.toggle('insufficient', !ok);
}

function handleOrderSubmit(product) {
  const kind = $('order-kind').value;
  const lots = Number($('order-lots').value);
  if (!Number.isInteger(lots) || lots <= 0) {
    alert('口數需為正整數');
    return;
  }

  if (kind === 'market') {
    const side = Number($('order-side').value);
    const existing = state.session.account.positions.find((p) => p.product === product);
    const isFreshOrReversal = !existing || existing.side !== side;
    if (isFreshOrReversal) {
      openThesisModal({ product, side, lots });
    } else {
      queueMarketOrder({ product, side, lots });
    }
  } else if (kind === 'stop' || kind === 'limit') {
    const triggerPrice = Number($('order-trigger-price').value);
    if (!Number.isFinite(triggerPrice)) {
      alert('請輸入觸價');
      return;
    }
    state.session = queueOrder(state.session, { kind, product, lots, triggerPrice });
    renderOrderQueue();
  } else if (kind === 'close') {
    state.session = queueOrder(state.session, { kind: 'close', product, lots });
    renderOrderQueue();
  }
}

function queueMarketOrder({ product, side, lots, thesis }) {
  state.session = queueOrder(state.session, { kind: 'market', product, side, lots, thesis });
  renderOrderQueue();
}

function openThesisModal(order) {
  state.pendingMarketOrder = order;
  $('thesis-input').value = '';
  openModal($('thesis-modal'), {
    initialFocus: '#thesis-input',
    onEscape: cancelThesisModal,
  });
}

function cancelThesisModal() {
  state.pendingMarketOrder = null;
  closeModal($('thesis-modal'));
}

function describeOrder(o) {
  const label = { market: '市價', close: '平倉', stop: '停損', limit: '停利', overnight_reason: '過夜理由' }[o.kind] ?? o.kind;
  if (o.kind === 'market') return `${label} ${PRODUCT_LABEL[o.product]} ${o.side === 1 ? '多' : '空'} ${o.lots}口`;
  if (o.kind === 'stop' || o.kind === 'limit') return `${label} ${PRODUCT_LABEL[o.product]} ${o.lots}口 @ ${o.triggerPrice}`;
  if (o.kind === 'close') return `${label} ${PRODUCT_LABEL[o.product]} ${o.lots}口`;
  return `${label} ${o.product ?? ''}`;
}

function renderOrderQueue() {
  const ul = $('order-queue-list');
  ul.innerHTML = '';
  for (const o of state.session.orderQueue) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = describeOrder(o);
    const btn = document.createElement('button');
    btn.className = 'btn-secondary';
    btn.textContent = '取消';
    btn.addEventListener('click', () => {
      state.session = cancelOrder(state.session, o.id);
      renderOrderQueue();
    });
    li.append(span, btn);
    ul.appendChild(li);
  }
}

function pushToast(text, cls) {
  const container = $('toast-container');
  const div = document.createElement('div');
  div.className = `toast ${cls}`;
  div.textContent = text;
  container.appendChild(div);
  setTimeout(() => {
    div.classList.add('toast-out');
    setTimeout(() => div.remove(), 300);
  }, 7000);
}

function describeEventForToast(e) {
  if (e.type === 'force_liquidation') return `${PRODUCT_LABEL[e.product]} ${e.lots}口 @ ${e.price}（${e.reason === 'profit_realization' ? '強制實現獲利回補現金' : '虧損強平'}）`;
  if (e.type === 'margin_call') return `需補繳約 ${fmtMoney(e.requiredTopUp)}，次日開盤前若未補足將被砍倉`;
  if (e.type === 'margin_call_enforcement') return `${PRODUCT_LABEL[e.product]} ${e.lots}口 @ ${e.price}（追繳未補足，開盤前執行）`;
  if (e.type === 'rollover') return `${PRODUCT_LABEL[e.product]} 滑價 ${e.slippage} 點，新倉價 ${e.newEntryPrice.toFixed(0)}`;
  return '';
}

function showDaySummaryToasts(events) {
  const kinds = [
    { type: 'margin_call_enforcement', label: '追繳未補足・已砍倉', cls: 'toast-danger' },
    { type: 'force_liquidation', label: '盤中強制平倉', cls: 'toast-danger' },
    { type: 'margin_call', label: '追繳通知', cls: 'toast-warning' },
    { type: 'rollover', label: '結算日自動轉倉', cls: 'toast-warning' },
  ];
  for (const k of kinds) {
    const matches = events.filter((e) => e.type === k.type);
    if (matches.length === 0) continue;
    pushToast(`${k.label}：${matches.map(describeEventForToast).join('；')}`, k.cls);
  }
}

function updateSettlementWarning() {
  const banner = $('settlement-warning');
  const s = state.session;
  const nextRow = s.finished ? null : s.rows[s.cursor];
  if (!nextRow || !isSettlementDay(nextRow.date) || s.account.positions.length === 0) {
    banner.hidden = true;
    return;
  }
  const held = s.account.positions.map((p) => `${PRODUCT_LABEL[p.product]} ${p.side === 1 ? '多' : '空'}${p.lots}口`).join('、');
  banner.textContent = `明日 ${nextRow.date} 為結算日：目前持有 ${held}，未平倉部位將自動轉倉（固定滑價＋雙邊費稅，必然執行）。若不想轉倉，請在按「下一天」前先平倉。`;
  banner.hidden = false;
}

function saveInfiniteProgress() {
  if (state.level?.id === INFINITE_LEVEL.id) {
    localStorage.setItem(
      INFINITE_SAVE_KEY,
      JSON.stringify({
        session: state.session,
        contradictionsAtStart: state.contradictionsAtStart,
        planModified: state.planModified,
        // 價位標線（coordinator 追加項第 4 點）：無限模式單槽存進既有
        // localStorage，一併存 lines 陣列（純 UI 註記，不影響 session 本
        // 身的 schema）。劇本模式沒有中途存檔本來就作廢不用管；馬賽克模式
        // 目前沒有中途存檔功能，同樣不用管。
        priceLines: state.chart ? state.chart.listPriceLines().map((l) => l.price) : [],
      })
    );
  }
}

// 回傳這一天新增的事件切片（undefined＝推進失敗/中止）——autoplay 的 tick
// 需要這個回傳值判斷是否該自動暫停（shouldAutoPauseForEvents，見
// autoplay.js），手動點「下一天」的呼叫端本來就不理會回傳值，兩邊共用同一
// 條推進路徑，沒有第二份推進邏輯。
async function handleAdvanceDay() {
  document.querySelectorAll('.overnight-reason-input').forEach((input) => {
    const reason = input.value.trim();
    if (reason) {
      state.session = queueOrder(state.session, { kind: 'overnight_reason', product: input.dataset.product, reason });
    }
  });

  const mosaic = isMosaicMode();
  const prevAnchor = state.session.rows[Math.max(state.session.cursor - 1, 0)];
  const prevMonth = monthOf(prevAnchor.date);
  const beforeCount = state.session.events.length;

  try {
    state.session = advanceDay(state.session);
  } catch (err) {
    alert(`推進失敗：${err.message}`);
    return undefined;
  }

  const newEvents = state.session.events.slice(beforeCount);
  const newRow = state.session.rows[state.session.cursor - 1];
  state.chart.appendDay(newRow, mosaic ? null : chipsForDate(state.chipsRows, newRow.date));

  showDaySummaryToasts(newEvents);
  renderHeader();
  renderAccountPanel();
  renderPositionsTable();
  renderOrderQueue();
  updateMarginPreview();

  const newMonth = monthOf(newRow.date);
  if (!mosaic && newMonth !== prevMonth) await loadAndRenderMonthEvents(newMonth);

  updateSettlementWarning();
  saveInfiniteProgress();

  if (state.session.finished) goToSettlement();

  return newEvents;
}

async function loadAndRenderMonthEvents(monthStr) {
  const events = await loadEventsForMonth(monthStr);
  const ul = $('month-events-list');
  ul.innerHTML = '';
  if (events.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'hint';
    empty.textContent = '本月尚無事件卡（全量仍在生成中）。';
    ul.appendChild(empty);
    return;
  }
  for (const ev of events) {
    const li = document.createElement('li');
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.setAttribute('aria-expanded', 'false');
    const title = document.createElement('div');
    title.className = 'event-title';
    const titleText = document.createElement('span');
    titleText.textContent = ev.title ?? '';
    const category = document.createElement('span');
    category.className = 'event-category';
    category.textContent = ev.category ?? '';
    title.append(titleText, category);
    const body = document.createElement('div');
    body.className = 'event-body';
    body.textContent = ev.body ?? '';
    li.append(title, body);
    const toggle = () => {
      const expanded = li.classList.toggle('expanded');
      li.setAttribute('aria-expanded', String(expanded));
    };
    li.addEventListener('click', toggle);
    li.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      toggle();
    });
    ul.appendChild(li);
  }
}

function openIntradayModal(dateStr) {
  const s = state.session;
  const playedDates = new Set(s.rows.slice(0, s.cursor).map((r) => r.date));
  if (!playedDates.has(dateStr)) return; // haven't walked through this day yet — no-op
  const row = s.rows.find((r) => r.date === dateStr);
  if (!row) return;
  // Regenerates via M2's own generateIntraday with the exact same seed the
  // session used that day (buildSeed(levelId,attempt,date)) — same-seed
  // determinism (tests/engine.test.js) guarantees byte-identical bars, so
  // this is a true replay, not a new draw. session.events only carries the
  // 301-point `knots` (touch-price ground truth), not the 60 aggregated
  // display `bars`, so re-deriving `bars` here is the only way to get them.
  const seed = buildSeed(s.levelId, s.attempt, dateStr);
  const { bars } = generateIntraday({ open: row.open, high: row.high, low: row.low, close: row.close }, seed);
  $('intraday-date-label').textContent = dateStr;
  openModal($('intraday-modal'), { initialFocus: '#intraday-close' });
  if (!state.intradayChart) state.intradayChart = createIntradayChart($('intraday-chart'));
  state.intradayChart.setBars(dateStr, bars);
}

// --------------------------------------------------------------- settlement screen

async function goToSettlement() {
  if (state.level?.id === INFINITE_LEVEL.id) localStorage.removeItem(INFINITE_SAVE_KEY);
  showScreen('screen-settlement');
  renderSettlementSummary();
  state.reportSaved = false;
  await attemptAutoSaveOrShowManual();
}

function renderSettlementSummary() {
  const s = state.session;
  const scoreClass = s.score >= 70 ? 'positive' : s.score < 40 ? 'negative' : '';
  $('settlement-summary').innerHTML = `
    <div class="score-big ${scoreClass}">${s.score} <span style="font-size:16px;color:var(--text-2)">/ 100 行為分</span></div>
    <p class="hint">${state.level.name} 第 ${s.attempt} 次挑戰・${s.rows[0].date} → ${s.rows[s.cursor - 1]?.date ?? s.rows[s.rows.length - 1].date}</p>
  `;
  $('settlement-violations').innerHTML =
    '<h3>違背統計</h3>' +
    Object.entries(s.scoreCounts)
      .map(([type, count]) => `<div class="violation-row"><span>${VIOLATION_LABEL[type] ?? type}</span><span>${count}</span></div>`)
      .join('');

  const riskSnapshots = s.events.filter((e) => e.type === 'risk_snapshot');
  if (state.equityChart) state.equityChart.destroy();
  state.equityChart = createEquityChart($('equity-curve-chart'));
  state.equityChart.setData(riskSnapshots);
}

// --------------------------------------------------------------- 結算自動存檔
// 使用者第一局實玩回饋：結算畫面要記得按「儲存戰報」，第一局差點連戰報都
// 沒存到。規則（見 goToSettlement 呼叫點與 wireStaticHandlers 的
// new-game-btn 監聽器）：
//   - 有已授權且 queryPermission 仍 granted 的資料夾 handle → 進結算畫面
//     當下自動寫檔，不需要使用者按任何鈕；寫入當下鎖住「回開局畫面」
//     （state.autoSaveInFlight），完成後解鎖。
//   - 沒有 handle／權限過期／自動寫入失敗 → 退回手動模式：顯示原因＋
//     「儲存戰報」鈕＋「授權一次後，之後每局自動存檔」提示。手動模式下
//     「回開局畫面」不鎖，但沒存過就按會跳 confirm。
//   - showDirectoryPicker/requestPermission 需要真人手勢，所以自動存檔
//     只能用 getSavedDirHandle()（純讀 IndexedDB＋queryPermission，不彈窗）
//     ——這正是 fsa.js canAutoSave() 那個小純函數在判斷的事。

// 建立「授權一次後...」提示行與「變更存檔資料夾」小連結——沒有對應的
// index.html 靜態元素（本次任務只碰 app.js/fsa.js），用 JS 動態建、插在
// save-report-btn 旁邊，只建立一次。
function ensureSettlementSaveUI() {
  if ($('fsa-first-time-hint')) return;
  const hint = document.createElement('p');
  hint.id = 'fsa-first-time-hint';
  hint.className = 'hint';
  hint.textContent = '授權一次後，之後每局自動存檔。';
  $('save-report-btn').insertAdjacentElement('afterend', hint);

  const changeLink = document.createElement('button');
  changeLink.type = 'button';
  changeLink.id = 'fsa-change-folder-btn';
  changeLink.className = 'btn-secondary';
  changeLink.textContent = '變更存檔資料夾';
  hint.insertAdjacentElement('afterend', changeLink);
}

// 兩條存檔路徑（自動／手動）共用的「組報告內容」——baseProfile 優先讀目標
// 資料夾裡既有的 profile.json（跨局進步曲線，SPEC §3），沒有 dirHandle
// （下載回退）就從空白 profile 開始。
async function buildReportArtifacts(dirHandle) {
  const s = state.session;
  const lastDate = s.rows[s.cursor - 1]?.date ?? s.rows[s.rows.length - 1].date;
  let baseProfile = createProfile();
  if (dirHandle) {
    const existing = await readExistingProfile(dirHandle);
    if (existing) baseProfile = existing;
  }
  const nextProfile = updateProfile(baseProfile, s);
  const reportMarkdown = buildReport(s, {
    profileHistory: nextProfile.sessions,
    contradictionsAtStart: state.contradictionsAtStart,
    planModified: state.planModified,
  });
  return { lastDate, reportMarkdown, profileJson: JSON.stringify(nextProfile, null, 2) };
}

async function writeReportToHandle(dirHandle) {
  const { lastDate, reportMarkdown, profileJson } = await buildReportArtifacts(dirHandle);
  const s = state.session;
  return writeReportFiles(dirHandle, { levelId: s.levelId, attempt: s.attempt, date: lastDate, reportMarkdown, profileJson });
}

function updateNewGameButtonState() {
  $('new-game-btn').disabled = state.autoSaveInFlight;
}

// offerAuth=false 專給「這瀏覽器根本不支援 FSA」用——授權提示/變更資料夾
// 連結兩個都跟「不彈窗自動存檔」這件事綁在一起，不支援就都沒意義。
function showManualSaveUI(reasonText, { offerAuth = true } = {}) {
  $('fsa-status').textContent = reasonText;
  $('fsa-first-time-hint').hidden = !offerAuth;
  $('fsa-change-folder-btn').hidden = !offerAuth;
}

function showAutoSavedUI(filename, folderName) {
  $('fsa-status').textContent = `✓ 已自動存檔至「${folderName}」：reports/${filename}、profile.json`;
  $('fsa-first-time-hint').hidden = true;
  $('fsa-change-folder-btn').hidden = false;
}

// 進結算畫面當下嘗試自動存檔（規格第 1 點）；getSavedDirHandle() 只讀不彈
// 窗（純 IndexedDB + queryPermission），完全不需要使用者手勢，可以在
// goToSettlement() 這種非手勢觸發的路徑裡直接 await。
async function attemptAutoSaveOrShowManual() {
  // 鎖「回開局畫面」涵蓋整個判斷＋寫入視窗（不是只鎖寫入那一小段）：
  // getSavedDirHandle() 本身也是 await（IndexedDB），沒鎖住的話玩家理論上
  // 能在「還在判斷要不要自動存」的瞬間就點走，跟規格第 4 點的防呆意圖相
  // 反。unlock 一律在 finally，任何一條分支結束都會解鎖。
  state.autoSaveInFlight = true;
  updateNewGameButtonState();
  try {
    if (!isFsaSupported()) {
      showManualSaveUI('此瀏覽器不支援 File System Access API，「儲存戰報」會改成下載兩個檔案。', { offerAuth: false });
      return;
    }
    let dirHandle = null;
    try {
      dirHandle = await getSavedDirHandle();
    } catch (err) {
      console.error('getSavedDirHandle failed:', err);
      dirHandle = null;
    }
    if (!dirHandle) {
      showManualSaveUI('尚未授權存檔資料夾，按「儲存戰報」授權一次即可。');
      return;
    }
    try {
      const filename = await writeReportToHandle(dirHandle);
      state.reportSaved = true;
      showAutoSavedUI(filename, dirHandle.name);
    } catch (err) {
      // 權限過期／資料夾被移動或刪除等——退回手動模式，原因給玩家看，不吞掉。
      console.error('auto-save failed, falling back to manual:', err);
      showManualSaveUI(`自動存檔失敗（${err.message}），請按「儲存戰報」手動存檔。`);
    }
  } finally {
    state.autoSaveInFlight = false;
    updateNewGameButtonState();
  }
}

// 手動「儲存戰報」鈕：這個 click 本身就是 FSA 要求的使用者手勢，可以彈
// showDirectoryPicker（首次授權）或 requestPermission（重新授權）。
async function handleSaveReport() {
  let dirHandle = null;

  if (isFsaSupported()) {
    try {
      dirHandle = await getSavedDirHandle();
      if (!dirHandle) dirHandle = await pickAndSaveDirHandle(); // this click IS the user gesture
    } catch (err) {
      console.error('FSA authorization failed, falling back to download:', err);
      dirHandle = null;
    }
  }

  try {
    if (dirHandle) {
      const filename = await writeReportToHandle(dirHandle);
      state.reportSaved = true;
      showAutoSavedUI(filename, dirHandle.name);
    } else {
      const { lastDate, reportMarkdown, profileJson } = await buildReportArtifacts(null);
      const s = state.session;
      const filename = downloadFallback({ levelId: s.levelId, attempt: s.attempt, date: lastDate, reportMarkdown, profileJson });
      state.reportSaved = true;
      $('fsa-status').textContent = `已觸發下載：${filename}、profile.json`;
    }
  } catch (err) {
    console.error(err);
    $('fsa-status').textContent = `寫入失敗（${err.message}），已改為下載。`;
    const { lastDate, reportMarkdown, profileJson } = await buildReportArtifacts(null);
    const s = state.session;
    downloadFallback({ levelId: s.levelId, attempt: s.attempt, date: lastDate, reportMarkdown, profileJson });
    state.reportSaved = true;
  }
  updateNewGameButtonState();
}

// 「變更存檔資料夾」：重新 showDirectoryPicker，換一個資料夾當往後的自動
// 存檔目標（規格第 3 點）。同一個 click 手勢下彈窗，成功後立刻用新資料夾
// 補存一次這局的戰報（不然玩家會以為換了資料夾但這局沒存進新地方）。
async function handleChangeFolder() {
  try {
    const dirHandle = await pickAndSaveDirHandle();
    const filename = await writeReportToHandle(dirHandle);
    state.reportSaved = true;
    showAutoSavedUI(filename, dirHandle.name);
  } catch (err) {
    console.error('change folder failed:', err);
    $('fsa-status').textContent = `變更資料夾失敗（${err.message}）。`;
  }
  updateNewGameButtonState();
}

// --------------------------------------------------------------- autoplay

// 播放／暫停控制沒有對應的 index.html 靜態元素——用 JS 動態建、插到既有
// 「下一天」按鈕前面，只建立一次。
function ensureAutoplayControlsUI() {
  if ($('autoplay-toggle-btn')) return;
  const wrap = document.createElement('div');
  wrap.id = 'autoplay-controls';
  wrap.className = 'field-row';
  wrap.innerHTML = `
    <button type="button" id="autoplay-toggle-btn" class="btn-secondary">▶ 播放</button>
    <label>速率
      <select id="autoplay-rate-select">
        ${AUTOPLAY_RATES.map((r) => `<option value="${r}"${r === 1 ? ' selected' : ''}>${r} 根／秒</option>`).join('')}
      </select>
    </label>
  `;
  $('advance-day-btn').insertAdjacentElement('beforebegin', wrap);
}

// --------------------------------------------------------------- 水平價位線標記

// 小輸入組（價位數字輸入＋標線鈕）插在推進控制列裡（跟下一天/自動播放同
// 一條，coordinator 規格第 1 點）。點圖表任一處只把價格「填進輸入框」
// （見 enterPlayScreen 的 onPriceClick 接線），不直接建線，避免誤觸。
function ensurePriceLineControlsUI() {
  if ($('priceline-controls')) return;
  const wrap = document.createElement('div');
  wrap.id = 'priceline-controls';
  wrap.className = 'field-row';
  wrap.innerHTML = `
    <label>價位標線
      <input type="number" id="priceline-input" step="1" placeholder="點圖表帶入" />
    </label>
    <button type="button" id="priceline-add-btn" class="btn-secondary">＋ 標線</button>
  `;
  $('advance-controls').appendChild(wrap);
}

// 已標線清單顯示在下單面板附近（coordinator 規格第 2 點）。
function ensurePriceLineListUI() {
  if ($('priceline-list-panel')) return;
  const section = document.createElement('section');
  section.id = 'priceline-list-panel';
  section.className = 'panel';
  section.innerHTML = `
    <h3>已標價位線</h3>
    <ul id="priceline-list"></ul>
  `;
  $('order-panel').insertAdjacentElement('beforebegin', section);
}

// 純 UI 註記（coordinator 規格第 4 點）：line 的實際狀態活在
// state.chart（src/ui/chart.js 的 candleSeries.createPriceLine 封裝），這
// 裡只是每次變動後重畫清單，不進 session/events/report 任何一條路徑。
function renderPriceLineList() {
  const ul = $('priceline-list');
  if (!ul) return;
  const lines = state.chart ? state.chart.listPriceLines() : [];
  ul.innerHTML = '';
  if (lines.length === 0) {
    ul.innerHTML = '<li class="hint">尚未標記</li>';
    return;
  }
  for (const { id, price } of lines) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = Math.round(price);
    const btn = document.createElement('button');
    btn.className = 'btn-secondary';
    btn.textContent = '刪除';
    btn.addEventListener('click', () => {
      state.chart.removePriceLine(id);
      renderPriceLineList();
      saveInfiniteProgress();
    });
    li.append(span, btn);
    ul.appendChild(li);
  }
}

function handleAddPriceLine() {
  if (!state.chart) return;
  const price = Number($('priceline-input').value);
  if (!Number.isFinite(price)) {
    alert('請輸入有效價位');
    return;
  }
  const id = state.chart.addPriceLine(price);
  if (id === null) {
    alert('已達上限 20 條，請先刪除幾條再標新的（防手滑灌爆）。');
    return;
  }
  renderPriceLineList();
  saveInfiniteProgress();
}

function isAnyModalOpen() {
  return isModalOpen($('thesis-modal')) || isModalOpen($('contradiction-modal')) || isModalOpen($('intraday-modal'));
}

function isAutoplaying() {
  return state.autoplay.timerId !== null;
}

function setAutoplayButtonLabel() {
  $('autoplay-toggle-btn').textContent = isAutoplaying() ? '⏸ 暫停' : '▶ 播放';
}

function stopAutoplay() {
  if (state.autoplay.timerId !== null) {
    clearInterval(state.autoplay.timerId);
    state.autoplay.timerId = null;
  }
  setAutoplayButtonLabel();
}

// 一個 tick＝跟手動按「下一天」完全同一條路徑（handleAdvanceDay）；tick 本
// 身只負責「這次要不要繼續」的判斷，不重做任何推進邏輯。
async function autoplayTick() {
  if (isAnyModalOpen()) {
    stopAutoplay();
    return;
  }
  const newEvents = await handleAdvanceDay();
  if (newEvents === undefined) {
    stopAutoplay(); // advanceDay 失敗/中止
    return;
  }
  if (state.session.finished || shouldAutoPauseForEvents(newEvents)) {
    stopAutoplay();
  }
}

function startAutoplay() {
  if (isAutoplaying()) return;
  if (state.session?.finished) return;
  state.autoplay.timerId = setInterval(autoplayTick, msPerTick(state.autoplay.rate));
  setAutoplayButtonLabel();
}

function toggleAutoplay() {
  if (isAutoplaying()) stopAutoplay();
  else startAutoplay();
}

function changeAutoplayRate() {
  state.autoplay.rate = Number($('autoplay-rate-select').value) || 1;
  if (isAutoplaying()) {
    // 速率切換在播放中即時生效：重開一個新間隔的計時器,不算暫停。
    clearInterval(state.autoplay.timerId);
    state.autoplay.timerId = setInterval(autoplayTick, msPerTick(state.autoplay.rate));
  }
}

function resetToSetup() {
  stopAutoplay();
  state.session = null;
  state.level = null;
  state.reportSaved = false;
  state.autoSaveInFlight = false;
  if (state.chart) {
    state.chart.destroy();
    state.chart = null;
  }
  if (state.intradayChart) {
    state.intradayChart.destroy();
    state.intradayChart = null;
  }
  if (state.equityChart) {
    state.equityChart.destroy();
    state.equityChart = null;
  }
  $('setup-form').hidden = true;
  document.querySelectorAll('.level-card').forEach((c) => c.classList.remove('selected'));
  showScreen('screen-setup');
}

// --------------------------------------------------------------- wiring

function wireStaticHandlers() {
  installModalKeyboardSupport();
  $('setup-form').addEventListener('submit', handleStartGameSubmit);
  $('infinite-randomize-btn').addEventListener('click', randomizeInfiniteStart);
  $('infinite-resume-btn').addEventListener('click', resumeInfiniteProgress);

  $('contradiction-revise').addEventListener('click', () => {
    reviseContradiction();
  });
  $('contradiction-proceed').addEventListener('click', () => {
    const plan = state.pendingPlan; // "堅持開局" — plan unchanged; contradictionsAtStart/planModified already
    // captured on state and flow straight into buildReport's options at
    // save-report time (src/report/report.js §2), no need to mutate plan itself.
    closeModal($('contradiction-modal'));
    startSessionFlow(plan);
    state.pendingPlan = null;
    state.pendingContradictions = null;
  });

  $('thesis-cancel').addEventListener('click', () => {
    cancelThesisModal();
  });
  $('thesis-confirm').addEventListener('click', () => {
    const thesis = $('thesis-input').value.trim();
    if (!thesis) {
      alert('請填寫論點才能送出（一句話：為什麼是現在、為什麼是這個方向？）');
      return;
    }
    closeModal($('thesis-modal'));
    queueMarketOrder({ ...state.pendingMarketOrder, thesis });
    state.pendingMarketOrder = null;
  });

  // 播放中按「下一天」= 先暫停再推一天（規格第 5 點），不是疊加推進。
  $('advance-day-btn').addEventListener('click', () => {
    if (isAutoplaying()) stopAutoplay();
    handleAdvanceDay();
  });
  $('autoplay-toggle-btn').addEventListener('click', toggleAutoplay);
  $('autoplay-rate-select').addEventListener('change', changeAutoplayRate);
  $('priceline-add-btn').addEventListener('click', handleAddPriceLine);
  $('end-run-btn').addEventListener('click', () => {
    stopAutoplay();
    if (confirm('確定要結束本局嗎？未跑完的天數不會再產生資料，直接進戰報。')) goToSettlement();
  });

  $('intraday-close').addEventListener('click', () => {
    closeModal($('intraday-modal'));
  });

  $('save-report-btn').addEventListener('click', handleSaveReport);
  $('fsa-change-folder-btn').addEventListener('click', handleChangeFolder);
  // 規格第 4 點：自動存檔模式下按鈕本身在存檔期間被 disabled（見
  // updateNewGameButtonState），這裡另外處理手動模式「還沒存過就想走」的
  // 提醒——兩條規則刻意分開，不是同一個機制的兩種表現。
  $('new-game-btn').addEventListener('click', () => {
    if (!state.reportSaved && !confirm('這局戰報還沒存檔，離開後會遺失。確定要回開局畫面嗎？')) return;
    resetToSetup();
  });
}

async function resumeInfiniteProgress() {
  const saved = localStorage.getItem(INFINITE_SAVE_KEY);
  if (!saved) return;
  try {
    const parsed = JSON.parse(saved);
    state.session = parsed.session;
    state.contradictionsAtStart = parsed.contradictionsAtStart ?? [];
    state.planModified = parsed.planModified ?? false;
    state.level = INFINITE_LEVEL;
    await enterPlayScreen();
    state.chart.setData(state.session.rows.slice(0, state.session.cursor), state.chipsRows);
    // 價位標線還原（coordinator 追加項第 4 點）：enterPlayScreen 剛建的是
    // 全新 chart，先前存的 lines 陣列要逐一補回去。
    for (const price of parsed.priceLines ?? []) state.chart.addPriceLine(price);
    renderPriceLineList();
  } catch (err) {
    console.error(err);
    alert('讀取上次進度失敗，將移除該筆存檔。');
    localStorage.removeItem(INFINITE_SAVE_KEY);
  }
}

async function init() {
  ensureMosaicOptionsUI();
  ensureAutoplayControlsUI();
  ensurePriceLineControlsUI();
  ensurePriceLineListUI();
  ensureSettlementSaveUI();
  initOrderPanel();
  wireStaticHandlers();
  renderPlanFields();
  try {
    const { dailyRows, chipsRows } = await loadCoreData();
    state.dailyRows = dailyRows;
    state.chipsRows = chipsRows;
    renderLevelCards();
  } catch (err) {
    console.error(err);
    $('level-select').innerHTML = `<p class="hint">資料載入失敗：${err.message}（請用 tools/serve.py 啟動靜態伺服器，不要用 file:// 直接開檔案）</p>`;
  }
}

init();
