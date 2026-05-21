# Yin-Yang Solver Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `YinYangSolver` fast and strong enough to solve a 35×35 Yin-Yang weekly within a 30-second budget (it currently times out).

**Architecture:** Rewrite `YinYangSolver._applyConnectivity` from an O(N²)-per-sweep per-empty-cell probe to two O(N) rules — a reachability BFS (forces cells that can never be a colour) and an articulation-point-filtered cut probe (forces bottleneck cells). The 2×2 rule, `propagate()`/`solve()`/`_backtrack()` structure, and the solver's public surface are unchanged. The worker's Yin-Yang time budget rises to 30 s.

**Tech Stack:** Vanilla ES2020 JavaScript, Chrome MV3, `node:test`, `jj` (Jujutsu) for version control — **never plain `git`**.

**Conventions:**
- Colocated Jujutsu/git workspace. Commit with `jj commit -m "msg"`. Never run `git commit`/`git add`/etc.
- After editing `solver.js` or `solver.worker.js`, run `npm run build`. Edits to tests/docs do not need a rebuild.
- `npm run lint`, `npm run typecheck`, `npm test` must all pass before each commit.
- TDD: write the failing test, run it to see it fail, implement, run it to see it pass, commit.

## Background

`YinYangSolver` solves Yin-Yang: a 2-colouring (internal encoding `0`=empty, `1`=black, `2`=white) where each colour forms one orthogonally-connected region and no 2×2 block is monochrome or a diagonal checkerboard. Profiling on a 35×35 weekly (1225 cells, 397 givens): the current `_applyConnectivity` re-BFSes every empty cell (O(N²) per sweep), `propagate()` averages ~32 ms, propagation deduces only 40%, and `solve()` times out.

`_applyConnectivity` currently looks like this:

```js
  _applyConnectivity(onChange) {
    const N = this.rows * this.cols;
    for (let color = 1; color <= 2; color++) {
      if (!this._colorConnected(color, -1)) return false;
    }
    for (let i = 0; i < N; i++) {
      if (this.grid[i] !== 0) continue;
      for (let color = 1; color <= 2; color++) {
        if (!this._colorConnected(color, i)) {
          this._assign(i, color);
          onChange();
          break;
        }
      }
    }
    return true;
  }
```

`_colorConnected(color, blockIdx)` (a BFS that returns whether all placed cells of `color` are mutually reachable through `{color ∪ empty}`, treating `blockIdx` as removed) stays **unchanged** — Task 3's cut pass reuses it.

## File Structure

| File | Change |
| --- | --- |
| `solver.js` | `YinYangSolver`: constructor gains 4 scratch buffers; new methods `_applyReachability`, `_articulationPoints`, `_applyCut`; `_applyConnectivity` rewritten |
| `solver.worker.js` | `yinyang` arm: `maxMs` 8000 → 30000 |
| `tests/solver.test.js` | New unit tests for the three new methods |
| `tests/fixtures/real-puzzles.js` | New `yinyangWeekly35x35` fixture |
| `tests/bench-yinyang.js` | Set `maxMs` so a non-solving puzzle bails instead of hanging |
| `CLAUDE.md` | Update the Yin-Yang solver-shape description |

---

## Task 1: Reachability rule (`_applyReachability`)

**Files:**
- Modify: `solver.js` — `YinYangSolver` constructor + new method
- Test: `tests/solver.test.js`

The reachability rule: BFS the graph `{cells that are color or empty}` from a placed-`color` cell. If the colour's placed cells are severed → contradiction. Any empty cell the BFS cannot reach can never be `color` → force it to the other colour.

- [ ] **Step 1: Write the failing tests**

Add to `tests/solver.test.js`:

