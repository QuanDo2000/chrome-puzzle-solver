# Stronger Nurikabe Solver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three new propagation rules + smarter branching to `NurikabeSolver` so the May-25 20×20 monthly (and similar monthlies) solves inside the 30 s worker budget.

**Architecture:** All changes are local to `NurikabeSolver` in `solver.js`. The three rules — `_applyFrontierForce`, `_applySeaArticulation`, `_applyShapeEnumeration` — slot into the existing `_propagate` fixpoint and `getHint` chain. `_pickBestUnknown` gains a composite score using reach data already populated.

**Reference spec:** `docs/superpowers/specs/2026-05-25-nurikabe-stronger-solver-design.md`
**Closest existing patterns:** `YinYangSolver._applyCut` (iterative Tarjan articulation), the existing `NurikabeSolver._bfsClueIsland` (clue BFS).

`jj commit` not git. Repo `/home/quando/documents/chrome-puzzle-solver/`. TDD.

---

## Task 1: `_applyFrontierForce` rule

**Files:** `solver.js` (modify `NurikabeSolver`), `tests/nurikabe.test.js` (append).

Find the `NurikabeSolver` class. Add the method immediately after `_applyIslandMerge` (or wherever the existing rules end). Add to `_propagate` between `_applyIslandMerge` and `_applyUnreachable`.

- [ ] **Step 1: Append failing tests to `tests/nurikabe.test.js`**

```js
test('NurikabeSolver._applyFrontierForce: single frontier cell forces WHITE', () => {
  // 1x4 clue 2 at (0,0), BLACK forced at (0,2) so the only frontier is (0,1).
  const s = new NurikabeSolver({
    rows: 1, cols: 4,
    task: [[2, -1, -1, -1]],
    initialState: [[2, 0, 1, 0]],
  });
  // claimedBy must be built first — it's part of the normal pipeline.
  assert.equal(s._buildClaimedBy(), true);
  assert.equal(s._applyFrontierForce(), true);
  assert.equal(s.cellStatus[1], 2);
});

test('NurikabeSolver._applyFrontierForce: empty frontier with unfinished island → contradiction', () => {
  // 1x3 clue 2 at (0,0); (0,1) BLACK isolates it; size < N with no growth path.
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[2, -1, -1]],
    initialState: [[2, 1, 0]],
  });
  assert.equal(s._buildClaimedBy(), true);
  assert.equal(s._applyFrontierForce(), false);
});

test('NurikabeSolver._applyFrontierForce: multiple frontier cells → no forcing', () => {
  // 2x2 clue 2 at (0,0). Both (0,1) and (1,0) are frontier — no inference.
  const s = new NurikabeSolver({
    rows: 2, cols: 2,
    task: [[2, -1], [-1, -1]],
  });
  assert.equal(s._buildClaimedBy(), true);
  assert.equal(s._applyFrontierForce(), true);
  assert.equal(s.cellStatus[1], 0);
  assert.equal(s.cellStatus[2], 0);
});
```

- [ ] **Step 2: Verify failure** — run `node --test tests/nurikabe.test.js`; expect `_applyFrontierForce is not a function`.

- [ ] **Step 3: Add `_applyFrontierForce` to `NurikabeSolver`**

Insert this method in the class (location: after `_applyIslandMerge`):

```js
  _applyFrontierForce() {
    const visited = this._bfsVisited;
    const queue = this._bfsQueue;
    const claimedBy = this._claimedBy;
    const isWall = this.isWall;
    const cellStatus = this.cellStatus;
    const task = this.task;
    const cols = this.cols, rows = this.rows;
    for (const clue of this.clues) {
      // BFS the current WHITE component from this clue. Track size and
      // collect frontier UNKNOWN cells (orthogonal neighbours of any member,
      // not blocked, not claimed by another clue).
      visited.fill(0);
      let qHead = 0, qTail = 0;
      visited[clue.idx] = 1;
      queue[qTail++] = clue.idx;
      let size = 1;
      let frontierCount = 0;
      let frontierIdx = -1;
      while (qHead < qTail) {
        const idx = queue[qHead++];
        const r = (idx / cols) | 0;
        const c = idx - r * cols;
        const visitN = (ni) => {
          if (visited[ni]) return;
          if (isWall[ni]) return;
          const v = cellStatus[ni];
          if (v === 1) return;
          if (task[ni] > 0 && ni !== clue.idx) return;
          const o = claimedBy[ni];
          if (o !== -1 && o !== clue.idx) return;
          if (v === 2) {
            visited[ni] = 1;
            size++;
            queue[qTail++] = ni;
          } else {
            // UNKNOWN frontier cell — mark to dedupe, count it.
            visited[ni] = 2;
            if (frontierCount === 0) frontierIdx = ni;
            frontierCount++;
          }
        };
        if (r > 0) visitN(idx - cols);
        if (r < rows - 1) visitN(idx + cols);
        if (c > 0) visitN(idx - 1);
        if (c < cols - 1) visitN(idx + 1);
      }
      if (size >= clue.size) continue;
      if (frontierCount === 0) return false; // island cannot grow
      if (frontierCount === 1) {
        if (!this._set(frontierIdx, 2)) return false;
      }
    }
    return true;
  }
```

- [ ] **Step 4: Wire into `_propagate`** — modify the existing `_propagate` body. Find:

```js
      if (!this._applyIslandMerge()) return false;
      if (!this._applyUnreachable()) return false;
```

Change to:

```js
      if (!this._applyIslandMerge()) return false;
      if (!this._applyFrontierForce()) return false;
      if (!this._applyUnreachable()) return false;
```

- [ ] **Step 5: Add to `getHint` rules array** — find the array and add the new entry between island-merge and unreachable:

```js
    const rules = [
      () => this._applyClueAdjacency(),
      () => { return this._buildClaimedBy() && this._applyIslandMerge(); },
      () => this._applyFrontierForce(),
      () => this._applyUnreachable(),
      () => this._applyIslandComplete(),
      () => this._apply2x2(),
      () => this._applySeaConnectivity(),
      () => this._applyBlackCount(),
    ];
```

- [ ] **Step 6: Run all nurikabe tests** — `node --test tests/nurikabe.test.js tests/nurikabe-fuzz.test.js`. Expect all passing.

- [ ] **Step 7: Commit**

```bash
jj commit -m "feat(nurikabe): _applyFrontierForce — single-frontier WHITE forcing"
```

---

## Task 2: `_applySeaArticulation` rule

**Files:** `solver.js`, `tests/nurikabe.test.js` (append).

Iterative Tarjan. Find articulation UNKNOWN cells whose removal disconnects BLACK cells; force them BLACK.

- [ ] **Step 1: Append failing tests**

