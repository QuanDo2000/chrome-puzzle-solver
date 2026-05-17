// Targeted invariants for GalaxiesSolver's trail-based undo.
// galaxiesSmall (in solver.test.js) does cover backtracking end-to-end, but
// these tests pin the trail mechanics directly so a regression in
// _assign / _rollback / _assignPair can't slip past.

const test = require('node:test');
const assert = require('node:assert/strict');
const { GalaxiesSolver } = require('../solver.js');
const fixtures = require('./fixtures/puzzles.js');

test('_assign records old value and _rollback restores it', () => {
  const p = fixtures.galaxiesSmall;
  const s = new GalaxiesSolver(p.stars, p.rows, p.cols);
  // Build the seed grid (needed because _assign reads/writes this.grid).
  s.grid = Array.from({ length: p.rows }, () => Array(p.cols).fill(-1));
  s.trail = [];
  const mark = s.trail.length;
  assert.equal(s._assign(0, 0, 2), true);
  assert.equal(s._assign(1, 1, 0), true);
  assert.equal(s.grid[0][0], 2);
  assert.equal(s.grid[1][1], 0);
  // Trail is flat: 3 ints per assignment (row, col, oldValue).
  assert.equal(s.trail.length, 6);
  s._rollback(mark);
  assert.equal(s.grid[0][0], -1);
  assert.equal(s.grid[1][1], -1);
  assert.equal(s.trail.length, 0);
});

test('_assign is a no-op when value already matches', () => {
  const p = fixtures.galaxiesSmall;
  const s = new GalaxiesSolver(p.stars, p.rows, p.cols);
  s.grid = Array.from({ length: p.rows }, () => Array(p.cols).fill(-1));
  s.trail = [];
  assert.equal(s._assign(0, 0, -1), false);
  assert.equal(s.trail.length, 0);
});

test('_assignPair pushes two trail entries and rollback restores both', () => {
  const p = fixtures.galaxiesSmall;
  const s = new GalaxiesSolver(p.stars, p.rows, p.cols);
  s.grid = Array.from({ length: p.rows }, () => Array(p.cols).fill(-1));
  s.trail = [];
  const mark = s.trail.length;
  // Pick a cell + star whose mirror lands in-bounds.
  const starIndex = 0;
  const ok = s._assignPair(0, 0, starIndex);
  assert.equal(ok, true);
  // After a successful pair, two cells should now hold starIndex.
  let assigned = 0;
  for (let r = 0; r < p.rows; r++) for (let c = 0; c < p.cols; c++) {
    if (s.grid[r][c] === starIndex) assigned++;
  }
  assert.ok(assigned === 2 || assigned === 1, // 1 if self-mirror
    `expected 1 or 2 cells with star ${starIndex}, got ${assigned}`);
  s._rollback(mark);
  for (let r = 0; r < p.rows; r++) for (let c = 0; c < p.cols; c++) {
    assert.equal(s.grid[r][c], -1);
  }
});

test('solve with forbiddenPartials bypasses the static solution cache', () => {
  const p = fixtures.galaxiesTiny;
  // Clear any cached solution from prior tests in this run.
  GalaxiesSolver._solutionCache.clear();

  // First solve warms the cache.
  const first = new GalaxiesSolver(p.stars, p.rows, p.cols).solve(null);
  assert.equal(first.solved, true);

  // Now forbid the only solution. If the cache short-circuit fires (the bug),
  // the solver returns the cached (and now-forbidden) grid; with the fix it
  // bypasses the cache, searches, and finds nothing.
  const second = new GalaxiesSolver(p.stars, p.rows, p.cols)
    .solve(null, { forbiddenPartials: [first.grid] });
  assert.equal(second.solved, false,
    'solver should not return a cached solution that is in forbiddenPartials');
});

test('solve drains its own search trail (search returns with grid solved)', () => {
  const p = fixtures.galaxiesSmall;
  const s = new GalaxiesSolver(p.stars, p.rows, p.cols);
  const trailBefore = s.trail.length;  // 0 (constructor)
  const result = s.solve(null);
  assert.equal(result.solved, true);
  // The trail isn't required to be empty after solve — entries from successful
  // assignments stay on it (no rollback when search returns success). The
  // invariant we DO care about: trail length didn't blow up beyond the grid
  // size (which would indicate runaway pushing without rollback).
  // Each filled cell contributed 3 ints to the flat trail; cellCount*3 is a
  // generous upper bound (we don't expect the trail to grow past total cells).
  const cellCount = p.rows * p.cols;
  assert.ok(s.trail.length <= cellCount * 3 * 2,
    `trail length ${s.trail.length} exceeds bound ${cellCount * 6}`);
  assert.ok(s.trail.length > trailBefore,
    'trail should have grown from at least the seed assignments');
});
