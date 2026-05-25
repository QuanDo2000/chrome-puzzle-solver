'use strict';

class NonogramSolver {
  /**
   * @param {number[][]} rowClues  Per-row block-length lists, top-to-bottom.
   * @param {number[][]} colClues  Per-column block-length lists, left-to-right.
   */
  constructor(rowClues, colClues) {
    this.rowClues = rowClues.map(r => r.filter(n => n > 0));
    this.colClues = colClues.map(c => c.filter(n => n > 0));
    this.rows = rowClues.length;
    this.cols = colClues.length;
    this.grid = Array.from({ length: this.rows }, () => Array(this.cols).fill(0));
    // Typed-array mirror of this.grid for fast access and trail-based undo.
    // Values: 0 = unknown, 1 = filled, -1 = empty (matches this.grid).
    this.gridBuf = new Int8Array(this.rows * this.cols);
    // Per-line counts of non-zero (known) cells. Maintained incrementally by
    // _set / _assign / _rollback so backtrack() can pick its variable in O(R+C)
    // instead of rebuilding via an O(R·C) scan per recursion node.
    this.rowKnown = new Int32Array(this.rows);
    this.colKnown = new Int32Array(this.cols);
    // Trail entries: (cellIndex << 2) | (oldValue + 1) — old ∈ {-1,0,1}.
    this.trail = [];
    this.maxIterations = 1000;
    this.bestPartial = null;
    this.bestPartialFilled = 0;
    this.maxMs = this.rows * this.cols >= 900 ? 3000 : 0;
    this.startedAt = 0;
    this.timedOut = false;
  }

  _idx(r, c) { return r * this.cols + c; }

  // Direct write, no trail. Use only outside backtracking (initial state).
  _set(r, c, v) {
    const old = this.gridBuf[r * this.cols + c];
    if (old === 0 && v !== 0) { this.rowKnown[r]++; this.colKnown[c]++; }
    else if (old !== 0 && v === 0) { this.rowKnown[r]--; this.colKnown[c]--; }
    this.gridBuf[r * this.cols + c] = v;
    this.grid[r][c] = v;
  }

  // Trailed write — records old value so _rollback can restore. Returns true
  // iff a write happened.
  _assign(r, c, v) {
    const i = r * this.cols + c;
    const old = this.gridBuf[i];
    if (old === v) return false;
    this.trail.push((i << 2) | (old + 1));
    if (old === 0 && v !== 0) { this.rowKnown[r]++; this.colKnown[c]++; }
    else if (old !== 0 && v === 0) { this.rowKnown[r]--; this.colKnown[c]--; }
    this.gridBuf[i] = v;
    this.grid[r][c] = v;
    return true;
  }

  // Roll the trail back to `mark`, restoring each cell to its previous value.
  _rollback(mark) {
    const t = this.trail;
    const cols = this.cols;
    while (t.length > mark) {
      const entry = t.pop();
      const old = (entry & 0b11) - 1;
      const i = entry >>> 2;
      const cur = this.gridBuf[i];
      const r = (i / cols) | 0;
      const c = i % cols;
      if (cur === 0 && old !== 0) { this.rowKnown[r]++; this.colKnown[c]++; }
      else if (cur !== 0 && old === 0) { this.rowKnown[r]--; this.colKnown[c]--; }
      this.gridBuf[i] = old;
      this.grid[r][c] = old;
    }
  }