```js
test('NurikabeSolver._applySeaArticulation: cut UNKNOWN between two BLACKs → BLACK', () => {
  // 1x3, BLACKs at (0,0) and (0,2), UNKNOWN at (0,1). (0,1) is the only
  // possible bridge — must be BLACK or sea is disconnected.
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[-1, -1, -1]],
    initialState: [[1, 0, 1]],
  });
  assert.equal(s._applySeaArticulation(), true);
  assert.equal(s.cellStatus[1], 1);
});

test('NurikabeSolver._applySeaArticulation: no BLACK cells yet → returns true, no force', () => {
  const s = new NurikabeSolver({
    rows: 3, cols: 3,
    task: [[1, -1, -1], [-1, -1, -1], [-1, -1, 1]],
  });
  assert.equal(s._applySeaArticulation(), true);
  // No cell should have flipped.
  for (let i = 0; i < 9; i++) {
    if (s.task[i] > 0) assert.equal(s.cellStatus[i], 2);
    else assert.equal(s.cellStatus[i], 0);
  }
});

test('NurikabeSolver._applySeaArticulation: alternative route exists → no force', () => {
  // 2x3, BLACKs at (0,0) and (0,2). UNKNOWN at (0,1), also UNKNOWN at (1,0)(1,1)(1,2)
  // — sea can connect around the bottom row.
  const s = new NurikabeSolver({
    rows: 2, cols: 3,
    task: [[-1, -1, -1], [-1, -1, -1]],
    initialState: [[1, 0, 1], [0, 0, 0]],
  });
  assert.equal(s._applySeaArticulation(), true);
  assert.equal(s.cellStatus[1], 0); // not forced — alternative exists
});

test('NurikabeSolver._applySeaArticulation: skipped during lookahead', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[-1, -1, -1]],
    initialState: [[1, 0, 1]],
  });
  s._inLookahead = true;
  assert.equal(s._applySeaArticulation(), true);
  assert.equal(s.cellStatus[1], 0); // not forced because lookahead is set
});
```

- [ ] **Step 2: Verify failure** — `_applySeaArticulation is not a function`.

- [ ] **Step 3: Add the method**

Insert after `_applySeaConnectivity`:

```js
  _applySeaArticulation() {
    if (this._inLookahead) return true;
    const N = this.N;
    const cols = this.cols, rows = this.rows;
    const isWall = this.isWall;
    const cellStatus = this.cellStatus;

    // Collect BLACK cells. If fewer than 2, no articulation possible.
    let firstBlack = -1;
    let blackCount = 0;
    for (let i = 0; i < N; i++) {
      if (cellStatus[i] === 1) {
        if (firstBlack < 0) firstBlack = i;
        blackCount++;
      }
    }
    if (firstBlack < 0 || blackCount < 2) return true;

    // Iterative Tarjan articulation over the {BLACK ∪ UNKNOWN} \ wall graph.
    // disc/low/parent arrays sized N; -1 sentinel for "not visited".
    const disc = new Int32Array(N).fill(-1);
    const low = new Int32Array(N).fill(-1);
    const parent = new Int32Array(N).fill(-1);
    const isArt = new Uint8Array(N);
    const stack = new Int32Array(N);
    const childIter = new Int32Array(N); // next child index for each node
    let timer = 0;

    const passable = (i) => !isWall[i] && (cellStatus[i] === 1 || cellStatus[i] === 0);

    let sp = 0;
    stack[sp++] = firstBlack;
    disc[firstBlack] = low[firstBlack] = timer++;
    let rootChildren = 0;

    while (sp > 0) {
      const u = stack[sp - 1];
      const ci = childIter[u]++;
      // Map ci to one of four neighbours.
      const r = (u / cols) | 0;
      const c = u - r * cols;
      let v = -1;
      if (ci === 0 && r > 0) v = u - cols;
      else if (ci === 1 && r < rows - 1) v = u + cols;
      else if (ci === 2 && c > 0) v = u - 1;
      else if (ci === 3 && c < cols - 1) v = u + 1;

      if (ci >= 4) {
        sp--;
        const p = parent[u];
        if (p >= 0) {
          if (low[u] < low[p]) low[p] = low[u];
          if (low[u] >= disc[p] && parent[p] !== -1) isArt[p] = 1;
        }
        continue;
      }
      if (v < 0 || !passable(v)) continue;
      if (disc[v] === -1) {
        parent[v] = u;
        disc[v] = low[v] = timer++;
        stack[sp++] = v;
        if (u === firstBlack) rootChildren++;
      } else if (v !== parent[u]) {
        if (disc[v] < low[u]) low[u] = disc[v];
      }
    }
    // Root is articulation iff it has >1 DFS children.
    if (rootChildren > 1) isArt[firstBlack] = 1;

    // For each articulation UNKNOWN, verify removal actually strands a BLACK.
    // Cheap test: re-run a BFS over {BLACK ∪ UNKNOWN} \ wall excluding the
    // articulation cell, count how many BLACKs are reachable from firstBlack.
    // If < blackCount, the cell is genuinely a cut → force BLACK.
    const visited = this._bfsVisited;
    const queue = this._bfsQueue;
    for (let u = 0; u < N; u++) {
      if (!isArt[u]) continue;
      if (cellStatus[u] !== 0) continue;
      // Probe: temporarily mark u as a blocker, BFS from firstBlack, count.
      visited.fill(0);
      let qH = 0, qT = 0;
      if (u === firstBlack) continue; // shouldn't happen for unknown root but guard
      visited[u] = 1; // exclude
      visited[firstBlack] = 1;
      queue[qT++] = firstBlack;
      let seen = (cellStatus[firstBlack] === 1) ? 1 : 0;
      while (qH < qT) {
        const idx = queue[qH++];
        const rr = (idx / cols) | 0;
        const cc = idx - rr * cols;
        const tryN = (ni) => {
          if (visited[ni]) return;
          if (isWall[ni]) return;
          const v = cellStatus[ni];
          if (v === 2) return;
          visited[ni] = 1;
          if (v === 1) seen++;
          queue[qT++] = ni;
        };
        if (rr > 0) tryN(idx - cols);
        if (rr < rows - 1) tryN(idx + cols);
        if (cc > 0) tryN(idx - 1);
        if (cc < cols - 1) tryN(idx + 1);
      }
      if (seen < blackCount) {
        if (!this._set(u, 1)) return false;
      }
    }
    return true;
  }
```

- [ ] **Step 4: Wire into `_propagate`** — find:

```js
      if (!this._applySeaConnectivity()) return false;
      if (!this._applyBlackCount()) return false;
```

Change to:

```js
      if (!this._applySeaConnectivity()) return false;
      if (!this._applySeaArticulation()) return false;
      if (!this._applyBlackCount()) return false;
```

- [ ] **Step 5: Add to `getHint` rules array** — insert between sea-connectivity and black-count:

```js
      () => this._applySeaConnectivity(),
      () => this._applySeaArticulation(),
      () => this._applyBlackCount(),
```

- [ ] **Step 6: Run tests** — `node --test tests/nurikabe.test.js tests/nurikabe-fuzz.test.js`. All passing.

