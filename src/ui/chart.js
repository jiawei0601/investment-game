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

import { createChart, CrosshairMode } from '../../vendor/lightweight-charts.4.1.3.standalone.production.mjs';

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
    // rows: array of {date,open,high,low,close,volume}; chipsRows: array of
    // {date,dealer_net,it_net,fini_net} (may be shorter or start later).
    setData(rows, chipsRows) {
      candleSeries.setData(rows.map((r) => ({ time: r.date, open: r.open, high: r.high, low: r.low, close: r.close })));
      volumeSeries.setData(
        rows.map((r) => ({ time: r.date, value: r.volume, color: r.close >= r.open ? 'rgba(38,194,129,.5)' : 'rgba(239,83,80,.5)' }))
      );
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
