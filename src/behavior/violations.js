// violations.js — 五類違背的機器全程比對（M4, SPEC.md §3）。
//
// detectViolations(plan, events, context) 是純函數：不吃任何真實時間、不做
// I/O，只 replay 一段「事件流」判斷違背。事件流的形狀刻意貼近 src/margin
// 產生的 ledger 事件（open/close 直接沿用 M3 的欄位），外加幾個
// src/game/session.js 專屬的補充事件類型，好讓這裡的規則邏輯純粹做「比對」
// 而不用重算保證金/權益數學（那些數學屬於 M3 或 game 層，這裡只消費算好的
// 數字）。測試可以完全用手工構造的事件陣列驅動，不需要跑過整個 session。
//
// `context.dailyCloses`（選用，array of {date, close}）：ma_break 停損規則
// 算 N 日均線用的完整收盤價歷史。**刻意不從事件流的 'day_close' 事件累積**
// ——事件流可能因為呼叫端的各種原因缺某幾天的 'day_close'（例如只挑錯誤重
// 現的片段餵測試），若 MA 是靠「目前看過幾個 day_close 事件」累積視窗，缺
// 一天就會讓後面所有 MA 值全部算錯且不會報錯。改成呼叫端直接把完整日線收
// 盤價序列（session 層是直接從 dailyRows 供給，不經過事件流）餵進來，MA 用
// 日期查表，即使事件流本身缺某天的 'day_close'，其餘日子的 MA 值仍然正確
// （只是缺的那天不會觸發「本日」的凹單判定——那是事件流完整性的問題，不是
// 這個函數的責任）。
//
// 事件流支援的型別：
//   {type:'thesis', date, product, thesis}
//     開倉論點（目前保留欄位，供 M7/M8 展示；本模組不用它做判定，論點漂移
//     走 thesis_change，見下）。
//   {type:'open', date, product, side, lots, price, marginUsageRatioAtEntry?}
//     沿用 M3 open() 回傳的 open 事件欄位；marginUsageRatioAtEntry 是
//     game 層在呼叫 margin.open() 前，用當下權益與所需原始保證金另外算好
//     附加上去的欄位（= 這筆開倉後的原始保證金需求 / 開倉當下權益），供
//     「計畫外交易 - 超使用率」判定；沒有這個欄位就跳過該項判定。
//   {type:'close', date, product, lots, price}
//     沿用 M3 close()/openReversal 的 close 事件欄位。任何 close（含部分平
//     倉）都會重置該 product 的凹單旗標（見下）。
//   {type:'intraday', date, knots}
//     當日生成日內細路徑（M2 generateIntraday 的 knots），供「凹單」判定
//     用 fixed_points 停損規則時逐點比對觸價。
//   {type:'day_close', date, close}
//     當日真實日K收盤，觸發：(a) ma_break 停損規則的破線判定（MA 值查
//     context.dailyCloses，不靠事件流累積）；(b) 凹單持續累進的「今天算不
//     算新的一天」節拍（見下）。
//   {type:'overnight_hold', date, product, side, lots, reason}
//     收盤時仍持有的部位；reason 有值代表玩家有填過夜理由。
//   {type:'risk_snapshot', date, equity, peakEquity, drawdownPct, marginUsageRatio}
//     game 層算好的當下回撤（%）與保證金使用率（0-1 比例），逐日附加。
//   {type:'thesis_change', date, product, priceOnly, note?}
//     論點漂移的「記錄介面」——本模組不自動判斷操作是否因價格而非論點改
//     變（SPEC：判定留給複盤），只在呼叫端已經明確標記 priceOnly=true 時
//     才轉成一筆違背；沒有這個顯式標記就不會產生 thesis_drift 違背。
//
// 凹單累進懲罰：第一次觸及停損條件未平記一筆 bag_holding；此後每個交易日
// 收盤（每個 'day_close' 事件）只要部位仍開著、旗標仍在，就再追加一筆
// bag_holding_continued（權重見 score.js VIOLATION_WEIGHTS，比初次輕）——
// 堵死「硬凹過第一刀就免費」：凹越多天，分數扣越多。部位平倉（含部分平倉）
// 立刻重置旗標，之後若價格再度觸及停損條件，視為新的一次 bag_holding（不
// 是 continued）。
//
// 風險失控同樣採「首次全額＋持續遞減」二段式（SPEC.md §3，2026-08-02 首局
// 實玩校準後補上——原本每個 risk_snapshot 都全額扣分，21 天輕微超限直接扣
// 到 0 分，分數失去解析度：同一個超限狀態掛 N 天是一個事件的延續，不是 N
// 個事件）。回撤超計畫與保證金使用率超計畫各自獨立追蹤 episode：同一種超限
// 持續中，第一天記 risk_out_of_control（權重不變），第二天起每天記
// risk_out_of_control_continued（權重較輕）；回到限內該 episode 結束，之後
// 再次超限視為新的一次 risk_out_of_control（不是 continued）。兩種超限互不
// 影響——同一天回撤超計畫又使用率超計畫，各自照自己的 episode 狀態獨立判
// 定，可能同一天各記一筆。
//
// 回傳陣列，每筆違背固定形狀 {type, date, detail, planRef}，type 為八種
// 之一：bag_holding（凹單）／bag_holding_continued（凹單持續）／
// unplanned_trade（計畫外交易）／risk_out_of_control（風險失控）／
// risk_out_of_control_continued（風險失控持續）／thesis_drift（論點漂移）／
// martingale_add（攤平加碼）。

