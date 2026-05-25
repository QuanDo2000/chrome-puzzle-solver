'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { NorinoriSolver, computePuzzleDiff } = require('../solver.js');

test('NorinoriSolver: constructor mirrors rooms and cellToRoom', () => {
  const s = new NorinoriSolver({
    rows: 2, cols: 2,
    rooms: [
      { cells: [{r: 0, c: 0}, {r: 0, c: 1}] },
      { cells: [{r: 1, c: 0}, {r: 1, c: 1}] },
    ],
  });
  assert.equal(s.rows, 2);
  assert.equal(s.K, 2);
  assert.equal(s.cellToRoom[0], 0);
  assert.equal(s.cellToRoom[1], 0);
  assert.equal(s.cellToRoom[2], 1);
  assert.equal(s.cellToRoom[3], 1);
});

test('NorinoriSolver: _set black forces CROSS-region neighbours to white', () => {
  const s = new NorinoriSolver({
    rows: 2, cols: 3,
    rooms: [
      { cells: [{r: 0, c: 0}, {r: 0, c: 1}, {r: 0, c: 2}] },
      { cells: [{r: 1, c: 0}, {r: 1, c: 1}, {r: 1, c: 2}] },
    ],
  });
  assert.equal(s._set(1, 1), true);
  assert.equal(s.cellStatus[1], 1);
  assert.equal(s.cellStatus[4], 2);
  assert.equal(s.cellStatus[0], 0);
  assert.equal(s.cellStatus[2], 0);
});

test('NorinoriSolver: _set cross-region black-on-black → contradiction', () => {
  const s = new NorinoriSolver({
    rows: 2, cols: 2,
    rooms: [
      { cells: [{r: 0, c: 0}, {r: 0, c: 1}] },
      { cells: [{r: 1, c: 0}, {r: 1, c: 1}] },
    ],
    initialState: [[1, 0], [0, 0]],
  });
  assert.equal(s._set(2, 1), false);
});

test('NorinoriSolver: _set same-region black-adjacent is OK (domino)', () => {
  const s = new NorinoriSolver({
    rows: 1, cols: 2,
    rooms: [{cells: [{r: 0, c: 0}, {r: 0, c: 1}]}],
    initialState: [[1, 0]],
  });
  assert.equal(s._set(1, 1), true);
  assert.equal(s.cellStatus[1], 1);
});

test('NorinoriSolver: _set / _rollback round-trip', () => {
  const s = new NorinoriSolver({
    rows: 1, cols: 2,
    rooms: [{cells: [{r: 0, c: 0}, {r: 0, c: 1}]}],
  });
  const mark = s.trail.length;
  assert.equal(s._set(0, 2), true);
  s._rollback(mark);
  assert.equal(s.cellStatus[0], 0);
});

test('NorinoriSolver._buildDominoCandidates: 1x2 region has 1 candidate', () => {
  const s = new NorinoriSolver({
    rows: 1, cols: 2,
    rooms: [{cells: [{r: 0, c: 0}, {r: 0, c: 1}]}],
  });
  assert.equal(s.dominoCandidates[0].length, 1);
  assert.deepEqual(Array.from(s.dominoCandidates[0][0]), [0, 1]);
});

test('NorinoriSolver._buildDominoCandidates: L-shaped region has 2 candidates', () => {
  const s = new NorinoriSolver({
    rows: 2, cols: 2,
    rooms: [
      { cells: [{r: 0, c: 0}, {r: 1, c: 0}, {r: 1, c: 1}] },
      { cells: [{r: 0, c: 1}] },
    ],
  });
  assert.equal(s.dominoCandidates[0].length, 2);
});

test('NorinoriSolver._buildDominoCandidates: 2x2 region has 4 candidates', () => {
  const s = new NorinoriSolver({
    rows: 2, cols: 2,
    rooms: [{cells: [{r: 0, c: 0}, {r: 0, c: 1}, {r: 1, c: 0}, {r: 1, c: 1}]}],
  });
  assert.equal(s.dominoCandidates[0].length, 4);
});

