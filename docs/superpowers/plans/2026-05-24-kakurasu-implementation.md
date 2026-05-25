# Kakurasu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full Kakurasu support (`/kakurasu/*`) to the Chrome MV3 extension. 11th puzzle type. Different rule family from prior 10: subset-sum-per-line with edge clues. No adjacency, no connectivity.

**Architecture:** `KakurasuSolver` — `Uint8Array` cellStatus (0/1/2), per-row + per-col bitmask domains precomputed via subset-sum DP, propagation by mask narrowing + intersection/union forcing. Two-tier trail (`cellTrail` + `maskTrail`) for rollback. Top-level 1-step lookahead. Most-constrained backtracking. Partial-on-timeout cache. Cell encoding matches Hitori (1=filled, 2=cross), so hint apply reuses generic `applyHintCells`.

**Tech Stack:** Vanilla JS (MV3), `node:test`, `jj` for commits.

**Reference spec:** `docs/superpowers/specs/2026-05-24-kakurasu-design.md`
**Closest existing solver:** Nonogram for per-line propagation shape, Hitori for cell-state encoding and integration boilerplate.

Run a single test file with `node --test tests/kakurasu.test.js`. Full suite: `npm test`.

**`jj` for commits** — every commit step uses `jj commit -m "..."` (never plain `git`).

---

## Task 1: KakurasuSolver scaffold (constructor + _set + _rollback)

**Files:**
- Modify: `solver.js` (append a new class after `HitoriSolver`, before `module.exports`)
- Test: `tests/kakurasu.test.js` (new)

No adjacency rule, so `_set` is simpler than Heyawake/Hitori — just trail-push + write.

- [ ] **Step 1: Create the failing test**

Create `tests/kakurasu.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { KakurasuSolver } = require('../solver.js');

test('KakurasuSolver: constructor mirrors clues and initialState', () => {
  const s = new KakurasuSolver({
    rows: 4, cols: 4,
    rowClues: [2, 7, 9, 6],
    colClues: [4, 8, 9, 5],
    initialState: [[0,0,0,0],[0,0,0,0],[0,0,1,0],[0,0,0,0]],
  });
  assert.equal(s.rows, 4);
  assert.equal(s.cols, 4);
  assert.equal(s.cellStatus[10], 1); // (2,2) flat = 2*4+2 = 10
  assert.equal(s.rowClues[1], 7);
  assert.equal(s.colClues[2], 9);
});

test('KakurasuSolver: _set / _rollback round-trip', () => {
  const s = new KakurasuSolver({
    rows: 2, cols: 2,
    rowClues: [1, 2], colClues: [1, 2],
  });
  const cm = s.cellTrail.length;
  assert.equal(s._set(0, 1), true);
  assert.equal(s.cellStatus[0], 1);
  // No-op on same
  assert.equal(s._set(0, 1), true);
  assert.equal(s.cellTrail.length, cm + 1);
  // Conflict
  assert.equal(s._set(0, 2), false);
  s._rollback(cm, 0);
  assert.equal(s.cellStatus[0], 0);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `node --test tests/kakurasu.test.js`
Expected: `KakurasuSolver is not defined`.

- [ ] **Step 3: Add KakurasuSolver scaffold to solver.js**

Find `module.exports = { ..., HitoriSolver, computePuzzleDiff };`. Insert BEFORE that line (after `HitoriSolver`'s closing `}`):

```js
class KakurasuSolver {
  constructor(data) {
    const { rows, cols, rowClues, colClues, initialState, maxMs } = data;
    this.rows = rows;
    this.cols = cols;
    this.rowClues = new Int32Array(rows);
    for (let r = 0; r < rows; r++) this.rowClues[r] = rowClues[r];
    this.colClues = new Int32Array(cols);
    for (let c = 0; c < cols; c++) this.colClues[c] = colClues[c];
    this.cellStatus = new Uint8Array(rows * cols);
    if (initialState) {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          this.cellStatus[r * cols + c] = initialState[r][c];
        }
      }
    }
    this.cellTrail = [];
    this.maskTrail = [];
    this._depth = 0;
    this._inLookahead = false;
    this.maxMs = maxMs || 0;
    this._startedAt = 0;
  }

  _set(idx, value) {
    const old = this.cellStatus[idx];
    if (old === value) return true;
    if (old !== 0) return false;
    this.cellTrail.push(idx | (old << 24));
    this.cellStatus[idx] = value;
    return true;
  }

  _rollback(cellMark, maskMark) {
    while (this.cellTrail.length > cellMark) {
      const e = this.cellTrail.pop();
      const i = e & 0xffffff;
      const old = (e >>> 24) & 0xff;
      this.cellStatus[i] = old;
    }
    while (this.maskTrail.length > maskMark) {
      const { axis, lineIdx, mask } = this.maskTrail.pop();
      if (axis === 0) this.rowMasksActive[lineIdx].push(mask);
      else this.colMasksActive[lineIdx].push(mask);
    }
  }

  _timeUp() {
    if (this.maxMs <= 0) return false;
    return (Date.now() - this._startedAt) > this.maxMs;
  }
}
```

Then update `module.exports`:

```js
module.exports = { NonogramSolver, AquariumSolver, GalaxiesSolver, BinairoSolver, ShikakuSolver, YinYangSolver, SlitherlinkSolver, HashiSolver, HeyawakeSolver, HitoriSolver, KakurasuSolver, computePuzzleDiff };
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test tests/kakurasu.test.js`
Expected: 2 tests passing.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(kakurasu): KakurasuSolver scaffold with two-tier trail (cellTrail + maskTrail)"
```

---

## Task 2: Build per-line bitmask domains (subset-sum precompute)

**Files:**
- Modify: `solver.js` (add `_buildMaskDomains` + call from constructor)
- Test: `tests/kakurasu.test.js` (append)

