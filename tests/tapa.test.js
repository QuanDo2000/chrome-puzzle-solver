'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TapaSolver } = require('../src/solvers/tapa.js');

test('Tapa oracle: clue run-string, no-2x2, connectivity, clue cells never shaded', () => {
  // 3x3, centre clue 1 (one shaded neighbour). Shading just (0,1) -> centre sees run [1].
  const task = [[-1, -1, -1], [-1, 1, -1], [-1, -1, -1]];
  const s = new TapaSolver({ rows: 3, cols: 3, task });
  const sh = (cells) => { const g = [[0,0,0],[0,0,0],[0,0,0]]; for (const [r,c] of cells) g[r][c]=1; return g; };
  assert.equal(s._isValid(sh([[0,1]])), true);            // centre clue sees exactly one run of 1
  assert.equal(s._isValid(sh([[0,0],[0,1]])), false);     // run of 2 -> "2" != "1"
  assert.equal(s._isValid(sh([[1,1]])), false);           // clue cell shaded -> invalid
  // no-2x2: a fully shaded 2x2 is invalid (clue at (1,1) keeps it from being a real board, use 2x2 board)
  const t2 = new TapaSolver({ rows: 2, cols: 2, task: [[-1,-1],[-1,-1]] });
  assert.equal(t2._isValid([[1,1],[1,1]]), false);        // 2x2 all shaded
  // connectivity: two disjoint shaded cells -> invalid
  const t3 = new TapaSolver({ rows: 1, cols: 3, task: [[-1,-1,-1]] });
  assert.equal(t3._isValid([[1,0,1]]), false);            // disconnected
  assert.equal(t3._isValid([[1,1,0]]), true);             // connected
});

test('Tapa clue patterns: a clue enumerates only matching neighbour bitmasks', () => {
  const task = [[-1,-1,-1],[-1,8,-1],[-1,-1,-1]]; // clue 8 = all 8 neighbours shaded
  const s = new TapaSolver({ rows: 3, cols: 3, task });
  const cl = s.clues.find((x) => x.r === 1 && x.c === 1);
  assert.equal(cl.patterns.length, 1);          // only the all-8 mask
  assert.equal(cl.patterns[0], 255);
});

test('Tapa propagation: a clue with one pattern forces its neighbours', () => {
  // 3x3, centre clue 8 (all neighbours shaded) -> all 8 neighbours forced shaded.
  const s = new TapaSolver({ rows: 3, cols: 3, task: [[-1,-1,-1],[-1,8,-1],[-1,-1,-1]] });
  s._initG();
  assert.equal(s._propagate(), true);
  for (const [r, c] of [[0,0],[0,1],[0,2],[1,0],[1,2],[2,0],[2,1],[2,2]]) assert.equal(s.g[r][c], 1);
});

test('Tapa propagation: no-2x2 forces the 4th cell unshaded', () => {
  const s = new TapaSolver({ rows: 2, cols: 2, task: [[-1,-1],[-1,-1]] });
  s._initG();
  s.g[0][0] = 1; s.g[0][1] = 1; s.g[1][0] = 1; // three of a 2x2 shaded
  assert.equal(s._propagate(), true);
  assert.equal(s.g[1][1], 0); // forced unshaded
});

test('Tapa propagation: clue 0 forces all neighbours unshaded', () => {
  const s = new TapaSolver({ rows: 3, cols: 3, task: [[-1,-1,-1],[-1,0,-1],[-1,-1,-1]] });
  s._initG();
  assert.equal(s._propagate(), true);
  for (const [r, c] of [[0,0],[0,1],[0,2],[1,0],[1,2],[2,0],[2,1],[2,2]]) assert.equal(s.g[r][c], 0);
});

const REAL_TAPA = { rows: 6, cols: 6, task: [[-1,-1,-1,-1,-1,-1],[22,-1,33,7,-1,5],[-1,-1,-1,-1,-1,-1],[3,-1,-1,-1,-1,12],[12,-1,-1,-1,-1,3],[-1,-1,-1,-1,-1,-1]] };

test('Tapa solve: the real 6x6-hard board solves to a valid, oracle-passing board', () => {
  const s = new TapaSolver(REAL_TAPA);
  const r = s.solve();
  assert.equal(r.solved, true);
  assert.equal(r.partial, undefined);
  // grid value-space {0,1,2}; derive shaded boolean for the oracle
  const shaded = r.grid.map((row) => row.map((v) => (v === 1 ? 1 : 0)));
  assert.ok(s._isValid(shaded));
  assert.equal(shaded.flat().filter((x) => x).length, 23);
});

