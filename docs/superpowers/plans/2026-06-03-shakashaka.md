# Shakashaka Puzzle Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add full Shakashaka support (Detect / Solve / Hint / Loop) to the puzzles-mobile.com Chrome extension, mirroring the other 16 puzzles.

**Architecture:** A pure `ShakashakaSolver` (CSP: each open cell ∈ {white, 4 triangles}; constraints = the page's ported `hasNonRect` local edge-matching + `taskMarkedCount` number clues; propagation + MRV backtracking + trail undo + sound partial on timeout). Wired through the standard registry: solver bundle, widget module, main-world read/apply/dump, worker dispatch, handler. The ported page predicates are the ground-truth validity oracle; a brute-force enumerator gates solver soundness.

**Tech Stack:** Plain JS, `node:test`, `jj` (NEVER `git`). Spec: `docs/superpowers/specs/2026-06-03-shakashaka-design.md`.

**IMPORTANT — `jj`, NEVER `git`.** Commit trailer:
```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

## Encoding reference (from recon — the ground truth)

- `task[r][c]`: `-1` open cell · `-2` black no-number · `0..4` numbered black cell. Dims = `task.length` × `task[0].length`.
- Page `cellStatus`: `0` empty · `1,2,3,4` triangle orientations · `5` explicit white.
- **Board-state space** (the solver's space; matches the page's `getBoardCellSt`): black = `-1` (fixed); open cell ∈ `{0=white, 1,2,3,4=triangle}`. Page cellStatus 0 AND 5 both map to board-state 0 (white).
- **`taskMarkedCount`** (page source, verbatim): counts orthogonal neighbours (W,E,N,S, in-range) whose `cellStatus` is `1..4` (a triangle). In board-state space = neighbours with value `1..4`.
- **`hasNonRect`** (page source, verbatim — THE rectangle rule to port; iterates open cells `task==-1`, `i = getBoardCellSt(t,e)`):
```
i==0 (white): for each diagonal corner, if both orthogonal neighbours toward it are white (falsy)
  but the diagonal neighbour o is non-white (truthy) and o != matchType -> VIOLATION.
  matchType: up-left->1, up-right->2, down-right->3, down-left->4.
i==1: need e<W-1 (else viol). right=get(t,e+1): if truthy, must==2 else viol;
      if falsy(white): need t>0 (else viol) and get(t-1,e+1)==1 (else viol).
      need t<H-1 (else viol). down=get(t+1,e): if truthy must==4 else viol;
      if white: need e>0 and get(t+1,e-1)==1.
i==2: need e>0. left=get(t,e-1): truthy must==1 else viol; if white need t>0 and get(t-1,e-1)==2.
      need t<H-1. down=get(t+1,e): truthy must==3 else viol; if white need e<W-1 and get(t+1,e+1)==2.
i==3: need e>0. left=get(t,e-1): truthy must==4 else viol; if white need t<H-1 and get(t+1,e-1)==3.
      need t>0. up=get(t-1,e): truthy must==2 else viol; if white need e<W-1 and get(t-1,e+1)==3.
i==4: need e<W-1. right=get(t,e+1): truthy must==3 else viol; if white need t<H-1 and get(t+1,e+1)==4.
      need t>0. up=get(t-1,e): truthy must==1 else viol; if white need e>0 and get(t-1,e-1)==4.
```
where `get(r,c)` = board-state value (only ever called in-range; black=-1 truthy, white=0 falsy, triangle 1..4 truthy). "VIOLATION" = `hasNonRect` returns this cell. The FULL VERBATIM source is preserved at the end of this plan ("Appendix: verbatim page source") — port from THAT, then verify against these decoded notes.

A complete board is **valid** iff no open cell triggers `hasNonRect` AND every numbered clue's `taskMarkedCount` equals its number.

## File Structure & wiring checklist (mirrors Shingoki)

| File | Action |
| --- | --- |
| `src/solvers/shakashaka.js` | **Create** — `ShakashakaSolver` |
| `tests/shakashaka.test.js` | **Create** — oracle + brute-force + solver tests |
| `tests/fixtures/real-puzzles.js` | **Modify** — add `shakashaka_25x25` fixture |
| `scripts/build-solver-bundle.js` | **Modify** — add `'shakashaka.js'` to FILES + `'ShakashakaSolver'` to EXPORTS |
| `solver.worker.js` | **Modify** — `shakashaka` dispatch branch + global comment |
| `handler.js` | **Modify** — `shakashakaHandler` + `registerHandler` |
| `main-world.js` | **Modify** — `readShakashakaData`/`readShakashakaState`/`applyShakashakaState` + dump branch |
| `background.js` | **Modify** — 3 fn names → `EXEC_MAIN_ALLOWLIST` |
| `globals.d.ts` | **Modify** — `ShakashakaSolver` decl + 3 fn names → `MainWorldFn` |
| `src/widget/puzzles/shakashaka.js` | **Create** — registry-hook module |
| `src/widget/puzzles/index.js` | **Modify** — register `shakashaka` into `PUZZLES` |
| `scripts/build-content-bundle.js` | **Modify** — add `'puzzles/shakashaka.js'` to WIDGET_FILES (before `puzzles/index.js`) |
| `manifest.json` | **No change** (already matches `puzzles-mobile.com/*`) — confirm |

---

### Task 1: Solver core — board model + ported oracle + brute-force enumerator

**Files:** Create `src/solvers/shakashaka.js`; Create `tests/shakashaka.test.js`.

- [ ] **Step 1: Write the failing oracle tests**

Create `tests/shakashaka.test.js`:
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ShakashakaSolver } = require('../src/solvers/shakashaka.js');

// Build a solver over a task grid (-1 open, -2 black, 0..4 numbered black).
function mk(task) { return new ShakashakaSolver({ task }); }

test('Shakashaka oracle: taskMarkedCount counts adjacent triangles', () => {
  // 1x3: black-numbered at (0,1) with two open neighbours.
  const s = mk([[-1, 0, -1]]);
  // board-state grid: open cells set to triangle(1) / white(0)
  const board = [[1, -1, 0]]; // left triangle, center black, right white
  assert.equal(s._taskMarkedCount(board, 0, 1), 1);
  const board2 = [[1, -1, 2]];
  assert.equal(s._taskMarkedCount(board2, 0, 1), 2);
});

test('Shakashaka oracle: hasNonRect flags a triangle with a wrong right neighbour', () => {
  // T1 at (0,0) requires right neighbour == T2 (it is T3 -> violation).
  const s = mk([[-1, -1]]);
  const board = [[1, 3]];
  assert.ok(s._hasNonRectAt(board, 0, 0)); // T1's right must be 2
});

test('Shakashaka oracle: hasNonRect accepts a valid T1/T2 pairing', () => {
  // T1 then T2 horizontally, with borders below -> need to satisfy down rule too.
  // Use a 2-wide, check the per-cell predicate for the T1 cell on a board where
  // right=2 and down is white at the edge (t<H-1 false -> border ok path).
  const s = mk([[-1, -1]]);   // 1 row -> t<H-1 is false for both, so the "need t<H-1" returns violation
  // On a 1-row board T1 violates (needs a down neighbour). Use 2 rows:
  const s2 = mk([[-1, -1], [-1, -1]]);
  // board where (0,0)=T1, (0,1)=T2, (1,0)=T4, (1,1)=T3 forms a closed diamond (valid).
  const board = [[1, 2], [4, 3]];
  assert.equal(s2._hasNonRectAt(board, 0, 0), false);
  assert.equal(s2._hasNonRectAt(board, 0, 1), false);
  assert.equal(s2._hasNonRectAt(board, 1, 0), false);
  assert.equal(s2._hasNonRectAt(board, 1, 1), false);
});

test('Shakashaka oracle: a 2x2 diamond of triangles is a fully valid board', () => {
  const s = mk([[-1, -1], [-1, -1]]);
  const board = [[1, 2], [4, 3]];
  assert.equal(s._hasNonRect(board), false);    // no cell violates
});
```

- [ ] **Step 2: Run → FAIL** (`ShakashakaSolver` not defined).
Run: `node --test --test-name-pattern='Shakashaka oracle' tests/shakashaka.test.js`

- [ ] **Step 3: Implement the board model + ported oracle**

Create `src/solvers/shakashaka.js`. Port `_taskMarkedCount` and `_hasNonRectAt`/`_hasNonRect` FAITHFULLY from the Appendix source. The solver works on a `board` grid in board-state space: `-1` black (where `task != -1`), `0..4` for open cells, and a sentinel `UNK = 9` for undecided open cells.

```js
'use strict';
const { timeUp } = require('./shared.js');

const UNK = 9; // undecided open cell

class ShakashakaSolver {
  constructor({ task, maxMs = 0 }) {
    this.task = task;
    this.rows = task.length;
    this.cols = task[0].length;
    this.maxMs = maxMs;
    this._startedAt = 0;
  }

  // Board-state of a cell for the rule functions: black cells (task!=-1) -> -1;
  // otherwise the board value (0 white, 1..4 triangle, or UNK if undecided).
  _bs(board, r, c) { return this.task[r][c] !== -1 ? -1 : board[r][c]; }

  // Ported taskMarkedCount: # orthogonal neighbours that are triangles (1..4).
  _taskMarkedCount(board, t, e) {
    const { rows, cols } = this; let s = 0;
    const tri = (r, c) => { const v = this._bs(board, r, c); return v >= 1 && v <= 4; };
    if (e > 0 && tri(t, e - 1)) s++;
    if (e < cols - 1 && tri(t, e + 1)) s++;
    if (t > 0 && tri(t - 1, e)) s++;
    if (t < rows - 1 && tri(t + 1, e)) s++;
    return s;
  }

  // Ported hasNonRect per-cell predicate. Returns true iff open cell (t,e)
  // triggers a rectangle violation on a COMPLETE board. (See Appendix for the
  // verbatim source; this is a faithful 1:1 port.)
  _hasNonRectAt(board, t, e) {
    const { rows: H, cols: W } = this;
    const g = (r, c) => this._bs(board, r, c);
    const i = g(t, e);
    if (i === 0) {
      if (t > 0 && e > 0)       { const r = g(t-1,e), l = g(t,e-1), o = g(t-1,e-1); if (!r && !l && o && o !== 1) return true; }
      if (t > 0 && e < W-1)     { const r = g(t-1,e), l = g(t,e+1), o = g(t-1,e+1); if (!r && !l && o && o !== 2) return true; }
      if (t < H-1 && e < W-1)   { const r = g(t+1,e), l = g(t,e+1), o = g(t+1,e+1); if (!r && !l && o && o !== 3) return true; }
      if (t < H-1 && e > 0)     { const r = g(t+1,e), l = g(t,e-1), o = g(t+1,e-1); if (!r && !l && o && o !== 4) return true; }
      return false;
    }
    if (i === 1) {
      if (!(e < W-1)) return true;
      let s = g(t, e+1); if (s) { if (s !== 2) return true; } else { if (!t) return true; if (g(t-1,e+1) !== i) return true; }
      if (!(t < H-1)) return true;
      s = g(t+1, e); if (s) { if (s !== 4) return true; } else { if (!e) return true; if (g(t+1,e-1) !== i) return true; }
      return false;
    }
    if (i === 2) {
      if (!e) return true;
      let s = g(t, e-1); if (s) { if (s !== 1) return true; } else { if (!t) return true; if (g(t-1,e-1) !== i) return true; }
      if (!(t < H-1)) return true;
      s = g(t+1, e); if (s) { if (s !== 3) return true; } else { if (!(e < W-1)) return true; if (g(t+1,e+1) !== i) return true; }
      return false;
    }
    if (i === 3) {
      if (!e) return true;
      let s = g(t, e-1); if (s) { if (s !== 4) return true; } else { if (!(t < H-1)) return true; if (g(t+1,e-1) !== i) return true; }
      if (!t) return true;
      s = g(t-1, e); if (s) { if (s !== 2) return true; } else { if (!(e < W-1)) return true; if (g(t-1,e+1) !== i) return true; }
      return false;
    }
    if (i === 4) {
      if (!(e < W-1)) return true;
      let s = g(t, e+1); if (s) { if (s !== 3) return true; } else { if (!(t < H-1)) return true; if (g(t+1,e+1) !== i) return true; }
      if (!t) return true;
      s = g(t-1, e); if (s) { if (s !== 1) return true; } else { if (!e) return true; if (g(t-1,e-1) !== i) return true; }
      return false;
    }
    return false; // UNK or other: not a determinate violation
  }

  // Full-board rectangle check (complete board). Returns the first offending
  // [t,e] or false. Mirrors the page's hasNonRect (iterates open cells only).
  _hasNonRect(board) {
    for (let t = 0; t < this.rows; t++) for (let e = 0; e < this.cols; e++) {
      if (this.task[t][e] === -1 && this._hasNonRectAt(board, t, e)) return [t, e];
    }
    return false;
  }

  // A complete board is valid iff no non-rect AND all number clues match.
  _isValid(board) {
    if (this._hasNonRect(board)) return false;
    for (let t = 0; t < this.rows; t++) for (let e = 0; e < this.cols; e++) {
      const k = this.task[t][e];
      if (k >= 0 && this._taskMarkedCount(board, t, e) !== k) return false;
    }
    return true;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ShakashakaSolver };
}
```

- [ ] **Step 4: Run → PASS** the oracle tests. If a `_hasNonRectAt` case fails, re-check the port against the Appendix (the border/`!(e<W-1)` conditions are easy to flip).
Run: `node --test --test-name-pattern='Shakashaka oracle' tests/shakashaka.test.js`

- [ ] **Step 5: Add the brute-force enumerator + a test pinning it**

Append to `tests/shakashaka.test.js`. The brute force enumerates every open cell over {0,1,2,3,4}, keeps boards passing `_isValid`. Tractable for ≤ ~10 open cells.
```js
function bruteForce(task) {
  const s = new ShakashakaSolver({ task });
  const rows = task.length, cols = task[0].length;
  const open = [];
  const board = task.map(row => row.map(v => (v === -1 ? 0 : -1)));
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (task[r][c] === -1) open.push([r, c]);
  const sols = [];
  const rec = (i) => {
    if (i === open.length) { if (s._isValid(board)) sols.push(board.map(row => row.slice())); return; }
    const [r, c] = open[i];
    for (let v = 0; v <= 4; v++) { board[r][c] = v; rec(i + 1); }
    board[r][c] = 0;
  };
  rec(0);
  return sols;
}

test('Shakashaka brute-force: a tiny board has a known solution count', () => {
  // 2x2 all-open: enumerate; assert at least the diamond [[1,2],[4,3]] is found.
  const sols = bruteForce([[-1,-1],[-1,-1]]);
  assert.ok(sols.length >= 1);
  assert.ok(sols.some(b => b[0][0]===1 && b[0][1]===2 && b[1][0]===4 && b[1][1]===3));
});
```

- [ ] **Step 6: Run → PASS, then commit**

Run: `node --test tests/shakashaka.test.js` → all pass.
```bash
jj commit -m "feat(shakashaka): solver board model + ported hasNonRect/taskMarkedCount oracle + brute-force

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The CSP solver (propagation + backtracking + partial)

**Files:** Modify `src/solvers/shakashaka.js`; Modify `tests/shakashaka.test.js`.

- [ ] **Step 1: Write the failing solve tests (incl. the brute-force soundness gate)**

```js
test('Shakashaka solve: solves a tiny board to a valid board', () => {
  const task = [[-1,-1],[-1,-1]];
  const res = new ShakashakaSolver({ task, maxMs: 5000 }).solve();
  assert.equal(res.solved, true);
  const chk = new ShakashakaSolver({ task });
  assert.equal(chk._isValid(res.cells), true);
});

test('Shakashaka solve: never spurious-UNSAT + matches brute-force on small boards', () => {
  // Several small satisfiable boards (mix of open + numbered/black).
  const boards = [
    [[-1,-1],[-1,-1]],
    [[-1,-1,-1],[-1,-2,-1],[-1,-1,-1]],
    [[-1,0,-1],[-1,-1,-1]],
    [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  ];
  for (const task of boards) {
    const all = bruteForce(task);
    const res = new ShakashakaSolver({ task, maxMs: 10000 }).solve();
    if (all.length === 0) { assert.notEqual(res.solved, true); continue; }
    assert.equal(res.solved, true, 'solvable board must solve');
    const chk = new ShakashakaSolver({ task });
    assert.equal(chk._isValid(res.cells), true, 'solver output must be valid');
  }
});

test('Shakashaka solve: forced cells hold in every solution (propagation soundness)', () => {
  // For a board, the cells the solver decides BEFORE any branch (pure propagation)
  // must match all brute-force solutions. Exposed via solveDeduce() (propagation
  // to fixpoint, no search) returning the determined board.
  const task = [[-1,-1,-1],[-1,-2,-1],[-1,-1,-1]];
  const all = bruteForce(task);
  const det = new ShakashakaSolver({ task })._deduceOnly(); // {cells, ok}
  if (det.ok) for (let r=0;r<task.length;r++) for (let c=0;c<task[0].length;c++) {
    if (task[r][c] !== -1) continue;
    if (det.cells[r][c] !== 9) { // decided
      for (const sol of all) assert.equal(sol[r][c], det.cells[r][c], `forced (${r},${c}) must hold in all solutions`);
    }
  }
});
```

- [ ] **Step 2: Run → FAIL** (`solve`/`_deduceOnly` not functions).

- [ ] **Step 3: Implement domains, propagation, search, `solve()`**

Add to `ShakashakaSolver`. Represent each open cell's domain as a bitmask over values 0..4 (bit v set = value v still possible). Black cells are fixed. SOUNDNESS: propagation may prune a value v at cell X only when assigning v is *certainly* invalid given currently-decided cells — i.e. it would make some open cell's FULLY-DECIDED local neighbourhood violate `_hasNonRectAt`, or break a number clue's feasible range. Otherwise keep it. Final leaf is validated by `_isValid`. (The brute-force test gates this.)

```js
  _initDomains() {
    const full = 0b11111; // values 0,1,2,3,4
    this._dom = this.task.map(row => row.map(v => (v === -1 ? full : 0)));
  }
  _boardFromDomains() {
    // singleton domains -> value; else UNK; black -> -1
    return this.task.map((row, r) => row.map((v, c) => {
      if (v !== -1) return -1;
      const d = this._dom[r][c];
      if (d && (d & (d - 1)) === 0) { let x = 0, m = d; while (m > 1) { m >>= 1; x++; } return x; }
      return UNK;
    }));
  }
  // Is value v at (r,c) locally consistent? Tentatively place it and check that no
  // open cell whose neighbourhood is now fully decided violates _hasNonRectAt, and
  // that no number clue is exceeded / made unreachable. Returns false if v is
  // provably impossible. Conservative: when a neighbourhood is not fully decided,
  // do NOT flag (sound — only prunes certain impossibilities).
  _consistent(board, r, c, v) {
    board[r][c] = v;
    let ok = true;
    // check this cell + 8 neighbours' rectangle predicate, only where fully decided
    for (let dr = -1; dr <= 1 && ok; dr++) for (let dc = -1; dc <= 1 && ok; dc++) {
      const t = r + dr, e = c + dc;
      if (t < 0 || e < 0 || t >= this.rows || e >= this.cols) continue;
      if (this.task[t][e] !== -1) continue;
      if (this._neighbourhoodDecided(board, t, e) && this._hasNonRectAt(board, t, e)) ok = false;
    }
    // number-clue feasibility around (r,c)
    if (ok) ok = this._clueFeasibleAround(board, r, c);
    board[r][c] = UNK;
    return ok;
  }
  _neighbourhoodDecided(board, t, e) {
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const r = t + dr, c = e + dc;
      if (r < 0 || c < 0 || r >= this.rows || c >= this.cols) continue;
      if (this.task[r][c] === -1 && board[r][c] === UNK) return false;
    }
    return true;
  }
  // For each numbered clue adjacent to (r,c): current triangle count must be <= k,
  // and k must be reachable given still-UNK neighbours (each can be a triangle).
  _clueFeasibleAround(board, r, c) {
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (Math.abs(dr) + Math.abs(dc) !== 1 && !(dr === 0 && dc === 0)) continue;
      const t = r + dr, e = c + dc;
      if (t < 0 || e < 0 || t >= this.rows || e >= this.cols) continue;
      const k = this.task[t][e];
      if (k < 0 || k > 4) continue;
      let tri = 0, unk = 0;
      for (const [nr, nc] of [[t,e-1],[t,e+1],[t-1,e],[t+1,e]]) {
        if (nr < 0 || nc < 0 || nr >= this.rows || nc >= this.cols) continue;
        if (this.task[nr][nc] !== -1) continue;
        const b = board[nr][nc];
        if (b === UNK) unk++; else if (b >= 1 && b <= 4) tri++;
      }
      if (tri > k || tri + unk < k) return false;
    }
    return true;
  }
  // Propagate domains to a fixpoint: drop any value that is not _consistent.
  // Returns false on a wipeout (some open cell's domain becomes empty).
  _propagate(board) {
    let changed = true;
    while (changed) {
      changed = false;
      for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) {
        if (this.task[r][c] !== -1) continue;
        let d = this._dom[r][c];
        if (d && (d & (d - 1)) === 0) continue; // already singleton
        let nd = 0;
        for (let v = 0; v <= 4; v++) if (d & (1 << v)) { if (this._consistent(board, r, c, v)) nd |= (1 << v); }
        if (nd === 0) return false;
        if (nd !== d) { this._dom[r][c] = nd; changed = true;
          // reflect singleton into board for subsequent checks
          if ((nd & (nd - 1)) === 0) { let x=0,m=nd; while(m>1){m>>=1;x++;} board[r][c]=x; }
        }
      }
    }
    return true;
  }
  // Propagation-only result (no search): the determined board (UNK where open).
  _deduceOnly() {
    this._initDomains();
    const board = this._boardFromDomains();
    const ok = this._propagate(board);
    return { ok, cells: this._boardFromDomains() };
  }

  solve() {
    this._startedAt = Date.now();
    this._initDomains();
    const board = this._boardFromDomains();
    if (!this._propagate(board)) return { solved: false, cells: null, error: 'no solution' };
    const partial = () => ({ solved: false, cells: this._boardFromDomains(), partial: true, error: 'time limit exceeded' });
    const search = () => {
      if (this.maxMs > 0 && timeUp(this.maxMs, this._startedAt)) throw 'BUDGET';
      // pick most-constrained open cell (smallest domain > 1)
      let best = null, bestN = 99;
      for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) {
        if (this.task[r][c] !== -1) continue;
        const d = this._dom[r][c], n = popcount(d);
        if (n > 1 && n < bestN) { bestN = n; best = [r, c]; }
      }
      if (!best) { const b = this._boardFromDomains(); return this._isValid(b) ? b : null; }
      const [r, c] = best; const dom = this._dom[r][c];
      const snapshot = this._dom.map(row => row.slice());
      for (let v = 0; v <= 4; v++) if (dom & (1 << v)) {
        this._dom = snapshot.map(row => row.slice());
        this._dom[r][c] = (1 << v);
        const b = this._boardFromDomains();
        if (this._propagate(b)) { const sol = search(); if (sol) return sol; }
      }
      this._dom = snapshot;
      return null;
    };
    try {
      const sol = search();
      if (sol) return { solved: true, cells: sol };
      return { solved: false, cells: null, error: 'no solution' };
    } catch (e) {
      if (e === 'BUDGET') return partial();
      throw e;
    }
  }
```
Add a top-level `popcount`:
```js
function popcount(x) { let n = 0; while (x) { x &= x - 1; n++; } return n; }
```
(Place `popcount` next to `UNK` at module scope.)

- [ ] **Step 4: Run → PASS** the solve tests, ESPECIALLY the brute-force soundness test. If "matches brute-force" fails (solver says UNSAT but brute-force finds solutions, or output invalid), the propagation pruned a valid value — re-check `_consistent` only flags CERTAIN impossibilities (neighbourhood-fully-decided guard) and the leaf uses `_isValid`. Do NOT weaken the test.
Run: `node --test tests/shakashaka.test.js`

- [ ] **Step 5: Measure on the real 25×25** (after Task 6 adds the fixture, re-run; for now use a generated/medium board) and `npm run lint`. Note solve time + solved/partial.

- [ ] **Step 6: Commit**
```bash
jj commit -m "feat(shakashaka): CSP solver — domain propagation + MRV backtracking + partial-on-timeout

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Solver bundle + worker dispatch + handler

**Files:** Modify `scripts/build-solver-bundle.js`, `solver.worker.js`, `handler.js`, `globals.d.ts`.

- [ ] **Step 1:** In `scripts/build-solver-bundle.js`, add `'shakashaka.js'` to the `FILES` array (after `'shingoki.js'`, before `'diff.js'`) and `'ShakashakaSolver'` to the `EXPORTS` array (after `'ShingokiSolver'`).

- [ ] **Step 2:** In `globals.d.ts`, add `declare const ShakashakaSolver: any;` near the other solver decls (e.g. after `ShingokiSolver`).

- [ ] **Step 3:** In `solver.worker.js`: add `ShakashakaSolver` to the `/* global ... */` comment list (line ~5), and add the dispatch branch (after the shingoki branch):
```js
    } else if (type === 'shakashaka' && extraData) {
      const s = new ShakashakaSolver({ task: extraData.task, maxMs: 30000 });
      result = s.solve();
    }
