/**
 * Solver result envelope. Cell value conventions are solver-specific:
 *   NonogramSolver: 1 = filled, -1 = empty, 0 = unknown
 *   AquariumSolver: 1 = water,  -1 = dry,   0 = unknown
 *   GalaxiesSolver: cell value = (star index + 1), 0 = unassigned (unsolved
 *     only). The grid array also has a `.galaxies` property: lines between
 *     adjacent cells that belong to different stars.
 *
 * @typedef {Object} SolveResult
 * @property {boolean} solved
 * @property {number[][] | null} [grid]
 * @property {string} [error]
 * @property {number[][]} [partialGrid]
 * @property {number} [partialFilled]
 */

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

/**
 * @typedef {Object} Star  Galaxy center in doubled coordinates: rows
 *   0..2R-2, cols 0..2C-2. Even/even = cell center; odd row = between two
 *   vertically-adjacent cells; odd col = between two horizontally-adjacent;
 *   odd/odd = at a four-cell corner.
 * @property {number} row
 * @property {number} col
 */

class GalaxiesSolver {
  /**
   * @param {Star[] | null | undefined} stars
   * @param {number} rows
   * @param {number} cols
   */
  constructor(stars, rows, cols) {
    this.stars = stars || [];
    this.rows = rows;
    this.cols = cols;
    this.grid = null;            // assigned by solve() once the seed grid is built
    this.trail = [];             // (row, col, oldValue) entries for trail-based undo
    this.maxNodes = rows * cols >= 900 ? 750000 : 200000;
    this.nodes = 0;
    this.startedAt = 0;
    this.maxMs = rows * cols >= 400 ? 8000 : 0;
    this.bestPartial = null;
    this.bestPartialFilled = 0;
    this.deadCache = new Set();
    this.maxDeadCache = rows * cols >= 900 ? 0 : 200000;
    this.staticCandidates = [];
    this.forbiddenPartials = [];
    // owner: Map<flatIndex, starIndex|-1>. Flat index = row * cols + col,
    // not a "r,c" string key, so lookups in _canUseCell don't allocate.
    this.owner = new Map();
    for (let i = 0; i < this.stars.length; i++) {
      for (const cell of GalaxiesSolver.seedCellsForStar(this.stars[i], this.rows, this.cols)) {
        const key = cell.row * cols + cell.col;
        if (this.owner.has(key)) this.owner.set(key, -1);
        else this.owner.set(key, i);
      }
    }
    this._buildStaticCandidates();
    this._pruneStaticCandidatesByReachability();
  }

  static _solutionCache = new Map();
  static _maxSolutionCache = 30;

  // Static cache survives across solver instances and across tests, so a
  // test that warms the cache with puzzle P silently affects a later test
  // that also solves P. Tests / benches should call this between cases
  // when they need a guaranteed cold solve.
  static clearSolutionCache() {
    GalaxiesSolver._solutionCache.clear();
  }

  // ── Shared galaxies geometry ────────────────────────────────────────
  // Static helpers used by GalaxiesSolver and also by content.js / handler.js
  // for hint computation and DOM line rendering. Previously duplicated across
  // the three files; centralized here so all callers stay in lockstep.

  /**
   * Cells covered by a star's seed footprint. A star at doubled coords
   * (R, C) occupies the 1, 2, or 4 grid cells that surround its center
   * depending on whether R and C are even (cell center) or odd (between
   * cells). Out-of-bounds cells are dropped.
   *
   * @param {{row: number, col: number}} star  Doubled-coord star position.
   * @param {number} rows                       Grid row count.
   * @param {number} cols                       Grid col count.
   * @returns {Array<{row: number, col: number}>}
   */
  static seedCellsForStar(star, rows, cols) {
    const rr = star.row % 2 === 0 ? [star.row / 2] : [(star.row - 1) / 2, (star.row + 1) / 2];
    const cc = star.col % 2 === 0 ? [star.col / 2] : [(star.col - 1) / 2, (star.col + 1) / 2];
    const out = [];
    for (const row of rr) {
      for (const col of cc) {
        if (row >= 0 && col >= 0 && row < rows && col < cols) out.push({ row, col });
      }
    }
    return out;
  }

  /**
   * Convert a region-id grid (1 region id per cell) to the implied galaxies
   * line layout: a horizontal line at (r, c) where the cells above and below
   * belong to different regions, and likewise for vertical lines. Robust to
   * a null grid (returns zero-filled arrays).
   *
   * @param {number[][] | null | undefined} grid
   * @param {number} rows
   * @param {number} cols
   * @returns {{horizontal: number[][], vertical: number[][]}}
   */
  static regionsToLines(grid, rows, cols) {
    const horizontal = Array.from({ length: rows + 1 }, () => Array(cols).fill(0));
    const vertical = Array.from({ length: rows }, () => Array(cols + 1).fill(0));
    if (!grid) return { horizontal, vertical };
    for (let r = 1; r < rows; r++) {
      for (let c = 0; c < cols; c++) horizontal[r][c] = grid[r - 1]?.[c] !== grid[r]?.[c] ? 1 : 0;
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 1; c < cols; c++) vertical[r][c] = grid[r]?.[c - 1] !== grid[r]?.[c] ? 1 : 0;
    }
    return { horizontal, vertical };
  }

  /**
   * @param {number[][] | null} initialGrid  Optional partial state ((star+1)/0).
   * @param {{ forbiddenPartials?: any[] }} [options]
   * @returns {SolveResult & { failedPartialGrid?: number[][] | null }}
   */
  solve(initialGrid, options = {}) {
    if (!this.rows || !this.cols || !this.stars.length) {
      return { solved: false, grid: null, error: 'No Galaxies task data found' };
    }
    // Cache stores the unconstrained solution; bypass when caller has constraints
    // that may invalidate it (a resumed partial, or a forbidden-solutions list).
    const cacheable = !initialGrid && !(options.forbiddenPartials?.length);
    const cacheKey = this._puzzleKey();
    if (cacheable) {
      const cached = GalaxiesSolver._solutionCache.get(cacheKey);
      if (cached) {
        return { solved: true, grid: this._cloneSolvedGrid(cached) };
      }
    }
    // Exact-cover ignores forbiddenPartials/initialGrid; only run on the
    // unconstrained path that also feeds the cache.
    if (cacheable && this.rows * this.cols < 400) {
      const exact = this._solveByRegionExactCover();
      if (exact?.solved) {
        this._storeSolution(cacheKey, exact.grid);
        return exact;
      }
    }

    const seedGrid = this._newSeededGrid();
    if (!seedGrid) return { solved: false, grid: null, error: 'Invalid Galaxies star layout' };
    // Reset every per-solve field so a reused instance behaves like a fresh
    // one. Mirrors NonogramSolver.solve()'s reset block; AquariumSolver.solve
    // is the third example. Production constructs a fresh solver per worker
    // message, but the inconsistency was a latent footgun.
    this.grid = seedGrid;
    this.trail = [];
    this.nodes = 0;
    this.bestPartial = null;
    this.bestPartialFilled = 0;
    this.timeoutPartial = null;
    this.deadCache.clear();
    this.timedOut = false;
    this.startedAt = Date.now();
    this.forbiddenPartials = this._normalizeForbiddenPartials(options.forbiddenPartials || []);
    const resumed = !!initialGrid;
    if (initialGrid && !this._applyInitialGrid(initialGrid)) {
      return { solved: false, grid: null, error: 'invalid partial state' };
    }
    this._rememberPartial();
    const solved = this._search(null);
    if (!solved) {
      if (resumed && !this.timedOut && this.nodes <= 2) {
        return { solved: false, grid: null, failedPartialGrid: initialGrid, error: 'partial state exhausted' };
      }
      const partialGrid = this.timeoutPartial
        ? this._toOutputGrid(this.timeoutPartial)
        : (this.bestPartial ? this._toOutputGrid(this.bestPartial) : null);
      return {
        solved: false,
        grid: null,
        partialGrid,
        partialFilled: this.bestPartialFilled,
        error: this.timedOut ? 'time limit exceeded' : 'search limit exceeded'
      };
    }
    const out = this._toOutputGrid(this.grid);
    if (cacheable) this._storeSolution(cacheKey, out);
    return { solved: true, grid: out };
  }

  _newSeededGrid() {
    const grid = Array.from({ length: this.rows }, () => Array(this.cols).fill(-1));
    const savedGrid = this.grid;
    this.grid = grid;
    for (let i = 0; i < this.stars.length; i++) {
      for (const cell of GalaxiesSolver.seedCellsForStar(this.stars[i], this.rows, this.cols)) {
        if (!this._assignPair(cell.row, cell.col, i)) {
          this.grid = savedGrid;
          return null;
        }
      }
    }
    this.grid = savedGrid;
    return grid;
  }

  _solveByRegionExactCover() {
    const started = Date.now();
    const maxMs = this.rows * this.cols >= 900 ? 2500 : 300;
    const shapesByStar = [];
    const cellToShapes = Array.from({ length: this.rows * this.cols }, () => []);
    let shapeId = 0;

    for (let i = 0; i < this.stars.length; i++) {
      if (Date.now() - started > maxMs) return null;
      const shapes = this._enumerateGalaxyShapes(i, started, maxMs);
      if (!shapes.length) return null;
      shapesByStar[i] = shapes;
      for (const shape of shapes) {
        shape.id = shapeId++;
        // shape.star already set to starIndex (== i) by _enumerateGalaxyShapes.
        for (const cell of shape.cells) cellToShapes[cell].push(shape);
      }
    }

    for (let idx = 0; idx < this.rows * this.cols; idx++) {
      if (!cellToShapes[idx].length) return null;
    }

    const covered = new Uint8Array(this.rows * this.cols);
    const usedStar = new Uint8Array(this.stars.length);
    const chosen = [];
    let coveredCount = 0;
    let nodes = 0;
    const maxNodes = this.rows * this.cols >= 900 ? 250000 : 100000;

    const search = () => {
      if (++nodes > maxNodes || Date.now() - started > maxMs) return null;
      if (coveredCount === this.rows * this.cols) {
        for (let i = 0; i < usedStar.length; i++) if (!usedStar[i]) return null;
        return chosen.slice();
      }

      let bestShapes = null;
      for (let idx = 0; idx < covered.length; idx++) {
        if (covered[idx]) continue;
        const viable = [];
        for (const shape of cellToShapes[idx]) {
          if (usedStar[shape.star]) continue;
          let ok = true;
          for (const cell of shape.cells) {
            if (covered[cell]) { ok = false; break; }
          }
          if (ok) viable.push(shape);
        }
        if (viable.length === 0) return null;
        if (!bestShapes || viable.length < bestShapes.length) {
          bestShapes = viable;
          if (viable.length === 1) break;
        }
      }
      for (let i = 0; i < this.stars.length; i++) {
        if (usedStar[i]) continue;
        const viable = [];
        for (const shape of shapesByStar[i]) {
          let ok = true;
          for (const cell of shape.cells) {
            if (covered[cell]) { ok = false; break; }
          }
          if (ok) viable.push(shape);
        }
        if (viable.length === 0) return null;
        if (!bestShapes || viable.length < bestShapes.length) {
          bestShapes = viable;
          if (viable.length === 1) break;
        }
      }
      if (!bestShapes) return null;

      bestShapes.sort((a, b) => a.cells.length - b.cells.length);
      for (const shape of bestShapes) {
        usedStar[shape.star] = 1;
        chosen.push(shape);
        for (const cell of shape.cells) { covered[cell] = 1; coveredCount++; }
        const solved = search();
        if (solved) return solved;
        for (const cell of shape.cells) { covered[cell] = 0; coveredCount--; }
        chosen.pop();
        usedStar[shape.star] = 0;
      }
      return null;
    };

    const solvedShapes = search();
    if (!solvedShapes) return null;
    const internal = Array.from({ length: this.rows }, () => Array(this.cols).fill(-1));
    for (const shape of solvedShapes) {
      for (const idx of shape.cells) internal[Math.floor(idx / this.cols)][idx % this.cols] = shape.star;
    }
    const savedGrid = this.grid;
    this.grid = internal;
    const ok = this._verify();
    this.grid = savedGrid;
    if (!ok) return null;
    return { solved: true, grid: this._toOutputGrid(internal), method: 'exact-cover-shapes' };
  }

  _enumerateGalaxyShapes(starIndex, started, maxMs) {
    const maxShapes = this.rows * this.cols >= 900 ? 200 : 500;
    const maxCells = this.rows * this.cols >= 900 ? 16 : 30;
    const seed = new Set();
    for (const cell of GalaxiesSolver.seedCellsForStar(this.stars[starIndex], this.rows, this.cols)) {
      if (!this.staticCandidates[cell.row]?.[cell.col]?.includes(starIndex)) return [];
      seed.add(cell.row * this.cols + cell.col);
    }
    const startKey = this._shapeKey(seed);
    const seen = new Set([startKey]);
    const shapes = [];
    const stack = [seed];

    while (stack.length && shapes.length < maxShapes) {
      if (Date.now() - started > maxMs) break;
      const shape = stack.pop();
      if (this._shapeConnected(shape)) shapes.push({ cells: Array.from(shape), star: starIndex, id: 0 });
      if (shape.size >= maxCells) continue;

      const frontier = this._shapeFrontier(shape, starIndex);
      frontier.sort((a, b) => a.length - b.length);
      for (const group of frontier) {
        const next = new Set(shape);
        let ok = true;
        for (const idx of group) {
          const r = Math.floor(idx / this.cols), c = idx % this.cols;
          if (!this.staticCandidates[r]?.[c]?.includes(starIndex)) { ok = false; break; }
          next.add(idx);
        }
        if (!ok || next.size === shape.size || next.size > maxCells) continue;
        const key = this._shapeKey(next);
        if (seen.has(key)) continue;
        seen.add(key);
        stack.push(next);
      }
    }
    return shapes;
  }

  _shapeFrontier(shape, starIndex) {
    const out = [];
    const seen = new Set();
    for (const idx of shape) {
      const r = Math.floor(idx / this.cols), c = idx % this.cols;
      for (const d of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nr = r + d[0], nc = c + d[1];
        if (!this._inside(nr, nc)) continue;
        const a = nr * this.cols + nc;
        if (shape.has(a)) continue;
        const s = this.stars[starIndex];
        const mr = s.row - nr, mc = s.col - nc;
        if (!this._inside(mr, mc)) continue;
        const b = mr * this.cols + mc;
        const group = a === b ? [a] : [a, b].sort((x, y) => x - y);
        const key = group.join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(group);
      }
    }
    return out;
  }

  _shapeConnected(shape) {
    const first = shape.values().next().value;
    if (first === undefined) return false;
    const q = [first];
    const seen = new Set([first]);
    for (let i = 0; i < q.length; i++) {
      const idx = q[i], r = Math.floor(idx / this.cols), c = idx % this.cols;
      for (const d of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nr = r + d[0], nc = c + d[1], nidx = nr * this.cols + nc;
        if (!this._inside(nr, nc) || seen.has(nidx) || !shape.has(nidx)) continue;
        seen.add(nidx);
        q.push(nidx);
      }
    }
    return seen.size === shape.size;
  }

  _shapeKey(shape) {
    return Array.from(shape).sort((a, b) => a - b).join(',');
  }

  _normalizeForbiddenPartials(partials) {
    const out = [];
    for (const grid of partials || []) {
      const cells = [];
      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) {
          const v = grid?.[r]?.[c];
          if (v > 0) cells.push([r, c, v - 1]);
        }
      }
      if (cells.length) out.push(cells);
    }
    return out;
  }

  _toOutputGrid(grid) {
    const out = grid.map(row => row.map(v => v + 1));
    out.galaxies = GalaxiesSolver.regionsToLines(grid, this.rows, this.cols);
    return out;
  }

  _applyInitialGrid(initialGrid) {
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const v = initialGrid[r]?.[c];
        if (!v || v <= 0) continue;
        if (!this._assignPair(r, c, v - 1)) return false;
      }
    }
    return true;
  }

  _puzzleKey() {
    return this.rows + 'x' + this.cols + ':' + this.stars.map(s => s.row + ',' + s.col).join(';');
  }

  _cloneSolvedGrid(grid) {
    const out = grid.map(row => row.slice());
    out.galaxies = {
      horizontal: grid.galaxies.horizontal.map(row => row.slice()),
      vertical: grid.galaxies.vertical.map(row => row.slice()),
    };
    return out;
  }

  _storeSolution(key, grid) {
    if (GalaxiesSolver._solutionCache.size >= GalaxiesSolver._maxSolutionCache) {
      const first = GalaxiesSolver._solutionCache.keys().next().value;
      GalaxiesSolver._solutionCache.delete(first);
    }
    GalaxiesSolver._solutionCache.set(key, this._cloneSolvedGrid(grid));
  }

  _buildStaticCandidates() {
    for (let r = 0; r < this.rows; r++) {
      this.staticCandidates[r] = [];
      for (let c = 0; c < this.cols; c++) {
        const out = [];
        for (let i = 0; i < this.stars.length; i++) {
          const m = this._mirror(r, c, i);
          if (this._canUseCell(r, c, i) && this._canUseCell(m.row, m.col, i)) out.push(i);
        }
        this.staticCandidates[r][c] = out;
      }
    }
  }

  _pruneStaticCandidatesByReachability() {
    const reachable = Array.from({ length: this.rows }, () => Array.from({ length: this.cols }, () => new Set()));
    for (let i = 0; i < this.stars.length; i++) {
      const start = this._starCell(this.stars[i]);
      if (!this.staticCandidates[start.row]?.[start.col]?.includes(i)) continue;
      const q = [start];
      const seen = new Set([start.row + ',' + start.col]);
      reachable[start.row][start.col].add(i);
      for (let qi = 0; qi < q.length; qi++) {
        const p = q[qi];
        for (const d of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nr = p.row + d[0], nc = p.col + d[1];
          const key = nr + ',' + nc;
          if (!this._inside(nr, nc) || seen.has(key)) continue;
          if (!this.staticCandidates[nr][nc].includes(i)) continue;
          seen.add(key);
          reachable[nr][nc].add(i);
          q.push({ row: nr, col: nc });
        }
      }
    }
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        this.staticCandidates[r][c] = this.staticCandidates[r][c].filter(i => reachable[r][c].has(i));
      }
    }
  }

  _starCell(star) {
    return { row: Math.floor(star.row / 2), col: Math.floor(star.col / 2) };
  }

  _mirror(row, col, starIndex) {
    const s = this.stars[starIndex];
    return { row: s.row - row, col: s.col - col };
  }

  _inside(row, col) {
    return row >= 0 && col >= 0 && row < this.rows && col < this.cols;
  }

  _canUseCell(row, col, starIndex) {
    if (!this._inside(row, col)) return false;
    const owner = this.owner.get(row * this.cols + col);
    return owner === undefined || owner === starIndex;
  }

  _canAssignPair(row, col, starIndex) {
    if (this.staticCandidates[row]?.[col] && !this.staticCandidates[row][col].includes(starIndex)) return false;
    // Inline _mirror to skip the per-call {row,col} object allocation; this is
    // the deepest hot path in the solver (called millions of times via
    // _candidates / _propagate / _regionReachable).
    const s = this.stars[starIndex];
    const mr = s.row - row, mc = s.col - col;
    if (!this._canUseCell(row, col, starIndex) || !this._canUseCell(mr, mc, starIndex)) return false;
    const a = this.grid[row][col], b = this.grid[mr][mc];
    return (a === -1 || a === starIndex) && (b === -1 || b === starIndex);
  }


  // Trailed write to a single cell. Returns true iff a write happened.
  // Trail is a flat array of 3-int groups: ..., row, col, oldValue.
  // Pushing 3 ints avoids the per-write tuple allocation of `push([r,c,old])`.
  _assign(row, col, value) {
    const old = this.grid[row][col];
    if (old === value) return false;
    this.trail.push(row, col, old);
    this.grid[row][col] = value;
    return true;
  }

  // Roll the trail back to `mark` (a previously-captured `this.trail.length`).
  _rollback(mark) {
    const t = this.trail;
    while (t.length > mark) {
      const old = t.pop();
      const c = t.pop();
      const r = t.pop();
      this.grid[r][c] = old;
    }
  }

  _assignPair(row, col, starIndex, changed) {
    if (!this._canAssignPair(row, col, starIndex)) return false;
    const s = this.stars[starIndex];
    this._assign(row, col, starIndex);
    this._assign(s.row - row, s.col - col, starIndex);
    if (changed) changed.add(starIndex);
    return true;
  }

  _candidates(row, col) {
    const out = [];
    const staticCandidates = this.staticCandidates[row]?.[col] || [];
    for (const i of staticCandidates) {
      if (this._canAssignPair(row, col, i)) out.push(i);
    }
    return out;
  }


  _search(checkStars) {
    if (++this.nodes > this.maxNodes) return null;
    if (this.maxMs && Date.now() - this.startedAt > this.maxMs) {
      this.timedOut = true;
      this.timeoutPartial = this.grid.map(row => row.slice());
      return null;
    }
    const changed = new Set(checkStars || []);
    if (!this._propagate(changed)) return null;
    if (this._matchesForbiddenPartial()) return null;
    this._rememberPartial();
    const key = this.maxDeadCache ? this._stateKey() : null;
    if (key && this.deadCache.has(key)) return null;
    let reachStars = this.rows * this.cols <= 225 ? null : (changed.size ? changed : null);
    if (this.rows * this.cols >= 900 && this.nodes % 250 === 0) reachStars = null;
    if (!this._regionsReachable(reachStars)) {
      this._rememberDead(key);
      return null;
    }
    let best = null;
    let bestCandidates = null;
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        if (this.grid[r][c] !== -1) continue;
        const candidates = this._candidates(r, c);
        if (candidates.length === 0) {
          this._rememberDead(key);
          return null;
        }
        if (!bestCandidates || candidates.length < bestCandidates.length) {
          best = { row: r, col: c };
          bestCandidates = candidates;
          if (candidates.length === 1) break;
        }
      }
      if (bestCandidates && bestCandidates.length === 1) break;
    }
    if (!best) {
      if (this._isFilled() && this._verify()) return this.grid;
      this._rememberDead(key);
      return null;
    }

    bestCandidates.sort((a, b) => this._distance(best.row, best.col, a) - this._distance(best.row, best.col, b));
    // Try each candidate in distance order. Trail-based undo replaces the
    // per-recursion grid clone — _rollback unwinds every write _assignPair and
    // _propagate made during the failed branch.
    for (const starIndex of bestCandidates) {
      const mark = this.trail.length;
      const nextChanged = new Set([starIndex]);
      if (this._assignPair(best.row, best.col, starIndex, nextChanged)) {
        const solved = this._search(nextChanged);
        if (solved) return this.grid;  // leave this.grid pointing at the solved state
      }
      this._rollback(mark);
    }
    this._rememberDead(key);
    return null;
  }

  _matchesForbiddenPartial() {
    for (const cells of this.forbiddenPartials) {
      let matches = true;
      for (const [r, c, v] of cells) {
        if (this.grid[r][c] !== v) { matches = false; break; }
      }
      if (matches) return true;
    }
    return false;
  }

  _rememberPartial() {
    if (!this.maxMs) return;
    let filled = 0;
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        if (this.grid[r][c] !== -1) filled++;
      }
    }
    if (filled > this.bestPartialFilled) {
      this.bestPartialFilled = filled;
      this.bestPartial = this.grid.map(row => row.slice());
    }
  }

  _stateKey() {
    // Each cell value (range -1..numStars-1) maps to a single 16-bit char code,
    // so the key is a fixed-length string of (rows*cols) chars. Faster than the
    // previous += / toString(36) approach because we avoid (a) per-cell number
    // formatting and (b) the O(N²) cost of repeated string concatenation.
    const rows = this.rows, cols = this.cols, grid = this.grid;
    const codes = new Array(rows * cols);
    let i = 0;
    for (let r = 0; r < rows; r++) {
      const row = grid[r];
      for (let c = 0; c < cols; c++) codes[i++] = row[c] + 1;
    }
    return String.fromCharCode.apply(null, codes);
  }

  _rememberDead(key) {
    if (key && this.deadCache.size < this.maxDeadCache) this.deadCache.add(key);
  }

  // changedStars is an OUTPUT accumulator (a Set), not a seed: _assignPair
  // adds each star it assigns to into it so the caller (_search at line 975)
  // can later restrict _regionsReachable to just those stars. Seeding still
  // sweeps every unknown cell up front because we have no incoming "which
  // cells just changed" signal; the dirty-queue optimization kicks in for
  // every subsequent iteration within this call.
  _propagate(changedStars) {
    // candidates(r, c) depends on grid[r][c] itself and on grid[mirror_Y(r, c)]
    // for each Y in staticCandidates[r][c]. So when an assignment lands at
    // (r, c), the only cells whose _candidates result can change are those
    // whose mirror under some star is (r, c) — at most one per star. Re-scan
    // only those instead of the whole grid.
    const rows = this.rows, cols = this.cols, stars = this.stars;
    const N = rows * cols;
    const queue = [];
    const inQueue = new Uint8Array(N);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (this.grid[r][c] === -1) {
          const idx = r * cols + c;
          queue.push(idx);
          inQueue[idx] = 1;
        }
      }
    }
    let qHead = 0;
    while (qHead < queue.length) {
      const idx = queue[qHead++];
      inQueue[idx] = 0;
      const r = (idx / cols) | 0;
      const c = idx - r * cols;
      if (this.grid[r][c] !== -1) continue;
      const candidates = this._candidates(r, c);
      if (candidates.length === 0) return false;
      if (candidates.length !== 1) continue;
      const star = candidates[0];
      // Resolve mirror inline (avoid the {row,col} allocation).
      const sStar = stars[star];
      const mr = sStar.row - r, mc = sStar.col - c;
      if (!this._assignPair(r, c, star, changedStars)) return false;
      // Enqueue every cell whose candidate-mirror set just lost a constraint:
      // for each Y, the cell (sY.row - r, sY.col - c) had (r, c) as its
      // mirror-under-Y, so its _candidates may have shrunk. Same for the
      // freshly-assigned mirror cell at (mr, mc).
      for (let y = 0; y < stars.length; y++) {
        const sY = stars[y];
        const nr1 = sY.row - r, nc1 = sY.col - c;
        if (nr1 >= 0 && nr1 < rows && nc1 >= 0 && nc1 < cols) {
          const ni = nr1 * cols + nc1;
          if (this.grid[nr1][nc1] === -1 && !inQueue[ni]) {
            queue.push(ni); inQueue[ni] = 1;
          }
        }
        const nr2 = sY.row - mr, nc2 = sY.col - mc;
        if (nr2 >= 0 && nr2 < rows && nc2 >= 0 && nc2 < cols) {
          const ni = nr2 * cols + nc2;
          if (this.grid[nr2][nc2] === -1 && !inQueue[ni]) {
            queue.push(ni); inQueue[ni] = 1;
          }
        }
      }
    }
    return true;
  }

  _distance(row, col, starIndex) {
    const s = this.stars[starIndex];
    return Math.abs(2 * row - s.row) + Math.abs(2 * col - s.col);
  }

  _verify() {
    for (let i = 0; i < this.stars.length; i++) {
      if (!this._connected(i)) return false;
    }
    return true;
  }

  _isFilled() {
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        if (this.grid[r][c] === -1) return false;
      }
    }
    return true;
  }

  _regionsReachable(stars) {
    const list = stars ? Array.from(stars) : this.stars.map((_, i) => i);
    for (const i of list) {
      if (!this._regionReachable(i)) return false;
    }
    return true;
  }

  _regionReachable(starIndex) {
    // Hot path: called per star per _search node. Avoid string-key Sets and
    // per-step object allocations by encoding (row, col) into a flat int and
    // using a Uint8Array as the visited bitmap.
    const rows = this.rows, cols = this.cols, grid = this.grid;
    let assigned = 0;
    let startIdx = -1;
    for (let r = 0; r < rows; r++) {
      const row = grid[r];
      for (let c = 0; c < cols; c++) {
        if (row[c] === starIndex) {
          assigned++;
          if (startIdx === -1) startIdx = r * cols + c;
        }
      }
    }
    if (startIdx === -1) return false;

    const seen = new Uint8Array(rows * cols);
    const q = [startIdx];
    seen[startIdx] = 1;
    let reachedAssigned = 0;
    for (let qi = 0; qi < q.length; qi++) {
      const idx = q[qi];
      const r = (idx / cols) | 0;
      const c = idx - r * cols;
      if (grid[r][c] === starIndex) reachedAssigned++;
      // Four-neighbour expansion, inlined to avoid the per-iteration array literal.
      if (r > 0) {
        const ni = idx - cols;
        if (!seen[ni] && (grid[r - 1][c] === starIndex || this._canAssignPair(r - 1, c, starIndex))) {
          seen[ni] = 1; q.push(ni);
        }
      }
      if (r < rows - 1) {
        const ni = idx + cols;
        if (!seen[ni] && (grid[r + 1][c] === starIndex || this._canAssignPair(r + 1, c, starIndex))) {
          seen[ni] = 1; q.push(ni);
        }
      }
      if (c > 0) {
        const ni = idx - 1;
        if (!seen[ni] && (grid[r][c - 1] === starIndex || this._canAssignPair(r, c - 1, starIndex))) {
          seen[ni] = 1; q.push(ni);
        }
      }
      if (c < cols - 1) {
        const ni = idx + 1;
        if (!seen[ni] && (grid[r][c + 1] === starIndex || this._canAssignPair(r, c + 1, starIndex))) {
          seen[ni] = 1; q.push(ni);
        }
      }
    }
    return reachedAssigned === assigned;
  }

  _connected(starIndex) {
    let total = 0;
    let start = null;
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        if (this.grid[r][c] !== starIndex) continue;
        total++;
        if (!start) start = { row: r, col: c };
      }
    }
    if (!start) return false;
    const q = [start];
    const seen = new Set([start.row + ',' + start.col]);
    for (let qi = 0; qi < q.length; qi++) {
      const p = q[qi];
      for (const d of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nr = p.row + d[0], nc = p.col + d[1];
        const key = nr + ',' + nc;
        if (!this._inside(nr, nc) || seen.has(key) || this.grid[nr][nc] !== starIndex) continue;
        seen.add(key);
        q.push({ row: nr, col: nc });
      }
    }
    return seen.size === total;
  }

}

