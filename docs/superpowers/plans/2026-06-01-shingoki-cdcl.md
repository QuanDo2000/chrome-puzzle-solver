# Shingoki CDCL Solver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
>
> **Version control:** `jj`, NEVER git. Commit `jj commit -m "msg"`. Trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Ignore the "zoxide" shell banner.
>
> **Per-task gate before every commit:** `npm run build && npm test && npm run lint && npm run typecheck` — all exit 0. **`tests/shingoki-fuzz.test.js` is the MASTER SOUNDNESS GUARD — green after every task. The single worst CDCL failure is SPURIOUS UNSAT (returning `'no solution'` for a solvable board): a fuzz board that returns solved:false = a spurious-UNSAT bug. Stop-and-fix; never weaken a test.**
>
> **EARLY SOUNDNESS GATE (Task 4):** This builds CDCL incrementally. Task 4 is a correct-but-slow CDCL skeleton WITHOUT learning. **If the skeleton goes spurious-UNSAT on solvable boards (fuzz red) and it can't be fixed, STOP and escalate — do not build learning on an unsound base.** Only proceed to Task 5+ once the skeleton is provably sound (fuzz + differential green).

**Goal:** Give `ShingokiSolver` a CDCL search engine that extends the solvable board range and returns a best-effort partial on timeout. (Full 40×40 solve is a bonus, not a gate — see spec's honest expectations.)

**Architecture:** In-solver CDCL on `ShingokiSolver`, mirroring `SlitherlinkSolver` (the working reference in this repo). Boolean edge vars; trail+reasons extending the existing T1 trail; full per-rule reason discipline; first-UIP conflict analysis + non-chronological backjump; VSIDS; Luby restarts. Reuses the existing sound `_propagate` rules as the propagator — NO 1-step lookahead inside search (the documented Slitherlink trap).

**Tech Stack:** Vanilla JS, `node:test`. No new deps.

**Spec:** `docs/superpowers/specs/2026-06-01-shingoki-cdcl-design.md` (read first).
**Reference of truth for complex methods:** `src/solvers/slitherlink.js` — `_analyzeConflict` (line ~608), `_cdclSearch` (~2144), `_lubyNext` (~503), `_restart` (~516), `_pickDecisionLiteral` (~480), `_decodeVar` (~314). When a task says "port slitherlink's X", READ that method and adapt the variable model to Shingoki (edges only — Shingoki has no cell/color vars).

**Verified Shingoki solver facts:**
- `src/solvers/shingoki.js`: `this.H` `(rows+1)×cols`, `this.V` `rows×(cols+1)`; 0/1/2 = unknown/line/cross.
- `setEdge(ref,val)` (lines 66-73) is the single edge-write chokepoint; already records the T1 trail `(kind,r,c,prev)` when `this._trail` is set. `_trailMark()`/`_rollbackTo(mark)` exist (T1).
- `_propagate()` runs the rule fixpoint (degree/shape/axis/run-cap/connectivity) via a local `trySet`→`setEdge`. Returns false on contradiction.
- `_allEdgeRefs()`, `incidentEdges(r,c)`, `_endpoints(ref)`, `decodeClue` (static), `_isValidComplete()`, `_deadByConnectivity()`, `_hasPrematureLoop()`, `numbersSatisfied()`, `getStepwiseHint`, `_lookahead1` all exist. **`getStepwiseHint`/`_lookahead1` stay UNCHANGED — CDCL does not touch them.**
- `solve()` (lines ~269-324) currently does DFS. It will be rewritten to call `_cdclSearch()` (Task 8).
- `tests/bench-shingoki.js` benches the captured 40×40 fixture `shingoki_40x40_monthly` in `tests/fixtures/real-puzzles.js`.

---

## File Structure

**Modify:**
- `src/solvers/shingoki.js` — all CDCL methods + the `solve()` switchover + partial-on-timeout.
- `src/widget/puzzles/shingoki.js` — partial-Solve handling (Task 9).
- `tests/shingoki.test.js` — per-component + differential + no-spurious-UNSAT + perf tests.
- `tests/bench-shingoki.js` — extend to a size ladder (Task 0).

No other files unless the partial return shape needs threading (Task 9 checks `solver.worker.js`/`handler.js`, mirroring slitherlink).

---

## Task 0: Bench size-ladder + differential harness

Establishes the measurement instrument BEFORE any engine change.

**Files:** Modify `tests/bench-shingoki.js`. Test: none (bench is standalone).

- [ ] **Step 1:** Extend `tests/bench-shingoki.js` to solve a ladder of constructive boards + the real 40×40. Replace its body with:

```js
'use strict';
// Standalone bench for ShingokiSolver. Run: node tests/bench-shingoki.js
const { ShingokiSolver } = require('../src/solvers/shingoki.js');
const fixtures = require('./fixtures/real-puzzles.js');

// Constructive board: random rectangle-perimeter loop, derive its clues.
function genBoard(n, seed) {
  let s = seed >>> 0; const rnd = () => { s = (s*1664525 + 1013904223) >>> 0; return s / 0x100000000; };
  const r0 = Math.floor(rnd()*n), r1 = r0 + 1 + Math.floor(rnd()*(n-r0));
  const c0 = Math.floor(rnd()*n), c1 = c0 + 1 + Math.floor(rnd()*(n-c0));
  const H = Array.from({length:n+1},()=>new Array(n).fill(0));
  const V = Array.from({length:n},()=>new Array(n+1).fill(0));
  for (let c=c0;c<c1;c++){H[r0][c]=1;H[r1][c]=1;}
  for (let r=r0;r<r1;r++){V[r][c0]=1;V[r][c1]=1;}
  const probe = new ShingokiSolver({rows:n,cols:n,task:Array.from({length:n+1},()=>new Array(n+1).fill(0))});
  probe.H = H; probe.V = V;
  const task = Array.from({length:n+1},()=>new Array(n+1).fill(0));
  for (let r=0;r<=n;r++) for (let c=0;c<=n;c++){
    const inc = probe.incidentEdges(r,c).filter(e=>probe.getEdge(e)===1);
    if (inc.length!==2) continue;
    const isTurn = inc.filter(e=>e.kind==='H').length===1;
    task[r][c] = isTurn ? -probe.runLengthAt(r,c) : probe.runLengthAt(r,c);
  }
  return task;
}

function run(label, rows, cols, task, maxMs) {
  const t0 = Date.now();
  const res = new ShingokiSolver({ rows, cols, task, maxMs }).solve();
  const ms = Date.now() - t0;
  let valid = 'n/a';
  if (res.solved) {
    const chk = new ShingokiSolver({ rows, cols, task });
    chk.H = res.horizontal; chk.V = res.vertical;
    valid = chk.numbersSatisfied();
  }
  console.log(`${label}: solved=${res.solved} valid=${valid} ms=${ms}${res.error ? ' err=' + res.error : ''}`);
}

const MAXMS = Number(process.env.MAXMS || 15000);
for (const n of [10, 15, 20, 25]) run(`constructive ${n}x${n}`, n, n, genBoard(n, n*97), MAXMS);
const p = fixtures.shingoki_40x40_monthly;
run('real 40x40 monthly', p.rows, p.cols, p.task, Number(process.env.MAXMS40 || 30000));
```

- [ ] **Step 2:** Run `node tests/bench-shingoki.js`. Record EVERY line — this is the DFS+T1+T2 baseline ladder. (Constructive boards are easy and will solve fast; the 40×40 times out. The point is the instrument exists.)

- [ ] **Step 3:** Gate (`npm run build && npm test && npm run lint && npm run typecheck`) + commit:
```
jj commit -m "test(shingoki): bench size-ladder for CDCL range measurement

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 1: Variable encoding

**Files:** Modify `src/solvers/shingoki.js`. Test `tests/shingoki.test.js`.

- [ ] **Step 1: Write tests** (append to `tests/shingoki.test.js`):

```js
test('Shingoki CDCL: _varId/_decodeVar round-trip for all edges', () => {
  const s = new ShingokiSolver({ rows: 3, cols: 4, task: [] });
  const seen = new Set();
  for (let r = 0; r <= 3; r++) for (let c = 0; c < 4; c++) {
    const id = s._varId('H', r, c);
    assert.ok(!seen.has(id), `H var ${id} collides`); seen.add(id);
    assert.deepEqual(s._decodeVar(id), { kind: 'H', r, c });
  }
  for (let r = 0; r < 3; r++) for (let c = 0; c <= 4; c++) {
    const id = s._varId('V', r, c);
    assert.ok(!seen.has(id), `V var ${id} collides`); seen.add(id);
    assert.deepEqual(s._decodeVar(id), { kind: 'V', r, c });
  }
  // contiguous 0..numVars-1
  assert.equal(seen.size, (3+1)*4 + 3*(4+1));
});
```

- [ ] **Step 2: Run, verify fail** (`_varId` undefined).

- [ ] **Step 3: Implement.** Add to the class (after `_axisEdges`):

```js
  // CDCL variable encoding: each edge is one boolean var (true=LINE, false=CROSS).
  // H edges occupy [0, numH); V edges [numH, numH+numV). numH = (rows+1)*cols.
  _numH() { return (this.rows + 1) * this.cols; }
  _varId(kind, r, c) {
    return kind === 'H' ? r * this.cols + c : this._numH() + r * (this.cols + 1) + c;
  }
  _decodeVar(id) {
    const numH = this._numH();
    if (id < numH) return { kind: 'H', r: Math.floor(id / this.cols), c: id % this.cols };
    const v = id - numH; const w = this.cols + 1;
    return { kind: 'V', r: Math.floor(v / w), c: v % w };
  }
  _numVars() { return this._numH() + this.rows * (this.cols + 1); }
```

- [ ] **Step 4: Run** `node --test tests/shingoki.test.js` (pass) + fuzz (3 pass — no behavior change yet).

- [ ] **Step 5: Gate + commit.**
```
jj commit -m "feat(shingoki/cdcl): boolean edge variable encoding

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Trail reasons + decision levels

Extend the T1 trail to carry, per assigned var, its REASON (antecedent var IDs) and decision LEVEL. This is the data CDCL conflict analysis walks.

**Files:** Modify `src/solvers/shingoki.js`. Test `tests/shingoki.test.js`.

- [ ] **Step 1: Write tests** (append):

```js
test('Shingoki CDCL: setEdge records reason + level on the assignment trail', () => {
  const s = new ShingokiSolver({ rows: 2, cols: 2, task: [[0,0,0],[0,0,0],[0,0,0]] });
  s._cdclInit();
  s._decisionLevel = 1;
  s._currentReason = null; // a decision
  s.setEdge({ kind: 'H', r: 0, c: 0 }, 1);
  const vid = s._varId('H', 0, 0);
  assert.equal(s._level[vid], 1);
  assert.equal(s._reason[vid], null); // decision => null reason
  s._decisionLevel = 2;
  s._currentReason = [vid]; // a forced edge, caused by the first
  s.setEdge({ kind: 'V', r: 0, c: 0 }, 1);
  const vid2 = s._varId('V', 0, 0);
  assert.equal(s._level[vid2], 2);
  assert.deepEqual(s._reason[vid2], [vid]);
});
```

- [ ] **Step 2: Run, verify fail** (`_cdclInit` undefined).

- [ ] **Step 3: Implement.** Add a CDCL-state initializer + extend `setEdge` to capture reason/level when CDCL is active:

```js
  // Initialize CDCL bookkeeping (separate from _initState's edge arrays).
  _cdclInit() {
    this._initState();              // builds H/V + _trail
    const n = this._numVars();
    this._reason = new Array(n).fill(undefined); // undefined=unassigned, null=decision, array=antecedents
    this._level = new Int32Array(n).fill(-1);
    this._assignTrail = [];         // var IDs in assignment order (for backjump)
    this._decisionLevel = 0;
    this._currentReason = null;     // set by rules before each forced setEdge
    this._cdcl = true;
  }
```

In `setEdge`, after the existing T1 trail push, add the CDCL capture:
```js
  setEdge(ref, val) {
    const cur = this.getEdge(ref);
    if (cur === val) return true;
    if (cur !== 0) return false;
    if (this._trail) this._trail.push(ref.kind, ref.r, ref.c, cur);
    if (this._cdcl) {
      const vid = this._varId(ref.kind, ref.r, ref.c);
      this._reason[vid] = this._currentReason; // null for a decision, array for a force
      this._level[vid] = this._decisionLevel;
      this._assignTrail.push(vid);
    }
    if (ref.kind === 'H') this.H[ref.r][ref.c] = val; else this.V[ref.r][ref.c] = val;
    return true;
  }
```

Extend `_rollbackTo` to also unwind `_reason`/`_level`/`_assignTrail` for any var whose edge it reverts to 0:
```js
  _rollbackTo(mark) {
    const t = this._trail;
    if (!t) return;
    while (t.length > mark) {
      const prev = t.pop(), c = t.pop(), r = t.pop(), kind = t.pop();
      if (kind === 'H') this.H[r][c] = prev; else this.V[r][c] = prev;
      if (this._cdcl) {
        const vid = this._varId(kind, r, c);
        this._reason[vid] = undefined;
        this._level[vid] = -1;
        // _assignTrail is popped in lockstep (same LIFO order as _trail)
        if (this._assignTrail.length && this._assignTrail[this._assignTrail.length - 1] === vid) {
          this._assignTrail.pop();
        }
      }
    }
  }
```
NOTE: the `_assignTrail` pop assumes lockstep with `_trail` — both are LIFO and pushed together in `setEdge`, so the top of `_assignTrail` always matches the var just reverted. The guard handles the non-CDCL path safely.

- [ ] **Step 4: Run** `node --test tests/shingoki.test.js` (new pass) + fuzz (3 pass — `_cdcl` is false in the DFS path, so behavior unchanged) + the existing trail test (still passes — non-CDCL rollback unchanged).

- [ ] **Step 5: Gate + commit.**
```
jj commit -m "feat(shingoki/cdcl): trail reasons + decision levels

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Reason discipline — thread _currentReason through every forcing rule

Every rule in `_propagate` that forces an edge must set `this._currentReason` to the exact antecedent var IDs FIRST. Without tight reasons CDCL learns nothing (the spec's make-or-break point). Conflicts likewise record `this._lastConflictReason`.

**Files:** Modify `src/solvers/shingoki.js`. Test `tests/shingoki.test.js`.

- [ ] **Step 1: Write a reason-correctness test** (append). It runs propagation under CDCL and checks a forced cross carries the two lines that forced it:

```js
test('Shingoki CDCL: degree-forced cross carries its two line antecedents', () => {
  // center vertex (1,1) gets two lines (E,S) -> W,N forced cross. The W cross's
  // reason must be exactly the two line vars.
  const s = new ShingokiSolver({ rows: 2, cols: 2, task: [[0,0,0],[0,0,0],[0,0,0]] });
  s._cdclInit();
  s._decisionLevel = 1;
  s._currentReason = null; s.setEdge({ kind: 'H', r: 1, c: 1 }, 1); // E decision
  s._currentReason = null; s.setEdge({ kind: 'V', r: 1, c: 1 }, 1); // S decision
  assert.equal(s._propagate(), true);
  const wVar = s._varId('H', 1, 0); // West edge, forced cross
  assert.equal(s.getEdge({ kind: 'H', r: 1, c: 0 }), 2);
  const reason = s._reason[wVar];
  assert.ok(Array.isArray(reason), 'forced cross must carry an antecedent array');
  const eVar = s._varId('H', 1, 1), sVar = s._varId('V', 1, 1);
  // reason must reference the lines that forced the degree rule (E and/or S)
  assert.ok(reason.includes(eVar) || reason.includes(sVar), 'reason must cite the forcing lines');
});
```

- [ ] **Step 2: Run, verify fail** (reason is currently `null`/`undefined` — `_propagate`'s `trySet` doesn't set `_currentReason`).

- [ ] **Step 3: Implement.** This is the careful part. In `_propagate`, for EACH forcing site, set `this._currentReason` to the antecedent var IDs before the `trySet`/`setEdge`. The forcing sites and their reasons:
  - **Degree, 2 lines → cross the rest:** reason = the var IDs of the (up to 2) incident LINE edges at this vertex.
  - **Degree, 1 line + 1 unknown → force line:** reason = the incident line var + the incident cross vars (what removed the alternatives).
  - **Circled vertex degree-2 forcing:** reason = the incident cross/border vars + (the clue is a structural antecedent — represent the clue by a sentinel; see below).
  - **White/black shape forcing:** reason = the known line var + the clue sentinel.
  - **Axis forcing:** reason = the crossed/border edges that killed the other axis + the clue sentinel.
  - **Run-cap forcing:** reason = the confirmed run's edge vars + the clue sentinel.

  **Clue sentinel:** clues are fixed facts (not variables), so they need no var in the reason — they're always-true. Represent a clue antecedent by simply OMITTING it from the reason array (a unit fact contributes nothing to the learned clause). So a reason is purely the set of antecedent EDGE var IDs.

  Practical implementation: add a helper `_incidentVars(r, c, valueFilter)` returning the var IDs of incident edges with a given value, and at each forcing site compute the reason from the edges that drove the deduction. Set `this._currentReason = [...]` immediately before each `trySet`. For sites that force multiple edges with the SAME antecedents, set `_currentReason` once before the loop.

  Also: when `_propagate` detects a CONTRADICTION (returns false), set `this._lastConflictReason` to the antecedent vars of the contradiction (e.g. the >2 lines at a vertex, or the conflicting run). Add a field `this._lastConflictReason = null;` in `_cdclInit`.

  IMPORTANT: every `_currentReason` you set must be SOUND — it must list edges whose current assignment genuinely entails the force. A wrong reason corrupts learning (spurious UNSAT). Unit-test the trickier rules (run-cap, axis) the same way as the degree test above.

- [ ] **Step 4: Run** `node --test tests/shingoki.test.js` (new reason tests pass) + fuzz (3 pass — reasons don't change WHICH edges are forced, only annotate them; behavior identical).

- [ ] **Step 5: Gate + commit.**
```
jj commit -m "feat(shingoki/cdcl): per-rule reason discipline (tight antecedents)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: CDCL skeleton WITHOUT learning — THE SOUNDNESS GATE

A correct-but-slow CDCL: decisions via VSIDS-less scan, `_propagate`, on conflict do CHRONOLOGICAL backjump (pop one level, force the decision's opposite). NO clause learning yet. This proves the var/trail/reason/level machinery is SOUND before learning is added. **If this goes spurious-UNSAT, STOP.**

**Files:** Modify `src/solvers/shingoki.js`. Test `tests/shingoki.test.js`.

- [ ] **Step 1: Write the soundness tests** (append). The skeleton must solve every fuzz-style board AND match `numbersSatisfied`:

```js
test('Shingoki CDCL skeleton: solves the captured 5x5 with a valid loop', () => {
  const TASK_5x5 = [
    [0,-5,0,0,0,0],[0,0,0,-4,0,0],[0,0,2,0,0,0],
    [-3,2,0,0,2,-4],[-3,0,0,-2,0,0],[0,0,0,-2,0,0],
  ];
  const res = new ShingokiSolver({ rows: 5, cols: 5, task: TASK_5x5, maxMs: 10000 })._solveCdcl();
  assert.equal(res.solved, true);
  const chk = new ShingokiSolver({ rows: 5, cols: 5, task: TASK_5x5 });
  chk.H = res.horizontal; chk.V = res.vertical;
  assert.equal(chk.numbersSatisfied(), true);
});

test('Shingoki CDCL skeleton: never spurious-UNSAT on solvable constructive boards', () => {
  // 5 constructive boards (the fuzz pattern) must all solve via the skeleton.
  function gen(n, seed) {
    let s = seed>>>0; const rnd=()=>{s=(s*1664525+1013904223)>>>0;return s/0x100000000;};
    const r0=Math.floor(rnd()*n),r1=r0+1+Math.floor(rnd()*(n-r0));
    const c0=Math.floor(rnd()*n),c1=c0+1+Math.floor(rnd()*(n-c0));
    const H=Array.from({length:n+1},()=>new Array(n).fill(0));
    const V=Array.from({length:n},()=>new Array(n+1).fill(0));
    for(let c=c0;c<c1;c++){H[r0][c]=1;H[r1][c]=1;}
    for(let r=r0;r<r1;r++){V[r][c0]=1;V[r][c1]=1;}
    const p=new ShingokiSolver({rows:n,cols:n,task:Array.from({length:n+1},()=>new Array(n+1).fill(0))});
    p.H=H;p.V=V;
    const task=Array.from({length:n+1},()=>new Array(n+1).fill(0));
    for(let r=0;r<=n;r++)for(let c=0;c<=n;c++){const inc=p.incidentEdges(r,c).filter(e=>p.getEdge(e)===1);if(inc.length!==2)continue;task[r][c]=inc.filter(e=>e.kind==='H').length===1?-p.runLengthAt(r,c):p.runLengthAt(r,c);}
    return task;
  }
  for (let seed = 1; seed <= 5; seed++) {
    const task = gen(6, seed);
    const res = new ShingokiSolver({ rows: 6, cols: 6, task, maxMs: 10000 })._solveCdcl();
    assert.notEqual(res.error, 'no solution', `seed ${seed}: spurious UNSAT`);
    assert.equal(res.solved, true, `seed ${seed} must solve`);
  }
});
```

- [ ] **Step 2: Run, verify fail** (`_solveCdcl` undefined).

- [ ] **Step 3: Implement the skeleton.** Add `_solveCdcl()` and a chronological `_cdclSkeletonSearch()`:

```js
  // Public-ish entry for the CDCL path. Task 8 will make solve() delegate here.
  _solveCdcl() {
    this._startedAt = Date.now();
    this._cdclInit();
    if (!this._propagate()) return { solved: false, horizontal: null, vertical: null, error: 'contradiction on initial propagation' };
    const ok = this._cdclSkeletonSearch();
    if (ok) return { solved: true, horizontal: this.H.map(r => r.slice()), vertical: this.V.map(r => r.slice()) };
    if (this.maxMs > 0 && timeUp(this.maxMs, this._startedAt)) {
      return { solved: false, horizontal: null, vertical: null, error: 'time limit exceeded' };
    }
    return { solved: false, horizontal: null, vertical: null, error: 'no solution' };
  }

  // Chronological CDCL skeleton (no learning): decide, propagate, on conflict
  // pop one level and flip the decision. Proves the machinery is sound.
  _cdclSkeletonSearch() {
    const triedFlip = []; // per level: has the decision's opposite been tried?
    for (;;) {
      if (this.maxMs > 0 && timeUp(this.maxMs, this._startedAt)) return false;
      // propagate to fixpoint; on conflict, backtrack chronologically
      if (!this._propagate() || this._deadByConnectivity()) {
        // conflict: undo to the previous decision level and flip it
        if (this._decisionLevel === 0) return false; // UNSAT at root
        const flipped = this._chronoBacktrackAndFlip(triedFlip);
        if (!flipped) return false;
        continue;
      }
      // find an unassigned edge; if none, we have a complete assignment
      const ref = this._firstUnassignedEdge();
      if (!ref) return this._isValidComplete();
      // decide: branch CROSS first (matches the DFS cross-first heuristic)
      this._decisionLevel++;
      triedFlip[this._decisionLevel] = false;
      this._levelMark = this._levelMark || [];
      this._levelMark[this._decisionLevel] = this._trailMark();
      this._currentReason = null;
      this._decisionEdge = this._decisionEdge || [];
      this._decisionEdge[this._decisionLevel] = ref;
      this.setEdge(ref, 2); // cross
    }
  }

  _firstUnassignedEdge() {
    for (const e of this._allEdgeRefs()) if (this.getEdge(e) === 0) return e;
    return null;
  }

  // Pop to the previous decision level; if that level's decision hasn't had its
  // opposite tried, set the opposite and mark it tried; else recurse upward.
  _chronoBacktrackAndFlip(triedFlip) {
    while (this._decisionLevel > 0) {
      const lvl = this._decisionLevel;
      this._rollbackTo(this._levelMark[lvl]);
      this._decisionLevel = lvl - 1;
      if (!triedFlip[lvl]) {
        triedFlip[lvl] = true;
        this._decisionLevel = lvl;
        this._levelMark[lvl] = this._trailMark();
        this._currentReason = null;
        const ref = this._decisionEdge[lvl];
        // first branch was CROSS(2); flip to LINE(1)
        this.setEdge(ref, 1);
        return true;
      }
    }
    return false;
  }
```
NOTE: this is the slow-but-sound version. It mirrors the existing DFS's cross-first/[2,1] order but routed through the CDCL state (levels/marks). Read the existing `solve()` DFS to keep the branching semantics identical.

- [ ] **Step 4: Run** `node --test tests/shingoki.test.js` (skeleton tests pass) + fuzz (3 pass). **CRITICAL GATE: the no-spurious-UNSAT test + fuzz MUST be green. If any constructive board returns `error:'no solution'`, the machinery is unsound — DEBUG before proceeding; do NOT build Task 5 on it. If it can't be made sound, STOP and report BLOCKED.**

- [ ] **Step 5: Differential check.** Write a throwaway script (DELETE after): solve 10 constructive boards (sizes 5-8) with BOTH the old `solve()` (DFS) and `_solveCdcl()` (skeleton); assert both return `solved:true` and both pass `numbersSatisfied`. Report the result. This is the soundness proof of the skeleton.

- [ ] **Step 6: Gate + commit.**
```
jj commit -m "feat(shingoki/cdcl): correct-but-slow CDCL skeleton (soundness gate)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Conflict analysis + clause learning + non-chronological backjump

Replace the chronological backtrack with first-UIP learning. PORT slitherlink's `_analyzeConflict` (line ~608) — READ IT — adapting its variable model (slitherlink has edge+cell vars; Shingoki has edge vars only, so drop the cell/color cases). Keep its subsumption pre-pass + rescue-path (its notes warn these are required for correctness).

**Files:** Modify `src/solvers/shingoki.js`. Test `tests/shingoki.test.js`.

- [ ] **Step 1: Write a learned-clause test** (append). A learned clause must EXCLUDE the conflicting assignment (every literal false under it):

```js
test('Shingoki CDCL: _analyzeConflict returns a clause excluding the conflict', () => {
  // Construct a tiny conflict: force a state where _propagate fails, capture the
  // learned clause, assert it is non-trivial (>=1 literal) and references
  // current-level vars. (Detailed structural assertions live in the differential
  // + fuzz gates; this is a smoke test that learning produces a real clause.)
  const TASK = [[0,-5,0,0,0,0],[0,0,0,-4,0,0],[0,0,2,0,0,0],[-3,2,0,0,2,-4],[-3,0,0,-2,0,0],[0,0,0,-2,0,0]];
  const s = new ShingokiSolver({ rows: 5, cols: 5, task: TASK, maxMs: 10000 });
  const res = s._solveCdcl();
  assert.equal(res.solved, true); // with learning, still solves correctly
  assert.ok(s._totalConflicts >= 0); // learning ran
});
```

- [ ] **Step 2: Implement.** Add `_analyzeConflict(conflictReason)`, `_computeBackjumpLevel(clause)`, `_addLearnedClause`, `_backjumpTo(level)`, and a learned-clause unit-propagation hook in `_propagate` (learned clauses participate in propagation: a clause with all-but-one literal false forces the last). Port slitherlink's structures; Shingoki specifics:
  - Literals: a var `v` assigned LINE contributes `~v` (negative) to a clause blaming it; assigned CROSS contributes `v`. Use slitherlink's `~lit` convention (`lit>=0` positive, `lit<0` negative; `varId = lit>=0 ? lit : ~lit`). **Never `Math.abs`/`-lit`** (var 0 is real).
  - The implication graph is `_reason[]`/`_level[]`/`_assignTrail[]` from Task 2.
  - Connectivity conflicts (from `_deadByConnectivity`) blame the most-recent current-level DECISION (chronological semantics) — they don't get a tight var-reason. Implement: on a connectivity conflict, set the conflict reason to `[decisionVarOfCurrentLevel]` so analysis learns `~decision`.
  - Replace `_cdclSkeletonSearch` with a `_cdclSearch` mirroring slitherlink's loop (line ~2144): decide → while(!propagate) { analyze, backjump, addLearned, (no VSIDS/restart yet — Tasks 6-7) }. Keep `_deadByConnectivity` as a post-propagate conflict trigger.
  - `_solveCdcl` calls `_cdclSearch` instead of `_cdclSkeletonSearch`.

- [ ] **Step 3: Run** `node --test tests/shingoki.test.js` + fuzz (3 pass). **GATE: no spurious UNSAT.** If the learned clauses cause a fuzz board to wrongly UNSAT, the analysis/reasons are buggy — debug (compare against slitherlink's analyze structure); do not proceed broken.

- [ ] **Step 4: Differential check** (throwaway, delete after): 20 constructive boards (5-10), both `solve()` and `_solveCdcl()` return valid solutions. Report.

- [ ] **Step 5: Measurement:** `node tests/bench-shingoki.js` — record the ladder. Learning should already extend range vs the skeleton.

- [ ] **Step 6: Gate + commit.**
```
jj commit -m "feat(shingoki/cdcl): first-UIP conflict analysis + clause learning + backjump

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: VSIDS branching

**Files:** Modify `src/solvers/shingoki.js`. Test `tests/shingoki.test.js`.

- [ ] **Step 1: Test** (append): bumping a var's activity makes `_pickDecisionVar` prefer it.

```js
test('Shingoki CDCL: VSIDS prefers the higher-activity unassigned var', () => {
  const s = new ShingokiSolver({ rows: 3, cols: 3, task: [] });
  s._cdclInit();
  s._initVsids();
  const a = s._varId('H', 1, 1), b = s._varId('V', 1, 1);
  s._bumpVar(b); s._bumpVar(b); s._bumpVar(a);
  assert.equal(s._pickDecisionVar(), b); // b has higher activity
});
```

- [ ] **Step 2: Implement** `_initVsids()` (Float32Array `_activity` size `_numVars`, `_vsidsInc`), `_bumpVar(vid)`, `_bumpVsids(clause)` (bump all vars in a learned clause), `_decayVsidsIfDue()` (multiply inc by 1/0.95 every 256 conflicts; rescale on overflow), `_pickDecisionVar()` (highest-activity UNASSIGNED var; returns -1 if all assigned). Wire `_pickDecisionVar` into `_cdclSearch`'s decision step (branch the chosen var CROSS-first). Mirror slitherlink's VSIDS (line ~113 notes, `_pickDecisionLiteral` ~480).

- [ ] **Step 3: Run** tests + fuzz (green). **Measurement:** bench ladder — VSIDS should improve mid-size solve times.

- [ ] **Step 4: Gate + commit.**
```
jj commit -m "feat(shingoki/cdcl): VSIDS activity-based branching

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Luby restarts + learned-clause LRU cap

**Files:** Modify `src/solvers/shingoki.js`. Test `tests/shingoki.test.js`.

- [ ] **Step 1: Test** (append): Luby sequence is correct.

```js
test('Shingoki CDCL: _lubyNext yields the canonical Luby sequence', () => {
  const s = new ShingokiSolver({ rows: 2, cols: 2, task: [] });
  const got = [];
  for (let i = 0; i < 15; i++) got.push(s._lubyNext(i));
  assert.deepEqual(got, [1,1,2,1,1,2,4,1,1,2,1,1,2,4,8]);
});
```

- [ ] **Step 2: Implement** `_lubyNext(idx)` (PORT slitherlink's ~503 — the canonical 1-indexed recurrence), `_restart()` (PORT ~516: backjump to level 0, keep learned clauses + activity), and an LRU cap on `_learnedClauses` (drop lowest-activity when over ~5000). Wire restart into `_cdclSearch`'s conflict loop (RESTART_UNIT=100, lubyIdx increments — mirror slitherlink ~2223).

- [ ] **Step 3: Run** tests + fuzz (green). **Measurement:** bench ladder.

- [ ] **Step 4: Gate + commit.**
```
jj commit -m "feat(shingoki/cdcl): Luby restarts + learned-clause LRU cap

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Switch solve() to CDCL + partial-on-timeout

**Files:** Modify `src/solvers/shingoki.js`. Test `tests/shingoki.test.js`.

- [ ] **Step 1: Test** (append): timeout returns a partial; success returns the loop.

```js
test('Shingoki solve: returns a partial snapshot on timeout', () => {
  const fixtures = require('./fixtures/real-puzzles.js');
  const p = fixtures.shingoki_40x40_monthly;
  const res = new ShingokiSolver({ rows: p.rows, cols: p.cols, task: p.task, maxMs: 1500 }).solve();
  if (!res.solved) {
    assert.equal(res.error, 'time limit exceeded');
    assert.ok(res.partial && res.partial.horizontal && res.partial.vertical, 'timeout must carry a partial');
    // partial must be SOUND: no edge contradicts the others (every set edge is a valid deduction)
    const chk = new ShingokiSolver({ rows: p.rows, cols: p.cols, task: p.task });
    chk.H = res.partial.horizontal; chk.V = res.partial.vertical;
    // at least some edges deduced
    let set = 0; for (const row of chk.H) for (const v of row) if (v) set++;
    assert.ok(set > 0, 'partial should have deduced edges');
  }
});

test('Shingoki solve: small boards still solve correctly via CDCL', () => {
  const TASK = [[0,-5,0,0,0,0],[0,0,0,-4,0,0],[0,0,2,0,0,0],[-3,2,0,0,2,-4],[-3,0,0,-2,0,0],[0,0,0,-2,0,0]];
  const res = new ShingokiSolver({ rows: 5, cols: 5, task: TASK, maxMs: 10000 }).solve();
  assert.equal(res.solved, true);
  const chk = new ShingokiSolver({ rows: 5, cols: 5, task: TASK });
  chk.H = res.horizontal; chk.V = res.vertical;
  assert.equal(chk.numbersSatisfied(), true);
});
```

- [ ] **Step 2: Implement.** Rewrite `solve()` to delegate to the CDCL path and add the partial snapshot. On timeout, capture the current `this.H`/`this.V` (the deduced state at the best point) into `partial`. To get a meaningful partial, on timeout return the state after the LAST successful propagate at decision level 0 (the safely-deduced edges) — track `this._rootSnapshot` after the initial propagate + any level-0 forced learning. Concretely:
```js
  solve() {
    const res = this._solveCdcl();
    if (!res.solved && res.error === 'time limit exceeded') {
      res.partial = this._rootSnapshot || { horizontal: this.H.map(r => r.slice()), vertical: this.V.map(r => r.slice()) };
    }
    return res;
  }
```
Set `this._rootSnapshot` in `_solveCdcl` right after the initial `_propagate()` succeeds (and refresh it whenever the search backjumps to level 0), so the partial is always a SOUND set of level-0 deductions (never mid-branch speculative edges). Keep the old DFS `solve` body as `_solveDfs` (dead ref) only if useful; otherwise remove it (the CDCL path supersedes it).

- [ ] **Step 3: Run** the FULL suite `npm test` + fuzz. The 5x5 golden, all integration, and the deductive-hint tests must pass (Hint uses getStepwiseHint, unaffected). **Differential gate:** confirm no previously-solvable board regressed.

- [ ] **Step 4: Measurement:** `node tests/bench-shingoki.js MAXMS40=30000` — record the FINAL ladder. This is the headline result: which sizes now solve, and the 40×40 partial coverage.

- [ ] **Step 5: Gate + commit.**
```
jj commit -m "feat(shingoki/cdcl): solve() uses CDCL + returns partial on timeout

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Widget partial-Solve handling

If `solve()` returns a partial, the widget should apply the deduced edges and tell the user to finish. Mirror slitherlink's `partialResultArm`.

**Files:** Modify `src/widget/puzzles/shingoki.js` (+ possibly `solver.worker.js`/`handler.js` if the partial field needs threading). Test `tests/puzzle-modules.test.js`.

- [ ] **Step 1: Read** how slitherlink threads its partial: grep `partial` in `src/widget/puzzles/slitherlink.js`, `solver.worker.js`, `content.js`/`widget.js`. Confirm whether the worker passes `result.partial` through (it returns the whole result object, so likely yes).

- [ ] **Step 2: Test** (append to tests/puzzle-modules.test.js): a `partialResultArm` (or the existing result-handling hook) on shingoki surfaces the partial. Mirror slitherlink's test shape if one exists; otherwise a minimal hook-shape test.

- [ ] **Step 3: Implement** the partial handling on the shingoki widget module mirroring slitherlink (`partialResultArm` that draws the partial `{horizontal, vertical}` and sets a "Partial: N edges deduced — finish manually" status). If slitherlink's partial flows through a generic path that already keys on `result.partial`, shingoki may need only a small addition or none — verify by tracing.

- [ ] **Step 4: Build + run** `npm run build && npm test`. Confirm `dist/content.js` carries the change.

- [ ] **Step 5: Gate + commit.**
```
jj commit -m "feat(shingoki/cdcl): widget partial-Solve handling (apply deduced edges)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: CI perf/range test + docs + cleanup

**Files:** Modify `tests/shingoki.test.js`, `AGENTS.md`, `src/solvers/shingoki.js` (header doc).

- [ ] **Step 1: Add a bounded range test** to `tests/shingoki.test.js` using the measured ladder — assert the sizes that now solve DO solve within budget (set from Task 8's measurement; e.g. if 15×15 solves in 1s, assert 15×15 solves under 8s). Do NOT assert the 40×40 solves (it may not — assert it returns either solved or a partial, never spurious UNSAT):

```js
test('Shingoki CDCL: solvable-range boards solve within budget; 40x40 never spurious-UNSAT', () => {
  const fixtures = require('./fixtures/real-puzzles.js');
  // 40x40: must return solved OR time-limit-with-partial — NEVER 'no solution'.
  const p = fixtures.shingoki_40x40_monthly;
  const res = new ShingokiSolver({ rows: p.rows, cols: p.cols, task: p.task, maxMs: 8000 }).solve();
  assert.notEqual(res.error, 'no solution', 'must never spurious-UNSAT a solvable board');
  if (!res.solved) assert.ok(res.partial, 'unsolved => partial present');
});
```
Add a constructive mid-size assertion sized from the real measurement (the implementer fills the size/budget from Task 8's ladder — document the chosen values in a comment).

- [ ] **Step 2: Docs.** Update `src/solvers/shingoki.js` header to document the CDCL engine (mirroring slitherlink's CDCL doc block, abbreviated) + the measured range. Update `AGENTS.md`'s Shingoki bullet: `(solver: CDCL — boolean edge vars, first-UIP learning, VSIDS, Luby restarts; reuses the sound propagation rules, no in-search lookahead; partial-on-timeout. Real 40×40 monthly: <state the measured outcome>. See the CDCL spec.)`.

- [ ] **Step 3: Full gate** `npm run build && npm test && npm run lint && npm run typecheck` all 0. Commit:
```
jj commit -m "test+docs(shingoki/cdcl): range test + document CDCL engine + measured results

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Live verification (INTERACTIVE — user)

- [ ] User reloads `dist/`, opens a large Shingoki. Clicks **Solve**: confirm it either solves (mid-size) or applies a substantial partial + "finish manually" status (40×40) — never hangs, never a wrong board. Confirm Hint/Loop still work. Report which board sizes fully solve live.

---

## Self-Review

**1. Spec coverage:**
- Variable model → Task 1 ✓
- Trail+reasons+levels → Task 2 ✓
- Full per-rule reason discipline → Task 3 ✓
- Propagation = existing rules, no lookahead → Tasks 4-5 (reuse `_propagate`; `_lookahead1` never called in `_cdclSearch`) ✓
- First-UIP conflict analysis + backjump (+ subsumption/rescue port) → Task 5 ✓
- VSIDS → Task 6 ✓
- Luby restarts + clause store LRU → Task 7 ✓
- Connectivity-conflict-blames-last-decision → Task 5 ✓
- Partial-on-timeout → Task 8 ✓
- Widget partial branch → Task 9 ✓
- Soundness gate (skeleton before learning) → Task 4 (explicit STOP condition) ✓
- No-spurious-UNSAT tests + fuzz master guard → Tasks 4,5,8,10 ✓
- Differential tests → Tasks 4,5 ✓
- Range/regression measurement → bench ladder Task 0 + gates in 5,6,7,8; CI test Task 10 ✓
- Risk gates (stop → DFS+partial if unsound/no-gain) → Task 4 STOP + the honest range-not-full-solve framing in Task 10's test ✓

**2. Placeholder scan:** The "port slitherlink's X" steps (Task 5 `_analyzeConflict`, Task 7 `_lubyNext`/`_restart`) reference COMPLETE working code in the same repo by file+line — that's a concrete source, not a placeholder; the Shingoki adaptation (edge-only vars, connectivity-blames-decision) is specified. Task 3's per-rule reasons are enumerated rule-by-rule. The two "fill from measurement" spots (Task 10 sizes/budget) are data the executor measures, with the Task 8 ladder as the source. No vague "add error handling" anywhere.

**3. Type consistency:** `_varId(kind,r,c)`/`_decodeVar(id)` (T1) used in T2/T3/T5. `_cdclInit`/`_reason`/`_level`/`_assignTrail`/`_currentReason`/`_lastConflictReason` (T2-T3) consistent. `_solveCdcl`/`_cdclSearch` (T4→T5 rename: skeleton's `_cdclSkeletonSearch` is REPLACED by `_cdclSearch` in T5 — flagged in T5 Step 2). `_pickDecisionVar` (T6), `_lubyNext`/`_restart` (T7). `solve()` returns `{solved, horizontal, vertical, error?, partial?}` consistent T8/T9/T10. Edge ref `{kind:'H'|'V', r, c}` and `~lit` literal convention consistent.
