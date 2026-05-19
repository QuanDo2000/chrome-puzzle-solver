// Rule-validity fuzz for BinairoSolver. We generate random givens at small
// sizes and assert: if solver returns solved=true, the resulting grid
// satisfies all three Binairo rules (no-triples, balance, uniqueness) on
// every row and column.

const test = require('node:test');
const assert = require('node:assert/strict');
const { BinairoSolver } = require('../solver.js');

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function randomGivens(rand, R, C, density) {
  const g = Array.from({ length: R }, () => new Array(C).fill(-1));
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      if (rand() < density) g[r][c] = rand() < 0.5 ? 0 : 1;
    }
  }
  return g;
}

function lineFromGrid(grid, axis, index, N) {
  const out = new Array(N);
  if (axis === 'row') for (let i = 0; i < N; i++) out[i] = grid[index][i];
  else for (let i = 0; i < N; i++) out[i] = grid[i][index];
  return out;
}

function violatesTriples(line) {
  for (let i = 2; i < line.length; i++) {
    if (line[i] !== 0 && line[i] === line[i - 1] && line[i] === line[i - 2]) return true;
  }
  return false;
}

function violatesBalance(line, half) {
  let ones = 0, zeros = 0;
  for (const v of line) {
    if (v === 1) ones++; else if (v === 2) zeros++;
  }
  return ones !== half || zeros !== half;
}

function lineKey(line) { return line.join(''); }

function verifyBinairoRules(grid, R, C, comparisonClues) {
  for (let r = 0; r < R; r++) {
    const line = lineFromGrid(grid, 'row', r, C);
    if (violatesTriples(line))            return `row ${r}: three in a row`;
    if (violatesBalance(line, C / 2))     return `row ${r}: unbalanced`;
  }
  for (let c = 0; c < C; c++) {
    const line = lineFromGrid(grid, 'col', c, R);
    if (violatesTriples(line))            return `col ${c}: three in a row`;
    if (violatesBalance(line, R / 2))     return `col ${c}: unbalanced`;
  }
  const rowKeys = new Set();
  for (let r = 0; r < R; r++) {
    const k = lineKey(lineFromGrid(grid, 'row', r, C));
    if (rowKeys.has(k)) return `duplicate row: ${k}`;
    rowKeys.add(k);
  }
  const colKeys = new Set();
  for (let c = 0; c < C; c++) {
    const k = lineKey(lineFromGrid(grid, 'col', c, R));
    if (colKeys.has(k)) return `duplicate col: ${k}`;
    colKeys.add(k);
  }
  if (Array.isArray(comparisonClues)) {
    for (let r = 0; r < comparisonClues.length && r < R; r++) {
      const row = comparisonClues[r];
      if (!Array.isArray(row)) continue;
      for (let c = 0; c < row.length && c < C; c++) {
        const flag = row[c];
        if (typeof flag !== 'number' || flag === 0) continue;
        const v = grid[r][c];
        if (v === 0) continue;
        if ((flag & 1) && c + 1 < C) {
          if (grid[r][c + 1] !== v) return `R-EQ violated at (${r},${c})`;
        }
        if ((flag & 2) && c + 1 < C) {
          if (grid[r][c + 1] === v) return `R-NE violated at (${r},${c})`;
        }
        if ((flag & 4) && r + 1 < R) {
          if (grid[r + 1][c] !== v) return `D-EQ violated at (${r},${c})`;
        }
        if ((flag & 8) && r + 1 < R) {
          if (grid[r + 1][c] === v) return `D-NE violated at (${r},${c})`;
        }
      }
    }
  }
  return null;
}

function runTrial(seed, R, C, density) {
  const rand = rng(seed);
  const givens = randomGivens(rand, R, C, density);
  BinairoSolver.clearSolutionCache();
  const result = new BinairoSolver({ rows: R, cols: C, givens }).solve();
  if (!result.solved) return;
  const violation = verifyBinairoRules(result.grid, R, C);
  assert.equal(violation, null,
    `seed=${seed} R=${R} C=${C}: solver returned solved=true but violates ${violation}. ` +
    `givens=${JSON.stringify(givens)} grid=${JSON.stringify(result.grid)}`);
}

