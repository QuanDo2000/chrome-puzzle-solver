'use strict';
const { timeUp } = require('./shared.js');

const UNK = 9; // undecided open cell
const GAC_CAP = 5; // max open read-neighbours to enumerate (cost bound; >cap -> don't prune, sound)

function popcount(x) { let n = 0; while (x) { x &= x - 1; n++; } return n; }

class ShakashakaSolver {
  constructor({ task, maxMs = 0 }) {
    this.task = task;
    this.rows = task.length;
    this.cols = task[0].length;
    this.maxMs = maxMs;
    this._startedAt = 0;
    this._heavyMaxCells = 200; // > this (~14x14) => large: bounded bifurcation + fast partial
    this._lightBudgetMs = 4000; // large-board deduction/search wall budget
    this._deadline = 0; // 0 = no deadline; set by budget>0 (ms epoch)
    this._bifurcationDisabled = false; // GAC-only mode (set for large-board Hint)
  }

  // Board-state of a cell for the rule functions: black cells (task!=-1) -> -1;
  // otherwise the board value (0 white, 1..4 triangle, or UNK if undecided).
  _bs(board, r, c) { return this.task[r][c] !== -1 ? -1 : board[r][c]; }

  // Ported taskMarkedCount: # orthogonal neighbours that are triangles (1..4).
  _taskMarkedCount(board, t, e) {
    const { rows, cols } = this; let s = 0;
    const tri = (r, c) => { const v = this._bs(board, r, c); return v >= 1 && v <= 4; };
    if (e > 0 && tri(t, e - 1)) s++;
    if (e < cols - 1 && tri(t, e + 1)) s++;
    if (t > 0 && tri(t - 1, e)) s++;
    if (t < rows - 1 && tri(t + 1, e)) s++;
    return s;
  }

  // Ported hasNonRect per-cell predicate. Returns true iff open cell (t,e)
  // triggers a rectangle violation on a COMPLETE board. (See Appendix for the
  // verbatim source; this is a faithful 1:1 port.)
  _hasNonRectAt(board, t, e) {
    const { rows: H, cols: W } = this;
    const g = (r, c) => this._bs(board, r, c);
    const i = g(t, e);
    if (i === 0) {
      if (t > 0 && e > 0)       { const r = g(t-1,e), l = g(t,e-1), o = g(t-1,e-1); if (!r && !l && o && o !== 1) return true; }
      if (t > 0 && e < W-1)     { const r = g(t-1,e), l = g(t,e+1), o = g(t-1,e+1); if (!r && !l && o && o !== 2) return true; }
      if (t < H-1 && e < W-1)   { const r = g(t+1,e), l = g(t,e+1), o = g(t+1,e+1); if (!r && !l && o && o !== 3) return true; }
      if (t < H-1 && e > 0)     { const r = g(t+1,e), l = g(t,e-1), o = g(t+1,e-1); if (!r && !l && o && o !== 4) return true; }
      return false;
    }
    if (i === 1) {
      if (!(e < W-1)) return true;
      let s = g(t, e+1); if (s) { if (s !== 2) return true; } else { if (!t) return true; if (g(t-1,e+1) !== i) return true; }
      if (!(t < H-1)) return true;
      s = g(t+1, e); if (s) { if (s !== 4) return true; } else { if (!e) return true; if (g(t+1,e-1) !== i) return true; }
      return false;
    }
    if (i === 2) {
      if (!e) return true;
      let s = g(t, e-1); if (s) { if (s !== 1) return true; } else { if (!t) return true; if (g(t-1,e-1) !== i) return true; }
      if (!(t < H-1)) return true;
      s = g(t+1, e); if (s) { if (s !== 3) return true; } else { if (!(e < W-1)) return true; if (g(t+1,e+1) !== i) return true; }
      return false;
    }
    if (i === 3) {
      if (!e) return true;
      let s = g(t, e-1); if (s) { if (s !== 4) return true; } else { if (!(t < H-1)) return true; if (g(t+1,e-1) !== i) return true; }
      if (!t) return true;
      s = g(t-1, e); if (s) { if (s !== 2) return true; } else { if (!(e < W-1)) return true; if (g(t-1,e+1) !== i) return true; }
      return false;
    }
    if (i === 4) {
      if (!(e < W-1)) return true;
      let s = g(t, e+1); if (s) { if (s !== 3) return true; } else { if (!(t < H-1)) return true; if (g(t+1,e+1) !== i) return true; }
      if (!t) return true;
      s = g(t-1, e); if (s) { if (s !== 1) return true; } else { if (!e) return true; if (g(t-1,e-1) !== i) return true; }
      return false;
    }
    return false; // UNK or other: not a determinate violation
  }

