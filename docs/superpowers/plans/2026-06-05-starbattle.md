# Star Battle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full Star Battle (Detect / Solve / Hint / Loop) support — a cell-state CSP (k stars per row/column/region, no two stars 8-adjacent), both shaped (regions) and shapeless (walls) variants, any star count.

**Architecture:** A pure `StarBattleSolver` ports the page `getErrors` as its validity oracle (k per row/col/region + 8-adjacency + wall-avoidance), propagates count + adjacency deductions, MRV-backtracks (branch the tightest group's candidates), sound partial on timeout. Standard cell-state widget hooks (star-glyph `drawPreviewCell`); region borders reuse the existing `regionMap` preview infra; the star count is scraped from the page title text. No `preview.js`/`diff.js` change.

**Tech Stack:** Vanilla JS (`require`/`module.exports` for tests; concatenated into the Blob worker + content bundle by the two build scripts), `node:test`.

**Version control:** This repo uses **`jj`, never plain `git`**. Commit with `jj commit -m "..."`. Do NOT run `git add`/`git commit`.

**Commit trailer:** End every commit message with:
```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

**Lint gate:** the repo enforces `eqeqeq` — use `===`/`!==`, never `==`/`!=`. The plan code is lint-clean; keep it so.

**Validation status:** The solver is ported verbatim from a reference prototype validated end-to-end during planning: the oracle matches brute-force across 300 random 4×4 boards; solver-solved ⟺ brute-satisfiable on all; root deduction never prunes a valid cell; and the **real 14×14 hard 3-star board full-solves in ~0.8s, oracle-valid, with a UNIQUE solution (42/42 stars)**. Implement the code as written.

---

## Page encoding (recon — ground truth)

- slug `starbattle` (`/star-battle/`); board N×N, N = `puzzleWidth` = `puzzleHeight` = `puzzleWH`.
- `window.Game.task` is `[]`; structure is in `window.Game.areas` (shaped: N×N region map `0..N-1`; `walls=[]`) or `window.Game.walls` (shapeless: N×N `0/1`, 1=blocked; `areas` all-0).
- `cellStatus`: `0` empty, `1` star, `2` X-marker.
- Star count `k` = closure `f.stars` — NOT on `window.Game`. Scrape the page title text: `document.body.innerText` contains `"… / 3★ …"` → `/(\d+)\s*★/` → `k`.
- 8-neighbour offsets: `dr=[-1,-1,-1,0,1,1,1,0]`, `dc=[-1,0,1,1,1,0,-1,-1]`.

### Verbatim `getErrors` (the porting reference; `_isValid` below ports it)
```
function(t){ // counts stars per row s[], col r[], area i[]; flags 8-adjacent pairs ("proximate")
  ... for each cell with cellStatus==1: s[n]++, r[c]++, i[areas[n][c]]++; check 8 neighbours for another star -> cellErrors;
  if(t && cellErrors) return "proximate";
  if(f.stars) for h: 
    if(s[h]>f.stars) ... "rowMany";  if(r[h]>f.stars) ... "colMany";  if(!f.shapeless && i[h]>f.stars) ... "blockMany";
    if(s[h]<f.stars && (t||rowFull)) ... "rowFew"; if(r[h]<f.stars && (t||colFull)) ... "colFew";
    if(!f.shapeless && i[h]<f.stars && (t||areaFull)) ... "blockFew";
}
// => valid iff every row, column, and region (shaped) has exactly f.stars stars, and no two stars are 8-adjacent.
```

---

## File structure

| File | Change | Responsibility |
| --- | --- | --- |
| `src/solvers/starbattle.js` | **Create** | `StarBattleSolver`: oracle, count/adjacency propagation, MRV search, `solve()`, `_deduceForced` |
| `tests/starbattle.test.js` | **Create** | oracle units + brute-force soundness gate |
| `tests/bench-starbattle.js` | **Create** | perf bench on the real 14×14 |
| `tests/fixtures/real-puzzles.js` | Modify | `starbattle_14x14` fixture |
| `src/widget/puzzles/starbattle.js` | **Create** | widget registry module |
| `src/widget/puzzles/index.js` | Modify | register `starbattle` |
| `main-world.js` | Modify | `readStarBattleData`/`readStarBattleState`/`applyStarBattleState` + dump branch |
| `handler.js` | Modify | `starbattleHandler` + registration |
| `background.js`, `globals.d.ts`, `eslint.config.js` | Modify | allowlist / MainWorldFn / solver decl / globals |
| `solver.worker.js` | Modify | `starbattle` dispatch branch |
| `scripts/build-solver-bundle.js`, `scripts/build-content-bundle.js` | Modify | bundle FILES/EXPORTS/WIDGET_FILES |

(No `preview.js` change — region borders reuse `pd.regionMap`; no `diff.js` change — the default per-cell diff applies.)

---

## Task 1: Solver oracle + groups + helpers + brute harness

**Files:** Create `src/solvers/starbattle.js`; Test `tests/starbattle.test.js`.

- [ ] **Step 1: Write the failing oracle tests** — create `tests/starbattle.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { StarBattleSolver } = require('../src/solvers/starbattle.js');

// k stars per row/col/region (shaped: areas), no two stars 8-adjacent, no star on a wall (shapeless).
function mk(opts) { return new StarBattleSolver(opts); }
const QUAD = [[0, 0, 1, 1], [0, 0, 1, 1], [2, 2, 3, 3], [2, 2, 3, 3]]; // 4 quadrant regions

test('StarBattle oracle: a valid 4x4 k=1 board (1 star per row/col/region, no adjacency)', () => {
  const s = mk({ rows: 4, cols: 4, stars: 1, areas: QUAD });
  assert.equal(s._isValid([[0, 1, 0, 0], [0, 0, 0, 1], [1, 0, 0, 0], [0, 0, 1, 0]]), true);
});

test('StarBattle oracle: two 8-adjacent stars are invalid', () => {
  const s = mk({ rows: 4, cols: 4, stars: 1, areas: QUAD });
  assert.equal(s._isValid([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 0, 1], [0, 0, 1, 0]]), false); // (0,0)&(1,1) diagonal
});

