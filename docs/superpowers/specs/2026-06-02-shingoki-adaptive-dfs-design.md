# Shingoki adaptive-DFS search engine — design

**Status:** approved (brainstorm)
**Date:** 2026-06-02
**Replaces:** the CDCL-only search path shipped in
`docs/superpowers/specs/2026-06-01-shingoki-cdcl-design.md` (and its perf
predecessor). The CDCL engine is removed by this work — see "Why CDCL is the
wrong tool" below.

## Summary

Replace `ShingokiSolver`'s CDCL search with a single **adaptive backtracking
(DFS) engine**: trail-based undo + the existing sound propagation rules +
in-search connectivity pruning + an **adaptive branching rule** that builds the
loop where committed chains exist (loop-aware) and falls back to a
most-constrained-edge choice where they don't (constraint-focused). A
sound **root-propagation partial** is returned on timeout. The CDCL/VSIDS/
restart/clause-learning machinery (~600 lines) is deleted.

## Why CDCL is the wrong tool (measured)

On a real `/shingoki/random/7x7-hard` board (21 mixed clues):

| Engine | Result |
| --- | --- |
| pre-CDCL DFS (first line-adjacent edge) | solves in ~16 s |
| **CDCL (shipped)** | **>60 s — times out** |
| loop-aware DFS (extend chains, LINE-first) | **solves in 2.5 s** |

Instrumentation: ~88% of conflicts on real boards are **structural**
(single-loop / premature-loop / connectivity). Structural conflicts have no
tight variable antecedent, so CDCL learns a useless ~15-literal "all current
decisions" clause. That learning (a) prunes nothing and (b) bloats the clause
DB so every `_propagateLearned` pass slows down — CDCL degenerates to
exponential backtracking *slower than no learning at all*. CDCL thus **regressed
the small/mid boards users actually play**.

The two engines are **complementary**: CDCL's VSIDS cracks ultra-sparse
synthetic boards (a 14-clue rectangle where propagation determines 0 edges) in
~24 ms, where a chain-extension DFS has nothing to extend and wanders; but real
published puzzles are densely/mixed-clued like the 7×7 above, where the
loop-aware DFS wins decisively. Branching order and decision phase are
**sound-neutral** (they change only search order, never correctness), so the
adaptive rule below can be tuned freely without spurious-UNSAT risk.

## Success criteria

1. **Soundness (absolute gate):** never a wrong solution, never spurious UNSAT
   (`'no solution'`) on a solvable board. Only `solved:true` or a partial.
2. **Realistic boards ≤ ~20×20 fully solve in a few seconds** — every genuinely
   clued board the site serves at random/daily sizes.
3. **40×40 monthly returns a sound partial** (the root-propagation snapshot),
   delivered at the bail cap (~6 s), not after grinding 30 s.
4. **No regression** on boards the old engine solved (differential).
5. Ultra-sparse / near-zero-propagation synthetic boards are **best-effort** —
   the goal is to solve them via the constraint-focused rule, but a pathological
   case may return a partial (see Testing, decision B).

## Architecture

A single search engine, all in `src/solvers/shingoki.js`. `solve()` runs the
initial propagation, snapshots the root, then calls `_solveDfs()`.

### Reused, unchanged (already proven sound)
`_initState`, `_propagate` and every rule it calls (degree / white-black shape /
axis / run-cap), the trail (`setEdge` push + `_trailMark` + `_rollbackTo`),
`incidentEdges`, `_endpoints`, `_hasPrematureLoop`, `_deadByConnectivity`,
`_isValidComplete`, `runLengthAt`, `numbersSatisfied`.

### Removed (~600 lines)
All CDCL machinery: `_cdclInit`, `_cdclSearch`, `_analyzeConflict`,
`_computeBackjumpLevel`, `_backjumpTo`, `_addLearnedClause`, `_forceLiteral`,
`_propagateLearned`, `_propagateAll`, `_currentLevelDecisionReason`; VSIDS
(`_activity`, `_bumpVar`, `_bumpVsids`, `_decayVsidsIfDue`, `_vsidsInc`,
`_vsidsConflicts`, `_initVsids`); `_lubyNext`, `_restart`; `_pickDecisionVar`;
the `_reason` / `_level` / `_assignTrail` parallel arrays; `_rootSnapshot` +
stagnation (`_stagnationMs`, `_stagnated`); the learned-clause store. Also strip
the CDCL reason-tracking branches threaded into `_propagate`/`setEdge`
(`if (this._cdcl) this._lastConflictReason = …`, the per-rule `conflictReason()`
closures, the `_currentReason` plumbing, and `setEdge`'s reason/level/trail
pushes) so propagation is plain again. Remove the `_varId`/`_decodeVar`/
`_numVars`/`_varValue` variable encoding if nothing outside CDCL uses it (verify
`getStepwiseHint` does not depend on it before deleting).

