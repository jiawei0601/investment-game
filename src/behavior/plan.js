// plan.js — 開局作戰計畫資料模型（M4, SPEC.md §3）。
//
// 六個欄位、每個欄位的選項值與顯示文字**必須逐字對應 SPEC §3 列出的選項**
// （AGENTS.md / M4 backlog 驗收條件：不可少列或改動選項文字）。`label` 是拿
// 給玩家看的原文；`value` 是給程式邏輯用的穩定 key，不影響顯示。
//
// stopLossRule === 'fixed_points' 需要額外參數 stopLossParams.points（X 點）；
// stopLossRule === 'ma_break' 需要額外參數 stopLossParams.n（N 日均線）。這兩
// 個參數只在對應規則被選中時才驗證/使用（見 validatePlan）。

export const PLAN_FIELDS = Object.freeze({
  goal: {
    label: '目標',
    options: [
      { value: 'capital_preservation', label: '保本' },
      { value: 'stable_return', label: '穩定正報酬' },
      { value: 'double', label: '翻倍' },
      { value: 'custom', label: '自訂' },
    ],
  },
  maxDrawdown: {
    label: '最大回撤（權益數）',
    options: [
      { value: 10, label: '10%' },
      { value: 20, label: '20%' },
      { value: 30, label: '30%' },
      { value: 'unlimited', label: '不設限' },
    ],
  },
  stopLossRule: {
    label: '停損規則',
    options: [
      { value: 'fixed_points', label: '固定點數 -X 點' },
      { value: 'ma_break', label: '收盤跌破 N 日均線' },
      { value: 'thesis_invalid', label: '論點失效才走' },
      { value: 'none', label: '不設停損' },
    ],
  },
  addRule: {
    label: '加碼規則',
    options: [
      { value: 'no_add', label: '不加碼' },
      { value: 'trend_add', label: '順勢加碼' },
      { value: 'martingale_add', label: '逆勢攤平' },
      { value: 'thesis_reinforced_only', label: '僅論點強化時' },
    ],
  },
  marginUsageCap: {
    label: '保證金使用率上限',
    options: [
      { value: 30, label: '30%' },
      { value: 50, label: '50%' },
      { value: 70, label: '70%' },
      { value: 'unlimited', label: '不設限' },
    ],
  },
  overnight: {
    label: '持倉過夜',
    options: [
      { value: 'allowed', label: '可過夜' },
      { value: 'day_trade_mainly', label: '當日沖銷為主（過夜需理由）' },
    ],
  },
});

function optionValues(field) {
  return PLAN_FIELDS[field].options.map((o) => o.value);
}

export function validatePlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== 'object') return ['plan must be an object'];

  for (const field of Object.keys(PLAN_FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(plan, field)) {
      errors.push(`missing field: ${field}`);
      continue;
    }
    const valid = optionValues(field);
    if (!valid.includes(plan[field])) {
      errors.push(`invalid value for ${field}: ${JSON.stringify(plan[field])} (expected one of ${JSON.stringify(valid)})`);
    }
  }

  if (plan.stopLossRule === 'fixed_points') {
    const points = plan.stopLossParams?.points;
    if (!(typeof points === 'number' && points > 0)) {
      errors.push('stopLossRule=fixed_points requires stopLossParams.points > 0');
    }
  }
  if (plan.stopLossRule === 'ma_break') {
    const n = plan.stopLossParams?.n;
    if (!(Number.isInteger(n) && n > 0)) {
      errors.push('stopLossRule=ma_break requires stopLossParams.n (positive integer)');
    }
  }

  return errors;
}

// createPlan 驗證輸入並回傳凍結後的計畫物件；驗證失敗丟錯（呼叫端 — 開局
// 表單 — 應在送出前自行擋，這裡是最後一道防線，不吞錯誤）。
export function createPlan(input) {
  const errors = validatePlan(input);
  if (errors.length) {
    throw new Error(`createPlan: invalid plan — ${errors.join('; ')}`);
  }
  const plan = {
    goal: input.goal,
    maxDrawdown: input.maxDrawdown,
    stopLossRule: input.stopLossRule,
    addRule: input.addRule,
    marginUsageCap: input.marginUsageCap,
    overnight: input.overnight,
    stopLossParams: input.stopLossParams ? { ...input.stopLossParams } : undefined,
  };
  return Object.freeze(plan);
}
