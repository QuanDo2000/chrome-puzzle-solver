const { HitoriSolver } = require('../solver.js');
const fixtures = require('./fixtures/real-puzzles.js');

const config = fixtures.hitori5x5EasyReal;
const WARMUP = 2;
const N = 5;

for (let i = 0; i < WARMUP; i++) {
  HitoriSolver.clearSolutionCache();
  new HitoriSolver({
    rows: config.rows,
    cols: config.cols,
    task: config.task,
  }).solve();
}

const times = [];
let solvedFlag = null;
for (let i = 0; i < N; i++) {
  HitoriSolver.clearSolutionCache();
  const s = new HitoriSolver({
    rows: config.rows,
    cols: config.cols,
    task: config.task,
  });
  const t0 = process.hrtime.bigint();
  const r = s.solve();
  const t1 = process.hrtime.bigint();
  times.push(Number(t1 - t0) / 1e6);
  if (solvedFlag === null) solvedFlag = r.solved;
}
times.sort((a, b) => a - b);
console.log('5x5-easy hitori solve times (ms):', times.map(t => t.toFixed(2)).join(', '));
console.log('median:', times[Math.floor(N / 2)].toFixed(2), 'ms');
console.log('solved:', solvedFlag);

if (!solvedFlag) {
  console.error('FAIL: hitori bench puzzle did not solve');
  process.exit(1);
}
