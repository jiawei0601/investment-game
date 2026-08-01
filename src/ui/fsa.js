// fsa.js — File System Access API wiring for M5 UI (SPEC.md §7 "File System
// Access API（A1）"). Handles the one-time repo-folder authorization, stores
// the directory handle in IndexedDB for reuse across sessions, and writes
// reports/{levelId}-{attempt}-{date}.md + profile.json. Falls back to a
// plain <a download> when the API isn't available (non-Chromium browsers).
//
// Every function here is display/IO plumbing only — it never touches game
// state, mirrors the "UI 只 render 與轉發指令" rule from AGENTS.md just
// applied to file I/O instead of game logic.

const DB_NAME = 'investment-game-fsa';
const DB_VERSION = 1;
const STORE = 'handles';
const HANDLE_KEY = 'repoDir';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function isFsaSupported() {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

// Must be called synchronously from within a user-gesture handler (click) —
// showDirectoryPicker() and requestPermission() both require "transient user
// activation", they will reject if called from inside an await chain that
// has lost the gesture.
export async function pickAndSaveDirHandle() {
  if (!isFsaSupported()) throw new Error('FSA_UNSUPPORTED');
  const handle = await window.showDirectoryPicker({ id: 'investment-game-repo', mode: 'readwrite' });
  await idbSet(HANDLE_KEY, handle);
  return handle;
}

// Reuses a previously-authorized handle if permission is still granted.
// Does NOT prompt (requestPermission needs a user gesture) — returns null if
// re-authorization is needed, letting the caller show a "重新授權" button.
export async function getSavedDirHandle() {
  if (!isFsaSupported()) return null;
  const handle = await idbGet(HANDLE_KEY);
  if (!handle) return null;
  const perm = await handle.queryPermission({ mode: 'readwrite' });
  return perm === 'granted' ? handle : null;
}

// Re-requests permission on an already-saved handle; must run inside a user
// gesture (click), same constraint as pickAndSaveDirHandle.
export async function reauthorizeDirHandle() {
  const handle = await idbGet(HANDLE_KEY);
  if (!handle) return null;
  const perm = await handle.requestPermission({ mode: 'readwrite' });
  return perm === 'granted' ? handle : null;
}

async function writeFile(dirHandle, subdir, filename, content) {
  const parent = subdir ? await dirHandle.getDirectoryHandle(subdir, { create: true }) : dirHandle;
  const fileHandle = await parent.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

// Writes reports/{levelId}-{attempt}-{date}.md and profile.json (SPEC §7
// directory layout). `date` should be the caller's own YYYY-MM-DD (e.g. the
// last trading day of the run), not Date.now() — AGENTS.md forbids
// Date.now() in the game-logic path, and this is called with the session's
// own last row date, never wall-clock time.
export async function writeReportFiles(dirHandle, { levelId, attempt, date, reportMarkdown, profileJson }) {
  const filename = `${levelId}-${attempt}-${date}.md`;
  await writeFile(dirHandle, 'reports', filename, reportMarkdown);
  await writeFile(dirHandle, null, 'profile.json', profileJson);
  return filename;
}

// Non-Chromium fallback: trigger two browser downloads instead of writing
// into the repo folder directly.
export function downloadFallback({ levelId, attempt, date, reportMarkdown, profileJson }) {
  const filename = `${levelId}-${attempt}-${date}.md`;
  triggerDownload(filename, reportMarkdown, 'text/markdown');
  triggerDownload('profile.json', profileJson, 'application/json');
  return filename;
}

function triggerDownload(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Reads an existing profile.json from the authorized folder, if any (used to
// merge跨局 history — SPEC §3 "跨局進步曲線"). Returns null if not found or
// unreadable (fresh profile).
export async function readExistingProfile(dirHandle) {
  try {
    const fileHandle = await dirHandle.getFileHandle('profile.json');
    const file = await fileHandle.getFile();
    const text = await file.text();
    return JSON.parse(text);
  } catch {
    return null;
  }
}
