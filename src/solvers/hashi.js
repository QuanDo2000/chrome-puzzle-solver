'use strict';

const { hashFNV1a } = require('./shared.js');

// HashiSolver — pure logic for Hashi (bridges) puzzles.
//
// One variable per candidate edge between adjacent islands (skipping
// crossings), tracked as `lo`/`hi` ∈ {0..2} representing the current feasible
// range. Trail-based undo (`_assign` pushes flat 3-int groups, `_rollback`
// restores). See `src/widget/puzzles/hashi.js` for the page-side encoding,
// apply contract, loop done-check, and diff.
//
// === Propagation fixpoint ===
//
// - **Crossing exclusion** — two edges that geometrically cross cannot both
//   have `hi > 0`; force one to 0.
// - **Degree forcing** — sum of `hi` at an island ≥ required ≥ sum of `lo`;
//   tighten edges to make both bounds reachable.
// - **Two-1s isolation** — an edge between two `required=1` islands cannot
//   be the only edge connecting them to the rest (would form a 2-island
//   sub-component).
// - **Connectivity cut** — if removing an UNKNOWN edge would disconnect a
//   known-required-positive sub-component from the rest, force it positive.
//
// After local rules stall, at `_depth === 0` and `!_inLookahead`, runs 1-step
// lookahead: probe each unsettled edge with each feasible value, run
// lookahead-free inner propagate, force survivor on single-side
// contradictions. Then most-constrained backtracking.
//
// === Solution shape ===
//
// `{solved, edges: [{a, b, orientation: 'H'|'V', bridges: 1|2}, ...]}`.
// `a`/`b` are island indices in solver-edge-construction order (owner-first
// by iteration), NOT canonically sorted — the diff arm and `applyHashiState`
// both normalize via `Math.min`/`Math.max` so ordering doesn't matter
// downstream. Static `_solutionCache` 50-entry LRU keyed FNV-1a of
// `(rows, cols, islands sorted by (r, c), target each)`; **deep-copy via
// `_cloneResult` on store and get** (the edge list could otherwise be
// mutated by callers and corrupt the cache).

class HashiSolver {
  constructor(data) {
    const { rows, cols, islands } = data;
    this.rows = rows;
    this.cols = cols;
    // Copy islands into normalized {r, c, target} form, indexed by id.
    // Validate target up-front: parseInt('') === NaN and Int8Array silently
    // coerces NaN → 0, which would produce a degenerate "no bridges"
    // solution reported as solved=true. Reject non-finite or out-of-range
    // targets immediately so the caller can surface a real diagnostic.
    this.islands = islands.map((i, idx) => {
      const target = i.number;
      if (!Number.isInteger(target) || target < 1 || target > 8) {
        throw new Error(`HashiSolver: island ${idx} at (${i.row},${i.col}) has invalid target ${target}`);
      }
      return { r: i.row, c: i.col, target };
    });
    const K = this.islands.length;

    // byPos[r*cols+c] → island id (or -1).
    this.byPos = new Int32Array(rows * cols).fill(-1);
    for (let id = 0; id < K; id++) {
      const { r, c } = this.islands[id];
      this.byPos[r * cols + c] = id;
    }

    // Enumerate edges: for each island, find nearest right neighbour and
    // nearest bottom neighbour (mirrors page's `right`/`bottom` ownership).
    this.edges = [];
    this.incident = Array.from({ length: K }, () => []);
    for (let id = 0; id < K; id++) {
      const { r, c } = this.islands[id];
      // Right neighbour
      for (let c2 = c + 1; c2 < cols; c2++) {
        const nid = this.byPos[r * cols + c2];
        if (nid >= 0) {
          const e = { a: id, b: nid, orientation: 'H', r, c1: c, c2 };
          const ei = this.edges.length;
          this.edges.push(e);
          this.incident[id].push(ei);
          this.incident[nid].push(ei);
          break;
        }
      }
      // Bottom neighbour
      for (let r2 = r + 1; r2 < rows; r2++) {
        const nid = this.byPos[r2 * cols + c];
        if (nid >= 0) {
          const e = { a: id, b: nid, orientation: 'V', c, r1: r, r2 };
          const ei = this.edges.length;
          this.edges.push(e);
          this.incident[id].push(ei);
          this.incident[nid].push(ei);
          break;
        }
      }
    }

    const E = this.edges.length;
    this.lo = new Int8Array(E); // all 0
    this.hi = new Int8Array(E);
    for (let i = 0; i < E; i++) {
      const e = this.edges[i];
      this.hi[i] = Math.min(2, this.islands[e.a].target, this.islands[e.b].target);
    }

    // Precompute crossings: an H edge at row r spanning [c1+1, c2-1]
    // crosses a V edge at col c spanning [r1+1, r2-1] iff
    // c1 < c < c2 AND r1 < r < r2.
    this.crosses = Array.from({ length: E }, () => []);
    for (let i = 0; i < E; i++) {
      const ei = this.edges[i];
      if (ei.orientation !== 'H') continue;
      for (let j = 0; j < E; j++) {
        const ej = this.edges[j];
        if (ej.orientation !== 'V') continue;
        if (ei.c1 < ej.c && ej.c < ei.c2 && ej.r1 < ei.r && ei.r < ej.r2) {
          this.crosses[i].push(j);
          this.crosses[j].push(i);
        }
      }
    }

    this.trail = [];
    this._depth = 0;
    this._inLookahead = false;
    this.maxMs = data.maxMs || 0;
    this._startedAt = 0;
  }

