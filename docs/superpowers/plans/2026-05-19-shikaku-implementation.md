# Shikaku Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Shikaku (`/shikaku/*`) as the sixth supported puzzle type — a rectangle-partition puzzle where each numeric clue indicates the area of the rectangle that must contain it. Full feature parity with existing puzzle types (Solve, Hint, Loop, Dump, Undo/Redo, canvas preview, hint cache).

**Architecture:** New `ShikakuSolver` in `solver.js` with per-clue rectangle candidate enumeration, propagation (single-candidate forcing, single-coverer cells, rectangle-fit elimination), and most-constrained backtracking. New `shikakuHandler` matches `/shikaku/`; three MAIN-world functions handle read/state/apply. `content.js` adds a `'shikaku'` branch through the existing dispatch chains. Canvas preview colors cells by owner index (using the existing `galaxiesColors` palette) and overlays clue numbers as text.

**Tech Stack:** Vanilla JS (ES2022 in `content.js`/`solver.js`/`handler.js`, ES5-ish in `main-world.js`). Tests use `node:test` + `node:assert/strict`. Version control is **jj (Jujutsu)** — never plain `git` per `CLAUDE.md`.

**Spec:** `docs/superpowers/specs/2026-05-19-shikaku-design.md`

**Convention reminders:**
- After editing source files referenced by `manifest.json`, run `npm run build` so Chrome's `dist/` reflects changes.
- Every commit uses `jj commit -m "..."`. Never `git commit`. See `CLAUDE.md` for the full `jj` ↔ `git` mapping.
- Solution shape across the worker → content → MAIN bridge is a `number[][]` 2D where each cell holds its owning clue's *index* (0..clues.length-1) or `-1` if unassigned.
- Functions in `main-world.js` are serialized via `fn.toString()` and run in the page MAIN world — no outer-scope references, helpers must be nested inside the function body. See the existing `readBinairoData` for the canonical shape.

---

## File overview

| Status | File | Purpose |
| --- | --- | --- |
| Modify | `solver.js` | + `class ShikakuSolver` (~250 LOC): clue extraction, candidate enumeration, propagation, MRV backtracking, static `_solutionCache`. Node export updated. |
| Modify | `solver.worker.js` | + `case 'shikaku'` dispatch. |
| Modify | `handler.js` | + `shikakuHandler` (priority 30). |
| Modify | `main-world.js` | + `readShikakuData`, `readShikakuState`, `applyShikakuState`. + `/shikaku/` branch in `dumpPuzzleForBench`. |
| Modify | `background.js` | `EXEC_MAIN_ALLOWLIST` += 3 entries. |
| Modify | `globals.d.ts` | `MainWorldFn` union += 3 entries + ambient `ShikakuSolver` declare. |
| Modify | `eslint.config.js` | + `ShikakuSolver: 'readonly'` in solver-globals. |
| Modify | `content.js` | + `'shikaku'` arms in `solveExtraData`, hint cache helpers, `getHint`, `applyHintHandler`, `setHintStatus`. + `shikakuCacheKey` + `shikakuHintStatusNodes`. + `SUPPORTED_PUZZLES` entry. + `drawPreview` rendering (colored cells + clue overlays). |
| Modify | `tests/fixtures/puzzles.js` | + `shikaku5x5` fixture (captured 9-clue puzzle). |
| Modify | `tests/capture.js` | + `solveShikaku` + `shikaku5x5` in `raw`. |
| Modify | `tests/golden.js` | Regenerated. |
| Modify | `tests/solver.test.js` | + ShikakuSolver test suite. |
| Create | `tests/shikaku-fuzz.test.js` | Constructive partition-based fuzz at 5×5/7×7/10×10. |
| Modify | `tests/fixtures/real-puzzles.js` | + `shikakuReal5x5_a`. |
| Create | `tests/bench-shikaku.js` | Real-puzzle perf bench. |
| Modify | `package.json` | + `bench:shikaku` script. |
| Modify | `.github/workflows/bench-nightly.yml` | + `bench:shikaku` step. |
| Modify | `CLAUDE.md` | Top description + file row + new Shikaku encoding subsection. |

No `manifest.json` change.

---

## Task 1: `ShikakuSolver` constructor + candidate enumeration

**Files:**
- Modify: `solver.js` — append `class ShikakuSolver`, update Node export.
- Modify: `tests/solver.test.js` — append two tests.

The constructor validates the clue-sum invariant and enumerates rectangle candidates per clue. No solving yet — just initial state.

- [ ] **Step 1: Append the failing tests** to `tests/solver.test.js`:

```js
test('ShikakuSolver: constructor rejects clue-sum mismatch', () => {
  assert.throws(() => new ShikakuSolver({
    rows: 3, cols: 3,
    clues: [{ row: 0, col: 0, area: 4 }, { row: 2, col: 2, area: 4 }],
  }), /sum/i);
});

test('ShikakuSolver: candidate enumeration produces all valid rectangles', () => {
  // 2x4 grid, clue area=4 at (0,0) and area=4 at (1,3).
  // Clue (0,0)=4 candidates: 1x4 (row 0), 2x2 covering (0,0) — but 2x2 might
  // contain the other clue. Enumerate by hand to confirm.
  //   Rectangles containing (0,0) with area 4:
  //     (0,0)-(0,3) 1×4 → contains (1,3)? No → valid
  //     (0,0)-(3,0) 4×1 → out of grid (rows=2) → invalid
  //     (0,0)-(1,1) 2×2 → contains (1,3)? No → valid
  //   Same shape for clue (1,3)=4 (mirrored).
  const s = new ShikakuSolver({
    rows: 2, cols: 4,
    clues: [{ row: 0, col: 0, area: 4 }, { row: 1, col: 3, area: 4 }],
  });
  // Sort for stable compare.
  function key(r) { return `${r.r1},${r.c1}-${r.r2},${r.c2}`; }
  const got = s.candidates.map(cs => cs.map(key).sort());
  assert.deepEqual(got[0].sort(), ['0,0-0,3', '0,0-1,1'].sort(),
    'clue (0,0)=4 candidates wrong');
  assert.deepEqual(got[1].sort(), ['0,2-1,3', '1,0-1,3'].sort(),
    'clue (1,3)=4 candidates wrong');
});
```

- [ ] **Step 2: Run, confirm both fail**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm test -- --test-name-pattern='ShikakuSolver: '`

Expected: failure with `ShikakuSolver is not a constructor` or similar.

- [ ] **Step 3: Append the class to `solver.js`**

Find the existing Node export block at the bottom (`if (typeof module !== 'undefined' && module.exports)`). Insert IMMEDIATELY BEFORE it:

```js
class ShikakuSolver {
  /**
   * @param {{
   *   rows: number,
   *   cols: number,
   *   clues: Array<{ row: number, col: number, area: number }>,
   *   initialState?: number[][],  // 2D of cell-owner indices (or -1)
   * }} opts
   */
  constructor({ rows, cols, clues, initialState }) {
    if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows <= 0 || cols <= 0) {
      throw new Error('ShikakuSolver: rows/cols must be positive integers');
    }
    if (!Array.isArray(clues)) {
      throw new Error('ShikakuSolver: clues must be an array');
    }
    const sum = clues.reduce((s, c) => s + (c.area | 0), 0);
    if (sum !== rows * cols) {
      throw new Error(`ShikakuSolver: clue area sum ${sum} must equal grid area ${rows * cols}`);
    }
    this.rows = rows;
    this.cols = cols;
    this.clues = clues.map(c => ({ row: c.row | 0, col: c.col | 0, area: c.area | 0 }));

    // Quick lookup: cell index → clue index for the cell's own clue, else -1.
    this.clueByCell = new Int16Array(rows * cols).fill(-1);
    for (let i = 0; i < this.clues.length; i++) {
      const k = this.clues[i];
      this.clueByCell[k.row * cols + k.col] = i;
    }

    // Cell ownership: owner[r * cols + c] = clue index (0..K-1) or -1 unassigned.
    this.owner = new Int16Array(rows * cols).fill(-1);
    // Mark each clue's own cell as owned by itself up front — clue cells
    // must belong to their own rectangle.
    for (let i = 0; i < this.clues.length; i++) {
      const k = this.clues[i];
      this.owner[k.row * cols + k.col] = i;
    }

    // 1 if the clue's rectangle has been fully placed.
    this.placed = new Uint8Array(this.clues.length);

    // Per-clue list of remaining candidate rectangles.
    this.candidates = this.clues.map((_, i) => this._enumerateCandidates(i));

    // Trail for backtracking — packs cell-index/old-owner and candidate-pruning frames.
    this.trail = [];

    // Seed from initialState if provided.
    if (initialState) {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const v = initialState[r]?.[c];
          if (Number.isInteger(v) && v >= 0 && v < this.clues.length) {
            this.owner[r * cols + c] = v;
          }
        }
      }
    }
  }

  _enumerateCandidates(clueIdx) {
    const k = this.clues[clueIdx];
    const R = this.rows, C = this.cols;
    const out = [];
    // Factorize k.area into (w, h) pairs.
    for (let h = 1; h <= k.area; h++) {
      if (k.area % h !== 0) continue;
      const w = k.area / h;
      // Rectangle of width w, height h that contains (k.row, k.col).
      // Top-left (r1, c1): r1 ∈ [k.row - h + 1, k.row], c1 ∈ [k.col - w + 1, k.col].
      for (let r1 = Math.max(0, k.row - h + 1); r1 <= k.row; r1++) {
        const r2 = r1 + h - 1;
        if (r2 >= R) continue;
        for (let c1 = Math.max(0, k.col - w + 1); c1 <= k.col; c1++) {
          const c2 = c1 + w - 1;
          if (c2 >= C) continue;
          // Reject if any OTHER clue cell lies inside.
          let otherClueInside = false;
          for (let r = r1; r <= r2 && !otherClueInside; r++) {
            for (let c = c1; c <= c2; c++) {
              const cellClue = this.clueByCell[r * C + c];
              if (cellClue !== -1 && cellClue !== clueIdx) {
                otherClueInside = true;
                break;
              }
            }
          }
          if (!otherClueInside) out.push({ r1, c1, r2, c2 });
        }
      }
    }
    return out;
  }
}
```

- [ ] **Step 4: Update the Node export at the bottom of `solver.js`**

Find:
```js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { NonogramSolver, AquariumSolver, GalaxiesSolver, BinairoSolver };
}
```

Replace with:
```js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { NonogramSolver, AquariumSolver, GalaxiesSolver, BinairoSolver, ShikakuSolver };
}
```

- [ ] **Step 5: Run, confirm both pass + full suite green**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm test 2>&1 | tail -5`

