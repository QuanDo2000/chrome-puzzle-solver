# Thermometers Puzzle Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full-parity (Detect/Solve/Hint/Loop) Thermometers puzzle support to the chrome-puzzle-solver extension for puzzles-mobile.com `/thermometers/`.

**Architecture:** Per-thermometer fill-level CSP. Each thermometer is an ordered bulb→tip cell chain; its state is a single fill level (0..len) and a cell is filled iff its index < level (the contiguous-prefix rule is intrinsic). A **contribution-bound** line propagation (bound each thermometer's contribution to a row/col by what the clue allows given the other thermometers' min/max) drives the solver — this alone fully solves the real 15×15 (validated: 1 node, 1 ms, unique). Wiring mirrors the Tents module exactly (cell-state, margin clues, every cell tracked in `cellStatus`).

**Tech Stack:** Vanilla JS (no deps), `node:test`, Chrome MV3. Version control is **`jj`, never `git`** (colocated Jujutsu repo — see AGENTS.md). Commit only the files each task lists.

**Validated facts (from validate-before-plan):**
- Clue orientation is **cols-first**: `task[0..cols-1]` = column clues, `task[cols..]` = row clues (rows-first produces a contradiction on the real board).
- `cellStatus`: `0` unknown / `1` filled (mercury) / `2` empty(cross). `serializeSolution` registers a solve when `cellStatus == 1` on exactly the filled cells.
- `Game.areaPoints[t]` is the ordered cell list, **index 0 = bulb**; `Game.areas` tiles all cells. `getErrors` is a no-op stub → the solver oracle (prefix + counts) is the rule, brute-force-gated.
- Solver/widget wire format for thermometers: `thermos = [[{r,c}, ...], ...]` (ordered bulb→tip).

**`jj` cheat-sheet for each task's commit step:**
```bash
jj commit -m "<message>" <file1> <file2> ...
```
End every commit message body with:
```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `src/solvers/thermometers.js` | `ThermometersSolver` — pure logic (propagation, search, oracle, getHint) | 1 |
| `tests/thermometers.test.js` | Oracle/propagation/getHint units + brute-force soundness gate + real-board solve | 1, 2 |
| `tests/fixtures/real-puzzles.js` | `thermometers_15x15` fixture (captured areaPoints + task) | 2 |
| `tests/bench-thermometers.js` | Real-board bench (`process.exit(1)` on unsolved) | 2 |
| `scripts/build-solver-bundle.js` | Add `thermometers.js` to FILES, `ThermometersSolver` to EXPORTS | 3 |
| `solver.worker.js` | Global comment + `thermometers` dispatch arm | 3 |
| `globals.d.ts` | `ThermometersSolver` decl + 3 `MainWorldFn` entries | 3, 4 |
| `eslint.config.js` | `ThermometersSolver` + `thermometers` globals | 3, 6 |
| `main-world.js` | `readThermometersData`/`readThermometersState`/`applyThermometersState` + dump branch | 4 |
| `background.js` | 3 `EXEC_MAIN_ALLOWLIST` entries | 4 |
| `handler.js` | `thermometersHandler` + `registerHandler` | 5 |
| `src/widget/puzzles/thermometers.js` | Widget module (static layer, preview, hintDispatch, cache) | 6 |
| `src/widget/puzzles/index.js` | Register module in `PUZZLES` | 6 |
| `scripts/build-content-bundle.js` | Add `puzzles/thermometers.js` to FILES | 6 |
| `src/widget/widget.js` | `thermometers` `{partial,grid}` partial-dispatch branch | 6 |

---

## Task 1: ThermometersSolver core + unit tests

**Files:**
- Create: `src/solvers/thermometers.js`
- Create: `tests/thermometers.test.js`

- [ ] **Step 1: Write the failing tests (oracle + propagation + getHint + soundness gate)**

Create `tests/thermometers.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ThermometersSolver } = require('../src/solvers/thermometers.js');

// Build a solver from thermos given as arrays of [r,c] pairs (compact), bulb first.
function mk(rows, cols, thermosRC, colClue, rowClue, maxMs) {
  const thermos = thermosRC.map((t) => t.map(([r, c]) => ({ r, c })));
  return new ThermometersSolver({ rows, cols, thermos, colClue, rowClue, maxMs });
}
// fill grid (1 filled / 0 empty) from a complete level assignment, for oracle tests.
function fillFromLevels(s, levels) {
  const g = Array.from({ length: s.rows }, () => new Array(s.cols).fill(0));
  for (let t = 0; t < s.T; t++) for (let i = 0; i < levels[t]; i++) { const cell = s.thermos[t][i]; g[cell.r][cell.c] = 1; }
  return g;
}

test('Thermometers oracle: prefix rule + exact counts', () => {
  // 1x3 single horizontal thermometer, bulb at (0,0) filling right.
  const s = mk(1, 3, [[[0, 0], [0, 1], [0, 2]]], [1, 1, 0], [2]);
  assert.equal(s._isValid([[1, 1, 0]]), true);   // prefix of length 2, counts match
  assert.equal(s._isValid([[1, 0, 1]]), false);  // not a prefix (gap) — breaks prefix rule
  assert.equal(s._isValid([[1, 1, 1]]), false);  // counts wrong (row clue 2, got 3)
  // 2x1 vertical thermometer bulb at (0,0): filling must start at the bulb.
  const v = mk(2, 1, [[[0, 0], [1, 0]]], [1], [0, 1]);
  assert.equal(v._isValid([[0], [1]]), false);   // (1,0) filled but bulb (0,0) empty -> not a prefix
});

test('Thermometers propagation: contribution-bound forces a prefix from a column clue', () => {
  // Two vertical thermometers side by side, each length 3, bulbs at top.
  // Col 0 clue 2 -> exactly the first 2 cells of thermo 0 filled. Pure propagation decides it.
  const s = mk(3, 2,
    [[[0, 0], [1, 0], [2, 0]], [[0, 1], [1, 1], [2, 1]]],
    [2, 0], [1, 1, 0]);
  s.lo = new Array(s.T).fill(0); s.hi = s.len.slice();
  assert.equal(s._propagate(), true);
  // thermo 0 (col 0): level forced to exactly 2; thermo 1 (col 1): level forced to 0
  assert.equal(s.lo[0], 2); assert.equal(s.hi[0], 2);
  assert.equal(s.lo[1], 0); assert.equal(s.hi[1], 0);
});

