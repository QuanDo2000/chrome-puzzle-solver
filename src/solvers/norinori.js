'use strict';

const { hashFNV1a, emitGrid, cloneSolveResult, timeUp, lruSet } = require('./shared.js');

// NorinoriSolver — pure logic for Norinori as enforced on puzzles-mobile.com
// (NOT textbook Norinori). See `src/widget/puzzles/norinori.js` for the
// rules-of-the-site and the cross-region domino allowance.
//
// === Propagation rules (fixpoint of four rules) ===
//
// - `_applyRegionCount` — region nB>2 → contradiction; nB+nU<2 →
//   contradiction; nB=2 → other unknowns forced WHITE; nB+nU=2 → both
//   unknowns forced BLACK.
// - `_apply2x2` — any 2×2 with nB>2 → contradiction; nB=2 with unknowns →
//   unknowns forced WHITE.
// - `_apply3InRow` — any 3-cell horizontal or vertical line with nB=3 →
//   contradiction; nB=2 with the third cell unknown → forced WHITE.
// - `_applyNeighborConstraints` — black with >1 black neighbour →
//   contradiction (L or 3-in-row); black with 1 black neighbour → other
//   neighbours forced WHITE; black with 0 black neighbours and 0 unknown
//   neighbours → contradiction (solo); black with 0 black neighbours and
//   exactly 1 unknown neighbour → that neighbour forced BLACK.
//
// `_set` is a plain trail-record assign — **no cascade**. After local rules
// stall, at top-level only (`_depth === 0`, `_inLookahead` re-entry guard)
// runs 1-step lookahead. Most-constrained variable for backtracking
// prefers cells with the most KNOWN neighbours (more local constraints =
// higher score).
//
// Don't reintroduce `dominoCandidates`, `_applyDominoes` (per-region
// domino enumeration), or `_applyCrossRegionDominate` — those encoded the
// textbook rule that the site does not enforce, and they make the 30×30
// daily provably unsolvable.
//
// Static `_solutionCache` keyed on FNV-1a of `(rows, cols, cellToRoom[])`,
// 50-entry LRU; 20-entry partial LRU. Worker `maxMs=30s`.

