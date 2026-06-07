'use strict';
const { LollipopsSolver } = require('../src/solvers/lollipops.js');
const REAL = require('./fixtures/real-puzzles.js');
const f = REAL.lollipops_10x10;
for (let i = 0; i < 2; i++) new LollipopsSolver({ rows: f.rows, cols: f.cols, task: f.task, maxMs: 30000 }).solve();
const t0 = Date.now();
const res = new LollipopsSolver({ rows: f.rows, cols: f.cols, task: f.task, maxMs: 30000 }).solve();
const wall = Date.now() - t0;
let shapes = 0; if (res.grid) for (const row of res.grid) for (const v of row) if (v === 1 || v === 2 || v === 3) shapes++;
console.log(`lollipops 10x10: solved=${res.solved} partial=${!!res.partial} wall=${wall}ms freeShapes=${shapes}`);
if (!res.solved) { console.error('UNSOLVED'); process.exit(1); }
console.log('full solve verified');