### Unchanged downstream
The widget partial path (`partialResultArm` in `src/widget/puzzles/shingoki.js`,
"Partial only: N edges deduced … finish manually"), the deductive Hint
(`getStepwiseHint` — keeps its own 1-step lookahead, NOT part of solve()), and
the partial return shape (`{solved:false, horizontal:null, vertical:null,
partial:true, ...}` carrying the deduced grid). `solver.worker.js` keeps
`maxMs: 30000`; the engine's own `searchMs` bail (below) governs the deep-search
budget.

## The adaptive branching rule (the heart)

`_pickBranch()` returns `{ref, firstVal}` for the next edge to assign, or `null`
when every edge is assigned. It is **sound-neutral** — only affects speed.

1. **Loop-aware (chains exist).** Scan vertices for a *chain endpoint*: exactly
   one committed LINE incident edge AND ≥1 unknown incident edge. If found,
   branch on one of that vertex's unknown edges, **LINE(1) first** then CROSS(2)
   — extending the loop. Among multiple chain endpoints, prefer the most
   constrained (incident to / nearest a clue, or fewest unknown continuations).
2. **Constraint-focused (no chains).** No chain endpoint exists (e.g. an
   ultra-sparse board at the root). Pick the **most-constrained** unknown edge:
   the unknown edge incident to the clued vertex with the fewest viable
   degree/axis completions; break ties toward the edge whose assignment triggers
   the most propagation. Choose the first value to be the one more likely to
   propagate (e.g. an edge forced by a near-saturated clue tries LINE first).

Ties broken deterministically (lowest `(kind, r, c)` index) for reproducible
search. The rule must be strong enough that the existing `gen()` sparse
rectangle boards (Testing) still solve — a naive "first unassigned edge"
fallback is explicitly insufficient.

## Search loop

Recursive DFS with trail-undo. Max recursion depth ≤ number of edges
(`(rows+1)*cols + rows*(cols+1)`, ≈ 3.3 k at 40×40) — within JS's default stack.

```
_dfs():
  if timeUp(searchMs) -> throw SearchBudgetExceeded   // unwinds to solve()
  if !_propagate() -> return false                     // contradiction
  if _hasPrematureLoop() || _deadByConnectivity() -> return false
  br = _pickBranch()
  if br == null -> return _isValidComplete()           // complete leaf
  for val in [br.firstVal, other(br.firstVal)]:
    mark = _trailMark()
    if setEdge(br.ref, val) && _dfs(): return true
    _rollbackTo(mark)
  return false
```

`solve()`:
```
_initState()
if !_propagate(): return {solved:false, ..., error:'contradiction on initial propagation'}
rootPartial = { horizontal: clone(H), vertical: clone(V) }   // SOUND level-0 facts
try:
  if _dfs(): return {solved:true, horizontal:H, vertical:V}
  return {solved:false, ..., error:'no solution'}            // genuine UNSAT
catch SearchBudgetExceeded:
  return {solved:false, horizontal:null, vertical:null,
          partial:true, ...rootPartial, error:'time limit exceeded'}
```

Note the **genuine-UNSAT vs timeout distinction**: `_dfs()` returning false with
no budget exception means the whole tree was exhausted → `'no solution'` (sound).
Only a `SearchBudgetExceeded` throw yields a partial. This must be preserved
exactly (it is the no-spurious-UNSAT guarantee).

## Partial-on-timeout & the bail cap (decision A: short cap)

- The partial is **always `rootPartial`** — the post-initial-propagation
  snapshot, captured before the first branch and never mutated by search.
  Mid-search `H`/`V` hold speculative decisions and must NOT be returned.
- Deep search runs under a **`searchMs` budget (~6000 ms)**, checked at every
  `_dfs` entry. Realistic ≤20×20 boards solve well under it; the 40×40 returns
  `rootPartial` at ~6 s instead of grinding the full 30 s. `searchMs` is a
  constructor option (default ~6000) so tests can lower it.