test('StarBattle oracle: a wrong row count is invalid', () => {
  const s = mk({ rows: 4, cols: 4, stars: 1, areas: QUAD });
  assert.equal(s._isValid([[1, 0, 1, 0], [0, 1, 0, 0], [0, 0, 0, 1], [0, 0, 0, 0]]), false); // row 0 has 2
});

test('StarBattle oracle: a wrong region count is invalid', () => {
  const s = mk({ rows: 4, cols: 4, stars: 1, areas: QUAD });
  assert.equal(s._isValid([[0, 0, 1, 0], [0, 0, 0, 1], [1, 0, 0, 0], [0, 1, 0, 0]]), false); // region 0 has 0 stars
});

test('StarBattle oracle (shapeless): a star on a wall cell is invalid', () => {
  const s = mk({ rows: 4, cols: 4, stars: 1, walls: [[0, 0, 0, 0], [0, 1, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] });
  assert.equal(s._isValid([[0, 0, 0, 1], [0, 1, 0, 0], [1, 0, 0, 0], [0, 0, 1, 0]]), false); // star at (1,1) wall
});
```

- [ ] **Step 2: Run to verify it fails** — `node --test tests/starbattle.test.js` → FAIL (module not found).

- [ ] **Step 3: Create the solver skeleton + oracle** — create `src/solvers/starbattle.js`:

```js
'use strict';

// Star Battle solver — pure logic, no DOM.
//
// PAGE ENCODING (recon, ground truth)
//   N x N grid; cellStatus 0 empty, 1 star, 2 X-marker. Star count k = f.stars (scraped from page text).
//   Shaped: areas[r][c] = region id (0..N-1). Shapeless: walls[r][c] = 1 for blocked cells.
//
// VALIDITY (ported from the page getErrors; see the plan doc):
//   exactly k stars per row, per column, per region (shaped); no two stars 8-adjacent; no star on a wall (shapeless).
//
// METHOD: count + adjacency propagation, then MRV backtracking (branch the tightest group's candidate cells).
// On maxMs timeout returns the SOUND root-propagation snapshot (UNK=9). Soundness is brute-force-gated in
// tests/starbattle.test.js. The real 14x14 hard 3-star full-solves in ~0.8s (unique).
//
// Internal working grid g[r][c]: 0 unknown, 1 star, 2 no-star. Output cells: 1 star, 0 no-star, 9 UNK.

const STAR_DR = [-1, -1, -1, 0, 1, 1, 1, 0];
const STAR_DC = [-1, 0, 1, 1, 1, 0, -1, -1];

class StarBattleSolver {
  constructor({ rows, cols, stars, areas = null, walls = null, maxMs = 30000 } = {}) {
    this.rows = rows; this.cols = cols; this.k = stars; this.areas = areas; this.walls = walls; this.maxMs = maxMs;
    // Groups that each need exactly k stars: every row, every column, and (shaped) every region.
    this.groups = [];
    for (let r = 0; r < rows; r++) { const g = []; for (let c = 0; c < cols; c++) g.push([r, c]); this.groups.push(g); }
    for (let c = 0; c < cols; c++) { const g = []; for (let r = 0; r < rows; r++) g.push([r, c]); this.groups.push(g); }
    if (areas) {
      const byId = {};
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const a = areas[r][c]; (byId[a] = byId[a] || []).push([r, c]); }
      for (const id in byId) this.groups.push(byId[id]);
    }
  }

  // Full-board validity oracle (port of getErrors). cells fully decided: 1 star, 0 no-star.
  _isValid(cells) {
    const { rows, cols, k, areas, walls } = this;
    const rowc = new Array(rows).fill(0), colc = new Array(cols).fill(0);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (cells[r][c] === 1) {
      rowc[r]++; colc[c]++;
      if (walls && walls[r][c]) return false; // star on a wall
    }
    for (let r = 0; r < rows; r++) if (rowc[r] !== k) return false;
    for (let c = 0; c < cols; c++) if (colc[c] !== k) return false;
    if (areas) {
      const ac = {}, ids = new Set();
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { ids.add(areas[r][c]); if (cells[r][c] === 1) { const a = areas[r][c]; ac[a] = (ac[a] || 0) + 1; } }
      for (const id of ids) if ((ac[id] || 0) !== k) return false;
    }
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (cells[r][c] === 1) {
      for (let u = 0; u < 8; u++) { const nr = r + STAR_DR[u], nc = c + STAR_DC[u]; if (nr >= 0 && nc >= 0 && nr < rows && nc < cols && cells[nr][nc] === 1) return false; }
    }
    return true;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { StarBattleSolver };
}
```

- [ ] **Step 4: Run to verify oracle tests pass** — `node --test tests/starbattle.test.js` → PASS (5 tests).

- [ ] **Step 5: Commit** —
```
jj commit -m "feat(starbattle): solver oracle (_isValid) + groups + helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Propagation (adjacency + count forcing)

**Files:** Modify `src/solvers/starbattle.js`; Test (append) `tests/starbattle.test.js`.

- [ ] **Step 1: Append failing tests:**

```js
test('StarBattle propagation: a placed star crosses its 8 neighbours', () => {
  // 5x5 k=1, no regions: a star at (2,2) is feasible, so propagation succeeds and crosses all 8 neighbours.
  const s = mk({ rows: 5, cols: 5, stars: 1 });
  s._initGrid(); s.g[2][2] = 1; // a star at the centre
  assert.equal(s._propagate(), true);
  for (const [r, c] of [[1,1],[1,2],[1,3],[2,1],[2,3],[3,1],[3,2],[3,3]]) assert.equal(s.g[r][c], 2);
});

test('StarBattle propagation: a group with all-but-k crossed forces the rest to stars', () => {
  // row 0, k=1: cross 3 cells -> the 4th is forced a star.
  const s = mk({ rows: 4, cols: 4, stars: 1, areas: QUAD });
  s._initGrid(); s.g[0][0] = 2; s.g[0][1] = 2; s.g[0][2] = 2;
  assert.equal(s._propagate(), true);
  assert.equal(s.g[0][3], 1); // forced star
});

test('StarBattle propagation: over-filled row is a contradiction', () => {
  const s = mk({ rows: 4, cols: 4, stars: 1, areas: QUAD });
  s._initGrid(); s.g[0][0] = 1; s.g[0][2] = 1; // two stars in a k=1 row
  assert.equal(s._propagate(), false);
});
```

- [ ] **Step 2: Run to verify it fails** — `node --test tests/starbattle.test.js` → FAIL (`_initGrid`/`_propagate` not a function).

- [ ] **Step 3: Add propagation methods** inside the `StarBattleSolver` class:

```js
  _initGrid() {
    this.g = Array.from({ length: this.rows }, () => new Array(this.cols).fill(0));
    if (this.walls) for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) if (this.walls[r][c]) this.g[r][c] = 2;
  }

  // Set cell (r,c) to val (1 star / 2 no-star). Returns false on a conflicting prior value.
  _set(r, c, val) {
    if (this.g[r][c] === val) return true;
    if (this.g[r][c] !== 0) return false;
    this.g[r][c] = val; this._dirty = true; return true;
  }

  // Adjacency + group-count forcing to a fixpoint. Returns false on contradiction.
  _propagate() {
    this._dirty = true;
    while (this._dirty) {
      this._dirty = false;
      // Adjacency: every star crosses its 8 neighbours; two adjacent stars = contradiction.
      for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) if (this.g[r][c] === 1) {
        for (let u = 0; u < 8; u++) {
          const nr = r + STAR_DR[u], nc = c + STAR_DC[u];
          if (nr >= 0 && nc >= 0 && nr < this.rows && nc < this.cols) {
            if (this.g[nr][nc] === 1) return false;
            if (this.g[nr][nc] === 0) { this.g[nr][nc] = 2; this._dirty = true; }
          }
        }
      }
      // Group count: each row/col/region needs exactly k stars.
      for (const grp of this.groups) {
        let s = 0; const unk = [];
        for (const [r, c] of grp) { const v = this.g[r][c]; if (v === 1) s++; else if (v === 0) unk.push([r, c]); }
        if (s > this.k) return false;
        if (s + unk.length < this.k) return false;
        if (s === this.k && unk.length) { for (const [r, c] of unk) if (!this._set(r, c, 2)) return false; }
        else if (s + unk.length === this.k && unk.length) { for (const [r, c] of unk) if (!this._set(r, c, 1)) return false; }
      }
    }
    return true;
  }
```

- [ ] **Step 4: Run to verify it passes** — `node --test tests/starbattle.test.js` → PASS.

- [ ] **Step 5: Commit** —
```
jj commit -m "feat(starbattle): adjacency + group-count propagation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Search + solve() + sound partial + brute-force soundness gate

**Files:** Modify `src/solvers/starbattle.js`; Test (append) `tests/starbattle.test.js`.

- [ ] **Step 1: Append the soundness gate + solve tests:**

```js
// Brute-force ALL 2^cells star placements; keep those passing _isValid.
function bruteForce(rows, cols, k, areas) {
  const s = new StarBattleSolver({ rows, cols, stars: k, areas }); const n = rows * cols; const sols = [];
  for (let mask = 0; mask < (1 << n); mask++) {
    const cells = []; let b = 0;
    for (let r = 0; r < rows; r++) { cells.push([]); for (let c = 0; c < cols; c++) { cells[r].push(((mask >> b) & 1) ? 1 : 0); b++; } }
    if (s._isValid(cells)) sols.push(cells.map(r => r.slice()));
  }
  return sols;
}
function randAreas(seed, rows, cols, nreg) {
  let x = seed; const rnd = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; };
  const a = []; for (let r = 0; r < rows; r++) { a.push([]); for (let c = 0; c < cols; c++) a[r].push(Math.floor(rnd() * nreg)); } return a;
}

