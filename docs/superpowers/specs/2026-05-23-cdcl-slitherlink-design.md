# CDCL search for SlitherlinkSolver — design

**Date:** 2026-05-23
**Status:** Approved design, pre-implementation
**Target:** Hard 50×40 Slitherlink boards (`puzzles-mobile.com/loop/special/monthly`-class) solve to a unique solution in ≤5 s wall, without regressing the 30×30 daily (≤2 s).

## 1. Summary

Add a Conflict-Driven Clause Learning (CDCL) search engine to
`SlitherlinkSolver` in `solver.js`. Replaces chronological backtracking
(`_backtrack`) with non-chronological backjump driven by first-UIP
conflict analysis, learned-clause propagation, VSIDS variable ordering,
and Luby restarts. All existing propagation layers (clue, vertex,
advanced patterns, color, connectivity, parity, lookahead) are preserved
and become *implication generators* — they supply reasons for each
forced assignment, which the CDCL machinery uses to derive learned
clauses.

The existing solve path is unchanged for puzzles that finish in
propagation (daily and smaller weeklies). CDCL only kicks in when
`_backtrack` would have — i.e., when initial propagate + lookahead
leaves UNKNOWN edges/cells.

## 2. Variables and clauses

### Variable encoding

Each variable is binary. IDs are integers in `[0, totalVars)`:

```
H edges:    [0,                          numH)
V edges:    [numH,                       numH + numV)
Cell colors:[numH + numV,                totalVars)
```

Where `numH = (H+1) * W`, `numV = H * (W+1)`, `cellCount = H * W`,
`totalVars = numH + numV + cellCount`.

Three helpers map between (kind, idx) and variable ID:

```js
_varIdEdge(kind, idx) // kind 'H' | 'V'
_varIdCell(idx)       // cellIdx = r * W + c
_decodeVar(varId)     // returns { kind: 'H' | 'V' | 'C', idx }
```

Literal encoding: positive integer for *true* sense, negative for
*false* sense. Standard SAT convention: `+v` = "variable v is true",
`-v` = "variable v is false". The mapping to our 3-valued
edge/color encoding:

- Edge var `+v` ↔ LINE; `-v` ↔ EMPTY. UNKNOWN = unassigned.
- Cell var `+v` ↔ INSIDE; `-v` ↔ OUTSIDE. UNKNOWN = unassigned.

### Clauses

A clause is a disjunction of literals; satisfied iff ≥1 literal is true;
*unit* iff exactly one literal is unassigned and the rest are false (that
literal is then forced).

Two clause sources:

- **Implicit:** any existing rule, when it forces a variable, implicitly
  generates a clause "if [antecedent assignments], then [forced
  assignment]". We don't store these — we capture only the *reason* (the
  antecedent variable IDs) for each forced assignment.
- **Learned:** output of first-UIP conflict analysis, stored in
  `_learnedClauses[]` as arrays of literals.

## 3. Reason tracking

### Data structures

```js
// Parallel to this.trail (existing).
// _reasons[i] === null  ⇒ trail entry i is a decision.
// _reasons[i] === [v1, v2, ...] ⇒ trail entry i was forced by a rule
//                                  with those antecedent variable IDs.
this._reasons = [];

// One decision level per trail entry. Decisions increment.
this._decisionLevels = [];

// Current decision level.
this._decisionLevel = 0;

// _currentReason: set by a rule before calling _setEdge/_setColor;
// the setters capture it into _reasons[] and reset to null.
this._currentReason = null;
```

### Instrumentation

Every existing rule needs to set `this._currentReason` before each force.
The complete set of force sites:

- `_applyClueRuleAt(r, c, onChange)` — antecedents = the variable IDs of
  the cell's other edges that are non-UNKNOWN (the m + n − 1 ones that
  triggered the force) plus the clue value (implicit, not a variable).
- `_applyVertexRuleAt(r, c, onChange)` — antecedents = the vertex's
  other incident edges that are non-UNKNOWN.
- `_applyCornerThree(corner, onChange)`, `_applyCornerOne(corner, onChange)` —
  empty antecedents (the rule fires from clue+geometry alone).
- `_applyAdjacentThreeH(r, c, onChange)`, `_applyAdjacentThreeV(r, c, onChange)` —
  empty antecedents.
