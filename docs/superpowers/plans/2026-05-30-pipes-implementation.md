# Pipes puzzle support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full support (Solve + Hint + Loop) for the Pipes (Net) rotation puzzle on puzzles-mobile.com, any board size, including the wrap (toroidal) variant.

**Architecture:** New `PipesSolver` (arc-consistency propagation over edges + most-constrained backtracking + a global connectivity pass; wrap-aware; mapping-agnostic internal N/E/S/W convention). Wired through the standard 16-puzzle registration surface (worker dispatch, bundler, solvers/index, main-world read/apply, allowlist, globals.d.ts, handler.js, widget module). Pipes is a *rotation* puzzle: `Game.task[r][c]` is a 4-bit arm mask; `Game.currentState.cellStatus[r][c]` is a rotation count. The solver returns solved masks; the widget converts each to a rotation count for the page.

**Tech Stack:** Node.js (`node:test`), CommonJS, two hand-rolled concat bundlers, Chrome MV3. Version control: **`jj`, never `git`**. Every commit message ends with a blank line then:
`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

**Source spec:** `docs/superpowers/specs/2026-05-30-pipes-design.md`

**Recon facts (captured live):**
- `Game.task` 4×4 sample: `[[8,3,2,6],[8,7,1,10],[10,13,13,11],[6,3,1,8]]` — each int is a 4-bit mask; unique solution confirmed; solving is mapping-agnostic.
- `Game.currentState.cellStatus` = rotation counts (all 0 fresh).
- `Game.puzzleWidth`/`puzzleHeight` = dims. Path `/pipes/<mode>/<WxH>`.

**Convention used throughout this plan (solver-internal):** `N=1, E=2, S=4, W=8`. `rotateCW(mask, k)` rotates arms clockwise k quarter-turns. Under this labeling, one CW quarter-turn maps N→E→S→W→N, i.e. each set bit `b` moves to `((b << 1) | (b >> 3)) & 0xF`. The solver never needs the *page's* labels — only the apply layer does (Task 9, gated on the live probe).

**Pre-flight (do once before Task 1):** confirm the repo is clean and tests pass: `npm test` → expect `547 pass, 0 fail`.

---

## Task 1: `PipesSolver` core — candidates, rotation, edge masks (no search yet)

**Files:**
- Create: `src/solvers/pipes.js`
- Create: `tests/pipes.test.js`

- [ ] **Step 1: Write failing tests for the rotation + candidate primitives**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PipesSolver } = require('../solver.js');

// N=1,E=2,S=4,W=8. CW quarter turn: N->E->S->W->N.
test('PipesSolver.rotateCW moves each arm one quarter clockwise', () => {
  assert.equal(PipesSolver.rotateCW(1, 1), 2);  // N -> E
  assert.equal(PipesSolver.rotateCW(2, 1), 4);  // E -> S
  assert.equal(PipesSolver.rotateCW(8, 1), 1);  // W -> N
  assert.equal(PipesSolver.rotateCW(1, 4), 1);  // full turn = identity
  assert.equal(PipesSolver.rotateCW(0b0101, 1), 0b1010); // N|S -> E|W
});

test('PipesSolver.candidates dedupes by rotational symmetry', () => {
  // straight N|S (5) has 2 distinct rotations; cross (15) has 1; elbow N|E (3) has 4.
  assert.equal(new Set(PipesSolver.candidates(5)).size, 2);
  assert.equal(new Set(PipesSolver.candidates(15)).size, 1);
  assert.equal(new Set(PipesSolver.candidates(3)).size, 4);
  assert.equal(new Set(PipesSolver.candidates(1)).size, 4); // endpoint
});
```

- [ ] **Step 2: Run it, confirm failure**

Run: `node --test tests/pipes.test.js`
Expected: FAIL — `Cannot find module '../solver.js'` exports `PipesSolver` (undefined) / or `solver.js` shim doesn't export it yet. (It WILL fail until Task 7 wires the bundle + index; that's expected — proceed, the unit tests in Task 2 use the direct path. To make THIS file pass now, temporarily require `'../src/solvers/pipes.js'` — but the plan standardizes on `../solver.js`, which Task 7 makes resolve. To avoid a chicken-and-egg, this task's test requires the direct module path:)

Change the require line to: `const { PipesSolver } = require('../src/solvers/pipes.js');`
Re-run: FAIL with `Cannot find module '../src/solvers/pipes.js'`.

- [ ] **Step 3: Create `src/solvers/pipes.js` with the primitives**

```js
'use strict';

// Pipes (Net) rotation-puzzle solver. task[r][c] is a 4-bit arm mask in the
// page's given orientation; solving picks a rotation per cell so every arm meets
// a neighbour's arm, nothing points off-board (unless wrap), and all armed cells
// form one connected network. Internal convention: N=1, E=2, S=4, W=8. The
// solver is mapping-agnostic — it only matches "my arm on side X meets the
// neighbour's arm on the opposite side" — so it need not know the page's labels.
// See docs/superpowers/specs/2026-05-30-pipes-design.md.

const N = 1, E = 2, S = 4, W = 8;

class PipesSolver {
  // One clockwise quarter-turn moves each set bit N->E->S->W->N.
  static rotateCW(mask, k) {
    let m = mask & 0xF;
    const turns = ((k % 4) + 4) % 4;
    for (let t = 0; t < turns; t++) {
      m = ((m << 1) | (m >> 3)) & 0xF;
    }
    return m;
  }

  // The distinct rotation masks of a piece, in rotation order [k=0,1,2,3] but
  // de-duplicated while preserving the smallest k for each distinct mask.
  static candidates(mask) {
    const seen = new Set();
    const out = [];
    for (let k = 0; k < 4; k++) {
      const m = PipesSolver.rotateCW(mask, k);
      if (!seen.has(m)) { seen.add(m); out.push(m); }
    }
    return out;
  }

  constructor({ rows, cols, task, wrap = false, maxMs = 0 }) {
    this.rows = rows;
    this.cols = cols;
    this.task = task;
    this.wrap = !!wrap;
    this.maxMs = maxMs;
    this._startedAt = 0;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PipesSolver };
}
```

- [ ] **Step 4: Run, confirm pass**

