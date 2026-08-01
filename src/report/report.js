// report.js — M7 戰報產生器（SPEC.md §6, docs/backlog/M7-battle-report-and-profile.md）。
//
// buildReport(session, options) → string（完整 markdown 戰報，8 個固定區塊）。
// **純函數、無 I/O**：只讀 session/options，不寫檔、不呼叫 Date.now()/
// Math.random()、不改動輸入。檔案寫入（reports/*.md）由 M5 用 File System
// Access API 做；本模組只負責產生文字內容。
//
// ---------------------------------------------------------------------------
// 戰報 schema（markdown，固定 8 個 heading，順序固定，供 M8 `/複盤` skill 與
// 任何未來消費者直接解析，不需臆測欄位）：
//
//   ## 1. 標頭
//     關卡（levelId）、第幾次玩（attempt）、區間（startDate ~ 實際跑到的最
//     後一天）、起始資金、最終權益、報酬率（僅作事實陳述一行，不參與行為
//     分——ADR 0003）。起始資金是從 session.events 的現金增減量反推回去的
//     （tests/game.test.js 的 replayCash 已驗證這條守恆律成立，這裡是它的
//     反向版本），不需要呼叫端額外傳 initialCash。
//
//   ## 2. 開局作戰計畫
//     PLAN_FIELDS 六欄位的中文全文＋矛盾警告＋玩家是否修改計畫。
//     **已知限制（誠實記錄，不是臆測）**：session 目前（M4/M5 尚未補上）不
//     記錄「開局當下」矛盾偵測跑出什麼、玩家改了沒有。本節預設用
//     `detectContradictions(session.plan)` 對「最終送出的計畫」重新跑一次
//     矛盾偵測，並在標題註明這是「戰報產生時重新偵測」而非「開局當時」。
//     若呼叫端（M5）之後把這段歷史接進來，可透過
//     `options.contradictionsAtStart`（陣列，detectContradictions() 同形狀）
//     與 `options.planModified`（boolean）覆寫，本節會自動改標「開局當時」。
//
//   ## 3. 逐筆交易時間軸
//     每筆 open/close/rollover/force_liquidation/margin_call_enforcement 一
//     列：日期、商品、動作、口數、價格、損益、論點（開倉當下的 thesis 事
//     件文字）、違背標記（該筆若與某違背同一天同一商品，行內標
//     `⚠ <違背類型中文>`，可能不只一種）。停損/限價觸發的平倉會被
//     'order_filled' 事件重新標成「停損觸發平倉」/「限價觸發平倉」，而不是
//     籠統的「平倉」。追繳砍倉（margin_call_enforcement）只顯示一次（底下
//     配套的原始 'close' 事件不重複列一行）。
//
//   ## 4. 保證金壓力軌跡
//     使用率峰值＋最大回撤、逐日使用率摘要（連續同一使用率區間的天數壓縮
//     成一行區間敘述，見下方「摘要化選擇」）、追繳/強平事件列表（含
//     knotIndex；沒有 knotIndex 的追繳通知——日結算產生的 margin_call——
//     標 knotIndex 欄為 "-"，因為那是收盤後判定，不屬於任何一個 knot）。
//
//   ## 5. 違背統計
//     VIOLATION_WEIGHTS 六個 key（五類＋凹單持續累進）逐項次數、單次扣分、
//     小計扣分。
//
//   ## 6. 行為分
//     本局最終分數＋逐筆違背明細表（日期／類型／內容，內容沿用
//     violations.js 產生的 detail 文字）。
//
//   ## 7. 歷次對照
//     options.profileHistory（陣列，形狀＝ src/behavior/profile.js 的
//     profile.sessions 元素：{levelId, attempt, startDate, endDate, score,
//     counts}）＋本局自身組成的當前一筆，依序列出行為分曲線與各違背類型
//     次數演變；並標出「連續 N 局都沒改掉」的違背類型（N =
//     REPEATED_VIOLATION_WINDOW，目前 3——某類型在最近 N 筆紀錄裡每一筆
//     次數都 > 0，代表這 N 局都沒把它歸零）。歷史筆數不足 N 時明確標示資料
//     不足，不臆測。
//
//   ## 8. 複盤指引
//     固定文字：說明此檔供 Claude Code `/複盤` skill 使用，預設三位大師
//     （Livermore／OPMAN／謝孟恭，SPEC.md §6）。
//
// 摘要化選擇（格式要求：長事件流要摘要化，並文件化選擇）：
//   - 保證金使用率軌跡：逐日 risk_snapshot 用四捨五入到 10% 的區間做
//     run-length 壓縮（例如連續 5 天都落在「使用率約 30%」區間 → 一行
//     「2020-03-02 ~ 2020-03-06（5 天）：使用率約 30%」），任何有追繳/強平
//     事件的日子強制切成獨立一行並在後面的事件表列出細節，不會被壓進區間。
//   - 完整原始事件流（session.events）本身**不**內嵌進戰報 —— 本模組是純
//     函數、不做 I/O，呼叫端本來就持有完整的 session 物件，需要原始事件流
//     直接讀 session.events 即可，把它整包塞進 markdown 只會製造一份沒人會
//     去讀的重複資料。