test('StarBattle soundness gate: solver matches brute-force across 300 random 4x4 k=1 boards', () => {
  let mism = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const areas = randAreas(seed, 4, 4, 4); const sols = bruteForce(4, 4, 1, areas);
    const res = new StarBattleSolver({ rows: 4, cols: 4, stars: 1, areas, maxMs: 3000 }).solve();
    if (res.solved !== (sols.length > 0)) { mism++; continue; }
    if (res.solved && !new StarBattleSolver({ rows: 4, cols: 4, stars: 1, areas })._isValid(res.cells)) mism++;
  }
  assert.equal(mism, 0);
});

test('StarBattle soundness: root deduction never prunes a cell a solution uses', () => {
  for (let seed = 1; seed <= 120; seed++) {
    const areas = randAreas(seed, 4, 4, 4); const sols = bruteForce(4, 4, 1, areas); if (!sols.length) continue;
    const s = new StarBattleSolver({ rows: 4, cols: 4, stars: 1, areas }); s._initGrid(); s._deadline = Date.now() + 3000;
    assert.ok(s._propagate(), `propagation contradicted a solvable board seed ${seed}`);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
      const v = s.g[r][c];
      if (v === 1) for (const sol of sols) assert.equal(sol[r][c], 1, `prune-star seed ${seed}`);
      if (v === 2) for (const sol of sols) assert.equal(sol[r][c], 0, `prune-nostar seed ${seed}`);
    }
  }
});

test('StarBattle solve: the quad board solves to a valid board', () => {
  const res = new StarBattleSolver({ rows: 4, cols: 4, stars: 1, areas: QUAD, maxMs: 5000 }).solve();
  assert.equal(res.solved, true);
  assert.ok(new StarBattleSolver({ rows: 4, cols: 4, stars: 1, areas: QUAD })._isValid(res.cells));
});
```

- [ ] **Step 2: Run to verify it fails** — `node --test tests/starbattle.test.js` → FAIL (`solve is not a function`).

- [ ] **Step 3: Add search/solve** inside the `StarBattleSolver` class:

```js
  _snapshot() { return this.g.map(r => r.slice()); }
  _restore(s) { this.g = s.map(r => r.slice()); }

  // Pick a candidate cell from the group (row/col/region) with the fewest unknowns that still needs stars.
  _pick() {
    let best = null, bestN = Infinity;
    for (const grp of this.groups) {
      let s = 0; const unk = [];
      for (const [r, c] of grp) { const v = this.g[r][c]; if (v === 1) s++; else if (v === 0) unk.push([r, c]); }
      if (s < this.k && unk.length && unk.length < bestN) { bestN = unk.length; best = unk; }
    }
    return best ? best[0] : null;
  }

  _search() {
    if (Date.now() > this._deadline) { this._timedOut = true; return null; }
    const cell = this._pick();
    if (!cell) { const cells = this.g.map(r => r.map(v => v === 1 ? 1 : 0)); return this._isValid(cells) ? cells : null; }
    const [r, c] = cell;
    for (const val of [1, 2]) {
      const snap = this._snapshot();
      if (this._set(r, c, val) && this._propagate()) { const res = this._search(); if (res) return res; }
      this._restore(snap);
    }
    return null;
  }

  solve() {
    this._initGrid();
    this._deadline = Date.now() + this.maxMs; this._timedOut = false;
    if (!this._propagate()) return { solved: false, error: 'No solution (contradiction in givens)' };
    const root = this.g.map(r => r.map(v => v === 1 ? 1 : (v === 2 ? 0 : 9)));
    const res = this._search();
    if (res) return { solved: true, cells: res.map(r => r.slice()) };
    if (this._timedOut) return { solved: false, partial: true, cells: root };
    return { solved: false, error: 'No solution found' };
  }
