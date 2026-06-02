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
  // 1x1 board: the only loop is the unit square. Every corner of that square is
  // a TURN with two length-1 arms, so a clue there must be BLACK with number 2
  // (turn; the two perpendicular runs sum to 2). A white clue here would be
  // unsolvable — white requires a straight pass, which a unit-square corner
  // can never be.
  const s = new ShingokiSolver({ rows: 1, cols: 1, task: [[-2,0],[0,0]] });
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

test('ShingokiSolver: a white clue must sit on a STRAIGHT pass, never a turn', () => {
  // Regression: degree-2 + numbersSatisfied does NOT imply correct shape. A
  // white clue (straight-through) placed where the only degree-2 geometry is a
  // turn must NOT be accepted. White-2 at the bottom-left corner vertex of a
  // 1x2 board can only be a corner turn -> there is NO valid solution, and the
  // solver must report that rather than returning a turn under a white clue.
  const res = new ShingokiSolver({ rows: 1, cols: 2, task: [[0, 0, 0], [2, 0, 0]] }).solve();
  if (res.solved) {
    // If (somehow) solved, the white clue vertex MUST be straight, not a turn.
    const chk = new ShingokiSolver({ rows: 1, cols: 2, task: [[0, 0, 0], [2, 0, 0]] });
    chk.H = res.horizontal; chk.V = res.vertical;
    const lines = chk.incidentEdges(1, 0).filter(e => chk.getEdge(e) === 1);
    const isTurn = lines.some(e => e.kind === 'H') && lines.some(e => e.kind === 'V');
    assert.equal(isTurn, false, 'white clue accepted on a turn — shape check missing');
  } else {
    assert.equal(res.solved, false); // expected: no valid straight-through loop exists
  }
});

test('ShingokiSolver: a black clue must sit on a TURN, never a straight pass', () => {
  // Symmetric guard: a black clue where the only degree-2 geometry is a straight
  // line must not be accepted. Black-2 mid-edge of a 1x2 board (vertex (0,1) or
  // (1,1)) along the only horizontal run would be straight -> invalid.
  const res = new ShingokiSolver({ rows: 1, cols: 2, task: [[0, -2, 0], [0, 0, 0]] }).solve();
  if (res.solved) {
    const chk = new ShingokiSolver({ rows: 1, cols: 2, task: [[0, -2, 0], [0, 0, 0]] });
    chk.H = res.horizontal; chk.V = res.vertical;
    const lines = chk.incidentEdges(0, 1).filter(e => chk.getEdge(e) === 1);
    const isTurn = lines.some(e => e.kind === 'H') && lines.some(e => e.kind === 'V');
    assert.equal(isTurn, true, 'black clue accepted on a straight pass — shape check missing');
  } else {
    assert.equal(res.solved, false);
  }
});

test('Shingoki deduction: white clue on the top row is forced horizontal', () => {
  // White at top-row vertex (0,1): vertical axis needs North V[-1][1] (off-board),
  // so it's impossible -> must be horizontal. West H[0][0] + East H[0][1] forced LINE.
  const s = new ShingokiSolver({ rows: 2, cols: 2, task: [[0,2,0],[0,0,0],[0,0,0]] });
  s._initState();
  assert.equal(s._propagate(), true);
  assert.equal(s.getEdge({ kind: 'H', r: 0, c: 0 }), 1); // West forced line
  assert.equal(s.getEdge({ kind: 'H', r: 0, c: 1 }), 1); // East forced line
  assert.equal(s.getEdge({ kind: 'V', r: 0, c: 1 }), 2); // South forced cross
});

test('Shingoki deduction: black clue in a corner forces both available arms', () => {
  // Black at corner vertex (0,0): only East H[0][0] + South V[0][0] exist; black
  // must turn -> both are the arms -> forced LINE.
  const s = new ShingokiSolver({ rows: 2, cols: 2, task: [[-2,0,0],[0,0,0],[0,0,0]] });
  s._initState();
  assert.equal(s._propagate(), true);
  assert.equal(s.getEdge({ kind: 'H', r: 0, c: 0 }), 1);
  assert.equal(s.getEdge({ kind: 'V', r: 0, c: 0 }), 1);
});

