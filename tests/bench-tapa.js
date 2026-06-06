'use strict';
const { TapaSolver } = require('../src/solvers/tapa.js');
const { tapa_6x6: P } = require('./fixtures/real-puzzles.js');

let wall = 0, res;
for (let i = 0; i < 3; i++) { const t0 = Date.now(); res = new TapaSolver({ rows: P.rows, cols: P.cols, task: P.task, maxMs: 30000 }).solve(); wall = Date.now() - t0; }
let n = 0; if (res.grid) for (const row of res.grid) for (const v of row) if (v === 1) n++;
const solver = new TapaSolver({ rows: P.rows, cols: P.cols, task: P.task });
const ok = res.solved && solver._isValid((res.grid || []).map((row) => row.map((v) => (v === 1 ? 1 : 0))));
console.log(`tapa 6x6: solved=${res.solved} partial=${!!res.partial} wall=${wall}ms shaded=${n}/23`);
if (ok) console.log('full solve verified by oracle'); else { console.log('NOT a verified full solve'); process.exit(1); }
