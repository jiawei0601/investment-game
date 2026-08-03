// profile.js — 跨局玩家檔案 schema（M4, SPEC.md §3「跨局進步曲線」）。
//
// 純資料模型＋不可變更新函數，實際檔案 I/O（讀寫 profile.json）留給 M7。
// schema（version 1）：
//   {
//     version: 1,
//     sessions: [
//       {
//         levelId, attempt, startDate, endDate,
//         completedAt,           // ISO timestamp，記錄這筆是何時寫入的
//         score,                 // computeScore() 的 score
//         counts: {              // computeScore() 的 counts，五類固定 key
//           bag_holding, unplanned_trade, risk_out_of_control,
//           thesis_drift, martingale_add,
//         },
//       },
//       ...
//     ],
//   }

const REQUIRED_ENTRY_FIELDS = ['levelId', 'attempt', 'startDate', 'endDate', 'score', 'counts'];

export function createProfile() {
  return { version: 1, sessions: [] };
}

export function recordSession(profile, entry) {
  for (const f of REQUIRED_ENTRY_FIELDS) {
    if (!(f in entry)) throw new Error(`recordSession: missing field "${f}"`);
  }
  const record = {
    levelId: entry.levelId,
    attempt: entry.attempt,
    startDate: entry.startDate,
    endDate: entry.endDate,
    completedAt: entry.completedAt ?? new Date().toISOString(),
    score: entry.score,
    counts: { ...entry.counts },
  };
  // 同一局（levelId, attempt）只記一筆：自動存檔＋手動補存/變更資料夾補存
  // 會對同一 session 各呼叫一次 updateProfile，append 會重複計局
  // （2026-08-03 實測 profile 出現雙重紀錄）。同鍵改為覆蓋。
  const others = profile.sessions.filter(
    (s) => !(s.levelId === record.levelId && s.attempt === record.attempt)
  );
  return { ...profile, sessions: [...others, record] };
}
