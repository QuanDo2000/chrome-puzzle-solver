# Yin-Yang Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Yin-Yang as the 6th puzzle type the extension solves, with full parity (Detect, Solve, Hint, Loop, Apply, preview, Dump, caching).

**Architecture:** A new `YinYangSolver` class in `solver.js` does propagation (2×2 rule + connectivity-cut probe) then most-constrained backtracking. Yin-Yang shares Binairo's exact `0/1/2` cell-state encoding, so the integration layer (handler, MAIN-world read/apply, content.js wiring, preview) is modelled directly on Binairo's.

**Tech Stack:** Vanilla ES2020 JavaScript, Chrome MV3, `node:test` for tests, `jj` (Jujutsu) for version control — **never plain `git`**.

**Conventions:**
- This repo is a colocated Jujutsu/git workspace. Commit with `jj commit -m "msg"`. Do NOT run `git commit`/`git add`/etc.
- After editing `manifest.json`, `background.js`, `main-world.js`, `content.js`, `handler.js`, `solver.js`, or `solver.worker.js`, run `npm run build`. Edits to tests/docs do not need a rebuild.
- `npm run lint`, `npm run typecheck`, `npm test` must all pass before each commit.

**Page encoding (from live recon of `/yin-yang/random/6x6-easy`):**
- `window.Game.task` — 2D givens: `-1` = none, `0` = given white, `1` = given black.
- `window.Game.currentState.cellStatus` — live state: `0` = empty, `1` = black, `2` = white.
- Givens → cellStatus translation: `-1→0, 0→2, 1→1`.

---

## Task 1: Add the yinyang6x6 test fixture

**Files:**
- Modify: `tests/fixtures/puzzles.js` (append a new fixture before the closing `};`)

- [ ] **Step 1: Add the fixture**

Append this entry to the object exported by `tests/fixtures/puzzles.js`, after the `shikaku5x5` entry (keep the existing trailing entries intact):

```js
  // 6x6 Yin-Yang captured from puzzles-mobile.com/yin-yang/random/6x6-easy
  // on 2026-05-20. task: -1=no given, 0=given white, 1=given black.
  yinyang6x6: {
    rows: 6,
    cols: 6,
    task: [
      [-1, -1, -1,  1, -1,  0],
      [-1, -1,  0, -1,  1, -1],
      [-1,  0, -1, -1, -1, -1],
      [-1, -1,  0,  1, -1, -1],
      [-1, -1,  0, -1, -1, -1],
      [ 1, -1, -1, -1, -1, -1],
    ],
  },
```

- [ ] **Step 2: Verify the file still parses**

Run: `node -e "const p=require('./tests/fixtures/puzzles.js'); console.log('yinyang6x6 rows:', p.yinyang6x6.rows)"`
Expected: `yinyang6x6 rows: 6`

- [ ] **Step 3: Commit**

```bash
jj commit -m "test(yin-yang): add 6x6 puzzle fixture"
```

---

## Task 2: YinYangSolver — constructor, encoding boundary, trail helpers

**Files:**
- Modify: `solver.js` — add the `YinYangSolver` class after the `ShikakuSolver` class and its `_rectsOverlap` helper, immediately before the `if (typeof module !== 'undefined' ...)` export block.
- Test: `tests/solver.test.js`

`YinYangSolver` works internally in cellStatus encoding (`0`=empty, `1`=black, `2`=white) and translates `task` givens (`-1/0/1`) at the constructor boundary — mirroring `BinairoSolver`.

- [ ] **Step 1: Write the failing test**

Add to `tests/solver.test.js` (the file already destructures solver classes from `../solver.js` on line 3 — extend that import to include `YinYangSolver`):

```js
test('YinYangSolver: constructor translates task givens to cellStatus encoding', () => {
  const task = [
    [-1, 0, 1],
    [1, -1, -1],
  ];
  const s = new YinYangSolver({ rows: 2, cols: 3, task });
  // -1 -> 0 empty, 0 -> 2 white, 1 -> 1 black.
  assert.equal(s._get(0, 0), 0);
  assert.equal(s._get(0, 1), 2);
  assert.equal(s._get(0, 2), 1);
  assert.equal(s._get(1, 0), 1);
  assert.equal(s._get(1, 1), 0);
});

test('YinYangSolver: initialState overrides givens when provided', () => {
  const task = [[-1, -1], [-1, -1]];
  const s = new YinYangSolver({
    rows: 2, cols: 2, task,
    initialState: [[1, 2], [0, 0]],
  });
  assert.equal(s._get(0, 0), 1);
  assert.equal(s._get(0, 1), 2);
  assert.equal(s._get(1, 0), 0);
});

test('YinYangSolver: constructor rejects invalid dimensions', () => {
  assert.throws(() => new YinYangSolver({ rows: 0, cols: 3, task: [] }));
  assert.throws(() => new YinYangSolver({ rows: 3, cols: 3, task: 'nope' }));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-name-pattern='YinYangSolver: constructor'`
Expected: FAIL with `YinYangSolver is not defined`.

- [ ] **Step 3: Write the implementation**

Insert into `solver.js` (after `_rectsOverlap`, before the export block):

```js
class YinYangSolver {
  /**
   * @param {{
   *   rows: number,
   *   cols: number,
   *   task: number[][],
   *   initialState?: number[][],
   * }} opts
   *   `task`         2D givens, page-native (-1=none, 0=given-white, 1=given-black).
   *   `initialState` optional 2D in cellStatus encoding (0=empty, 1=black, 2=white);
   *                  when present it seeds the grid instead of the translated givens.
   */
  constructor({ rows, cols, task, initialState }) {
    if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows <= 0 || cols <= 0) {
      throw new Error('YinYangSolver: rows/cols must be positive integers');
    }
    if (!Array.isArray(task)) {
      throw new Error('YinYangSolver: task must be an array');
    }
    this.rows = rows;
    this.cols = cols;
    this.task = task.map(row => (Array.isArray(row) ? row.slice() : []));

    // Internal grid: 0=empty, 1=black, 2=white. Flat Uint8Array.
    this.grid = new Uint8Array(rows * cols);
    // Trail entries packed as (idx << 2) | oldValue. oldValue in {0,1,2}.
    this.trail = [];
    // Solve-time budget. maxMs=0 disables it.
    this.maxMs = 0;
    this._startedAt = 0;
    this._timedOut = false;

    const seed = initialState || this._gridFromGivens();
    for (let r = 0; r < rows; r++) {
      const row = seed[r] || [];
      for (let c = 0; c < cols; c++) {
        const v = row[c];
        if (v === 1 || v === 2) this.grid[r * cols + c] = v;
      }
    }
  }

  _gridFromGivens() {
    const out = [];
    for (let r = 0; r < this.rows; r++) {
      const row = this.task[r] || [];
      const dst = new Array(this.cols).fill(0);
      for (let c = 0; c < this.cols; c++) {
        const g = row[c];
        dst[c] = g === 1 ? 1 : g === 0 ? 2 : 0;
      }
      out[r] = dst;
    }
    return out;
  }

  _get(r, c) { return this.grid[r * this.cols + c]; }

  // Trailed write. Caller must guarantee grid[idx] is currently 0 (empty).
  _assign(idx, v) {
    this.trail.push((idx << 2) | this.grid[idx]);
    this.grid[idx] = v;
  }

  _rollback(mark) {
    while (this.trail.length > mark) {
      const e = this.trail.pop();
      this.grid[e >> 2] = e & 3;
    }
  }

  _budgetExceeded() {
    if (this.maxMs <= 0) return false;
    if (Date.now() - this._startedAt > this.maxMs) {
      this._timedOut = true;
      return true;
    }
    return false;
  }
}
```

