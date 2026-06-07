# Thermometers puzzle support — design

**Date:** 2026-06-06
**Target:** puzzles-mobile.com `/thermometers/` (slug `thermometers`), 15×15 and other sizes
**Scope:** Full parity — Detect, Solve, Hint, Loop — matching every other puzzle in the extension.

## Summary

Thermometers is a margin-clue cell-shading puzzle. The grid is fully tiled by
**thermometers**: each thermometer is an ordered chain of cells with a **bulb**
at one end and a **tip** at the other. You fill mercury into thermometers; the
mercury in each thermometer is a **contiguous run starting at the bulb**. Row
and column clues give the exact number of filled cells in that row/column. The
solution is unique.

This is a clean CSP with no connectivity constraint, so (unlike Shingoki /
Shakashaka / Masyu) there is no large-board deduction ceiling — 15×15 (and
larger) should fully solve quickly.

## Page encoding (recon, ground truth)

Captured from `window.Game` on a live `/thermometers/random/15x15` board.

- **`window.Game.areaPoints`** — array of thermometers. `areaPoints[t]` is an
  **ordered list of cells**, `{row, col, n}`, where **array index 0 is the
  bulb** and the last element is the tip. (The `n` field is the cell's geometric
  coordinate index along the run and is NOT the bulb order — only the array
  order is. Verified: e.g. a thermometer `[{r0,c6,n3},{r0,c5,n2},{r0,c4,n1},
  {r0,c3,n0}]` has its bulb at `(0,6)` and fills left to `(0,3)`.) The page
  builds this in `parseTask` from the `;`-separated area definitions (direction
  cases 1–4 push bulb-first by direction; case 5 is an explicit ordered list).
- **`window.Game.areas`** — `rows×cols` grid of thermometer ids; every cell
  belongs to exactly one thermometer (full tiling). Used to validate coverage.
- **`window.Game.task`** — 30 numbers for a 15×15: the first `cols` are the
  **column** clues, the next `rows` are the **row** clues (cols-then-rows
  convention, matching Tents). Both halves of the captured board sum to 112,
  consistent with a single filled-cell total. **Orientation is verified
  empirically** in the prototype/brute-force gate before the plan locks (if
  cols-first fails to produce the unique real-board solution, swap).
- **`cellStatus[r][c]`** — `0` unknown, `1` filled (mercury), `2` empty/cross.
  Confirmed by `drawCellStatus` (`cell-on`=1, `cell-x`=2) and
  `serializeSolution` (`cellStatus[r][c] == 1 ? "y" : "n"`, row-major). A solve
  registers when `cellStatus == 1` on exactly the filled cells.
- **There are NO clue cells inside the grid** — clues live on the margins
  (like Nonogram / Tents). Every cell is fillable and tracked in `cellStatus`.
  So, unlike the Nurikabe/Tents family, the solver does NOT need to re-assert
  any untracked clue cells.
- **`getErrors` is a no-op stub** (`function(t){return true}`) — the site does
  not validate thermometer rules. As with Stitches, the solver derives the
  rules from first principles and is **brute-force-gated** in tests.

## Rules (the solver's oracle)

A complete fill is valid iff:

1. **Prefix rule:** for every thermometer, the filled cells are a contiguous
   prefix starting at the bulb (index 0). Equivalently: if `cells[t][i]` is
   filled then every `cells[t][j]` with `j < i` is filled; if a cell is empty,
   every cell after it toward the tip is empty.
2. **Count rule:** every row has exactly its row-clue filled cells and every
   column has exactly its column-clue filled cells.

(`getErrors` enforces neither — the oracle is the spec, gated by brute force.)

## Component design

### Solver — `src/solvers/thermometers.js`

- **Model.** Thermometer `t` has an ordered cell list `cells[t]` (bulb→tip) and
  a fill level `lvl[t] ∈ [lo[t], hi[t]]`; `cells[t][i]` is filled iff
  `i < lvl[t]`. The contiguous-prefix rule is intrinsic to this integer
  representation, so only the count rule needs active enforcement.
- **Propagation to a fixpoint** (per row and per column):
  - `definitelyFilled(line)` = count of cells whose thermo has `i < lo[t]`.
  - `possiblyFilled(line)` = count of cells whose thermo has `i < hi[t]`.
  - Contradiction if `definitelyFilled > clue` or `possiblyFilled < clue`.
  - If `definitelyFilled == clue`, force every still-possible cell in the line
    empty → lower its thermo's `hi` (cascades down the prefix automatically).
  - If `possiblyFilled == clue`, force every possibly-filled cell filled → raise
    its thermo's `lo`.
  - Forcing a cell adjusts a thermo bound, which dirties the rows/cols of the
    cells that bound change exposes; repeat until stable. Use a dirty-worklist
    over thermometers/lines (the perf pattern from Tents) so propagation is
    incremental, not a full rescan each iteration.
- **Search.** Pick the most-constrained thermometer (smallest `hi-lo` among
  those with `hi > lo`), branch over its feasible levels in `[lo, hi]`,
  propagate, recurse. **Trail-based undo** (preallocated typed array of changed
  bounds) so backtracking is allocation-free.
- **Oracle** `_isValid(grid)` — prefix rule for every thermometer + exact row/col
  counts. Used by the brute-force differential gate.