test('NorinoriSolver._buildDominoCandidates: isolated cell has 0 candidates', () => {
  const s = new NorinoriSolver({
    rows: 1, cols: 2,
    rooms: [
      { cells: [{r: 0, c: 0}] },
      { cells: [{r: 0, c: 1}] },
    ],
  });
  assert.equal(s.dominoCandidates[0].length, 0);
  assert.equal(s.dominoCandidates[1].length, 0);
});

test('NorinoriSolver._applyDominoes: nB=2 non-adjacent → contradiction', () => {
  const s = new NorinoriSolver({
    rows: 1, cols: 3,
    rooms: [{cells: [{r: 0, c: 0}, {r: 0, c: 1}, {r: 0, c: 2}]}],
    initialState: [[1, 0, 1]],
  });
  assert.equal(s._applyDominoes(), false);
});

test('NorinoriSolver._applyDominoes: nB=2 adjacent → other cells forced white', () => {
  const s = new NorinoriSolver({
    rows: 1, cols: 3,
    rooms: [{cells: [{r: 0, c: 0}, {r: 0, c: 1}, {r: 0, c: 2}]}],
    initialState: [[1, 1, 0]],
  });
  assert.equal(s._applyDominoes(), true);
  assert.equal(s.cellStatus[2], 2);
});

test('NorinoriSolver._applyDominoes: nB=1 with only one same-region neighbour → force partner', () => {
  const s = new NorinoriSolver({
    rows: 1, cols: 2,
    rooms: [{cells: [{r: 0, c: 0}, {r: 0, c: 1}]}],
    initialState: [[1, 0]],
  });
  assert.equal(s._applyDominoes(), true);
  assert.equal(s.cellStatus[1], 1);
});

test('NorinoriSolver._applyDominoes: nB=0 with only one live candidate → both cells forced black', () => {
  const s = new NorinoriSolver({
    rows: 1, cols: 2,
    rooms: [{cells: [{r: 0, c: 0}, {r: 0, c: 1}]}],
  });
  assert.equal(s._applyDominoes(), true);
  assert.equal(s.cellStatus[0], 1);
  assert.equal(s.cellStatus[1], 1);
});

test('NorinoriSolver._applyDominoes: nB=0, multiple candidates → cell in every candidate forced black', () => {
  const s = new NorinoriSolver({
    rows: 2, cols: 2,
    rooms: [
      { cells: [{r: 0, c: 0}, {r: 1, c: 0}, {r: 1, c: 1}] },
      { cells: [{r: 0, c: 1}] },
    ],
  });
  assert.equal(s._applyDominoes(), true);
  assert.equal(s.cellStatus[2], 1);
  assert.equal(s.cellStatus[0], 0);
  assert.equal(s.cellStatus[3], 0);
});

test('NorinoriSolver._applyDominoes: nB=0 with 0 live candidates → contradiction', () => {
  const s = new NorinoriSolver({
    rows: 1, cols: 2,
    rooms: [{cells: [{r: 0, c: 0}, {r: 0, c: 1}]}],
    initialState: [[2, 2]],
  });
  assert.equal(s._applyDominoes(), false);
});

test('NorinoriSolver._applyCrossRegionDominate: cell adjacent to a region where every candidate touches it → forced white', () => {
  // 2x3 grid, two row-regions.
  // Region 0 (row 0): cells (0,0),(0,1),(0,2). Domino candidates:
  //   (0,0)-(0,1) and (0,1)-(0,2). Both contain (0,1).
  // Region 1 (row 1): cell (1,1) is 4-adjacent to (0,1) (cross-region).
  //   Since both region-0 candidates touch (0,1), (1,1) must be white.
  const s = new NorinoriSolver({
    rows: 2, cols: 3,
    rooms: [
      { cells: [{r: 0, c: 0}, {r: 0, c: 1}, {r: 0, c: 2}] },
      { cells: [{r: 1, c: 0}, {r: 1, c: 1}, {r: 1, c: 2}] },
    ],
  });
  assert.equal(s._applyCrossRegionDominate(), true);
  assert.equal(s.cellStatus[4], 2); // (1,1) forced white
});

test('NorinoriSolver._propagate: cascades dominoes + cross-region rules', () => {
  // 1x4 with two 2-cell regions. Each forces black domino → cross-region
  // blacks adjacent → contradiction.
  const s = new NorinoriSolver({
    rows: 1, cols: 4,
    rooms: [
      { cells: [{r: 0, c: 0}, {r: 0, c: 1}] },
      { cells: [{r: 0, c: 2}, {r: 0, c: 3}] },
    ],
  });
  assert.equal(s._propagate(), false);
});

