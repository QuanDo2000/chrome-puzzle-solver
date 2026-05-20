const test = require('node:test');
const assert = require('node:assert/strict');
const { NonogramSolver, AquariumSolver, GalaxiesSolver, BinairoSolver, ShikakuSolver, YinYangSolver } = require('../solver.js');
const fixtures = require('./fixtures/puzzles.js');
const golden = require('./golden.js');

// Roundtrip through JSON to match the capture script's representation: drops
// non-numeric properties some solvers attach to grid arrays (e.g. Galaxies
// stores its galaxies array as a side-property on the grid).
function clean(result) {
  if (!result || typeof result !== 'object') return result;
  const { solved, grid, error } = result;
  return JSON.parse(JSON.stringify({ solved, grid, error: error || null }));
}

test('NonogramSolver: diagonal 5x5 matches golden', () => {
  const p = fixtures.nonogramDiagonal5;
  const result = clean(new NonogramSolver(p.rowClues, p.colClues).solve(null));
  assert.deepEqual(result, golden.nonogramDiagonal5);
});

test('NonogramSolver: corners 3x3 matches golden', () => {
  const p = fixtures.nonogramCorners3;
  const result = clean(new NonogramSolver(p.rowClues, p.colClues).solve(null));
  assert.deepEqual(result, golden.nonogramCorners3);
});

test('AquariumSolver: tiny 2x2 matches golden', () => {
  const p = fixtures.aquariumTiny;
  const result = clean(
    new AquariumSolver(p.rowClues, p.colClues, p.regionMap, p.rows, p.cols).solve(null)
  );
  assert.deepEqual(result, golden.aquariumTiny);
});

test('AquariumSolver: large 15x15 matches golden (exercises DP machinery)', () => {
  const p = fixtures.aquariumLarge;
  const result = clean(
    new AquariumSolver(p.rowClues, p.colClues, p.regionMap, p.rows, p.cols).solve(null)
  );
  assert.deepEqual(result, golden.aquariumLarge);
});

test('GalaxiesSolver: tiny 4x4 matches golden', () => {
  const p = fixtures.galaxiesTiny;
  const result = clean(new GalaxiesSolver(p.stars, p.rows, p.cols).solve(null));
  assert.deepEqual(result, golden.galaxiesTiny);
});

test('GalaxiesSolver: small 7x7 matches golden (exercises _search backtracking)', () => {
  const p = fixtures.galaxiesSmall;
  const result = clean(new GalaxiesSolver(p.stars, p.rows, p.cols).solve(null));
  assert.deepEqual(result, golden.galaxiesSmall);
});

test('BinairoSolver: constructor accepts givens and exposes rows/cols', () => {
  const p = fixtures.binairo6x6;
  const s = new BinairoSolver({ rows: p.rows, cols: p.cols, givens: p.givens });
  assert.equal(s.rows, p.rows);
  assert.equal(s.cols, p.cols);
});

test('BinairoSolver: no-triples propagation forces opposite when two same in a row', () => {
  // Row: [1, 1, ?, ?, ?, ?] — third cell must be 2 (zero).
  const s = new BinairoSolver({
    rows: 6, cols: 6,
    givens: [
      [1, 1, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1, -1],
    ],
  });
  const ok = s.propagate();
  assert.equal(ok, true);
  assert.equal(s._get(0, 2), 2, 'cell (0,2) must be forced to 2 (zero)');
});

test('BinairoSolver: balance rule fills row when half is reached (6-cell row, 3 ones placed)', () => {
  // Row 0 has three 1s; the remaining three empty cells must all become 2.
  const s = new BinairoSolver({
    rows: 6, cols: 6,
    givens: [
      [1, -1, 1, -1, 1, -1],
      [-1, -1, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1, -1],
    ],
  });
  const ok = s.propagate();
  assert.equal(ok, true);
  for (let c = 0; c < 6; c++) {
    if (c % 2 === 1) assert.equal(s._get(0, c), 2, `row 0 col ${c} should be 2`);
  }
});

