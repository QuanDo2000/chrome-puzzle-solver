// Property-style cross-check of the full NonogramSolver.solve() search against
// a brute-force oracle. tests/solveline.test.js already fuzzes the per-line DP
// (solveLine) exhaustively; this file exercises the row/col propagation +
// backtracking loop on top of it, which previously had only two golden
// fixtures (tests/solver.test.js).
//
// Strategy mirrors tests/aquarium-fuzz.test.js:
//   - constructive trials: pick a random 0/1 grid, derive its row/col clues
//     (guaranteed solvable). The solver must return solved:true and a grid
//     that *satisfies* those clues — not necessarily the same grid, since a
//     nonogram can have several solutions for one clue set.
//   - random-clue trials (tiny boards only): take row clues from one random
//     grid and col clues from another. The pair is usually inconsistent, so
//     the solver must report solved:false iff the brute-force oracle is empty,
//     and any solved grid must be in the oracle's set.

const test = require('node:test');
const assert = require('node:assert/strict');
const { NonogramSolver } = require('../solver.js');

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function randomGrid(rand, R, C, p) {
  return Array.from({ length: R }, () =>
    Array.from({ length: C }, () => (rand() < p ? 1 : 0)));
}

// Run-length encode the filled (1) cells of a 0/1 line. An empty line is the
// clue [] — matching NonogramSolver.solveLine's N===0 case.
function rle(line) {
  const out = [];
  let count = 0;
  for (const v of line) {
    if (v === 1) count++;
    else if (count > 0) { out.push(count); count = 0; }
  }
  if (count > 0) out.push(count);
  return out;
}

function deriveClues(grid, R, C) {
  const rowClues = grid.map(row => rle(row));
  const colClues = [];
  for (let c = 0; c < C; c++) {
    const col = new Array(R);
    for (let r = 0; r < R; r++) col[r] = grid[r][c];
    colClues.push(rle(col));
  }
  return { rowClues, colClues };
}

// The solver emits 1 = filled, -1 = empty. Normalize to 0/1 for clue checks.
function normalize(grid) {
  return grid.map(row => row.map(v => (v === 1 ? 1 : 0)));
}

function cluesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].length !== b[i].length) return false;
    for (let j = 0; j < a[i].length; j++) if (a[i][j] !== b[i][j]) return false;
  }
  return true;
}

function gridSatisfies(grid01, rowClues, colClues, R, C) {
  const derived = deriveClues(grid01, R, C);
  return cluesEqual(derived.rowClues, rowClues) &&
         cluesEqual(derived.colClues, colClues);
}

function gridsEqual(a, b) {
  for (let r = 0; r < a.length; r++) {
    for (let c = 0; c < a[r].length; c++) if (a[r][c] !== b[r][c]) return false;
  }
  return true;
}

// Enumerate every 2^(R*C) grid and keep those matching the clues. Only viable
// for R*C <= 16; callers must respect that.
function bruteForce(rowClues, colClues, R, C) {
  const total = R * C;
  assert.ok(total <= 16, `bruteForce called on ${R}x${C} (too large)`);
  const solutions = [];
  for (let mask = 0; mask < (1 << total); mask++) {
    const grid = Array.from({ length: R }, () => new Array(C).fill(0));
    for (let bit = 0; bit < total; bit++) {
      if (mask & (1 << bit)) grid[(bit / C) | 0][bit % C] = 1;
    }
    if (gridSatisfies(grid, rowClues, colClues, R, C)) solutions.push(grid);
  }
  return solutions;
}

function runConstructive(seed, R, C, p) {
  const rand = rng(seed);
  const truth = randomGrid(rand, R, C, p);
  const { rowClues, colClues } = deriveClues(truth, R, C);

  const result = new NonogramSolver(rowClues, colClues).solve(null);
  assert.equal(result.solved, true,
    `seed=${seed}: solver failed on constructive puzzle. ` +
    `rowClues=${JSON.stringify(rowClues)}, colClues=${JSON.stringify(colClues)}`);
  const grid01 = normalize(result.grid);
  assert.ok(gridSatisfies(grid01, rowClues, colClues, R, C),
    `seed=${seed}: solver grid does not satisfy its own clues. ` +
    `grid=${JSON.stringify(grid01)}`);
}

function runRandomClues(seed, R, C, p) {
  const rand = rng(seed);
  const { rowClues } = deriveClues(randomGrid(rand, R, C, p), R, C);
  const { colClues } = deriveClues(randomGrid(rand, R, C, p), R, C);

  const oracle = bruteForce(rowClues, colClues, R, C);
  const result = new NonogramSolver(rowClues, colClues).solve(null);

  assert.equal(result.solved, oracle.length > 0,
    `seed=${seed}: solved=${result.solved} but oracle has ${oracle.length} solutions. ` +
    `rowClues=${JSON.stringify(rowClues)}, colClues=${JSON.stringify(colClues)}`);

  if (result.solved) {
    const grid01 = normalize(result.grid);
    assert.ok(oracle.some(sol => gridsEqual(sol, grid01)),
      `seed=${seed}: solver grid not in oracle's ${oracle.length}-solution set. ` +
      `grid=${JSON.stringify(grid01)}`);
  }
}

test('NonogramSolver: constructive solvable 4x4 (40 trials)', () => {
  for (let seed = 1; seed <= 40; seed++) runConstructive(seed, 4, 4, 0.5);
});

test('NonogramSolver: constructive solvable 5x5, sparse + dense (40 trials)', () => {
  for (let seed = 100; seed <= 119; seed++) runConstructive(seed, 5, 5, 0.3);
  for (let seed = 120; seed <= 139; seed++) runConstructive(seed, 5, 5, 0.7);
});

test('NonogramSolver: constructive solvable 6x6 (30 trials)', () => {
  for (let seed = 200; seed <= 229; seed++) runConstructive(seed, 6, 6, 0.5);
});

test('NonogramSolver: random-clue 3x3 vs brute force (40 trials)', () => {
  for (let seed = 300; seed <= 339; seed++) runRandomClues(seed, 3, 3, 0.5);
});

test('NonogramSolver: random-clue 4x4 vs brute force (20 trials)', () => {
  // 4x4 brute force is 2^16 grids per trial; 20 trials keeps this under ~1s.
  for (let seed = 400; seed <= 419; seed++) runRandomClues(seed, 4, 4, 0.5);
});
