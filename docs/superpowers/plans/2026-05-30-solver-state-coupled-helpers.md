# Solver state-coupled helpers (whiteConnectivity / trail / collectChangedCells) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the remaining duplicated solver internals into `src/solvers/shared.js`: the ~90-line Tarjan `whiteConnectivity` (hitori + kurodoko), the trail encode/decode (`trailPush` / `rollbackTrail`), and the `getHint` change-collector (`collectChangedCells`).

**Architecture:** These are internal to `solve()`/`getHint()` and fully exercised by the per-solver fuzz suites + the per-puzzle-module hint tests, so the existing test suite is the behavior oracle. Helpers go into the existing `src/solvers/shared.js` (already bundler-wired). `whiteConnectivity` and `rollbackTrail` are byte-identical extractions; `trailPush` is on the hot path so it carries a benchmark gate; `collectChangedCells` replaces the genuinely-uniform piece of the `getHint` preamble (the full preamble does NOT factor — see below).

**Tech Stack:** Node.js (`node:test`), CommonJS, `build-solver-bundle.js` concatenator, the `tests/bench-real.js` benchmark. Version control: **`jj`, never `git`**.

**Source spec:** `docs/superpowers/specs/2026-05-29-solver-shared-utils-design.md` (this is the spec's Phase 2, adjusted by what the code actually supports).

**Important scope adjustment — `runHintPreamble` is NOT extracted.** The spec proposed a single `runHintPreamble(solver, initialState)`. Grounding shows the 7 grid solvers' `getHint` preambles genuinely differ: mosaic has no clue-reassertion; kurodoko forces clue cells to white via `_set` *between* the field reset and the `before` snapshot; nurikabe direct-assigns `this.cellStatus[clue.idx] = 2` and uses `this.N` instead of `rows*cols`. The `before` snapshot must come *after* each solver's clue handling, and clue handling varies (none / `_set` / direct-assign / different field names). Factoring this would need more callbacks/config than the duplication it removes. Instead, Task 3 extracts `collectChangedCells` — the one uniform piece (the `collectChanged` closure body), which every preamble shares.

**Established facts (from grounding):**
- `hitori._applyConnectivity()` and `kurodoko._applyConnectivity()` are byte-identical except comments. Both: find first white (status 2) as anchor; BFS reachability over `{white ∪ unknown}` (status !== 1); if any known white unreachable → `false`; early-out `if (this._inLookahead) return true`; iterative Tarjan articulation; force "critical" unknown cells to white via `this._set(u, 2)`; return `true`. cellStatus encoding: 1 = black, 2 = white, 0 = unknown.
- `_rollback(mark)` is byte-identical across hitori, kurodoko, mosaic, norinori, heyawake, nurikabe, kakurasu, slitherlink: `while (this.trail.length > mark) { const e = this.trail.pop(); const i = e & 0xffffff; const old = (e >>> 24) & 0xff; this.cellStatus[i] = old; }`.
- The trail encode is `this.trail.push(idx | (old << 24))` inside each `_set`.
- The `getHint` `collectChanged` closure is uniform: collect `{row, col, value}` for cells that went from 0 (in `before`) to nonzero (in `cellStatus`).

---

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `src/solvers/shared.js` | Modify | Add `whiteConnectivity`, `trailPush`, `rollbackTrail`, `collectChangedCells`. |
| `src/solvers/{hitori,kurodoko}.js` | Modify | `_applyConnectivity` → `whiteConnectivity`. |
| `src/solvers/{hitori,kurodoko,mosaic,norinori,heyawake,nurikabe,kakurasu,slitherlink}.js` | Modify | `_rollback`/`_set` trail → `rollbackTrail`/`trailPush`. |
| grid solvers with a `getHint` | Modify | `collectChanged` closure → `collectChangedCells`. |
| `tests/shared-utils.test.js` | Modify | Unit tests for each helper. |
| `CLAUDE.md` | Modify | Extend the shared-utils note. |

---

## Task 1: Extract `whiteConnectivity` (hitori + kurodoko)

**Files:**
- Modify: `src/solvers/shared.js`, `src/solvers/hitori.js`, `src/solvers/kurodoko.js`, `tests/shared-utils.test.js`

The helper takes the cellStatus array, dims, the `inLookahead` flag, and a `set(idx, value)` callback (the solver's `_set`, used to force critical cells). It returns `true` (consistent / forced) or `false` (contradiction).

- [ ] **Step 1: Add the helper to `src/solvers/shared.js`** (before the CJS export tail).

Copy the EXACT body of `hitori._applyConnectivity()` (read `src/solvers/hitori.js` lines ~163-254), with these mechanical substitutions: `this.cellStatus` → `cellStatus`, `this.rows` → `rows`, `this.cols` → `cols`, `this._inLookahead` → `inLookahead`, and the two `this._set(u, 2)` / `this._set(...)` calls → `set(u, 2)`. Wrap as:
```js
// White-region connectivity for Hitori/Kurodoko (cellStatus: 1=black, 2=white,
// 0=unknown). Anchors on the first white, BFS-checks all known whites are
// reachable through {white ∪ unknown}, then (outside lookahead) runs iterative
// Tarjan articulation and forces any unknown cell whose removal would split the
// known whites to white via set(idx, 2). Returns false on contradiction.
function whiteConnectivity(cellStatus, rows, cols, inLookahead, set) {
  const total = rows * cols;
  let anchor = -1;
  for (let i = 0; i < total; i++) {
    if (cellStatus[i] === 2) { anchor = i; break; }
  }
  if (anchor < 0) return true;
  // ... (paste the rest of hitori's body verbatim with the substitutions above)
  return true;
}
```
Add `whiteConnectivity` to `module.exports`.

- [ ] **Step 2: Add a unit test to `tests/shared-utils.test.js`.**

```js
test('whiteConnectivity: passes a connected board, fails a split one, forces a cut cell', () => {
  // 1×5 strip, white at both ends, black in middle would split → unreachable white.
  // cellStatus 1=black 2=white 0=unknown. Layout: [white, unknown, black, unknown, white]
  const split = [2, 0, 1, 0, 2];
  assert.equal(solverShared.whiteConnectivity(split, 1, 5, true, () => true), false);

  // Connected: [white, unknown, unknown, unknown, white] is fine in lookahead.
  const ok = [2, 0, 0, 0, 2];
  assert.equal(solverShared.whiteConnectivity(ok, 1, 5, true, () => true), true);

  // Articulation forcing (outside lookahead): the single unknown bridging two
  // whites in [2,0,2] must be forced white via set().
  const forced = [];
  const board = [2, 0, 2];
  const res = solverShared.whiteConnectivity(board, 1, 3, false, (idx, v) => { forced.push([idx, v]); board[idx] = v; return true; });
  assert.equal(res, true);
  assert.deepEqual(forced, [[1, 2]]);
});
```
Run `node --test tests/shared-utils.test.js` → all pass. (If the exact forcing assertion is environment-sensitive, keep the connected/split assertions which are the core invariant, and adjust the forcing case to match observed behavior — but do NOT weaken the connected/split checks.)

- [ ] **Step 3: Swap hitori.** In `src/solvers/hitori.js`: add `whiteConnectivity` to the `require('./shared.js')` destructure. Replace the entire `_applyConnectivity()` method with:
```js
  _applyConnectivity() {
    return whiteConnectivity(this.cellStatus, this.rows, this.cols, this._inLookahead, (idx, v) => this._set(idx, v));
  }
```

- [ ] **Step 4: Swap kurodoko** identically: add `whiteConnectivity` to its `require('./shared.js')` destructure and replace its `_applyConnectivity()` with the same body as Step 3.

- [ ] **Step 5: Full gate.**
Run: `npm run build && npm test && npm run lint && npm run typecheck`
Expected: build writes both bundles; ALL tests pass (especially `tests/hitori-fuzz.test.js` and `tests/kurodoko-fuzz.test.js` — they exercise `_applyConnectivity` through `solve()`, so green = behavior preserved); 0 lint errors; typecheck clean.
Also: `grep -c "require('./shared.js')" dist/solver.js` → `0`.

If a fuzz test fails, your paste/substitution diverged from the original — diff against the original `_applyConnectivity`. Do NOT weaken tests.

- [ ] **Step 6: Commit.**
```bash
jj commit -m "refactor(solvers): extract hitori/kurodoko _applyConnectivity to shared whiteConnectivity"
```
(End with a blank line then `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.)

---

## Task 2: Extract `rollbackTrail` + `trailPush` (benchmark-gated)

**Files:**
- Modify: `src/solvers/shared.js`, the 8 trail solvers, `tests/shared-utils.test.js`

**The duplicated `_rollback` body (byte-identical across 8 solvers):**
```js
_rollback(mark) {
  while (this.trail.length > mark) {
    const e = this.trail.pop();
    const i = e & 0xffffff;
    const old = (e >>> 24) & 0xff;
    this.cellStatus[i] = old;
  }
}
```
**The trail encode (inside each `_set`):** `this.trail.push(idx | (old << 24));`

- [ ] **Step 1: Add both helpers to `src/solvers/shared.js`.**
```js
// Trail-based undo (shared by the grid solvers). An entry packs the cell index
// (low 24 bits) and the previous value (next 8 bits): idx | (old << 24).
function trailPush(trail, idx, old) {
  trail.push(idx | (old << 24));
}
// Undo every trail entry back to `mark`, restoring each cell's previous value.
function rollbackTrail(trail, cellStatus, mark) {
  while (trail.length > mark) {
    const e = trail.pop();
    cellStatus[e & 0xffffff] = (e >>> 24) & 0xff;
  }
}
```
Add `trailPush, rollbackTrail` to `module.exports`.

- [ ] **Step 2: Unit test in `tests/shared-utils.test.js`.**
```js
test('trailPush + rollbackTrail round-trip cell values', () => {
  const trail = [];
  const cs = [5, 7, 9];
  solverShared.trailPush(trail, 0, cs[0]); cs[0] = 1;
  solverShared.trailPush(trail, 2, cs[2]); cs[2] = 1;
  assert.deepEqual(cs, [1, 7, 1]);
  solverShared.rollbackTrail(trail, cs, 1); // undo back to mark 1 (the 2nd push)
  assert.deepEqual(cs, [1, 7, 9]);
  solverShared.rollbackTrail(trail, cs, 0); // undo the rest
  assert.deepEqual(cs, [5, 7, 9]);
  assert.equal(trail.length, 0);
});
```
Run `node --test tests/shared-utils.test.js` → all pass.

- [ ] **Step 3: Swap `_rollback` in all 8 solvers** (`hitori, kurodoko, mosaic, norinori, heyawake, nurikabe, kakurasu, slitherlink`). In EACH: confirm its `_rollback` matches the canonical body, add `rollbackTrail` to its `require('./shared.js')` destructure, and replace the method body with:
```js
  _rollback(mark) {
    rollbackTrail(this.trail, this.cellStatus, mark);
  }
```
If a solver's `_rollback` differs (e.g. extra bookkeeping), EXCLUDE it and report.

- [ ] **Step 4: Swap the trail encode in each `_set`.** In each of the same 8 solvers, add `trailPush` to the destructure and replace the line `this.trail.push(idx | (old << 24));` with `trailPush(this.trail, idx, old);`. Leave the rest of `_set` (e.g. hitori/kurodoko's adjacent-forcing) unchanged.

- [ ] **Step 5: Correctness gate.**
Run: `npm run build && npm test && npm run lint && npm run typecheck` → all green.

- [ ] **Step 6: Benchmark gate (hot-path check).** `_set`/`_rollback` are the hottest solver paths. Capture a baseline from the pre-Task-2 revision and compare:
```bash
# Baseline = the committed solver bundle BEFORE this task (Task 1's commit).
jj file show -r @- solver.js  # confirm the shim; the real source is src/solvers
node tests/bench-real.js   # run on current (post-swap) tree, note the per-puzzle ms
```
Run `node tests/bench-real.js` 3 times on the current tree and note timings. Then check out the parent commit's `src/solvers` state into a scratch copy and run the same bench, OR use the project's documented method: `jj file show -r <task1-change-id> <each swapped file> > /tmp/<file>.baseline`, diff timings. Expected: **no statistically meaningful regression** (bench-real discards 2 warmup iters; treat >10% slowdown on hitori/kurodoko/mosaic as a regression).

**If `trailPush` causes a >10% regression** on any solver: revert ONLY the Step-4 trail-encode swap (keep `rollbackTrail` from Step 3, which is per-backtrack and safe), remove `trailPush` from `module.exports` and `shared.js`, and note it. If no regression, keep both.

- [ ] **Step 7: Commit.**
```bash
jj commit -m "refactor(solvers): extract trail undo to shared rollbackTrail/trailPush"
```
(+ trailer. If trailPush was reverted per Step 6, adjust the message to mention only rollbackTrail.)

---

## Task 3: Extract `collectChangedCells` (the getHint change-collector)

**Files:**
- Modify: `src/solvers/shared.js`, the grid solvers with a `getHint`, `tests/shared-utils.test.js`

**The uniform closure (from mosaic.js getHint):**
```js
const collectChanged = () => {
  const out = [];
  for (let i = 0; i < total; i++) {
    if (before[i] === 0 && this.cellStatus[i] !== 0) {
      const r = (i / this.cols) | 0;
      const c = i - r * this.cols;
      out.push({ row: r, col: c, value: this.cellStatus[i] });
    }
  }
  return out;
};
```

- [ ] **Step 1: Add the helper.**
```js
// getHint change-collector: cells that went from 0 (in `before`) to a nonzero
// value (in `cellStatus`), as {row, col, value}. before.length defines the cell
// count, so callers don't pass rows explicitly.
function collectChangedCells(cellStatus, before, cols) {
  const out = [];
  for (let i = 0; i < before.length; i++) {
    if (before[i] === 0 && cellStatus[i] !== 0) {
      const r = (i / cols) | 0;
      out.push({ row: r, col: i - r * cols, value: cellStatus[i] });
    }
  }
  return out;
}
```
Add `collectChangedCells` to `module.exports`.

- [ ] **Step 2: Unit test.**
```js
test('collectChangedCells reports 0→nonzero cells as {row,col,value}', () => {
  const before = new Uint8Array([0, 0, 1, 0]); // 2×2
  const after  = [0, 2, 1, 1];                 // idx1: 0→2, idx3: 0→1; idx2 was already 1
  assert.deepEqual(solverShared.collectChangedCells(after, before, 2), [
    { row: 0, col: 1, value: 2 },
    { row: 1, col: 1, value: 1 },
  ]);
});
```
Run `node --test tests/shared-utils.test.js` → all pass.

- [ ] **Step 3: Discover + swap.** Run `grep -rln "collectChanged" src/solvers/*.js` to find the grid solvers whose `getHint` defines the `collectChanged` closure. For EACH:
1. Confirm its `collectChanged` body matches the canonical closure (modulo `total` vs `this.N` — both equal the cell count, which `before.length` captures).
2. Add `collectChangedCells` to the file's `require('./shared.js')` destructure.
3. Replace the `const collectChanged = () => { ... };` definition with:
```js
    const collectChanged = () => collectChangedCells(this.cellStatus, before, this.cols);
```
(Keep the variable name `collectChanged` and all call sites unchanged — only the closure body changes.)
4. If a solver's `collectChanged` differs structurally (e.g. emits a different shape, or filters differently), EXCLUDE it and report.

- [ ] **Step 4: Full gate.**
Run: `npm run build && npm test && npm run lint && npm run typecheck` → all green. The per-puzzle-module hint tests + the integration tests exercise `getHint`, so green = behavior preserved.

- [ ] **Step 5: Commit.**
```bash
jj commit -m "refactor(solvers): extract getHint change-collector to shared collectChangedCells"
```
(+ trailer.)

---

## Task 4: Docs + final verification

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Extend the shared-utils note.** In `CLAUDE.md`'s "### Shared utilities + bundler require-strip" subsection, add the new helpers to the listed set (so it reads e.g. "…`emitGrid`, `cloneSolveResult`, `timeUp`, `lruSet`, `whiteConnectivity`, `rollbackTrail`/`trailPush`, `collectChangedCells`").

- [ ] **Step 2: Final full gate.**
Run: `npm run build && npm test && npm run lint && npm run typecheck` → all green.
Confirm exports: `node -e "console.log(Object.keys(require('./src/solvers/shared.js')).sort().join(','))"` → should include `whiteConnectivity`, `rollbackTrail`, `collectChangedCells` (and `trailPush` unless reverted in Task 2).

- [ ] **Step 3: Commit.**
```bash
jj commit -m "docs: list whiteConnectivity/trail/collectChangedCells in shared-utils note"
```
(+ trailer.)

---

## Self-Review notes (for the executor)

- **No characterization test needed:** these are internal to `solve()`/`getHint()` and exercised by the fuzz suites + hint tests; a green `npm test` after each swap is the behavior proof. The new `tests/shared-utils.test.js` cases verify the helpers in isolation.
- **`whiteConnectivity` is a verbatim paste** of hitori's `_applyConnectivity` with `this.`→params and `this._set`→`set`. Diff against the original if a fuzz test fails.
- **`trailPush` is the only perf risk** (hot path); Task 2 Step 6 benchmarks it and reverts just that piece if it regresses, keeping `rollbackTrail`.
- **`runHintPreamble` is intentionally NOT extracted** — preambles differ in clue-reassertion/ordering/field names; `collectChangedCells` captures the uniform piece instead.
- **Verify-from-source before swapping** every solver; EXCLUDE + report any that differ.
- **jj only** for commits.
