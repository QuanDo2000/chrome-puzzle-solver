'use strict';
// Standalone bench for ShakashakaSolver. Run: node tests/bench-shakashaka.js
const { ShakashakaSolver } = require('../src/solvers/shakashaka.js');
const fixtures = require('./fixtures/real-puzzles.js');

const UNK = 9;

function popcount(x) { let n = 0; while (x) { x &= x - 1; n++; } return n; }

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

// Root-deduction reach: _initDomains(); _deduceAll(0) with a bounded deadline;
// count singleton domains / total open cells.
function rootReach(label, task, rows, cols, budgetMs) {
  const s = new ShakashakaSolver({ task });
  const t0 = Date.now();
  s._initDomains();
  if (budgetMs > 0) s._deadline = Date.now() + budgetMs;
  s._deduceAll(0);
  const ms = Date.now() - t0;
  let singletons = 0, total = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (task[r][c] !== -1) continue;
    total++;
    if (popcount(s._dom[r][c]) === 1) singletons++;
  }
  const pct = total > 0 ? ((singletons / total) * 100).toFixed(1) : '0.0';
  console.log(`  root-deduction reach: ${singletons}/${total} (${pct}%) in ${ms}ms`);
}

// Build a constructive all-open n×n board (no clues, no black cells).
function openBoard(n) {
  return Array.from({ length: n }, () => new Array(n).fill(-1));
}

const MAXMS = Number(process.env.MAXMS || 30000);

console.log('=== Shakashaka bench ===');
console.log('');

// --- Real 5x5 ---
const task5x5 = [[-2,-2,-1,-1,-1],[-1,-1,-1,-1,-1],[-1,-1,-2,-1,-2],[1,-1,-1,-1,-1],[-1,-1,-1,-1,-1]];
const fixture5x5 = { task: task5x5, rows: 5, cols: 5 };
console.log('shakashaka real 5x5:');
rootReach('real 5x5', task5x5, 5, 5, 0);
run('  solve', fixture5x5, MAXMS);

console.log('');

// --- Constructive size ladder (all-open square boards) ---
// All-open boards have no anchor: root deduction reach = 0 by design (GAC needs a
// decided neighbour to propagate from). The solve time reflects full backtracking.
for (const n of [6, 8, 10, 12]) {
  const task = openBoard(n);
  const fixture = { task, rows: n, cols: n };
  console.log(`shakashaka constructive ${n}x${n} (all-open):`);
  rootReach(`${n}x${n}`, task, n, n, 0);
  run('  solve', fixture, MAXMS);
  console.log('');
}

// --- Real 25x25 ---
console.log('shakashaka 25x25 (real):');
rootReach('25x25', fixtures.shakashaka_25x25.task, 25, 25, 8000);
run('  solve', fixtures.shakashaka_25x25, MAXMS);