```

- [ ] **Step 4: Run to verify it passes** — `node --test tests/starbattle.test.js` → PASS (all oracle, propagation, soundness, solve tests). Then `npm test` → full suite PASS.

- [ ] **Step 5: Commit** —
```
jj commit -m "feat(starbattle): MRV search + solve() with sound partial; brute-force gate

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `_deduceForced` hint + solver-bundle/worker/globals wiring

**Files:** Modify `src/solvers/starbattle.js`, `scripts/build-solver-bundle.js`, `solver.worker.js`, `globals.d.ts`; Test (append) `tests/starbattle.test.js`.

- [ ] **Step 1: Append the hint test:**

```js
test('StarBattle _deduceForced: a seeded star forces no-star cells (adjacency + counts)', () => {
  const s = new StarBattleSolver({ rows: 4, cols: 4, stars: 1, areas: QUAD, maxMs: 1000 });
  // live cellStatus: a star at (0,1) (value 1), everything else unknown (0).
  const cur = [[0, 1, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  const forced = s._deduceForced(cur);
  const has = (r, c, v) => forced.some(f => f.row === r && f.col === c && f.value === v);
  assert.ok(has(0, 0, 2) && has(1, 0, 2) && has(2, 1, 2), 'adjacency + group counts force no-stars');
  assert.ok(forced.every(f => f.value === 1 || f.value === 2), 'forced values are star(1) or no-star(2)');
});
```

- [ ] **Step 2: Run to verify it fails** — `node --test tests/starbattle.test.js` → FAIL (`_deduceForced is not a function`).

- [ ] **Step 3: Add `_deduceForced`** inside the `StarBattleSolver` class:

```js
  // Hint engine: seed the solver with the live cellStatus (1 star, 2 X/no-star, 0 unknown), deduce to a fixpoint,
  // and return the newly-forced cells as { row, col, value } (value 1 = star, 2 = no-star). Returns [] if the live
  // board is contradictory (caller falls back to the cached-solution diff).
  _deduceForced(curCells) {
    this._initGrid();
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) {
      const v = curCells[r][c];
      if (v === 1) { if (!this._set(r, c, 1)) return []; }
      else if (v === 2) { if (!this._set(r, c, 2)) return []; }
    }
    this._deadline = Date.now() + (this.maxMs || 2000);
    if (!this._propagate()) return [];
    const forced = [];
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) {
      if (curCells[r][c] === 1 || curCells[r][c] === 2) continue;
      const v = this.g[r][c];
      if (v === 1) forced.push({ row: r, col: c, value: 1 });
      else if (v === 2) forced.push({ row: r, col: c, value: 2 });
    }
    return forced;
  }
```

- [ ] **Step 4: Run to verify it passes** — `node --test tests/starbattle.test.js` → PASS.

- [ ] **Step 5: Wire the solver bundle.** In `scripts/build-solver-bundle.js`, add `'starbattle.js'` to `FILES` (after `'lightup.js'`, before `'diff.js'`):
```js
  'lightup.js',
  'slant.js',
  'starbattle.js',
  'diff.js',
```
(adjust to the actual surrounding lines — place `'starbattle.js'` among the cell-puzzle entries, before `'diff.js'`); and add `'StarBattleSolver'` to `EXPORTS` (after `'SlantSolver'`):
```js
  ... 'LightUpSolver', 'SlantSolver', 'StarBattleSolver', 'computePuzzleDiff',
```

- [ ] **Step 6: Worker dispatch.** In `solver.worker.js`: append `StarBattleSolver` to the `/* global ... */` comment, then add the branch beside slant's:
```js
    } else if (type === 'starbattle' && extraData) {
      const s = new StarBattleSolver({ rows: extraData.rows, cols: extraData.cols, stars: extraData.stars, areas: extraData.areas, walls: extraData.walls, maxMs: 30000 });
      result = s.solve();
```

- [ ] **Step 7: Globals.** In `globals.d.ts`, after `declare const SlantSolver: any;` add `declare const StarBattleSolver: any;`.

- [ ] **Step 8: Build + verify.** `npm run build && npm test` → build writes `dist/solver.js`+`dist/content.js` with no surviving-require errors; `grep -c 'class StarBattleSolver' dist/solver.js` ≥ 1; suite PASS. Also `npm run lint && npm run typecheck` → clean.

