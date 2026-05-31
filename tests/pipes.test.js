'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PipesSolver } = require('../src/solvers/pipes.js');

// N=1,E=2,S=4,W=8. CW quarter turn: N->E->S->W->N.
test('PipesSolver.rotateCW moves each arm one quarter clockwise', () => {
  assert.equal(PipesSolver.rotateCW(1, 1), 2);  // N -> E
  assert.equal(PipesSolver.rotateCW(2, 1), 4);  // E -> S
  assert.equal(PipesSolver.rotateCW(8, 1), 1);  // W -> N
  assert.equal(PipesSolver.rotateCW(1, 4), 1);  // full turn = identity
  assert.equal(PipesSolver.rotateCW(0b0101, 1), 0b1010); // N|S -> E|W
});

test('PipesSolver.candidates dedupes by rotational symmetry', () => {
  assert.equal(new Set(PipesSolver.candidates(5)).size, 2);  // straight N|S
  assert.equal(new Set(PipesSolver.candidates(15)).size, 1); // cross
  assert.equal(new Set(PipesSolver.candidates(3)).size, 4);  // elbow N|E
  assert.equal(new Set(PipesSolver.candidates(1)).size, 4);  // endpoint
});
