# Norinori Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Norinori support — 14th puzzle type. Region-partitioned (like Heyawake) but with per-region "exactly 2 blacks forming a domino" + cross-region no-adjacency rules.

**Architecture:** `NorinoriSolver` follows Heyawake's shape (`cellToRoom` + `roomCells` + flat cellStatus) with a **context-sensitive `_set` adjacency cascade** — only cross-region neighbours are forced white when writing black; same-region neighbours stay free (they may be the domino partner).

**Reference spec:** `docs/superpowers/specs/2026-05-24-norinori-design.md`
**Closest existing solver:** Heyawake for region partition + cellStatus encoding.

`jj commit` not git. Repo `/home/quando/documents/chrome-puzzle-solver/`. TDD.

---

## Task 1: NorinoriSolver scaffold + _set with cross-region cascade

**Files:** `solver.js`, `tests/norinori.test.js` (new).

The constructor builds `roomCells` + `cellToRoom`. The key novelty is `_set`: black writes force ONLY cross-region 4-neighbours to white; same-region neighbours are left untouched.

- [ ] **Step 1: Create the failing test**

Create `tests/norinori.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { NorinoriSolver } = require('../solver.js');

test('NorinoriSolver: constructor mirrors rooms and cellToRoom', () => {
  const s = new NorinoriSolver({
    rows: 2, cols: 2,
    rooms: [
      { cells: [{r: 0, c: 0}, {r: 0, c: 1}] },
      { cells: [{r: 1, c: 0}, {r: 1, c: 1}] },
    ],
  });
  assert.equal(s.rows, 2);
  assert.equal(s.K, 2);
  assert.equal(s.cellToRoom[0], 0);
  assert.equal(s.cellToRoom[1], 0);
  assert.equal(s.cellToRoom[2], 1);
  assert.equal(s.cellToRoom[3], 1);
});

test('NorinoriSolver: _set black forces CROSS-region neighbours to white', () => {
  // 2x3, two rows = two regions. Black at (0,1) should force (1,1) white
  // (cross-region) but NOT touch (0,0) or (0,2) (same region).
  const s = new NorinoriSolver({
    rows: 2, cols: 3,
    rooms: [
      { cells: [{r: 0, c: 0}, {r: 0, c: 1}, {r: 0, c: 2}] },
      { cells: [{r: 1, c: 0}, {r: 1, c: 1}, {r: 1, c: 2}] },
    ],
  });
  assert.equal(s._set(1, 1), true); // (0,1) black
  assert.equal(s.cellStatus[1], 1);
  assert.equal(s.cellStatus[4], 2); // (1,1) cross-region → white
  assert.equal(s.cellStatus[0], 0); // (0,0) same region → unchanged
  assert.equal(s.cellStatus[2], 0); // (0,2) same region → unchanged
});

test('NorinoriSolver: _set cross-region black-on-black → contradiction', () => {
  const s = new NorinoriSolver({
    rows: 2, cols: 2,
    rooms: [
      { cells: [{r: 0, c: 0}, {r: 0, c: 1}] },
      { cells: [{r: 1, c: 0}, {r: 1, c: 1}] },
    ],
    initialState: [[1, 0], [0, 0]],
  });
  assert.equal(s._set(2, 1), false); // (1,0) adjacent to (0,0) cross-region
});

test('NorinoriSolver: _set same-region black-adjacent is OK (domino formation)', () => {
  const s = new NorinoriSolver({
    rows: 1, cols: 2,
    rooms: [{cells: [{r: 0, c: 0}, {r: 0, c: 1}]}],
    initialState: [[1, 0]],
  });
  assert.equal(s._set(1, 1), true); // same region, becomes domino
  assert.equal(s.cellStatus[1], 1);
});

test('NorinoriSolver: _set / _rollback round-trip', () => {
  const s = new NorinoriSolver({
    rows: 1, cols: 2,
    rooms: [{cells: [{r: 0, c: 0}, {r: 0, c: 1}]}],
  });
  const mark = s.trail.length;
  assert.equal(s._set(0, 2), true);
  s._rollback(mark);
  assert.equal(s.cellStatus[0], 0);
});
```

- [ ] **Step 2: Verify failure** — `NorinoriSolver is not defined`.

- [ ] **Step 3: Add NorinoriSolver to solver.js** (after `MosaicSolver`, before `module.exports`):

```js
class NorinoriSolver {
  constructor(data) {
    const { rows, cols, rooms, initialState, maxMs } = data;
    this.rows = rows;
    this.cols = cols;
    this.K = rooms.length;
    this.cellToRoom = new Int32Array(rows * cols).fill(-1);
    this.roomCells = new Array(this.K);
    for (let k = 0; k < this.K; k++) {
      const cells = rooms[k].cells;
      const arr = new Int32Array(cells.length);
      for (let i = 0; i < cells.length; i++) {
        const idx = cells[i].r * cols + cells[i].c;
        arr[i] = idx;
        this.cellToRoom[idx] = k;
      }
      this.roomCells[k] = arr;
    }
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
    if (value === 1) {
      const r = (idx / this.cols) | 0;
      const c = idx - r * this.cols;
      const ownRoom = this.cellToRoom[idx];
      const ns = [];
      if (r > 0) ns.push(idx - this.cols);
      if (r < this.rows - 1) ns.push(idx + this.cols);
      if (c > 0) ns.push(idx - 1);
      if (c < this.cols - 1) ns.push(idx + 1);
      for (let i = 0; i < ns.length; i++) {
        const ni = ns[i];
        // Cross-region: black-on-black contradiction; force unknown to white.
        // Same-region: leave it alone (it may become the domino partner).
        if (this.cellToRoom[ni] === ownRoom) continue;
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

Update `module.exports` to include `NorinoriSolver`.

- [ ] **Step 4: Verify 5 passing.**

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(norinori): NorinoriSolver scaffold with cross-region adjacency cascade"
```

---

## Task 2: Precompute per-region domino candidates

**Files:** `solver.js`, `tests/norinori.test.js` (append).

For each region, enumerate all adjacent same-region cell pairs (ordered low-to-high to avoid duplicates).

- [ ] **Step 1: Failing tests — append:**