class AquariumSolver {
  /**
   * @param {number[]} rowClues  Water count per row, top-to-bottom.
   * @param {number[]} colClues  Water count per column, left-to-right.
   * @param {number[][]} regionMap  rows × cols matrix of region IDs. Each
   *   region is one connected aquarium; water within it obeys gravity (if
   *   any cell at row r is water, every cell at row >= r in that region is
   *   too).
   * @param {number} rows
   * @param {number} cols
   */
  constructor(rowClues, colClues, regionMap, rows, cols) {
    this.rows = rows;
    this.cols = cols;
    this.rowClues = rowClues;
    this.colClues = colClues;
    this._cellsCount = rows * cols;
    // Soft wall-clock budget. 0 = unlimited (matches the small-puzzle case in
    // NonogramSolver/GalaxiesSolver). Checked sparsely in the search hot
    // loops to keep Date.now() overhead negligible.
    this.maxMs = rows * cols >= 400 ? 8000 : 0;
    this.startedAt = 0;
    this.timedOut = false;

    const raw = {};
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const id = regionMap[r][c];
        (raw[id] || (raw[id] = [])).push(r * cols + c);
      }

    this.aquariums = [];
    for (const id in raw) {
      const cellList = raw[id];
      const byRow = {};
      for (const idx of cellList) {
        const rr = Math.floor(idx / cols);
        let entry = byRow[rr];
        if (!entry) byRow[rr] = entry = { row: rr, count: 0, cells: [] };
        entry.count++;
        entry.cells.push(idx);
      }
      const groups = Object.values(byRow).sort((a, b) => a.row - b.row);
      const maxLvl = groups.length;
      const tRows = [], tCols = [];
      for (const g of groups) {
        tRows.push(g.row);
        for (const idx of g.cells) { const c = idx % cols; if (tCols.indexOf(c) < 0) tCols.push(c); }
      }

      // contribs[lvl].rc[r] = # cells this aquarium fills in row r at water lvl.
      // contribs[lvl].cc[c] = # cells this aquarium fills in col c at water lvl.
      // Dense Int32Arrays (length rows/cols) rather than sparse objects: faster
      // lookups in the _solveRepair / _dpPreprocess hot loops and no `|| 0`.
      const contribs = [];
      for (let lvl = 0; lvl <= maxLvl; lvl++) {
        const rc = new Int32Array(rows);
        const cc = new Int32Array(cols);
        for (let i = maxLvl - lvl; i < maxLvl; i++) {
          const g = groups[i];
          rc[g.row] += g.count;
          for (const idx of g.cells) cc[idx % cols] += 1;
        }
        contribs.push({ rc, cc });
      }
      this.aquariums.push({ id, idx: this.aquariums.length, groups, maxLvl, contribs, tRows, tCols });
    }

    this.waterLevel = {};
    this.d = {};
    for (const aq of this.aquariums) {
      this.waterLevel[aq.id] = -1;
      this.d[aq.id] = { mn: 0, mx: aq.maxLvl };
    }
    this._kc = new Int8Array(this._cellsCount);
    this._searchNodes = 0;
    this._maxSearchNodes = 50000;
    this._deadCache = new Map();
    this._deadCacheMax = 200000;
    this._dpCache = new Map();
    this._dpCacheMax = 500000;
    this._nogoods = [];
    this._nogoodSet = new Set();
    this._nogoodIndex = new Map();
    this._nogoodMax = 50000;
    this._nogoodMaxTerms = 18;
    this._bestPartial = null;
    this._bestPartialFilled = 0;
  }

  /**
   * @param {number[][] | null} initialGrid  Optional partial state (1/-1/0).
   * @returns {SolveResult}
   */
  solve(initialGrid) {
    this._searchNodes = 0;
    this._deadCache.clear();
    this._dpCache.clear();
    this._nogoods = [];
    this._nogoodSet.clear();
    this._nogoodIndex.clear();
    this._bestPartial = null;
    this._bestPartialFilled = 0;
    this._kc.fill(0);
    this.startedAt = Date.now();
    this.timedOut = false;
    if (initialGrid)
      for (let r = 0; r < this.rows; r++)
        for (let c = 0; c < this.cols; c++) {
          const v = initialGrid[r][c];
          if (v !== 0) this._kc[r * this.cols + c] = v;
        }

    for (const aq of this.aquariums) this._initRange(aq);
    this._propagate();
    this._rememberPartial();

    if (this._allAssigned()) {
      this._buildGrid();
      if (!this._verify()) return { solved: false, error: 'verification failed' };
      return { solved: true, grid: this.grid };
    }

    this._dpPreprocess();
    if (!this._dpPairwise() || !this._propagate()) {
      // DP may have partially modified ranges — restore to pre-DP state
      this._deadCache.clear();
      this._dpCache.clear();
      this._nogoods = [];
      this._nogoodSet.clear();
      this._nogoodIndex.clear();
      for (const aq of this.aquariums) { this.waterLevel[aq.id] = -1; this._initRange(aq); }
      this._propagate();
    }
    this._rememberPartial();

    if (this._allAssigned()) {
      this._buildGrid();
      if (!this._verify()) return { solved: false, error: 'verification failed' };
      return { solved: true, grid: this.grid };
    }

    const repair = this._solveRepair();
    if (repair?.solved) {
      this._buildGrid();
      if (!this._verify()) return { solved: false, error: 'verification failed' };
      return { solved: true, grid: this.grid };
    }

    const result = this._backtrack();
    if (!result.solved) {
      return this._withPartial(result);
    }
    this._buildGrid();
    if (!this._verify()) return { solved: false, error: 'verification failed' };
    return { solved: true, grid: this.grid };
  }

  _withPartial(result) {
    if (!result.error) result.error = 'no solution found';
    if (this._bestPartial) {
      result.partialGrid = this._bestPartial.map(row => row.slice());
      result.partialFilled = this._bestPartialFilled;
    }
    return result;
  }

  _rememberPartial() {
    this._buildGrid();
    let filled = 0;
    for (const row of this.grid) for (const v of row) if (v !== 0) filled++;
    if (filled > this._bestPartialFilled) {
      this._bestPartialFilled = filled;
      this._bestPartial = this.grid.map(row => row.slice());
    }
  }

  _snap() {
    const N = this.aquariums.length;
    const mn = new Int32Array(N), mx = new Int32Array(N), wl = new Int32Array(N);
    for (let i = 0; i < N; i++) {
      const aq = this.aquariums[i];
      mn[i] = this.d[aq.id].mn; mx[i] = this.d[aq.id].mx; wl[i] = this.waterLevel[aq.id];
    }
    return { mn, mx, wl };
  }

  _restore(s) {
    for (let i = 0; i < this.aquariums.length; i++) {
      const aq = this.aquariums[i];
      this.d[aq.id].mn = s.mn[i]; this.d[aq.id].mx = s.mx[i]; this.waterLevel[aq.id] = s.wl[i];
    }
  }

  _initRange(aq) {
    let mn = 0, mx = aq.maxLvl;
    const kc = this._kc;
    for (let i = 0; i < aq.maxLvl; i++) {
      let water = false, air = false;
      for (const idx of aq.groups[i].cells) {
        const v = kc[idx];
        if (v === 1) water = true;
        else if (v === -1) air = true;
        if (water && air) break;
      }
      if (water) mn = Math.max(mn, aq.maxLvl - i);
      if (air) mx = Math.min(mx, aq.maxLvl - i - 1);
    }
    this.d[aq.id].mn = mn; this.d[aq.id].mx = mx;
  }

  _allAssigned() {
    for (const aq of this.aquariums) if (this.waterLevel[aq.id] < 0) return false;
    return true;
  }

  _propagate() {
    const rowC = this.rows, colC = this.cols;
    const rc = this.rowClues, cc = this.colClues;

    const baseRL = Array(rowC).fill(0), baseRH = Array(rowC).fill(0);
    const baseCL = Array(colC).fill(0), baseCH = Array(colC).fill(0);

    const vars = [];
    for (const aq of this.aquariums) {
      if (this.waterLevel[aq.id] >= 0) {
        const ct = aq.contribs[this.waterLevel[aq.id]];
        for (let r = 0; r < rowC; r++) { const v = ct.rc[r]; baseRL[r] += v; baseRH[r] += v; }
        for (let c = 0; c < colC; c++) { const v = ct.cc[c]; baseCL[c] += v; baseCH[c] += v; }
      } else {
        vars.push(aq);
      }
    }

    // bounds check even when all assigned
    {
      const rowLo = baseRL.slice(), rowHi = baseRH.slice();
      const colLo = baseCL.slice(), colHi = baseCH.slice();
      for (const aq of vars) {
        if (this.waterLevel[aq.id] >= 0) continue;
        const { mn, mx } = this.d[aq.id];
        const clo = aq.contribs[mn], chi = aq.contribs[mx];
        for (let r = 0; r < rowC; r++) { rowLo[r] += clo.rc[r]; rowHi[r] += chi.rc[r]; }
        for (let c = 0; c < colC; c++) { colLo[c] += clo.cc[c]; colHi[c] += chi.cc[c]; }
      }
      for (let r = 0; r < rowC; r++) if (rowLo[r] > rc[r] || rowHi[r] < rc[r]) return false;
      for (let c = 0; c < colC; c++) if (colLo[c] > cc[c] || colHi[c] < cc[c]) return false;
    }
    if (vars.length === 0) return true;

    let it = 0;
    while (it++ < 100) {
      let ch = false;

      const rowLo = baseRL.slice(), rowHi = baseRH.slice();
      const colLo = baseCL.slice(), colHi = baseCH.slice();

      for (const aq of vars) {
        if (this.waterLevel[aq.id] >= 0) continue;
        const { mn, mx } = this.d[aq.id];
        const clo = aq.contribs[mn], chi = aq.contribs[mx];
        for (let r = 0; r < rowC; r++) { rowLo[r] += clo.rc[r]; rowHi[r] += chi.rc[r]; }
        for (let c = 0; c < colC; c++) { colLo[c] += clo.cc[c]; colHi[c] += chi.cc[c]; }
      }

      for (let r = 0; r < rowC; r++) if (rowLo[r] > rc[r] || rowHi[r] < rc[r]) return false;
      for (let c = 0; c < colC; c++) if (colLo[c] > cc[c] || colHi[c] < cc[c]) return false;

      for (const aq of vars) {
        if (this.waterLevel[aq.id] >= 0) continue;
        const { mn, mx } = this.d[aq.id];
        for (let r = 0; r < rowC; r++) {
          const otherLo = rowLo[r] - (aq.contribs[mn].rc[r]);
          const otherHi = rowHi[r] - (aq.contribs[mx].rc[r]);
          const needed = rc[r] - otherHi, avail = rc[r] - otherLo;
          if (needed > 0 || avail <= 0) {
            let nm = mx, nx = mn;
            for (let l = mn; l <= mx; l++) {
              const c = aq.contribs[l].rc[r];
              if (c >= needed && c <= avail) {
                if (l < nm) nm = l;
                if (l > nx) nx = l;
              }
            }
            if (nm !== mn || nx !== mx) {
              const newMn = Math.max(this.d[aq.id].mn, nm);
              const newMx = Math.min(this.d[aq.id].mx, nx);
              if (newMn > newMx) return false;
              if (newMn !== this.d[aq.id].mn || newMx !== this.d[aq.id].mx) {
                this.d[aq.id].mn = newMn; this.d[aq.id].mx = newMx; ch = true;
              }
            }
          }
        }
        const nmn = this.d[aq.id].mn, nmx = this.d[aq.id].mx;
        for (let c = 0; c < colC; c++) {
          const otherLo = colLo[c] - (aq.contribs[nmn].cc[c]);
          const otherHi = colHi[c] - (aq.contribs[nmx].cc[c]);
          const needed = cc[c] - otherHi, avail = cc[c] - otherLo;
          if (needed > 0 || avail <= 0) {
            let nm = nmx, nx = nmn;
            for (let l = nmn; l <= nmx; l++) {
              const ccv = aq.contribs[l].cc[c];
              if (ccv >= needed && ccv <= avail) {
                if (l < nm) nm = l;
                if (l > nx) nx = l;
              }
            }
            if (nm !== nmn || nx !== nmx) {
              this.d[aq.id].mn = nm; this.d[aq.id].mx = nx; ch = true;
              if (nm > nx) return false;
            }
          }
        }
      }

      let vi = 0;
      while (vi < vars.length) {
        const aq = vars[vi];
        if (this.waterLevel[aq.id] >= 0) { vi++; continue; }
        const { mn, mx } = this.d[aq.id];
        if (mn > mx) return false;
        if (mn === mx) {
          this.waterLevel[aq.id] = mn;
          const ct = aq.contribs[mn];
          for (let r = 0; r < rowC; r++) { const v = ct.rc[r]; baseRL[r] += v; baseRH[r] += v; rowLo[r] += v; rowHi[r] += v; }
          for (let c = 0; c < colC; c++) { const v = ct.cc[c]; baseCL[c] += v; baseCH[c] += v; colLo[c] += v; colHi[c] += v; }
          vars.splice(vi, 1);
          ch = true;
          continue;
        }
        vi++;
      }

      if (!ch) break;
    }
    return true;
  }

  _dpPreprocess() {
    const rowC = this.rows, colC = this.cols;
    const rc = this.rowClues, cc = this.colClues;

    for (let pass = 0; pass < 5; pass++) {
      const baseR = Array(rowC).fill(0), baseC = Array(colC).fill(0);
      const vars = [];
      for (const aq of this.aquariums) {
        if (this.waterLevel[aq.id] >= 0) {
          const ct = aq.contribs[this.waterLevel[aq.id]];
          for (let r = 0; r < rowC; r++) { const v = ct.rc[r]; baseR[r] += v; }
          for (let c = 0; c < colC; c++) { const v = ct.cc[c]; baseC[c] += v; }
        } else {
          vars.push(aq);
        }
      }
      if (vars.length < 2) return;

      const rLookup = Array.from({ length: rowC }, () => []);
      const cLookup = Array.from({ length: colC }, () => []);
      for (const aq of vars) {
        for (const r of aq.tRows) rLookup[r].push(aq);
        for (const c of aq.tCols) cLookup[c].push(aq);
      }

      const narrow = (lineVars, getContrib, clue, cachePrefix) => {
        const N = lineVars.length;
        if (N < 2 || clue <= 0) return { ok: true };
        const cacheKey = cachePrefix + ':' + clue + ':' + lineVars.map(aq => {
          const d = this.d[aq.id];
          return aq.id + '=' + d.mn + '-' + d.mx;
        }).join(',');
        const cached = this._cacheGet(cacheKey);
        if (cached !== undefined) {
          if (cached === null) return { ok: false };
          let narrowed = false;
          for (let i = 0; i < N; i++) {
            const aq = lineVars[i];
            const d = this.d[aq.id];
            const [mn, mx] = cached[i];
            if (mn > mx) return { ok: false };
            if (mn !== d.mn || mx !== d.mx) {
              d.mn = mn;
              d.mx = mx;
              narrowed = true;
            }
          }
          return { ok: true, narrowed };
        }
        const stride = clue + 1;
        const dp = new Uint8Array((N + 1) * stride);
        dp[0] = 1;
        for (let i = 0; i < N; i++) {
          const aq = lineVars[i];
          const { mn, mx } = this.d[aq.id];
          const bi = i * stride, ni = (i + 1) * stride;
          let any = 0;
          for (let s = 0; s <= clue; s++) {
            if (!dp[bi + s]) continue;
            for (let l = mn; l <= mx; l++) {
              const c = getContrib(aq, l);
              const ns = s + c;
              if (ns <= clue) { dp[ni + ns] = 1; any = 1; }
            }
          }
          if (!any) { this._cacheSet(cacheKey, null); return { ok: false }; }
        }
        if (!dp[N * stride + clue]) { this._cacheSet(cacheKey, null); return { ok: false }; }

        let narrowed = false;
        const cachedRanges = [];
        for (let i = N - 1; i >= 0; i--) {
          const aq = lineVars[i];
          const d = this.d[aq.id];
          const om = d.mn, ox = d.mx;
          let nm = ox, nx = om;
          const bi = i * stride, ni = (i + 1) * stride;
          for (let s = 0; s <= clue; s++) {
            if (!dp[bi + s]) continue;
            for (let l = om; l <= ox; l++) {
              const c = getContrib(aq, l);
              const ns = s + c;
              if (ns <= clue && dp[ni + ns]) {
                if (l < nm) nm = l;
                if (l > nx) nx = l;
              }
            }
          }
          if (nm > nx) { this._cacheSet(cacheKey, null); return { ok: false }; }
          if (nm !== om || nx !== ox) { d.mn = nm; d.mx = nx; narrowed = true; }
          cachedRanges[i] = [nm, nx];
        }
        this._cacheSet(cacheKey, cachedRanges);
        return { ok: true, narrowed };
      };

      let changed = false;
      for (let r = 0; r < rowC; r++) {
        const adj = rc[r] - baseR[r];
        if (adj < 0) return;
        if (rLookup[r].length > 1 && adj > 0) {
          const nr = narrow(rLookup[r], (aq, l) => aq.contribs[l].rc[r], adj, 'r' + r);
          if (!nr.ok) return;
          if (nr.narrowed) changed = true;
        }
      }
      for (let c = 0; c < colC; c++) {
        const adj = cc[c] - baseC[c];
        if (adj < 0) return;
        if (cLookup[c].length > 1 && adj > 0) {
          const nr = narrow(cLookup[c], (aq, l) => aq.contribs[l].cc[c], adj, 'c' + c);
          if (!nr.ok) return;
          if (nr.narrowed) changed = true;
        }
      }

      // After DP, auto-fix any singletons
      for (const aq of vars) {
        if (this.waterLevel[aq.id] >= 0) continue;
        const { mn, mx } = this.d[aq.id];
        if (mn === mx && mn >= 0) {
          this.waterLevel[aq.id] = mn;
          changed = true;
        }
      }

      if (!changed) break;
    }
  }

  _dpPairwise() {
    const H = this.rows, W = this.cols;
    const rc = this.rowClues, cc = this.colClues;

    const baseR = Array(H).fill(0), baseC = Array(W).fill(0);
    const allVars = [], idMap = {};
    for (const aq of this.aquariums) {
      idMap[aq.id] = allVars.length;
      if (this.waterLevel[aq.id] >= 0) {
        const ct = aq.contribs[this.waterLevel[aq.id]];
        for (let r = 0; r < H; r++) { const v = ct.rc[r]; baseR[r] += v; }
        for (let c = 0; c < W; c++) { const v = ct.cc[c]; baseC[c] += v; }
      } else {
        allVars.push(aq);
      }
    }

    // Build for each row the list of variable indices that have cells in that row
    const rowVars = Array.from({ length: H }, () => []);
    for (let vi = 0; vi < allVars.length; vi++) {
      const aq = allVars[vi];
      for (const r of aq.tRows) rowVars[r].push(vi);
    }

    // Process adjacent row pairs
    for (let r = 0; r < H - 1; r++) {
      const adj1 = rc[r] - baseR[r], adj2 = rc[r + 1] - baseR[r + 1];
      if (adj1 < 0 || adj2 < 0) return false;

      const viSet = new Set([...rowVars[r], ...rowVars[r + 1]]);
      const vList = [...viSet];
      if (vList.length < 2) continue;

      const ranges = [];
      const vars = [];
      for (const vi of vList) {
        const aq = allVars[vi];
        if (this.waterLevel[aq.id] >= 0) continue;
        const { mn, mx } = this.d[aq.id];
        ranges.push(this.d[aq.id]);
        const levels = [];
        for (let l = mn; l <= mx; l++) levels.push(l);
        vars.push({ levels, id: aq.id });
      }
      if (vars.length < 2) continue;

      const getPair = (lvl, id) => {
        const aq = allVars[idMap[id]];
        const ct = aq.contribs[lvl];
        return [(ct.rc[r]), (ct.rc[r + 1])];
      };

      const res = this._narrowLevels(adj1, adj2, vars, getPair, ranges, 'rr' + r);
      if (!res.ok) return false;
    }

    // Process adjacent column pairs
    const colVars = Array.from({ length: W }, () => []);
    for (let vi = 0; vi < allVars.length; vi++) {
      const aq = allVars[vi];
      for (const c of aq.tCols) colVars[c].push(vi);
    }

    for (let c = 0; c < W - 1; c++) {
      const adj1 = cc[c] - baseC[c], adj2 = cc[c + 1] - baseC[c + 1];
      if (adj1 < 0 || adj2 < 0) return false;

      const viSet = new Set([...colVars[c], ...colVars[c + 1]]);
      const vList = [...viSet];
      if (vList.length < 2) continue;

      const ranges = [];
      const vars = [];
      for (const vi of vList) {
        const aq = allVars[vi];
        if (this.waterLevel[aq.id] >= 0) continue;
        const { mn, mx } = this.d[aq.id];
        ranges.push(this.d[aq.id]);
        const levels = [];
        for (let l = mn; l <= mx; l++) levels.push(l);
        vars.push({ levels, id: aq.id });
      }
      if (vars.length < 2) continue;

      const getPair = (lvl, id) => {
        const aq = allVars[idMap[id]];
        const ct = aq.contribs[lvl];
        return [(ct.cc[c]), (ct.cc[c + 1])];
      };

      const res = this._narrowLevels(adj1, adj2, vars, getPair, ranges, 'cc' + c);
      if (!res.ok) return false;
    }

    return true;
  }

  _levelOrder(mn, mx) {
    const order = [];
    let lo = mn, hi = mx;
    while (lo <= hi) {
      order.push(lo);
      if (lo !== hi) order.push(hi);
      lo++; hi--;
    }
    return order;
  }

  // Two-dimensional DP that narrows each variable's water-level range so the
  // pair of clue sums (pairClue1, pairClue2) is still reachable across the
  // adjacent row/col pair. Memoized via _cacheGet / _cacheSet. Extracted from
  // _dpPairwise.
  //   vars     : [{ id, levels: [lvl...] }, ...]
  //   getPair  : (lvl, id) → [contribClue1, contribClue2]
  //   ranges   : aligned with vars; each {mn, mx} gets tightened in place.
  // Returns { ok: false } on contradiction, otherwise { ok: true, changed }.
  _narrowLevels(pairClue1, pairClue2, vars, getPair, ranges, cachePrefix) {
    const n = vars.length;
    if (n === 0) return { ok: true, changed: false };
    const cacheKey = cachePrefix + ':' + pairClue1 + ',' + pairClue2 + ':' + vars.map((v, i) => {
      const d = ranges[i];
      return v.id + '=' + d.mn + '-' + d.mx;
    }).join(',');
    const cached = this._cacheGet(cacheKey);
    if (cached !== undefined) {
      if (cached === null) return { ok: false };
      let changed = false;
      for (let i = 0; i < n; i++) {
        const d = ranges[i];
        const [mn, mx] = cached[i];
        if (mn > mx) return { ok: false };
        if (mn !== d.mn || mx !== d.mx) { d.mn = mn; d.mx = mx; changed = true; }
      }
      return { ok: true, changed };
    }
    const max1 = pairClue1, max2 = pairClue2;
    const sz1 = max1 + 1, sz2 = max2 + 1;

    // Forward DP
    const fwd = new Array(n + 1);
    fwd[0] = new Uint8Array(sz1 * sz2);
    fwd[0][0] = 1;
    for (let i = 0; i < n; i++) {
      const cur = fwd[i];
      const next = new Uint8Array(sz1 * sz2);
      const { levels } = vars[i];
      for (let s = 0; s < sz1 * sz2; s++) {
        if (!cur[s]) continue;
        const s1 = Math.floor(s / sz2), s2 = s % sz2;
        for (const lvl of levels) {
          const [c1, c2] = getPair(lvl, vars[i].id);
          const ns1 = s1 + c1, ns2 = s2 + c2;
          if (ns1 <= max1 && ns2 <= max2) next[ns1 * sz2 + ns2] = 1;
        }
      }
      fwd[i + 1] = next;
    }

    // Backward DP
    const bwd = new Array(n + 1);
    bwd[n] = new Uint8Array(sz1 * sz2);
    bwd[n][0] = 1;
    for (let i = n - 1; i >= 0; i--) {
      const cur = bwd[i + 1];
      const next = new Uint8Array(sz1 * sz2);
      const { levels } = vars[i];
      for (let s = 0; s < sz1 * sz2; s++) {
        if (!cur[s]) continue;
        const s1 = Math.floor(s / sz2), s2 = s % sz2;
        for (const lvl of levels) {
          const [c1, c2] = getPair(lvl, vars[i].id);
          const ns1 = s1 + c1, ns2 = s2 + c2;
          if (ns1 <= max1 && ns2 <= max2) next[ns1 * sz2 + ns2] = 1;
        }
      }
      bwd[i] = next;
    }

    if (!fwd[n][pairClue1 * sz2 + pairClue2]) { this._cacheSet(cacheKey, null); return { ok: false }; }

    // For each variable, check each level
    let changed = false;
    const cachedRanges = [];
    for (let i = 0; i < n; i++) {
      const d = ranges[i];
      const { levels, id } = vars[i];
      let nmn = 999, nmx = -1;
      for (const lvl of levels) {
        const [c1, c2] = getPair(lvl, id);
        const need1 = pairClue1 - c1, need2 = pairClue2 - c2;
        if (need1 < 0 || need2 > max2) continue;
        // Check if fwd[i] + bwd[i+1] can fill need1, need2
        let ok = false;
        const f = fwd[i], b = bwd[i + 1];
        for (let s = 0; s < sz1 * sz2 && !ok; s++) {
          if (!f[s]) continue;
          const s1 = Math.floor(s / sz2), s2 = s % sz2;
          const r1 = need1 - s1, r2 = need2 - s2;
          if (r1 >= 0 && r1 <= max1 && r2 >= 0 && r2 <= max2 && b[r1 * sz2 + r2]) ok = true;
        }
        if (ok) {
          if (lvl < nmn) nmn = lvl;
          if (lvl > nmx) nmx = lvl;
        }
      }
      if (nmn > nmx) { this._cacheSet(cacheKey, null); return { ok: false }; }
      if (nmn !== d.mn || nmx !== d.mx) { d.mn = nmn; d.mx = nmx; changed = true; }
      cachedRanges[i] = [nmn, nmx];
    }
    this._cacheSet(cacheKey, cachedRanges);
    return { ok: true, changed };
  }

  _cacheKey() {
    const parts = [];
    for (const aq of this.aquariums) {
      const lvl = this.waterLevel[aq.id];
      if (lvl >= 0) {
        parts.push(lvl);
      } else {
        const d = this.d[aq.id];
        parts.push(d.mn, ':', d.mx);
      }
      parts.push('|');
    }
    return parts.join('');
  }

  _rememberDead(key) {
    if (this._deadCache.has(key)) return;
    if (this._deadCache.size >= this._deadCacheMax) {
      this._deadCache.delete(this._deadCache.keys().next().value);
    }
    this._deadCache.set(key, 1);
  }

  _assignmentTokens() {
    const tokens = [];
    for (const aq of this.aquariums) {
      const lvl = this.waterLevel[aq.id];
      if (lvl >= 0) tokens.push(aq.id + '=' + lvl);
    }
    return tokens;
  }

  _learnNogood(tokens) {
    if (!tokens.length || tokens.length > this._nogoodMaxTerms) return;
    const key = tokens.join(',');
    if (this._nogoodSet.has(key)) return;
    if (this._nogoods.length >= this._nogoodMax) {
      const old = this._nogoods.shift();
      this._nogoodSet.delete(old.key);
      const bucket = this._nogoodIndex.get(old.first);
      if (bucket) {
        const idx = bucket.indexOf(old);
        if (idx >= 0) bucket.splice(idx, 1);
        if (bucket.length === 0) this._nogoodIndex.delete(old.first);
      }
    }
    const entry = { key, tokens: tokens.slice(), first: tokens[0] };
    this._nogoods.push(entry);
    this._nogoodSet.add(key);
    let bucket = this._nogoodIndex.get(entry.first);
    if (!bucket) this._nogoodIndex.set(entry.first, bucket = []);
    bucket.push(entry);
  }

  _hasNogood(tokens) {
    if (!tokens.length || this._nogoods.length === 0) return false;
    const tokenSet = new Set(tokens);
    for (const token of tokens) {
      const bucket = this._nogoodIndex.get(token);
      if (!bucket) continue;
      for (const entry of bucket) {
        if (entry.tokens.length > tokens.length) continue;
        let ok = true;
        for (const t of entry.tokens) {
          if (!tokenSet.has(t)) { ok = false; break; }
        }
        if (ok) return true;
      }
    }
    return false;
  }

  _cacheGet(key) {
    return this._dpCache.get(key);
  }

  _cacheSet(key, value) {
    if (this._dpCache.has(key)) return;
    if (this._dpCache.size >= this._dpCacheMax) {
      this._dpCache.delete(this._dpCache.keys().next().value);
    }
    this._dpCache.set(key, value);
  }

  // Deterministic xorshift32 PRNG seeded from puzzle shape (clues + aquarium
  // sizes), so a re-run on the same puzzle picks the same repair path.
  _makeRepairRng(rc, cc, vars) {
    let seed = 2166136261;
    for (const n of rc.concat(cc)) seed = Math.imul(seed ^ n, 16777619) >>> 0;
    for (const aq of vars) seed = Math.imul(seed ^ (aq.maxLvl + aq.groups.length), 16777619) >>> 0;
    const rand = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 4294967296;
    };
    const pick = arr => arr[Math.floor(rand() * arr.length)];
    return { rand, pick };
  }

  _solveRepair(maxRestarts = 80, maxSteps = 12000) {
    const H = this.rows, W = this.cols;
    const rc = this.rowClues, cc = this.colClues;
    const vars = this.aquariums;

    // levels[aq.idx] = array of possible water levels for that aquarium.
    // Indexed by aq.idx (integer) rather than aq.id (string) — array lookup is
    // faster than object-property lookup in the inner repair loop.
    const levels = new Array(vars.length);
    for (let vi = 0; vi < vars.length; vi++) {
      const aq = vars[vi];
      if (this.waterLevel[aq.id] >= 0) {
        levels[vi] = [this.waterLevel[aq.id]];
      } else {
        const d = this.d[aq.id];
        if (d.mn > d.mx) return null;
        const out = [];
        for (let l = d.mn; l <= d.mx; l++) out.push(l);
        levels[vi] = out;
      }
    }

    // lineVars[line] = aquariums that touch that row/col AND have >1 possible
    // level. Pre-filtering by .length > 1 here (it's constant for this call)
    // saves a .filter() allocation in every step of the inner loop.
    const lineVars = Array.from({ length: H + W }, () => []);
    for (let vi = 0; vi < vars.length; vi++) {
      const aq = vars[vi];
      if (levels[vi].length <= 1) continue;
      for (let i = 0; i < aq.tRows.length; i++) lineVars[aq.tRows[i]].push(aq);
      for (let i = 0; i < aq.tCols.length; i++) lineVars[H + aq.tCols[i]].push(aq);
    }

    const { rand, pick } = this._makeRepairRng(rc, cc, vars);

    const violation = (rowS, colS) => {
      let v = 0;
      for (let r = 0; r < H; r++) v += Math.abs(rowS[r] - rc[r]);
      for (let c = 0; c < W; c++) v += Math.abs(colS[c] - cc[c]);
      return v;
    };

    for (let restart = 0; restart < maxRestarts; restart++) {
      // assign[aq.idx] = current water level. Int32Array vs object: faster
      // indexed access in the inner hot loop.
      const assign = new Int32Array(vars.length);
      const rowS = new Int32Array(H), colS = new Int32Array(W);

      for (let vi = 0; vi < vars.length; vi++) {
        const aq = vars[vi];
        const ls = levels[vi];
        const lvl = pick(ls);
        assign[vi] = lvl;
        const ct = aq.contribs[lvl];
        const ctRc = ct.rc, ctCc = ct.cc;
        for (let r = 0; r < H; r++) rowS[r] += ctRc[r];
        for (let c = 0; c < W; c++) colS[c] += ctCc[c];
      }

      let cur = violation(rowS, colS);
      for (let step = 0; step < maxSteps; step++) {
        if (this.maxMs && (step & 0xFF) === 0 &&
            Date.now() - this.startedAt > this.maxMs) {
          this.timedOut = true;
          return null;
        }
        if (cur === 0) {
          for (let vi = 0; vi < vars.length; vi++) {
            const aq = vars[vi];
            const lvl = assign[vi];
            this.waterLevel[aq.id] = lvl;
            this.d[aq.id].mn = this.d[aq.id].mx = lvl;
          }
          return { solved: true };
        }

        const badLines = [];
        for (let r = 0; r < H; r++) if (rowS[r] !== rc[r]) badLines.push(r);
        for (let c = 0; c < W; c++) if (colS[c] !== cc[c]) badLines.push(H + c);
        if (badLines.length === 0) continue;

        const line = pick(badLines);
        const candidates = lineVars[line];
        if (candidates.length === 0) continue;

        let bestMoves = [];
        let bestV = cur;
        for (let ci = 0; ci < candidates.length; ci++) {
          const aq = candidates[ci];
          const aqIdx = aq.idx;
          const oldLvl = assign[aqIdx];
          const oldCt = aq.contribs[oldLvl];
          const aqLevels = levels[aqIdx];
          const tRows = aq.tRows, tCols = aq.tCols;
          const tRowsLen = tRows.length, tColsLen = tCols.length;
          const oldRc = oldCt.rc, oldCc = oldCt.cc;
          for (let li = 0; li < aqLevels.length; li++) {
            const lvl = aqLevels[li];
            if (lvl === oldLvl) continue;
            const ct = aq.contribs[lvl];
            const ctRc = ct.rc, ctCc = ct.cc;
            let nextV = cur;
            for (let i = 0; i < tRowsLen; i++) {
              const r = tRows[i];
              const before = Math.abs(rowS[r] - rc[r]);
              const after = Math.abs(rowS[r] + ctRc[r] - oldRc[r] - rc[r]);
              nextV += after - before;
            }
            for (let i = 0; i < tColsLen; i++) {
              const c = tCols[i];
              const before = Math.abs(colS[c] - cc[c]);
              const after = Math.abs(colS[c] + ctCc[c] - oldCc[c] - cc[c]);
              nextV += after - before;
            }
            if (nextV < bestV) {
              bestV = nextV;
              bestMoves = [{ aq, aqIdx, lvl, oldCt, ct, nextV }];
            } else if (nextV === bestV) {
              bestMoves.push({ aq, aqIdx, lvl, oldCt, ct, nextV });
            }
          }
        }

        let move = null;
        let moveV = cur;
        if (bestMoves.length > 0 && (bestV < cur || rand() < 0.05)) {
          move = pick(bestMoves);
          moveV = move.nextV;
        } else {
          // Random move — compute its violation incrementally rather than
          // doing the full O(H+W) recompute after applying it.
          const aq = candidates[Math.floor(rand() * candidates.length)];
          const aqIdx = aq.idx;
          const oldLvl = assign[aqIdx];
          const aqLevels = levels[aqIdx];
          // Inline filter+pick to avoid array allocation.
          let pickIdx = Math.floor(rand() * (aqLevels.length - 1));
          let lvl = -1;
          for (let i = 0; i < aqLevels.length; i++) {
            if (aqLevels[i] === oldLvl) continue;
            if (pickIdx === 0) { lvl = aqLevels[i]; break; }
            pickIdx--;
          }
          const oldCt = aq.contribs[oldLvl];
          const ct = aq.contribs[lvl];
          const ctRc = ct.rc, ctCc = ct.cc, oldRc = oldCt.rc, oldCc = oldCt.cc;
          const tRows = aq.tRows, tCols = aq.tCols;
          let nextV = cur;
          for (let i = 0; i < tRows.length; i++) {
            const r = tRows[i];
            const before = Math.abs(rowS[r] - rc[r]);
            const after = Math.abs(rowS[r] + ctRc[r] - oldRc[r] - rc[r]);
            nextV += after - before;
          }
          for (let i = 0; i < tCols.length; i++) {
            const c = tCols[i];
            const before = Math.abs(colS[c] - cc[c]);
            const after = Math.abs(colS[c] + ctCc[c] - oldCc[c] - cc[c]);
            nextV += after - before;
          }
          move = { aq, aqIdx, lvl, oldCt, ct };
          moveV = nextV;
        }

        assign[move.aqIdx] = move.lvl;
        const mRc = move.ct.rc, mCc = move.ct.cc, moRc = move.oldCt.rc, moCc = move.oldCt.cc;
        const mTRows = move.aq.tRows, mTCols = move.aq.tCols;
        for (let i = 0; i < mTRows.length; i++) {
          const r = mTRows[i];
          rowS[r] += mRc[r] - moRc[r];
        }
        for (let i = 0; i < mTCols.length; i++) {
          const c = mTCols[i];
          colS[c] += mCc[c] - moCc[c];
        }
        cur = moveV;
      }
    }

    return null;
  }

  _backtrack() {
    if (++this._searchNodes > this._maxSearchNodes) {
      return { solved: false, error: 'search limit exceeded' };
    }
    // Time check every 1024 nodes — Date.now() is cheap but not free, and
    // 1024 nodes is well below the cost of a single millisecond of search.
    if (this.maxMs && (this._searchNodes & 0x3FF) === 0 &&
        Date.now() - this.startedAt > this.maxMs) {
      this.timedOut = true;
      return { solved: false, error: 'time limit exceeded' };
    }
    const assignedTokens = this._assignmentTokens();
    if (this._hasNogood(assignedTokens)) return { solved: false, error: 'contradiction' };

    let best = null;
    for (const aq of this.aquariums) {
      if (this.waterLevel[aq.id] >= 0) continue;
      const { mn, mx } = this.d[aq.id];
      if (mn > mx) return { solved: false };
      if (!best || (mx - mn) < (this.d[best.id].mx - this.d[best.id].mn)) best = aq;
    }
    if (!best) return { solved: true };

    const cacheKey = this._cacheKey();
    if (this._deadCache.has(cacheKey)) return { solved: false };

    const { mn, mx } = this.d[best.id];
forLoop:
    for (const lvl of this._levelOrder(mn, mx)) {
      const snap = this._snap();
      this.waterLevel[best.id] = lvl;
      this.d[best.id].mn = this.d[best.id].mx = lvl;
      const branchTokens = assignedTokens.concat(best.id + '=' + lvl);
      if (!this._propagate()) { this._learnNogood(branchTokens); this._restore(snap); continue; }
      this._rememberPartial();
      this._dpPreprocess();
      if (!this._dpPairwise()) { this._learnNogood(branchTokens); this._restore(snap); continue forLoop; }
      this._rememberPartial();
      for (const aq of this.aquariums) {
        if (this.waterLevel[aq.id] < 0 && this.d[aq.id].mn > this.d[aq.id].mx)
          { this._learnNogood(branchTokens); this._restore(snap); continue forLoop; }
      }

      if (this._allAssigned()) return { solved: true };

      const r = this._backtrack();
      if (r.solved) return r;
      if (r.error) { this._restore(snap); return r; }
      this._learnNogood(branchTokens);
      this._restore(snap);
    }
    this._learnNogood(assignedTokens);
    this._rememberDead(cacheKey);
    return { solved: false };
  }

  _buildGrid() {
    const cols = this.cols;
    this.grid = Array.from({ length: this.rows }, () => Array(cols).fill(0));
    for (const aq of this.aquariums) {
      const lvl = this.waterLevel[aq.id];
      if (lvl < 0) continue;
      for (let i = 0; i < aq.maxLvl; i++) {
        const isWater = i >= aq.maxLvl - lvl;
        const val = isWater ? 1 : -1;
        for (const idx of aq.groups[i].cells) this.grid[Math.floor(idx / cols)][idx % cols] = val;
      }
    }
  }

  _verify() {
    for (let r = 0; r < this.rows; r++) {
      let n = 0;
      for (let c = 0; c < this.cols; c++) if (this.grid[r][c] === 1) n++;
      if (n !== this.rowClues[r]) return false;
    }
    for (let c = 0; c < this.cols; c++) {
      let n = 0;
      for (let r = 0; r < this.rows; r++) if (this.grid[r][c] === 1) n++;
      if (n !== this.colClues[c]) return false;
    }
    for (const aq of this.aquariums) {
      let seenAir = false;
      for (let i = aq.maxLvl - 1; i >= 0; i--)
        for (const idx of aq.groups[i].cells) {
          const v = this.grid[Math.floor(idx / this.cols)][idx % this.cols];
          if (v === -1) seenAir = true;
          else if (v === 1 && seenAir) return false;
        }
    }
    return true;
  }

  isComplete() {
    for (let r = 0; r < this.rows; r++)
      for (let c = 0; c < this.cols; c++)
        if (this.grid[r][c] === 0) return false;
    return this._verify();
  }

  _findForcedCells(currentGrid) {
    const cm = Array.from({ length: this.rows }, () => Array(this.cols).fill(0));
    for (const aq of this.aquariums)
      for (const g of aq.groups)
        for (const idx of g.cells)
          cm[Math.floor(idx / this.cols)][idx % this.cols] = aq.id;
    const tmp = new AquariumSolver(this.rowClues, this.colClues, cm, this.rows, this.cols);
    const kc = tmp._kc;
    for (let r = 0; r < this.rows; r++)
      for (let c = 0; c < this.cols; c++) {
        const v = currentGrid[r][c];
        if (v !== 0) kc[r * this.cols + c] = v;
      }
    for (const aq of tmp.aquariums) tmp._initRange(aq);
    if (!tmp._propagate()) return null;

    const cellToGroup = new Map();
    for (const aq of tmp.aquariums)
      for (let i = 0; i < aq.maxLvl; i++)
        for (const idx of aq.groups[i].cells)
          cellToGroup.set(idx, { aq, groupIdx: i });

    const forced = [];
    for (const aq of tmp.aquariums) {
      const { mn, mx } = tmp.d[aq.id];
      const forcedWaterFrom = aq.maxLvl - mn;
      for (let i = 0; i < aq.maxLvl; i++) {
        let value = 0;
        if (i >= forcedWaterFrom) value = 1;
        else if (i < aq.maxLvl - mx) value = -1;
        if (value === 0) continue;
        for (const idx of aq.groups[i].cells) {
          const r = Math.floor(idx / this.cols);
          const c = idx % this.cols;
          if (currentGrid[r][c] === 0) forced.push({ row: r, col: c, value });
        }
      }
    }
    return forced.length > 0 ? forced : null;
  }

  getHint(currentGrid) {
    const forced = this._findForcedCells(currentGrid);
    if (forced) {
      const byRow = {};
      for (const f of forced) {
        if (!byRow[f.row]) byRow[f.row] = { cells: [] };
        byRow[f.row].cells.push({ index: f.col, value: f.value });
      }
      let bestR = -1, bestN = 0, bestCells = [];
      for (const r in byRow) {
        const row = parseInt(r);
        if (byRow[row].cells.length > bestN) {
          bestN = byRow[row].cells.length;
          bestR = row;
          bestCells = byRow[row].cells;
        }
      }
      if (bestR >= 0) return { type: 'row', index: bestR, clue: [this.rowClues[bestR]], cells: bestCells, count: bestCells.length };
    }

    let bestR = -1, bestC = -1, bestN = 0, bestCells = [], bestType = 'row';
    for (let r = 0; r < this.rows; r++) {
      let filled = 0, empty = 0;
      const ecells = [];
      for (let c = 0; c < this.cols; c++) {
        if (currentGrid[r][c] === 1) filled++;
        else if (currentGrid[r][c] === 0) { empty++; ecells.push(c); }
      }
      if (filled === this.rowClues[r]) {
        const cells = ecells.map(c => ({ index: c, value: -1 }));
        if (cells.length > bestN) { bestN = cells.length; bestR = r; bestCells = cells; bestType = 'row'; }
      } else if (this.rowClues[r] - filled === empty) {
        const cells = ecells.map(c => ({ index: c, value: 1 }));
        if (cells.length > bestN) { bestN = cells.length; bestR = r; bestCells = cells; bestType = 'row'; }
      }
    }
    for (let c = 0; c < this.cols; c++) {
      let filled = 0, empty = 0;
      const cells = [];
      for (let r = 0; r < this.rows; r++) {
        if (currentGrid[r][c] === 1) filled++;
        else if (currentGrid[r][c] === 0) { empty++; cells.push(r); }
      }
      if (filled === this.colClues[c]) {
        const cs = cells.map(r => ({ index: r, value: -1 }));
        if (cs.length > bestN) { bestN = cs.length; bestC = c; bestCells = cs; bestType = 'col'; }
      } else if (this.colClues[c] - filled === empty) {
        const cs = cells.map(r => ({ index: r, value: 1 }));
        if (cs.length > bestN) { bestN = cs.length; bestC = c; bestCells = cs; bestType = 'col'; }
      }
    }
    if (bestCells.length > 0) {
      return { type: bestType, index: bestType === 'row' ? bestR : bestC, clue: [bestType === 'row' ? this.rowClues[bestR] : this.colClues[bestC]], cells: bestCells, count: bestCells.length };
    }

    return null;
  }
}