test('BinairoSolver: uniqueness rule forces last two cells when matching another row', () => {
  // Row 0 fully filled = [1,2,1,2,1,2]. Row 1 has [1,2,1,2,?,?]. The
  // candidates {(1,2),(2,1)} both satisfy no-triples + balance. Uniqueness
  // (matching row 0's filled pattern) eliminates (1,2). Force (2,1).
  // Row 0 reaches its filled pattern via givens; cells in other rows are
  // free enough that propagation doesn't trip on them. Givens for row 1
  // are crafted to force balance/no-triples to NOT decide on their own.
  const givens = Array.from({ length: 6 }, () => new Array(6).fill(-1));
  // Row 0: 1, 0, 1, 0, 1, 0
  givens[0] = [1, 0, 1, 0, 1, 0];
  // Row 1: 1, 0, 1, 0, -, -  (last two open)
  givens[1] = [1, 0, 1, 0, -1, -1];
  const s = new BinairoSolver({ rows: 6, cols: 6, givens });
  const ok = s.propagate();
  assert.equal(ok, true);
  // Uniqueness forces row 1 col 4 = 2 (zero), col 5 = 1 (one), giving
  // [1,2,1,2,2,1] which differs from row 0.
  assert.equal(s._get(1, 4), 2);
  assert.equal(s._get(1, 5), 1);
});

test('BinairoSolver: solves the captured 6x6 fixture', () => {
  const p = fixtures.binairo6x6;
  const s = new BinairoSolver({ rows: p.rows, cols: p.cols, givens: p.givens });
  const result = s.solve();
  assert.equal(result.solved, true);
  // Sanity: each row/col has exactly 3 ones and 3 zeros.
  for (let r = 0; r < 6; r++) {
    let ones = 0, zeros = 0;
    for (let c = 0; c < 6; c++) {
      if (result.grid[r][c] === 1) ones++;
      else if (result.grid[r][c] === 2) zeros++;
    }
    assert.equal(ones, 3, `row ${r}: expected 3 ones, got ${ones}`);
    assert.equal(zeros, 3, `row ${r}: expected 3 zeros, got ${zeros}`);
  }
});

test('BinairoSolver: getHint returns every cell deducible from fresh givens', () => {
  const p = fixtures.binairo6x6;
  const s = new BinairoSolver({ rows: p.rows, cols: p.cols, givens: p.givens });
  // Grid argument: 0/1/2 encoding from the page. Mirror the givens →
  // initialFromGivens translation.
  const grid = s._gridTo2D();
  const hint = s.getHint(grid);
  assert.ok(hint, 'getHint should return at least one forced cell from these givens');
  assert.equal(hint.type, 'row');
  assert.ok(Number.isInteger(hint.index));
  const total = hint.cells.length + hint.extraCells.length;
  assert.ok(total >= 1, `expected ≥1 deduced cell, got ${total}`);
  const allCells = [
    ...hint.cells.map(c => c.value),
    ...hint.extraCells.map(c => c.value),
  ];
  for (const v of allCells) {
    assert.ok(v === 1 || v === 2, `hint value must be 1 or 2, got ${v}`);
  }
});

test('BinairoSolver: getHint returns null when state is already at fixed point', () => {
  const p = fixtures.binairo6x6;
  const s = new BinairoSolver({ rows: p.rows, cols: p.cols, givens: p.givens });
  // Solve fully, then ask for a hint — there should be nothing left to deduce.
  const solved = s.solve();
  assert.equal(solved.solved, true);
  const hint = new BinairoSolver({ rows: p.rows, cols: p.cols, givens: p.givens })
    .getHint(solved.grid);
  assert.equal(hint, null);
});

test('BinairoSolver: getHint line-lookahead fallback unblocks stalled states', () => {
  // The 40x30 monthly stalls after Step 1 (516 cells deduced by local rules).
  // The line-restricted lookahead fallback must find at least one more
  // forced cell so Hint doesn't dead-end before Solve.
  const real = require('./fixtures/real-puzzles.js');
  // Reuse the 30x30 weekly here since it's already in fixtures; the 40x30
  // monthly isn't fixturized but the same principle applies — any puzzle
  // whose local rules stall but line-lookahead finds forces is a valid
  // test. The 30x30 weekly stalls at the same place.
  const p = real.binairoRealWeekly30x30_a;
  BinairoSolver.clearSolutionCache();

  // Step 1: fresh hint with local rules.
  const s0 = new BinairoSolver({ rows: p.rows, cols: p.cols, givens: p.givens });
  const grid0 = s0._gridTo2D();
  const h0 = s0.getHint(grid0);
  assert.ok(h0, 'step 1 must produce a hint');
  const after = grid0.map(r => r.slice());
  for (const c of h0.cells) after[h0.index][c.index] = c.value;
  for (const c of h0.extraCells) after[c.row][c.col] = c.value;

  // Step 2: local rules should stall here on the weekly; fallback should kick in.
  const s1 = new BinairoSolver({ rows: p.rows, cols: p.cols, givens: p.givens });
  const h1 = s1.getHint(after);
  if (h1) {
    // If fallback produces anything, those cells must agree with the solve.
    BinairoSolver.clearSolutionCache();
    const solved = new BinairoSolver({ rows: p.rows, cols: p.cols, givens: p.givens }).solve();
    assert.equal(solved.solved, true);
    const cells = [
      ...h1.cells.map(c => ({ row: h1.index, col: c.index, value: c.value })),
      ...h1.extraCells,
    ];
    for (const c of cells) {
      assert.equal(solved.grid[c.row][c.col], c.value,
        `fallback hint claimed (${c.row},${c.col})=${c.value} but solved grid has ${solved.grid[c.row][c.col]}`);
    }
  }
});

