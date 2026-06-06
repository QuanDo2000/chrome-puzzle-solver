'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { StitchesSolver } = require('../src/solvers/stitches.js');

// A 1x3 strip, three regions A|B|C, K=1: edges H(0,0) [A-B] and H(0,1) [B-C].
// The only valid board selects both (each pair needs 1 stitch); each cell deg<=1
// (cell (0,1) is shared but degree 2 if both selected -> INVALID). So K=1 here is
// infeasible by degree; use it to exercise the oracle's degree + pair rules.
const AREAS_3 = [[0, 1, 2]];

test('Stitches oracle: region-pair exactly-K, degree<=1, line-count', () => {
  const s = new StitchesSolver({ rows: 1, cols: 3, areas: AREAS_3, colClue: [1, 0, 1], rowClue: [2], stitches: 1 });
  // both stitches placed: pairs A-B and B-C each have 1 (ok), but cell (0,1) has degree 2 -> invalid
  assert.equal(s._isValid({ horizontal: [[1, 1, 0]], vertical: [[0, 0, 0]] }), false);
  // 1x2 two regions K=1, one stitch, both cells endpoints.
  const t = new StitchesSolver({ rows: 1, cols: 2, areas: [[0, 1]], colClue: [1, 1], rowClue: [2], stitches: 1 });
  assert.equal(t._isValid({ horizontal: [[1, 0]], vertical: [[0, 0]] }), true);
  assert.equal(t._isValid({ horizontal: [[0, 0]], vertical: [[0, 0]] }), false); // pair A-B has 0 != K
  // wrong line clue:
  assert.equal(new StitchesSolver({ rows: 1, cols: 2, areas: [[0, 1]], colClue: [0, 1], rowClue: [2], stitches: 1 })._isValid({ horizontal: [[1, 0]], vertical: [[0, 0]] }), false);
});

test('Stitches: edge enumeration counts only cross-region borders', () => {
  // 1x3 with regions [0,0,1]: only ONE border (between col1 and col2).
  const s = new StitchesSolver({ rows: 1, cols: 3, areas: [[0, 0, 1]], colClue: [0, 1, 1], rowClue: [2], stitches: 1 });
  assert.equal(s.edges.length, 1);
  assert.equal(s.edges[0].type, 'h');
  assert.equal(s.edges[0].c, 1);
});

test('Stitches propagation: region-pair forcing selects when candidates == K', () => {
  // 1x2, regions [0,1], K=1, single candidate edge -> must be selected.
  const s = new StitchesSolver({ rows: 1, cols: 2, areas: [[0, 1]], colClue: [1, 1], rowClue: [2], stitches: 1 });
  s._initState();
  assert.equal(s._propagate(), true);
  assert.equal(s.st[0], 1); // the only edge forced selected
});

test('Stitches propagation: cell degree <= 1 rejects conflicting edges', () => {
  // 1x3 regions [0,1,2], K=1: edges H(0,0)[0-1], H(0,1)[1-2]. Cell (0,1) shared.
  // Forcing both would degree-2 cell (0,1) -> contradiction.
  const s = new StitchesSolver({ rows: 1, cols: 3, areas: [[0, 1, 2]], colClue: [1, 0, 1], rowClue: [2], stitches: 1 });
  s._initState();
  assert.equal(s._propagate(), false); // both pairs need their only edge, but they share cell (0,1)
});

test('Stitches propagation: a zero row-clue rejects edges in that row, leaving the pair satisfiable', () => {
  // 2x3, region 0 = left two cols, region 1 = right col. Two candidate stitches cross the
  // border: H(0,1) (cells (0,1)-(0,2)) and H(1,1) (cells (1,1)-(1,2)); pair 0-1, K=1.
  // rowClue[0]=0 forbids endpoints in row 0 -> reject H(0,1); the pair then forces H(1,1).
  const s = new StitchesSolver({ rows: 2, cols: 3, areas: [[0, 0, 1], [0, 0, 1]], colClue: [0, 1, 1], rowClue: [0, 2], stitches: 1 });
  s._initState();
  assert.equal(s._propagate(), true); // feasible
  const eH01 = s.edges.findIndex((e) => e.type === 'h' && e.r === 0 && e.c === 1);
  const eH11 = s.edges.findIndex((e) => e.type === 'h' && e.r === 1 && e.c === 1);
  assert.equal(s.st[eH01], 0); // rejected (row-0 clue is 0)
  assert.equal(s.st[eH11], 1); // forced (pair 0-1 still needs its one stitch)
});