test('Thermometers getHint: returns newly-forced cells (1 filled / 2 empty)', () => {
  const s = mk(3, 2,
    [[[0, 0], [1, 0], [2, 0]], [[0, 1], [1, 1], [2, 1]]],
    [2, 0], [1, 1, 0], 1000);
  const forced = s.getHint([[0, 0], [0, 0], [0, 0]]); // blank board (cellStatus all 0)
  // col-0 thermo: (0,0),(1,0) filled, (2,0) empty; col-1 thermo: all empty
  assert.ok(forced.some((f) => f.row === 0 && f.col === 0 && f.value === 1));
  assert.ok(forced.some((f) => f.row === 2 && f.col === 0 && f.value === 2));
  assert.ok(forced.some((f) => f.row === 0 && f.col === 1 && f.value === 2));
  assert.ok(forced.every((f) => f.value === 1 || f.value === 2));
});

function rng(seed) { let x = seed >>> 0; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; }; }

// Random thermometer tiling via randomized orthogonal chain walks (chain order = bulb->tip).
function randomTiling(rnd, rows, cols) {
  const used = Array.from({ length: rows }, () => new Array(cols).fill(false));
  const D = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  const thermos = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (used[r][c]) continue;
    const chain = [{ r, c }]; used[r][c] = true; let cr = r, cc = c;
    const maxLen = 1 + Math.floor(rnd() * 4);
    while (chain.length < maxLen) {
      const nbrs = [];
      for (const [dr, dc] of D) { const nr = cr + dr, nc = cc + dc; if (nr >= 0 && nc >= 0 && nr < rows && nc < cols && !used[nr][nc]) nbrs.push([nr, nc]); }
      if (!nbrs.length) break;
      const [nr, nc] = nbrs[Math.floor(rnd() * nbrs.length)];
      used[nr][nc] = true; chain.push({ r: nr, c: nc }); cr = nr; cc = nc;
    }
    thermos.push(chain);
  }
  return thermos;
}

