// Property-style cross-check of AquariumSolver against a brute-force oracle.
//
// Aquarium rule recap: a grid is partitioned into regions ("aquariums").
// Within each region, water obeys gravity — if any cell at row r is water,
// every cell of the same region at row >= r is also water. So each region's
// state is one integer "water level" in [0, maxLvl], where maxLvl is the
// number of distinct rows the region spans. The oracle enumerates every
// (level_1, ..., level_K) tuple and keeps those whose row/col water counts
// match the clues.
//
// Strategy mirrors tests/galaxies-fuzz.test.js:
//   - constructive trials: pick a random region map + random water levels,
//     derive clues from the resulting grid (guaranteed solvable). Solver
//     must return a grid in the oracle's solution set.
//   - random-clue trials: same region map but with random clues (usually
//     unsolvable). Solver must report solved:false iff oracle is empty.

const test = require('node:test');
const assert = require('node:assert/strict');
const { AquariumSolver } = require('../solver.js');

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// Build a connected region partition by BFS growth from K random seed cells.
// May produce slightly fewer than K regions if seeds are unreachable; that's
// fine — we use whatever K' comes out.
function randomRegionMap(rand, R, C, targetK) {
  const map = Array.from({ length: R }, () => new Array(C).fill(-1));
  const cells = [];
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) cells.push([r, c]);
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  for (let i = 0; i < targetK && i < cells.length; i++) {
    map[cells[i][0]][cells[i][1]] = i;
  }
  let assigned = targetK;
  while (assigned < R * C) {
    let progress = false;
    for (let id = 0; id < targetK; id++) {
      const candidates = [];
      for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
        if (map[r][c] !== -1) continue;
        for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nr = r + dr, nc = c + dc;
          if (nr < 0 || nr >= R || nc < 0 || nc >= C) continue;
          if (map[nr][nc] === id) { candidates.push([r, c]); break; }
        }
      }
      if (candidates.length === 0) continue;
      const [r, c] = candidates[Math.floor(rand() * candidates.length)];
      map[r][c] = id;
      assigned++;
      progress = true;
    }
    if (!progress) break;
  }
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
    if (map[r][c] === -1) map[r][c] = 0;
  }
  return map;
}

function describeRegions(regionMap, R, C) {
  const byId = new Map();
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
    const id = regionMap[r][c];
    if (!byId.has(id)) byId.set(id, new Map());
    const byRow = byId.get(id);
    if (!byRow.has(r)) byRow.set(r, []);
    byRow.get(r).push([r, c]);
  }
  return Array.from(byId.entries()).map(([id, byRow]) => {
    const groups = Array.from(byRow.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([row, cells]) => ({ row, cells }));
    return { id, groups, maxLvl: groups.length };
  });
}

function gridFromLevels(regions, levels, R, C) {
  const grid = Array.from({ length: R }, () => new Array(C).fill(0));
  for (let k = 0; k < regions.length; k++) {
    const reg = regions[k];
    const lvl = levels[k];
    for (let g = reg.maxLvl - lvl; g < reg.maxLvl; g++) {
      for (const [r, c] of reg.groups[g].cells) grid[r][c] = 1;
    }
  }
  return grid;
}

function rowColSums(grid, R, C) {
  const rs = new Array(R).fill(0);
  const cs = new Array(C).fill(0);
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
    if (grid[r][c] === 1) { rs[r]++; cs[c]++; }
  }
  return { rs, cs };
}

function bruteForceAquarium(rowClues, colClues, regionMap, R, C) {
  const regions = describeRegions(regionMap, R, C);
  const K = regions.length;
  const solutions = [];
  const levels = new Array(K).fill(0);
  function recurse(i) {
    if (solutions.length > 64) return;
    if (i === K) {
      const grid = gridFromLevels(regions, levels, R, C);
      const { rs, cs } = rowColSums(grid, R, C);
      for (let r = 0; r < R; r++) if (rs[r] !== rowClues[r]) return;
      for (let c = 0; c < C; c++) if (cs[c] !== colClues[c]) return;
      solutions.push(grid);
      return;
    }
    for (let lvl = 0; lvl <= regions[i].maxLvl; lvl++) {
      levels[i] = lvl;
      recurse(i + 1);
    }
  }
  recurse(0);
  return solutions;
}

// AquariumSolver returns grid with 1 = water, -1 = dry. Normalize to 1/0 for
// the oracle comparison.
function normalizeSolverGrid(g) {
  return g.map(row => row.map(v => v === 1 ? 1 : 0));
}

