'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { rotationCount, rotateMask } = require('../src/widget/pipes-rotation.js');
const { PipesSolver } = require('../src/solvers/pipes.js');

// rotationCount(taskMask, solvedMask, pageCW) = k in 0..3 such that rotating the
// task mask k page-steps yields the solved mask. pageCW=true: a page step is a
// clockwise quarter-turn (== solver rotateCW); false: counter-clockwise.
test('rotationCount finds the k that turns task into solved (CW page)', () => {
  for (const base of [1, 3, 5, 6, 7, 15]) {
    for (let k = 0; k < 4; k++) {
      const solved = PipesSolver.rotateCW(base, k);
      const got = rotationCount(base, solved, true);
      assert.equal(PipesSolver.rotateCW(base, got), solved, `base=${base} k=${k}`);
      assert.ok(got >= 0 && got < 4);
    }
  }
});

test('rotationCount honours CCW page direction', () => {
  assert.equal(rotationCount(1, 2, true), 1);  // N->E is 1 CW step
  assert.equal(rotationCount(1, 2, false), 3); // N->E is 3 CCW steps
});

test('rotationCount returns 0 for a symmetric/aligned piece', () => {
  assert.equal(rotationCount(15, 15, true), 0); // cross: any k; smallest is 0
  assert.equal(rotationCount(5, 5, true), 0);   // straight already aligned
});

// rotateMask(taskMask, count, pageCW) rotates a 4-bit mask `count` page-steps.
// pageCW=true is a clockwise quarter-turn per step (== PipesSolver.rotateCW),
// false is counter-clockwise. It is the forward inverse of rotationCount.
test('rotateMask applies the CW page step count times (matches PipesSolver.rotateCW)', () => {
  for (const base of [0, 1, 3, 5, 6, 7, 15]) {
    for (let k = 0; k < 4; k++) {
      assert.equal(rotateMask(base, k, true), PipesSolver.rotateCW(base, k), `base=${base} k=${k}`);
    }
  }
});

test('rotateMask round-trips with rotationCount', () => {
  for (const base of [1, 3, 5, 6, 7]) {
    for (let k = 0; k < 4; k++) {
      const solved = PipesSolver.rotateCW(base, k);
      assert.equal(rotateMask(base, rotationCount(base, solved, true), true), solved, `base=${base} k=${k}`);
    }
  }
});

test('rotateMask honours CCW direction', () => {
  assert.equal(rotateMask(1, 1, false), 8); // N(1) one CCW step -> W(8)
  assert.equal(rotateMask(1, 3, false), 2); // three CCW steps -> E(2)
});
