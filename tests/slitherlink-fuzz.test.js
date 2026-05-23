const test = require('node:test');
const assert = require('node:assert/strict');
const { SlitherlinkSolver } = require('../solver.js');

// Deterministic LCG so failures reproduce.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// Independent validator. Returns { ok, reason } where ok=true means the edge
// set is a single closed loop satisfying every clue.
function validateSlitherlinkSolution(task, result) {
  const H = task.length, W = task[0].length;
  const { horizontal, vertical } = result;
  if (!horizontal || !vertical) return { ok: false, reason: 'missing arrays' };
  if (horizontal.length !== H + 1) return { ok: false, reason: 'wrong horizontal rows' };
  if (vertical.length !== H) return { ok: false, reason: 'wrong vertical rows' };

  // 1. clues satisfied exactly (count only LINE=1 edges; EMPTY=2, UNKNOWN=0).
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const k = task[r][c];
      if (k < 0) continue;
      const m = (horizontal[r][c] === 1 ? 1 : 0) + (horizontal[r + 1][c] === 1 ? 1 : 0)
              + (vertical[r][c] === 1 ? 1 : 0)   + (vertical[r][c + 1] === 1 ? 1 : 0);
      if (m !== k) return { ok: false, reason: `clue ${k} at (${r},${c}) got ${m}` };
    }
  }
  // 2. every dot has degree 0 or 2.
  const degree = (r, c) => {
    let m = 0;
    if (c > 0 && horizontal[r][c - 1] === 1) m++;
    if (c < W && horizontal[r][c] === 1) m++;
    if (r > 0 && vertical[r - 1][c] === 1) m++;
    if (r < H && vertical[r][c] === 1) m++;
    return m;
  };
  let lineEdges = 0;
  for (let r = 0; r <= H; r++) {
    for (let c = 0; c <= W; c++) {
      const d = degree(r, c);
      if (d !== 0 && d !== 2) return { ok: false, reason: `dot (${r},${c}) degree ${d}` };
    }
  }
  for (let r = 0; r <= H; r++) for (let c = 0; c < W; c++) if (horizontal[r][c] === 1) lineEdges++;
  for (let r = 0; r < H; r++) for (let c = 0; c <= W; c++) if (vertical[r][c] === 1) lineEdges++;
  if (lineEdges === 0) return { ok: false, reason: 'no LINE edges' };

  // 3. all LINE edges form a single closed loop.
  const adj = new Map();
  const addAdj = (r, c, id) => {
    const k = r * (W + 1) + c;
    let a = adj.get(k);
    if (!a) { a = []; adj.set(k, a); }
    a.push(id);
  };
  const edgeList = [];
  for (let r = 0; r <= H; r++) {
    for (let c = 0; c < W; c++) {
      if (horizontal[r][c] === 1) {
        const id = edgeList.length;
        edgeList.push({ kind: 'h', r, c, a: [r, c], b: [r, c + 1] });
        addAdj(r, c, id); addAdj(r, c + 1, id);
      }
    }
  }
  for (let r = 0; r < H; r++) {
    for (let c = 0; c <= W; c++) {
      if (vertical[r][c] === 1) {
        const id = edgeList.length;
        edgeList.push({ kind: 'v', r, c, a: [r, c], b: [r + 1, c] });
        addAdj(r, c, id); addAdj(r + 1, c, id);
      }
    }
  }
  const seen = new Uint8Array(edgeList.length);
  const stack = [0];
  seen[0] = 1;
  let visited = 1;
  while (stack.length) {
    const eid = stack.pop();
    const e = edgeList[eid];
    for (const [r, c] of [e.a, e.b]) {
      for (const nb of adj.get(r * (W + 1) + c) || []) {
        if (!seen[nb]) { seen[nb] = 1; visited++; stack.push(nb); }
      }
    }
  }
  if (visited !== edgeList.length) return { ok: false, reason: `${visited}/${edgeList.length} edges in main loop` };
  return { ok: true };
}

