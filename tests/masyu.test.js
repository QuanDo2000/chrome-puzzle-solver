'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MasyuSolver } = require('../src/solvers/masyu.js');

// task: "W" white pearl, "B" black pearl, -1 empty.
function mk(task) { return new MasyuSolver({ task, rows: task.length, cols: task[0].length }); }

test('Masyu oracle: 3x3 outer-ring (black corners, white mid-edges) is valid', () => {
  const s = mk([['B','W','B'],['W',-1,'W'],['B','W','B']]);
  const H = [[1,1],[2,2],[1,1]];      // 3x2
  const V = [[1,2,1],[1,2,1]];        // 2x3
  assert.equal(s._isValid(H, V), true);
});

test('Masyu oracle: white pearl that turns is invalid', () => {
  // (0,0) white but the loop turns there -> invalid (also degree issues)
  const s = mk([['W',-1],[-1,-1]]);
  const H = [[1],[2]]; const V = [[1,2]];   // (0,0) has right+bottom = a turn
  assert.equal(s._isValid(H, V), false);
});

test('Masyu oracle: black pearl going straight is invalid', () => {
  const s = mk([[-1,'B',-1]]);
  const H = [[1,1]]; const V = [];           // (0,1) straight horizontal through black
  assert.equal(s._isValid(H, V), false);
});

test('Masyu oracle: a loose end (degree 1) is invalid', () => {
  const s = mk([[-1,-1],[-1,-1]]);
  const H = [[1],[2]]; const V = [[1,2]];    // (0,0) deg2, (0,1) deg1 etc -> not a loop
  assert.equal(s._isValid(H, V), false);
});

test('Masyu oracle: an empty board with no pearls is vacuously valid', () => {
  const s = mk([[-1,-1],[-1,-1]]);
  assert.equal(s._isValid([[2],[2]], [[2,2]]), true);
});

test('Masyu propagation: a white pearl on the top border is forced horizontal', () => {
  const s = mk([[-1,'W',-1],[-1,-1,-1],[-1,-1,-1]]);
  s.H = Array.from({length:3},()=>[0,0]); s.V = Array.from({length:2},()=>[0,0,0]);
  assert.equal(s._propagate(), true);
  // top-row white can't go vertical -> horizontal through: left+right line, bottom cross
  assert.equal(s.H[0][0], 1); assert.equal(s.H[0][1], 1); assert.equal(s.V[0][1], 2);
});

test('Masyu propagation: a black pearl with a committed arm forces its continuation', () => {
  // 5x5 black at (2,2); set the right arm (H[2][2]) line. Black must NOT go straight
  // (opposite edge H[2][1] crossed) and the right arm must continue straight one cell
  // (H[2][3] line, the cell beyond's perpendiculars crossed).
  const task = Array.from({length:5},()=>new Array(5).fill(-1)); task[2][2] = 'B';
  const s = new MasyuSolver({ task, rows: 5, cols: 5 });
  s.H = Array.from({length:5},()=>[0,0,0,0]); s.V = Array.from({length:4},()=>[0,0,0,0,0]);
  s.H[2][2] = 1;
  assert.equal(s._propagate(), true);
  assert.equal(s.H[2][1], 2);   // opposite horizontal edge crossed (no straight-through)
  assert.equal(s.H[2][3], 1);   // right arm continues straight
  assert.equal(s.V[1][3], 2);   // the continuation cell's perpendiculars crossed
  assert.equal(s.V[2][3], 2);
});

test('Masyu propagation: a cell forced to degree 3 is a contradiction', () => {
  const s = mk([[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]]);
  s.H = Array.from({length:3},()=>[0,0]); s.V = Array.from({length:2},()=>[0,0,0]);
  s.H[1][0] = 1; s.H[1][1] = 1; s.V[0][1] = 1; // cell (1,1): left+right+top = 3 lines
  assert.equal(s._propagate(), false);
});

test('Masyu connectivity: a closed loop missing a pearl is a bad sub-loop', () => {
  // 2x3 (H is 2x2, V is 1x3): a closed 2x2 loop on the left cells
  // (H[0][0],H[1][0] line; V[0][0],V[0][1] line), with the pearl at (0,2) left out.
  const s = mk([[-1,-1,'W'],[-1,-1,-1]]);
  s.H = [[1,0],[1,0]]; s.V = [[1,1,0]];
  assert.equal(s._badSubloop(), true);
});

