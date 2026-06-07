'use strict';

// ThermometersSolver — pure logic, no DOM.
//
// PAGE ENCODING (recon, getErrors is a NO-OP stub -> the oracle below IS the rule, brute-force-gated
// in tests/thermometers.test.js):
//   Game.areaPoints[t] = ordered cell list, INDEX 0 = bulb, last = tip (the page builds it bulb-first
//   per direction). Game.task = column clues (0..cols-1) then row clues. cellStatus 0 unknown /
//   1 filled (mercury) / 2 empty. A solve registers when cellStatus==1 on exactly the filled cells.
//
// RULE: per thermometer the filled cells are a contiguous prefix from the bulb; each row/col has its
//   exact clued count of filled cells.
//
// MODEL: thermometer t has cells thermos[t] (bulb->tip, {r,c}) and a fill level in [lo[t], hi[t]]
//   (hi exclusive upper bound, 0..len); cell i is filled iff i < level. The prefix rule is intrinsic.
//   Only the count rule is propagated, via CONTRIBUTION-BOUND propagation: in a line with clue K,
//   bound each thermometer's contribution by K minus the other thermometers' minimum/maximum
//   contributions, tightening lo/hi. This alone fully solves real 15x15 boards (1 node). Search
//   (most-constrained thermometer, snapshot/restore of the small lo/hi arrays) is the fallback.

class ThermometersSolver {
  constructor({ rows, cols, thermos, colClue, rowClue, maxMs = 30000 }) {
    this.rows = rows; this.cols = cols; this.thermos = thermos;
    this.colClue = colClue; this.rowClue = rowClue; this.maxMs = maxMs;
    this.T = thermos.length;
    this.len = thermos.map((t) => t.length);
    // Per-line groups: for each row/col, { t, idxs } where idxs = sorted thermo-indices of that
    // thermometer's cells lying in the line (a horizontal thermometer contributes several to its row).
    const rowG = []; const colG = [];
    for (let r = 0; r < rows; r++) rowG.push(new Map());
    for (let c = 0; c < cols; c++) colG.push(new Map());
    for (let t = 0; t < this.T; t++) for (let i = 0; i < thermos[t].length; i++) {
      const cell = thermos[t][i], r = cell.r, c = cell.c;
      if (!rowG[r].has(t)) rowG[r].set(t, []); rowG[r].get(t).push(i);
      if (!colG[c].has(t)) colG[c].set(t, []); colG[c].get(t).push(i);
    }
    const toGroups = (m) => { const out = []; for (const [t, idxs] of m) { idxs.sort((a, b) => a - b); out.push({ t, idxs }); } return out; };
    this.rowGroups = rowG.map(toGroups);
    this.colGroups = colG.map(toGroups);
  }

  // count of idxs strictly below `level` (idxs ascending).
  _contrib(idxs, level) { let n = 0; for (let k = 0; k < idxs.length; k++) { if (idxs[k] < level) n++; else break; } return n; }

  // Contribution-bound propagation for one line. Returns -1 on contradiction, else number of changes.
  _lineProp(groups, clue) {
    const n = groups.length;
    if (!n) return clue === 0 ? 0 : -1;
    const cMin = new Array(n), cMax = new Array(n);
    let minTotal = 0, maxTotal = 0;
    for (let g = 0; g < n; g++) { cMin[g] = this._contrib(groups[g].idxs, this.lo[groups[g].t]); cMax[g] = this._contrib(groups[g].idxs, this.hi[groups[g].t]); minTotal += cMin[g]; maxTotal += cMax[g]; }
    if (minTotal > clue || maxTotal < clue) return -1;
    let changed = 0;
    for (let g = 0; g < n; g++) {
      const t = groups[g].t, idxs = groups[g].idxs;
      const allowedMax = clue - (minTotal - cMin[g]); // cap on this thermo's contribution to the line
      const allowedMin = clue - (maxTotal - cMax[g]); // floor on this thermo's contribution
      if (allowedMax < cMax[g]) { const m = allowedMax < 0 ? 0 : allowedMax; const newHi = m < idxs.length ? idxs[m] : this.hi[t]; if (newHi < this.hi[t]) { this.hi[t] = newHi; changed++; } }
      if (allowedMin > cMin[g]) { const m = allowedMin; const newLo = (m >= 1 && m - 1 < idxs.length) ? idxs[m - 1] + 1 : this.lo[t]; if (newLo > this.lo[t]) { this.lo[t] = newLo; changed++; } }
      if (this.lo[t] > this.hi[t]) return -1;
    }
    return changed;
  }

  _propagate() {
    let changed = true;
    while (changed) {
      changed = false;
      for (let r = 0; r < this.rows; r++) { const k = this._lineProp(this.rowGroups[r], this.rowClue[r]); if (k < 0) return false; if (k) changed = true; }
      for (let c = 0; c < this.cols; c++) { const k = this._lineProp(this.colGroups[c], this.colClue[c]); if (k < 0) return false; if (k) changed = true; }
    }
    return true;
  }

