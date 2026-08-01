// templates.js — 矛盾偵測預寫模板庫（M4, SPEC.md §3/§6）。
//
// 每個 templateKey（對應 contradictions.js 的 CONTRADICTION_RULES）底下是
// 三位大師（Livermore／OPMAN／謝孟恭）各 2-3 句台詞，風格對齊各自人設：
//   - livermore：停損紀律／趨勢／加碼紀律，語氣冷硬直接。
//   - opman：資金控管／凹單放到歸零，語氣像盤後教學文，帶點碎念。
//   - gooaye（謝孟恭）：部位管理白話，語氣輕鬆口語但講重點。
// 純文案資料，不含邏輯；getTemplate() 是唯一的存取入口。

export const TEMPLATES = Object.freeze({
  martingale_vs_drawdown_cap: Object.freeze({
    livermore: Object.freeze([
      '虧損的部位絕對不要加碼，這是我用真金白銀換來的規則，不是格言。',
      '你設了回撤上限，又打算逆勢攤平——這兩件事不可能同時成立，market 不會等你。',
    ]),
    opman: Object.freeze([
      '攤平就是凹單的正式名稱，只是聽起來比較專業而已。',
      '你回撤上限寫多少不重要，逆勢攤平會直接把那個數字打穿再說。',
    ]),
    gooaye: Object.freeze([
      '賠錢加碼這件事，十個裡面九個是凹單，剩下那個是運氣好。',
      '你都設回撤上限了，是在跟自己說「我知道會賠」，那就不要再往下攤了。',
    ]),
  }),

  high_margin_usage_vs_drawdown_cap: Object.freeze({
    livermore: Object.freeze([
      '把子彈用到七成以上，你等於是在賭沒有意外——但意外從來不會事先通知你。',
      '槓桿用滿，回撤上限就只是紙上的數字，市場一根長黑就能撕掉它。',
    ]),
    opman: Object.freeze([
      '保證金用到 70% 以上，你的資金控管已經名存實亡了。',
      '這不是格局判讀的問題，是你把安全邊際自己讓出去了。',
    ]),
    gooaye: Object.freeze([
      '滿倉開槓桿又想守回撤，這兩件事根本互相矛盾，市場不會體諒你。',
      '用這麼高的使用率，你的回撤上限只是安慰自己用的。',
    ]),
  }),

  daytrade_vs_thesis_invalid_stop: Object.freeze({
    livermore: Object.freeze([
      '當沖靠的是價格說話，等你想清楚論點還成不成立，行情早就走完了。',
      '停損要是價格，不是心情——尤其是當日沖銷，你沒有隔夜想清楚的時間。',
    ]),
    opman: Object.freeze([
      '當沖不設價格停損，你是準備用整個帳戶去驗證論點對不對嗎。',
      '收盤前你哪來的時間判斷論點失效，先把停損價設出來。',
    ]),
    gooaye: Object.freeze([
      '當沖玩的是速度，你卻用需要時間醞釀的邏輯當停損，根本搭不起來。',
      '先講好一個價格停損，論點的事留到收盤後複盤再想。',
    ]),
  }),
});

export function getTemplate(templateKey) {
  const t = TEMPLATES[templateKey];
  if (!t) throw new Error(`getTemplate: unknown templateKey "${templateKey}"`);
  return t;
}
