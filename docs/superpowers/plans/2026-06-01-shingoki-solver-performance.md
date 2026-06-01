# Shingoki Solver Performance (Large Boards) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
>
> **Version control:** `jj`, NEVER git. Commit `jj commit -m "msg"`. Trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Ignore the "zoxide" shell banner.
>
> **Per-task gate before every commit:** `npm run build && npm test && npm run lint && npm run typecheck` — all exit 0. **The constructive fuzz `tests/shingoki-fuzz.test.js` is the MASTER SOUNDNESS GUARD — it must stay GREEN after every task. An unsound prune or force breaks it immediately. Stop-and-fix; never weaken a test.**
>
> **MEASURE-AND-STOP:** This plan is measure-driven. Task 0 establishes the baseline + bench. Each subsequent layer (Tasks 2,3,4) ends with a MEASUREMENT GATE: run the 40×40 bench, record the time. **As soon as the 40×40 solves in a few seconds (target ≤ ~5s, hard ceiling 10s), SKIP the remaining layers** and jump to the final task. If after Task 4 it is still over budget, STOP and escalate (CDCL is a separate spec) — do not expand scope.

**Goal:** The real 40×40 monthly Shingoki board (currently a 30s timeout) solves fully in a few seconds.

**Architecture:** Strengthen `ShingokiSolver` in measured layers: (1) trail-based undo to kill per-branch snapshot allocation, (2) in-search connectivity pruning (premature-subloop + reachability), (3) number max-reach propagation, (4) smarter branching. Measure on the real board after each; stop when fast enough. All inside `src/solvers/shingoki.js`. CDCL out of scope.

**Tech Stack:** Vanilla JS, `node:test`. No new deps.

**Spec:** `docs/superpowers/specs/2026-06-01-shingoki-solver-performance-design.md` (read first).

**Solver facts (verified):**
- `src/solvers/shingoki.js`: `ShingokiSolver({rows,cols,task,maxMs})`. Edge arrays `this.H` `(rows+1)×cols`, `this.V` `rows×(cols+1)`; 0/1/2 = unknown/line/cross.
- `getEdge(ref)` (lines 62-64): `ref.kind==='H' ? this.H[ref.r][ref.c] : this.V[ref.r][ref.c]`.
- `setEdge(ref,val)` (lines 66-73): returns false on conflicting non-zero; else writes and returns true. **This is the single mutation chokepoint** — trail-undo hooks here.
- `_propagate()` routes all forces through the local `trySet` → `setEdge`.
- `solve()` (lines ~269-324) uses THREE full-array snapshot sites: the loop-closure short-circuit (lines 290-294) and the branch loop `for (const val of [2,1])` (lines 307-313). These are what trail-undo replaces.
- `_endpoints(ref)`, `_allEdgeRefs()`, `incidentEdges(r,c)`, `_hasPrematureLoop()`, `_loopComplete()`, `_isValidComplete()`, `numbersSatisfied()` all exist.
- Real-puzzle fixtures live in `tests/fixtures/real-puzzles.js` (plain JS exporting board objects `{type, rows, cols, task, ...}`); `tests/bench-real.js` benches them.

**Captured 40×40 monthly board (the benchmark):** saved at `/tmp/real40.json` during profiling; the full task array is in the session. Task 0 embeds it in the fixture file.

---

## File Structure

**Modify:**
- `src/solvers/shingoki.js` — all four layers (trail-undo, connectivity prune, max-reach, branching).
- `tests/fixtures/real-puzzles.js` — add the captured 40×40 shingoki board.
- `tests/shingoki.test.js` — per-layer unit tests + a bounded perf test on the 40×40.

**Create:**
- `tests/bench-shingoki.js` — standalone bench (mirrors `tests/bench-real.js`) printing solve time on the real board. Used for the measurement gates (not part of `npm test`).

No other files change.

---

## Task 0: Capture the benchmark board + baseline measurement

**Files:** Modify `tests/fixtures/real-puzzles.js`; Create `tests/bench-shingoki.js`.