Also extend the export block at the bottom of `solver.js`:

```js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { NonogramSolver, AquariumSolver, GalaxiesSolver, BinairoSolver, ShikakuSolver, YinYangSolver };
}
```

And extend line 3 of `tests/solver.test.js`:

```js
const { NonogramSolver, AquariumSolver, GalaxiesSolver, BinairoSolver, ShikakuSolver, YinYangSolver } = require('../solver.js');
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --test-name-pattern='YinYangSolver: '`
Expected: 3 passing tests.

- [ ] **Step 5: Commit**

```bash
npm run lint && npm run typecheck && jj commit -m "feat(yin-yang): YinYangSolver constructor and encoding boundary"
```

---

## Task 3: YinYangSolver — 2×2 rule propagation

**Files:**
- Modify: `solver.js` — add methods to `YinYangSolver`
- Test: `tests/solver.test.js`

The 2×2 rule: a fully-placed 2×2 window is illegal if monochrome (4 same) or a diagonal checkerboard (the two diagonals being opposite colors). When 3 of 4 cells are placed, the 4th is forced if exactly one value keeps the window legal.

- [ ] **Step 1: Write the failing test**

Add to `tests/solver.test.js`:

```js
test('YinYangSolver: _is2x2Illegal flags monochrome and checkerboard', () => {
  const s = new YinYangSolver({ rows: 2, cols: 2, task: [[-1, -1], [-1, -1]] });
  assert.equal(s._is2x2Illegal(1, 1, 1, 1), true, 'all black');
  assert.equal(s._is2x2Illegal(2, 2, 2, 2), true, 'all white');
  assert.equal(s._is2x2Illegal(1, 2, 2, 1), true, 'checkerboard B/W');
  assert.equal(s._is2x2Illegal(2, 1, 1, 2), true, 'checkerboard W/B');
  assert.equal(s._is2x2Illegal(1, 1, 2, 2), false, 'split is legal');
  assert.equal(s._is2x2Illegal(1, 2, 1, 2), false, 'column split is legal');
});

test('YinYangSolver: 2x2 rule forces the 4th cell of a monochrome-3 window', () => {
  // TL,TR,BL all black -> BR must be white (else 2x2 monochrome).
  const s = new YinYangSolver({
    rows: 2, cols: 2, task: [[-1, -1], [-1, -1]],
    initialState: [[1, 1], [1, 0]],
  });
  assert.equal(s.propagate(), true);
  assert.equal(s._get(1, 1), 2);
});

test('YinYangSolver: 2x2 rule forces the 4th cell of a checkerboard-3 window', () => {
  // TL=black, TR=white, BL=white, BR empty. BR=black -> checkerboard;
  // so BR is forced white.
  const s = new YinYangSolver({
    rows: 2, cols: 2, task: [[-1, -1], [-1, -1]],
    initialState: [[1, 2], [2, 0]],
  });
  assert.equal(s.propagate(), true);
  assert.equal(s._get(1, 1), 2);
});

test('YinYangSolver: 2x2 rule reports contradiction on an illegal full window', () => {
  const s = new YinYangSolver({
    rows: 2, cols: 2, task: [[-1, -1], [-1, -1]],
    initialState: [[1, 1], [1, 1]],
  });
  assert.equal(s.propagate(), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-name-pattern='YinYangSolver: 2x2'`
Expected: FAIL with `s._is2x2Illegal is not a function` / `s.propagate is not a function`.

- [ ] **Step 3: Write the implementation**

Add these methods to the `YinYangSolver` class body:

```js
  // a=TL, b=TR, c=BL, d=BR; each in {1,2}. A full 2x2 window is illegal
  // when monochrome (all four equal) or a diagonal checkerboard (the two
  // diagonals are opposite colors).
  _is2x2Illegal(a, b, c, d) {
    const mono = a === b && b === c && c === d;
    const checker = a === d && b === c && a !== b;
    return mono || checker;
  }

  // 2x2 propagation rule. Returns false on contradiction; calls onChange()
  // whenever it forces a cell.
  _apply2x2(onChange) {
    const C = this.cols;
    for (let r = 0; r + 1 < this.rows; r++) {
      for (let c = 0; c + 1 < C; c++) {
        const idxs = [r * C + c, r * C + c + 1, (r + 1) * C + c, (r + 1) * C + c + 1];
        const vals = [
          this.grid[idxs[0]], this.grid[idxs[1]],
          this.grid[idxs[2]], this.grid[idxs[3]],
        ];
        let emptyCount = 0, emptyPos = -1;
        for (let k = 0; k < 4; k++) {
          if (vals[k] === 0) { emptyCount++; emptyPos = k; }
        }
        if (emptyCount === 0) {
          if (this._is2x2Illegal(vals[0], vals[1], vals[2], vals[3])) return false;
          continue;
        }
        if (emptyCount !== 1) continue;
        let legalVal = 0, legalCount = 0;
        for (let val = 1; val <= 2; val++) {
          vals[emptyPos] = val;
          if (!this._is2x2Illegal(vals[0], vals[1], vals[2], vals[3])) {
            legalVal = val;
            legalCount++;
          }
        }
        vals[emptyPos] = 0;
        if (legalCount === 0) return false;
        if (legalCount === 1) {
          this._assign(idxs[emptyPos], legalVal);
          onChange();
        }
      }
    }
    return true;
  }

  // Iterate the propagation rules to a fixpoint. Returns false on
  // contradiction. (The connectivity rule is added in the next task.)
  propagate() {
    let changed = true;
    while (changed) {
      if (this._budgetExceeded()) return false;
      changed = false;
      const onChange = () => { changed = true; };
      if (!this._apply2x2(onChange)) return false;
    }
    return true;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --test-name-pattern='YinYangSolver: 2x2'` and `node --test --test-name-pattern='YinYangSolver: _is2x2'`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