```

- [ ] **Step 4:** In `handler.js`, add the handler (mirroring `shingokiHandler`, near it) and register it:
```js
const shakashakaHandler = {
  name: 'puzzles-mobile-shakashaka',
  priority: 30,
  matches() { return isPuzzlesMobilePage() && window.location.pathname.includes('/shakashaka/'); },
  async detect() {
    const data = await callMainWorld('readShakashakaData', []);
    if (!data || !data.task) return { found: false };
    return { found: true, type: 'shakashaka', rows: data.rows, cols: data.cols, task: data.task };
  },
  async readState() {
    return await callMainWorld('readShakashakaState', []);
  },
  async applySolution(solution) {
    const ok = await callMainWorld('applyShakashakaState', [solution]);
    return ok ? { success: true } : { success: false, error: 'apply failed' };
  },
};
registerHandler(shakashakaHandler);
```
(Match the EXACT shape of the existing handlers — check `shingokiHandler` for the precise `detect`/`readState`/`applySolution` signatures and adapt; the above is the intended contract.)

- [ ] **Step 5:** `npm run build` (solver.js + content.js rebuild) — must succeed (bundler guards pass). `npm run typecheck` — clean.

- [ ] **Step 6: Commit**
```bash
jj commit -m "feat(shakashaka): wire solver bundle + worker dispatch + handler

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: MAIN-world read/apply/dump + allowlist

