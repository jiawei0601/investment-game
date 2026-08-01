// levels.js — M5 UI level catalogue (SPEC.md §2 「劇本制 4 關」).
//
// startDate/endDate are month-granularity bounds straight from SPEC §2; they
// don't need to land on an actual trading day because src/game/session.js's
// createSession() already clips them to whatever rows exist in that window
// (rowsBetween filters `r.date >= startDate && r.date <= endDate`).
//
// levelId feeds directly into buildSeed(levelId, attempt, date) (AGENTS.md
// seed convention) — it must never contain '|' (buildSeed throws otherwise).

export const LEVELS = Object.freeze([
  Object.freeze({
    id: 'pandemic',
    name: '疫情',
    range: '2020-01 → 2020-06',
    startDate: '2020-01-01',
    endDate: '2020-06-30',
    goal: '崩盤中的槓桿存活：減碼、補保證金還是反手',
  }),
  Object.freeze({
    id: 'bear',
    name: '熊市',
    range: '2022-01 → 2022-10',
    startDate: '2022-01-01',
    endDate: '2022-10-31',
    goal: '陰跌凹單：無明確底部的空頭，最難',
  }),
  Object.freeze({
    id: 'flat',
    name: '平淡',
    range: '2017-03 → 2017-08',
    startDate: '2017-03-01',
    endDate: '2017-08-31',
    goal: '低波動不亂做；過度交易被成本磨死',
  }),
  Object.freeze({
    id: 'crash',
    name: '閃崩',
    range: '2024-05 → 2024-10',
    startDate: '2024-05-01',
    endDate: '2024-10-31',
    goal: '大漲後的 2024-08-05 史上最大跌點：持倉過夜的代價',
  }),
]);

// 無限模式不是固定 level：起訖區間由玩家（起點用種子隨機、結束自訂）決定，
// UI 只是把它包成跟劇本關同形狀的物件方便共用同一套開局表單渲染邏輯。
export const INFINITE_LEVEL = Object.freeze({
  id: 'infinite',
  name: '無限模式',
  range: '隨機起點・自訂結束',
  startDate: null,
  endDate: null,
  goal: '沒有預設劇本，自己決定訓練多久、練什麼。',
});

// 馬賽克模式（ADR 0009）：跟無限模式一樣不是固定 level，rows 由
// src/mosaic/build.js 的 buildMosaicRows() 產生後直接餵 createSession，
// startDate/endDate 為 null 只是沿用同一套開局表單渲染邏輯（selectLevel()
// 用 level.id 判斷要不要顯示局長輸入框，見 app.js ensureMosaicOptionsUI）。
export const MOSAIC_LEVEL = Object.freeze({
  id: 'mosaic',
  name: '馬賽克',
  range: '隨機起點・真實月份拼接',
  startDate: null,
  endDate: null,
  goal: '反記憶行情、無資訊層：連方向都不能靠記憶猜（ADR 0009）。',
});

export function findLevel(id) {
  if (id === INFINITE_LEVEL.id) return INFINITE_LEVEL;
  if (id === MOSAIC_LEVEL.id) return MOSAIC_LEVEL;
  return LEVELS.find((l) => l.id === id) ?? null;
}