Expected: all pass.

- [ ] **Step 6: Lint + typecheck**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm run lint && npm run typecheck`

Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
cd /home/quando/documents/chrome-puzzle-solver && jj commit -m "feat(shikaku): ShikakuSolver constructor + candidate enumeration"
```

---

## Task 2: Propagation rule — single-candidate forcing + rectangle-fit elimination

**Files:**
- Modify: `solver.js` — add propagation methods.
- Modify: `tests/solver.test.js` — append test.

When a clue has exactly one remaining candidate, place it: assign every cell in that rectangle to the clue, and prune candidates of OTHER clues that now overlap.

- [ ] **Step 1: Append the failing test**

```js
test('ShikakuSolver: single-candidate forcing places the rectangle', () => {
  // 2x2 grid, single clue area=4 at (0,0). Only candidate is the full grid.
  // Propagation should place it.
  const s = new ShikakuSolver({
    rows: 2, cols: 2,
    clues: [{ row: 0, col: 0, area: 4 }],
  });
  assert.equal(s.candidates[0].length, 1, 'should have exactly 1 candidate');
  const ok = s.propagate();
  assert.equal(ok, true);
  assert.equal(s.placed[0], 1, 'clue 0 must be placed');
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 2; c++) {
      assert.equal(s.owner[r * 2 + c], 0, `cell (${r},${c}) must be owned by clue 0`);
    }
  }
});
```

- [ ] **Step 2: Run, confirm fails**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm test -- --test-name-pattern='single-candidate forcing'`

Expected: `TypeError: s.propagate is not a function`.

- [ ] **Step 3: Add propagate + helpers to `ShikakuSolver`** (insert before the class's closing `}`):

```js
  // Iterate the propagation rules until no rule changes anything. Returns
  // false on contradiction (any clue's candidate set becomes empty or a
  // cell can't be covered).
  propagate() {
    let changed = true;
    while (changed) {
      changed = false;
      // 1. Zero-candidate detection — any unplaced clue with 0 candidates
      //    is unsolvable from here.
      for (let i = 0; i < this.clues.length; i++) {
        if (!this.placed[i] && this.candidates[i].length === 0) return false;
      }
      // 2. Single-candidate forcing — place the rectangle, prune neighbours.
      for (let i = 0; i < this.clues.length; i++) {
        if (this.placed[i]) continue;
        if (this.candidates[i].length === 1) {
          if (!this._placeRectangle(i, this.candidates[i][0])) return false;
          changed = true;
        }
      }
      // 3. Rectangle-fit elimination cascades automatically inside
      //    _placeRectangle (it prunes other clues' overlapping candidates),
      //    so no separate rule needed here.
    }
    return true;
  }

  // Place clue `i`'s rectangle. Marks every cell as owned, prunes
  // candidates of other clues that now overlap, marks `placed[i] = 1`.
  // Returns false if any conflict is detected during placement (cell
  // already owned by a different clue) or if another clue's candidate
  // set collapses to empty as a side-effect.
  _placeRectangle(clueIdx, rect) {
    const C = this.cols;
    // Assign cells. _assign records old-owner in trail for undo.
    for (let r = rect.r1; r <= rect.r2; r++) {
      for (let c = rect.c1; c <= rect.c2; c++) {
        const idx = r * C + c;
        const cur = this.owner[idx];
        if (cur !== -1 && cur !== clueIdx) return false;  // conflict
        if (cur === -1) this._assign(idx, clueIdx);
      }
    }
    // Mark placed.
    this._setPlaced(clueIdx, 1);
    // Reduce this clue's candidates to just the placed rectangle.
    const oldCands = this.candidates[clueIdx];
    this._setCandidates(clueIdx, [rect]);
    // Prune overlapping candidates from other clues.
    for (let j = 0; j < this.clues.length; j++) {
      if (j === clueIdx || this.placed[j]) continue;
      const filtered = this.candidates[j].filter(r2 => !_rectsOverlap(rect, r2));
      if (filtered.length !== this.candidates[j].length) {
        this._setCandidates(j, filtered);
      }
    }
    void oldCands;
    return true;
  }

  // ── Trail-based undo ───────────────────────────────────────────
  // Frame kinds packed into the trail. 0=cell-assign, 1=placed-flag, 2=candidates.
  _assign(idx, value) {
    const old = this.owner[idx];
    this.trail.push({ kind: 0, idx, old });
    this.owner[idx] = value;
  }
  _setPlaced(clueIdx, value) {
    const old = this.placed[clueIdx];
    this.trail.push({ kind: 1, clueIdx, old });
    this.placed[clueIdx] = value;
  }
  _setCandidates(clueIdx, newList) {
    const old = this.candidates[clueIdx];
    this.trail.push({ kind: 2, clueIdx, old });
    this.candidates[clueIdx] = newList;
  }
  _rollback(mark) {
    while (this.trail.length > mark) {
      const e = this.trail.pop();
      if (e.kind === 0) this.owner[e.idx] = e.old;
      else if (e.kind === 1) this.placed[e.clueIdx] = e.old;
      else this.candidates[e.clueIdx] = e.old;
    }
  }
```

And at the BOTTOM of `solver.js` (outside the class, before the Node export), add this helper:

```js
function _rectsOverlap(a, b) {
  return !(a.r2 < b.r1 || b.r2 < a.r1 || a.c2 < b.c1 || b.c2 < a.c1);
}
```

- [ ] **Step 4: Run, confirm passes**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm test -- --test-name-pattern='single-candidate forcing'`

Expected: PASS.

- [ ] **Step 5: Full suite + lint + typecheck**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm run lint && npm run typecheck && npm test 2>&1 | tail -3`

- [ ] **Step 6: Commit**

```bash
cd /home/quando/documents/chrome-puzzle-solver && jj commit -m "feat(shikaku): single-candidate forcing + rectangle-fit elimination"
```

---

## Task 3: `solve()` with MRV backtracking

**Files:**
- Modify: `solver.js` — add `solve()` and helpers.
- Modify: `tests/solver.test.js` — append two tests.

- [ ] **Step 1: Append failing tests**

```js
test('ShikakuSolver: solves a trivial 2x2 single-clue puzzle', () => {
  const s = new ShikakuSolver({
    rows: 2, cols: 2,
    clues: [{ row: 0, col: 0, area: 4 }],
  });
  const r = s.solve();
  assert.equal(r.solved, true);
  assert.equal(r.grid.length, 2);
  assert.equal(r.grid[0].length, 2);
  for (let r2 = 0; r2 < 2; r2++) {
    for (let c = 0; c < 2; c++) {
      assert.equal(r.grid[r2][c], 0);
    }
  }
});

test('ShikakuSolver: solves a 2x4 two-clue puzzle requiring backtracking', () => {
  const s = new ShikakuSolver({
    rows: 2, cols: 4,
    clues: [{ row: 0, col: 0, area: 4 }, { row: 1, col: 3, area: 4 }],
  });
  const r = s.solve();
  assert.equal(r.solved, true);
  // Every cell owned by clue 0 or 1, full coverage.
  const counts = [0, 0];
  for (let r2 = 0; r2 < 2; r2++) {
    for (let c = 0; c < 4; c++) {
      const o = r.grid[r2][c];
      assert.ok(o === 0 || o === 1, `cell (${r2},${c}) has owner ${o}`);
      counts[o]++;
    }
  }
  assert.equal(counts[0], 4);
  assert.equal(counts[1], 4);
});
```

- [ ] **Step 2: Run, confirm fails**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm test -- --test-name-pattern='solves a'`

Expected: `TypeError: s.solve is not a function`.

- [ ] **Step 3: Add solve() + backtracking to `ShikakuSolver`**

Insert before the class's closing `}`:

```js
  solve() {
    if (!this.propagate()) {
      return { solved: false, grid: null, error: 'contradiction on initial propagation' };
    }
    if (this._isComplete()) return { solved: true, grid: this._ownerTo2D() };
    if (this._backtrack()) return { solved: true, grid: this._ownerTo2D() };
    return { solved: false, grid: null, error: 'no solution found' };
  }

  _isComplete() {
    for (let i = 0; i < this.clues.length; i++) {
      if (!this.placed[i]) return false;
    }
    return true;
  }

  _ownerTo2D() {
    const out = [];
    for (let r = 0; r < this.rows; r++) {
      const row = new Array(this.cols);
      for (let c = 0; c < this.cols; c++) row[c] = this.owner[r * this.cols + c];
      out[r] = row;
    }
    return out;
  }

  _backtrack() {
    // MRV: pick the unplaced clue with the fewest remaining candidates.
    let target = -1;
    let bestCount = Infinity;
    for (let i = 0; i < this.clues.length; i++) {
      if (this.placed[i]) continue;
      const n = this.candidates[i].length;
      if (n < bestCount) { bestCount = n; target = i; }
    }
    if (target === -1) return this._isComplete();
    const cands = this.candidates[target].slice();
    for (const rect of cands) {
      const mark = this.trail.length;
      if (this._placeRectangle(target, rect) && this.propagate()) {
        if (this._isComplete() || this._backtrack()) return true;
      }
      this._rollback(mark);
    }
    return false;
  }
```

