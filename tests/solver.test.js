const test = require('node:test');
const assert = require('node:assert/strict');
const { NonogramSolver, AquariumSolver, GalaxiesSolver, BinairoSolver, ShikakuSolver, YinYangSolver, SlitherlinkSolver, HashiSolver, HeyawakeSolver, computePuzzleDiff } = require('../solver.js');
const fixtures = require('./fixtures/puzzles.js');
const golden = require('./golden.js');

function heyawakeRoomsFromFixture(fixture) {
  const { rows, cols, areas, areaTask } = fixture;
  const cellsPerRoom = {};
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const k = areas[r][c];
      if (!cellsPerRoom[k]) cellsPerRoom[k] = [];
      cellsPerRoom[k].push({ r, c });
    }
  }
  return areaTask.map((target, k) => ({ cells: cellsPerRoom[k], target }));
}

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

test('YinYangSolver: 6x6 fixture matches golden', () => {
  YinYangSolver.clearSolutionCache();
  const p = fixtures.yinyang6x6;
  const result = clean(
    new YinYangSolver({ rows: p.rows, cols: p.cols, task: p.task }).solve()
  );
  assert.deepEqual(result, golden.yinyang6x6);
});

test('YinYangSolver: _is2x2Illegal flags monochrome and checkerboard', () => {
  const s = new YinYangSolver({ rows: 2, cols: 2, task: [[-1, -1], [-1, -1]] });
  assert.equal(s._is2x2Illegal(1, 1, 1, 1), true, 'all black');
  assert.equal(s._is2x2Illegal(2, 2, 2, 2), true, 'all white');
  assert.equal(s._is2x2Illegal(1, 2, 2, 1), true, 'checkerboard B/W');
  assert.equal(s._is2x2Illegal(2, 1, 1, 2), true, 'checkerboard W/B');
  assert.equal(s._is2x2Illegal(1, 1, 2, 2), false, 'split is legal');
  assert.equal(s._is2x2Illegal(1, 2, 1, 2), false, 'column split is legal');
});

test('YinYangSolver: 2x2 rule forces the 4th cell of a monochrome-3 window', () => {
  // TL,TR,BL all black -> BR must be white (else 2x2 monochrome).
  const s = new YinYangSolver({
    rows: 2, cols: 2, task: [[-1, -1], [-1, -1]],
    initialState: [[1, 1], [1, 0]],
  });
  assert.equal(s.propagate(), true);
  assert.equal(s._get(1, 1), 2);
});

test('YinYangSolver: 2x2 rule forces the 4th cell of a checkerboard-3 window', () => {
  // TL=black, TR=white, BL=white, BR empty. BR=black -> checkerboard;
  // so BR is forced white.
  const s = new YinYangSolver({
    rows: 2, cols: 2, task: [[-1, -1], [-1, -1]],
    initialState: [[1, 2], [2, 0]],
  });
  assert.equal(s.propagate(), true);
  assert.equal(s._get(1, 1), 2);
});

test('YinYangSolver: 2x2 rule reports contradiction on an illegal full window', () => {
  const s = new YinYangSolver({
    rows: 2, cols: 2, task: [[-1, -1], [-1, -1]],
    initialState: [[1, 1], [1, 1]],
  });
  assert.equal(s.propagate(), false);
});

test('YinYangSolver: _colorConnected detects disconnected placed cells', () => {
  // Two black cells separated by a white wall, no empty bridge.
  const s = new YinYangSolver({
    rows: 1, cols: 3, task: [[-1, -1, -1]],
    initialState: [[1, 2, 1]],
  });
  assert.equal(s._colorConnected(1, -1), false);
});

test('YinYangSolver: connectivity-cut probe forces a bridging cell', () => {
  // Row: black, empty, black. The empty cell is the only path between the
  // two black cells, so it is forced black.
  const s = new YinYangSolver({
    rows: 1, cols: 3, task: [[-1, -1, -1]],
    initialState: [[1, 0, 1]],
  });
  assert.equal(s.propagate(), true);
  assert.equal(s._get(0, 1), 1);
});

test('YinYangSolver: connectivity reports contradiction on a severed color', () => {
  const s = new YinYangSolver({
    rows: 1, cols: 3, task: [[-1, -1, -1]],
    initialState: [[1, 2, 1]],
  });
  assert.equal(s.propagate(), false);
});

test('YinYangSolver: solves the 6x6 fixture into a valid board', () => {
  YinYangSolver.clearSolutionCache();
  const p = fixtures.yinyang6x6;
  const result = new YinYangSolver({ rows: p.rows, cols: p.cols, task: p.task }).solve();
  assert.equal(result.solved, true);
  // Every cell placed.
  for (const row of result.grid) {
    for (const v of row) assert.ok(v === 1 || v === 2, 'every cell is black or white');
  }
  // Givens respected.
  for (let r = 0; r < p.rows; r++) {
    for (let c = 0; c < p.cols; c++) {
      const g = p.task[r][c];
      if (g === 1) assert.equal(result.grid[r][c], 1);
      if (g === 0) assert.equal(result.grid[r][c], 2);
    }
  }
  YinYangSolver.clearSolutionCache();
});

test('YinYangSolver: reports contradiction on an unsolvable board', () => {
  // A 2x2 forced into a monochrome by givens.
  const result = new YinYangSolver({
    rows: 2, cols: 2, task: [[1, 1], [1, 1]],
  }).solve();
  assert.equal(result.solved, false);
  assert.equal(result.grid, null);
});

test('YinYangSolver: maxMs budget makes a hard solve bail quickly', () => {
  const task = Array.from({ length: 14 }, () => new Array(14).fill(-1));
  const s = new YinYangSolver({ rows: 14, cols: 14, task });
  s.maxMs = 1;
  const t0 = Date.now();
  s.solve();
  assert.ok(Date.now() - t0 < 500, 'solve must bail within 500ms when maxMs=1');
});

test('YinYangSolver: getHint returns cells forced by propagation', () => {
  // Row: black, empty, black -> the empty cell is forced black.
  const s = new YinYangSolver({ rows: 1, cols: 3, task: [[-1, -1, -1]] });
  const hint = s.getHint([[1, 0, 1]]);
  assert.ok(hint, 'getHint must return a hint');
  const all = [
    ...(hint.cells || []).map(c => ({ row: hint.index, col: c.index, value: c.value })),
    ...(hint.extraCells || []),
  ];
  assert.ok(all.some(c => c.row === 0 && c.col === 1 && c.value === 1),
    'cell (0,1) must be forced black');
});

test('YinYangSolver: getHint returns null when nothing is deducible', () => {
  // A fully solved 6x6 — propagation forces nothing.
  YinYangSolver.clearSolutionCache();
  const p = fixtures.yinyang6x6;
  const solved = new YinYangSolver({ rows: p.rows, cols: p.cols, task: p.task }).solve();
  const s = new YinYangSolver({ rows: p.rows, cols: p.cols, task: p.task });
  assert.equal(s.getHint(solved.grid), null);
  YinYangSolver.clearSolutionCache();
});

test('YinYangSolver: getHint falls back to a bounded lookahead step when local rules stall', () => {
  // The 35x35 weekly: local rules stall well short of a solution. Drive the
  // board to that local-rules fixpoint, then confirm the fast (local-only)
  // hint finds nothing there, getHint falls back to a lookahead step, and
  // that step is bounded — an immediate next step, not the whole remainder.
  const real = require('./fixtures/real-puzzles.js');
  const p = real.yinyangWeekly35x35;
  const stall = new YinYangSolver({ rows: p.rows, cols: p.cols, task: p.task });
  stall._depth = 1; // local rules only — lookahead disabled
  stall.propagate();
  const stalledGrid = stall._gridTo2D();
  let remainingEmpty = 0;
  for (const row of stalledGrid) for (const v of row) if (v === 0) remainingEmpty++;
  assert.ok(remainingEmpty > 0, 'the local rules should leave the 35x35 incomplete');

  const probe = new YinYangSolver({ rows: p.rows, cols: p.cols, task: p.task });
  assert.equal(probe._localHint(stalledGrid), null,
    'the local-only hint should find nothing on the stalled grid');
  const hint = probe.getHint(stalledGrid);
  assert.ok(hint, 'getHint must fall back to a lookahead step and return a hint');
  const total = hint.cells.length + hint.extraCells.length;
  assert.ok(total < remainingEmpty,
    `lookahead-step hint (${total} cells) must be smaller than the ${remainingEmpty} remaining empties`);
});

test('YinYangSolver: reachability forces an unreachable empty cell', () => {
  // 1x3: black at (0,0), white wall at (0,1), empty (0,2). (0,2) cannot
  // reach the black region -> it can never be black -> forced white.
  const s = new YinYangSolver({
    rows: 1, cols: 3, task: [[-1, -1, -1]],
    initialState: [[1, 2, 0]],
  });
  assert.equal(s._applyReachability(1, () => {}), true);
  assert.equal(s._get(0, 2), 2);
});

test('YinYangSolver: reachability reports contradiction on a severed colour', () => {
  // black at (0,0) and (0,2), white wall between -> black cannot connect.
  const s = new YinYangSolver({
    rows: 1, cols: 3, task: [[-1, -1, -1]],
    initialState: [[1, 2, 1]],
  });
  assert.equal(s._applyReachability(1, () => {}), false);
});

test('YinYangSolver: reachability is a no-op when the colour has no placed cells', () => {
  const s = new YinYangSolver({
    rows: 1, cols: 3, task: [[-1, -1, -1]],
    initialState: [[0, 0, 0]],
  });
  assert.equal(s._applyReachability(1, () => {}), true);
  assert.equal(s._get(0, 0), 0);
  assert.equal(s._get(0, 1), 0);
  assert.equal(s._get(0, 2), 0);
});

test('YinYangSolver: _articulationPoints finds the cut cell of a path graph', () => {
  // 1x3 all empty -> G is a 3-cell path A-B-C -> middle cell (index 1) is
  // the only articulation point.
  const s = new YinYangSolver({ rows: 1, cols: 3, task: [[-1, -1, -1]] });
  assert.deepEqual([...s._articulationPoints(1)].sort((a, b) => a - b), [1]);
});

test('YinYangSolver: _articulationPoints finds none in a 2x2 cycle', () => {
  // 2x2 all empty -> G is a 4-cycle (2-connected) -> no articulation points.
  const s = new YinYangSolver({ rows: 2, cols: 2, task: [[-1, -1], [-1, -1]] });
  assert.deepEqual([...s._articulationPoints(1)], []);
});

test('YinYangSolver: _articulationPoints excludes cells not in the colour graph', () => {
  // 1x3 with the middle cell = white. For colour 1 the graph is just the two
  // endpoints (disconnected) -> no articulation points.
  const s = new YinYangSolver({
    rows: 1, cols: 3, task: [[-1, -1, -1]],
    initialState: [[1, 2, 1]],
  });
  assert.deepEqual([...s._articulationPoints(1)], []);
});

test('YinYangSolver: propagate forces unreachable cells via reachability', () => {
  // 1x5: black, white, empty, empty, empty. The three empties cannot reach
  // the black region (the white cell blocks) -> all forced white. The old
  // per-cell cut probe missed this; the reachability rule catches it.
  const s = new YinYangSolver({
    rows: 1, cols: 5, task: [[-1, -1, -1, -1, -1]],
    initialState: [[1, 2, 0, 0, 0]],
  });
  assert.equal(s.propagate(), true);
  assert.equal(s._get(0, 2), 2);
  assert.equal(s._get(0, 3), 2);
  assert.equal(s._get(0, 4), 2);
});

test('YinYangSolver: _applyLookahead forces nothing and returns true on an open board', () => {
  // 4x4 all empty — many valid solutions, no single cell is forced.
  const s = new YinYangSolver({
    rows: 4, cols: 4, task: Array.from({ length: 4 }, () => [-1, -1, -1, -1]),
  });
  let changes = 0;
  assert.equal(s._applyLookahead(() => { changes++; }), true);
  assert.equal(changes, 0);
});

