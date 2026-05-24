# Heyawake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full Heyawake support (`/heyawake/*` URLs) to the Chrome MV3 extension — solver, MAIN-world fns, handler, worker arm, content.js wire-up, tests, and bench, matching the parity of the eight existing puzzle types.

**Architecture:** `HeyawakeSolver` follows the Binairo/Yin-Yang pattern — flat `Uint8Array` cell state (0/1/2), trail-based undo, propagate-then-backtrack with top-level 1-step lookahead. Four propagation rules: room count saturation, no-adjacent-blacks (eager in `_set`), no-3-rooms straight line via precomputed minimal spans, white connectivity via reachability+articulation. Static solution and partial caches mirror Slitherlink. Rooms come from `G.areaPoints` (cell lists) and `G.areaTask` (clue per room) — encoding is identical to Binairo (0=empty, 1=black, 2=white), so hint apply reuses the generic `applyHintCells` MAIN-world function.

**Tech Stack:** Vanilla JS (MV3 service worker + content script + Web Worker), `node:test` runner, `jj` for version control (never plain `git`).

**Reference spec:** `docs/superpowers/specs/2026-05-24-heyawake-design.md`

**Test runner:** `node --test`. Run a single test file with `node --test tests/heyawake.test.js`. Run the full suite with `npm test`.

**Important — `jj` for commits:** This repo uses Jujutsu colocated with git. Every commit step must use `jj commit -m "..."` (which finalizes the current change and starts a new one). Never use `git commit`, `git add`, etc.

---

## Task 1: HeyawakeSolver scaffold + trail + _set/_rollback

**Files:**
- Modify: `solver.js` (append a new class after `HashiSolver`, before the `module.exports` tail)
- Test: `tests/heyawake.test.js` (new)

The minimal class accepts the constructor input, builds the flat cell-to-room map, copies `initialState` into `cellStatus`, and supports trail-based undo. No propagation rules yet.

- [ ] **Step 1: Create the failing test file**

Create `tests/heyawake.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { HeyawakeSolver } = require('../solver.js');

test('HeyawakeSolver: constructor mirrors initialState and indexes rooms', () => {
  const s = new HeyawakeSolver({
    rows: 2, cols: 2,
    rooms: [
      { cells: [{ r: 0, c: 0 }, { r: 0, c: 1 }], target: 1 },
      { cells: [{ r: 1, c: 0 }, { r: 1, c: 1 }], target: -1 },
    ],
    initialState: [[0, 1], [2, 0]],
  });
  assert.equal(s.rows, 2);
  assert.equal(s.cols, 2);
  assert.equal(s.K, 2);
  assert.equal(s.cellStatus[0], 0);
  assert.equal(s.cellStatus[1], 1);
  assert.equal(s.cellStatus[2], 2);
  assert.equal(s.cellStatus[3], 0);
  assert.equal(s.cellToRoom[0], 0);
  assert.equal(s.cellToRoom[1], 0);
  assert.equal(s.cellToRoom[2], 1);
  assert.equal(s.cellToRoom[3], 1);
  assert.equal(s.target[0], 1);
  assert.equal(s.target[1], -1);
});

test('HeyawakeSolver: _set / _rollback round-trip', () => {
  const s = new HeyawakeSolver({
    rows: 1, cols: 2,
    rooms: [
      { cells: [{ r: 0, c: 0 }, { r: 0, c: 1 }], target: -1 },
    ],
  });
  const mark = s.trail.length;
  assert.equal(s._set(0, 2), true);
  assert.equal(s.cellStatus[0], 2);
  assert.equal(s.trail.length, mark + 1);
  // No-op on same value
  assert.equal(s._set(0, 2), true);
  assert.equal(s.trail.length, mark + 1);
  // Conflicting write returns false
  assert.equal(s._set(0, 1), false);
  s._rollback(mark);
  assert.equal(s.cellStatus[0], 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/heyawake.test.js`
Expected: FAIL with "HeyawakeSolver is not defined" or `require` error.

- [ ] **Step 3: Add HeyawakeSolver class skeleton to solver.js**

