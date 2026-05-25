'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { KakurasuSolver } = require('../solver.js');

function generatePuzzle(rows, cols, seed) {
  let rng = seed >>> 0;
  const rand = () => {
    rng = (rng * 1103515245 + 12345) >>> 0;
    return rng / 0x100000000;
  };
  const shade = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (rand() < 0.5) shade[r][c] = 1;
  }
  const rowClues = new Array(rows).fill(0);
  const colClues = new Array(cols).fill(0);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (shade[r][c]) {
        rowClues[r] += (c + 1);
        colClues[c] += (r + 1);
      }
    }
  }
  return { rowClues, colClues, shade };
}

function validate(rows, cols, rowClues, colClues, grid) {
  for (let r = 0; r < rows; r++) {
    let sum = 0;
    for (let c = 0; c < cols; c++) {
      if (grid[r][c] === 1) sum += (c + 1);
    }
    if (sum !== rowClues[r]) return `row ${r} sum ${sum} ≠ clue ${rowClues[r]}`;
  }
  for (let c = 0; c < cols; c++) {
    let sum = 0;
    for (let r = 0; r < rows; r++) {
      if (grid[r][c] === 1) sum += (r + 1);
    }
    if (sum !== colClues[c]) return `col ${c} sum ${sum} ≠ clue ${colClues[c]}`;
  }
  return null;
}

test('KakurasuSolver fuzz: solved boards satisfy both row and column sums', () => {
  KakurasuSolver.clearSolutionCache();
  let solved = 0;
  for (let seed = 1; seed <= 30; seed++) {
    KakurasuSolver.clearSolutionCache();
    const rows = 3 + (seed % 4);
    const cols = 3 + ((seed >> 2) % 4);
    const { rowClues, colClues } = generatePuzzle(rows, cols, seed * 9173 + 1);
    const s = new KakurasuSolver({ rows, cols, rowClues, colClues, maxMs: 2000 });
    const r = s.solve();
    if (!r.solved) continue;
    const err = validate(rows, cols, rowClues, colClues, r.grid);
    assert.equal(err, null, `seed=${seed} ${rows}x${cols}: ${err}`);
    solved++;
  }
  assert.ok(solved >= 10, `expected ≥ 10 solved boards, got ${solved}`);
});