test('Shingoki deduction: white axis-forcing does NOT fire when both axes viable', () => {
  // White at interior vertex (1,1) on a 2x2 board: both H and V axes are in-range
  // and unconstrained -> ambiguous -> nothing forced (soundness).
  const s = new ShingokiSolver({ rows: 2, cols: 2, task: [[0,0,0],[0,2,0],[0,0,0]] });
  s._initState();
  assert.equal(s._propagate(), true);
  for (const e of s.incidentEdges(1, 1)) assert.equal(s.getEdge(e), 0);
});

test('Shingoki deduction: white with both axes blocked is a contradiction', () => {
  // White at (1,1); cross West and East (kills horizontal) and North (kills
  // vertical, since vertical needs both N and S) -> no viable axis.
  const s = new ShingokiSolver({ rows: 2, cols: 2, task: [[0,0,0],[0,2,0],[0,0,0]] });
  s._initState();
  s.setEdge({ kind: 'H', r: 1, c: 0 }, 2);
  s.setEdge({ kind: 'H', r: 1, c: 1 }, 2);
  s.setEdge({ kind: 'V', r: 0, c: 1 }, 2);
  assert.equal(s._propagate(), false);
});

test('Shingoki number: confirmed run equal to the clue forces a cross at the open end', () => {
  // 1x3 board (2x4 vertices). White clue n=2 at vertex (0,1). Lay West+East as
  // the start of a horizontal run: H[0][0]=1 (West of (0,1)), H[0][1]=1 (East).
  // The run through (0,1) is already length 2 == n, so the next edge east,
  // H[0][2], must be CROSS (the run can't extend).
  const s = new ShingokiSolver({ rows: 1, cols: 3, task: [[0,2,0,0],[0,0,0,0]] });
  s._initState();
  s.setEdge({ kind: 'H', r: 0, c: 0 }, 1);
  s.setEdge({ kind: 'H', r: 0, c: 1 }, 1);
  assert.equal(s._propagate(), true);
  assert.equal(s.getEdge({ kind: 'H', r: 0, c: 2 }), 2); // run-cap forces cross
});

test('Shingoki number: a run longer than the clue is a contradiction', () => {
  // White n=2 at (0,1) but three collinear lines through it -> run 3 > 2.
  const s = new ShingokiSolver({ rows: 1, cols: 3, task: [[0,2,0,0],[0,0,0,0]] });
  s._initState();
  s.setEdge({ kind: 'H', r: 0, c: 0 }, 1);
  s.setEdge({ kind: 'H', r: 0, c: 1 }, 1);
  s.setEdge({ kind: 'H', r: 0, c: 2 }, 1);
  assert.equal(s._propagate(), false);
});

test('Shingoki number: run-cap does NOT fire before the run reaches the clue', () => {
  // White n=3 at (0,1), only one confirmed line so far (run 1 < 3) -> no forcing.
  const s = new ShingokiSolver({ rows: 1, cols: 3, task: [[0,3,0,0],[0,0,0,0]] });
  s._initState();
  s.setEdge({ kind: 'H', r: 0, c: 1 }, 1); // East only
  assert.equal(s._propagate(), true);
  assert.equal(s.getEdge({ kind: 'H', r: 0, c: 2 }), 0); // not yet capped
});

test('Shingoki getStepwiseHint: returns forced LINE edges from an empty captured 5x5', () => {
  const TASK_5x5 = [
    [0,-5,0,0,0,0],[0,0,0,-4,0,0],[0,0,2,0,0,0],
    [-3,2,0,0,2,-4],[-3,0,0,-2,0,0],[0,0,0,-2,0,0],
  ];
  const s = new ShingokiSolver({ rows: 5, cols: 5, task: TASK_5x5, maxMs: 5000 });
  const curH = Array.from({ length: 6 }, () => new Array(5).fill(0));
  const curV = Array.from({ length: 5 }, () => new Array(6).fill(0));
  const hint = s.getStepwiseHint(curH, curV);
  assert.ok(hint && hint.edges.length >= 1, 'expected at least one forced edge');
  const solved = new ShingokiSolver({ rows: 5, cols: 5, task: TASK_5x5, maxMs: 10000 }).solve();
  assert.equal(solved.solved, true);
  for (const e of hint.edges) {
    const v = e.orientation === 'h' ? solved.horizontal[e.r][e.c] : solved.vertical[e.r][e.c];
    assert.equal(v, 1, `forced edge ${JSON.stringify(e)} must be a line in the solution`);
  }
});

