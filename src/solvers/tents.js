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
//
// PERF (large monthly boards, e.g. 30x30): the search is allocation-bound, not algorithm-bound —
//   the matching prune is essential (without it a 30x30 doesn't finish) so it stays at every node.
//   The wins are zero-allocation per node: (1) TRAIL-based undo (a preallocated Int32Array of
//   touched cell ids + length pointer) replaces cloning the whole grid twice per node; (2) the Kuhn
//   matching uses STAMPED Int32Array scratch (owner/seen) + one reused `_candOK` closure instead of
//   a fresh Map + a Set-per-tree each call; (3) `_propagate` reuses one scratch buffer for the
//   per-row/col unknown lists. `g` stays a 2D array (the test suite reads `g[r][c]` directly).

const D8R = [-1, -1, -1, 0, 1, 1, 1, 0];
const D8C = [-1, 0, 1, 1, 1, 0, -1, -1];
const D4R = [-1, 1, 0, 0];
const D4C = [0, 0, -1, 1];

class TentsSolver {
  constructor({ rows, cols, trees, colClue, rowClue, maxMs = 30000 }) {
    this.rows = rows; this.cols = cols; this.trees = trees;
    this.colClue = colClue; this.rowClue = rowClue; this.maxMs = maxMs;
    this.treeList = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (trees[r][c]) this.treeList.push([r, c]);
    this.T = this.treeList.length;
    const N = rows * cols;
    // Zero-allocation scratch (sized once). Trail: cell ids touched since a search mark (each cell
    // goes 9 -> v at most once per path, so it never exceeds N). _scratch: per-line unknown list.
    this._trail = new Int32Array(N); this._tlen = 0;
    this._scratch = new Int32Array(Math.max(rows, cols) || 1);
    // Matching scratch: owner[id]=tree matched to cell id when ostamp[id]===_mGen; seen[id]===sgen
    // marks cells visited in the current augmenting search. Stamping avoids per-call Map/Set allocs.
    this._mOwner = new Int32Array(N); this._mStamp = new Int32Array(N);
    this._mSeen = new Int32Array(N); this._mGen = 0; this._seenGen = 0;
    // Reused predicate for the feasibility matching (possible-tent = tent or unknown, non-tree).
    this._candOK = (r, c) => !this.trees[r][c] && (this.g[r][c] === 1 || this.g[r][c] === 9);
    // Dirty-worklist scratch. _propagate re-examines only the rows/cols/trees/tents a change can
    // affect, instead of full-rescanning every fixpoint iteration. Row/col/tree queues are transient
    // (drained to empty every call, seeded fully by _initG); the tent queue (cells newly set to tent,
    // for the 8-adjacency rule) persists across nodes and is mark-restored on backtrack.
    this._rowQ = new Int32Array(rows); this._rowIn = new Uint8Array(rows); this._rowQn = 0;
    this._colQ = new Int32Array(cols); this._colIn = new Uint8Array(cols); this._colQn = 0;
    this._treeQ = new Int32Array(this.T || 1); this._treeIn = new Uint8Array(this.T || 1); this._treeQn = 0;
    this._tentQ = new Int32Array(N); this._tentN = 0; this._tentProc = 0;
    // cell id -> index of a tree on that cell, else -1 (so _set can enqueue trees adjacent to a change).
    this._treeIndex = new Int32Array(N).fill(-1);
    for (let ti = 0; ti < this.T; ti++) this._treeIndex[this.treeList[ti][0] * cols + this.treeList[ti][1]] = ti;
  }

  // Kuhn bipartite max matching: trees -> candidate cells where cellOK(r,c) holds (orthogonal adj).
  // Uses stamped Int32Array scratch (no Map/Set allocation per call).
  _maxMatch(cellOK) {
    const { rows, cols, treeList } = this;
    const owner = this._mOwner, ostamp = this._mStamp, seen = this._mSeen;
    const gen = ++this._mGen;
    const tryK = (ti, sgen) => {
      const tr = treeList[ti][0], tc = treeList[ti][1];
      for (let a = 0; a < 4; a++) {
        const r = tr + D4R[a], c = tc + D4C[a];
        if (r < 0 || c < 0 || r >= rows || c >= cols || !cellOK(r, c)) continue;
        const id = r * cols + c;
        if (seen[id] === sgen) continue;
        seen[id] = sgen;
        if (ostamp[id] !== gen || tryK(owner[id], sgen)) { owner[id] = ti; ostamp[id] = gen; return true; }
      }
      return false;
    };
    let m = 0;
    for (let ti = 0; ti < this.T; ti++) { const sgen = ++this._seenGen; if (tryK(ti, sgen)) m++; }
    return m;
  }

  _free(r, c) { return r >= 0 && c >= 0 && r < this.rows && c < this.cols && !this.trees[r][c]; }