- [ ] **Step 1: Add the captured board to `tests/fixtures/real-puzzles.js`.** Append (the full task array is the 40×40 dumped this session — the agent must copy it verbatim from `/tmp/real40.json`, which contains `{"rows":40,"cols":40,"task":[...]}`):

```js
// 40x40 shingoki, /shingoki/special/monthly. Captured via Dump.
// Signed vertex clues on a 41x41 lattice (>0 white/straight, <0 black/turn,
// abs=number, 0=none). Benchmark for solver performance.
const shingoki_40x40_monthly = {
  type: 'shingoki',
  rows: 40,
  cols: 40,
  task: /* paste the 41x41 task array from /tmp/real40.json verbatim */,
};
```
Add `shingoki_40x40_monthly` to the file's `module.exports` (match how existing fixtures are exported — read the export block at the bottom of the file first).

VERIFY the paste: `node -e "const f=require('./tests/fixtures/real-puzzles.js'); const p=f.shingoki_40x40_monthly; console.log(p.rows, p.cols, p.task.length, p.task[0].length)"` must print `40 40 41 41`.

- [ ] **Step 2: Create `tests/bench-shingoki.js`:**

```js
'use strict';
// Standalone bench for ShingokiSolver on the real captured board.
// Run: node tests/bench-shingoki.js   (NOT part of npm test)
const { ShingokiSolver } = require('../src/solvers/shingoki.js');
const fixtures = require('./fixtures/real-puzzles.js');

const p = fixtures.shingoki_40x40_monthly;
const MAXMS = Number(process.env.MAXMS || 30000);
const t0 = Date.now();
const res = new ShingokiSolver({ rows: p.rows, cols: p.cols, task: p.task, maxMs: MAXMS }).solve();
const ms = Date.now() - t0;
let ok = false;
if (res.solved) {
  const chk = new ShingokiSolver({ rows: p.rows, cols: p.cols, task: p.task });
  chk.H = res.horizontal; chk.V = res.vertical;
  ok = chk.numbersSatisfied();
}
console.log(`shingoki 40x40: solved=${res.solved} valid=${ok} ms=${ms}${res.error ? ' err=' + res.error : ''}`);
process.exit(res.solved && ok ? 0 : 1);
```

- [ ] **Step 3: Record the BASELINE.** Run `node tests/bench-shingoki.js`. Expected (current solver): `solved=false ... err=time limit exceeded ms=~30000`. **Record this exact line** — it's the before number every later gate compares against.

- [ ] **Step 4: Gate + commit.** `npm run build && npm test && npm run lint && npm run typecheck` (the bench is not in npm test, but the fixture require must not break anything). Commit:
```
jj commit -m "test(shingoki): capture real 40x40 monthly board + perf bench (baseline: 30s timeout)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 1: Trail-based undo (Layer 1)

Replace per-branch full-array snapshots with an O(changes) change-trail. **Behavior-preserving** — same solutions, just no allocation.

**Files:** Modify `src/solvers/shingoki.js`. Test: existing suite + a focused trail test.

- [ ] **Step 1: Write a focused test** (append to `tests/shingoki.test.js`):

```js
test('ShingokiSolver: trail records and rolls back edge writes', () => {
  const s = new ShingokiSolver({ rows: 2, cols: 2, task: [[0,0,0],[0,0,0],[0,0,0]] });
  s._initState();
  const mark = s._trailMark();
  s.setEdge({ kind: 'H', r: 0, c: 0 }, 1);
  s.setEdge({ kind: 'V', r: 1, c: 1 }, 2);
  assert.equal(s.getEdge({ kind: 'H', r: 0, c: 0 }), 1);
  assert.equal(s.getEdge({ kind: 'V', r: 1, c: 1 }), 2);
  s._rollbackTo(mark);
  assert.equal(s.getEdge({ kind: 'H', r: 0, c: 0 }), 0);
  assert.equal(s.getEdge({ kind: 'V', r: 1, c: 1 }), 0);
});
```

- [ ] **Step 2: Run, verify fail** (`_trailMark`/`_rollbackTo` undefined). `node --test tests/shingoki.test.js`.

- [ ] **Step 3: Implement the trail.** In `_initState`, add `this._trail = [];`. Change `setEdge` to record the prior value when it writes:

```js
  setEdge(ref, val) {
    const cur = this.getEdge(ref);
    if (cur === val) return true;
    if (cur !== 0) return false;
    if (this._trail) this._trail.push(ref.kind, ref.r, ref.c, cur);
    if (ref.kind === 'H') this.H[ref.r][ref.c] = val; else this.V[ref.r][ref.c] = val;
    return true;
  }
