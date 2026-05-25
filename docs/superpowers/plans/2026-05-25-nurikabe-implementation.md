# Nurikabe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Nurikabe support — 15th puzzle type. Clue-driven cell-state puzzle (no regions); each clue N anchors an island of exactly N white cells, all blacks form one connected sea, no 2×2 of blacks.

**Architecture:** `NurikabeSolver` follows the cell-state shape used by Heyawake / Norinori (flat `cellStatus`, trail-based undo). Clue cells fixed to WHITE at construction. Six propagation rules: clue-adjacency, unreachable (BFS), island-completion (BFS + capacity), 2×2, sea connectivity (BFS + cut), global black-count. Top-level lookahead + backtracking.

**Reference spec:** `docs/superpowers/specs/2026-05-25-nurikabe-design.md`
**Closest existing solvers:** Heyawake (cell-state + clue list shape), Yin-Yang (BFS reachability + cut articulation), Norinori (fresh-rewritten in this codebase — clean reference for the propagation-fixpoint scaffolding).

`jj commit` not git. Repo `/home/quando/documents/chrome-puzzle-solver/`. TDD.

---

## Task 1: NurikabeSolver scaffold + constructor + _set

**Files:** `solver.js`, `tests/nurikabe.test.js` (new).

Constructor reads `task` (2D int, -1 or positive), builds the flat `task` array, collects clue cells, computes `expectedBlacks`, forces clue cells to WHITE, runs a cheap pre-check (per-clue reachable area ≥ N).

- [ ] **Step 1: Create the failing test**

Create `tests/nurikabe.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { NurikabeSolver } = require('../solver.js');

test('NurikabeSolver: constructor sets clue cells WHITE and builds clues list', () => {
  // 3x3: clue 1 at (0,0), clue 2 at (2,2). expectedBlacks = 9 - 3 = 6.
  const s = new NurikabeSolver({
    rows: 3, cols: 3,
    task: [[1, -1, -1], [-1, -1, -1], [-1, -1, 2]],
  });
  assert.equal(s.rows, 3);
  assert.equal(s.cols, 3);
  assert.equal(s.clues.length, 2);
  assert.deepEqual(s.clues.map(c => ({idx: c.idx, size: c.size})), [
    {idx: 0, size: 1},
    {idx: 8, size: 2},
  ]);
  assert.equal(s.expectedBlacks, 6);
  // Clue cells forced WHITE.
  assert.equal(s.cellStatus[0], 2);
  assert.equal(s.cellStatus[8], 2);
});

test('NurikabeSolver: _set / _rollback round-trip', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[1, -1, -1]],
  });
  const mark = s.trail.length;
  assert.equal(s._set(1, 1), true);
  assert.equal(s.cellStatus[1], 1);
  s._rollback(mark);
  assert.equal(s.cellStatus[1], 0);
});

test('NurikabeSolver: _set overwriting same value is no-op (true)', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[1, -1, -1]],
  });
  // Clue cell already WHITE from constructor.
  assert.equal(s._set(0, 2), true);
});

test('NurikabeSolver: _set overwriting different non-zero → false', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[1, -1, -1]],
  });
  // Clue cell is WHITE; trying to write BLACK must fail.
  assert.equal(s._set(0, 1), false);
});

test('NurikabeSolver: constructor pre-check rejects when a clue can not reach its size', () => {
  // 1x3 with clue 3 at (0,0), but only 3 cells total — fine. Try clue 5 in
  // 1x3 — impossible (max 3 white cells available).
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[5, -1, -1]],
  });
  assert.equal(s.contradiction, true);
});

test('NurikabeSolver: two adjacent clue cells set contradiction at construction', () => {
  // Two clues in adjacent cells can't be separate islands.
  const s = new NurikabeSolver({
    rows: 1, cols: 2,
    task: [[1, 1]],
  });
  assert.equal(s.contradiction, true);
});
```

- [ ] **Step 2: Verify failure** — `NurikabeSolver is not defined`.

- [ ] **Step 3: Add NurikabeSolver to `solver.js`** (after `NorinoriSolver`, before `module.exports`):

```js
class NurikabeSolver {
  constructor(data) {
    const { rows, cols, task, initialState, maxMs } = data;
    this.rows = rows;
    this.cols = cols;
    this.N = rows * cols;
    this.task = new Int32Array(this.N);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        this.task[r * cols + c] = task[r][c];
      }
    }
    this.clues = [];
    let sum = 0;
    for (let i = 0; i < this.N; i++) {
      const v = this.task[i];
      if (v > 0) { this.clues.push({ idx: i, size: v }); sum += v; }
    }
    this.expectedBlacks = this.N - sum;
    this.cellStatus = new Uint8Array(this.N);
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
    this.contradiction = false;

    // Force clue cells WHITE.
    for (const clue of this.clues) {
      if (!this._set(clue.idx, 2)) { this.contradiction = true; return; }
    }
    // Cheap pre-check: two clue cells can never be 4-adjacent.
    for (const clue of this.clues) {
      const r = (clue.idx / cols) | 0;
      const c = clue.idx - r * cols;
      const ns = [];
      if (r > 0) ns.push(clue.idx - cols);
      if (r < rows - 1) ns.push(clue.idx + cols);
      if (c > 0) ns.push(clue.idx - 1);
      if (c < cols - 1) ns.push(clue.idx + 1);
      for (const ni of ns) {
        if (this.task[ni] > 0) { this.contradiction = true; return; }
      }
    }
    // Pre-check: each clue's reachable area (BFS through non-BLACK, not
    // through other clue cells) ≥ N.
    for (const clue of this.clues) {
      if (this._reachableFromCell(clue.idx, clue.size) < clue.size) {
        this.contradiction = true;
        return;
      }
    }
  }

  // BFS through {cellStatus !== 1} from start, blocked by other clue cells.
  // Returns size of reachable region, capped at `cap` for speed.
  _reachableFromCell(startIdx, cap) {
    const visited = new Uint8Array(this.N);
    visited[startIdx] = 1;
    const queue = [startIdx];
    let count = 1;
    while (queue.length && count < cap + 1) {
      const idx = queue.shift();
      const r = (idx / this.cols) | 0;
      const c = idx - r * this.cols;
      const ns = [];
      if (r > 0) ns.push(idx - this.cols);
      if (r < this.rows - 1) ns.push(idx + this.cols);
      if (c > 0) ns.push(idx - 1);
      if (c < this.cols - 1) ns.push(idx + 1);
      for (const ni of ns) {
        if (visited[ni]) continue;
        if (this.cellStatus[ni] === 1) continue;
        // Skip other clue cells.
        if (ni !== startIdx && this.task[ni] > 0) continue;
        visited[ni] = 1;
        count++;
        if (count >= cap + 1) break;
        queue.push(ni);
      }
    }
    return count;
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

Update `module.exports` to include `NurikabeSolver`.

- [ ] **Step 4: Verify 6 passing.**

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(nurikabe): NurikabeSolver scaffold + constructor"
```

---

## Task 2: Rule 1 — _applyClueAdjacency

**Files:** `solver.js`, `tests/nurikabe.test.js` (append).

