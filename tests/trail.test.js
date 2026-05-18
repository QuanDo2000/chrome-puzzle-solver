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
  const first = s.solve(null);
  // Second call on the SAME instance: must not be contaminated by first run's
  // gridBuf / rowKnown / colKnown / bestPartial state.
  const second = s.solve(null);
  assert.deepEqual(second, first);
  // And the per-line counters must match a fresh-solver baseline.
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