```
(Push flat primitives, not objects, to avoid per-write allocation — mirrors the perf style of the other solvers.)

Add:
```js
  _trailMark() { return this._trail ? this._trail.length : 0; }

  _rollbackTo(mark) {
    const t = this._trail;
    if (!t) return;
    while (t.length > mark) {
      const prev = t.pop(), c = t.pop(), r = t.pop(), kind = t.pop();
      if (kind === 'H') this.H[r][c] = prev; else this.V[r][c] = prev;
    }
  }
```

- [ ] **Step 4: Convert `solve()`'s three snapshot sites to trail mark/rollback.** Replace the loop-closure short-circuit block (currently lines ~290-295):
```js
      if (this._loopComplete()) {
        const mark = this._trailMark();
        for (const e of allEdges) if (this.getEdge(e) === 0) this.setEdge(e, 2);
        if (this._isValidComplete()) return this._snapshotGrid();
        this._rollbackTo(mark);
        return null;
      }
```
And the branch loop (currently lines ~306-314):
```js
      for (const val of [2, 1]) {
        const mark = this._trailMark();
        if (this.setEdge(edge, val) && this._propagate() && !this._hasPrematureLoop()) {
          const got = backtrack();
          if (got) return got;
        }
        this._rollbackTo(mark);
      }
```
NOTE: `_snapshotGrid()` (deep-copies H/V for the RETURN value) stays unchanged — that's the final answer, not a branch snapshot.

- [ ] **Step 5: Run the full suite.** `node --test tests/shingoki.test.js` (all pass incl new trail test) + `node --test tests/shingoki-fuzz.test.js` (3 pass — trail-undo must not change results). If fuzz changes/breaks, the rollback is wrong.

- [ ] **Step 6: MEASUREMENT GATE.** `node tests/bench-shingoki.js` — record the time. (Layer 1 alone may not solve the 40×40, but the per-node cost should drop; if it solves in a few seconds, you may skip ahead — but still implement Layer 2 connectivity only if needed. Record the number regardless.)

- [ ] **Step 7: Gate + commit.** Full gate green. Commit:
```
jj commit -m "perf(shingoki): trail-based undo replaces per-branch array snapshots

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: In-search connectivity pruning (Layer 2 — centerpiece)

Prune partial states whose committed LINE edges can never close into one loop. **Sound: only prunes provably-dead states.** This is the likeliest big win.

**Files:** Modify `src/solvers/shingoki.js`. Test `tests/shingoki.test.js`.

- [ ] **Step 1: Write soundness tests** (append). These assert the prune fires on dead states and does NOT fire on live ones:

```js
test('Shingoki connectivity: a closed subloop with clues still outside is pruned', () => {
  // 3x3 board (4x4 verts). Close the unit square at the top-left: H[0][0],H[1][0],
  // V[0][0],V[0][1] form a closed 1x1 loop. Put a clue OUTSIDE it (vertex (3,3))
  // that must be on the loop -> this partial can never become one loop -> dead.
  const s = new ShingokiSolver({ rows: 3, cols: 3, task: [
    [0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,-2],
  ] });
  s._initState();
  s.setEdge({ kind: 'H', r: 0, c: 0 }, 1);
  s.setEdge({ kind: 'H', r: 1, c: 0 }, 1);
  s.setEdge({ kind: 'V', r: 0, c: 0 }, 1);
  s.setEdge({ kind: 'V', r: 0, c: 1 }, 1);
  assert.equal(s._deadByConnectivity(), true);
});

test('Shingoki connectivity: a valid open partial chain is NOT pruned', () => {
  // An open chain (not yet closed) with a clue elsewhere is still completable.
  const s = new ShingokiSolver({ rows: 3, cols: 3, task: [
    [0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,-2],
  ] });
  s._initState();
  s.setEdge({ kind: 'H', r: 0, c: 0 }, 1); // single open segment
  assert.equal(s._deadByConnectivity(), false);
});

test('Shingoki connectivity: an empty board is NOT pruned', () => {
  const s = new ShingokiSolver({ rows: 3, cols: 3, task: [
    [0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,-2],
  ] });
  s._initState();
  assert.equal(s._deadByConnectivity(), false);
});
```