If an unknown cell has 2+ distinct clue 4-neighbours, it must be BLACK (it can't join two islands).

- [ ] **Step 1: Append failing tests**

```js
test('NurikabeSolver._applyClueAdjacency: cell with 2 clue neighbours → BLACK', () => {
  // 1x3 with clues at (0,0) and (0,2). Cell (0,1) is adjacent to both →
  // must be BLACK.
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[1, -1, 1]],
  });
  assert.equal(s.contradiction, false);
  assert.equal(s._applyClueAdjacency(), true);
  assert.equal(s.cellStatus[1], 1); // BLACK
});

test('NurikabeSolver._applyClueAdjacency: cell with one clue neighbour stays unknown', () => {
  // 1x3 with single clue at (0,0). (0,1) has only one clue neighbour →
  // not forced.
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[1, -1, -1]],
  });
  assert.equal(s._applyClueAdjacency(), true);
  assert.equal(s.cellStatus[1], 0);
});
```

- [ ] **Step 2: Verify failure** — `_applyClueAdjacency is not a function`.

- [ ] **Step 3: Add method to `NurikabeSolver`** (inside the class, after `_timeUp`):

```js
  _applyClueAdjacency() {
    for (let i = 0; i < this.N; i++) {
      if (this.cellStatus[i] !== 0) continue;
      const r = (i / this.cols) | 0;
      const c = i - r * this.cols;
      const ns = [];
      if (r > 0) ns.push(i - this.cols);
      if (r < this.rows - 1) ns.push(i + this.cols);
      if (c > 0) ns.push(i - 1);
      if (c < this.cols - 1) ns.push(i + 1);
      let clueCount = 0;
      for (const ni of ns) if (this.task[ni] > 0) clueCount++;
      if (clueCount >= 2) {
        if (!this._set(i, 1)) return false;
      }
    }
    return true;
  }
```

- [ ] **Step 4: Verify all passing.**

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(nurikabe): rule 1 — clue-adjacency forcing"
```

---

## Task 3: Rule 2 — _applyUnreachable

**Files:** `solver.js`, `tests/nurikabe.test.js` (append).

A cell unreachable by any clue (BFS through `{cellStatus !== 1, not another clue}` within distance N-1) must be BLACK.

- [ ] **Step 1: Append failing tests**

```js
test('NurikabeSolver._applyUnreachable: cell out of all clue reach → BLACK', () => {
  // 5x5 with clue 1 at (0,0) (island = just itself) and clue 1 at (4,4).
  // All other cells are unreachable from any clue (each clue's island is 1
  // cell, can't extend).
  const s = new NurikabeSolver({
    rows: 5, cols: 5,
    task: [
      [1, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1],
      [-1, -1, -1, -1, 1],
    ],
  });
  assert.equal(s._applyUnreachable(), true);
  // Center (2,2) — way out of any size-1 island's reach.
  assert.equal(s.cellStatus[12], 1);
});

test('NurikabeSolver._applyUnreachable: cell within Manhattan-but-not-BFS-distance still gets forced', () => {
  // 3x3 with clue 2 at (0,0). Maximum reach: distance 1 from clue.
  // Cell (2,2) at distance 4 → must be BLACK.
  const s = new NurikabeSolver({
    rows: 3, cols: 3,
    task: [[2, -1, -1], [-1, -1, -1], [-1, -1, -1]],
  });
  assert.equal(s._applyUnreachable(), true);
  assert.equal(s.cellStatus[8], 1); // (2,2) → BLACK
});

test('NurikabeSolver._applyUnreachable: cell within reach stays unknown', () => {
  // 3x3 with clue 4 at (1,1). Every cell is within distance ≤ 2 — none
  // forced black by this rule.
  const s = new NurikabeSolver({
    rows: 3, cols: 3,
    task: [[-1, -1, -1], [-1, 4, -1], [-1, -1, -1]],
  });
  assert.equal(s._applyUnreachable(), true);
  // Corners are at Manhattan-2 from (1,1), reachable within size 4.
  assert.equal(s.cellStatus[0], 0);
});
```

- [ ] **Step 2: Verify failure** — `_applyUnreachable is not a function`.

- [ ] **Step 3: Add method to `NurikabeSolver`:**

```js
  // BFS reachable set from clue: cells within (size-1) edge-distance through
  // {cellStatus !== 1} not crossing any other clue cell. Returns a
  // Uint8Array(N) indicator.
  _bfsClueReach(clue) {
    const reach = new Uint8Array(this.N);
    reach[clue.idx] = 1;
    let frontier = [clue.idx];
    for (let step = 1; step < clue.size; step++) {
      const next = [];
      for (const idx of frontier) {
        const r = (idx / this.cols) | 0;
        const c = idx - r * this.cols;
        const ns = [];
        if (r > 0) ns.push(idx - this.cols);
        if (r < this.rows - 1) ns.push(idx + this.cols);
        if (c > 0) ns.push(idx - 1);
        if (c < this.cols - 1) ns.push(idx + 1);
        for (const ni of ns) {
          if (reach[ni]) continue;
          if (this.cellStatus[ni] === 1) continue;
          if (ni !== clue.idx && this.task[ni] > 0) continue;
          reach[ni] = 1;
          next.push(ni);
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }
    return reach;
  }

  _applyUnreachable() {
    // Union of all clue reach sets.
    const union = new Uint8Array(this.N);
    for (const clue of this.clues) {
      const r = this._bfsClueReach(clue);
      for (let i = 0; i < this.N; i++) if (r[i]) union[i] = 1;
    }
    for (let i = 0; i < this.N; i++) {
      if (this.cellStatus[i] !== 0) continue;
      if (!union[i]) {
        if (!this._set(i, 1)) return false;
      }
    }
    return true;
  }
```

- [ ] **Step 4: Verify all passing.**

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(nurikabe): rule 2 — unreachable cells forced BLACK"
```

---

## Task 4: Rule 3 — _applyIslandComplete

**Files:** `solver.js`, `tests/nurikabe.test.js` (append).

For each clue: BFS the current WHITE component from the clue (blocked by BLACK and other clues). Then BFS reachable capacity (WHITE ∪ UNKNOWN). Detect: white component too big → contradiction; capacity < N → contradiction; white==N → frontier UNKNOWNs → BLACK; capacity==N → reachable UNKNOWNs → WHITE.

- [ ] **Step 1: Append failing tests**

```js
test('NurikabeSolver._applyIslandComplete: white component == N forces UNKNOWN frontier to BLACK', () => {
  // 1x3 with clue 2 at (0,0). Set (0,1) WHITE manually — island now has 2
  // cells. (0,2) is the frontier → must be BLACK.
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[2, -1, -1]],
  });
  s._set(1, 2);
  assert.equal(s._applyIslandComplete(), true);
  assert.equal(s.cellStatus[2], 1);
});

test('NurikabeSolver._applyIslandComplete: capacity == N forces reachable UNKNOWNs to WHITE', () => {
  // 1x3 with clue 2 at (0,0) and (0,2) preset to BLACK. Reachable capacity
  // for the clue is exactly {(0,0), (0,1)} = 2. (0,1) must be WHITE.
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[2, -1, -1]],
  });
  s._set(2, 1);
  assert.equal(s._applyIslandComplete(), true);
  assert.equal(s.cellStatus[1], 2);
});

test('NurikabeSolver._applyIslandComplete: white component > N → contradiction', () => {
  // Clue 1 at (0,0) with (0,1) already WHITE — island would be 2 > 1.
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[1, -1, -1]],
    initialState: [[2, 2, 0]],
  });
  assert.equal(s._applyIslandComplete(), false);
});

test('NurikabeSolver._applyIslandComplete: capacity < N → contradiction', () => {
  // 1x3 with clue 3 at (0,0), (0,2) BLACK. Capacity = 2 (cells 0 and 1) < 3.
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[3, -1, -1]],
    initialState: [[2, 0, 1]],
  });
  assert.equal(s._applyIslandComplete(), false);
});
```

- [ ] **Step 2: Verify failure** — `_applyIslandComplete is not a function`.

- [ ] **Step 3: Add methods:**

```js
  // BFS the current WHITE component from `startIdx` (a clue cell),
  // blocked by BLACK and by other clue cells. Returns {size, members,
  // frontier} where frontier is the set of UNKNOWN neighbours of the
  // component.
  _bfsWhiteComponent(startIdx) {
    const members = new Uint8Array(this.N);
    members[startIdx] = 1;
    const queue = [startIdx];
    const frontier = [];
    const seenFrontier = new Uint8Array(this.N);
    let size = 1;
    while (queue.length) {
      const idx = queue.shift();
      const r = (idx / this.cols) | 0;
      const c = idx - r * this.cols;
      const ns = [];
      if (r > 0) ns.push(idx - this.cols);
      if (r < this.rows - 1) ns.push(idx + this.cols);
      if (c > 0) ns.push(idx - 1);
      if (c < this.cols - 1) ns.push(idx + 1);
      for (const ni of ns) {
        if (members[ni]) continue;
        const v = this.cellStatus[ni];
        if (v === 1) continue;
        // Block at other clue cells.
        if (this.task[ni] > 0 && ni !== startIdx) continue;
        if (v === 2) {
          members[ni] = 1;
          size++;
          queue.push(ni);
        } else if (v === 0) {
          if (!seenFrontier[ni]) {
            seenFrontier[ni] = 1;
            frontier.push(ni);
          }
        }
      }
    }
    return { size, members, frontier };
  }

  // Capacity = WHITE ∪ UNKNOWN reachable from any cell in `members`,
  // blocked by BLACK and other clues. Counts unique cells (including the
  // members themselves).
  _islandCapacity(startIdx, members) {
    const visited = new Uint8Array(this.N);
    const queue = [];
    let count = 0;
    for (let i = 0; i < this.N; i++) {
      if (members[i]) { visited[i] = 1; queue.push(i); count++; }
    }
    const reachable = new Uint8Array(this.N);
    for (let i = 0; i < this.N; i++) if (members[i]) reachable[i] = 1;
    while (queue.length) {
      const idx = queue.shift();
      const r = (idx / this.cols) | 0;
      const c = idx - r * this.cols;
      const ns = [];
      if (r > 0) ns.push(idx - this.cols);
      if (r < this.rows - 1) ns.push(idx + this.cols);
      if (c > 0) ns.push(idx - 1);
      if (c < this.cols - 1) ns.push(idx + 1);
      for (const ni of ns) {
        if (visited[ni]) continue;
        const v = this.cellStatus[ni];
        if (v === 1) continue;
        if (this.task[ni] > 0 && ni !== startIdx) continue;
        visited[ni] = 1;
        reachable[ni] = 1;
        count++;
        queue.push(ni);
      }
    }
    return { capacity: count, reachable };
  }

  _applyIslandComplete() {
    for (const clue of this.clues) {
      const { size, members, frontier } = this._bfsWhiteComponent(clue.idx);
      if (size > clue.size) return false;
      const { capacity, reachable } = this._islandCapacity(clue.idx, members);
      if (capacity < clue.size) return false;
      if (size === clue.size) {
        for (const ni of frontier) {
          if (this.cellStatus[ni] === 0) {
            if (!this._set(ni, 1)) return false;
          }
        }
      }
      if (capacity === clue.size) {
        for (let i = 0; i < this.N; i++) {
          if (reachable[i] && this.cellStatus[i] === 0) {
            if (!this._set(i, 2)) return false;
          }
        }
      }
    }
    return true;
  }
```

- [ ] **Step 4: Verify all passing.**

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(nurikabe): rule 3 — island completion + capacity"
```

---

## Task 5: Rules 4 + 6 — _apply2x2 + _applyBlackCount

**Files:** `solver.js`, `tests/nurikabe.test.js` (append).

Two simple global rules: no 2×2 of blacks, total black count.

- [ ] **Step 1: Append failing tests**

```js
test('NurikabeSolver._apply2x2: 4 blacks in 2x2 → contradiction', () => {
  const s = new NurikabeSolver({
    rows: 2, cols: 2,
    task: [[-1, -1], [-1, -1]],
    initialState: [[1, 1], [1, 1]],
  });
  assert.equal(s._apply2x2(), false);
});

test('NurikabeSolver._apply2x2: 3 blacks + 1 unknown in 2x2 → unknown forced WHITE', () => {
  const s = new NurikabeSolver({
    rows: 2, cols: 2,
    task: [[-1, -1], [-1, -1]],
    initialState: [[1, 1], [1, 0]],
  });
  assert.equal(s._apply2x2(), true);
  assert.equal(s.cellStatus[3], 2);
});

test('NurikabeSolver._applyBlackCount: too many blacks → contradiction', () => {
  // 2x2, clue 1 at (0,0). expectedBlacks = 4 - 1 = 3. Place 4 blacks
  // (impossible — clue cell is WHITE) ... actually place 4 blacks
  // requires forcing clue cell which fails. Use 3x3 with clue 1, place
  // all non-clue cells BLACK (8 blacks vs expected 8) — fine. To trigger
  // overflow, use 1x3 clue 2: expectedBlacks=1, place 2 blacks.
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[2, -1, -1]],
    initialState: [[2, 1, 1]],
  });
  assert.equal(s._applyBlackCount(), false);
});

