'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MasyuSolver } = require('../src/solvers/masyu.js');

// task: "W" white pearl, "B" black pearl, -1 empty.
function mk(task) { return new MasyuSolver({ task, rows: task.length, cols: task[0].length }); }

test('Masyu oracle: 3x3 outer-ring (black corners, white mid-edges) is valid', () => {
  const s = mk([['B','W','B'],['W',-1,'W'],['B','W','B']]);
  const H = [[1,1],[2,2],[1,1]];      // 3x2
  const V = [[1,2,1],[1,2,1]];        // 2x3
  assert.equal(s._isValid(H, V), true);
});

test('Masyu oracle: white pearl that turns is invalid', () => {
  // (0,0) white but the loop turns there -> invalid (also degree issues)
  const s = mk([['W',-1],[-1,-1]]);
  const H = [[1],[2]]; const V = [[1,2]];   // (0,0) has right+bottom = a turn
  assert.equal(s._isValid(H, V), false);
});

test('Masyu oracle: black pearl going straight is invalid', () => {
  const s = mk([[-1,'B',-1]]);
  const H = [[1,1]]; const V = [];           // (0,1) straight horizontal through black
  assert.equal(s._isValid(H, V), false);
});

test('Masyu oracle: a loose end (degree 1) is invalid', () => {
  const s = mk([[-1,-1],[-1,-1]]);
  const H = [[1],[2]]; const V = [[1,2]];    // (0,0) deg2, (0,1) deg1 etc -> not a loop
  assert.equal(s._isValid(H, V), false);
});

test('Masyu oracle: an empty board with no pearls is vacuously valid', () => {
  const s = mk([[-1,-1],[-1,-1]]);
  assert.equal(s._isValid([[2],[2]], [[2,2]]), true);
});
