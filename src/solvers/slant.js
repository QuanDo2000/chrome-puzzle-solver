'use strict';

// Slant (Gokigen Naname) solver — pure logic, no DOM.
//
// PAGE ENCODING (recon, ground truth)
//   task[t][e]:  (H+1)x(W+1) vertex clues — -1 none, 0..4 = required incident-diagonal count
//   cellStatus[r][c]:  0 empty, 1 = '\' (top-left<->bottom-right), 2 = '/' (top-right<->bottom-left)
//   cell (r,c) '\' = edge (r,c)-(r+1,c+1);  '/' = edge (r,c+1)-(r+1,c)
//
// VALIDITY (ported from the page getErrors; see the plan doc):
//   (1) every clued vertex's incident-diagonal count equals its clue;
//   (2) the diagonal-edge graph is ACYCLIC (a forest — no loops; need not be connected).
//
// METHOD: clue-forcing + acyclicity propagation (with a rollback union-find of committed
// cells), then first-undecided DFS backtracking with union-find cycle detection. (Branch
// order is first-undecided, not MRV — every cell is a binary {\,/} domain, so MRV would be
// degenerate.) On maxMs timeout returns the SOUND root-propagation snapshot (UNK=9).
// Soundness is brute-force-gated in tests/slant.test.js. The real 20x20 full-solves in ~0.4s.
//
// cells[r][c] in solver/output: 1 '\', 2 '/', 9 UNK (partials only).

// Rollback-friendly union-find (no path compression so clone() is an exact snapshot).
class DSU {
  constructor(n) { this.p = new Array(n); this.r = new Array(n).fill(0); for (let i = 0; i < n; i++) this.p[i] = i; }
  find(x) { while (this.p[x] !== x) x = this.p[x]; return x; }
  connected(a, b) { return this.find(a) === this.find(b); }
  union(a, b) { // true if joined (were separate); false if already same (would form a cycle)
    let ra = this.find(a), rb = this.find(b);
    if (ra === rb) return false;
    if (this.r[ra] < this.r[rb]) { const t = ra; ra = rb; rb = t; }
    this.p[rb] = ra; if (this.r[ra] === this.r[rb]) this.r[ra]++;
    return true;
  }
  clone() { const d = new DSU(this.p.length); d.p = this.p.slice(); d.r = this.r.slice(); return d; }
}

