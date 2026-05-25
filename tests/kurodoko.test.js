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

test('KurodokoSolver._propagate: returns true on the recon 5x5', () => {
  const s = new KurodokoSolver({
    rows: 5, cols: 5,
    task: [
      [-1,-1,-1,6,-1],
      [-1,4,-1,7,-1],
      [-1,-1,-1,-1,-1],
      [-1,5,-1,8,-1],
      [-1,5,-1,-1,-1],
    ],
  });
  assert.equal(s._propagate(), true);
});

test('KurodokoSolver._propagate: contradictory input', () => {
  // 2x2 with clue=4 at (0,0): max visibility = 1 + 1 + 0 + 0 + 1 = 3 (self + right + down).
  // K=4 impossible → contradiction.
  const s = new KurodokoSolver({
    rows: 2, cols: 2,
    task: [[4,-1],[-1,-1]],
  });
  assert.equal(s._propagate(), false);
});

test('KurodokoSolver.solve: solves the recon 5x5', () => {
  KurodokoSolver.clearSolutionCache();
  const s = new KurodokoSolver({
    rows: 5, cols: 5,
    task: [
      [-1,-1,-1,6,-1],
      [-1,4,-1,7,-1],
      [-1,-1,-1,-1,-1],
      [-1,5,-1,8,-1],
      [-1,5,-1,-1,-1],
    ],
    maxMs: 5000,
  });
  const r = s.solve();
  assert.equal(r.solved, true);
  let blacks = 0, whites = 0, zeros = 0;
  for (const row of r.grid) for (const v of row) {
    if (v === 1) blacks++;
    else if (v === 2) whites++;
    else if (v === 0) zeros++;
  }
  // 6 clue cells (the -1 positions in task are non-clue); clue cells emit 0.
  assert.equal(zeros, 6, `expected 6 zero (clue) cells; got ${zeros}`);
});

test('KurodokoSolver.solve: returns {solved:false, grid:null} on unsat', () => {
  KurodokoSolver.clearSolutionCache();
  const s = new KurodokoSolver({
    rows: 2, cols: 2,
    task: [[4,-1],[-1,-1]],
  });
  const r = s.solve();
  assert.equal(r.solved, false);
  assert.equal(r.grid, null);
});

test('KurodokoSolver._solutionCache: cache hit returns deep copy', () => {
  KurodokoSolver.clearSolutionCache();
  const opts = { rows: 3, cols: 3, task: [[-1,-1,-1],[-1,5,-1],[-1,-1,-1]] };
  const a = new KurodokoSolver(opts).solve();
  a.grid[0][0] = 99;
  const b = new KurodokoSolver(opts).solve();
  assert.notEqual(b.grid[0][0], 99);
});

test('computePuzzleDiff kurodoko: flags wrong-color cells, ignores unknown', () => {
  const { computePuzzleDiff } = require('../solver.js');
  const solution = [[1, 2], [2, 1]];
  const board = [[2, 2], [0, 1]];
  const diff = computePuzzleDiff('kurodoko', board, solution);
  assert.equal(diff.length, 1);
  assert.deepEqual(diff[0], { row: 0, col: 0, expected: 1, actual: 2 });
});

test('KurodokoSolver.getHint: K=1 yields immediate hint', () => {
  KurodokoSolver.clearSolutionCache();
  const s = new KurodokoSolver({
    rows: 3, cols: 3,
    task: [[-1,-1,-1],[-1,1,-1],[-1,-1,-1]],
  });
  const hint = s.getHint([[0,0,0],[0,0,0],[0,0,0]]);
  assert.ok(Array.isArray(hint));
  assert.ok(hint.length >= 1);
  // At least one of (0,1), (1,0), (1,2), (2,1) should appear as black.
  const expected = [[0,1],[1,0],[1,2],[2,1]];
  const found = expected.some(([r,c]) =>
    hint.some(h => h.row === r && h.col === c && h.value === 1));
  assert.ok(found, `expected neighbour-of-(1,1) forced black; got ${JSON.stringify(hint)}`);
  // No clue cell should appear in the hint set.
  assert.ok(!hint.some(h => h.row === 1 && h.col === 1), 'clue cell must not be in hint');
});

test('KurodokoSolver.getHint: null on solved board', () => {
  KurodokoSolver.clearSolutionCache();
  const s = new KurodokoSolver({
    rows: 3, cols: 3,
    task: [[-1,-1,-1],[-1,1,-1],[-1,-1,-1]],
  });
  // Solved state: 4-neighbours black, rest white. Clue cell stays at 0.
  const solved = [[2,1,2],[1,0,1],[2,1,2]];
  assert.equal(s.getHint(solved), null);
});