- [ ] **Step 2: Run, verify fail** (`_deadByConnectivity` undefined).

- [ ] **Step 3: Implement `_deadByConnectivity()`.** Returns true iff the committed line edges provably cannot extend to a single loop covering all clued vertices. Sound checks only:

```js
  // True iff the committed LINE edges can never close into ONE loop through all
  // clued vertices. Sound: only reports states with no valid completion.
  // (a) Premature subloop: a maximal line-component that is already a closed
  //     cycle (all its vertices degree 2) while some line edge OR clued vertex
  //     lies outside it -> a 2nd component can never merge -> dead.
  // (b) (covered by existing degree rules: a degree-1 endpoint is fine mid-search)
  _deadByConnectivity() {
    const { rows, cols } = this;
    const lineDeg = (r, c) => this.incidentEdges(r, c).filter(e => this.getEdge(e) === 1).length;
    // Collect line-vertices (degree >= 1 in lines).
    const vid = (r, c) => r * (cols + 1) + c;
    const seen = new Uint8Array((rows + 1) * (cols + 1));
    const lineVerts = [];
    for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
      if (lineDeg(r, c) > 0) lineVerts.push([r, c]);
    }
    if (lineVerts.length === 0) return false; // nothing committed
    // BFS each line-component over LINE edges; a component is "closed" iff every
    // vertex in it has line-degree exactly 2.
    let components = 0;
    let sawClosed = false;
    for (const [sr, sc] of lineVerts) {
      if (seen[vid(sr, sc)]) continue;
      components++;
      let closed = true;
      const stack = [[sr, sc]]; seen[vid(sr, sc)] = 1;
      const compCells = [];
      while (stack.length) {
        const [r, c] = stack.pop();
        compCells.push([r, c]);
        if (lineDeg(r, c) !== 2) closed = false;
        for (const e of this.incidentEdges(r, c)) {
          if (this.getEdge(e) !== 1) continue;
          const [a, b] = this._endpoints(e);
          const nv = (a.r === r && a.c === c) ? b : a;
          if (!seen[vid(nv.r, nv.c)]) { seen[vid(nv.r, nv.c)] = 1; stack.push([nv.r, nv.c]); }
        }
      }
      if (closed) sawClosed = true;
    }
    // A closed component is only valid if it is the ONLY component AND every
    // clued vertex is inside it (degree 2). If a closed loop exists but there
    // are other line-components, OR a clued vertex is not on this closed loop,
    // it's a premature subloop -> dead.
    if (sawClosed) {
      if (components > 1) return true;
      // single closed component: every clued vertex must be in it (degree 2).
      for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
        const clue = ShingokiSolver.decodeClue(this.task[r][c]);
        if (clue && !seen[vid(r, c)]) return true; // clue outside the closed loop
      }
    }
    return false;
  }
```

- [ ] **Step 4: Wire it into the branch loop** in `solve()`, alongside `_hasPrematureLoop`:
```js
        if (this.setEdge(edge, val) && this._propagate() && !this._hasPrematureLoop() && !this._deadByConnectivity()) {
```

- [ ] **Step 5: Run.** `node --test tests/shingoki.test.js` (new + all prior) + `node --test tests/shingoki-fuzz.test.js` (3 pass — over-pruning breaks these). If fuzz breaks, `_deadByConnectivity` is unsound; debug, do not weaken tests.

- [ ] **Step 6: MEASUREMENT GATE.** `node tests/bench-shingoki.js` — record the time. **If solved in a few seconds (≤~5s), the feature target is met — skip Tasks 3 & 4 and go to Task 5.** Otherwise continue.