class SlantSolver {
  constructor({ task, rows, cols, maxMs = 30000 } = {}) {
    this.task = task; this.rows = rows; this.cols = cols; this.maxMs = maxMs;
    this.V = (rows + 1) * (cols + 1);
  }
  _inside(r, c) { return r >= 0 && r < this.rows && c >= 0 && c < this.cols; }
  _vid(t, e) { return t * (this.cols + 1) + e; }
  // [u,v] vertex ids of cell (r,c)'s diagonal: val 1 = '\', val 2 = '/'.
  _edge(r, c, val) {
    return val === 1 ? [this._vid(r, c), this._vid(r + 1, c + 1)] : [this._vid(r, c + 1), this._vid(r + 1, c)];
  }
  // Incident cell-slots of vertex (t,e): [r, c, pointingVal] (the cell value that points to (t,e)).
  _slots(t, e) {
    const s = [];
    if (this._inside(t - 1, e - 1)) s.push([t - 1, e - 1, 1]);
    if (this._inside(t, e)) s.push([t, e, 1]);
    if (this._inside(t - 1, e)) s.push([t - 1, e, 2]);
    if (this._inside(t, e - 1)) s.push([t, e - 1, 2]);
    return s;
  }
  // Full-board validity oracle (port of getErrors). cells fully decided (1/2).
  _isValid(cells) {
    const { rows, cols, task } = this;
    for (let t = 0; t <= rows; t++) for (let e = 0; e <= cols; e++) {
      const k = task[t][e]; if (k < 0) continue;
      let cnt = 0; for (const [r, c, pv] of this._slots(t, e)) if (cells[r][c] === pv) cnt++;
      if (cnt !== k) return false;
    }
    const d = new DSU(this.V);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const [u, v] = this._edge(r, c, cells[r][c]);
      if (!d.union(u, v)) return false; // cycle
    }
    return true;
  }

  _freshDSU() { return new DSU(this.V); }

  // Set cell (r,c) to val (1/2), unioning its diagonal edge. Returns false on a
  // conflicting prior value OR if the edge would close a cycle.
  _set(r, c, val) {
    if (this.cells[r][c] === val) return true;
    if (this.cells[r][c] !== 0) return false;
    const [u, v] = this._edge(r, c, val);
    if (!this.dsu.union(u, v)) return false; // would create a cycle
    this.cells[r][c] = val; this._dirty = true; return true;
  }

  // Clue-forcing + acyclicity-forcing to a fixpoint. Returns false on contradiction.
  _propagate() {
    this._dirty = true;
    while (this._dirty) {
      this._dirty = false;
      // Clue forcing: per clued vertex, count pointing/undecided incident cells.
      for (let t = 0; t <= this.rows; t++) for (let e = 0; e <= this.cols; e++) {
        const k = this.task[t][e]; if (k < 0) continue;
        let P = 0; const und = [];
        for (const sl of this._slots(t, e)) { const v = this.cells[sl[0]][sl[1]]; if (v === sl[2]) P++; else if (v === 0) und.push(sl); }
        if (P > k) return false;
        if (P + und.length < k) return false;
        if (P === k && und.length) { for (const sl of und) { const notp = sl[2] === 1 ? 2 : 1; if (!this._set(sl[0], sl[1], notp)) return false; } }
        else if (P + und.length === k && und.length) { for (const sl of und) { if (!this._set(sl[0], sl[1], sl[2])) return false; } }
      }
      // Acyclicity forcing: an undecided cell whose '\' would cycle must be '/' (and vice-versa).
      for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) {
        if (this.cells[r][c] !== 0) continue;
        const [u1, v1] = this._edge(r, c, 1), [u2, v2] = this._edge(r, c, 2);
        const cyc1 = this.dsu.connected(u1, v1), cyc2 = this.dsu.connected(u2, v2);
        if (cyc1 && cyc2) return false;
        else if (cyc1) { if (!this._set(r, c, 2)) return false; }
        else if (cyc2) { if (!this._set(r, c, 1)) return false; }
      }
    }
    return true;
  }

  _snapshot() { return { cells: this.cells.map(r => r.slice()), dsu: this.dsu.clone() }; }
  _restore(s) { this.cells = s.cells.map(r => r.slice()); this.dsu = s.dsu.clone(); }
  _pickCell() {
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) if (this.cells[r][c] === 0) return [r, c];
    return null;
  }
  _search() {
    if (Date.now() > this._deadline) { this._timedOut = true; return null; }
    const cell = this._pickCell();
    if (!cell) return this._isValid(this.cells) ? this.cells : null;
    for (const val of [1, 2]) {
      const snap = this._snapshot();
      if (this._set(cell[0], cell[1], val) && this._propagate()) { const res = this._search(); if (res) return res; }
      this._restore(snap);
    }
    return null;
  }
  solve() {
    this.cells = Array.from({ length: this.rows }, () => new Array(this.cols).fill(0));
    this.dsu = this._freshDSU();
    this._deadline = Date.now() + this.maxMs; this._timedOut = false;
    if (!this._propagate()) return { solved: false, error: 'No solution (contradiction in givens)' };
    const root = this.cells.map(r => r.map(v => (v === 0 ? 9 : v)));
    const res = this._search();
    if (res) return { solved: true, cells: res.map(r => r.slice()) };
    if (this._timedOut) return { solved: false, partial: true, cells: root };
    return { solved: false, error: 'No solution found' };
  }

  // Hint engine: seed the solver with the live cellStatus (0/1/2), deduce to a fixpoint,
  // and return the newly-forced cells as { row, col, value }. Returns [] if the live board
  // is contradictory (caller falls back to the cached-solution diff).
  _deduceForced(curCells) {
    this.cells = curCells.map(row => row.map(v => (v === 1 || v === 2) ? v : 0));
    this.dsu = this._freshDSU();
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) {
      const v = this.cells[r][c];
      if (v === 1 || v === 2) { const [u, w] = this._edge(r, c, v); if (!this.dsu.union(u, w)) return []; }
    }
    this._deadline = Date.now() + (this.maxMs || 2000);
    if (!this._propagate()) return [];
    const forced = [];
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) {
      if (curCells[r][c] === 1 || curCells[r][c] === 2) continue;
      const v = this.cells[r][c];
      if (v === 1 || v === 2) forced.push({ row: r, col: c, value: v });
    }
    return forced;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SlantSolver };
}
