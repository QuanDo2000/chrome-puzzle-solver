'use strict';

// SlitherlinkSolver — pure logic for Slitherlink loop puzzles.
//
// Internal edge encoding: `0=UNKNOWN, 1=LINE, 2=EMPTY` (passthrough to page
// encoding; user-drawn ×s are meaningful signal, not dropped). See
// `src/widget/puzzles/slitherlink.js` for the page-side encoding and the
// content-script integration (apply, diff, loop done-check, partial routing).
//
// === Trail-based undo ===
//
// Trail uses a 2-bit kind field per entry: `(kind << 24) | idx` for edges
// (`kind` 0=H, 1=V), or `(oldColor << 26) | (2 << 24) | idx` for cell color
// writes. `_rollback` dispatches on `(e >> 24) & 3`. Edge writes don't trail
// old value (`_setEdge` rejects overwrite of non-UNKNOWN); color writes do
// (need to know which slot to restore).
//
// === Propagation fixpoint (cheapest first) ===
//
// 1. `_propagateClues` — `m > k` or `m + n < k` → contradiction; `m == k` →
//    remaining UNKNOWN → EMPTY; `m + n == k` → remaining UNKNOWN → LINE.
// 2. `_propagateVertices` — every dot's loop-degree ∈ {0, 2}; per-dot
//    `lineCount`/`unknownCount` (Int16Array) maintained incrementally.
// 3. `_propagateAdvanced` — corner-3, corner-1, adjacent 3-3 (H+V), diagonal
//    3-3 (all 4 orientations). Each via per-instance helper (so
//    `_findNextHintDeduction` can dispatch individually).
// 4. `_propagateColors` — inside/outside cell coloring (`this.colors`
//    `Uint8Array(H*W)`, 0=UNKNOWN/1=INSIDE/2=OUTSIDE; out-of-grid = OUTSIDE).
//    Sub-rules: (a) known edge → adjacent cells differ iff LINE; (b) known
//    colors → edge state; (c) clue × own-color → forced opposite/same colors
//    on neighbours. Writes via `_setColor` (trailed).
// 5. `_propagateConnectivity` — `_slApplyInsideReachability` BFS-floods from
//    known-INSIDE through `{INSIDE ∪ UNKNOWN}` forcing unreachable cells to
//    OUTSIDE; `_slApplyOutsideReachability` from virtual exterior root
//    (border cells); `_slApplyCut` iterative-Tarjan articulation analysis
//    **INSIDE only** — OUTSIDE-cut is unsound (OUTSIDE can connect via plane
//    exterior even when cell-graph-disconnected; rectangle-loop
//    counterexample). All guarded by `!_inLookahead` to keep inner probe cheap.
// 6. `_propagateParity` — every straight scan line crosses the loop an even
//    number of times. Horizontal scan at `y=R+0.5` crosses `V[R][.]` edges;
//    vertical at `x=C+0.5` crosses `H[.][C]`. 0 unknowns + odd LINE →
//    contradiction; 1 unknown → forced to make even.
//
// Subloop prevention via union-find over LINE-edge endpoints. DSU **rebuilt
// from scratch** at the two callsites needing it (`propagate()` post-fixpoint,
// `_backtrack()` at completion) — incremental maintenance under backtracking
// is fiddly, rebuild is O(LINE_count). Multi-loop detection at fixpoint is
// deferred to final completion check (unknowns may remain legitimately in
// degree-0 disconnected regions); final check enforces all clues exact, no
// UNKNOWN edges, every dot degree 0/2, all LINE edges in one component.
//
// After fixpoint, `propagate()` runs **1-step lookahead** (`_applyLookahead`)
// at `_depth === 0` and `!_inLookahead` — probe each candidate UNKNOWN edge
// (and selected cells), run lookahead-free inner propagate, force surviving
// value on single-side contradictions. Candidate filter: edges adjacent to
// tight dots/clues only.
//
// Most-constrained variable pick at backtrack: score each UNKNOWN edge as
// `10 * max(lineCount[u], lineCount[v]) - min(unknownCount[u], unknownCount[v])`
// (higher = more constrained). Init `bestScore = -Infinity` (blank-board
// scores are negative). Branch LINE first, then EMPTY.
//
// === Partial results ===
//
// Hard boards (e.g. 50×40 monthly) time out but propagation gives a useful
// chunk. `solve()` returns `{solved: false, partial: true, horizontal,
// vertical, error: 'timed out'}` on either timeout. Two static caches:
// `_solutionCache` (50-entry LRU, full solutions, keyed FNV-1a of
// `(width, height, task)`); `_partialCache` (20-entry LRU, partial
// snapshots, same key — partial cache hit short-circuits propagate, saves 3–7
// s per Hint/Loop on monthly-class after the first timeout).
// `clearSolutionCache()` clears BOTH (keep tests deterministic).
//
// Worker budget is **10 s** (not 30) — partial-return fires sooner on too-hard
// boards so the user gets visible progress in ~10 s.
//
// `getHint(curH, curV)` seeds probe solver from live edge state, runs
// `_findNextHintDeduction(minLines)` where `minLines = max(3, ceil(H*W/30))`
// (scales batch with area so Loop completes in ~10 s wall regardless of size;
// see [[hint-batch-scaling-for-loop]]). Inner propagate at `_depth = 1` (skips
// lookahead — too expensive per click); collects forced LINE edges from trail
// until reaching `minLines`, then rolls back. Falls back to tight-budget
// `solve()` (capped `min(this.maxMs, 5000)` ms) returning partial. Probe sets
// `_startedAt = Date.now()` so inherited `maxMs` doesn't fire spuriously.
//
// === CDCL search ===
//
// `solve()` calls `_cdclSearch()` (CDCL with first-UIP, non-chronological
// backjumping, VSIDS branching, LRU learned-clause storage cap 5000, Luby
// restarts RESTART_UNIT=100). `_backtrack` kept as dead code for reference;
// don't delete without first replacing `_cdclSearch`.
//
// - **Variable encoding** — `_varIdEdge('H'|'V', idx)`, `_varIdCell(idx)`,
//   `_decodeVar`. H edges `[0, numH)`, V `[numH, numH+numV)`, cells
//   `[numH+numV, totalVars)`.
// - **Literals** — `~lit` convention: `lit >= 0` is positive (LINE/INSIDE),
//   `lit < 0` is negative (EMPTY/OUTSIDE), `varId = lit >= 0 ? lit : ~lit`.
//   **Never `Math.abs(lit)` or `-lit`** — variable 0 is real and arithmetic
//   negation is ambiguous.
// - **Reason tracking** — `_setEdge/_setColor` push `_currentReason` (set by
//   rule helpers before forcing) into `_reasons[]` parallel to `this.trail`.
//   Decisions push `null`. `_decisionLevels[]` tracks level.
// - **Conflict analysis** — `_analyzeConflict` is classic first-UIP plus two
//   non-textbook additions: (1) subsumption pre-pass — current-level conflict
//   vars whose reasons reference other current-level conflict vars marked
//   "subsumed" so they don't double-count toward `pathCount`; (2) rescue path —
//   if all current-level vars are subsumed (seeding leaves `pathCount === 0`),
//   walk trail backward to most recent current-level seen var and clear its
//   subsumed flag. Without rescue, lookahead-driven contradictions produce
//   empty-but-not-empty learned clauses that backjump-to-0 incorrectly.
// - **VSIDS** — `Float32Array` scores, decay 0.95 every 256 conflicts.
//   `_pickDecisionLiteral()` returns highest-score unassigned. **Caller MUST
//   `_allEdgesAssigned()`-check separately** — literal 0 is valid (H-edge
//   0/LINE), so can't be used as "all-assigned" sentinel.
// - **Luby restarts** — `_lubyNext(idx)` returns the canonical Luby sequence
//   (Knuth AofA Vol 4A §7.2.2.2): `[1,1,2,1,1,2,4,1,1,2,1,1,2,4,8,...]`.
//   Standard 1-indexed recurrence (the spec's iterative formula
//   non-terminates on `idx===1`). Restarts pop trail to level 0, keep
//   learned clauses + VSIDS.
//
// **Performance envelope** (2026-05-23):
//
// | board                     | path             | wall time         |
// | ---                       | ---              | ---               |
// | 5×5 real                  | propagate alone  | ~0.6 ms median    |
// | 30×30 synthetic-rect      | propagate alone  | ~200 ms           |
// | 50×40 monthly real        | times out, partial | 30 s (budget)   |
//
// 50×40 monthly currently **does not solve** within 10 s (or 30 s in bench).
// Returns partial with ~38% edges deduced. Bottleneck: `_applyLookahead` ~750
// ms per call caps CDCL at ~40 conflicts/s — too few for a 2000-edge puzzle.
//
// Fixture `slitherlinkRealMonthly50x40_a` carries `expectSolved: false` so
// bench records timing without failing. The `tests/solver.test.js` integration
// test asserts only **soundness** (not spurious `error: 'no solution found'`),
// not solvedness. Tighten when a real perf fix lands.
//
// **Lookahead/CDCL composition constraint.** `_applyLookahead`'s double-fail
// (both LINE and EMPTY probes contradict) **cannot** use probe-collected
// antecedents as a CDCL conflict reason: those vars are rolled back below the
// analysis point, so `_analyzeConflict` sees them as level 0 and learns
// nothing. Instead, the double-fail handler blames **the most recent
// current-level decision** (chronological-backtrack semantics). Learned
// clause `~lastDecision`, backjump pops one level, next propagate forces
// opposite sense. Rule-level conflicts (with well-formed reasons that survive
// rollback) still drive normal first-UIP learning.
//
// === Approaches ruled out for the monthly perf gap ===
//
// Tried during CDCL build (2026-05-23):
//
// - **Disable lookahead inside `_cdclSearch` (`_depth = 1`)**: per-propagate
//   cheap (~5 ms), CDCL accumulates hundreds of conflicts. But rule set
//   without lookahead is too weak — converges to *spurious UNSAT*
//   (`error: 'no solution found'`) on known-solvable boards.
// - **Use probe-collected antecedents as CDCL conflict reason on
//   double-fail**: vars rolled back below `_analyzeConflict`'s reach, UIP
//   walk learns empty clauses. Source of the spurious UNSAT pre-fix.
// - **Use "all current-level decisions" as conflict reason on double-fail**:
//   wide learned clauses `~d1 ∨ ~d2 ∨ ... ∨ ~dk` prune huge swaths; CDCL
//   falsely concludes UNSAT after ~10 conflicts.
// - **Per-edge `_lookaheadClean` cache + adjacent-cell dirty tracking**:
//   unsound — parity scans full rows/columns and connectivity BFSes across
//   the entire cell graph. Far-away edge changes flip probe outcomes
//   without dirtying any cell adjacent to the probed edge, so cache-skip
//   admits stale results. Manifests as fuzz failures and false UNSAT.