class BinairoSolver {
  /**
   * @param {{ rows: number, cols: number, givens: number[][], initialState?: number[][], comparisonClues?: (number|null)[][] }} opts
   *   `givens`          2D array, page-native encoding (-1=blank, 0=given-zero, 1=given-one).
   *   `initialState`    optional 2D in cellStatus encoding (0=empty, 1=one, 2=zero);
   *                     defaults to givens-translated state.
   *   `comparisonClues` optional sparse 2D of flag integers (1=R-EQ, 2=R-NE, 4=D-EQ, 8=D-NE);
   *                     omitted or undefined produces standard (unconstrained) Binairo.
   */
  constructor({ rows, cols, givens, initialState, comparisonClues }) {
    if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows <= 0 || cols <= 0) {
      throw new Error('BinairoSolver: rows/cols must be positive integers');
    }
    if (rows % 2 !== 0 || cols % 2 !== 0) {
      throw new Error('BinairoSolver: rows/cols must be even (Binairo requires N/2 of each value per line)');
    }
    if (!Array.isArray(givens)) {
      throw new Error('BinairoSolver: givens must be an array');
    }
    this.rows = rows;
    this.cols = cols;
    this.rowHalf = cols / 2;     // half-count target for any single row
    this.colHalf = rows / 2;     // half-count target for any single column
    this.givens = givens.map(row => (Array.isArray(row) ? row.slice() : []));

    // Internal grid: 0=empty, 1=one, 2=zero. Flat Int8Array for fast access.
    this.grid = new Int8Array(rows * cols);

    // Per-line known-value counts. Maintained incrementally by _assign / _rollback.
    this.rowOnes  = new Int32Array(rows);
    this.rowZeros = new Int32Array(rows);
    this.colOnes  = new Int32Array(cols);
    this.colZeros = new Int32Array(cols);

    // Trail entries packed as (idx << 2) | oldValue. oldValue ∈ {0, 1, 2}.
    this.trail = [];

    // Solve-time control. maxMs=0 disables the budget.
    this.maxMs = 0;
    this._startedAt = 0;
    this._timedOut = false;
    // Depth tracking so lookahead only fires at the top level — at deeper
    // backtrack depths the per-cell probing cost outweighs the pruning win.
    this._depth = 0;
    this._inLookahead = false;

    // Comparison-clue normalization: page-native sparse 2D of flag integers
    // collapses to a flat list of canonical pairwise constraints. Empty/
    // undefined `comparisonClues` produces an empty list (standard Binairo).
    this.compConstraints = this._decodeComparison(comparisonClues);

