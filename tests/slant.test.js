'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SlantSolver } = require('../src/solvers/slant.js');

// task: (rows+1) x (cols+1) vertex clues (-1 none, 0..4). cells: 1='\', 2='/'.
function mk(task, rows, cols) { return new SlantSolver({ task, rows, cols }); }

test('Slant oracle: an acyclic board with no clues is valid (star around a vertex)', () => {
  const s = mk([[-1, -1, -1], [-1, -1, -1], [-1, -1, -1]], 2, 2);
  assert.equal(s._isValid([[1, 2], [2, 1]]), true);
});

test('Slant oracle: a 4-cell diagonal cycle is rejected', () => {
  const s = mk([[-1, -1, -1], [-1, -1, -1], [-1, -1, -1]], 2, 2);
  assert.equal(s._isValid([[2, 1], [1, 2]]), false); // diamond loop
});

test('Slant oracle: a vertex clue must match the incident-diagonal count', () => {
  const s = mk([[-1, -1, -1], [-1, 4, -1], [-1, -1, -1]], 2, 2); // centre vertex needs 4
  assert.equal(s._isValid([[1, 2], [2, 1]]), true);  // all four diagonals meet the centre
  assert.equal(s._isValid([[2, 1], [1, 2]]), false); // centre degree 0 (and a cycle)
});

test('Slant oracle: a corner-vertex clue pins its single cell', () => {
  const s = mk([[1, -1], [-1, -1]], 1, 1); // vertex (0,0) clue 1; only cell (0,0) touches it via '\'
  assert.equal(s._isValid([[1]]), true);   // '\' points to (0,0)
  assert.equal(s._isValid([[2]]), false);  // '/' does not
});

test('Slant propagation: a degree-4 centre vertex forces the surrounding star', () => {
  const s = mk([[-1, -1, -1], [-1, 4, -1], [-1, -1, -1]], 2, 2);
  s.cells = [[0, 0], [0, 0]]; s.dsu = s._freshDSU();
  assert.equal(s._propagate(), true);
  assert.deepEqual(s.cells, [[1, 2], [2, 1]]); // all four diagonals forced to meet the centre
});

test('Slant propagation: acyclicity forces the non-cycling diagonal', () => {
  // Pre-commit three sides of the diamond; the 4th cell must take the non-cycling diagonal.
  const s = mk([[-1, -1, -1], [-1, -1, -1], [-1, -1, -1]], 2, 2);
  s.cells = [[0, 0], [0, 0]]; s.dsu = s._freshDSU();
  assert.equal(s._set(0, 0, 2), true); // '/' v(0,1)-v(1,0)
  assert.equal(s._set(1, 0, 1), true); // '\' v(1,0)-v(2,1)
  assert.equal(s._set(1, 1, 2), true); // '/' v(1,2)-v(2,1)
  // now cell (0,1) as '\' would be v(0,1)-v(1,2): v(0,1) and v(1,2) already connected -> cycle.
  assert.equal(s._propagate(), true);
  assert.equal(s.cells[0][1], 2); // forced to '/', not the cycling '\'
});

test('Slant propagation: an over-constrained clue is a contradiction', () => {
  // corner vertex (0,0) can have at most 1 incident cell; clue 2 is impossible.
  const s = mk([[2, -1], [-1, -1]], 1, 1);
  s.cells = [[0]]; s.dsu = s._freshDSU();
  assert.equal(s._propagate(), false);
});
