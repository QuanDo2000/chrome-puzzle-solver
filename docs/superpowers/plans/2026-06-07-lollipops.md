# Lollipops Puzzle Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full-parity (Detect/Solve/Hint/Loop) Lollipops puzzle support to the chrome-puzzle-solver extension for puzzles-mobile.com `/lollipops/`.

**Architecture:** Per-cell shape CSP. Each free cell ∈ {empty=4, candy=1, v-stick=2, h-stick=3}; clue cells (`task ≥ 0`) are fixed shapes. The oracle is ported verbatim from the page's `getErrors` (every lollipop is a candy+stick domino — candy↔`h` L/R, candy↔`v` U/D — with exactly one connection per shape, no non-partner shape neighbour, and a line-of-sight rule). The solver runs a sound unit-propagation fixpoint (forces any cell with a single locally-consistent value) then backtracks; this fully solves the real 10×10 uniquely in ~17 ms (validated).

**Tech Stack:** Vanilla JS (no deps), `node:test`, Chrome MV3. Version control is **`jj`, never `git`** (colocated Jujutsu repo — see CLAUDE.md). Commit only the files each task lists. End every commit message body with:
```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

**Validated facts (validate-before-plan):**
- `cellStatus`/`task` value-space: `0` off/unset, `1` candy (`o`), `2` v-stick, `3` h-stick, `4` cross/empty.
- Oracle distinguishes `0` (unset → "incomplete, don't flag") from `4` (cross → ignored). In a complete board (empties = `4`) every shape must have exactly one connection. (This was the one bug the gate caught.)
- Clue cells (`task ≥ 0`) are fixed shapes, NOT tracked in `cellStatus` (read `taskStatus`); the clue value IS the shape, not a count.
- Solver+oracle brute-force-gated: 250 random tiny boards, 0 mismatches. Real 10×10 solves uniquely (count=1) in ~17 ms, 16 candies + 16 sticks. `getHint` (local-consistency unit propagation) forces 61/85 free cells from blank, all matching the unique solution.
- `applyHintCells` (generic) binary-clamps (`v===1→1`, `v===2→2`, else→0), destroying `h`(3)/cross(4) — Lollipops needs a custom `applyHint` (Pipes precedent).

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `src/solvers/lollipops.js` | `LollipopsSolver` — oracle (ported getErrors), propagation, search, getHint | 1 |
| `tests/lollipops.test.js` | Oracle/propagation/getHint units + brute-force gate + real-board solve | 1, 2 |
| `tests/fixtures/real-puzzles.js` | `lollipops_10x10` fixture (captured task) | 2 |
| `tests/bench-lollipops.js` | Real-board bench | 2 |
| `scripts/build-solver-bundle.js` | FILES + EXPORTS | 3 |
| `solver.worker.js` | Global comment + dispatch arm | 3 |
| `globals.d.ts` | `LollipopsSolver` decl + 3 `MainWorldFn` | 3, 4 |
| `eslint.config.js` | `LollipopsSolver` + `lollipops` globals | 3, 6 |
| `main-world.js` | read/apply/dump functions | 4 |
| `background.js` | 3 `EXEC_MAIN_ALLOWLIST` entries | 4 |
| `handler.js` | `lollipopsHandler` + `registerHandler` | 5 |
| `src/widget/puzzles/lollipops.js` | Widget module (static clues, preview, applyHint, hintDispatch) | 6 |
| `src/widget/puzzles/index.js` | Register in `PUZZLES` | 6 |
| `scripts/build-content-bundle.js` | FILES entry | 6 |
| `src/widget/widget.js` | `lollipops` `{partial,grid}` partial-dispatch branch | 6 |

---

## Task 1: LollipopsSolver core + unit tests

**Files:**
- Create: `src/solvers/lollipops.js`
- Create: `tests/lollipops.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/lollipops.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { LollipopsSolver } = require('../src/solvers/lollipops.js');

// Helper: build a solver. task is the 2D clue grid (-1 free, >=0 fixed shape).
function mk(task, maxMs) { return new LollipopsSolver({ rows: task.length, cols: task[0].length, task, maxMs }); }

test('Lollipops oracle: a valid candy+stick pair passes', () => {
  // 1x2: candy at (0,0) + h-stick at (0,1) -> a horizontal lollipop.
  const s = mk([[-1, -1]]);
  assert.equal(s.isValid([[1, 3]]), true);   // o-h connect (candy R->h, h L->candy)
  assert.equal(s.isValid([[1, 1]]), false);  // two candies adjacent -> invalid adjacency
  assert.equal(s.isValid([[1, 2]]), false);  // candy + v-stick side by side: v's L/R partner is null -> d>0
  assert.equal(s.isValid([[1, 4]]), false);  // candy with no partner (only a cross neighbour) -> u==0
});

test('Lollipops oracle: vertical pair + wrong-orientation rejected', () => {
  const s = mk([[-1], [-1]]);             // 2x1
  assert.equal(s.isValid([[1], [2]]), true);   // candy above v-stick -> connect (candy D->v, v U->candy)
  assert.equal(s.isValid([[1], [3]]), false);  // h-stick stacked under candy: h's U/D partner null -> d>0
});