**Files:** Modify `main-world.js`, `background.js`, `globals.d.ts`.

- [ ] **Step 1:** In `main-world.js`, add three SELF-CONTAINED functions (serialized via `fn.toString()` — no outer-scope or sibling refs; only `window.Game`/`document`). Model on `readShingokiData`/`applyShingokiState`.

```js
function readShakashakaData() {
  try {
    var G = window.Game;
    var task = G.task;
    if (!task || !task.length) return null;
    return { task: task, rows: task.length, cols: task[0].length };
  } catch (e) { return null; }
}

function readShakashakaState() {
  try {
    var s = window.Game.currentState.cellStatus;
    return { cellStatus: s.map(function (row) { return row.slice(); }) };
  } catch (e) { return null; }
}

function applyShakashakaState(solution) {
  try {
    var G = window.Game;
    if (G.saveState) G.saveState(true);
    var cells = solution.cells; // board-state grid: -1 black, 0 white, 1..4 triangle
    for (var r = 0; r < cells.length; r++) for (var c = 0; c < cells[r].length; c++) {
      if (G.task[r][c] !== -1) continue;            // skip black cells
      var v = cells[r][c];
      G.currentState.cellStatus[r][c] = (v >= 1 && v <= 4) ? v : 5; // triangle or explicit white
    }
    // canonical render ladder
    if (G.drawCurrentState) G.drawCurrentState();
    else if (G.render) G.render();
    else if (G.redraw) G.redraw();
    else if (G.redrawGrid) G.redrawGrid();
    else if (G.draw) G.draw();
    else { var saved = G.getSaved && G.getSaved(); if (saved && G.loadGame) G.loadGame(saved); }
    return true;
  } catch (e) { return false; }
}
```
(Confirm `applySolution` passes `{cells}` — match the worker result shape `solutionFromResult` produces in Task 5; keep the shape consistent. If the widget passes the raw solver result, `solution.cells` is correct.)

