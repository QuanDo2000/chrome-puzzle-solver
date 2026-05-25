'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MosaicSolver } = require('../solver.js');

test('MosaicSolver: constructor mirrors task and initialState', () => {
  const s = new MosaicSolver({
    rows: 2, cols: 2,
    task: [[-1, 3], [-1, -1]],
    initialState: [[0, 1], [2, 0]],
  });
  assert.equal(s.rows, 2);
  assert.equal(s.cols, 2);
  assert.equal(s.cellStatus[0], 0);
  assert.equal(s.cellStatus[1], 1);
  assert.equal(s.cellStatus[2], 2);
  assert.equal(s.cellStatus[3], 0);
  assert.equal(s.task[1], 3);
  assert.equal(s.clues.length, 1);
  assert.equal(s.clueValues[0], 3);
});

test('MosaicSolver: _set does NOT cascade (no adjacency rule)', () => {
  const s = new MosaicSolver({
    rows: 3, cols: 3, task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  assert.equal(s._set(4, 1), true);
  assert.equal(s.cellStatus[4], 1);
  assert.equal(s.cellStatus[1], 0);
  assert.equal(s.cellStatus[3], 0);
  assert.equal(s.cellStatus[5], 0);
  assert.equal(s.cellStatus[7], 0);
});

test('MosaicSolver: _set / _rollback round-trip', () => {
  const s = new MosaicSolver({ rows: 1, cols: 2, task: [[-1, -1]] });
  const mark = s.trail.length;
  assert.equal(s._set(0, 2), true);
  s._rollback(mark);
  assert.equal(s.cellStatus[0], 0);
});
