const { AquariumSolver } = require('../solver.js');
const fixtures = require('./fixtures/puzzles.js');

// Silence the AquariumSolver init log.
const origLog = console.log;
console.log = () => {};
const log = (...a) => origLog(...a);

const p = fixtures.aquariumLarge;

const N = 11;
const times = [];
let solvedFlag = null;
for (let i = 0; i < N; i++) {
  const s = new AquariumSolver(p.rowClues, p.colClues, p.regionMap, p.rows, p.cols);
  const t0 = process.hrtime.bigint();
  const r = s.solve(null);
  const t1 = process.hrtime.bigint();
  times.push(Number(t1 - t0) / 1e6);
  if (solvedFlag === null) solvedFlag = r.solved;
}
times.sort((a, b) => a - b);
log('15x15 aquarium solve times (ms):', times.map(t => t.toFixed(2)).join(', '));
log('median:', times[Math.floor(N / 2)].toFixed(2), 'ms');
log('solved:', solvedFlag);

if (!solvedFlag) {
  console.error('FAIL: aquarium bench puzzle did not solve');
  process.exit(1);
}
