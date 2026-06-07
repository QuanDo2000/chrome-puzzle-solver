'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TentsSolver } = require('../src/solvers/tents.js');

test('Tents oracle: counts, 8-adjacency, tents-not-on-trees, perfect matching', () => {
  // 1x3: tree at col1. _isValid bundles counts AND matching, so each case is clue-consistent.
  const trees = [[0, 1, 0]];
  const s = new TentsSolver({ rows: 1, cols: 3, trees, colClue: [1, 0, 0], rowClue: [1] });
  assert.equal(s._isValid([[1, 0, 0]]), true);           // tent (0,0) matches tree (0,1); clues ok
  assert.equal(s._isValid([[1, 0, 1]]), false);          // col-clue mismatch + 2 tents / 1 tree
  assert.equal(s._isValid([[0, 1, 0]]), false);          // tent on a tree
  // a tent on the other side of the tree, with matching clues, is valid
  const s2 = new TentsSolver({ rows: 1, cols: 3, trees, colClue: [0, 0, 1], rowClue: [1] });
  assert.equal(s2._isValid([[0, 0, 1]]), true);          // tent (0,2) also matches tree (0,1)
  // 8-adjacency: 2x1, no trees, clue 0 — two vertically-adjacent tents are invalid
  const t2 = new TentsSolver({ rows: 2, cols: 1, trees: [[0], [0]], colClue: [0], rowClue: [0, 0] });
  assert.equal(t2._isValid([[1], [1]]), false);          // vertically-adjacent tents (also clue/match fail)
});

test('Tents matching: a placement passing counts+adjacency but failing the matching is invalid', () => {
  // 1x5 trees at col0,col4; tent at col2 only (adjacent to no tree) -> matching 0.
  const s = new TentsSolver({ rows: 1, cols: 5, trees: [[1, 0, 0, 0, 1]], colClue: [0, 0, 1, 0, 0], rowClue: [1] });
  assert.equal(s._isValid([[0, 0, 1, 0, 0]]), false);    // tent at (0,2) adjacent to no tree
});

test('Tents propagation: a placed tent crosses its 8 neighbours to grass', () => {
  // Clues [0,1,0] are the only ones consistent with a centre tent + its 8 grass neighbours
  // (rows/cols 0 and 2 end up all grass). Adjacency runs first in _propagate and forces them.
  const s = new TentsSolver({ rows: 3, cols: 3, trees: [[0,0,0],[0,0,0],[0,0,0]], colClue: [0,1,0], rowClue: [0,1,0] });
  s._initG();
  assert.equal(s._set(1, 1, 1), true); // a tent at centre (via _set so the worklist enqueues it)
  assert.equal(s._propagate(), true);
  for (const [r, c] of [[0,0],[0,1],[0,2],[1,0],[1,2],[2,0],[2,1],[2,2]]) assert.equal(s.g[r][c], 2);
});

test('Tents propagation: row/col count forcing', () => {
  // 1x3 row clue 0 -> all grass.
  const s = new TentsSolver({ rows: 1, cols: 3, trees: [[0,0,0]], colClue: [0,0,0], rowClue: [0] });
  s._initG();
  assert.equal(s._propagate(), true);
  for (const c of [0,1,2]) assert.equal(s.g[0][c], 2);
});

test('Tents propagation: a tree with a single possible adjacent tent forces it', () => {
  // 1x3, tree at col0: its only orthogonal in-row neighbour is col1 -> forced tent.
  const s = new TentsSolver({ rows: 1, cols: 3, trees: [[1,0,0]], colClue: [0,1,0], rowClue: [1] });
  s._initG();
  assert.equal(s._propagate(), true);
  assert.equal(s.g[0][1], 1); // forced tent (only adjacent non-tree cell of the tree)
});

const REAL_TENTS = {
  rows: 15, cols: 15,
  task: ["6","1","6","0","4","3","2","3","3","3","3","3","2","4","2","4","3","4","1","4","2","4","3","4","1","5","2","3","3","2"].map(Number),
  trees: [[0,0,0,0,0,0,0,0,1,0,0,0,0,1,0],[1,0,0,1,0,0,0,1,0,0,0,0,0,0,0],[0,0,1,0,0,1,0,0,0,0,0,0,0,0,1],[1,0,0,0,0,0,0,0,1,1,0,1,0,0,0],[0,1,0,1,0,0,1,0,0,0,0,0,0,1,0],[0,0,0,0,0,0,0,1,0,0,0,1,0,0,0],[0,1,0,0,1,0,0,0,0,0,0,0,0,1,0],[1,0,0,0,0,0,0,0,0,0,0,0,0,1,0],[0,0,0,0,0,0,0,0,0,1,1,0,0,0,1],[1,0,1,0,0,1,0,0,0,0,0,0,1,0,0],[0,0,0,0,0,0,0,1,0,0,0,0,0,0,0],[0,0,1,0,1,0,0,0,1,1,0,0,0,1,0],[1,0,0,1,0,0,0,0,0,0,0,0,0,1,0],[0,0,0,0,1,0,0,1,1,0,0,0,0,0,0],[0,0,1,0,0,1,0,0,0,0,0,1,0,0,0]],
};
function mkReal() { return new TentsSolver({ rows: 15, cols: 15, trees: REAL_TENTS.trees, colClue: REAL_TENTS.task.slice(0, 15), rowClue: REAL_TENTS.task.slice(15) }); }

