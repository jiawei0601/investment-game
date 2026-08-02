// chart.js — lightweight-charts wrapper for M5 UI (SPEC.md §7, docs/backlog/M5-ui.md).
//
// Vendored file: vendor/lightweight-charts.4.1.3.standalone.production.mjs
// (official TradingView "standalone" ESM build — no build step, imported
// directly with <script type="module">; see vendor/README.md).
//
// This module is display-only: it never decides anything about trades or
// touch prices, it only renders rows/knots the game session already
// produced. Daily-chart `time` values are plain 'YYYY-MM-DD' strings (the
// same date strings data/daily/TX.json uses) — lightweight-charts parses
// that format natively as a business day, so no timezone math is needed
// here for the daily/settlement charts. The intraday modal chart (5-minute
// bars within one trading day) DOES need real increasing timestamps for its
// time axis; see buildIntradayTimestamps below for that one exception.

import { createChart, CrosshairMode, LineStyle } from '../../vendor/lightweight-charts.4.1.3.standalone.production.mjs';

// 水平價位線標記（純 UI 註記，coordinator 追加項）：單一強調色虛線＋價位
// 標籤，用 lightweight-charts 原生 series.createPriceLine，不自製繪圖層。
const PRICE_LINE_COLOR = '#f4b942';
const PRICE_LINE_MAX = 20;

const CHART_BASE_OPTIONS = {
  layout: {
    background: { color: 'transparent' },
    textColor: '#9fb0c3',
    fontFamily: 'SFMono-Regular, Consolas, monospace',
  },
  grid: {
    vertLines: { color: '#1f2937' },
    horzLines: { color: '#1f2937' },
  },
  crosshair: { mode: CrosshairMode.Normal },
  rightPriceScale: { borderColor: '#2a3444' },
  timeScale: { borderColor: '#2a3444', timeVisible: false },
};

// lightweight-charts normalizes a 'YYYY-MM-DD' time input into a
// {year,month,day} BusinessDay object on the way back out (click/crosshair
// callbacks) — this turns either shape back into the canonical date string
// our data/session events use everywhere else.
export function timeToDateStr(time) {
  if (typeof time === 'string') return time;
  if (time && typeof time === 'object' && 'year' in time) {
    const mm = String(time.month).padStart(2, '0');
    const dd = String(time.day).padStart(2, '0');
    return `${time.year}-${mm}-${dd}`;
  }
  return null;
}

