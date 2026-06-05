'use strict';

// Masyu (loop) solver — pure logic, no DOM.
//
// PAGE ENCODING (recon, ground truth)
//   task[r][c]:  "W" white pearl · "B" black pearl · -1 empty
//   loop edges:  cellHorizontalStatus H = rows x (cols-1)  (H[r][c] joins (r,c)-(r,c+1))
//                cellVerticalStatus   V = (rows-1) x cols  (V[r][c] joins (r,c)-(r+1,c))
//                tri-state: 0 unknown · 1 line · 2 cross.  The loop runs through CELL CENTRES.
//
// VALIDITY (ported from the page getErrors; see the plan doc):
//   (1) every cell degree 0 or 2; (2) all line-edges form ONE connected cycle (no sub-loops);
//   (3) white pearl: straight through AND turns in >=1 adjacent cell;
//   (4) black pearl: turns AND both arms go straight one more cell; (5) every pearl on the loop.
//
// METHOD: degree+pearl propagation, failed-literal edge & pearl-orientation probing, and
// reachability/connectivity forcing (all to a fixpoint), then loop-extension DFS. On maxMs
// timeout returns the SOUND root-deduction snapshot. Soundness is brute-force-gated in
// tests/masyu.test.js. Real 25x25-hard returns a sound partial (~16.5%) — full solve of a
// 25x25 is not achievable (the global-connectivity ceiling, same as Shingoki).

class MasyuSolver {
  constructor({ task, rows, cols, maxMs = 30000 } = {}) {
    this.task = task;
    this.rows = typeof rows === 'number' ? rows : task.length;
    this.cols = typeof cols === 'number' ? cols : (task[0] ? task[0].length : 0);
    this.maxMs = maxMs;
    this.useProbe = true;
    this.probeMs = maxMs;
  }

  _inH(r, c) { return r >= 0 && r < this.rows && c >= 0 && c < this.cols - 1; }
  _inV(r, c) { return r >= 0 && r < this.rows - 1 && c >= 0 && c < this.cols; }
  // current working value; out-of-range reads as cross (2).
  _get(t, r, c) { return t === 'h' ? (this._inH(r, c) ? this.H[r][c] : 2) : (this._inV(r, c) ? this.V[r][c] : 2); }
  // set an edge; returns false on conflict (already a different non-zero value).
  _set(t, r, c, v) {
    if (t === 'h') { if (!this._inH(r, c)) return v === 2; if (this.H[r][c] === v) return true; if (this.H[r][c] !== 0) return false; this.H[r][c] = v; this._dirty = true; return true; }
    if (!this._inV(r, c)) return v === 2; if (this.V[r][c] === v) return true; if (this.V[r][c] !== 0) return false; this.V[r][c] = v; this._dirty = true; return true;
  }
  // incident edges [type,r,c,inRange] for left,right,top,bottom of cell (r,c)
  _incident(r, c) {
    return [['h', r, c - 1, this._inH(r, c - 1)], ['h', r, c, this._inH(r, c)],
            ['v', r - 1, c, this._inV(r - 1, c)], ['v', r, c, this._inV(r, c)]];
  }
  _deg(r, c) { let d = 0; if (this._get('h', r, c - 1) === 1) d++; if (this._get('h', r, c) === 1) d++; if (this._get('v', r - 1, c) === 1) d++; if (this._get('v', r, c) === 1) d++; return d; }

  // Full-board validity oracle (port of getErrors). H/V are complete (no 0).
  _isValid(H, V) {
    const { rows, cols, task } = this;
    const line = (r, c, t) => t === 'h'
      ? (r >= 0 && r < rows && c >= 0 && c < cols - 1 && H[r][c] === 1)
      : (r >= 0 && r < rows - 1 && c >= 0 && c < cols && V[r][c] === 1);
    const deg = (r, c) => { let d = 0; if (line(r, c - 1, 'h')) d++; if (line(r, c, 'h')) d++; if (line(r - 1, c, 'v')) d++; if (line(r, c, 'v')) d++; return d; };
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const d = deg(r, c); if (d === 1 || d > 2) return false; }
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const t = task[r][c]; if (t !== 'W' && t !== 'B') continue;
      const hl = line(r, c - 1, 'h'), hr = line(r, c, 'h'), vt = line(r - 1, c, 'v'), vb = line(r, c, 'v');
      if (((hl?1:0)+(hr?1:0)+(vt?1:0)+(vb?1:0)) !== 2) return false;
      if (t === 'W') {
        const straight = (hl && hr && !vt && !vb) || (vt && vb && !hl && !hr);
        if (!straight) return false;
        if ((line(r,c-2,'h')&&line(r,c-1,'h')&&line(r,c,'h')&&line(r,c+1,'h')) ||
            (line(r-2,c,'v')&&line(r-1,c,'v')&&line(r,c,'v')&&line(r+1,c,'v'))) return false;
      } else {
        const turn = ((hl||hr)&&(vt||vb)&&!(hl&&hr)&&!(vt&&vb));
        if (!turn) return false;
        if ((line(r,c,'h')&&line(r-1,c+1,'v')) || (line(r,c,'h')&&line(r,c+1,'v')) ||
            (line(r,c-1,'h')&&line(r-1,c-1,'v')) || (line(r,c-1,'h')&&line(r,c-1,'v')) ||
            (line(r,c,'v')&&line(r+1,c,'h')) || (line(r,c,'v')&&line(r+1,c-1,'h')) ||
            (line(r-1,c,'v')&&line(r-1,c,'h')) || (line(r-1,c,'v')&&line(r-1,c-1,'h'))) return false;
      }
    }
    // single connected loop
    const idx = (r, c) => r * cols + c;
    const loopCells = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (deg(r, c) === 2) loopCells.push([r, c]);
    if (loopCells.length === 0) { for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (task[r][c]==='W'||task[r][c]==='B') return false; return true; }
    const neigh = (r, c) => { const o = []; if (line(r,c-1,'h')) o.push([r,c-1]); if (line(r,c,'h')) o.push([r,c+1]); if (line(r-1,c,'v')) o.push([r-1,c]); if (line(r,c,'v')) o.push([r+1,c]); return o; };
    const seen = new Set(); const st = [loopCells[0]]; seen.add(idx(loopCells[0][0], loopCells[0][1]));
    while (st.length) { const [r, c] = st.pop(); for (const [nr, nc] of neigh(r, c)) { const k = idx(nr, nc); if (!seen.has(k)) { seen.add(k); st.push([nr, nc]); } } }
    return seen.size === loopCells.length;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MasyuSolver };
}
