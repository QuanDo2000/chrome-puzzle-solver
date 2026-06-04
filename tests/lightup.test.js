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

test('LightUp propagation: isolated white cells are forced to bulbs', () => {
  const s = mk([[-1, 2, -1]]);  // each white cell is its own segment
  s._initDomains(); s._buildSegments();
  assert.equal(s._propagate(), true);
  assert.equal(s._dom[0][0], 2); // forced bulb
  assert.equal(s._dom[0][2], 2); // forced bulb
});

test('LightUp propagation: clue 0 forbids all adjacent bulbs', () => {
  // clue 0 at (1,2); its four neighbours have length-2 arms so they can still be
  // lit from further down the arm — the board stays satisfiable (no contradiction),
  // but every clue-neighbour loses the bulb option.
  const s = mk([
    [-2, -1, -1, -1, -2],
    [-1, -1,  0, -1, -1],
    [-2, -1, -1, -1, -2],
  ]);
  s._initDomains(); s._buildSegments();
  assert.equal(s._propagate(), true);
  assert.equal(s._dom[0][2] & 2, 0); // above the clue: cannot be a bulb
  assert.equal(s._dom[2][2] & 2, 0); // below
  assert.equal(s._dom[1][1] & 2, 0); // left
  assert.equal(s._dom[1][3] & 2, 0); // right
});

test('LightUp propagation: a placed bulb forbids bulbs along its segment', () => {
  const s = mk([[-1, -1, -1]]);
  s._initDomains(); s._buildSegments();
  s._dom[0][0] = 2;                 // pin a bulb at the left
  assert.equal(s._propagate(), true);
  assert.equal(s._dom[0][1], 1);    // cannot be a bulb (lit, same segment)
  assert.equal(s._dom[0][2], 1);
});

test('LightUp propagation: detects collision contradiction', () => {
  const s = mk([[-1, -1, -1]]);
  s._initDomains(); s._buildSegments();
  s._dom[0][0] = 2; s._dom[0][2] = 2; // two bulbs in one segment
  assert.equal(s._propagate(), false);
});