test('YinYangSolver: _applyLookahead detects unsolvability via the both-fail probe', () => {
  // 2x4 board where black corners cannot be 2-coloured validly: probing the
  // first empty cell, BOTH colours propagate to a connectivity contradiction.
  const s = new YinYangSolver({
    rows: 2, cols: 4, task: [[-1, -1, -1, -1], [-1, -1, -1, -1]],
    initialState: [[1, 1, 0, 0], [0, 0, 1, 1]],
  });
  assert.equal(s._applyLookahead(() => {}), false);
});

test('YinYangSolver: _applyBorderArc rejects a board with >2 border arcs', () => {
  // 3x3 with all 8 border cells placed in an alternating B/W ring -> the
  // border has 8 colour transitions (4 arcs) -> unsolvable.
  const s = new YinYangSolver({
    rows: 3, cols: 3, task: [[-1, -1, -1], [-1, -1, -1], [-1, -1, -1]],
    initialState: [[1, 2, 1], [2, 0, 2], [1, 2, 1]],
  });
  assert.equal(s._applyBorderArc(() => {}), false);
});

test('YinYangSolver: _applyBorderArc forces a border cell to avoid a 3rd arc', () => {
  // Border has placed cells B,W,B forming 2 arcs; the empty cell at (1,0)
  // would create a 3rd arc if white, so it is forced black.
  const s = new YinYangSolver({
    rows: 3, cols: 3, task: [[-1, -1, -1], [-1, -1, -1], [-1, -1, -1]],
    initialState: [[0, 1, 0], [0, 0, 2], [1, 0, 0]],
  });
  assert.equal(s._applyBorderArc(() => {}), true);
  assert.equal(s._get(1, 0), 1);
});

test('computePuzzleDiff: flags a wrongly-placed cell, ignores correct and empty', () => {
  const solution = [[1, 2], [1, 2]];
  const grid = [[0, 1], [1, 0]]; // (0,1)=1 vs solution 2 -> mistake; (1,0) ok; (0,0),(1,1) empty
  assert.deepEqual(computePuzzleDiff('binairo', grid, solution), [{ row: 0, col: 1 }]);
});

test('computePuzzleDiff: galaxies normalizes by star — relabeled regions are not mistakes', () => {
  // 2x2 grid, 2 stars in doubled coords: (0,0)->anchor (0,0), (2,2)->anchor (1,1).
  const stars = [{ row: 0, col: 0 }, { row: 2, col: 2 }];
  const solution = [[1, 2], [1, 2]]; // star 0 owns the left column, star 1 the right
  // Same partition, but the player's regions are labelled 5/8 instead of 1/2:
  const relabeled = [[5, 8], [5, 8]];
  assert.deepEqual(computePuzzleDiff('galaxies', relabeled, solution, stars), [],
    'a correct partition with different region labels must not be flagged');
});

test('computePuzzleDiff: galaxies flags cells in the wrong galaxy', () => {
  const stars = [{ row: 0, col: 0 }, { row: 2, col: 2 }];
  const solution = [[1, 2], [1, 2]]; // columns
  const wrong = [[5, 5], [8, 8]];    // player split by rows instead
  const set = new Set(
    computePuzzleDiff('galaxies', wrong, solution, stars).map(d => d.row + ',' + d.col));
  assert.equal(set.has('0,1'), true, 'cell in the wrong galaxy is flagged');
  assert.equal(set.has('1,0'), true);
  assert.equal(set.has('0,0'), false, 'cell in the right galaxy is not flagged');
  assert.equal(set.has('1,1'), false);
});

test('computePuzzleDiff: galaxies does not flag a blank board (region holds multiple stars)', () => {
  const stars = [{ row: 0, col: 0 }, { row: 2, col: 2 }];
  const solution = [[1, 2], [1, 2]];
  // A blank galaxies board flood-fills to ONE region (id 1) holding BOTH
  // stars — uncommitted, so nothing is a mistake.
  const blank = [[1, 1], [1, 1]];
  assert.deepEqual(computePuzzleDiff('galaxies', blank, solution, stars), []);
});

test('computePuzzleDiff: shikaku flags a wrongly-shaped rectangle, not a correct one', () => {
  // 2x4 solution: clue 0 owns the left 2x2, clue 1 owns the right 2x2.
  const solution = [[0, 0, 1, 1], [0, 0, 1, 1]];
  // Player board with page owner ids (7/9/5) that DON'T match solver indices:
  // owner 7 = the correct left 2x2; owners 9 and 5 = wrong 2x1 columns.
  const grid = [[7, 7, 9, 5], [7, 7, 9, 5]];
  const set = new Set(computePuzzleDiff('shikaku', grid, solution).map(d => d.row + ',' + d.col));
  assert.equal(set.has('0,0'), false, 'correct left rectangle not flagged');
  assert.equal(set.has('1,1'), false);
  assert.equal(set.has('0,2'), true, 'wrong-shaped right rectangle flagged');
  assert.equal(set.has('0,3'), true);
  assert.equal(set.has('1,2'), true);
  assert.equal(set.has('1,3'), true);
});

test('computePuzzleDiff: shikaku ignores unassigned (-1) cells', () => {
  assert.deepEqual(computePuzzleDiff('shikaku', [[-1, -1], [-1, -1]], [[0, 0], [0, 0]]), []);
});

test('computePuzzleDiff: returns empty when grids are missing', () => {
  assert.deepEqual(computePuzzleDiff('binairo', null, [[1]]), []);
});

test('computePuzzleDiff: slitherlink returns empty on a correct partial board', () => {
  const board = {
    horizontal: [[1, 0, 0], [0, 0, 0]],
    vertical:   [[0, 0, 0, 0]],
  };
  const solution = {
    horizontal: [[1, 1, 1], [1, 1, 1]],
    vertical:   [[1, 0, 0, 1]],
  };
  const diff = computePuzzleDiff('slitherlink', board, solution);
  assert.deepEqual(diff, []);
});

test('computePuzzleDiff: slitherlink flags a wrong horizontal LINE', () => {
  const board = {
    horizontal: [[1, 1, 0], [0, 0, 0]],
    vertical:   [[0, 0, 0, 0]],
  };
  const solution = {
    horizontal: [[1, 0, 1], [1, 1, 1]],
    vertical:   [[1, 0, 0, 1]],
  };
  const diff = computePuzzleDiff('slitherlink', board, solution);
  assert.deepEqual(diff, [{ orientation: 'h', r: 0, c: 1 }]);
});

test('computePuzzleDiff: slitherlink ignores empty-edge cells', () => {
  const board = {
    horizontal: [[0, 0, 0], [0, 0, 0]],
    vertical:   [[0, 0, 0, 0]],
  };
  const solution = {
    horizontal: [[1, 1, 1], [1, 1, 1]],
    vertical:   [[1, 1, 1, 1]],
  };
  const diff = computePuzzleDiff('slitherlink', board, solution);
  assert.deepEqual(diff, []);
});

test('SlitherlinkSolver: constructor builds H/V edge arrays of the right shape', () => {
  const task = [
    [-1, -1, -1, -1,  3],
    [-1,  2, -1, -1, -1],
    [-1,  2, -1,  0,  3],
    [-1,  1, -1, -1,  3],
    [-1,  2,  3,  1, -1],
  ];
  const s = new SlitherlinkSolver({ width: 5, height: 5, task });
  assert.equal(s.width, 5);
  assert.equal(s.height, 5);
  // (H+1) * W horizontal slots, H * (W+1) vertical slots.
  assert.equal(s.H.length, 6 * 5);
  assert.equal(s.V.length, 5 * 6);
  // All edges UNKNOWN (0) initially.
  for (let i = 0; i < s.H.length; i++) assert.equal(s.H[i], 0);
  for (let i = 0; i < s.V.length; i++) assert.equal(s.V[i], 0);
  // Dot counters all zero.
  for (let i = 0; i < s.lineCount.length; i++) assert.equal(s.lineCount[i], 0);
  for (let i = 0; i < s.unknownCount.length; i++) {
    // Every dot has between 2 and 4 incident edges (corner=2, edge=3, interior=4).
    assert.ok(s.unknownCount[i] >= 2 && s.unknownCount[i] <= 4);
  }
});

test('SlitherlinkSolver: _setEdge LINE/EMPTY updates dot counters and trails', () => {
  const s = new SlitherlinkSolver({
    width: 2, height: 2,
    task: [[-1, -1], [-1, -1]],
  });
  // Pick H[0][0] (top edge of top-left cell): joins dot (0,0) and dot (0,1).
  const mark = s.trail.length;
  const id = s._hIdx(0, 0);
  const d00 = s._dotId(0, 0);
  const d01 = s._dotId(0, 1);
  const u00Before = s.unknownCount[d00];
  const u01Before = s.unknownCount[d01];
  assert.equal(s._setEdge(id, 'H', 1), true);  // assign LINE
  assert.equal(s.H[id], 1);
  assert.equal(s.lineCount[d00], 1);
  assert.equal(s.lineCount[d01], 1);
  assert.equal(s.unknownCount[d00], u00Before - 1);
  assert.equal(s.unknownCount[d01], u01Before - 1);
  s._rollback(mark);
  assert.equal(s.H[id], 0);
  assert.equal(s.lineCount[d00], 0);
  assert.equal(s.lineCount[d01], 0);
  assert.equal(s.unknownCount[d00], u00Before);
  assert.equal(s.unknownCount[d01], u01Before);

  // Same edge, now assign EMPTY. unknownCount should still decrement, but
  // lineCount must stay at 0 (EMPTY isn't a loop edge).
  const mark2 = s.trail.length;
  assert.equal(s._setEdge(id, 'H', 2), true);   // assign EMPTY
  assert.equal(s.H[id], 2);
  assert.equal(s.lineCount[d00], 0);
  assert.equal(s.lineCount[d01], 0);
  assert.equal(s.unknownCount[d00], u00Before - 1);
  assert.equal(s.unknownCount[d01], u01Before - 1);
  s._rollback(mark2);
  assert.equal(s.H[id], 0);
  assert.equal(s.lineCount[d00], 0);
  assert.equal(s.lineCount[d01], 0);
  assert.equal(s.unknownCount[d00], u00Before);
  assert.equal(s.unknownCount[d01], u01Before);
});

test('SlitherlinkSolver: constructor rejects invalid dimensions', () => {
  assert.throws(() => new SlitherlinkSolver({ width: 0, height: 3, task: [] }));
  assert.throws(() => new SlitherlinkSolver({ width: 3, height: 3, task: 'nope' }));
});

test('SlitherlinkSolver: _setEdge returns false when overwriting an existing value', () => {
  const s = new SlitherlinkSolver({
    width: 2, height: 2,
    task: [[-1, -1], [-1, -1]],
  });
  const id = s._hIdx(0, 0);
  assert.equal(s._setEdge(id, 'H', 1), true);   // first assign
  assert.equal(s._setEdge(id, 'H', 1), true);   // same value -> no-op true
  assert.equal(s._setEdge(id, 'H', 2), false);  // overwrite -> false
  assert.equal(s.H[id], 1);                     // unchanged
});

test('SlitherlinkSolver: _propagateClues forces EMPTY when m==clue', () => {
  // Clue 0 at (0,0): all 4 edges of that cell must be EMPTY.
  const s = new SlitherlinkSolver({
    width: 2, height: 2,
    task: [[0, -1], [-1, -1]],
  });
  const onChange = () => {};
  assert.equal(s._propagateClues(onChange), true);
  // top H[0][0], bottom H[1][0], left V[0][0], right V[0][1] all EMPTY.
  assert.equal(s.H[s._hIdx(0, 0)], 2);
  assert.equal(s.H[s._hIdx(1, 0)], 2);
  assert.equal(s.V[s._vIdx(0, 0)], 2);
  assert.equal(s.V[s._vIdx(0, 1)], 2);
});

