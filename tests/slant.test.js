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

// Brute-force ALL 2^cells diagonal assignments; keep those passing _isValid.
function bruteForce(task, rows, cols) {
  const s = new SlantSolver({ task, rows, cols }); const n = rows * cols; const sols = [];
  for (let mask = 0; mask < (1 << n); mask++) {
    const cells = []; let b = 0;
    for (let r = 0; r < rows; r++) { cells.push([]); for (let c = 0; c < cols; c++) { cells[r].push(((mask >> b) & 1) ? 1 : 2); b++; } }
    if (s._isValid(cells)) sols.push(cells.map(r => r.slice()));
  }
  return sols;
}
function randTask(seed, rows, cols) {
  let x = seed; const rnd = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; };
  const t = []; for (let i = 0; i <= rows; i++) { t.push([]); for (let j = 0; j <= cols; j++) { const p = rnd(); t[i].push(p < 0.55 ? -1 : Math.min(4, Math.floor(rnd() * 5))); } } return t;
}

test('Slant soundness gate: solver matches brute-force across 400 random 2x3 boards', () => {
  let mism = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const t = randTask(seed, 2, 3); const sols = bruteForce(t, 2, 3);
    const res = new SlantSolver({ task: t, rows: 2, cols: 3, maxMs: 3000 }).solve();
    if (res.solved !== (sols.length > 0)) { mism++; continue; }
    if (res.solved && !new SlantSolver({ task: t, rows: 2, cols: 3 })._isValid(res.cells)) mism++;
  }
  assert.equal(mism, 0);
});

test('Slant soundness: root deduction never prunes a cell a solution uses', () => {
  for (let seed = 1; seed <= 150; seed++) {
    const t = randTask(seed, 2, 3); const sols = bruteForce(t, 2, 3); if (!sols.length) continue;
    const s = new SlantSolver({ task: t, rows: 2, cols: 3 });
    s.cells = [[0, 0, 0], [0, 0, 0]]; s.dsu = s._freshDSU(); s._deadline = Date.now() + 3000;
    assert.ok(s._propagate(), `propagation contradicted a solvable board seed ${seed}`);
    for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) { const v = s.cells[r][c]; if (v !== 0) for (const sol of sols) assert.equal(sol[r][c], v, `prune seed ${seed}`); }
  }
});

test('Slant solve: a uniquely-clued board solves to a valid board', () => {
  const t = [[-1, -1, -1], [-1, 4, -1], [-1, -1, -1]];
  const res = new SlantSolver({ task: t, rows: 2, cols: 2, maxMs: 5000 }).solve();
  assert.equal(res.solved, true);
  assert.deepEqual(res.cells, [[1, 2], [2, 1]]);
});