Run: `node --test tests/pipes.test.js`
Expected: 2 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(pipes): PipesSolver rotation + candidate primitives"
```

---

## Task 2: `PipesSolver.solve` — propagation + backtracking + connectivity

**Files:**
- Modify: `src/solvers/pipes.js`
- Modify: `tests/pipes.test.js`

- [ ] **Step 1: Add failing tests (the captured 4×4 + a forced trivial board + wrap)**

Append to `tests/pipes.test.js` (using the direct module path require already at top):

```js
function edgesConsistent(grid, rows, cols, wrap) {
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const m = grid[r][c];
    const up = r > 0 ? grid[r-1][c] : (wrap ? grid[rows-1][c] : null);
    const left = c > 0 ? grid[r][c-1] : (wrap ? grid[r][cols-1] : null);
    const hasN = !!(m & 1), hasW = !!(m & 8);
    if (up === null) { if (hasN) return false; } else if (hasN !== !!(up & 4)) return false;
    if (left === null) { if (hasW) return false; } else if (hasW !== !!(left & 2)) return false;
  }
  return true;
}
function connected(grid, rows, cols, wrap) {
  const armed = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (grid[r][c]) armed.push(r*cols+c);
  if (armed.length === 0) return true;
  const seen = new Set([armed[0]]); const st = [armed[0]];
  while (st.length) {
    const u = st.pop(), r = (u/cols)|0, c = u%cols, m = grid[r][c];
    const nb = [];
    if (m & 1) nb.push([(r-1+rows)%rows, c, r>0||wrap]);
    if (m & 4) nb.push([(r+1)%rows, c, r<rows-1||wrap]);
    if (m & 8) nb.push([r, (c-1+cols)%cols, c>0||wrap]);
    if (m & 2) nb.push([r, (c+1)%cols, c<cols-1||wrap]);
    for (const [nr, nc, ok] of nb) { if (!ok) continue; const v = nr*cols+nc; if (!seen.has(v)) { seen.add(v); st.push(v); } }
  }
  return seen.size === armed.length;
}

test('PipesSolver solves the captured 4x4 (non-wrap, unique)', () => {
  const task = [[8,3,2,6],[8,7,1,10],[10,13,13,11],[6,3,1,8]];
  const res = new PipesSolver({ rows: 4, cols: 4, task, wrap: false }).solve();
  assert.equal(res.solved, true);
  assert.ok(edgesConsistent(res.grid, 4, 4, false), 'all edges agree, no off-board arms');
  assert.ok(connected(res.grid, 4, 4, false), 'single connected network');
  // each solved cell is a rotation of its task cell
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    assert.ok(PipesSolver.candidates(task[r][c]).includes(res.grid[r][c]));
  }
});

test('PipesSolver: 1x2 two endpoints must point at each other', () => {
  // two single-arm pieces side by side: only solution is left=E(2), right=W(8).
  const res = new PipesSolver({ rows: 1, cols: 2, task: [[1, 1]], wrap: false }).solve();
  assert.equal(res.solved, true);
  assert.deepEqual(res.grid, [[2, 8]]);
});

