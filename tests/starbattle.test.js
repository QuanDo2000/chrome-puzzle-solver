'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { StarBattleSolver } = require('../src/solvers/starbattle.js');

// k stars per row/col/region (shaped: areas), no two stars 8-adjacent, no star on a wall (shapeless).
function mk(opts) { return new StarBattleSolver(opts); }
const QUAD = [[0, 0, 1, 1], [0, 0, 1, 1], [2, 2, 3, 3], [2, 2, 3, 3]]; // 4 quadrant regions

test('StarBattle oracle: a valid 4x4 k=1 board (1 star per row/col/region, no adjacency)', () => {
  const s = mk({ rows: 4, cols: 4, stars: 1, areas: QUAD });
  assert.equal(s._isValid([[0, 1, 0, 0], [0, 0, 0, 1], [1, 0, 0, 0], [0, 0, 1, 0]]), true);
});

test('StarBattle oracle: two 8-adjacent stars are invalid', () => {
  const s = mk({ rows: 4, cols: 4, stars: 1, areas: QUAD });
  assert.equal(s._isValid([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 0, 1], [0, 0, 1, 0]]), false); // (0,0)&(1,1) diagonal
});

test('StarBattle oracle: a wrong row count is invalid', () => {
  const s = mk({ rows: 4, cols: 4, stars: 1, areas: QUAD });
  assert.equal(s._isValid([[1, 0, 1, 0], [0, 1, 0, 0], [0, 0, 0, 1], [0, 0, 0, 0]]), false); // row 0 has 2
});

test('StarBattle oracle: a wrong region count is invalid', () => {
  const s = mk({ rows: 4, cols: 4, stars: 1, areas: QUAD });
  assert.equal(s._isValid([[0, 0, 1, 0], [0, 0, 0, 1], [1, 0, 0, 0], [0, 1, 0, 0]]), false); // region 0 has 0 stars
});

test('StarBattle oracle (shapeless): a star on a wall cell is invalid', () => {
  const s = mk({ rows: 4, cols: 4, stars: 1, walls: [[0, 0, 0, 0], [0, 1, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] });
  assert.equal(s._isValid([[0, 0, 0, 1], [0, 1, 0, 0], [1, 0, 0, 0], [0, 0, 1, 0]]), false); // star at (1,1) wall
});

test('StarBattle propagation: a placed star crosses its 8 neighbours', () => {
  // 5x5 k=1, no regions: a star at (2,2) is feasible, so propagation succeeds and crosses all 8 neighbours.
  const s = mk({ rows: 5, cols: 5, stars: 1 });
  s._initGrid(); s._set(2, 2, 1); // a star at the centre (via _set so group counts stay consistent)
  assert.equal(s._propagate(), true);
  for (const [r, c] of [[1,1],[1,2],[1,3],[2,1],[2,3],[3,1],[3,2],[3,3]]) assert.equal(s.g[r][c], 2);
});

test('StarBattle propagation: a group with all-but-k crossed forces the rest to stars', () => {
  // row 0, k=1: cross 3 cells -> the 4th is forced a star.
  const s = mk({ rows: 4, cols: 4, stars: 1, areas: QUAD });
  s._initGrid(); s._set(0, 0, 2); s._set(0, 1, 2); s._set(0, 2, 2);
  assert.equal(s._propagate(), true);
  assert.equal(s.g[0][3], 1); // forced star
});

test('StarBattle propagation: over-filled row is a contradiction', () => {
  const s = mk({ rows: 4, cols: 4, stars: 1, areas: QUAD });
  s._initGrid(); s._set(0, 0, 1); s._set(0, 2, 1); // two stars in a k=1 row
  assert.equal(s._propagate(), false);
});

// Brute-force ALL 2^cells star placements; keep those passing _isValid.
function bruteForce(rows, cols, k, areas) {
  const s = new StarBattleSolver({ rows, cols, stars: k, areas }); const n = rows * cols; const sols = [];
  for (let mask = 0; mask < (1 << n); mask++) {
    const cells = []; let b = 0;
    for (let r = 0; r < rows; r++) { cells.push([]); for (let c = 0; c < cols; c++) { cells[r].push(((mask >> b) & 1) ? 1 : 0); b++; } }
    if (s._isValid(cells)) sols.push(cells.map(r => r.slice()));
  }
  return sols;
}
function randAreas(seed, rows, cols, nreg) {
  let x = seed; const rnd = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; };
  const a = []; for (let r = 0; r < rows; r++) { a.push([]); for (let c = 0; c < cols; c++) a[r].push(Math.floor(rnd() * nreg)); } return a;
}

