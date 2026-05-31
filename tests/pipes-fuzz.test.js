'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PipesSolver } = require('../src/solvers/pipes.js');

function rng(seed) { let s = seed >>> 0; return () => { s = (s*1664525 + 1013904223) >>> 0; return s / 0x100000000; }; }
// Page bit→side map (must match PipesSolver): E=1, N=2, W=4, S=8.
const N=2,E=1,S=8,W=4, OPP={[N]:S,[S]:N,[E]:W,[W]:E};

// Build a random spanning tree over the grid; its edges define each cell's
// solved mask. Guaranteed connected + edge-consistent => guaranteed solvable.
function randomNetwork(rand, rows, cols, wrap) {
  const total = rows*cols;
  const mask = new Array(total).fill(0);
  const inTree = new Uint8Array(total); inTree[0] = 1;
  const frontier = [0];
  let count = 1;
  const nb = (i, s) => {
    const r=(i/cols)|0, c=i%cols;
    if (s===N){const nr=r-1; if(nr<0) return wrap?(rows-1)*cols+c:-1; return nr*cols+c;}
    if (s===S){const nr=r+1; if(nr>=rows) return wrap?c:-1; return nr*cols+c;}
    if (s===W){const nc=c-1; if(nc<0) return wrap?r*cols+cols-1:-1; return r*cols+nc;}
    {const nc=c+1; if(nc>=cols) return wrap?r*cols:-1; return r*cols+nc;}
  };
  while (count < total) {
    const order = frontier.slice().sort(() => rand() - 0.5);
    let grew = false;
    for (const i of order) {
      const sidesShuffled = [N,E,S,W].sort(() => rand() - 0.5);
      for (const s of sidesShuffled) {
        const j = nb(i, s);
        if (j >= 0 && !inTree[j]) { mask[i]|=s; mask[j]|=OPP[s]; inTree[j]=1; count++; frontier.push(j); grew=true; break; }
      }
      if (grew) break;
    }
    if (!grew) break;
  }
  return { mask, complete: count === total };
}

function toTask(rand, solvedMask, rows, cols) {
  const task = [];
  for (let r=0;r<rows;r++){ const row=[]; for (let c=0;c<cols;c++){ const k=Math.floor(rand()*4); row.push(PipesSolver.rotateCW(solvedMask[r*cols+c], k)); } task.push(row); }
  return task;
}
function edgesConsistent(grid, rows, cols, wrap) {
  const nb=(r,c,s)=>{ if(s===N){const nr=r-1;if(nr<0)return wrap?[rows-1,c]:null;return[nr,c];}
    if(s===S){const nr=r+1;if(nr>=rows)return wrap?[0,c]:null;return[nr,c];}
    if(s===W){const nc=c-1;if(nc<0)return wrap?[r,cols-1]:null;return[r,nc];}
    {const nc=c+1;if(nc>=cols)return wrap?[r,0]:null;return[r,nc];} };
  for (let r=0;r<rows;r++) for (let c=0;c<cols;c++){ const m=grid[r][c];
    for (const s of [N,E,S,W]){ const p=nb(r,c,s); const has=!!(m&s);
      if (p===null){ if(has) return false; } else { const nm=grid[p[0]][p[1]]; if (has !== !!(nm & OPP[s])) return false; } } }
  return true;
}

function runConstructive(seed, rows, cols, wrap) {
  const rand = rng(seed);
  const net = randomNetwork(rand, rows, cols, wrap);
  if (!net.complete) return; // skip degenerate gen (rare; keeps the oracle's "single network" invariant true)
  const solved = net.mask;
  const task = toTask(rand, solved, rows, cols);
  const res = new PipesSolver({ rows, cols, task, wrap }).solve();
  assert.equal(res.solved, true, `seed=${seed} ${rows}x${cols} wrap=${wrap}: should solve. task=${JSON.stringify(task)}`);
  assert.ok(edgesConsistent(res.grid, rows, cols, wrap), `seed=${seed}: solver grid edge-consistent`);
  for (let r=0;r<rows;r++) for (let c=0;c<cols;c++)
    assert.ok(PipesSolver.candidates(task[r][c]).includes(res.grid[r][c]), `seed=${seed}: (${r},${c}) is a rotation of task`);
}

test('PipesSolver constructive non-wrap 4x4 (40 trials)', () => { for (let s=1;s<=40;s++) runConstructive(s, 4, 4, false); });
test('PipesSolver constructive non-wrap 6x6 (30 trials)', () => { for (let s=100;s<=129;s++) runConstructive(s, 6, 6, false); });
test('PipesSolver constructive non-wrap 4x7 (20 trials)', () => { for (let s=200;s<=219;s++) runConstructive(s, 4, 7, false); });
test('PipesSolver constructive WRAP 5x5 (30 trials)', () => { for (let s=300;s<=329;s++) runConstructive(s, 5, 5, true); });
// Large WRAP boards are the hard case: the border rule never fires, so without
// loop-pruning the solver would explode (a real 60x40 monthly-wrap puzzle did
// not solve in 70 s before the fix; ~70 ms after). These big constructive
// trials lock in the loop-prune speedup AND correctness (runConstructive
// asserts solved + edge-consistent + every cell a rotation of its task).
test('PipesSolver constructive WRAP 30x30 (8 trials)', () => { for (let s=400;s<=407;s++) runConstructive(s, 30, 30, true); });
test('PipesSolver constructive WRAP 60x40 (4 trials)', () => {
  const t0 = Date.now();
  for (let s=500;s<=503;s++) runConstructive(s, 60, 40, true);
  assert.ok(Date.now() - t0 < 20000, 'four 60x40 wrap solves must finish well under 20s (loop-prune)');
});