test('Shingoki getStepwiseHint: returns null on a completed board', () => {
  const TASK_5x5 = [
    [0,-5,0,0,0,0],[0,0,0,-4,0,0],[0,0,2,0,0,0],
    [-3,2,0,0,2,-4],[-3,0,0,-2,0,0],[0,0,0,-2,0,0],
  ];
  const solved = new ShingokiSolver({ rows: 5, cols: 5, task: TASK_5x5, maxMs: 10000 }).solve();
  const s = new ShingokiSolver({ rows: 5, cols: 5, task: TASK_5x5, maxMs: 5000 });
  assert.equal(s.getStepwiseHint(solved.horizontal, solved.vertical), null);
});

test('Shingoki getStepwiseHint: does not mutate the caller arrays', () => {
  const TASK_5x5 = [
    [0,-5,0,0,0,0],[0,0,0,-4,0,0],[0,0,2,0,0,0],
    [-3,2,0,0,2,-4],[-3,0,0,-2,0,0],[0,0,0,-2,0,0],
  ];
  const s = new ShingokiSolver({ rows: 5, cols: 5, task: TASK_5x5, maxMs: 5000 });
  const curH = Array.from({ length: 6 }, () => new Array(5).fill(0));
  const curV = Array.from({ length: 5 }, () => new Array(6).fill(0));
  s.getStepwiseHint(curH, curV);
  assert.ok(curH.every(row => row.every(v => v === 0)));
  assert.ok(curV.every(row => row.every(v => v === 0)));
});

test('Shingoki deductive reach: iterating getStepwiseHint from empty makes monotonic, correct progress', () => {
  const TASK_5x5 = [
    [0,-5,0,0,0,0],[0,0,0,-4,0,0],[0,0,2,0,0,0],
    [-3,2,0,0,2,-4],[-3,0,0,-2,0,0],[0,0,0,-2,0,0],
  ];
  const solved = new ShingokiSolver({ rows: 5, cols: 5, task: TASK_5x5, maxMs: 10000 }).solve();
  assert.equal(solved.solved, true);
  const H = Array.from({ length: 6 }, () => new Array(5).fill(0));
  const V = Array.from({ length: 5 }, () => new Array(6).fill(0));
  let steps = 0, applied = 0;
  for (; steps < 100; steps++) {
    const s = new ShingokiSolver({ rows: 5, cols: 5, task: TASK_5x5, maxMs: 5000 });
    const hint = s.getStepwiseHint(H, V);
    if (!hint) break;
    for (const e of hint.edges) {
      const v = e.orientation === 'h' ? solved.horizontal[e.r][e.c] : solved.vertical[e.r][e.c];
      assert.equal(v, 1, `deduced edge ${JSON.stringify(e)} must match solution`);
      if (e.orientation === 'h') H[e.r][e.c] = 1; else V[e.r][e.c] = 1;
      applied++;
    }
  }
  assert.ok(steps < 100, 'must terminate (getStepwiseHint returns null when stuck)');
  assert.ok(applied >= 1, 'pure logic should deduce at least one edge on this board');
  const totalLines = solved.horizontal.flat().filter(v => v === 1).length
                   + solved.vertical.flat().filter(v => v === 1).length;
  console.log(`[shingoki deductive reach] logic placed ${applied}/${totalLines} solution lines in ${steps} hint rounds`);
});

test('Shingoki connectivity: a closed subloop with clues still outside is pruned', () => {
  // 3x3 board (4x4 verts). Close the unit square at top-left: H[0][0],H[1][0],
  // V[0][0],V[0][1] form a closed 1x1 loop. A clue OUTSIDE it (vertex (3,3))
  // must be on the loop -> this partial can never become one loop -> dead.
  const s = new ShingokiSolver({ rows: 3, cols: 3, task: [
    [0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,-2],
  ] });
  s._initState();
  s.setEdge({ kind: 'H', r: 0, c: 0 }, 1);
  s.setEdge({ kind: 'H', r: 1, c: 0 }, 1);
  s.setEdge({ kind: 'V', r: 0, c: 0 }, 1);
  s.setEdge({ kind: 'V', r: 0, c: 1 }, 1);
  assert.equal(s._deadByConnectivity(), true);
});

test('Shingoki connectivity: a valid open partial chain is NOT pruned', () => {
  const s = new ShingokiSolver({ rows: 3, cols: 3, task: [
    [0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,-2],
  ] });
  s._initState();
  s.setEdge({ kind: 'H', r: 0, c: 0 }, 1); // single open segment
  assert.equal(s._deadByConnectivity(), false);
});

