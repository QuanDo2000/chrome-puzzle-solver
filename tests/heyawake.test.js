'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { HeyawakeSolver } = require('../solver.js');

test('HeyawakeSolver: constructor mirrors initialState and indexes rooms', () => {
  const s = new HeyawakeSolver({
    rows: 2, cols: 2,
    rooms: [
      { cells: [{ r: 0, c: 0 }, { r: 0, c: 1 }], target: 1 },
      { cells: [{ r: 1, c: 0 }, { r: 1, c: 1 }], target: -1 },
    ],
    initialState: [[0, 1], [2, 0]],
  });
  assert.equal(s.rows, 2);
  assert.equal(s.cols, 2);
  assert.equal(s.K, 2);
  assert.equal(s.cellStatus[0], 0);
  assert.equal(s.cellStatus[1], 1);
  assert.equal(s.cellStatus[2], 2);
  assert.equal(s.cellStatus[3], 0);
  assert.equal(s.cellToRoom[0], 0);
  assert.equal(s.cellToRoom[1], 0);
  assert.equal(s.cellToRoom[2], 1);
  assert.equal(s.cellToRoom[3], 1);
  assert.equal(s.target[0], 1);
  assert.equal(s.target[1], -1);
});

test('HeyawakeSolver: _set / _rollback round-trip', () => {
  const s = new HeyawakeSolver({
    rows: 1, cols: 2,
    rooms: [
      { cells: [{ r: 0, c: 0 }, { r: 0, c: 1 }], target: -1 },
    ],
  });
  const mark = s.trail.length;
  assert.equal(s._set(0, 2), true);
  assert.equal(s.cellStatus[0], 2);
  assert.equal(s.trail.length, mark + 1);
  // No-op on same value
  assert.equal(s._set(0, 2), true);
  assert.equal(s.trail.length, mark + 1);
  // Conflicting write returns false
  assert.equal(s._set(0, 1), false);
  s._rollback(mark);
  assert.equal(s.cellStatus[0], 0);
});

test('HeyawakeSolver._applyRoomCounts: saturated room forces unknowns to white', () => {
  const s = new HeyawakeSolver({
    rows: 1, cols: 4,
    rooms: [
      { cells: [
        { r: 0, c: 0 }, { r: 0, c: 1 }, { r: 0, c: 2 }, { r: 0, c: 3 },
      ], target: 2 },
    ],
    initialState: [[1, 1, 0, 0]], // 2 blacks already in
  });
  assert.equal(s._applyRoomCounts(), true);
  assert.equal(s.cellStatus[2], 2);
  assert.equal(s.cellStatus[3], 2);
});

test('HeyawakeSolver._applyRoomCounts: must-saturate forces unknowns to black', () => {
  // Use non-adjacent unknowns (cols 0 and 2) so rule 2 doesn't fire
  const s = new HeyawakeSolver({
    rows: 1, cols: 4,
    rooms: [
      { cells: [
        { r: 0, c: 0 }, { r: 0, c: 1 }, { r: 0, c: 2 }, { r: 0, c: 3 },
      ], target: 2 },
    ],
    initialState: [[0, 2, 0, 2]], // 2 whites, 2 unknowns at cols 0 and 2 (non-adjacent) → both must be black
  });
  assert.equal(s._applyRoomCounts(), true);
  assert.equal(s.cellStatus[0], 1);
  assert.equal(s.cellStatus[2], 1);
});

test('HeyawakeSolver._applyRoomCounts: too many blacks → contradiction', () => {
  const s = new HeyawakeSolver({
    rows: 1, cols: 3,
    rooms: [
      { cells: [{ r: 0, c: 0 }, { r: 0, c: 1 }, { r: 0, c: 2 }], target: 1 },
    ],
    initialState: [[1, 1, 0]], // 2 blacks, target 1
  });
  assert.equal(s._applyRoomCounts(), false);
});