- [ ] **Step 2:** In `main-world.js` `dumpPuzzleForBench`, add an INLINE `/shakashaka/` branch (cannot call `readShakashakaData`):
```js
    if (path.indexOf('/shakashaka/') !== -1) {
      var t = window.Game.task;
      return { type: 'shakashaka', rows: t.length, cols: t[0].length, task: t, path: path };
    }
```

- [ ] **Step 3:** In `background.js`, add `'readShakashakaData'`, `'readShakashakaState'`, `'applyShakashakaState'` to `EXEC_MAIN_ALLOWLIST`.

- [ ] **Step 4:** In `globals.d.ts`, add the same three names to the `MainWorldFn` union.

- [ ] **Step 5:** `npm run build` + `npm run typecheck` — clean (the allowlist/MainWorldFn must match).

- [ ] **Step 6: Commit**
```bash
jj commit -m "feat(shakashaka): main-world read/apply/dump + exec allowlist + globals

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Widget registry module + preview

**Files:** Create `src/widget/puzzles/shakashaka.js`; Modify `src/widget/puzzles/index.js`, `scripts/build-content-bundle.js`.

Model the module on `src/widget/puzzles/shingoki.js` AND a cell-based puzzle (e.g. `mosaic.js`/`nurikabe.js`) for the cell-grid hooks. Shakashaka's solution is a per-cell grid (not edges), so `solutionFromResult` returns `{cells}`, and the preview draws cells.

- [ ] **Step 1:** Create `src/widget/puzzles/shakashaka.js` exporting a `shakashaka` object with these hooks (match the existing modules' exact signatures — read `shingoki.js` and `mosaic.js` first):
  - `type: 'shakashaka'`, `label: 'Shakashaka'`, `url`, `solutionKeyPrefix`.
  - `cacheKey(data)`: FNV-1a over the task grid (use the shared `hashFNV1a`). Mirror shingoki's cacheKey but over `data.task` flattened.
  - `canvasDims(pd, {grid})`: `{ rows, cols, marginCells: 0 }`.
  - `staticSig(data)`: a signature over the task (black cells + numbers) so the static layer rebuilds on change.
  - `drawStaticLayer(ctx, {rows, cols, cellSize, pd})`: draw black cells (filled), numbers (text), and grid. (White/triangles are the DYNAMIC layer / preview.)
  - `solveExtraData(data)`: `{ task: data.task }`.
  - `solutionFromResult(result)`: `result && result.cells ? { cells: result.cells } : null`.
  - `solutionToCacheJson`/`solutionFromCacheJson`: `{cells}` round-trip (deep clone).
  - `drawPreview` / the preview hook: draw each open cell — white (light) or a triangle in orientation 1–4 (a filled half-cell triangle). **The exact half-cell geometry per orientation must be pinned against the page CSS during live-verify** (Task 6); start from this mapping derived from `hasNonRect` and correct on the live page: T1 = right-angle filling toward up-left, T2 = up-right, T3 = down-right, T4 = down-left (verify!).
  - `hintDispatch(ctx)`: deductive — run the solver's `_deduceOnly()` from the CURRENT board (read via `readShakashakaState`, mapped to board-state), return the newly-forced cells as a batch (cap via the Loop scaling rule); fall back to the cached solution diff when logic is exhausted. Returns `{success, hint?}`.
  - `loopDoneCheck(ctx)`: true when the board matches the solution.
  - `applyHint(hint, {callMainWorld})`: call `applyShakashakaState` with the hint cells.
  - `partialResultArm(result, {...})`: mirror shingoki's — "Partial: N cells deduced … finish manually"; does NOT recordSolveSuccess.

  End with the CommonJS guard `if (typeof module !== 'undefined' && module.exports) module.exports = shakashaka;`.

  NOTE: this is the largest task; if the hint/preview specifics are unclear, implement Detect+Solve+preview+apply first (get a working solve end-to-end), then Hint/Loop. Keep each hook's signature identical to the reference modules.

- [ ] **Step 2:** In `src/widget/puzzles/index.js`, register it: add `if (typeof shakashaka !== 'undefined') PUZZLES[shakashaka.type] = shakashaka;` (alongside the others).

- [ ] **Step 3:** In `scripts/build-content-bundle.js`, add `'puzzles/shakashaka.js'` to `WIDGET_FILES` — BEFORE `'puzzles/index.js'` (e.g. right after `'puzzles/shingoki.js'`).

- [ ] **Step 4:** `npm run build` — content.js bundles cleanly (the bundler concatenates the new file; index.js registers it). `npm run lint` + `npm run typecheck` clean.

- [ ] **Step 5: Commit**
```bash
jj commit -m "feat(shakashaka): widget registry module (detect/solve/hint/loop/preview) + registration

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Fixture, bench, build, docs, live-verify