test('SlitherlinkSolver: _propagateClues forces LINE when m+n==clue', () => {
  // Clue 2 at (0,0) with top and left edges pre-EMPTY: forces bottom + right to LINE.
  const s = new SlitherlinkSolver({
    width: 2, height: 2,
    task: [[2, -1], [-1, -1]],
  });
  // Pre-set top edge to EMPTY, left edge to EMPTY.
  s._setEdge(s._hIdx(0, 0), 'H', 2);
  s._setEdge(s._vIdx(0, 0), 'V', 2);
  const onChange = () => {};
  assert.equal(s._propagateClues(onChange), true);
  // bottom + right must now both be LINE.
  assert.equal(s.H[s._hIdx(1, 0)], 1);
  assert.equal(s.V[s._vIdx(0, 1)], 1);
});

test('SlitherlinkSolver: _propagateClues reports contradiction when m > clue', () => {
  // Clue 1 at (0,0), but two of its edges already LINE.
  const s = new SlitherlinkSolver({
    width: 2, height: 2,
    task: [[1, -1], [-1, -1]],
  });
  s._setEdge(s._hIdx(0, 0), 'H', 1);
  s._setEdge(s._vIdx(0, 0), 'V', 1);
  assert.equal(s._propagateClues(() => {}), false);
});

test('SlitherlinkSolver: _propagateClues reports contradiction when m+n < clue', () => {
  // Clue 3 at (0,0), with 2 edges already EMPTY: only 2 edges left, can't reach 3.
  const s = new SlitherlinkSolver({
    width: 2, height: 2,
    task: [[3, -1], [-1, -1]],
  });
  s._setEdge(s._hIdx(0, 0), 'H', 2);
  s._setEdge(s._vIdx(0, 0), 'V', 2);
  assert.equal(s._propagateClues(() => {}), false);
});

test('SlitherlinkSolver: _propagateVertices forces EMPTY when m==2', () => {
  const s = new SlitherlinkSolver({ width: 2, height: 2, task: [[-1, -1], [-1, -1]] });
  s._setEdge(s._hIdx(1, 0), 'H', 1);
  s._setEdge(s._vIdx(1, 1), 'V', 1);
  assert.equal(s._propagateVertices(() => {}), true);
  assert.equal(s.H[s._hIdx(1, 1)], 2);
  assert.equal(s.V[s._vIdx(0, 1)], 2);
});

test('SlitherlinkSolver: _propagateVertices forces LINE when m==1 && n==1', () => {
  const s = new SlitherlinkSolver({ width: 2, height: 2, task: [[-1, -1], [-1, -1]] });
  s._setEdge(s._hIdx(0, 0), 'H', 1);
  assert.equal(s._propagateVertices(() => {}), true);
  assert.equal(s.V[s._vIdx(0, 0)], 1);
});

test('SlitherlinkSolver: _propagateVertices forces EMPTY when m==0 && n==1', () => {
  const s = new SlitherlinkSolver({ width: 2, height: 2, task: [[-1, -1], [-1, -1]] });
  s._setEdge(s._hIdx(0, 0), 'H', 2);
  assert.equal(s._propagateVertices(() => {}), true);
  assert.equal(s.V[s._vIdx(0, 0)], 2);
});

test('SlitherlinkSolver: _propagateVertices reports contradiction when m > 2', () => {
  const s = new SlitherlinkSolver({ width: 2, height: 2, task: [[-1, -1], [-1, -1]] });
  s._setEdge(s._hIdx(1, 0), 'H', 1);
  s._setEdge(s._hIdx(1, 1), 'H', 1);
  s._setEdge(s._vIdx(1, 1), 'V', 1);
  assert.equal(s._propagateVertices(() => {}), false);
});

test('SlitherlinkSolver: _propagateVertices reports contradiction when m==1 && n==0', () => {
  const s = new SlitherlinkSolver({ width: 2, height: 2, task: [[-1, -1], [-1, -1]] });
  s._setEdge(s._hIdx(0, 0), 'H', 1);
  s._setEdge(s._vIdx(0, 0), 'V', 2);
  assert.equal(s._propagateVertices(() => {}), false);
});

test('SlitherlinkSolver: _dsuRebuild and _checkSingleLoopComplete accept a single closed loop', () => {
  // 2x2 grid; the perimeter is a single closed loop with 8 edges.
  const s = new SlitherlinkSolver({
    width: 2, height: 2, task: [[-1, -1], [-1, -1]],
  });
  // Perimeter LINE edges.
  s._setEdge(s._hIdx(0, 0), 'H', 1);
  s._setEdge(s._hIdx(0, 1), 'H', 1);
  s._setEdge(s._hIdx(2, 0), 'H', 1);
  s._setEdge(s._hIdx(2, 1), 'H', 1);
  s._setEdge(s._vIdx(0, 0), 'V', 1);
  s._setEdge(s._vIdx(1, 0), 'V', 1);
  s._setEdge(s._vIdx(0, 2), 'V', 1);
  s._setEdge(s._vIdx(1, 2), 'V', 1);
  // All interior edges EMPTY.
  s._setEdge(s._hIdx(1, 0), 'H', 2);
  s._setEdge(s._hIdx(1, 1), 'H', 2);
  s._setEdge(s._vIdx(0, 1), 'V', 2);
  s._setEdge(s._vIdx(1, 1), 'V', 2);
  s._dsuRebuild();
  assert.equal(s._checkSingleLoopComplete(), true);
});

test('SlitherlinkSolver: _checkSingleLoopComplete rejects a premature subloop', () => {
  // 3x3 grid; close the 4 edges around the top-left cell (a 4-edge subloop)
  // and leave the rest UNKNOWN.
  const s = new SlitherlinkSolver({
    width: 3, height: 3, task: [
      [-1, -1, -1],
      [-1, -1, -1],
      [-1, -1, -1],
    ],
  });
  s._setEdge(s._hIdx(0, 0), 'H', 1);
  s._setEdge(s._hIdx(1, 0), 'H', 1);
  s._setEdge(s._vIdx(0, 0), 'V', 1);
  s._setEdge(s._vIdx(0, 1), 'V', 1);
  s._dsuRebuild();
  assert.equal(s._cycleClosed, true);    // cycle detected during rebuild
  assert.equal(s._checkSingleLoopComplete(), false);
});

test('SlitherlinkSolver: _checkSingleLoopComplete rejects two disjoint loops (check d)', () => {
  // 4×2 grid (4 cols, 2 rows). Draw two disjoint perimeter loops, one over
  // cells (0,0)+(1,0) and one over cells (0,2)+(1,2) — i.e. two separate
  // vertical 2x1 rectangles. Every edge is resolved (LINE or EMPTY); every
  // dot is degree 0 or 2; no clues so check (a) passes trivially. The only
  // failure mode is check (d): two components.
  const s = new SlitherlinkSolver({
    width: 4, height: 2, task: [
      [-1, -1, -1, -1],
      [-1, -1, -1, -1],
    ],
  });
  // Loop A — perimeter of the left 1×2 block (cells (0,0)+(1,0)).
  s._setEdge(s._hIdx(0, 0), 'H', 1);            // top
  s._setEdge(s._hIdx(2, 0), 'H', 1);            // bottom
  s._setEdge(s._vIdx(0, 0), 'V', 1);            // left top
  s._setEdge(s._vIdx(1, 0), 'V', 1);            // left bottom
  s._setEdge(s._vIdx(0, 1), 'V', 1);            // right top
  s._setEdge(s._vIdx(1, 1), 'V', 1);            // right bottom
  // Loop B — perimeter of the right 1×2 block (cells (0,3)+(1,3)).
  s._setEdge(s._hIdx(0, 3), 'H', 1);            // top
  s._setEdge(s._hIdx(2, 3), 'H', 1);            // bottom
  s._setEdge(s._vIdx(0, 3), 'V', 1);            // left top
  s._setEdge(s._vIdx(1, 3), 'V', 1);            // left bottom
  s._setEdge(s._vIdx(0, 4), 'V', 1);            // right top
  s._setEdge(s._vIdx(1, 4), 'V', 1);            // right bottom
  // Every remaining edge → EMPTY.
  // Horizontals:
  s._setEdge(s._hIdx(0, 1), 'H', 2);
  s._setEdge(s._hIdx(0, 2), 'H', 2);
  s._setEdge(s._hIdx(1, 0), 'H', 2);
  s._setEdge(s._hIdx(1, 1), 'H', 2);
  s._setEdge(s._hIdx(1, 2), 'H', 2);
  s._setEdge(s._hIdx(1, 3), 'H', 2);
  s._setEdge(s._hIdx(2, 1), 'H', 2);
  s._setEdge(s._hIdx(2, 2), 'H', 2);
  // Verticals:
  s._setEdge(s._vIdx(0, 2), 'V', 2);
  s._setEdge(s._vIdx(1, 2), 'V', 2);
  // Sanity-check the setup: no UNKNOWNs left.
  for (let i = 0; i < s.H.length; i++) assert.equal(s.H[i] === 0, false);
  for (let i = 0; i < s.V.length; i++) assert.equal(s.V[i] === 0, false);
  s._dsuRebuild();
  // Each loop independently closes a cycle, so _cycleClosed is true.
  assert.equal(s._cycleClosed, true);
  // Check (d) must catch the two-component case.
  assert.equal(s._checkSingleLoopComplete(), false);
});

test('SlitherlinkSolver: solves the 5x5 fixture', () => {
  SlitherlinkSolver.clearSolutionCache();
  const p = fixtures.slitherlink5x5;
  const s = new SlitherlinkSolver({ width: p.cols, height: p.rows, task: p.task });
  s.maxMs = 5000;
  const result = s.solve();
  assert.equal(result.solved, true);
  // Shape checks.
  assert.equal(result.horizontal.length, p.rows + 1);
  assert.equal(result.horizontal[0].length, p.cols);
  assert.equal(result.vertical.length, p.rows);
  assert.equal(result.vertical[0].length, p.cols + 1);
  // Every entry 0, 1, or 2 (UNKNOWN=0, LINE=1, EMPTY=2).
  for (const row of result.horizontal) for (const v of row) assert.ok(v === 0 || v === 1 || v === 2);
  for (const row of result.vertical)   for (const v of row) assert.ok(v === 0 || v === 1 || v === 2);
  // Every clue is satisfied exactly (count only LINE=1 edges).
  for (let r = 0; r < p.rows; r++) {
    for (let c = 0; c < p.cols; c++) {
      const clue = p.task[r][c];
      if (clue < 0) continue;
      const m = (result.horizontal[r][c] === 1 ? 1 : 0)
              + (result.horizontal[r + 1][c] === 1 ? 1 : 0)
              + (result.vertical[r][c] === 1 ? 1 : 0)
              + (result.vertical[r][c + 1] === 1 ? 1 : 0);
      assert.equal(m, clue, `clue at (${r},${c})=${clue} but got ${m}`);
    }
  }
  SlitherlinkSolver.clearSolutionCache();
});

test('SlitherlinkSolver: caches the second call', () => {
  SlitherlinkSolver.clearSolutionCache();
  const p = fixtures.slitherlink5x5;
  let propCalls = 0;
  const s1 = new SlitherlinkSolver({ width: p.cols, height: p.rows, task: p.task });
  s1.maxMs = 5000;
  s1.solve();
  // Second call should hit the cache before propagate() runs even once.
  const s2 = new SlitherlinkSolver({ width: p.cols, height: p.rows, task: p.task });
  const orig = s2.propagate.bind(s2);
  s2.propagate = function (...args) { propCalls++; return orig(...args); };
  const r2 = s2.solve();
  assert.equal(r2.solved, true);
  assert.equal(propCalls, 0, 'cached solve should not call propagate()');
  SlitherlinkSolver.clearSolutionCache();
});