```js
test('YinYangSolver: reachability forces an unreachable empty cell', () => {
  // 1x3: black at (0,0), white wall at (0,1), empty (0,2). (0,2) cannot
  // reach the black region -> it can never be black -> forced white.
  const s = new YinYangSolver({
    rows: 1, cols: 3, task: [[-1, -1, -1]],
    initialState: [[1, 2, 0]],
  });
  assert.equal(s._applyReachability(1, () => {}), true);
  assert.equal(s._get(0, 2), 2);
});

test('YinYangSolver: reachability reports contradiction on a severed colour', () => {
  // black at (0,0) and (0,2), white wall between -> black cannot connect.
  const s = new YinYangSolver({
    rows: 1, cols: 3, task: [[-1, -1, -1]],
    initialState: [[1, 2, 1]],
  });
  assert.equal(s._applyReachability(1, () => {}), false);
});

test('YinYangSolver: reachability is a no-op when the colour has no placed cells', () => {
  const s = new YinYangSolver({
    rows: 1, cols: 3, task: [[-1, -1, -1]],
    initialState: [[0, 0, 0]],
  });
  assert.equal(s._applyReachability(1, () => {}), true);
  assert.equal(s._get(0, 0), 0);
  assert.equal(s._get(0, 1), 0);
  assert.equal(s._get(0, 2), 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-name-pattern='YinYangSolver: reachability'`
Expected: FAIL with `s._applyReachability is not a function`.

- [ ] **Step 3: Add the scratch buffer to the constructor**

In `solver.js`, in the `YinYangSolver` constructor, immediately after the line `this._timedOut = false;`, add:

```js
    // Reusable scratch buffer for the reachability BFS (avoids per-call
    // typed-array allocation in the hot propagation path).
    this._scratchSeen = new Uint8Array(rows * cols);
```

- [ ] **Step 4: Add the `_applyReachability` method**

Add this method to the `YinYangSolver` class body (place it just before `_applyConnectivity`):

```js
  // Reachability deduction for one colour. BFS the graph of cells that are
  // `color` or empty, starting from a placed-`color` cell. Returns false if
  // the colour's placed cells are severed (a contradiction). Any empty cell
  // the BFS cannot reach can never be `color`, so it is forced to the other
  // colour. Calls onChange() for each forced cell.
  _applyReachability(color, onChange) {
    const C = this.cols, R = this.rows, N = R * C;
    let start = -1, placedCount = 0;
    for (let i = 0; i < N; i++) {
      if (this.grid[i] === color) {
        placedCount++;
        if (start === -1) start = i;
      }
    }
    if (placedCount === 0) return true;

    const seen = this._scratchSeen;
    seen.fill(0);
    const stack = [start];
    seen[start] = 1;
    let reachedPlaced = 1;
    const consider = (nb) => {
      if (seen[nb]) return;
      const gv = this.grid[nb];
      if (gv === color || gv === 0) {
        seen[nb] = 1;
        if (gv === color) reachedPlaced++;
        stack.push(nb);
      }
    };
    while (stack.length) {
      const cur = stack.pop();
      const r = (cur / C) | 0, c = cur % C;
      if (r > 0) consider(cur - C);
      if (r + 1 < R) consider(cur + C);
      if (c > 0) consider(cur - 1);
      if (c + 1 < C) consider(cur + 1);
    }

    if (reachedPlaced !== placedCount) return false;

    const other = color === 1 ? 2 : 1;
    for (let i = 0; i < N; i++) {
      if (this.grid[i] === 0 && !seen[i]) {
        this._assign(i, other);
        onChange();
      }
    }
    return true;
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test --test-name-pattern='YinYangSolver: reachability'`
Expected: 3 passing. Also run `npm test` — full suite green (no regression; `_applyReachability` is not yet wired into `propagate`).

- [ ] **Step 6: Commit**

```bash
npm run lint && npm run typecheck && jj commit -m "feat(yin-yang): reachability propagation rule"
```

---

## Task 2: Articulation-points DFS (`_articulationPoints`)

**Files:**
- Modify: `solver.js` — `YinYangSolver` constructor + new method
- Test: `tests/solver.test.js`

A standard Tarjan articulation-point search over the graph `{cells that are color or empty}`. Used by Task 3's cut pass to find which empty cells to probe.

- [ ] **Step 1: Write the failing tests**

Add to `tests/solver.test.js`:

