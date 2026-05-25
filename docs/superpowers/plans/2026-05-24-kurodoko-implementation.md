# Kurodoko Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full Kurodoko support (`/kurodoko/*`) — 12th puzzle type. Visibility-sum rule on numbered cells + adjacency + connectivity (latter two cloned from Heyawake/Hitori).

**Architecture:** `KurodokoSolver` follows Hitori shape. Cell encoding `0/1/2` matches. New propagation rule: per-clue visibility-sum tightening (per-direction `vis_d_min` / `vis_d_max` from `[lower, upper]` interval, force whites/blacks at the tight ends).

**Reference spec:** `docs/superpowers/specs/2026-05-24-kurodoko-design.md`
**Closest existing solver:** Hitori for boilerplate; Heyawake for connectivity.

`jj commit` not git. Repo `/home/quando/documents/chrome-puzzle-solver/`. TDD.

---

## Task 1: KurodokoSolver scaffold (constructor + _set with adjacency + _rollback + force clue cells white)

**Files:** `solver.js`, `tests/kurodoko.test.js` (new).

The constructor (a) copies inputs, (b) builds `clues` + `clueValues`, (c) **forces every clue cell to cellStatus=2 via `_set(idx, 2)` at the end of construction**. The adjacency cascade in `_set` fires naturally if needed.

- [ ] **Step 1: Create the failing test:**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { KurodokoSolver } = require('../solver.js');

test('KurodokoSolver: constructor forces clue cells to white', () => {
  const s = new KurodokoSolver({
    rows: 2, cols: 2,
    task: [[-1, 3], [-1, -1]],
  });
  assert.equal(s.cellStatus[1], 2);  // (0,1) clue → white
  assert.equal(s.cellStatus[0], 0);  // (0,0) non-clue → unknown
  assert.equal(s.clues.length, 1);
  assert.equal(s.clueValues[0], 3);
});

test('KurodokoSolver: _set black write forces 4-neighbours to white', () => {
  const s = new KurodokoSolver({
    rows: 3, cols: 3, task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  assert.equal(s._set(4, 1), true);
  assert.equal(s.cellStatus[1], 2);
  assert.equal(s.cellStatus[3], 2);
  assert.equal(s.cellStatus[5], 2);
  assert.equal(s.cellStatus[7], 2);
});

test('KurodokoSolver: _set / _rollback round-trip', () => {
  const s = new KurodokoSolver({ rows: 1, cols: 2, task: [[-1, -1]] });
  const mark = s.trail.length;
  assert.equal(s._set(0, 2), true);
  assert.equal(s.cellStatus[0], 2);
  s._rollback(mark);
  assert.equal(s.cellStatus[0], 0);
});
```

- [ ] **Step 2: Verify failure — `KurodokoSolver is not defined`.**

- [ ] **Step 3: Add KurodokoSolver to solver.js** (after `KakurasuSolver`, before `module.exports`):

```js
class KurodokoSolver {
  constructor(data) {
    const { rows, cols, task, initialState, maxMs } = data;
    this.rows = rows;
    this.cols = cols;
    this.task = new Int32Array(rows * cols);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        this.task[r * cols + c] = task[r][c];
      }
    }
    const cluesList = [], cluesValuesList = [];
    for (let i = 0; i < rows * cols; i++) {
      if (this.task[i] !== -1) {
        cluesList.push(i);
        cluesValuesList.push(this.task[i]);
      }
    }
    this.clues = new Int32Array(cluesList);
    this.clueValues = new Int32Array(cluesValuesList);
    this.cellStatus = new Uint8Array(rows * cols);
    if (initialState) {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          this.cellStatus[r * cols + c] = initialState[r][c];
        }
      }
    }
    this.trail = [];
    this._depth = 0;
    this._inLookahead = false;
    this.maxMs = maxMs || 0;
    this._startedAt = 0;
    // Force clue cells to white (the adjacency cascade fires naturally
    // if any initial-state black neighbours exist).
    for (let i = 0; i < this.clues.length; i++) {
      this._set(this.clues[i], 2);
    }
  }

  _set(idx, value) {
    const old = this.cellStatus[idx];
    if (old === value) return true;
    if (old !== 0) return false;
    this.trail.push(idx | (old << 24));
    this.cellStatus[idx] = value;
    if (value === 1) {
      const r = (idx / this.cols) | 0;
      const c = idx - r * this.cols;
      const ns = [];
      if (r > 0) ns.push(idx - this.cols);
      if (r < this.rows - 1) ns.push(idx + this.cols);
      if (c > 0) ns.push(idx - 1);
      if (c < this.cols - 1) ns.push(idx + 1);
      for (let i = 0; i < ns.length; i++) {
        const ni = ns[i];
        const nv = this.cellStatus[ni];
        if (nv === 1) return false;
        if (nv === 0) {
          if (!this._set(ni, 2)) return false;
        }
      }
    }
    return true;
  }

  _rollback(mark) {
    while (this.trail.length > mark) {
      const e = this.trail.pop();
      const i = e & 0xffffff;
      const old = (e >>> 24) & 0xff;
      this.cellStatus[i] = old;
    }
  }

  _timeUp() {
    if (this.maxMs <= 0) return false;
    return (Date.now() - this._startedAt) > this.maxMs;
  }
}
```

Update `module.exports` to include `KurodokoSolver`.

- [ ] **Step 4: Verify 3 passing.**

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(kurodoko): KurodokoSolver scaffold with clue-cells-forced-white"
```

---

## Task 2: Visibility-sum propagation

**Files:** `solver.js` (add `_applyVisibility`), `tests/kurodoko.test.js` (append).

For each clue cell, walk 4 cardinal directions; compute `lower[d]` (consecutive known-white from start) and `upper[d]` (cells until first known-black or edge); apply per-direction `vis_d_min`/`vis_d_max` tightening.

- [ ] **Step 1: Failing tests — append:**

