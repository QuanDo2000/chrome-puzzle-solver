'use strict';

const { hashFNV1a, emitGrid, cloneSolveResult, timeUp } = require('./shared.js');

class HitoriSolver {
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
    this._buildStaticForcedWhites();
    this._buildBuckets();
    this._startedAt = 0;
  }

  _buildStaticForcedWhites() {
    const forced = [];
    for (let r = 0; r < this.rows; r++) {
      for (let c = 1; c < this.cols - 1; c++) {
        const left = this.task[r * this.cols + c - 1];
        const right = this.task[r * this.cols + c + 1];
        if (left === right) {
          forced.push(r * this.cols + c);
        }
      }
    }
    for (let c = 0; c < this.cols; c++) {
      for (let r = 1; r < this.rows - 1; r++) {
        const up = this.task[(r - 1) * this.cols + c];
        const down = this.task[(r + 1) * this.cols + c];
        if (up === down) {
          const idx = r * this.cols + c;
          if (!forced.includes(idx)) forced.push(idx);
        }
      }
    }
    this.staticForcedWhites = new Int32Array(forced);
  }

  _buildBuckets() {
    this.rowBuckets = new Array(this.rows);
    for (let r = 0; r < this.rows; r++) {
      const m = new Map();
      for (let c = 0; c < this.cols; c++) {
        const idx = r * this.cols + c;
        const v = this.task[idx];
        if (!m.has(v)) m.set(v, []);
        m.get(v).push(idx);
      }
      this.rowBuckets[r] = m;
    }
    this.colBuckets = new Array(this.cols);
    for (let c = 0; c < this.cols; c++) {
      const m = new Map();
      for (let r = 0; r < this.rows; r++) {
        const idx = r * this.cols + c;
        const v = this.task[idx];
        if (!m.has(v)) m.set(v, []);
        m.get(v).push(idx);
      }
      this.colBuckets[c] = m;
    }
  }

  _applyUniquenessBucket(idxs) {
    let nW = 0, nU = 0;
    for (let i = 0; i < idxs.length; i++) {
      const v = this.cellStatus[idxs[i]];
      if (v === 2) nW++;
      else if (v === 0) nU++;
    }
    if (nW > 1) return false;
    if (nW === 1 && nU > 0) {
      for (let i = 0; i < idxs.length; i++) {
        if (this.cellStatus[idxs[i]] === 0) {
          if (!this._set(idxs[i], 1)) return false;
        }
      }
    }
    return true;
  }

  _applyUniqueness() {
    for (let r = 0; r < this.rows; r++) {
      for (const idxs of this.rowBuckets[r].values()) {
        if (idxs.length < 2) continue;
        if (!this._applyUniquenessBucket(idxs)) return false;
      }
    }
    for (let c = 0; c < this.cols; c++) {
      for (const idxs of this.colBuckets[c].values()) {
        if (idxs.length < 2) continue;
        if (!this._applyUniquenessBucket(idxs)) return false;
      }
    }
    return true;
  }

  _applyStaticForcedWhites() {
    for (let i = 0; i < this.staticForcedWhites.length; i++) {
      const idx = this.staticForcedWhites[i];
      if (this.cellStatus[idx] === 0) {
        if (!this._set(idx, 2)) return false;
      } else if (this.cellStatus[idx] !== 2) {
        return false;
      }
    }
    return true;
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
    const disc = new Int32Array(total).fill(-1);
    const low = new Int32Array(total);
    const parent = new Int32Array(total).fill(-1);
    const subtreeKnownWhite = new Int32Array(total);
    const articulationSplits = new Int32Array(total);
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
    return timeUp(this.maxMs, this._startedAt);
  }

  _propagate() {
    let changedOverall = true;
    while (changedOverall) {
      if (this._timeUp()) return true;
      changedOverall = false;
      const mark = this.trail.length;
      if (!this._applyStaticForcedWhites()) return false;
      if (!this._applyUniqueness()) return false;
      if (!this._applyConnectivity()) return false;
      if (this.trail.length > mark) changedOverall = true;
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
    let bestIdx = -1;
    let bestScore = -Infinity;
    const total = this.rows * this.cols;
    for (let i = 0; i < total; i++) {
      if (this.cellStatus[i] !== 0) continue;
      const r = (i / this.cols) | 0;
      const c = i - r * this.cols;
      const v = this.task[i];
      const rowBucket = this.rowBuckets[r].get(v);
      const colBucket = this.colBuckets[c].get(v);
      let bestTight = 0;
      for (const idxs of [rowBucket, colBucket]) {
        if (!idxs || idxs.length < 2) continue;
        let unk = 0;
        for (let j = 0; j < idxs.length; j++) {
          if (this.cellStatus[idxs[j]] === 0) unk++;
        }
        const t = 1 / (unk + 1);
        if (t > bestTight) bestTight = t;
      }
      let adj = 0;
      if (r > 0 && this.cellStatus[i - this.cols] !== 0) adj++;
      if (r < this.rows - 1 && this.cellStatus[i + this.cols] !== 0) adj++;
      if (c > 0 && this.cellStatus[i - 1] !== 0) adj++;
      if (c < this.cols - 1 && this.cellStatus[i + 1] !== 0) adj++;
      const score = bestTight * 4 + adj;
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

    // Rule 1: static sandwich/triplet.
    if (!this._applyStaticForcedWhites()) return null;
    {
      const h = collectChanged();
      if (h.length) return h;
    }

    // Rule 2: uniqueness per row-bucket, then col-bucket. Stop at first firing.
    for (let r = 0; r < this.rows; r++) {
      for (const idxs of this.rowBuckets[r].values()) {
        if (idxs.length < 2) continue;
        if (!this._applyUniquenessBucket(idxs)) return null;
        const h = collectChanged();
        if (h.length) return h;
      }
    }
    for (let c = 0; c < this.cols; c++) {
      for (const idxs of this.colBuckets[c].values()) {
        if (idxs.length < 2) continue;
        if (!this._applyUniquenessBucket(idxs)) return null;
        const h = collectChanged();
        if (h.length) return h;
      }
    }

    // Rule 3: connectivity.
    if (!this._applyConnectivity()) return null;
    {
      const h = collectChanged();
      if (h.length) return h;
    }

    // Rule 4: single lookahead probe.
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

  solve() {
    const key = this._cacheKey();
    const cached = HitoriSolver._solutionCache.get(key)
                || HitoriSolver._partialCache.get(key);
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
      for (let i = 0; i < this.rows * this.cols; i++) mix(this.task[i]);
    });
  }

  _cloneResult(r) {
    return cloneSolveResult(r);
  }

  _storeInCache(key, result) {
    const m = result.partial ? HitoriSolver._partialCache : HitoriSolver._solutionCache;
    const max = result.partial ? HitoriSolver._maxPartialCache : HitoriSolver._maxSolutionCache;
    if (m.size >= max) {
      const first = m.keys().next().value;
      m.delete(first);
    }
    m.set(key, this._cloneResult(result));
  }
}

HitoriSolver._solutionCache = new Map();
HitoriSolver._maxSolutionCache = 50;
HitoriSolver._partialCache = new Map();
HitoriSolver._maxPartialCache = 20;
HitoriSolver.clearSolutionCache = function() {
  HitoriSolver._solutionCache.clear();
  HitoriSolver._partialCache.clear();
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { HitoriSolver };
}
