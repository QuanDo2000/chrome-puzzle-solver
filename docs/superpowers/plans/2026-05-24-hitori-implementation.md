# Hitori Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full Hitori support (`/hitori/*`) to the Chrome MV3 extension — solver, MAIN-world fns, handler, worker, content.js wire-up, tests, bench. Matches the parity of the 9 existing puzzle types.

**Architecture:** `HitoriSolver` follows the Heyawake pattern verbatim — flat `Uint8Array` cellStatus (0/1/2), trail-based undo, propagate-then-backtrack with top-level lookahead, partial-on-timeout cache. Three propagation rules: **static sandwich/triplet pre-pass** (`X-?-X` middle is forced white), **uniqueness** (row/col digit no-duplicates over unshaded), and **white connectivity** (BFS + articulation, code-cloned from `HeyawakeSolver._applyConnectivity`). No-adjacent-blacks is eager in `_set`. Rooms-with-targets become a 2D digit grid (`task`).

**Tech Stack:** Vanilla JS (MV3), `node:test`, `jj` for commits (never plain `git`).

**Reference spec:** `docs/superpowers/specs/2026-05-24-hitori-design.md`
**Reference solver to clone from:** `HeyawakeSolver` (cellStatus encoding, `_set` adjacency cascade, `_applyConnectivity`, `_applyLookahead`, `_backtrack`, cache helpers — all directly portable).

Run a single test file with `node --test tests/hitori.test.js`. Full suite: `npm test`.

**`jj` for commits** — every commit step uses `jj commit -m "..."` (which finalizes the current change and starts a new empty one). Never `git commit`/`git add`/`git status`.

---

## Task 1: HitoriSolver scaffold (constructor + _set with adjacency + _rollback + _timeUp)

**Files:**
- Modify: `solver.js` (append a new class after `HeyawakeSolver`, before `module.exports`)
- Test: `tests/hitori.test.js` (new)

Combines Heyawake's tasks 1+3 since the adjacency cascade in `_set` is identical (cellStatus encoding matches exactly).

- [ ] **Step 1: Create the failing test file**