- `solver.worker.js` keeps `maxMs: 30000` as an outer wall-clock guard, but in
  practice `searchMs` fires first. (Constructor accepts both; `searchMs` is the
  deep-search cap, `maxMs` the hard ceiling.)

## Files

- `src/solvers/shingoki.js` — remove CDCL machinery; add `_solveDfs`,
  `_pickBranch`, root-partial capture, `searchMs` bail. Update the module header
  design notes (replace the CDCL paragraph with the adaptive-DFS description).
- `src/widget/puzzles/shingoki.js` — no behavior change; update the one-line
  header reference to the solver if it names CDCL.
- `solver.worker.js` — unchanged (`maxMs: 30000`); confirm no CDCL-specific
  options are passed.
- `tests/shingoki.test.js` — drop CDCL-internal unit tests (conflict analysis,
  Luby, VSIDS, learned-clause, the 385k-conflict invariant harness, the
  stagnation tests); keep/repoint soundness + differential + no-spurious-UNSAT;
  add the real 7×7-hard fixture test; keep the deep-search 8×8 and the `gen()`
  sparse-board tests (decision B).
- `tests/fixtures/real-puzzles.js` — add the real 7×7-hard board
  (`shingoki_7x7_hard`) as a fixture. Keep `shingoki_40x40_monthly`.
- `tests/bench-shingoki.js` — keep the size ladder; it now measures the DFS.
- `CLAUDE.md` — update the Shingoki per-puzzle note (currently describes the
  CDCL engine) to the adaptive-DFS engine.

## Testing

**Soundness (absolute gate):**
- Constructive fuzz 5×5/8×8/10×10 stays 100% green (master guard — a spurious
  prune/UNSAT turns a fuzz board `solved:false` → instant red).
- Differential: for boards the old engine solved, the DFS returns a solution
  passing `numbersSatisfied()` (not necessarily the same loop; solutions can be
  non-unique).
- No-spurious-UNSAT: known-solvable boards never return `'no solution'`; an
  impossible board (e.g. a white clue with an unreachable run length) returns
  `'no solution'`, NOT a partial.

**Range / regression:**
- **Real 7×7-hard fixture** (`shingoki_7x7_hard`, the board that motivated this)
  solves in a few seconds — guards the exact regression.
- Deep-search 8×8 (existing) still solves.
- `gen()` sparse rectangle boards (10×10 seeds 1–8, 15×15 seeds 1–3) still
  solve via the constraint-focused rule. **Decision B:** intent is to keep these
  strict; if one pathological board cannot be cracked by a reasonable
  most-constrained heuristic, relax *that specific* assertion to accept a partial
  (consistent with "ultra-sparse = best-effort") and `log` what was dropped — do
  NOT expand scope to chase it.
- **40×40 monthly**: returns a sound partial, all vertex degrees ≤2, wall under
  `searchMs` + margin (bounded CI perf test).
- Bench ladder records solve time + solved/partial across 10/15/20/25 + 40×40.

**Execution:** subagent-driven; each task gets spec-compliance + adversarial
soundness review, with fuzz + differential + no-spurious-UNSAT as objective
gates after every step. Build incrementally: (1) add `_solveDfs` + loop-aware
branching + root partial behind `solve()`, prove fuzz/differential green and the
7×7 solves; (2) strengthen the constraint-focused fallback until the `gen`
boards pass; (3) remove the dead CDCL machinery once nothing references it;
(4) update docs/benches.

## Risk gates (explicit stop conditions)

- **Any spurious UNSAT** the branching can't be responsible for (it's
  sound-neutral, so this would indicate a propagation/prune bug introduced while
  stripping CDCL plumbing) → STOP, bisect the strip, restore the exact rule
  behavior. Never ship an unsound solver.
- **Constraint-focused rule cannot solve the realistic ≤20×20 band** in budget
  → revisit the heuristic (add bounded lookahead-for-branching) before
  considering scope changes; this is the core deliverable.

## Out of scope (YAGNI)

- Clause learning / nogood caching (the measured reason CDCL failed — do not
  reintroduce).
- Restarts (they discard chain progress; a complete DFS doesn't need them).
- Changes to `getStepwiseHint` (deductive Hint keeps its own lookahead).
- Full 40×40 auto-solve (bounded success criteria — partial is the contract).
- Any widget / page-interaction / bundler change beyond the doc-reference update.