  _assign(ei, newLo, newHi) {
    // Monotonic tighten: caller must ensure newLo >= lo[ei] && newHi <= hi[ei].
    // Returns false on no-op (avoids trail bloat under redundant tightening).
    const oldLo = this.lo[ei], oldHi = this.hi[ei];
    if (oldLo === newLo && oldHi === newHi) return false;
    this.trail.push(ei, oldLo, oldHi);
    this.lo[ei] = newLo;
    this.hi[ei] = newHi;
    return true;
  }

  _rollback(mark) {
    while (this.trail.length > mark) {
      const oldHi = this.trail.pop();
      const oldLo = this.trail.pop();
      const ei = this.trail.pop();
      this.lo[ei] = oldLo;
      this.hi[ei] = oldHi;
    }
  }

  _applyCrossings() {
    // For each edge with lo ≥ 1, force all crossing partners to hi = 0.
    // Contradiction if any crossing partner already has lo > 0.
    for (let i = 0; i < this.edges.length; i++) {
      if (this.lo[i] < 1) continue;
      const partners = this.crosses[i];
      for (let k = 0; k < partners.length; k++) {
        const j = partners[k];
        if (this.lo[j] > 0) return false;
        if (this.hi[j] > 0) this._assign(j, 0, 0);
      }
    }
    return true;
  }

  _applyDegree() {
    // For each island, enforce sum(bridges) == target on incident edges.
    // Iterate to fixpoint (a tightening on one edge can cascade through
    // the other endpoint).
    let changed = true;
    while (changed) {
      changed = false;
      for (let id = 0; id < this.islands.length; id++) {
        const target = this.islands[id].target;
        const inc = this.incident[id];
        let degMin = 0, degMax = 0;
        for (let k = 0; k < inc.length; k++) {
          degMin += this.lo[inc[k]];
          degMax += this.hi[inc[k]];
        }
        if (degMin > target || degMax < target) return false;
        for (let k = 0; k < inc.length; k++) {
          const ei = inc[k];
          // newLo = max(lo[ei], target - (degMax - hi[ei]))
          const newLo = Math.max(this.lo[ei], target - (degMax - this.hi[ei]));
          // newHi = min(hi[ei], target - (degMin - lo[ei]))
          const newHi = Math.min(this.hi[ei], target - (degMin - this.lo[ei]));
          if (newLo > newHi) return false;
          if (newLo !== this.lo[ei] || newHi !== this.hi[ei]) {
            const dLo = newLo - this.lo[ei];
            const dHi = newHi - this.hi[ei];
            this._assign(ei, newLo, newHi);
            degMin += dLo;
            degMax += dHi;
            changed = true;
          }
        }
      }
    }
    return true;
  }

  _applyTwoOnesIsolation() {
    // An edge between two islands with target=1 forms a closed 2-component
    // when given 1 bridge. Forbid it unless the puzzle is exactly those
    // two islands.
    if (this.islands.length <= 2) return true;
    for (let i = 0; i < this.edges.length; i++) {
      const e = this.edges[i];
      if (this.islands[e.a].target === 1 && this.islands[e.b].target === 1) {
        if (this.lo[i] > 0) return false;
        if (this.hi[i] > 0) this._assign(i, 0, 0);
      }
    }
    return true;
  }