test('Masyu connectivity: an OPEN path is NOT a bad sub-loop (regression)', () => {
  // a path with deg-1 open ends must not be flagged
  const s = mk([[-1,'W',-1,-1],['W',-1,'W',-1],[-1,-1,-1,-1]]);
  s.H = Array.from({length:3},()=>[0,0,0]); s.V = Array.from({length:2},()=>[0,0,0,0]);
  s.H[0][0]=1; s.H[0][1]=1; s.V[0][0]=1; s.V[1][0]=1; s.H[2][0]=1; s.V[0][1]=2;
  assert.equal(s._badSubloop(), false);
});

test('Masyu connectivity: reachability flags pearls split into two components', () => {
  // cross a moat so a pearl can never connect (force isolation)
  const s = mk([['W',-1,'B']]);
  s.H = [[2,2]]; s.V = []; // both horizontal edges crossed -> three isolated cells, pearls unreachable
  assert.equal(s._connOk(), false);
});

// Brute-force ALL line/cross edge assignments (2^edges); keep those passing _isValid.
function bruteForce(task) {
  const rows = task.length, cols = task[0].length;
  const s = new MasyuSolver({ task, rows, cols });
  const total = rows * (cols - 1) + (rows - 1) * cols; const sols = [];
  for (let mask = 0; mask < (1 << total); mask++) {
    const H = [], V = []; let b = 0;
    for (let r = 0; r < rows; r++) { H.push([]); for (let c = 0; c < cols - 1; c++) { H[r].push(((mask >> b) & 1) ? 1 : 2); b++; } }
    for (let r = 0; r < rows - 1; r++) { V.push([]); for (let c = 0; c < cols; c++) { V[r].push(((mask >> b) & 1) ? 1 : 2); b++; } }
    if (s._isValid(H, V)) sols.push({ H, V });
  }
  return sols;
}

function randTask(seed, rows, cols) {
  let x = seed; const rnd = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; };
  const t = []; for (let r = 0; r < rows; r++) { t.push([]); for (let c = 0; c < cols; c++) { const p = rnd(); t[r].push(p < 0.6 ? -1 : (p < 0.8 ? 'W' : 'B')); } } return t;
}

test('Masyu soundness gate: solver matches brute-force across 400 random 3x4 boards', () => {
  let mism = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const t = randTask(seed, 3, 4);
    const sols = bruteForce(t);
    const res = new MasyuSolver({ task: t, rows: 3, cols: 4, maxMs: 3000 }).solve();
    if (res.solved !== (sols.length > 0)) { mism++; continue; }
    if (res.solved && !new MasyuSolver({ task: t, rows: 3, cols: 4 })._isValid(res.horizontal, res.vertical)) mism++;
  }
  assert.equal(mism, 0);
});

test('Masyu soundness: root deduction never prunes an edge a solution uses', () => {
  for (let seed = 1; seed <= 120; seed++) {
    const t = randTask(seed, 3, 4); const sols = bruteForce(t); if (!sols.length) continue;
    const s = new MasyuSolver({ task: t, rows: 3, cols: 4 });
    s.H = Array.from({length:3},()=>[0,0,0]); s.V = Array.from({length:2},()=>[0,0,0,0]);
    s._deadline = Date.now() + 3000;
    assert.ok(s._propagate(), `propagation contradicted a solvable board seed ${seed}`);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) { const v = s.H[r][c]; if (v !== 0) for (const sol of sols) assert.equal(sol.H[r][c], v, `H prune seed ${seed}`); }
    for (let r = 0; r < 2; r++) for (let c = 0; c < 4; c++) { const v = s.V[r][c]; if (v !== 0) for (const sol of sols) assert.equal(sol.V[r][c], v, `V prune seed ${seed}`); }
  }
});

test('Masyu solve: 3x3 outer-ring board solves to a valid loop', () => {
  const t = [['B','W','B'],['W',-1,'W'],['B','W','B']];
  const res = new MasyuSolver({ task: t, rows: 3, cols: 3, maxMs: 5000 }).solve();
  assert.equal(res.solved, true);
  assert.ok(new MasyuSolver({ task: t, rows: 3, cols: 3 })._isValid(res.horizontal, res.vertical));
});