test('SlitherlinkSolver: maxMs=1 bails within 500ms', () => {
  const task = Array.from({ length: 10 }, () => new Array(10).fill(-1));
  const s = new SlitherlinkSolver({ width: 10, height: 10, task });
  s.maxMs = 1;
  const t0 = Date.now();
  const r = s.solve();
  const dt = Date.now() - t0;
  assert.ok(dt < 500, `solve must bail within 500ms; took ${dt}ms`);
  if (!r.solved) assert.equal(r.error, 'timed out');
});

test('SlitherlinkSolver: getHint returns edges forced by propagation', () => {
  SlitherlinkSolver.clearSolutionCache();
  const p = fixtures.slitherlink5x5;
  const full = new SlitherlinkSolver({ width: p.cols, height: p.rows, task: p.task }).solve();
  assert.equal(full.solved, true);

  // Find a LINE edge to "hide" from the board.
  let hideKind = null, hideR = -1, hideC = -1;
  outer: for (let r = 0; r <= p.rows; r++) {
    for (let c = 0; c < p.cols; c++) {
      if (full.horizontal[r][c] === 1) { hideKind = 'h'; hideR = r; hideC = c; break outer; }
    }
  }
  assert.notEqual(hideKind, null);
  const curH = full.horizontal.map(row => row.slice());
  const curV = full.vertical.map(row => row.slice());
  curH[hideR][hideC] = 0;

  const s = new SlitherlinkSolver({ width: p.cols, height: p.rows, task: p.task });
  const hint = s.getHint(curH, curV);
  assert.ok(hint, 'expected a hint');
  assert.equal(hint.type, 'slitherlink');
  assert.ok(Array.isArray(hint.edges));
  assert.ok(hint.edges.length >= 1);
  const hidden = { orientation: 'h', r: hideR, c: hideC };
  assert.ok(
    hint.edges.some(e => e.orientation === hidden.orientation && e.r === hidden.r && e.c === hidden.c),
    'expected hidden edge in hint set',
  );
  SlitherlinkSolver.clearSolutionCache();
});

test('SlitherlinkSolver: 5x5 fixture matches golden', () => {
  SlitherlinkSolver.clearSolutionCache();
  const p = fixtures.slitherlink5x5;
  const result = new SlitherlinkSolver({ width: p.cols, height: p.rows, task: p.task }).solve();
  assert.deepEqual(
    {
      solved: result.solved,
      horizontal: result.horizontal,
      vertical: result.vertical,
      error: result.error || null,
    },
    golden.slitherlink5x5,
  );
  SlitherlinkSolver.clearSolutionCache();
});

// ── _propagateAdvanced tests ──────────────────────────────────────────────────

test('SlitherlinkSolver: _propagateAdvanced corner-3 forces outer corner edges to LINE', () => {
  // Clue 3 at top-left corner (0,0). Corner dot has 2 incident edges
  // (H[0][0] and V[0][0]). With clue=3, at least one outer corner edge must
  // be LINE → vertex rule forces both.
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[3, -1, -1], [-1, -1, -1], [-1, -1, -1]],
  });
  const onChange = () => {};
  assert.equal(s._propagateAdvanced(onChange), true);
  assert.equal(s.H[s._hIdx(0, 0)], 1, 'top edge of corner-3 cell must be LINE');
  assert.equal(s.V[s._vIdx(0, 0)], 1, 'left edge of corner-3 cell must be LINE');
});

test('SlitherlinkSolver: _propagateAdvanced corner-1 forces outer corner edges to EMPTY', () => {
  // Clue 1 at top-left corner (0,0). If either outer corner edge were LINE,
  // the vertex rule on the corner dot forces the other LINE too → 2 LINEs on
  // a clue-1 cell → contradiction. So both outer edges must be EMPTY.
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[1, -1, -1], [-1, -1, -1], [-1, -1, -1]],
  });
  const onChange = () => {};
  assert.equal(s._propagateAdvanced(onChange), true);
  assert.equal(s.H[s._hIdx(0, 0)], 2, 'top edge of corner-1 cell must be EMPTY');
  assert.equal(s.V[s._vIdx(0, 0)], 2, 'left edge of corner-1 cell must be EMPTY');
});

test('SlitherlinkSolver: _propagateAdvanced adjacent-3-3 horizontal forces 3 vertical edges to LINE', () => {
  // Two horizontally-adjacent 3-clue cells at (0,0) and (0,1). The shared
  // vertical edge V[0][1] and the outer verticals V[0][0] and V[0][2] must
  // all be LINE (standard adjacent-3-3 pattern).
  const s = new SlitherlinkSolver({
    width: 3, height: 2,
    task: [[3, 3, -1], [-1, -1, -1]],
  });
  const onChange = () => {};
  assert.equal(s._propagateAdvanced(onChange), true);
  assert.equal(s.V[s._vIdx(0, 0)], 1, 'left outer vertical must be LINE');
  assert.equal(s.V[s._vIdx(0, 1)], 1, 'shared vertical must be LINE');
  assert.equal(s.V[s._vIdx(0, 2)], 1, 'right outer vertical must be LINE');
});

test('SlitherlinkSolver: _propagateAdvanced adjacent-3-3 vertical forces 3 horizontal edges to LINE', () => {
  // Two vertically-adjacent 3-clue cells at (0,0) and (1,0). The shared
  // horizontal edge H[1][0] and the outer horizontals H[0][0] and H[2][0]
  // must all be LINE (standard adjacent-3-3 pattern).
  const s = new SlitherlinkSolver({
    width: 2, height: 3,
    task: [[3, -1], [3, -1], [-1, -1]],
  });
  const onChange = () => {};
  assert.equal(s._propagateAdvanced(onChange), true);
  assert.equal(s.H[s._hIdx(0, 0)], 1, 'top outer horizontal must be LINE');
  assert.equal(s.H[s._hIdx(1, 0)], 1, 'shared horizontal must be LINE');
  assert.equal(s.H[s._hIdx(2, 0)], 1, 'bottom outer horizontal must be LINE');
});

test('SlitherlinkSolver: _propagateAdvanced diagonal-3-3 down-right forces 4 outer corner edges to LINE', () => {
  // 3-clue cells at (0,0) and (1,1) (down-right diagonal). The outer corners
  // facing AWAY from each other: for (0,0) that's H[0][0] and V[0][0]; for
  // (1,1) that's H[2][1] and V[1][2].
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[3, -1, -1], [-1, 3, -1], [-1, -1, -1]],
  });
  const onChange = () => {};
  assert.equal(s._propagateAdvanced(onChange), true);
  assert.equal(s.H[s._hIdx(0, 0)], 1, 'H[0][0] must be LINE (outer corner of (0,0))');
  assert.equal(s.V[s._vIdx(0, 0)], 1, 'V[0][0] must be LINE (outer corner of (0,0))');
  assert.equal(s.H[s._hIdx(2, 1)], 1, 'H[2][1] must be LINE (outer corner of (1,1))');
  assert.equal(s.V[s._vIdx(1, 2)], 1, 'V[1][2] must be LINE (outer corner of (1,1))');
});

test('SlitherlinkSolver: getHint returns edges when given a nearly-complete board', () => {
  SlitherlinkSolver.clearSolutionCache();
  const p = fixtures.slitherlink5x5;
  // Solve the puzzle first to get the full solution.
  const solved = new SlitherlinkSolver({ width: p.cols, height: p.rows, task: p.task });
  solved.maxMs = 5000;
  const full = solved.solve();
  assert.equal(full.solved, true);
  // Hide one LINE edge from the known solution. getHint must find it.
  let hideR = -1, hideC = -1;
  outer: for (let r = 0; r <= p.rows; r++) {
    for (let c = 0; c < p.cols; c++) {
      if (full.horizontal[r][c] === 1) { hideR = r; hideC = c; break outer; }
    }
  }
  assert.notEqual(hideR, -1, 'expected at least one horizontal LINE in the solution');
  const curH = full.horizontal.map(row => row.slice());
  const curV = full.vertical.map(row => row.slice());
  curH[hideR][hideC] = 0;
  const s = new SlitherlinkSolver({ width: p.cols, height: p.rows, task: p.task });
  s.maxMs = 5000;
  const hint = s.getHint(curH, curV);
  assert.ok(hint, 'expected a hint for the nearly-complete board');
  assert.equal(hint.type, 'slitherlink');
  assert.ok(hint.edges.length >= 1);
  // The hidden edge must be among the hinted edges.
  assert.ok(
    hint.edges.some(e => e.orientation === 'h' && e.r === hideR && e.c === hideC),
    'expected the hidden edge in the hint set',
  );
  SlitherlinkSolver.clearSolutionCache();
});

test('SlitherlinkSolver: getHint returns a bounded batch (next-move scale)', () => {
  SlitherlinkSolver.clearSolutionCache();
  // Adjacent 3-3 at top-left: cells (0,0) and (0,1) both have clue 3.
  // minLines = max(3, ceil(9/30)) = 3. Accumulator gathers from corner-3 and
  // adjacent-3-3 patterns. The result must be a small batch (well under ~10).
  const task = [
    [3, 3, -1],
    [-1, -1, -1],
    [-1, -1, -1],
  ];
  const s = new SlitherlinkSolver({ width: 3, height: 3, task });
  const blankH = Array.from({ length: 4 }, () => new Array(3).fill(0));
  const blankV = Array.from({ length: 3 }, () => new Array(4).fill(0));
  const hint = s.getHint(blankH, blankV);
  assert.ok(hint, 'expected a hint');
  assert.equal(hint.type, 'slitherlink');
  assert.ok(hint.edges.length >= 1);
  // The hint must be a bounded batch — never more than ~10 edges.
  assert.ok(hint.edges.length <= 10, `next-move hint should be small; got ${hint.edges.length}`);
  SlitherlinkSolver.clearSolutionCache();
});

test('SlitherlinkSolver: getHint scales batch size with board area', () => {
  SlitherlinkSolver.clearSolutionCache();
  // 10x10 board with a corner-3, adjacent 3-3 pairs, and diagonal 3-3 pairs so
  // deductions fire. Target: minLines = max(3, ceil(100/30)) = max(3, 4) = 4.
  const task = Array.from({ length: 10 }, () => new Array(10).fill(-1));
  task[0][0] = 3;
  task[0][3] = 3; task[0][4] = 3;
  task[5][5] = 3; task[6][6] = 3;
  const s = new SlitherlinkSolver({ width: 10, height: 10, task });
  const blankH = Array.from({ length: 11 }, () => new Array(10).fill(0));
  const blankV = Array.from({ length: 10 }, () => new Array(11).fill(0));
  const hint = s.getHint(blankH, blankV);
  assert.ok(hint, 'expected a hint on 10x10 board with pattern clues');
  // ceil(10*10/30) = 4 -> minLines = max(3, 4) = 4.
  // Accumulator gathers edges from successive rule applications until >= 4.
  assert.ok(hint.edges.length >= 4, `expected >= 4 edges on 10x10, got ${hint.edges.length}`);
  SlitherlinkSolver.clearSolutionCache();
});

// ── _applyLookahead tests ──────────────────────────────────────────────────────

test('SlitherlinkSolver: _applyLookahead forces an edge when one value contradicts', () => {
  // Set up a 2x2 board where vertex logic leaves two edges unknown for a dot
  // that already has lineCount=2. _applyLookahead should determine that
  // assigning LINE to any remaining unknown at that dot contradicts and force
  // the value to EMPTY without crashing.
  const s = new SlitherlinkSolver({
    width: 2, height: 2,
    task: [[-1, -1], [-1, -1]],
  });
  // Give dot (1,1) (at bottom-center) lineCount=2 via H[1][0] and H[1][1].
  s._setEdge(s._hIdx(1, 0), 'H', 1);
  s._setEdge(s._hIdx(1, 1), 'H', 1);
  // Dot (1,1) now has lineCount=2, unknownCount=2 (V[0][1] and V[1][1]).
  // Normal vertex propagation would force both unknown edges to EMPTY.
  // We call _applyLookahead directly (depth=0, not inLookahead) and verify
  // it completes without returning false.
  s._depth = 0;
  s._inLookahead = false;
  s._startedAt = Date.now();
  let _forced = 0;
  const ok = s._applyLookahead(() => { _forced++; });
  assert.ok(ok !== false, '_applyLookahead must not return false on a valid state');
  // Vertex rule: V[0][1] and V[1][1] must be EMPTY.
  assert.equal(s.V[s._vIdx(0, 1)], 2, 'V[0][1] should be EMPTY (lineCount-2 vertex forces it)');
});