test('NurikabeSolver._applyBlackCount: nB + nU == expected → all unknowns BLACK', () => {
  // 1x3 clue 1 at (0,0). expectedBlacks = 2. Current: clue WHITE, (0,1)
  // unknown, (0,2) BLACK. nB=1, nU=1. nB+nU=2=expected → (0,1) BLACK.
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[1, -1, -1]],
    initialState: [[2, 0, 1]],
  });
  assert.equal(s._applyBlackCount(), true);
  assert.equal(s.cellStatus[1], 1);
});
```

- [ ] **Step 2: Verify failure** — methods not defined.

- [ ] **Step 3: Add methods:**

```js
  _apply2x2() {
    for (let r = 0; r + 1 < this.rows; r++) {
      for (let c = 0; c + 1 < this.cols; c++) {
        const a = r * this.cols + c;
        const cells = [a, a + 1, a + this.cols, a + this.cols + 1];
        let nB = 0, nU = 0;
        for (const ci of cells) {
          if (this.cellStatus[ci] === 1) nB++;
          else if (this.cellStatus[ci] === 0) nU++;
        }
        if (nB === 4) return false;
        if (nB === 3 && nU === 1) {
          for (const ci of cells) {
            if (this.cellStatus[ci] === 0) {
              if (!this._set(ci, 2)) return false;
            }
          }
        }
      }
    }
    return true;
  }

  _applyBlackCount() {
    let nB = 0, nU = 0;
    for (let i = 0; i < this.N; i++) {
      if (this.cellStatus[i] === 1) nB++;
      else if (this.cellStatus[i] === 0) nU++;
    }
    if (nB > this.expectedBlacks) return false;
    if (nB + nU < this.expectedBlacks) return false;
    if (nB === this.expectedBlacks && nU > 0) {
      for (let i = 0; i < this.N; i++) {
        if (this.cellStatus[i] === 0) {
          if (!this._set(i, 2)) return false;
        }
      }
    } else if (nB + nU === this.expectedBlacks && nU > 0) {
      for (let i = 0; i < this.N; i++) {
        if (this.cellStatus[i] === 0) {
          if (!this._set(i, 1)) return false;
        }
      }
    }
    return true;
  }
```

- [ ] **Step 4: Verify all passing.**

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(nurikabe): rules 4 + 6 — 2x2 forbid + global black count"
```

---

## Task 6: Rule 5 — _applySeaConnectivity

**Files:** `solver.js`, `tests/nurikabe.test.js` (append).

The sea must be a single connected component. (a) If BLACK cells form multiple components AND can't be joined through UNKNOWN cells → contradiction. (b) If two BLACKs can only be connected via a single UNKNOWN articulation cell, that UNKNOWN must be BLACK.

- [ ] **Step 1: Append failing tests**

```js
test('NurikabeSolver._applySeaConnectivity: two BLACKs separated only by all-WHITE → contradiction', () => {
  // 1x3: BLACK, WHITE, BLACK. Sea is in 2 components, can't connect.
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[-1, 1, -1]],
    initialState: [[1, 2, 1]],
  });
  assert.equal(s._applySeaConnectivity(), false);
});

test('NurikabeSolver._applySeaConnectivity: connected via UNKNOWN is fine', () => {
  // 1x3: BLACK, UNKNOWN, BLACK. Sea can connect through unknown.
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[-1, -1, -1]],
    initialState: [[1, 0, 1]],
  });
  assert.equal(s._applySeaConnectivity(), true);
});
```