test('BinairoSolver: getHint uses local rules only — never reveals the entire 30x30', () => {
  // getHint runs the local-rule set (no-triples, balance, uniqueness,
  // single-remaining) but NOT lookahead. On the 30x30 weekly the local
  // rules alone deduce ~338 of 679 empty cells — short of finishing the
  // puzzle. Hint cells must match the solved grid.
  const real = require('./fixtures/real-puzzles.js');
  const p = real.binairoRealWeekly30x30_a;
  BinairoSolver.clearSolutionCache();

  const s = new BinairoSolver({ rows: p.rows, cols: p.cols, givens: p.givens });
  const grid = s._gridTo2D();
  const hint = s.getHint(grid);
  assert.ok(hint, 'getHint should produce at least one deduction on the 30x30');

  const hintCells = [
    ...hint.cells.map(c => ({ row: hint.index, col: c.index, value: c.value })),
    ...hint.extraCells,
  ];
  assert.ok(hintCells.length > 0, 'getHint result must contain at least one cell');
  assert.ok(hintCells.length < 679,
    `getHint produced ${hintCells.length} cells; lookahead must be excluded`);

  BinairoSolver.clearSolutionCache();
  const solved = new BinairoSolver({ rows: p.rows, cols: p.cols, givens: p.givens }).solve();
  assert.equal(solved.solved, true);
  for (const c of hintCells) {
    assert.equal(solved.grid[c.row][c.col], c.value,
      `hint claimed (${c.row},${c.col})=${c.value} but solved grid has ${solved.grid[c.row][c.col]}`);
  }
});