- [ ] **Step 7: Gate + commit.**
```
jj commit -m "perf(shingoki): in-search connectivity pruning (premature-subloop / cut-off-clue)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Number max-reach propagation (Layer 3) — ONLY IF Task 2's gate didn't hit target

Add max-reach forcing to `_propagate`: a clued vertex whose only viable straight axis cannot reach its clue number is a contradiction; a direction whose minimum required run forces edges, forces them.

**Files:** Modify `src/solvers/shingoki.js`. Test `tests/shingoki.test.js`.

- [ ] **Step 1: Write soundness tests** (append):

```js
test('Shingoki max-reach: white clue whose only axis cannot reach its number is a contradiction', () => {
  // 1x3 board (2x4 verts). White n=5 at vertex (0,1). Horizontal axis max length
  // through (0,1) is West(1) + East(2) = 3 edges < 5, and vertical is impossible
  // (top row) -> contradiction.
  const s = new ShingokiSolver({ rows: 1, cols: 3, task: [[0,5,0,0],[0,0,0,0]] });
  s._initState();
  assert.equal(s._propagate(), false);
});

test('Shingoki max-reach: does NOT fire when the clue is still reachable', () => {
  // White n=3 at (0,1): max horizontal reach = 3 == n -> reachable -> no contradiction.
  const s = new ShingokiSolver({ rows: 1, cols: 3, task: [[0,3,0,0],[0,0,0,0]] });
  s._initState();
  assert.equal(s._propagate(), true);
});
```

- [ ] **Step 2: Run, verify the first fails** (currently `_propagate` returns true for the n=5 case — no max-reach check).

- [ ] **Step 3: Implement `_maxReach(r,c,axis)` + the check.** Add:

```js
  // Maximum straight-run length (in edges) achievable through vertex (r,c) on
  // an axis: count line+unknown edges outward in both directions until a CROSS
  // or border. Confirmed crosses cap the run; unknowns are optimistically
  // counted (they COULD be lines). Used for the sound "can't reach the clue"
  // contradiction.
  _maxReach(r, c, axis) {
    const reach = (dr, dc) => {
      let len = 0, cr = r, cc = c;
      for (;;) {
        const nr = cr + dr, nc = cc + dc;
        let ref;
        if (dr === 0) {
          const ec = Math.min(cc, nc);
          if (ec < 0 || ec >= this.cols || cr < 0 || cr > this.rows) break;
          ref = { kind: 'H', r: cr, c: ec };
        } else {
          const er = Math.min(cr, nr);
          if (er < 0 || er >= this.rows || cc < 0 || cc > this.cols) break;
          ref = { kind: 'V', r: er, c: cc };
        }
        if (this.getEdge(ref) === 2) break; // cross caps the run
        len++; cr = nr; cc = nc;
      }
      return len;
    };
    return axis === 'H' ? reach(0, -1) + reach(0, 1) : reach(-1, 0) + reach(1, 0);
  }
```

Then inside `_propagate`'s `if (clue) { ... }` body, after the existing run-cap call, add the max-reach contradiction (sound: if NEITHER axis can reach the number, no completion exists). Use the existing `_axisEdges` viability notion:

```js
        // Max-reach: if no viable axis can reach the clue number, contradiction.
        // White must use ONE collinear axis; black sums BOTH perpendicular arms.
        if (clue.color === 'white') {
          const hV = this._axisEdges(r, c, 'H').length === 2 && this._axisEdges(r, c, 'H').every(e => this.getEdge(e) !== 2);
          const vV = this._axisEdges(r, c, 'V').length === 2 && this._axisEdges(r, c, 'V').every(e => this.getEdge(e) !== 2);
          const best = Math.max(hV ? this._maxReach(r, c, 'H') : 0, vV ? this._maxReach(r, c, 'V') : 0);
          if (best < clue.n) return false;
        } else {
          // black: the two arms are perpendicular; max total = H reach + V reach.
          if (this._maxReach(r, c, 'H') + this._maxReach(r, c, 'V') < clue.n) return false;
        }
