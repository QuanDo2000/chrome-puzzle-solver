'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { KurodokoSolver } = require('../solver.js');

test('KurodokoSolver: constructor forces clue cells to white', () => {
  const s = new KurodokoSolver({
    rows: 2, cols: 2,
    task: [[-1, 3], [-1, -1]],
  });
  assert.equal(s.cellStatus[1], 2);  // (0,1) clue → white
  assert.equal(s.cellStatus[0], 0);  // (0,0) non-clue → unknown
  assert.equal(s.clues.length, 1);
  assert.equal(s.clueValues[0], 3);
});

test('KurodokoSolver: _set black write forces 4-neighbours to white', () => {
  const s = new KurodokoSolver({
    rows: 3, cols: 3, task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  assert.equal(s._set(4, 1), true);
  assert.equal(s.cellStatus[1], 2);
  assert.equal(s.cellStatus[3], 2);
  assert.equal(s.cellStatus[5], 2);
  assert.equal(s.cellStatus[7], 2);
});

test('KurodokoSolver: _set / _rollback round-trip', () => {
  const s = new KurodokoSolver({ rows: 1, cols: 2, task: [[-1, -1]] });
  const mark = s.trail.length;
  assert.equal(s._set(0, 2), true);
  assert.equal(s.cellStatus[0], 2);
  s._rollback(mark);
  assert.equal(s.cellStatus[0], 0);
});
