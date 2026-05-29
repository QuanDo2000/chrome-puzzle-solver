# Shared utilities for solvers and widget modules — design

**Date:** 2026-05-29
**Status:** Approved (pending implementation plan)
**Track:** A (cross-cutting duplication cleanup)

## Problem

Duplicated logic is spread across both the solver layer (`src/solvers/*.js`)
and the widget layer (`src/widget/**/*.js`):

- **FNV-1a hash** — reimplemented ~14× in solver `_cacheKey` methods and ~13×
  in widget `cacheKey`/`staticSig` hooks (~27 copies total).
- **LRU cache set** (~7), **`_emit` grid 1-D→2-D** (~6), **`_cloneResult`**
  (~8), **`_timeUp`** (~7), **trail `idx|(oldVal<<24)` encoding** (~7), and the
  **`getHint` preamble** (~7) across the grid solvers.
- **Tarjan articulation-point white-connectivity** — ~80 lines duplicated
  nearly verbatim between `hitori.js` and `kurodoko.js`.
- Widget: the grey **`×` cross-draw** (~6), **single-cell hint-status
  template** (~6), **simple `hintDispatch` factory** (~6).

Estimated ~400–600 lines removable. The cleanup is purely
behavior-preserving.

## The central constraint

`src/solvers/*.js` and `src/widget/**/*.js` are consumed **two ways**:

1. **Node `require`** — tests run against the source files. Root `solver.js`
   is a 2-line shim (`module.exports = require('./src/solvers/index.js')`), so
   `require('../solver.js')` reaches the real source. Widget puzzle modules are
   `require`d directly by `tests/puzzle-modules.test.js`.
2. **Text concatenation** — `scripts/build-solver-bundle.js` and
   `scripts/build-content-bundle.js` glue files into `dist/solver.js` /
   `dist/content.js` (gitignored), stripping `'use strict'` and the CJS export
   tail. The browser worker / content script load these single files; there is
   **no module system** at runtime — concatenated files share one top-level
   scope.

A shared helper therefore cannot simply be `require`d: `require` works in Node
but is undefined in the concatenated bundle. The codebase already finesses
cross-file references two ways — bare bundle-scope `const` + `typeof X !==
'undefined'` guards (`puzzles/index.js`), and `global.X` test stubs
(`puzzle-modules.test.js`) — but neither suits **solver core helpers**, which
run inside `solve()` and are exercised for real by the Node fuzz tests; a
free-identifier reference would throw `ReferenceError`. They need a real Node
binding.

## Chosen mechanism: `require()` + bundler-strip (Approach A)

Helpers live in a shared CJS module (`module.exports = {…}` for Node).
Consumers import with `const { hashFNV1a, emitGrid } = require('./shared.js')`.
Each bundler is taught to:

1. Concatenate the shared module **first** (its export tail stripped by the
   existing `EXPORT_RE`, leaving bare top-level `function`/`const`).
2. **Strip** the `const … = require('…/shared.js')` lines from every consumer,
   so in the bundle the references resolve to the concatenated top-level
   helpers; in Node, `require` provides a real binding.

This is the natural extension of the strips both bundlers already perform.

### Rejected alternatives

- **Bare bundle-global + Node `global` injection** (the `puzzles/index.js` /
  test-stub pattern): fragile for core logic — every helper would need a
  `global.X` injection in every test entry point and `index.js`; a miss is a
  runtime `ReferenceError`, not a build error.
- **Build-time codegen** (stamp identical bodies into each file): source still
  reads as duplicated, no single bug-fix point, extra moving parts.

## Module layout (per-layer shared modules)

```
src/solvers/shared.js   ← FNV-1a, lruSet, emitGrid, cloneSolveResult, timeUp,
                          trailPush/trailPop, runHintPreamble, whiteConnectivity
src/widget/shared.js    ← FNV-1a, drawCrossCell, absoluteCellHintStatus,
                          makeSimpleHintDispatch
```

