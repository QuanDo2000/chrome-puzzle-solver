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
const { timeUp } = require('./shared.js');

class ShingokiSolver {
  static decodeClue(v) {
    if (!v) return null;
    return v > 0 ? { color: 'white', n: v } : { color: 'black', n: -v };
  }

  constructor({ rows, cols, task, maxMs = 0 }) {
    this.rows = rows;
    this.cols = cols;
    this.task = task;
    this.maxMs = maxMs;
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

  _initState() {
    const { rows, cols } = this;
    this.H = Array.from({ length: rows + 1 }, () => new Array(cols).fill(0));
    this.V = Array.from({ length: rows }, () => new Array(cols + 1).fill(0));
    this._trail = [];
  }

  // Initialize CDCL bookkeeping (separate from _initState's edge arrays).
  _cdclInit() {
    this._initState();              // builds H/V + _trail
    const n = this._numVars();
    this._reason = new Array(n).fill(undefined); // undefined=unassigned, null=decision, array=antecedents
    const lv = new Int32Array(n); lv.fill(-1); this._level = lv;
    this._assignTrail = [];         // var IDs in assignment order (for backjump)
    this._decisionLevel = 0;
    this._currentReason = null;     // set by rules before each forced setEdge
    this._lastConflictReason = null;
    this._learnedClauses = [];      // each: array of literals (~lit convention)
    this._totalConflicts = 0;
    this._cdcl = true;
  }

  // Truth value of a variable under the current edge assignment:
  //  1 = LINE (positive), -1 = CROSS (negative), 0 = unassigned.
  _varValue(vid) {
    const d = this._decodeVar(vid);
    const v = d.kind === 'H' ? this.H[d.r][d.c] : this.V[d.r][d.c];
    return v === 0 ? 0 : v === 1 ? 1 : -1;
  }

  // Sets the edge corresponding to a literal under the ~lit convention:
  //   lit >= 0 -> var is positive (LINE);  lit < 0 -> var is negative (CROSS).
  //   varId = lit >= 0 ? lit : ~lit.  NEVER Math.abs/-lit (var 0 is real).
  // Returns false on contradiction (same contract as setEdge).
  _forceLiteral(lit) {
    const vid = lit >= 0 ? lit : ~lit;
    const d = this._decodeVar(vid);
    return this.setEdge({ kind: d.kind, r: d.r, c: d.c }, lit >= 0 ? 1 : 2);
  }

  _addLearnedClause(literals) {
    this._learnedClauses.push(literals.slice());
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
    if (this._cdcl) {
      const vid = this._varId(ref.kind, ref.r, ref.c);
      this._reason[vid] = this._currentReason; // null for a decision, array for a force
      this._level[vid] = this._decisionLevel;
      this._assignTrail.push(vid);
    }
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
      if (this._cdcl) {
        const vid = this._varId(kind, r, c);
        this._reason[vid] = undefined;
        this._level[vid] = -1;
        if (this._assignTrail.length && this._assignTrail[this._assignTrail.length - 1] === vid) {
          this._assignTrail.pop();
        }
      }
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

    // Captures the incident-edge set of the vertex whose rule is currently
    // forcing edges, so trySet/conflictReason can derive a local antecedent set.
    let curInc = null;

    const trySet = (ref, val, reasonOverride) => {
      if (this._cdcl) {
        // Most rules here are LOCAL to (r,c): sound local reason = the
        // determined incident edges of the CURRENT vertex, excluding the edge
        // being set (clue is a fixed fact -> omitted). The NON-LOCAL run-cap
        // rule walks a straight run beyond (r,c)'s incident edges, so it passes
        // an explicit reasonOverride spanning the full run (the true
        // antecedents); using the local set there would under-approximate and
        // yield an unsound learned clause.
        if (reasonOverride) {
          this._currentReason = reasonOverride;
        } else {
          const reason = [];
          for (const e of curInc) {
            if (e.kind === ref.kind && e.r === ref.r && e.c === ref.c) continue; // skip target
            if (this.getEdge(e) !== 0) reason.push(this._varId(e.kind, e.r, e.c));
          }
          this._currentReason = reason;
        }
      }
      const before = this.getEdge(ref);
      if (!this.setEdge(ref, val)) return false;
      if (this.getEdge(ref) !== before) for (const v of this._endpoints(ref)) { seen.delete(v.r*(cols+2)+v.c); enq(v.r, v.c); }
      return true;
    };

    while (queue.length) {
      const [r, c] = queue.pop();
      seen.delete(r * (cols + 2) + c);
      const inc = this.incidentEdges(r, c);
      curInc = inc;
      // Determined incident edges of the current vertex, as a conflict reason.
      const conflictReason = () => {
        const rs = [];
        for (const e of inc) if (this.getEdge(e) !== 0) rs.push(this._varId(e.kind, e.r, e.c));
        return rs;
      };
      let lines = 0, crosses = 0;
      for (const e of inc) { const v = this.getEdge(e); if (v === 1) lines++; else if (v === 2) crosses++; }
      const unknown = inc.length - lines - crosses;
      const clue = ShingokiSolver.decodeClue(this.task[r][c]);

      // Degree rule: a vertex is degree 0 or 2.
      if (lines > 2) { if (this._cdcl) this._lastConflictReason = conflictReason(); return false; }
      if (lines === 2) { for (const e of inc) if (this.getEdge(e) === 0) if (!trySet(e, 2)) { if (this._cdcl) this._lastConflictReason = conflictReason(); return false; } }
      // If only 2 edges can still be lines and a 2 is required, force them.
      if (lines === 1 && unknown === 1) {
        // degree must reach 2: the one unknown becomes a line.
        for (const e of inc) if (this.getEdge(e) === 0) if (!trySet(e, 1)) { if (this._cdcl) this._lastConflictReason = conflictReason(); return false; }
      }
      // No vertex (clued or empty) may end at degree exactly 1.
      if (lines === 1 && unknown === 0) { if (this._cdcl) this._lastConflictReason = conflictReason(); return false; }
      // Circled vertex must be degree 2 (cannot be 0).
      if (clue) {
        if (lines + unknown < 2) { if (this._cdcl) this._lastConflictReason = conflictReason(); return false; } // can't reach degree 2
        if (lines === 0 && unknown === 2) { for (const e of inc) if (this.getEdge(e) === 0) if (!trySet(e, 1)) { if (this._cdcl) this._lastConflictReason = conflictReason(); return false; } }
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
          if (!hViable && !vViable) { if (this._cdcl) this._lastConflictReason = conflictReason(); return false; }
          if (hViable && !vViable) {
            for (const e of hEdges) if (this.getEdge(e) === 0 && !trySet(e, 1)) { if (this._cdcl) this._lastConflictReason = conflictReason(); return false; }
            for (const e of vEdges) if (this.getEdge(e) === 0 && !trySet(e, 2)) { if (this._cdcl) this._lastConflictReason = conflictReason(); return false; }
          } else if (vViable && !hViable) {
            for (const e of vEdges) if (this.getEdge(e) === 0 && !trySet(e, 1)) { if (this._cdcl) this._lastConflictReason = conflictReason(); return false; }
            for (const e of hEdges) if (this.getEdge(e) === 0 && !trySet(e, 2)) { if (this._cdcl) this._lastConflictReason = conflictReason(); return false; }
          }
        } else {
          // Black needs one horizontal + one vertical line. If only one edge of
          // an axis is available (in-range, not crossed), it must be that arm.
          for (const axis of ['H', 'V']) {
            const avail = this._axisEdges(r, c, axis).filter(e => this.getEdge(e) !== 2);
            if (avail.length === 1 && this.getEdge(avail[0]) === 0) {
              if (!trySet(avail[0], 1)) { if (this._cdcl) this._lastConflictReason = conflictReason(); return false; }
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
              if (e.kind === straightKind) { if (this.getEdge(e) === 0 && !trySet(e, 1)) { if (this._cdcl) this._lastConflictReason = conflictReason(); return false; } }
              else { if (this.getEdge(e) === 0 && !trySet(e, 2)) { if (this._cdcl) this._lastConflictReason = conflictReason(); return false; } }
            }
          }
        } else {
          // black: turn -> the two loop edges are perpendicular (one H, one V).
          if (lineRefs.length >= 1) {
            const sameKind = isH(lineRefs[0]) ? 'H' : 'V';
            // the collinear partner of the known line must be cross.
            for (const e of inc) if (e.kind === sameKind && this.getEdge(e) === 0) if (!trySet(e, 2)) { if (this._cdcl) this._lastConflictReason = conflictReason(); return false; }
          }
        }
        // Run-cap is NON-LOCAL: it owns its conflict reason (the full run, which
        // extends beyond (r,c)'s incident edges) via _lastConflictReason, set
        // inside _applyRunCap. Do NOT recompute the local conflictReason() here
        // or it would clobber the sound run-spanning reason with an
        // under-approximation.
        if (!this._applyRunCap(r, c, clue, trySet)) return false;
      }
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
    const runEdges = [];
    if (horiz) {
      const a = walk(0, -1), b = walk(0, 1);
      total += a.len + b.len; ends.push(a.endRef, b.endRef);
      runEdges.push(...a.edges, ...b.edges);
    }
    if (vert) {
      const a = walk(-1, 0), b = walk(1, 0);
      total += a.len + b.len; ends.push(a.endRef, b.endRef);
      runEdges.push(...a.edges, ...b.edges);
    }
    // Run-cap is a NON-LOCAL rule: the antecedents of every force/conflict it
    // produces are the CONFIRMED edges of the whole run (which extend beyond
    // (r,c)'s incident edges), not just the clue vertex's local edges. Recording
    // only the local edges would under-approximate the reason and make the
    // learned clause unsound (the omitted far run edges are necessary to entail
    // the force). So build the run-spanning reason here and pass it explicitly.
    const runReason = this._cdcl
      ? runEdges.map(e => this._varId(e.kind, e.r, e.c))
      : null;
    if (total > clue.n) {
      if (this._cdcl) this._lastConflictReason = runReason;
      return false;
    }
    if (total === clue.n) {
      for (const ref of ends) {
        // Pass runReason as an explicit override so trySet records the full run
        // (not its local recompute). The target end edge is unknown (==0) so it
        // is never itself in runReason; no self-reference to strip.
        if (ref && this.getEdge(ref) === 0 && !trySet(ref, 2, runReason)) {
          if (this._cdcl) this._lastConflictReason = runReason;
          return false;
        }
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

  solve() {
    this._startedAt = Date.now();
    this._initState();
    if (!this._propagate()) return { solved: false, horizontal: null, vertical: null, error: 'contradiction on initial propagation' };

    const allEdges = this._allEdgeRefs();
    const backtrack = () => {
      if (this.maxMs > 0 && timeUp(this.maxMs, this._startedAt)) return null;
      // find an unknown edge; prefer one incident to a vertex that already has a line.
      let pick = null, fallback = null;
      for (const e of allEdges) {
        if (this.getEdge(e) !== 0) continue;
        if (!fallback) fallback = e;
        const eps = this._endpoints(e);
        if (eps.some(v => this.incidentEdges(v.r, v.c).some(x => this.getEdge(x) === 1))) { pick = e; break; }
      }
      // Loop-closure short-circuit: if the partial assignment already forms a
      // single closed loop through every clued vertex with no dangling
      // (degree-1) endpoint, the loop is complete. Any remaining unknown edge
      // must be a cross (a line would make a degree-3 vertex or a 2nd loop).
      if (this._loopComplete()) {
        const mark = this._trailMark();
        for (const e of allEdges) if (this.getEdge(e) === 0) this.setEdge(e, 2);
        if (this._isValidComplete()) return this._snapshotGrid();
        this._rollbackTo(mark);
        return null;
      }
      const edge = pick || fallback;
      if (!edge) {
        return this._isValidComplete() ? this._snapshotGrid() : null;
      }
      // Cross before line: an under-constrained Shingoki board is mostly crosses
      // (the loop covers only a fraction of vertices), so trying cross first
      // collapses the empty field immediately and lets the loop-closure
      // short-circuit fire, instead of greedily extending spurious line chains
      // across the empty field before ever closing the loop.
      for (const val of [2, 1]) {
        const mark = this._trailMark();
        if (this.setEdge(edge, val) && this._propagate() && !this._hasPrematureLoop() && !this._deadByConnectivity()) {
          const got = backtrack();
          if (got) return got;
        }
        this._rollbackTo(mark);
      }
      return null;
    };

    const grid = backtrack();
    if (!grid) {
      return { solved: false, horizontal: null, vertical: null,
        error: this.maxMs > 0 && timeUp(this.maxMs, this._startedAt) ? 'time limit exceeded' : 'no solution' };
    }
    return { solved: true, horizontal: grid.horizontal, vertical: grid.vertical };
  }

  // CDCL path entry (correct-but-slow skeleton, NO clause learning). Separate
  // from solve(); proves the var/trail/reason/level machinery is SOUND before
  // learning is added. A later task makes solve() delegate here.
  _solveCdcl() {
    this._startedAt = Date.now();
    this._cdclInit();
    if (!this._propagate()) {
      return { solved: false, horizontal: null, vertical: null, error: 'contradiction on initial propagation' };
    }
    const ok = this._cdclSearch();
    if (ok) {
      return { solved: true, horizontal: this.H.map(r => r.slice()), vertical: this.V.map(r => r.slice()) };
    }
    if (this.maxMs > 0 && timeUp(this.maxMs, this._startedAt)) {
      return { solved: false, horizontal: null, vertical: null, error: 'time limit exceeded' };
    }
    return { solved: false, horizontal: null, vertical: null, error: 'no solution' };
  }

  // Decision level at which `vid` was assigned (0 if unassigned/root).
  _decisionLevelOf(vid) {
    const lv = this._level[vid];
    return lv < 0 ? 0 : lv;
  }

  // First-UIP conflict analysis (CDCL §4), ported from SlitherlinkSolver and
  // adapted to Shingoki's var-keyed reason/level bookkeeping (edge-only vars).
  //
  // Slitherlink keys `_reasons[]`/`_decisionLevels[]` by TRAIL INDEX and stores
  // literals; Shingoki keys `_reason[vid]`/`_level[vid]` by VAR ID and stores
  // antecedent VAR IDs (Task 3). So here:
  //   - `_decisionLevelOf(vid)` reads `_level[vid]` directly (no _trailIndexOf).
  //   - the reason of a seen var is `_reason[vid]` directly.
  //   - the trail walk iterates `_assignTrail` (var ids in assignment order).
  // The learned clause is an array of literals; each literal NEGATES the seen
  // var's current assignment: LINE (value 1) -> `~v`, CROSS (value -1) -> `v`,
  // so the clause excludes the current (bad) assignment but is implied true.
  //
  // Textbook first-UIP (no subsumption pre-pass). Shingoki's CDCL search does
  // NOT run lookahead, so every reason (`_reason[vid]`) is a well-formed,
  // SUFFICIENT antecedent set for its forced var (sound local reason from
  // _propagate; the non-local run-cap rule records its full run as the reason).
  // Slitherlink's subsumption pre-pass + rescue path exist to cope with
  // lookahead "ghost" vars in its conflict reasons; importing them here is
  // unsound because subsumption can drop a needed current-level antecedent
  // (e.g. a var X that is BOTH in another conflict var's reason and the sole
  // bridge to a separate current-level fact), yielding a too-short unit clause
  // that wrongly asserts a decision's negation -> spurious UNSAT. Plain first-
  // UIP resolves every current-level var down to ONE asserting literal and
  // keeps all earlier-level literals, which is exactly what we need.
  _analyzeConflict(conflictReason) {
    const n = this._numVars();
    const learned = [];
    const seen = new Uint8Array(n);
    let pathCount = 0;
    const curLevel = this._decisionLevel;

    // Seed pathCount (current-level vars) + earlier-level literals.
    for (const vid of conflictReason) {
      if (vid < 0 || vid >= n || seen[vid]) continue;
      const value = this._varValue(vid);
      if (value === 0) continue;
      seen[vid] = 1;
      const lvl = this._decisionLevelOf(vid);
      if (lvl === 0) continue;
      if (lvl < curLevel) learned.push(value > 0 ? ~vid : vid);
      else pathCount++;
    }

    // Walk the assignment trail backward, resolving current-level vars by their
    // antecedents until exactly one current-level var remains (the first UIP).
    for (let i = this._assignTrail.length - 1; pathCount > 0 && i >= 0; i--) {
      const vid = this._assignTrail[i];
      if (!seen[vid] || this._level[vid] !== curLevel) continue;

      pathCount--;
      const reason = this._reason[vid];

      if (pathCount === 0 || reason === null) {
        // vid is the first UIP — assert its negation.
        const value = this._varValue(vid);
        learned.push(value > 0 ? ~vid : vid);
        break;
      }

      // Resolve vid: replace it with its antecedents.
      for (const av of reason) {
        if (av < 0 || av >= n || seen[av]) continue;
        seen[av] = 1;
        const aLvl = this._decisionLevelOf(av);
        if (aLvl === 0) continue;
        const aVal = this._varValue(av);
        if (aVal === 0) continue;
        if (aLvl < curLevel) learned.push(aVal > 0 ? ~av : av);
        else pathCount++;
      }
    }

    return learned;
  }

  // Second-highest decision level among the learned clause's literals — the
  // level the clause becomes unit at after rollback. 0 if only one level.
  _computeBackjumpLevel(learned) {
    let max = 0, second = 0;
    for (const lit of learned) {
      const vid = lit >= 0 ? lit : ~lit;
      const lvl = this._decisionLevelOf(vid);
      if (lvl > max) { second = max; max = lvl; }
      else if (lvl > second && lvl < max) second = lvl;
    }
    return second;
  }

  // Rolls the assignment trail back to `level` (all surviving entries have
  // _level <= level), then sets _decisionLevel = level. Uses the edge trail's
  // existing rollback by computing the trail mark of the first edge-write whose
  // var sits above `level`. The edge trail and _assignTrail advance in lockstep
  // (setEdge pushes both), so the count of above-level _assignTrail vars equals
  // the count of edge-writes to undo from the trail tail.
  _backjumpTo(level) {
    let above = 0;
    for (let i = this._assignTrail.length - 1; i >= 0; i--) {
      if (this._level[this._assignTrail[i]] > level) above++; else break;
    }
    // Each setEdge that changed an edge pushed 4 ints onto _trail. Undo `above`
    // of those by rolling back to the matching mark.
    const mark = this._trail.length - above * 4;
    this._rollbackTo(mark < 0 ? 0 : mark);
    this._decisionLevel = level;
  }

  // Learned-clause unit propagation. A learned clause is a valid implied
  // constraint, so unit-forcing from it is sound. Scans every learned clause:
  //   - satisfied (some literal true)            -> skip
  //   - all literals false                       -> conflict, return false
  //   - exactly one literal unassigned (unit)    -> force it (reason = the other
  //                                                 literals' vars), record change
  // `onChange()` is called for each force so the caller re-runs the rule
  // fixpoint. Sets _lastConflictReason on conflict (the clause's vars).
  _propagateLearned(onChange) {
    for (const clause of this._learnedClauses) {
      let unassignedCount = 0, unassignedLit = 0, satisfied = false;
      for (const lit of clause) {
        const vid = lit >= 0 ? lit : ~lit;
        const v = this._varValue(vid);
        if (v === 0) { unassignedCount++; unassignedLit = lit; }
        else if ((v > 0) === (lit >= 0)) { satisfied = true; break; }
      }
      if (satisfied) continue;
      if (unassignedCount === 0) {
        this._lastConflictReason = clause.map(l => (l >= 0 ? l : ~l));
        return false;
      }
      if (unassignedCount === 1) {
        this._currentReason = clause
          .filter(l => l !== unassignedLit)
          .map(l => (l >= 0 ? l : ~l));
        if (!this._forceLiteral(unassignedLit)) {
          this._lastConflictReason = clause.map(l => (l >= 0 ? l : ~l));
          return false;
        }
        onChange();
      }
    }
    return true;
  }

  // Full propagation to a joint fixpoint of the deduction rules (_propagate)
  // AND learned-clause unit propagation. Alternates the two until neither
  // changes (or one signals a conflict). Returns false on contradiction.
  _propagateAll() {
    for (;;) {
      if (!this._propagate()) return false;
      if (this._learnedClauses.length === 0) return true;
      let changed = false;
      if (!this._propagateLearned(() => { changed = true; })) return false;
      if (!changed) return true;
      // a learned clause forced an edge -> re-run the rules.
    }
  }

  // Learning CDCL search (replaces _cdclSkeletonSearch): decide CROSS-first,
  // propagate (rules + learned clauses), and on conflict run first-UIP analysis
  // to learn a clause, then non-chronologically backjump and add it. Decisions
  // use _firstUnassignedEdge (VSIDS is a later task); no restarts yet.
  //
  // Conflict sources beyond rule-propagation failure: a complete-but-invalid
  // leaf, a premature closed sub-loop, or a connectivity-dead partial. None of
  // these produce a tight var-reason from _propagate, so they BLAME THE CURRENT-
  // LEVEL DECISION: the learned clause becomes ~decision (chronological-ish, but
  // routed through the clause/backjump mechanism so it still prunes soundly).
  _cdclSearch() {
    for (;;) {
      if (this.maxMs > 0 && timeUp(this.maxMs, this._startedAt)) return false;

      // Propagate (rules + learned clauses) and check the structural prunes.
      let conflict = false;
      if (!this._propagateAll()) {
        conflict = true; // _lastConflictReason already set by the failing pass
      } else if (this._hasPrematureLoop() || this._deadByConnectivity()) {
        conflict = true;
        this._lastConflictReason = this._currentLevelDecisionReason();
      } else {
        const ref = this._firstUnassignedEdge();
        if (ref === null) {
          if (this._isValidComplete()) return true; // solved
          // complete-but-invalid leaf: blame the current decision.
          conflict = true;
          this._lastConflictReason = this._currentLevelDecisionReason();
        } else {
          // decide: CROSS(2) first (matches solve()'s [2,1] order).
          this._decisionLevel++;
          this._currentReason = null; // decision => null reason
          this.setEdge(ref, 2);
          continue;
        }
      }

      if (conflict) {
        this._totalConflicts++;
        if (this._decisionLevel === 0) return false; // UNSAT at root

        const conflictReason = this._lastConflictReason || [];
        const learned = this._analyzeConflict(conflictReason);
        const backjumpLevel = this._computeBackjumpLevel(learned);
        this._backjumpTo(backjumpLevel);
        if (learned.length > 0) this._addLearnedClause(learned);
        // After backjump the learned clause is unit (or empty -> level 0); the
        // next loop's _propagateAll picks it up and forces the asserting literal.
        if (learned.length === 0) {
          // No antecedents (e.g. a connectivity conflict that blamed a decision
          // already at level 0 after the walk). Defensive: cannot make progress.
          return false;
        }
      }
    }
  }

  // Conflict reason for a STRUCTURAL conflict (connectivity-dead / premature
  // loop / complete-but-invalid leaf). Unlike a rule conflict, these have no
  // tight var-antecedent — the invalidity depends on the WHOLE decision path,
  // not a single edge. So the reason is the conjunction of ALL current decisions
  // (the decision var at each level 1.._decisionLevel). _analyzeConflict then
  // learns ~d1 v ~d2 v ... v ~dk; its second-highest level is k-1, so the
  // backjump pops one level and the clause forces ~d_k — i.e. it flips the
  // deepest decision (chronological-backtrack semantics) but routed through the
  // sound learned-clause/backjump mechanism. Using only the deepest decision
  // here would be UNSOUND: asserting ~d_k at root discards d1..d_{k-1}, which
  // were not refuted, and can prune the real solution -> spurious UNSAT.
  _currentLevelDecisionReason() {
    const out = [];
    const seenLevel = new Set();
    for (let i = this._assignTrail.length - 1; i >= 0; i--) {
      const v = this._assignTrail[i];
      const lv = this._level[v];
      if (lv >= 1 && this._reason[v] === null && !seenLevel.has(lv)) {
        seenLevel.add(lv);
        out.push(v);
      }
    }
    return out;
  }

  _firstUnassignedEdge() {
    for (const e of this._allEdgeRefs()) if (this.getEdge(e) === 0) return e;
    return null;
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
    if (!this._propagate()) return null; // contradictory board state; let caller fall back
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

  _snapshotGrid() {
    return { horizontal: this.H.map(r => r.slice()), vertical: this.V.map(r => r.slice()) };
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

  // True iff the current partial assignment is already a single closed loop
  // covering every clued vertex: at least one line edge exists, no vertex is
  // degree 1, every clued vertex is degree 2, and all line edges form one
  // connected component. When true, all remaining unknown edges must be crosses.
  _loopComplete() {
    const { rows, cols } = this;
    let lineEdges = 0;
    for (let r = 0; r <= rows; r++) {
      for (let c = 0; c < cols; c++) if (this.H[r][c] === 1) lineEdges++;
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c <= cols; c++) if (this.V[r][c] === 1) lineEdges++;
    }
    if (lineEdges === 0) return false;
    for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
      const deg = this.incidentEdges(r, c).filter(e => this.getEdge(e) === 1).length;
      if (deg === 1) return false;
      const clue = ShingokiSolver.decodeClue(this.task[r][c]);
      if (clue && deg !== 2) return false;
    }
    return this._oneClosedComponentOrOpen();
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
