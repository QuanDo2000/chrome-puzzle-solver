'use strict';

const { hashFNV1a, emitGrid, cloneSolveResult } = require('./shared.js');

class HeyawakeSolver {
  constructor(data) {
    const { rows, cols, rooms, initialState, maxMs } = data;
    this.rows = rows;
    this.cols = cols;
    this.K = rooms.length;
    this.target = new Int32Array(this.K);
    this.roomCells = [];
    this.cellToRoom = new Int32Array(rows * cols).fill(-1);
    for (let k = 0; k < this.K; k++) {
      this.target[k] = rooms[k].target;
      const cells = rooms[k].cells;
      const arr = new Int32Array(cells.length);
      for (let i = 0; i < cells.length; i++) {
        const idx = cells[i].r * cols + cells[i].c;
        arr[i] = idx;
        this.cellToRoom[idx] = k;
      }
      this.roomCells.push(arr);
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
    this._buildLineConstraints();
    this._startedAt = 0;
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
      const neighbours = [];
      if (r > 0) neighbours.push(idx - this.cols);
      if (r < this.rows - 1) neighbours.push(idx + this.cols);
      if (c > 0) neighbours.push(idx - 1);
      if (c < this.cols - 1) neighbours.push(idx + 1);
      for (let i = 0; i < neighbours.length; i++) {
        const ni = neighbours[i];
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
      const idx = e & 0xffffff;
      const old = (e >>> 24) & 0xff;
      this.cellStatus[idx] = old;
    }
  }

  _timeUp() {
    if (this.maxMs <= 0) return false;
    return (Date.now() - this._startedAt) > this.maxMs;
  }

  _applyRoomCounts() {
    for (let k = 0; k < this.K; k++) {
      if (this.target[k] < 0) continue;
      const cells = this.roomCells[k];
      let nB = 0, nU = 0;
      for (let i = 0; i < cells.length; i++) {
        const v = this.cellStatus[cells[i]];
        if (v === 1) nB++;
        else if (v === 0) nU++;
      }
      if (nB > this.target[k]) return false;
      if (nB + nU < this.target[k]) return false;
      if (nB === this.target[k] && nU > 0) {
        for (let i = 0; i < cells.length; i++) {
          if (this.cellStatus[cells[i]] === 0) {
            if (!this._set(cells[i], 2)) return false;
          }
        }
      } else if (nB + nU === this.target[k] && nU > 0) {
        for (let i = 0; i < cells.length; i++) {
          if (this.cellStatus[cells[i]] === 0) {
            if (!this._set(cells[i], 1)) return false;
          }
        }
      }
    }
    return true;
  }

  _applyLineConstraints() {
    for (let i = 0; i < this.lineConstraints.length; i++) {
      const cells = this.lineConstraints[i];
      let nB = 0, nU = 0, uIdx = -1;
      for (let j = 0; j < cells.length; j++) {
        const v = this.cellStatus[cells[j]];
        if (v === 1) nB++;
        else if (v === 0) { nU++; uIdx = cells[j]; }
      }
      if (nB === 0 && nU === 0) return false;
      if (nB === 0 && nU === 1) {
        if (!this._set(uIdx, 1)) return false;
      }
    }
    return true;
  }

  _buildLineConstraints() {
    this.lineConstraints = [];
    for (let r = 0; r < this.rows; r++) {
      const row = new Array(this.cols);
      for (let c = 0; c < this.cols; c++) row[c] = r * this.cols + c;
      this._scanLineForConstraints(row);
    }
    for (let c = 0; c < this.cols; c++) {
      const col = new Array(this.rows);
      for (let r = 0; r < this.rows; r++) col[r] = r * this.cols + c;
      this._scanLineForConstraints(col);
    }
    this.lineConstraintsByCell = Array.from({ length: this.rows * this.cols }, () => []);
    for (let i = 0; i < this.lineConstraints.length; i++) {
      const cells = this.lineConstraints[i];
      for (let j = 0; j < cells.length; j++) {
        this.lineConstraintsByCell[cells[j]].push(i);
      }
    }
  }

  _scanLineForConstraints(cellIdxs) {
    const n = cellIdxs.length;
    if (n < 3) return;
    const segments = [];
    let curRoom = this.cellToRoom[cellIdxs[0]];
    let curStart = 0;
    for (let i = 1; i < n; i++) {
      const r = this.cellToRoom[cellIdxs[i]];
      if (r !== curRoom) {
        segments.push({ room: curRoom, start: curStart, end: i - 1 });
        curRoom = r;
        curStart = i;
      }
    }
    segments.push({ room: curRoom, start: curStart, end: n - 1 });
    for (let i = 0; i + 2 < segments.length; i++) {
      const a = segments[i], b = segments[i + 1], c = segments[i + 2];
      const span = [];
      span.push(cellIdxs[a.end]);
      for (let k = b.start; k <= b.end; k++) span.push(cellIdxs[k]);
      span.push(cellIdxs[c.start]);
      this.lineConstraints.push(new Int32Array(span));
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

  _propagate() {
    let changedOverall = true;
    while (changedOverall) {
      if (this._timeUp()) return true;
      changedOverall = false;
      const mark = this.trail.length;
      if (!this._applyRoomCounts()) return false;
      if (!this._applyLineConstraints()) return false;
      if (!this._applyConnectivity()) return false;
      if (this.trail.length > mark) changedOverall = true;
    }
    if (this._depth === 0 && !this._inLookahead) {
      if (!this._applyLookahead()) return false;
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
      const k = this.cellToRoom[i];
      const cells = this.roomCells[k];
      let nB = 0, nU = 0;
      for (let j = 0; j < cells.length; j++) {
        const v = this.cellStatus[cells[j]];
        if (v === 1) nB++;
        else if (v === 0) nU++;
      }
      let roomTightness = 0;
      if (this.target[k] >= 0) {
        const need = this.target[k] - nB;
        const slack = Math.min(need, nU - need);
        roomTightness = 1 / (Math.max(0, slack) + 1);
      }
      const r = (i / this.cols) | 0;
      const c = i - r * this.cols;
      let adj = 0;
      if (r > 0 && this.cellStatus[i - this.cols] !== 0) adj++;
      if (r < this.rows - 1 && this.cellStatus[i + this.cols] !== 0) adj++;
      if (c > 0 && this.cellStatus[i - 1] !== 0) adj++;
      if (c < this.cols - 1 && this.cellStatus[i + 1] !== 0) adj++;
      let lt = 0;
      const lcs = this.lineConstraintsByCell[i];
      for (let j = 0; j < lcs.length; j++) {
        const lcCells = this.lineConstraints[lcs[j]];
        let u = 0;
        for (let m = 0; m < lcCells.length; m++) {
          if (this.cellStatus[lcCells[m]] === 0) u++;
        }
        if (u <= 2) lt++;
      }
      const score = roomTightness * 4 + adj + lt;
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
    const cached = HeyawakeSolver._solutionCache.get(key) || HeyawakeSolver._partialCache.get(key);
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

  static _solutionCache = new Map();
  static _maxSolutionCache = 50;
  static _partialCache = new Map();
  static _maxPartialCache = 20;

  static clearSolutionCache() {
    HeyawakeSolver._solutionCache.clear();
    HeyawakeSolver._partialCache.clear();
  }

  // Stepwise hint: returns the cells deduced by ONE rule firing, not the
  // whole propagation-to-fixpoint cascade. Each click surfaces a single
  // logical step so the user can follow the deduction:
  //
  //   1. Room saturation — per room: if blacks==target force unknowns white,
  //      if blacks+unknowns==target force unknowns black. Stop at the first
  //      room that yields positives. Adjacency cascades (via _set) from the
  //      same step count as part of that step.
  //   2. Line constraint — per minimal 3-rooms span: if blacks==0 and one
  //      unknown remains, force it black. Stop at the first span that fires.
  //   3. Connectivity — BFS-then-articulation; whatever the rule forces in
  //      a single _applyConnectivity pass is one step (articulation
  //      analysis as a whole is one logical deduction).
  //   4. 1-step lookahead — probe one undecided cell at a time; if exactly
  //      one value survives, force it and stop.
  //
  // Returns [{row, col, value}, ...] (always positive value) or null when
  // nothing further can be deduced / the state is contradictory.
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

    // Rule 1: per-room saturation. Stop at the first room that yields a write.
    for (let k = 0; k < this.K; k++) {
      if (this.target[k] < 0) continue;
      const cells = this.roomCells[k];
      let nB = 0, nU = 0;
      for (let i = 0; i < cells.length; i++) {
        const v = this.cellStatus[cells[i]];
        if (v === 1) nB++;
        else if (v === 0) nU++;
      }
      if (nB > this.target[k]) return null;
      if (nB + nU < this.target[k]) return null;
      if (nB === this.target[k] && nU > 0) {
        for (let i = 0; i < cells.length; i++) {
          if (this.cellStatus[cells[i]] === 0) {
            if (!this._set(cells[i], 2)) return null;
          }
        }
        const hints = collectChanged();
        if (hints.length) return hints;
      } else if (nB + nU === this.target[k] && nU > 0) {
        for (let i = 0; i < cells.length; i++) {
          if (this.cellStatus[cells[i]] === 0) {
            if (!this._set(cells[i], 1)) return null;
          }
        }
        const hints = collectChanged();
        if (hints.length) return hints;
      }
    }

    // Rule 3: per line-constraint, force black if only one unknown remains.
    // (Rule 2, no-adjacent-blacks, is eager inside _set so it can't fire
    //  independently — it cascades from any black write above.)
    for (let i = 0; i < this.lineConstraints.length; i++) {
      const cells = this.lineConstraints[i];
      let nB = 0, nU = 0, uIdx = -1;
      for (let j = 0; j < cells.length; j++) {
        const v = this.cellStatus[cells[j]];
        if (v === 1) nB++;
        else if (v === 0) { nU++; uIdx = cells[j]; }
      }
      if (nB === 0 && nU === 0) return null;
      if (nB === 0 && nU === 1) {
        if (!this._set(uIdx, 1)) return null;
        const hints = collectChanged();
        if (hints.length) return hints;
      }
    }

    // Rule 4: connectivity (BFS for contradiction + articulation forcing).
    // _applyConnectivity already encapsulates "one connectivity deduction".
    if (!this._applyConnectivity()) return null;
    {
      const hints = collectChanged();
      if (hints.length) return hints;
    }

    // Rule 5: 1-step lookahead — probe each unknown cell with each value;
    // force the survivor if exactly one passes. Stop at first force.
    for (let i = 0; i < total; i++) {
      if (this.cellStatus[i] !== 0) continue;
      const survivors = [];
      for (const v of [1, 2]) {
        const probeMark = this.trail.length;
        this._inLookahead = true;
        const okSet = this._set(i, v);
        const ok = okSet && this._propagate();
        this._rollback(probeMark);
        this._inLookahead = false;
        if (ok) survivors.push(v);
        if (survivors.length > 1) break;
      }
      if (survivors.length === 0) return null;
      if (survivors.length === 1) {
        if (!this._set(i, survivors[0])) return null;
        const hints = collectChanged();
        if (hints.length) return hints;
      }
    }

    return null;
  }

  _cacheKey() {
    return hashFNV1a((mix) => {
      mix(this.rows); mix(this.cols); mix(this.K);
      for (let k = 0; k < this.K; k++) mix(this.target[k] + 1);
      for (let i = 0; i < this.rows * this.cols; i++) mix(this.cellToRoom[i]);
    });
  }

  _cloneResult(r) {
    return cloneSolveResult(r);
  }

  _storeInCache(key, result) {
    const m = result.partial ? HeyawakeSolver._partialCache : HeyawakeSolver._solutionCache;
    const max = result.partial ? HeyawakeSolver._maxPartialCache : HeyawakeSolver._maxSolutionCache;
    if (m.size >= max) {
      const first = m.keys().next().value;
      m.delete(first);
    }
    m.set(key, this._cloneResult(result));
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { HeyawakeSolver };
}