Create `tests/hitori.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { HitoriSolver } = require('../solver.js');

test('HitoriSolver: constructor mirrors task and initialState', () => {
  const s = new HitoriSolver({
    rows: 2, cols: 2,
    task: [[5, 3], [3, 5]],
    initialState: [[0, 1], [2, 0]],
  });
  assert.equal(s.rows, 2);
  assert.equal(s.cols, 2);
  assert.equal(s.cellStatus[0], 0);
  assert.equal(s.cellStatus[1], 1);
  assert.equal(s.cellStatus[2], 2);
  assert.equal(s.cellStatus[3], 0);
  assert.equal(s.task[0], 5);
  assert.equal(s.task[1], 3);
  assert.equal(s.task[2], 3);
  assert.equal(s.task[3], 5);
});

test('HitoriSolver._set: black write forces 4-neighbours to white', () => {
  const s = new HitoriSolver({
    rows: 3, cols: 3, task: [[1,2,3],[4,5,6],[7,8,9]],
  });
  assert.equal(s._set(4, 1), true);
  assert.equal(s.cellStatus[1], 2);
  assert.equal(s.cellStatus[3], 2);
  assert.equal(s.cellStatus[5], 2);
  assert.equal(s.cellStatus[7], 2);
  assert.equal(s.cellStatus[0], 0);
});

test('HitoriSolver._set: black-next-to-black → contradiction', () => {
  const s = new HitoriSolver({
    rows: 1, cols: 2, task: [[1, 2]],
    initialState: [[1, 0]],
  });
  assert.equal(s._set(1, 1), false);
});

test('HitoriSolver._set / _rollback round-trip', () => {
  const s = new HitoriSolver({ rows: 1, cols: 2, task: [[1, 2]] });
  const mark = s.trail.length;
  assert.equal(s._set(0, 2), true);
  assert.equal(s.cellStatus[0], 2);
  s._rollback(mark);
  assert.equal(s.cellStatus[0], 0);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `node --test tests/hitori.test.js`
Expected: FAIL — `HitoriSolver is not defined`.

- [ ] **Step 3: Add HitoriSolver scaffold to solver.js**

Find the `module.exports = { ..., HeyawakeSolver, computePuzzleDiff };` line. Insert the new class BEFORE that line (after `HeyawakeSolver`'s closing `}`):

```js
class HitoriSolver {
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

Then update the `module.exports` to include `HitoriSolver`:

```js
module.exports = { NonogramSolver, AquariumSolver, GalaxiesSolver, BinairoSolver, ShikakuSolver, YinYangSolver, SlitherlinkSolver, HashiSolver, HeyawakeSolver, HitoriSolver, computePuzzleDiff };
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test tests/hitori.test.js`
Expected: 4 tests passing.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(hitori): HitoriSolver scaffold with adjacency-cascade _set"
```

---

## Task 2: Static sandwich/triplet pre-rule

**Files:**
- Modify: `solver.js` (add `_buildStaticForcedWhites` + call from constructor + `_applyStaticForcedWhites`)
- Test: `tests/hitori.test.js` (append)

Scan rows and columns: for any cell whose flanks (left+right or top+bottom) have the same `task` value, the cell is forced white. Build the list at constructor time; the application method writes them to cellStatus.

- [ ] **Step 1: Write failing tests**

Append:

```js
test('HitoriSolver._buildStaticForcedWhites: sandwich X-Y-X forces middle white', () => {
  const s = new HitoriSolver({
    rows: 1, cols: 3,
    task: [[5, 3, 5]],
  });
  // Middle cell (col 1, idx 1) must be in the forced-white list.
  assert.ok(Array.from(s.staticForcedWhites).includes(1),
    `expected idx 1 in staticForcedWhites; got ${Array.from(s.staticForcedWhites)}`);
});

test('HitoriSolver._buildStaticForcedWhites: triplet X-X-X forces middle white', () => {
  const s = new HitoriSolver({
    rows: 1, cols: 3,
    task: [[7, 7, 7]],
  });
  assert.ok(Array.from(s.staticForcedWhites).includes(1));
});

test('HitoriSolver._buildStaticForcedWhites: vertical sandwich on column', () => {
  const s = new HitoriSolver({
    rows: 3, cols: 1,
    task: [[5], [3], [5]],
  });
  // Middle cell (row 1, idx 1) forced white via vertical flank match.
  assert.ok(Array.from(s.staticForcedWhites).includes(1));
});

test('HitoriSolver._applyStaticForcedWhites: writes forced-white cells', () => {
  const s = new HitoriSolver({
    rows: 1, cols: 3,
    task: [[5, 3, 5]],
  });
  assert.equal(s._applyStaticForcedWhites(), true);
  assert.equal(s.cellStatus[1], 2);
});

test('HitoriSolver._applyStaticForcedWhites: existing black at forced-white spot → contradiction', () => {
  const s = new HitoriSolver({
    rows: 1, cols: 3,
    task: [[5, 3, 5]],
    initialState: [[0, 1, 0]],
  });
  assert.equal(s._applyStaticForcedWhites(), false);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `node --test tests/hitori.test.js`
Expected: 5 failing tests — `staticForcedWhites` / `_applyStaticForcedWhites` undefined.

- [ ] **Step 3: Implement**

Add inside `HitoriSolver`:

```js
_buildStaticForcedWhites() {
  const forced = [];
  // Row scans: positions 1..cols-2 where task[r][c-1] === task[r][c+1].
  for (let r = 0; r < this.rows; r++) {
    for (let c = 1; c < this.cols - 1; c++) {
      const left = this.task[r * this.cols + c - 1];
      const right = this.task[r * this.cols + c + 1];
      if (left === right) {
        forced.push(r * this.cols + c);
      }
    }
  }
  // Column scans: positions 1..rows-2 where task[r-1][c] === task[r+1][c].
  for (let c = 0; c < this.cols; c++) {
    for (let r = 1; r < this.rows - 1; r++) {
      const up = this.task[(r - 1) * this.cols + c];
      const down = this.task[(r + 1) * this.cols + c];
      if (up === down) {
        const idx = r * this.cols + c;
        if (!forced.includes(idx)) forced.push(idx);
      }
    }
  }
  this.staticForcedWhites = new Int32Array(forced);
}

_applyStaticForcedWhites() {
  for (let i = 0; i < this.staticForcedWhites.length; i++) {
    const idx = this.staticForcedWhites[i];
    if (this.cellStatus[idx] === 0) {
      if (!this._set(idx, 2)) return false;
    } else if (this.cellStatus[idx] !== 2) {
      return false; // already black at a forced-white spot
    }
  }
  return true;
}
```

Then call `_buildStaticForcedWhites` at the end of the constructor, before `this._startedAt = 0;`:

```js
this._buildStaticForcedWhites();
this._startedAt = 0;
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test tests/hitori.test.js`
Expected: 9 tests passing.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(hitori): static sandwich/triplet pre-rule"
```

---

## Task 3: Uniqueness propagation

**Files:**
- Modify: `solver.js` (add `_buildBuckets` + call from constructor + `_applyUniqueness`)
- Test: `tests/hitori.test.js` (append)

For each (row, value), precompute the list of cells with that value. Same for columns. At propagation: if multiple whites in a bucket → contradiction; if exactly one white + unknowns → force unknowns black.

- [ ] **Step 1: Write failing tests**

Append:

```js
test('HitoriSolver._applyUniqueness: two whites with same value in row → contradiction', () => {
  const s = new HitoriSolver({
    rows: 1, cols: 3,
    task: [[5, 3, 5]],
    initialState: [[2, 0, 2]],
  });
  assert.equal(s._applyUniqueness(), false);
});

test('HitoriSolver._applyUniqueness: one white + one unknown same value → unknown forced black', () => {
  const s = new HitoriSolver({
    rows: 1, cols: 4,
    task: [[5, 3, 5, 2]],
    initialState: [[2, 0, 0, 0]], // (0,0) white, (0,2) unknown but same value → black
  });
  assert.equal(s._applyUniqueness(), true);
  assert.equal(s.cellStatus[2], 1);
});

test('HitoriSolver._applyUniqueness: unique row values → no force', () => {
  const s = new HitoriSolver({
    rows: 1, cols: 3,
    task: [[1, 2, 3]],
  });
  assert.equal(s._applyUniqueness(), true);
  assert.equal(s.cellStatus[0], 0);
  assert.equal(s.cellStatus[1], 0);
  assert.equal(s.cellStatus[2], 0);
});

test('HitoriSolver._applyUniqueness: column uniqueness', () => {
  const s = new HitoriSolver({
    rows: 3, cols: 1,
    task: [[5], [3], [5]],
    initialState: [[2], [0], [0]], // top white, bottom unknown but same value → bottom black
  });
  assert.equal(s._applyUniqueness(), true);
  assert.equal(s.cellStatus[2], 1);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `node --test tests/hitori.test.js`
Expected: 4 failures — `_applyUniqueness` undefined.

- [ ] **Step 3: Implement**

Add inside `HitoriSolver`:

```js
_buildBuckets() {
  // rowBuckets[r] = Map<value, number[]>
  this.rowBuckets = new Array(this.rows);
  for (let r = 0; r < this.rows; r++) {
    const m = new Map();
    for (let c = 0; c < this.cols; c++) {
      const idx = r * this.cols + c;
      const v = this.task[idx];
      if (!m.has(v)) m.set(v, []);
      m.get(v).push(idx);
    }
    this.rowBuckets[r] = m;
  }
  this.colBuckets = new Array(this.cols);
  for (let c = 0; c < this.cols; c++) {
    const m = new Map();
    for (let r = 0; r < this.rows; r++) {
      const idx = r * this.cols + c;
      const v = this.task[idx];
      if (!m.has(v)) m.set(v, []);
      m.get(v).push(idx);
    }
    this.colBuckets[c] = m;
  }
}

_applyUniquenessBucket(idxs) {
  let nW = 0, nU = 0;
  for (let i = 0; i < idxs.length; i++) {
    const v = this.cellStatus[idxs[i]];
    if (v === 2) nW++;
    else if (v === 0) nU++;
  }
  if (nW > 1) return false;
  if (nW === 1 && nU > 0) {
    for (let i = 0; i < idxs.length; i++) {
      if (this.cellStatus[idxs[i]] === 0) {
        if (!this._set(idxs[i], 1)) return false;
      }
    }
  }
  return true;
}

_applyUniqueness() {
  for (let r = 0; r < this.rows; r++) {
    for (const idxs of this.rowBuckets[r].values()) {
      if (idxs.length < 2) continue;
      if (!this._applyUniquenessBucket(idxs)) return false;
    }
  }
  for (let c = 0; c < this.cols; c++) {
    for (const idxs of this.colBuckets[c].values()) {
      if (idxs.length < 2) continue;
      if (!this._applyUniquenessBucket(idxs)) return false;
    }
  }
  return true;
}
```

Then call `_buildBuckets()` from the constructor (after `_buildStaticForcedWhites`):

```js
this._buildStaticForcedWhites();
this._buildBuckets();
this._startedAt = 0;
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test tests/hitori.test.js`
Expected: 13 tests passing.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(hitori): row+column uniqueness propagation"
```

---

## Task 4: White connectivity (BFS + articulation, cloned from Heyawake)

**Files:**
- Modify: `solver.js` (add `_applyConnectivity` to `HitoriSolver`)
- Test: `tests/hitori.test.js` (append)

Direct port from `HeyawakeSolver._applyConnectivity`. The rule is identical (white=2, black=1), so the code transfers verbatim.

- [ ] **Step 1: Write failing tests**

Append:

```js
test('HitoriSolver._applyConnectivity: blacks splitting whites → contradiction', () => {
  const s = new HitoriSolver({
    rows: 3, cols: 3,
    task: [[1,2,3],[4,5,6],[7,8,9]],
  });
  s.cellStatus[0] = 2; s.cellStatus[1] = 1; s.cellStatus[2] = 2;
  s.cellStatus[3] = 1; s.cellStatus[4] = 1; s.cellStatus[5] = 1;
  s.cellStatus[6] = 2; s.cellStatus[7] = 1; s.cellStatus[8] = 2;
  assert.equal(s._applyConnectivity(), false);
});

test('HitoriSolver._applyConnectivity: articulation unknown forced white', () => {
  const s = new HitoriSolver({
    rows: 3, cols: 3,
    task: [[1,2,3],[4,5,6],[7,8,9]],
  });
  s.cellStatus[0] = 2; s.cellStatus[2] = 2;
  s.cellStatus[3] = 1; s.cellStatus[5] = 1;
  s.cellStatus[6] = 2; s.cellStatus[8] = 2;
  assert.equal(s._applyConnectivity(), true);
  assert.equal(s.cellStatus[4], 2);
});

test('HitoriSolver._applyConnectivity: skipped inside lookahead', () => {
  const s = new HitoriSolver({
    rows: 3, cols: 3,
    task: [[1,2,3],[4,5,6],[7,8,9]],
  });
  s.cellStatus[0] = 2; s.cellStatus[2] = 2;
  s.cellStatus[3] = 1; s.cellStatus[5] = 1;
  s.cellStatus[6] = 2; s.cellStatus[8] = 2;
  s._inLookahead = true;
  assert.equal(s._applyConnectivity(), true);
  assert.equal(s.cellStatus[4], 0);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `node --test tests/hitori.test.js`
Expected: 3 failures.

- [ ] **Step 3: Implement (clone from HeyawakeSolver._applyConnectivity verbatim)**

Add inside `HitoriSolver`:

```js
_applyConnectivity() {
  const total = this.rows * this.cols;
  let anchor = -1;
  for (let i = 0; i < total; i++) {
    if (this.cellStatus[i] === 2) { anchor = i; break; }
  }
  if (anchor < 0) return true;
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
  const disc = new Int32Array(total).fill(-1);
  const low = new Int32Array(total);
  const parent = new Int32Array(total).fill(-1);
  const subtreeKnownWhite = new Int32Array(total);
  const articulationSplits = new Int32Array(total);
  let timer = 0;
  const dfsStack = [];
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
  disc[anchor] = low[anchor] = timer++;
  subtreeKnownWhite[anchor] = (this.cellStatus[anchor] === 2 ? 1 : 0);
  dfsStack.push({ u: anchor, ns: neighboursOf(anchor), idx: 0 });
  let rootChildCount = 0;
  while (dfsStack.length) {
    const top = dfsStack[dfsStack.length - 1];
    if (top.idx >= top.ns.length) {
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
  const totalKnownWhites = subtreeKnownWhite[anchor];
  for (let u = 0; u < total; u++) {
    if (this.cellStatus[u] !== 0) continue;
    if (disc[u] < 0) continue;
    let critical = false;
    if (u === anchor) {
      critical = (rootChildCount >= 2 && articulationSplits[u] >= 2);
    } else {
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

Run: `node --test tests/hitori.test.js`
Expected: 16 tests passing.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(hitori): white-connectivity rule (BFS + articulation)"
```

---

## Task 5: Propagate orchestrator + lookahead

**Files:**
- Modify: `solver.js` (add `_propagate`, `_applyLookahead`)
- Test: `tests/hitori.test.js` (append)

`_propagate` iterates the four rules to fixpoint, then calls lookahead at top level. `_applyLookahead` probes each unknown with each value, forces survivor.

- [ ] **Step 1: Failing test**

Append:

```js
test('HitoriSolver._propagate: cascades static + uniqueness', () => {
  // Row [5,3,5]: sandwich forces middle white. Then uniqueness with white=3:
  // task[1]=3 is the only 3 in row → no conflict. But row also has two 5's
  // at cols 0,2; one already white via... wait, sandwich forces col 1 (value 3)
  // to white. So cells: ?, W, ?. The two 5's at cols 0,2 are still unknown.
  // Uniqueness on value 5: 2 cells, both unknown — no immediate force.
  // No further deduction at propagate level. Verify _propagate returns true
  // and at least col 1 is white.
  const s = new HitoriSolver({
    rows: 1, cols: 3,
    task: [[5, 3, 5]],
  });
  assert.equal(s._propagate(), true);
  assert.equal(s.cellStatus[1], 2);
});

test('HitoriSolver._propagate: returns false on contradictory input', () => {
  const s = new HitoriSolver({
    rows: 1, cols: 3,
    task: [[5, 3, 5]],
    initialState: [[2, 0, 2]], // two whites of value 5
  });
  assert.equal(s._propagate(), false);
});
```

- [ ] **Step 2: Run, verify failure**

- [ ] **Step 3: Implement**

Add inside `HitoriSolver`:

```js
_propagate() {
  let changedOverall = true;
  while (changedOverall) {
    if (this._timeUp()) return true;
    changedOverall = false;
    const mark = this.trail.length;
    if (!this._applyStaticForcedWhites()) return false;
    if (!this._applyUniqueness()) return false;
    if (!this._applyConnectivity()) return false;
    if (this.trail.length > mark) changedOverall = true;
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

- [ ] **Step 4: Run, verify pass**

Run: `node --test tests/hitori.test.js`
Expected: 18 tests passing.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(hitori): _propagate orchestrator + top-level lookahead"
```

---

## Task 6: solve() + backtracking + caches + _isComplete + _emit + computePuzzleDiff arm

**Files:**
- Modify: `solver.js` (add `_isComplete`, `_emit`, `_pickBestUnknown`, `_backtrack`, `solve`, static caches, `_cacheKey`, `_cloneResult`, `_storeInCache`, `clearSolutionCache`; extend `computePuzzleDiff` for `'hitori'`)
- Test: `tests/hitori.test.js` (append)

- [ ] **Step 1: Failing tests**

Append:

```js
test('HitoriSolver.solve: solves the recon 5x5', () => {
  HitoriSolver.clearSolutionCache();
  const task = [
    [5,5,2,3,3],
    [2,5,4,4,3],
    [4,4,1,5,2],
    [1,2,5,4,5],
    [1,4,5,5,1],
  ];
  const expected = [
    [2,1,2,2,1],
    [2,2,2,1,2],
    [2,1,2,2,2],
    [2,2,1,2,2],
    [1,2,2,1,2],
  ];
  const s = new HitoriSolver({ rows:5, cols:5, task });
  const r = s.solve();
  assert.equal(r.solved, true);
  assert.deepEqual(r.grid, expected);
});

test('HitoriSolver.solve: returns {solved:false, grid:null} on unsat', () => {
  HitoriSolver.clearSolutionCache();
  const s = new HitoriSolver({
    rows: 1, cols: 3,
    task: [[5, 3, 5]],
    initialState: [[2, 0, 2]],
  });
  const r = s.solve();
  assert.equal(r.solved, false);
  assert.equal(r.grid, null);
});

test('HitoriSolver._solutionCache: cache hit returns deep copy', () => {
  HitoriSolver.clearSolutionCache();
  const task = [[5,5,2,3,3],[2,5,4,4,3],[4,4,1,5,2],[1,2,5,4,5],[1,4,5,5,1]];
  const a = new HitoriSolver({ rows:5, cols:5, task }).solve();
  a.grid[0][0] = 99;
  const b = new HitoriSolver({ rows:5, cols:5, task }).solve();
  assert.notEqual(b.grid[0][0], 99);
});

test('computePuzzleDiff hitori: flags wrong-color cells, ignores unknown', () => {
  const { computePuzzleDiff } = require('../solver.js');
  const solution = [[1, 2], [2, 1]];
  const board = [[2, 2], [0, 1]];
  const diff = computePuzzleDiff('hitori', board, solution);
  assert.equal(diff.length, 1);
  assert.deepEqual(diff[0], { row: 0, col: 0, expected: 1, actual: 2 });
});
```

- [ ] **Step 2: Run, verify failure**

- [ ] **Step 3: Implement**

Add inside `HitoriSolver` (before any static fields):

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
    const r = (i / this.cols) | 0;
    const c = i - r * this.cols;
    const v = this.task[i];
    const rowBucket = this.rowBuckets[r].get(v);
    const colBucket = this.colBuckets[c].get(v);
    let bestTight = 0;
    for (const idxs of [rowBucket, colBucket]) {
      if (!idxs || idxs.length < 2) continue;
      let unk = 0;
      for (let j = 0; j < idxs.length; j++) {
        if (this.cellStatus[idxs[j]] === 0) unk++;
      }
      const t = 1 / (unk + 1);
      if (t > bestTight) bestTight = t;
    }
    let adj = 0;
    if (r > 0 && this.cellStatus[i - this.cols] !== 0) adj++;
    if (r < this.rows - 1 && this.cellStatus[i + this.cols] !== 0) adj++;
    if (c > 0 && this.cellStatus[i - 1] !== 0) adj++;
    if (c < this.cols - 1 && this.cellStatus[i + 1] !== 0) adj++;
    const score = bestTight * 4 + adj;
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
  const cached = HitoriSolver._solutionCache.get(key)
              || HitoriSolver._partialCache.get(key);
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

After `solve()` and before the closing `}` of the class, add the static fields and helpers:

```js
static _solutionCache = new Map();
static _maxSolutionCache = 50;
static _partialCache = new Map();
static _maxPartialCache = 20;
static clearSolutionCache() {
  HitoriSolver._solutionCache.clear();
  HitoriSolver._partialCache.clear();
}

_cacheKey() {
  let h = 0x811c9dc5;
  const mix = (n) => { h ^= n & 0xff; h = Math.imul(h, 0x01000193) >>> 0; };
  mix(this.rows); mix(this.cols);
  for (let i = 0; i < this.rows * this.cols; i++) mix(this.task[i]);
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
  const m = result.partial ? HitoriSolver._partialCache : HitoriSolver._solutionCache;
  const max = result.partial ? HitoriSolver._maxPartialCache : HitoriSolver._maxSolutionCache;
  if (m.size >= max) {
    const first = m.keys().next().value;
    m.delete(first);
  }
  m.set(key, this._cloneResult(result));
}
```

Finally, extend `computePuzzleDiff` in `solver.js`. Find the heyawake arm (added in T13 of the heyawake plan). Either:
- The heyawake arm uses a `type === 'heyawake'` explicit check — add `|| type === 'hitori'` to make it also cover hitori, OR
- Add a parallel `'hitori'` arm with the same shape (`{row, col, expected, actual}`).

Either is fine; the easier option is `if (type === 'heyawake' || type === 'hitori') { ... }`.

- [ ] **Step 4: Run, verify pass**

Run: `node --test tests/hitori.test.js`
Expected: 22 tests passing.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(hitori): solve() with MC backtracking + caches + computePuzzleDiff arm"
```

---

## Task 7: Stepwise getHint

**Files:**
- Modify: `solver.js` (add `getHint`)
- Test: `tests/hitori.test.js` (append)

Same shape as the just-shipped Heyawake stepwise getHint. Rule-by-rule, returning at first firing.

- [ ] **Step 1: Failing tests**

Append:

```js
test('HitoriSolver.getHint: sandwich/triplet emit on first call', () => {
  HitoriSolver.clearSolutionCache();
  const s = new HitoriSolver({
    rows: 1, cols: 3,
    task: [[5, 3, 5]],
  });
  const hint = s.getHint([[0, 0, 0]]);
  assert.ok(Array.isArray(hint));
  assert.ok(hint.length >= 1);
  // Middle cell (col 1) must be in the hint (forced white).
  const mid = hint.find(h => h.row === 0 && h.col === 1);
  assert.ok(mid, `expected (0,1) in hint; got ${JSON.stringify(hint)}`);
  assert.equal(mid.value, 2);
});

test('HitoriSolver.getHint: null on solved board', () => {
  HitoriSolver.clearSolutionCache();
  const s = new HitoriSolver({
    rows: 1, cols: 3,
    task: [[5, 3, 5]],
  });
  // Solved: black, white, black would violate adjacency at distance 2 — no.
  // Actually for a 1×3 with task [5,3,5]: middle forced white by sandwich,
  // ends are both 5 so at most one can be unshaded. Both ends black? Then
  // they're not adjacent (col 0 vs col 2 with middle separating). Whites:
  // only the middle. Solution: [1, 2, 1].
  assert.equal(s.getHint([[1, 2, 1]]), null);
});

test('HitoriSolver.getHint: stepwise — small batch per call on 5x5', () => {
  HitoriSolver.clearSolutionCache();
  const task = [
    [5,5,2,3,3],
    [2,5,4,4,3],
    [4,4,1,5,2],
    [1,2,5,4,5],
    [1,4,5,5,1],
  ];
  const s = new HitoriSolver({ rows:5, cols:5, task });
  const empty = Array.from({length:5}, () => new Array(5).fill(0));
  const hint = s.getHint(empty);
  assert.ok(Array.isArray(hint));
  assert.ok(hint.length >= 1);
  assert.ok(hint.length <= 8, `expected ≤ 8 cells; got ${hint.length}`);
});
```

- [ ] **Step 2: Run, verify failure**

- [ ] **Step 3: Implement**

Add inside `HitoriSolver`:

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

  // Rule 1: static sandwich/triplet — apply, return batch.
  if (!this._applyStaticForcedWhites()) return null;
  {
    const h = collectChanged();
    if (h.length) return h;
  }

  // Rule 2: uniqueness per row-bucket, then col-bucket. Stop at first firing.
  for (let r = 0; r < this.rows; r++) {
    for (const idxs of this.rowBuckets[r].values()) {
      if (idxs.length < 2) continue;
      if (!this._applyUniquenessBucket(idxs)) return null;
      const h = collectChanged();
      if (h.length) return h;
    }
  }
  for (let c = 0; c < this.cols; c++) {
    for (const idxs of this.colBuckets[c].values()) {
      if (idxs.length < 2) continue;
      if (!this._applyUniquenessBucket(idxs)) return null;
      const h = collectChanged();
      if (h.length) return h;
    }
  }

  // Rule 3: connectivity.
  if (!this._applyConnectivity()) return null;
  {
    const h = collectChanged();
    if (h.length) return h;
  }

  // Rule 4: single lookahead probe.
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

- [ ] **Step 4: Run, verify pass**

Run: `node --test tests/hitori.test.js`
Expected: 25 tests passing.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(hitori): stepwise getHint"
```

---

## Task 8: Fuzz soundness test

**Files:**
- Create: `tests/hitori-fuzz.test.js`

Random Hitori-like puzzles: pick a random shaded pattern that satisfies the 3 rules, derive the digit grid that requires it. Validate every solved result.

- [ ] **Step 1: Create the fuzz test**

Create `tests/hitori-fuzz.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { HitoriSolver } = require('../solver.js');

// Generate a random valid (rows×cols) Hitori shading: random pattern that
// satisfies (a) no two adjacent blacks, (b) all whites connected. Then
// build a digit grid where each row's unshaded cells have unique values
// and each column's unshaded cells have unique values. This guarantees a
// satisfiable puzzle.
function generatePuzzle(rows, cols, seed) {
  let rng = seed >>> 0;
  const rand = () => {
    rng = (rng * 1103515245 + 12345) >>> 0;
    return rng / 0x100000000;
  };
  // Start with all white; randomly shade cells respecting adjacency.
  const shade = Array.from({ length: rows }, () => new Array(cols).fill(0));
  const cells = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push([r, c]);
  // Shuffle
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  for (const [r, c] of cells) {
    if (rand() > 0.3) continue;
    // Adjacency check
    if (r > 0 && shade[r-1][c] === 1) continue;
    if (r < rows-1 && shade[r+1][c] === 1) continue;
    if (c > 0 && shade[r][c-1] === 1) continue;
    if (c < cols-1 && shade[r][c+1] === 1) continue;
    // Connectivity check: removing this cell from whites must keep whites connected.
    shade[r][c] = 1;
    if (!whitesConnected(shade, rows, cols)) shade[r][c] = 0;
  }
  // Build task grid: each row's unshaded cells get a permutation of [1..K]
  // for some K. To make uniqueness trivially satisfiable, assign each
  // unshaded cell a value 1..(rowUnshadedCount) per row, then permute.
  // For shaded cells, assign a duplicate of an existing unshaded value in
  // the same row to make uniqueness force shading (or any value; the
  // solver doesn't see "shaded" in the input).
  const task = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let r = 0; r < rows; r++) {
    let n = 1;
    for (let c = 0; c < cols; c++) {
      if (shade[r][c] === 0) task[r][c] = n++;
    }
  }
  // For shaded cells, pick any value already in the row (duplicate) so the
  // uniqueness rule forces the cell to be shaded.
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (shade[r][c] !== 1) continue;
      // Find any unshaded value in this row; use the first one.
      for (let c2 = 0; c2 < cols; c2++) {
        if (shade[r][c2] === 0) { task[r][c] = task[r][c2]; break; }
      }
    }
  }
  // The puzzle's solver should reproduce `shade` (1=black, 2=white). Build
  // the expected cellStatus:
  const expected = shade.map(row => row.map(v => v === 1 ? 1 : 2));
  return { task, expected };
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
  // Rule 1: row uniqueness on whites
  for (let r = 0; r < rows; r++) {
    const seen = new Set();
    for (let c = 0; c < cols; c++) {
      if (grid[r][c] !== 2) continue;
      const v = task[r][c];
      if (seen.has(v)) return `rule 1 row: duplicate ${v} at (${r},${c})`;
      seen.add(v);
    }
  }
  // Rule 1: col uniqueness on whites
  for (let c = 0; c < cols; c++) {
    const seen = new Set();
    for (let r = 0; r < rows; r++) {
      if (grid[r][c] !== 2) continue;
      const v = task[r][c];
      if (seen.has(v)) return `rule 1 col: duplicate ${v} at (${r},${c})`;
      seen.add(v);
    }
  }
  // Rule 2: no adjacent blacks
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (grid[r][c] !== 1) continue;
    if (r > 0 && grid[r-1][c] === 1) return `rule 2 at (${r-1},${c})-(${r},${c})`;
    if (c > 0 && grid[r][c-1] === 1) return `rule 2 at (${r},${c-1})-(${r},${c})`;
  }
  // Rule 3: whites connected
  let anchor = -1;
  for (let r = 0; r < rows && anchor < 0; r++) for (let c = 0; c < cols; c++) {
    if (grid[r][c] === 2) { anchor = r * cols + c; break; }
  }
  if (anchor < 0) return null;
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
    if (grid[r][c] === 2 && !visited[r * cols + c]) return `rule 3: white at (${r},${c}) disconnected`;
  }
  return null;
}

test('HitoriSolver fuzz: solved boards satisfy all 3 rules', () => {
  HitoriSolver.clearSolutionCache();
  let solved = 0;
  for (let seed = 1; seed <= 30; seed++) {
    HitoriSolver.clearSolutionCache();
    const rows = 4 + (seed % 3);
    const cols = 4 + ((seed >> 2) % 3);
    const { task } = generatePuzzle(rows, cols, seed * 9173 + 1);
    const s = new HitoriSolver({ rows, cols, task, maxMs: 2000 });
    const r = s.solve();
    if (!r.solved) continue;
    const err = validate(rows, cols, task, r.grid);
    assert.equal(err, null, `seed=${seed} ${rows}x${cols}: ${err}`);
    solved++;
  }
  assert.ok(solved >= 10, `expected ≥ 10 solved boards, got ${solved}`);
});
```

- [ ] **Step 2: Run the fuzz**

Run: `node --test tests/hitori-fuzz.test.js`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
jj commit -m "test(hitori): fuzz suite for 3-rule soundness"
```

---

## Task 9: Fixtures + golden + integration test

**Files:**
- Modify: `tests/fixtures/puzzles.js` (add `hitori5x5Easy`)
- Modify: `tests/golden.js` (add golden snapshot)
- Modify: `tests/solver.test.js` (add integration test)

- [ ] **Step 1: Add fixture**

Append to `tests/fixtures/puzzles.js`:

```js
exports.hitori5x5Easy = {
  type: 'hitori',
  rows: 5,
  cols: 5,
  task: [
    [5,5,2,3,3],
    [2,5,4,4,3],
    [4,4,1,5,2],
    [1,2,5,4,5],
    [1,4,5,5,1],
  ],
};
```

- [ ] **Step 2: Add golden snapshot**

Append to `tests/golden.js`:

```js
exports.hitori5x5Easy = [
  [2,1,2,2,1],
  [2,2,2,1,2],
  [2,1,2,2,2],
  [2,2,1,2,2],
  [1,2,2,1,2],
];
```

- [ ] **Step 3: Add integration test**

Append to `tests/solver.test.js`:

```js
test('HitoriSolver: hitori5x5Easy fixture matches golden', () => {
  const { HitoriSolver } = require('../solver.js');
  const fixture = require('./fixtures/puzzles.js').hitori5x5Easy;
  HitoriSolver.clearSolutionCache();
  const s = new HitoriSolver({
    rows: fixture.rows,
    cols: fixture.cols,
    task: fixture.task,
  });
  const r = s.solve();
  assert.equal(r.solved, true);
  assert.deepEqual(r.grid, require('./golden.js').hitori5x5Easy);
});
```

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
jj commit -m "test(hitori): puzzles.js fixture + golden snapshot + integration test"
```

---

## Task 10: MAIN-world functions + allowlist + globals.d.ts

**Files:**
- Modify: `main-world.js`
- Modify: `background.js`
- Modify: `globals.d.ts`

- [ ] **Step 1: Add `readHitoriData`**

Find the last `read*Data` function in `main-world.js`. After it, add:

```js
function readHitoriData() {
  try {
    var G = window.Game;
    if (!G || !G.task || !G.puzzleWidth || !G.puzzleHeight) return null;
    var rows = G.puzzleHeight, cols = G.puzzleWidth;
    var task = [];
    for (var r = 0; r < rows; r++) {
      var row = G.task[r] || [];
      var arr = new Array(cols);
      for (var c = 0; c < cols; c++) arr[c] = row[c] || 0;
      task.push(arr);
    }
    return { rows: rows, cols: cols, task: task };
  } catch (e) {
    return null;
  }
}
```

- [ ] **Step 2: Add `readHitoriState`**

```js
function readHitoriState(rows, cols) {
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

- [ ] **Step 3: Add `applyHitoriState`**

```js
function applyHitoriState(grid) {
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
    console.warn('Hitori apply failed:', e);
    return false;
  }
}
```

- [ ] **Step 4: Update EXEC_MAIN_ALLOWLIST in background.js**

Add three entries adjacent to the existing heyawake entries:

```js
'readHitoriData',
'readHitoriState',
'applyHitoriState',
```

- [ ] **Step 5: Update globals.d.ts**

Add to the `MainWorldFn` union, and add `declare const HitoriSolver: any;` adjacent to `HeyawakeSolver`:

```ts
| 'readHitoriData'
| 'readHitoriState'
| 'applyHitoriState'
```

- [ ] **Step 6: Update eslint.config.js**

Find the `solverClasses` globals block and add `HitoriSolver`.

- [ ] **Step 7: Verify**

Run: `npm run lint && npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
jj commit -m "feat(hitori): MAIN-world read/apply fns + allowlist + globals.d.ts"
```

---

## Task 11: Worker arm + handler registration

**Files:**
- Modify: `solver.worker.js` (add hitori arm)
- Modify: `handler.js` (register `hitoriHandler`)

- [ ] **Step 1: Worker arm**

Add `HitoriSolver` to the `/* global */` directive at the top of `solver.worker.js`. Then, in the `if/else if` chain dispatching by `type`, add before the final `else`:

```js
} else if (type === 'hitori' && extraData) {
  const s = new HitoriSolver({
    rows: extraData.rows,
    cols: extraData.cols,
    task: extraData.task,
    initialState: initialGrid || null,
    maxMs: 30000,
  });
  result = s.solve();
}
```

- [ ] **Step 2: Register handler**

Open `handler.js`. After `heyawakeHandler`, register `hitoriHandler` (mirror the shape):

```js
const hitoriHandler = {
  name: 'puzzles-mobile-hitori',
  priority: 30,
  matches() {
    return isPuzzlesMobilePage() && window.location.pathname.includes('/hitori/');
  },
  async detect() {
    const result = { found: false, rows: 0, cols: 0, rowClues: [], colClues: [] };
    const data = await callMainWorld('readHitoriData', []);
    if (!data) return { ...result, error: 'No Hitori task data found' };
    const stageEl = document.getElementById('stage') ||
                    document.getElementById('game') ||
                    document.querySelector('[class*="game"], [class*="puzzle"]');
    return {
      found: true,
      type: 'hitori',
      rows: data.rows,
      cols: data.cols,
      task: data.task,
      rowClues: [],
      colClues: [],
      _cells: [],
      _element: stageEl,
    };
  },
  async readState(ctx) {
    const state = await callMainWorld('readHitoriState', [ctx.rows, ctx.cols]);
    if (state) return state;
    return Array.from({ length: ctx.rows }, () => new Array(ctx.cols).fill(0));
  },
  async applySolution(solution, _ctx) {
    const ok = await callMainWorld('applyHitoriState', [solution]);
    return ok ? { success: true } : { success: false, error: 'Hitori apply failed' };
  },
};

registerHandler(hitoriHandler);
```

- [ ] **Step 3: Verify**

Run: `npm run lint && npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
jj commit -m "feat(hitori): worker dispatch arm + handler registration"
```

---

## Task 12: dumpPuzzleForBench arm + real fixture + bench-real arm

**Files:**
- Modify: `main-world.js` (dump arm — INLINE extraction, no outer fn calls)
- Modify: `tests/fixtures/real-puzzles.js`
- Modify: `tests/bench-real.js`

- [ ] **Step 1: Extend dump**

In `main-world.js`, find `dumpPuzzleForBench`. Find the dispatch block (look for the heyawake / hashi branches). Add **before** the heyawake branch (or anywhere among the existing branches):

```js
if (path.indexOf('/hitori/') !== -1 || g.slug === 'hitori') {
  // INLINE extraction — dumpPuzzleForBench is serialized via fn.toString()
  // and can't call readHitoriData from MAIN world.
  if (!g.task || !g.puzzleWidth || !g.puzzleHeight) {
    return { error: 'hitori: missing g.task/dims', diagnostic: diagnostic(g), path: path };
  }
  var hiRows = g.puzzleHeight, hiCols = g.puzzleWidth;
  var hiTask = [];
  for (var hr = 0; hr < hiRows; hr++) {
    var srcRow = g.task[hr] || [];
    var dstRow = new Array(hiCols);
    for (var hc = 0; hc < hiCols; hc++) dstRow[hc] = srcRow[hc] || 0;
    hiTask.push(dstRow);
  }
  return { type: 'hitori', rows: hiRows, cols: hiCols, task: hiTask, path: path };
}
```

- [ ] **Step 2: Add real fixture**

Append to `tests/fixtures/real-puzzles.js`:

```js
exports.hitori5x5EasyReal = {
  type: 'hitori',
  rows: 5,
  cols: 5,
  task: [
    [5,5,2,3,3],
    [2,5,4,4,3],
    [4,4,1,5,2],
    [1,2,5,4,5],
    [1,4,5,5,1],
  ],
};
```

- [ ] **Step 3: Add bench-real arm**

Open `tests/bench-real.js`. Find the puzzle-type dispatch (look at how the heyawake arm is structured). Add a hitori arm mirroring it:

```js
if (fixture.type === 'hitori') {
  const { HitoriSolver } = require('../solver.js');
  return new HitoriSolver({
    rows: fixture.rows,
    cols: fixture.cols,
    task: fixture.task,
  });
}
```

(Adjust to the file's exact structure — match the heyawake arm.)

- [ ] **Step 4: Run bench-real to verify**

Run: `node tests/bench-real.js`
Expected: hitori5x5EasyReal solves, no failures.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(hitori): dumpPuzzleForBench arm + real fixture + bench-real arm"
```

---

## Task 13: bench-hitori.js + CI step

**Files:**
- Create: `tests/bench-hitori.js`
- Modify: `.github/workflows/bench-nightly.yml`

- [ ] **Step 1: Create the bench script**

Create `tests/bench-hitori.js`:

```js
'use strict';
const { HitoriSolver } = require('../solver.js');
const fixture = require('./fixtures/real-puzzles.js').hitori5x5EasyReal;

const ITERATIONS = 5;
const WARMUP = 2;
const times = [];
for (let i = 0; i < WARMUP + ITERATIONS; i++) {
  HitoriSolver.clearSolutionCache();
  const s = new HitoriSolver({
    rows: fixture.rows,
    cols: fixture.cols,
    task: fixture.task,
  });
  const t0 = process.hrtime.bigint();
  const r = s.solve();
  const t1 = process.hrtime.bigint();
  if (!r.solved) {
    console.error('hitori5x5EasyReal failed to solve');
    process.exit(1);
  }
  if (i >= WARMUP) times.push(Number(t1 - t0) / 1e6);
}
times.sort((a, b) => a - b);
const median = times[Math.floor(times.length / 2)];
console.log(`hitori5x5EasyReal: median ${median.toFixed(2)} ms over ${ITERATIONS} runs`);
```

- [ ] **Step 2: Run**

Run: `node tests/bench-hitori.js`
Expected: prints median time.

- [ ] **Step 3: Add CI step**

In `.github/workflows/bench-nightly.yml`, add (adjacent to bench-heyawake):

```yaml
      - name: Bench Hitori
        run: node tests/bench-hitori.js
```

- [ ] **Step 4: Commit**

```bash
jj commit -m "ci(hitori): bench script + nightly workflow step"
```

---

## Task 14: content.js bookkeeping

**Files:**
- Modify: `content.js` (SUPPORTED_PUZZLES, SOLUTION_KEY_PREFIXES, hitoriCacheKey, gridDataSig/staticSig, solveExtraData, pendingAutoSolve gate)

- [ ] **Step 1: SUPPORTED_PUZZLES**

Find `const SUPPORTED_PUZZLES = [`. Insert (alphabetical: between Heyawake and Nonogram):

```js
  { name: 'Hitori',       url: 'https://www.puzzles-mobile.com/hitori/' },
```

- [ ] **Step 2: SOLUTION_KEY_PREFIXES**

Find `SOLUTION_KEY_PREFIXES`. Add `'hitori-solution:'` to the array.

- [ ] **Step 3: hitoriCacheKey**

Find `heyawakeCacheKey` for reference. After it, add:

```js
function hitoriCacheKey(data) {
  if (data?.type !== 'hitori' || !data.task) return null;
  let h = 0x811c9dc5;
  const mix = (n) => { h ^= n & 0xff; h = Math.imul(h, 0x01000193) >>> 0; };
  mix(0x49); // 'I' nameplate
  mix(data.rows); mix(data.cols);
  for (const row of data.task) for (const v of row) mix(v + 1);
  return 'hitori-solution:' + (h >>> 0).toString(16);
}
```

Wire it into the dispatch chain alongside `heyawakeCacheKey` (find the two `data?.type === 'heyawake' ? heyawakeCacheKey(data)` sites and add `: data?.type === 'hitori' ? hitoriCacheKey(data)` before each fallback).

- [ ] **Step 4: solveExtraData**

Find `solveExtraData`. The heyawake arm returns `{rows, cols, rooms}`. Add a hitori arm:

```js
if (data.type === 'hitori') {
  return { rows: data.rows, cols: data.cols, task: data.task };
}
```

- [ ] **Step 5: gridDataSig / staticSig**

Find `heyawakeAreasSig`. Add a parallel `hitoriTaskSig(task)`:

```js
function hitoriTaskSig(task) {
  if (!task) return '0';
  let h = 0x811c9dc5;
  for (const row of task) for (const v of row) {
    h ^= v & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16);
}
```

Then find where `staticSig` is built (the `|hy=` segment is added). Add `'|hi=' + hitoriTaskSig(pd?.type === 'hitori' ? pd.task : null)`.

- [ ] **Step 6: pendingAutoSolve gate**

Find:

```js
const skipAutoSolveGate = puzzleData.type === 'slitherlink' || puzzleData.type === 'hashi' || puzzleData.type === 'heyawake';
```

Extend to include hitori:

```js
const skipAutoSolveGate = puzzleData.type === 'slitherlink' || puzzleData.type === 'hashi' || puzzleData.type === 'heyawake' || puzzleData.type === 'hitori';
```

- [ ] **Step 7: drawPreview rect-bail check**

Find the line that returns early for puzzle types with custom rendering (look for the line containing `'heyawake'`):

```js
if (pd?.regionMap || pd?.type === 'galaxies' || pd?.type === 'binairo' || pd?.type === 'shikaku' || pd?.type === 'yinyang' || pd?.type === 'slitherlink' || pd?.type === 'hashi' || pd?.type === 'heyawake') return;
```

Add `|| pd?.type === 'hitori'`.

- [ ] **Step 8: Verify**

Run: `npm run lint && npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
jj commit -m "feat(hitori): content.js bookkeeping (SUPPORTED_PUZZLES, prefix, cache key, sig, gate)"
```

---

## Task 15: content.js drawPreview arm

**Files:**
- Modify: `content.js` (`drawPreview` — add hitori render path)

Renders each cell with its digit clue overlaid. Shaded cells (cellStatus===1) get a dark fill with light digit text; unshaded (cellStatus===2) and unknown (0) get a light background with dark digit text.

- [ ] **Step 1: Read existing drawPreview for context**

Inspect the heyawake arm in `drawPreview` (search for `pd?.type === 'heyawake'`). Note how it uses `staticLayer`, `staticCtx`, `cellSize`, `ctx`, `rows`, `cols`. Mirror the structure.

- [ ] **Step 2: Add the hitori arm**

Inside `drawPreview`, before the generic fallback, add (adapt to the surrounding code's exact variable names):

```js
if (pd?.type === 'hitori') {
  // Static layer: outer border only — no internal regions. Re-render
  // unconditionally when staticDirty (or whatever equivalent).
  // ... (mirror heyawake's static border logic)
  
  // Dynamic layer: render each cell with its digit clue overlaid.
  const task = pd.task;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * cellSize, y = r * cellSize;
      const v = grid[r][c];
      const clue = task[r][c];
      // Render the digit text. Letters (10..35) render as a-z; digits as themselves.
      const ch = clue >= 10 && clue <= 35
        ? String.fromCharCode(clue + 87)
        : String(clue);
      if (v === 1) {
        // Shaded: dark fill, light text
        ctx.fillStyle = '#1f2937';
        ctx.fillRect(x, y, cellSize, cellSize);
        ctx.fillStyle = '#f3f4f6';
      } else {
        ctx.fillStyle = '#1f2937';
      }
      ctx.font = `bold ${Math.floor(cellSize * 0.55)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(ch, x + cellSize / 2, y + cellSize / 2);
    }
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
  // Mistake rings via computePuzzleDiff (generic cell-state arm covers hitori).
  if (pd.solution) {
    const diff = computePuzzleDiff('hitori', grid, pd.solution);
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

(Adapt to the file's exact patterns. If the file uses an `ifs.staticLayer.toCache(...)` style or different variable names, follow those.)

- [ ] **Step 3: Verify**

Run: `npm run lint && npm run typecheck && npm test && npm run build`
Expected: all clean.

- [ ] **Step 4: Commit**

```bash
jj commit -m "feat(hitori): drawPreview arm with digit clues + mistake rings"
```

---

## Task 16: content.js getHint dispatch + hintStatusNodes + solveHandler partial arm

**Files:**
- Modify: `content.js`

- [ ] **Step 1: getHint dispatch**

In the `getHint` function, find the heyawake arm. Add a parallel hitori arm:

```js
} else if (detectedGrid.type === 'hitori') {
  if (solution && firstMismatch(grid, solution)) {
    return { success: false, error: 'Current game state is wrong.' };
  }
  const solver = new HitoriSolver({ rows, cols, task: detectedGrid.task });
  const hintCells = solver.getHint(grid);
  if (!hintCells || hintCells.length === 0) {
    return { success: false, error: 'No more cells can be deduced from the current state. Click Solve to finish.' };
  }
  hint = { type: 'hitori', extraCells: hintCells, count: hintCells.length };
}
```

- [ ] **Step 2: setHintStatus arm + hitoriHintStatusNodes**

Find `setHintStatus`. Add a hitori arm before the generic fallback:

```js
} else if (puzzleData?.type === 'hitori') {
  setStatusNodes('info', prefix, ...hitoriHintStatusNodes(h));
}
```

Then add the function near `heyawakeHintStatusNodes`:

```js
function hitoriHintStatusNodes(h) {
  const cells = h.extraCells || [];
  if (cells.length === 0) return ['No hint available'];
  if (cells.length === 1) {
    const cell = cells[0];
    // cellStatus 1 = shaded, 2 = unshaded.
    const valueStr = cell.value === 1 ? 'shaded' : 'unshaded';
    return [
      'Cell ', bold(`(row ${cell.row + 1}, col ${cell.col + 1})`),
      ' must be ', bold(valueStr),
    ];
  }
  return [bold(String(cells.length)), ' cells can be deduced'];
}
```

- [ ] **Step 3: solveHandler partial arm**

Find the partial-result switch (look for `applyHashiPartialResult` then the heyawake branch). Add a hitori branch:

```js
if (result?.partial && puzzleData?.type === 'hitori' && Array.isArray(result.grid)) {
  applyGridPartialResult(result);
  return;
}
```

- [ ] **Step 4: Loop early-break exclusion**

Find the Loop early-break clause (the one with `hr.hint?.type !== 'heyawake'`):

```js
if (hr.hint?.type !== 'galaxies' && hr.hint?.type !== 'slitherlink' && hr.hint?.type !== 'hashi' && hr.hint?.type !== 'heyawake' && !hr.hint?.cells?.length) break;
```

Add `&& hr.hint?.type !== 'hitori'`.

- [ ] **Step 5: Verify**

Run: `npm run lint && npm run typecheck && npm test && npm run build`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
jj commit -m "feat(hitori): content.js getHint dispatch + hintStatusNodes + partial arm"
```

---

## Task 17: Final verification

**Files:** (none — verification only)

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: tests pass, count ≈ 288 + ~10 new hitori tests = ~298.

- [ ] **Step 2: Lint + typecheck**

Run: `npm run lint && npm run typecheck`
Expected: clean.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 4: Bench**

Run: `node tests/bench-hitori.js`
Expected: prints median solve time, well under 100 ms.

- [ ] **Step 5: Manual smoke test in browser**

Load `dist/` (or refresh if already loaded). Navigate to `https://www.puzzles-mobile.com/hitori/random/5x5-easy`. Click Detect → status shows "Found 5×5 Hitori." with digit clues rendered. Click Solve → preview shows the shaded grid with correct digits. Click Apply → page accepts the moves. Click Hint on a fresh board → cells highlighted with the correct values.

- [ ] **Step 6: If clean, no commit needed**

If verification surfaced any fixes, commit them:

```bash
jj commit -m "fix(hitori): final verification fixes"
```

---

End of plan. Self-review on completion: spec coverage complete, no placeholders, method names consistent across tasks.