- [ ] **Step 4: Run, confirm passes**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm test 2>&1 | tail -3`

Expected: all green.

- [ ] **Step 5: Lint + typecheck**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm run lint && npm run typecheck`

- [ ] **Step 6: Commit**

```bash
cd /home/quando/documents/chrome-puzzle-solver && jj commit -m "feat(shikaku): solve() with MRV backtracking"
```

---

## Task 4: Static `_solutionCache` with LRU eviction

**Files:**
- Modify: `solver.js` — add cache statics + wire into `solve()`.
- Modify: `tests/solver.test.js` — append test.

- [ ] **Step 1: Append failing test**

```js
test('ShikakuSolver: static _solutionCache returns prior solve on identical clues', () => {
  ShikakuSolver.clearSolutionCache();
  const clues = [
    { row: 0, col: 0, area: 4 },
    { row: 1, col: 3, area: 4 },
  ];
  const r1 = new ShikakuSolver({ rows: 2, cols: 4, clues }).solve();
  assert.equal(r1.solved, true);
  const r2 = new ShikakuSolver({ rows: 2, cols: 4, clues }).solve();
  assert.equal(r2.solved, true);
  assert.deepEqual(r2.grid, r1.grid);
  ShikakuSolver.clearSolutionCache();
});
```

- [ ] **Step 2: Run, confirm fails** with `TypeError: ShikakuSolver.clearSolutionCache is not a function`.

- [ ] **Step 3: Add cache statics + replace solve()** in `ShikakuSolver`. Insert these statics just before the class's closing `}`:

```js
  static _solutionCache = new Map();
  static _maxSolutionCache = 50;

  static clearSolutionCache() {
    ShikakuSolver._solutionCache.clear();
  }

  _cacheKey() {
    let h = 0x811c9dc5;
    const mix = (n) => { h ^= n; h = Math.imul(h, 0x01000193) >>> 0; };
    mix(this.rows);
    mix(this.cols);
    mix(this.clues.length);
    // Sort by (row, col, area) for stable hashing.
    const sorted = this.clues.slice().sort((a, b) =>
      a.row - b.row || a.col - b.col || a.area - b.area);
    for (const k of sorted) {
      mix(k.row); mix(k.col); mix(k.area);
    }
    return String(h >>> 0);
  }

  _storeInCache(key, grid) {
    const m = ShikakuSolver._solutionCache;
    if (m.size >= ShikakuSolver._maxSolutionCache) {
      const first = m.keys().next().value;
      m.delete(first);
    }
    m.set(key, grid.map(row => row.slice()));
  }
```

Then REPLACE the existing `solve()` body with cache-aware version:

```js
  solve() {
    const key = this._cacheKey();
    const cached = ShikakuSolver._solutionCache.get(key);
    if (cached) return { solved: true, grid: cached.map(row => row.slice()) };

    if (!this.propagate()) {
      return { solved: false, grid: null, error: 'contradiction on initial propagation' };
    }
    if (this._isComplete()) {
      const grid = this._ownerTo2D();
      this._storeInCache(key, grid);
      return { solved: true, grid };
    }
    if (this._backtrack()) {
      const grid = this._ownerTo2D();
      this._storeInCache(key, grid);
      return { solved: true, grid };
    }
    return { solved: false, grid: null, error: 'no solution found' };
  }
```

- [ ] **Step 4: Run, confirm passes**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm test 2>&1 | tail -3`

- [ ] **Step 5: Lint + typecheck**

- [ ] **Step 6: Commit**

```bash
cd /home/quando/documents/chrome-puzzle-solver && jj commit -m "feat(shikaku): static _solutionCache with LRU eviction"
```

---

## Task 5: `getHint(currentGrid)` with forward-checking fallback

**Files:**
- Modify: `solver.js` — add `getHint`.
- Modify: `tests/solver.test.js` — append test.

- [ ] **Step 1: Append failing test**

```js
test('ShikakuSolver: getHint returns forced cells from fresh state', () => {
  // 2x4 grid with two area=4 clues — local propagation should fully solve it.
  const clues = [
    { row: 0, col: 0, area: 4 },
    { row: 1, col: 3, area: 4 },
  ];
  const s = new ShikakuSolver({ rows: 2, cols: 4, clues });
  const grid = s._ownerTo2D();
  const hint = s.getHint(grid);
  assert.ok(hint, 'getHint must return at least one forced cell');
  const total = (hint.cells?.length || 0) + (hint.extraCells?.length || 0);
  assert.ok(total >= 1, `expected ≥1 cell, got ${total}`);
});
```

- [ ] **Step 2: Run, confirm fails**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm test -- --test-name-pattern='getHint returns forced'`

Expected: `TypeError: s.getHint is not a function`.

- [ ] **Step 3: Add `getHint` to ShikakuSolver**

Insert before the class's closing `}`:

```js
  /**
   * Run propagation rules (no backtracking) to find every cell whose
   * owner is now uniquely forced. If propagation produces nothing, fall
   * back to a single pass of forward-checking probes (for each unplaced
   * clue, probe each candidate, propagate, force any clue whose only
   * surviving candidate becomes unique). Returns hint shape compatible
   * with content.js (row-anchored, with extraCells for cross-row).
   * @param {number[][]} currentGrid  2D of cell owners (or -1).
   */
  getHint(currentGrid) {
    const clone = new ShikakuSolver({
      rows: this.rows, cols: this.cols,
      clues: this.clues,
      initialState: currentGrid,
    });
    const before = new Int16Array(clone.owner);
    let ok = clone.propagate();
    if (!ok) return null;

    let anyChange = false;
    for (let i = 0; i < before.length; i++) {
      if (before[i] !== clone.owner[i]) { anyChange = true; break; }
    }

    if (!anyChange) {
      // Forward-checking fallback: for each unplaced clue, probe each
      // candidate. If exactly one candidate keeps the puzzle consistent
      // (i.e., propagate after placement returns true), that's forced.
      const forced = [];
      for (let i = 0; i < clone.clues.length; i++) {
        if (clone.placed[i]) continue;
        const survivors = [];
        for (const rect of clone.candidates[i].slice()) {
          const mark = clone.trail.length;
          if (clone._placeRectangle(i, rect) && clone.propagate()) {
            survivors.push(rect);
          }
          clone._rollback(mark);
        }
        if (survivors.length === 0) return null;
        if (survivors.length === 1) {
          forced.push({ clueIdx: i, rect: survivors[0] });
        }
      }
      // Apply forced placements in batch.
      for (const f of forced) {
        if (!clone._placeRectangle(f.clueIdx, f.rect)) return null;
      }
      // Final cascade.
      if (!clone.propagate()) return null;
    }

    // Collect transition cells.
    const cells2d = [];
    for (let i = 0; i < before.length; i++) {
      if (before[i] === -1 && clone.owner[i] !== -1) {
        const r = (i / clone.cols) | 0;
        const c = i % clone.cols;
        cells2d.push({ row: r, col: c, value: clone.owner[i] });
      }
    }
    if (cells2d.length === 0) return null;

    // Anchor on first cell's row, others go in extraCells.
    const base = cells2d[0];
    const cells = [];
    const extraCells = [];
    for (const f of cells2d) {
      if (f.row === base.row) cells.push({ index: f.col, value: f.value });
      else extraCells.push({ row: f.row, col: f.col, value: f.value });
    }
    return {
      type: 'row',
      index: base.row,
      clue: null,
      cells,
      extraCells,
      count: cells2d.length,
    };
  }
```

