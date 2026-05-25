'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { HitoriSolver } = require('../solver.js');

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

// Generate a solvable Hitori puzzle:
// 1. Build a Latin square so every row and column has unique values.
// 2. Build a valid shading (no adjacent blacks, whites connected).
// 3. For each shaded cell overwrite its value with a duplicate from its row,
//    so the intended shading IS the unique valid solution.
function generatePuzzle(rows, cols, seed) {
  let rng = seed >>> 0;
  const rand = () => {
    rng = (rng * 1103515245 + 12345) >>> 0;
    return rng / 0x100000000;
  };

  // Latin square via cyclic shifts + random row/col permutations
  const n = Math.max(rows, cols);
  const base = Array.from({ length: n }, (_, i) => i + 1);
  const rowPerm = Array.from({ length: rows }, (_, i) => i);
  for (let i = rows - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [rowPerm[i], rowPerm[j]] = [rowPerm[j], rowPerm[i]];
  }
  const colPerm = Array.from({ length: cols }, (_, i) => i);
  for (let i = cols - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [colPerm[i], colPerm[j]] = [colPerm[j], colPerm[i]];
  }
  const latin = Array.from({ length: rows }, (_, r) =>
    colPerm.map(c => base[(rowPerm[r] + c) % n])
  );

  // Build a random valid shading
  const shade = Array.from({ length: rows }, () => new Array(cols).fill(0));
  const cells = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push([r, c]);
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  for (const [r, c] of cells) {
    if (rand() > 0.35) continue;
    if (r > 0 && shade[r - 1][c] === 1) continue;
    if (r < rows - 1 && shade[r + 1][c] === 1) continue;
    if (c > 0 && shade[r][c - 1] === 1) continue;
    if (c < cols - 1 && shade[r][c + 1] === 1) continue;
    shade[r][c] = 1;
    if (!whitesConnected(shade, rows, cols)) shade[r][c] = 0;
  }

  // Build task: unshaded cells keep their Latin-square value;
  // shaded cells copy a value from an unshaded cell in the same row
  // so the row has a duplicate (required for the cell to be shadeable).
  const task = latin.map(row => [...row]);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (shade[r][c] !== 1) continue;
      for (let c2 = 0; c2 < cols; c2++) {
        if (shade[r][c2] === 0) { task[r][c] = task[r][c2]; break; }
      }
    }
  }
  return { task };
}

function validate(rows, cols, task, grid) {
  for (let r = 0; r < rows; r++) {
    const seen = new Set();
    for (let c = 0; c < cols; c++) {
      if (grid[r][c] !== 2) continue;
      const v = task[r][c];
      if (seen.has(v)) return `rule 1 row: duplicate ${v} at (${r},${c})`;
      seen.add(v);
    }
  }
  for (let c = 0; c < cols; c++) {
    const seen = new Set();
    for (let r = 0; r < rows; r++) {
      if (grid[r][c] !== 2) continue;
      const v = task[r][c];
      if (seen.has(v)) return `rule 1 col: duplicate ${v} at (${r},${c})`;
      seen.add(v);
    }
  }
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (grid[r][c] !== 1) continue;
    if (r > 0 && grid[r - 1][c] === 1) return `rule 2 at (${r - 1},${c})-(${r},${c})`;
    if (c > 0 && grid[r][c - 1] === 1) return `rule 2 at (${r},${c - 1})-(${r},${c})`;
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
    if (grid[r][c] === 2 && !visited[r * cols + c]) return `rule 3: white at (${r},${c}) disconnected`;
  }
  return null;
}

test('HitoriSolver fuzz: solved boards satisfy all 3 rules', () => {
  HitoriSolver.clearSolutionCache();
  let solved = 0;
  for (let seed = 1; seed <= 30; seed++) {
    HitoriSolver.clearSolutionCache();
    const rows = 4 + (seed % 3);
    const cols = 4 + ((seed >> 2) % 3);
    const { task } = generatePuzzle(rows, cols, seed * 9173 + 1);
    const s = new HitoriSolver({ rows, cols, task, maxMs: 2000 });
    const r = s.solve();
    if (!r.solved) continue;
    const err = validate(rows, cols, task, r.grid);
    assert.equal(err, null, `seed=${seed} ${rows}x${cols}: ${err}`);
    solved++;
  }
  assert.ok(solved >= 10, `expected ≥ 10 solved boards, got ${solved}`);
});
