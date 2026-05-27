'use strict';

class NurikabeSolver {
  constructor(data) {
    const { rows, cols, task, initialState, maxMs } = data;
    this.rows = rows;
    this.cols = cols;
    this.N = rows * cols;
    this.task = new Int32Array(this.N);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        this.task[r * cols + c] = task[r][c];
      }
    }
    // task[i]: positive = clue value; -1 = blank cell; -2 = wall (cell not
    // on the board, treated as a permanent blocker for BFS, never counted
    // toward black totals or 2x2 violations).
    this.isWall = new Uint8Array(this.N);
    let wallCount = 0;
    for (let i = 0; i < this.N; i++) {
      if (this.task[i] === -2) { this.isWall[i] = 1; wallCount++; }
    }
    this.clues = [];
    let sum = 0;
    for (let i = 0; i < this.N; i++) {
      const v = this.task[i];
      if (v > 0) { this.clues.push({ idx: i, size: v }); sum += v; }
    }
    this.expectedBlacks = this.N - wallCount - sum;
    this.cellStatus = new Uint8Array(this.N);
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
    this.contradiction = false;
    // Reused BFS scratch buffers to avoid per-call Uint8Array allocation.
    this._bfsVisited = new Uint8Array(this.N);
    this._bfsQueue = new Int32Array(this.N);
    this._bfsMembers = new Uint8Array(this.N);
    this._bfsReachable = new Uint8Array(this.N);
    this._bfsReachList = new Int32Array(this.N);
    this._bfsMembersList = new Int32Array(this.N);
    this._bfsFrontierList = new Int32Array(this.N);
    // claimedBy[i] = clue idx that owns this WHITE cell, or -1 if not yet
    // claimed (UNKNOWN/BLACK/wall, or WHITE not yet attached to a clue).
    this._claimedBy = new Int32Array(this.N);
    // Shape enumeration scratch.
    this._shapeInShape = new Uint8Array(this.N);
    this._shapeStack = new Int32Array(this.N);
    this._shapeFrontier = new Int32Array(this.N);
    this._shapeInFrontier = new Uint8Array(this.N);
    this._shapeInAll = new Uint8Array(this.N);
    this._shapeInAny = new Uint8Array(this.N);
    this._shapeCouldBeWhite = new Uint8Array(this.N);
    // Coarse dirty bit — set whenever cellStatus changes via _set; cleared
    // by _applyShapeEnumeration on entry.
    this._dirtyShape = true;

    // Force clue cells WHITE.
    for (const clue of this.clues) {
      if (!this._set(clue.idx, 2)) { this.contradiction = true; return; }
    }
    // Two clue cells can never be 4-adjacent.
    for (const clue of this.clues) {
      const r = (clue.idx / cols) | 0;
      const c = clue.idx - r * cols;
      const ns = [];
      if (r > 0) ns.push(clue.idx - cols);
      if (r < rows - 1) ns.push(clue.idx + cols);
      if (c > 0) ns.push(clue.idx - 1);
      if (c < cols - 1) ns.push(clue.idx + 1);
      for (const ni of ns) {
        if (this.task[ni] > 0) { this.contradiction = true; return; }
      }
    }
    // Each clue's reachable area (BFS through non-BLACK, not through
    // other clue cells) ≥ N.
    for (const clue of this.clues) {
      if (this._reachableFromCell(clue.idx, clue.size) < clue.size) {
        this.contradiction = true;
        return;
      }
    }
  }

  // Caps for _applyShapeEnumeration. Both numbers are conservative — raise
  // only after benching.
  static MAX_SHAPES_PER_CLUE = 2000;
  static MAX_ENUMERATED_CLUE_SIZE = 12;

  _reachableFromCell(startIdx, cap) {
    const visited = this._bfsVisited;
    visited.fill(0);
    const queue = this._bfsQueue;
    let qHead = 0, qTail = 0;
    visited[startIdx] = 1;
    queue[qTail++] = startIdx;
    let count = 1;
    const cols = this.cols, rows = this.rows;
    while (qHead < qTail && count < cap + 1) {
      const idx = queue[qHead++];
      const r = (idx / cols) | 0;
      const c = idx - r * cols;
      if (r > 0) {
        const ni = idx - cols;
        if (!visited[ni] && !this.isWall[ni] && this.cellStatus[ni] !== 1 && (ni === startIdx || this.task[ni] <= 0)) {
          visited[ni] = 1; count++;
          if (count >= cap + 1) break;
          queue[qTail++] = ni;
        }
      }
      if (r < rows - 1) {
        const ni = idx + cols;
        if (!visited[ni] && !this.isWall[ni] && this.cellStatus[ni] !== 1 && (ni === startIdx || this.task[ni] <= 0)) {
          visited[ni] = 1; count++;
          if (count >= cap + 1) break;
          queue[qTail++] = ni;
        }
      }
      if (c > 0) {
        const ni = idx - 1;
        if (!visited[ni] && !this.isWall[ni] && this.cellStatus[ni] !== 1 && (ni === startIdx || this.task[ni] <= 0)) {
          visited[ni] = 1; count++;
          if (count >= cap + 1) break;
          queue[qTail++] = ni;
        }
      }
      if (c < cols - 1) {
        const ni = idx + 1;
        if (!visited[ni] && !this.isWall[ni] && this.cellStatus[ni] !== 1 && (ni === startIdx || this.task[ni] <= 0)) {
          visited[ni] = 1; count++;
          if (count >= cap + 1) break;
          queue[qTail++] = ni;
        }
      }
    }
    return count;
  }

  _set(idx, value) {
    const old = this.cellStatus[idx];
    if (old === value) return true;
    if (old !== 0) return false;
    this.trail.push(idx | (old << 24));
    this.cellStatus[idx] = value;
    this._dirtyShape = true;
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

  _applyClueAdjacency() {
    for (let i = 0; i < this.N; i++) {
      if (this.isWall[i]) continue;
      if (this.cellStatus[i] !== 0) continue;
      const r = (i / this.cols) | 0;
      const c = i - r * this.cols;
      const ns = [];
      if (r > 0) ns.push(i - this.cols);
      if (r < this.rows - 1) ns.push(i + this.cols);
      if (c > 0) ns.push(i - 1);
      if (c < this.cols - 1) ns.push(i + 1);
      let clueCount = 0;
      for (const ni of ns) if (this.task[ni] > 0) clueCount++;
      if (clueCount >= 2) {
        if (!this._set(i, 1)) return false;
      }
    }
    return true;
  }

  // Mark cells reachable from clue.idx within (clue.size - 1) steps into
  // `union`, skipping BLACK, walls, and other clue cells. Step-wise BFS via
  // the shared scratch queue.
  _bfsClueReachInto(clue, union) {
    const visited = this._bfsVisited;
    visited.fill(0);
    const queue = this._bfsQueue;
    let qHead = 0, qTail = 0;
    visited[clue.idx] = 1;
    union[clue.idx] = 1;
    queue[qTail++] = clue.idx;
    const cols = this.cols, rows = this.rows;
    // Step-wise: track frontier boundary in queue using level markers.
    let stepEnd = qTail;
    for (let step = 1; step < clue.size; step++) {
      const nextStart = qTail;
      while (qHead < stepEnd) {
        const idx = queue[qHead++];
        const r = (idx / cols) | 0;
        const c = idx - r * cols;
        if (r > 0) {
          const ni = idx - cols;
          if (!visited[ni] && !this.isWall[ni] && this.cellStatus[ni] !== 1 && (ni === clue.idx || this.task[ni] <= 0)) {
            visited[ni] = 1; union[ni] = 1; queue[qTail++] = ni;
          }
        }
        if (r < rows - 1) {
          const ni = idx + cols;
          if (!visited[ni] && !this.isWall[ni] && this.cellStatus[ni] !== 1 && (ni === clue.idx || this.task[ni] <= 0)) {
            visited[ni] = 1; union[ni] = 1; queue[qTail++] = ni;
          }
        }
        if (c > 0) {
          const ni = idx - 1;
          if (!visited[ni] && !this.isWall[ni] && this.cellStatus[ni] !== 1 && (ni === clue.idx || this.task[ni] <= 0)) {
            visited[ni] = 1; union[ni] = 1; queue[qTail++] = ni;
          }
        }
        if (c < cols - 1) {
          const ni = idx + 1;
          if (!visited[ni] && !this.isWall[ni] && this.cellStatus[ni] !== 1 && (ni === clue.idx || this.task[ni] <= 0)) {
            visited[ni] = 1; union[ni] = 1; queue[qTail++] = ni;
          }
        }
      }
      if (nextStart === qTail) break;
      stepEnd = qTail;
    }
  }

  _applyUnreachable() {
    const union = this._bfsReachable;
    union.fill(0);
    for (const clue of this.clues) this._bfsClueReachInto(clue, union);
    for (let i = 0; i < this.N; i++) {
      if (this.isWall[i]) continue;
      if (this.cellStatus[i] !== 0) continue;
      if (!union[i]) {
        if (!this._set(i, 1)) return false;
      }
    }
    return true;
  }

  // Single BFS that produces both the WHITE-connected component (`members`)
  // AND the WHITE-or-UNKNOWN reachable closure (`reachable`) for a clue.
  // BFS through {non-BLACK, non-wall, not another clue}. members[i] is set
  // only for cells reached through an all-WHITE path; reachable[i] also
  // marks cells whose closest ancestor in the BFS first crossed an UNKNOWN.
  // Returns {size, capacity}. Members & reachable are stored in the shared
  // scratch buffers `_bfsMembers` / `_bfsReachable` (reset by this call).
  // Single BFS from a clue producing:
  //   - membersList[0..membersCount): cells reachable via an all-WHITE path
  //   - reachList[0..reachCount): cells reachable via WHITE-or-UNKNOWN
  // (each list packs indices densely, so iteration is O(set size) not O(N)).
  // Returns {size: membersCount, capacity: reachCount}. Buffers are
  // overwritten on each call; caller must consume before the next call.
  _bfsClueIsland(clue) {
    const reachable = this._bfsReachable;
    const reachList = this._bfsReachList;
    const membersList = this._bfsMembersList;
    // Clear only the cells we touched on the previous call: reachable[i] is
    // set iff reachList contains i, so we'd need to track that. Easier
    // safe-and-cheap: fill(0).
    reachable.fill(0);
    reachable[clue.idx] = 1;
    let reachCount = 1, membersCount = 1;
    reachList[0] = clue.idx;
    membersList[0] = clue.idx;
    const queue = this._bfsQueue;
    // Pack "all-WHITE path so far" into bit 30 of the queue entry.
    const WHITE_BIT = 1 << 30;
    let qHead = 0, qTail = 0;
    queue[qTail++] = clue.idx | WHITE_BIT;
    const cols = this.cols, rows = this.rows;
    const clueIdx = clue.idx;
    const isWall = this.isWall;
    const cellStatus = this.cellStatus;
    const task = this.task;
    const claimedBy = this._claimedBy;
    while (qHead < qTail) {
      const entry = queue[qHead++];
      const idx = entry & ~WHITE_BIT;
      const whiteSoFar = (entry & WHITE_BIT) !== 0;
      const r = (idx / cols) | 0;
      const c = idx - r * cols;
      // Helper inlined four times for the four neighbour directions. A cell
      // is enterable iff: not yet reached, not a wall, not BLACK, not a
      // different clue cell, and not WHITE-claimed by a different clue
      // (since that would belong to that clue's island, not this one).
      if (r > 0) {
        const ni = idx - cols;
        if (!reachable[ni] && !isWall[ni]) {
          const v = cellStatus[ni];
          const o = claimedBy[ni];
          if (v !== 1 && (task[ni] <= 0 || ni === clueIdx) && (o === -1 || o === clueIdx)) {
            reachable[ni] = 1;
            reachList[reachCount++] = ni;
            const stillWhite = whiteSoFar && v === 2;
            if (stillWhite) membersList[membersCount++] = ni;
            queue[qTail++] = stillWhite ? (ni | WHITE_BIT) : ni;
          }
        }
      }
      if (r < rows - 1) {
        const ni = idx + cols;
        if (!reachable[ni] && !isWall[ni]) {
          const v = cellStatus[ni];
          const o = claimedBy[ni];
          if (v !== 1 && (task[ni] <= 0 || ni === clueIdx) && (o === -1 || o === clueIdx)) {
            reachable[ni] = 1;
            reachList[reachCount++] = ni;
            const stillWhite = whiteSoFar && v === 2;
            if (stillWhite) membersList[membersCount++] = ni;
            queue[qTail++] = stillWhite ? (ni | WHITE_BIT) : ni;
          }
        }
      }
      if (c > 0) {
        const ni = idx - 1;
        if (!reachable[ni] && !isWall[ni]) {
          const v = cellStatus[ni];
          const o = claimedBy[ni];
          if (v !== 1 && (task[ni] <= 0 || ni === clueIdx) && (o === -1 || o === clueIdx)) {
            reachable[ni] = 1;
            reachList[reachCount++] = ni;
            const stillWhite = whiteSoFar && v === 2;
            if (stillWhite) membersList[membersCount++] = ni;
            queue[qTail++] = stillWhite ? (ni | WHITE_BIT) : ni;
          }
        }
      }
      if (c < cols - 1) {
        const ni = idx + 1;
        if (!reachable[ni] && !isWall[ni]) {
          const v = cellStatus[ni];
          const o = claimedBy[ni];
          if (v !== 1 && (task[ni] <= 0 || ni === clueIdx) && (o === -1 || o === clueIdx)) {
            reachable[ni] = 1;
            reachList[reachCount++] = ni;
            const stillWhite = whiteSoFar && v === 2;
            if (stillWhite) membersList[membersCount++] = ni;
            queue[qTail++] = stillWhite ? (ni | WHITE_BIT) : ni;
          }
        }
      }
    }
    return { size: membersCount, capacity: reachCount };
  }

  _applyIslandComplete() {
    const reachList = this._bfsReachList;
    const membersList = this._bfsMembersList;
    const cols = this.cols, rows = this.rows;
    for (const clue of this.clues) {
      const { size, capacity } = this._bfsClueIsland(clue);
      if (size > clue.size) return false;
      if (capacity < clue.size) return false;
      if (size === clue.size) {
        // Members list is dense; iterate it directly. Visit each member
        // cell's 4-neighbour and force unknown cross-island neighbours BLACK.
        // (Members are connected; their non-member non-wall non-clue
        // neighbours are the island frontier.)
        for (let mi = 0; mi < size; mi++) {
          const idx = membersList[mi];
          const r = (idx / cols) | 0;
          const c = idx - r * cols;
          if (r > 0) {
            const ni = idx - cols;
            if (this.cellStatus[ni] === 0 && !this.isWall[ni]) {
              if (!this._set(ni, 1)) return false;
            }
          }
          if (r < rows - 1) {
            const ni = idx + cols;
            if (this.cellStatus[ni] === 0 && !this.isWall[ni]) {
              if (!this._set(ni, 1)) return false;
            }
          }
          if (c > 0) {
            const ni = idx - 1;
            if (this.cellStatus[ni] === 0 && !this.isWall[ni]) {
              if (!this._set(ni, 1)) return false;
            }
          }
          if (c < cols - 1) {
            const ni = idx + 1;
            if (this.cellStatus[ni] === 0 && !this.isWall[ni]) {
              if (!this._set(ni, 1)) return false;
            }
          }
        }
      }
      if (capacity === clue.size) {
        for (let ri = 0; ri < capacity; ri++) {
          const i = reachList[ri];
          if (this.cellStatus[i] === 0) {
            if (!this._set(i, 2)) return false;
          }
        }
      }
    }
    return true;
  }

  // For one clue, recursively enumerate connected supersets of its current
  // WHITE component of size exactly clue.size, drawing from {WHITE ∪
  // UNKNOWN} cells not blocked by BLACK / walls / other clue cells / cells
  // claimed by another clue. On each surviving shape, OR-mark inAny and
  // AND-mark inAll per cell. Returns { count, capped, infeasible }.
  _enumerateClueShapes(clue) {
    const N = this.N;
    const cols = this.cols, rows = this.rows;
    const isWall = this.isWall;
    const cellStatus = this.cellStatus;
    const task = this.task;
    const claimedBy = this._claimedBy;
    const inShape = this._shapeInShape;
    const inFrontier = this._shapeInFrontier;
    const stack = this._shapeStack;
    const frontier = this._shapeFrontier;
    const inAll = this._shapeInAll;
    const inAny = this._shapeInAny;

    inShape.fill(0);
    inFrontier.fill(0);
    inAll.fill(1);
    inAny.fill(0);

    let shapeSize = 0;
    let stackTop = 0;
    let frontierTop = 0;
    const seedQueue = this._bfsQueue;
    let qH = 0, qT = 0;
    inShape[clue.idx] = 1;
    stack[stackTop++] = clue.idx;
    shapeSize = 1;
    seedQueue[qT++] = clue.idx;
    while (qH < qT) {
      const idx = seedQueue[qH++];
      const r = (idx / cols) | 0;
      const c = idx - r * cols;
      const seedN = (ni) => {
        if (inShape[ni]) return;
        if (isWall[ni]) return;
        const v = cellStatus[ni];
        if (v === 1) return;
        if (task[ni] > 0 && ni !== clue.idx) return;
        const o = claimedBy[ni];
        if (o !== -1 && o !== clue.idx) return;
        if (v === 2) {
          inShape[ni] = 1;
          shapeSize++;
          stack[stackTop++] = ni;
          seedQueue[qT++] = ni;
        } else {
          if (!inFrontier[ni]) {
            inFrontier[ni] = 1;
            frontier[frontierTop++] = ni;
          }
        }
      };
      if (r > 0) seedN(idx - cols);
      if (r < rows - 1) seedN(idx + cols);
      if (c > 0) seedN(idx - 1);
      if (c < cols - 1) seedN(idx + 1);
    }
    if (shapeSize > clue.size) {
      return { count: 0, capped: false, infeasible: false };
    }

    const target = clue.size;
    const MAX = NurikabeSolver.MAX_SHAPES_PER_CLUE;
    let shapeCount = 0;
    let capped = false;

    const recordShape = () => {
      shapeCount++;
      for (let k = 0; k < stackTop; k++) inAny[stack[k]] = 1;
      if (shapeCount === 1) {
        for (let i = 0; i < N; i++) inAll[i] = inShape[i];
      } else {
        for (let i = 0; i < N; i++) {
          if (inAll[i] && !inShape[i]) inAll[i] = 0;
        }
      }
    };

    const recurse = () => {
      if (shapeCount >= MAX) { capped = true; return; }
      if (shapeSize === target) {
        if (this._shapeIsValid(clue)) recordShape();
        return;
      }
      const baseFrontierTop = frontierTop;
      const baseCells = [];
      for (let i = 0; i < baseFrontierTop; i++) {
        const f = frontier[i];
        if (!inShape[f]) baseCells.push(f);
      }
      for (let i = 0; i < baseCells.length; i++) {
        if (shapeCount >= MAX) { capped = true; break; }
        const cell = baseCells[i];
        if (inShape[cell]) continue;
        inShape[cell] = 1;
        stack[stackTop++] = cell;
        shapeSize++;
        const fAddedFrom = frontierTop;
        const rc = (cell / cols) | 0;
        const cc = cell - rc * cols;
        const addF = (ni) => {
          if (inShape[ni]) return;
          if (isWall[ni]) return;
          const v = cellStatus[ni];
          if (v === 1) return;
          if (task[ni] > 0 && ni !== clue.idx) return;
          const o = claimedBy[ni];
          if (o !== -1 && o !== clue.idx) return;
          if (inFrontier[ni]) return;
          inFrontier[ni] = 1;
          frontier[frontierTop++] = ni;
        };
        if (rc > 0) addF(cell - cols);
        if (rc < rows - 1) addF(cell + cols);
        if (cc > 0) addF(cell - 1);
        if (cc < cols - 1) addF(cell + 1);
        recurse();
        for (let k = fAddedFrom; k < frontierTop; k++) inFrontier[frontier[k]] = 0;
        frontierTop = fAddedFrom;
        shapeSize--;
        stackTop--;
        inShape[cell] = 0;
      }
    };

    if (shapeSize === target) {
      if (this._shapeIsValid(clue)) recordShape();
    } else {
      recurse();
    }

    for (let i = 0; i < frontierTop; i++) inFrontier[frontier[i]] = 0;
    for (let i = 0; i < stackTop; i++) inShape[stack[i]] = 0;

    return { count: shapeCount, capped, infeasible: shapeCount === 0 && !capped };
  }

  // Validate the current shape (cells with inShape === 1): the shape must
  // not extend into another clue's WHITE component, and the "forced-BLACK"
  // halo around the shape (UNKNOWN cells orthogonally adjacent but not
  // in the shape) must not, combined with existing BLACK/walls, form a
  // 2x2 all-BLACK block.
  _shapeIsValid(clue) {
    const cols = this.cols, rows = this.rows;
    const inShape = this._shapeInShape;
    const cellStatus = this.cellStatus;
    const claimedBy = this._claimedBy;
    const stack = this._shapeStack;
    const N = this.N;
    let stackTop = 0;
    for (let i = 0; i < N; i++) if (inShape[i]) stack[stackTop++] = i;
    for (let s = 0; s < stackTop; s++) {
      const idx = stack[s];
      const r = (idx / cols) | 0;
      const c = idx - r * cols;
      if (cellStatus[idx] !== 0) continue;
      // No-merge: an UNKNOWN cell in the shape may not be 4-adjacent to a
      // WHITE cell claimed by a different clue (placing this cell WHITE
      // would extend our island into the other clue's component).
      const check = (ni) => {
        if (cellStatus[ni] === 2 && claimedBy[ni] !== -1 && claimedBy[ni] !== clue.idx) {
          return false;
        }
        return true;
      };
      if (r > 0 && !check(idx - cols)) return false;
      if (r < rows - 1 && !check(idx + cols)) return false;
      if (c > 0 && !check(idx - 1)) return false;
      if (c < cols - 1 && !check(idx + 1)) return false;
    }
    return true;
  }

  // Main rule. For each clue ≤ MAX_ENUMERATED_CLUE_SIZE, enumerate valid
  // shapes; force WHITE on cells present in every surviving shape (inAll).
  // Cross-clue BLACK exclusion is added in Task 5.
  _applyShapeEnumeration() {
    if (!this._dirtyShape) return true;
    this._dirtyShape = false;
    const couldBeWhite = this._shapeCouldBeWhite;
    couldBeWhite.fill(0);
    // Track which clues contribute usable cross-exclusion signal. A clue
    // is "useful" iff size ≤ cap AND its enumeration did NOT hit the
    // per-clue shape cap. Capped / oversized clues have an incomplete (or
    // empty) catalog, so we must NOT exclude cells in their Manhattan
    // reach from couldBeWhite — doing so would force them BLACK unsoundly.
    const clueUseful = new Uint8Array(this.clues.length);
    for (let ci = 0; ci < this.clues.length; ci++) {
      const clue = this.clues[ci];
      if (this._timeUp()) return true;
      if (clue.size > NurikabeSolver.MAX_ENUMERATED_CLUE_SIZE) continue;
      const { count, capped, infeasible } = this._enumerateClueShapes(clue);
      if (capped) continue;
      if (infeasible) return false;
      if (count === 0) continue;
      clueUseful[ci] = 1;
      for (let i = 0; i < this.N; i++) {
        if (this._shapeInAll[i] && this.cellStatus[i] === 0) {
          if (!this._set(i, 2)) return false;
        }
        if (this._shapeInAny[i]) couldBeWhite[i] = 1;
      }
    }
    // Cross-clue exclusion. _bfsReachable holds the union of clue reaches
    // computed by _applyUnreachable; couldBeWhite holds the union of cells
    // that appeared in at least one enumerated shape across all clues.
    // Any UNKNOWN cell in the reach union but with couldBeWhite[i] === 0
    // must be BLACK — no clue can claim it for an island.
    const reachUnion = this._bfsReachable;
    for (let i = 0; i < this.N; i++) {
      if (this.cellStatus[i] !== 0) continue;
      if (this.isWall[i]) continue;
      if (!reachUnion[i]) continue;
      if (couldBeWhite[i]) continue;
      const r = (i / this.cols) | 0;
      const c = i - r * this.cols;
      // Force BLACK only if every clue whose Manhattan reach includes this
      // cell contributed usable cross-exclusion signal. If any
      // unenumerable or capped clue can reach the cell, its shape catalog
      // is empty or incomplete, so we can't conclude the cell isn't in
      // its island.
      let hasReachableUseful = false;
      let hasReachableUnusable = false;
      for (let cj = 0; cj < this.clues.length; cj++) {
        const clue = this.clues[cj];
        const cr = (clue.idx / this.cols) | 0;
        const cc = clue.idx - cr * this.cols;
        if (Math.abs(cr - r) + Math.abs(cc - c) > clue.size - 1) continue;
        if (!clueUseful[cj]) {
          hasReachableUnusable = true;
          break;
        }
        hasReachableUseful = true;
      }
      if (hasReachableUnusable) continue;
      if (!hasReachableUseful) continue;
      if (!this._set(i, 1)) return false;
    }
    return true;
  }

  _apply2x2() {
    for (let r = 0; r + 1 < this.rows; r++) {
      for (let c = 0; c + 1 < this.cols; c++) {
        const a = r * this.cols + c;
        const cells = [a, a + 1, a + this.cols, a + this.cols + 1];
        // Any wall in the 2x2 disables the constraint (the rule requires 4
        // black on-board cells; walls are off-board).
        let hasWall = false;
        for (const ci of cells) if (this.isWall[ci]) { hasWall = true; break; }
        if (hasWall) continue;
        let nB = 0, nU = 0;
        for (const ci of cells) {
          if (this.cellStatus[ci] === 1) nB++;
          else if (this.cellStatus[ci] === 0) nU++;
        }
        if (nB === 4) return false;
        if (nB === 3 && nU === 1) {
          for (const ci of cells) {
            if (this.cellStatus[ci] === 0) {
              if (!this._set(ci, 2)) return false;
            }
          }
        }
      }
    }
    return true;
  }

  _applyBlackCount() {
    let nB = 0, nU = 0;
    for (let i = 0; i < this.N; i++) {
      if (this.isWall[i]) continue;
      if (this.cellStatus[i] === 1) nB++;
      else if (this.cellStatus[i] === 0) nU++;
    }
    if (nB > this.expectedBlacks) return false;
    if (nB + nU < this.expectedBlacks) return false;
    if (nB === this.expectedBlacks && nU > 0) {
      for (let i = 0; i < this.N; i++) {
        if (this.isWall[i]) continue;
        if (this.cellStatus[i] === 0) {
          if (!this._set(i, 2)) return false;
        }
      }
    } else if (nB + nU === this.expectedBlacks && nU > 0) {
      for (let i = 0; i < this.N; i++) {
        if (this.isWall[i]) continue;
        if (this.cellStatus[i] === 0) {
          if (!this._set(i, 1)) return false;
        }
      }
    }
    return true;
  }

  // Populate `_claimedBy[i] = clue.idx` for every WHITE cell reachable
  // from `clue` via a path of WHITE cells (blocked by BLACK, walls, and
  // other clue cells). Returns false if a WHITE cell would be claimed by
  // two different clues (an island holding two clues — unsat).
  _buildClaimedBy() {
    const claimedBy = this._claimedBy;
    claimedBy.fill(-1);
    const queue = this._bfsQueue;
    const cols = this.cols, rows = this.rows;
    for (const clue of this.clues) {
      claimedBy[clue.idx] = clue.idx;
      let qHead = 0, qTail = 0;
      queue[qTail++] = clue.idx;
      while (qHead < qTail) {
        const idx = queue[qHead++];
        const r = (idx / cols) | 0;
        const c = idx - r * cols;
        const visit = (ni) => {
          if (this.isWall[ni]) return true;
          if (this.cellStatus[ni] !== 2) return true;
          if (this.task[ni] > 0 && ni !== clue.idx) return true;
          if (claimedBy[ni] === clue.idx) return true;
          if (claimedBy[ni] !== -1) return false; // two clues claim this WHITE cell
          claimedBy[ni] = clue.idx;
          queue[qTail++] = ni;
          return true;
        };
        if (r > 0 && !visit(idx - cols)) return false;
        if (r < rows - 1 && !visit(idx + cols)) return false;
        if (c > 0 && !visit(idx - 1)) return false;
        if (c < cols - 1 && !visit(idx + 1)) return false;
      }
    }
    return true;
  }

  // For each UNKNOWN cell, count how many distinct clue-owned WHITE
  // components touch it. ≥2 → cell must be BLACK (going WHITE would merge
  // two islands).
  _applyIslandMerge() {
    const claimedBy = this._claimedBy;
    const cols = this.cols, rows = this.rows;
    for (let i = 0; i < this.N; i++) {
      if (this.isWall[i]) continue;
      if (this.cellStatus[i] !== 0) continue;
      const r = (i / cols) | 0;
      const c = i - r * cols;
      let firstOwner = -1, secondOwner = -1;
      const check = (ni) => {
        const o = claimedBy[ni];
        if (o < 0) return;
        if (firstOwner < 0) { firstOwner = o; return; }
        if (o !== firstOwner) secondOwner = o;
      };
      if (r > 0) check(i - cols);
      if (r < rows - 1) check(i + cols);
      if (c > 0) check(i - 1);
      if (c < cols - 1) check(i + 1);
      if (secondOwner >= 0) {
        if (!this._set(i, 1)) return false;
      }
    }
    return true;
  }

  // For each clue with WHITE-component size S < N, find the UNKNOWN
  // frontier of that component (cells adjacent to a member but not in it).
  // 0 frontier cells → island cannot grow (contradiction). 1 frontier cell
  // → that cell must be WHITE (only way for the island to reach N).
  _applyFrontierForce() {
    const visited = this._bfsVisited;
    const queue = this._bfsQueue;
    const claimedBy = this._claimedBy;
    const isWall = this.isWall;
    const cellStatus = this.cellStatus;
    const task = this.task;
    const cols = this.cols, rows = this.rows;
    for (const clue of this.clues) {
      visited.fill(0);
      let qHead = 0, qTail = 0;
      visited[clue.idx] = 1;
      queue[qTail++] = clue.idx;
      let size = 1;
      let frontierCount = 0;
      let frontierIdx = -1;
      while (qHead < qTail) {
        const idx = queue[qHead++];
        const r = (idx / cols) | 0;
        const c = idx - r * cols;
        const visitN = (ni) => {
          if (visited[ni]) return;
          if (isWall[ni]) return;
          const v = cellStatus[ni];
          if (v === 1) return;
          if (task[ni] > 0 && ni !== clue.idx) return;
          const o = claimedBy[ni];
          if (o !== -1 && o !== clue.idx) return;
          if (v === 2) {
            visited[ni] = 1;
            size++;
            queue[qTail++] = ni;
          } else {
            visited[ni] = 2;
            if (frontierCount === 0) frontierIdx = ni;
            frontierCount++;
          }
        };
        if (r > 0) visitN(idx - cols);
        if (r < rows - 1) visitN(idx + cols);
        if (c > 0) visitN(idx - 1);
        if (c < cols - 1) visitN(idx + 1);
      }
      if (size >= clue.size) continue;
      if (frontierCount === 0) return false;
      if (frontierCount === 1) {
        if (!this._set(frontierIdx, 2)) return false;
      }
    }
    return true;
  }

  _applySeaConnectivity() {
    if (this._inLookahead) return true;
    let firstBlack = -1, blackCount = 0;
    for (let i = 0; i < this.N; i++) {
      if (this.cellStatus[i] === 1) {
        if (firstBlack < 0) firstBlack = i;
        blackCount++;
      }
    }
    if (firstBlack < 0) return true;
    const visited = this._bfsVisited;
    visited.fill(0);
    const queue = this._bfsQueue;
    let qHead = 0, qTail = 0;
    visited[firstBlack] = 1;
    queue[qTail++] = firstBlack;
    let blacksSeen = 1;
    const cols = this.cols, rows = this.rows;
    while (qHead < qTail) {
      const idx = queue[qHead++];
      const r = (idx / cols) | 0;
      const c = idx - r * cols;
      if (r > 0) {
        const ni = idx - cols;
        if (!visited[ni] && !this.isWall[ni] && this.cellStatus[ni] !== 2) {
          visited[ni] = 1;
          if (this.cellStatus[ni] === 1) blacksSeen++;
          queue[qTail++] = ni;
        }
      }
      if (r < rows - 1) {
        const ni = idx + cols;
        if (!visited[ni] && !this.isWall[ni] && this.cellStatus[ni] !== 2) {
          visited[ni] = 1;
          if (this.cellStatus[ni] === 1) blacksSeen++;
          queue[qTail++] = ni;
        }
      }
      if (c > 0) {
        const ni = idx - 1;
        if (!visited[ni] && !this.isWall[ni] && this.cellStatus[ni] !== 2) {
          visited[ni] = 1;
          if (this.cellStatus[ni] === 1) blacksSeen++;
          queue[qTail++] = ni;
        }
      }
      if (c < cols - 1) {
        const ni = idx + 1;
        if (!visited[ni] && !this.isWall[ni] && this.cellStatus[ni] !== 2) {
          visited[ni] = 1;
          if (this.cellStatus[ni] === 1) blacksSeen++;
          queue[qTail++] = ni;
        }
      }
    }
    return blacksSeen === blackCount;
  }

  // For each UNKNOWN cell that is an articulation point in the
  // {BLACK ∪ UNKNOWN} \ walls graph, verify removing it strands at least
  // one BLACK component from another. If so, the cell must be BLACK —
  // otherwise the final sea (which must be a single component) would be
  // disconnected. Skipped during lookahead (cheaper rules handle that
  // path).
  _applySeaArticulation() {
    if (this._inLookahead) return true;
    const N = this.N;
    const cols = this.cols, rows = this.rows;
    const isWall = this.isWall;
    const cellStatus = this.cellStatus;

    let firstBlack = -1;
    let blackCount = 0;
    for (let i = 0; i < N; i++) {
      if (cellStatus[i] === 1) {
        if (firstBlack < 0) firstBlack = i;
        blackCount++;
      }
    }
    if (firstBlack < 0 || blackCount < 2) return true;

    const disc = new Int32Array(N).fill(-1);
    const low = new Int32Array(N).fill(-1);
    const parent = new Int32Array(N).fill(-1);
    const isArt = new Uint8Array(N);
    const stack = new Int32Array(N);
    const childIter = new Int32Array(N);
    let timer = 0;

    const passable = (i) => !isWall[i] && (cellStatus[i] === 1 || cellStatus[i] === 0);

    let sp = 0;
    stack[sp++] = firstBlack;
    disc[firstBlack] = low[firstBlack] = timer++;
    let rootChildren = 0;

    while (sp > 0) {
      const u = stack[sp - 1];
      const ci = childIter[u]++;
      const r = (u / cols) | 0;
      const c = u - r * cols;
      let v = -1;
      if (ci === 0 && r > 0) v = u - cols;
      else if (ci === 1 && r < rows - 1) v = u + cols;
      else if (ci === 2 && c > 0) v = u - 1;
      else if (ci === 3 && c < cols - 1) v = u + 1;

      if (ci >= 4) {
        sp--;
        const p = parent[u];
        if (p >= 0) {
          if (low[u] < low[p]) low[p] = low[u];
          if (low[u] >= disc[p] && parent[p] !== -1) isArt[p] = 1;
        }
        continue;
      }
      if (v < 0 || !passable(v)) continue;
      if (disc[v] === -1) {
        parent[v] = u;
        disc[v] = low[v] = timer++;
        stack[sp++] = v;
        if (u === firstBlack) rootChildren++;
      } else if (v !== parent[u]) {
        if (disc[v] < low[u]) low[u] = disc[v];
      }
    }
    if (rootChildren > 1) isArt[firstBlack] = 1;

    const visited = this._bfsVisited;
    const queue = this._bfsQueue;
    for (let u = 0; u < N; u++) {
      if (!isArt[u]) continue;
      if (cellStatus[u] !== 0) continue;
      visited.fill(0);
      let qH = 0, qT = 0;
      if (u === firstBlack) continue;
      visited[u] = 1;
      visited[firstBlack] = 1;
      queue[qT++] = firstBlack;
      let seen = (cellStatus[firstBlack] === 1) ? 1 : 0;
      while (qH < qT) {
        const idx = queue[qH++];
        const rr = (idx / cols) | 0;
        const cc = idx - rr * cols;
        const tryN = (ni) => {
          if (visited[ni]) return;
          if (isWall[ni]) return;
          const v = cellStatus[ni];
          if (v === 2) return;
          visited[ni] = 1;
          if (v === 1) seen++;
          queue[qT++] = ni;
        };
        if (rr > 0) tryN(idx - cols);
        if (rr < rows - 1) tryN(idx + cols);
        if (cc > 0) tryN(idx - 1);
        if (cc < cols - 1) tryN(idx + 1);
      }
      if (seen < blackCount) {
        if (!this._set(u, 1)) return false;
      }
    }
    return true;
  }

  _propagate() {
    if (!this._propagateFixpointOnly()) return false;
    if (this._depth === 0 && !this._inLookahead) {
      if (!this._applyShapeEnumeration()) return false;
      if (this._dirtyShape) {
        // Shape enumeration changed state — re-run cheaper fixpoint.
        if (!this._propagateFixpointOnly()) return false;
      }
      if (!this._applyLookahead()) return false;
    }
    return true;
  }

  _propagateFixpointOnly() {
    let changed = true;
    while (changed) {
      if (this._timeUp()) return true;
      changed = false;
      const mark = this.trail.length;
      if (!this._applyClueAdjacency()) return false;
      if (!this._buildClaimedBy()) return false;
      if (!this._applyIslandMerge()) return false;
      if (!this._applyFrontierForce()) return false;
      if (!this._applyUnreachable()) return false;
      if (!this._applyIslandComplete()) return false;
      if (!this._apply2x2()) return false;
      if (!this._applySeaConnectivity()) return false;
      if (!this._applySeaArticulation()) return false;
      if (!this._applyBlackCount()) return false;
      if (this.trail.length > mark) changed = true;
    }
    return true;
  }

  _applyLookahead() {
    let changed = true;
    while (changed) {
      if (this._timeUp()) return true;
      changed = false;
      for (let i = 0; i < this.N; i++) {
        if (this.isWall[i]) continue;
        if (this.cellStatus[i] !== 0) continue;
        const survivors = [];
        for (const v of [1, 2]) {
          const mark = this.trail.length;
          this._inLookahead = true;
          this._depth++;
          const okSet = this._set(i, v);
          const ok = okSet && this._propagate();
          this._depth--;
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
    for (let i = 0; i < this.N; i++) {
      if (this.isWall[i]) continue;
      if (this.cellStatus[i] === 0) return false;
    }
    return true;
  }

  _emit() {
    const grid = [];
    for (let r = 0; r < this.rows; r++) {
      const row = new Array(this.cols);
      for (let c = 0; c < this.cols; c++) row[c] = this.cellStatus[r * this.cols + c];
      grid.push(row);
    }
    return grid;
  }

  _pickBestUnknown() {
    let bestIdx = -1, bestScore = -1;
    const claimedBy = this._claimedBy;
    // Find the clue with the smallest positive remaining N - S so we can
    // bias toward closing it out. _bfsClueIsland returns { size, capacity }
    // — we only need size here.
    let smallestRemaining = Infinity;
    let smallestClueIdx = -1;
    let smallestClueSize = 0;
    for (const clue of this.clues) {
      const { size } = this._bfsClueIsland(clue);
      const rem = clue.size - size;
      if (rem > 0 && rem < smallestRemaining) {
        smallestRemaining = rem;
        smallestClueIdx = clue.idx;
        smallestClueSize = clue.size;
      }
    }
    for (let i = 0; i < this.N; i++) {
      if (this.isWall[i]) continue;
      if (this.cellStatus[i] !== 0) continue;
      const r = (i / this.cols) | 0;
      const c = i - r * this.cols;
      let score = 0;
      // Known/wall 4-neighbours
      if (r > 0 && (this.isWall[i - this.cols] || this.cellStatus[i - this.cols] !== 0)) score++;
      if (r < this.rows - 1 && (this.isWall[i + this.cols] || this.cellStatus[i + this.cols] !== 0)) score++;
      if (c > 0 && (this.isWall[i - 1] || this.cellStatus[i - 1] !== 0)) score++;
      if (c < this.cols - 1 && (this.isWall[i + 1] || this.cellStatus[i + 1] !== 0)) score++;
      // Adjacent to any claimed WHITE cell — +2
      const adjClaimed =
        (r > 0 && claimedBy[i - this.cols] >= 0) ||
        (r < this.rows - 1 && claimedBy[i + this.cols] >= 0) ||
        (c > 0 && claimedBy[i - 1] >= 0) ||
        (c < this.cols - 1 && claimedBy[i + 1] >= 0);
      if (adjClaimed) score += 2;
      // In Manhattan reach of exactly one clue — +3
      let reachingClues = 0;
      for (const clue of this.clues) {
        const cr = (clue.idx / this.cols) | 0;
        const cc = clue.idx - cr * this.cols;
        if (Math.abs(cr - r) + Math.abs(cc - c) <= clue.size - 1) {
          reachingClues++;
          if (reachingClues > 1) break;
        }
      }
      if (reachingClues === 1) score += 3;
      // In Manhattan reach of the smallest-remaining clue — +5
      if (smallestClueIdx >= 0) {
        const cr = (smallestClueIdx / this.cols) | 0;
        const cc = smallestClueIdx - cr * this.cols;
        if (Math.abs(cr - r) + Math.abs(cc - c) <= smallestClueSize - 1) score += 5;
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
    const cached = NurikabeSolver._solutionCache.get(key)
                || NurikabeSolver._partialCache.get(key);
    if (cached) return this._cloneResult(cached);
    this._startedAt = Date.now();
    let result;
    if (this.contradiction) {
      result = { solved: false, grid: null };
    } else if (!this._propagate()) {
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
    NurikabeSolver._solutionCache.clear();
    NurikabeSolver._partialCache.clear();
  }

  _cacheKey() {
    let h = 0x811c9dc5;
    const mix = (n) => { h ^= n & 0xff; h = Math.imul(h, 0x01000193) >>> 0; };
    mix(this.rows); mix(this.cols);
    for (let i = 0; i < this.N; i++) {
      const v = this.task[i];
      mix(v & 0xff);
      mix((v >>> 8) & 0xff);
    }
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
    const m = result.partial ? NurikabeSolver._partialCache : NurikabeSolver._solutionCache;
    const max = result.partial ? NurikabeSolver._maxPartialCache : NurikabeSolver._maxSolutionCache;
    if (m.size >= max) {
      const first = m.keys().next().value;
      m.delete(first);
    }
    m.set(key, this._cloneResult(result));
  }

  getHint(initialState) {
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        this.cellStatus[r * this.cols + c] = initialState[r][c];
      }
    }
    // Re-assert clue cells as WHITE (value 2). The page doesn't track clue
    // cells in cellStatus, so initialState always has them as UNKNOWN (0)
    // even when the puzzle is mid-solve. Without this re-assert, the
    // propagation rules (e.g. sea-connectivity) can deduce clue cells as
    // BLACK and the hint output targets cells the page won't accept —
    // Loop applies the no-op move forever (caught in 5x5-easy regression).
    for (const clue of this.clues) {
      this.cellStatus[clue.idx] = 2;
    }
    const before = new Uint8Array(this.N);
    for (let i = 0; i < this.N; i++) before[i] = this.cellStatus[i];
    this.trail = [];
    this._depth = 0;
    this._inLookahead = false;
    this._startedAt = Date.now();

    const collectChanged = () => {
      const out = [];
      for (let i = 0; i < this.N; i++) {
        if (before[i] === 0 && this.cellStatus[i] !== 0) {
          const r = (i / this.cols) | 0;
          const c = i - r * this.cols;
          out.push({ row: r, col: c, value: this.cellStatus[i] });
        }
      }
      return out;
    };

    const rules = [
      () => this._applyClueAdjacency(),
      () => { return this._buildClaimedBy() && this._applyIslandMerge(); },
      () => this._applyFrontierForce(),
      () => this._applyUnreachable(),
      () => this._applyIslandComplete(),
      () => this._apply2x2(),
      () => this._applySeaConnectivity(),
      () => this._applySeaArticulation(),
      () => this._applyBlackCount(),
      () => this._applyShapeEnumeration(),
    ];
    for (const rule of rules) {
      if (!rule()) return null;
      const h = collectChanged();
      if (h.length) return h;
    }

    for (let i = 0; i < this.N; i++) {
      if (this.isWall[i]) continue;
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { NurikabeSolver };
}