```js
test('YinYangSolver: _articulationPoints finds the cut cell of a path graph', () => {
  // 1x3 all empty -> G is a 3-cell path A-B-C -> middle cell (index 1) is
  // the only articulation point.
  const s = new YinYangSolver({ rows: 1, cols: 3, task: [[-1, -1, -1]] });
  assert.deepEqual([...s._articulationPoints(1)].sort((a, b) => a - b), [1]);
});

test('YinYangSolver: _articulationPoints finds none in a 2x2 cycle', () => {
  // 2x2 all empty -> G is a 4-cycle (2-connected) -> no articulation points.
  const s = new YinYangSolver({ rows: 2, cols: 2, task: [[-1, -1], [-1, -1]] });
  assert.deepEqual([...s._articulationPoints(1)], []);
});

test('YinYangSolver: _articulationPoints excludes cells not in the colour graph', () => {
  // 1x3 with the middle cell = white. For colour 1 the graph is just the two
  // endpoints (disconnected) -> no articulation points.
  const s = new YinYangSolver({
    rows: 1, cols: 3, task: [[-1, -1, -1]],
    initialState: [[1, 2, 1]],
  });
  assert.deepEqual([...s._articulationPoints(1)], []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-name-pattern='YinYangSolver: _articulationPoints'`
Expected: FAIL with `s._articulationPoints is not a function`.

- [ ] **Step 3: Add the scratch buffers to the constructor**

In `solver.js`, in the `YinYangSolver` constructor, immediately after the `this._scratchSeen = new Uint8Array(rows * cols);` line added in Task 1, add:

```js
    // Reusable scratch buffers for the articulation-points DFS.
    this._apDisc = new Int32Array(rows * cols);
    this._apLow = new Int32Array(rows * cols);
    this._apIsAP = new Uint8Array(rows * cols);
```

- [ ] **Step 4: Add the `_articulationPoints` method**

Add this method to the `YinYangSolver` class body (place it just before `_applyConnectivity`):

```js
  // Articulation points of the graph of cells that are `color` or empty
  // (4-neighbour adjacency), via a standard Tarjan DFS. Returns an array of
  // cell indices. Recursion depth is bounded by the cell count, which is
  // safe for the puzzle sizes here (<= ~40x40).
  _articulationPoints(color) {
    const C = this.cols, R = this.rows, N = R * C;
    const grid = this.grid;
    const disc = this._apDisc; disc.fill(-1);
    const low = this._apLow;
    const isAP = this._apIsAP; isAP.fill(0);
    let timer = 0;

    const dfs = (u, parent) => {
      disc[u] = low[u] = timer++;
      let children = 0;
      const r = (u / C) | 0, c = u % C;
      for (let d = 0; d < 4; d++) {
        let v = -1;
        if (d === 0) { if (r > 0) v = u - C; }
        else if (d === 1) { if (r + 1 < R) v = u + C; }
        else if (d === 2) { if (c > 0) v = u - 1; }
        else { if (c + 1 < C) v = u + 1; }
        if (v < 0) continue;
        if (grid[v] !== color && grid[v] !== 0) continue;
        if (disc[v] === -1) {
          children++;
          dfs(v, u);
          if (low[v] < low[u]) low[u] = low[v];
          if (parent !== -1 && low[v] >= disc[u]) isAP[u] = 1;
        } else if (v !== parent) {
          if (disc[v] < low[u]) low[u] = disc[v];
        }
      }
      if (parent === -1 && children > 1) isAP[u] = 1;
    };

    for (let i = 0; i < N; i++) {
      if ((grid[i] === color || grid[i] === 0) && disc[i] === -1) dfs(i, -1);
    }

    const out = [];
    for (let i = 0; i < N; i++) if (isAP[i]) out.push(i);
    return out;
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test --test-name-pattern='YinYangSolver: _articulationPoints'`
Expected: 3 passing. Also run `npm test` — full suite green.

- [ ] **Step 6: Commit**

```bash
npm run lint && npm run typecheck && jj commit -m "feat(yin-yang): articulation-points DFS"
```

---

## Task 3: Cut rule + rewrite `_applyConnectivity`

**Files:**
- Modify: `solver.js` — `YinYangSolver`: new `_applyCut`, rewritten `_applyConnectivity`
- Test: `tests/solver.test.js`

Add the cut pass (`_applyCut`) and replace the body of `_applyConnectivity` so it runs the reachability rule then the cut rule per colour. This is the task that activates Tasks 1–2.

- [ ] **Step 1: Write the failing test**

Add to `tests/solver.test.js`:

```js
test('YinYangSolver: propagate forces unreachable cells via reachability', () => {
  // 1x5: black, white, empty, empty, empty. The three empties cannot reach
  // the black region (the white cell blocks) -> all forced white. The old
  // per-cell cut probe missed this; the reachability rule catches it.
  const s = new YinYangSolver({
    rows: 1, cols: 5, task: [[-1, -1, -1, -1, -1]],
    initialState: [[1, 2, 0, 0, 0]],
  });
  assert.equal(s.propagate(), true);
  assert.equal(s._get(0, 2), 2);
  assert.equal(s._get(0, 3), 2);
  assert.equal(s._get(0, 4), 2);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-name-pattern='YinYangSolver: propagate forces unreachable'`
Expected: FAIL — the current `_applyConnectivity` (per-cell cut probe only) does not force those cells, so `_get(0, 2)` is still `0`.

- [ ] **Step 3: Add the `_applyCut` method**

Add this method to the `YinYangSolver` class body (place it just before `_applyConnectivity`):

```js
  // Cut deduction for one colour. Any articulation point of the
  // {color ∪ empty} graph that is empty and whose removal would sever the
  // colour's placed cells must itself be that colour. Calls onChange() for
  // each forced cell.
  _applyCut(color, onChange) {
    const aps = this._articulationPoints(color);
    for (const ap of aps) {
      if (this.grid[ap] !== 0) continue;
      if (!this._colorConnected(color, ap)) {
        this._assign(ap, color);
        onChange();
      }
    }
  }
```

- [ ] **Step 4: Rewrite `_applyConnectivity`**

Replace the entire existing `_applyConnectivity` method body with:

```js
  // Connectivity propagation. Returns false on contradiction; calls
  // onChange() whenever it forces a cell. Runs the reachability rule (forces
  // cells that can never be a colour, and detects severed colours) then the
  // cut rule (forces bottleneck cells) for each colour. The propagate()
  // fixpoint loop re-runs this until nothing changes.
  _applyConnectivity(onChange) {
    for (let color = 1; color <= 2; color++) {
      if (!this._applyReachability(color, onChange)) return false;
    }
    for (let color = 1; color <= 2; color++) {
      this._applyCut(color, onChange);
    }
    return true;
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test --test-name-pattern='YinYangSolver: propagate forces unreachable'`
Expected: PASS.

Run: `npm test`
Expected: full suite green — all existing `YinYangSolver` tests (2×2, connectivity bridge/contradiction, solve, getHint, golden, maxMs) and `yinyang-fuzz.test.js` still pass. The new rules are sound, so every board the fuzz validator accepts stays valid and the 6×6 golden solution is unchanged.

- [ ] **Step 6: Build and commit**

```bash
npm run lint && npm run typecheck && npm run build && jj commit -m "feat(yin-yang): O(N) connectivity via reachability + articulation-point cut"
```

---

## Task 4: 35×35 weekly fixture + bench guard

**Files:**
- Modify: `tests/fixtures/real-puzzles.js` — new fixture
- Modify: `tests/bench-yinyang.js` — `maxMs` guard

- [ ] **Step 1: Add the weekly fixture**

In `tests/fixtures/real-puzzles.js`, add this entry (a key on the exported object, alongside `yinyangReal6x6_a`):

