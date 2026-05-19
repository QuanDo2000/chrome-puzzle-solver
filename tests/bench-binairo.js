const { BinairoSolver } = require('../solver.js');
const real = require('./fixtures/real-puzzles.js');

const origLog = console.log;
console.log = () => {};
const log = (...a) => origLog(...a);

const targets = Object.keys(real)
  .filter(k => real[k]?.type === 'binairo')
  .map(k => ({ name: k, puzzle: real[k] }));

if (targets.length === 0) {
  console.error('FAIL: no binairo entries in tests/fixtures/real-puzzles.js');
  process.exit(1);
}

const WARMUP = 2;
const N = 11;
let failed = false;

for (const { name, puzzle } of targets) {
  for (let i = 0; i < WARMUP; i++) {
    BinairoSolver.clearSolutionCache();
    new BinairoSolver({ rows: puzzle.rows, cols: puzzle.cols, givens: puzzle.givens }).solve();
  }
  const times = [];
  let solvedFlag = null;
  for (let i = 0; i < N; i++) {
    BinairoSolver.clearSolutionCache();
    const s = new BinairoSolver({ rows: puzzle.rows, cols: puzzle.cols, givens: puzzle.givens });
    const t0 = process.hrtime.bigint();
    const r = s.solve();
    const t1 = process.hrtime.bigint();
    times.push(Number(t1 - t0) / 1e6);
    if (solvedFlag === null) solvedFlag = r.solved;
  }
  times.sort((a, b) => a - b);
  log(`${name} (${puzzle.rows}x${puzzle.cols}) solve times (ms):`, times.map(t => t.toFixed(2)).join(', '));
  log(`  median: ${times[Math.floor(N / 2)].toFixed(2)} ms, solved: ${solvedFlag}`);
  if (!solvedFlag) failed = true;
}

if (failed) {
  console.error('FAIL: one or more binairo bench puzzles did not solve');
  process.exit(1);
}