```

- [ ] **Step 4: Run.** `node --test tests/shingoki.test.js` + `node --test tests/shingoki-fuzz.test.js` (must stay green — max-reach must never under-count a genuinely reachable run, which would wrongly reject a valid board).

- [ ] **Step 5: MEASUREMENT GATE.** `node tests/bench-shingoki.js` — record. **If under target, skip Task 4 → Task 5.**

- [ ] **Step 6: Gate + commit.**
```
jj commit -m "perf(shingoki): number max-reach contradiction propagation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Smarter branching (Layer 4) — ONLY IF Task 3's gate didn't hit target

Branch on the most-constrained unknown edge (incident to a clued vertex or adjacent to a committed line) instead of first-in-scan. The current code already prefers an edge "incident to a vertex that already has a line"; extend the preference to also weight clued-vertex adjacency, picking the edge with the FEWEST remaining viable completions among its endpoints.

**Files:** Modify `src/solvers/shingoki.js`. Test `tests/shingoki.test.js`.

- [ ] **Step 1: Write a test** that the chosen branch edge is adjacent to a constrained vertex when one exists:

```js
test('Shingoki branching: prefers an edge incident to a clued or lined vertex', () => {
  // This is a heuristic; assert via _pickBranchEdge returning an edge touching
  // a clued vertex over an isolated one.
  const s = new ShingokiSolver({ rows: 2, cols: 2, task: [[0,0,0],[0,0,0],[0,0,-2]] });
  s._initState();
  const e = s._pickBranchEdge(s._allEdgeRefs());
  assert.ok(e, 'should pick an edge');
  const touchesClue = s._endpoints(e).some(v => ShingokiSolver.decodeClue(s.task[v.r]?.[v.c]) ||
    s.incidentEdges(v.r, v.c).some(x => s.getEdge(x) === 1));
  assert.equal(touchesClue, true);
});
```

- [ ] **Step 2: Run, verify fail** (`_pickBranchEdge` undefined).

- [ ] **Step 3: Implement `_pickBranchEdge(allEdges)`** factoring out + improving the current inline pick:

```js
  // Choose the next unknown edge to branch on: prefer one incident to a vertex
  // that is clued or already has a line (most constrained), falling back to the
  // first unknown. Returns null if none unknown.
  _pickBranchEdge(allEdges) {
    let fallback = null;
    for (const e of allEdges) {
      if (this.getEdge(e) !== 0) continue;
      if (!fallback) fallback = e;
      const eps = this._endpoints(e);
      const constrained = eps.some(v =>
        ShingokiSolver.decodeClue(this.task[v.r]?.[v.c]) ||
        this.incidentEdges(v.r, v.c).some(x => this.getEdge(x) === 1));
      if (constrained) return e;
    }
    return fallback;
  }
```
Replace the inline pick loop in `solve()` (the `let pick=null, fallback=null; for(...)` block) with `const edge = this._pickBranchEdge(allEdges);` and drop the now-dead `pick||fallback` line (keep the `if (!edge) return _isValidComplete()...` leaf check).

- [ ] **Step 4: Run.** `node --test tests/shingoki.test.js` + `node --test tests/shingoki-fuzz.test.js` (green).

- [ ] **Step 5: MEASUREMENT GATE.** `node tests/bench-shingoki.js` — record. **If under target → Task 5. If STILL over budget after this layer: STOP. Report all four recorded times and escalate — CDCL is a separate spec. Do NOT add more.**