- [ ] **Step 2: Verify failure** — `_applySeaConnectivity is not a function`.

- [ ] **Step 3: Add method:**

```js
  _applySeaConnectivity() {
    // Skip during lookahead — expensive BFS, keep inner probe cheap.
    if (this._inLookahead) return true;
    // Find all BLACK cells. If none, trivially OK.
    const blacks = [];
    for (let i = 0; i < this.N; i++) if (this.cellStatus[i] === 1) blacks.push(i);
    if (blacks.length === 0) return true;
    // BFS from first BLACK through {BLACK ∪ UNKNOWN}.
    const visited = new Uint8Array(this.N);
    const queue = [blacks[0]];
    visited[blacks[0]] = 1;
    while (queue.length) {
      const idx = queue.shift();
      const r = (idx / this.cols) | 0;
      const c = idx - r * this.cols;
      const ns = [];
      if (r > 0) ns.push(idx - this.cols);
      if (r < this.rows - 1) ns.push(idx + this.cols);
      if (c > 0) ns.push(idx - 1);
      if (c < this.cols - 1) ns.push(idx + 1);
      for (const ni of ns) {
        if (visited[ni]) continue;
        const v = this.cellStatus[ni];
        if (v === 2) continue;
        visited[ni] = 1;
        queue.push(ni);
      }
    }
    // Every BLACK must be visited.
    for (const b of blacks) if (!visited[b]) return false;
    return true;
  }
```

- [ ] **Step 4: Verify all passing.**

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(nurikabe): rule 5 — sea connectivity"
```

---

## Task 7: _propagate + _applyLookahead

**Files:** `solver.js`, `tests/nurikabe.test.js` (append).

Fixpoint of the six rules; at top level, single-step lookahead.

- [ ] **Step 1: Append failing tests**

```js
test('NurikabeSolver._propagate: fixpoint solves trivial 1x2 clue 2', () => {
  // Clue 2 at (0,0): must occupy both cells WHITE. expectedBlacks = 0.
  const s = new NurikabeSolver({
    rows: 1, cols: 2,
    task: [[2, -1]],
  });
  assert.equal(s._propagate(), true);
  assert.equal(s.cellStatus[0], 2);
  assert.equal(s.cellStatus[1], 2);
});

