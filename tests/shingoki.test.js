'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ShingokiSolver } = require('../src/solvers/shingoki.js');

test('ShingokiSolver: decodeClue splits sign into color + number', () => {
  assert.deepEqual(ShingokiSolver.decodeClue(0), null);
  assert.deepEqual(ShingokiSolver.decodeClue(3), { color: 'white', n: 3 });
  assert.deepEqual(ShingokiSolver.decodeClue(-5), { color: 'black', n: 5 });
});

test('ShingokiSolver: incidentEdges lists in-range W/E/N/S edge refs', () => {
  // 2x2 cells -> 3x3 vertices. H dims 3x2, V dims 2x3.
  const s = new ShingokiSolver({ rows: 2, cols: 2, task: [[0,0,0],[0,0,0],[0,0,0]] });
  // corner vertex (0,0): only East H[0][0] and South V[0][0]
  assert.deepEqual(s.incidentEdges(0, 0).sort(byKey), [
    { kind: 'H', r: 0, c: 0 }, { kind: 'V', r: 0, c: 0 },
  ].sort(byKey));
  // center vertex (1,1): all four
  assert.equal(s.incidentEdges(1, 1).length, 4);
  function byKey(a, b) { return (a.kind+a.r+a.c).localeCompare(b.kind+b.r+b.c); }
});

test('ShingokiSolver: a vertex with two lines crosses out its other edges', () => {
  // 2x2 cells. Force two lines into center vertex (1,1): E and S.
  const s = new ShingokiSolver({ rows: 2, cols: 2, task: [[0,0,0],[0,0,0],[0,0,0]] });
  s._initState();
  s.setEdge({ kind: 'H', r: 1, c: 1 }, 1); // East of (1,1)
  s.setEdge({ kind: 'V', r: 1, c: 1 }, 1); // South of (1,1)
  assert.equal(s._propagate(), true);
  // West H[1][0] and North V[0][1] must be crossed (2).
  assert.equal(s.getEdge({ kind: 'H', r: 1, c: 0 }), 2);
  assert.equal(s.getEdge({ kind: 'V', r: 0, c: 1 }), 2);
});

test('ShingokiSolver: white clue forbids a turn (collinear edges only)', () => {
  // White at center vertex (1,1): if East is a line, West must be a line too.
  const s = new ShingokiSolver({ rows: 2, cols: 2, task: [[0,0,0],[0,3,0],[0,0,0]] });
  s._initState();
  s.setEdge({ kind: 'H', r: 1, c: 1 }, 1); // East line
  assert.equal(s._propagate(), true);
  assert.equal(s.getEdge({ kind: 'H', r: 1, c: 0 }), 1); // West forced line (straight)
  assert.equal(s.getEdge({ kind: 'V', r: 0, c: 1 }), 2); // North crossed
  assert.equal(s.getEdge({ kind: 'V', r: 1, c: 1 }), 2); // South crossed
});

test('ShingokiSolver: black clue forbids straight (perpendicular only)', () => {
  // Black at center vertex (1,1): if East is a line, West must be crossed.
  const s = new ShingokiSolver({ rows: 2, cols: 2, task: [[0,0,0],[0,-3,0],[0,0,0]] });
  s._initState();
  s.setEdge({ kind: 'H', r: 1, c: 1 }, 1); // East line
  assert.equal(s._propagate(), true);
  assert.equal(s.getEdge({ kind: 'H', r: 1, c: 0 }), 2); // West forced cross (must turn)
});

test('ShingokiSolver: circled vertex cannot be degree 0', () => {
  // White clue at (1,1); cross 3 of its 4 edges -> contradiction (cannot reach degree 2).
  const s = new ShingokiSolver({ rows: 2, cols: 2, task: [[0,0,0],[0,3,0],[0,0,0]] });
  s._initState();
  s.setEdge({ kind: 'H', r: 1, c: 0 }, 2);
  s.setEdge({ kind: 'H', r: 1, c: 1 }, 2);
  s.setEdge({ kind: 'V', r: 0, c: 1 }, 2);
  assert.equal(s._propagate(), false); // South alone can't make degree 2
});

test('ShingokiSolver: white clued vertex stuck at degree 1 is a contradiction', () => {
  // White at (1,1). East line + West cross => the collinear partner is gone,
  // so the white "straight" shape can never hold (would need both H edges).
  // _propagate must report the contradiction, not return true.
  const s = new ShingokiSolver({ rows: 2, cols: 2, task: [[0,0,0],[0,3,0],[0,0,0]] });
  s._initState();
  s.setEdge({ kind: 'H', r: 1, c: 1 }, 1); // East line
  s.setEdge({ kind: 'H', r: 1, c: 0 }, 2); // West cross
  assert.equal(s._propagate(), false);
});