    // Seed the grid from initialState if provided, else from givens.
    const init = initialState || this._initialFromGivens(givens);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = init[r] && init[r][c] !== undefined ? init[r][c] : 0;
        if (v !== 0) this._set(r, c, v);
      }
    }
  }

  _initialFromGivens(givens) {
    const out = Array.from({ length: this.rows }, () => new Array(this.cols).fill(0));
    for (let r = 0; r < this.rows; r++) {
      const row = givens[r] || [];
      for (let c = 0; c < this.cols; c++) {
        const g = row[c];
        out[r][c] = g === 1 ? 1 : g === 0 ? 2 : 0;
      }
    }
    return out;
  }

  _decodeComparison(comparisonClues) {
    const out = [];
    if (!Array.isArray(comparisonClues)) return out;
    const R = this.rows, C = this.cols;
    for (let r = 0; r < comparisonClues.length && r < R; r++) {
      const row = comparisonClues[r];
      if (!Array.isArray(row)) continue;
      for (let c = 0; c < row.length && c < C; c++) {
        const flag = row[c];
        if (typeof flag !== 'number' || flag === 0) continue;
        if ((flag & 1) && c + 1 < C) out.push({ aR: r, aC: c, bR: r, bC: c + 1, sameSign: true });
        if ((flag & 2) && c + 1 < C) out.push({ aR: r, aC: c, bR: r, bC: c + 1, sameSign: false });
        if ((flag & 4) && r + 1 < R) out.push({ aR: r, aC: c, bR: r + 1, bC: c, sameSign: true });
        if ((flag & 8) && r + 1 < R) out.push({ aR: r, aC: c, bR: r + 1, bC: c, sameSign: false });
      }
    }
    return out;
  }

  // Public static so tests can construct compConstraints without an instance.
  static compConstraintsFromFlags(rows, cols, comparisonClues) {
    const stub = Object.create(BinairoSolver.prototype);
    stub.rows = rows;
    stub.cols = cols;
    return stub._decodeComparison(comparisonClues);
  }

  _idx(r, c) { return r * this.cols + c; }

  _get(r, c) { return this.grid[r * this.cols + c]; }

  // Direct write, no trail. Use only for initial seeding.
  _set(r, c, v) {
    const i = r * this.cols + c;
    const old = this.grid[i];
    if (old === v) return;
    this._bumpCounts(r, c, old, v);
    this.grid[i] = v;
  }

  // Trailed write. Returns true iff value changed.
  _assign(r, c, v) {
    const i = r * this.cols + c;
    const old = this.grid[i];
    if (old === v) return false;
    this.trail.push((i << 2) | old);
    this._bumpCounts(r, c, old, v);
    this.grid[i] = v;
    return true;
  }

  _rollback(mark) {
    const t = this.trail;
    const cols = this.cols;
    while (t.length > mark) {
      const entry = t.pop();
      const old = entry & 0b11;
      const i = entry >>> 2;
      const cur = this.grid[i];
      const r = (i / cols) | 0;
      const c = i % cols;
      this._bumpCounts(r, c, cur, old);
      this.grid[i] = old;
    }
  }

  _bumpCounts(r, c, oldV, newV) {
    if (oldV === 1) { this.rowOnes[r]--; this.colOnes[c]--; }
    else if (oldV === 2) { this.rowZeros[r]--; this.colZeros[c]--; }
    if (newV === 1) { this.rowOnes[r]++; this.colOnes[c]++; }
    else if (newV === 2) { this.rowZeros[r]++; this.colZeros[c]++; }
  }

  // Fixed-point loop driving the three local rules, then (top level only)
  // a 1-step lookahead pass. Returns false on contradiction.
  propagate() {
    if (this._timedOut) return false;
    while (true) {
      let changed = false;
      if (!this._applyNoTriples(() => { changed = true; })) return false;
      if (!this._applyBalance(() => { changed = true; }))   return false;
      if (!this._applyComparison(() => { changed = true; })) return false;
      if (!this._applyUniqueness(() => { changed = true; })) return false;
      if (!this._applySingleRemaining(() => { changed = true; })) return false;
      if (changed) continue;
      // Local rules exhausted. Try lookahead — but only at depth 0 (inside
      // backtracking, the recurring per-cell probe cost dwarfs the gain).
      if (this._depth > 0 || this._inLookahead) break;
      let lookChanged = false;
      this._inLookahead = true;
      let lookOK;
      try {
        lookOK = this._applyLookahead(() => { lookChanged = true; });
      } finally {
        this._inLookahead = false;
      }
      if (!lookOK) return false;
      if (!lookChanged) break;
      // Lookahead made progress; re-run local rules to cascade.
    }
    return true;
  }

  // For each empty cell, tentatively assign each value, run a (lookahead-free)
  // propagate, and check whether the assignment leads to a contradiction. If
  // exactly one value survives, force it. If both fail, signal contradiction.
  _applyLookahead(onChange) {
    if (this._checkTimeout()) return false;
    const R = this.rows, C = this.cols;
    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        if (this._get(r, c) !== 0) continue;
        if (this._checkTimeout()) return false;
        const mark = this.trail.length;

        // Probe v=1: an immediate triple short-circuits to failed probe.
        let okOne = false;
        if (!this._wouldCreateTriple(r, c, 1)) {
          if (this._assign(r, c, 1) && this.propagate()) okOne = true;
          this._rollback(mark);
        }

        // Probe v=2
        let okZero = false;
        if (!this._wouldCreateTriple(r, c, 2)) {
          if (this._assign(r, c, 2) && this.propagate()) okZero = true;
          this._rollback(mark);
        }

        if (!okOne && !okZero) return false;
        if (okOne && !okZero) { if (this._assign(r, c, 1)) onChange(); }
        else if (okZero && !okOne) { if (this._assign(r, c, 2)) onChange(); }
      }
    }
    return true;
  }

  _checkTimeout() {
    if (this._timedOut) return true;
    if (this.maxMs > 0 && Date.now() - this._startedAt > this.maxMs) {
      this._timedOut = true;
      return true;
    }
    return false;
  }

  // Per-line enumeration fallback: for each row/column with a tractable
  // number of empty-cell permutations, enumerate every valid completion
  // (respecting balance, no-triples within the line, and comparison
  // constraints involving cells in the line — including cross-axis
  // constraints whose other side is already filled). For each empty cell,
  // if all valid completions agree on its value, force it.
  //
  // Used by getHint as a fallback when local rules deduce nothing. Finds
  // forced moves that the cell-by-cell line lookahead misses, including
  // forces driven by comparison constraints that span multiple empties.
  _applyLineEnumeration(onChange) {
    const R = this.rows, C = this.cols;
    const MAX_COMBOS = 5000;
    for (let r = 0; r < R; r++) {
      if (!this._enumerateLine('row', r, this.rowHalf, MAX_COMBOS, onChange)) return false;
    }
    for (let c = 0; c < C; c++) {
      if (!this._enumerateLine('col', c, this.colHalf, MAX_COMBOS, onChange)) return false;
    }
    return true;
  }

  _enumerateLine(axis, index, halfCount, maxCombos, onChange) {
    const N = axis === 'row' ? this.cols : this.rows;
    const lineVals = new Int8Array(N);
    const empties = [];
    let onesCount = 0;
    for (let i = 0; i < N; i++) {
      const v = axis === 'row' ? this._get(index, i) : this._get(i, index);
      lineVals[i] = v;
      if (v === 0) empties.push(i);
      else if (v === 1) onesCount++;
    }
    if (empties.length === 0) return true;
    const needOnes = halfCount - onesCount;
    const k = empties.length;
    if (needOnes < 0 || needOnes > k) return false;

    // Skip lines whose enumeration would blow the budget — local rules and
    // backtracking handle those instead.
    let combos = 1;
    for (let i = 0; i < Math.min(needOnes, k - needOnes); i++) {
      combos = (combos * (k - i)) / (i + 1);
      if (combos > maxCombos) return true;
    }

    // Restrict comparison constraints to those involving this line.
    const lineConstraints = [];
    for (const cn of this.compConstraints) {
      const aInLine = (axis === 'row' && cn.aR === index) || (axis === 'col' && cn.aC === index);
      const bInLine = (axis === 'row' && cn.bR === index) || (axis === 'col' && cn.bC === index);
      if (aInLine || bInLine) lineConstraints.push(cn);
    }

    // possible[i]: bitmask of values seen at empties[i] across valid completions.
    //   bit 0 (=1) → value 1 reachable; bit 1 (=2) → value 2 reachable.
    const possible = new Int8Array(k);
    const valForEmpty = new Int8Array(k);
    const candidate = new Int8Array(N);
    let validCount = 0;
    const self = this;

    function isValid() {
      for (let i = 0; i < N; i++) candidate[i] = lineVals[i];
      for (let i = 0; i < k; i++) candidate[empties[i]] = valForEmpty[i];
      for (let i = 2; i < N; i++) {
        if (candidate[i] !== 0 &&
            candidate[i] === candidate[i - 1] &&
            candidate[i] === candidate[i - 2]) return false;
      }
      for (const cn of lineConstraints) {
        const valA = (axis === 'row' && cn.aR === index) ? candidate[cn.aC] :
                     (axis === 'col' && cn.aC === index) ? candidate[cn.aR] :
                     self._get(cn.aR, cn.aC);
        const valB = (axis === 'row' && cn.bR === index) ? candidate[cn.bC] :
                     (axis === 'col' && cn.bC === index) ? candidate[cn.bR] :
                     self._get(cn.bR, cn.bC);
        if (valA === 0 || valB === 0) continue;
        if ((valA === valB) !== cn.sameSign) return false;
      }
      return true;
    }

    function recurse(pos, onesLeft, zerosLeft) {
      if (pos === k) {
        if (isValid()) {
          validCount++;
          for (let i = 0; i < k; i++) possible[i] |= valForEmpty[i] === 1 ? 1 : 2;
        }
        return;
      }
      if (zerosLeft > 0) {
        valForEmpty[pos] = 2;
        recurse(pos + 1, onesLeft, zerosLeft - 1);
      }
      if (onesLeft > 0) {
        valForEmpty[pos] = 1;
        recurse(pos + 1, onesLeft - 1, zerosLeft);
      }
    }
    recurse(0, needOnes, k - needOnes);

    if (validCount === 0) return false;

    for (let i = 0; i < k; i++) {
      const forced = possible[i] === 1 ? 1 : possible[i] === 2 ? 2 : 0;
      if (forced === 0) continue;
      const r = axis === 'row' ? index : empties[i];
      const c = axis === 'row' ? empties[i] : index;
      if (this._get(r, c) !== 0) continue;
      if (this._wouldCreateTriple(r, c, forced)) return false;
      if (this._assign(r, c, forced)) onChange();
    }
    return true;
  }

  // Line-restricted lookahead: a single round over rows/columns that need
  // exactly 1 of one value and ≥2 of the other. For each empty cell in
  // such a line, probe both values via local-rule propagation. If exactly
  // one value survives, force it. Cells where both values stay legal are
  // skipped. Used by getHint as a fallback when local rules alone deduce
  // nothing — it picks up forced moves that require case analysis but
  // doesn't unfurl the whole board the way unrestricted lookahead does.
  _applyLineLookahead(onChange) {
    const R = this.rows, C = this.cols, rowHalf = this.rowHalf, colHalf = this.colHalf;

    const targets = [];
    for (let r = 0; r < R; r++) {
      const needOnes  = rowHalf - this.rowOnes[r];
      const needZeros = rowHalf - this.rowZeros[r];
      if ((needOnes === 1 && needZeros >= 2) || (needZeros === 1 && needOnes >= 2)) {
        targets.push({ axis: 'row', index: r });
      }
    }
    for (let c = 0; c < C; c++) {
      const needOnes  = colHalf - this.colOnes[c];
      const needZeros = colHalf - this.colZeros[c];
      if ((needOnes === 1 && needZeros >= 2) || (needZeros === 1 && needOnes >= 2)) {
        targets.push({ axis: 'col', index: c });
      }
    }

    for (const tgt of targets) {
      if (this._checkTimeout()) return false;
      const empties = tgt.axis === 'row'
        ? this._emptyCellsInRow(tgt.index)
        : this._emptyCellsInCol(tgt.index);
      for (const idx of empties) {
        const r = tgt.axis === 'row' ? tgt.index : idx;
        const c = tgt.axis === 'row' ? idx : tgt.index;
        // Skip cells forced earlier in this pass.
        if (this._get(r, c) !== 0) continue;
        const mark = this.trail.length;

        let okOne = false;
        if (!this._wouldCreateTriple(r, c, 1)) {
          if (this._assign(r, c, 1) && this.propagate()) okOne = true;
          this._rollback(mark);
        }

        let okZero = false;
        if (!this._wouldCreateTriple(r, c, 2)) {
          if (this._assign(r, c, 2) && this.propagate()) okZero = true;
          this._rollback(mark);
        }

        if (!okOne && !okZero) return false;
        if (okOne && !okZero) { if (this._assign(r, c, 1)) onChange(); }
        else if (okZero && !okOne) { if (this._assign(r, c, 2)) onChange(); }
        // else (both legal): cell can take either value — skip per spec.
      }
    }
    return true;
  }

  // For each empty cell, check both placements against up to three horizontal
  // and three vertical 3-windows that contain it (boundary windows skipped).
  // If exactly one value is legal, force it. If neither is legal, contradiction.
  _applyNoTriples(onChange) {
    const R = this.rows, C = this.cols;
    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        if (this._get(r, c) !== 0) continue;
        const canOne  = !this._wouldCreateTriple(r, c, 1);
        const canZero = !this._wouldCreateTriple(r, c, 2);
        if (!canOne && !canZero) return false;
        if (canOne && !canZero) { if (this._assign(r, c, 1)) onChange(); }
        else if (canZero && !canOne) { if (this._assign(r, c, 2)) onChange(); }
      }
    }
    return true;
  }

  // Does placing v at (r,c) create v,v,v in any of the four 3-windows that
  // span this cell? Skip windows where any other slot is empty (0) — they
  // can't force a triple yet.
  _wouldCreateTriple(r, c, v) {
    const R = this.rows, C = this.cols;
    // Horizontal windows: (c-2,c-1,c), (c-1,c,c+1), (c,c+1,c+2)
    for (let dc = -2; dc <= 0; dc++) {
      const c0 = c + dc;
      if (c0 < 0 || c0 + 2 >= C) continue;
      const a = (c0     === c) ? v : this._get(r, c0);
      const b = (c0 + 1 === c) ? v : this._get(r, c0 + 1);
      const d = (c0 + 2 === c) ? v : this._get(r, c0 + 2);
      if (a === v && b === v && d === v) return true;
    }
    // Vertical windows: (r-2,r-1,r), (r-1,r,r+1), (r,r+1,r+2)
    for (let dr = -2; dr <= 0; dr++) {
      const r0 = r + dr;
      if (r0 < 0 || r0 + 2 >= R) continue;
      const a = (r0     === r) ? v : this._get(r0, c);
      const b = (r0 + 1 === r) ? v : this._get(r0 + 1, c);
      const d = (r0 + 2 === r) ? v : this._get(r0 + 2, c);
      if (a === v && b === v && d === v) return true;
    }
    return false;
  }

  // When a line needs exactly one more of a given value (rowOnes/rowZeros
  // is one short of the half-target), check each empty cell to see whether
  // it can legally hold that value without creating a triple. If exactly
  // one slot can, force the value there and every other empty in the line
  // to the opposite value. If no slot can, the line is unsolvable —
  // signal contradiction.
  //
  // This catches a class of deductions that no-triples + balance miss:
  // no-triples is cell-local, balance only fires at the half-target, and
  // uniqueness only fires on 2-empty lines. With a longer empty stretch
  // but a single remaining instance of one value, the position is often
  // pinned by triple constraints alone.
  _applySingleRemaining(onChange) {
    const R = this.rows, C = this.cols, rowHalf = this.rowHalf, colHalf = this.colHalf;

    for (let r = 0; r < R; r++) {
      if (this.rowOnes[r] === rowHalf - 1) {
        if (!this._forceSingleInRow(r, 1, onChange)) return false;
      }
      if (this.rowZeros[r] === rowHalf - 1) {
        if (!this._forceSingleInRow(r, 2, onChange)) return false;
      }
    }
    for (let c = 0; c < C; c++) {
      if (this.colOnes[c] === colHalf - 1) {
        if (!this._forceSingleInCol(c, 1, onChange)) return false;
      }
      if (this.colZeros[c] === colHalf - 1) {
        if (!this._forceSingleInCol(c, 2, onChange)) return false;
      }
    }
    return true;
  }

  _forceSingleInRow(r, target, onChange) {
    const empties = this._emptyCellsInRow(r);
    if (empties.length === 0) return true;
    let onlySlot = -1;
    let count = 0;
    for (const c of empties) {
      if (!this._wouldCreateTriple(r, c, target)) {
        if (++count > 1) return true; // more than one slot — can't force
        onlySlot = c;
      }
    }
    if (count === 0) return false; // contradiction: nowhere to place the target
    const other = target === 1 ? 2 : 1;
    if (this._assign(r, onlySlot, target)) onChange();
    for (const c of empties) {
      if (c === onlySlot) continue;
      if (this._wouldCreateTriple(r, c, other)) return false;
      if (this._assign(r, c, other)) onChange();
    }
    return true;
  }

  _forceSingleInCol(c, target, onChange) {
    const empties = this._emptyCellsInCol(c);
    if (empties.length === 0) return true;
    let onlySlot = -1;
    let count = 0;
    for (const r of empties) {
      if (!this._wouldCreateTriple(r, c, target)) {
        if (++count > 1) return true;
        onlySlot = r;
      }
    }
    if (count === 0) return false;
    const other = target === 1 ? 2 : 1;
    if (this._assign(onlySlot, c, target)) onChange();
    for (const r of empties) {
      if (r === onlySlot) continue;
      if (this._wouldCreateTriple(r, c, other)) return false;
      if (this._assign(r, c, other)) onChange();
    }
    return true;
  }

  // If a line already has rowHalf of one value, every empty cell in it must
  // take the other value. Validates no-triples on each assignment so that
  // backtracking doesn't need a separate full-grid triple scan.
  _applyBalance(onChange) {
    const R = this.rows, C = this.cols, rowHalf = this.rowHalf, colHalf = this.colHalf;

    for (let r = 0; r < R; r++) {
      const ones  = this.rowOnes[r];
      const zeros = this.rowZeros[r];
      if (ones > rowHalf || zeros > rowHalf) return false;
      if (ones === rowHalf) {
        for (let c = 0; c < C; c++) {
          if (this._get(r, c) !== 0) continue;
          if (this._wouldCreateTriple(r, c, 2)) return false;
          if (this._assign(r, c, 2)) onChange();
        }
      } else if (zeros === rowHalf) {
        for (let c = 0; c < C; c++) {
          if (this._get(r, c) !== 0) continue;
          if (this._wouldCreateTriple(r, c, 1)) return false;
          if (this._assign(r, c, 1)) onChange();
        }
      }
    }

    for (let c = 0; c < C; c++) {
      const ones  = this.colOnes[c];
      const zeros = this.colZeros[c];
      if (ones > colHalf || zeros > colHalf) return false;
      if (ones === colHalf) {
        for (let r = 0; r < R; r++) {
          if (this._get(r, c) !== 0) continue;
          if (this._wouldCreateTriple(r, c, 2)) return false;
          if (this._assign(r, c, 2)) onChange();
        }
      } else if (zeros === colHalf) {
        for (let r = 0; r < R; r++) {
          if (this._get(r, c) !== 0) continue;
          if (this._wouldCreateTriple(r, c, 1)) return false;
          if (this._assign(r, c, 1)) onChange();
        }
      }
    }
    return true;
  }
  // Comparison-clue propagation. For each pairwise constraint:
  // - if both sides are known, verify consistency (else contradiction);
  // - if exactly one side is known, force the other so the constraint holds.
  // Validates no-triples on each forced assignment so the post-validation
  // gap in _backtrack stays closed.
  _applyComparison(onChange) {
    for (const k of this.compConstraints) {
      const a = this._get(k.aR, k.aC);
      const b = this._get(k.bR, k.bC);
      if (a !== 0 && b !== 0) {
        const equal = a === b;
        if (equal !== k.sameSign) return false;
        continue;
      }
      if (a === 0 && b === 0) continue;
      const known = a !== 0 ? a : b;
      const target = k.sameSign ? known : (known === 1 ? 2 : 1);
      const r = a !== 0 ? k.bR : k.aR;
      const c = a !== 0 ? k.bC : k.aC;
      if (this._wouldCreateTriple(r, c, target)) return false;
      if (this._assign(r, c, target)) onChange();
    }
    return true;
  }
  // Force a line whose only 2 empty cells admit exactly one completion that
  // (a) keeps balance legal, (b) avoids no-triples, (c) avoids matching any
  // already-completed parallel line.
  _applyUniqueness(onChange) {
    const R = this.rows, C = this.cols, rowHalf = this.rowHalf, colHalf = this.colHalf;

    const filledRowMasks = this._filledLineMasks('row');
    for (let r = 0; r < R; r++) {
      const empty = this._emptyCellsInRow(r);
      if (empty.length !== 2) continue;
      // Skip balance-forced rows: _applyBalance will fill them; uniqueness candidates
      // won't include the balance-only completions ([2,2] or [1,1]), so we'd see 0
      // candidates and falsely report a contradiction.
      if (this.rowOnes[r] === rowHalf || this.rowZeros[r] === rowHalf) continue;
      const cands = this._completeLineCandidates(r, 'row', empty, filledRowMasks, rowHalf);
      if (cands.length === 0) return false;
      if (cands.length === 1) {
        const [v0, v1] = cands[0];
        // Cross-axis triple check — _completeLineCandidates only validates
        // no-triples within the line. The two assigns can still create a
        // column-direction triple. Without this guard, the post-validation
        // in _backtrack used to catch it; now we surface it inline.
        if (this._wouldCreateTriple(r, empty[0], v0)) return false;
        if (this._assign(r, empty[0], v0)) onChange();
        if (this._wouldCreateTriple(r, empty[1], v1)) return false;
        if (this._assign(r, empty[1], v1)) onChange();
      }
    }

    const filledColMasks = this._filledLineMasks('col');
    for (let c = 0; c < C; c++) {
      const empty = this._emptyCellsInCol(c);
      if (empty.length !== 2) continue;
      // Skip balance-forced cols for the same reason.
      if (this.colOnes[c] === colHalf || this.colZeros[c] === colHalf) continue;
      const cands = this._completeLineCandidates(c, 'col', empty, filledColMasks, colHalf);
      if (cands.length === 0) return false;
      if (cands.length === 1) {
        const [v0, v1] = cands[0];
        if (this._wouldCreateTriple(empty[0], c, v0)) return false;
        if (this._assign(empty[0], c, v0)) onChange();
        if (this._wouldCreateTriple(empty[1], c, v1)) return false;
        if (this._assign(empty[1], c, v1)) onChange();
      }
    }
    return true;
  }

  _emptyCellsInRow(r) {
    const out = [];
    for (let c = 0; c < this.cols; c++) if (this._get(r, c) === 0) out.push(c);
    return out;
  }

  _emptyCellsInCol(c) {
    const out = [];
    for (let r = 0; r < this.rows; r++) if (this._get(r, c) === 0) out.push(r);
    return out;
  }

  // Encode a fully-filled line as a bitmask of bit-per-cell where 1=one and 0=zero.
  // Returns a Set<number> of all currently-full lines along the given axis.
  _filledLineMasks(axis) {
    const set = new Set();
    if (axis === 'row') {
      for (let r = 0; r < this.rows; r++) {
        let mask = 0, full = true;
        for (let c = 0; c < this.cols; c++) {
          const v = this._get(r, c);
          if (v === 0) { full = false; break; }
          if (v === 1) mask |= (1 << c);
        }
        if (full) set.add(mask);
      }
    } else {
      for (let c = 0; c < this.cols; c++) {
        let mask = 0, full = true;
        for (let r = 0; r < this.rows; r++) {
          const v = this._get(r, c);
          if (v === 0) { full = false; break; }
          if (v === 1) mask |= (1 << r);
        }
        if (full) set.add(mask);
      }
    }
    return set;
  }

  // Try both orderings ([1,2] and [2,1]) for the two empty slots in line `index`.
  // Returns an array of legal completions, each as a 2-tuple of values that
  // would go into the empty slots in their listed order.
  _completeLineCandidates(index, axis, emptySlots, filledMasks, _halfCount) {
    const tryVals = [[1, 2], [2, 1]];
    const out = [];
    for (const [v0, v1] of tryVals) {
      const mask = this._maskWith(index, axis, emptySlots, v0, v1);
      if (mask === null) continue;                // balance / no-triples failed
      if (filledMasks.has(mask)) continue;        // duplicate of a full line
      out.push([v0, v1]);
    }
    return out;
  }

  // Build the would-be completed-line bitmask if (emptySlots[0]=v0, emptySlots[1]=v1).
  // Returns null if the completion violates balance or no-triples.
  _maskWith(index, axis, emptySlots, v0, v1) {
    const N = axis === 'row' ? this.cols : this.rows;
    let mask = 0, ones = 0, zeros = 0;
    const tempVals = new Int8Array(N);
    for (let i = 0; i < N; i++) {
      const v = axis === 'row' ? this._get(index, i) : this._get(i, index);
      tempVals[i] = v;
    }
    tempVals[emptySlots[0]] = v0;
    tempVals[emptySlots[1]] = v1;
    for (let i = 0; i < N; i++) {
      const v = tempVals[i];
      if (v === 1) { mask |= (1 << i); ones++; }
      else if (v === 2) { zeros++; }
      else return null;                           // shouldn't happen for 2-empty lines
      if (i >= 2 && tempVals[i] !== 0 && tempVals[i] === tempVals[i - 1] && tempVals[i] === tempVals[i - 2]) {
        return null;                              // no-triples violation
      }
    }
    const half = axis === 'row' ? this.rowHalf : this.colHalf;
    if (ones !== half || zeros !== half) return null;
    return mask;
  }

  /**
   * @returns {{ solved: boolean, grid: number[][] | null, error?: string }}
   */
  solve() {
    const key = this._cacheKey();
    const cached = BinairoSolver._solutionCache.get(key);
    if (cached) return { solved: true, grid: cached.map(row => row.slice()) };

    this._startedAt = Date.now();
    this._timedOut = false;
    this._depth = 0;

    // Reject invalid givens up-front. Propagation rules only catch triples
    // they create themselves (and the no-triples rule only scans empty cells),
    // so a pre-existing triple in the initial state would otherwise sneak
    // through and produce a triple-bearing "solution".
    if (this._gridHasTriple()) {
      return { solved: false, grid: null, error: 'givens contain a triple' };
    }

    if (!this.propagate()) {
      if (this._timedOut) return { solved: false, grid: null, error: 'timed out' };
      return { solved: false, grid: null, error: 'contradiction on initial propagation' };
    }
    if (this._isComplete()) {
      // Balance + uniqueness propagation now reject triples at assign-time,
      // so a fully-filled state cannot contain triples; only the cross-line
      // duplicate-row/duplicate-col check is still meaningful here.
      if (this._hasDuplicateLines()) {
        return { solved: false, grid: null, error: 'givens produce an invalid Binairo grid' };
      }
      const grid = this._gridTo2D();
      this._storeInCache(key, grid);
      return { solved: true, grid };
    }
    if (this._backtrack()) {
      const grid = this._gridTo2D();
      this._storeInCache(key, grid);
      return { solved: true, grid };
    }
    return { solved: false, grid: null, error: this._timedOut ? 'timed out' : 'no solution found' };
  }

  /**
   * Runs local-rule propagation to fixed point (no-triples, balance,
   * uniqueness, single-remaining). If that produces no deductions, falls
   * back to ONE round of line-restricted lookahead: for each line that
   * has exactly 1 of one value and ≥2 of the other still to place, probe
   * each empty cell in that line — if exactly one value survives the
   * probe, force it. Cells that can take either value are left alone.
   *
   * This avoids the "Hint reveals the whole board" problem that full
   * lookahead has, while still finding forced cells that pure local
   * deduction misses.
   * @param {number[][]} currentGrid  2D in cellStatus encoding (0/1/2).
   */
  getHint(currentGrid) {
    const clone = new BinairoSolver({
      rows: this.rows, cols: this.cols,
      givens: this.givens,
      initialState: currentGrid,
    });
    // Carry comparison constraints onto the clone — the constructor doesn't
    // see them because we only pass `givens` + `initialState`. Without this
    // the clone's `compConstraints` stays empty and `_applyComparison`
    // becomes a no-op inside Hint, so Binairo Plus puzzles look fully
    // deduced when many comparison-driven cells remain forceable.
    clone.compConstraints = this.compConstraints;
    // Suppress the propagate()-internal lookahead phase. Hint's only
    // permitted lookahead is the line-restricted fallback below.
    clone._depth = 1;
    const before = new Int8Array(clone.grid);
    let ok = clone.propagate();
    if (!ok) return null;

    // If local rules deduced nothing, progressive fallbacks (cheapest first):
    //   1. Per-line enumeration: enumerate valid completions per row/column
    //      (with comparison-clue awareness), force cells whose value is
    //      consistent across all completions. Fast on lines with tractable
    //      combo counts; skips lines whose enumeration would blow the budget.
    //   2. Unrestricted 1-pass lookahead: for each empty cell, probe both
    //      values via local-rule propagation; force the survivor if exactly
    //      one is legal. Strictly stronger than the older line-restricted
    //      version since it sees forces across all line patterns. Capped at
    //      ONE pass (not iterated to fixed point) so Hint stays bounded —
    //      the iterated form lives in solve()'s propagate() lookahead phase.
    let localChanged = false;
    for (let i = 0; i < before.length; i++) {
      if (before[i] !== clone.grid[i]) { localChanged = true; break; }
    }
    if (!localChanged) {
      ok = clone._applyLineEnumeration(() => {});
      if (!ok) return null;
      // Cascade local rules over enumeration's new forces.
      if (clone.grid.some((v, i) => v !== before[i])) {
        ok = clone.propagate();
        if (!ok) return null;
      }
      // If enumeration found nothing, try unrestricted single-pass lookahead.
      let stillNothing = true;
      for (let i = 0; i < before.length; i++) {
        if (before[i] !== clone.grid[i]) { stillNothing = false; break; }
      }
      if (stillNothing) {
        clone._inLookahead = true;
        try {
          ok = clone._applyLookahead(() => {});
        } finally {
          clone._inLookahead = false;
        }
        if (!ok) return null;
        // Cascade local rules over lookahead's new forces.
        if (clone.grid.some((v, i) => v !== before[i])) {
          ok = clone.propagate();
          if (!ok) return null;
        }
      }
    }

    const forced = [];
    for (let i = 0; i < before.length; i++) {
      if (before[i] === 0 && clone.grid[i] !== 0) {
        const r = (i / clone.cols) | 0;
        const c = i % clone.cols;
        forced.push({ row: r, col: c, value: clone.grid[i] });
      }
    }
    if (forced.length === 0) return null;

    // Anchor on the first cell's row. Same-row cells go in `cells` (indexed
    // by column); the rest go in `extraCells` with absolute (row, col).
    const base = forced[0];
    const cells = [];
    const extraCells = [];
    for (const f of forced) {
      if (f.row === base.row) cells.push({ index: f.col, value: f.value });
      else extraCells.push({ row: f.row, col: f.col, value: f.value });
    }
    return {
      type: 'row',
      index: base.row,
      clue: null,
      cells,
      extraCells,
      count: forced.length,
    };
  }

  _isComplete() {
    for (let i = 0; i < this.grid.length; i++) if (this.grid[i] === 0) return false;
    return true;
  }

  _gridTo2D() {
    const out = [];
    for (let r = 0; r < this.rows; r++) {
      const row = new Array(this.cols);
      for (let c = 0; c < this.cols; c++) row[c] = this.grid[r * this.cols + c];
      out[r] = row;
    }
    return out;
  }

  // Most-constrained empty cell: minimize (rowHalf - rowOnes[r]) + (colHalf - colOnes[c]).
  // Returns [r, c] or null if no empty cell.
  _pickBranchCell() {
    let bestR = -1, bestC = -1, bestScore = Infinity;
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        if (this._get(r, c) !== 0) continue;
        const score = (this.rowHalf - this.rowOnes[r]) + (this.colHalf - this.colOnes[c]);
        if (score < bestScore) { bestScore = score; bestR = r; bestC = c; }
      }
    }
    return bestR === -1 ? null : [bestR, bestC];
  }

  // Scan the entire grid for any three-in-a-row (horizontal or vertical).
  // Returns true if any triple of consecutive identical non-zero values is found.
  // Called after propagation to catch triples that _applyBalance or
  // _applyUniqueness may have introduced (those rules don't verify no-triples
  // for the cells they fill, and propagation only checks *empty* cells).
  _gridHasTriple() {
    const R = this.rows, C = this.cols;
    for (let r = 0; r < R; r++) {
      for (let c = 2; c < C; c++) {
        const v = this._get(r, c);
        if (v !== 0 && v === this._get(r, c - 1) && v === this._get(r, c - 2)) return true;
      }
    }
    for (let c = 0; c < C; c++) {
      for (let r = 2; r < R; r++) {
        const v = this._get(r, c);
        if (v !== 0 && v === this._get(r - 1, c) && v === this._get(r - 2, c)) return true;
      }
    }
    return false;
  }

  // When the grid is complete, verify uniqueness across all rows and cols.
  // Returns true if any two rows (or cols) are identical.
  _hasDuplicateLines() {
    const R = this.rows, C = this.cols;
    const rowMasks = new Set();
    for (let r = 0; r < R; r++) {
      let mask = 0;
      for (let c = 0; c < C; c++) if (this._get(r, c) === 1) mask |= (1 << c);
      if (rowMasks.has(mask)) return true;
      rowMasks.add(mask);
    }
    const colMasks = new Set();
    for (let c = 0; c < C; c++) {
      let mask = 0;
      for (let r = 0; r < R; r++) if (this._get(r, c) === 1) mask |= (1 << r);
      if (colMasks.has(mask)) return true;
      colMasks.add(mask);
    }
    return false;
  }

  _backtrack() {
    if (this._checkTimeout()) return false;
    const cell = this._pickBranchCell();
    if (!cell) {
      if (!this._isComplete()) return false;
      return !this._hasDuplicateLines();
    }
    const [r, c] = cell;
    this._depth++;
    try {
      for (const v of [1, 2]) {
        // Pre-check: the branch assignment itself must not create a triple
        // (propagation only catches triples through balance/uniqueness, not
        // through the bare backtrack assign).
        if (this._wouldCreateTriple(r, c, v)) continue;
        const mark = this.trail.length;
        this._assign(r, c, v);
        if (this.propagate()) {
          if (this._isComplete()) {
            if (!this._hasDuplicateLines()) return true;
          } else if (this._backtrack()) {
            return true;
          }
        }
        this._rollback(mark);
        if (this._timedOut) return false;
      }
    } finally {
      this._depth--;
    }
    return false;
  }

  static _solutionCache = new Map();
  static _maxSolutionCache = 50;

  static clearSolutionCache() {
    BinairoSolver._solutionCache.clear();
  }

  _cacheKey() {
    // FNV-1a over (rows, cols, flattened givens). Returns a 32-bit unsigned int as string.
    let h = 0x811c9dc5;
    const mix = (n) => { h ^= n; h = Math.imul(h, 0x01000193) >>> 0; };
    mix(this.rows);
    mix(this.cols);
    for (let r = 0; r < this.rows; r++) {
      const row = this.givens[r] || [];
      for (let c = 0; c < this.cols; c++) mix((row[c] | 0) + 2); // +2 to map -1..1 to 1..3
    }
    // Mix comparison constraints. Stable ordering is _decodeComparison's
    // emission order: outer row then col, with bit order (R-EQ, R-NE,
    // D-EQ, D-NE). Length sentinel up front so an empty list still mixes.
    mix(this.compConstraints.length);
    for (const k of this.compConstraints) {
      mix(k.aR); mix(k.aC); mix(k.bR); mix(k.bC);
      mix(k.sameSign ? 1 : 0);
    }
    return String(h >>> 0);
  }

  _storeInCache(key, grid) {
    const m = BinairoSolver._solutionCache;
    if (m.size >= BinairoSolver._maxSolutionCache) {
      const first = m.keys().next().value;
      m.delete(first);
    }
    // Store a deep copy so callers can't mutate the cached grid.
    m.set(key, grid.map(row => row.slice()));
  }
}

class ShikakuSolver {
  /**
   * @param {{
   *   rows: number,
   *   cols: number,
   *   clues: Array<{ row: number, col: number, area: number }>,
   *   initialState?: number[][],
   * }} opts
   */
  constructor({ rows, cols, clues, initialState }) {
    if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows <= 0 || cols <= 0) {
      throw new Error('ShikakuSolver: rows/cols must be positive integers');
    }
    if (!Array.isArray(clues)) {
      throw new Error('ShikakuSolver: clues must be an array');
    }
    const sum = clues.reduce((s, c) => s + (c.area | 0), 0);
    if (sum !== rows * cols) {
      throw new Error(`ShikakuSolver: clue area sum ${sum} must equal grid area ${rows * cols}`);
    }
    this.rows = rows;
    this.cols = cols;
    this.clues = clues.map(c => ({ row: c.row | 0, col: c.col | 0, area: c.area | 0 }));

    this.clueByCell = new Int16Array(rows * cols).fill(-1);
    for (let i = 0; i < this.clues.length; i++) {
      const k = this.clues[i];
      this.clueByCell[k.row * cols + k.col] = i;
    }

    this.owner = new Int16Array(rows * cols).fill(-1);
    for (let i = 0; i < this.clues.length; i++) {
      const k = this.clues[i];
      this.owner[k.row * cols + k.col] = i;
    }

    this.placed = new Uint8Array(this.clues.length);
    this.candidates = this.clues.map((_, i) => this._enumerateCandidates(i));
    this.trail = [];