  // g[r][c]: 9 unknown, 1 tent, 2 grass. Tree cells fixed 0 (never tents). Seeds every row/col/tree
  // dirty so the first _propagate (root, or a unit test calling it after _initG) is a full pass.
  _initG() {
    this.g = [];
    for (let r = 0; r < this.rows; r++) { this.g.push([]); for (let c = 0; c < this.cols; c++) this.g[r].push(this.trees[r][c] ? 0 : 9); }
    this._tlen = 0; this._tentN = 0; this._tentProc = 0;
    this._rowQn = 0; this._colQn = 0; this._treeQn = 0;
    this._rowIn.fill(0); this._colIn.fill(0); this._treeIn.fill(0);
    for (let r = 0; r < this.rows; r++) { this._rowQ[this._rowQn++] = r; this._rowIn[r] = 1; }
    for (let c = 0; c < this.cols; c++) { this._colQ[this._colQn++] = c; this._colIn[c] = 1; }
    for (let ti = 0; ti < this.T; ti++) { this._treeQ[this._treeQn++] = ti; this._treeIn[ti] = 1; }
  }

  _enqRow(r) { if (!this._rowIn[r]) { this._rowIn[r] = 1; this._rowQ[this._rowQn++] = r; } }
  _enqCol(c) { if (!this._colIn[c]) { this._colIn[c] = 1; this._colQ[this._colQn++] = c; } }
  _enqTree(ti) { if (!this._treeIn[ti]) { this._treeIn[ti] = 1; this._treeQ[this._treeQn++] = ti; } }

  // Records the 9 -> v transition on the trail and enqueues every scope the change can affect:
  // its row/col (count forcing), orthogonally-adjacent trees (coverage), and — for a tent — the
  // tent queue (8-adjacency). Returns false if the cell was already a different decided value.
  _set(r, c, v) {
    if (this.g[r][c] === v) return true;
    if (this.g[r][c] !== 9) return false;
    this.g[r][c] = v;
    const cols = this.cols, id = r * cols + c;
    this._trail[this._tlen++] = id;
    this._enqRow(r); this._enqCol(c);
    for (let a = 0; a < 4; a++) { const nr = r + D4R[a], nc = c + D4C[a]; if (nr < 0 || nc < 0 || nr >= this.rows || nc >= cols) continue; const ti = this._treeIndex[nr * cols + nc]; if (ti >= 0) this._enqTree(ti); }
    if (v === 1) this._tentQ[this._tentN++] = id;
    return true;
  }

  // Roll every cell touched after `mark` back to unknown (9). Tent-queue pointers are mark-restored
  // by the caller (_search); the row/col/tree queues are always empty at a search boundary.
  _rollback(mark) { const cols = this.cols; while (this._tlen > mark) { const id = this._trail[--this._tlen]; const r = (id / cols) | 0; this.g[r][id - r * cols] = 9; } }

  // Clear the transient row/col/tree queues (used when _propagate bails on a contradiction, so the
  // next propagate starts clean). The tent queue is left to the caller's mark-restore.
  _clearQueues() {
    while (this._rowQn > 0) this._rowIn[this._rowQ[--this._rowQn]] = 0;
    while (this._colQn > 0) this._colIn[this._colQ[--this._colQn]] = 0;
    while (this._treeQn > 0) this._treeIn[this._treeQ[--this._treeQn]] = 0;
  }

  // adjacency: a placed tent forces its 8 neighbours to grass; two adjacent tents = contradiction.
  _forceTent(id) {
    const cols = this.cols, r = (id / cols) | 0, c = id - r * cols;
    for (let a = 0; a < 8; a++) { const nr = r + D8R[a], nc = c + D8C[a]; if (!this._free(nr, nc)) continue; if (this.g[nr][nc] === 1) return false; if (this.g[nr][nc] === 9 && !this._set(nr, nc, 2)) return false; }
    return true;
  }

  // row count forcing (scratch reused for the unknown-column list).
  _forceRow(r) {
    const cols = this.cols, unk = this._scratch; let t = 0, n = 0;
    for (let c = 0; c < cols; c++) { if (this.g[r][c] === 1) t++; else if (this.g[r][c] === 9) unk[n++] = c; }
    if (t > this.rowClue[r] || t + n < this.rowClue[r]) return false;
    if (t === this.rowClue[r]) { for (let i = 0; i < n; i++) if (!this._set(r, unk[i], 2)) return false; }
    else if (t + n === this.rowClue[r]) { for (let i = 0; i < n; i++) if (!this._set(r, unk[i], 1)) return false; }
    return true;
  }

  // col count forcing (scratch reused for the unknown-row list).
  _forceCol(c) {
    const rows = this.rows, unk = this._scratch; let t = 0, n = 0;
    for (let r = 0; r < rows; r++) { if (this.g[r][c] === 1) t++; else if (this.g[r][c] === 9) unk[n++] = r; }
    if (t > this.colClue[c] || t + n < this.colClue[c]) return false;
    if (t === this.colClue[c]) { for (let i = 0; i < n; i++) if (!this._set(unk[i], c, 2)) return false; }
    else if (t + n === this.colClue[c]) { for (let i = 0; i < n; i++) if (!this._set(unk[i], c, 1)) return false; }
    return true;
  }

