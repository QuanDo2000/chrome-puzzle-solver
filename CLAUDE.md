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
- **Flat-int `Map` keys** for `GalaxiesSolver.owner` (was `"r,c"` strings).
- **`String.fromCharCode.apply`** for state-hash keys in `_stateKey` (was `+= toString(36) + '.'`).
- **`Uint8Array`-backed BFS visited sets** in `_regionReachable`.
- **Dense `Int32Array` contribs** in `AquariumSolver` (was sparse `{row: count}` objects).
- **Canvas: early-bail + cached static layer** in `content.js drawPreview` — keyed by puzzle shape; only the dynamic cell layer is redrawn per state-watch tick.

### Widget conventions
- `setStatusNodes(type, ...parts)` + `bold(text)` build status DOM via `appendChild`. Never use `innerHTML` for dynamic content.
- `clearPendingHint()` resets the pending-hint UI state in one call (formerly a scattered 3-line pattern).
- `applySolveResult(result)` is the canonical "solve succeeded → enter confirm mode" transition (used by both fresh-solve and retry paths).
- `mutatingOp` token serializes apply/undo/redo so they can't interleave (closes the race where Undo mid-apply pushed half-applied state to redo).
- The Loop button repurposes as Stop while looping — `setButtonsDisabled(true)` must be followed by `loopBtn.disabled = false`.

## Tests and benches

- `npm test` runs the `node:test` suite under `tests/`.
- `tests/fixtures/puzzles.js` — small deterministic puzzles with golden snapshots in `tests/golden.js`. Regenerate via `npm run capture`.
- `tests/fixtures/real-puzzles.js` — full-size puzzles captured from puzzles-mobile.com via the widget's **📋 Dump** button. Used by `tests/bench-real.js` only.
- `tests/solveline.test.js` — property-style cross-check of `NonogramSolver.solveLine` against a brute-force enumerator (200 fuzz trials). Add similar cross-checks if you change line-DP logic.
- Bench scripts: `tests/bench.js` (synthetic nonogram), `tests/bench-galaxies.js`, `tests/bench-aquarium.js`, `tests/bench-real.js`.
- Comparing perf vs a prior revision: `jj file show -r <change-id> solver.js > /tmp/solver-baseline.js`, swap into place, run bench, swap back.

## Capturing new real puzzles

Click the widget's **📋 Dump** button on any puzzle page. It writes a JSON snippet (matching the `real-puzzles.js` format) to the clipboard and to `console.log` with prefix `[puzzle-solver dump]`. On extractor failure the snippet includes a `diagnostic` block with the shape of `window.Game` — paste that back to patch `dumpPuzzleForBench()` in `main-world.js`.

## Things explicitly removed (don't reintroduce)

- `utils.js` (held `PUZZLE_SELECTORS` used only by the never-registered `genericHandler`).
- `genericHandler` in `handler.js` (catch-all that was never registered).
- `solveLineValid` in `NonogramSolver` (merged into `solveLine`'s single forward+backward pass).
- `console.log` debug breadcrumbs from `AquariumSolver.solve` and the galaxies hint failure path.
- `setStatusHtml(html, type)` + `hintStatusText` — replaced by `setStatusNodes` + `hintStatusNodes`.
- `clone()` and `isContradiction()` in `NonogramSolver` (replaced by trail-based undo + bool return from `propagate`).