    if (initialState) {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const v = initialState[r]?.[c];
          if (Number.isInteger(v) && v >= 0 && v < this.clues.length) {
            this.owner[r * cols + c] = v;
          }
        }
      }
    }
  }

  _enumerateCandidates(clueIdx) {
    const k = this.clues[clueIdx];
    const R = this.rows, C = this.cols;
    const out = [];
    for (let h = 1; h <= k.area; h++) {
      if (k.area % h !== 0) continue;
      const w = k.area / h;
      for (let r1 = Math.max(0, k.row - h + 1); r1 <= k.row; r1++) {
        const r2 = r1 + h - 1;
        if (r2 >= R) continue;
        for (let c1 = Math.max(0, k.col - w + 1); c1 <= k.col; c1++) {
          const c2 = c1 + w - 1;
          if (c2 >= C) continue;
          let otherClueInside = false;
          for (let r = r1; r <= r2 && !otherClueInside; r++) {
            for (let c = c1; c <= c2; c++) {
              const cellClue = this.clueByCell[r * C + c];
              if (cellClue !== -1 && cellClue !== clueIdx) {
                otherClueInside = true;
                break;
              }
            }
          }
          if (!otherClueInside) out.push({ r1, c1, r2, c2 });
        }
      }
    }
    return out;
  }

  // Iterate the propagation rules until no rule changes anything. Returns
  // false on contradiction (any clue's candidate set becomes empty).
  propagate() {
    let changed = true;
    while (changed) {
      changed = false;
      // 1. Zero-candidate detection.
      for (let i = 0; i < this.clues.length; i++) {
        if (!this.placed[i] && this.candidates[i].length === 0) return false;
      }
      // 2. Single-candidate forcing — place the rectangle, prune neighbours.
      for (let i = 0; i < this.clues.length; i++) {
        if (this.placed[i]) continue;
        if (this.candidates[i].length === 1) {
          if (!this._placeRectangle(i, this.candidates[i][0])) return false;
          changed = true;
        }
      }
    }
    return true;
  }

  // Place clue `i`'s rectangle. Marks every cell owned, prunes overlapping
  // candidates from other clues, sets placed[i] = 1. Returns false on a
  // cell-ownership conflict.
  _placeRectangle(clueIdx, rect) {
    const C = this.cols;
    for (let r = rect.r1; r <= rect.r2; r++) {
      for (let c = rect.c1; c <= rect.c2; c++) {
        const idx = r * C + c;
        const cur = this.owner[idx];
        if (cur !== -1 && cur !== clueIdx) return false;
        if (cur === -1) this._assign(idx, clueIdx);
      }
    }
    this._setPlaced(clueIdx, 1);
    this._setCandidates(clueIdx, [rect]);
    for (let j = 0; j < this.clues.length; j++) {
      if (j === clueIdx || this.placed[j]) continue;
      const filtered = this.candidates[j].filter(r2 => !_rectsOverlap(rect, r2));
      if (filtered.length !== this.candidates[j].length) {
        this._setCandidates(j, filtered);
      }
    }
    return true;
  }

  // ── Trail-based undo. Frame kinds: 0=cell-assign, 1=placed, 2=candidates.
  _assign(idx, value) {
    this.trail.push({ kind: 0, idx, old: this.owner[idx] });
    this.owner[idx] = value;
  }
  _setPlaced(clueIdx, value) {
    this.trail.push({ kind: 1, clueIdx, old: this.placed[clueIdx] });
    this.placed[clueIdx] = value;
  }
  _setCandidates(clueIdx, newList) {
    this.trail.push({ kind: 2, clueIdx, old: this.candidates[clueIdx] });
    this.candidates[clueIdx] = newList;
  }
  _rollback(mark) {
    while (this.trail.length > mark) {
      const e = this.trail.pop();
      if (e.kind === 0) this.owner[e.idx] = e.old;
      else if (e.kind === 1) this.placed[e.clueIdx] = e.old;
      else this.candidates[e.clueIdx] = e.old;
    }
  }

  static _solutionCache = new Map();
  static _maxSolutionCache = 50;

  static clearSolutionCache() {
    ShikakuSolver._solutionCache.clear();
  }

  _cacheKey() {
    let h = 0x811c9dc5;
    const mix = (n) => { h ^= n; h = Math.imul(h, 0x01000193) >>> 0; };
    mix(this.rows);
    mix(this.cols);
    mix(this.clues.length);
    const sorted = this.clues.slice().sort((a, b) =>
      a.row - b.row || a.col - b.col || a.area - b.area);
    for (const k of sorted) {
      mix(k.row); mix(k.col); mix(k.area);
    }
    return String(h >>> 0);
  }

  _storeInCache(key, grid) {
    const m = ShikakuSolver._solutionCache;
    if (m.size >= ShikakuSolver._maxSolutionCache) {
      const first = m.keys().next().value;
      m.delete(first);
    }
    m.set(key, grid.map(row => row.slice()));
  }

  solve() {
    const key = this._cacheKey();
    const cached = ShikakuSolver._solutionCache.get(key);
    if (cached) return { solved: true, grid: cached.map(row => row.slice()) };

    if (!this.propagate()) {
      return { solved: false, grid: null, error: 'contradiction on initial propagation' };
    }
    if (this._isComplete()) {
      const grid = this._ownerTo2D();
      this._storeInCache(key, grid);
      return { solved: true, grid };
    }
    if (this._backtrack()) {
      const grid = this._ownerTo2D();
      this._storeInCache(key, grid);
      return { solved: true, grid };
    }
    return { solved: false, grid: null, error: 'no solution found' };
  }

  _isComplete() {
    for (let i = 0; i < this.clues.length; i++) {
      if (!this.placed[i]) return false;
    }
    return true;
  }

  _ownerTo2D() {
    const out = [];
    for (let r = 0; r < this.rows; r++) {
      const row = new Array(this.cols);
      for (let c = 0; c < this.cols; c++) row[c] = this.owner[r * this.cols + c];
      out[r] = row;
    }
    return out;
  }

  _backtrack() {
    // MRV: pick the unplaced clue with the fewest remaining candidates.
    let target = -1;
    let bestCount = Infinity;
    for (let i = 0; i < this.clues.length; i++) {
      if (this.placed[i]) continue;
      const n = this.candidates[i].length;
      if (n < bestCount) { bestCount = n; target = i; }
    }
    if (target === -1) return this._isComplete();
    const cands = this.candidates[target].slice();
    for (const rect of cands) {
      const mark = this.trail.length;
      if (this._placeRectangle(target, rect) && this.propagate()) {
        if (this._isComplete() || this._backtrack()) return true;
      }
      this._rollback(mark);
    }
    return false;
  }

  /**
   * Reveal one complete rectangle. A Shikaku hint is "draw the rectangle
   * around this number", so the hint covers every cell of one clue's
   * rectangle — the clue's own number cell included.
   *
   * Real Shikaku puzzles have a unique solution, so the rectangle's shape
   * is certain; we solve from the clues alone (NOT from `currentGrid`,
   * whose owner ids are page-assigned and need not match our clue
   * indices) and consult `currentGrid` only to skip rectangles the player
   * has already drawn. Returns the first not-yet-drawn rectangle as a
   * row-anchored hint shape compatible with content.js, or null when the
   * board is already complete or the puzzle is unsolvable.
   * @param {number[][]} currentGrid  2D of cell owners (or -1 for undrawn).
   */
  getHint(currentGrid) {
    const solved = new ShikakuSolver({
      rows: this.rows, cols: this.cols, clues: this.clues,
    }).solve();
    if (!solved.solved) return null;
    const sol = solved.grid;

    const isDrawn = (r, c) => {
      const row = currentGrid && currentGrid[r];
      const v = row ? row[c] : -1;
      return Number.isInteger(v) && v >= 0;
    };

    for (let ci = 0; ci < this.clues.length; ci++) {
      const cells2d = [];
      let hasUndrawn = false;
      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) {
          if (sol[r][c] === ci) {
            cells2d.push({ row: r, col: c, value: ci });
            if (!isDrawn(r, c)) hasUndrawn = true;
          }
        }
      }
      if (!hasUndrawn || cells2d.length === 0) continue;

      const base = cells2d[0];
      const cells = [];
      const extraCells = [];
      for (const f of cells2d) {
        if (f.row === base.row) cells.push({ index: f.col, value: f.value });
        else extraCells.push({ row: f.row, col: f.col, value: f.value });
      }
      return {
        type: 'row',
        index: base.row,
        clue: {
          row: this.clues[ci].row,
          col: this.clues[ci].col,
          area: this.clues[ci].area,
        },
        cells,
        extraCells,
        count: cells2d.length,
      };
    }
    return null;
  }
}

function _rectsOverlap(a, b) {
  return !(a.r2 < b.r1 || b.r2 < a.r1 || a.c2 < b.c1 || b.c2 < a.c1);
}

class YinYangSolver {
  /**
   * @param {{
   *   rows: number,
   *   cols: number,
   *   task: number[][],
   *   initialState?: number[][],
   * }} opts
   *   `task`         2D givens, page-native (-1=none, 0=given-white, 1=given-black).
   *   `initialState` optional 2D in cellStatus encoding (0=empty, 1=black, 2=white);
   *                  when present it seeds the grid instead of the translated givens.
   */
  constructor({ rows, cols, task, initialState }) {
    if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows <= 0 || cols <= 0) {
      throw new Error('YinYangSolver: rows/cols must be positive integers');
    }
    if (!Array.isArray(task)) {
      throw new Error('YinYangSolver: task must be an array');
    }
    this.rows = rows;
    this.cols = cols;
    this.task = task.map(row => (Array.isArray(row) ? row.slice() : []));

    // Internal grid: 0=empty, 1=black, 2=white. Flat Uint8Array.
    this.grid = new Uint8Array(rows * cols);
    // Trail entries packed as (idx << 2) | oldValue. oldValue in {0,1,2}.
    this.trail = [];
    // Solve-time budget. maxMs=0 disables it.
    this.maxMs = 0;
    this._startedAt = 0;
    this._timedOut = false;
    // Lookahead control: _depth gates lookahead to the top level of the
    // search; _inLookahead prevents a probe's propagate() from recursing
    // into lookahead.
    this._depth = 0;
    this._inLookahead = false;
    // Reusable scratch buffer for the reachability BFS (avoids per-call
    // typed-array allocation in the hot propagation path).
    this._scratchSeen = new Uint8Array(rows * cols);
    // Reusable scratch buffers for the articulation-points DFS.
    this._apDisc = new Int32Array(rows * cols);
    this._apLow = new Int32Array(rows * cols);
    this._apIsAP = new Uint8Array(rows * cols);
    // Perimeter cells in cyclic order, for the border-arc rule.
    this._border = this._computeBorderCycle();

