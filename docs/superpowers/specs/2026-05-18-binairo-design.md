# Binairo puzzle support — design spec

**Date:** 2026-05-18
**Status:** Approved, pending implementation plan
**Scope:** Add a fourth puzzle type (Binairo / Takuzu) to the Chrome MV3 extension,
with full feature parity to the existing Nonogram, Aquarium, and Galaxies support.

## Goals

1. Detect Binairo puzzles on `https://www.puzzles-mobile.com/binairo/*` and expose
   the standard widget controls: Solve, Hint, Loop, Dump, Undo/Redo, canvas preview.
2. Implement `BinairoSolver` deductively (no-triples + balance + uniqueness rules),
   with backtracking as a fallback. Cache solutions in a static map keyed by the
   givens signature.
3. Reuse existing infrastructure (worker proxy, hint cache TTL+LRU, two-layer
   preview canvas, loop button) — no architectural new ground.

## Non-goals (v1)

- **Comparison-clue Binairo variant** (the `=`/`≠` markers between adjacent cells).
  The page engine exposes `FLAG_RIGHT_EQ/NE`, `FLAG_DOWN_EQ/NE`, and a
  `comparisonClues` field — the `binairoHandler` will refuse with a clear error if
  `comparisonClues` is non-empty. Adding it later is a localized propagator change.
- **Style-specific preview rendering.** The page can render in `circles`, `squares`,
  `binary` (literal "0"/"1" text), or `tictac` styles. The extension preview always
  uses the `circles` look regardless of the page setting.

## Recon facts (from a live 6x6-easy capture, 2026-05-18)

- **No `var task = '...'` script tag.** The previous nonogram/aquarium parser route
  (`parsePuzzleTask` in `handler.js`) does not apply. Task data lives only on
  `window.Game`.
- **`window.Game.task`** is a 2D `int[height][width]` of *givens*:
  - `-1` = blank (no given)
  - ` 0` = given zero
  - ` 1` = given one
- **`window.Game.currentState.cellStatus`** is a 2D `int[height][width]` of
  *current cell values*:
  - `0` = empty
  - `1` = filled with "one" (black)
  - `2` = filled with "zero" (white)
- **Translation (givens → initial cellStatus):** `-1→0, 0→2, 1→1`.
- **Render ladder:** `Game.saveState(true)` exists; `Game.redraw` exists; no
  `Game.render`. Universal trailer (`Game.getSaved` + `Game.loadGame`) is present.
- **Engine validators present on `Game`:** `check3InARow`, `checkMoreThanAllowed`,
  `checkDuplicates`, `checkComparison`. We do not call them — they are the page's
  own check button. Listed here as confirmation that the rule set matches our
  three deduction rules.
- **DOM root:** `#stage` (not `#game`).
- **Slug confirmation:** `window.Game.slug === 'binairo'`, and there is a
  truthy `window.Game.binairo` field.
- **Sizes seen:** 6x6, 8x8, 10x10, 12x12, 14x14 (and possibly 20x20 — to be
  confirmed at impl time). Even-sided grids only.

## Architecture

### File responsibilities

| File | Change |
| --- | --- |
| `solver.js` | + `class BinairoSolver` (~300 LOC). Pure logic. |
| `solver.worker.js` | + dispatch case `'binairo'`. |
| `content.js` | + `'binairo'` branch in `runSolve`, `applySolveResult`, `drawPreview`, `loopHandler`, hint-cache key derivation. |
| `handler.js` | + `binairoHandler` (priority 30, matches `/binairo/`). |
| `main-world.js` | + `readBinairoData`, `readBinairoState`, `applyBinairoState`. + `'binairo'` branch in `dumpPuzzleForBench`. |
| `background.js` | `EXEC_MAIN_ALLOWLIST` += 3 entries. |
| `globals.d.ts` | `MainWorldFn` union += 3 entries. |
| `tests/fixtures/puzzles.js` | + 2 deterministic Binairo puzzles. |
| `tests/golden.js` | + 2 golden solutions. |
| `tests/solver.test.js` | + Binairo round-trip suite. |
| `tests/binairo-fuzz.test.js` | + rule-validity fuzz (100 seed-stable inputs). |
| `tests/bench-binairo.js` | + perf bench, `process.exit(1)` on unsolved. |
| `tests/fixtures/real-puzzles.js` | + 1–3 real-puzzle entries (added once `dumpPuzzleForBench` is Binairo-aware). |
| `package.json` | + `"bench:binairo"` script. |
| `.github/workflows/bench-nightly.yml` | + `bench:binairo` step (no `continue-on-error`). |