```js
test('NorinoriSolver._buildDominoCandidates: 1x2 region has 1 candidate', () => {
  const s = new NorinoriSolver({
    rows: 1, cols: 2,
    rooms: [{cells: [{r: 0, c: 0}, {r: 0, c: 1}]}],
  });
  assert.equal(s.dominoCandidates[0].length, 1);
  assert.deepEqual(Array.from(s.dominoCandidates[0][0]), [0, 1]);
});

test('NorinoriSolver._buildDominoCandidates: L-shaped region has 2 candidates', () => {
  // L: (0,0), (1,0), (1,1). Adjacent pairs: (0,0)-(1,0) and (1,0)-(1,1).
  const s = new NorinoriSolver({
    rows: 2, cols: 2,
    rooms: [
      { cells: [{r: 0, c: 0}, {r: 1, c: 0}, {r: 1, c: 1}] },
      { cells: [{r: 0, c: 1}] },
    ],
  });
  assert.equal(s.dominoCandidates[0].length, 2);
});

test('NorinoriSolver._buildDominoCandidates: 2x2 region has 4 candidates', () => {
  const s = new NorinoriSolver({
    rows: 2, cols: 2,
    rooms: [{cells: [{r: 0, c: 0}, {r: 0, c: 1}, {r: 1, c: 0}, {r: 1, c: 1}]}],
  });
  // (0,0)-(0,1), (0,0)-(1,0), (0,1)-(1,1), (1,0)-(1,1) = 4 pairs.
  assert.equal(s.dominoCandidates[0].length, 4);
});

test('NorinoriSolver._buildDominoCandidates: isolated cell has 0 candidates', () => {
  // 1x2 grid, two single-cell regions. Each cannot have a domino.
  const s = new NorinoriSolver({
    rows: 1, cols: 2,
    rooms: [
      { cells: [{r: 0, c: 0}] },
      { cells: [{r: 0, c: 1}] },
    ],
  });
  assert.equal(s.dominoCandidates[0].length, 0);
  assert.equal(s.dominoCandidates[1].length, 0);
});
```

- [ ] **Step 2: Verify failure (`dominoCandidates` undefined).**

- [ ] **Step 3: Implement — inside `NorinoriSolver`:**

```js
_buildDominoCandidates() {
  this.dominoCandidates = new Array(this.K);
  for (let k = 0; k < this.K; k++) {
    const cells = this.roomCells[k];
    const cellSet = new Set(Array.from(cells));
    const pairs = [];
    for (let i = 0; i < cells.length; i++) {
      const idx = cells[i];
      const r = (idx / this.cols) | 0;
      const c = idx - r * this.cols;
      // Down neighbour (in same region).
      if (r + 1 < this.rows) {
        const ni = idx + this.cols;
        if (cellSet.has(ni)) pairs.push(new Int32Array([idx, ni]));
      }
      // Right neighbour (in same region).
      if (c + 1 < this.cols) {
        const ni = idx + 1;
        if (cellSet.has(ni)) pairs.push(new Int32Array([idx, ni]));
      }
    }
    this.dominoCandidates[k] = pairs;
  }
}
```

Call from constructor end (before `this._startedAt = 0`):

```js
this._buildDominoCandidates();
this._startedAt = 0;
```

- [ ] **Step 4: Verify 9 passing.**

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(norinori): precompute per-region domino candidates"
```

---

## Task 3: Per-region domino propagation (Rule 1)

**Files:** `solver.js`, `tests/norinori.test.js` (append).

For each region, propagate the "exactly 2 blacks forming a domino" rule based on current state.

- [ ] **Step 1: Failing tests — append:**

```js
test('NorinoriSolver._applyDominoes: nB=2 non-adjacent → contradiction', () => {
  // 1x3 region, blacks at (0,0) and (0,2) → not adjacent → contradiction.
  const s = new NorinoriSolver({
    rows: 1, cols: 3,
    rooms: [{cells: [{r: 0, c: 0}, {r: 0, c: 1}, {r: 0, c: 2}]}],
    initialState: [[1, 0, 1]],
  });
  assert.equal(s._applyDominoes(), false);
});

test('NorinoriSolver._applyDominoes: nB=2 adjacent → other cells forced white', () => {
  // 1x3 region, blacks at (0,0) and (0,1). Cell (0,2) → forced white.
  const s = new NorinoriSolver({
    rows: 1, cols: 3,
    rooms: [{cells: [{r: 0, c: 0}, {r: 0, c: 1}, {r: 0, c: 2}]}],
    initialState: [[1, 1, 0]],
  });
  assert.equal(s._applyDominoes(), true);
  assert.equal(s.cellStatus[2], 2);
});

test('NorinoriSolver._applyDominoes: nB=1 with only one same-region neighbour → force partner', () => {
  // 1x2 region. Black at (0,0). Only same-region neighbour is (0,1) → forced black.
  const s = new NorinoriSolver({
    rows: 1, cols: 2,
    rooms: [{cells: [{r: 0, c: 0}, {r: 0, c: 1}]}],
    initialState: [[1, 0]],
  });
  assert.equal(s._applyDominoes(), true);
  assert.equal(s.cellStatus[1], 1);
});

test('NorinoriSolver._applyDominoes: nB=0 with only one live candidate → both cells forced black', () => {
  // 1x2 region with one candidate pair. Both cells forced black.
  const s = new NorinoriSolver({
    rows: 1, cols: 2,
    rooms: [{cells: [{r: 0, c: 0}, {r: 0, c: 1}]}],
  });
  assert.equal(s._applyDominoes(), true);
  assert.equal(s.cellStatus[0], 1);
  assert.equal(s.cellStatus[1], 1);
});

test('NorinoriSolver._applyDominoes: nB=0, multiple candidates → cell in every candidate forced black', () => {
  // L-shaped 3-cell region. Cells: (0,0), (1,0), (1,1).
  // Domino candidates: (0,0)-(1,0) and (1,0)-(1,1).
  // (1,0) is in both candidates → must be black.
  // (0,0) and (1,1) are each in one candidate, neither in both → unchanged.
  const s = new NorinoriSolver({
    rows: 2, cols: 2,
    rooms: [
      { cells: [{r: 0, c: 0}, {r: 1, c: 0}, {r: 1, c: 1}] },
      { cells: [{r: 0, c: 1}] },
    ],
  });
  assert.equal(s._applyDominoes(), true);
  assert.equal(s.cellStatus[2], 1); // (1,0) forced black
  assert.equal(s.cellStatus[0], 0); // (0,0) unchanged
  assert.equal(s.cellStatus[3], 0); // (1,1) unchanged
});