  _applyConnectivityCut() {
    // Cheap reachability check: for each undecided edge e with hi[e] > 0,
    // check whether removing it (treating hi=0) would split the graph
    // into multiple components when only using edges with hi > 0.
    // If so, lo[e] must be ≥ 1 (the edge is a cut).
    const K = this.islands.length;
    if (K <= 1) return true;
    for (let i = 0; i < this.edges.length; i++) {
      if (this.hi[i] === 0) continue;
      if (this.lo[i] >= 1) continue;
      // Check connectivity skipping edge i.
      const visited = new Uint8Array(K);
      const stack = [0];
      visited[0] = 1;
      while (stack.length) {
        const u = stack.pop();
        const inc = this.incident[u];
        for (let k = 0; k < inc.length; k++) {
          const ei = inc[k];
          if (ei === i) continue;
          if (this.hi[ei] === 0) continue;
          const v = this.edges[ei].a === u ? this.edges[ei].b : this.edges[ei].a;
          if (!visited[v]) { visited[v] = 1; stack.push(v); }
        }
      }
      let allReachable = true;
      for (let v = 0; v < K; v++) {
        if (!visited[v]) { allReachable = false; break; }
      }
      if (!allReachable) {
        // Edge i is a cut. Force lo ≥ 1.
        if (this.hi[i] < 1) return false;
        this._assign(i, Math.max(this.lo[i], 1), this.hi[i]);
      }
    }
    return true;
  }

  propagate() {
    // Iterate the four cheap rules to a fixpoint, then lookahead at top
    // level only.
    let changedOverall = true;
    while (changedOverall) {
      if (this._timeUp()) return true; // bail without contradicting
      changedOverall = false;
      const mark = this.trail.length;
      if (!this._applyCrossings()) return false;
      if (!this._applyDegree()) return false;
      if (!this._applyTwoOnesIsolation()) return false;
      if (!this._applyConnectivityCut()) return false;
      if (this.trail.length > mark) changedOverall = true;
    }
    if (this._depth === 0 && !this._inLookahead) {
      if (!this._applyLookahead()) return false;
    }
    return true;
  }

  _applyLookahead() {
    // For each undecided edge, probe each remaining value. If exactly one
    // value propagates without contradiction, force the survivor.
    let changed = true;
    while (changed) {
      if (this._timeUp()) return true;
      changed = false;
      for (let i = 0; i < this.edges.length; i++) {
        if (this.lo[i] === this.hi[i]) continue;
        const survivors = [];
        for (let v = this.lo[i]; v <= this.hi[i]; v++) {
          const mark = this.trail.length;
          this._inLookahead = true;
          this._assign(i, v, v);
          const ok = this.propagate();
          this._rollback(mark);
          this._inLookahead = false;
          if (ok) survivors.push(v);
          if (survivors.length > 1) break;
        }
        if (survivors.length === 0) return false;
        if (survivors.length === 1 && (this.lo[i] !== survivors[0] || this.hi[i] !== survivors[0])) {
          this._assign(i, survivors[0], survivors[0]);
          if (!this._applyCrossings()) return false;
          if (!this._applyDegree()) return false;
          changed = true;
        }
      }
    }
    return true;
  }

  _timeUp() {
    if (this.maxMs <= 0) return false;
    return (Date.now() - this._startedAt) > this.maxMs;
  }

  static _solutionCache = new Map();
  static _maxSolutionCache = 50;

  static clearSolutionCache() {
    HashiSolver._solutionCache.clear();
  }

  _cacheKey() {
    // FNV-1a over (rows, cols, islands sorted by (row, col)).
    return hashFNV1a((mix) => {
      mix(this.rows); mix(this.cols); mix(this.islands.length);
      const sorted = this.islands.slice().sort((a, b) =>
        a.r - b.r || a.c - b.c);
      for (const i of sorted) { mix(i.r); mix(i.c); mix(i.target); }
    });
  }