No `manifest.json` change (the existing host permission already covers the path).
No `dist/` source files — `npm run build` regenerates it from the above.

### `BinairoSolver`

**Representation.** Internal grid is `number[][]` using the page's native
`cellStatus` encoding (`0=empty, 1=one, 2=zero`). Constructor signature:

```js
new BinairoSolver({ rows, cols, givens, initialState? })
```

- `givens` is the 2D `Game.task` (`-1/0/1`).
- `initialState` is optional; if absent it is derived from `givens` via the
  translation `-1→0, 0→2, 1→1`. If present (e.g. user has already filled
  some cells) it is taken as-is.

`solve()` returns the solved grid in cellStatus encoding so the MAIN-world
apply path is identity — no translation on write.

**Deduction propagator.** Three rules in a fixed-point loop driven by a
dirty-cell queue (mirrors `GalaxiesSolver._propagate`):

1. **No-triples.** For each empty cell `(r,c)`, if placing value `v ∈ {1,2}`
   would create three-in-a-row in any of the 4 axis-windows that include
   `(r,c)` (positions `c-2,c-1,c` / `c-1,c,c+1` / `c,c+1,c+2` horizontally, and
   analogously vertically), and the other value `3-v` does not, force `3-v`.
2. **Balance.** Each row and column must have exactly `N/2` ones and `N/2`
   zeros. Maintain four `Int32Array(rows)`/`Int32Array(cols)` running counts
   (`rowOnes`, `rowZeros`, `colOnes`, `colZeros`), incremented in `_assign`
   and decremented in `_rollback`. When `rowOnes[r] === N/2`, force every
   empty cell in row `r` to `2`; symmetric for the other three.
3. **Uniqueness.** When a row becomes fully filled, register its bitmask in
   `Set<number> filledRows` (use the natural binary: one→1, zero→0). On any
   row with exactly 2 empty cells, enumerate the 2 candidate completions,
   discard those that violate no-triples or balance or that hit
   `filledRows`. If exactly one candidate survives, force both cells.
   Same logic for columns with `filledCols`. Restricted to "exactly 2 empty"
   for performance — full-row enumeration is bounded but rarely productive
   earlier.

**Backtracking.** If propagation hits a fixed point with empty cells left:

- Pick the empty cell with the lowest sum of `(N/2 - rowOnes[r])` and
  `(N/2 - colOnes[c])` (most-constrained heuristic).
- Try `1` then `2`. Trail-based undo: a flat `Int32Array` of
  `[r, c, prevVal]` triples, plus the count deltas needed to rewind
  `rowOnes`/`rowZeros`/`colOnes`/`colZeros`. Same shape as
  `NonogramSolver`'s `_assign`/`_rollback`.
- Return on first solution. The engine guarantees unique solutions for
  ranked puzzles, but the solver does not assert this.

**Solution cache.** Static `BinairoSolver._solutionCache` keyed on a
canonical givens signature (FNV-1a hash of `rows,cols,task-flattened`).
Bypassed when `initialState` is provided and differs from the
givens-derived state (same rule as `GalaxiesSolver._solutionCache`).
`BinairoSolver.clearSolutionCache()` exists for test order-independence.

**Hint mode.** `getHint(currentState)` returns one of:
- `{ row, col, value, rule }` — first deduction step in rule order
  (no-triples → balance → uniqueness) consistent with `currentState`.
- `{ row, col, value, rule: 'solver-fallback' }` — when propagation is
  exhausted, look up the cached solution; return the first cell that's
  empty in `currentState` and filled in the cached solve. Mirrors the
  aquarium/galaxies hint fallback pattern in `97953e4` and `6638c9c`.
- `null` — input already complete.

**Performance budget.** Solve median <50ms on the largest "hard" size on
puzzles-mobile (size to be confirmed at impl time; assumed 14×14 or 20×20).
Bench fails CI if any captured real puzzle is unsolved.

### `main-world.js` additions

All three functions are serialized via `chrome.scripting.executeScript` and
must therefore (per `CLAUDE.md`) live without outer-scope references and
without dependence on other functions in `main-world.js`.