test('Shingoki connectivity: an empty board is NOT pruned', () => {
  const s = new ShingokiSolver({ rows: 3, cols: 3, task: [
    [0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,-2],
  ] });
  s._initState();
  assert.equal(s._deadByConnectivity(), false);
});

test('ShingokiSolver: trail records and rolls back edge writes', () => {
  const s = new ShingokiSolver({ rows: 2, cols: 2, task: [[0,0,0],[0,0,0],[0,0,0]] });
  s._initState();
  const mark = s._trailMark();
  s.setEdge({ kind: 'H', r: 0, c: 0 }, 1);
  s.setEdge({ kind: 'V', r: 1, c: 1 }, 2);
  assert.equal(s.getEdge({ kind: 'H', r: 0, c: 0 }), 1);
  assert.equal(s.getEdge({ kind: 'V', r: 1, c: 1 }), 2);
  s._rollbackTo(mark);
  assert.equal(s.getEdge({ kind: 'H', r: 0, c: 0 }), 0);
  assert.equal(s.getEdge({ kind: 'V', r: 1, c: 1 }), 0);
});

test('Shingoki CDCL: _varId/_decodeVar round-trip for all edges', () => {
  const s = new ShingokiSolver({ rows: 3, cols: 4, task: [] });
  const seen = new Set();
  for (let r = 0; r <= 3; r++) for (let c = 0; c < 4; c++) {
    const id = s._varId('H', r, c);
    assert.ok(!seen.has(id), `H var ${id} collides`); seen.add(id);
    assert.deepEqual(s._decodeVar(id), { kind: 'H', r, c });
  }
  for (let r = 0; r < 3; r++) for (let c = 0; c <= 4; c++) {
    const id = s._varId('V', r, c);
    assert.ok(!seen.has(id), `V var ${id} collides`); seen.add(id);
    assert.deepEqual(s._decodeVar(id), { kind: 'V', r, c });
  }
  assert.equal(seen.size, (3+1)*4 + 3*(4+1));
});

test('Shingoki CDCL: setEdge records reason + level on the assignment trail', () => {
  const s = new ShingokiSolver({ rows: 2, cols: 2, task: [[0,0,0],[0,0,0],[0,0,0]] });
  s._cdclInit();
  s._decisionLevel = 1;
  s._currentReason = null; // a decision
  s.setEdge({ kind: 'H', r: 0, c: 0 }, 1);
  const vid = s._varId('H', 0, 0);
  assert.equal(s._level[vid], 1);
  assert.equal(s._reason[vid], null); // decision => null reason
  s._decisionLevel = 2;
  s._currentReason = [vid]; // a forced edge, caused by the first
  s.setEdge({ kind: 'V', r: 0, c: 0 }, 1);
  const vid2 = s._varId('V', 0, 0);
  assert.equal(s._level[vid2], 2);
  assert.deepEqual(s._reason[vid2], [vid]);
});

test('Shingoki CDCL: degree-forced cross carries its determined-edge antecedents', () => {
  // center vertex (1,1) gets two lines (E,S) -> W,N forced cross. The forced
  // cross's reason must reference the determined incident edges (the lines).
  const s = new ShingokiSolver({ rows: 2, cols: 2, task: [[0,0,0],[0,0,0],[0,0,0]] });
  s._cdclInit();
  s._decisionLevel = 1;
  s._currentReason = null; s.setEdge({ kind: 'H', r: 1, c: 1 }, 1); // E decision
  s._currentReason = null; s.setEdge({ kind: 'V', r: 1, c: 1 }, 1); // S decision
  assert.equal(s._propagate(), true);
  const wVar = s._varId('H', 1, 0); // West edge, forced cross
  assert.equal(s.getEdge({ kind: 'H', r: 1, c: 0 }), 2);
  const reason = s._reason[wVar];
  assert.ok(Array.isArray(reason), 'forced cross must carry an antecedent array');
  const eVar = s._varId('H', 1, 1), sVar = s._varId('V', 1, 1);
  // reason must reference the lines that drove the degree rule at (1,1)
  assert.ok(reason.includes(eVar) && reason.includes(sVar), 'reason must cite both forcing lines');
  // reason must NOT include the forced edge itself
  assert.ok(!reason.includes(wVar), 'reason must not include the forced var');
});

