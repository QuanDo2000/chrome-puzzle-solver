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

test('KurodokoSolver._applyVisibility: K=1 forces 4-neighbours black', () => {
  const s = new KurodokoSolver({
    rows: 3, cols: 3,
    task: [[-1,-1,-1],[-1,1,-1],[-1,-1,-1]],
  });
  assert.equal(s._applyVisibility(), true);
  assert.equal(s.cellStatus[1], 1);  // (0,1) black
  assert.equal(s.cellStatus[3], 1);  // (1,0) black
  assert.equal(s.cellStatus[5], 1);  // (1,2) black
  assert.equal(s.cellStatus[7], 1);  // (2,1) black
});

test('KurodokoSolver._applyVisibility: K=max forces in-line cells white', () => {
  // 3x3 with clue=5 at (1,1) = full visibility (self+4 axial cells).
  const s = new KurodokoSolver({
    rows: 3, cols: 3,
    task: [[-1,-1,-1],[-1,5,-1],[-1,-1,-1]],
  });
  assert.equal(s._applyVisibility(), true);
  assert.equal(s.cellStatus[1], 2);  // (0,1) white
  assert.equal(s.cellStatus[3], 2);  // (1,0) white
  assert.equal(s.cellStatus[5], 2);  // (1,2) white
  assert.equal(s.cellStatus[7], 2);  // (2,1) white
});

test('KurodokoSolver._applyVisibility: corner clue K=2 has slack — no force', () => {
  const s = new KurodokoSolver({
    rows: 3, cols: 3,
    task: [[2,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  assert.equal(s._applyVisibility(), true);
  assert.equal(s.cellStatus[0], 2);  // clue cell forced white by constructor
  // Other cells should remain unknown (multiple distributions valid).
});

test('KurodokoSolver._applyVisibility: contradiction when clue impossible', () => {
  const s = new KurodokoSolver({
    rows: 1, cols: 1,
    task: [[2]],
  });
  assert.equal(s._applyVisibility(), false);
});

test('KurodokoSolver._applyConnectivity: blacks splitting whites → contradiction', () => {
  const s = new KurodokoSolver({
    rows: 3, cols: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  s.cellStatus[0] = 2; s.cellStatus[1] = 1; s.cellStatus[2] = 2;
  s.cellStatus[3] = 1; s.cellStatus[4] = 1; s.cellStatus[5] = 1;
  s.cellStatus[6] = 2; s.cellStatus[7] = 1; s.cellStatus[8] = 2;
  assert.equal(s._applyConnectivity(), false);
});

test('KurodokoSolver._applyConnectivity: articulation unknown forced white', () => {
  const s = new KurodokoSolver({
    rows: 3, cols: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  s.cellStatus[0] = 2; s.cellStatus[2] = 2;
  s.cellStatus[3] = 1; s.cellStatus[5] = 1;
  s.cellStatus[6] = 2; s.cellStatus[8] = 2;
  assert.equal(s._applyConnectivity(), true);
  assert.equal(s.cellStatus[4], 2);
});