- [ ] **Step 4: Run, confirm passes**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm test 2>&1 | tail -3`

- [ ] **Step 5: Lint + typecheck**

- [ ] **Step 6: Commit**

```bash
cd /home/quando/documents/chrome-puzzle-solver && jj commit -m "feat(shikaku): getHint with forward-checking fallback"
```

---

## Task 6: Worker dispatch

**Files:**
- Modify: `solver.worker.js`

- [ ] **Step 1: Edit the binairo branch in `solver.worker.js`**. Find:

```js
    } else if (type === 'binairo' && extraData) {
      const s = new BinairoSolver({
        rows: extraData.rows,
        cols: extraData.cols,
        givens: extraData.givens,
        comparisonClues: extraData.comparisonClues || [],
        initialState: initialGrid || null,
      });
      result = s.solve();
    } else {
```

Replace with:

```js
    } else if (type === 'binairo' && extraData) {
      const s = new BinairoSolver({
        rows: extraData.rows,
        cols: extraData.cols,
        givens: extraData.givens,
        comparisonClues: extraData.comparisonClues || [],
        initialState: initialGrid || null,
      });
      result = s.solve();
    } else if (type === 'shikaku' && extraData) {
      const s = new ShikakuSolver({
        rows: extraData.rows,
        cols: extraData.cols,
        clues: extraData.clues,
        initialState: initialGrid || null,
      });
      result = s.solve();
    } else {
```

- [ ] **Step 2: Smoke parse**

Run: `cd /home/quando/documents/chrome-puzzle-solver && node -e "require('./solver.js'); require('./solver.worker.js')" 2>&1 | head -3`

Expected: a `ReferenceError: importScripts is not defined` (normal). Any `SyntaxError` would be a real issue.

- [ ] **Step 3: Lint + typecheck + tests**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm run lint && npm run typecheck && npm test 2>&1 | tail -3`

- [ ] **Step 4: Commit**

```bash
cd /home/quando/documents/chrome-puzzle-solver && jj commit -m "feat(shikaku): dispatch case in solver.worker.js"
```

---

## Task 7: MAIN-world functions

**Files:**
- Modify: `main-world.js`

**Convention reminder:** Every function in `main-world.js` is serialized via `fn.toString()` — no outer-scope references, helpers must be nested. Use `var` and `function` declarations consistently with the file's ES5 shape.

- [ ] **Step 1: Append three new functions to `main-world.js`**

Insert immediately BEFORE the existing `function dumpPuzzleForBench()` (search for `function dumpPuzzleForBench()` to find the insertion point):

```js
function readShikakuData() {
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

  return new Promise(function(resolve) {
    function poll() {
      var r = doRead();
      if (r) { resolve(r); return; }
      maxAttempts--;
      if (maxAttempts <= 0) { resolve(null); return; }
      setTimeout(poll, pollMs);
    }
    poll();
    setTimeout(function() { resolve(null); }, 10000);
  });
}

function readShikakuState(rows, cols) {
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
        out[r][c] = (typeof v === 'number' && v >= 0) ? v : -1;
      }
    }
    return out;
  } catch (e) {
    return null;
  }
}

function applyShikakuState(solution, clues) {
  try {
    if (!solution || !Array.isArray(solution)) return false;
    if (!(window.Game && window.Game.currentState && window.Game.currentState.cellStatus)) {
      return false;
    }
    var cs = window.Game.currentState.cellStatus;
    var rows = solution.length;

    // saveState(true) BEFORE writes — same pattern as binairo/aquarium.
    if (typeof window.Game.saveState === 'function') {
      window.Game.saveState(true);
    }

    // Write each cell's owner index. -1 stays as unassigned (engine
    // convention).
    for (var r = 0; r < rows && r < cs.length; r++) {
      var srcRow = solution[r] || [];
      var dstRow = cs[r];
      if (!Array.isArray(dstRow)) continue;
      for (var c = 0; c < srcRow.length && c < dstRow.length; c++) {
        var v = srcRow[c];
        dstRow[c] = (typeof v === 'number' && v >= 0) ? v : -1;
      }
    }

    // Build areas list from cellStatus. Each area is the bounding box of
    // its owner-index cells. Field names verified at impl time via a
    // follow-up Dump — assumed { id, cellList } here.
    var areas = [];
    if (Array.isArray(clues)) {
      for (var i = 0; i < clues.length; i++) {
        var cellList = [];
        for (var r2 = 0; r2 < rows && r2 < cs.length; r2++) {
          for (var c2 = 0; c2 < cs[r2].length; c2++) {
            if (cs[r2][c2] === i) cellList.push({ r: r2, c: c2 });
          }
        }
        areas.push({ id: i, cellList: cellList });
      }
      window.Game.currentState.areas = areas;
    }

    if (typeof window.Game.drawCurrentState === 'function') {
      window.Game.drawCurrentState();
    } else if (typeof window.Game.redraw === 'function') {
      window.Game.redraw();
    } else if (typeof window.Game.render === 'function') {
      window.Game.render();
    } else if (window.Game.getSaved && window.Game.loadGame) {
      var saved = window.Game.getSaved();
      if (saved) window.Game.loadGame(saved);
    }
    return true;
  } catch (e) {
    console.warn('Shikaku apply failed:', e);
    return false;
  }
}
```

- [ ] **Step 2: Syntax check**

Run: `cd /home/quando/documents/chrome-puzzle-solver && node -e "globalThis.window = {}; globalThis.document = {}; globalThis.setTimeout = setTimeout; require('./main-world.js'); console.log('parsed OK')" 2>&1 | head -3`

Expected: `parsed OK` (or other harmless output). Any `SyntaxError` would be a real issue.

- [ ] **Step 3: Lint + typecheck**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm run lint && npm run typecheck`

- [ ] **Step 4: Commit**

```bash
cd /home/quando/documents/chrome-puzzle-solver && jj commit -m "feat(shikaku): MAIN-world readShikakuData/readShikakuState/applyShikakuState"
```

---

## Task 8: Background allowlist + `MainWorldFn` union + eslint globals

**Files:**
- Modify: `background.js`
- Modify: `globals.d.ts`
- Modify: `eslint.config.js`

- [ ] **Step 1: Edit `background.js`** — extend `EXEC_MAIN_ALLOWLIST`:

Find:
```js
const EXEC_MAIN_ALLOWLIST = new Set([
  'readGameState',
  'readGameClues',
  'readGalaxiesData',
  'readGalaxiesState',
  'applyGalaxiesState',
  'readBinairoData',
  'readBinairoState',
  'applyBinairoState',
  'applyGameState',
  'applyHintCells',
  'dumpPuzzleForBench',
]);
```

Replace with:
```js
const EXEC_MAIN_ALLOWLIST = new Set([
  'readGameState',
  'readGameClues',
  'readGalaxiesData',
  'readGalaxiesState',
  'applyGalaxiesState',
  'readBinairoData',
  'readBinairoState',
  'applyBinairoState',
  'readShikakuData',
  'readShikakuState',
  'applyShikakuState',
  'applyGameState',
  'applyHintCells',
  'dumpPuzzleForBench',
]);
```

- [ ] **Step 2: Edit `globals.d.ts`** — extend `MainWorldFn` union + add ambient `ShikakuSolver`.

Find:
```ts
type MainWorldFn =
  | 'readGameState'
  | 'readGameClues'
  | 'readGalaxiesData'
  | 'readGalaxiesState'
  | 'applyGalaxiesState'
  | 'readBinairoData'
  | 'readBinairoState'
  | 'applyBinairoState'
  | 'applyGameState'
  | 'applyHintCells'
  | 'dumpPuzzleForBench';
```

Replace with:
```ts
type MainWorldFn =
  | 'readGameState'
  | 'readGameClues'
  | 'readGalaxiesData'
  | 'readGalaxiesState'
  | 'applyGalaxiesState'
  | 'readBinairoData'
  | 'readBinairoState'
  | 'applyBinairoState'
  | 'readShikakuData'
  | 'readShikakuState'
  | 'applyShikakuState'
  | 'applyGameState'
  | 'applyHintCells'
  | 'dumpPuzzleForBench';
```

Then find the existing ambient solver declarations (search for `declare const BinairoSolver`):

```ts
declare const NonogramSolver: any;
declare const AquariumSolver: any;
declare const GalaxiesSolver: any;
declare const BinairoSolver: any;
```

Add ShikakuSolver:

```ts
declare const NonogramSolver: any;
declare const AquariumSolver: any;
declare const GalaxiesSolver: any;
declare const BinairoSolver: any;
declare const ShikakuSolver: any;
```

- [ ] **Step 3: Edit `eslint.config.js`** — add ShikakuSolver to the solver-globals.

Run `grep -n "BinairoSolver" /home/quando/documents/chrome-puzzle-solver/eslint.config.js` to find the spot. Then add `ShikakuSolver: 'readonly'` alongside `BinairoSolver: 'readonly'` in the same object.

- [ ] **Step 4: Lint + typecheck**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm run lint && npm run typecheck`

Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
cd /home/quando/documents/chrome-puzzle-solver && jj commit -m "feat(shikaku): allowlist + MainWorldFn union + eslint globals"
```

---

## Task 9: `shikakuHandler` in `handler.js`

**Files:**
- Modify: `handler.js`

- [ ] **Step 1: Add the handler.** Find the existing `binairoHandler` registration (search for `registerHandler(binairoHandler)`). Insert IMMEDIATELY AFTER that line:

```js

// ── Shikaku handler (puzzles-mobile.com/shikaku/) ─────────────

const shikakuHandler = {
  name: 'puzzles-mobile-shikaku',
  priority: 30,

  matches() {
    return isPuzzlesMobilePage() &&
           window.location.pathname.includes('/shikaku/');
  },

  async detect() {
    const result = { found: false, rows: 0, cols: 0, rowClues: [], colClues: [] };
    const data = await callMainWorld('readShikakuData', []);
    if (!data) return { ...result, error: 'No Shikaku task data found' };
    const rows = data.height, cols = data.width;
    const clues = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = data.task[r]?.[c];
        if (typeof v === 'number' && v > 0) clues.push({ row: r, col: c, area: v });
      }
    }
    const sumAreas = clues.reduce((s, x) => s + x.area, 0);
    const gridArea = rows * cols;
    if (sumAreas !== gridArea) {
      return { ...result,
        error: `Clue areas sum to ${sumAreas} but grid is ${gridArea}` };
    }
    const stageEl = document.getElementById('stage') ||
                    document.getElementById('game') ||
                    document.querySelector('[class*="game"], [class*="puzzle"]');
    return {
      found: true,
      type: 'shikaku',
      rows, cols, clues,
      rowClues: [], colClues: [],
      _cells: [], _element: stageEl,
    };
  },

  async readState(ctx) {
    const state = await callMainWorld('readShikakuState', [ctx.rows, ctx.cols]);
    if (state) return state;
    return Array.from({ length: ctx.rows }, () => new Array(ctx.cols).fill(-1));
  },

  async applySolution(solution, ctx) {
    const ok = await callMainWorld('applyShikakuState', [solution, ctx.clues]);
    return ok
      ? { success: true }
      : { success: false, error: 'Shikaku apply failed (no window.Game or MAIN-world timeout)' };
  },
};

registerHandler(shikakuHandler);
```

- [ ] **Step 2: Lint + typecheck + tests**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm run lint && npm run typecheck && npm test 2>&1 | tail -3`

- [ ] **Step 3: Commit**

```bash
cd /home/quando/documents/chrome-puzzle-solver && jj commit -m "feat(shikaku): shikakuHandler (priority 30, matches /shikaku/)"
```

---

## Task 10: `content.js` — `solveExtraData` + cache key + supported puzzles

**Files:**
- Modify: `content.js`