    const seed = initialState || this._gridFromGivens();
    for (let r = 0; r < rows; r++) {
      const row = seed[r] || [];
      for (let c = 0; c < cols; c++) {
        const v = row[c];
        if (v === 1 || v === 2) this.grid[r * cols + c] = v;
      }
    }
  }

  _gridFromGivens() {
    const out = [];
    for (let r = 0; r < this.rows; r++) {
      const row = this.task[r] || [];
      const dst = new Array(this.cols).fill(0);
      for (let c = 0; c < this.cols; c++) {
        const g = row[c];
        dst[c] = g === 1 ? 1 : g === 0 ? 2 : 0;
      }
      out[r] = dst;
    }
    return out;
  }

  _get(r, c) { return this.grid[r * this.cols + c]; }

  // Trailed write. Records grid[idx]'s prior value so _rollback restores it.
  // Propagation and backtracking only ever call this on empty cells.
  _assign(idx, v) {
    this.trail.push((idx << 2) | this.grid[idx]);
    this.grid[idx] = v;
  }

  _rollback(mark) {
    while (this.trail.length > mark) {
      const e = this.trail.pop();
      this.grid[e >> 2] = e & 3;
    }
  }

  _budgetExceeded() {
    if (this.maxMs <= 0) return false;
    if (Date.now() - this._startedAt > this.maxMs) {
      this._timedOut = true;
      return true;
    }
    return false;
  }

  // a=TL, b=TR, c=BL, d=BR; each in {1,2}. A full 2x2 window is illegal
  // when monochrome (all four equal) or a diagonal checkerboard (the two
  // diagonals are opposite colors).
  _is2x2Illegal(a, b, c, d) {
    const mono = a === b && b === c && c === d;
    const checker = a === d && b === c && a !== b;
    return mono || checker;
  }

  // 2x2 propagation rule. Returns false on contradiction; calls onChange()
  // whenever it forces a cell.
  _apply2x2(onChange) {
    const C = this.cols;
    for (let r = 0; r + 1 < this.rows; r++) {
      for (let c = 0; c + 1 < C; c++) {
        const idxs = [r * C + c, r * C + c + 1, (r + 1) * C + c, (r + 1) * C + c + 1];
        const vals = [
          this.grid[idxs[0]], this.grid[idxs[1]],
          this.grid[idxs[2]], this.grid[idxs[3]],
        ];
        let emptyCount = 0, emptyPos = -1;
        for (let k = 0; k < 4; k++) {
          if (vals[k] === 0) { emptyCount++; emptyPos = k; }
        }
        if (emptyCount === 0) {
          if (this._is2x2Illegal(vals[0], vals[1], vals[2], vals[3])) return false;
          continue;
        }
        if (emptyCount !== 1) continue;
        let legalVal = 0, legalCount = 0;
        for (let val = 1; val <= 2; val++) {
          vals[emptyPos] = val;
          if (!this._is2x2Illegal(vals[0], vals[1], vals[2], vals[3])) {
            legalVal = val;
            legalCount++;
          }
        }
        vals[emptyPos] = 0;
        if (legalCount === 0) return false;
        if (legalCount === 1) {
          this._assign(idxs[emptyPos], legalVal);
          onChange();
        }
      }
    }
    return true;
  }

  // True iff every placed cell of `color` is mutually reachable through
  // {color cells ∪ empty cells}. When blockIdx >= 0 that cell is treated as
  // impassable (removed from the graph) — used by the cut probe below.
  _colorConnected(color, blockIdx) {
    const C = this.cols, R = this.rows, N = R * C;
    let start = -1, placedCount = 0;
    for (let i = 0; i < N; i++) {
      if (i === blockIdx) continue;
      if (this.grid[i] === color) {
        placedCount++;
        if (start === -1) start = i;
      }
    }
    // 0 or 1 placed cells of this colour: nothing to disconnect. (On real
    // >=6x6 boards the 2x2 rule guarantees both colours appear.)
    if (placedCount <= 1) return true;
    const seen = new Uint8Array(N);
    const stack = [start];
    seen[start] = 1;
    let reached = 1;
    while (stack.length) {
      const cur = stack.pop();
      const r = (cur / C) | 0, c = cur % C;
      const nbrs = [];
      if (r > 0) nbrs.push(cur - C);
      if (r + 1 < R) nbrs.push(cur + C);
      if (c > 0) nbrs.push(cur - 1);
      if (c + 1 < C) nbrs.push(cur + 1);
      for (const nb of nbrs) {
        if (seen[nb] || nb === blockIdx) continue;
        const gv = this.grid[nb];
        if (gv === color || gv === 0) {
          seen[nb] = 1;
          if (gv === color) reached++;
          stack.push(nb);
        }
      }
    }
    return reached === placedCount;
  }

  // Reachability deduction for one colour. BFS the graph of cells that are
  // `color` or empty, starting from a placed-`color` cell. Returns false if
  // the colour's placed cells are severed (a contradiction). Any empty cell
  // the BFS cannot reach can never be `color`, so it is forced to the other
  // colour. Calls onChange() for each forced cell.
  _applyReachability(color, onChange) {
    const C = this.cols, R = this.rows, N = R * C;
    let start = -1, placedCount = 0;
    for (let i = 0; i < N; i++) {
      if (this.grid[i] === color) {
        placedCount++;
        if (start === -1) start = i;
      }
    }
    if (placedCount === 0) return true;

    const seen = this._scratchSeen;
    seen.fill(0);
    const stack = [start];
    seen[start] = 1;
    let reachedPlaced = 1;
    const consider = (nb) => {
      if (seen[nb]) return;
      const gv = this.grid[nb];
      if (gv === color || gv === 0) {
        seen[nb] = 1;
        if (gv === color) reachedPlaced++;
        stack.push(nb);
      }
    };
    while (stack.length) {
      const cur = stack.pop();
      const r = (cur / C) | 0, c = cur % C;
      if (r > 0) consider(cur - C);
      if (r + 1 < R) consider(cur + C);
      if (c > 0) consider(cur - 1);
      if (c + 1 < C) consider(cur + 1);
    }

    if (reachedPlaced !== placedCount) return false;

    const other = color === 1 ? 2 : 1;
    for (let i = 0; i < N; i++) {
      if (this.grid[i] === 0 && !seen[i]) {
        this._assign(i, other);
        onChange();
      }
    }
    return true;
  }

  // Articulation points of the graph of cells that are `color` or empty
  // (4-neighbour adjacency), via a standard Tarjan DFS. Returns an array of
  // cell indices. Recursion depth is bounded by the cell count, which is
  // safe for the puzzle sizes here (<= ~40x40).
  _articulationPoints(color) {
    const C = this.cols, R = this.rows, N = R * C;
    const grid = this.grid;
    const disc = this._apDisc; disc.fill(-1);
    const low = this._apLow;
    const isAP = this._apIsAP; isAP.fill(0);
    let timer = 0;

    const dfs = (u, parent) => {
      disc[u] = low[u] = timer++;
      let children = 0;
      const r = (u / C) | 0, c = u % C;
      for (let d = 0; d < 4; d++) {
        let v = -1;
        if (d === 0) { if (r > 0) v = u - C; }
        else if (d === 1) { if (r + 1 < R) v = u + C; }
        else if (d === 2) { if (c > 0) v = u - 1; }
        else { if (c + 1 < C) v = u + 1; }
        if (v < 0) continue;
        if (grid[v] !== color && grid[v] !== 0) continue;
        if (disc[v] === -1) {
          children++;
          dfs(v, u);
          if (low[v] < low[u]) low[u] = low[v];
          if (parent !== -1 && low[v] >= disc[u]) isAP[u] = 1;
        } else if (v !== parent) {
          if (disc[v] < low[u]) low[u] = disc[v];
        }
      }
      if (parent === -1 && children > 1) isAP[u] = 1;
    };

    for (let i = 0; i < N; i++) {
      if ((grid[i] === color || grid[i] === 0) && disc[i] === -1) dfs(i, -1);
    }

    const out = [];
    for (let i = 0; i < N; i++) if (isAP[i]) out.push(i);
    return out;
  }

  // Cut deduction for one colour. Any articulation point of the
  // {color ∪ empty} graph that is empty and whose removal would sever the
  // colour's placed cells must itself be that colour. Calls onChange() for
  // each forced cell.
  _applyCut(color, onChange) {
    const aps = this._articulationPoints(color);
    for (const ap of aps) {
      if (this.grid[ap] !== 0) continue;
      if (!this._colorConnected(color, ap)) {
        this._assign(ap, color);
        onChange();
      }
    }
  }

  // Connectivity propagation. Returns false on contradiction; calls
  // onChange() whenever it forces a cell. Runs the reachability rule (forces
  // cells that can never be a colour, and detects severed colours) then the
  // cut rule (forces bottleneck cells) for each colour. The propagate()
  // fixpoint loop re-runs this until nothing changes.
  _applyConnectivity(onChange) {
    for (let color = 1; color <= 2; color++) {
      if (!this._applyReachability(color, onChange)) return false;
    }
    for (let color = 1; color <= 2; color++) {
      this._applyCut(color, onChange);
    }
    return true;
  }

  // Probe one empty cell `idx`: tentatively place each colour and run a
  // (lookahead-free) propagate(). Returns 1 or 2 if exactly that colour is
  // forced (the other colour leads to a contradiction), -1 if both colours
  // lead to a contradiction, 0 if neither does. The caller must have set
  // `_inLookahead` so the probe's propagate() does not recurse into lookahead.
  _lookaheadProbe(idx) {
    let mark = this.trail.length;
    this._assign(idx, 1);
    const blackBad = !this.propagate();
    this._rollback(mark);
    mark = this.trail.length;
    this._assign(idx, 2);
    const whiteBad = !this.propagate();
    this._rollback(mark);
    if (blackBad && whiteBad) return -1;
    if (blackBad) return 2;
    if (whiteBad) return 1;
    return 0;
  }

  // 1-step lookahead. For each empty cell, probe both colours; if exactly
  // one colour leads to a contradiction, force the other. If both do, the
  // board is unsolvable. Returns false on contradiction, true otherwise.
  // Calls onChange() for each forced cell. Expensive — propagate() runs it
  // only at the top level.
  _applyLookahead(onChange) {
    const N = this.rows * this.cols;
    this._inLookahead = true;
    try {
      for (let i = 0; i < N; i++) {
        if (this.grid[i] !== 0) continue;
        if (this._budgetExceeded()) return true;
        const forced = this._lookaheadProbe(i);
        if (forced === -1) return false;
        if (forced !== 0) { this._assign(i, forced); onChange(); }
      }
      return true;
    } finally {
      this._inLookahead = false;
    }
  }

  // The perimeter cells in cyclic order (top L->R, right T->B, bottom R->L,
  // left B->T). Empty for grids too small to have a perimeter cycle.
  _computeBorderCycle() {
    const R = this.rows, C = this.cols;
    if (R < 2 || C < 2) return [];
    const out = [];
    for (let c = 0; c < C; c++) out.push(c);
    for (let r = 1; r < R; r++) out.push(r * C + (C - 1));
    for (let c = C - 2; c >= 0; c--) out.push((R - 1) * C + c);
    for (let r = R - 2; r >= 1; r--) out.push(r * C);
    return out;
  }

  // Count colour transitions around the border cycle, considering only
  // placed cells (empties skipped). `extraIdx`/`extraColor` let a probe
  // treat one otherwise-empty cell as tentatively coloured (pass -1/0 for
  // no probe). The transition count equals the number of border arcs when
  // it is >= 2; 0 transitions means a single arc.
  _borderTransitions(extraIdx, extraColor) {
    const border = this._border;
    const seq = [];
    for (let i = 0; i < border.length; i++) {
      const idx = border[i];
      const v = idx === extraIdx ? extraColor : this.grid[idx];
      if (v === 1 || v === 2) seq.push(v);
    }
    const L = seq.length;
    if (L < 2) return 0;
    let t = 0;
    for (let i = 0; i < L; i++) {
      if (seq[i] !== seq[(i + 1) % L]) t++;
    }
    return t;
  }

  // Border-arc deduction. A valid Yin-Yang has at most 2 border arcs, i.e.
  // at most 2 colour transitions around the perimeter; >= 4 transitions is
  // impossible. Returns false on contradiction; forces any empty border
  // cell whose wrong colour would create a 3rd arc. Calls onChange() for
  // each forced cell.
  _applyBorderArc(onChange) {
    if (this.rows < 2 || this.cols < 2) return true;
    if (this._borderTransitions(-1, 0) >= 4) return false;
    const border = this._border;
    for (let i = 0; i < border.length; i++) {
      const idx = border[i];
      if (this.grid[idx] !== 0) continue;
      const blackBad = this._borderTransitions(idx, 1) >= 4;
      const whiteBad = this._borderTransitions(idx, 2) >= 4;
      if (blackBad && whiteBad) return false;
      if (blackBad) { this._assign(idx, 2); onChange(); }
      else if (whiteBad) { this._assign(idx, 1); onChange(); }
    }
    return true;
  }

  // Iterate the propagation rules to a fixpoint. Returns false on
  // contradiction. The local rules (2x2, connectivity) run to a fixpoint;
  // then at the top level (_depth === 0, not already inside a lookahead
  // probe) the 1-step lookahead runs, and if it forces anything the whole
  // process repeats.
  propagate() {
    let progress = true;
    while (progress) {
      progress = false;
      let changed = true;
      while (changed) {
        if (this._budgetExceeded()) return false;
        changed = false;
        const onChange = () => { changed = true; };
        if (!this._apply2x2(onChange)) return false;
        if (!this._applyConnectivity(onChange)) return false;
        if (!this._applyBorderArc(onChange)) return false;
      }
      if (this._depth === 0 && !this._inLookahead) {
        let laChanged = false;
        if (!this._applyLookahead(() => { laChanged = true; })) return false;
        if (laChanged) progress = true;
      }
    }
    return true;
  }

  _isComplete() {
    for (let i = 0; i < this.grid.length; i++) {
      if (this.grid[i] === 0) return false;
    }
    return true;
  }

  _gridTo2D() {
    const out = [];
    for (let r = 0; r < this.rows; r++) {
      const row = new Array(this.cols);
      for (let c = 0; c < this.cols; c++) row[c] = this.grid[r * this.cols + c];
      out[r] = row;
    }
    return out;
  }

  // Most-constrained variable: the empty cell touching the most non-empty
  // neighbours. Keeps the search frontier tight so connectivity prunes hard.
  _pickCell() {
    const C = this.cols, R = this.rows, N = R * C;
    let best = -1, bestScore = -1;
    for (let i = 0; i < N; i++) {
      if (this.grid[i] !== 0) continue;
      const r = (i / C) | 0, c = i % C;
      let score = 0;
      if (r > 0 && this.grid[i - C] !== 0) score++;
      if (r + 1 < R && this.grid[i + C] !== 0) score++;
      if (c > 0 && this.grid[i - 1] !== 0) score++;
      if (c + 1 < C && this.grid[i + 1] !== 0) score++;
      if (score > bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  _backtrack() {
    if (this._budgetExceeded()) return false;
    const target = this._pickCell();
    if (target === -1) return this._isComplete();
    for (let val = 1; val <= 2; val++) {
      const mark = this.trail.length;
      this._assign(target, val);
      if (this.propagate()) {
        if (this._isComplete() || this._backtrack()) return true;
      }
      this._rollback(mark);
      if (this._timedOut) return false;
    }
    return false;
  }

  /**
   * Return a hint for `currentGrid` — a row-anchored shape matching
   * BinairoSolver.getHint, or null if nothing is deducible / the board is
   * contradictory. First tries the fast local rules; if they deduce
   * nothing, falls back to a single lookahead deduction plus the local
   * cascade it triggers — an immediate next step, not the whole solvable
   * remainder.
   * @param {number[][]} currentGrid  2D in cellStatus encoding (0/1/2).
   */
  getHint(currentGrid) {
    return this._localHint(currentGrid) || this._lookaheadStepHint(currentGrid);
  }

  // Hint from the local rules only (2x2, connectivity, border-arc) — fast.
  // Returns a row-anchored hint of every cell the local rules force, or
  // null when they force nothing / the board is contradictory.
  _localHint(currentGrid) {
    const clone = new YinYangSolver({
      rows: this.rows, cols: this.cols, task: this.task,
      initialState: currentGrid,
    });
    clone._depth = 1; // local rules only — no lookahead
    const before = new Uint8Array(clone.grid);
    if (!clone.propagate()) return null;
    return clone._collectHint(before);
  }

  // Hint from ONE lookahead deduction plus the local cascade it triggers.
  // Probes empty cells in order, applies the first cell a 1-step lookahead
  // can force, then lets the local rules settle — keeping each Hint to an
  // immediate next step rather than the whole solvable remainder. Returns
  // null if no lookahead deduction is available / the board is contradictory.
  _lookaheadStepHint(currentGrid) {
    const clone = new YinYangSolver({
      rows: this.rows, cols: this.cols, task: this.task,
      initialState: currentGrid,
    });
    clone._depth = 1; // the cascade uses local rules only
    if (!clone.propagate()) return null;
    const before = new Uint8Array(clone.grid);

    let forcedIdx = -1, forcedColor = 0;
    clone._inLookahead = true;
    try {
      for (let i = 0; i < clone.grid.length; i++) {
        if (clone.grid[i] !== 0) continue;
        const forced = clone._lookaheadProbe(i);
        if (forced === -1) return null;
        if (forced !== 0) { forcedIdx = i; forcedColor = forced; break; }
      }
    } finally {
      clone._inLookahead = false;
    }
    if (forcedIdx === -1) return null;

    clone._assign(forcedIdx, forcedColor);
    if (!clone.propagate()) return null;
    return clone._collectHint(before);
  }

  // Build a row-anchored hint (matching BinairoSolver.getHint) from the
  // cells that went from empty in `before` to placed in the current grid.
  // Returns null if nothing changed.
  _collectHint(before) {
    const cells2d = [];
    for (let i = 0; i < before.length; i++) {
      if (before[i] === 0 && this.grid[i] !== 0) {
        cells2d.push({
          row: (i / this.cols) | 0,
          col: i % this.cols,
          value: this.grid[i],
        });
      }
    }
    if (cells2d.length === 0) return null;

    const base = cells2d[0];
    const cells = [];
    const extraCells = [];
    for (const f of cells2d) {
      if (f.row === base.row) cells.push({ index: f.col, value: f.value });
      else extraCells.push({ row: f.row, col: f.col, value: f.value });
    }
    return { type: 'row', index: base.row, cells, extraCells, count: cells2d.length };
  }

  /**
   * @returns {{ solved: boolean, grid: number[][] | null, error?: string }}
   */
  solve() {
    const key = this._cacheKey();
    const cached = YinYangSolver._solutionCache.get(key);
    if (cached) return { solved: true, grid: cached.map(row => row.slice()) };

    this._startedAt = Date.now();
    this._timedOut = false;
    this._depth = 0;
    this._inLookahead = false;

    if (!this.propagate()) {
      return {
        solved: false, grid: null,
        error: this._timedOut ? 'timed out' : 'contradiction on initial propagation',
      };
    }
    if (this._isComplete()) {
      const grid = this._gridTo2D();
      this._storeInCache(key, grid);
      return { solved: true, grid };
    }
    this._depth = 1;
    if (this._backtrack()) {
      const grid = this._gridTo2D();
      this._storeInCache(key, grid);
      return { solved: true, grid };
    }
    return {
      solved: false, grid: null,
      error: this._timedOut ? 'timed out' : 'no solution found',
    };
  }

  static _solutionCache = new Map();
  static _maxSolutionCache = 50;

  static clearSolutionCache() {
    YinYangSolver._solutionCache.clear();
  }

  _cacheKey() {
    // FNV-1a over (rows, cols, flattened task). Returns a 32-bit uint string.
    let h = 0x811c9dc5;
    const mix = (n) => { h ^= n; h = Math.imul(h, 0x01000193) >>> 0; };
    mix(this.rows);
    mix(this.cols);
    for (let r = 0; r < this.rows; r++) {
      const row = this.task[r] || [];
      for (let c = 0; c < this.cols; c++) mix((row[c] | 0) + 2); // -1..1 -> 1..3
    }
    return String(h >>> 0);
  }

  _storeInCache(key, grid) {
    const m = YinYangSolver._solutionCache;
    if (m.size >= YinYangSolver._maxSolutionCache) {
      m.delete(m.keys().next().value);
    }
    m.set(key, grid.map(row => row.slice()));
  }
}

/**
 * Slitherlink ("Loop") solver. Edge-variable propagation + backtracking,
 * modeled on GalaxiesSolver's trail-based undo. See CLAUDE.md "Slitherlink
 * encoding" for the design notes.
 *
 * Edge encoding (internal): 0=UNKNOWN, 1=LINE, 2=EMPTY. Chosen so 1 maps
 * straight onto the page's `cellHorizontalStatus`/`cellVerticalStatus`
 * encoding for apply.
 *
 * Edge indexing: horizontal edge H[r][c] (r in 0..H, c in 0..W-1) joins
 * dot (r,c) and dot (r,c+1). Vertical edge V[r][c] (r in 0..H-1, c in
 * 0..W) joins dot (r,c) and dot (r+1,c). Flat ids:
 *   _hIdx(r, c) = r * W + c
 *   _vIdx(r, c) = r * (W + 1) + c
 *   _dotId(r, c) = r * (W + 1) + c
 */
class SlitherlinkSolver {
  /**
   * @param {{
   *   width: number,
   *   height: number,
   *   task: number[][],
   *   initialState?: { horizontal: number[][], vertical: number[][] },
   *   maxMs?: number,
   * }} opts
   */
  constructor({ width, height, task, initialState, maxMs }) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new Error('SlitherlinkSolver: width/height must be positive integers');
    }
    if (!Array.isArray(task)) {
      throw new Error('SlitherlinkSolver: task must be an array');
    }
    this.width = width;
    this.height = height;
    this.task = task.map(row => (Array.isArray(row) ? row.slice() : []));
    this.maxMs = maxMs | 0;
    this._startedAt = 0;
    this._timedOut = false;
    // Lookahead / backtracking depth control.
    this._depth = 0;
    this._inLookahead = false;

    // CDCL variable counts. Must be set after width/height.
    const _W = width, _H = height;
    this.numH = (_H + 1) * _W;
    this.numV = _H * (_W + 1);
    this.cellCount = _H * _W;
    this.totalVars = this.numH + this.numV + this.cellCount;

    const W = width, H = height;
    // (H+1) * W horizontal edge slots; H * (W+1) vertical edge slots.
    this.H = new Uint8Array((H + 1) * W);
    this.V = new Uint8Array(H * (W + 1));

    // Cell colors: 0 = UNKNOWN, 1 = INSIDE, 2 = OUTSIDE.
    // The loop divides the plane into inside/outside; adjacent cells sharing an
    // edge differ in color iff that edge is LINE.
    this.colors = new Uint8Array(H * W);

    // Trail entries encoding (2-bit kind in bits 24-25):
    //   kind=0 (H edge): (0 << 24) | idx
    //   kind=1 (V edge): (1 << 24) | idx
    //   kind=2 (color):  (oldColor << 26) | (2 << 24) | idx
    // oldColor ∈ {1=INSIDE, 2=OUTSIDE} (UNKNOWN=0 is never trailed).
    // Edge entries: old value is always 0 (UNKNOWN) so we don't trail it.
    this.trail = [];

    // ── CDCL reason tracking (parallel to this.trail) ────────────────────
    // _reasons[i]: null = decision; [...varIds] = propagation antecedents.
    // _decisionLevels[i]: decision level at the time of the trail entry.
    this._reasons = [];
    this._decisionLevels = [];
    // Current search decision level (0 = top-level propagation).
    this._decisionLevel = 0;
    // Set by a rule helper before it calls _setEdge/_setColor so those
    // setters can capture the reason. Decisions set it to null explicitly.
    this._currentReason = null;

    // Learned clause storage (CDCL).
    this._learnedClauses = [];       // [{ literals: int[], activity: number }]
    this._maxLearnedClauses = 5000;
    this._lastConflictReason = null; // set by any rule that returns false

    // Scratch arrays for connectivity propagation (_propagateConnectivity).
    const N = H * W;
    this._slSeen = new Uint8Array(N);
    this._slSeen2 = new Uint8Array(N);
    this._slApDisc = new Int32Array(N);
    this._slApLow = new Int32Array(N);
    this._slApIsAP = new Uint8Array(N);

    // Per-dot incidence counters. Maintained incrementally so propagation
    // never has to recount.
    const D = (H + 1) * (W + 1);
    this.lineCount = new Int16Array(D);
    this.unknownCount = new Int16Array(D);
    // Initialize unknownCount with each dot's actual edge count (corners=2,
    // borders=3, interior=4).
    for (let r = 0; r <= H; r++) {
      for (let c = 0; c <= W; c++) {
        let cnt = 0;
        if (c > 0) cnt++;            // H[r][c-1]
        if (c < W) cnt++;            // H[r][c]
        if (r > 0) cnt++;            // V[r-1][c]
        if (r < H) cnt++;            // V[r][c]
        this.unknownCount[r * (W + 1) + c] = cnt;
      }
    }

    // Apply initialState if provided. We DO go through _setEdge so dot
    // counters stay consistent; we just discard the trail afterwards (the
    // initial state is the baseline, not something to roll back).
    if (initialState) {
      const ih = initialState.horizontal || [];
      const iv = initialState.vertical || [];
      for (let r = 0; r <= H; r++) {
        const row = ih[r] || [];
        for (let c = 0; c < W; c++) {
          if (row[c] === 1) this._setEdge(this._hIdx(r, c), 'H', 1);
          else if (row[c] === 2) this._setEdge(this._hIdx(r, c), 'H', 2);
        }
      }
      for (let r = 0; r < H; r++) {
        const row = iv[r] || [];
        for (let c = 0; c <= W; c++) {
          if (row[c] === 1) this._setEdge(this._vIdx(r, c), 'V', 1);
          else if (row[c] === 2) this._setEdge(this._vIdx(r, c), 'V', 2);
        }
      }
      this.trail.length = 0;  // baseline — never roll back through it
      this._reasons.length = 0;
      this._decisionLevels.length = 0;
    }
  }

  _hIdx(r, c) { return r * this.width + c; }
  _vIdx(r, c) { return r * (this.width + 1) + c; }
  _dotId(r, c) { return r * (this.width + 1) + c; }

  // ── CDCL variable encoding ───────────────────────────────────────────────
  // Variable IDs: [0, numH) = H edges, [numH, numH+numV) = V edges,
  // [numH+numV, totalVars) = cell colors (row-major).

  /** @param {'H'|'V'} kind @param {number} idx @returns {number} */
  _varIdEdge(kind, idx) {
    return kind === 'H' ? idx : this.numH + idx;
  }

  /** @param {number} cellIdx  (r * width + c) @returns {number} */
  _varIdCell(cellIdx) {
    return this.numH + this.numV + cellIdx;
  }

  /** @param {number} varId @returns {{ kind: 'H'|'V'|'C', idx: number }} */
  _decodeVar(varId) {
    if (varId < this.numH) return { kind: 'H', idx: varId };
    if (varId < this.numH + this.numV) return { kind: 'V', idx: varId - this.numH };
    return { kind: 'C', idx: varId - this.numH - this.numV };
  }

  /**
   * Current sign of variable `varId`:
   *  +1 if true  (edge=LINE  or cell=INSIDE)
   *  -1 if false (edge=EMPTY or cell=OUTSIDE)
   *   0 if UNKNOWN
   * @param {number} varId
   * @returns {-1|0|1}
   */
  _varValue(varId) {
    const d = this._decodeVar(varId);
    if (d.kind === 'H') {
      const v = this.H[d.idx];
      return v === 0 ? 0 : v === 1 ? 1 : -1;
    }
    if (d.kind === 'V') {
      const v = this.V[d.idx];
      return v === 0 ? 0 : v === 1 ? 1 : -1;
    }
    const c = this.colors[d.idx];
    return c === 0 ? 0 : c === 1 ? 1 : -1;
  }

  // Returns [u, v] dot ids that an edge joins.
  _edgeEndpoints(kind, idx) {
    const W = this.width;
    if (kind === 'H') {
      // H[r][c] joins (r, c) and (r, c+1).
      const r = (idx / W) | 0;
      const c = idx - r * W;
      return [this._dotId(r, c), this._dotId(r, c + 1)];
    } else {
      // V[r][c] joins (r, c) and (r+1, c).
      const stride = W + 1;
      const r = (idx / stride) | 0;
      const c = idx - r * stride;
      return [this._dotId(r, c), this._dotId(r + 1, c)];
    }
  }

  // Trailed write. Returns false if the new value would conflict with an
  // existing assignment (i.e., the edge is already set to a different
  // non-UNKNOWN value). UNKNOWN→UNKNOWN is a no-op and returns true.
  _setEdge(idx, kind, val) {
    const arr = kind === 'H' ? this.H : this.V;
    const old = arr[idx];
    if (old === val) return true;
    if (old !== 0) return false;  // attempted to overwrite an existing value
    const kindBit = kind === 'H' ? 0 : 1;
    this.trail.push((kindBit << 24) | idx);
    this._reasons.push(this._currentReason);
    this._decisionLevels.push(this._decisionLevel);
    this._currentReason = null;
    arr[idx] = val;
    // Update endpoint counters.
    const [u, v] = this._edgeEndpoints(kind, idx);
    this.unknownCount[u]--;
    this.unknownCount[v]--;
    if (val === 1) {
      this.lineCount[u]++;
      this.lineCount[v]++;
    }
    return true;
  }

  _rollback(mark) {
    while (this.trail.length > mark) {
      const e = this.trail.pop();
      this._reasons.pop();
      this._decisionLevels.pop();
      const idx = e & 0xFFFFFF;
      const kind = (e >> 24) & 3;  // 2-bit kind: 0=H, 1=V, 2=color
      if (kind === 2) {
        // Color entry: restore old color from bits 26-27.
        this.colors[idx] = (e >> 26) & 3;
      } else {
        // Edge entry (kind 0=H, 1=V).
        const arr = kind === 0 ? this.H : this.V;
        const edgeKind = kind === 0 ? 'H' : 'V';
        const cur = arr[idx];
        arr[idx] = 0;
        const [u, v] = this._edgeEndpoints(edgeKind, idx);
        this.unknownCount[u]++;
        this.unknownCount[v]++;
        if (cur === 1) {
          this.lineCount[u]--;
          this.lineCount[v]--;
        }
      }
    }
  }

  _budgetExceeded() {
    if (this.maxMs <= 0) return false;
    if (Date.now() - this._startedAt > this.maxMs) {
      this._timedOut = true;
      return true;
    }
    return false;
  }

  // Trailed write for cell colors. Returns false on conflict (cell already
  // known to a different color). UNKNOWN→same is a no-op that returns true.
  _setColor(idx, color) {
    const old = this.colors[idx];
    if (old === color) return true;
    if (old !== 0) return false;  // conflict
    this.trail.push((old << 26) | (2 << 24) | idx);
    this._reasons.push(this._currentReason);
    this._decisionLevels.push(this._decisionLevel);
    this._currentReason = null;
    this.colors[idx] = color;
    return true;
  }

  // Maps a SAT literal to the corresponding _setEdge / _setColor call.
  // Literal encoding: lit >= 0 means positive (LINE/INSIDE = 1), lit < 0 means
  // negative (EMPTY/OUTSIDE = 2). Variable IDs are non-negative; negation is
  // represented as ~varId (bitwise NOT, always negative).
  // Returns false on conflict (same contract as _setEdge/_setColor).
  _forceLiteral(lit) {
    const varId = lit >= 0 ? lit : ~lit;
    const decoded = this._decodeVar(varId);
    const positive = lit >= 0;
    if (decoded.kind === 'H') {
      return this._setEdge(decoded.idx, 'H', positive ? 1 : 2);
    }
    if (decoded.kind === 'V') {
      return this._setEdge(decoded.idx, 'V', positive ? 1 : 2);
    }
    return this._setColor(decoded.idx, positive ? 1 : 2);
  }

  // Propagates all learned clauses as unit-propagation rules.
  // Literal encoding: lit >= 0 = positive (LINE/INSIDE), lit < 0 = negative
  // (EMPTY/OUTSIDE), varId = lit >= 0 ? lit : ~lit.
  // For each clause:
  //   - already satisfied → skip
  //   - all literals false (conflict) → set _lastConflictReason, return false
  //   - exactly one literal unassigned (unit) → force it, bump activity
  // Returns true iff no contradiction was found.
  _propagateLearnedClauses(onChange) {
    for (const clause of this._learnedClauses) {
      let unassignedCount = 0;
      let unassignedLit = 0;
      let satisfied = false;
      for (const lit of clause.literals) {
        const varId = lit >= 0 ? lit : ~lit;
        const v = this._varValue(varId);
        const positive = lit >= 0;
        if (v === 0) {
          unassignedCount++;
          unassignedLit = lit;
        } else if ((v > 0) === positive) {
          satisfied = true;
          break;
        }
      }
      if (satisfied) continue;
      if (unassignedCount === 0) {
        this._lastConflictReason = clause.literals.map(l => l >= 0 ? l : ~l);
        return false;
      }
      if (unassignedCount === 1) {
        this._currentReason = clause.literals
          .filter(l => l !== unassignedLit)
          .map(l => l >= 0 ? l : ~l);
        if (!this._forceLiteral(unassignedLit)) {
          this._lastConflictReason = clause.literals.map(l => l >= 0 ? l : ~l);
          return false;
        }
        onChange();
        clause.activity += 1;
      }
    }
    return true;
  }

  // Returns the color of cell (r,c): 1=INSIDE, 2=OUTSIDE, 0=UNKNOWN.
  // Out-of-grid coordinates are implicitly OUTSIDE (2).
  _colorOf(r, c) {
    if (r < 0 || r >= this.height || c < 0 || c >= this.width) return 2;
    return this.colors[r * this.width + c];
  }

  // Cell inside/outside coloring rule. Couples edge state and color in both
  // directions: LINE iff adjacent cells differ in color. Also uses known cell
  // colors to restrict neighbors of clued cells.
  //
  // Returns false on contradiction; calls onChange() for every forced edge
  // or color assignment.
  //
  // Three sub-rules:
  //   A — known edge → color: if E is LINE/EMPTY between cells A and B,
  //       the colors of A and B must differ/be equal. Force the unknown one.
  //   B — known colors → edge: if A and B both have known colors, the shared
  //       edge must be LINE (different) or EMPTY (same). Force it.
  //   C — clue × own-color: for clued cell (r,c) with known color myColor,
  //       count opposite-color (m) and unknown (u) neighbors. Apply forcing
  //       when m==k or m+u==k.
  _propagateColors(onChange) {
    const H = this.height, W = this.width;

    // ── Rule A: known edge → color relation ──────────────────────────────
    // Horizontal edges H[r][c]: separates cell (r-1,c) above and cell (r,c)
    // below. Row r of H is between row r-1 and row r of cells.
    for (let r = 0; r <= H; r++) {
      for (let c = 0; c < W; c++) {
        const e = this.H[this._hIdx(r, c)];
        if (e === 0) continue;  // unknown edge
        // Cell above: (r-1, c); cell below: (r, c).
        const colorAbove = this._colorOf(r - 1, c);
        const colorBelow = this._colorOf(r, c);
        const idxAbove = (r - 1) >= 0 ? (r - 1) * W + c : -1;
        const idxBelow = r < H ? r * W + c : -1;
        const eVar = this._varIdEdge('H', this._hIdx(r, c));
        if (e === 1) {
          // LINE → colors must differ.
          if (colorAbove !== 0 && colorBelow !== 0 && colorAbove === colorBelow) return false;
          if (colorAbove !== 0 && colorBelow === 0) {
            // Force below to opposite.
            const forced = colorAbove === 1 ? 2 : 1;
            if (idxBelow >= 0) {
              this._currentReason = [eVar, ...(idxAbove >= 0 ? [this._varIdCell(idxAbove)] : [])];
              if (!this._setColor(idxBelow, forced)) return false; onChange();
            } else if (forced !== 2) return false;  // out-of-grid must be OUTSIDE
          } else if (colorBelow !== 0 && colorAbove === 0) {
            const forced = colorBelow === 1 ? 2 : 1;
            if (idxAbove >= 0) {
              this._currentReason = [eVar, ...(idxBelow >= 0 ? [this._varIdCell(idxBelow)] : [])];
              if (!this._setColor(idxAbove, forced)) return false; onChange();
            } else if (forced !== 2) return false;
          }
        } else {
          // EMPTY → colors must be same.
          if (colorAbove !== 0 && colorBelow !== 0 && colorAbove !== colorBelow) return false;
          if (colorAbove !== 0 && colorBelow === 0) {
            if (idxBelow >= 0) {
              this._currentReason = [eVar, ...(idxAbove >= 0 ? [this._varIdCell(idxAbove)] : [])];
              if (!this._setColor(idxBelow, colorAbove)) return false; onChange();
            } else if (colorAbove !== 2) return false;
          } else if (colorBelow !== 0 && colorAbove === 0) {
            if (idxAbove >= 0) {
              this._currentReason = [eVar, ...(idxBelow >= 0 ? [this._varIdCell(idxBelow)] : [])];
              if (!this._setColor(idxAbove, colorBelow)) return false; onChange();
            } else if (colorBelow !== 2) return false;
          }
        }
      }
    }

    // Vertical edges V[r][c]: separates cell (r,c-1) to the left and cell
    // (r,c) to the right.
    for (let r = 0; r < H; r++) {
      for (let c = 0; c <= W; c++) {
        const e = this.V[this._vIdx(r, c)];
        if (e === 0) continue;
        const colorLeft = this._colorOf(r, c - 1);
        const colorRight = this._colorOf(r, c);
        const idxLeft = (c - 1) >= 0 ? r * W + (c - 1) : -1;
        const idxRight = c < W ? r * W + c : -1;
        const eVar = this._varIdEdge('V', this._vIdx(r, c));
        if (e === 1) {
          if (colorLeft !== 0 && colorRight !== 0 && colorLeft === colorRight) return false;
          if (colorLeft !== 0 && colorRight === 0) {
            const forced = colorLeft === 1 ? 2 : 1;
            if (idxRight >= 0) {
              this._currentReason = [eVar, ...(idxLeft >= 0 ? [this._varIdCell(idxLeft)] : [])];
              if (!this._setColor(idxRight, forced)) return false; onChange();
            } else if (forced !== 2) return false;
          } else if (colorRight !== 0 && colorLeft === 0) {
            const forced = colorRight === 1 ? 2 : 1;
            if (idxLeft >= 0) {
              this._currentReason = [eVar, ...(idxRight >= 0 ? [this._varIdCell(idxRight)] : [])];
              if (!this._setColor(idxLeft, forced)) return false; onChange();
            } else if (forced !== 2) return false;
          }
        } else {
          if (colorLeft !== 0 && colorRight !== 0 && colorLeft !== colorRight) return false;
          if (colorLeft !== 0 && colorRight === 0) {
            if (idxRight >= 0) {
              this._currentReason = [eVar, ...(idxLeft >= 0 ? [this._varIdCell(idxLeft)] : [])];
              if (!this._setColor(idxRight, colorLeft)) return false; onChange();
            } else if (colorLeft !== 2) return false;
          } else if (colorRight !== 0 && colorLeft === 0) {
            if (idxLeft >= 0) {
              this._currentReason = [eVar, ...(idxRight >= 0 ? [this._varIdCell(idxRight)] : [])];
              if (!this._setColor(idxLeft, colorRight)) return false; onChange();
            } else if (colorRight !== 2) return false;
          }
        }
      }
    }

    // ── Rule B: known colors → edge state ────────────────────────────────
    // Horizontal edges: cell (r-1,c) above and cell (r,c) below.
    for (let r = 0; r <= H; r++) {
      for (let c = 0; c < W; c++) {
        const eIdx = this._hIdx(r, c);
        if (this.H[eIdx] !== 0) continue;
        const colorAbove = this._colorOf(r - 1, c);
        const colorBelow = this._colorOf(r, c);
        if (colorAbove === 0 || colorBelow === 0) continue;
        const idxAbove = (r - 1) >= 0 ? (r - 1) * W + c : -1;
        const idxBelow = r < H ? r * W + c : -1;
        const expectedEdge = colorAbove !== colorBelow ? 1 : 2;
        const antecedents = [];
        if (idxAbove >= 0) antecedents.push(this._varIdCell(idxAbove));
        if (idxBelow >= 0) antecedents.push(this._varIdCell(idxBelow));
        this._currentReason = antecedents;
        if (!this._setEdge(eIdx, 'H', expectedEdge)) return false;
        onChange();
      }
    }
    // Vertical edges: cell (r,c-1) to the left and cell (r,c) to the right.
    for (let r = 0; r < H; r++) {
      for (let c = 0; c <= W; c++) {
        const eIdx = this._vIdx(r, c);
        if (this.V[eIdx] !== 0) continue;
        const colorLeft = this._colorOf(r, c - 1);
        const colorRight = this._colorOf(r, c);
        if (colorLeft === 0 || colorRight === 0) continue;
        const idxLeft = (c - 1) >= 0 ? r * W + (c - 1) : -1;
        const idxRight = c < W ? r * W + c : -1;
        const expectedEdge = colorLeft !== colorRight ? 1 : 2;
        const antecedents = [];
        if (idxLeft >= 0) antecedents.push(this._varIdCell(idxLeft));
        if (idxRight >= 0) antecedents.push(this._varIdCell(idxRight));
        this._currentReason = antecedents;
        if (!this._setEdge(eIdx, 'V', expectedEdge)) return false;
        onChange();
      }
    }

    // ── Rule C: clue × own-color ──────────────────────────────────────────
    // Neighbors in order: above (r-1,c), below (r+1,c), left (r,c-1),
    // right (r,c+1). Out-of-grid treated as OUTSIDE (2).
    for (let r = 0; r < H; r++) {
      const taskRow = this.task[r] || [];
      for (let c = 0; c < W; c++) {
        const clue = taskRow[c];
        if (clue === undefined || clue < 0 || clue > 4) continue;
        const myIdx = r * W + c;
        const myColor = this._colorOf(r, c);
        if (myColor === 0) continue;
        const opposite = myColor === 1 ? 2 : 1;
        const myVar = this._varIdCell(myIdx);
        const nbrs = [[r-1,c],[r+1,c],[r,c-1],[r,c+1]];
        let m = 0, u = 0;
        const oppositeVars = [];
        for (const [nr, nc] of nbrs) {
          const nc2 = this._colorOf(nr, nc);
          if (nc2 === opposite) {
            m++;
            if (nr >= 0 && nr < H && nc >= 0 && nc < W) oppositeVars.push(this._varIdCell(nr * W + nc));
          } else if (nc2 === 0) u++;
        }
        if (m > clue) return false;
        if (m + u < clue) return false;
        if (m === clue && u > 0) {
          // Force all unknown neighbors to same color as myColor.
          const antecedents = [myVar, ...oppositeVars];
          for (const [nr, nc] of nbrs) {
            if (nr < 0 || nr >= H || nc < 0 || nc >= W) continue;
            const ni = nr * W + nc;
            if (this.colors[ni] === 0) {
              this._currentReason = antecedents;
              if (!this._setColor(ni, myColor)) return false;
              onChange();
            }
          }
        } else if (m + u === clue && u > 0) {
          // Force all unknown neighbors to opposite color.
          const antecedents = [myVar, ...oppositeVars];
          for (const [nr, nc] of nbrs) {
            if (nr < 0 || nr >= H || nc < 0 || nc >= W) continue;
            const ni = nr * W + nc;
            if (this.colors[ni] === 0) {
              this._currentReason = antecedents;
              if (!this._setColor(ni, opposite)) return false;
              onChange();
            }
          }
        }
      }
    }

    return true;
  }

  // Return an array of 4 {kind, idx} entries describing cell (r,c)'s edges
  // in a fixed order: top, bottom, left, right.
  _cellEdges(r, c) {
    return [
      { kind: 'H', idx: this._hIdx(r, c) },         // top
      { kind: 'H', idx: this._hIdx(r + 1, c) },     // bottom
      { kind: 'V', idx: this._vIdx(r, c) },         // left
      { kind: 'V', idx: this._vIdx(r, c + 1) },     // right
    ];
  }

  // Per-cell clue forcing rule. Returns false on contradiction; calls onChange()
  // whenever it forces an edge. Skips cells without a valid clue.
  _applyClueRuleAt(r, c, onChange) {
    const clue = (this.task[r] || [])[c];
    if (clue === undefined || clue < 0 || clue > 4) return true;
    const edges = this._cellEdges(r, c);
    let m = 0, n = 0;
    for (const e of edges) {
      const v = (e.kind === 'H' ? this.H : this.V)[e.idx];
      if (v === 1) m++;
      else if (v === 0) n++;
    }
    if (m > clue) return false;
    if (m + n < clue) return false;
    if (m === clue && n > 0) {
      // All UNKNOWN edges → EMPTY.
      const antecedents = edges
        .filter(e => (e.kind === 'H' ? this.H : this.V)[e.idx] !== 0)
        .map(e => this._varIdEdge(/** @type {'H'|'V'} */ (e.kind), e.idx));
      for (const e of edges) {
        const arr = e.kind === 'H' ? this.H : this.V;
        if (arr[e.idx] === 0) {
          this._currentReason = antecedents;
          if (!this._setEdge(e.idx, e.kind, 2)) return false;
          onChange();
        }
      }
    } else if (m + n === clue && n > 0) {
      // All UNKNOWN edges → LINE.
      const antecedents = edges
        .filter(e => (e.kind === 'H' ? this.H : this.V)[e.idx] !== 0)
        .map(e => this._varIdEdge(/** @type {'H'|'V'} */ (e.kind), e.idx));
      for (const e of edges) {
        const arr = e.kind === 'H' ? this.H : this.V;
        if (arr[e.idx] === 0) {
          this._currentReason = antecedents;
          if (!this._setEdge(e.idx, e.kind, 1)) return false;
          onChange();
        }
      }
    }
    return true;
  }

  // Clue forcing rule. Returns false on contradiction; calls onChange()
  // whenever it forces an edge.
  _propagateClues(onChange) {
    const H = this.height, W = this.width;
    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) {
        if (!this._applyClueRuleAt(r, c, onChange)) return false;
      }
    }
    return true;
  }

  // Return {kind, idx} entries for the (up to 4) edges incident to dot (r,c).
  _dotEdges(r, c) {
    const H = this.height, W = this.width;
    const out = [];
    if (c > 0) out.push({ kind: 'H', idx: this._hIdx(r, c - 1) });   // left
    if (c < W) out.push({ kind: 'H', idx: this._hIdx(r, c) });       // right
    if (r > 0) out.push({ kind: 'V', idx: this._vIdx(r - 1, c) });   // up
    if (r < H) out.push({ kind: 'V', idx: this._vIdx(r, c) });       // down
    return out;
  }

  // Per-dot vertex forcing rule. Returns false on contradiction; calls onChange()
  // whenever it forces an edge.
  _applyVertexRuleAt(r, c, onChange) {
    const dotId = this._dotId(r, c);
    const m = this.lineCount[dotId];
    const n = this.unknownCount[dotId];
    if (m > 2) return false;
    if (m === 1 && n === 0) return false;
    if (m === 2 && n > 0) {
      const antecedents = this._dotEdges(r, c)
        .filter(e => (e.kind === 'H' ? this.H : this.V)[e.idx] !== 0)
        .map(e => this._varIdEdge(/** @type {'H'|'V'} */ (e.kind), e.idx));
      for (const e of this._dotEdges(r, c)) {
        const arr = e.kind === 'H' ? this.H : this.V;
        if (arr[e.idx] === 0) {
          this._currentReason = antecedents;
          if (!this._setEdge(e.idx, e.kind, 2)) return false;
          onChange();
        }
      }
    } else if (m === 1 && n === 1) {
      const antecedents = this._dotEdges(r, c)
        .filter(e => (e.kind === 'H' ? this.H : this.V)[e.idx] === 1)
        .map(e => this._varIdEdge(/** @type {'H'|'V'} */ (e.kind), e.idx));
      for (const e of this._dotEdges(r, c)) {
        const arr = e.kind === 'H' ? this.H : this.V;
        if (arr[e.idx] === 0) {
          this._currentReason = antecedents;
          if (!this._setEdge(e.idx, e.kind, 1)) return false;
          onChange();
          break;
        }
      }
    } else if (m === 0 && n === 1) {
      this._currentReason = [];
      for (const e of this._dotEdges(r, c)) {
        const arr = e.kind === 'H' ? this.H : this.V;
        if (arr[e.idx] === 0) {
          if (!this._setEdge(e.idx, e.kind, 2)) return false;
          onChange();
          break;
        }
      }
    }
    return true;
  }

  // Vertex forcing rule. Returns false on contradiction; calls onChange()
  // whenever it forces an edge.
  _propagateVertices(onChange) {
    const H = this.height, W = this.width;
    for (let r = 0; r <= H; r++) {
      for (let c = 0; c <= W; c++) {
        if (!this._applyVertexRuleAt(r, c, onChange)) return false;
      }
    }
    return true;
  }

  _dsuMakeArrays() {
    const D = (this.height + 1) * (this.width + 1);
    if (!this._dsuParent || this._dsuParent.length !== D) {
      this._dsuParent = new Int32Array(D);
      this._dsuRank = new Int8Array(D);
    }
  }

  _dsuFind(x) {
    const p = this._dsuParent;
    let r = x;
    while (p[r] !== r) r = p[r];
    // Path compression.
    while (p[x] !== r) { const next = p[x]; p[x] = r; x = next; }
    return r;
  }

  // Rebuild the DSU over all currently-LINE edges. Sets `_cycleClosed` true
  // iff at least one LINE edge's endpoints were already in the same
  // component before that edge was unioned in (i.e., a cycle exists).
  // O(E α(D)) — cheap.
  _dsuRebuild() {
    this._dsuMakeArrays();
    const p = this._dsuParent;
    const rank = this._dsuRank;
    for (let i = 0; i < p.length; i++) { p[i] = i; rank[i] = 0; }
    this._cycleClosed = false;
    const H = this.height, W = this.width;
    for (let r = 0; r <= H; r++) {
      for (let c = 0; c < W; c++) {
        if (this.H[this._hIdx(r, c)] !== 1) continue;
        const [u, v] = this._edgeEndpoints('H', this._hIdx(r, c));
        const ru = this._dsuFind(u), rv = this._dsuFind(v);
        if (ru === rv) { this._cycleClosed = true; continue; }
        if (rank[ru] < rank[rv]) p[ru] = rv;
        else if (rank[ru] > rank[rv]) p[rv] = ru;
        else { p[rv] = ru; rank[ru]++; }
      }
    }
    for (let r = 0; r < H; r++) {
      for (let c = 0; c <= W; c++) {
        if (this.V[this._vIdx(r, c)] !== 1) continue;
        const [u, v] = this._edgeEndpoints('V', this._vIdx(r, c));
        const ru = this._dsuFind(u), rv = this._dsuFind(v);
        if (ru === rv) { this._cycleClosed = true; continue; }
        if (rank[ru] < rank[rv]) p[ru] = rv;
        else if (rank[ru] > rank[rv]) p[rv] = ru;
        else { p[rv] = ru; rank[ru]++; }
      }
    }
  }

  // True iff (a) every clue is satisfied exactly, (b) no UNKNOWN edges remain,
  // (c) every dot has degree 0 or 2, and (d) all LINE edges form a single
  // connected component. Assumes _dsuRebuild() has just been called.
  _checkSingleLoopComplete() {
    const H = this.height, W = this.width;
    // (a) clue check.
    for (let r = 0; r < H; r++) {
      const row = this.task[r] || [];
      for (let c = 0; c < W; c++) {
        const clue = row[c];
        if (clue === undefined || clue < 0 || clue > 4) continue;
        const edges = this._cellEdges(r, c);
        let m = 0;
        for (const e of edges) {
          if ((e.kind === 'H' ? this.H : this.V)[e.idx] === 1) m++;
        }
        if (m !== clue) return false;
      }
    }
    // (b) no UNKNOWN edges.
    for (let i = 0; i < this.H.length; i++) if (this.H[i] === 0) return false;
    for (let i = 0; i < this.V.length; i++) if (this.V[i] === 0) return false;
    // (c) every dot is degree 0 or 2.
    for (let i = 0; i < this.lineCount.length; i++) {
      const m = this.lineCount[i];
      if (m !== 0 && m !== 2) return false;
    }
    // (d) all LINE edges share one component.
    let totalLines = 0;
    let firstRoot = -1;
    for (let r = 0; r <= H; r++) {
      for (let c = 0; c < W; c++) {
        if (this.H[this._hIdx(r, c)] !== 1) continue;
        totalLines++;
        const [u] = this._edgeEndpoints('H', this._hIdx(r, c));
        const ru = this._dsuFind(u);
        if (firstRoot === -1) firstRoot = ru;
        else if (firstRoot !== ru) return false;
      }
    }
    for (let r = 0; r < H; r++) {
      for (let c = 0; c <= W; c++) {
        if (this.V[this._vIdx(r, c)] !== 1) continue;
        totalLines++;
        const [u] = this._edgeEndpoints('V', this._vIdx(r, c));
        const ru = this._dsuFind(u);
        if (firstRoot === -1) firstRoot = ru;
        else if (firstRoot !== ru) return false;
      }
    }
    return totalLines > 0;
  }

  // Helper: returns the [cell-r, cell-c, H-r, H-c, V-r, V-c] tuple for a
  // named corner. Used by _applyCornerThree and _applyCornerOne.
  _cornerCoords(corner) {
    const H = this.height, W = this.width;
    switch (corner) {
      case 'TL': return [0,   0,   0, 0,   0, 0  ];
      case 'TR': return [0,   W-1, 0, W-1, 0, W  ];
      case 'BL': return [H-1, 0,   H, 0,   H-1, 0];
      case 'BR': return [H-1, W-1, H, W-1, H-1, W];
      default: return null;
    }
  }

  // Corner-3 pattern for one grid corner. Returns false on contradiction.
  _applyCornerThree(corner, onChange) {
    const coords = this._cornerCoords(corner);
    if (!coords) return true;
    const [cr, cc, hr, hc, vr, vc] = coords;
    const k = (this.task[cr] || [])[cc];
    if (k !== 3) return true;
    if (this.H[this._hIdx(hr, hc)] !== 1) {
      this._currentReason = [];
      if (!this._setEdge(this._hIdx(hr, hc), 'H', 1)) return false;
      onChange();
    }
    if (this.V[this._vIdx(vr, vc)] !== 1) {
      this._currentReason = [];
      if (!this._setEdge(this._vIdx(vr, vc), 'V', 1)) return false;
      onChange();
    }
    return true;
  }

  // Corner-1 pattern for one grid corner. Returns false on contradiction.
  _applyCornerOne(corner, onChange) {
    const coords = this._cornerCoords(corner);
    if (!coords) return true;
    const [cr, cc, hr, hc, vr, vc] = coords;
    const k = (this.task[cr] || [])[cc];
    if (k !== 1) return true;
    if (this.H[this._hIdx(hr, hc)] !== 2) {
      this._currentReason = [];
      if (!this._setEdge(this._hIdx(hr, hc), 'H', 2)) return false;
      onChange();
    }
    if (this.V[this._vIdx(vr, vc)] !== 2) {
      this._currentReason = [];
      if (!this._setEdge(this._vIdx(vr, vc), 'V', 2)) return false;
      onChange();
    }
    return true;
  }

  // Horizontal adjacent-3-3 pattern for cells (r,c) and (r,c+1). Returns
  // false on contradiction; no-ops if either cell doesn't have clue 3.
  _applyAdjacentThreeH(r, c, onChange) {
    if ((this.task[r] || [])[c] !== 3 || (this.task[r] || [])[c + 1] !== 3) return true;
    // Shared vertical V[r][c+1], outer verticals V[r][c] and V[r][c+2].
    for (const [vr, vc] of [[r, c], [r, c + 1], [r, c + 2]]) {
      const idx = this._vIdx(vr, vc);
      if (this.V[idx] !== 1) {
        this._currentReason = [];
        if (!this._setEdge(idx, 'V', 1)) return false;
        onChange();
      }
    }
    return true;
  }

  // Vertical adjacent-3-3 pattern for cells (r,c) and (r+1,c). Returns
  // false on contradiction; no-ops if either cell doesn't have clue 3.
  _applyAdjacentThreeV(r, c, onChange) {
    if ((this.task[r] || [])[c] !== 3 || (this.task[r + 1] || [])[c] !== 3) return true;
    // Shared horizontal H[r+1][c], outer horizontals H[r][c] and H[r+2][c].
    for (const [hr, hc] of [[r, c], [r + 1, c], [r + 2, c]]) {
      const idx = this._hIdx(hr, hc);
      if (this.H[idx] !== 1) {
        this._currentReason = [];
        if (!this._setEdge(idx, 'H', 1)) return false;
        onChange();
      }
    }
    return true;
  }

  // Diagonal-3-3 pattern for cell (r,c) and its diagonal neighbour (r+dr, c+dc).
  // (dr,dc) must be (1,1) or (1,-1) — the two down-directions; up-directions
  // are covered when the nested loop visits the other cell first.
  // Returns false on contradiction; no-ops if clue condition not met.
  _applyDiagonalThree(r, c, dr, dc, onChange) {
    const nr = r + dr, nc = c + dc;
    if ((this.task[r] || [])[c] !== 3 || (this.task[nr] || [])[nc] !== 3) return true;
    // (r,c)'s far corner is opposite (dr,dc): far-H and far-V.
    // down-right (dr=1,dc=1): far corner of (r,c) = top-left → H[r][c], V[r][c]
    // down-left  (dr=1,dc=-1): far corner of (r,c) = top-right → H[r][c], V[r][c+1]
    const hIdx1 = this._hIdx(r, c);
    const vIdx1 = dc === 1 ? this._vIdx(r, c) : this._vIdx(r, c + 1);
    // far corner of (nr,nc):
    // down-right: bottom-right of (r+1,c+1) → H[r+2][c+1], V[r+1][c+2]
    // down-left:  bottom-left of (r+1,c-1) → H[r+2][c-1], V[r+1][c-1]
    const hIdx2 = this._hIdx(nr + 1, nc);
    const vIdx2 = dc === 1 ? this._vIdx(nr, nc + 1) : this._vIdx(nr, nc);
    for (const [arr, idx] of [[this.H, hIdx1], [this.V, vIdx1], [this.H, hIdx2], [this.V, vIdx2]]) {
      if (arr[idx] !== 1) {
        const kind = (arr === this.H) ? 'H' : 'V';
        this._currentReason = [];
        if (!this._setEdge(idx, kind, 1)) return false;
        onChange();
      }
    }
    return true;
  }

  // Classic Slitherlink pattern deductions. Returns false on contradiction,
  // calls onChange() after every successful force.
  //
  // Patterns (all provably sound):
  //   a) Corner-3: corner cell with clue 3 → both outer corner edges LINE.
  //      Proof: corner dot has only 2 incident edges (both belonging to the
  //      cell). Clue 3 ⟹ exactly 3 of 4 cell edges are LINE ⟹ at least
  //      one outer corner edge is LINE ⟹ vertex rule (degree 0 or 2) forces
  //      both to LINE.
  //   b) Corner-1: corner cell with clue 1 → both outer corner edges EMPTY.
  //      Proof: if either outer corner edge were LINE, vertex rule on the
  //      corner dot forces the other LINE too → cell has ≥2 LINEs from
  //      corners alone → contradicts clue 1 → both must be EMPTY.
  //   c) Adjacent 3-3 horizontal: cells (r,c)=3 and (r,c+1)=3 → shared
  //      vertical V[r][c+1] and outer verticals V[r][c] and V[r][c+2] are
  //      LINE.  Proof: cell (r,c) needs 3 of {H[r][c], H[r+1][c], V[r][c],
  //      V[r][c+1]}. Cell (r,c+1) needs 3 of {H[r][c+1], H[r+1][c+1],
  //      V[r][c+1], V[r][c+2]}. If V[r][c+1] (shared) were EMPTY each cell
  //      must have all 3 remaining edges LINE, so both H[r][c] and H[r+1][c]
  //      are LINE and both H[r][c+1] and H[r+1][c+1] are LINE. Dot (r,c+1)
  //      would then have lineCount ≥ 3 (H[r][c] + H[r][c+1] + V[r][c+1]=E
  //      means 0 from V side but dot (r+1,c+1) has H[r+1][c] + H[r+1][c+1]
  //      LINE → degree 2 using both, forcing V[r+1][c+1] EMPTY and V[r][c+1]
  //      EMPTY). Actually the clean proof: the two cells share V[r][c+1].
  //      Assume it EMPTY. Then (r,c) uses all 3 of H[r][c], H[r+1][c],
  //      V[r][c]; and (r,c+1) uses all 3 of H[r][c+1], H[r+1][c+1],
  //      V[r][c+2]. But then dot (r,c+1) has H[r][c] + H[r][c+1] → degree
  //      ≥2 → V[r][c+1] must be LINE (vertex rule). Contradiction. So
  //      V[r][c+1] must be LINE. With V[r][c+1] LINE, cells (r,c) and
  //      (r,c+1) each need 2 more LINEs from their remaining 3 edges, and
  //      those must NOT include the shared horizontals at the outer corner
  //      dots in a way that forces the corner verticals. Cleaner end-result:
  //      standard slitherlink theory says both outer verticals are forced LINE.
  //   d) Adjacent 3-3 vertical: symmetric to (c).
  //   e) Diagonal 3-3 (all 4 orientations): cells (r,c) and (r±1,c±1) both
  //      have clue 3 → the outer-corner edges of each cell (the pair facing
  //      AWAY from the other cell's corner) are forced LINE.
  //      Proof (down-right case): cell (r,c) at corner (r,c) and cell
  //      (r+1,c+1) at corner (r+1,c+1) share no edges. Standard result:
  //      the outer-facing edges at the two cells' far corners are forced LINE
  //      because any other assignment leaves the opposing cell unable to
  //      achieve clue 3 without creating a degree-3 dot on the shared inner
  //      corner. Applies symmetrically to all 4 diagonal orientations.
  _propagateAdvanced(onChange) {
    const H = this.height, W = this.width;

    // (a) + (b) Corner patterns.
    for (const corner of ['TL', 'TR', 'BL', 'BR']) {
      if (!this._applyCornerThree(corner, onChange)) return false;
      if (!this._applyCornerOne(corner, onChange)) return false;
    }

    // (c) Horizontally-adjacent 3-3.
    for (let r = 0; r < H; r++) {
      for (let c = 0; c + 1 < W; c++) {
        if (!this._applyAdjacentThreeH(r, c, onChange)) return false;
      }
    }

    // (d) Vertically-adjacent 3-3.
    for (let r = 0; r + 1 < H; r++) {
      for (let c = 0; c < W; c++) {
        if (!this._applyAdjacentThreeV(r, c, onChange)) return false;
      }
    }

    // (e) Diagonal 3-3 — down-right and down-left (up directions are
    // covered when the inner cell visits the outer cell as its "first").
    for (let r = 0; r + 1 < H; r++) {
      for (let c = 0; c + 1 < W; c++) {
        if (!this._applyDiagonalThree(r, c, 1, 1, onChange)) return false;
      }
    }
    for (let r = 0; r + 1 < H; r++) {
      for (let c = 1; c < W; c++) {
        if (!this._applyDiagonalThree(r, c, 1, -1, onChange)) return false;
      }
    }

    return true;
  }

  // Line-crossing parity rule. A closed Slitherlink loop crosses any straight
  // scan line an even number of times.
  //
  // Geometry: dots are at integer coordinates (row, col) 0..H x 0..W.
  //   - H[r][c]: horizontal edge at y=r, spanning x from c to c+1.
  //   - V[r][c]: vertical edge at x=c, spanning y from r to r+1.
  //
  // A horizontal scan at y = R + 0.5 (between dot rows R and R+1) crosses
  // VERTICAL edges that span over y = R + 0.5, i.e., V[R][c] for c = 0..W.
  //
  // A vertical scan at x = C + 0.5 (between dot cols C and C+1) crosses
  // HORIZONTAL edges that span over x = C + 0.5, i.e., H[r][C] for r = 0..H.
  //
  // Per scan line, let m = count of LINE edges, n = count of UNKNOWN edges:
  //   - n == 0 && m is odd  → contradiction.
  //   - n == 1              → force the unknown: if m odd → LINE, if m even → EMPTY.
  //   - n >= 2              → no forced deduction.
  //
  // Returns false on contradiction; calls onChange() for each forced edge.
  _propagateParity(onChange) {
    const H = this.height, W = this.width;

    // ── Horizontal scans R = 0..H-1 (cross V[R][c] for c = 0..W) ──────────
    for (let R = 0; R < H; R++) {
      let m = 0, n = 0, unknownC = -1;
      for (let c = 0; c <= W; c++) {
        const v = this.V[this._vIdx(R, c)];
        if (v === 1) m++;
        else if (v === 0) { n++; unknownC = c; }
      }
      if (n === 0) {
        if (m & 1) return false;
      } else if (n === 1) {
        const forced = (m & 1) ? 1 : 2;
        const antecedents = [];
        for (let c = 0; c <= W; c++) {
          if (c === unknownC) continue;
          const v = this.V[this._vIdx(R, c)];
          if (v !== 0) antecedents.push(this._varIdEdge('V', this._vIdx(R, c)));
        }
        this._currentReason = antecedents;
        if (!this._setEdge(this._vIdx(R, unknownC), 'V', forced)) return false;
        onChange();
      }
    }

    // ── Vertical scans C = 0..W-1 (cross H[r][C] for r = 0..H) ─────────────
    for (let C = 0; C < W; C++) {
      let m = 0, n = 0, unknownR = -1;
      for (let r = 0; r <= H; r++) {
        const v = this.H[this._hIdx(r, C)];
        if (v === 1) m++;
        else if (v === 0) { n++; unknownR = r; }
      }
      if (n === 0) {
        if (m & 1) return false;
      } else if (n === 1) {
        const forced = (m & 1) ? 1 : 2;
        const antecedents = [];
        for (let r = 0; r <= H; r++) {
          if (r === unknownR) continue;
          const v = this.H[this._hIdx(r, C)];
          if (v !== 0) antecedents.push(this._varIdEdge('H', this._hIdx(r, C)));
        }
        this._currentReason = antecedents;
        if (!this._setEdge(this._hIdx(unknownR, C), 'H', forced)) return false;
        onChange();
      }
    }

    return true;
  }

  // INSIDE reachability deduction. BFS from a single known-INSIDE cell through
  // the {INSIDE ∪ UNKNOWN} graph. Returns false if not all known-INSIDE cells
  // are reachable (they're disconnected → contradiction). Any UNKNOWN cell not
  // reachable is forced OUTSIDE. Calls onChange() for each forced cell.
  _slApplyInsideReachability(onChange) {
    const H = this.height, W = this.width, N = H * W;
    let start = -1, placedCount = 0;
    for (let i = 0; i < N; i++) {
      if (this.colors[i] === 1) {
        placedCount++;
        if (start === -1) start = i;
      }
    }
    if (placedCount === 0) return true;  // no known-INSIDE cells: nothing to do

    const seen = this._slSeen;
    seen.fill(0);
    const queue = [start];
    seen[start] = 1;
    let reachedPlaced = 1;
    let qi = 0;
    while (qi < queue.length) {
      const cur = queue[qi++];
      const r = (cur / W) | 0, c = cur % W;
      if (r > 0)     { const nb = cur - W; if (!seen[nb] && this.colors[nb] !== 2) { seen[nb] = 1; if (this.colors[nb] === 1) reachedPlaced++; queue.push(nb); } }
      if (r + 1 < H) { const nb = cur + W; if (!seen[nb] && this.colors[nb] !== 2) { seen[nb] = 1; if (this.colors[nb] === 1) reachedPlaced++; queue.push(nb); } }
      if (c > 0)     { const nb = cur - 1; if (!seen[nb] && this.colors[nb] !== 2) { seen[nb] = 1; if (this.colors[nb] === 1) reachedPlaced++; queue.push(nb); } }
      if (c + 1 < W) { const nb = cur + 1; if (!seen[nb] && this.colors[nb] !== 2) { seen[nb] = 1; if (this.colors[nb] === 1) reachedPlaced++; queue.push(nb); } }
    }

    if (reachedPlaced !== placedCount) return false;  // known-INSIDE cells are disconnected

    // Any UNKNOWN cell not in BFS can never be INSIDE (can't reach INSIDE cells).
    const insideAntecedents = [];
    for (let i = 0; i < N; i++) {
      if (this.colors[i] === 1) insideAntecedents.push(this._varIdCell(i));
    }
    for (let i = 0; i < N; i++) {
      if (this.colors[i] === 0 && !seen[i]) {
        this._currentReason = insideAntecedents;
        if (!this._setColor(i, 2)) return false;
        onChange();
      }
    }
    return true;
  }

  // OUTSIDE reachability deduction. BFS from all non-INSIDE border cells
  // (representing connectivity to the virtual exterior of the grid). Returns
  // false if any known-OUTSIDE cell is not reachable from the grid exterior
  // through the {OUTSIDE ∪ UNKNOWN} graph (contradiction). Any UNKNOWN cell
  // not reachable from the exterior can never be OUTSIDE, so it is forced
  // INSIDE. Calls onChange() for each forced cell.
  _slApplyOutsideReachability(onChange) {
    const H = this.height, W = this.width, N = H * W;
    const seen = this._slSeen;
    seen.fill(0);
    const queue = [];

    // Seed from all border cells that are not known-INSIDE.
    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) {
        if (r !== 0 && r !== H - 1 && c !== 0 && c !== W - 1) continue;  // not border
        const idx = r * W + c;
        if (this.colors[idx] === 1) continue;  // known INSIDE: not a border root
        if (!seen[idx]) { seen[idx] = 1; queue.push(idx); }
      }
    }

    // BFS through {OUTSIDE ∪ UNKNOWN}.
    let reachedOutside = 0;
    let qi = 0;
    while (qi < queue.length) {
      const cur = queue[qi++];
      const r = (cur / W) | 0, c = cur % W;
      if (this.colors[cur] === 2) reachedOutside++;
      if (r > 0)     { const nb = cur - W; if (!seen[nb] && this.colors[nb] !== 1) { seen[nb] = 1; queue.push(nb); } }
      if (r + 1 < H) { const nb = cur + W; if (!seen[nb] && this.colors[nb] !== 1) { seen[nb] = 1; queue.push(nb); } }
      if (c > 0)     { const nb = cur - 1; if (!seen[nb] && this.colors[nb] !== 1) { seen[nb] = 1; queue.push(nb); } }
      if (c + 1 < W) { const nb = cur + 1; if (!seen[nb] && this.colors[nb] !== 1) { seen[nb] = 1; queue.push(nb); } }
    }

    // All known-OUTSIDE cells must be reachable from the exterior.
    let totalOutside = 0;
    for (let i = 0; i < N; i++) if (this.colors[i] === 2) totalOutside++;
    if (reachedOutside !== totalOutside) return false;  // some OUTSIDE cell is interior-trapped

    // Any UNKNOWN cell not reachable from the exterior can never be OUTSIDE.
    const outsideAntecedents = [];
    for (let i = 0; i < N; i++) {
      if (this.colors[i] === 2) outsideAntecedents.push(this._varIdCell(i));
    }
    for (let i = 0; i < N; i++) {
      if (this.colors[i] === 0 && !seen[i]) {
        this._currentReason = outsideAntecedents;
        if (!this._setColor(i, 1)) return false;
        onChange();
      }
    }
    return true;
  }

  // Articulation points of the {color ∪ UNKNOWN} cell graph (4-adjacency).
  // UNKNOWN cells act as "wildcard" for both colors. Returns a Uint8Array of
  // length H*W where entry i is 1 if cell i is an articulation point.
  // Standard iterative Tarjan DFS (avoids JS stack-overflow on large boards).
  _slArticulationPoints(color) {
    const H = this.height, W = this.width, N = H * W;
    const disc = this._slApDisc; disc.fill(-1);
    const low = this._slApLow;
    const isAP = this._slApIsAP; isAP.fill(0);
    let timer = 0;

    // Iterative DFS using an explicit stack of [node, parentNode, neighborIndex].
    for (let startNode = 0; startNode < N; startNode++) {
      const cv = this.colors[startNode];
      if (cv !== color && cv !== 0) continue;  // not in {color ∪ UNKNOWN}
      if (disc[startNode] !== -1) continue;    // already visited

      // Stack entry: [node, parent, childrenCount, neighborIndex]
      const dfsStack = [[startNode, -1, 0, 0]];
      disc[startNode] = low[startNode] = timer++;

      while (dfsStack.length) {
        const frame = dfsStack[dfsStack.length - 1];
        const [u, parent] = frame;
        const r = (u / W) | 0, cu = u % W;
        // Enumerate neighbors lazily via frame[3] (neighborIndex).
        let pushed = false;
        while (frame[3] < 4) {
          const d = frame[3]++;
          let v = -1;
          if (d === 0) { if (r > 0) v = u - W; }
          else if (d === 1) { if (r + 1 < H) v = u + W; }
          else if (d === 2) { if (cu > 0) v = u - 1; }
          else { if (cu + 1 < W) v = u + 1; }
          if (v < 0) continue;
          const vc = this.colors[v];
          if (vc !== color && vc !== 0) continue;  // not in subgraph
          if (disc[v] === -1) {
            // Tree edge: push child onto stack.
            frame[2]++;  // children count of u
            disc[v] = low[v] = timer++;
            dfsStack.push([v, u, 0, 0]);
            pushed = true;
            break;
          } else if (v !== parent) {
            // Back edge: update low.
            if (disc[v] < low[u]) low[u] = disc[v];
          }
        }
        if (!pushed) {
          // Done with this node: propagate low to parent, check AP condition.
          dfsStack.pop();
          if (dfsStack.length > 0) {
            const parentFrame = dfsStack[dfsStack.length - 1];
            const p = parentFrame[0];
            if (low[u] < low[p]) low[p] = low[u];
            if (parent !== -1 && low[u] >= disc[p]) isAP[p] = 1;
          } else {
            // Root of DFS tree.
            if (frame[2] > 1) isAP[u] = 1;
          }
        }
      }
    }
    return isAP;
  }

  // Cut deduction for one color. For each UNKNOWN articulation point of the
  // {color ∪ UNKNOWN} graph whose removal would disconnect the known-color
  // cells, force it to `color`. Calls onChange() for each forced cell.
  _slApplyCut(color, onChange) {
    const N = this.height * this.width;
    const isAP = this._slArticulationPoints(color);
    for (let ap = 0; ap < N; ap++) {
      if (!isAP[ap]) continue;
      if (this.colors[ap] !== 0) continue;  // not UNKNOWN
      // Check if removing this cell disconnects the known-color cells.
      if (!this._slColorConnected(color, ap)) {
        const antecedents = [];
        for (let i = 0; i < N; i++) {
          if (this.colors[i] === color) antecedents.push(this._varIdCell(i));
        }
        this._currentReason = antecedents;
        if (!this._setColor(ap, color)) return false;
        onChange();
      }
    }
    return true;
  }

  // Helper: BFS to check whether all known-color cells (excluding `blockIdx`)
  // remain connected through the {color ∪ UNKNOWN} graph when `blockIdx` is
  // removed. Returns true if connected (or ≤1 known-color cell remains).
  _slColorConnected(color, blockIdx) {
    const H = this.height, W = this.width, N = H * W;
    let start = -1, placedCount = 0;
    for (let i = 0; i < N; i++) {
      if (i === blockIdx) continue;
      if (this.colors[i] === color) {
        placedCount++;
        if (start === -1) start = i;
      }
    }
    if (placedCount <= 1) return true;
    const seen = this._slSeen2;
    seen.fill(0);
    const stack = [start];
    seen[start] = 1;
    let reached = 1;
    while (stack.length) {
      const cur = stack.pop();
      const r = (cur / W) | 0, c = cur % W;
      const neighbors = [];
      if (r > 0) neighbors.push(cur - W);
      if (r + 1 < H) neighbors.push(cur + W);
      if (c > 0) neighbors.push(cur - 1);
      if (c + 1 < W) neighbors.push(cur + 1);
      for (const nb of neighbors) {
        if (seen[nb] || nb === blockIdx) continue;
        const vc = this.colors[nb];
        if (vc === color || vc === 0) {
          seen[nb] = 1;
          if (vc === color) reached++;
          stack.push(nb);
        }
      }
    }
    return reached === placedCount;
  }

  // Connectivity propagation (cell color graph). Runs:
  //   (a) INSIDE reachability: UNKNOWN cells that can't reach any known-INSIDE
  //       cell through the {INSIDE ∪ UNKNOWN} graph are forced OUTSIDE. Also
  //       detects contradiction if known-INSIDE cells are disconnected.
  //   (b) OUTSIDE reachability: UNKNOWN cells that can't reach the virtual grid
  //       exterior through the {OUTSIDE ∪ UNKNOWN} graph are forced INSIDE.
  //   (c) INSIDE articulation cut: UNKNOWN articulation points of the
  //       {INSIDE ∪ UNKNOWN} graph whose removal disconnects known-INSIDE cells
  //       are forced INSIDE.
  //
  // Note: OUTSIDE articulation cut is intentionally omitted. The OUTSIDE region
  // in a valid Slitherlink solution is connected via the plane exterior — two
  // known-OUTSIDE cells may be disconnected within the cell graph (e.g., one
  // above and one below the loop) yet still be in the same topological region.
  //
  // Returns false on contradiction; calls onChange() for each forced color.
  _propagateConnectivity(onChange) {
    if (!this._slApplyInsideReachability(onChange)) return false;
    if (!this._slApplyOutsideReachability(onChange)) return false;
    if (!this._slApplyCut(1, onChange)) return false;
    return true;
  }

  // 1-step lookahead. For each "constrained" UNKNOWN edge, probe both values
  // (LINE and EMPTY). If one probe propagates to a contradiction, force the
  // other. If both propagate to contradictions, return false.
  //
  // Called from propagate() only when _depth === 0 and !_inLookahead so the
  // inner propagate() calls skip re-entering lookahead (controlled by the
  // _inLookahead flag).
  //
  // Candidate edges (performance heuristic — without filtering a 30×30 board
  // starts with ~1521 unknowns → >3000 probes at ~3ms each ≈ 9s per pass):
  //   - At least one endpoint dot has lineCount[u] + unknownCount[u] ≤ 3
  //     (tight dot — close to being forced).
  //   - OR the edge borders a clued cell (r,c) where (current LINE count m)
  //     + (current UNKNOWN count n) ≤ 3 (tight cell — most edges already set).
  // This cuts the candidate set 5-10× in practice.
  _applyLookahead(onChange) {
    const H = this.height, W = this.width;

    // Collect candidate edges (kind, idx, arr) filtering by tightness.
    const candidates = [];

    // Helper: check if an edge (kind, idx) is a candidate.
    const isTight = (kind, idx) => {
      // 1. Endpoint dot tightness.
      const [u, v] = this._edgeEndpoints(kind, idx);
      if (this.lineCount[u] + this.unknownCount[u] <= 3) return true;
      if (this.lineCount[v] + this.unknownCount[v] <= 3) return true;
      // 2. Adjacent cell tightness.
      if (kind === 'H') {
        const c = idx % W;
        const r = (idx / W) | 0;
        // Cell above: (r-1, c).
        if (r > 0) {
          const row = this.task[r - 1] || [];
          const cl = row[c];
          if (cl >= 0 && cl <= 4) {
            const edges = this._cellEdges(r - 1, c);
            let m = 0, n = 0;
            for (const e of edges) { const v2 = (e.kind === 'H' ? this.H : this.V)[e.idx]; if (v2 === 1) m++; else if (v2 === 0) n++; }
            if (m + n <= 3) return true;
          }
        }
        // Cell below: (r, c).
        if (r < H) {
          const row = this.task[r] || [];
          const cl = row[c];
          if (cl >= 0 && cl <= 4) {
            const edges = this._cellEdges(r, c);
            let m = 0, n = 0;
            for (const e of edges) { const v2 = (e.kind === 'H' ? this.H : this.V)[e.idx]; if (v2 === 1) m++; else if (v2 === 0) n++; }
            if (m + n <= 3) return true;
          }
        }
      } else {
        // V[r][c]: r = idx / (W+1), c = idx % (W+1).
        const stride = W + 1;
        const r = (idx / stride) | 0;
        const c = idx - r * stride;
        // Cell to the left: (r, c-1).
        if (c > 0) {
          const row = this.task[r] || [];
          const cl = row[c - 1];
          if (cl >= 0 && cl <= 4) {
            const edges = this._cellEdges(r, c - 1);
            let m = 0, n = 0;
            for (const e of edges) { const v2 = (e.kind === 'H' ? this.H : this.V)[e.idx]; if (v2 === 1) m++; else if (v2 === 0) n++; }
            if (m + n <= 3) return true;
          }
        }
        // Cell to the right: (r, c).
        if (c < W) {
          const row = this.task[r] || [];
          const cl = row[c];
          if (cl >= 0 && cl <= 4) {
            const edges = this._cellEdges(r, c);
            let m = 0, n = 0;
            for (const e of edges) { const v2 = (e.kind === 'H' ? this.H : this.V)[e.idx]; if (v2 === 1) m++; else if (v2 === 0) n++; }
            if (m + n <= 3) return true;
          }
        }
      }
      return false;
    };

    for (let r = 0; r <= H; r++) {
      for (let c = 0; c < W; c++) {
        const idx = this._hIdx(r, c);
        if (this.H[idx] !== 0) continue;
        if (isTight('H', idx)) candidates.push({ kind: 'H', idx });
      }
    }
    for (let r = 0; r < H; r++) {
      for (let c = 0; c <= W; c++) {
        const idx = this._vIdx(r, c);
        if (this.V[idx] !== 0) continue;
        if (isTight('V', idx)) candidates.push({ kind: 'V', idx });
      }
    }

    this._inLookahead = true;
    for (const { kind, idx } of candidates) {
      if (this._budgetExceeded()) { this._inLookahead = false; return false; }
      const arr = kind === 'H' ? this.H : this.V;
      if (arr[idx] !== 0) continue;  // already assigned during this lookahead pass

      let lineFails = false, emptyFails = false;
      let lineContradictionReason = [], emptyContradictionReason = [];

      for (const probeVal of [1, 2]) {
        const mark = this.trail.length;
        if (!this._setEdge(idx, kind, probeVal)) {
          // Can't even set it: means it was already set to the other value.
          if (probeVal === 1) lineFails = true; else emptyFails = true;
          this._rollback(mark);
          continue;
        }
        const ok = this.propagate();
        const probeReasonVars = [];
        for (let ti = mark; ti < this.trail.length; ti++) {
          const r = this._reasons[ti];
          if (Array.isArray(r)) for (const v of r) probeReasonVars.push(v);
        }
        this._rollback(mark);
        if (!ok) {
          if (probeVal === 1) { lineFails = true; lineContradictionReason = probeReasonVars; }
          else { emptyFails = true; emptyContradictionReason = probeReasonVars; }
        }
      }

      if (lineFails && emptyFails) {
        this._inLookahead = false;
        return false;
      }
      if (lineFails) {
        this._currentReason = [...new Set([...lineContradictionReason, ...emptyContradictionReason])];
        if (!this._setEdge(idx, kind, 2)) { this._inLookahead = false; return false; }
        onChange();
      } else if (emptyFails) {
        this._currentReason = [...new Set([...lineContradictionReason, ...emptyContradictionReason])];
        if (!this._setEdge(idx, kind, 1)) { this._inLookahead = false; return false; }
        onChange();
      }
    }
    this._inLookahead = false;
    return true;
  }

  // Iterate clue + vertex rules to a fixpoint. After each pass that
  // added a LINE edge, rebuild the DSU; if a cycle closed, check for
  // subloop: a real subloop means some LINE-endpoint dot has degree 1
  // (the line can't extend because the cycle is already closed). If every
  // LINE dot has degree 2, the cycle is consistent — the remaining unknowns
  // are in degree-0 regions and will be forced EMPTY or explored later.
  propagate() {
    // Outer loop: alternate between the local-rule fixpoint and the 1-step
    // lookahead (top-level only). Each lookahead pass may force new edges,
    // which re-enters the local-rule fixpoint, and so on.
    let anyLineAddedSinceRebuild = false;

    for (;;) {
      // ── Local-rule fixpoint ──────────────────────────────────────────────
      let changed = true;
      while (changed) {
        if (this._budgetExceeded()) return false;
        changed = false;
        // We don't know LINE vs EMPTY from the rule callback, so just rebuild
        // after each fixpoint pass that ran any propagator. (Cheap: O(E α).)
        const onLocalChange = () => { changed = true; anyLineAddedSinceRebuild = true; };
        if (!this._propagateClues(onLocalChange)) return false;
        if (!this._propagateVertices(onLocalChange)) return false;
        // _propagateAdvanced forces edges based purely on clue structure; those
        // forces are already applied before lookahead starts. Skipping it in
        // inner probe propagations avoids redundant O(H×W) work — the forced
        // edges are either already set (no-op _setEdge) or not reachable from
        // the probe edge alone. This halves inner-probe propagation time.
        if (!this._inLookahead && !this._propagateAdvanced(onLocalChange)) return false;
        if (!this._propagateColors(onLocalChange)) return false;
        if (!this._propagateParity(onLocalChange)) return false;
        if (!this._propagateLearnedClauses(onLocalChange)) return false;
        if (!this._inLookahead && !this._propagateConnectivity(onLocalChange)) return false;
      }

      // ── Subloop check ────────────────────────────────────────────────────
      if (anyLineAddedSinceRebuild) {
        this._dsuRebuild();
        anyLineAddedSinceRebuild = false;
        if (this._cycleClosed) {
          if (this._allEdgesAssigned()) {
            if (!this._checkSingleLoopComplete()) return false;
          } else {
            for (let i = 0; i < this.lineCount.length; i++) {
              if (this.lineCount[i] === 1) return false;
            }
          }
        }
      }

      // ── 1-step lookahead (top-level only) ───────────────────────────────
      if (this._depth !== 0 || this._inLookahead) break;
      let lookaheadForced = false;
      const onLookaheadChange = () => { lookaheadForced = true; anyLineAddedSinceRebuild = true; };
      if (!this._applyLookahead(onLookaheadChange)) return false;
      if (!lookaheadForced) break;  // fixpoint reached
      // Lookahead forced edges → re-run local rules.
    }

    return true;
  }

  // Most-constrained UNKNOWN edge for branching. Returns { kind, idx } or null.
  _pickEdge() {
    let best = null, bestScore = -Infinity;
    const H = this.height, W = this.width;
    for (let r = 0; r <= H; r++) {
      for (let c = 0; c < W; c++) {
        const idx = this._hIdx(r, c);
        if (this.H[idx] !== 0) continue;
        const [u, v] = this._edgeEndpoints('H', idx);
        const score = Math.max(this.lineCount[u], this.lineCount[v]) * 10
                    - Math.min(this.unknownCount[u], this.unknownCount[v]);
        if (score > bestScore) { bestScore = score; best = { kind: 'H', idx }; }
      }
    }
    for (let r = 0; r < H; r++) {
      for (let c = 0; c <= W; c++) {
        const idx = this._vIdx(r, c);
        if (this.V[idx] !== 0) continue;
        const [u, v] = this._edgeEndpoints('V', idx);
        const score = Math.max(this.lineCount[u], this.lineCount[v]) * 10
                    - Math.min(this.unknownCount[u], this.unknownCount[v]);
        if (score > bestScore) { bestScore = score; best = { kind: 'V', idx }; }
      }
    }
    return best;
  }

  _allEdgesAssigned() {
    for (let i = 0; i < this.H.length; i++) if (this.H[i] === 0) return false;
    for (let i = 0; i < this.V.length; i++) if (this.V[i] === 0) return false;
    return true;
  }

  _emit() {
    const H = this.height, W = this.width;
    const horizontal = [];
    for (let r = 0; r <= H; r++) {
      const row = new Array(W);
      for (let c = 0; c < W; c++) {
        const v = this.H[this._hIdx(r, c)];
        row[c] = v === 1 ? 1 : v === 2 ? 2 : 0;
      }
      horizontal.push(row);
    }
    const vertical = [];
    for (let r = 0; r < H; r++) {
      const row = new Array(W + 1);
      for (let c = 0; c <= W; c++) {
        const v = this.V[this._vIdx(r, c)];
        row[c] = v === 1 ? 1 : v === 2 ? 2 : 0;
      }
      vertical.push(row);
    }
    return { horizontal, vertical };
  }

  _backtrack() {
    if (this._budgetExceeded()) return false;
    if (this._allEdgesAssigned()) {
      this._dsuRebuild();
      return this._checkSingleLoopComplete();
    }
    const pick = this._pickEdge();
    if (!pick) return false;
    for (const val of [1, 2]) {
      if (this._budgetExceeded()) return false;
      const mark = this.trail.length;
      if (!this._setEdge(pick.idx, pick.kind, val)) continue;
      this._depth++;
      const propOk = this.propagate();
      this._depth--;
      if (propOk) {
        if (this._allEdgesAssigned()) {
          this._dsuRebuild();
          if (this._checkSingleLoopComplete()) return true;
        } else if (this._backtrack()) {
          return true;
        }
      }
      this._rollback(mark);
      if (this._timedOut) return false;
    }
    return false;
  }

  /**
   * @returns {{
   *   solved: boolean,
   *   horizontal: number[][] | null,
   *   vertical: number[][] | null,
   *   error?: string,
   *   partial?: boolean,
   * }}
   */
  solve() {
    const key = this._cacheKey();
    const cached = SlitherlinkSolver._solutionCache.get(key);
    if (cached) {
      return {
        solved: true,
        horizontal: cached.horizontal.map(row => row.slice()),
        vertical: cached.vertical.map(row => row.slice()),
      };
    }

    // Partial cache hit: a prior solve attempt for this exact task timed
    // out and stored what propagation could deduce. Return it instead of
    // re-running the full propagate (saves ~2-6 s per Hint/Loop click on
    // hard boards where solve doesn't fit in the budget).
    const partialCached = SlitherlinkSolver._partialCache.get(key);
    if (partialCached) {
      return {
        solved: false,
        horizontal: partialCached.horizontal.map(row => row.slice()),
        vertical: partialCached.vertical.map(row => row.slice()),
        error: 'timed out',
        partial: true,
      };
    }

    this._startedAt = Date.now();
    this._timedOut = false;

    if (!this.propagate()) {
      // Distinguish timeout from contradiction. A timeout means propagation
      // didn't finish but the state in this.H/this.V is the partial fixpoint
      // up to that point — usable as a partial for callers (e.g. getHint's
      // fallback path). Contradiction means the state is inconsistent and
      // we shouldn't expose it.
      if (this._timedOut) {
        const partial = this._emit();
        SlitherlinkSolver._storeInPartialCache(key, partial);
        return {
          solved: false,
          horizontal: partial.horizontal,
          vertical: partial.vertical,
          error: 'timed out',
          partial: true,
        };
      }
      return {
        solved: false, horizontal: null, vertical: null,
        error: 'contradiction on initial propagation',
      };
    }
    if (this._allEdgesAssigned()) {
      this._dsuRebuild();
      if (this._checkSingleLoopComplete()) {
        const out = this._emit();
        this._storeInCache(key, out);
        return { solved: true, horizontal: out.horizontal, vertical: out.vertical };
      }
      return {
        solved: false, horizontal: null, vertical: null,
        error: 'fully-assigned grid is not a valid single loop',
      };
    }
    if (this._backtrack()) {
      const out = this._emit();
      this._storeInCache(key, out);
      return { solved: true, horizontal: out.horizontal, vertical: out.vertical };
    }
    // Backtrack failed or timed out. Trail-rollback restored the state to
    // the post-propagation snapshot (everything propagate() + lookahead
    // could deduce). Return that as a partial so callers can show the
    // user the deducible portion instead of nothing — meaningful on hard
    // boards (e.g. the 50×40 monthly: ~38% of edges determined in ~3s
    // before backtracking gives up). Cache so repeated Hint/Loop clicks
    // don't re-burn the budget.
    const partial = this._emit();
    if (this._timedOut) SlitherlinkSolver._storeInPartialCache(key, partial);
    return {
      solved: false,
      horizontal: partial.horizontal,
      vertical: partial.vertical,
      error: this._timedOut ? 'timed out' : 'no solution found',
      partial: true,
    };
  }

  static _storeInPartialCache(key, out) {
    const m = SlitherlinkSolver._partialCache;
    if (m.size >= SlitherlinkSolver._maxPartialCache) {
      m.delete(m.keys().next().value);
    }
    m.set(key, {
      horizontal: out.horizontal.map(row => row.slice()),
      vertical: out.vertical.map(row => row.slice()),
    });
  }

  // Run the local-rule fixpoint (clue + vertex + advanced patterns, NO
  // lookahead) and collect the first `minLines` LINE edges that are forced.
  // Uses propagate() with _depth=1 to skip the lookahead tier, so we get the
  // full propagation chain without speculative branching — this is the same
  // "next logical steps a solver would explain" but batched for Loop speed.
  // A single rollback at the end leaves the probe state unchanged.
  // Returns an array of {orientation, r, c} entries, or null if no rule fires.
  _findNextHintDeduction(minLines = 1) {
    const W = this.width;
    const overallMark = this.trail.length;

    // Run local-rule propagation (no lookahead) from the current state.
    // _depth=1 skips _applyLookahead in propagate(). _startedAt is already
    // set by the getHint caller.
    this._depth = 1;
    const propOk = this.propagate();
    this._depth = 0;

    if (!propOk) {
      // Contradiction: the current board state is already invalid.
      this._rollback(overallMark);
      return null;
    }

    // Collect LINE edges from the trail, up to minLines.
    // Trail entries with kind=2 are color writes — skip them; we only want edges.
    const allLines = [];
    for (let i = overallMark; i < this.trail.length; i++) {
      const e = this.trail[i];
      const kind = (e >> 24) & 3;
      if (kind === 2) continue;  // color write — not an edge
      const idx = e & 0xFFFFFF;
      const arr = kind === 0 ? this.H : this.V;
      if (arr[idx] === 1) {
        if (kind === 0) {
          const r = (idx / W) | 0;
          allLines.push({ orientation: 'h', r, c: idx - r * W });
        } else {
          const stride = W + 1;
          const r = (idx / stride) | 0;
          allLines.push({ orientation: 'v', r, c: idx - r * stride });
        }
        if (allLines.length >= minLines) break;
      }
    }

    this._rollback(overallMark);
    return allLines.length > 0 ? allLines : null;
  }

  /**
   * Next-move hint. Returns:
   *   { type: 'slitherlink', edges: [{orientation:'h'|'v', r, c}, ...], count }
   * or null if no hint can be found.
   *
   * Accumulates LINE edges from successive rule applications (vertex → clue →
   * advanced patterns) until at least minLines = max(3, ceil(H×W/30)) edges
   * are collected. Successive applications are not rolled back between them so
   * later rules can chain off earlier deductions. This batch sizing keeps Loop
   * under ~10s on 30×30 boards (target ≈30 iterations × 300ms inter-step).
   * No lookahead is used in this path.
   *
   * Fallback: if no local rule fires, runs a full solve (with lookahead) and
   * reveals one missing LINE edge.
   *
   * @param {number[][]} curH  (H+1)×W, 0/1
   * @param {number[][]} curV  H×(W+1), 0/1
   */
  getHint(curH, curV) {
    const probe = new SlitherlinkSolver({
      width: this.width, height: this.height, task: this.task,
      initialState: { horizontal: curH, vertical: curV },
      maxMs: this.maxMs,
    });
    probe._startedAt = Date.now();

    // Next-move hint: accumulate LINE edges across successive rule applications
    // until minLines is reached, so Loop finishes a 30×30 in ~10s (target ~30
    // Loop iterations × 300ms inter-step sleep).
    const minLines = Math.max(3, Math.ceil(this.height * this.width / 30));
    const next = probe._findNextHintDeduction(minLines);

    if (next && next.length > 0) {
      // Local rules produced something — return as-is, even if fewer than
      // minLines. Supplementing from a full solve would burn the entire
      // solve budget per click on puzzles our solver can't crack (e.g. the
      // 50×40 monthly times out at 30 s every step). minLines is a soft
      // target: hit it when local rules can, no more.
      return { type: 'slitherlink', edges: next, count: next.length };
    }

    // Local rules deduced nothing. Try a tight-budget solve and pull up to
    // minLines missing LINE edges from the result. We accept partial solves
    // (solve() returns `{ solved:false, partial:true, horizontal, vertical }`
    // on timeout): the partial is the deducible portion from
    // propagate+lookahead, exactly the LINE set we want to draw hints from.
    // Result is cached in _partialCache so this 5 s cost is paid at most
    // once per puzzle — subsequent Hint/Loop clicks hit the cache instantly.
    const fallbackBudget = Math.min(this.maxMs > 0 ? this.maxMs : 5000, 5000);
    const fallbackSolver = new SlitherlinkSolver({
      width: this.width, height: this.height, task: this.task,
      maxMs: fallbackBudget,
    });
    const full = fallbackSolver.solve();
    if (!full || !full.horizontal || !full.vertical) return null;
    const H = this.height, W = this.width;
    const out = [];
    for (let r = 0; r <= H && out.length < minLines; r++) {
      for (let c = 0; c < W && out.length < minLines; c++) {
        if (full.horizontal[r][c] === 1 && (curH[r]?.[c] !== 1)) {
          out.push({ orientation: 'h', r, c });
        }
      }
    }
    for (let r = 0; r < H && out.length < minLines; r++) {
      for (let c = 0; c <= W && out.length < minLines; c++) {
        if (full.vertical[r][c] === 1 && (curV[r]?.[c] !== 1)) {
          out.push({ orientation: 'v', r, c });
        }
      }
    }
    if (out.length === 0) return null;
    return { type: 'slitherlink', edges: out, count: out.length };
  }

  static _solutionCache = new Map();
  static _maxSolutionCache = 50;
  // Separate partial-result cache so Hint/Loop fallback solves don't
  // re-burn the full budget each click on puzzles our solver can't crack
  // (e.g. the 50×40 monthly: ~615 LINE edges determined in 2 s, then 14
  // more Loop clicks would each re-spend that 2 s without this cache).
  static _partialCache = new Map();
  static _maxPartialCache = 20;
  static clearSolutionCache() {
    SlitherlinkSolver._solutionCache.clear();
    SlitherlinkSolver._partialCache.clear();
  }

  _cacheKey() {
    // FNV-1a over (width, height, flattened task).
    let h = 0x811c9dc5;
    const mix = (n) => { h ^= n; h = Math.imul(h, 0x01000193) >>> 0; };
    mix(0x4C); // 'L' nameplate so slitherlink keys don't collide
    mix(this.width);
    mix(this.height);
    for (let r = 0; r < this.height; r++) {
      const row = this.task[r] || [];
      for (let c = 0; c < this.width; c++) mix((row[c] | 0) + 2);
    }
    return String(h >>> 0);
  }

  _storeInCache(key, out) {
    const m = SlitherlinkSolver._solutionCache;
    if (m.size >= SlitherlinkSolver._maxSolutionCache) {
      m.delete(m.keys().next().value);
    }
    m.set(key, {
      horizontal: out.horizontal.map(row => row.slice()),
      vertical: out.vertical.map(row => row.slice()),
    });
  }
}