- [ ] **Step 7: Commit**

```bash
jj commit -m "feat(nurikabe): _applySeaArticulation — Tarjan-based BLACK cut forcing"
```

---

## Task 3: Constructor scratch buffers for shape enumeration

**Files:** `solver.js`.

Add buffers needed by the shape-enumeration rule before implementing it.

- [ ] **Step 1: Modify constructor**

Find the existing buffer-allocation block:

```js
    this._bfsVisited = new Uint8Array(this.N);
    this._bfsQueue = new Int32Array(this.N);
    this._bfsMembers = new Uint8Array(this.N);
    this._bfsReachable = new Uint8Array(this.N);
    this._bfsReachList = new Int32Array(this.N);
    this._bfsMembersList = new Int32Array(this.N);
    this._bfsFrontierList = new Int32Array(this.N);
    this._claimedBy = new Int32Array(this.N);
```

Append:

```js
    // Shape enumeration scratch.
    this._shapeInShape = new Uint8Array(this.N);
    this._shapeStack = new Int32Array(this.N);
    this._shapeFrontier = new Int32Array(this.N);
    this._shapeInFrontier = new Uint8Array(this.N);
    this._shapeInAll = new Uint8Array(this.N);
    this._shapeInAny = new Uint8Array(this.N);
    // Per-cell tally: union of "this cell is in at least one shape of some
    // clue whose reach includes it". Used for cross-clue exclusion.
    this._shapeCouldBeWhite = new Uint8Array(this.N);
    // Coarse dirty bit — set whenever cellStatus changes via _set; cleared
    // by _applyShapeEnumeration on entry.
    this._dirtyShape = true;
```

- [ ] **Step 2: Hook `_set` to set `_dirtyShape`** — find the existing `_set` body:

```js
  _set(idx, value) {
    const old = this.cellStatus[idx];
    if (old === value) return true;
    if (old !== 0) return false;
    this.trail.push(idx | (old << 24));
    this.cellStatus[idx] = value;
    return true;
  }
```

Change to:

```js
  _set(idx, value) {
    const old = this.cellStatus[idx];
    if (old === value) return true;
    if (old !== 0) return false;
    this.trail.push(idx | (old << 24));
    this.cellStatus[idx] = value;
    this._dirtyShape = true;
    return true;
  }
```

- [ ] **Step 3: Run tests** — `node --test tests/nurikabe.test.js`. All passing (no behaviour change, just new buffers).

- [ ] **Step 4: Commit**

```bash
jj commit -m "refactor(nurikabe): scratch buffers + dirty bit for shape enumeration"
```

---

## Task 4: `_applyShapeEnumeration` — core DFS + WHITE forcing

**Files:** `solver.js`, `tests/nurikabe.test.js`.

Implement the rule for forcing WHITE via the `inAll` intersection. Leave the cross-clue BLACK exclusion for Task 5.

- [ ] **Step 1: Append failing tests**

```js
test('NurikabeSolver._applyShapeEnumeration: 1x3 clue 3 forces all cells WHITE', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[3, -1, -1]],
  });
  assert.equal(s._buildClaimedBy(), true);
  assert.equal(s._applyShapeEnumeration(), true);
  assert.equal(s.cellStatus[0], 2);
  assert.equal(s.cellStatus[1], 2);
  assert.equal(s.cellStatus[2], 2);
});

test('NurikabeSolver._applyShapeEnumeration: 2x3 clue 3 + BLACK boundary forces shared cell WHITE', () => {
  // 2x3 with clue 3 at (0,0) and BLACK at (0,2). Two valid shapes:
  //   {(0,0),(0,1),(1,0)} and {(0,0),(0,1),(1,1)}.
  // Both include (0,1) → (0,1) must be WHITE.
  const s = new NurikabeSolver({
    rows: 2, cols: 3,
    task: [[3, -1, -1], [-1, -1, -1]],
    initialState: [[2, 0, 1], [0, 0, 0]],
  });
  assert.equal(s._buildClaimedBy(), true);
  assert.equal(s._applyShapeEnumeration(), true);
  assert.equal(s.cellStatus[1], 2);
});

test('NurikabeSolver._applyShapeEnumeration: divergent shapes leave shared-only cells unknown', () => {
  // 2x2 with clue 2 at (0,0). Shapes: {(0,0),(0,1)} and {(0,0),(1,0)}.
  // (0,1) and (1,0) each appear in one shape only — neither forced.
  const s = new NurikabeSolver({
    rows: 2, cols: 2,
    task: [[2, -1], [-1, -1]],
  });
  assert.equal(s._buildClaimedBy(), true);
  assert.equal(s._applyShapeEnumeration(), true);
  assert.equal(s.cellStatus[1], 0);
  assert.equal(s.cellStatus[2], 0);
});

test('NurikabeSolver._applyShapeEnumeration: skips clues larger than cap', () => {
  // 4x4 with a clue 16 (covers whole board). Skip enumeration — no
  // inference, no crash, no change to cellStatus.
  const taskArr = [
    [16, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1]
  ];
  const s = new NurikabeSolver({ rows: 4, cols: 4, task: taskArr });
  assert.equal(s._buildClaimedBy(), true);
  // No assertion about state — just that the call completes without throw.
  assert.equal(s._applyShapeEnumeration(), true);
});
```

- [ ] **Step 2: Verify failure** — `_applyShapeEnumeration is not a function`.

- [ ] **Step 3: Add caps + helper + the method**

Insert near the top of the class, right after the constructor:

```js
  // Caps for _applyShapeEnumeration. Both numbers are conservative — raise
  // only after benching.
  static MAX_SHAPES_PER_CLUE = 2000;
  static MAX_ENUMERATED_CLUE_SIZE = 12;
```

Then add the rule method. Place it right after `_applyIslandComplete`:

```js
  // For one clue, recursively enumerate connected supersets of its current
  // WHITE component of size exactly clue.size, drawing from {WHITE ∪
  // UNKNOWN} cells not blocked by BLACK / walls / other clue cells / cells
  // claimed by other clues. On each surviving shape, mark this._shapeInAll
  // and this._shapeInAny per cell. Returns:
  //   { count, capped, infeasible } where:
  //     count       — number of valid shapes found
  //     capped      — true if MAX_SHAPES_PER_CLUE hit
  //     infeasible  — true if zero valid shapes found
  _enumerateClueShapes(clue) {
    const N = this.N;
    const cols = this.cols, rows = this.rows;
    const isWall = this.isWall;
    const cellStatus = this.cellStatus;
    const task = this.task;
    const claimedBy = this._claimedBy;
    const inShape = this._shapeInShape;
    const inFrontier = this._shapeInFrontier;
    const stack = this._shapeStack;
    const frontier = this._shapeFrontier;
    const inAll = this._shapeInAll;
    const inAny = this._shapeInAny;

    inShape.fill(0);
    inFrontier.fill(0);
    // Initialize inAll = 1 everywhere, inAny = 0 — we AND inAll with each
    // shape's membership and OR inAny.
    inAll.fill(1);
    inAny.fill(0);

    // Seed shape with the clue's current WHITE component members.
    let shapeSize = 0;
    let stackTop = 0;
    let frontierTop = 0;
    const seedQueue = this._bfsQueue;
    let qH = 0, qT = 0;
    inShape[clue.idx] = 1;
    stack[stackTop++] = clue.idx;
    shapeSize = 1;
    seedQueue[qT++] = clue.idx;
    while (qH < qT) {
      const idx = seedQueue[qH++];
      const r = (idx / cols) | 0;
      const c = idx - r * cols;
      const seedN = (ni) => {
        if (inShape[ni]) return;
        if (isWall[ni]) return;
        const v = cellStatus[ni];
        if (v === 1) return;
        if (task[ni] > 0 && ni !== clue.idx) return;
        const o = claimedBy[ni];
        if (o !== -1 && o !== clue.idx) return;
        if (v === 2) {
          inShape[ni] = 1;
          shapeSize++;
          stack[stackTop++] = ni;
          seedQueue[qT++] = ni;
        } else {
          // UNKNOWN frontier candidate.
          if (!inFrontier[ni]) {
            inFrontier[ni] = 1;
            frontier[frontierTop++] = ni;
          }
        }
      };
      if (r > 0) seedN(idx - cols);
      if (r < rows - 1) seedN(idx + cols);
      if (c > 0) seedN(idx - 1);
      if (c < cols - 1) seedN(idx + 1);
    }
    if (shapeSize > clue.size) {
      // Inconsistent existing component — let _applyIslandComplete catch it.
      return { count: 0, capped: false, infeasible: false };
    }

    const target = clue.size;
    const MAX = NurikabeSolver.MAX_SHAPES_PER_CLUE;
    let shapeCount = 0;
    let capped = false;

    const recordShape = () => {
      shapeCount++;
      for (let k = 0; k < stackTop; k++) inAny[stack[k]] = 1;
      // AND inAll with current membership: any cell not in this shape
      // can no longer be in every shape.
      // Iterate the set of currently-in-shape cells: zero out inAll for
      // cells NOT in shape would require iterating all N. Cheaper: track
      // inverse — clear inAll on first shape entry to "membership of this
      // shape only" by zeroing then setting per-stack. But we want
      // intersection across shapes.
      //
      // Trick: track inAll as a count = shapesContainingCell. After
      // enumeration we keep cells where count === shapeCount. To keep the
      // arrays Uint8Array-sized, do this via the inAny array trick instead:
      // we'll patch this in the caller.
      if (shapeCount === 1) {
        // First shape: mark inAll for cells in this shape (others stay 1
        // for now; we'll prune at end).
        for (let i = 0; i < N; i++) {
          inAll[i] = inShape[i];
        }
      } else {
        // AND with this shape.
        for (let i = 0; i < N; i++) {
          if (inAll[i] && !inShape[i]) inAll[i] = 0;
        }
      }
    };

    // Iterative recursion via explicit stack of (frontierStart, frontierEnd)
    // would be complex; recursive DFS is fine here because target ≤ 12.
    const recurse = () => {
      if (shapeCount >= MAX) { capped = true; return; }
      if (shapeSize === target) {
        if (this._shapeIsValid(clue)) recordShape();
        return;
      }
      // Snapshot frontier length to roll back after this depth's adds.
      const baseFrontierTop = frontierTop;
      // Iterate over current frontier as it is at entry. Capture indices
      // up front because we'll append during iteration.
      const baseCells = [];
      for (let i = 0; i < baseFrontierTop; i++) {
        const f = frontier[i];
        if (!inShape[f]) baseCells.push(f);
      }
      for (let i = 0; i < baseCells.length; i++) {
        if (shapeCount >= MAX) { capped = true; break; }
        const cell = baseCells[i];
        if (inShape[cell]) continue;
        // Add cell to shape.
        inShape[cell] = 1;
        stack[stackTop++] = cell;
        shapeSize++;
        // Extend frontier with cell's UNKNOWN/WHITE neighbours (with the
        // same blocking rules as seeding).
        const fAddedFrom = frontierTop;
        const rc = (cell / cols) | 0;
        const cc = cell - rc * cols;
        const addF = (ni) => {
          if (inShape[ni]) return;
          if (isWall[ni]) return;
          const v = cellStatus[ni];
          if (v === 1) return;
          if (task[ni] > 0 && ni !== clue.idx) return;
          const o = claimedBy[ni];
          if (o !== -1 && o !== clue.idx) return;
          if (inFrontier[ni]) return;
          inFrontier[ni] = 1;
          frontier[frontierTop++] = ni;
        };
        if (rc > 0) addF(cell - cols);
        if (rc < rows - 1) addF(cell + cols);
        if (cc > 0) addF(cell - 1);
        if (cc < cols - 1) addF(cell + 1);
        recurse();
        // Rollback.
        for (let k = fAddedFrom; k < frontierTop; k++) inFrontier[frontier[k]] = 0;
        frontierTop = fAddedFrom;
        shapeSize--;
        stackTop--;
        inShape[cell] = 0;
      }
    };

    if (shapeSize === target) {
      if (this._shapeIsValid(clue)) recordShape();
    } else {
      recurse();
    }

    // Clean frontier marks for next clue.
    for (let i = 0; i < frontierTop; i++) inFrontier[frontier[i]] = 0;
    for (let i = 0; i < stackTop; i++) inShape[stack[i]] = 0;

    return { count: shapeCount, capped, infeasible: shapeCount === 0 && !capped };
  }

  // Validate the current shape (cells where inShape === 1). Returns true if
  // the shape passes the no-merge + no-2x2-black checks. Used by
  // _enumerateClueShapes.
  _shapeIsValid(clue) {
    const cols = this.cols, rows = this.rows;
    const inShape = this._shapeInShape;
    const isWall = this.isWall;
    const cellStatus = this.cellStatus;
    const claimedBy = this._claimedBy;
    const stack = this._shapeStack;
    // No-merge: any UNKNOWN cell in the shape must not be orthogonally
    // adjacent to a WHITE cell claimed by a different clue.
    const N = this.N;
    let stackTop = 0;
    for (let i = 0; i < N; i++) if (inShape[i]) stack[stackTop++] = i;
    for (let s = 0; s < stackTop; s++) {
      const idx = stack[s];
      const r = (idx / cols) | 0;
      const c = idx - r * cols;
      if (cellStatus[idx] === 0) {
        // Check neighbours
        const check = (ni) => {
          if (cellStatus[ni] === 2 && claimedBy[ni] !== -1 && claimedBy[ni] !== clue.idx) {
            return false;
          }
          return true;
        };
        if (r > 0 && !check(idx - cols)) return false;
        if (r < rows - 1 && !check(idx + cols)) return false;
        if (c > 0 && !check(idx - 1)) return false;
        if (c < cols - 1 && !check(idx + 1)) return false;
      }
    }
    // No-2x2-black: shape's outer ring (UNKNOWN neighbours not in shape)
    // would be forced BLACK by clue isolation. Together with existing
    // BLACK/wall cells, must not create a 2x2 of all-black cells.
    // Build a "would-be-black" set: for each shape cell, mark UNKNOWN
    // neighbours not in shape as candidate-black.
    const wouldBlack = this._bfsVisited; // reuse — we will fill(0) at end
    wouldBlack.fill(0);
    for (let s = 0; s < stackTop; s++) {
      const idx = stack[s];
      const r = (idx / cols) | 0;
      const c = idx - r * cols;
      const addB = (ni) => {
        if (inShape[ni]) return;
        if (isWall[ni]) return;
        if (cellStatus[ni] === 0) wouldBlack[ni] = 1;
        // WHITE/BLACK don't extend forced-black set (WHITE belongs to a
        // different clue and is the caller's problem already; BLACK is
        // already black).
      };
      if (r > 0) addB(idx - cols);
      if (r < rows - 1) addB(idx + cols);
      if (c > 0) addB(idx - 1);
      if (c < cols - 1) addB(idx + 1);
    }
    // Now check every 2x2 in the bounding box of the shape ± 1 cell.
    let minR = rows, minC = cols, maxR = -1, maxC = -1;
    for (let s = 0; s < stackTop; s++) {
      const idx = stack[s];
      const r = (idx / cols) | 0;
      const c = idx - r * cols;
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
    }
    const r0 = Math.max(0, minR - 1);
    const c0 = Math.max(0, minC - 1);
    const r1 = Math.min(rows - 2, maxR);
    const c1 = Math.min(cols - 2, maxC);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const a = r * cols + c;
        const b = a + 1;
        const d = a + cols;
        const e = d + 1;
        // Each cell black iff cellStatus===1, OR (wouldBlack[i] === 1 and
        // not in shape). Walls and shape cells are not black.
        const isBlack = (ii) => {
          if (inShape[ii]) return false;
          if (isWall[ii]) return false;
          if (cellStatus[ii] === 1) return true;
          if (wouldBlack[ii]) return true;
          return false;
        };
        if (isBlack(a) && isBlack(b) && isBlack(d) && isBlack(e)) {
          // Clean up before returning.
          wouldBlack.fill(0);
          return false;
        }
      }
    }
    wouldBlack.fill(0);
    return true;
  }

  // Main rule: iterate clues whose size ≤ MAX_ENUMERATED_CLUE_SIZE; for
  // each, enumerate shapes; force WHITE on cells in every shape; also
  // accumulate the cross-clue exclusion vector (used in Task 5).
  _applyShapeEnumeration() {
    if (!this._dirtyShape) return true;
    this._dirtyShape = false;
    const couldBeWhite = this._shapeCouldBeWhite;
    couldBeWhite.fill(0);
    for (const clue of this.clues) {
      if (this._timeUp()) return true;
      if (clue.size > NurikabeSolver.MAX_ENUMERATED_CLUE_SIZE) continue;
      const { count, capped, infeasible } = this._enumerateClueShapes(clue);
      if (capped) continue; // no inference from this clue
      if (infeasible) return false; // no valid shape exists → contradiction
      if (count === 0) continue;
      // Force WHITE on inAll cells.
      for (let i = 0; i < this.N; i++) {
        if (this._shapeInAll[i] && this.cellStatus[i] === 0) {
          if (!this._set(i, 2)) return false;
        }
        if (this._shapeInAny[i]) couldBeWhite[i] = 1;
      }
    }
    return true;
  }
```