```js
  // 35x35 Yin-Yang weekly special, captured 2026-05-20 via the Dump button.
  // The size that motivated the solver performance upgrade.
  yinyangWeekly35x35: {
    type: 'yinyang',
    rows: 35,
    cols: 35,
    task: [
      [-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
      [-1,-1,1,-1,1,-1,-1,-1,-1,-1,-1,1,-1,-1,1,-1,1,-1,1,-1,-1,-1,-1,-1,1,-1,1,-1,-1,-1,1,-1,-1,-1,-1],
      [-1,-1,1,-1,-1,1,-1,1,-1,-1,0,-1,-1,-1,1,-1,1,-1,-1,-1,-1,-1,0,-1,-1,-1,-1,-1,0,-1,-1,-1,-1,1,-1],
      [-1,-1,-1,-1,-1,-1,-1,-1,1,-1,-1,-1,1,-1,1,-1,-1,-1,-1,0,-1,0,-1,-1,-1,0,1,-1,0,-1,1,-1,1,-1,-1],
      [-1,-1,1,-1,0,-1,0,-1,-1,-1,-1,0,1,-1,1,-1,-1,1,-1,-1,-1,0,-1,0,-1,0,-1,-1,-1,1,-1,-1,-1,-1,-1],
      [-1,-1,1,-1,-1,0,1,0,1,-1,0,-1,1,-1,1,-1,-1,1,1,0,-1,0,0,-1,-1,-1,-1,-1,-1,-1,1,0,-1,0,-1],
      [-1,1,-1,-1,-1,-1,-1,0,-1,-1,-1,0,1,-1,1,-1,1,-1,-1,0,-1,0,-1,1,1,1,0,0,-1,-1,-1,-1,0,-1,-1],
      [-1,-1,-1,-1,-1,0,-1,0,-1,0,0,-1,1,-1,1,-1,-1,0,-1,0,-1,-1,-1,1,-1,-1,-1,-1,0,1,-1,-1,-1,1,-1],
      [-1,-1,-1,-1,0,-1,-1,0,-1,-1,-1,0,-1,-1,-1,0,-1,0,-1,-1,0,0,-1,-1,1,-1,-1,-1,0,-1,-1,-1,-1,-1,-1],
      [-1,-1,0,-1,-1,0,-1,0,-1,-1,0,-1,0,-1,0,-1,0,-1,-1,1,-1,-1,-1,1,-1,1,-1,0,-1,1,-1,-1,-1,1,-1],
      [-1,-1,-1,0,0,-1,0,-1,0,-1,-1,-1,-1,-1,-1,0,-1,1,-1,-1,1,0,-1,-1,-1,-1,1,-1,0,-1,-1,-1,-1,-1,-1],
      [-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,0,0,0,-1,1,-1,1,-1,1,-1,-1,1,-1,1,-1,-1,-1,-1,0,-1,0,-1,-1],
      [-1,-1,0,0,0,0,0,0,0,-1,-1,-1,-1,-1,-1,0,1,-1,1,-1,1,0,-1,-1,-1,-1,1,-1,0,-1,0,-1,-1,0,-1],
      [-1,1,-1,-1,-1,-1,-1,-1,-1,0,-1,0,-1,0,-1,0,1,-1,1,-1,1,0,-1,-1,-1,1,-1,-1,-1,-1,-1,1,-1,-1,-1],
      [-1,-1,1,-1,0,0,0,0,0,-1,0,-1,0,-1,0,-1,1,-1,1,-1,-1,-1,-1,-1,-1,-1,-1,1,-1,0,-1,-1,-1,0,-1],
      [-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,0,-1,-1,-1,0,-1,-1,0,-1,-1,-1,1,-1,1,-1,0,0,-1,0,-1],
      [-1,-1,1,-1,0,0,0,0,0,0,0,0,0,0,0,-1,0,0,0,-1,1,-1,-1,-1,1,-1,1,-1,1,0,-1,1,-1,0,-1],
      [-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,0,-1,-1,1,0,-1,-1,-1,1,-1,1,0,-1,-1,-1,0,-1],
      [-1,-1,-1,1,-1,-1,-1,0,-1,-1,0,0,0,0,0,0,0,0,-1,-1,1,-1,-1,-1,1,-1,1,-1,-1,0,-1,0,-1,0,-1],
      [-1,1,-1,1,-1,0,-1,-1,0,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,0,-1,-1,0,-1,-1,-1,1,-1,0,-1,-1,0,-1,0,-1],
      [-1,-1,-1,1,-1,-1,-1,0,-1,0,0,0,0,0,0,-1,0,0,0,-1,0,0,-1,-1,1,-1,-1,-1,-1,0,-1,-1,0,-1,-1],
      [-1,-1,0,-1,-1,0,-1,-1,-1,1,-1,1,-1,1,-1,-1,-1,-1,-1,-1,-1,-1,-1,0,1,-1,-1,1,-1,-1,-1,0,-1,1,-1],
      [-1,-1,-1,-1,-1,-1,0,-1,-1,-1,-1,-1,-1,-1,-1,1,-1,0,-1,0,1,-1,-1,-1,-1,1,-1,-1,-1,0,-1,0,-1,-1,-1],
      [-1,0,-1,1,-1,0,-1,-1,0,-1,0,-1,0,-1,0,-1,0,-1,0,-1,1,1,0,-1,-1,-1,-1,1,-1,-1,-1,0,-1,0,-1],
      [-1,-1,-1,1,-1,-1,-1,0,-1,-1,-1,1,-1,-1,1,-1,-1,-1,-1,0,-1,-1,-1,-1,-1,1,-1,-1,-1,0,-1,0,-1,0,-1],
      [-1,-1,-1,-1,-1,-1,-1,0,-1,1,1,0,-1,-1,1,1,-1,1,-1,-1,0,-1,-1,0,1,-1,-1,1,-1,-1,-1,-1,-1,0,-1],
      [-1,-1,1,-1,-1,1,-1,-1,-1,-1,-1,1,-1,0,-1,-1,-1,-1,-1,-1,-1,-1,-1,0,-1,-1,1,-1,-1,-1,0,-1,-1,0,-1],
      [-1,1,-1,-1,-1,0,0,0,0,-1,0,0,0,-1,0,-1,0,-1,0,0,0,0,-1,-1,0,-1,-1,1,1,-1,0,-1,-1,0,-1],
      [-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,1,1,-1,-1,-1,-1,-1,0,-1,-1,0,-1,-1,-1,-1,1,-1,0,-1,-1],
      [-1,1,-1,0,-1,0,0,0,-1,-1,0,0,0,-1,1,-1,-1,-1,0,0,0,0,-1,-1,0,-1,-1,1,-1,1,-1,0,-1,-1,-1],
      [-1,-1,-1,0,-1,-1,-1,-1,0,-1,-1,-1,-1,0,-1,1,1,-1,-1,-1,-1,-1,-1,-1,-1,-1,0,-1,-1,-1,-1,-1,0,-1,0],
      [-1,0,-1,-1,0,0,0,0,-1,0,0,0,0,-1,0,0,0,0,0,0,0,0,0,0,0,-1,-1,-1,-1,-1,1,0,-1,-1,-1],
      [-1,0,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,0,-1,1,-1,-1,-1,-1,-1,-1,-1,-1,-1,0,-1,-1,-1,-1,0,-1,-1,-1,-1],
      [-1,-1,0,0,0,0,0,0,0,-1,-1,0,-1,-1,-1,-1,-1,0,-1,0,-1,0,-1,0,-1,-1,-1,1,-1,-1,-1,-1,0,-1,-1],
      [-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,0,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
    ],
  },
```