FNV-1a is defined once **per layer** (27 copies → 2), not once globally. A
single cross-layer `src/shared/hash.js` was considered and rejected: it couples
both bundlers to a third directory and forces a path-variable strip-regex, for
the marginal benefit of 2→1. Each bundler stays self-contained within its own
directory.

- `src/solvers/shared.js` is **not** exported from `index.js` (internal), but is
  the first entry in `build-solver-bundle.js`'s `FILES`.
- `src/widget/shared.js` is the first entry in `build-content-bundle.js`'s
  `WIDGET_FILES`.
- All helpers are **free functions taking explicit args** — no shared base
  class (the solvers have none today; free functions are the smaller, lower-risk
  change).

## Helper interfaces

### `src/solvers/shared.js`

| Helper | Signature → returns | Replaces | Notes |
|---|---|---|---|
| `hashFNV1a` | `(pushBytes) → number` | ~14 `_cacheKey` | Matches the most common existing call shape to minimize site churn. Returns `>>>0` 32-bit int; callers add `.toString(16)` + prefix. Must be **byte-identical** to legacy keys. |
| `lruSet` | `(map, maxSize, key, value) → void` | ~7 | Evict-oldest-then-set. |
| `emitGrid` | `(cellStatus, rows, cols) → number[][]` | ~6 `_emit` | 1-D → 2-D. |
| `cloneSolveResult` | `(result) → result` | ~8 `_cloneResult` | Deep-copies `grid`; preserves `solved`/`error`/`partial`. |
| `timeUp` | `(maxMs, startedAt) → boolean` | ~7 `_timeUp` | `maxMs<=0 → false`. |
| `trailPush` / `trailPop` | `(trail, idx, oldVal)` / `(trail, cellStatus) → void` | trail encoding ×7 | `idx \| (oldVal<<24)` pack/unpack. |
| `runHintPreamble` | `(solver, initialState) → {before, collectChanged}` | getHint preamble ×7 | Copies `initialState`→`cellStatus`, snapshots `before`, resets `trail`/`_depth`/`_inLookahead`/`_startedAt`, returns `collectChanged()`. Relies on the 7 solvers' shared field names (already common). |
| `whiteConnectivity` | `(cellStatus, rows, cols, opts) → boolean` | Hitori + Kurodoko Tarjan (~80 lines ×2) | DFS articulation-point check that "white" cells stay connected; `opts` supplies the per-puzzle white/black predicate. |

### `src/widget/shared.js`

| Helper | Signature | Replaces |
|---|---|---|
| `hashFNV1a` | same as above | ~13 `cacheKey`/`staticSig` |
| `drawCrossCell` | `(ctx, x, y, cellSize) → void` | grey `×` block ×6 |
| `absoluteCellHintStatus` | `(h, {bold}, v1Label, v2Label) → node[]` | single-cell hint-status ×6 |
| `makeSimpleHintDispatch` | `(SolverClass, extraArgs?) → hintDispatch fn` | inline `hintDispatch` ×6 |

**Highest-risk interfaces:** `runHintPreamble` and `whiteConnectivity`
(state-coupled — extract one solver at a time, fuzz-test immediately) and
`hashFNV1a` (must reproduce legacy keys exactly, or cached solutions silently
miss — pinned by a parity test before any swap).

### Known exclusions (from already-shipped Track-B decisions — do not "fix")

- **Aquarium's widget `cacheKey`** stays a delimited string-concat key (not
  FNV-1a) — it must mirror cache.js's `puzzlePartialKey` shape until a future
  "Stage D" collapses them, and a lossless string key is collision-safer than a
  32-bit hash anyway. Exclude it from the `hashFNV1a` swap-in.
- **Hitori's `drawPreviewCell` `v===2`** is a light grey fill, not the `×`
  (Hitori's `v=2` means "kept white/circled", a different semantic from
  "confirmed empty"). Exclude it from `drawCrossCell`. The `×` cohort is
  kurodoko, mosaic, norinori, nurikabe, kakurasu, and heyawake (6 modules).

