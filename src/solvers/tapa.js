'use strict';

// TapaSolver — pure logic, no DOM.
//
// PAGE ENCODING (recon, ground truth — getErrors is a REAL oracle, ported here):
//   task[r][c]: -1 shadeable; >=0 clue (decimal digits = run lengths, never shaded); -2 "B"
//   clue (never shaded, no count). cellStatus 0 unknown / 1 shaded / 2 not-shaded. Clue cells
//   are NOT tracked in cellStatus (the page renders them).
//
// RULES (getErrors): (1) no 2x2 fully shaded; (2) all shaded cells form one orthogonal
// component; (3) each clue cell's shaded-neighbour run pattern (getNeighbourCount) matches the
// clue: build an 8-dir bitmask of shaded neighbours (off-grid = unshaded); if not all-8, rotate
// until bit0 is a gap (cyclic wrap); count maximal runs; sort ascending; join; loose-== clue.
//
// METHOD: per clue, enumerate the <=256 neighbour bitmasks whose run-string matches; arc-consistency
// propagation (clue-pattern intersection + no-2x2) to a fixpoint; backtrack on the most-constrained
// clue's undecided neighbour; a connectivity-feasibility prune (every shaded cell must stay reachable
// through shaded-or-unknown cells) at each node; sound partial = root snapshot on timeout.
// Brute-force-gated in tests/tapa.test.js. VALUE-SPACE (mirrors Nurikabe): solve() returns grid
// 0 unknown / 1 shaded / 2 not-shaded.
//
// PERFORMANCE (large boards, e.g. 35x35 monthly): the working grid `g` is a flat Int8Array;
// search backtracks via a trail (record changed cells, restore to 9) instead of cloning the grid;
// propagation is a DIRTY WORKLIST (only re-check clues / 2x2 windows whose cells changed — seeded
// from each _set) rather than a full rescan; connectivity reuses a stamped scratch array (no
// per-node allocation). 35x35 monthly: ~20x faster than the naive version (well under a second).

const DR = [-1, -1, -1, 0, 1, 1, 1, 0];
const DC = [-1, 0, 1, 1, 1, 0, -1, -1];

// Run-string of an 8-bit shaded-neighbour mask (ported getNeighbourCount): rotate a gap to bit0
// (unless all-8), count runs, sort ascending, join.
function tapaRunString(mask) {
  let l = mask;
  if (l !== 255) while (l & 1) l = ((l >> 1) | (l << 7)) & 0xff;
  const runs = []; let s = 0;
  for (let i = 0; i < 8; i++) { if (l & (1 << i)) s++; else { if (s) runs.push(s); s = 0; } }
  if (s) runs.push(s);
  runs.sort();
  return runs.join('');
}