// Bounding box of every distinct owner value on a board (skipping `empty`).
// Returns a Map: ownerValue -> { r1, c1, r2, c2 }.
function _ownerBoxes(board, rows, cols, empty) {
  const m = new Map();
  for (let r = 0; r < rows; r++) {
    const row = board[r] || [];
    for (let c = 0; c < cols; c++) {
      const v = row[c];
      if (v === empty || v === undefined) continue;
      const b = m.get(v);
      if (!b) {
        m.set(v, { r1: r, c1: c, r2: r, c2: c });
      } else {
        if (r < b.r1) b.r1 = r;
        if (r > b.r2) b.r2 = r;
        if (c < b.c1) b.c1 = c;
        if (c > b.c2) b.c2 = c;
      }
    }
  }
  return m;
}

// Shikaku diff: owner ids differ between the page board and the solver
// solution, so compare rectangle GEOMETRY — a placed cell is a mistake when
// its owner's bounding box does not match the solution rectangle covering it.
function _shikakuDiff(grid, solution) {
  const out = [];
  const rows = Math.min(grid.length, solution.length);
  if (rows === 0) return out;
  const cols = Math.min((grid[0] || []).length, (solution[0] || []).length);
  const gBox = _ownerBoxes(grid, rows, cols, -1);
  const sBox = _ownerBoxes(solution, rows, cols, -1);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const gv = grid[r][c];
      if (gv === -1 || gv === undefined) continue; // unassigned — not a mistake
      const gb = gBox.get(gv);
      const sb = sBox.get(solution[r][c]);
      if (!gb || !sb ||
          gb.r1 !== sb.r1 || gb.c1 !== sb.c1 ||
          gb.r2 !== sb.r2 || gb.c2 !== sb.c2) {
        out.push({ row: r, col: c });
      }
    }
  }
  return out;
}

