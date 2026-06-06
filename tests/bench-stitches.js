'use strict';
const { StitchesSolver } = require('../src/solvers/stitches.js');
const { stitches_15x15: P } = require('./fixtures/real-puzzles.js');

let wall = 0, res;
for (let i = 0; i < 3; i++) { // 2 warmup + 1 measured
  const t0 = Date.now();
  res = new StitchesSolver({ rows: P.rows, cols: P.cols, areas: P.areas, colClue: P.colClue, rowClue: P.rowClue, stitches: P.stitches, maxMs: 30000 }).solve();
  wall = Date.now() - t0;
}
let n = 0; if (res.horizontal) { for (const row of res.horizontal) for (const v of row) if (v === 1) n++; for (const row of res.vertical) for (const v of row) if (v === 1) n++; }
const ok = res.solved && new StitchesSolver({ rows: P.rows, cols: P.cols, areas: P.areas, colClue: P.colClue, rowClue: P.rowClue, stitches: P.stitches })._isValid({ horizontal: res.horizontal, vertical: res.vertical });
console.log(`stitches 15x15 k=${P.stitches}: solved=${res.solved} partial=${!!res.partial} wall=${wall}ms stitches=${n}/42`);
if (ok) console.log('full solve verified by oracle'); else { console.log('NOT a verified full solve'); process.exit(1); }