- [ ] **Step 1: Add `shikaku` branch to `solveExtraData`**. Find:

```js
  if (data.type === 'binairo') {
    return {
      rows: data.rows,
      cols: data.cols,
      givens: data.givens,
      comparisonClues: data.comparisonClues || [],
    };
  }
```

Insert AFTER this block (before the next type's `if` or before the trailing `return null;`):

```js
  if (data.type === 'shikaku') {
    return {
      rows: data.rows,
      cols: data.cols,
      clues: data.clues,
    };
  }
```

- [ ] **Step 2: Add `shikakuCacheKey`** near the existing `binairoCacheKey`. Use grep to locate:

```bash
grep -n "function binairoCacheKey" /home/quando/documents/chrome-puzzle-solver/content.js
```

Insert IMMEDIATELY AFTER `binairoCacheKey`'s closing `}`:

```js
function shikakuCacheKey(data) {
  if (data?.type !== 'shikaku') return null;
  let h = 0x811c9dc5;
  const mix = (n) => { h ^= n; h = Math.imul(h, 0x01000193) >>> 0; };
  mix(0x53); // 'S' nameplate
  mix(data.rows | 0);
  mix(data.cols | 0);
  const clues = Array.isArray(data.clues) ? data.clues : [];
  mix(clues.length);
  // Sort for stable hashing.
  const sorted = clues.slice().sort((a, b) =>
    a.row - b.row || a.col - b.col || a.area - b.area);
  for (const k of sorted) {
    mix(k.row | 0);
    mix(k.col | 0);
    mix(k.area | 0);
  }
  return 'shikaku-solution:' + (h >>> 0).toString(16);
}
```

- [ ] **Step 3: Wire `shikakuCacheKey` into the dispatch chains.** Find `getCachedGridSolution`:

```bash
grep -n "function getCachedGridSolution\|function cacheGridSolution" /home/quando/documents/chrome-puzzle-solver/content.js
```

Read both functions. Each has a ternary chain dispatching by `data?.type`. Add a `'shikaku'` arm to each, calling `shikakuCacheKey(data)`. The shape mirrors the existing `'binairo'` arm.

- [ ] **Step 4: Add `'shikaku-solution:'` to `SOLUTION_KEY_PREFIXES`**

```bash
grep -n "SOLUTION_KEY_PREFIXES" /home/quando/documents/chrome-puzzle-solver/content.js
```

Find the array literal and append `'shikaku-solution:'` alongside `'binairo-solution:'`.

- [ ] **Step 5: Add Shikaku to `SUPPORTED_PUZZLES`**

Find:
```js
const SUPPORTED_PUZZLES = [
  { name: 'Nonogram',     url: 'https://www.puzzles-mobile.com/nonograms/' },
  { name: 'Aquarium',     url: 'https://www.puzzles-mobile.com/aquarium/' },
  { name: 'Galaxies',     url: 'https://www.puzzles-mobile.com/galaxies/' },
  { name: 'Binairo',      url: 'https://www.puzzles-mobile.com/binairo/' },
  { name: 'Binairo Plus', url: 'https://www.puzzles-mobile.com/binairo-plus/' },
];
```

Replace with:
```js
const SUPPORTED_PUZZLES = [
  { name: 'Nonogram',     url: 'https://www.puzzles-mobile.com/nonograms/' },
  { name: 'Aquarium',     url: 'https://www.puzzles-mobile.com/aquarium/' },
  { name: 'Galaxies',     url: 'https://www.puzzles-mobile.com/galaxies/' },
  { name: 'Binairo',      url: 'https://www.puzzles-mobile.com/binairo/' },
  { name: 'Binairo Plus', url: 'https://www.puzzles-mobile.com/binairo-plus/' },
  { name: 'Shikaku',      url: 'https://www.puzzles-mobile.com/shikaku/' },
];
```

- [ ] **Step 6: Lint + typecheck + tests**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm run lint && npm run typecheck && npm test 2>&1 | tail -3`

- [ ] **Step 7: Commit**

```bash
cd /home/quando/documents/chrome-puzzle-solver && jj commit -m "feat(shikaku): solveExtraData, cache key, supported puzzles list"
```

---

## Task 11: `content.js` — `getHint` branch + `shikakuHintStatusNodes` + apply

**Files:**
- Modify: `content.js`

- [ ] **Step 1: Add `'shikaku'` branch to the main `getHint` function**

Find the binairo branch in `getHint` (search for `} else if (detectedGrid.type === 'binairo') {`). Insert IMMEDIATELY AFTER its closing `}`:

```js
    } else if (detectedGrid.type === 'shikaku') {
      const solver = new ShikakuSolver({
        rows, cols, clues: detectedGrid.clues, initialState: grid,
      });
      hint = solver.getHint(grid);
      if (!hint) {
        return { success: false, error: 'No more cells can be deduced from the current state. Click Solve to finish.' };
      }
```

- [ ] **Step 2: Add `shikakuHintStatusNodes`** near `binairoHintStatusNodes`. Find:

```bash
grep -n "function binairoHintStatusNodes" /home/quando/documents/chrome-puzzle-solver/content.js
```

Insert IMMEDIATELY AFTER its closing `}`:

```js
  function shikakuHintStatusNodes(h) {
    const total = (h.cells?.length || 0) + (h.extraCells?.length || 0);
    if (total === 0) return ['No hint available'];
    if (total === 1) {
      const cell = h.cells?.[0] || h.extraCells?.[0];
      const row = h.cells?.length ? h.index : cell.row;
      const col = h.cells?.length ? cell.index : cell.col;
      return [
        'Cell ', bold(`(row ${row + 1}, col ${col + 1})`),
        ' belongs to area ', bold(String(cell.value + 1)),
      ];
    }
    return [bold(String(total)), ' cells can be deduced'];
  }
```

- [ ] **Step 3: Add the `shikaku` branch to `setHintStatus`**. Find:

```bash
grep -n "function setHintStatus" /home/quando/documents/chrome-puzzle-solver/content.js
```

Find the existing chain:

```js
  function setHintStatus(h, prefix = '') {
    if (h.type === 'galaxies') {
      setStatusNodes('info', prefix, 'Draw the ', bold(galaxiesHintLineDesc(h)), '.');
    } else if (puzzleData?.type === 'binairo') {
      setStatusNodes('info', prefix, ...binairoHintStatusNodes(h));
    } else {
      setStatusNodes('info', prefix, ...hintStatusNodes(h));
    }
  }
```

Replace with:

```js
  function setHintStatus(h, prefix = '') {
    if (h.type === 'galaxies') {
      setStatusNodes('info', prefix, 'Draw the ', bold(galaxiesHintLineDesc(h)), '.');
    } else if (puzzleData?.type === 'binairo') {
      setStatusNodes('info', prefix, ...binairoHintStatusNodes(h));
    } else if (puzzleData?.type === 'shikaku') {
      setStatusNodes('info', prefix, ...shikakuHintStatusNodes(h));
    } else {
      setStatusNodes('info', prefix, ...hintStatusNodes(h));
    }
  }
```

- [ ] **Step 4: Add the `shikaku` branch to `applyHintHandler`**. Find:

```bash
grep -n "async function applyHintHandler" /home/quando/documents/chrome-puzzle-solver/content.js
```

Replace the function body's apply branch:

```js
    if (puzzleData.pendingHint.type === 'galaxies') {
      result = await applySolution({ type: 'galaxies-lines', lines: puzzleData.pendingHint.lines });
    } else {
      const hintCells = hintAbsoluteCells(puzzleData.pendingHint);
      const ok = await callMainWorld('applyHintCells', [hintCells]);
      result = ok ? { success: true } : { success: false, error: 'Hint apply failed' };
    }
```

with:

```js
    if (puzzleData.pendingHint.type === 'galaxies') {
      result = await applySolution({ type: 'galaxies-lines', lines: puzzleData.pendingHint.lines });
    } else if (puzzleData.type === 'shikaku') {
      // Shikaku uses owner-index cellStatus + currentState.areas; the
      // generic applyHintCells writer doesn't know that shape. Read the
      // current state, overlay the hint cells, and re-apply via the
      // dedicated shikaku function.
      const hintCells = hintAbsoluteCells(puzzleData.pendingHint);
      const cur = await callMainWorld('readShikakuState', [puzzleData.rows, puzzleData.cols]);
      const grid = cur || Array.from({ length: puzzleData.rows }, () => new Array(puzzleData.cols).fill(-1));
      for (const cell of hintCells) grid[cell.row][cell.col] = cell.value;
      const ok = await callMainWorld('applyShikakuState', [grid, puzzleData.clues]);
      result = ok ? { success: true } : { success: false, error: 'Shikaku hint apply failed' };
    } else {
      const hintCells = hintAbsoluteCells(puzzleData.pendingHint);
      const ok = await callMainWorld('applyHintCells', [hintCells]);
      result = ok ? { success: true } : { success: false, error: 'Hint apply failed' };
    }
```

- [ ] **Step 5: Also add the `shikaku` branch to `applyAndRunLoop`** (the Loop-button apply path). Find:

```bash
grep -n "async function applyAndRunLoop" /home/quando/documents/chrome-puzzle-solver/content.js
```

Look at the existing branch. It will have a similar `if (puzzleData.pendingHint.type === 'galaxies') { ... } else { callMainWorld('applyHintCells', [hintCells]) }`. Add the same shikaku branch shape:

```js
      } else if (puzzleData.type === 'shikaku') {
        const hintCells = hintAbsoluteCells(puzzleData.pendingHint);
        const cur = await callMainWorld('readShikakuState', [puzzleData.rows, puzzleData.cols]);
        const grid = cur || Array.from({ length: puzzleData.rows }, () => new Array(puzzleData.cols).fill(-1));
        for (const cell of hintCells) grid[cell.row][cell.col] = cell.value;
        ok = !!(await callMainWorld('applyShikakuState', [grid, puzzleData.clues]));
      }
