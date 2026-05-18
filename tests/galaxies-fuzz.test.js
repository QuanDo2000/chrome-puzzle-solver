// Property-style cross-check of GalaxiesSolver against a brute-force oracle.
//
// For each random small puzzle we enumerate every valid galaxy partition by
// recursion + 180° mirror symmetry, then assert:
//   - if the oracle finds >=1 solution, the solver must return one of them
//   - if the oracle finds 0 solutions, the solver must report solved:false
//
// Keep grids tiny (<=4x4): the oracle is exponential in cell count, and
// GalaxiesSolver has a static solution cache we clear between trials.

const test = require('node:test');
const assert = require('node:assert/strict');
const { GalaxiesSolver } = require('../solver.js');

// PRNG with explicit seed for reproducibility.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// Star coords are in doubled coords: 0..2R-2 by 0..2C-2. Picks K distinct
// stars. Most outputs will be unsolvable — that exercises the failure path.
function randomPuzzle(rand, R, C, K) {
  const used = new Set();
  const stars = [];
  let tries = 0;
  while (stars.length < K && tries++ < 200) {
    const sr = Math.floor(rand() * (2 * R - 1));
    const sc = Math.floor(rand() * (2 * C - 1));
    const key = sr * 1000 + sc;
    if (used.has(key)) continue;
    used.add(key);
    stars.push({ row: sr, col: sc });
  }
  return { stars, rows: R, cols: C };
}

// Constructive generator: tile the grid with random rectangles, place a star
// at each rectangle's center. This guarantees a solvable puzzle (the tiling
// itself is a valid solution), so the solver MUST find some answer — though
// not necessarily this exact tiling, since other valid partitions can exist.
function constructiveSolvablePuzzle(rand, R, C) {
  const filled = Array.from({ length: R }, () => new Array(C).fill(false));
  const stars = [];
  const sizes = [[1, 1], [1, 2], [2, 1], [2, 2], [1, 3], [3, 1]];
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      if (filled[r][c]) continue;
      const shuffled = sizes.slice().sort(() => rand() - 0.5);
      for (const [h, w] of shuffled) {
        if (r + h > R || c + w > C) continue;
        let blocked = false;
        for (let dr = 0; dr < h && !blocked; dr++) {
          for (let dc = 0; dc < w; dc++) {
            if (filled[r + dr][c + dc]) { blocked = true; break; }
          }
        }
        if (blocked) continue;
        for (let dr = 0; dr < h; dr++) for (let dc = 0; dc < w; dc++) filled[r + dr][c + dc] = true;
        stars.push({ row: 2 * r + h - 1, col: 2 * c + w - 1 });
        break;
      }
    }
  }
  return { stars, rows: R, cols: C };
}

// Returns null if cell is outside the grid; otherwise the mirror cell coords.
function mirrorCell(r, c, star) {
  return { r: star.row - r, c: star.col - c };
}

// Enumerate every valid assignment by greedy orbit-pair recursion.
// `assign[r][c]` is the star index (-1 if unfilled). At each cell we either
// skip (already filled by an earlier mirror placement) or try each star whose
// mirror cell is still consistent.
function bruteForceSolutions(stars, R, C) {
  const K = stars.length;
  const assign = Array.from({ length: R }, () => new Array(C).fill(-1));
  const solutions = [];
  const cellOrder = [];
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) cellOrder.push([r, c]);

  function regionsValid() {
    const counts = new Array(K).fill(0);
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) counts[assign[r][c]]++;
    for (let i = 0; i < K; i++) if (counts[i] === 0) return false;
    const seen = Array.from({ length: R }, () => new Array(C).fill(false));
    for (let i = 0; i < K; i++) {
      let startR = -1, startC = -1;
      for (let r = 0; r < R && startR < 0; r++) {
        for (let c = 0; c < C; c++) {
          if (assign[r][c] === i) { startR = r; startC = c; break; }
        }
      }
      const queue = [[startR, startC]];
      seen[startR][startC] = true;
      let visited = 0;
      while (queue.length) {
        const [r, c] = queue.shift();
        visited++;
        for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nr = r + dr, nc = c + dc;
          if (nr < 0 || nr >= R || nc < 0 || nc >= C) continue;
          if (seen[nr][nc] || assign[nr][nc] !== i) continue;
          seen[nr][nc] = true;
          queue.push([nr, nc]);
        }
      }
      if (visited !== counts[i]) return false;
    }
    return true;
  }

  function recurse(idx) {
    if (solutions.length > 32) return;
    if (idx === cellOrder.length) {
      if (regionsValid()) solutions.push(assign.map(row => row.slice()));
      return;
    }
    const [r, c] = cellOrder[idx];
    if (assign[r][c] !== -1) { recurse(idx + 1); return; }
    for (let s = 0; s < K; s++) {
      const m = mirrorCell(r, c, stars[s]);
      if (m.r < 0 || m.r >= R || m.c < 0 || m.c >= C) continue;
      const prev = assign[m.r][m.c];
      if (prev !== -1 && prev !== s) continue;
      assign[r][c] = s;
      const mirrorWasFree = prev === -1;
      if (mirrorWasFree) assign[m.r][m.c] = s;
      recurse(idx + 1);
      assign[r][c] = -1;
      if (mirrorWasFree) assign[m.r][m.c] = -1;
    }
  }
  recurse(0);
  return solutions;
}

