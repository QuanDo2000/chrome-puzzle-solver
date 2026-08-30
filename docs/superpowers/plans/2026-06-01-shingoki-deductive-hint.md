# Shingoki Deductive Hint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Version control:** This repo uses `jj`, never plain `git`. Commit with `jj commit -m "..."`. End commit messages with the trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Ignore the shell's harmless "zoxide: …" banner.
>
> **Per-task gate (run before every commit):** `npm run build && npm test && npm run lint && npm run typecheck` — all exit 0. (`npm run build` because solver.js/content.js feed `dist/`.) **The existing `tests/shingoki-fuzz.test.js` MUST stay green after every task — an unsound propagation rule breaks it immediately. Treat any fuzz failure as a stop-and-fix, never weaken the test.**

**Goal:** Make Shingoki's Hint (and Loop) reveal the next logically-forced edge from the current board, falling back silently to the cached-solution hint only when pure logic is exhausted.

**Architecture:** Add clue/number + border propagation rules and a 1-step lookahead to `ShingokiSolver`, expose them as `getStepwiseHint(curH, curV)` (mirroring `SlitherlinkSolver.getHint`), and have the Shingoki widget's `hintDispatch` try that first, falling back to the existing solution-diff code. Solver-side + one widget hook; no page-interaction, bundler, manifest, or handler changes.

**Tech Stack:** Vanilla JS, `node:test`. No new deps.

**Spec:** `docs/superpowers/specs/2026-05-31-shingoki-deductive-hint-design.md` (read first).

**Solver facts you need (verified):**
- `ShingokiSolver` (`src/solvers/shingoki.js`) constructor: `new ShingokiSolver({ rows, cols, task, maxMs })`. `task` is `(rows+1)×(cols+1)` signed vertex clues (>0 white/straight, <0 black/turn, abs = number = sum of the two straight runs in edges, 0 = none).
- Edge arrays: `this.H` `(rows+1)×cols`, `this.V` `rows×(cols+1)`; values `0` unknown / `1` line / `2` cross. `_initState()` builds them 0-filled.
- Helpers: `incidentEdges(r,c)` → `[{kind:'H'|'V', r, c}]` (in-range W/E/N/S), `getEdge(ref)`, `setEdge(ref,val)` (false on conflicting non-zero), `_endpoints(ref)`, `_allEdgeRefs()`, `runLengthAt(r,c)` (sum of straight line-runs through a vertex), `numbersSatisfied()`, `_propagate()` (worklist to fixpoint; returns false on contradiction).
- `_propagate()` ALREADY has: degree rule, degree-1 dead-end, circled-must-be-degree-2, white=collinear / black=perpendicular shape rules. It does NOT yet constrain clue NUMBERS or border-blocked axes. Measured: 0/60 edges deduced from an empty 5×5.
- Solver classes are globals in the content-script scope (manifest loads `solver.js` before `content.js`), so the widget can `new ShingokiSolver(...)` directly — Slitherlink's `hintDispatch` does exactly this.

**Captured 5×5-easy task (golden, used across tasks):**
```js
const TASK_5x5 = [
  [0,-5,0,0,0,0],
  [0,0,0,-4,0,0],
  [0,0,2,0,0,0],
  [-3,2,0,0,2,-4],
  [-3,0,0,-2,0,0],
  [0,0,0,-2,0,0],
];
```

---

## File Structure

**Modify:**
- `src/solvers/shingoki.js` — add border/axis propagation (Task 1), number-run propagation (Task 2), `_lookahead1` + `getStepwiseHint` (Task 3). All new propagation goes inside the existing `_propagate` worklist body (so it reaches fixpoint with the existing rules).
- `src/widget/puzzles/shingoki.js` — `hintDispatch` tries `getStepwiseHint` first, falls back to the existing solution-diff (Task 4).
- `tests/shingoki.test.js` — per-rule + `getStepwiseHint` unit tests (Tasks 1-3, 5).
- `tests/puzzle-modules.test.js` — `hintDispatch` deduction-first + fallback tests (Task 4).
- `AGENTS.md` / spec — note the deductive hint (Task 5).

No other files change.

---

## Task 1: Border/axis-forcing propagation (opening deductions)

Makes deductions fire on a fresh board purely from clue COLOUR + board geometry (no numbers yet). All rules are sound: they force a value only when the alternative is geometrically impossible.