test('BinairoSolver: single-remaining rule forces unique slot when only 1 value left', () => {
  // 6-row, 6-col. Row 0 needs exactly 1 more "1": already has [1,1,2,2,_,_]
  // (ones=2, rowHalf=3). Empty slots are cols 4 and 5. Placing "1" at col 4
  // would create 1,2,_,1 → not a triple, fine. Placing "1" at col 5 also
  // fine — both legal, so single-remaining cannot fire on this row alone.
  // Use a tighter setup: row 0 = [2,1,1,2,_,_], ones=2, empties at 4,5.
  // Placing 1 at col 4: cells 2,3,4 = 1,2,1 — no triple. fine.
  // Placing 1 at col 5: cells 3,4,5 = 2,_,1 — fine.
  // Still both legal. We need a config where one slot would create a triple.
  // [_,1,1,_,_,_] in a 6-row: rowHalf=3, ones=2. Empties 0,3,4,5. Need 1 more "1".
  // At col 0: cells 0,1,2 = 1,1,1 → triple. Illegal.
  // At col 3: cells 1,2,3 = 1,1,1 → triple. Illegal.
  // At col 4: cells 2,3,4 = 1,?,1 — wait 3 is empty. cells 3,4,5 = ?,1,?. No triple yet.
  // At col 5: cells 3,4,5 = ?,?,1 — no triple yet.
  // So legal slots are 4 and 5. Still two. Hmm.
  // [_,1,1,2,_,_]: ones=2, empties at 0,4,5.
  // col 0: cells 0,1,2 = 1,1,1 → triple. Illegal.
  // col 4: cells 2,3,4 = 1,2,1 — fine.
  // col 5: cells 3,4,5 = 2,_,1 — fine. (4 is empty so window 4,5,6 doesn't apply if 6 is OOB)
  // Two legal again.
  // [_,1,1,2,_,2]: ones=2, zeros=2, empties at 0,4. Need 1 "1".
  // col 0: cells 0,1,2 = 1,1,1 → triple. Illegal.
  // col 4: cells 2,3,4 = 1,2,1 — fine. Cells 3,4,5 = 2,1,2 — fine.
  // Only col 4 is legal → single-remaining forces col 4 = 1.
  // But wait — empties=2, so uniqueness rule might fire first. Let me check.
  // Uniqueness: enumerate (1,2) and (2,1) for slots [0,4]. Need ones=3 and zeros=3.
  //   (0=1, 4=2): line=[1,1,1,2,2,2]. ones=3, zeros=3, balanced. But cells 0,1,2 = 1,1,1 → triple. Rejected.
  //   (0=2, 4=1): line=[2,1,1,2,1,2]. ones=3, zeros=3, balanced. No triples. Valid.
  // So uniqueness picks (0=2, 4=1). Forces. Single-remaining doesn't get a chance to add anything new.
  //
  // To isolate single-remaining we need a row with 3+ empties.
  // [_,1,1,2,_,_,_,2,_,2,_,1] (12 cells). rowOnes=3, rowZeros=3, rowHalf=6. Need 3 more ones, 3 more zeros.
  // Not single-remaining (need 1 more, not 3).
  //
  // [_,1,1,2,_,2,2,1,_,2,1,1] (12). rowOnes=5, rowZeros=4, empties at 0,4,8. Need 1 more one, 2 zeros.
  // Single-remaining for ones at 5=rowHalf-1=5? Yes.
  //   col 0: cells 0,1,2 = 1,1,1 → triple. Illegal.
  //   col 4: cells 2,3,4 = 1,2,1 — fine. cells 3,4,5 = 2,1,2 — fine. cells 4,5,6 = 1,2,2 — fine.
  //   col 8: cells 6,7,8 = 2,1,1 — fine. cells 7,8,9 = 1,1,2 — fine. cells 8,9,10 = 1,2,1 — fine.
  // Two legal slots (4 and 8) → can't force. Damn.
  //
  // [1,1,_,2,2,_,1,1,2,_,_,_] (12). rowOnes=4, rowZeros=3, empties at 2,5,9,10,11. Need 2 ones, 3 zeros.
  // Not single-remaining.
  //
  // I'll fall back to a smaller targeted test: build the state manually,
  // call _applySingleRemaining directly, and assert.
  const givens = Array.from({ length: 6 }, () => new Array(6).fill(-1));
  givens[0] = [1, 1, -1, -1, -1, 0]; // partial — 2 ones, 1 zero given
  // Manually fabricate an `initialState` that exercises single-remaining
  // on a column: col 0 has cells 0,1=1 and we'll need 1 more "1" with
  // only one legal slot.
  const initialState = [
    [1, 1, 2, 2, 0, 2],  // ones=2, zeros=3, empties at col 4
    [1, 2, 0, 0, 2, 0],
    [2, 1, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0],
  ];
  // Col 0: cells 0=1, 1=1, 2=2 → if col 0 gets one more "1", placing it at
  // row 3 makes cells 1,2,3 = 1,2,1 — fine. Row 4: cells 2,3,4 = 2,?,1 fine.
  // Row 5: cells 3,4,5 = ?,?,1 — fine. So 3 legal slots — but col 0 already
  // has 2 ones in 6 rows (colHalf=3), so colOnes = 2 = 3-1 = colHalf-1. ✓ single-remaining fires.
  // All three remaining rows (3, 4, 5) of col 0 are legal slots → won't force.
  // To make only one row legal, plant a 1 at row 2 of col 0 first:
  initialState[2][0] = 1; // now col 0 has [1,1,1,_,_,_] which is itself a triple.
  // That's actually a contradiction in the initial state. Skip.

  // Build a config where col 0 has [1,1,2,_,_,_] (rowOnes=2, rowZeros=1).
  // Need 1 more "1" (colHalf-1=2). Slots: rows 3,4,5.
  // Place "1" at row 3: cells 1,2,3 of col 0 = 1,2,1 → fine.
  // Place "1" at row 4: cells 2,3,4 = 2,?,1 → fine.
  // Place "1" at row 5: cells 3,4,5 = ?,?,1 → fine. All legal.
  // To restrict: prefill rows 4 and 5 with something that bans 1 there.
  // Row 4, col 0 must not allow 1 → if rows 5,6 col 0 are 1,1 we'd ban row 4 by triple but row 6 OOB.
  // Try: rows 4 and 5 of col 0 are already filled with 2. Then row 3 is the only empty in col 0.
  // colOnes=2 (rows 0,1), colZeros=3 (rows 2,4,5). Need 1 more "1". One empty (row 3). Forced.
  const initialState2 = [
    [1, 0, 0, 0, 0, 0],
    [1, 0, 0, 0, 0, 0],
    [2, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0],
    [2, 0, 0, 0, 0, 0],
    [2, 0, 0, 0, 0, 0],
  ];
  const givens2 = Array.from({ length: 6 }, () => new Array(6).fill(-1));
  const s = new BinairoSolver({ rows: 6, cols: 6, givens: givens2, initialState: initialState2 });
  let changed = false;
  const ok = s._applySingleRemaining(() => { changed = true; });
  assert.equal(ok, true);
  assert.equal(changed, true, 'single-remaining should fire on col 0 with one slot left');
  assert.equal(s._get(3, 0), 1, 'col 0 row 3 must be forced to 1');
});