For each row r: enumerate every bitmask `m` over `{0..cols-1}` where `Σ_c (c+1) for bits c set === rowClues[r]`. Same per column with row-index weights. Naive enumeration is fine (2^16 = 65536 max per line; real boards are ≤ 10 cols).

- [ ] **Step 1: Failing tests — append:**

```js
test('KakurasuSolver._buildMaskDomains: row mask 1×3 clue=4', () => {
  // 1×3 row, weights 1,2,3, target=4: subsets summing to 4: {1,3} → mask 0b101.
  const s = new KakurasuSolver({
    rows: 1, cols: 3,
    rowClues: [4],
    colClues: [1, 0, 0], // col 0 of weight 1 hit by row 0 (weight 1) when filled
  });
  assert.deepEqual(Array.from(s.rowMasksActive[0]).sort(), [0b101]);
});

test('KakurasuSolver._buildMaskDomains: row clue=0 → only empty mask', () => {
  const s = new KakurasuSolver({
    rows: 1, cols: 3,
    rowClues: [0],
    colClues: [0, 0, 0],
  });
  assert.deepEqual(Array.from(s.rowMasksActive[0]), [0]);
});

test('KakurasuSolver._buildMaskDomains: clue exceeds max sum → no masks', () => {
  // 1×3 max sum = 1+2+3 = 6. Clue 100 → impossible.
  const s = new KakurasuSolver({
    rows: 1, cols: 3,
    rowClues: [100],
    colClues: [0, 0, 0],
  });
  assert.equal(s.rowMasksActive[0].length, 0);
});

test('KakurasuSolver._buildMaskDomains: 4×4 recon row 0 clue=2 → only col 1 filled', () => {
  const s = new KakurasuSolver({
    rows: 4, cols: 4,
    rowClues: [2, 7, 9, 6],
    colClues: [4, 8, 9, 5],
  });
  // Row 0: cols 1..4 weighted 1,2,3,4. Sum to 2: {2} → bit 1 → mask 0b0010.
  assert.deepEqual(Array.from(s.rowMasksActive[0]).sort(), [0b0010]);
});
```

- [ ] **Step 2: Run, verify failure**

Expected: `rowMasksActive is undefined`.

- [ ] **Step 3: Implement — inside `KakurasuSolver`:**

```js
_buildMaskDomains() {
  // For each row r: enumerate masks over {0..cols-1} summing to rowClues[r].
  this.rowMasksActive = new Array(this.rows);
  for (let r = 0; r < this.rows; r++) {
    const target = this.rowClues[r];
    const masks = [];
    const limit = 1 << this.cols;
    for (let m = 0; m < limit; m++) {
      let sum = 0;
      for (let c = 0; c < this.cols; c++) {
        if (m & (1 << c)) sum += (c + 1);
      }
      if (sum === target) masks.push(m);
    }
    this.rowMasksActive[r] = masks;
  }
  // For each col c: enumerate masks over {0..rows-1}.
  this.colMasksActive = new Array(this.cols);
  for (let c = 0; c < this.cols; c++) {
    const target = this.colClues[c];
    const masks = [];
    const limit = 1 << this.rows;
    for (let m = 0; m < limit; m++) {
      let sum = 0;
      for (let r = 0; r < this.rows; r++) {
        if (m & (1 << r)) sum += (r + 1);
      }
      if (sum === target) masks.push(m);
    }
    this.colMasksActive[c] = masks;
  }
}
```

Call from constructor end (before `this._startedAt = 0`):

```js
this._buildMaskDomains();
this._startedAt = 0;
```

- [ ] **Step 4: Verify 6 passing.**

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(kakurasu): precompute per-line bitmask domains via subset-sum enumeration"
```

---

## Task 3: Mask narrowing + per-line forcing

**Files:**
- Modify: `solver.js` (add `_narrowAndForceLine`, `_applyLines`)
- Test: `tests/kakurasu.test.js` (append)

For each row/col: filter masks against known cells; if active masks empty → contradiction; intersection of remaining masks gives forced-filled bits; complement of union gives forced-cross bits.

- [ ] **Step 1: Failing tests — append:**

```js
test('KakurasuSolver._applyLines: single-mask row forces every cell', () => {
  // Row 0: clue=2 → unique mask 0b0010. Forces col 1 filled, cols 0,2,3 cross.
  const s = new KakurasuSolver({
    rows: 1, cols: 4,
    rowClues: [2],
    colClues: [0, 1, 0, 0],
  });
  assert.equal(s._applyLines(), true);
  assert.equal(s.cellStatus[0], 2);  // (0,0) cross
  assert.equal(s.cellStatus[1], 1);  // (0,1) filled
  assert.equal(s.cellStatus[2], 2);  // (0,2) cross
  assert.equal(s.cellStatus[3], 2);  // (0,3) cross
});

test('KakurasuSolver._applyLines: empty row mask list → contradiction', () => {
  const s = new KakurasuSolver({
    rows: 1, cols: 3,
    rowClues: [100],
    colClues: [0, 0, 0],
  });
  assert.equal(s._applyLines(), false);
});

