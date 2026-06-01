'use strict';
// Standalone bench for ShingokiSolver on the real captured board.
// Run: node tests/bench-shingoki.js   (NOT part of npm test)
const { ShingokiSolver } = require('../src/solvers/shingoki.js');
const fixtures = require('./fixtures/real-puzzles.js');

const p = fixtures.shingoki_40x40_monthly;
const MAXMS = Number(process.env.MAXMS || 30000);
const t0 = Date.now();
const res = new ShingokiSolver({ rows: p.rows, cols: p.cols, task: p.task, maxMs: MAXMS }).solve();
const ms = Date.now() - t0;
let ok = false;
if (res.solved) {
  const chk = new ShingokiSolver({ rows: p.rows, cols: p.cols, task: p.task });
  chk.H = res.horizontal; chk.V = res.vertical;
  ok = chk.numbersSatisfied();
}
console.log(`shingoki 40x40: solved=${res.solved} valid=${ok} ms=${ms}${res.error ? ' err=' + res.error : ''}`);
process.exit(res.solved && ok ? 0 : 1);
