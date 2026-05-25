const { HeyawakeSolver } = require('../solver.js');
const fixtures = require('./fixtures/real-puzzles.js');

const config = fixtures.heyawake6x6EasyReal;
const WARMUP = 2;
const N = 5;

function buildRooms(f) {
  const cellsPerRoom = {};
  for (let r = 0; r < f.rows; r++) {
    for (let c = 0; c < f.cols; c++) {
      const k = f.areas[r][c];
      if (!cellsPerRoom[k]) cellsPerRoom[k] = [];
      cellsPerRoom[k].push({ r, c });
    }
  }
  return f.areaTask.map((target, k) => ({ cells: cellsPerRoom[k], target }));
}

for (let i = 0; i < WARMUP; i++) {
  HeyawakeSolver.clearSolutionCache();
  new HeyawakeSolver({
    rows: config.rows,
    cols: config.cols,
    rooms: buildRooms(config),
  }).solve();
}

const times = [];
let solvedFlag = null;
for (let i = 0; i < N; i++) {
  HeyawakeSolver.clearSolutionCache();
  const s = new HeyawakeSolver({
    rows: config.rows,
    cols: config.cols,
    rooms: buildRooms(config),
  });
  const t0 = process.hrtime.bigint();
  const r = s.solve();
  const t1 = process.hrtime.bigint();
  times.push(Number(t1 - t0) / 1e6);
  if (solvedFlag === null) solvedFlag = r.solved;
}
times.sort((a, b) => a - b);
console.log('6x6-easy heyawake solve times (ms):', times.map(t => t.toFixed(2)).join(', '));
console.log('median:', times[Math.floor(N / 2)].toFixed(2), 'ms');
console.log('solved:', solvedFlag);

if (!solvedFlag) {
  console.error('FAIL: heyawake bench puzzle did not solve');
  process.exit(1);
}