// Main daily chart: candlesticks (top ~70%) + volume histogram (overlay
// price scale, bottom strip) + optional 三大法人籌碼淨額 histogram (bottom
// strip below volume, only meaningful once chips data starts 2018-06-05 —
// SPEC §5 "2018-06 後有資料才顯示").
export function createDailyChart(container) {
  const chart = createChart(container, {
    ...CHART_BASE_OPTIONS,
    width: container.clientWidth,
    height: container.clientHeight || 520,
  });

  const candleSeries = chart.addCandlestickSeries({
    upColor: '#26c281',
    downColor: '#ef5350',
    borderVisible: false,
    wickUpColor: '#26c281',
    wickDownColor: '#ef5350',
  });
  candleSeries.priceScale().applyOptions({ scaleMargins: { top: 0.05, bottom: 0.35 } });

  const volumeSeries = chart.addHistogramSeries({
    priceScaleId: 'volume',
    color: '#3b9eff',
    priceFormat: { type: 'volume' },
  });
  volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.72, bottom: 0.18 } });

  // SMA20 參照線（使用者需求 2026-08-02）：純顯示，不進任何判定。
  // closes 由 setData/appendDay 維護，於 >=20 根時輸出均值點。
  const smaSeries = chart.addLineSeries({
    color: '#c58af9',
    lineWidth: 1,
    priceLineVisible: false,
    lastValueVisible: true,
    title: 'SMA20',
  });
  let smaCloses = [];
  const smaAt = () => smaCloses.slice(-20).reduce((a, b) => a + b, 0) / 20;

  const chipsSeries = chart.addHistogramSeries({
    priceScaleId: 'chips',
    color: '#f4b942',
    priceFormat: { type: 'volume' },
  });
  chipsSeries.priceScale().applyOptions({ scaleMargins: { top: 0.9, bottom: 0 } });
  chipsSeries.applyOptions({ visible: false });

  function resize() {
    chart.applyOptions({ width: container.clientWidth, height: container.clientHeight || 520 });
  }
  window.addEventListener('resize', resize);

  // id -> {price, handle}. Purely a display-side registry — never touches
  // session/events/report (coordinator: 純 UI 註記，不進遊戲邏輯任何路徑).
  const priceLines = new Map();
  let nextPriceLineId = 1;

  return {
    chart,
    candleSeries,
    volumeSeries,
    chipsSeries,
    resize,
    onDayClick(handler) {
      chart.subscribeClick((param) => {
        const dateStr = timeToDateStr(param.time);
        if (dateStr) handler(dateStr);
      });
    },
    // 點擊圖表任一處回報該處價格（僅回報，不建線——由呼叫端決定要不要填進
    // 輸入框，避免誤觸就直接畫線）。param.point 在點到時間軸/價格軸之外的
    // 區域時可能是 undefined，這種情況不回呼。
    onPriceClick(handler) {
      chart.subscribeClick((param) => {
        if (!param.point) return;
        const price = candleSeries.coordinateToPrice(param.point.y);
        if (price !== null) handler(price);
      });
    },
    // 加一條水平價位線，回傳一個穩定 id 供之後 removePriceLine 用。上限 20
    // 條（防手滑灌爆，coordinator 規格）；超過回傳 null，呼叫端自行決定要
    //不要提示使用者。
    addPriceLine(price) {
      if (priceLines.size >= PRICE_LINE_MAX) return null;
      const handle = candleSeries.createPriceLine({
        price,
        color: PRICE_LINE_COLOR,
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: String(Math.round(price)),
      });
      const id = nextPriceLineId++;
      priceLines.set(id, { price, handle });
      return id;
    },
    removePriceLine(id) {
      const entry = priceLines.get(id);
      if (!entry) return;
      candleSeries.removePriceLine(entry.handle);
      priceLines.delete(id);
    },
    listPriceLines() {
      return [...priceLines.entries()].map(([id, { price }]) => ({ id, price }));
    },
    // rows: array of {date,open,high,low,close,volume}; chipsRows: array of
    // {date,dealer_net,it_net,fini_net} (may be shorter or start later).
    setData(rows, chipsRows) {
      candleSeries.setData(rows.map((r) => ({ time: r.date, open: r.open, high: r.high, low: r.low, close: r.close })));
      volumeSeries.setData(
        rows.map((r) => ({ time: r.date, value: r.volume, color: r.close >= r.open ? 'rgba(38,194,129,.5)' : 'rgba(239,83,80,.5)' }))
      );
      smaCloses = rows.map((r) => r.close);
      const smaPoints = [];
      for (let i = 19; i < rows.length; i++) {
        let s = 0;
        for (let j = i - 19; j <= i; j++) s += rows[j].close;
        smaPoints.push({ time: rows[i].date, value: s / 20 });
      }
      smaSeries.setData(smaPoints);
      const chipsByDate = new Map(chipsRows.map((r) => [r.date, r]));
      const chipsPoints = rows
        .filter((r) => chipsByDate.has(r.date))
        .map((r) => {
          const c = chipsByDate.get(r.date);
          const net = c.dealer_net + c.it_net + c.fini_net;
          return { time: r.date, value: net, color: net >= 0 ? '#26c281' : '#ef5350' };
        });
      if (chipsPoints.length > 0) {
        chipsSeries.setData(chipsPoints);
        chipsSeries.applyOptions({ visible: true });
        candleSeries.priceScale().applyOptions({ scaleMargins: { top: 0.05, bottom: 0.42 } });
        volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.62, bottom: 0.2 } });
      } else {
        chipsSeries.setData([]);
        chipsSeries.applyOptions({ visible: false });
        candleSeries.priceScale().applyOptions({ scaleMargins: { top: 0.05, bottom: 0.35 } });
        volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.72, bottom: 0.18 } });
      }
      chart.timeScale().fitContent();
    },
    appendDay(row, chipsRow) {
      candleSeries.update({ time: row.date, open: row.open, high: row.high, low: row.low, close: row.close });
      smaCloses.push(row.close);
      if (smaCloses.length >= 20) smaSeries.update({ time: row.date, value: smaAt() });
      volumeSeries.update({ time: row.date, value: row.volume, color: row.close >= row.open ? 'rgba(38,194,129,.5)' : 'rgba(239,83,80,.5)' });
      if (chipsRow) {
        const net = chipsRow.dealer_net + chipsRow.it_net + chipsRow.fini_net;
        chipsSeries.applyOptions({ visible: true });
        chipsSeries.update({ time: row.date, value: net, color: net >= 0 ? '#26c281' : '#ef5350' });
      }
    },
    destroy() {
      window.removeEventListener('resize', resize);
      chart.remove();
    },
  };
}