test('NorinoriSolver._propagate: returns true on a consistent single-region puzzle', () => {
  const s = new NorinoriSolver({
    rows: 1, cols: 2,
    rooms: [{cells: [{r: 0, c: 0}, {r: 0, c: 1}]}],
  });
  assert.equal(s._propagate(), true);
});

test('NorinoriSolver.solve: solves the recon 6x6', () => {
  NorinoriSolver.clearSolutionCache();
  const areas = [
    [0,0,1,1,1,2],
    [0,0,0,1,2,2],
    [3,0,0,4,4,2],
    [3,0,0,5,6,6],
    [3,3,0,5,6,6],
    [7,7,5,5,5,6],
  ];
  const cellsByRoom = {};
  for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) {
    const k = areas[r][c];
    if (!cellsByRoom[k]) cellsByRoom[k] = [];
    cellsByRoom[k].push({r, c});
  }
  const rooms = Object.keys(cellsByRoom).sort((a, b) => +a - +b)
    .map(k => ({cells: cellsByRoom[k]}));
  const s = new NorinoriSolver({rows: 6, cols: 6, rooms, maxMs: 5000});
  const r = s.solve();
  assert.equal(r.solved, true);
  for (const room of rooms) {
    const blacks = [];
    for (const cell of room.cells) {
      if (r.grid[cell.r][cell.c] === 1) blacks.push(cell);
    }
    assert.equal(blacks.length, 2);
    const dr = Math.abs(blacks[0].r - blacks[1].r);
    const dc = Math.abs(blacks[0].c - blacks[1].c);
    assert.equal(dr + dc, 1);
  }
});

test('NorinoriSolver.solve: unsat returns {solved:false, grid:null}', () => {
  NorinoriSolver.clearSolutionCache();
  // 1x4 with two 2-cell regions: each forces a domino that's cross-region
  // adjacent → unsat.
  const s = new NorinoriSolver({
    rows: 1, cols: 4,
    rooms: [
      { cells: [{r: 0, c: 0}, {r: 0, c: 1}] },
      { cells: [{r: 0, c: 2}, {r: 0, c: 3}] },
    ],
  });
  const r = s.solve();
  assert.equal(r.solved, false);
  assert.equal(r.grid, null);
});

test('NorinoriSolver._solutionCache: cache hit returns deep copy', () => {
  NorinoriSolver.clearSolutionCache();
  const opts = {
    rows: 1, cols: 2,
    rooms: [{cells: [{r: 0, c: 0}, {r: 0, c: 1}]}],
  };
  const a = new NorinoriSolver(opts).solve();
  a.grid[0][0] = 99;
  const b = new NorinoriSolver(opts).solve();
  assert.notEqual(b.grid[0][0], 99);
});

test('computePuzzleDiff norinori: flags wrong-color cells, ignores unknown', () => {
  const solution = [[1, 2], [2, 1]];
  const board = [[2, 2], [0, 1]];
  const diff = computePuzzleDiff('norinori', board, solution);
  assert.equal(diff.length, 1);
  assert.deepEqual(diff[0], { row: 0, col: 0, expected: 1, actual: 2 });
});

test('NorinoriSolver.getHint: 1x2 single region yields immediate blacks', () => {
  NorinoriSolver.clearSolutionCache();
  const s = new NorinoriSolver({
    rows: 1, cols: 2,
    rooms: [{cells: [{r: 0, c: 0}, {r: 0, c: 1}]}],
  });
  const hint = s.getHint([[0, 0]]);
  assert.ok(Array.isArray(hint));
  assert.ok(hint.length === 2);
  for (const h of hint) assert.equal(h.value, 1);
});

test('NorinoriSolver.getHint: null on solved board', () => {
  NorinoriSolver.clearSolutionCache();
  const s = new NorinoriSolver({
    rows: 1, cols: 2,
    rooms: [{cells: [{r: 0, c: 0}, {r: 0, c: 1}]}],
  });
  assert.equal(s.getHint([[1, 1]]), null);
});