- [ ] **Step 4: Run tests** — `node --test tests/nurikabe.test.js`. The 4 new tests should pass; existing tests should also pass.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(nurikabe): _applyShapeEnumeration — DFS shape enumeration + inAll WHITE forcing"
```

---

## Task 5: Cross-clue exclusion → BLACK in `_applyShapeEnumeration`

**Files:** `solver.js`, `tests/nurikabe.test.js`.

After enumerating all clues, an UNKNOWN cell in the union of clue reaches but in no clue's enumerated shapes must be BLACK.

- [ ] **Step 1: Append failing test**

```js
test('NurikabeSolver._applyShapeEnumeration: cell in reach but in no shape → BLACK', () => {
  // 3x1 with clue 1 at (0,0). Reach of the clue is just {(0,0)} (size 1).
  // (1,0) is NOT in the reach so already BLACK from _applyUnreachable.
  // To test cross-clue exclusion specifically: use 1x4 with clue 2 at (0,0)
  // and clue 1 at (0,3). Cell (0,1) is in clue (0,0)'s reach via shape
  // {(0,0),(0,1)} — could be WHITE. Cell (0,2) is in clue (0,0)'s reach
  // (Manhattan ≤ 1) but NO shape of size 2 from (0,0) includes (0,2). Not
  // in clue (0,3)'s reach either (size 1). So (0,2) must be BLACK.
  const s = new NurikabeSolver({
    rows: 1, cols: 4,
    task: [[2, -1, -1, 1]],
  });
  assert.equal(s._buildClaimedBy(), true);
  // Run _applyUnreachable first to set up the reach union.
  assert.equal(s._applyUnreachable(), true);
  assert.equal(s._applyShapeEnumeration(), true);
  assert.equal(s.cellStatus[2], 1);
});
```

- [ ] **Step 2: Verify failure** — the assertion `cellStatus[2] === 1` will fail (cell stays 0 because the rule only does WHITE forcing today).

- [ ] **Step 3: Extend `_applyShapeEnumeration`**

Replace the rule body's tail (after the `for (const clue of this.clues)` loop):

```js
    for (const clue of this.clues) {
      // ...existing body (unchanged)...
    }
    // Cross-clue exclusion. _bfsReachable holds the union of clue reaches
    // computed by _applyUnreachable; couldBeWhite holds the union of cells
    // that appeared in at least one enumerated shape across all clues.
    // Any UNKNOWN cell in the reach union but with couldBeWhite[i] === 0
    // must be BLACK.
    const reachUnion = this._bfsReachable;
    for (let i = 0; i < this.N; i++) {
      if (this.cellStatus[i] !== 0) continue;
      if (this.isWall[i]) continue;
      if (!reachUnion[i]) continue;
      if (couldBeWhite[i]) continue;
      // Sanity: if this cell isn't reachable from any enumerable clue (all
      // its candidate clues are over the size cap or all hit MAX_SHAPES),
      // skip forcing — we don't have enough info.
      let hasReachableEnumerable = false;
      for (const clue of this.clues) {
        if (clue.size > NurikabeSolver.MAX_ENUMERATED_CLUE_SIZE) continue;
        // Cheap Manhattan reach check (no BFS per cell): the actual reach
        // bookkeeping is in _bfsReachable; we already know reachUnion[i] is
        // set, so SOME clue can reach this cell. We only need to ensure at
        // least one of them was enumerated. Approximate: assume yes if any
        // small clue exists at Manhattan ≤ clue.size - 1 from i.
        const r = (i / this.cols) | 0;
        const c = i - r * this.cols;
        const cr = (clue.idx / this.cols) | 0;
        const cc = clue.idx - cr * this.cols;
        if (Math.abs(cr - r) + Math.abs(cc - c) <= clue.size - 1) {
          hasReachableEnumerable = true;
          break;
        }
      }
      if (!hasReachableEnumerable) continue;
      if (!this._set(i, 1)) return false;
    }
    return true;
  }