  /**
   * @param {number[][] | null} initialGrid  Optional partial state (1/-1/0).
   * @returns {SolveResult}
   */
  solve(initialGrid) {
    // Reset every per-solve field so a reused instance behaves like a fresh
    // one. AquariumSolver and GalaxiesSolver both reset on entry to solve();
    // this matches that contract. Production constructs a fresh solver per
    // call (solver.worker.js), but the inconsistency was a latent footgun.
    this.trail.length = 0;
    this.gridBuf.fill(0);
    for (let r = 0; r < this.rows; r++) this.grid[r].fill(0);
    this.rowKnown.fill(0);
    this.colKnown.fill(0);
    this.bestPartial = null;
    this.bestPartialFilled = 0;
    this.startedAt = Date.now();
    this.timedOut = false;
    if (initialGrid) {
      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) {
          if (initialGrid[r] && initialGrid[r][c] !== undefined) {
            this._set(r, c, initialGrid[r][c]);
          }
        }
      }
    }

    if (!this.propagate()) {
      return { solved: false, grid: null, error: 'contradiction on initial propagation' };
    }
    this.rememberPartial(this.grid);
    if (this.isComplete()) return { solved: true, grid: this.grid };

    const result = this.backtrack();
    if (!result.solved && this.bestPartial) {
      result.partialGrid = this.bestPartial.map(row => row.slice());
      result.partialFilled = this.bestPartialFilled;
    }
    return result;
  }

  rememberPartial(grid) {
    let filled = 0;
    for (const row of grid) for (const v of row) if (v !== 0) filled++;
    if (filled > this.bestPartialFilled) {
      this.bestPartialFilled = filled;
      this.bestPartial = grid.map(row => row.slice());
    }
  }

  propagate() {
    const dirtyRows = new Set();
    const dirtyCols = new Set();
    for (let r = 0; r < this.rows; r++) dirtyRows.add(r);
    for (let c = 0; c < this.cols; c++) dirtyCols.add(c);

    let iters = 0;
    while ((dirtyRows.size > 0 || dirtyCols.size > 0) && iters < this.maxIterations) {
      iters++;
      const rowsToProcess = Array.from(dirtyRows);
      const colsToProcess = Array.from(dirtyCols);
      dirtyRows.clear();
      dirtyCols.clear();

      for (const r of rowsToProcess) {
        const result = this.solveLine(this.rowClues[r], this.grid[r]);
        if (!result) return false;
        for (let c = 0; c < this.cols; c++) {
          if (result[c] !== 0 && this._assign(r, c, result[c])) dirtyCols.add(c);
        }
      }

      for (const c of colsToProcess) {
        const line = [];
        for (let r = 0; r < this.rows; r++) line.push(this.grid[r][c]);
        const result = this.solveLine(this.colClues[c], line);
        if (!result) return false;
        for (let r = 0; r < this.rows; r++) {
          if (result[r] !== 0 && this._assign(r, c, result[r])) dirtyRows.add(r);
        }
      }
    }
    return true;
  }

  // Returns a length-L array: result[c] = 0 (unknown), 1 (forced filled),
  // or -1 (forced empty). Returns null if the line has no valid completion.
  //
  // Forward + backward DP in O(L·N·blockAvg). The previous implementation
  // re-ran an O(L·N) DP twice per unknown cell, giving O(L²·N·block) — for the
  // 50×50 monthly puzzle that's the dominant cost in NonogramSolver.propagate.
  solveLine(clues, line) {
    const L = line.length;
    const N = clues.length;

    if (N === 0) {
      for (let c = 0; c < L; c++) if (line[c] === 1) return null;
      return Array(L).fill(-1);
    }

    // Bitmap canEmpty path requires N <= 31 (Int32 has 32 bits, k indexes
    // [0..N]). Real nonograms cap out around N=12 on 50×50 boards; the
    // smallest puzzle needing N=32 would have L >= 63, larger than anything
    // the extension targets. Fail loud if a caller violates this rather
    // than carry untested fallback code.
    if (N > 31) throw new Error(`solveLine: N=${N} exceeds bitmap capacity (31)`);
    const W = N + 1;
    // f[i*W + k] = "first i cells matched the first k clues, about to consider cell i"
    // (cell i is at this point not yet inside a block).
    const f = new Uint8Array((L + 1) * W);
    // bf[i] = bitmask of k values where f[i*W+k] is set. Maintained inline with
    // the DP so the final canEmpty test is O(1) per cell instead of O(N).
    const bf = new Int32Array(L + 1);
    f[0] = 1;
    bf[0] = 1;
    for (let i = 0; i < L; i++) {
      for (let k = 0; k <= N; k++) {
        if (!f[i * W + k]) continue;
        // Option A: cell i is empty.
        if (line[i] !== 1) {
          f[(i + 1) * W + k] = 1;
          bf[i + 1] |= (1 << k);
        }
        // Option B: place clue k starting at cell i.
        if (k < N) {
          const block = clues[k];
          if (i + block <= L) {
            let fits = true;
            for (let j = i; j < i + block; j++) {
              if (line[j] === -1) { fits = false; break; }
            }
            if (fits) {
              if (k < N - 1) {
                if (i + block < L && line[i + block] !== 1) {
                  f[(i + block + 1) * W + k + 1] = 1;
                  bf[i + block + 1] |= (1 << (k + 1));
                }
              } else {
                f[(i + block) * W + k + 1] = 1;
                bf[i + block] |= (1 << (k + 1));
              }
            }
          }
        }
      }
    }
    if (!f[L * W + N]) return null;

    // b[i*W + k] = "cells [i..L) can match clues [k..N)".
    const b = new Uint8Array((L + 1) * W);
    const bb = new Int32Array(L + 1);
    b[L * W + N] = 1;
    bb[L] = (1 << N);
    // Also: b[i][N] iff cells [i..L) are all empty-compatible.
    for (let i = L - 1; i >= 0; i--) {
      if (line[i] !== 1 && b[(i + 1) * W + N]) {
        b[i * W + N] = 1;
        bb[i] |= (1 << N);
      }
    }
    for (let i = L - 1; i >= 0; i--) {
      for (let k = N - 1; k >= 0; k--) {
        // Option A: skip cell i (empty).
        if (line[i] !== 1 && b[(i + 1) * W + k]) {
          b[i * W + k] = 1;
          bb[i] |= (1 << k);
          continue;
        }
        // Option B: place clue k at cell i.
        const block = clues[k];
        if (i + block > L) continue;
        let fits = true;
        for (let j = i; j < i + block; j++) {
          if (line[j] === -1) { fits = false; break; }
        }
        if (!fits) continue;
        if (k < N - 1) {
          if (i + block < L && line[i + block] !== 1 && b[(i + block + 1) * W + k + 1]) {
            b[i * W + k] = 1;
            bb[i] |= (1 << k);
          }
        } else {
          if (b[(i + block) * W + k + 1]) {
            b[i * W + k] = 1;
            bb[i] |= (1 << k);
          }
        }
      }
    }

    // Cells covered by at least one valid block placement → can be filled.
    // Use a difference array so each (s, k) contributes O(1) work.
    // gapEmpty[c]=1 marks cells that are the mandatory single-cell gap right
    // after a non-last block. The forward DP collapses that gap into the
    // block-placement transition (jumping from f[s][k] to f[s+block+1][k+1]),
    // so f[s+block][k+1] is never set and the generic "f[c][k] && skip &&
    // b[c+1][k]" check below cannot detect cell s+block as empty. We mark it
    // explicitly when we confirm the (s, k) placement is part of a valid
    // configuration.
    const fillDelta = new Int32Array(L + 1);
    const gapEmpty = new Uint8Array(L);
    for (let s = 0; s < L; s++) {
      for (let k = 0; k < N; k++) {
        if (!f[s * W + k]) continue;
        const block = clues[k];
        if (s + block > L) continue;
        let fits = true;
        for (let j = s; j < s + block; j++) {
          if (line[j] === -1) { fits = false; break; }
        }
        if (!fits) continue;
        let validTail;
        if (k < N - 1) {
          validTail = s + block < L && line[s + block] !== 1 && b[(s + block + 1) * W + k + 1];
        } else {
          validTail = !!b[(s + block) * W + k + 1];
        }
        if (!validTail) continue;
        fillDelta[s]++;
        fillDelta[s + block]--;
        if (k < N - 1) gapEmpty[s + block] = 1;
      }
    }

    const result = new Array(L);
    let cover = 0;
    for (let c = 0; c < L; c++) {
      cover += fillDelta[c];
      const canFill = cover > 0;
      // canEmpty: either c is the mandatory gap of some valid placement, OR
      // there's a valid config where cell c is in an "explicit skip" region
      // (∃k: f[c][k] && b[c+1][k]). Bitmap intersection answers in O(1).
      let canEmpty = gapEmpty[c] === 1;
      if (!canEmpty && line[c] !== 1) {
        canEmpty = (bf[c] & bb[c + 1]) !== 0;
      }
      if (line[c] !== 0) result[c] = line[c];
      else if (canFill && !canEmpty) result[c] = 1;
      else if (canEmpty && !canFill) result[c] = -1;
      else result[c] = 0;
    }
    return result;
  }

  isComplete() {
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        if (this.grid[r][c] === 0) return false;
      }
    }
    return this.verify();
  }

  verify() {
    for (let r = 0; r < this.rows; r++) {
      const actual = this.getLineClues(this.grid[r]);
      if (!this.arraysEqual(actual, this.rowClues[r])) return false;
    }
    for (let c = 0; c < this.cols; c++) {
      const actual = this.getLineClues(this.getCol(c));
      if (!this.arraysEqual(actual, this.colClues[c])) return false;
    }
    return true;
  }

  getLineClues(line) {
    const clues = [];
    let count = 0;
    for (const v of line) {
      if (v === 1) {
        count++;
      } else if (count > 0) {
        clues.push(count);
        count = 0;
      }
    }
    if (count > 0) clues.push(count);
    return clues;
  }

  arraysEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  getCol(c) {
    return this.grid.map(row => row[c]);
  }

  backtrack(depth = 0) {
    if (this.maxMs && Date.now() - this.startedAt > this.maxMs) {
      this.timedOut = true;
      return { solved: false, grid: null, error: 'time limit exceeded' };
    }
    const maxDepth = Math.max(500, this.rows * this.cols);
    if (depth > maxDepth) return { solved: false, grid: null, error: 'Backtrack limit reached' };

    let bestR = -1, bestC = -1;
    let bestScore = -1;

    for (let r = 0; r < this.rows; r++) {
      const row = this.grid[r];
      const rk = this.rowKnown[r];
      for (let c = 0; c < this.cols; c++) {
        if (row[c] === 0) {
          const score = rk + this.colKnown[c];
          if (score > bestScore) {
            bestScore = score;
            bestR = r;
            bestC = c;
          }
        }
      }
    }

    if (bestR === -1) {
      return this.isComplete()
        ? { solved: true, grid: this.grid }
        : { solved: false, grid: null };
    }

    for (const guess of [1, -1]) {
      const mark = this.trail.length;
      this._assign(bestR, bestC, guess);
      if (this.propagate()) {
        this.rememberPartial(this.grid);
        const result = this.backtrack(depth + 1);
        if (result.solved) return result;
        if (result.partialGrid) this.rememberPartial(result.partialGrid);
      }
      this._rollback(mark);
    }

    return { solved: false, grid: null };
  }

  getHint(grid) {
    let best = null;
    let bestCount = 0;
    let bestCells = [];

    for (let r = 0; r < this.rows; r++) {
      const line = grid[r];
      const result = this.solveLine(this.rowClues[r], line);
      if (!result) continue;
      const found = [];
      for (let c = 0; c < this.cols; c++) {
        if (result[c] !== 0 && result[c] !== line[c]) {
          found.push({ index: c, value: result[c] });
        }
      }
      if (found.length > bestCount) {
        bestCount = found.length;
        best = { type: 'row', index: r, clue: this.rowClues[r] };
        bestCells = found;
      }
    }

    for (let c = 0; c < this.cols; c++) {
      const line = [];
      for (let r = 0; r < this.rows; r++) line.push(grid[r][c]);
      const result = this.solveLine(this.colClues[c], line);
      if (!result) continue;
      const found = [];
      for (let r = 0; r < this.rows; r++) {
        if (result[r] !== 0 && result[r] !== line[r]) {
          found.push({ index: r, value: result[r] });
        }
      }
      if (found.length > bestCount) {
        bestCount = found.length;
        best = { type: 'col', index: c, clue: this.colClues[c] };
        bestCells = found;
      }
    }

    if (!best) return null;
    return { ...best, cells: bestCells, count: bestCells.length };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { NonogramSolver };
}