test('Shingoki CDCL: contradiction sets _lastConflictReason to the determined edges', () => {
  // White at (1,1); cross W,E,N -> no viable axis -> contradiction.
  const s = new ShingokiSolver({ rows: 2, cols: 2, task: [[0,0,0],[0,2,0],[0,0,0]] });
  s._cdclInit();
  s._decisionLevel = 1;
  s._currentReason = null; s.setEdge({ kind: 'H', r: 1, c: 0 }, 2);
  s._currentReason = null; s.setEdge({ kind: 'H', r: 1, c: 1 }, 2);
  s._currentReason = null; s.setEdge({ kind: 'V', r: 0, c: 1 }, 2);
  assert.equal(s._propagate(), false);
  assert.ok(Array.isArray(s._lastConflictReason) && s._lastConflictReason.length >= 1,
    'contradiction must set a non-empty conflict reason');
});

test('Shingoki CDCL: run-cap force reason includes the far run edge (sound, not under-approximated)', () => {
  // 1x4 board (2x5 verts): white n=3 at (0,1). Lay H[0][0],H[0][1],H[0][2] lines.
  // run through (0,1) = West(H[0][0]=1) + East(H[0][1],H[0][2]=2) = 3 == n ->
  // force cross at H[0][3] (the next east edge).
  const s = new ShingokiSolver({ rows: 1, cols: 4, task: [[0,3,0,0,0],[0,0,0,0,0]] });
  s._cdclInit();
  s._decisionLevel = 1;
  s._currentReason = null; s.setEdge({ kind: 'H', r: 0, c: 0 }, 1);
  s._currentReason = null; s.setEdge({ kind: 'H', r: 0, c: 1 }, 1);
  s._currentReason = null; s.setEdge({ kind: 'H', r: 0, c: 2 }, 1);
  assert.equal(s._propagate(), true);
  const farVar = s._varId('H', 0, 3); // forced cross at the run's far end
  assert.equal(s.getEdge({ kind: 'H', r: 0, c: 3 }), 2);
  const reason = s._reason[farVar];
  assert.ok(Array.isArray(reason), 'run-cap force must carry a reason');
  const runFar = s._varId('H', 0, 2); // the far run edge NOT incident to clue vertex (0,1)
  assert.ok(reason.includes(runFar), 'reason MUST include the far run edge H[0][2] (was the under-approximation bug)');
  // SUFFICIENCY: the reason edges alone must entail the forced cross. Replay on a
  // fresh solver: set exactly the reason edges to LINE, propagate, confirm the
  // far edge is forced to cross.
  const chk = new ShingokiSolver({ rows: 1, cols: 4, task: [[0,3,0,0,0],[0,0,0,0,0]] });
  chk._cdclInit();
  for (const vid of reason) { const d = chk._decodeVar(vid); chk._currentReason = null; chk.setEdge({ kind: d.kind, r: d.r, c: d.c }, 1); }
  chk._propagate();
  assert.equal(chk.getEdge({ kind: 'H', r: 0, c: 3 }), 2, 'reason edges alone must entail the forced cross (sufficiency)');
});

test('Shingoki CDCL skeleton: solves the captured 5x5 with a valid loop', () => {
  const TASK_5x5 = [
    [0,-5,0,0,0,0],[0,0,0,-4,0,0],[0,0,2,0,0,0],
    [-3,2,0,0,2,-4],[-3,0,0,-2,0,0],[0,0,0,-2,0,0],
  ];
  const res = new ShingokiSolver({ rows: 5, cols: 5, task: TASK_5x5, maxMs: 10000 })._solveCdcl();
  assert.equal(res.solved, true);
  const chk = new ShingokiSolver({ rows: 5, cols: 5, task: TASK_5x5 });
  chk.H = res.horizontal; chk.V = res.vertical;
  assert.equal(chk.numbersSatisfied(), true);
});

