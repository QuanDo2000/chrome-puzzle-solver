# Slitherlink ("Loop") Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Slitherlink as the 7th puzzle type the extension solves, with full parity (Detect, Solve, Hint, Loop, Apply, preview, Dump, caching, auto-solve-on-detect with live mistake highlighting). The puzzles-mobile.com URL path is `/loop/` but the puzzle is named `slitherlink` everywhere in code to avoid colliding with the existing Loop button feature (`loopHandler` in `content.js`).

**Architecture:** A new `SlitherlinkSolver` class in `solver.js` runs propagation (clue forcing + vertex forcing) to a fixpoint, then union-find-tracked subloop-prevention plus most-constrained backtracking. The puzzle is edge-encoded exactly like Galaxies (`cellHorizontalStatus` `(H+1)×W` and `cellVerticalStatus` `H×(W+1)`, value `1` = line on the page), so the handler / MAIN-world / content wiring mirrors the existing Galaxies path. The diff for the auto-solve overlay is **edge-based** (the one deviation from the existing "ring cells" pattern — Slitherlink mistakes live on edges, not cells).

**Tech Stack:** Vanilla ES2020 JavaScript, Chrome MV3, `node:test` for tests, `jj` (Jujutsu) for version control — **never plain `git`**.

**Conventions:**
- This repo is a colocated Jujutsu/git workspace. Commit with `jj commit -m "msg"`. Do NOT run `git commit`/`git add`/etc.
- After editing `manifest.json`, `background.js`, `main-world.js`, `content.js`, `handler.js`, `solver.js`, or `solver.worker.js`, run `npm run build`. Edits to tests/docs do not need a rebuild.
- `npm run lint`, `npm run typecheck`, `npm test` must all pass before each commit.
- Every commit message ends with a blank line then `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

**Page encoding** (from live recon of `/loop/random/5x5-normal`):
- `window.Game.task` — 2D `int[H][W]`. `-1` = no clue; `0/1/2/3` = clue (count of loop edges around that cell).
- `window.Game.currentState.cellHorizontalStatus` — `(H+1) × W`, `0` = empty, `1` = line.
- `window.Game.currentState.cellVerticalStatus` — `H × (W+1)`, `0` = empty, `1` = line.
- Render functions: `drawCurrentState`, `redraw`, `draw`.

---

## Cross-task invariants

These must stay consistent. Re-read them before each task.

- **Edge encoding (solver internal):** `0 = UNKNOWN`, `1 = LINE`, `2 = EMPTY`. Chosen so `1` matches the page's LINE encoding and the solver→apply translation is a direct write of `1` for LINE, `0` for everything else.
- **Edge encoding (emit/apply):** `0 = empty`, `1 = line`. The solver's `solve()` and `getHint()` translate UNKNOWN/EMPTY → `0` and LINE → `1` before returning, so callers never see the internal `2`.
- **Edge indexing:** For cell `(r, c)` in an `H × W` grid:
  - top edge = `H[r][c]`, bottom = `H[r+1][c]`, left = `V[r][c]`, right = `V[r][c+1]`.
  - `H` has shape `(H+1) × W` (indices `r ∈ 0..H`, `c ∈ 0..W-1`).
  - `V` has shape `H × (W+1)` (indices `r ∈ 0..H-1`, `c ∈ 0..W`).
- **Flat edge ids (internal):** H edges are ids `0 .. (H+1)*W - 1`, V edges are ids `(H+1)*W .. (H+1)*W + H*(W+1) - 1`. Helpers `_hIdx(r,c)`, `_vIdx(r,c)` compute these.
- **Dot ids:** `dotId(r, c) = r * (W+1) + c`, total `(H+1)*(W+1)` dots.
- **Hint shape (solver → content):** `{ type: 'slitherlink', edges: [{orientation: 'h'|'v', r, c}, ...], count: number }`. Always contains at least one edge entry when returned non-null.
- **Solve result shape (solver):** `{ solved: boolean, horizontal: number[H+1][W] | null, vertical: number[H][W+1] | null, error?: string }` where each cell is `0` or `1`.
- **Worker payload (`extraData`):** `{ rows, cols, task, initialGrid?: { horizontal, vertical } }`. Type discriminator is `type: 'slitherlink'`.
- **Diff shape (slitherlink branch only):** `[{orientation: 'h'|'v', r, c}, ...]`. Other puzzle types still return `{row, col}` entries — call sites must dispatch on `puzzleData.type`.

---

## Task 1: Add the slitherlink5x5 test fixture

**Files:**
- Modify: `tests/fixtures/puzzles.js` (append a new fixture before the closing `};`)

- [ ] **Step 1: Add the fixture**

Append this entry to the object exported by `tests/fixtures/puzzles.js`, after the `yinyang6x6` entry (keep the closing `};` intact):

```js
  // 5x5 Slitherlink captured from puzzles-mobile.com/loop/random/5x5-normal
  // on 2026-05-22. task: -1=no clue, 0/1/2/3=count of loop edges around cell.
  slitherlink5x5: {
    rows: 5,
    cols: 5,
    task: [
      [-1, -1, -1, -1,  3],
      [-1,  2, -1, -1, -1],
      [-1,  2, -1,  0,  3],
      [-1,  1, -1, -1,  3],
      [-1,  2,  3,  1, -1],
    ],
  },
```

- [ ] **Step 2: Verify the file still parses**

Run: `node -e "const p=require('./tests/fixtures/puzzles.js'); console.log('slitherlink5x5 rows:', p.slitherlink5x5.rows)"`
Expected: `slitherlink5x5 rows: 5`

- [ ] **Step 3: Commit**

```bash
jj commit -m "test(slitherlink): add 5x5 puzzle fixture

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: SlitherlinkSolver — constructor, edge model, trail helpers

**Files:**
- Modify: `solver.js` — add the `SlitherlinkSolver` class **after** the `YinYangSolver` class (which ends around line 4440 — find by grep), immediately before `function _shikakuDiff(...)` (around line 4445). Update the `module.exports` block at the bottom.
- Modify: `tests/solver.test.js` — extend the destructured require to include `SlitherlinkSolver`.

`SlitherlinkSolver` works entirely in edge encoding (`0=UNKNOWN, 1=LINE, 2=EMPTY`). The constructor stores edges in two flat `Uint8Array`s and maintains per-dot incidence counters incrementally so propagation runs over O(1)-update state.

- [ ] **Step 1: Write the failing test**

Extend the top of `tests/solver.test.js` (line 3 currently destructures the existing solvers) to add `SlitherlinkSolver`:

```js
const { NonogramSolver, AquariumSolver, GalaxiesSolver, BinairoSolver, ShikakuSolver, YinYangSolver, SlitherlinkSolver, computePuzzleDiff } = require('../solver.js');
```

Add these tests to `tests/solver.test.js`:

```js
test('SlitherlinkSolver: constructor builds H/V edge arrays of the right shape', () => {
  const task = [
    [-1, -1, -1, -1,  3],
    [-1,  2, -1, -1, -1],
    [-1,  2, -1,  0,  3],
    [-1,  1, -1, -1,  3],
    [-1,  2,  3,  1, -1],
  ];
  const s = new SlitherlinkSolver({ width: 5, height: 5, task });
  assert.equal(s.width, 5);
  assert.equal(s.height, 5);
  // (H+1) * W horizontal slots, H * (W+1) vertical slots.
  assert.equal(s.H.length, 6 * 5);
  assert.equal(s.V.length, 5 * 6);
  // All edges UNKNOWN (0) initially.
  for (let i = 0; i < s.H.length; i++) assert.equal(s.H[i], 0);
  for (let i = 0; i < s.V.length; i++) assert.equal(s.V[i], 0);
  // Dot counters all zero.
  for (let i = 0; i < s.lineCount.length; i++) assert.equal(s.lineCount[i], 0);
  for (let i = 0; i < s.unknownCount.length; i++) {
    // Every dot has between 2 and 4 incident edges (corner=2, edge=3, interior=4).
    assert.ok(s.unknownCount[i] >= 2 && s.unknownCount[i] <= 4);
  }
});

test('SlitherlinkSolver: _setEdge LINE/EMPTY updates dot counters and trails', () => {
  const s = new SlitherlinkSolver({
    width: 2, height: 2,
    task: [[-1, -1], [-1, -1]],
  });
  // Pick H[0][0] (top edge of top-left cell): joins dot (0,0) and dot (0,1).
  const mark = s.trail.length;
  const id = s._hIdx(0, 0);
  const d00 = s._dotId(0, 0);
  const d01 = s._dotId(0, 1);
  const u00Before = s.unknownCount[d00];
  const u01Before = s.unknownCount[d01];
  assert.equal(s._setEdge(id, 'H', 1), true);  // assign LINE
  assert.equal(s.H[id], 1);
  assert.equal(s.lineCount[d00], 1);
  assert.equal(s.lineCount[d01], 1);
  assert.equal(s.unknownCount[d00], u00Before - 1);
  assert.equal(s.unknownCount[d01], u01Before - 1);
  s._rollback(mark);
  assert.equal(s.H[id], 0);
  assert.equal(s.lineCount[d00], 0);
  assert.equal(s.lineCount[d01], 0);
  assert.equal(s.unknownCount[d00], u00Before);
  assert.equal(s.unknownCount[d01], u01Before);
});

test('SlitherlinkSolver: constructor rejects invalid dimensions', () => {
  assert.throws(() => new SlitherlinkSolver({ width: 0, height: 3, task: [] }));
  assert.throws(() => new SlitherlinkSolver({ width: 3, height: 3, task: 'nope' }));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-name-pattern='SlitherlinkSolver: '`
Expected: FAIL with `SlitherlinkSolver is not defined`.

- [ ] **Step 3: Write the implementation**

Locate the end of the `YinYangSolver` class with `grep -n "^}" solver.js | head` (the YinYangSolver class ends with a `}` on its own line). Insert this class **immediately after** the `YinYangSolver` class's closing brace, and **before** the `function _shikakuDiff(...)` line (around line 4445):

```js
/**
 * Slitherlink ("Loop") solver. Edge-variable propagation + backtracking,
 * modeled on GalaxiesSolver's trail-based undo. See CLAUDE.md "Slitherlink
 * encoding" for the design notes.
 *
 * Edge encoding (internal): 0=UNKNOWN, 1=LINE, 2=EMPTY. Chosen so 1 maps
 * straight onto the page's `cellHorizontalStatus`/`cellVerticalStatus`
 * encoding for apply.
 *
 * Edge indexing: horizontal edge H[r][c] (r in 0..H, c in 0..W-1) joins
 * dot (r,c) and dot (r,c+1). Vertical edge V[r][c] (r in 0..H-1, c in
 * 0..W) joins dot (r,c) and dot (r+1,c). Flat ids:
 *   _hIdx(r, c) = r * W + c
 *   _vIdx(r, c) = r * (W + 1) + c
 *   _dotId(r, c) = r * (W + 1) + c
 */
class SlitherlinkSolver {
  /**
   * @param {{
   *   width: number,
   *   height: number,
   *   task: number[][],
   *   initialState?: { horizontal: number[][], vertical: number[][] },
   *   maxMs?: number,
   * }} opts
   */
  constructor({ width, height, task, initialState, maxMs }) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new Error('SlitherlinkSolver: width/height must be positive integers');
    }
    if (!Array.isArray(task)) {
      throw new Error('SlitherlinkSolver: task must be an array');
    }
    this.width = width;
    this.height = height;
    this.task = task.map(row => (Array.isArray(row) ? row.slice() : []));
    this.maxMs = maxMs | 0;
    this._startedAt = 0;
    this._timedOut = false;

    const W = width, H = height;
    // (H+1) * W horizontal edge slots; H * (W+1) vertical edge slots.
    this.H = new Uint8Array((H + 1) * W);
    this.V = new Uint8Array(H * (W + 1));

    // Trail entries: pack `(kind << 25) | (oldValue << 24) | idx` where
    // kind 0 = horizontal, 1 = vertical, oldValue in {0,1,2}, idx fits in
    // 24 bits (more than enough for grids up to ~4000 edges).
    this.trail = [];

    // Per-dot incidence counters. Maintained incrementally so propagation
    // never has to recount.
    const D = (H + 1) * (W + 1);
    this.lineCount = new Int16Array(D);
    this.unknownCount = new Int16Array(D);
    // Initialize unknownCount with each dot's actual edge count (corners=2,
    // borders=3, interior=4).
    for (let r = 0; r <= H; r++) {
      for (let c = 0; c <= W; c++) {
        let cnt = 0;
        if (c > 0) cnt++;            // H[r][c-1]
        if (c < W) cnt++;            // H[r][c]
        if (r > 0) cnt++;            // V[r-1][c]
        if (r < H) cnt++;            // V[r][c]
        this.unknownCount[r * (W + 1) + c] = cnt;
      }
    }

    // Apply initialState if provided. We DO go through _setEdge so dot
    // counters stay consistent; we just discard the trail afterwards (the
    // initial state is the baseline, not something to roll back).
    if (initialState) {
      const ih = initialState.horizontal || [];
      const iv = initialState.vertical || [];
      for (let r = 0; r <= H; r++) {
        const row = ih[r] || [];
        for (let c = 0; c < W; c++) {
          if (row[c] === 1) this._setEdge(this._hIdx(r, c), 'H', 1);
        }
      }
      for (let r = 0; r < H; r++) {
        const row = iv[r] || [];
        for (let c = 0; c <= W; c++) {
          if (row[c] === 1) this._setEdge(this._vIdx(r, c), 'V', 1);
        }
      }
      this.trail.length = 0;  // baseline — never roll back through it
    }
  }

  _hIdx(r, c) { return r * this.width + c; }
  _vIdx(r, c) { return r * (this.width + 1) + c; }
  _dotId(r, c) { return r * (this.width + 1) + c; }

  // Returns [u, v] dot ids that an edge joins.
  _edgeEndpoints(kind, idx) {
    const W = this.width;
    if (kind === 'H') {
      // H[r][c] joins (r, c) and (r, c+1).
      const r = (idx / W) | 0;
      const c = idx - r * W;
      return [this._dotId(r, c), this._dotId(r, c + 1)];
    } else {
      // V[r][c] joins (r, c) and (r+1, c).
      const stride = W + 1;
      const r = (idx / stride) | 0;
      const c = idx - r * stride;
      return [this._dotId(r, c), this._dotId(r + 1, c)];
    }
  }

  // Trailed write. Returns false if the new value would conflict with an
  // existing assignment (i.e., the edge is already set to a different
  // non-UNKNOWN value). UNKNOWN→UNKNOWN is a no-op and returns true.
  _setEdge(idx, kind, val) {
    const arr = kind === 'H' ? this.H : this.V;
    const old = arr[idx];
    if (old === val) return true;
    if (old !== 0) return false;  // attempted to overwrite an existing value
    const kindBit = kind === 'H' ? 0 : 1;
    this.trail.push((kindBit << 25) | (old << 24) | idx);
    arr[idx] = val;
    // Update endpoint counters.
    const [u, v] = this._edgeEndpoints(kind, idx);
    this.unknownCount[u]--;
    this.unknownCount[v]--;
    if (val === 1) {
      this.lineCount[u]++;
      this.lineCount[v]++;
    }
    return true;
  }

  _rollback(mark) {
    while (this.trail.length > mark) {
      const e = this.trail.pop();
      const idx = e & 0xFFFFFF;
      const old = (e >> 24) & 1;
      const kindBit = (e >> 25) & 1;
      const kind = kindBit === 0 ? 'H' : 'V';
      const arr = kind === 'H' ? this.H : this.V;
      const cur = arr[idx];
      arr[idx] = old;
      const [u, v] = this._edgeEndpoints(kind, idx);
      this.unknownCount[u]++;
      this.unknownCount[v]++;
      if (cur === 1) {
        this.lineCount[u]--;
        this.lineCount[v]--;
      }
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

Extend the bottom-of-file export tail (around line 4546):

```js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { NonogramSolver, AquariumSolver, GalaxiesSolver, BinairoSolver, ShikakuSolver, YinYangSolver, SlitherlinkSolver, computePuzzleDiff };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --test-name-pattern='SlitherlinkSolver: '`
Expected: 3 passing tests.

- [ ] **Step 5: Commit**

```bash
npm run lint && npm run typecheck && jj commit -m "feat(slitherlink): SlitherlinkSolver constructor and edge model

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Clue propagation (`_propagateClues`)