```
readBinairoData()
  Poll up to ~10s (200 × 50ms) for window.Game?.task && window.Game?.puzzleWidth.
  Return:
    { task:        deepCopy2D(Game.task),
      width:       Game.puzzleWidth,
      height:      Game.puzzleHeight,
      comparisonClues: Array.isArray(Game.comparisonClues) ? Game.comparisonClues : [] }
  Returns null on timeout.

readBinairoState(rows, cols)
  Read window.Game?.currentState?.cellStatus. Return a 2D deep copy validated
  to be rows × cols. Returns null if shape mismatch or undefined.

applyBinairoState(solution2D)
  Returns boolean. Follows the save+render ladder from CLAUDE.md:
    1. Game.saveState(true)   — verified necessary on aquarium engine; assumed
                                necessary here. To be confirmed at impl time;
                                drop if observation proves otherwise.
    2. for (r,c) Game.currentState.cellStatus[r][c] = solution2D[r][c]
    3. Game.redraw()
    4. const saved = Game.getSaved && Game.getSaved();
       if (saved && Game.loadGame) Game.loadGame(saved);
  Returns true on completion, false if window.Game is missing.

dumpPuzzleForBench()  — branch addition
  When Game.slug === 'binairo' (or pathname includes '/binairo/'):
    Emit { type: 'binairo', task: Game.task, cellStatus: Game.currentState.cellStatus,
           width: Game.puzzleWidth, height: Game.puzzleHeight,
           comparisonClues: Game.comparisonClues || [] }.
  Existing diagnostic fallback path is unchanged.
```

### `background.js` and `globals.d.ts`

Append `'readBinairoData'`, `'readBinairoState'`, `'applyBinairoState'` to
`EXEC_MAIN_ALLOWLIST` in `background.js`. Mirror the three names in the
`MainWorldFn` union in `globals.d.ts`. Order in both files: insert after the
existing galaxies entries so the diff is local.

### `handler.js` — `binairoHandler`

```
priority: 30   // above galaxies (25) so any future overlap is unambiguous;
               //  and above the puzzles-mobile catch-all (10).
matches():     isPuzzlesMobilePage() && pathname.includes('/binairo/')

detect():
  const data = await callMainWorld('readBinairoData', []);
  if (!data) return { found: false, error: 'No Binairo task data found' }
  if (data.comparisonClues?.length)
    return { found: false, error: 'Binairo comparison-clue variant not yet supported' }
  const stageEl = document.getElementById('stage') || document.getElementById('game')
  return {
    found: true,
    type: 'binairo',
    rows: data.height,
    cols: data.width,
    givens: data.task,
    _cells: [],
    _element: stageEl,
  }

readState(ctx):
  return await callMainWorld('readBinairoState', [ctx.rows, ctx.cols])
       || Array.from({ length: ctx.rows }, () => Array(ctx.cols).fill(0));

applySolution(solution, _ctx):
  const ok = await callMainWorld('applyBinairoState', [solution]);
  return ok
    ? { success: true }
    : { success: false, error: 'Binairo apply failed (no window.Game or MAIN-world timeout)' };
```

No Node export (no parser to test in isolation).

### `content.js` widget integration

**`runSolve`:**

```js
case 'binairo':
  return {
    type: 'binairo',
    solution: await solverWorker.solve('binairo', { rows, cols, givens }),
  };
```

**Hint cache key:** namespace `puzzle-solver:hint:binairo:<sig>`, where `sig` is
`fnv1a(rows + 'x' + cols + ':' + JSON.stringify(givens))`. Same 7-day TTL +
50-entry LRU store landed in `5e6e6ed`.

**Loop button:** one forced cell per tick using `BinairoSolver.getHint`, 300ms
inter-step sleep cancellable via `stopLoopWait`. Same shape as the galaxies
loop.

**`drawPreview` (canvas):**
- **`latticeLayer`** (cached) — grey grid lines, identical to other types.
- **`staticLayer`** (cached) — for binairo: a tiny corner-tab on each given
  cell (those where `givens[r][c] !== -1`), so the user can distinguish
  puzzle-supplied givens from solved cells.
- **Dynamic per-tick fills** (between latticeLayer and staticLayer per the
  existing two-layer cache order):
  - `cellStatus === 1` (one/black): filled disc, radius `0.35 * cellSize`,
    fill `#222`.
  - `cellStatus === 2` (zero/white): hollow disc, same radius, stroke `#222`
    width 2, fill `#fff`.
  - `cellStatus === 0`: nothing.
- No X-mark Path2D. The FNV-1a `gridDataSig` early-bail and 200ms tick are
  unchanged.

### Tests, fixtures, benches

`tests/fixtures/puzzles.js` gets two deterministic Binairo entries (one
6x6-easy from the captured fixture, one larger size — 10x10 or 12x12 — to
exercise non-trivial deduction). `tests/golden.js` gets matching solution
snapshots. `npm run capture` regenerates these.

`tests/solver.test.js` gets a `BinairoSolver solves fixture puzzles` suite
that round-trips fixture → solve → golden compare.

