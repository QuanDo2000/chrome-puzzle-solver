'use strict';

const { hashFNV1a, emitGrid, cloneSolveResult, timeUp, lruSet } = require('./shared.js');

class KakurasuSolver {
  constructor(data) {
    const { rows, cols, rowClues, colClues, initialState, maxMs } = data;
    this.rows = rows;
    this.cols = cols;
    this.rowClues = new Int32Array(rows);
    for (let r = 0; r < rows; r++) this.rowClues[r] = rowClues[r];
    this.colClues = new Int32Array(cols);
    for (let c = 0; c < cols; c++) this.colClues[c] = colClues[c];
    this.cellStatus = new Uint8Array(rows * cols);
    if (initialState) {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          this.cellStatus[r * cols + c] = initialState[r][c];
        }
      }
    }
    this.cellTrail = [];
    this.maskTrail = [];
    this._depth = 0;
    this._inLookahead = false;
    this.maxMs = maxMs || 0;
    this._buildMaskDomains();
    this._startedAt = 0;
  }

  _buildMaskDomains() {
    this.rowMasksActive = new Array(this.rows);
    for (let r = 0; r < this.rows; r++) {
      const target = this.rowClues[r];
      const masks = [];
      const limit = 1 << this.cols;
      for (let m = 0; m < limit; m++) {
        let sum = 0;
        for (let c = 0; c < this.cols; c++) {
          if (m & (1 << c)) sum += (c + 1);
        }
        if (sum === target) masks.push(m);
      }
      this.rowMasksActive[r] = masks;
    }
    this.colMasksActive = new Array(this.cols);
    for (let c = 0; c < this.cols; c++) {
      const target = this.colClues[c];
      const masks = [];
      const limit = 1 << this.rows;
      for (let m = 0; m < limit; m++) {
        let sum = 0;
        for (let r = 0; r < this.rows; r++) {
          if (m & (1 << r)) sum += (r + 1);
        }
        if (sum === target) masks.push(m);
      }
      this.colMasksActive[c] = masks;
    }
  }

  _set(idx, value) {
    const old = this.cellStatus[idx];
    if (old === value) return true;
    if (old !== 0) return false;
    this.cellTrail.push(idx | (old << 24));
    this.cellStatus[idx] = value;
    return true;
  }

  _rollback(cellMark, maskMark) {
    while (this.cellTrail.length > cellMark) {
      const e = this.cellTrail.pop();
      const i = e & 0xffffff;
      const old = (e >>> 24) & 0xff;
      this.cellStatus[i] = old;
    }
    while (this.maskTrail.length > maskMark) {
      const { axis, lineIdx, mask } = this.maskTrail.pop();
      if (axis === 0) this.rowMasksActive[lineIdx].push(mask);
      else this.colMasksActive[lineIdx].push(mask);
    }
  }

  _narrowLine(axis, lineIdx, active) {
    const kept = [];
    for (let i = 0; i < active.length; i++) {
      const m = active[i];
      let ok = true;
      if (axis === 0) {
        const r = lineIdx;
        for (let c = 0; c < this.cols; c++) {
          const cs = this.cellStatus[r * this.cols + c];
          const bit = (m >> c) & 1;
          if (cs === 1 && !bit) { ok = false; break; }
          if (cs === 2 && bit)  { ok = false; break; }
        }
      } else {
        const c = lineIdx;
        for (let r = 0; r < this.rows; r++) {
          const cs = this.cellStatus[r * this.cols + c];
          const bit = (m >> r) & 1;
          if (cs === 1 && !bit) { ok = false; break; }
          if (cs === 2 && bit)  { ok = false; break; }
        }
      }
      if (ok) kept.push(m);
      else this.maskTrail.push({ axis, lineIdx, mask: m });
    }
    return kept;
  }

  _applyLines() {
    for (let r = 0; r < this.rows; r++) {
      const before = this.rowMasksActive[r];
      if (before.length === 0) return false;
      const active = this._narrowLine(0, r, before);
      this.rowMasksActive[r] = active;
      if (active.length === 0) return false;
      let inter = active[0], union = active[0];
      for (let i = 1; i < active.length; i++) {
        inter &= active[i];
        union |= active[i];
      }
      for (let c = 0; c < this.cols; c++) {
        const bitMask = 1 << c;
        const idx = r * this.cols + c;
        if ((inter & bitMask) && this.cellStatus[idx] === 0) {
          if (!this._set(idx, 1)) return false;
        } else if (!(union & bitMask) && this.cellStatus[idx] === 0) {
          if (!this._set(idx, 2)) return false;
        }
      }
    }
    for (let c = 0; c < this.cols; c++) {
      const before = this.colMasksActive[c];
      if (before.length === 0) return false;
      const active = this._narrowLine(1, c, before);
      this.colMasksActive[c] = active;
      if (active.length === 0) return false;
      let inter = active[0], union = active[0];
      for (let i = 1; i < active.length; i++) {
        inter &= active[i];
        union |= active[i];
      }
      for (let r = 0; r < this.rows; r++) {
        const bitMask = 1 << r;
        const idx = r * this.cols + c;
        if ((inter & bitMask) && this.cellStatus[idx] === 0) {
          if (!this._set(idx, 1)) return false;
        } else if (!(union & bitMask) && this.cellStatus[idx] === 0) {
          if (!this._set(idx, 2)) return false;
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
      const cm = this.cellTrail.length;
      if (!this._applyLines()) return false;
      if (this.cellTrail.length > cm) changed = true;
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
          const cm = this.cellTrail.length;
          const mm = this.maskTrail.length;
          this._inLookahead = true;
          const okSet = this._set(i, v);
          const ok = okSet && this._propagate();
          this._rollback(cm, mm);
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
    let bestIdx = -1, bestScore = -Infinity;
    const total = this.rows * this.cols;
    for (let i = 0; i < total; i++) {
      if (this.cellStatus[i] !== 0) continue;
      const r = (i / this.cols) | 0, c = i - r * this.cols;
      const rn = this.rowMasksActive[r].length;
      const cn = this.colMasksActive[c].length;
      const score = 1 / (rn + 1) + 1 / (cn + 1);
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
      const cm = this.cellTrail.length, mm = this.maskTrail.length;
      if (this._set(idx, v) && this._propagate() && this._backtrack()) {
        this._depth--;
        return true;
      }
      this._rollback(cm, mm);
      if (this._timeUp()) break;
    }
    this._depth--;
    return false;
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
    this.cellTrail = [];
    this.maskTrail = [];
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

    // Rebuild mask domains from current state so narrowing starts fresh.
    this._buildMaskDomains();

    // Per-row narrowing+forcing — stop at first row that yields a change.
    for (let r = 0; r < this.rows; r++) {
      const active = this._narrowLine(0, r, this.rowMasksActive[r]);
      this.rowMasksActive[r] = active;
      if (active.length === 0) return null;
      let inter = active[0], union = active[0];
      for (let i = 1; i < active.length; i++) {
        inter &= active[i];
        union |= active[i];
      }
      let changed = false;
      for (let c = 0; c < this.cols; c++) {
        const bitMask = 1 << c;
        const idx = r * this.cols + c;
        if ((inter & bitMask) && this.cellStatus[idx] === 0) {
          if (!this._set(idx, 1)) return null;
          changed = true;
        } else if (!(union & bitMask) && this.cellStatus[idx] === 0) {
          if (!this._set(idx, 2)) return null;
          changed = true;
        }
      }
      if (changed) {
        const h = collectChanged();
        if (h.length) return h;
      }
    }

    // Per-col narrowing+forcing — stop at first col that yields a change.
    for (let c = 0; c < this.cols; c++) {
      const active = this._narrowLine(1, c, this.colMasksActive[c]);
      this.colMasksActive[c] = active;
      if (active.length === 0) return null;
      let inter = active[0], union = active[0];
      for (let i = 1; i < active.length; i++) {
        inter &= active[i];
        union |= active[i];
      }
      let changed = false;
      for (let r = 0; r < this.rows; r++) {
        const bitMask = 1 << r;
        const idx = r * this.cols + c;
        if ((inter & bitMask) && this.cellStatus[idx] === 0) {
          if (!this._set(idx, 1)) return null;
          changed = true;
        } else if (!(union & bitMask) && this.cellStatus[idx] === 0) {
          if (!this._set(idx, 2)) return null;
          changed = true;
        }
      }
      if (changed) {
        const h = collectChanged();
        if (h.length) return h;
      }
    }

    // Single lookahead probe.
    for (let i = 0; i < total; i++) {
      if (this.cellStatus[i] !== 0) continue;
      const survivors = [];
      for (const v of [1, 2]) {
        const cm = this.cellTrail.length, mm = this.maskTrail.length;
        this._inLookahead = true;
        const okSet = this._set(i, v);
        const ok = okSet && this._propagate();
        this._rollback(cm, mm);
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

  solve() {
    const key = this._cacheKey();
    const cached = KakurasuSolver._solutionCache.get(key)
                || KakurasuSolver._partialCache.get(key);
    if (cached) return this._cloneResult(cached);
    this._startedAt = Date.now();
    let result;
    if (!this._propagate()) {
      this._rollback(0, 0);
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
    KakurasuSolver._solutionCache.clear();
    KakurasuSolver._partialCache.clear();
  }

  _cacheKey() {
    return hashFNV1a((mix) => {
      mix(this.rows); mix(this.cols);
      for (let r = 0; r < this.rows; r++) mix(this.rowClues[r]);
      for (let c = 0; c < this.cols; c++) mix(this.colClues[c]);
    });
  }

  _cloneResult(r) {
    return cloneSolveResult(r);
  }

  _storeInCache(key, result) {
    const m = result.partial ? KakurasuSolver._partialCache : KakurasuSolver._solutionCache;
    const max = result.partial ? KakurasuSolver._maxPartialCache : KakurasuSolver._maxSolutionCache;
    lruSet(m, max, key, this._cloneResult(result));
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { KakurasuSolver };
}