test('Lollipops oracle: line-of-sight rejects two equal shapes across only crosses', () => {
  // 1x3: candy, cross, candy. The two candies see each other across the cross -> invalid.
  // (Each candy also has no partner, but line-of-sight is the point; use a config isolating it.)
  // 1x4: o h x o  -> the lone candy at col3 has no partner (u==0) AND sees... build a cleaner case.
  // Use 1x5: o h x h o : candy(0) - h(1) pair; h(3) - o(4) pair; the two h at col1 and col3 see each
  // other across the cross at col2 -> line-of-sight error.
  const s = mk([[-1, -1, -1, -1, -1]]);
  assert.equal(s.isValid([[1, 3, 4, 3, 1]]), false); // two h-sticks see each other across the cross
  assert.equal(s.isValid([[1, 3, 1, 3, 1]]), false); // (sanity) not all-valid either
});

test('Lollipops oracle: a double-connected candy is rejected', () => {
  // candy in the middle of a 1x3 with h on both sides: u==2 -> invalid.
  const s = mk([[-1, -1, -1]]);
  assert.equal(s.isValid([[3, 1, 3]]), false); // candy connects L and R -> u==2
});

test('Lollipops propagation: a lone v-clue forces a candy above or below (here above)', () => {
  // 2x1, v-stick fixed at (1,0). Its only candy slot is (0,0) -> forced candy; full board solves.
  const s = mk([[-1], [2]], 1000);
  const res = s.solve();
  assert.equal(res.solved, true);
  assert.equal(res.grid[0][0], 1); // candy forced above the v-stick
});

test('Lollipops getHint: returns sound forced cells (1/2/3/4), re-asserting clue shapes', () => {
  const s = mk([[-1], [2]], 1000);
  const forced = s.getHint([[0], [0]]); // blank cellStatus (clue cell (1,0) is 0/untracked)
  assert.ok(forced.some((f) => f.row === 0 && f.col === 0 && f.value === 1)); // candy above
  assert.ok(forced.every((f) => [1, 2, 3, 4].includes(f.value)));
});

function rng(seed) { let x = seed >>> 0; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; }; }

// Enumerate all oracle-valid full boards (each cell 1/2/3/4) for a blank rows x cols grid.
function allValid(rows, cols) {
  const N = rows * cols, vals = [1, 2, 3, 4], total = Math.pow(4, N);
  const blank = Array.from({ length: rows }, () => new Array(cols).fill(-1));
  const o = new LollipopsSolver({ rows, cols, task: blank });
  const out = []; const g = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let x = 0; x < total; x++) { let y = x; for (let i = 0; i < N; i++) { g[(i / cols) | 0][i % cols] = vals[y & 3]; y >>= 2; } if (o.isValid(g)) out.push(g.map((r) => r.slice())); }
  return out;
}

