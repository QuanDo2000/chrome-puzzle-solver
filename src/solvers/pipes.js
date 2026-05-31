'use strict';

// Pipes (Net) rotation-puzzle solver. task[r][c] is a 4-bit arm mask in the
// page's given orientation; solving picks a rotation per cell so every arm meets
// a neighbour's arm, nothing points off-board (unless wrap), and all armed cells
// form one connected network. Internal convention: N=1, E=2, S=4, W=8. The
// solver is mapping-agnostic — it only matches "my arm on side X meets the
// neighbour's arm on the opposite side" — so it need not know the page's labels.

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
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PipesSolver };
}
