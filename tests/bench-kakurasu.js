const { KakurasuSolver } = require('../solver.js');
const fixtures = require('./fixtures/real-puzzles.js');

const config = fixtures.kakurasu4x4EasyReal;
const WARMUP = 2;
const N = 5;

for (let i = 0; i < WARMUP; i++) {
  KakurasuSolver.clearSolutionCache();
  new KakurasuSolver({
    rows: config.rows,
    cols: config.cols,
    rowClues: config.rowClues,
    colClues: config.colClues,
  }).solve();
}

const times = [];
let solvedFlag = null;
for (let i = 0; i < N; i++) {
  KakurasuSolver.clearSolutionCache();
  const s = new KakurasuSolver({
    rows: config.rows,
    cols: config.cols,
    rowClues: config.rowClues,
    colClues: config.colClues,
  });
  const t0 = process.hrtime.bigint();
  const r = s.solve();
  const t1 = process.hrtime.bigint();
  times.push(Number(t1 - t0) / 1e6);
  if (solvedFlag === null) solvedFlag = r.solved;
}
times.sort((a, b) => a - b);
console.log('4x4-easy kakurasu solve times (ms):', times.map(t => t.toFixed(2)).join(', '));
console.log('median:', times[Math.floor(N / 2)].toFixed(2), 'ms');
console.log('solved:', solvedFlag);

if (!solvedFlag) {
  console.error('FAIL: kakurasu bench puzzle did not solve');
  process.exit(1);
}
