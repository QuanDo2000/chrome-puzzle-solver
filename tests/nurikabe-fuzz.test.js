'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { NurikabeSolver } = require('../solver.js');

function validate(rows, cols, task, grid) {
  const N = rows * cols;
  const visited = new Uint8Array(N);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (task[r][c] <= 0) continue;
    if (grid[r][c] !== 2) return `clue (${r},${c}) is not WHITE`;
    const queue = [[r, c]];
    visited[r * cols + c] = 1;
    let size = 1;
    let cluesInside = 1;
    while (queue.length) {
      const [cr, cc] = queue.shift();
      for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const nr = cr + dr, nc = cc + dc;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        if (visited[nr * cols + nc]) continue;
        if (grid[nr][nc] !== 2) continue;
        visited[nr * cols + nc] = 1;
        if (task[nr][nc] > 0) cluesInside++;
        size++;
        queue.push([nr, nc]);
      }
    }
    if (cluesInside !== 1) return `island at (${r},${c}) has ${cluesInside} clues`;
    if (size !== task[r][c]) return `island at (${r},${c}) size ${size} != ${task[r][c]}`;
  }
  for (let r = 0; r + 1 < rows; r++) for (let c = 0; c + 1 < cols; c++) {
    if (grid[r][c] === 1 && grid[r][c+1] === 1 && grid[r+1][c] === 1 && grid[r+1][c+1] === 1) {
      return `2x2 BLACK at (${r},${c})`;
    }
  }
  const blackVisited = new Uint8Array(N);
  let bStart = -1;
  let blackCount = 0;
  for (let i = 0; i < N; i++) {
    const r = (i / cols) | 0, c = i - r * cols;
    if (grid[r][c] === 1) { blackCount++; if (bStart < 0) bStart = i; }
  }
  if (bStart >= 0) {
    const q = [bStart]; blackVisited[bStart] = 1;
    let seen = 1;
    while (q.length) {
      const idx = q.shift();
      const r = (idx / cols) | 0, c = idx - r * cols;
      for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        const ni = nr * cols + nc;
        if (blackVisited[ni]) continue;
        if (grid[nr][nc] !== 1) continue;
        blackVisited[ni] = 1;
        seen++;
        q.push(ni);
      }
    }
    if (seen !== blackCount) return `sea has ${blackCount - seen} disconnected BLACKs`;
  }
  return null;
}

function generateRandomBoard(rows, cols, seed) {
  let rng = seed >>> 0;
  const rand = () => {
    rng = (rng * 1103515245 + 12345) >>> 0;
    return rng / 0x100000000;
  };
  const grid = Array.from({length: rows}, () => new Array(cols).fill(1));
  const task = Array.from({length: rows}, () => new Array(cols).fill(-1));
  const visited = Array.from({length: rows}, () => new Array(cols).fill(false));
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (visited[r][c]) continue;
    if (rand() < 0.55) continue;
    let startSafe = true;
    for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      if (visited[nr][nc]) { startSafe = false; break; }
    }
    if (!startSafe) continue;
    const targetSize = 1 + Math.floor(rand() * 3);
    const cells = [[r, c]];
    visited[r][c] = true;
    while (cells.length < targetSize) {
      const idx = Math.floor(rand() * cells.length);
      const [cr, cc] = cells[idx];
      const dirs = [[-1,0],[1,0],[0,-1],[0,1]].sort(() => rand() - 0.5);
      let grew = false;
      for (const [dr, dc] of dirs) {
        const nr = cr + dr, nc = cc + dc;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        if (visited[nr][nc]) continue;
        let safe = true;
        for (const [ddr, ddc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
          const nnr = nr + ddr, nnc = nc + ddc;
          if (nnr < 0 || nnr >= rows || nnc < 0 || nnc >= cols) continue;
          if (!visited[nnr][nnc]) continue;
          const inIsland = cells.some(([ir, ic]) => ir === nnr && ic === nnc);
          if (!inIsland) { safe = false; break; }
        }
        if (!safe) continue;
        cells.push([nr, nc]);
        visited[nr][nc] = true;
        grew = true;
        break;
      }
      if (!grew) break;
    }
    for (const [ir, ic] of cells) grid[ir][ic] = 2;
    task[cells[0][0]][cells[0][1]] = cells.length;
  }
  for (let r = 0; r + 1 < rows; r++) for (let c = 0; c + 1 < cols; c++) {
    if (grid[r][c] === 1 && grid[r][c+1] === 1 && grid[r+1][c] === 1 && grid[r+1][c+1] === 1) {
      return null;
    }
  }
  const N = rows * cols;
  const seen = new Uint8Array(N);
  let bStart = -1, blackCount = 0;
  for (let i = 0; i < N; i++) {
    const r = (i / cols) | 0, c = i - r * cols;
    if (grid[r][c] === 1) { blackCount++; if (bStart < 0) bStart = i; }
  }
  if (bStart < 0) return null;
  const q = [bStart]; seen[bStart] = 1; let s = 1;
  while (q.length) {
    const idx = q.shift();
    const r = (idx / cols) | 0, c = idx - r * cols;
    for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      const ni = nr * cols + nc;
      if (seen[ni]) continue;
      if (grid[nr][nc] !== 1) continue;
      seen[ni] = 1; s++; q.push(ni);
    }
  }
  if (s !== blackCount) return null;
  return { task, grid };
}

test('NurikabeSolver fuzz: solved boards satisfy all rules', () => {
  let solved = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const rows = 3 + (seed % 3);
    const cols = 3 + ((seed >> 2) % 3);
    const board = generateRandomBoard(rows, cols, seed * 7919 + 1);
    if (!board) continue;
    NurikabeSolver.clearSolutionCache();
    const s = new NurikabeSolver({ rows, cols, task: board.task, maxMs: 5000 });
    const r = s.solve();
    if (!r.solved) continue;
    const err = validate(rows, cols, board.task, r.grid);
    assert.equal(err, null, `seed=${seed} ${rows}x${cols}: ${err}`);
    solved++;
  }
  assert.ok(solved >= 10, `expected ≥ 10 solved boards, got ${solved}`);
});