test('ShingokiSolver: runLength sums both straight directions at a circle', () => {
  const s = new ShingokiSolver({ rows: 1, cols: 3, task: [[0,0,0,0],[0,0,0,0]] });
  s._initState();
  // Lay a straight horizontal segment along vertex-row 0: H[0][0],H[0][1],H[0][2] lines.
  s.H[0][0] = 1; s.H[0][1] = 1; s.H[0][2] = 1;
  // White circle at vertex (0,1): West run (1 edge: H[0][0]) + East run (H[0][1],H[0][2] = 2 edges) = 3.
  assert.equal(s.runLengthAt(0, 1), 3);
});

test('ShingokiSolver: numbersSatisfied rejects wrong clue total', () => {
  const s = new ShingokiSolver({ rows: 1, cols: 3, task: [[0,5,0,0],[0,0,0,0]] }); // white 5 at (0,1)
  s._initState();
  s.H[0][0] = 1; s.H[0][1] = 1; s.H[0][2] = 1; // run = 3, clue says 5
  assert.equal(s.numbersSatisfied(), false);
});

test('ShingokiSolver: solves the smallest loop (1x1 cell = 2x2 vertices)', () => {
  // 1x1 board: the only loop is the unit square. White clue forces it onto the loop.
  const s = new ShingokiSolver({ rows: 1, cols: 1, task: [[2,0],[0,0]] });
  const res = s.solve();
  assert.equal(res.solved, true);
  assert.equal(res.horizontal[0][0], 1);
  assert.equal(res.horizontal[1][0], 1);
  assert.equal(res.vertical[0][0], 1);
  assert.equal(res.vertical[0][1], 1);
});

test('ShingokiSolver: solves the captured real 5x5-easy task (single loop)', () => {
  const task = [
    [0,-5,0,0,0,0],
    [0,0,0,-4,0,0],
    [0,0,2,0,0,0],
    [-3,2,0,0,2,-4],
    [-3,0,0,-2,0,0],
    [0,0,0,-2,0,0],
  ];
  const res = new ShingokiSolver({ rows: 5, cols: 5, task, maxMs: 10000 }).solve();
  assert.equal(res.solved, true);
  assert.equal(res.horizontal.length, 6);
  assert.equal(res.horizontal[0].length, 5);
  assert.equal(res.vertical.length, 5);
  assert.equal(res.vertical[0].length, 6);
  const check = new ShingokiSolver({ rows: 5, cols: 5, task });
  check.H = res.horizontal; check.V = res.vertical;
  assert.equal(check.numbersSatisfied(), true);
});

test('ShingokiSolver: solves a loop that leaves vertices off the loop (premature-prune regression)', () => {
  // 4x4-cell board (5x5 vertices). Loop = perimeter of the rectangle of
  // vertices (1,1)..(3,3) -> a 2x2-cell square in the middle. Many vertices
  // (the entire border ring of the 5x5 lattice) are OFF the loop. Derive the
  // clues from this loop, then confirm the solver reproduces a valid solution.
  const rows = 4, cols = 4;
  const H = Array.from({ length: rows + 1 }, () => new Array(cols).fill(0));
  const V = Array.from({ length: rows }, () => new Array(cols + 1).fill(0));
  const r0 = 1, r1 = 3, c0 = 1, c1 = 3;
  for (let c = c0; c < c1; c++) { H[r0][c] = 1; H[r1][c] = 1; }
  for (let r = r0; r < r1; r++) { V[r][c0] = 1; V[r][c1] = 1; }
  // Derive clues from the loop shape: at each loop vertex, white if straight,
  // black if it turns; number = sum of both straight runs (runLengthAt).
  const probe = new ShingokiSolver({ rows, cols, task: Array.from({ length: rows + 1 }, () => new Array(cols + 1).fill(0)) });
  probe.H = H; probe.V = V;
  const task = Array.from({ length: rows + 1 }, () => new Array(cols + 1).fill(0));
  for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
    const inc = probe.incidentEdges(r, c).filter(e => probe.getEdge(e) === 1);
    if (inc.length !== 2) continue; // off-loop
    const isTurn = inc.filter(e => e.kind === 'H').length === 1;
    const n = probe.runLengthAt(r, c);
    task[r][c] = isTurn ? -n : n;
  }
  const res = new ShingokiSolver({ rows, cols, task, maxMs: 10000 }).solve();
  assert.equal(res.solved, true);
  const chk = new ShingokiSolver({ rows, cols, task });
  chk.H = res.horizontal; chk.V = res.vertical;
  assert.equal(chk.numbersSatisfied(), true);
  // Confirm at least one vertex is genuinely off the returned loop.
  let offLoop = 0;
  for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
    const deg = chk.incidentEdges(r, c).filter(e => chk.getEdge(e) === 1).length;
    if (deg === 0) offLoop++;
  }
  assert.ok(offLoop > 0, 'expected some vertices off the loop');
});
