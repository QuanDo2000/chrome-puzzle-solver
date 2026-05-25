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
  for (const room of rooms) {
    const blacks = [];
    for (const cell of room.cells) {
      if (grid[cell.r][cell.c] === 1) blacks.push(cell);
    }
    if (blacks.length !== 2) return `rule 1 count: region has ${blacks.length} blacks`;
    const dr = Math.abs(blacks[0].r - blacks[1].r);
    const dc = Math.abs(blacks[0].c - blacks[1].c);
    if (dr + dc !== 1) return `rule 1 domino: blacks not adjacent`;
  }
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (grid[r][c] !== 1) continue;
    for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      if (grid[nr][nc] !== 1) continue;
      if (areas[r][c] !== areas[nr][nc]) {
        return `rule 2: cross-region blacks at (${r},${c})-(${nr},${nc})`;
      }
    }
  }
  return null;
}

test('NorinoriSolver fuzz: solved boards satisfy both rules', () => {
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
