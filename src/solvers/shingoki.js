'use strict';

// Shingoki (loop) solver. Single closed loop on a (rows+1)x(cols+1) vertex
// lattice. task[r][c] is a vertex clue: >0 white (loop straight through), <0
// black (loop turns), abs = number = sum (in edges) of the two straight runs
// meeting at the circle, 0 = no circle. Loop state is edge-based:
//   H[r][c] connects vertex (r,c)-(r,c+1), dims (rows+1) x cols
//   V[r][c] connects vertex (r,c)-(r+1,c), dims rows x (cols+1)
// Edge tri-state: 0 unknown, 1 line, 2 cross. Output mirrors Slitherlink's
// { horizontal, vertical } so the widget reuses edge conventions.
// Deductive hint entry point: getStepwiseHint(curH, curV) — propagation +
// 1-step lookahead; returns forced LINE edges or null (see the deductive-hint spec).
//
// === Adaptive DFS search engine ===
//
// solve() runs a recursive backtracking search over edge values, built on the
// sound primitives _propagate (degree/shape/axis/run-cap), the change-trail
// (setEdge push + _trailMark/_rollbackTo), the structural prunes
// (_hasPrematureLoop / _deadByConnectivity), and the acceptance gate
// _isValidComplete. Branch selection (_pickBranch) is adaptive and
// SOUND-NEUTRAL: it extends a committed chain (LINE first) where one exists,
// else picks a constraint-focused edge by probing which assignment propagates
// most. CDCL was tried and removed: ~88% of conflicts on real boards are
// structural (connectivity) with no tight var-reason, so clause learning was
// useless AND bloated propagation, regressing small boards (see the
// adaptive-DFS design spec).
//
// Partial-on-timeout: a searchMs deep-search cap (~6 s; maxMs is the outer
// ceiling) unwinds via a thrown SEARCH_BUDGET sentinel, and solve() returns the
// level-0 propagation snapshot captured before the first branch — a SOUND
// partial (every edge entailed by the clues, no vertex degree > 2). Only a
// budget bail yields a partial; an exhausted tree returns 'no solution'.
//
// Measured reality (real captured boards): the 7x7-hard and dense/fully-clued
// boards solve in a few seconds. Real HARD boards >=10x10 do NOT fully solve in
// budget — the deduction engine stalls at ~9-16 edges and the residual search
// space is astronomical (CDCL and iterated lookahead also fail them) — so they
// return a sound partial at the searchMs cap (the 'finish manually' widget
// path). Solving real mid-size hard boards needs a much stronger deduction
// engine (advanced number-reachability / loop-parity / region connectivity),
// which is out of scope here. See the adaptive-DFS design spec's revised
// success criteria.
const { timeUp } = require('./shared.js');

// Thrown by _dfs to unwind to solve() when the deep-search budget expires.
// Distinct object identity so solve() can tell a budget bail from a real error.
const SEARCH_BUDGET = { budget: true };

class ShingokiSolver {
  static decodeClue(v) {
    if (!v) return null;
    return v > 0 ? { color: 'white', n: v } : { color: 'black', n: -v };
  }

  constructor({ rows, cols, task, maxMs = 0, searchMs = 6000 }) {
    this.rows = rows;
    this.cols = cols;
    this.task = task;
    this.maxMs = maxMs;
    // Deep-search budget for the adaptive DFS. When exceeded, solve() returns the
    // sound level-0 propagation partial instead of grinding the full maxMs. The
    // searchMs cap fires first in practice; maxMs is an outer ceiling. Pass 0 to
    // disable searchMs (rely on maxMs only).
    this._searchMs = searchMs;
    this._heavyBudgetMs = 0;
    this._hintBudgetMs = 800;
    this._startedAt = 0;
  }

  // Four incident edges of vertex (r,c), in-range only.
  incidentEdges(r, c) {
    const { rows, cols } = this;
    const out = [];
    if (c - 1 >= 0)   out.push({ kind: 'H', r, c: c - 1 }); // West
    if (c < cols)     out.push({ kind: 'H', r, c });        // East
    if (r - 1 >= 0)   out.push({ kind: 'V', r: r - 1, c }); // North
    if (r < rows)     out.push({ kind: 'V', r, c });        // South
    return out;
  }

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