- [ ] **Step 2: Verify the fixture file parses**

Run: `node -e "const r=require('./tests/fixtures/real-puzzles.js'); const w=r.yinyangWeekly35x35; console.log('rows', w.task.length, 'rowlens', Math.min(...w.task.map(x=>x.length)), Math.max(...w.task.map(x=>x.length)))"`
Expected: `rows 35 rowlens 35 35`. (If a row length is not 35, the transcription is wrong — re-check against the spec/dump before continuing.)

- [ ] **Step 3: Add the `maxMs` guard to the bench**

In `tests/bench-yinyang.js`, the timed loop constructs a solver and calls `.solve()`. There are two construction sites — the warmup loop and the timed loop. In **both**, set `s.maxMs = 30000;` right after the `new YinYangSolver(...)` line so a non-solving puzzle bails at 30 s instead of hanging forever. The warmup loop currently reads:

```js
  for (let i = 0; i < WARMUP; i++) {
    YinYangSolver.clearSolutionCache();
    new YinYangSolver({ rows: puzzle.rows, cols: puzzle.cols, task: puzzle.task }).solve();
  }
```

Change it to:

```js
  for (let i = 0; i < WARMUP; i++) {
    YinYangSolver.clearSolutionCache();
    const w = new YinYangSolver({ rows: puzzle.rows, cols: puzzle.cols, task: puzzle.task });
    w.maxMs = 30000;
    w.solve();
  }
```

The timed loop currently reads:

```js
  for (let i = 0; i < N; i++) {
    YinYangSolver.clearSolutionCache();
    const s = new YinYangSolver({ rows: puzzle.rows, cols: puzzle.cols, task: puzzle.task });
    const t0 = process.hrtime.bigint();
    const r = s.solve();
```

Change it to add the `maxMs` line right after the `const s = ...` line:

```js
  for (let i = 0; i < N; i++) {
    YinYangSolver.clearSolutionCache();
    const s = new YinYangSolver({ rows: puzzle.rows, cols: puzzle.cols, task: puzzle.task });
    s.maxMs = 30000;
    const t0 = process.hrtime.bigint();
    const r = s.solve();
```