function gridsEqual(a, b) {
  for (let r = 0; r < a.length; r++) {
    for (let c = 0; c < a[r].length; c++) if (a[r][c] !== b[r][c]) return false;
  }
  return true;
}

function runConstructive(seed, R, C, targetK) {
  const rand = rng(seed);
  const regionMap = randomRegionMap(rand, R, C, targetK);
  const regions = describeRegions(regionMap, R, C);
  const levels = regions.map(r => Math.floor(rand() * (r.maxLvl + 1)));
  const groundTruth = gridFromLevels(regions, levels, R, C);
  const { rs, cs } = rowColSums(groundTruth, R, C);

  const oracle = bruteForceAquarium(rs, cs, regionMap, R, C);
  assert.ok(oracle.length >= 1,
    `seed=${seed}: constructive puzzle should have >=1 oracle solution`);

  const solver = new AquariumSolver(rs, cs, regionMap, R, C);
  const result = solver.solve(null);
  assert.equal(result.solved, true,
    `seed=${seed}: solver failed on constructive puzzle. ` +
    `regionMap=${JSON.stringify(regionMap)}, rs=${JSON.stringify(rs)}, cs=${JSON.stringify(cs)}`);

  const solverGrid = normalizeSolverGrid(result.grid);
  const matched = oracle.some(sol => gridsEqual(sol, solverGrid));
  assert.ok(matched,
    `seed=${seed}: solver grid not in oracle's ${oracle.length}-solution set. ` +
    `solver=${JSON.stringify(solverGrid)}`);
}

function runRandomClues(seed, R, C, targetK) {
  const rand = rng(seed);
  const regionMap = randomRegionMap(rand, R, C, targetK);
  const maxClue = Math.min(R, C);
  const rs = Array.from({ length: R }, () => Math.floor(rand() * (maxClue + 1)));
  const cs = Array.from({ length: C }, () => Math.floor(rand() * (maxClue + 1)));
  // Clues must agree on total water count; if they don't, oracle will find
  // nothing and that's a legitimate test of the unsolvable path.

  const oracle = bruteForceAquarium(rs, cs, regionMap, R, C);
  const solver = new AquariumSolver(rs, cs, regionMap, R, C);
  const result = solver.solve(null);

  if (oracle.length === 0) {
    assert.equal(result.solved, false,
      `seed=${seed}: oracle empty but solver returned solved=true. ` +
      `rs=${JSON.stringify(rs)}, cs=${JSON.stringify(cs)}`);
    return;
  }

  assert.equal(result.solved, true,
    `seed=${seed}: oracle found ${oracle.length} but solver failed`);
  const solverGrid = normalizeSolverGrid(result.grid);
  assert.ok(oracle.some(sol => gridsEqual(sol, solverGrid)),
    `seed=${seed}: solver grid not in oracle's set`);
}

test('AquariumSolver: constructive solvable 3x3 (30 trials)', () => {
  for (let seed = 1; seed <= 30; seed++) runConstructive(seed, 3, 3, 2);
});

test('AquariumSolver: constructive solvable 4x4 (30 trials)', () => {
  for (let seed = 100; seed <= 129; seed++) runConstructive(seed, 4, 4, 3);
});

test('AquariumSolver: constructive solvable 4x5 (20 trials)', () => {
  for (let seed = 200; seed <= 219; seed++) runConstructive(seed, 4, 5, 4);
});

test('AquariumSolver: random-clue 3x3 (20 trials)', () => {
  for (let seed = 300; seed <= 319; seed++) runRandomClues(seed, 3, 3, 2);
});

test('AquariumSolver: random-clue 4x4 (20 trials)', () => {
  for (let seed = 400; seed <= 419; seed++) runRandomClues(seed, 4, 4, 3);
});

test('AquariumSolver: maxMs budget triggers timedOut on slow unsolvable puzzle', () => {
  // Seed 555 was identified empirically as taking ~5s of search before
  // exhausting nodes. With maxMs=1 the solver must bail well before then.
  const rand = rng(555);
  const regionMap = randomRegionMap(rand, 4, 4, 3);
  const maxClue = 4;
  const rs = Array.from({ length: 4 }, () => Math.floor(rand() * (maxClue + 1)));
  const cs = Array.from({ length: 4 }, () => Math.floor(rand() * (maxClue + 1)));
  const solver = new AquariumSolver(rs, cs, regionMap, 4, 4);
  solver.maxMs = 1;
  const t0 = Date.now();
  const result = solver.solve(null);
  const elapsed = Date.now() - t0;
  assert.equal(result.solved, false);
  assert.ok(elapsed < 500,
    `solver should bail within 500ms once maxMs=1 is exceeded, took ${elapsed}ms`);
});