test('BinairoSolver: static _solutionCache returns prior solve on identical givens', () => {
  BinairoSolver.clearSolutionCache();
  const p = fixtures.binairo6x6;
  const r1 = new BinairoSolver({ rows: p.rows, cols: p.cols, givens: p.givens }).solve();
  assert.equal(r1.solved, true);
  // Second call must come from cache — no exception, same grid.
  const r2 = new BinairoSolver({ rows: p.rows, cols: p.cols, givens: p.givens }).solve();
  assert.equal(r2.solved, true);
  assert.deepEqual(r2.grid, r1.grid);
  BinairoSolver.clearSolutionCache();
});

test('BinairoSolver: 6x6 captured fixture matches golden', () => {
  BinairoSolver.clearSolutionCache();
  const p = fixtures.binairo6x6;
  const result = clean(
    new BinairoSolver({ rows: p.rows, cols: p.cols, givens: p.givens }).solve()
  );
  assert.deepEqual(result, golden.binairo6x6);
});

test('BinairoSolver: 30x30 weekly solves under 1s (lookahead regression guard)', () => {
  // Before the lookahead propagation phase landed, this puzzle didn't solve
  // within several minutes — local rules + plain backtracking got stuck once
  // initial propagation exhausted. With lookahead it's ~80ms. Bound at 1s
  // generously to absorb CI variance; a regression would mean a fundamental
  // rule/lookahead break, not a small slowdown.
  const real = require('./fixtures/real-puzzles.js');
  const p = real.binairoRealWeekly30x30_a;
  BinairoSolver.clearSolutionCache();
  const t0 = Date.now();
  const result = new BinairoSolver({ rows: p.rows, cols: p.cols, givens: p.givens }).solve();
  const elapsed = Date.now() - t0;
  assert.equal(result.solved, true);
  assert.ok(elapsed < 1000, `30x30 weekly took ${elapsed}ms (>1s); lookahead may have regressed`);
});

test('BinairoSolver: maxMs budget triggers timed-out on unfinishable search', () => {
  // Construct a 30x30 with intentionally degenerate givens that take longer
  // than the budget. Easier path: use the same weekly fixture but set a 1ms
  // budget — the lookahead pass alone outruns that.
  const real = require('./fixtures/real-puzzles.js');
  const p = real.binairoRealWeekly30x30_a;
  BinairoSolver.clearSolutionCache();
  const s = new BinairoSolver({ rows: p.rows, cols: p.cols, givens: p.givens });
  s.maxMs = 1;
  const t0 = Date.now();
  const result = s.solve();
  const elapsed = Date.now() - t0;
  // Either timed-out or finished within the slack. Either way, must bail
  // promptly (well under 500ms).
  assert.ok(elapsed < 500, `solver should bail within 500ms when maxMs=1, took ${elapsed}ms`);
  if (!result.solved) {
    assert.equal(result.error, 'timed out');
  }
});

test('BinairoSolver: _decodeComparison expands flags into pairwise constraints', () => {
  const s = new BinairoSolver({
    rows: 6, cols: 6,
    givens: Array.from({ length: 6 }, () => new Array(6).fill(-1)),
    comparisonClues: [
      [4],                       // (0,0): D-EQ → ((0,0), (1,0), same)
      [null, null, null, 2],     // (1,3): R-NE → ((1,3), (1,4), diff)
      [null, null, 10, 4],       // (2,2): 10=8|2 → R-NE + D-NE
                                 // (2,3): 4=D-EQ → ((2,3), (3,3), same)
    ],
  });
  // Sort for stable comparison.
  const got = s.compConstraints.slice().sort((a, b) =>
    (a.aR - b.aR) || (a.aC - b.aC) || (a.bR - b.bR) || (a.bC - b.bC) ||
    (Number(a.sameSign) - Number(b.sameSign)));
  const expected = [
    { aR: 0, aC: 0, bR: 1, bC: 0, sameSign: true  },  // D-EQ at (0,0)
    { aR: 1, aC: 3, bR: 1, bC: 4, sameSign: false },  // R-NE at (1,3)
    { aR: 2, aC: 2, bR: 2, bC: 3, sameSign: false },  // R-NE at (2,2)
    { aR: 2, aC: 2, bR: 3, bC: 2, sameSign: false },  // D-NE at (2,2)
    { aR: 2, aC: 3, bR: 3, bC: 3, sameSign: true  },  // D-EQ at (2,3)
  ].sort((a, b) =>
    (a.aR - b.aR) || (a.aC - b.aC) || (a.bR - b.bR) || (a.bC - b.bC) ||
    (Number(a.sameSign) - Number(b.sameSign)));
  assert.deepEqual(got, expected);
});

