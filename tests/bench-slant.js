'use strict';
// Bench the Slant solver on the real 20x20 capture. Reports wall + cell reach.
const { SlantSolver } = require('../src/solvers/slant.js');
const real = require('./fixtures/real-puzzles.js');
const puz = real.slant_20x20 || (real.puzzles && real.puzzles.slant_20x20);
if (!puz) { console.error('slant_20x20 fixture missing'); process.exit(1); }

function run(maxMs) {
  const t0 = Date.now();
  const res = new SlantSolver({ task: puz.task, rows: 20, cols: 20, maxMs }).solve();
  const wall = Date.now() - t0;
  let total = 0, det = 0;
  for (let r = 0; r < 20; r++) for (let c = 0; c < 20; c++) { total++; if (res.cells && (res.cells[r][c] === 1 || res.cells[r][c] === 2)) det++; }
  return { res, wall, total, det };
}
run(2000); run(2000); // warmup
const { res, wall, total, det } = run(30000);
console.log(`slant 20x20: solved=${res.solved} partial=${!!res.partial} wall=${wall}ms reach=${det}/${total}`);
if (res.solved) {
  const ok = new SlantSolver({ task: puz.task, rows: 20, cols: 20 })._isValid(res.cells);
  if (!ok) { console.error('FAIL: solved output failed the oracle'); process.exit(1); }
  console.log('full solve verified by oracle');
} else if (res.partial) {
  console.log('returned a sound partial (root-deduction snapshot)');
} else {
  console.error('FAIL: solver returned neither solution nor partial'); process.exit(1);
}