// Galaxies diff: region ids are numbered differently by the solver (star
// order) and the page (flood-fill order), so map both to star indices and
// compare. The page flood-fills the WHOLE grid into regions — there is no
// "unassigned" cell — so a region the player has not yet split still holds
// multiple stars. Only flag cells in a region the player has committed to
// exactly ONE star; a region with 0 or 2+ stars is incomplete, not wrong
// (this is why a blank board rings nothing). Stars are in doubled
// coordinates — star (R,C) anchors to real cell (R>>1, C>>1).
function _galaxiesDiff(grid, solution, stars) {
  const out = [];
  if (!Array.isArray(stars)) return out;
  const rows = Math.min(grid.length, solution.length);
  if (rows === 0) return out;
  const cols = Math.min((grid[0] || []).length, (solution[0] || []).length);

  const solStar = new Map();      // solution region id -> star index
  const userStar = new Map();     // player region id -> a star index in it
  const userStarCount = new Map(); // player region id -> how many stars it holds
  for (let i = 0; i < stars.length; i++) {
    const ar = stars[i].row >> 1, ac = stars[i].col >> 1;
    if (ar < 0 || ar >= rows || ac < 0 || ac >= cols) continue;
    const sRid = solution[ar] && solution[ar][ac];
    if (sRid > 0) solStar.set(sRid, i);
    const gRid = grid[ar] && grid[ar][ac];
    if (gRid > 0) {
      userStar.set(gRid, i);
      userStarCount.set(gRid, (userStarCount.get(gRid) || 0) + 1);
    }
  }

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const gv = grid[r][c];
      if (!(gv > 0)) continue;
      // Skip cells whose region is not yet committed to exactly one star.
      if (userStarCount.get(gv) !== 1) continue;
      if (userStar.get(gv) !== solStar.get(solution[r][c])) {
        out.push({ row: r, col: c });
      }
    }
  }
  return out;
}

// Slitherlink diff: edge-based, not cell-based. A mistake is a committed
// LINE edge (board value === 1) where the solution disagrees. UNKNOWN/empty
// edges on the board are never flagged.
function _slitherlinkDiff(board, solution) {
  const out = [];
  if (!board || !solution) return out;
  const bh = board.horizontal || [];
  const sh = solution.horizontal || [];
  const rowsH = Math.min(bh.length, sh.length);
  for (let r = 0; r < rowsH; r++) {
    const br = bh[r] || [], sr = sh[r] || [];
    const cols = Math.min(br.length, sr.length);
    for (let c = 0; c < cols; c++) {
      if (br[c] === 0) continue;             // UNKNOWN never flagged
      if (br[c] !== sr[c]) out.push({ orientation: 'h', r, c });
    }
  }
  const bv = board.vertical || [];
  const sv = solution.vertical || [];
  const rowsV = Math.min(bv.length, sv.length);
  for (let r = 0; r < rowsV; r++) {
    const br = bv[r] || [], sr = sv[r] || [];
    const cols = Math.min(br.length, sr.length);
    for (let c = 0; c < cols; c++) {
      if (br[c] === 0) continue;
      if (br[c] !== sr[c]) out.push({ orientation: 'v', r, c });
    }
  }
  return out;
}

/**
 * Compare a player's board to the puzzle's solution; return the cells the
 * player has PLACED incorrectly (empty cells are never flagged). Pure — no
 * DOM. Used by the widget preview to highlight mistakes.
 *
 * @param {string} type   'nonogram'|'aquarium'|'binairo'|'yinyang'|'galaxies'|'shikaku'|'slitherlink'
 * @param {number[][]|{horizontal:number[][], vertical:number[][]}} grid      the player's current board
 * @param {number[][]|{horizontal:number[][], vertical:number[][]}} solution  the solved board
 * @param {{row:number,col:number}[]} [stars]  galaxies stars (doubled coords); galaxies only
 * @returns {{row:number, col:number}[]|{orientation:string, r:number, c:number}[]}
 */
function computePuzzleDiff(type, grid, solution, stars) {
  const out = [];
  if (type === 'slitherlink') return _slitherlinkDiff(grid, solution);
  if (!Array.isArray(grid) || !Array.isArray(solution)) return out;
  if (type === 'shikaku') return _shikakuDiff(grid, solution);
  if (type === 'galaxies') return _galaxiesDiff(grid, solution, stars);
  // Nonogram, Aquarium, Binairo, Yin-Yang: a cell is a mistake when the
  // player has placed something there (its value is not 0 = "not yet
  // placed") and that value differs from the solution.
  const rows = Math.min(grid.length, solution.length);
  for (let r = 0; r < rows; r++) {
    const gRow = grid[r] || [], sRow = solution[r] || [];
    const cols = Math.min(gRow.length, sRow.length);
    for (let c = 0; c < cols; c++) {
      const g = gRow[c];
      if (g !== 0 && g !== undefined && g !== sRow[c]) {
        out.push({ row: r, col: c });
      }
    }
  }
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { NonogramSolver, AquariumSolver, GalaxiesSolver, BinairoSolver, ShikakuSolver, YinYangSolver, SlitherlinkSolver, computePuzzleDiff };
}
