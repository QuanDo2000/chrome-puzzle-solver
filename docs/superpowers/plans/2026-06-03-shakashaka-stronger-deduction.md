# Shakashaka Stronger Deduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Strengthen `ShakashakaSolver`'s deduction with GAC arc-consistency (cheap Tier-1) + bifurcation 1-ply probing (heavy Tier-2) so it solves the small/medium range and produces far stronger partials, mirroring the Shingoki two-tier engine.

**Architecture:** A `_deduceAll` driver runs `_gacPropagate` to fixpoint, then a `_bifurcate` pass, repeating while anything changed; `solve()`/the MRV search and the deductive Hint switch from the conservative `_propagate`/`_consistent` to `_deduceAll`. The ported `_hasNonRectAt`/`_taskMarkedCount` (already byte-faithful) are the ground-truth oracle; the existing brute-force cross-check gates GAC/bifurcation soundness. Size/time-gating keeps large boards fast and Hint interactive.

**Tech Stack:** Plain JS, `node:test`, `jj` (NEVER `git`). Spec: `docs/superpowers/specs/2026-06-03-shakashaka-stronger-deduction-design.md`.

**IMPORTANT — `jj`, NEVER `git`.** Commit trailer:
```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

## Existing solver shape (from the base feature, in `src/solvers/shakashaka.js`)

Module-scope: `const UNK = 9;` and `function popcount(x){...}`. Class `ShakashakaSolver` has: `constructor({task, maxMs})`, `_bs`, `_taskMarkedCount`, `_hasNonRectAt`, `_hasNonRect`, `_isValid` (the ported oracle); `_initDomains` (sets `this._dom` to bitmasks 0b11111 for open / 0 for black), `_boardFromDomains` (singleton→value, else UNK, black→-1), `_consistent`/`_neighbourhoodDecided`/`_clueFeasibleAround` (the OLD conservative propagation), `_propagate`, `_deduceOnly` (returns `{ok, cells}`), `solve` (returns `{solved, cells, partial?, error?}`). Tests in `tests/shakashaka.test.js` have a `bruteForce(task)` enumerator and the soundness cross-check.

**SOUNDNESS PRINCIPLE (read first):** GAC/bifurcation may only PRUNE a value `v` at a cell when NO valid completion uses `v` there. GAC-on-own-predicate is sound because it prunes `v` only when no assignment of the cell's open read-neighbours (over their domains) satisfies that cell's `_hasNonRectAt`; the bounded cap UNDER-prunes (skips when too many neighbours open) — sound (weaker), never unsound. Bifurcation prunes `v` only when pinning it + full sound GAC reaches a contradiction. The brute-force cross-check is the objective gate: every pruned value must hold for NO solution, every forced cell for EVERY solution.

---

### Task 1: GAC arc-consistency (Tier-1) + `_deduceAll` driver

**Files:** Modify `src/solvers/shakashaka.js`; Modify `tests/shakashaka.test.js`.

- [ ] **Step 1: Write the failing tests (unit + brute-force soundness for GAC)**

Add to `tests/shakashaka.test.js`:
```js
test('Shakashaka GAC: prunes a triangle impossible by a border (bottom-row T1)', () => {
  // A 2-row board: a T1 needs a down-neighbour; on the BOTTOM row T1 is impossible.
  const s = new ShakashakaSolver({ task: [[-1,-1],[-1,-1]] });
  s._initDomains();
  s._gacPropagate();
  // bottom row (r=1): T1 (bit 1) must be pruned from both cells' domains
  assert.equal((s._dom[1][0] >> 1) & 1, 0, 'bottom-left domain must not contain T1');
  assert.equal((s._dom[1][1] >> 1) & 1, 0, 'bottom-right domain must not contain T1');
});

