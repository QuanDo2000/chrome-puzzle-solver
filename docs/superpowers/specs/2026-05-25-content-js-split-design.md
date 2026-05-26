# `content.js` per-puzzle split (registry pattern) — design

Date: 2026-05-25
Status: approved

Refactors the 4,674-line `content.js` content-script monolith into a
shared widget shell plus 15 per-puzzle modules under `src/widget/`,
following a registry pattern. Every place that branches on
`puzzleData.type` (~60 conditional sites) becomes a table lookup into
the registry.

Same spirit as the `solver.js` split that just shipped, but a deeper
refactor — content.js isn't just 15 classes in one file; it weaves
per-puzzle code through a single `makeWidget()` closure of ~2,800
lines. We straighten that out by giving each puzzle a focused module
and migrating one puzzle at a time.

## 1. Goal

- Cut per-puzzle iteration cost: adding a puzzle now means creating
  one new file under `src/widget/puzzles/` and adding it to the
  registry index, rather than touching ~10 different sites in
  `content.js`.
- Make every per-puzzle code path discoverable from one location.
- Preserve runtime: the extension keeps loading a single concatenated
  `dist/content.js` produced by a build script. No bundler dependency.
- Tests pass at every commit during the migration; nothing batches.

## 2. File layout

```
src/widget/
  state.js                 top-level shared state (undoStack, mutatingOp,
                           suppressStateWatch, solverPending, etc.)
  worker.js                getSolverWorker + runSolve (worker proxy)
  cache.js                 localStorage solution & partial cache
                           (pruneSolutionCache, isFreshSolutionEntry,
                            getCachedGridSolution, cacheGridSolution,
                            puzzlePartialKey, getCachedPartial,
                            cachePartial, clearPartial, chooseInitialGrid)
  galaxies-hint.js         Galaxies hint solver (~600 LOC; stays whole)
  hint.js                  Shared hint helpers (hintAbsoluteCells,
                           applyHintToGrid, addAquariumRegionHints,
                           hintFromCellChunk, nextChunkHint)
  preview.js               drawPreview shell, buildLatticeLayer,
                           buildStaticLayer, draw*On helpers
  widget.js                makeWidget shell: DOM construction,
                           Solve/Hint/Loop button handlers, status
                           text, lifecycle (pagehide / pageshow)
  puzzles/
    index.js               Registry: { type: module } map + exports
                           PUZZLES, SOLUTION_KEY_PREFIXES,
                           SUPPORTED_PUZZLES arrays
    aquarium.js            One module per puzzle. 15 files total.
    binairo.js
    galaxies.js
    hashi.js
    heyawake.js
    hitori.js
    kakurasu.js
    kurodoko.js
    mosaic.js
    nonogram.js
    norinori.js
    nurikabe.js
    shikaku.js
    slitherlink.js
    yinyang.js

scripts/
  build-content-bundle.js  Sibling of build-solver-bundle.js. Reads
                           src/widget/**/*.js in dependency order and
                           writes dist/content.js.

content.js                 1-line require shim → src/widget/widget.js
                           (analogous to solver.js shim)
```

## 3. Per-puzzle module interface

Each `src/widget/puzzles/<type>.js` exports a single object with this
shape. Every field is optional except `type`. The shared dispatchers
in `widget.js` / `preview.js` / `cache.js` call into these hooks via
the registry — missing hooks mean "this puzzle has nothing to do for
this concern".

