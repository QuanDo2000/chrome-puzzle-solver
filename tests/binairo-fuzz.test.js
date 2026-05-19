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

function verifyBinairoRules(grid, R, C) {
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
