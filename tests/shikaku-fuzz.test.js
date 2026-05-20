// Constructive fuzz for ShikakuSolver. Builds a random partition via BSP,
// extracts clues, solves, asserts the solver returns a grid that is a
// valid Shikaku partition (every clue area matches the count of cells
// owned by that clue's rectangle, every cell is owned, each owner-set
// forms a rectangle).

const test = require('node:test');
const assert = require('node:assert/strict');
const { ShikakuSolver } = require('../solver.js');

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function bspPartition(rand, r1, c1, r2, c2, minSize, out) {
  const h = r2 - r1 + 1;
  const w = c2 - c1 + 1;
  if (h <= minSize && w <= minSize) {
    out.push({ r1, c1, r2, c2 });
    return;
  }
  if (rand() < 0.25) {
    out.push({ r1, c1, r2, c2 });
    return;
  }
  const splitVertical = w >= h ? rand() < 0.7 : rand() < 0.3;
  if (splitVertical && w > minSize * 2) {
    const c = c1 + minSize + Math.floor(rand() * (w - 2 * minSize));
    bspPartition(rand, r1, c1, r2, c, minSize, out);
    bspPartition(rand, r1, c + 1, r2, c2, minSize, out);
  } else if (h > minSize * 2) {
    const r = r1 + minSize + Math.floor(rand() * (h - 2 * minSize));
    bspPartition(rand, r1, c1, r, c2, minSize, out);
    bspPartition(rand, r + 1, c1, r2, c2, minSize, out);
  } else {
    out.push({ r1, c1, r2, c2 });
  }
}

function makeCluesFromPartition(rects) {
  return rects.map(r => ({
    row: r.r1,
    col: r.c1,
    area: (r.r2 - r.r1 + 1) * (r.c2 - r.c1 + 1),
  }));
}

function verifyShikakuSolution(grid, clues, R, C) {
  const counts = new Array(clues.length).fill(0);
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      const o = grid[r][c];
      if (!Number.isInteger(o) || o < 0 || o >= clues.length) {
        return `cell (${r},${c}) has invalid owner ${o}`;
      }
      counts[o]++;
    }
  }
  for (let i = 0; i < clues.length; i++) {
    if (counts[i] !== clues[i].area) {
      return `clue ${i} (row ${clues[i].row}, col ${clues[i].col}, area ${clues[i].area}) actually has ${counts[i]} cells`;
    }
  }
  for (let i = 0; i < clues.length; i++) {
    const cellOwner = grid[clues[i].row][clues[i].col];
    if (cellOwner !== i) {
      return `clue ${i}'s own cell is owned by ${cellOwner}`;
    }
  }
  for (let i = 0; i < clues.length; i++) {
    let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
    let count = 0;
    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        if (grid[r][c] === i) {
          minR = Math.min(minR, r);
          maxR = Math.max(maxR, r);
          minC = Math.min(minC, c);
          maxC = Math.max(maxC, c);
          count++;
        }
      }
    }
    const w = maxC - minC + 1;
    const h = maxR - minR + 1;
    if (w * h !== count) {
      return `owner ${i}'s cells do not form a rectangle (bbox ${w}×${h} but ${count} cells)`;
    }
  }
  return null;
}

function runTrial(seed, R, C, minSize) {
  const rand = rng(seed);
  const rects = [];
  bspPartition(rand, 0, 0, R - 1, C - 1, minSize, rects);
  const clues = makeCluesFromPartition(rects);
  ShikakuSolver.clearSolutionCache();
  const result = new ShikakuSolver({ rows: R, cols: C, clues }).solve();
  assert.equal(result.solved, true,
    `seed=${seed} R=${R} C=${C}: solver failed on a constructively-built puzzle. ` +
    `clues=${JSON.stringify(clues)}`);
  const violation = verifyShikakuSolution(result.grid, clues, R, C);
  assert.equal(violation, null,
    `seed=${seed} R=${R} C=${C}: solver returned solved=true but ${violation}. ` +
    `grid=${JSON.stringify(result.grid)}`);
}

test('ShikakuSolver: constructive fuzz 5x5 (30 trials)', () => {
  for (let seed = 1; seed <= 30; seed++) runTrial(seed, 5, 5, 1);
});

test('ShikakuSolver: constructive fuzz 7x7 (20 trials)', () => {
  for (let seed = 100; seed <= 119; seed++) runTrial(seed, 7, 7, 1);
});

test('ShikakuSolver: constructive fuzz 10x10 (10 trials)', () => {
  for (let seed = 200; seed <= 209; seed++) runTrial(seed, 10, 10, 1);
});
