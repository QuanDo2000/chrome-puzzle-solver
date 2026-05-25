'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { HeyawakeSolver } = require('../solver.js');

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
      const w = 1 + Math.floor(rand() * maxW);
      let maxH = 1;
      outer: while (r + maxH < rows) {
        for (let cc = c; cc < c + w; cc++) {
          if (grid[r + maxH][cc] !== -1) break outer;
        }
        maxH++;
      }
      const h = 1 + Math.floor(rand() * maxH);
      const id = rooms.length;
      const cells = [];
      for (let rr = r; rr < r + h; rr++) {
        for (let cc = c; cc < c + w; cc++) {
          grid[rr][cc] = id;
          cells.push({ r: rr, c: cc });
        }
      }
      rooms.push({ cells, target: -1 });
    }
  }
  return { rooms, areas: grid };
}

function pickTargetsFromSolution(rooms, solution) {
  const out = [];
  for (const room of rooms) {
    let blacks = 0;
    for (const cell of room.cells) if (solution[cell.r][cell.c] === 1) blacks++;
    out.push({ ...room, target: Math.random() < 0.5 ? blacks : -1 });
  }
  return out;
}

function validate(rows, cols, rooms, areas, grid) {
  for (const room of rooms) {
    if (room.target < 0) continue;
    let n = 0;
    for (const cell of room.cells) if (grid[cell.r][cell.c] === 1) n++;
    if (n !== room.target) return `rule 1: room target ${room.target} vs ${n} blacks`;
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (grid[r][c] !== 1) continue;
      if (r > 0 && grid[r - 1][c] === 1) return `rule 2: blacks at (${r-1},${c}) (${r},${c})`;
      if (c > 0 && grid[r][c - 1] === 1) return `rule 2: blacks at (${r},${c-1}) (${r},${c})`;
    }
  }
  const checkLine = (cells) => {
    const n = cells.length;
    let runStart = 0;
    while (runStart < n) {
      if (grid[cells[runStart].r][cells[runStart].c] !== 2) { runStart++; continue; }
      let runEnd = runStart;
      while (runEnd + 1 < n && grid[cells[runEnd + 1].r][cells[runEnd + 1].c] === 2) runEnd++;
      const rs = new Set();
      for (let i = runStart; i <= runEnd; i++) rs.add(areas[cells[i].r][cells[i].c]);
      if (rs.size >= 3) return `rule 3: white run from (${cells[runStart].r},${cells[runStart].c}) to (${cells[runEnd].r},${cells[runEnd].c}) spans ${rs.size} rooms`;
      runStart = runEnd + 1;
    }
    return null;
  };
  for (let r = 0; r < rows; r++) {
    const err = checkLine(Array.from({ length: cols }, (_, c) => ({ r, c })));
    if (err) return err;
  }
  for (let c = 0; c < cols; c++) {
    const err = checkLine(Array.from({ length: rows }, (_, r) => ({ r, c })));
    if (err) return err;
  }
  let anchor = -1;
  for (let r = 0; r < rows && anchor < 0; r++) for (let c = 0; c < cols; c++) {
    if (grid[r][c] === 2) { anchor = r * cols + c; break; }
  }
  if (anchor < 0) return null;
  const visited = new Uint8Array(rows * cols);
  visited[anchor] = 1;
  const stack = [anchor];
  while (stack.length) {
    const u = stack.pop();
    const r = (u / cols) | 0;
    const c = u - r * cols;
    const ns = [];
    if (r > 0) ns.push(u - cols);
    if (r < rows - 1) ns.push(u + cols);
    if (c > 0) ns.push(u - 1);
    if (c < cols - 1) ns.push(u + 1);
    for (const ni of ns) {
      if (visited[ni]) continue;
      const nr = (ni / cols) | 0, nc = ni - nr * cols;
      if (grid[nr][nc] !== 2) continue;
      visited[ni] = 1;
      stack.push(ni);
    }
  }
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (grid[r][c] === 2 && !visited[r * cols + c]) {
      return `rule 4: white at (${r},${c}) disconnected from anchor`;
    }
  }
  return null;
}

test('HeyawakeSolver fuzz: every solved board satisfies all four rules', () => {
  HeyawakeSolver.clearSolutionCache();
  let solved = 0;
  let attempted = 0;
  for (let seed = 1; seed <= 30; seed++) {
    attempted++;
    const rows = 4 + (seed % 3);
    const cols = 4 + ((seed >> 2) % 3);
    const { rooms: baseRooms, areas } = generateRectangularRooms(rows, cols, seed * 9173 + 1);
    HeyawakeSolver.clearSolutionCache();
    let primer = new HeyawakeSolver({ rows, cols, rooms: baseRooms, maxMs: 2000 });
    const primed = primer.solve();
    if (!primed.solved) continue;
    const rooms = pickTargetsFromSolution(baseRooms, primed.grid);
    HeyawakeSolver.clearSolutionCache();
    const s = new HeyawakeSolver({ rows, cols, rooms, maxMs: 2000 });
    const r = s.solve();
    if (!r.solved) continue;
    const err = validate(rows, cols, rooms, areas, r.grid);
    assert.equal(err, null, `seed=${seed} ${rows}x${cols}: ${err}`);
    solved++;
  }
  assert.ok(solved >= 10, `expected at least 10 solved boards, got ${solved}/${attempted}`);
});
