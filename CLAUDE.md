# Project conventions for Claude Code

A Chrome MV3 extension that solves Nonogram, Aquarium, Galaxies, Binairo,
Binairo Plus, Shikaku, Yin-Yang, Slitherlink, and Hashi puzzles on
puzzles-mobile.com. Eight solver classes in `solver.js`, a content-script
widget in `content.js`, and a small service worker in `background.js`.

## Version control: use `jj`, never plain `git`

Colocated Jujutsu + git workspace. Always use `jj` — never `git commit`, `git
add`, `git status`, `git log`, `git checkout`, etc.

Common commands: `jj status`, `jj log`, `jj diff`, `jj commit -m "msg"`, `jj
describe -m "msg"`, `jj new`, `jj edit <change-id>`, `jj restore --from
<change-id> <path>`, `jj file show -r <change-id> <path>`.

When dispatching subagents that commit, tell them explicitly to use `jj`.

## File responsibilities

| File | Role | Runs in |
| --- | --- | --- |
| `solver.js` | All solver classes — pure logic, no DOM | Content script + Web Worker + Node tests |
| `solver.worker.js` | Worker entry: imports solver.js + dispatches by puzzle type | Web Worker (inlined Blob — see Worker note) |
| `content.js` | Widget UI, message dispatch, `runSolve` (Worker proxy), `drawPreview` | Content script |
| `handler.js` | Per-puzzle-type handlers | Content script |
| `background.js` | `chrome.runtime.onMessage` listener + `importScripts('main-world.js')` | MV3 service worker |
| `main-world.js` | Functions serialized via `chrome.scripting.executeScript({world:'MAIN', func})` and run in the page context. Reference `window.Game`, `document`, `localStorage` — none exist in the SW. | Page MAIN world (per call) |

## Build output (`dist/`)

`dist/` is the minimized folder Chrome loads — only files referenced by
`manifest.json` plus `main-world.js`. Gitignored, rebuilt by `npm run build`.

**Run `npm run build` after editing**: `manifest.json`, `background.js`,
`main-world.js`, `content.js`, `handler.js`, `solver.js`, `solver.worker.js`,
or any `icons/` referenced by `manifest.json`. Tests/lint/docs/`package.json`
edits don't need a rebuild.

## Architectural notes (the non-obvious bits)

