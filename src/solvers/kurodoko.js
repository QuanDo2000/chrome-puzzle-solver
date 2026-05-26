'use strict';

class KurodokoSolver {
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
    this._startedAt = 0;
    // Force clue cells to white.
    for (let i = 0; i < this.clues.length; i++) {
      this._set(this.clues[i], 2);
    }
  }

  _set(idx, value) {
    const old = this.cellStatus[idx];
    if (old === value) return true;
    if (old !== 0) return false;
    this.trail.push(idx | (old << 24));
    this.cellStatus[idx] = value;
    if (value === 1) {
      const r = (idx / this.cols) | 0;
      const c = idx - r * this.cols;
      const ns = [];
      if (r > 0) ns.push(idx - this.cols);
      if (r < this.rows - 1) ns.push(idx + this.cols);
      if (c > 0) ns.push(idx - 1);
      if (c < this.cols - 1) ns.push(idx + 1);
      for (let i = 0; i < ns.length; i++) {
        const ni = ns[i];
        const nv = this.cellStatus[ni];
        if (nv === 1) return false;
        if (nv === 0) {
          if (!this._set(ni, 2)) return false;
        }
      }
    }
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

  _applyConnectivity() {
    const total = this.rows * this.cols;
    let anchor = -1;
    for (let i = 0; i < total; i++) {
      if (this.cellStatus[i] === 2) { anchor = i; break; }
    }
    if (anchor < 0) return true;
    // Phase A: BFS reachability — every known white must be reachable
    // through {white ∪ unknown}.
    const visited = new Uint8Array(total);
    visited[anchor] = 1;
    const stack = [anchor];
    while (stack.length) {
      const u = stack.pop();
      const r = (u / this.cols) | 0;
      const c = u - r * this.cols;
      const ns = [];
      if (r > 0) ns.push(u - this.cols);
      if (r < this.rows - 1) ns.push(u + this.cols);
      if (c > 0) ns.push(u - 1);
      if (c < this.cols - 1) ns.push(u + 1);
      for (let i = 0; i < ns.length; i++) {
        const ni = ns[i];
        if (!visited[ni] && this.cellStatus[ni] !== 1) { visited[ni] = 1; stack.push(ni); }
      }
    }
    for (let i = 0; i < total; i++) {
      if (this.cellStatus[i] === 2 && !visited[i]) return false;
    }
    if (this._inLookahead) return true;
    // Phase B: articulation analysis on the {white ∪ unknown} graph.
    // An unknown cell whose removal would disconnect any two known whites
    // must itself be white.
    // Iterative Tarjan with parent / disc / low arrays.
    const disc = new Int32Array(total).fill(-1);
    const low = new Int32Array(total);
    const parent = new Int32Array(total).fill(-1);
    const subtreeKnownWhite = new Int32Array(total); // count in own subtree
    const articulationSplits = new Int32Array(total); // count of children whose subtree contains ≥1 known white
    let timer = 0;
    const dfsStack = [];
    const neighboursOf = (u) => {
      const r = (u / this.cols) | 0;
      const c = u - r * this.cols;
      const ns = [];
      if (r > 0) { const ni = u - this.cols; if (this.cellStatus[ni] !== 1) ns.push(ni); }
      if (r < this.rows - 1) { const ni = u + this.cols; if (this.cellStatus[ni] !== 1) ns.push(ni); }
      if (c > 0) { const ni = u - 1; if (this.cellStatus[ni] !== 1) ns.push(ni); }
      if (c < this.cols - 1) { const ni = u + 1; if (this.cellStatus[ni] !== 1) ns.push(ni); }
      return ns;
    };
    disc[anchor] = low[anchor] = timer++;
    subtreeKnownWhite[anchor] = (this.cellStatus[anchor] === 2 ? 1 : 0);
    dfsStack.push({ u: anchor, ns: neighboursOf(anchor), idx: 0 });
    let rootChildCount = 0;
    while (dfsStack.length) {
      const top = dfsStack[dfsStack.length - 1];
      if (top.idx >= top.ns.length) {
        const u = top.u;
        const p = parent[u];
        if (p >= 0) {
          if (low[u] < low[p]) low[p] = low[u];
          subtreeKnownWhite[p] += subtreeKnownWhite[u];
          if (low[u] >= disc[p] && subtreeKnownWhite[u] >= 1) {
            articulationSplits[p]++;
          }
        }
        dfsStack.pop();
        continue;
      }
      const v = top.ns[top.idx++];
      const u = top.u;
      if (disc[v] < 0) {
        parent[v] = u;
        disc[v] = low[v] = timer++;
        subtreeKnownWhite[v] = (this.cellStatus[v] === 2 ? 1 : 0);
        if (u === anchor) rootChildCount++;
        dfsStack.push({ u: v, ns: neighboursOf(v), idx: 0 });
      } else if (v !== parent[u]) {
        if (disc[v] < low[u]) low[u] = disc[v];
      }
    }
    const totalKnownWhites = subtreeKnownWhite[anchor];
    for (let u = 0; u < total; u++) {
      if (this.cellStatus[u] !== 0) continue;
      if (disc[u] < 0) continue;
      let critical = false;
      if (u === anchor) {
        critical = (rootChildCount >= 2 && articulationSplits[u] >= 2);
      } else {
        const restWhites = totalKnownWhites - subtreeKnownWhite[u];
        critical = (articulationSplits[u] >= 1 && restWhites >= 1);
      }
      if (critical) {
        if (!this._set(u, 2)) return false;
      }
    }
    return true;
  }

  _timeUp() {
    if (this.maxMs <= 0) return false;
    return (Date.now() - this._startedAt) > this.maxMs;
  }

  _applyVisibility() {
    const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (let i = 0; i < this.clues.length; i++) {
      const idx = this.clues[i];
      const K = this.clueValues[i];
      const r0 = (idx / this.cols) | 0;
      const c0 = idx - r0 * this.cols;
      const lowers = [];
      const uppers = [];
      const cellsByDir = [];
      for (const [dr, dc] of dirs) {
        let lower = 0;
        let stillRun = true;
        const cells = [];
        let rr = r0 + dr, cc = c0 + dc;
        while (rr >= 0 && rr < this.rows && cc >= 0 && cc < this.cols) {
          const cidx = rr * this.cols + cc;
          const v = this.cellStatus[cidx];
          if (v === 1) break;
          cells.push(cidx);
          if (stillRun) {
            if (v === 2) lower++;
            else stillRun = false;
          }
          rr += dr; cc += dc;
        }
        lowers.push(lower);
        uppers.push(cells.length);
        cellsByDir.push(cells);
      }
      const sumLower = lowers[0] + lowers[1] + lowers[2] + lowers[3];
      const sumUpper = uppers[0] + uppers[1] + uppers[2] + uppers[3];
      if (sumLower + 1 > K) return false;
      if (sumUpper + 1 < K) return false;
      const T = K - 1;
      for (let d = 0; d < 4; d++) {
        const otherSumLower = sumLower - lowers[d];
        const otherSumUpper = sumUpper - uppers[d];
        const vis_min = Math.max(lowers[d], T - otherSumUpper);
        const vis_max = Math.min(uppers[d], T - otherSumLower);
        if (vis_min > vis_max) return false;
        const cells = cellsByDir[d];
        // Force [0..vis_min-1] white.
        for (let j = 0; j < vis_min; j++) {
          if (this.cellStatus[cells[j]] === 0) {
            if (!this._set(cells[j], 2)) return false;
          }
        }
        // If tight (vis_min == vis_max) and stopping cell exists, force black.
        if (vis_min === vis_max && vis_max < cells.length) {
          if (this.cellStatus[cells[vis_max]] === 0) {
            if (!this._set(cells[vis_max], 1)) return false;
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
      if (!this._applyVisibility()) return false;
      if (!this._applyConnectivity()) return false;
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
    const grid = [];
    for (let r = 0; r < this.rows; r++) {
      const row = new Array(this.cols);
      for (let c = 0; c < this.cols; c++) {
        const idx = r * this.cols + c;
        // Clue cells emit 0 (page invariant: clue cells stay 0 in cellStatus).
        row[c] = (this.task[idx] !== -1) ? 0 : this.cellStatus[idx];
      }
      grid.push(row);
    }
    return grid;
  }

  _pickBestUnknown() {
    let bestIdx = -1, bestScore = -Infinity;
    const total = this.rows * this.cols;
    for (let i = 0; i < total; i++) {
      if (this.cellStatus[i] !== 0) continue;
      const r = (i / this.cols) | 0, c = i - r * this.cols;
      let adj = 0;
      if (r > 0 && this.cellStatus[i - this.cols] !== 0) adj++;
      if (r < this.rows - 1 && this.cellStatus[i + this.cols] !== 0) adj++;
      if (c > 0 && this.cellStatus[i - 1] !== 0) adj++;
      if (c < this.cols - 1 && this.cellStatus[i + 1] !== 0) adj++;
      const score = adj;
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
    const cached = KurodokoSolver._solutionCache.get(key)
                || KurodokoSolver._partialCache.get(key);
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
    let h = 0x811c9dc5;
    const mix = (n) => { h ^= n & 0xff; h = Math.imul(h, 0x01000193) >>> 0; };
    mix(this.rows); mix(this.cols);
    for (let i = 0; i < this.rows * this.cols; i++) mix(this.task[i] + 1);
    return h >>> 0;
  }

  _cloneResult(r) {
    return {
      solved: r.solved,
      grid: r.grid ? r.grid.map(row => row.slice()) : null,
      ...(r.error !== undefined ? { error: r.error } : {}),
      ...(r.partial !== undefined ? { partial: r.partial } : {}),
    };
  }

  _storeInCache(key, result) {
    const m = result.partial ? KurodokoSolver._partialCache : KurodokoSolver._solutionCache;
    const max = result.partial ? KurodokoSolver._maxPartialCache : KurodokoSolver._maxSolutionCache;
    if (m.size >= max) {
      const first = m.keys().next().value;
      m.delete(first);
    }
    m.set(key, this._cloneResult(result));
  }

  getHint(initialState) {
    const total = this.rows * this.cols;
    // Load the caller's board state.
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        this.cellStatus[r * this.cols + c] = initialState[r][c];
      }
    }
    this.trail = [];
    this._depth = 0;
    this._inLookahead = false;
    this._startedAt = Date.now();
    // Force clue cells to white (matching constructor behaviour).
    for (let i = 0; i < this.clues.length; i++) {
      if (this.cellStatus[this.clues[i]] === 0) {
        if (!this._set(this.clues[i], 2)) return null;
      }
    }
    const before = new Uint8Array(total);
    for (let i = 0; i < total; i++) before[i] = this.cellStatus[i];

    const collectChanged = () => {
      const out = [];
      for (let i = 0; i < total; i++) {
        if (before[i] === 0 && this.cellStatus[i] !== 0 && this.task[i] === -1) {
          const r = (i / this.cols) | 0;
          const c = i - r * this.cols;
          out.push({ row: r, col: c, value: this.cellStatus[i] });
        }
      }
      return out;
    };

    // Visibility — one pass; return if anything changed.
    const cm1 = this.trail.length;
    if (!this._applyVisibility()) return null;
    if (this.trail.length > cm1) {
      const h = collectChanged();
      if (h.length) return h;
    }

    // Connectivity — one pass; return if anything changed.
    const cm2 = this.trail.length;
    if (!this._applyConnectivity()) return null;
    if (this.trail.length > cm2) {
      const h = collectChanged();
      if (h.length) return h;
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
}

KurodokoSolver._solutionCache = new Map();
KurodokoSolver._maxSolutionCache = 50;
KurodokoSolver._partialCache = new Map();
KurodokoSolver._maxPartialCache = 20;
KurodokoSolver.clearSolutionCache = function() {
  KurodokoSolver._solutionCache.clear();
  KurodokoSolver._partialCache.clear();
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { KurodokoSolver };
}
