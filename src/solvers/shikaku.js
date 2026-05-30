'use strict';

const { hashFNV1a, lruSet } = require('./shared.js');

// ShikakuSolver — pure logic for Shikaku rectangle partitioning.
//
// Per-clue enumerate rectangle candidates (axis-aligned, correct area, no
// other clue inside, fits grid); single-candidate forcing + most-constrained
// backtracking. `getHint` runs propagation → forward-checking →
// solve-and-reveal. Static `_solutionCache` keyed on FNV-1a of
// `(rows, cols, clues sorted)`, 50-entry LRU.
//
// See `src/widget/puzzles/shikaku.js` for the page encoding, the area-shape
// contract the page mutates, and preview/loop-done-check details.

class ShikakuSolver {
  /**
   * @param {{
   *   rows: number,
   *   cols: number,
   *   clues: Array<{ row: number, col: number, area: number }>,
   *   initialState?: number[][],
   * }} opts
   */
  constructor({ rows, cols, clues, initialState }) {
    if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows <= 0 || cols <= 0) {
      throw new Error('ShikakuSolver: rows/cols must be positive integers');
    }
    if (!Array.isArray(clues)) {
      throw new Error('ShikakuSolver: clues must be an array');
    }
    const sum = clues.reduce((s, c) => s + (c.area | 0), 0);
    if (sum !== rows * cols) {
      throw new Error(`ShikakuSolver: clue area sum ${sum} must equal grid area ${rows * cols}`);
    }
    this.rows = rows;
    this.cols = cols;
    this.clues = clues.map(c => ({ row: c.row | 0, col: c.col | 0, area: c.area | 0 }));

    this.clueByCell = new Int16Array(rows * cols).fill(-1);
    for (let i = 0; i < this.clues.length; i++) {
      const k = this.clues[i];
      this.clueByCell[k.row * cols + k.col] = i;
    }

    this.owner = new Int16Array(rows * cols).fill(-1);
    for (let i = 0; i < this.clues.length; i++) {
      const k = this.clues[i];
      this.owner[k.row * cols + k.col] = i;
    }

    this.placed = new Uint8Array(this.clues.length);
    this.candidates = this.clues.map((_, i) => this._enumerateCandidates(i));
    this.trail = [];

