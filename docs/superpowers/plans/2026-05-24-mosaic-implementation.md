# Mosaic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Mosaic (Fill-a-Pix) support — 13th puzzle type. Single-rule puzzle: each clue's 3×3 neighborhood count of blacks equals the clue value.

**Architecture:** `MosaicSolver` follows Hitori shape but simpler — no adjacency rule (so `_set` is plain trail+write), no connectivity rule. Just the per-clue 3×3 neighborhood count. Cell encoding 0/1/2 matches.

**Reference spec:** `docs/superpowers/specs/2026-05-24-mosaic-design.md`
**Closest existing solver:** Kurodoko (clue-cell + cell-state encoding) minus the visibility, adjacency, and connectivity rules.

`jj commit` not git. Repo `/home/quando/documents/chrome-puzzle-solver/`. TDD.

---

## Task 1: MosaicSolver scaffold + _set (no adjacency) + _rollback

**Files:** `solver.js`, `tests/mosaic.test.js` (new).

- [ ] **Step 1: Failing test:**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MosaicSolver } = require('../solver.js');

test('MosaicSolver: constructor mirrors task and initialState', () => {
  const s = new MosaicSolver({
    rows: 2, cols: 2,
    task: [[-1, 3], [-1, -1]],
    initialState: [[0, 1], [2, 0]],
  });
  assert.equal(s.rows, 2);
  assert.equal(s.cols, 2);
  assert.equal(s.cellStatus[0], 0);
  assert.equal(s.cellStatus[1], 1);
  assert.equal(s.cellStatus[2], 2);
  assert.equal(s.cellStatus[3], 0);
  assert.equal(s.task[1], 3);
  assert.equal(s.clues.length, 1);
  assert.equal(s.clueValues[0], 3);
});