const REAL = {
  rows: 15, cols: 15, stitches: 3,
  task: ["1","5","6","8","10","9","5","10","4","4","8","6","1","7","0","2","4","6","7","9","4","10","7","6","8","6","3","7","4","1"].map(Number),
  areas: [[0,0,0,0,1,1,1,1,1,1,1,1,1,1,1],[0,0,0,0,1,0,1,1,1,1,1,1,1,1,1],[0,0,0,0,0,0,2,1,2,1,3,3,1,1,1],[0,0,4,0,0,2,2,1,2,1,1,3,3,3,1],[4,0,4,2,0,2,2,2,2,2,1,1,3,3,1],[4,0,4,2,2,2,4,4,3,2,2,3,3,3,3],[4,0,4,2,2,2,4,4,3,2,2,3,3,3,3],[4,4,4,4,4,4,4,4,3,3,3,3,5,3,5],[4,4,4,6,5,4,5,3,3,5,5,3,5,5,5],[6,6,4,6,5,4,5,3,3,3,5,3,3,5,5],[6,6,4,6,5,5,5,5,5,5,5,5,5,5,5],[6,6,6,6,5,5,6,6,7,5,7,7,5,7,5],[6,6,6,6,5,5,6,6,7,5,7,5,5,7,5],[6,6,6,6,5,5,6,7,7,7,7,7,5,7,7],[6,6,6,6,6,6,6,6,6,6,7,7,7,7,7]],
};
function mkReal(maxMs = 30000) {
  return new StitchesSolver({ rows: REAL.rows, cols: REAL.cols, areas: REAL.areas, colClue: REAL.task.slice(0, 15), rowClue: REAL.task.slice(15), stitches: REAL.stitches, maxMs });
}

test('Stitches solve: the real 15x15-3 board solves to a valid, oracle-passing board', () => {
  const s = mkReal();
  const r = s.solve();
  assert.equal(r.solved, true);
  assert.equal(r.partial, undefined);
  assert.ok(s._isValid({ horizontal: r.horizontal, vertical: r.vertical }));
  // 14 region-pairs x 3 = 42 stitches
  let n = 0; for (const row of r.horizontal) for (const v of row) if (v === 1) n++; for (const row of r.vertical) for (const v of row) if (v === 1) n++;
  assert.equal(n, 42);
});

// Brute-force differential soundness gate (no page oracle exists).
function rng(seed) { let x = seed >>> 0; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; }; }

