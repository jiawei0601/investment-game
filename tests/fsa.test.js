// tests/fsa.test.js — File System Access wiring (src/ui/fsa.js), pure-logic
// slice only. The DOM/showDirectoryPicker/IndexedDB parts of fsa.js need a
// real browser (documented as manual verification steps in HANDOFF-style
// notes elsewhere, per the 結算自動存檔 task's "瀏覽器部分文件化手動驗證
// 步驟即可" note) — this file covers exactly the one piece that's a pure
// function and therefore testable with plain `node --test`.
//
// Run with: node --test tests/fsa.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import { canAutoSave } from '../src/ui/fsa.js';

test('canAutoSave: true only for the granted PermissionState', () => {
  assert.equal(canAutoSave('granted'), true);
});

test('canAutoSave: false for prompt (needs a user gesture before any write)', () => {
  assert.equal(canAutoSave('prompt'), false);
});

test('canAutoSave: false for denied', () => {
  assert.equal(canAutoSave('denied'), false);
});

test('canAutoSave: false for garbage/undefined input (fail closed, never silently write)', () => {
  assert.equal(canAutoSave(undefined), false);
  assert.equal(canAutoSave(null), false);
  assert.equal(canAutoSave(''), false);
  assert.equal(canAutoSave('GRANTED'), false); // case-sensitive, no loose matching
});
