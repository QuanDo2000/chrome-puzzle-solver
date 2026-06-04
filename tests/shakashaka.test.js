'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ShakashakaSolver } = require('../src/solvers/shakashaka.js');

// Build a solver over a task grid (-1 open, -2 black, 0..4 numbered black).
function mk(task) { return new ShakashakaSolver({ task }); }

test('Shakashaka oracle: taskMarkedCount counts adjacent triangles', () => {
  // 1x3: black-numbered at (0,1) with two open neighbours.
  const s = mk([[-1, 0, -1]]);
  // board-state grid: open cells set to triangle(1) / white(0)
  const board = [[1, -1, 0]]; // left triangle, center black, right white
  assert.equal(s._taskMarkedCount(board, 0, 1), 1);
  const board2 = [[1, -1, 2]];
  assert.equal(s._taskMarkedCount(board2, 0, 1), 2);
});

test('Shakashaka oracle: hasNonRect flags a triangle with a wrong right neighbour', () => {
  // T1 at (0,0) requires right neighbour == T2 (it is T3 -> violation).
  const s = mk([[-1, -1]]);
  const board = [[1, 3]];
  assert.ok(s._hasNonRectAt(board, 0, 0)); // T1's right must be 2
});

test('Shakashaka oracle: hasNonRect accepts a valid T1/T2 pairing', () => {
  // T1 then T2 horizontally, with borders below -> need to satisfy down rule too.
  // Use a 2-wide, check the per-cell predicate for the T1 cell on a board where
  // right=2 and down is white at the edge (t<H-1 false -> border ok path).
  const s = mk([[-1, -1]]);   // 1 row -> t<H-1 is false for both, so the "need t<H-1" returns violation
  // On a 1-row board T1 violates (needs a down neighbour). Use 2 rows:
  const s2 = mk([[-1, -1], [-1, -1]]);
  // board where (0,0)=T1, (0,1)=T2, (1,0)=T4, (1,1)=T3 forms a closed diamond (valid).
  const board = [[1, 2], [4, 3]];
  assert.equal(s2._hasNonRectAt(board, 0, 0), false);
  assert.equal(s2._hasNonRectAt(board, 0, 1), false);
  assert.equal(s2._hasNonRectAt(board, 1, 0), false);
  assert.equal(s2._hasNonRectAt(board, 1, 1), false);
});

test('Shakashaka oracle: a 2x2 diamond of triangles is a fully valid board', () => {
  const s = mk([[-1, -1], [-1, -1]]);
  const board = [[1, 2], [4, 3]];
  assert.equal(s._hasNonRect(board), false);    // no cell violates
});

function bruteForce(task) {
  const s = new ShakashakaSolver({ task });
  const rows = task.length, cols = task[0].length;
  const open = [];
  const board = task.map(row => row.map(v => (v === -1 ? 0 : -1)));
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (task[r][c] === -1) open.push([r, c]);
  const sols = [];
  const rec = (i) => {
    if (i === open.length) { if (s._isValid(board)) sols.push(board.map(row => row.slice())); return; }
    const [r, c] = open[i];
    for (let v = 0; v <= 4; v++) { board[r][c] = v; rec(i + 1); }
    board[r][c] = 0;
  };
  rec(0);
  return sols;
}

test('Shakashaka brute-force: a tiny board has a known solution count', () => {
  // 2x2 all-open: enumerate; assert at least the diamond [[1,2],[4,3]] is found.
  const sols = bruteForce([[-1,-1],[-1,-1]]);
  assert.ok(sols.length >= 1);
  assert.ok(sols.some(b => b[0][0]===1 && b[0][1]===2 && b[1][0]===4 && b[1][1]===3));
});

test('Shakashaka solve: solves a tiny board to a valid board', () => {
  const task = [[-1,-1],[-1,-1]];
  const res = new ShakashakaSolver({ task, maxMs: 5000 }).solve();
  assert.equal(res.solved, true);
  const chk = new ShakashakaSolver({ task });
  assert.equal(chk._isValid(res.cells), true);
});

test('Shakashaka solve: never spurious-UNSAT + matches brute-force on small boards', () => {
  // Several small satisfiable boards (mix of open + numbered/black).
  const boards = [
    [[-1,-1],[-1,-1]],
    [[-1,-1,-1],[-1,-2,-1],[-1,-1,-1]],
    [[-1,0,-1],[-1,-1,-1]],
    [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  ];
  for (const task of boards) {
    const all = bruteForce(task);
    const res = new ShakashakaSolver({ task, maxMs: 10000 }).solve();
    if (all.length === 0) { assert.notEqual(res.solved, true); continue; }
    assert.equal(res.solved, true, 'solvable board must solve');
    const chk = new ShakashakaSolver({ task });
    assert.equal(chk._isValid(res.cells), true, 'solver output must be valid');
  }
});

test('Shakashaka solve: random small-board fuzz cross-check vs brute-force', () => {
  // Deterministic LCG so failures reproduce.
  let seed = 0x12345678;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = (rows, cols) => {
    const task = [];
    for (let r = 0; r < rows; r++) {
      const row = [];
      for (let c = 0; c < cols; c++) {
        const u = rnd();
        if (u < 0.6) row.push(-1);          // open
        else if (u < 0.8) row.push(-2);     // black no-number
        else row.push(Math.floor(rnd() * 5)); // numbered 0..4
      }
      task.push(row);
    }
    return task;
  };
  const dims = [[3,3],[3,4],[4,3]];
  for (let iter = 0; iter < 40; iter++) {
    const [rows, cols] = dims[iter % dims.length];
    const task = pick(rows, cols);
    const all = bruteForce(task);
    const res = new ShakashakaSolver({ task, maxMs: 10000 }).solve();
    if (all.length === 0) {
      assert.notEqual(res.solved, true, `iter ${iter}: solver must not claim solve when UNSAT`);
    } else {
      assert.equal(res.solved, true, `iter ${iter}: solvable board must solve`);
      const chk = new ShakashakaSolver({ task });
      assert.equal(chk._isValid(res.cells), true, `iter ${iter}: solver output must be valid`);
    }
    // forced-cell soundness: deduced singletons must hold in every solution
    const det = new ShakashakaSolver({ task })._deduceOnly();
    if (det.ok && all.length > 0) {
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        if (task[r][c] !== -1) continue;
        if (det.cells[r][c] !== 9) {
          for (const sol of all) assert.equal(sol[r][c], det.cells[r][c], `iter ${iter}: forced (${r},${c}) must hold in all solutions`);
        }
      }
    }
  }
});

test('Shakashaka solve: forced cells hold in every solution (propagation soundness)', () => {
  // For a board, the cells the solver decides BEFORE any branch (pure propagation)
  // must match all brute-force solutions. Exposed via solveDeduce() (propagation
  // to fixpoint, no search) returning the determined board.
  const task = [[-1,-1,-1],[-1,-2,-1],[-1,-1,-1]];
  const all = bruteForce(task);
  const det = new ShakashakaSolver({ task })._deduceOnly(); // {cells, ok}
  if (det.ok) for (let r=0;r<task.length;r++) for (let c=0;c<task[0].length;c++) {
    if (task[r][c] !== -1) continue;
    if (det.cells[r][c] !== 9) { // decided
      for (const sol of all) assert.equal(sol[r][c], det.cells[r][c], `forced (${r},${c}) must hold in all solutions`);
    }
  }
});
