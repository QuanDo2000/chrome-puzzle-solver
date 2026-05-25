'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { NurikabeSolver } = require('../solver.js');

test('NurikabeSolver: constructor sets clue cells WHITE and builds clues list', () => {
  const s = new NurikabeSolver({
    rows: 3, cols: 3,
    task: [[1, -1, -1], [-1, -1, -1], [-1, -1, 2]],
  });
  assert.equal(s.rows, 3);
  assert.equal(s.cols, 3);
  assert.equal(s.clues.length, 2);
  assert.deepEqual(s.clues.map(c => ({idx: c.idx, size: c.size})), [
    {idx: 0, size: 1},
    {idx: 8, size: 2},
  ]);
  assert.equal(s.expectedBlacks, 6);
  assert.equal(s.cellStatus[0], 2);
  assert.equal(s.cellStatus[8], 2);
});

test('NurikabeSolver: _set / _rollback round-trip', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[1, -1, -1]],
  });
  const mark = s.trail.length;
  assert.equal(s._set(1, 1), true);
  assert.equal(s.cellStatus[1], 1);
  s._rollback(mark);
  assert.equal(s.cellStatus[1], 0);
});

test('NurikabeSolver: _set overwriting same value is no-op (true)', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[1, -1, -1]],
  });
  assert.equal(s._set(0, 2), true);
});

test('NurikabeSolver: _set overwriting different non-zero → false', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[1, -1, -1]],
  });
  assert.equal(s._set(0, 1), false);
});

test('NurikabeSolver: constructor pre-check rejects when a clue can not reach its size', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[5, -1, -1]],
  });
  assert.equal(s.contradiction, true);
});

test('NurikabeSolver: two adjacent clue cells set contradiction at construction', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 2,
    task: [[1, 1]],
  });
  assert.equal(s.contradiction, true);
});
