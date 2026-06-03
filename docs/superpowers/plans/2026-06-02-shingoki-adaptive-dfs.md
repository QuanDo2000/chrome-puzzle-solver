# Shingoki Adaptive-DFS Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `ShingokiSolver`'s regressed CDCL search with a single adaptive backtracking (DFS) engine that solves realistic clued boards fast (loop-aware) and ultra-sparse boards via a constraint-focused fallback, returning a sound root-propagation partial on a short timeout.

**Architecture:** One recursive DFS over edge values, built on the existing sound primitives (`_propagate`, the trail, the structural prunes, `_isValidComplete`). An adaptive `_pickBranch()` extends committed chains where they exist, else probes for the most-constrained edge. On a `searchMs` deep-search cap (~6 s) it unwinds via a thrown sentinel and `solve()` returns the level-0 propagation snapshot. All CDCL/VSIDS/restart/clause-learning machinery (~600 lines) is deleted once the DFS is green.

**Tech Stack:** Plain JS (`src/solvers/shingoki.js`), `node:test`, `jj` for version control. Spec: `docs/superpowers/specs/2026-06-02-shingoki-adaptive-dfs-design.md`.

**IMPORTANT — version control:** This repo uses **`jj`, never `git`**. Commit with `jj commit -m "msg"`. End every commit message with the trailer:
```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

**Soundness discipline (read before starting):** Branching order and decision *phase* (which value is tried first) are **sound-neutral** — they only change search speed, never correctness. The correctness guarantees come entirely from the unchanged `_propagate` + structural prunes + `_isValidComplete`. The one correctness-critical invariant to preserve exactly: **only a budget timeout yields a `partial`; full tree exhaustion returns `error: 'no solution'`**. Never let a budget bail masquerade as UNSAT or vice-versa.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/solvers/shingoki.js` | The solver | Add `_pickBranch`, `_pickConstrainedEdge`, `_probePropagationCount`, `_otherVal`, `_dfs`; rewrite `solve()`; add `searchMs` ctor option; later delete all CDCL machinery + update header |
| `tests/shingoki.test.js` | Solver tests | Remove CDCL-internal tests + stagnation tests; repoint public tests off the "CDCL" name; add the 7×7-hard regression test |
| `tests/fixtures/real-puzzles.js` | Real captures | Add `shingoki_7x7_hard` fixture |
| `tests/bench-shingoki.js` | Bench ladder | No logic change; confirm it runs the DFS |
| `solver.worker.js` | Worker dispatch | No change (confirm `maxMs: 30000`, no CDCL-only options) |
| `CLAUDE.md` | Project notes | Replace the Shingoki CDCL note with the adaptive-DFS description |

The new engine sits behind `solve()`. During Tasks 1–3 the CDCL methods still exist but are unreferenced (the DFS calls `_initState`, not `_cdclInit`, so `this._cdcl` stays falsy and the CDCL branches inside `_propagate`/`setEdge` are skipped). Task 4 deletes the dead code.

---

### Task 1: Adaptive branch selection (`_pickBranch` + helpers)

**Files:**
- Modify: `src/solvers/shingoki.js` (add methods near the other search helpers, e.g. after `_firstUnassignedEdge` around line 904)
- Test: `tests/shingoki.test.js`

Pure selection logic over the current edge state. No search yet. SOUND-NEUTRAL.

- [ ] **Step 1: Write the failing tests**

Add at the end of `tests/shingoki.test.js`:

```js
test('Shingoki DFS: _pickBranch extends a chain endpoint, LINE first', () => {
  // 3x3 vertices (2x2 cells). Put one committed LINE so vertex (0,0) has
  // exactly one line and >=1 unknown incident edge -> a chain endpoint.
  const s = new ShingokiSolver({ rows: 2, cols: 2, task: [[0,0,0],[0,0,0],[0,0,0]] });
  s._initState();
  s.setEdge({ kind: 'H', r: 0, c: 0 }, 1); // line between (0,0)-(0,1)
  const br = s._pickBranch();
  assert.ok(br, 'must return a branch');
  // (0,0) now has 1 line (H 0,0) and unknown V(0,0); the branch must be an
  // unknown edge incident to a chain endpoint, tried LINE(1) first.
  assert.equal(br.firstVal, 1);
  assert.equal(s.getEdge(br.ref), 0, 'branch edge must currently be unknown');
});

test('Shingoki DFS: _pickBranch returns null when all edges are assigned', () => {
  const s = new ShingokiSolver({ rows: 1, cols: 1, task: [[0,0],[0,0]] });
  s._initState();
  for (const e of s._allEdgeRefs()) s.setEdge(e, 2); // all crossed
  assert.equal(s._pickBranch(), null);
});

test('Shingoki DFS: _pickBranch picks a clued-incident edge when no chain exists', () => {
  // No committed lines anywhere, one white clue at (0,1). The constraint-focused
  // branch must return an unknown edge incident to a clued vertex, LINE first.
  const s = new ShingokiSolver({ rows: 2, cols: 2, task: [[0,2,0],[0,0,0],[0,0,0]] });
  s._initState();
  const br = s._pickBranch();
  assert.ok(br, 'must return a branch');
  assert.equal(br.firstVal, 1);
  const eps = s._endpoints(br.ref);
  assert.ok(eps.some(v => s.task[v.r][v.c] !== 0), 'edge must touch a clued vertex');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test --test-name-pattern='_pickBranch' tests/shingoki.test.js`
