'use strict';
const { timeUp } = require('./shared.js');

const UNK = 9; // undecided open cell

class ShakashakaSolver {
  constructor({ task, maxMs = 0 }) {
    this.task = task;
    this.rows = task.length;
    this.cols = task[0].length;
    this.maxMs = maxMs;
    this._startedAt = 0;
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
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ShakashakaSolver };
}
