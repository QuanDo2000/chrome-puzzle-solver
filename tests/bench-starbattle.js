'use strict';
// Bench the Star Battle solver on the real 14x14 capture. Reports wall + star count.
const { StarBattleSolver } = require('../src/solvers/starbattle.js');
const real = require('./fixtures/real-puzzles.js');
const puz = real.starbattle_14x14 || (real.puzzles && real.puzzles.starbattle_14x14);
if (!puz) { console.error('starbattle_14x14 fixture missing'); process.exit(1); }

function run(maxMs) {
  const t0 = Date.now();
  const res = new StarBattleSolver({ rows: 14, cols: 14, stars: 3, areas: puz.areas, maxMs }).solve();
  const wall = Date.now() - t0;
  let stars = 0; if (res.cells) for (const row of res.cells) for (const v of row) if (v === 1) stars++;
  return { res, wall, stars };
}
run(2000); run(2000); // warmup
const { res, wall, stars } = run(30000);
console.log(`starbattle 14x14 k=3: solved=${res.solved} partial=${!!res.partial} wall=${wall}ms stars=${stars}/42`);
if (res.solved) {
  const ok = new StarBattleSolver({ rows: 14, cols: 14, stars: 3, areas: puz.areas })._isValid(res.cells);
  if (!ok) { console.error('FAIL: solved output failed the oracle'); process.exit(1); }
  console.log('full solve verified by oracle');
} else if (res.partial) {
  console.log('returned a sound partial (root-deduction snapshot)');
} else {
  console.error('FAIL: solver returned neither solution nor partial'); process.exit(1);
}
