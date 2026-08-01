// calendar.js — settlement-day calendar rule for the M3 margin engine.
//
// isSettlementDay: 台指期結算日＝當月第三個週三（SPEC.md §2、§4）。
// 簡化沿用 M1 的作法：不處理國定假日順延（若第三個週三剛好是假日，真實
// 交易所會順延，本遊戲不模擬這個邊界情況——標的資料源本身也未特別標記
// 假日順延過的結算日）。輸入為 'YYYY-MM-DD'，以曆面日期（非時區換算）
// 直接用 UTC 建構 Date 物件比對星期，避免本地時區位移造成的日期跳動。

export function isSettlementDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCDay() !== 3) return false; // 3 = Wednesday

  let wednesdayCount = 0;
  for (let day = 1; day <= d; day++) {
    if (new Date(Date.UTC(y, m - 1, day)).getUTCDay() === 3) wednesdayCount++;
  }
  return wednesdayCount === 3;
}
