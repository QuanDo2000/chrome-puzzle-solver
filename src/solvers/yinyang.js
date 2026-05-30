'use strict';

const { hashFNV1a, lruSet } = require('./shared.js');

// YinYangSolver — pure logic for Yin-Yang.
//
// Internal grid encoding: `0=empty, 1=black, 2=white` (cellStatus polarity,
// same as Binairo). See `src/widget/puzzles/yinyang.js` for the page-side
// encoding and translation contract.
//
// === Propagation rules ===
//
// `propagate()` iterates four local rules to fixpoint:
// - `_apply2x2` — no 2×2 monochrome / diagonal checkerboard.
// - `_applyReachability` — BFS the `{colour ∪ empty}` graph; empty cells
//   unreachable from a colour's placed cells forced to the other.
// - `_applyCut` — articulation points whose removal severs a colour's
//   placed cells forced to that colour; iterative Tarjan.
// - `_applyBorderArc` — perimeter cycle has ≤2 colour transitions;
//   ≥4 is contradiction, cell whose wrong colour would create a 3rd arc
//   forced.
//
// After local rules stall, at top-level only (`_depth === 0`, with
// `_inLookahead` re-entry guard) runs 1-step lookahead (`_applyLookahead`).
// Then most-constrained backtracking. On a complete grid a successful
// `propagate()` IS the validity proof.
//
// === Hint strategy ===
//
// `getHint` runs local rules only first (`_localHint`, fast); falls back to
// `_lookaheadStepHint` (single lookahead deduction + the local cascade it
// triggers — not the whole solvable remainder) so Hint never dead-ends while
// the puzzle is still solvable. Static `_solutionCache` keyed on FNV-1a of
// `(rows, cols, task)`, 50-entry LRU. Worker `maxMs=30s` (35×35 weekly solves
// by deduction in ~5 s).

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
    return String(hashFNV1a((mix) => {
      mix(this.rows);
      mix(this.cols);
      for (let r = 0; r < this.rows; r++) {
        const row = this.task[r] || [];
        for (let c = 0; c < this.cols; c++) mix((row[c] | 0) + 2); // -1..1 -> 1..3
      }
    }, false));
  }

  _storeInCache(key, grid) {
    const m = YinYangSolver._solutionCache;
    lruSet(m, YinYangSolver._maxSolutionCache, key, grid.map(row => row.slice()));
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { YinYangSolver };
}
