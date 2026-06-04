'use strict';
// Standalone bench for ShakashakaSolver. Run: node tests/bench-shakashaka.js
const { ShakashakaSolver } = require('../src/solvers/shakashaka.js');
const fixtures = require('./fixtures/real-puzzles.js');

const UNK = 9;

function run(label, fixture, maxMs) {
  const { task, rows, cols } = fixture;
  const t0 = Date.now();
  const res = new ShakashakaSolver({ task, maxMs }).solve();
  const ms = Date.now() - t0;

  // Count determined cells: open cells (task==-1) whose value != UNK and != -1
  let det = 0, total = 0;
  if (res.cells) {
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      if (task[r][c] !== -1) continue;
      total++;
      const v = res.cells[r][c];
      if (v !== UNK && v !== -1) det++;
    }
  } else {
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      if (task[r][c] !== -1) continue;
      total++;
    }
  }

  const status = res.solved ? 'solved' : (res.partial ? 'partial' : 'unsolved');
  console.log(`${label}: ${status} ms=${ms} determined=${det}/${total}${res.error ? ' err=' + res.error : ''}`);
  if (res.solved) {
    const chk = new ShakashakaSolver({ task });
    const valid = chk._isValid(res.cells);
    console.log(`  validity check: ${valid}`);
  }
}

const MAXMS = Number(process.env.MAXMS || 30000);
run('shakashaka 25x25', fixtures.shakashaka_25x25, MAXMS);
