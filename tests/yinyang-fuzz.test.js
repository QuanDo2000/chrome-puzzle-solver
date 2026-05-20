const test = require('node:test');
const assert = require('node:assert');
const { YinYangSolver } = require('../solver.js');

// Independent validator: a solved board must be fully placed, free of
// illegal 2x2 windows, and each colour must form exactly one connected
// region.
function isValidYinYang(grid, rows, cols) {
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (grid[r][c] !== 1 && grid[r][c] !== 2) return false;
    }
  }
  for (let r = 0; r + 1 < rows; r++) {
    for (let c = 0; c + 1 < cols; c++) {
      const a = grid[r][c], b = grid[r][c + 1];
      const d = grid[r + 1][c], e = grid[r + 1][c + 1];
      const mono = a === b && b === d && d === e;
      const checker = a === e && b === d && a !== b;
      if (mono || checker) return false;
    }
  }
  return components(grid, rows, cols, 1) === 1 &&
         components(grid, rows, cols, 2) === 1;
}

function components(grid, rows, cols, color) {
  const seen = Array.from({ length: rows }, () => new Array(cols).fill(false));
  let count = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (grid[r][c] !== color || seen[r][c]) continue;
      count++;
      const stack = [[r, c]];
      seen[r][c] = true;
      while (stack.length) {
        const [cr, cc] = stack.pop();
        for (const [nr, nc] of [[cr - 1, cc], [cr + 1, cc], [cr, cc - 1], [cr, cc + 1]]) {
          if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
          if (grid[nr][nc] === color && !seen[nr][nc]) {
            seen[nr][nc] = true;
            stack.push([nr, nc]);
          }
        }
      }
    }
  }
  return count;
}

function respectsTask(grid, task, rows, cols) {
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const g = task[r][c];
      if (g === 1 && grid[r][c] !== 1) return false;
      if (g === 0 && grid[r][c] !== 2) return false;
    }
  }
  return true;
}

// Deterministic LCG so failures reproduce.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

test('YinYangSolver fuzz: every solved board is independently valid', () => {
  const rng = makeRng(0xC0FFEE);
  for (let iter = 0; iter < 400; iter++) {
    const rows = 4 + Math.floor(rng() * 3); // 4..6
    const cols = 4 + Math.floor(rng() * 3);
    const task = Array.from({ length: rows }, () => new Array(cols).fill(-1));
    const givenCount = Math.floor(rng() * (rows * cols * 0.4));
    for (let g = 0; g < givenCount; g++) {
      const r = Math.floor(rng() * rows);
      const c = Math.floor(rng() * cols);
      task[r][c] = rng() < 0.5 ? 0 : 1;
    }
    YinYangSolver.clearSolutionCache();
    const s = new YinYangSolver({ rows, cols, task });
    s.maxMs = 2000;
    const result = s.solve();
    if (result.solved) {
      assert.ok(isValidYinYang(result.grid, rows, cols),
        `iter ${iter}: solver returned an invalid board`);
      assert.ok(respectsTask(result.grid, task, rows, cols),
        `iter ${iter}: solver ignored a given`);
    }
  }
});

test('YinYangSolver fuzz: 4x4 completeness cross-check vs brute force', () => {
  const rows = 4, cols = 4, N = 16;
  // Enumerate every 2-colouring of a 4x4; keep the valid ones.
  const validBoards = [];
  for (let mask = 0; mask < (1 << N); mask++) {
    const grid = [];
    for (let r = 0; r < rows; r++) {
      const row = [];
      for (let c = 0; c < cols; c++) {
        row.push(((mask >> (r * cols + c)) & 1) ? 1 : 2);
      }
      grid.push(row);
    }
    if (isValidYinYang(grid, rows, cols)) validBoards.push(grid);
  }
  assert.ok(validBoards.length > 0, 'there must be valid 4x4 boards');

  const rng = makeRng(0x1234);
  for (let iter = 0; iter < 200; iter++) {
    // Pick a random valid board, derive a random given-subset from it.
    const board = validBoards[Math.floor(rng() * validBoards.length)];
    const task = Array.from({ length: rows }, () => new Array(cols).fill(-1));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (rng() < 0.45) task[r][c] = board[r][c] === 1 ? 1 : 0;
      }
    }
    // A solution exists (the board it came from). The solver must find one,
    // and it must be valid + respect the givens.
    YinYangSolver.clearSolutionCache();
    const result = new YinYangSolver({ rows, cols, task }).solve();
    assert.equal(result.solved, true, `iter ${iter}: solver failed a solvable board`);
    assert.ok(isValidYinYang(result.grid, rows, cols),
      `iter ${iter}: solver returned an invalid board`);
    assert.ok(respectsTask(result.grid, task, rows, cols),
      `iter ${iter}: solver ignored a given`);
  }
});
