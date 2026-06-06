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
  constructor({ rows, cols, areas, colClue, rowClue, stitches, maxMs = 30000 } = {}) {
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
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { StitchesSolver };
}