- [ ] **Step 9: Commit** —
```
jj commit -m "feat(starbattle): _deduceForced hint + solver bundle/worker/globals wiring

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: MAIN-world read/apply (incl. ★ scrape) + allowlist + MainWorldFn

**Files:** Modify `main-world.js`, `background.js`, `globals.d.ts`.

**Context:** MAIN-world functions are serialized via `fn.toString()` — reference only `window.Game`/`document`/their own `var`s, no outer-scope helpers or sibling-function calls. `readStarBattleData` scrapes the star count from `document.body.innerText` via `/(\d+)\s*★/`, detects shaped (multi-region `areas`) vs shapeless (`walls` with a 1), and returns `{rows, cols, stars, areas, walls}` (the unused one null). `applyStarBattleState` writes `cellStatus`: `saveState(true)` before, `1→1` (star) / `2→2` (X), skip UNK(9), render ladder after, never `check()`. The 3 names go in BOTH `background.js`'s `EXEC_MAIN_ALLOWLIST` AND `globals.d.ts`'s `MainWorldFn`. Build-relevant → run `npm run build`.

- [ ] **Step 1: Add the three functions** in `main-world.js` after the `applySlantState` function (search `function applySlantState`):

```js
function readStarBattleData() {
  try {
    var G = window.Game;
    if (!G || !G.puzzleWidth || !G.puzzleHeight) return null;
    var N = G.puzzleWidth;
    // Star count: scrape the page title text ("14x14 / 3★ Hard Star Battle").
    var stars = null;
    try { var m = (document.body.innerText || '').match(/(\d+)\s*★/); if (m) stars = parseInt(m[1], 10); } catch (e2) {}
    if (stars === null) { try { var m2 = (document.body.innerText || '').match(/(\d+)\s*stars?\b/i); if (m2) stars = parseInt(m2[1], 10); } catch (e3) {} }
    // Detect shapeless (walls with a 1) vs shaped (multi-region areas).
    var walls = null, areas = null;
    var hasWall = Array.isArray(G.walls) && G.walls.length > 0;
    if (hasWall) {
      var anyWall = false;
      for (var wr = 0; wr < G.walls.length; wr++) { var row = G.walls[wr] || []; for (var wc = 0; wc < row.length; wc++) if (row[wc] === 1) anyWall = true; }
      if (anyWall) { walls = G.walls.map(function (r) { return r.slice(); }); }
    }
    if (!walls && Array.isArray(G.areas) && G.areas.length > 0) {
      var distinct = {}; for (var ar = 0; ar < G.areas.length; ar++) { var arow = G.areas[ar] || []; for (var ac = 0; ac < arow.length; ac++) distinct[arow[ac]] = 1; }
      if (Object.keys(distinct).length > 1) areas = G.areas.map(function (r) { return r.slice(); });
    }
    return { rows: N, cols: N, stars: stars, areas: areas, walls: walls };
  } catch (e) { return null; }
}

function readStarBattleState() {
  try {
    var s = window.Game.currentState.cellStatus;
    return { cellStatus: s.map(function (row) { return row.slice(); }) };
  } catch (e) { return null; }
}

function applyStarBattleState(solution) {
  try {
    var G = window.Game;
    if (!solution || !solution.cells) return false;
    if (!(G && G.currentState)) return false;
    if (typeof G.saveState === 'function') G.saveState(true);
    var cells = solution.cells; // 1 star, 2 no-star/X, 9 UNK / 0 (skip)
    for (var r = 0; r < cells.length; r++) for (var c = 0; c < cells[r].length; c++) {
      var v = cells[r][c];
      if (v === 1) G.currentState.cellStatus[r][c] = 1;
      else if (v === 2) G.currentState.cellStatus[r][c] = 2;
    }
    if (typeof G.drawCurrentState === 'function') G.drawCurrentState();
    else if (typeof G.render === 'function') G.render();
    else if (typeof G.redraw === 'function') G.redraw();
    else if (typeof G.redrawGrid === 'function') G.redrawGrid();
    else if (typeof G.draw === 'function') G.draw();
    else if (G.getSaved && G.loadGame) { var saved = G.getSaved(); if (saved) G.loadGame(saved); }
    return true;
  } catch (e) { return false; }
}
```

- [ ] **Step 2: Dump branch.** In `dumpPuzzleForBench`, after the `/slant/` branch (search `'/slant/'`), add:
```js
    if (path.indexOf('/star-battle/') !== -1) {
      var sbStars = null;
      try { var sm = (document.body.innerText || '').match(/(\d+)\s*★/); if (sm) sbStars = parseInt(sm[1], 10); } catch (se) {}
      return { type: 'starbattle', rows: window.Game.puzzleHeight, cols: window.Game.puzzleWidth, stars: sbStars, areas: window.Game.areas, walls: window.Game.walls, path: path };
    }
```

- [ ] **Step 3: Allowlist.** In `background.js` `EXEC_MAIN_ALLOWLIST`, after the three `...Slant...` entries add `'readStarBattleData'`, `'readStarBattleState'`, `'applyStarBattleState'`.

- [ ] **Step 4: MainWorldFn.** In `globals.d.ts` `MainWorldFn`, after the three Slant entries add `| 'readStarBattleData'`, `| 'readStarBattleState'`, `| 'applyStarBattleState'`.

- [ ] **Step 5: Verify** — `npm run build && npm run typecheck && npm run lint && npm test` → all PASS; confirm all three names appear in BOTH `background.js` and `globals.d.ts`.

- [ ] **Step 6: Commit** —
```
jj commit -m "feat(starbattle): MAIN-world read/apply (star-count scrape) + dump + allowlist/MainWorldFn

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Handler registration

**Files:** Modify `handler.js`.

**Context:** Register at load; no top-level `document`/`window`/`chrome` access outside function bodies. `readState` returns a **normalized 0/1 board** (`cellStatus 1→1` star, else→0) so the default per-cell diff flags only wrongly-placed stars. `detect` returns `regionMap: data.areas` so the preview draws region borders (shaped). `applySolution` wraps cells as `{ cells }` for `applyStarBattleState`.

- [ ] **Step 1:** After `registerHandler(slantHandler);`, add:

```js
const starbattleHandler = {
  name: 'puzzles-mobile-starbattle',
  priority: 30,

  matches() {
    return isPuzzlesMobilePage() &&
           window.location.pathname.includes('/star-battle/');
  },

  async detect() {
    const result = { found: false, rows: 0, cols: 0, rowClues: [], colClues: [] };
    const data = await callMainWorld('readStarBattleData', []);
    if (!data) return { ...result, error: 'No Star Battle task data found' };
    const stageEl = document.getElementById('stage') ||
                    document.getElementById('game') ||
                    document.querySelector('[class*="game"], [class*="puzzle"]');
    return {
      found: true,
      type: 'starbattle',
      rows: data.rows,
      cols: data.cols,
      stars: data.stars,
      areas: data.areas,
      walls: data.walls,
      regionMap: data.areas, // drives the preview region borders (shaped)
      rowClues: [],
      colClues: [],
      _cells: [],
      _element: stageEl,
    };
  },

  // Normalized board: star (cellStatus 1) -> 1, everything else -> 0. The default per-cell
  // diff then flags only wrongly-placed stars (board 1 where the solution has 0); X-marks and
  // blanks read as 0 and are never flagged.
  async readState(ctx) {
    const state = await callMainWorld('readStarBattleState', []);
    const cs = state && state.cellStatus;
    const rows = (ctx && ctx.rows) || (cs ? cs.length : 0);
    const cols = (ctx && ctx.cols) || (cs && cs[0] ? cs[0].length : 0);
    const grid = [];
    for (let r = 0; r < rows; r++) {
      const row = new Array(cols).fill(0);
      for (let c = 0; c < cols; c++) { const v = cs && cs[r] ? cs[r][c] : 0; row[c] = (v === 1) ? 1 : 0; }
      grid.push(row);
    }
    return grid;
  },

  async applySolution(solution, _ctx) {
    const cells = Array.isArray(solution) ? solution : (solution && solution.cells);
    if (!Array.isArray(cells)) {
      return { success: false, error: 'Star Battle applySolution: missing cells' };
    }
    const ok = await callMainWorld('applyStarBattleState', [{ cells }]);
    return ok
      ? { success: true }
      : { success: false, error: 'Star Battle apply failed (no window.Game or MAIN-world timeout)' };
  },
};

registerHandler(starbattleHandler);
```

- [ ] **Step 2: Verify** — `npm run build && npm run lint && npm run typecheck && npm test` → all PASS (the suite `require`s handler.js under Node, confirming clean require).

- [ ] **Step 3: Commit** —
```
jj commit -m "feat(starbattle): handler (detect/readState/applySolution) + registration

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Widget registry module + registration + content bundle + eslint

**Files:** Create `src/widget/puzzles/starbattle.js`; Modify `src/widget/puzzles/index.js`, `scripts/build-content-bundle.js`, `eslint.config.js`.

- [ ] **Step 1: Create `src/widget/puzzles/starbattle.js`:**

```js
'use strict';

const { hashFNV1a } = require('../shared.js');

// Star Battle widget module — detect / solve / hint / loop / preview hooks.
//
// CELL MODEL: per-cell board-state grid; each cell is 1 = star or 0 = no-star (UNK=9 in solver
// partials). The solver returns { solved, cells, partial?, error? }; solutionFromResult returns the
// bare 2-D cells array so the preview cell-loop, the default per-cell mistake-diff, undo/redo and the
// cache share one shape. The handler's readState returns a normalized 0/1 board (star=1, else 0);
// region borders come from puzzleData.regionMap (the shaped areas) via the existing preview infra.
//
// HINT (deductive): hintDispatch reads the raw cellStatus (1 star, 2 X, 0 unknown), runs
// StarBattleSolver._deduceForced, reports newly-forced cells (stars AND no-stars), batch-capped;
// falls back to revealing the next cached-solution stars.
//
// TWO VALUE-SPACES (don't conflate): the board/solution grid is {0 no-star, 1 star} (used by
// solutionFromResult, loopDoneCheck, firstMismatch, the per-cell diff); the hint extraCells AND the
// cellStatus apply path are {1 star, 2 no-star/X} (used by _deduceForced and applyStarBattleState).

function hintBatchCap(rows, cols) { return Math.max(4, Math.ceil((rows * cols) / 30)); }