### MV3 Worker cross-origin gotcha
Content scripts share the page's origin, so `new
Worker(chrome.runtime.getURL('solver.worker.js'))` is blocked as cross-origin
**even when web-accessible**. `content.js` works around it by `fetch`-ing
`solver.js` and `solver.worker.js` as text, stripping the worker's
`importScripts(...)` line, and constructing the Worker from a same-origin
`Blob` URL. See `getSolverWorker()` in `content.js`.

### MAIN-world function dispatch
`callMainWorld(funcName, args)` in `handler.js` → SW does `globalThis[funcName]`
(declared in `main-world.js`, loaded via `importScripts`) → `chrome.scripting
.executeScript({func, args, world:'MAIN'})`. The function is **serialized as
source via `fn.toString()`**, so:
- No outer-scope helpers — nested helpers must live inside the function body.
- No references to other `main-world.js` functions — only MAIN-world globals
  (`window.Game`, `document`, etc.).

### MAIN-world write functions: save + render ladder
Any function mutating `window.Game.currentState` (`applyGameState`,
`applyGalaxiesState`, `applyHintCells`) must:
1. Call `window.Game.saveState(true)` **before** writes — without it, aquarium
   silently keeps prior visible state even though `cellStatus` updated.
2. Fall through the **canonical render ladder** **after** writes — the same
   if/else-if chain in every `apply*State` function:
   `drawCurrentState → render → redraw → redrawGrid → draw →
   getSaved+loadGame`. No single method repaints every puzzle type
   (aquarium needs `redraw`/`redrawGrid`; the newer cell-state puzzles use
   `drawCurrentState`), so the ladder tries each in order and stops at the
   first that exists. Keep all `apply*State` functions on this identical
   ladder — don't reintroduce per-puzzle orderings.

`applyGameState` is the reference shape. Never call `window.Game.check()` — the
site flags an instant solve as a DNF.

### `handler.js` Node-only export tail
`handler.js` has `if (typeof module !== 'undefined' && module.exports) {
module.exports = { parseGalaxiesTask }; }` so tests can `require` the parser.
`registerHandler(...)` calls run under Node `require` but only push to a local
array. **Don't add a top-level statement that touches `document`/`window`/
`chrome` outside a function body** or Node-side `require()` will throw.

### Performance patterns used
- **Trail-based undo** in `NonogramSolver` and `GalaxiesSolver` — replaces
  per-recursion grid cloning.
- **Forward + backward line DP** in `NonogramSolver.solveLine` — single
  O(L·N·block) pass.
- **Bitmap canEmpty intersection** in `solveLine` — `bf[c] & bb[c+1]`
  answers per-cell can-be-empty in O(1); requires N ≤ 31 (asserted).
- **Incremental `rowKnown`/`colKnown`** in `NonogramSolver` — Int32Array
  maintained in `_set`/`_assign`/`_rollback` so backtrack picks variable
  in O(R+C).
- **Dirty-cell queue** in `GalaxiesSolver._propagate` — enqueue only cells
  whose mirror landed on the changed cell.
- **Inlined `_mirror`** at hottest sites — skip per-call `{row, col}` alloc.
- **Flat-int `Map` keys** for `GalaxiesSolver.owner` (was `"r,c"`).
- **`String.fromCharCode.apply`** for `_stateKey` hash keys.
- **`Uint8Array`-backed BFS visited sets** in `_regionReachable`.
- **Dense `Int32Array` contribs** in `AquariumSolver`.
- **Static `_solutionCache`** on `GalaxiesSolver` — bypassed when
  `initialGrid` or `forbiddenPartials` set. Use
  `GalaxiesSolver.clearSolutionCache()` in tests.
- **Canvas two-layer cache** in `content.js drawPreview` — `latticeLayer`
  (grey borders) UNDER dynamic fills; `staticLayer` (region borders /
  nonogram guides / stars) ON TOP. Both rebuilt only on shape changes.
- **FNV-1a numeric hashes** for `gridDataSig`/`regionMapSig` early-bail.

### Widget conventions
- `setStatusNodes(type, ...parts)` + `bold(text)` build status DOM via
  `appendChild`. Never `innerHTML` for dynamic content.
- `clearPendingHint()` resets pending-hint UI state in one call.
- `recordSolveSuccess(result)` caches solver output (solution, galaxies
  cache, partial clears). Shared by `applySolveResult` and `loopHandler`.
- `applySolveResult(result)` = `recordSolveSuccess` + confirm-mode UI
  transition.
- `applySolution(solution, skipUndo, internal)`: undo/redo pass
  `internal=true` so nested apply doesn't drop the mutex (outer caller owns
  it). All `handler.applySolution` impls return `{success, error?}`;
  `applySolution` propagates that, never lies about success.
- `mutatingOp` token serializes apply/undo/redo.
- Loop button repurposes as Stop while looping — `setButtonsDisabled(true)`
  must be followed by `loopBtn.disabled = false`. The inter-step 300 ms
  sleep is cancellable via `stopLoopWait` so Stop is instant.
- Lifecycle: `pagehide(persisted=false)` drains `solverPending`, terminates
  worker, stops state-watch observer. `pagehide(persisted=true)` no-ops
  (BFCache). `pageshow(persisted=true)` nulls the dead worker so next call
  rebuilds lazily.
- `detectHandler` fires `autoSolve()` (non-blocking) after successful
  detect: cache-check, then background worker solve from givens, populating
  `puzzleData.solution` + localStorage caches. `pendingAutoSolve` bridges
  the race when a feature is clicked before solve lands. `drawPreview`
  rings cells where board disagrees with solution (`computePuzzleDiff`),
  recomputed each redraw. Shikaku/Galaxies diffs are geometry- or
  star-normalized (owner/region ids don't align board↔solver).

## Capturing new real puzzles

Click the widget's **📋 Dump** button. Writes a JSON snippet (matching
`real-puzzles.js` format) to clipboard and `console.log` prefixed
`[puzzle-solver dump]`. On extractor failure the snippet includes a
`diagnostic` block — paste back to patch `dumpPuzzleForBench()` in
`main-world.js`.

## MV3 hardening contract

- `background.js`'s `onMessage` rejects `sender.id !== chrome.runtime.id`
  and gates `execMain` `funcName` against `EXEC_MAIN_ALLOWLIST`. TS-side
  mirror is `MainWorldFn` in `globals.d.ts`; the two lists must stay in
  sync (every entry on one is on the other) — don't pin a count here, it
  drifts when puzzles are added.
- `callMainWorld` has a 15 s wall-clock timeout via `Promise.race` — if SW
  dies mid-call, caller resolves `null` instead of hanging.
- `execMain` targets `sender.tab.id`, not the active tab — handles
  tab-switch mid-call.
- `manifest.json` permissions list is minimal (`scripting` only). Don't add
  `activeTab`/`storage` without concrete need.

## Tests and benches

- `npm test` runs `node:test` suite under `tests/`. `npm run lint`,
  `npm run typecheck` gated in CI.
- `tests/fixtures/puzzles.js` — small deterministic puzzles; golden
  snapshots in `tests/golden.js`. Regenerate via `npm run capture`.
- `tests/fixtures/real-puzzles.js` — full-size captures via 📋 Dump. Used
  by `tests/bench-real.js`.
- `tests/solveline.test.js` — brute-force cross-check; small (N≤3) and
  large (N=4..7, bitmap fast-path) fuzz.
- Bench scripts discard 2 warmup iterations. `bench-galaxies.js`,
  `bench-aquarium.js`, `bench-real.js` `process.exit(1)` on unsolved.
  `bench.js`'s synthetic nonogram is intentionally ambiguous so
  `solved=false` is expected.
- Compare perf vs prior revision: `jj file show -r <change-id> solver.js >
  /tmp/solver-baseline.js`, swap in, bench, swap back.
- Nightly CI `.github/workflows/bench-nightly.yml` runs all four; no
  `continue-on-error`.

## Things explicitly removed (don't reintroduce)

- `utils.js` (held `PUZZLE_SELECTORS` only used by never-registered
  `genericHandler`).
- `genericHandler` in `handler.js` (was never registered).
- `solveLineValid` in `NonogramSolver` (merged into `solveLine`).
- `console.log` breadcrumbs from `AquariumSolver.solve` and galaxies hint
  failure path.
- `setStatusHtml(html, type)` + `hintStatusText` (replaced by
  `setStatusNodes`/`hintStatusNodes`).
- `clone()` and `isContradiction()` in `NonogramSolver` (trail-based undo +
  bool from `propagate`).
- `AquariumSolver._solveMinConflicts` (random-restart heuristic, never
  called).
- `solveLine` N>31 fallback scan (bitmap is only path; real puzzles cap
  at N≈12).
- `sendToContent` action in `background.js` (unused).
- `syncGameTimerForCheck` top-level in `main-world.js` (closure lost when
  serialized; inlined as nested `syncTimer` in each caller).
- `tests/snapshots/` directory + its eslint ignore (dead infrastructure).

## Per-puzzle design notes

Encoding/algorithm details for each puzzle live in the relevant module
header. For widget/page-interaction details (page encoding, cellStatus
shapes, MAIN-world read/write contracts, preview/diff/loop-done-check
specifics), see the header of `src/widget/puzzles/<type>.js`. For solver
internals (propagation rules, lookahead, CDCL, caching, perf envelopes),
see `src/solvers/<type>.js`.

Modules with detailed design notes in their headers:

- Binairo / Binairo Plus — `src/widget/puzzles/binairo.js`,
  `src/solvers/binairo.js`
- Shikaku — `src/widget/puzzles/shikaku.js`, `src/solvers/shikaku.js`
- Yin-Yang — `src/widget/puzzles/yinyang.js`, `src/solvers/yinyang.js`
- Slitherlink — `src/widget/puzzles/slitherlink.js`,
  `src/solvers/slitherlink.js`
- Hashi — `src/widget/puzzles/hashi.js`, `src/solvers/hashi.js`
- Norinori — `src/widget/puzzles/norinori.js`, `src/solvers/norinori.js`
- Galaxies (shared statics) — `src/widget/galaxies-hint.js`,
  `src/solvers/galaxies.js`
