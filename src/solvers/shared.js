'use strict';

// Shared, dependency-free helpers for the solver layer. Concatenated FIRST
// into dist/solver.js by scripts/build-solver-bundle.js. Consumer files import
// these helpers via a relative require of this module, which the bundler
// strips (in the bundle the helpers are already top-level globals). See
// docs/superpowers/specs/2026-05-29-solver-shared-utils-design.md.

// FNV-1a 32-bit hash. Callers feed bytes via the `mix` callback so each
// call site keeps its own byte sequence; this preserves byte-identical keys
// versus the previous per-solver inline implementations.
function hashFNV1a(feed, mask = true) {
  let h = 0x811c9dc5;
  const mix = mask
    ? (n) => { h ^= n & 0xff; h = Math.imul(h, 0x01000193) >>> 0; }
    : (n) => { h ^= n; h = Math.imul(h, 0x01000193) >>> 0; };
  feed(mix);
  return h >>> 0;
}

// Rebuild a 1-D cellStatus array into a rows×cols 2-D grid (the shape every
// grid solver's _emit() returns).
function emitGrid(cellStatus, rows, cols) {
  const grid = [];
  for (let r = 0; r < rows; r++) {
    const row = new Array(cols);
    for (let c = 0; c < cols; c++) row[c] = cellStatus[r * cols + c];
    grid.push(row);
  }
  return grid;
}

// Deep-clone a grid solve result (grid deep-copied, solved/error/partial
// preserved). Matches every grid solver's _cloneResult.
function cloneSolveResult(r) {
  return {
    solved: r.solved,
    grid: r.grid ? r.grid.map(row => row.slice()) : null,
    ...(r.error !== undefined ? { error: r.error } : {}),
    ...(r.partial !== undefined ? { partial: r.partial } : {}),
  };
}

// Soft wall-clock budget check. maxMs <= 0 means unlimited.
function timeUp(maxMs, startedAt) {
  if (maxMs <= 0) return false;
  return (Date.now() - startedAt) > maxMs;
}

// Insertion-order LRU set: evict the oldest entry when at capacity, then set.
// (Map preserves insertion order, so keys().next() is the oldest.)
function lruSet(map, maxSize, key, value) {
  if (map.size >= maxSize) {
    map.delete(map.keys().next().value);
  }
  map.set(key, value);
}

// Tarjan articulation-point connectivity check for white cells (cellStatus 2=white, 1=black, 0=unknown).
// Phase A: BFS verifies every known white is reachable through {white ∪ unknown}.
// Phase B (skipped in lookahead): iterative Tarjan DFS identifies unknown articulation cells
// that would disconnect known whites, and forces them white via set(idx, 2).
function whiteConnectivity(cellStatus, rows, cols, inLookahead, set) {
  const total = rows * cols;
  let anchor = -1;
  for (let i = 0; i < total; i++) {
    if (cellStatus[i] === 2) { anchor = i; break; }
  }
  if (anchor < 0) return true;
  const visited = new Uint8Array(total);
  visited[anchor] = 1;
  const stack = [anchor];
  while (stack.length) {
    const u = stack.pop();
    const r = (u / cols) | 0;
    const c = u - r * cols;
    const ns = [];
    if (r > 0) ns.push(u - cols);
    if (r < rows - 1) ns.push(u + cols);
    if (c > 0) ns.push(u - 1);
    if (c < cols - 1) ns.push(u + 1);
    for (let i = 0; i < ns.length; i++) {
      const ni = ns[i];
      if (!visited[ni] && cellStatus[ni] !== 1) { visited[ni] = 1; stack.push(ni); }
    }
  }
  for (let i = 0; i < total; i++) {
    if (cellStatus[i] === 2 && !visited[i]) return false;
  }
  if (inLookahead) return true;
  const disc = new Int32Array(total).fill(-1);
  const low = new Int32Array(total);
  const parent = new Int32Array(total).fill(-1);
  const subtreeKnownWhite = new Int32Array(total);
  const articulationSplits = new Int32Array(total);
  let timer = 0;
  const dfsStack = [];
  const neighboursOf = (u) => {
    const r = (u / cols) | 0;
    const c = u - r * cols;
    const ns = [];
    if (r > 0) { const ni = u - cols; if (cellStatus[ni] !== 1) ns.push(ni); }
    if (r < rows - 1) { const ni = u + cols; if (cellStatus[ni] !== 1) ns.push(ni); }
    if (c > 0) { const ni = u - 1; if (cellStatus[ni] !== 1) ns.push(ni); }
    if (c < cols - 1) { const ni = u + 1; if (cellStatus[ni] !== 1) ns.push(ni); }
    return ns;
  };
  disc[anchor] = low[anchor] = timer++;
  subtreeKnownWhite[anchor] = (cellStatus[anchor] === 2 ? 1 : 0);
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
      subtreeKnownWhite[v] = (cellStatus[v] === 2 ? 1 : 0);
      if (u === anchor) rootChildCount++;
      dfsStack.push({ u: v, ns: neighboursOf(v), idx: 0 });
    } else if (v !== parent[u]) {
      if (disc[v] < low[u]) low[u] = disc[v];
    }
  }
  const totalKnownWhites = subtreeKnownWhite[anchor];
  for (let u = 0; u < total; u++) {
    if (cellStatus[u] !== 0) continue;
    if (disc[u] < 0) continue;
    let critical = false;
    if (u === anchor) {
      critical = (rootChildCount >= 2 && articulationSplits[u] >= 2);
    } else {
      const restWhites = totalKnownWhites - subtreeKnownWhite[u];
      critical = (articulationSplits[u] >= 1 && restWhites >= 1);
    }
    if (critical) {
      if (!set(u, 2)) return false;
    }
  }
  return true;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { hashFNV1a, emitGrid, cloneSolveResult, timeUp, lruSet, whiteConnectivity };
}