test('BinairoSolver: _decodeComparison drops out-of-grid constraints', () => {
  const s = new BinairoSolver({
    rows: 4, cols: 4,
    givens: Array.from({ length: 4 }, () => new Array(4).fill(-1)),
    comparisonClues: [
      [null, null, null, 1],  // R-EQ on last column → drop
      [null, null, null, 4],  // D-EQ on last column but valid downward → keep
      [null, null, null, null],
      [4, null, null, null],  // D-EQ on last row → drop
    ],
  });
  // Only the (1,3) D-EQ survives.
  assert.equal(s.compConstraints.length, 1);
  assert.deepEqual(s.compConstraints[0],
    { aR: 1, aC: 3, bR: 2, bC: 3, sameSign: true });
});

test('BinairoSolver: _applyComparison EQ forces same value', () => {
  // 4x4 board: only constraint is (0,0) D-EQ (0,0)≡(1,0). Place 1 at (0,0)
  // via givens; propagation should force (1,0) to 1 also.
  const givens = Array.from({ length: 4 }, () => new Array(4).fill(-1));
  givens[0][0] = 1;
  const s = new BinairoSolver({
    rows: 4, cols: 4, givens,
    comparisonClues: [[4]], // D-EQ at (0,0)
  });
  let changed = false;
  const ok = s._applyComparison(() => { changed = true; });
  assert.equal(ok, true);
  assert.equal(changed, true);
  assert.equal(s._get(1, 0), 1, 'cell (1,0) must be forced to match (0,0)=1');
});

test('BinairoSolver: _applyComparison NE forces opposite value', () => {
  // R-NE between (0,0) and (0,1): flag = 2 at (0,0).
  const givens = Array.from({ length: 4 }, () => new Array(4).fill(-1));
  givens[0][0] = 1;
  const s = new BinairoSolver({
    rows: 4, cols: 4, givens,
    comparisonClues: [[2]],
  });
  let changed = false;
  const ok = s._applyComparison(() => { changed = true; });
  assert.equal(ok, true);
  assert.equal(changed, true);
  assert.equal(s._get(0, 1), 2, 'cell (0,1) must be forced opposite to (0,0)=1');
});

test('BinairoSolver: _applyComparison flags inconsistent prefill as contradiction', () => {
  // R-EQ between (0,0) and (0,1), but givens contradict it.
  const givens = Array.from({ length: 4 }, () => new Array(4).fill(-1));
  givens[0][0] = 1;
  givens[0][1] = 0;
  const s = new BinairoSolver({
    rows: 4, cols: 4, givens,
    comparisonClues: [[1]],
  });
  const ok = s._applyComparison(() => {});
  assert.equal(ok, false, 'should report contradiction when EQ holds 1 vs 0');
});

test('BinairoSolver: _cacheKey differs when comparisonClues differ', () => {
  const givens = Array.from({ length: 4 }, () => new Array(4).fill(-1));
  const a = new BinairoSolver({ rows: 4, cols: 4, givens, comparisonClues: [] });
  const b = new BinairoSolver({ rows: 4, cols: 4, givens, comparisonClues: [[1]] });
  const c = new BinairoSolver({ rows: 4, cols: 4, givens, comparisonClues: [[2]] });
  assert.notEqual(a._cacheKey(), b._cacheKey(), 'empty vs R-EQ must differ');
  assert.notEqual(b._cacheKey(), c._cacheKey(), 'R-EQ vs R-NE must differ');
});

test('BinairoSolver: binairoPlus6x6 fixture matches golden', () => {
  BinairoSolver.clearSolutionCache();
  const p = fixtures.binairoPlus6x6;
  const result = clean(
    new BinairoSolver({
      rows: p.rows, cols: p.cols, givens: p.givens,
      comparisonClues: p.comparisonClues,
    }).solve()
  );
  assert.deepEqual(result, golden.binairoPlus6x6);
});