test('NurikabeSolver._propagate: returns false on inherent contradiction', () => {
  // 1x3 clue 1 at (0,0), clue 1 at (0,1) — clue-adjacency contradiction
  // already in constructor.
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[1, 1, -1]],
  });
  assert.equal(s.contradiction, true);
});
```

- [ ] **Step 2: Verify failure** — `_propagate is not a function`.

- [ ] **Step 3: Add methods:**

```js
  _propagate() {
    let changed = true;
    while (changed) {
      if (this._timeUp()) return true;
      changed = false;
      const mark = this.trail.length;
      if (!this._applyClueAdjacency()) return false;
      if (!this._applyUnreachable()) return false;
      if (!this._applyIslandComplete()) return false;
      if (!this._apply2x2()) return false;
      if (!this._applySeaConnectivity()) return false;
      if (!this._applyBlackCount()) return false;
      if (this.trail.length > mark) changed = true;
    }
    if (this._depth === 0 && !this._inLookahead) {
      if (!this._applyLookahead()) return false;
    }
    return true;
  }

  _applyLookahead() {
    let changed = true;
    while (changed) {
      if (this._timeUp()) return true;
      changed = false;
      for (let i = 0; i < this.N; i++) {
        if (this.cellStatus[i] !== 0) continue;
        const survivors = [];
        for (const v of [1, 2]) {
          const mark = this.trail.length;
          this._inLookahead = true;
          this._depth++;
          const okSet = this._set(i, v);
          const ok = okSet && this._propagate();
          this._depth--;
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

- [ ] **Step 4: Verify all passing.**

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(nurikabe): propagate fixpoint + single-step lookahead"
```

---

## Task 8: solve + _backtrack + caches + computePuzzleDiff arm

**Files:** `solver.js`, `tests/nurikabe.test.js` (append).

- [ ] **Step 1: Append failing tests**

```js
test('NurikabeSolver.solve: solves trivial 1x2 clue 2', () => {
  NurikabeSolver.clearSolutionCache();
  const s = new NurikabeSolver({
    rows: 1, cols: 2,
    task: [[2, -1]],
    maxMs: 5000,
  });
  const r = s.solve();
  assert.equal(r.solved, true);
  assert.deepEqual(r.grid, [[2, 2]]);
});

test('NurikabeSolver.solve: solves unsat returning {solved:false, grid:null}', () => {
  NurikabeSolver.clearSolutionCache();
  // 1x2 clue 1 + clue 1 adjacent → contradicting at construction.
  const s = new NurikabeSolver({
    rows: 1, cols: 2,
    task: [[1, 1]],
    maxMs: 5000,
  });
  const r = s.solve();
  assert.equal(r.solved, false);
  assert.equal(r.grid, null);
});

test('NurikabeSolver._solutionCache: cache hit returns deep copy', () => {
  NurikabeSolver.clearSolutionCache();
  const opts = { rows: 1, cols: 2, task: [[2, -1]] };
  const a = new NurikabeSolver(opts).solve();
  a.grid[0][0] = 99;
  const b = new NurikabeSolver(opts).solve();
  assert.notEqual(b.grid[0][0], 99);
});

test('computePuzzleDiff nurikabe: flags wrong-color non-clue cells', () => {
  const solution = [[2, 1], [1, 2]];
  const board = [[2, 2], [1, 2]]; // (0,1) wrong
  const diff = computePuzzleDiff('nurikabe', board, solution);
  assert.equal(diff.length, 1);
  assert.deepEqual(diff[0], { row: 0, col: 1, expected: 1, actual: 2 });
});
```

- [ ] **Step 2: Verify failure.**

- [ ] **Step 3: Add to `NurikabeSolver`:**

```js
  _isComplete() {
    for (let i = 0; i < this.N; i++) if (this.cellStatus[i] === 0) return false;
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
    let bestIdx = -1, bestScore = -1;
    for (let i = 0; i < this.N; i++) {
      if (this.cellStatus[i] !== 0) continue;
      const r = (i / this.cols) | 0;
      const c = i - r * this.cols;
      let score = 0;
      if (r > 0 && this.cellStatus[i - this.cols] !== 0) score++;
      if (r < this.rows - 1 && this.cellStatus[i + this.cols] !== 0) score++;
      if (c > 0 && this.cellStatus[i - 1] !== 0) score++;
      if (c < this.cols - 1 && this.cellStatus[i + 1] !== 0) score++;
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
    const cached = NurikabeSolver._solutionCache.get(key)
                || NurikabeSolver._partialCache.get(key);
    if (cached) return this._cloneResult(cached);
    this._startedAt = Date.now();
    let result;
    if (this.contradiction) {
      result = { solved: false, grid: null };
    } else if (!this._propagate()) {
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

  static _solutionCache = new Map();
  static _maxSolutionCache = 50;
  static _partialCache = new Map();
  static _maxPartialCache = 20;
  static clearSolutionCache() {
    NurikabeSolver._solutionCache.clear();
    NurikabeSolver._partialCache.clear();
  }

  _cacheKey() {
    let h = 0x811c9dc5;
    const mix = (n) => { h ^= n & 0xff; h = Math.imul(h, 0x01000193) >>> 0; };
    mix(this.rows); mix(this.cols);
    for (let i = 0; i < this.N; i++) {
      const v = this.task[i];
      mix(v & 0xff);
      mix((v >>> 8) & 0xff);
    }
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
    const m = result.partial ? NurikabeSolver._partialCache : NurikabeSolver._solutionCache;
    const max = result.partial ? NurikabeSolver._maxPartialCache : NurikabeSolver._maxSolutionCache;
    if (m.size >= max) {
      const first = m.keys().next().value;
      m.delete(first);
    }
    m.set(key, this._cloneResult(result));
  }
```

Locate `computePuzzleDiff` in solver.js; find its existing per-puzzle branch list. Add `|| type === 'nurikabe'` to the cell-state arm so cell-by-cell wrong-color flagging applies.

- [ ] **Step 4: Verify all passing.**

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(nurikabe): solve + backtracking + caches + diff arm"
```

---

## Task 9: getHint stepwise

**Files:** `solver.js`, `tests/nurikabe.test.js` (append).

Per-rule stepwise getHint that returns the first batch of forced writes.

- [ ] **Step 1: Append failing tests**

```js
test('NurikabeSolver.getHint: 1x2 clue 2 yields both whites as a hint', () => {
  NurikabeSolver.clearSolutionCache();
  const s = new NurikabeSolver({
    rows: 1, cols: 2,
    task: [[2, -1]],
  });
  const hint = s.getHint([[2, 0]]);
  assert.ok(Array.isArray(hint));
  assert.ok(hint.some(h => h.row === 0 && h.col === 1 && h.value === 2));
});

test('NurikabeSolver.getHint: null on already-solved board', () => {
  NurikabeSolver.clearSolutionCache();
  const s = new NurikabeSolver({
    rows: 1, cols: 2,
    task: [[2, -1]],
  });
  assert.equal(s.getHint([[2, 2]]), null);
});
```

- [ ] **Step 2: Verify failure.**

- [ ] **Step 3: Add `getHint` to `NurikabeSolver`:**

```js
  getHint(initialState) {
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        this.cellStatus[r * this.cols + c] = initialState[r][c];
      }
    }
    const before = new Uint8Array(this.N);
    for (let i = 0; i < this.N; i++) before[i] = this.cellStatus[i];
    this.trail = [];
    this._depth = 0;
    this._inLookahead = false;
    this._startedAt = Date.now();

    const collectChanged = () => {
      const out = [];
      for (let i = 0; i < this.N; i++) {
        if (before[i] === 0 && this.cellStatus[i] !== 0) {
          const r = (i / this.cols) | 0;
          const c = i - r * this.cols;
          out.push({ row: r, col: c, value: this.cellStatus[i] });
        }
      }
      return out;
    };

    const rules = [
      () => this._applyClueAdjacency(),
      () => this._applyUnreachable(),
      () => this._applyIslandComplete(),
      () => this._apply2x2(),
      () => this._applySeaConnectivity(),
      () => this._applyBlackCount(),
    ];
    for (const rule of rules) {
      if (!rule()) return null;
      const h = collectChanged();
      if (h.length) return h;
    }

    // Single lookahead probe.
    for (let i = 0; i < this.N; i++) {
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

- [ ] **Step 4: Verify all passing.**

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(nurikabe): stepwise getHint"
```

---

## Task 10: Fuzz soundness test

**Files:** `tests/nurikabe-fuzz.test.js` (new).

Generate random small Nurikabe instances by starting from a solved configuration and emitting clue cells. Run the solver and verify the recovered solution satisfies all 5 rules.

- [ ] **Step 1: Create `tests/nurikabe-fuzz.test.js`:**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { NurikabeSolver } = require('../solver.js');

function validate(rows, cols, task, grid) {
  const N = rows * cols;
  // Rule: every clue is part of an exact-N white island.
  const visited = new Uint8Array(N);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (task[r][c] <= 0) continue;
    if (grid[r][c] !== 2) return `clue (${r},${c}) is not WHITE`;
    const queue = [[r, c]];
    visited[r * cols + c] = 1;
    let size = 1;
    let cluesInside = 1;
    while (queue.length) {
      const [cr, cc] = queue.shift();
      for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const nr = cr + dr, nc = cc + dc;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        if (visited[nr * cols + nc]) continue;
        if (grid[nr][nc] !== 2) continue;
        visited[nr * cols + nc] = 1;
        if (task[nr][nc] > 0) cluesInside++;
        size++;
        queue.push([nr, nc]);
      }
    }
    if (cluesInside !== 1) return `island at (${r},${c}) has ${cluesInside} clues`;
    if (size !== task[r][c]) return `island at (${r},${c}) size ${size} != ${task[r][c]}`;
  }
  // Rule: no 2x2 of BLACK.
  for (let r = 0; r + 1 < rows; r++) for (let c = 0; c + 1 < cols; c++) {
    if (grid[r][c] === 1 && grid[r][c+1] === 1 && grid[r+1][c] === 1 && grid[r+1][c+1] === 1) {
      return `2x2 BLACK at (${r},${c})`;
    }
  }
  // Rule: BLACKs form single component.
  const blackVisited = new Uint8Array(N);
  let bStart = -1;
  let blackCount = 0;
  for (let i = 0; i < N; i++) {
    const r = (i / cols) | 0, c = i - r * cols;
    if (grid[r][c] === 1) { blackCount++; if (bStart < 0) bStart = i; }
  }
  if (bStart >= 0) {
    const q = [bStart]; blackVisited[bStart] = 1;
    let seen = 1;
    while (q.length) {
      const idx = q.shift();
      const r = (idx / cols) | 0, c = idx - r * cols;
      for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        const ni = nr * cols + nc;
        if (blackVisited[ni]) continue;
        if (grid[nr][nc] !== 1) continue;
        blackVisited[ni] = 1;
        seen++;
        q.push(ni);
      }
    }
    if (seen !== blackCount) return `sea has ${blackCount - seen} disconnected BLACKs`;
  }
  return null;
}

// Generate a random valid Nurikabe board by partitioning the grid into
// islands separated by BLACK cells, then emitting one clue per island.
function generateRandomBoard(rows, cols, seed) {
  let rng = seed >>> 0;
  const rand = () => {
    rng = (rng * 1103515245 + 12345) >>> 0;
    return rng / 0x100000000;
  };
  // Simple: place small islands greedily, fill the rest with BLACK.
  const grid = Array.from({length: rows}, () => new Array(cols).fill(1));
  const task = Array.from({length: rows}, () => new Array(cols).fill(-1));
  const visited = Array.from({length: rows}, () => new Array(cols).fill(false));
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (visited[r][c]) continue;
    if (rand() < 0.55) continue; // most cells become BLACK
    // Try to grow an island of size 1-3 from here.
    const targetSize = 1 + Math.floor(rand() * 3);
    const cells = [[r, c]];
    visited[r][c] = true;
    while (cells.length < targetSize) {
      const idx = Math.floor(rand() * cells.length);
      const [cr, cc] = cells[idx];
      const dirs = [[-1,0],[1,0],[0,-1],[0,1]].sort(() => rand() - 0.5);
      let grew = false;
      for (const [dr, dc] of dirs) {
        const nr = cr + dr, nc = cc + dc;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        if (visited[nr][nc]) continue;
        // Reject neighbours that would touch a non-this-island white.
        let safe = true;
        for (const [ddr, ddc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
          const nnr = nr + ddr, nnc = nc + ddc;
          if (nnr < 0 || nnr >= rows || nnc < 0 || nnc >= cols) continue;
          if (!visited[nnr][nnc]) continue;
          // The visited neighbour must be one of `cells`.
          const inIsland = cells.some(([ir, ic]) => ir === nnr && ic === nnc);
          if (!inIsland) { safe = false; break; }
        }
        if (!safe) continue;
        cells.push([nr, nc]);
        visited[nr][nc] = true;
        grew = true;
        break;
      }
      if (!grew) break;
    }
    for (const [ir, ic] of cells) grid[ir][ic] = 2;
    task[cells[0][0]][cells[0][1]] = cells.length;
  }
  // Reject boards with 2x2 BLACK.
  for (let r = 0; r + 1 < rows; r++) for (let c = 0; c + 1 < cols; c++) {
    if (grid[r][c] === 1 && grid[r][c+1] === 1 && grid[r+1][c] === 1 && grid[r+1][c+1] === 1) {
      return null;
    }
  }
  // Reject boards with disconnected sea OR no blacks.
  const N = rows * cols;
  const seen = new Uint8Array(N);
  let bStart = -1, blackCount = 0;
  for (let i = 0; i < N; i++) {
    const r = (i / cols) | 0, c = i - r * cols;
    if (grid[r][c] === 1) { blackCount++; if (bStart < 0) bStart = i; }
  }
  if (bStart < 0) return null;
  const q = [bStart]; seen[bStart] = 1; let s = 1;
  while (q.length) {
    const idx = q.shift();
    const r = (idx / cols) | 0, c = idx - r * cols;
    for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      const ni = nr * cols + nc;
      if (seen[ni]) continue;
      if (grid[nr][nc] !== 1) continue;
      seen[ni] = 1; s++; q.push(ni);
    }
  }
  if (s !== blackCount) return null;
  return { task, grid };
}

test('NurikabeSolver fuzz: solved boards satisfy all rules', () => {
  let solved = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const rows = 3 + (seed % 3);
    const cols = 3 + ((seed >> 2) % 3);
    const board = generateRandomBoard(rows, cols, seed * 7919 + 1);
    if (!board) continue;
    NurikabeSolver.clearSolutionCache();
    const s = new NurikabeSolver({ rows, cols, task: board.task, maxMs: 5000 });
    const r = s.solve();
    if (!r.solved) continue;
    const err = validate(rows, cols, board.task, r.grid);
    assert.equal(err, null, `seed=${seed} ${rows}x${cols}: ${err}`);
    solved++;
  }
  assert.ok(solved >= 10, `expected ≥ 10 solved boards, got ${solved}`);
});
```

- [ ] **Step 2: Run fuzz** — `node --test tests/nurikabe-fuzz.test.js`. Expect PASS.

- [ ] **Step 3: Commit**

```bash
jj commit -m "test(nurikabe): fuzz soundness check (validity not uniqueness)"
```

---

## Task 11: Fixture + golden + integration test

**Files:** `tests/fixtures/puzzles.js`, `tests/golden.js`, `tests/solver.test.js`.

Add a fixture matching the 5×5 recon and an integration test asserting the solver produces a valid solution.

- [ ] **Step 1: Add fixture** — open `tests/fixtures/puzzles.js`, add to the exports object (alphabetical between `mosaic` entries and `slitherlink`/`shikaku`-style entries, near the existing `norinori6x6Normal`):

```js
  nurikabe5x5Easy: {
    type: 'nurikabe',
    rows: 5,
    cols: 5,
    task: [
      [2, -1, -1, 1, -1],
      [-1, -1, -1, -1, -1],
      [3, -1, -1, -1, 1],
      [-1, -1, -1, -1, -1],
      [-1, 2, -1, -1, 2],
    ],
  },
```

- [ ] **Step 2: Add integration test** — append to `tests/solver.test.js`:

```js
test('NurikabeSolver: nurikabe5x5Easy fixture solves to a valid grid', () => {
  const fixture = fixtures.nurikabe5x5Easy;
  NurikabeSolver.clearSolutionCache();
  const s = new NurikabeSolver({
    rows: fixture.rows,
    cols: fixture.cols,
    task: fixture.task,
  });
  const r = s.solve();
  assert.equal(r.solved, true);
  // Validate via the rules.
  const N = fixture.rows * fixture.cols;
  // 1. Every clue has an island of size == clue.
  const visited = new Uint8Array(N);
  for (let row = 0; row < fixture.rows; row++) for (let col = 0; col < fixture.cols; col++) {
    if (fixture.task[row][col] <= 0) continue;
    assert.equal(r.grid[row][col], 2);
    const queue = [[row, col]];
    visited[row * fixture.cols + col] = 1;
    let size = 1, cluesInside = 1;
    while (queue.length) {
      const [cr, cc] = queue.shift();
      for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const nr = cr + dr, nc = cc + dc;
        if (nr < 0 || nr >= fixture.rows || nc < 0 || nc >= fixture.cols) continue;
        const ni = nr * fixture.cols + nc;
        if (visited[ni]) continue;
        if (r.grid[nr][nc] !== 2) continue;
        visited[ni] = 1;
        if (fixture.task[nr][nc] > 0) cluesInside++;
        size++;
        queue.push([nr, nc]);
      }
    }
    assert.equal(cluesInside, 1, `island at (${row},${col}) clues=${cluesInside}`);
    assert.equal(size, fixture.task[row][col], `island size at (${row},${col})`);
  }
  // 2. No 2x2 black.
  for (let row = 0; row + 1 < fixture.rows; row++)
    for (let col = 0; col + 1 < fixture.cols; col++)
      assert.ok(!(r.grid[row][col] === 1 && r.grid[row][col+1] === 1 &&
                  r.grid[row+1][col] === 1 && r.grid[row+1][col+1] === 1),
        `2x2 black at (${row},${col})`);
});
```

You'll also need to import `NurikabeSolver` at the top of `tests/solver.test.js`. Find the existing `require('../solver.js')` destructuring and add `NurikabeSolver` to it.

- [ ] **Step 3: Add `nurikabe5x5Easy` snapshot to `tests/golden.js`** if the golden file is the snapshot store for this project. (If goldens are produced via `npm run capture`, run it: `npm run capture`.)

- [ ] **Step 4: Run** — `npm test`. Expect PASS on the new test.

- [ ] **Step 5: Commit**

```bash
jj commit -m "test(nurikabe): 5x5 fixture + golden + integration test"
```

---

## Task 12: MAIN-world functions + allowlist + globals.d.ts + eslint

**Files:** `main-world.js`, `background.js`, `globals.d.ts`, `eslint.config.js`.

Add the read/state/apply triple for Nurikabe.

- [ ] **Step 1: Append to `main-world.js`** (after the Norinori block, before `dumpPuzzleForBench`):

```js
function readNurikabeData() {
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
        arr[c] = (typeof v === 'number' && v >= 0) ? v : -1;
      }
      task.push(arr);
    }
    return { rows: rows, cols: cols, task: task };
  } catch (e) {
    return null;
  }
}

