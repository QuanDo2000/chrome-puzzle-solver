# Shingoki CDCL solver — design

**Status:** approved (brainstorm)
**Date:** 2026-06-01
**Builds on:** the Shingoki solver-performance work (trail-undo T1 + connectivity
pruning T2, both committed and sound) — see
`docs/superpowers/specs/2026-06-01-shingoki-solver-performance-design.md`.
**Reference:** `SlitherlinkSolver`'s CDCL (`src/solvers/slitherlink.js`) — a
working, documented CDCL for the analogous loop puzzle in this codebase.

## Summary

Give `ShingokiSolver` a CDCL (conflict-driven clause learning) search engine so
it solves boards plain DFS cannot, returning a best-effort **partial** when it
still times out. CDCL lives as in-solver methods on `ShingokiSolver`, reuses the
existing sound `_propagate` rules as the propagator, and runs **without
1-step lookahead inside search** (the documented Slitherlink trap).

## Honest expectations (read first — this is NOT a guaranteed full-solve)

Slitherlink's mature CDCL (first-UIP, VSIDS, Luby restarts, clause learning)
**does not solve its own 50×40 monthly board** — it times out and returns a
~38% partial (see slitherlink.js performance notes). So the Shingoki 40×40
monthly **may also not fully solve**. The committed success criteria are:

1. **Soundness (absolute gate):** never a wrong solution and never spurious
   UNSAT (`'no solution'`) on a solvable board. Only `solved:true` or
   `'time limit exceeded'` (with a partial).
2. **Extended range:** boards in the ~15×15–25×25 band that currently time out
   should now solve.
3. **Better partial:** on the 40×40, return substantially more than today's ~3%
   deduced.
4. **No regression:** boards ≤10×10 stay fast and correct.

Full 40×40 auto-solve is a hoped-for bonus, NOT a pass/fail gate. If CDCL gives
no measurable range extension over DFS+T1+T2, we ship partial-on-timeout alone
(see Risk Gates).

## Architecture

CDCL as in-solver methods on `ShingokiSolver` (mirroring `SlitherlinkSolver`;
NOT a shared cross-puzzle abstraction — the puzzles' models differ and we won't
destabilize the working Slitherlink CDCL). Components:

### Variable model
Each edge is one boolean variable. `_varId('H', r, c) = r*cols + c`
(range `[0, numH)` where `numH = (rows+1)*cols`);
`_varId('V', r, c) = numH + r*(cols+1) + c`. `_decodeVar(id)` inverts it.
**true = LINE (edge value 1)**, **false = CROSS (edge value 2)**, unassigned =
unknown (0). `setEdge` already mediates all edge writes — the single chokepoint
to instrument.

### Trail + reasons (extends the T1 trail)
The T1 trail records `(kind,r,c,prev)` per write. Add a parallel `_reasons[]`
and `_decisionLevels[]`. When a propagation rule forces an edge it sets
`this._currentReason = [varId, ...]` (the antecedent vars) BEFORE calling
`setEdge`; `setEdge` pushes that reason. A **decision** (CDCL branch) pushes
`null` as the reason and bumps the level. Rollback pops trail + reasons + levels
together.

### Reason discipline (make-or-break)
Every forcing site in `_propagate` sets `_currentReason` to the EXACT
edges/clue that entailed the force:
- degree rule (2 lines → cross rest): reason = the 2 incident line vars.
- white/black shape: reason = the known line var(s) + the clue.
- axis forcing: reason = the crossed/border edges that killed the other axis +
  the clue.
- run-cap: reason = the confirmed run's edge vars + the clue.
Loose reasons = weak learned clauses = no speedup (Slitherlink's documented
lesson). Threaded rule-by-rule; unit-tested that each force carries the right
antecedents.

### Propagation = existing rules, NO lookahead
`_cdclSearch` calls the same `_propagate` fixpoint (degree/shape/axis/run-cap/
connectivity) — already proven sound. NO `_lookahead1` inside search
(Slitherlink found lookahead-in-CDCL produces spurious UNSAT — its biggest
pitfall). A `_propagate` contradiction raises a conflict.

### Conflict analysis → learn → backjump
Port `_analyzeConflict`: walk the implication graph from the conflict, first-UIP
cut, produce a learned clause (`~v1 ∨ ~v2 ∨ …`), compute the backjump level, pop
the trail to it, assert the learned clause's unit literal. INCLUDE Slitherlink's
subsumption pre-pass + rescue-path refinements (its notes warn omitting them
yields empty-but-not-empty clauses that backjump-to-0 wrongly).