test('Lollipops soundness gate: solver matches brute-force across random tiny boards', () => {
  let tested = 0, mism = 0;
  for (let iter = 0; iter < 5000 && tested < 250; iter++) {
    const rnd = rng(iter * 2654435761 + 99);
    const rows = 2 + Math.floor(rnd() * 2), cols = 2 + Math.floor(rnd() * 2); // 2..3
    if (rows * cols > 9) continue;
    const valids = allValid(rows, cols); if (!valids.length) continue;
    const sol = valids[Math.floor(rnd() * valids.length)];
    const task = Array.from({ length: rows }, () => new Array(cols).fill(-1));
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (sol[r][c] !== 4 && rnd() < 0.4) task[r][c] = sol[r][c];
    let bf = 0;
    for (const v of valids) { let ok = true; for (let r = 0; r < rows && ok; r++) for (let c = 0; c < cols && ok; c++) if (task[r][c] >= 0 && v[r][c] !== task[r][c]) ok = false; if (ok) bf++; }
    tested++;
    const s = new LollipopsSolver({ rows, cols, task, maxMs: 4000 });
    const res = s.solve(true);
    if (!!res.solved !== (bf > 0)) { mism++; continue; }
    if (res.solved) {
      if (!s.isValid(res.grid)) mism++;
      if ((res.count === 1) !== (bf === 1)) mism++;
    }
  }
  assert.equal(mism, 0, `gate mismatches=${mism} (tested=${tested})`);
  assert.ok(tested >= 100, `gate exercised too few boards (${tested})`);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/lollipops.test.js`
Expected: FAIL — `Cannot find module '../src/solvers/lollipops.js'`.

- [ ] **Step 3: Implement the solver**

Create `src/solvers/lollipops.js`:

```js
'use strict';

// LollipopsSolver — pure logic, no DOM.
//
// PAGE ENCODING (recon, getErrors is a REAL oracle — ported verbatim below and brute-force-gated in
// tests/lollipops.test.js):
//   cellStatus / task value-space: 0 off/unset, 1 candy (o), 2 vertical stick (v), 3 horizontal
//   stick (h), 4 cross/empty. task[r][c] = -1 free cell (player fills), >=0 a FIXED clue shape
//   (getShapeAt returns the task value). Clue cells are NOT tracked in cellStatus. serializeSolution
//   maps 0 and 4 both to "n" (a solve is registered from the shape placements).
//
// RULE (every lollipop is a candy + one adjacent stick): _partner(shape, dir) — candy(1) pairs with
//   h(3) L/R or v(2) U/D; v(2) pairs with candy U/D only; h(3) pairs with candy L/R only. A complete
//   board is valid iff every shape has EXACTLY ONE valid partner connection (u==1), NO non-partner
//   shape neighbour (d==0), and the line-of-sight rule holds (walking a row/col skipping only crosses
//   (4), the same shape must not be visible). getErrors distinguishes a 0 (unset) neighbour [g=true,
//   incomplete] from a 4 (cross) neighbour [ignored]; in a complete board (empties=4) every shape
//   must connect.
//
// METHOD: sound unit-propagation fixpoint (_propagate forces any free cell with a single locally-
//   consistent value) then backtracking with the local-consistency prune (_consistent). Fully solves
//   the real 10x10 uniquely in ~17ms. solve() grid: clue cells 0, free cells 1/2/3/4.

const DIRS = [
  { dr: 0, dc: -1, dir: 'L' }, { dr: 0, dc: 1, dir: 'R' },
  { dr: -1, dc: 0, dir: 'U' }, { dr: 1, dc: 0, dir: 'D' },
];

// _lollipopPartnerState: the shape a valid neighbour in direction `dir` must have to connect to `c`.
function partner(c, dir) {
  if (c === 1) return (dir === 'L' || dir === 'R') ? 3 : 2;
  if (c === 2) return (dir === 'U' || dir === 'D') ? 1 : null;
  if (c === 3) return (dir === 'L' || dir === 'R') ? 1 : null;
  return null;
}

class LollipopsSolver {
  constructor({ rows, cols, task, maxMs = 30000 } = {}) {
    this.rows = rows; this.cols = cols; this.task = task; this.maxMs = maxMs;
  }

  // effective shape at a cell: clue cells read the fixed task value, else the working grid.
  _val(r, c) { const t = this.task[r][c]; return t >= 0 ? t : this.g[r][c]; }

  // Local consistency on the working grid g (-9 unknown; 4 cross ignored; 0 does not occur during
  // search). Ported from getErrors' per-cell checks, applied to currently-decided cells only.
  _consistent() {
    const { rows, cols } = this;
    for (let h = 0; h < rows; h++) for (let n = 0; n < cols; n++) {
      const c = this._val(h, n); if (c === -9) continue;
      if (c === 1 || c === 2 || c === 3) {
        let u = 0, d = 0, unk = false;
        for (const { dr, dc, dir } of DIRS) {
          const S = h + dr, v = n + dc; if (S < 0 || v < 0 || S >= rows || v >= cols) continue;
          const s = this._val(S, v); if (s === -9) { unk = true; continue; } if (s === 4) continue;
          const p = partner(c, dir); if (p !== null && s === p) u++; else d++;
        }
        if (d > 0 || u > 1) return false;
        if (!unk && u === 0) return false;
        for (const { dr, dc } of DIRS) {
          let f = h + dr, z = n + dc;
          while (f >= 0 && z >= 0 && f < rows && z < cols) {
            const w = this._val(f, z);
            if (w === 4) { f += dr; z += dc; continue; }
            if (w === -9) break; if (w === c) return false; else break;
          }
        }
      }
    }
    return true;
  }

  // Unit-propagation fixpoint: force any free unassigned cell with a single locally-consistent value.
  // Sound (the only consistent value must be the solution's). Returns false on contradiction.
  _propagate() {
    let changed = true;
    while (changed) {
      changed = false;
      for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) {
        if (this.task[r][c] >= 0 || this.g[r][c] !== -9) continue;
        let cand = -1, n = 0;
        for (const v of [1, 2, 3, 4]) { this.g[r][c] = v; if (this._consistent()) { cand = v; n++; } this.g[r][c] = -9; if (n > 1) break; }
        if (n === 0) return false;
        if (n === 1) { this.g[r][c] = cand; changed = true; }
      }
    }
    return true;
  }

  // Oracle on a full grid (clue cells read from task): the exact getErrors rules. 0 -> incomplete
  // flag, 4 -> ignored. `grid` free cells are 1/2/3/4 (clue cells may be 0; _val reads task).
  isValid(grid) { const save = this.g; this.g = grid; const ok = this._isValidFull(); this.g = save; return ok; }
  _isValidFull() {
    const { rows, cols } = this;
    for (let h = 0; h < rows; h++) for (let n = 0; n < cols; n++) {
      const c = this._val(h, n); if (c !== 1 && c !== 2 && c !== 3) continue;
      let u = 0, d = 0, g0 = false;
      for (const { dr, dc, dir } of DIRS) {
        const S = h + dr, v = n + dc; if (S < 0 || v < 0 || S >= rows || v >= cols) continue;
        const s = this._val(S, v); if (s === 0) { g0 = true; continue; } if (s === 4) continue;
        const p = partner(c, dir); if (p !== null && s === p) u++; else d++;
      }
      if (u > 1 || d > 0) return false; if (u === 0 && !g0) return false;
      for (const { dr, dc } of DIRS) {
        let f = h + dr, z = n + dc;
        while (f >= 0 && z >= 0 && f < rows && z < cols) {
          const w = this._val(f, z); if (w === 4) { f += dr; z += dc; continue; }
          if (w === c) return false; else break;
        }
      }
    }
    return true;
  }

  // emit: clue cells 0, free cells their value (unassigned -9 -> 0). Used for solution + partial.
  _emit() { const out = []; for (let r = 0; r < this.rows; r++) { out.push([]); for (let c = 0; c < this.cols; c++) { const v = this.g[r][c]; out[r].push(this.task[r][c] >= 0 ? 0 : (v === -9 ? 0 : v)); } } return out; }
  // full grid for the oracle: clue cells 0 (read via task), free cells (unassigned -> 4 cross).
  _full() { const out = []; for (let r = 0; r < this.rows; r++) { out.push([]); for (let c = 0; c < this.cols; c++) out[r].push(this.task[r][c] >= 0 ? 0 : (this.g[r][c] === -9 ? 4 : this.g[r][c])); } return out; }

  solve(countAll = false) {
    this.g = []; for (let r = 0; r < this.rows; r++) { this.g.push([]); for (let c = 0; c < this.cols; c++) this.g[r].push(this.task[r][c] >= 0 ? this.task[r][c] : -9); }
    this.deadline = Date.now() + this.maxMs; this.count = 0; this.first = null; this.timedOut = false;
    if (!this._propagate()) return { solved: false, error: 'No solution (contradiction in givens)' };
    const partialBase = this._emit();
    this._search(countAll);
    if (this.first) return { solved: true, grid: this.first, count: this.count };
    if (this.timedOut) return { solved: false, partial: true, grid: partialBase };
    return { solved: false, error: 'No solution found' };
  }

  _firstFree() { for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) if (this.task[r][c] < 0 && this.g[r][c] === -9) return [r, c]; return null; }

  _search(countAll) {
    if (Date.now() > this.deadline) { this.timedOut = true; return true; }
    if (!this._consistent()) return false;
    const cell = this._firstFree();
    if (!cell) { if (this.isValid(this._full())) { this.count++; if (!this.first) this.first = this._emit(); } return this.count >= (countAll ? 2 : 1); }
    const r = cell[0], c = cell[1];
    for (const v of [4, 1, 2, 3]) {
      this.g[r][c] = v; this._search(countAll); this.g[r][c] = -9;
      if (this.timedOut || this.count >= (countAll ? 2 : 1)) return true;
    }
    return false;
  }

  // Hint engine. initialState = live cellStatus (0 unknown / 1/2/3/4). Clue cells are 0 there and
  // re-asserted from task (the clue-cells-not-in-cellStatus family — else Loop never terminates).
  // Returns newly-forced free cells { row, col, value(1/2/3/4) } via the sound unit propagation.
  getHint(initialState) {
    this.g = []; for (let r = 0; r < this.rows; r++) { this.g.push([]); for (let c = 0; c < this.cols; c++) {
      if (this.task[r][c] >= 0) { this.g[r].push(this.task[r][c]); continue; }
      const v = initialState[r] ? initialState[r][c] : 0;
      this.g[r].push((v === 1 || v === 2 || v === 3 || v === 4) ? v : -9);
    } }
    if (!this._consistent() || !this._propagate()) return [];
    const out = [];
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) {
      if (this.task[r][c] >= 0) continue;
      const was = initialState[r] ? initialState[r][c] : 0;
      if (was !== 0) continue;
      if (this.g[r][c] !== -9) out.push({ row: r, col: c, value: this.g[r][c] });
    }
    return out;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LollipopsSolver };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/lollipops.test.js`
Expected: PASS — 7 tests pass (the soundness gate reports `mismatches=0`).

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(lollipops): solver core (per-cell shape CSP, getErrors oracle)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" src/solvers/lollipops.js tests/lollipops.test.js
```

