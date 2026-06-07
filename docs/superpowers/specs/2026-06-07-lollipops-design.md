# Lollipops puzzle support — design

**Date:** 2026-06-07
**Target:** puzzles-mobile.com `/lollipops/` (slug `lollipops`), 10×10 and other sizes
**Scope:** Full parity — Detect, Solve, Hint, Loop.

## Summary

Lollipops is a shape-placement logic puzzle. Each **lollipop** is a 2-cell domino: a
round **candy** plus its **stick**. A horizontal domino is candy + horizontal stick
(side by side); a vertical domino is candy + vertical stick (stacked). Some cells are
**given** (fixed shapes); the player fills the rest with shapes or leaves them empty so
that every shape forms exactly one valid lollipop and no two equal shapes "see" each
other along a row/column. The solution is unique.

Unlike Thermometers/Stitches, **`getErrors` is a genuine oracle** (not a no-op) — the
solver ports it verbatim and is additionally brute-force-gated.

## Page encoding (recon, ground truth)

Captured from `window.Game` on a live `/lollipops/random/10x10-normal` board.

- **`window.Game.task`** — a `rows×cols` grid. `-1` = a normal cell the player fills;
  `≥ 0` = a **given clue cell whose shape is fixed** to that value. `getShapeAt(r,c)`
  returns `task[r][c]` when `≥ 0`, else `cellStatus[r][c]`. So the clue value **is** the
  shape, not a count (`getErrors` contains no count logic).
- **Shape value-space** (`cellStatus` and `task`): `0` off/unset, `1` = candy (`o`,
  circle), `2` = vertical stick (`v`), `3` = horizontal stick (`h`), `4` = cross/empty
  (`x`). Confirmed by `drawCellStatus` (`cell-o`=1, `cell-v`=2, `cell-h`=3, `cell-x`=4)
  and `serializeSolution` (`["n","o","v","h","n"]` — so `0` and `4` both serialize to
  `"n"`; a solve is registered from the **shape placements** alone).
- **Clue cells are NOT tracked in `cellStatus`** — `getCurrentStatus` reads `taskStatus`
  for them; `cellStatus` stays `0` at clue cells. This is the
  [[project_clue_cells_not_in_cellstatus]] family.
- **No regions** (`areas`/`areaPoints`/`areaTask` are null) and **no row/col margin
  clues**. Clues are in-grid fixed shapes.

## Rules (the solver's oracle — ported from `getErrors`)

`_lollipopPartnerState(shape, dir)` defines a valid connection:
- candy `o` (1): partner is `h` (3) when the neighbour is **L/R**, `v` (2) when **U/D**.
- vertical stick `v` (2): partner is `o` (1) when the neighbour is **U/D**; otherwise no
  connection (L/R → null).
- horizontal stick `h` (3): partner is `o` (1) when the neighbour is **L/R**; otherwise
  no connection (U/D → null).

A complete board is valid iff, for every shape cell (candy or stick — including givens):

1. **Exactly one connection** (`u == 1`): exactly one orthogonal neighbour is its valid
   partner per `_lollipopPartnerState`.
2. **No invalid adjacency** (`d == 0`): no orthogonal neighbour is a non-partner shape
   (any neighbouring shape must be the one valid partner; all others must be empty/cross).
3. **Line-of-sight**: walking from the cell in each of the 4 directions and skipping only
   `x` (4) cells, if the first non-`x` cell is the **same shape**, that's an error. Net
   effect: in each row/column's empties-removed sequence, no two **adjacent** shapes are
   equal.

Consequences: every lollipop is exactly a candy + one adjacent stick (sticks are length
1; a longer stick would give a middle segment two connections). The whole board is a set
of candy+stick dominoes plus empty cells. (`getErrors` buckets a flagged cell into
`taskErrors` if it is a clue cell, else `cellErrors`; this bucketing does not affect
validity.)

## Component design

### Solver — `src/solvers/lollipops.js`

- **Model.** Per-cell variable. Clue cells (`task ≥ 0`) are fixed to their shape. Free
  cells (`task == -1`) range over {empty=4, candy=1, v=2, h=3}.
- **Oracle `_isValid(grid)`** — the three rules above, ported from `getErrors`. The
  soundness anchor and the brute-force-gate reference. `grid` here uses the shape codes
  with both `0` and `4` treated as empty (matching `serializeSolution`).
- **Propagation to a fixpoint** (sound deductions from the rules):
  - A `v`-clue/`v`-cell needs a candy directly above **or** below and forbids any shape
    L/R; symmetric for `h` (candy L/R, no shape U/D); a candy needs exactly one stick
    neighbour of matching orientation and no other shape neighbour.
  - When only one partner placement remains for a shape, force it; when a cell can hold no
    shape legally, set it empty.
  - Line-of-sight: a candidate shape is pruned if it would sit adjacent (in the
    empties-removed row/col sequence) to an already-placed equal shape.
  - Repeat until stable; contradiction ⇒ backtrack.
- **Search.** MRV free cell (fewest legal values), branch over candidates, propagate,
  recurse; **trail-based undo**. 10×10 with local constraints solves fast.
- **API.** `solve(countAll=false)` → `{solved, grid, count}` (grid: clue cells `0`, free
  cells `1/2/3/4`) or `{solved:false, partial:true, grid}` on timeout, `{solved:false,
  error}` on contradiction. `getHint(initialState)` seeds free cells from the live
  `cellStatus`, **re-asserts clue shapes from `task`** (clue cells aren't in `cellStatus`
  — else Loop never terminates), propagates, and returns newly-forced free cells
  `{row, col, value(1/2/3/4)}`.