- [ ] **Step 6: Gate + commit.**
```
jj commit -m "perf(shingoki): most-constrained-edge branching

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Lock in the win — CI perf test + docs

**Files:** Modify `tests/shingoki.test.js`, `CLAUDE.md`.

- [ ] **Step 1: Add a bounded perf test** to `tests/shingoki.test.js` using the measured final time. Set `BUDGET_MS` to ~2× the measured solve time (headroom for slow CI), but no more than 15000:

```js
test('Shingoki perf: real 40x40 monthly solves within budget', () => {
  const fixtures = require('./fixtures/real-puzzles.js');
  const p = fixtures.shingoki_40x40_monthly;
  const BUDGET_MS = 15000; // tighten to ~2x measured if the bench is well under
  const t0 = Date.now();
  const res = new ShingokiSolver({ rows: p.rows, cols: p.cols, task: p.task, maxMs: BUDGET_MS }).solve();
  const ms = Date.now() - t0;
  assert.equal(res.solved, true, `40x40 should solve (took ${ms}ms)`);
  const chk = new ShingokiSolver({ rows: p.rows, cols: p.cols, task: p.task });
  chk.H = res.horizontal; chk.V = res.vertical;
  assert.equal(chk.numbersSatisfied(), true, 'solution must satisfy all clues');
});
```
Set `BUDGET_MS` from the actual final measurement (e.g. if it solves in 1.5s, set 4000). Document the chosen value in a comment.

- [ ] **Step 2: Run** `node --test tests/shingoki.test.js` — the perf test passes.

- [ ] **Step 3: Docs.** In `src/solvers/shingoki.js` header, add a short note listing which layers shipped and the measured 40×40 time. In `CLAUDE.md`'s Shingoki design-notes bullet, append `(solver: trail-undo + in-search connectivity pruning [+ max-reach / branching as needed] — real 40×40 monthly solves in ~Xs; see the solver-performance spec).` with the real X.

- [ ] **Step 4: Full gate + commit.** `npm run build && npm test && npm run lint && npm run typecheck` all 0.
```
jj commit -m "test+docs(shingoki): CI perf test on real 40x40 + document solver layers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Live verification (INTERACTIVE — user)

- [ ] **Step 1:** User reloads `dist/` (chrome://extensions → ↻) and opens a large Shingoki (e.g. the monthly).
- [ ] **Step 2:** Click **Solve** — confirm it produces the full loop in a few seconds (no timeout), and the page accepts it.
- [ ] **Step 3:** Confirm Hint/Loop still behave (they share the strengthened propagation).
- [ ] **Step 4:** If Solve still times out on some board, capture it via Dump for a follow-up.

---

## Self-Review

**1. Spec coverage:**
- Trail-based undo (spec Layer 1) → Task 1 ✓
- In-search connectivity pruning, premature-subloop + cut-off-clue (spec Layer 2) → Task 2 ✓ (open-endpoint reachability BFS folded into `_deadByConnectivity`'s component scan — it detects a clued vertex unreachable on the closed loop; a separate "cut off behind crosses" BFS is deferred unless the gate shows it's needed, consistent with measure-and-stop)
- Number max-reach (spec Layer 3) → Task 3 ✓
- Smarter branching (spec Layer 4) → Task 4 ✓
- Benchmark fixture + bench + measurement protocol (spec) → Task 0 + the measurement gates in Tasks 1-4 ✓
- CI perf test guards regression (spec) → Task 5 ✓
- Full solve target, no partial fallback (spec) → solve() unchanged on timeout ✓
- CDCL escalation if insufficient (spec) → Task 4 Step 5 stop-and-escalate ✓
- Soundness via fuzz after every task (spec) → every task's Step 5/test step ✓

**2. Placeholder scan:** No TBD/TODO in code steps. The two intentional "fill from measurement" spots — the verbatim task-array paste (Task 0) and `BUDGET_MS` (Task 5) — are data the executor copies/measures, not vague instructions; both have explicit verify steps. The "ONLY IF gate didn't hit target" on Tasks 3/4 is the deliberate measure-and-stop control flow, not a placeholder.

**3. Type consistency:** `_trailMark()`/`_rollbackTo(mark)` (Task 1), `_deadByConnectivity()` (Task 2), `_maxReach(r,c,axis)` (Task 3), `_pickBranchEdge(allEdges)` (Task 4) — names consistent between their definition and their wiring into `solve()`/`_propagate()`. Edge ref shape `{kind:'H'|'V', r, c}` consistent throughout. `setEdge` trail-push uses flat primitives consistent with `_rollbackTo`'s pop order (kind,r,c,prev pushed → prev,c,r,kind popped — LIFO, verified correct).
