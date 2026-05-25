'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { KakurasuSolver } = require('../solver.js');

test('KakurasuSolver: constructor mirrors clues and initialState', () => {
  const s = new KakurasuSolver({
    rows: 4, cols: 4,
    rowClues: [2, 7, 9, 6],
    colClues: [4, 8, 9, 5],
    initialState: [[0,0,0,0],[0,0,0,0],[0,0,1,0],[0,0,0,0]],
  });
  assert.equal(s.rows, 4);
  assert.equal(s.cols, 4);
  assert.equal(s.cellStatus[10], 1); // (2,2) flat = 2*4+2 = 10
  assert.equal(s.rowClues[1], 7);
  assert.equal(s.colClues[2], 9);
});

test('KakurasuSolver: _set / _rollback round-trip', () => {
  const s = new KakurasuSolver({
    rows: 2, cols: 2,
    rowClues: [1, 2], colClues: [1, 2],
  });
  const cm = s.cellTrail.length;
  assert.equal(s._set(0, 1), true);
  assert.equal(s.cellStatus[0], 1);
  // No-op on same
  assert.equal(s._set(0, 1), true);
  assert.equal(s.cellTrail.length, cm + 1);
  // Conflict
  assert.equal(s._set(0, 2), false);
  s._rollback(cm, 0);
  assert.equal(s.cellStatus[0], 0);
});

test('KakurasuSolver._buildMaskDomains: row mask 1×3 clue=4', () => {
  const s = new KakurasuSolver({
    rows: 1, cols: 3,
    rowClues: [4],
    colClues: [1, 0, 0],
  });
  assert.deepEqual(Array.from(s.rowMasksActive[0]).sort(), [0b101]);
});

test('KakurasuSolver._buildMaskDomains: row clue=0 → only empty mask', () => {
  const s = new KakurasuSolver({
    rows: 1, cols: 3,
    rowClues: [0],
    colClues: [0, 0, 0],
  });
  assert.deepEqual(Array.from(s.rowMasksActive[0]), [0]);
});

test('KakurasuSolver._buildMaskDomains: clue exceeds max sum → no masks', () => {
  const s = new KakurasuSolver({
    rows: 1, cols: 3,
    rowClues: [100],
    colClues: [0, 0, 0],
  });
  assert.equal(s.rowMasksActive[0].length, 0);
});

test('KakurasuSolver._buildMaskDomains: 4×4 recon row 0 clue=2 → only col 1 filled', () => {
  const s = new KakurasuSolver({
    rows: 4, cols: 4,
    rowClues: [2, 7, 9, 6],
    colClues: [4, 8, 9, 5],
  });
  assert.deepEqual(Array.from(s.rowMasksActive[0]).sort(), [0b0010]);
});