```

Place it as a sibling branch to the galaxies arm.

- [ ] **Step 6: Lint + typecheck + tests**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm run lint && npm run typecheck && npm test 2>&1 | tail -3`

- [ ] **Step 7: Commit**

```bash
cd /home/quando/documents/chrome-puzzle-solver && jj commit -m "feat(shikaku): getHint branch + shikakuHintStatusNodes + apply path"
```

---

## Task 12: Canvas preview — colored cells + clue numbers + borders

**Files:**
- Modify: `content.js`

The preview renders shikaku cells colored by owner index, with thick black borders between cells of different owners, and clue numbers as text overlays at clue cells.

- [ ] **Step 1: Extend `staticSig`** to include the clue hash.

Find:
```js
    const staticSig = rows + 'x' + cols + '@' + cellSize + '|t=' + (pd?.type || '') +
                      '|rm=' + regionMapSig(pd?.regionMap) +
                      '|st=' + (pd?.stars ? pd.stars.map(s => s.row + ',' + s.col).join(';') : '') +
                      '|cc=' + comparisonCluesSig(pd?.comparisonClues);
```

Replace with:
```js
    const staticSig = rows + 'x' + cols + '@' + cellSize + '|t=' + (pd?.type || '') +
                      '|rm=' + regionMapSig(pd?.regionMap) +
                      '|st=' + (pd?.stars ? pd.stars.map(s => s.row + ',' + s.col).join(';') : '') +
                      '|cc=' + comparisonCluesSig(pd?.comparisonClues) +
                      '|sk=' + shikakuCluesSig(pd?.type === 'shikaku' ? pd.clues : null);
```

- [ ] **Step 2: Add `shikakuCluesSig` near `comparisonCluesSig`**

```bash
grep -n "function comparisonCluesSig" /home/quando/documents/chrome-puzzle-solver/content.js
```

Insert IMMEDIATELY AFTER its closing `}`:

```js
  function shikakuCluesSig(clues) {
    if (!Array.isArray(clues) || clues.length === 0) return '0';
    let h = 0x811c9dc5;
    for (const k of clues) {
      h ^= (k.row | 0) * 65537 + (k.col | 0) * 31 + (k.area | 0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return (h >>> 0).toString(36);
  }
```

- [ ] **Step 3: Add shikaku to the cell-paint loop in `drawPreview`**

Find the existing cell-paint loop in `drawPreview` (search for `const isBinairo = puzzleData?.type === 'binairo'`):

```js
    const isBinairo = puzzleData?.type === 'binairo';
    const discR = isBinairo ? Math.max(2, Math.floor(cellSize * 0.35)) : 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = grid[r][c];
        if (v === 0) continue;
        const x = c * cellSize, y = r * cellSize;
        if (isBinairo) {
          // ... existing binairo branch ...
        } else if (puzzleData?.type === 'galaxies' && v > 0) {
          // ... existing galaxies branch ...
        } else if (v === 1) {
          // ...
```

Add a shikaku branch as a new conditional alongside galaxies. The shikaku cell value is the owner *index* (0..clues.length-1) or `-1` for unassigned. We treat positive integers as owner indices and color them with `galaxiesColors`:

After the `isBinairo` branch, before the `puzzleData?.type === 'galaxies'` branch, insert:

```js
        } else if (puzzleData?.type === 'shikaku' && v >= 0) {
          ctx.fillStyle = galaxiesColors[v % galaxiesColors.length];
          ctx.fillRect(x + 1, y + 1, cellSize - 2, cellSize - 2);
```

- [ ] **Step 4: Add shikaku borders to `drawPreview`**. The existing galaxies branch draws borders between cells of different owners. For shikaku, do the same. Find the existing block (search for `if (puzzleData?.type === 'galaxies')` inside `drawPreview` — the one that draws galaxy lines):

```js
    if (puzzleData?.type === 'galaxies') {
      ctx.save();
      ctx.strokeStyle = '#1f2937';
      ctx.lineWidth = Math.max(2, Math.floor(cellSize / 8));
      const glines = grid.galaxies;
      // ... existing galaxy line drawing ...
    }
```

After that block, insert a shikaku-borders block:

```js
    if (puzzleData?.type === 'shikaku') {
      ctx.save();
      ctx.strokeStyle = '#1f2937';
      ctx.lineWidth = Math.max(2, Math.floor(cellSize / 8));
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = c * cellSize, y = r * cellSize;
          const v = grid[r][c];
          if (c + 1 < cols && grid[r][c + 1] !== v) {
            ctx.beginPath(); ctx.moveTo(x + cellSize, y); ctx.lineTo(x + cellSize, y + cellSize); ctx.stroke();
          }
          if (r + 1 < rows && grid[r + 1][c] !== v) {
            ctx.beginPath(); ctx.moveTo(x, y + cellSize); ctx.lineTo(x + cellSize, y + cellSize); ctx.stroke();
          }
        }
      }
      ctx.restore();
    }
```

- [ ] **Step 5: Add clue-number overlays to `buildStaticLayer`**. Find:

```bash
grep -n "function buildStaticLayer" /home/quando/documents/chrome-puzzle-solver/content.js
```

Inside `buildStaticLayer`, after the existing branches (galaxies stars, binairo glyphs), append:

```js
    if (pd?.type === 'shikaku' && Array.isArray(pd.clues)) {
      drawShikakuCluesOn(ctx, cellSize, pd.clues);
    }
```

Then add a new helper right after the `drawComparisonCluesOn` helper:

```js
  function drawShikakuCluesOn(ctx, cellSize, clues) {
    const fontSize = Math.max(10, Math.floor(cellSize * 0.5));
    ctx.save();
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#fff';
    ctx.fillStyle = '#111827';
    for (const k of clues) {
      const x = k.col * cellSize + cellSize / 2;
      const y = k.row * cellSize + cellSize / 2;
      const ch = String(k.area);
      ctx.strokeText(ch, x, y);
      ctx.fillText(ch, x, y);
    }
    ctx.restore();
  }
```

- [ ] **Step 6: Lint + typecheck + tests + build**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm run lint && npm run typecheck && npm test 2>&1 | tail -3 && npm run build`

- [ ] **Step 7: Commit**

```bash
cd /home/quando/documents/chrome-puzzle-solver && jj commit -m "feat(shikaku): canvas preview colored cells + borders + clue numbers"
```

---

## Task 13: Live verification + Dump-button branch

**Files:**
- Modify: `main-world.js` — `dumpPuzzleForBench` branch.

This is the user-side live verification step + the dump branch so future puzzle captures work.

- [ ] **Step 1: Add `/shikaku/` branch to `dumpPuzzleForBench`**

In `main-world.js`, find the existing binairo branch (search for `path.indexOf('/binairo/')`):

```js
    if (path.indexOf('/binairo/') !== -1 || path.indexOf('/binairo-plus/') !== -1) {
      // ... existing body ...
    }
```

Insert IMMEDIATELY AFTER that block (before the next path branch):

```js
    if (path.indexOf('/shikaku/') !== -1) {
      if (!Array.isArray(g.task)) {
        return { error: 'shikaku: g.task is not a 2D array', diagnostic: diagnostic(g), path: path };
      }
      var clues = [];
      for (var r = 0; r < height; r++) {
        var srcRow = g.task[r] || [];
        for (var c = 0; c < width; c++) {
          var v = srcRow[c];
          if (typeof v === 'number' && v > 0) clues.push({ row: r, col: c, area: v });
        }
      }
      return { type: 'shikaku', rows: height, cols: width, clues: clues, path: path };
    }
