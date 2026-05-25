'use strict';
const { MosaicSolver } = require('../solver.js');
const fixture = require('./fixtures/real-puzzles.js').mosaic5x5EasyReal;

const ITERATIONS = 5;
const WARMUP = 2;
const times = [];
for (let i = 0; i < WARMUP + ITERATIONS; i++) {
  MosaicSolver.clearSolutionCache();
  const s = new MosaicSolver({
    rows: fixture.rows,
    cols: fixture.cols,
    task: fixture.task,
  });
  const t0 = process.hrtime.bigint();
  const r = s.solve();
  const t1 = process.hrtime.bigint();
  if (!r.solved) { console.error('mosaic5x5EasyReal failed to solve'); process.exit(1); }
  if (i >= WARMUP) times.push(Number(t1 - t0) / 1e6);
}
times.sort((a, b) => a - b);
console.log(`mosaic5x5EasyReal: median ${times[Math.floor(times.length / 2)].toFixed(2)} ms over ${ITERATIONS} runs`);
