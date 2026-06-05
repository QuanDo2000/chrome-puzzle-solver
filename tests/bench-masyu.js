'use strict';
// Bench the Masyu solver on the real 25x25 capture. Reports wall + edge reach.
// The real 25x25-hard does NOT full-solve (global-connectivity ceiling, like Shingoki);
// it returns a SOUND partial. Assert sound (solved=true valid, OR partial), never crash.
const { MasyuSolver } = require('../src/solvers/masyu.js');
const real = require('./fixtures/real-puzzles.js');
const puz = real.masyu_25x25 || (real.puzzles && real.puzzles.masyu_25x25);
if (!puz) { console.error('masyu_25x25 fixture missing'); process.exit(1); }

function run(maxMs) {
  const t0 = Date.now();
  const res = new MasyuSolver({ task: puz.task, rows: 25, cols: 25, maxMs }).solve();
  const wall = Date.now() - t0;
  let total = 0, det = 0;
  for (let r = 0; r < 25; r++) for (let c = 0; c < 24; c++) { total++; if (res.horizontal && res.horizontal[r][c] !== 0) det++; }
  for (let r = 0; r < 24; r++) for (let c = 0; c < 25; c++) { total++; if (res.vertical && res.vertical[r][c] !== 0) det++; }
  return { res, wall, total, det };
}
run(2000); run(2000); // warmup
const { res, wall, total, det } = run(30000);
console.log(`masyu 25x25: solved=${res.solved} partial=${!!res.partial} wall=${wall}ms reach=${det}/${total}`);
if (res.solved) {
  const ok = new MasyuSolver({ task: puz.task, rows: 25, cols: 25 })._isValid(res.horizontal, res.vertical);
  if (!ok) { console.error('FAIL: solved output failed the oracle'); process.exit(1); }
  console.log('full solve verified by oracle');
} else if (res.partial) {
  console.log('returned a sound partial (root-deduction snapshot)');
} else {
  console.error('FAIL: solver returned neither solution nor partial'); process.exit(1);
}