**Files:**
- Modify: `solver.js` — add methods to `SlitherlinkSolver`
- Modify: `tests/solver.test.js`

For every clued cell with clue `k`, look at its 4 edges. Count `m` (already LINE) and `n` (still UNKNOWN). Rules:
- `m > k` → contradiction.
- `m + n < k` → contradiction (not enough edges left to reach `k`).
- `m == k` → force all remaining UNKNOWN edges of this cell to EMPTY.
- `m + n == k` → force all UNKNOWN edges to LINE.
- Otherwise: no deduction this round.

- [ ] **Step 1: Write the failing test**

Add to `tests/solver.test.js`:

```js
test('SlitherlinkSolver: _propagateClues forces EMPTY when m==clue', () => {
  // Clue 0 at (0,0): all 4 edges of that cell must be EMPTY.
  const s = new SlitherlinkSolver({
    width: 2, height: 2,
    task: [[0, -1], [-1, -1]],
  });
  const onChange = () => {};
  assert.equal(s._propagateClues(onChange), true);
  // top H[0][0], bottom H[1][0], left V[0][0], right V[0][1] all EMPTY.
  assert.equal(s.H[s._hIdx(0, 0)], 2);
  assert.equal(s.H[s._hIdx(1, 0)], 2);
  assert.equal(s.V[s._vIdx(0, 0)], 2);
  assert.equal(s.V[s._vIdx(0, 1)], 2);
});

test('SlitherlinkSolver: _propagateClues forces LINE when m+n==clue', () => {
  // Clue 3 at corner (0,0): all available edges = LINE (only 2 in-grid
  // edges for top-left cell of a 1x1 has clue context... use 2x2). For
  // 2x2 with clue 3 at (0,0), there are 4 incident edges, so m+n==4 not 3.
  // Use clue 2 at (0,0) with one neighbour pre-EMPTY: forces the other 2.
  const s = new SlitherlinkSolver({
    width: 2, height: 2,
    task: [[2, -1], [-1, -1]],
  });
  // Pre-set top edge to EMPTY, left edge to EMPTY.
  s._setEdge(s._hIdx(0, 0), 'H', 2);
  s._setEdge(s._vIdx(0, 0), 'V', 2);
  const onChange = () => {};
  assert.equal(s._propagateClues(onChange), true);
  // bottom + right must now both be LINE.
  assert.equal(s.H[s._hIdx(1, 0)], 1);
  assert.equal(s.V[s._vIdx(0, 1)], 1);
});

test('SlitherlinkSolver: _propagateClues reports contradiction when m > clue', () => {
  // Clue 1 at (0,0), but two of its edges already LINE.
  const s = new SlitherlinkSolver({
    width: 2, height: 2,
    task: [[1, -1], [-1, -1]],
  });
  s._setEdge(s._hIdx(0, 0), 'H', 1);
  s._setEdge(s._vIdx(0, 0), 'V', 1);
  assert.equal(s._propagateClues(() => {}), false);
});

test('SlitherlinkSolver: _propagateClues reports contradiction when m+n < clue', () => {
  // Clue 3 at (0,0), with 2 edges already EMPTY: only 2 edges left, can't
  // reach 3.
  const s = new SlitherlinkSolver({
    width: 2, height: 2,
    task: [[3, -1], [-1, -1]],
  });
  s._setEdge(s._hIdx(0, 0), 'H', 2);
  s._setEdge(s._vIdx(0, 0), 'V', 2);
  assert.equal(s._propagateClues(() => {}), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-name-pattern='SlitherlinkSolver: _propagateClues'`
Expected: FAIL with `s._propagateClues is not a function`.

- [ ] **Step 3: Write the implementation**

Add to the `SlitherlinkSolver` class body:

```js
  // Return an array of 4 {kind, idx} entries describing cell (r,c)'s edges
  // in a fixed order: top, bottom, left, right.
  _cellEdges(r, c) {
    return [
      { kind: 'H', idx: this._hIdx(r, c) },         // top
      { kind: 'H', idx: this._hIdx(r + 1, c) },     // bottom
      { kind: 'V', idx: this._vIdx(r, c) },         // left
      { kind: 'V', idx: this._vIdx(r, c + 1) },     // right
    ];
  }

  // Clue forcing rule. Returns false on contradiction; calls onChange()
  // whenever it forces an edge.
  _propagateClues(onChange) {
    const H = this.height, W = this.width;
    for (let r = 0; r < H; r++) {
      const row = this.task[r] || [];
      for (let c = 0; c < W; c++) {
        const clue = row[c];
        if (clue === undefined || clue < 0 || clue > 4) continue;
        const edges = this._cellEdges(r, c);
        let m = 0, n = 0;
        for (const e of edges) {
          const v = (e.kind === 'H' ? this.H : this.V)[e.idx];
          if (v === 1) m++;
          else if (v === 0) n++;
        }
        if (m > clue) return false;
        if (m + n < clue) return false;
        if (m === clue && n > 0) {
          // All UNKNOWN edges → EMPTY.
          for (const e of edges) {
            const arr = e.kind === 'H' ? this.H : this.V;
            if (arr[e.idx] === 0) {
              if (!this._setEdge(e.idx, e.kind, 2)) return false;
              onChange();
            }
          }
        } else if (m + n === clue && n > 0) {
          // All UNKNOWN edges → LINE.
          for (const e of edges) {
            const arr = e.kind === 'H' ? this.H : this.V;
            if (arr[e.idx] === 0) {
              if (!this._setEdge(e.idx, e.kind, 1)) return false;
              onChange();
            }
          }
        }
      }
    }
    return true;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --test-name-pattern='SlitherlinkSolver: _propagateClues'`
Expected: 4 passing tests.

- [ ] **Step 5: Commit**

```bash
npm run lint && npm run typecheck && jj commit -m "feat(slitherlink): clue forcing propagation

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Vertex propagation (`_propagateVertices`)

**Files:**
- Modify: `solver.js` — add methods to `SlitherlinkSolver`
- Modify: `tests/solver.test.js`

Every dot in a valid Slitherlink has loop-degree 0 or 2 (a closed loop has no dead ends and no junctions). With `m = lineCount[dot]` and `n = unknownCount[dot]`:
- `m > 2` → contradiction.
- `m == 2` → all remaining UNKNOWN incident edges → EMPTY.
- `m == 1 && n == 0` → contradiction (degree 1 is illegal).
- `m == 1 && n == 1` → the unique UNKNOWN edge → LINE (closes the path).
- `m == 0 && n == 1` → the unique UNKNOWN edge → EMPTY (a dot with only one possible edge can't have degree 2; it must be degree 0).

- [ ] **Step 1: Write the failing test**

Add to `tests/solver.test.js`:

```js
test('SlitherlinkSolver: _propagateVertices forces EMPTY when m==2', () => {
  // 2x2 grid, dot (1,1) (center). Set H[1][0] and V[1][1] both LINE
  // (these are two of dot (1,1)'s 4 incident edges). The other two
  // (H[1][1] and V[0][1]) must be forced EMPTY.
  const s = new SlitherlinkSolver({
    width: 2, height: 2, task: [[-1, -1], [-1, -1]],
  });
  s._setEdge(s._hIdx(1, 0), 'H', 1);
  s._setEdge(s._vIdx(1, 1), 'V', 1);
  assert.equal(s._propagateVertices(() => {}), true);
  assert.equal(s.H[s._hIdx(1, 1)], 2);
  assert.equal(s.V[s._vIdx(0, 1)], 2);
});

test('SlitherlinkSolver: _propagateVertices forces LINE when m==1 && n==1', () => {
  // Corner dot (0,0) has only 2 incident edges: H[0][0] and V[0][0].
  // Set H[0][0] LINE; V[0][0] must be forced LINE.
  const s = new SlitherlinkSolver({
    width: 2, height: 2, task: [[-1, -1], [-1, -1]],
  });
  s._setEdge(s._hIdx(0, 0), 'H', 1);
  assert.equal(s._propagateVertices(() => {}), true);
  assert.equal(s.V[s._vIdx(0, 0)], 1);
});

test('SlitherlinkSolver: _propagateVertices forces EMPTY when m==0 && n==1', () => {
  // Corner dot (0,0). Set H[0][0] EMPTY — V[0][0] becomes the only UNKNOWN
  // edge with m=0, so it must be EMPTY too (degree 0).
  const s = new SlitherlinkSolver({
    width: 2, height: 2, task: [[-1, -1], [-1, -1]],
  });
  s._setEdge(s._hIdx(0, 0), 'H', 2);
  assert.equal(s._propagateVertices(() => {}), true);
  assert.equal(s.V[s._vIdx(0, 0)], 2);
});

test('SlitherlinkSolver: _propagateVertices reports contradiction when m > 2', () => {
  // Center dot (1,1) of a 2x2: set 3 of its 4 incident edges to LINE.
  const s = new SlitherlinkSolver({
    width: 2, height: 2, task: [[-1, -1], [-1, -1]],
  });
  s._setEdge(s._hIdx(1, 0), 'H', 1);
  s._setEdge(s._hIdx(1, 1), 'H', 1);
  s._setEdge(s._vIdx(1, 1), 'V', 1);
  assert.equal(s._propagateVertices(() => {}), false);
});

