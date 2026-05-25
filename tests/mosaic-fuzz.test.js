'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MosaicSolver } = require('../solver.js');

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
  const task = Array.from({ length: rows }, () => new Array(cols).fill(-1));
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (rand() < 0.5) {
      let k = 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
        if (shade[rr][cc] === 1) k++;
      }
      task[r][c] = k;
    }
  }
  return { task };
}

function validate(rows, cols, task, grid) {
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (task[r][c] === -1) continue;
    const K = task[r][c];
    let k = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
      if (grid[rr][cc] === 1) k++;
    }
    if (k !== K) return `clue (${r},${c})=${K} got ${k} blacks`;
  }
  return null;
}

test('MosaicSolver fuzz: solved boards satisfy every clue', () => {
  MosaicSolver.clearSolutionCache();
  let solved = 0;
  for (let seed = 1; seed <= 30; seed++) {
    MosaicSolver.clearSolutionCache();
    const rows = 4 + (seed % 3);
    const cols = 4 + ((seed >> 2) % 3);
    const { task } = generatePuzzle(rows, cols, seed * 9173 + 1);
    const s = new MosaicSolver({ rows, cols, task, maxMs: 3000 });
    const r = s.solve();
    if (!r.solved) continue;
    const err = validate(rows, cols, task, r.grid);
    assert.equal(err, null, `seed=${seed} ${rows}x${cols}: ${err}`);
    solved++;
  }
  assert.ok(solved >= 10, `expected ≥ 10 solved boards, got ${solved}`);
});