- [ ] **Step 4: Run the bench — the acceptance gate**

Run: `npm run bench:yinyang`
Expected: prints solve times for both `yinyangReal6x6_a` and `yinyangWeekly35x35`, both `solved: true`, ends with `All yinyang bench puzzles solved.`, exits 0.

**If `yinyangWeekly35x35` reports `solved: false` / times out:** STOP. Do not commit a passing bench. Report this — the reachability + AP-cut rules were not sufficient, and the contingency (the border-arc deduction rule from the spec) is needed as a follow-up task.

- [ ] **Step 5: Commit**

```bash
jj commit -m "test(yin-yang): 35x35 weekly bench fixture + bench maxMs guard"
```

---

## Task 5: Raise the worker time budget

**Files:**
- Modify: `solver.worker.js`

- [ ] **Step 1: Change the budget**

In `solver.worker.js`, the `yinyang` dispatch arm contains the line `s.maxMs = 8000;`. Change it to:

```js
      s.maxMs = 30000;
```

Leave every other dispatch arm unchanged.

- [ ] **Step 2: Verify + build**

Run: `npm run lint`
Expected: clean.

Run: `npm run build`
Expected: completes without error.

- [ ] **Step 3: Commit**

```bash
jj commit -m "feat(yin-yang): raise worker solve budget to 30s for large boards"
```

---

## Task 6: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the solver-shape description**

In `CLAUDE.md`, the "Yin-Yang encoding" subsection describes the solver. It currently says propagation iterates "2×2 forcing (`_apply2x2`) and a connectivity-cut probe (`_applyConnectivity`, which forces any empty cell whose removal would sever a colour's placed cells)".

Replace that description of the connectivity rule with an accurate one:

```
Solver shape: `propagate()` iterates three sound rules to a fixpoint — 2×2
forcing (`_apply2x2`), a reachability rule (`_applyReachability`: BFS the
`{colour ∪ empty}` graph from a colour's placed cells; an empty cell the BFS
cannot reach can never be that colour, so force the other), and an
articulation-point cut rule (`_applyCut`: an empty articulation point of the
`{colour ∪ empty}` graph whose removal severs the colour's placed cells is
forced to that colour). Connectivity is O(N) per sweep. Then most-constrained
backtracking (`_pickCell`). A successful `propagate()` on a complete grid IS
a validity proof — no separate completion check. `getHint` runs `propagate()`
only and reports the cells it forced.
```

Adjust the surrounding wording so the paragraph reads naturally — the goal is that the description matches the current code (`_applyReachability`, `_articulationPoints`, `_applyCut`, the rewritten `_applyConnectivity`).

- [ ] **Step 2: Verify**

Run: `npm test`
Expected: full suite green (CLAUDE.md edits need no rebuild).

- [ ] **Step 3: Commit**

```bash
jj commit -m "docs(yin-yang): document the reachability + cut connectivity rules"
```

---

## Final verification

After all tasks:

- [ ] `npm run lint && npm run typecheck && npm test` — all green.
- [ ] `npm run build` — completes.
- [ ] `npm run bench:yinyang` — both fixtures solve; the 35×35 weekly solves within the 30 s budget (ideally far faster).
- [ ] Re-profile: `new YinYangSolver(...).propagate()` on the 35×35 should now take low single-digit milliseconds, down from ~247 ms.
- [ ] Load `dist/` in Chrome, open the `/yin-yang/special/weekly` puzzle, and confirm Solve completes and Apply renders the solution.

## Notes for the implementer

- `_colorConnected(color, blockIdx)` is **not** modified — Task 3's `_applyCut` reuses it as-is. It is called only on the (few) articulation-point cells, so its per-call allocation is not a hot path.
- The scratch buffers (`_scratchSeen`, `_apDisc`, `_apLow`, `_apIsAP`) are safe to reuse across calls because `_applyReachability` and `_articulationPoints` never nest (no method re-enters itself or the other before returning). `getHint` builds a separate clone solver with its own buffers.
- If Task 4's bench shows the 35×35 still does not solve, the design's documented contingency is the border-arc rule (each colour occupies one contiguous arc of the grid border). That would be a new task; escalate rather than weakening the bench.
