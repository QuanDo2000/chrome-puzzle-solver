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
