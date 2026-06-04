'use strict';

// Light Up (Akari) solver — pure logic, no DOM.
//
// PAGE ENCODING (recon, ground truth)
//   task[r][c]:        -1 white/open · -2 black no-number · 0..4 numbered black
//   cellStatus[r][c]:   0 empty · 1 bulb · 2 X (no-bulb marker)
//
// SOLVER BOARD MODEL
//   cells[r][c]:       -1 black · 0 no-bulb white · 1 bulb white · 9 UNK (partials only)
//   _dom[r][c]:         0 black · 1 = {no-bulb} · 2 = {bulb} · 3 = {no-bulb, bulb}  (bitmask: bit0=no-bulb, bit1=bulb)
//
// VALIDITY (ported verbatim from the page getErrors; see the plan doc Appendix):
//   (1) no bulb lies in another bulb's unblocked row/col segment (collision);
//   (2) every numbered cell's orthogonally-adjacent bulb count == its clue;
//   (3) every cell is lit (a bulb, in a bulb's segment up to the first black, or black).
//
// METHOD: domain propagation (clue forcing + no-collision + coverage forcing) to a
// fixpoint, then first-undecided backtracking with snapshot undo. (Variable order is
// just first-undecided, not MRV — every branchable cell is a binary {bulb,no-bulb}
// domain, so MRV would be degenerate. Snapshot-undo rather than trailing because
// propagation is strong enough that search node-count stays tiny on real boards.)
// On maxMs timeout returns the SOUND root-propagation snapshot (UNK=9 where still
// undecided) — never a speculative mid-search branch. Soundness is brute-force-gated
// in tests/lightup.test.js.

class LightUpSolver {
  constructor({ task, maxMs = 30000 } = {}) {
    this.task = task;
    this.rows = task.length;
    this.cols = task[0] ? task[0].length : 0;
    this.maxMs = maxMs;
    this._timedOut = false;
  }

  // Orthogonal in-range bulb count around a numbered cell.
  // NOTE: `_taskMarkedCount` and `_isValid` keep the page getErrors index names
  // (`i` = row, `r` = col, `l` = segment walk) so they stay auditable against the
  // captured getErrorsSrc. Every OTHER method in this file uses `r` = row, `c` = col.
  _taskMarkedCount(cells, i, r) {
    let n = 0;
    if (i > 0 && cells[i - 1][r] === 1) n++;
    if (i < this.rows - 1 && cells[i + 1][r] === 1) n++;
    if (r > 0 && cells[i][r - 1] === 1) n++;
    if (r < this.cols - 1 && cells[i][r + 1] === 1) n++;
    return n;
  }

  // Full-board validity oracle (port of getErrors with t=true). cells is a fully
  // decided board: -1 black, 0 no-bulb, 1 bulb.
  _isValid(cells) {
    const H = this.rows, W = this.cols, task = this.task;
    const lit = Array.from({ length: H }, () => new Array(W).fill(0));
    for (let i = 0; i < H; i++) for (let r = 0; r < W; r++) {
      if (cells[i][r] === 1) {                       // a bulb
        let o = 0; lit[i][r] = 1;
        for (let l = r; l < W - 1 && task[i][l + 1] === -1;) { l++; lit[i][l] = 1; if (cells[i][l] === 1) o++; }
        for (let l = r; l > 0 && task[i][l - 1] === -1;) { l--; lit[i][l] = 1; if (cells[i][l] === 1) o++; }
        for (let l = i; l < H - 1 && task[l + 1][r] === -1;) { l++; lit[l][r] = 1; if (cells[l][r] === 1) o++; }
        for (let l = i; l > 0 && task[l - 1][r] === -1;) { l--; lit[l][r] = 1; if (cells[l][r] === 1) o++; }
        if (o) return false;                         // lightCollision
      }
      if (task[i][r] >= 0) {                          // numbered black
        if (this._taskMarkedCount(cells, i, r) !== task[i][r]) return false; // taskViolation
        lit[i][r] = 1;
      }
      if (task[i][r] === -2) lit[i][r] = 1;           // black no-number: covered
    }
    for (let i = 0; i < H; i++) for (let r = 0; r < W; r++) if (!lit[i][r]) return false; // hasEmpty
    return true;
  }