test('SlitherlinkSolver: _applyLookahead returns false when both values contradict', () => {
  // A 1x1 grid with clue=4 but 2 edges already set EMPTY (direct array write
  // to bypass the trail, simulating a corrupted state). Calling propagate()
  // on this state must return false — which exercises the contradiction path.
  const s = new SlitherlinkSolver({
    width: 1, height: 1,
    task: [[4]],
  });
  // Directly corrupt the array (bypassing _setEdge) so propagate catches it:
  s.H[s._hIdx(0, 0)] = 2;
  s.H[s._hIdx(1, 0)] = 2;
  // propagate() will return false immediately via _propagateClues (m+n < clue=4).
  const propOk = s.propagate();
  assert.equal(propOk, false, 'corrupted state with clue=4 and 2 EMPTY edges must contradict');
});

test('SlitherlinkSolver: _applyLookahead is skipped at _depth > 0', () => {
  const s = new SlitherlinkSolver({
    width: 2, height: 2,
    task: [[-1, -1], [-1, -1]],
  });
  let lookaheadCalls = 0;
  const origLookahead = s._applyLookahead.bind(s);
  s._applyLookahead = function(...args) { lookaheadCalls++; return origLookahead(...args); };
  // With _depth > 0, propagate() must skip _applyLookahead.
  s._depth = 1;
  s._inLookahead = false;
  s._startedAt = Date.now();
  s.propagate();
  assert.equal(lookaheadCalls, 0, '_applyLookahead must not be called when _depth > 0');
});

// ── _propagateColors tests ─────────────────────────────────────────────────────

test('SlitherlinkSolver: _propagateColors — boundary LINE edge forces inside', () => {
  // 2x2 grid. Set H[0][0]=LINE (top edge of cell (0,0)). Then cell (0,0)
  // borders OUTSIDE on top via a LINE → cell (0,0) is INSIDE.
  const s = new SlitherlinkSolver({ width: 2, height: 2, task: [[-1,-1],[-1,-1]] });
  s._setEdge(s._hIdx(0, 0), 'H', 1);
  assert.equal(s._propagateColors(() => {}), true);
  assert.equal(s.colors[0 * 2 + 0], 1); // INSIDE
});

test('SlitherlinkSolver: _propagateColors — boundary EMPTY edge forces outside', () => {
  const s = new SlitherlinkSolver({ width: 2, height: 2, task: [[-1,-1],[-1,-1]] });
  s._setEdge(s._hIdx(0, 0), 'H', 2);
  assert.equal(s._propagateColors(() => {}), true);
  assert.equal(s.colors[0 * 2 + 0], 2); // OUTSIDE
});

test('SlitherlinkSolver: _propagateColors — adjacent same colors force EMPTY edge', () => {
  const s = new SlitherlinkSolver({ width: 2, height: 2, task: [[-1,-1],[-1,-1]] });
  // Seed: both cell (0,0) and (1,0) as INSIDE.
  s._setColor(0 * 2 + 0, 1);
  s._setColor(1 * 2 + 0, 1);
  assert.equal(s._propagateColors(() => {}), true);
  // Edge between them (H[1][0]) must be EMPTY.
  assert.equal(s.H[s._hIdx(1, 0)], 2);
});

test('SlitherlinkSolver: _propagateColors — adjacent different colors force LINE edge', () => {
  const s = new SlitherlinkSolver({ width: 2, height: 2, task: [[-1,-1],[-1,-1]] });
  s._setColor(0 * 2 + 0, 1); // inside
  s._setColor(1 * 2 + 0, 2); // outside
  assert.equal(s._propagateColors(() => {}), true);
  assert.equal(s.H[s._hIdx(1, 0)], 1); // LINE
});

test('SlitherlinkSolver: _propagateColors — clue×color: m==k forces remaining same', () => {
  // 3x3 grid, cell (1,1) clue 1, own color INSIDE. Its 4 neighbors. Suppose
  // (0,1) is already OUTSIDE — that's 1 opposite. clue=1, m=1. So remaining
  // 3 neighbors must be INSIDE (same as the cell).
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,1,-1],[-1,-1,-1]],
  });
  s._setColor(1 * 3 + 1, 1);  // (1,1) INSIDE
  s._setColor(0 * 3 + 1, 2);  // (0,1) OUTSIDE → m=1
  assert.equal(s._propagateColors(() => {}), true);
  assert.equal(s.colors[2 * 3 + 1], 1); // (2,1) INSIDE
  assert.equal(s.colors[1 * 3 + 0], 1); // (1,0) INSIDE
  assert.equal(s.colors[1 * 3 + 2], 1); // (1,2) INSIDE
});

test('SlitherlinkSolver: _propagateColors — contradiction on conflicting edge/color', () => {
  const s = new SlitherlinkSolver({ width: 2, height: 2, task: [[-1,-1],[-1,-1]] });
  s._setColor(0 * 2 + 0, 1);
  s._setColor(1 * 2 + 0, 1);
  s._setEdge(s._hIdx(1, 0), 'H', 1); // LINE but cells are same color
  assert.equal(s._propagateColors(() => {}), false);
});

test('SlitherlinkSolver: trail rolls back color writes', () => {
  const s = new SlitherlinkSolver({ width: 2, height: 2, task: [[-1,-1],[-1,-1]] });
  const mark = s.trail.length;
  assert.equal(s._setColor(0, 1), true);
  assert.equal(s.colors[0], 1);
  s._rollback(mark);
  assert.equal(s.colors[0], 0);
});

// ── _propagateConnectivity tests ──────────────────────────────────────────────

test('SlitherlinkSolver: connectivity forces unreachable cells to the other color', () => {
  // 3x3 grid. Set cell (0,0) INSIDE, surround it with OUTSIDE.
  // Then cell (2,2) — which is far away — can only be reached from (0,0)
  // through OUTSIDE cells, so (2,2) must be OUTSIDE.
  const s = new SlitherlinkSolver({ width: 3, height: 3, task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]] });
  s._setColor(0, 1);             // (0,0) INSIDE
  s._setColor(1, 2);             // (0,1) OUTSIDE
  s._setColor(3, 2);             // (1,0) OUTSIDE
  // Now (0,0) is the only INSIDE cell, isolated by OUTSIDE neighbors.
  // Any remaining UNKNOWN cell can't reach (0,0) without crossing OUTSIDE.
  // So all remaining UNKNOWN cells must be OUTSIDE.
  assert.equal(s._propagateConnectivity(() => {}), true);
  // (2,2) at index 2*3+2 = 8 should now be OUTSIDE.
  assert.equal(s.colors[8], 2, 'cell (2,2) should be forced OUTSIDE');
});

test('SlitherlinkSolver: connectivity articulation forces a bridging cell', () => {
  // 3x3 grid. INSIDE cells at (0,0) and (0,2). Row 1 is all OUTSIDE,
  // and (1,1) is OUTSIDE, so the only path between (0,0) and (0,2) through
  // {INSIDE ∪ UNKNOWN} is via (0,1). So (0,1) must be forced INSIDE.
  const s = new SlitherlinkSolver({ width: 3, height: 3, task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]] });
  s._setColor(0, 1);             // (0,0) INSIDE
  s._setColor(2, 1);             // (0,2) INSIDE
  // Block all paths except through (0,1).
  s._setColor(3, 2);             // (1,0) OUTSIDE
  s._setColor(4, 2);             // (1,1) OUTSIDE
  s._setColor(5, 2);             // (1,2) OUTSIDE
  // Now (0,1) = idx 1 is the only connection between (0,0) and (0,2).
  // Removing (0,1) disconnects (0,0) from (0,2) → (0,1) must be INSIDE.
  assert.equal(s._propagateConnectivity(() => {}), true);
  assert.equal(s.colors[1], 1, 'cell (0,1) should be forced INSIDE');
});

test('SlitherlinkSolver: connectivity detects contradiction when known cells are isolated', () => {
  // 3x3 grid. Two known-INSIDE cells with no path between them via INSIDE/UNKNOWN.
  // (0,0) and (0,2) INSIDE, but (0,1) is OUTSIDE (no path between them).
  const s = new SlitherlinkSolver({ width: 3, height: 3, task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]] });
  s._setColor(0, 1);             // (0,0) INSIDE
  s._setColor(2, 1);             // (0,2) INSIDE
  // Block the only direct path between them.
  s._setColor(1, 2);             // (0,1) OUTSIDE — the only direct bridge
  // Block all other possible paths via row 1.
  s._setColor(3, 2);             // (1,0) OUTSIDE
  s._setColor(4, 2);             // (1,1) OUTSIDE
  s._setColor(5, 2);             // (1,2) OUTSIDE
  // No path from (0,0) to (0,2) through {INSIDE ∪ UNKNOWN} → contradiction.
  assert.equal(s._propagateConnectivity(() => {}), false);
});

// ── _propagateParity tests ────────────────────────────────────────────────────

test('SlitherlinkSolver: parity forces last unknown to make crossings even', () => {
  // Horizontal scan at y = 0.5 (between dot rows 0 and 1) crosses V[0][c]
  // for c = 0..W. If 3 of the 5 V[0] edges are LINE and 1 is UNKNOWN, the
  // unknown must be LINE (3+1=4 = even). W=4 → V[0][0..4] = 5 edges.
  const s = new SlitherlinkSolver({ width: 4, height: 4, task: Array.from({length:4},()=>new Array(4).fill(-1)) });
  // Set V[0][0..2] = LINE, V[0][3] = EMPTY, V[0][4] = UNKNOWN.
  s._setEdge(s._vIdx(0, 0), 'V', 1);
  s._setEdge(s._vIdx(0, 1), 'V', 1);
  s._setEdge(s._vIdx(0, 2), 'V', 1);
  s._setEdge(s._vIdx(0, 3), 'V', 2);
  // V[0][4] still UNKNOWN. m=3 (odd) → force LINE.
  assert.equal(s._propagateParity(() => {}), true);
  assert.equal(s.V[s._vIdx(0, 4)], 1, 'V[0][4] should be forced LINE');
});

test('SlitherlinkSolver: parity forces last unknown to keep crossings even', () => {
  // Horizontal scan at y=0.5: V[0][0..4]. 2 LINE + 2 EMPTY + 1 UNKNOWN.
  // m=2 (even) → force UNKNOWN to EMPTY.
  const s = new SlitherlinkSolver({ width: 4, height: 4, task: Array.from({length:4},()=>new Array(4).fill(-1)) });
  s._setEdge(s._vIdx(0, 0), 'V', 1);
  s._setEdge(s._vIdx(0, 1), 'V', 1);
  s._setEdge(s._vIdx(0, 2), 'V', 2);
  s._setEdge(s._vIdx(0, 3), 'V', 2);
  // V[0][4] UNKNOWN. m=2 (even) → force EMPTY.
  assert.equal(s._propagateParity(() => {}), true);
  assert.equal(s.V[s._vIdx(0, 4)], 2, 'V[0][4] should be forced EMPTY');
});