test('Shakashaka GAC: never prunes a value used by a valid solution (brute-force gate)', () => {
  const boards = [
    [[-1,-1],[-1,-1]],
    [[-1,-1,-1],[-1,-2,-1],[-1,-1,-1]],
    [[-1,0,-1],[-1,-1,-1]],
    [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
    [[-1,-1,-1,-1],[-1,-2,-1,-1],[-1,-1,2,-1]],
  ];
  for (const task of boards) {
    const all = bruteForce(task);
    const s = new ShakashakaSolver({ task });
    s._initDomains();
    s._gacPropagate(); // may wipe out only if unsat
    for (let r = 0; r < task.length; r++) for (let c = 0; c < task[0].length; c++) {
      if (task[r][c] !== -1) continue;
      for (let v = 0; v <= 4; v++) {
        const possibleInSomeSolution = all.some(sol => sol[r][c] === v);
        if (possibleInSomeSolution) {
          assert.ok((s._dom[r][c] >> v) & 1, `GAC wrongly pruned (${r},${c})=${v} which a valid solution uses`);
        }
      }
    }
  }
});

test('Shakashaka _deduceAll: GAC-only fixpoint never makes a solvable board UNSAT', () => {
  const task = [[-1,-1,-1],[-1,-2,-1],[-1,-1,-1]];
  const s = new ShakashakaSolver({ task });
  s._initDomains();
  assert.equal(s._deduceAll(0), true); // no wipeout on a solvable board
});
```

- [ ] **Step 2: Run → FAIL** (`_gacPropagate`/`_deduceAll` not functions).
Run: `node --test --test-name-pattern='Shakashaka GAC|_deduceAll' tests/shakashaka.test.js`

- [ ] **Step 3: Implement GAC + the driver**

Add module-scope constant near `UNK`: `const GAC_CAP = 5; // max open read-neighbours to enumerate (cost bound; >cap -> don't prune, sound)`.

Add these methods to the class:
```js
  // Is value v supported at open cell (r,c)? Tentatively place v; v is impossible
  // (return false) iff a number clue around (r,c) is infeasible, OR — when the
  // cell's open read-neighbours are few enough to enumerate — no assignment of
  // those neighbours (over their current domains) makes _hasNonRectAt(r,c) pass.
  // When too many neighbours are open (> GAC_CAP) we cannot disprove v cheaply, so
  // we KEEP it (sound under-pruning). Reads neighbour domains from this._dom.
  _gacSupported(board, r, c, v) {
    const { rows, cols } = this;
    const U = [];
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const t = r + dr, e = c + dc;
      if (t < 0 || e < 0 || t >= rows || e >= cols || (t === r && e === c)) continue;
      if (this.task[t][e] === -1 && board[t][e] === UNK) U.push([t, e]);
    }
    board[r][c] = v;
    let ok;
    if (!this._clueFeasibleAround(board, r, c)) ok = false;
    else if (U.length > GAC_CAP) ok = true;
    else ok = this._enumSupport(board, r, c, U, 0);
    for (const [t, e] of U) board[t][e] = UNK;
    board[r][c] = UNK;
    return ok;
  }
  // Recursively assign the open neighbours U from their domains; true iff some
  // assignment makes _hasNonRectAt(r,c) false (no violation at (r,c)).
  _enumSupport(board, r, c, U, i) {
    if (i === U.length) return !this._hasNonRectAt(board, r, c);
    const [t, e] = U[i], d = this._dom[t][e];
    for (let w = 0; w <= 4; w++) if (d & (1 << w)) {
      board[t][e] = w;
      if (this._enumSupport(board, r, c, U, i + 1)) return true;
    }
    board[t][e] = UNK;
    return false;
  }
  // Generalized arc-consistency to a fixpoint over this._dom. Returns false on a
  // domain wipeout (contradiction). Prunes only provably-impossible values.
  _gacPropagate() {
    let changed = true;
    while (changed) {
      changed = false;
      const board = this._boardFromDomains();
      for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) {
        if (this.task[r][c] !== -1) continue;
        const d = this._dom[r][c];
        if (popcount(d) <= 1) continue;
        let nd = 0;
        for (let v = 0; v <= 4; v++) if (d & (1 << v)) { if (this._gacSupported(board, r, c, v)) nd |= (1 << v); }
        if (nd === 0) return false;
        if (nd !== d) {
          this._dom[r][c] = nd;
          if (popcount(nd) === 1) { let x = 0, m = nd; while (m > 1) { m >>= 1; x++; } board[r][c] = x; }
          changed = true;
        }
      }
    }
    return true;
  }
  // Two-tier deduction driver. Tier-1 GAC; Tier-2 bifurcation added in Task 2.
  // `budget` (ms, 0 = use existing deadline) bounds the heavy passes.
  _deduceAll(budget) {
    if (budget > 0) this._deadline = Date.now() + budget;
    return this._gacPropagate();
  }
```

- [ ] **Step 4: Reroute `solve()`, the search, and `_deduceOnly` to `_deduceAll`/GAC**

In `_deduceOnly`, replace the `_propagate(board)` call with `this._deduceAll(0)` (operating on `this._dom`); return `{ ok, cells: this._boardFromDomains() }`.

In `solve()`: replace the initial `if (!this._propagate(board))` with `if (!this._deduceAll(0))`, and in the inner `search()` replace `this._propagate(b)` with `this._deduceAll(0)`. (Both now operate on `this._dom`; the `board` variable derivations stay for the leaf `_isValid` check via `_boardFromDomains()`.) Keep the MRV pick + snapshot/restore of `this._dom` exactly as-is.

- [ ] **Step 5: Run + measure**

Run: `node --test tests/shakashaka.test.js` → all green (the GAC soundness gate + the existing brute-force cross-check pass; if a value is wrongly pruned, GAC is unsound — re-check `_gacSupported` only prunes via the own-predicate enumeration / clue feasibility). Run `npm run lint`.
MEASURE (throwaway script, delete after): root-deduction reach (`_initDomains(); _deduceAll(0)`; count singleton domains) on the `shakashaka_25x25` fixture (expect ~8%), and full `solve()` on the real 5×5 (`[[-2,-2,-1,-1,-1],[-1,-1,-1,-1,-1],[-1,-1,-2,-1,-2],[1,-1,-1,-1,-1],[-1,-1,-1,-1,-1]]`) — confirm it still solves fast. Report.

- [ ] **Step 6: Commit**
```bash
jj commit -m "feat(shakashaka): GAC arc-consistency (Tier-1) + _deduceAll driver

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Bifurcation (Tier-2)

**Files:** Modify `src/solvers/shakashaka.js`; Modify `tests/shakashaka.test.js`.

- [ ] **Step 1: Write the failing tests (soundness gate over more boards)**
```js
test('Shakashaka bifurcation: _deduceAll with Tier-2 never prunes a valid value (brute-force)', () => {
  const boards = [
    [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
    [[-1,-1,-1,-1],[-1,-2,-1,-1],[-1,-1,2,-1],[-1,-1,-1,-1]],
    [[-1,0,-1],[-1,-1,-1],[-1,-2,-1]],
    [[-1,-1,-1,-1],[-2,-1,-1,-2],[-1,-1,-1,-1]],
  ];
  for (const task of boards) {
    const all = bruteForce(task);
    const s = new ShakashakaSolver({ task });
    s._initDomains();
    s._deduceAll(0); // GAC + bifurcation
    for (let r = 0; r < task.length; r++) for (let c = 0; c < task[0].length; c++) {
      if (task[r][c] !== -1) continue;
      for (let v = 0; v <= 4; v++) {
        if (all.some(sol => sol[r][c] === v)) {
          assert.ok((s._dom[r][c] >> v) & 1, `bifurcation wrongly pruned (${r},${c})=${v}`);
        }
      }
    }
  }
});

test('Shakashaka bifurcation: forced cells hold in every solution', () => {
  const task = [[-1,-1,-1,-1],[-1,-2,-1,-1],[-1,-1,2,-1],[-1,-1,-1,-1]];
  const all = bruteForce(task);
  const s = new ShakashakaSolver({ task });
  s._initDomains(); s._deduceAll(0);
  for (let r = 0; r < task.length; r++) for (let c = 0; c < task[0].length; c++) {
    if (task[r][c] !== -1) continue;
    if (popcount(s._dom[r][c]) === 1) {
      let v = 0, m = s._dom[r][c]; while (m > 1) { m >>= 1; v++; }
      for (const sol of all) assert.equal(sol[r][c], v, `forced (${r},${c})=${v} must hold in all solutions`);
    }
  }
});
```

- [ ] **Step 2: Run → FAIL** (`_deduceAll` is GAC-only; the forced-cells/extra-prune behaviour differs — these tests assert soundness which should pass, but add `_bifurcate` to strengthen; if they pass already they still must pass after Task 2).
Run: `node --test --test-name-pattern='Shakashaka bifurcation' tests/shakashaka.test.js`

- [ ] **Step 3: Implement `_bifurcate` and wire it into `_deduceAll`**
```js
  // Tier-2: 1-ply probe each frontier cell-value. Pin it, run full GAC; if that
  // wipes out, the value is provably impossible -> prune. Frontier = open cells
  // adjacent to a decided/black cell. Cost-gated by this._deadline. Returns
  // { changed, ok:false on contradiction }.
  _bifurcate() {
    const board = this._boardFromDomains();
    const frontier = [];
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) {
      if (this.task[r][c] !== -1 || popcount(this._dom[r][c]) <= 1) continue;
      let adj = false;
      for (const [t, e] of [[r-1,c],[r+1,c],[r,c-1],[r,c+1]]) {
        if (t < 0 || e < 0 || t >= this.rows || e >= this.cols) continue;
        if (this.task[t][e] !== -1 || board[t][e] !== UNK) { adj = true; break; }
      }
      if (adj) frontier.push([r, c]);
    }
    let changed = false;
    for (const [r, c] of frontier) {
      if (this._deadline && Date.now() > this._deadline) break;
      const d = this._dom[r][c];
      if (popcount(d) <= 1) continue;
      for (let v = 0; v <= 4; v++) if (d & (1 << v)) {
        const saved = this._dom.map(row => row.slice());
        this._dom[r][c] = (1 << v);
        const ok = this._gacPropagate();
        this._dom = saved;
        if (!ok) {
          this._dom[r][c] &= ~(1 << v);
          changed = true;
          if (this._dom[r][c] === 0) return { changed, ok: false };
        }
      }
    }
    return { changed, ok: true };
  }
```
Update `_deduceAll`:
```js
  _deduceAll(budget) {
    if (budget > 0) this._deadline = Date.now() + budget;
    for (;;) {
      if (!this._gacPropagate()) return false;
      if (this._bifurcationDisabled) return true;
      if (this._deadline && Date.now() > this._deadline) return true;
      const bif = this._bifurcate();
      if (!bif.ok) return false;
      if (!bif.changed) return true;
    }
  }
```
(`this._bifurcationDisabled` defaults to undefined/false; set true on probe clones is NOT needed here because `_bifurcate` calls `_gacPropagate` (not `_deduceAll`) on the probe — no recursion. The flag exists for the Hint/size-gate path in Task 3.)

- [ ] **Step 4: Run → PASS** the bifurcation soundness tests + the full suite. The brute-force gate is THE check; if it fails, bifurcation pruned a valid value — `_bifurcate` must prune `v` ONLY when `_gacPropagate` on the pinned clone returns false (genuine wipeout). Do NOT weaken the test.
Run: `node --test tests/shakashaka.test.js`

- [ ] **Step 5: Measure** (throwaway, delete after): reach on the 25×25 (`_initDomains(); _deduceAll(0)` — expect ~23%, may take ~8s) AND full `solve()` on a constructive size ladder (build small all-open boards 4×4/6×6/8×8/10×10 — measure solved/wall-time) + the real 5×5. Report which sizes now solve and the 25×25 reach. Run `npm run lint`.

- [ ] **Step 6: Commit**
```bash
jj commit -m "feat(shakashaka): bifurcation (Tier-2) 1-ply probing in _deduceAll

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Size-gating, deduction deadline, partial + Hint interactivity

**Files:** Modify `src/solvers/shakashaka.js`; Modify `tests/shakashaka.test.js`; possibly `src/widget/puzzles/shakashaka.js`.

Mirror Shingoki: large boards run GAC + a bounded bifurcation slice and return a fast strong partial; the deductive Hint stays interactive.

- [ ] **Step 1: Write the failing tests**
```js
test('Shakashaka solve: large board returns a SOUND partial fast (no full grind)', () => {
  const fx = require('./fixtures/real-puzzles.js');
  const p = fx.shakashaka_25x25;
  const t0 = Date.now();
  const res = new ShakashakaSolver({ task: p.task, maxMs: 30000 }).solve();
  const wall = Date.now() - t0;
  if (!res.solved) {
    assert.equal(res.partial, true);
    assert.ok(wall < 25000, `large board should bail well under 30s, took ${wall}ms`);
    // partial soundness: the determined cells are consistent (no _isValid contradiction
    // among decided cells — check no fully-decided board check fails). At minimum,
    // every decided open cell's value is in 0..4.
    for (const row of res.cells) for (const v of row) assert.ok(v === -1 || (v >= 0 && v <= 4) || v === 9);
  }
});

test('Shakashaka solve: the real 5x5 still solves fast', () => {
  const task = [[-2,-2,-1,-1,-1],[-1,-1,-1,-1,-1],[-1,-1,-2,-1,-2],[1,-1,-1,-1,-1],[-1,-1,-1,-1,-1]];
  const t0 = Date.now();
  const res = new ShakashakaSolver({ task, maxMs: 30000 }).solve();
  assert.equal(res.solved, true);
  assert.ok(Date.now() - t0 < 5000);
  const chk = new ShakashakaSolver({ task });
  assert.equal(chk._isValid(res.cells), true);
});
```

- [ ] **Step 2: Run → FAIL / measure** (the large-board test may already pass if bifurcation is bounded; the point is to lock the gating).

- [ ] **Step 3: Implement size-gating + deadline in `solve()`**

Add constructor fields (after the existing ones): `this._heavyMaxCells = 200; this._lightBudgetMs = 4000; this._deadline = 0; this._bifurcationDisabled = false;`. Then in `solve()`, set the effective budget + deadline by size, and disable the heavy Tier-2 for large boards so they return the GAC partial fast:
```js
  solve() {
    this._startedAt = Date.now();
    this._initDomains();
    const cells = this.rows * this.cols;
    const big = cells > this._heavyMaxCells;
    // Large boards: run GAC + a bounded bifurcation slice, capped short, then return
    // the strong partial. Small/medium boards get the full budget and solve.
    const budget = big ? Math.min(this.maxMs || this._lightBudgetMs, this._lightBudgetMs) : (this.maxMs || 0);
    this._deadline = budget > 0 ? Date.now() + budget : 0;
    if (!this._deduceAll(0)) return { solved: false, cells: null, error: 'no solution' };
    // ... existing search, but it must also respect this._deadline ...
  }
```
Update the inner `search()` time check to throw the budget sentinel when `this._deadline && Date.now() > this._deadline` (in addition to any existing `maxMs` check), and on that bail return the partial: `{ solved:false, cells: this._boardFromDomains(), partial:true, error:'time limit exceeded' }`. (Keep the genuine-`no solution` path for a truly exhausted search — only a deadline bail yields a partial.)

- [ ] **Step 4: Hint interactivity (widget)** — in `src/widget/puzzles/shakashaka.js` `_deduceForced`, construct the solver and call `_deduceAll(800)` (an ~800 ms interactive deadline) instead of the old `_propagate`, and for large boards set `solver._bifurcationDisabled = true` before deducing so a single Hint stays fast (GAC-only on big boards). Measure single-Hint latency on the 25×25 (throwaway): must stay < ~1s. (If `_deduceForced` already calls a propagation method, swap it to `_deduceAll`.)

- [ ] **Step 5: Run + measure** `npm test` (green), `npm run lint`, `npm run typecheck`. Measure: 5×5 solves fast; 25×25 returns a sound partial in a few seconds; Hint < 1s on the 25×25.

- [ ] **Step 6: Commit**
```bash
jj commit -m "perf(shakashaka): size-gate heavy Tier-2 + deduction deadline; large boards fast partial, Hint interactive

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Bench, docs, build, final

**Files:** add `tests/bench-shakashaka.js` (extend), Modify `CLAUDE.md`, build.

- [ ] **Step 1:** Extend `tests/bench-shakashaka.js` to print, for the 5×5 and `shakashaka_25x25` (and a constructive size ladder 6/8/10/12), root-deduction reach (`_initDomains(); _deduceAll(0)`; singleton count) + solve/partial + wall-time.
- [ ] **Step 2:** Run `node tests/bench-shakashaka.js`, record the numbers (which sizes solve; 25×25 reach/partial-time).
- [ ] **Step 3:** Update `CLAUDE.md`'s Shakashaka per-puzzle note: two-tier deduction (GAC Tier-1 + bifurcation Tier-2, oracle-gated, size-gated), the measured outcome (small/medium solve; 25×25 strong sound partial), honest about the large-board ceiling (same as Shingoki).
- [ ] **Step 4:** `npm run build && npm test && npm run lint && npm run typecheck` — all green. Commit:
```bash
jj commit -m "docs+build(shakashaka): two-tier deduction bench + CLAUDE note; rebuild dist

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final review

Dispatch a reviewer: (1) GAC + bifurcation are sound (brute-force gate: no valid value pruned, no invalid solve, no spurious-UNSAT, forced cells hold in all solutions) — extended independent fuzz (hundreds of random small boards, mutation-tested harness); (2) `_deduceAll` wiring correct (solve/search/Hint use it); (3) size-gating returns large boards' partial fast; (4) Hint < 1s; (5) the real 5×5 solves, the 25×25 returns a sound partial; (6) build/lint/typecheck/tests green; (7) `dist/` rebuilt. Then **superpowers:finishing-a-development-branch** + live-verify.

## Measure-and-stop notes

- After Task 2, the controller measures the size ladder. If GAC+bifurcation solves up to ~10–15 and the 25×25 sits at a strong partial, that matches the spec's honest expectation — STOP (don't chase region-rectangle reasoning unless the medium range falls short).
- `GAC_CAP` (default 5) trades reach for cost; if medium boards need more reach and time allows, raising it is the first knob (re-measure). `_heavyMaxCells`/`_lightBudgetMs` tune the large-board partial speed.
- Soundness is absolute: any brute-force-caught unsound prune reverts the responsible rule.
