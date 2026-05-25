'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { NorinoriSolver } = require('../solver.js');

function generateRectangularRooms(rows, cols, seed) {
  let rng = seed >>> 0;
  const rand = () => {
    rng = (rng * 1103515245 + 12345) >>> 0;
    return rng / 0x100000000;
  };
  const grid = Array.from({ length: rows }, () => new Array(cols).fill(-1));
  const rooms = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (grid[r][c] !== -1) continue;
      let maxW = 1;
      while (c + maxW < cols && grid[r][c + maxW] === -1) maxW++;
      const wantW = 2 + Math.floor(rand() * Math.max(1, maxW - 1));
      const finalW = Math.min(wantW, maxW);
      let maxH = 1;
      outer: while (r + maxH < rows) {
        for (let cc = c; cc < c + finalW; cc++) {
          if (grid[r + maxH][cc] !== -1) break outer;
        }
        maxH++;
      }
      const h = 1 + Math.floor(rand() * maxH);
      const id = rooms.length;
      const cells = [];
      for (let rr = r; rr < r + h; rr++) {
        for (let cc = c; cc < c + finalW; cc++) {
          grid[rr][cc] = id;
          cells.push({r: rr, c: cc});
        }
      }
      rooms.push({cells});
    }
  }
  return { rooms, areas: grid };
}

function validate(rows, cols, rooms, areas, grid) {
  // Rule 1: each region has exactly 2 black cells.
  for (const room of rooms) {
    let nB = 0;
    for (const cell of room.cells) if (grid[cell.r][cell.c] === 1) nB++;
    if (nB !== 2) return `rule 1: region has ${nB} blacks`;
  }
  // Rule 2: no 3-in-row.
  for (let r = 0; r < rows; r++)
    for (let c = 0; c + 2 < cols; c++)
      if (grid[r][c] === 1 && grid[r][c+1] === 1 && grid[r][c+2] === 1)
        return `rule 2: h-3-in-row at (${r},${c})`;
  for (let c = 0; c < cols; c++)
    for (let r = 0; r + 2 < rows; r++)
      if (grid[r][c] === 1 && grid[r+1][c] === 1 && grid[r+2][c] === 1)
        return `rule 2: v-3-in-row at (${r},${c})`;
  // Rule 3: no 2x2 with 3+ blacks.
  for (let r = 0; r + 1 < rows; r++)
    for (let c = 0; c + 1 < cols; c++) {
      let n = 0;
      if (grid[r][c] === 1) n++;
      if (grid[r][c+1] === 1) n++;
      if (grid[r+1][c] === 1) n++;
      if (grid[r+1][c+1] === 1) n++;
      if (n > 2) return `rule 3: 2x2 with ${n} blacks at (${r},${c})`;
    }
  // Rule 4: every black has at least one black neighbour.
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      if (grid[r][c] !== 1) continue;
      let hasB = false;
      if (r > 0 && grid[r-1][c] === 1) hasB = true;
      if (r < rows - 1 && grid[r+1][c] === 1) hasB = true;
      if (c > 0 && grid[r][c-1] === 1) hasB = true;
      if (c < cols - 1 && grid[r][c+1] === 1) hasB = true;
      if (!hasB) return `rule 4: solo black at (${r},${c})`;
    }
  return null;
}

test('NorinoriSolver fuzz: solved boards satisfy all four site rules', () => {
  NorinoriSolver.clearSolutionCache();
  let solved = 0;
  for (let seed = 1; seed <= 30; seed++) {
    NorinoriSolver.clearSolutionCache();
    const rows = 4 + (seed % 3);
    const cols = 4 + ((seed >> 2) % 3);
    const { rooms, areas } = generateRectangularRooms(rows, cols, seed * 9173 + 1);
    const s = new NorinoriSolver({ rows, cols, rooms, maxMs: 3000 });
    const r = s.solve();
    if (!r.solved) continue;
    const err = validate(rows, cols, rooms, areas, r.grid);
    assert.equal(err, null, `seed=${seed} ${rows}x${cols}: ${err}`);
    solved++;
  }
  assert.ok(solved >= 5, `expected ≥ 5 solved boards, got ${solved}`);
});