test('HeyawakeSolver._applyRoomCounts: -1 target is unconstrained', () => {
  const s = new HeyawakeSolver({
    rows: 1, cols: 3,
    rooms: [
      { cells: [{ r: 0, c: 0 }, { r: 0, c: 1 }, { r: 0, c: 2 }], target: -1 },
    ],
    initialState: [[1, 1, 0]],
  });
  assert.equal(s._applyRoomCounts(), true);
  assert.equal(s.cellStatus[2], 0); // unchanged
});

test('HeyawakeSolver._set: black write forces 4-neighbours to white', () => {
  const s = new HeyawakeSolver({
    rows: 3, cols: 3,
    rooms: [
      { cells: Array.from({ length: 9 }, (_, i) => ({ r: (i / 3) | 0, c: i % 3 })), target: -1 },
    ],
  });
  // Set center to black; expect up/down/left/right forced white
  assert.equal(s._set(4, 1), true);
  assert.equal(s.cellStatus[1], 2); // up
  assert.equal(s.cellStatus[7], 2); // down
  assert.equal(s.cellStatus[3], 2); // left
  assert.equal(s.cellStatus[5], 2); // right
  assert.equal(s.cellStatus[0], 0); // diagonals untouched
});

test('HeyawakeSolver._set: black write next to existing black → contradiction', () => {
  const s = new HeyawakeSolver({
    rows: 1, cols: 2,
    rooms: [{ cells: [{ r: 0, c: 0 }, { r: 0, c: 1 }], target: -1 }],
    initialState: [[1, 0]],
  });
  assert.equal(s._set(1, 1), false);
});

test('HeyawakeSolver._set: white write has no adjacency side effect', () => {
  const s = new HeyawakeSolver({
    rows: 1, cols: 3,
    rooms: [{ cells: [{ r: 0, c: 0 }, { r: 0, c: 1 }, { r: 0, c: 2 }], target: -1 }],
  });
  assert.equal(s._set(1, 2), true);
  assert.equal(s.cellStatus[0], 0); // neighbours unchanged
  assert.equal(s.cellStatus[2], 0);
});

test('HeyawakeSolver._buildLineConstraints: 1x4 with 4 rooms emits 2 minimal spans', () => {
  const s = new HeyawakeSolver({
    rows: 1, cols: 4,
    rooms: [
      { cells: [{ r: 0, c: 0 }], target: -1 },
      { cells: [{ r: 0, c: 1 }], target: -1 },
      { cells: [{ r: 0, c: 2 }], target: -1 },
      { cells: [{ r: 0, c: 3 }], target: -1 },
    ],
  });
  assert.equal(s.lineConstraints.length, 2);
  assert.deepEqual(Array.from(s.lineConstraints[0]), [0, 1, 2]);
  assert.deepEqual(Array.from(s.lineConstraints[1]), [1, 2, 3]);
});

test('HeyawakeSolver._buildLineConstraints: room spanning 2 cells produces wider middle', () => {
  const s = new HeyawakeSolver({
    rows: 1, cols: 5,
    rooms: [
      { cells: [{ r: 0, c: 0 }], target: -1 },
      { cells: [{ r: 0, c: 1 }, { r: 0, c: 2 }], target: -1 },
      { cells: [{ r: 0, c: 3 }], target: -1 },
      { cells: [{ r: 0, c: 4 }], target: -1 },
    ],
  });
  // Triple (0,1,2): cells [0,1,2,3]; triple (1,2,3): cells [2,3,4]
  assert.equal(s.lineConstraints.length, 2);
  assert.deepEqual(Array.from(s.lineConstraints[0]), [0, 1, 2, 3]);
  assert.deepEqual(Array.from(s.lineConstraints[1]), [2, 3, 4]);
});

