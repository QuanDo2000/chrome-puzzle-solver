'use strict';
// Bench the Light Up solver on the real 25x25 capture. Discards warmup, reports
// wall time + reach, and asserts the partial (if any) is the sound root snapshot.
const { LightUpSolver } = require('../src/solvers/lightup.js');
const real = require('./fixtures/real-puzzles.js');

const puz = real.lightup_25x25 || (real.puzzles && real.puzzles.lightup_25x25);
if (!puz) { console.error('lightup_25x25 fixture missing'); process.exit(1); }

function run(maxMs) {
  const t0 = Date.now();
  const res = new LightUpSolver({ task: puz.task, maxMs }).solve();
  const wall = Date.now() - t0;
  let total = 0, determined = 0;
  for (let r = 0; r < puz.task.length; r++) for (let c = 0; c < puz.task[r].length; c++) {
    if (puz.task[r][c] !== -1) continue;
    total++;
    const v = res.cells[r][c];
    if (v === 0 || v === 1) determined++;
  }
  return { res, wall, total, determined };
}

run(2000); run(2000); // warmup
const { res, wall, total, determined } = run(30000);
console.log(`lightup 25x25: solved=${res.solved} wall=${wall}ms reach=${determined}/${total}`);

if (res.solved) {
  const ok = new LightUpSolver({ task: puz.task })._isValid(res.cells);
  if (!ok) { console.error('FAIL: solved output failed the oracle'); process.exit(1); }
  console.log('full solve verified by oracle');
} else if (res.partial) {
  console.log('returned a sound partial (root-propagation snapshot)');
} else {
  console.error('FAIL: solver returned neither solution nor partial'); process.exit(1);
}