function deriveStopParams(plan) {
  if (plan.stopLossRule === 'fixed_points') {
    return { kind: 'fixed_points', points: plan.stopLossParams?.points };
  }
  if (plan.stopLossRule === 'ma_break') {
    return { kind: 'ma_break', n: plan.stopLossParams?.n };
  }
  return null; // thesis_invalid / none: 無法機械判定觸價，不做凹單偵測
}

// 從完整日線收盤價歷史（非事件流）建出「日期 -> N 日均線」查表，只在有滿
// N 天歷史（含當天）的日期才有值。
function buildMASeries(dailyCloses, n) {
  const ma = new Map();
  if (!Array.isArray(dailyCloses) || !Number.isInteger(n) || n <= 0) return ma;
  const sorted = [...dailyCloses].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (let i = 0; i < sorted.length; i++) {
    if (i + 1 < n) continue;
    const window = sorted.slice(i + 1 - n, i + 1);
    const avg = window.reduce((s, r) => s + r.close, 0) / n;
    ma.set(sorted[i].date, avg);
  }
  return ma;
}

function mergeEntry(prior, ev) {
  if (prior && prior.side === ev.side) {
    const combinedLots = prior.lots + ev.lots;
    const entryPrice = (prior.entryPrice * prior.lots + ev.price * ev.lots) / combinedLots;
    return { side: ev.side, lots: combinedLots, entryPrice, date: ev.date };
  }
  return { side: ev.side, lots: ev.lots, entryPrice: ev.price, date: ev.date };
}