class TapaSolver {
  constructor({ rows, cols, task, maxMs = 30000 }) {
    this.rows = rows; this.cols = cols; this.task = task; this.maxMs = maxMs;
    this.shadeable = (r, c) => r >= 0 && c >= 0 && r < rows && c < cols && task[r][c] === -1;
    // per numeric clue (>=0): valid neighbour bitmasks + flat neighbour indices (-1 = not shadeable)
    this.clues = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (task[r][c] >= 0) {
      let forbidden = 0;
      for (let a = 0; a < 8; a++) if (!this.shadeable(r + DR[a], c + DC[a])) forbidden |= 1 << a;
      const patterns = [];
      for (let m = 0; m < 256; m++) {
        if (m & forbidden) continue;
        /* eslint-disable-next-line eqeqeq */
        if (tapaRunString(m) == task[r][c]) patterns.push(m);
      }
      const nbrIdx = Array.from({ length: 8 }, (_, a) => { const h = r + DR[a], n = c + DC[a]; return this.shadeable(h, n) ? h * cols + n : -1; });
      this.clues.push({ r, c, patterns, nbrIdx });
    }
    // cell -> clue indices that include it (dirty-worklist propagation)
    this.cellClues = Array.from({ length: rows * cols }, () => []);
    for (let i = 0; i < this.clues.length; i++) for (const idx of this.clues[i].nbrIdx) if (idx >= 0) this.cellClues[idx].push(i);
    // cell -> top-left indices of the 2x2 windows containing it
    this.cell2x2 = Array.from({ length: rows * cols }, () => []);
    for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++) { const tl = r * cols + c; for (const ix of [tl, tl + 1, tl + cols, tl + cols + 1]) this.cell2x2[ix].push(tl); }
    this._cstamp = new Int32Array(rows * cols); this._cgen = 0;     // stamped connectivity scratch
    this._inCq = new Uint8Array(this.clues.length);                // clue-in-queue flags
  }

  // Oracle (ported getErrors) on a complete shaded boolean grid (shaded[r][c] === 1 iff shaded).
  _isValid(shaded) {
    const { rows, cols, task } = this;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (task[r][c] !== -1 && shaded[r][c]) return false; // clue cell shaded
    for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++) if (shaded[r][c] && shaded[r][c + 1] && shaded[r + 1][c] && shaded[r + 1][c + 1]) return false; // 2x2
    for (const cl of this.clues) { // clue run-strings
      let mask = 0; for (let a = 0; a < 8; a++) { const idx = cl.nbrIdx[a]; if (idx >= 0 && shaded[(idx / cols) | 0][idx % cols]) mask |= 1 << a; }
      /* eslint-disable-next-line eqeqeq */
      if (!(tapaRunString(mask) == task[cl.r][cl.c])) return false;
    }
    const cells = []; for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (shaded[r][c]) cells.push(r * cols + c);
    if (cells.length > 1) { // one orthogonal component
      const seen = new Set([cells[0]]); const stack = [cells[0]];
      while (stack.length) { const id = stack.pop(); const r = (id / cols) | 0, c = id % cols; for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) { const h = r + dr, n = c + dc; if (h >= 0 && n >= 0 && h < rows && n < cols && shaded[h][n] && !seen.has(h * cols + n)) { seen.add(h * cols + n); stack.push(h * cols + n); } } }
      if (seen.size !== cells.length) return false;
    }
    return true;
  }

  // Flat working grid: 9 unknown, 0 unshaded, 1 shaded. Clue cells fixed 0. Seeds the dirty
  // worklist with all clues so the first _propagate() does the full root arc-consistency.
  _initG() {
    this.g = new Int8Array(this.rows * this.cols);
    for (let i = 0; i < this.g.length; i++) this.g[i] = this.task[(i / this.cols) | 0][i % this.cols] === -1 ? 9 : 0;
    this.trail = []; this._cw = []; this._cq = []; this._inCq.fill(0);
    for (let ci = 0; ci < this.clues.length; ci++) this._enqClue(ci);
  }

  // Set flat cell idx to val (1/0). Returns false on a conflicting prior value. Records the change
  // on the trail (for backtracking) and on the cell-worklist (for incremental propagation).
  _set(idx, val) {
    if (this.g[idx] === val) return true;
    if (this.g[idx] !== 9) return false;
    this.g[idx] = val; this.trail.push(idx); this._cw.push(idx);
    return true;
  }

  _rollback(mark) { const t = this.trail; while (t.length > mark) this.g[t.pop()] = 9; }
  _enqClue(ci) { if (!this._inCq[ci]) { this._inCq[ci] = 1; this._cq.push(ci); } }
  _clearWork() { this._cw.length = 0; for (const ci of this._cq) this._inCq[ci] = 0; this._cq.length = 0; }

  // Arc-consistency for one clue: drop patterns inconsistent with decided neighbours; contradiction
  // if none survive; force a neighbour direction agreed by all survivors. Forced cells go via _set.
  _acClue(ci) {
    const cl = this.clues[ci], ok = [];
    for (const m of cl.patterns) { let good = true; for (let a = 0; a < 8; a++) { const idx = cl.nbrIdx[a]; if (idx < 0) continue; const want = (m >> a) & 1, cur = this.g[idx]; if ((cur === 1 && !want) || (cur === 0 && want)) { good = false; break; } } if (good) ok.push(m); }
    if (!ok.length) return false;
    for (let a = 0; a < 8; a++) { const idx = cl.nbrIdx[a]; if (idx < 0 || this.g[idx] !== 9) continue; let all1 = true, all0 = true; for (const m of ok) { if ((m >> a) & 1) all0 = false; else all1 = false; } if (all1) { if (!this._set(idx, 1)) return false; } else if (all0) { if (!this._set(idx, 0)) return false; } }
    return true;
  }

  // no-2x2 around a changed cell: a 2x2 with 4 shaded is a contradiction; 3 shaded + 1 unknown
  // forces the unknown unshaded.
  _check2x2(idx) {
    for (const tl of this.cell2x2[idx]) {
      const i0 = tl, i1 = tl + 1, i2 = tl + this.cols, i3 = i2 + 1;
      let sh = 0, unk = 0, uc = -1;
      for (const ix of [i0, i1, i2, i3]) { if (this.g[ix] === 1) sh++; else if (this.g[ix] === 9) { unk++; uc = ix; } }
      if (sh === 4) return false;
      if (sh === 3 && unk === 1) { if (!this._set(uc, 0)) return false; }
    }
    return true;
  }

  // Dirty-worklist propagation to a fixpoint. Drains changed cells (enqueue their clues + check
  // their 2x2 windows) and dirty clues (arc-consistency). Clears the worklist on contradiction.
  _propagate() {
    while (this._cw.length || this._cq.length) {
      while (this._cw.length) {
        const idx = this._cw.pop();
        const cc = this.cellClues[idx]; for (let k = 0; k < cc.length; k++) this._enqClue(cc[k]);
        if (!this._check2x2(idx)) { this._clearWork(); return false; }
      }
      if (this._cq.length) {
        const ci = this._cq.pop(); this._inCq[ci] = 0;
        if (!this._acClue(ci)) { this._clearWork(); return false; }
      }
    }
    return true;
  }

  // emit in the Nurikabe value-space: 0 unknown, 1 shaded, 2 not-shaded (clue cells -> 2).
  _emit() { const out = []; for (let r = 0; r < this.rows; r++) { out.push([]); for (let c = 0; c < this.cols; c++) { if (this.task[r][c] !== -1) { out[r].push(2); continue; } const v = this.g[r * this.cols + c]; out[r].push(v === 9 ? 0 : v === 1 ? 1 : 2); } } return out; }
  _shaded() { const sh = []; for (let r = 0; r < this.rows; r++) { sh.push([]); for (let c = 0; c < this.cols; c++) sh[r].push(this.g[r * this.cols + c] === 1 ? 1 : 0); } return sh; }

  // Connectivity-feasibility prune: every definitely-shaded (1) cell must still be reachable from
  // the others through {shaded ∪ unknown} cells. A definitely-unshaded (0) cell can never become
  // shaded, so if it splits the shaded region the branch can never satisfy the single-group rule.
  // Uses a stamped scratch array (generation counter) so no per-node allocation/clearing is needed.
  _connectFeasible() {
    const { rows, cols } = this, g = this.g;
    let first = -1, nsh = 0;
    for (let i = 0; i < g.length; i++) if (g[i] === 1) { if (first < 0) first = i; nsh++; }
    if (nsh <= 1) return true;
    const stamp = this._cstamp, gen = ++this._cgen, st = [first]; stamp[first] = gen; let reach = 0;
    while (st.length) {
      const id = st.pop(), r = (id / cols) | 0, c = id % cols;
      if (g[id] === 1) reach++;
      if (r > 0) { const n = id - cols; if (stamp[n] !== gen && (g[n] === 1 || g[n] === 9)) { stamp[n] = gen; st.push(n); } }
      if (r < rows - 1) { const n = id + cols; if (stamp[n] !== gen && (g[n] === 1 || g[n] === 9)) { stamp[n] = gen; st.push(n); } }
      if (c > 0) { const n = id - 1; if (stamp[n] !== gen && (g[n] === 1 || g[n] === 9)) { stamp[n] = gen; st.push(n); } }
      if (c < cols - 1) { const n = id + 1; if (stamp[n] !== gen && (g[n] === 1 || g[n] === 9)) { stamp[n] = gen; st.push(n); } }
    }
    return reach === nsh;
  }

  // Branch on the most-constrained clue (fewest surviving valid patterns >1) with an undecided
  // neighbour — its first undecided neighbour (flat idx). Falls back to the first undecided cell.
  _pick() {
    let best = null, bestN = Infinity;
    for (const cl of this.clues) {
      let cnt = 0, hasUnk = false;
      for (const m of cl.patterns) { let ok = true; for (let a = 0; a < 8; a++) { const idx = cl.nbrIdx[a]; if (idx < 0) continue; const want = (m >> a) & 1, cur = this.g[idx]; if ((cur === 1 && !want) || (cur === 0 && want)) { ok = false; break; } } if (ok) cnt++; }
      for (let a = 0; a < 8; a++) { const idx = cl.nbrIdx[a]; if (idx >= 0 && this.g[idx] === 9) { hasUnk = true; break; } }
      if (hasUnk && cnt > 1 && cnt < bestN) { bestN = cnt; best = cl; }
    }
    if (best) { for (let a = 0; a < 8; a++) { const idx = best.nbrIdx[a]; if (idx >= 0 && this.g[idx] === 9) return idx; } }
    for (let i = 0; i < this.g.length; i++) if (this.task[(i / this.cols) | 0][i % this.cols] === -1 && this.g[i] === 9) return i;
    return -1;
  }

  _search(countAll) {
    if (Date.now() > this._deadline) { this._timedOut = true; return true; }
    if (!this._connectFeasible()) return false;
    const idx = this._pick();
    if (idx < 0) { const sh = this._shaded(); if (this._isValid(sh)) { this._count++; if (!this._first) this._first = this.g.slice(); if (!countAll) return true; if (this._count >= 2) return true; } return false; }
    for (const val of [1, 0]) {
      const mark = this.trail.length;
      if (this._set(idx, val) && this._propagate() && this._search(countAll)) { if (!countAll || this._count >= 2 || this._timedOut) return true; }
      this._rollback(mark); this._clearWork();
    }
    return false;
  }

  solve(countAll = false) {
    this._initG();
    this._deadline = Date.now() + this.maxMs; this._timedOut = false; this._count = 0; this._first = null;
    for (const cl of this.clues) if (!cl.patterns.length) return { solved: false, error: 'No solution (a clue has no satisfiable pattern)' };
    if (!this._propagate()) return { solved: false, error: 'No solution (contradiction in givens)' };
    const root = this._emit();
    this._search(countAll);
    if (this._first) { this.g = this._first; return { solved: true, grid: this._emit(), count: this._count }; }
    if (this._timedOut) return { solved: false, partial: true, grid: root };
    return { solved: false, error: 'No solution found' };
  }

  // Hint engine. initialState = live cellStatus (0 unknown / 1 shaded / 2 not-shaded). Clue cells
  // are 0 in cellStatus (the page doesn't track them) — _initG fixes them not-shaded (g=0) so the
  // propagation can't target clue cells and Loop never terminates ([[project_clue_cells_not_in_cellstatus]]).
  // Returns the newly-forced shadeable cells as { row, col, value(1 shaded / 2 not-shaded) }.
  getHint(initialState) {
    this._initG();
    const cols = this.cols;
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < cols; c++) if (this.task[r][c] === -1) {
      const v = initialState[r] ? initialState[r][c] : 0;
      if (v === 1) { if (!this._set(r * cols + c, 1)) return []; }
      else if (v === 2) { if (!this._set(r * cols + c, 0)) return []; }
    }
    this._deadline = Date.now() + (this.maxMs || 1500);
    if (!this._propagate()) return [];
    const out = [];
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < cols; c++) {
      if (this.task[r][c] !== -1) continue;
      const was = initialState[r] ? initialState[r][c] : 0;
      if (was !== 0) continue; // only newly-decided
      const g = this.g[r * cols + c];
      if (g === 1) out.push({ row: r, col: c, value: 1 });
      else if (g === 0) out.push({ row: r, col: c, value: 2 });
    }
    return out;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TapaSolver, tapaRunString };
}