test('KakurasuSolver._applyLines: mask narrowing under known cell', () => {
  // Row 0: cols 0,1,2 (weights 1,2,3) clue=3. Subsets summing to 3: {3} → 0b100,
  // or {1,2} → 0b011. Two masks. If we know (0,2) is cross (mask 0b100 invalid),
  // only 0b011 remains → cells 0 and 1 forced filled.
  const s = new KakurasuSolver({
    rows: 1, cols: 3,
    rowClues: [3],
    colClues: [1, 2, 0],
    initialState: [[0, 0, 2]],
  });
  assert.equal(s._applyLines(), true);
  assert.equal(s.cellStatus[0], 1);
  assert.equal(s.cellStatus[1], 1);
});
```

- [ ] **Step 2: Verify failure.**

- [ ] **Step 3: Implement — inside `KakurasuSolver`:**

```js
_narrowLine(axis, lineIdx, active) {
  // Returns a new (filtered) array of masks consistent with current cells.
  // axis 0 = row, axis 1 = col. Drops are recorded into maskTrail so
  // backtrack can restore.
  const kept = [];
  for (let i = 0; i < active.length; i++) {
    const m = active[i];
    let ok = true;
    if (axis === 0) {
      const r = lineIdx;
      for (let c = 0; c < this.cols; c++) {
        const cs = this.cellStatus[r * this.cols + c];
        const bit = (m >> c) & 1;
        if (cs === 1 && !bit) { ok = false; break; }
        if (cs === 2 && bit)  { ok = false; break; }
      }
    } else {
      const c = lineIdx;
      for (let r = 0; r < this.rows; r++) {
        const cs = this.cellStatus[r * this.cols + c];
        const bit = (m >> r) & 1;
        if (cs === 1 && !bit) { ok = false; break; }
        if (cs === 2 && bit)  { ok = false; break; }
      }
    }
    if (ok) kept.push(m);
    else this.maskTrail.push({ axis, lineIdx, mask: m });
  }
  return kept;
}

_applyLines() {
  // Single pass over rows then columns. Filter masks; if any line empties
  // out → contradiction. Force intersection/union deductions.
  for (let r = 0; r < this.rows; r++) {
    const active = this._narrowLine(0, r, this.rowMasksActive[r]);
    this.rowMasksActive[r] = active;
    if (active.length === 0) return false;
    let inter = active[0], union = active[0];
    for (let i = 1; i < active.length; i++) {
      inter &= active[i];
      union |= active[i];
    }
    for (let c = 0; c < this.cols; c++) {
      const bitMask = 1 << c;
      const idx = r * this.cols + c;
      if ((inter & bitMask) && this.cellStatus[idx] === 0) {
        if (!this._set(idx, 1)) return false;
      } else if (!(union & bitMask) && this.cellStatus[idx] === 0) {
        if (!this._set(idx, 2)) return false;
      }
    }
  }
  for (let c = 0; c < this.cols; c++) {
    const active = this._narrowLine(1, c, this.colMasksActive[c]);
    this.colMasksActive[c] = active;
    if (active.length === 0) return false;
    let inter = active[0], union = active[0];
    for (let i = 1; i < active.length; i++) {
      inter &= active[i];
      union |= active[i];
    }
    for (let r = 0; r < this.rows; r++) {
      const bitMask = 1 << r;
      const idx = r * this.cols + c;
      if ((inter & bitMask) && this.cellStatus[idx] === 0) {
        if (!this._set(idx, 1)) return false;
      } else if (!(union & bitMask) && this.cellStatus[idx] === 0) {
        if (!this._set(idx, 2)) return false;
      }
    }
  }
  return true;
}
```

- [ ] **Step 4: Verify 9 passing.**

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(kakurasu): mask narrowing + per-line intersection/union forcing"
```

---

## Task 4: Propagate orchestrator + lookahead

**Files:**
- Modify: `solver.js` (add `_propagate`, `_applyLookahead`)
- Test: `tests/kakurasu.test.js` (append)

- [ ] **Step 1: Failing tests — append:**

```js
test('KakurasuSolver._propagate: solves recon 4x4 by propagation alone', () => {
  const s = new KakurasuSolver({
    rows: 4, cols: 4,
    rowClues: [2, 7, 9, 6],
    colClues: [4, 8, 9, 5],
  });
  assert.equal(s._propagate(), true);
  // Verify solution matches the hand-derived:
  // . X . .
  // . . X X
  // . X X X
  // X X X .
  const expected = [
    [2,1,2,2],
    [2,2,1,1],
    [2,1,1,1],
    [1,1,1,2],
  ];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    assert.equal(s.cellStatus[r*4+c], expected[r][c],
      `cell (${r},${c}) expected ${expected[r][c]} got ${s.cellStatus[r*4+c]}`);
  }
});
```

- [ ] **Step 2: Verify failure (`_propagate` undefined).**

- [ ] **Step 3: Implement — inside `KakurasuSolver`:**

```js
_propagate() {
  let changed = true;
  while (changed) {
    if (this._timeUp()) return true;
    changed = false;
    const cm = this.cellTrail.length;
    if (!this._applyLines()) return false;
    if (this.cellTrail.length > cm) changed = true;
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
        const cm = this.cellTrail.length;
        const mm = this.maskTrail.length;
        this._inLookahead = true;
        const okSet = this._set(i, v);
        const ok = okSet && this._propagate();
        this._rollback(cm, mm);
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

- [ ] **Step 4: Verify 10 passing.**

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(kakurasu): _propagate orchestrator + top-level lookahead"
```

---

## Task 5: solve() + backtracking + caches + computePuzzleDiff arm

**Files:**
- Modify: `solver.js` (add `_isComplete`, `_emit`, `_pickBestUnknown`, `_backtrack`, `solve`, static caches, helpers; extend `computePuzzleDiff`)
- Test: `tests/kakurasu.test.js` (append)

- [ ] **Step 1: Failing tests — append:**

```js
test('KakurasuSolver.solve: solves recon 4x4', () => {
  KakurasuSolver.clearSolutionCache();
  const s = new KakurasuSolver({
    rows: 4, cols: 4,
    rowClues: [2, 7, 9, 6],
    colClues: [4, 8, 9, 5],
  });
  const r = s.solve();
  assert.equal(r.solved, true);
  const expected = [
    [2,1,2,2],
    [2,2,1,1],
    [2,1,1,1],
    [1,1,1,2],
  ];
  assert.deepEqual(r.grid, expected);
});

test('KakurasuSolver.solve: unsat returns {solved:false, grid:null}', () => {
  KakurasuSolver.clearSolutionCache();
  const s = new KakurasuSolver({
    rows: 1, cols: 3,
    rowClues: [100],
    colClues: [0, 0, 0],
  });
  const r = s.solve();
  assert.equal(r.solved, false);
  assert.equal(r.grid, null);
});

test('KakurasuSolver._solutionCache: cache hit returns deep copy', () => {
  KakurasuSolver.clearSolutionCache();
  const opts = { rows:4, cols:4, rowClues:[2,7,9,6], colClues:[4,8,9,5] };
  const a = new KakurasuSolver(opts).solve();
  a.grid[0][0] = 99;
  const b = new KakurasuSolver(opts).solve();
  assert.notEqual(b.grid[0][0], 99);
});

test('computePuzzleDiff kakurasu: flags wrong-color cells, ignores unknown', () => {
  const { computePuzzleDiff } = require('../solver.js');
  const solution = [[1, 2], [2, 1]];
  const board = [[2, 2], [0, 1]];
  const diff = computePuzzleDiff('kakurasu', board, solution);
  assert.equal(diff.length, 1);
  assert.deepEqual(diff[0], { row: 0, col: 0, expected: 1, actual: 2 });
});
```

