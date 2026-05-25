'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { HitoriSolver } = require('../solver.js');

test('HitoriSolver: constructor mirrors task and initialState', () => {
  const s = new HitoriSolver({
    rows: 2, cols: 2,
    task: [[5, 3], [3, 5]],
    initialState: [[0, 1], [2, 0]],
  });
  assert.equal(s.rows, 2);
  assert.equal(s.cols, 2);
  assert.equal(s.cellStatus[0], 0);
  assert.equal(s.cellStatus[1], 1);
  assert.equal(s.cellStatus[2], 2);
  assert.equal(s.cellStatus[3], 0);
  assert.equal(s.task[0], 5);
  assert.equal(s.task[1], 3);
  assert.equal(s.task[2], 3);
  assert.equal(s.task[3], 5);
});

test('HitoriSolver._set: black write forces 4-neighbours to white', () => {
  const s = new HitoriSolver({
    rows: 3, cols: 3, task: [[1,2,3],[4,5,6],[7,8,9]],
  });
  assert.equal(s._set(4, 1), true);
  assert.equal(s.cellStatus[1], 2);
  assert.equal(s.cellStatus[3], 2);
  assert.equal(s.cellStatus[5], 2);
  assert.equal(s.cellStatus[7], 2);
  assert.equal(s.cellStatus[0], 0);
});

test('HitoriSolver._set: black-next-to-black → contradiction', () => {
  const s = new HitoriSolver({
    rows: 1, cols: 2, task: [[1, 2]],
    initialState: [[1, 0]],
  });
  assert.equal(s._set(1, 1), false);
});

test('HitoriSolver._set / _rollback round-trip', () => {
  const s = new HitoriSolver({ rows: 1, cols: 2, task: [[1, 2]] });
  const mark = s.trail.length;
  assert.equal(s._set(0, 2), true);
  assert.equal(s.cellStatus[0], 2);
  s._rollback(mark);
  assert.equal(s.cellStatus[0], 0);
});
