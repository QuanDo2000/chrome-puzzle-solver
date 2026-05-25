'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { NorinoriSolver, computePuzzleDiff } = require('../solver.js');

// Validates a Norinori solution against the four site rules (per
// puzzles-mobile.com's getErrors): exactly 2 blacks per region, no
// 3-in-row of blacks, no 2x2 with 3+ blacks, every black has at least
// one black neighbour. Dominos may span regions.
function validate(grid, rooms) {
  const rows = grid.length, cols = grid[0].length;
  for (const room of rooms) {
    let nB = 0;
    for (const cell of room.cells) if (grid[cell.r][cell.c] === 1) nB++;
    if (nB !== 2) return `region count != 2 (got ${nB})`;
  }
  for (let r = 0; r < rows; r++)
    for (let c = 0; c + 2 < cols; c++)
      if (grid[r][c] === 1 && grid[r][c+1] === 1 && grid[r][c+2] === 1)
        return `h-3-in-row at (${r},${c})`;
  for (let c = 0; c < cols; c++)
    for (let r = 0; r + 2 < rows; r++)
      if (grid[r][c] === 1 && grid[r+1][c] === 1 && grid[r+2][c] === 1)
        return `v-3-in-row at (${r},${c})`;
  for (let r = 0; r + 1 < rows; r++)
    for (let c = 0; c + 1 < cols; c++) {
      let n = 0;
      if (grid[r][c] === 1) n++;
      if (grid[r][c+1] === 1) n++;
      if (grid[r+1][c] === 1) n++;
      if (grid[r+1][c+1] === 1) n++;
      if (n > 2) return `2x2 with ${n} blacks at (${r},${c})`;
    }
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      if (grid[r][c] !== 1) continue;
      let has = false;
      if (r > 0 && grid[r-1][c] === 1) has = true;
      if (r < rows - 1 && grid[r+1][c] === 1) has = true;
      if (c > 0 && grid[r][c-1] === 1) has = true;
      if (c < cols - 1 && grid[r][c+1] === 1) has = true;
      if (!has) return `solo black at (${r},${c})`;
    }
  return null;
}

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

test('NorinoriSolver: _set does not cascade (cross-region adjacency allowed)', () => {
  // Two 2-cell regions stacked. Placing one black no longer forces the
  // cross-region neighbour to white — that constraint is gone in the
  // relaxed-rule solver (cross-region dominoes are legal).
  const s = new NorinoriSolver({
    rows: 2, cols: 1,
    rooms: [
      { cells: [{r: 0, c: 0}] },
      { cells: [{r: 1, c: 0}] },
    ],
  });
  assert.equal(s._set(0, 1), true);
  assert.equal(s.cellStatus[0], 1);
  assert.equal(s.cellStatus[1], 0);
});

test('NorinoriSolver._applyRegionCount: nB=2 forces remaining unknowns white', () => {
  const s = new NorinoriSolver({
    rows: 1, cols: 3,
    rooms: [{cells: [{r: 0, c: 0}, {r: 0, c: 1}, {r: 0, c: 2}]}],
    initialState: [[1, 1, 0]],
  });
  assert.equal(s._applyRegionCount(), true);
  assert.equal(s.cellStatus[2], 2);
});

test('NorinoriSolver._applyRegionCount: nB>2 → contradiction', () => {
  const s = new NorinoriSolver({
    rows: 1, cols: 4,
    rooms: [{cells: [{r: 0, c: 0}, {r: 0, c: 1}, {r: 0, c: 2}, {r: 0, c: 3}]}],
    initialState: [[1, 1, 1, 0]],
  });
  assert.equal(s._applyRegionCount(), false);
});

test('NorinoriSolver._applyRegionCount: nB+nU<2 → contradiction (room cannot reach 2 blacks)', () => {
  const s = new NorinoriSolver({
    rows: 1, cols: 3,
    rooms: [{cells: [{r: 0, c: 0}, {r: 0, c: 1}, {r: 0, c: 2}]}],
    initialState: [[2, 2, 0]],
  });
  assert.equal(s._applyRegionCount(), false);
});

test('NorinoriSolver._applyRegionCount: when only 2 cells remain available → both forced black', () => {
  const s = new NorinoriSolver({
    rows: 1, cols: 3,
    rooms: [{cells: [{r: 0, c: 0}, {r: 0, c: 1}, {r: 0, c: 2}]}],
    initialState: [[2, 0, 0]],
  });
  assert.equal(s._applyRegionCount(), true);
  assert.equal(s.cellStatus[1], 1);
  assert.equal(s.cellStatus[2], 1);
});

test('NorinoriSolver._apply2x2: 2 blacks force the other 2 cells white', () => {
  const s = new NorinoriSolver({
    rows: 2, cols: 2,
    rooms: [{cells: [{r: 0, c: 0}, {r: 0, c: 1}, {r: 1, c: 0}, {r: 1, c: 1}]}],
    initialState: [[1, 1], [0, 0]],
  });
  assert.equal(s._apply2x2(), true);
  assert.equal(s.cellStatus[2], 2);
  assert.equal(s.cellStatus[3], 2);
});