test('MosaicSolver: _set does NOT cascade (no adjacency rule)', () => {
  const s = new MosaicSolver({
    rows: 3, cols: 3, task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  assert.equal(s._set(4, 1), true);
  assert.equal(s.cellStatus[4], 1);
  // Neighbours stay unknown — Mosaic has no adjacency rule.
  assert.equal(s.cellStatus[1], 0);
  assert.equal(s.cellStatus[3], 0);
  assert.equal(s.cellStatus[5], 0);
  assert.equal(s.cellStatus[7], 0);
});

test('MosaicSolver: _set / _rollback round-trip', () => {
  const s = new MosaicSolver({ rows: 1, cols: 2, task: [[-1, -1]] });
  const mark = s.trail.length;
  assert.equal(s._set(0, 2), true);
  s._rollback(mark);
  assert.equal(s.cellStatus[0], 0);
});
```

- [ ] **Step 2: Verify failure** — `MosaicSolver is not defined`.

- [ ] **Step 3: Add MosaicSolver to solver.js** (after `KurodokoSolver`, before `module.exports`):

```js
class MosaicSolver {
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
  }

  _set(idx, value) {
    const old = this.cellStatus[idx];
    if (old === value) return true;
    if (old !== 0) return false;
    this.trail.push(idx | (old << 24));
    this.cellStatus[idx] = value;
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

Update `module.exports` to include `MosaicSolver`.

- [ ] **Step 4: Verify 3 passing.**

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(mosaic): MosaicSolver scaffold (no adjacency, no connectivity)"
```

---

## Task 2: Build per-clue 3×3 neighborhoods

**Files:** `solver.js` (add `_buildNeighborhoods` + constructor call), `tests/mosaic.test.js` (append).

For each clue, precompute the list of cell flat-indices in its 3×3 (clamped) neighborhood.

- [ ] **Step 1: Failing tests — append:**

```js
test('MosaicSolver._buildNeighborhoods: interior clue has 9 cells', () => {
  const s = new MosaicSolver({
    rows: 3, cols: 3,
    task: [[-1,-1,-1],[-1,5,-1],[-1,-1,-1]],
  });
  // Single clue at (1,1) center. Neighborhood: all 9 cells.
  assert.equal(s.clueNeighborhood[0].length, 9);
  const set = new Set(Array.from(s.clueNeighborhood[0]));
  for (let i = 0; i < 9; i++) assert.ok(set.has(i), `expected idx ${i}`);
});

test('MosaicSolver._buildNeighborhoods: corner clue has 4 cells', () => {
  const s = new MosaicSolver({
    rows: 3, cols: 3,
    task: [[2,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  // Clue at (0,0) corner. Neighborhood: (0,0), (0,1), (1,0), (1,1) = idxs 0, 1, 3, 4.
  assert.equal(s.clueNeighborhood[0].length, 4);
  assert.deepEqual(Array.from(s.clueNeighborhood[0]).sort((a,b)=>a-b), [0, 1, 3, 4]);
});

test('MosaicSolver._buildNeighborhoods: edge clue has 6 cells', () => {
  const s = new MosaicSolver({
    rows: 3, cols: 3,
    task: [[-1,4,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  // Clue at (0,1) top-edge. Neighborhood: (0,0), (0,1), (0,2), (1,0), (1,1), (1,2).
  assert.equal(s.clueNeighborhood[0].length, 6);
  assert.deepEqual(Array.from(s.clueNeighborhood[0]).sort((a,b)=>a-b), [0, 1, 2, 3, 4, 5]);
});
```

- [ ] **Step 2: Verify failure (`clueNeighborhood` undefined).**

- [ ] **Step 3: Implement — inside `MosaicSolver`:**

```js
_buildNeighborhoods() {
  this.clueNeighborhood = new Array(this.clues.length);
  for (let i = 0; i < this.clues.length; i++) {
    const idx = this.clues[i];
    const r0 = (idx / this.cols) | 0;
    const c0 = idx - r0 * this.cols;
    const cells = [];
    for (let dr = -1; dr <= 1; dr++) {
      const r = r0 + dr;
      if (r < 0 || r >= this.rows) continue;
      for (let dc = -1; dc <= 1; dc++) {
        const c = c0 + dc;
        if (c < 0 || c >= this.cols) continue;
        cells.push(r * this.cols + c);
      }
    }
    this.clueNeighborhood[i] = new Int32Array(cells);
  }
}
```

Call from constructor end (before `this._startedAt = 0`):

```js
this._buildNeighborhoods();
this._startedAt = 0;
```

- [ ] **Step 4: Verify 6 passing.**

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(mosaic): precompute per-clue 3×3 neighborhood cells"
```

---

## Task 3: Per-clue neighborhood-count propagation

**Files:** `solver.js` (add `_applyClues`), `tests/mosaic.test.js` (append).

- [ ] **Step 1: Failing tests — append:**

```js
test('MosaicSolver._applyClues: K=0 forces neighborhood to white', () => {
  const s = new MosaicSolver({
    rows: 3, cols: 3,
    task: [[0,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  assert.equal(s._applyClues(), true);
  // Neighborhood of (0,0): idxs 0, 1, 3, 4 all forced white.
  assert.equal(s.cellStatus[0], 2);
  assert.equal(s.cellStatus[1], 2);
  assert.equal(s.cellStatus[3], 2);
  assert.equal(s.cellStatus[4], 2);
});

test('MosaicSolver._applyClues: K=neighborhood-size forces all black', () => {
  // 3x3 interior clue K=9 forces all 9 cells black.
  const s = new MosaicSolver({
    rows: 3, cols: 3,
    task: [[-1,-1,-1],[-1,9,-1],[-1,-1,-1]],
  });
  assert.equal(s._applyClues(), true);
  for (let i = 0; i < 9; i++) assert.equal(s.cellStatus[i], 1);
});

test('MosaicSolver._applyClues: contradiction when K > neighborhood', () => {
  // Corner clue with K=5 in a 3x3 — neighborhood is 4 cells, max blacks = 4.
  const s = new MosaicSolver({
    rows: 3, cols: 3,
    task: [[5,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  assert.equal(s._applyClues(), false);
});

test('MosaicSolver._applyClues: contradiction when K < known blacks', () => {
  // K=0 but a black already in the neighborhood.
  const s = new MosaicSolver({
    rows: 3, cols: 3,
    task: [[0,-1,-1],[-1,-1,-1],[-1,-1,-1]],
    initialState: [[0, 1, 0], [0, 0, 0], [0, 0, 0]],
  });
  assert.equal(s._applyClues(), false);
});
```

- [ ] **Step 2: Verify failure (`_applyClues` undefined).**

- [ ] **Step 3: Implement:**

```js
_applyClues() {
  for (let i = 0; i < this.clues.length; i++) {
    const cells = this.clueNeighborhood[i];
    const K = this.clueValues[i];
    let nB = 0, nU = 0;
    for (let j = 0; j < cells.length; j++) {
      const v = this.cellStatus[cells[j]];
      if (v === 1) nB++;
      else if (v === 0) nU++;
    }
    if (nB > K) return false;
    if (nB + nU < K) return false;
    if (nB === K && nU > 0) {
      for (let j = 0; j < cells.length; j++) {
        if (this.cellStatus[cells[j]] === 0) {
          if (!this._set(cells[j], 2)) return false;
        }
      }
    } else if (nB + nU === K && nU > 0) {
      for (let j = 0; j < cells.length; j++) {
        if (this.cellStatus[cells[j]] === 0) {
          if (!this._set(cells[j], 1)) return false;
        }
      }
    }
  }
  return true;
}
```

- [ ] **Step 4: Verify 10 passing.**

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(mosaic): per-clue 3×3 neighborhood-count propagation"
```

---

## Task 4: Propagate orchestrator + lookahead

**Files:** `solver.js`, `tests/mosaic.test.js` (append).

- [ ] **Step 1: Failing test — append:**

```js
test('MosaicSolver._propagate: cascades through overlapping clues', () => {
  // Linear cascade: K=0 at (0,0) forces 4 whites, then a downstream clue can fire.
  const s = new MosaicSolver({
    rows: 2, cols: 3,
    task: [[0,-1,-1],[-1,-1,3]],
  });
  // K=0 at (0,0): cells (0,0),(0,1),(1,0),(1,1) all white.
  // K=3 at (1,2): neighborhood = (0,1),(0,2),(1,1),(1,2). (0,1) and (1,1) are white.
  // So need 3 blacks in 2 remaining unknowns — impossible. Should return false.
  assert.equal(s._propagate(), false);
});

test('MosaicSolver._propagate: returns true on consistent input', () => {
  const s = new MosaicSolver({
    rows: 3, cols: 3,
    task: [[-1,-1,-1],[-1,9,-1],[-1,-1,-1]],
  });
  assert.equal(s._propagate(), true);
});
```

- [ ] **Step 2: Verify failure.**

- [ ] **Step 3: Implement:**

```js
_propagate() {
  let changed = true;
  while (changed) {
    if (this._timeUp()) return true;
    changed = false;
    const mark = this.trail.length;
    if (!this._applyClues()) return false;
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

- [ ] **Step 4: Verify 12 passing.**

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(mosaic): _propagate orchestrator + top-level lookahead"
```

---

## Task 5: solve + backtracking + caches + computePuzzleDiff arm

**Files:** `solver.js`, `tests/mosaic.test.js` (append).

- [ ] **Step 1: Failing tests — append:**

```js
test('MosaicSolver.solve: solves recon 5x5', () => {
  MosaicSolver.clearSolutionCache();
  const s = new MosaicSolver({
    rows: 5, cols: 5,
    task: [
      [-1,4,-1,-1,1],
      [-1,-1,-1,-1,-1],
      [-1,-1,2,3,-1],
      [-1,3,-1,-1,2],
      [0,-1,4,-1,-1],
    ],
    maxMs: 5000,
  });
  const r = s.solve();
  assert.equal(r.solved, true);
  // Every cell determined.
  for (const row of r.grid) for (const v of row) assert.notEqual(v, 0);
});

test('MosaicSolver.solve: unsat returns {solved:false, grid:null}', () => {
  MosaicSolver.clearSolutionCache();
  const s = new MosaicSolver({
    rows: 3, cols: 3,
    task: [[5,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  const r = s.solve();
  assert.equal(r.solved, false);
  assert.equal(r.grid, null);
});

test('MosaicSolver._solutionCache: cache hit returns deep copy', () => {
  MosaicSolver.clearSolutionCache();
  const opts = { rows: 3, cols: 3, task: [[-1,-1,-1],[-1,9,-1],[-1,-1,-1]] };
  const a = new MosaicSolver(opts).solve();
  a.grid[0][0] = 99;
  const b = new MosaicSolver(opts).solve();
  assert.notEqual(b.grid[0][0], 99);
});

test('computePuzzleDiff mosaic: flags wrong-color cells, ignores unknown', () => {
  const { computePuzzleDiff } = require('../solver.js');
  const solution = [[1, 2], [2, 1]];
  const board = [[2, 2], [0, 1]];
  const diff = computePuzzleDiff('mosaic', board, solution);
  assert.equal(diff.length, 1);
  assert.deepEqual(diff[0], { row: 0, col: 0, expected: 1, actual: 2 });
});
```

- [ ] **Step 2: Verify failure.**

- [ ] **Step 3: Implement — inside `MosaicSolver`:**

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
    for (let c = 0; c < this.cols; c++) row[c] = this.cellStatus[r * this.cols + c];
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
    let adj = 0;
    if (r > 0 && this.cellStatus[i - this.cols] !== 0) adj++;
    if (r < this.rows - 1 && this.cellStatus[i + this.cols] !== 0) adj++;
    if (c > 0 && this.cellStatus[i - 1] !== 0) adj++;
    if (c < this.cols - 1 && this.cellStatus[i + 1] !== 0) adj++;
    if (adj > bestScore) { bestScore = adj; bestIdx = i; }
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
  const cached = MosaicSolver._solutionCache.get(key)
              || MosaicSolver._partialCache.get(key);
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

Then add static fields + helpers at the BOTTOM of `MosaicSolver`:

```js
static _solutionCache = new Map();
static _maxSolutionCache = 50;
static _partialCache = new Map();
static _maxPartialCache = 20;
static clearSolutionCache() {
  MosaicSolver._solutionCache.clear();
  MosaicSolver._partialCache.clear();
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
  const m = result.partial ? MosaicSolver._partialCache : MosaicSolver._solutionCache;
  const max = result.partial ? MosaicSolver._maxPartialCache : MosaicSolver._maxSolutionCache;
  if (m.size >= max) {
    const first = m.keys().next().value;
    m.delete(first);
  }
  m.set(key, this._cloneResult(result));
}
```

Extend `computePuzzleDiff` — find the existing `if (type === 'heyawake' || type === 'hitori' || type === 'kakurasu' || type === 'kurodoko')` arm, add `|| type === 'mosaic'`.

- [ ] **Step 4: Verify 16 passing.**

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(mosaic): solve() with backtracking + caches + computePuzzleDiff arm"
```

---

## Task 6: Stepwise getHint

**Files:** `solver.js`, `tests/mosaic.test.js` (append).

- [ ] **Step 1: Failing tests — append:**

```js
test('MosaicSolver.getHint: K=0 yields immediate whites', () => {
  MosaicSolver.clearSolutionCache();
  const s = new MosaicSolver({
    rows: 3, cols: 3,
    task: [[0,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  const hint = s.getHint([[0,0,0],[0,0,0],[0,0,0]]);
  assert.ok(Array.isArray(hint));
  assert.ok(hint.length >= 1);
  // Cells (0,0), (0,1), (1,0), (1,1) must be forced white.
  for (const [r, c] of [[0,0],[0,1],[1,0],[1,1]]) {
    const h = hint.find(x => x.row === r && x.col === c);
    assert.ok(h && h.value === 2);
  }
});

test('MosaicSolver.getHint: null on solved board', () => {
  MosaicSolver.clearSolutionCache();
  const s = new MosaicSolver({
    rows: 3, cols: 3,
    task: [[0,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  // All cells either white (K=0 forces) or anything consistent for non-clue.
  const solved = [[2,2,2],[2,2,2],[2,2,2]];
  assert.equal(s.getHint(solved), null);
});
```

- [ ] **Step 2: Verify failure.**

- [ ] **Step 3: Implement:**

```js
getHint(initialState) {
  const total = this.rows * this.cols;
  for (let r = 0; r < this.rows; r++) {
    for (let c = 0; c < this.cols; c++) {
      this.cellStatus[r * this.cols + c] = initialState[r][c];
    }
  }
  const before = new Uint8Array(total);
  for (let i = 0; i < total; i++) before[i] = this.cellStatus[i];
  this.trail = [];
  this._depth = 0;
  this._inLookahead = false;
  this._startedAt = Date.now();

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

  // Per-clue scan, stop at first that yields a change.
  for (let i = 0; i < this.clues.length; i++) {
    const cells = this.clueNeighborhood[i];
    const K = this.clueValues[i];
    let nB = 0, nU = 0;
    for (let j = 0; j < cells.length; j++) {
      const v = this.cellStatus[cells[j]];
      if (v === 1) nB++;
      else if (v === 0) nU++;
    }
    if (nB > K) return null;
    if (nB + nU < K) return null;
    let changed = false;
    if (nB === K && nU > 0) {
      for (let j = 0; j < cells.length; j++) {
        if (this.cellStatus[cells[j]] === 0) {
          if (!this._set(cells[j], 2)) return null;
          changed = true;
        }
      }
    } else if (nB + nU === K && nU > 0) {
      for (let j = 0; j < cells.length; j++) {
        if (this.cellStatus[cells[j]] === 0) {
          if (!this._set(cells[j], 1)) return null;
          changed = true;
        }
      }
    }
    if (changed) {
      const h = collectChanged();
      if (h.length) return h;
    }
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

- [ ] **Step 4: Verify 18 passing.**

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(mosaic): stepwise getHint"
```

---

## Task 7: Fuzz soundness test

**Files:** Create `tests/mosaic-fuzz.test.js`.

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MosaicSolver } = require('../solver.js');

function generatePuzzle(rows, cols, seed) {
  let rng = seed >>> 0;
  const rand = () => {
    rng = (rng * 1103515245 + 12345) >>> 0;
    return rng / 0x100000000;
  };
  const shade = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (rand() < 0.5) shade[r][c] = 1;
  }
  // Pick clue cells (~50% of cells) and derive K from 3×3 neighborhood.
  const task = Array.from({ length: rows }, () => new Array(cols).fill(-1));
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (rand() < 0.5) {
      let k = 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
        if (shade[rr][cc] === 1) k++;
      }
      task[r][c] = k;
    }
  }
  return { task };
}

function validate(rows, cols, task, grid) {
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (task[r][c] === -1) continue;
    const K = task[r][c];
    let k = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
      if (grid[rr][cc] === 1) k++;
    }
    if (k !== K) return `clue (${r},${c})=${K} got ${k} blacks`;
  }
  return null;
}

test('MosaicSolver fuzz: solved boards satisfy every clue', () => {
  MosaicSolver.clearSolutionCache();
  let solved = 0;
  for (let seed = 1; seed <= 30; seed++) {
    MosaicSolver.clearSolutionCache();
    const rows = 4 + (seed % 3);
    const cols = 4 + ((seed >> 2) % 3);
    const { task } = generatePuzzle(rows, cols, seed * 9173 + 1);
    const s = new MosaicSolver({ rows, cols, task, maxMs: 3000 });
    const r = s.solve();
    if (!r.solved) continue;
    const err = validate(rows, cols, task, r.grid);
    assert.equal(err, null, `seed=${seed} ${rows}x${cols}: ${err}`);
    solved++;
  }
  assert.ok(solved >= 10, `expected ≥ 10 solved boards, got ${solved}`);
});
```

- [ ] **Step 1: Run, expect PASS. Commit:**

```bash
jj commit -m "test(mosaic): fuzz suite for clue-satisfaction soundness"
```

---

## Task 8: Fixtures + golden + integration

**Files:** `tests/fixtures/puzzles.js`, `tests/golden.js`, `tests/solver.test.js`.

- [ ] **Step 1: Fixture in puzzles.js:**

```js
exports.mosaic5x5Easy = {
  type: 'mosaic',
  rows: 5,
  cols: 5,
  task: [
    [-1,4,-1,-1,1],
    [-1,-1,-1,-1,-1],
    [-1,-1,2,3,-1],
    [-1,3,-1,-1,2],
    [0,-1,4,-1,-1],
  ],
};
```

- [ ] **Step 2: Capture golden — run from repo root:**

```bash
node -e "
const { MosaicSolver } = require('./solver.js');
const f = require('./tests/fixtures/puzzles.js').mosaic5x5Easy;
const s = new MosaicSolver({ rows: f.rows, cols: f.cols, task: f.task });
const r = s.solve();
if (!r.solved) { console.error('NO SOLUTION'); process.exit(1); }
console.log(JSON.stringify(r.grid));
"
```

Paste into `tests/golden.js`:

```js
exports.mosaic5x5Easy = <pasted-2D-array>;
```

- [ ] **Step 3: Integration test in `tests/solver.test.js`** (ensure `MosaicSolver` is imported):

```js
test('MosaicSolver: mosaic5x5Easy fixture matches golden', () => {
  const { MosaicSolver } = require('../solver.js');
  const fixture = require('./fixtures/puzzles.js').mosaic5x5Easy;
  MosaicSolver.clearSolutionCache();
  const s = new MosaicSolver({
    rows: fixture.rows,
    cols: fixture.cols,
    task: fixture.task,
  });
  const r = s.solve();
  assert.equal(r.solved, true);
  assert.deepEqual(r.grid, require('./golden.js').mosaic5x5Easy);
});
```

- [ ] **Step 4: `npm test` — expect clean. Commit:**

```bash
jj commit -m "test(mosaic): puzzles.js fixture + golden snapshot + integration test"
```

---

## Task 9: MAIN-world fns + allowlist + globals.d.ts + eslint

**Files:** `main-world.js`, `background.js`, `globals.d.ts`, `eslint.config.js`.

- [ ] **Step 1: `readMosaicData` in main-world.js:**

```js
function readMosaicData() {
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

- [ ] **Step 2: `readMosaicState`:**

```js
function readMosaicState(rows, cols) {
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

- [ ] **Step 3: `applyMosaicState` — writes every cell, no skip (clue cells participate in cellStatus normally):**

```js
function applyMosaicState(grid) {
  try {
    var G = window.Game;
    if (!G || !G.currentState || !G.currentState.cellStatus) return false;
    if (typeof G.saveState === 'function') G.saveState(true);
    var cs = G.currentState.cellStatus;
    for (var r = 0; r < grid.length; r++) {
      if (!cs[r]) cs[r] = [];
      for (var c = 0; c < grid[r].length; c++) {
        cs[r][c] = grid[r][c];
      }
    }
    if (typeof G.drawCurrentState === 'function') G.drawCurrentState();
    if (typeof G.render === 'function') G.render();
    if (typeof G.redraw === 'function') G.redraw();
    return true;
  } catch (e) {
    console.warn('Mosaic apply failed:', e);
    return false;
  }
}
```

- [ ] **Step 4: background.js EXEC_MAIN_ALLOWLIST — add 3 entries.**
- [ ] **Step 5: globals.d.ts — add 3 to MainWorldFn + `declare const MosaicSolver: any;`.**
- [ ] **Step 6: eslint.config.js — add `MosaicSolver` to solverClasses.**
- [ ] **Step 7: Verify `npm run lint && npm run typecheck && npm test`.**
- [ ] **Step 8: Commit:**

```bash
jj commit -m "feat(mosaic): MAIN-world read/apply fns + allowlist + globals.d.ts"
```

---

## Task 10: Worker arm + handler

**Files:** `solver.worker.js`, `handler.js`.

- [ ] **Step 1: Worker arm** — add `MosaicSolver` to `/* global */`, then arm before final `else`:

```js
} else if (type === 'mosaic' && extraData) {
  const s = new MosaicSolver({
    rows: extraData.rows,
    cols: extraData.cols,
    task: extraData.task,
    initialState: initialGrid || null,
    maxMs: 30000,
  });
  result = s.solve();
}
```

- [ ] **Step 2: Handler — after kurodokoHandler:**

```js
const mosaicHandler = {
  name: 'puzzles-mobile-mosaic',
  priority: 30,
  matches() {
    return isPuzzlesMobilePage() && window.location.pathname.includes('/mosaic/');
  },
  async detect() {
    const result = { found: false, rows: 0, cols: 0, rowClues: [], colClues: [] };
    const data = await callMainWorld('readMosaicData', []);
    if (!data) return { ...result, error: 'No Mosaic task data found' };
    const stageEl = document.getElementById('stage') ||
                    document.getElementById('game') ||
                    document.querySelector('[class*="game"], [class*="puzzle"]');
    return {
      found: true,
      type: 'mosaic',
      rows: data.rows,
      cols: data.cols,
      task: data.task,
      rowClues: [], colClues: [],
      _cells: [],
      _element: stageEl,
    };
  },
  async readState(ctx) {
    const state = await callMainWorld('readMosaicState', [ctx.rows, ctx.cols]);
    if (state) return state;
    return Array.from({ length: ctx.rows }, () => new Array(ctx.cols).fill(0));
  },
  async applySolution(solution, _ctx) {
    const ok = await callMainWorld('applyMosaicState', [solution]);
    return ok ? { success: true } : { success: false, error: 'Mosaic apply failed' };
  },
};

registerHandler(mosaicHandler);
```

- [ ] **Step 3: Verify + Commit:**

```bash
jj commit -m "feat(mosaic): worker dispatch arm + handler registration"
```

---

## Task 11: Dump + real fixture + bench-real

**Files:** `main-world.js`, `tests/fixtures/real-puzzles.js`, `tests/bench-real.js`.

- [ ] **Step 1: Inline dump arm:**

```js
if (path.indexOf('/mosaic/') !== -1 || g.slug === 'mosaic') {
  if (!g.task || !g.puzzleWidth || !g.puzzleHeight) {
    return { error: 'mosaic: missing task/dims', diagnostic: diagnostic(g), path: path };
  }
  var mcRows = g.puzzleHeight, mcCols = g.puzzleWidth;
  var mcTask = [];
  for (var mcr = 0; mcr < mcRows; mcr++) {
    var srcRow = g.task[mcr] || [];
    var dstRow = new Array(mcCols);
    for (var mcc = 0; mcc < mcCols; mcc++) {
      var v = srcRow[mcc];
      dstRow[mcc] = (typeof v === 'number') ? v : -1;
    }
    mcTask.push(dstRow);
  }
  return { type: 'mosaic', rows: mcRows, cols: mcCols, task: mcTask, path: path };
}
```

- [ ] **Step 2: Real fixture in real-puzzles.js:**

```js
exports.mosaic5x5EasyReal = {
  type: 'mosaic',
  rows: 5,
  cols: 5,
  task: [
    [-1,4,-1,-1,1],
    [-1,-1,-1,-1,-1],
    [-1,-1,2,3,-1],
    [-1,3,-1,-1,2],
    [0,-1,4,-1,-1],
  ],
};
```

- [ ] **Step 3: bench-real.js — mirror kurodoko arm.**

- [ ] **Step 4: Verify `node tests/bench-real.js`. Commit:**

```bash
jj commit -m "feat(mosaic): dumpPuzzleForBench arm + real fixture + bench-real arm"
```

---

## Task 12: bench-mosaic.js + CI step

**Files:** Create `tests/bench-mosaic.js`, modify `.github/workflows/bench-nightly.yml`.

- [ ] **Step 1:**

```js
'use strict';
const { MosaicSolver } = require('../solver.js');
const fixture = require('./fixtures/real-puzzles.js').mosaic5x5EasyReal;

const ITERATIONS = 5;
const WARMUP = 2;
const times = [];
for (let i = 0; i < WARMUP + ITERATIONS; i++) {
  MosaicSolver.clearSolutionCache();
  const s = new MosaicSolver({
    rows: fixture.rows,
    cols: fixture.cols,
    task: fixture.task,
  });
  const t0 = process.hrtime.bigint();
  const r = s.solve();
  const t1 = process.hrtime.bigint();
  if (!r.solved) { console.error('mosaic5x5EasyReal failed to solve'); process.exit(1); }
  if (i >= WARMUP) times.push(Number(t1 - t0) / 1e6);
}
times.sort((a, b) => a - b);
console.log(`mosaic5x5EasyReal: median ${times[Math.floor(times.length / 2)].toFixed(2)} ms over ${ITERATIONS} runs`);
```

- [ ] **Step 2: CI step:**

```yaml
      - name: Bench Mosaic
        run: node tests/bench-mosaic.js
```

- [ ] **Step 3: Commit:**

```bash
jj commit -m "ci(mosaic): bench script + nightly workflow step"
```

---

## Task 13: content.js bookkeeping

**Files:** `content.js`.

- [ ] **Step 1: SUPPORTED_PUZZLES** — insert between Kurodoko and Nonogram:

```js
  { name: 'Mosaic',       url: 'https://www.puzzles-mobile.com/mosaic/' },
```

- [ ] **Step 2: SOLUTION_KEY_PREFIXES** — add `'mosaic-solution:'`.

- [ ] **Step 3: mosaicCacheKey — after kurodokoCacheKey:**

```js
function mosaicCacheKey(data) {
  if (data?.type !== 'mosaic' || !data.task) return null;
  let h = 0x811c9dc5;
  const mix = (n) => { h ^= n & 0xff; h = Math.imul(h, 0x01000193) >>> 0; };
  mix(0x4D); // 'M' nameplate
  mix(data.rows); mix(data.cols);
  for (const row of data.task) for (const v of row) mix(v + 1);
  return 'mosaic-solution:' + (h >>> 0).toString(16);
}
```

Wire alongside kurodokoCacheKey at both ternary dispatch sites.

- [ ] **Step 4: solveExtraData arm:**

```js
if (data.type === 'mosaic') {
  return { rows: data.rows, cols: data.cols, task: data.task };
}
```

- [ ] **Step 5: mosaicTaskSig + staticSig segment — after kurodokoTaskSig:**

```js
function mosaicTaskSig(task) {
  if (!task) return '0';
  let h = 0x811c9dc5;
  for (const row of task) for (const v of row) {
    h ^= (v + 1) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16);
}
```

In `staticSig`, append `'|mc=' + mosaicTaskSig(pd?.type === 'mosaic' ? pd.task : null)`.

- [ ] **Step 6: pendingAutoSolve gate** — extend `skipAutoSolveGate` to include mosaic.

- [ ] **Step 7: drawPreview rect-bail** — add `|| pd?.type === 'mosaic'`.

- [ ] **Step 8: Verify, commit:**

```bash
jj commit -m "feat(mosaic): content.js bookkeeping (SUPPORTED_PUZZLES, prefix, cache key, sig, gate)"
```

---

## Task 14: content.js drawPreview arm

**Files:** `content.js`.

Renders the grid with clue digits at clue cells (text color depends on cellStatus), shaded fills for cellStatus=1, X marks for cellStatus=2.

- [ ] **Step 1: Read the kurodoko drawPreview arm for reference.**

- [ ] **Step 2: Add `isMosaic` flag near other type flags:**

```js
const isMosaic = puzzleData?.type === 'mosaic';
```

Update the skip-empty-cells guard to include mosaic:

```js
if (v === 0 && !isShikaku && !isHitori && !isKakurasu && !isKurodoko && !isMosaic) continue;
```

- [ ] **Step 3: Per-cell render arm for mosaic** — note that clue cells can ALSO be black/white; render the digit overlaid on the shaded/cross fill:

```js
} else if (isMosaic) {
  const v = grid[r][c];
  const taskVal = (pd.task && pd.task[r] && typeof pd.task[r][c] === 'number') ? pd.task[r][c] : -1;
  // Background fill based on cellStatus.
  if (v === 1) {
    ctx.fillStyle = '#1f2937';
    ctx.fillRect(x, y, cellSize, cellSize);
  } else if (v === 2) {
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
  // Clue digit overlay (light on dark fill, dark otherwise).
  if (taskVal !== -1) {
    ctx.font = `bold ${Math.floor(cellSize * 0.5)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = (v === 1) ? '#f3f4f6' : '#1f2937';
    ctx.fillText(String(taskVal), x + cellSize / 2, y + cellSize / 2);
  }
}
```

- [ ] **Step 4: Hint overlay arm** — adjacent to kurodoko's:

```js
} else if (puzzleData?.type === 'mosaic' && (cell.value === 1 || cell.value === 2)) {
  ctx.strokeStyle = cell.value === 1 ? '#3b82f6' : '#60a5fa';
  ctx.lineWidth = Math.max(2, Math.floor(cellSize / 9));
  ctx.strokeRect(cx + 2, cy + 2, cellSize - 4, cellSize - 4);
}
```

Add a band-skip arm `else if (puzzleData?.type === 'mosaic')` no-op alongside kurodoko's.

- [ ] **Step 5: Static layer in `buildStaticLayer`** — mosaic arm draws outer border + light grid lines (clone hitori's static-layer code).

- [ ] **Step 6: Loop early-break exclusion** — extend to include mosaic.

- [ ] **Step 7: Verify, commit:**

```bash
jj commit -m "feat(mosaic): drawPreview arm with clue digit + shaded fills + cross marks"
```

---

## Task 15: content.js getHint + hintStatusNodes + partial arm

**Files:** `content.js`.

- [ ] **Step 1: getHint dispatch** — after kurodoko arm:

```js
} else if (detectedGrid.type === 'mosaic') {
  if (solution && firstMismatch(grid, solution)) {
    return { success: false, error: 'Current game state is wrong.' };
  }
  const solver = new MosaicSolver({
    rows, cols, task: detectedGrid.task,
  });
  const hintCells = solver.getHint(grid);
  if (!hintCells || hintCells.length === 0) {
    return { success: false, error: 'No more cells can be deduced from the current state. Click Solve to finish.' };
  }
  hint = { type: 'mosaic', extraCells: hintCells, count: hintCells.length };
}
```

- [ ] **Step 2: mosaicHintStatusNodes + setHintStatus arm:**

```js
function mosaicHintStatusNodes(h) {
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
} else if (puzzleData?.type === 'mosaic') {
  setStatusNodes('info', prefix, ...mosaicHintStatusNodes(h));
}
```

- [ ] **Step 3: solveHandler partial arm:**

```js
if (result?.partial && puzzleData?.type === 'mosaic' && Array.isArray(result.grid)) {
  applyGridPartialResult(result);
  return;
}
```

- [ ] **Step 4: Verify, commit:**

```bash
jj commit -m "feat(mosaic): content.js getHint dispatch + hintStatusNodes + partial arm"
```

---

## Task 16: Final verification + push

- [ ] **Step 1: Full suite, lint, typecheck, build.**
- [ ] **Step 2: Bench.**
- [ ] **Step 3: Push** — `jj bookmark set main -r @-` then `jj git push --bookmark main`.

End of plan.