  // grid from a complete level assignment: 1 filled / 2 empty.
  _emitLevels(levels) {
    const out = []; for (let r = 0; r < this.rows; r++) out.push(new Array(this.cols).fill(0));
    for (let t = 0; t < this.T; t++) for (let i = 0; i < this.thermos[t].length; i++) { const cell = this.thermos[t][i]; out[cell.r][cell.c] = i < levels[t] ? 1 : 2; }
    return out;
  }

  // partial grid from current bounds: decided cells 1/2, undecided 0.
  _emitBounds() {
    const out = []; for (let r = 0; r < this.rows; r++) out.push(new Array(this.cols).fill(0));
    for (let t = 0; t < this.T; t++) for (let i = 0; i < this.thermos[t].length; i++) { const cell = this.thermos[t][i]; out[cell.r][cell.c] = i < this.lo[t] ? 1 : (i >= this.hi[t] ? 2 : 0); }
    return out;
  }

  // Oracle on a fill grid (truthy = filled): prefix rule + exact row/col counts.
  _isValid(fill) {
    for (let t = 0; t < this.T; t++) { let empty = false; for (let i = 0; i < this.thermos[t].length; i++) { const cell = this.thermos[t][i]; if (fill[cell.r][cell.c]) { if (empty) return false; } else empty = true; } }
    const rc = new Array(this.rows).fill(0), cc = new Array(this.cols).fill(0);
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) if (fill[r][c]) { rc[r]++; cc[c]++; }
    for (let r = 0; r < this.rows; r++) if (rc[r] !== this.rowClue[r]) return false;
    for (let c = 0; c < this.cols; c++) if (cc[c] !== this.colClue[c]) return false;
    return true;
  }

  _search(countAll) {
    if (Date.now() > this._deadline) { this._timedOut = true; return true; }
    const sLo = this.lo.slice(), sHi = this.hi.slice();
    if (!this._propagate()) { this.lo = sLo; this.hi = sHi; return false; }
    let best = -1, bw = Infinity;
    for (let t = 0; t < this.T; t++) { const w = this.hi[t] - this.lo[t]; if (w > 0 && w < bw) { bw = w; best = t; } }
    if (best === -1) {
      const fill = this._emitLevels(this.lo).map((row) => row.map((v) => (v === 1 ? 1 : 0)));
      if (this._isValid(fill)) { this._count++; if (!this._first) this._first = this.lo.slice(); }
      this.lo = sLo; this.hi = sHi; return this._count >= (countAll ? 2 : 1);
    }
    for (let v = this.lo[best]; v <= this.hi[best]; v++) {
      const bLo = this.lo.slice(), bHi = this.hi.slice();
      this.lo[best] = v; this.hi[best] = v;
      this._search(countAll);
      this.lo = bLo; this.hi = bHi;
      if (this._timedOut || this._count >= (countAll ? 2 : 1)) break;
    }
    this.lo = sLo; this.hi = sHi; return this._count >= (countAll ? 2 : 1);
  }

  solve(countAll = false) {
    this.lo = new Array(this.T).fill(0); this.hi = this.len.slice();
    this._deadline = Date.now() + this.maxMs; this._timedOut = false; this._count = 0; this._first = null;
    if (!this._propagate()) return { solved: false, error: 'No solution (contradiction in givens)' };
    const root = this._emitBounds();
    this._search(countAll);
    if (this._first) return { solved: true, grid: this._emitLevels(this._first), count: this._count };
    if (this._timedOut) return { solved: false, partial: true, grid: root };
    return { solved: false, error: 'No solution found' };
  }

  // Hint engine. initialState = live cellStatus (0 unknown / 1 filled / 2 empty). Seeds bounds from
  // it, propagates, returns newly-decided cells { row, col, value(1 filled / 2 empty) }.
  getHint(initialState) {
    this.lo = new Array(this.T).fill(0); this.hi = this.len.slice();
    for (let t = 0; t < this.T; t++) {
      for (let i = 0; i < this.thermos[t].length; i++) {
        const cell = this.thermos[t][i];
        const v = (initialState[cell.r] && initialState[cell.r][cell.c] !== undefined) ? initialState[cell.r][cell.c] : 0;
        if (v === 1) { if (i + 1 > this.lo[t]) this.lo[t] = i + 1; }   // filled -> level >= i+1
        else if (v === 2) { if (i < this.hi[t]) this.hi[t] = i; }      // empty -> level <= i
      }
      if (this.lo[t] > this.hi[t]) return [];
    }
    this._deadline = Date.now() + (this.maxMs || 1500);
    if (!this._propagate()) return [];
    const out = [];
    for (let t = 0; t < this.T; t++) {
      for (let i = 0; i < this.thermos[t].length; i++) {
        const cell = this.thermos[t][i];
        const was = (initialState[cell.r] && initialState[cell.r][cell.c] !== undefined) ? initialState[cell.r][cell.c] : 0;
        if (was !== 0) continue;
        const nv = i < this.lo[t] ? 1 : (i >= this.hi[t] ? 2 : 0);
        if (nv !== 0) out.push({ row: cell.r, col: cell.c, value: nv });
      }
    }
    return out;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ThermometersSolver };
}