// Intraday replay chart (modal, M2's 60 five-minute bars). Real synthetic
// UTC timestamps are used purely as an axis-label trick: the trading
// session is 08:45-13:45 Taiwan wall-clock time, and we feed those exact
// hour/minute digits into Date.UTC so the chart's default UTC label
// formatting prints "08:45..13:45" without needing a timezone-aware
// localization callback. This has no bearing on judgment/settlement — it is
// purely how the modal's x-axis is drawn.
const SESSION_START_MINUTES = 8 * 60 + 45; // 08:45
const BAR_MINUTES = 5;

function barTimestamp(dateStr, barIndex) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const minutes = SESSION_START_MINUTES + barIndex * BAR_MINUTES;
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return Math.floor(Date.UTC(y, m - 1, d, hh, mm) / 1000);
}

export function createIntradayChart(container) {
  const chart = createChart(container, {
    ...CHART_BASE_OPTIONS,
    width: container.clientWidth,
    height: container.clientHeight || 380,
    timeScale: { ...CHART_BASE_OPTIONS.timeScale, timeVisible: true, secondsVisible: false },
  });
  const candleSeries = chart.addCandlestickSeries({
    upColor: '#26c281',
    downColor: '#ef5350',
    borderVisible: false,
    wickUpColor: '#26c281',
    wickDownColor: '#ef5350',
  });

  function resize() {
    chart.applyOptions({ width: container.clientWidth, height: container.clientHeight || 380 });
  }
  window.addEventListener('resize', resize);

  return {
    chart,
    candleSeries,
    // bars: M2 generateIntraday()'s `bars` array ({t,o,h,l,c}[60]).
    setBars(dateStr, bars) {
      candleSeries.setData(
        bars.map((b) => ({ time: barTimestamp(dateStr, b.t), open: b.o, high: b.h, low: b.l, close: b.c }))
      );
      chart.timeScale().fitContent();
    },
    destroy() {
      window.removeEventListener('resize', resize);
      chart.remove();
    },
  };
}

// Settlement-screen equity curve: a plain line series built from the
// session's own 'risk_snapshot' events (already-computed equity numbers —
// this module does no equity math itself).
export function createEquityChart(container) {
  const chart = createChart(container, {
    ...CHART_BASE_OPTIONS,
    width: container.clientWidth,
    height: container.clientHeight || 200,
  });
  const lineSeries = chart.addLineSeries({ color: '#3b9eff', lineWidth: 2 });

  return {
    chart,
    setData(riskSnapshots) {
      lineSeries.setData(riskSnapshots.map((s) => ({ time: s.date, value: s.equity })));
      chart.timeScale().fitContent();
    },
    destroy() {
      chart.remove();
    },
  };
}