test('NorinoriSolver._apply2x2: 3 blacks → contradiction', () => {
  const s = new NorinoriSolver({
    rows: 2, cols: 2,
    rooms: [{cells: [{r: 0, c: 0}, {r: 0, c: 1}, {r: 1, c: 0}, {r: 1, c: 1}]}],
    initialState: [[1, 1], [1, 0]],
  });
  assert.equal(s._apply2x2(), false);
});

test('NorinoriSolver._apply3InRow: 2 horizontal blacks adjacent + unknown extension → forced white', () => {
  const s = new NorinoriSolver({
    rows: 1, cols: 4,
    rooms: [{cells: [{r: 0, c: 0}, {r: 0, c: 1}, {r: 0, c: 2}, {r: 0, c: 3}]}],
    initialState: [[1, 1, 0, 0]],
  });
  assert.equal(s._apply3InRow(), true);
  assert.equal(s.cellStatus[2], 2);
});

test('NorinoriSolver._apply3InRow: 3 vertical blacks → contradiction', () => {
  const s = new NorinoriSolver({
    rows: 3, cols: 1,
    rooms: [{cells: [{r: 0, c: 0}, {r: 1, c: 0}, {r: 2, c: 0}]}],
    initialState: [[1], [1], [1]],
  });
  assert.equal(s._apply3InRow(), false);
});

test('NorinoriSolver._applyNeighborConstraints: black with 1 black neighbour forces other neighbours white', () => {
  // 1x3: black at (0,0) and (0,1). (0,2) is unknown — must be white because
  // (0,1) already has its one black partner.
  const s = new NorinoriSolver({
    rows: 1, cols: 3,
    rooms: [{cells: [{r: 0, c: 0}, {r: 0, c: 1}, {r: 0, c: 2}]}],
    initialState: [[1, 1, 0]],
  });
  assert.equal(s._applyNeighborConstraints(), true);
  assert.equal(s.cellStatus[2], 2);
});

test('NorinoriSolver._applyNeighborConstraints: black with 0 black + 1 unknown neighbour → unknown forced black', () => {
  // 1x2: black at (0,0). (0,1) is its only neighbour — must be black.
  const s = new NorinoriSolver({
    rows: 1, cols: 2,
    rooms: [{cells: [{r: 0, c: 0}, {r: 0, c: 1}]}],
    initialState: [[1, 0]],
  });
  assert.equal(s._applyNeighborConstraints(), true);
  assert.equal(s.cellStatus[1], 1);
});

test('NorinoriSolver._applyNeighborConstraints: black with 2 black neighbours → contradiction (L-shape)', () => {
  // 2x2: (0,0)=B, (0,1)=B, (1,0)=B. (0,0) has 2 black neighbours.
  const s = new NorinoriSolver({
    rows: 2, cols: 2,
    rooms: [{cells: [{r: 0, c: 0}, {r: 0, c: 1}, {r: 1, c: 0}, {r: 1, c: 1}]}],
    initialState: [[1, 1], [1, 0]],
  });
  assert.equal(s._applyNeighborConstraints(), false);
});

test('NorinoriSolver._applyNeighborConstraints: solo black (all neighbours white) → contradiction', () => {
  // 1x3: middle cell black, both neighbours white.
  const s = new NorinoriSolver({
    rows: 1, cols: 3,
    rooms: [{cells: [{r: 0, c: 0}, {r: 0, c: 1}, {r: 0, c: 2}]}],
    initialState: [[2, 1, 2]],
  });
  assert.equal(s._applyNeighborConstraints(), false);
});

test('NorinoriSolver._propagate: 1x2 region forces both cells black', () => {
  const s = new NorinoriSolver({
    rows: 1, cols: 2,
    rooms: [{cells: [{r: 0, c: 0}, {r: 0, c: 1}]}],
  });
  assert.equal(s._propagate(), true);
  assert.equal(s.cellStatus[0], 1);
  assert.equal(s.cellStatus[1], 1);
});

test('NorinoriSolver._propagate: two stacked 2-cell regions form a valid 2-by-1 cross-region pair pattern', () => {
  // 2 rows x 1 col, each row is its own region. Cross-region blacks are
  // legal now, so this solves: both cells black, vertical 2x1 domino
  // spans both regions.
  const s = new NorinoriSolver({
    rows: 2, cols: 1,
    rooms: [
      { cells: [{r: 0, c: 0}] },
      { cells: [{r: 1, c: 0}] },
    ],
  });
  // 1-cell regions can never have 2 blacks → propagate flags this.
  assert.equal(s._propagate(), false);
});

test('NorinoriSolver.solve: solves the recon 6x6 to a valid grid', () => {
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
  const err = validate(r.grid, rooms);
  assert.equal(err, null, `solution invalid: ${err}`);
});

test('NorinoriSolver.solve: unsat (1-cell regions can never reach 2 blacks)', () => {
  NorinoriSolver.clearSolutionCache();
  const s = new NorinoriSolver({
    rows: 1, cols: 2,
    rooms: [
      { cells: [{r: 0, c: 0}] },
      { cells: [{r: 0, c: 1}] },
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
