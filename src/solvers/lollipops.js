'use strict';

// LollipopsSolver — pure logic, no DOM.
//
// PAGE ENCODING (recon, getErrors is a REAL oracle — ported verbatim below and brute-force-gated in
// tests/lollipops.test.js):
//   cellStatus / task value-space: 0 off/unset, 1 candy (o), 2 vertical stick (v), 3 horizontal
//   stick (h), 4 cross/empty. task[r][c] = -1 free cell (player fills), >=0 a FIXED clue shape
//   (getShapeAt returns the task value). Clue cells are NOT tracked in cellStatus. serializeSolution
//   maps 0 and 4 both to "n" (a solve is registered from the shape placements).
//
// RULE (every lollipop is a candy + one adjacent stick): _partner(shape, dir) — candy(1) pairs with
//   h(3) L/R or v(2) U/D; v(2) pairs with candy U/D only; h(3) pairs with candy L/R only. A complete
//   board is valid iff every shape has EXACTLY ONE valid partner connection (u==1), NO non-partner
//   shape neighbour (d==0), and the line-of-sight rule holds (walking a row/col skipping only crosses
//   (4), the same shape must not be visible). getErrors distinguishes a 0 (unset) neighbour [g=true,
//   incomplete] from a 4 (cross) neighbour [ignored]; in a complete board (empties=4) every shape
//   must connect.
//
// METHOD: sound unit-propagation fixpoint (_propagate forces any free cell with a single locally-
//   consistent value) then backtracking with the local-consistency prune (_consistent). Fully solves
//   the real 10x10 uniquely in ~17ms. solve() grid: clue cells 0, free cells 1/2/3/4.

const DIRS = [
  { dr: 0, dc: -1, dir: 'L' }, { dr: 0, dc: 1, dir: 'R' },
  { dr: -1, dc: 0, dir: 'U' }, { dr: 1, dc: 0, dir: 'D' },
];

// _lollipopPartnerState: the shape a valid neighbour in direction `dir` must have to connect to `c`.
function partner(c, dir) {
  if (c === 1) return (dir === 'L' || dir === 'R') ? 3 : 2;
  if (c === 2) return (dir === 'U' || dir === 'D') ? 1 : null;
  if (c === 3) return (dir === 'L' || dir === 'R') ? 1 : null;
  return null;
}

class LollipopsSolver {
  constructor({ rows, cols, task, maxMs = 30000 }) {
    this.rows = rows; this.cols = cols; this.task = task; this.maxMs = maxMs;
  }

  // effective shape at a cell: clue cells read the fixed task value, else the working grid.
  _val(r, c) { const t = this.task[r][c]; return t >= 0 ? t : this.g[r][c]; }

  // Local consistency on the working grid g (-9 unknown; 4 cross ignored; 0 does not occur during
  // search). Ported from getErrors' per-cell checks, applied to currently-decided cells only.
  _consistent() {
    const { rows, cols } = this;
    for (let h = 0; h < rows; h++) for (let n = 0; n < cols; n++) {
      const c = this._val(h, n); if (c === -9) continue;
      if (c === 1 || c === 2 || c === 3) {
        let u = 0, d = 0, unk = false;
        for (const { dr, dc, dir } of DIRS) {
          const S = h + dr, v = n + dc; if (S < 0 || v < 0 || S >= rows || v >= cols) continue;
          const s = this._val(S, v); if (s === -9) { unk = true; continue; } if (s === 4) continue;
          const p = partner(c, dir); if (p !== null && s === p) u++; else d++;
        }
        if (d > 0 || u > 1) return false;
        if (!unk && u === 0) return false;
        for (const { dr, dc } of DIRS) {
          let f = h + dr, z = n + dc;
          while (f >= 0 && z >= 0 && f < rows && z < cols) {
            const w = this._val(f, z);
            if (w === 4) { f += dr; z += dc; continue; }
            if (w === -9) break; if (w === c) return false; else break;
          }
        }
      }
    }
    return true;
  }

