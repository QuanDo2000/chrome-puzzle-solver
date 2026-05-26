# `content.js` split Phase 2 Stage A — design

Date: 2026-05-25
Status: approved

Unwinds the 2,778-line `makeWidget()` closure from `content.js`
(currently 3,307 lines) into two new files under `src/widget/`:
`preview.js` (canvas rendering + sig helpers) and `widget.js` (the
makeWidget shell + DOM construction + button handlers + lifecycle).
After Stage A, the root `content.js` is reduced to ~200 lines (just
the `chrome.runtime.onMessage` listener, `applySolution`,
`solveExtraData`, the `WIDGET_STORAGE_KEY`/`SUPPORTED_PUZZLES`
constants, and the bootstrap that calls `makeWidget()` at DOM-ready).

This is the foundational refactor that unblocks the rest of Phase 2
(registry-first dispatchers, per-puzzle migration, cleanup).

## 1. Goal

- Move every makeWidget-internal helper out of the closure so it sits
  at module scope, where Phase 2 Stage B can wire it through the
  per-puzzle registry.
- Preserve runtime: bundle byte-equivalence with the prior Phase-1
  bundle at every commit; 448 tests stay green.
- Stay within the project's no-bundler-tool philosophy. The existing
  `scripts/build-content-bundle.js` learns two more file names.

## 2. Layout after Stage A

```
src/widget/
  state.js            (existing)  state vars + mutating-op helpers
  worker.js           (existing)  worker proxy + runSolve
  cache.js            (existing)  localStorage cache
  galaxies-hint.js    (existing)  Galaxies hint solver
  hint.js             (existing)  shared hint helpers
  preview.js          (NEW)       sig helpers + canvas-layer builders
                                  + drawPreview
  widget.js           (NEW)       makeWidget shell + button handlers
                                  + lifecycle
  puzzles/
    index.js          (existing)  empty registry (Phase 2 Stage C fills it)

content.js            ~200 lines  message listener, applySolution,
                                  solveExtraData, SUPPORTED_PUZZLES,
                                  loadWidgetPref/saveWidgetPref,
                                  makeWidget() bootstrap

scripts/
  build-content-bundle.js   bundler — order updated to include
                            preview.js (after hint.js) and widget.js
                            (after puzzles/index.js)
```

Bundler order (deliberate, mirrors dependency direction):

1. `state.js`
2. `worker.js`
3. `cache.js`
4. `galaxies-hint.js`
5. `hint.js`
6. `preview.js`
7. `puzzles/index.js`
8. `widget.js`
9. (remaining) `content.js`

Each file references only symbols defined earlier in the order, so a
flat-scope concatenation works in both the browser and the vm test
context.

## 3. Sub-stage A1 — Pure helpers into `preview.js`

The mechanical extraction. Every function listed below currently
lives inside makeWidget's closure but doesn't capture any closure
state: it takes `ctx` (CanvasRenderingContext2D) + data arguments and
returns a value or paints into the given context.

**Sig helpers** (~250 LOC total):

```
hintSig, regionMapSig, comparisonCluesSig, shikakuCluesSig,
slitherlinkCluesSig, hashiIslandsSig, hitoriTaskSig,
kakurasuCluesSig, kurodokoTaskSig, mosaicTaskSig, norinoriAreasSig,
nurikabeTaskSig, heyawakeAreasSig, gridDataSig
```

**Canvas-layer builders** (~600 LOC total):

```
buildLatticeLayer, buildStaticLayer,
drawComparisonCluesOn, drawShikakuCluesOn, drawHashiIslandsOn,
drawHeyawakeRoomsOn, drawRegionBordersOn, drawNonogramGuidesOn
```

All move from `function name() { ... }` inside makeWidget to top-level
`function name() { ... }` in `src/widget/preview.js`. The closure no
longer defines them; bundle order ensures they're available at flat
scope.

After A1, makeWidget is ~700 LOC lighter; `preview.js` is ~850 LOC.

## 4. Sub-stage A2 — `drawPreview` into `preview.js`

The hard part. Current `drawPreview` is a ~700-LOC function inside
makeWidget. It captures four closure locals:

- `canvas` — the `<canvas>` element from makeWidget's shadow DOM.
- `latticeLayer`, `staticLayer` — cached off-screen canvases.
- `staticLayerSig` — string hash for cache invalidation.

Plus it reads `puzzleData` (the current detected puzzle) and `hint`
(the current hint overlay) from the surrounding scope.

**Refactor:**

- Lift the cache state to module-scope `let` in `preview.js`:
  ```js
  let _latticeLayer = null;
  let _staticLayer = null;
  let _staticLayerSig = '';
  ```
  Single-instance state is fine — there's only one widget per page.

- Promote `drawPreview` to a top-level function with explicit args:
  ```js
  function drawPreview(canvas, puzzleData, grid, hint) {
    // (formerly closure refs become parameter accesses)
  }
  ```

- Inside makeWidget, the local `drawPreview` becomes a one-line
  forward:
  ```js
  const drawPreviewLocal = (g, h) => drawPreview(canvas, puzzleData, g, h);
  ```
  Or — better — every call site inside makeWidget gets rewritten to
  pass `canvas` and `puzzleData` explicitly. That keeps the indirection
  flat.