class NorinoriSolver {
  constructor(data) {
    const { rows, cols, rooms, initialState, maxMs } = data;
    this.rows = rows;
    this.cols = cols;
    this.K = rooms.length;
    this.cellToRoom = new Int32Array(rows * cols).fill(-1);
    this.roomCells = new Array(this.K);
    for (let k = 0; k < this.K; k++) {
      const cells = rooms[k].cells;
      const arr = new Int32Array(cells.length);
      for (let i = 0; i < cells.length; i++) {
        const idx = cells[i].r * cols + cells[i].c;
        arr[i] = idx;
        this.cellToRoom[idx] = k;
      }
      this.roomCells[k] = arr;
    }
    this.cellStatus = new Uint8Array(rows * cols);
    if (initialState) {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          this.cellStatus[r * cols + c] = initialState[r][c];
        }
      }
    }
    this.trail = [];
    this._depth = 0;
    this._inLookahead = false;
    this.maxMs = maxMs || 0;
    this._startedAt = 0;
  }

  // Rules enforced (per puzzles-mobile.com's getErrors): each region has
  // exactly 2 black cells; no 3-in-row of blacks; no 2x2 with 3+ blacks;
  // every black has at least one black neighbor (no solo). These imply
  // blacks form dominoes that may span regions.
  _set(idx, value) {
    const old = this.cellStatus[idx];
    if (old === value) return true;
    if (old !== 0) return false;
    this.trail.push(idx | (old << 24));
    this.cellStatus[idx] = value;
    return true;
  }

  _rollback(mark) {
    while (this.trail.length > mark) {
      const e = this.trail.pop();
      const i = e & 0xffffff;
      const old = (e >>> 24) & 0xff;
      this.cellStatus[i] = old;
    }
  }

  _applyRegionCount() {
    for (let k = 0; k < this.K; k++) {
      const cells = this.roomCells[k];
      let nB = 0, nU = 0;
      for (let i = 0; i < cells.length; i++) {
        const v = this.cellStatus[cells[i]];
        if (v === 1) nB++;
        else if (v === 0) nU++;
      }
      if (nB > 2) return false;
      if (nB + nU < 2) return false;
      if (nB === 2) {
        for (let i = 0; i < cells.length; i++) {
          if (this.cellStatus[cells[i]] === 0) {
            if (!this._set(cells[i], 2)) return false;
          }
        }
      } else if (nB + nU === 2) {
        for (let i = 0; i < cells.length; i++) {
          if (this.cellStatus[cells[i]] === 0) {
            if (!this._set(cells[i], 1)) return false;
          }
        }
      }
    }
    return true;
  }

  _apply2x2() {
    for (let r = 0; r + 1 < this.rows; r++) {
      for (let c = 0; c + 1 < this.cols; c++) {
        const a = r * this.cols + c;
        const cells = [a, a + 1, a + this.cols, a + this.cols + 1];
        let nB = 0, nU = 0;
        for (let i = 0; i < 4; i++) {
          const v = this.cellStatus[cells[i]];
          if (v === 1) nB++;
          else if (v === 0) nU++;
        }
        if (nB > 2) return false;
        if (nB === 2 && nU > 0) {
          for (let i = 0; i < 4; i++) {
            if (this.cellStatus[cells[i]] === 0) {
              if (!this._set(cells[i], 2)) return false;
            }
          }
        }
      }
    }
    return true;
  }

  _apply3InRow() {
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c + 2 < this.cols; c++) {
        const a = r * this.cols + c;
        const cells = [a, a + 1, a + 2];
        let nB = 0, nU = 0;
        for (let i = 0; i < 3; i++) {
          const v = this.cellStatus[cells[i]];
          if (v === 1) nB++;
          else if (v === 0) nU++;
        }
        if (nB === 3) return false;
        if (nB === 2 && nU > 0) {
          for (let i = 0; i < 3; i++) {
            if (this.cellStatus[cells[i]] === 0) {
              if (!this._set(cells[i], 2)) return false;
            }
          }
        }
      }
    }
    for (let c = 0; c < this.cols; c++) {
      for (let r = 0; r + 2 < this.rows; r++) {
        const a = r * this.cols + c;
        const cells = [a, a + this.cols, a + 2 * this.cols];
        let nB = 0, nU = 0;
        for (let i = 0; i < 3; i++) {
          const v = this.cellStatus[cells[i]];
          if (v === 1) nB++;
          else if (v === 0) nU++;
        }
        if (nB === 3) return false;
        if (nB === 2 && nU > 0) {
          for (let i = 0; i < 3; i++) {
            if (this.cellStatus[cells[i]] === 0) {
              if (!this._set(cells[i], 2)) return false;
            }
          }
        }
      }
    }
    return true;
  }

  _applyNeighborConstraints() {
    const total = this.rows * this.cols;
    for (let i = 0; i < total; i++) {
      if (this.cellStatus[i] !== 1) continue;
      const r = (i / this.cols) | 0;
      const c = i - r * this.cols;
      const ns = [];
      if (r > 0) ns.push(i - this.cols);
      if (r < this.rows - 1) ns.push(i + this.cols);
      if (c > 0) ns.push(i - 1);
      if (c < this.cols - 1) ns.push(i + 1);
      let nB = 0, nU = 0, uIdx = -1;
      for (let j = 0; j < ns.length; j++) {
        const nv = this.cellStatus[ns[j]];
        if (nv === 1) nB++;
        else if (nv === 0) { nU++; uIdx = ns[j]; }
      }
      if (nB > 1) return false;
      if (nB === 1) {
        for (let j = 0; j < ns.length; j++) {
          if (this.cellStatus[ns[j]] === 0) {
            if (!this._set(ns[j], 2)) return false;
          }
        }
      } else {
        if (nU === 0) return false;
        if (nU === 1) {
          if (!this._set(uIdx, 1)) return false;
        }
      }
    }
    return true;
  }

  _timeUp() {
    return timeUp(this.maxMs, this._startedAt);
  }

  _propagate() {
    let changed = true;
    while (changed) {
      if (this._timeUp()) return true;
      changed = false;
      const mark = this.trail.length;
      if (!this._applyRegionCount()) return false;
      if (!this._apply2x2()) return false;
      if (!this._apply3InRow()) return false;
      if (!this._applyNeighborConstraints()) return false;
      if (this.trail.length > mark) changed = true;
    }
    if (this._depth === 0 && !this._inLookahead) {
      if (!this._applyLookahead()) return false;
    }
    return true;
  }

  _applyLookahead() {
    const total = this.rows * this.cols;
    let changed = true;
    while (changed) {
      if (this._timeUp()) return true;
      changed = false;
      for (let i = 0; i < total; i++) {
        if (this.cellStatus[i] !== 0) continue;
        const survivors = [];
        for (const v of [1, 2]) {
          const mark = this.trail.length;
          this._inLookahead = true;
          this._depth++;
          const okSet = this._set(i, v);
          const ok = okSet && this._propagate();
          this._depth--;
          this._rollback(mark);
          this._inLookahead = false;
          if (ok) survivors.push(v);
          if (survivors.length > 1) break;
        }
        if (survivors.length === 0) return false;
        if (survivors.length === 1) {
          if (!this._set(i, survivors[0])) return false;
          if (!this._propagate()) return false;
          changed = true;
        }
      }
    }
    return true;
  }

  _isComplete() {
    for (let i = 0; i < this.rows * this.cols; i++) {
      if (this.cellStatus[i] === 0) return false;
    }
    return true;
  }

  _emit() {
    return emitGrid(this.cellStatus, this.rows, this.cols);
  }

  _pickBestUnknown() {
    let bestIdx = -1, bestScore = -1;
    const total = this.rows * this.cols;
    for (let i = 0; i < total; i++) {
      if (this.cellStatus[i] !== 0) continue;
      const r = (i / this.cols) | 0;
      const c = i - r * this.cols;
      let score = 0;
      if (r > 0 && this.cellStatus[i - this.cols] !== 0) score++;
      if (r < this.rows - 1 && this.cellStatus[i + this.cols] !== 0) score++;
      if (c > 0 && this.cellStatus[i - 1] !== 0) score++;
      if (c < this.cols - 1 && this.cellStatus[i + 1] !== 0) score++;
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }
    return bestIdx;
  }

  _backtrack() {
    if (this._timeUp()) return false;
    const idx = this._pickBestUnknown();
    if (idx < 0) return this._isComplete();
    this._depth++;
    for (const v of [1, 2]) {
      const mark = this.trail.length;
      if (this._set(idx, v) && this._propagate() && this._backtrack()) {
        this._depth--;
        return true;
      }
      this._rollback(mark);
      if (this._timeUp()) break;
    }
    this._depth--;
    return false;
  }

  solve() {
    const key = this._cacheKey();
    const cached = NorinoriSolver._solutionCache.get(key)
                || NorinoriSolver._partialCache.get(key);
    if (cached) return this._cloneResult(cached);
    this._startedAt = Date.now();
    let result;
    if (!this._propagate()) {
      this._rollback(0);
      result = { solved: false, grid: null };
    } else if (this._isComplete()) {
      result = { solved: true, grid: this._emit() };
    } else if (this._backtrack()) {
      result = { solved: true, grid: this._emit() };
    } else {
      const partial = this._emit();
      result = this._timeUp()
        ? { solved: false, grid: partial, error: 'timed out', partial: true }
        : { solved: false, grid: null };
    }
    if (result.solved || result.partial) this._storeInCache(key, result);
    return result;
  }

  static _solutionCache = new Map();
  static _maxSolutionCache = 50;
  static _partialCache = new Map();
  static _maxPartialCache = 20;
  static clearSolutionCache() {
    NorinoriSolver._solutionCache.clear();
    NorinoriSolver._partialCache.clear();
  }

  _cacheKey() {
    return hashFNV1a((mix) => {
      mix(this.rows); mix(this.cols); mix(this.K);
      for (let i = 0; i < this.rows * this.cols; i++) mix(this.cellToRoom[i]);
    });
  }

  _cloneResult(r) {
    return cloneSolveResult(r);
  }

  getHint(initialState) {
    const total = this.rows * this.cols;
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        this.cellStatus[r * this.cols + c] = initialState[r][c];
      }
    }
    const before = new Uint8Array(total);
    for (let i = 0; i < total; i++) before[i] = this.cellStatus[i];
    this.trail = [];
    this._depth = 0;
    this._inLookahead = false;
    this._startedAt = Date.now();

    const collectChanged = () => {
      const out = [];
      for (let i = 0; i < total; i++) {
        if (before[i] === 0 && this.cellStatus[i] !== 0) {
          const r = (i / this.cols) | 0;
          const c = i - r * this.cols;
          out.push({ row: r, col: c, value: this.cellStatus[i] });
        }
      }
      return out;
    };

    if (!this._applyRegionCount()) return null;
    {
      const h = collectChanged();
      if (h.length) return h;
    }
    if (!this._apply2x2()) return null;
    {
      const h = collectChanged();
      if (h.length) return h;
    }
    if (!this._apply3InRow()) return null;
    {
      const h = collectChanged();
      if (h.length) return h;
    }
    if (!this._applyNeighborConstraints()) return null;
    {
      const h = collectChanged();
      if (h.length) return h;
    }

    // Single lookahead probe.
    for (let i = 0; i < total; i++) {
      if (this.cellStatus[i] !== 0) continue;
      const survivors = [];
      for (const v of [1, 2]) {
        const mark = this.trail.length;
        this._inLookahead = true;
        const okSet = this._set(i, v);
        const ok = okSet && this._propagate();
        this._rollback(mark);
        this._inLookahead = false;
        if (ok) survivors.push(v);
        if (survivors.length > 1) break;
      }
      if (survivors.length === 0) return null;
      if (survivors.length === 1) {
        if (!this._set(i, survivors[0])) return null;
        const h = collectChanged();
        if (h.length) return h;
      }
    }
    return null;
  }

  _storeInCache(key, result) {
    const m = result.partial ? NorinoriSolver._partialCache : NorinoriSolver._solutionCache;
    const max = result.partial ? NorinoriSolver._maxPartialCache : NorinoriSolver._maxSolutionCache;
    lruSet(m, max, key, this._cloneResult(result));
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { NorinoriSolver };
}