### VSIDS + Luby restarts + clause store
- VSIDS: `Float32Array` activity scores, decay 0.95 every 256 conflicts.
  `_pickDecisionLiteral` returns highest-score unassigned. Caller MUST use a
  separate `_allEdgesAssigned()` check — var 0 is real (H-edge 0), can't be the
  all-assigned sentinel.
- Luby restarts: `_lubyNext(idx)` canonical sequence; restart pops trail to
  level 0, keeps learned clauses + VSIDS scores.
- Learned-clause store with an LRU cap (~5000) to bound memory.

### Connectivity in CDCL
The single-loop constraint (`_deadByConnectivity`, `_hasPrematureLoop`, leaf
`_isValidComplete`) stays as a CHECKER, run at the propagate fixpoint and at the
leaf. A connectivity conflict can't always produce tight var-reasons, so — like
Slitherlink's lookahead double-fail — it blames the MOST-RECENT current-level
DECISION (chronological semantics): learn `~lastDecision`, backjump one level.
Rule-level conflicts (with well-formed reasons) drive normal first-UIP learning.

### Partial-on-timeout
On `maxMs`, `solve()` returns `{solved:false, horizontal:null, vertical:null,
partial:{horizontal,vertical}, error:'time limit exceeded'}` — the deduced
snapshot at the best point reached. The widget gains a partial Solve branch
(mirror Slitherlink's `partialResultArm`: "Partial: N edges deduced, finish
manually").

## What T1/T2 contribute
The T1 trail becomes the CDCL trail (extended with reasons/levels). T2
connectivity pruning + all propagation rules become CDCL's propagator unchanged.

## Files

- `src/solvers/shingoki.js` — all CDCL machinery + `_cdclSearch`; `solve()`
  switches to call it; partial-on-timeout return.
- `src/widget/puzzles/shingoki.js` — partial Solve branch (`partialResultArm`
  or equivalent), mirroring slitherlink.
- `tests/shingoki.test.js` — per-component unit tests + differential +
  no-spurious-UNSAT + regression.
- `tests/bench-shingoki.js` — extend to a board-size ladder (10/15/20/25×25 +
  the 40×40) for the range measurement.
- Possibly `solver.worker.js` / `handler.js` if the partial return shape needs
  threading (mirror slitherlink's partial path).

## Testing

**Soundness (absolute gate):**
- Constructive fuzz (5×5/8×8/10×10) stays 100% green — master guard; a spurious
  UNSAT makes a fuzz board `solved:false` → instant red.
- Differential: for boards the OLD DFS solves, new CDCL returns a solution that
  passes `numbersSatisfied` (not necessarily the identical loop — solutions can
  be non-unique — but always valid).
- Per-component units: var encode/decode round-trip; reason tracking (forced
  edge carries correct antecedent vars); `_analyzeConflict` clause excludes the
  conflict; Luby sequence; restart preserves learned clauses.
- **No-spurious-UNSAT test:** known-solvable boards never return `'no solution'`
  — only `solved:true` or `'time limit exceeded'`. THE Slitherlink trap; explicit
  guard.

**Performance / range:**
- Bench ladder (10/15/20/25×25 + real 40×40) records solve time + solved/partial
  after the engine works. Finds the new solvable ceiling.
- Success = extended range + better 40×40 partial + no small-board regression.
- Regression guard: ≤10×10 boards stay fast (CDCL overhead can't slow easy
  boards) — bench asserts.

## Risk gates (explicit stop conditions)

- **Spurious UNSAT that reason-discipline can't fix** → STOP, fall back to
  "DFS + partial-on-timeout" (still a real improvement). Never ship an unsound
  solver.
- **No measurable range extension over DFS+T1+T2** → STOP, ship
  partial-on-timeout alone (much smaller change). The bench ladder decides
  objectively.

## Execution

Subagent-driven; each component (var encoding, reason threading, conflict
analysis, VSIDS/restarts, integration, partial-on-timeout) gets spec +
ADVERSARIAL soundness review, with fuzz + differential + no-spurious-UNSAT as
objective gates after every step. Build incrementally: a working
CDCL-without-learning skeleton first (correct but slow), then add learning,
VSIDS, restarts — measuring at each step so a regression to spurious UNSAT is
caught immediately.

## Out of scope (YAGNI)

- Shared cross-puzzle CDCL abstraction (in-solver, Shingoki-specific).
- Lookahead inside CDCL search (the documented trap).
- Guaranteeing a full 40×40 solve (bounded success criteria above).
- Any change to the deductive Hint (`getStepwiseHint` keeps its own lookahead —
  it's not in the CDCL search path).