test('Shingoki CDCL skeleton: never spurious-UNSAT on solvable constructive boards', () => {
  function gen(n, seed) {
    let s = seed>>>0; const rnd=()=>{s=(s*1664525+1013904223)>>>0;return s/0x100000000;};
    const r0=Math.floor(rnd()*n),r1=r0+1+Math.floor(rnd()*(n-r0));
    const c0=Math.floor(rnd()*n),c1=c0+1+Math.floor(rnd()*(n-c0));
    const H=Array.from({length:n+1},()=>new Array(n).fill(0));
    const V=Array.from({length:n},()=>new Array(n+1).fill(0));
    for(let c=c0;c<c1;c++){H[r0][c]=1;H[r1][c]=1;}
    for(let r=r0;r<r1;r++){V[r][c0]=1;V[r][c1]=1;}
    const p=new ShingokiSolver({rows:n,cols:n,task:Array.from({length:n+1},()=>new Array(n+1).fill(0))});
    p.H=H;p.V=V;
    const task=Array.from({length:n+1},()=>new Array(n+1).fill(0));
    for(let r=0;r<=n;r++)for(let c=0;c<=n;c++){const inc=p.incidentEdges(r,c).filter(e=>p.getEdge(e)===1);if(inc.length!==2)continue;task[r][c]=inc.filter(e=>e.kind==='H').length===1?-p.runLengthAt(r,c):p.runLengthAt(r,c);}
    return task;
  }
  for (let seed = 1; seed <= 5; seed++) {
    const task = gen(6, seed);
    const res = new ShingokiSolver({ rows: 6, cols: 6, task, maxMs: 10000 })._solveCdcl();
    assert.notEqual(res.error, 'no solution', `seed ${seed}: spurious UNSAT`);
    assert.equal(res.solved, true, `seed ${seed} must solve`);
  }
});

test('Shingoki CDCL: run-cap conflict reason includes the run edges', () => {
  // 1x4 board, white n=2 at (0,1), three collinear lines -> run 3 > 2 -> conflict.
  const s = new ShingokiSolver({ rows: 1, cols: 4, task: [[0,2,0,0,0],[0,0,0,0,0]] });
  s._cdclInit();
  s._decisionLevel = 1;
  s._currentReason = null; s.setEdge({ kind: 'H', r: 0, c: 0 }, 1);
  s._currentReason = null; s.setEdge({ kind: 'H', r: 0, c: 1 }, 1);
  s._currentReason = null; s.setEdge({ kind: 'H', r: 0, c: 2 }, 1);
  assert.equal(s._propagate(), false);
  const cr = s._lastConflictReason;
  assert.ok(Array.isArray(cr) && cr.length >= 1, 'conflict reason set');
  // must reference the run edges that exceed the clue (at least the ones beyond the clue vertex's incidents)
  const runFar = s._varId('H', 0, 2);
  assert.ok(cr.includes(runFar), 'conflict reason MUST include the far run edge');
});

test('Shingoki CDCL learning: _forceLiteral sets LINE for a positive literal, CROSS for ~v', () => {
  const s = new ShingokiSolver({ rows: 2, cols: 2, task: [[0,0,0],[0,0,0],[0,0,0]] });
  s._cdclInit();
  const v = s._varId('H', 0, 0);
  assert.equal(s._forceLiteral(v), true);          // positive -> LINE
  assert.equal(s.getEdge({ kind: 'H', r: 0, c: 0 }), 1);
  const v2 = s._varId('V', 0, 0);
  assert.equal(s._forceLiteral(~v2), true);         // ~v -> CROSS
  assert.equal(s.getEdge({ kind: 'V', r: 0, c: 0 }), 2);
});

test('Shingoki CDCL learning: _addLearnedClause stores the clause verbatim', () => {
  const s = new ShingokiSolver({ rows: 2, cols: 2, task: [[0,0,0],[0,0,0],[0,0,0]] });
  s._cdclInit();
  s._addLearnedClause([3, ~7, 1]);
  assert.equal(s._learnedClauses.length, 1);
  assert.deepEqual(s._learnedClauses[0], [3, ~7, 1]);
});