test('HeyawakeSolver._buildLineConstraints: column scan emits vertical spans', () => {
  const s = new HeyawakeSolver({
    rows: 4, cols: 1,
    rooms: [
      { cells: [{ r: 0, c: 0 }], target: -1 },
      { cells: [{ r: 1, c: 0 }], target: -1 },
      { cells: [{ r: 2, c: 0 }], target: -1 },
      { cells: [{ r: 3, c: 0 }], target: -1 },
    ],
  });
  assert.equal(s.lineConstraints.length, 2);
  assert.deepEqual(Array.from(s.lineConstraints[0]), [0, 1, 2]);
  assert.deepEqual(Array.from(s.lineConstraints[1]), [1, 2, 3]);
});

test('HeyawakeSolver._applyLineConstraints: span with one unknown forces it black', () => {
  const s = new HeyawakeSolver({
    rows: 1, cols: 4,
    rooms: [
      { cells: [{ r: 0, c: 0 }], target: -1 },
      { cells: [{ r: 0, c: 1 }], target: -1 },
      { cells: [{ r: 0, c: 2 }], target: -1 },
      { cells: [{ r: 0, c: 3 }], target: -1 },
    ],
    initialState: [[2, 0, 2, 2]],
  });
  assert.equal(s._applyLineConstraints(), true);
  assert.equal(s.cellStatus[1], 1);
});

test('HeyawakeSolver._applyLineConstraints: all-white span → contradiction', () => {
  const s = new HeyawakeSolver({
    rows: 1, cols: 4,
    rooms: [
      { cells: [{ r: 0, c: 0 }], target: -1 },
      { cells: [{ r: 0, c: 1 }], target: -1 },
      { cells: [{ r: 0, c: 2 }], target: -1 },
      { cells: [{ r: 0, c: 3 }], target: -1 },
    ],
    initialState: [[2, 2, 2, 2]],
  });
  assert.equal(s._applyLineConstraints(), false);
});

test('HeyawakeSolver._applyLineConstraints: span with black is satisfied (no force)', () => {
  const s = new HeyawakeSolver({
    rows: 1, cols: 4,
    rooms: [
      { cells: [{ r: 0, c: 0 }], target: -1 },
      { cells: [{ r: 0, c: 1 }], target: -1 },
      { cells: [{ r: 0, c: 2 }], target: -1 },
      { cells: [{ r: 0, c: 3 }], target: -1 },
    ],
    initialState: [[1, 0, 0, 0]],
  });
  assert.equal(s._applyLineConstraints(), true);
  assert.equal(s.cellStatus[1], 0);
  assert.equal(s.cellStatus[2], 0);
});

test('HeyawakeSolver._applyConnectivity: blacks splitting whites → contradiction', () => {
  const s = new HeyawakeSolver({
    rows: 3, cols: 3,
    rooms: [
      { cells: Array.from({ length: 9 }, (_, i) => ({ r: (i / 3) | 0, c: i % 3 })), target: -1 },
    ],
  });
  s.cellStatus[0] = 2; s.cellStatus[1] = 1; s.cellStatus[2] = 2;
  s.cellStatus[3] = 1; s.cellStatus[4] = 1; s.cellStatus[5] = 1;
  s.cellStatus[6] = 2; s.cellStatus[7] = 1; s.cellStatus[8] = 2;
  assert.equal(s._applyConnectivity(), false);
});

test('HeyawakeSolver._applyConnectivity: reachable whites through unknowns → ok', () => {
  const s = new HeyawakeSolver({
    rows: 3, cols: 3,
    rooms: [
      { cells: Array.from({ length: 9 }, (_, i) => ({ r: (i / 3) | 0, c: i % 3 })), target: -1 },
    ],
    initialState: [[2, 0, 0], [0, 0, 0], [0, 0, 2]],
  });
  assert.equal(s._applyConnectivity(), true);
});

test('HeyawakeSolver._applyConnectivity: no whites yet → ok', () => {
  const s = new HeyawakeSolver({
    rows: 2, cols: 2,
    rooms: [
      { cells: [
        { r: 0, c: 0 }, { r: 0, c: 1 }, { r: 1, c: 0 }, { r: 1, c: 1 },
      ], target: -1 },
    ],
  });
  assert.equal(s._applyConnectivity(), true);
});