**The per-puzzle render arms** inside drawPreview (the giant
`if (isNurikabe) ... else if (isBinairo) ...` switch on cellStatus
rendering) are NOT migrated in Stage A. They stay inline in
`drawPreview`. Stage C migrates them to `PUZZLES[type].drawPreviewCell`.

After A2, makeWidget is another ~700 LOC lighter. `preview.js` is
~1,550 LOC. content.js is ~1,900 lines.

## 5. Sub-stage A3 — makeWidget shell into `widget.js`

Move what's left of the makeWidget closure to `src/widget/widget.js`.
That includes:

- The full `makeWidget()` function (now ~1,200 LOC after A1+A2): DOM
  construction (shadow root, buttons, status nodes), button handlers
  (Solve/Hint/Loop/Stop/Undo/Redo/Dump), status text helpers
  (`setStatus`, `setStatusNodes`, `bold`), per-puzzle hint-status
  functions (`binairoHintStatusNodes`, `heyawakeHintStatusNodes`, etc.
  — 14 of them, each ~15 LOC), `renderHintStatusAndPreview`,
  `solveHandler`, `hintHandler`, `loopHandler`,
  `applySolveResult`, `recordSolveSuccess`, `applyPartialResult`.
- The lifecycle setup (`pagehide` / `pageshow` MutationObserver wire-up)
  that currently lives below makeWidget in content.js.
- The bootstrap call that creates the widget at DOM-ready.

content.js after A3 is ~200 lines:

- `chrome.runtime.onMessage` listener (lines 1-67 currently)
- `detectPuzzle`, `readGridState`, `applySolution` (68-132)
- `solveExtraData` (101-487)
- `WIDGET_STORAGE_KEY`, `SUPPORTED_PUZZLES`, `loadWidgetPref`,
  `saveWidgetPref` (488-528)
- Maybe a one-line `if (document.readyState === ...) makeWidget()`
  bootstrap, depending on what was at the bottom of the file.

Note: in this stage, `solveExtraData` and `SUPPORTED_PUZZLES` STAY in
content.js. They migrate to the per-puzzle registry in Stage B/C, not
Stage A.

The bottom-of-file `widgetExpandFn` global (currently a `let` at
content.js line 514) moves with the rest of the widget into widget.js
— it's the only piece content.js's onMessage listener uses to
expand the widget after `chrome.action.onClicked`. After widget.js is
in place, content.js's listener references `widgetExpandFn` as a
cross-file global, same shape as the existing `detectedGrid` /
`mutatingOp` cross-file refs.

## 6. Stage A integration steps

Migration order (each step is one commit, tests pass):

1. **A1.1**: Add `preview.js` with empty placeholder + wire bundler
   + test loader. Verify dist/content.js bundle still works.
2. **A1.2**: Move all sig helpers (14 functions) from makeWidget to
   preview.js. Verify.
3. **A1.3**: Move canvas-layer builders + draw helpers (8 functions)
   from makeWidget to preview.js. Verify.
4. **A2.1**: Promote drawPreview from a closure to a top-level
   function in preview.js. Rewrite call sites inside makeWidget to
   pass canvas + puzzleData explicitly. Lift the three cache locals
   to module scope. Verify.
5. **A3.1**: Add `widget.js` with empty placeholder + wire bundler
   + test loader. Verify.
6. **A3.2**: Move the makeWidget function body (and its callers,
   lifecycle hooks) to widget.js. content.js becomes ~200 lines.
   Verify.
7. **A3.3**: Update eslint config + globals.d.ts for the newly
   cross-file symbols (drawPreview, makeWidget,
   `widgetExpandFn`, the 14 hint-status functions, etc.).
8. **Final**: lint, typecheck, npm test, npm run build, manual
   browser smoke, push to main.

Eight commits total. Each is mechanical except A2.1 (drawPreview
promotion — the only non-trivial closure surgery in Stage A).

## 7. Testing

- `npm test` (448 tests) must stay green at every commit.
  `tests/galaxies-hint.test.js` already loads `src/widget/*.js` via
  the vm context; extending `widgetOrder` to include `preview.js` and
  `widget.js` (matching the bundler) keeps the vm path mirroring the
  browser path.
- No new tests required for Stage A — it's a refactor; integration
  tests cover behavior.
- Manual browser smoke after the final commit: open any puzzle, run
  Solve / Hint / Loop. Should behave identically to pre-Stage-A.

## 8. Risks and out-of-scope

- **Single-instance cache state** in preview.js (module-scope
  `_latticeLayer` etc.) means a second widget on the same page would
  share rendering state. Today there's only one widget per page, so
  this is acceptable. Flag in the source comment.
- **Closure-captured locals discovered late**: a function inside
  makeWidget may reference a closure local we hadn't noticed. The
  refactor extracts cautiously — A1 only touches obviously-pure
  functions; A2 + A3 promote stepwise, verifying tests between each.
- **Out of Stage A scope**:
  - Per-puzzle registry — Stage B/C.
  - drawPreview's per-puzzle render arm migration — Stage C.
  - `solveExtraData`/`SUPPORTED_PUZZLES` migration — Stage B/C.
  - Fallback cleanup — Stage D.
  - Any refactor of `handler.js` or `main-world.js`.

End of design.