- `_applyDiagonalThree(r, c, dr, dc, onChange)` — empty antecedents.
- `_propagateColors` (three sub-rules):
  - edge → color: antecedents = the edge variable + the known endpoint
    color variable (if any).
  - color → edge: antecedents = both endpoint color variables.
  - clue × color: antecedents = the own-color variable + the m + u − 1
    other neighbor colors that triggered the force.
- `_propagateConnectivity`:
  - reachability force: antecedents = the BFS frontier — variables of
    cells along the path that was cut off. *Practical simplification:*
    use the snapshot of all known-OPPOSITE colors (over-approximation;
    yields more general learned clauses but easier to compute).
  - articulation cut: antecedents = the placed-color cells on either
    side of the cut.
- `_propagateParity` — antecedents = the n − 1 known edges in the scan
  whose parity drove the force.
- `_applyLookahead` — antecedents from BOTH probe contradiction reasons;
  the lookahead force says "value X must be Y because both X-LINE and
  X-EMPTY contradict". Reason = union of the two contradiction reasons.
- `_propagateLearnedClauses` (new): antecedents = the falsified literals
  in the clause.

For rules with "empty antecedents" (corner/adjacent/diagonal patterns
based purely on clue geometry), the reason is the empty list — these
assignments are valid at decision level 0 always and never participate
in a conflict analysis chain (any conflict involving them is unsolvable
in any branch).

## 4. Conflict analysis (first-UIP)

When `propagate()` returns false, the rule that detected the contradiction
records the *conflict reason* — the antecedent set of the rule, as if it
had forced an impossible value.

The first-UIP algorithm:

```
function analyzeConflict(conflictReason):
    learned = set of literals derived from conflictReason
    seen = bitset over variables, marking "at current level, already processed"
    pathCount = number of unresolved current-level literals in learned

    Walk trail backward from top:
        Take the most-recent assignment that's in `learned`:
            if its decision level < currentDecisionLevel:
                keep it in `learned` (it'll appear in the final clause)
                continue
            else (at current level):
                pathCount -= 1
                if pathCount == 0:
                    UIP found — this is the unique-implication-point
                    learned ∪= { negation of this assignment }
                    return learned
                else:
                    resolve: replace this literal with its reason
                    add reason literals (negated) to learned, marking new
                    pathCount += (number of new current-level literals)
                    continue
```

The output is a learned clause: exactly one literal at the current
decision level (the UIP), plus zero or more literals at earlier levels.

### Edge cases

- Decision-level-0 conflict ⇒ the puzzle has no solution. Return
  contradiction up to `solve()`, which already handles "no solution"
  (returns `{ solved: false, error: 'no solution found' }`).
- Empty reason at current level ⇒ the conflict involves only earlier-
  level decisions; backjump to the deepest of those levels.

## 5. Backjump + learned clauses

After deriving the learned clause:

```
backjumpLevel = max decision level among non-UIP literals in the clause
               (or 0 if the clause has only the UIP)
```

Pop the trail back to `backjumpLevel`: roll back every assignment whose
`_decisionLevels[i] > backjumpLevel`. Decrement `_decisionLevel` to
`backjumpLevel`. The learned clause is now *unit* at the new level (all
literals false except the UIP, which is unassigned by the pop), so it
immediately forces the UIP's negation as the next assignment.

Add the learned clause to `_learnedClauses[]`. Resume propagation from
the new state.

### Learned clause storage

```js
this._learnedClauses = [];       // [{ literals: int[], activity: number }, ...]
this._maxLearnedClauses = 5000;
```

When `_learnedClauses.length >= 5000`, drop the lowest-activity quarter
(LRU on activity scores). Activity bumps each time the clause is used
for propagation or conflict analysis; decays alongside VSIDS.

### Learned clause propagation

New propagator joins the fixpoint:

```js
_propagateLearnedClauses(onChange) {
  for (const clause of this._learnedClauses) {
    let unassignedCount = 0, unassignedLit = 0;
    let satisfied = false;
    for (const lit of clause.literals) {
      const v = this._varValue(Math.abs(lit));
      if (v === 0) { unassignedCount++; unassignedLit = lit; }
      else if ((v > 0) === (lit > 0)) { satisfied = true; break; }
    }
    if (satisfied) continue;
    if (unassignedCount === 0) return false; // contradiction
    if (unassignedCount === 1) {
      this._currentReason = clause.literals.filter(l => l !== unassignedLit).map(l => Math.abs(l));
      if (!this._forceLiteral(unassignedLit)) return false;
      onChange();
      clause.activity += 1;
    }
  }
  return true;
}
```