Expected: FAIL — `s._pickBranch is not a function`.

- [ ] **Step 3: Implement the selection methods**

Insert into the `ShingokiSolver` class (after `_firstUnassignedEdge`):

```js
  // Flip a decision value: LINE(1) <-> CROSS(2).
  _otherVal(v) { return v === 1 ? 2 : 1; }

  // Adaptive branch selection. Returns { ref, firstVal } for the next edge to
  // assign, or null when every edge is assigned. SOUND-NEUTRAL: affects only
  // search order/speed, never correctness.
  _pickBranch() {
    const { rows, cols } = this;
    // 1) Loop-aware: a "chain endpoint" is a vertex with exactly one committed
    //    LINE and >=1 unknown incident edge. Extend it (LINE first) to build the
    //    loop. Prefer a clued chain endpoint (tighter) over an unclued one.
    let chainEdge = null, chainCluedEdge = null;
    for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
      const inc = this.incidentEdges(r, c);
      let lines = 0, unknownRef = null;
      for (const e of inc) {
        const g = this.getEdge(e);
        if (g === 1) lines++;
        else if (g === 0 && !unknownRef) unknownRef = e;
      }
      if (lines === 1 && unknownRef) {
        if (this.task[r][c]) { chainCluedEdge = unknownRef; }
        else if (!chainEdge) { chainEdge = unknownRef; }
      }
    }
    if (chainCluedEdge) return { ref: chainCluedEdge, firstVal: 1 };
    if (chainEdge) return { ref: chainEdge, firstVal: 1 };
    // 2) No chain exists -> constraint-focused choice.
    return this._pickConstrainedEdge();
  }

  // Constraint-focused selection for when no chain endpoint exists (e.g. an
  // ultra-sparse board at the root). Probe-guided: among unknown edges incident
  // to a clued vertex, pick the one whose LINE assignment forces the most
  // propagation (focuses search the way the sparse-board case needs). Falls back
  // to the first unknown edge anywhere. Returns { ref, firstVal:1 } or null.
  _pickConstrainedEdge() {
    const { rows, cols } = this;
    let best = null, bestScore = -1;
    const seen = new Set();
    for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
      if (!this.task[r][c]) continue;
      for (const e of this.incidentEdges(r, c)) {
        if (this.getEdge(e) !== 0) continue;
        const k = e.kind + e.r + ',' + e.c;
        if (seen.has(k)) continue;
        seen.add(k);
        const score = this._probePropagationCount(e, 1);
        if (score > bestScore) { bestScore = score; best = e; }
      }
    }
    if (best) return { ref: best, firstVal: 1 };
    const any = this._firstUnassignedEdge();
    return any ? { ref: any, firstVal: 1 } : null;
  }

  // Edges determined by propagation after tentatively setting `e=val` on a clone
  // of the current state. Returns -1 if that assignment immediately contradicts
  // (so the caller prefers any non-contradicting edge). Mirrors _lookahead1's
  // probe pattern; pure (never mutates this.H/this.V).
  _probePropagationCount(e, val) {
    const probe = new ShingokiSolver({ rows: this.rows, cols: this.cols, task: this.task });
    probe.H = this.H.map(row => row.slice());
    probe.V = this.V.map(row => row.slice());
    let before = 0;
    for (const ref of probe._allEdgeRefs()) if (probe.getEdge(ref) !== 0) before++;
    if (!(probe.setEdge(e, val) && probe._propagate())) return -1;
    let after = 0;
    for (const ref of probe._allEdgeRefs()) if (probe.getEdge(ref) !== 0) after++;
    return after - before;
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test --test-name-pattern='_pickBranch' tests/shingoki.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(shingoki): adaptive branch selection (loop-aware + constraint-focused)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: DFS search + `solve()` switch + root partial + searchMs bail

**Files:**
- Modify: `src/solvers/shingoki.js` — add `SEARCH_BUDGET` sentinel (module scope), add `searchMs` to the constructor, add `_dfs`, rewrite `solve()`
- Test: `tests/shingoki.test.js`

This makes `solve()` run the new engine. CDCL methods remain but are no longer called.

- [ ] **Step 1: Write the failing tests**

Add to `tests/shingoki.test.js`:

```js
test('Shingoki DFS: solves the real 7x7-hard board in a few seconds (regression)', { timeout: 15000 }, () => {
  // The board that motivated replacing CDCL: CDCL timed out (>60s); the DFS
  // solves it fast. Hardcoded from /shingoki/random/7x7-hard (8x8 vertex clues).
  const task = [
    [0,0,-4,0,0,0,0,0],
    [0,0,0,0,0,0,-2,0],
    [-2,0,0,0,-4,-3,0,-3],
    [0,0,0,0,0,0,-4,0],
    [0,0,0,0,0,0,0,0],
    [3,0,0,0,-2,0,0,0],
    [0,-2,0,-3,0,0,0,0],
    [0,2,0,0,-2,0,0,0],
  ];
  const t0 = Date.now();
  const res = new ShingokiSolver({ rows: 7, cols: 7, task, maxMs: 30000 }).solve();
  assert.equal(res.solved, true, 'DFS must solve the real 7x7-hard board');
  assert.ok(Date.now() - t0 < 10000, 'should solve in well under 10s');
  const chk = new ShingokiSolver({ rows: 7, cols: 7, task });
  chk.H = res.horizontal; chk.V = res.vertical;
  assert.equal(chk.numbersSatisfied(), true);
});

