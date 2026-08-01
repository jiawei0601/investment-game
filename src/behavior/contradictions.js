// contradictions.js — 開局作戰計畫矛盾偵測（M4, SPEC.md §3, ADR 0003）。
//
// 純規則實作：不 import 任何 LLM/HTTP client，不做網路呼叫。規則表資料驅
// 動——新增一組矛盾＝在 CONTRADICTION_RULES 加一列，不用改 detectContradictions
// 本身。每條規則附 templateKey，供 templates.js 查出對應的三位大師台詞。
//
// 目前涵蓋 SPEC §3 明列的三組範例：
//   1. 逆勢攤平 + 設回撤上限 → 攤平必然放大回撤，任何非「不設限」的回撤上
//      限都會被攤平動作自我打穿（SPEC 舉例用 10%，這裡對「有設定回撤上限」
//      一視同仁，因為道理不因門檻數字而異）。
//   2. 保證金使用率上限 70%（或不設限，效果等同 ≥70%）+ 設回撤上限 → 一根
//      長黑就打穿。
//   3. 當日沖銷為主 + 停損＝論點失效才走 → 當沖必須有價格停損，論點是否
//      失效無法在收盤前判斷完畢。

export const CONTRADICTION_RULES = Object.freeze([
  {
    id: 'martingale_vs_drawdown_cap',
    templateKey: 'martingale_vs_drawdown_cap',
    fields: ['addRule', 'maxDrawdown'],
    reason: '逆勢攤平會持續放大虧損部位的曝險，任何設定的回撤上限都會被攤平動作自我打穿。',
    test: (plan) => plan.addRule === 'martingale_add' && plan.maxDrawdown !== 'unlimited',
  },
  {
    id: 'high_margin_usage_vs_drawdown_cap',
    templateKey: 'high_margin_usage_vs_drawdown_cap',
    fields: ['marginUsageCap', 'maxDrawdown'],
    reason: '保證金使用率上限拉到 70% 以上時，一根長黑就足以打穿任何回撤上限。',
    test: (plan) =>
      (plan.marginUsageCap === 70 || plan.marginUsageCap === 'unlimited') && plan.maxDrawdown !== 'unlimited',
  },
  {
    id: 'daytrade_vs_thesis_invalid_stop',
    templateKey: 'daytrade_vs_thesis_invalid_stop',
    fields: ['overnight', 'stopLossRule'],
    reason: '當日沖銷為主必須有價格停損，「論點是否失效」無法在收盤前判斷完畢。',
    test: (plan) => plan.overnight === 'day_trade_mainly' && plan.stopLossRule === 'thesis_invalid',
  },
]);

// 回傳所有被觸發的矛盾規則（可能同時觸發多條，不互斥）。空陣列＝計畫合法，
// 可零摩擦直接開局。
export function detectContradictions(plan) {
  return CONTRADICTION_RULES.filter((rule) => rule.test(plan)).map((rule) => ({
    id: rule.id,
    templateKey: rule.templateKey,
    fields: rule.fields,
    reason: rule.reason,
  }));
}
