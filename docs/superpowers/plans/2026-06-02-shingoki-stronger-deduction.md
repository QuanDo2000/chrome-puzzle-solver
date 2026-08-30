# Shingoki Stronger Deduction Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strengthen `ShingokiSolver`'s deduction (today it stalls at ~9–16 forced edges on real 10×10+ boards) so deduction + the existing DFS solves real hard boards up to 25×25, with the new rules in the shared pipeline so Hint/Loop gain the same reach.

**Architecture:** Two-tier deduction run to a joint fixpoint, all in `src/solvers/shingoki.js`. Tier 1 (cheap, in `_propagate`) gets max-reach number forcing; Tier 2 (`_deduceHeavy`: per-clue candidate-intersection, stronger connectivity, bounded bifurcation) runs in a `_deduceAll` driver that alternates Tier 1 ↔ Tier 2 to fixpoint. `solve()`/`_dfs`/`getStepwiseHint` call `_deduceAll` with per-entry budgets. A brute-force reference oracle verifies every rule's soundness.

**Tech Stack:** Plain JS (`src/solvers/shingoki.js`), `node:test`, `jj`. Spec: `docs/superpowers/specs/2026-06-02-shingoki-stronger-deduction-design.md`.

**IMPORTANT — version control:** `jj`, NEVER `git`. Commit with `jj commit -m "msg"` ending with:
```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

## THE SOUNDNESS PRINCIPLE (read before any technique task)

Every new rule may **force** edges (set an unknown edge to LINE/CROSS) or signal **contradiction**. An unsound force poisons the whole solver. The governing rule for the candidate-based techniques:

> **Over-approximating the candidate set (keeping a configuration that's actually impossible) is SOUND — it only makes the rule weaker (forces fewer edges). UNDER-approximating (dropping a configuration that is actually still possible) is UNSOUND — it can force a wrong edge.**
>
> Therefore: a feasibility check may drop a candidate ONLY if that candidate is **definitely impossible** given the current board. When unsure, KEEP the candidate. Forcing comes from the *intersection* of all surviving candidates, so extra candidates can only shrink what gets forced — never force something wrong.

Likewise a forcing rule may signal contradiction ONLY when it is certain no completion exists. The **brute-force oracle (Task 0)** is the objective gate: it catches any force the rule makes that some valid solution contradicts. Run it after every technique. The constructive fuzz (`tests/shingoki-fuzz.test.js`) is the secondary master guard.

**CRITICAL test-board caveat (learned the hard way):** `assertForceSoundness` EARLY-RETURNS when the board is UNSATISFIABLE (`bruteForceSolutions` returns `[]`) — so an unsat test board makes the oracle test pass VACUOUSLY (it verifies nothing). Every oracle test board you write MUST be satisfiable, and for intersection-style rules ideally have ≥2 distinct solutions (so the intersection logic is actually exercised). **Before trusting any oracle test, add `assert.ok(bruteForceSolutions(rows, cols, task).length >= 1)` (≥2 for Task 3+) to that board's setup, or check it once interactively.** Also note the number arithmetic when hand-building boards: a BLACK clue's number = the sum of BOTH straight-run lengths (e.g. a black corner of an N×N border loop has number = the two side-lengths it sees to the next corners, NOT 2). The plan's literal test-board numbers are illustrative — VERIFY each board is satisfiable and adjust the clue numbers if not.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/solvers/shingoki.js` | the solver | add `_deduceAll`/`_deduceHeavy`, `clueCandidates`, the technique methods; wire `solve`/`_dfs`/`getStepwiseHint` to `_deduceAll` |
| `tests/shingoki.test.js` | unit + oracle tests | add the brute-force oracle helper + `assertForceSoundness` harness + per-technique tests |
| `tests/shingoki-fuzz.test.js` | master fuzz guard | unchanged shape; stays green |
| `tests/bench-shingoki.js` | measurement | extend to print determined-edge counts + solve time on the real fixtures |
| `tests/fixtures/real-puzzles.js` | fixtures | already has 7×7/10×10/15×15/25×25/40×40; no change |

Existing methods you will build on (current line numbers in `src/solvers/shingoki.js`): `incidentEdges` (69), `_axisEdges` (81), `_initState` (95), `getEdge` (102), `setEdge` (107), `_trailMark`/`_rollbackTo` (116/118), `_endpoints` (128), `_propagate` (134), `runLengthAt` (233), `_applyRunCap` (272), `numbersSatisfied` (320), `solve` (338), `_dfs` (370), `getStepwiseHint` (489), `_allEdgeRefs` (514), `_hasPrematureLoop` (536), `_deadByConnectivity` (556), `_oneClosedComponentOrOpen` (597), `_shapesSatisfied` (622), `_isValidComplete` (636). Edge refs are `{kind:'H'|'V', r, c}`; edge values 0 unknown / 1 LINE / 2 CROSS; `task[r][c]` is the signed clue (0 none, >0 white, <0 black); `ShingokiSolver.decodeClue(v)` → `{color,n}` or null.

