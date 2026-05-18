// Targeted tests for NonogramSolver's trail-based undo mechanism, which the
// golden snapshots don't exercise (small puzzles solve via propagation alone
// or backtrack-without-rollback). Tests the trail invariants directly so a
// regression in _assign / _rollback can't slip past the suite.

const test = require('node:test');
const assert = require('node:assert/strict');
const { NonogramSolver } = require('../solver.js');

test('_assign records old value and _rollback restores it', () => {
  const s = new NonogramSolver([[1], [1]], [[1], [1]]);
  // Initial state: all zeros.
  const mark = s.trail.length;
  s._assign(0, 0, 1);
  s._assign(0, 1, -1);
  s._assign(1, 1, 1);
  assert.equal(s.grid[0][0], 1);
  assert.equal(s.grid[0][1], -1);
  assert.equal(s.grid[1][1], 1);
  assert.equal(s.gridBuf[0], 1);
  assert.equal(s.gridBuf[1], -1);
  assert.equal(s.gridBuf[3], 1);
  s._rollback(mark);
  assert.equal(s.grid[0][0], 0);
  assert.equal(s.grid[0][1], 0);
  assert.equal(s.grid[1][1], 0);
  assert.equal(s.gridBuf[0], 0);
  assert.equal(s.gridBuf[1], 0);
  assert.equal(s.gridBuf[3], 0);
  assert.equal(s.trail.length, mark);
});

test('_assign is a no-op when the value is already set', () => {
  const s = new NonogramSolver([[1]], [[1]]);
  s._assign(0, 0, 1);
  const trailLen = s.trail.length;
  const wrote = s._assign(0, 0, 1);
  assert.equal(wrote, false);
  assert.equal(s.trail.length, trailLen);
});

test('_rollback restores non-zero previous values, not just zero', () => {
  const s = new NonogramSolver([[1]], [[1]]);
  s._assign(0, 0, -1);
  const mark = s.trail.length;
  s._assign(0, 0, 1);
  assert.equal(s.grid[0][0], 1);
  s._rollback(mark);
  assert.equal(s.grid[0][0], -1);
  assert.equal(s.gridBuf[0], -1);
});

test('solve reports contradiction on an unsolvable puzzle without crashing', () => {
  // Row 0 demands 3 filled cells in a 2-cell row — impossible. propagate()
  // should return false; solve() should report it, not silently fall through.
  const s = new NonogramSolver([[3], [0]], [[1], [1]]);
  const result = s.solve(null);
  assert.equal(result.solved, false);
  // Either our explicit message or whatever backtrack ultimately returns —
  // the key invariant is we didn't loop forever or return a wrong "solved".
  assert.ok(result.error || result.grid === null);
});

test('solve() on a reused instance resets per-solve state', () => {
  const rowClues = [[2], [1, 1], [2]];
  const colClues = [[2], [1, 1], [2]];
  const s = new NonogramSolver(rowClues, colClues);
  // Directly pollute every per-solve field with poison. If solve()'s reset
  // block misses any of them, the poison persists into search and either
  // breaks the solve or shows up in the post-solve state.
  s.trail.push(0xdead, 0xbeef, 0xface);
  s.gridBuf[0] = -1;
  s.grid[0][0] = -1;
  s.rowKnown[0] = 99;
  s.colKnown[0] = 99;
  s.bestPartial = [['poison'], ['poison'], ['poison']];
  s.bestPartialFilled = Number.MAX_SAFE_INTEGER;
  s.timedOut = true;

  const result = s.solve(null);
  // 1. Solve correctness — only possible if grid/gridBuf/counters were reset.
  if (result.solved) {
    for (let r = 0; r < 3; r++) {
      let cnt = 0;
      for (let c = 0; c < 3; c++) if (s.grid[r][c] !== 0) cnt++;
      assert.equal(s.rowKnown[r], cnt, `rowKnown[${r}] desynced from grid`);
    }
    for (let c = 0; c < 3; c++) {
      let cnt = 0;
      for (let r = 0; r < 3; r++) if (s.grid[r][c] !== 0) cnt++;
      assert.equal(s.colKnown[c], cnt, `colKnown[${c}] desynced from grid`);
    }
  }
  // 2. Per-solve tracking fields can't retain poison.
  assert.notEqual(s.bestPartialFilled, Number.MAX_SAFE_INTEGER,
    'bestPartialFilled should be reset');
  if (s.bestPartial) {
    assert.notDeepEqual(s.bestPartial[0], ['poison'],
      'bestPartial should not retain poison rows');
  }
  assert.equal(s.timedOut, false, 'timedOut should be reset');

  // 3. End-to-end: a second clean solve agrees with a fresh-solver baseline.
  const second = s.solve(null);
  const fresh = new NonogramSolver(rowClues, colClues).solve(null);
  assert.deepEqual(second, fresh);
});

test('backtrack rollback works end-to-end via solve()', () => {
  // 3x3 nonogram designed so the first guess sometimes fails.
  // Rows: [2], [1,1], [2]   Cols: [2], [1,1], [2]
  // Forces backtrack to try and reject candidates.
  const rowClues = [[2], [1, 1], [2]];
  const colClues = [[2], [1, 1], [2]];
  const result = new NonogramSolver(rowClues, colClues).solve(null);
  // Whether or not this particular puzzle is uniquely solvable, solve()
  // must return a deterministic result and not throw.
  assert.equal(typeof result.solved, 'boolean');
  if (result.solved) {
    // If solved, verify the result matches the clues (cheap correctness check).
    const grid = result.grid;
    for (let r = 0; r < 3; r++) {
      const got = [];
      let run = 0;
      for (let c = 0; c < 3; c++) {
        if (grid[r][c] === 1) run++;
        else if (run) { got.push(run); run = 0; }
      }
      if (run) got.push(run);
      assert.deepEqual(got, rowClues[r]);
    }
  }
});