test('Thermometers soundness gate: solver matches brute-force across random tiny boards', () => {
  let tested = 0, mismatches = 0;
  for (let iter = 0; iter < 8000 && tested < 300; iter++) {
    const rnd = rng(iter * 2654435761 + 12345);
    const rows = 2 + Math.floor(rnd() * 3), cols = 2 + Math.floor(rnd() * 3); // 2..4
    const thermos = randomTiling(rnd, rows, cols);
    let total = 1; for (const t of thermos) total *= (t.length + 1);
    if (total > 500000) continue;
    // random fill -> derived clues (guarantees >=1 solution)
    const lvl = thermos.map((t) => Math.floor(rnd() * (t.length + 1)));
    const s0 = new ThermometersSolver({ rows, cols, thermos, colClue: new Array(cols).fill(0), rowClue: new Array(rows).fill(0) });
    const g0 = fillFromLevels(s0, lvl);
    const rowClue = new Array(rows).fill(0), colClue = new Array(cols).fill(0);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (g0[r][c]) { rowClue[r]++; colClue[c]++; }
    const s = new ThermometersSolver({ rows, cols, thermos, colClue, rowClue, maxMs: 4000 });
    // brute force: enumerate all level combos, count oracle-valid
    let bf = 0; const lens = thermos.map((t) => t.length); const combo = new Array(s.T).fill(0);
    for (let x = 0; x < total; x++) {
      let y = x; for (let t = 0; t < s.T; t++) { combo[t] = y % (lens[t] + 1); y = (y / (lens[t] + 1)) | 0; }
      if (s._isValid(fillFromLevels(s, combo))) bf++;
    }
    tested++;
    const res = s.solve(true);
    if (!!res.solved !== (bf > 0)) { mismatches++; continue; }
    if (res.solved) {
      const fill = res.grid.map((row) => row.map((v) => (v === 1 ? 1 : 0)));
      if (!s._isValid(fill)) mismatches++;
      if ((res.count === 1) !== (bf === 1)) mismatches++;
    }
  }
  assert.equal(mismatches, 0, `gate mismatches=${mismatches} (tested=${tested})`);
  assert.ok(tested >= 150, `gate exercised too few boards (${tested})`);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/thermometers.test.js`
Expected: FAIL — `Cannot find module '../src/solvers/thermometers.js'`.

- [ ] **Step 3: Implement the solver**

Create `src/solvers/thermometers.js`:

```js
'use strict';

// ThermometersSolver — pure logic, no DOM.
//
// PAGE ENCODING (recon, getErrors is a NO-OP stub -> the oracle below IS the rule, brute-force-gated
// in tests/thermometers.test.js):
//   Game.areaPoints[t] = ordered cell list, INDEX 0 = bulb, last = tip (the page builds it bulb-first
//   per direction). Game.task = column clues (0..cols-1) then row clues. cellStatus 0 unknown /
//   1 filled (mercury) / 2 empty. A solve registers when cellStatus==1 on exactly the filled cells.
//
// RULE: per thermometer the filled cells are a contiguous prefix from the bulb; each row/col has its
//   exact clued count of filled cells.
//
// MODEL: thermometer t has cells thermos[t] (bulb->tip, {r,c}) and a fill level in [lo[t], hi[t]]
//   (hi exclusive upper bound, 0..len); cell i is filled iff i < level. The prefix rule is intrinsic.
//   Only the count rule is propagated, via CONTRIBUTION-BOUND propagation: in a line with clue K,
//   bound each thermometer's contribution by K minus the other thermometers' minimum/maximum
//   contributions, tightening lo/hi. This alone fully solves real 15x15 boards (1 node). Search
//   (most-constrained thermometer, snapshot/restore of the small lo/hi arrays) is the fallback.

class ThermometersSolver {
  constructor({ rows, cols, thermos, colClue, rowClue, maxMs = 30000 } = {}) {
    this.rows = rows; this.cols = cols; this.thermos = thermos;
    this.colClue = colClue; this.rowClue = rowClue; this.maxMs = maxMs;
    this.T = thermos.length;
    this.len = thermos.map((t) => t.length);
    // Per-line groups: for each row/col, { t, idxs } where idxs = sorted thermo-indices of that
    // thermometer's cells lying in the line (a horizontal thermometer contributes several to its row).
    const rowG = []; const colG = [];
    for (let r = 0; r < rows; r++) rowG.push(new Map());
    for (let c = 0; c < cols; c++) colG.push(new Map());
    for (let t = 0; t < this.T; t++) for (let i = 0; i < thermos[t].length; i++) {
      const cell = thermos[t][i], r = cell.r, c = cell.c;
      if (!rowG[r].has(t)) rowG[r].set(t, []); rowG[r].get(t).push(i);
      if (!colG[c].has(t)) colG[c].set(t, []); colG[c].get(t).push(i);
    }
    const toGroups = (m) => { const out = []; for (const [t, idxs] of m) { idxs.sort((a, b) => a - b); out.push({ t, idxs }); } return out; };
    this.rowGroups = rowG.map(toGroups);
    this.colGroups = colG.map(toGroups);
  }

  // count of idxs strictly below `level` (idxs ascending).
  _contrib(idxs, level) { let n = 0; for (let k = 0; k < idxs.length; k++) { if (idxs[k] < level) n++; else break; } return n; }

  // Contribution-bound propagation for one line. Returns -1 on contradiction, else number of changes.
  _lineProp(groups, clue) {
    const n = groups.length;
    if (!n) return clue === 0 ? 0 : -1;
    const cMin = new Array(n), cMax = new Array(n);
    let minTotal = 0, maxTotal = 0;
    for (let g = 0; g < n; g++) { cMin[g] = this._contrib(groups[g].idxs, this.lo[groups[g].t]); cMax[g] = this._contrib(groups[g].idxs, this.hi[groups[g].t]); minTotal += cMin[g]; maxTotal += cMax[g]; }
    if (minTotal > clue || maxTotal < clue) return -1;
    let changed = 0;
    for (let g = 0; g < n; g++) {
      const t = groups[g].t, idxs = groups[g].idxs;
      const allowedMax = clue - (minTotal - cMin[g]); // cap on this thermo's contribution to the line
      const allowedMin = clue - (maxTotal - cMax[g]); // floor on this thermo's contribution
      if (allowedMax < cMax[g]) { const m = allowedMax < 0 ? 0 : allowedMax; const newHi = m < idxs.length ? idxs[m] : this.hi[t]; if (newHi < this.hi[t]) { this.hi[t] = newHi; changed++; } }
      if (allowedMin > cMin[g]) { const m = allowedMin; const newLo = (m >= 1 && m - 1 < idxs.length) ? idxs[m - 1] + 1 : this.lo[t]; if (newLo > this.lo[t]) { this.lo[t] = newLo; changed++; } }
      if (this.lo[t] > this.hi[t]) return -1;
    }
    return changed;
  }

  _propagate() {
    let changed = true;
    while (changed) {
      changed = false;
      for (let r = 0; r < this.rows; r++) { const k = this._lineProp(this.rowGroups[r], this.rowClue[r]); if (k < 0) return false; if (k) changed = true; }
      for (let c = 0; c < this.cols; c++) { const k = this._lineProp(this.colGroups[c], this.colClue[c]); if (k < 0) return false; if (k) changed = true; }
    }
    return true;
  }

  // grid from a complete level assignment: 1 filled / 2 empty.
  _emitLevels(levels) {
    const out = []; for (let r = 0; r < this.rows; r++) out.push(new Array(this.cols).fill(0));
    for (let t = 0; t < this.T; t++) for (let i = 0; i < this.thermos[t].length; i++) { const cell = this.thermos[t][i]; out[cell.r][cell.c] = i < levels[t] ? 1 : 2; }
    return out;
  }

  // partial grid from current bounds: decided cells 1/2, undecided 0.
  _emitBounds() {
    const out = []; for (let r = 0; r < this.rows; r++) out.push(new Array(this.cols).fill(0));
    for (let t = 0; t < this.T; t++) for (let i = 0; i < this.thermos[t].length; i++) { const cell = this.thermos[t][i]; out[cell.r][cell.c] = i < this.lo[t] ? 1 : (i >= this.hi[t] ? 2 : 0); }
    return out;
  }

  // Oracle on a fill grid (truthy = filled): prefix rule + exact row/col counts.
  _isValid(fill) {
    for (let t = 0; t < this.T; t++) { let empty = false; for (let i = 0; i < this.thermos[t].length; i++) { const cell = this.thermos[t][i]; if (fill[cell.r][cell.c]) { if (empty) return false; } else empty = true; } }
    const rc = new Array(this.rows).fill(0), cc = new Array(this.cols).fill(0);
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) if (fill[r][c]) { rc[r]++; cc[c]++; }
    for (let r = 0; r < this.rows; r++) if (rc[r] !== this.rowClue[r]) return false;
    for (let c = 0; c < this.cols; c++) if (cc[c] !== this.colClue[c]) return false;
    return true;
  }

  _search(countAll) {
    if (Date.now() > this._deadline) { this._timedOut = true; return true; }
    const sLo = this.lo.slice(), sHi = this.hi.slice();
    if (!this._propagate()) { this.lo = sLo; this.hi = sHi; return false; }
    let best = -1, bw = Infinity;
    for (let t = 0; t < this.T; t++) { const w = this.hi[t] - this.lo[t]; if (w > 0 && w < bw) { bw = w; best = t; } }
    if (best === -1) {
      const fill = this._emitLevels(this.lo).map((row) => row.map((v) => (v === 1 ? 1 : 0)));
      if (this._isValid(fill)) { this._count++; if (!this._first) this._first = this.lo.slice(); }
      this.lo = sLo; this.hi = sHi; return this._count >= (countAll ? 2 : 1);
    }
    for (let v = this.lo[best]; v <= this.hi[best]; v++) {
      const bLo = this.lo.slice(), bHi = this.hi.slice();
      this.lo[best] = v; this.hi[best] = v;
      this._search(countAll);
      this.lo = bLo; this.hi = bHi;
      if (this._timedOut || this._count >= (countAll ? 2 : 1)) break;
    }
    this.lo = sLo; this.hi = sHi; return this._count >= (countAll ? 2 : 1);
  }

  solve(countAll = false) {
    this.lo = new Array(this.T).fill(0); this.hi = this.len.slice();
    this._deadline = Date.now() + this.maxMs; this._timedOut = false; this._count = 0; this._first = null;
    if (!this._propagate()) return { solved: false, error: 'No solution (contradiction in givens)' };
    const root = this._emitBounds();
    this._search(countAll);
    if (this._first) return { solved: true, grid: this._emitLevels(this._first), count: this._count };
    if (this._timedOut) return { solved: false, partial: true, grid: root };
    return { solved: false, error: 'No solution found' };
  }

  // Hint engine. initialState = live cellStatus (0 unknown / 1 filled / 2 empty). Seeds bounds from
  // it, propagates, returns newly-decided cells { row, col, value(1 filled / 2 empty) }.
  getHint(initialState) {
    this.lo = new Array(this.T).fill(0); this.hi = this.len.slice();
    for (let t = 0; t < this.T; t++) {
      for (let i = 0; i < this.thermos[t].length; i++) {
        const cell = this.thermos[t][i];
        const v = (initialState[cell.r] && initialState[cell.r][cell.c] !== undefined) ? initialState[cell.r][cell.c] : 0;
        if (v === 1) { if (i + 1 > this.lo[t]) this.lo[t] = i + 1; }   // filled -> level >= i+1
        else if (v === 2) { if (i < this.hi[t]) this.hi[t] = i; }      // empty -> level <= i
      }
      if (this.lo[t] > this.hi[t]) return [];
    }
    this._deadline = Date.now() + (this.maxMs || 1500);
    if (!this._propagate()) return [];
    const out = [];
    for (let t = 0; t < this.T; t++) {
      for (let i = 0; i < this.thermos[t].length; i++) {
        const cell = this.thermos[t][i];
        const was = (initialState[cell.r] && initialState[cell.r][cell.c] !== undefined) ? initialState[cell.r][cell.c] : 0;
        if (was !== 0) continue;
        const nv = i < this.lo[t] ? 1 : (i >= this.hi[t] ? 2 : 0);
        if (nv !== 0) out.push({ row: cell.r, col: cell.c, value: nv });
      }
    }
    return out;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ThermometersSolver };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/thermometers.test.js`
Expected: PASS — 4 tests pass (oracle, propagation, getHint, soundness gate with `mismatches=0`).

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(thermometers): solver core (fill-level CSP, contribution-bound propagation)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" src/solvers/thermometers.js tests/thermometers.test.js
```

---

## Task 2: Real-board fixture + solve test + bench

**Files:**
- Modify: `tests/fixtures/real-puzzles.js` (add `thermometers_15x15`)
- Modify: `tests/thermometers.test.js` (add real-board solve test)
- Create: `tests/bench-thermometers.js`

- [ ] **Step 1: Add the captured fixture**

In `tests/fixtures/real-puzzles.js`, add a `thermometers_15x15` entry to the exported object (follow the file's existing export shape — it exports a map of named puzzles). The fixture stores the raw captured `task` and `areaPoints` (the test converts `areaPoints` → thermos exactly as `readThermometersData` will, validating that conversion):

```js
  thermometers_15x15: {
    rows: 15, cols: 15,
    task: ["2","2","5","10","8","8","12","9","9","9","7","6","12","7","6","8","9","10","11","13","11","1","7","3","2","7","9","11","6","4"].map(Number),
    areaPoints: [[{"row":0,"col":0},{"row":1,"col":0}],[{"row":0,"col":1},{"row":1,"col":1},{"row":2,"col":1},{"row":3,"col":1}],[{"row":0,"col":2},{"row":1,"col":2},{"row":2,"col":2}],[{"row":0,"col":6},{"row":0,"col":5},{"row":0,"col":4},{"row":0,"col":3}],[{"row":0,"col":8},{"row":0,"col":7}],[{"row":0,"col":14},{"row":0,"col":13},{"row":0,"col":12},{"row":0,"col":11},{"row":0,"col":10},{"row":0,"col":9}],[{"row":1,"col":3},{"row":2,"col":3}],[{"row":1,"col":5},{"row":1,"col":4}],[{"row":1,"col":9},{"row":1,"col":8},{"row":1,"col":7},{"row":1,"col":6}],[{"row":1,"col":10},{"row":2,"col":10}],[{"row":1,"col":11},{"row":2,"col":11}],[{"row":1,"col":14},{"row":1,"col":13},{"row":1,"col":12}],[{"row":2,"col":0},{"row":3,"col":0}],[{"row":2,"col":9},{"row":2,"col":8},{"row":2,"col":7},{"row":2,"col":6},{"row":2,"col":5},{"row":2,"col":4}],[{"row":2,"col":13},{"row":2,"col":12}],[{"row":3,"col":14},{"row":2,"col":14}],[{"row":3,"col":10},{"row":3,"col":9},{"row":3,"col":8},{"row":3,"col":7},{"row":3,"col":6},{"row":3,"col":5},{"row":3,"col":4},{"row":3,"col":3},{"row":3,"col":2}],[{"row":3,"col":11},{"row":3,"col":12},{"row":3,"col":13}],[{"row":4,"col":3},{"row":4,"col":2},{"row":4,"col":1},{"row":4,"col":0}],[{"row":4,"col":12},{"row":4,"col":11},{"row":4,"col":10},{"row":4,"col":9},{"row":4,"col":8},{"row":4,"col":7},{"row":4,"col":6},{"row":4,"col":5},{"row":4,"col":4}],[{"row":4,"col":14},{"row":4,"col":13}],[{"row":5,"col":0},{"row":6,"col":0}],[{"row":5,"col":14},{"row":5,"col":13},{"row":5,"col":12},{"row":5,"col":11},{"row":5,"col":10},{"row":5,"col":9},{"row":5,"col":8},{"row":5,"col":7},{"row":5,"col":6},{"row":5,"col":5},{"row":5,"col":4},{"row":5,"col":3},{"row":5,"col":2},{"row":5,"col":1}],[{"row":6,"col":1},{"row":7,"col":1}],[{"row":6,"col":10},{"row":6,"col":9},{"row":6,"col":8},{"row":6,"col":7},{"row":6,"col":6},{"row":6,"col":5},{"row":6,"col":4},{"row":6,"col":3},{"row":6,"col":2}],[{"row":6,"col":11},{"row":7,"col":11}],[{"row":6,"col":12},{"row":7,"col":12}],[{"row":6,"col":14},{"row":6,"col":13}],[{"row":8,"col":0},{"row":7,"col":0}],[{"row":7,"col":4},{"row":7,"col":3},{"row":7,"col":2}],[{"row":7,"col":5},{"row":7,"col":6},{"row":7,"col":7},{"row":7,"col":8},{"row":7,"col":9},{"row":7,"col":10}],[{"row":7,"col":13},{"row":7,"col":14}],[{"row":8,"col":1},{"row":8,"col":2},{"row":8,"col":3}],[{"row":8,"col":13},{"row":8,"col":12},{"row":8,"col":11},{"row":8,"col":10},{"row":8,"col":9},{"row":8,"col":8},{"row":8,"col":7},{"row":8,"col":6},{"row":8,"col":5},{"row":8,"col":4}],[{"row":8,"col":14},{"row":9,"col":14}],[{"row":9,"col":3},{"row":9,"col":2},{"row":9,"col":1},{"row":9,"col":0}],[{"row":9,"col":4},{"row":10,"col":4}],[{"row":9,"col":7},{"row":9,"col":6},{"row":9,"col":5}],[{"row":9,"col":10},{"row":9,"col":9},{"row":9,"col":8}],[{"row":9,"col":11},{"row":9,"col":12},{"row":9,"col":13}],[{"row":10,"col":0},{"row":10,"col":1}],[{"row":10,"col":3},{"row":10,"col":2}],[{"row":10,"col":12},{"row":10,"col":11},{"row":10,"col":10},{"row":10,"col":9},{"row":10,"col":8},{"row":10,"col":7},{"row":10,"col":6},{"row":10,"col":5}],[{"row":10,"col":13},{"row":10,"col":14}],[{"row":11,"col":1},{"row":11,"col":0}],[{"row":11,"col":3},{"row":11,"col":2}],[{"row":11,"col":5},{"row":11,"col":4}],[{"row":11,"col":6},{"row":11,"col":7}],[{"row":11,"col":8},{"row":11,"col":9},{"row":11,"col":10},{"row":11,"col":11},{"row":11,"col":12},{"row":11,"col":13},{"row":11,"col":14}],[{"row":12,"col":10},{"row":12,"col":9},{"row":12,"col":8},{"row":12,"col":7},{"row":12,"col":6},{"row":12,"col":5},{"row":12,"col":4},{"row":12,"col":3},{"row":12,"col":2},{"row":12,"col":1},{"row":12,"col":0}],[{"row":12,"col":14},{"row":12,"col":13},{"row":12,"col":12},{"row":12,"col":11}],[{"row":13,"col":0},{"row":14,"col":0}],[{"row":13,"col":5},{"row":13,"col":4},{"row":13,"col":3},{"row":13,"col":2},{"row":13,"col":1}],[{"row":13,"col":6},{"row":13,"col":7}],[{"row":13,"col":13},{"row":13,"col":12},{"row":13,"col":11},{"row":13,"col":10},{"row":13,"col":9},{"row":13,"col":8}],[{"row":13,"col":14},{"row":14,"col":14}],[{"row":14,"col":13},{"row":14,"col":12},{"row":14,"col":11},{"row":14,"col":10},{"row":14,"col":9},{"row":14,"col":8},{"row":14,"col":7},{"row":14,"col":6},{"row":14,"col":5},{"row":14,"col":4},{"row":14,"col":3},{"row":14,"col":2},{"row":14,"col":1}]],
  },
```

- [ ] **Step 2: Add the real-board solve test**

Append to `tests/thermometers.test.js`:

```js
const REAL = require('./fixtures/real-puzzles.js');

test('Thermometers solve: the real 15x15 board solves uniquely, oracle-passing, cols-first', () => {
  const f = REAL.thermometers_15x15;
  const thermos = f.areaPoints.map((pts) => pts.map((p) => ({ r: p.row, c: p.col })));
  // coverage: every cell belongs to exactly one thermometer
  const cover = Array.from({ length: f.rows }, () => new Array(f.cols).fill(0));
  for (const t of thermos) for (const cell of t) cover[cell.r][cell.c]++;
  for (let r = 0; r < f.rows; r++) for (let c = 0; c < f.cols; c++) assert.equal(cover[r][c], 1, `cell ${r},${c} covered ${cover[r][c]}x`);
  const colClue = f.task.slice(0, f.cols), rowClue = f.task.slice(f.cols); // cols-first (validated)
  const s = new ThermometersSolver({ rows: f.rows, cols: f.cols, thermos, colClue, rowClue, maxMs: 20000 });
  const res = s.solve(true);
  assert.equal(res.solved, true);
  assert.equal(res.partial, undefined);
  assert.equal(res.count, 1, 'unique solution');
  const fill = res.grid.map((row) => row.map((v) => (v === 1 ? 1 : 0)));
  assert.ok(s._isValid(fill), 'oracle rejects own solution');
  assert.equal(fill.flat().filter(Boolean).length, 112); // total filled
});
```

- [ ] **Step 3: Run the real-board test**

Run: `node --test tests/thermometers.test.js`
Expected: PASS — all 5 tests pass (the real board solves uniquely, 112 filled).

- [ ] **Step 4: Create the bench**

Create `tests/bench-thermometers.js`:

```js
'use strict';
const { ThermometersSolver } = require('../src/solvers/thermometers.js');
const REAL = require('./fixtures/real-puzzles.js');

const f = REAL.thermometers_15x15;
const thermos = f.areaPoints.map((pts) => pts.map((p) => ({ r: p.row, c: p.col })));
const colClue = f.task.slice(0, f.cols), rowClue = f.task.slice(f.cols);

// 2 warmup iterations discarded (matches the other bench scripts).
for (let i = 0; i < 2; i++) new ThermometersSolver({ rows: f.rows, cols: f.cols, thermos, colClue, rowClue, maxMs: 30000 }).solve();
const t0 = Date.now();
const res = new ThermometersSolver({ rows: f.rows, cols: f.cols, thermos, colClue, rowClue, maxMs: 30000 }).solve();
const wall = Date.now() - t0;
let filled = 0; if (res.grid) for (const row of res.grid) for (const v of row) if (v === 1) filled++;
console.log(`thermometers 15x15: solved=${res.solved} partial=${!!res.partial} wall=${wall}ms filled=${filled}`);
if (!res.solved) { console.error('UNSOLVED'); process.exit(1); }
console.log('full solve verified');
```

- [ ] **Step 5: Run the bench**

Run: `node tests/bench-thermometers.js`
Expected: `thermometers 15x15: solved=true partial=false wall=<~1>ms filled=112` then `full solve verified`.

- [ ] **Step 6: Commit**

```bash
jj commit -m "test(thermometers): real 15x15 fixture, unique-solve test, bench

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" tests/fixtures/real-puzzles.js tests/thermometers.test.js tests/bench-thermometers.js
```

---

## Task 3: Solver bundling + worker dispatch + globals + eslint

**Files:**
- Modify: `scripts/build-solver-bundle.js` (FILES + EXPORTS)
- Modify: `solver.worker.js` (global comment + dispatch arm)
- Modify: `globals.d.ts:37` (solver decl)
- Modify: `eslint.config.js:76` (solver global)

- [ ] **Step 1: Add to the solver bundle FILES and EXPORTS**

In `scripts/build-solver-bundle.js`, add `'thermometers.js',` to the `FILES` array immediately after `'tents.js',` (must stay before `'diff.js',`):

```js
  'tapa.js',
  'tents.js',
  'thermometers.js',
  'diff.js',
];
```

In the same file, add `'ThermometersSolver',` to the `EXPORTS` array immediately after `'TentsSolver',` (must stay before `'computePuzzleDiff'`):

```js
  'MosaicSolver', 'NorinoriSolver', 'NurikabeSolver', 'PipesSolver', 'ShingokiSolver', 'MasyuSolver', 'ShakashakaSolver', 'LightUpSolver', 'SlantSolver', 'StarBattleSolver', 'StitchesSolver', 'TapaSolver', 'TentsSolver', 'ThermometersSolver', 'computePuzzleDiff',
];
```

- [ ] **Step 2: Add the worker dispatch arm + global comment**

In `solver.worker.js`, append `, ThermometersSolver` to the `/* global ... */` comment on line 5 (after `TentsSolver`):

```js
/* global NonogramSolver, GalaxiesSolver, AquariumSolver, BinairoSolver, ShikakuSolver, YinYangSolver, SlitherlinkSolver, HashiSolver, HeyawakeSolver, HitoriSolver, KakurasuSolver, KurodokoSolver, MosaicSolver, NorinoriSolver, NurikabeSolver, PipesSolver, ShingokiSolver, MasyuSolver, ShakashakaSolver, LightUpSolver, SlantSolver, StarBattleSolver, StitchesSolver, TapaSolver, TentsSolver, ThermometersSolver */
```

In the same file, add the dispatch arm immediately after the `tents` arm (after the line `result = s.solve();` that closes the `tents` block, before the `} else {` fallback):

```js
    } else if (type === 'thermometers' && extraData) {
      const s = new ThermometersSolver({ rows: extraData.rows, cols: extraData.cols, thermos: extraData.thermos, colClue: extraData.colClue, rowClue: extraData.rowClue, maxMs: 30000 });
      result = s.solve();
```

- [ ] **Step 3: Add the TypeScript + eslint globals**

In `globals.d.ts`, add after line 37 (`declare const TentsSolver: any;`):

```ts
declare const ThermometersSolver: any;
```

In `eslint.config.js`, add after line 76 (`TentsSolver: 'readonly',`):

```js
  ThermometersSolver: 'readonly',
```

- [ ] **Step 4: Build and verify the bundle compiles + worker solves**

Run: `npm run build`
Expected: `Wrote dist/solver.js` and `Wrote dist/content.js`, no errors (the bundler throws if a shared-require survives or shared.js isn't first — neither applies here).

Run: `node -e "const {ThermometersSolver}=require('./dist/solver.js'); const REAL=require('./tests/fixtures/real-puzzles.js'); const f=REAL.thermometers_15x15; const thermos=f.areaPoints.map(p=>p.map(q=>({r:q.row,c:q.col}))); const r=new ThermometersSolver({rows:15,cols:15,thermos,colClue:f.task.slice(0,15),rowClue:f.task.slice(15),maxMs:30000}).solve(); console.log('bundle solve solved='+r.solved);"`
Expected: `bundle solve solved=true` (confirms the solver is exported from the built bundle the worker loads).

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(thermometers): bundle the solver + worker dispatch arm

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" scripts/build-solver-bundle.js solver.worker.js globals.d.ts eslint.config.js
```

---

## Task 4: MAIN-world read/apply/dump + background allowlist + globals

**Files:**
- Modify: `main-world.js` (add 3 functions after `applyTentsState` ~line 2111, + dump branch after the `/tents/` branch ~line 2668)
- Modify: `background.js` (3 allowlist entries after `'applyTentsState',` ~line 57)
- Modify: `globals.d.ts` (3 `MainWorldFn` entries after `'applyTentsState'` ~line 121)

- [ ] **Step 1: Add the MAIN-world read/apply functions**

In `main-world.js`, immediately after the `applyTentsState` function (the `}` ending it, ~line 2111), add:

```js
function readThermometersData() {
  try {
    var G = window.Game;
    if (!G || !Array.isArray(G.task) || !Array.isArray(G.areaPoints) || !G.puzzleWidth || !G.puzzleHeight) return null;
    var rows = G.puzzleHeight, cols = G.puzzleWidth;
    var thermos = [];
    for (var t = 0; t < G.areaPoints.length; t++) {
      var pts = G.areaPoints[t] || [], cells = [];
      for (var i = 0; i < pts.length; i++) cells.push({ r: pts[i].row, c: pts[i].col });
      thermos.push(cells);
    }
    var colClue = [], rowClue = [];
    for (var cc = 0; cc < cols; cc++) colClue.push(parseInt(G.task[cc], 10) || 0);
    for (var rr = 0; rr < rows; rr++) rowClue.push(parseInt(G.task[cols + rr], 10) || 0);
    return { rows: rows, cols: cols, thermos: thermos, colClue: colClue, rowClue: rowClue };
  } catch (e) { return null; }
}

function readThermometersState(rows, cols) {
  try {
    var G = window.Game;
    if (!G || !G.currentState || !G.currentState.cellStatus) return null;
    var cs = G.currentState.cellStatus, grid = [];
    for (var r = 0; r < rows; r++) { var row = cs[r] || [], arr = new Array(cols); for (var c = 0; c < cols; c++) arr[c] = row[c] || 0; grid.push(arr); }
    return grid;
  } catch (e) { return null; }
}

function applyThermometersState(grid) {
  try {
    var G = window.Game;
    if (!G || !G.currentState || !G.currentState.cellStatus) return false;
    if (typeof G.saveState === 'function') G.saveState(true);
    var cs = G.currentState.cellStatus, rows = G.puzzleHeight, cols = G.puzzleWidth;
    for (var r = 0; r < rows; r++) {
      if (!cs[r]) cs[r] = [];
      for (var c = 0; c < cols; c++) {
        var v = (grid[r] && grid[r][c] !== undefined) ? grid[r][c] : 0;
        if (v === 1 || v === 2) cs[r][c] = v; // 1 filled / 2 empty; 0 (unknown) left untouched
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

- [ ] **Step 2: Add the dump branch**

In `main-world.js`, in `dumpPuzzleForBench`, immediately after the closing `}` of the `/tents/` branch (~line 2668, the `}` after `return { type: 'tents', ... };`), add:

```js
    if (path.indexOf('/thermometers/') !== -1 || g.slug === 'thermometers') {
      if (!Array.isArray(g.task) || !Array.isArray(g.areaPoints) || !g.puzzleWidth || !g.puzzleHeight) return { error: 'thermometers: missing task/areaPoints/dims', diagnostic: diagnostic(g), path: path };
      var thRows = g.puzzleHeight, thCols = g.puzzleWidth, thTherm = [], thCol = [], thRow = [];
      for (var tht = 0; tht < g.areaPoints.length; tht++) { var thPts = g.areaPoints[tht] || [], thCells = []; for (var thi = 0; thi < thPts.length; thi++) thCells.push({ r: thPts[thi].row, c: thPts[thi].col }); thTherm.push(thCells); }
      for (var thcc = 0; thcc < thCols; thcc++) thCol.push(parseInt(g.task[thcc], 10) || 0);
      for (var thrr = 0; thrr < thRows; thrr++) thRow.push(parseInt(g.task[thCols + thrr], 10) || 0);
      return { type: 'thermometers', rows: thRows, cols: thCols, thermos: thTherm, colClue: thCol, rowClue: thRow, path: path };
    }
```

- [ ] **Step 3: Add the background allowlist entries**

In `background.js`, in the `EXEC_MAIN_ALLOWLIST` set, add after `'applyTentsState',` (~line 57):

```js
  'readThermometersData',
  'readThermometersState',
  'applyThermometersState',
```

- [ ] **Step 4: Add the MainWorldFn type entries**

In `globals.d.ts`, in the `MainWorldFn` union, add after `| 'applyTentsState'` (~line 121):

```ts
  | 'readThermometersData'
  | 'readThermometersState'
  | 'applyThermometersState'
```

- [ ] **Step 5: Verify lint + typecheck + build (no functional test yet — these run in the page)**

Run: `npm run lint && npm run typecheck && npm run build`
Expected: all succeed, no errors. (The allowlist and `MainWorldFn` union must stay in sync — both got the same 3 names.)

- [ ] **Step 6: Commit**

```bash
jj commit -m "feat(thermometers): MAIN-world read/apply/dump + background allowlist

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" main-world.js background.js globals.d.ts
```

---

## Task 5: Content-script handler

**Files:**
- Modify: `handler.js` (add `thermometersHandler` + `registerHandler` after the `tentsHandler` block, ~line 1362, before the `// ── Puzzles-mobile handler ──` section)

- [ ] **Step 1: Add the handler**

In `handler.js`, immediately after `registerHandler(tentsHandler);` (~line 1362), add:

```js
// ── Thermometers handler (puzzles-mobile.com/thermometers/) ───

const thermometersHandler = {
  name: 'puzzles-mobile-thermometers',
  priority: 30,

  matches() {
    return isPuzzlesMobilePage() && window.location.pathname.includes('/thermometers/');
  },

  async detect() {
    const result = { found: false, rows: 0, cols: 0, rowClues: [], colClues: [] };
    const data = await callMainWorld('readThermometersData', []);
    if (!data) return { ...result, error: 'No Thermometers task data found' };
    const stageEl = document.getElementById('stage') || document.getElementById('game') ||
                    document.querySelector('[class*="game"], [class*="puzzle"]');
    return { found: true, type: 'thermometers', rows: data.rows, cols: data.cols, thermos: data.thermos, colClue: data.colClue, rowClue: data.rowClue, rowClues: [], colClues: [], _cells: [], _element: stageEl };
  },

  async readState(ctx) {
    const state = await callMainWorld('readThermometersState', [ctx.rows, ctx.cols]);
    if (state) return state; // RAW cellStatus 0/1/2 (no normalization — like tents)
    return Array.from({ length: ctx.rows }, () => new Array(ctx.cols).fill(0));
  },

  async applySolution(solution, _ctx) {
    const ok = await callMainWorld('applyThermometersState', [solution]);
    return ok ? { success: true } : { success: false, error: 'Thermometers apply failed' };
  },
};

registerHandler(thermometersHandler);
```

- [ ] **Step 2: Verify lint + typecheck + build**

Run: `npm run lint && npm run typecheck && npm run build`
Expected: all succeed. (`registerHandler(...)` runs under Node `require` of handler.js but only pushes to a local array; this handler touches `window`/`document` only inside function bodies, so the Node-side require does not throw — per AGENTS.md.)

- [ ] **Step 3: Commit**

```bash
jj commit -m "feat(thermometers): content-script handler

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" handler.js
```

---

## Task 6: Widget module + registry + content bundle + partial-dispatch + final verify

**Files:**
- Create: `src/widget/puzzles/thermometers.js`
- Modify: `src/widget/puzzles/index.js` (register in `PUZZLES`)
- Modify: `scripts/build-content-bundle.js` (FILES)
- Modify: `eslint.config.js` (`thermometers` global, ~line 345)
- Modify: `src/widget/widget.js` (partial-dispatch branch, ~line 532)

- [ ] **Step 1: Create the widget module**

Create `src/widget/puzzles/thermometers.js`:

```js
'use strict';

const { hashFNV1a } = require('../shared.js');

// Thermometers widget module — cell-state puzzle (Tapa/Tents family, margin clues). Value-space:
// cellStatus 0 unknown / 1 filled (mercury) / 2 empty. EVERY cell is tracked (no clue cells). Solver
// grid = 1 filled / 2 empty; readState is RAW so the default per-cell diff applies. drawStaticLayer
// renders the thermometer tubes + bulbs + row/col clue gutters; drawPreviewCell draws mercury.
// NO preview.js/diff.js/hint.js changes. hintDispatch has a cached-solution fallback (same as tents).

function hintBatchCap(rows, cols) { return Math.max(6, Math.ceil((rows * cols) / 30)); }

const thermometers = {
  type: 'thermometers',
  label: 'Thermometers',
  url: 'https://www.puzzles-mobile.com/thermometers/',
  solutionKeyPrefix: 'thermometers-solution:',
  skipAutoSolveGate: true,
  hasAbsoluteHintCells: true,
  hintBandSkip: true,
  renderEmptyCells: true,

  cacheKey(data) {
    if (data?.type !== 'thermometers' || !data.thermos) return null;
    const h = hashFNV1a((mix) => { mix(0x54); mix(data.rows); mix(data.cols); for (const therm of data.thermos) { mix(therm.length); for (const cell of therm) { mix(cell.r); mix(cell.c); } } for (const v of (data.colClue || [])) mix((v | 0) + 1); for (const v of (data.rowClue || [])) mix((v | 0) + 1); });
    return 'thermometers-solution:' + h.toString(16);
  },

  staticSig(data) { return 'th=' + _thermoSig(data?.type === 'thermometers' ? data : null); },

  canvasDims(pd, { grid }) {
    return { rows: pd?.rows || (Array.isArray(grid) ? grid.length : 0), cols: pd?.cols || (Array.isArray(grid) && grid[0] ? grid[0].length : 0), marginCells: 0.6 };
  },

  // Static layer: thermometer tubes (grey) with a bulb circle at index 0 + row/col clue gutters + border.
  drawStaticLayer(ctx, { rows, cols, cellSize, pd }) {
    const thermos = (pd && pd.thermos) || [], colClue = (pd && pd.colClue) || [], rowClue = (pd && pd.rowClue) || [];
    ctx.save();
    ctx.strokeStyle = '#cbd5e1'; ctx.fillStyle = '#cbd5e1';
    ctx.lineWidth = cellSize * 0.6; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const therm of thermos) {
      if (!therm || !therm.length) continue;
      const b = therm[0], bx = (b.c + 0.5) * cellSize, by = (b.r + 0.5) * cellSize;
      ctx.beginPath(); ctx.arc(bx, by, cellSize * 0.4, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath();
      for (let i = 0; i < therm.length; i++) { const x = (therm[i].c + 0.5) * cellSize, y = (therm[i].r + 0.5) * cellSize; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
      ctx.stroke();
    }
    ctx.fillStyle = '#1f2937'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `bold ${Math.max(8, Math.floor(cellSize * 0.5))}px sans-serif`;
    const g = cellSize * 0.6;
    for (let c = 0; c < cols; c++) ctx.fillText(String(colClue[c] ?? ''), (c + 0.5) * cellSize, -g / 2);
    for (let r = 0; r < rows; r++) ctx.fillText(String(rowClue[r] ?? ''), -g / 2, (r + 0.5) * cellSize);
    const borderW = Math.max(2, Math.floor(cellSize / 6));
    ctx.strokeStyle = '#1f2937'; ctx.lineWidth = borderW; ctx.lineCap = 'square';
    ctx.strokeRect(borderW / 2, borderW / 2, cols * cellSize - borderW, rows * cellSize - borderW);
    ctx.restore();
  },

  // Dynamic: filled (1) -> red mercury circle; empty (2) -> bare tube (drawn by static layer).
  drawPreviewCell(ctx, { v, x, y, cellSize }) {
    if (v === 1) { ctx.fillStyle = '#ef4444'; ctx.beginPath(); ctx.arc(x + cellSize / 2, y + cellSize / 2, cellSize * 0.28, 0, Math.PI * 2); ctx.fill(); }
  },

  drawHintCell(ctx, { cell, cx, cy, cellSize }) {
    if (cell.value === 1 || cell.value === 2) { ctx.strokeStyle = cell.value === 1 ? '#ef4444' : '#60a5fa'; ctx.lineWidth = Math.max(2, Math.floor(cellSize / 9)); ctx.strokeRect(cx + 2, cy + 2, cellSize - 4, cellSize - 4); }
  },

  hintStatusNodes(h, { bold }) {
    const cells = h.extraCells || [];
    if (!cells.length) return ['No hint available'];
    if (cells.length === 1) { const cell = cells[0]; return ['Cell ', bold(`(row ${cell.row + 1}, col ${cell.col + 1})`), ' is ', bold(cell.value === 1 ? 'filled' : 'empty')]; }
    return [bold(String(cells.length)), ' cells can be deduced'];
  },

  solveExtraData(data) { return { rows: data.rows, cols: data.cols, thermos: data.thermos, colClue: data.colClue, rowClue: data.rowClue }; },
  solutionFromResult(result) { return (result && result.grid) ? result.grid : null; },
  solutionToCacheJson(solution) { return Array.isArray(solution) ? { grid: solution.map((row) => row.slice()) } : null; },
  solutionFromCacheJson(parsed) { return (parsed && Array.isArray(parsed.grid)) ? parsed.grid.map((row) => row.slice()) : null; },

  partialResultArm(result, { applyGridPartialResult }) { applyGridPartialResult(result); },

  hintDispatch(ctx) {
    const { grid, solution, rows, cols, detectedGrid, firstMismatch } = ctx;
    if (solution && firstMismatch && firstMismatch(grid, solution)) {
      return { success: false, error: 'Current game state is wrong.' };
    }
    const dg = detectedGrid;
    if (dg && Array.isArray(dg.thermos)) {
      const Solver = (typeof ThermometersSolver !== 'undefined') ? ThermometersSolver : require('../../solvers/thermometers.js').ThermometersSolver;
      const forced = new Solver({ rows, cols, thermos: dg.thermos, colClue: dg.colClue, rowClue: dg.rowClue, maxMs: 1500 }).getHint(grid);
      if (forced && forced.length) {
        const batch = forced.slice(0, hintBatchCap(rows, cols));
        return { success: true, hint: { type: 'thermometers', extraCells: batch, count: batch.length }, grid, solution };
      }
    }
    if (!Array.isArray(solution)) return { success: false, error: 'No more cells can be deduced. Click Solve to finish.' };
    const cap = hintBatchCap(rows, cols); const cells = [];
    for (let r = 0; r < rows && cells.length < cap; r++) for (let c = 0; c < cols && cells.length < cap; c++) {
      const sv = solution[r] ? solution[r][c] : 0;
      if (sv !== 1 && sv !== 2) continue;
      const cur = grid && grid[r] ? grid[r][c] : 0;
      if (cur === sv) continue;
      cells.push({ row: r, col: c, value: sv });
    }
    if (!cells.length) return { success: false, error: 'No hint available' };
    return { success: true, hint: { type: 'thermometers', extraCells: cells, count: cells.length }, grid, solution };
  },
};

function _thermoSig(data) {
  if (!data) return '0';
  const h = hashFNV1a((mix) => { for (const therm of (data.thermos || [])) { mix(therm.length); for (const cell of therm) { mix(cell.r); mix(cell.c); } } for (const v of (data.colClue || [])) mix((v | 0) + 1); for (const v of (data.rowClue || [])) mix((v | 0) + 1); });
  return h.toString(16);
}

if (typeof module !== 'undefined' && module.exports) { module.exports = thermometers; }
```

- [ ] **Step 2: Register the module + bundle it + eslint global**

In `src/widget/puzzles/index.js`, add after the `tents` line:

```js
if (typeof thermometers !== 'undefined') PUZZLES[thermometers.type] = thermometers;
```

In `scripts/build-content-bundle.js`, add `'puzzles/thermometers.js',` to the `FILES` array immediately after `'puzzles/tents.js',`:

```js
  'puzzles/tents.js',
  'puzzles/thermometers.js',
```

In `eslint.config.js`, add after `tents: 'readonly',` (~line 345):

```js
        thermometers: 'readonly',
```

- [ ] **Step 3: Add the partial-dispatch branch**

In `src/widget/widget.js`, immediately after the `tents` partial branch (the `}` after `return;` at ~line 532, before the `// Generic cell-state partial:` comment), add:

```js
      if (result?.partial && puzzleData?.type === 'thermometers' && Array.isArray(result.grid)) {
        applyPartialResult(result);
        return;
      }
```

- [ ] **Step 4: Build + full verification**

Run: `npm run build && npm run lint && npm run typecheck && npm test`
Expected: build writes `dist/solver.js` + `dist/content.js`; lint + typecheck clean; **all tests pass** (the full suite plus the 5 new thermometers tests).

Run: `node tests/bench-thermometers.js`
Expected: `thermometers 15x15: solved=true partial=false wall=<~1>ms filled=112`.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(thermometers): widget module, registry, partial-dispatch, bundle

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" src/widget/puzzles/thermometers.js src/widget/puzzles/index.js scripts/build-content-bundle.js eslint.config.js src/widget/widget.js
```

---

## Final review (after all tasks)

Dispatch a final whole-implementation code review covering: solver soundness (gate green), all wiring touchpoints present and in sync (allowlist ↔ MainWorldFn, FILES ↔ EXPORTS), the partial-dispatch branch present, no `git` used (jj only), and a manual reload check on a live `/thermometers/` board (Detect → Solve → Hint → Loop; verify tube/bulb/mercury rendering and clue gutters — the preview geometry is empirical, like the Shakashaka note).

## Notes / known empirical points to verify on the live page

- **Preview geometry** (tube width, bulb radius, mercury circle size/colour) is a first cut — verify it reads clearly on the live board and adjust constants in `drawStaticLayer`/`drawPreviewCell` if needed (no logic impact).
- **Clue orientation** (cols-first) is validated against the captured board; if a future board ever fails to detect/solve, re-confirm the `task` split.
```
