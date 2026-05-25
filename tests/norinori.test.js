'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { NorinoriSolver } = require('../solver.js');

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
