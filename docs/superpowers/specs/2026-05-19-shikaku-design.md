# Shikaku puzzle support — design spec

**Date:** 2026-05-19
**Status:** Approved, pending implementation plan
**Scope:** Add Shikaku as the sixth supported puzzle type on
`puzzles-mobile.com/shikaku/*` with full feature parity to the existing
puzzle types (Solve, Hint, Loop, Dump, Undo/Redo, canvas preview,
localStorage hint cache).

## Goals

1. Detect Shikaku puzzles on `/shikaku/*` and expose the standard widget
   controls.
2. Implement a `ShikakuSolver` class (per-clue rectangle enumeration +
   propagation + most-constrained backtracking).
3. Render the partitioned rectangles on the preview canvas, with clue
   numbers overlaid at clue cells.
4. Update the "Supported puzzles" list shown on the homepage.

## Non-goals

- A second solver class. The shared `BinairoSolver` pattern doesn't help
  here — Shikaku's geometry is fundamentally different from cell-state
  puzzles.
- Any rule variants. The page's `/shikaku/` path covers a single rule
  set; no `/shikaku-plus/` or comparison-clue variant exists today.

## Recon facts (from a live 5×5 capture, 2026-05-19)

- **URL:** `https://www.puzzles-mobile.com/shikaku/random/5x5`.
- **`Game.slug === 'shikaku'`**.
- **`Game.task`** is a `rows × cols` 2D array of integers. Non-zero cells
  are clues; the value is the area of the rectangle that must contain
  that cell. Zero cells are non-clue cells.
- **`Game.currentState.cellStatus`** is `rows × cols` of int. Currently
  all `-1` (unassigned). Populated cells hold the index of the rectangle
  (area) they belong to once the user draws.
- **`Game.currentState.areas`** holds the user's drawn rectangles. Exact
  field shape is captured at impl time via a follow-up Dump after one
  rectangle is drawn on the live page; design assumes an array indexed
  by area id with at minimum a `cellList: [{r, c}, ...]` field.
- **Render functions:** `redraw`, `drawCurrentState`, `check`.
- **`Game.saveState`** exists. Engine-specific helpers visible:
  `extendArea`, `shrinkArea`, `removeArea`, `drawRect`, `areaHasErrors`,
  `serializeShikakuColorState`, `loadShikakuColorState`.
- **DOM root:** `#stage` with `style-modern` / `style-classic` mode CSS.

## Architecture

### File responsibilities

| Status | File | Change |
| --- | --- | --- |
| Modify | `solver.js` | + `class ShikakuSolver` (~250 LOC): candidate-rectangle enumeration, propagation rules, backtracking, static `_solutionCache`. |
| Modify | `solver.worker.js` | + `case 'shikaku'` dispatch. |
| Modify | `content.js` | + `'shikaku'` branches in `solveExtraData`, `getHint`, `drawPreview`, hint cache; `SUPPORTED_PUZZLES` entry; `shikakuHintStatusNodes` helper. |
| Modify | `handler.js` | + `shikakuHandler` (priority 30, matches `/shikaku/`). |
| Modify | `main-world.js` | + `readShikakuData`, `readShikakuState`, `applyShikakuState`. + `/shikaku/` branch in `dumpPuzzleForBench`. |
| Modify | `background.js` | `EXEC_MAIN_ALLOWLIST` += 3 entries. |
| Modify | `globals.d.ts` | `MainWorldFn` union += 3 entries; ambient `ShikakuSolver` declare. |
| Modify | `eslint.config.js` | + `ShikakuSolver: 'readonly'` in solver-globals. |
| Modify | `tests/fixtures/puzzles.js` | + `shikaku5x5` fixture (the captured puzzle). |
| Modify | `tests/capture.js` | + `solveShikaku` + entry in `raw` map. |
| Modify | `tests/golden.js` | Regenerated. |
| Modify | `tests/solver.test.js` | + ShikakuSolver suite (constructor, candidate enumeration, propagation, backtracking, cache). |
| Create | `tests/shikaku-fuzz.test.js` | Constructive partition-based fuzz. |
| Modify | `tests/fixtures/real-puzzles.js` | + `shikakuReal5x5_a`. |
| Create | `tests/bench-shikaku.js` | Per-fixture perf bench, `process.exit(1)` on unsolved. |
| Modify | `package.json` | + `bench:shikaku` script. |
| Modify | `.github/workflows/bench-nightly.yml` | + `bench:shikaku` step. |
| Modify | `CLAUDE.md` | Top description + file row + new "Shikaku encoding" subsection. |

