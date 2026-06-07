'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { LollipopsSolver } = require('../src/solvers/lollipops.js');

// Helper: build a solver. task is the 2D clue grid (-1 free, >=0 fixed shape).
function mk(task, maxMs) { return new LollipopsSolver({ rows: task.length, cols: task[0].length, task, maxMs }); }

test('Lollipops oracle: a valid candy+stick pair passes', () => {
  // 1x2: candy at (0,0) + h-stick at (0,1) -> a horizontal lollipop.
  const s = mk([[-1, -1]]);
  assert.equal(s.isValid([[1, 3]]), true);   // o-h connect (candy R->h, h L->candy)
  assert.equal(s.isValid([[1, 1]]), false);  // two candies adjacent -> invalid adjacency
  assert.equal(s.isValid([[1, 2]]), false);  // candy + v-stick side by side: v's L/R partner is null -> d>0
  assert.equal(s.isValid([[1, 4]]), false);  // candy with no partner (only a cross neighbour) -> u==0
});

test('Lollipops oracle: vertical pair + wrong-orientation rejected', () => {
  const s = mk([[-1], [-1]]);             // 2x1
  assert.equal(s.isValid([[1], [2]]), true);   // candy above v-stick -> connect (candy D->v, v U->candy)
  assert.equal(s.isValid([[1], [3]]), false);  // h-stick stacked under candy: h's U/D partner null -> d>0
});

test('Lollipops oracle: line-of-sight rejects two equal shapes across only crosses', () => {
  const s = mk([[-1, -1, -1, -1, -1]]);
  assert.equal(s.isValid([[1, 3, 4, 3, 1]]), false); // two h-sticks see each other across the cross
  assert.equal(s.isValid([[1, 3, 1, 3, 1]]), false); // (sanity) not all-valid either
});

test('Lollipops oracle: a double-connected candy is rejected', () => {
  // candy in the middle of a 1x3 with h on both sides: u==2 -> invalid.
  const s = mk([[-1, -1, -1]]);
  assert.equal(s.isValid([[3, 1, 3]]), false); // candy connects L and R -> u==2
});

test('Lollipops propagation: a lone v-clue forces a candy above or below (here above)', () => {
  // 2x1, v-stick fixed at (1,0). Its only candy slot is (0,0) -> forced candy; full board solves.
  const s = mk([[-1], [2]], 1000);
  const res = s.solve();
  assert.equal(res.solved, true);
  assert.equal(res.grid[0][0], 1); // candy forced above the v-stick
});

test('Lollipops getHint: returns sound forced cells (1/2/3/4), re-asserting clue shapes', () => {
  const s = mk([[-1], [2]], 1000);
  const forced = s.getHint([[0], [0]]); // blank cellStatus (clue cell (1,0) is 0/untracked)
  assert.ok(forced.some((f) => f.row === 0 && f.col === 0 && f.value === 1)); // candy above
  assert.ok(forced.every((f) => [1, 2, 3, 4].includes(f.value)));
});

function rng(seed) { let x = seed >>> 0; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; }; }

// Enumerate all oracle-valid full boards (each cell 1/2/3/4) for a blank rows x cols grid.
function allValid(rows, cols) {
  const N = rows * cols, vals = [1, 2, 3, 4], total = Math.pow(4, N);
  const blank = Array.from({ length: rows }, () => new Array(cols).fill(-1));
  const o = new LollipopsSolver({ rows, cols, task: blank });
  const out = []; const g = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let x = 0; x < total; x++) { let y = x; for (let i = 0; i < N; i++) { g[(i / cols) | 0][i % cols] = vals[y & 3]; y >>= 2; } if (o.isValid(g)) out.push(g.map((r) => r.slice())); }
  return out;
}

test('Lollipops soundness gate: solver matches brute-force across random tiny boards', () => {
  let tested = 0, mism = 0;
  for (let iter = 0; iter < 5000 && tested < 250; iter++) {
    const rnd = rng(iter * 2654435761 + 99);
    const rows = 2 + Math.floor(rnd() * 2), cols = 2 + Math.floor(rnd() * 2); // 2..3
    if (rows * cols > 9) continue;
    const valids = allValid(rows, cols); if (!valids.length) continue;
    const sol = valids[Math.floor(rnd() * valids.length)];
    const task = Array.from({ length: rows }, () => new Array(cols).fill(-1));
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (sol[r][c] !== 4 && rnd() < 0.4) task[r][c] = sol[r][c];
    let bf = 0;
    for (const v of valids) { let ok = true; for (let r = 0; r < rows && ok; r++) for (let c = 0; c < cols && ok; c++) if (task[r][c] >= 0 && v[r][c] !== task[r][c]) ok = false; if (ok) bf++; }
    tested++;
    const s = new LollipopsSolver({ rows, cols, task, maxMs: 4000 });
    const res = s.solve(true);
    if (!!res.solved !== (bf > 0)) { mism++; continue; }
    if (res.solved) {
      if (!s.isValid(res.grid)) mism++;
      if ((res.count === 1) !== (bf === 1)) mism++;
    }
  }
  assert.equal(mism, 0, `gate mismatches=${mism} (tested=${tested})`);
  assert.ok(tested >= 100, `gate exercised too few boards (${tested})`);
});