npm run lint && npm run typecheck && jj commit -m "feat(yin-yang): 2x2-rule propagation"
```

---

## Task 4: YinYangSolver — connectivity-cut propagation

**Files:**
- Modify: `solver.js` — add methods to `YinYangSolver`, extend `propagate()`
- Test: `tests/solver.test.js`

Connectivity rule: all placed cells of each color must remain mutually reachable through the graph of `{that color's cells ∪ empty cells}`. If they are not → contradiction. If removing a single empty cell `e` from that graph disconnects a color's placed cells, `e` is forced to that color.

- [ ] **Step 1: Write the failing test**

Add to `tests/solver.test.js`:

```js
test('YinYangSolver: _colorConnected detects disconnected placed cells', () => {
  // Two black cells separated by a white wall, no empty bridge.
  const s = new YinYangSolver({
    rows: 1, cols: 3, task: [[-1, -1, -1]],
    initialState: [[1, 2, 1]],
  });
  assert.equal(s._colorConnected(1, -1), false);
});

test('YinYangSolver: connectivity-cut probe forces a bridging cell', () => {
  // Row: black, empty, black. The empty cell is the only path between the
  // two black cells, so it is forced black.
  const s = new YinYangSolver({
    rows: 1, cols: 3, task: [[-1, -1, -1]],
    initialState: [[1, 0, 1]],
  });
  assert.equal(s.propagate(), true);
  assert.equal(s._get(0, 1), 1);
});

test('YinYangSolver: connectivity reports contradiction on a severed color', () => {
  const s = new YinYangSolver({
    rows: 1, cols: 3, task: [[-1, -1, -1]],
    initialState: [[1, 2, 1]],
  });
  assert.equal(s.propagate(), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-name-pattern='YinYangSolver: connectivity'` and `node --test --test-name-pattern='YinYangSolver: _colorConnected'`
Expected: FAIL with `s._colorConnected is not a function`.

- [ ] **Step 3: Write the implementation**

Add these methods to `YinYangSolver`:

```js
  // True iff every placed cell of `color` is mutually reachable through
  // {color cells ∪ empty cells}. When blockIdx >= 0 that cell is treated as
  // impassable (removed from the graph) — used by the cut probe below.
  _colorConnected(color, blockIdx) {
    const C = this.cols, R = this.rows, N = R * C;
    let start = -1, placedCount = 0;
    for (let i = 0; i < N; i++) {
      if (i === blockIdx) continue;
      if (this.grid[i] === color) {
        placedCount++;
        if (start === -1) start = i;
      }
    }
    if (placedCount <= 1) return true;
    const seen = new Uint8Array(N);
    const stack = [start];
    seen[start] = 1;
    let reached = 1;
    while (stack.length) {
      const cur = stack.pop();
      const r = (cur / C) | 0, c = cur % C;
      const nbrs = [];
      if (r > 0) nbrs.push(cur - C);
      if (r + 1 < R) nbrs.push(cur + C);
      if (c > 0) nbrs.push(cur - 1);
      if (c + 1 < C) nbrs.push(cur + 1);
      for (const nb of nbrs) {
        if (seen[nb] || nb === blockIdx) continue;
        const gv = this.grid[nb];
        if (gv === color || gv === 0) {
          seen[nb] = 1;
          if (gv === color) reached++;
          stack.push(nb);
        }
      }
    }
    return reached === placedCount;
  }

  // Connectivity propagation. Returns false on contradiction; calls
  // onChange() whenever it forces a cell.
  _applyConnectivity(onChange) {
    const N = this.rows * this.cols;
    for (let color = 1; color <= 2; color++) {
      if (!this._colorConnected(color, -1)) return false;
    }
    for (let i = 0; i < N; i++) {
      if (this.grid[i] !== 0) continue;
      for (let color = 1; color <= 2; color++) {
        if (!this._colorConnected(color, i)) {
          // Removing empty cell i severs `color` -> i must be `color`.
          this._assign(i, color);
          onChange();
          break;
        }
      }
    }
    return true;
  }
```

Then extend `propagate()` to call the connectivity rule inside the fixpoint loop:

```js
  propagate() {
    let changed = true;
    while (changed) {
      if (this._budgetExceeded()) return false;
      changed = false;
      const onChange = () => { changed = true; };
      if (!this._apply2x2(onChange)) return false;
      if (!this._applyConnectivity(onChange)) return false;
    }
    return true;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --test-name-pattern='YinYangSolver: connectivity'` and `node --test --test-name-pattern='YinYangSolver: _colorConnected'`
Expected: all passing. Also confirm Task 3's 2×2 tests still pass: `node --test --test-name-pattern='YinYangSolver: 2x2'`.

- [ ] **Step 5: Commit**

```bash
npm run lint && npm run typecheck && jj commit -m "feat(yin-yang): connectivity-cut propagation"
```

---

## Task 5: YinYangSolver — solve(), backtracking, solution cache

**Files:**
- Modify: `solver.js` — add methods + static cache to `YinYangSolver`
- Test: `tests/solver.test.js`

- [ ] **Step 1: Write the failing test**

Add to `tests/solver.test.js`:

```js
test('YinYangSolver: solves the 6x6 fixture into a valid board', () => {
  YinYangSolver.clearSolutionCache();
  const p = fixtures.yinyang6x6;
  const result = new YinYangSolver({ rows: p.rows, cols: p.cols, task: p.task }).solve();
  assert.equal(result.solved, true);
  // Every cell placed.
  for (const row of result.grid) {
    for (const v of row) assert.ok(v === 1 || v === 2, 'every cell is black or white');
  }
  // Givens respected.
  for (let r = 0; r < p.rows; r++) {
    for (let c = 0; c < p.cols; c++) {
      const g = p.task[r][c];
      if (g === 1) assert.equal(result.grid[r][c], 1);
      if (g === 0) assert.equal(result.grid[r][c], 2);
    }
  }
  YinYangSolver.clearSolutionCache();
});

test('YinYangSolver: reports contradiction on an unsolvable board', () => {
  // A 2x2 forced into a monochrome by givens.
  const result = new YinYangSolver({
    rows: 2, cols: 2, task: [[1, 1], [1, 1]],
  }).solve();
  assert.equal(result.solved, false);
  assert.equal(result.grid, null);
});

test('YinYangSolver: maxMs budget makes a hard solve bail quickly', () => {
  const task = Array.from({ length: 14 }, () => new Array(14).fill(-1));
  const s = new YinYangSolver({ rows: 14, cols: 14, task });
  s.maxMs = 1;
  const t0 = Date.now();
  s.solve();
  assert.ok(Date.now() - t0 < 500, 'solve must bail within 500ms when maxMs=1');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-name-pattern='YinYangSolver: solves'`
Expected: FAIL with `s.solve is not a function` / `YinYangSolver.clearSolutionCache is not a function`.

- [ ] **Step 3: Write the implementation**

Add these methods + static members to `YinYangSolver`:

```js
  _isComplete() {
    for (let i = 0; i < this.grid.length; i++) {
      if (this.grid[i] === 0) return false;
    }
    return true;
  }

  _gridTo2D() {
    const out = [];
    for (let r = 0; r < this.rows; r++) {
      const row = new Array(this.cols);
      for (let c = 0; c < this.cols; c++) row[c] = this.grid[r * this.cols + c];
      out[r] = row;
    }
    return out;
  }

  // Most-constrained variable: the empty cell touching the most non-empty
  // neighbours. Keeps the search frontier tight so connectivity prunes hard.
  _pickCell() {
    const C = this.cols, R = this.rows, N = R * C;
    let best = -1, bestScore = -1;
    for (let i = 0; i < N; i++) {
      if (this.grid[i] !== 0) continue;
      const r = (i / C) | 0, c = i % C;
      let score = 0;
      if (r > 0 && this.grid[i - C] !== 0) score++;
      if (r + 1 < R && this.grid[i + C] !== 0) score++;
      if (c > 0 && this.grid[i - 1] !== 0) score++;
      if (c + 1 < C && this.grid[i + 1] !== 0) score++;
      if (score > bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  _backtrack() {
    if (this._budgetExceeded()) return false;
    const target = this._pickCell();
    if (target === -1) return this._isComplete();
    for (let val = 1; val <= 2; val++) {
      const mark = this.trail.length;
      this._assign(target, val);
      if (this.propagate()) {
        if (this._isComplete() || this._backtrack()) return true;
      }
      this._rollback(mark);
      if (this._timedOut) return false;
    }
    return false;
  }

  /**
   * @returns {{ solved: boolean, grid: number[][] | null, error?: string }}
   */
  solve() {
    const key = this._cacheKey();
    const cached = YinYangSolver._solutionCache.get(key);
    if (cached) return { solved: true, grid: cached.map(row => row.slice()) };

    this._startedAt = Date.now();
    this._timedOut = false;

    if (!this.propagate()) {
      return {
        solved: false, grid: null,
        error: this._timedOut ? 'timed out' : 'contradiction on initial propagation',
      };
    }
    if (this._isComplete()) {
      const grid = this._gridTo2D();
      this._storeInCache(key, grid);
      return { solved: true, grid };
    }
    if (this._backtrack()) {
      const grid = this._gridTo2D();
      this._storeInCache(key, grid);
      return { solved: true, grid };
    }
    return {
      solved: false, grid: null,
      error: this._timedOut ? 'timed out' : 'no solution found',
    };
  }

  static _solutionCache = new Map();
  static _maxSolutionCache = 50;

  static clearSolutionCache() {
    YinYangSolver._solutionCache.clear();
  }

  _cacheKey() {
    // FNV-1a over (rows, cols, flattened task). Returns a 32-bit uint string.
    let h = 0x811c9dc5;
    const mix = (n) => { h ^= n; h = Math.imul(h, 0x01000193) >>> 0; };
    mix(this.rows);
    mix(this.cols);
    for (let r = 0; r < this.rows; r++) {
      const row = this.task[r] || [];
      for (let c = 0; c < this.cols; c++) mix((row[c] | 0) + 2); // -1..1 -> 1..3
    }
    return String(h >>> 0);
  }

  _storeInCache(key, grid) {
    const m = YinYangSolver._solutionCache;
    if (m.size >= YinYangSolver._maxSolutionCache) {
      m.delete(m.keys().next().value);
    }
    m.set(key, grid.map(row => row.slice()));
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --test-name-pattern='YinYangSolver: '`
Expected: all `YinYangSolver` tests pass.

- [ ] **Step 5: Commit**

```bash
npm run lint && npm run typecheck && jj commit -m "feat(yin-yang): solve via backtracking with solution cache"
```

---

## Task 6: YinYangSolver — getHint()

**Files:**
- Modify: `solver.js` — add `getHint` to `YinYangSolver`
- Test: `tests/solver.test.js`

`getHint` runs propagation only (no backtracking) on the current board and returns every cell propagation forced from empty to placed — "all logically-certain cells". The return shape is row-anchored, matching `BinairoSolver.getHint` so `content.js`'s `hintAbsoluteCells` consumes it unchanged.

- [ ] **Step 1: Write the failing test**

Add to `tests/solver.test.js`:

```js
test('YinYangSolver: getHint returns cells forced by propagation', () => {
  // Row: black, empty, black -> the empty cell is forced black.
  const s = new YinYangSolver({ rows: 1, cols: 3, task: [[-1, -1, -1]] });
  const hint = s.getHint([[1, 0, 1]]);
  assert.ok(hint, 'getHint must return a hint');
  const all = [
    ...(hint.cells || []).map(c => ({ row: hint.index, col: c.index, value: c.value })),
    ...(hint.extraCells || []),
  ];
  assert.ok(all.some(c => c.row === 0 && c.col === 1 && c.value === 1),
    'cell (0,1) must be forced black');
});

test('YinYangSolver: getHint returns null when nothing is deducible', () => {
  // A fully solved 6x6 — propagation forces nothing.
  YinYangSolver.clearSolutionCache();
  const p = fixtures.yinyang6x6;
  const solved = new YinYangSolver({ rows: p.rows, cols: p.cols, task: p.task }).solve();
  const s = new YinYangSolver({ rows: p.rows, cols: p.cols, task: p.task });
  assert.equal(s.getHint(solved.grid), null);
  YinYangSolver.clearSolutionCache();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-name-pattern='YinYangSolver: getHint'`
Expected: FAIL with `s.getHint is not a function`.

- [ ] **Step 3: Write the implementation**

Add `getHint` to `YinYangSolver`:

```js
  /**
   * Run propagation only (no backtracking) on `currentGrid` and return every
   * cell forced from empty to placed — all cells deducible by pure logic.
   * Returns null when the current board is contradictory or nothing is
   * forced. Shape is row-anchored, matching BinairoSolver.getHint.
   * @param {number[][]} currentGrid  2D in cellStatus encoding (0/1/2).
   */
  getHint(currentGrid) {
    const clone = new YinYangSolver({
      rows: this.rows, cols: this.cols, task: this.task,
      initialState: currentGrid,
    });
    const before = new Uint8Array(clone.grid);
    if (!clone.propagate()) return null;

    const cells2d = [];
    for (let i = 0; i < before.length; i++) {
      if (before[i] === 0 && clone.grid[i] !== 0) {
        cells2d.push({
          row: (i / clone.cols) | 0,
          col: i % clone.cols,
          value: clone.grid[i],
        });
      }
    }
    if (cells2d.length === 0) return null;

    const base = cells2d[0];
    const cells = [];
    const extraCells = [];
    for (const f of cells2d) {
      if (f.row === base.row) cells.push({ index: f.col, value: f.value });
      else extraCells.push({ row: f.row, col: f.col, value: f.value });
    }
    return { type: 'row', index: base.row, cells, extraCells, count: cells2d.length };
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --test-name-pattern='YinYangSolver: getHint'`
Expected: both passing.

- [ ] **Step 5: Commit**

```bash
npm run lint && npm run typecheck && jj commit -m "feat(yin-yang): getHint via propagation-only deduction"
```

---

## Task 7: Golden snapshot for the 6×6 fixture

**Files:**
- Modify: `tests/capture.js`
- Modify: `tests/golden.js` (regenerated by `npm run capture`)
- Test: `tests/solver.test.js`

- [ ] **Step 1: Write the failing test**

Add to `tests/solver.test.js` (the file already requires `./golden.js` as `golden` and `./fixtures/puzzles.js` as `fixtures`; reuse those):

```js
test('YinYangSolver: 6x6 fixture matches golden', () => {
  YinYangSolver.clearSolutionCache();
  const p = fixtures.yinyang6x6;
  const result = new YinYangSolver({ rows: p.rows, cols: p.cols, task: p.task }).solve();
  assert.deepEqual(
    { solved: result.solved, grid: result.grid, error: result.error || null },
    golden.yinyang6x6,
  );
  YinYangSolver.clearSolutionCache();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-name-pattern='YinYangSolver: 6x6 fixture matches golden'`
Expected: FAIL — `golden.yinyang6x6` is `undefined`.

- [ ] **Step 3: Wire capture.js and regenerate the golden**

In `tests/capture.js`: add `YinYangSolver` to the destructured `require('../solver.js')`, add a solve helper, and add the entry to the `raw` object.

Add the helper next to `solveShikaku`:

```js
function solveYinYang(p) {
  YinYangSolver.clearSolutionCache();
  return new YinYangSolver({ rows: p.rows, cols: p.cols, task: p.task }).solve();
}
```

Add to the `raw` object after `shikaku5x5`:

```js
  yinyang6x6: solveYinYang(fixtures.yinyang6x6),
```

Then regenerate:

Run: `npm run capture`
Expected output includes: `yinyang6x6: solved=true`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --test-name-pattern='YinYangSolver: 6x6 fixture matches golden'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run lint && npm run typecheck && jj commit -m "test(yin-yang): golden snapshot for the 6x6 fixture"
```

---

## Task 8: Worker dispatch for Yin-Yang

**Files:**
- Modify: `solver.worker.js`

- [ ] **Step 1: Add the dispatch arm**

In `solver.worker.js`, extend the `/* global ... */` comment to include `YinYangSolver`:

```js
/* global NonogramSolver, GalaxiesSolver, AquariumSolver, BinairoSolver, ShikakuSolver, YinYangSolver */
```

Add a dispatch arm before the final `else` (the `NonogramSolver` fallback):

```js
    } else if (type === 'yinyang' && extraData) {
      const s = new YinYangSolver({
        rows: extraData.rows,
        cols: extraData.cols,
        task: extraData.task,
        initialState: initialGrid || null,
      });
      s.maxMs = 8000;
      result = s.solve();
    } else {
```

- [ ] **Step 2: Verify the worker file parses**

Run: `node -e "require('./solver.js'); console.log('solver.js OK')"` (the worker imports solver.js; a syntax check of the worker itself is covered by lint).
Run: `npm run lint`
Expected: lint passes.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: completes without error.

- [ ] **Step 4: Commit**

```bash
jj commit -m "feat(yin-yang): worker dispatch arm"
```

---

## Task 9: MAIN-world read/apply functions

**Files:**
- Modify: `main-world.js`

Three functions modelled on Binairo's `readBinairoData` / `readBinairoState` / `applyBinairoState`.

- [ ] **Step 1: Add the functions**

In `main-world.js`, add after `applyBinairoState` (or anywhere among the read/apply functions):

```js
function readYinYangData() {
  var maxAttempts = 20;
  var pollMs = 250;

  function deepCopy2D(g) {
    if (!Array.isArray(g)) return null;
    var out = [];
    for (var r = 0; r < g.length; r++) {
      if (!Array.isArray(g[r])) return null;
      out[r] = g[r].slice();
    }
    return out;
  }

  function doRead() {
    try {
      if (!window.Game || window.Game.loaded === false) return null;
      if (!Array.isArray(window.Game.task)) return null;
      var width = window.Game.puzzleWidth;
      var height = window.Game.puzzleHeight;
      if (!width || !height) return null;
      var task = deepCopy2D(window.Game.task);
      if (!task) return null;
      return { task: task, width: width, height: height };
    } catch (e) {
      return null;
    }
  }

  return new Promise(function (resolve) {
    function poll() {
      var r = doRead();
      if (r) { resolve(r); return; }
      maxAttempts--;
      if (maxAttempts <= 0) { resolve(null); return; }
      setTimeout(poll, pollMs);
    }
    poll();
    setTimeout(function () { resolve(null); }, 10000);
  });
}

function readYinYangState(rows, cols) {
  try {
    if (!window.Game || !window.Game.currentState) return null;
    var cs = window.Game.currentState.cellStatus;
    if (!Array.isArray(cs)) return null;
    var out = [];
    for (var r = 0; r < rows && r < cs.length; r++) {
      var row = cs[r];
      if (!Array.isArray(row)) return null;
      out[r] = [];
      for (var c = 0; c < cols && c < row.length; c++) {
        var v = row[c];
        out[r][c] = (v === 1 || v === 2) ? v : 0;
      }
    }
    return out;
  } catch (e) {
    return null;
  }
}

function applyYinYangState(solution) {
  try {
    if (!solution || !Array.isArray(solution)) return false;
    if (!(window.Game && window.Game.currentState && window.Game.currentState.cellStatus)) {
      return false;
    }
    var cs = window.Game.currentState.cellStatus;
    var rows = solution.length;

    // saveState(true) BEFORE writes — commit to the page's internal model
    // first. See CLAUDE.md "MAIN-world write functions: save + render ladder".
    if (typeof window.Game.saveState === 'function') {
      window.Game.saveState(true);
    }

    for (var r = 0; r < rows && r < cs.length; r++) {
      var srcRow = solution[r] || [];
      var dstRow = cs[r];
      if (!Array.isArray(dstRow)) continue;
      for (var c = 0; c < srcRow.length && c < dstRow.length; c++) {
        var v = srcRow[c];
        dstRow[c] = (v === 1 || v === 2) ? v : 0;
      }
    }

    if (typeof window.Game.drawCurrentState === 'function') {
      window.Game.drawCurrentState();
    } else if (typeof window.Game.redraw === 'function') {
      window.Game.redraw();
    } else if (typeof window.Game.draw === 'function') {
      window.Game.draw();
    } else if (window.Game.getSaved && window.Game.loadGame) {
      var saved = window.Game.getSaved();
      if (saved) window.Game.loadGame(saved);
    }
    return true;
  } catch (e) {
    console.warn('Yin-Yang apply failed:', e);
    return false;
  }
}
```

- [ ] **Step 2: Verify the file parses**

Run: `node -e "require('./main-world.js'); console.log('main-world.js parses OK')"`
Expected: `main-world.js parses OK`.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: completes without error.

- [ ] **Step 4: Commit**

```bash
npm run lint && jj commit -m "feat(yin-yang): MAIN-world read/apply functions"
```

---

## Task 10: Allowlist the new MAIN-world functions

**Files:**
- Modify: `background.js`
- Modify: `globals.d.ts`

- [ ] **Step 1: Extend the allowlist**

In `background.js`, add the three names to `EXEC_MAIN_ALLOWLIST` (after `applyShikakuState`):

```js
  'readShikakuData',
  'readShikakuState',
  'applyShikakuState',
  'readYinYangData',
  'readYinYangState',
  'applyYinYangState',
  'applyGameState',
```

- [ ] **Step 2: Mirror in globals.d.ts**

In `globals.d.ts`, add the three names to the `MainWorldFn` union (after `'applyShikakuState'`):

```ts
  | 'readShikakuData'
  | 'readShikakuState'
  | 'applyShikakuState'
  | 'readYinYangData'
  | 'readYinYangState'
  | 'applyYinYangState'
  | 'applyGameState'
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm run lint`
Expected: both pass.

Run: `npm run build`
Expected: completes without error.

- [ ] **Step 4: Commit**

```bash
jj commit -m "feat(yin-yang): allowlist MAIN-world functions"
```

---

## Task 11: yinYangHandler

**Files:**
- Modify: `handler.js`

- [ ] **Step 1: Add the handler**

In `handler.js`, add after the `registerHandler(shikakuHandler);` line (and before the puzzles-mobile handler section):

```js
// ── Yin-Yang handler (puzzles-mobile.com/yin-yang/) ───────────

const yinYangHandler = {
  name: 'puzzles-mobile-yinyang',
  priority: 30,

  matches() {
    return isPuzzlesMobilePage() &&
           window.location.pathname.includes('/yin-yang/');
  },

  async detect() {
    const result = { found: false, rows: 0, cols: 0, rowClues: [], colClues: [] };
    const data = await callMainWorld('readYinYangData', []);
    if (!data) return { ...result, error: 'No Yin-Yang task data found' };
    const stageEl = document.getElementById('stage') ||
                    document.getElementById('game') ||
                    document.querySelector('[class*="game"], [class*="puzzle"]');
    return {
      found: true,
      type: 'yinyang',
      rows: data.height,
      cols: data.width,
      task: data.task,
      rowClues: [],
      colClues: [],
      _cells: [],
      _element: stageEl,
    };
  },

  async readState(ctx) {
    const state = await callMainWorld('readYinYangState', [ctx.rows, ctx.cols]);
    if (state) return state;
    return Array.from({ length: ctx.rows }, () => new Array(ctx.cols).fill(0));
  },

  async applySolution(solution, _ctx) {
    const ok = await callMainWorld('applyYinYangState', [solution]);
    return ok
      ? { success: true }
      : { success: false, error: 'Yin-Yang apply failed (no window.Game or MAIN-world timeout)' };
  },
};

registerHandler(yinYangHandler);
```

- [ ] **Step 2: Verify handler.js still parses under Node**

Run: `node -e "require('./handler.js'); console.log('handler.js OK')"`
Expected: `handler.js OK` (the Node export tail only exports `parseGalaxiesTask`; `registerHandler` runs but touches no DOM).

- [ ] **Step 3: Verify + build**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all pass (88 existing + new YinYangSolver tests).

Run: `npm run build`
Expected: completes without error.

- [ ] **Step 4: Commit**

```bash
jj commit -m "feat(yin-yang): yinYangHandler for /yin-yang/ pages"
```

---

## Task 12: content.js — solveExtraData, cache key, key prefix

**Files:**
- Modify: `content.js`

- [ ] **Step 1: Add the solveExtraData arm**

In `content.js`'s `solveExtraData()` function, add a `yinyang` arm next to the `binairo` arm:

```js
  if (data.type === 'yinyang') {
    return {
      rows: data.rows,
      cols: data.cols,
      task: data.task,
    };
  }
```

- [ ] **Step 2: Add the cache key function**

Add `yinYangCacheKey` next to `shikakuCacheKey`:

```js
function yinYangCacheKey(data) {
  if (data?.type !== 'yinyang') return null;
  // FNV-1a over (type nameplate, rows, cols, flattened task).
  let h = 0x811c9dc5;
  const mix = (n) => { h ^= n; h = Math.imul(h, 0x01000193) >>> 0; };
  mix(0x59); // 'Y' nameplate so yin-yang keys can't collide with other types
  mix(data.rows | 0);
  mix(data.cols | 0);
  const t = data.task || [];
  for (let r = 0; r < data.rows; r++) {
    const row = t[r] || [];
    for (let c = 0; c < data.cols; c++) mix((row[c] | 0) + 2);
  }
  return 'yinyang-solution:' + (h >>> 0).toString(16);
}
```

- [ ] **Step 3: Register the key in the cache dispatchers**

Add `yinyang-solution:` to the `SOLUTION_KEY_PREFIXES` array:

```js
const SOLUTION_KEY_PREFIXES = ['galaxies-solution:', 'aquarium-solution:', 'nonogram-solution:', 'binairo-solution:', 'shikaku-solution:', 'yinyang-solution:'];
```

Add a `yinyang` arm to BOTH `getCachedGridSolution` and `cacheGridSolution` (each has the same `data?.type === ... ? ...CacheKey(data)` ternary chain) — add this line after the `shikaku` line in each:

```js
    : data?.type === 'yinyang' ? yinYangCacheKey(data)
```

- [ ] **Step 4: Verify + build**

Run: `npm run lint && npm run typecheck`
Expected: both pass.

Run: `npm run build`
Expected: completes without error.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(yin-yang): content.js solve dispatch and solution caching"
```

---

## Task 13: content.js — Hint branch and status text

**Files:**
- Modify: `content.js`

- [ ] **Step 1: Add the getHint branch**

In `content.js`'s `getHint()` function, add a `yinyang` arm next to the `binairo` arm (the chain at ~line 1363). Place it after the `binairo` block, before `shikaku`:

```js
    } else if (detectedGrid.type === 'yinyang') {
      if (solution && firstMismatch(grid, solution)) {
        return { success: false, error: 'Current game state is wrong.' };
      }
      const solver = new YinYangSolver({
        rows, cols, task: detectedGrid.task, initialState: grid,
      });
      hint = solver.getHint(grid);
      // Pure deduction by design — no solve fallback. When propagation
      // exhausts, the user clicks Solve (which backtracks).
      if (!hint) {
        return { success: false, error: 'No more cells can be deduced from the current state. Click Solve to finish.' };
      }
```

- [ ] **Step 2: Add the hint status nodes function**

Add `yinYangHintStatusNodes` next to `binairoHintStatusNodes`:

```js
  function yinYangHintStatusNodes(h) {
    const total = (h.cells?.length || 0) + (h.extraCells?.length || 0);
    if (total === 0) return ['No hint available'];
    if (total === 1) {
      const cell = h.cells?.[0] || h.extraCells?.[0];
      const row = h.cells?.length ? h.index : cell.row;
      const col = h.cells?.length ? cell.index : cell.col;
      // Yin-Yang cellStatus: 1 = black, 2 = white.
      const valueStr = cell.value === 1 ? 'black' : 'white';
      return [
        'Cell ', bold(`(row ${row + 1}, col ${col + 1})`),
        ' must be ', bold(valueStr),
      ];
    }
    return [bold(String(total)), ' cells can be deduced'];
  }
```

- [ ] **Step 3: Dispatch to it in setHintStatus**

In the `setHintStatus` dispatch chain (~line 1657, the `else if (puzzleData?.type === 'binairo')` / `'shikaku'` chain), add a `yinyang` arm:

```js
    } else if (puzzleData?.type === 'yinyang') {
      setStatusNodes('info', prefix, ...yinYangHintStatusNodes(h));
```

- [ ] **Step 4: Verify + build**

Run: `npm run lint && npm run typecheck`
Expected: both pass.

Run: `npm run build`
Expected: completes without error.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(yin-yang): content.js Hint branch and status text"
```

---

## Task 14: content.js — preview rendering and supported-puzzles entry

**Files:**
- Modify: `content.js`

Yin-Yang cells render as stones: `cellStatus 1` (black) → dark disc; `2` (white) → light disc with a grey outline. Given cells get a small contrasting centre dot. Note the polarity is the OPPOSITE of Binairo (Binairo `1` renders light, `2` dark).

- [ ] **Step 1: Add the cell-paint arm**

In `content.js`'s `drawPreview`, near the existing `isShikaku` / `isBinairo` flags (~line 2128), add:

```js
    const isYinYang = puzzleData?.type === 'yinyang';
```

In the cell-paint loop, the `if (v === 0 && !isShikaku) continue;` guard already skips empty cells for Yin-Yang (`0` = empty). Add a Yin-Yang arm to the per-cell branch chain, after the `isBinairo` block and before the `galaxies` block:

```js
        } else if (isYinYang) {
          // cellStatus: 1 = black stone, 2 = white stone.
          const cx = x + cellSize / 2, cy = y + cellSize / 2;
          const yyR = Math.max(2, Math.floor(cellSize * 0.35));
          if (v === 1) {
            ctx.fillStyle = '#1f2937';
            ctx.beginPath();
            ctx.arc(cx, cy, yyR, 0, Math.PI * 2);
            ctx.fill();
          } else if (v === 2) {
            ctx.fillStyle = '#fff';
            ctx.strokeStyle = '#1f2937';
            ctx.lineWidth = Math.max(1.5, cellSize / 14);
            ctx.beginPath();
            ctx.arc(cx, cy, yyR, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
          // Given cells get a small contrasting centre dot.
          const given = puzzleData?.task?.[r]?.[c];
          if (given === 0 || given === 1) {
            ctx.fillStyle = v === 1 ? '#fff' : '#1f2937';
            ctx.beginPath();
            ctx.arc(cx, cy, Math.max(1, Math.floor(cellSize * 0.1)), 0, Math.PI * 2);
            ctx.fill();
          }
```

- [ ] **Step 2: Add the hint-highlight arm**

In `drawPreview`'s hint-highlight loop (the `for (const cell of hintAbsoluteCells(hint))` block, ~line 2255), add a Yin-Yang arm before the `binairo` arm:

```js
        if (puzzleData?.type === 'yinyang' && (cell.value === 1 || cell.value === 2)) {
          // Draw the hint stone in its colour, ringed blue to mark the hint.
          const ccx = cx + cellSize / 2;
          const ccy = cy + cellSize / 2;
          const hr = Math.max(2, Math.floor(cellSize * 0.35));
          ctx.fillStyle = cell.value === 1 ? '#1f2937' : '#fff';
          ctx.beginPath();
          ctx.arc(ccx, ccy, hr, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#2e86de';
          ctx.lineWidth = Math.max(2, Math.floor(cellSize / 9));
          ctx.beginPath();
          ctx.arc(ccx, ccy, hr, 0, Math.PI * 2);
          ctx.stroke();
        } else if (puzzleData?.type === 'binairo' && (cell.value === 1 || cell.value === 2)) {
```

(The existing `else if (puzzleData?.type === 'binairo' ...)` line becomes the `} else if` continuation — keep its body unchanged.)

- [ ] **Step 3: Add the SUPPORTED_PUZZLES entry**

In the `SUPPORTED_PUZZLES` array, add after the Shikaku entry:

```js
  { name: 'Yin-Yang',     url: 'https://www.puzzles-mobile.com/yin-yang/' },
```

- [ ] **Step 4: Verify + build**

Run: `npm run lint && npm run typecheck`
Expected: both pass.

Run: `npm run build`
Expected: completes without error.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(yin-yang): preview rendering and supported-puzzles entry"
```

---

## Task 15: Fuzz test — soundness and 4×4 completeness cross-check

**Files:**
- Create: `tests/yinyang-fuzz.test.js`

- [ ] **Step 1: Write the test file**

Create `tests/yinyang-fuzz.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { YinYangSolver } = require('../solver.js');

// Independent validator: a solved board must be fully placed, free of
// illegal 2x2 windows, and each colour must form exactly one connected
// region.
function isValidYinYang(grid, rows, cols) {
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (grid[r][c] !== 1 && grid[r][c] !== 2) return false;
    }
  }
  for (let r = 0; r + 1 < rows; r++) {
    for (let c = 0; c + 1 < cols; c++) {
      const a = grid[r][c], b = grid[r][c + 1];
      const d = grid[r + 1][c], e = grid[r + 1][c + 1];
      const mono = a === b && b === d && d === e;
      const checker = a === e && b === d && a !== b;
      if (mono || checker) return false;
    }
  }
  return components(grid, rows, cols, 1) === 1 &&
         components(grid, rows, cols, 2) === 1;
}

function components(grid, rows, cols, color) {
  const seen = Array.from({ length: rows }, () => new Array(cols).fill(false));
  let count = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (grid[r][c] !== color || seen[r][c]) continue;
      count++;
      const stack = [[r, c]];
      seen[r][c] = true;
      while (stack.length) {
        const [cr, cc] = stack.pop();
        for (const [nr, nc] of [[cr - 1, cc], [cr + 1, cc], [cr, cc - 1], [cr, cc + 1]]) {
          if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
          if (grid[nr][nc] === color && !seen[nr][nc]) {
            seen[nr][nc] = true;
            stack.push([nr, nc]);
          }
        }
      }
    }
  }
  return count;
}

function respectsTask(grid, task, rows, cols) {
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const g = task[r][c];
      if (g === 1 && grid[r][c] !== 1) return false;
      if (g === 0 && grid[r][c] !== 2) return false;
    }
  }
  return true;
}

// Deterministic LCG so failures reproduce.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

test('YinYangSolver fuzz: every solved board is independently valid', () => {
  const rng = makeRng(0xC0FFEE);
  for (let iter = 0; iter < 400; iter++) {
    const rows = 4 + Math.floor(rng() * 3); // 4..6
    const cols = 4 + Math.floor(rng() * 3);
    const task = Array.from({ length: rows }, () => new Array(cols).fill(-1));
    const givenCount = Math.floor(rng() * (rows * cols * 0.4));
    for (let g = 0; g < givenCount; g++) {
      const r = Math.floor(rng() * rows);
      const c = Math.floor(rng() * cols);
      task[r][c] = rng() < 0.5 ? 0 : 1;
    }
    YinYangSolver.clearSolutionCache();
    const s = new YinYangSolver({ rows, cols, task });
    s.maxMs = 2000;
    const result = s.solve();
    if (result.solved) {
      assert.ok(isValidYinYang(result.grid, rows, cols),
        `iter ${iter}: solver returned an invalid board`);
      assert.ok(respectsTask(result.grid, task, rows, cols),
        `iter ${iter}: solver ignored a given`);
    }
  }
});

test('YinYangSolver fuzz: 4x4 completeness cross-check vs brute force', () => {
  const rows = 4, cols = 4, N = 16;
  // Enumerate every 2-colouring of a 4x4; keep the valid ones.
  const validBoards = [];
  for (let mask = 0; mask < (1 << N); mask++) {
    const grid = [];
    for (let r = 0; r < rows; r++) {
      const row = [];
      for (let c = 0; c < cols; c++) {
        row.push(((mask >> (r * cols + c)) & 1) ? 1 : 2);
      }
      grid.push(row);
    }
    if (isValidYinYang(grid, rows, cols)) validBoards.push(grid);
  }
  assert.ok(validBoards.length > 0, 'there must be valid 4x4 boards');

  const rng = makeRng(0x1234);
  for (let iter = 0; iter < 200; iter++) {
    // Pick a random valid board, derive a random given-subset from it.
    const board = validBoards[Math.floor(rng() * validBoards.length)];
    const task = Array.from({ length: rows }, () => new Array(cols).fill(-1));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (rng() < 0.45) task[r][c] = board[r][c] === 1 ? 1 : 0;
      }
    }
    // A solution exists (the board it came from). The solver must find one,
    // and it must be valid + respect the givens.
    YinYangSolver.clearSolutionCache();
    const result = new YinYangSolver({ rows, cols, task }).solve();
    assert.equal(result.solved, true, `iter ${iter}: solver failed a solvable board`);
    assert.ok(isValidYinYang(result.grid, rows, cols),
      `iter ${iter}: solver returned an invalid board`);
    assert.ok(respectsTask(result.grid, task, rows, cols),
      `iter ${iter}: solver ignored a given`);
  }
});
```

- [ ] **Step 2: Run the fuzz test**

Run: `node --test tests/yinyang-fuzz.test.js`
Expected: both tests pass. If a board fails validation, the assertion message prints the iteration — the LCG seed makes it reproducible; debug `YinYangSolver` rather than weakening the test.

- [ ] **Step 3: Run the whole suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
npm run lint && jj commit -m "test(yin-yang): soundness fuzz and 4x4 completeness cross-check"
```

---

## Task 16: Benchmark and real-puzzle fixture

**Files:**
- Modify: `tests/fixtures/real-puzzles.js`
- Create: `tests/bench-yinyang.js`
- Modify: `package.json`
- Modify: `.github/workflows/bench-nightly.yml`

- [ ] **Step 1: Add a real-puzzle entry**

In `tests/fixtures/real-puzzles.js`, add an entry (match the existing entries' style — they are keyed objects with a `type` field):

```js
  yinyangReal6x6_a: {
    type: 'yinyang',
    rows: 6,
    cols: 6,
    task: [
      [-1, -1, -1,  1, -1,  0],
      [-1, -1,  0, -1,  1, -1],
      [-1,  0, -1, -1, -1, -1],
      [-1, -1,  0,  1, -1, -1],
      [-1, -1,  0, -1, -1, -1],
      [ 1, -1, -1, -1, -1, -1],
    ],
  },
```

- [ ] **Step 2: Create the bench script**

Create `tests/bench-yinyang.js` (modelled on `tests/bench-shikaku.js`):

```js
const { YinYangSolver } = require('../solver.js');
const real = require('./fixtures/real-puzzles.js');

const origLog = console.log;
console.log = () => {};
const log = (...a) => origLog(...a);

const targets = Object.keys(real)
  .filter(k => real[k]?.type === 'yinyang')
  .map(k => ({ name: k, puzzle: real[k] }));

if (targets.length === 0) {
  console.error('FAIL: no yinyang entries in tests/fixtures/real-puzzles.js');
  process.exit(1);
}

const WARMUP = 2;
const N = 11;
let failed = false;

for (const { name, puzzle } of targets) {
  for (let i = 0; i < WARMUP; i++) {
    YinYangSolver.clearSolutionCache();
    new YinYangSolver({ rows: puzzle.rows, cols: puzzle.cols, task: puzzle.task }).solve();
  }
  const times = [];
  let solvedFlag = null;
  for (let i = 0; i < N; i++) {
    YinYangSolver.clearSolutionCache();
    const s = new YinYangSolver({ rows: puzzle.rows, cols: puzzle.cols, task: puzzle.task });
    const t0 = process.hrtime.bigint();
    const r = s.solve();
    const t1 = process.hrtime.bigint();
    times.push(Number(t1 - t0) / 1e6);
    if (solvedFlag === null) solvedFlag = r.solved;
  }
  times.sort((a, b) => a - b);
  log(`${name} (${puzzle.rows}x${puzzle.cols}) solve times (ms):`, times.map(t => t.toFixed(2)).join(', '));
  log(`  median: ${times[Math.floor(N / 2)].toFixed(2)} ms, solved: ${solvedFlag}`);
  if (!solvedFlag) failed = true;
}

if (failed) {
  console.error('FAIL: one or more yinyang bench puzzles did not solve');
  process.exit(1);
}
log('All yinyang bench puzzles solved.');
```

- [ ] **Step 3: Add the package.json script**

In `package.json`'s `scripts`, add after `bench:shikaku`:

```json
    "bench:yinyang": "node tests/bench-yinyang.js",
```

- [ ] **Step 4: Add to the nightly workflow**

In `.github/workflows/bench-nightly.yml`, find the step that runs `node tests/bench-shikaku.js` and add an adjacent line/step running `node tests/bench-yinyang.js`, mirroring exactly how the shikaku bench is invoked.

- [ ] **Step 5: Run the bench**

Run: `npm run bench:yinyang`
Expected: prints `All yinyang bench puzzles solved.` and exits 0.

- [ ] **Step 6: Commit**

```bash
jj commit -m "test(yin-yang): bench script and real-puzzle fixture"
```

---

## Task 17: Document the Yin-Yang encoding in CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the intro line**

In `CLAUDE.md`, update the opening description to include Yin-Yang in the list of supported puzzles, and the solver-class count (it lists the solver classes in `solver.js`).

- [ ] **Step 2: Add a Yin-Yang encoding subsection**

Add a new subsection under "Architectural notes", after the Shikaku encoding subsection:

```markdown
### Yin-Yang encoding

The `/yin-yang/*` path is served by a dedicated `YinYangSolver` +
`yinYangHandler`. Yin-Yang shares Binairo's exact cell encoding:

- `window.Game.task` — 2D givens: `-1` = none, `0` = given white,
  `1` = given black.
- `window.Game.currentState.cellStatus` — live state: `0` = empty,
  `1` = black, `2` = white.
- Translation givens → cellStatus: `-1→0, 0→2, 1→1`.

`YinYangSolver` works internally in cellStatus encoding and translates
`task` givens at the constructor boundary, mirroring `BinairoSolver`.

Rules: (1) every cell is black or white; (2) all black cells form one
orthogonally-connected region, all white cells likewise; (3) no 2×2 window
may be monochrome OR a diagonal checkerboard (a checkerboard makes both
colours' diagonal pairs uncrossable, so it is forbidden).

Solver shape: `propagate()` iterates two sound rules — 2×2 forcing
(`_apply2x2`) and a connectivity-cut probe (`_applyConnectivity`, which
forces any empty cell whose removal would sever a colour's placed cells) —
to a fixpoint, then most-constrained backtracking (`_pickCell` picks the
empty cell with the most placed neighbours). Because the connectivity check
on a *full* grid reduces to "each colour is connected", a successful
`propagate()` on a complete grid IS a validity proof — no separate
completion check. `getHint` runs `propagate()` only and reports the cells
it forced. Static `_solutionCache` keyed on FNV-1a of `(rows, cols, task)`,
50-entry LRU. Instance `maxMs` budget so the worker can't hang.

MAIN-world: `readYinYangData` / `readYinYangState` / `applyYinYangState`,
twins of the Binairo functions. Hints reuse the generic `applyHintCells`
path (Yin-Yang is `0/1/2` cell-state encoding, like Binairo). The Loop
done-check needs no special arm — `0` = empty, like the other cell-state
puzzles.
```

- [ ] **Step 3: Update the EXEC_MAIN_ALLOWLIST count**

The "MV3 hardening contract" section states the allowlist has 14 entries. Update it to 17.

- [ ] **Step 4: Verify**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all pass. (CLAUDE.md edits need no rebuild.)

- [ ] **Step 5: Commit**

```bash
jj commit -m "docs(yin-yang): document the encoding and solver in CLAUDE.md"
```

---

## Final verification

After all tasks:

- [ ] `npm run lint && npm run typecheck && npm test` — all green.
- [ ] `npm run build` — completes.
- [ ] `npm run bench:yinyang` — solves and exits 0.
- [ ] Load `dist/` in Chrome, open `https://www.puzzles-mobile.com/yin-yang/random/6x6-easy`, and verify: Detect identifies "Yin-Yang 6×6"; Solve fills the board and Apply renders it; Hint highlights deducible stones and Apply-hint writes them; Loop steps to completion; the preview matches the board.

## Notes for the implementer

- **Hint application** reuses the existing generic `applyHintCells` MAIN-world
  path (the `else` branch of `applyHintHandler` in `content.js`) — Yin-Yang
  is `0/1/2` cell-state encoding exactly like Binairo, so no Yin-Yang-specific
  arm is needed there. `applyYinYangState` is only for full-board Solve apply.
- The render ladder in `applyYinYangState` (`drawCurrentState → redraw →
  draw → getSaved+loadGame`) cannot be unit-tested. Verify it during the
  final live check; if the board does not visibly update after Apply, adjust
  the ladder order (see CLAUDE.md "MAIN-world write functions: save + render
  ladder").
- `getHint` ignoring the `initialState` for `task` is intentional — the live
  board (`currentGrid`) already contains the givens, so seeding from it is
  complete.