test('Shingoki DFS: genuine UNSAT returns no-solution, not a partial', () => {
  // A 3x3 white clue with run length 9 is unreachable on a 3-cell line -> UNSAT.
  const task = [[0,0,0],[0,9,0],[0,0,0]];
  const res = new ShingokiSolver({ rows: 2, cols: 2, task, maxMs: 5000 }).solve();
  assert.equal(res.solved, false);
  assert.equal(res.error, 'no solution');
  assert.notEqual(res.partial, true);
});

test('Shingoki DFS: timeout returns a SOUND flat partial (level-0 only)', () => {
  const fixtures = require('./fixtures/real-puzzles.js');
  const p = fixtures.shingoki_40x40_monthly;
  const res = new ShingokiSolver({ rows: p.rows, cols: p.cols, task: p.task, searchMs: 1000, maxMs: 30000 }).solve();
  if (res.solved) return;
  assert.equal(res.error, 'time limit exceeded');
  assert.equal(res.partial, true);
  assert.ok(res.horizontal && res.vertical);
  const chk = new ShingokiSolver({ rows: p.rows, cols: p.cols, task: p.task });
  chk.H = res.horizontal; chk.V = res.vertical;
  for (let r = 0; r <= p.rows; r++) for (let c = 0; c <= p.cols; c++) {
    const deg = chk.incidentEdges(r, c).filter(e => chk.getEdge(e) === 1).length;
    assert.ok(deg <= 2, `partial vertex (${r},${c}) degree ${deg} > 2 (unsound)`);
  }
});

