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
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TapaSolver, tapaRunString };
}