### Widget — `src/widget/puzzles/lollipops.js`

- `type:'lollipops'`; flags `renderEmptyCells:true`, `hasAbsoluteHintCells:true`,
  `skipAutoSolveGate:true`.
- **`readState`** — raw `cellStatus` (0/1/2/3/4), no normalization (Loop preserves marks).
- **`drawStaticLayer`** — render the **given** clue shapes from `pd.task` (1 = candy
  circle, 2 = vertical bar, 3 = horizontal bar) in a distinct given colour, plus the grid
  border. No clue gutters.
- **`drawPreviewCell`** — placed shapes: candy = filled circle, `v` = vertical rounded
  bar, `h` = horizontal rounded bar, empty (4) = faint mark or nothing. A candy↔stick
  connector line is optional. Exact glyph geometry is empirical — verify on the live page
  (same caveat as Shakashaka/Thermometers).
- **Diff** — default per-cell fallback in `diff.js` (clue cells are `0` in both board and
  solution grid, so no false diff). No `diff.js` change.
- **`solutionFromResult`** — `result.grid`.
- **`applyHint`** — CUSTOM hook (required): the generic `applyHintCells` binary-clamps
  (`v===1→1`, `v===2→2`, else→0), which would destroy `h`-sticks (3) and crosses (4).
  Merge the hint `extraCells` into a grid and route through `applyLollipopsState` (writes
  1/2/3/4). Same class as [[project_pipes_value_space]].
- **`hintDispatch`** — deductive `getHint`, then cached-solution fallback, batch-capped
  for Loop (`makeSimpleHintDispatch` has no fallback).
- **`cacheKey`/`staticSig`** — hash the `task` grid + dims (nameplate byte distinct from
  existing puzzles).

### Cross-layer wiring (standard touchpoints)

- **`handler.js`** — `lollipopsHandler`: matches `/lollipops/`; `detect` returns
  `{task, rows, cols}`; raw `readState`; `applySolution → applyLollipopsState`;
  `registerHandler(...)` before the Node-only export tail.
- **`main-world.js`** — `readLollipopsData` (`task` 2D + dims), `readLollipopsState`
  (`cellStatus` 0/1/2/3/4), `applyLollipopsState` (write `1/2/3/4` to `cellStatus` for
  **non-clue** cells only — skip `task[r][c] ≥ 0`; `saveState(true)` BEFORE; canonical
  render ladder AFTER; never `check()`), and a `/lollipops/` branch in
  `dumpPuzzleForBench`.
- **`background.js`** — 3 `EXEC_MAIN_ALLOWLIST` entries (`readLollipopsData`,
  `readLollipopsState`, `applyLollipopsState`).
- **`globals.d.ts`** — `LollipopsSolver` decl + the 3 `MainWorldFn` entries (kept in sync
  with the allowlist).
- **`eslint.config.js`** (`LollipopsSolver` + `lollipops` globals), **`solver.worker.js`**
  (global comment + dispatch arm), **`src/widget/puzzles/index.js`**,
  **`scripts/build-solver-bundle.js`** (FILES before `diff.js`, EXPORTS before
  `computePuzzleDiff`), **`scripts/build-content-bundle.js`**.
- **`src/widget/widget.js`** — add the `lollipops` `{partial, grid}` branch to the Solve
  partial-dispatch chain (the recurring gotcha: the generic branch only matches
  `result.cells`).

## Data flow

`detect` → `{task, rows, cols}` cached in `puzzleData` → background worker `solve` →
`puzzleData.solution` + localStorage caches (non-blocking `autoSolve` after detect) →
`drawPreview` draws the given clue shapes (static layer) + placed shapes and rings
board↔solution diffs (`computePuzzleDiff`, default per-cell) → `applySolution` / Hint
(custom `applyHint`) / Loop write `cellStatus` via `applyLollipopsState`.

## Testing — `tests/lollipops.test.js`

- **Oracle units:** a valid candy+stick pair passes; rejects (a) two adjacent candies,
  (b) a stick with a wrong-orientation/absent candy, (c) a double-connected candy, (d) a
  line-of-sight violation (two equal shapes separated only by empties).
- **Propagation units:** a lone `v`-clue forces a candy directly above/below; line-of-sight
  pruning removes an equal-shape candidate.
- **Soundness gate:** generate random tiny boards — enumerate all `_isValid` full boards
  for the grid, fix a random subset of one as givens, brute-count completions — and assert
  the solver's `solved`/`count` match across ~150–300 boards (enumeration cell-capped, e.g.
  free cells ≤ 11 → 4^11). `0` mismatches required.
- **Real-board solve:** the captured 10×10 (fixture in `tests/fixtures/real-puzzles.js`)
  solves uniquely and oracle-passes.
- **Bench:** `tests/bench-lollipops.js` (`process.exit(1)` on unsolved).

## Validation before planning

Build a throwaway prototype (ported-`getErrors` oracle + solver), brute-force
soundness-gate it on tiny boards, and run the captured real 10×10 confirming a **unique**
solve, before the plan locks. Run the plan's exact test assertions too.

## Out of scope / non-goals

- No reliance on the clue numbers as counts (they are fixed shapes).
- No `taskStatus` "completed" interaction (cosmetic player marking on clue cells); the
  solver/applier only places shapes on free cells.
- Empty cells may be applied as `4` (cross) or left `0` — both serialize to `"n"`; the
  applier writes the solver's value (`4` for empty) to non-clue cells.
