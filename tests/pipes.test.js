'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PipesSolver } = require('../solver.js');

// rotateCW is the page's per-increment bit transform (m<<1)|(m>>3); these
// assertions are label-agnostic (raw bit shifts). The page side map is
// E=1, N=2, W=4, S=8 (see PipesSolver).
test('PipesSolver.rotateCW advances bits one page step', () => {
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

// Page bit→side map (must match PipesSolver): E=1, N=2, W=4, S=8.
function edgesConsistent(grid, rows, cols, wrap) {
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const m = grid[r][c];
    const up = r > 0 ? grid[r-1][c] : (wrap ? grid[rows-1][c] : null);
    const left = c > 0 ? grid[r][c-1] : (wrap ? grid[r][cols-1] : null);
    const hasN = !!(m & 2), hasW = !!(m & 4);
    if (up === null) { if (hasN) return false; } else if (hasN !== !!(up & 8)) return false;  // my N ↔ neighbour's S
    if (left === null) { if (hasW) return false; } else if (hasW !== !!(left & 1)) return false; // my W ↔ neighbour's E
  }
  return true;
}
function connected(grid, rows, cols, wrap) {
  const armed = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (grid[r][c]) armed.push(r*cols+c);
  if (armed.length === 0) return true;
  const seen = new Set([armed[0]]); const st = [armed[0]];
  while (st.length) {
    const u = st.pop(), r = (u/cols)|0, c = u%cols, m = grid[r][c];
    const nb = [];
    if (m & 2) nb.push([(r-1+rows)%rows, c, r>0||wrap]); // N
    if (m & 8) nb.push([(r+1)%rows, c, r<rows-1||wrap]); // S
    if (m & 4) nb.push([r, (c-1+cols)%cols, c>0||wrap]); // W
    if (m & 1) nb.push([r, (c+1)%cols, c<cols-1||wrap]); // E
    for (const [nr, nc, ok] of nb) { if (!ok) continue; const v = nr*cols+nc; if (!seen.has(v)) { seen.add(v); st.push(v); } }
  }
  return seen.size === armed.length;
}

test('PipesSolver solves the captured 4x4 (non-wrap, unique)', () => {
  const task = [[8,3,2,6],[8,7,1,10],[10,13,13,11],[6,3,1,8]];
  const res = new PipesSolver({ rows: 4, cols: 4, task, wrap: false }).solve();
  assert.equal(res.solved, true);
  assert.ok(edgesConsistent(res.grid, 4, 4, false), 'all edges agree, no off-board arms');
  assert.ok(connected(res.grid, 4, 4, false), 'single connected network');
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    assert.ok(PipesSolver.candidates(task[r][c]).includes(res.grid[r][c]));
  }
});

test('PipesSolver: 1x2 two endpoints must point at each other', () => {
  const res = new PipesSolver({ rows: 1, cols: 2, task: [[1, 1]], wrap: false }).solve();
  assert.equal(res.solved, true);
  assert.deepEqual(res.grid, [[1, 4]]); // page map: left=E(1), right=W(4)
});

test('PipesSolver: unsolvable returns solved:false', () => {
  const res = new PipesSolver({ rows: 1, cols: 3, task: [[1,1,1]], wrap: false }).solve();
  assert.equal(res.solved, false);
});