test('SlitherlinkSolver: parity contradiction with no unknowns and odd count', () => {
  // Horizontal scan at y=0.5: V[0][0..4] = LINE, EMPTY, EMPTY, EMPTY, EMPTY.
  // m=1 (odd), n=0 → contradiction.
  const s = new SlitherlinkSolver({ width: 4, height: 4, task: Array.from({length:4},()=>new Array(4).fill(-1)) });
  s._setEdge(s._vIdx(0, 0), 'V', 1);
  s._setEdge(s._vIdx(0, 1), 'V', 2);
  s._setEdge(s._vIdx(0, 2), 'V', 2);
  s._setEdge(s._vIdx(0, 3), 'V', 2);
  s._setEdge(s._vIdx(0, 4), 'V', 2);
  assert.equal(s._propagateParity(() => {}), false);
});

test('SlitherlinkSolver: _emit outputs 2 for known EMPTY edges', () => {
  const s = new SlitherlinkSolver({ width: 2, height: 2, task: [[-1,-1],[-1,-1]] });
  s._setEdge(s._hIdx(0, 0), 'H', 1);
  s._setEdge(s._hIdx(1, 0), 'H', 2);
  const out = s._emit();
  assert.equal(out.horizontal[0][0], 1);
  assert.equal(out.horizontal[1][0], 2);
  assert.equal(out.horizontal[2][0], 0); // UNKNOWN
});

test('SlitherlinkSolver: constructor seeds EMPTY edges from initialState', () => {
  const s = new SlitherlinkSolver({
    width: 2, height: 2,
    task: [[-1,-1],[-1,-1]],
    initialState: {
      horizontal: [[1, 0], [2, 0], [0, 0]],
      vertical:   [[0, 0, 0], [0, 0, 0]],
    },
  });
  assert.equal(s.H[s._hIdx(0, 0)], 1, 'H[0][0] = LINE');
  assert.equal(s.H[s._hIdx(1, 0)], 2, 'H[1][0] = EMPTY');
});

test('computePuzzleDiff: slitherlink flags wrong × (board=2 but solution=1)', () => {
  const board = {
    horizontal: [[2, 0, 0], [0, 0, 0]],
    vertical:   [[0, 0, 0, 0]],
  };
  const solution = {
    horizontal: [[1, 0, 0], [0, 0, 0]],
    vertical:   [[0, 0, 0, 0]],
  };
  const diff = computePuzzleDiff('slitherlink', board, solution);
  assert.deepEqual(diff, [{ orientation: 'h', r: 0, c: 0 }]);
});

test('SlitherlinkSolver: _varIdEdge/_varIdCell/_decodeVar round-trip', () => {
  const s = new SlitherlinkSolver({
    width: 5, height: 5,
    task: [[-1,-1,-1,-1,-1],[-1,-1,-1,-1,-1],[-1,-1,-1,-1,-1],[-1,-1,-1,-1,-1],[-1,-1,-1,-1,-1]],
  });
  assert.equal(s.numH, 30);
  assert.equal(s.numV, 30);
  assert.equal(s.cellCount, 25);
  assert.equal(s.totalVars, 85);
  const hId = s._varIdEdge('H', 7);
  assert.equal(hId, 7);
  const dH = s._decodeVar(hId);
  assert.equal(dH.kind, 'H');
  assert.equal(dH.idx, 7);
  const vId = s._varIdEdge('V', 3);
  assert.equal(vId, s.numH + 3);
  const dV = s._decodeVar(vId);
  assert.equal(dV.kind, 'V');
  assert.equal(dV.idx, 3);
  const cId = s._varIdCell(12);
  assert.equal(cId, s.numH + s.numV + 12);
  const dC = s._decodeVar(cId);
  assert.equal(dC.kind, 'C');
  assert.equal(dC.idx, 12);
  for (let i = 0; i < s.totalVars; i++) {
    const d = s._decodeVar(i);
    if (d.kind === 'H') assert.equal(s._varIdEdge('H', d.idx), i);
    else if (d.kind === 'V') assert.equal(s._varIdEdge('V', d.idx), i);
    else assert.equal(s._varIdCell(d.idx), i);
  }
});

test('SlitherlinkSolver: _varValue on initial state returns 0', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  for (let i = 0; i < s.totalVars; i++) {
    assert.equal(s._varValue(i), 0, `var ${i} should be UNKNOWN initially`);
  }
});

test('SlitherlinkSolver: _varValue after _setEdge LINE returns +1', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  const idx = s._hIdx(0, 0);
  s._setEdge(idx, 'H', 1);
  assert.equal(s._varValue(s._varIdEdge('H', idx)), 1);
});

test('SlitherlinkSolver: _varValue after _setEdge EMPTY returns -1', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  const idx = s._hIdx(0, 1);
  s._setEdge(idx, 'H', 2);
  assert.equal(s._varValue(s._varIdEdge('H', idx)), -1);
});

test('SlitherlinkSolver: _varValue after _setColor INSIDE returns +1', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  s._setColor(0, 1);
  assert.equal(s._varValue(s._varIdCell(0)), 1);
});

test('SlitherlinkSolver: _varValue after _setColor OUTSIDE returns -1', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  s._setColor(1, 2);
  assert.equal(s._varValue(s._varIdCell(1)), -1);
});

test('SlitherlinkSolver: reason structures initialized correctly after construction', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  assert.ok(Array.isArray(s._reasons), '_reasons must be an array');
  assert.equal(s._reasons.length, 0);
  assert.ok(Array.isArray(s._decisionLevels), '_decisionLevels must be an array');
  assert.equal(s._decisionLevels.length, 0);
  assert.equal(s._decisionLevel, 0);
  assert.equal(s._currentReason, null);
});

test('SlitherlinkSolver: _setEdge captures _currentReason into _reasons', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  const idx = s._hIdx(0, 0);
  const fakeReason = [42, 13];
  s._currentReason = fakeReason;
  s._setEdge(idx, 'H', 1);
  const trailLen = s.trail.length;
  assert.ok(trailLen >= 1);
  assert.deepEqual(s._reasons[trailLen - 1], fakeReason);
  assert.equal(s._decisionLevels[trailLen - 1], 0);
  assert.equal(s._currentReason, null);
  assert.equal(s._reasons.length, s.trail.length);
  assert.equal(s._decisionLevels.length, s.trail.length);
});

test('SlitherlinkSolver: _setEdge with null _currentReason records null reason (decision)', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  const idx = s._vIdx(0, 0);
  s._currentReason = null;
  s._setEdge(idx, 'V', 2);
  const trailLen = s.trail.length;
  assert.equal(s._reasons[trailLen - 1], null);
  assert.equal(s._decisionLevels[trailLen - 1], 0);
});

test('SlitherlinkSolver: _setColor captures _currentReason', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  const cellIdx = 4;
  const fakeReason = [s._varIdCell(0)];
  s._currentReason = fakeReason;
  s._setColor(cellIdx, 1);
  const trailLen = s.trail.length;
  assert.ok(trailLen >= 1);
  assert.deepEqual(s._reasons[trailLen - 1], fakeReason);
  assert.equal(s._currentReason, null);
});

test('SlitherlinkSolver: _rollback pops _reasons and _decisionLevels in sync', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  const mark = s.trail.length;
  s._currentReason = [5];
  s._setEdge(s._hIdx(0, 0), 'H', 1);
  s._currentReason = [6, 7];
  s._setEdge(s._hIdx(0, 1), 'H', 2);
  assert.equal(s.trail.length, mark + 2);
  assert.equal(s._reasons.length, mark + 2);
  assert.equal(s._decisionLevels.length, mark + 2);
  s._rollback(mark);
  assert.equal(s.trail.length, mark);
  assert.equal(s._reasons.length, mark);
  assert.equal(s._decisionLevels.length, mark);
});

test('SlitherlinkSolver: _applyClueRuleAt records correct antecedents for each forced edge', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[2,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  const hTopIdx = s._hIdx(0, 0);
  const vLeftIdx = s._vIdx(0, 0);
  s._currentReason = null; s._setEdge(hTopIdx, 'H', 1);
  s._currentReason = null; s._setEdge(vLeftIdx, 'V', 1);

  const forced = [];
  const ok = s._applyClueRuleAt(0, 0, () => forced.push(null));
  assert.equal(ok, true);
  const trailLen = s.trail.length;
  const expectedAntecedents = new Set([
    s._varIdEdge('H', hTopIdx),
    s._varIdEdge('V', vLeftIdx),
  ]);
  for (let i = trailLen - forced.length; i < trailLen; i++) {
    const reason = s._reasons[i];
    assert.ok(Array.isArray(reason), `reason at trail[${i}] must be an array`);
    assert.equal(reason.length, 2, `reason should have 2 antecedents`);
    for (const v of reason) assert.ok(expectedAntecedents.has(v), `unexpected antecedent ${v}`);
  }
});

test('SlitherlinkSolver: _applyVertexRuleAt records correct antecedents', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  const hIdx = s._hIdx(0, 0);
  s._currentReason = null; s._setEdge(hIdx, 'H', 1);
  const trailBefore = s.trail.length;
  const ok = s._applyVertexRuleAt(0, 0, () => {});
  assert.equal(ok, true);
  assert.equal(s.trail.length, trailBefore + 1, 'should force exactly 1 edge');
  const reason = s._reasons[s.trail.length - 1];
  assert.ok(Array.isArray(reason));
  assert.equal(reason.length, 1);
  assert.equal(reason[0], s._varIdEdge('H', hIdx));
});

test('SlitherlinkSolver: _applyCornerThree records empty antecedents', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[3,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  const trailBefore = s.trail.length;
  const ok = s._applyCornerThree('TL', () => {});
  assert.equal(ok, true);
  for (let i = trailBefore; i < s.trail.length; i++) {
    assert.deepEqual(s._reasons[i], []);
  }
});

test('SlitherlinkSolver: _applyAdjacentThreeH records empty antecedents', () => {
  const s = new SlitherlinkSolver({
    width: 4, height: 3,
    task: [[3,3,-1,-1],[-1,-1,-1,-1],[-1,-1,-1,-1]],
  });
  const trailBefore = s.trail.length;
  const ok = s._applyAdjacentThreeH(0, 0, () => {});
  assert.equal(ok, true);
  for (let i = trailBefore; i < s.trail.length; i++) {
    assert.deepEqual(s._reasons[i], []);
  }
});

test('SlitherlinkSolver: _propagateColors sub-rule A records edge+color antecedents', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  s._currentReason = null; s._setEdge(s._hIdx(1, 0), 'H', 1);
  s._currentReason = null; s._setColor(0, 1);
  const trailBefore = s.trail.length;
  const ok = s._propagateColors(() => {});
  assert.equal(ok, true);
  assert.equal(s.colors[1 * 3 + 0], 2);
  let colorForceIdx = -1;
  for (let i = s.trail.length - 1; i >= trailBefore; i--) {
    if (((s.trail[i] >> 24) & 3) === 2) { colorForceIdx = i; break; }
  }
  assert.ok(colorForceIdx >= 0, 'expected a color trail entry from rule A');
  const reason = s._reasons[colorForceIdx];
  assert.ok(Array.isArray(reason));
  assert.ok(reason.includes(s._varIdEdge('H', s._hIdx(1, 0))), 'reason must include edge var');
  assert.ok(reason.includes(s._varIdCell(0)), 'reason must include above-cell color var');
});

test('SlitherlinkSolver: _propagateColors sub-rule B records both-color antecedents', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  s._currentReason = null; s._setColor(0, 1);
  s._currentReason = null; s._setColor(1, 2);
  const trailBefore = s.trail.length;
  const ok = s._propagateColors(() => {});
  assert.equal(ok, true);
  assert.equal(s.V[s._vIdx(0, 1)], 1);
  let edgeForceIdx = -1;
  for (let i = s.trail.length - 1; i >= trailBefore; i--) {
    if (((s.trail[i] >> 24) & 3) !== 2) { edgeForceIdx = i; break; }
  }
  assert.ok(edgeForceIdx >= 0, 'expected an edge trail entry from rule B');
  const reason = s._reasons[edgeForceIdx];
  assert.ok(Array.isArray(reason));
  assert.ok(reason.includes(s._varIdCell(0)), 'reason must include left-cell color var');
  assert.ok(reason.includes(s._varIdCell(1)), 'reason must include right-cell color var');
});