test('Tents solve: the real 15x15-hard board solves to a valid, oracle-passing board', () => {
  const s = mkReal();
  const r = s.solve();
  assert.equal(r.solved, true);
  assert.equal(r.partial, undefined);
  const tent = r.grid.map((row) => row.map((v) => (v === 1 ? 1 : 0)));
  assert.ok(s._isValid(tent));
  assert.equal(tent.flat().filter((x) => x).length, 45); // 45 tents = 45 trees
});

test('Tents getHint: re-asserts trees not-tent and returns forced cells', () => {
  // 1x3, tree at col0, colClue [0,1,0], rowClue [1]: from blank, getHint forces (0,1) tent + (0,2) grass.
  const s = new TentsSolver({ rows: 1, cols: 3, trees: [[1,0,0]], colClue: [0,1,0], rowClue: [1], maxMs: 1000 });
  const forced = s.getHint([[0, 0, 0]]); // page cellStatus: tree cell (0,0) is 0 (untracked)
  assert.ok(forced.some((f) => f.row === 0 && f.col === 1 && f.value === 1)); // tent
  assert.ok(forced.every((f) => f.value === 1 || f.value === 2));
});

function rng(seed) { let x = seed >>> 0; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; }; }

test('Tents soundness gate: solver matches brute-force across random tiny boards', () => {
  const D8R = [-1,-1,-1,0,1,1,1,0], D8C = [-1,0,1,1,1,0,-1,-1], D4R = [-1,1,0,0], D4C = [0,0,-1,1];
  let tested = 0;
  for (let iter = 0; iter < 6000 && tested < 300; iter++) {
    const rnd = rng(iter * 2654435761 + 555);
    const rows = 3 + Math.floor(rnd() * 2), cols = 3 + Math.floor(rnd() * 2);
    const trees = []; let nt = 0;
    for (let r = 0; r < rows; r++) { trees.push([]); for (let c = 0; c < cols; c++) { const t = rnd() < 0.25 ? 1 : 0; trees[r].push(t); if (t) nt++; } }
    if (!nt) continue;
    const freeCells = []; for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (!trees[r][c]) freeCells.push([r, c]);
    if (!freeCells.length || freeCells.length > 16) continue;
    const treeList = []; for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (trees[r][c]) treeList.push([r, c]);
    const toTent = (mask) => { const t = []; for (let r = 0; r < rows; r++) { t.push([]); for (let c = 0; c < cols; c++) t[r].push(0); } for (let i = 0; i < freeCells.length; i++) if (mask & (1 << i)) { const [r, c] = freeCells[i]; t[r][c] = 1; } return t; };
    const structOK = (tent) => {
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (tent[r][c]) { for (let a = 0; a < 8; a++) { const nr = r + D8R[a], nc = c + D8C[a]; if (nr >= 0 && nc >= 0 && nr < rows && nc < cols && tent[nr][nc]) return false; } }
      let total = 0; for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (tent[r][c]) total++; if (total !== nt) return false;
      const mc = new Map(); const tryK = (ti, seen) => { const [tr, tc] = treeList[ti]; for (let a = 0; a < 4; a++) { const r = tr + D4R[a], c = tc + D4C[a]; if (r < 0 || c < 0 || r >= rows || c >= cols || !tent[r][c]) continue; const id = r * cols + c; if (seen.has(id)) continue; seen.add(id); if (!mc.has(id) || tryK(mc.get(id), seen)) { mc.set(id, ti); return true; } } return false; };
      let m = 0; for (let ti = 0; ti < nt; ti++) if (tryK(ti, new Set())) m++; return m === nt;
    };
    const structural = []; for (let mask = 0; mask < (1 << freeCells.length); mask++) { const t = toTent(mask); if (structOK(t)) structural.push(t); }
    if (!structural.length) continue;
    const C = structural[Math.floor(rnd() * structural.length)];
    const colClue = new Array(cols).fill(0), rowClue = new Array(rows).fill(0);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (C[r][c]) { rowClue[r]++; colClue[c]++; }
    const oracle = new TentsSolver({ rows, cols, trees, colClue, rowClue });
    let brute = 0; for (let mask = 0; mask < (1 << freeCells.length); mask++) if (oracle._isValid(toTent(mask))) brute++;
    tested++;
    const solver = new TentsSolver({ rows, cols, trees, colClue, rowClue, maxMs: 5000 });
    const res = solver.solve(true);
    assert.equal(!!res.solved, brute > 0, `solved-mismatch trees=${JSON.stringify(trees)}`);
    if (res.solved) {
      const tent = res.grid.map((row) => row.map((v) => (v === 1 ? 1 : 0)));
      assert.ok(solver._isValid(tent), 'oracle rejects own solution');
      assert.equal(res.count === 1, brute === 1, `uniqueness trees=${JSON.stringify(trees)} brute=${brute} count=${res.count}`);
    }
  }
  assert.ok(tested >= 150, `gate exercised too few boards (${tested})`);
});
