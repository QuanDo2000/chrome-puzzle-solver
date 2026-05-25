'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { NurikabeSolver, computePuzzleDiff } = require('../solver.js');

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

test('NurikabeSolver._applyClueAdjacency: cell with 2 clue neighbours → BLACK', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[1, -1, 1]],
  });
  assert.equal(s.contradiction, false);
  assert.equal(s._applyClueAdjacency(), true);
  assert.equal(s.cellStatus[1], 1);
});

test('NurikabeSolver._applyClueAdjacency: cell with one clue neighbour stays unknown', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[1, -1, -1]],
  });
  assert.equal(s._applyClueAdjacency(), true);
  assert.equal(s.cellStatus[1], 0);
});

test('NurikabeSolver._applyUnreachable: cell out of all clue reach → BLACK', () => {
  const s = new NurikabeSolver({
    rows: 5, cols: 5,
    task: [
      [1, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1],
      [-1, -1, -1, -1, 1],
    ],
  });
  assert.equal(s._applyUnreachable(), true);
  assert.equal(s.cellStatus[12], 1);
});

test('NurikabeSolver._applyUnreachable: cell within Manhattan-but-not-BFS-distance still gets forced', () => {
  const s = new NurikabeSolver({
    rows: 3, cols: 3,
    task: [[2, -1, -1], [-1, -1, -1], [-1, -1, -1]],
  });
  assert.equal(s._applyUnreachable(), true);
  assert.equal(s.cellStatus[8], 1);
});

test('NurikabeSolver._applyUnreachable: cell within reach stays unknown', () => {
  const s = new NurikabeSolver({
    rows: 3, cols: 3,
    task: [[-1, -1, -1], [-1, 4, -1], [-1, -1, -1]],
  });
  assert.equal(s._applyUnreachable(), true);
  assert.equal(s.cellStatus[0], 0);
});

test('NurikabeSolver._applyIslandComplete: white component == N forces UNKNOWN frontier to BLACK', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[2, -1, -1]],
  });
  s._set(1, 2);
  assert.equal(s._applyIslandComplete(), true);
  assert.equal(s.cellStatus[2], 1);
});

test('NurikabeSolver._applyIslandComplete: capacity == N forces reachable UNKNOWNs to WHITE', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[2, -1, -1]],
  });
  s._set(2, 1);
  assert.equal(s._applyIslandComplete(), true);
  assert.equal(s.cellStatus[1], 2);
});

test('NurikabeSolver._applyIslandComplete: white component > N → contradiction', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[1, -1, -1]],
    initialState: [[2, 2, 0]],
  });
  assert.equal(s._applyIslandComplete(), false);
});

test('NurikabeSolver._applyIslandComplete: capacity < N → contradiction', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[3, -1, -1]],
    initialState: [[2, 0, 1]],
  });
  assert.equal(s._applyIslandComplete(), false);
});

test('NurikabeSolver._apply2x2: 4 blacks in 2x2 → contradiction', () => {
  const s = new NurikabeSolver({
    rows: 2, cols: 2,
    task: [[-1, -1], [-1, -1]],
    initialState: [[1, 1], [1, 1]],
  });
  assert.equal(s._apply2x2(), false);
});

test('NurikabeSolver._apply2x2: 3 blacks + 1 unknown in 2x2 → unknown forced WHITE', () => {
  const s = new NurikabeSolver({
    rows: 2, cols: 2,
    task: [[-1, -1], [-1, -1]],
    initialState: [[1, 1], [1, 0]],
  });
  assert.equal(s._apply2x2(), true);
  assert.equal(s.cellStatus[3], 2);
});

test('NurikabeSolver._applyBlackCount: too many blacks → contradiction', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[2, -1, -1]],
    initialState: [[2, 1, 1]],
  });
  assert.equal(s._applyBlackCount(), false);
});

test('NurikabeSolver._applyBlackCount: nB + nU == expected → all unknowns BLACK', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[1, -1, -1]],
    initialState: [[2, 0, 1]],
  });
  assert.equal(s._applyBlackCount(), true);
  assert.equal(s.cellStatus[1], 1);
});

test('NurikabeSolver._applySeaConnectivity: two BLACKs separated only by all-WHITE → contradiction', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[-1, 1, -1]],
    initialState: [[1, 2, 1]],
  });
  assert.equal(s._applySeaConnectivity(), false);
});

test('NurikabeSolver._applySeaConnectivity: connected via UNKNOWN is fine', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[-1, -1, -1]],
    initialState: [[1, 0, 1]],
  });
  assert.equal(s._applySeaConnectivity(), true);
});

