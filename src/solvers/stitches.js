'use strict';

// StitchesSolver — pure logic, no DOM.
//
// PAGE ENCODING (recon, ground truth; getErrors is a no-op stub so this ruleset IS the spec):
//   areas[r][c] = jigsaw region id. task[0..W-1] = column hole-counts, task[W..W+H-1] = row
//   hole-counts. Solution = stitches: cellHorizontalStatus[r][c]=1 joins (r,c)-(r,c+1),
//   cellVerticalStatus[r][c]=1 joins (r,c)-(r+1,c). serializeSolution = H grid then V grid.
//
// MODEL: a stitch is an edge between two orthogonally-adjacent cells in DIFFERENT regions.
//   1) each adjacent region-pair joined by exactly K stitches
//   2) each cell is an endpoint of at most one stitch (degree <= 1)
//   3) row r endpoint-count == rowClue[r]; col c endpoint-count == colClue[c]
// METHOD: candidate-edge CSP — region-pair + cell-degree + line-count propagation to a
// fixpoint, then backtracking on the tightest region-pair's undecided edge. Sound partial =
// root snapshot on timeout. No page oracle -> brute-force-gated in tests/stitches.test.js.
//
// OUTPUT cells: { horizontal, vertical } two rows x cols 0/1 grids (1 = stitch). horizontal[r][c]
//   meaningful for c<cols-1; vertical[r][c] for r<rows-1.