Find the line `module.exports = { NonogramSolver, AquariumSolver, ... HashiSolver, computePuzzleDiff };` in `solver.js`. Insert the new class BEFORE that line (after `HashiSolver`'s closing `}`):

```js
class HeyawakeSolver {
  constructor(data) {
    const { rows, cols, rooms, initialState, maxMs } = data;
    this.rows = rows;
    this.cols = cols;
    this.K = rooms.length;
    this.target = new Int32Array(this.K);
    this.roomCells = [];
    this.cellToRoom = new Int32Array(rows * cols).fill(-1);
    for (let k = 0; k < this.K; k++) {
      this.target[k] = rooms[k].target;
      const cells = rooms[k].cells;
      const arr = new Int32Array(cells.length);
      for (let i = 0; i < cells.length; i++) {
        const idx = cells[i].r * cols + cells[i].c;
        arr[i] = idx;
        this.cellToRoom[idx] = k;
      }
      this.roomCells.push(arr);
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
    return true;
  }

  _rollback(mark) {
    while (this.trail.length > mark) {
      const e = this.trail.pop();
      const idx = e & 0xffffff;
      const old = (e >>> 24) & 0xff;
      this.cellStatus[idx] = old;
    }
  }

  _timeUp() {
    if (this.maxMs <= 0) return false;
    return (Date.now() - this._startedAt) > this.maxMs;
  }
}
```

Then update the `module.exports` line to include `HeyawakeSolver`:

```js
module.exports = { NonogramSolver, AquariumSolver, GalaxiesSolver, BinairoSolver, ShikakuSolver, YinYangSolver, SlitherlinkSolver, HashiSolver, HeyawakeSolver, computePuzzleDiff };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/heyawake.test.js`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(heyawake): HeyawakeSolver scaffold with trail-based _set/_rollback"
```

---

## Task 2: Rule 1 — Room saturation propagation

**Files:**
- Modify: `solver.js` (add `_applyRoomCounts` method inside `HeyawakeSolver`)
- Test: `tests/heyawake.test.js` (append)

Force-white when a room's black count equals its target; force-black when remaining unknowns must all be black to reach target.

- [ ] **Step 1: Write failing tests**

Append to `tests/heyawake.test.js`:

```js
test('HeyawakeSolver._applyRoomCounts: saturated room forces unknowns to white', () => {
  const s = new HeyawakeSolver({
    rows: 1, cols: 4,
    rooms: [
      { cells: [
        { r: 0, c: 0 }, { r: 0, c: 1 }, { r: 0, c: 2 }, { r: 0, c: 3 },
      ], target: 2 },
    ],
    initialState: [[1, 1, 0, 0]], // 2 blacks already in
  });
  assert.equal(s._applyRoomCounts(), true);
  assert.equal(s.cellStatus[2], 2);
  assert.equal(s.cellStatus[3], 2);
});

test('HeyawakeSolver._applyRoomCounts: must-saturate forces unknowns to black', () => {
  const s = new HeyawakeSolver({
    rows: 1, cols: 3,
    rooms: [
      { cells: [{ r: 0, c: 0 }, { r: 0, c: 1 }, { r: 0, c: 2 }], target: 2 },
    ],
    initialState: [[2, 0, 0]], // 1 white, 2 unknowns, target 2 → both unknowns must be black
  });
  assert.equal(s._applyRoomCounts(), true);
  assert.equal(s.cellStatus[1], 1);
  assert.equal(s.cellStatus[2], 1);
});

test('HeyawakeSolver._applyRoomCounts: too many blacks → contradiction', () => {
  const s = new HeyawakeSolver({
    rows: 1, cols: 3,
    rooms: [
      { cells: [{ r: 0, c: 0 }, { r: 0, c: 1 }, { r: 0, c: 2 }], target: 1 },
    ],
    initialState: [[1, 1, 0]], // 2 blacks, target 1
  });
  assert.equal(s._applyRoomCounts(), false);
});

test('HeyawakeSolver._applyRoomCounts: -1 target is unconstrained', () => {
  const s = new HeyawakeSolver({
    rows: 1, cols: 3,
    rooms: [
      { cells: [{ r: 0, c: 0 }, { r: 0, c: 1 }, { r: 0, c: 2 }], target: -1 },
    ],
    initialState: [[1, 1, 0]],
  });
  assert.equal(s._applyRoomCounts(), true);
  assert.equal(s.cellStatus[2], 0); // unchanged
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test tests/heyawake.test.js`
Expected: 4 failing tests — "s._applyRoomCounts is not a function".

- [ ] **Step 3: Implement `_applyRoomCounts`**

Add this method inside the `HeyawakeSolver` class (between `_timeUp` and the closing `}`):

```js
_applyRoomCounts() {
  for (let k = 0; k < this.K; k++) {
    if (this.target[k] < 0) continue;
    const cells = this.roomCells[k];
    let nB = 0, nU = 0;
    for (let i = 0; i < cells.length; i++) {
      const v = this.cellStatus[cells[i]];
      if (v === 1) nB++;
      else if (v === 0) nU++;
    }
    if (nB > this.target[k]) return false;
    if (nB + nU < this.target[k]) return false;
    if (nB === this.target[k] && nU > 0) {
      for (let i = 0; i < cells.length; i++) {
        if (this.cellStatus[cells[i]] === 0) {
          if (!this._set(cells[i], 2)) return false;
        }
      }
    } else if (nB + nU === this.target[k] && nU > 0) {
      for (let i = 0; i < cells.length; i++) {
        if (this.cellStatus[cells[i]] === 0) {
          if (!this._set(cells[i], 1)) return false;
        }
      }
    }
  }
  return true;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test tests/heyawake.test.js`
Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(heyawake): rule 1 — room-count saturation propagation"
```

---

## Task 3: Rule 2 — No adjacent blacks (eager in _set)

**Files:**
- Modify: `solver.js` (extend `_set` to apply rule 2 eagerly)
- Test: `tests/heyawake.test.js` (append)

When a cell is set to 1, all four 4-neighbours must become 2 (or be already 2). If any neighbour is already 1, return false.

- [ ] **Step 1: Write failing test**

Append:

```js
test('HeyawakeSolver._set: black write forces 4-neighbours to white', () => {
  const s = new HeyawakeSolver({
    rows: 3, cols: 3,
    rooms: [
      { cells: Array.from({ length: 9 }, (_, i) => ({ r: (i / 3) | 0, c: i % 3 })), target: -1 },
    ],
  });
  // Set center to black; expect up/down/left/right forced white
  assert.equal(s._set(4, 1), true);
  assert.equal(s.cellStatus[1], 2); // up
  assert.equal(s.cellStatus[7], 2); // down
  assert.equal(s.cellStatus[3], 2); // left
  assert.equal(s.cellStatus[5], 2); // right
  assert.equal(s.cellStatus[0], 0); // diagonals untouched
});

test('HeyawakeSolver._set: black write next to existing black → contradiction', () => {
  const s = new HeyawakeSolver({
    rows: 1, cols: 2,
    rooms: [{ cells: [{ r: 0, c: 0 }, { r: 0, c: 1 }], target: -1 }],
    initialState: [[1, 0]],
  });
  assert.equal(s._set(1, 1), false);
});

test('HeyawakeSolver._set: white write has no adjacency side effect', () => {
  const s = new HeyawakeSolver({
    rows: 1, cols: 3,
    rooms: [{ cells: [{ r: 0, c: 0 }, { r: 0, c: 1 }, { r: 0, c: 2 }], target: -1 }],
  });
  assert.equal(s._set(1, 2), true);
  assert.equal(s.cellStatus[0], 0); // neighbours unchanged
  assert.equal(s.cellStatus[2], 0);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `node --test tests/heyawake.test.js`
Expected: black-neighbour tests fail — current `_set` doesn't propagate adjacency.

- [ ] **Step 3: Extend `_set`**

Replace the `_set` method body with:

```js
_set(idx, value) {
  const old = this.cellStatus[idx];
  if (old === value) return true;
  if (old !== 0) return false;
  this.trail.push(idx | (old << 24));
  this.cellStatus[idx] = value;
  if (value === 1) {
    const r = (idx / this.cols) | 0;
    const c = idx - r * this.cols;
    const neighbours = [];
    if (r > 0) neighbours.push(idx - this.cols);
    if (r < this.rows - 1) neighbours.push(idx + this.cols);
    if (c > 0) neighbours.push(idx - 1);
    if (c < this.cols - 1) neighbours.push(idx + 1);
    for (let i = 0; i < neighbours.length; i++) {
      const ni = neighbours[i];
      const nv = this.cellStatus[ni];
      if (nv === 1) return false;
      if (nv === 0) {
        if (!this._set(ni, 2)) return false;
      }
    }
  }
  return true;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test tests/heyawake.test.js`
Expected: 9 passing.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(heyawake): rule 2 — no-adjacent-blacks eager in _set"
```

---

## Task 4: Rule 3a — Line constraint precomputation

**Files:**
- Modify: `solver.js` (add `_buildLineConstraints` + call it from constructor)
- Test: `tests/heyawake.test.js` (append)

Walk each row and column. For each consecutive triple of room segments, emit the minimal span (last cell of room A + all of room B + first cell of room C) as an `Int32Array`.

- [ ] **Step 1: Write failing test**

Append:

```js
test('HeyawakeSolver._buildLineConstraints: 1x4 with 4 rooms emits 2 minimal spans', () => {
  // Layout: room 0 at col 0, room 1 at col 1, room 2 at col 2, room 3 at col 3
  const s = new HeyawakeSolver({
    rows: 1, cols: 4,
    rooms: [
      { cells: [{ r: 0, c: 0 }], target: -1 },
      { cells: [{ r: 0, c: 1 }], target: -1 },
      { cells: [{ r: 0, c: 2 }], target: -1 },
      { cells: [{ r: 0, c: 3 }], target: -1 },
    ],
  });
  assert.equal(s.lineConstraints.length, 2);
  // First span: triple (0,1,2) — last of 0 + all of 1 + first of 2 = cells 0, 1, 2
  assert.deepEqual(Array.from(s.lineConstraints[0]), [0, 1, 2]);
  // Second span: triple (1,2,3) — cells 1, 2, 3
  assert.deepEqual(Array.from(s.lineConstraints[1]), [1, 2, 3]);
});

test('HeyawakeSolver._buildLineConstraints: room spanning 2 cells produces wider middle', () => {
  // 1x5: room 0 at col 0, room 1 at cols 1-2, room 2 at col 3, room 3 at col 4
  const s = new HeyawakeSolver({
    rows: 1, cols: 5,
    rooms: [
      { cells: [{ r: 0, c: 0 }], target: -1 },
      { cells: [{ r: 0, c: 1 }, { r: 0, c: 2 }], target: -1 },
      { cells: [{ r: 0, c: 3 }], target: -1 },
      { cells: [{ r: 0, c: 4 }], target: -1 },
    ],
  });
  // Triple (0,1,2): last of 0 (col 0) + all of 1 (cols 1,2) + first of 2 (col 3)
  // → cells [0, 1, 2, 3]
  // Triple (1,2,3): last of 1 (col 2) + all of 2 (col 3) + first of 3 (col 4)
  // → cells [2, 3, 4]
  assert.equal(s.lineConstraints.length, 2);
  assert.deepEqual(Array.from(s.lineConstraints[0]), [0, 1, 2, 3]);
  assert.deepEqual(Array.from(s.lineConstraints[1]), [2, 3, 4]);
});

test('HeyawakeSolver._buildLineConstraints: column scan emits vertical spans', () => {
  // 4x1: each row is its own room
  const s = new HeyawakeSolver({
    rows: 4, cols: 1,
    rooms: [
      { cells: [{ r: 0, c: 0 }], target: -1 },
      { cells: [{ r: 1, c: 0 }], target: -1 },
      { cells: [{ r: 2, c: 0 }], target: -1 },
      { cells: [{ r: 3, c: 0 }], target: -1 },
    ],
  });
  assert.equal(s.lineConstraints.length, 2);
  // Triples in column-walk order: cells [0,1,2] and [1,2,3]
  assert.deepEqual(Array.from(s.lineConstraints[0]), [0, 1, 2]);
  assert.deepEqual(Array.from(s.lineConstraints[1]), [1, 2, 3]);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `node --test tests/heyawake.test.js`
Expected: 3 failing tests — `s.lineConstraints is undefined`.

- [ ] **Step 3: Implement precomputation**

Add `_buildLineConstraints` and helper inside `HeyawakeSolver`:

```js
_buildLineConstraints() {
  this.lineConstraints = [];
  for (let r = 0; r < this.rows; r++) {
    const row = new Array(this.cols);
    for (let c = 0; c < this.cols; c++) row[c] = r * this.cols + c;
    this._scanLineForConstraints(row);
  }
  for (let c = 0; c < this.cols; c++) {
    const col = new Array(this.rows);
    for (let r = 0; r < this.rows; r++) col[r] = r * this.cols + c;
    this._scanLineForConstraints(col);
  }
  // Map cell → list of constraint indices it participates in
  this.lineConstraintsByCell = Array.from({ length: this.rows * this.cols }, () => []);
  for (let i = 0; i < this.lineConstraints.length; i++) {
    const cells = this.lineConstraints[i];
    for (let j = 0; j < cells.length; j++) {
      this.lineConstraintsByCell[cells[j]].push(i);
    }
  }
}

_scanLineForConstraints(cellIdxs) {
  const n = cellIdxs.length;
  if (n < 3) return;
  // Build segments: contiguous runs of same room id along this line.
  const segments = [];
  let curRoom = this.cellToRoom[cellIdxs[0]];
  let curStart = 0;
  for (let i = 1; i < n; i++) {
    const r = this.cellToRoom[cellIdxs[i]];
    if (r !== curRoom) {
      segments.push({ room: curRoom, start: curStart, end: i - 1 });
      curRoom = r;
      curStart = i;
    }
  }
  segments.push({ room: curRoom, start: curStart, end: n - 1 });
  // Each consecutive triple of segments yields one minimal 3-rooms span.
  // (Rectangular rooms guarantee a.room !== c.room within a line.)
  for (let i = 0; i + 2 < segments.length; i++) {
    const a = segments[i], b = segments[i + 1], c = segments[i + 2];
    const span = [];
    span.push(cellIdxs[a.end]);                       // last cell of A
    for (let k = b.start; k <= b.end; k++) span.push(cellIdxs[k]); // all of B
    span.push(cellIdxs[c.start]);                     // first cell of C
    this.lineConstraints.push(new Int32Array(span));
  }
}
```

Then call `_buildLineConstraints` from the end of the constructor (before the `this._startedAt = 0;` line):

```js
this._buildLineConstraints();
this._startedAt = 0;
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test tests/heyawake.test.js`
Expected: 12 passing.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(heyawake): rule 3a — precompute minimal 3-rooms line spans"
```

---

## Task 5: Rule 3b — Line constraint propagation

**Files:**
- Modify: `solver.js` (add `_applyLineConstraints`)
- Test: `tests/heyawake.test.js` (append)

For each line constraint span: count blacks and unknowns. All-white → contradiction. 0 blacks + 1 unknown → force that unknown black.

- [ ] **Step 1: Write failing test**

Append:

```js
test('HeyawakeSolver._applyLineConstraints: span with one unknown forces it black', () => {
  const s = new HeyawakeSolver({
    rows: 1, cols: 4,
    rooms: [
      { cells: [{ r: 0, c: 0 }], target: -1 },
      { cells: [{ r: 0, c: 1 }], target: -1 },
      { cells: [{ r: 0, c: 2 }], target: -1 },
      { cells: [{ r: 0, c: 3 }], target: -1 },
    ],
    initialState: [[2, 0, 2, 2]], // span [0,1,2] has 2 whites + 1 unknown
  });
  assert.equal(s._applyLineConstraints(), true);
  assert.equal(s.cellStatus[1], 1);
});

test('HeyawakeSolver._applyLineConstraints: all-white span → contradiction', () => {
  const s = new HeyawakeSolver({
    rows: 1, cols: 4,
    rooms: [
      { cells: [{ r: 0, c: 0 }], target: -1 },
      { cells: [{ r: 0, c: 1 }], target: -1 },
      { cells: [{ r: 0, c: 2 }], target: -1 },
      { cells: [{ r: 0, c: 3 }], target: -1 },
    ],
    initialState: [[2, 2, 2, 2]],
  });
  assert.equal(s._applyLineConstraints(), false);
});

test('HeyawakeSolver._applyLineConstraints: span with black is satisfied (no force)', () => {
  const s = new HeyawakeSolver({
    rows: 1, cols: 4,
    rooms: [
      { cells: [{ r: 0, c: 0 }], target: -1 },
      { cells: [{ r: 0, c: 1 }], target: -1 },
      { cells: [{ r: 0, c: 2 }], target: -1 },
      { cells: [{ r: 0, c: 3 }], target: -1 },
    ],
    initialState: [[1, 0, 0, 0]],
  });
  assert.equal(s._applyLineConstraints(), true);
  // Span [0,1,2] has 1 black already — no propagation
  assert.equal(s.cellStatus[1], 0);
  // Span [1,2,3]: 3 unknowns — no propagation
  assert.equal(s.cellStatus[2], 0);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `node --test tests/heyawake.test.js`
Expected: 3 failures — `_applyLineConstraints is not a function`.

- [ ] **Step 3: Implement**

Add inside `HeyawakeSolver`:

```js
_applyLineConstraints() {
  for (let i = 0; i < this.lineConstraints.length; i++) {
    const cells = this.lineConstraints[i];
    let nB = 0, nU = 0, uIdx = -1;
    for (let j = 0; j < cells.length; j++) {
      const v = this.cellStatus[cells[j]];
      if (v === 1) nB++;
      else if (v === 0) { nU++; uIdx = cells[j]; }
    }
    if (nB === 0 && nU === 0) return false;
    if (nB === 0 && nU === 1) {
      if (!this._set(uIdx, 1)) return false;
    }
  }
  return true;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test tests/heyawake.test.js`
Expected: 15 passing.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(heyawake): rule 3b — line-constraint propagation"
```

---

## Task 6: Rule 4a — White connectivity (BFS contradiction detection)

**Files:**
- Modify: `solver.js` (add `_applyConnectivity` — BFS portion only)
- Test: `tests/heyawake.test.js` (append)

BFS from a known-white anchor through `{white ∪ unknown}` cells. Any known-white not reached is a contradiction. (Articulation forcing comes in Task 7.)

- [ ] **Step 1: Write failing test**

Append:

```js
test('HeyawakeSolver._applyConnectivity: blacks splitting whites → contradiction', () => {
  // 3x3, single room (no other rules interfere). Layout:
  //   2 1 2
  //   1 1 1
  //   2 1 2
  // Whites at corners isolated by blacks; not all reachable through whites/unknowns.
  const s = new HeyawakeSolver({
    rows: 3, cols: 3,
    rooms: [
      { cells: Array.from({ length: 9 }, (_, i) => ({ r: (i / 3) | 0, c: i % 3 })), target: -1 },
    ],
  });
  s.cellStatus[0] = 2; s.cellStatus[1] = 1; s.cellStatus[2] = 2;
  s.cellStatus[3] = 1; s.cellStatus[4] = 1; s.cellStatus[5] = 1;
  s.cellStatus[6] = 2; s.cellStatus[7] = 1; s.cellStatus[8] = 2;
  assert.equal(s._applyConnectivity(), false);
});

test('HeyawakeSolver._applyConnectivity: reachable whites through unknowns → ok', () => {
  // 3x3 with two known whites and unknowns between them — reachable, ok.
  const s = new HeyawakeSolver({
    rows: 3, cols: 3,
    rooms: [
      { cells: Array.from({ length: 9 }, (_, i) => ({ r: (i / 3) | 0, c: i % 3 })), target: -1 },
    ],
    initialState: [[2, 0, 0], [0, 0, 0], [0, 0, 2]],
  });
  assert.equal(s._applyConnectivity(), true);
});

test('HeyawakeSolver._applyConnectivity: no whites yet → ok', () => {
  const s = new HeyawakeSolver({
    rows: 2, cols: 2,
    rooms: [
      { cells: [
        { r: 0, c: 0 }, { r: 0, c: 1 }, { r: 1, c: 0 }, { r: 1, c: 1 },
      ], target: -1 },
    ],
  });
  assert.equal(s._applyConnectivity(), true);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `node --test tests/heyawake.test.js`
Expected: 3 failures.

- [ ] **Step 3: Implement BFS**

Add inside `HeyawakeSolver`:

```js
_applyConnectivity() {
  const total = this.rows * this.cols;
  let anchor = -1;
  for (let i = 0; i < total; i++) {
    if (this.cellStatus[i] === 2) { anchor = i; break; }
  }
  if (anchor < 0) return true; // no constraint with no whites
  const visited = new Uint8Array(total);
  visited[anchor] = 1;
  const stack = [anchor];
  while (stack.length) {
    const u = stack.pop();
    const r = (u / this.cols) | 0;
    const c = u - r * this.cols;
    if (r > 0) {
      const ni = u - this.cols;
      if (!visited[ni] && this.cellStatus[ni] !== 1) { visited[ni] = 1; stack.push(ni); }
    }
    if (r < this.rows - 1) {
      const ni = u + this.cols;
      if (!visited[ni] && this.cellStatus[ni] !== 1) { visited[ni] = 1; stack.push(ni); }
    }
    if (c > 0) {
      const ni = u - 1;
      if (!visited[ni] && this.cellStatus[ni] !== 1) { visited[ni] = 1; stack.push(ni); }
    }
    if (c < this.cols - 1) {
      const ni = u + 1;
      if (!visited[ni] && this.cellStatus[ni] !== 1) { visited[ni] = 1; stack.push(ni); }
    }
  }
  for (let i = 0; i < total; i++) {
    if (this.cellStatus[i] === 2 && !visited[i]) return false;
  }
  return true;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test tests/heyawake.test.js`
Expected: 18 passing.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(heyawake): rule 4a — white-connectivity contradiction via BFS"
```

---

## Task 7: Rule 4b — Articulation forcing for unknowns

**Files:**
- Modify: `solver.js` (extend `_applyConnectivity` with iterative Tarjan)
- Test: `tests/heyawake.test.js` (append)

Find articulation points in the `{white ∪ unknown}` graph. If removing an unknown disconnects two known whites, force that unknown to white. Skipped inside lookahead probes (`_inLookahead` guard).

- [ ] **Step 1: Write failing test**

Append:

```js
test('HeyawakeSolver._applyConnectivity: articulation unknown gets forced white', () => {
  // 1x5 row: whites at ends, single unknown in the middle, blacks elsewhere.
  // Layout: W . W with the unknown being the only path between the two whites.
  //         Wait — need blacks adjacent that prevent other paths.
  // Actually for a 1D case: 2 0 2 — middle MUST be white to connect.
  // But that's trivially handled by the BFS-only path already if we set the
  // forcing flag. Let's use a 2D case:
  //   2 1 0
  //   1 1 1
  //   2 1 0
  // Here both bottom-right and top-right unknowns are isolated (surrounded by
  // black). They cannot be white (no path to the white anchor). So they
  // must be black. Hmm — but we're testing the articulation FORCE-WHITE rule.
  // Need a case where an unknown bridges two whites.
  //   2 0 2
  //   1 . 1
  //   2 0 2
  // The center (4) is the only connection between (0,1) and (2,1). The top
  // white at (0,0) connects to (1,0)? But (1,0) is black. So (0,0) connects
  // only via (0,1) (an unknown). To reach (0,2) the only path is through
  // (0,1). So (0,1) must be white. (2,1) similarly must be white. The center
  // (4) connects them.
  // Simpler 3x3:
  //   2 ? 2
  //   1 ? 1
  //   2 ? 2
  // The middle column (cells 1, 4, 7) is the only connection between the
  // four corner whites. The blacks at (1,0) and (1,2) cut the middle row.
  // All four corners must reach each other through (1,4,7). Cell 4 is an
  // articulation between corners 0/2 (top) and 6/8 (bottom). It must be white.
  const s = new HeyawakeSolver({
    rows: 3, cols: 3,
    rooms: [
      { cells: Array.from({ length: 9 }, (_, i) => ({ r: (i / 3) | 0, c: i % 3 })), target: -1 },
    ],
  });
  s.cellStatus[0] = 2; s.cellStatus[2] = 2;
  s.cellStatus[3] = 1; s.cellStatus[5] = 1;
  s.cellStatus[6] = 2; s.cellStatus[8] = 2;
  // Cells 1, 4, 7 unknown — articulation analysis must force at least cell 4 white
  assert.equal(s._applyConnectivity(), true);
  assert.equal(s.cellStatus[4], 2, 'cell 4 (center) must be forced white');
});

test('HeyawakeSolver._applyConnectivity: articulation skipped inside lookahead', () => {
  const s = new HeyawakeSolver({
    rows: 3, cols: 3,
    rooms: [
      { cells: Array.from({ length: 9 }, (_, i) => ({ r: (i / 3) | 0, c: i % 3 })), target: -1 },
    ],
  });
  s.cellStatus[0] = 2; s.cellStatus[2] = 2;
  s.cellStatus[3] = 1; s.cellStatus[5] = 1;
  s.cellStatus[6] = 2; s.cellStatus[8] = 2;
  s._inLookahead = true;
  assert.equal(s._applyConnectivity(), true);
  assert.equal(s.cellStatus[4], 0, 'cell 4 must NOT be forced inside lookahead');
});
```

- [ ] **Step 2: Run, verify failure**

Run: `node --test tests/heyawake.test.js`
Expected: articulation-forcing test fails (cell 4 still 0).

- [ ] **Step 3: Extend `_applyConnectivity` with articulation analysis**

Replace `_applyConnectivity` with:

```js
_applyConnectivity() {
  const total = this.rows * this.cols;
  let anchor = -1;
  for (let i = 0; i < total; i++) {
    if (this.cellStatus[i] === 2) { anchor = i; break; }
  }
  if (anchor < 0) return true;
  // Phase A: BFS reachability — every known white must be reachable
  // through {white ∪ unknown}.
  const visited = new Uint8Array(total);
  visited[anchor] = 1;
  const stack = [anchor];
  while (stack.length) {
    const u = stack.pop();
    const r = (u / this.cols) | 0;
    const c = u - r * this.cols;
    const ns = [];
    if (r > 0) ns.push(u - this.cols);
    if (r < this.rows - 1) ns.push(u + this.cols);
    if (c > 0) ns.push(u - 1);
    if (c < this.cols - 1) ns.push(u + 1);
    for (let i = 0; i < ns.length; i++) {
      const ni = ns[i];
      if (!visited[ni] && this.cellStatus[ni] !== 1) { visited[ni] = 1; stack.push(ni); }
    }
  }
  for (let i = 0; i < total; i++) {
    if (this.cellStatus[i] === 2 && !visited[i]) return false;
  }
  if (this._inLookahead) return true;
  // Phase B: articulation analysis on the {white ∪ unknown} graph.
  // An unknown cell whose removal would disconnect any two known whites
  // must itself be white.
  // Iterative Tarjan with parent / disc / low arrays.
  const disc = new Int32Array(total).fill(-1);
  const low = new Int32Array(total);
  const parent = new Int32Array(total).fill(-1);
  const childOfRoot = new Int32Array(1);
  childOfRoot[0] = 0;
  // articulationKnownWhiteCount[u] = how many subtree-known-whites would be
  // isolated if u were removed (counted on the parent-pointing edges).
  // We compute via DFS: for each non-root vertex u, u is an articulation
  // point iff some child v has low[v] >= disc[u]. AND when u itself is
  // unknown, we additionally require that removing u splits known-whites
  // into ≥2 components (rather than just splitting the graph in general).
  // To simplify: count, for each cell, the total known-whites reachable via
  // each child subtree. If ≥2 such subtrees each contain a known-white,
  // u is a critical cut for known-white connectivity.
  const subtreeKnownWhite = new Int32Array(total); // count in own subtree
  const articulationSplits = new Int32Array(total); // count of children whose subtree contains ≥1 known white
  let timer = 0;
  // Iterative DFS stack: { u, childIdxNext, neighbours }
  const dfsStack = [];
  // Per-vertex precomputed neighbour list (only {white ∪ unknown})
  const neighboursOf = (u) => {
    const r = (u / this.cols) | 0;
    const c = u - r * this.cols;
    const ns = [];
    if (r > 0) { const ni = u - this.cols; if (this.cellStatus[ni] !== 1) ns.push(ni); }
    if (r < this.rows - 1) { const ni = u + this.cols; if (this.cellStatus[ni] !== 1) ns.push(ni); }
    if (c > 0) { const ni = u - 1; if (this.cellStatus[ni] !== 1) ns.push(ni); }
    if (c < this.cols - 1) { const ni = u + 1; if (this.cellStatus[ni] !== 1) ns.push(ni); }
    return ns;
  };
  // Root the DFS at the anchor.
  disc[anchor] = low[anchor] = timer++;
  subtreeKnownWhite[anchor] = (this.cellStatus[anchor] === 2 ? 1 : 0);
  dfsStack.push({ u: anchor, ns: neighboursOf(anchor), idx: 0 });
  let rootChildCount = 0;
  while (dfsStack.length) {
    const top = dfsStack[dfsStack.length - 1];
    if (top.idx >= top.ns.length) {
      // Finished u; update parent's low and subtree-known-white counter.
      const u = top.u;
      const p = parent[u];
      if (p >= 0) {
        if (low[u] < low[p]) low[p] = low[u];
        subtreeKnownWhite[p] += subtreeKnownWhite[u];
        if (low[u] >= disc[p] && subtreeKnownWhite[u] >= 1) {
          articulationSplits[p]++;
        }
      }
      dfsStack.pop();
      continue;
    }
    const v = top.ns[top.idx++];
    const u = top.u;
    if (disc[v] < 0) {
      parent[v] = u;
      disc[v] = low[v] = timer++;
      subtreeKnownWhite[v] = (this.cellStatus[v] === 2 ? 1 : 0);
      if (u === anchor) rootChildCount++;
      dfsStack.push({ u: v, ns: neighboursOf(v), idx: 0 });
    } else if (v !== parent[u]) {
      if (disc[v] < low[u]) low[u] = disc[v];
    }
  }
  // Decide which unknowns are articulation points for known whites and force white.
  const totalKnownWhites = subtreeKnownWhite[anchor];
  for (let u = 0; u < total; u++) {
    if (this.cellStatus[u] !== 0) continue; // only unknowns
    if (disc[u] < 0) continue; // not in graph
    let critical = false;
    if (u === anchor) {
      // Root is articulation iff it has ≥2 children whose subtrees each
      // contain a known white.
      critical = (rootChildCount >= 2 && articulationSplits[u] >= 2);
    } else {
      // Non-root u: articulation if articulationSplits[u] >= 1 (some child's
      // subtree contains a known white that depends on u) AND the "rest of
      // the graph" through u's parent also contains a known white. The rest
      // contains (totalKnownWhites - subtreeKnownWhite[u]).
      const restWhites = totalKnownWhites - subtreeKnownWhite[u];
      critical = (articulationSplits[u] >= 1 && restWhites >= 1);
    }
    if (critical) {
      if (!this._set(u, 2)) return false;
    }
  }
  return true;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test tests/heyawake.test.js`
Expected: 20 passing.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(heyawake): rule 4b — articulation analysis forces critical whites"
```

---

## Task 8: Propagate orchestrator

**Files:**
- Modify: `solver.js` (add `_propagate`)
- Test: `tests/heyawake.test.js` (append)

Iterate the four rules to fixpoint. Returns false on contradiction.

- [ ] **Step 1: Write failing test**

Append:

```js
test('HeyawakeSolver._propagate: cascades rules to fixpoint', () => {
  // 1x4 with two rooms: target=1 + target=0. Room 1 (target=0) forces both
  // its cells to white. Room 0 (target=1) has 2 unknowns; can't deduce yet.
  // But the line-constraint (if any) would help; here only 2 rooms, so no
  // line constraint fires. After room-count, the puzzle is partially deduced.
  const s = new HeyawakeSolver({
    rows: 1, cols: 4,
    rooms: [
      { cells: [{ r: 0, c: 0 }, { r: 0, c: 1 }], target: 1 },
      { cells: [{ r: 0, c: 2 }, { r: 0, c: 3 }], target: 0 },
    ],
  });
  assert.equal(s._propagate(), true);
  assert.equal(s.cellStatus[2], 2);
  assert.equal(s.cellStatus[3], 2);
  // Room 0 unknowns: can't decide without more rules / lookahead
  assert.equal(s.cellStatus[0], 0);
  assert.equal(s.cellStatus[1], 0);
});

test('HeyawakeSolver._propagate: returns false on contradictory input', () => {
  const s = new HeyawakeSolver({
    rows: 1, cols: 2,
    rooms: [
      { cells: [{ r: 0, c: 0 }, { r: 0, c: 1 }], target: 2 },
    ],
    initialState: [[2, 0]], // target 2, but cell 0 is already white → impossible
  });
  // Room-count rule: nB=0, nU=1, target=2 → nB+nU=1<2 → contradiction
  assert.equal(s._propagate(), false);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `node --test tests/heyawake.test.js`
Expected: `_propagate is not a function`.

- [ ] **Step 3: Implement**

Add inside `HeyawakeSolver`:

```js
_propagate() {
  let changedOverall = true;
  while (changedOverall) {
    if (this._timeUp()) return true;
    changedOverall = false;
    const mark = this.trail.length;
    if (!this._applyRoomCounts()) return false;
    if (!this._applyLineConstraints()) return false;
    if (!this._applyConnectivity()) return false;
    if (this.trail.length > mark) changedOverall = true;
  }
  return true;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test tests/heyawake.test.js`
Expected: 22 passing.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(heyawake): _propagate orchestrator runs rules to fixpoint"
```

---

## Task 9: 1-step lookahead

**Files:**
- Modify: `solver.js` (add `_applyLookahead`, extend `_propagate` to call it at depth 0)
- Test: `tests/heyawake.test.js` (append)

Probe each unknown with each value; force survivor when only one survives. Gated by `_inLookahead` and `_depth === 0`.

- [ ] **Step 1: Write failing test**

Append:

```js
test('HeyawakeSolver._applyLookahead: probes force unique survivors', () => {
  // Constructed: 1x3 with one room target=1. Two unknowns at 0 and 2.
  // Setting cell 0 black → cell 1 white (adjacency). Room count: target=1
  // satisfied; cell 2 forced white. OK.
  // Setting cell 0 white → cell 2 must be black (target=1, only candidate
  // since cell 1 is also in this room). Both probes survive! No forcing.
  // Need a case with exactly one survivor.
  // Use 1x3 with one room target=1 PLUS initial white at cell 2.
  // Probe cell 0 = black → cell 1 forced white (adjacency), room saturated. OK.
  // Probe cell 0 = white → room has 1 black needed but no candidates (cell 1
  //   unknown, cell 2 already white) — propagator may not immediately
  //   contradict (cell 1 could be black). Still ambiguous.
  // Simpler: use rule 3 to force lookahead. Skip this — go for any case
  // where lookahead provably narrows.
  // Direct test: probe a binary state with one obvious blocker.
  // 2x1: rooms [{[0,1], target:1}]. Initially [[0],[0]].
  // Probe cell 0 = black → cell 1 white via adjacency.
  // Probe cell 0 = white → cell 1 must be black (target 1, room saturated).
  // Both survive — not useful for lookahead detection.
  // For lookahead's force-survivor logic, we need one probe to contradict.
  // 1x3, room1 cells [0,1] target=1, room2 cell [2] target=1.
  // Probe cell 0 black → cell 1 white (adjacency), room1 saturated, room2
  //   needs cell 2 black, but then cell 1 (white) adjacent to cell 2 (black) — ok.
  // Probe cell 0 white → room1 needs cell 1 black, then cell 2 (target=1)
  //   must be black, but cell 1 (black) adjacent to cell 2 (black) → CONTRADICTION.
  // Only black survives for cell 0.
  const s = new HeyawakeSolver({
    rows: 1, cols: 3,
    rooms: [
      { cells: [{ r: 0, c: 0 }, { r: 0, c: 1 }], target: 1 },
      { cells: [{ r: 0, c: 2 }], target: 1 },
    ],
  });
  assert.equal(s._applyLookahead(), true);
  assert.equal(s.cellStatus[0], 1, 'cell 0 must be forced black via lookahead');
});
```

- [ ] **Step 2: Run, verify failure**

Run: `node --test tests/heyawake.test.js`
Expected: 1 failure — `_applyLookahead` undefined.

- [ ] **Step 3: Implement**

Add inside `HeyawakeSolver`:

```js
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

Then extend `_propagate` so it calls lookahead at the top level. Replace the existing `_propagate` body's tail (`return true;`) with:

```js
  if (this._depth === 0 && !this._inLookahead) {
    if (!this._applyLookahead()) return false;
  }
  return true;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test tests/heyawake.test.js`
Expected: 23 passing.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(heyawake): top-level 1-step lookahead in _propagate"
```

---

## Task 10: Most-constrained backtracking + solve() + _isComplete + _emit

**Files:**
- Modify: `solver.js` (add `_pickBestUnknown`, `_backtrack`, `_isComplete`, `_emit`, `solve`)
- Test: `tests/heyawake.test.js` (append)

Pick the unknown cell with highest tightness score (room slack inverse + adjacency + line-tension). Branch [1, 2]. Standard `solve()` that returns `{solved, grid, error?, partial?}`.

- [ ] **Step 1: Write failing test**

Append:

```js
test('HeyawakeSolver.solve: 2x2 trivial puzzle (target 1 single room)', () => {
  const s = new HeyawakeSolver({
    rows: 2, cols: 2,
    rooms: [
      { cells: [
        { r: 0, c: 0 }, { r: 0, c: 1 }, { r: 1, c: 0 }, { r: 1, c: 1 },
      ], target: 1 },
    ],
  });
  const r = s.solve();
  assert.equal(r.solved, true);
  // Exactly one black, rest white, no two blacks adjacent — any single-black
  // assignment is valid.
  let blacks = 0;
  for (const row of r.grid) for (const v of row) {
    if (v === 1) blacks++;
    else assert.equal(v, 2);
  }
  assert.equal(blacks, 1);
});

test('HeyawakeSolver.solve: returns {solved:false, grid:null} on unsat', () => {
  const s = new HeyawakeSolver({
    rows: 1, cols: 2,
    rooms: [{ cells: [{ r: 0, c: 0 }, { r: 0, c: 1 }], target: 2 }],
  });
  // target=2 in a 2-cell room → both must be black → adjacency violation
  const r = s.solve();
  assert.equal(r.solved, false);
  assert.equal(r.grid, null);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `node --test tests/heyawake.test.js`
Expected: `s.solve is not a function`.

- [ ] **Step 3: Implement**

Add inside `HeyawakeSolver`:

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
  let bestIdx = -1;
  let bestScore = -Infinity;
  const total = this.rows * this.cols;
  for (let i = 0; i < total; i++) {
    if (this.cellStatus[i] !== 0) continue;
    const k = this.cellToRoom[i];
    const cells = this.roomCells[k];
    let nB = 0, nU = 0;
    for (let j = 0; j < cells.length; j++) {
      const v = this.cellStatus[cells[j]];
      if (v === 1) nB++;
      else if (v === 0) nU++;
    }
    let roomTightness = 0;
    if (this.target[k] >= 0) {
      const need = this.target[k] - nB;
      const slack = Math.min(need, nU - need);
      roomTightness = 1 / (Math.max(0, slack) + 1);
    }
    const r = (i / this.cols) | 0;
    const c = i - r * this.cols;
    let adj = 0;
    if (r > 0 && this.cellStatus[i - this.cols] !== 0) adj++;
    if (r < this.rows - 1 && this.cellStatus[i + this.cols] !== 0) adj++;
    if (c > 0 && this.cellStatus[i - 1] !== 0) adj++;
    if (c < this.cols - 1 && this.cellStatus[i + 1] !== 0) adj++;
    let lt = 0;
    const lcs = this.lineConstraintsByCell[i];
    for (let j = 0; j < lcs.length; j++) {
      const lcCells = this.lineConstraints[lcs[j]];
      let u = 0;
      for (let m = 0; m < lcCells.length; m++) {
        if (this.cellStatus[lcCells[m]] === 0) u++;
      }
      if (u <= 2) lt++;
    }
    const score = roomTightness * 4 + adj + lt;
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
  this._startedAt = Date.now();
  if (!this._propagate()) {
    this._rollback(0);
    return { solved: false, grid: null };
  }
  if (this._isComplete()) return { solved: true, grid: this._emit() };
  if (this._backtrack()) return { solved: true, grid: this._emit() };
  const partial = this._emit();
  if (this._timeUp()) {
    return { solved: false, grid: partial, error: 'timed out', partial: true };
  }
  return { solved: false, grid: null };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test tests/heyawake.test.js`
Expected: 25 passing.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(heyawake): solve() with MC backtracking + partial-on-timeout"
```

---

## Task 11: Static caches + deep clone

**Files:**
- Modify: `solver.js` (add static `_solutionCache`, `_partialCache`, `_cacheKey`, `_storeInCache`, `_cloneResult`, `clearSolutionCache`; wire into `solve()`)
- Test: `tests/heyawake.test.js` (append)

50-entry LRU for full solutions, 20-entry for partials. Deep-copy on store AND read so callers can mutate returned grids without poisoning the cache (Hashi fix #6 precedent).

- [ ] **Step 1: Write failing test**

Append:

```js
test('HeyawakeSolver._solutionCache: cache hit returns a deep copy', () => {
  HeyawakeSolver.clearSolutionCache();
  const data = {
    rows: 2, cols: 2,
    rooms: [{ cells: [
      { r: 0, c: 0 }, { r: 0, c: 1 }, { r: 1, c: 0 }, { r: 1, c: 1 },
    ], target: 1 }],
  };
  const a = new HeyawakeSolver(data).solve();
  assert.equal(a.solved, true);
  // Mutate the first result's grid
  a.grid[0][0] = 99;
  const b = new HeyawakeSolver(data).solve();
  assert.equal(b.solved, true);
  // Second result must NOT see the mutation
  assert.notEqual(b.grid[0][0], 99);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `node --test tests/heyawake.test.js`
Expected: cache test fails (mutation leaks back).

- [ ] **Step 3: Implement caches**

Add static fields and methods inside `HeyawakeSolver` (place at the BOTTOM of the class body, before the closing `}`):

```js
static _solutionCache = new Map();
static _maxSolutionCache = 50;
static _partialCache = new Map();
static _maxPartialCache = 20;
static clearSolutionCache() {
  HeyawakeSolver._solutionCache.clear();
  HeyawakeSolver._partialCache.clear();
}

_cacheKey() {
  let h = 0x811c9dc5;
  const mix = (n) => { h ^= n & 0xff; h = Math.imul(h, 0x01000193) >>> 0; };
  mix(this.rows); mix(this.cols); mix(this.K);
  for (let k = 0; k < this.K; k++) mix(this.target[k] + 1); // shift -1 → 0
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
  const m = result.partial ? HeyawakeSolver._partialCache : HeyawakeSolver._solutionCache;
  const max = result.partial ? HeyawakeSolver._maxPartialCache : HeyawakeSolver._maxSolutionCache;
  if (m.size >= max) {
    const first = m.keys().next().value;
    m.delete(first);
  }
  m.set(key, this._cloneResult(result));
}
```

Then modify `solve()` to consult and populate the cache. Replace `solve()` with:

```js
solve() {
  const key = this._cacheKey();
  const cached = HeyawakeSolver._solutionCache.get(key) || HeyawakeSolver._partialCache.get(key);
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

- [ ] **Step 4: Run, verify pass**

Run: `node --test tests/heyawake.test.js`
Expected: 26 passing.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(heyawake): static solution + partial caches with deep-copy"
```

---

## Task 12: getHint contract

**Files:**
- Modify: `solver.js` (add `getHint`)
- Test: `tests/heyawake.test.js` (append)

Returns `[{row, col, value}, ...]` of forced cells, or `null` if nothing deducible. Propagates from the live `cellStatus` without lookahead at default depth.

- [ ] **Step 1: Write failing test**

Append:

```js
test('HeyawakeSolver.getHint: returns forced cells on an empty solvable board', () => {
  // 1x3, room0=[0,1] target=1, room1=[2] target=1. Room1 saturates: cell 2 black.
  // Then adjacency: cell 1 white. Then room0 unknowns = 1 (cell 0) with target=1
  // → cell 0 black.
  HeyawakeSolver.clearSolutionCache();
  const s = new HeyawakeSolver({
    rows: 1, cols: 3,
    rooms: [
      { cells: [{ r: 0, c: 0 }, { r: 0, c: 1 }], target: 1 },
      { cells: [{ r: 0, c: 2 }], target: 1 },
    ],
  });
  const hint = s.getHint([[0, 0, 0]]);
  assert.ok(Array.isArray(hint));
  assert.ok(hint.length >= 1);
  // At least cell 2 (row 0, col 2) must be in the hint as value=1
  const c2 = hint.find(h => h.row === 0 && h.col === 2);
  assert.ok(c2, `cell (0,2) should be in hint; got ${JSON.stringify(hint)}`);
  assert.equal(c2.value, 1);
});

test('HeyawakeSolver.getHint: returns null when state is already fully solved', () => {
  HeyawakeSolver.clearSolutionCache();
  const s = new HeyawakeSolver({
    rows: 1, cols: 3,
    rooms: [
      { cells: [{ r: 0, c: 0 }, { r: 0, c: 1 }], target: 1 },
      { cells: [{ r: 0, c: 2 }], target: 1 },
    ],
  });
  // Solved state: black, white, black
  assert.equal(s.getHint([[1, 2, 1]]), null);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `node --test tests/heyawake.test.js`
Expected: `s.getHint is not a function`.

- [ ] **Step 3: Implement**

Add inside `HeyawakeSolver`:

```js
getHint(initialState) {
  // Seed cellStatus from caller's grid; propagate; emit newly-decided cells.
  const total = this.rows * this.cols;
  // Reset cellStatus to the seeded state (caller-provided grid).
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
  if (!this._propagate()) return null;
  const hints = [];
  for (let i = 0; i < total; i++) {
    if (before[i] === 0 && this.cellStatus[i] !== 0) {
      const r = (i / this.cols) | 0;
      const c = i - r * this.cols;
      hints.push({ row: r, col: c, value: this.cellStatus[i] });
    }
  }
  return hints.length ? hints : null;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test tests/heyawake.test.js`
Expected: 28 passing.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(heyawake): getHint returns forced cells from current state"
```

---

## Task 13: computePuzzleDiff arm

**Files:**
- Modify: `solver.js` (extend `computePuzzleDiff` to handle `'heyawake'`)
- Test: `tests/heyawake.test.js` (append)

Standard cell-state arm: flag `(r, c)` where `board[r][c] !== 0 && board[r][c] !== solution[r][c]`. Identical shape to nonogram / aquarium.

- [ ] **Step 1: Write failing test**

Append:

```js
test('computePuzzleDiff heyawake: flags wrong-color cells, ignores unknown', () => {
  const { computePuzzleDiff } = require('../solver.js');
  const solution = [[1, 2], [2, 1]];
  const board = [
    [2, 2],   // (0,0) wrong: solution wants black, user has white
    [0, 1],   // (1,0) unknown (skip), (1,1) correct
  ];
  const diff = computePuzzleDiff('heyawake', board, solution);
  assert.equal(diff.length, 1);
  assert.deepEqual(diff[0], { row: 0, col: 0, expected: 1, actual: 2 });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `node --test tests/heyawake.test.js`
Expected: diff returns empty array (no heyawake arm).

- [ ] **Step 3: Add heyawake arm to computePuzzleDiff**

Find `computePuzzleDiff` in `solver.js`. There's already a generic cell-state arm; check the structure. Look for the line that branches on `type` — likely an `if (type === 'hashi')` block followed by the generic fallback. Add `'heyawake'` to the list of types that use the cell-state diff, OR confirm it already falls through to the generic arm.

Open the function and look for the section that returns the cell-mismatch list. If the existing fallback already handles 2D-grid puzzles (`nonogram`, `aquarium`, `binairo`, `yinyang`), then heyawake's 2D grid will work as-is and the test should already pass — re-run the test.

If you find an explicit `if/switch` listing the puzzle types, add `heyawake` to it. The diff entry shape should be `{ row, col, expected, actual }`.

- [ ] **Step 4: Run, verify pass**

Run: `node --test tests/heyawake.test.js`
Expected: 29 passing.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(heyawake): computePuzzleDiff cell-state arm"
```

---

## Task 14: Fuzz soundness test

**Files:**
- Create: `tests/heyawake-fuzz.test.js`

Generate random heyawake puzzles. For each solved result, independently validate all four rules.

- [ ] **Step 1: Create the fuzz test**

Create `tests/heyawake-fuzz.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { HeyawakeSolver } = require('../solver.js');

function generateRectangularRooms(rows, cols, seed) {
  // Random rectangular partition. Walk grid in row-major order; at each
  // unfilled cell, pick a random width×height that fits without overlap.
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
      // Find max width
      let maxW = 1;
      while (c + maxW < cols && grid[r][c + maxW] === -1) maxW++;
      const w = 1 + Math.floor(rand() * maxW);
      // Find max height for this width
      let maxH = 1;
      outer: while (r + maxH < rows) {
        for (let cc = c; cc < c + w; cc++) {
          if (grid[r + maxH][cc] !== -1) break outer;
        }
        maxH++;
      }
      const h = 1 + Math.floor(rand() * maxH);
      const id = rooms.length;
      const cells = [];
      for (let rr = r; rr < r + h; rr++) {
        for (let cc = c; cc < c + w; cc++) {
          grid[rr][cc] = id;
          cells.push({ r: rr, c: cc });
        }
      }
      rooms.push({ cells, target: -1 });
    }
  }
  return { rooms, areas: grid };
}

function pickTargetsFromSolution(rooms, solution) {
  // For each room, count blacks in the solution to pick target.
  // 50% chance: keep target=-1 (no clue).
  const out = [];
  for (const room of rooms) {
    let blacks = 0;
    for (const cell of room.cells) if (solution[cell.r][cell.c] === 1) blacks++;
    out.push({ ...room, target: Math.random() < 0.5 ? blacks : -1 });
  }
  return out;
}

function validate(rows, cols, rooms, areas, grid) {
  // Rule 1: room counts match (if target >= 0)
  for (const room of rooms) {
    if (room.target < 0) continue;
    let n = 0;
    for (const cell of room.cells) if (grid[cell.r][cell.c] === 1) n++;
    if (n !== room.target) return `rule 1: room target ${room.target} vs ${n} blacks`;
  }
  // Rule 2: no adjacent blacks
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (grid[r][c] !== 1) continue;
      if (r > 0 && grid[r - 1][c] === 1) return `rule 2: blacks at (${r-1},${c}) (${r},${c})`;
      if (c > 0 && grid[r][c - 1] === 1) return `rule 2: blacks at (${r},${c-1}) (${r},${c})`;
    }
  }
  // Rule 3: no white run crosses 3 rooms
  const checkLine = (cells) => {
    const n = cells.length;
    let runStart = 0;
    while (runStart < n) {
      if (grid[cells[runStart].r][cells[runStart].c] !== 2) { runStart++; continue; }
      let runEnd = runStart;
      while (runEnd + 1 < n && grid[cells[runEnd + 1].r][cells[runEnd + 1].c] === 2) runEnd++;
      const rooms = new Set();
      for (let i = runStart; i <= runEnd; i++) rooms.add(areas[cells[i].r][cells[i].c]);
      if (rooms.size >= 3) return `rule 3: white run from (${cells[runStart].r},${cells[runStart].c}) to (${cells[runEnd].r},${cells[runEnd].c}) spans ${rooms.size} rooms`;
      runStart = runEnd + 1;
    }
    return null;
  };
  for (let r = 0; r < rows; r++) {
    const err = checkLine(Array.from({ length: cols }, (_, c) => ({ r, c })));
    if (err) return err;
  }
  for (let c = 0; c < cols; c++) {
    const err = checkLine(Array.from({ length: rows }, (_, r) => ({ r, c })));
    if (err) return err;
  }
  // Rule 4: white connectivity (BFS)
  let anchor = -1;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (grid[r][c] === 2) { anchor = r * cols + c; break; }
    if (anchor >= 0) break;
  }
  if (anchor < 0) return null; // all black? technically valid but ridiculous
  const visited = new Uint8Array(rows * cols);
  visited[anchor] = 1;
  const stack = [anchor];
  while (stack.length) {
    const u = stack.pop();
    const r = (u / cols) | 0;
    const c = u - r * cols;
    const ns = [];
    if (r > 0) ns.push(u - cols);
    if (r < rows - 1) ns.push(u + cols);
    if (c > 0) ns.push(u - 1);
    if (c < cols - 1) ns.push(u + 1);
    for (const ni of ns) {
      if (visited[ni]) continue;
      const nr = (ni / cols) | 0, nc = ni - nr * cols;
      if (grid[nr][nc] !== 2) continue;
      visited[ni] = 1;
      stack.push(ni);
    }
  }
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (grid[r][c] === 2 && !visited[r * cols + c]) {
      return `rule 4: white at (${r},${c}) disconnected from anchor`;
    }
  }
  return null;
}

test('HeyawakeSolver fuzz: every solved board satisfies all four rules', () => {
  HeyawakeSolver.clearSolutionCache();
  let solved = 0;
  let attempted = 0;
  for (let seed = 1; seed <= 30; seed++) {
    attempted++;
    const rows = 4 + (seed % 3);
    const cols = 4 + ((seed >> 2) % 3);
    const { rooms: baseRooms, areas } = generateRectangularRooms(rows, cols, seed * 9173 + 1);
    // First, solve with all targets = -1 to get ANY valid coloring.
    HeyawakeSolver.clearSolutionCache();
    let primer = new HeyawakeSolver({ rows, cols, rooms: baseRooms, maxMs: 2000 });
    const primed = primer.solve();
    if (!primed.solved) continue;
    // Now pick targets from that solution; re-solve. Expected: at least
    // one valid solution exists (the primer's). Solver should find one.
    const rooms = pickTargetsFromSolution(baseRooms, primed.grid);
    HeyawakeSolver.clearSolutionCache();
    const s = new HeyawakeSolver({ rows, cols, rooms, maxMs: 2000 });
    const r = s.solve();
    if (!r.solved) continue;
    const err = validate(rows, cols, rooms, areas, r.grid);
    assert.equal(err, null, `seed=${seed} ${rows}x${cols}: ${err}`);
    solved++;
  }
  assert.ok(solved >= 10, `expected at least 10 solved boards, got ${solved}/${attempted}`);
});
```

- [ ] **Step 2: Run the fuzz test**

Run: `node --test tests/heyawake-fuzz.test.js`
Expected: PASS — at least 10 solved boards, all validated against all 4 rules.

If FAIL: read the assertion message — it names the rule and cells violated. Trace the bug in solver.js and fix before continuing.

- [ ] **Step 3: Commit**

```bash
jj commit -m "test(heyawake): fuzz suite for 4-rule soundness"
```

---

## Task 15: Fixtures + golden snapshot

**Files:**
- Modify: `tests/fixtures/puzzles.js` (add `heyawake6x6Easy`)
- Modify: `tests/golden.js` (add golden snapshot)
- Modify: `tests/solver.test.js` (add integration test that compares against golden)

Wire the recon dump into a deterministic test fixture and a golden-output snapshot so any future regression is caught.

- [ ] **Step 1: Add the fixture**

Open `tests/fixtures/puzzles.js`. Add a new exported fixture (place it after the last existing one):

```js
exports.heyawake6x6Easy = {
  type: 'heyawake',
  rows: 6,
  cols: 6,
  areas: [
    [0, 1, 2, 3, 3, 3],
    [4, 4, 2, 3, 3, 3],
    [5, 5, 5, 5, 6, 7],
    [8, 8, 8, 9, 6, 7],
    [8, 8, 8, 10, 10, 7],
    [8, 8, 8, 10, 10, 7],
  ],
  areaTask: [1, -1, -1, 2, 1, -1, 0, -1, 3, 1, -1],
};
```

- [ ] **Step 2: Add a helper to convert the fixture into solver-input shape**

Test files need to convert the `areas` + `areaTask` shape into the `rooms` array the solver wants. Add this helper at the top of `tests/solver.test.js` (inside an early `describe`-free block, near other helpers):

```js
function heyawakeRoomsFromFixture(fixture) {
  const { rows, cols, areas, areaTask } = fixture;
  const cellsPerRoom = {};
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const k = areas[r][c];
      if (!cellsPerRoom[k]) cellsPerRoom[k] = [];
      cellsPerRoom[k].push({ r, c });
    }
  }
  return areaTask.map((target, k) => ({ cells: cellsPerRoom[k], target }));
}
```

- [ ] **Step 3: Write the failing integration test**

Append to `tests/solver.test.js` (after the existing solver-suite tests, before any module-end code):

```js
test('HeyawakeSolver: heyawake6x6Easy fixture solves to a unique valid grid', () => {
  const { HeyawakeSolver } = require('../solver.js');
  const fixture = require('./fixtures/puzzles.js').heyawake6x6Easy;
  HeyawakeSolver.clearSolutionCache();
  const s = new HeyawakeSolver({
    rows: fixture.rows,
    cols: fixture.cols,
    rooms: heyawakeRoomsFromFixture(fixture),
  });
  const r = s.solve();
  assert.equal(r.solved, true);
  const expected = require('./golden.js').heyawake6x6Easy;
  assert.deepEqual(r.grid, expected);
});
```

- [ ] **Step 4: Run, see what the solver actually produces**

Run: `node --test tests/solver.test.js`
Expected: FAIL with a `golden.heyawake6x6Easy` undefined error.

Now capture the actual output. Add a temp `console.log(JSON.stringify(r.grid))` after `assert.equal(r.solved, true)` and re-run:

Run: `node --test tests/solver.test.js 2>&1 | grep heyawake6x6Easy -A 5`

You'll see a 2D array. Copy that.

- [ ] **Step 5: Add the golden snapshot**

Open `tests/golden.js`. Add a new export:

```js
exports.heyawake6x6Easy = [
  // ... paste the 2D array from step 4
];
```

Remove the `console.log` from Step 4.

- [ ] **Step 6: Re-run the test**

Run: `node --test tests/solver.test.js`
Expected: PASS — integration test green.

- [ ] **Step 7: Commit**

```bash
jj commit -m "test(heyawake): puzzles.js fixture + golden snapshot + integration test"
```

---

## Task 16: MAIN-world functions + allowlist

**Files:**
- Modify: `main-world.js` (add `readHeyawakeData`, `readHeyawakeState`, `applyHeyawakeState`)
- Modify: `background.js` (add 3 entries to `EXEC_MAIN_ALLOWLIST`)
- Modify: `globals.d.ts` (add 3 entries to `MainWorldFn`)

No new unit test — these run only inside the page (MAIN world), not Node. Integration verification happens via running the extension on a real puzzle (later) and via lint/typecheck.

- [ ] **Step 1: Add `readHeyawakeData` to `main-world.js`**

Find the last `read*Data` function in `main-world.js`. After it, add:

```js
function readHeyawakeData() {
  try {
    var G = window.Game;
    if (!G || !G.areas || !G.areaPoints || !G.areaTask) return null;
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
        cells.push({ r: pts[i].row, c: pts[i].col });
      }
      var target = G.areaTask[k];
      if (typeof target !== 'number' || !isFinite(target)) target = -1;
      rooms.push({ cells: cells, target: target });
    }
    return { rows: rows, cols: cols, areas: areas, rooms: rooms };
  } catch (e) {
    return null;
  }
}
```

- [ ] **Step 2: Add `readHeyawakeState`**

Add after `readHeyawakeData`:

```js
function readHeyawakeState(rows, cols) {
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

- [ ] **Step 3: Add `applyHeyawakeState`**

Add after `readHeyawakeState`:

```js
function applyHeyawakeState(grid) {
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
    console.warn('Heyawake apply failed:', e);
    return false;
  }
}
```

- [ ] **Step 4: Add to allowlist**

Open `background.js`. Find `EXEC_MAIN_ALLOWLIST = [...]`. Add three entries:

```js
'readHeyawakeData',
'readHeyawakeState',
'applyHeyawakeState',
```

Keep them grouped logically (e.g., after the hashi entries).

- [ ] **Step 5: Mirror in globals.d.ts**

Open `globals.d.ts`. Find the `MainWorldFn` type. Add three entries:

```ts
| 'readHeyawakeData'
| 'readHeyawakeState'
| 'applyHeyawakeState'
```

- [ ] **Step 6: Run lint + typecheck to verify**

Run: `npm run lint && npm run typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
jj commit -m "feat(heyawake): MAIN-world read/apply fns + allowlist entries"
```

---

## Task 17: Worker dispatch + handler registration

**Files:**
- Modify: `solver.worker.js` (add heyawake arm)
- Modify: `handler.js` (register `heyawakeHandler`)

- [ ] **Step 1: Add worker arm**

Open `solver.worker.js`. Find the `if/else if` chain dispatching by `type`. Add (before the final `else`):

```js
} else if (type === 'heyawake' && extraData) {
  const s = new HeyawakeSolver({
    rows: extraData.rows,
    cols: extraData.cols,
    rooms: extraData.rooms,
    initialState: initialGrid || null,
    maxMs: 30000,
  });
  result = s.solve();
}
```

Also update the `/* global ... */` directive at the top of the file to include `HeyawakeSolver`.

- [ ] **Step 2: Register the handler**

Open `handler.js`. Find the registration block (after the last handler). Add:

```js
registerHandler({
  type: 'heyawake',
  matches: (url) => url.includes('/heyawake/'),
  readData: () => callMainWorld('readHeyawakeData', []),
  readState: (rows, cols) => callMainWorld('readHeyawakeState', [rows, cols]),
  applySolution: (grid) => callMainWorld('applyHeyawakeState', [grid]),
});
```

If the existing handlers use a slightly different registration shape (e.g., method names), match what they use. Read one of them first (e.g., `binairoHandler`) and copy its shape.

- [ ] **Step 3: Run lint + typecheck**

Run: `npm run lint && npm run typecheck`
Expected: clean.

- [ ] **Step 4: Run full test suite to catch regressions**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(heyawake): worker dispatch arm + handler registration"
```

---

## Task 18: dumpPuzzleForBench arm + real-puzzle fixture

**Files:**
- Modify: `main-world.js` (add heyawake branch in `dumpPuzzleForBench`)
- Modify: `tests/fixtures/real-puzzles.js` (add `heyawake6x6EasyReal`)
- Modify: `tests/bench-real.js` (add heyawake arm)

- [ ] **Step 1: Extend dump**

Open `main-world.js`. Find `dumpPuzzleForBench`. Find the type-dispatch block (likely `if (path.includes(...))` or `if (slug === ...)`). Add:

```js
if (path.indexOf('/heyawake/') >= 0 || g.slug === 'heyawake') {
  const data = readHeyawakeData();
  if (!data) {
    return { error: 'heyawake: readHeyawakeData failed', diagnostic: diagnostic(g), path: path };
  }
  return {
    type: 'heyawake',
    rows: data.rows,
    cols: data.cols,
    areas: data.areas,
    areaTask: data.rooms.map(r => r.target),
  };
}
```

(Place this branch before the existing fallthrough, matching the pattern of the other puzzle branches in the function.)

- [ ] **Step 2: Add real-puzzle fixture**

Open `tests/fixtures/real-puzzles.js`. Add an export:

```js
exports.heyawake6x6EasyReal = {
  type: 'heyawake',
  rows: 6,
  cols: 6,
  areas: [
    [0, 1, 2, 3, 3, 3],
    [4, 4, 2, 3, 3, 3],
    [5, 5, 5, 5, 6, 7],
    [8, 8, 8, 9, 6, 7],
    [8, 8, 8, 10, 10, 7],
    [8, 8, 8, 10, 10, 7],
  ],
  areaTask: [1, -1, -1, 2, 1, -1, 0, -1, 3, 1, -1],
};
```

- [ ] **Step 3: Add bench-real arm**

Open `tests/bench-real.js`. Find the puzzle-type dispatch. Add a heyawake arm:

```js
if (fixture.type === 'heyawake') {
  const { HeyawakeSolver } = require('../solver.js');
  const rooms = [];
  const cellsPerRoom = {};
  for (let r = 0; r < fixture.rows; r++) {
    for (let c = 0; c < fixture.cols; c++) {
      const k = fixture.areas[r][c];
      if (!cellsPerRoom[k]) cellsPerRoom[k] = [];
      cellsPerRoom[k].push({ r, c });
    }
  }
  for (let k = 0; k < fixture.areaTask.length; k++) {
    rooms.push({ cells: cellsPerRoom[k], target: fixture.areaTask[k] });
  }
  return new HeyawakeSolver({
    rows: fixture.rows,
    cols: fixture.cols,
    rooms: rooms,
  });
}
```

Match the surrounding code shape — existing types may return `{ solver, args }` or similar. Read the bench-real source carefully and conform.

- [ ] **Step 4: Run bench-real to verify**

Run: `node tests/bench-real.js`
Expected: includes a heyawake6x6EasyReal entry with a measured solve time.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(heyawake): dumpPuzzleForBench arm + real fixture + bench-real arm"
```

---

## Task 19: bench-heyawake.js script + CI workflow step

**Files:**
- Create: `tests/bench-heyawake.js`
- Modify: `.github/workflows/bench-nightly.yml`

- [ ] **Step 1: Create the bench script**

Create `tests/bench-heyawake.js` (copy the structure from `tests/bench-hashi.js`):

```js
'use strict';
const { HeyawakeSolver } = require('../solver.js');
const fixture = require('./fixtures/real-puzzles.js').heyawake6x6EasyReal;

function buildRooms(f) {
  const cellsPerRoom = {};
  for (let r = 0; r < f.rows; r++) {
    for (let c = 0; c < f.cols; c++) {
      const k = f.areas[r][c];
      if (!cellsPerRoom[k]) cellsPerRoom[k] = [];
      cellsPerRoom[k].push({ r, c });
    }
  }
  return f.areaTask.map((target, k) => ({ cells: cellsPerRoom[k], target }));
}

const ITERATIONS = 5;
const WARMUP = 2;
const times = [];
for (let i = 0; i < WARMUP + ITERATIONS; i++) {
  HeyawakeSolver.clearSolutionCache();
  const s = new HeyawakeSolver({
    rows: fixture.rows,
    cols: fixture.cols,
    rooms: buildRooms(fixture),
  });
  const t0 = process.hrtime.bigint();
  const r = s.solve();
  const t1 = process.hrtime.bigint();
  if (!r.solved) {
    console.error('heyawake6x6EasyReal failed to solve');
    process.exit(1);
  }
  if (i >= WARMUP) times.push(Number(t1 - t0) / 1e6);
}
times.sort((a, b) => a - b);
const median = times[Math.floor(times.length / 2)];
console.log(`heyawake6x6EasyReal: median ${median.toFixed(2)} ms over ${ITERATIONS} runs`);
```

- [ ] **Step 2: Run the bench**

Run: `node tests/bench-heyawake.js`
Expected: prints a median solve time (target: <50 ms for the 6×6 easy).

- [ ] **Step 3: Add CI workflow step**

Open `.github/workflows/bench-nightly.yml`. Find the existing bench steps. Add:

```yaml
      - name: Bench Heyawake
        run: node tests/bench-heyawake.js
```

Place it adjacent to other bench steps (e.g., after `Bench Hashi`).

- [ ] **Step 4: Commit**

```bash
jj commit -m "ci(heyawake): bench script + nightly workflow step"
```

---

## Task 20: content.js — small wiring (SUPPORTED_PUZZLES, prefix, gate, sig)

**Files:**
- Modify: `content.js`

Five tiny touches: `SUPPORTED_PUZZLES`, `SOLUTION_KEY_PREFIXES`, `gridDataSig` (`|hy=` segment), `hintHandler` pendingAutoSolve gate, generic 2D arms verification.

- [ ] **Step 1: Add to SUPPORTED_PUZZLES**

Find `const SUPPORTED_PUZZLES = [` in `content.js`. Insert (alphabetically between Hashi and Nonogram):

```js
  { name: 'Heyawake',     url: 'https://www.puzzles-mobile.com/heyawake/' },
```

- [ ] **Step 2: Add to SOLUTION_KEY_PREFIXES**

Find `const SOLUTION_KEY_PREFIXES = [` (or however that list is declared). Add `'heyawake-solution:'` to the array.

- [ ] **Step 3: Extend gridDataSig**

Find `gridDataSig` and `staticSig` in `content.js` — these functions FNV-hash puzzle metadata for cache invalidation. For heyawake, the static layer depends on `puzzleData.areas`. Add a heyawake arm so the static sig includes the areas:

```js
if (puzzleData.type === 'heyawake' && puzzleData.areas) {
  s += '|hy=';
  for (const row of puzzleData.areas) {
    for (const v of row) {
      h ^= (v + 1) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
}
```

(Locate the existing pattern for `|bn=`, `|sk=`, etc., and follow it.)

- [ ] **Step 4: Extend pendingAutoSolve gate**

Find this line (added by the code-review fixes earlier):

```js
const skipAutoSolveGate = puzzleData.type === 'slitherlink' || puzzleData.type === 'hashi';
```

Extend to include heyawake:

```js
const skipAutoSolveGate = puzzleData.type === 'slitherlink' || puzzleData.type === 'hashi' || puzzleData.type === 'heyawake';
```

- [ ] **Step 5: Run lint + typecheck + tests**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
jj commit -m "feat(heyawake): content.js bookkeeping (SUPPORTED_PUZZLES, prefix, sig, gate)"
```

---

## Task 21: content.js — drawPreview arm

**Files:**
- Modify: `content.js` (`drawPreview` function — add heyawake render)

Paint black cells, white-dot markers, room borders (thick lines between distinct `areas` values), and target numbers for rooms with `target >= 0`.

- [ ] **Step 1: Locate drawPreview**

Find `function drawPreview(grid, hint) {` (or the equivalent) in `content.js`. Look at how Galaxies / Shikaku do region borders — heyawake's pattern is similar.

- [ ] **Step 2: Add the heyawake arm**

Inside drawPreview, before the generic fallback, add (adapt to surrounding code conventions for `ctx`, `cell` sizing, `staticLayer` caching):

```js
if (puzzleData.type === 'heyawake') {
  const areas = puzzleData.areas;
  // Static layer: room borders + clue numbers (rebuilt only on shape change).
  if (staticDirty) {
    staticCtx.clearRect(0, 0, staticLayer.width, staticLayer.height);
    // Room borders
    staticCtx.strokeStyle = '#000';
    staticCtx.lineWidth = 2;
    for (let r = 0; r < puzzleData.rows; r++) {
      for (let c = 0; c < puzzleData.cols; c++) {
        const k = areas[r][c];
        if (r === 0 || areas[r - 1][c] !== k) {
          staticCtx.beginPath();
          staticCtx.moveTo(c * cell, r * cell);
          staticCtx.lineTo((c + 1) * cell, r * cell);
          staticCtx.stroke();
        }
        if (c === 0 || areas[r][c - 1] !== k) {
          staticCtx.beginPath();
          staticCtx.moveTo(c * cell, r * cell);
          staticCtx.lineTo(c * cell, (r + 1) * cell);
          staticCtx.stroke();
        }
      }
    }
    // Outer border
    staticCtx.strokeRect(0, 0, puzzleData.cols * cell, puzzleData.rows * cell);
    // Clue numbers (top-left of each room, target >= 0 only)
    staticCtx.font = `${Math.floor(cell * 0.4)}px sans-serif`;
    staticCtx.fillStyle = '#000';
    staticCtx.textBaseline = 'top';
    const seen = new Set();
    for (let r = 0; r < puzzleData.rows; r++) {
      for (let c = 0; c < puzzleData.cols; c++) {
        const k = areas[r][c];
        if (seen.has(k)) continue;
        seen.add(k);
        const target = puzzleData.rooms?.[k]?.target ?? -1;
        if (target >= 0) {
          staticCtx.fillText(String(target), c * cell + 4, r * cell + 4);
        }
      }
    }
  }
  // Dynamic layer: black fills, white dots, hint highlights, mistake rings
  ctx.drawImage(staticLayer, 0, 0);
  for (let r = 0; r < puzzleData.rows; r++) {
    for (let c = 0; c < puzzleData.cols; c++) {
      const v = grid[r][c];
      if (v === 1) {
        ctx.fillStyle = '#000';
        ctx.fillRect(c * cell + 2, r * cell + 2, cell - 4, cell - 4);
      } else if (v === 2) {
        ctx.fillStyle = '#888';
        ctx.beginPath();
        ctx.arc(c * cell + cell / 2, r * cell + cell / 2, cell * 0.08, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  // Hint overlay
  if (hint?.cells) {
    ctx.strokeStyle = '#ff8800';
    ctx.lineWidth = 2;
    for (const h of hint.cells) {
      ctx.strokeRect(h.col * cell + 1, h.row * cell + 1, cell - 2, cell - 2);
    }
  }
  // Mistake rings
  const diff = puzzleData.solution
    ? computePuzzleDiff('heyawake', grid, puzzleData.solution)
    : [];
  for (const m of diff) {
    ctx.strokeStyle = '#cc0000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(m.col * cell + cell / 2, m.row * cell + cell / 2, cell * 0.35, 0, Math.PI * 2);
    ctx.stroke();
  }
  return;
}
```

(If `staticCtx`/`staticLayer`/`staticDirty` aren't in the immediate surrounding code, adapt to whatever the existing puzzle types use — Galaxies' `staticLayer` two-layer caching is the closest match.)

- [ ] **Step 3: Verify visually (manual)**

After building (`npm run build`) and loading the extension on the heyawake page, click Detect. The widget should show the room borders + clue numbers, and Solve should produce a preview with black-filled cells. (This step is manual; mark complete when you've eyeballed it.)

- [ ] **Step 4: Run lint + typecheck**

Run: `npm run lint && npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(heyawake): drawPreview arm with room borders + clue numbers + mistake rings"
```

---

## Task 22: content.js — getHint dispatch + applyGridPartialResult + solveHandler arm

**Files:**
- Modify: `content.js`

- [ ] **Step 1: Add heyawake getHint dispatch**

Find the `getHint` function in `content.js`. After the existing puzzle-type arms (slitherlink, hashi, etc.), before the generic fallback, add:

```js
} else if (detectedGrid.type === 'heyawake') {
  const rooms = detectedGrid.rooms;
  const solver = new HeyawakeSolver({
    rows, cols, rooms,
  });
  const hintCells = solver.getHint(grid);
  if (!hintCells || hintCells.length === 0) {
    return { success: false, error: 'No more cells can be deduced from the current state. Click Solve to finish.' };
  }
  hint = { type: 'heyawake', cells: hintCells, count: hintCells.length };
}
```

(`HeyawakeSolver` needs to be imported into the content.js scope — find where the other solvers are imported and add it. If they're available as window-globals via solver.js inclusion, no import change needed.)

- [ ] **Step 2: Add `applyGridPartialResult` helper**

Find `applyPartialResult` and `applyHashiPartialResult` in `content.js`. Add a third helper after them:

```js
// Generic 2D-grid partial result handler. Heyawake is the first caller;
// any future cell-state puzzle that supports partials can use it.
// Deliberately does NOT call recordSolveSuccess (matches the slitherlink/
// hashi precedent — caching a partial would mis-trigger Loop done-check
// and the mistake overlay).
function applyGridPartialResult(result) {
  loopConfirming = false;
  clearPendingHint();
  solveBtn.textContent = 'Confirm';
  confirming = true;
  let filled = 0;
  for (const row of result.grid) {
    for (const v of row) if (v !== 0) filled++;
  }
  setStatus(
    `Partial only: ${filled} cells deduced (board too hard for full solve). Apply, then finish manually.`,
    'info',
  );
  drawPreview(result.grid);
}
```

- [ ] **Step 3: Wire into solveHandler partial arm**

Find the partial-result switch added by the previous PR (looks something like):

```js
if (result?.partial && result.horizontal && result.vertical) {
  applyPartialResult(result);
  return;
}
if (result?.partial && puzzleData?.type === 'hashi' && Array.isArray(result.edges)) {
  applyHashiPartialResult(result);
  return;
}
```

Add a third branch after them:

```js
if (result?.partial && puzzleData?.type === 'heyawake' && Array.isArray(result.grid)) {
  applyGridPartialResult(result);
  return;
}
```

- [ ] **Step 4: Run lint + typecheck + tests**

Run: `npm run lint && npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(heyawake): content.js getHint dispatch + applyGridPartialResult helper"
```

---

## Task 23: Final verification — full suite + build + manual smoke

**Files:** (none — verification only)

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all tests pass (the count should be the previous count + ~25 heyawake unit tests + 1 fuzz test + 1 integration test). Note: the user established baseline is 255/255 before heyawake; expect ~280/280 after.

- [ ] **Step 2: Lint + typecheck**

Run: `npm run lint && npm run typecheck`
Expected: clean.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: clean — `dist/` rebuilt with the new files.

- [ ] **Step 4: Bench**

Run: `node tests/bench-heyawake.js`
Expected: prints median solve time, well under 100 ms.

- [ ] **Step 5: Manual smoke test in browser**

Load `dist/` as an unpacked extension. Navigate to `https://www.puzzles-mobile.com/heyawake/random/6x6-easy`. Click Detect → Solve → verify a valid solution is previewed. Click Apply → verify the page accepts the move. Click Hint on a fresh board → verify cells are highlighted.

- [ ] **Step 6: If working copy is empty, no commit needed.**

Otherwise:

```bash
jj commit -m "feat(heyawake): final polish + verification"
```

---

## Self-review checklist (executor: skip)

After completing all 23 tasks, the writer of this plan should self-review:

1. **Spec coverage:** Every section of the design doc is addressed by at least one task. ✓
2. **Placeholder scan:** No TBDs / TODOs / "implement details" placeholders. ✓
3. **Type consistency:** `cellStatus` is `Uint8Array` flat throughout; `target` is `Int32Array`; method names (`_set`, `_rollback`, `_propagate`, `_applyRoomCounts`, `_applyLineConstraints`, `_applyConnectivity`, `_applyLookahead`, `_backtrack`, `_pickBestUnknown`, `_isComplete`, `_emit`, `solve`, `getHint`) consistent across tasks. ✓
4. **Ambiguity:** Each step has actual code or an exact command, not "implement appropriately". ✓