  // Full-board rectangle check (complete board). Returns the first offending
  // [t,e] or false. Mirrors the page's hasNonRect (iterates open cells only).
  _hasNonRect(board) {
    for (let t = 0; t < this.rows; t++) for (let e = 0; e < this.cols; e++) {
      if (this.task[t][e] === -1 && this._hasNonRectAt(board, t, e)) return [t, e];
    }
    return false;
  }

  // A complete board is valid iff no non-rect AND all number clues match.
  _isValid(board) {
    if (this._hasNonRect(board)) return false;
    for (let t = 0; t < this.rows; t++) for (let e = 0; e < this.cols; e++) {
      const k = this.task[t][e];
      if (k >= 0 && this._taskMarkedCount(board, t, e) !== k) return false;
    }
    return true;
  }

  _initDomains() {
    const full = 0b11111; // values 0,1,2,3,4
    this._dom = this.task.map(row => row.map(v => (v === -1 ? full : 0)));
  }
  _boardFromDomains() {
    // singleton domains -> value; else UNK; black -> -1
    return this.task.map((row, r) => row.map((v, c) => {
      if (v !== -1) return -1;
      const d = this._dom[r][c];
      if (d && (d & (d - 1)) === 0) { let x = 0, m = d; while (m > 1) { m >>= 1; x++; } return x; }
      return UNK;
    }));
  }
  // Is value v at (r,c) locally consistent? Tentatively place it and check that no
  // open cell whose neighbourhood is now fully decided violates _hasNonRectAt, and
  // that no number clue is exceeded / made unreachable. Returns false if v is
  // provably impossible. Conservative: when a neighbourhood is not fully decided,
  // do NOT flag (sound — only prunes certain impossibilities).
  _consistent(board, r, c, v) {
    board[r][c] = v;
    let ok = true;
    // check this cell + 8 neighbours' rectangle predicate, only where fully decided
    for (let dr = -1; dr <= 1 && ok; dr++) for (let dc = -1; dc <= 1 && ok; dc++) {
      const t = r + dr, e = c + dc;
      if (t < 0 || e < 0 || t >= this.rows || e >= this.cols) continue;
      if (this.task[t][e] !== -1) continue;
      if (this._neighbourhoodDecided(board, t, e) && this._hasNonRectAt(board, t, e)) ok = false;
    }
    // number-clue feasibility around (r,c)
    if (ok) ok = this._clueFeasibleAround(board, r, c);
    board[r][c] = UNK;
    return ok;
  }
  _neighbourhoodDecided(board, t, e) {
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const r = t + dr, c = e + dc;
      if (r < 0 || c < 0 || r >= this.rows || c >= this.cols) continue;
      if (this.task[r][c] === -1 && board[r][c] === UNK) return false;
    }
    return true;
  }
  // For each numbered clue adjacent to (r,c): current triangle count must be <= k,
  // and k must be reachable given still-UNK neighbours (each can be a triangle).
  _clueFeasibleAround(board, r, c) {
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (Math.abs(dr) + Math.abs(dc) !== 1 && !(dr === 0 && dc === 0)) continue;
      const t = r + dr, e = c + dc;
      if (t < 0 || e < 0 || t >= this.rows || e >= this.cols) continue;
      const k = this.task[t][e];
      if (k < 0 || k > 4) continue;
      let tri = 0, unk = 0;
      for (const [nr, nc] of [[t,e-1],[t,e+1],[t-1,e],[t+1,e]]) {
        if (nr < 0 || nc < 0 || nr >= this.rows || nc >= this.cols) continue;
        if (this.task[nr][nc] !== -1) continue;
        const b = board[nr][nc];
        if (b === UNK) unk++; else if (b >= 1 && b <= 4) tri++;
      }
      if (tri > k || tri + unk < k) return false;
    }
    return true;
  }
  // Propagate domains to a fixpoint: drop any value that is not _consistent.
  // Returns false on a wipeout (some open cell's domain becomes empty).
  _propagate(board) {
    let changed = true;
    while (changed) {
      changed = false;
      for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) {
        if (this.task[r][c] !== -1) continue;
        const d = this._dom[r][c];
        if (d && (d & (d - 1)) === 0) continue; // already singleton
        let nd = 0;
        for (let v = 0; v <= 4; v++) if (d & (1 << v)) { if (this._consistent(board, r, c, v)) nd |= (1 << v); }
        if (nd === 0) return false;
        if (nd !== d) { this._dom[r][c] = nd; changed = true;
          // reflect singleton into board for subsequent checks
          if ((nd & (nd - 1)) === 0) { let x=0,m=nd; while(m>1){m>>=1;x++;} board[r][c]=x; }
        }
      }
    }
    return true;
  }
  // Is value v supported at open cell (r,c)? Tentatively place v; v is impossible
  // (return false) iff a number clue around (r,c) is infeasible, OR — when the
  // cell's open read-neighbours are few enough to enumerate — no assignment of
  // those neighbours (over their current domains) makes _hasNonRectAt(r,c) pass.
  // When too many neighbours are open (> GAC_CAP) we cannot disprove v cheaply, so
  // we KEEP it (sound under-pruning). Reads neighbour domains from this._dom.
  _gacSupported(board, r, c, v) {
    const { rows, cols } = this;
    const U = [];
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const t = r + dr, e = c + dc;
      if (t < 0 || e < 0 || t >= rows || e >= cols || (t === r && e === c)) continue;
      if (this.task[t][e] === -1 && board[t][e] === UNK) U.push([t, e]);
    }
    board[r][c] = v;
    let ok;
    if (!this._clueFeasibleAround(board, r, c)) ok = false;
    else if (U.length > GAC_CAP) ok = true;
    else ok = this._enumSupport(board, r, c, U, 0);
    for (const [t, e] of U) board[t][e] = UNK;
    board[r][c] = UNK;
    return ok;
  }
  // Recursively assign the open neighbours U from their domains; true iff some
  // assignment makes _hasNonRectAt(r,c) false (no violation at (r,c)).
  _enumSupport(board, r, c, U, i) {
    if (i === U.length) return !this._hasNonRectAt(board, r, c);
    const [t, e] = U[i], d = this._dom[t][e];
    for (let w = 0; w <= 4; w++) if (d & (1 << w)) {
      board[t][e] = w;
      if (this._enumSupport(board, r, c, U, i + 1)) return true;
    }
    board[t][e] = UNK;
    return false;
  }
  // Generalized arc-consistency to a fixpoint over this._dom. Returns false on a
  // domain wipeout (contradiction). Prunes only provably-impossible values.
  _gacPropagate() {
    let changed = true;
    while (changed) {
      changed = false;
      const board = this._boardFromDomains();
      for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) {
        if (this.task[r][c] !== -1) continue;
        const d = this._dom[r][c];
        if (popcount(d) <= 1) continue;
        let nd = 0;
        for (let v = 0; v <= 4; v++) if (d & (1 << v)) { if (this._gacSupported(board, r, c, v)) nd |= (1 << v); }
        if (nd === 0) return false;
        if (nd !== d) {
          this._dom[r][c] = nd;
          if (popcount(nd) === 1) { let x = 0, m = nd; while (m > 1) { m >>= 1; x++; } board[r][c] = x; }
          changed = true;
        }
      }
    }
    return true;
  }
  // Tier-2: 1-ply probe each frontier cell-value. Pin it, run full GAC; if that
  // wipes out, the value is provably impossible -> prune. Frontier = open cells
  // adjacent to a decided/black cell. Cost-gated by this._deadline. Returns
  // { changed, ok:false on contradiction }.
  _bifurcate() {
    const board = this._boardFromDomains();
    const frontier = [];
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) {
      if (this.task[r][c] !== -1 || popcount(this._dom[r][c]) <= 1) continue;
      let adj = false;
      for (const [t, e] of [[r-1,c],[r+1,c],[r,c-1],[r,c+1]]) {
        if (t < 0 || e < 0 || t >= this.rows || e >= this.cols) continue;
        if (this.task[t][e] !== -1 || board[t][e] !== UNK) { adj = true; break; }
      }
      if (adj) frontier.push([r, c]);
    }
    let changed = false;
    for (const [r, c] of frontier) {
      if (this._deadline && Date.now() > this._deadline) break;
      const d = this._dom[r][c];
      if (popcount(d) <= 1) continue;
      for (let v = 0; v <= 4; v++) if (d & (1 << v)) {
        const saved = this._dom.map(row => row.slice());
        this._dom[r][c] = (1 << v);
        const ok = this._gacPropagate();
        this._dom = saved;
        if (!ok) {
          this._dom[r][c] &= ~(1 << v);
          changed = true;
          if (this._dom[r][c] === 0) return { changed, ok: false };
        }
      }
    }
    return { changed, ok: true };
  }
  // Two-tier deduction driver. Tier-1 GAC to fixpoint, then a Tier-2 bifurcation
  // pass, repeating while anything changed. `budget` (ms, 0 = use existing
  // deadline) bounds the heavy passes.
  _deduceAll(budget) {
    if (budget > 0) this._deadline = Date.now() + budget;
    for (;;) {
      if (!this._gacPropagate()) return false;
      if (this._bifurcationDisabled) return true;
      if (this._deadline && Date.now() > this._deadline) return true;
      const bif = this._bifurcate();
      if (!bif.ok) return false;
      if (!bif.changed) return true;
    }
  }
  // Propagation-only result (no search): the determined board (UNK where open).
  _deduceOnly() {
    this._initDomains();
    const ok = this._deduceAll(0);
    return { ok, cells: this._boardFromDomains() };
  }

  solve() {
    this._startedAt = Date.now();
    this._initDomains();
    // Size-gate: large boards get a short budget so they return a strong GAC+bounded-
    // bifurcation partial fast; small/medium boards get the full maxMs and solve.
    const cells = this.rows * this.cols;
    const big = cells > this._heavyMaxCells;
    const budget = big ? Math.min(this.maxMs || this._lightBudgetMs, this._lightBudgetMs) : (this.maxMs || 0);
    this._deadline = budget > 0 ? Date.now() + budget : 0;
    // _deadline set BEFORE _deduceAll(0) so the root bifurcation is itself bounded.
    if (!this._deduceAll(0)) return { solved: false, cells: null, error: 'no solution' };
    const partial = () => ({ solved: false, cells: this._boardFromDomains(), partial: true, error: 'time limit exceeded' });
    const search = () => {
      if ((this.maxMs > 0 && timeUp(this.maxMs, this._startedAt)) ||
          (this._deadline && Date.now() > this._deadline)) throw 'BUDGET';
      // pick most-constrained open cell (smallest domain > 1)
      let best = null, bestN = 99;
      for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) {
        if (this.task[r][c] !== -1) continue;
        const d = this._dom[r][c], n = popcount(d);
        if (n > 1 && n < bestN) { bestN = n; best = [r, c]; }
      }
      if (!best) { const b = this._boardFromDomains(); return this._isValid(b) ? b : null; }
      const [r, c] = best; const dom = this._dom[r][c];
      const snapshot = this._dom.map(row => row.slice());
      for (let v = 0; v <= 4; v++) if (dom & (1 << v)) {
        this._dom = snapshot.map(row => row.slice());
        this._dom[r][c] = (1 << v);
        if (this._deduceAll(0)) { const sol = search(); if (sol) return sol; }
      }
      this._dom = snapshot;
      return null;
    };
    try {
      const sol = search();
      if (sol) return { solved: true, cells: sol };
      return { solved: false, cells: null, error: 'no solution' };
    } catch (e) {
      if (e === 'BUDGET') return partial();
      throw e;
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ShakashakaSolver };
}