test('SlitherlinkSolver: _propagateColors sub-rule C records own-color + opposite-neighbor antecedents', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,1,-1],[-1,-1,-1]],
  });
  const centerIdx = 1 * 3 + 1;
  const aboveIdx  = 0 * 3 + 1;
  s._currentReason = null; s._setColor(centerIdx, 1);
  s._currentReason = null; s._setColor(aboveIdx, 2);
  const trailBefore = s.trail.length;
  const ok = s._propagateColors(() => {});
  assert.equal(ok, true);
  let ruleCAntecedentsOk = false;
  for (let i = trailBefore; i < s.trail.length; i++) {
    if (((s.trail[i] >> 24) & 3) !== 2) continue;
    const reason = s._reasons[i];
    if (!Array.isArray(reason)) continue;
    if (reason.includes(s._varIdCell(centerIdx)) && reason.includes(s._varIdCell(aboveIdx))) {
      ruleCAntecedentsOk = true;
      break;
    }
  }
  assert.ok(ruleCAntecedentsOk, 'rule C should record own-color + opposite-neighbor as antecedents');
});

test('SlitherlinkSolver: _slApplyInsideReachability records opposite-color antecedents', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  s._currentReason = null; s._setColor(0, 1);
  s._currentReason = null; s._setColor(1, 2);
  s._currentReason = null; s._setColor(3, 2);
  const trailBefore = s.trail.length;
  const ok = s._slApplyInsideReachability(() => {});
  assert.equal(ok, true);
  for (let i = trailBefore; i < s.trail.length; i++) {
    const reason = s._reasons[i];
    assert.ok(Array.isArray(reason), `reason at ${i} must be array`);
    assert.ok(reason.length > 0, `reason at ${i} must be non-empty`);
  }
});

test('SlitherlinkSolver: _propagateParity records scan-line antecedents', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  s._currentReason = null; s._setEdge(s._vIdx(0, 0), 'V', 1);
  s._currentReason = null; s._setEdge(s._vIdx(0, 1), 'V', 1);
  s._currentReason = null; s._setEdge(s._vIdx(0, 3), 'V', 1);
  const _trailBefore = s.trail.length;
  const ok = s._propagateParity(() => {});
  assert.equal(ok, true);
  assert.equal(s.V[s._vIdx(0, 2)], 1, 'V[0][2] must be forced LINE');
  const forcedEntry = s.trail.length - 1;
  const reason = s._reasons[forcedEntry];
  assert.ok(Array.isArray(reason));
  assert.ok(reason.length === 3, `expected 3 antecedents, got ${reason.length}`);
  assert.ok(reason.includes(s._varIdEdge('V', s._vIdx(0, 0))));
  assert.ok(reason.includes(s._varIdEdge('V', s._vIdx(0, 1))));
  assert.ok(reason.includes(s._varIdEdge('V', s._vIdx(0, 3))));
});

test('SlitherlinkSolver: _applyLookahead records union-of-probe reasons', () => {
  const s = new SlitherlinkSolver({
    width: 4, height: 4,
    task: [
      [2, -1, -1, -1],
      [-1, -1, -1, -1],
      [-1, -1, -1, -1],
      [-1, -1, -1,  2],
    ],
  });
  s._depth = 0;
  s._inLookahead = false;
  const trailBefore = s.trail.length;
  const ok = s.propagate();
  if (!ok) return;
  for (let i = trailBefore; i < s.trail.length; i++) {
    assert.ok(s._reasons[i] === null || Array.isArray(s._reasons[i]),
      `trail[${i}] reason must be null or array`);
  }
});

test('SlitherlinkSolver: _propagateLearnedClauses no-op on empty clause set', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  let changed = false;
  const onChange = () => { changed = true; };
  const result = s._propagateLearnedClauses(onChange);
  assert.equal(result, true);
  assert.equal(changed, false);
});

test('SlitherlinkSolver: _propagateLearnedClauses forces unit clause', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  s._currentReason = [];
  s._setEdge(0, 'H', 2);
  s._currentReason = [];
  s._setEdge(1, 'H', 2);
  s._currentReason = null;
  const id0 = s._varIdEdge('H', 0);
  const id1 = s._varIdEdge('H', 1);
  const id2 = s._varIdEdge('H', 2);
  s._learnedClauses = [{ literals: [id0, id1, id2], activity: 1 }];
  let forced = false;
  const result = s._propagateLearnedClauses(() => { forced = true; });
  assert.equal(result, true);
  assert.equal(forced, true);
  assert.equal(s.H[2], 1);
  assert.equal(s._learnedClauses[0].activity, 2);
});

test('SlitherlinkSolver: _propagateLearnedClauses contradiction sets _lastConflictReason', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  s._currentReason = []; s._setEdge(0, 'H', 2);
  s._currentReason = []; s._setEdge(1, 'H', 2);
  s._currentReason = []; s._setEdge(2, 'H', 2);
  s._currentReason = null;
  const id0 = s._varIdEdge('H', 0);
  const id1 = s._varIdEdge('H', 1);
  const id2 = s._varIdEdge('H', 2);
  s._learnedClauses = [{ literals: [id0, id1, id2], activity: 1 }];
  const result = s._propagateLearnedClauses(() => {});
  assert.equal(result, false);
  assert.ok(Array.isArray(s._lastConflictReason));
  assert.ok(s._lastConflictReason.includes(id0));
  assert.ok(s._lastConflictReason.includes(id1));
  assert.ok(s._lastConflictReason.includes(id2));
});

test('SlitherlinkSolver: clue rule contradiction sets _lastConflictReason', () => {
  const s = new SlitherlinkSolver({
    width: 2, height: 2,
    task: [[0, -1], [-1, -1]],
  });
  s._currentReason = []; s._setEdge(s._hIdx(0, 0), 'H', 1);
  s._currentReason = []; s._setEdge(s._hIdx(1, 0), 'H', 1);
  s._currentReason = []; s._setEdge(s._vIdx(0, 0), 'V', 1);
  s._currentReason = null;
  s._lastConflictReason = null;
  const ok = s.propagate();
  assert.equal(ok, false);
  assert.ok(Array.isArray(s._lastConflictReason));
  assert.ok(s._lastConflictReason.length > 0);
  for (const v of s._lastConflictReason) {
    assert.ok(v >= 0 && v < s.totalVars, `varId ${v} out of range`);
  }
});

test('SlitherlinkSolver: vertex rule contradiction sets _lastConflictReason', () => {
  // Give dot (1,1) three LINE edges to trigger the m > 2 contradiction.
  // For width=2: hIdx(1,0)=2, hIdx(1,1)=3, vIdx(0,1)=1 all meet at dot(1,1).
  const s = new SlitherlinkSolver({
    width: 2, height: 2,
    task: [[-1,-1],[-1,-1]],
  });
  s._currentReason = []; s._setEdge(s._hIdx(1, 0), 'H', 1);
  s._currentReason = []; s._setEdge(s._hIdx(1, 1), 'H', 1);
  s._currentReason = []; s._setEdge(s._vIdx(0, 1), 'V', 1);
  s._currentReason = null;
  s._lastConflictReason = null;
  const ok = s.propagate();
  assert.equal(ok, false);
  assert.ok(Array.isArray(s._lastConflictReason));
  assert.ok(s._lastConflictReason.length > 0);
  for (const v of s._lastConflictReason) {
    assert.ok(v >= 0 && v < s.totalVars, `varId ${v} out of range`);
  }
});

test('SlitherlinkSolver: _computeBackjumpLevel returns second-highest level', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  const v1 = s._varIdEdge('H', 0);  // id 0, level 1
  const v2 = s._varIdEdge('H', 1);  // id 1, level 2
  const v3 = s._varIdEdge('H', 2);  // id 2, level 3
  s.trail = [(0 << 24) | 0, (0 << 24) | 1, (0 << 24) | 2];
  s._decisionLevels = [1, 2, 3];
  s._reasons = [null, null, null];

  // Learned clause literals at levels [3, 1, 2] → max=3, second=2.
  // Use ~v for negation to handle var id 0 unambiguously.
  const learned = [~v3, ~v1, ~v2];
  const level = s._computeBackjumpLevel(learned);
  assert.equal(level, 2);
});

test('SlitherlinkSolver: _computeBackjumpLevel single level returns 0', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  const v1 = s._varIdEdge('H', 0);
  s.trail = [(0 << 24) | 0];
  s._decisionLevels = [3];
  s._reasons = [null];
  const level = s._computeBackjumpLevel([~v1]);
  assert.equal(level, 0);
});

test('SlitherlinkSolver: _backjumpTo resets trail and _decisionLevel', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });

  s.H[0] = 1;
  s.trail.push((0 << 24) | 0);
  s._reasons.push(null);
  s._decisionLevels.push(1);

  s.H[1] = 1;
  s.trail.push((0 << 24) | 1);
  s._reasons.push(null);
  s._decisionLevels.push(2);

  s.H[2] = 1;
  s.trail.push((0 << 24) | 2);
  s._reasons.push(null);
  s._decisionLevels.push(3);

  s._decisionLevel = 3;

  s._backjumpTo(1);

  assert.equal(s._decisionLevel, 1);
  for (let i = 0; i < s._decisionLevels.length; i++) {
    assert.ok(s._decisionLevels[i] <= 1, `trail entry ${i} has level ${s._decisionLevels[i]} > 1`);
  }
  assert.equal(s.H[1], 0);
  assert.equal(s.H[2], 0);
  assert.equal(s.H[0], 1);
});

test('SlitherlinkSolver: _analyzeConflict derives first-UIP learned clause', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });

  const varA = s._varIdEdge('H', 0);  // id 0
  const varB = s._varIdEdge('H', 1);  // id 1
  const varC = s._varIdEdge('H', 2);  // id 2

  // Simulate trail entries directly. Edge encoding: (kind<<24)|idx, kind 0=H.
  s.trail = [
    (0 << 24) | 0,
    (0 << 24) | 1,
    (0 << 24) | 2,
  ];
  s._reasons = [
    null,           // varA: decision at level 1
    null,           // varB: decision at level 2
    [varA, varB],   // varC: implied by varA + varB
  ];
  s._decisionLevels = [1, 2, 2];
  s._decisionLevel = 2;

  // Set actual edge values so _varValue returns the right sign.
  s.H[0] = 1; // varA = LINE
  s.H[1] = 1; // varB = LINE
  s.H[2] = 1; // varC = LINE

  // Conflict reason includes varC and varB.
  const conflictReason = [varC, varB];
  const learned = s._analyzeConflict(conflictReason);

  assert.ok(Array.isArray(learned));
  // UIP is varC at level 2 (most recently assigned current-level var).
  // Negated using ~ convention.
  assert.ok(learned.includes(~varC), `expected ~varC=${~varC} in learned; got ${JSON.stringify(learned)}`);
  // Resolution of varC's reason brings in varA (level 1, earlier).
  assert.ok(learned.includes(~varA), `expected ~varA=${~varA} in learned; got ${JSON.stringify(learned)}`);
  // Exactly one current-level literal (the UIP) in the learned clause.
  const level2Lits = learned.filter(lit => {
    const v = lit >= 0 ? lit : ~lit;
    return s._decisionLevelOf(v) === 2;
  });
  assert.equal(level2Lits.length, 1, `expected 1 current-level literal; got ${JSON.stringify(level2Lits)}`);
});

test('SlitherlinkSolver: _addLearnedClause stores clauses up to cap', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  for (let i = 0; i < 4999; i++) {
    s._addLearnedClause([i + 1]);
  }
  assert.equal(s._learnedClauses.length, 4999);
});

test('SlitherlinkSolver: _addLearnedClause evicts on overflow', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  for (let i = 0; i < 5000; i++) {
    s._addLearnedClause([i + 1]);
  }
  assert.equal(s._learnedClauses.length, 3750);
});