test('BinairoSolver: rule-validity fuzz 4x4 (40 trials)', () => {
  for (let seed = 1; seed <= 40; seed++) runTrial(seed, 4, 4, 0.3);
});

test('BinairoSolver: rule-validity fuzz 6x6 (40 trials)', () => {
  for (let seed = 100; seed <= 139; seed++) runTrial(seed, 6, 6, 0.25);
});

test('BinairoSolver: rule-validity fuzz 8x8 (20 trials)', () => {
  for (let seed = 200; seed <= 219; seed++) runTrial(seed, 8, 8, 0.2);
});

function constructiveSolvedGrid(rand, R, C) {
  // Use the solver itself to produce a known-solved grid from random givens
  // we know are solvable: empty givens + repeated solves until one succeeds.
  // Empty givens admit many solutions; backtracking returns one
  // deterministically.
  BinairoSolver.clearSolutionCache();
  const givens = Array.from({ length: R }, () => new Array(C).fill(-1));
  // Stir randomness in by pre-placing a couple of random hints.
  for (let i = 0; i < 2; i++) {
    const r = Math.floor(rand() * R);
    const c = Math.floor(rand() * C);
    givens[r][c] = rand() < 0.5 ? 0 : 1;
  }
  const r = new BinairoSolver({ rows: R, cols: C, givens }).solve();
  if (!r.solved) return null;
  return { grid: r.grid, givens };
}

function sampleComparisonClues(rand, grid, R, C, density) {
  // For each interior border, with probability `density`, attach a flag
  // (EQ if the two sides are equal in the solved grid, NE otherwise).
  const cc = Array.from({ length: R }, () => []);
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      let flag = 0;
      if (c + 1 < C && rand() < density) {
        flag |= (grid[r][c] === grid[r][c + 1]) ? 1 : 2;
      }
      if (r + 1 < R && rand() < density) {
        flag |= (grid[r][c] === grid[r + 1][c]) ? 4 : 8;
      }
      if (flag !== 0) cc[r][c] = flag;
      else if (cc[r].length <= c) cc[r].length = c + 1;
    }
    // Trim trailing undefined.
    while (cc[r].length > 0 && (cc[r][cc[r].length - 1] === undefined ||
                                 cc[r][cc[r].length - 1] === 0)) {
      cc[r].pop();
    }
  }
  return cc;
}

function runComparisonTrial(seed, R, C) {
  const rand = rng(seed);
  const built = constructiveSolvedGrid(rand, R, C);
  if (!built) return; // skip — couldn't build a base solution
  const comparisonClues = sampleComparisonClues(rand, built.grid, R, C, 0.2);
  // Knock out a random subset of givens to make the puzzle non-trivial.
  const givens = built.givens.map(row => row.slice());
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      if (givens[r][c] !== -1 && rand() < 0.5) givens[r][c] = -1;
    }
  }
  BinairoSolver.clearSolutionCache();
  const result = new BinairoSolver({ rows: R, cols: C, givens, comparisonClues }).solve();
  if (!result.solved) return;
  const violation = verifyBinairoRules(result.grid, R, C, comparisonClues);
  assert.equal(violation, null,
    `seed=${seed} R=${R} C=${C}: solver returned solved=true but violates ${violation}. ` +
    `givens=${JSON.stringify(givens)} cc=${JSON.stringify(comparisonClues)} grid=${JSON.stringify(result.grid)}`);
}

test('BinairoSolver: comparison-clue constructive fuzz 4x4 (30 trials)', () => {
  for (let seed = 500; seed <= 529; seed++) runComparisonTrial(seed, 4, 4);
});

test('BinairoSolver: comparison-clue constructive fuzz 6x6 (30 trials)', () => {
  for (let seed = 600; seed <= 629; seed++) runComparisonTrial(seed, 6, 6);
});