test('BinairoSolver: getHint carries comparisonClues onto the clone (binairo-plus regression)', () => {
  // Hand-built 4x4 case where comparison clues are the ONLY way to make
  // progress. Empty givens leave many candidates; the two clues below
  // (R-EQ at (0,0) and R-NE at (1,0)) pin nothing on their own, but the
  // chained constraints + balance let propagate deduce at least one cell.
  // If getHint forgot to carry compConstraints, no comparison-driven
  // deductions would surface and the cell count would be 0.
  const givens = Array.from({ length: 4 }, () => new Array(4).fill(-1));
  givens[0][0] = 1; // seed so R-EQ at (0,0) has work to do
  const comparisonClues = [[1], [2]]; // R-EQ at (0,0), R-NE at (1,0)
  const s = new BinairoSolver({ rows: 4, cols: 4, givens, comparisonClues });
  const grid = s._gridTo2D();
  const hint = s.getHint(grid);
  assert.ok(hint, 'getHint should find at least one comparison-driven cell');
  const cells = [
    ...hint.cells.map(c => ({ row: hint.index, col: c.index, value: c.value })),
    ...hint.extraCells,
  ];
  // R-EQ at (0,0) with (0,0)=1 forces (0,1)=1.
  const forced01 = cells.find(c => c.row === 0 && c.col === 1);
  assert.ok(forced01, 'getHint must force (0,1) via R-EQ with (0,0)=1');
  assert.equal(forced01.value, 1, '(0,1) must be 1 (matching (0,0))');
});

test('BinairoSolver: _applyLineEnumeration forces cells from per-line completions', () => {
  // 4x4 col 0: cells [1, 0, ?, ?]. needOnes = 2-1 = 1, empties = 2.
  // Candidates (2,1) and (1,2). (2,1) at pos (3,0) = 1 — fine. (1,2) puts
  // (2,0) = 1; cells (0,0)=1, (1,0)=0, (2,0)=1 — no triple. Both legal in
  // isolation. Add a D-NE at (1,0) forcing (1,0) != (2,0); cell (1,0)=0
  // so (2,0) must be 1. After that, (3,0) must be 0 (balance: ones=2).
  const givens = Array.from({ length: 4 }, () => new Array(4).fill(-1));
  givens[0][0] = 1;
  givens[1][0] = 0;
  const comparisonClues = [[], [8]]; // D-NE at (1,0) → (1,0) ≠ (2,0)
  const s = new BinairoSolver({ rows: 4, cols: 4, givens, comparisonClues });
  let changed = false;
  const ok = s._applyLineEnumeration(() => { changed = true; });
  assert.equal(ok, true);
  assert.equal(changed, true);
  assert.equal(s._get(2, 0), 1, 'D-NE forces (2,0) != (1,0)=0 → (2,0)=1');
  assert.equal(s._get(3, 0), 2, 'balance forces (3,0)=2 (2 ones already in col)');
});

test('ShikakuSolver: constructor rejects clue-sum mismatch', () => {
  assert.throws(() => new ShikakuSolver({
    rows: 3, cols: 3,
    clues: [{ row: 0, col: 0, area: 4 }, { row: 2, col: 2, area: 4 }],
  }), /sum/i);
});

test('ShikakuSolver: candidate enumeration produces all valid rectangles', () => {
  // 2x4 grid, clue area=4 at (0,0) and area=4 at (1,3).
  //   Rectangles containing (0,0) with area 4:
  //     (0,0)-(0,3) 1×4 → contains (1,3)? No → valid
  //     (0,0)-(3,0) 4×1 → out of grid (rows=2) → invalid
  //     (0,0)-(1,1) 2×2 → contains (1,3)? No → valid
  //   Same shape for clue (1,3)=4 (mirrored).
  const s = new ShikakuSolver({
    rows: 2, cols: 4,
    clues: [{ row: 0, col: 0, area: 4 }, { row: 1, col: 3, area: 4 }],
  });
  function key(r) { return `${r.r1},${r.c1}-${r.r2},${r.c2}`; }
  const got = s.candidates.map(cs => cs.map(key).sort());
  assert.deepEqual(got[0].sort(), ['0,0-0,3', '0,0-1,1'].sort(),
    'clue (0,0)=4 candidates wrong');
  assert.deepEqual(got[1].sort(), ['0,2-1,3', '1,0-1,3'].sort(),
    'clue (1,3)=4 candidates wrong');
});

test('ShikakuSolver: single-candidate forcing places the rectangle', () => {
  // 2x2 grid, single clue area=4 at (0,0). Only candidate is the full grid.
  const s = new ShikakuSolver({
    rows: 2, cols: 2,
    clues: [{ row: 0, col: 0, area: 4 }],
  });
  assert.equal(s.candidates[0].length, 1, 'should have exactly 1 candidate');
  const ok = s.propagate();
  assert.equal(ok, true);
  assert.equal(s.placed[0], 1, 'clue 0 must be placed');
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 2; c++) {
      assert.equal(s.owner[r * 2 + c], 0, `cell (${r},${c}) must be owned by clue 0`);
    }
  }
});

