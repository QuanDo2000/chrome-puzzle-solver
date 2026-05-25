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