  _initState() {
    const { rows, cols } = this;
    this.H = Array.from({ length: rows + 1 }, () => new Array(cols).fill(0));
    this.V = Array.from({ length: rows }, () => new Array(cols + 1).fill(0));
    this._trail = [];
  }

  getEdge(ref) {
    return ref.kind === 'H' ? this.H[ref.r][ref.c] : this.V[ref.r][ref.c];
  }

  // Returns false if this contradicts an existing different non-zero value.
  setEdge(ref, val) {
    const cur = this.getEdge(ref);
    if (cur === val) return true;
    if (cur !== 0) return false;
    if (this._trail) this._trail.push(ref.kind, ref.r, ref.c, cur);
    if (ref.kind === 'H') this.H[ref.r][ref.c] = val; else this.V[ref.r][ref.c] = val;
    return true;
  }

  _trailMark() { return this._trail ? this._trail.length : 0; }

  _rollbackTo(mark) {
    const t = this._trail;
    if (!t) return;
    while (t.length > mark) {
      const prev = t.pop(), c = t.pop(), r = t.pop(), kind = t.pop();
      if (kind === 'H') this.H[r][c] = prev; else this.V[r][c] = prev;
    }
  }

  // Endpoints (vertices) of an edge, for worklist enqueue.
  _endpoints(ref) {
    return ref.kind === 'H'
      ? [{ r: ref.r, c: ref.c }, { r: ref.r, c: ref.c + 1 }]
      : [{ r: ref.r, c: ref.c }, { r: ref.r + 1, c: ref.c }];
  }

  _propagate() {
    const { rows, cols } = this;
    const queue = [];
    const seen = new Set();
    const enq = (r, c) => { const k = r * (cols + 2) + c; if (!seen.has(k)) { seen.add(k); queue.push([r, c]); } };
    for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) enq(r, c);

    const trySet = (ref, val) => {
      const before = this.getEdge(ref);
      if (!this.setEdge(ref, val)) return false;
      if (this.getEdge(ref) !== before) for (const v of this._endpoints(ref)) { seen.delete(v.r*(cols+2)+v.c); enq(v.r, v.c); }
      return true;
    };

