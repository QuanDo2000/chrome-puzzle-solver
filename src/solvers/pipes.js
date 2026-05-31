'use strict';

// Pipes (Net) rotation-puzzle solver. task[r][c] is a 4-bit arm mask in the
// page's given orientation; solving picks a rotation per cell so every arm meets
// a neighbour's arm, nothing points off-board (unless wrap), and all armed cells
// form one connected network. Internal convention: N=1, E=2, S=4, W=8. The
// solver is mapping-agnostic — it only matches "my arm on side X meets the
// neighbour's arm on the opposite side" — so it need not know the page's labels.

const { timeUp } = require('./shared.js');

const N = 1, E = 2, S = 4, W = 8;

class PipesSolver {
  // One clockwise quarter-turn moves each set bit N->E->S->W->N.
  static rotateCW(mask, k) {
    let m = mask & 0xF;
    const turns = ((k % 4) + 4) % 4;
    for (let t = 0; t < turns; t++) {
      m = ((m << 1) | (m >> 3)) & 0xF;
    }
    return m;
  }

  // The distinct rotation masks of a piece, in rotation order [k=0,1,2,3] but
  // de-duplicated while preserving the smallest k for each distinct mask.
  static candidates(mask) {
    const seen = new Set();
    const out = [];
    for (let k = 0; k < 4; k++) {
      const m = PipesSolver.rotateCW(mask, k);
      if (!seen.has(m)) { seen.add(m); out.push(m); }
    }
    return out;
  }

  constructor({ rows, cols, task, wrap = false, maxMs = 0 }) {
    this.rows = rows;
    this.cols = cols;
    this.task = task;
    this.wrap = !!wrap;
    this.maxMs = maxMs;
    this._startedAt = 0;
  }

  // neighbour index on a side, honouring wrap; returns -1 if off-board (non-wrap).
  _nb(r, c, side) {
    const { rows, cols, wrap } = this;
    if (side === N) { const nr = r - 1; if (nr < 0) return wrap ? (rows-1)*cols + c : -1; return nr*cols + c; }
    if (side === S) { const nr = r + 1; if (nr >= rows) return wrap ? c : -1; return nr*cols + c; }
    if (side === W) { const nc = c - 1; if (nc < 0) return wrap ? r*cols + (cols-1) : -1; return r*cols + nc; }
    /* E */          { const nc = c + 1; if (nc >= cols) return wrap ? r*cols : -1; return r*cols + nc; }
  }

  solve() {
    this._startedAt = Date.now();
    const { rows, cols } = this;
    const total = rows * cols;
    const cand = new Array(total);
    for (let i = 0; i < total; i++) cand[i] = PipesSolver.candidates(this.task[(i/cols)|0][i%cols]);

    const opp = { [N]: S, [S]: N, [E]: W, [W]: E };
    const sides = [N, E, S, W];

    const propagate = (queue) => {
      while (queue.length) {
        const i = queue.pop();
        const r = (i/cols)|0, c = i%cols;
        let masks = cand[i];
        if (!this.wrap) {
          const filtered = masks.filter(m =>
            !((m & N) && r === 0) && !((m & S) && r === rows-1) &&
            !((m & W) && c === 0) && !((m & E) && c === cols-1));
          if (filtered.length !== masks.length) { cand[i] = masks = filtered; }
        }
        if (masks.length === 0) return false;
        for (const s of sides) {
          const j = this._nb(r, c, s);
          if (j < 0) continue;
          const iHasArm = masks.some(m => m & s);
          const iAllArm = masks.every(m => m & s);
          let want;
          if (iAllArm) want = true; else if (!iHasArm) want = false; else continue;
          const before = cand[j].length;
          cand[j] = cand[j].filter(m => (!!(m & opp[s])) === want);
          if (cand[j].length === 0) return false;
          if (cand[j].length !== before) queue.push(j);
        }
      }
      return true;
    };

    if (!propagate(Array.from({ length: total }, (_, i) => i))) {
      return { solved: false, grid: null, error: 'contradiction on initial propagation' };
    }

    const assign = new Array(total).fill(-1);
    const solveFrom = () => {
      if (this.maxMs > 0 && timeUp(this.maxMs, this._startedAt)) return null;
      let best = -1, bestLen = Infinity;
      for (let i = 0; i < total; i++) {
        if (assign[i] !== -1) continue;
        const len = cand[i].length;
        if (len === 1) { assign[i] = cand[i][0]; continue; }
        if (len < bestLen) { bestLen = len; best = i; }
      }
      if (best === -1) {
        for (let i = 0; i < total; i++) if (assign[i] === -1) assign[i] = cand[i][0];
        if (!this._connectedAssignment(assign)) { return null; }
        const grid = [];
        for (let r = 0; r < rows; r++) { const row = []; for (let c = 0; c < cols; c++) row.push(assign[r*cols+c]); grid.push(row); }
        return grid;
      }
      for (const m of cand[best]) {
        const snapshot = cand.map(a => a.slice());
        const savedAssign = assign.slice();
        cand[best] = [m];
        if (propagate([best])) {
          const got = solveFrom();
          if (got) return got;
        }
        for (let i = 0; i < total; i++) { cand[i] = snapshot[i]; assign[i] = savedAssign[i]; }
      }
      return null;
    };

    const grid = solveFrom();
    if (!grid) {
      return { solved: false, grid: null, error: this.maxMs > 0 && timeUp(this.maxMs, this._startedAt) ? 'time limit exceeded' : 'no solution' };
    }
    return { solved: true, grid };
  }

  _connectedAssignment(assign) {
    const { rows, cols } = this;
    const total = rows * cols;
    const armed = [];
    for (let i = 0; i < total; i++) if (assign[i]) armed.push(i);
    if (armed.length === 0) return true;
    const seen = new Uint8Array(total);
    seen[armed[0]] = 1;
    const st = [armed[0]];
    let cnt = 1;
    const sides = [N, E, S, W];
    const opp = { [N]: S, [S]: N, [E]: W, [W]: E };
    while (st.length) {
      const i = st.pop(), r = (i/cols)|0, c = i%cols, m = assign[i];
      for (const s of sides) {
        if (!(m & s)) continue;
        const j = this._nb(r, c, s);
        if (j < 0) continue;
        if (!(assign[j] & opp[s])) continue;
        if (!seen[j]) { seen[j] = 1; cnt++; st.push(j); }
      }
    }
    return cnt === armed.length;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PipesSolver };
}