test('NorinoriSolver._applyDominoes: nB=0 with 0 live candidates → contradiction', () => {
  // 1-cell region: no domino possible.
  const s = new NorinoriSolver({
    rows: 1, cols: 1,
    rooms: [{cells: [{r: 0, c: 0}]}],
  });
  assert.equal(s._applyDominoes(), false);
});
```

- [ ] **Step 2: Verify failure (`_applyDominoes` undefined).**

- [ ] **Step 3: Implement — inside `NorinoriSolver`:**

```js
_applyDominoes() {
  for (let k = 0; k < this.K; k++) {
    const cells = this.roomCells[k];
    let nB = 0, nU = 0;
    const blacks = [];
    for (let i = 0; i < cells.length; i++) {
      const v = this.cellStatus[cells[i]];
      if (v === 1) { nB++; blacks.push(cells[i]); }
      else if (v === 0) nU++;
    }
    if (nB > 2) return false;
    if (nB === 2) {
      // Two blacks placed: must be adjacent.
      const dr = Math.abs(((blacks[0] / this.cols) | 0) - ((blacks[1] / this.cols) | 0));
      const dc = Math.abs((blacks[0] % this.cols) - (blacks[1] % this.cols));
      if (dr + dc !== 1) return false;
      // Other cells in region → white.
      for (let i = 0; i < cells.length; i++) {
        if (this.cellStatus[cells[i]] === 0) {
          if (!this._set(cells[i], 2)) return false;
        }
      }
      continue;
    }
    if (nB === 1) {
      // The second black must be a same-region 4-neighbour, not white.
      const bidx = blacks[0];
      const r = (bidx / this.cols) | 0;
      const c = bidx - r * this.cols;
      const partners = [];
      const ns = [];
      if (r > 0) ns.push(bidx - this.cols);
      if (r < this.rows - 1) ns.push(bidx + this.cols);
      if (c > 0) ns.push(bidx - 1);
      if (c < this.cols - 1) ns.push(bidx + 1);
      for (let i = 0; i < ns.length; i++) {
        const ni = ns[i];
        if (this.cellToRoom[ni] !== k) continue;
        if (this.cellStatus[ni] === 2) continue;
        partners.push(ni);
      }
      if (partners.length === 0) return false;
      if (partners.length === 1) {
        if (!this._set(partners[0], 1)) return false;
      }
      // Cells not in {bidx, partners} → white.
      const keep = new Set([bidx, ...partners]);
      for (let i = 0; i < cells.length; i++) {
        if (keep.has(cells[i])) continue;
        if (this.cellStatus[cells[i]] === 0) {
          if (!this._set(cells[i], 2)) return false;
        }
      }
      continue;
    }
    // nB === 0: enumerate live domino candidates.
    const candidates = this.dominoCandidates[k];
    const live = [];
    for (let i = 0; i < candidates.length; i++) {
      const p = candidates[i];
      if (this.cellStatus[p[0]] === 2) continue;
      if (this.cellStatus[p[1]] === 2) continue;
      live.push(p);
    }
    if (live.length === 0) return false;
    // For each cell in region: if in every live candidate → black; if in none → white.
    // Build per-cell membership count.
    const counts = new Map();
    for (const p of live) {
      counts.set(p[0], (counts.get(p[0]) || 0) + 1);
      counts.set(p[1], (counts.get(p[1]) || 0) + 1);
    }
    for (let i = 0; i < cells.length; i++) {
      const ci = cells[i];
      if (this.cellStatus[ci] !== 0) continue;
      const c = counts.get(ci) || 0;
      if (c === 0) {
        if (!this._set(ci, 2)) return false;
      } else if (c === live.length) {
        if (!this._set(ci, 1)) return false;
      }
    }
  }
  return true;
}
```

- [ ] **Step 4: Verify 15 passing.**

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(norinori): rule 1 — per-region domino propagation"
```

---

## Task 4: Cross-region dominate propagation (Rule 2)

**Files:** `solver.js`, `tests/norinori.test.js` (append).

For each unknown cell, check if every live domino candidate in any adjacent region forces a black adjacent to this cell. If yes, the cell must be white.

- [ ] **Step 1: Failing test — append:**

```js
test('NorinoriSolver._applyCrossRegionDominate: cell adjacent to a region with one candidate that touches it → forced white', () => {
  // 1x4 grid. Region 0 = (0,0)(0,1) (only candidate: [0,1]).
  // Region 1 = (0,2)(0,3). The cell (0,2) is adjacent to (0,1) (which
  // will be in region 0's only candidate). So (0,2) must be white.
  const s = new NorinoriSolver({
    rows: 1, cols: 4,
    rooms: [
      { cells: [{r: 0, c: 0}, {r: 0, c: 1}] },
      { cells: [{r: 0, c: 2}, {r: 0, c: 3}] },
    ],
  });
  // _applyCrossRegionDominate should not (alone) force whites in this
  // specific case until region 0 is narrowed. But via _applyDominoes
  // region 0's nB=0 with single candidate forces (0,0) and (0,1) black,
  // which via _set cross-region cascade forces (0,2) white. Test the
  // cross-region dominate rule with a multi-candidate region instead.

  // Setup: region 0 = (0,0)(0,1)(0,2) → candidates: (0,0)-(0,1), (0,1)-(0,2).
  // Every candidate touches (0,1). External cell (1,1) in another region
  // is adjacent to (0,1). Since (0,1) is in every region-0 candidate, it
  // will be forced black eventually (via _applyDominoes' intersection
  // rule), which then forces (1,1) white via _set cascade.

  // For an isolated _applyCrossRegionDominate test, set up a case where
  // intersection-rule on region A doesn't force any cell, but every
  // live candidate's cells are adjacent to a cell C in region B.
  const s2 = new NorinoriSolver({
    rows: 2, cols: 3,
    rooms: [
      { cells: [{r: 0, c: 0}, {r: 0, c: 1}, {r: 0, c: 2}] }, // top row
      { cells: [{r: 1, c: 0}, {r: 1, c: 1}, {r: 1, c: 2}] }, // bottom row
    ],
  });
  // Region 0 candidates: (0,0)-(0,1), (0,1)-(0,2). Every candidate
  // touches (0,1) or (0,2) → not every candidate touches a single cell
  // of region 1.
  // Cell (1,0) in region 1 is adjacent to (0,0) which is in candidate 1.
  // Cell (1,1) is adjacent to (0,1) (in both candidates) → if every
  // candidate has (0,1), then (1,1) must be white. Both candidates DO
  // contain (0,1), so (1,1) is forced white.
  assert.equal(s2._applyCrossRegionDominate(), true);
  // (1,1) should be forced white because both region-0 candidates contain
  // (0,1) which is 4-adjacent to (1,1).
  assert.equal(s2.cellStatus[4], 2);
});
```

- [ ] **Step 2: Verify failure (`_applyCrossRegionDominate` undefined).**

- [ ] **Step 3: Implement — inside `NorinoriSolver`:**