export function detectViolations(plan, events, context = {}) {
  const violations = [];
  const positions = new Map(); // product -> {side, lots, entryPrice, date}
  const episodes = new Map(); // product -> {startDate} — active bag-holding episode
  const stopParams = deriveStopParams(plan);
  const maSeries = stopParams?.kind === 'ma_break' ? buildMASeries(context.dailyCloses, stopParams.n) : null;

  // 風險失控二段式的兩個獨立 episode 狀態（帳戶層級，不分 product）：
  // 回撤超計畫、保證金使用率超計畫各自一個，null = 目前不在超限狀態。
  let drawdownEpisode = null; // {startDate} | null
  let marginUsageEpisode = null; // {startDate} | null

  function flagEpisode(product, date, detail) {
    violations.push({ type: 'bag_holding', date, detail, planRef: 'stopLossRule' });
    episodes.set(product, { startDate: date });
  }

  for (const ev of events) {
    switch (ev.type) {
      case 'open': {
        const prior = positions.get(ev.product);

        // 攤平加碼：同方向加碼，且加碼價格比既有均價更差（逆勢），計畫又
        // 不是「逆勢攤平」時記一筆違背。
        if (prior && prior.side === ev.side) {
          const adverse = prior.side === 1 ? ev.price < prior.entryPrice : ev.price > prior.entryPrice;
          if (adverse && plan.addRule !== 'martingale_add') {
            violations.push({
              type: 'martingale_add',
              date: ev.date,
              detail: `${ev.product} 逆勢加碼於 ${ev.price}（既有均價 ${prior.entryPrice}），計畫加碼規則=${plan.addRule}`,
              planRef: 'addRule',
            });
          }
        }

        // 計畫外交易：開倉當下保證金使用率超過計畫上限。
        if (
          typeof ev.marginUsageRatioAtEntry === 'number' &&
          plan.marginUsageCap !== 'unlimited' &&
          ev.marginUsageRatioAtEntry * 100 > plan.marginUsageCap
        ) {
          violations.push({
            type: 'unplanned_trade',
            date: ev.date,
            detail: `${ev.product} 開倉當下保證金使用率 ${(ev.marginUsageRatioAtEntry * 100).toFixed(1)}% 超過計畫上限 ${plan.marginUsageCap}%`,
            planRef: 'marginUsageCap',
          });
        }

        positions.set(ev.product, mergeEntry(prior, ev));
        episodes.delete(ev.product);
        break;
      }

      case 'close': {
        const prior = positions.get(ev.product);
        if (prior) {
          const remaining = prior.lots - ev.lots;
          if (remaining > 0) positions.set(ev.product, { ...prior, lots: remaining });
          else positions.delete(ev.product);
        }
        // Fix 1：任何平倉（含部分平倉）都重置凹單旗標，讓剩餘部位（或未來
        // 重新進場的部位）在下一次觸及停損條件時，被當成新的一次
        // bag_holding，而不是被舊旗標永久壓住不再計分。
        episodes.delete(ev.product);
        break;
      }

      case 'intraday': {
        if (stopParams?.kind === 'fixed_points' && typeof stopParams.points === 'number') {
          for (const [product, pos] of positions) {
            if (episodes.has(product)) continue; // 已有進行中的episode，續記交給 day_close
            const stopPrice = pos.entryPrice - pos.side * stopParams.points;
            const touched = pos.side === 1
              ? ev.knots.some((k) => k <= stopPrice)
              : ev.knots.some((k) => k >= stopPrice);
            if (touched) {
              flagEpisode(product, ev.date, `${product} 觸及計畫停損價 ${stopPrice}（entry=${pos.entryPrice}）仍未平倉`);
            }
          }
        }
        break;
      }

      case 'day_close': {
        if (maSeries) {
          const ma = maSeries.get(ev.date);
          if (typeof ma === 'number') {
            for (const [product, pos] of positions) {
              if (episodes.has(product)) continue; // 已有進行中的episode，續記交給下面的累進迴圈
              const broke = pos.side === 1 ? ev.close < ma : ev.close > ma;
              if (broke) {
                flagEpisode(product, ev.date, `${product} 收盤 ${ev.close} 跌破 ${stopParams.n} 日均線 ${ma.toFixed(1)} 仍未平倉`);
              }
            }
          }
        }

        // 凹單持續累進：對每個「進行中的 episode」（不論是 fixed_points 靠
        // 上面的 intraday 觸發、還是 ma_break 靠這裡剛觸發），只要不是今天
        // 才開始（startDate !== 今天）且部位仍持有，這個 day_close 就代表
        // 「又一個交易日收盤仍未執行停損」，追加一筆 bag_holding_continued。
        for (const [product, episode] of episodes) {
          if (episode.startDate === ev.date) continue; // 觸發當天已經算過 bag_holding，不重複計
          if (!positions.has(product)) continue; // 防呆：理論上 close 已經清掉 episode
          violations.push({
            type: 'bag_holding_continued',
            date: ev.date,
            detail: `${product} 觸及計畫停損後持續未平倉（自 ${episode.startDate} 起累計）`,
            planRef: 'stopLossRule',
          });
        }
        break;
      }

      case 'overnight_hold': {
        if (plan.overnight === 'day_trade_mainly' && !ev.reason) {
          violations.push({
            type: 'unplanned_trade',
            date: ev.date,
            detail: `${ev.product} 無理由過夜（計畫=當日沖銷為主）`,
            planRef: 'overnight',
          });
        }
        break;
      }

      case 'risk_snapshot': {
        const drawdownBreach = plan.maxDrawdown !== 'unlimited' && ev.drawdownPct > plan.maxDrawdown;
        if (drawdownBreach) {
          if (drawdownEpisode) {
            violations.push({
              type: 'risk_out_of_control_continued',
              date: ev.date,
              detail: `回撤 ${ev.drawdownPct.toFixed(1)}% 持續超過計畫上限 ${plan.maxDrawdown}%（自 ${drawdownEpisode.startDate} 起）`,
              planRef: 'maxDrawdown',
            });
          } else {
            violations.push({
              type: 'risk_out_of_control',
              date: ev.date,
              detail: `回撤 ${ev.drawdownPct.toFixed(1)}% 超過計畫上限 ${plan.maxDrawdown}%`,
              planRef: 'maxDrawdown',
            });
            drawdownEpisode = { startDate: ev.date };
          }
        } else {
          drawdownEpisode = null; // 回到限內，episode 結束
        }

        const marginUsageBreach = plan.marginUsageCap !== 'unlimited' && ev.marginUsageRatio * 100 > plan.marginUsageCap;
        if (marginUsageBreach) {
          if (marginUsageEpisode) {
            violations.push({
              type: 'risk_out_of_control_continued',
              date: ev.date,
              detail: `保證金使用率 ${(ev.marginUsageRatio * 100).toFixed(1)}% 持續超過計畫上限 ${plan.marginUsageCap}%（自 ${marginUsageEpisode.startDate} 起）`,
              planRef: 'marginUsageCap',
            });
          } else {
            violations.push({
              type: 'risk_out_of_control',
              date: ev.date,
              detail: `保證金使用率 ${(ev.marginUsageRatio * 100).toFixed(1)}% 超過計畫上限 ${plan.marginUsageCap}%`,
              planRef: 'marginUsageCap',
            });
            marginUsageEpisode = { startDate: ev.date };
          }
        } else {
          marginUsageEpisode = null; // 回到限內，episode 結束
        }
        break;
      }

      case 'thesis_change': {
        if (ev.priceOnly) {
          violations.push({
            type: 'thesis_drift',
            date: ev.date,
            detail: `${ev.product} 因價格而非論點改變操作方向${ev.note ? `（${ev.note}）` : ''}`,
            planRef: 'thesis',
          });
        }
        break;
      }

      default:
        break;
    }
  }

  return violations;
}