No `manifest.json` change (host permission covers the path).

### `ShikakuSolver`

**Constructor.**

```js
new ShikakuSolver({ rows, cols, clues, initialState? })
```

- `clues`: `Array<{ row, col, area }>`. Order doesn't matter; clue index
  is the array index after construction.
- `initialState`: optional `Int16Array(rows*cols)` of cell ownership
  (`-1` for unassigned, otherwise the clue index that owns the cell).
- Validates `sum(clue.area) === rows * cols`; otherwise throws.
- Precomputes `this.candidates: Array<Array<Rect>>` — for each clue, the
  list of axis-aligned rectangles that contain the clue's cell, have
  the right area, and don't contain any other clue cell.

**Internal state.**

- `this.owner: Int16Array(rows * cols)` — cell ownership, `-1` if unassigned.
- `this.candidates: Rect[][]` — pruned per clue.
- `this.placed: Uint8Array(clues.length)` — `1` if the clue's rectangle has been placed.
- `this.trail: number[]` — flat undo log packing `(cell-index, prev-owner)`
  for `_assign`/`_rollback`, plus markers for candidate-pruning frames.

**Candidate enumeration** (one-time at construction):

For each clue `(r, c, area)`:
- Factorize `area` into `(w, h)` pairs with `w * h === area`.
- For each `(w, h)`, slide a `w × h` rectangle so it contains `(r, c)`:
  `r1 ∈ [r - h + 1, r]`, `c1 ∈ [c - w + 1, c]`.
- Skip rectangles where any other clue cell lies inside.
- Skip rectangles that don't fit in the grid.

Stored as `{r1, c1, r2, c2}` (inclusive corners).

**Propagation rules** (fixed-point loop):

1. **Zero-candidate detection.** If any unplaced clue has
   `candidates.length === 0` → contradiction.
2. **Single-candidate forcing.** Clue with exactly one remaining candidate:
   place that rectangle (mark every cell, prune overlapping candidates of
   other clues).
3. **Single-coverer cell.** For each unassigned cell, count the unplaced
   clues whose candidates cover it. If zero → contradiction. If only one
   clue's candidates can cover it, prune the OTHER clues' candidates that
   include the cell — they're now infeasible.
4. **Rectangle-fit elimination.** When a rectangle is placed, prune every
   candidate of every other clue that overlaps any of those cells.

The rules cascade — placing one rectangle removes candidates from many
clues, which can in turn produce new single-candidate forces.

**Backtracking.** When propagation reaches fixed point with unplaced
clues remaining:
- Pick the unplaced clue with the fewest remaining candidates (MRV).
- Try each candidate; trail-based undo on failure.
- Recurse.

Trail entries packed compactly; rollback restores `owner`, `placed`, and
`candidates` to the pre-branch state.

**`solve()`** returns `{ solved, grid, error? }`. On success, `grid` is a
2D `Int16Array` per row (or 2D regular array) of cell ownership. Worker
dispatch + handler apply both treat this as opaque ownership values.

**`getHint(currentGrid)`.** Mirrors the binairo design:
1. Clone solver state with `initialState = currentGrid`.
2. Run propagation to fixed point with `clone._depth = 1` (suppress
   lookahead).
3. Collect every cell whose ownership transitioned from `-1` to some
   index.
4. If nothing changed, run one pass of "for each unplaced clue, probe
   each candidate, propagate to fixed point, check for contradiction":
   forward-checking lookahead. Force any clue whose only surviving
   candidate is unambiguous after this pass.
5. Return `{ type: 'cell-list', cells: [{row, col, value: ownerIndex}, ...] }`
   or null.

`puzzleData.type === 'shikaku'`, hint shape distinguishable from the
row-anchored hints used by other puzzle types — `setHintStatus` gains
a `shikaku` branch.

**Static cache.** `ShikakuSolver._solutionCache: Map<string, grid>` keyed on
FNV-1a of `(rows, cols, clues-sorted)`. 50-entry LRU. Bypassed when
`initialState` differs from "all -1" (i.e., the user has already
partially solved). `ShikakuSolver.clearSolutionCache()` for tests.