---

## Task 2: Real-board fixture + solve test + bench

**Files:**
- Modify: `tests/fixtures/real-puzzles.js` (add `lollipops_10x10`)
- Modify: `tests/lollipops.test.js` (add real-board solve test)
- Create: `tests/bench-lollipops.js`

- [ ] **Step 1: Add the fixture** — append to the exported map in `tests/fixtures/real-puzzles.js` (match the file's existing `module.exports = { ... }` object-literal style; the entry must be reachable as `REAL.lollipops_10x10`):

```js
  lollipops_10x10: {
    rows: 10, cols: 10,
    task: [
      [-1,-1,-1,-1,1,-1,3,-1,-1,-1],
      [-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
      [-1,-1,2,-1,-1,-1,-1,3,-1,-1],
      [1,-1,-1,-1,-1,-1,-1,-1,-1,1],
      [2,-1,1,-1,-1,1,-1,-1,-1,-1],
      [-1,-1,-1,-1,-1,-1,-1,2,-1,-1],
      [-1,-1,-1,-1,3,-1,-1,-1,-1,-1],
      [3,-1,-1,-1,-1,3,-1,-1,3,-1],
      [-1,-1,-1,3,-1,-1,-1,-1,-1,-1],
      [-1,3,-1,-1,-1,-1,-1,1,-1,-1],
    ],
  },
```

- [ ] **Step 2: Add the real-board solve test** — append to `tests/lollipops.test.js`:

```js
const REAL = require('./fixtures/real-puzzles.js');

test('Lollipops solve: the real 10x10 board solves uniquely, oracle-passing', () => {
  const f = REAL.lollipops_10x10;
  const s = new LollipopsSolver({ rows: f.rows, cols: f.cols, task: f.task, maxMs: 20000 });
  const res = s.solve(true);
  assert.equal(res.solved, true);
  assert.equal(res.partial, undefined);
  assert.equal(res.count, 1, 'unique solution');
  assert.ok(s.isValid(res.grid), 'oracle rejects own solution');
  // 15 free-cell shapes (16 candies + 16 sticks total minus the 17 clue cells).
  let freeShapes = 0; for (let r = 0; r < f.rows; r++) for (let c = 0; c < f.cols; c++) { const v = res.grid[r][c]; if (v === 1 || v === 2 || v === 3) freeShapes++; }
  assert.equal(freeShapes, 15);
});
```

- [ ] **Step 3: Run** — `node --test tests/lollipops.test.js`; expect all 8 tests pass (real board: solved, count 1, 15 free shapes).

- [ ] **Step 4: Create `tests/bench-lollipops.js`:**

```js
'use strict';
const { LollipopsSolver } = require('../src/solvers/lollipops.js');
const REAL = require('./fixtures/real-puzzles.js');
const f = REAL.lollipops_10x10;
for (let i = 0; i < 2; i++) new LollipopsSolver({ rows: f.rows, cols: f.cols, task: f.task, maxMs: 30000 }).solve();
const t0 = Date.now();
const res = new LollipopsSolver({ rows: f.rows, cols: f.cols, task: f.task, maxMs: 30000 }).solve();
const wall = Date.now() - t0;
let shapes = 0; if (res.grid) for (const row of res.grid) for (const v of row) if (v === 1 || v === 2 || v === 3) shapes++;
console.log(`lollipops 10x10: solved=${res.solved} partial=${!!res.partial} wall=${wall}ms freeShapes=${shapes}`);
if (!res.solved) { console.error('UNSOLVED'); process.exit(1); }
console.log('full solve verified');
```

- [ ] **Step 5: Run** — `node tests/bench-lollipops.js`; expect `solved=true partial=false ... freeShapes=15` then `full solve verified`.

- [ ] **Step 6: Commit**

```bash
jj commit -m "test(lollipops): real 10x10 fixture, unique-solve test, bench

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" tests/fixtures/real-puzzles.js tests/lollipops.test.js tests/bench-lollipops.js
```

---

## Task 3: Solver bundling + worker dispatch + globals

**Files:** `scripts/build-solver-bundle.js`, `solver.worker.js`, `globals.d.ts`, `eslint.config.js`

- [ ] **Step 1** — `scripts/build-solver-bundle.js`: in `FILES`, add `'lollipops.js',` immediately after `'thermometers.js',` (must stay before `'diff.js',`). In `EXPORTS`, add `'LollipopsSolver',` immediately after `'ThermometersSolver',` (before `'computePuzzleDiff'`).

- [ ] **Step 2** — `solver.worker.js`: append `, LollipopsSolver` to the `/* global ... */` comment (after `ThermometersSolver`). Add the dispatch arm immediately after the `thermometers` arm (before the `} else {` fallback):

```js
    } else if (type === 'lollipops' && extraData) {
      const s = new LollipopsSolver({ rows: extraData.rows, cols: extraData.cols, task: extraData.task, maxMs: 30000 });
      result = s.solve();
```

- [ ] **Step 3** — `globals.d.ts`: add `declare const LollipopsSolver: any;` after `declare const ThermometersSolver: any;`. `eslint.config.js`: add `  LollipopsSolver: 'readonly',` after `  ThermometersSolver: 'readonly',` (match indentation).

- [ ] **Step 4: Verify**

Run: `npm run build` — expect `Wrote dist/solver.js` and `Wrote dist/content.js`.
Run: `node -e "const {LollipopsSolver}=require('./dist/solver.js'); const f=require('./tests/fixtures/real-puzzles.js').lollipops_10x10; const r=new LollipopsSolver({rows:10,cols:10,task:f.task,maxMs:30000}).solve(); console.log('bundle solve solved='+r.solved);"` — expect `bundle solve solved=true`.
Run: `npm run lint && npm run typecheck` — both clean.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(lollipops): bundle the solver + worker dispatch arm

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" scripts/build-solver-bundle.js solver.worker.js globals.d.ts eslint.config.js
```

---

## Task 4: MAIN-world read/apply/dump + background allowlist + globals

**Files:** `main-world.js`, `background.js`, `globals.d.ts`

- [ ] **Step 1** — `main-world.js`: add three functions immediately after the `applyThermometersState` function's closing brace. (Self-contained — they run serialized in the page; reference only `window.Game`, params, locals.)

```js
function readLollipopsData() {
  try {
    var G = window.Game;
    if (!G || !Array.isArray(G.task) || !G.puzzleWidth || !G.puzzleHeight) return null;
    var rows = G.puzzleHeight, cols = G.puzzleWidth, task = [];
    for (var r = 0; r < rows; r++) { var row = G.task[r] || [], arr = new Array(cols); for (var c = 0; c < cols; c++) { var v = row[c]; arr[c] = (typeof v === 'number' && v >= 0) ? v : -1; } task.push(arr); }
    return { rows: rows, cols: cols, task: task };
  } catch (e) { return null; }
}

function readLollipopsState(rows, cols) {
  try {
    var G = window.Game;
    if (!G || !G.currentState || !G.currentState.cellStatus) return null;
    var cs = G.currentState.cellStatus, grid = [];
    for (var r = 0; r < rows; r++) { var row = cs[r] || [], arr = new Array(cols); for (var c = 0; c < cols; c++) arr[c] = row[c] || 0; grid.push(arr); }
    return grid;
  } catch (e) { return null; }
}

function applyLollipopsState(grid) {
  try {
    var G = window.Game;
    if (!G || !G.currentState || !G.currentState.cellStatus || !Array.isArray(G.task)) return false;
    if (typeof G.saveState === 'function') G.saveState(true);
    var cs = G.currentState.cellStatus, rows = G.puzzleHeight, cols = G.puzzleWidth;
    for (var r = 0; r < rows; r++) {
      if (!cs[r]) cs[r] = [];
      for (var c = 0; c < cols; c++) {
        if (G.task[r] && typeof G.task[r][c] === 'number' && G.task[r][c] >= 0) continue; // fixed clue cell
        var v = (grid[r] && grid[r][c] !== undefined) ? grid[r][c] : 0;
        if (v === 1 || v === 2 || v === 3 || v === 4) cs[r][c] = v; // 0 (unknown) left untouched
      }
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

- [ ] **Step 2** — `main-world.js` dump branch: in `dumpPuzzleForBench`, immediately after the `/thermometers/` branch's closing brace, add:

```js
    if (path.indexOf('/lollipops/') !== -1 || g.slug === 'lollipops') {
      if (!Array.isArray(g.task) || !g.puzzleWidth || !g.puzzleHeight) return { error: 'lollipops: missing task/dims', diagnostic: diagnostic(g), path: path };
      var llRows = g.puzzleHeight, llCols = g.puzzleWidth, llTask = [];
      for (var llr = 0; llr < llRows; llr++) { var llSrc = g.task[llr] || [], llDst = new Array(llCols); for (var llc = 0; llc < llCols; llc++) { var llv = llSrc[llc]; llDst[llc] = (typeof llv === 'number' && llv >= 0) ? llv : -1; } llTask.push(llDst); }
      return { type: 'lollipops', rows: llRows, cols: llCols, task: llTask, path: path };
    }
```

- [ ] **Step 3** — `background.js`: add after `'applyThermometersState',` in `EXEC_MAIN_ALLOWLIST`:

```js
  'readLollipopsData',
  'readLollipopsState',
  'applyLollipopsState',
```

- [ ] **Step 4** — `globals.d.ts`: add after `| 'applyThermometersState'` in the `MainWorldFn` union:

```ts
  | 'readLollipopsData'
  | 'readLollipopsState'
  | 'applyLollipopsState'
```

- [ ] **Step 5: Verify** — `npm run lint && npm run typecheck && npm run build` all clean; `node -e "require('./main-world.js'); console.log('main-world loads')"` prints `main-world loads`. Confirm the 3 names appear in BOTH the allowlist and `MainWorldFn`.

- [ ] **Step 6: Commit**

```bash
jj commit -m "feat(lollipops): MAIN-world read/apply/dump + background allowlist

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" main-world.js background.js globals.d.ts
```

---

## Task 5: Content-script handler

**Files:** `handler.js`

- [ ] **Step 1** — add immediately after `registerHandler(thermometersHandler);` (NOTE: methods reference `window`/`document` only inside bodies — safe under Node `require`):

```js
// ── Lollipops handler (puzzles-mobile.com/lollipops/) ─────────

const lollipopsHandler = {
  name: 'puzzles-mobile-lollipops',
  priority: 30,

  matches() {
    return isPuzzlesMobilePage() && window.location.pathname.includes('/lollipops/');
  },

  async detect() {
    const result = { found: false, rows: 0, cols: 0, rowClues: [], colClues: [] };
    const data = await callMainWorld('readLollipopsData', []);
    if (!data) return { ...result, error: 'No Lollipops task data found' };
    const stageEl = document.getElementById('stage') || document.getElementById('game') ||
                    document.querySelector('[class*="game"], [class*="puzzle"]');
    return { found: true, type: 'lollipops', rows: data.rows, cols: data.cols, task: data.task, rowClues: [], colClues: [], _cells: [], _element: stageEl };
  },

  async readState(ctx) {
    const state = await callMainWorld('readLollipopsState', [ctx.rows, ctx.cols]);
    if (state) return state; // RAW cellStatus 0/1/2/3/4 (no normalization)
    return Array.from({ length: ctx.rows }, () => new Array(ctx.cols).fill(0));
  },

  async applySolution(solution, _ctx) {
    const ok = await callMainWorld('applyLollipopsState', [solution]);
    return ok ? { success: true } : { success: false, error: 'Lollipops apply failed' };
  },
};

registerHandler(lollipopsHandler);
```

- [ ] **Step 2: Verify** — `npm run lint && npm run typecheck && npm run build` clean; `node -e "require('./handler.js'); console.log('handler loads')"` prints `handler loads`.

- [ ] **Step 3: Commit**

```bash
jj commit -m "feat(lollipops): content-script handler

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" handler.js
```

---

## Task 6: Widget module + registry + content bundle + partial-dispatch + final verify

**Files:** create `src/widget/puzzles/lollipops.js`; modify `src/widget/puzzles/index.js`, `scripts/build-content-bundle.js`, `eslint.config.js`, `src/widget/widget.js`

- [ ] **Step 1: Create `src/widget/puzzles/lollipops.js`:**

```js
'use strict';

const { hashFNV1a } = require('../shared.js');

// Lollipops widget module — cell-state puzzle, clue cells are in-grid FIXED shapes (not tracked in
// cellStatus — the clue-cells-not-in-cellStatus family). Value-space: cellStatus 0 unknown / 1 candy
// / 2 v-stick / 3 h-stick / 4 cross. Solver grid: clue cells 0, free cells 1/2/3/4. readState is RAW
// so the default per-cell diff applies. drawStaticLayer renders the given clue shapes from pd.task;
// drawPreviewCell renders placed shapes. NO preview.js/diff.js/hint.js changes. applyHint is custom
// (the generic applyHintCells binary-clamps, destroying h(3)/cross(4) — same as pipes). hintDispatch
// has a cached-solution fallback.

function hintBatchCap(rows, cols) { return Math.max(6, Math.ceil((rows * cols) / 30)); }

// Shared glyph drawing for a shape value in a cell box (x,y,cellSize). color overrides the fill.
function drawShape(ctx, v, x, y, cellSize, color) {
  const cx = x + cellSize / 2, cy = y + cellSize / 2;
  ctx.fillStyle = color;
  if (v === 1) { ctx.beginPath(); ctx.arc(cx, cy, cellSize * 0.3, 0, Math.PI * 2); ctx.fill(); }
  else if (v === 2) { ctx.fillRect(cx - cellSize * 0.12, y + cellSize * 0.16, cellSize * 0.24, cellSize * 0.68); }
  else if (v === 3) { ctx.fillRect(x + cellSize * 0.16, cy - cellSize * 0.12, cellSize * 0.68, cellSize * 0.24); }
}

const lollipops = {
  type: 'lollipops',
  label: 'Lollipops',
  url: 'https://www.puzzles-mobile.com/lollipops/',
  solutionKeyPrefix: 'lollipops-solution:',
  skipAutoSolveGate: true,
  hasAbsoluteHintCells: true,
  hintBandSkip: true,
  renderEmptyCells: true,

  cacheKey(data) {
    if (data?.type !== 'lollipops' || !data.task) return null;
    const h = hashFNV1a((mix) => { mix(0x6c); mix(data.rows); mix(data.cols); for (const row of data.task) for (const v of row) mix((v | 0) + 2); });
    return 'lollipops-solution:' + h.toString(16);
  },

  staticSig(data) { return 'll=' + _lolliSig(data?.type === 'lollipops' ? data : null); },

  canvasDims(pd, { grid }) {
    return { rows: pd?.rows || (Array.isArray(grid) ? grid.length : 0), cols: pd?.cols || (Array.isArray(grid) && grid[0] ? grid[0].length : 0), marginCells: 0.15 };
  },

  // Static layer: given clue shapes (from pd.task) in a distinct colour + grid border.
  drawStaticLayer(ctx, { rows, cols, cellSize, pd }) {
    const task = (pd && pd.task) || [];
    ctx.save();
    for (let r = 0; r < rows; r++) { const row = task[r] || []; for (let c = 0; c < cols; c++) { const v = row[c]; if (v === 1 || v === 2 || v === 3) drawShape(ctx, v, c * cellSize, r * cellSize, cellSize, '#7c3aed'); } }
    const borderW = Math.max(2, Math.floor(cellSize / 6));
    ctx.strokeStyle = '#1f2937'; ctx.lineWidth = borderW; ctx.lineCap = 'square';
    ctx.strokeRect(borderW / 2, borderW / 2, cols * cellSize - borderW, rows * cellSize - borderW);
    ctx.restore();
  },

  // Dynamic: placed shapes (candy/v/h) in red; cross (4) -> faint x; unknown/clue -> nothing.
  drawPreviewCell(ctx, { v, x, y, cellSize, r, c, puzzleData }) {
    if (puzzleData?.task?.[r]?.[c] >= 0) return; // clue cell drawn by the static layer
    if (v === 1 || v === 2 || v === 3) drawShape(ctx, v, x, y, cellSize, '#dc2626');
    else if (v === 4) { ctx.strokeStyle = 'rgba(100,116,139,0.5)'; ctx.lineWidth = Math.max(1, cellSize * 0.04); const p = cellSize * 0.36; ctx.beginPath(); ctx.moveTo(x + p, y + p); ctx.lineTo(x + cellSize - p, y + cellSize - p); ctx.moveTo(x + cellSize - p, y + p); ctx.lineTo(x + p, y + cellSize - p); ctx.stroke(); }
  },

  drawHintCell(ctx, { cell, cx, cy, cellSize }) {
    if ([1, 2, 3, 4].includes(cell.value)) { ctx.strokeStyle = '#dc2626'; ctx.lineWidth = Math.max(2, Math.floor(cellSize / 9)); ctx.strokeRect(cx + 2, cy + 2, cellSize - 4, cellSize - 4); }
  },

  hintStatusNodes(h, { bold }) {
    const cells = h.extraCells || [];
    if (!cells.length) return ['No hint available'];
    const name = { 1: 'a candy', 2: 'a vertical stick', 3: 'a horizontal stick', 4: 'empty' };
    if (cells.length === 1) { const cell = cells[0]; return ['Cell ', bold(`(row ${cell.row + 1}, col ${cell.col + 1})`), ' is ', bold(name[cell.value] || '?')]; }
    return [bold(String(cells.length)), ' cells can be deduced'];
  },

  solveExtraData(data) { return { rows: data.rows, cols: data.cols, task: data.task }; },
  solutionFromResult(result) { return (result && result.grid) ? result.grid : null; },
  solutionToCacheJson(solution) { return Array.isArray(solution) ? { grid: solution.map((row) => row.slice()) } : null; },
  solutionFromCacheJson(parsed) { return (parsed && Array.isArray(parsed.grid)) ? parsed.grid.map((row) => row.slice()) : null; },

  partialResultArm(result, { applyGridPartialResult }) { applyGridPartialResult(result); },

  // Custom apply: the generic applyHintCells binary-clamps (h(3)/cross(4) -> 0). Read the live board,
  // overlay the hint's raw values, and apply through applyLollipopsState (the path Loop uses).
  async applyHint(hint, { callMainWorld, puzzleData, hintAbsoluteCells }) {
    const rows = puzzleData.rows, cols = puzzleData.cols;
    const cur = await callMainWorld('readLollipopsState', [rows, cols]);
    const grid = (cur || Array.from({ length: rows }, () => new Array(cols).fill(0))).map((row) => row.slice());
    for (const cell of hintAbsoluteCells(hint)) { if (grid[cell.row]) grid[cell.row][cell.col] = cell.value | 0; }
    return !!(await callMainWorld('applyLollipopsState', [grid]));
  },

  hintDispatch(ctx) {
    const { grid, solution, rows, cols, detectedGrid, firstMismatch } = ctx;
    if (solution && firstMismatch && firstMismatch(grid, solution)) {
      return { success: false, error: 'Current game state is wrong.' };
    }
    const dg = detectedGrid;
    if (dg && Array.isArray(dg.task)) {
      const Solver = (typeof LollipopsSolver !== 'undefined') ? LollipopsSolver : require('../../solvers/lollipops.js').LollipopsSolver;
      const forced = new Solver({ rows, cols, task: dg.task, maxMs: 1500 }).getHint(grid);
      if (forced && forced.length) {
        const batch = forced.slice(0, hintBatchCap(rows, cols));
        return { success: true, hint: { type: 'lollipops', extraCells: batch, count: batch.length }, grid, solution };
      }
    }
    if (!Array.isArray(solution)) return { success: false, error: 'No more cells can be deduced. Click Solve to finish.' };
    const cap = hintBatchCap(rows, cols); const cells = [];
    const task = dg && dg.task;
    for (let r = 0; r < rows && cells.length < cap; r++) for (let c = 0; c < cols && cells.length < cap; c++) {
      if (task && task[r] && task[r][c] >= 0) continue; // skip clue cells
      const sv = solution[r] ? solution[r][c] : 0;
      if (sv !== 1 && sv !== 2 && sv !== 3 && sv !== 4) continue;
      const cur = grid && grid[r] ? grid[r][c] : 0;
      if (cur === sv) continue;
      cells.push({ row: r, col: c, value: sv });
    }
    if (!cells.length) return { success: false, error: 'No hint available' };
    return { success: true, hint: { type: 'lollipops', extraCells: cells, count: cells.length }, grid, solution };
  },
};

function _lolliSig(data) {
  if (!data) return '0';
  const h = hashFNV1a((mix) => { for (const row of (data.task || [])) for (const v of row) mix((v | 0) + 2); });
  return h.toString(16);
}

if (typeof module !== 'undefined' && module.exports) { module.exports = lollipops; }
```

- [ ] **Step 2** — register + bundle + eslint:
  - `src/widget/puzzles/index.js`: add after the `thermometers` line: `if (typeof lollipops !== 'undefined') PUZZLES[lollipops.type] = lollipops;`
  - `scripts/build-content-bundle.js`: in the FILES array, add `'puzzles/lollipops.js',` immediately after `'puzzles/thermometers.js',`.
  - `eslint.config.js`: add `        lollipops: 'readonly',` after the `thermometers: 'readonly',` widget-module global (the lowercase group, NOT the `LollipopsSolver` solver global).

- [ ] **Step 3** — `src/widget/widget.js`: add the partial-dispatch branch immediately after the `thermometers` branch (before the `// Generic cell-state partial:` comment):

```js
      if (result?.partial && puzzleData?.type === 'lollipops' && Array.isArray(result.grid)) {
        applyPartialResult(result);
        return;
      }
```

- [ ] **Step 4: Full verification** (run in order):
  1. `npm run build` — `Wrote dist/solver.js` + `Wrote dist/content.js`.
  2. `npm run lint` — clean.
  3. `npm run typecheck` — clean.
  4. `npm test` — ALL pass (full suite + 8 lollipops tests). Report the total.
  5. `node tests/bench-lollipops.js` — `solved=true partial=false ... freeShapes=15` then `full solve verified`.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(lollipops): widget module, registry, partial-dispatch, bundle

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" src/widget/puzzles/lollipops.js src/widget/puzzles/index.js scripts/build-content-bundle.js eslint.config.js src/widget/widget.js
```

---

## Final review (after all tasks)

Dispatch a final whole-implementation review: solver soundness (gate green), every wiring touchpoint present and in sync (allowlist ↔ MainWorldFn, FILES ↔ EXPORTS), the custom `applyHint` (non-binary) wired, the partial-dispatch branch present, jj-only (no `git`), and a manual reload on a live `/lollipops/` board (Detect → Solve → Hint → Loop; verify clue shapes, placed candy/stick glyphs, and that Hint/Loop place `h`-sticks correctly — the preview glyphs are empirical, like Shakashaka/Thermometers).

## Known empirical points to verify on the live page

- **Preview glyphs** (candy circle, v/h bars, cross, given-vs-placed colours) are a first cut — verify they read clearly and match the page's candy/stick visuals; adjust constants in `drawShape`/`drawStaticLayer`/`drawPreviewCell` if needed (no logic impact). Mirror the Thermometers lattice-vs-static lesson if any "structure under fills" emerges (here there is none — shapes are per-cell, no connectors drawn).
- **Clue rendering**: clue cells render their fixed shape (candy/v/h). If the live page shows the clue as a number or a different glyph, adjust `drawStaticLayer` (logic is unaffected — clue value is the shape).
```
