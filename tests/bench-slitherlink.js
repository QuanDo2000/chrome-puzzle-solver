const { SlitherlinkSolver } = require('../solver.js');
const real = require('./fixtures/real-puzzles.js');

const origLog = console.log;
console.log = () => {};
const log = (...a) => origLog(...a);

const targets = Object.keys(real)
  .filter(k => real[k]?.type === 'slitherlink')
  .map(k => ({ name: k, puzzle: real[k] }));

if (targets.length === 0) {
  console.error('FAIL: no slitherlink entries in tests/fixtures/real-puzzles.js');
  process.exit(1);
}

let failed = false;

for (const { name, puzzle } of targets) {
  // Baselines that don't expect to fully solve (e.g. the 50×40 monthly that
  // currently times out) use a shorter budget and fewer iterations — we only
  // need a stable timing baseline, not a sample distribution.
  const expectSolved = puzzle.expectSolved !== false;
  const WARMUP = expectSolved ? 2 : 1;
  const N = expectSolved ? 11 : 3;
  const budgetMs = expectSolved ? 30000 : 8000;
  for (let i = 0; i < WARMUP; i++) {
    SlitherlinkSolver.clearSolutionCache();
    const s = new SlitherlinkSolver({ width: puzzle.cols, height: puzzle.rows, task: puzzle.task });
    s.maxMs = budgetMs;
    s.solve();
  }
  const times = [];
  let solvedFlag = null;
  for (let i = 0; i < N; i++) {
    SlitherlinkSolver.clearSolutionCache();
    const s = new SlitherlinkSolver({ width: puzzle.cols, height: puzzle.rows, task: puzzle.task });
    s.maxMs = budgetMs;
    const t0 = process.hrtime.bigint();
    const r = s.solve();
    const t1 = process.hrtime.bigint();
    times.push(Number(t1 - t0) / 1e6);
    if (solvedFlag === null) solvedFlag = r.solved;
  }
  times.sort((a, b) => a - b);
  log(`${name} (${puzzle.rows}x${puzzle.cols}) solve times (ms):`, times.map(t => t.toFixed(2)).join(', '));
  log(`  median: ${times[Math.floor(N / 2)].toFixed(2)} ms, solved: ${solvedFlag}${expectSolved ? '' : ' (baseline; expectSolved=false)'}`);
  if (!solvedFlag && expectSolved) failed = true;
}

if (failed) {
  console.error('FAIL: one or more slitherlink bench puzzles did not solve');
  process.exit(1);
}
log('All slitherlink bench puzzles meeting expectSolved completed.');
