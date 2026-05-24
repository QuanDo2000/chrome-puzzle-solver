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
  const s = new HeyawakeSolver({
    rows: 1, cols: 3,
    rooms: [
      { cells: [{ r: 0, c: 0 }, { r: 0, c: 1 }, { r: 0, c: 2 }], target: 2 },
    ],
    initialState: [[2, 0, 0]], // 1 white, 2 unknowns, target 2 → both unknowns must be black
  });
  assert.equal(s._applyRoomCounts(), true);
  assert.equal(s.cellStatus[1], 1);
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