```js
'use strict';

module.exports = {
  // Identity
  type: 'nurikabe',                   // string key in PUZZLES registry
  label: 'Nurikabe',                  // displayed in SUPPORTED_PUZZLES list
  url: 'https://www.puzzles-mobile.com/nurikabe/',
  solutionKeyPrefix: 'nurikabe-solution:',

  // Cache + signatures
  cacheKey(data),                     // → 'nurikabe-solution:hash' or null
  staticSig(data),                    // → 'nu=hash' segment, joined by '|'
  solveExtraData(data),               // → { rows, cols, ...puzzle-specific }

  // Hint
  hintStatusNodes(hint, helpers),     // → DOM nodes; helpers = { bold }
  hintDispatch(args),                 // args: { boardState, detectedGrid,
                                      //         rows, cols, solution,
                                      //         firstMismatch, getCached }
                                      // → hint object or { error } or null
  loopDoneCheck(args),                // args: { boardState, solution,
                                      //         puzzleData }
                                      // → boolean (true = puzzle done)
  partialResultArm(result, ctx),      // optional; ctx has applyPartial fns

  // Preview rendering
  drawPreviewCell(ctx, args),         // args: { r, c, v, taskVal, x, y,
                                      //         cellW, cellH, hint,
                                      //         puzzleData, isSlitherlink,
                                      //         xPad, ... }
                                      // ctx is CanvasRenderingContext2D
  drawHintRing(ctx, args),            // optional; args: { cell, cx, cy,
                                      //                   cellSize }
  drawStaticLayer(ctx, args),         // optional; args: { rows, cols,
                                      //                   cellSize, w, h,
                                      //                   pd }
                                      // For things like region borders,
                                      // clue numbers baked into the
                                      // static layer.
  customLattice,                      // optional bool. If true →
                                      // drawLattice(...) is called
                                      // instead of the default grid.
  drawLattice(ctx, args),             // optional; args same as draw*Layer.
                                      // Nurikabe uses this for walls.

  // Flags
  skipAutoSolveGate,                  // optional bool. Currently true for
                                      // slitherlink/hashi/heyawake/hitori/
                                      // kakurasu/kurodoko/mosaic/norinori/
                                      // nurikabe.
  hintBandSkip,                       // optional bool. If true, the hint
                                      // overlay's row/column band is
                                      // skipped (cell-state puzzles).
};
```

Hooks are pure (no DOM access via `document`, no `window` access — the
widget shell provides whatever context they need via `args` or
`helpers` bags). Each hook is therefore unit-testable in isolation.

## 4. Shared infrastructure files

### `src/widget/state.js`

Hoists the top-of-file `let detectedGrid`, undoStack/redoStack,
mutatingOp, suppressStateWatch, solverPending into module scope.
Exposes `getState()` / `mutateState()` accessors.

Pure state container. No DOM access. ~80 LOC.

### `src/widget/worker.js`

`getSolverWorker()` (the inline-blob worker trick from CLAUDE.md
"MV3 Worker cross-origin gotcha") plus `runSolve(rowClues, colClues,
initialGrid, solverType, extraData)`. Exports both.

Imports `chrome.runtime.getURL` from `chrome` (global), not refactored.
~100 LOC.

### `src/widget/cache.js`

All localStorage cache machinery. The per-puzzle `cacheKey()` arrives
via `PUZZLES[type].cacheKey(data)`. The 15-way switch in
`getCachedGridSolution` / `cacheGridSolution` collapses to a table
lookup.

`SOLUTION_KEY_PREFIXES` is now derived from
`Object.values(PUZZLES).map(p => p.solutionKeyPrefix).filter(Boolean)`.

~250 LOC.

### `src/widget/galaxies-hint.js`

The Galaxies-specific hint solver (lines 234-902 of current content.js
— `getGalaxiesHint`, `nextGalaxyHint`, `getGalaxiesComponents`,
`propagateAllConstraints`, etc.). Galaxies needs its own constraint
propagation for hints; it's too specialized to fold into a generic
`hintDispatch`. The `puzzles/galaxies.js` module wraps this by
`hintDispatch: (args) => getGalaxiesHint(args.boardState, args.stars)`.

~670 LOC. Stays whole.

### `src/widget/hint.js`

Shared hint helpers used by multiple puzzles' `hintDispatch`:
`hintAbsoluteCells(hint)`, `applyHintToGrid(grid, hint)`,
`addAquariumRegionHints(...)`, `hintFromCellChunk`, `nextChunkHint`.

~400 LOC.

### `src/widget/preview.js`

The `drawPreview` shell — the canvas-allocation, dirty-sig tracking,
two-layer cache (lattice + static), and the outer per-cell render
loop. Replaces all per-puzzle `if (isNurikabe) { ... }` arms with a
single line:

```js
PUZZLES[pd.type]?.drawPreviewCell?.(ctx, args);
```

Also exports `buildLatticeLayer` (default + per-puzzle override via
`customLattice`) and `buildStaticLayer`. The static-layer builder
calls `PUZZLES[pd.type]?.drawStaticLayer?.(ctx, args)`.

Per-puzzle helpers that were inline (drawComparisonCluesOn,
drawShikakuCluesOn, drawHashiIslandsOn, drawHeyawakeRoomsOn,
drawRegionBordersOn, drawNonogramGuidesOn) move into their respective
`puzzles/*.js` files. Generic helpers (gridDataSig) stay in
preview.js.

~800 LOC (was ~1,000 inline).

