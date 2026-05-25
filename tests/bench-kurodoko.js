'use strict';
const { KurodokoSolver } = require('../solver.js');
const fixture = require('./fixtures/real-puzzles.js').kurodoko5x5EasyReal;

const ITERATIONS = 5;
const WARMUP = 2;
const times = [];
for (let i = 0; i < WARMUP + ITERATIONS; i++) {
  KurodokoSolver.clearSolutionCache();
  const s = new KurodokoSolver({
    rows: fixture.rows,
    cols: fixture.cols,
    task: fixture.task,
  });
  const t0 = process.hrtime.bigint();
  const r = s.solve();
  const t1 = process.hrtime.bigint();
  if (!r.solved) {
    console.error('kurodoko5x5EasyReal failed to solve');
    process.exit(1);
  }
  if (i >= WARMUP) times.push(Number(t1 - t0) / 1e6);
}
times.sort((a, b) => a - b);
const median = times[Math.floor(times.length / 2)];
console.log(`kurodoko5x5EasyReal: median ${median.toFixed(2)} ms over ${ITERATIONS} runs`);
