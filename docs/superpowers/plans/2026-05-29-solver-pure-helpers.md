# Solver pure-helper dedup (emitGrid / cloneSolveResult / timeUp / lruSet) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract four duplicated pure helpers from the grid solvers into `src/solvers/shared.js` — `emitGrid`, `cloneSolveResult`, `timeUp`, `lruSet` — eliminating ~30 near-identical copies.

**Architecture:** These helpers are all internal to `solve()` and already exercised end-to-end by the per-solver fuzz suites, so the fuzz tests (not a new characterization test) are the behavior oracle. Each helper goes into the existing `src/solvers/shared.js` (already wired into the bundler with require-strip + fail-loud guards from the FNV work) and is `require`d by each consumer. Behavior-preserving: every fuzz test must stay green.

**Tech Stack:** Node.js (`node:test`), CommonJS, the hand-rolled `build-solver-bundle.js` concatenator. Version control: **`jj`, never `git`**.

**Source spec:** `docs/superpowers/specs/2026-05-29-solver-shared-utils-design.md` (this plan implements the four remaining Phase-1 pure helpers; FNV-1a is already done).

**Scope of THIS plan:** spec Phase 1 minus `hashFNV1a` (done). **Out of scope** (spec Phase 2, follow-up plan): `trailPush`/`trailPop`, `runHintPreamble`, `whiteConnectivity`.

**Key facts established by discovery:**
- `emitGrid` consumers (byte-identical grid form): `hitori`, `kakurasu`, `kurodoko`, `mosaic`, `norinori`, `nurikabe`, `heyawake`. **EXCLUDE** `slitherlink` (`_emit` returns `{horizontal,vertical}`) and `hashi` (`_emit` returns an edges array) — different shapes.
- `cloneSolveResult` consumers: `hitori`, `kakurasu`, `kurodoko`, `mosaic`, `norinori`, `nurikabe`, `heyawake`, `hashi` (the 8 with a `_cloneResult`). Verify each matches the canonical body before swapping.
- `timeUp` consumers: `hitori`, `kakurasu`, `kurodoko`, `mosaic`, `norinori`, `nurikabe`, `heyawake`, `hashi` (the 8 with a `_timeUp`). The helper takes explicit args, so per-solver field names don't matter as long as the body matches.
- `lruSet`: the evict-oldest-then-set block inside `_storeInCache`/`_storeInPartialCache`. Many solvers have a cache; only swap solvers whose eviction block matches the canonical pattern (verify from source).

---

## Task 1: Add `emitGrid` and swap the grid solvers

**Files:**
- Modify: `src/solvers/shared.js`
- Modify: `src/solvers/{hitori,kakurasu,kurodoko,mosaic,norinori,nurikabe,heyawake}.js`
- Modify: `tests/shared-utils.test.js`

**Canonical `_emit` body (verified byte-identical across the 7 grid solvers):**
```js
_emit() {
  const grid = [];
  for (let r = 0; r < this.rows; r++) {
    const row = new Array(this.cols);
    for (let c = 0; c < this.cols; c++) row[c] = this.cellStatus[r * this.cols + c];
    grid.push(row);
  }
  return grid;
}
```

- [ ] **Step 1: Add the helper to `src/solvers/shared.js`**

Insert before the CJS export tail:
```js
// Rebuild a 1-D cellStatus array into a rows×cols 2-D grid (the shape every
// grid solver's _emit() returns).
function emitGrid(cellStatus, rows, cols) {
  const grid = [];
  for (let r = 0; r < rows; r++) {
    const row = new Array(cols);
    for (let c = 0; c < cols; c++) row[c] = cellStatus[r * cols + c];
    grid.push(row);
  }
  return grid;
}
```
And add `emitGrid` to the `module.exports = { ... }` object.

- [ ] **Step 2: Add a unit test for the helper**

