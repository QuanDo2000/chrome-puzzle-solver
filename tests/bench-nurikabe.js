'use strict';
const { NurikabeSolver } = require('../solver.js');
const realPuzzles = require('./fixtures/real-puzzles.js');

const FIXTURES = ['nurikabe5x5EasyReal', 'nurikabe20x20MonthlyReal'];
const ITERATIONS = 5;
const WARMUP = 2;

for (const name of FIXTURES) {
  const fixture = realPuzzles[name];
  if (!fixture) continue;
  const times = [];
  for (let i = 0; i < WARMUP + ITERATIONS; i++) {
    NurikabeSolver.clearSolutionCache();
    const s = new NurikabeSolver({
      rows: fixture.rows,
      cols: fixture.cols,
      task: fixture.task,
      maxMs: 60000,
    });
    const t0 = process.hrtime.bigint();
    const r = s.solve();
    const t1 = process.hrtime.bigint();
    if (!r.solved) { console.error(`${name} failed to solve`); process.exit(1); }
    if (i >= WARMUP) times.push(Number(t1 - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  console.log(`${name}: median ${times[Math.floor(times.length / 2)].toFixed(2)} ms over ${ITERATIONS} runs`);
}