```js
test('KurodokoSolver._applyVisibility: K=1 forces 4-neighbours black', () => {
  // 3x3 with clue=1 at center. K=1 means only the clue cell is visible.
  // All 4 neighbours of (1,1) must be black.
  const s = new KurodokoSolver({
    rows: 3, cols: 3,
    task: [[-1,-1,-1],[-1,1,-1],[-1,-1,-1]],
  });
  // (1,1) clue forced white by constructor.
  // visibility rule should force (0,1), (1,0), (1,2), (2,1) to black.
  // But: black neighbours of (1,1) would themselves force black-neighbour
  // adjacency cascade — (0,1) black makes (0,0), (0,2) white; etc.
  // Actually adjacency in _set fires from black write — black at (0,1)
  // would force (0,0), (0,2) white. So expectation: 4-neighbours of (1,1)
  // are black, their other neighbours forced white.
  assert.equal(s._applyVisibility(), true);
  assert.equal(s.cellStatus[1], 1);  // (0,1) black
  assert.equal(s.cellStatus[3], 1);  // (1,0) black
  assert.equal(s.cellStatus[5], 1);  // (1,2) black
  assert.equal(s.cellStatus[7], 1);  // (2,1) black
});

test('KurodokoSolver._applyVisibility: K=max forces in-line cells white', () => {
  // 3x3 with clue at (1,1), K = 1 + 1 + 1 + 1 + 1 = 5 (max for center cell).
  // All cells in row 1 and col 1 must be white.
  const s = new KurodokoSolver({
    rows: 3, cols: 3,
    task: [[-1,-1,-1],[-1,5,-1],[-1,-1,-1]],
  });
  assert.equal(s._applyVisibility(), true);
  assert.equal(s.cellStatus[1], 2);  // (0,1) white
  assert.equal(s.cellStatus[3], 2);  // (1,0) white
  assert.equal(s.cellStatus[5], 2);  // (1,2) white
  assert.equal(s.cellStatus[7], 2);  // (2,1) white
});

test('KurodokoSolver._applyVisibility: corner clue K=2', () => {
  // 3x3 with clue=2 at (0,0). Visible cells from (0,0): self + 1 more.
  // Either (0,1) is white and (0,2) black, or (1,0) is white and (2,0)
  // black. Or one of the immediate neighbours is white and the other
  // direction is fully blocked. Per-direction tightening should not
  // force anything yet (slack in distribution).
  const s = new KurodokoSolver({
    rows: 3, cols: 3,
    task: [[2,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  assert.equal(s._applyVisibility(), true);
  // (0,0) forced white by constructor. Other cells should be unknown
  // (visibility tightening shouldn't force them yet — there's slack).
  assert.equal(s.cellStatus[0], 2);
  // Note: nothing forced beyond clue cell in this case.
});

test('KurodokoSolver._applyVisibility: contradiction when clue value impossible', () => {
  // 1x1 with clue=2. Only the clue cell itself is visible, but K=2
  // requires 2 visible cells. Impossible → contradiction.
  const s = new KurodokoSolver({
    rows: 1, cols: 1,
    task: [[2]],
  });
  assert.equal(s._applyVisibility(), false);
});
```

- [ ] **Step 2: Verify failure.**

- [ ] **Step 3: Implement — inside `KurodokoSolver`:**

```js
_applyVisibility() {
  const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  for (let i = 0; i < this.clues.length; i++) {
    const idx = this.clues[i];
    const K = this.clueValues[i];
    const r0 = (idx / this.cols) | 0;
    const c0 = idx - r0 * this.cols;
    const lowers = [];
    const uppers = [];
    const cellsByDir = [];
    for (const [dr, dc] of dirs) {
      let lower = 0;
      let stillRun = true;
      const cells = [];
      let rr = r0 + dr, cc = c0 + dc;
      while (rr >= 0 && rr < this.rows && cc >= 0 && cc < this.cols) {
        const cidx = rr * this.cols + cc;
        const v = this.cellStatus[cidx];
        if (v === 1) break;
        cells.push(cidx);
        if (stillRun) {
          if (v === 2) lower++;
          else stillRun = false;
        }
        rr += dr; cc += dc;
      }
      lowers.push(lower);
      uppers.push(cells.length);
      cellsByDir.push(cells);
    }
    const sumLower = lowers[0] + lowers[1] + lowers[2] + lowers[3];
    const sumUpper = uppers[0] + uppers[1] + uppers[2] + uppers[3];
    if (sumLower + 1 > K) return false;
    if (sumUpper + 1 < K) return false;
    const T = K - 1;
    for (let d = 0; d < 4; d++) {
      const otherSumLower = sumLower - lowers[d];
      const otherSumUpper = sumUpper - uppers[d];
      const vis_min = Math.max(lowers[d], T - otherSumUpper);
      const vis_max = Math.min(uppers[d], T - otherSumLower);
      if (vis_min > vis_max) return false;
      const cells = cellsByDir[d];
      // Force [0..vis_min-1] white.
      for (let j = 0; j < vis_min; j++) {
        if (this.cellStatus[cells[j]] === 0) {
          if (!this._set(cells[j], 2)) return false;
        }
      }
      // If tight (vis_min == vis_max) and stopping cell exists, force black.
      if (vis_min === vis_max && vis_max < cells.length) {
        if (this.cellStatus[cells[vis_max]] === 0) {
          if (!this._set(cells[vis_max], 1)) return false;
        }
      }
    }
  }
  return true;
}
```