    while (queue.length) {
      const [r, c] = queue.pop();
      seen.delete(r * (cols + 2) + c);
      const inc = this.incidentEdges(r, c);
      let lines = 0, crosses = 0;
      for (const e of inc) { const v = this.getEdge(e); if (v === 1) lines++; else if (v === 2) crosses++; }
      const unknown = inc.length - lines - crosses;
      const clue = ShingokiSolver.decodeClue(this.task[r][c]);

      // Degree rule: a vertex is degree 0 or 2.
      if (lines > 2) return false;
      if (lines === 2) { for (const e of inc) if (this.getEdge(e) === 0) if (!trySet(e, 2)) return false; }
      // If only 2 edges can still be lines and a 2 is required, force them.
      if (lines === 1 && unknown === 1) {
        // degree must reach 2: the one unknown becomes a line.
        for (const e of inc) if (this.getEdge(e) === 0) if (!trySet(e, 1)) return false;
      }
      // No vertex (clued or empty) may end at degree exactly 1.
      if (lines === 1 && unknown === 0) return false;
      // Circled vertex must be degree 2 (cannot be 0).
      if (clue) {
        if (lines + unknown < 2) return false; // can't reach degree 2
        if (lines === 0 && unknown === 2) { for (const e of inc) if (this.getEdge(e) === 0) if (!trySet(e, 1)) return false; }
      }

      // Border/axis forcing (sound opening deductions).
      if (clue) {
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
      }

      // Circle shape rules apply once we know the two line-edges OR can force them.
      if (clue) {
        const lineRefs = inc.filter(e => this.getEdge(e) === 1);
        const isH = (e) => e.kind === 'H';
        if (clue.color === 'white') {
          // straight: the two loop edges are collinear (both H or both V).
          // If one line is set, force its opposite collinear partner to line and the perpendicular pair to cross.
          if (lineRefs.length >= 1) {
            const straightKind = isH(lineRefs[0]) ? 'H' : 'V';
            for (const e of inc) {
              if (e.kind === straightKind) { if (this.getEdge(e) === 0 && !trySet(e, 1)) return false; }
              else { if (this.getEdge(e) === 0 && !trySet(e, 2)) return false; }
            }
          }
        } else {
          // black: turn -> the two loop edges are perpendicular (one H, one V).
          if (lineRefs.length >= 1) {
            const sameKind = isH(lineRefs[0]) ? 'H' : 'V';
            // the collinear partner of the known line must be cross.
            for (const e of inc) if (e.kind === sameKind && this.getEdge(e) === 0) if (!trySet(e, 2)) return false;
          }
        }
        if (!this._applyRunCap(r, c, clue, trySet)) return false;
      }
    }
    return true;
  }

  // Tier 2 heavy deduction: runs one pass of the expensive rules (added in later
  // tasks). Returns false on contradiction, and sets `this._heavyChanged = true`
  // if it forced any edge. `budgetMs` (0 = unbounded) caps the pass; on expiry it
  // returns true without finishing (sound: it only ever FORCES, never relaxes).
  _deduceHeavy(_budgetMs) {
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

  // Length (in line-edges) of the maximal straight runs through vertex (r,c),
  // summed over its two loop directions. Assumes the vertex is on the loop with
  // a definite shape (used at a complete assignment / when edges are set).
  runLengthAt(r, c) {
    const { rows, cols } = this;
    // walk in a direction following collinear line edges
    const walk = (dr, dc) => {
      let len = 0, cr = r, cc = c;
      for (;;) {
        const nr = cr + dr, nc = cc + dc; let edgeVal;
        if (dr === 0) { // horizontal: edge between (cr,cc) and (cr,nc)
          const ec = Math.min(cc, nc);
          if (ec < 0 || ec >= cols || cr < 0 || cr > rows) break;
          edgeVal = this.H[cr][ec];
        } else { // vertical
          const er = Math.min(cr, nr);
          if (er < 0 || er >= rows || cc < 0 || cc > cols) break;
          edgeVal = this.V[er][cc];
        }
        if (edgeVal !== 1) break;
        len++; cr = nr; cc = nc;
      }
      return len;
    };
    // The two straight directions are the line-edge axis through the vertex.
    // Determine axis from incident line edges.
    const inc = this.incidentEdges(r, c).filter(e => this.getEdge(e) === 1);
    if (inc.length === 0) return 0;
    const horiz = inc.some(e => e.kind === 'H');
    const vert = inc.some(e => e.kind === 'V');
    let total = 0;
    if (horiz) total += walk(0, -1) + walk(0, 1);
    if (vert) total += walk(-1, 0) + walk(1, 0);
    return total;
  }

  // Run-cap: for a clued vertex with >=1 confirmed collinear line, if the
  // confirmed straight run already equals the clue number, force a cross at each
  // OPEN (unknown) end so the run can't grow; if it exceeds the number, signal a
  // contradiction. Returns false on contradiction. Only acts on confirmed (=1)
  // edges, so it's sound. `trySet` is passed in from _propagate to keep the
  // worklist coherent.
  _applyRunCap(r, c, clue, trySet) {
    const inc = this.incidentEdges(r, c).filter(e => this.getEdge(e) === 1);
    if (inc.length === 0) return true;
    // Walk a direction counting CONFIRMED line edges; return {len, endRef, edges}
    // where endRef is the next edge beyond the run (or null if border) and edges
    // is the list of confirmed run-edge refs traversed in that direction.
    const walk = (dr, dc) => {
      let len = 0, cr = r, cc = c, endRef = null;
      const edges = [];
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
        edges.push(ref);
        len++; cr = nr; cc = nc;
      }
      return { len, endRef, edges };
    };
    const horiz = inc.some(e => e.kind === 'H');
    const vert = inc.some(e => e.kind === 'V');
    let total = 0;
    const ends = [];
    if (horiz) {
      const a = walk(0, -1), b = walk(0, 1);
      total += a.len + b.len; ends.push(a.endRef, b.endRef);
    }
    if (vert) {
      const a = walk(-1, 0), b = walk(1, 0);
      total += a.len + b.len; ends.push(a.endRef, b.endRef);
    }
    if (total > clue.n) return false;
    if (total === clue.n) {
      for (const ref of ends) {
        if (ref && this.getEdge(ref) === 0 && !trySet(ref, 2)) return false;
      }
    }
    return true;
  }

  numbersSatisfied() {
    const { rows, cols } = this;
    for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
      const clue = ShingokiSolver.decodeClue(this.task[r][c]);
      if (!clue) continue;
      if (this.runLengthAt(r, c) !== clue.n) return false;
    }
    return true;
  }

  // Public entry: adaptive DFS. Returns { solved, horizontal, vertical, error? }.
  // On a deep-search budget bail it attaches a SOUND partial — the level-0
  // snapshot of edges deduced from the givens alone, captured before any branch.
  // Genuine UNSAT (full tree exhausted) returns error 'no solution', never a
  // partial; only a budget bail yields a partial. The flat slitherlink-shaped
  // partial (top-level horizontal/vertical + partial:true) lets the widget's
  // type-agnostic {horizontal,vertical} partial arm apply it with no
  // shingoki-specific dispatch.
  solve() {
    this._startedAt = Date.now();
    this._initState();
    if (!this._deduceAll(0)) {
      return { solved: false, horizontal: null, vertical: null, error: 'contradiction on initial propagation' };
    }
    const rootPartial = { horizontal: this.H.map(r => r.slice()), vertical: this.V.map(r => r.slice()) };
    this._budgetExceeded = false;
    let solved = false;
    try {
      solved = this._dfs();
    } catch (err) {
      if (err !== SEARCH_BUDGET) throw err;
      this._budgetExceeded = true;
    }
    if (solved) {
      return { solved: true, horizontal: this.H.map(r => r.slice()), vertical: this.V.map(r => r.slice()) };
    }
    if (this._budgetExceeded) {
      return {
        solved: false, horizontal: rootPartial.horizontal, vertical: rootPartial.vertical,
        partial: true, error: 'time limit exceeded',
      };
    }
    return { solved: false, horizontal: null, vertical: null, error: 'no solution' };
  }

  // Recursive adaptive DFS with trail-undo. Returns true if a valid complete
  // loop was found below this node, false on a dead branch. Throws SEARCH_BUDGET
  // when the deep-search/maxMs budget expires (unwinds to solve()). The
  // soundness rests entirely on _propagate + the structural prunes +
  // _isValidComplete; branch order is sound-neutral.
  _dfs() {
    if ((this._searchMs > 0 && timeUp(this._searchMs, this._startedAt)) ||
        (this.maxMs > 0 && timeUp(this.maxMs, this._startedAt))) throw SEARCH_BUDGET;
    if (!this._deduceAll(this._heavyBudgetMs ?? 0)) return false;
    if (this._hasPrematureLoop() || this._deadByConnectivity()) return false;
    const br = this._pickBranch();
    if (!br) return this._isValidComplete();
    for (const val of [br.firstVal, this._otherVal(br.firstVal)]) {
      const mark = this._trailMark();
      if (this.setEdge(br.ref, val) && this._dfs()) return true;
      this._rollbackTo(mark);
    }
    return false;
  }

  _firstUnassignedEdge() {
    for (const e of this._allEdgeRefs()) if (this.getEdge(e) === 0) return e;
    return null;
  }

  // Flip a decision value: LINE(1) <-> CROSS(2).
  _otherVal(v) { return v === 1 ? 2 : 1; }

  // Adaptive branch selection. Returns { ref, firstVal } for the next edge to
  // assign, or null when every edge is assigned. SOUND-NEUTRAL: affects only
  // search order/speed, never correctness.
  _pickBranch() {
    // Score each unknown edge by its endpoints' line-adjacency: an endpoint with
    // exactly one committed LINE (a chain endpoint, score 3) is the best place to
    // extend the loop; an endpoint already touching a line (score 2) is next;
    // an isolated edge scores 1. Take the global max, short-circuiting on the
    // first score-3 (chain extension), and try LINE(1) first. When nothing is
    // adjacent to a line (score 1 only — a sparse start), defer to the
    // probe-guided constraint-focused choice. SOUND-NEUTRAL.
    let best = null, bestScore = -1;
    for (const e of this._allEdgeRefs()) {
      if (this.getEdge(e) !== 0) continue;
      let sc = 0;
      for (const v of this._endpoints(e)) {
        const inc = this.incidentEdges(v.r, v.c);
        let ln = 0;
        for (const x of inc) if (this.getEdge(x) === 1) ln++;
        sc = Math.max(sc, ln === 1 ? 3 : ln > 0 ? 2 : 1);
      }
      if (sc > bestScore) { bestScore = sc; best = e; if (sc === 3) break; }
    }
    if (best === null) return null;             // all edges assigned
    if (bestScore <= 1) return this._pickConstrainedEdge(); // no chains -> constraint-focused
    return { ref: best, firstVal: 1 };
  }

  // Constraint-focused selection for when no chain endpoint exists (e.g. an
  // ultra-sparse board at the root). Probe-guided: among unknown edges incident
  // to a clued vertex, pick the one whose LINE assignment forces the most
  // propagation (focuses search the way the sparse-board case needs). Falls back
  // to the first unknown edge anywhere. Returns { ref, firstVal:1 } or null.
  _pickConstrainedEdge() {
    const { rows, cols } = this;
    let best = null, bestScore = -1;
    const seen = new Set();
    for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
      if (!this.task[r][c]) continue;
      for (const e of this.incidentEdges(r, c)) {
        if (this.getEdge(e) !== 0) continue;
        const k = e.kind + e.r + ',' + e.c;
        if (seen.has(k)) continue;
        seen.add(k);
        const score = this._probePropagationCount(e, 1);
        if (score > bestScore) { bestScore = score; best = e; }
      }
    }
    if (best) return { ref: best, firstVal: 1 };
    const any = this._firstUnassignedEdge();
    return any ? { ref: any, firstVal: 1 } : null;
  }

  // Edges determined by propagation after tentatively setting `e=val` on a clone
  // of the current state. Returns -1 if that assignment immediately contradicts
  // (so the caller prefers any non-contradicting edge). Mirrors _lookahead1's
  // probe pattern; pure (never mutates this.H/this.V).
  _probePropagationCount(e, val) {
    const probe = new ShingokiSolver({ rows: this.rows, cols: this.cols, task: this.task });
    probe.H = this.H.map(row => row.slice());
    probe.V = this.V.map(row => row.slice());
    let before = 0;
    for (const ref of probe._allEdgeRefs()) if (probe.getEdge(ref) !== 0) before++;
    if (!(probe.setEdge(e, val) && probe._propagate())) return -1;
    let after = 0;
    for (const ref of probe._allEdgeRefs()) if (probe.getEdge(ref) !== 0) after++;
    return after - before;
  }

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
    this._trail = [];
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
    if (!this._deduceAll(this._hintBudgetMs ?? 0)) return null; // contradictory board state; let caller fall back
    let edges = collect();
    if (edges.length === 0) {
      if (!this._lookahead1()) return null;
      edges = collect();
    }
    if (edges.length === 0) return null;
    const cap = Math.max(4, Math.ceil((this.rows * this.cols) / 30));
    return { edges: edges.slice(0, cap) };
  }

  _allEdgeRefs() {
    const { rows, cols } = this;
    const out = [];
    for (let r = 0; r <= rows; r++) for (let c = 0; c < cols; c++) out.push({ kind: 'H', r, c });
    for (let r = 0; r < rows; r++) for (let c = 0; c <= cols; c++) out.push({ kind: 'V', r, c });
    return out;
  }

  _loopVertices() {
    const { rows, cols } = this;
    const verts = [];
    for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
      if (this.incidentEdges(r, c).some(e => this.getEdge(e) === 1)) verts.push([r, c]);
    }
    return verts;
  }

  // A closed subloop is premature iff line edges form 2+ separate components
  // (a closed loop that can never merge with the rest). Unknown edges are NOT
  // evidence of prematurity — they may resolve to crosses, and a valid solution
  // may legitimately leave vertices off the loop. Pruning on unknown edges would
  // discard correct solutions whose loop doesn't cover every vertex.
  _hasPrematureLoop() {
    const { rows, cols } = this;
    // Any degree-1 vertex means the line graph is still an open chain — not a
    // closed loop yet, so nothing to prune.
    for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
      const deg = this.incidentEdges(r, c).filter(e => this.getEdge(e) === 1).length;
      if (deg === 1) return false;
    }
    // No degree-1 vertices: every line-vertex is degree 2. If the line edges
    // span more than one connected component, a closed subloop exists that can
    // never merge into a single loop => prune.
    return !this._oneClosedComponentOrOpen();
  }

  // True iff the committed LINE edges can never close into ONE loop through all
  // clued vertices. Sound: only reports states with NO valid completion.
  // Detects a premature closed subloop: a line-component that is already a closed
  // cycle (every vertex in it degree exactly 2) while ANOTHER line-component
  // exists OR a clued vertex lies outside it -> a 2nd component can never merge
  // into the closed one -> dead.
  _deadByConnectivity() {
    const { rows, cols } = this;
    const lineDeg = (r, c) => this.incidentEdges(r, c).filter(e => this.getEdge(e) === 1).length;
    const vid = (r, c) => r * (cols + 1) + c;
    const seen = new Uint8Array((rows + 1) * (cols + 1));
    const lineVerts = [];
    for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
      if (lineDeg(r, c) > 0) lineVerts.push([r, c]);
    }
    if (lineVerts.length === 0) return false;
    let components = 0;
    let sawClosed = false;
    for (const [sr, sc] of lineVerts) {
      if (seen[vid(sr, sc)]) continue;
      components++;
      let closed = true;
      const stack = [[sr, sc]]; seen[vid(sr, sc)] = 1;
      while (stack.length) {
        const [r, c] = stack.pop();
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
    if (sawClosed) {
      if (components > 1) return true; // a closed loop + something else can't merge
      // single closed component: every clued vertex must be ON it
      for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
        const clue = ShingokiSolver.decodeClue(this.task[r][c]);
        if (clue && !seen[vid(r, c)]) return true; // clue outside the closed loop
      }
    }
    return false;
  }

  // True if at most one connected line-component exists.
  _oneClosedComponentOrOpen() {
    const verts = this._loopVertices();
    if (verts.length === 0) return true;
    const { cols } = this;
    const key = (r, c) => r * (cols + 1) + c;
    const seen = new Set();
    const start = verts[0];
    const st = [start]; seen.add(key(start[0], start[1]));
    while (st.length) {
      const [r, c] = st.pop();
      for (const e of this.incidentEdges(r, c)) {
        if (this.getEdge(e) !== 1) continue;
        const [a, b] = this._endpoints(e);
        const nv = (a.r === r && a.c === c) ? b : a;
        if (!seen.has(key(nv.r, nv.c))) { seen.add(key(nv.r, nv.c)); st.push([nv.r, nv.c]); }
      }
    }
    return seen.size === verts.length;
  }

  // A clued vertex's loop SHAPE must match its colour: white = straight
  // (the two line edges collinear), black = turn (one H + one V). Degree-2 and
  // numbersSatisfied do NOT imply this (a white clue can sit on a turn whose two
  // perpendicular runs happen to sum to its number), so the acceptance gate must
  // check it explicitly. Assumes the vertex is degree 2 (callers ensure it).
  _shapesSatisfied() {
    const { rows, cols } = this;
    for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
      const clue = ShingokiSolver.decodeClue(this.task[r][c]);
      if (!clue) continue;
      const lines = this.incidentEdges(r, c).filter(e => this.getEdge(e) === 1);
      if (lines.length !== 2) return false;
      const isTurn = lines.some(e => e.kind === 'H') && lines.some(e => e.kind === 'V');
      if (clue.color === 'white' && isTurn) return false;   // white must go straight
      if (clue.color === 'black' && !isTurn) return false;  // black must turn
    }
    return true;
  }

  _isValidComplete() {
    const { rows, cols } = this;
    let lineVerts = 0;
    for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
      const deg = this.incidentEdges(r, c).filter(e => this.getEdge(e) === 1).length;
      const clue = ShingokiSolver.decodeClue(this.task[r][c]);
      if (deg !== 0 && deg !== 2) return false;
      if (clue && deg !== 2) return false;
      if (deg === 2) lineVerts++;
    }
    if (lineVerts === 0) return false;
    if (!this._oneClosedComponentOrOpen()) return false;
    if (!this._shapesSatisfied()) return false;
    if (!this.numbersSatisfied()) return false;
    return true;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ShingokiSolver };
}
