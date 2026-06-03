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
  _deduceHeavy(budgetMs) {
    this._heavyChanged = false;
    if (budgetMs > 0 && timeUp(budgetMs, this._startedAt)) return true; // interactive cap
    if (!this._candidateIntersectForce()) return false;
    if (!this._connectivityForce()) return false;
    if (!this._bifurcationDisabled && !this._bifurcateForce()) return false;
    return true;
  }

  // Tier-2 bounded bifurcation (1-ply lookahead using the FULL sound deduction).
  // For each unknown FRONTIER edge (incident to a committed line, to bound cost),
  // probe LINE then CROSS on a CLONE running `_deduceAllNoBif` (the full
  // no-bifurcation deduction). If one value PROVABLY has no completion (the
  // sound deduction reaches a contradiction), force the other. Sound because a
  // contradiction from a sound deduction proves the probed value is impossible.
  // Returns false on contradiction; sets `this._heavyChanged` if it forced an
  // edge. Probe clones carry `_bifurcationDisabled` (belt-and-suspenders) and use
  // `_deduceAllNoBif`, so there is no nested bifurcation/unbounded recursion.
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
        p._trail = []; // probe runs connectivity/candidate rules that setEdge+_rollbackTo;
                       // without a trail _rollbackTo no-ops and corrupts the probe board.
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
    const { rows, cols } = this;
    // An off-board edge ref simply does not exist (it is an implicit board wall,
    // never LINE). Skipping it from the cross-set only weakens this candidate's
    // forcing — it never under-approximates the candidate SET — so it is sound.
    const inBoard = (e) => e.kind === 'H'
      ? (e.r >= 0 && e.r <= rows && e.c >= 0 && e.c < cols)
      : (e.r >= 0 && e.r < rows && e.c >= 0 && e.c <= cols);
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
    for (const e of perpCrossAtCentre) if (inBoard(e) && !addCross(e)) return null;
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

  // Technique 3: 1-ply structural connectivity forcing (Tier 2). For each unknown
  // edge, probe LINE — if setting it LINE immediately creates a premature closed
  // loop (_hasPrematureLoop) or a connectivity-dead state (_deadByConnectivity),
  // it cannot be LINE -> force CROSS. Symmetrically probe CROSS — if setting it
  // CROSS strands a clued vertex (_deadByConnectivity), force LINE. Both probes
  // restore state exactly (setEdge then _rollbackTo). Soundness reduces to the
  // trusted checkers + correct rollback; the oracle confirms. Returns false on a
  // contradiction (an edge whose both values are dead).
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

  // Joint Tier1+Tier2 fixpoint. Runs _propagate to fixpoint, then one
  // _deduceHeavy pass; repeats while the heavy pass changed anything. Returns
  // false on any contradiction. `budgetMs` (0 = unbounded) bounds the heavy
  // passes for interactive callers; Tier 1 always runs fully (it is cheap).
  _deduceAll(budgetMs) {
    for (;;) {
      if (!this._propagate()) return false;
      if (!this._maxReachForce()) return false;
      if (this._maxReachChanged) continue;     // forced edges -> re-propagate
      if (!this._deduceHeavy(budgetMs)) return false;
      if (!this._heavyChanged) return true;
    }
  }

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
  // Sets edges via setEdge (trail-tracked). Re-runs cheap; called from _deduceAll.
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
    this._maxReachChanged = changed; // Tier-1 re-settle flag (read by _deduceAll)
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