**Files:** Modify `tests/fixtures/real-puzzles.js`, `AGENTS.md`; add `tests/bench-shakashaka.js`; build.

- [ ] **Step 1:** Add the captured 25×25 to `tests/fixtures/real-puzzles.js` (task grid verbatim from recon, in the "Appendix: captured 25×25 task" below):
```js
  shakashaka_25x25: {
    type: 'shakashaka', rows: 25, cols: 25,
    task: [ /* the 25x25 grid from the Appendix below — paste verbatim */ ],
  },
```

- [ ] **Step 2:** Add `tests/bench-shakashaka.js` (mirror `tests/bench-shingoki.js`): solve the 25×25 fixture, print solved/partial + wall-time + determined-cell reach. Add a bounded test in `tests/shakashaka.test.js` asserting the 25×25 returns `solved` OR a sound partial (never throws; output—if solved—passes `_isValid`).

- [ ] **Step 3:** Run `node tests/bench-shakashaka.js` — record solve time + solved/partial. Run `npm test` — all green.

- [ ] **Step 4:** Update `AGENTS.md`: add `shakashaka` to the puzzle list (intro line) and a per-puzzle note (encoding + CSP-with-ported-oracle solver + the white=5 / triangle-geometry empirical notes).

- [ ] **Step 5:** `npm run build && npm test && npm run lint && npm run typecheck` — all green. Confirm `manifest.json` already matches `puzzles-mobile.com/*` (no change).

