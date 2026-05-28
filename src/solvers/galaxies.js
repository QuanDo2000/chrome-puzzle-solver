'use strict';

// GalaxiesSolver — pure logic for Galaxies (Tentai Show).
//
// === Shared geometry statics ===
//
// `GalaxiesSolver.seedCellsForStar(star, rows, cols)` and
// `GalaxiesSolver.regionsToLines(grid, rows, cols)` are static, used by this
// solver, `src/widget/galaxies-hint.js`, and `handler.js` (DOM lines). Don't
// reintroduce per-file copies — they drifted before.

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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GalaxiesSolver };
}
