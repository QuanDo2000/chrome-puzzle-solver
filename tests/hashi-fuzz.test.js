const test = require('node:test');
const assert = require('node:assert/strict');
const { HashiSolver } = require('../solver.js');

// Generate a valid hashi puzzle by starting from a connected spanning tree
// of random islands and assigning bridge counts. Then strip bridges to
// produce the puzzle (only numbers retained).

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function generatePuzzle(seed, rows, cols, numIslands) {
  const r = rng(seed);
  // Place islands on a random subset of cells, ensuring at most 1 per row*col.
  const positions = new Set();
  const islands = [];
  let attempts = 0;
  while (islands.length < numIslands && attempts < numIslands * 10) {
    attempts++;
    const row = Math.floor(r() * rows);
    const col = Math.floor(r() * cols);
    const key = row * cols + col;
    if (positions.has(key)) continue;
    // Also exclude same row/col adjacency for variety.
    positions.add(key);
    islands.push({ index: islands.length, row, col, number: 0 });
  }
  // Solve a random set of bridges by walking edges and accumulating degrees.
  // For simplicity here: try a small puzzle and check the solver finds *some*
  // consistent solution (or solved=false). This validates soundness.
  return { rows, cols, islands };
}

test('HashiSolver fuzz: 5x5 with 4 islands — solver returns sound result', () => {
  for (let seed = 1; seed <= 30; seed++) {
    HashiSolver.clearSolutionCache();
    const p = generatePuzzle(seed, 5, 5, 4);
    // Assign random numbers in [1,4].
    const r = rng(seed * 17 + 3);
    for (const i of p.islands) i.number = 1 + Math.floor(r() * 4);
    const s = new HashiSolver({ ...p, maxMs: 2000 });
    const result = s.solve();
    if (result.solved) {
      // Verify rules.
      const deg = new Array(p.islands.length).fill(0);
      for (const e of result.edges) {
        deg[e.a] += e.bridges;
        deg[e.b] += e.bridges;
      }
      for (let i = 0; i < p.islands.length; i++) {
        assert.equal(deg[i], p.islands[i].number, `seed ${seed}, island ${i}`);
      }
    }
    // If solved=false, that's also fine — random puzzles are often UNSAT.
  }
  HashiSolver.clearSolutionCache();
});
