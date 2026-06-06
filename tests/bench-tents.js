'use strict';
const { TentsSolver } = require('../src/solvers/tents.js');
const { tents_15x15: P } = require('./fixtures/real-puzzles.js');

let wall = 0, res;
for (let i = 0; i < 3; i++) { const t0 = Date.now(); res = new TentsSolver({ rows: P.rows, cols: P.cols, trees: P.trees, colClue: P.colClue, rowClue: P.rowClue, maxMs: 30000 }).solve(); wall = Date.now() - t0; }
let n = 0; if (res.grid) for (const row of res.grid) for (const v of row) if (v === 1) n++;
const solver = new TentsSolver({ rows: P.rows, cols: P.cols, trees: P.trees, colClue: P.colClue, rowClue: P.rowClue });
const ok = res.solved && solver._isValid((res.grid || []).map((row) => row.map((v) => (v === 1 ? 1 : 0))));
console.log(`tents 15x15: solved=${res.solved} partial=${!!res.partial} wall=${wall}ms tents=${n}/45`);
if (ok) console.log('full solve verified by oracle'); else { console.log('NOT a verified full solve'); process.exit(1); }