test('HeyawakeSolver._applyConnectivity: articulation unknown gets forced white', () => {
  // 3x3:
  //   2 ? 2
  //   1 ? 1
  //   2 ? 2
  // Blacks at (1,0) and (1,2) cut the middle row. Four corners (all white)
  // can only reach each other through the middle column (cells 1, 4, 7).
  // Cell 4 (center) is an articulation point — removing it leaves
  // top whites disconnected from bottom whites. It must be forced white.
  const s = new HeyawakeSolver({
    rows: 3, cols: 3,
    rooms: [
      { cells: Array.from({ length: 9 }, (_, i) => ({ r: (i / 3) | 0, c: i % 3 })), target: -1 },
    ],
  });
  s.cellStatus[0] = 2; s.cellStatus[2] = 2;
  s.cellStatus[3] = 1; s.cellStatus[5] = 1;
  s.cellStatus[6] = 2; s.cellStatus[8] = 2;
  assert.equal(s._applyConnectivity(), true);
  assert.equal(s.cellStatus[4], 2, 'cell 4 (center) must be forced white');
});

test('HeyawakeSolver._applyConnectivity: articulation skipped inside lookahead', () => {
  const s = new HeyawakeSolver({
    rows: 3, cols: 3,
    rooms: [
      { cells: Array.from({ length: 9 }, (_, i) => ({ r: (i / 3) | 0, c: i % 3 })), target: -1 },
    ],
  });
  s.cellStatus[0] = 2; s.cellStatus[2] = 2;
  s.cellStatus[3] = 1; s.cellStatus[5] = 1;
  s.cellStatus[6] = 2; s.cellStatus[8] = 2;
  s._inLookahead = true;
  assert.equal(s._applyConnectivity(), true);
  assert.equal(s.cellStatus[4], 0, 'cell 4 must NOT be forced inside lookahead');
});

test('HeyawakeSolver._propagate: cascades rules to fixpoint', () => {
  // room2 target=0 forces cells 2,3 white via local rules.
  // Lookahead then probes room1: cell 0=white would leave cells 2,3
  // disconnected from cell 0 (connectivity contradiction), so cell 0 is
  // forced black and cell 1 is forced white.
  const s = new HeyawakeSolver({
    rows: 1, cols: 4,
    rooms: [
      { cells: [{ r: 0, c: 0 }, { r: 0, c: 1 }], target: 1 },
      { cells: [{ r: 0, c: 2 }, { r: 0, c: 3 }], target: 0 },
    ],
  });
  assert.equal(s._propagate(), true);
  assert.equal(s.cellStatus[2], 2);
  assert.equal(s.cellStatus[3], 2);
  assert.equal(s.cellStatus[0], 1); // forced black by lookahead
  assert.equal(s.cellStatus[1], 2); // forced white by adjacency
});

test('HeyawakeSolver._propagate: returns false on contradictory input', () => {
  const s = new HeyawakeSolver({
    rows: 1, cols: 2,
    rooms: [
      { cells: [{ r: 0, c: 0 }, { r: 0, c: 1 }], target: 2 },
    ],
    initialState: [[2, 0]],
  });
  assert.equal(s._propagate(), false);
});

test('HeyawakeSolver._applyLookahead: probes force unique survivors', () => {
  // 1x3, room1 cells [0,1] target=1, room2 cell [2] target=1.
  // Probe cell 0 black → cell 1 white (adjacency), room1 saturated, room2
  //   needs cell 2 black, but then cell 1 (white) adjacent to cell 2 (black) — ok.
  // Probe cell 0 white → room1 needs cell 1 black, then cell 2 must be black,
  //   but cell 1 (black) adjacent to cell 2 (black) → CONTRADICTION.
  // Only black survives for cell 0.
  const s = new HeyawakeSolver({
    rows: 1, cols: 3,
    rooms: [
      { cells: [{ r: 0, c: 0 }, { r: 0, c: 1 }], target: 1 },
      { cells: [{ r: 0, c: 2 }], target: 1 },
    ],
  });
  assert.equal(s._applyLookahead(), true);
  assert.equal(s.cellStatus[0], 1, 'cell 0 must be forced black via lookahead');
});

