// score.js — 行為分（D）計算（M4, SPEC.md §3, ADR 0003）。
//
// 100 分起扣，各類違背權重資料驅動（VIOLATION_WEIGHTS），改權重不用碰
// computeScore 本體。**行為分獨立於報酬率**：輸入只有違背清單與計畫，完
// 全不吃任何損益/報酬數字——這是刻意的（ADR 0003：報酬率只當事實陳述，
// 不進評分公式）。

export const VIOLATION_WEIGHTS = Object.freeze({
  bag_holding: 15, // 凹單：核心診斷對象，權重最看重的兩項之一
  bag_holding_continued: 5, // 凹單持續：觸停損未平之後，每個交易日收盤仍未執行停損
  // 再追加一筆（堵死「硬凹過第一刀就免費」——第一天記重的，之後每天再輕輕
  // 扣一次，讓凹越久分越低），部位平掉或旗標重置即停，見 violations.js。
  unplanned_trade: 8, // 計畫外交易：常見但單次殺傷力較低
  risk_out_of_control: 15, // 風險失控：直接違反自己設的安全邊際
  risk_out_of_control_continued: 3, // 風險失控持續：同一超限狀態（回撤或使用
  // 率）持續中的每個後續交易日，比照凹單持續的邏輯輕扣（SPEC §3「首次全額＋
  // 持續遞減」二段式，2026-08-02 首局實玩校準：21 天輕微超限被扣到 0 分，
  // 分數失去解析度，改成這個權重）。
  thesis_drift: 10, // 論點漂移：記錄介面判定寬鬆，權重中等
  martingale_add: 20, // 攤平加碼：SPEC 明點的頭號矛盾行為，權重最高
});

export function computeScore(violations, _plan) {
  const counts = {
    bag_holding: 0,
    bag_holding_continued: 0,
    unplanned_trade: 0,
    risk_out_of_control: 0,
    risk_out_of_control_continued: 0,
    thesis_drift: 0,
    martingale_add: 0,
  };
  let score = 100;
  for (const v of violations) {
    if (!(v.type in counts)) continue; // 未知型別防呆略過，不讓陌生 type 拖垮分數
    counts[v.type] += 1;
    score -= VIOLATION_WEIGHTS[v.type] ?? 0;
  }
  score = Math.max(0, Math.min(100, score));
  return { score, counts };
}
