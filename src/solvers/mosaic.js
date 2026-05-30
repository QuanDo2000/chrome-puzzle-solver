'use strict';

const { hashFNV1a, emitGrid } = require('./shared.js');

class MosaicSolver {
  constructor(data) {
    const { rows, cols, task, initialState, maxMs } = data;
    this.rows = rows;
    this.cols = cols;
    this.task = new Int32Array(rows * cols);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        this.task[r * cols + c] = task[r][c];
      }
    }
    const cluesList = [], cluesValuesList = [];
    for (let i = 0; i < rows * cols; i++) {
      if (this.task[i] !== -1) {
        cluesList.push(i);
        cluesValuesList.push(this.task[i]);
      }
    }
    this.clues = new Int32Array(cluesList);
    this.clueValues = new Int32Array(cluesValuesList);
    this.cellStatus = new Uint8Array(rows * cols);
    if (initialState) {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          this.cellStatus[r * cols + c] = initialState[r][c];
        }
      }
    }
    this.trail = [];
    this._depth = 0;
    this._inLookahead = false;
    this.maxMs = maxMs || 0;
    this._buildNeighborhoods();
    this._startedAt = 0;
  }

  _set(idx, value) {
    const old = this.cellStatus[idx];
    if (old === value) return true;
    if (old !== 0) return false;
    this.trail.push(idx | (old << 24));
    this.cellStatus[idx] = value;
    return true;
  }

  _rollback(mark) {
    while (this.trail.length > mark) {
      const e = this.trail.pop();
      const i = e & 0xffffff;
      const old = (e >>> 24) & 0xff;
      this.cellStatus[i] = old;
    }
  }

  _timeUp() {
    if (this.maxMs <= 0) return false;
    return (Date.now() - this._startedAt) > this.maxMs;
  }

  _buildNeighborhoods() {
    this.clueNeighborhood = new Array(this.clues.length);
    // cellToClues[cellIdx] = Int32Array of clue indices whose neighborhood
    // contains cellIdx. Used by the dirty-queue propagator so each cell
    // change only re-checks the ~4-9 overlapping clues instead of all K.
    const cellToCluesList = Array.from({ length: this.rows * this.cols }, () => []);
    for (let i = 0; i < this.clues.length; i++) {
      const idx = this.clues[i];
      const r0 = (idx / this.cols) | 0;
      const c0 = idx - r0 * this.cols;
      const cells = [];
      for (let dr = -1; dr <= 1; dr++) {
        const r = r0 + dr;
        if (r < 0 || r >= this.rows) continue;
        for (let dc = -1; dc <= 1; dc++) {
          const c = c0 + dc;
          if (c < 0 || c >= this.cols) continue;
          const cidx = r * this.cols + c;
          cells.push(cidx);
          cellToCluesList[cidx].push(i);
        }
      }
      this.clueNeighborhood[i] = new Int32Array(cells);
    }
    this.cellToClues = cellToCluesList.map(arr => new Int32Array(arr));
    this._buildCluePairs();
  }

  // For each pair of clues whose centers are within Chebyshev distance 2,
  // precompute (L, R, D) where L = N_A \ N_B, R = N_B \ N_A,
  // D = K_A - K_B. The constraint blacks(L) - blacks(R) = D often forces
  // entire cell sets even when single-clue propagation alone is stuck.
  // This is the canonical strong rule for Mosaic / Fill-a-Pix solvers.
  _buildCluePairs() {
    this.cluePairs = [];
    const K = this.clues.length;
    for (let i = 0; i < K; i++) {
      const aIdx = this.clues[i];
      const aR = (aIdx / this.cols) | 0;
      const aC = aIdx - aR * this.cols;
      for (let j = i + 1; j < K; j++) {
        const bIdx = this.clues[j];
        const bR = (bIdx / this.cols) | 0;
        const bC = bIdx - bR * this.cols;
        const dr = bR - aR, dc = bC - aC;
        const adr = dr < 0 ? -dr : dr;
        const adc = dc < 0 ? -dc : dc;
        if (adr > 2 || adc > 2) continue;
        // Compute L (in N_A, not in N_B) and R (in N_B, not in N_A).
        const setB = new Set(this.clueNeighborhood[j]);
        const L = [], R = [];
        const cellsA = this.clueNeighborhood[i];
        for (let k = 0; k < cellsA.length; k++) {
          if (!setB.has(cellsA[k])) L.push(cellsA[k]);
        }
        const setA = new Set(cellsA);
        const cellsB = this.clueNeighborhood[j];
        for (let k = 0; k < cellsB.length; k++) {
          if (!setA.has(cellsB[k])) R.push(cellsB[k]);
        }
        if (L.length === 0 || R.length === 0) continue;
        this.cluePairs.push({
          L: new Int32Array(L),
          R: new Int32Array(R),
          D: this.clueValues[i] - this.clueValues[j],
        });
      }
    }
  }

  // Two-clue subtraction propagation. For each precomputed pair (L, R, D):
  // blacks(L) - blacks(R) = D. Combined with [0, |L|] and [0, |R|] bounds
  // (and any known blacks/whites already placed), this often collapses to
  // a unique value that forces every unknown in L and/or R.
  _applyCluePairs() {
    const pairs = this.cluePairs;
    for (let p = 0; p < pairs.length; p++) {
      const pair = pairs[p];
      const L = pair.L, R = pair.R, D = pair.D;
      let bL = 0, uL = 0;
      for (let i = 0; i < L.length; i++) {
        const v = this.cellStatus[L[i]];
        if (v === 1) bL++;
        else if (v === 0) uL++;
      }
      let bR = 0, uR = 0;
      for (let i = 0; i < R.length; i++) {
        const v = this.cellStatus[R[i]];
        if (v === 1) bR++;
        else if (v === 0) uR++;
      }
      // blacks(L) = blacks(R) + D. Intersect [bL, bL+uL] - D with [bR, bR+uR].
      const lower = Math.max(bR, bL - D);
      const upper = Math.min(bR + uR, bL + uL - D);
      if (lower > upper) return false;
      // Strong deduction: interval on blacks(R) collapses to a single value.
      if (lower === upper) {
        const needR = lower - bR; // unknowns in R that must be black
        const needL = (lower + D) - bL; // unknowns in L that must be black
        if (uR > 0) {
          if (needR === 0) {
            for (let i = 0; i < R.length; i++) {
              if (this.cellStatus[R[i]] === 0) {
                if (!this._set(R[i], 2)) return false;
              }
            }
          } else if (needR === uR) {
            for (let i = 0; i < R.length; i++) {
              if (this.cellStatus[R[i]] === 0) {
                if (!this._set(R[i], 1)) return false;
              }
            }
          }
        }
        if (uL > 0) {
          if (needL === 0) {
            for (let i = 0; i < L.length; i++) {
              if (this.cellStatus[L[i]] === 0) {
                if (!this._set(L[i], 2)) return false;
              }
            }
          } else if (needL === uL) {
            for (let i = 0; i < L.length; i++) {
              if (this.cellStatus[L[i]] === 0) {
                if (!this._set(L[i], 1)) return false;
              }
            }
          }
        }
      }
    }
    return true;
  }

  // Apply a single clue's deductions. Returns false on contradiction.
  // Cell forces via _set push to the trail; the caller (queue-based
  // _applyClues) reads those trail entries to re-queue overlapping clues.
  _applyClueAt(i) {
    const cells = this.clueNeighborhood[i];
    const K = this.clueValues[i];
    let nB = 0, nU = 0;
    for (let j = 0; j < cells.length; j++) {
      const v = this.cellStatus[cells[j]];
      if (v === 1) nB++;
      else if (v === 0) nU++;
    }
    if (nB > K) return false;
    if (nB + nU < K) return false;
    if (nB === K && nU > 0) {
      for (let j = 0; j < cells.length; j++) {
        if (this.cellStatus[cells[j]] === 0) {
          if (!this._set(cells[j], 2)) return false;
        }
      }
    } else if (nB + nU === K && nU > 0) {
      for (let j = 0; j < cells.length; j++) {
        if (this.cellStatus[cells[j]] === 0) {
          if (!this._set(cells[j], 1)) return false;
        }
      }
    }
    return true;
  }

  // Dirty-clue queue propagation. Initial pass enqueues all clues; each
  // cell change identified by trail growth re-queues the ~4-9 clues
  // overlapping that cell. The queue can never exceed K entries because
  // inQueue[] guards re-adds — each clue is in the queue at most once at
  // any given time. ~100× faster than the naive all-clues-each-pass
  // approach on 30×30 dailies (inner propagate inside lookahead/backtrack
  // was the bottleneck).
  _applyClues() {
    const K = this.clues.length;
    if (!this._inQueue || this._inQueue.length !== K) {
      this._inQueue = new Uint8Array(K);
      // Tail advances on each enqueue, including re-enqueues after a
      // clue is processed and its cells change again. Worst-case bound:
      // initial seeding (K) + every cell can change at most twice, each
      // change re-queues up to 9 overlapping clues. So
      // K + 2 × rows × cols × 9 is a safe ceiling.
      this._queue = new Int32Array(K + this.rows * this.cols * 18);
    }
    const inQueue = this._inQueue;
    const queue = this._queue;
    let head = 0, tail = 0;
    for (let i = 0; i < K; i++) {
      queue[tail++] = i;
      inQueue[i] = 1;
    }
    while (head < tail) {
      const i = queue[head++];
      inQueue[i] = 0;
      const before = this.trail.length;
      if (!this._applyClueAt(i)) return false;
      for (let t = before; t < this.trail.length; t++) {
        const cellIdx = this.trail[t] & 0xffffff;
        const overlapping = this.cellToClues[cellIdx];
        for (let k = 0; k < overlapping.length; k++) {
          const ci = overlapping[k];
          if (!inQueue[ci]) {
            queue[tail++] = ci;
            inQueue[ci] = 1;
          }
        }
      }
    }
    return true;
  }

  _propagate() {
    let changed = true;
    while (changed) {
      if (this._timeUp()) return true;
      changed = false;
      const mark = this.trail.length;
      if (!this._applyClues()) return false;
      if (!this._applyCluePairs()) return false;
      if (this.trail.length > mark) changed = true;
    }
    if (this._depth === 0 && !this._inLookahead) {
      if (!this._applyLookahead()) return false;
    }
    return true;
  }

  _applyLookahead() {
    const total = this.rows * this.cols;
    let changed = true;
    while (changed) {
      if (this._timeUp()) return true;
      changed = false;
      for (let i = 0; i < total; i++) {
        if (this.cellStatus[i] !== 0) continue;
        const survivors = [];
        for (const v of [1, 2]) {
          const mark = this.trail.length;
          this._inLookahead = true;
          const okSet = this._set(i, v);
          const ok = okSet && this._propagate();
          this._rollback(mark);
          this._inLookahead = false;
          if (ok) survivors.push(v);
          if (survivors.length > 1) break;
        }
        if (survivors.length === 0) return false;
        if (survivors.length === 1) {
          if (!this._set(i, survivors[0])) return false;
          if (!this._propagate()) return false;
          changed = true;
        }
      }
    }
    return true;
  }

  _isComplete() {
    for (let i = 0; i < this.rows * this.cols; i++) {
      if (this.cellStatus[i] === 0) return false;
    }
    return true;
  }

  _emit() {
    return emitGrid(this.cellStatus, this.rows, this.cols);
  }

  _pickBestUnknown() {
    // Most-constrained variable for Mosaic: pick the unknown cell whose
    // participating clues have the smallest remaining slack. Slack for a
    // clue with K target, nB blacks, nU unknowns = min(K - nB, nU - (K - nB)) —
    // how many free choices remain. A cell touching a tight clue forces
    // either color on the next branch step, pruning the tree.
    let bestIdx = -1, bestScore = -Infinity;
    const total = this.rows * this.cols;
    for (let i = 0; i < total; i++) {
      if (this.cellStatus[i] !== 0) continue;
      const overlapping = this.cellToClues[i];
      let minSlack = Infinity;
      for (let k = 0; k < overlapping.length; k++) {
        const ci = overlapping[k];
        const cells = this.clueNeighborhood[ci];
        const K = this.clueValues[ci];
        let nB = 0, nU = 0;
        for (let j = 0; j < cells.length; j++) {
          const v = this.cellStatus[cells[j]];
          if (v === 1) nB++;
          else if (v === 0) nU++;
        }
        const need = K - nB;
        const slack = need < nU - need ? need : nU - need;
        if (slack < minSlack) minSlack = slack;
      }
      // Fallback to adjacency count when the cell has no overlapping clues
      // (rare — every Mosaic cell is typically in at least one neighborhood
      // since clues are dense, but be safe).
      let score;
      if (minSlack === Infinity) {
        const r = (i / this.cols) | 0, c = i - r * this.cols;
        let adj = 0;
        if (r > 0 && this.cellStatus[i - this.cols] !== 0) adj++;
        if (r < this.rows - 1 && this.cellStatus[i + this.cols] !== 0) adj++;
        if (c > 0 && this.cellStatus[i - 1] !== 0) adj++;
        if (c < this.cols - 1 && this.cellStatus[i + 1] !== 0) adj++;
        score = adj;
      } else {
        // Smaller slack = tighter clue = better pick. Invert sign so the
        // higher-score variable wins.
        score = -minSlack * 100 + overlapping.length;
      }
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }
    return bestIdx;
  }

  _backtrack() {
    if (this._timeUp()) return false;
    const idx = this._pickBestUnknown();
    if (idx < 0) return this._isComplete();
    this._depth++;
    for (const v of [1, 2]) {
      const mark = this.trail.length;
      if (this._set(idx, v) && this._propagate() && this._backtrack()) {
        this._depth--;
        return true;
      }
      this._rollback(mark);
      if (this._timeUp()) break;
    }
    this._depth--;
    return false;
  }

  solve() {
    const key = this._cacheKey();
    const cached = MosaicSolver._solutionCache.get(key)
                || MosaicSolver._partialCache.get(key);
    if (cached) return this._cloneResult(cached);
    this._startedAt = Date.now();
    let result;
    if (!this._propagate()) {
      this._rollback(0);
      result = { solved: false, grid: null };
    } else if (this._isComplete()) {
      result = { solved: true, grid: this._emit() };
    } else if (this._backtrack()) {
      result = { solved: true, grid: this._emit() };
    } else {
      const partial = this._emit();
      result = this._timeUp()
        ? { solved: false, grid: partial, error: 'timed out', partial: true }
        : { solved: false, grid: null };
    }
    if (result.solved || result.partial) this._storeInCache(key, result);
    return result;
  }

  _cacheKey() {
    return hashFNV1a((mix) => {
      mix(this.rows); mix(this.cols);
      for (let i = 0; i < this.rows * this.cols; i++) mix(this.task[i] + 1);
    });
  }

  _cloneResult(r) {
    return {
      solved: r.solved,
      grid: r.grid ? r.grid.map(row => row.slice()) : null,
      ...(r.error !== undefined ? { error: r.error } : {}),
      ...(r.partial !== undefined ? { partial: r.partial } : {}),
    };
  }

  getHint(initialState) {
    const total = this.rows * this.cols;
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        this.cellStatus[r * this.cols + c] = initialState[r][c];
      }
    }
    const before = new Uint8Array(total);
    for (let i = 0; i < total; i++) before[i] = this.cellStatus[i];
    this.trail = [];
    this._depth = 0;
    this._inLookahead = false;
    this._startedAt = Date.now();

    const collectChanged = () => {
      const out = [];
      for (let i = 0; i < total; i++) {
        if (before[i] === 0 && this.cellStatus[i] !== 0) {
          const r = (i / this.cols) | 0;
          const c = i - r * this.cols;
          out.push({ row: r, col: c, value: this.cellStatus[i] });
        }
      }
      return out;
    };

    // Per-clue scan, stop at first that yields a change.
    for (let i = 0; i < this.clues.length; i++) {
      const cells = this.clueNeighborhood[i];
      const K = this.clueValues[i];
      let nB = 0, nU = 0;
      for (let j = 0; j < cells.length; j++) {
        const v = this.cellStatus[cells[j]];
        if (v === 1) nB++;
        else if (v === 0) nU++;
      }
      if (nB > K) return null;
      if (nB + nU < K) return null;
      let changed = false;
      if (nB === K && nU > 0) {
        for (let j = 0; j < cells.length; j++) {
          if (this.cellStatus[cells[j]] === 0) {
            if (!this._set(cells[j], 2)) return null;
            changed = true;
          }
        }
      } else if (nB + nU === K && nU > 0) {
        for (let j = 0; j < cells.length; j++) {
          if (this.cellStatus[cells[j]] === 0) {
            if (!this._set(cells[j], 1)) return null;
            changed = true;
          }
        }
      }
      if (changed) {
        const h = collectChanged();
        if (h.length) return h;
      }
    }

    // Single lookahead probe.
    for (let i = 0; i < total; i++) {
      if (this.cellStatus[i] !== 0) continue;
      const survivors = [];
      for (const v of [1, 2]) {
        const mark = this.trail.length;
        this._inLookahead = true;
        const okSet = this._set(i, v);
        const ok = okSet && this._propagate();
        this._rollback(mark);
        this._inLookahead = false;
        if (ok) survivors.push(v);
        if (survivors.length > 1) break;
      }
      if (survivors.length === 0) return null;
      if (survivors.length === 1) {
        if (!this._set(i, survivors[0])) return null;
        const h = collectChanged();
        if (h.length) return h;
      }
    }

    return null;
  }

  _storeInCache(key, result) {
    const m = result.partial ? MosaicSolver._partialCache : MosaicSolver._solutionCache;
    const max = result.partial ? MosaicSolver._maxPartialCache : MosaicSolver._maxSolutionCache;
    if (m.size >= max) {
      const first = m.keys().next().value;
      m.delete(first);
    }
    m.set(key, this._cloneResult(result));
  }

  static clearSolutionCache() {
    MosaicSolver._solutionCache.clear();
    MosaicSolver._partialCache.clear();
  }
}
MosaicSolver._solutionCache = new Map();
MosaicSolver._maxSolutionCache = 50;
MosaicSolver._partialCache = new Map();
MosaicSolver._maxPartialCache = 20;

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MosaicSolver };
}
