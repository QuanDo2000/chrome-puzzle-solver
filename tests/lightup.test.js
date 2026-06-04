'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { LightUpSolver } = require('../src/solvers/lightup.js');

// task: -1 white, -2 black-no-number, 0..4 numbered black.
function mk(task) { return new LightUpSolver({ task }); }

test('LightUp oracle: taskMarkedCount counts orthogonal bulbs', () => {
  // [white, clue, white]; cells: bulb, black, bulb
  const s = mk([[-1, 2, -1]]);
  assert.equal(s._taskMarkedCount([[1, -1, 1]], 0, 1), 2);
  assert.equal(s._taskMarkedCount([[1, -1, 0]], 0, 1), 1);
  assert.equal(s._taskMarkedCount([[0, -1, 0]], 0, 1), 0);
});

test('LightUp oracle: a single bulb lights its full unblocked segment', () => {
  const s = mk([[-1, -1, -1]]);          // 1x3 all white
  assert.equal(s._isValid([[1, 0, 0]]), true);   // bulb at left lights all three
  assert.equal(s._isValid([[0, 1, 0]]), true);
});

test('LightUp oracle: two bulbs seeing each other is invalid (collision)', () => {
  const s = mk([[-1, -1, -1]]);
  assert.equal(s._isValid([[1, 0, 1]]), false);  // both in one segment
});

test('LightUp oracle: a black wall blocks light and splits segments', () => {
  const s = mk([[-1, 2, -1]]);           // white | clue2 | white
  // each white cell is its own segment; both must be bulbs; clue 2 satisfied
  assert.equal(s._isValid([[1, -1, 1]]), true);
  // unlit cell -> invalid
  assert.equal(s._isValid([[0, -1, 1]]), false); // (0,0) unlit
  // clue mismatch -> invalid
  const s0 = mk([[-1, 0, -1]]);          // clue 0 forbids both -> but then unlit -> invalid anyway
  assert.equal(s0._isValid([[1, -1, 1]]), false); // clue 0 violated (marked=2)
});

test('LightUp oracle: numbered clue must match exactly', () => {
  const s = mk([[-1, 1, -1]]);
  assert.equal(s._isValid([[1, -1, 1]]), false); // marked 2 != 1
});
