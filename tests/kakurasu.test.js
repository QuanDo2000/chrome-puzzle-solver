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

test('KakurasuSolver._applyLines: single-mask row forces every cell', () => {
  const s = new KakurasuSolver({
    rows: 1, cols: 4,
    rowClues: [2],
    colClues: [0, 1, 0, 0],
  });
  assert.equal(s._applyLines(), true);
  assert.equal(s.cellStatus[0], 2);  // (0,0) cross
  assert.equal(s.cellStatus[1], 1);  // (0,1) filled
  assert.equal(s.cellStatus[2], 2);
  assert.equal(s.cellStatus[3], 2);
});

test('KakurasuSolver._applyLines: empty row mask list → contradiction', () => {
  const s = new KakurasuSolver({
    rows: 1, cols: 3,
    rowClues: [100],
    colClues: [0, 0, 0],
  });
  assert.equal(s._applyLines(), false);
});

test('KakurasuSolver._applyLines: mask narrowing under known cell', () => {
  // 1×3, row clue=3. Subsets summing to 3: {1,2}→0b011 (cols 0,1 filled),
  // {3}→0b100 (col 2 filled). Known cross at (0,2) eliminates 0b100,
  // leaving 0b011 → cells 0,1 forced filled. Col clues match that
  // solution: col 0 has row 0 filled (weight 1) → clue 1; col 1 same →
  // clue 1; col 2 empty → clue 0.
  const s = new KakurasuSolver({
    rows: 1, cols: 3,
    rowClues: [3],
    colClues: [1, 1, 0],
    initialState: [[0, 0, 2]],
  });
  assert.equal(s._applyLines(), true);
  assert.equal(s.cellStatus[0], 1);
  assert.equal(s.cellStatus[1], 1);
});

test('KakurasuSolver._propagate: solves recon 4x4 by propagation alone', () => {
  const s = new KakurasuSolver({
    rows: 4, cols: 4,
    rowClues: [2, 7, 9, 6],
    colClues: [4, 8, 9, 5],
  });
  assert.equal(s._propagate(), true);
  const expected = [
    [2,1,2,2],
    [2,2,1,1],
    [2,1,1,1],
    [1,1,1,2],
  ];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    assert.equal(s.cellStatus[r*4+c], expected[r][c],
      `cell (${r},${c}) expected ${expected[r][c]} got ${s.cellStatus[r*4+c]}`);
  }
});