test('Tapa solve: the real 20x20-hard board FULL-solves fast (connectivity-prune regression)', () => {
  // Without the connectivity-feasibility prune this board takes ~20s; with it, ~36ms. A tight
  // 5s budget would time out to a partial if the prune ever regresses, so this guards it.
  const task = [[-1,-1,-1,12,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,13,-1,-1,-1],[4,-1,6,-1,-1,-1,112,-1,5,-1,-1,33,-1,122,-1,-1,-1,7,-1,4],[4,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,4],[-1,-1,7,-1,23,-1,-1,-1,-1,112,23,-1,-1,-1,-1,13,-1,4,-1,-1],[-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],[12,-1,-1,-1,-1,-1,-1,33,122,-1,-1,24,7,-1,-1,-1,-1,-1,-1,13],[-1,-1,6,-1,13,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,24,-1,7,-1,-1],[5,-1,-1,-1,5,-1,-1,-1,12,-1,-1,7,-1,-1,-1,24,-1,-1,-1,22],[-1,-1,6,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,24,-1,-1],[-1,-1,-1,-1,13,-1,-1,23,-1,22,13,-1,15,-1,-1,14,-1,-1,-1,-1],[-1,-1,-1,-1,12,-1,-1,33,-1,4,12,-1,23,-1,-1,6,-1,-1,-1,-1],[-1,-1,7,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,6,-1,-1],[5,-1,-1,-1,122,-1,-1,-1,15,-1,-1,13,-1,-1,-1,14,-1,-1,-1,5],[-1,-1,7,-1,22,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,12,-1,6,-1,-1],[5,-1,-1,-1,-1,-1,-1,113,6,-1,-1,13,5,-1,-1,-1,-1,-1,-1,13],[-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1],[-1,-1,14,-1,5,-1,-1,-1,-1,33,33,-1,-1,-1,-1,24,-1,14,-1,-1],[3,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,4],[4,-1,5,-1,-1,-1,122,-1,7,-1,-1,23,-1,12,-1,-1,-1,6,-1,4],[-1,-1,-1,12,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,12,-1,-1,-1]];
  const s = new TapaSolver({ rows: 20, cols: 20, task, maxMs: 5000 });
  const r = s.solve();
  assert.equal(r.solved, true);
  assert.equal(r.partial, undefined);
  assert.ok(s._isValid(r.grid.map((row) => row.map((v) => (v === 1 ? 1 : 0)))));
});

function rng(seed) { let x = seed >>> 0; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; }; }

test('Tapa soundness gate: solver matches brute-force across random tiny boards', () => {
  const DR = [-1,-1,-1,0,1,1,1,0], DC = [-1,0,1,1,1,0,-1,-1];
  const { tapaRunString } = require('../src/solvers/tapa.js');
  let tested = 0;
  for (let iter = 0; iter < 5000 && tested < 400; iter++) {
    const rnd = rng(iter * 2654435761 + 777);
    const rows = 3 + Math.floor(rnd() * 2), cols = 3 + Math.floor(rnd() * 2);
    const isCl = [], task = [];
    for (let r = 0; r < rows; r++) { isCl.push([]); task.push([]); for (let c = 0; c < cols; c++) { const clue = rnd() < 0.3; isCl[r].push(clue); task[r].push(clue ? 0 : -1); } }
    // derive each clue from a random seed shading of the non-clue cells
    const seed = []; for (let r = 0; r < rows; r++) { seed.push([]); for (let c = 0; c < cols; c++) seed[r].push(isCl[r][c] ? 0 : (rnd() < 0.5 ? 1 : 0)); }
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (isCl[r][c]) { let m = 0; for (let a = 0; a < 8; a++) { const h = r + DR[a], n = c + DC[a]; if (h >= 0 && n >= 0 && h < rows && n < cols && seed[h][n]) m |= 1 << a; } const v = tapaRunString(m); task[r][c] = v === '' ? 0 : parseInt(v, 10); }
    const free = []; for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (!isCl[r][c]) free.push([r, c]);
    if (!free.length || free.length > 14) continue;
    const oracle = new TapaSolver({ rows, cols, task });
    let brute = 0;
    for (let mask = 0; mask < (1 << free.length); mask++) { const sh = Array.from({ length: rows }, () => new Array(cols).fill(0)); for (let i = 0; i < free.length; i++) if (mask & (1 << i)) { const [r, c] = free[i]; sh[r][c] = 1; } if (oracle._isValid(sh)) brute++; }
    tested++;
    const solver = new TapaSolver({ rows, cols, task, maxMs: 5000 });
    const res = solver.solve(true);
    assert.equal(!!res.solved, brute > 0, `solved-mismatch task=${JSON.stringify(task)}`);
    if (res.solved) {
      const sh = res.grid.map((row) => row.map((v) => (v === 1 ? 1 : 0)));
      assert.ok(solver._isValid(sh), 'oracle rejects own solution');
      assert.equal(res.count === 1, brute === 1, `uniqueness task=${JSON.stringify(task)} brute=${brute} count=${res.count}`);
    }
  }
  assert.ok(tested >= 200, `gate exercised too few boards (${tested})`);
});

test('Tapa getHint: re-asserts clue cells unshaded and returns forced cells', () => {
  // 3x3 centre clue 8: from a blank live board, getHint forces all 8 neighbours shaded.
  const s = new TapaSolver({ rows: 3, cols: 3, task: [[-1,-1,-1],[-1,8,-1],[-1,-1,-1]], maxMs: 1000 });
  const live = [[0,0,0],[0,0,0],[0,0,0]]; // page cellStatus: clue cell (1,1) is 0 (untracked)
  const forced = s.getHint(live);
  const shadedForced = forced.filter((f) => f.value === 1).map((f) => `${f.row},${f.col}`).sort();
  assert.deepEqual(shadedForced, ['0,0','0,1','0,2','1,0','1,2','2,0','2,1','2,2']);
  assert.ok(forced.every((f) => f.value === 1 || f.value === 2));
});