class StitchesSolver {
  constructor({ rows, cols, areas, colClue, rowClue, stitches, maxMs = 30000 }) {
    this.rows = rows; this.cols = cols; this.areas = areas;
    this.colClue = colClue; this.rowClue = rowClue; this.K = stitches; this.maxMs = maxMs;
    // candidate edges: cross-region orthogonal borders
    this.edges = [];            // { cells:[cidA,cidB], pair, type:'h'|'v', r, c }
    this.cellEdges = Array.from({ length: rows * cols }, () => []); // cell -> incident edge ids
    this.pairEdges = new Map(); // "min-max" region pair -> edge ids
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      if (c + 1 < cols && areas[r][c] !== areas[r][c + 1]) this._addEdge(r, c, r, c + 1, 'h', r, c);
      if (r + 1 < rows && areas[r][c] !== areas[r + 1][c]) this._addEdge(r, c, r + 1, c, 'v', r, c);
    }
  }

  _addEdge(r1, c1, r2, c2, type, er, ec) {
    const W = this.cols, a = this.areas[r1][c1], b = this.areas[r2][c2];
    const id = this.edges.length, key = Math.min(a, b) + '-' + Math.max(a, b);
    this.edges.push({ cells: [r1 * W + c1, r2 * W + c2], pair: key, type, r: er, c: ec });
    this.cellEdges[r1 * W + c1].push(id); this.cellEdges[r2 * W + c2].push(id);
    if (!this.pairEdges.has(key)) this.pairEdges.set(key, []);
    this.pairEdges.get(key).push(id);
  }

  _initState() {
    this.st = new Int8Array(this.edges.length).fill(-1); // -1 unknown, 0 rejected, 1 selected
    this._dirty = false;
  }

  _set(id, val) { // false on conflict
    if (this.st[id] === val) return true;
    if (this.st[id] !== -1) return false;
    this.st[id] = val; this._dirty = true; return true;
  }

  // region-pair exactly-K + cell-degree<=1 + row/col line-count, to a fixpoint.
  _propagate() {
    const { rows, cols, K } = this;
    this._dirty = true;
    while (this._dirty) {
      this._dirty = false;
      // 1) region pairs
      for (const [, ids] of this.pairEdges) {
        let s = 0, u = 0; for (const id of ids) { if (this.st[id] === 1) s++; else if (this.st[id] === -1) u++; }
        if (s > K || s + u < K) return false;
        if (s === K && u) { for (const id of ids) if (this.st[id] === -1 && !this._set(id, 0)) return false; }
        else if (s + u === K && u) { for (const id of ids) if (this.st[id] === -1 && !this._set(id, 1)) return false; }
      }
      // 2) cell degree <= 1
      for (let cid = 0; cid < rows * cols; cid++) {
        const inc = this.cellEdges[cid]; if (!inc.length) continue;
        let s = 0; for (const id of inc) if (this.st[id] === 1) s++;
        if (s > 1) return false;
        if (s === 1) { for (const id of inc) if (this.st[id] === -1 && !this._set(id, 0)) return false; }
      }
      // 3) row/col endpoint counts
      const rowKnown = new Int32Array(rows), rowPoss = new Int32Array(rows);
      const colKnown = new Int32Array(cols), colPoss = new Int32Array(cols);
      const cellPoss = new Uint8Array(rows * cols);
      for (let cid = 0; cid < rows * cols; cid++) {
        const inc = this.cellEdges[cid]; if (!inc.length) continue;
        let s = 0, u = 0; for (const id of inc) { if (this.st[id] === 1) s++; else if (this.st[id] === -1) u++; }
        if (s === 1) { rowKnown[Math.floor(cid / cols)]++; colKnown[cid % cols]++; }
        else if (u > 0) { cellPoss[cid] = 1; rowPoss[Math.floor(cid / cols)]++; colPoss[cid % cols]++; }
      }
      for (let r = 0; r < rows; r++) {
        if (rowKnown[r] > this.rowClue[r] || rowKnown[r] + rowPoss[r] < this.rowClue[r]) return false;
        if (rowKnown[r] === this.rowClue[r] && rowPoss[r]) for (let c = 0; c < cols; c++) { const cid = r * cols + c; if (cellPoss[cid]) for (const id of this.cellEdges[cid]) if (this.st[id] === -1 && !this._set(id, 0)) return false; }
      }
      for (let c = 0; c < cols; c++) {
        if (colKnown[c] > this.colClue[c] || colKnown[c] + colPoss[c] < this.colClue[c]) return false;
        if (colKnown[c] === this.colClue[c] && colPoss[c]) for (let r = 0; r < rows; r++) { const cid = r * cols + c; if (cellPoss[cid]) for (const id of this.cellEdges[cid]) if (this.st[id] === -1 && !this._set(id, 0)) return false; }
      }
    }
    return true;
  }

  // Full-board validity oracle (the decoded ruleset). horizontal/vertical: rows x cols 0/1.
  _isValid(sol) {
    const { rows, cols, K, colClue, rowClue } = this;
    const H = sol.horizontal || [], V = sol.vertical || [];
    // map selected edges back to which candidate ids they are + tally
    const pc = new Map(); for (const k of this.pairEdges.keys()) pc.set(k, 0);
    const deg = new Int32Array(rows * cols);
    for (const e of this.edges) {
      const on = e.type === 'h' ? (H[e.r] && H[e.r][e.c] === 1) : (V[e.r] && V[e.r][e.c] === 1);
      if (on) { pc.set(e.pair, pc.get(e.pair) + 1); deg[e.cells[0]]++; deg[e.cells[1]]++; }
    }
    for (const [, v] of pc) if (v !== K) return false;
    for (let i = 0; i < deg.length; i++) if (deg[i] > 1) return false;
    const rc = new Int32Array(rows), cc = new Int32Array(cols);
    for (let i = 0; i < deg.length; i++) if (deg[i] === 1) { rc[Math.floor(i / cols)]++; cc[i % cols]++; }
    for (let r = 0; r < rows; r++) if (rc[r] !== rowClue[r]) return false;
    for (let c = 0; c < cols; c++) if (cc[c] !== colClue[c]) return false;
    return true;
  }

  _snapshot() { return this.st.slice(); }
  _restore(s) { this.st = s; }

  // tightest region-pair still needing stitches -> its first undecided edge
  _pick() {
    let best = -1, bestU = Infinity;
    for (const [, ids] of this.pairEdges) {
      let s = 0, u = 0; for (const id of ids) { if (this.st[id] === 1) s++; else if (this.st[id] === -1) u++; }
      if (s < this.K && u && u < bestU) { bestU = u; best = ids.find((id) => this.st[id] === -1); }
    }
    return best;
  }

  _toGrids() {
    const H = Array.from({ length: this.rows }, () => new Array(this.cols).fill(0));
    const V = Array.from({ length: this.rows }, () => new Array(this.cols).fill(0));
    for (let i = 0; i < this.edges.length; i++) if (this.st[i] === 1) { const e = this.edges[i]; if (e.type === 'h') H[e.r][e.c] = 1; else V[e.r][e.c] = 1; }
    return { horizontal: H, vertical: V };
  }

  _search(countAll) {
    if (Date.now() > this._deadline) { this._timedOut = true; return true; }
    const e = this._pick();
    if (e === -1) {
      const g = this._toGrids();
      if (this._isValid(g)) { this._count++; if (!this._first) this._first = g; if (!countAll) return true; if (this._count >= 2) return true; }
      return false;
    }
    for (const val of [1, 0]) {
      const snap = this._snapshot();
      if (this._set(e, val) && this._propagate()) { if (this._search(countAll)) { if (!countAll || this._count >= 2 || this._timedOut) return true; } }
      this._restore(snap);
    }
    return false;
  }

  solve(countAll = false) {
    this._initState();
    this._deadline = Date.now() + this.maxMs; this._timedOut = false; this._count = 0; this._first = null;
    // infeasible if any adjacent pair has fewer than K candidate edges
    for (const [, ids] of this.pairEdges) if (ids.length < this.K) return { solved: false, error: 'No solution (a region pair has < K borders)' };
    if (!this._propagate()) return { solved: false, error: 'No solution (contradiction in givens)' };
    const root = this._toGrids();
    this._search(countAll);
    if (this._first) return { solved: true, horizontal: this._first.horizontal, vertical: this._first.vertical, count: this._count };
    if (this._timedOut) return { solved: false, partial: true, horizontal: root.horizontal, vertical: root.vertical };
    return { solved: false, error: 'No solution found' };
  }

  // Hint engine: seed from the live board (h/v tri-state 1=stitch, 2=blocked-X, 0=unknown),
  // propagate, and return newly-forced STITCH edges as { type:'horizontal'|'vertical', r, c, value:1 }.
  // Returns [] if the live board is contradictory (caller falls back to the cached solution).
  _deduceForced(curH, curV) {
    this._initState();
    for (let i = 0; i < this.edges.length; i++) {
      const e = this.edges[i];
      const live = e.type === 'h' ? ((curH[e.r] || [])[e.c]) : ((curV[e.r] || [])[e.c]);
      if (live === 1) { if (!this._set(i, 1)) return []; }
      else if (live === 2) { if (!this._set(i, 0)) return []; }
    }
    this._deadline = Date.now() + (this.maxMs || 1500);
    if (!this._propagate()) return [];
    const forced = [];
    for (let i = 0; i < this.edges.length; i++) {
      if (this.st[i] !== 1) continue;
      const e = this.edges[i];
      const live = e.type === 'h' ? ((curH[e.r] || [])[e.c]) : ((curV[e.r] || [])[e.c]);
      if (live !== 1) forced.push({ type: e.type === 'h' ? 'horizontal' : 'vertical', r: e.r, c: e.c, value: 1 });
    }
    return forced;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { StitchesSolver };
}
