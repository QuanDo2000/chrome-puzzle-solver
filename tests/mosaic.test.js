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

test('MosaicSolver._buildNeighborhoods: interior clue has 9 cells', () => {
  const s = new MosaicSolver({
    rows: 3, cols: 3,
    task: [[-1,-1,-1],[-1,5,-1],[-1,-1,-1]],
  });
  assert.equal(s.clueNeighborhood[0].length, 9);
  const set = new Set(Array.from(s.clueNeighborhood[0]));
  for (let i = 0; i < 9; i++) assert.ok(set.has(i));
});

test('MosaicSolver._buildNeighborhoods: corner clue has 4 cells', () => {
  const s = new MosaicSolver({
    rows: 3, cols: 3,
    task: [[2,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  assert.equal(s.clueNeighborhood[0].length, 4);
  assert.deepEqual(Array.from(s.clueNeighborhood[0]).sort((a,b)=>a-b), [0, 1, 3, 4]);
});

test('MosaicSolver._buildNeighborhoods: edge clue has 6 cells', () => {
  const s = new MosaicSolver({
    rows: 3, cols: 3,
    task: [[-1,4,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  assert.equal(s.clueNeighborhood[0].length, 6);
  assert.deepEqual(Array.from(s.clueNeighborhood[0]).sort((a,b)=>a-b), [0, 1, 2, 3, 4, 5]);
});

test('MosaicSolver._applyClues: K=0 forces neighborhood to white', () => {
  const s = new MosaicSolver({
    rows: 3, cols: 3,
    task: [[0,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  assert.equal(s._applyClues(), true);
  assert.equal(s.cellStatus[0], 2);
  assert.equal(s.cellStatus[1], 2);
  assert.equal(s.cellStatus[3], 2);
  assert.equal(s.cellStatus[4], 2);
});

test('MosaicSolver._applyClues: K=neighborhood-size forces all black', () => {
  const s = new MosaicSolver({
    rows: 3, cols: 3,
    task: [[-1,-1,-1],[-1,9,-1],[-1,-1,-1]],
  });
  assert.equal(s._applyClues(), true);
  for (let i = 0; i < 9; i++) assert.equal(s.cellStatus[i], 1);
});

test('MosaicSolver._applyClues: contradiction when K > neighborhood', () => {
  const s = new MosaicSolver({
    rows: 3, cols: 3,
    task: [[5,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  assert.equal(s._applyClues(), false);
});

test('MosaicSolver._applyClues: contradiction when K < known blacks', () => {
  const s = new MosaicSolver({
    rows: 3, cols: 3,
    task: [[0,-1,-1],[-1,-1,-1],[-1,-1,-1]],
    initialState: [[0, 1, 0], [0, 0, 0], [0, 0, 0]],
  });
  assert.equal(s._applyClues(), false);
});

test('MosaicSolver._propagate: cascades through overlapping clues', () => {
  // K=0 at (0,0) forces (0,0)..(1,1) white. K=3 at (1,2) neighborhood has those whites
  // + 2 unknowns; impossible to make 3 blacks → contradiction.
  const s = new MosaicSolver({
    rows: 2, cols: 3,
    task: [[0,-1,-1],[-1,-1,3]],
  });
  assert.equal(s._propagate(), false);
});

test('MosaicSolver._propagate: returns true on consistent input', () => {
  const s = new MosaicSolver({
    rows: 3, cols: 3,
    task: [[-1,-1,-1],[-1,9,-1],[-1,-1,-1]],
  });
  assert.equal(s._propagate(), true);
});

test('MosaicSolver.solve: solves recon 5x5', () => {
  MosaicSolver.clearSolutionCache();
  const s = new MosaicSolver({
    rows: 5, cols: 5,
    task: [
      [-1,4,-1,-1,1],
      [-1,-1,-1,-1,-1],
      [-1,-1,2,3,-1],
      [-1,3,-1,-1,2],
      [0,-1,4,-1,-1],
    ],
    maxMs: 5000,
  });
  const r = s.solve();
  assert.equal(r.solved, true);
  for (const row of r.grid) for (const v of row) assert.notEqual(v, 0);
});

test('MosaicSolver.solve: unsat returns {solved:false, grid:null}', () => {
  MosaicSolver.clearSolutionCache();
  const s = new MosaicSolver({
    rows: 3, cols: 3,
    task: [[5,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  const r = s.solve();
  assert.equal(r.solved, false);
  assert.equal(r.grid, null);
});

test('MosaicSolver._solutionCache: cache hit returns deep copy', () => {
  MosaicSolver.clearSolutionCache();
  const opts = { rows: 3, cols: 3, task: [[-1,-1,-1],[-1,9,-1],[-1,-1,-1]] };
  const a = new MosaicSolver(opts).solve();
  a.grid[0][0] = 99;
  const b = new MosaicSolver(opts).solve();
  assert.notEqual(b.grid[0][0], 99);
});

test('computePuzzleDiff mosaic: flags wrong-color cells, ignores unknown', () => {
  const { computePuzzleDiff } = require('../solver.js');
  const solution = [[1, 2], [2, 1]];
  const board = [[2, 2], [0, 1]];
  const diff = computePuzzleDiff('mosaic', board, solution);
  assert.equal(diff.length, 1);
  assert.deepEqual(diff[0], { row: 0, col: 0, expected: 1, actual: 2 });
});