- [ ] **Step 2: Verify failure.**

- [ ] **Step 3: Implement — inside `KakurasuSolver`:**

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
  // Tightness = inverse of fewer-active-masks for the cell's row or col.
  let bestIdx = -1, bestScore = -Infinity;
  const total = this.rows * this.cols;
  for (let i = 0; i < total; i++) {
    if (this.cellStatus[i] !== 0) continue;
    const r = (i / this.cols) | 0, c = i - r * this.cols;
    const rn = this.rowMasksActive[r].length;
    const cn = this.colMasksActive[c].length;
    const score = 1 / (rn + 1) + 1 / (cn + 1);
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
    const cm = this.cellTrail.length, mm = this.maskTrail.length;
    if (this._set(idx, v) && this._propagate() && this._backtrack()) {
      this._depth--;
      return true;
    }
    this._rollback(cm, mm);
    if (this._timeUp()) break;
  }
  this._depth--;
  return false;
}

solve() {
  const key = this._cacheKey();
  const cached = KakurasuSolver._solutionCache.get(key)
              || KakurasuSolver._partialCache.get(key);
  if (cached) return this._cloneResult(cached);
  this._startedAt = Date.now();
  let result;
  if (!this._propagate()) {
    this._rollback(0, 0);
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

Then add the static fields + helpers at the BOTTOM of `KakurasuSolver`:

```js
static _solutionCache = new Map();
static _maxSolutionCache = 50;
static _partialCache = new Map();
static _maxPartialCache = 20;
static clearSolutionCache() {
  KakurasuSolver._solutionCache.clear();
  KakurasuSolver._partialCache.clear();
}

_cacheKey() {
  let h = 0x811c9dc5;
  const mix = (n) => { h ^= n & 0xff; h = Math.imul(h, 0x01000193) >>> 0; };
  mix(this.rows); mix(this.cols);
  for (let r = 0; r < this.rows; r++) mix(this.rowClues[r]);
  for (let c = 0; c < this.cols; c++) mix(this.colClues[c]);
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
  const m = result.partial ? KakurasuSolver._partialCache : KakurasuSolver._solutionCache;
  const max = result.partial ? KakurasuSolver._maxPartialCache : KakurasuSolver._maxSolutionCache;
  if (m.size >= max) {
    const first = m.keys().next().value;
    m.delete(first);
  }
  m.set(key, this._cloneResult(result));
}
```

Then extend `computePuzzleDiff` in `solver.js` — find the existing `if (type === 'heyawake' || type === 'hitori')` arm. Add `|| type === 'kakurasu'`.

- [ ] **Step 4: Verify 14 passing.**

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(kakurasu): solve() with MC backtracking + caches + computePuzzleDiff arm"
```

---

## Task 6: Stepwise getHint

**Files:**
- Modify: `solver.js` (add `getHint`)
- Test: `tests/kakurasu.test.js` (append)

Stepwise — try rows then columns; stop at first that yields new forced cells. Fall back to single lookahead.

- [ ] **Step 1: Failing tests — append:**

```js
test('KakurasuSolver.getHint: single-mask row yields immediate hint', () => {
  KakurasuSolver.clearSolutionCache();
  const s = new KakurasuSolver({
    rows: 1, cols: 4,
    rowClues: [2],
    colClues: [0, 1, 0, 0],
  });
  const hint = s.getHint([[0,0,0,0]]);
  assert.ok(Array.isArray(hint));
  assert.ok(hint.length >= 1);
  // (0,1) must be filled.
  const c1 = hint.find(h => h.row === 0 && h.col === 1);
  assert.ok(c1);
  assert.equal(c1.value, 1);
});

test('KakurasuSolver.getHint: null on solved board', () => {
  KakurasuSolver.clearSolutionCache();
  const s = new KakurasuSolver({
    rows: 1, cols: 4,
    rowClues: [2],
    colClues: [0, 1, 0, 0],
  });
  assert.equal(s.getHint([[2, 1, 2, 2]]), null);
});

test('KakurasuSolver.getHint: stepwise — small batch on 4x4', () => {
  KakurasuSolver.clearSolutionCache();
  const s = new KakurasuSolver({
    rows: 4, cols: 4,
    rowClues: [2, 7, 9, 6],
    colClues: [4, 8, 9, 5],
  });
  const empty = Array.from({length:4}, () => new Array(4).fill(0));
  const hint = s.getHint(empty);
  assert.ok(Array.isArray(hint));
  assert.ok(hint.length >= 1);
  assert.ok(hint.length <= 8, `expected ≤ 8 cells per step; got ${hint.length}`);
});
```

- [ ] **Step 2: Verify failure.**

- [ ] **Step 3: Implement — inside `KakurasuSolver`:**

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
  this.cellTrail = [];
  this.maskTrail = [];
  this._depth = 0;
  this._inLookahead = false;
  this._startedAt = Date.now();
  // Re-narrow masks against the live state. Done by re-building from rowMasks/colMasks
  // would be cleaner, but masks were already filtered in earlier propagation. Since
  // getHint creates a fresh solver each call (in content.js), masks are at construction
  // values — so just run _applyLines once per row/col stop-at-first-firing.
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

  // Per-row narrowing+forcing — stop at first row that yields a change.
  for (let r = 0; r < this.rows; r++) {
    const active = this._narrowLine(0, r, this.rowMasksActive[r]);
    this.rowMasksActive[r] = active;
    if (active.length === 0) return null;
    let inter = active[0], union = active[0];
    for (let i = 1; i < active.length; i++) {
      inter &= active[i];
      union |= active[i];
    }
    let changed = false;
    for (let c = 0; c < this.cols; c++) {
      const bitMask = 1 << c;
      const idx = r * this.cols + c;
      if ((inter & bitMask) && this.cellStatus[idx] === 0) {
        if (!this._set(idx, 1)) return null;
        changed = true;
      } else if (!(union & bitMask) && this.cellStatus[idx] === 0) {
        if (!this._set(idx, 2)) return null;
        changed = true;
      }
    }
    if (changed) {
      const h = collectChanged();
      if (h.length) return h;
    }
  }

  // Per-col narrowing+forcing — stop at first col that yields a change.
  for (let c = 0; c < this.cols; c++) {
    const active = this._narrowLine(1, c, this.colMasksActive[c]);
    this.colMasksActive[c] = active;
    if (active.length === 0) return null;
    let inter = active[0], union = active[0];
    for (let i = 1; i < active.length; i++) {
      inter &= active[i];
      union |= active[i];
    }
    let changed = false;
    for (let r = 0; r < this.rows; r++) {
      const bitMask = 1 << r;
      const idx = r * this.cols + c;
      if ((inter & bitMask) && this.cellStatus[idx] === 0) {
        if (!this._set(idx, 1)) return null;
        changed = true;
      } else if (!(union & bitMask) && this.cellStatus[idx] === 0) {
        if (!this._set(idx, 2)) return null;
        changed = true;
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
      const cm = this.cellTrail.length, mm = this.maskTrail.length;
      this._inLookahead = true;
      const okSet = this._set(i, v);
      const ok = okSet && this._propagate();
      this._rollback(cm, mm);
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
jj commit -m "feat(kakurasu): stepwise getHint"
```

---

## Task 7: Fuzz soundness test

**Files:**
- Create: `tests/kakurasu-fuzz.test.js`

Generate random valid solutions by sampling random 0/1 grids, deriving row+col clues, then re-solving and checking the result satisfies both row sums and col sums.

- [ ] **Step 1: Create**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { KakurasuSolver } = require('../solver.js');

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
  const rowClues = new Array(rows).fill(0);
  const colClues = new Array(cols).fill(0);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (shade[r][c]) {
        rowClues[r] += (c + 1);
        colClues[c] += (r + 1);
      }
    }
  }
  return { rowClues, colClues, shade };
}