```js
_applyCrossRegionDominate() {
  // Precompute live candidates per region (filter out pairs with a white cell).
  const liveCands = new Array(this.K);
  for (let k = 0; k < this.K; k++) {
    const cands = this.dominoCandidates[k];
    const live = [];
    for (let i = 0; i < cands.length; i++) {
      const p = cands[i];
      if (this.cellStatus[p[0]] === 2) continue;
      if (this.cellStatus[p[1]] === 2) continue;
      live.push(p);
    }
    liveCands[k] = live;
  }
  const total = this.rows * this.cols;
  for (let idx = 0; idx < total; idx++) {
    if (this.cellStatus[idx] !== 0) continue;
    const r = (idx / this.cols) | 0;
    const c = idx - r * this.cols;
    const ownRoom = this.cellToRoom[idx];
    // Group adjacent cross-region neighbours by their region.
    const adjByRoom = new Map(); // roomId → Set<cellIdx>
    const ns = [];
    if (r > 0) ns.push(idx - this.cols);
    if (r < this.rows - 1) ns.push(idx + this.cols);
    if (c > 0) ns.push(idx - 1);
    if (c < this.cols - 1) ns.push(idx + 1);
    for (let i = 0; i < ns.length; i++) {
      const ni = ns[i];
      const nr = this.cellToRoom[ni];
      if (nr === ownRoom || nr < 0) continue;
      let set = adjByRoom.get(nr);
      if (!set) { set = new Set(); adjByRoom.set(nr, set); }
      set.add(ni);
    }
    // For each adjacent region: if every live candidate of that region
    // includes at least one cell in the adjacency set → idx must be white.
    for (const [yRoom, adjSet] of adjByRoom) {
      const live = liveCands[yRoom];
      if (live.length === 0) continue;
      let allTouch = true;
      for (let i = 0; i < live.length; i++) {
        const p = live[i];
        if (!adjSet.has(p[0]) && !adjSet.has(p[1])) {
          allTouch = false;
          break;
        }
      }
      if (allTouch) {
        if (!this._set(idx, 2)) return false;
        break;
      }
    }
  }
  return true;
}
```

- [ ] **Step 4: Verify 16 passing.**

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(norinori): rule 2 — cross-region dominate propagation"
```

---

## Task 5: Propagate orchestrator + lookahead

**Files:** `solver.js`, `tests/norinori.test.js` (append).

- [ ] **Step 1: Failing tests — append:**

```js
test('NorinoriSolver._propagate: cascades dominoes + cross-region', () => {
  // 1x4 with two 2-cell regions. Region 0 = (0,0)(0,1). Only candidate:
  // (0,0)-(0,1) → both forced black. Then via _set cross-region cascade,
  // (0,2) (in region 1) is forced white. Then region 1 has nB=0, nU=1
  // → 0 candidates → contradiction? No wait, region 1 has 2 cells (0,2)
  // and (0,3); if (0,2) is white, then region 1's only candidate is
  // (0,2)-(0,3) which is no longer live → 0 live candidates → contradiction.
  // Indeed an inconsistent puzzle.
  const s = new NorinoriSolver({
    rows: 1, cols: 4,
    rooms: [
      { cells: [{r: 0, c: 0}, {r: 0, c: 1}] },
      { cells: [{r: 0, c: 2}, {r: 0, c: 3}] },
    ],
  });
  assert.equal(s._propagate(), false);
});