test('NurikabeSolver._propagate: fixpoint solves trivial 1x2 clue 2', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 2,
    task: [[2, -1]],
  });
  assert.equal(s._propagate(), true);
  assert.equal(s.cellStatus[0], 2);
  assert.equal(s.cellStatus[1], 2);
});

test('NurikabeSolver._propagate: returns false on inherent contradiction', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[1, 1, -1]],
  });
  assert.equal(s.contradiction, true);
});

test('NurikabeSolver.solve: solves trivial 1x2 clue 2', () => {
  NurikabeSolver.clearSolutionCache();
  const s = new NurikabeSolver({
    rows: 1, cols: 2,
    task: [[2, -1]],
    maxMs: 5000,
  });
  const r = s.solve();
  assert.equal(r.solved, true);
  assert.deepEqual(r.grid, [[2, 2]]);
});

test('NurikabeSolver.solve: solves unsat returning {solved:false, grid:null}', () => {
  NurikabeSolver.clearSolutionCache();
  const s = new NurikabeSolver({
    rows: 1, cols: 2,
    task: [[1, 1]],
    maxMs: 5000,
  });
  const r = s.solve();
  assert.equal(r.solved, false);
  assert.equal(r.grid, null);
});

test('NurikabeSolver._solutionCache: cache hit returns deep copy', () => {
  NurikabeSolver.clearSolutionCache();
  const opts = { rows: 1, cols: 2, task: [[2, -1]] };
  const a = new NurikabeSolver(opts).solve();
  a.grid[0][0] = 99;
  const b = new NurikabeSolver(opts).solve();
  assert.notEqual(b.grid[0][0], 99);
});

test('computePuzzleDiff nurikabe: flags wrong-color non-clue cells', () => {
  const solution = [[2, 1], [1, 2]];
  const board = [[2, 2], [1, 2]];
  const diff = computePuzzleDiff('nurikabe', board, solution);
  assert.equal(diff.length, 1);
  assert.deepEqual(diff[0], { row: 0, col: 1, expected: 1, actual: 2 });
});

test('NurikabeSolver.getHint: 1x2 clue 2 yields the other white as a hint', () => {
  NurikabeSolver.clearSolutionCache();
  const s = new NurikabeSolver({
    rows: 1, cols: 2,
    task: [[2, -1]],
  });
  const hint = s.getHint([[2, 0]]);
  assert.ok(Array.isArray(hint));
  assert.ok(hint.some(h => h.row === 0 && h.col === 1 && h.value === 2));
});

test('NurikabeSolver.getHint: null on already-solved board', () => {
  NurikabeSolver.clearSolutionCache();
  const s = new NurikabeSolver({
    rows: 1, cols: 2,
    task: [[2, -1]],
  });
  assert.equal(s.getHint([[2, 2]]), null);
});

test('NurikabeSolver: wall cells (task=-2) are off-board, excluded from expectedBlacks', () => {
  // 2x2: top-left clue size 2, top-right wall, bottom both blank.
  // Board cells: 3 (excluding the wall). Clue value = 2. So expectedBlacks = 3 - 2 = 1.
  const s = new NurikabeSolver({
    rows: 2, cols: 2,
    task: [[2, -2], [-1, -1]],
  });
  assert.equal(s.contradiction, false);
  assert.equal(s.isWall[1], 1);
  assert.equal(s.isWall[0], 0);
  assert.equal(s.expectedBlacks, 1);
  const r = s.solve();
  assert.equal(r.solved, true);
  // Wall stays 0; clue stays WHITE; one more WHITE; one BLACK.
  assert.equal(r.grid[0][1], 0);
});

test('NurikabeSolver: walls disable 2x2 black violation', () => {
  // 2x2 with a wall at top-right. Force the other 3 cells BLACK — shouldn't be a violation.
  const s = new NurikabeSolver({
    rows: 2, cols: 2,
    task: [[-1, -2], [-1, -1]],
    initialState: [[1, 0], [1, 1]],
  });
  assert.equal(s._apply2x2(), true);
});

test('NurikabeSolver: walls block BFS reach', () => {
  // 1x4 with clue 2 at (0,0), wall at (0,1), blanks at (0,2)(0,3).
  // Clue's reach = just itself (wall blocks). Capacity < 2 → contradiction.
  const s = new NurikabeSolver({
    rows: 1, cols: 4,
    task: [[2, -2, -1, -1]],
  });
  assert.equal(s.contradiction, true);
});