Append to `tests/shared-utils.test.js`:
```js
test('emitGrid rebuilds a 1-D cellStatus into a 2-D grid', () => {
  const cs = [1, 2, 0, 0, 1, 2]; // 2 rows × 3 cols
  assert.deepEqual(solverShared.emitGrid(cs, 2, 3), [[1, 2, 0], [0, 1, 2]]);
});
```
Run: `node --test tests/shared-utils.test.js` → all pass.

- [ ] **Step 3: Swap each of the 7 grid solvers**

In EACH of `hitori, kakurasu, kurodoko, mosaic, norinori, nurikabe, heyawake`:
1. First confirm the file's `_emit()` matches the canonical body above (it should — verified for mosaic/hitori/nurikabe; check the others). If one differs, STOP and report DONE_WITH_CONCERNS naming the file.
2. Ensure `const { hashFNV1a } = require('./shared.js');` already exists at the top (added during the FNV work). Change it to also import emitGrid: `const { hashFNV1a, emitGrid } = require('./shared.js');`
3. Replace the `_emit()` method body with:
```js
  _emit() {
    return emitGrid(this.cellStatus, this.rows, this.cols);
  }
```

Do NOT touch `slitherlink.js` or `hashi.js` (different `_emit` shapes).

- [ ] **Step 4: Run the full gate**