```

(The `return true;` closes the function; preserve the existing closing brace of `_applyShapeEnumeration`.)

- [ ] **Step 4: Update the test to ensure `_applyUnreachable` is called first** — required because shape enumeration depends on `_bfsReachable` being populated.

The test as written already calls `_applyUnreachable` before `_applyShapeEnumeration`. Good.

- [ ] **Step 5: Run all nurikabe tests** — `node --test tests/nurikabe.test.js tests/nurikabe-fuzz.test.js`. All passing.

- [ ] **Step 6: Commit**

```bash
jj commit -m "feat(nurikabe): shape enumeration cross-clue BLACK exclusion"
```

---

## Task 6: Wire `_applyShapeEnumeration` into `_propagate` + `getHint`

**Files:** `solver.js`.

The rule runs at top-level only, before single-cell lookahead.

- [ ] **Step 1: Modify `_propagate`**

Find:

```js
    if (this._depth === 0 && !this._inLookahead) {
      if (!this._applyLookahead()) return false;
    }
    return true;
  }
```

Replace with:

```js
    if (this._depth === 0 && !this._inLookahead) {
      if (!this._applyShapeEnumeration()) return false;
      // If shape enumeration forced anything, re-run the cheaper fixpoint
      // before lookahead.
      if (this.trail.length > 0 && !this._dirtyShape) {
        // _applyShapeEnumeration cleared _dirtyShape only if no _set fired.
      }
      if (this._dirtyShape) {
        // shape enum changed state — run fixpoint again to settle.
        if (!this._propagateFixpointOnly()) return false;
      }
      if (!this._applyLookahead()) return false;
    }
    return true;
  }
```

- [ ] **Step 2: Refactor the fixpoint loop into a helper** — extract the `while (changed)` loop body of `_propagate` into a method called `_propagateFixpointOnly` (same body, just without the lookahead/shape-enum tail).

Locate the current `_propagate` body. Refactor:

```js
  _propagate() {
    if (!this._propagateFixpointOnly()) return false;
    if (this._depth === 0 && !this._inLookahead) {
      if (!this._applyShapeEnumeration()) return false;
      if (this._dirtyShape) {
        if (!this._propagateFixpointOnly()) return false;
      }
      if (!this._applyLookahead()) return false;
    }
    return true;
  }

  _propagateFixpointOnly() {
    let changed = true;
    while (changed) {
      if (this._timeUp()) return true;
      changed = false;
      const mark = this.trail.length;
      if (!this._applyClueAdjacency()) return false;
      if (!this._buildClaimedBy()) return false;
      if (!this._applyIslandMerge()) return false;
      if (!this._applyFrontierForce()) return false;
      if (!this._applyUnreachable()) return false;
      if (!this._applyIslandComplete()) return false;
      if (!this._apply2x2()) return false;
      if (!this._applySeaConnectivity()) return false;
      if (!this._applySeaArticulation()) return false;
      if (!this._applyBlackCount()) return false;
      if (this.trail.length > mark) changed = true;
    }
    return true;
  }
```

- [ ] **Step 3: Modify `getHint` rules array** — append shape enumeration as the final stepwise rule (after black-count):

```js
    const rules = [
      () => this._applyClueAdjacency(),
      () => { return this._buildClaimedBy() && this._applyIslandMerge(); },
      () => this._applyFrontierForce(),
      () => this._applyUnreachable(),
      () => this._applyIslandComplete(),
      () => this._apply2x2(),
      () => this._applySeaConnectivity(),
      () => this._applySeaArticulation(),
      () => this._applyBlackCount(),
      () => this._applyShapeEnumeration(),
    ];
```

- [ ] **Step 4: Run tests** — `node --test tests/nurikabe.test.js tests/nurikabe-fuzz.test.js`. All passing.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(nurikabe): integrate shape enumeration into _propagate at depth 0"
```

---

## Task 7: Smarter `_pickBestUnknown`

**Files:** `solver.js`, `tests/nurikabe.test.js`.

Composite score using clue-reach data already populated by `_applyUnreachable`.

- [ ] **Step 1: Add a unit test**

```js
test('NurikabeSolver._pickBestUnknown: prefers cell in single clue reach', () => {
  // 1x4 with clue 2 at (0,0) and clue 1 at (0,3). After unreachable,
  // (0,1) is in clue-2's reach only; (0,2) BLACK. Pick should target (0,1).
  const s = new NurikabeSolver({
    rows: 1, cols: 4,
    task: [[2, -1, -1, 1]],
  });
  assert.equal(s._buildClaimedBy(), true);
  assert.equal(s._applyUnreachable(), true);
  // (0,1) is the only remaining UNKNOWN.
  const idx = s._pickBestUnknown();
  assert.equal(idx, 1);
});
```

- [ ] **Step 2: Verify the test passes against the EXISTING code** — sanity check that the test reflects current behaviour for a trivial board. (For this 4-cell example any heuristic picks the only unknown. The point of the test is to lock in the existing API and catch refactor regressions.)

- [ ] **Step 3: Replace `_pickBestUnknown`**

Find the existing method and replace:

```js
  _pickBestUnknown() {
    let bestIdx = -1, bestScore = -1;
    const reachUnion = this._bfsReachable;
    const claimedBy = this._claimedBy;
    // Find the clue with the smallest remaining N - S so we can bias
    // toward closing it out.
    let smallestRemaining = Infinity;
    let smallestClueIdx = -1;
    for (const clue of this.clues) {
      const { size } = this._bfsClueIsland(clue);
      const rem = clue.size - size;
      if (rem > 0 && rem < smallestRemaining) {
        smallestRemaining = rem;
        smallestClueIdx = clue.idx;
      }
    }
    for (let i = 0; i < this.N; i++) {
      if (this.isWall[i]) continue;
      if (this.cellStatus[i] !== 0) continue;
      const r = (i / this.cols) | 0;
      const c = i - r * this.cols;
      let score = 0;
      // Known/wall 4-neighbours
      if (r > 0 && (this.isWall[i - this.cols] || this.cellStatus[i - this.cols] !== 0)) score++;
      if (r < this.rows - 1 && (this.isWall[i + this.cols] || this.cellStatus[i + this.cols] !== 0)) score++;
      if (c > 0 && (this.isWall[i - 1] || this.cellStatus[i - 1] !== 0)) score++;
      if (c < this.cols - 1 && (this.isWall[i + 1] || this.cellStatus[i + 1] !== 0)) score++;
      // Adjacent to any claimed WHITE cell — +2
      const adjClaimed =
        (r > 0 && claimedBy[i - this.cols] >= 0) ||
        (r < this.rows - 1 && claimedBy[i + this.cols] >= 0) ||
        (c > 0 && claimedBy[i - 1] >= 0) ||
        (c < this.cols - 1 && claimedBy[i + 1] >= 0);
      if (adjClaimed) score += 2;
      // In reach of exactly one clue — +3. Cheap proxy: at least in the
      // union, OK; precise per-cell single-clue check would require
      // _bfsReachable to be re-computed per clue (expensive). Use Manhattan
      // approximation.
      let reachingClues = 0;
      for (const clue of this.clues) {
        const cr = (clue.idx / this.cols) | 0;
        const cc = clue.idx - cr * this.cols;
        if (Math.abs(cr - r) + Math.abs(cc - c) <= clue.size - 1) {
          reachingClues++;
          if (reachingClues > 1) break;
        }
      }
      if (reachingClues === 1) score += 3;
      // In reach of smallest-remaining clue — +5
      if (smallestClueIdx >= 0) {
        const cr = (smallestClueIdx / this.cols) | 0;
        const cc = smallestClueIdx - cr * this.cols;
        // Find that clue's size.
        let smallestClueSize = 0;
        for (const clue of this.clues) {
          if (clue.idx === smallestClueIdx) { smallestClueSize = clue.size; break; }
        }
        if (Math.abs(cr - r) + Math.abs(cc - c) <= smallestClueSize - 1) score += 5;
      }
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }
    return bestIdx;
  }
```

- [ ] **Step 4: Run tests** — `node --test tests/nurikabe.test.js tests/nurikabe-fuzz.test.js`. All passing.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(nurikabe): smarter _pickBestUnknown — clue-reach composite score"
```

---

## Task 8: 20×20 monthly fixture + integration test

**Files:** `tests/fixtures/puzzles.js`, `tests/fixtures/real-puzzles.js`, `tests/solver.test.js`.

- [ ] **Step 1: Append `nurikabe20x20Monthly` to `tests/fixtures/puzzles.js`**

Find the `nurikabe5x5Easy` entry; add after it:

```js
  nurikabe20x20Monthly: {
    type: 'nurikabe',
    rows: 20,
    cols: 20,
    task: [
      [-1,-1,3,-1,-1,2,-1,1,-2,-2,-2,-2,-1,-1,-1,-1,-1,2,-1,-1],
      [-1,-1,-1,-1,-1,-1,-1,-1,-2,-2,-2,-2,-1,-1,-1,-1,2,-1,-1,-1],
      [-1,-1,-1,-1,-1,-1,-1,-1,-2,-2,-2,-2,-1,-1,3,-1,-1,-1,1,-1],
      [-1,-1,-1,-1,-1,-1,-1,-1,-2,-2,-2,-2,-1,-1,-1,-1,-1,-1,-1,-1],
      [-1,-1,4,-1,-1,-1,-1,-1,-2,-2,-2,-2,-1,-1,-1,-1,-1,-1,3,-1],
      [-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,3,-1,-1,-1,-1,-1],
      [-1,-1,-1,-1,4,-1,-1,-1,-1,-1,-1,-1,-1,3,-1,-1,4,-1,-1,-1],
      [-1,-1,-1,3,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,1,-1,-1,1,-1,-1],
      [-2,-2,-2,-2,-2,-1,-1,12,-1,7,-1,-1,-1,1,-1,-2,-2,-2,-2,-2],
      [-2,-2,-2,-2,-2,-1,1,-1,-1,-1,-1,-1,-1,-1,-1,-2,-2,-2,-2,-2],
      [-2,-2,-2,-2,-2,-1,-1,-1,2,-1,-1,-1,-1,3,-1,-2,-2,-2,-2,-2],
      [-2,-2,-2,-2,-2,-1,2,-1,-1,-1,2,-1,2,-1,-1,-2,-2,-2,-2,-2],
      [-1,-1,1,-1,-1,1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,3,-1,-1,-1],
      [-1,-1,-1,3,-1,-1,3,-1,-1,-1,-1,-1,-1,-1,-1,2,-1,-1,-1,-1],
      [-1,-1,-1,-1,-1,3,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
      [-1,3,-1,-1,-1,-1,-1,-1,-2,-2,-2,-2,-1,-1,-1,-1,-1,13,-1,-1],
      [-1,-1,-1,-1,-1,-1,-1,-1,-2,-2,-2,-2,-1,-1,-1,-1,-1,-1,-1,-1],
      [-1,-1,-1,-1,-1,4,-1,-1,-2,-2,-2,-2,-1,-1,-1,-1,-1,-1,-1,-1],
      [-1,-1,-1,4,-1,-1,-1,-1,-2,-2,-2,-2,-1,-1,-1,-1,-1,-1,-1,-1],
      [-1,-1,3,-1,-1,-1,-1,-1,-2,-2,-2,-2,3,-1,7,-1,-1,3,-1,-1],
    ],
  },
```

- [ ] **Step 2: Append to `tests/fixtures/real-puzzles.js`**

Find `nurikabe5x5EasyReal`; add after:

```js
  nurikabe20x20MonthlyReal: {
    type: 'nurikabe',
    rows: 20,
    cols: 20,
    // Identical task to nurikabe20x20Monthly; duplicated here so bench-real.js
    // can load it from the real-puzzles file without depending on the test
    // fixtures file. Keep in sync.
    task: [
      // (same 20-row task array as above)
    ],
  },
```

(Copy the same `task` array verbatim.)

- [ ] **Step 3: Append integration test to `tests/solver.test.js`**

After the existing `nurikabe5x5Easy` integration test, add:

```js
test('NurikabeSolver: nurikabe20x20Monthly fixture solves within 30s to a valid grid', { timeout: 60000 }, () => {
  const fixture = fixtures.nurikabe20x20Monthly;
  NurikabeSolver.clearSolutionCache();
  const s = new NurikabeSolver({
    rows: fixture.rows,
    cols: fixture.cols,
    task: fixture.task,
    maxMs: 30000,
  });
  const t0 = Date.now();
  const r = s.solve();
  const elapsed = Date.now() - t0;
  assert.equal(r.solved, true, `expected solved in 30s, got ${r.solved} after ${elapsed}ms`);
  assert.ok(elapsed <= 30000, `solve took ${elapsed}ms, exceeds 30s budget`);
  // Validate against all four Nurikabe rules.
  const taskArr = fixture.task;
  const N = fixture.rows * fixture.cols;
  // 1. Each clue is part of an exact-N white island, single-clue.
  const visited = new Uint8Array(N);
  for (let row = 0; row < fixture.rows; row++) {
    for (let col = 0; col < fixture.cols; col++) {
      if (taskArr[row][col] <= 0) continue;
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
          if (taskArr[nr][nc] > 0) cluesInside++;
          size++;
          queue.push([nr, nc]);
        }
      }
      assert.equal(cluesInside, 1, `island at (${row},${col}) has ${cluesInside} clues`);
      assert.equal(size, taskArr[row][col], `island size at (${row},${col})`);
    }
  }
  // 2. No 2x2 BLACK.
  for (let row = 0; row + 1 < fixture.rows; row++) {
    for (let col = 0; col + 1 < fixture.cols; col++) {
      assert.ok(!(r.grid[row][col] === 1 && r.grid[row][col+1] === 1 &&
                  r.grid[row+1][col] === 1 && r.grid[row+1][col+1] === 1),
        `2x2 BLACK at (${row},${col})`);
    }
  }
  // 3. All BLACKs connected.
  const seen = new Uint8Array(N);
  let firstBlack = -1, blackCount = 0;
  for (let i = 0; i < N; i++) {
    const r2 = Math.floor(i / fixture.cols), c2 = i % fixture.cols;
    if (r.grid[r2][c2] === 1) { blackCount++; if (firstBlack < 0) firstBlack = i; }
  }
  if (firstBlack >= 0) {
    const q = [firstBlack]; seen[firstBlack] = 1; let s2 = 1;
    while (q.length) {
      const idx = q.shift();
      const r2 = Math.floor(idx / fixture.cols), c2 = idx % fixture.cols;
      for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const nr = r2 + dr, nc = c2 + dc;
        if (nr < 0 || nr >= fixture.rows || nc < 0 || nc >= fixture.cols) continue;
        const ni = nr * fixture.cols + nc;
        if (seen[ni]) continue;
        if (r.grid[nr][nc] !== 1) continue;
        seen[ni] = 1; s2++; q.push(ni);
      }
    }
    assert.equal(s2, blackCount, `sea disconnected: saw ${s2}/${blackCount} blacks`);
  }
});
```

- [ ] **Step 4: Run the integration test** — `node --test tests/solver.test.js`. The 20×20 test must pass within 60s (the time budget is 30s + slack for test infrastructure).

If it fails on time, that's a signal the rule strength needs another iteration — flag the issue, don't proceed.

- [ ] **Step 5: Commit**

```bash
jj commit -m "test(nurikabe): 20x20 monthly fixture + integration test (≤ 30s solve)"
```

---

## Task 9: bench-nurikabe entry + nightly CI

**Files:** `tests/bench-nurikabe.js`.

- [ ] **Step 1: Modify `tests/bench-nurikabe.js`**

Find the current bench (just the 5×5 entry). Wrap into a parameterized loop:

```js
'use strict';
const { NurikabeSolver } = require('../solver.js');
const realPuzzles = require('./fixtures/real-puzzles.js');

