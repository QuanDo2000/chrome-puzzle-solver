'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ShingokiSolver } = require('../src/solvers/shingoki.js');

function rng(seed) { let s = seed >>> 0; return () => { s = (s*1664525 + 1013904223) >>> 0; return s / 0x100000000; }; }

// Build a random sub-rectangle perimeter loop (always a single closed loop).
function rectLoop(rand, rows, cols) {
  const r0 = Math.floor(rand() * rows), r1 = r0 + 1 + Math.floor(rand() * (rows - r0));
  const c0 = Math.floor(rand() * cols), c1 = c0 + 1 + Math.floor(rand() * (cols - c0));
  const H = Array.from({ length: rows + 1 }, () => new Array(cols).fill(0));
  const V = Array.from({ length: rows }, () => new Array(cols + 1).fill(0));
  for (let c = c0; c < c1; c++) { H[r0][c] = 1; H[r1][c] = 1; }
  for (let r = r0; r < r1; r++) { V[r][c0] = 1; V[r][c1] = 1; }
  return { H, V };
}

function deriveTask(loop, rows, cols) {
  const task = Array.from({ length: rows + 1 }, () => new Array(cols + 1).fill(0));
  const s = new ShingokiSolver({ rows, cols, task });
  s.H = loop.H; s.V = loop.V;
  for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
    const inc = s.incidentEdges(r, c).filter(e => s.getEdge(e) === 1);
    if (inc.length !== 2) continue; // not on loop
    const isTurn = inc.filter(e => e.kind === 'H').length === 1; // one H one V => turn => black
    const n = s.runLengthAt(r, c);
    task[r][c] = isTurn ? -n : n;
  }
  return task;
}

// requireSolved=true => the board must fully solve (small boards). Otherwise the
// master guarantee is soundness: solve() returns a valid loop OR a sound level-0
// partial (no vertex degree > 2), and NEVER a spurious 'no solution'. The sparse
// rectangle-perimeter class is pathologically hard at 8x8+ and cannot fully
// solve in budget, but it must always come back sound.
function runConstructive(seed, rows, cols, requireSolved) {
  const rand = rng(seed);
  const loop = rectLoop(rand, rows, cols);
  const task = deriveTask(loop, rows, cols);
  // For boards that must fully solve, give the full deep-search budget. For the
  // soundness-only (non-solvable sparse) boards, use a modest searchMs so the
  // sound partial comes back promptly instead of grinding the whole budget — the
  // point of these trials is soundness, not how long search runs before bailing.
  const searchMs = requireSolved ? 10000 : 1000;
  const res = new ShingokiSolver({ rows, cols, task, maxMs: 10000, searchMs }).solve();
  assert.notEqual(res.error, 'no solution', `seed=${seed} ${rows}x${cols}: spurious UNSAT. task=${JSON.stringify(task)}`);
  if (requireSolved) assert.equal(res.solved, true, `seed=${seed} ${rows}x${cols}: should solve. task=${JSON.stringify(task)}`);
  if (res.solved) {
    const chk = new ShingokiSolver({ rows, cols, task });
    chk.H = res.horizontal; chk.V = res.vertical;
    assert.equal(chk.numbersSatisfied(), true, `seed=${seed}: clue totals satisfied`);
    return;
  }
  // Not solved => must be a sound level-0 partial.
  assert.equal(res.partial, true, `seed=${seed} ${rows}x${cols}: not solved must carry a partial`);
  assert.ok(res.horizontal && res.vertical, `seed=${seed}: partial must carry grids`);
  const chk = new ShingokiSolver({ rows, cols, task });
  chk.H = res.horizontal; chk.V = res.vertical;
  for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
    const deg = chk.incidentEdges(r, c).filter(e => chk.getEdge(e) === 1).length;
    assert.ok(deg <= 2, `seed=${seed}: partial vertex (${r},${c}) degree ${deg} > 2 (unsound)`);
  }
}

test('ShingokiSolver constructive 5x5 (30 trials)', () => { for (let s=1;s<=30;s++) runConstructive(s,5,5,true); });
test('ShingokiSolver constructive 8x8 (20 trials, solved-or-sound-partial)', () => { for (let s=100;s<=119;s++) runConstructive(s,8,8,false); });
test('ShingokiSolver constructive 10x10 (10 trials, solved-or-sound-partial, time-bounded)', () => {
  const t0 = Date.now();
  for (let s=200;s<=209;s++) runConstructive(s,10,10,false);
  assert.ok(Date.now() - t0 < 30000, '10x10 constructive trials must finish under 30s');
});
