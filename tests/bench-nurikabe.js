'use strict';
const { NurikabeSolver } = require('../solver.js');
const fixture = require('./fixtures/real-puzzles.js').nurikabe5x5EasyReal;

const ITERATIONS = 5;
const WARMUP = 2;
const times = [];
for (let i = 0; i < WARMUP + ITERATIONS; i++) {
  NurikabeSolver.clearSolutionCache();
  const s = new NurikabeSolver({
    rows: fixture.rows,
    cols: fixture.cols,
    task: fixture.task,
  });
  const t0 = process.hrtime.bigint();
  const r = s.solve();
  const t1 = process.hrtime.bigint();
  if (!r.solved) { console.error('nurikabe5x5EasyReal failed to solve'); process.exit(1); }
  if (i >= WARMUP) times.push(Number(t1 - t0) / 1e6);
}
times.sort((a, b) => a - b);
console.log(`nurikabe5x5EasyReal: median ${times[Math.floor(times.length / 2)].toFixed(2)} ms over ${ITERATIONS} runs`);
