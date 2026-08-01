// profile.js — M7 跨局玩家檔案更新（docs/backlog/M7-battle-report-and-profile.md）。
//
// 沿用 src/behavior/profile.js 既有 schema 原樣（createProfile()/
// recordSession() 已提供的 {levelId, attempt, startDate, endDate, score,
// counts} 完全夠用，不需要擴充欄位）——依 M7 派工說明，只有真的需要擴充該
// schema 時才允許碰 src/behavior/*；這裡用不到，所以本檔刻意不去改
// src/behavior 任何檔案，只是它的一個薄組裝層。
//
// updateProfile(profile, session) → profile'
//   純函數，不改動輸入的 profile 或 session。
//   - session.finished !== true（劇本模式中離）→ 原樣傳回 profile，不寫入
//     這一局（SPEC.md §9-4 無中途存檔互鎖：能把未結算的半局寫進跨局曲線，
//     就等於能靠「中離重開」洗掉違背紀錄）。
//   - completedAt 刻意不用 `new Date().toISOString()`（牆上時鐘）：那會讓
//     這個函數同一組輸入兩次呼叫得到不同輸出。改用 session 本身最後一個
//     交易日的日期（session 域內、確定性的資料）——「這局哪一天結算」本來
//     就該問遊戲內的日期，不是呼叫當下的系統時間。

import { createProfile, recordSession } from '../behavior/index.js';

export { createProfile };

export function updateProfile(profile, session) {
  if (!session.finished) return profile;
  const startDate = session.rows[0].date;
  const endDate = session.rows[session.rows.length - 1].date;
  return recordSession(profile, {
    levelId: session.levelId,
    attempt: session.attempt,
    startDate,
    endDate,
    completedAt: endDate,
    score: session.score,
    counts: session.scoreCounts,
  });
}