```

- [ ] **Step 2: Rebuild dist + commit**

```bash
cd /home/quando/documents/chrome-puzzle-solver && npm run lint && npm run typecheck && npm run build
cd /home/quando/documents/chrome-puzzle-solver && jj commit -m "feat(shikaku): dumpPuzzleForBench branch for /shikaku/ pages"
```

- [ ] **Step 3: USER live verification** (this plan can't drive a browser):

1. Reload the unpacked extension from `dist/` in Chrome.
2. Visit `https://www.puzzles-mobile.com/shikaku/random/5x5`.
3. **Detect** → status reads "Detected Shikaku 5×5".
4. **Solve** → status reads "Solved!" and preview canvas shows the partitioned rectangles in distinct colors with clue numbers visible.
5. Click **Apply** (Solve button after Solve completes). Verify the board updates to match the preview.
6. **If the apply path fails** — currentState.areas shape doesn't match the page's expectations — capture a follow-up Dump after manually drawing one rectangle on the page. Inspect `Game.currentState.areas` shape in DevTools and patch `applyShikakuState` to match. Commit the patch as a separate `fix(shikaku): applyShikakuState areas shape` change.
7. **Hint** → click on a fresh page (reset first via the page's own UI). Verify one or more cells get highlighted with translucent colors.
8. **Loop** → click; verify cells fill one (or one rectangle's worth) per tick.

This step does NOT produce a commit unless step 6's patch was needed.

---

## Task 14: Deterministic fixture + golden snapshot + matching solver test

**Files:**
- Modify: `tests/fixtures/puzzles.js`
- Modify: `tests/capture.js`
- Modify: `tests/golden.js` (auto-regenerated)
- Modify: `tests/solver.test.js`

- [ ] **Step 1: Append fixture** to `tests/fixtures/puzzles.js`. Find the existing `binairoPlus6x6` entry. Insert AFTER it (before the closing `};`):

```js
  // 5x5 Shikaku captured from puzzles-mobile.com/shikaku/random/5x5 on
  // 2026-05-19. 9 clues, areas summing to 25 (= 5×5).
  shikaku5x5: {
    rows: 5,
    cols: 5,
    clues: [
      { row: 0, col: 0, area: 4 },
      { row: 0, col: 3, area: 2 },
      { row: 1, col: 1, area: 2 },
      { row: 2, col: 2, area: 3 },
      { row: 2, col: 3, area: 4 },
      { row: 3, col: 1, area: 2 },
      { row: 3, col: 3, area: 2 },
      { row: 4, col: 3, area: 4 },
      { row: 4, col: 4, area: 2 },
    ],
  },
```

- [ ] **Step 2: Edit `tests/capture.js`** to handle shikaku.

Find:
```js
const { NonogramSolver, AquariumSolver, GalaxiesSolver, BinairoSolver } = require('../solver.js');
```

Replace with:
```js
const { NonogramSolver, AquariumSolver, GalaxiesSolver, BinairoSolver, ShikakuSolver } = require('../solver.js');
```

Find `solveBinairo` and add a `solveShikaku` right after it:

```js
function solveShikaku(p) {
  ShikakuSolver.clearSolutionCache();
  return new ShikakuSolver({ rows: p.rows, cols: p.cols, clues: p.clues }).solve();
}
```

Find the `raw` map. Append `shikaku5x5: solveShikaku(fixtures.shikaku5x5)`:

```js
const raw = {
  // ... existing entries unchanged ...
  binairoPlus6x6:    solveBinairo(fixtures.binairoPlus6x6),
  shikaku5x5:        solveShikaku(fixtures.shikaku5x5),
};
```

- [ ] **Step 3: Regenerate goldens**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm run capture`

Expected: `Wrote tests/golden.js with N entries.` (one more than before) and `shikaku5x5: solved=true`.

If `solved=false` — investigate immediately. This is a real bug in the solver. BLOCKED until fixed.

- [ ] **Step 4: Append golden-match test** to `tests/solver.test.js`:

```js
test('ShikakuSolver: 5x5 fixture matches golden', () => {
  ShikakuSolver.clearSolutionCache();
  const p = fixtures.shikaku5x5;
  const result = clean(
    new ShikakuSolver({ rows: p.rows, cols: p.cols, clues: p.clues }).solve()
  );
  assert.deepEqual(result, golden.shikaku5x5);
});
```

- [ ] **Step 5: Run + lint + typecheck**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm run lint && npm run typecheck && npm test 2>&1 | tail -3`

Expected: all green.

- [ ] **Step 6: Commit**

```bash
cd /home/quando/documents/chrome-puzzle-solver && jj commit -m "test(shikaku): 5x5 fixture + golden snapshot + matching solver test"
```

---

## Task 15: Constructive fuzz test

**Files:**
- Create: `tests/shikaku-fuzz.test.js`

For each seed, build a random partition of an `R × C` grid via BSP (binary space partitioning) — recursively split rectangles until min-size cells. Pick a clue cell (top-left of each rectangle), set its area to the rectangle's cell count. Solver must find a valid partition matching all clues.

- [ ] **Step 1: Create the fuzz test file**

```js
// Constructive fuzz for ShikakuSolver. Builds a random partition via BSP,
// extracts clues, solves, asserts the solver returns a grid that is a
// valid Shikaku partition (every clue area matches the count of cells
// owned by that clue's rectangle, every cell is owned, no clue's
// rectangle contains another clue cell).

const test = require('node:test');
const assert = require('node:assert/strict');
const { ShikakuSolver } = require('../solver.js');

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function bspPartition(rand, r1, c1, r2, c2, minSize, out) {
  const h = r2 - r1 + 1;
  const w = c2 - c1 + 1;
  // Stop splitting if either dimension would dip below minSize, or by chance.
  if (h <= minSize && w <= minSize) {
    out.push({ r1, c1, r2, c2 });
    return;
  }
  if (rand() < 0.25) {
    out.push({ r1, c1, r2, c2 });
    return;
  }
  // Pick a split axis preferring the longer one.
  const splitVertical = w >= h ? rand() < 0.7 : rand() < 0.3;
  if (splitVertical && w > minSize * 2) {
    const c = c1 + minSize + Math.floor(rand() * (w - 2 * minSize));
    bspPartition(rand, r1, c1, r2, c, minSize, out);
    bspPartition(rand, r1, c + 1, r2, c2, minSize, out);
  } else if (h > minSize * 2) {
    const r = r1 + minSize + Math.floor(rand() * (h - 2 * minSize));
    bspPartition(rand, r1, c1, r, c2, minSize, out);
    bspPartition(rand, r + 1, c1, r2, c2, minSize, out);
  } else {
    out.push({ r1, c1, r2, c2 });
  }
}

function makeCluesFromPartition(rects) {
  return rects.map(r => ({
    row: r.r1,
    col: r.c1,
    area: (r.r2 - r.r1 + 1) * (r.c2 - r.c1 + 1),
  }));
}

function verifyShikakuSolution(grid, clues, R, C) {
  const counts = new Array(clues.length).fill(0);
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      const o = grid[r][c];
      if (!Number.isInteger(o) || o < 0 || o >= clues.length) {
        return `cell (${r},${c}) has invalid owner ${o}`;
      }
      counts[o]++;
    }
  }
  for (let i = 0; i < clues.length; i++) {
    if (counts[i] !== clues[i].area) {
      return `clue ${i} (row ${clues[i].row}, col ${clues[i].col}, area ${clues[i].area}) actually has ${counts[i]} cells`;
    }
  }
  // Each clue cell must belong to its own rectangle.
  for (let i = 0; i < clues.length; i++) {
    const cellOwner = grid[clues[i].row][clues[i].col];
    if (cellOwner !== i) {
      return `clue ${i}'s own cell is owned by ${cellOwner}`;
    }
  }
  // Each owner-set must form a rectangle.
  for (let i = 0; i < clues.length; i++) {
    let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
    let count = 0;
    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        if (grid[r][c] === i) {
          minR = Math.min(minR, r);
          maxR = Math.max(maxR, r);
          minC = Math.min(minC, c);
          maxC = Math.max(maxC, c);
          count++;
        }
      }
    }
    const w = maxC - minC + 1;
    const h = maxR - minR + 1;
    if (w * h !== count) {
      return `owner ${i}'s cells do not form a rectangle (bbox ${w}×${h} but ${count} cells)`;
    }
  }
  return null;
}

function runTrial(seed, R, C, minSize) {
  const rand = rng(seed);
  const rects = [];
  bspPartition(rand, 0, 0, R - 1, C - 1, minSize, rects);
  const clues = makeCluesFromPartition(rects);
  ShikakuSolver.clearSolutionCache();
  const result = new ShikakuSolver({ rows: R, cols: C, clues }).solve();
  assert.equal(result.solved, true,
    `seed=${seed} R=${R} C=${C}: solver failed on a constructively-built puzzle. ` +
    `clues=${JSON.stringify(clues)}`);
  const violation = verifyShikakuSolution(result.grid, clues, R, C);
  assert.equal(violation, null,
    `seed=${seed} R=${R} C=${C}: solver returned solved=true but ${violation}. ` +
    `grid=${JSON.stringify(result.grid)}`);
}

test('ShikakuSolver: constructive fuzz 5x5 (30 trials)', () => {
  for (let seed = 1; seed <= 30; seed++) runTrial(seed, 5, 5, 1);
});

test('ShikakuSolver: constructive fuzz 7x7 (20 trials)', () => {
  for (let seed = 100; seed <= 119; seed++) runTrial(seed, 7, 7, 1);
});

test('ShikakuSolver: constructive fuzz 10x10 (10 trials)', () => {
  for (let seed = 200; seed <= 209; seed++) runTrial(seed, 10, 10, 1);
});
```

- [ ] **Step 2: Run + lint**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm test -- --test-name-pattern='constructive fuzz'`

Expected: 3 passes.

If any trial fails, the solver has a real bug — debug, fix, and re-run before commit.

- [ ] **Step 3: Lint + typecheck + full suite**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm run lint && npm run typecheck && npm test 2>&1 | tail -3`

- [ ] **Step 4: Commit**

```bash
cd /home/quando/documents/chrome-puzzle-solver && jj commit -m "test(shikaku): constructive partition-based fuzz"
```

---

## Task 16: Real-puzzles fixture + bench script + CI step

**Files:**
- Modify: `tests/fixtures/real-puzzles.js`
- Create: `tests/bench-shikaku.js`
- Modify: `package.json`
- Modify: `.github/workflows/bench-nightly.yml`

- [ ] **Step 1: Append real-puzzles entry**

In `tests/fixtures/real-puzzles.js`, find the closing `};` of the module-exports object. Insert BEFORE it:

```js
  // Shikaku 5x5 captured from puzzles-mobile.com/shikaku/random/5x5 on
  // 2026-05-19. Mirrors fixtures.shikaku5x5 in shape; this copy lives in
  // real-puzzles.js so bench-shikaku.js exercises the shikaku code path.
  shikakuReal5x5_a: {
    type: 'shikaku',
    rows: 5,
    cols: 5,
    clues: [
      { row: 0, col: 0, area: 4 },
      { row: 0, col: 3, area: 2 },
      { row: 1, col: 1, area: 2 },
      { row: 2, col: 2, area: 3 },
      { row: 2, col: 3, area: 4 },
      { row: 3, col: 1, area: 2 },
      { row: 3, col: 3, area: 2 },
      { row: 4, col: 3, area: 4 },
      { row: 4, col: 4, area: 2 },
    ],
  },
```

- [ ] **Step 2: Create `tests/bench-shikaku.js`**

```js
const { ShikakuSolver } = require('../solver.js');
const real = require('./fixtures/real-puzzles.js');

const origLog = console.log;
console.log = () => {};
const log = (...a) => origLog(...a);