const starbattle = {
  type: 'starbattle',
  label: 'Star Battle',
  url: 'https://www.puzzles-mobile.com/star-battle/',
  solutionKeyPrefix: 'starbattle-solution:',
  hasAbsoluteHintCells: true,
  hintBandSkip: true,
  renderEmptyCells: true,

  cacheKey(data) {
    if (!data || data.type !== 'starbattle') return null;
    // FNV-1a over (nameplate 'B'=0x42, rows, cols, stars, flattened areas|walls).
    const h = hashFNV1a((mix) => {
      mix(0x42); mix(data.rows | 0); mix(data.cols | 0); mix((data.stars | 0) + 1);
      const grid = data.areas || data.walls || [];
      for (let r = 0; r < grid.length; r++) { const row = grid[r] || []; for (let c = 0; c < row.length; c++) mix((row[c] | 0) + 1); }
    });
    return 'starbattle-solution:' + h.toString(16);
  },

  canvasDims(pd, { grid }) {
    return {
      rows: pd?.rows || (Array.isArray(grid) ? grid.length : 0),
      cols: pd?.cols || (Array.isArray(grid) && grid[0] ? grid[0].length : 0),
      marginCells: 0,
    };
  },

  staticSig(data) { return 'sb=' + _starbattleSig(data?.type === 'starbattle' ? data : null); },

  // Static layer: outer border + wall cells (shapeless). Region borders (shaped) are drawn from
  // puzzleData.regionMap by preview.js's shared region-border renderer.
  drawStaticLayer(ctx, { rows, cols, cellSize, pd }) {
    ctx.save();
    const walls = pd && pd.walls;
    if (Array.isArray(walls)) {
      ctx.fillStyle = '#1f2937';
      for (let r = 0; r < rows; r++) { const row = walls[r] || []; for (let c = 0; c < cols; c++) if (row[c] === 1) ctx.fillRect(c * cellSize, r * cellSize, cellSize, cellSize); }
    }
    const borderW = Math.max(2, Math.floor(cellSize / 6));
    ctx.strokeStyle = '#1f2937'; ctx.lineWidth = borderW; ctx.lineCap = 'square';
    ctx.strokeRect(borderW / 2, borderW / 2, cols * cellSize - borderW, rows * cellSize - borderW);
    ctx.restore();
  },

  // Dynamic per-cell render: a star glyph for value 1.
  drawPreviewCell(ctx, { v, x, y, cellSize }) {
    if (v === 1) _drawStar(ctx, x, y, cellSize, '#f59e0b');
  },

  drawHintCell(ctx, { cell, cx, cy, cellSize }) {
    if (cell.value === 1) _drawStar(ctx, cx, cy, cellSize, 'rgba(46, 134, 222, 0.85)');
    else { // forced no-star: a light ring
      ctx.save(); ctx.strokeStyle = '#60a5fa'; ctx.lineWidth = Math.max(2, Math.floor(cellSize / 9));
      ctx.strokeRect(cx + 2, cy + 2, cellSize - 4, cellSize - 4); ctx.restore();
    }
  },

  hintStatusNodes(h, { bold }) {
    const cells = h.extraCells || [];
    if (cells.length === 0) return ['No hint available'];
    if (cells.length === 1) {
      const cell = cells[0];
      const label = cell.value === 1 ? 'a star' : 'no star';
      return ['Cell ', bold(`(row ${cell.row + 1}, col ${cell.col + 1})`), ' is ', bold(label)];
    }
    return [bold(String(cells.length)), ' cells can be deduced'];
  },

  solveExtraData(data) { return { rows: data.rows, cols: data.cols, stars: data.stars, areas: data.areas, walls: data.walls }; },
  solutionFromResult(result) { return result && result.cells ? result.cells : null; },
  solutionToCacheJson(solution) { return Array.isArray(solution) ? { cells: solution.map((row) => row.slice()) } : null; },
  solutionFromCacheJson(parsed) { return (parsed && Array.isArray(parsed.cells)) ? parsed.cells.map((row) => row.slice()) : null; },

  // Deductive hint. ctx: { detectedGrid, grid, solution, rows, cols, callMainWorld, firstMismatch }.
  async hintDispatch(ctx) {
    const { callMainWorld, solution, rows, cols, detectedGrid, grid, firstMismatch } = ctx;
    if (solution && firstMismatch && firstMismatch(grid, solution)) {
      return { success: false, error: 'Current game state is wrong.' };
    }
    if (detectedGrid && typeof detectedGrid.stars === 'number') {
      try {
        const state = await callMainWorld('readStarBattleState', []);
        const cs = state && state.cellStatus;
        if (Array.isArray(cs)) {
          const Solver = (typeof StarBattleSolver !== 'undefined') ? StarBattleSolver : require('../../solvers/starbattle.js').StarBattleSolver;
          const solver = new Solver({ rows, cols, stars: detectedGrid.stars, areas: detectedGrid.areas, walls: detectedGrid.walls, maxMs: 1500 });
          const forced = solver._deduceForced(cs);
          if (forced && forced.length) {
            const batch = forced.slice(0, hintBatchCap(rows, cols));
            return { success: true, hint: { type: 'starbattle', extraCells: batch, count: batch.length }, grid, solution };
          }
        }
      } catch { /* fall through */ }
    }
    if (!Array.isArray(solution)) return { success: false, error: 'No solution available' };
    const cap = hintBatchCap(rows, cols);
    const cells = [];
    for (let r = 0; r < solution.length && cells.length < cap; r++) {
      const sRow = solution[r] || [];
      for (let c = 0; c < sRow.length && cells.length < cap; c++) {
        const cur = grid && grid[r] ? grid[r][c] : 0;
        if (sRow[c] === 1 && cur !== 1) cells.push({ row: r, col: c, value: 1 });
      }
    }
    if (!cells.length) return { success: false, error: 'No hint available' };
    return { success: true, hint: { type: 'starbattle', extraCells: cells, count: cells.length }, grid, solution };
  },

  // ctx: { boardState, solution, puzzleData }. Done when every solution star is on the board.
  loopDoneCheck(ctx) {
    const { boardState, solution } = ctx;
    if (!Array.isArray(solution) || !Array.isArray(boardState)) return false;
    for (let r = 0; r < solution.length; r++) {
      const sRow = solution[r] || [], bRow = boardState[r] || [];
      for (let c = 0; c < sRow.length; c++) { if (sRow[c] === 1 && bRow[c] !== 1) return false; }
    }
    return true;
  },

  // Apply a hint batch: write ONLY the hint cells (UNK=9 elsewhere; applyStarBattleState skips UNK).
  async applyHint(hint, { callMainWorld, puzzleData }) {
    const rows = puzzleData ? puzzleData.rows : 0;
    const cols = puzzleData ? puzzleData.cols : 0;
    const cells = [];
    for (let r = 0; r < rows; r++) cells.push(new Array(cols).fill(9));
    for (const cell of (hint.extraCells || [])) { if (cells[cell.row]) cells[cell.row][cell.col] = cell.value; }
    const ok = await callMainWorld('applyStarBattleState', [{ cells }]);
    return ok === true;
  },

  // Partial-Solve UI: solver timed out and returned { partial:true, cells } (UNK=9 where open).
  partialResultArm(result, {
    clearPendingHint, setStatus, drawPreview, setConfirming, setLoopConfirming, setSolveBtnText,
  }) {
    setLoopConfirming(false); clearPendingHint(); setSolveBtnText('Confirm'); setConfirming(true);
    const cells = (result.cells || []).map((row) => row.map((v) => (v === 1 ? 1 : 0)));
    let placed = 0, total = 0;
    for (const row of result.cells || []) for (const v of row) { total++; if (v === 1 || v === 0) placed++; }
    const pct = total > 0 ? Math.round(100 * placed / total) : 0;
    setStatus(`Partial only: ${placed} cells deduced (${pct}% of cells, too hard for a full solve). Apply, then finish manually.`, 'info');
    drawPreview(cells);
  },
};