  // tree coverage: a tree with no placed adjacent tent and exactly one possible adjacent cell -> force it.
  _forceTree(ti) {
    const tr = this.treeList[ti][0], tc = this.treeList[ti][1]; let placed = 0, candN = 0, cr = 0, cc = 0;
    for (let a = 0; a < 4; a++) { const r = tr + D4R[a], c = tc + D4C[a]; if (!this._free(r, c)) continue; if (this.g[r][c] === 1) placed++; else if (this.g[r][c] === 9) { candN++; cr = r; cc = c; } }
    if (placed === 0) { if (candN === 0) return false; if (candN === 1 && !this._set(cr, cc, 1)) return false; }
    return true;
  }

  // Drain the dirty worklists to a fixpoint. Returns false on contradiction (queues left clean).
  _propagate() {
    while (this._tentProc < this._tentN || this._rowQn > 0 || this._colQn > 0 || this._treeQn > 0) {
      while (this._tentProc < this._tentN) { if (!this._forceTent(this._tentQ[this._tentProc++])) { this._clearQueues(); return false; } }
      while (this._rowQn > 0) { const r = this._rowQ[--this._rowQn]; this._rowIn[r] = 0; if (!this._forceRow(r)) { this._clearQueues(); return false; } }
      while (this._colQn > 0) { const c = this._colQ[--this._colQn]; this._colIn[c] = 0; if (!this._forceCol(c)) { this._clearQueues(); return false; } }
      while (this._treeQn > 0) { const ti = this._treeQ[--this._treeQn]; this._treeIn[ti] = 0; if (!this._forceTree(ti)) { this._clearQueues(); return false; } }
    }
    return true;
  }

  // matching feasibility: trees must still be coverable by possible-tent cells (tent or unknown)
  _matchFeasible() { return this._maxMatch(this._candOK) === this.T; }

  _tentGrid() { const t = []; for (let r = 0; r < this.rows; r++) { t.push([]); for (let c = 0; c < this.cols; c++) t[r].push(this.g[r][c] === 1 ? 1 : 0); } return t; }
  // emit: 0 unknown/tree, 1 tent, 2 grass.
  _emit() { const out = []; for (let r = 0; r < this.rows; r++) { out.push([]); for (let c = 0; c < this.cols; c++) { if (this.trees[r][c]) { out[r].push(0); continue; } const v = this.g[r][c]; out[r].push(v === 9 ? 0 : v === 1 ? 1 : 2); } } return out; }

  _pick() { for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) if (!this.trees[r][c] && this.g[r][c] === 9) return [r, c]; return null; }

  _search(countAll) {
    if (Date.now() > this._deadline) { this._timedOut = true; return true; }
    if (!this._matchFeasible()) return false;
    const cell = this._pick();
    if (!cell) { const t = this._tentGrid(); if (this._isValid(t)) { this._count++; if (!this._first) this._first = this.g.map((row) => row.slice()); if (!countAll) return true; if (this._count >= 2) return true; } return false; }
    const r = cell[0], c = cell[1];
    for (let vi = 0; vi < 2; vi++) {
      const v = vi === 0 ? 1 : 2;
      const mark = this._tlen, tentMark = this._tentN;
      if (this._set(r, c, v) && this._propagate() && this._search(countAll)) { if (!countAll || this._count >= 2 || this._timedOut) return true; }
      this._rollback(mark); this._tentN = tentMark; this._tentProc = tentMark;
    }
    return false;
  }

  solve(countAll = false) {
    this._initG();
    this._deadline = Date.now() + this.maxMs; this._timedOut = false; this._count = 0; this._first = null;
    if (!this._propagate()) return { solved: false, error: 'No solution (contradiction in givens)' };
    const root = this._emit();
    this._search(countAll);
    if (this._first) { this.g = this._first; return { solved: true, grid: this._emit(), count: this._count }; }
    if (this._timedOut) return { solved: false, partial: true, grid: root };
    return { solved: false, error: 'No solution found' };
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

  // Hint engine. initialState = live cellStatus (0 unknown / 1 tent / 2 grass). Tree cells are 0 in
  // cellStatus (untracked) — _initG fixes them 0 (never tent) so deduction can't target them and
  // Loop never stalls on them ([[project_clue_cells_not_in_cellstatus]]). Returns newly-forced
  // non-tree cells as { row, col, value(1 tent / 2 grass) }.
  getHint(initialState) {
    this._initG();
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) if (!this.trees[r][c]) {
      const v = initialState[r] ? initialState[r][c] : 0;
      if (v === 1) { if (!this._set(r, c, 1)) return []; }
      else if (v === 2) { if (!this._set(r, c, 2)) return []; }
    }
    this._deadline = Date.now() + (this.maxMs || 1500);
    if (!this._propagate()) return [];
    const out = [];
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) {
      if (this.trees[r][c]) continue;
      const was = initialState[r] ? initialState[r][c] : 0;
      if (was !== 0) continue;
      if (this.g[r][c] === 1) out.push({ row: r, col: c, value: 1 });
      else if (this.g[r][c] === 2) out.push({ row: r, col: c, value: 2 });
    }
    return out;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TentsSolver };
}
