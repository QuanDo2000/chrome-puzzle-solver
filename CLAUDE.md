# Project conventions for Claude Code

A Chrome MV3 extension that solves Nonogram, Aquarium, and Galaxies puzzles
on puzzles-mobile.com. Three solver classes in `solver.js`, a content-script
widget in `content.js`, and a small service worker in `background.js`.

## Version control: use `jj`, never plain `git`

This repo is a colocated Jujutsu + git workspace. Always use `jj` for version
control operations. Do NOT run `git commit`, `git add`, `git status`, `git log`,
`git checkout`, or any other plain `git` command.

| Intent | Command |
| --- | --- |
| Show working-copy status | `jj status` |
| Show recent history | `jj log` |
| Show diff of current change | `jj diff` |
| Commit working copy (creates a new empty change on top) | `jj commit -m "msg"` |
| Describe current change without committing | `jj describe -m "msg"` |
| Create a new empty change | `jj new` |
| Move working copy to a specific change | `jj edit <change-id>` |
| Restore a file from a previous change | `jj restore --from <change-id> <path>` |
| Show a file at a specific revision | `jj file show -r <change-id> <path>` |

When dispatching subagents that need to commit work, tell them explicitly to use
`jj` and not `git`.

## File responsibilities

| File | Role | Runs in |
| --- | --- | --- |
| `solver.js` | `NonogramSolver`, `AquariumSolver`, `GalaxiesSolver` — pure logic, no DOM | Content script + Web Worker (via inlined Blob) + Node tests |
| `solver.worker.js` | Worker entry: imports solver.js + dispatches by puzzle type | Web Worker (inlined into a Blob — see Worker note below) |
| `content.js` | Widget UI, message dispatch, `runSolve` (Worker proxy), `drawPreview` | Content script (isolated world, page's origin) |
| `handler.js` | Per-puzzle-type handlers (galaxies/aquarium/puzzles-mobile fallback) | Content script |
| `background.js` | Service worker entry. Only contains the `chrome.runtime.onMessage` listener + `importScripts('main-world.js')` | MV3 service worker |
| `main-world.js` | Library of functions that get **serialized via `chrome.scripting.executeScript({world: 'MAIN', func})`** and executed in the page context. They reference `window.Game`, `document`, `localStorage` — none of which exist in the service worker. | Page MAIN world (per call) |

## Build output (`dist/`)

`dist/` is the minimized extension folder Chrome loads — only the files referenced by `manifest.json` plus `main-world.js` (which `background.js` `importScripts`). It's gitignored and rebuilt by `npm run build`.

**After editing any of these source files, run `npm run build`** so Chrome picks up the change on the next reload:

- `manifest.json`, `background.js`, `main-world.js`
- `content.js`, `handler.js`, `solver.js`, `solver.worker.js`
- anything under `icons/` that's referenced by `manifest.json`

Edits to tests, lint config, docs, `package.json`, etc. do **not** need a rebuild.

## Architectural notes (the non-obvious bits)

### MV3 Worker cross-origin gotcha
Content scripts share the page's origin, so `new Worker(chrome.runtime.getURL('solver.worker.js'))` is blocked as cross-origin **even when the resource is web-accessible**. `content.js` works around it by `fetch`-ing both `solver.js` and `solver.worker.js` as text, stripping the worker's `importScripts(...)` line, and constructing the Worker from a same-origin `Blob` URL. See `getSolverWorker()` in `content.js`.

### MAIN-world function dispatch
`callMainWorld(funcName, args)` in `handler.js` sends `{action: 'execMain', funcName}` to the SW. The SW does `globalThis[funcName]` to find the function (declared in `main-world.js`, imported via `importScripts`), then calls `chrome.scripting.executeScript({func, args, world: 'MAIN'})`. The function is **serialized as source via `fn.toString()`** and injected into the page, so:
- It cannot reference outer-scope helpers (closure is lost in transit). Nested helpers must live inside the function body.
- It cannot reference functions defined elsewhere in `main-world.js` — only globals available in MAIN world (`window.Game`, `document`, etc.).

### Performance patterns used
- **Trail-based undo** in `NonogramSolver` (`_assign`/`_rollback` pushing flat 3-int groups) and `GalaxiesSolver` (same with 2D tuples) — replaces per-recursion grid cloning.
- **Forward + backward line DP** in `NonogramSolver.solveLine` — single O(L·N·block) pass replaces the old per-cell solveLineValid reruns (was 36× slower on the 50×50 monthly).
- **Bitmap canEmpty intersection** in `solveLine` — `bf[c] & bb[c+1]` k-bit intersection answers the per-cell can-be-empty check in O(1); requires N ≤ 31, asserted in code.
- **Incremental `rowKnown`/`colKnown`** in `NonogramSolver` — Int32Array per-line counts maintained in `_set`/`_assign`/`_rollback` so `backtrack` picks its variable in O(R+C) instead of O(R·C) per recursion.
- **Dirty-cell queue** in `GalaxiesSolver._propagate` — after each assignment, only enqueue cells whose mirror-under-some-star landed on the changed cell. Replaces the prior `while(didChange)` full grid sweep.
- **Inlined `_mirror`** at the hottest sites (`_canAssignPair`, `_assignPair`, `_shapeFrontier`) — skips the per-call `{row, col}` object allocation.
- **Flat-int `Map` keys** for `GalaxiesSolver.owner` (was `"r,c"` strings).
- **`String.fromCharCode.apply`** for state-hash keys in `_stateKey` (was `+= toString(36) + '.'`).
- **`Uint8Array`-backed BFS visited sets** in `_regionReachable`.
- **Dense `Int32Array` contribs** in `AquariumSolver` (was sparse `{row: count}` objects).
- **Static `_solutionCache`** on `GalaxiesSolver` — bypassed when `initialGrid` or `forbiddenPartials` is set (constraints invalidate the unconstrained cached result). Use `GalaxiesSolver.clearSolutionCache()` in tests to keep them order-independent.
- **Canvas: two-layer cache** in `content.js drawPreview` — `latticeLayer` (grey cell-border lines) drawn UNDER dynamic fills; `staticLayer` (region borders / nonogram guides / galaxy stars) drawn ON TOP. Both rebuilt only on puzzle-shape changes. Dynamic fills + X-mark Path2D in between.
- **FNV-1a numeric hashes** for `gridDataSig` / `regionMapSig` early-bail in `drawPreview` (was O(N²) string concat per 200ms tick).

### Widget conventions
- `setStatusNodes(type, ...parts)` + `bold(text)` build status DOM via `appendChild`. Never use `innerHTML` for dynamic content.
- `clearPendingHint()` resets the pending-hint UI state in one call (formerly a scattered 3-line pattern).
- `recordSolveSuccess(result)` caches the solver output (puzzle solution, galaxies cache, partial clears). Shared by both `applySolveResult` and `loopHandler`'s intermediate solve so the cache invariants can't drift.
- `applySolveResult(result)` = `recordSolveSuccess(result)` + the confirm-mode UI transition (status text, button label, preview). Used by fresh-solve and retry paths.
- `applySolution(solution, skipUndo, internal)`: undo/redo pass `internal=true` so the nested apply doesn't drop the mutex (the outer caller already owns it). All three handler.applySolution implementations return `{ success, error? }`; applySolution propagates that, never lies about success.
- `mutatingOp` token serializes apply/undo/redo so they can't interleave.
- The Loop button repurposes as Stop while looping — `setButtonsDisabled(true)` must be followed by `loopBtn.disabled = false`. The inter-step 300ms sleep is cancellable via `stopLoopWait` so Stop is instant.
- Lifecycle: `pagehide(persisted=false)` drains `solverPending`, terminates the worker, stops the state-watch observer. `pagehide(persisted=true)` no-ops (BFCache). `pageshow(persisted=true)` nulls the (now-dead) worker so the next call rebuilds lazily.

## Capturing new real puzzles

Click the widget's **📋 Dump** button on any puzzle page. It writes a JSON snippet (matching the `real-puzzles.js` format) to the clipboard and to `console.log` with prefix `[puzzle-solver dump]`. On extractor failure the snippet includes a `diagnostic` block with the shape of `window.Game` — paste that back to patch `dumpPuzzleForBench()` in `main-world.js`.

## MV3 hardening contract

- `background.js`'s `onMessage` listener rejects anything where `sender.id !== chrome.runtime.id` and gates `execMain` `funcName` against `EXEC_MAIN_ALLOWLIST` (9 entries). The TS-side mirror is `MainWorldFn` in `globals.d.ts`; keep them in sync.
- `callMainWorld` has a 15s wall-clock timeout via `Promise.race` — if the SW dies mid-call, the caller resolves `null` instead of hanging.
- `execMain` targets `sender.tab.id`, not the active tab — handles tab-switch mid-call.
- `manifest.json` permissions list is minimal (`scripting` only). Don't add `activeTab` / `storage` back without a concrete need.

## Tests and benches

- `npm test` runs the `node:test` suite under `tests/`. `npm run lint`, `npm run typecheck` are gated in CI.
- `tests/fixtures/puzzles.js` — small deterministic puzzles with golden snapshots in `tests/golden.js`. Regenerate via `npm run capture`.
- `tests/fixtures/real-puzzles.js` — full-size puzzles captured from puzzles-mobile.com via the widget's **📋 Dump** button. Used by `tests/bench-real.js` only.
- `tests/solveline.test.js` — brute-force cross-check of `solveLine`. Two fuzz tests: small (N≤3) and large (N=4..7, exercises the bitmap fast-path).
- Bench scripts (`tests/bench.js`, `bench-galaxies.js`, `bench-aquarium.js`, `bench-real.js`) discard 2 warmup iterations. `bench-galaxies.js`, `bench-aquarium.js`, and `bench-real.js` `process.exit(1)` on unsolved puzzles; `bench.js`'s synthetic nonogram is intentionally ambiguous so `solved=false` is expected and it does not exit non-zero.
- Comparing perf vs a prior revision: `jj file show -r <change-id> solver.js > /tmp/solver-baseline.js`, swap into place, run bench, swap back.
- Nightly CI workflow (`.github/workflows/bench-nightly.yml`) runs all four; no `continue-on-error`.

## Things explicitly removed (don't reintroduce)

- `utils.js` (held `PUZZLE_SELECTORS` used only by the never-registered `genericHandler`).
- `genericHandler` in `handler.js` (catch-all that was never registered).
- `solveLineValid` in `NonogramSolver` (merged into `solveLine`'s single forward+backward pass).
- `console.log` debug breadcrumbs from `AquariumSolver.solve` and the galaxies hint failure path.
- `setStatusHtml(html, type)` + `hintStatusText` — replaced by `setStatusNodes` + `hintStatusNodes`.
- `clone()` and `isContradiction()` in `NonogramSolver` (replaced by trail-based undo + bool return from `propagate`).
- `AquariumSolver._solveMinConflicts` — random-restart heuristic from an earlier solver iteration; never called.
- `solveLine` N>31 fallback scan — the bitmap path is the only path now (real puzzles cap at N≈12).
- `sendToContent` action in `background.js` — was unused.
- `syncGameTimerForCheck` top-level in `main-world.js` — closure is lost when serialized to MAIN world; inlined as nested `syncTimer` in each caller.
- `tests/snapshots/` directory + its eslint ignore — dead infrastructure.