const FIXTURES = ['nurikabe5x5EasyReal', 'nurikabe20x20MonthlyReal'];
const ITERATIONS = 5;
const WARMUP = 2;

for (const name of FIXTURES) {
  const fixture = realPuzzles[name];
  if (!fixture) continue;
  const times = [];
  for (let i = 0; i < WARMUP + ITERATIONS; i++) {
    NurikabeSolver.clearSolutionCache();
    const s = new NurikabeSolver({
      rows: fixture.rows,
      cols: fixture.cols,
      task: fixture.task,
      maxMs: 60000,
    });
    const t0 = process.hrtime.bigint();
    const r = s.solve();
    const t1 = process.hrtime.bigint();
    if (!r.solved) { console.error(`${name} failed to solve`); process.exit(1); }
    if (i >= WARMUP) times.push(Number(t1 - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  console.log(`${name}: median ${times[Math.floor(times.length / 2)].toFixed(2)} ms over ${ITERATIONS} runs`);
}
```

- [ ] **Step 2: Run** — `node tests/bench-nurikabe.js`. Expect both fixtures to solve. The 5×5 should be sub-millisecond; the 20×20 should be ≤ 30 000 ms.

- [ ] **Step 3: Commit**

```bash
jj commit -m "test(nurikabe): bench-nurikabe includes 20x20 monthly real fixture"
```

---

## Task 10: Final verification + push

**Files:** none.

- [ ] **Step 1: Full test suite** — `npm test`. All tests passing, including the 20×20 integration test.

- [ ] **Step 2: Lint + typecheck** — `npm run lint && npm run typecheck`. Expect clean.

- [ ] **Step 3: Bench** — `node tests/bench-nurikabe.js`. 20×20 must solve.

- [ ] **Step 4: Bench-real** — `node tests/bench-real.js`. Watch for regressions on the 5×5 (should still be < 1ms).

- [ ] **Step 5: Manual browser smoke** — `npm run build`. Reload extension at `chrome://extensions`. Open the actual `/nurikabe/special/monthly` puzzle, click Solve. Should finish in ≤ 30 s with all cells determined.

- [ ] **Step 6: Push to main**

```bash
jj bookmark set main -r @-
jj git push --bookmark main
```

---

## Self-review notes

**Spec coverage:**
- §3.1 `_applyFrontierForce` → Task 1. ✓
- §3.2 `_applySeaArticulation` → Task 2. ✓
- §3.3 `_applyShapeEnumeration` core → Task 4. ✓
- §3.3 cross-clue BLACK exclusion → Task 5. ✓
- §3.3 caps + time-up + dirty bit → Tasks 3 + 4 (caps), Task 4 (time-up + dirty bit). ✓
- §4 smarter `_pickBestUnknown` → Task 7. ✓
- §5 `_propagate` integration → Task 6. ✓
- §6 scratch buffers + `_dirtyShape` → Task 3. ✓
- §7.1 per-rule unit tests → Tasks 1, 2, 4, 5 (each test set). ✓
- §7.2 integration test → Task 8. ✓
- §7.3 fuzz (unchanged) → existing test; no task needed. ✓
- §7.4 bench → Task 9. ✓
- §8 perf budget → enforced implicitly by Task 8 (30s budget assertion). ✓
- §9 caches (unchanged) → no task. ✓
- §10 out of scope → respected. ✓

**Placeholder scan:** No "TBD" / "implement later" / hand-waving. The `_shapeIsValid` no-2x2 logic uses `_bfsVisited` as temporary `wouldBlack` storage; that's documented inline.

**Type consistency:** `_applyFrontierForce`, `_applySeaArticulation`, `_applyShapeEnumeration`, `_enumerateClueShapes`, `_shapeIsValid`, `_propagateFixpointOnly` are introduced and used consistently across tasks. Scratch buffers `_shapeInShape`, `_shapeStack`, `_shapeFrontier`, `_shapeInFrontier`, `_shapeInAll`, `_shapeInAny`, `_shapeCouldBeWhite`, `_dirtyShape` declared in Task 3 are used in Tasks 4-7.

End of plan.