function validate(rows, cols, rowClues, colClues, grid) {
  for (let r = 0; r < rows; r++) {
    let sum = 0;
    for (let c = 0; c < cols; c++) {
      if (grid[r][c] === 1) sum += (c + 1);
    }
    if (sum !== rowClues[r]) return `row ${r} sum ${sum} ≠ clue ${rowClues[r]}`;
  }
  for (let c = 0; c < cols; c++) {
    let sum = 0;
    for (let r = 0; r < rows; r++) {
      if (grid[r][c] === 1) sum += (r + 1);
    }
    if (sum !== colClues[c]) return `col ${c} sum ${sum} ≠ clue ${colClues[c]}`;
  }
  return null;
}

test('KakurasuSolver fuzz: solved boards satisfy both row and column sums', () => {
  KakurasuSolver.clearSolutionCache();
  let solved = 0;
  for (let seed = 1; seed <= 30; seed++) {
    KakurasuSolver.clearSolutionCache();
    const rows = 3 + (seed % 4);    // 3..6
    const cols = 3 + ((seed >> 2) % 4);  // 3..6
    const { rowClues, colClues } = generatePuzzle(rows, cols, seed * 9173 + 1);
    const s = new KakurasuSolver({ rows, cols, rowClues, colClues, maxMs: 2000 });
    const r = s.solve();
    if (!r.solved) continue;
    const err = validate(rows, cols, rowClues, colClues, r.grid);
    assert.equal(err, null, `seed=${seed} ${rows}x${cols}: ${err}`);
    solved++;
  }
  assert.ok(solved >= 10, `expected ≥ 10 solved boards, got ${solved}`);
});
```

- [ ] **Step 2: Run, expect PASS.**

- [ ] **Step 3: Commit**

```bash
jj commit -m "test(kakurasu): fuzz suite for row+col sum soundness"
```

---

## Task 8: Fixtures + golden + integration test

**Files:**
- Modify: `tests/fixtures/puzzles.js`
- Modify: `tests/golden.js`
- Modify: `tests/solver.test.js`

- [ ] **Step 1: Add fixture to puzzles.js:**

```js
exports.kakurasu4x4Easy = {
  type: 'kakurasu',
  rows: 4,
  cols: 4,
  rowClues: [2, 7, 9, 6],
  colClues: [4, 8, 9, 5],
};
```

- [ ] **Step 2: Add golden:**

```js
exports.kakurasu4x4Easy = [
  [2,1,2,2],
  [2,2,1,1],
  [2,1,1,1],
  [1,1,1,2],
];
```

- [ ] **Step 3: Add integration test to solver.test.js:**

```js
test('KakurasuSolver: kakurasu4x4Easy fixture matches golden', () => {
  const { KakurasuSolver } = require('../solver.js');
  const fixture = require('./fixtures/puzzles.js').kakurasu4x4Easy;
  KakurasuSolver.clearSolutionCache();
  const s = new KakurasuSolver({
    rows: fixture.rows,
    cols: fixture.cols,
    rowClues: fixture.rowClues,
    colClues: fixture.colClues,
  });
  const r = s.solve();
  assert.equal(r.solved, true);
  assert.deepEqual(r.grid, require('./golden.js').kakurasu4x4Easy);
});
```

- [ ] **Step 4: Run `npm test`, expect clean.**

- [ ] **Step 5: Commit**

```bash
jj commit -m "test(kakurasu): puzzles.js fixture + golden snapshot + integration test"
```

---

## Task 9: MAIN-world functions + allowlist + globals.d.ts + eslint

**Files:**
- Modify: `main-world.js`
- Modify: `background.js`
- Modify: `globals.d.ts`
- Modify: `eslint.config.js`

- [ ] **Step 1: Add `readKakurasuData` to main-world.js:**

```js
function readKakurasuData() {
  try {
    var G = window.Game;
    if (!G || !G.task || !G.task.horizontal || !G.task.vertical) return null;
    if (!G.puzzleWidth || !G.puzzleHeight) return null;
    var rows = G.puzzleHeight, cols = G.puzzleWidth;
    var rowClues = [];
    for (var r = 0; r < rows; r++) rowClues.push(G.task.horizontal[r] || 0);
    var colClues = [];
    for (var c = 0; c < cols; c++) colClues.push(G.task.vertical[c] || 0);
    return { rows: rows, cols: cols, rowClues: rowClues, colClues: colClues };
  } catch (e) {
    return null;
  }
}
```

- [ ] **Step 2: Add `readKakurasuState`:**

```js
function readKakurasuState(rows, cols) {
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

- [ ] **Step 3: Add `applyKakurasuState`:**

```js
function applyKakurasuState(grid) {
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
    console.warn('Kakurasu apply failed:', e);
    return false;
  }
}
```

- [ ] **Step 4: background.js EXEC_MAIN_ALLOWLIST — add three entries.**

- [ ] **Step 5: globals.d.ts — add three to `MainWorldFn`, plus `declare const KakurasuSolver: any;`.**

- [ ] **Step 6: eslint.config.js — add `KakurasuSolver` to `solverClasses` globals block.**

- [ ] **Step 7: Verify `npm run lint && npm run typecheck && npm test`.**

- [ ] **Step 8: Commit**

```bash
jj commit -m "feat(kakurasu): MAIN-world read/apply fns + allowlist + globals.d.ts"
```

---

## Task 10: Worker arm + handler registration

**Files:**
- Modify: `solver.worker.js`
- Modify: `handler.js`

- [ ] **Step 1: Worker arm** — add `KakurasuSolver` to `/* global */`, then add arm before the final `else`:

```js
} else if (type === 'kakurasu' && extraData) {
  const s = new KakurasuSolver({
    rows: extraData.rows,
    cols: extraData.cols,
    rowClues: extraData.rowClues,
    colClues: extraData.colClues,
    initialState: initialGrid || null,
    maxMs: 30000,
  });
  result = s.solve();
}
```

- [ ] **Step 2: Register handler** — after `hitoriHandler`:

```js
const kakurasuHandler = {
  name: 'puzzles-mobile-kakurasu',
  priority: 30,
  matches() {
    return isPuzzlesMobilePage() && window.location.pathname.includes('/kakurasu/');
  },
  async detect() {
    const result = { found: false, rows: 0, cols: 0, rowClues: [], colClues: [] };
    const data = await callMainWorld('readKakurasuData', []);
    if (!data) return { ...result, error: 'No Kakurasu task data found' };
    const stageEl = document.getElementById('stage') ||
                    document.getElementById('game') ||
                    document.querySelector('[class*="game"], [class*="puzzle"]');
    return {
      found: true,
      type: 'kakurasu',
      rows: data.rows,
      cols: data.cols,
      rowClues: data.rowClues,
      colClues: data.colClues,
      _cells: [],
      _element: stageEl,
    };
  },
  async readState(ctx) {
    const state = await callMainWorld('readKakurasuState', [ctx.rows, ctx.cols]);
    if (state) return state;
    return Array.from({ length: ctx.rows }, () => new Array(ctx.cols).fill(0));
  },
  async applySolution(solution, _ctx) {
    const ok = await callMainWorld('applyKakurasuState', [solution]);
    return ok ? { success: true } : { success: false, error: 'Kakurasu apply failed' };
  },
};

registerHandler(kakurasuHandler);
```

- [ ] **Step 3: Verify `npm run lint && npm run typecheck && npm test`.**

- [ ] **Step 4: Commit**

```bash
jj commit -m "feat(kakurasu): worker dispatch arm + handler registration"
```

---

## Task 11: dumpPuzzleForBench arm + real fixture + bench-real arm

**Files:**
- Modify: `main-world.js` (INLINE extraction in dump)
- Modify: `tests/fixtures/real-puzzles.js`
- Modify: `tests/bench-real.js`

- [ ] **Step 1: Inline dump arm** — find `dumpPuzzleForBench`. Add before existing branches:

```js
if (path.indexOf('/kakurasu/') !== -1 || g.slug === 'kakurasu') {
  // INLINE — no readKakurasuData call (serialized via fn.toString).
  if (!g.task || !g.task.horizontal || !g.task.vertical
      || !g.puzzleWidth || !g.puzzleHeight) {
    return { error: 'kakurasu: missing task/dims', diagnostic: diagnostic(g), path: path };
  }
  var kaRows = g.puzzleHeight, kaCols = g.puzzleWidth;
  var rowClues = [];
  for (var kr = 0; kr < kaRows; kr++) rowClues.push(g.task.horizontal[kr] || 0);
  var colClues = [];
  for (var kc = 0; kc < kaCols; kc++) colClues.push(g.task.vertical[kc] || 0);
  return { type: 'kakurasu', rows: kaRows, cols: kaCols,
           rowClues: rowClues, colClues: colClues, path: path };
}
```

- [ ] **Step 2: Real fixture** — append to real-puzzles.js:

```js
exports.kakurasu4x4EasyReal = {
  type: 'kakurasu',
  rows: 4,
  cols: 4,
  rowClues: [2, 7, 9, 6],
  colClues: [4, 8, 9, 5],
};
```

- [ ] **Step 3: bench-real arm** — open `tests/bench-real.js`. Mirror the hitori arm:

```js
if (fixture.type === 'kakurasu') {
  const { KakurasuSolver } = require('../solver.js');
  return new KakurasuSolver({
    rows: fixture.rows,
    cols: fixture.cols,
    rowClues: fixture.rowClues,
    colClues: fixture.colClues,
  });
}
```

(Mirror whatever pattern the file uses for imports + cache clears in the warmup/iter loops.)

- [ ] **Step 4: Verify `node tests/bench-real.js`** — expect kakurasu4x4EasyReal solves.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(kakurasu): dumpPuzzleForBench arm + real fixture + bench-real arm"
```

---

## Task 12: bench-kakurasu.js + CI step

**Files:**
- Create: `tests/bench-kakurasu.js`
- Modify: `.github/workflows/bench-nightly.yml`

- [ ] **Step 1: Create bench script:**

```js
'use strict';
const { KakurasuSolver } = require('../solver.js');
const fixture = require('./fixtures/real-puzzles.js').kakurasu4x4EasyReal;

const ITERATIONS = 5;
const WARMUP = 2;
const times = [];
for (let i = 0; i < WARMUP + ITERATIONS; i++) {
  KakurasuSolver.clearSolutionCache();
  const s = new KakurasuSolver({
    rows: fixture.rows,
    cols: fixture.cols,
    rowClues: fixture.rowClues,
    colClues: fixture.colClues,
  });
  const t0 = process.hrtime.bigint();
  const r = s.solve();
  const t1 = process.hrtime.bigint();
  if (!r.solved) {
    console.error('kakurasu4x4EasyReal failed to solve');
    process.exit(1);
  }
  if (i >= WARMUP) times.push(Number(t1 - t0) / 1e6);
}
times.sort((a, b) => a - b);
const median = times[Math.floor(times.length / 2)];
console.log(`kakurasu4x4EasyReal: median ${median.toFixed(2)} ms over ${ITERATIONS} runs`);
```

- [ ] **Step 2: Run, expect a median print.**

- [ ] **Step 3: CI step** — `.github/workflows/bench-nightly.yml`:

```yaml
      - name: Bench Kakurasu
        run: node tests/bench-kakurasu.js
```

(Adjacent to existing bench steps; match indentation.)

- [ ] **Step 4: Commit**

```bash
jj commit -m "ci(kakurasu): bench script + nightly workflow step"
```

---

## Task 13: content.js bookkeeping

**Files:** `content.js`

- [ ] **Step 1: SUPPORTED_PUZZLES** — insert (alphabetical: between Hitori and Nonogram):

```js
  { name: 'Kakurasu',     url: 'https://www.puzzles-mobile.com/kakurasu/' },
```

- [ ] **Step 2: SOLUTION_KEY_PREFIXES** — add `'kakurasu-solution:'`.

- [ ] **Step 3: kakurasuCacheKey** — after `hitoriCacheKey`:

```js
function kakurasuCacheKey(data) {
  if (data?.type !== 'kakurasu' || !data.rowClues || !data.colClues) return null;
  let h = 0x811c9dc5;
  const mix = (n) => { h ^= n & 0xff; h = Math.imul(h, 0x01000193) >>> 0; };
  mix(0x4B); // 'K' nameplate
  mix(data.rows); mix(data.cols);
  for (const v of data.rowClues) mix(v + 1);
  for (const v of data.colClues) mix(v + 1);
  return 'kakurasu-solution:' + (h >>> 0).toString(16);
}
```

Wire alongside hitoriCacheKey at both ternary chain sites.

- [ ] **Step 4: solveExtraData arm:**

```js
if (data.type === 'kakurasu') {
  return { rows: data.rows, cols: data.cols, rowClues: data.rowClues, colClues: data.colClues };
}
```

- [ ] **Step 5: kakurasuCluesSig + staticSig segment** — after `hitoriTaskSig`:

```js
function kakurasuCluesSig(rowClues, colClues) {
  if (!rowClues || !colClues) return '0';
  let h = 0x811c9dc5;
  for (const v of rowClues) { h ^= v & 0xff; h = Math.imul(h, 0x01000193) >>> 0; }
  for (const v of colClues) { h ^= v & 0xff; h = Math.imul(h, 0x01000193) >>> 0; }
  return (h >>> 0).toString(16);
}
```

In `staticSig`, add `'|ka=' + kakurasuCluesSig(pd?.type === 'kakurasu' ? pd.rowClues : null, pd?.type === 'kakurasu' ? pd.colClues : null)`.

- [ ] **Step 6: pendingAutoSolve gate** — extend `skipAutoSolveGate` to include kakurasu.

- [ ] **Step 7: drawPreview rect-bail** — add `|| pd?.type === 'kakurasu'`.

- [ ] **Step 8: Verify `npm run lint && npm run typecheck && npm test`.**

- [ ] **Step 9: Commit**

```bash
jj commit -m "feat(kakurasu): content.js bookkeeping (SUPPORTED_PUZZLES, prefix, cache key, sig, gate)"
```

---

## Task 14: content.js drawPreview arm

**Files:** `content.js`

Renders the N×N grid plus row clues on the right edge and column clues on the bottom edge. Canvas extent: `(N+1) × (N+1)` cells.

- [ ] **Step 1: Read existing structure** — inspect the hitori arm and the nonogram clue rendering for layout reference.

- [ ] **Step 2: Canvas sizing** — find where canvas dimensions are computed (probably uses `rows`/`cols` from `puzzleData`). For kakurasu, the visible grid is `rows × cols` but the canvas needs an extra row/col for the edge clues. Match whatever pattern Nonogram uses for accommodating clue strips.

  If the file already computes `displayRows = rows + extraTop` style, add `extraRight`/`extraBottom = pd?.type === 'kakurasu' ? 1 : 0`.

- [ ] **Step 3: Add kakurasu arm in drawPreview:**

```js
if (pd?.type === 'kakurasu') {
  const cellSize = /* existing variable */;
  const rows = pd.rows, cols = pd.cols;
  // Grid cells in the top-left N×N area:
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * cellSize, y = r * cellSize;
      const v = grid[r][c];
      // Cell background — alternate or single color
      ctx.strokeStyle = '#9ca3af';
      ctx.strokeRect(x, y, cellSize, cellSize);
      if (v === 1) {
        const pad = Math.max(2, Math.floor(cellSize * 0.1));
        ctx.fillStyle = '#1f2937';
        ctx.fillRect(x + pad, y + pad, cellSize - 2*pad, cellSize - 2*pad);
      } else if (v === 2) {
        // X mark
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
    }
  }
  // Row clues on the right edge (column = cols):
  ctx.font = `bold ${Math.floor(cellSize * 0.5)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#1f2937';
  for (let r = 0; r < rows; r++) {
    const x = cols * cellSize + cellSize / 2;
    const y = r * cellSize + cellSize / 2;
    ctx.fillText(String(pd.rowClues[r]), x, y);
  }
  // Column clues on the bottom edge (row = rows):
  for (let c = 0; c < cols; c++) {
    const x = c * cellSize + cellSize / 2;
    const y = rows * cellSize + cellSize / 2;
    ctx.fillText(String(pd.colClues[c]), x, y);
  }
  // Hint overlay: ring forced cells.
  if (hint?.extraCells) {
    for (const cell of hint.extraCells) {
      const x = cell.col * cellSize, y = cell.row * cellSize;
      ctx.strokeStyle = cell.value === 1 ? '#3b82f6' : '#60a5fa';
      ctx.lineWidth = 3;
      ctx.strokeRect(x + 2, y + 2, cellSize - 4, cellSize - 4);
    }
  }
  // Mistake rings.
  if (pd.solution) {
    const diff = computePuzzleDiff('kakurasu', grid, pd.solution);
    for (const m of diff) {
      const x = m.col * cellSize, y = m.row * cellSize;
      ctx.strokeStyle = '#dc2626';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x + cellSize / 2, y + cellSize / 2, cellSize * 0.35, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  return;
}
```

**Adapt this to the file's exact variable names** — read the hitori arm for the actual cellSize/ctx/staticLayer conventions. If hitori uses a separate `buildStaticLayer` for the static parts, mirror that for the clue text (it's static — depends only on the clues, not the dynamic state).