const targets = Object.keys(real)
  .filter(k => real[k]?.type === 'shikaku')
  .map(k => ({ name: k, puzzle: real[k] }));

if (targets.length === 0) {
  console.error('FAIL: no shikaku entries in tests/fixtures/real-puzzles.js');
  process.exit(1);
}

const WARMUP = 2;
const N = 11;
let failed = false;

for (const { name, puzzle } of targets) {
  for (let i = 0; i < WARMUP; i++) {
    ShikakuSolver.clearSolutionCache();
    new ShikakuSolver({ rows: puzzle.rows, cols: puzzle.cols, clues: puzzle.clues }).solve();
  }
  const times = [];
  let solvedFlag = null;
  for (let i = 0; i < N; i++) {
    ShikakuSolver.clearSolutionCache();
    const s = new ShikakuSolver({ rows: puzzle.rows, cols: puzzle.cols, clues: puzzle.clues });
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
  console.error('FAIL: one or more shikaku bench puzzles did not solve');
  process.exit(1);
}
```

- [ ] **Step 3: Run the bench**

Run: `cd /home/quando/documents/chrome-puzzle-solver && node tests/bench-shikaku.js`

Expected: one or more lines, each `solved: true`.

- [ ] **Step 4: Edit `package.json`** — append `"bench:shikaku"`:

Find the `"scripts"` block. Add after `"bench:binairo"`:

```json
    "bench:shikaku": "node tests/bench-shikaku.js"
```

(Make sure the preceding line ends with a comma.)

- [ ] **Step 5: Edit `.github/workflows/bench-nightly.yml`** — append the bench step.

Find the existing bench steps:

```yaml
      - run: node tests/bench-real.js
      - run: node tests/bench-galaxies.js
      - run: node tests/bench-aquarium.js
      - run: node tests/bench-binairo.js
```

Replace with:
```yaml
      - run: node tests/bench-real.js
      - run: node tests/bench-galaxies.js
      - run: node tests/bench-aquarium.js
      - run: node tests/bench-binairo.js
      - run: node tests/bench-shikaku.js
```

- [ ] **Step 6: Verify the npm script + suite + lint**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm run bench:shikaku && npm run lint && npm test 2>&1 | tail -3`

- [ ] **Step 7: Commit**

```bash
cd /home/quando/documents/chrome-puzzle-solver && jj commit -m "test(shikaku): real-puzzle bench + npm script + CI step"
```

---

## Task 17: `CLAUDE.md` update

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the top description**

Find the first paragraph (something like *"A Chrome MV3 extension that solves Nonogram, Aquarium, Galaxies, Binairo, and Binairo Plus puzzles..."*):

Replace with:
```markdown
A Chrome MV3 extension that solves Nonogram, Aquarium, Galaxies, Binairo,
Binairo Plus, and Shikaku puzzles on puzzles-mobile.com. Five solver
classes in `solver.js`, a content-script widget in `content.js`, and a
small service worker in `background.js`.
```

- [ ] **Step 2: Update the file-responsibilities row** for `solver.js`. Find:

```markdown
| `solver.js` | `NonogramSolver`, `AquariumSolver`, `GalaxiesSolver`, `BinairoSolver` — pure logic, no DOM | Content script + Web Worker (via inlined Blob) + Node tests |
```

Replace with:

```markdown
| `solver.js` | `NonogramSolver`, `AquariumSolver`, `GalaxiesSolver`, `BinairoSolver`, `ShikakuSolver` — pure logic, no DOM | Content script + Web Worker (via inlined Blob) + Node tests |
```

- [ ] **Step 3: Update the allowlist-count note**

Find:
```markdown
- `background.js`'s `onMessage` listener rejects anything where `sender.id !== chrome.runtime.id` and gates `execMain` `funcName` against `EXEC_MAIN_ALLOWLIST` (11 entries). The TS-side mirror is `MainWorldFn` in `globals.d.ts`; keep them in sync.
```

Replace `11 entries` with `14 entries`.

- [ ] **Step 4: Add Shikaku encoding subsection**

Find the existing `### Binairo Plus / comparison-clue support` subsection. Locate its end. Insert IMMEDIATELY AFTER it:

```markdown
### Shikaku encoding

The `/shikaku/*` path is served by a dedicated `ShikakuSolver` +
`shikakuHandler` because Shikaku's algorithm doesn't overlap with the
cell-state puzzles (it partitions the grid into rectangles).

Page exposes the puzzle at `window.Game.task` as a 2D array of integers.
Non-zero cells are clues — the integer value is the **area** of the
rectangle that must contain that cell. Zero cells are non-clue cells.
`window.Game.currentState.cellStatus` is `rows × cols` of int: `-1` =
unassigned, otherwise the index of the area (rectangle) that owns the
cell. `currentState.areas` holds the rectangle list — the field shape
was first captured at impl time from a live Dump after drawing one
rectangle; see `applyShikakuState` in `main-world.js` for the
authoritative shape.

Solver shape: `ShikakuSolver` per-clue enumerates rectangle candidates
(all axis-aligned rects containing the clue cell, with the right area,
no other clue inside, fitting in the grid). Propagation: single-candidate
forcing places a rectangle; cascade prunes overlapping candidates of
other clues. Most-constrained backtracking when propagation exhausts.
Hint uses propagation + a single forward-checking pass over each clue's
candidates (place each, propagate, check feasibility — force any clue
whose only surviving candidate is unique). Static `_solutionCache` keyed
on FNV-1a of `(rows, cols, clues sorted)`, 50-entry LRU.

Solution shape across worker → content → MAIN bridge: 2D `number[][]`
where each cell holds its owning clue's index (0..K-1) or `-1` if
unassigned. Hint shape is row-anchored like the other puzzles
(`{ type: 'row', index, cells, extraCells, count }`); the cell values
are owner indices, not 1/2/-1. The `applyHintHandler` and
`applyAndRunLoop` in `content.js` have shikaku-specific arms that
re-read the current state, overlay the hint cells, and re-apply via
`applyShikakuState` (rather than the generic `applyHintCells` which
assumes cell-state encoding).

Preview canvas colors each cell by owner index using the existing
`galaxiesColors` palette, draws thick borders between cells of different
owners, and overlays the clue numbers as bold text at clue cells. The
clue overlay lives in the cached `staticLayer`; `staticSig` includes a
`|sk=` segment so the layer rebuilds when the clue set changes.
```

- [ ] **Step 5: Verify**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm run lint && npm run typecheck && npm test 2>&1 | tail -3`

- [ ] **Step 6: Commit**

```bash
cd /home/quando/documents/chrome-puzzle-solver && jj commit -m "docs(claude): Shikaku encoding subsection + file-row + allowlist count"
```

---

## Final verification

After all tasks complete:

- [ ] **Step 1: Full quality gate**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm run lint && npm run typecheck && npm test && npm run build`

Expected: all green.

- [ ] **Step 2: Benches**

Run: `cd /home/quando/documents/chrome-puzzle-solver && node tests/bench-shikaku.js && node tests/bench-binairo.js`

Expected: each reports `solved: true` for every fixture.

- [ ] **Step 3: `jj log` review**

Run: `cd /home/quando/documents/chrome-puzzle-solver && jj log -n 20`

Expected commits (oldest to newest, in the order tasks were executed):
- `feat(shikaku): ShikakuSolver constructor + candidate enumeration`
- `feat(shikaku): single-candidate forcing + rectangle-fit elimination`
- `feat(shikaku): solve() with MRV backtracking`
- `feat(shikaku): static _solutionCache with LRU eviction`
- `feat(shikaku): getHint with forward-checking fallback`
- `feat(shikaku): dispatch case in solver.worker.js`
- `feat(shikaku): MAIN-world readShikakuData/readShikakuState/applyShikakuState`
- `feat(shikaku): allowlist + MainWorldFn union + eslint globals`
- `feat(shikaku): shikakuHandler (priority 30, matches /shikaku/)`
- `feat(shikaku): solveExtraData, cache key, supported puzzles list`
- `feat(shikaku): getHint branch + shikakuHintStatusNodes + apply path`
- `feat(shikaku): canvas preview colored cells + borders + clue numbers`
- `feat(shikaku): dumpPuzzleForBench branch for /shikaku/ pages`
- (optional) `fix(shikaku): applyShikakuState areas shape` — only if the live verify exposed a mismatch.
- `test(shikaku): 5x5 fixture + golden snapshot + matching solver test`
- `test(shikaku): constructive partition-based fuzz`
- `test(shikaku): real-puzzle bench + npm script + CI step`
- `docs(claude): Shikaku encoding subsection + file-row + allowlist count`

---

## Notes for the executing engineer

- **`puzzleData.type === 'shikaku'`.** The dispatcher checks `puzzleData.type` to route through the shikaku-specific branches in `content.js` (apply, hint status, preview render). Don't conflate with `pendingHint.type` (the hint shape's own field, still `'row'`).
- **Owner indices are integers, not 1/2/-1.** The hint cell `value` field carries owner indices. The MAIN-world `applyHintCells` doesn't know this encoding — that's why the shikaku branch in `applyHintHandler` routes through `applyShikakuState` instead.
- **`currentState.areas` shape.** Recon couldn't capture the populated shape. Task 7's `applyShikakuState` assumes `[{ id, cellList }]`; Task 13's live verification confirms or patches this. If the page rejects our shape, capture the live one, patch `applyShikakuState`, and rebuild.
- **`jj`, not `git`.** Every commit step uses `jj commit -m "..."`. The repo is colocated; `git commit` silently misroutes the change.
- **No `manifest.json` change.** Host permissions already cover `puzzles-mobile.com/*`.
- **No `npm run build` mid-plan.** Only at the end of Task 12 (after preview rendering) and Task 13 (after dump branch) are `npm run build` invocations needed. Test-only edits don't need a rebuild.