### Handler

```js
const shikakuHandler = {
  name: 'puzzles-mobile-shikaku',
  priority: 30,
  matches() { return isPuzzlesMobilePage() && pathname.includes('/shikaku/'); },
  async detect() {
    const data = await callMainWorld('readShikakuData', []);
    if (!data) return { found: false, error: 'No Shikaku task data found' };
    const clues = [];
    for (let r = 0; r < data.height; r++) {
      for (let c = 0; c < data.width; c++) {
        const v = data.task[r]?.[c];
        if (typeof v === 'number' && v > 0) clues.push({ row: r, col: c, area: v });
      }
    }
    const sumAreas = clues.reduce((s, x) => s + x.area, 0);
    const gridArea = data.width * data.height;
    if (sumAreas !== gridArea) {
      return { found: false, error: `Clue areas sum to ${sumAreas} but grid is ${gridArea}` };
    }
    return {
      found: true, type: 'shikaku',
      rows: data.height, cols: data.width,
      clues, _cells: [], _element: stageEl,
    };
  },
  async readState(ctx) { return await callMainWorld('readShikakuState', [ctx.rows, ctx.cols]); },
  async applySolution(solution, ctx) {
    const ok = await callMainWorld('applyShikakuState', [solution, ctx.clues]);
    return ok ? { success: true } : { success: false, error: 'Shikaku apply failed' };
  },
};
```

### MAIN-world functions

`readShikakuData()` — polls `Game.task` until populated (10 s timeout).
Returns `{ task, width, height }`.

`readShikakuState(rows, cols)` — returns `Game.currentState.cellStatus`
trimmed to `rows × cols`, as a 2D array of int.

`applyShikakuState(solution, clues)` — follows the save+render ladder:
1. `Game.saveState(true)`.
2. Write each `solution[r][c]` into `currentState.cellStatus[r][c]`.
3. Construct `currentState.areas` from `solution + clues`. **Exact field
   names confirmed at impl time** via a follow-up Dump after one
   rectangle is drawn on the live page; design assumes:

   ```js
   areas = [
     { id, color, cellList: [{ r, c }, ...] },  // one per clue
   ];
   ```

   Plus possibly `currentState.areaColors`. The TODO is to capture the
   real shape during the first MAIN-world implementation step.
4. Call `Game.drawCurrentState()` if present, else `redraw`, else
   `getSaved + loadGame` (same fallback as the other types).

Returns boolean.

`dumpPuzzleForBench` gains a `/shikaku/` branch returning
`{ type: 'shikaku', rows, cols, clues, path }`.

### Background + types

`EXEC_MAIN_ALLOWLIST` += `'readShikakuData', 'readShikakuState', 'applyShikakuState'`.
`MainWorldFn` union in `globals.d.ts` mirrors. Ambient `declare const ShikakuSolver: any;`
added alongside the other solver declares. `eslint.config.js` `solverClasses`
globals + `ShikakuSolver: 'readonly'`.

### content.js wiring

`solveExtraData('shikaku')` returns `{ rows, cols, clues }`.

`shikakuCacheKey(data)` — FNV-1a over `rows`, `cols`, and the sorted clue
list. Key prefix `'shikaku-solution:'`. Added to
`SOLUTION_KEY_PREFIXES` so the LRU + TTL cleanup picks it up.

`getCachedGridSolution` / `cacheGridSolution` / `recordSolveSuccess`
ternary chains gain a `'shikaku'` arm.

`getHint`'s shikaku branch follows the binairo pattern: local rules to
fixed point, then forward-checking lookahead fallback, then "No more
cells can be deduced — click Solve."

`setHintStatus` dispatches `'shikaku'` to `shikakuHintStatusNodes` —
prints e.g. *"3 cells belong to clue at **(row 2, col 3)** = **4**"* using
the same `bold()`-based pattern as `binairoHintStatusNodes`.

### Canvas preview

`drawPreview` cell-paint:
- Each cell colored by `pd.colorPalette[owner]` (use the existing
  `galaxiesColors` palette).
- Cells with `owner === -1` (unassigned) painted white.

`buildStaticLayer` for shikaku:
- Thick black borders between cells of different owners (palette-aware).
- Clue numbers rendered as bold text overlays at each clue cell.

`staticSig` extended with `|cl=<clueHash>` so the cached static layer
rebuilds when the clue set changes.