  _cloneResult(result) {
    return {
      solved: result.solved,
      edges: result.edges.map(e => ({ ...e })),
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  }

  _storeInCache(key, result) {
    const m = HashiSolver._solutionCache;
    if (m.size >= HashiSolver._maxSolutionCache) {
      const first = m.keys().next().value;
      m.delete(first);
    }
    m.set(key, this._cloneResult(result));
  }

  solve() {
    const key = this._cacheKey();
    const cached = HashiSolver._solutionCache.get(key);
    if (cached) return this._cloneResult(cached);
    this._startedAt = Date.now();
    let result;
    if (!this.propagate()) {
      // propagate() returns false on contradiction without rolling back its
      // mid-fixpoint writes; emit() on that dirty state would surface
      // contradictory values. Roll back first so the cached result reflects
      // an empty (or original) state instead of inconsistent forced edges.
      this._rollback(0);
      result = { solved: false, edges: [] };
    } else if (this._isComplete()) {
      result = { solved: true, edges: this._emit() };
    } else if (!this._backtrack()) {
      // _backtrack rolls back per-branch, so on full failure the state is
      // the post-propagate snapshot — _emit() is sound either way. The
      // partial:true flag (timeout only) lets content.js surface deduced
      // edges as a preview instead of dropping them.
      const partial = this._emit();
      result = this._timeUp()
        ? { solved: false, edges: partial, error: 'timed out', partial: true }
        : { solved: false, edges: partial };
    } else {
      result = { solved: true, edges: this._emit() };
    }
    this._storeInCache(key, result);
    return result;
  }

  _backtrack() {
    // Most-constrained variable: largest pressure on tightest endpoint.
    let bestEi = -1;
    let bestScore = -1;
    for (let i = 0; i < this.edges.length; i++) {
      if (this.lo[i] === this.hi[i]) continue;
      const e = this.edges[i];
      const tA = this.islands[e.a].target, tB = this.islands[e.b].target;
      const score = Math.max(tA, tB) * 10 + (this.hi[i] - this.lo[i]);
      if (score > bestScore) { bestScore = score; bestEi = i; }
    }
    if (bestEi === -1) return this._isComplete();

    this._depth++;
    // Branch high → low.
    for (let v = this.hi[bestEi]; v >= this.lo[bestEi]; v--) {
      const mark = this.trail.length;
      this._assign(bestEi, v, v);
      if (this.propagate() && this._backtrack()) {
        this._depth--;
        return true;
      }
      this._rollback(mark);
      if (this._timeUp()) break;
    }
    this._depth--;
    return false;
  }

  _isComplete() {
    // All edges decided + degrees match + single connected component.
    for (let i = 0; i < this.edges.length; i++) {
      if (this.lo[i] !== this.hi[i]) return false;
    }
    const K = this.islands.length;
    const deg = new Int32Array(K);
    for (let i = 0; i < this.edges.length; i++) {
      if (this.lo[i] === 0) continue;
      deg[this.edges[i].a] += this.lo[i];
      deg[this.edges[i].b] += this.lo[i];
    }
    for (let id = 0; id < K; id++) {
      if (deg[id] !== this.islands[id].target) return false;
    }
    // Connectivity over bridges ≥ 1.
    const visited = new Uint8Array(K);
    visited[0] = 1;
    const stack = [0];
    while (stack.length) {
      const u = stack.pop();
      const inc = this.incident[u];
      for (let k = 0; k < inc.length; k++) {
        const ei = inc[k];
        if (this.lo[ei] === 0) continue;
        const v = this.edges[ei].a === u ? this.edges[ei].b : this.edges[ei].a;
        if (!visited[v]) { visited[v] = 1; stack.push(v); }
      }
    }
    for (let id = 0; id < K; id++) if (!visited[id]) return false;
    return true;
  }

  _emit() {
    const out = [];
    for (let i = 0; i < this.edges.length; i++) {
      if (this.lo[i] !== this.hi[i]) continue;
      if (this.lo[i] === 0) continue;
      const e = this.edges[i];
      out.push({ a: e.a, b: e.b, orientation: e.orientation, bridges: this.lo[i] });
    }
    return out;
  }

  getHint(currentEdges) {
    // Seed bounds from currentEdges: any edge currently set to N → lo=hi=N.
    // Then propagate; collect newly-decided edges as hints. Fall back to
    // solve() and emit gap edges if propagation alone doesn't deduce.
    //
    // Edge keys are always min-max normalized: solver-side this.edges[i]
    // may have e.a > e.b (page's island ordering isn't guaranteed
    // row-major), but readHashiState always normalizes the pair to
    // (min, max) before passing in, so we have to look up by the same
    // shape.
    const K = this.islands.length;
    const minLines = Math.max(1, Math.ceil(K / 10));
    const keyOf = (a, b) => `${Math.min(a, b)}-${Math.max(a, b)}`;

    // Build a key for the current edge set so we can apply hints. The page
    // (and readHashiState) emits ALL neighbour pairs including bridges=0
    // for unconnected pairs — those are "unknown / blank" in hashi semantics,
    // not "forced to 0". Skip them on seed; only drawn bridges (1 or 2)
    // count as user assignments.
    const currentMap = new Map();
    for (const e of currentEdges) {
      currentMap.set(keyOf(e.a, e.b), e.bridges);
    }
    // Seed. On bounds-contradiction we restore and bail with []; the
    // contradiction-vs-stalled distinction is the stepwise hint's concern,
    // not the array-returning getHint's.
    for (let i = 0; i < this.edges.length; i++) {
      const e = this.edges[i];
      const key = keyOf(e.a, e.b);
      if (currentMap.has(key)) {
        const v = currentMap.get(key);
        if (v === 0) continue; // unconnected — leave as unknown
        if (v < this.lo[i] || v > this.hi[i]) {
          this._rollback(0);
          return [];
        }
        this._assign(i, v, v);
      }
    }
    if (!this.propagate()) {
      this._rollback(0);
      return [];
    }
    // Collect newly forced edges (those that became lo=hi after seed).
    // Skip lo===0 deductions — they're forced rule-outs the user can't draw.
    const hints = [];
    for (let i = 0; i < this.edges.length; i++) {
      if (this.lo[i] !== this.hi[i]) continue;
      if (this.lo[i] === 0) continue;
      const e = this.edges[i];
      const key = keyOf(e.a, e.b);
      if (currentMap.has(key) && currentMap.get(key) === this.lo[i]) continue;
      hints.push({ a: e.a, b: e.b, orientation: e.orientation, bridges: this.lo[i] });
      if (hints.length >= minLines) return hints;
    }
    // Fallback: solve and emit gap edges (excluding bridges=0 since they
    // aren't visible board changes).
    this._rollback(0); // reset for clean solve
    const r = this.solve();
    if (!r.solved) return hints;
    for (const e of r.edges) {
      const key = keyOf(e.a, e.b);
      if (currentMap.get(key) !== e.bridges) {
        hints.push(e);
        if (hints.length >= minLines) break;
      }
    }
    return hints;
  }

  // Stepwise hint: returns the next visible logical deduction. Each call
  // surfaces ONE rule firing that yields at least one positive bridge the
  // user can draw on the board. Rule-outs (forced to 0 bridges) are not
  // applicable on the page UI, so they're applied silently inside this
  // call and only the rule whose positive deduction emerges is named.
  //
  // Rule order, cheapest first:
  //   1. degree-saturate (per-island sum constraint forcing to 2-bridges)
  //   2. two-1s isolation (rule-out — silent)
  //   3. crossing exclusion (rule-out — silent)
  //   4. degree-tighten (per-island producing positives)
  //   5. connectivity cut (positive)
  //   6. 1-step lookahead (positive)
  //
  // Return shape:
  //   { edges:[{a,b,orientation,bridges}], rule:string, description:string }
  //   { contradiction: true } when the user's current bridges conflict with
  //     the puzzle bounds — caller surfaces a specific "your bridges
  //     conflict" status instead of the generic "no more deductions"
  //   null when no further positive deduction is possible.
  getStepwiseHint(currentEdges) {
    // Edge keys are min-max normalized because this.edges[i] may have
    // e.a > e.b (page island order isn't guaranteed row-major), while
    // currentEdges from readHashiState are already normalized.
    const keyOf = (a, b) => `${Math.min(a, b)}-${Math.max(a, b)}`;
    // Build current map (skip bridges=0 — those are unknown, not "forced 0").
    const currentMap = new Map();
    for (const e of currentEdges || []) {
      if (e.bridges > 0) {
        currentMap.set(keyOf(e.a, e.b), e.bridges);
      }
    }

    // Seed from current. Bounds violation ⇒ user has drawn an inconsistent
    // configuration; surface as a structured contradiction so the UI can
    // tell the user instead of falsely claiming "no more deductions".
    for (let i = 0; i < this.edges.length; i++) {
      const e = this.edges[i];
      const key = keyOf(e.a, e.b);
      if (currentMap.has(key)) {
        const v = currentMap.get(key);
        if (v < this.lo[i] || v > this.hi[i]) {
          this._rollback(0);
          return { contradiction: true };
        }
        this._assign(i, v, v);
      }
    }

    const fmtPos = (id) => {
      const isl = this.islands[id];
      return `(row ${isl.r + 1}, col ${isl.c + 1})`;
    };
    const done = (result) => { this._rollback(0); return result; };

    // Collect edges newly decided since `mark` whose final value is POSITIVE
    // and that the user hasn't already drawn at that value. Used to detect
    // "is this firing producing something the user can act on?"
    const positiveSince = (mark) => {
      const seen = new Set();
      const out = [];
      for (let t = mark; t < this.trail.length; t += 3) {
        const ei = this.trail[t];
        if (seen.has(ei)) continue;
        seen.add(ei);
        if (this.lo[ei] !== this.hi[ei]) continue;
        if (this.lo[ei] === 0) continue;
        const e = this.edges[ei];
        const key = keyOf(e.a, e.b);
        if (currentMap.has(key) && currentMap.get(key) === this.lo[ei]) continue;
        out.push({ a: e.a, b: e.b, orientation: e.orientation, bridges: this.lo[ei] });
      }
      return out;
    };
    const anyChangeSince = (mark) => this.trail.length > mark;

    // Outer loop: silently apply rule-outs (two-1s, crossings, degree-leftover)
    // until a rule produces at least one POSITIVE deduction. Each iteration
    // tries the rules in priority order; rule-outs accumulate inside this
    // call so subsequent rule passes see the tightened state.
    let safety = 0;
    while (safety++ < this.edges.length * 4 + 10) {
      // ── Rule 1: per-island degree forcing (can yield positives or rule-outs)
      let degreePositive = null;
      let degreeChanged = false;
      for (let id = 0; id < this.islands.length; id++) {
        const target = this.islands[id].target;
        const inc = this.incident[id];
        let degMin = 0, degMax = 0;
        for (let k = 0; k < inc.length; k++) {
          degMin += this.lo[inc[k]];
          degMax += this.hi[inc[k]];
        }
        if (degMin > target || degMax < target) return done(null);
        if (degMin === target && degMax === target) continue;

        const mark = this.trail.length;
        let tightened = false;
        for (let k = 0; k < inc.length; k++) {
          const ei = inc[k];
          const newLo = Math.max(this.lo[ei], target - (degMax - this.hi[ei]));
          const newHi = Math.min(this.hi[ei], target - (degMin - this.lo[ei]));
          if (newLo > newHi) return done(null);
          if (newLo !== this.lo[ei] || newHi !== this.hi[ei]) {
            const dLo = newLo - this.lo[ei], dHi = newHi - this.hi[ei];
            this._assign(ei, newLo, newHi);
            degMin += dLo; degMax += dHi;
            tightened = true;
          }
        }
        if (!tightened) continue;
        degreeChanged = true;
        const positives = positiveSince(mark);
        if (positives.length > 0) {
          const pos = fmtPos(id);
          const allMax = positives.every(e => e.bridges === 2);
          const rule = allMax ? 'degree-saturate' : 'degree-tighten';
          const description = allMax
            ? `Island ${pos} target ${target} = max possible — each remaining edge must be 2 bridges.`
            : `Island ${pos} target ${target} forces ${positives.length === 1 ? 'a bridge' : 'bridges'} on its remaining edge${positives.length === 1 ? '' : 's'}.`;
          degreePositive = { edges: positives, rule, description, pivot: { island: id } };
          break;
        }
        // Rule-out only (degree-leftover) — applied, continue scanning.
      }
      if (degreePositive) return done(degreePositive);

      // ── Rule 2: two-1s isolation (silent rule-outs only) ─────────────
      let twoOnesChanged = false;
      if (this.islands.length > 2) {
        for (let i = 0; i < this.edges.length; i++) {
          if (this.hi[i] === 0) continue;
          const e = this.edges[i];
          if (this.islands[e.a].target !== 1 || this.islands[e.b].target !== 1) continue;
          if (this.lo[i] > 0) return done(null);
          this._assign(i, 0, 0);
          twoOnesChanged = true;
        }
      }

      // ── Rule 3: crossing exclusion (silent rule-outs only) ───────────
      let crossingChanged = false;
      for (let i = 0; i < this.edges.length; i++) {
        if (this.lo[i] < 1) continue;
        const partners = this.crosses[i];
        for (let k = 0; k < partners.length; k++) {
          const j = partners[k];
          if (this.hi[j] === 0) continue;
          if (this.lo[j] > 0) return done(null);
          this._assign(j, 0, 0);
          crossingChanged = true;
        }
      }

      // If silent rule-outs changed anything, restart so degree forcing can
      // pick up positives enabled by the new constraints.
      if (twoOnesChanged || crossingChanged || degreeChanged) continue;

      // ── Rule 4: connectivity cut (positive only) ─────────────────────
      const K = this.islands.length;
      if (K > 1) {
        for (let i = 0; i < this.edges.length; i++) {
          if (this.hi[i] === 0 || this.lo[i] >= 1) continue;
          const visited = new Uint8Array(K);
          const stack = [0];
          visited[0] = 1;
          while (stack.length) {
            const u = stack.pop();
            const inc = this.incident[u];
            for (let k = 0; k < inc.length; k++) {
              const ei2 = inc[k];
              if (ei2 === i) continue;
              if (this.hi[ei2] === 0) continue;
              const v = this.edges[ei2].a === u ? this.edges[ei2].b : this.edges[ei2].a;
              if (!visited[v]) { visited[v] = 1; stack.push(v); }
            }
          }
          let allReachable = true;
          for (let v = 0; v < K; v++) { if (!visited[v]) { allReachable = false; break; } }
          if (allReachable) continue;
          const mark = this.trail.length;
          this._assign(i, Math.max(this.lo[i], 1), this.hi[i]);
          const positives = positiveSince(mark);
          if (positives.length === 0) {
            // The cut forced lo≥1 but the edge still has hi=2 (so lo=1, hi=2
            // — not yet a positive decision). Apply degree on its endpoints
            // to potentially resolve, then keep going by restarting outer.
            if (anyChangeSince(mark)) break;
            continue;
          }
          const e = this.edges[i];
          const description = `Without a bridge between ${fmtPos(e.a)} and ${fmtPos(e.b)}, the network would be disconnected — at least one bridge required.`;
          return done({
            edges: positives,
            rule: 'connectivity-cut',
            description,
            pivot: { edge: i },
          });
        }
      }

      // ── Rule 5: 1-step lookahead (positive only) ─────────────────────
      if (this._depth === 0 && !this._inLookahead) {
        for (let i = 0; i < this.edges.length; i++) {
          if (this.lo[i] === this.hi[i]) continue;
          const survivors = [];
          for (let v = this.lo[i]; v <= this.hi[i]; v++) {
            const probeMark = this.trail.length;
            this._inLookahead = true;
            this._assign(i, v, v);
            const ok = this.propagate();
            this._rollback(probeMark);
            this._inLookahead = false;
            if (ok) survivors.push(v);
            if (survivors.length > 1) break;
          }
          if (survivors.length === 0) return done(null);
          if (survivors.length === 1) {
            const survivor = survivors[0];
            const mark = this.trail.length;
            this._assign(i, survivor, survivor);
            const positives = positiveSince(mark);
            if (positives.length === 0) continue; // forced to 0, keep scanning
            const e = this.edges[i];
            const description = `Trying any value other than ${survivor} bridge${survivor === 1 ? '' : 's'} between ${fmtPos(e.a)} and ${fmtPos(e.b)} leads to a contradiction.`;
            return done({
              edges: positives,
              rule: 'lookahead',
              description,
              pivot: { edge: i },
            });
          }
        }
      }

      // Nothing fired this iteration; exit loop and try fallback.
      break;
    }

    // ── Fallback: solve and emit one gap edge ─────────────────────────
    this._rollback(0); // clean state for cached solve
    const r = this.solve();
    if (!r.solved) return null;
    for (const e of r.edges) {
      const key = `${Math.min(e.a, e.b)}-${Math.max(e.a, e.b)}`;
      const cur = currentMap.get(key);
      if (cur !== e.bridges) {
        return {
          edges: [e],
          rule: 'solve-gap',
          description: `From the complete solution: bridge between ${fmtPos(e.a)} and ${fmtPos(e.b)} (${e.bridges} bridge${e.bridges === 1 ? '' : 's'}).`,
          pivot: null,
        };
      }
    }
    return null; // already solved
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { HashiSolver };
}
