'use strict';
// Standalone bench for ShingokiSolver. Run: node tests/bench-shingoki.js
const { ShingokiSolver } = require('../src/solvers/shingoki.js');
const fixtures = require('./fixtures/real-puzzles.js');

// Constructive board: random rectangle-perimeter loop, derive its clues.
function genBoard(n, seed) {
  let s = seed >>> 0; const rnd = () => { s = (s*1664525 + 1013904223) >>> 0; return s / 0x100000000; };
  const r0 = Math.floor(rnd()*n), r1 = r0 + 1 + Math.floor(rnd()*(n-r0));
  const c0 = Math.floor(rnd()*n), c1 = c0 + 1 + Math.floor(rnd()*(n-c0));
  const H = Array.from({length:n+1},()=>new Array(n).fill(0));
  const V = Array.from({length:n},()=>new Array(n+1).fill(0));
  for (let c=c0;c<c1;c++){H[r0][c]=1;H[r1][c]=1;}
  for (let r=r0;r<r1;r++){V[r][c0]=1;V[r][c1]=1;}
  const probe = new ShingokiSolver({rows:n,cols:n,task:Array.from({length:n+1},()=>new Array(n+1).fill(0))});
  probe.H = H; probe.V = V;
  const task = Array.from({length:n+1},()=>new Array(n+1).fill(0));
  for (let r=0;r<=n;r++) for (let c=0;c<=n;c++){
    const inc = probe.incidentEdges(r,c).filter(e=>probe.getEdge(e)===1);
    if (inc.length!==2) continue;
    const isTurn = inc.filter(e=>e.kind==='H').length===1;
    task[r][c] = isTurn ? -probe.runLengthAt(r,c) : probe.runLengthAt(r,c);
  }
  return task;
}

function run(label, rows, cols, task, maxMs) {
  const t0 = Date.now();
  const res = new ShingokiSolver({ rows, cols, task, maxMs }).solve();
  const ms = Date.now() - t0;
  let valid = 'n/a';
  if (res.solved) {
    const chk = new ShingokiSolver({ rows, cols, task });
    chk.H = res.horizontal; chk.V = res.vertical;
    valid = chk.numbersSatisfied();
  }
  console.log(`${label}: solved=${res.solved} valid=${valid} ms=${ms}${res.error ? ' err=' + res.error : ''}`);
}

const MAXMS = Number(process.env.MAXMS || 15000);
for (const n of [10, 15, 20, 25]) run(`constructive ${n}x${n}`, n, n, genBoard(n, n*97), MAXMS);
const p = fixtures.shingoki_40x40_monthly;
run('real 40x40 monthly', p.rows, p.cols, p.task, Number(process.env.MAXMS40 || 30000));

function runReach(label, rows, cols, task) {
  const s = new ShingokiSolver({ rows, cols, task });
  s._initState(); s._deduceAll(0);
  let det = 0, tot = 0;
  for (const e of s._allEdgeRefs()) { tot++; if (s.getEdge(e) !== 0) det++; }
  console.log(`${label}: root-deduction reach=${det}/${tot}`);
}
const fx = require('./fixtures/real-puzzles.js');
for (const k of ['shingoki_7x7_hard','shingoki_10x10_hard','shingoki_15x15_hard','shingoki_25x25_hard']) {
  const p2 = fx[k]; runReach(k, p2.rows, p2.cols, p2.task);
}