- [ ] **Step 6: Commit**, then **LIVE-VERIFY** (user reloads `dist/`): on the `/shakashaka/` page — Detect appears; Solve→Confirm fills triangles+whites correctly (this confirms the triangle geometry AND white=5-vs-0); Hint/Loop work. Fix the two empirical items (triangle orientation mapping, white encoding) based on what the live board shows, re-build, re-commit.
```bash
jj commit -m "feat(shakashaka): 25x25 fixture + bench + docs + build

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final review

Dispatch a reviewer over the whole change set: (1) the ported `hasNonRect`/`taskMarkedCount` match the page source (Appendix); (2) the brute-force soundness test passes (solver never spurious-UNSAT, output always valid, forced cells hold in all solutions); (3) all wiring touch-points present (checklist table); (4) main-world fns self-contained; (5) allowlist/MainWorldFn in sync; (6) build/lint/typecheck/tests green; (7) `dist/` rebuilt. Then **superpowers:finishing-a-development-branch** + live-verify on the page.

## Appendix: verbatim page source (the porting reference — DO NOT paraphrase)

```js
// taskMarkedCount(t,e):
function(t,e){var s=0;return e&&1<=this.currentState.cellStatus[t][e-1]&&this.currentState.cellStatus[t][e-1]<=4&&s++,e<p.puzzleWidth-1&&1<=this.currentState.cellStatus[t][e+1]&&this.currentState.cellStatus[t][e+1]<=4&&s++,t&&1<=this.currentState.cellStatus[t-1][e]&&this.currentState.cellStatus[t-1][e]<=4&&s++,t<p.puzzleHeight-1&&1<=this.currentState.cellStatus[t+1][e]&&this.currentState.cellStatus[t+1][e]<=4&&s++,s}

