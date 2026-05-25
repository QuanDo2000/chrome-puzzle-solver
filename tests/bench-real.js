// End-to-end bench against puzzles captured from real puzzles-mobile.com pages.
// Run: node tests/bench-real.js
//
// For each puzzle, runs 5 solves, reports min / median / max plus solver type,
// solved flag, and search-node count where applicable.

const { NonogramSolver, AquariumSolver, GalaxiesSolver, HashiSolver, HeyawakeSolver, HitoriSolver, KakurasuSolver, KurodokoSolver } = require('../solver.js');
const fixtures = require('./fixtures/real-puzzles.js');

function heyawakeRoomsFromFixture(p) {
  const { rows, cols, areas, areaTask } = p;
  const cellsPerRoom = {};
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const k = areas[r][c];
      if (!cellsPerRoom[k]) cellsPerRoom[k] = [];
      cellsPerRoom[k].push({ r, c });
    }
  }
  return areaTask.map((target, k) => ({ cells: cellsPerRoom[k], target }));
}

// Silence AquariumSolver's init log (if any leak through).
console.log = ((orig) => {
  return (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('[AquariumSolver]')) return;
    orig.apply(console, args);
  };
})(console.log);

const WARMUP = 2;
const N = 5;
const rows = [];

function buildSolver(p) {
  if (p.type === 'nonogram') return new NonogramSolver(p.rowClues, p.colClues);
  if (p.type === 'aquarium') return new AquariumSolver(p.rowClues, p.colClues, p.regionMap, p.rows, p.cols);
  if (p.type === 'galaxies') return new GalaxiesSolver(p.stars, p.rows, p.cols);
  if (p.type === 'hashi') return new HashiSolver({ rows: p.rows, cols: p.cols, islands: p.islands, maxMs: 10000 });
  if (p.type === 'heyawake') return new HeyawakeSolver({ rows: p.rows, cols: p.cols, rooms: heyawakeRoomsFromFixture(p) });
  if (p.type === 'hitori') return new HitoriSolver({ rows: p.rows, cols: p.cols, task: p.task });
  if (p.type === 'kakurasu') return new KakurasuSolver({ rows: p.rows, cols: p.cols, rowClues: p.rowClues, colClues: p.colClues });
  if (p.type === 'kurodoko') return new KurodokoSolver({ rows: p.rows, cols: p.cols, task: p.task });
  return null;
}

for (const name of Object.keys(fixtures)) {
  const p = fixtures[name];
  // bench-real.js covers nonogram/aquarium/galaxies/hashi/heyawake. The other
  // puzzle types (binairo, shikaku, yin-yang, slitherlink) share real-puzzles.js
  // but have their own dedicated bench scripts (bench-binairo.js etc.), so skip
  // them here.
  if (!buildSolver(p)) continue;
  // Discard WARMUP iterations to skip V8 JIT cold-start cost.
  for (let i = 0; i < WARMUP; i++) {
    GalaxiesSolver.clearSolutionCache();
    HashiSolver.clearSolutionCache();
    HeyawakeSolver.clearSolutionCache();
    HitoriSolver.clearSolutionCache();
    KakurasuSolver.clearSolutionCache();
    KurodokoSolver.clearSolutionCache();
    buildSolver(p).solve(null);
  }
  const times = [];
  let solved = null;
  let nodes = null;
  for (let i = 0; i < N; i++) {
    // GalaxiesSolver, HashiSolver, HeyawakeSolver, KakurasuSolver, and
    // KurodokoSolver have static solution caches — clear them so each
    // iteration measures a real solve rather than a cache hit.
    GalaxiesSolver.clearSolutionCache();
    HashiSolver.clearSolutionCache();
    HeyawakeSolver.clearSolutionCache();
    HitoriSolver.clearSolutionCache();
    KakurasuSolver.clearSolutionCache();
    KurodokoSolver.clearSolutionCache();
    const s = buildSolver(p);
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

const unsolved = rows.filter(r => !r.solved);
if (unsolved.length > 0) {
  console.error(`FAIL: ${unsolved.length} real puzzle(s) did not solve: ${unsolved.map(r => r.name).join(', ')}`);
  process.exit(1);
}
