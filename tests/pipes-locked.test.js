'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const pipes = require('../src/widget/puzzles/pipes.js');

// pipes.lockedMistakes({ grid, solution, task, pinned }) returns [{row,col}] for
// every LOCKED (pinned) cell whose current rotation produces a different pipe
// MASK than the solution. grid & solution are rotation-COUNT grids; task is the
// scrambled-mask grid; pinned is a 0/1 lock grid. Solution counts are rotations
// FROM task TO solved, so solution=[[0]] means "solved shape == task mask".
// Mask facts (PipesSolver.rotateCW, page-CW): elbow mask 3: k0=3,k1=6.
// straight mask 5: k0=5,k1=10,k2=5 (period 2). cross mask 15: any k = 15.
// end mask 1: k0=1,k1=2.

test('lockedMistakes flags a locked cell at the wrong rotation', () => {
  const m = pipes.lockedMistakes({
    task: [[3]], solution: [[0]], grid: [[1]], pinned: [[1]], // 3 rotated 1 -> 6 != 3
  });
  assert.deepEqual(m, [{ row: 0, col: 0 }]);
});

test('lockedMistakes does NOT flag a correctly-locked cell', () => {
  const m = pipes.lockedMistakes({
    task: [[3]], solution: [[0]], grid: [[0]], pinned: [[1]], // 3 -> 3 == solved
  });
  assert.deepEqual(m, []);
});

test('lockedMistakes does NOT flag an unlocked wrong cell', () => {
  const m = pipes.lockedMistakes({
    task: [[3]], solution: [[0]], grid: [[1]], pinned: [[0]], // wrong but not pinned
  });
  assert.deepEqual(m, []);
});

test('lockedMistakes does NOT flag a symmetric piece locked at an equivalent rotation', () => {
  // straight (mask 5) solved at k0; locked at k2 -> mask 5 again. Counts differ
  // (0 vs 2) but the shape is identical, so it must NOT be flagged.
  const m = pipes.lockedMistakes({
    task: [[5]], solution: [[0]], grid: [[2]], pinned: [[1]],
  });
  assert.deepEqual(m, []);
});

test('lockedMistakes never flags a rotation-invariant cross', () => {
  const m = pipes.lockedMistakes({
    task: [[15]], solution: [[0]], grid: [[3]], pinned: [[1]],
  });
  assert.deepEqual(m, []);
});

test('lockedMistakes returns [] when any input grid is missing', () => {
  assert.deepEqual(pipes.lockedMistakes({ task: [[3]], solution: [[0]], grid: [[1]] }), []);
  assert.deepEqual(pipes.lockedMistakes({}), []);
});

test('lockedMistakes flags only pinned-and-wrong cells across a 2x2 grid', () => {
  // (0,0) elbow, pinned, wrong (3 rotated 1 -> 6 != 3)        -> flagged
  // (0,1) end,   pinned, correct (1 rotated 0 -> 1 == 1)      -> not flagged
  // (1,0) elbow, NOT pinned, wrong (3 rotated 1 -> 6 != 3)    -> not flagged (unlocked)
  // (1,1) end,   pinned, wrong (1 rotated 1 -> 2 != 1)        -> flagged
  const m = pipes.lockedMistakes({
    task:     [[3, 1], [3, 1]],
    solution: [[0, 0], [0, 0]],
    grid:     [[1, 0], [1, 1]],
    pinned:   [[1, 1], [0, 1]],
  });
  assert.deepEqual(m, [{ row: 0, col: 0 }, { row: 1, col: 1 }]);
});

test('lockedMistakes never flags a blank (mask 0) locked cell', () => {
  // A blank cell has no arms; rotateMask(0, k) === 0 for any k, so a locked
  // blank can never be at the "wrong" rotation. Spec degenerate-piece case.
  const m = pipes.lockedMistakes({
    task: [[0]], solution: [[0]], grid: [[2]], pinned: [[1]],
  });
  assert.deepEqual(m, []);
});