`SUPPORTED_PUZZLES` += Shikaku entry.

## Data flow (Solve, end-to-end)

1. User opens `puzzles-mobile.com/shikaku/random/5x5`.
2. `shikakuHandler.matches()` returns true; widget renders.
3. User clicks Solve.
4. `runSolve` → `handler.detect` → `callMainWorld('readShikakuData')`.
5. `solveExtraData` packages `{ rows, cols, clues }`; worker dispatches to
   `new ShikakuSolver(...).solve()`.
6. Returned `grid` (cell-ownership 2D) caches + drives preview.
7. Apply → `applyShikakuState(grid, clues)` writes `cellStatus` + `areas`,
   calls `drawCurrentState` → board reflects the solved partition.

Hint flow follows the same pipeline with `getHint` returning the
forced-cell list.

## Tests, fixtures, benches

`tests/fixtures/puzzles.js` gets `shikaku5x5` (the captured puzzle's
9 clues). `tests/capture.js` adds `solveShikaku` + raw entry; `npm run
capture` regenerates `tests/golden.js`.

`tests/solver.test.js` adds:
- Constructor validates clue-sum vs grid area.
- Candidate enumeration count on a hand-built case.
- Single-candidate forcing fires.
- Zero-candidate state → propagate returns false.
- 5×5 fixture solves + matches golden.
- Static cache returns prior solve on identical clues.

`tests/shikaku-fuzz.test.js` does constructive partition trials at
5×5 / 7×7 / 10×10 — split the grid into random rectangles via BSP,
pick a clue cell per rectangle, assert solver finds a valid partition
matching all clue areas.

`tests/fixtures/real-puzzles.js` gets `shikakuReal5x5_a`. The user can
add 10×10 / 15×15 entries after the Shikaku-aware Dump button lands.

`tests/bench-shikaku.js` iterates `type === 'shikaku'` entries; 2 warmup
+ 11 timed runs each; `process.exit(1)` if any reports `solved: false`.

`package.json` += `"bench:shikaku": "node tests/bench-shikaku.js"`.
Nightly workflow += `node tests/bench-shikaku.js` step.

## Error paths

- `readShikakuData` timeout → handler returns `error: 'No Shikaku task data found'`.
- Clue-area sum mismatch → handler refuses with explicit error before
  even calling the solver.
- Solver returns `solved: false` → widget shows "No solution found".
- Apply path returns false → "Shikaku apply failed". No DOM-click
  fallback (the page is canvas-rendered, not DOM-grid-rendered).

## Implementation phasing (suggested)

1. **Solver:** clue/candidate enumeration, propagation rules, backtracking,
   tests. No browser dependency — fully Node-runnable.
2. **Worker + handler:** thread shikaku through worker dispatch and detect.
3. **MAIN-world:** read/state/apply functions. First step verifies the
   `currentState.areas` shape via a follow-up Dump on the live page.
4. **content.js:** runSolve wiring, hint cache, hint branch.
5. **Preview canvas:** colored rectangles + clue numbers + borders.
6. **Fuzz + bench + CI:** comparison-clue analog of the binairo fuzz.
7. **Dump branch:** Shikaku-aware fixture capture.
8. **CLAUDE.md:** new subsection + file-row updates.

## Open assumptions to verify at impl time

1. **`currentState.areas` shape.** Recon couldn't capture a populated
   `areas` array; design assumes `[{ id, color, cellList }]` but the
   real field names are TBD. First MAIN-world implementation step is to
   draw a single rectangle on the live page, dump, paste, lock the
   shape, and adjust `applyShikakuState`.
2. **`Game.saveState(true)` necessity.** Assumed by analogy with
   aquarium/binairo. First live verification toggles it on/off to
   confirm.
3. **Available puzzle sizes.** Recon shows 5×5; site likely has 10×10
   and 15×15 too. Bench fixtures captured as those sizes appear; design
   doesn't constrain them.

## Out of scope (deferred)

- Animated rendering of incremental Hint placements.
- A "verify rectangles" pre-pass before Solve that checks whether the
  user's partial state contradicts the clues. The existing
  `firstMismatch`-style check in `getHint` covers this generically for
  cell-state puzzles but doesn't translate directly to ownership-state
  puzzles like Shikaku. Punt until a real issue surfaces.