- [ ] **Step 4: Verify 7 passing.**

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(kurodoko): rule 2 — visibility-sum propagation per clue"
```

---

## Task 3: White connectivity (cloned from Heyawake)

**Files:** `solver.js` (add `_applyConnectivity` to `KurodokoSolver`), `tests/kurodoko.test.js` (append).

Direct port from `HeyawakeSolver._applyConnectivity` — identical encoding.

- [ ] **Step 1: Failing tests — append:**

```js
test('KurodokoSolver._applyConnectivity: blacks splitting whites → contradiction', () => {
  const s = new KurodokoSolver({
    rows: 3, cols: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  s.cellStatus[0] = 2; s.cellStatus[1] = 1; s.cellStatus[2] = 2;
  s.cellStatus[3] = 1; s.cellStatus[4] = 1; s.cellStatus[5] = 1;
  s.cellStatus[6] = 2; s.cellStatus[7] = 1; s.cellStatus[8] = 2;
  assert.equal(s._applyConnectivity(), false);
});

test('KurodokoSolver._applyConnectivity: articulation unknown forced white', () => {
  const s = new KurodokoSolver({
    rows: 3, cols: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  s.cellStatus[0] = 2; s.cellStatus[2] = 2;
  s.cellStatus[3] = 1; s.cellStatus[5] = 1;
  s.cellStatus[6] = 2; s.cellStatus[8] = 2;
  assert.equal(s._applyConnectivity(), true);
  assert.equal(s.cellStatus[4], 2);
});
```

- [ ] **Step 2: Verify failure.**

- [ ] **Step 3: Clone `_applyConnectivity` from `HeyawakeSolver` into `KurodokoSolver`** (the implementation is identical — just copy the full method body).

- [ ] **Step 4: Verify 9 passing.**

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(kurodoko): white-connectivity rule (BFS + articulation, cloned from Heyawake)"
```

---

## Task 4: Propagate orchestrator + lookahead

**Files:** `solver.js`, `tests/kurodoko.test.js` (append).

- [ ] **Step 1: Failing test — append:**

```js
test('KurodokoSolver._propagate: returns true on the recon 5x5 (partial deduction)', () => {
  const s = new KurodokoSolver({
    rows: 5, cols: 5,
    task: [
      [-1,-1,-1,6,-1],
      [-1,4,-1,7,-1],
      [-1,-1,-1,-1,-1],
      [-1,5,-1,8,-1],
      [-1,5,-1,-1,-1],
    ],
  });
  assert.equal(s._propagate(), true);
});

test('KurodokoSolver._propagate: returns false on contradictory input', () => {
  // 2x2 with clue=4 at (0,0): max visibility is 1+1+0+0+0 = 3 (self+right+down).
  // K=4 is impossible → contradiction.
  const s = new KurodokoSolver({
    rows: 2, cols: 2,
    task: [[4,-1],[-1,-1]],
  });
  assert.equal(s._propagate(), false);
});
```

- [ ] **Step 2: Verify failure.**

- [ ] **Step 3: Implement — inside `KurodokoSolver`:**

```js
_propagate() {
  let changed = true;
  while (changed) {
    if (this._timeUp()) return true;
    changed = false;
    const mark = this.trail.length;
    if (!this._applyVisibility()) return false;
    if (!this._applyConnectivity()) return false;
    if (this.trail.length > mark) changed = true;
  }
  if (this._depth === 0 && !this._inLookahead) {
    if (!this._applyLookahead()) return false;
  }
  return true;
}

_applyLookahead() {
  const total = this.rows * this.cols;
  let changed = true;
  while (changed) {
    if (this._timeUp()) return true;
    changed = false;
    for (let i = 0; i < total; i++) {
      if (this.cellStatus[i] !== 0) continue;
      const survivors = [];
      for (const v of [1, 2]) {
        const mark = this.trail.length;
        this._inLookahead = true;
        const okSet = this._set(i, v);
        const ok = okSet && this._propagate();
        this._rollback(mark);
        this._inLookahead = false;
        if (ok) survivors.push(v);
        if (survivors.length > 1) break;
      }
      if (survivors.length === 0) return false;
      if (survivors.length === 1) {
        if (!this._set(i, survivors[0])) return false;
        if (!this._propagate()) return false;
        changed = true;
      }
    }
  }
  return true;
}
```

- [ ] **Step 4: Verify 11 passing.**

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(kurodoko): _propagate orchestrator + top-level lookahead"
```

---

## Task 5: solve + backtracking + caches + computePuzzleDiff arm

**Files:** `solver.js`, `tests/kurodoko.test.js` (append).

- [ ] **Step 1: Failing tests — append:**

```js
test('KurodokoSolver.solve: solves the recon 5x5', () => {
  KurodokoSolver.clearSolutionCache();
  const s = new KurodokoSolver({
    rows: 5, cols: 5,
    task: [
      [-1,-1,-1,6,-1],
      [-1,4,-1,7,-1],
      [-1,-1,-1,-1,-1],
      [-1,5,-1,8,-1],
      [-1,5,-1,-1,-1],
    ],
    maxMs: 5000,
  });
  const r = s.solve();
  assert.equal(r.solved, true);
  // Validate the solution: clue cells are 0 (or 2 internally → 0 emitted);
  // every cell determined.
  let blacks = 0, whites = 0, unknowns = 0;
  for (const row of r.grid) for (const v of row) {
    if (v === 1) blacks++;
    else if (v === 2) whites++;
    else if (v === 0) unknowns++;
  }
  // Clue cells in r.grid should be 0 (we filter them out in _emit).
  // 6 clue cells in the recon.
  assert.equal(unknowns, 6, `expected 6 unknown cells (clue positions) in emit, got ${unknowns}`);
});

test('KurodokoSolver.solve: returns {solved:false, grid:null} on unsat', () => {
  KurodokoSolver.clearSolutionCache();
  const s = new KurodokoSolver({
    rows: 2, cols: 2,
    task: [[4,-1],[-1,-1]],
  });
  const r = s.solve();
  assert.equal(r.solved, false);
  assert.equal(r.grid, null);
});

test('KurodokoSolver._solutionCache: cache hit returns deep copy', () => {
  KurodokoSolver.clearSolutionCache();
  const opts = { rows: 3, cols: 3, task: [[-1,-1,-1],[-1,5,-1],[-1,-1,-1]] };
  const a = new KurodokoSolver(opts).solve();
  a.grid[0][0] = 99;
  const b = new KurodokoSolver(opts).solve();
  assert.notEqual(b.grid[0][0], 99);
});

test('computePuzzleDiff kurodoko: flags wrong-color cells, ignores unknown', () => {
  const { computePuzzleDiff } = require('../solver.js');
  const solution = [[1, 2], [2, 1]];
  const board = [[2, 2], [0, 1]];
  const diff = computePuzzleDiff('kurodoko', board, solution);
  assert.equal(diff.length, 1);
  assert.deepEqual(diff[0], { row: 0, col: 0, expected: 1, actual: 2 });
});
```

- [ ] **Step 2: Verify failure.**

- [ ] **Step 3: Implement — inside `KurodokoSolver`:**

```js
_isComplete() {
  for (let i = 0; i < this.rows * this.cols; i++) {
    if (this.cellStatus[i] === 0) return false;
  }
  return true;
}

_emit() {
  const grid = [];
  for (let r = 0; r < this.rows; r++) {
    const row = new Array(this.cols);
    for (let c = 0; c < this.cols; c++) {
      const idx = r * this.cols + c;
      // Clue cells emit 0 (page expects cellStatus=0 for clue cells).
      row[c] = (this.task[idx] !== -1) ? 0 : this.cellStatus[idx];
    }
    grid.push(row);
  }
  return grid;
}

_pickBestUnknown() {
  let bestIdx = -1, bestScore = -Infinity;
  const total = this.rows * this.cols;
  for (let i = 0; i < total; i++) {
    if (this.cellStatus[i] !== 0) continue;
    const r = (i / this.cols) | 0, c = i - r * this.cols;
    // Count adjacent determined cells as a proxy for "constrained".
    let adj = 0;
    if (r > 0 && this.cellStatus[i - this.cols] !== 0) adj++;
    if (r < this.rows - 1 && this.cellStatus[i + this.cols] !== 0) adj++;
    if (c > 0 && this.cellStatus[i - 1] !== 0) adj++;
    if (c < this.cols - 1 && this.cellStatus[i + 1] !== 0) adj++;
    const score = adj;
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }
  return bestIdx;
}

_backtrack() {
  if (this._timeUp()) return false;
  const idx = this._pickBestUnknown();
  if (idx < 0) return this._isComplete();
  this._depth++;
  for (const v of [1, 2]) {
    const mark = this.trail.length;
    if (this._set(idx, v) && this._propagate() && this._backtrack()) {
      this._depth--;
      return true;
    }
    this._rollback(mark);
    if (this._timeUp()) break;
  }
  this._depth--;
  return false;
}

solve() {
  const key = this._cacheKey();
  const cached = KurodokoSolver._solutionCache.get(key)
              || KurodokoSolver._partialCache.get(key);
  if (cached) return this._cloneResult(cached);
  this._startedAt = Date.now();
  let result;
  if (!this._propagate()) {
    this._rollback(0);
    result = { solved: false, grid: null };
  } else if (this._isComplete()) {
    result = { solved: true, grid: this._emit() };
  } else if (this._backtrack()) {
    result = { solved: true, grid: this._emit() };
  } else {
    const partial = this._emit();
    result = this._timeUp()
      ? { solved: false, grid: partial, error: 'timed out', partial: true }
      : { solved: false, grid: null };
  }
  if (result.solved || result.partial) this._storeInCache(key, result);
  return result;
}
```

Then add static fields + helpers at the BOTTOM of `KurodokoSolver`:

```js
static _solutionCache = new Map();
static _maxSolutionCache = 50;
static _partialCache = new Map();
static _maxPartialCache = 20;
static clearSolutionCache() {
  KurodokoSolver._solutionCache.clear();
  KurodokoSolver._partialCache.clear();
}

_cacheKey() {
  let h = 0x811c9dc5;
  const mix = (n) => { h ^= n & 0xff; h = Math.imul(h, 0x01000193) >>> 0; };
  mix(this.rows); mix(this.cols);
  for (let i = 0; i < this.rows * this.cols; i++) mix(this.task[i] + 1);
  return h >>> 0;
}

_cloneResult(r) {
  return {
    solved: r.solved,
    grid: r.grid ? r.grid.map(row => row.slice()) : null,
    ...(r.error !== undefined ? { error: r.error } : {}),
    ...(r.partial !== undefined ? { partial: r.partial } : {}),
  };
}

_storeInCache(key, result) {
  const m = result.partial ? KurodokoSolver._partialCache : KurodokoSolver._solutionCache;
  const max = result.partial ? KurodokoSolver._maxPartialCache : KurodokoSolver._maxSolutionCache;
  if (m.size >= max) {
    const first = m.keys().next().value;
    m.delete(first);
  }
  m.set(key, this._cloneResult(result));
}
```

Then extend `computePuzzleDiff`. Find the existing `if (type === 'heyawake' || type === 'hitori' || type === 'kakurasu')` arm. Add `|| type === 'kurodoko'`.

- [ ] **Step 4: Verify 15 passing.**

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(kurodoko): solve() with backtracking + caches + computePuzzleDiff arm"
```

---

## Task 6: Stepwise getHint

**Files:** `solver.js`, `tests/kurodoko.test.js` (append).

Rule-by-rule: try visibility per clue, then connectivity, then single lookahead.

- [ ] **Step 1: Failing tests — append:**

```js
test('KurodokoSolver.getHint: K=1 yields immediate neighbours-black hint', () => {
  KurodokoSolver.clearSolutionCache();
  const s = new KurodokoSolver({
    rows: 3, cols: 3,
    task: [[-1,-1,-1],[-1,1,-1],[-1,-1,-1]],
  });
  // Live state: all zeros except (1,1) is clue=1.
  const initial = [[0,0,0],[0,0,0],[0,0,0]];
  const hint = s.getHint(initial);
  assert.ok(Array.isArray(hint));
  assert.ok(hint.length >= 1);
  // At least one of (0,1), (1,0), (1,2), (2,1) should be in the hint as black.
  const expectedBlackCoords = [[0,1],[1,0],[1,2],[2,1]];
  const found = expectedBlackCoords.some(([r,c]) =>
    hint.some(h => h.row === r && h.col === c && h.value === 1));
  assert.ok(found, `expected at least one neighbour-of-(1,1) forced black; got ${JSON.stringify(hint)}`);
});

test('KurodokoSolver.getHint: null on solved board', () => {
  KurodokoSolver.clearSolutionCache();
  const s = new KurodokoSolver({
    rows: 3, cols: 3,
    task: [[-1,-1,-1],[-1,1,-1],[-1,-1,-1]],
  });
  // Solved state: 4-neighbours black, rest white. Pass as initialState.
  // (0,0), (0,2), (2,0), (2,2) white; (0,1), (1,0), (1,2), (2,1) black;
  // (1,1) clue (page stores 0).
  const solved = [
    [2, 1, 2],
    [1, 0, 1],
    [2, 1, 2],
  ];
  assert.equal(s.getHint(solved), null);
});
```

- [ ] **Step 2: Verify failure.**

- [ ] **Step 3: Implement — inside `KurodokoSolver`:**

```js
getHint(initialState) {
  const total = this.rows * this.cols;
  // Reset cellStatus to initialState; the constructor's clue-forcing
  // is in the original cellStatus, so a fresh load needs re-forcing.
  for (let r = 0; r < this.rows; r++) {
    for (let c = 0; c < this.cols; c++) {
      this.cellStatus[r * this.cols + c] = initialState[r][c];
    }
  }
  this.trail = [];
  this._depth = 0;
  this._inLookahead = false;
  this._startedAt = Date.now();
  // Force clue cells to white (matching constructor behavior).
  for (let i = 0; i < this.clues.length; i++) {
    if (this.cellStatus[this.clues[i]] === 0) {
      if (!this._set(this.clues[i], 2)) return null;
    }
  }
  const before = new Uint8Array(total);
  for (let i = 0; i < total; i++) before[i] = this.cellStatus[i];

  const collectChanged = () => {
    const out = [];
    for (let i = 0; i < total; i++) {
      if (before[i] === 0 && this.cellStatus[i] !== 0 && this.task[i] === -1) {
        const r = (i / this.cols) | 0;
        const c = i - r * this.cols;
        out.push({ row: r, col: c, value: this.cellStatus[i] });
      }
    }
    return out;
  };

  // Per-clue visibility — stop at first that yields changes.
  // Run _applyVisibility once and check; if any cells changed, return them.
  const cm = this.trail.length;
  if (!this._applyVisibility()) return null;
  if (this.trail.length > cm) {
    const h = collectChanged();
    if (h.length) return h;
  }

  // Connectivity.
  if (!this._applyConnectivity()) return null;
  {
    const h = collectChanged();
    if (h.length) return h;
  }

  // Single lookahead probe.
  for (let i = 0; i < total; i++) {
    if (this.cellStatus[i] !== 0) continue;
    const survivors = [];
    for (const v of [1, 2]) {
      const mark = this.trail.length;
      this._inLookahead = true;
      const okSet = this._set(i, v);
      const ok = okSet && this._propagate();
      this._rollback(mark);
      this._inLookahead = false;
      if (ok) survivors.push(v);
      if (survivors.length > 1) break;
    }
    if (survivors.length === 0) return null;
    if (survivors.length === 1) {
      if (!this._set(i, survivors[0])) return null;
      const h = collectChanged();
      if (h.length) return h;
    }
  }

  return null;
}
```

- [ ] **Step 4: Verify 17 passing.**

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(kurodoko): stepwise getHint (clue cells filtered from changed-set)"
```

---

## Task 7: Fuzz soundness test

**Files:** Create `tests/kurodoko-fuzz.test.js`.

Generate random valid shading (random 0/1 grid respecting adjacency + connectivity), pick K random clue cells, walk visibility arms to derive their values. Then solve and validate all 4 rules.

- [ ] **Step 1: Create:**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { KurodokoSolver } = require('../solver.js');

function generatePuzzle(rows, cols, seed) {
  let rng = seed >>> 0;
  const rand = () => {
    rng = (rng * 1103515245 + 12345) >>> 0;
    return rng / 0x100000000;
  };
  const shade = Array.from({ length: rows }, () => new Array(cols).fill(0));
  // Random shading respecting adjacency rule.
  const cells = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push([r, c]);
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  for (const [r, c] of cells) {
    if (rand() > 0.25) continue;
    if (r > 0 && shade[r-1][c] === 1) continue;
    if (r < rows-1 && shade[r+1][c] === 1) continue;
    if (c > 0 && shade[r][c-1] === 1) continue;
    if (c < cols-1 && shade[r][c+1] === 1) continue;
    shade[r][c] = 1;
    if (!whitesConnected(shade, rows, cols)) shade[r][c] = 0;
  }
  // Pick clue cells from whites (~40%).
  const task = Array.from({ length: rows }, () => new Array(cols).fill(-1));
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (shade[r][c] === 0 && rand() < 0.4) {
      task[r][c] = visibility(r, c, shade, rows, cols);
    }
  }
  return { task, shade };
}

function visibility(r, c, shade, rows, cols) {
  let total = 1;
  // up
  for (let rr = r - 1; rr >= 0 && shade[rr][c] === 0; rr--) total++;
  // down
  for (let rr = r + 1; rr < rows && shade[rr][c] === 0; rr++) total++;
  // left
  for (let cc = c - 1; cc >= 0 && shade[r][cc] === 0; cc--) total++;
  // right
  for (let cc = c + 1; cc < cols && shade[r][cc] === 0; cc++) total++;
  return total;
}

function whitesConnected(shade, rows, cols) {
  let anchor = -1;
  for (let r = 0; r < rows && anchor < 0; r++) for (let c = 0; c < cols; c++) {
    if (shade[r][c] === 0) { anchor = r * cols + c; break; }
  }
  if (anchor < 0) return true;
  const visited = new Uint8Array(rows * cols);
  visited[anchor] = 1;
  const stack = [anchor];
  while (stack.length) {
    const u = stack.pop();
    const r = (u / cols) | 0, c = u - r * cols;
    const ns = [];
    if (r > 0) ns.push(u - cols);
    if (r < rows - 1) ns.push(u + cols);
    if (c > 0) ns.push(u - 1);
    if (c < cols - 1) ns.push(u + 1);
    for (const ni of ns) {
      if (visited[ni]) continue;
      const nr = (ni / cols) | 0, nc = ni - nr * cols;
      if (shade[nr][nc] !== 0) continue;
      visited[ni] = 1;
      stack.push(ni);
    }
  }
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (shade[r][c] === 0 && !visited[r * cols + c]) return false;
  }
  return true;
}

function validate(rows, cols, task, grid) {
  // Rule 1: clue cells must be white (cellStatus 0 in emit since we skip them).
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (task[r][c] !== -1 && grid[r][c] === 1) return `rule 1: clue cell (${r},${c}) shaded black`;
  }
  // Rule 2: visibility sums.
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (task[r][c] === -1) continue;
    const K = task[r][c];
    const isWhite = (rr, cc) => grid[rr][cc] === 2 || (task[rr][cc] !== -1);
    let sum = 1;
    for (let rr = r - 1; rr >= 0 && isWhite(rr, c); rr--) sum++;
    for (let rr = r + 1; rr < rows && isWhite(rr, c); rr++) sum++;
    for (let cc = c - 1; cc >= 0 && isWhite(r, cc); cc--) sum++;
    for (let cc = c + 1; cc < cols && isWhite(r, cc); cc++) sum++;
    if (sum !== K) return `rule 2: clue (${r},${c})=${K} but visibility = ${sum}`;
  }
  // Rule 3: no adjacent blacks.
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (grid[r][c] !== 1) continue;
    if (r > 0 && grid[r-1][c] === 1) return `rule 3 at (${r-1},${c})-(${r},${c})`;
    if (c > 0 && grid[r][c-1] === 1) return `rule 3 at (${r},${c-1})-(${r},${c})`;
  }
  // Rule 4: white connectivity (treat clue cells as white).
  const isWhite = (rr, cc) => grid[rr][cc] === 2 || (task[rr][cc] !== -1);
  let anchor = -1;
  for (let r = 0; r < rows && anchor < 0; r++) for (let c = 0; c < cols; c++) {
    if (isWhite(r, c)) { anchor = r * cols + c; break; }
  }
  if (anchor < 0) return null;
  const visited = new Uint8Array(rows * cols);
  visited[anchor] = 1;
  const stack = [anchor];
  while (stack.length) {
    const u = stack.pop();
    const r = (u / cols) | 0, c = u - r * cols;
    const ns = [];
    if (r > 0) ns.push(u - cols);
    if (r < rows - 1) ns.push(u + cols);
    if (c > 0) ns.push(u - 1);
    if (c < cols - 1) ns.push(u + 1);
    for (const ni of ns) {
      if (visited[ni]) continue;
      const nr = (ni / cols) | 0, nc = ni - nr * cols;
      if (!isWhite(nr, nc)) continue;
      visited[ni] = 1;
      stack.push(ni);
    }
  }
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (isWhite(r, c) && !visited[r * cols + c]) return `rule 4: white at (${r},${c}) disconnected`;
  }
  return null;
}

test('KurodokoSolver fuzz: solved boards satisfy all 4 rules', () => {
  KurodokoSolver.clearSolutionCache();
  let solved = 0;
  for (let seed = 1; seed <= 30; seed++) {
    KurodokoSolver.clearSolutionCache();
    const rows = 4 + (seed % 3);
    const cols = 4 + ((seed >> 2) % 3);
    const { task } = generatePuzzle(rows, cols, seed * 9173 + 1);
    const s = new KurodokoSolver({ rows, cols, task, maxMs: 3000 });
    const r = s.solve();
    if (!r.solved) continue;
    const err = validate(rows, cols, task, r.grid);
    assert.equal(err, null, `seed=${seed} ${rows}x${cols}: ${err}`);
    solved++;
  }
  assert.ok(solved >= 10, `expected ≥ 10 solved boards, got ${solved}`);
});
```

- [ ] **Step 2: Run.** Expect PASS.

- [ ] **Step 3: Commit**

```bash
jj commit -m "test(kurodoko): fuzz suite for 4-rule soundness"
```

---

## Task 8: Fixtures + golden + integration test

**Files:** `tests/fixtures/puzzles.js`, `tests/golden.js`, `tests/solver.test.js`.

- [ ] **Step 1: Add fixture:**

```js
exports.kurodoko5x5Easy = {
  type: 'kurodoko',
  rows: 5,
  cols: 5,
  task: [
    [-1,-1,-1,6,-1],
    [-1,4,-1,7,-1],
    [-1,-1,-1,-1,-1],
    [-1,5,-1,8,-1],
    [-1,5,-1,-1,-1],
  ],
};
```

- [ ] **Step 2: Solve once to capture golden, then add to `tests/golden.js`:**

Run from the repo root:
```bash
node -e "
const { KurodokoSolver } = require('./solver.js');
const f = require('./tests/fixtures/puzzles.js').kurodoko5x5Easy;
const s = new KurodokoSolver({ rows: f.rows, cols: f.cols, task: f.task });
const r = s.solve();
if (!r.solved) { console.error('NO SOLUTION'); process.exit(1); }
console.log(JSON.stringify(r.grid));
"
```

Paste the printed 2D array into `tests/golden.js`:

```js
exports.kurodoko5x5Easy = <pasted-2D-array>;
```

- [ ] **Step 3: Integration test in `tests/solver.test.js`:**

```js
test('KurodokoSolver: kurodoko5x5Easy fixture matches golden', () => {
  const { KurodokoSolver } = require('../solver.js');
  const fixture = require('./fixtures/puzzles.js').kurodoko5x5Easy;
  KurodokoSolver.clearSolutionCache();
  const s = new KurodokoSolver({
    rows: fixture.rows,
    cols: fixture.cols,
    task: fixture.task,
  });
  const r = s.solve();
  assert.equal(r.solved, true);
  assert.deepEqual(r.grid, require('./golden.js').kurodoko5x5Easy);
});
```

Ensure `KurodokoSolver` is imported at the top of `tests/solver.test.js`.

- [ ] **Step 4: `npm test` — expect clean.**

- [ ] **Step 5: Commit**

```bash
jj commit -m "test(kurodoko): puzzles.js fixture + golden snapshot + integration test"
```

---

## Task 9: MAIN-world fns + allowlist + globals.d.ts + eslint

**Files:** `main-world.js`, `background.js`, `globals.d.ts`, `eslint.config.js`.

- [ ] **Step 1: Add `readKurodokoData`:**

```js
function readKurodokoData() {
  try {
    var G = window.Game;
    if (!G || !G.task || !G.puzzleWidth || !G.puzzleHeight) return null;
    var rows = G.puzzleHeight, cols = G.puzzleWidth;
    var task = [];
    for (var r = 0; r < rows; r++) {
      var row = G.task[r] || [];
      var arr = new Array(cols);
      for (var c = 0; c < cols; c++) {
        var v = row[c];
        arr[c] = (typeof v === 'number') ? v : -1;
      }
      task.push(arr);
    }
    return { rows: rows, cols: cols, task: task };
  } catch (e) {
    return null;
  }
}
```

- [ ] **Step 2: Add `readKurodokoState`:**

```js
function readKurodokoState(rows, cols) {
  try {
    var G = window.Game;
    if (!G || !G.currentState || !G.currentState.cellStatus) return null;
    var cs = G.currentState.cellStatus;
    var grid = [];
    for (var r = 0; r < rows; r++) {
      var row = cs[r] || [];
      var arr = new Array(cols);
      for (var c = 0; c < cols; c++) arr[c] = row[c] || 0;
      grid.push(arr);
    }
    return grid;
  } catch (e) {
    return null;
  }
}
```

- [ ] **Step 3: Add `applyKurodokoState` — **must skip clue cells** (where task[r][c] !== -1):**

```js
function applyKurodokoState(grid) {
  try {
    var G = window.Game;
    if (!G || !G.currentState || !G.currentState.cellStatus || !G.task) return false;
    if (typeof G.saveState === 'function') G.saveState(true);
    var cs = G.currentState.cellStatus;
    for (var r = 0; r < grid.length; r++) {
      if (!cs[r]) cs[r] = [];
      for (var c = 0; c < grid[r].length; c++) {
        // Skip clue cells — page tracks them via taskStatus, not cellStatus.
        var taskVal = (G.task[r] && typeof G.task[r][c] === 'number') ? G.task[r][c] : -1;
        if (taskVal !== -1) continue;
        cs[r][c] = grid[r][c];
      }
    }
    if (typeof G.drawCurrentState === 'function') G.drawCurrentState();
    if (typeof G.render === 'function') G.render();
    if (typeof G.redraw === 'function') G.redraw();
    return true;
  } catch (e) {
    console.warn('Kurodoko apply failed:', e);
    return false;
  }
}
```

- [ ] **Step 4: background.js EXEC_MAIN_ALLOWLIST — add 3 entries.**
- [ ] **Step 5: globals.d.ts — add 3 to MainWorldFn + `declare const KurodokoSolver: any;`.**
- [ ] **Step 6: eslint.config.js — add `KurodokoSolver` to solverClasses.**
- [ ] **Step 7: Verify `npm run lint && npm run typecheck && npm test`.**
- [ ] **Step 8: Commit**

```bash
jj commit -m "feat(kurodoko): MAIN-world read/apply fns + allowlist + globals.d.ts"
```

---

## Task 10: Worker arm + handler

**Files:** `solver.worker.js`, `handler.js`.

- [ ] **Step 1: Worker arm** — add `KurodokoSolver` to `/* global */`, then:

```js
} else if (type === 'kurodoko' && extraData) {
  const s = new KurodokoSolver({
    rows: extraData.rows,
    cols: extraData.cols,
    task: extraData.task,
    initialState: initialGrid || null,
    maxMs: 30000,
  });
  result = s.solve();
}
```

- [ ] **Step 2: Register handler** — after `kakurasuHandler`:

```js
const kurodokoHandler = {
  name: 'puzzles-mobile-kurodoko',
  priority: 30,
  matches() {
    return isPuzzlesMobilePage() && window.location.pathname.includes('/kurodoko/');
  },
  async detect() {
    const result = { found: false, rows: 0, cols: 0, rowClues: [], colClues: [] };
    const data = await callMainWorld('readKurodokoData', []);
    if (!data) return { ...result, error: 'No Kurodoko task data found' };
    const stageEl = document.getElementById('stage') ||
                    document.getElementById('game') ||
                    document.querySelector('[class*="game"], [class*="puzzle"]');
    return {
      found: true,
      type: 'kurodoko',
      rows: data.rows,
      cols: data.cols,
      task: data.task,
      rowClues: [], colClues: [],
      _cells: [],
      _element: stageEl,
    };
  },
  async readState(ctx) {
    const state = await callMainWorld('readKurodokoState', [ctx.rows, ctx.cols]);
    if (state) return state;
    return Array.from({ length: ctx.rows }, () => new Array(ctx.cols).fill(0));
  },
  async applySolution(solution, _ctx) {
    const ok = await callMainWorld('applyKurodokoState', [solution]);
    return ok ? { success: true } : { success: false, error: 'Kurodoko apply failed' };
  },
};

registerHandler(kurodokoHandler);
```

- [ ] **Step 3: Verify `npm run lint && npm run typecheck && npm test`.**

- [ ] **Step 4: Commit**

```bash
jj commit -m "feat(kurodoko): worker dispatch arm + handler registration"
```

---

## Task 11: Dump + real fixture + bench-real

**Files:** `main-world.js`, `tests/fixtures/real-puzzles.js`, `tests/bench-real.js`.

- [ ] **Step 1: Inline dump arm in `dumpPuzzleForBench`:**

```js
if (path.indexOf('/kurodoko/') !== -1 || g.slug === 'kurodoko') {
  if (!g.task || !g.puzzleWidth || !g.puzzleHeight) {
    return { error: 'kurodoko: missing task/dims', diagnostic: diagnostic(g), path: path };
  }
  var kdRows = g.puzzleHeight, kdCols = g.puzzleWidth;
  var kdTask = [];
  for (var kdr = 0; kdr < kdRows; kdr++) {
    var srcRow = g.task[kdr] || [];
    var dstRow = new Array(kdCols);
    for (var kdc = 0; kdc < kdCols; kdc++) {
      var v = srcRow[kdc];
      dstRow[kdc] = (typeof v === 'number') ? v : -1;
    }
    kdTask.push(dstRow);
  }
  return { type: 'kurodoko', rows: kdRows, cols: kdCols, task: kdTask, path: path };
}
```

- [ ] **Step 2: Real fixture in real-puzzles.js:**

```js
exports.kurodoko5x5EasyReal = {
  type: 'kurodoko',
  rows: 5,
  cols: 5,
  task: [
    [-1,-1,-1,6,-1],
    [-1,4,-1,7,-1],
    [-1,-1,-1,-1,-1],
    [-1,5,-1,8,-1],
    [-1,5,-1,-1,-1],
  ],
};
```

- [ ] **Step 3: bench-real.js arm — mirror the kakurasu arm.**

- [ ] **Step 4: `node tests/bench-real.js` — expect kurodoko5x5EasyReal solves.**

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(kurodoko): dumpPuzzleForBench arm + real fixture + bench-real arm"
```

---

## Task 12: bench-kurodoko.js + CI step

**Files:** Create `tests/bench-kurodoko.js`, modify `.github/workflows/bench-nightly.yml`.

- [ ] **Step 1:**

```js
'use strict';
const { KurodokoSolver } = require('../solver.js');
const fixture = require('./fixtures/real-puzzles.js').kurodoko5x5EasyReal;

const ITERATIONS = 5;
const WARMUP = 2;
const times = [];
for (let i = 0; i < WARMUP + ITERATIONS; i++) {
  KurodokoSolver.clearSolutionCache();
  const s = new KurodokoSolver({
    rows: fixture.rows,
    cols: fixture.cols,
    task: fixture.task,
  });
  const t0 = process.hrtime.bigint();
  const r = s.solve();
  const t1 = process.hrtime.bigint();
  if (!r.solved) {
    console.error('kurodoko5x5EasyReal failed to solve');
    process.exit(1);
  }
  if (i >= WARMUP) times.push(Number(t1 - t0) / 1e6);
}
times.sort((a, b) => a - b);
const median = times[Math.floor(times.length / 2)];
console.log(`kurodoko5x5EasyReal: median ${median.toFixed(2)} ms over ${ITERATIONS} runs`);
```

- [ ] **Step 2: Run, expect a median print.**

- [ ] **Step 3: CI step:**

```yaml
      - name: Bench Kurodoko
        run: node tests/bench-kurodoko.js
```

- [ ] **Step 4: Commit**

```bash
jj commit -m "ci(kurodoko): bench script + nightly workflow step"
```

---

## Task 13: content.js bookkeeping

**Files:** `content.js`.

- [ ] **Step 1: SUPPORTED_PUZZLES** — insert (alphabetical: between Kakurasu and Nonogram):

```js
  { name: 'Kurodoko',     url: 'https://www.puzzles-mobile.com/kurodoko/' },
```

- [ ] **Step 2: SOLUTION_KEY_PREFIXES** — add `'kurodoko-solution:'`.

- [ ] **Step 3: kurodokoCacheKey** — after `kakurasuCacheKey`:

```js
function kurodokoCacheKey(data) {
  if (data?.type !== 'kurodoko' || !data.task) return null;
  let h = 0x811c9dc5;
  const mix = (n) => { h ^= n & 0xff; h = Math.imul(h, 0x01000193) >>> 0; };
  mix(0x44); // 'D' nameplate (kuroDoko)
  mix(data.rows); mix(data.cols);
  for (const row of data.task) for (const v of row) mix(v + 1);
  return 'kurodoko-solution:' + (h >>> 0).toString(16);
}
```

Wire alongside kakurasuCacheKey at both ternary dispatch sites.

- [ ] **Step 4: solveExtraData arm:**

```js
if (data.type === 'kurodoko') {
  return { rows: data.rows, cols: data.cols, task: data.task };
}
```

- [ ] **Step 5: kurodokoTaskSig + staticSig segment** — after kakurasuCluesSig:

```js
function kurodokoTaskSig(task) {
  if (!task) return '0';
  let h = 0x811c9dc5;
  for (const row of task) for (const v of row) {
    h ^= (v + 1) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16);
}
```

In `staticSig`, append `'|kd=' + kurodokoTaskSig(pd?.type === 'kurodoko' ? pd.task : null)`.

- [ ] **Step 6: pendingAutoSolve gate** — extend `skipAutoSolveGate` to include kurodoko.

- [ ] **Step 7: drawPreview rect-bail** — add `|| pd?.type === 'kurodoko'`.

- [ ] **Step 8: Verify `npm run lint && npm run typecheck && npm test`.**

- [ ] **Step 9: Commit**

```bash
jj commit -m "feat(kurodoko): content.js bookkeeping (SUPPORTED_PUZZLES, prefix, cache key, sig, gate)"
```

---

## Task 14: content.js drawPreview arm

**Files:** `content.js`.

Renders the grid with clue numbers in clue cells, shaded fills for cellStatus=1, cross/X marks for cellStatus=2, blank for unknown (0).

- [ ] **Step 1: Read the hitori arm in drawPreview for reference.**

- [ ] **Step 2: Add a kurodoko arm:**

```js
} else if (isKurodoko) {
  const v = grid[r][c];
  const taskVal = (pd.task && pd.task[r] && typeof pd.task[r][c] === 'number') ? pd.task[r][c] : -1;
  if (taskVal !== -1) {
    // Clue cell: render the number on a light/neutral background.
    ctx.font = `bold ${Math.floor(cellSize * 0.5)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#1f2937';
    ctx.fillText(String(taskVal), x + cellSize / 2, y + cellSize / 2);
  } else if (v === 1) {
    // Shaded: solid dark inset.
    const pad = Math.max(2, Math.floor(cellSize * 0.1));
    ctx.fillStyle = '#1f2937';
    ctx.fillRect(x + pad, y + pad, cellSize - 2*pad, cellSize - 2*pad);
  } else if (v === 2) {
    // White / cross-mark: small X.
    const pad = Math.max(3, Math.floor(cellSize * 0.25));
    ctx.strokeStyle = '#9ca3af';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + pad, y + pad);
    ctx.lineTo(x + cellSize - pad, y + cellSize - pad);
    ctx.moveTo(x + cellSize - pad, y + pad);
    ctx.lineTo(x + pad, y + cellSize - pad);
    ctx.stroke();
  }
  // v === 0: blank
}
```

Add `const isKurodoko = puzzleData?.type === 'kurodoko';` near the other type flags. Add `if (v === 0 && !isShikaku && !isHitori && !isKurodoko) continue;` to the skip condition.

For the static layer (light grid lines + outer border): clone from hitori's static-layer code, no clue text on static layer (clue numbers go on the dynamic layer since drawPreview re-runs every frame).

For hint overlay: extend the hitori-style band/cell handling so kurodoko renders a blue ring on each forced cell. For mistake rings: generic `{row, col}` arm via `computePuzzleDiff('kurodoko', ...)`.

- [ ] **Step 3: Verify `npm run lint && npm run typecheck && npm test && npm run build`.**

- [ ] **Step 4: Commit**

```bash
jj commit -m "feat(kurodoko): drawPreview arm with clue numbers + shaded fills + cross marks"
```

---

## Task 15: content.js getHint + hintStatusNodes + partial arm + Loop break

**Files:** `content.js`.

- [ ] **Step 1: getHint dispatch** — after kakurasu arm:

```js
} else if (detectedGrid.type === 'kurodoko') {
  if (solution && firstMismatch(grid, solution)) {
    return { success: false, error: 'Current game state is wrong.' };
  }
  const solver = new KurodokoSolver({
    rows, cols, task: detectedGrid.task,
  });
  const hintCells = solver.getHint(grid);
  if (!hintCells || hintCells.length === 0) {
    return { success: false, error: 'No more cells can be deduced from the current state. Click Solve to finish.' };
  }
  hint = { type: 'kurodoko', extraCells: hintCells, count: hintCells.length };
}
```

- [ ] **Step 2: kurodokoHintStatusNodes + setHintStatus arm:**

```js
function kurodokoHintStatusNodes(h) {
  const cells = h.extraCells || [];
  if (cells.length === 0) return ['No hint available'];
  if (cells.length === 1) {
    const cell = cells[0];
    const valueStr = cell.value === 1 ? 'shaded' : 'unshaded';
    return [
      'Cell ', bold(`(row ${cell.row + 1}, col ${cell.col + 1})`),
      ' must be ', bold(valueStr),
    ];
  }
  return [bold(String(cells.length)), ' cells can be deduced'];
}
```

In `setHintStatus`:
```js
} else if (puzzleData?.type === 'kurodoko') {
  setStatusNodes('info', prefix, ...kurodokoHintStatusNodes(h));
}
```

- [ ] **Step 3: solveHandler partial arm:**

```js
if (result?.partial && puzzleData?.type === 'kurodoko' && Array.isArray(result.grid)) {
  applyGridPartialResult(result);
  return;
}
```

- [ ] **Step 4: Loop early-break** — add `&& hr.hint?.type !== 'kurodoko'`.

- [ ] **Step 5: Verify `npm run lint && npm run typecheck && npm test && npm run build`.**

- [ ] **Step 6: Commit**

```bash
jj commit -m "feat(kurodoko): content.js getHint dispatch + hintStatusNodes + partial arm + Loop break"
```

---

## Task 16: Final verification + push

- [ ] **Step 1: Full suite, lint, typecheck, build.**
- [ ] **Step 2: Bench.**
- [ ] **Step 3: Manual smoke (browser).**
- [ ] **Step 4: Push** — `jj bookmark set main -r @-` then `jj git push --bookmark main`.

End of plan.
