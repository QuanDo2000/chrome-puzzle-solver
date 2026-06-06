'use strict';

// TentsSolver — pure logic, no DOM.
//
// PAGE ENCODING (recon, ground truth — getErrors is a REAL oracle):
//   trees[r][c]=1 are fixed givens (never tents, not tracked in cellStatus). task: col tent-counts
//   then row tent-counts. cellStatus 0 unknown / 1 tent / 2 grass.
//
// RULE (the perfect tree<->tent matching subsumes getErrors' soleTree/soleTent/camp checks):
//   tents only on non-tree cells; each row/col has its clued tent count; no two tents 8-adjacent;
//   a perfect bipartite matching pairs each tree with exactly one orthogonally-adjacent tent
//   (bijection; #tents == #trees == sum(colClue) == sum(rowClue)).
//
// METHOD: count + 8-adjacency + tree-coverage propagation to a fixpoint; backtrack on the first
//   undecided cell; a Kuhn matching feasibility prune at each node + the perfect-matching leaf
//   check; sound partial = root snapshot on timeout. Brute-force-gated in tests/tents.test.js.
//   solve() returns grid 0 unknown/tree / 1 tent / 2 grass.

const D8R = [-1, -1, -1, 0, 1, 1, 1, 0];
const D8C = [-1, 0, 1, 1, 1, 0, -1, -1];
const D4R = [-1, 1, 0, 0];
const D4C = [0, 0, -1, 1];

class TentsSolver {
  constructor({ rows, cols, trees, colClue, rowClue, maxMs = 30000 } = {}) {
    this.rows = rows; this.cols = cols; this.trees = trees;
    this.colClue = colClue; this.rowClue = rowClue; this.maxMs = maxMs;
    this.treeList = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (trees[r][c]) this.treeList.push([r, c]);
    this.T = this.treeList.length;
  }

  // Kuhn bipartite max matching: trees -> candidate cells where cellOK(r,c) holds (orthogonal adj).
  _maxMatch(cellOK) {
    const { rows, cols } = this, matchCell = new Map();
    const tryK = (ti, seen) => {
      const [tr, tc] = this.treeList[ti];
      for (let a = 0; a < 4; a++) {
        const r = tr + D4R[a], c = tc + D4C[a];
        if (r < 0 || c < 0 || r >= rows || c >= cols || !cellOK(r, c)) continue;
        const id = r * cols + c;
        if (seen.has(id)) continue;
        seen.add(id);
        if (!matchCell.has(id) || tryK(matchCell.get(id), seen)) { matchCell.set(id, ti); return true; }
      }
      return false;
    };
    let m = 0;
    for (let ti = 0; ti < this.T; ti++) if (tryK(ti, new Set())) m++;
    return m;
  }

  // Oracle on a complete tent grid (tent[r][c] === 1 iff tent).
  _isValid(tent) {
    const { rows, cols, trees, colClue, rowClue } = this;
    const rc = new Array(rows).fill(0), cc = new Array(cols).fill(0);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (tent[r][c] === 1) {
      if (trees[r][c]) return false; // tent on a tree
      rc[r]++; cc[c]++;
      for (let a = 0; a < 8; a++) { const nr = r + D8R[a], nc = c + D8C[a]; if (nr >= 0 && nc >= 0 && nr < rows && nc < cols && tent[nr][nc] === 1) return false; } // 8-adjacent tents
    }
    for (let r = 0; r < rows; r++) if (rc[r] !== rowClue[r]) return false;
    for (let c = 0; c < cols; c++) if (cc[c] !== colClue[c]) return false;
    let total = 0; for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (tent[r][c] === 1) total++;
    if (total !== this.T) return false;
    return this._maxMatch((r, c) => tent[r][c] === 1) === this.T; // perfect matching trees <-> tents
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TentsSolver };
}
