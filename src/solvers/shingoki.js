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
    // Walk a direction counting CONFIRMED line edges; return {len, endRef} where
    // endRef is the next edge beyond the run (or null if border).
    const walk = (dr, dc) => {
      let len = 0, cr = r, cc = c, endRef = null;
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
        len++; cr = nr; cc = nc;
      }
      return { len, endRef };
    };
    const horiz = inc.some(e => e.kind === 'H');
    const vert = inc.some(e => e.kind === 'V');
    let total = 0;
    const ends = [];
    if (horiz) { const a = walk(0, -1), b = walk(0, 1); total += a.len + b.len; ends.push(a.endRef, b.endRef); }
    if (vert)  { const a = walk(-1, 0), b = walk(1, 0); total += a.len + b.len; ends.push(a.endRef, b.endRef); }
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
