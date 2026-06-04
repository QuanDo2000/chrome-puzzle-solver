'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ShakashakaSolver } = require('../src/solvers/shakashaka.js');

// Build a solver over a task grid (-1 open, -2 black, 0..4 numbered black).
function mk(task) { return new ShakashakaSolver({ task }); }

test('Shakashaka oracle: taskMarkedCount counts adjacent triangles', () => {
  // 1x3: black-numbered at (0,1) with two open neighbours.
  const s = mk([[-1, 0, -1]]);
  // board-state grid: open cells set to triangle(1) / white(0)
  const board = [[1, -1, 0]]; // left triangle, center black, right white
  assert.equal(s._taskMarkedCount(board, 0, 1), 1);
  const board2 = [[1, -1, 2]];
  assert.equal(s._taskMarkedCount(board2, 0, 1), 2);
});

test('Shakashaka oracle: hasNonRect flags a triangle with a wrong right neighbour', () => {
  // T1 at (0,0) requires right neighbour == T2 (it is T3 -> violation).
  const s = mk([[-1, -1]]);
  const board = [[1, 3]];
  assert.ok(s._hasNonRectAt(board, 0, 0)); // T1's right must be 2
});

test('Shakashaka oracle: hasNonRect accepts a valid T1/T2 pairing', () => {
  // T1 then T2 horizontally, with borders below -> need to satisfy down rule too.
  // Use a 2-wide, check the per-cell predicate for the T1 cell on a board where
  // right=2 and down is white at the edge (t<H-1 false -> border ok path).
  const s = mk([[-1, -1]]);   // 1 row -> t<H-1 is false for both, so the "need t<H-1" returns violation
  // On a 1-row board T1 violates (needs a down neighbour). Use 2 rows:
  const s2 = mk([[-1, -1], [-1, -1]]);
  // board where (0,0)=T1, (0,1)=T2, (1,0)=T4, (1,1)=T3 forms a closed diamond (valid).
  const board = [[1, 2], [4, 3]];
  assert.equal(s2._hasNonRectAt(board, 0, 0), false);
  assert.equal(s2._hasNonRectAt(board, 0, 1), false);
  assert.equal(s2._hasNonRectAt(board, 1, 0), false);
  assert.equal(s2._hasNonRectAt(board, 1, 1), false);
});

test('Shakashaka oracle: a 2x2 diamond of triangles is a fully valid board', () => {
  const s = mk([[-1, -1], [-1, -1]]);
  const board = [[1, 2], [4, 3]];
  assert.equal(s._hasNonRect(board), false);    // no cell violates
});

function bruteForce(task) {
  const s = new ShakashakaSolver({ task });
  const rows = task.length, cols = task[0].length;
  const open = [];
  const board = task.map(row => row.map(v => (v === -1 ? 0 : -1)));
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (task[r][c] === -1) open.push([r, c]);
  const sols = [];
  const rec = (i) => {
    if (i === open.length) { if (s._isValid(board)) sols.push(board.map(row => row.slice())); return; }
    const [r, c] = open[i];
    for (let v = 0; v <= 4; v++) { board[r][c] = v; rec(i + 1); }
    board[r][c] = 0;
  };
  rec(0);
  return sols;
}

test('Shakashaka brute-force: a tiny board has a known solution count', () => {
  // 2x2 all-open: enumerate; assert at least the diamond [[1,2],[4,3]] is found.
  const sols = bruteForce([[-1,-1],[-1,-1]]);
  assert.ok(sols.length >= 1);
  assert.ok(sols.some(b => b[0][0]===1 && b[0][1]===2 && b[1][0]===4 && b[1][1]===3));
});