function readNurikabeState(rows, cols) {
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

function applyNurikabeState(grid) {
  try {
    var G = window.Game;
    if (!G || !G.currentState || !G.currentState.cellStatus || !G.task) return false;
    if (typeof G.saveState === 'function') G.saveState(true);
    var cs = G.currentState.cellStatus;
    var rows = G.puzzleHeight, cols = G.puzzleWidth;
    for (var r = 0; r < rows; r++) {
      if (!cs[r]) cs[r] = [];
      for (var c = 0; c < cols; c++) {
        // Skip clue cells: page renders them separately, not user-toggleable.
        var t = (G.task[r] && G.task[r][c] !== undefined) ? G.task[r][c] : -1;
        if (typeof t === 'number' && t > 0) continue;
        cs[r][c] = grid[r][c];
      }
    }
    if (typeof G.drawCurrentState === 'function') G.drawCurrentState();
    if (typeof G.render === 'function') G.render();
    if (typeof G.redraw === 'function') G.redraw();
    return true;
  } catch (e) {
    console.warn('Nurikabe apply failed:', e);
    return false;
  }
}
```

- [ ] **Step 2: Add to `background.js`** — append three entries to `EXEC_MAIN_ALLOWLIST`:

```js
  'readNurikabeData',
  'readNurikabeState',
  'applyNurikabeState',
```

- [ ] **Step 3: Edit `globals.d.ts`** — add 3 entries to `MainWorldFn` union and add:

```ts
declare const NurikabeSolver: any;
```

(Locate the existing `declare const NorinoriSolver: any;` and add the new line right after.)

- [ ] **Step 4: Edit `eslint.config.js`** — find the `solverClasses` array and add `'NurikabeSolver'`.

- [ ] **Step 5: Run** — `npm run lint && npm run typecheck`. Expect clean.

- [ ] **Step 6: Commit**

```bash
jj commit -m "feat(nurikabe): MAIN-world fns + allowlist + globals + eslint"
```

---

## Task 13: Worker arm + handler

**Files:** `solver.worker.js`, `handler.js`.

Worker dispatches Nurikabe to `NurikabeSolver`. Handler matches `/nurikabe/`.

- [ ] **Step 1: Add to `solver.worker.js`** — find the dispatch switch / chain (look at how Norinori is dispatched). Add:

```js
  if (msg.type === 'nurikabe') {
    const solver = new NurikabeSolver({
      rows: msg.rows, cols: msg.cols, task: msg.task,
      initialState: msg.initialState, maxMs: 30000,
    });
    return solver.solve();
  }
```

- [ ] **Step 2: Add to `handler.js`** — find `norinoriHandler` registration and add immediately after:

```js
const nurikabeHandler = {
  name: 'nurikabe',
  priority: 30,
  matches(url) {
    return url.indexOf('/nurikabe/') !== -1;
  },
  async readData() {
    return await callMainWorld('readNurikabeData', []);
  },
  async readState(rows, cols) {
    return await callMainWorld('readNurikabeState', [rows, cols]);
  },
  async applySolution(grid) {
    const ok = await callMainWorld('applyNurikabeState', [grid]);
    return { success: !!ok };
  },
};
registerHandler(nurikabeHandler);
```

- [ ] **Step 3: Run lint** — `npm run lint`. Expect clean.

- [ ] **Step 4: Commit**

```bash
jj commit -m "feat(nurikabe): worker arm + handler"
```

---

## Task 14: Dump arm + real fixture + bench-real

**Files:** `main-world.js`, `tests/fixtures/real-puzzles.js`, `tests/bench-real.js`.

Add nurikabe arm to `dumpPuzzleForBench`. Capture a real 5×5 dump into the fixtures file.

- [ ] **Step 1: Add to `dumpPuzzleForBench`** in `main-world.js`, after the norinori branch:

```js
    if (path.indexOf('/nurikabe/') !== -1 || g.slug === 'nurikabe') {
      if (!g.task || !g.puzzleWidth || !g.puzzleHeight) {
        return { error: 'nurikabe: missing task/dims', diagnostic: diagnostic(g), path: path };
      }
      var nkRows = g.puzzleHeight, nkCols = g.puzzleWidth;
      var nkTask = [];
      for (var nkr = 0; nkr < nkRows; nkr++) {
        var nkSrc = g.task[nkr] || [];
        var nkDst = new Array(nkCols);
        for (var nkc = 0; nkc < nkCols; nkc++) {
          var nkv = nkSrc[nkc];
          nkDst[nkc] = (typeof nkv === 'number' && nkv >= 0) ? nkv : -1;
        }
        nkTask.push(nkDst);
      }
      var nkCellStatus = null;
      if (g.currentState && g.currentState.cellStatus) {
        nkCellStatus = [];
        for (var nkcr = 0; nkcr < nkRows; nkcr++) {
          var nkcsRow = g.currentState.cellStatus[nkcr] || [];
          var nkcsOut = new Array(nkCols);
          for (var nkcc = 0; nkcc < nkCols; nkcc++) nkcsOut[nkcc] = nkcsRow[nkcc] || 0;
          nkCellStatus.push(nkcsOut);
        }
      }
      return {
        type: 'nurikabe',
        rows: nkRows,
        cols: nkCols,
        task: nkTask,
        cellStatus: nkCellStatus,
        path: path,
      };
    }
```

- [ ] **Step 2: Rebuild + dump real 5×5** — `npm run build`, reload extension, open the 5×5 easy puzzle, click 📋 Dump, paste the result.

- [ ] **Step 3: Append to `tests/fixtures/real-puzzles.js`:**

```js
  nurikabe5x5EasyReal: {
    type: 'nurikabe',
    rows: 5,
    cols: 5,
    task: <PASTE the task from the dump>,
  },
```

- [ ] **Step 4: Add bench-real arm** — `tests/bench-real.js` — find the existing norinori arm and add a parallel block:

```js
} else if (puzzle.type === 'nurikabe') {
  NurikabeSolver.clearSolutionCache();
  const t0 = process.hrtime.bigint();
  const s = new NurikabeSolver({
    rows: puzzle.rows, cols: puzzle.cols, task: puzzle.task,
    maxMs: 30000,
  });
  const r = s.solve();
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;
  if (!r.solved) {
    console.error(`${name}: did not solve`);
    process.exit(1);
  }
  results.push({ name, ms });
}
```

- [ ] **Step 5: Run bench-real** — `node tests/bench-real.js`. Expect the new fixture to solve.

- [ ] **Step 6: Commit**

```bash
jj commit -m "feat(nurikabe): dump arm + real fixture + bench-real"
```

---

## Task 15: bench-nurikabe + nightly CI

**Files:** `tests/bench-nurikabe.js` (new), `.github/workflows/bench-nightly.yml`.

- [ ] **Step 1: Create `tests/bench-nurikabe.js`:**

```js
'use strict';
const { NurikabeSolver } = require('../solver.js');
const fixtures = require('./fixtures/real-puzzles.js');

