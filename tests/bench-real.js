// End-to-end bench against puzzles captured from real puzzles-mobile.com pages.
// Run: node tests/bench-real.js
//
// For each puzzle, runs 5 solves, reports min / median / max plus solver type,
// solved flag, and search-node count where applicable.

const { NonogramSolver, AquariumSolver, GalaxiesSolver } = require('../solver.js');
const fixtures = require('./fixtures/real-puzzles.js');

// Silence AquariumSolver's init log (if any leak through).
console.log = ((orig) => {
  return (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('[AquariumSolver]')) return;
    orig.apply(console, args);
  };
})(console.log);

const N = 5;
const rows = [];

for (const name of Object.keys(fixtures)) {
  const p = fixtures[name];
  const times = [];
  let solved = null;
  let nodes = null;
  for (let i = 0; i < N; i++) {
    let s;
    if (p.type === 'nonogram') {
      s = new NonogramSolver(p.rowClues, p.colClues);
    } else if (p.type === 'aquarium') {
      s = new AquariumSolver(p.rowClues, p.colClues, p.regionMap, p.rows, p.cols);
    } else if (p.type === 'galaxies') {
      s = new GalaxiesSolver(p.stars, p.rows, p.cols);
    } else {
      console.error('Unknown puzzle type:', p.type);
      continue;
    }
    const t0 = process.hrtime.bigint();
    const r = s.solve(null);
    const t1 = process.hrtime.bigint();
    times.push(Number(t1 - t0) / 1e6);
    if (solved === null) {
      solved = r.solved;
      nodes = s._searchNodes ?? s.nodes ?? null;
    }
  }
  times.sort((a, b) => a - b);
  rows.push({
    name,
    type: p.type,
    size: `${p.rows}×${p.cols}`,
    min: times[0],
    median: times[Math.floor(N / 2)],
    max: times[N - 1],
    solved,
    nodes,
  });
}

const pad = (s, n) => String(s).padEnd(n);
console.log('');
console.log(pad('Puzzle', 32), pad('Size', 8), pad('Min', 10), pad('Median', 10), pad('Max', 10), pad('Nodes', 8), 'Solved');
console.log('-'.repeat(96));
for (const r of rows) {
  console.log(
    pad(r.name, 32),
    pad(r.size, 8),
    pad(r.min.toFixed(2) + 'ms', 10),
    pad(r.median.toFixed(2) + 'ms', 10),
    pad(r.max.toFixed(2) + 'ms', 10),
    pad(r.nodes ?? '-', 8),
    r.solved,
  );
}