## Bundler changes (both scripts)

1. **Concat shared module first** — `shared.js` is `FILES[0]` / `WIDGET_FILES[0]`.
2. **Strip consumer requires** — after the existing strips, apply:
   ```js
   const SHARED_REQUIRE_RE =
     /^\s*const\s*\{[^}]*\}\s*=\s*require\(['"]\.{1,2}\/(?:[\w.-]+\/)*shared\.js['"]\);?\s*$/mg;
   ```
   Path-flexible (`./shared.js` from solvers; `../shared.js` from
   `widget/puzzles/`).
3. **Fail loud** —
   - `throw` if any `require('…/shared.js')` substring survives in the assembled
     bundle (a malformed import slipped the regex → would crash the worker).
   - `throw` if the shared module wasn't found / isn't first.
   - Mirrors the existing "throw if CJS export block didn't strip" stance.
4. **Testability refactor** — wrap each script's work in an exported pure
   function:
   ```js
   function buildSolverBundle() { /* …returns bundle string… */ }
   if (require.main === module) { fs.writeFileSync(dist, buildSolverBundle()); }
   module.exports = { buildSolverBundle };
   ```
   `npm run build` behavior is unchanged (guarded by `require.main`).

## Verification plan

1. **Existing fuzz tests** (15 solvers + `solveLine` + nonogram) and
   `puzzle-modules.test.js` are the behavior oracle — every extraction is
   correct iff they stay green.
2. **Hash-parity test (new)** — assert `hashFNV1a(…)` reproduces the exact
   legacy key for sampled inputs of each type, run **before** any `cacheKey` is
   rewired.
3. **Solver bundle-validation test (new)** — `require` `buildSolverBundle()`,
   evaluate the string in a fresh `vm` context, run one representative solve per
   puzzle type, assert results match the Node path. Closes a pre-existing gap:
   nothing tests the concatenated output today.
4. **Content bundle smoke test (new)** — `buildContentBundle()` + `vm.Script`
   parse to catch surviving-`require` / redeclaration `SyntaxError`s (full
   DOM/`chrome` functional run is out of scope; `puzzle-modules.test.js` covers
   the rewired hook logic).
5. **Per-step gate** — `npm run build` → `npm test` → `npm run lint` →
   `npm run typecheck` green before every commit. One helper / one solver per
   step.

## Rollout sequence

- **Phase 0 — mechanism, no behavior change.** (1) Extract
  `buildSolverBundle()`/`buildContentBundle()` + add bundle-validation &
  content-smoke tests against the *current* bundles. (2) Create `shared.js` in
  both layers with just `hashFNV1a`; wire both bundlers (concat-first,
  strip-regex, fail-loud); add the hash-parity test. No call sites changed yet.
- **Phase 1 — pure solver helpers (low risk), one commit each:** `hashFNV1a`
  swap-in → `lruSet` → `emitGrid` → `cloneSolveResult` → `timeUp`.
- **Phase 2 — state-coupled solver helpers (high risk), one solver at a time:**
  `trailPush/Pop` → `runHintPreamble` → `whiteConnectivity` (Hitori, then
  Kurodoko).
- **Phase 3 — widget helpers:** `hashFNV1a` swap-in → `drawCrossCell` →
  `absoluteCellHintStatus` → `makeSimpleHintDispatch`.
- **Phase 4 — docs:** update CLAUDE.md (architectural notes + the bundler's
  shared-require strip).

**Fallback:** if a Phase-2 helper proves too entangled for a clean interface,
stop at it and leave that one duplicated; earlier phases stand alone. Each phase
is a shippable increment.

## Out of scope

- A single cross-layer `src/shared/` hash module (per-layer chosen instead).
- Converting solvers to a shared base class (free functions only).
- A headless-DOM functional test of the content bundle (smoke parse only).
- The widget render-ladder / other Track-B items (already handled separately).