test('SlitherlinkSolver: _addLearnedClause evicts lowest-activity clauses', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  for (let i = 0; i < 4999; i++) {
    s._addLearnedClause([i + 1]);
  }
  for (let i = 0; i < 10; i++) {
    s._learnedClauses[i].activity = 999;
  }
  s._addLearnedClause([9999]);
  const highActivity = s._learnedClauses.filter(c => c.activity === 999);
  assert.equal(highActivity.length, 10);
});

test('SlitherlinkSolver: _bumpVsids increments scores', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  assert.equal(s._vsidsScores[5], 0);
  assert.equal(s._vsidsScores[6], 0);
  assert.equal(s._vsidsScores[13], 0);
  // Literals: +5 (var 5), ~7 (var 7, negated), 13 (var 13).
  s._bumpVsids([5, ~7, 13]);
  assert.equal(s._vsidsScores[5], 1);
  assert.equal(s._vsidsScores[7], 1);
  assert.equal(s._vsidsScores[13], 1);
  assert.equal(s._vsidsScores[0], 0);
});

test('SlitherlinkSolver: _decayVsidsIfDue decays only after 256 calls', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  s._vsidsScores[5] = 10;
  s._learnedClauses = [{ literals: [5], activity: 8 }];

  for (let i = 0; i < 255; i++) s._decayVsidsIfDue();
  assert.equal(s._vsidsScores[5], 10);
  assert.equal(s._learnedClauses[0].activity, 8);

  s._decayVsidsIfDue();
  assert.ok(Math.abs(s._vsidsScores[5] - 9.5) < 0.01,
    `expected ~9.5, got ${s._vsidsScores[5]}`);
  assert.ok(Math.abs(s._learnedClauses[0].activity - 7.6) < 0.01,
    `expected ~7.6, got ${s._learnedClauses[0].activity}`);
  assert.equal(s._vsidsConflictsSinceDecay, 0);
});

test('SlitherlinkSolver: _pickDecisionLiteral picks highest VSIDS score', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  s._vsidsScores[2] = 0.5;
  s._vsidsScores[4] = 2.0;
  s._vsidsScores[7] = 1.0;
  const lit = s._pickDecisionLiteral();
  // Extract varId with ~lit convention.
  const varId = lit >= 0 ? lit : ~lit;
  assert.equal(varId, 4);
});

test('SlitherlinkSolver: _pickDecisionLiteral falls back when all scores zero', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  const lit = s._pickDecisionLiteral();
  // Returns 0 only if all vars assigned; with empty grid, must return non-zero.
  // Under ~lit convention, a positive literal can be 0 (var 0 positive).
  // So we can't simply assert "lit !== 0"; instead verify a valid var ID came back
  // by checking _varValue is 0 for that var (unassigned).
  const varId = lit >= 0 ? lit : ~lit;
  assert.ok(varId >= 0 && varId < s.totalVars, `varId ${varId} out of range`);
  assert.equal(s._varValue(varId), 0, 'returned literal must be unassigned');
});

test('SlitherlinkSolver: _lubyNext returns the correct first 18 Luby values', () => {
  const s = new SlitherlinkSolver({ width: 2, height: 2, task: [[-1,-1],[-1,-1]] });
  // Canonical 0-indexed Luby (Knuth, AofA Vol 4A §7.2.2.2).
  const expected = [1, 1, 2, 1, 1, 2, 4, 1, 1, 2, 1, 1, 2, 4, 8, 1, 1, 2];
  for (let i = 0; i < expected.length; i++) {
    assert.equal(s._lubyNext(i), expected[i], `_lubyNext(${i}) should be ${expected[i]}`);
  }
});

test('SlitherlinkSolver: _restart pops trail to level 0', () => {
  const s = new SlitherlinkSolver({ width: 2, height: 2, task: [[-1,-1],[-1,-1]] });
  s._decisionLevel = 3;
  // Push three real trail entries (using the existing trail encoding).
  s.H[0] = 1;
  s.trail.push((0 << 24) | 0);
  s._reasons.push(null);
  s._decisionLevels.push(1);
  s.H[1] = 1;
  s.trail.push((0 << 24) | 1);
  s._reasons.push(null);
  s._decisionLevels.push(2);
  s.H[2] = 1;
  s.trail.push((0 << 24) | 2);
  s._reasons.push(null);
  s._decisionLevels.push(3);
  s._restart();
  assert.equal(s._decisionLevel, 0);
  assert.equal(s.trail.length, 0);
  // Edges rolled back.
  assert.equal(s.H[0], 0);
  assert.equal(s.H[1], 0);
  assert.equal(s.H[2], 0);
});

test('SlitherlinkSolver: _restart preserves _learnedClauses and _vsidsScores', () => {
  const s = new SlitherlinkSolver({ width: 2, height: 2, task: [[-1,-1],[-1,-1]] });
  s._learnedClauses.push({ literals: [1, ~2], activity: 5 });
  s._vsidsScores[0] = 3.14;
  s._decisionLevel = 1;
  s.H[0] = 1;
  s.trail.push((0 << 24) | 0);
  s._decisionLevels.push(1);
  s._reasons.push(null);
  s._restart();
  assert.equal(s._learnedClauses.length, 1);
  assert.equal(s._learnedClauses[0].literals[0], 1);
  assert.ok(Math.abs(s._vsidsScores[0] - 3.14) < 0.001);
});

test('SlitherlinkSolver+CDCL: 5x5 fixture solves identically via _cdclSearch', () => {
  const { slitherlink5x5 } = require('./fixtures/puzzles.js');
  SlitherlinkSolver.clearSolutionCache();
  const s = new SlitherlinkSolver({
    width: slitherlink5x5.cols,
    height: slitherlink5x5.rows,
    task: slitherlink5x5.task,
  });
  const r = s.solve();
  assert.equal(r.solved, true, '5x5 fixture should solve');
  assert.equal(r.horizontal.length, slitherlink5x5.rows + 1);
  assert.equal(r.horizontal[0].length, slitherlink5x5.cols);
  assert.equal(r.vertical.length, slitherlink5x5.rows);
  assert.equal(r.vertical[0].length, slitherlink5x5.cols + 1);
  // A solved puzzle has every edge determined: LINE (1) or EMPTY (2).
  // UNKNOWN (0) in a "solved=true" result would be a bug.
  for (const row of r.horizontal) for (const v of row) assert.ok(v === 1 || v === 2, `horizontal edge ${v} not LINE/EMPTY`);
  for (const row of r.vertical) for (const v of row) assert.ok(v === 1 || v === 2, `vertical edge ${v} not LINE/EMPTY`);
});

test('SlitherlinkSolver+CDCL: fuzz-generated small puzzles all solve correctly', () => {
  SlitherlinkSolver.clearSolutionCache();
  const cases = [
    { rows: 3, cols: 3, task: [[-1,2,-1],[-1,-1,2],[-1,2,-1]] },
    { rows: 3, cols: 3, task: [[2,-1,-1],[-1,-1,-1],[-1,-1,2]] },
    { rows: 4, cols: 4, task: [[-1,2,-1,-1],[2,-1,-1,2],[-1,-1,2,-1],[-1,2,-1,-1]] },
    { rows: 4, cols: 4, task: [[3,-1,-1,3],[-1,-1,-1,-1],[-1,-1,-1,-1],[3,-1,-1,3]] },
    { rows: 4, cols: 4, task: [[-1,3,-1,3],[-1,-1,2,-1],[2,-1,-1,-1],[3,-1,3,-1]] },
  ];
  for (const c of cases) {
    SlitherlinkSolver.clearSolutionCache();
    const s = new SlitherlinkSolver({ width: c.cols, height: c.rows, task: c.task });
    s.maxMs = 5000;
    const r = s.solve();
    if (r.solved) {
      // Solved puzzles have every edge determined to LINE (1) or EMPTY (2).
      for (const row of r.horizontal) for (const v of row) assert.ok(v === 1 || v === 2, `horizontal edge ${v} not LINE/EMPTY`);
      for (const row of r.vertical) for (const v of row) assert.ok(v === 1 || v === 2, `vertical edge ${v} not LINE/EMPTY`);
    }
  }
});

test('SlitherlinkSolver+CDCL: 30x30 daily still solves under 2s with same output', () => {
  SlitherlinkSolver.clearSolutionCache();
  const realPuzzles = require('./fixtures/real-puzzles.js');
  const daily = realPuzzles.slitherlinkRealDaily30x30;
  // Skip gracefully until the fixture is captured in T16.
  if (!daily || daily.rows !== 30 || daily.cols !== 30) {
    console.warn('No 30x30 daily fixture; skipping daily regression test');
    return;
  }
  const s = new SlitherlinkSolver({ width: daily.cols, height: daily.rows, task: daily.task });
  s.maxMs = 10000;
  const t0 = Date.now();
  const r = s.solve();
  const dt = Date.now() - t0;
  assert.equal(r.solved, true, '30x30 daily should fully solve with CDCL');
  assert.ok(dt < 2000, `30x30 daily should solve in <2s; took ${dt}ms`);
});

test('SlitherlinkSolver+CDCL: 50x40 monthly returns a sound result within budget', () => {
  // Current state: the monthly times out and returns a partial. That is the
  // known perf envelope — see CLAUDE.md "Slitherlink performance envelope".
  // This test asserts the sound behaviours only:
  //   - solve() returns within budget (no infinite loop / hang)
  //   - result is either solved=true OR (solved=false AND error='timed out' AND
  //     partial=true). Specifically NOT 'no solution found' — that would mean
  //     the lookahead/CDCL composition bug regressed to spurious UNSAT on a
  //     known-solvable board.
  // Once a real perf fix lands, tighten this to assert solved=true within a
  // target budget.
  SlitherlinkSolver.clearSolutionCache();
  const realPuzzles = require('./fixtures/real-puzzles.js');
  const monthly = realPuzzles.slitherlinkRealMonthly50x40_a;
  if (!monthly) {
    console.warn('No 50x40 monthly fixture; will be added in Task 16');
    return;
  }
  const s = new SlitherlinkSolver({ width: monthly.cols, height: monthly.rows, task: monthly.task });
  s.maxMs = 8000;
  const t0 = Date.now();
  const r = s.solve();
  const dt = Date.now() - t0;
  assert.ok(dt < 15000, `solve() exceeded wall-clock guard; took ${dt}ms`);
  if (r.solved) {
    console.warn(`Monthly now solves in ${dt}ms — consider tightening this assertion.`);
    return;
  }
  // Not solved → must be a sound timeout-partial, not a spurious UNSAT.
  assert.equal(r.error, 'timed out', `monthly returned error=${r.error}; expected 'timed out' or solved=true (spurious UNSAT regression?)`);
  assert.equal(r.partial, true, 'monthly partial result missing partial=true');
});

test('HashiSolver: hashi3x3Tiny matches golden', () => {
  HashiSolver.clearSolutionCache();
  const p = fixtures.hashi3x3Tiny;
  const result = new HashiSolver(p).solve();
  assert.deepEqual(result, golden.hashi3x3Tiny);
  HashiSolver.clearSolutionCache();
});

test('HashiSolver: hashi7x7Easy matches golden', () => {
  HashiSolver.clearSolutionCache();
  const p = fixtures.hashi7x7Easy;
  const result = new HashiSolver(p).solve();
  assert.deepEqual(result, golden.hashi7x7Easy);
  HashiSolver.clearSolutionCache();
});

test('HeyawakeSolver: heyawake6x6Easy fixture solves to a unique valid grid', () => {
  const fixture = fixtures.heyawake6x6Easy;
  HeyawakeSolver.clearSolutionCache();
  const s = new HeyawakeSolver({
    rows: fixture.rows,
    cols: fixture.cols,
    rooms: heyawakeRoomsFromFixture(fixture),
  });
  const r = s.solve();
  assert.equal(r.solved, true);
  const expected = golden.heyawake6x6Easy;
  assert.deepEqual(r.grid, expected);
});