test('PipesSolver: unsolvable returns solved:false', () => {
  // three endpoints in a row: middle cannot connect both sides with 1 arm.
  const res = new PipesSolver({ rows: 1, cols: 3, task: [[1,1,1]], wrap: false }).solve();
  assert.equal(res.solved, false);
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `node --test tests/pipes.test.js`
Expected: the 3 new tests FAIL (`solve is not a function`).

- [ ] **Step 3: Implement `solve` + helpers in `src/solvers/pipes.js`**

Add `const { timeUp } = require('./shared.js');` at the top (after `'use strict';`). Add these methods to the class and a connectivity helper. Full implementation:

```js
  // neighbour index on a side, honouring wrap; returns -1 if off-board (non-wrap).
  _nb(r, c, side) {
    const { rows, cols, wrap } = this;
    if (side === N) { const nr = r - 1; if (nr < 0) return wrap ? (rows-1)*cols + c : -1; return nr*cols + c; }
    if (side === S) { const nr = r + 1; if (nr >= rows) return wrap ? c : -1; return nr*cols + c; }
    if (side === W) { const nc = c - 1; if (nc < 0) return wrap ? r*cols + (cols-1) : -1; return r*cols + nc; }
    /* E */          { const nc = c + 1; if (nc >= cols) return wrap ? r*cols : -1; return r*cols + nc; }
  }

  solve() {
    this._startedAt = Date.now();
    const { rows, cols } = this;
    const total = rows * cols;
    // cand[i] = array of still-possible masks for cell i.
    const cand = new Array(total);
    for (let i = 0; i < total; i++) cand[i] = PipesSolver.candidates(this.task[(i/cols)|0][i%cols]);

    // The opposite side bit (the arm a neighbour must present to match side `s`).
    const opp = { [N]: S, [S]: N, [E]: W, [W]: E };
    const sides = [N, E, S, W];

    // Arc-consistency. Returns false on contradiction.
    const propagate = (queue) => {
      while (queue.length) {
        const i = queue.pop();
        const r = (i/cols)|0, c = i%cols;
        let masks = cand[i];
        // Border rule (non-wrap): drop masks with an arm pointing off-board.
        if (!this.wrap) {
          const filtered = masks.filter(m =>
            !((m & N) && r === 0) && !((m & S) && r === rows-1) &&
            !((m & W) && c === 0) && !((m & E) && c === cols-1));
          if (filtered.length !== masks.length) { cand[i] = masks = filtered; }
        }
        if (masks.length === 0) return false;
        // Edge agreement with each neighbour.
        for (const s of sides) {
          const j = this._nb(r, c, s);
          if (j < 0) continue;
          const iHasArm = masks.some(m => m & s);
          const iAllArm = masks.every(m => m & s);
          // The neighbour must (if i always has the arm) present opp; (if i never
          // has it) not present opp. If i is ambiguous, no constraint yet.
          let want;
          if (iAllArm) want = true; else if (!iHasArm) want = false; else continue;
          const before = cand[j].length;
          cand[j] = cand[j].filter(m => (!!(m & opp[s])) === want);
          if (cand[j].length === 0) return false;
          if (cand[j].length !== before) queue.push(j);
        }
      }
      return true;
    };

    // initial propagation over all cells
    if (!propagate(Array.from({ length: total }, (_, i) => i))) {
      return { solved: false, grid: null, error: 'contradiction on initial propagation' };
    }

    // Backtracking search with per-cell trail (candidate-set snapshots).
    const assign = new Array(total).fill(-1);
    const solveFrom = () => {
      if (this.maxMs > 0 && timeUp(this.maxMs, this._startedAt)) return null;
      // pick most-constrained unassigned cell (fewest candidates > 1)
      let best = -1, bestLen = Infinity;
      for (let i = 0; i < total; i++) {
        if (assign[i] !== -1) continue;
        const len = cand[i].length;
        if (len === 1) { assign[i] = cand[i][0]; continue; }
        if (len < bestLen) { bestLen = len; best = i; }
      }
      if (best === -1) {
        // all assigned (or forced) — finalize singletons then verify connectivity
        for (let i = 0; i < total; i++) if (assign[i] === -1) assign[i] = cand[i][0];
        if (!this._connectedAssignment(assign)) { return null; }
        const grid = [];
        for (let r = 0; r < rows; r++) { const row = []; for (let c = 0; c < cols; c++) row.push(assign[r*cols+c]); grid.push(row); }
        return grid;
      }
      for (const m of cand[best]) {
        const snapshot = cand.map(a => a.slice());
        const savedAssign = assign.slice();
        cand[best] = [m];
        if (propagate([best])) {
          const got = solveFrom();
          if (got) return got;
        }
        for (let i = 0; i < total; i++) { cand[i] = snapshot[i]; assign[i] = savedAssign[i]; }
      }
      return null;
    };

    const grid = solveFrom();
    if (!grid) {
      return { solved: false, grid: null, error: this.maxMs > 0 && timeUp(this.maxMs, this._startedAt) ? 'time limit exceeded' : 'no solution' };
    }
    return { solved: true, grid };
  }

  // BFS over lit edges; every armed cell must be reachable from the first armed cell.
  _connectedAssignment(assign) {
    const { rows, cols } = this;
    const total = rows * cols;
    const armed = [];
    for (let i = 0; i < total; i++) if (assign[i]) armed.push(i);
    if (armed.length === 0) return true;
    const seen = new Uint8Array(total);
    seen[armed[0]] = 1;
    const st = [armed[0]];
    let cnt = 1;
    const sides = [N, E, S, W];
    const opp = { [N]: S, [S]: N, [E]: W, [W]: E };
    while (st.length) {
      const i = st.pop(), r = (i/cols)|0, c = i%cols, m = assign[i];
      for (const s of sides) {
        if (!(m & s)) continue;
        const j = this._nb(r, c, s);
        if (j < 0) continue;
        // edge is real only if the neighbour also presents the opposite arm
        if (!(assign[j] & opp[s])) continue;
        if (!seen[j]) { seen[j] = 1; cnt++; st.push(j); }
      }
    }
    return cnt === armed.length;
  }
```

- [ ] **Step 4: Run, confirm pass**

Run: `node --test tests/pipes.test.js`
Expected: 5 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(pipes): PipesSolver solve — propagation, backtracking, connectivity"
```

---

## Task 3: Fuzz test (constructive + brute-force cross-check, incl. wrap)

**Files:**
- Create: `tests/pipes-fuzz.test.js`

- [ ] **Step 1: Write the fuzz test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PipesSolver } = require('../src/solvers/pipes.js');

function rng(seed) { let s = seed >>> 0; return () => { s = (s*1664525 + 1013904223) >>> 0; return s / 0x100000000; }; }
const N=1,E=2,S=4,W=8, OPP={[N]:S,[S]:N,[E]:W,[W]:E};

// Build a random spanning tree over the grid; its edges define each cell's
// solved mask. Guaranteed connected + edge-consistent => guaranteed solvable.
function randomNetwork(rand, rows, cols, wrap) {
  const total = rows*cols;
  const mask = new Array(total).fill(0);
  const inTree = new Uint8Array(total); inTree[0] = 1;
  const frontier = [0];
  let count = 1;
  const nb = (i, s) => {
    const r=(i/cols)|0, c=i%cols;
    if (s===N){const nr=r-1; if(nr<0) return wrap?(rows-1)*cols+c:-1; return nr*cols+c;}
    if (s===S){const nr=r+1; if(nr>=rows) return wrap?c:-1; return nr*cols+c;}
    if (s===W){const nc=c-1; if(nc<0) return wrap?r*cols+cols-1:-1; return r*cols+nc;}
    {const nc=c+1; if(nc>=cols) return wrap?r*cols:-1; return r*cols+nc;}
  };
  while (count < total) {
    // pick a random in-tree cell with an out-of-tree neighbour
    const order = frontier.slice().sort(() => rand() - 0.5);
    let grew = false;
    for (const i of order) {
      const sidesShuffled = [N,E,S,W].sort(() => rand() - 0.5);
      for (const s of sidesShuffled) {
        const j = nb(i, s);
        if (j >= 0 && !inTree[j]) { mask[i]|=s; mask[j]|=OPP[s]; inTree[j]=1; count++; frontier.push(j); grew=true; break; }
      }
      if (grew) break;
    }
    if (!grew) break; // disconnected (wrap edge cases) — accept partial, still valid network of `count`
  }
  return mask;
}

function toTask(rand, solvedMask, rows, cols) {
  // apply a random rotation to each cell to scramble into the "given" task
  const task = [];
  for (let r=0;r<rows;r++){ const row=[]; for (let c=0;c<cols;c++){ const k=Math.floor(rand()*4); row.push(PipesSolver.rotateCW(solvedMask[r*cols+c], k)); } task.push(row); }
  return task;
}
function edgesConsistent(grid, rows, cols, wrap) {
  const nb=(r,c,s)=>{ if(s===N){const nr=r-1;if(nr<0)return wrap?[rows-1,c]:null;return[nr,c];}
    if(s===S){const nr=r+1;if(nr>=rows)return wrap?[0,c]:null;return[nr,c];}
    if(s===W){const nc=c-1;if(nc<0)return wrap?[r,cols-1]:null;return[r,nc];}
    {const nc=c+1;if(nc>=cols)return wrap?[r,0]:null;return[r,nc];} };
  for (let r=0;r<rows;r++) for (let c=0;c<cols;c++){ const m=grid[r][c];
    for (const s of [N,E,S,W]){ const p=nb(r,c,s); const has=!!(m&s);
      if (p===null){ if(has) return false; } else { const nm=grid[p[0]][p[1]]; if (has !== !!(nm & OPP[s])) return false; } } }
  return true;
}

function runConstructive(seed, rows, cols, wrap) {
  const rand = rng(seed);
  const solved = randomNetwork(rand, rows, cols, wrap);
  const task = toTask(rand, solved, rows, cols);
  const res = new PipesSolver({ rows, cols, task, wrap }).solve();
  assert.equal(res.solved, true, `seed=${seed} ${rows}x${cols} wrap=${wrap}: should solve. task=${JSON.stringify(task)}`);
  assert.ok(edgesConsistent(res.grid, rows, cols, wrap), `seed=${seed}: solver grid edge-consistent`);
  // every solved cell is a rotation of the task cell
  for (let r=0;r<rows;r++) for (let c=0;c<cols;c++)
    assert.ok(PipesSolver.candidates(task[r][c]).includes(res.grid[r][c]), `seed=${seed}: (${r},${c}) is a rotation of task`);
}

test('PipesSolver constructive non-wrap 4x4 (40 trials)', () => { for (let s=1;s<=40;s++) runConstructive(s, 4, 4, false); });
test('PipesSolver constructive non-wrap 6x6 (30 trials)', () => { for (let s=100;s<=129;s++) runConstructive(s, 6, 6, false); });
test('PipesSolver constructive non-wrap 4x7 (20 trials)', () => { for (let s=200;s<=219;s++) runConstructive(s, 4, 7, false); });
test('PipesSolver constructive WRAP 5x5 (30 trials)', () => { for (let s=300;s<=329;s++) runConstructive(s, 5, 5, true); });
```

- [ ] **Step 2: Run, confirm pass**

Run: `node --test tests/pipes-fuzz.test.js`
Expected: 4 pass, 0 fail. If a wrap trial fails because `randomNetwork` left a disconnected board (the `!grew` break), that means the generated task may have multiple components — the solver's single-network rule would then legitimately reject it. If this causes flakiness, tighten `runConstructive` to skip seeds where `solved` has any 0-mask cell (every cell should be armed in a spanning tree of the full grid); add `for (const m of solved) if (m === 0) return; // skip degenerate` after building `solved`. Keep assertions strong otherwise.

- [ ] **Step 3: Commit**

```bash
jj commit -m "test(pipes): constructive + wrap fuzz cross-check for PipesSolver"
```

---

## Task 4: Wire the solver into the bundle + Node index + worker dispatch

**Files:**
- Modify: `scripts/build-solver-bundle.js`
- Modify: `src/solvers/index.js`
- Modify: `solver.worker.js`
- Modify: `tests/pipes.test.js` (switch require back to `../solver.js`)

- [ ] **Step 1: Add to `scripts/build-solver-bundle.js`**

In the `FILES` array, add `'pipes.js'` (alphabetical placement, after `'nurikabe.js'` or anywhere before `'diff.js'`). In the `EXPORTS` array, add `'PipesSolver'` (before `'computePuzzleDiff'`).

- [ ] **Step 2: Add to `src/solvers/index.js`**

Add `const { PipesSolver } = require('./pipes.js');` with the other requires, and add `PipesSolver` to the `module.exports` object.

- [ ] **Step 3: Add worker dispatch in `solver.worker.js`**

Add `PipesSolver` to the `/* global ... */` comment list. Add this branch BEFORE the final `} else {` (the nonogram default). The `wrap: 'auto'` fallback runs non-wrap first, then wrap:

```js
    } else if (type === 'pipes' && extraData) {
      const mk = (wrap) => new PipesSolver({
        rows: extraData.rows, cols: extraData.cols, task: extraData.task, wrap, maxMs: extraData.maxMs || 0,
      }).solve();
      if (extraData.wrap === 'auto') {
        result = mk(false);
        if (result.solved) { result.wrap = false; }
        else { result = mk(true); result.wrap = true; }
      } else {
        result = mk(!!extraData.wrap);
        if (result && typeof result === 'object') result.wrap = !!extraData.wrap;
      }
```

- [ ] **Step 4: Point `tests/pipes.test.js` at the bundle**

Change its top require from `require('../src/solvers/pipes.js')` to `require('../solver.js')`. (Leave `tests/pipes-fuzz.test.js` on the direct path — both work; this just proves the bundle re-exports correctly.)

- [ ] **Step 5: Build + run the gate**

Run: `npm run build && node --test tests/pipes.test.js tests/pipes-fuzz.test.js && npm test`
Expected: build writes both bundles; pipes tests pass; full suite still green (now higher count). `grep -c "require('./shared.js')" dist/solver.js` → `0` (pipes.js's shared require is stripped by the bundler).

- [ ] **Step 6: Commit**

```bash
jj commit -m "feat(pipes): wire PipesSolver into bundle, index, and worker dispatch"
```

---

## Task 5: Bundle-validation test entry

**Files:**
- Modify: `tests/bundle.test.js`

- [ ] **Step 1: Add a bundle assertion**

In `tests/bundle.test.js`, in the test that checks the bundle exports every solver class, add `'PipesSolver'` to the list of names asserted to be `typeof === 'function'`. Add one solve-through-the-bundle check mirroring the existing bundled-solver tests:

```js
test('bundled PipesSolver solves the captured 4x4', () => {
  const bundled = loadBundledSolvers();
  const task = [[8,3,2,6],[8,7,1,10],[10,13,13,11],[6,3,1,8]];
  const res = new bundled.PipesSolver({ rows: 4, cols: 4, task, wrap: false }).solve();
  assert.equal(res.solved, true);
});
```

- [ ] **Step 2: Run**

Run: `node --test tests/bundle.test.js`
Expected: all pass (including the new PipesSolver checks).

- [ ] **Step 3: Commit**

```bash
jj commit -m "test(bundle): assert bundle exposes PipesSolver"
```

---

## Task 6: mask→rotation-count conversion helper (Node-testable, page-convention-parametrised)

**Files:**
- Create: `src/widget/pipes-rotation.js`
- Create: `tests/pipes-rotation.test.js`
- Modify: `scripts/build-content-bundle.js` (add to WIDGET_FILES so it's in the content bundle)

This is the conversion the widget uses at apply/hint time. It is parametrised by the page's rotation direction so the live probe (Task 9) only flips a flag, not the logic.

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { rotationCount } = require('../src/widget/pipes-rotation.js');
const { PipesSolver } = require('../src/solvers/pipes.js');

// rotationCount(taskMask, solvedMask, pageCW) = k in 0..3 such that rotating the
// task mask k page-steps yields the solved mask. pageCW=true means a page step
// is a clockwise quarter-turn (solver's rotateCW); false means counter-clockwise.
test('rotationCount finds the k that turns task into solved (CW page)', () => {
  for (const base of [1, 3, 5, 6, 7, 15]) {
    for (let k = 0; k < 4; k++) {
      const solved = PipesSolver.rotateCW(base, k);
      const got = rotationCount(base, solved, true);
      assert.equal(PipesSolver.rotateCW(base, got), solved, `base=${base} k=${k}`);
      assert.ok(got >= 0 && got < 4);
    }
  }
});

test('rotationCount honours CCW page direction', () => {
  // base N(1); solved E(2). CW that's 1 step; CCW it's 3 steps.
  assert.equal(rotationCount(1, 2, true), 1);
  assert.equal(rotationCount(1, 2, false), 3);
});

test('rotationCount returns 0 for a symmetric piece already matching', () => {
  assert.equal(rotationCount(15, 15, true), 0); // cross: any k works; smallest is 0
  assert.equal(rotationCount(5, 5, true), 0);   // straight already aligned
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `node --test tests/pipes-rotation.test.js`
Expected: FAIL — `Cannot find module '../src/widget/pipes-rotation.js'`.

- [ ] **Step 3: Create `src/widget/pipes-rotation.js`**

```js
'use strict';

// Convert a solved pipe mask back into the number of page rotation steps to
// apply to the given task mask. Parametrised by page rotation direction
// (pageCW) so the live probe only sets a flag. Returns the smallest k in 0..3
// (smallest matters for symmetric pieces, which match at multiple k).
function rotationCount(taskMask, solvedMask, pageCW) {
  // One page step rotates the mask by one quarter turn in the page's direction.
  // CW step: N->E->S->W. CCW step: N->W->S->E (== 3 CW steps).
  const stepCW = (m) => ((m << 1) | (m >> 3)) & 0xF;
  const stepCCW = (m) => ((m >> 1) | (m << 3)) & 0xF;
  const step = pageCW ? stepCW : stepCCW;
  let m = taskMask & 0xF;
  for (let k = 0; k < 4; k++) {
    if (m === (solvedMask & 0xF)) return k;
    m = step(m);
  }
  return 0; // unreachable for a valid rotation pair; 0 is a safe no-op
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { rotationCount };
}
```

- [ ] **Step 4: Run, confirm pass**

Run: `node --test tests/pipes-rotation.test.js`
Expected: 3 pass.

- [ ] **Step 5: Wire into the content bundle**

In `scripts/build-content-bundle.js`, add `'pipes-rotation.js'` to `WIDGET_FILES` (after `'shared.js'`, before the puzzle modules — it's a leaf helper). Confirm it has the `typeof module` CJS tail (it does) so the bundler's strip handles it.

- [ ] **Step 6: Build + confirm**

Run: `npm run build && node --test tests/pipes-rotation.test.js`
Expected: build ok; tests pass. `grep -c "function rotationCount" dist/content.js` → `1`.

- [ ] **Step 7: Commit**

```bash
jj commit -m "feat(pipes): mask->rotation-count conversion helper (page-direction parametrised)"
```

---

## Task 7: MAIN-world read/apply + allowlist + globals.d.ts + dump branch

**Files:**
- Modify: `main-world.js`
- Modify: `background.js`
- Modify: `globals.d.ts`

These are MAIN-world functions serialized via `fn.toString()` — **no outer-scope references; only `window.Game`, nested helpers, and literals.** Mirror the structure of the existing `readHitoriData`/`readHitoriState`/`applyHitoriState` (read `main-world.js` for their exact shape, including the save+render ladder).

- [ ] **Step 1: Add `readPipesData` to `main-world.js`**

```js
function readPipesData() {
  try {
    var g = window.Game;
    if (!g || !g.task || !g.puzzleWidth || !g.puzzleHeight) return null;
    var rows = g.puzzleHeight, cols = g.puzzleWidth;
    var task = [];
    for (var r = 0; r < rows; r++) {
      var srcRow = g.task[r] || [];
      var arr = new Array(cols);
      for (var c = 0; c < cols; c++) arr[c] = srcRow[c] | 0;
      task.push(arr);
    }
    return { rows: rows, cols: cols, task: task };
  } catch (e) {
    return null;
  }
}
```
(No wrap field here — the worker's `wrap:'auto'` fallback resolves it; Task 9's probe may later add a wrap signal read if one exists.)

- [ ] **Step 2: Add `readPipesState` to `main-world.js`**

```js
function readPipesState(rows, cols) {
  try {
    var g = window.Game;
    if (!g || !g.currentState || !g.currentState.cellStatus) return null;
    var cs = g.currentState.cellStatus;
    var grid = [];
    for (var r = 0; r < rows; r++) {
      var row = cs[r] || [];
      var arr = new Array(cols);
      for (var c = 0; c < cols; c++) arr[c] = row[c] | 0;
      grid.push(arr);
    }
    return grid;
  } catch (e) {
    return null;
  }
}
```

- [ ] **Step 3: Add `applyPipesState` to `main-world.js`**

Takes a `rows×cols` array of rotation counts (0..3). Mirrors the cell-state writers' save+render ladder.

```js
function applyPipesState(rotations) {
  try {
    var g = window.Game;
    if (!g || !g.currentState || !g.currentState.cellStatus) return false;
    if (typeof g.saveState === 'function') g.saveState(true);
    var cs = g.currentState.cellStatus;
    for (var r = 0; r < rotations.length && r < cs.length; r++) {
      var src = rotations[r] || [];
      var dst = cs[r];
      if (!Array.isArray(dst)) continue;
      for (var c = 0; c < src.length && c < dst.length; c++) {
        dst[c] = src[c] | 0;
      }
    }
    if (typeof g.drawCurrentState === 'function') { g.drawCurrentState(); }
    else if (typeof g.render === 'function') { g.render(); }
    else if (typeof g.redraw === 'function') { g.redraw(); }
    else if (typeof g.redrawGrid === 'function') { g.redrawGrid(); }
    else if (typeof g.draw === 'function') { g.draw(); }
    else if (g.getSaved && g.loadGame) { var saved = g.getSaved(); if (saved) g.loadGame(saved); }
    return true;
  } catch (e) {
    console.warn('Pipes apply failed:', e);
    return false;
  }
}
```
**NOTE (probe-gated, Task 9):** the page may store `cellStatus` as something other than a raw 0..3 count (e.g. the rotated mask itself, or a status enum). If the Task-9 probe shows that, this writer changes to write whatever the page expects. Until verified live, this raw-count writer matches the recon (cellStatus all-0 fresh, integer per cell).

- [ ] **Step 4: Add the `/pipes/` branch to `dumpPuzzleForBench`**

In `dumpPuzzleForBench` (main-world.js), add near the other path checks:

```js
    if (path.indexOf('/pipes/') !== -1) {
      if (!Array.isArray(g.task)) {
        return { error: 'pipes: g.task is not a 2D array', diagnostic: diagnostic(g), path: path };
      }
      var ptask = [];
      for (var r = 0; r < height; r++) {
        var prow = g.task[r] || [];
        var arr = [];
        for (var c = 0; c < width; c++) arr.push(prow[c] | 0);
        ptask.push(arr);
      }
      return { type: 'pipes', rows: height, cols: width, task: ptask, path: path };
    }
```

- [ ] **Step 5: Add to `background.js` allowlist**

Add `'readPipesData'`, `'readPipesState'`, `'applyPipesState'` to the `EXEC_MAIN_ALLOWLIST` Set (near the other `apply*State` entries).

- [ ] **Step 6: Add to `globals.d.ts` MainWorldFn**

Add the same three string literals to the `MainWorldFn` union (mirror how `applyNurikabeState` etc. appear). The allowlist and this union must stay in sync (CLAUDE.md contract).

- [ ] **Step 7: Build + sync check**

Run: `npm run build && npm run typecheck && npm run lint`
Expected: all clean. Manually confirm allowlist↔MainWorldFn parity: every Pipes entry appears in both.

- [ ] **Step 8: Commit**

```bash
jj commit -m "feat(pipes): MAIN-world read/apply, allowlist, globals, dump branch"
```

---

## Task 8: handler.js + widget module + registry (Solve path end-to-end)

**Files:**
- Modify: `handler.js`
- Create: `src/widget/puzzles/pipes.js`
- Modify: `src/widget/puzzles/index.js`
- Modify: `tests/puzzle-modules.test.js`

**Reference files to mirror exactly (read them first):** `handler.js`'s `hitoriHandler` + `registerHandler(hitoriHandler)`; `src/widget/puzzles/hitori.js` (the simplest full module — type/label/url/cacheKey/solveExtraData/drawPreviewCell/hintStatusNodes/hintDispatch/partialResultArm + CJS tail).

- [ ] **Step 1: Create `src/widget/puzzles/pipes.js`**

Mirror `hitori.js`'s structure. Key differences for Pipes: `solveExtraData` passes `task` + `wrap:'auto'`; `drawPreviewCell` draws a pipe glyph; hint uses rotation counts. Full module:

```js
'use strict';

const { hashFNV1a } = require('../shared.js');
const { rotationCount } = require('../pipes-rotation.js');

// Pipes (Net) rotation puzzle. detectedGrid.task = per-cell 4-bit arm masks
// (page-given orientation). solution = per-cell solved masks (solver
// convention N=1,E=2,S=4,W=8). cellStatus = rotation counts. See
// docs/superpowers/specs/2026-05-30-pipes-design.md.
//
// NOTE: pageCW (page rotation direction) is pinned by the live probe; default
// true (clockwise) until verified. solutionToRotations() is the single place
// that depends on it.

const PIPE_PAGE_CW = true; // probe-confirmed in Task 9

const pipes = {
  type: 'pipes',
  label: 'Pipes',
  url: 'https://www.puzzles-mobile.com/pipes/random/4x4',
  solutionKeyPrefix: 'pipes-solution:',

  cacheKey(data) {
    if (!data || data.type !== 'pipes') return null;
    const h = hashFNV1a((mix) => {
      mix(data.rows | 0); mix(data.cols | 0);
      const t = data.task || [];
      for (let r = 0; r < data.rows; r++) {
        const row = t[r] || [];
        for (let c = 0; c < data.cols; c++) mix((row[c] | 0) + 1);
      }
    });
    return 'pipes-solution:' + h.toString(16);
  },

  solveExtraData(data) {
    return { rows: data.rows, cols: data.cols, task: data.task, wrap: 'auto' };
  },

  // Draw the solved arms of a cell as segments from centre to each lit edge.
  // `v` is the solved mask for this cell (N=1,E=2,S=4,W=8).
  drawPreviewCell(ctx, { v, x, y, cellSize }) {
    if (!v) return;
    const cx = x + cellSize / 2, cy = y + cellSize / 2;
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = Math.max(2, Math.floor(cellSize / 8));
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (v & 1) { ctx.moveTo(cx, cy); ctx.lineTo(cx, y); }            // N
    if (v & 2) { ctx.moveTo(cx, cy); ctx.lineTo(x + cellSize, cy); } // E
    if (v & 4) { ctx.moveTo(cx, cy); ctx.lineTo(cx, y + cellSize); } // S
    if (v & 8) { ctx.moveTo(cx, cy); ctx.lineTo(x, cy); }            // W
    ctx.stroke();
    // centre node; filled dot for an endpoint (single arm)
    const arms = (v & 1 ? 1 : 0) + (v & 2 ? 1 : 0) + (v & 4 ? 1 : 0) + (v & 8 ? 1 : 0);
    ctx.fillStyle = '#2563eb';
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(2, Math.floor(cellSize / (arms === 1 ? 6 : 10))), 0, Math.PI * 2);
    ctx.fill();
  },

  // Convert the solver's solved masks to per-cell rotation counts vs the given
  // task. Returns rows×cols of 0..3. Used by hint + full apply.
  solutionToRotations(task, solution, rows, cols) {
    const out = [];
    for (let r = 0; r < rows; r++) {
      const row = new Array(cols);
      for (let c = 0; c < cols; c++) row[c] = rotationCount(task[r][c], solution[r][c], PIPE_PAGE_CW);
      out.push(row);
    }
    return out;
  },

  hintStatusNodes(h, { bold }) {
    const cells = h.extraCells || [];
    if (cells.length === 0) return ['No rotations needed'];
    if (cells.length === 1) {
      const cell = cells[0];
      return ['Rotate ', bold(`(row ${cell.row + 1}, col ${cell.col + 1})`), ' to its correct orientation'];
    }
    return ['Rotate ', bold(String(cells.length)), ' cells to their correct orientation'];
  },

  // hintDispatch returns cells whose current rotation != solved rotation, as a
  // batch capped for Loop. value carries the target rotation count.
  hintDispatch(ctx) {
    const { detectedGrid, grid, solution, rows, cols } = ctx;
    if (!solution) {
      return { success: false, error: 'No solution available yet. Click Solve first.' };
    }
    const targets = pipes.solutionToRotations(detectedGrid.task, solution, rows, cols);
    const cells = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const cur = (grid && grid[r] && grid[r][c]) | 0;
      if (cur !== targets[r][c]) cells.push({ row: r, col: c, value: targets[r][c] });
    }
    if (cells.length === 0) {
      return { success: false, error: 'Already solved. Nothing to rotate.' };
    }
    const hint = { type: 'pipes', extraCells: cells, count: cells.length };
    return { success: true, hint, grid, solution };
  },

  // Loop is done when every cell's current rotation matches its solved
  // rotation. The generic fallback ("every cell != 0") is WRONG for pipes —
  // rotation count 0 is a valid, common solved state — so pipes needs its own.
  // ctx provides the board state + the solved-rotations comparison inputs;
  // mirror how another puzzle's loopDoneCheck receives them (read widget.js's
  // loopDoneCheck dispatch to confirm the exact ctx/args shape before finalizing).
  loopDoneCheck(boardState, solution, { detectedGrid, rows, cols } = {}) {
    if (!solution || !detectedGrid) return false;
    const targets = pipes.solutionToRotations(detectedGrid.task, solution, rows, cols);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const cur = (boardState && boardState[r] && boardState[r][c]) | 0;
      if (cur !== targets[r][c]) return false;
    }
    return true;
  },

  partialResultArm(result, { applyGridPartialResult }) {
    applyGridPartialResult(result);
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = pipes;
}
```

**Implementer note:** verify the actual `drawPreviewCell` ctx-arg shape, the `hintDispatch` ctx fields, AND the `loopDoneCheck` ctx/args against sibling modules + the dispatch sites in `widget.js`/`preview.js` — pass exactly the fields the dispatcher provides. Two integration points need live confirmation against the dispatchers (not just hitori):
1. **Preview value source:** `drawPreviewCell`'s `v` must be the cell's *solved mask*. If `drawPreview` feeds board state (rotation counts) instead of solution masks, pipes needs the preview to map count→mask first (the dispatcher may need a small per-puzzle adapter, or feed `solution` for pipes). Confirm which the dispatcher passes; adapt.
2. **`loopDoneCheck` signature:** the generic done-check is `boardState.every(row => row.every(c => c !== 0))` and most puzzles pass `(boardState, solution)`. Pipes needs `detectedGrid`/`rows`/`cols` too. If the dispatcher doesn't already pass those, either (a) thread them through the loopDoneCheck ctx (small dispatcher change, mirror the partialResultArm ctx-passing pattern), or (b) have the hook read them from a captured-at-detect source. Pick the approach that matches the codebase; flag DONE_WITH_CONCERNS if neither fits cleanly.

Flag either as DONE_WITH_CONCERNS if the sibling pattern doesn't fit.

- [ ] **Step 2: Register in `src/widget/puzzles/index.js`**

Add, alongside the others: `if (typeof pipes !== 'undefined') PUZZLES[pipes.type] = pipes;`

- [ ] **Step 3: Add to `scripts/build-content-bundle.js` WIDGET_FILES**

Add `'puzzles/pipes.js'` to the puzzle-modules section (before `'puzzles/index.js'`).

- [ ] **Step 4: Add `pipesHandler` to `handler.js`**

Mirror `hitoriHandler` exactly. It should: have `type: 'pipes'`, match `path.indexOf('/pipes/') !== -1`, read via `callMainWorld('readPipesData', [])` + `callMainWorld('readPipesState', [rows, cols])`, expose `solveExtraData`/`getCells`, and `applySolution` that converts the solved masks → rotation counts (via the widget module's `solutionToRotations`, or inline the same `rotationCount` calls) and calls `callMainWorld('applyPipesState', [rotations])`. Then `registerHandler(pipesHandler);`. Read the hitori handler first and replicate its method set precisely.

- [ ] **Step 5: Add a hook unit test to `tests/puzzle-modules.test.js`**

Mirror the hitori entry. Test the pure hooks: `cacheKey` (stable + type-gated), `solveExtraData` (returns task+wrap:'auto'), `hintStatusNodes` (single + multi phrasing), and `solutionToRotations` (a known task+solution → expected counts). Example for the last:

```js
const pipes = require('../src/widget/puzzles/pipes.js');
test('pipes: solutionToRotations maps solved masks to rotation counts', () => {
  // task N(1); solved E(2) => 1 CW step. task straight N|S(5); solved E|W(10) => 1.
  const rot = pipes.solutionToRotations([[1, 5]], [[2, 10]], 1, 2);
  assert.deepEqual(rot, [[1, 1]]);
});
test('pipes: cacheKey is type-gated and stable', () => {
  const d = { type: 'pipes', rows: 1, cols: 2, task: [[1, 5]] };
  assert.equal(pipes.cacheKey({ type: 'other' }), null);
  assert.equal(pipes.cacheKey(d), pipes.cacheKey(d));
});
```

- [ ] **Step 6: Build + full gate**

Run: `npm run build && npm test && npm run lint && npm run typecheck`
Expected: all green; content bundle parse-check (bundle.test.js) passes; puzzle-modules tests include pipes.

- [ ] **Step 7: Commit**

```bash
jj commit -m "feat(pipes): handler, widget module, registry — Solve/Hint path"
```

---

## Task 9: Live probe — pin page rotation direction + wrap signal, then verify

**Files:** possibly `src/widget/puzzles/pipes.js` (`PIPE_PAGE_CW`), `main-world.js` (`applyPipesState` cellStatus semantics, wrap read), `handler.js`.

This task is interactive — it needs the user to run a console snippet on a live `/pipes/.../4x4` board. **Do not guess; adjust code to the observed output.**

- [ ] **Step 1: Give the user this probe snippet**

```js
(() => {
  const g = window.Game;
  const before = JSON.parse(JSON.stringify(g.currentState.cellStatus));
  // rotate cell (0,0) once via the page's own input path if available:
  let how = 'none';
  try {
    if (typeof g.getNextStatus === 'function') { how = 'getNextStatus(' + g.getNextStatus(0, 0, before[0][0]) + ')'; }
  } catch (e) { how = 'getNextStatus threw: ' + e.message; }
  return JSON.stringify({
    task00: g.task[0][0],
    cellStatus00_before: before[0][0],
    getNextStatus_src: (g.getNextStatus || '').toString().slice(0, 400),
    getCurrentStatus_src: (g.getCurrentStatus || '').toString().slice(0, 400),
    setCellState_src: (g.setCellState || '').toString().slice(0, 400),
    how,
    wrapHints: { path: location.pathname, hasWrap: 'wrap' in g, wrapVal: g.wrap, keys: Object.keys(g).filter(k => /wrap|toroid|loop/i.test(k)) },
  }, null, 2);
})()
```
Ask the user to also: rotate the top-left cell once by clicking it on the board, then run `JSON.stringify(window.Game.currentState.cellStatus[0][0])` and report the value, and describe which way the arms visually turned (clockwise or counter-clockwise).

- [ ] **Step 2: Interpret the output and set the flags**

- If a single click increments `cellStatus[0][0]` by 1 and arms turn **clockwise**, set `PIPE_PAGE_CW = true` (default — no change). If counter-clockwise, set `PIPE_PAGE_CW = false` in `src/widget/puzzles/pipes.js`.
- If `cellStatus` stores the **rotated mask** (not a 0..3 count), change `applyPipesState` to write `rotateCW(task, k)` masks instead of `k`, and change `solutionToRotations` consumers accordingly — OR write the solved mask directly if that's what the page reads. Adjust `readPipesState` to match.
- If a wrap signal exists (`g.wrap`, a path token, or a key from `wrapHints`), add a `wrap` field to `readPipesData` and pass it through `solveExtraData` (replacing `'auto'`); keep `'auto'` as fallback if none found.

- [ ] **Step 3: Re-run the full gate after any change**

Run: `npm run build && npm test && npm run lint && npm run typecheck` → all green.

- [ ] **Step 4: Commit (only if changes were made)**

```bash
jj commit -m "fix(pipes): pin page rotation direction / wrap signal from live probe"
```

- [ ] **Step 5: User live verification**

Ask the user to load `/pipes/random/4x4` (and a larger size if available), then:
- Click **Solve** → the board completes (all pipes connect; the site shows solved).
- Click **Hint** → a batch of cells rotate toward the solution.
- Click **Loop** → it finishes the board.
- If a wrap variant is reachable, verify Solve there too.
Report any cell that ends mis-rotated (would indicate a `PIPE_PAGE_CW` or cellStatus-semantics mismatch).

---

## Task 10: cache-key parity entry + docs

**Files:**
- Modify: `tests/cachekey-parity.test.js`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add pipes to `tests/cachekey-parity.test.js`**

Add `widget:pipes:cacheKey` to the characterization map. Require `pipes` module, build a fixture `data = { type:'pipes', rows:4, cols:4, task:[[8,3,2,6],[8,7,1,10],[10,13,13,11],[6,3,1,8]] }`, record the golden via the file's `RECORD=1` workflow, paste it in, and confirm a plain run passes.

- [ ] **Step 2: Update CLAUDE.md**

- Update the opening line listing supported puzzles to include Pipes ("…, Hashi, and Pipes").
- Add a "Per-puzzle design notes" bullet pointing at `src/widget/puzzles/pipes.js` + `src/solvers/pipes.js`.
- Add a one-line note: "Pipes is a rotation puzzle — `task` = 4-bit arm masks, `cellStatus` = rotation counts; solver returns solved masks, widget converts to counts via `pipes-rotation.js` (`PIPE_PAGE_CW`)."

- [ ] **Step 3: Final full gate**

Run: `npm run build && npm test && npm run lint && npm run typecheck`
Expected: all green. Note the final test count.

- [ ] **Step 4: Commit**

```bash
jj commit -m "test+docs(pipes): cache-key parity entry; document Pipes puzzle"
```

---

## Self-Review notes (for the executor)

- **TDD throughout:** solver primitives → solve → fuzz are test-first; the registration tasks (4,5,7,8) are wiring with the bundle/puzzle-modules tests as the gate.
- **The fuzz test is the real oracle** for solver correctness (constructive networks are solvable by construction; the solver must find an edge-consistent rotation of each cell). Wrap is covered.
- **Task 9 is interactive and probe-gated** — the apply-layer code (rotation direction, cellStatus semantics, wrap signal) is written to a documented default and adjusted to live observation. Do NOT mark Task 9 done without the user's live confirmation.
- **MAIN-world serialization:** `read/applyPipesState` and the dump branch must use only `window.Game`, nested helpers, and literals — no outer-scope refs (`fn.toString()` constraint).
- **Allowlist ↔ globals.d.ts sync** is a hard contract (Task 7).
- **Mirror, don't transcribe:** Tasks 7–8 say "mirror hitori's exact shape" for the handler and MAIN-world read/apply structure — read those files in the repo rather than relying on memory, since their precise method set is the integration contract.
- **jj only** for commits; each ends with the Co-Authored-By trailer.