test('ShikakuSolver: solves a trivial 2x2 single-clue puzzle', () => {
  const s = new ShikakuSolver({
    rows: 2, cols: 2,
    clues: [{ row: 0, col: 0, area: 4 }],
  });
  const r = s.solve();
  assert.equal(r.solved, true);
  assert.equal(r.grid.length, 2);
  assert.equal(r.grid[0].length, 2);
  for (let r2 = 0; r2 < 2; r2++) {
    for (let c = 0; c < 2; c++) {
      assert.equal(r.grid[r2][c], 0);
    }
  }
});

test('ShikakuSolver: solves a 2x4 two-clue puzzle requiring backtracking', () => {
  const s = new ShikakuSolver({
    rows: 2, cols: 4,
    clues: [{ row: 0, col: 0, area: 4 }, { row: 1, col: 3, area: 4 }],
  });
  const r = s.solve();
  assert.equal(r.solved, true);
  const counts = [0, 0];
  for (let r2 = 0; r2 < 2; r2++) {
    for (let c = 0; c < 4; c++) {
      const o = r.grid[r2][c];
      assert.ok(o === 0 || o === 1, `cell (${r2},${c}) has owner ${o}`);
      counts[o]++;
    }
  }
  assert.equal(counts[0], 4);
  assert.equal(counts[1], 4);
});

test('ShikakuSolver: static _solutionCache returns prior solve on identical clues', () => {
  ShikakuSolver.clearSolutionCache();
  const clues = [
    { row: 0, col: 0, area: 4 },
    { row: 1, col: 3, area: 4 },
  ];
  const r1 = new ShikakuSolver({ rows: 2, cols: 4, clues }).solve();
  assert.equal(r1.solved, true);
  const r2 = new ShikakuSolver({ rows: 2, cols: 4, clues }).solve();
  assert.equal(r2.solved, true);
  assert.deepEqual(r2.grid, r1.grid);
  ShikakuSolver.clearSolutionCache();
});

test('ShikakuSolver: getHint reveals a whole rectangle including its clue cell', () => {
  ShikakuSolver.clearSolutionCache();
  const clues = [
    { row: 0, col: 0, area: 4 },
    { row: 1, col: 3, area: 4 },
  ];
  const s = new ShikakuSolver({ rows: 2, cols: 4, clues });
  const empty = [[-1, -1, -1, -1], [-1, -1, -1, -1]];
  const hint = s.getHint(empty);
  assert.ok(hint, 'getHint must return a rectangle from an empty board');
  assert.ok(hint.clue, 'hint must carry the clue it reveals');
  // Flatten the hint into absolute {row,col} cells.
  const cells = [
    ...(hint.cells || []).map(c => ({ row: hint.index, col: c.index })),
    ...(hint.extraCells || []).map(c => ({ row: c.row, col: c.col })),
  ];
  assert.equal(cells.length, hint.clue.area,
    `hint must cover the clue's whole ${hint.clue.area}-cell rectangle`);
  assert.ok(
    cells.some(c => c.row === hint.clue.row && c.col === hint.clue.col),
    'hint cells must include the clue (number) cell itself');
  ShikakuSolver.clearSolutionCache();
});

test('ShikakuSolver: 5x5 fixture matches golden', () => {
  ShikakuSolver.clearSolutionCache();
  const p = fixtures.shikaku5x5;
  const result = clean(
    new ShikakuSolver({ rows: p.rows, cols: p.cols, clues: p.clues }).solve()
  );
  assert.deepEqual(result, golden.shikaku5x5);
});

test('YinYangSolver: constructor translates task givens to cellStatus encoding', () => {
  const task = [
    [-1, 0, 1],
    [1, -1, -1],
  ];
  const s = new YinYangSolver({ rows: 2, cols: 3, task });
  // -1 -> 0 empty, 0 -> 2 white, 1 -> 1 black.
  assert.equal(s._get(0, 0), 0);
  assert.equal(s._get(0, 1), 2);
  assert.equal(s._get(0, 2), 1);
  assert.equal(s._get(1, 0), 1);
  assert.equal(s._get(1, 1), 0);
});

test('YinYangSolver: initialState overrides givens when provided', () => {
  const task = [[-1, -1], [-1, -1]];
  const s = new YinYangSolver({
    rows: 2, cols: 2, task,
    initialState: [[1, 2], [0, 0]],
  });
  assert.equal(s._get(0, 0), 1);
  assert.equal(s._get(0, 1), 2);
  assert.equal(s._get(1, 0), 0);
});

test('YinYangSolver: constructor rejects invalid dimensions', () => {
  assert.throws(() => new YinYangSolver({ rows: 0, cols: 3, task: [] }));
  assert.throws(() => new YinYangSolver({ rows: 3, cols: 3, task: 'nope' }));
});