**Rules (added to `_propagate`'s per-vertex body, only when `clue` is set):**
- A white vertex needs two **collinear** line edges: either both horizontal (West `H[r][c-1]` + East `H[r][c]`) or both vertical (North `V[r-1][c]` + South `V[r][c]`). An axis is *viable* only if BOTH its edges are in-range and not crossed (`!== 2`). If exactly one axis is viable, force its two edges to LINE and the other axis's in-range edges to CROSS. If neither axis is viable → contradiction (return false).
- A black vertex needs one horizontal + one vertical line. If only one horizontal edge is in-range-and-not-crossed, it MUST be the horizontal arm → force it LINE. Same for vertical. (Corner black, e.g. vertex (0,0): only East+South exist → both forced LINE.)

**Files:** Modify `src/solvers/shingoki.js`. Test `tests/shingoki.test.js`.

- [ ] **Step 1: Write failing tests** (append to `tests/shingoki.test.js`):

```js
test('Shingoki deduction: white clue on the top row is forced horizontal', () => {
  // White at top-row vertex (0,1): vertical axis needs North V[-1][1] (off-board),
  // so it's impossible -> must be horizontal. West H[0][0] + East H[0][1] forced LINE.
  const s = new ShingokiSolver({ rows: 2, cols: 2, task: [[0,2,0],[0,0,0],[0,0,0]] });
  s._initState();
  assert.equal(s._propagate(), true);
  assert.equal(s.getEdge({ kind: 'H', r: 0, c: 0 }), 1); // West forced line
  assert.equal(s.getEdge({ kind: 'H', r: 0, c: 1 }), 1); // East forced line
  assert.equal(s.getEdge({ kind: 'V', r: 0, c: 1 }), 2); // South forced cross
});

test('Shingoki deduction: black clue in a corner forces both available arms', () => {
  // Black at corner vertex (0,0): only East H[0][0] + South V[0][0] exist; black
  // must turn -> both are the arms -> forced LINE.
  const s = new ShingokiSolver({ rows: 2, cols: 2, task: [[-2,0,0],[0,0,0],[0,0,0]] });
  s._initState();
  assert.equal(s._propagate(), true);
  assert.equal(s.getEdge({ kind: 'H', r: 0, c: 0 }), 1);
  assert.equal(s.getEdge({ kind: 'V', r: 0, c: 0 }), 1);
});

test('Shingoki deduction: white axis-forcing does NOT fire when both axes viable', () => {
  // White at interior vertex (1,1) on a 2x2 board: both H and V axes are in-range
  // and unconstrained -> ambiguous -> nothing forced (soundness).
  const s = new ShingokiSolver({ rows: 2, cols: 2, task: [[0,0,0],[0,2,0],[0,0,0]] });
  s._initState();
  assert.equal(s._propagate(), true);
  // all four incident edges of (1,1) stay unknown
  for (const e of s.incidentEdges(1, 1)) assert.equal(s.getEdge(e), 0);
});

test('Shingoki deduction: white with both axes blocked is a contradiction', () => {
  // White at (1,1); cross West and East (kills horizontal) and North (kills
  // vertical, since vertical needs both N and S) -> no viable axis.
  const s = new ShingokiSolver({ rows: 2, cols: 2, task: [[0,0,0],[0,2,0],[0,0,0]] });
  s._initState();
  s.setEdge({ kind: 'H', r: 1, c: 0 }, 2);
  s.setEdge({ kind: 'H', r: 1, c: 1 }, 2);
  s.setEdge({ kind: 'V', r: 0, c: 1 }, 2);
  assert.equal(s._propagate(), false);
});
```

- [ ] **Step 2: Run, verify failing.** `node --test tests/shingoki.test.js` — the 4 new tests fail (no axis-forcing yet).

- [ ] **Step 3: Implement.** Inside `_propagate`, in the `if (clue) { ... }` shape block, BEFORE the existing "lineRefs.length >= 1" shape logic, add axis/arm forcing. Add this helper method to the class (after `incidentEdges`):

```js
  // The two edges of a given axis at vertex (r,c): 'H' => [West, East],
  // 'V' => [North, South]. Returns only in-range refs.
  _axisEdges(r, c, axis) {
    const { rows, cols } = this;
    if (axis === 'H') {
      const out = [];
      if (c - 1 >= 0) out.push({ kind: 'H', r, c: c - 1 });
      if (c < cols)   out.push({ kind: 'H', r, c });
      return out;
    }
    const out = [];
    if (r - 1 >= 0) out.push({ kind: 'V', r: r - 1, c });
    if (r < rows)   out.push({ kind: 'V', r, c });
    return out;
  }
```

Then add this block inside `_propagate`'s `if (clue) {` body, immediately after the `if (lines + unknown < 2) return false;` / `lines===0 && unknown===2` degree lines and BEFORE the `// Circle shape rules apply once we know...` comment:

```js
        // Border/axis forcing (sound opening deductions).
        if (clue.color === 'white') {
          // White needs two COLLINEAR lines. An axis is viable only if BOTH its
          // edges are in-range and not crossed.
          const hEdges = this._axisEdges(r, c, 'H');
          const vEdges = this._axisEdges(r, c, 'V');
          const hViable = hEdges.length === 2 && hEdges.every(e => this.getEdge(e) !== 2);
          const vViable = vEdges.length === 2 && vEdges.every(e => this.getEdge(e) !== 2);
          if (!hViable && !vViable) return false;
          if (hViable && !vViable) {
            for (const e of hEdges) if (this.getEdge(e) === 0 && !trySet(e, 1)) return false;
            for (const e of vEdges) if (this.getEdge(e) === 0 && !trySet(e, 2)) return false;
          } else if (vViable && !hViable) {
            for (const e of vEdges) if (this.getEdge(e) === 0 && !trySet(e, 1)) return false;
            for (const e of hEdges) if (this.getEdge(e) === 0 && !trySet(e, 2)) return false;
          }
        } else {
          // Black needs one horizontal + one vertical line. If only one edge of
          // an axis is available (in-range, not crossed), it must be that arm.
          for (const axis of ['H', 'V']) {
            const avail = this._axisEdges(r, c, axis).filter(e => this.getEdge(e) !== 2);
            if (avail.length === 1 && this.getEdge(avail[0]) === 0) {
              if (!trySet(avail[0], 1)) return false;
            }
          }
        }
```

- [ ] **Step 4: Run.** `node --test tests/shingoki.test.js` — all pass (new + existing 14). Then `node --test tests/shingoki-fuzz.test.js` — all 3 pass (soundness guard). If fuzz breaks, a rule is unsound — fix before committing.

- [ ] **Step 5: Gate + commit.** `npm run build && npm test && npm run lint && npm run typecheck` all 0.
```
jj commit -m "feat(shingoki): border/axis-forcing propagation (opening deductions)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Number-run propagation (run-cap + max-reach)

Makes the clue NUMBER constrain edges. Two sound rules.

**Files:** Modify `src/solvers/shingoki.js`. Test `tests/shingoki.test.js`.

- [ ] **Step 1: Write failing tests** (append):

```js
test('Shingoki number: confirmed run equal to the clue forces a cross at the open end', () => {
  // 1x3 board (2x4 vertices). White clue n=2 at vertex (0,1). Lay West+East as
  // the start of a horizontal run: H[0][0]=1 (West of (0,1)), H[0][1]=1 (East).
  // The run through (0,1) is already length 2 == n, so the next edge east,
  // H[0][2], must be CROSS (the run can't extend).
  const s = new ShingokiSolver({ rows: 1, cols: 3, task: [[0,2,0,0],[0,0,0,0]] });
  s._initState();
  s.setEdge({ kind: 'H', r: 0, c: 0 }, 1);
  s.setEdge({ kind: 'H', r: 0, c: 1 }, 1);
  assert.equal(s._propagate(), true);
  assert.equal(s.getEdge({ kind: 'H', r: 0, c: 2 }), 2); // run-cap forces cross
});

test('Shingoki number: a run longer than the clue is a contradiction', () => {
  // White n=2 at (0,1) but three collinear lines through it -> run 3 > 2.
  const s = new ShingokiSolver({ rows: 1, cols: 3, task: [[0,2,0,0],[0,0,0,0]] });
  s._initState();
  s.setEdge({ kind: 'H', r: 0, c: 0 }, 1);
  s.setEdge({ kind: 'H', r: 0, c: 1 }, 1);
  s.setEdge({ kind: 'H', r: 0, c: 2 }, 1);
  assert.equal(s._propagate(), false);
});

test('Shingoki number: run-cap does NOT fire before the run reaches the clue', () => {
  // White n=3 at (0,1), only one confirmed line so far (run 1 < 3) -> no forcing.
  const s = new ShingokiSolver({ rows: 1, cols: 3, task: [[0,3,0,0],[0,0,0,0]] });
  s._initState();
  s.setEdge({ kind: 'H', r: 0, c: 1 }, 1); // East only
  assert.equal(s._propagate(), true);
  // the West edge and the further-east edge stay unknown (run not yet capped)
  assert.equal(s.getEdge({ kind: 'H', r: 0, c: 2 }), 0);
});
```

- [ ] **Step 2: Run, verify failing.** `node --test tests/shingoki.test.js`.

- [ ] **Step 3: Implement.** Add a helper that, for a clued vertex with at least one confirmed line, measures the confirmed straight run and caps it. Add this method to the class (after `runLengthAt`):

```js
  // Run-cap: for a clued vertex with >=1 confirmed collinear line, if the
  // confirmed straight run already equals the clue number, force a cross at each
  // OPEN (unknown) end so the run can't grow; if it exceeds the number, signal a
  // contradiction. Returns false on contradiction. Only acts on confirmed (=1)
  // edges, so it's sound. `trySet` is passed in from _propagate to keep the
  // worklist coherent.
  _applyRunCap(r, c, clue, trySet) {
    // Determine the axis from confirmed line edges (white: collinear; black:
    // each arm is its own 1-edge "run" perpendicular to the other).
    const inc = this.incidentEdges(r, c).filter(e => this.getEdge(e) === 1);
    if (inc.length === 0) return true;
    // Walk a direction counting CONFIRMED line edges; return {len, endRef} where
    // endRef is the next edge beyond the run (or null if border).
    const walk = (dr, dc) => {
      let len = 0, cr = r, cc = c, endRef = null;
      for (;;) {
        const nr = cr + dr, nc = cc + dc;
        let ref;
        if (dr === 0) {
          const ec = Math.min(cc, nc);
          if (ec < 0 || ec >= this.cols || cr < 0 || cr > this.rows) { endRef = null; break; }
          ref = { kind: 'H', r: cr, c: ec };
        } else {
          const er = Math.min(cr, nr);
          if (er < 0 || er >= this.rows || cc < 0 || cc > this.cols) { endRef = null; break; }
          ref = { kind: 'V', r: er, c: cc };
        }
        if (this.getEdge(ref) !== 1) { endRef = ref; break; }
        len++; cr = nr; cc = nc;
      }
      return { len, endRef };
    };
    const horiz = inc.some(e => e.kind === 'H');
    const vert = inc.some(e => e.kind === 'V');
    let total = 0;
    const ends = [];
    if (horiz) { const a = walk(0, -1), b = walk(0, 1); total += a.len + b.len; ends.push(a.endRef, b.endRef); }
    if (vert)  { const a = walk(-1, 0), b = walk(1, 0); total += a.len + b.len; ends.push(a.endRef, b.endRef); }
    if (total > clue.n) return false;
    if (total === clue.n) {
      for (const ref of ends) {
        if (ref && this.getEdge(ref) === 0 && !trySet(ref, 2)) return false;
      }
    }
    return true;
  }
```

Then call it inside `_propagate`'s `if (clue) { ... }` body, at the END of that block (after the shape rules):
```js
        if (!this._applyRunCap(r, c, clue, trySet)) return false;
```

- [ ] **Step 4: Run.** `node --test tests/shingoki.test.js` (new + all prior pass) then `node --test tests/shingoki-fuzz.test.js` (3 pass). Fix any fuzz break before proceeding.

- [ ] **Step 5: Gate + commit.**
```
jj commit -m "feat(shingoki): number run-cap propagation (clue total constrains edges)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 1-step lookahead + getStepwiseHint

**Files:** Modify `src/solvers/shingoki.js`. Test `tests/shingoki.test.js`.

- [ ] **Step 1: Write failing tests** (append):

```js
test('Shingoki getStepwiseHint: returns forced LINE edges from an empty captured 5x5', () => {
  const TASK_5x5 = [
    [0,-5,0,0,0,0],[0,0,0,-4,0,0],[0,0,2,0,0,0],
    [-3,2,0,0,2,-4],[-3,0,0,-2,0,0],[0,0,0,-2,0,0],
  ];
  const s = new ShingokiSolver({ rows: 5, cols: 5, task: TASK_5x5, maxMs: 5000 });
  const curH = Array.from({ length: 6 }, () => new Array(5).fill(0));
  const curV = Array.from({ length: 5 }, () => new Array(6).fill(0));
  const hint = s.getStepwiseHint(curH, curV);
  assert.ok(hint && hint.edges.length >= 1, 'expected at least one forced edge');
  // Every returned edge must match the real solution (correctness of deduction).
  const solved = new ShingokiSolver({ rows: 5, cols: 5, task: TASK_5x5, maxMs: 10000 }).solve();
  assert.equal(solved.solved, true);
  for (const e of hint.edges) {
    const v = e.orientation === 'h' ? solved.horizontal[e.r][e.c] : solved.vertical[e.r][e.c];
    assert.equal(v, 1, `forced edge ${JSON.stringify(e)} must be a line in the solution`);
  }
});

test('Shingoki getStepwiseHint: returns null on a completed board', () => {
  const TASK_5x5 = [
    [0,-5,0,0,0,0],[0,0,0,-4,0,0],[0,0,2,0,0,0],
    [-3,2,0,0,2,-4],[-3,0,0,-2,0,0],[0,0,0,-2,0,0],
  ];
  const solved = new ShingokiSolver({ rows: 5, cols: 5, task: TASK_5x5, maxMs: 10000 }).solve();
  const s = new ShingokiSolver({ rows: 5, cols: 5, task: TASK_5x5, maxMs: 5000 });
  assert.equal(s.getStepwiseHint(solved.horizontal, solved.vertical), null);
});

test('Shingoki getStepwiseHint: does not mutate the caller arrays', () => {
  const TASK_5x5 = [
    [0,-5,0,0,0,0],[0,0,0,-4,0,0],[0,0,2,0,0,0],
    [-3,2,0,0,2,-4],[-3,0,0,-2,0,0],[0,0,0,-2,0,0],
  ];
  const s = new ShingokiSolver({ rows: 5, cols: 5, task: TASK_5x5, maxMs: 5000 });
  const curH = Array.from({ length: 6 }, () => new Array(5).fill(0));
  const curV = Array.from({ length: 5 }, () => new Array(6).fill(0));
  s.getStepwiseHint(curH, curV);
  assert.ok(curH.every(row => row.every(v => v === 0)));
  assert.ok(curV.every(row => row.every(v => v === 0)));
});
```

- [ ] **Step 2: Run, verify failing.** `node --test tests/shingoki.test.js` (getStepwiseHint undefined).

- [ ] **Step 3: Implement.** Add to the class (after `solve`):

```js
  // One round of 1-step lookahead: for each unknown edge, tentatively set LINE
  // then CROSS on a probe; if exactly one value survives propagation, force it.
  // Returns false on contradiction, true otherwise. Bounded by maxMs.
  _lookahead1() {
    const refs = this._allEdgeRefs();
    for (const e of refs) {
      if (this.getEdge(e) !== 0) continue;
      if (this.maxMs > 0 && timeUp(this.maxMs, this._startedAt)) return true;
      const trial = (val) => {
        const probe = new ShingokiSolver({ rows: this.rows, cols: this.cols, task: this.task });
        probe.H = this.H.map(row => row.slice());
        probe.V = this.V.map(row => row.slice());
        return probe.setEdge(e, val) && probe._propagate();
      };
      const lineOk = trial(1);
      const crossOk = trial(2);
      if (!lineOk && !crossOk) return false;
      if (lineOk && !crossOk) { if (!this.setEdge(e, 1) || !this._propagate()) return false; }
      else if (crossOk && !lineOk) { if (!this.setEdge(e, 2) || !this._propagate()) return false; }
    }
    return true;
  }

  // Deductive next-move hint. Seeds from the live board edge state, propagates
  // (+ one lookahead round if propagation alone forces nothing new), and returns
  // the newly-forced LINE edges (board was 0, now 1) up to a batch cap. Returns
  // null when logic forces no new line. Pure: never mutates curH/curV.
  getStepwiseHint(curH, curV) {
    this._startedAt = Date.now();
    this.H = curH.map(row => row.slice());
    this.V = curV.map(row => row.slice());
    const collect = () => {
      const out = [];
      for (let r = 0; r < this.H.length; r++) for (let c = 0; c < this.H[r].length; c++) {
        if (this.H[r][c] === 1 && (curH[r]?.[c] ?? 0) !== 1) out.push({ orientation: 'h', r, c });
      }
      for (let r = 0; r < this.V.length; r++) for (let c = 0; c < this.V[r].length; c++) {
        if (this.V[r][c] === 1 && (curV[r]?.[c] ?? 0) !== 1) out.push({ orientation: 'v', r, c });
      }
      return out;
    };
    if (!this._propagate()) return null; // contradictory board state; let caller fall back
    let edges = collect();
    if (edges.length === 0) {
      if (!this._lookahead1()) return null;
      edges = collect();
    }
    if (edges.length === 0) return null;
    const cap = Math.max(4, Math.ceil((this.rows * this.cols) / 30));
    return { edges: edges.slice(0, cap) };
  }
```

- [ ] **Step 4: Run.** `node --test tests/shingoki.test.js` (all pass) + `node --test tests/shingoki-fuzz.test.js` (3 pass).

- [ ] **Step 5: Gate + commit.**
```
jj commit -m "feat(shingoki): 1-step lookahead + getStepwiseHint deductive hint

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Widget hintDispatch — deduction first, solution fallback

**Files:** Modify `src/widget/puzzles/shingoki.js`. Test `tests/puzzle-modules.test.js`.

The current `hintDispatch` reads the live board via `callMainWorld('readShingokiState', [rows, cols])` and diffs against `solution`. Change it to FIRST instantiate a `ShingokiSolver` (global in the bundle; require it at the top under Node) from the detected task + live board and call `getStepwiseHint`; if that yields edges, return them; else fall through to the existing solution-diff.

- [ ] **Step 1: Write failing tests** (append to `tests/puzzle-modules.test.js`, near the other shingoki tests). At the top of the file with the other requires, add: `const { ShingokiSolver } = require('../src/solvers/shingoki.js');` (only if not already present — check first).

```js
test('shingoki: hintDispatch returns deductive edges when logic forces a move', async () => {
  const TASK_5x5 = [
    [0,-5,0,0,0,0],[0,0,0,-4,0,0],[0,0,2,0,0,0],
    [-3,2,0,0,2,-4],[-3,0,0,-2,0,0],[0,0,0,-2,0,0],
  ];
  // empty live board
  const callMainWorld = async (fn) => {
    if (fn === 'readShingokiState') {
      return { horizontal: Array.from({ length: 6 }, () => new Array(5).fill(0)),
               vertical: Array.from({ length: 5 }, () => new Array(6).fill(0)) };
    }
    return null;
  };
  const ctx = {
    solution: null, rows: 5, cols: 5, callMainWorld,
    detectedGrid: { type: 'shingoki', rows: 5, cols: 5, task: TASK_5x5 },
  };
  const r = await shingoki.hintDispatch(ctx);
  assert.equal(r.success, true);
  assert.ok(r.hint.edges.length >= 1);
  assert.ok(r.hint.edges.every(e => e.orientation === 'h' || e.orientation === 'v'));
});

test('shingoki: hintDispatch falls back to solution-diff when deduction yields nothing', async () => {
  // No task in detectedGrid -> deductive path can't run -> must fall back to the
  // solution diff. Solution has one line the empty board lacks.
  const callMainWorld = async (fn) => {
    if (fn === 'readShingokiState') return { horizontal: [[0,0],[0,0]], vertical: [[0],[0]] };
    return null;
  };
  const ctx = {
    solution: { horizontal: [[1,0],[0,0]], vertical: [[0],[0]] },
    rows: 1, cols: 1, callMainWorld, detectedGrid: { type: 'shingoki', rows: 1, cols: 1 },
  };
  const r = await shingoki.hintDispatch(ctx);
  assert.equal(r.success, true);
  assert.deepEqual(r.hint.edges, [{ orientation: 'h', r: 0, c: 0 }]);
});
```

- [ ] **Step 2: Run, verify failing.** `node --test tests/puzzle-modules.test.js`.

- [ ] **Step 3: Implement.** In `src/widget/puzzles/shingoki.js`, replace the body of `hintDispatch` so it tries deduction first. The current hook reads `{ callMainWorld, solution, rows, cols }` from ctx; also read `detectedGrid` (present in the hint.js ctx) for the task. Reference implementation:

```js
  async hintDispatch(ctx) {
    const { callMainWorld, solution, rows, cols, detectedGrid } = ctx;
    const board = await callMainWorld('readShingokiState', [rows, cols]);
    if (!board) return { success: false, error: 'Could not read board' };

    // 1) Deductive hint: forced edges from the live board via the solver.
    //    `ShingokiSolver` is a content-script global (solver.js loads first);
    //    require()'d under Node for tests. Guarded so a solver/throw can't break
    //    Hint — fall through to the solution diff.
    const task = detectedGrid && detectedGrid.task;
    if (task) {
      try {
        const Solver = (typeof ShingokiSolver !== 'undefined')
          ? ShingokiSolver
          : require('../../solvers/shingoki.js').ShingokiSolver;
        const solver = new Solver({ rows, cols, task, maxMs: 5000 });
        const deduced = solver.getStepwiseHint(board.horizontal, board.vertical);
        if (deduced && deduced.edges.length) {
          return { success: true, hint: { type: 'shingoki', edges: deduced.edges }, grid: board, solution };
        }
      } catch (_e) { /* fall through to solution diff */ }
    }

    // 2) Fallback: reveal the next correct LINE edges from the cached solution.
    if (!solution || !solution.horizontal || !solution.vertical) {
      return { success: false, error: 'No solution available' };
    }
    const cap = hintBatchCap(rows, cols);
    const edges = [];
    const { horizontal, vertical } = solution;
    for (let r = 0; r < horizontal.length && edges.length < cap; r++) {
      for (let c = 0; c < horizontal[r].length && edges.length < cap; c++) {
        if (horizontal[r][c] === 1 && board.horizontal[r][c] !== 1) edges.push({ orientation: 'h', r, c });
      }
    }
    for (let r = 0; r < vertical.length && edges.length < cap; r++) {
      for (let c = 0; c < vertical[r].length && edges.length < cap; c++) {
        if (vertical[r][c] === 1 && board.vertical[r][c] !== 1) edges.push({ orientation: 'v', r, c });
      }
    }
    if (!edges.length) return { success: false, error: 'No hint available' };
    return { success: true, hint: { type: 'shingoki', edges }, grid: board, solution };
  },
```

NOTE on the Node `require`: the widget module currently only `require`s `../shared.js`. Adding a guarded `require('../../solvers/shingoki.js')` inside a `typeof ShingokiSolver === 'undefined'` branch is safe — in the browser bundle `ShingokiSolver` is a global so the require is never reached; under Node tests the require resolves. Verify the build's require-strip guard (`SHARED_REQUIRE_RE`) does NOT strip this line (it only strips `shared`/`pipes-rotation` requires); if the bundler complains, move the require to a module-top `let` guarded by `typeof module !== 'undefined'` instead. Confirm with `npm run build`.

- [ ] **Step 4: Run.** `node --test tests/puzzle-modules.test.js` (new + existing shingoki tests pass). `npm run build` (confirm no require-strip error; confirm bundle still has `type: 'shingoki'`).

- [ ] **Step 5: Gate + commit.**
```
jj commit -m "feat(shingoki): Hint/Loop use deductive getStepwiseHint, fall back to solution

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Measure deductive reach + docs

**Files:** `tests/shingoki.test.js` (measurement test), `AGENTS.md` / spec note.

- [ ] **Step 1: Add a measurement test** that records how far pure logic reaches on the captured 5×5 (NOT asserted to be 100% — the spec says fallback covers gaps). Append to `tests/shingoki.test.js`:

```js
test('Shingoki deductive reach: iterating getStepwiseHint from empty makes monotonic, correct progress', () => {
  const TASK_5x5 = [
    [0,-5,0,0,0,0],[0,0,0,-4,0,0],[0,0,2,0,0,0],
    [-3,2,0,0,2,-4],[-3,0,0,-2,0,0],[0,0,0,-2,0,0],
  ];
  const solved = new ShingokiSolver({ rows: 5, cols: 5, task: TASK_5x5, maxMs: 10000 }).solve();
  assert.equal(solved.solved, true);
  const H = Array.from({ length: 6 }, () => new Array(5).fill(0));
  const V = Array.from({ length: 5 }, () => new Array(6).fill(0));
  let steps = 0, applied = 0;
  for (; steps < 100; steps++) {
    const s = new ShingokiSolver({ rows: 5, cols: 5, task: TASK_5x5, maxMs: 5000 });
    const hint = s.getStepwiseHint(H, V);
    if (!hint) break;
    for (const e of hint.edges) {
      // every deduced edge must be correct
      const v = e.orientation === 'h' ? solved.horizontal[e.r][e.c] : solved.vertical[e.r][e.c];
      assert.equal(v, 1, `deduced edge ${JSON.stringify(e)} must match solution`);
      if (e.orientation === 'h') H[e.r][e.c] = 1; else V[e.r][e.c] = 1;
      applied++;
    }
  }
  assert.ok(steps < 100, 'must terminate (getStepwiseHint returns null when stuck)');
  assert.ok(applied >= 1, 'pure logic should deduce at least one edge on this board');
  // Record reach for visibility (not a hard assertion):
  const totalLines = solved.horizontal.flat().filter(v => v === 1).length
                   + solved.vertical.flat().filter(v => v === 1).length;
  console.log(`[shingoki deductive reach] logic placed ${applied}/${totalLines} solution lines in ${steps} hint rounds`);
});
```

- [ ] **Step 2: Run.** `node --test tests/shingoki.test.js` — passes; note the logged reach (`applied/totalLines`).

- [ ] **Step 3: Update docs.** In `AGENTS.md`, under the Shingoki design-notes bullet, append a short clause: `(Hint/Loop use a deductive getStepwiseHint — border/axis + number-run propagation + 1-step lookahead — falling back to the cached solution when logic is exhausted).` Add a one-line note to the bottom of `src/solvers/shingoki.js`'s header comment pointing at `getStepwiseHint` as the deductive-hint entry point.

- [ ] **Step 4: Full gate + commit.** `npm run build && npm test && npm run lint && npm run typecheck` all 0.
```
jj commit -m "test+docs(shingoki): measure deductive-hint reach; document getStepwiseHint

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Live verification (INTERACTIVE — user)

**Files:** none.

- [ ] **Step 1:** User reloads `dist/` (chrome://extensions → reload ↻) and hard-reloads the Shingoki 5×5-easy page.
- [ ] **Step 2:** Detect, then click **Hint** repeatedly — confirm it reveals correct edges (now logic-driven; on this board many will be forced openings).
- [ ] **Step 3:** **Loop** — confirm it plays out, drawing batches until solved (deduction where possible, solution fallback otherwise), no stall.
- [ ] **Step 4:** Confirm **Solve → Confirm** still works (unchanged path).
- [ ] **Step 5:** If a hint ever reveals a WRONG edge, that's an unsound deduction rule — capture the board state (📋 Dump) and the rule will be corrected (re-run the full gate after any fix).

---

## Self-Review

**1. Spec coverage:**
- Border/axis opening rules (spec §Rules 3) → Task 1 ✓
- Number run-cap + reachability (spec §Rules 1,2,4) → Task 2 (run-cap + over-length contradiction; max-reach/black-split partially emergent via run-cap + axis-forcing + lookahead — see note below) ⚠ (see gap)
- 1-step lookahead (spec §Rules) → Task 3 ✓
- `getStepwiseHint` contract (line edges or null, pure, batch cap, maxMs) → Task 3 ✓
- Widget deduction-first + silent solution fallback → Task 4 ✓
- Both Hint and Loop use it (Loop already calls hintDispatch) → Task 4 (no loop change needed) ✓
- No prose reasons → honored (edges only) ✓
- Silent fallback, never throws (try/catch) → Task 4 ✓
- Tests: per-rule soundness (fires + does-not-fire), getStepwiseHint, fallback, fuzz stays green, reach measurement → Tasks 1-5 ✓

**Gap noted (intentional, not a placeholder):** Spec rule 2 "run-floor/reachability force the alternative" and rule 4 "black arm-length split" are only PARTIALLY implemented (run-cap covers the "==n forces cross / >n contradiction" half; the "max-reach < n" forcing is left to the 1-step lookahead, which catches it indirectly — if a direction can't reach n, setting the wrong edge there contradicts during propagation). This is a deliberate scope trim: the lookahead subsumes the harder forward-checking forms soundly, and the measurement test (Task 5) documents the actual reach. If Task 5 shows poor reach (e.g. `applied` is tiny), a follow-up task can add explicit max-reach forcing — but per the spec's "measure first" stance, we don't build it speculatively.

**2. Placeholder scan:** No TBD/TODO; every code step has complete code; commands and expected outcomes are explicit.

**3. Type consistency:** `getStepwiseHint(curH, curV)` → `{ edges:[{orientation:'h'|'v', r, c}] } | null` consistent across Tasks 3, 4, 5. `_axisEdges(r,c,axis)`, `_applyRunCap(r,c,clue,trySet)`, `_lookahead1()` signatures consistent. Edge refs `{kind:'H'|'V', r, c}` (solver-internal) vs hint edges `{orientation:'h'|'v', r, c}` (widget contract) — distinct shapes, used correctly in each layer (matches the existing base-feature convention).