test('Stitches soundness gate: solver matches brute-force across random tiny boards', () => {
  let tested = 0;
  for (let iter = 0; iter < 1500 && tested < 400; iter++) {
    const rnd = rng(iter * 2654435761 + 12345);
    const rows = 2 + Math.floor(rnd() * 2), cols = 2 + Math.floor(rnd() * 2);
    const nreg = 2 + Math.floor(rnd() * 2), K = 1 + Math.floor(rnd() * 2);
    const areas = []; for (let r = 0; r < rows; r++) { areas.push([]); for (let c = 0; c < cols; c++) areas[r].push(Math.floor(rnd() * nreg)); }
    const probe = new StitchesSolver({ rows, cols, areas, colClue: new Array(cols).fill(0), rowClue: new Array(rows).fill(0), stitches: K });
    const E = probe.edges; if (!E.length || E.length > 16) continue;
    // structurally-valid configs (region==K, degree<=1)
    const pairs = [...probe.pairEdges.keys()];
    const structural = [];
    for (let mask = 0; mask < (1 << E.length); mask++) {
      const pc = new Map(pairs.map((p) => [p, 0])); const deg = new Int32Array(rows * cols); let ok = true;
      for (let i = 0; i < E.length; i++) if (mask & (1 << i)) { pc.set(E[i].pair, pc.get(E[i].pair) + 1); for (const cid of E[i].cells) if (++deg[cid] > 1) ok = false; }
      if (!ok) continue; let allK = true; for (const [, v] of pc) if (v !== K) { allK = false; break; }
      if (allK) structural.push(mask);
    }
    if (!structural.length) continue;
    // derive clues from a random structurally-valid config
    const C = structural[Math.floor(rnd() * structural.length)]; const deg = new Int32Array(rows * cols);
    for (let i = 0; i < E.length; i++) if (C & (1 << i)) for (const cid of E[i].cells) deg[cid]++;
    const rowClue = new Array(rows).fill(0), colClue = new Array(cols).fill(0);
    for (let i = 0; i < deg.length; i++) if (deg[i] === 1) { rowClue[Math.floor(i / cols)]++; colClue[i % cols]++; }
    // brute solutions
    const toSol = (mask) => { const H = Array.from({ length: rows }, () => new Array(cols).fill(0)), V = Array.from({ length: rows }, () => new Array(cols).fill(0)); for (let i = 0; i < E.length; i++) if (mask & (1 << i)) { const e = E[i]; if (e.type === 'h') H[e.r][e.c] = 1; else V[e.r][e.c] = 1; } return { horizontal: H, vertical: V }; };
    const oracleS = new StitchesSolver({ rows, cols, areas, colClue, rowClue, stitches: K });
    let brute = 0; for (let mask = 0; mask < (1 << E.length); mask++) if (oracleS._isValid(toSol(mask))) brute++;
    tested++;
    const solver = new StitchesSolver({ rows, cols, areas, colClue, rowClue, stitches: K, maxMs: 5000 });
    const res = solver.solve(true); // countAll for uniqueness
    assert.equal(!!res.solved, brute > 0, `solved-mismatch areas=${JSON.stringify(areas)} K=${K}`);
    if (res.solved) {
      assert.ok(solver._isValid({ horizontal: res.horizontal, vertical: res.vertical }), 'oracle rejects own solution');
      assert.equal(res.count === 1, brute === 1, `uniqueness areas=${JSON.stringify(areas)} K=${K} brute=${brute} count=${res.count}`);
    }
  }
  assert.ok(tested >= 200, `gate exercised too few boards (${tested})`);
});

test('Stitches _deduceForced: forces a region pair whose only candidate edges == K', () => {
  // 1x2 regions [0,1] K=1: empty live board -> the single edge is forced selected.
  const s = new StitchesSolver({ rows: 1, cols: 2, areas: [[0, 1]], colClue: [1, 1], rowClue: [2], stitches: 1, maxMs: 1000 });
  const H = [[0, 0]], V = [[0, 0]];
  const forced = s._deduceForced(H, V);
  assert.ok(forced.some((f) => f.type === 'horizontal' && f.r === 0 && f.c === 0 && f.value === 1));
});

test('Stitches _deduceForced: returns [] on a contradictory live board', () => {
  const s = new StitchesSolver({ rows: 1, cols: 3, areas: [[0, 1, 2]], colClue: [1, 0, 1], rowClue: [2], stitches: 1, maxMs: 1000 });
  const forced = s._deduceForced([[1, 1, 0]], [[0, 0, 0]]); // cell (0,1) degree 2
  assert.deepEqual(forced, []);
});

test('Stitches diff: a board stitch absent from the solution is flagged; UNKNOWN never', () => {
  const { computePuzzleDiff } = require('../src/solvers/diff.js');
  const solution = { horizontal: [[1, 0]], vertical: [[0, 0]] };
  const board = { horizontal: [[0, 1]], vertical: [[0, 0]] }; // stitch at (0,1) not in solution
  const d = computePuzzleDiff('stitches', board, solution);
  assert.ok(d.some((m) => m.orientation === 'h' && m.r === 0 && m.c === 1));
  assert.equal(computePuzzleDiff('stitches', { horizontal: [[1, 0]], vertical: [[0, 0]] }, solution).length, 0);
});