The propagator runs in the fixpoint after `_propagateParity` (existing
order: clue → vertex → advanced → colors → connectivity → parity →
learned).

## 6. VSIDS

```js
this._vsidsScores = new Float32Array(totalVars);
this._vsidsDecay = 0.95;
this._vsidsDecayInterval = 256;  // conflicts between decays
this._vsidsConflictsSinceDecay = 0;
```

On each conflict, bump every variable in the learned clause by 1.
Every 256 conflicts, multiply all scores by 0.95. Ties broken by lowest
variable ID for determinism.

Decision picker: scan unassigned variables (linear scan — fine at our
totalVars ~6000), pick highest score. Replaces `_pickEdge` / `_pickCell`
during CDCL search.

For the first decision (no conflicts yet), fall back to existing
heuristics (`_pickCell` then `_pickEdge`) so we don't pick arbitrarily.

## 7. Restart policy

Canonical Luby sequence (0-indexed):
`[1, 1, 2, 1, 1, 2, 4, 1, 1, 2, 1, 1, 2, 4, 8, 1, 1, 2, ...]`
multiplied by `RESTART_UNIT = 100` conflicts. Implementation
(Knuth, AofA Vol 4A §7.2.2.2; 1-indexed `k = idx + 1`):

```js
_lubyNext(idx) {
  let k = idx + 1;
  for (;;) {
    let n = 1;
    while ((1 << n) - 1 < k) n++;
    if (k === (1 << n) - 1) return 1 << (n - 1);
    k = k - (1 << (n - 1)) + 1;
  }
}
```

At each restart: pop trail to decision level 0, keep all learned clauses
and VSIDS scores. The retained learned clauses guide propagation
immediately, often determining many variables before the next decision
is needed.

## 8. Integration

```js
solve() {
  // ... existing cache + partial cache checks unchanged ...
  this._startedAt = Date.now();
  this._timedOut = false;

  if (!this.propagate()) {
    // ... existing timeout / contradiction handling ...
  }
  if (this._allEdgesAssigned()) {
    this._dsuRebuild();
    if (this._checkSingleLoopComplete()) {
      const out = this._emit();
      this._storeInCache(key, out);
      return { solved: true, horizontal: out.horizontal, vertical: out.vertical };
    }
    // ... existing invalid-grid handling ...
  }

  // Was: if (this._backtrack()) { ... }
  // Now:
  if (this._cdclSearch()) {
    const out = this._emit();
    this._storeInCache(key, out);
    return { solved: true, horizontal: out.horizontal, vertical: out.vertical };
  }

  // ... existing partial-on-timeout path unchanged ...
}
```

`_cdclSearch()`:

```js
_cdclSearch() {
  let conflictsSinceRestart = 0;
  let lubyIdx = 0;
  let restartLimit = this._lubyNext(lubyIdx) * 100;

  while (true) {
    if (this._budgetExceeded()) return false;

    // Pick a decision.
    const lit = this._pickDecisionLiteral();
    if (lit === 0) {
      // All variables assigned — verify final loop and return.
      this._dsuRebuild();
      return this._checkSingleLoopComplete();
    }

    this._decisionLevel++;
    this._currentReason = null;  // decisions have no reason
    if (!this._forceLiteral(lit)) {
      // Couldn't assign — treat as conflict at this level.
      // (Shouldn't happen because we picked an unassigned variable.)
      return false;
    }

    while (!this.propagate()) {
      // Conflict.
      conflictsSinceRestart++;
      this._totalConflicts++;
      if (this._decisionLevel === 0) return false;  // unsolvable

      const conflictReason = this._lastConflictReason;
      const learned = this._analyzeConflict(conflictReason);
      const backjumpLevel = this._computeBackjumpLevel(learned);

      this._backjumpTo(backjumpLevel);
      this._addLearnedClause(learned);
      this._bumpVsids(learned);
      this._decayVsidsIfDue();

      if (conflictsSinceRestart >= restartLimit) {
        this._restart();
        conflictsSinceRestart = 0;
        lubyIdx++;
        restartLimit = this._lubyNext(lubyIdx) * 100;
      }
    }

    // propagate() succeeded — continue with next decision.
  }
}
```