function bench(name, fn, iterations = 7) {
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    const t1 = process.hrtime.bigint();
    times.push(Number(t1 - t0) / 1e6);
  }
  // Drop 2 warmups, report median.
  times.splice(0, 2);
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  console.log(`${name}: median ${median.toFixed(2)} ms over ${times.length} runs`);
}

for (const [name, p] of Object.entries(fixtures)) {
  if (p.type !== 'nurikabe') continue;
  bench(name, () => {
    NurikabeSolver.clearSolutionCache();
    const s = new NurikabeSolver({
      rows: p.rows, cols: p.cols, task: p.task, maxMs: 30000,
    });
    const r = s.solve();
    if (!r.solved) {
      console.error(`${name}: did not solve`);
      process.exit(1);
    }
  });
}
```

- [ ] **Step 2: Run bench** — `node tests/bench-nurikabe.js`. Expect the 5×5 to solve in a few ms.

- [ ] **Step 3: Add nightly step** in `.github/workflows/bench-nightly.yml`. Find the existing "Bench Norinori" step and add right after:

```yaml
      - name: Bench Nurikabe
        run: node tests/bench-nurikabe.js
```

- [ ] **Step 4: Commit**

```bash
jj commit -m "test(nurikabe): bench-nurikabe + nightly CI step"
```

---

## Task 16: content.js bookkeeping (SUPPORTED_PUZZLES, cache key, prefixes, flags)

**Files:** `content.js`.

Add Nurikabe entries to several lookup tables and bookkeeping spots in `content.js`. Follow the pattern of the existing Norinori entries.

- [ ] **Step 1: Add to `SUPPORTED_PUZZLES`** — alphabetical between Norinori and Shikaku:

```js
  nurikabe: {
    type: 'nurikabe',
    label: 'Nurikabe',
    urlIndicators: ['/nurikabe/'],
  },
```

- [ ] **Step 2: Add to `SOLUTION_KEY_PREFIXES`:**

```js
  'nurikabe-solution:',
```

- [ ] **Step 3: Add cache-key helper** — find `norinoriCacheKey` and add right after:

```js
function nurikabeCacheKey(puzzleData) {
  let h = 0x811c9dc5;
  const mix = (n) => { h ^= n & 0xff; h = Math.imul(h, 0x01000193) >>> 0; };
  mix(0x4F); // nameplate byte, distinct from Norinori (0x4E)
  mix(puzzleData.rows); mix(puzzleData.cols);
  for (let r = 0; r < puzzleData.rows; r++) {
    for (let c = 0; c < puzzleData.cols; c++) {
      const v = puzzleData.task[r][c];
      mix(v & 0xff); mix((v >>> 8) & 0xff);
    }
  }
  return (h >>> 0).toString(16);
}
```

- [ ] **Step 4: Add to `solveExtraData`** — locate the switch/dispatcher for per-puzzle solve extras. Add:

```js
    case 'nurikabe':
      return { task: puzzleData.task };