test('HeyawakeSolver.solve: 2x2 trivial puzzle (target 1 single room)', () => {
  const s = new HeyawakeSolver({
    rows: 2, cols: 2,
    rooms: [
      { cells: [
        { r: 0, c: 0 }, { r: 0, c: 1 }, { r: 1, c: 0 }, { r: 1, c: 1 },
      ], target: 1 },
    ],
  });
  const r = s.solve();
  assert.equal(r.solved, true);
  let blacks = 0;
  for (const row of r.grid) for (const v of row) {
    if (v === 1) blacks++;
    else assert.equal(v, 2);
  }
  assert.equal(blacks, 1);
});

test('HeyawakeSolver.solve: returns {solved:false, grid:null} on unsat', () => {
  const s = new HeyawakeSolver({
    rows: 1, cols: 2,
    rooms: [{ cells: [{ r: 0, c: 0 }, { r: 0, c: 1 }], target: 2 }],
  });
  const r = s.solve();
  assert.equal(r.solved, false);
  assert.equal(r.grid, null);
});

test('HeyawakeSolver._solutionCache: cache hit returns a deep copy', () => {
  HeyawakeSolver.clearSolutionCache();
  const data = {
    rows: 2, cols: 2,
    rooms: [{ cells: [
      { r: 0, c: 0 }, { r: 0, c: 1 }, { r: 1, c: 0 }, { r: 1, c: 1 },
    ], target: 1 }],
  };
  const a = new HeyawakeSolver(data).solve();
  assert.equal(a.solved, true);
  a.grid[0][0] = 99;
  const b = new HeyawakeSolver(data).solve();
  assert.equal(b.solved, true);
  assert.notEqual(b.grid[0][0], 99);
});

test('HeyawakeSolver.getHint: returns forced cells on an empty solvable board', () => {
  HeyawakeSolver.clearSolutionCache();
  const s = new HeyawakeSolver({
    rows: 1, cols: 3,
    rooms: [
      { cells: [{ r: 0, c: 0 }, { r: 0, c: 1 }], target: 1 },
      { cells: [{ r: 0, c: 2 }], target: 1 },
    ],
  });
  const hint = s.getHint([[0, 0, 0]]);
  assert.ok(Array.isArray(hint));
  assert.ok(hint.length >= 1);
  const c2 = hint.find(h => h.row === 0 && h.col === 2);
  assert.ok(c2, `cell (0,2) should be in hint; got ${JSON.stringify(hint)}`);
  assert.equal(c2.value, 1);
});

test('HeyawakeSolver.getHint: returns null when state is already fully solved', () => {
  HeyawakeSolver.clearSolutionCache();
  const s = new HeyawakeSolver({
    rows: 1, cols: 3,
    rooms: [
      { cells: [{ r: 0, c: 0 }, { r: 0, c: 1 }], target: 1 },
      { cells: [{ r: 0, c: 2 }], target: 1 },
    ],
  });
  assert.equal(s.getHint([[1, 2, 1]]), null);
});

test('computePuzzleDiff heyawake: flags wrong-color cells, ignores unknown', () => {
  const { computePuzzleDiff } = require('../solver.js');
  const solution = [[1, 2], [2, 1]];
  const board = [
    [2, 2],
    [0, 1],
  ];
  const diff = computePuzzleDiff('heyawake', board, solution);
  assert.equal(diff.length, 1);
  assert.deepEqual(diff[0], { row: 0, col: 0, expected: 1, actual: 2 });
});