test('SlitherlinkSolver: _propagateVertices reports contradiction when m==1 && n==0', () => {
  // Corner dot (0,0). H[0][0]=LINE, V[0][0]=EMPTY -> degree 1, illegal.
  const s = new SlitherlinkSolver({
    width: 2, height: 2, task: [[-1, -1], [-1, -1]],
  });
  s._setEdge(s._hIdx(0, 0), 'H', 1);
  s._setEdge(s._vIdx(0, 0), 'V', 2);
  assert.equal(s._propagateVertices(() => {}), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-name-pattern='SlitherlinkSolver: _propagateVertices'`
Expected: FAIL with `s._propagateVertices is not a function`.

- [ ] **Step 3: Write the implementation**

Add to the `SlitherlinkSolver` class body:

```js
  // Return {kind, idx} entries for the (up to 4) edges incident to dot (r,c).
  _dotEdges(r, c) {
    const H = this.height, W = this.width;
    const out = [];
    if (c > 0) out.push({ kind: 'H', idx: this._hIdx(r, c - 1) });   // left
    if (c < W) out.push({ kind: 'H', idx: this._hIdx(r, c) });       // right
    if (r > 0) out.push({ kind: 'V', idx: this._vIdx(r - 1, c) });   // up
    if (r < H) out.push({ kind: 'V', idx: this._vIdx(r, c) });       // down
    return out;
  }

  // Vertex forcing rule. Returns false on contradiction; calls onChange()
  // whenever it forces an edge.
  _propagateVertices(onChange) {
    const H = this.height, W = this.width;
    for (let r = 0; r <= H; r++) {
      for (let c = 0; c <= W; c++) {
        const dotId = this._dotId(r, c);
        const m = this.lineCount[dotId];
        const n = this.unknownCount[dotId];
        if (m > 2) return false;
        if (m === 1 && n === 0) return false;
        if (m === 2 && n > 0) {
          // All remaining UNKNOWN incident edges → EMPTY.
          for (const e of this._dotEdges(r, c)) {
            const arr = e.kind === 'H' ? this.H : this.V;
            if (arr[e.idx] === 0) {
              if (!this._setEdge(e.idx, e.kind, 2)) return false;
              onChange();
            }
          }
        } else if (m === 1 && n === 1) {
          // The unique UNKNOWN incident edge → LINE.
          for (const e of this._dotEdges(r, c)) {
            const arr = e.kind === 'H' ? this.H : this.V;
            if (arr[e.idx] === 0) {
              if (!this._setEdge(e.idx, e.kind, 1)) return false;
              onChange();
              break;
            }
          }
        } else if (m === 0 && n === 1) {
          // The unique UNKNOWN edge → EMPTY (can't be degree 2 with only
          // one possible incident edge).
          for (const e of this._dotEdges(r, c)) {
            const arr = e.kind === 'H' ? this.H : this.V;
            if (arr[e.idx] === 0) {
              if (!this._setEdge(e.idx, e.kind, 2)) return false;
              onChange();
              break;
            }
          }
        }
      }
    }
    return true;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --test-name-pattern='SlitherlinkSolver: _propagateVertices'`
Expected: 5 passing tests.

- [ ] **Step 5: Commit**

```bash
npm run lint && npm run typecheck && jj commit -m "feat(slitherlink): vertex forcing propagation

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Union-find + subloop check

**Files:**
- Modify: `solver.js` — add methods to `SlitherlinkSolver`
- Modify: `tests/solver.test.js`

When the solver commits an edge to LINE, it's joining the edge's two endpoint dots into the same loop fragment. Tracked naively with union-find, this lets us cheaply detect "this LINE just closed a cycle". A closed cycle is only valid if it consumes every other LINE in the puzzle — otherwise it's a premature subloop.

**DSU consistency under trailed backtracking:** Maintaining incremental union-find under rollback is fiddly (unions don't have a clean inverse without a separate undo log per union). We sidestep this: **rebuild the DSU lazily from scratch** at the two points that need it — the subloop-check call inside `_propagate()` and the search-variable pick inside `_backtrack()`. Rebuild cost is O(total LINE edges), and these calls are rare relative to the per-rule work, so the simpler implementation wins.

- [ ] **Step 1: Write the failing test**

Add to `tests/solver.test.js`:

```js
test('SlitherlinkSolver: _dsuRebuild and _checkSingleLoopComplete accept a single closed loop', () => {
  // 2x2 grid; the perimeter (8 edges, but in 2x2 it's H[0][0..1], H[2][0..1],
  // V[0..1][0], V[0..1][2]) is a single closed loop with 8 edges.
  const s = new SlitherlinkSolver({
    width: 2, height: 2, task: [[-1, -1], [-1, -1]],
  });
  // Perimeter LINE edges.
  s._setEdge(s._hIdx(0, 0), 'H', 1);
  s._setEdge(s._hIdx(0, 1), 'H', 1);
  s._setEdge(s._hIdx(2, 0), 'H', 1);
  s._setEdge(s._hIdx(2, 1), 'H', 1);
  s._setEdge(s._vIdx(0, 0), 'V', 1);
  s._setEdge(s._vIdx(1, 0), 'V', 1);
  s._setEdge(s._vIdx(0, 2), 'V', 1);
  s._setEdge(s._vIdx(1, 2), 'V', 1);
  // All interior edges EMPTY.
  s._setEdge(s._hIdx(1, 0), 'H', 2);
  s._setEdge(s._hIdx(1, 1), 'H', 2);
  s._setEdge(s._vIdx(0, 1), 'V', 2);
  s._setEdge(s._vIdx(1, 1), 'V', 2);
  s._dsuRebuild();
  assert.equal(s._checkSingleLoopComplete(), true);
});

test('SlitherlinkSolver: _checkSingleLoopComplete rejects a premature subloop', () => {
  // 3x3 grid; close the 4 edges around the top-left cell (a 4-edge subloop)
  // and leave the rest UNKNOWN. The check must fail (subloop is incomplete).
  const s = new SlitherlinkSolver({
    width: 3, height: 3, task: [
      [-1, -1, -1],
      [-1, -1, -1],
      [-1, -1, -1],
    ],
  });
  s._setEdge(s._hIdx(0, 0), 'H', 1);
  s._setEdge(s._hIdx(1, 0), 'H', 1);
  s._setEdge(s._vIdx(0, 0), 'V', 1);
  s._setEdge(s._vIdx(0, 1), 'V', 1);
  s._dsuRebuild();
  assert.equal(s._cycleClosed, true);    // a cycle was detected during rebuild
  assert.equal(s._checkSingleLoopComplete(), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-name-pattern='SlitherlinkSolver: _dsuRebuild'` and `node --test --test-name-pattern='SlitherlinkSolver: _checkSingleLoopComplete'`
Expected: FAIL with `s._dsuRebuild is not a function`.

- [ ] **Step 3: Write the implementation**

Add to the `SlitherlinkSolver` class body:

```js
  _dsuMakeArrays() {
    const D = (this.height + 1) * (this.width + 1);
    if (!this._dsuParent || this._dsuParent.length !== D) {
      this._dsuParent = new Int32Array(D);
      this._dsuRank = new Int8Array(D);
    }
  }

  _dsuFind(x) {
    const p = this._dsuParent;
    let r = x;
    while (p[r] !== r) r = p[r];
    // Path compression.
    while (p[x] !== r) { const next = p[x]; p[x] = r; x = next; }
    return r;
  }

  // Rebuild the DSU over all currently-LINE edges. Sets `_cycleClosed` true
  // iff at least one LINE edge's endpoints were already in the same
  // component before that edge was unioned in (i.e., a cycle exists).
  // O(E α(D)) — cheap.
  _dsuRebuild() {
    this._dsuMakeArrays();
    const p = this._dsuParent;
    const rank = this._dsuRank;
    for (let i = 0; i < p.length; i++) { p[i] = i; rank[i] = 0; }
    this._cycleClosed = false;
    const H = this.height, W = this.width;
    // Horizontal LINE edges.
    for (let r = 0; r <= H; r++) {
      for (let c = 0; c < W; c++) {
        if (this.H[this._hIdx(r, c)] !== 1) continue;
        const [u, v] = this._edgeEndpoints('H', this._hIdx(r, c));
        const ru = this._dsuFind(u), rv = this._dsuFind(v);
        if (ru === rv) { this._cycleClosed = true; continue; }
        if (rank[ru] < rank[rv]) p[ru] = rv;
        else if (rank[ru] > rank[rv]) p[rv] = ru;
        else { p[rv] = ru; rank[ru]++; }
      }
    }
    // Vertical LINE edges.
    for (let r = 0; r < H; r++) {
      for (let c = 0; c <= W; c++) {
        if (this.V[this._vIdx(r, c)] !== 1) continue;
        const [u, v] = this._edgeEndpoints('V', this._vIdx(r, c));
        const ru = this._dsuFind(u), rv = this._dsuFind(v);
        if (ru === rv) { this._cycleClosed = true; continue; }
        if (rank[ru] < rank[rv]) p[ru] = rv;
        else if (rank[ru] > rank[rv]) p[rv] = ru;
        else { p[rv] = ru; rank[ru]++; }
      }
    }
  }

  // True iff (a) every clue is satisfied exactly, (b) no UNKNOWN edges
  // remain, (c) every dot has degree 0 or 2, and (d) all LINE edges form a
  // single connected component. Assumes _dsuRebuild() has just been called.
  _checkSingleLoopComplete() {
    const H = this.height, W = this.width;
    // (a) clue check.
    for (let r = 0; r < H; r++) {
      const row = this.task[r] || [];
      for (let c = 0; c < W; c++) {
        const clue = row[c];
        if (clue === undefined || clue < 0 || clue > 4) continue;
        const edges = this._cellEdges(r, c);
        let m = 0;
        for (const e of edges) {
          if ((e.kind === 'H' ? this.H : this.V)[e.idx] === 1) m++;
        }
        if (m !== clue) return false;
      }
    }
    // (b) no UNKNOWN edges.
    for (let i = 0; i < this.H.length; i++) if (this.H[i] === 0) return false;
    for (let i = 0; i < this.V.length; i++) if (this.V[i] === 0) return false;
    // (c) every dot is degree 0 or 2.
    for (let i = 0; i < this.lineCount.length; i++) {
      const m = this.lineCount[i];
      if (m !== 0 && m !== 2) return false;
    }
    // (d) all LINE edges share one component.
    let totalLines = 0;
    let firstRoot = -1;
    for (let r = 0; r <= H; r++) {
      for (let c = 0; c < W; c++) {
        if (this.H[this._hIdx(r, c)] !== 1) continue;
        totalLines++;
        const [u] = this._edgeEndpoints('H', this._hIdx(r, c));
        const ru = this._dsuFind(u);
        if (firstRoot === -1) firstRoot = ru;
        else if (firstRoot !== ru) return false;
      }
    }
    for (let r = 0; r < H; r++) {
      for (let c = 0; c <= W; c++) {
        if (this.V[this._vIdx(r, c)] !== 1) continue;
        totalLines++;
        const [u] = this._edgeEndpoints('V', this._vIdx(r, c));
        const ru = this._dsuFind(u);
        if (firstRoot === -1) firstRoot = ru;
        else if (firstRoot !== ru) return false;
      }
    }
    // Must have at least one LINE edge (the empty board is not a solution).
    return totalLines > 0;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --test-name-pattern='SlitherlinkSolver: _dsuRebuild'` and `node --test --test-name-pattern='SlitherlinkSolver: _checkSingleLoopComplete'`
Expected: both passing.

- [ ] **Step 5: Commit**

```bash
npm run lint && npm run typecheck && jj commit -m "feat(slitherlink): union-find and single-loop completion check

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `solve()`, backtracking, solution cache, maxMs

**Files:**
- Modify: `solver.js` — add `propagate`, `solve`, `_backtrack`, static cache + `clearSolutionCache`, `_cacheKey`, `_storeInCache`
- Modify: `tests/solver.test.js`

`propagate()` iterates the two local rules to a fixpoint. After every fixpoint where a LINE edge has been added, run `_dsuRebuild()`; if `_cycleClosed` is true, run `_checkSingleLoopComplete()` — if it fails, the closure was a premature subloop, so the current branch is dead.

`solve()` runs propagate; if any UNKNOWN edges remain, pick the most-constrained UNKNOWN edge (see heuristic below) and branch LINE first, EMPTY second. `maxMs` checked between branches and inside the propagation loop.

**Variable-pick heuristic:** Walk the H array then the V array; for each UNKNOWN edge, score it by `max(lineCount[u], lineCount[v]) - min(unknownCount[u], unknownCount[v])` (higher is more constrained). Take the highest-scoring edge. Simple, deterministic, and biased toward edges adjacent to dots that are already partially committed.

- [ ] **Step 1: Write the failing test**

Add to `tests/solver.test.js`:

```js
test('SlitherlinkSolver: solves the 5x5 fixture', () => {
  SlitherlinkSolver.clearSolutionCache();
  const p = fixtures.slitherlink5x5;
  const s = new SlitherlinkSolver({ width: p.cols, height: p.rows, task: p.task });
  s.maxMs = 5000;
  const result = s.solve();
  assert.equal(result.solved, true);
  // Shape checks.
  assert.equal(result.horizontal.length, p.rows + 1);
  assert.equal(result.horizontal[0].length, p.cols);
  assert.equal(result.vertical.length, p.rows);
  assert.equal(result.vertical[0].length, p.cols + 1);
  // Every entry 0 or 1.
  for (const row of result.horizontal) for (const v of row) assert.ok(v === 0 || v === 1);
  for (const row of result.vertical)   for (const v of row) assert.ok(v === 0 || v === 1);
  // Every clue is satisfied exactly.
  for (let r = 0; r < p.rows; r++) {
    for (let c = 0; c < p.cols; c++) {
      const clue = p.task[r][c];
      if (clue < 0) continue;
      const m = result.horizontal[r][c] + result.horizontal[r + 1][c]
              + result.vertical[r][c] + result.vertical[r][c + 1];
      assert.equal(m, clue, `clue at (${r},${c})=${clue} but got ${m}`);
    }
  }
  SlitherlinkSolver.clearSolutionCache();
});

test('SlitherlinkSolver: caches the second call', () => {
  SlitherlinkSolver.clearSolutionCache();
  const p = fixtures.slitherlink5x5;
  let propCalls = 0;
  const s1 = new SlitherlinkSolver({ width: p.cols, height: p.rows, task: p.task });
  s1.maxMs = 5000;
  s1.solve();
  // Second call should hit the cache before propagate() runs even once.
  const s2 = new SlitherlinkSolver({ width: p.cols, height: p.rows, task: p.task });
  const orig = s2.propagate.bind(s2);
  s2.propagate = function (...args) { propCalls++; return orig(...args); };
  const r2 = s2.solve();
  assert.equal(r2.solved, true);
  assert.equal(propCalls, 0, 'cached solve should not call propagate()');
  SlitherlinkSolver.clearSolutionCache();
});

test('SlitherlinkSolver: maxMs=1 bails within 500ms', () => {
  // A large blank board would otherwise search for a long time.
  const task = Array.from({ length: 10 }, () => new Array(10).fill(-1));
  const s = new SlitherlinkSolver({ width: 10, height: 10, task });
  s.maxMs = 1;
  const t0 = Date.now();
  const r = s.solve();
  const dt = Date.now() - t0;
  assert.ok(dt < 500, `solve must bail within 500ms; took ${dt}ms`);
  if (!r.solved) assert.equal(r.error, 'timed out');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-name-pattern='SlitherlinkSolver: solves the 5x5'`
Expected: FAIL with `s.solve is not a function` / `SlitherlinkSolver.clearSolutionCache is not a function`.

- [ ] **Step 3: Write the implementation**

Add to the `SlitherlinkSolver` class body:

```js
  // Iterate clue + vertex rules to a fixpoint. After each pass that
  // added a LINE edge, rebuild the DSU; if a cycle closed, only accept it
  // when the whole puzzle is complete (otherwise it's a subloop).
  propagate() {
    let changed = true;
    let anyLineAddedSinceRebuild = false;
    while (changed) {
      if (this._budgetExceeded()) return false;
      changed = false;
      const onChange = (kind) => {
        changed = true;
        if (kind === 'line') anyLineAddedSinceRebuild = true;
      };
      // We don't actually know whether a forced edge was LINE vs EMPTY from
      // the rule functions, so just rebuild after each fixpoint pass that
      // ran any propagator. (Cheap: O(E α).)
      const onAnyChange = () => { changed = true; anyLineAddedSinceRebuild = true; };
      if (!this._propagateClues(onAnyChange)) return false;
      if (!this._propagateVertices(onAnyChange)) return false;
    }
    // After the fixpoint: rebuild DSU and check for premature subloops.
    if (anyLineAddedSinceRebuild) {
      this._dsuRebuild();
      if (this._cycleClosed) {
        // A cycle closed somewhere. Only valid if the puzzle is complete.
        if (!this._checkSingleLoopComplete()) return false;
      }
    }
    return true;
  }

  // Most-constrained UNKNOWN edge for branching. Returns { kind, idx } or
  // null if no UNKNOWN edges remain.
  _pickEdge() {
    let best = null, bestScore = -1;
    const H = this.height, W = this.width;
    for (let r = 0; r <= H; r++) {
      for (let c = 0; c < W; c++) {
        const idx = this._hIdx(r, c);
        if (this.H[idx] !== 0) continue;
        const [u, v] = this._edgeEndpoints('H', idx);
        const score = Math.max(this.lineCount[u], this.lineCount[v]) * 10
                    - Math.min(this.unknownCount[u], this.unknownCount[v]);
        if (score > bestScore) { bestScore = score; best = { kind: 'H', idx }; }
      }
    }
    for (let r = 0; r < H; r++) {
      for (let c = 0; c <= W; c++) {
        const idx = this._vIdx(r, c);
        if (this.V[idx] !== 0) continue;
        const [u, v] = this._edgeEndpoints('V', idx);
        const score = Math.max(this.lineCount[u], this.lineCount[v]) * 10
                    - Math.min(this.unknownCount[u], this.unknownCount[v]);
        if (score > bestScore) { bestScore = score; best = { kind: 'V', idx }; }
      }
    }
    return best;
  }

  _allEdgesAssigned() {
    for (let i = 0; i < this.H.length; i++) if (this.H[i] === 0) return false;
    for (let i = 0; i < this.V.length; i++) if (this.V[i] === 0) return false;
    return true;
  }

  _emit() {
    const H = this.height, W = this.width;
    const horizontal = [];
    for (let r = 0; r <= H; r++) {
      const row = new Array(W);
      for (let c = 0; c < W; c++) row[c] = this.H[this._hIdx(r, c)] === 1 ? 1 : 0;
      horizontal.push(row);
    }
    const vertical = [];
    for (let r = 0; r < H; r++) {
      const row = new Array(W + 1);
      for (let c = 0; c <= W; c++) row[c] = this.V[this._vIdx(r, c)] === 1 ? 1 : 0;
      vertical.push(row);
    }
    return { horizontal, vertical };
  }

  _backtrack() {
    if (this._budgetExceeded()) return false;
    if (this._allEdgesAssigned()) {
      // Must end with a single loop.
      this._dsuRebuild();
      return this._checkSingleLoopComplete();
    }
    const pick = this._pickEdge();
    if (!pick) {
      // No UNKNOWN edges but _allEdgesAssigned returned false — shouldn't
      // happen, but be safe.
      return false;
    }
    // Try LINE first, then EMPTY.
    for (const val of [1, 2]) {
      if (this._budgetExceeded()) return false;
      const mark = this.trail.length;
      if (!this._setEdge(pick.idx, pick.kind, val)) {
        // Already non-UNKNOWN somehow — bail.
        continue;
      }
      if (this.propagate()) {
        if (this._allEdgesAssigned()) {
          this._dsuRebuild();
          if (this._checkSingleLoopComplete()) return true;
        } else if (this._backtrack()) {
          return true;
        }
      }
      this._rollback(mark);
      if (this._timedOut) return false;
    }
    return false;
  }

  /**
   * @returns {{
   *   solved: boolean,
   *   horizontal: number[][] | null,
   *   vertical: number[][] | null,
   *   error?: string,
   * }}
   */
  solve() {
    const key = this._cacheKey();
    const cached = SlitherlinkSolver._solutionCache.get(key);
    if (cached) {
      return {
        solved: true,
        horizontal: cached.horizontal.map(row => row.slice()),
        vertical: cached.vertical.map(row => row.slice()),
      };
    }

    this._startedAt = Date.now();
    this._timedOut = false;

    if (!this.propagate()) {
      return {
        solved: false, horizontal: null, vertical: null,
        error: this._timedOut ? 'timed out' : 'contradiction on initial propagation',
      };
    }
    if (this._allEdgesAssigned()) {
      this._dsuRebuild();
      if (this._checkSingleLoopComplete()) {
        const out = this._emit();
        this._storeInCache(key, out);
        return { solved: true, horizontal: out.horizontal, vertical: out.vertical };
      }
      return {
        solved: false, horizontal: null, vertical: null,
        error: 'fully-assigned grid is not a valid single loop',
      };
    }
    if (this._backtrack()) {
      const out = this._emit();
      this._storeInCache(key, out);
      return { solved: true, horizontal: out.horizontal, vertical: out.vertical };
    }
    return {
      solved: false, horizontal: null, vertical: null,
      error: this._timedOut ? 'timed out' : 'no solution found',
    };
  }

  static _solutionCache = new Map();
  static _maxSolutionCache = 50;
  static clearSolutionCache() { SlitherlinkSolver._solutionCache.clear(); }

  _cacheKey() {
    // FNV-1a over (width, height, flattened task).
    let h = 0x811c9dc5;
    const mix = (n) => { h ^= n; h = Math.imul(h, 0x01000193) >>> 0; };
    mix(0x4C); // 'L' nameplate (Loop) so slitherlink keys don't collide
    mix(this.width);
    mix(this.height);
    for (let r = 0; r < this.height; r++) {
      const row = this.task[r] || [];
      for (let c = 0; c < this.width; c++) mix((row[c] | 0) + 2);
    }
    return String(h >>> 0);
  }

  _storeInCache(key, out) {
    const m = SlitherlinkSolver._solutionCache;
    if (m.size >= SlitherlinkSolver._maxSolutionCache) {
      m.delete(m.keys().next().value);
    }
    m.set(key, {
      horizontal: out.horizontal.map(row => row.slice()),
      vertical: out.vertical.map(row => row.slice()),
    });
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --test-name-pattern='SlitherlinkSolver: '`
Expected: all SlitherlinkSolver tests pass (including the new 5x5 + cache + maxMs tests).

- [ ] **Step 5: Commit**

```bash
npm run lint && npm run typecheck && jj commit -m "feat(slitherlink): solve, backtracking, solution cache, maxMs

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `getHint(curH, curV)`

**Files:**
- Modify: `solver.js` — add `getHint` to `SlitherlinkSolver`
- Modify: `tests/solver.test.js`

`getHint` constructs a new solver seeded from the current board state (`curH` / `curV`), runs `propagate()` only, and collects every UNKNOWN edge that propagation forced to LINE. Returns a hint object the rest of the pipeline consumes. If propagation deduces nothing, falls back to running `solve()` and returning a single arbitrary LINE edge from the solution that the board doesn't yet have.

- [ ] **Step 1: Write the failing test**

Add to `tests/solver.test.js`:

```js
test('SlitherlinkSolver: getHint returns edges forced by propagation', () => {
  // A near-solved 5x5: provide the full solution minus one LINE edge,
  // and confirm getHint returns that edge.
  SlitherlinkSolver.clearSolutionCache();
  const p = fixtures.slitherlink5x5;
  const full = new SlitherlinkSolver({ width: p.cols, height: p.rows, task: p.task }).solve();
  assert.equal(full.solved, true);

  // Find a LINE edge to "hide" from the board.
  let hideKind = null, hideR = -1, hideC = -1;
  outer: for (let r = 0; r <= p.rows; r++) {
    for (let c = 0; c < p.cols; c++) {
      if (full.horizontal[r][c] === 1) { hideKind = 'h'; hideR = r; hideC = c; break outer; }
    }
  }
  assert.notEqual(hideKind, null);
  const curH = full.horizontal.map(row => row.slice());
  const curV = full.vertical.map(row => row.slice());
  curH[hideR][hideC] = 0;

  const s = new SlitherlinkSolver({ width: p.cols, height: p.rows, task: p.task });
  const hint = s.getHint(curH, curV);
  assert.ok(hint, 'expected a hint');
  assert.equal(hint.type, 'slitherlink');
  assert.ok(Array.isArray(hint.edges));
  assert.ok(hint.edges.length >= 1);
  // The hidden edge must be among the returned hints.
  const hidden = { orientation: 'h', r: hideR, c: hideC };
  assert.ok(
    hint.edges.some(e => e.orientation === hidden.orientation && e.r === hidden.r && e.c === hidden.c),
    'expected hidden edge in hint set',
  );
  SlitherlinkSolver.clearSolutionCache();
});

test('SlitherlinkSolver: getHint falls back to solve when propagation deduces nothing', () => {
  // Blank board: propagation alone forces nothing on most non-trivial
  // puzzles, so getHint must fall back to solve+reveal.
  SlitherlinkSolver.clearSolutionCache();
  const p = fixtures.slitherlink5x5;
  const rows = p.rows, cols = p.cols;
  const curH = Array.from({ length: rows + 1 }, () => new Array(cols).fill(0));
  const curV = Array.from({ length: rows },     () => new Array(cols + 1).fill(0));
  const s = new SlitherlinkSolver({ width: cols, height: rows, task: p.task });
  s.maxMs = 5000;
  const hint = s.getHint(curH, curV);
  assert.ok(hint, 'expected a fallback hint');
  assert.equal(hint.type, 'slitherlink');
  assert.equal(hint.edges.length, 1, 'fallback emits a single edge');
  const e = hint.edges[0];
  assert.ok(e.orientation === 'h' || e.orientation === 'v');
  SlitherlinkSolver.clearSolutionCache();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-name-pattern='SlitherlinkSolver: getHint'`
Expected: FAIL with `s.getHint is not a function`.

- [ ] **Step 3: Write the implementation**

Add to the `SlitherlinkSolver` class body:

```js
  /**
   * Pure-deduction hint. Returns:
   *   { type: 'slitherlink', edges: [{orientation:'h'|'v', r, c}, ...], count }
   * or null if no LINE edges can be added and solve fails. Edges are
   * returned in scan order (rows top-to-bottom, then cols left-to-right;
   * horizontals before verticals).
   *
   * @param {number[][]} curH  (H+1)×W, 0/1
   * @param {number[][]} curV  H×(W+1), 0/1
   */
  getHint(curH, curV) {
    // Build a probe solver from current state.
    const probe = new SlitherlinkSolver({
      width: this.width, height: this.height, task: this.task,
      initialState: { horizontal: curH, vertical: curV },
      maxMs: this.maxMs,
    });
    if (!probe.propagate()) return null;

    const newEdges = [];
    const H = this.height, W = this.width;
    for (let r = 0; r <= H; r++) {
      for (let c = 0; c < W; c++) {
        const v = probe.H[probe._hIdx(r, c)];
        if (v === 1 && (curH[r]?.[c] !== 1)) newEdges.push({ orientation: 'h', r, c });
      }
    }
    for (let r = 0; r < H; r++) {
      for (let c = 0; c <= W; c++) {
        const v = probe.V[probe._vIdx(r, c)];
        if (v === 1 && (curV[r]?.[c] !== 1)) newEdges.push({ orientation: 'v', r, c });
      }
    }
    if (newEdges.length > 0) {
      return { type: 'slitherlink', edges: newEdges, count: newEdges.length };
    }

    // Fallback: solve and reveal one LINE edge the board doesn't have.
    const full = this.solve();
    if (!full.solved) return null;
    for (let r = 0; r <= H; r++) {
      for (let c = 0; c < W; c++) {
        if (full.horizontal[r][c] === 1 && (curH[r]?.[c] !== 1)) {
          return { type: 'slitherlink', edges: [{ orientation: 'h', r, c }], count: 1 };
        }
      }
    }
    for (let r = 0; r < H; r++) {
      for (let c = 0; c <= W; c++) {
        if (full.vertical[r][c] === 1 && (curV[r]?.[c] !== 1)) {
          return { type: 'slitherlink', edges: [{ orientation: 'v', r, c }], count: 1 };
        }
      }
    }
    return null;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --test-name-pattern='SlitherlinkSolver: getHint'`
Expected: both passing.

- [ ] **Step 5: Commit**

```bash
npm run lint && npm run typecheck && jj commit -m "feat(slitherlink): getHint via propagation with solve fallback

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Golden snapshot for the 5×5 fixture

**Files:**
- Modify: `tests/capture.js`
- Modify (auto-generated): `tests/golden.js`
- Modify: `tests/solver.test.js`

- [ ] **Step 1: Write the failing test**

Add to `tests/solver.test.js` (the file already requires `./golden.js` as `golden` and `./fixtures/puzzles.js` as `fixtures`):

```js
test('SlitherlinkSolver: 5x5 fixture matches golden', () => {
  SlitherlinkSolver.clearSolutionCache();
  const p = fixtures.slitherlink5x5;
  const result = new SlitherlinkSolver({ width: p.cols, height: p.rows, task: p.task }).solve();
  assert.deepEqual(
    {
      solved: result.solved,
      horizontal: result.horizontal,
      vertical: result.vertical,
      error: result.error || null,
    },
    golden.slitherlink5x5,
  );
  SlitherlinkSolver.clearSolutionCache();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-name-pattern='SlitherlinkSolver: 5x5 fixture matches golden'`
Expected: FAIL — `golden.slitherlink5x5` is `undefined`.

- [ ] **Step 3: Wire capture.js and regenerate the golden**

In `tests/capture.js`, extend the destructured require (line 7) to include `SlitherlinkSolver`:

```js
const { NonogramSolver, AquariumSolver, GalaxiesSolver, BinairoSolver, ShikakuSolver, YinYangSolver, SlitherlinkSolver } = require('../solver.js');
```

Add the helper next to `solveYinYang`:

```js
function solveSlitherlink(p) {
  SlitherlinkSolver.clearSolutionCache();
  return new SlitherlinkSolver({ width: p.cols, height: p.rows, task: p.task }).solve();
}
```

Add to the `raw` object after `yinyang6x6`:

```js
  slitherlink5x5:    solveSlitherlink(fixtures.slitherlink5x5),
```

Extend the `clean` function to handle the slitherlink result shape — replace it with this version:

```js
function clean(result) {
  if (!result || typeof result !== 'object') return result;
  if ('horizontal' in result && 'vertical' in result) {
    // Slitherlink shape.
    const { solved, horizontal, vertical, error } = result;
    return { solved, horizontal, vertical, error: error || null };
  }
  const { solved, grid, error } = result;
  return { solved, grid, error: error || null };
}
```

Then regenerate:

Run: `npm run capture`
Expected output includes: `slitherlink5x5: solved=true`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --test-name-pattern='SlitherlinkSolver: 5x5 fixture matches golden'`
Expected: PASS.

Also confirm the full test suite still passes:

Run: `npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
npm run lint && npm run typecheck && jj commit -m "test(slitherlink): golden snapshot for the 5x5 fixture

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Worker dispatch

**Files:**
- Modify: `solver.worker.js`

- [ ] **Step 1: Add the dispatch arm**

Extend the `/* global ... */` comment to include `SlitherlinkSolver`:

```js
/* global NonogramSolver, GalaxiesSolver, AquariumSolver, BinairoSolver, ShikakuSolver, YinYangSolver, SlitherlinkSolver */
```

Add a dispatch arm immediately before the final `else` branch (the `NonogramSolver` fallback):

```js
    } else if (type === 'slitherlink' && extraData) {
      const s = new SlitherlinkSolver({
        width: extraData.cols,
        height: extraData.rows,
        task: extraData.task,
        initialState: extraData.initialGrid || null,
      });
      s.maxMs = 30000;
      result = s.solve();
    } else {
```

(`extraData.cols`/`rows` because content.js's `solveExtraData` passes `rows`/`cols` as cell-grid dimensions; the solver's constructor wants `width`/`height` to match the page's `puzzleWidth`/`puzzleHeight` semantics, which are also the cell-grid dimensions for Slitherlink.)

- [ ] **Step 2: Verify the worker file parses and lint passes**

Run: `node -e "require('./solver.js'); console.log('solver.js OK')"`
Run: `npm run lint`
Expected: lint passes.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: completes without error.

- [ ] **Step 4: Commit**

```bash
jj commit -m "feat(slitherlink): worker dispatch arm

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: MAIN-world read/apply functions

**Files:**
- Modify: `main-world.js`

Three functions modeled on `readGalaxiesData` / `readGalaxiesState` / `applyGalaxiesState`. They're serialized via `fn.toString()` into the page — no outer-scope helpers, no top-level DOM access. Each helper is nested inside its parent function.

- [ ] **Step 1: Add `readSlitherlinkData`, `readSlitherlinkState`, `applySlitherlinkState`**

Add these three functions to `main-world.js`. Place them after `applyYinYangState` (around line 643):

```js
function readSlitherlinkData() {
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

function readSlitherlinkState(rows, cols) {
  try {
    if (!window.Game || !window.Game.currentState) return null;
    var hs = window.Game.currentState.cellHorizontalStatus;
    var vs = window.Game.currentState.cellVerticalStatus;
    if (!Array.isArray(hs) || !Array.isArray(vs)) return null;
    var horizontal = [];
    for (var hr = 0; hr <= rows; hr++) {
      var row = hs[hr] || [];
      horizontal[hr] = [];
      for (var hc = 0; hc < cols; hc++) {
        horizontal[hr][hc] = row[hc] === 1 ? 1 : 0;
      }
    }
    var vertical = [];
    for (var vr = 0; vr < rows; vr++) {
      var vrow = vs[vr] || [];
      vertical[vr] = [];
      for (var vc = 0; vc <= cols; vc++) {
        vertical[vr][vc] = vrow[vc] === 1 ? 1 : 0;
      }
    }
    return { horizontal: horizontal, vertical: vertical };
  } catch (e) {
    return null;
  }
}

function applySlitherlinkState(lines) {
  try {
    if (!lines || !lines.horizontal || !lines.vertical) return false;
    if (!(window.Game && window.Game.currentState)) return false;
    var hs = window.Game.currentState.cellHorizontalStatus;
    var vs = window.Game.currentState.cellVerticalStatus;
    if (!Array.isArray(hs) || !Array.isArray(vs)) return false;

    // saveState(true) BEFORE writes — see CLAUDE.md "MAIN-world write
    // functions: save + render ladder".
    if (typeof window.Game.saveState === 'function') {
      window.Game.saveState(true);
    }

    for (var r = 0; r < hs.length && r < lines.horizontal.length; r++) {
      var dst = hs[r], src = lines.horizontal[r] || [];
      if (!Array.isArray(dst)) continue;
      for (var c = 0; c < dst.length && c < src.length; c++) {
        dst[c] = src[c] === 1 ? 1 : 0;
      }
    }
    for (var r2 = 0; r2 < vs.length && r2 < lines.vertical.length; r2++) {
      var dst2 = vs[r2], src2 = lines.vertical[r2] || [];
      if (!Array.isArray(dst2)) continue;
      for (var c2 = 0; c2 < dst2.length && c2 < src2.length; c2++) {
        dst2[c2] = src2[c2] === 1 ? 1 : 0;
      }
    }
    window.Game.currentState.solved = false;
    window.Game.solved = false;

    if (typeof window.Game.drawCurrentState === 'function') {
      window.Game.drawCurrentState();
    } else if (typeof window.Game.render === 'function') {
      window.Game.render();
    } else if (typeof window.Game.redraw === 'function') {
      window.Game.redraw();
    } else if (typeof window.Game.draw === 'function') {
      window.Game.draw();
    }
    return true;
  } catch (e) {
    console.warn('Slitherlink apply failed:', e);
    return false;
  }
}
```

- [ ] **Step 2: Verify the file parses under Node**

Run: `node -e "require('./main-world.js'); console.log('main-world.js parses OK')"`
Expected: `main-world.js parses OK`.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: completes without error.

- [ ] **Step 4: Commit**

```bash
npm run lint && jj commit -m "feat(slitherlink): MAIN-world read/apply functions

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Allowlist + MainWorldFn union + eslint globals + globals.d.ts solver class

**Files:**
- Modify: `background.js` — extend `EXEC_MAIN_ALLOWLIST` (17 → 20 entries)
- Modify: `globals.d.ts` — add `SlitherlinkSolver` ambient and extend `MainWorldFn` union
- Modify: `eslint.config.js` — add `SlitherlinkSolver` to `solverClasses`

- [ ] **Step 1: Extend the allowlist**

In `background.js`, add the three names to `EXEC_MAIN_ALLOWLIST` (after `applyYinYangState`):

```js
  'readYinYangData',
  'readYinYangState',
  'applyYinYangState',
  'readSlitherlinkData',
  'readSlitherlinkState',
  'applySlitherlinkState',
  'applyGameState',
```

- [ ] **Step 2: Mirror in globals.d.ts**

In `globals.d.ts`:
- Add `declare const SlitherlinkSolver: any;` after the existing solver-class declarations.
- Add the three names to the `MainWorldFn` union (after `'applyYinYangState'`):

```ts
declare const SlitherlinkSolver: any;
```

```ts
  | 'readYinYangData'
  | 'readYinYangState'
  | 'applyYinYangState'
  | 'readSlitherlinkData'
  | 'readSlitherlinkState'
  | 'applySlitherlinkState'
  | 'applyGameState'
```

- [ ] **Step 3: Update eslint.config.js**

In `eslint.config.js`, extend `solverClasses`:

```js
const solverClasses = {
  NonogramSolver: 'readonly',
  AquariumSolver: 'readonly',
  GalaxiesSolver: 'readonly',
  BinairoSolver: 'readonly',
  ShikakuSolver: 'readonly',
  YinYangSolver: 'readonly',
  SlitherlinkSolver: 'readonly',
};
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run lint`
Expected: both pass.

Run: `npm run build`
Expected: completes without error.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(slitherlink): allowlist + globals + eslint

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: `slitherlinkHandler` in handler.js

**Files:**
- Modify: `handler.js`

The handler keys on `/loop/` (the page URL path) but the in-code type stays `slitherlink`. `readState` returns `{ horizontal, vertical }` — an edge-state object, NOT a 2D cell grid like other handlers — and the rest of `content.js`'s slitherlink-specific code branches on `puzzleData.type === 'slitherlink'` to handle that shape correctly.

- [ ] **Step 1: Add the handler**

In `handler.js`, add after the `registerHandler(yinYangHandler);` line (around line 407, before the puzzles-mobile catch-all):

```js
// ── Slitherlink handler (puzzles-mobile.com/loop/) ────────────

const slitherlinkHandler = {
  name: 'puzzles-mobile-slitherlink',
  priority: 30,

  matches() {
    return isPuzzlesMobilePage() &&
           window.location.pathname.includes('/loop/');
  },

  async detect() {
    const result = { found: false, rows: 0, cols: 0, rowClues: [], colClues: [] };
    const data = await callMainWorld('readSlitherlinkData', []);
    if (!data) return { ...result, error: 'No Slitherlink task data found' };
    const stageEl = document.getElementById('stage') ||
                    document.getElementById('game') ||
                    document.querySelector('[class*="game"], [class*="puzzle"]');
    return {
      found: true,
      type: 'slitherlink',
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
    const state = await callMainWorld('readSlitherlinkState', [ctx.rows, ctx.cols]);
    if (state) return state;
    // Empty edge state: matches the page's shape (H+1 × W and H × W+1) of zeros.
    return {
      horizontal: Array.from({ length: ctx.rows + 1 }, () => new Array(ctx.cols).fill(0)),
      vertical:   Array.from({ length: ctx.rows },     () => new Array(ctx.cols + 1).fill(0)),
    };
  },

  async applySolution(solution, _ctx) {
    // Solution shape from the worker / hint apply: { horizontal, vertical }.
    if (!solution || !solution.horizontal || !solution.vertical) {
      return { success: false, error: 'Slitherlink applySolution: missing horizontal/vertical' };
    }
    const ok = await callMainWorld('applySlitherlinkState', [solution]);
    return ok
      ? { success: true }
      : { success: false, error: 'Slitherlink apply failed (no window.Game or MAIN-world timeout)' };
  },
};

registerHandler(slitherlinkHandler);
```

- [ ] **Step 2: Verify handler.js still parses under Node**

Run: `node -e "require('./handler.js'); console.log('handler.js OK')"`
Expected: `handler.js OK`.

- [ ] **Step 3: Verify + build**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all pass.

Run: `npm run build`
Expected: completes without error.

- [ ] **Step 4: Commit**

```bash
jj commit -m "feat(slitherlink): handler for /loop/ pages

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: content.js — solve wiring, cache key, supported puzzles

**Files:**
- Modify: `content.js`

Three pieces: extend `solveExtraData()` with a slitherlink arm, add `slitherlinkCacheKey` + its registration in the cache dispatchers + the `SOLUTION_KEY_PREFIXES` list, add a Slitherlink entry to `SUPPORTED_PUZZLES`.

Note: Slitherlink's `puzzleData.solution` will be an `{ horizontal, vertical }` object (not a `number[][]`), so the existing `getCachedGridSolution` / `cacheGridSolution` parsers — which assume `Array.isArray(parsed.grid)` — won't work. Add a slitherlink-specific arm to BOTH that handles the edge-state shape.

- [ ] **Step 1: Add the solveExtraData arm**

In `content.js`'s `solveExtraData()` (around line 903), add a `slitherlink` arm next to the `yinyang` arm:

```js
  if (data.type === 'slitherlink') {
    return {
      rows: data.rows,
      cols: data.cols,
      task: data.task,
    };
  }
```

- [ ] **Step 2: Add the cache key function**

Add `slitherlinkCacheKey` next to `yinYangCacheKey` (around line 1116):

```js
function slitherlinkCacheKey(data) {
  if (data?.type !== 'slitherlink') return null;
  // FNV-1a over (nameplate, rows, cols, flattened task).
  let h = 0x811c9dc5;
  const mix = (n) => { h ^= n; h = Math.imul(h, 0x01000193) >>> 0; };
  mix(0x4C); // 'L' nameplate (Loop) so slitherlink keys don't collide
  mix(data.rows | 0);
  mix(data.cols | 0);
  const t = data.task || [];
  for (let r = 0; r < data.rows; r++) {
    const row = t[r] || [];
    for (let c = 0; c < data.cols; c++) mix((row[c] | 0) + 2);
  }
  return 'slitherlink-solution:' + (h >>> 0).toString(16);
}
```

- [ ] **Step 3: Register the key in the cache dispatchers**

Add `slitherlink-solution:` to `SOLUTION_KEY_PREFIXES`:

```js
const SOLUTION_KEY_PREFIXES = ['galaxies-solution:', 'aquarium-solution:', 'nonogram-solution:', 'binairo-solution:', 'shikaku-solution:', 'yinyang-solution:', 'slitherlink-solution:'];
```

Replace `getCachedGridSolution` and `cacheGridSolution` (around lines 1132 and 1155) with the versions below — they add a `slitherlink` arm that handles the `{horizontal, vertical}` shape (not a 2D grid). Don't just append to the chain; the body itself differs.

```js
function getCachedGridSolution(data) {
  const key = data?.type === 'aquarium' ? aquariumCacheKey(data)
    : data?.type === 'nonogram' ? nonogramCacheKey(data)
    : data?.type === 'binairo' ? binairoCacheKey(data)
    : data?.type === 'shikaku' ? shikakuCacheKey(data)
    : data?.type === 'yinyang' ? yinYangCacheKey(data)
    : data?.type === 'slitherlink' ? slitherlinkCacheKey(data)
    : null;
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!isFreshSolutionEntry(parsed)) {
      try { localStorage.removeItem(key); } catch { /* ignore */ }
      return null;
    }
    if (data.type === 'slitherlink') {
      if (!parsed?.horizontal || !parsed?.vertical) return null;
      return {
        horizontal: parsed.horizontal.map(row => row.slice()),
        vertical: parsed.vertical.map(row => row.slice()),
      };
    }
    if (!Array.isArray(parsed?.grid)) return null;
    return parsed.grid.map(row => row.slice());
  } catch {
    return null;
  }
}

function cacheGridSolution(data, grid) {
  const key = data?.type === 'aquarium' ? aquariumCacheKey(data)
    : data?.type === 'nonogram' ? nonogramCacheKey(data)
    : data?.type === 'binairo' ? binairoCacheKey(data)
    : data?.type === 'shikaku' ? shikakuCacheKey(data)
    : data?.type === 'yinyang' ? yinYangCacheKey(data)
    : data?.type === 'slitherlink' ? slitherlinkCacheKey(data)
    : null;
  if (!key) return;
  try {
    if (data?.type === 'slitherlink') {
      if (!grid || !grid.horizontal || !grid.vertical) return;
      localStorage.setItem(key, JSON.stringify({
        horizontal: grid.horizontal, vertical: grid.vertical, savedAt: Date.now(),
      }));
    } else {
      if (!Array.isArray(grid)) return;
      localStorage.setItem(key, JSON.stringify({ grid, savedAt: Date.now() }));
    }
    pruneSolutionCache();
  } catch { /* quota or unavailable */ }
}
```

- [ ] **Step 4: Add the SUPPORTED_PUZZLES entry**

In the `SUPPORTED_PUZZLES` array (around line 1499), add after the Yin-Yang entry:

```js
  { name: 'Slitherlink',  url: 'https://www.puzzles-mobile.com/loop/' },
```

- [ ] **Step 5: Verify + build**

Run: `npm run lint && npm run typecheck`
Expected: both pass.

Run: `npm run build`
Expected: completes without error.

- [ ] **Step 6: Commit**

```bash
jj commit -m "feat(slitherlink): content.js solve wiring, cache key, supported puzzles

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 14: content.js — Hint branch, Apply path, Loop done-check

**Files:**
- Modify: `content.js`

Three integration points:
1. Add a `slitherlink` arm to the `getHint()` dispatch chain (around line 1330-1450). The arm calls `SlitherlinkSolver.getHint(curH, curV)` and wraps the result.
2. Add a `slitherlink` arm to `applyHintHandler` (around line 2827) and `applyAndRunLoop` (around line 2647): merge the hint's LINE edges into the current edge state, then apply via `applySlitherlinkState`.
3. Loop done-check (around line 2693): "done" when every solution LINE edge is present on the board.

- [ ] **Step 1: Add the getHint branch**

In `content.js`'s `getHint()` (around line 1330), add a `slitherlink` arm just BEFORE the `shikaku` arm. The arm reads the current edge state, runs `SlitherlinkSolver.getHint`, and packages the result. Place this between the `yinyang` arm and the `shikaku` arm:

```js
    } else if (detectedGrid.type === 'slitherlink') {
      // Re-read edge state. The grid we have is the cell-flood-fill grid
      // produced by readGridState for displays, but slitherlink's solver
      // needs the raw H/V edge arrays.
      const edgeState = await callMainWorld('readSlitherlinkState', [rows, cols]);
      const curH = edgeState?.horizontal
        || Array.from({ length: rows + 1 }, () => new Array(cols).fill(0));
      const curV = edgeState?.vertical
        || Array.from({ length: rows },     () => new Array(cols + 1).fill(0));
      const solver = new SlitherlinkSolver({
        width: cols, height: rows, task: detectedGrid.task,
        initialState: { horizontal: curH, vertical: curV },
      });
      solver.maxMs = 5000;
      hint = solver.getHint(curH, curV);
      if (!hint) {
        return { success: false, error: 'No more edges can be deduced from the current state. Click Solve to finish.' };
      }
      // Carry the current edge state along so applyHintHandler / loop can
      // overlay onto it without re-reading.
      hint._curH = curH;
      hint._curV = curV;
```

The `grid` variable in this function is the cell-flood-fill grid used by other puzzle types' mistake detection. Slitherlink uses the edge-state diff path instead, so we DON'T do a `firstMismatch(grid, solution)` check here.

Also, the existing `if (!hint) return { success: false, error: 'No hint available' };` at the bottom of the function (after the switch) will catch slitherlink if the arm above returns null — but the arm always returns its own error, so the bottom guard is unreachable for slitherlink. No further change.

- [ ] **Step 2: Add slitherlink hint-status nodes**

Add `slitherlinkHintStatusNodes` next to `yinYangHintStatusNodes` (the function is defined near `setHintStatus`, ~line 1690):

```js
  function slitherlinkHintStatusNodes(h) {
    const total = h?.edges?.length || 0;
    if (total === 0) return ['No hint available'];
    if (total === 1) {
      const e = h.edges[0];
      const desc = e.orientation === 'h'
        ? `the top of cell (row ${e.r + 1}, col ${e.c + 1}) / bottom of (row ${e.r}, col ${e.c + 1})`
        : `the left of cell (row ${e.r + 1}, col ${e.c + 1}) / right of (row ${e.r + 1}, col ${e.c})`;
      return ['Draw a line along ', bold(desc), '.'];
    }
    return [bold(String(total)), ' edges can be deduced'];
  }
```

In the `setHintStatus` dispatch chain (around line 1700), add a slitherlink arm just before the `else`:

```js
    } else if (puzzleData?.type === 'slitherlink') {
      setStatusNodes('info', prefix, ...slitherlinkHintStatusNodes(h));
```

- [ ] **Step 3: Add slitherlink arms to applyHintHandler and applyAndRunLoop**

In `applyHintHandler` (around line 2827), add a slitherlink arm before the `else` branch (the generic `applyHintCells` fallback). Place it after the `shikaku` arm:

```js
    } else if (puzzleData.type === 'slitherlink') {
      // Read the current edge state, overlay the hint's LINE edges, apply.
      const cur = await callMainWorld('readSlitherlinkState', [puzzleData.rows, puzzleData.cols]);
      const horizontal = (cur?.horizontal || Array.from({ length: puzzleData.rows + 1 },
        () => new Array(puzzleData.cols).fill(0))).map(row => row.slice());
      const vertical   = (cur?.vertical   || Array.from({ length: puzzleData.rows },
        () => new Array(puzzleData.cols + 1).fill(0))).map(row => row.slice());
      for (const e of (puzzleData.pendingHint.edges || [])) {
        if (e.orientation === 'h' && horizontal[e.r]) horizontal[e.r][e.c] = 1;
        else if (e.orientation === 'v' && vertical[e.r]) vertical[e.r][e.c] = 1;
      }
      const ok = await callMainWorld('applySlitherlinkState', [{ horizontal, vertical }]);
      result = ok ? { success: true } : { success: false, error: 'Slitherlink hint apply failed' };
```

In `applyAndRunLoop` (around line 2647), the conditional chain in the body has galaxies / shikaku / generic arms. Add a slitherlink arm in the same chain BEFORE the generic else (right after the shikaku arm):

```js
      } else if (puzzleData.type === 'slitherlink') {
        const cur = await callMainWorld('readSlitherlinkState', [puzzleData.rows, puzzleData.cols]);
        const horizontal = (cur?.horizontal || Array.from({ length: puzzleData.rows + 1 },
          () => new Array(puzzleData.cols).fill(0))).map(row => row.slice());
        const vertical   = (cur?.vertical   || Array.from({ length: puzzleData.rows },
          () => new Array(puzzleData.cols + 1).fill(0))).map(row => row.slice());
        for (const e of (puzzleData.pendingHint.edges || [])) {
          if (e.orientation === 'h' && horizontal[e.r]) horizontal[e.r][e.c] = 1;
          else if (e.orientation === 'v' && vertical[e.r]) vertical[e.r][e.c] = 1;
        }
        ok = !!(await callMainWorld('applySlitherlinkState', [{ horizontal, vertical }]));
```

Also extend `applyHintToGrid` (around line 1278) so the Loop's in-memory merge handles slitherlink. The function currently has a `galaxies` arm that overwrites `grid.galaxies`; add a parallel `slitherlink` arm before the cell-encoding fallthrough:

```js
function applyHintToGrid(grid, hint) {
  if (hint?.type === 'galaxies') {
    grid.galaxies = hint.lines;
    return;
  }
  if (hint?.type === 'slitherlink') {
    // grid is { horizontal, vertical } from slitherlinkHandler.readState.
    for (const e of (hint.edges || [])) {
      if (e.orientation === 'h' && grid.horizontal?.[e.r]) grid.horizontal[e.r][e.c] = 1;
      else if (e.orientation === 'v' && grid.vertical?.[e.r]) grid.vertical[e.r][e.c] = 1;
    }
    return;
  }
  for (const cell of hintAbsoluteCells(hint)) {
    if (grid[cell.row] !== undefined) grid[cell.row][cell.col] = cell.value;
  }
}
```

This is the function `runLoop` calls (around line 2708) after each step's hint is computed, to keep the in-memory `gs.grid` in sync so the next step's done-check sees the latest edges. Without the new arm, `applyHintToGrid` would fall through to `hintAbsoluteCells`, which assumes a cell-encoding hint and silently does nothing for slitherlink — the Loop would never see progress and break early.

- [ ] **Step 4: Loop done-check + per-step diff**

In `runLoop` (around line 2677), the existing per-step completion check is:

```js
const gsComplete = puzzleData.type === 'shikaku'
  ? gs.grid.every(row => row.every(c => c !== -1))
  : gs.grid.every(row => row.every(c => c !== 0));
if (puzzleData.type !== 'galaxies' && gsComplete) break;
```

Replace this block with a slitherlink-aware version:

```js
let gsComplete;
if (puzzleData.type === 'slitherlink') {
  // Done when every solution LINE edge is on the board.
  const sol = puzzleData.solution;
  if (sol?.horizontal && sol?.vertical) {
    const edgeState = await callMainWorld('readSlitherlinkState', [puzzleData.rows, puzzleData.cols]);
    const bh = edgeState?.horizontal || [];
    const bv = edgeState?.vertical || [];
    gsComplete = true;
    outer: for (let r = 0; r < sol.horizontal.length; r++) {
      for (let c = 0; c < (sol.horizontal[r]?.length || 0); c++) {
        if (sol.horizontal[r][c] === 1 && bh[r]?.[c] !== 1) { gsComplete = false; break outer; }
      }
    }
    if (gsComplete) {
      outer2: for (let r = 0; r < sol.vertical.length; r++) {
        for (let c = 0; c < (sol.vertical[r]?.length || 0); c++) {
          if (sol.vertical[r][c] === 1 && bv[r]?.[c] !== 1) { gsComplete = false; break outer2; }
        }
      }
    }
  } else {
    gsComplete = false;
  }
} else if (puzzleData.type === 'shikaku') {
  gsComplete = gs.grid.every(row => row.every(c => c !== -1));
} else {
  gsComplete = gs.grid.every(row => row.every(c => c !== 0));
}
if (puzzleData.type !== 'galaxies' && gsComplete) break;
```

Mirror the same completion logic in the post-loop `endComplete` block (around line 2734-2738):

```js
let endComplete = false;
if (end?.grid) {
  if (puzzleData.type === 'slitherlink' && puzzleData.solution?.horizontal && puzzleData.solution?.vertical) {
    const edgeState = await callMainWorld('readSlitherlinkState', [puzzleData.rows, puzzleData.cols]);
    const bh = edgeState?.horizontal || [];
    const bv = edgeState?.vertical || [];
    endComplete = true;
    for (let r = 0; endComplete && r < puzzleData.solution.horizontal.length; r++) {
      for (let c = 0; c < (puzzleData.solution.horizontal[r]?.length || 0); c++) {
        if (puzzleData.solution.horizontal[r][c] === 1 && bh[r]?.[c] !== 1) { endComplete = false; break; }
      }
    }
    for (let r = 0; endComplete && r < puzzleData.solution.vertical.length; r++) {
      for (let c = 0; c < (puzzleData.solution.vertical[r]?.length || 0); c++) {
        if (puzzleData.solution.vertical[r][c] === 1 && bv[r]?.[c] !== 1) { endComplete = false; break; }
      }
    }
  } else {
    endComplete = puzzleData.type === 'shikaku'
      ? end.grid.every(row => row.every(c => c !== -1))
      : end.grid.every(row => row.every(c => c !== 0));
  }
}
const done = end?.grid && puzzleData.type !== 'galaxies' && endComplete;
setStatus(done ? 'Solved!' : 'No more hints available.', done ? 'success' : 'info');
```

- [ ] **Step 5: Verify + build**

Run: `npm run lint && npm run typecheck`
Expected: both pass.

Run: `npm run build`
Expected: completes without error.

- [ ] **Step 6: Commit**

```bash
jj commit -m "feat(slitherlink): content.js Hint branch, Apply, and Loop done-check

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 15: content.js — `drawPreview` slitherlink arm

**Files:**
- Modify: `content.js`

The preview needs:
- **Static layer:** the dot lattice + clue numbers centered in clued cells. Already-existing `staticLayer` cache; just add a slitherlink-specific section inside `buildStaticLayer` (called at `staticLayer = buildStaticLayer(...)` around line 2167) and a `|sl=` segment to `staticSig` so the layer rebuilds when the task changes.
- **Dynamic layer:** thick LINE strokes between dots, mirroring the galaxies arm's style.
- **`gridDataSig`:** hash the edge arrays so the per-tick early-bail tracks edge changes.
- **`drawNonogramGuidesOn`:** already excludes other puzzle types; add `slitherlink` to the early-return list.

For slitherlink, the `grid` passed to `drawPreview` will be `{ horizontal, vertical }` (an edge-state object), not a 2D cell array. We add an `isSlitherlink` flag at the top of `drawPreview` and short-circuit around the cell-paint loop body that assumes `grid[r][c]`.

- [ ] **Step 1: Add the type flag and a `slitherlinkCluesSig` helper**

Near the top of `drawPreview` (around line 2186-2188), add:

```js
    const isSlitherlink = puzzleData?.type === 'slitherlink';
```

Add this signature helper near `shikakuCluesSig` (find by `grep -n shikakuCluesSig content.js`):

```js
  function slitherlinkCluesSig(task) {
    if (!Array.isArray(task)) return '';
    let h = 0x811c9dc5;
    for (let r = 0; r < task.length; r++) {
      const row = task[r] || [];
      for (let c = 0; c < row.length; c++) {
        h ^= (row[c] | 0) + 2;
        h = Math.imul(h, 0x01000193) >>> 0;
      }
    }
    return (h >>> 0).toString(16);
  }
```

- [ ] **Step 2: Extend `staticSig` and `gridDataSig`**

In `drawPreview` (around line 2160), extend the `staticSig` expression to include `|sl=`:

```js
    const staticSig = rows + 'x' + cols + '@' + cellSize + '|t=' + (pd?.type || '') +
                      '|rm=' + regionMapSig(pd?.regionMap) +
                      '|st=' + (pd?.stars ? pd.stars.map(s => s.row + ',' + s.col).join(';') : '') +
                      '|cc=' + comparisonCluesSig(pd?.comparisonClues) +
                      '|sk=' + shikakuCluesSig(pd?.type === 'shikaku' ? pd.clues : null) +
                      '|sl=' + slitherlinkCluesSig(pd?.type === 'slitherlink' ? pd.task : null);
```

In `gridDataSig` (around line 1915), add a slitherlink branch BEFORE the default 2D scan. The function currently assumes a 2D `number[][]`. Replace the function so it also handles the edge-state shape:

```js
  function gridDataSig(grid) {
    if (grid && grid.horizontal && grid.vertical) {
      // Slitherlink edge-state shape: hash both arrays.
      let h = 0x811c9dc5;
      const mix = (n) => { h ^= n; h = Math.imul(h, 0x01000193) >>> 0; };
      for (const row of grid.horizontal) for (const v of row) mix(v | 0);
      mix(0xFF);
      for (const row of grid.vertical) for (const v of row) mix(v | 0);
      if (grid.galaxies) {
        mix(0xEE);
        for (const row of grid.galaxies.horizontal || []) for (const v of row) mix(v | 0);
        for (const row of grid.galaxies.vertical   || []) for (const v of row) mix(v | 0);
      }
      return (h >>> 0).toString(16);
    }
    // existing implementation continues...
```

(Keep the existing 2D-grid code path immediately after this branch, unchanged.)

- [ ] **Step 3: Add a slitherlink branch to `buildStaticLayer`**

In `buildStaticLayer` (find by grep `function buildStaticLayer`), add a slitherlink section that draws the dot lattice + clue numbers. Place it before the final `return offscreen` (or wherever the function ends — check by reading the function). The lattice dots are drawn as small filled circles at every `(r * cellSize, c * cellSize)`; clue numbers go centered in clued cells using the canvas's existing font:

```js
    if (pd?.type === 'slitherlink') {
      const dotR = Math.max(1.5, cellSize / 14);
      ctx.fillStyle = '#1f2937';
      for (let r = 0; r <= rows; r++) {
        for (let c = 0; c <= cols; c++) {
          ctx.beginPath();
          ctx.arc(c * cellSize, r * cellSize, dotR, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // Clue numbers.
      const fontPx = Math.max(8, Math.floor(cellSize * 0.55));
      ctx.font = `bold ${fontPx}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#1f2937';
      const task = pd.task || [];
      for (let r = 0; r < rows; r++) {
        const row = task[r] || [];
        for (let c = 0; c < cols; c++) {
          const v = row[c];
          if (v === 0 || v === 1 || v === 2 || v === 3) {
            ctx.fillText(String(v), c * cellSize + cellSize / 2, r * cellSize + cellSize / 2);
          }
        }
      }
    }
```

- [ ] **Step 4: Exclude slitherlink from `drawNonogramGuidesOn`**

In `drawNonogramGuidesOn` (around line 2102), extend the early-return condition:

```js
  function drawNonogramGuidesOn(ctx, rows, cols, cellSize, w, h, pd) {
    if (pd?.regionMap || pd?.type === 'galaxies' || pd?.type === 'binairo' ||
        pd?.type === 'shikaku' || pd?.type === 'yinyang' || pd?.type === 'slitherlink') return;
```

- [ ] **Step 5: Add the cell-paint short-circuit and dynamic LINE drawing**

Just before the existing `for (let r = 0; r < rows; r++) {` cell-paint loop in `drawPreview` (around line 2191), short-circuit for slitherlink — the cell-iteration touches `grid[r][c]` which doesn't exist on the edge-state shape:

```js
    if (isSlitherlink) {
      // Slitherlink: paint LINE edges between dots. Cell-fill loop is skipped
      // because `grid` here is { horizontal, vertical }, not a 2D cell array.
      ctx.save();
      ctx.strokeStyle = '#1f2937';
      ctx.lineWidth = Math.max(2, Math.floor(cellSize / 6));
      ctx.lineCap = 'round';
      const hg = grid.horizontal || [];
      for (let r = 0; r <= rows; r++) {
        const row = hg[r] || [];
        for (let c = 0; c < cols; c++) {
          if (row[c] === 1) {
            ctx.beginPath();
            ctx.moveTo(c * cellSize, r * cellSize);
            ctx.lineTo((c + 1) * cellSize, r * cellSize);
            ctx.stroke();
          }
        }
      }
      const vg = grid.vertical || [];
      for (let r = 0; r < rows; r++) {
        const row = vg[r] || [];
        for (let c = 0; c <= cols; c++) {
          if (row[c] === 1) {
            ctx.beginPath();
            ctx.moveTo(c * cellSize, r * cellSize);
            ctx.lineTo(c * cellSize, (r + 1) * cellSize);
            ctx.stroke();
          }
        }
      }
      ctx.restore();
    } else {
      // existing cell-paint loop here, unchanged
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          // ... existing body ...
        }
      }
      if (xMarkPath) {
        ctx.strokeStyle = '#999';
        ctx.lineWidth = 1;
        ctx.stroke(xMarkPath);
      }
    }
```

(The wrapping `else` brackets the existing cell-paint loop AND its trailing `if (xMarkPath) { ... }` block so they only run for non-slitherlink puzzles.)

- [ ] **Step 6: Hint highlight for slitherlink**

The existing hint-highlight block (around line 2303) calls `hintAbsoluteCells(hint)` which is cell-based. Skip it for slitherlink and draw hint edges in blue instead. Right before the existing `if (hint) { ... }` block, add:

```js
    if (isSlitherlink && hint && Array.isArray(hint.edges)) {
      ctx.save();
      ctx.strokeStyle = '#2e86de';
      ctx.lineWidth = Math.max(3, Math.floor(cellSize / 5));
      ctx.lineCap = 'round';
      for (const e of hint.edges) {
        if (e.orientation === 'h') {
          ctx.beginPath();
          ctx.moveTo(e.c * cellSize, e.r * cellSize);
          ctx.lineTo((e.c + 1) * cellSize, e.r * cellSize);
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.moveTo(e.c * cellSize, e.r * cellSize);
          ctx.lineTo(e.c * cellSize, (e.r + 1) * cellSize);
          ctx.stroke();
        }
      }
      ctx.restore();
    } else if (hint) {
      // existing if (hint) { ... } block unchanged
```

(Close the `else` branch so the existing cell-based highlight runs only for non-slitherlink puzzles.)

- [ ] **Step 7: Verify + build**

Run: `npm run lint && npm run typecheck`
Expected: both pass.

Run: `npm run build`
Expected: completes without error.

- [ ] **Step 8: Commit**

```bash
jj commit -m "feat(slitherlink): drawPreview support for edge state

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 16: `computePuzzleDiff` slitherlink arm + edge-mistake overlay

**Files:**
- Modify: `solver.js` — extend `computePuzzleDiff` with a slitherlink arm; add `_slitherlinkDiff`
- Modify: `content.js` — mistake overlay paints edges, status text uses `mistakes.length`
- Modify: `tests/solver.test.js`

For Slitherlink, mistakes are on edges, not cells. The diff arm walks the board's `horizontal` / `vertical` arrays; a mistake is a committed LINE (`board[r][c] === 1`) where the solution disagrees (`solution[r][c] !== 1`). UNKNOWN/empty board edges (`0`) are NOT mistakes — same "empty cells aren't flagged" invariant.

- [ ] **Step 1: Write the failing test**

Add to `tests/solver.test.js`:

```js
test('computePuzzleDiff: slitherlink returns empty on a correct partial board', () => {
  // Board has just one LINE edge that matches the solution.
  const board = {
    horizontal: [[1, 0, 0], [0, 0, 0]],
    vertical:   [[0, 0, 0, 0]],
  };
  const solution = {
    horizontal: [[1, 1, 1], [1, 1, 1]],
    vertical:   [[1, 0, 0, 1]],
  };
  const diff = computePuzzleDiff('slitherlink', board, solution);
  assert.deepEqual(diff, []);
});

test('computePuzzleDiff: slitherlink flags a wrong horizontal LINE', () => {
  const board = {
    horizontal: [[1, 1, 0], [0, 0, 0]],
    vertical:   [[0, 0, 0, 0]],
  };
  const solution = {
    horizontal: [[1, 0, 1], [1, 1, 1]],
    vertical:   [[1, 0, 0, 1]],
  };
  // Board has H[0][1]=1 but solution has H[0][1]=0 -> mistake.
  const diff = computePuzzleDiff('slitherlink', board, solution);
  assert.deepEqual(diff, [{ orientation: 'h', r: 0, c: 1 }]);
});

test('computePuzzleDiff: slitherlink ignores empty-edge cells', () => {
  // Solution has many LINE edges that the board doesn't have — those are
  // not mistakes (empty cells are never flagged).
  const board = {
    horizontal: [[0, 0, 0], [0, 0, 0]],
    vertical:   [[0, 0, 0, 0]],
  };
  const solution = {
    horizontal: [[1, 1, 1], [1, 1, 1]],
    vertical:   [[1, 1, 1, 1]],
  };
  const diff = computePuzzleDiff('slitherlink', board, solution);
  assert.deepEqual(diff, []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-name-pattern='computePuzzleDiff: slitherlink'`
Expected: FAIL — the existing `computePuzzleDiff` returns `[]` because the slitherlink board isn't a 2D `number[][]` (the top-level guard `if (!Array.isArray(grid) || !Array.isArray(solution)) return out;` short-circuits).

- [ ] **Step 3: Write the implementation**

In `solver.js`, add `_slitherlinkDiff` next to `_galaxiesDiff` (around line 4476):

```js
// Slitherlink diff: edge-based, not cell-based. A mistake is a committed
// LINE edge (board value === 1) where the solution disagrees. UNKNOWN/empty
// edges on the board are never flagged.
function _slitherlinkDiff(board, solution) {
  const out = [];
  if (!board || !solution) return out;
  const bh = board.horizontal || [];
  const sh = solution.horizontal || [];
  const rowsH = Math.min(bh.length, sh.length);
  for (let r = 0; r < rowsH; r++) {
    const br = bh[r] || [], sr = sh[r] || [];
    const cols = Math.min(br.length, sr.length);
    for (let c = 0; c < cols; c++) {
      if (br[c] === 1 && sr[c] !== 1) out.push({ orientation: 'h', r, c });
    }
  }
  const bv = board.vertical || [];
  const sv = solution.vertical || [];
  const rowsV = Math.min(bv.length, sv.length);
  for (let r = 0; r < rowsV; r++) {
    const br = bv[r] || [], sr = sv[r] || [];
    const cols = Math.min(br.length, sr.length);
    for (let c = 0; c < cols; c++) {
      if (br[c] === 1 && sr[c] !== 1) out.push({ orientation: 'v', r, c });
    }
  }
  return out;
}
```

Extend `computePuzzleDiff` (around line 4523). Insert the slitherlink branch BEFORE the `if (!Array.isArray(grid) || !Array.isArray(solution)) return out;` guard, since slitherlink's grid is an `{horizontal, vertical}` object:

```js
function computePuzzleDiff(type, grid, solution, stars) {
  const out = [];
  if (type === 'slitherlink') return _slitherlinkDiff(grid, solution);
  if (!Array.isArray(grid) || !Array.isArray(solution)) return out;
  if (type === 'shikaku') return _shikakuDiff(grid, solution);
  if (type === 'galaxies') return _galaxiesDiff(grid, solution, stars);
  // existing default cell-loop unchanged...
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test --test-name-pattern='computePuzzleDiff: slitherlink'`
Expected: all 3 passing.

- [ ] **Step 5: Update content.js mistake overlay to paint edges**

In `drawPreview` (around line 2401), the mistake-overlay block currently expects `{row, col}` entries. Slitherlink returns `{orientation, r, c}` entries — paint those as red edges instead of red cell rings:

```js
    if (puzzleData?.solution) {
      const mistakes = computePuzzleDiff(
        puzzleData.type, grid, puzzleData.solution, puzzleData.stars);
      if (mistakes.length) {
        ctx.save();
        ctx.strokeStyle = '#e63946';
        ctx.lineWidth = Math.max(2, Math.floor(cellSize / 8));
        if (puzzleData.type === 'slitherlink') {
          ctx.lineCap = 'round';
          ctx.lineWidth = Math.max(3, Math.floor(cellSize / 5));
          for (const m of mistakes) {
            ctx.beginPath();
            if (m.orientation === 'h') {
              ctx.moveTo(m.c * cellSize, m.r * cellSize);
              ctx.lineTo((m.c + 1) * cellSize, m.r * cellSize);
            } else {
              ctx.moveTo(m.c * cellSize, m.r * cellSize);
              ctx.lineTo(m.c * cellSize, (m.r + 1) * cellSize);
            }
            ctx.stroke();
          }
        } else {
          for (const m of mistakes) {
            const mx = m.col * cellSize, my = m.row * cellSize;
            ctx.fillStyle = 'rgba(230, 57, 70, 0.22)';
            ctx.fillRect(mx, my, cellSize, cellSize);
            ctx.strokeRect(mx + 1, my + 1, cellSize - 2, cellSize - 2);
          }
        }
        ctx.restore();
      }
    }
```

The status-text mistake count in `afterAutoSolve` (around line 2582) reads `mistakes.length` only — it's already type-agnostic and works unchanged.

- [ ] **Step 6: Verify + build**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all pass.

Run: `npm run build`
Expected: completes without error.

- [ ] **Step 7: Commit**

```bash
jj commit -m "feat(slitherlink): computePuzzleDiff edge arm and mistake overlay

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 17: Fuzz test — `tests/slitherlink-fuzz.test.js`

**Files:**
- Create: `tests/slitherlink-fuzz.test.js`

The fuzz test does two things:
1. **Constructive soundness:** generate boards from known-valid loops (a random rectangle), derive the clues from that loop, run the solver, and verify the returned edge set forms a single closed loop that satisfies all original clues. The known-valid loop is also a witness that the puzzle is solvable — so any `solved: false` result is a solver bug.
2. **4×4 brute-force completeness:** enumerate all valid Slitherlink solutions on 4×4 (`H` has `5*4=20` edges, `V` has `4*5=20` edges → `2^40` total — too big; instead, enumerate by trying all `2^(rows*cols)` cell colorings and treating "loop boundary = interior/exterior boundary"). Use this only as a sanity check on a single seed; the main path is constructive.

- [ ] **Step 1: Create the test file**

Create `tests/slitherlink-fuzz.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { SlitherlinkSolver } = require('../solver.js');

// Deterministic LCG so failures reproduce.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// Independent validator. Returns { ok, reason } where ok=true means the edge
// set is a single closed loop satisfying every clue.
function validateSlitherlinkSolution(task, result) {
  const H = task.length, W = task[0].length;
  const { horizontal, vertical } = result;
  if (!horizontal || !vertical) return { ok: false, reason: 'missing arrays' };
  if (horizontal.length !== H + 1) return { ok: false, reason: 'wrong horizontal rows' };
  if (vertical.length !== H) return { ok: false, reason: 'wrong vertical rows' };

  // 1. clues satisfied exactly.
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const k = task[r][c];
      if (k < 0) continue;
      const m = horizontal[r][c] + horizontal[r + 1][c]
              + vertical[r][c] + vertical[r][c + 1];
      if (m !== k) return { ok: false, reason: `clue ${k} at (${r},${c}) got ${m}` };
    }
  }
  // 2. every dot has degree 0 or 2.
  const degree = (r, c) => {
    let m = 0;
    if (c > 0 && horizontal[r][c - 1] === 1) m++;
    if (c < W && horizontal[r][c] === 1) m++;
    if (r > 0 && vertical[r - 1][c] === 1) m++;
    if (r < H && vertical[r][c] === 1) m++;
    return m;
  };
  let lineEdges = 0;
  for (let r = 0; r <= H; r++) {
    for (let c = 0; c <= W; c++) {
      const d = degree(r, c);
      if (d !== 0 && d !== 2) return { ok: false, reason: `dot (${r},${c}) degree ${d}` };
    }
  }
  for (let r = 0; r <= H; r++) for (let c = 0; c < W; c++) if (horizontal[r][c] === 1) lineEdges++;
  for (let r = 0; r < H; r++) for (let c = 0; c <= W; c++) if (vertical[r][c] === 1) lineEdges++;
  if (lineEdges === 0) return { ok: false, reason: 'no LINE edges' };

  // 3. all LINE edges form a single closed loop. BFS from one LINE endpoint
  //    via shared dots; every LINE edge must be visited.
  // Build adjacency: for each dot, list its incident LINE edges.
  const adj = new Map();
  const addAdj = (r, c, id) => {
    const k = r * (W + 1) + c;
    let a = adj.get(k);
    if (!a) { a = []; adj.set(k, a); }
    a.push(id);
  };
  const edgeList = [];
  for (let r = 0; r <= H; r++) {
    for (let c = 0; c < W; c++) {
      if (horizontal[r][c] === 1) {
        const id = edgeList.length;
        edgeList.push({ kind: 'h', r, c, a: [r, c], b: [r, c + 1] });
        addAdj(r, c, id); addAdj(r, c + 1, id);
      }
    }
  }
  for (let r = 0; r < H; r++) {
    for (let c = 0; c <= W; c++) {
      if (vertical[r][c] === 1) {
        const id = edgeList.length;
        edgeList.push({ kind: 'v', r, c, a: [r, c], b: [r + 1, c] });
        addAdj(r, c, id); addAdj(r + 1, c, id);
      }
    }
  }
  const seen = new Uint8Array(edgeList.length);
  const stack = [0];
  seen[0] = 1;
  let visited = 1;
  while (stack.length) {
    const eid = stack.pop();
    const e = edgeList[eid];
    for (const [r, c] of [e.a, e.b]) {
      for (const nb of adj.get(r * (W + 1) + c) || []) {
        if (!seen[nb]) { seen[nb] = 1; visited++; stack.push(nb); }
      }
    }
  }
  if (visited !== edgeList.length) return { ok: false, reason: `${visited}/${edgeList.length} edges in main loop` };
  return { ok: true };
}

// Build a solvable Slitherlink puzzle from a known closed-loop rectangle.
// rect = { r0, c0, r1, c1 } (inclusive); the loop is its perimeter.
function buildLoopPuzzle(H, W, rect) {
  const horizontal = Array.from({ length: H + 1 }, () => new Array(W).fill(0));
  const vertical   = Array.from({ length: H },     () => new Array(W + 1).fill(0));
  // Top edge of rectangle.
  for (let c = rect.c0; c <= rect.c1; c++) horizontal[rect.r0][c] = 1;
  // Bottom edge.
  for (let c = rect.c0; c <= rect.c1; c++) horizontal[rect.r1 + 1][c] = 1;
  // Left edge.
  for (let r = rect.r0; r <= rect.r1; r++) vertical[r][rect.c0] = 1;
  // Right edge.
  for (let r = rect.r0; r <= rect.r1; r++) vertical[r][rect.c1 + 1] = 1;

  // Derive clues per cell.
  const task = [];
  for (let r = 0; r < H; r++) {
    const row = new Array(W);
    for (let c = 0; c < W; c++) {
      row[c] = horizontal[r][c] + horizontal[r + 1][c]
             + vertical[r][c] + vertical[r][c + 1];
    }
    task.push(row);
  }
  return { task, horizontal, vertical };
}

test('SlitherlinkSolver fuzz: every constructed loop puzzle solves to a valid loop', () => {
  const rng = makeRng(0xBEEF);
  for (let iter = 0; iter < 50; iter++) {
    const H = 4 + Math.floor(rng() * 3); // 4..6
    const W = 4 + Math.floor(rng() * 3);
    // Random rectangle of width and height at least 2.
    const r0 = Math.floor(rng() * (H - 1));
    const c0 = Math.floor(rng() * (W - 1));
    const r1 = r0 + 1 + Math.floor(rng() * (H - r0 - 1));
    const c1 = c0 + 1 + Math.floor(rng() * (W - c0 - 1));
    const { task: fullTask } = buildLoopPuzzle(H, W, { r0, c0, r1, c1 });
    // Mask: keep ~50% of clues.
    const maskedTask = fullTask.map(row => row.slice());
    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) {
        if (rng() < 0.5) maskedTask[r][c] = -1;
      }
    }
    SlitherlinkSolver.clearSolutionCache();
    const s = new SlitherlinkSolver({ width: W, height: H, task: maskedTask });
    s.maxMs = 5000;
    const result = s.solve();
    assert.equal(result.solved, true, `iter ${iter}: solver failed a solvable board (rect ${r0},${c0}-${r1},${c1})`);
    const v = validateSlitherlinkSolution(maskedTask, result);
    assert.equal(v.ok, true, `iter ${iter}: ${v.reason}`);
  }
});

test('SlitherlinkSolver fuzz: 4x4 brute-force completeness sanity', () => {
  // Enumerate all 2^16 fillings of a 4x4 cell grid (1 = inside, 0 = outside).
  // For each, derive the loop boundary edges; if the result is a single
  // simple closed loop (every dot 0/2 degree, one component), record the
  // clues. The set of (task, solution) pairs is our ground truth.
  const H = 4, W = 4;
  function loopFromFilling(filling) {
    const horizontal = Array.from({ length: H + 1 }, () => new Array(W).fill(0));
    const vertical   = Array.from({ length: H },     () => new Array(W + 1).fill(0));
    // H[r][c] is on the boundary iff cell (r-1, c) and (r, c) differ.
    for (let r = 0; r <= H; r++) {
      for (let c = 0; c < W; c++) {
        const above = r > 0 ? filling[r - 1][c] : 0;
        const below = r < H ? filling[r][c]     : 0;
        if (above !== below) horizontal[r][c] = 1;
      }
    }
    for (let r = 0; r < H; r++) {
      for (let c = 0; c <= W; c++) {
        const left  = c > 0 ? filling[r][c - 1] : 0;
        const right = c < W ? filling[r][c]     : 0;
        if (left !== right) vertical[r][c] = 1;
      }
    }
    return { horizontal, vertical };
  }
  // Just spot-check one filling: a 2x2 interior at (1..2, 1..2). That makes
  // a valid 4-cell rectangle loop.
  const filling = [
    [0, 0, 0, 0],
    [0, 1, 1, 0],
    [0, 1, 1, 0],
    [0, 0, 0, 0],
  ];
  const sol = loopFromFilling(filling);
  // Derive clues.
  const task = [];
  for (let r = 0; r < H; r++) {
    const row = new Array(W);
    for (let c = 0; c < W; c++) {
      row[c] = sol.horizontal[r][c] + sol.horizontal[r + 1][c]
             + sol.vertical[r][c] + sol.vertical[r][c + 1];
    }
    task.push(row);
  }
  SlitherlinkSolver.clearSolutionCache();
  const s = new SlitherlinkSolver({ width: W, height: H, task });
  s.maxMs = 5000;
  const r = s.solve();
  assert.equal(r.solved, true);
  const v = validateSlitherlinkSolution(task, r);
  assert.equal(v.ok, true, v.reason);
  // The solver's answer must match the constructed solution (this puzzle
  // has a unique solution because all 16 clues are present).
  assert.deepEqual(r.horizontal, sol.horizontal);
  assert.deepEqual(r.vertical,   sol.vertical);
});
```

- [ ] **Step 2: Run the fuzz test**

Run: `node --test tests/slitherlink-fuzz.test.js`
Expected: both tests pass. If a board fails validation, the assertion message prints the iteration / seed for reproducibility.

- [ ] **Step 3: Run the whole suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
npm run lint && jj commit -m "test(slitherlink): constructive fuzz + 4x4 completeness sanity

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 18: Bench + real-puzzle fixture + nightly CI

**Files:**
- Modify: `tests/fixtures/real-puzzles.js`
- Create: `tests/bench-slitherlink.js`
- Modify: `package.json`
- Modify: `.github/workflows/bench-nightly.yml`

- [ ] **Step 1: Add the captured 5×5 to `real-puzzles.js`**

Add after the `yinyangWeekly35x35` entry (find by grep, before the closing `};`):

```js
  slitherlinkReal5x5_a: {
    type: 'slitherlink',
    rows: 5,
    cols: 5,
    task: [
      [-1, -1, -1, -1,  3],
      [-1,  2, -1, -1, -1],
      [-1,  2, -1,  0,  3],
      [-1,  1, -1, -1,  3],
      [-1,  2,  3,  1, -1],
    ],
  },
```

- [ ] **Step 2: Create the bench script**

Create `tests/bench-slitherlink.js`:

```js
const { SlitherlinkSolver } = require('../solver.js');
const real = require('./fixtures/real-puzzles.js');

const origLog = console.log;
console.log = () => {};
const log = (...a) => origLog(...a);

const targets = Object.keys(real)
  .filter(k => real[k]?.type === 'slitherlink')
  .map(k => ({ name: k, puzzle: real[k] }));

if (targets.length === 0) {
  console.error('FAIL: no slitherlink entries in tests/fixtures/real-puzzles.js');
  process.exit(1);
}

const WARMUP = 2;
const N = 11;
let failed = false;

for (const { name, puzzle } of targets) {
  for (let i = 0; i < WARMUP; i++) {
    SlitherlinkSolver.clearSolutionCache();
    new SlitherlinkSolver({ width: puzzle.cols, height: puzzle.rows, task: puzzle.task }).solve();
  }
  const times = [];
  let solvedFlag = null;
  for (let i = 0; i < N; i++) {
    SlitherlinkSolver.clearSolutionCache();
    const s = new SlitherlinkSolver({ width: puzzle.cols, height: puzzle.rows, task: puzzle.task });
    s.maxMs = 30000;
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
  console.error('FAIL: one or more slitherlink bench puzzles did not solve');
  process.exit(1);
}
log('All slitherlink bench puzzles solved.');
```

- [ ] **Step 3: Add the package.json script**

In `package.json`'s `scripts`, add after `bench:yinyang`:

```json
    "bench:yinyang": "node tests/bench-yinyang.js",
    "bench:slitherlink": "node tests/bench-slitherlink.js"
```

(Make sure the previous line has a trailing comma after the new edit.)

- [ ] **Step 4: Add to the nightly workflow**

In `.github/workflows/bench-nightly.yml`, add after the `bench-yinyang.js` line:

```yaml
      - run: node tests/bench-slitherlink.js
```

- [ ] **Step 5: Run the bench**

Run: `npm run bench:slitherlink`
Expected: prints `All slitherlink bench puzzles solved.` and exits 0.

- [ ] **Step 6: Commit**

```bash
jj commit -m "test(slitherlink): bench script and real-puzzle fixture

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 19: Dump-button branch + CLAUDE.md + final verification

**Files:**
- Modify: `main-world.js` — `dumpPuzzleForBench` slitherlink branch
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add the dump-button branch**

In `main-world.js`'s `dumpPuzzleForBench` (around line 910 — after the yin-yang branch, before the galaxies branch), add:

```js
    if (path.indexOf('/loop/') !== -1) {
      if (!Array.isArray(g.task)) {
        return { error: 'slitherlink: g.task is not a 2D array', diagnostic: diagnostic(g), path: path };
      }
      var slTask = [];
      for (var r = 0; r < height; r++) {
        var srcRow = g.task[r] || [];
        var copyRow = [];
        for (var c = 0; c < width; c++) {
          var v = srcRow[c];
          copyRow.push((typeof v === 'number' && v >= 0 && v <= 3) ? v : -1);
        }
        slTask.push(copyRow);
      }
      return { type: 'slitherlink', rows: height, cols: width, task: slTask, path: path };
    }
```

- [ ] **Step 2: Update CLAUDE.md**

Update the intro line (currently "A Chrome MV3 extension that solves Nonogram, Aquarium, Galaxies, Binairo, Binairo Plus, Shikaku, and Yin-Yang puzzles…") to include Slitherlink:

```markdown
# Project conventions for Claude Code

A Chrome MV3 extension that solves Nonogram, Aquarium, Galaxies, Binairo,
Binairo Plus, Shikaku, Yin-Yang, and Slitherlink puzzles on puzzles-mobile.com.
Seven solver classes in `solver.js`, a content-script widget in `content.js`,
and a small service worker in `background.js`.
```

Add a Slitherlink encoding subsection after "Yin-Yang encoding" in the "Architectural notes" section:

```markdown
### Slitherlink encoding

The `/loop/*` path is served by a dedicated `SlitherlinkSolver` +
`slitherlinkHandler`. The puzzle is named "slitherlink" everywhere in code
to avoid colliding with the existing Loop button feature; the URL path
matcher still keys on `/loop/`.

Page encoding (edge-based, same shape as Galaxies):
- `window.Game.task` — 2D `int[H][W]`. `-1` = no clue; `0/1/2/3` = clue
  (count of loop edges around that cell).
- `window.Game.currentState.cellHorizontalStatus` — `(H+1) × W`,
  `0` = empty, `1` = line.
- `window.Game.currentState.cellVerticalStatus` — `H × (W+1)`,
  same encoding. (The page also uses `2` for player-placed × marks; the
  extension ignores those — apply only ever writes `0` or `1`.)

Internal solver edge encoding: `0 = UNKNOWN`, `1 = LINE`, `2 = EMPTY`. The
`1 = LINE` value was chosen so the solver→apply translation is a direct
write of `1` where LINE, `0` otherwise. Trail-based undo packs
`(kind << 25) | (oldValue << 24) | idx` into a single int per assign for
flat-array rollback.

Solver shape: `propagate()` iterates two sound local rules — clue forcing
(`_propagateClues`: `m > k` or `m + n < k` → contradiction; `m == k` →
remaining UNKNOWN edges → EMPTY; `m + n == k` → remaining UNKNOWN → LINE)
and vertex forcing (`_propagateVertices`: every dot's loop-degree ∈ {0, 2};
`m == 2` → remaining UNKNOWN → EMPTY; `m == 1, n == 1` → the unique
UNKNOWN → LINE; `m == 0, n == 1` → the unique UNKNOWN → EMPTY) — to a
fixpoint. Per-dot `lineCount` / `unknownCount` counters are maintained
incrementally on assign/rollback so the rules run in O(D + clued cells)
per pass.

Subloop prevention is via union-find over LINE-edge endpoints. The DSU
is **rebuilt from scratch** at the two callsites that need it
(`propagate()` post-fixpoint, `_backtrack()` at completion) rather than
maintained incrementally — keeping the trail+DSU invariants in sync under
backtracking is fiddly, and rebuild cost is O(LINE_count) which is cheap
relative to per-rule work. A closed cycle (DSU find collision on a new
LINE) is only valid when `_checkSingleLoopComplete()` passes — every clue
satisfied exactly, no UNKNOWN edges remain, every dot degree 0/2, and
all LINE edges in one connected component. Failure on either check
indicates a premature subloop and the branch is rejected.

Most-constrained variable pick at backtrack time: score each UNKNOWN edge
as `10 * max(lineCount[u], lineCount[v]) - min(unknownCount[u], unknownCount[v])`
(higher = more constrained). Branch LINE first, then EMPTY. Static
`_solutionCache` keyed on FNV-1a of `(width, height, task)`, 50-entry LRU.
Instance `maxMs` budget; the worker sets 30 s for large boards.

`getHint(curH, curV)` constructs a probe solver seeded from the current
edge state, runs `propagate()` only, and collects all newly-forced LINE
edges as `[{orientation: 'h' | 'v', r, c}, ...]`. Falls back to `solve()`
+ reveal-one-LINE-not-on-board when propagation deduces nothing.

MAIN-world: `readSlitherlinkData` / `readSlitherlinkState` /
`applySlitherlinkState`, twins of the Galaxies functions but without the
flood-fill region-build (we only care about the raw H/V arrays).
`applySlitherlinkState` calls `saveState(true)` before writes, then falls
through `drawCurrentState → render → redraw → draw` ladder.

The diff is **edge-based** — `computePuzzleDiff('slitherlink', board,
solution)` returns `[{orientation, r, c}, ...]` entries, not `{row, col}`
entries. Both `drawPreview`'s mistake overlay (paints wrong edges in red)
and `applyHintHandler` / `applyAndRunLoop` (read current edge state,
overlay hint edges, apply) branch on `puzzleData.type === 'slitherlink'`
to handle the edge shape. The Loop done-check is "every solution LINE
edge is also on the board", because Slitherlink boards never get
"all cells filled" — the empty-cell sentinel that other puzzles use to
detect completion doesn't apply.

`puzzleData.solution` for slitherlink is `{horizontal, vertical}` (not a
2D `number[][]`), so `getCachedGridSolution` / `cacheGridSolution` carry
a slitherlink-specific shape branch — straight 2D-grid serialization
would lose the structure. The cache localStorage key prefix is
`slitherlink-solution:`.
```

Update the MV3 hardening contract subsection to bump the allowlist count:

```markdown
- `background.js`'s `onMessage` listener rejects anything where `sender.id !== chrome.runtime.id` and gates `execMain` `funcName` against `EXEC_MAIN_ALLOWLIST` (20 entries). The TS-side mirror is `MainWorldFn` in `globals.d.ts`; keep them in sync.
```

(Search for "17 entries" in CLAUDE.md and update to "20 entries". If the exact wording differs from the example above, use the file's actual text and only change the count.)

- [ ] **Step 3: Final verification**

Run: `npm run build && npm run lint && npm run typecheck && npm test`
Expected: all four pass.

Run: `npm run bench:slitherlink`
Expected: prints `All slitherlink bench puzzles solved.` and exits 0.

- [ ] **Step 4: Commit**

```bash
jj commit -m "docs(slitherlink): document encoding and dump-button branch

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Final live check

After all tasks, manually verify in Chrome:

- [ ] Load `dist/` in Chrome.
- [ ] Open `https://www.puzzles-mobile.com/loop/random/5x5-normal`.
- [ ] Click **Detect**: status reads "Found 5×5 Slitherlink".
- [ ] Wait ~1s for auto-solve. The preview shows the full loop in dark strokes; if the board has any wrong edges, they ring red.
- [ ] Click **Solve**: preview shows the solution. Click **Confirm** → board fills with the loop.
- [ ] Reset, click **Hint** → preview ghosts one or more blue LINE edges; status names the edge. Click **Apply** → those edges appear on the board.
- [ ] Reset, click **Loop** → step-by-step solve; the button shows step counts.
- [ ] Click **📋 Dump** → clipboard contains a `{ type: 'slitherlink', rows: 5, cols: 5, task: [...] }` snippet.

## Notes for the implementer

- **No DOM access at top level of `handler.js`** (just like the existing handlers). The Node-only export tail (`if (typeof module ...)`) only exports `parseGalaxiesTask`; the slitherlink handler object is registered but its `matches()` / `detect()` methods only run when invoked.
- **Edge-state vs cell-grid shape:** several callers in `content.js` assume the grid is a 2D `number[][]`. Slitherlink's `puzzleData.solution` and the grid returned by `readState` are `{horizontal, vertical}` objects. Every code path that touches `grid` for slitherlink must dispatch on `puzzleData.type` first. The places this matters in the plan: `gridDataSig`, `getCachedGridSolution`/`cacheGridSolution`, `drawPreview`'s cell-paint loop, the mistake overlay, the Loop done-check.
- **`puzzleData.task`** is preserved by `detectHandler` for slitherlink (the spec's `detect()` returns `task`). The preview's clue-number drawing and `slitherlinkCluesSig` read it.
- **Hint shape consistency:** Task 7 (solver) → Task 14 (apply) → Task 16 (diff) all use `{orientation: 'h' | 'v', r, c}`. Don't mix it up with `{row, col}`.
- The `firstMismatch` check in the existing `getHint` for slitherlink is omitted because the edge shape doesn't match `firstMismatch`'s `grid[r][c]` API. The auto-solve diff overlay already shows mistakes live; the hint path doesn't need to gate on them.
