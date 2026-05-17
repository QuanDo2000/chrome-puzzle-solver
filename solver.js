class NonogramSolver {
  constructor(rowClues, colClues) {
    this.rowClues = rowClues.map(r => r.filter(n => n > 0));
    this.colClues = colClues.map(c => c.filter(n => n > 0));
    this.rows = rowClues.length;
    this.cols = colClues.length;
    this.grid = Array.from({ length: this.rows }, () => Array(this.cols).fill(0));
    // Typed-array mirror of this.grid for fast access and trail-based undo.
    // Values: 0 = unknown, 1 = filled, -1 = empty (matches this.grid).
    this.gridBuf = new Int8Array(this.rows * this.cols);
    // Trail entries: (cellIndex << 2) | (oldValue + 1) — old ∈ {-1,0,1}.
    this.trail = [];
    this.maxIterations = 1000;
    this.bestPartial = null;
    this.bestPartialFilled = 0;
    this.timeoutPartial = null;
    this.frontier = [];
    this.maxFrontier = this.rows * this.cols >= 900 ? 80 : 0;
    this.maxMs = this.rows * this.cols >= 900 ? 3000 : 0;
    this.startedAt = 0;
    this.timedOut = false;
  }

  _idx(r, c) { return r * this.cols + c; }

  // Direct write, no trail. Use only outside backtracking (initial state).
  _set(r, c, v) {
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
      this.gridBuf[i] = old;
      this.grid[(i / cols) | 0][i % cols] = old;
    }
  }

  solve(initialGrid) {
    this.trail.length = 0;
    if (initialGrid) {
      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) {
          if (initialGrid[r] && initialGrid[r][c] !== undefined) {
            this._set(r, c, initialGrid[r][c]);
          }
        }
      }
    }
    this.startedAt = Date.now();
    this.timedOut = false;

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

  solveLine(clues, line) {
    const L = line.length;
    const N = clues.length;
    if (N === 0) return Array(L).fill(-1);

    const f = Array.from({ length: L + 1 }, () => Array(N + 1).fill(false));
    f[0][0] = true;

    for (let i = 0; i <= L; i++) {
      for (let k = 0; k <= N; k++) {
        if (!f[i][k]) continue;
        if (i === L) continue;

        if (line[i] !== 1) {
          f[i + 1][k] = true;
        }

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
                  f[i + block + 1][k + 1] = true;
                }
              } else {
                f[i + block][k + 1] = true;
              }
            }
          }
        }
      }
    }

    if (!f[L][N]) return null;

    const result = Array(L).fill(0);
    for (let p = 0; p < L; p++) {
      if (line[p] !== 0) { result[p] = line[p]; continue; }

      const lineEmpty = line.slice();
      lineEmpty[p] = -1;
      const canBeEmpty = this.solveLineValid(clues, lineEmpty);

      const lineFilled = line.slice();
      lineFilled[p] = 1;
      const canBeFilled = this.solveLineValid(clues, lineFilled);

      if (canBeFilled && !canBeEmpty) result[p] = 1;
      else if (!canBeFilled && canBeEmpty) result[p] = -1;
    }

    return result;
  }

  solveLineValid(clues, line) {
    const L = line.length;
    const N = clues.length;
    if (N === 0) return true;

    const f = Array.from({ length: L + 1 }, () => Array(N + 1).fill(false));
    f[0][0] = true;

    for (let i = 0; i <= L; i++) {
      for (let k = 0; k <= N; k++) {
        if (!f[i][k]) continue;
        if (i === L) continue;

        if (line[i] !== 1) {
          f[i + 1][k] = true;
        }

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
                  f[i + block + 1][k + 1] = true;
                }
              } else {
                f[i + block][k + 1] = true;
              }
            }
          }
        }
      }
    }

    return f[L][N];
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

  getRow(r) {
    return [...this.grid[r]];
  }

  getCol(c) {
    return this.grid.map(row => row[c]);
  }

  backtrack(depth = 0) {
    if (this.maxMs && Date.now() - this.startedAt > this.maxMs) {
      this.timedOut = true;
      return { solved: false, grid: null, error: 'time limit exceeded' };
    }
    const maxDepth = this.maxDepth || Math.max(500, this.rows * this.cols);
    if (depth > maxDepth) return { solved: false, grid: null, error: 'Backtrack limit reached' };

    const rowKnown = this.grid.map(r => r.reduce((a, v) => a + (v !== 0 ? 1 : 0), 0));
    const colKnown = Array(this.cols).fill(0);
    for (let c = 0; c < this.cols; c++) {
      for (let r = 0; r < this.rows; r++) {
        if (this.grid[r][c] !== 0) colKnown[c]++;
      }
    }

    let bestR = -1, bestC = -1;
    let bestScore = -1;

    for (let r = 0; r < this.rows; r++) {
      const row = this.grid[r];
      const rk = rowKnown[r];
      for (let c = 0; c < this.cols; c++) {
        if (row[c] === 0) {
          const score = rk + colKnown[c];
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

class GalaxiesSolver {
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
      for (const cell of this._seedCells(this.stars[i])) {
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

  solve(initialGrid, options = {}) {
    if (!this.rows || !this.cols || !this.stars.length) {
      return { solved: false, grid: null, error: 'No Galaxies task data found' };
    }
    const cacheKey = this._puzzleKey();
    const cached = GalaxiesSolver._solutionCache.get(cacheKey);
    if (cached) {
      return { solved: true, grid: this._cloneSolvedGrid(cached) };
    }
    if (this.rows * this.cols < 400) {
      const exact = this._solveByRegionExactCover();
      if (exact?.solved) {
        this._storeSolution(cacheKey, exact.grid);
        return exact;
      }
    }
    this.startedAt = Date.now();
    this.forbiddenPartials = this._normalizeForbiddenPartials(options.forbiddenPartials || []);
    this.frontier = [];

    const frontierGrids = options.frontierGrids || [];
    for (let i = frontierGrids.length - 1; i >= 0; i--) {
      const fgrid = this._newSeededGrid();
      if (!fgrid) continue;
      this.grid = fgrid;
      this.trail = [];
      if (!this._applyInitialGrid(frontierGrids[i])) continue;
      this._rememberPartial();
      const solvedFrontier = this._search(null);
      if (solvedFrontier) {
        const out = this._toOutputGrid(this.grid);
        this._storeSolution(cacheKey, out);
        return { solved: true, grid: out };
      }
      if (this.timedOut) break;
    }
    if (this.timedOut) {
      const partialGrid = this.timeoutPartial
        ? this._toOutputGrid(this.timeoutPartial)
        : (this.bestPartial ? this._toOutputGrid(this.bestPartial) : null);
      return {
        solved: false,
        grid: null,
        partialGrid,
        partialFilled: this.bestPartialFilled,
        frontierGrids: this._frontierOutput(),
        error: 'time limit exceeded'
      };
    }

    const seedGrid = this._newSeededGrid();
    if (!seedGrid) return { solved: false, grid: null, error: 'Invalid Galaxies star layout' };
    this.grid = seedGrid;
    this.trail = [];
    this.timedOut = false;
    this.startedAt = Date.now();
    this.frontier = [];
    this.forbiddenPartials = this._normalizeForbiddenPartials(options.forbiddenPartials || []);
    for (const f of frontierGrids) this._pushFrontierFromOutput(f);
    const resumed = !!initialGrid;
    if (initialGrid && !this._applyInitialGrid(initialGrid)) {
      return { solved: false, grid: null, error: 'invalid partial state' };
    }
    this._rememberPartial();
    const solved = this._search(null);
    if (!solved) {
      if (resumed && !this.timedOut && this.nodes <= 2) {
        return { solved: false, grid: null, failedPartialGrid: initialGrid, frontierGrids: this._frontierOutput(), error: 'partial state exhausted' };
      }
      const partialGrid = this.timeoutPartial
        ? this._toOutputGrid(this.timeoutPartial)
        : (this.bestPartial ? this._toOutputGrid(this.bestPartial) : null);
      return {
        solved: false,
        grid: null,
        partialGrid,
        partialFilled: this.bestPartialFilled,
        frontierGrids: this._frontierOutput(),
        error: this.timedOut ? 'time limit exceeded' : 'search limit exceeded'
      };
    }
    const out = this._toOutputGrid(this.grid);
    this._storeSolution(cacheKey, out);
    return { solved: true, grid: out };
  }

  _newSeededGrid() {
    const grid = Array.from({ length: this.rows }, () => Array(this.cols).fill(-1));
    const savedGrid = this.grid;
    this.grid = grid;
    for (let i = 0; i < this.stars.length; i++) {
      for (const cell of this._seedCells(this.stars[i])) {
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
        shape.star = i;
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
    for (const cell of this._seedCells(this.stars[starIndex])) {
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
      if (this._shapeConnected(shape)) shapes.push({ cells: Array.from(shape) });
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
        const m = this._mirror(nr, nc, starIndex);
        if (!this._inside(m.row, m.col)) continue;
        const b = m.row * this.cols + m.col;
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
    out.galaxies = this._toLines(grid);
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

  _seedCells(star) {
    const rows = star.row % 2 === 0 ? [star.row / 2] : [(star.row - 1) / 2, (star.row + 1) / 2];
    const cols = star.col % 2 === 0 ? [star.col / 2] : [(star.col - 1) / 2, (star.col + 1) / 2];
    const out = [];
    for (const row of rows) {
      for (const col of cols) {
        if (this._inside(row, col)) out.push({ row, col });
      }
    }
    return out;
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
    const m = this._mirror(row, col, starIndex);
    if (!this._canUseCell(row, col, starIndex) || !this._canUseCell(m.row, m.col, starIndex)) return false;
    const a = this.grid[row][col], b = this.grid[m.row][m.col];
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
    const m = this._mirror(row, col, starIndex);
    this._assign(row, col, starIndex);
    this._assign(m.row, m.col, starIndex);
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
    // Save alternative branches to the frontier (so they can resume later if
    // this branch fails). Each "save" is: trail mark, assign, snapshot, rollback.
    for (let i = bestCandidates.length - 1; i > 0; i--) {
      const mark = this.trail.length;
      const altChanged = new Set([bestCandidates[i]]);
      if (this._assignPair(best.row, best.col, bestCandidates[i], altChanged)) {
        this._pushFrontier();
      }
      this._rollback(mark);
    }
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

  _pushFrontier() {
    if (!this.maxFrontier || this.frontier.length >= this.maxFrontier) return;
    this.frontier.push(this.grid.map(row => row.slice()));
  }

  _pushFrontierFromOutput(outputGrid) {
    if (!this.maxFrontier || this.frontier.length >= this.maxFrontier || !outputGrid) return;
    this.frontier.push(outputGrid.map(row => row.map(v => v - 1)));
  }

  _frontierOutput() {
    return this.frontier.map(grid => this._toOutputGrid(grid));
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

  _propagate(changedStars) {
    let didChange = true;
    while (didChange) {
      didChange = false;
      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) {
          if (this.grid[r][c] !== -1) continue;
          const candidates = this._candidates(r, c);
          if (candidates.length === 0) return false;
          if (candidates.length === 1) {
            if (!this._assignPair(r, c, candidates[0], changedStars)) return false;
            didChange = true;
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

  _toLines(grid) {
    const horizontal = Array.from({ length: this.rows + 1 }, () => Array(this.cols).fill(0));
    const vertical = Array.from({ length: this.rows }, () => Array(this.cols + 1).fill(0));
    for (let r = 1; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) horizontal[r][c] = grid[r - 1][c] !== grid[r][c] ? 1 : 0;
    }
    for (let r = 0; r < this.rows; r++) {
      for (let c = 1; c < this.cols; c++) vertical[r][c] = grid[r][c - 1] !== grid[r][c] ? 1 : 0;
    }
    return { horizontal, vertical };
  }
}

class AquariumSolver {
  constructor(rowClues, colClues, regionMap, rows, cols) {
    this.rows = rows;
    this.cols = cols;
    this.rowClues = rowClues;
    this.colClues = colClues;
    this._cellsCount = rows * cols;

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
    this._deadCacheHits = 0;
    this._dpCache = new Map();
    this._dpCacheMax = 500000;
    this._dpCacheHits = 0;
    this._nogoods = [];
    this._nogoodSet = new Set();
    this._nogoodIndex = new Map();
    this._nogoodMax = 50000;
    this._nogoodMaxTerms = 18;
    this._nogoodHits = 0;
    this._bestPartial = null;
    this._bestPartialFilled = 0;
  }

  solve(initialGrid) {
    this._searchNodes = 0;
    this._deadCache.clear();
    this._deadCacheHits = 0;
    this._dpCache.clear();
    this._dpCacheHits = 0;
    this._nogoods = [];
    this._nogoodSet.clear();
    this._nogoodIndex.clear();
    this._nogoodHits = 0;
    this._bestPartial = null;
    this._bestPartialFilled = 0;
    this._kc.fill(0);
    if (initialGrid)
      for (let r = 0; r < this.rows; r++)
        for (let c = 0; c < this.cols; c++) {
          const v = initialGrid[r][c];
          if (v !== 0) this._kc[r * this.cols + c] = v;
        }

    for (const aq of this.aquariums) this._initRange(aq);
    this._propagate();
    this._rememberPartial();

    if (this._allAssigned()) { this._buildGrid(); return { solved: true, grid: this.grid }; }

    this._dpPreprocess();
    this._dpPairwise();
    if (!this._propagate()) {
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

    if (this._allAssigned()) { this._buildGrid(); return { solved: true, grid: this.grid }; }

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
        for (let r = 0; r < rowC; r++) { const v = ct.rc[r] || 0; baseRL[r] += v; baseRH[r] += v; }
        for (let c = 0; c < colC; c++) { const v = ct.cc[c] || 0; baseCL[c] += v; baseCH[c] += v; }
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
        for (let r = 0; r < rowC; r++) { rowLo[r] += clo.rc[r] || 0; rowHi[r] += chi.rc[r] || 0; }
        for (let c = 0; c < colC; c++) { colLo[c] += clo.cc[c] || 0; colHi[c] += chi.cc[c] || 0; }
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
        for (let r = 0; r < rowC; r++) { rowLo[r] += clo.rc[r] || 0; rowHi[r] += chi.rc[r] || 0; }
        for (let c = 0; c < colC; c++) { colLo[c] += clo.cc[c] || 0; colHi[c] += chi.cc[c] || 0; }
      }

      for (let r = 0; r < rowC; r++) if (rowLo[r] > rc[r] || rowHi[r] < rc[r]) return false;
      for (let c = 0; c < colC; c++) if (colLo[c] > cc[c] || colHi[c] < cc[c]) return false;

      for (const aq of vars) {
        if (this.waterLevel[aq.id] >= 0) continue;
        const { mn, mx } = this.d[aq.id];
        for (let r = 0; r < rowC; r++) {
          const otherLo = rowLo[r] - (aq.contribs[mn].rc[r] || 0);
          const otherHi = rowHi[r] - (aq.contribs[mx].rc[r] || 0);
          const needed = rc[r] - otherHi, avail = rc[r] - otherLo;
          if (needed > 0 || avail <= 0) {
            let nm = mx, nx = mn;
            for (let l = mn; l <= mx; l++) {
              const c = aq.contribs[l].rc[r] || 0;
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
          const otherLo = colLo[c] - (aq.contribs[nmn].cc[c] || 0);
          const otherHi = colHi[c] - (aq.contribs[nmx].cc[c] || 0);
          const needed = cc[c] - otherHi, avail = cc[c] - otherLo;
          if (needed > 0 || avail <= 0) {
            let nm = nmx, nx = nmn;
            for (let l = nmn; l <= nmx; l++) {
              const ccv = aq.contribs[l].cc[c] || 0;
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
          for (let r = 0; r < rowC; r++) { const v = ct.rc[r] || 0; baseRL[r] += v; baseRH[r] += v; rowLo[r] += v; rowHi[r] += v; }
          for (let c = 0; c < colC; c++) { const v = ct.cc[c] || 0; baseCL[c] += v; baseCH[c] += v; colLo[c] += v; colHi[c] += v; }
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
          for (let r = 0; r < rowC; r++) { const v = ct.rc[r] || 0; baseR[r] += v; }
          for (let c = 0; c < colC; c++) { const v = ct.cc[c] || 0; baseC[c] += v; }
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
          const nr = narrow(rLookup[r], (aq, l) => aq.contribs[l].rc[r] || 0, adj, 'r' + r);
          if (!nr.ok) return;
          if (nr.narrowed) changed = true;
        }
      }
      for (let c = 0; c < colC; c++) {
        const adj = cc[c] - baseC[c];
        if (adj < 0) return;
        if (cLookup[c].length > 1 && adj > 0) {
          const nr = narrow(cLookup[c], (aq, l) => aq.contribs[l].cc[c] || 0, adj, 'c' + c);
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
        for (let r = 0; r < H; r++) { const v = ct.rc[r] || 0; baseR[r] += v; }
        for (let c = 0; c < W; c++) { const v = ct.cc[c] || 0; baseC[c] += v; }
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

    const narrowLevels = (pairClue1, pairClue2, vars, getPair, ranges, cachePrefix) => {
      // vars: array of { id, levels: [lvl...] } for each variable
      // getPair(lvl): returns [c1, c2]
      // ranges: [mn, mx] to update
      const n = vars.length;
      if (n === 0) return true;
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
    };

    // Process adjacent row pairs
    let anyChange = false;
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
        return [(ct.rc[r] || 0), (ct.rc[r + 1] || 0)];
      };

      const res = narrowLevels(adj1, adj2, vars, getPair, ranges, 'rr' + r);
      if (!res.ok) return false;
      if (res.changed) anyChange = true;
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
        return [(ct.cc[c] || 0), (ct.cc[c + 1] || 0)];
      };

      const res = narrowLevels(adj1, adj2, vars, getPair, ranges, 'cc' + c);
      if (!res.ok) return false;
      if (res.changed) anyChange = true;
    }

    return anyChange || true;
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
        if (ok) {
          this._nogoodHits++;
          return true;
        }
      }
    }
    return false;
  }

  _cacheGet(key) {
    const value = this._dpCache.get(key);
    if (value !== undefined) this._dpCacheHits++;
    return value;
  }

  _cacheSet(key, value) {
    if (this._dpCache.has(key)) return;
    if (this._dpCache.size >= this._dpCacheMax) {
      this._dpCache.delete(this._dpCache.keys().next().value);
    }
    this._dpCache.set(key, value);
  }

  _solveMinConflicts() {
    const H = this.rows, W = this.cols;
    const rc = this.rowClues, cc = this.colClues;
    const vars = this.aquariums.filter(a => this.waterLevel[a.id] < 0);
    if (vars.length === 0) return null;

    for (let restart = 0; restart < 20; restart++) {
      const wl = {};
      for (const aq of this.aquariums) wl[aq.id] = this.waterLevel[aq.id];

      const rowS = Array(H).fill(0), colS = Array(W).fill(0);
      for (const aq of vars) {
        const { mn, mx } = this.d[aq.id];
        wl[aq.id] = mn + Math.floor(Math.random() * (mx - mn + 1));
        const ct = aq.contribs[wl[aq.id]];
        for (let r = 0; r < H; r++) rowS[r] += ct.rc[r] || 0;
        for (let c = 0; c < W; c++) colS[c] += ct.cc[c] || 0;
      }

      const violation = () => {
        let v = 0;
        for (let r = 0; r < H; r++) v += Math.abs(rowS[r] - rc[r]);
        for (let c = 0; c < W; c++) v += Math.abs(colS[c] - cc[c]);
        return v;
      };

      let curV = violation();
      if (curV === 0) {
        for (const aq of this.aquariums) {
          this.waterLevel[aq.id] = wl[aq.id];
          const l = wl[aq.id];
          if (l >= 0) this.d[aq.id].mn = this.d[aq.id].mx = l;
        }
        return { solved: true };
      }

      for (let step = 0; step < 20000; step++) {
        const aq = vars[Math.floor(Math.random() * vars.length)];
        const { mn, mx } = this.d[aq.id];
        const oldLvl = wl[aq.id];
        const oldCt = aq.contribs[oldLvl];
        let bestLvl = oldLvl;
        let bestV = curV;

        for (let lvl = mn; lvl <= mx; lvl++) {
          if (lvl === oldLvl) continue;
          const ct = aq.contribs[lvl];
          // delta update
          for (let r = 0; r < H; r++) {
            const delta = (ct.rc[r] || 0) - (oldCt.rc[r] || 0);
            if (delta) rowS[r] += delta;
          }
          for (let c = 0; c < W; c++) {
            const delta = (ct.cc[c] || 0) - (oldCt.cc[c] || 0);
            if (delta) colS[c] += delta;
          }
          const v = violation();
          if (v < bestV) { bestV = v; bestLvl = lvl; }
          // restore
          for (let r = 0; r < H; r++) {
            const delta = (ct.rc[r] || 0) - (oldCt.rc[r] || 0);
            if (delta) rowS[r] -= delta;
          }
          for (let c = 0; c < W; c++) {
            const delta = (ct.cc[c] || 0) - (oldCt.cc[c] || 0);
            if (delta) colS[c] -= delta;
          }
          if (v === 0) {
            wl[aq.id] = lvl;
            for (const a of this.aquariums) {
              this.waterLevel[a.id] = wl[a.id];
              const l = wl[a.id];
              if (l >= 0) this.d[a.id].mn = this.d[a.id].mx = l;
            }
            return { solved: true };
          }
        }

        if (bestLvl !== oldLvl) {
          const ct = aq.contribs[bestLvl];
          for (let r = 0; r < H; r++) rowS[r] += (ct.rc[r] || 0) - (oldCt.rc[r] || 0);
          for (let c = 0; c < W; c++) colS[c] += (ct.cc[c] || 0) - (oldCt.cc[c] || 0);
          wl[aq.id] = bestLvl;
          curV = bestV;
        }
      }
    }
    return null;
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
    if (this._deadCache.has(cacheKey)) {
      this._deadCacheHits++;
      return { solved: false };
    }

    const { mn, mx } = this.d[best.id];
forLoop:
    for (let lvl of this._levelOrder(mn, mx)) {
      const snap = this._snap();
      this.waterLevel[best.id] = lvl;
      this.d[best.id].mn = this.d[best.id].mx = lvl;
      const branchTokens = assignedTokens.concat(best.id + '=' + lvl);
      if (!this._propagate()) { this._learnNogood(branchTokens); this._restore(snap); continue; }
      this._rememberPartial();
      this._dpPreprocess();
      this._dpPairwise();
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { NonogramSolver, AquariumSolver, GalaxiesSolver };
}