class SlitherlinkSolver {
  /**
   * @param {{
   *   width: number,
   *   height: number,
   *   task: number[][],
   *   initialState?: { horizontal: number[][], vertical: number[][] },
   *   maxMs?: number,
   * }} opts
   */
  constructor({ width, height, task, initialState, maxMs }) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new Error('SlitherlinkSolver: width/height must be positive integers');
    }
    if (!Array.isArray(task)) {
      throw new Error('SlitherlinkSolver: task must be an array');
    }
    this.width = width;
    this.height = height;
    this.task = task.map(row => (Array.isArray(row) ? row.slice() : []));
    this.maxMs = maxMs | 0;
    this._startedAt = 0;
    this._timedOut = false;
    // Lookahead / backtracking depth control.
    this._depth = 0;
    this._inLookahead = false;

    // CDCL variable counts. Must be set after width/height.
    const _W = width, _H = height;
    this.numH = (_H + 1) * _W;
    this.numV = _H * (_W + 1);
    this.cellCount = _H * _W;
    this.totalVars = this.numH + this.numV + this.cellCount;

    const W = width, H = height;
    // (H+1) * W horizontal edge slots; H * (W+1) vertical edge slots.
    this.H = new Uint8Array((H + 1) * W);
    this.V = new Uint8Array(H * (W + 1));

    // Cell colors: 0 = UNKNOWN, 1 = INSIDE, 2 = OUTSIDE.
    // The loop divides the plane into inside/outside; adjacent cells sharing an
    // edge differ in color iff that edge is LINE.
    this.colors = new Uint8Array(H * W);

    // Trail entries encoding (2-bit kind in bits 24-25):
    //   kind=0 (H edge): (0 << 24) | idx
    //   kind=1 (V edge): (1 << 24) | idx
    //   kind=2 (color):  (oldColor << 26) | (2 << 24) | idx
    // oldColor ∈ {1=INSIDE, 2=OUTSIDE} (UNKNOWN=0 is never trailed).
    // Edge entries: old value is always 0 (UNKNOWN) so we don't trail it.
    this.trail = [];

    // ── CDCL reason tracking (parallel to this.trail) ────────────────────
    // _reasons[i]: null = decision; [...varIds] = propagation antecedents.
    // _decisionLevels[i]: decision level at the time of the trail entry.
    this._reasons = [];
    this._decisionLevels = [];
    // Current search decision level (0 = top-level propagation).
    this._decisionLevel = 0;
    // Set by a rule helper before it calls _setEdge/_setColor so those
    // setters can capture the reason. Decisions set it to null explicitly.
    this._currentReason = null;

    // Learned clause storage (CDCL).
    this._learnedClauses = [];       // [{ literals: int[], activity: number }]
    this._maxLearnedClauses = 5000;
    this._lastConflictReason = null; // set by any rule that returns false
    this._vsidsScores = new Float32Array(this.totalVars);
    this._vsidsDecay = 0.95;
    this._vsidsDecayInterval = 256;
    this._vsidsConflictsSinceDecay = 0;
    this._totalConflicts = 0;

    // Scratch arrays for connectivity propagation (_propagateConnectivity).
    const N = H * W;
    this._slSeen = new Uint8Array(N);
    this._slSeen2 = new Uint8Array(N);
    this._slApDisc = new Int32Array(N);
    this._slApLow = new Int32Array(N);
    this._slApIsAP = new Uint8Array(N);

    // Per-dot incidence counters. Maintained incrementally so propagation
    // never has to recount.
    const D = (H + 1) * (W + 1);
    this.lineCount = new Int16Array(D);
    this.unknownCount = new Int16Array(D);
    // Initialize unknownCount with each dot's actual edge count (corners=2,
    // borders=3, interior=4).
    for (let r = 0; r <= H; r++) {
      for (let c = 0; c <= W; c++) {
        let cnt = 0;
        if (c > 0) cnt++;            // H[r][c-1]
        if (c < W) cnt++;            // H[r][c]
        if (r > 0) cnt++;            // V[r-1][c]
        if (r < H) cnt++;            // V[r][c]
        this.unknownCount[r * (W + 1) + c] = cnt;
      }
    }

    // Apply initialState if provided. We DO go through _setEdge so dot
    // counters stay consistent; we just discard the trail afterwards (the
    // initial state is the baseline, not something to roll back).
    if (initialState) {
      const ih = initialState.horizontal || [];
      const iv = initialState.vertical || [];
      for (let r = 0; r <= H; r++) {
        const row = ih[r] || [];
        for (let c = 0; c < W; c++) {
          if (row[c] === 1) this._setEdge(this._hIdx(r, c), 'H', 1);
          else if (row[c] === 2) this._setEdge(this._hIdx(r, c), 'H', 2);
        }
      }
      for (let r = 0; r < H; r++) {
        const row = iv[r] || [];
        for (let c = 0; c <= W; c++) {
          if (row[c] === 1) this._setEdge(this._vIdx(r, c), 'V', 1);
          else if (row[c] === 2) this._setEdge(this._vIdx(r, c), 'V', 2);
        }
      }
      this.trail.length = 0;  // baseline — never roll back through it
      this._reasons.length = 0;
      this._decisionLevels.length = 0;
    }
  }

  _hIdx(r, c) { return r * this.width + c; }
  _vIdx(r, c) { return r * (this.width + 1) + c; }
  _dotId(r, c) { return r * (this.width + 1) + c; }

  // ── CDCL variable encoding ───────────────────────────────────────────────
  // Variable IDs: [0, numH) = H edges, [numH, numH+numV) = V edges,
  // [numH+numV, totalVars) = cell colors (row-major).

  /** @param {'H'|'V'} kind @param {number} idx @returns {number} */
  _varIdEdge(kind, idx) {
    return kind === 'H' ? idx : this.numH + idx;
  }

  /** @param {number} cellIdx  (r * width + c) @returns {number} */
  _varIdCell(cellIdx) {
    return this.numH + this.numV + cellIdx;
  }

  /** @param {number} varId @returns {{ kind: 'H'|'V'|'C', idx: number }} */
  _decodeVar(varId) {
    if (varId < this.numH) return { kind: 'H', idx: varId };
    if (varId < this.numH + this.numV) return { kind: 'V', idx: varId - this.numH };
    return { kind: 'C', idx: varId - this.numH - this.numV };
  }

  /**
   * Current sign of variable `varId`:
   *  +1 if true  (edge=LINE  or cell=INSIDE)
   *  -1 if false (edge=EMPTY or cell=OUTSIDE)
   *   0 if UNKNOWN
   * @param {number} varId
   * @returns {-1|0|1}
   */
  _varValue(varId) {
    const d = this._decodeVar(varId);
    if (d.kind === 'H') {
      const v = this.H[d.idx];
      return v === 0 ? 0 : v === 1 ? 1 : -1;
    }
    if (d.kind === 'V') {
      const v = this.V[d.idx];
      return v === 0 ? 0 : v === 1 ? 1 : -1;
    }
    const c = this.colors[d.idx];
    return c === 0 ? 0 : c === 1 ? 1 : -1;
  }

  // Returns [u, v] dot ids that an edge joins.
  _edgeEndpoints(kind, idx) {
    const W = this.width;
    if (kind === 'H') {
      // H[r][c] joins (r, c) and (r, c+1).
      const r = (idx / W) | 0;
      const c = idx - r * W;
      return [this._dotId(r, c), this._dotId(r, c + 1)];
    } else {
      // V[r][c] joins (r, c) and (r+1, c).
      const stride = W + 1;
      const r = (idx / stride) | 0;
      const c = idx - r * stride;
      return [this._dotId(r, c), this._dotId(r + 1, c)];
    }
  }

  // Trailed write. Returns false if the new value would conflict with an
  // existing assignment (i.e., the edge is already set to a different
  // non-UNKNOWN value). UNKNOWN→UNKNOWN is a no-op and returns true.
  _setEdge(idx, kind, val) {
    const arr = kind === 'H' ? this.H : this.V;
    const old = arr[idx];
    if (old === val) return true;
    if (old !== 0) return false;  // attempted to overwrite an existing value
    const kindBit = kind === 'H' ? 0 : 1;
    this.trail.push((kindBit << 24) | idx);
    this._reasons.push(this._currentReason);
    this._decisionLevels.push(this._decisionLevel);
    this._currentReason = null;
    arr[idx] = val;
    // Update endpoint counters.
    const [u, v] = this._edgeEndpoints(kind, idx);
    this.unknownCount[u]--;
    this.unknownCount[v]--;
    if (val === 1) {
      this.lineCount[u]++;
      this.lineCount[v]++;
    }
    return true;
  }

  _rollback(mark) {
    while (this.trail.length > mark) {
      const e = this.trail.pop();
      this._reasons.pop();
      this._decisionLevels.pop();
      const idx = e & 0xFFFFFF;
      const kind = (e >> 24) & 3;  // 2-bit kind: 0=H, 1=V, 2=color
      if (kind === 2) {
        // Color entry: restore old color from bits 26-27.
        this.colors[idx] = (e >> 26) & 3;
      } else {
        // Edge entry (kind 0=H, 1=V).
        const arr = kind === 0 ? this.H : this.V;
        const edgeKind = kind === 0 ? 'H' : 'V';
        const cur = arr[idx];
        arr[idx] = 0;
        const [u, v] = this._edgeEndpoints(edgeKind, idx);
        this.unknownCount[u]++;
        this.unknownCount[v]++;
        if (cur === 1) {
          this.lineCount[u]--;
          this.lineCount[v]--;
        }
      }
    }
  }

  _budgetExceeded() {
    if (this.maxMs <= 0) return false;
    if (Date.now() - this._startedAt > this.maxMs) {
      this._timedOut = true;
      return true;
    }
    return false;
  }

  // Trailed write for cell colors. Returns false on conflict (cell already
  // known to a different color). UNKNOWN→same is a no-op that returns true.
  _setColor(idx, color) {
    const old = this.colors[idx];
    if (old === color) return true;
    if (old !== 0) return false;  // conflict
    this.trail.push((old << 26) | (2 << 24) | idx);
    this._reasons.push(this._currentReason);
    this._decisionLevels.push(this._decisionLevel);
    this._currentReason = null;
    this.colors[idx] = color;
    return true;
  }

  // Maps a SAT literal to the corresponding _setEdge / _setColor call.
  // Literal encoding: lit >= 0 means positive (LINE/INSIDE = 1), lit < 0 means
  // negative (EMPTY/OUTSIDE = 2). Variable IDs are non-negative; negation is
  // represented as ~varId (bitwise NOT, always negative).
  // Returns false on conflict (same contract as _setEdge/_setColor).
  _forceLiteral(lit) {
    const varId = lit >= 0 ? lit : ~lit;
    const decoded = this._decodeVar(varId);
    const positive = lit >= 0;
    if (decoded.kind === 'H') {
      return this._setEdge(decoded.idx, 'H', positive ? 1 : 2);
    }
    if (decoded.kind === 'V') {
      return this._setEdge(decoded.idx, 'V', positive ? 1 : 2);
    }
    return this._setColor(decoded.idx, positive ? 1 : 2);
  }

  _addLearnedClause(literals) {
    this._learnedClauses.push({ literals: literals.slice(), activity: 1 });
    if (this._learnedClauses.length >= this._maxLearnedClauses) {
      this._learnedClauses.sort((a, b) => a.activity - b.activity);
      const drop = Math.floor(this._maxLearnedClauses / 4);
      this._learnedClauses.splice(0, drop);
    }
  }

  _bumpVsids(literals) {
    for (const lit of literals) {
      const varId = lit >= 0 ? lit : ~lit;
      this._vsidsScores[varId] += 1;
    }
  }

  _decayVsidsIfDue() {
    this._vsidsConflictsSinceDecay++;
    if (this._vsidsConflictsSinceDecay < this._vsidsDecayInterval) return;
    this._vsidsConflictsSinceDecay = 0;
    for (let i = 0; i < this.totalVars; i++) {
      this._vsidsScores[i] *= this._vsidsDecay;
    }
    for (const c of this._learnedClauses) {
      c.activity *= this._vsidsDecay;
    }
  }

  _pickDecisionLiteral() {
    let best = -1;
    let bestScore = -Infinity;
    for (let v = 0; v < this.totalVars; v++) {
      if (this._varValue(v) !== 0) continue;
      if (this._vsidsScores[v] > bestScore) {
        bestScore = this._vsidsScores[v];
        best = v;
      }
    }
    if (best === -1) return 0; // all assigned — caller must check _allEdgesAssigned() separately

    // When all scores are 0 (no conflicts yet), fall back to existing
    // domain-specific heuristics for a smarter initial branch.
    if (bestScore === 0) {
      const edgePick = this._pickEdge();
      if (edgePick) return this._varIdEdge(/** @type {'H'|'V'} */ (edgePick.kind), edgePick.idx);
    }
    // Pick positive sense (LINE / INSIDE) by default — just return the var ID
    // (which is itself a positive literal under ~lit convention).
    return best;
  }

  _lubyNext(idx) {
    // Canonical Luby (0-indexed). Knuth, AofA Vol 4A §7.2.2.2.
    // For 1-indexed k: if k == 2^n - 1 return 2^(n-1), else recurse on
    // k - 2^(n-1) + 1 with the smallest n satisfying 2^n - 1 >= k.
    let k = idx + 1;
    for (;;) {
      let n = 1;
      while ((1 << n) - 1 < k) n++;
      if (k === (1 << n) - 1) return 1 << (n - 1);
      k = k - (1 << (n - 1)) + 1;
    }
  }

  _restart() {
    this._backjumpTo(0);
  }

  // Propagates all learned clauses as unit-propagation rules.
  // Literal encoding: lit >= 0 = positive (LINE/INSIDE), lit < 0 = negative
  // (EMPTY/OUTSIDE), varId = lit >= 0 ? lit : ~lit.
  // For each clause:
  //   - already satisfied → skip
  //   - all literals false (conflict) → set _lastConflictReason, return false
  //   - exactly one literal unassigned (unit) → force it, bump activity
  // Returns true iff no contradiction was found.
  _propagateLearnedClauses(onChange) {
    for (const clause of this._learnedClauses) {
      let unassignedCount = 0;
      let unassignedLit = 0;
      let satisfied = false;
      for (const lit of clause.literals) {
        const varId = lit >= 0 ? lit : ~lit;
        const v = this._varValue(varId);
        const positive = lit >= 0;
        if (v === 0) {
          unassignedCount++;
          unassignedLit = lit;
        } else if ((v > 0) === positive) {
          satisfied = true;
          break;
        }
      }
      if (satisfied) continue;
      if (unassignedCount === 0) {
        this._lastConflictReason = clause.literals.map(l => l >= 0 ? l : ~l);
        return false;
      }
      if (unassignedCount === 1) {
        this._currentReason = clause.literals
          .filter(l => l !== unassignedLit)
          .map(l => l >= 0 ? l : ~l);
        if (!this._forceLiteral(unassignedLit)) {
          this._lastConflictReason = clause.literals.map(l => l >= 0 ? l : ~l);
          return false;
        }
        onChange();
        clause.activity += 1;
      }
    }
    return true;
  }

  // Returns the varId for the trail entry at position i.
  // Trail encoding: bits 24-25 = kind (0=H edge, 1=V edge, 2=color), bits 0-23 = idx.
  _varAtTrailIndex(i) {
    const e = this.trail[i];
    const idx = e & 0xFFFFFF;
    const kind = (e >> 24) & 3;
    if (kind === 0) return this._varIdEdge('H', idx);
    if (kind === 1) return this._varIdEdge('V', idx);
    if (kind === 2) return this._varIdCell(idx);
    return -1;
  }

  // Returns the decision level at which varId was assigned, or 0 if unknown.
  _decisionLevelOf(varId) {
    for (let i = this.trail.length - 1; i >= 0; i--) {
      if (this._varAtTrailIndex(i) === varId) return this._decisionLevels[i];
    }
    return 0;
  }

  // Returns the trail index for varId, or -1 if not found.
  _trailIndexOf(varId) {
    for (let i = this.trail.length - 1; i >= 0; i--) {
      if (this._varAtTrailIndex(i) === varId) return i;
    }
    return -1;
  }

  // First-UIP conflict analysis (CDCL §4).
  // conflictReason: array of varIds involved in the conflict.
  // Returns the learned clause as an array of literals (using ~lit convention).
  // Each literal negates the current assignment of its variable.
  //
  // Algorithm: walk the trail backward from the most recently assigned
  // current-level variable, resolving implications until exactly one
  // current-level variable remains (the UIP). Literals at earlier levels
  // go directly into the learned clause.
  //
  // Subsumption during seeding: if a current-level var X in conflictReason
  // appears in the reason of another current-level var Y in conflictReason,
  // X is already captured through Y's implication chain and is not counted
  // separately toward pathCount. This prevents spurious double-counting when
  // the conflict reason contains both an implied var and one of its antecedents.
  _analyzeConflict(conflictReason) {
    // First-UIP conflict analysis with subsumed-variable shortcut.
    // The conflict reason contains variable IDs (not literals) of the variables
    // whose current assignments jointly caused the contradiction.
    //
    // The subsumed shortcut: if a current-level conflict var X's reason includes
    // another current-level conflict var Y, then Y is "subsumed" by X — we do
    // not count Y separately in pathCount. This effectively makes X the UIP
    // candidate rather than resolving through Y. After finding the UIP, we
    // transitively expand its reason chain to collect ALL earlier-level
    // antecedents (including those reachable through subsumed variables).
    const learned = [];
    const seen = new Uint8Array(this.totalVars + 1);
    let pathCount = 0;

    // Pre-pass: mark all conflict vars seen; for current-level vars, mark the
    // vars in their reasons as subsumed (won't count toward pathCount).
    const subsumed = new Uint8Array(this.totalVars + 1);
    for (const varId of conflictReason) {
      if (varId < 0 || varId >= this.totalVars) continue;
      seen[varId] = 1;
      const lvl = this._decisionLevelOf(varId);
      if (lvl !== this._decisionLevel) continue;
      const trailIdx = this._trailIndexOf(varId);
      if (trailIdx < 0) continue;
      const reason = this._reasons[trailIdx];
      if (!reason) continue;
      for (const av of reason) {
        if (av >= 0 && av < this.totalVars) subsumed[av] = 1;
      }
    }

    // Seed pathCount and earlier-level learned literals from conflictReason.
    for (const varId of conflictReason) {
      if (varId < 0 || varId >= this.totalVars) continue;
      const value = this._varValue(varId);
      if (value === 0) continue;
      const lvl = this._decisionLevelOf(varId);
      if (lvl === 0) continue;
      if (lvl < this._decisionLevel) {
        learned.push(value > 0 ? ~varId : varId);
      } else if (!subsumed[varId]) {
        pathCount++;
      }
    }

    // If all current-level conflict vars were subsumed, pathCount is 0 and the
    // UIP walk below would never run — leaving the learned clause without any
    // current-level literal. To avoid producing incorrect clauses in this case,
    // find the most recently assigned current-level var in `seen` (even if
    // subsumed) and treat it as the UIP by injecting pathCount=1 and clearing
    // its subsumed flag.
    if (pathCount === 0) {
      for (let i = this.trail.length - 1; i >= 0; i--) {
        const v = this._varAtTrailIndex(i);
        if (v < 0 || !seen[v]) continue;
        if (this._decisionLevels[i] !== this._decisionLevel) continue;
        // Found the most recent current-level var — make it the UIP.
        subsumed[v] = 0;
        pathCount = 1;
        break;
      }
    }

    // Walk trail backward to find first UIP.
    for (let i = this.trail.length - 1; pathCount > 0 && i >= 0; i--) {
      const varAtI = this._varAtTrailIndex(i);
      if (varAtI < 0 || !seen[varAtI]) continue;
      if (this._decisionLevels[i] !== this._decisionLevel) continue;
      if (subsumed[varAtI]) continue;

      pathCount--;

      const reason = this._reasons[i];
      if (pathCount === 0 || reason === null) {
        // varAtI is the first UIP.
        const value = this._varValue(varAtI);
        learned.push(value > 0 ? ~varAtI : varAtI);
        // Expand UIP's reason transitively to capture ALL earlier-level
        // antecedents — including those reachable through subsumed current-level
        // vars whose antecedents were not counted in pathCount.
        if (reason) {
          const toExpand = [varAtI];
          const expandedSeen = new Uint8Array(this.totalVars + 1);
          expandedSeen[varAtI] = 1;
          while (toExpand.length > 0) {
            const cur = toExpand.pop();
            const curTi = this._trailIndexOf(cur);
            const curReason = curTi >= 0 ? this._reasons[curTi] : null;
            if (!curReason) continue;
            for (const av of curReason) {
              if (av < 0 || av >= this.totalVars) continue;
              if (expandedSeen[av]) continue;
              expandedSeen[av] = 1;
              const aLvl = this._decisionLevelOf(av);
              if (aLvl === 0) continue;
              if (aLvl >= this._decisionLevel) {
                // Current-level antecedent: transitively expand its reason.
                toExpand.push(av);
                continue;
              }
              // Earlier-level antecedent: skip if already in learned.
              // For earlier-level vars at this point, seen[av]===1 implies the
              // var was already pushed to learned (via the pre-pass at line 4913,
              // or the resolution loop at line 4996). The subsumed flag tracks
              // current-level subsumption and does not apply to learned-set
              // membership for earlier-level vars.
              if (seen[av]) continue;
              const aVal = this._varValue(av);
              if (aVal === 0) continue;
              learned.push(aVal > 0 ? ~av : av);
              seen[av] = 1;
            }
          }
        }
        break;
      }

      // Resolve varAtI: replace it with its antecedents.
      for (const av of reason) {
        if (av < 0 || av >= this.totalVars) continue;
        if (seen[av]) continue;
        seen[av] = 1;
        const aLvl = this._decisionLevelOf(av);
        if (aLvl === 0) continue;
        const aValue = this._varValue(av);
        const aLit = aValue > 0 ? ~av : av;
        if (aLvl < this._decisionLevel) {
          learned.push(aLit);
        } else {
          pathCount++;
        }
      }
    }

    return learned;
  }

  // Returns the second-highest decision level among literals in a learned clause.
  // Used by CDCL to determine the target level for a backjump (the level at which
  // the learned clause becomes unit after rolling back).
  // Returns 0 if there is only one distinct level (backjump to root).
  _computeBackjumpLevel(learned) {
    let max = 0, second = 0;
    for (const lit of learned) {
      const varId = lit >= 0 ? lit : ~lit;
      const lvl = this._decisionLevelOf(varId);
      if (lvl > max) {
        second = max;
        max = lvl;
      } else if (lvl > second && lvl < max) {
        second = lvl;
      }
    }
    return second;
  }

  // Rolls the trail back to the first entry whose decision level exceeds `level`,
  // then sets this._decisionLevel = level.
  // After this call all trail entries have level ≤ `level`.
  _backjumpTo(level) {
    let mark = this.trail.length;
    for (let i = 0; i < this.trail.length; i++) {
      if (this._decisionLevels[i] > level) {
        mark = i;
        break;
      }
    }
    this._rollback(mark);
    this._decisionLevel = level;
  }

  // Returns the color of cell (r,c): 1=INSIDE, 2=OUTSIDE, 0=UNKNOWN.
  // Out-of-grid coordinates are implicitly OUTSIDE (2).
  _colorOf(r, c) {
    if (r < 0 || r >= this.height || c < 0 || c >= this.width) return 2;
    return this.colors[r * this.width + c];
  }

  // Cell inside/outside coloring rule. Couples edge state and color in both
  // directions: LINE iff adjacent cells differ in color. Also uses known cell
  // colors to restrict neighbors of clued cells.
  //
  // Returns false on contradiction; calls onChange() for every forced edge
  // or color assignment.
  //
  // Three sub-rules:
  //   A — known edge → color: if E is LINE/EMPTY between cells A and B,
  //       the colors of A and B must differ/be equal. Force the unknown one.
  //   B — known colors → edge: if A and B both have known colors, the shared
  //       edge must be LINE (different) or EMPTY (same). Force it.
  //   C — clue × own-color: for clued cell (r,c) with known color myColor,
  //       count opposite-color (m) and unknown (u) neighbors. Apply forcing
  //       when m==k or m+u==k.
  _propagateColors(onChange) {
    const H = this.height, W = this.width;

    // ── Rule A: known edge → color relation ──────────────────────────────
    // Horizontal edges H[r][c]: separates cell (r-1,c) above and cell (r,c)
    // below. Row r of H is between row r-1 and row r of cells.
    for (let r = 0; r <= H; r++) {
      for (let c = 0; c < W; c++) {
        const e = this.H[this._hIdx(r, c)];
        if (e === 0) continue;  // unknown edge
        // Cell above: (r-1, c); cell below: (r, c).
        const colorAbove = this._colorOf(r - 1, c);
        const colorBelow = this._colorOf(r, c);
        const idxAbove = (r - 1) >= 0 ? (r - 1) * W + c : -1;
        const idxBelow = r < H ? r * W + c : -1;
        const eVar = this._varIdEdge('H', this._hIdx(r, c));
        if (e === 1) {
          // LINE → colors must differ.
          if (colorAbove !== 0 && colorBelow !== 0 && colorAbove === colorBelow) {
            this._lastConflictReason = [eVar, ...(idxAbove >= 0 ? [this._varIdCell(idxAbove)] : []), ...(idxBelow >= 0 ? [this._varIdCell(idxBelow)] : [])];
            return false;
          }
          if (colorAbove !== 0 && colorBelow === 0) {
            // Force below to opposite.
            const forced = colorAbove === 1 ? 2 : 1;
            if (idxBelow >= 0) {
              this._currentReason = [eVar, ...(idxAbove >= 0 ? [this._varIdCell(idxAbove)] : [])];
              if (!this._setColor(idxBelow, forced)) return false; onChange();
            } else if (forced !== 2) {
              this._lastConflictReason = [eVar, ...(idxAbove >= 0 ? [this._varIdCell(idxAbove)] : [])];
              return false;  // out-of-grid must be OUTSIDE
            }
          } else if (colorBelow !== 0 && colorAbove === 0) {
            const forced = colorBelow === 1 ? 2 : 1;
            if (idxAbove >= 0) {
              this._currentReason = [eVar, ...(idxBelow >= 0 ? [this._varIdCell(idxBelow)] : [])];
              if (!this._setColor(idxAbove, forced)) return false; onChange();
            } else if (forced !== 2) {
              this._lastConflictReason = [eVar, ...(idxBelow >= 0 ? [this._varIdCell(idxBelow)] : [])];
              return false;
            }
          }
        } else {
          // EMPTY → colors must be same.
          if (colorAbove !== 0 && colorBelow !== 0 && colorAbove !== colorBelow) {
            this._lastConflictReason = [eVar, ...(idxAbove >= 0 ? [this._varIdCell(idxAbove)] : []), ...(idxBelow >= 0 ? [this._varIdCell(idxBelow)] : [])];
            return false;
          }
          if (colorAbove !== 0 && colorBelow === 0) {
            if (idxBelow >= 0) {
              this._currentReason = [eVar, ...(idxAbove >= 0 ? [this._varIdCell(idxAbove)] : [])];
              if (!this._setColor(idxBelow, colorAbove)) return false; onChange();
            } else if (colorAbove !== 2) {
              this._lastConflictReason = [eVar, ...(idxAbove >= 0 ? [this._varIdCell(idxAbove)] : [])];
              return false;
            }
          } else if (colorBelow !== 0 && colorAbove === 0) {
            if (idxAbove >= 0) {
              this._currentReason = [eVar, ...(idxBelow >= 0 ? [this._varIdCell(idxBelow)] : [])];
              if (!this._setColor(idxAbove, colorBelow)) return false; onChange();
            } else if (colorBelow !== 2) {
              this._lastConflictReason = [eVar, ...(idxBelow >= 0 ? [this._varIdCell(idxBelow)] : [])];
              return false;
            }
          }
        }
      }
    }

    // Vertical edges V[r][c]: separates cell (r,c-1) to the left and cell
    // (r,c) to the right.
    for (let r = 0; r < H; r++) {
      for (let c = 0; c <= W; c++) {
        const e = this.V[this._vIdx(r, c)];
        if (e === 0) continue;
        const colorLeft = this._colorOf(r, c - 1);
        const colorRight = this._colorOf(r, c);
        const idxLeft = (c - 1) >= 0 ? r * W + (c - 1) : -1;
        const idxRight = c < W ? r * W + c : -1;
        const eVar = this._varIdEdge('V', this._vIdx(r, c));
        if (e === 1) {
          if (colorLeft !== 0 && colorRight !== 0 && colorLeft === colorRight) {
            this._lastConflictReason = [eVar, ...(idxLeft >= 0 ? [this._varIdCell(idxLeft)] : []), ...(idxRight >= 0 ? [this._varIdCell(idxRight)] : [])];
            return false;
          }
          if (colorLeft !== 0 && colorRight === 0) {
            const forced = colorLeft === 1 ? 2 : 1;
            if (idxRight >= 0) {
              this._currentReason = [eVar, ...(idxLeft >= 0 ? [this._varIdCell(idxLeft)] : [])];
              if (!this._setColor(idxRight, forced)) return false; onChange();
            } else if (forced !== 2) {
              this._lastConflictReason = [eVar, ...(idxLeft >= 0 ? [this._varIdCell(idxLeft)] : [])];
              return false;
            }
          } else if (colorRight !== 0 && colorLeft === 0) {
            const forced = colorRight === 1 ? 2 : 1;
            if (idxLeft >= 0) {
              this._currentReason = [eVar, ...(idxRight >= 0 ? [this._varIdCell(idxRight)] : [])];
              if (!this._setColor(idxLeft, forced)) return false; onChange();
            } else if (forced !== 2) {
              this._lastConflictReason = [eVar, ...(idxRight >= 0 ? [this._varIdCell(idxRight)] : [])];
              return false;
            }
          }
        } else {
          if (colorLeft !== 0 && colorRight !== 0 && colorLeft !== colorRight) {
            this._lastConflictReason = [eVar, ...(idxLeft >= 0 ? [this._varIdCell(idxLeft)] : []), ...(idxRight >= 0 ? [this._varIdCell(idxRight)] : [])];
            return false;
          }
          if (colorLeft !== 0 && colorRight === 0) {
            if (idxRight >= 0) {
              this._currentReason = [eVar, ...(idxLeft >= 0 ? [this._varIdCell(idxLeft)] : [])];
              if (!this._setColor(idxRight, colorLeft)) return false; onChange();
            } else if (colorLeft !== 2) {
              this._lastConflictReason = [eVar, ...(idxLeft >= 0 ? [this._varIdCell(idxLeft)] : [])];
              return false;
            }
          } else if (colorRight !== 0 && colorLeft === 0) {
            if (idxLeft >= 0) {
              this._currentReason = [eVar, ...(idxRight >= 0 ? [this._varIdCell(idxRight)] : [])];
              if (!this._setColor(idxLeft, colorRight)) return false; onChange();
            } else if (colorRight !== 2) {
              this._lastConflictReason = [eVar, ...(idxRight >= 0 ? [this._varIdCell(idxRight)] : [])];
              return false;
            }
          }
        }
      }
    }

    // ── Rule B: known colors → edge state ────────────────────────────────
    // Horizontal edges: cell (r-1,c) above and cell (r,c) below.
    for (let r = 0; r <= H; r++) {
      for (let c = 0; c < W; c++) {
        const eIdx = this._hIdx(r, c);
        if (this.H[eIdx] !== 0) continue;
        const colorAbove = this._colorOf(r - 1, c);
        const colorBelow = this._colorOf(r, c);
        if (colorAbove === 0 || colorBelow === 0) continue;
        const idxAbove = (r - 1) >= 0 ? (r - 1) * W + c : -1;
        const idxBelow = r < H ? r * W + c : -1;
        const expectedEdge = colorAbove !== colorBelow ? 1 : 2;
        const antecedents = [];
        if (idxAbove >= 0) antecedents.push(this._varIdCell(idxAbove));
        if (idxBelow >= 0) antecedents.push(this._varIdCell(idxBelow));
        this._currentReason = antecedents;
        if (!this._setEdge(eIdx, 'H', expectedEdge)) return false;
        onChange();
      }
    }
    // Vertical edges: cell (r,c-1) to the left and cell (r,c) to the right.
    for (let r = 0; r < H; r++) {
      for (let c = 0; c <= W; c++) {
        const eIdx = this._vIdx(r, c);
        if (this.V[eIdx] !== 0) continue;
        const colorLeft = this._colorOf(r, c - 1);
        const colorRight = this._colorOf(r, c);
        if (colorLeft === 0 || colorRight === 0) continue;
        const idxLeft = (c - 1) >= 0 ? r * W + (c - 1) : -1;
        const idxRight = c < W ? r * W + c : -1;
        const expectedEdge = colorLeft !== colorRight ? 1 : 2;
        const antecedents = [];
        if (idxLeft >= 0) antecedents.push(this._varIdCell(idxLeft));
        if (idxRight >= 0) antecedents.push(this._varIdCell(idxRight));
        this._currentReason = antecedents;
        if (!this._setEdge(eIdx, 'V', expectedEdge)) return false;
        onChange();
      }
    }

    // ── Rule C: clue × own-color ──────────────────────────────────────────
    // Neighbors in order: above (r-1,c), below (r+1,c), left (r,c-1),
    // right (r,c+1). Out-of-grid treated as OUTSIDE (2).
    for (let r = 0; r < H; r++) {
      const taskRow = this.task[r] || [];
      for (let c = 0; c < W; c++) {
        const clue = taskRow[c];
        if (clue === undefined || clue < 0 || clue > 4) continue;
        const myIdx = r * W + c;
        const myColor = this._colorOf(r, c);
        if (myColor === 0) continue;
        const opposite = myColor === 1 ? 2 : 1;
        const myVar = this._varIdCell(myIdx);
        const nbrs = [[r-1,c],[r+1,c],[r,c-1],[r,c+1]];
        let m = 0, u = 0;
        const oppositeVars = [];
        for (const [nr, nc] of nbrs) {
          const nc2 = this._colorOf(nr, nc);
          if (nc2 === opposite) {
            m++;
            if (nr >= 0 && nr < H && nc >= 0 && nc < W) oppositeVars.push(this._varIdCell(nr * W + nc));
          } else if (nc2 === 0) u++;
        }
        if (m > clue) {
          this._lastConflictReason = [myVar, ...oppositeVars];
          return false;
        }
        if (m + u < clue) {
          this._lastConflictReason = [myVar, ...oppositeVars];
          return false;
        }
        if (m === clue && u > 0) {
          // Force all unknown neighbors to same color as myColor.
          const antecedents = [myVar, ...oppositeVars];
          for (const [nr, nc] of nbrs) {
            if (nr < 0 || nr >= H || nc < 0 || nc >= W) continue;
            const ni = nr * W + nc;
            if (this.colors[ni] === 0) {
              this._currentReason = antecedents;
              if (!this._setColor(ni, myColor)) return false;
              onChange();
            }
          }
        } else if (m + u === clue && u > 0) {
          // Force all unknown neighbors to opposite color.
          const antecedents = [myVar, ...oppositeVars];
          for (const [nr, nc] of nbrs) {
            if (nr < 0 || nr >= H || nc < 0 || nc >= W) continue;
            const ni = nr * W + nc;
            if (this.colors[ni] === 0) {
              this._currentReason = antecedents;
              if (!this._setColor(ni, opposite)) return false;
              onChange();
            }
          }
        }
      }
    }

    return true;
  }

  // Return an array of 4 {kind, idx} entries describing cell (r,c)'s edges
  // in a fixed order: top, bottom, left, right.
  _cellEdges(r, c) {
    return [
      { kind: 'H', idx: this._hIdx(r, c) },         // top
      { kind: 'H', idx: this._hIdx(r + 1, c) },     // bottom
      { kind: 'V', idx: this._vIdx(r, c) },         // left
      { kind: 'V', idx: this._vIdx(r, c + 1) },     // right
    ];
  }

  // Per-cell clue forcing rule. Returns false on contradiction; calls onChange()
  // whenever it forces an edge. Skips cells without a valid clue.
  _applyClueRuleAt(r, c, onChange) {
    const clue = (this.task[r] || [])[c];
    if (clue === undefined || clue < 0 || clue > 4) return true;
    const edges = this._cellEdges(r, c);
    let m = 0, n = 0;
    for (const e of edges) {
      const v = (e.kind === 'H' ? this.H : this.V)[e.idx];
      if (v === 1) m++;
      else if (v === 0) n++;
    }
    if (m > clue) {
      this._lastConflictReason = edges
        .filter(e => (e.kind === 'H' ? this.H : this.V)[e.idx] !== 0)
        .map(e => this._varIdEdge(/** @type {'H'|'V'} */ (e.kind), e.idx));
      return false;
    }
    if (m + n < clue) {
      this._lastConflictReason = edges
        .filter(e => (e.kind === 'H' ? this.H : this.V)[e.idx] !== 0)
        .map(e => this._varIdEdge(/** @type {'H'|'V'} */ (e.kind), e.idx));
      return false;
    }
    if (m === clue && n > 0) {
      // All UNKNOWN edges → EMPTY.
      const antecedents = edges
        .filter(e => (e.kind === 'H' ? this.H : this.V)[e.idx] !== 0)
        .map(e => this._varIdEdge(/** @type {'H'|'V'} */ (e.kind), e.idx));
      for (const e of edges) {
        const arr = e.kind === 'H' ? this.H : this.V;
        if (arr[e.idx] === 0) {
          this._currentReason = antecedents;
          if (!this._setEdge(e.idx, e.kind, 2)) return false;
          onChange();
        }
      }
    } else if (m + n === clue && n > 0) {
      // All UNKNOWN edges → LINE.
      const antecedents = edges
        .filter(e => (e.kind === 'H' ? this.H : this.V)[e.idx] !== 0)
        .map(e => this._varIdEdge(/** @type {'H'|'V'} */ (e.kind), e.idx));
      for (const e of edges) {
        const arr = e.kind === 'H' ? this.H : this.V;
        if (arr[e.idx] === 0) {
          this._currentReason = antecedents;
          if (!this._setEdge(e.idx, e.kind, 1)) return false;
          onChange();
        }
      }
    }
    return true;
  }

  // Clue forcing rule. Returns false on contradiction; calls onChange()
  // whenever it forces an edge.
  _propagateClues(onChange) {
    const H = this.height, W = this.width;
    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) {
        if (!this._applyClueRuleAt(r, c, onChange)) return false;
      }
    }
    return true;
  }

  // Return {kind, idx} entries for the (up to 4) edges incident to dot (r,c).
  _dotEdges(r, c) {
    const H = this.height, W = this.width;
    const out = [];
    if (c > 0) out.push({ kind: 'H', idx: this._hIdx(r, c - 1) });   // left
    if (c < W) out.push({ kind: 'H', idx: this._hIdx(r, c) });       // right
    if (r > 0) out.push({ kind: 'V', idx: this._vIdx(r - 1, c) });   // up
    if (r < H) out.push({ kind: 'V', idx: this._vIdx(r, c) });       // down
    return out;
  }

  // Per-dot vertex forcing rule. Returns false on contradiction; calls onChange()
  // whenever it forces an edge.
  _applyVertexRuleAt(r, c, onChange) {
    const dotId = this._dotId(r, c);
    const m = this.lineCount[dotId];
    const n = this.unknownCount[dotId];
    if (m > 2) {
      this._lastConflictReason = this._dotEdges(r, c)
        .filter(e => (e.kind === 'H' ? this.H : this.V)[e.idx] !== 0)
        .map(e => this._varIdEdge(/** @type {'H'|'V'} */ (e.kind), e.idx));
      return false;
    }
    if (m === 1 && n === 0) {
      this._lastConflictReason = this._dotEdges(r, c)
        .filter(e => (e.kind === 'H' ? this.H : this.V)[e.idx] !== 0)
        .map(e => this._varIdEdge(/** @type {'H'|'V'} */ (e.kind), e.idx));
      return false;
    }
    if (m === 2 && n > 0) {
      const antecedents = this._dotEdges(r, c)
        .filter(e => (e.kind === 'H' ? this.H : this.V)[e.idx] !== 0)
        .map(e => this._varIdEdge(/** @type {'H'|'V'} */ (e.kind), e.idx));
      for (const e of this._dotEdges(r, c)) {
        const arr = e.kind === 'H' ? this.H : this.V;
        if (arr[e.idx] === 0) {
          this._currentReason = antecedents;
          if (!this._setEdge(e.idx, e.kind, 2)) return false;
          onChange();
        }
      }
    } else if (m === 1 && n === 1) {
      const antecedents = this._dotEdges(r, c)
        .filter(e => (e.kind === 'H' ? this.H : this.V)[e.idx] === 1)
        .map(e => this._varIdEdge(/** @type {'H'|'V'} */ (e.kind), e.idx));
      for (const e of this._dotEdges(r, c)) {
        const arr = e.kind === 'H' ? this.H : this.V;
        if (arr[e.idx] === 0) {
          this._currentReason = antecedents;
          if (!this._setEdge(e.idx, e.kind, 1)) return false;
          onChange();
          break;
        }
      }
    } else if (m === 0 && n === 1) {
      this._currentReason = [];
      for (const e of this._dotEdges(r, c)) {
        const arr = e.kind === 'H' ? this.H : this.V;
        if (arr[e.idx] === 0) {
          if (!this._setEdge(e.idx, e.kind, 2)) return false;
          onChange();
          break;
        }
      }
    }
    return true;
  }

  // Vertex forcing rule. Returns false on contradiction; calls onChange()
  // whenever it forces an edge.
  _propagateVertices(onChange) {
    const H = this.height, W = this.width;
    for (let r = 0; r <= H; r++) {
      for (let c = 0; c <= W; c++) {
        if (!this._applyVertexRuleAt(r, c, onChange)) return false;
      }
    }
    return true;
  }

  _dsuMakeArrays() {
    const D = (this.height + 1) * (this.width + 1);
    if (!this._dsuParent || this._dsuParent.length !== D) {
      this._dsuParent = new Int32Array(D);
      this._dsuRank = new Int8Array(D);
    }
  }

  _dsuFind(x) {
    const p = this._dsuParent;
    let r = x;
    while (p[r] !== r) r = p[r];
    // Path compression.
    while (p[x] !== r) { const next = p[x]; p[x] = r; x = next; }
    return r;
  }

  // Rebuild the DSU over all currently-LINE edges. Sets `_cycleClosed` true
  // iff at least one LINE edge's endpoints were already in the same
  // component before that edge was unioned in (i.e., a cycle exists).
  // O(E α(D)) — cheap.
  _dsuRebuild() {
    this._dsuMakeArrays();
    const p = this._dsuParent;
    const rank = this._dsuRank;
    for (let i = 0; i < p.length; i++) { p[i] = i; rank[i] = 0; }
    this._cycleClosed = false;
    const H = this.height, W = this.width;
    for (let r = 0; r <= H; r++) {
      for (let c = 0; c < W; c++) {
        if (this.H[this._hIdx(r, c)] !== 1) continue;
        const [u, v] = this._edgeEndpoints('H', this._hIdx(r, c));
        const ru = this._dsuFind(u), rv = this._dsuFind(v);
        if (ru === rv) { this._cycleClosed = true; continue; }
        if (rank[ru] < rank[rv]) p[ru] = rv;
        else if (rank[ru] > rank[rv]) p[rv] = ru;
        else { p[rv] = ru; rank[ru]++; }
      }
    }
    for (let r = 0; r < H; r++) {
      for (let c = 0; c <= W; c++) {
        if (this.V[this._vIdx(r, c)] !== 1) continue;
        const [u, v] = this._edgeEndpoints('V', this._vIdx(r, c));
        const ru = this._dsuFind(u), rv = this._dsuFind(v);
        if (ru === rv) { this._cycleClosed = true; continue; }
        if (rank[ru] < rank[rv]) p[ru] = rv;
        else if (rank[ru] > rank[rv]) p[rv] = ru;
        else { p[rv] = ru; rank[ru]++; }
      }
    }
  }

  // True iff (a) every clue is satisfied exactly, (b) no UNKNOWN edges remain,
  // (c) every dot has degree 0 or 2, and (d) all LINE edges form a single
  // connected component. Assumes _dsuRebuild() has just been called.
  _checkSingleLoopComplete() {
    const H = this.height, W = this.width;
    // (a) clue check.
    for (let r = 0; r < H; r++) {
      const row = this.task[r] || [];
      for (let c = 0; c < W; c++) {
        const clue = row[c];
        if (clue === undefined || clue < 0 || clue > 4) continue;
        const edges = this._cellEdges(r, c);
        let m = 0;
        for (const e of edges) {
          if ((e.kind === 'H' ? this.H : this.V)[e.idx] === 1) m++;
        }
        if (m !== clue) return false;
      }
    }
    // (b) no UNKNOWN edges.
    for (let i = 0; i < this.H.length; i++) if (this.H[i] === 0) return false;
    for (let i = 0; i < this.V.length; i++) if (this.V[i] === 0) return false;
    // (c) every dot is degree 0 or 2.
    for (let i = 0; i < this.lineCount.length; i++) {
      const m = this.lineCount[i];
      if (m !== 0 && m !== 2) return false;
    }
    // (d) all LINE edges share one component.
    let totalLines = 0;
    let firstRoot = -1;
    for (let r = 0; r <= H; r++) {
      for (let c = 0; c < W; c++) {
        if (this.H[this._hIdx(r, c)] !== 1) continue;
        totalLines++;
        const [u] = this._edgeEndpoints('H', this._hIdx(r, c));
        const ru = this._dsuFind(u);
        if (firstRoot === -1) firstRoot = ru;
        else if (firstRoot !== ru) return false;
      }
    }
    for (let r = 0; r < H; r++) {
      for (let c = 0; c <= W; c++) {
        if (this.V[this._vIdx(r, c)] !== 1) continue;
        totalLines++;
        const [u] = this._edgeEndpoints('V', this._vIdx(r, c));
        const ru = this._dsuFind(u);
        if (firstRoot === -1) firstRoot = ru;
        else if (firstRoot !== ru) return false;
      }
    }
    return totalLines > 0;
  }

  // Helper: returns the [cell-r, cell-c, H-r, H-c, V-r, V-c] tuple for a
  // named corner. Used by _applyCornerThree and _applyCornerOne.
  _cornerCoords(corner) {
    const H = this.height, W = this.width;
    switch (corner) {
      case 'TL': return [0,   0,   0, 0,   0, 0  ];
      case 'TR': return [0,   W-1, 0, W-1, 0, W  ];
      case 'BL': return [H-1, 0,   H, 0,   H-1, 0];
      case 'BR': return [H-1, W-1, H, W-1, H-1, W];
      default: return null;
    }
  }

  // Corner-3 pattern for one grid corner. Returns false on contradiction.
  _applyCornerThree(corner, onChange) {
    const coords = this._cornerCoords(corner);
    if (!coords) return true;
    const [cr, cc, hr, hc, vr, vc] = coords;
    const k = (this.task[cr] || [])[cc];
    if (k !== 3) return true;
    if (this.H[this._hIdx(hr, hc)] !== 1) {
      this._currentReason = [];
      if (!this._setEdge(this._hIdx(hr, hc), 'H', 1)) return false;
      onChange();
    }
    if (this.V[this._vIdx(vr, vc)] !== 1) {
      this._currentReason = [];
      if (!this._setEdge(this._vIdx(vr, vc), 'V', 1)) return false;
      onChange();
    }
    return true;
  }

  // Corner-1 pattern for one grid corner. Returns false on contradiction.
  _applyCornerOne(corner, onChange) {
    const coords = this._cornerCoords(corner);
    if (!coords) return true;
    const [cr, cc, hr, hc, vr, vc] = coords;
    const k = (this.task[cr] || [])[cc];
    if (k !== 1) return true;
    if (this.H[this._hIdx(hr, hc)] !== 2) {
      this._currentReason = [];
      if (!this._setEdge(this._hIdx(hr, hc), 'H', 2)) return false;
      onChange();
    }
    if (this.V[this._vIdx(vr, vc)] !== 2) {
      this._currentReason = [];
      if (!this._setEdge(this._vIdx(vr, vc), 'V', 2)) return false;
      onChange();
    }
    return true;
  }

  // Horizontal adjacent-3-3 pattern for cells (r,c) and (r,c+1). Returns
  // false on contradiction; no-ops if either cell doesn't have clue 3.
  _applyAdjacentThreeH(r, c, onChange) {
    if ((this.task[r] || [])[c] !== 3 || (this.task[r] || [])[c + 1] !== 3) return true;
    // Shared vertical V[r][c+1], outer verticals V[r][c] and V[r][c+2].
    for (const [vr, vc] of [[r, c], [r, c + 1], [r, c + 2]]) {
      const idx = this._vIdx(vr, vc);
      if (this.V[idx] !== 1) {
        this._currentReason = [];
        if (!this._setEdge(idx, 'V', 1)) return false;
        onChange();
      }
    }
    return true;
  }

  // Vertical adjacent-3-3 pattern for cells (r,c) and (r+1,c). Returns
  // false on contradiction; no-ops if either cell doesn't have clue 3.
  _applyAdjacentThreeV(r, c, onChange) {
    if ((this.task[r] || [])[c] !== 3 || (this.task[r + 1] || [])[c] !== 3) return true;
    // Shared horizontal H[r+1][c], outer horizontals H[r][c] and H[r+2][c].
    for (const [hr, hc] of [[r, c], [r + 1, c], [r + 2, c]]) {
      const idx = this._hIdx(hr, hc);
      if (this.H[idx] !== 1) {
        this._currentReason = [];
        if (!this._setEdge(idx, 'H', 1)) return false;
        onChange();
      }
    }
    return true;
  }

  // Diagonal-3-3 pattern for cell (r,c) and its diagonal neighbour (r+dr, c+dc).
  // (dr,dc) must be (1,1) or (1,-1) — the two down-directions; up-directions
  // are covered when the nested loop visits the other cell first.
  // Returns false on contradiction; no-ops if clue condition not met.
  _applyDiagonalThree(r, c, dr, dc, onChange) {
    const nr = r + dr, nc = c + dc;
    if ((this.task[r] || [])[c] !== 3 || (this.task[nr] || [])[nc] !== 3) return true;
    // (r,c)'s far corner is opposite (dr,dc): far-H and far-V.
    // down-right (dr=1,dc=1): far corner of (r,c) = top-left → H[r][c], V[r][c]
    // down-left  (dr=1,dc=-1): far corner of (r,c) = top-right → H[r][c], V[r][c+1]
    const hIdx1 = this._hIdx(r, c);
    const vIdx1 = dc === 1 ? this._vIdx(r, c) : this._vIdx(r, c + 1);
    // far corner of (nr,nc):
    // down-right: bottom-right of (r+1,c+1) → H[r+2][c+1], V[r+1][c+2]
    // down-left:  bottom-left of (r+1,c-1) → H[r+2][c-1], V[r+1][c-1]
    const hIdx2 = this._hIdx(nr + 1, nc);
    const vIdx2 = dc === 1 ? this._vIdx(nr, nc + 1) : this._vIdx(nr, nc);
    for (const [arr, idx] of [[this.H, hIdx1], [this.V, vIdx1], [this.H, hIdx2], [this.V, vIdx2]]) {
      if (arr[idx] !== 1) {
        const kind = (arr === this.H) ? 'H' : 'V';
        this._currentReason = [];
        if (!this._setEdge(idx, kind, 1)) return false;
        onChange();
      }
    }
    return true;
  }

  // Classic Slitherlink pattern deductions. Returns false on contradiction,
  // calls onChange() after every successful force.
  //
  // Patterns (all provably sound):
  //   a) Corner-3: corner cell with clue 3 → both outer corner edges LINE.
  //      Proof: corner dot has only 2 incident edges (both belonging to the
  //      cell). Clue 3 ⟹ exactly 3 of 4 cell edges are LINE ⟹ at least
  //      one outer corner edge is LINE ⟹ vertex rule (degree 0 or 2) forces
  //      both to LINE.
  //   b) Corner-1: corner cell with clue 1 → both outer corner edges EMPTY.
  //      Proof: if either outer corner edge were LINE, vertex rule on the
  //      corner dot forces the other LINE too → cell has ≥2 LINEs from
  //      corners alone → contradicts clue 1 → both must be EMPTY.
  //   c) Adjacent 3-3 horizontal: cells (r,c)=3 and (r,c+1)=3 → shared
  //      vertical V[r][c+1] and outer verticals V[r][c] and V[r][c+2] are
  //      LINE.  Proof: cell (r,c) needs 3 of {H[r][c], H[r+1][c], V[r][c],
  //      V[r][c+1]}. Cell (r,c+1) needs 3 of {H[r][c+1], H[r+1][c+1],
  //      V[r][c+1], V[r][c+2]}. If V[r][c+1] (shared) were EMPTY each cell
  //      must have all 3 remaining edges LINE, so both H[r][c] and H[r+1][c]
  //      are LINE and both H[r][c+1] and H[r+1][c+1] are LINE. Dot (r,c+1)
  //      would then have lineCount ≥ 3 (H[r][c] + H[r][c+1] + V[r][c+1]=E
  //      means 0 from V side but dot (r+1,c+1) has H[r+1][c] + H[r+1][c+1]
  //      LINE → degree 2 using both, forcing V[r+1][c+1] EMPTY and V[r][c+1]
  //      EMPTY). Actually the clean proof: the two cells share V[r][c+1].
  //      Assume it EMPTY. Then (r,c) uses all 3 of H[r][c], H[r+1][c],
  //      V[r][c]; and (r,c+1) uses all 3 of H[r][c+1], H[r+1][c+1],
  //      V[r][c+2]. But then dot (r,c+1) has H[r][c] + H[r][c+1] → degree
  //      ≥2 → V[r][c+1] must be LINE (vertex rule). Contradiction. So
  //      V[r][c+1] must be LINE. With V[r][c+1] LINE, cells (r,c) and
  //      (r,c+1) each need 2 more LINEs from their remaining 3 edges, and
  //      those must NOT include the shared horizontals at the outer corner
  //      dots in a way that forces the corner verticals. Cleaner end-result:
  //      standard slitherlink theory says both outer verticals are forced LINE.
  //   d) Adjacent 3-3 vertical: symmetric to (c).
  //   e) Diagonal 3-3 (all 4 orientations): cells (r,c) and (r±1,c±1) both
  //      have clue 3 → the outer-corner edges of each cell (the pair facing
  //      AWAY from the other cell's corner) are forced LINE.
  //      Proof (down-right case): cell (r,c) at corner (r,c) and cell
  //      (r+1,c+1) at corner (r+1,c+1) share no edges. Standard result:
  //      the outer-facing edges at the two cells' far corners are forced LINE
  //      because any other assignment leaves the opposing cell unable to
  //      achieve clue 3 without creating a degree-3 dot on the shared inner
  //      corner. Applies symmetrically to all 4 diagonal orientations.
  _propagateAdvanced(onChange) {
    const H = this.height, W = this.width;

    // (a) + (b) Corner patterns.
    for (const corner of ['TL', 'TR', 'BL', 'BR']) {
      if (!this._applyCornerThree(corner, onChange)) return false;
      if (!this._applyCornerOne(corner, onChange)) return false;
    }

    // (c) Horizontally-adjacent 3-3.
    for (let r = 0; r < H; r++) {
      for (let c = 0; c + 1 < W; c++) {
        if (!this._applyAdjacentThreeH(r, c, onChange)) return false;
      }
    }

    // (d) Vertically-adjacent 3-3.
    for (let r = 0; r + 1 < H; r++) {
      for (let c = 0; c < W; c++) {
        if (!this._applyAdjacentThreeV(r, c, onChange)) return false;
      }
    }

    // (e) Diagonal 3-3 — down-right and down-left (up directions are
    // covered when the inner cell visits the outer cell as its "first").
    for (let r = 0; r + 1 < H; r++) {
      for (let c = 0; c + 1 < W; c++) {
        if (!this._applyDiagonalThree(r, c, 1, 1, onChange)) return false;
      }
    }
    for (let r = 0; r + 1 < H; r++) {
      for (let c = 1; c < W; c++) {
        if (!this._applyDiagonalThree(r, c, 1, -1, onChange)) return false;
      }
    }

    return true;
  }

  // Line-crossing parity rule. A closed Slitherlink loop crosses any straight
  // scan line an even number of times.
  //
  // Geometry: dots are at integer coordinates (row, col) 0..H x 0..W.
  //   - H[r][c]: horizontal edge at y=r, spanning x from c to c+1.
  //   - V[r][c]: vertical edge at x=c, spanning y from r to r+1.
  //
  // A horizontal scan at y = R + 0.5 (between dot rows R and R+1) crosses
  // VERTICAL edges that span over y = R + 0.5, i.e., V[R][c] for c = 0..W.
  //
  // A vertical scan at x = C + 0.5 (between dot cols C and C+1) crosses
  // HORIZONTAL edges that span over x = C + 0.5, i.e., H[r][C] for r = 0..H.
  //
  // Per scan line, let m = count of LINE edges, n = count of UNKNOWN edges:
  //   - n == 0 && m is odd  → contradiction.
  //   - n == 1              → force the unknown: if m odd → LINE, if m even → EMPTY.
  //   - n >= 2              → no forced deduction.
  //
  // Returns false on contradiction; calls onChange() for each forced edge.
  _propagateParity(onChange) {
    const H = this.height, W = this.width;

    // ── Horizontal scans R = 0..H-1 (cross V[R][c] for c = 0..W) ──────────
    for (let R = 0; R < H; R++) {
      let m = 0, n = 0, unknownC = -1;
      for (let c = 0; c <= W; c++) {
        const v = this.V[this._vIdx(R, c)];
        if (v === 1) m++;
        else if (v === 0) { n++; unknownC = c; }
      }
      if (n === 0) {
        if (m & 1) {
          const reasonVars = [];
          for (let c = 0; c <= W; c++) {
            const v = this.V[this._vIdx(R, c)];
            if (v !== 0) reasonVars.push(this._varIdEdge('V', this._vIdx(R, c)));
          }
          this._lastConflictReason = reasonVars;
          return false;
        }
      } else if (n === 1) {
        const forced = (m & 1) ? 1 : 2;
        const antecedents = [];
        for (let c = 0; c <= W; c++) {
          if (c === unknownC) continue;
          const v = this.V[this._vIdx(R, c)];
          if (v !== 0) antecedents.push(this._varIdEdge('V', this._vIdx(R, c)));
        }
        this._currentReason = antecedents;
        if (!this._setEdge(this._vIdx(R, unknownC), 'V', forced)) return false;
        onChange();
      }
    }

    // ── Vertical scans C = 0..W-1 (cross H[r][C] for r = 0..H) ─────────────
    for (let C = 0; C < W; C++) {
      let m = 0, n = 0, unknownR = -1;
      for (let r = 0; r <= H; r++) {
        const v = this.H[this._hIdx(r, C)];
        if (v === 1) m++;
        else if (v === 0) { n++; unknownR = r; }
      }
      if (n === 0) {
        if (m & 1) {
          const reasonVars = [];
          for (let r = 0; r <= H; r++) {
            const v = this.H[this._hIdx(r, C)];
            if (v !== 0) reasonVars.push(this._varIdEdge('H', this._hIdx(r, C)));
          }
          this._lastConflictReason = reasonVars;
          return false;
        }
      } else if (n === 1) {
        const forced = (m & 1) ? 1 : 2;
        const antecedents = [];
        for (let r = 0; r <= H; r++) {
          if (r === unknownR) continue;
          const v = this.H[this._hIdx(r, C)];
          if (v !== 0) antecedents.push(this._varIdEdge('H', this._hIdx(r, C)));
        }
        this._currentReason = antecedents;
        if (!this._setEdge(this._hIdx(unknownR, C), 'H', forced)) return false;
        onChange();
      }
    }

    return true;
  }

  // INSIDE reachability deduction. BFS from a single known-INSIDE cell through
  // the {INSIDE ∪ UNKNOWN} graph. Returns false if not all known-INSIDE cells
  // are reachable (they're disconnected → contradiction). Any UNKNOWN cell not
  // reachable is forced OUTSIDE. Calls onChange() for each forced cell.
  _slApplyInsideReachability(onChange) {
    const H = this.height, W = this.width, N = H * W;
    let start = -1, placedCount = 0;
    for (let i = 0; i < N; i++) {
      if (this.colors[i] === 1) {
        placedCount++;
        if (start === -1) start = i;
      }
    }
    if (placedCount === 0) return true;  // no known-INSIDE cells: nothing to do

    const seen = this._slSeen;
    seen.fill(0);
    const queue = [start];
    seen[start] = 1;
    let reachedPlaced = 1;
    let qi = 0;
    while (qi < queue.length) {
      const cur = queue[qi++];
      const r = (cur / W) | 0, c = cur % W;
      if (r > 0)     { const nb = cur - W; if (!seen[nb] && this.colors[nb] !== 2) { seen[nb] = 1; if (this.colors[nb] === 1) reachedPlaced++; queue.push(nb); } }
      if (r + 1 < H) { const nb = cur + W; if (!seen[nb] && this.colors[nb] !== 2) { seen[nb] = 1; if (this.colors[nb] === 1) reachedPlaced++; queue.push(nb); } }
      if (c > 0)     { const nb = cur - 1; if (!seen[nb] && this.colors[nb] !== 2) { seen[nb] = 1; if (this.colors[nb] === 1) reachedPlaced++; queue.push(nb); } }
      if (c + 1 < W) { const nb = cur + 1; if (!seen[nb] && this.colors[nb] !== 2) { seen[nb] = 1; if (this.colors[nb] === 1) reachedPlaced++; queue.push(nb); } }
    }

    if (reachedPlaced !== placedCount) {
      // known-INSIDE cells are disconnected — collect all known-INSIDE cell vars
      const reasonVars = [];
      for (let i = 0; i < N; i++) {
        if (this.colors[i] === 1) reasonVars.push(this._varIdCell(i));
      }
      this._lastConflictReason = reasonVars;
      return false;
    }

    // Any UNKNOWN cell not in BFS can never be INSIDE (can't reach INSIDE cells).
    const insideAntecedents = [];
    for (let i = 0; i < N; i++) {
      if (this.colors[i] === 1) insideAntecedents.push(this._varIdCell(i));
    }
    for (let i = 0; i < N; i++) {
      if (this.colors[i] === 0 && !seen[i]) {
        this._currentReason = insideAntecedents;
        if (!this._setColor(i, 2)) return false;
        onChange();
      }
    }
    return true;
  }

  // OUTSIDE reachability deduction. BFS from all non-INSIDE border cells
  // (representing connectivity to the virtual exterior of the grid). Returns
  // false if any known-OUTSIDE cell is not reachable from the grid exterior
  // through the {OUTSIDE ∪ UNKNOWN} graph (contradiction). Any UNKNOWN cell
  // not reachable from the exterior can never be OUTSIDE, so it is forced
  // INSIDE. Calls onChange() for each forced cell.
  _slApplyOutsideReachability(onChange) {
    const H = this.height, W = this.width, N = H * W;
    const seen = this._slSeen;
    seen.fill(0);
    const queue = [];

    // Seed from all border cells that are not known-INSIDE.
    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) {
        if (r !== 0 && r !== H - 1 && c !== 0 && c !== W - 1) continue;  // not border
        const idx = r * W + c;
        if (this.colors[idx] === 1) continue;  // known INSIDE: not a border root
        if (!seen[idx]) { seen[idx] = 1; queue.push(idx); }
      }
    }

    // BFS through {OUTSIDE ∪ UNKNOWN}.
    let reachedOutside = 0;
    let qi = 0;
    while (qi < queue.length) {
      const cur = queue[qi++];
      const r = (cur / W) | 0, c = cur % W;
      if (this.colors[cur] === 2) reachedOutside++;
      if (r > 0)     { const nb = cur - W; if (!seen[nb] && this.colors[nb] !== 1) { seen[nb] = 1; queue.push(nb); } }
      if (r + 1 < H) { const nb = cur + W; if (!seen[nb] && this.colors[nb] !== 1) { seen[nb] = 1; queue.push(nb); } }
      if (c > 0)     { const nb = cur - 1; if (!seen[nb] && this.colors[nb] !== 1) { seen[nb] = 1; queue.push(nb); } }
      if (c + 1 < W) { const nb = cur + 1; if (!seen[nb] && this.colors[nb] !== 1) { seen[nb] = 1; queue.push(nb); } }
    }

    // All known-OUTSIDE cells must be reachable from the exterior.
    let totalOutside = 0;
    for (let i = 0; i < N; i++) if (this.colors[i] === 2) totalOutside++;
    if (reachedOutside !== totalOutside) {
      // some OUTSIDE cell is interior-trapped — collect all known-OUTSIDE cell vars
      const reasonVars = [];
      for (let i = 0; i < N; i++) {
        if (this.colors[i] === 2) reasonVars.push(this._varIdCell(i));
      }
      this._lastConflictReason = reasonVars;
      return false;
    }

    // Any UNKNOWN cell not reachable from the exterior can never be OUTSIDE.
    const outsideAntecedents = [];
    for (let i = 0; i < N; i++) {
      if (this.colors[i] === 2) outsideAntecedents.push(this._varIdCell(i));
    }
    for (let i = 0; i < N; i++) {
      if (this.colors[i] === 0 && !seen[i]) {
        this._currentReason = outsideAntecedents;
        if (!this._setColor(i, 1)) return false;
        onChange();
      }
    }
    return true;
  }

  // Articulation points of the {color ∪ UNKNOWN} cell graph (4-adjacency).
  // UNKNOWN cells act as "wildcard" for both colors. Returns a Uint8Array of
  // length H*W where entry i is 1 if cell i is an articulation point.
  // Standard iterative Tarjan DFS (avoids JS stack-overflow on large boards).
  _slArticulationPoints(color) {
    const H = this.height, W = this.width, N = H * W;
    const disc = this._slApDisc; disc.fill(-1);
    const low = this._slApLow;
    const isAP = this._slApIsAP; isAP.fill(0);
    let timer = 0;

    // Iterative DFS using an explicit stack of [node, parentNode, neighborIndex].
    for (let startNode = 0; startNode < N; startNode++) {
      const cv = this.colors[startNode];
      if (cv !== color && cv !== 0) continue;  // not in {color ∪ UNKNOWN}
      if (disc[startNode] !== -1) continue;    // already visited

      // Stack entry: [node, parent, childrenCount, neighborIndex]
      const dfsStack = [[startNode, -1, 0, 0]];
      disc[startNode] = low[startNode] = timer++;

      while (dfsStack.length) {
        const frame = dfsStack[dfsStack.length - 1];
        const [u, parent] = frame;
        const r = (u / W) | 0, cu = u % W;
        // Enumerate neighbors lazily via frame[3] (neighborIndex).
        let pushed = false;
        while (frame[3] < 4) {
          const d = frame[3]++;
          let v = -1;
          if (d === 0) { if (r > 0) v = u - W; }
          else if (d === 1) { if (r + 1 < H) v = u + W; }
          else if (d === 2) { if (cu > 0) v = u - 1; }
          else { if (cu + 1 < W) v = u + 1; }
          if (v < 0) continue;
          const vc = this.colors[v];
          if (vc !== color && vc !== 0) continue;  // not in subgraph
          if (disc[v] === -1) {
            // Tree edge: push child onto stack.
            frame[2]++;  // children count of u
            disc[v] = low[v] = timer++;
            dfsStack.push([v, u, 0, 0]);
            pushed = true;
            break;
          } else if (v !== parent) {
            // Back edge: update low.
            if (disc[v] < low[u]) low[u] = disc[v];
          }
        }
        if (!pushed) {
          // Done with this node: propagate low to parent, check AP condition.
          dfsStack.pop();
          if (dfsStack.length > 0) {
            const parentFrame = dfsStack[dfsStack.length - 1];
            const p = parentFrame[0];
            if (low[u] < low[p]) low[p] = low[u];
            if (parent !== -1 && low[u] >= disc[p]) isAP[p] = 1;
          } else {
            // Root of DFS tree.
            if (frame[2] > 1) isAP[u] = 1;
          }
        }
      }
    }
    return isAP;
  }

  // Cut deduction for one color. For each UNKNOWN articulation point of the
  // {color ∪ UNKNOWN} graph whose removal would disconnect the known-color
  // cells, force it to `color`. Calls onChange() for each forced cell.
  _slApplyCut(color, onChange) {
    const N = this.height * this.width;
    const isAP = this._slArticulationPoints(color);
    for (let ap = 0; ap < N; ap++) {
      if (!isAP[ap]) continue;
      if (this.colors[ap] !== 0) continue;  // not UNKNOWN
      // Check if removing this cell disconnects the known-color cells.
      if (!this._slColorConnected(color, ap)) {
        const antecedents = [];
        for (let i = 0; i < N; i++) {
          if (this.colors[i] === color) antecedents.push(this._varIdCell(i));
        }
        this._currentReason = antecedents;
        if (!this._setColor(ap, color)) return false;
        onChange();
      }
    }
    return true;
  }

  // Helper: BFS to check whether all known-color cells (excluding `blockIdx`)
  // remain connected through the {color ∪ UNKNOWN} graph when `blockIdx` is
  // removed. Returns true if connected (or ≤1 known-color cell remains).
  _slColorConnected(color, blockIdx) {
    const H = this.height, W = this.width, N = H * W;
    let start = -1, placedCount = 0;
    for (let i = 0; i < N; i++) {
      if (i === blockIdx) continue;
      if (this.colors[i] === color) {
        placedCount++;
        if (start === -1) start = i;
      }
    }
    if (placedCount <= 1) return true;
    const seen = this._slSeen2;
    seen.fill(0);
    const stack = [start];
    seen[start] = 1;
    let reached = 1;
    while (stack.length) {
      const cur = stack.pop();
      const r = (cur / W) | 0, c = cur % W;
      const neighbors = [];
      if (r > 0) neighbors.push(cur - W);
      if (r + 1 < H) neighbors.push(cur + W);
      if (c > 0) neighbors.push(cur - 1);
      if (c + 1 < W) neighbors.push(cur + 1);
      for (const nb of neighbors) {
        if (seen[nb] || nb === blockIdx) continue;
        const vc = this.colors[nb];
        if (vc === color || vc === 0) {
          seen[nb] = 1;
          if (vc === color) reached++;
          stack.push(nb);
        }
      }
    }
    return reached === placedCount;
  }

  // Connectivity propagation (cell color graph). Runs:
  //   (a) INSIDE reachability: UNKNOWN cells that can't reach any known-INSIDE
  //       cell through the {INSIDE ∪ UNKNOWN} graph are forced OUTSIDE. Also
  //       detects contradiction if known-INSIDE cells are disconnected.
  //   (b) OUTSIDE reachability: UNKNOWN cells that can't reach the virtual grid
  //       exterior through the {OUTSIDE ∪ UNKNOWN} graph are forced INSIDE.
  //   (c) INSIDE articulation cut: UNKNOWN articulation points of the
  //       {INSIDE ∪ UNKNOWN} graph whose removal disconnects known-INSIDE cells
  //       are forced INSIDE.
  //
  // Note: OUTSIDE articulation cut is intentionally omitted. The OUTSIDE region
  // in a valid Slitherlink solution is connected via the plane exterior — two
  // known-OUTSIDE cells may be disconnected within the cell graph (e.g., one
  // above and one below the loop) yet still be in the same topological region.
  //
  // Returns false on contradiction; calls onChange() for each forced color.
  _propagateConnectivity(onChange) {
    if (!this._slApplyInsideReachability(onChange)) return false;
    if (!this._slApplyOutsideReachability(onChange)) return false;
    if (!this._slApplyCut(1, onChange)) return false;
    return true;
  }

  // 1-step lookahead. For each "constrained" UNKNOWN edge, probe both values
  // (LINE and EMPTY). If one probe propagates to a contradiction, force the
  // other. If both propagate to contradictions, return false.
  //
  // Called from propagate() only when _depth === 0 and !_inLookahead so the
  // inner propagate() calls skip re-entering lookahead (controlled by the
  // _inLookahead flag).
  //
  // Candidate edges (performance heuristic — without filtering a 30×30 board
  // starts with ~1521 unknowns → >3000 probes at ~3ms each ≈ 9s per pass):
  //   - At least one endpoint dot has lineCount[u] + unknownCount[u] ≤ 3
  //     (tight dot — close to being forced).
  //   - OR the edge borders a clued cell (r,c) where (current LINE count m)
  //     + (current UNKNOWN count n) ≤ 3 (tight cell — most edges already set).
  // This cuts the candidate set 5-10× in practice.
  _applyLookahead(onChange) {
    const H = this.height, W = this.width;

    // Collect candidate edges (kind, idx, arr) filtering by tightness.
    const candidates = [];

    // Helper: check if an edge (kind, idx) is a candidate.
    const isTight = (kind, idx) => {
      // 1. Endpoint dot tightness.
      const [u, v] = this._edgeEndpoints(kind, idx);
      if (this.lineCount[u] + this.unknownCount[u] <= 3) return true;
      if (this.lineCount[v] + this.unknownCount[v] <= 3) return true;
      // 2. Adjacent cell tightness.
      if (kind === 'H') {
        const c = idx % W;
        const r = (idx / W) | 0;
        // Cell above: (r-1, c).
        if (r > 0) {
          const row = this.task[r - 1] || [];
          const cl = row[c];
          if (cl >= 0 && cl <= 4) {
            const edges = this._cellEdges(r - 1, c);
            let m = 0, n = 0;
            for (const e of edges) { const v2 = (e.kind === 'H' ? this.H : this.V)[e.idx]; if (v2 === 1) m++; else if (v2 === 0) n++; }
            if (m + n <= 3) return true;
          }
        }
        // Cell below: (r, c).
        if (r < H) {
          const row = this.task[r] || [];
          const cl = row[c];
          if (cl >= 0 && cl <= 4) {
            const edges = this._cellEdges(r, c);
            let m = 0, n = 0;
            for (const e of edges) { const v2 = (e.kind === 'H' ? this.H : this.V)[e.idx]; if (v2 === 1) m++; else if (v2 === 0) n++; }
            if (m + n <= 3) return true;
          }
        }
      } else {
        // V[r][c]: r = idx / (W+1), c = idx % (W+1).
        const stride = W + 1;
        const r = (idx / stride) | 0;
        const c = idx - r * stride;
        // Cell to the left: (r, c-1).
        if (c > 0) {
          const row = this.task[r] || [];
          const cl = row[c - 1];
          if (cl >= 0 && cl <= 4) {
            const edges = this._cellEdges(r, c - 1);
            let m = 0, n = 0;
            for (const e of edges) { const v2 = (e.kind === 'H' ? this.H : this.V)[e.idx]; if (v2 === 1) m++; else if (v2 === 0) n++; }
            if (m + n <= 3) return true;
          }
        }
        // Cell to the right: (r, c).
        if (c < W) {
          const row = this.task[r] || [];
          const cl = row[c];
          if (cl >= 0 && cl <= 4) {
            const edges = this._cellEdges(r, c);
            let m = 0, n = 0;
            for (const e of edges) { const v2 = (e.kind === 'H' ? this.H : this.V)[e.idx]; if (v2 === 1) m++; else if (v2 === 0) n++; }
            if (m + n <= 3) return true;
          }
        }
      }
      return false;
    };

    for (let r = 0; r <= H; r++) {
      for (let c = 0; c < W; c++) {
        const idx = this._hIdx(r, c);
        if (this.H[idx] !== 0) continue;
        if (isTight('H', idx)) candidates.push({ kind: 'H', idx });
      }
    }
    for (let r = 0; r < H; r++) {
      for (let c = 0; c <= W; c++) {
        const idx = this._vIdx(r, c);
        if (this.V[idx] !== 0) continue;
        if (isTight('V', idx)) candidates.push({ kind: 'V', idx });
      }
    }

    this._inLookahead = true;
    for (const { kind, idx } of candidates) {
      if (this._budgetExceeded()) { this._inLookahead = false; return false; }
      const arr = kind === 'H' ? this.H : this.V;
      if (arr[idx] !== 0) continue;  // already assigned during this lookahead pass

      let lineFails = false, emptyFails = false;
      let lineContradictionReason = [], emptyContradictionReason = [];

      for (const probeVal of [1, 2]) {
        const mark = this.trail.length;
        if (!this._setEdge(idx, kind, probeVal)) {
          // Can't even set it: means it was already set to the other value.
          if (probeVal === 1) lineFails = true; else emptyFails = true;
          this._rollback(mark);
          continue;
        }
        const ok = this.propagate();
        const probeReasonVars = [];
        for (let ti = mark; ti < this.trail.length; ti++) {
          const r = this._reasons[ti];
          if (Array.isArray(r)) for (const v of r) probeReasonVars.push(v);
        }
        this._rollback(mark);
        if (!ok) {
          if (probeVal === 1) { lineFails = true; lineContradictionReason = probeReasonVars; }
          else { emptyFails = true; emptyContradictionReason = probeReasonVars; }
        }
      }

      if (lineFails && emptyFails) {
        // Lookahead has proven the candidate edge has no consistent value under
        // the current trail. Probe-captured reasons reference vars that are
        // rolled back below, so handing them to CDCL gives _analyzeConflict
        // dangling pointers — UIP analysis sees no current-level material and
        // either produces an empty learned clause (→ backjump to 0 → spurious
        // UNSAT) or learns over-wide clauses that wrongly prune the search.
        //
        // Instead, blame the most recent current-level decision (chronological
        // backtrack semantics, same as the legacy _backtrack path). _analyzeConflict
        // will then learn a unit clause forcing that decision's negation, and
        // backjump to the level below. CDCL still learns useful clauses from
        // rule-level conflicts (which DO have well-formed reasons); only lookahead
        // double-fails get this degenerate-but-sound treatment.
        let lastDecisionVar = -1;
        if (this._decisionLevel > 0) {
          for (let ti = this.trail.length - 1; ti >= 0; ti--) {
            if (this._decisionLevels[ti] === this._decisionLevel && this._reasons[ti] === null) {
              lastDecisionVar = this._varAtTrailIndex(ti);
              break;
            }
          }
        }
        this._lastConflictReason = lastDecisionVar >= 0 ? [lastDecisionVar] : [];
        this._inLookahead = false;
        return false;
      }
      if (lineFails) {
        this._currentReason = [...new Set([...lineContradictionReason, ...emptyContradictionReason])];
        if (!this._setEdge(idx, kind, 2)) { this._inLookahead = false; return false; }
        onChange();
      } else if (emptyFails) {
        this._currentReason = [...new Set([...lineContradictionReason, ...emptyContradictionReason])];
        if (!this._setEdge(idx, kind, 1)) { this._inLookahead = false; return false; }
        onChange();
      }
    }
    this._inLookahead = false;
    return true;
  }

  // Iterate clue + vertex rules to a fixpoint. After each pass that
  // added a LINE edge, rebuild the DSU; if a cycle closed, check for
  // subloop: a real subloop means some LINE-endpoint dot has degree 1
  // (the line can't extend because the cycle is already closed). If every
  // LINE dot has degree 2, the cycle is consistent — the remaining unknowns
  // are in degree-0 regions and will be forced EMPTY or explored later.
  propagate() {
    // Outer loop: alternate between the local-rule fixpoint and the 1-step
    // lookahead (top-level only). Each lookahead pass may force new edges,
    // which re-enters the local-rule fixpoint, and so on.
    let anyLineAddedSinceRebuild = false;

    for (;;) {
      // ── Local-rule fixpoint ──────────────────────────────────────────────
      let changed = true;
      while (changed) {
        if (this._budgetExceeded()) return false;
        changed = false;
        // We don't know LINE vs EMPTY from the rule callback, so just rebuild
        // after each fixpoint pass that ran any propagator. (Cheap: O(E α).)
        const onLocalChange = () => { changed = true; anyLineAddedSinceRebuild = true; };
        if (!this._propagateClues(onLocalChange)) return false;
        if (!this._propagateVertices(onLocalChange)) return false;
        // _propagateAdvanced forces edges based purely on clue structure; those
        // forces are already applied before lookahead starts. Skipping it in
        // inner probe propagations avoids redundant O(H×W) work — the forced
        // edges are either already set (no-op _setEdge) or not reachable from
        // the probe edge alone. This halves inner-probe propagation time.
        if (!this._inLookahead && !this._propagateAdvanced(onLocalChange)) return false;
        if (!this._propagateColors(onLocalChange)) return false;
        if (!this._propagateParity(onLocalChange)) return false;
        if (!this._propagateLearnedClauses(onLocalChange)) return false;
        if (!this._inLookahead && !this._propagateConnectivity(onLocalChange)) return false;
      }

      // ── Subloop check ────────────────────────────────────────────────────
      if (anyLineAddedSinceRebuild) {
        this._dsuRebuild();
        anyLineAddedSinceRebuild = false;
        if (this._cycleClosed) {
          if (this._allEdgesAssigned()) {
            if (!this._checkSingleLoopComplete()) return false;
          } else {
            for (let i = 0; i < this.lineCount.length; i++) {
              if (this.lineCount[i] === 1) return false;
            }
          }
        }
      }

      // ── 1-step lookahead (top-level only) ───────────────────────────────
      if (this._depth !== 0 || this._inLookahead) break;
      let lookaheadForced = false;
      const onLookaheadChange = () => { lookaheadForced = true; anyLineAddedSinceRebuild = true; };
      if (!this._applyLookahead(onLookaheadChange)) return false;
      if (!lookaheadForced) break;  // fixpoint reached
      // Lookahead forced edges → re-run local rules.
    }

    return true;
  }

  // Most-constrained UNKNOWN edge for branching. Returns { kind, idx } or null.
  _pickEdge() {
    let best = null, bestScore = -Infinity;
    const H = this.height, W = this.width;
    for (let r = 0; r <= H; r++) {
      for (let c = 0; c < W; c++) {
        const idx = this._hIdx(r, c);
        if (this.H[idx] !== 0) continue;
        const [u, v] = this._edgeEndpoints('H', idx);
        const score = Math.max(this.lineCount[u], this.lineCount[v]) * 10
                    - Math.min(this.unknownCount[u], this.unknownCount[v]);
        if (score > bestScore) { bestScore = score; best = { kind: 'H', idx }; }
      }
    }
    for (let r = 0; r < H; r++) {
      for (let c = 0; c <= W; c++) {
        const idx = this._vIdx(r, c);
        if (this.V[idx] !== 0) continue;
        const [u, v] = this._edgeEndpoints('V', idx);
        const score = Math.max(this.lineCount[u], this.lineCount[v]) * 10
                    - Math.min(this.unknownCount[u], this.unknownCount[v]);
        if (score > bestScore) { bestScore = score; best = { kind: 'V', idx }; }
      }
    }
    return best;
  }

  _allEdgesAssigned() {
    for (let i = 0; i < this.H.length; i++) if (this.H[i] === 0) return false;
    for (let i = 0; i < this.V.length; i++) if (this.V[i] === 0) return false;
    return true;
  }

  _emit() {
    const H = this.height, W = this.width;
    const horizontal = [];
    for (let r = 0; r <= H; r++) {
      const row = new Array(W);
      for (let c = 0; c < W; c++) {
        const v = this.H[this._hIdx(r, c)];
        row[c] = v === 1 ? 1 : v === 2 ? 2 : 0;
      }
      horizontal.push(row);
    }
    const vertical = [];
    for (let r = 0; r < H; r++) {
      const row = new Array(W + 1);
      for (let c = 0; c <= W; c++) {
        const v = this.V[this._vIdx(r, c)];
        row[c] = v === 1 ? 1 : v === 2 ? 2 : 0;
      }
      vertical.push(row);
    }
    return { horizontal, vertical };
  }

  // Main CDCL search loop. Replaces _backtrack() in solve().
  // Precondition: propagate() has already been called once (in solve()) and
  // returned true; some edges may still be UNKNOWN.
  // Returns true if a complete valid loop was found; false on contradiction
  // or budget exceeded.
  _cdclSearch() {
    let conflictsSinceRestart = 0;
    let lubyIdx = 0;
    const RESTART_UNIT = 100;
    let restartLimit = this._lubyNext(lubyIdx) * RESTART_UNIT;

    // _depth stays at 0 so propagate() runs the 1-step lookahead, which
    // provides strong deduction power. Lookahead conflict reasons may reference
    // probe-internal "ghost" variables, but _analyzeConflict's pathCount=0
    // recovery (in the subsumed-all-current-level case) ensures the UIP is
    // always a current-level var with a valid trail entry — learned clauses
    // are always correct even when the raw conflict reason is over-approximate.
    //
    // NOTE: per-iteration lookahead is the dominant cost on large boards
    // (~3 s per propagate on the 50×40 monthly, so CDCL accumulates only
    // single-digit conflicts in 30 s). Disabling lookahead during search makes
    // CDCL fast but the rules alone are too weak — known-solvable boards
    // converge to a spurious UNSAT. Resolving this needs either a faster
    // lookahead implementation or stronger non-probing rules; both are out of
    // scope for the T1–T17 CDCL build.

    while (true) {
      if (this._budgetExceeded()) { return false; }

      // Check completion before asking for a decision literal. This is the
      // authoritative "done" test — _pickDecisionLiteral() returns 0 both when
      // all vars are assigned (sentinel) AND when H-edge 0 is the best pick
      // (valid literal), so we cannot distinguish the two cases from its return
      // value alone. The caller comment on _pickDecisionLiteral says explicitly:
      // "caller must check _allEdgesAssigned() separately".
      if (this._allEdgesAssigned()) {
        this._dsuRebuild();
        return this._checkSingleLoopComplete();
      }

      // After _allEdgesAssigned() returned false, there are unassigned edges.
      // _pickDecisionLiteral() is called to pick the best literal to branch on.
      // Note: literal 0 is valid (H-edge 0, positive sense / LINE). The function
      // only returns the "all assigned" sentinel (0 from best===-1) when every
      // variable is assigned, which can't happen here. Proceed unconditionally.
      const lit = this._pickDecisionLiteral();

      this._decisionLevel++;
      this._currentReason = null;
      // Shouldn't happen: we picked an unassigned variable. Defensive guard
      // in case _pickDecisionLiteral and the trail state ever drift.
      if (!this._forceLiteral(lit)) {
        return false;
      }

      while (!this.propagate()) {
        if (this._budgetExceeded()) { return false; }
        conflictsSinceRestart++;
        this._totalConflicts++;

        if (this._decisionLevel === 0) {
          // Level-0 conflict: the propagate that just failed wrote some
          // forced values before hitting a contradiction. Without an
          // explicit backjump those writes leak into _emit(), so the
          // partial cache would hold mid-fixpoint state. Backjump to 0
          // pops them and leaves a sound post-rollback snapshot for the
          // caller to emit.
          this._backjumpTo(0);
          return false;
        }

        const conflictReason = this._lastConflictReason;
        const learned = this._analyzeConflict(conflictReason);
        const backjumpLevel = this._computeBackjumpLevel(learned);

        // Non-chronological backjump: jump back to the computed level.
        // If the learned clause is empty (no antecedents), backjump to 0.
        this._backjumpTo(backjumpLevel);
        if (learned.length > 0) {
          this._addLearnedClause(learned);
        }
        this._bumpVsids(learned);
        this._decayVsidsIfDue();

        if (conflictsSinceRestart >= restartLimit) {
          this._restart();
          conflictsSinceRestart = 0;
          lubyIdx++;
          restartLimit = this._lubyNext(lubyIdx) * RESTART_UNIT;
        }
      }
    }
  }

  // Dead — kept for reference until T17 cleanup. `_cdclSearch()` is the live
  // search path; `solve()` no longer calls this method.
  _backtrack() {
    if (this._budgetExceeded()) return false;
    if (this._allEdgesAssigned()) {
      this._dsuRebuild();
      return this._checkSingleLoopComplete();
    }
    const pick = this._pickEdge();
    if (!pick) return false;
    for (const val of [1, 2]) {
      if (this._budgetExceeded()) return false;
      const mark = this.trail.length;
      if (!this._setEdge(pick.idx, pick.kind, val)) continue;
      this._depth++;
      const propOk = this.propagate();
      this._depth--;
      if (propOk) {
        if (this._allEdgesAssigned()) {
          this._dsuRebuild();
          if (this._checkSingleLoopComplete()) return true;
        } else if (this._backtrack()) {
          return true;
        }
      }
      this._rollback(mark);
      if (this._timedOut) return false;
    }
    return false;
  }

  /**
   * @returns {{
   *   solved: boolean,
   *   horizontal: number[][] | null,
   *   vertical: number[][] | null,
   *   error?: string,
   *   partial?: boolean,
   * }}
   */
  solve() {
    const key = this._cacheKey();
    const cached = SlitherlinkSolver._solutionCache.get(key);
    if (cached) {
      return {
        solved: true,
        horizontal: cached.horizontal.map(row => row.slice()),
        vertical: cached.vertical.map(row => row.slice()),
      };
    }

    // Partial cache hit: a prior solve attempt for this exact task timed
    // out and stored what propagation could deduce. Return it instead of
    // re-running the full propagate (saves ~2-6 s per Hint/Loop click on
    // hard boards where solve doesn't fit in the budget).
    const partialCached = SlitherlinkSolver._partialCache.get(key);
    if (partialCached) {
      return {
        solved: false,
        horizontal: partialCached.horizontal.map(row => row.slice()),
        vertical: partialCached.vertical.map(row => row.slice()),
        error: 'timed out',
        partial: true,
      };
    }

    this._startedAt = Date.now();
    this._timedOut = false;

    if (!this.propagate()) {
      // Distinguish timeout from contradiction. A timeout means propagation
      // didn't finish but the state in this.H/this.V is the partial fixpoint
      // up to that point — usable as a partial for callers (e.g. getHint's
      // fallback path). Contradiction means the state is inconsistent and
      // we shouldn't expose it.
      if (this._timedOut) {
        const partial = this._emit();
        SlitherlinkSolver._storeInPartialCache(key, partial);
        return {
          solved: false,
          horizontal: partial.horizontal,
          vertical: partial.vertical,
          error: 'timed out',
          partial: true,
        };
      }
      return {
        solved: false, horizontal: null, vertical: null,
        error: 'contradiction on initial propagation',
      };
    }
    if (this._allEdgesAssigned()) {
      this._dsuRebuild();
      if (this._checkSingleLoopComplete()) {
        const out = this._emit();
        this._storeInCache(key, out);
        return { solved: true, horizontal: out.horizontal, vertical: out.vertical };
      }
      return {
        solved: false, horizontal: null, vertical: null,
        error: 'fully-assigned grid is not a valid single loop',
      };
    }
    if (this._cdclSearch()) {
      const out = this._emit();
      this._storeInCache(key, out);
      return { solved: true, horizontal: out.horizontal, vertical: out.vertical };
    }
    // CDCL search failed or timed out. _cdclSearch's exit paths
    // (_backjumpTo(0) on level-0 conflict, budget check after restart, etc.)
    // leave the trail at level 0 — the post-propagation snapshot of
    // everything propagate() + lookahead could deduce at the root. Return
    // that as a partial so callers can show the deducible portion instead
    // of nothing — meaningful on hard boards (e.g. the 50×40 monthly:
    // ~38% of edges determined in ~3s before backtracking gives up).
    // Cache so repeated Hint/Loop clicks don't re-burn the budget.
    const partial = this._emit();
    if (this._timedOut) SlitherlinkSolver._storeInPartialCache(key, partial);
    return {
      solved: false,
      horizontal: partial.horizontal,
      vertical: partial.vertical,
      error: this._timedOut ? 'timed out' : 'no solution found',
      partial: true,
    };
  }

  static _storeInPartialCache(key, out) {
    const m = SlitherlinkSolver._partialCache;
    if (m.size >= SlitherlinkSolver._maxPartialCache) {
      m.delete(m.keys().next().value);
    }
    m.set(key, {
      horizontal: out.horizontal.map(row => row.slice()),
      vertical: out.vertical.map(row => row.slice()),
    });
  }

  // Run the local-rule fixpoint (clue + vertex + advanced patterns, NO
  // lookahead) and collect the first `minLines` LINE edges that are forced.
  // Uses propagate() with _depth=1 to skip the lookahead tier, so we get the
  // full propagation chain without speculative branching — this is the same
  // "next logical steps a solver would explain" but batched for Loop speed.
  // A single rollback at the end leaves the probe state unchanged.
  // Returns an array of {orientation, r, c} entries, or null if no rule fires.
  _findNextHintDeduction(minLines = 1) {
    const W = this.width;
    const overallMark = this.trail.length;

    // Run local-rule propagation (no lookahead) from the current state.
    // _depth=1 skips _applyLookahead in propagate(). _startedAt is already
    // set by the getHint caller.
    this._depth = 1;
    const propOk = this.propagate();
    this._depth = 0;

    if (!propOk) {
      // Contradiction: the current board state is already invalid.
      this._rollback(overallMark);
      return null;
    }

    // Collect LINE edges from the trail, up to minLines.
    // Trail entries with kind=2 are color writes — skip them; we only want edges.
    const allLines = [];
    for (let i = overallMark; i < this.trail.length; i++) {
      const e = this.trail[i];
      const kind = (e >> 24) & 3;
      if (kind === 2) continue;  // color write — not an edge
      const idx = e & 0xFFFFFF;
      const arr = kind === 0 ? this.H : this.V;
      if (arr[idx] === 1) {
        if (kind === 0) {
          const r = (idx / W) | 0;
          allLines.push({ orientation: 'h', r, c: idx - r * W });
        } else {
          const stride = W + 1;
          const r = (idx / stride) | 0;
          allLines.push({ orientation: 'v', r, c: idx - r * stride });
        }
        if (allLines.length >= minLines) break;
      }
    }

    this._rollback(overallMark);
    return allLines.length > 0 ? allLines : null;
  }

  /**
   * Next-move hint. Returns:
   *   { type: 'slitherlink', edges: [{orientation:'h'|'v', r, c}, ...], count }
   * or null if no hint can be found.
   *
   * Accumulates LINE edges from successive rule applications (vertex → clue →
   * advanced patterns) until at least minLines = max(3, ceil(H×W/30)) edges
   * are collected. Successive applications are not rolled back between them so
   * later rules can chain off earlier deductions. This batch sizing keeps Loop
   * under ~10s on 30×30 boards (target ≈30 iterations × 300ms inter-step).
   * No lookahead is used in this path.
   *
   * Fallback: if no local rule fires, runs a full solve (with lookahead) and
   * reveals one missing LINE edge.
   *
   * @param {number[][]} curH  (H+1)×W, 0/1
   * @param {number[][]} curV  H×(W+1), 0/1
   */
  getHint(curH, curV) {
    const probe = new SlitherlinkSolver({
      width: this.width, height: this.height, task: this.task,
      initialState: { horizontal: curH, vertical: curV },
      maxMs: this.maxMs,
    });
    probe._startedAt = Date.now();

    // Next-move hint: accumulate LINE edges across successive rule applications
    // until minLines is reached, so Loop finishes a 30×30 in ~10s (target ~30
    // Loop iterations × 300ms inter-step sleep).
    const minLines = Math.max(3, Math.ceil(this.height * this.width / 30));
    const next = probe._findNextHintDeduction(minLines);

    if (next && next.length > 0) {
      // Local rules produced something — return as-is, even if fewer than
      // minLines. Supplementing from a full solve would burn the entire
      // solve budget per click on puzzles our solver can't crack (e.g. the
      // 50×40 monthly times out at 30 s every step). minLines is a soft
      // target: hit it when local rules can, no more.
      return { type: 'slitherlink', edges: next, count: next.length };
    }

    // Local rules deduced nothing. Try a tight-budget solve and pull up to
    // minLines missing LINE edges from the result. We accept partial solves
    // (solve() returns `{ solved:false, partial:true, horizontal, vertical }`
    // on timeout): the partial is the deducible portion from
    // propagate+lookahead, exactly the LINE set we want to draw hints from.
    // Result is cached in _partialCache so this 5 s cost is paid at most
    // once per puzzle — subsequent Hint/Loop clicks hit the cache instantly.
    const fallbackBudget = Math.min(this.maxMs > 0 ? this.maxMs : 5000, 5000);
    const fallbackSolver = new SlitherlinkSolver({
      width: this.width, height: this.height, task: this.task,
      maxMs: fallbackBudget,
    });
    const full = fallbackSolver.solve();
    if (!full || !full.horizontal || !full.vertical) return null;
    const H = this.height, W = this.width;
    const out = [];
    for (let r = 0; r <= H && out.length < minLines; r++) {
      for (let c = 0; c < W && out.length < minLines; c++) {
        if (full.horizontal[r][c] === 1 && (curH[r]?.[c] !== 1)) {
          out.push({ orientation: 'h', r, c });
        }
      }
    }
    for (let r = 0; r < H && out.length < minLines; r++) {
      for (let c = 0; c <= W && out.length < minLines; c++) {
        if (full.vertical[r][c] === 1 && (curV[r]?.[c] !== 1)) {
          out.push({ orientation: 'v', r, c });
        }
      }
    }
    if (out.length === 0) return null;
    return { type: 'slitherlink', edges: out, count: out.length };
  }

  static _solutionCache = new Map();
  static _maxSolutionCache = 50;
  // Separate partial-result cache so Hint/Loop fallback solves don't
  // re-burn the full budget each click on puzzles our solver can't crack
  // (e.g. the 50×40 monthly: ~615 LINE edges determined in 2 s, then 14
  // more Loop clicks would each re-spend that 2 s without this cache).
  static _partialCache = new Map();
  static _maxPartialCache = 20;
  static clearSolutionCache() {
    SlitherlinkSolver._solutionCache.clear();
    SlitherlinkSolver._partialCache.clear();
  }

  _cacheKey() {
    // FNV-1a over (width, height, flattened task).
    let h = 0x811c9dc5;
    const mix = (n) => { h ^= n; h = Math.imul(h, 0x01000193) >>> 0; };
    mix(0x4C); // 'L' nameplate so slitherlink keys don't collide
    mix(this.width);
    mix(this.height);
    for (let r = 0; r < this.height; r++) {
      const row = this.task[r] || [];
      for (let c = 0; c < this.width; c++) mix((row[c] | 0) + 2);
    }
    return String(h >>> 0);
  }

  _storeInCache(key, out) {
    const m = SlitherlinkSolver._solutionCache;
    if (m.size >= SlitherlinkSolver._maxSolutionCache) {
      m.delete(m.keys().next().value);
    }
    m.set(key, {
      horizontal: out.horizontal.map(row => row.slice()),
      vertical: out.vertical.map(row => row.slice()),
    });
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SlitherlinkSolver };
}