// Build a solvable Slitherlink puzzle from a known closed-loop rectangle.
function buildLoopPuzzle(H, W, rect) {
  const horizontal = Array.from({ length: H + 1 }, () => new Array(W).fill(0));
  const vertical   = Array.from({ length: H },     () => new Array(W + 1).fill(0));
  for (let c = rect.c0; c <= rect.c1; c++) horizontal[rect.r0][c] = 1;
  for (let c = rect.c0; c <= rect.c1; c++) horizontal[rect.r1 + 1][c] = 1;
  for (let r = rect.r0; r <= rect.r1; r++) vertical[r][rect.c0] = 1;
  for (let r = rect.r0; r <= rect.r1; r++) vertical[r][rect.c1 + 1] = 1;

  const task = [];
  for (let r = 0; r < H; r++) {
    const row = new Array(W);
    for (let c = 0; c < W; c++) {
      row[c] = horizontal[r][c] + horizontal[r + 1][c]
             + vertical[r][c] + vertical[r][c + 1];
    }
    task.push(row);
  }
  return { task, horizontal, vertical };
}

test('SlitherlinkSolver fuzz: every constructed loop puzzle solves to a valid loop', () => {
  const rng = makeRng(0xBEEF);
  for (let iter = 0; iter < 50; iter++) {
    const H = 4 + Math.floor(rng() * 3); // 4..6
    const W = 4 + Math.floor(rng() * 3);
    const r0 = Math.floor(rng() * (H - 1));
    const c0 = Math.floor(rng() * (W - 1));
    const r1 = r0 + 1 + Math.floor(rng() * (H - r0 - 1));
    const c1 = c0 + 1 + Math.floor(rng() * (W - c0 - 1));
    const { task: fullTask } = buildLoopPuzzle(H, W, { r0, c0, r1, c1 });
    const maskedTask = fullTask.map(row => row.slice());
    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) {
        if (rng() < 0.5) maskedTask[r][c] = -1;
      }
    }
    SlitherlinkSolver.clearSolutionCache();
    const s = new SlitherlinkSolver({ width: W, height: H, task: maskedTask });
    s.maxMs = 5000;
    const result = s.solve();
    assert.equal(result.solved, true, `iter ${iter}: solver failed a solvable board (rect ${r0},${c0}-${r1},${c1})`);
    const v = validateSlitherlinkSolution(maskedTask, result);
    assert.equal(v.ok, true, `iter ${iter}: ${v.reason}`);
  }
});

test('SlitherlinkSolver fuzz: 4x4 brute-force completeness sanity', () => {
  const H = 4, W = 4;
  function loopFromFilling(filling) {
    const horizontal = Array.from({ length: H + 1 }, () => new Array(W).fill(0));
    const vertical   = Array.from({ length: H },     () => new Array(W + 1).fill(0));
    for (let r = 0; r <= H; r++) {
      for (let c = 0; c < W; c++) {
        const above = r > 0 ? filling[r - 1][c] : 0;
        const below = r < H ? filling[r][c]     : 0;
        if (above !== below) horizontal[r][c] = 1;
      }
    }
    for (let r = 0; r < H; r++) {
      for (let c = 0; c <= W; c++) {
        const left  = c > 0 ? filling[r][c - 1] : 0;
        const right = c < W ? filling[r][c]     : 0;
        if (left !== right) vertical[r][c] = 1;
      }
    }
    return { horizontal, vertical };
  }
  const filling = [
    [0, 0, 0, 0],
    [0, 1, 1, 0],
    [0, 1, 1, 0],
    [0, 0, 0, 0],
  ];
  const sol = loopFromFilling(filling);
  const task = [];
  for (let r = 0; r < H; r++) {
    const row = new Array(W);
    for (let c = 0; c < W; c++) {
      row[c] = sol.horizontal[r][c] + sol.horizontal[r + 1][c]
             + sol.vertical[r][c] + sol.vertical[r][c + 1];
    }
    task.push(row);
  }
  SlitherlinkSolver.clearSolutionCache();
  const s = new SlitherlinkSolver({ width: W, height: H, task });
  s.maxMs = 5000;
  const r = s.solve();
  assert.equal(r.solved, true);
  const v = validateSlitherlinkSolution(task, r);
  assert.equal(v.ok, true, v.reason);
  // _emit now outputs 1=LINE or 2=EMPTY; sol uses 1=LINE or 0=EMPTY.
  // Normalise both to 1=LINE, 0=not-LINE for the structural comparison.
  const normalise = grid => grid.map(row => row.map(v => v === 1 ? 1 : 0));
  assert.deepEqual(normalise(r.horizontal), sol.horizontal);
  assert.deepEqual(normalise(r.vertical),   sol.vertical);
});