### `src/widget/widget.js`

The remaining shell: `makeWidget()` + DOM construction + Solve / Hint
/ Loop / Stop / Undo / Redo button handlers + status text +
`setStatusNodes`, `setHintStatus`, `setStatus` + lifecycle (pagehide,
pageshow, detectHandler).

`solveHandler`, `hintHandler`, `loopHandler` delegate to registry
hooks for puzzle-specific logic. They become small switchboards
instead of giant switch statements.

~900 LOC (was ~2,800 inside makeWidget).

### `src/widget/puzzles/index.js`

```js
'use strict';

const aquarium = require('./aquarium.js');
const binairo = require('./binairo.js');
// ... 13 more ...
const yinyang = require('./yinyang.js');

const PUZZLES = {
  [aquarium.type]: aquarium,
  [binairo.type]: binairo,
  // ... 13 more ...
  [yinyang.type]: yinyang,
};

const SOLUTION_KEY_PREFIXES = Object.values(PUZZLES)
  .map(p => p.solutionKeyPrefix)
  .filter(Boolean);

const SUPPORTED_PUZZLES = Object.values(PUZZLES)
  .map(p => ({ name: p.label, url: p.url }))
  .sort((a, b) => a.name.localeCompare(b.name));

module.exports = { PUZZLES, SOLUTION_KEY_PREFIXES, SUPPORTED_PUZZLES };
```

## 5. drawPreview refactor

The hardest part. Current drawPreview is ~700 LOC of nested loops
with per-puzzle arms. The refactor:

```js
function drawPreview(grid, hint) {
  // shared setup: cellSize, latticeLayer, staticLayer (with sig cache)
  // shared loop:
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = grid[r][c];
      const args = {
        r, c, v,
        taskVal: pd.task?.[r]?.[c],
        x: c * cellSize, y: r * cellSize,
        cellW: cellSize, cellH: cellSize,
        hint, puzzleData: pd, isSlitherlink: pd.type === 'slitherlink',
        xPad, ctx,
      };
      PUZZLES[pd.type]?.drawPreviewCell?.(ctx, args);
    }
  }
  // shared hint-band overlay (with per-puzzle hintBandSkip flag)
  // shared per-cell hint ring (with per-puzzle drawHintRing hook)
}
```

Per-puzzle `drawPreviewCell` is the per-cell visual: `cellStatus === 1
→ filled black inset`, `=== 2 → white tint`, etc. Each file's
implementation is ~30-100 LOC of focused canvas calls. No more
`isShikaku && !isBinairo && ...` boolean tangle.

## 6. Bundling

### `scripts/build-content-bundle.js`

Mirrors `build-solver-bundle.js`. Reads:

1. `src/widget/state.js`
2. `src/widget/worker.js`
3. `src/widget/cache.js`
4. `src/widget/galaxies-hint.js`
5. `src/widget/hint.js`
6. `src/widget/puzzles/*.js` (all 15, alphabetical)
7. `src/widget/puzzles/index.js`
8. `src/widget/preview.js`
9. `src/widget/widget.js`

Order matters: each later file may reference symbols from earlier
ones. The script strips per-file `if (typeof module !== 'undefined' ...)`
export blocks, concatenates, appends one combined export block, writes
`dist/content.js`. Same regex anchor as the solver bundler.

