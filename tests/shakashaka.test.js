'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ShakashakaSolver } = require('../src/solvers/shakashaka.js');

function popcount(x) { let n = 0; while (x) { x &= x - 1; n++; } return n; }

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
  const _s = mk([[-1, -1]]);   // 1 row -> t<H-1 is false for both, so the "need t<H-1" returns violation
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

test('Shakashaka solve: 25x25 real fixture returns solved or sound partial (never throws)', () => {
  const fixtures = require('./fixtures/real-puzzles.js');
  const { task } = fixtures.shakashaka_25x25;
  const res = new ShakashakaSolver({ task, maxMs: 30000 }).solve();
  // Must not throw; must return an object with solved or partial flag
  assert.ok(res !== null && typeof res === 'object', '25x25 must return a result object');
  assert.ok(res.solved === true || res.partial === true, '25x25 must be solved or partial');
  if (res.solved) {
    const chk = new ShakashakaSolver({ task });
    assert.equal(chk._isValid(res.cells), true, '25x25 solved output must be valid');
  }
  if (res.partial) {
    assert.ok(res.cells !== null && Array.isArray(res.cells), '25x25 partial must have cells array');
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

test('Shakashaka GAC: prunes a triangle impossible by a border (bottom-row T1)', () => {
  // A 2-row board: a T1 needs a down-neighbour; on the BOTTOM row T1 is impossible.
  const s = new ShakashakaSolver({ task: [[-1,-1],[-1,-1]] });
  s._initDomains();
  s._gacPropagate();
  // bottom row (r=1): T1 (bit 1) must be pruned from both cells' domains
  assert.equal((s._dom[1][0] >> 1) & 1, 0, 'bottom-left domain must not contain T1');
  assert.equal((s._dom[1][1] >> 1) & 1, 0, 'bottom-right domain must not contain T1');
});

test('Shakashaka GAC: never prunes a value used by a valid solution (brute-force gate)', () => {
  // Small boards (<= 8 open cells -> brute force is fast). Includes boards where
  // GAC actively deduces (the 2x4/2x3-with-black solve uniquely) so the no-prune
  // check is not vacuous, plus multi-solution boards.
  const boards = [
    [[-1,-1],[-1,-1]],                  // 2x2, 4 open, 2 solutions
    [[-2,-1,-1],[-1,-1,-1],[-1,-1,-1]], // 3x3 corner-black, 8 open, 2 solutions
    [[-1,-1,-1,-1],[-2,-1,-1,-2]],      // 2x4, 6 open, unique solution, GAC deduces
    [[-1,-1,-1],[-2,-1,-1]],            // 2x3, 5 open, unique solution, GAC deduces
  ];
  for (const task of boards) {
    const all = bruteForce(task);
    const s = new ShakashakaSolver({ task });
    s._initDomains();
    s._gacPropagate(); // may wipe out only if unsat
    for (let r = 0; r < task.length; r++) for (let c = 0; c < task[0].length; c++) {
      if (task[r][c] !== -1) continue;
      for (let v = 0; v <= 4; v++) {
        const possibleInSomeSolution = all.some(sol => sol[r][c] === v);
        if (possibleInSomeSolution) {
          assert.ok((s._dom[r][c] >> v) & 1, `GAC wrongly pruned (${r},${c})=${v} which a valid solution uses`);
        }
      }
    }
  }
});

test('Shakashaka _deduceAll: GAC-only fixpoint never makes a solvable board UNSAT', () => {
  // Solvable board (has brute-force solutions) with a black cell; GAC must not
  // spuriously wipe a domain. (The plan's original 3x3 center-black board is in
  // fact UNSAT, so a GAC wipeout there is sound — use an actually-solvable one.)
  const task = [[-2,-1,-1],[-1,-1,-1],[-1,-1,-1]];
  assert.ok(bruteForce(task).length > 0, 'fixture must be solvable');
  const s = new ShakashakaSolver({ task });
  s._initDomains();
  assert.equal(s._deduceAll(0), true); // no wipeout on a solvable board
});

test('Shakashaka bifurcation: _deduceAll with Tier-2 never prunes a valid value (brute-force)', () => {
  // Small boards (<= 9 open cells). E/G solve uniquely and bifurcation deduces
  // several cells, so the no-prune check exercises real pruning; the 3x3 all-open
  // and corner-black boards have multiple solutions.
  const boards = [
    [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]], // 3x3 all-open, 9 open
    [[-2,-1,-1],[-1,-1,-1],[-1,-1,-1]], // 3x3 corner-black, 8 open
    [[-1,-1,-1,-1],[-2,-1,-1,-2]],      // 2x4, 6 open, unique, bifurcation deduces
    [[-1,-1,-1],[-2,-1,-1]],            // 2x3, 5 open, unique, bifurcation deduces
  ];
  for (const task of boards) {
    const all = bruteForce(task);
    const s = new ShakashakaSolver({ task });
    s._initDomains();
    s._deduceAll(0); // GAC + bifurcation
    for (let r = 0; r < task.length; r++) for (let c = 0; c < task[0].length; c++) {
      if (task[r][c] !== -1) continue;
      for (let v = 0; v <= 4; v++) {
        if (all.some(sol => sol[r][c] === v)) {
          assert.ok((s._dom[r][c] >> v) & 1, `bifurcation wrongly pruned (${r},${c})=${v}`);
        }
      }
    }
  }
});

test('Shakashaka bifurcation: forced cells hold in every solution', () => {
  // 2x4 with two black corners: 6 open, a unique solution, bifurcation deduces
  // several cells -> a meaningful forced-cell check (fast: 5^6 brute force).
  const task = [[-1,-1,-1,-1],[-2,-1,-1,-2]];
  const all = bruteForce(task);
  const s = new ShakashakaSolver({ task });
  s._initDomains(); s._deduceAll(0);
  for (let r = 0; r < task.length; r++) for (let c = 0; c < task[0].length; c++) {
    if (task[r][c] !== -1) continue;
    if (popcount(s._dom[r][c]) === 1) {
      let v = 0, m = s._dom[r][c]; while (m > 1) { m >>= 1; v++; }
      for (const sol of all) assert.equal(sol[r][c], v, `forced (${r},${c})=${v} must hold in all solutions`);
    }
  }
});