test('StarBattle soundness gate: solver matches brute-force across 300 random 4x4 k=1 boards', () => {
  let mism = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const areas = randAreas(seed, 4, 4, 4); const sols = bruteForce(4, 4, 1, areas);
    const res = new StarBattleSolver({ rows: 4, cols: 4, stars: 1, areas, maxMs: 3000 }).solve();
    if (res.solved !== (sols.length > 0)) { mism++; continue; }
    if (res.solved && !new StarBattleSolver({ rows: 4, cols: 4, stars: 1, areas })._isValid(res.cells)) mism++;
  }
  assert.equal(mism, 0);
});

test('StarBattle soundness: root deduction never prunes a cell a solution uses', () => {
  for (let seed = 1; seed <= 120; seed++) {
    const areas = randAreas(seed, 4, 4, 4); const sols = bruteForce(4, 4, 1, areas); if (!sols.length) continue;
    const s = new StarBattleSolver({ rows: 4, cols: 4, stars: 1, areas }); s._initGrid(); s._deadline = Date.now() + 3000;
    assert.ok(s._propagate(), `propagation contradicted a solvable board seed ${seed}`);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
      const v = s.g[r][c];
      if (v === 1) for (const sol of sols) assert.equal(sol[r][c], 1, `prune-star seed ${seed}`);
      if (v === 2) for (const sol of sols) assert.equal(sol[r][c], 0, `prune-nostar seed ${seed}`);
    }
  }
});

test('StarBattle solve: the quad board solves to a valid board', () => {
  const res = new StarBattleSolver({ rows: 4, cols: 4, stars: 1, areas: QUAD, maxMs: 5000 }).solve();
  assert.equal(res.solved, true);
  assert.ok(new StarBattleSolver({ rows: 4, cols: 4, stars: 1, areas: QUAD })._isValid(res.cells));
});

test('StarBattle widget solutionFromResult: star->1, no-star->X(2), UNK->empty(0)', () => {
  // Empty/UNK cells must render EMPTY in the preview — only decided no-stars become an X marker.
  const mod = require('../src/widget/puzzles/starbattle.js');
  // full solve (solver cells {0 no-star, 1 star}) -> {1 star, 2 X}
  assert.deepEqual(mod.solutionFromResult({ cells: [[1, 0], [0, 1]] }), [[1, 2], [2, 1]]);
  // partial: UNK (9) stays empty (0), never X; decided no-star (0) -> X (2)
  assert.deepEqual(mod.solutionFromResult({ cells: [[1, 9], [0, 9]] }), [[1, 0], [2, 0]]);
  assert.equal(mod.solutionFromResult(null), null);
});

test('StarBattle constructor: empty walls/areas ([]) are treated as "none", not indexed', () => {
  // The page (and the bench dump) pass walls:[] on shaped boards. An un-normalized []
  // is truthy, so _initGrid/_isValid would index walls[r] (undefined) and throw, stranding
  // the worker mid-solve (looks like a hang). Both [] and null must solve identically.
  const mk = (walls) => new StarBattleSolver({ rows: 4, cols: 4, stars: 1, areas: QUAD, walls, maxMs: 5000 });
  assert.doesNotThrow(() => mk([]).solve());
  const a = mk([]).solve(), b = mk(null).solve();
  assert.equal(a.solved, true);
  assert.equal(b.solved, true);
  assert.deepEqual(a.cells, b.cells);
});

test('StarBattle _deduceForced: a seeded star forces no-star cells (adjacency + counts)', () => {
  const s = new StarBattleSolver({ rows: 4, cols: 4, stars: 1, areas: QUAD, maxMs: 1000 });
  // live cellStatus: a star at (0,1) (value 1), everything else unknown (0).
  const cur = [[0, 1, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  const forced = s._deduceForced(cur);
  const has = (r, c, v) => forced.some(f => f.row === r && f.col === c && f.value === v);
  assert.ok(has(0, 0, 2) && has(1, 0, 2) && has(2, 1, 2), 'adjacency + group counts force no-stars');
  assert.ok(forced.every(f => f.value === 1 || f.value === 2), 'forced values are star(1) or no-star(2)');
});