If the canvas sizing requires changes elsewhere (e.g. a `getPuzzleExtent` function), update it to account for the +1 row/col clue band for kakurasu.

- [ ] **Step 4: Verify `npm run lint && npm run typecheck && npm test && npm run build`.**

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(kakurasu): drawPreview arm with row/col edge clues + cross marks"
```

---

## Task 15: content.js getHint + hintStatusNodes + partial arm + Loop break

**Files:** `content.js`

- [ ] **Step 1: getHint dispatch** — after the hitori arm:

```js
} else if (detectedGrid.type === 'kakurasu') {
  if (solution && firstMismatch(grid, solution)) {
    return { success: false, error: 'Current game state is wrong.' };
  }
  const solver = new KakurasuSolver({
    rows, cols,
    rowClues: detectedGrid.rowClues,
    colClues: detectedGrid.colClues,
  });
  const hintCells = solver.getHint(grid);
  if (!hintCells || hintCells.length === 0) {
    return { success: false, error: 'No more cells can be deduced from the current state. Click Solve to finish.' };
  }
  hint = { type: 'kakurasu', extraCells: hintCells, count: hintCells.length };
}
```

- [ ] **Step 2: setHintStatus arm + kakurasuHintStatusNodes** — after hitoriHintStatusNodes:

```js
function kakurasuHintStatusNodes(h) {
  const cells = h.extraCells || [];
  if (cells.length === 0) return ['No hint available'];
  if (cells.length === 1) {
    const cell = cells[0];
    const valueStr = cell.value === 1 ? 'filled' : 'empty';
    return [
      'Cell ', bold(`(row ${cell.row + 1}, col ${cell.col + 1})`),
      ' must be ', bold(valueStr),
    ];
  }
  return [bold(String(cells.length)), ' cells can be deduced'];
}
```

In `setHintStatus`, add a kakurasu arm:

```js
} else if (puzzleData?.type === 'kakurasu') {
  setStatusNodes('info', prefix, ...kakurasuHintStatusNodes(h));
}
```

- [ ] **Step 3: solveHandler partial arm** — add a kakurasu branch:

```js
if (result?.partial && puzzleData?.type === 'kakurasu' && Array.isArray(result.grid)) {
  applyGridPartialResult(result);
  return;
}
```

- [ ] **Step 4: Loop early-break** — add `&& hr.hint?.type !== 'kakurasu'`.

- [ ] **Step 5: Verify `npm run lint && npm run typecheck && npm test && npm run build`.**

- [ ] **Step 6: Commit**

```bash
jj commit -m "feat(kakurasu): content.js getHint dispatch + hintStatusNodes + partial arm + Loop break"
```

---

## Task 16: Final verification + push

**Files:** (none — verification only)

- [ ] **Step 1: Full suite** — `npm test`. Expect ~320 tests passing.
- [ ] **Step 2: Lint + typecheck.**
- [ ] **Step 3: Build.**
- [ ] **Step 4: Bench** — `node tests/bench-kakurasu.js`.
- [ ] **Step 5: Manual smoke test** — load dist/, navigate to `/kakurasu/random/4x4-easy`, Detect → Solve → Apply → verify the page accepts the moves. Hint → cells highlighted.
- [ ] **Step 6: Push** — `jj bookmark set main -r @-` then `jj git push --bookmark main`.

---

End of plan.
