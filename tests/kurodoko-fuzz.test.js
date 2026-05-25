'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { KurodokoSolver } = require('../solver.js');

function generatePuzzle(rows, cols, seed) {
  let rng = seed >>> 0;
  const rand = () => {
    rng = (rng * 1103515245 + 12345) >>> 0;
    return rng / 0x100000000;
  };
  const shade = Array.from({ length: rows }, () => new Array(cols).fill(0));
  const cells = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push([r, c]);
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  for (const [r, c] of cells) {
    if (rand() > 0.25) continue;
    if (r > 0 && shade[r-1][c] === 1) continue;
    if (r < rows-1 && shade[r+1][c] === 1) continue;
    if (c > 0 && shade[r][c-1] === 1) continue;
    if (c < cols-1 && shade[r][c+1] === 1) continue;
    shade[r][c] = 1;
    if (!whitesConnected(shade, rows, cols)) shade[r][c] = 0;
  }
  const task = Array.from({ length: rows }, () => new Array(cols).fill(-1));
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (shade[r][c] === 0 && rand() < 0.4) {
      task[r][c] = visibility(r, c, shade, rows, cols);
    }
  }
  return { task, shade };
}

function visibility(r, c, shade, rows, cols) {
  let total = 1;
  for (let rr = r - 1; rr >= 0 && shade[rr][c] === 0; rr--) total++;
  for (let rr = r + 1; rr < rows && shade[rr][c] === 0; rr++) total++;
  for (let cc = c - 1; cc >= 0 && shade[r][cc] === 0; cc--) total++;
  for (let cc = c + 1; cc < cols && shade[r][cc] === 0; cc++) total++;
  return total;
}

function whitesConnected(shade, rows, cols) {
  let anchor = -1;
  for (let r = 0; r < rows && anchor < 0; r++) for (let c = 0; c < cols; c++) {
    if (shade[r][c] === 0) { anchor = r * cols + c; break; }
  }
  if (anchor < 0) return true;
  const visited = new Uint8Array(rows * cols);
  visited[anchor] = 1;
  const stack = [anchor];
  while (stack.length) {
    const u = stack.pop();
    const r = (u / cols) | 0, c = u - r * cols;
    const ns = [];
    if (r > 0) ns.push(u - cols);
    if (r < rows - 1) ns.push(u + cols);
    if (c > 0) ns.push(u - 1);
    if (c < cols - 1) ns.push(u + 1);
    for (const ni of ns) {
      if (visited[ni]) continue;
      const nr = (ni / cols) | 0, nc = ni - nr * cols;
      if (shade[nr][nc] !== 0) continue;
      visited[ni] = 1;
      stack.push(ni);
    }
  }
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (shade[r][c] === 0 && !visited[r * cols + c]) return false;
  }
  return true;
}

function validate(rows, cols, task, grid) {
  // Rule 1: clue cells must NOT be black (grid emits 0 for them).
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (task[r][c] !== -1 && grid[r][c] === 1) return `rule 1: clue cell (${r},${c}) shaded`;
  }
  // Rule 2: visibility sums.
  const isWhite = (rr, cc) => grid[rr][cc] === 2 || (task[rr][cc] !== -1);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (task[r][c] === -1) continue;
    const K = task[r][c];
    let sum = 1;
    for (let rr = r - 1; rr >= 0 && isWhite(rr, c); rr--) sum++;
    for (let rr = r + 1; rr < rows && isWhite(rr, c); rr++) sum++;
    for (let cc = c - 1; cc >= 0 && isWhite(r, cc); cc--) sum++;
    for (let cc = c + 1; cc < cols && isWhite(r, cc); cc++) sum++;
    if (sum !== K) return `rule 2: clue (${r},${c})=${K} but visibility=${sum}`;
  }
  // Rule 3: no adjacent blacks.
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (grid[r][c] !== 1) continue;
    if (r > 0 && grid[r-1][c] === 1) return `rule 3: blacks (${r-1},${c}) (${r},${c})`;
    if (c > 0 && grid[r][c-1] === 1) return `rule 3: blacks (${r},${c-1}) (${r},${c})`;
  }
  // Rule 4: white connectivity (treat clue cells as whites).
  let anchor = -1;
  for (let r = 0; r < rows && anchor < 0; r++) for (let c = 0; c < cols; c++) {
    if (isWhite(r, c)) { anchor = r * cols + c; break; }
  }
  if (anchor < 0) return null;
  const visited = new Uint8Array(rows * cols);
  visited[anchor] = 1;
  const stack = [anchor];
  while (stack.length) {
    const u = stack.pop();
    const r = (u / cols) | 0, c = u - r * cols;
    const ns = [];
    if (r > 0) ns.push(u - cols);
    if (r < rows - 1) ns.push(u + cols);
    if (c > 0) ns.push(u - 1);
    if (c < cols - 1) ns.push(u + 1);
    for (const ni of ns) {
      if (visited[ni]) continue;
      const nr = (ni / cols) | 0, nc = ni - nr * cols;
      if (!isWhite(nr, nc)) continue;
      visited[ni] = 1;
      stack.push(ni);
    }
  }
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (isWhite(r, c) && !visited[r * cols + c]) return `rule 4: white at (${r},${c}) disconnected`;
  }
  return null;
}

test('KurodokoSolver fuzz: solved boards satisfy all 4 rules', () => {
  KurodokoSolver.clearSolutionCache();
  let solved = 0;
  for (let seed = 1; seed <= 30; seed++) {
    KurodokoSolver.clearSolutionCache();
    const rows = 4 + (seed % 3);
    const cols = 4 + ((seed >> 2) % 3);
    const { task } = generatePuzzle(rows, cols, seed * 9173 + 1);
    const s = new KurodokoSolver({ rows, cols, task, maxMs: 3000 });
    const r = s.solve();
    if (!r.solved) continue;
    const err = validate(rows, cols, task, r.grid);
    assert.equal(err, null, `seed=${seed} ${rows}x${cols}: ${err}`);
    solved++;
  }
  assert.ok(solved >= 10, `expected ≥ 10 solved boards, got ${solved}`);
});
