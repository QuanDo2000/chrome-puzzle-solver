'use strict';

// Shingoki (loop) solver. Single closed loop on a (rows+1)x(cols+1) vertex
// lattice. task[r][c] is a vertex clue: >0 white (loop straight through), <0
// black (loop turns), abs = number = sum (in edges) of the two straight runs
// meeting at the circle, 0 = no circle. Loop state is edge-based:
//   H[r][c] connects vertex (r,c)-(r,c+1), dims (rows+1) x cols
//   V[r][c] connects vertex (r,c)-(r+1,c), dims rows x (cols+1)
// Edge tri-state: 0 unknown, 1 line, 2 cross. Output mirrors Slitherlink's
// { horizontal, vertical } so the widget reuses edge conventions.
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

  _initState() {
    const { rows, cols } = this;
    this.H = Array.from({ length: rows + 1 }, () => new Array(cols).fill(0));
    this.V = Array.from({ length: rows }, () => new Array(cols + 1).fill(0));
  }

  getEdge(ref) {
    return ref.kind === 'H' ? this.H[ref.r][ref.c] : this.V[ref.r][ref.c];
  }

  // Returns false if this contradicts an existing different non-zero value.
  setEdge(ref, val) {
    const cur = this.getEdge(ref);
    if (cur === val) return true;
    if (cur !== 0) return false;
    if (ref.kind === 'H') this.H[ref.r][ref.c] = val; else this.V[ref.r][ref.c] = val;
    return true;
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
        const snapH = this.H.map(row => row.slice());
        const snapV = this.V.map(row => row.slice());
        for (const e of allEdges) if (this.getEdge(e) === 0) this.setEdge(e, 2);
        if (this._isValidComplete()) return this._snapshotGrid();
        this.H = snapH; this.V = snapV;
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
        const snapH = this.H.map(row => row.slice());
        const snapV = this.V.map(row => row.slice());
        if (this.setEdge(edge, val) && this._propagate() && !this._hasPrematureLoop()) {
          const got = backtrack();
          if (got) return got;
        }
        this.H = snapH; this.V = snapV;
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
    if (!this.numbersSatisfied()) return false;
    return true;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ShingokiSolver };
}