test('NorinoriSolver._propagate: returns true on consistent input', () => {
  // 2x2 split into two 2-cell regions diagonally:
  // Region 0 = (0,0)(0,1), Region 1 = (1,0)(1,1).
  // Both regions need dominoes. Top region forces (0,0)(0,1) black.
  // Bottom region: (1,0) adjacent to (0,0) (black, cross-region) — forced white.
  // (1,1) adjacent to (0,1) (black, cross-region) — forced white.
  // Bottom region has 0 live candidates → contradiction.
  // So this is unsolvable. Try a 2x3 layout that IS solvable.

  // 1x4 with region 0 = (0,0)(0,1)(0,2), region 1 = (0,3). Region 1 has
  // 1 cell, impossible. Skip.

  // 2x2 with region 0 = (0,0)(0,1)(1,1), region 1 = (1,0).
  // Region 1 has 1 cell — impossible.

  // 2x4: region 0 = (0,0)(0,1), region 1 = (0,2)(0,3),
  //      region 2 = (1,0)(1,1), region 3 = (1,2)(1,3).
  // Region 0 dom = (0,0)-(0,1). Cross-region: (1,0) and (1,1) forced white.
  // → region 2 dom impossible → contradiction.

  // Hard to find a tiny consistent puzzle. Just test with the recon 6x6
  // (deferred to integration test). Inline an unconstrained test:
  // 1x2 single region — solvable.
  const s = new NorinoriSolver({
    rows: 1, cols: 2,
    rooms: [{cells: [{r: 0, c: 0}, {r: 0, c: 1}]}],
  });
  assert.equal(s._propagate(), true);
});
```

- [ ] **Step 2: Verify failure (`_propagate` undefined).**

- [ ] **Step 3: Implement — inside `NorinoriSolver`:**

```js
_propagate() {
  let changed = true;
  while (changed) {
    if (this._timeUp()) return true;
    changed = false;
    const mark = this.trail.length;
    if (!this._applyDominoes()) return false;
    if (!this._applyCrossRegionDominate()) return false;
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

- [ ] **Step 4: Verify 18 passing.**

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(norinori): _propagate orchestrator + top-level lookahead"
```

---

## Task 6: solve + backtracking + caches + computePuzzleDiff arm

**Files:** `solver.js`, `tests/norinori.test.js` (append).

- [ ] **Step 1: Failing tests — append:**

```js
test('NorinoriSolver.solve: solves the recon 6x6', () => {
  NorinoriSolver.clearSolutionCache();
  const areas = [
    [0,0,1,1,1,2],
    [0,0,0,1,2,2],
    [3,0,0,4,4,2],
    [3,0,0,5,6,6],
    [3,3,0,5,6,6],
    [7,7,5,5,5,6],
  ];
  const cellsByRoom = {};
  for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) {
    const k = areas[r][c];
    if (!cellsByRoom[k]) cellsByRoom[k] = [];
    cellsByRoom[k].push({r, c});
  }
  const rooms = Object.keys(cellsByRoom).sort((a, b) => +a - +b)
    .map(k => ({cells: cellsByRoom[k]}));
  const s = new NorinoriSolver({rows: 6, cols: 6, rooms, maxMs: 5000});
  const r = s.solve();
  assert.equal(r.solved, true);
  // Validate: each region has exactly 2 black cells that are adjacent.
  for (const room of rooms) {
    const blacks = [];
    for (const cell of room.cells) {
      if (r.grid[cell.r][cell.c] === 1) blacks.push(cell);
    }
    assert.equal(blacks.length, 2);
    const dr = Math.abs(blacks[0].r - blacks[1].r);
    const dc = Math.abs(blacks[0].c - blacks[1].c);
    assert.equal(dr + dc, 1);
  }
});

test('NorinoriSolver.solve: unsat returns {solved:false, grid:null}', () => {
  NorinoriSolver.clearSolutionCache();
  const s = new NorinoriSolver({
    rows: 1, cols: 1,
    rooms: [{cells: [{r: 0, c: 0}]}],
  });
  const r = s.solve();
  assert.equal(r.solved, false);
  assert.equal(r.grid, null);
});

test('NorinoriSolver._solutionCache: cache hit returns deep copy', () => {
  NorinoriSolver.clearSolutionCache();
  const opts = {
    rows: 1, cols: 2,
    rooms: [{cells: [{r: 0, c: 0}, {r: 0, c: 1}]}],
  };
  const a = new NorinoriSolver(opts).solve();
  a.grid[0][0] = 99;
  const b = new NorinoriSolver(opts).solve();
  assert.notEqual(b.grid[0][0], 99);
});

test('computePuzzleDiff norinori: flags wrong-color cells, ignores unknown', () => {
  const { computePuzzleDiff } = require('../solver.js');
  const solution = [[1, 2], [2, 1]];
  const board = [[2, 2], [0, 1]];
  const diff = computePuzzleDiff('norinori', board, solution);
  assert.equal(diff.length, 1);
  assert.deepEqual(diff[0], { row: 0, col: 0, expected: 1, actual: 2 });
});
```

- [ ] **Step 2: Verify failure.**

- [ ] **Step 3: Implement — inside `NorinoriSolver`:**

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
  // Most-constrained: cells whose region has the fewest live candidates.
  let bestIdx = -1, bestScore = Infinity;
  const total = this.rows * this.cols;
  for (let i = 0; i < total; i++) {
    if (this.cellStatus[i] !== 0) continue;
    const k = this.cellToRoom[i];
    const cands = this.dominoCandidates[k];
    let live = 0;
    for (let j = 0; j < cands.length; j++) {
      if (this.cellStatus[cands[j][0]] === 2) continue;
      if (this.cellStatus[cands[j][1]] === 2) continue;
      live++;
    }
    if (live < bestScore) { bestScore = live; bestIdx = i; }
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
  const cached = NorinoriSolver._solutionCache.get(key)
              || NorinoriSolver._partialCache.get(key);
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

Static fields + helpers at the BOTTOM of `NorinoriSolver`:

```js
static _solutionCache = new Map();
static _maxSolutionCache = 50;
static _partialCache = new Map();
static _maxPartialCache = 20;
static clearSolutionCache() {
  NorinoriSolver._solutionCache.clear();
  NorinoriSolver._partialCache.clear();
}

_cacheKey() {
  let h = 0x811c9dc5;
  const mix = (n) => { h ^= n & 0xff; h = Math.imul(h, 0x01000193) >>> 0; };
  mix(this.rows); mix(this.cols); mix(this.K);
  for (let i = 0; i < this.rows * this.cols; i++) mix(this.cellToRoom[i]);
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
  const m = result.partial ? NorinoriSolver._partialCache : NorinoriSolver._solutionCache;
  const max = result.partial ? NorinoriSolver._maxPartialCache : NorinoriSolver._maxSolutionCache;
  if (m.size >= max) {
    const first = m.keys().next().value;
    m.delete(first);
  }
  m.set(key, this._cloneResult(result));
}
```

Extend `computePuzzleDiff` — find the existing `'mosaic' ||` arm and add `|| type === 'norinori'`.

- [ ] **Step 4: Verify 22 passing.**

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(norinori): solve() with MC backtracking + caches + computePuzzleDiff arm"
```

---

## Task 7: Stepwise getHint

**Files:** `solver.js`, `tests/norinori.test.js` (append).

- [ ] **Step 1: Failing tests — append:**

```js
test('NorinoriSolver.getHint: 1x2 single region yields immediate blacks', () => {
  NorinoriSolver.clearSolutionCache();
  const s = new NorinoriSolver({
    rows: 1, cols: 2,
    rooms: [{cells: [{r: 0, c: 0}, {r: 0, c: 1}]}],
  });
  const hint = s.getHint([[0, 0]]);
  assert.ok(Array.isArray(hint));
  assert.ok(hint.length === 2);
  for (const h of hint) assert.equal(h.value, 1);
});

test('NorinoriSolver.getHint: null on solved board', () => {
  NorinoriSolver.clearSolutionCache();
  const s = new NorinoriSolver({
    rows: 1, cols: 2,
    rooms: [{cells: [{r: 0, c: 0}, {r: 0, c: 1}]}],
  });
  assert.equal(s.getHint([[1, 1]]), null);
});
```

- [ ] **Step 2: Verify failure.**

- [ ] **Step 3: Implement — inside `NorinoriSolver`:**

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

  // Run dominoes + cross-region once. Return at first batch.
  if (!this._applyDominoes()) return null;
  {
    const h = collectChanged();
    if (h.length) return h;
  }
  if (!this._applyCrossRegionDominate()) return null;
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

- [ ] **Step 4: Verify 24 passing.**

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(norinori): stepwise getHint"
```

---

## Task 8: Fuzz soundness test

**Files:** Create `tests/norinori-fuzz.test.js`.

Generate random rectangular region partition, place random domino per region (respecting cross-region adjacency), then verify solver recovers a solution satisfying both rules.

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { NorinoriSolver } = require('../solver.js');

function generateRectangularRooms(rows, cols, seed) {
  let rng = seed >>> 0;
  const rand = () => {
    rng = (rng * 1103515245 + 12345) >>> 0;
    return rng / 0x100000000;
  };
  const grid = Array.from({ length: rows }, () => new Array(cols).fill(-1));
  const rooms = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (grid[r][c] !== -1) continue;
      let maxW = 1;
      while (c + maxW < cols && grid[r][c + maxW] === -1) maxW++;
      const w = 2 + Math.floor(rand() * Math.max(1, maxW - 1));  // min width 2 for domino feasibility
      const finalW = Math.min(w, maxW);
      let maxH = 1;
      outer: while (r + maxH < rows) {
        for (let cc = c; cc < c + finalW; cc++) {
          if (grid[r + maxH][cc] !== -1) break outer;
        }
        maxH++;
      }
      const h = 1 + Math.floor(rand() * maxH);
      const id = rooms.length;
      const cells = [];
      for (let rr = r; rr < r + h; rr++) {
        for (let cc = c; cc < c + finalW; cc++) {
          grid[rr][cc] = id;
          cells.push({r: rr, c: cc});
        }
      }
      rooms.push({cells});
    }
  }
  return { rooms, areas: grid };
}

function validate(rows, cols, rooms, areas, grid) {
  // Rule 1: each region has exactly 2 black cells that are adjacent.
  for (const room of rooms) {
    const blacks = [];
    for (const cell of room.cells) {
      if (grid[cell.r][cell.c] === 1) blacks.push(cell);
    }
    if (blacks.length !== 2) return `rule 1 count: region has ${blacks.length} blacks`;
    const dr = Math.abs(blacks[0].r - blacks[1].r);
    const dc = Math.abs(blacks[0].c - blacks[1].c);
    if (dr + dc !== 1) return `rule 1 domino: blacks not adjacent`;
  }
  // Rule 2: no two cross-region blacks adjacent.
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (grid[r][c] !== 1) continue;
    for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      if (grid[nr][nc] !== 1) continue;
      if (areas[r][c] !== areas[nr][nc]) {
        return `rule 2: cross-region blacks at (${r},${c})-(${nr},${nc})`;
      }
    }
  }
  return null;
}

test('NorinoriSolver fuzz: solved boards satisfy both rules', () => {
  NorinoriSolver.clearSolutionCache();
  let solved = 0;
  for (let seed = 1; seed <= 30; seed++) {
    NorinoriSolver.clearSolutionCache();
    const rows = 4 + (seed % 3);
    const cols = 4 + ((seed >> 2) % 3);
    const { rooms, areas } = generateRectangularRooms(rows, cols, seed * 9173 + 1);
    const s = new NorinoriSolver({ rows, cols, rooms, maxMs: 3000 });
    const r = s.solve();
    if (!r.solved) continue;
    const err = validate(rows, cols, rooms, areas, r.grid);
    assert.equal(err, null, `seed=${seed} ${rows}x${cols}: ${err}`);
    solved++;
  }
  assert.ok(solved >= 5, `expected ≥ 5 solved boards, got ${solved}`);
});
```

- [ ] **Step 1: Run, expect PASS. Commit:**

```bash
jj commit -m "test(norinori): fuzz suite for 2-rule soundness"
```

---

## Task 9: Fixtures + golden + integration test

**Files:** `tests/fixtures/puzzles.js`, `tests/golden.js`, `tests/solver.test.js`.

The recon's `areas`:
```
[0,0,1,1,1,2]
[0,0,0,1,2,2]
[3,0,0,4,4,2]
[3,0,0,5,6,6]
[3,3,0,5,6,6]
[7,7,5,5,5,6]
```

8 regions (0..7). Cells listed in `areaPoints` of the recon.

- [ ] **Step 1: Add fixture** — `tests/fixtures/puzzles.js`:

```js
exports.norinori6x6Normal = {
  type: 'norinori',
  rows: 6,
  cols: 6,
  areas: [
    [0,0,1,1,1,2],
    [0,0,0,1,2,2],
    [3,0,0,4,4,2],
    [3,0,0,5,6,6],
    [3,3,0,5,6,6],
    [7,7,5,5,5,6],
  ],
};
```

- [ ] **Step 2: Capture golden** — run:

```bash
node -e "
const { NorinoriSolver } = require('./solver.js');
const f = require('./tests/fixtures/puzzles.js').norinori6x6Normal;
const cellsByRoom = {};
for (let r = 0; r < f.rows; r++) for (let c = 0; c < f.cols; c++) {
  const k = f.areas[r][c];
  if (!cellsByRoom[k]) cellsByRoom[k] = [];
  cellsByRoom[k].push({r, c});
}
const rooms = Object.keys(cellsByRoom).sort((a,b) => +a - +b).map(k => ({cells: cellsByRoom[k]}));
const s = new NorinoriSolver({rows: f.rows, cols: f.cols, rooms});
const r = s.solve();
if (!r.solved) { console.error('NO SOLUTION'); process.exit(1); }
console.log(JSON.stringify(r.grid));
"
```

Paste into `tests/golden.js`:

```js
exports.norinori6x6Normal = <pasted-2D-array>;
```

- [ ] **Step 3: Add helper to `tests/solver.test.js` (near top)** if not already present:

```js
function norinoriRoomsFromFixture(fixture) {
  const cellsByRoom = {};
  for (let r = 0; r < fixture.rows; r++) {
    for (let c = 0; c < fixture.cols; c++) {
      const k = fixture.areas[r][c];
      if (!cellsByRoom[k]) cellsByRoom[k] = [];
      cellsByRoom[k].push({r, c});
    }
  }
  return Object.keys(cellsByRoom).sort((a, b) => +a - +b)
    .map(k => ({cells: cellsByRoom[k]}));
}
```

- [ ] **Step 4: Add integration test** (append to solver.test.js):

```js
test('NorinoriSolver: norinori6x6Normal fixture matches golden', () => {
  const { NorinoriSolver } = require('../solver.js');
  const fixture = require('./fixtures/puzzles.js').norinori6x6Normal;
  NorinoriSolver.clearSolutionCache();
  const s = new NorinoriSolver({
    rows: fixture.rows,
    cols: fixture.cols,
    rooms: norinoriRoomsFromFixture(fixture),
  });
  const r = s.solve();
  assert.equal(r.solved, true);
  assert.deepEqual(r.grid, require('./golden.js').norinori6x6Normal);
});
```

- [ ] **Step 5: `npm test` clean, commit:**

```bash
jj commit -m "test(norinori): puzzles.js fixture + golden snapshot + integration test"
```

---

## Task 10: MAIN-world fns + allowlist + globals.d.ts + eslint

**Files:** `main-world.js`, `background.js`, `globals.d.ts`, `eslint.config.js`.

- [ ] **Step 1: Add `readNorinoriData`** — mirrors `readHeyawakeData`:

```js
function readNorinoriData() {
  try {
    var G = window.Game;
    if (!G || !G.areas || !G.areaPoints) return null;
    if (!G.puzzleWidth || !G.puzzleHeight) return null;
    var rows = G.puzzleHeight, cols = G.puzzleWidth;
    var areas = [];
    for (var r = 0; r < rows; r++) {
      var row = G.areas[r] || [];
      var arr = new Array(cols);
      for (var c = 0; c < cols; c++) arr[c] = row[c] || 0;
      areas.push(arr);
    }
    var rooms = [];
    for (var k = 0; k < G.areaPoints.length; k++) {
      var pts = G.areaPoints[k] || [];
      var cells = [];
      for (var i = 0; i < pts.length; i++) {
        cells.push({r: pts[i].row, c: pts[i].col});
      }
      rooms.push({cells: cells});
    }
    return { rows: rows, cols: cols, areas: areas, rooms: rooms };
  } catch (e) {
    return null;
  }
}
```

- [ ] **Step 2: Add `readNorinoriState` + `applyNorinoriState`** — standard cellStatus shape (no clue-cell skip):

```js
function readNorinoriState(rows, cols) {
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

function applyNorinoriState(grid) {
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
    console.warn('Norinori apply failed:', e);
    return false;
  }
}
```

- [ ] **Step 3: background.js EXEC_MAIN_ALLOWLIST** — add 3 entries.

- [ ] **Step 4: globals.d.ts** — add 3 to `MainWorldFn` + `declare const NorinoriSolver: any;`.

- [ ] **Step 5: eslint.config.js** — add `NorinoriSolver` to solverClasses.

- [ ] **Step 6: Verify `npm run lint && npm run typecheck && npm test`.**

- [ ] **Step 7: Commit**

```bash
jj commit -m "feat(norinori): MAIN-world read/apply fns + allowlist + globals.d.ts"
```

---

## Task 11: Worker arm + handler

**Files:** `solver.worker.js`, `handler.js`.

- [ ] **Step 1: Worker arm — add `NorinoriSolver` to `/* global */`, then arm before final `else`:**

```js
} else if (type === 'norinori' && extraData) {
  const s = new NorinoriSolver({
    rows: extraData.rows,
    cols: extraData.cols,
    rooms: extraData.rooms,
    initialState: initialGrid || null,
    maxMs: 30000,
  });
  result = s.solve();
}
```

- [ ] **Step 2: Handler — after mosaicHandler:**

```js
const norinoriHandler = {
  name: 'puzzles-mobile-norinori',
  priority: 30,
  matches() {
    return isPuzzlesMobilePage() && window.location.pathname.includes('/norinori/');
  },
  async detect() {
    const result = { found: false, rows: 0, cols: 0, rowClues: [], colClues: [] };
    const data = await callMainWorld('readNorinoriData', []);
    if (!data) return { ...result, error: 'No Norinori task data found' };
    const stageEl = document.getElementById('stage') ||
                    document.getElementById('game') ||
                    document.querySelector('[class*="game"], [class*="puzzle"]');
    return {
      found: true,
      type: 'norinori',
      rows: data.rows,
      cols: data.cols,
      areas: data.areas,
      rooms: data.rooms,
      rowClues: [], colClues: [],
      _cells: [],
      _element: stageEl,
    };
  },
  async readState(ctx) {
    const state = await callMainWorld('readNorinoriState', [ctx.rows, ctx.cols]);
    if (state) return state;
    return Array.from({ length: ctx.rows }, () => new Array(ctx.cols).fill(0));
  },
  async applySolution(solution, _ctx) {
    const ok = await callMainWorld('applyNorinoriState', [solution]);
    return ok ? { success: true } : { success: false, error: 'Norinori apply failed' };
  },
};

registerHandler(norinoriHandler);
```

- [ ] **Step 3: Verify, commit:**

```bash
jj commit -m "feat(norinori): worker dispatch arm + handler registration"
```

---

## Task 12: Dump + real fixture + bench-real

**Files:** `main-world.js`, `tests/fixtures/real-puzzles.js`, `tests/bench-real.js`.

- [ ] **Step 1: Inline dump arm in main-world.js `dumpPuzzleForBench`:**

```js
if (path.indexOf('/norinori/') !== -1 || g.slug === 'norinori') {
  if (!g.areas || !g.areaPoints || !g.puzzleWidth || !g.puzzleHeight) {
    return { error: 'norinori: missing areas/areaPoints/dims', diagnostic: diagnostic(g), path: path };
  }
  var nnRows = g.puzzleHeight, nnCols = g.puzzleWidth;
  var nnAreas = [];
  for (var nnr = 0; nnr < nnRows; nnr++) {
    var srcRow = g.areas[nnr] || [];
    var dstRow = new Array(nnCols);
    for (var nnc = 0; nnc < nnCols; nnc++) dstRow[nnc] = srcRow[nnc] || 0;
    nnAreas.push(dstRow);
  }
  return { type: 'norinori', rows: nnRows, cols: nnCols, areas: nnAreas, path: path };
}
```

- [ ] **Step 2: Real fixture in real-puzzles.js:**

```js
exports.norinori6x6NormalReal = {
  type: 'norinori',
  rows: 6,
  cols: 6,
  areas: [
    [0,0,1,1,1,2],
    [0,0,0,1,2,2],
    [3,0,0,4,4,2],
    [3,0,0,5,6,6],
    [3,3,0,5,6,6],
    [7,7,5,5,5,6],
  ],
};
```

- [ ] **Step 3: bench-real.js arm** — mirror the heyawake arm (with `areas → rooms` conversion):

```js
if (p.type === 'norinori') {
  const cellsByRoom = {};
  for (let r = 0; r < p.rows; r++) for (let c = 0; c < p.cols; c++) {
    const k = p.areas[r][c];
    if (!cellsByRoom[k]) cellsByRoom[k] = [];
    cellsByRoom[k].push({r, c});
  }
  const rooms = Object.keys(cellsByRoom).sort((a,b) => +a - +b).map(k => ({cells: cellsByRoom[k]}));
  return new NorinoriSolver({rows: p.rows, cols: p.cols, rooms});
}
```

Add `NorinoriSolver` import and `clearSolutionCache()` calls in warmup/iter loops.

- [ ] **Step 4: Verify `node tests/bench-real.js`, then `npm test`. Commit:**

```bash
jj commit -m "feat(norinori): dumpPuzzleForBench arm + real fixture + bench-real arm"
```

---

## Task 13: bench-norinori + CI

**Files:** Create `tests/bench-norinori.js`, modify `.github/workflows/bench-nightly.yml`.

- [ ] **Step 1:**

```js
'use strict';
const { NorinoriSolver } = require('../solver.js');
const fixture = require('./fixtures/real-puzzles.js').norinori6x6NormalReal;

function buildRooms(f) {
  const cellsByRoom = {};
  for (let r = 0; r < f.rows; r++) for (let c = 0; c < f.cols; c++) {
    const k = f.areas[r][c];
    if (!cellsByRoom[k]) cellsByRoom[k] = [];
    cellsByRoom[k].push({r, c});
  }
  return Object.keys(cellsByRoom).sort((a,b) => +a - +b).map(k => ({cells: cellsByRoom[k]}));
}

const ITERATIONS = 5;
const WARMUP = 2;
const times = [];
for (let i = 0; i < WARMUP + ITERATIONS; i++) {
  NorinoriSolver.clearSolutionCache();
  const s = new NorinoriSolver({
    rows: fixture.rows,
    cols: fixture.cols,
    rooms: buildRooms(fixture),
  });
  const t0 = process.hrtime.bigint();
  const r = s.solve();
  const t1 = process.hrtime.bigint();
  if (!r.solved) { console.error('norinori6x6NormalReal failed to solve'); process.exit(1); }
  if (i >= WARMUP) times.push(Number(t1 - t0) / 1e6);
}
times.sort((a, b) => a - b);
console.log(`norinori6x6NormalReal: median ${times[Math.floor(times.length / 2)].toFixed(2)} ms over ${ITERATIONS} runs`);
```

- [ ] **Step 2: CI step in `.github/workflows/bench-nightly.yml`:**

```yaml
      - name: Bench Norinori
        run: node tests/bench-norinori.js
```

- [ ] **Step 3: Commit:**

```bash
jj commit -m "ci(norinori): bench script + nightly workflow step"
```

---

## Task 14: content.js bookkeeping

**Files:** `content.js`.

- [ ] **Step 1: SUPPORTED_PUZZLES — insert alphabetically (between Mosaic and Nonogram):**

```js
  { name: 'Norinori',     url: 'https://www.puzzles-mobile.com/norinori/' },
```

- [ ] **Step 2: SOLUTION_KEY_PREFIXES — add `'norinori-solution:'`.**

- [ ] **Step 3: norinoriCacheKey — after mosaicCacheKey:**

```js
function norinoriCacheKey(data) {
  if (data?.type !== 'norinori' || !data.areas) return null;
  let h = 0x811c9dc5;
  const mix = (n) => { h ^= n & 0xff; h = Math.imul(h, 0x01000193) >>> 0; };
  mix(0x4E); // 'N' nameplate
  mix(data.rows); mix(data.cols);
  for (const row of data.areas) for (const v of row) mix(v + 1);
  return 'norinori-solution:' + (h >>> 0).toString(16);
}
```

Wire alongside mosaicCacheKey at both ternary dispatch sites.

- [ ] **Step 4: solveExtraData arm:**

```js
if (data.type === 'norinori') {
  return { rows: data.rows, cols: data.cols, rooms: data.rooms };
}
```

- [ ] **Step 5: norinoriAreasSig + staticSig segment — after mosaicTaskSig:**

```js
function norinoriAreasSig(areas) {
  if (!areas) return '0';
  let h = 0x811c9dc5;
  for (const row of areas) for (const v of row) {
    h ^= (v + 1) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16);
}
```

In `staticSig`, append `'|nn=' + norinoriAreasSig(pd?.type === 'norinori' ? pd.areas : null)`.

- [ ] **Step 6: pendingAutoSolve gate** — extend `skipAutoSolveGate` to include norinori.

- [ ] **Step 7: drawPreview rect-bail** — add `|| pd?.type === 'norinori'`.

- [ ] **Step 8: Verify, commit:**

```bash
jj commit -m "feat(norinori): content.js bookkeeping (SUPPORTED_PUZZLES, prefix, cache key, sig, gate)"
```

---

## Task 15: drawPreview arm

**Files:** `content.js`.

Render the grid with region borders (cloned from Heyawake's pattern, keyed off `|nn=` sig) + black fills + cross marks.

- [ ] **Step 1: Read Heyawake's drawPreview arm for reference** (search for `pd?.type === 'heyawake'`).

- [ ] **Step 2: Add `isNorinori` flag and per-cell render arm** — black cell = solid dark fill; cross = small X; unknown = blank. Region borders on the static layer via `drawHeyawakeRoomsOn`-style code (or call the same helper if it doesn't depend on heyawake-specific rooms/targets — the room-borders-only variant works for norinori too if we pass `rooms = null` to skip clue numbers).

Use this reference structure (adapt variable names to match the file):

```js
} else if (isNorinori) {
  if (v === 1) {
    const pad = Math.max(2, Math.floor(cellSize * 0.1));
    ctx.fillStyle = '#1f2937';
    ctx.fillRect(x + pad, y + pad, cellSize - 2*pad, cellSize - 2*pad);
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
}
```

For the static layer's region borders, clone Heyawake's logic — it walks `pd.areas[r][c]` and draws thick borders between cells with different region ids. No clue numbers for norinori (since `rooms[k].target` is always implicitly 2 — don't render).

Mirror the hint overlay arm + band-skip from Heyawake.

- [ ] **Step 3: Loop early-break exclusion** — extend the `hr.hint?.type !== ...` chain to include `'norinori'`.

- [ ] **Step 4: Verify `npm run lint && npm run typecheck && npm test && npm run build`.**

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(norinori): drawPreview arm with region borders + black + cross marks"
```

---

## Task 16: getHint dispatch + status + partial + Loop break

**Files:** `content.js`.

- [ ] **Step 1: getHint dispatch — after mosaic arm:**

```js
} else if (detectedGrid.type === 'norinori') {
  if (solution && firstMismatch(grid, solution)) {
    return { success: false, error: 'Current game state is wrong.' };
  }
  const solver = new NorinoriSolver({
    rows, cols, rooms: detectedGrid.rooms,
  });
  const hintCells = solver.getHint(grid);
  if (!hintCells || hintCells.length === 0) {
    return { success: false, error: 'No more cells can be deduced from the current state. Click Solve to finish.' };
  }
  hint = { type: 'norinori', extraCells: hintCells, count: hintCells.length };
}
```

- [ ] **Step 2: norinoriHintStatusNodes + setHintStatus arm:**

```js
function norinoriHintStatusNodes(h) {
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
} else if (puzzleData?.type === 'norinori') {
  setStatusNodes('info', prefix, ...norinoriHintStatusNodes(h));
}
```

- [ ] **Step 3: solveHandler partial arm:**

```js
if (result?.partial && puzzleData?.type === 'norinori' && Array.isArray(result.grid)) {
  applyGridPartialResult(result);
  return;
}
```

- [ ] **Step 4: Verify, commit:**

```bash
jj commit -m "feat(norinori): content.js getHint dispatch + hintStatusNodes + partial arm"
```

---

## Task 17: Final verification + push

- [ ] **Step 1: Full suite, lint, typecheck, build, bench.**
- [ ] **Step 2: Push** — `jj bookmark set main -r @-` then `jj git push --bookmark main`.

End of plan.