`package.json`'s `build` script gains a second `node scripts/...`
invocation. `cp content.js dist/` is removed (it's now generated).

### Root `content.js` shim

After the migration:

```js
'use strict';
module.exports = require('./src/widget/widget.js');
```

Mirrors `solver.js`. Test imports (`require('../content.js')`) keep
working through the shim.

## 7. Migration strategy

The risk of doing this all in one commit is high — content.js touches
every code path the widget exercises. Migrate incrementally:

### Phase 1: Build infrastructure (no puzzle migrated yet)

1. Create `src/widget/` and `src/widget/puzzles/` directories.
2. Add empty registry `puzzles/index.js` returning `{ PUZZLES: {} }`.
3. Extract shared utilities: `state.js`, `worker.js`, `cache.js`,
   `hint.js`, `galaxies-hint.js` — purely mechanical moves of
   already-isolated functions. Tests pass.
4. Add `scripts/build-content-bundle.js` and wire into `npm run build`.
   `dist/content.js` initially identical to a `cp content.js dist/`
   would have produced (no per-puzzle modules registered yet).

### Phase 2: Wire dispatchers with registry-first fallback

Every dispatcher in widget.js / preview.js / cache.js checks the
registry first; if the puzzle is registered, delegate; otherwise fall
back to the existing inline switch arm. This means we can register
puzzles one at a time and each registration removes one switch arm.

Pseudocode:

```js
function cacheKey(data) {
  const reg = PUZZLES[data.type];
  if (reg?.cacheKey) return reg.cacheKey(data);
  // ─── fallback: existing inline switch ───
  return data?.type === 'aquarium' ? aquariumCacheKey(data) : ...;
}
```

### Phase 3: Migrate one puzzle per commit

For each of the 15 puzzles (in any order — we'll start with
Nonogram as it's simplest):

1. Create `src/widget/puzzles/<type>.js` with all the puzzle's
   bits — cacheKey, sig, solveExtraData, drawPreviewCell,
   hintStatusNodes, hintDispatch, loopDoneCheck.
2. Register it in `puzzles/index.js`.
3. Delete the puzzle's inline branches from every dispatcher (the
   fallback was making them dead code anyway).
4. Run `npm test` — must stay green.
5. Run `npm run build` and manually smoke-test the puzzle in the
   browser.
6. Commit.

15 commits, one per puzzle. Each adds ~150-300 LOC in the puzzle
module and removes a similar amount from the inline branches.

### Phase 4: Remove fallback paths

Once all 15 puzzles are registered, the fallback branches in every
dispatcher are dead. Remove them. The dispatchers become pure
table-lookups.

Final commit reduces content.js to:

```js
'use strict';
module.exports = require('./src/widget/widget.js');
```

## 8. Testing

The existing test suite (448 tests) must pass at every commit
throughout the migration. No new puzzle-specific tests required —
existing integration tests in `tests/solver.test.js` already exercise
the full path.

Two tests need updating:

- `tests/galaxies-hint.test.js`: currently `vm.runInContext`s
  `solver.js` + `handler.js` + `content.js`. Already updated for
  the solver split. Extend the same pattern to load
  `src/widget/**/*.js` files instead of root `content.js`.

- Any test that imports from `content.js` for top-level helpers
  (currently none, but verify): switch to the shim or the source
  file directly.

A new sanity test in `scripts/`:

```bash
node -e "require('./dist/content.js'); console.log('bundle ok');"
```

Run after `npm run build` to catch bundler regressions.

## 9. Caveats and out of scope

- The Aquarium / Nonogram / Galaxies hint logic isn't symmetric with
  the cell-state puzzles. They use different hint shapes (rows,
  cells, paths). The interface accommodates both by making
  `hintDispatch` return an opaque hint object that the puzzle's own
  `hintStatusNodes` renders. The shared `applyHintToGrid` already
  handles the variation; we don't redesign it.

- `handler.js` is not refactored here. It's a separate concern (per-
  puzzle URL matching + DOM bridge) and has its own per-puzzle list.
  A future split could move each `Handler` object into its puzzle
  module, but that's out of scope.

- `main-world.js` is not refactored. Its per-puzzle `read*Data` /
  `apply*State` functions could co-locate with the puzzle module
  someday but they have an external constraint (serialised via
  `fn.toString()` for MAIN-world execution) that complicates the
  split.

- We do not introduce ES modules / `import` syntax. CommonJS shape
  matches solver.js and the existing tooling.

- We do not change runtime behaviour. Each commit must produce a
  bundle byte-equivalent (modulo whitespace + comment reordering) to
  the previous one, or the test suite fails.

## 10. Risks

- **Dispatcher fallback bookkeeping**: forgetting to remove a
  fallback after registering a puzzle leaves dead code. Mitigation:
  Phase 4 sweep + manual code review.

- **Closure context leaks**: hooks need DOM refs (e.g., `shadow.querySelector`),
  but those live inside `makeWidget`. Solution: `widget.js` passes
  refs explicitly in the hook's `args` bag; puzzles never see
  `shadow` or other widget-internal state.

- **Bundle order dependencies**: a later file references a symbol
  from an earlier one. If we get the order wrong, the bundle works
  in Node tests (require resolves async) but fails in the browser
  (script evaluation is synchronous and order-dependent).
  Mitigation: the build script's `FILES` array is the single source
  of truth; we walk it deliberately, not alphabetically.

- **Test vm load**: `tests/galaxies-hint.test.js` needs the same
  per-file-load update applied during the solver split.

- **Time**: this is roughly 2-3× the work of the solver split.
  Budget accordingly.

End of design.