// Draw a star glyph (the ★ character) centred in the cell.
function _drawStar(ctx, x, y, size, fill) {
  ctx.save();
  ctx.fillStyle = fill;
  ctx.font = `${Math.floor(size * 0.8)}px serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('★', x + size / 2, y + size / 2 + size * 0.04);
  ctx.restore();
}

function _starbattleSig(data) {
  if (!data) return '0';
  const grid = data.areas || data.walls || [];
  const h = hashFNV1a((mix) => { mix((data.stars | 0) + 1); for (const row of grid) for (const v of row) mix(((v | 0) + 1) & 0xff); });
  return h.toString(16);
}

if (typeof module !== 'undefined' && module.exports) { module.exports = starbattle; }
```

- [ ] **Step 2: Register** in `src/widget/puzzles/index.js`, after the slant line:
```js
if (typeof starbattle !== 'undefined') PUZZLES[starbattle.type] = starbattle;
```

- [ ] **Step 3: Content bundle** — in `scripts/build-content-bundle.js` `WIDGET_FILES`, add `'puzzles/starbattle.js'` after `'puzzles/slant.js'` (before `'puzzles/index.js'`).

- [ ] **Step 4: eslint globals** — in `eslint.config.js`, add `StarBattleSolver: 'readonly'` to the `solverClasses` block (after `SlantSolver`) and `starbattle: 'readonly'` to the widget-puzzles globals block (after `slant`).

- [ ] **Step 5: Build + verify** — `npm run build && npm run lint && npm run typecheck && npm test` → all PASS; `grep -c "type: 'starbattle'" dist/content.js` ≥ 1; no surviving-require errors.

- [ ] **Step 6: Commit** —
```
jj commit -m "feat(starbattle): widget registry module + registration + content bundle + eslint

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Real 14×14 fixture + bench + final build

**Files:** Modify `tests/fixtures/real-puzzles.js`; Create `tests/bench-starbattle.js`.

- [ ] **Step 1: Add the fixture** — in `tests/fixtures/real-puzzles.js`, after the `slant_20x20` entry, add the captured real board (shaped 14×14, 14 regions, 3 stars):

```js
  starbattle_14x14: {
    type: 'starbattle', rows: 14, cols: 14, stars: 3,
    areas: [
      [0,0,0,0,0,0,0,0,0,1,1,1,1,1],
      [0,0,2,3,3,0,0,4,5,1,1,1,1,1],
      [6,2,2,2,3,0,4,4,5,5,5,5,5,1],
      [6,2,3,2,3,4,4,4,4,5,5,5,5,1],
      [6,2,3,3,3,4,3,3,4,5,5,5,1,1],
      [6,2,2,2,3,3,3,3,4,4,5,1,1,7],
      [6,2,8,2,9,3,10,10,10,5,5,5,5,7],
      [6,6,8,9,9,9,9,10,5,5,7,7,7,7],
      [6,8,8,8,8,9,9,10,10,5,5,7,11,11],
      [8,8,9,8,9,9,9,9,10,5,10,7,7,11],
      [8,9,9,9,9,9,12,9,10,10,10,10,7,11],
      [8,8,9,9,12,12,12,9,10,10,11,11,11,11],
      [12,12,9,12,12,12,12,10,10,13,11,13,13,11],
      [12,12,12,12,10,10,10,10,13,13,13,13,13,13],
    ],
  },
```

- [ ] **Step 2: Create `tests/bench-starbattle.js`:**

```js
'use strict';
// Bench the Star Battle solver on the real 14x14 capture. Reports wall + star count.
const { StarBattleSolver } = require('../src/solvers/starbattle.js');
const real = require('./fixtures/real-puzzles.js');
const puz = real.starbattle_14x14 || (real.puzzles && real.puzzles.starbattle_14x14);
if (!puz) { console.error('starbattle_14x14 fixture missing'); process.exit(1); }

function run(maxMs) {
  const t0 = Date.now();
  const res = new StarBattleSolver({ rows: 14, cols: 14, stars: 3, areas: puz.areas, maxMs }).solve();
  const wall = Date.now() - t0;
  let stars = 0; if (res.cells) for (const row of res.cells) for (const v of row) if (v === 1) stars++;
  return { res, wall, stars };
}
run(2000); run(2000); // warmup
const { res, wall, stars } = run(30000);
console.log(`starbattle 14x14 k=3: solved=${res.solved} partial=${!!res.partial} wall=${wall}ms stars=${stars}/42`);
if (res.solved) {
  const ok = new StarBattleSolver({ rows: 14, cols: 14, stars: 3, areas: puz.areas })._isValid(res.cells);
  if (!ok) { console.error('FAIL: solved output failed the oracle'); process.exit(1); }
  console.log('full solve verified by oracle');
} else if (res.partial) {
  console.log('returned a sound partial (root-deduction snapshot)');
} else {
  console.error('FAIL: solver returned neither solution nor partial'); process.exit(1);
}
```

- [ ] **Step 3: Run the bench** — `node tests/bench-starbattle.js`. Expected (measured in planning): `solved=true wall=~800ms stars=42/42` + `full solve verified by oracle`. Record the actual line in the commit message.

- [ ] **Step 4: Final verification** — `npm run build && npm test && npm run lint && npm run typecheck` → all PASS; `dist/` rebuilt.

- [ ] **Step 5: Commit** —
```
jj commit -m "test(starbattle): real 14x14 fixture + bench (<record measured result>)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Live-verify (after deploy — non-blockers, flagged in the spec)

Load on a `/star-battle/` board: Detect → Solve → confirm the star glyphs land on the right cells and (shaped) region borders render; Apply and confirm the page accepts the stars as solved; run Hint and Loop. Confirm the `(\d+)★` star-count scrape reads correctly (check both a shaped and a shapeless board); if the title markup differs, adjust the `readStarBattleData` scrape.

---

## Self-review checklist

1. **Spec coverage:** oracle port incl. adjacency + region + walls (T1), count+adjacency propagation (T2), MRV search + sound partial + brute-force gate (T3), `_deduceForced` hint + bundle (T4), MAIN-world incl. ★-scrape + UNK-skip apply (T5), handler incl. normalized readState + regionMap (T6), widget incl. star-glyph + walls drawStaticLayer + applyHint-only-hint-cells + loopDoneCheck (T7), real fixture + bench (T8). All present.
2. **Placeholder scan:** none — every step carries complete code or an exact command, except the deliberately-deferred bench number (recorded at run time) and the visual/scrape live-verify items (flagged non-blockers; the scrape code IS given).
3. **Type consistency:** `StarBattleSolver`, `solve()→{solved,cells,partial?,error?}`, `_deduceForced`, `_isValid`/`_initGrid`/`_set`/`_propagate`/`_pick`/`_snapshot`/`_restore`/`_search`, `STAR_DR`/`STAR_DC`, cells {1,0,9}, `{rows,cols,stars,areas,walls}`, `readStarBattleData`/`readStarBattleState`/`applyStarBattleState`, hint `extraCells:[{row,col,value∈{1,2}}]`, type `'starbattle'`, slug `/star-battle/`, `regionMap` from areas — consistent across all tasks.
```