function solutionsEqual(a, b) {
  for (let r = 0; r < a.length; r++) {
    for (let c = 0; c < a[r].length; c++) {
      if (a[r][c] !== b[r][c]) return false;
    }
  }
  return true;
}

function runTrial(seed, R, C, K, mode = 'random') {
  GalaxiesSolver.clearSolutionCache();
  const rand = rng(seed);
  const puzzle = mode === 'constructive'
    ? constructiveSolvablePuzzle(rand, R, C)
    : randomPuzzle(rand, R, C, K);
  if (mode === 'random' && puzzle.stars.length < K) return { skipped: true };

  const oracle = bruteForceSolutions(puzzle.stars, R, C);
  const solver = new GalaxiesSolver(puzzle.stars, R, C);
  const result = solver.solve(null);

  if (oracle.length === 0) {
    assert.equal(result.solved, false,
      `seed=${seed}: oracle has no solution but solver returned solved=true. ` +
      `stars=${JSON.stringify(puzzle.stars)}`);
    return { oracle: 0, solver: result.solved };
  }

  assert.equal(result.solved, true,
    `seed=${seed}: oracle found ${oracle.length} solution(s) but solver failed. ` +
    `stars=${JSON.stringify(puzzle.stars)}`);

  // Solver returns 1-indexed star IDs in result.grid; oracle uses 0-indexed.
  const solverGrid = result.grid.map(row => row.map(v => v - 1));
  const matched = oracle.some(sol => solutionsEqual(sol, solverGrid));
  assert.ok(matched,
    `seed=${seed}: solver returned a grid not in the oracle's set of ${oracle.length}. ` +
    `stars=${JSON.stringify(puzzle.stars)}, solver=${JSON.stringify(solverGrid)}`);
  return { oracle: oracle.length, solver: result.solved };
}

test('GalaxiesSolver: fuzz 3x3 with 2 stars (50 trials)', () => {
  for (let seed = 1; seed <= 50; seed++) runTrial(seed, 3, 3, 2);
});

test('GalaxiesSolver: fuzz 3x3 with 3 stars (40 trials)', () => {
  for (let seed = 100; seed <= 139; seed++) runTrial(seed, 3, 3, 3);
});

test('GalaxiesSolver: fuzz 4x4 with 2 stars (30 trials)', () => {
  for (let seed = 200; seed <= 229; seed++) runTrial(seed, 4, 4, 2);
});

test('GalaxiesSolver: fuzz 4x4 with 3 stars (20 trials)', () => {
  for (let seed = 300; seed <= 319; seed++) runTrial(seed, 4, 4, 3);
});

test('GalaxiesSolver: constructive solvable 3x3 (30 trials)', () => {
  for (let seed = 400; seed <= 429; seed++) runTrial(seed, 3, 3, null, 'constructive');
});

test('GalaxiesSolver: constructive solvable 4x4 (30 trials)', () => {
  for (let seed = 500; seed <= 529; seed++) runTrial(seed, 4, 4, null, 'constructive');
});
