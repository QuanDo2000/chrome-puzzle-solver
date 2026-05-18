const { GalaxiesSolver } = require('../solver.js');

// 12x12 with 5 stars: ~5000 search nodes — heavy recursion that exercises
// the trail/rollback path and gives a meaningful trail-vs-clone signal.
const config = {
  stars: [
    { row: 5, col: 5 }, { row: 17, col: 17 }, { row: 11, col: 11 },
    { row: 5, col: 17 }, { row: 17, col: 5 },
  ],
  rows: 12, cols: 12,
};

const WARMUP = 2;
const N = 5;
// Discard the first WARMUP iterations to skip V8 JIT cold-start cost.
for (let i = 0; i < WARMUP; i++) {
  GalaxiesSolver._solutionCache.clear?.();
  new GalaxiesSolver(config.stars, config.rows, config.cols).solve(null);
}
const times = [];
let solvedFlag = null;
let nodes = 0;
for (let i = 0; i < N; i++) {
  // Bypass the solution cache so each run does the full search work.
  GalaxiesSolver._solutionCache.clear?.();
  const s = new GalaxiesSolver(config.stars, config.rows, config.cols);
  const t0 = process.hrtime.bigint();
  const r = s.solve(null);
  const t1 = process.hrtime.bigint();
  times.push(Number(t1 - t0) / 1e6);
  if (solvedFlag === null) { solvedFlag = r.solved; nodes = s.nodes; }
}
times.sort((a, b) => a - b);
console.log('12x12 (5 stars) galaxies solve times (ms):',
  times.map(t => t.toFixed(2)).join(', '));
console.log('median:', times[Math.floor(N / 2)].toFixed(2), 'ms');
console.log('solved:', solvedFlag, 'nodes:', nodes);

if (!solvedFlag) {
  console.error('FAIL: galaxies bench puzzle did not solve');
  process.exit(1);
}
