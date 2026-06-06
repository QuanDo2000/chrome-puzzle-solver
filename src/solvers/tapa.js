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
// METHOD: per clue, enumerate the <=256 neighbour bitmasks whose run-string matches; AC propagation
// (clue-pattern intersection + no-2x2) to a fixpoint; backtrack on the first undecided shadeable
// cell; connectivity checked at each complete leaf; sound partial = root snapshot on timeout.
// Brute-force-gated in tests/tapa.test.js.
//
// VALUE-SPACE (mirrors Nurikabe): solve() returns grid 0 unknown / 1 shaded / 2 not-shaded.

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
  constructor({ rows, cols, task, maxMs = 30000 } = {}) {
    this.rows = rows; this.cols = cols; this.task = task; this.maxMs = maxMs;
    this.shadeable = (r, c) => r >= 0 && c >= 0 && r < rows && c < cols && task[r][c] === -1;
    // per numeric clue (>=0): valid neighbour bitmasks
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
      this.clues.push({ r, c, patterns, nbr: Array.from({ length: 8 }, (_, a) => [r + DR[a], c + DC[a]]) });
    }
  }

  _initG() {
    // g: 9 unknown, 0 unshaded, 1 shaded. Clue cells fixed 0 (never shaded).
    this.g = [];
    for (let r = 0; r < this.rows; r++) { this.g.push([]); for (let c = 0; c < this.cols; c++) this.g[r].push(this.task[r][c] === -1 ? 9 : 0); }
  }

  // clue-pattern arc-consistency + no-2x2, to a fixpoint. Returns false on contradiction.
  _propagate() {
    const { rows, cols } = this;
    let dirty = true;
    while (dirty) {
      dirty = false;
      for (const cl of this.clues) {
        const ok = [];
        for (const m of cl.patterns) {
          let good = true;
          for (let a = 0; a < 8; a++) { const [h, n] = cl.nbr[a]; if (!this.shadeable(h, n)) continue; const want = (m >> a) & 1; const cur = this.g[h][n]; if ((cur === 1 && !want) || (cur === 0 && want)) { good = false; break; } }
          if (good) ok.push(m);
        }
        if (!ok.length) return false;
        for (let a = 0; a < 8; a++) { const [h, n] = cl.nbr[a]; if (!this.shadeable(h, n) || this.g[h][n] !== 9) continue; let all1 = true, all0 = true; for (const m of ok) { if ((m >> a) & 1) all0 = false; else all1 = false; } if (all1) { this.g[h][n] = 1; dirty = true; } else if (all0) { this.g[h][n] = 0; dirty = true; } }
      }
      for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++) {
        const q = [[r, c], [r, c + 1], [r + 1, c], [r + 1, c + 1]];
        let sh = 0, unk = 0, unkCell = null;
        for (const [h, n] of q) { if (this.g[h][n] === 1) sh++; else if (this.g[h][n] === 9) { unk++; unkCell = [h, n]; } }
        if (sh === 4) return false;
        if (sh === 3 && unk === 1) { this.g[unkCell[0]][unkCell[1]] = 0; dirty = true; }
      }
    }
    return true;
  }

  _shadedFromG() { const sh = []; for (let r = 0; r < this.rows; r++) { sh.push([]); for (let c = 0; c < this.cols; c++) sh[r].push(this.g[r][c] === 1 ? 1 : 0); } return sh; }

  // emit in the Nurikabe value-space: 0 unknown, 1 shaded, 2 not-shaded (clue cells -> 2).
  _emit() { const out = []; for (let r = 0; r < this.rows; r++) { out.push([]); for (let c = 0; c < this.cols; c++) { if (this.task[r][c] !== -1) { out[r].push(2); continue; } const v = this.g[r][c]; out[r].push(v === 9 ? 0 : v === 1 ? 1 : 2); } } return out; }

  _pick() { for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) if (this.task[r][c] === -1 && this.g[r][c] === 9) return [r, c]; return null; }

  _search(countAll) {
    if (Date.now() > this._deadline) { this._timedOut = true; return true; }
    const cell = this._pick();
    if (!cell) { const sh = this._shadedFromG(); if (this._isValid(sh)) { this._count++; if (!this._first) this._first = this.g.map((row) => row.slice()); if (!countAll) return true; if (this._count >= 2) return true; } return false; }
    const [r, c] = cell;
    for (const val of [1, 0]) {
      const snap = this.g.map((row) => row.slice());
      this.g[r][c] = val;
      if (this._propagate() && this._search(countAll)) { if (!countAll || this._count >= 2 || this._timedOut) return true; }
      this.g = snap;
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

  // Oracle (ported getErrors) on a complete shaded boolean grid (shaded[r][c] === 1 iff shaded).
  _isValid(shaded) {
    const { rows, cols, task } = this;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (task[r][c] !== -1 && shaded[r][c]) return false; // clue cell shaded
    for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++) if (shaded[r][c] && shaded[r][c + 1] && shaded[r + 1][c] && shaded[r + 1][c + 1]) return false; // 2x2
    for (const cl of this.clues) { // clue run-strings
      let mask = 0; for (let a = 0; a < 8; a++) { const [h, n] = cl.nbr[a]; if (h >= 0 && n >= 0 && h < rows && n < cols && shaded[h][n]) mask |= 1 << a; }
      /* eslint-disable-next-line eqeqeq */
      if (!(tapaRunString(mask) == task[cl.r][cl.c])) return false;
    }
    const cells = []; for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (shaded[r][c]) cells.push(r * cols + c);
    if (cells.length > 1) { // one orthogonal component
      const seen = new Set([cells[0]]); const stack = [cells[0]];
      while (stack.length) { const id = stack.pop(); const r = Math.floor(id / cols), c = id % cols; for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) { const h = r + dr, n = c + dc; if (h >= 0 && n >= 0 && h < rows && n < cols && shaded[h][n] && !seen.has(h * cols + n)) { seen.add(h * cols + n); stack.push(h * cols + n); } } }
      if (seen.size !== cells.length) return false;
    }
    return true;
  }

  // Hint engine. initialState = live cellStatus (0 unknown / 1 shaded / 2 not-shaded). Clue cells
  // are 0 in cellStatus (the page doesn't track them) — re-assert them as not-shaded (g=0) or the
  // propagation can target clue cells and Loop never terminates ([[project_clue_cells_not_in_cellstatus]]).
  // Returns the newly-forced shadeable cells as { row, col, value(1 shaded / 2 not-shaded) }.
  getHint(initialState) {
    this._initG(); // clue cells already g=0 (not-shaded); shadeable cells g=9
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) if (this.task[r][c] === -1) {
      const v = initialState[r] ? initialState[r][c] : 0;
      this.g[r][c] = v === 1 ? 1 : v === 2 ? 0 : 9;
    }
    this._deadline = Date.now() + (this.maxMs || 1500);
    if (!this._propagate()) return [];
    const out = [];
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) {
      if (this.task[r][c] !== -1) continue;
      const was = initialState[r] ? initialState[r][c] : 0;
      if (was !== 0) continue; // only newly-decided
      if (this.g[r][c] === 1) out.push({ row: r, col: c, value: 1 });
      else if (this.g[r][c] === 0) out.push({ row: r, col: c, value: 2 });
    }
    return out;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TapaSolver, tapaRunString };
}