`tests/binairo-fuzz.test.js` generates 100 seed-stable random givens (well-
formed: even sizes, ≤ N/2 of each value pre-placed per row/col) and asserts
that `BinairoSolver().solve()` returns a grid satisfying all three rules over
every row and column.

`tests/bench-binairo.js` mirrors `tests/bench-aquarium.js`: 2 warmup
iterations discarded, `process.exit(1)` on any unsolved fixture.

`tests/fixtures/real-puzzles.js` adds 1–3 real-puzzle Binairo entries
captured via the Dump button **after** `dumpPuzzleForBench` learns the
`binairo` branch. The impl plan should sequence the dumper change before
the bench fixture capture.

`package.json` gets `"bench:binairo": "node tests/bench-binairo.js"`. The
nightly workflow gets a `bench:binairo` step, no `continue-on-error`.

`tests/handler-parsers.test.js` is **unchanged** — no parser to test (task
arrives as a 2D array, not a string).

## Data flow (solve, end-to-end)

1. User opens `puzzles-mobile.com/binairo/random/6x6-easy`.
2. Content script loads. `binairoHandler.matches()` returns true.
3. User clicks Solve in the widget.
4. `runSolve` → handler.detect → `callMainWorld('readBinairoData')` → SW dispatches
   `chrome.scripting.executeScript({world:'MAIN', func: readBinairoData})` → returns
   `{ task, width, height, comparisonClues:[] }`.
5. `runSolve` posts `{type:'binairo', rows, cols, givens}` to the Blob-built
   worker.
6. Worker constructs `BinairoSolver`, runs propagator + (rarely) backtrack,
   returns the solved cellStatus grid.
7. `applySolveResult` caches the solution (hint cache + UI confirm-mode), draws
   the preview.
8. User clicks Apply → `handler.applySolution(solution)` →
   `callMainWorld('applyBinairoState', [solution])` → SW runs the save+render
   ladder in MAIN world → page reflects the solved board.

## Error paths

- `readBinairoData` timeout → handler `detect()` returns `{ found: false, error: 'No Binairo task data found' }`. Widget shows the error in the status node.
- Comparison-variant detected → handler returns `{ found: false, error: 'Binairo comparison-clue variant not yet supported' }`. Widget shows the error.
- Solver returns no solution → `applySolveResult` shows "No solution found" status (same path as nonogram/galaxies). Bench fails CI.
- MAIN-world apply returns false → widget shows "Binairo apply failed" status. No DOM-click fallback exists (no `_cells` array on this handler — the page is canvas-rendered, not DOM-grid-rendered).

## Implementation phasing (suggested for the plan)

1. **Recon-confirm phase.** Capture one more live puzzle (8x8 or 10x10) by
   updating `dumpPuzzleForBench` to recognize Binairo. Confirms the cellStatus
   encoding holds at non-6x6 sizes.
2. **Solver + tests.** `BinairoSolver` in `solver.js` + worker dispatch + the
   two test files. No browser dependency — fully Node-runnable.
3. **MAIN-world + handler.** `main-world.js` additions, `background.js`
   allowlist, `globals.d.ts` mirror, `binairoHandler`. Manual verification on
   the live 6x6 puzzle confirms the `saveState(true)` requirement (drop the
   call if redraw alone updates the board correctly).
4. **Widget + preview.** `content.js` routing, hint cache key, loop dispatch,
   canvas preview render mode.
5. **Bench + CI.** `bench-binairo.js`, package.json script, nightly workflow.
6. **CLAUDE.md update.** Add Binairo to the puzzle-type list and document the
   `task`-vs-`cellStatus` encoding difference (it's a non-obvious gotcha that
   future readers will hit).

## Open assumptions to verify at impl time

1. **`Game.saveState(true)` necessity.** Verified necessary on the aquarium
   engine (per the bug fix in `7df9fa5`). Assumed necessary here on the same
   grounds. First manual verification step is to apply with and without the
   call; drop if not needed.
2. **DOM root selector.** Recon showed `#stage`; we default to
   `#stage || #game`. If neither exists on some sizes, the handler still
   works (it doesn't depend on `_element` for read/apply — only for the
   widget anchor).
3. **Largest hard size.** Assumed 14×14 or 20×20; the bench will use whatever
   sizes are captured.

## Out of scope (deferred)

- Comparison-clue Binairo variant.
- Other Binairo-style modes on the site that might exist (e.g. "Triku" /
  3-value variants). The handler `matches()` is path-scoped to `/binairo/` so
  these won't accidentally trigger.