test('Shingoki CDCL learning: _analyzeConflict learns a clause whose literals are all currently falsified', () => {
  // Drive a real 2-decision conflict via propagation, then analyze.
  // 1x4 board, white n=2 at (0,1). Decide H(0,0)=LINE then H(0,1)=LINE then
  // H(0,2)=LINE -> run 3 > 2 -> run-cap conflict at level 3.
  const s = new ShingokiSolver({ rows: 1, cols: 4, task: [[0,2,0,0,0],[0,0,0,0,0]] });
  s._cdclInit();
  s._decisionLevel = 1; s._currentReason = null; s.setEdge({ kind: 'H', r: 0, c: 0 }, 1);
  s._decisionLevel = 2; s._currentReason = null; s.setEdge({ kind: 'H', r: 0, c: 1 }, 1);
  s._decisionLevel = 3; s._currentReason = null; s.setEdge({ kind: 'H', r: 0, c: 2 }, 1);
  assert.equal(s._propagate(), false);
  const learned = s._analyzeConflict(s._lastConflictReason);
  assert.ok(learned.length >= 1, 'learned clause is non-empty');
  // Every literal must be currently FALSIFIED (the clause excludes the bad
  // assignment): a positive literal v means "v should be LINE" but v is CROSS,
  // a negative literal ~v means "v should be CROSS" but v is LINE.
  for (const lit of learned) {
    const vid = lit >= 0 ? lit : ~lit;
    const want = lit >= 0 ? 1 : -1;     // literal asserts this value
    assert.equal(s._varValue(vid), -want, `literal ${lit} must be currently falsified`);
  }
});

test('Shingoki CDCL: solves the captured 5x5 via learning search', () => {
  const TASK = [[0,-5,0,0,0,0],[0,0,0,-4,0,0],[0,0,2,0,0,0],[-3,2,0,0,2,-4],[-3,0,0,-2,0,0],[0,0,0,-2,0,0]];
  const s = new ShingokiSolver({ rows: 5, cols: 5, task: TASK, maxMs: 10000 });
  const res = s._solveCdcl();
  assert.equal(res.solved, true);
  const chk = new ShingokiSolver({ rows: 5, cols: 5, task: TASK });
  chk.H = res.horizontal; chk.V = res.vertical;
  assert.equal(chk.numbersSatisfied(), true);
  assert.ok(s._totalConflicts >= 0); // learning ran
});

test('Shingoki CDCL learning: never spurious-UNSAT on constructive boards (15 seeds)', () => {
  function gen(n, seed) {
    let s=seed>>>0; const rnd=()=>{s=(s*1664525+1013904223)>>>0;return s/0x100000000;};
    const r0=Math.floor(rnd()*n),r1=r0+1+Math.floor(rnd()*(n-r0));
    const c0=Math.floor(rnd()*n),c1=c0+1+Math.floor(rnd()*(n-c0));
    const H=Array.from({length:n+1},()=>new Array(n).fill(0));
    const V=Array.from({length:n},()=>new Array(n+1).fill(0));
    for(let c=c0;c<c1;c++){H[r0][c]=1;H[r1][c]=1;}
    for(let r=r0;r<r1;r++){V[r][c0]=1;V[r][c1]=1;}
    const p=new ShingokiSolver({rows:n,cols:n,task:Array.from({length:n+1},()=>new Array(n+1).fill(0))});
    p.H=H;p.V=V;
    const task=Array.from({length:n+1},()=>new Array(n+1).fill(0));
    for(let r=0;r<=n;r++)for(let c=0;c<=n;c++){const inc=p.incidentEdges(r,c).filter(e=>p.getEdge(e)===1);if(inc.length!==2)continue;task[r][c]=inc.filter(e=>e.kind==='H').length===1?-p.runLengthAt(r,c):p.runLengthAt(r,c);}
    return task;
  }
  for (let seed=1; seed<=15; seed++) {
    const task=gen(7,seed);
    const res=new ShingokiSolver({rows:7,cols:7,task,maxMs:10000})._solveCdcl();
    assert.notEqual(res.error,'no solution',`seed ${seed}: spurious UNSAT`);
    assert.equal(res.solved,true,`seed ${seed} must solve`);
  }
});

test('Shingoki CDCL: VSIDS prefers the higher-activity unassigned var', () => {
  const s = new ShingokiSolver({ rows: 3, cols: 3, task: [] });
  s._cdclInit();
  s._initVsids();
  const a = s._varId('H', 1, 1), b = s._varId('V', 1, 1);
  s._bumpVar(b); s._bumpVar(b); s._bumpVar(a);
  assert.equal(s._pickDecisionVar(), b); // b has higher activity
});

test('Shingoki CDCL: _lubyNext yields the canonical Luby sequence', () => {
  const s = new ShingokiSolver({ rows: 2, cols: 2, task: [] });
  const got = [];
  for (let i = 0; i < 15; i++) got.push(s._lubyNext(i));
  assert.deepEqual(got, [1,1,2,1,1,2,4,1,1,2,1,1,2,4,8]);
});
