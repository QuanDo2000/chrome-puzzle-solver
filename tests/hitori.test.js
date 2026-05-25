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

test('HitoriSolver._buildStaticForcedWhites: sandwich X-Y-X forces middle white', () => {
  const s = new HitoriSolver({
    rows: 1, cols: 3,
    task: [[5, 3, 5]],
  });
  assert.ok(Array.from(s.staticForcedWhites).includes(1),
    `expected idx 1 in staticForcedWhites; got ${Array.from(s.staticForcedWhites)}`);
});

test('HitoriSolver._buildStaticForcedWhites: triplet X-X-X forces middle white', () => {
  const s = new HitoriSolver({
    rows: 1, cols: 3,
    task: [[7, 7, 7]],
  });
  assert.ok(Array.from(s.staticForcedWhites).includes(1));
});

test('HitoriSolver._buildStaticForcedWhites: vertical sandwich on column', () => {
  const s = new HitoriSolver({
    rows: 3, cols: 1,
    task: [[5], [3], [5]],
  });
  assert.ok(Array.from(s.staticForcedWhites).includes(1));
});

test('HitoriSolver._applyStaticForcedWhites: writes forced-white cells', () => {
  const s = new HitoriSolver({
    rows: 1, cols: 3,
    task: [[5, 3, 5]],
  });
  assert.equal(s._applyStaticForcedWhites(), true);
  assert.equal(s.cellStatus[1], 2);
});

test('HitoriSolver._applyStaticForcedWhites: existing black at forced-white spot → contradiction', () => {
  const s = new HitoriSolver({
    rows: 1, cols: 3,
    task: [[5, 3, 5]],
    initialState: [[0, 1, 0]],
  });
  assert.equal(s._applyStaticForcedWhites(), false);
});

test('HitoriSolver._applyUniqueness: two whites with same value in row → contradiction', () => {
  const s = new HitoriSolver({
    rows: 1, cols: 3,
    task: [[5, 3, 5]],
    initialState: [[2, 0, 2]],
  });
  assert.equal(s._applyUniqueness(), false);
});

test('HitoriSolver._applyUniqueness: one white + one unknown same value → unknown forced black', () => {
  const s = new HitoriSolver({
    rows: 1, cols: 4,
    task: [[5, 3, 5, 2]],
    initialState: [[2, 0, 0, 0]],
  });
  assert.equal(s._applyUniqueness(), true);
  assert.equal(s.cellStatus[2], 1);
});

test('HitoriSolver._applyUniqueness: unique row values → no force', () => {
  const s = new HitoriSolver({
    rows: 1, cols: 3,
    task: [[1, 2, 3]],
  });
  assert.equal(s._applyUniqueness(), true);
  assert.equal(s.cellStatus[0], 0);
  assert.equal(s.cellStatus[1], 0);
  assert.equal(s.cellStatus[2], 0);
});

test('HitoriSolver._applyUniqueness: column uniqueness', () => {
  const s = new HitoriSolver({
    rows: 3, cols: 1,
    task: [[5], [3], [5]],
    initialState: [[2], [0], [0]],
  });
  assert.equal(s._applyUniqueness(), true);
  assert.equal(s.cellStatus[2], 1);
});

test('HitoriSolver._applyConnectivity: blacks splitting whites → contradiction', () => {
  const s = new HitoriSolver({
    rows: 3, cols: 3,
    task: [[1,2,3],[4,5,6],[7,8,9]],
  });
  s.cellStatus[0] = 2; s.cellStatus[1] = 1; s.cellStatus[2] = 2;
  s.cellStatus[3] = 1; s.cellStatus[4] = 1; s.cellStatus[5] = 1;
  s.cellStatus[6] = 2; s.cellStatus[7] = 1; s.cellStatus[8] = 2;
  assert.equal(s._applyConnectivity(), false);
});

test('HitoriSolver._applyConnectivity: articulation unknown forced white', () => {
  const s = new HitoriSolver({
    rows: 3, cols: 3,
    task: [[1,2,3],[4,5,6],[7,8,9]],
  });
  s.cellStatus[0] = 2; s.cellStatus[2] = 2;
  s.cellStatus[3] = 1; s.cellStatus[5] = 1;
  s.cellStatus[6] = 2; s.cellStatus[8] = 2;
  assert.equal(s._applyConnectivity(), true);
  assert.equal(s.cellStatus[4], 2);
});

test('HitoriSolver._applyConnectivity: skipped inside lookahead', () => {
  const s = new HitoriSolver({
    rows: 3, cols: 3,
    task: [[1,2,3],[4,5,6],[7,8,9]],
  });
  s.cellStatus[0] = 2; s.cellStatus[2] = 2;
  s.cellStatus[3] = 1; s.cellStatus[5] = 1;
  s.cellStatus[6] = 2; s.cellStatus[8] = 2;
  s._inLookahead = true;
  assert.equal(s._applyConnectivity(), true);
  assert.equal(s.cellStatus[4], 0);
});

test('HitoriSolver._propagate: cascades static + uniqueness', () => {
  const s = new HitoriSolver({
    rows: 1, cols: 3,
    task: [[5, 3, 5]],
  });
  assert.equal(s._propagate(), true);
  assert.equal(s.cellStatus[1], 2);
});

test('HitoriSolver._propagate: returns false on contradictory input', () => {
  const s = new HitoriSolver({
    rows: 1, cols: 3,
    task: [[5, 3, 5]],
    initialState: [[2, 0, 2]],
  });
  assert.equal(s._propagate(), false);
});

test('HitoriSolver.solve: solves the recon 5x5', () => {
  HitoriSolver.clearSolutionCache();
  const task = [
    [5,5,2,3,3],
    [2,5,4,4,3],
    [4,4,1,5,2],
    [1,2,5,4,5],
    [1,4,5,5,1],
  ];
  const expected = [
    [2,1,2,2,1],
    [2,2,2,1,2],
    [2,1,2,2,2],
    [2,2,1,2,2],
    [1,2,2,1,2],
  ];
  const s = new HitoriSolver({ rows:5, cols:5, task });
  const r = s.solve();
  assert.equal(r.solved, true);
  assert.deepEqual(r.grid, expected);
});

test('HitoriSolver.solve: returns {solved:false, grid:null} on unsat', () => {
  HitoriSolver.clearSolutionCache();
  const s = new HitoriSolver({
    rows: 1, cols: 3,
    task: [[5, 3, 5]],
    initialState: [[2, 0, 2]],
  });
  const r = s.solve();
  assert.equal(r.solved, false);
  assert.equal(r.grid, null);
});

test('HitoriSolver._solutionCache: cache hit returns deep copy', () => {
  HitoriSolver.clearSolutionCache();
  const task = [[5,5,2,3,3],[2,5,4,4,3],[4,4,1,5,2],[1,2,5,4,5],[1,4,5,5,1]];
  const a = new HitoriSolver({ rows:5, cols:5, task }).solve();
  a.grid[0][0] = 99;
  const b = new HitoriSolver({ rows:5, cols:5, task }).solve();
  assert.notEqual(b.grid[0][0], 99);
});

test('computePuzzleDiff hitori: flags wrong-color cells, ignores unknown', () => {
  const { computePuzzleDiff } = require('../solver.js');
  const solution = [[1, 2], [2, 1]];
  const board = [[2, 2], [0, 1]];
  const diff = computePuzzleDiff('hitori', board, solution);
  assert.equal(diff.length, 1);
  assert.deepEqual(diff[0], { row: 0, col: 0, expected: 1, actual: 2 });
});