test('Shingoki DFS: searchMs cap bails well before maxMs on the 40x40', () => {
  const fixtures = require('./fixtures/real-puzzles.js');
  const p = fixtures.shingoki_40x40_monthly;
  const t0 = Date.now();
  const res = new ShingokiSolver({ rows: p.rows, cols: p.cols, task: p.task, searchMs: 2000, maxMs: 30000 }).solve();
  const wall = Date.now() - t0;
  if (!res.solved) {
    assert.equal(res.partial, true);
    assert.ok(wall < 8000, `searchMs cap should bail near 2s, took ${wall}ms`);
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test --test-name-pattern='Shingoki DFS: (solves the real|genuine UNSAT|timeout returns|searchMs cap)' tests/shingoki.test.js`
Expected: FAIL — the 7×7 currently routes through CDCL and times out / `searchMs` is ignored.

- [ ] **Step 3: Add the sentinel + constructor option**

At module scope, just above `class ShingokiSolver {`:

```js
// Thrown by _dfs to unwind to solve() when the deep-search budget expires.
// Distinct object identity so solve() can tell a budget bail from a real error.
const SEARCH_BUDGET = { budget: true };
```

In the constructor, add `searchMs` (keep `stagnationMs` for now — removed in Task 4):

```js
  constructor({ rows, cols, task, maxMs = 0, searchMs = 6000, stagnationMs = 8000 }) {
    this.rows = rows;
    this.cols = cols;
    this.task = task;
    this.maxMs = maxMs;
    // Deep-search budget for the adaptive DFS. When exceeded, solve() returns the
    // sound level-0 propagation partial instead of grinding the full maxMs. The
    // searchMs cap fires first in practice; maxMs is an outer ceiling. Pass 0 to
    // disable searchMs (rely on maxMs only).
    this._searchMs = searchMs;
    this._stagnationMs = stagnationMs;
    this._stagnated = false;
    this._startedAt = 0;
  }
```

- [ ] **Step 4: Rewrite `solve()` and add `_dfs`**

Replace the existing `solve()` (lines ~542–555) with:

```js
  // Public entry: adaptive DFS. Returns { solved, horizontal, vertical, error? }.
  // On a deep-search budget bail it attaches a SOUND partial — the level-0
  // snapshot of edges deduced from the givens alone, captured before any branch.
  // Genuine UNSAT (full tree exhausted) returns error 'no solution', never a
  // partial; only a budget bail yields a partial. The flat slitherlink-shaped
  // partial (top-level horizontal/vertical + partial:true) lets the widget's
  // type-agnostic {horizontal,vertical} partial arm apply it with no
  // shingoki-specific dispatch.
  solve() {
    this._startedAt = Date.now();
    this._initState();
    if (!this._propagate()) {
      return { solved: false, horizontal: null, vertical: null, error: 'contradiction on initial propagation' };
    }
    const rootPartial = { horizontal: this.H.map(r => r.slice()), vertical: this.V.map(r => r.slice()) };
    this._budgetExceeded = false;
    let solved = false;
    try {
      solved = this._dfs();
    } catch (err) {
      if (err !== SEARCH_BUDGET) throw err;
      this._budgetExceeded = true;
    }
    if (solved) {
      return { solved: true, horizontal: this.H.map(r => r.slice()), vertical: this.V.map(r => r.slice()) };
    }
    if (this._budgetExceeded) {
      return {
        solved: false, horizontal: rootPartial.horizontal, vertical: rootPartial.vertical,
        partial: true, error: 'time limit exceeded',
      };
    }
    return { solved: false, horizontal: null, vertical: null, error: 'no solution' };
  }

  // Recursive adaptive DFS with trail-undo. Returns true if a valid complete
  // loop was found below this node, false on a dead branch. Throws SEARCH_BUDGET
  // when the deep-search/maxMs budget expires (unwinds to solve()). The
  // soundness rests entirely on _propagate + the structural prunes +
  // _isValidComplete; branch order is sound-neutral.
  _dfs() {
    if ((this._searchMs > 0 && timeUp(this._searchMs, this._startedAt)) ||
        (this.maxMs > 0 && timeUp(this.maxMs, this._startedAt))) throw SEARCH_BUDGET;
    if (!this._propagate()) return false;
    if (this._hasPrematureLoop() || this._deadByConnectivity()) return false;
    const br = this._pickBranch();
    if (!br) return this._isValidComplete();
    for (const val of [br.firstVal, this._otherVal(br.firstVal)]) {
      const mark = this._trailMark();
      if (this.setEdge(br.ref, val) && this._dfs()) return true;
      this._rollbackTo(mark);
    }
    return false;
  }
```

Note: the very first `_propagate()` runs in `solve()` before capturing `rootPartial`; `_dfs` re-propagates at entry (idempotent — a no-op fixpoint the first time). Leave that; it keeps `_dfs` self-contained for recursion.

- [ ] **Step 5: Run the new tests + the full suite**

Run: `node --test --test-name-pattern='Shingoki DFS' tests/shingoki.test.js`
Expected: PASS (Task 1 + Task 2 DFS tests).

Run: `npm test`
Expected: the CDCL-internal tests still pass (they call methods directly, unaffected); the public solve tests pass. If any public test now fails because a `gen()` board exceeds the default `searchMs: 6000`, do NOT fix it here — Task 3 owns the `gen()` boards. Note which fail and proceed.

- [ ] **Step 6: Commit**

```bash
jj commit -m "feat(shingoki): adaptive DFS engine behind solve() + sound partial bail

solve() now runs the loop-aware/constraint-focused DFS instead of CDCL.
Root-propagation snapshot returned on a searchMs deep-search cap; genuine
UNSAT still returns 'no solution'. CDCL methods remain but unreferenced.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Verify & strengthen the constraint-focused fallback on `gen()` boards

**Files:**
- Modify: `src/solvers/shingoki.js` (only if a heuristic improvement is needed)
- Modify: `tests/shingoki.test.js` (adjust the `gen()` tests' budgets / decision-B relaxation)

The `gen()` rectangle boards (sparse perimeter clues, near-zero root propagation) are the hard case for a loop-aware engine. This task makes them pass or applies the decision-B relaxation.

- [ ] **Step 1: Measure the `gen()` boards with the new DFS**

Write a throwaway probe (delete after): for `n in [10, 15, 20]` and a few seeds, build `gen(n, seed)` (copy the `gen` from the existing test at `tests/shingoki.test.js:705`) and run `new ShingokiSolver({ rows:n, cols:n, task, searchMs: 0, maxMs: 30000 }).solve()` recording `solved` + wall-time.

Run: `node /tmp/sg-gen-probe.js`
Record which boards solve and how fast.

- [ ] **Step 2: Decide based on the measurement**

- **If all `gen()` boards solve within ~3 s:** no solver change. Go to Step 3.
- **If some are slow (3–15 s) but solve:** no solver change; just give those tests an explicit generous `searchMs` (they are synthetic stress, not the product cap). Go to Step 3.
- **If some do NOT solve even with `searchMs: 0` (full `maxMs`):** strengthen `_pickConstrainedEdge`. The likely fix: when probing, ALSO consider CROSS(2) assignments and prefer the edge+value whose probe yields the highest propagation count (a fuller 1-ply lookahead), and have `_pickBranch` set `firstVal` to that winning value. Concretely, replace the body of `_pickConstrainedEdge` to evaluate both values:

```js
  _pickConstrainedEdge() {
    const { rows, cols } = this;
    let best = null, bestVal = 1, bestScore = -1;
    const seen = new Set();
    for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
      if (!this.task[r][c]) continue;
      for (const e of this.incidentEdges(r, c)) {
        if (this.getEdge(e) !== 0) continue;
        const k = e.kind + e.r + ',' + e.c;
        if (seen.has(k)) continue;
        seen.add(k);
        for (const v of [1, 2]) {
          const score = this._probePropagationCount(e, v);
          if (score > bestScore) { bestScore = score; best = e; bestVal = v; }
        }
      }
    }
    if (best) return { ref: best, firstVal: bestVal };
    const any = this._firstUnassignedEdge();
    return any ? { ref: any, firstVal: 1 } : null;
  }
```

Re-measure. If it now solves, keep this; the `firstVal: bestVal` change is still sound-neutral (only orders the two branches). If a single pathological board STILL resists, apply decision B: relax THAT specific assertion to accept a partial and `console.log` (or a test comment) what was dropped — do NOT expand scope.

- [ ] **Step 3: Update the `gen()` tests**

In `tests/shingoki.test.js`, for the three `gen()`-based public tests (currently named `Shingoki solve: never spurious-UNSAT via the public entry`, `Shingoki CDCL: 40x40 monthly never spurious-UNSAT`, `Shingoki CDCL: mid-size constructive boards solve fast and valid`), ensure each `new ShingokiSolver({...})` call passes a `searchMs` large enough for the synthetic board to finish (e.g. `searchMs: 15000`) so the test asserts correctness, not the 6 s product cap. (The 40×40 monthly test deliberately keeps a SHORT budget to assert partial behavior — leave it short.)

- [ ] **Step 4: Run**

Run: `npm test`
Expected: all `gen()`-based tests pass (or the single relaxed pathological case documented). Delete the throwaway probe.

- [ ] **Step 5: Commit**

```bash
jj commit -m "test+perf(shingoki): constraint-focused fallback solves gen() sparse boards

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Delete the dead CDCL machinery

**Files:**
- Modify: `src/solvers/shingoki.js` — remove all CDCL methods, var-encoding, VSIDS, restarts, stagnation, and the `_cdcl` branches in `_propagate`/`setEdge`/`_rollbackTo`
- Modify: `tests/shingoki.test.js` — remove the CDCL-internal + stagnation tests

- [ ] **Step 1: Remove the CDCL-internal tests**

Delete these tests from `tests/shingoki.test.js` (they assert internals being deleted). Identify by name and remove the whole `test(...)` block:
- `Shingoki CDCL: _varId/_decodeVar round-trip for all edges`
- `Shingoki CDCL: setEdge records reason + level on the assignment trail`
- `Shingoki CDCL: degree-forced cross carries its determined-edge antecedents`
- `Shingoki CDCL: contradiction sets _lastConflictReason to the determined edges`
- `Shingoki CDCL: run-cap force reason includes the far run edge ...`
- `Shingoki CDCL skeleton: solves the captured 5x5 with a valid loop`
- `Shingoki CDCL skeleton: never spurious-UNSAT on solvable constructive boards`
- `Shingoki CDCL: run-cap conflict reason includes the run edges`
- `Shingoki CDCL learning: _forceLiteral sets LINE for a positive literal ...`
- `Shingoki CDCL learning: _addLearnedClause stores the clause verbatim`
- `Shingoki CDCL learning: _analyzeConflict learns a clause ...`
- `Shingoki CDCL: solves the captured 5x5 via learning search`
- `Shingoki CDCL learning: never spurious-UNSAT on constructive boards (15 seeds)`
- `Shingoki CDCL: VSIDS prefers the higher-activity unassigned var`
- `Shingoki CDCL: _lubyNext yields the canonical Luby sequence`
- `Shingoki CDCL: stagnation early-exit returns the partial fast on the 40x40 ...`
- `Shingoki CDCL: stagnation exit does not break solvable mid-size boards`
- `Shingoki CDCL: stagnation window does not abort a deep-search-solvable board`

KEEP (they test rules/structural/hint/public behavior): everything from `decodeClue` through `Shingoki connectivity: ...`, `trail records and rolls back`, and the public solve tests (`Shingoki solve: ...`, `Shingoki CDCL: 40x40 monthly never spurious-UNSAT`, `Shingoki CDCL: mid-size constructive boards solve fast and valid`).

The deep-search 8×8 board from the deleted `stagnation window does not abort` test is preserved as a fast-solve test in Task 5 — copy its `task` array out before deleting if convenient (it is reproduced in Task 5 Step 1).

- [ ] **Step 2: Delete the CDCL methods from `src/solvers/shingoki.js`**

Remove these methods entirely: `_numH`, `_varId`, `_decodeVar`, `_numVars`, `_cdclInit`, `_initVsids`, `_bumpVar`, `_bumpVsids`, `_decayVsidsIfDue`, `_pickDecisionVar`, `_varValue`, `_forceLiteral`, `_addLearnedClause`, `_lubyNext`, `_restart`, `_solveCdcl`, `_decisionLevelOf`, `_analyzeConflict`, `_computeBackjumpLevel`, `_backjumpTo`, `_propagateLearned`, `_propagateAll`, `_snapshotLineCount`, `_cdclSearch`, `_currentLevelDecisionReason`.

Remove the constructor's `stagnationMs` option and the `_stagnationMs`/`_stagnated` fields:

```js
  constructor({ rows, cols, task, maxMs = 0, searchMs = 6000 }) {
    this.rows = rows;
    this.cols = cols;
    this.task = task;
    this.maxMs = maxMs;
    // Deep-search budget for the adaptive DFS. When exceeded, solve() returns the
    // sound level-0 propagation partial instead of grinding the full maxMs. The
    // searchMs cap fires first in practice; maxMs is an outer ceiling. Pass 0 to
    // disable searchMs (rely on maxMs only).
    this._searchMs = searchMs;
    this._startedAt = 0;
  }
```

- [ ] **Step 3: Strip the `_cdcl` branches from `setEdge`, `_rollbackTo`, `_propagate`**

`setEdge` (remove the `if (this._cdcl) {...}` block):

```js
  setEdge(ref, val) {
    const cur = this.getEdge(ref);
    if (cur === val) return true;
    if (cur !== 0) return false;
    if (this._trail) this._trail.push(ref.kind, ref.r, ref.c, cur);
    if (ref.kind === 'H') this.H[ref.r][ref.c] = val; else this.V[ref.r][ref.c] = val;
    return true;
  }
```

`_rollbackTo` (remove the `if (this._cdcl) {...}` block):

```js
  _rollbackTo(mark) {
    const t = this._trail;
    if (!t) return;
    while (t.length > mark) {
      const prev = t.pop(), c = t.pop(), r = t.pop(), kind = t.pop();
      if (kind === 'H') this.H[r][c] = prev; else this.V[r][c] = prev;
    }
  }
```

`_propagate`: simplify `trySet` to drop the reason bookkeeping, and remove every `if (this._cdcl) this._lastConflictReason = conflictReason();` guard and the `conflictReason`/`curInc` closures. The simplified `trySet`:

```js
    const trySet = (ref, val) => {
      const before = this.getEdge(ref);
      if (!this.setEdge(ref, val)) return false;
      if (this.getEdge(ref) !== before) for (const v of this._endpoints(ref)) { seen.delete(v.r*(cols+2)+v.c); enq(v.r, v.c); }
      return true;
    };
```

Then in the rule body, replace every `if (!trySet(e, X)) { if (this._cdcl) this._lastConflictReason = conflictReason(); return false; }` with `if (!trySet(e, X)) return false;`, and every bare `{ if (this._cdcl) this._lastConflictReason = conflictReason(); return false; }` (the conflict cases, e.g. `if (lines > 2)`) with `return false;`. Delete the `curInc` variable, the `conflictReason` closure, and the `reasonOverride` parameter usage. `_applyRunCap`'s signature stays `(r, c, clue, trySet)` but its `reasonOverride`/`runReason`/`_cdcl` lines are removed:

```js
  _applyRunCap(r, c, clue, trySet) {
    const inc = this.incidentEdges(r, c).filter(e => this.getEdge(e) === 1);
    if (inc.length === 0) return true;
    const walk = (dr, dc) => { /* unchanged */ };
    const horiz = inc.some(e => e.kind === 'H');
    const vert = inc.some(e => e.kind === 'V');
    let total = 0;
    const ends = [];
    if (horiz) { const a = walk(0,-1), b = walk(0,1); total += a.len + b.len; ends.push(a.endRef, b.endRef); }
    if (vert)  { const a = walk(-1,0), b = walk(1,0); total += a.len + b.len; ends.push(a.endRef, b.endRef); }
    if (total > clue.n) return false;
    if (total === clue.n) {
      for (const ref of ends) {
        if (ref && this.getEdge(ref) === 0 && !trySet(ref, 2)) return false;
      }
    }
    return true;
  }
```

(The `edges`/`runEdges` accumulation existed only to build CDCL reasons — drop it; `walk` no longer needs to return `edges`, but leaving `edges` in the returned object is harmless. Simplest: leave `walk` as-is and just stop using `runEdges`.)

Also delete `trySet`'s now-unused 3rd `reasonOverride` param if you removed all call sites; `_applyRunCap` no longer passes one.

- [ ] **Step 4: Verify nothing references removed symbols**

Run: `grep -nE '_cdcl|_varId|_decodeVar|_numVars|_varValue|_analyzeConflict|_backjump|_lubyNext|_restart|_vsids|_activity|stagnat|_lastConflictReason|_reason\b|_assignTrail|_learnedClauses|_rootSnapshot|_propagateAll|_propagateLearned|_solveCdcl|_currentReason' src/solvers/shingoki.js`
Expected: NO matches (empty output). If any remain, remove them.

Run: `npm run lint && npm run typecheck`
Expected: clean (no undefined-symbol or unused-var errors).

- [ ] **Step 5: Run the full suite + fuzz**

Run: `npm test`
Expected: PASS, 0 fail. The master soundness guards (constructive fuzz, no-spurious-UNSAT, differential, the structural-prune tests) must be green.

- [ ] **Step 6: Commit**

```bash
jj commit -m "refactor(shingoki): delete dead CDCL machinery (~600 lines)

Removes CDCL/VSIDS/restarts/clause-learning/stagnation and the _cdcl
reason-tracking branches threaded through propagate/setEdge/rollback.
Propagation is plain again. solve() runs only the adaptive DFS.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: 7×7-hard fixture, deep-search guard, and test cleanup

**Files:**
- Modify: `tests/fixtures/real-puzzles.js` — add `shingoki_7x7_hard`
- Modify: `tests/shingoki.test.js` — repoint remaining "CDCL" test names; add a deep-search guard; point the 7×7 regression test at the fixture

- [ ] **Step 1: Add the 7×7-hard fixture**

In `tests/fixtures/real-puzzles.js`, after the `shingoki_40x40_monthly` block, add:

```js
  // 7x7 shingoki, /shingoki/random/7x7-hard. Captured via Dump. The board that
  // exposed CDCL's regression (CDCL >60s; the adaptive DFS solves it in ~2-3s).
  // Signed vertex clues on an 8x8 lattice (>0 white/straight, <0 black/turn).
  shingoki_7x7_hard: {
    type: 'shingoki',
    rows: 7,
    cols: 7,
    task: [
      [0,0,-4,0,0,0,0,0],
      [0,0,0,0,0,0,-2,0],
      [-2,0,0,0,-4,-3,0,-3],
      [0,0,0,0,0,0,-4,0],
      [0,0,0,0,0,0,0,0],
      [3,0,0,0,-2,0,0,0],
      [0,-2,0,-3,0,0,0,0],
      [0,2,0,0,-2,0,0,0],
    ],
  },
```

- [ ] **Step 2: Point the 7×7 regression test at the fixture**

Replace the inline `task` in the `Shingoki DFS: solves the real 7x7-hard board` test (added in Task 2) with the fixture:

```js
test('Shingoki DFS: solves the real 7x7-hard board in a few seconds (regression)', { timeout: 15000 }, () => {
  const p = require('./fixtures/real-puzzles.js').shingoki_7x7_hard;
  const t0 = Date.now();
  const res = new ShingokiSolver({ rows: p.rows, cols: p.cols, task: p.task, maxMs: 30000 }).solve();
  assert.equal(res.solved, true, 'DFS must solve the real 7x7-hard board');
  assert.ok(Date.now() - t0 < 10000, 'should solve in well under 10s');
  const chk = new ShingokiSolver({ rows: p.rows, cols: p.cols, task: p.task });
  chk.H = res.horizontal; chk.V = res.vertical;
  assert.equal(chk.numbersSatisfied(), true);
});
```

- [ ] **Step 3: Add the deep-search-board guard (replaces the deleted stagnation test)**

The sparse 8×8 board that CDCL needed ~7 s for; the DFS solves it fast. Add:

```js
test('Shingoki DFS: solves a deep-search sparse board (4 clues) fast', { timeout: 15000 }, () => {
  // A sparse 8x8 (4 clues) whose root propagation deduces almost nothing; the
  // loop is found by chain-building DFS. CDCL needed ~7s here; the DFS is fast.
  const task = [
    [0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,4,0,0],
    [0,0,0,0,0,4,4,0,0],
    [0,0,0,0,0,4,0,0,0],
    [0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0],
  ];
  const res = new ShingokiSolver({ rows: 8, cols: 8, task, maxMs: 30000 }).solve();
  assert.equal(res.solved, true);
  const chk = new ShingokiSolver({ rows: 8, cols: 8, task });
  chk.H = res.horizontal; chk.V = res.vertical;
  assert.equal(chk.numbersSatisfied(), true);
});
```

- [ ] **Step 4: Repoint the surviving "CDCL" test names**

Rename the two remaining public tests that still say "CDCL" to describe the engine-agnostic behavior:
- `Shingoki CDCL: 40x40 monthly never spurious-UNSAT; returns solved or sound partial` → `Shingoki solve: 40x40 monthly never spurious-UNSAT; returns solved or sound partial`
- `Shingoki CDCL: mid-size constructive boards solve fast and valid` → `Shingoki solve: mid-size constructive boards solve fast and valid`
- `Shingoki solve: small boards still solve correctly via CDCL` → `Shingoki solve: small boards still solve correctly`

(These are name-only edits; keep their bodies, including the Task 3 `searchMs` budgets.)

- [ ] **Step 5: Run**

Run: `npm test`
Expected: PASS, 0 fail.

- [ ] **Step 6: Commit**

```bash
jj commit -m "test(shingoki): 7x7-hard fixture + deep-search guard; drop CDCL test names

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Docs, module header, bench, and build

**Files:**
- Modify: `src/solvers/shingoki.js` — replace the CDCL header paragraph
- Modify: `CLAUDE.md` — replace the Shingoki per-puzzle note
- Verify: `tests/bench-shingoki.js`, `solver.worker.js`
- Build: `npm run build`

- [ ] **Step 1: Replace the solver module header**

In `src/solvers/shingoki.js`, replace the `=== CDCL search engine ===` block (lines ~14–36) with:

```js
// === Adaptive DFS search engine ===
//
// solve() runs a recursive backtracking search over edge values, built on the
// sound primitives _propagate (degree/shape/axis/run-cap), the change-trail
// (setEdge push + _trailMark/_rollbackTo), the structural prunes
// (_hasPrematureLoop / _deadByConnectivity), and the acceptance gate
// _isValidComplete. Branch selection (_pickBranch) is adaptive and
// SOUND-NEUTRAL: it extends a committed chain (LINE first) where one exists,
// else picks a constraint-focused edge by probing which assignment propagates
// most. CDCL was tried and removed: ~88% of conflicts on real boards are
// structural (connectivity) with no tight var-reason, so clause learning was
// useless AND bloated propagation, regressing small boards (see the
// adaptive-DFS design spec).
//
// Partial-on-timeout: a searchMs deep-search cap (~6 s; maxMs is the outer
// ceiling) unwinds via a thrown SEARCH_BUDGET sentinel, and solve() returns the
// level-0 propagation snapshot captured before the first branch — a SOUND
// partial (every edge entailed by the clues, no vertex degree > 2). Only a
// budget bail yields a partial; an exhausted tree returns 'no solution'.
//
// Measured reality: realistic clued boards up to ~20x20 solve in a few seconds.
// The 40x40 monthly does not fully solve and returns its sound partial at the
// searchMs cap (the 'finish manually' widget path).
```

- [ ] **Step 2: Update the CLAUDE.md Shingoki note**

In `CLAUDE.md`, replace the Shingoki bullet (line ~253) with:

```
- Shingoki — `src/widget/puzzles/shingoki.js`, `src/solvers/shingoki.js` (Hint/Loop use a deductive getStepwiseHint — border/axis + number-run propagation + 1-step lookahead — falling back to the cached solution when logic is exhausted) (solver: adaptive DFS — loop-aware chain-extension where chains exist, constraint-focused probe-guided branching where they don't; reuses the sound propagation rules + connectivity prunes; sound level-0 partial on a ~6s searchMs cap. Realistic boards up to ~20x20 solve in a few seconds; the 40x40 monthly returns a sound partial — see the adaptive-DFS spec. CDCL was tried and removed: clause-learning is useless+harmful on connectivity-dominated boards.).
```

- [ ] **Step 3: Verify the bench and worker need no change**

Run: `node tests/bench-shingoki.js`
Expected: it runs and prints the size ladder + the 40×40 (solved=false partial is acceptable for 40×40; the smaller sizes should solve). No code change required.

Confirm `solver.worker.js` shingoki branch still reads `new ShingokiSolver({ rows, cols, task, maxMs: 30000 })` (the `searchMs` default of 6000 applies). No change needed.

- [ ] **Step 4: Rebuild the extension bundle**

`src/solvers/shingoki.js` changed, so the solver bundle must be rebuilt (per CLAUDE.md).

Run: `npm run build`
Expected: `Wrote dist/solver.js` + `Wrote dist/content.js`, no bundler errors (the surviving-require / shared-first / bare-module.exports guards pass).

- [ ] **Step 5: Final full gate**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all green, 0 fail.

- [ ] **Step 6: Commit**

```bash
jj commit -m "docs+build(shingoki): adaptive-DFS header + CLAUDE note; rebuild dist

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final review (after all tasks)

Dispatch a final code reviewer over the whole change set: confirm (1) no CDCL symbol survives anywhere in `src/solvers/shingoki.js`; (2) the genuine-UNSAT-vs-partial distinction holds (only a `SEARCH_BUDGET` bail sets `partial:true`); (3) the master soundness guards (fuzz, no-spurious-UNSAT, differential) are green; (4) the real 7×7-hard fixture solves fast; (5) the 40×40 returns a sound partial under the cap; (6) `dist/` rebuilt. Then use **superpowers:finishing-a-development-branch**.