  // Unit-propagation fixpoint: force any free unassigned cell with a single locally-consistent value.
  // Sound (the only consistent value must be the solution's). Returns false on contradiction.
  _propagate() {
    let changed = true;
    while (changed) {
      changed = false;
      for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) {
        if (this.task[r][c] >= 0 || this.g[r][c] !== -9) continue;
        let cand = -1, n = 0;
        for (const v of [1, 2, 3, 4]) { this.g[r][c] = v; if (this._consistent()) { cand = v; n++; } this.g[r][c] = -9; if (n > 1) break; }
        if (n === 0) return false;
        if (n === 1) { this.g[r][c] = cand; changed = true; }
      }
    }
    return true;
  }

  // Oracle on a full grid (clue cells read from task): the exact getErrors rules. 0 -> incomplete
  // flag, 4 -> ignored. `grid` free cells are 1/2/3/4 (clue cells may be 0; _val reads task).
  isValid(grid) { const save = this.g; this.g = grid; const ok = this._isValidFull(); this.g = save; return ok; }
  _isValidFull() {
    const { rows, cols } = this;
    for (let h = 0; h < rows; h++) for (let n = 0; n < cols; n++) {
      const c = this._val(h, n); if (c !== 1 && c !== 2 && c !== 3) continue;
      let u = 0, d = 0, g0 = false;
      for (const { dr, dc, dir } of DIRS) {
        const S = h + dr, v = n + dc; if (S < 0 || v < 0 || S >= rows || v >= cols) continue;
        const s = this._val(S, v); if (s === 0) { g0 = true; continue; } if (s === 4) continue;
        const p = partner(c, dir); if (p !== null && s === p) u++; else d++;
      }
      if (u > 1 || d > 0) return false; if (u === 0 && !g0) return false;
      for (const { dr, dc } of DIRS) {
        let f = h + dr, z = n + dc;
        while (f >= 0 && z >= 0 && f < rows && z < cols) {
          const w = this._val(f, z); if (w === 4) { f += dr; z += dc; continue; }
          if (w === c) return false; else break;
        }
      }
    }
    return true;
  }

  // emit: clue cells 0, free cells their value (unassigned -9 -> 0). Used for solution + partial.
  _emit() { const out = []; for (let r = 0; r < this.rows; r++) { out.push([]); for (let c = 0; c < this.cols; c++) { const v = this.g[r][c]; out[r].push(this.task[r][c] >= 0 ? 0 : (v === -9 ? 0 : v)); } } return out; }
  // full grid for the oracle: clue cells 0 (read via task), free cells (unassigned -> 4 cross).
  _full() { const out = []; for (let r = 0; r < this.rows; r++) { out.push([]); for (let c = 0; c < this.cols; c++) out[r].push(this.task[r][c] >= 0 ? 0 : (this.g[r][c] === -9 ? 4 : this.g[r][c])); } return out; }

  solve(countAll = false) {
    this.g = []; for (let r = 0; r < this.rows; r++) { this.g.push([]); for (let c = 0; c < this.cols; c++) this.g[r].push(this.task[r][c] >= 0 ? this.task[r][c] : -9); }
    this.deadline = Date.now() + this.maxMs; this.count = 0; this.first = null; this.timedOut = false;
    if (!this._propagate()) return { solved: false, error: 'No solution (contradiction in givens)' };
    const partialBase = this._emit();
    this._search(countAll);
    if (this.first) return { solved: true, grid: this.first, count: this.count };
    if (this.timedOut) return { solved: false, partial: true, grid: partialBase };
    return { solved: false, error: 'No solution found' };
  }

  _firstFree() { for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) if (this.task[r][c] < 0 && this.g[r][c] === -9) return [r, c]; return null; }

  _search(countAll) {
    if (Date.now() > this.deadline) { this.timedOut = true; return true; }
    if (!this._consistent()) return false;
    const cell = this._firstFree();
    if (!cell) { if (this.isValid(this._full())) { this.count++; if (!this.first) this.first = this._emit(); } return this.count >= (countAll ? 2 : 1); }
    const r = cell[0], c = cell[1];
    for (const v of [4, 1, 2, 3]) {
      this.g[r][c] = v; this._search(countAll); this.g[r][c] = -9;
      if (this.timedOut || this.count >= (countAll ? 2 : 1)) return true;
    }
    return false;
  }

  // Hint engine. initialState = live cellStatus (0 unknown / 1/2/3/4). Clue cells are 0 there and
  // re-asserted from task (the clue-cells-not-in-cellStatus family — else Loop never terminates).
  // Returns newly-forced free cells { row, col, value(1/2/3/4) } via the sound unit propagation.
  getHint(initialState) {
    this.g = []; for (let r = 0; r < this.rows; r++) { this.g.push([]); for (let c = 0; c < this.cols; c++) {
      if (this.task[r][c] >= 0) { this.g[r].push(this.task[r][c]); continue; }
      const v = initialState[r] ? initialState[r][c] : 0;
      this.g[r].push((v === 1 || v === 2 || v === 3 || v === 4) ? v : -9);
    } }
    if (!this._consistent() || !this._propagate()) return [];
    const out = [];
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) {
      if (this.task[r][c] >= 0) continue;
      const was = initialState[r] ? initialState[r][c] : 0;
      if (was !== 0) continue;
      if (this.g[r][c] !== -9) out.push({ row: r, col: c, value: this.g[r][c] });
    }
    return out;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LollipopsSolver };
}
