'use strict';
const { ThermometersSolver } = require('../src/solvers/thermometers.js');
const REAL = require('./fixtures/real-puzzles.js');

const f = REAL.thermometers_15x15;
const thermos = f.areaPoints.map((pts) => pts.map((p) => ({ r: p.row, c: p.col })));
const colClue = f.task.slice(0, f.cols), rowClue = f.task.slice(f.cols);

// 2 warmup iterations discarded (matches the other bench scripts).
for (let i = 0; i < 2; i++) new ThermometersSolver({ rows: f.rows, cols: f.cols, thermos, colClue, rowClue, maxMs: 30000 }).solve();
const t0 = Date.now();
const res = new ThermometersSolver({ rows: f.rows, cols: f.cols, thermos, colClue, rowClue, maxMs: 30000 }).solve();
const wall = Date.now() - t0;
let filled = 0; if (res.grid) for (const row of res.grid) for (const v of row) if (v === 1) filled++;
console.log(`thermometers 15x15: solved=${res.solved} partial=${!!res.partial} wall=${wall}ms filled=${filled}`);
if (!res.solved) { console.error('UNSOLVED'); process.exit(1); }
console.log('full solve verified');
