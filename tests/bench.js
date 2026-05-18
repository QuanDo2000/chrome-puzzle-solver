const { NonogramSolver } = require('../solver.js');

// 15x15 symmetric nonogram. Symmetric clues keep the puzzle constrained while
// still exercising backtracking (line-DP alone won't fully resolve it).
const rowClues = [
  [5, 2, 2], [1, 2, 1, 1, 2], [3, 1, 3, 1], [2, 2, 2, 2], [4, 1, 4],
  [1, 1, 1, 1, 1, 1], [2, 2, 2], [1, 1, 1, 1], [3, 3], [1, 1, 1, 1],
  [2, 2, 2], [1, 1, 1, 1, 1, 1], [4, 1, 4], [2, 2, 2, 2], [3, 1, 3, 1],
];
const colClues = rowClues;

const WARMUP = 2;
const N = 5;
// Discard the first WARMUP iterations: V8 JIT compiles after a few executions
// of the same code path, so the first 1-2 solves are 2-10x slower than steady
// state. Including them would dominate the median.
for (let i = 0; i < WARMUP; i++) {
  new NonogramSolver(rowClues, colClues).solve(null);
}
const times = [];
let solvedFlag = null;
for (let i = 0; i < N; i++) {
  const s = new NonogramSolver(rowClues, colClues);
  const t0 = process.hrtime.bigint();
  const r = s.solve(null);
  const t1 = process.hrtime.bigint();
  times.push(Number(t1 - t0) / 1e6);
  if (solvedFlag === null) solvedFlag = r.solved;
}
times.sort((a, b) => a - b);
console.log('15x15 solve times (ms):', times.map(t => t.toFixed(1)).join(', '));
console.log('median:', times[Math.floor(N / 2)].toFixed(1), 'ms');
console.log('solved:', solvedFlag);