- **Sound partial.** On timeout, emit the root-propagated bounds as a partial
  grid (cells decided by `lo`/`hi` agreement), never a guess.
- **API.** `solve(countAll=false)` → `{solved, grid, count?}` or
  `{solved:false, partial:true, grid}` on timeout; grid value-space `0` empty,
  `1` filled (the widget maps to cellStatus). `getHint(initialState)` →
  newly-forced cells `{row, col, value}` (value `1` filled / `2` empty).

### Widget — `src/widget/puzzles/thermometers.js`

- `type: 'thermometers'`; flags `renderEmptyCells: true`,
  `hasAbsoluteHintCells: true`, `skipAutoSolveGate: true`.
- **`readState`** — raw `cellStatus` (0/1/2), no normalization, so Loop
  preserves marks already on the board.
- **`drawStaticLayer`** — render the thermometer geometry from `pd.thermos`:
  a **bulb** (filled circle) at index 0 of each thermometer and a rounded
  **tube** connecting consecutive cells through to the tip; plus the row/col
  clue gutters and the grid border. Cached; rebuilt only on shape change.
- **`drawPreviewCell`** — value `1` → mercury (coloured rounded fill sitting
  inside the tube); value `2` → light empty/cross mark; skip nothing (all cells
  are board cells).
- **Diff** — default per-cell fallback in `diff.js` (`g !== 0 && g !== s`); no
  `diff.js` change.
- **`solutionFromResult`** — map solver grid → cellStatus: filled→1, empty→2.
- **`hintDispatch`** — deductive `getHint`, then **cached-solution fallback**,
  batch-capped for Loop (`makeSimpleHintDispatch` has no fallback; same fix as
  Tapa/Tents). Per-click batch size scales with board area for Loop.

### Cross-layer wiring (standard touchpoints)

- **`handler.js`** — `thermometersHandler`: matches `/thermometers/`; `detect`
  returns `{thermos, colClue, rowClue, rows, cols}` (thermos = ordered cell
  lists from `areaPoints`, clues split from `task`); raw `readState`;
  `applySolution → applyThermometersState`. `registerHandler(...)` added before
  the Node-only export tail.
- **`main-world.js`** — `readThermometersData` (areaPoints → ordered thermo cell
  lists, task → col/row clues, dims), `readThermometersState`,
  `applyThermometersState` (writes `cellStatus` = 1 filled / 2 empty;
  `saveState(true)` BEFORE writes; canonical render ladder AFTER; never
  `check()`), and a `/thermometers/` branch in `dumpPuzzleForBench`.
- **`background.js`** — 3 `EXEC_MAIN_ALLOWLIST` entries
  (`readThermometersData`, `readThermometersState`, `applyThermometersState`).
- **`globals.d.ts`** — `ThermometersSolver` decl + the 3 `MainWorldFn` entries
  (kept in sync with the allowlist).
- **`eslint.config.js`**, **`solver.worker.js`** (global comment + dispatch
  arm), **`src/widget/puzzles/index.js`**, **`scripts/build-solver-bundle.js`**
  (FILES before `diff.js`, EXPORTS before `computePuzzleDiff`),
  **`scripts/build-content-bundle.js`**.
- **`src/widget/widget.js`** — add the `thermometers` `{partial, grid}` branch
  to the Solve partial-dispatch chain (the recurring gotcha: the generic branch
  only matches `result.cells`).

## Data flow

`detect` → `{thermos, colClue, rowClue, rows, cols}` cached in `puzzleData` →
background worker `solve` from givens → `puzzleData.solution` + localStorage
caches (non-blocking `autoSolve` after detect) → `drawPreview` draws the
thermometer geometry (static layer) and rings board↔solution diffs
(`computePuzzleDiff`, default per-cell) → `applySolution` / Hint / Loop write
`cellStatus` via `applyThermometersState`.

## Testing — `tests/thermometers.test.js`

- **Oracle units:** prefix rule + count rule; a placement that passes counts
  but breaks the prefix is rejected; a non-bulb-anchored fill is rejected.
- **Propagation units:** count-forcing raises `lo` (line possibly==clue) and
  lowers `hi` (line definitely==clue); a forced cell cascades through its
  thermometer's prefix.
- **Soundness gate:** generate ~300 random tiny boards (random thermometer
  tilings + a random valid fill → derived clues) and assert the solver's
  `solved`/`count` match full brute-force enumeration via the oracle.
- **Real-board solve:** the captured 15×15 board (fixture in
  `tests/fixtures/real-puzzles.js`) solves uniquely and oracle-passes; this test
  also empirically confirms the `task` cols-then-rows orientation.
- **Bench:** `tests/bench-thermometers.js` (`process.exit(1)` on unsolved).

## Validation before planning (validate-before-plan discipline)

Before the plan locks: build a throwaway prototype solver + oracle, brute-force
soundness-gate it on tiny boards, run it on the captured real 15×15 (confirming
unique solve and the clue orientation), and run the plan's exact test
assertions. This has caught a test bug in every prior puzzle.

## Out of scope / non-goals

- No special handling for diagonal or branching thermometers — the page's
  `areaPoints` are simple ordered chains; the solver treats any ordered chain
  generically (works regardless of geometry).
- No `getErrors` port (it's a no-op); soundness rests on the brute-force gate.