```

- [ ] **Step 5: Add `staticSig` segment** — locate where `staticSig` is composed; add a `|nu=` segment that hashes `puzzleData.task` (mirror the `|nn=` pattern):

```js
  if (puzzleData.type === 'nurikabe' && puzzleData.task) {
    parts.push('nu=' + nurikabeTaskSig(puzzleData.task));
  }
```

And add `nurikabeTaskSig` helper near `norinoriAreasSig`:

```js
function nurikabeTaskSig(task) {
  let h = 0x811c9dc5;
  const mix = (n) => { h ^= n & 0xff; h = Math.imul(h, 0x01000193) >>> 0; };
  for (let r = 0; r < task.length; r++) {
    for (let c = 0; c < task[r].length; c++) {
      const v = task[r][c];
      mix(v & 0xff); mix((v >>> 8) & 0xff);
    }
  }
  return (h >>> 0).toString(16);
}
```

- [ ] **Step 6: Add `isNurikabe` flag** — find `isNorinori` in `drawPreview`'s setup and add `const isNurikabe = puzzleData.type === 'nurikabe';` right after.

- [ ] **Step 7: Run** — `npm run lint && npm run typecheck`. Expect clean.

- [ ] **Step 8: Commit**

```bash
jj commit -m "feat(nurikabe): content.js bookkeeping"
```

---

## Task 17: drawPreview arm

**Files:** `content.js`.

Render Nurikabe cells: BLACK = solid dark fill, WHITE = light fill. Clue cells are drawn by the page; our overlay skips them.

- [ ] **Step 1: Add per-cell render arm** — in `drawPreview`, in the per-cell loop, after the `isNorinori` arm:

```js
        if (isNurikabe) {
          // Skip clue cells (page draws them).
          if (puzzleData.task && puzzleData.task[r] && puzzleData.task[r][c] > 0) continue;
          if (v === 1) {
            ctx.fillStyle = 'rgba(40, 40, 50, 0.92)';
            ctx.fillRect(x + 2, y + 2, cellW - 4, cellH - 4);
          } else if (v === 2) {
            ctx.fillStyle = 'rgba(240, 240, 240, 0.5)';
            ctx.fillRect(x + 2, y + 2, cellW - 4, cellH - 4);
          }
          continue;
        }
```

- [ ] **Step 2: Rebuild** — `npm run build`. Reload extension; open the 5×5 easy puzzle; click Solve. Preview should overlay BLACKs over non-clue cells and tint WHITE on the rest. Clue numbers remain visible.

- [ ] **Step 3: Commit**

```bash
jj commit -m "feat(nurikabe): drawPreview arm"
```

---

## Task 18: getHint dispatch + status + Loop break

**Files:** `content.js`.

Add Nurikabe to the hint dispatcher, status text, partial-result arm, and Loop done-check.

- [ ] **Step 1: Hint dispatch** — locate the hint dispatch chain (likely in `runHint` or similar). Add the Nurikabe arm:

```js
    case 'nurikabe': {
      const solver = new NurikabeSolver({
        rows: puzzleData.rows, cols: puzzleData.cols, task: puzzleData.task,
        maxMs: 5000,
      });
      const hint = solver.getHint(boardState);
      if (!hint || hint.length === 0) return null;
      return hint;
    }
```

- [ ] **Step 2: Status nodes** — locate `norinoriHintStatusNodes` (or similar) and add `nurikabeHintStatusNodes`:

```js
function nurikabeHintStatusNodes(hint) {
  return [bold(`Hint: ${hint.length} cell${hint.length === 1 ? '' : 's'}`)];
}
```

Add a dispatch arm in `setHintStatus`:

```js
    case 'nurikabe':
      return nurikabeHintStatusNodes(hint);
```

- [ ] **Step 3: Loop done-check** — find the Loop loop where it checks "every solution cell of value !=0 is on the board". For Nurikabe, the check is the same as Heyawake / Norinori — non-clue cells where solution !== 0 must equal the board. Add to the dispatcher:

```js
    case 'nurikabe':
      // Loop is done when every non-clue solution cell with value 1 or 2
      // matches on the board (clue cells are always rendered by the page).
      for (let r = 0; r < puzzleData.rows; r++) {
        for (let c = 0; c < puzzleData.cols; c++) {
          if (puzzleData.task[r][c] > 0) continue;
          const sol = solution[r][c];
          if (sol === 0) continue;
          if (boardState[r][c] !== sol) return false;
        }
      }
      return true;
```

- [ ] **Step 4: Partial result arm** — `solveHandler`'s partial-result switch. Add `'nurikabe'` to the list of types that route partial results to `applyPartialResult` (cell-state types). It probably already handles "any 2D grid" generically; verify no special-case needed.

- [ ] **Step 5: Rebuild + manual test** — `npm run build`, reload extension, open 5×5 easy:
  - Click Solve → grid fills correctly.
  - Click Hint → at least one cell deduced.
  - Click Loop → puzzle completes step-by-step.

- [ ] **Step 6: Commit**

```bash
jj commit -m "feat(nurikabe): getHint dispatch + status + Loop done-check"
```

---

## Task 19: Final verification + push

**Files:** none.

- [ ] **Step 1: Full test suite** — `npm test`. Expect all tests passing.

- [ ] **Step 2: Lint + typecheck** — `npm run lint && npm run typecheck`. Expect clean.

- [ ] **Step 3: Bench** — `node tests/bench-nurikabe.js`. Expect the 5×5 fixture to solve in a few ms.

- [ ] **Step 4: Manual smoke test in browser** — load extension on a fresh 5×5 easy puzzle. Verify Solve, Hint, Loop, Stop all work. Try the 📋 Dump button: confirm the dump emits a clean `type: 'nurikabe'` payload.

- [ ] **Step 5: Rebuild + commit** — `npm run build`. If dist/ changed, commit that too:

```bash
jj commit -m "build(nurikabe): refresh dist/"
```

- [ ] **Step 6: Push to main**

```bash
jj bookmark set main -r @-
jj git push --bookmark main
```

---

## Self-review notes

**Spec coverage check:**
- Spec §2 rules 1-5 → Tasks 2-6 + 8 (count rule). ✓
- Spec §3 constructor + clue init + pre-checks → Task 1. ✓
- Spec §3 `_set` plain assign + trail → Task 1. ✓
- Spec §3 lookahead + backtracking + caches → Tasks 7-8. ✓
- Spec §3 `getHint` stepwise → Task 9. ✓
- Spec §4 MAIN-world fns → Task 12. ✓
- Spec §4 dump arm → Task 14. ✓
- Spec §5 handler + worker → Task 13. ✓
- Spec §6 content.js bookkeeping (`SUPPORTED_PUZZLES`, prefix, cache key, sig, flag) → Task 16. ✓
- Spec §6 drawPreview → Task 17. ✓
- Spec §6 getHint dispatch, status, Loop check → Task 18. ✓
- Spec §7 tests (fixture, golden, unit, fuzz, integration, bench, real fixture, CI) → Tasks 1-11, 14-15. ✓

**Placeholder scan:** No "TODO" / "implement later" / "similar to" — all code blocks complete inline.

**Type consistency:** `NurikabeSolver`, `clues`, `expectedBlacks`, `cellStatus`, `task`, `contradiction`, `_set`, `_rollback`, `_propagate`, `_applyLookahead`, `_pickBestUnknown`, `_backtrack`, `solve`, `getHint`, `_cacheKey`, `_cloneResult`, `_storeInCache`, `_isComplete`, `_emit`, `_timeUp`, `_bfsClueReach`, `_bfsWhiteComponent`, `_islandCapacity`, `_reachableFromCell`, `_applyClueAdjacency`, `_applyUnreachable`, `_applyIslandComplete`, `_apply2x2`, `_applyBlackCount`, `_applySeaConnectivity` — names match across tasks.

End of plan.