The partial-cache path is unchanged; if CDCL itself times out, the
existing `_emit()` snapshot is returned as partial.

## 9. Tests + bench

### Unit tests

- **Reason capture:** assign edges via a known rule path, verify
  `_reasons[trail.length - 1]` contains the expected antecedent set.
- **First-UIP:** construct a 3-decision chain with a known conflict;
  verify the derived learned clause has exactly one current-level
  literal.
- **Backjump correctness:** assert `this._decisionLevel` after
  `_backjumpTo(k)` equals `k`, and the trail's top entries are all at
  level ≤ `k`.
- **Learned-clause propagation:** seed a learned clause manually, verify
  it forces the unassigned literal when all others are false.
- **VSIDS:** bump a few variables, verify decision picker selects the
  highest-scoring unassigned variable.
- **Restart:** count conflicts, verify restart pops to level 0 and
  retains learned clauses.

### Integration tests

- **Daily regression gate:** `tests/solver.test.js` — captured 30×30
  daily solves in ≤2 s, identical solution to current.
- **Monthly:** new test — captured 50×40 monthly (the one we have)
  solves in ≤5 s, with a deep-validated solution (run the existing
  fuzz validator against it).
- **5×5 fixture:** still solves identically.

### Bench

- `tests/bench-slitherlink.js` augmented: in addition to the captured
  5×5, include 2-3 more captured monthlies (TBD — ask user to dump).
- All bench puzzles must `solved === true` within their declared
  budget; bench fails otherwise.

### Fuzz

- Existing `tests/slitherlink-fuzz.test.js` continues to pass.
- Add a "hard fuzz" using 20×20+ random rectangle-loops as ground
  truth, with random clue masking. CDCL should handle these reliably.

## 10. Risks + mitigations

- **Reason-instrumentation gaps.** Easy to miss a force path; silent
  CDCL incorrectness if a forced assignment has no reason recorded.
  Mitigation: a debug assertion at every `_setEdge`/`_setColor` site
  that `this._currentReason !== null` during propagation (decisions
  set it to `null` explicitly). Off in production builds via a flag.

- **Learned clause explosion.** Mitigation: 5k cap with LRU-on-activity
  eviction. Activity decays alongside VSIDS.

- **Daily regression.** CDCL only kicks in when `_backtrack` would
  have. Initial propagate fully solves the daily today — CDCL never
  fires. Regression gate test enforces this.

- **Restart nondeterminism.** None — Luby sequence is deterministic,
  no randomization. Same input ⇒ same output ⇒ reproducible bench.

- **VSIDS picks a bad first variable.** For the very first conflict
  (no scores yet), fall back to existing `_pickCell` / `_pickEdge`
  heuristics. After that, VSIDS guides.

- **`_propagateLearnedClauses` cost on large clause sets.** O(C·L)
  per propagation pass where C = clause count, L = avg literals.
  At cap (5k clauses × ~10 literals) that's 50k ops per pass —
  cheap. If profiling shows otherwise, add 2-watched-literals (out of
  scope for v1).

## 11. Out of scope

- **2-watched literals.** Performance optimization for huge clause sets.
  Premature at our scale.
- **Clause minimization.** Cleanup heuristic (remove redundant literals
  from learned clauses via subsumption against earlier antecedents).
  Modest perceived gain, defer.
- **Pure-literal elimination.**
- **Random restart seeds.** Determinism > diversity for this codebase.
- **Multiple captured monthlies in this design.** The plan can ask the
  user to dump a couple more; the implementation can ship with just
  the existing one and bench-fail gracefully on unsolved.

## 12. Open questions for the plan

- File organization: keep CDCL inside `solver.js` or extract to
  `cdcl.js`? Decision deferred to the implementation plan — depends on
  final line count.
- Whether to expose `_cdclEnabled` as an instance flag so tests can
  selectively disable CDCL. Probably yes; cheap and useful.
- The conflict-reason capture for `_propagateConnectivity` is described
  as a "snapshot of all known-opposite colors" — this is correct but
  loose. Tightening it (using only the BFS-cut path) is a future
  optimization; the loose version generates more general learned
  clauses, which doesn't harm correctness.