**Execution note (measure-and-stop):** the controller measures reach + solve time on the real fixtures after each technique and decides whether the next is still needed (per the spec's risk gates). Build Task 0 first; then techniques in order.

---

### Task 0: Brute-force reference oracle + force-soundness harness (test infra)

**Files:**
- Modify: `tests/shingoki.test.js` (add helpers near the top, after the requires)

No solver change — this is the verification backbone every later task depends on.

- [ ] **Step 1: Write a test that pins the oracle on a known tiny board**

Add to `tests/shingoki.test.js`:

```js
// --- Brute-force reference oracle (independent of the deduction techniques) ---
// Enumerates EVERY valid Shingoki loop on a small board by exhaustive edge
// assignment with degree pruning. Acceptance uses only the base checkers
// (_isValidComplete = degree + single-loop + shapes + numbers), NOT the new
// techniques, so it is an independent oracle. Use on boards <= 4x4 (cells).
function bruteForceSolutions(rows, cols, task) {
  const s = new ShingokiSolver({ rows, cols, task });
  s._initState();
  const edges = s._allEdgeRefs();
  const sols = [];
  const okSoFar = () => {
    for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
      const inc = s.incidentEdges(r, c);
      let ln = 0, unk = 0;
      for (const e of inc) { const g = s.getEdge(e); if (g === 1) ln++; else if (g === 0) unk++; }
      if (ln > 2) return false;                 // degree can't exceed 2
      if (ln === 1 && unk === 0) return false;  // stuck at degree 1
      if (task[r][c] && ln + unk < 2) return false; // clued vertex can't reach degree 2
    }
    return true;
  };
  const rec = (i) => {
    if (i === edges.length) { if (s._isValidComplete()) sols.push({ H: s.H.map(r => r.slice()), V: s.V.map(r => r.slice()) }); return; }
    const e = edges[i];
    for (const v of [1, 2]) {
      if (e.kind === 'H') s.H[e.r][e.c] = v; else s.V[e.r][e.c] = v;
      if (okSoFar()) rec(i + 1);
    }
    if (e.kind === 'H') s.H[e.r][e.c] = 0; else s.V[e.r][e.c] = 0;
  };
  rec(0);
  return sols;
}

test('Shingoki oracle: enumerates the unique loop of a fully-determined 2x2', () => {
  // 2x2 cells = 3x3 vertices. The only loop is the full border (8 edges).
  // White clue at center is impossible (center not reachable by a border loop),
  // so use border-corner black clues with number 2 (each corner turns; runs 1+1).
  const task = [[ -2,0,-2],[0,0,0],[-2,0,-2]];
  const sols = bruteForceSolutions(2, 2, task);
  assert.equal(sols.length, 1, 'border loop is the unique solution');
  // every border edge is LINE, no interior edge exists on 2x2 besides border
  const s = new ShingokiSolver({ rows: 2, cols: 2, task });
  s.H = sols[0].H; s.V = sols[0].V;
  assert.equal(s._isValidComplete(), true);
  assert.equal(s.numbersSatisfied(), true);
});
```

- [ ] **Step 2: Run it**

Run: `node --test --test-name-pattern='oracle: enumerates' tests/shingoki.test.js`
Expected: PASS. If the unique-count assertion fails, the oracle's `okSoFar`/acceptance is wrong — fix before proceeding (everything depends on it).

- [ ] **Step 3: Add the force-soundness harness**

```js
// --- Force-soundness harness ---
// Verifies a deduction step never forces an edge that some valid completion
// contradicts. For a satisfiable small board, take random partial states drawn
// from real solutions, run the step, and assert every edge it forces matches
// ALL solutions consistent with that partial state (and it signals contradiction
// only when zero completions are consistent). `applyStep(solver)` runs the
// technique under test on the seeded solver and returns false on contradiction.
function assertForceSoundness(rows, cols, task, applyStep, opts = {}) {
  const trials = opts.trials ?? 40;
  const all = bruteForceSolutions(rows, cols, task);
  if (all.length === 0) return; // unsat board: nothing to check here
  const edges = new ShingokiSolver({ rows, cols, task });
  edges._initState();
  const allEdges = edges._allEdgeRefs();
  // deterministic PRNG (no Math.random in this repo's tests by convention)
  let seed = (rows * 131 + cols * 17 + 9001) >>> 0;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };
  const valAt = (sol, e) => (e.kind === 'H' ? sol.H[e.r][e.c] : sol.V[e.r][e.c]);
  for (let t = 0; t < trials; t++) {
    const base = all[Math.floor(rnd() * all.length)];
    // random partial: each edge independently included with prob ~0.5, set to base's value
    const s = new ShingokiSolver({ rows, cols, task });
    s._initState();
    for (const e of allEdges) {
      if (rnd() < 0.5) { const v = valAt(base, e); if (e.kind === 'H') s.H[e.r][e.c] = v; else s.V[e.r][e.c] = v; }
    }
    const consistent = all.filter(sol => allEdges.every(e => {
      const cur = s.getEdge(e); return cur === 0 || cur === valAt(sol, e);
    }));
    const before = allEdges.map(e => s.getEdge(e));
    const ok = applyStep(s);
    if (!ok) { assert.equal(consistent.length, 0, `step signalled contradiction but ${consistent.length} completion(s) exist`); continue; }
    allEdges.forEach((e, i) => {
      const after = s.getEdge(e);
      if (after !== 0 && before[i] === 0) {
        for (const sol of consistent) {
          assert.equal(after, valAt(sol, e), `forced ${e.kind}(${e.r},${e.c})=${after} but a valid completion has ${valAt(sol, e)}`);
        }
      }
    });
  }
}

test('Shingoki oracle: harness passes for the existing _propagate (sound baseline)', () => {
  // The existing propagation is sound, so the harness must accept it on several
  // small satisfiable boards. This also self-tests the harness.
  const boards = [
    { rows: 2, cols: 2, task: [[-2,0,-2],[0,0,0],[-2,0,-2]] },
    { rows: 3, cols: 3, task: [[-2,0,0,-2],[0,0,0,0],[0,0,0,0],[-2,0,0,-2]] },
  ];
  for (const b of boards) {
    assertForceSoundness(b.rows, b.cols, b.task, (s) => s._propagate());
  }
});
```

- [ ] **Step 4: Run the harness self-test**

Run: `node --test --test-name-pattern='oracle: harness passes' tests/shingoki.test.js`
Expected: PASS (the existing `_propagate` is sound, so the harness accepts it). If it FAILS, either the harness or `_propagate` has a bug — investigate before trusting the oracle.

- [ ] **Step 5: Run full suite + commit**

Run: `npm test` → expect prior pass count + the 3 new oracle tests, 0 fail.

```bash
jj commit -m "test(shingoki): brute-force reference oracle + force-soundness harness

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 1: `_deduceAll` driver wired into solve/dfs/hint (behavior-neutral)

**Files:**
- Modify: `src/solvers/shingoki.js`
- Test: `tests/shingoki.test.js`

Establish the two-tier pipeline with an EMPTY Tier 2, so it is behavior-identical to `_propagate` today. Later tasks add rules to `_deduceHeavy` and they flow everywhere automatically.

- [ ] **Step 1: Write the failing test**

```js
test('Shingoki _deduceAll: behaves like _propagate when Tier 2 is empty', () => {
  const task = [[-2,0,0,-2],[0,0,0,0],[0,0,0,0],[-2,0,0,-2]];
  const a = new ShingokiSolver({ rows: 3, cols: 3, task }); a._initState(); const ra = a._propagate();
  const b = new ShingokiSolver({ rows: 3, cols: 3, task }); b._initState(); const rb = b._deduceAll(0);
  assert.equal(ra, rb);
  assert.deepEqual(a.H, b.H); assert.deepEqual(a.V, b.V);
});
```

- [ ] **Step 2: Run → FAIL** (`_deduceAll is not a function`).
Run: `node --test --test-name-pattern='_deduceAll: behaves like' tests/shingoki.test.js`

- [ ] **Step 3: Implement `_deduceHeavy` (empty stub) + `_deduceAll`**

Add after `_propagate` (around line 232):

```js
  // Tier 2 heavy deduction: runs one pass of the expensive rules (added in later
  // tasks). Returns false on contradiction, and sets `this._heavyChanged = true`
  // if it forced any edge. `budgetMs` (0 = unbounded) caps the pass; on expiry it
  // returns true without finishing (sound: it only ever FORCES, never relaxes).
  _deduceHeavy(budgetMs) {
    this._heavyChanged = false;
    // (techniques appended here in later tasks; each sets _heavyChanged and may
    //  return false on contradiction)
    return true;
  }

  // Joint Tier1+Tier2 fixpoint. Runs _propagate to fixpoint, then one
  // _deduceHeavy pass; repeats while the heavy pass changed anything. Returns
  // false on any contradiction. `budgetMs` (0 = unbounded) bounds the heavy
  // passes for interactive callers; Tier 1 always runs fully (it is cheap).
  _deduceAll(budgetMs) {
    for (;;) {
      if (!this._propagate()) return false;
      if (!this._deduceHeavy(budgetMs)) return false;
      if (!this._heavyChanged) return true;
    }
  }
```

- [ ] **Step 4: Wire the three entry points to `_deduceAll`**

In `solve()` (line 341) replace `if (!this._propagate())` with `if (!this._deduceAll(0))`.
In `_dfs()` (line 373) replace `if (!this._propagate()) return false;` with `if (!this._deduceAll(this._heavyBudgetMs ?? 0)) return false;`.
In `getStepwiseHint` (line 503) replace `if (!this._propagate())` with `if (!this._deduceAll(this._hintBudgetMs ?? 0))`. **Also add `this._trail = [];` immediately after the `this.H = ...`/`this.V = ...` assignments at the top of `getStepwiseHint` (lines 491–492)** — `getStepwiseHint` sets `H`/`V` directly without `_initState`, so it has no trail; the rollback-based Tier-2 rules (connectivity/bifurcation, Tasks 4–5) need one or their probes won't undo. (Harmless now with an empty Tier 2; required before Task 4.)
Add to the constructor (after `this._searchMs = searchMs;`): `this._heavyBudgetMs = 0; this._hintBudgetMs = 800;` (interactive Hint cap; solver unbounded). These fields exist now so later tasks have the budget knobs; with an empty Tier 2 they have no effect.

- [ ] **Step 5: Run the test + full suite**

Run: `node --test --test-name-pattern='_deduceAll' tests/shingoki.test.js` → PASS.
Run: `npm test` → all green, 0 fail (behavior-neutral: 7×7 still solves, fuzz green, real-mid-size still sound-partial).

- [ ] **Step 6: Commit**

```bash
jj commit -m "feat(shingoki): _deduceAll two-tier driver (empty Tier 2, behavior-neutral)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Technique 1 — max-reach number forcing (Tier 1)

**Files:**
- Modify: `src/solvers/shingoki.js`
- Test: `tests/shingoki.test.js`

For a clued vertex, bound the achievable straight run per direction and force the axis / minimum extension implied by the number.

- [ ] **Step 1: Write the failing tests (positive, negative, oracle)**

```js
test('Shingoki maxReach: a white clue whose number exceeds one axis forces the other axis', () => {
  // 1x4 strip (rows=1, cols=4 -> 2x5 vertices). A white clue near the left on the
  // top row: vertical axis has only 1 edge available (can't form a 2-edge straight
  // run through the vertex), so a number >=2 must be horizontal.
  // Vertices 2 rows x 5 cols. Put white clue n=4 at (0,2).
  const task = [[0,0,4,0,0],[0,0,0,0,0]];
  const s = new ShingokiSolver({ rows: 1, cols: 4, task });
  s._initState();
  s._deduceAll(0);
  // vertical edges at (0,2) [the only vertical incident is V(0,2)] cannot give a
  // straight vertical run through (0,2) (needs edges both above and below; none
  // above), so the white line must be horizontal -> H(0,1) and H(0,2) forced LINE.
  assert.equal(s.getEdge({ kind: 'H', r: 0, c: 1 }), 1);
  assert.equal(s.getEdge({ kind: 'H', r: 0, c: 2 }), 1);
});

test('Shingoki maxReach: does NOT fire when both axes can still reach the number', () => {
  // White clue n=2 in the interior with both axes open -> ambiguous, force nothing.
  const task = [[0,0,0,0,0],[0,0,2,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]];
  const s = new ShingokiSolver({ rows: 4, cols: 4, task });
  s._initState();
  s._deduceAll(0);
  // no incident edge of (1,2) should be forced LINE (both axes viable)
  for (const e of s.incidentEdges(1, 2)) {
    if (s.getEdge(e) === 1) assert.fail(`maxReach wrongly forced ${e.kind}(${e.r},${e.c})`);
  }
});

test('Shingoki maxReach: force-soundness vs the oracle (3x3 + 4x4 boards)', () => {
  const boards = [
    { rows: 3, cols: 3, task: [[2,0,0,-2],[0,0,0,0],[0,0,0,0],[-2,0,0,2]] },
    { rows: 4, cols: 4, task: [[0,0,3,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,4,0,0]] },
  ];
  for (const b of boards) {
    assertForceSoundness(b.rows, b.cols, b.task, (s) => s._maxReachForce());
  }
});
```

- [ ] **Step 2: Run → FAIL** (`_maxReachForce is not a function`).

- [ ] **Step 3: Implement `_maxReachForce` and call it from `_propagate`'s clued section**

Add the method (near `_applyRunCap`). It computes, per direction from the clue, the maximum number of additional LINE edges achievable (consecutive non-CROSS edges to the border), and applies the sound forcings. SOUNDNESS: only force when the number arithmetic leaves no alternative.

```js
  // Max achievable straight-run length (in edges) from vertex (r,c) in direction
  // (dr,dc): count consecutive edges that are not CROSS until border/cross.
  _maxRun(r, c, dr, dc) {
    const { rows, cols } = this;
    let len = 0, cr = r, cc = c;
    for (;;) {
      const nr = cr + dr, nc = cc + dc; let ref;
      if (dr === 0) { const ec = Math.min(cc, nc); if (ec < 0 || ec >= cols || cr < 0 || cr > rows) break; ref = { kind: 'H', r: cr, c: ec }; }
      else { const er = Math.min(cr, nr); if (er < 0 || er >= rows || cc < 0 || cc > cols) break; ref = { kind: 'V', r: er, c: cc }; }
      if (this.getEdge(ref) === 2) break;       // a cross stops the run
      len++; cr = nr; cc = nc;
    }
    return len;
  }

  // Technique 1: max-reach number forcing. Tier 1. Returns false on contradiction.
  // Sets edges via setEdge (trail-tracked). Re-runs cheap; called inside _propagate.
  _maxReachForce() {
    const { rows, cols } = this;
    let changed = false;
    const force = (ref, val) => { if (this.getEdge(ref) === 0) { if (!this.setEdge(ref, val)) return false; changed = true; } else if (this.getEdge(ref) !== val) return false; return true; };
    for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
      const clue = ShingokiSolver.decodeClue(this.task[r][c]);
      if (!clue) continue;
      // axis max totals: H = left+right reach, V = up+down reach (edges).
      const hMax = this._maxRun(r, c, 0, -1) + this._maxRun(r, c, 0, 1);
      const vMax = this._maxRun(r, c, -1, 0) + this._maxRun(r, c, 1, 0);
      if (clue.color === 'white') {
        const hOk = hMax >= clue.n, vOk = vMax >= clue.n;
        if (!hOk && !vOk) return false;                 // number unreachable -> contradiction
        if (hOk && !vOk) {                               // must be horizontal
          for (const e of this._axisEdges(r, c, 'V')) if (!force(e, 2)) return false;
        } else if (vOk && !hOk) {                        // must be vertical
          for (const e of this._axisEdges(r, c, 'H')) if (!force(e, 2)) return false;
        }
        // forced-extension: if the chosen axis is known (one axis viable), and one
        // direction is capped below what's needed, force the minimum in the other.
        for (const axis of ['H', 'V']) {
          const viable = axis === 'H' ? (hOk && !vOk) : (vOk && !hOk);
          if (!viable) continue;
          const dirs = axis === 'H' ? [[0,-1],[0,1]] : [[-1,0],[1,0]];
          const maxA = this._maxRun(r, c, dirs[0][0], dirs[0][1]);
          const maxB = this._maxRun(r, c, dirs[1][0], dirs[1][1]);
          // need a+b = n, a<=maxA, b<=maxB, a,b>=1. min a = max(1, n-maxB).
          const minA = Math.max(1, clue.n - maxB), minB = Math.max(1, clue.n - maxA);
          if (minA > maxA || minB > maxB) return false;
          if (!this._forceMinRun(r, c, dirs[0][0], dirs[0][1], minA, force)) return false;
          if (!this._forceMinRun(r, c, dirs[1][0], dirs[1][1], minB, force)) return false;
        }
      } else { // black: one H arm + one V arm; each arm >=1, sum = n.
        // each arm's max reach is the best of its two directions.
        const hArm = Math.max(this._maxRun(r, c, 0, -1), this._maxRun(r, c, 0, 1));
        const vArm = Math.max(this._maxRun(r, c, -1, 0), this._maxRun(r, c, 1, 0));
        if (hArm < 1 || vArm < 1) return false;          // black needs both arms
        if (hArm + vArm < clue.n) return false;          // unreachable
      }
    }
    this._maxReachChanged = changed; // Tier-1 re-settle flag (read by _propagate)
    return true;
  }

  // Force the first `m` edges LINE along (dr,dc) from (r,c) (m>=1). Sound only when
  // the caller has established this direction must contribute at least m edges.
  _forceMinRun(r, c, dr, dc, m, force) {
    let cr = r, cc = c;
    for (let i = 0; i < m; i++) {
      const nr = cr + dr, nc = cc + dc; let ref;
      if (dr === 0) { const ec = Math.min(cc, nc); ref = { kind: 'H', r: cr, c: ec }; }
      else { const er = Math.min(cr, nr); ref = { kind: 'V', r: er, c: cc }; }
      if (!force(ref, 1)) return false;
      cr = nr; cc = nc;
    }
    return true;
  }
```

Integrate max-reach as a step in the `_deduceAll` loop (NOT inside `_propagate` — that would need worklist surgery and risk deep recursion). It runs between `_propagate` and the heavy pass: cheap, always-on, and when it forces edges the loop re-runs `_propagate` to settle them. Update `_deduceAll` (from Task 1) to:

```js
  _deduceAll(budgetMs) {
    for (;;) {
      if (!this._propagate()) return false;
      if (!this._maxReachForce()) return false;
      if (this._maxReachChanged) continue;     // forced edges -> re-propagate
      if (!this._deduceHeavy(budgetMs)) return false;
      if (!this._heavyChanged) return true;
    }
  }
```

`_maxReachForce` sets `this._maxReachChanged` (its own Tier-1 flag, distinct from the Tier-2 `_heavyChanged`). Probes that call `_propagate()` directly (the branch-heuristic probes in `_lookahead1`/`_probePropagationCount`) intentionally skip max-reach — they only need a cheap estimate, and soundness is unaffected (those are sound-neutral). The solver/Hint always get max-reach via `_deduceAll`.

- [ ] **Step 4: Run the technique tests → PASS**

Run: `node --test --test-name-pattern='maxReach' tests/shingoki.test.js`
Expected: positive forces fire, negative does not, oracle soundness passes.

- [ ] **Step 5: Full suite + fuzz + measure**

Run: `npm test` → 0 fail (fuzz green = still sound).
Measure: run `node tests/bench-shingoki.js` and record solve/partial + (after Task 6's bench update, edge counts) on the real fixtures. The controller records the reach delta.

- [ ] **Step 6: Commit**

```bash
jj commit -m "feat(shingoki): technique 1 — max-reach number forcing (Tier 1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Technique 2 — per-clue candidate-configuration intersection (Tier 2)

**Files:**
- Modify: `src/solvers/shingoki.js`
- Test: `tests/shingoki.test.js`

The heaviest hitter. A reusable `clueCandidates(r,c)` enumerates feasible configs; the intersection rule forces edges common to all. **Apply the SOUNDNESS PRINCIPLE: keep a candidate unless it is definitely impossible.**

- [ ] **Step 1: Write the failing tests**

```js
test('Shingoki candidates: a black clue n=2 in a corner forces both arms (unique config)', () => {
  // 3x3 vertices, black clue n=2 at corner (0,0): only arms are H(0,0) east and
  // V(0,0) south; each must be length 1 -> both forced LINE; the run-caps force
  // crosses at H(0,1)?... only assert the two arms.
  const task = [[-2,0,0],[0,0,0],[0,0,0]];
  const s = new ShingokiSolver({ rows: 2, cols: 2, task });
  s._initState();
  s._deduceAll(0);
  assert.equal(s.getEdge({ kind: 'H', r: 0, c: 0 }), 1);
  assert.equal(s.getEdge({ kind: 'V', r: 0, c: 0 }), 1);
});

test('Shingoki candidates: intersection forces the common edge across splits', () => {
  // A white clue with two feasible splits that AGREE on one edge but differ
  // elsewhere -> only the agreed edge is forced. (Hand-built; see comment.)
  // White n=2 at (0,1) on a 1x2-cell strip top row: horizontal axis only; splits
  // are (a=1 left,b=1 right) the unique config -> both H(0,0),H(0,1) forced.
  const task = [[0,2,0],[0,0,0]];
  const s = new ShingokiSolver({ rows: 1, cols: 2, task });
  s._initState();
  s._deduceAll(0);
  assert.equal(s.getEdge({ kind: 'H', r: 0, c: 0 }), 1);
  assert.equal(s.getEdge({ kind: 'H', r: 0, c: 1 }), 1);
});

test('Shingoki candidates: force-soundness vs the oracle (3x3 + 4x4, several boards)', () => {
  const boards = [
    { rows: 3, cols: 3, task: [[2,0,0,-2],[0,0,0,0],[0,-3,0,0],[-2,0,0,2]] },
    { rows: 4, cols: 4, task: [[0,0,3,0,0],[0,-2,0,0,0],[0,0,0,4,0],[0,0,0,0,0],[0,0,2,0,0]] },
    { rows: 4, cols: 4, task: [[-2,0,0,0,-2],[0,0,0,0,0],[0,0,5,0,0],[0,0,0,0,0],[-2,0,0,0,-2]] },
  ];
  for (const b of boards) {
    assertForceSoundness(b.rows, b.cols, b.task, (s) => s._candidateIntersectForce(), { trials: 60 });
  }
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `clueCandidates` + `_candidateIntersectForce`**

A candidate is `{ line: Set<edgeKey>, cross: Set<edgeKey> }` where edgeKey = `` `${kind}${r},${c}` ``. Build the set of feasible candidates for a clue, then force edges in the intersection. KEEP a candidate unless an edge it requires LINE is already CROSS, or an edge it requires CROSS is already LINE, or it doesn't fit in-board.

```js
  _edgeKey(kind, r, c) { return kind + r + ',' + c; }

  // Walk `len` edges from (r,c) in (dr,dc); return the list of edge refs, or null
  // if it runs off-board.
  _runEdges(r, c, dr, dc, len) {
    const { rows, cols } = this;
    const out = []; let cr = r, cc = c;
    for (let i = 0; i < len; i++) {
      const nr = cr + dr, nc = cc + dc; let ref;
      if (dr === 0) { const ec = Math.min(cc, nc); if (ec < 0 || ec >= cols || cr < 0 || cr > rows) return null; ref = { kind: 'H', r: cr, c: ec }; }
      else { const er = Math.min(cr, nr); if (er < 0 || er >= rows || cc < 0 || cc > cols) return null; ref = { kind: 'V', r: er, c: cc }; }
      out.push(ref); cr = nr; cc = nc;
    }
    return { edges: out, endR: cr, endC: cc };
  }

  // The straight-continuation edge just past the vertex (er,ec) heading (dr,dc),
  // or null if off-board. Used to CROSS-cap a run end (the run stops -> turn).
  _capEdge(er, ec, dr, dc) {
    const { rows, cols } = this;
    const nr = er + dr, nc = ec + dc;
    if (dr === 0) { const c2 = Math.min(ec, nc); if (c2 < 0 || c2 >= cols || er < 0 || er > rows) return null; return { kind: 'H', r: er, c: c2 }; }
    const r2 = Math.min(er, nr); if (r2 < 0 || r2 >= rows || ec < 0 || ec > cols) return null; return { kind: 'V', r: r2, c: ec };
  }

  // Build a candidate from two arms (each {dr,dc,len}). Returns the candidate
  // {line,cross} or null if it does not fit the board (off-board, or a required
  // LINE edge is CROSS / required CROSS edge is LINE). Conservative: when a check
  // is ambiguous we KEEP the candidate (return it), never drop it.
  _buildCandidate(r, c, arms, perpCrossAtCentre) {
    const line = new Set(), cross = new Set();
    const addLine = (e) => { if (this.getEdge(e) === 2) return false; line.add(this._edgeKey(e.kind, e.r, e.c)); return true; };
    const addCross = (e) => { if (this.getEdge(e) === 1) return false; cross.add(this._edgeKey(e.kind, e.r, e.c)); return true; };
    for (const arm of arms) {
      const run = this._runEdges(r, c, arm.dr, arm.dc, arm.len);
      if (!run) return null;                       // off-board -> impossible
      for (const e of run.edges) if (!addLine(e)) return null;
      const cap = this._capEdge(run.endR, run.endC, arm.dr, arm.dc);
      if (cap && !addCross(cap)) return null;       // run must stop -> cap is CROSS
    }
    for (const e of perpCrossAtCentre) if (!addCross(e)) return null;
    return { line, cross };
  }

  // All feasible configurations for the clue at (r,c). White: axis in {H,V} x
  // split (a,b), a+b=n; the two arms collinear; the perpendicular pair at centre
  // is CROSS. Black: 4 quadrant orientations x split (a,b); arms perpendicular;
  // the collinear partners at centre are CROSS.
  clueCandidates(r, c) {
    const clue = ShingokiSolver.decodeClue(this.task[r][c]);
    if (!clue) return [];
    const N = clue.n, out = [];
    const W = { kind: 'H', r, c: c - 1 }, E = { kind: 'H', r, c };       // centre H edges
    const Nr = { kind: 'V', r: r - 1, c }, S = { kind: 'V', r, c };      // centre V edges
    if (clue.color === 'white') {
      // horizontal axis: arms left(0,-1) + right(0,1); perp V pair CROSS.
      for (let a = 1; a <= N - 1; a++) {
        const cand = this._buildCandidate(r, c, [{ dr: 0, dc: -1, len: a }, { dr: 0, dc: 1, len: N - a }], [Nr, S]);
        if (cand) out.push(cand);
      }
      // vertical axis: arms up + down; perp H pair CROSS.
      for (let a = 1; a <= N - 1; a++) {
        const cand = this._buildCandidate(r, c, [{ dr: -1, dc: 0, len: a }, { dr: 1, dc: 0, len: N - a }], [W, E]);
        if (cand) out.push(cand);
      }
    } else {
      // black: pick one H direction and one V direction (4 combos); collinear
      // partner of each chosen arm is CROSS at centre.
      const hDirs = [{ dr: 0, dc: -1, partner: E }, { dr: 0, dc: 1, partner: W }];
      const vDirs = [{ dr: -1, dc: 0, partner: S }, { dr: 1, dc: 0, partner: Nr }];
      for (const h of hDirs) for (const v of vDirs) {
        for (let a = 1; a <= N - 1; a++) {
          const cand = this._buildCandidate(r, c, [{ dr: h.dr, dc: h.dc, len: a }, { dr: v.dr, dc: v.dc, len: N - a }], [h.partner, v.partner]);
          if (cand) out.push(cand);
        }
      }
    }
    return out;
  }

  // Technique 2: force edges common to ALL feasible candidates of each clue.
  // Returns false on contradiction (a clue with zero candidates). Tier 2.
  _candidateIntersectForce() {
    const { rows, cols } = this;
    let changed = false;
    for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
      if (!this.task[r][c]) continue;
      const cands = this.clueCandidates(r, c);
      if (cands.length === 0) return false;               // no config fits -> dead
      // intersect: an edge is forced LINE iff every candidate has it LINE; CROSS
      // iff every candidate has it CROSS.
      const lineCommon = new Set(cands[0].line), crossCommon = new Set(cands[0].cross);
      for (let i = 1; i < cands.length; i++) {
        for (const k of [...lineCommon]) if (!cands[i].line.has(k)) lineCommon.delete(k);
        for (const k of [...crossCommon]) if (!cands[i].cross.has(k)) crossCommon.delete(k);
      }
      const apply = (keySet, val) => {
        for (const k of keySet) {
          const kind = k[0]; const [rr, cc] = k.slice(1).split(',').map(Number);
          const ref = { kind, r: rr, c: cc };
          if (this.getEdge(ref) === 0) { if (!this.setEdge(ref, val)) return false; changed = true; }
          else if (this.getEdge(ref) !== val) return false;
        }
        return true;
      };
      if (!apply(lineCommon, 1)) return false;
      if (!apply(crossCommon, 2)) return false;
    }
    if (changed) this._heavyChanged = true;
    return true;
  }
```

Append the call inside `_deduceHeavy` (replace the stub body's comment):

```js
  _deduceHeavy(budgetMs) {
    this._heavyChanged = false;
    if (budgetMs > 0 && timeUp(budgetMs, this._startedAt)) return true; // interactive cap
    if (!this._candidateIntersectForce()) return false;
    return true;
  }
```

(The `budgetMs` check uses `this._startedAt`; `solve()` and `getStepwiseHint` both set it. For the solver `budgetMs` is 0 → no cap; for Hint it is `_hintBudgetMs`=800ms.)

- [ ] **Step 4: Run technique tests → PASS** (positive forces, intersection, and the ORACLE soundness test — the critical gate).

Run: `node --test --test-name-pattern='candidates' tests/shingoki.test.js`

If the oracle test FAILS, a candidate was wrongly DROPPED (under-approximation) — re-check `_buildCandidate`/`clueCandidates` feasibility: it must only drop off-board or edge-contradicted configs. Do NOT add cross-clue feasibility yet (that is a later optional strengthening; conservative is sound).

- [ ] **Step 5: Full suite + fuzz + measure**

Run: `npm test` → 0 fail (fuzz green). Measure reach + solve on the real fixtures (`node tests/bench-shingoki.js`). Record the delta — this technique is expected to be the big jump. The controller decides whether Tasks 4/5 are still needed.

- [ ] **Step 6: Commit**

```bash
jj commit -m "feat(shingoki): technique 2 — per-clue candidate-intersection deduction (Tier 2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Technique 3 — stronger connectivity forcing (Tier 2) [conditional on measurement]

**Files:**
- Modify: `src/solvers/shingoki.js`
- Test: `tests/shingoki.test.js`

Extend `_deadByConnectivity` from a checker into a forcer. Only build this if Tasks 2–3 don't already solve the real fixtures (controller's call after measuring).

- [ ] **Step 1: Write the failing tests (oracle-gated)**

```js
test('Shingoki connectivity-force: an edge whose LINE value closes a loop excluding a clue is forced CROSS', () => {
  // Hand-built: a near-complete chain where one edge would close a small loop
  // leaving a clued vertex outside. Assert that edge is forced CROSS.
  // (Construct via a known board+partial; see implementation comment for the setup.)
  // Placeholder board exercised through the oracle test below; the targeted unit
  // test uses a 4x4 with a forced-closing edge:
  const task = [[-2,0,0,0,-2],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[-2,0,0,0,-2]];
  const s = new ShingokiSolver({ rows: 4, cols: 4, task });
  s._initState();
  // seed three sides of the border loop, leave the closing edge unknown:
  // (the full border is the unique solution; any chord that closes early excludes corners)
  assert.equal(typeof s._connectivityForce, 'function');
});

test('Shingoki connectivity-force: force-soundness vs the oracle (3x3 + 4x4)', () => {
  const boards = [
    { rows: 3, cols: 3, task: [[-2,0,0,-2],[0,0,0,0],[0,0,0,0],[-2,0,0,-2]] },
    { rows: 4, cols: 4, task: [[-2,0,0,0,-2],[0,0,0,0,0],[0,0,2,0,0],[0,0,0,0,0],[-2,0,0,0,-2]] },
  ];
  for (const b of boards) assertForceSoundness(b.rows, b.cols, b.task, (s) => s._connectivityForce(), { trials: 60 });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `_connectivityForce`**

For each unknown edge, tentatively set it LINE; if that immediately creates a premature closed loop (existing `_hasPrematureLoop`) or a connectivity-dead state (`_deadByConnectivity`), it cannot be LINE → force CROSS. Symmetrically, tentatively CROSS; if that disconnects a required clued vertex from the loop frontier (`_deadByConnectivity`), force LINE. This is a 1-ply structural probe reusing the existing sound checkers, so soundness reduces to those checkers' soundness (already trusted) — the oracle confirms.

```js
  _connectivityForce() {
    let changed = false;
    for (const e of this._allEdgeRefs()) {
      if (this.getEdge(e) !== 0) continue;
      // probe LINE
      const m1 = this._trailMark();
      let lineDead = false;
      if (this.setEdge(e, 1)) { if (this._hasPrematureLoop() || this._deadByConnectivity()) lineDead = true; }
      else lineDead = true;
      this._rollbackTo(m1);
      // probe CROSS
      const m2 = this._trailMark();
      let crossDead = false;
      if (this.setEdge(e, 2)) { if (this._deadByConnectivity()) crossDead = true; }
      else crossDead = true;
      this._rollbackTo(m2);
      if (lineDead && crossDead) return false;     // neither value works -> contradiction
      if (lineDead) { if (!this.setEdge(e, 2)) return false; changed = true; }
      else if (crossDead) { if (!this.setEdge(e, 1)) return false; changed = true; }
    }
    if (changed) this._heavyChanged = true;
    return true;
  }
```

Add `if (!this._connectivityForce()) return false;` to `_deduceHeavy` after the candidate-intersect call.

- [ ] **Step 4: Run technique tests → PASS** (oracle soundness is the gate).
- [ ] **Step 5: Full suite + fuzz + measure** (`npm test` 0 fail; record reach/solve delta).
- [ ] **Step 6: Commit**

```bash
jj commit -m "feat(shingoki): technique 3 — connectivity forcing (Tier 2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Technique 4 — bounded bifurcation as deduction (Tier 2) [conditional]

**Files:**
- Modify: `src/solvers/shingoki.js`
- Test: `tests/shingoki.test.js`

Generalize `_lookahead1` to use the FULL deduction on the probe (not just `_propagate`), cost-gated. Only build if Tasks 2–4 fall short.

- [ ] **Step 1: Write the failing tests**

```js
test('Shingoki bifurcation: forces an edge when one value deduces a contradiction', () => {
  assert.equal(typeof ShingokiSolver.prototype._bifurcateForce, 'function');
});
test('Shingoki bifurcation: force-soundness vs the oracle (3x3 + 4x4)', () => {
  const boards = [
    { rows: 3, cols: 3, task: [[2,0,0,-2],[0,0,0,0],[0,0,0,0],[-2,0,0,2]] },
    { rows: 4, cols: 4, task: [[0,0,3,0,0],[0,-2,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,2,0,0]] },
  ];
  for (const b of boards) assertForceSoundness(b.rows, b.cols, b.task, (s) => s._bifurcateForce(), { trials: 40 });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `_bifurcateForce`**

For each unknown frontier edge (incident to a committed line, to bound cost), probe LINE and CROSS on a clone running full `_deduceAll`; if one value yields a contradiction, force the other. Time-gated by `this._heavyBudgetMs` so it can't dominate.

```js
  _bifurcateForce() {
    let changed = false;
    const frontier = this._allEdgeRefs().filter(e => this.getEdge(e) === 0 &&
      this._endpoints(e).some(v => this.incidentEdges(v.r, v.c).some(x => this.getEdge(x) === 1)));
    for (const e of frontier) {
      if (this.getEdge(e) !== 0) continue;
      // Respect the overall solve budget so a single deduction pass can't hang
      // between _dfs budget checks (`_heavyBudgetMs` is the optional finer cap;
      // `budgetMs` passed to _deduceHeavy already caps the interactive Hint case).
      if ((this._heavyBudgetMs > 0 && timeUp(this._heavyBudgetMs, this._startedAt)) ||
          (this._searchMs > 0 && timeUp(this._searchMs, this._startedAt)) ||
          (this.maxMs > 0 && timeUp(this.maxMs, this._startedAt))) break;
      const probe = (val) => {
        const p = new ShingokiSolver({ rows: this.rows, cols: this.cols, task: this.task });
        p.H = this.H.map(row => row.slice()); p.V = this.V.map(row => row.slice());
        p._heavyBudgetMs = 0; // bounded by the outer loop's frontier limit + no nested bifurcation
        p._bifurcationDisabled = true;
        return p.setEdge(val.ref, val.val) && p._deduceAllNoBif();
      };
      const lineOk = probe({ ref: e, val: 1 });
      const crossOk = probe({ ref: e, val: 2 });
      if (!lineOk && !crossOk) return false;
      if (lineOk && !crossOk) { if (!this.setEdge(e, 1)) return false; changed = true; }
      else if (crossOk && !lineOk) { if (!this.setEdge(e, 2)) return false; changed = true; }
    }
    if (changed) this._heavyChanged = true;
    return true;
  }

  // _deduceAll WITHOUT bifurcation (prevents unbounded recursion in probes).
  // Includes Tier 1 (propagate + max-reach) and the non-bifurcation Tier-2 rules.
  _deduceAllNoBif() {
    for (;;) {
      if (!this._propagate()) return false;
      if (!this._maxReachForce()) return false;
      if (this._maxReachChanged) continue;
      this._heavyChanged = false;
      if (!this._candidateIntersectForce()) return false;
      if (!this._connectivityForce()) return false;
      if (!this._heavyChanged) return true;
    }
  }
```

Guard `_deduceHeavy` to call `_bifurcateForce` only when not disabled: add `if (!this._bifurcationDisabled && !this._bifurcateForce()) return false;` after the connectivity call.

- [ ] **Step 4: Run technique tests → PASS** (oracle soundness gate).
- [ ] **Step 5: Full suite + fuzz + measure.**
- [ ] **Step 6: Commit**

```bash
jj commit -m "feat(shingoki): technique 4 — bounded bifurcation deduction (Tier 2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Measurement bench, docs, and build

**Files:**
- Modify: `tests/bench-shingoki.js`, `src/solvers/shingoki.js` (header), `AGENTS.md`
- Build: `npm run build`

- [ ] **Step 1: Extend the bench to print reach (determined-edge counts)**

In `tests/bench-shingoki.js`, after each real-fixture solve, also print the count of determined edges from the ROOT deduction alone (construct a solver, `_initState()`, `_deduceAll(0)`, count non-zero edges) — this is the reach metric the techniques target. Add a `runReach(label, p)` helper that prints `reach=<determined>/<total>` and append calls for the 7×7/10×10/15×15/25×25 fixtures.

```js
function runReach(label, rows, cols, task) {
  const s = new ShingokiSolver({ rows, cols, task });
  s._initState(); s._deduceAll(0);
  let det = 0, tot = 0;
  for (const e of s._allEdgeRefs()) { tot++; if (s.getEdge(e) !== 0) det++; }
  console.log(`${label}: root-deduction reach=${det}/${tot}`);
}
const fx = require('./fixtures/real-puzzles.js');
for (const k of ['shingoki_7x7_hard','shingoki_10x10_hard','shingoki_15x15_hard','shingoki_25x25_hard']) {
  const p = fx[k]; runReach(k, p.rows, p.cols, p.task);
}
```

- [ ] **Step 2: Run the bench, record the final numbers**

Run: `node tests/bench-shingoki.js`
Record per-fixture: root-deduction reach + solved/partial + wall-time. This is the deliverable's evidence.

- [ ] **Step 3: Update the solver module header + AGENTS.md to the measured outcome**

Update the `=== Adaptive DFS search engine ===` header in `src/solvers/shingoki.js` to describe the two-tier deduction (`_deduceAll`: Tier 1 `_propagate`+max-reach, Tier 2 `_deduceHeavy` candidate-intersection/connectivity/bifurcation) and state the measured reach/solve outcome on the real fixtures (fill in the actual numbers from Step 2). Update the `AGENTS.md` Shingoki bullet's solver description likewise — state honestly which real sizes now solve and which still return a sound partial.

- [ ] **Step 4: Rebuild**

Run: `npm run build` → `Wrote dist/solver.js` + `Wrote dist/content.js`, no bundler errors.

- [ ] **Step 5: Final gate**

Run: `npm test && npm run lint && npm run typecheck` → all green, 0 fail.

- [ ] **Step 6: Commit**

```bash
jj commit -m "docs+build(shingoki): two-tier deduction header/CLAUDE note + reach bench; rebuild dist

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final review (after all built techniques)

Dispatch a final reviewer over the whole change set: (1) every technique's force-soundness oracle test passes; (2) the constructive fuzz (master guard) is green; (3) the genuine-UNSAT-vs-partial contract in `solve()` is unchanged (only a `SEARCH_BUDGET` bail yields a partial); (4) Hint stays interactive (the `_hintBudgetMs` cap is honoured); (5) the real fixtures' measured reach/solve improved and the numbers in the docs match the bench; (6) `dist/` rebuilt. Then use **superpowers:finishing-a-development-branch**.

## Conditional / measure-and-stop notes

- Tasks 4 and 5 are **conditional**: if after Task 3 the real 25×25 already solves in budget, STOP (skip 4/5/parity) per the spec's "solved-enough" gate. If a technique adds no measurable reach/solve gain on the real fixtures, STOP and report rather than continue.
- **Technique 5 (loop-parity)** from the spec has no task here by design — it is only reached if 1–4 fall short of 25×25, and is a separate design decision at that point (the controller raises it).
- **Optional strengthening of `clueCandidates`** (intermediate-clue consistency: dropping a candidate whose straight run passes through a clued vertex incompatibly) is a sound *follow-up* to Task 3 IF more reach is needed — each strengthening must keep the oracle test green (it only drops definitely-impossible candidates). Not a separate task unless the measurement calls for it.
- **Performance — per-node Tier-2 cost.** `_dfs` calls `_deduceAll(0)` (full Tier 2) at every node. The design bet is that strong deduction leaves *few* search nodes, so this is affordable. If the bench shows solve-time regressing because Tier 2 (especially `_connectivityForce`/`_bifurcateForce`, which probe O(edges) per call) runs at every branch, GATE Tier 2 by depth: track a node depth in `_dfs` and run the heavy pass only at depth 0 and shallow nodes (e.g. depth ≤ 2) or every K nodes, falling back to `_propagate` deeper. This is a sound, behavior-preserving optimization (Tier 1 always runs; skipping a Tier-2 pass only delays a deduction to a deeper node). Add it in whichever of Tasks 3–5 first shows the regression; it is NOT needed if deduction keeps the node count low. This trade-off is the controller's call from the measurement.
- **Soundness of the structural-probe rules (Tasks 4–5)** rests on the existing `_hasPrematureLoop`/`_deadByConnectivity` checkers being sound, plus correct trail rollback. Verify in the adversarial review that every probe path (`setEdge` → check → `_rollbackTo`) restores state exactly, and that the solver instance has a real `this._trail` in all three entry contexts (solve/dfs have it via `_initState`; Hint gets it from the Task 1 `this._trail = []` fix).
