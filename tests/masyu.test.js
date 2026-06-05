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

test('Masyu propagation: a white pearl on the top border is forced horizontal', () => {
  const s = mk([[-1,'W',-1],[-1,-1,-1],[-1,-1,-1]]);
  s.H = Array.from({length:3},()=>[0,0]); s.V = Array.from({length:2},()=>[0,0,0]);
  assert.equal(s._propagate(), true);
  // top-row white can't go vertical -> horizontal through: left+right line, bottom cross
  assert.equal(s.H[0][0], 1); assert.equal(s.H[0][1], 1); assert.equal(s.V[0][1], 2);
});

test('Masyu propagation: a black pearl with a committed arm forces its continuation', () => {
  // 5x5 black at (2,2); set the right arm (H[2][2]) line. Black must NOT go straight
  // (opposite edge H[2][1] crossed) and the right arm must continue straight one cell
  // (H[2][3] line, the cell beyond's perpendiculars crossed).
  const task = Array.from({length:5},()=>new Array(5).fill(-1)); task[2][2] = 'B';
  const s = new MasyuSolver({ task, rows: 5, cols: 5 });
  s.H = Array.from({length:5},()=>[0,0,0,0]); s.V = Array.from({length:4},()=>[0,0,0,0,0]);
  s.H[2][2] = 1;
  assert.equal(s._propagate(), true);
  assert.equal(s.H[2][1], 2);   // opposite horizontal edge crossed (no straight-through)
  assert.equal(s.H[2][3], 1);   // right arm continues straight
  assert.equal(s.V[1][3], 2);   // the continuation cell's perpendiculars crossed
  assert.equal(s.V[2][3], 2);
});

test('Masyu propagation: a cell forced to degree 3 is a contradiction', () => {
  const s = mk([[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]]);
  s.H = Array.from({length:3},()=>[0,0]); s.V = Array.from({length:2},()=>[0,0,0]);
  s.H[1][0] = 1; s.H[1][1] = 1; s.V[0][1] = 1; // cell (1,1): left+right+top = 3 lines
  assert.equal(s._propagate(), false);
});