  // Map current domains to a cells grid: black -1, {bulb} 1, {no-bulb} 0, undecided 9.
  _cellsFromDom() {
    const out = [];
    for (let r = 0; r < this.rows; r++) {
      const row = new Array(this.cols);
      for (let c = 0; c < this.cols; c++) {
        if (this.task[r][c] !== -1) { row[c] = -1; continue; }
        const d = this._dom[r][c];
        row[c] = d === 2 ? 1 : (d === 1 ? 0 : 9);
      }
      out.push(row);
    }
    return out;
  }

  _initDomains() {
    this._dom = [];
    for (let r = 0; r < this.rows; r++) {
      const row = new Array(this.cols);
      for (let c = 0; c < this.cols; c++) row[c] = this.task[r][c] === -1 ? 3 : 0;
      this._dom.push(row);
    }
  }

  // Precompute, per cell:
  //   _nb[r][c]  = orthogonal in-range WHITE neighbours (used by clue forcing, so it
  //                MUST be computed for numbered/black cells too — not just white ones).
  //   _segs[r][c]= a white cell's segment cells (4 dirs until a black wall); [] for black.
  _buildSegments() {
    const H = this.rows, W = this.cols, task = this.task;
    this._segs = Array.from({ length: H }, () => new Array(W));
    this._nb = Array.from({ length: H }, () => new Array(W));
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      // _nb for EVERY cell (clue cells need their white neighbours).
      const nb = [];
      if (r > 0 && task[r - 1][c] === -1) nb.push([r - 1, c]);
      if (r < H - 1 && task[r + 1][c] === -1) nb.push([r + 1, c]);
      if (c > 0 && task[r][c - 1] === -1) nb.push([r, c - 1]);
      if (c < W - 1 && task[r][c + 1] === -1) nb.push([r, c + 1]);
      this._nb[r][c] = nb;
      // _segs only for white cells.
      if (task[r][c] !== -1) { this._segs[r][c] = []; continue; }
      const seg = [];
      for (let l = c; l < W - 1 && task[r][l + 1] === -1;) { l++; seg.push([r, l]); }
      for (let l = c; l > 0 && task[r][l - 1] === -1;) { l--; seg.push([r, l]); }
      for (let l = r; l < H - 1 && task[l + 1][c] === -1;) { l++; seg.push([l, c]); }
      for (let l = r; l > 0 && task[l - 1][c] === -1;) { l--; seg.push([l, c]); }
      this._segs[r][c] = seg;
    }
  }

  // Is (r,c) lit by some DECIDED bulb? (itself a bulb, or a bulb in its segment.)
  _isLit(r, c) {
    if (this._dom[r][c] === 2) return true;
    for (const [nr, nc] of this._segs[r][c]) if (this._dom[nr][nc] === 2) return true;
    return false;
  }

  // Propagate three sound rules to a fixpoint. Returns false on contradiction.
  //   A no-collision: a decided bulb forbids bulbs (and lights) its whole segment.
  //   B clue forcing: a numbered cell pins its undecided neighbours when forced.
  //   C coverage:     an unlit white cell with exactly one possible lighter forces it;
  //                   zero possible lighters is a contradiction.
  _propagate() {
    let changed = true;
    while (changed) {
      changed = false;
      // Rule A
      for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) {
        if (this._dom[r][c] !== 2) continue;
        for (const [nr, nc] of this._segs[r][c]) {
          const d = this._dom[nr][nc];
          if (d === 2) return false;          // two bulbs see each other
          if (d === 3) { this._dom[nr][nc] = 1; changed = true; } // can't be a bulb
        }
      }
      // Rule B
      for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) {
        const k = this.task[r][c];
        if (k < 0) continue;                  // not a numbered cell
        let b = 0; const undec = [];
        for (const [nr, nc] of this._nb[r][c]) {
          const d = this._dom[nr][nc];
          if (d === 2) b++;
          else if (d === 3) undec.push([nr, nc]);
        }
        if (b > k) return false;
        if (b + undec.length < k) return false;
        if (b === k && undec.length) { for (const [nr, nc] of undec) this._dom[nr][nc] = 1; changed = true; }
        else if (b + undec.length === k && undec.length) { for (const [nr, nc] of undec) this._dom[nr][nc] = 2; changed = true; }
      }
      // Rule C
      for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) {
        if (this.task[r][c] !== -1) continue; // only white cells need lighting
        if (this._isLit(r, c)) continue;
        let count = 0, only = null;
        if (this._dom[r][c] & 2) { count++; only = [r, c]; }
        for (const [nr, nc] of this._segs[r][c]) {
          if (this._dom[nr][nc] & 2) { count++; only = [nr, nc]; }
        }
        if (count === 0) return false;        // can never be lit
        if (count === 1 && this._dom[only[0]][only[1]] !== 2) { this._dom[only[0]][only[1]] = 2; changed = true; }
      }
    }
    return true;
  }

  _snapshot() { return this._dom.map(row => row.slice()); }
  _restore(snap) { this._dom = snap.map(row => row.slice()); }

  // Recursive first-undecided backtracking. Returns a solved cells grid, or null (dead end / timeout).
  _search() {
    if (Date.now() > this._deadline) { this._timedOut = true; return null; }
    // pick first undecided white cell (dom===3)
    let pr = -1, pc = -1;
    for (let r = 0; r < this.rows && pr < 0; r++) for (let c = 0; c < this.cols; c++) {
      if (this._dom[r][c] === 3) { pr = r; pc = c; break; }
    }
    if (pr < 0) { const cells = this._cellsFromDom(); return this._isValid(cells) ? cells : null; }
    const snap = this._snapshot();
    // Branch bulb first (more constraining), then no-bulb.
    this._dom[pr][pc] = 2;
    if (this._propagate()) { const res = this._search(); if (res) return res; }
    this._restore(snap);
    this._dom[pr][pc] = 1;
    if (this._propagate()) { const res = this._search(); if (res) return res; }
    this._restore(snap);
    return null;
  }

  // Hint engine: pin the player's already-decided cells, propagate to a fixpoint,
  // and return open cells the deduction newly determined. `decided` is a board-state
  // grid: -1 black, 0 no-bulb, 1 bulb, 9 UNK (untouched). Returns [] on contradiction
  // (the live board is wrong) so callers fall back to the cached-solution diff.
  _deduceOnly(decided) {
    this._initDomains();
    this._buildSegments();
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) {
      if (this.task[r][c] !== -1) continue;
      const v = decided[r][c];
      if (v === 0) this._dom[r][c] = 1;
      else if (v === 1) this._dom[r][c] = 2;
    }
    if (!this._propagate()) return [];
    const forced = [];
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) {
      if (this.task[r][c] !== -1) continue;
      if (decided[r][c] !== 9) continue;        // only newly-determined cells
      const d = this._dom[r][c];
      if (d === 2) forced.push({ row: r, col: c, value: 1 });
      else if (d === 1) forced.push({ row: r, col: c, value: 0 });
    }
    return forced;
  }

  solve() {
    this._initDomains();
    this._buildSegments();
    this._deadline = Date.now() + this.maxMs;
    this._timedOut = false;
    if (!this._propagate()) return { solved: false, error: 'No solution (contradiction in givens)' };
    const rootCells = this._cellsFromDom();   // sound root snapshot for partial (UNK=9)
    const result = this._search();
    if (result) return { solved: true, cells: result };
    if (this._timedOut) return { solved: false, partial: true, cells: rootCells };
    return { solved: false, error: 'No solution found' };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LightUpSolver };
}