Run: `npm run build && npm test && npm run lint && npm run typecheck`
Expected: build writes both bundles; all tests pass (every grid solver's fuzz test exercises `_emit` via `solve()` — green means behavior-preserved); 0 lint errors; typecheck clean.

Also confirm the bundle strips the require and the guard held: `grep -c "require('./shared.js')" dist/solver.js` → `0`.

- [ ] **Step 5: Commit**

```bash
jj commit -m "refactor(solvers): extract _emit grid rebuild to shared emitGrid"
```
(End the message with a blank line then: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`)

---

## Task 2: Add `cloneSolveResult` and swap

**Files:**
- Modify: `src/solvers/shared.js`
- Modify: the `_cloneResult`-bearing solvers (verify list: `hitori, kakurasu, kurodoko, mosaic, norinori, nurikabe, heyawake, hashi`)
- Modify: `tests/shared-utils.test.js`

**Canonical `_cloneResult` body (from mosaic.js):**
```js
_cloneResult(r) {
  return {
    solved: r.solved,
    grid: r.grid ? r.grid.map(row => row.slice()) : null,
    ...(r.error !== undefined ? { error: r.error } : {}),
    ...(r.partial !== undefined ? { partial: r.partial } : {}),
  };
}
```

- [ ] **Step 1: Add the helper to `src/solvers/shared.js`**

```js
// Deep-clone a grid solve result (grid deep-copied, solved/error/partial
// preserved). Matches every grid solver's _cloneResult.
function cloneSolveResult(r) {
  return {
    solved: r.solved,
    grid: r.grid ? r.grid.map(row => row.slice()) : null,
    ...(r.error !== undefined ? { error: r.error } : {}),
    ...(r.partial !== undefined ? { partial: r.partial } : {}),
  };
}
```
Add `cloneSolveResult` to `module.exports`.

- [ ] **Step 2: Add a unit test**

```js
test('cloneSolveResult deep-copies grid and preserves flags', () => {
  const src = { solved: true, grid: [[1, 2], [0, 1]], partial: true };
  const out = solverShared.cloneSolveResult(src);
  assert.deepEqual(out, src);
  out.grid[0][0] = 9;
  assert.equal(src.grid[0][0], 1); // deep copy, not shared
  assert.ok(!('error' in solverShared.cloneSolveResult({ solved: false, grid: null })));
});
```
Run: `node --test tests/shared-utils.test.js` → all pass.

- [ ] **Step 3: Verify + swap each solver**

For EACH of `hitori, kakurasu, kurodoko, mosaic, norinori, nurikabe, heyawake, hashi`:
1. Confirm its `_cloneResult` matches the canonical body. **Note:** `hashi`'s result uses `edges` rather than `grid` — check `hashi.js`'s `_cloneResult`; if it clones `edges` (not `grid`), it does NOT match `cloneSolveResult` → EXCLUDE hashi and report it. Only swap solvers whose `_cloneResult` is the exact grid-form body above.
2. Add `cloneSolveResult` to the file's `require('./shared.js')` destructure.
3. Replace the method body with:
```js
  _cloneResult(r) {
    return cloneSolveResult(r);
  }
```

- [ ] **Step 4: Full gate**

Run: `npm run build && npm test && npm run lint && npm run typecheck` → all green.

- [ ] **Step 5: Commit**

```bash
jj commit -m "refactor(solvers): extract _cloneResult to shared cloneSolveResult"
```
(+ Co-Authored-By trailer.)

---

## Task 3: Add `timeUp` and swap

**Files:**
- Modify: `src/solvers/shared.js`
- Modify: the `_timeUp`-bearing solvers (`hitori, kakurasu, kurodoko, mosaic, norinori, nurikabe, heyawake, hashi`)
- Modify: `tests/shared-utils.test.js`

**Canonical `_timeUp` body:**
```js
_timeUp() {
  if (this.maxMs <= 0) return false;
  return (Date.now() - this._startedAt) > this.maxMs;
}
```

- [ ] **Step 1: Add the helper**

```js
// Soft wall-clock budget check. maxMs <= 0 means unlimited.
function timeUp(maxMs, startedAt) {
  if (maxMs <= 0) return false;
  return (Date.now() - startedAt) > maxMs;
}
```
Add `timeUp` to `module.exports`.

- [ ] **Step 2: Add a unit test**

```js
test('timeUp: unlimited when maxMs <= 0, else compares elapsed', () => {
  assert.equal(solverShared.timeUp(0, 0), false);
  assert.equal(solverShared.timeUp(-1, 0), false);
  assert.equal(solverShared.timeUp(1000, Date.now()), false);   // just started
  assert.equal(solverShared.timeUp(10, Date.now() - 1000), true); // long over
});
```
Run: `node --test tests/shared-utils.test.js` → all pass.

- [ ] **Step 3: Verify + swap each solver**

For EACH of the 8 solvers: confirm `_timeUp` matches the canonical body, confirm the field names it reads (`this.maxMs` and `this._startedAt` — but a couple of solvers may name them differently; read each). Add `timeUp` to the require destructure, and replace the body with the call using THAT solver's actual field names, e.g.:
```js
  _timeUp() {
    return timeUp(this.maxMs, this._startedAt);
  }
```
If a solver uses different field names (e.g. `this.startedAt` without underscore), pass those instead — the helper takes explicit args. If a solver's `_timeUp` body differs structurally, EXCLUDE it and report.

- [ ] **Step 4: Full gate**

Run: `npm run build && npm test && npm run lint && npm run typecheck` → all green.

- [ ] **Step 5: Commit**

```bash
jj commit -m "refactor(solvers): extract _timeUp to shared timeUp"
```
(+ Co-Authored-By trailer.)

---

## Task 4: Add `lruSet` and swap the cache-eviction block

**Files:**
- Modify: `src/solvers/shared.js`
- Modify: the solvers whose `_storeInCache`/`_storeInPartialCache` uses the canonical evict-oldest pattern
- Modify: `tests/shared-utils.test.js`

**Canonical eviction block (from mosaic.js `_storeInCache`):**
```js
_storeInCache(key, result) {
  const m = result.partial ? MosaicSolver._partialCache : MosaicSolver._solutionCache;
  const max = result.partial ? MosaicSolver._maxPartialCache : MosaicSolver._maxSolutionCache;
  if (m.size >= max) {
    const first = m.keys().next().value;
    m.delete(first);
  }
  m.set(key, this._cloneResult(result));
}
```
The **shared part** is the `if (m.size >= max) { … } m.set(key, value)` eviction+set. The cache-selection lines (`const m = …; const max = …;`) and the value (`this._cloneResult(result)` vs a solver-specific clone) stay in each solver.

- [ ] **Step 1: Add the helper**

```js
// Insertion-order LRU set: evict the oldest entry when at capacity, then set.
// (Map preserves insertion order, so keys().next() is the oldest.)
function lruSet(map, maxSize, key, value) {
  if (map.size >= maxSize) {
    map.delete(map.keys().next().value);
  }
  map.set(key, value);
}
```
Add `lruSet` to `module.exports`.

- [ ] **Step 2: Add a unit test**

```js
test('lruSet evicts the oldest entry at capacity', () => {
  const m = new Map();
  solverShared.lruSet(m, 2, 'a', 1);
  solverShared.lruSet(m, 2, 'b', 2);
  solverShared.lruSet(m, 2, 'c', 3); // evicts 'a'
  assert.deepEqual([...m.keys()], ['b', 'c']);
  assert.equal(m.get('c'), 3);
  // updating an existing key at capacity still works (size not exceeded)
  solverShared.lruSet(m, 2, 'b', 20);
  assert.equal(m.get('b'), 20);
});
```
Run: `node --test tests/shared-utils.test.js` → all pass.

- [ ] **Step 3: Discover + swap**

Run `grep -rln "m.size >= max\|keys().next().value" src/solvers/*.js` to find solvers using the eviction pattern. For EACH whose `_storeInCache` (or `_storeInPartialCache`) contains the canonical `if (m.size >= max) { const first = m.keys().next().value; m.delete(first); } m.set(...)` block:
1. Add `lruSet` to the require destructure.
2. Replace the eviction+set lines with `lruSet(m, max, key, <the existing value expression>);` keeping the `const m = …; const max = …;` selection lines and the exact value expression (e.g. `this._cloneResult(result)` or slitherlink's edge-clone) unchanged.

Only swap solvers whose block matches exactly. If a solver's store logic differs (e.g. no max, or a different eviction), EXCLUDE it and note it in the report. Slitherlink stores `{horizontal, vertical}` clones — its value expression differs but the eviction block may still match; if so, swap it keeping its own value expression.

- [ ] **Step 4: Full gate**

Run: `npm run build && npm test && npm run lint && npm run typecheck` → all green. The fuzz suites that hit the cache (e.g. repeated solves) exercise this; green means behavior preserved.

- [ ] **Step 5: Commit**

```bash
jj commit -m "refactor(solvers): extract cache eviction to shared lruSet"
```
(+ Co-Authored-By trailer.)

---

## Task 5: Update CLAUDE.md + final verification

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Extend the shared-utils note**

In `CLAUDE.md`'s "### Shared utilities + bundler require-strip" subsection, update the helper list from "(currently `hashFNV1a`)" to reflect the new helpers, e.g.: "dependency-free helpers (`hashFNV1a`, `emitGrid`, `cloneSolveResult`, `timeUp`, `lruSet`)."

- [ ] **Step 2: Final full gate**

Run: `npm run build && npm test && npm run lint && npm run typecheck`
Expected: all green. Note the test count should have grown by the new shared-utils unit tests.

Confirm dedup is realized: `grep -rl "this.cellStatus\[r \* this.cols" src/solvers/*.js` should no longer list the 7 swapped grid solvers' `_emit` (only any that legitimately inline it elsewhere).

- [ ] **Step 3: Commit**

```bash
jj commit -m "docs: list emitGrid/cloneSolveResult/timeUp/lruSet in shared-utils note"
```
(+ Co-Authored-By trailer.)

---

## Self-Review notes (for the executor)

- **No characterization test per helper:** unlike cache keys (persisted → needed `cachekey-parity`), these helpers are internal to `solve()` and fully exercised by the 15 per-solver fuzz suites. A green `npm test` after each swap IS the behavior proof. The new `tests/shared-utils.test.js` cases verify the helpers themselves in isolation.
- **Verify-from-source before swapping:** every task says to confirm the solver's current method matches the canonical body and to EXCLUDE/report any that differ (the FNV work showed per-solver variation is common — e.g. slitherlink/hashi `_emit` shapes, hashi result `edges`).
- **Bundler safety:** the require-strip + fail-loud guards already exist from the FNV work; a green `npm run build` confirms no `require('./shared.js')` survives.
- **jj only:** every commit uses `jj commit`, never `git`.