import { PLAN_FIELDS, detectContradictions, getTemplate, VIOLATION_WEIGHTS } from '../behavior/index.js';
import { equityOf } from '../margin/index.js';

const REPEATED_VIOLATION_WINDOW = 3;

const VIOLATION_LABELS = Object.freeze({
  bag_holding: '凹單',
  bag_holding_continued: '凹單持續',
  unplanned_trade: '計畫外交易',
  risk_out_of_control: '風險失控',
  thesis_drift: '論點漂移',
  martingale_add: '攤平加碼',
});

const PRODUCT_NAMES = Object.freeze({ TX: '大台 TX', MTX: '小台 MTX', TMF: '微台 TMF' });

function fmt(n) {
  if (!Number.isFinite(n)) return String(n);
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

// 起始資金反推：鏡射 tests/game.test.js 的 replayCash() 現金增減規則，用
// session.account.cash（現在的現金）減掉整段事件流造成的淨增減量。
function cashDelta(ev) {
  switch (ev.type) {
    case 'open':
      return -(ev.fee + ev.tax);
    case 'close':
    case 'force_liquidation':
      return ev.realizedPL - ev.fee - ev.tax;
    case 'rollover':
      return ev.realizedPL - ev.cost;
    case 'deposit':
      return ev.amount;
    case 'withdraw':
      return -ev.amount;
    case 'shock':
      return -ev.amount;
    default:
      return 0;
  }
}

function deriveInitialCash(session) {
  const totalDelta = session.events.reduce((sum, ev) => sum + cashDelta(ev), 0);
  return session.account.cash - totalDelta;
}

function fieldLabel(field, value) {
  const opt = PLAN_FIELDS[field]?.options.find((o) => o.value === value);
  return opt ? opt.label : String(value);
}

// --------------------------------------------------------------------- 1
function buildHeaderSection(session) {
  const initialCash = deriveInitialCash(session);
  const startDate = session.rows[0].date;
  const lastRow = session.rows[Math.max(0, session.cursor - 1)] ?? session.rows[0];
  const finalEquity = equityOf(session.account, session.lastSettlePrice);
  const returnPct = initialCash !== 0 ? ((finalEquity - initialCash) / initialCash) * 100 : 0;

  return [
    '## 1. 標頭',
    '',
    `- 關卡：${session.levelId}`,
    `- 第幾次玩：第 ${session.attempt} 次`,
    `- 區間：${startDate} ~ ${lastRow.date}${session.finished ? '' : '（尚未結算完畢，統計至目前進度）'}`,
    `- 起始資金：NT$ ${fmt(initialCash)}`,
    `- 最終權益：NT$ ${fmt(finalEquity)}`,
    `- 報酬（僅作事實陳述，不計入行為分，見第 6 節）：${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(2)}%`,
    '',
  ].join('\n');
}

// --------------------------------------------------------------------- 2
function buildPlanSection(session, options) {
  const plan = session.plan;
  const lines = ['## 2. 開局作戰計畫', ''];

  for (const field of Object.keys(PLAN_FIELDS)) {
    lines.push(`- ${PLAN_FIELDS[field].label}：${fieldLabel(field, plan[field])}`);
  }
  if (plan.stopLossRule === 'fixed_points' && plan.stopLossParams?.points) {
    lines.push(`  - 固定點數：${plan.stopLossParams.points} 點`);
  }
  if (plan.stopLossRule === 'ma_break' && plan.stopLossParams?.n) {
    lines.push(`  - 均線天數：${plan.stopLossParams.n} 日`);
  }
  lines.push('');

  const usingProvidedHistory = Array.isArray(options.contradictionsAtStart);
  const contradictions = usingProvidedHistory ? options.contradictionsAtStart : detectContradictions(plan);
  lines.push(
    `**矛盾警告**${usingProvidedHistory ? '（開局當時偵測到的版本）' : '（戰報產生時對最終計畫重新偵測——session 未記錄開局當下版本）'}：`
  );
  if (contradictions.length === 0) {
    lines.push('- 無（零摩擦直接開局，或已修正至無矛盾）');
  } else {
    for (const c of contradictions) {
      const quote = getTemplate(c.templateKey).opman[0];
      lines.push(`- ⚠ ${c.reason}（${quote}）`);
    }
  }
  lines.push('');

  const planModified =
    typeof options.planModified === 'boolean'
      ? options.planModified
        ? '是'
        : '否'
      : '未知（session 未提供此欄位，待 M5 補上開局計畫修改歷史後可傳入 options.planModified）';
  lines.push(`**玩家是否修改計畫**：${planModified}`);
  lines.push('');
  return lines.join('\n');
}

// --------------------------------------------------------------------- 3
function extractProductFromDetail(detail) {
  const m = /^(TX|MTX|TMF)\s/.exec(detail || '');
  return m ? m[1] : null;
}

function buildViolationIndex(violations) {
  const map = new Map(); // `${date}|${product}` -> [violation, ...]
  for (const v of violations) {
    const product = extractProductFromDetail(v.detail);
    if (!product) continue;
    const key = `${v.date}|${product}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(v);
  }
  return map;
}

function buildTradesSection(session) {
  const violationIndex = buildViolationIndex(session.violations);
  const pendingThesis = new Map(); // product -> thesis text, set by 'thesis', consumed by next 'open'
  const rows = [];

  for (const ev of session.events) {
    if (ev.type === 'thesis') {
      pendingThesis.set(ev.product, ev.thesis);
    } else if (ev.type === 'open') {
      const thesis = pendingThesis.get(ev.product) ?? '';
      pendingThesis.delete(ev.product);
      rows.push({
        date: ev.date,
        product: ev.product,
        action: `開倉 ${ev.side === 1 ? '多' : '空'}`,
        lots: ev.lots,
        price: ev.price,
        thesis,
      });
    } else if (ev.type === 'close') {
      // knotIndex === -1 是追繳砍倉 (enforceMarginCall) 產生的配套 close 事
      // 件——那一筆已經由下面的 'margin_call_enforcement' 標記事件代表，這
      // 裡跳過避免同一個動作重複列兩行。
      if (ev.knotIndex === -1) continue;
      rows.push({ date: ev.date, product: ev.product, action: '平倉', lots: ev.lots, price: ev.price, realizedPL: ev.realizedPL });
    } else if (ev.type === 'order_filled') {
      const label = ev.orderKind === 'stop' ? '停損觸發平倉' : ev.orderKind === 'limit' ? '限價觸發平倉' : null;
      if (!label) continue;
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i];
        if (r.date === ev.date && r.product === ev.product && r.action === '平倉' && r.lots === ev.lots && r.price === ev.price) {
          r.action = label;
          break;
        }
      }
    } else if (ev.type === 'rollover') {
      rows.push({ date: ev.date, product: ev.product, action: '轉倉', lots: ev.lots, price: ev.newEntryPrice, realizedPL: ev.realizedPL });
    } else if (ev.type === 'force_liquidation') {
      rows.push({ date: ev.date, product: ev.product, action: '盤中強制平倉', lots: ev.lots, price: ev.price, realizedPL: ev.realizedPL });
    } else if (ev.type === 'margin_call_enforcement') {
      rows.push({ date: ev.date, product: ev.product, action: '追繳砍倉', lots: ev.lots, price: ev.price, realizedPL: ev.realizedPL });
    }
  }

  const lines = ['## 3. 逐筆交易時間軸', ''];
  if (rows.length === 0) {
    lines.push('（本局無任何交易）', '');
    return lines.join('\n');
  }
  lines.push('| 日期 | 商品 | 動作 | 口數 | 價格 | 損益 | 論點 | 違背 |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const vs = violationIndex.get(`${r.date}|${r.product}`) ?? [];
    const warn = vs.length ? `⚠ ${vs.map((v) => VIOLATION_LABELS[v.type] ?? v.type).join('、')}` : '';
    const pl = typeof r.realizedPL === 'number' ? fmt(r.realizedPL) : '';
    lines.push(
      `| ${r.date} | ${PRODUCT_NAMES[r.product] ?? r.product} | ${r.action} | ${r.lots} | ${fmt(r.price)} | ${pl} | ${r.thesis || ''} | ${warn} |`
    );
  }
  lines.push('');
  return lines.join('\n');
}

// --------------------------------------------------------------------- 4
function usageBucket(ratio) {
  if (!Number.isFinite(ratio)) return '∞（權益歸零或轉負）';
  return `${Math.round(ratio * 10) * 10}%`;
}

function summarizeDailyUsage(daily, eventDays) {
  const lines = [];
  let i = 0;
  while (i < daily.length) {
    const d = daily[i];
    if (eventDays.has(d.date)) {
      lines.push(`- ${d.date}：使用率約 ${usageBucket(d.marginUsageRatio)}（當日有追繳／強平事件，見下表）`);
      i += 1;
      continue;
    }
    const bucket = usageBucket(d.marginUsageRatio);
    let j = i + 1;
    while (j < daily.length && !eventDays.has(daily[j].date) && usageBucket(daily[j].marginUsageRatio) === bucket) {
      j += 1;
    }
    if (j - i === 1) {
      lines.push(`- ${d.date}：使用率約 ${bucket}`);
    } else {
      lines.push(`- ${d.date} ~ ${daily[j - 1].date}（${j - i} 天）：使用率約 ${bucket}`);
    }
    i = j;
  }
  return lines.join('\n');
}

function buildMarginSection(session) {
  const daily = session.events.filter((e) => e.type === 'risk_snapshot');
  const marginCalls = session.events.filter((e) => e.type === 'margin_call');
  const liquidations = session.events.filter((e) => e.type === 'force_liquidation');
  const enforcements = session.events.filter((e) => e.type === 'margin_call_enforcement');

  const lines = ['## 4. 保證金壓力軌跡', ''];
  if (daily.length === 0) {
    lines.push('（本局尚無風險快照資料）', '');
    return lines.join('\n');
  }

  let peak = daily[0];
  for (const d of daily) {
    if (!(d.marginUsageRatio <= peak.marginUsageRatio)) peak = d; // Infinity 也會贏過任何有限值
  }
  const peakDisplay = Number.isFinite(peak.marginUsageRatio)
    ? `${(peak.marginUsageRatio * 100).toFixed(1)}%`
    : '∞（權益歸零或轉負，見下方追繳/強平事件）';
  const maxDrawdown = Math.max(...daily.map((d) => d.drawdownPct));

  lines.push(`- 保證金使用率峰值：${peakDisplay}（${peak.date}）`);
  lines.push(`- 最大回撤：${maxDrawdown.toFixed(1)}%`);
  lines.push('');

  const eventDays = new Set([...marginCalls, ...liquidations, ...enforcements].map((e) => e.date));
  lines.push('### 使用率逐日摘要', '', summarizeDailyUsage(daily, eventDays), '');

  lines.push('### 追繳與強平事件', '');
  if (marginCalls.length === 0 && liquidations.length === 0 && enforcements.length === 0) {
    lines.push('（本局無追繳或強平事件）', '');
  } else {
    lines.push('| 日期 | knotIndex | 類型 | 內容 |');
    lines.push('|---|---|---|---|');
    for (const e of marginCalls) {
      lines.push(`| ${e.date} | - | 追繳通知 | 權益 ${fmt(e.equity)}，需補足 ${fmt(e.requiredTopUp)} |`);
    }
    for (const e of enforcements) {
      lines.push(`| ${e.date} | ${e.knotIndex} | 追繳砍倉 | ${e.product} ${e.lots} 口 @ ${fmt(e.price)}，實現損益 ${fmt(e.realizedPL)} |`);
    }
    for (const e of liquidations) {
      const reason = e.reason === 'profit_realization' ? '獲利回補現金缺口' : '虧損砍倉';
      lines.push(`| ${e.date} | ${e.knotIndex} | 盤中強制平倉 | ${e.product} ${e.lots} 口 @ ${fmt(e.price)}，實現損益 ${fmt(e.realizedPL)}（${reason}） |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// --------------------------------------------------------------------- 5
function buildViolationStatsSection(session) {
  const lines = ['## 5. 違背統計', ''];
  lines.push('| 類型 | 次數 | 單次扣分 | 小計扣分 |');
  lines.push('|---|---|---|---|');
  let totalDeduction = 0;
  for (const type of Object.keys(VIOLATION_WEIGHTS)) {
    const count = session.scoreCounts[type] ?? 0;
    const weight = VIOLATION_WEIGHTS[type];
    const subtotal = count * weight;
    totalDeduction += subtotal;
    lines.push(`| ${VIOLATION_LABELS[type] ?? type} | ${count} | -${weight} | -${subtotal} |`);
  }
  lines.push('');
  lines.push(`合計扣分：-${totalDeduction}（起始 100 分，下限 0 分，見第 6 節）`);
  lines.push('');
  return lines.join('\n');
}

// --------------------------------------------------------------------- 6
function buildScoreSection(session) {
  const lines = ['## 6. 行為分', ''];
  lines.push(`本局行為分：**${session.score} / 100**`);
  lines.push('');
  lines.push('逐筆違背明細：');
  lines.push('');
  if (session.violations.length === 0) {
    lines.push('（本局無違背紀錄）', '');
  } else {
    lines.push('| 日期 | 類型 | 內容 |');
    lines.push('|---|---|---|');
    for (const v of session.violations) {
      lines.push(`| ${v.date} | ${VIOLATION_LABELS[v.type] ?? v.type} | ${v.detail} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// --------------------------------------------------------------------- 7
function currentHistoryEntry(session) {
  return {
    levelId: session.levelId,
    attempt: session.attempt,
    startDate: session.rows[0].date,
    endDate: (session.rows[Math.max(0, session.cursor - 1)] ?? session.rows[0]).date,
    score: session.score,
    counts: session.scoreCounts,
  };
}

function buildHistorySection(session, profileHistory) {
  const lines = ['## 7. 歷次對照', ''];
  const history = Array.isArray(profileHistory) ? profileHistory : [];
  const points = [...history, currentHistoryEntry(session)];
  const types = Object.keys(VIOLATION_WEIGHTS);

  lines.push('### 行為分曲線', '');
  lines.push('| # | 關卡 | 第幾次玩 | 區間 | 行為分 |');
  lines.push('|---|---|---|---|---|');
  points.forEach((p, i) => {
    const tag = i === points.length - 1 ? '（本局）' : '';
    lines.push(`| ${i + 1} | ${p.levelId} | ${p.attempt} | ${p.startDate} ~ ${p.endDate} | ${p.score}${tag} |`);
  });
  lines.push('');

  lines.push('### 各違背類型次數演變', '');
  lines.push(`| # | ${types.map((t) => VIOLATION_LABELS[t]).join(' | ')} |`);
  lines.push(`|---|${types.map(() => '---').join('|')}|`);
  points.forEach((p, i) => {
    lines.push(`| ${i + 1} | ${types.map((t) => p.counts?.[t] ?? 0).join(' | ')} |`);
  });
  lines.push('');

  lines.push(`### 連續 ${REPEATED_VIOLATION_WINDOW} 局未改善`, '');
  if (points.length < REPEATED_VIOLATION_WINDOW) {
    lines.push(`（資料不足 ${REPEATED_VIOLATION_WINDOW} 局，尚無法判斷）`, '');
  } else {
    const recent = points.slice(-REPEATED_VIOLATION_WINDOW);
    const stuck = types.filter((t) => recent.every((p) => (p.counts?.[t] ?? 0) > 0));
    if (stuck.length === 0) {
      lines.push('（無連續未改善項目）', '');
    } else {
      for (const t of stuck) {
        lines.push(`- ⚠ **${VIOLATION_LABELS[t]}**：最近 ${REPEATED_VIOLATION_WINDOW} 局每一局都出現，尚未改掉`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

// --------------------------------------------------------------------- 8
function buildAppendixSection() {
  return [
    '## 8. 複盤指引',
    '',
    '此戰報供 Claude Code `/複盤` skill 讀取分析，預設召集三位大師視角（SPEC.md §6）：',
    '',
    '- **Livermore**（停損執行／趨勢／加碼紀律）',
    '- **OPMAN**（台指格局判讀／資金控管／凹單放到歸零）',
    '- **謝孟恭**（部位管理／心態／資訊判讀）',
    '',
    '遊戲本體零 AI 依賴；複盤走離線戰報 .md，不在遊戲內呼叫任何 LLM。',
    '',
  ].join('\n');
}

export function buildReport(session, options = {}) {
  const profileHistory = options.profileHistory ?? [];
  return [
    `# 戰報 — ${session.levelId}（第 ${session.attempt} 次）`,
    '',
    buildHeaderSection(session),
    buildPlanSection(session, options),
    buildTradesSection(session),
    buildMarginSection(session),
    buildViolationStatsSection(session),
    buildScoreSection(session),
    buildHistorySection(session, profileHistory),
    buildAppendixSection(),
  ].join('\n');
}
