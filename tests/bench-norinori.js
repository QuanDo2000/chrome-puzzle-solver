'use strict';
const { NorinoriSolver } = require('../solver.js');
const fixture = require('./fixtures/real-puzzles.js').norinori6x6NormalReal;

function buildRooms(f) {
  const cellsByRoom = {};
  for (let r = 0; r < f.rows; r++) for (let c = 0; c < f.cols; c++) {
    const k = f.areas[r][c];
    if (!cellsByRoom[k]) cellsByRoom[k] = [];
    cellsByRoom[k].push({r, c});
  }
  return Object.keys(cellsByRoom).sort((a,b) => +a - +b).map(k => ({cells: cellsByRoom[k]}));
}

const ITERATIONS = 5;
const WARMUP = 2;
const times = [];
for (let i = 0; i < WARMUP + ITERATIONS; i++) {
  NorinoriSolver.clearSolutionCache();
  const s = new NorinoriSolver({
    rows: fixture.rows,
    cols: fixture.cols,
    rooms: buildRooms(fixture),
  });
  const t0 = process.hrtime.bigint();
  const r = s.solve();
  const t1 = process.hrtime.bigint();
  if (!r.solved) { console.error('norinori6x6NormalReal failed to solve'); process.exit(1); }
  if (i >= WARMUP) times.push(Number(t1 - t0) / 1e6);
}
times.sort((a, b) => a - b);
console.log(`norinori6x6NormalReal: median ${times[Math.floor(times.length / 2)].toFixed(2)} ms over ${ITERATIONS} runs`);