    if (initialState) {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const v = initialState[r]?.[c];
          if (Number.isInteger(v) && v >= 0 && v < this.clues.length) {
            this.owner[r * cols + c] = v;
          }
        }
      }
    }
  }

  _enumerateCandidates(clueIdx) {
    const k = this.clues[clueIdx];
    const R = this.rows, C = this.cols;
    const out = [];
    for (let h = 1; h <= k.area; h++) {
      if (k.area % h !== 0) continue;
      const w = k.area / h;
      for (let r1 = Math.max(0, k.row - h + 1); r1 <= k.row; r1++) {
        const r2 = r1 + h - 1;
        if (r2 >= R) continue;
        for (let c1 = Math.max(0, k.col - w + 1); c1 <= k.col; c1++) {
          const c2 = c1 + w - 1;
          if (c2 >= C) continue;
          let otherClueInside = false;
          for (let r = r1; r <= r2 && !otherClueInside; r++) {
            for (let c = c1; c <= c2; c++) {
              const cellClue = this.clueByCell[r * C + c];
              if (cellClue !== -1 && cellClue !== clueIdx) {
                otherClueInside = true;
                break;
              }
            }
          }
          if (!otherClueInside) out.push({ r1, c1, r2, c2 });
        }
      }
    }
    return out;
  }

  // Iterate the propagation rules until no rule changes anything. Returns
  // false on contradiction (any clue's candidate set becomes empty).
  propagate() {
    let changed = true;
    while (changed) {
      changed = false;
      // 1. Zero-candidate detection.
      for (let i = 0; i < this.clues.length; i++) {
        if (!this.placed[i] && this.candidates[i].length === 0) return false;
      }
      // 2. Single-candidate forcing — place the rectangle, prune neighbours.
      for (let i = 0; i < this.clues.length; i++) {
        if (this.placed[i]) continue;
        if (this.candidates[i].length === 1) {
          if (!this._placeRectangle(i, this.candidates[i][0])) return false;
          changed = true;
        }
      }
    }
    return true;
  }

  // Place clue `i`'s rectangle. Marks every cell owned, prunes overlapping
  // candidates from other clues, sets placed[i] = 1. Returns false on a
  // cell-ownership conflict.
  _placeRectangle(clueIdx, rect) {
    const C = this.cols;
    for (let r = rect.r1; r <= rect.r2; r++) {
      for (let c = rect.c1; c <= rect.c2; c++) {
        const idx = r * C + c;
        const cur = this.owner[idx];
        if (cur !== -1 && cur !== clueIdx) return false;
        if (cur === -1) this._assign(idx, clueIdx);
      }
    }
    this._setPlaced(clueIdx, 1);
    this._setCandidates(clueIdx, [rect]);
    for (let j = 0; j < this.clues.length; j++) {
      if (j === clueIdx || this.placed[j]) continue;
      const filtered = this.candidates[j].filter(r2 => !_rectsOverlap(rect, r2));
      if (filtered.length !== this.candidates[j].length) {
        this._setCandidates(j, filtered);
      }
    }
    return true;
  }

  // ── Trail-based undo. Frame kinds: 0=cell-assign, 1=placed, 2=candidates.
  _assign(idx, value) {
    this.trail.push({ kind: 0, idx, old: this.owner[idx] });
    this.owner[idx] = value;
  }
  _setPlaced(clueIdx, value) {
    this.trail.push({ kind: 1, clueIdx, old: this.placed[clueIdx] });
    this.placed[clueIdx] = value;
  }
  _setCandidates(clueIdx, newList) {
    this.trail.push({ kind: 2, clueIdx, old: this.candidates[clueIdx] });
    this.candidates[clueIdx] = newList;
  }
  _rollback(mark) {
    while (this.trail.length > mark) {
      const e = this.trail.pop();
      if (e.kind === 0) this.owner[e.idx] = e.old;
      else if (e.kind === 1) this.placed[e.clueIdx] = e.old;
      else this.candidates[e.clueIdx] = e.old;
    }
  }

  static _solutionCache = new Map();
  static _maxSolutionCache = 50;

  static clearSolutionCache() {
    ShikakuSolver._solutionCache.clear();
  }

  _cacheKey() {
    return String(hashFNV1a((mix) => {
      mix(this.rows);
      mix(this.cols);
      mix(this.clues.length);
      const sorted = this.clues.slice().sort((a, b) =>
        a.row - b.row || a.col - b.col || a.area - b.area);
      for (const k of sorted) {
        mix(k.row); mix(k.col); mix(k.area);
      }
    }, false));
  }

  _storeInCache(key, grid) {
    const m = ShikakuSolver._solutionCache;
    lruSet(m, ShikakuSolver._maxSolutionCache, key, grid.map(row => row.slice()));
  }

  solve() {
    const key = this._cacheKey();
    const cached = ShikakuSolver._solutionCache.get(key);
    if (cached) return { solved: true, grid: cached.map(row => row.slice()) };

    if (!this.propagate()) {
      return { solved: false, grid: null, error: 'contradiction on initial propagation' };
    }
    if (this._isComplete()) {
      const grid = this._ownerTo2D();
      this._storeInCache(key, grid);
      return { solved: true, grid };
    }
    if (this._backtrack()) {
      const grid = this._ownerTo2D();
      this._storeInCache(key, grid);
      return { solved: true, grid };
    }
    return { solved: false, grid: null, error: 'no solution found' };
  }

  _isComplete() {
    for (let i = 0; i < this.clues.length; i++) {
      if (!this.placed[i]) return false;
    }
    return true;
  }

  _ownerTo2D() {
    const out = [];
    for (let r = 0; r < this.rows; r++) {
      const row = new Array(this.cols);
      for (let c = 0; c < this.cols; c++) row[c] = this.owner[r * this.cols + c];
      out[r] = row;
    }
    return out;
  }

  _backtrack() {
    // MRV: pick the unplaced clue with the fewest remaining candidates.
    let target = -1;
    let bestCount = Infinity;
    for (let i = 0; i < this.clues.length; i++) {
      if (this.placed[i]) continue;
      const n = this.candidates[i].length;
      if (n < bestCount) { bestCount = n; target = i; }
    }
    if (target === -1) return this._isComplete();
    const cands = this.candidates[target].slice();
    for (const rect of cands) {
      const mark = this.trail.length;
      if (this._placeRectangle(target, rect) && this.propagate()) {
        if (this._isComplete() || this._backtrack()) return true;
      }
      this._rollback(mark);
    }
    return false;
  }

  /**
   * Reveal one complete rectangle. A Shikaku hint is "draw the rectangle
   * around this number", so the hint covers every cell of one clue's
   * rectangle — the clue's own number cell included.
   *
   * Real Shikaku puzzles have a unique solution, so the rectangle's shape
   * is certain; we solve from the clues alone (NOT from `currentGrid`,
   * whose owner ids are page-assigned and need not match our clue
   * indices) and consult `currentGrid` only to skip rectangles the player
   * has already drawn. Returns the first not-yet-drawn rectangle as a
   * row-anchored hint shape compatible with content.js, or null when the
   * board is already complete or the puzzle is unsolvable.
   * @param {number[][]} currentGrid  2D of cell owners (or -1 for undrawn).
   */
  getHint(currentGrid) {
    const solved = new ShikakuSolver({
      rows: this.rows, cols: this.cols, clues: this.clues,
    }).solve();
    if (!solved.solved) return null;
    const sol = solved.grid;

    const isDrawn = (r, c) => {
      const row = currentGrid && currentGrid[r];
      const v = row ? row[c] : -1;
      return Number.isInteger(v) && v >= 0;
    };

    for (let ci = 0; ci < this.clues.length; ci++) {
      const cells2d = [];
      let hasUndrawn = false;
      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) {
          if (sol[r][c] === ci) {
            cells2d.push({ row: r, col: c, value: ci });
            if (!isDrawn(r, c)) hasUndrawn = true;
          }
        }
      }
      if (!hasUndrawn || cells2d.length === 0) continue;

      const base = cells2d[0];
      const cells = [];
      const extraCells = [];
      for (const f of cells2d) {
        if (f.row === base.row) cells.push({ index: f.col, value: f.value });
        else extraCells.push({ row: f.row, col: f.col, value: f.value });
      }
      return {
        type: 'row',
        index: base.row,
        clue: {
          row: this.clues[ci].row,
          col: this.clues[ci].col,
          area: this.clues[ci].area,
        },
        cells,
        extraCells,
        count: cells2d.length,
      };
    }
    return null;
  }
}

function _rectsOverlap(a, b) {
  return !(a.r2 < b.r1 || b.r2 < a.r1 || a.c2 < b.c1 || b.c2 < a.c1);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ShikakuSolver };
}