// getBoardCellSt(t,e): -1 if task!=-1; else (cellStatus==5 ? 0 : cellStatus)
function(t,e){return-1!=this.task[t][e]?-1:5==this.currentState.cellStatus[t][e]?0:this.currentState.cellStatus[t][e]}

// hasNonRect(): (p.puzzleHeight rows, p.puzzleWidth cols)
function(){for(var t=0;t<p.puzzleHeight;t++)for(var e=0;e<p.puzzleWidth;e++)if(-1==this.task[t][e]){var s,i=this.getBoardCellSt(t,e);if(!i){if(t&&e){var r=this.getBoardCellSt(t-1,e),l=this.getBoardCellSt(t,e-1),o=this.getBoardCellSt(t-1,e-1);if(!r&&!l&&o&&1!=o)return[t,e]}if(t&&e<p.puzzleWidth-1){r=this.getBoardCellSt(t-1,e),l=this.getBoardCellSt(t,e+1),o=this.getBoardCellSt(t-1,e+1);if(!r&&!l&&o&&2!=o)return[t,e]}if(t<p.puzzleHeight-1&&e<p.puzzleWidth-1){r=this.getBoardCellSt(t+1,e),l=this.getBoardCellSt(t,e+1),o=this.getBoardCellSt(t+1,e+1);if(!r&&!l&&o&&3!=o)return[t,e]}if(t<p.puzzleHeight-1&&e){r=this.getBoardCellSt(t+1,e),l=this.getBoardCellSt(t,e-1),o=this.getBoardCellSt(t+1,e-1);if(!r&&!l&&o&&4!=o)return[t,e]}}if(1==i){if(!(e<p.puzzleWidth-1))return[t,e];if(s=this.getBoardCellSt(t,e+1)){if(2!=s)return[t,e]}else{if(!t)return[t,e];if(this.getBoardCellSt(t-1,e+1)!=i)return[t,e]}if(!(t<p.puzzleHeight-1))return[t,e];if(s=this.getBoardCellSt(t+1,e)){if(4!=s)return[t,e]}else{if(!e)return[t,e];if(this.getBoardCellSt(t+1,e-1)!=i)return[t,e]}}if(2==i){if(!e)return[t,e];if(s=this.getBoardCellSt(t,e-1)){if(1!=s)return[t,e]}else{if(!t)return[t,e];if(this.getBoardCellSt(t-1,e-1)!=i)return[t,e]}if(!(t<p.puzzleHeight-1))return[t,e];if(s=this.getBoardCellSt(t+1,e)){if(3!=s)return[t,e]}else{if(!(e<p.puzzleWidth-1))return[t,e];if(this.getBoardCellSt(t+1,e+1)!=i)return[t,e]}}if(3==i){if(!e)return[t,e];if(s=this.getBoardCellSt(t,e-1)){if(4!=s)return[t,e]}else{if(!(t<p.puzzleHeight-1))return[t,e];if(this.getBoardCellSt(t+1,e-1)!=i)return[t,e]}if(!t)return[t,e];if(s=this.getBoardCellSt(t-1,e)){if(2!=s)return[t,e]}else{if(!(e<p.puzzleWidth-1))return[t,e];if(this.getBoardCellSt(t-1,e+1)!=i)return[t,e]}}if(4==i){if(!(e<p.puzzleWidth-1))return[t,e];if(s=this.getBoardCellSt(t,e+1)){if(3!=s)return[t,e]}else{if(!(t<p.puzzleHeight-1))return[t,e];if(this.getBoardCellSt(t+1,e+1)!=i)return[t,e]}if(!t)return[t,e];if(s=this.getBoardCellSt(t-1,e)){if(1!=s)return[t,e]}else{if(!e)return[t,e];if(this.getBoardCellSt(t-1,e-1)!=i)return[t,e]}}}return!1}
```

## Appendix: captured 25×25 task (verbatim from recon — for the fixture)

```js
[
  [-1,-1,-1,-1,-1,-1,-1,-2,-1,-1,-2,-1,-1,-1,-2,-1,-1,-1,-2,-1,-2,-1,-1,-2,-1],
  [-1,-1,-1,-1,-2,-1,-1,-1,-1,-1,-1,-1,-2,-1,-1,-1,-1,-1,-2,-1,-1,-1,-1,-1,-1],
  [-1,-1,-1,1,-1,-1,-1,-2,-1,-1,-1,-1,-1,-1,-1,-1,-1,1,-1,-1,-1,-1,4,-1,-1],
  [-1,-1,-1,-2,-1,-1,-1,-2,-1,-1,-1,-2,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-2,-1],
  [-2,1,-2,-2,-1,-1,-1,0,-1,1,-1,-1,2,-1,-1,-1,-1,-1,4,-1,-1,-1,-1,-1,-1],
  [-1,-1,-1,-2,-1,-1,-1,-2,-2,-1,-1,-1,-1,2,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [-1,-1,-1,-1,-2,1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,1,-1,-1,-1,-1,-1],
  [-1,-1,4,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-2,-1,-1,-1,-2,-1,-2,-1,-1,-1],
  [-1,-1,-1,-1,-1,-1,-2,-1,-1,-1,-2,-1,-1,-1,-1,-1,-2,-1,-1,-1,-2,-1,-1,-2,-1],
  [-1,-1,-1,-1,-1,-1,-1,-1,-1,-2,-1,-1,-1,-1,-1,-2,-1,-1,-1,-1,-2,-1,-1,-2,-1],
  [2,-1,-1,-1,-1,-1,-1,-1,-2,-1,-2,-1,-1,-1,-1,-1,-1,-1,-1,-2,-1,-1,2,-1,-2],
  [-1,-1,-1,4,-1,-1,-1,-1,-1,-1,-1,-2,-1,-1,4,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [-1,-1,-2,-1,-1,-1,-1,4,-1,-1,-1,-1,-1,-1,-1,-2,-1,-1,-1,-1,-1,4,-1,-1,-2],
  [-1,-1,-1,-1,-1,3,-1,-1,-1,-1,-1,-1,2,-1,-1,-1,4,-1,-1,-1,-1,-1,-2,-1,-1],
  [3,-1,-1,4,-1,-1,-1,-1,-1,-1,-1,-1,-1,-2,-1,-1,-1,-2,-1,-1,-1,-1,-1,-1,-2],
  [-1,-1,-2,-1,-1,-1,-1,4,-1,-1,-1,2,-1,-1,4,-1,-1,-1,4,-1,-1,-2,-1,-1,-1],
  [-1,-1,-1,-1,-1,-1,-1,-1,-2,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-2,-1,-1,-1,-2],
  [2,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-2],
  [-1,-1,4,-1,-1,-1,-1,-1,-1,-1,2,-1,-1,-1,-1,-1,3,-1,-1,-1,-1,-1,2,-2,-1],
  [-1,-1,-1,-1,-1,-1,-1,-1,-2,-1,-1,-1,-2,-1,-1,-1,-1,-2,-1,-1,-1,-1,-1,-1,-1],
  [2,-1,-1,-1,-1,-1,-1,-1,-2,-1,-1,-1,-1,2,-1,-1,-1,-1,-1,-1,-1,4,-1,-1,-1],
  [-1,-1,-1,-1,-1,3,-1,-1,-1,-1,-1,-1,2,-1,-1,-2,-1,-1,-1,-2,-1,-1,-1,1,-1],
  [-1,-1,-2,-1,3,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,2,-1,-1,-1,-1,-1,-1,-1,0],
  [-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],
  [1,-1,-1,-2,-1,-1,3,-1,-1,2,-1,-1,3,-1,-1,3,-1,-1,-1,-1,1,-1,-1,-1,-1]
]
```
