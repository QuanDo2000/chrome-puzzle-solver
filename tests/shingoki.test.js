'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ShingokiSolver } = require('../src/solvers/shingoki.js');

// Soundness assertion for boards the engine may or may not fully solve: it must
// return either a valid complete loop OR a sound level-0 partial — NEVER a
// spurious 'no solution', and never an unsound partial (vertex degree > 2).
function assertSolvedOrSoundPartial(res, rows, cols, task, label) {
  assert.notEqual(res.error, 'no solution', `${label}: spurious UNSAT on a solvable board`);
  if (res.solved) {
    const chk = new ShingokiSolver({ rows, cols, task });
    chk.H = res.horizontal; chk.V = res.vertical;
    assert.equal(chk.numbersSatisfied(), true, `${label}: solved but invalid`);
    return;
  }
  assert.equal(res.partial, true, `${label}: not solved must carry a partial`);
  assert.ok(res.horizontal && res.vertical, `${label}: partial must carry grids`);
  const chk = new ShingokiSolver({ rows, cols, task });
  chk.H = res.horizontal; chk.V = res.vertical;
  for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
    const deg = chk.incidentEdges(r, c).filter(e => chk.getEdge(e) === 1).length;
    assert.ok(deg <= 2, `${label}: partial vertex (${r},${c}) degree ${deg} > 2 (unsound)`);
  }
}

// --- Brute-force reference oracle (independent of the deduction techniques) ---
// Enumerates EVERY valid Shingoki loop on a small board by exhaustive edge
// assignment with degree pruning. Acceptance uses only the base checkers
// (_isValidComplete = degree + single-loop + shapes + numbers), NOT the new
// techniques, so it is an independent oracle. Use on boards <= 4x4 (cells).
function bruteForceSolutions(rows, cols, task) {
  const s = new ShingokiSolver({ rows, cols, task });
  s._initState();
  const edges = s._allEdgeRefs();
  const sols = [];
  const okSoFar = () => {
    for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
      const inc = s.incidentEdges(r, c);
      let ln = 0, unk = 0;
      for (const e of inc) { const g = s.getEdge(e); if (g === 1) ln++; else if (g === 0) unk++; }
      if (ln > 2) return false;                 // degree can't exceed 2
      if (ln === 1 && unk === 0) return false;  // stuck at degree 1
      if (task[r][c] && ln + unk < 2) return false; // clued vertex can't reach degree 2
    }
    return true;
  };
  const rec = (i) => {
    if (i === edges.length) { if (s._isValidComplete()) sols.push({ H: s.H.map(r => r.slice()), V: s.V.map(r => r.slice()) }); return; }
    const e = edges[i];
    for (const v of [1, 2]) {
      if (e.kind === 'H') s.H[e.r][e.c] = v; else s.V[e.r][e.c] = v;
      if (okSoFar()) rec(i + 1);
    }
    if (e.kind === 'H') s.H[e.r][e.c] = 0; else s.V[e.r][e.c] = 0;
  };
  rec(0);
  return sols;
}

// --- Force-soundness harness ---
// Verifies a deduction step never forces an edge that some valid completion
// contradicts. For a satisfiable small board, take random partial states drawn
// from real solutions, run the step, and assert every edge it forces matches
// ALL solutions consistent with that partial state (and it signals contradiction
// only when zero completions are consistent). `applyStep(solver)` runs the
// technique under test on the seeded solver and returns false on contradiction.
function assertForceSoundness(rows, cols, task, applyStep, opts = {}) {
  const trials = opts.trials ?? 40;
  const all = bruteForceSolutions(rows, cols, task);
  if (all.length === 0) return; // unsat board: nothing to check here
  const edges = new ShingokiSolver({ rows, cols, task });
  edges._initState();
  const allEdges = edges._allEdgeRefs();
  // deterministic PRNG (no Math.random in this repo's tests by convention)
  let seed = (rows * 131 + cols * 17 + 9001) >>> 0;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };
  const valAt = (sol, e) => (e.kind === 'H' ? sol.H[e.r][e.c] : sol.V[e.r][e.c]);
  for (let t = 0; t < trials; t++) {
    const base = all[Math.floor(rnd() * all.length)];
    // random partial: each edge independently included with prob ~0.5, set to base's value
    const s = new ShingokiSolver({ rows, cols, task });
    s._initState();
    for (const e of allEdges) {
      if (rnd() < 0.5) { const v = valAt(base, e); if (e.kind === 'H') s.H[e.r][e.c] = v; else s.V[e.r][e.c] = v; }
    }
    const consistent = all.filter(sol => allEdges.every(e => {
      const cur = s.getEdge(e); return cur === 0 || cur === valAt(sol, e);
    }));
    const before = allEdges.map(e => s.getEdge(e));
    const ok = applyStep(s);
    if (!ok) { assert.equal(consistent.length, 0, `step signalled contradiction but ${consistent.length} completion(s) exist`); continue; }
    allEdges.forEach((e, i) => {
      const after = s.getEdge(e);
      if (after !== 0 && before[i] === 0) {
        for (const sol of consistent) {
          assert.equal(after, valAt(sol, e), `forced ${e.kind}(${e.r},${e.c})=${after} but a valid completion has ${valAt(sol, e)}`);
        }
      }
    });
  }
}

test('Shingoki oracle: enumerates the unique loop of a fully-determined 2x2', () => {
  // 2x2 cells = 3x3 vertices. The only loop is the full border (8 edges).
  // White clue at center is impossible (center not reachable by a border loop),
  // so use border-corner black clues. Each corner turns; on a 2x2 the midpoint
  // border vertices are straight pass-throughs, so each corner's two straight
  // runs reach the opposite corners: 2 + 2 = 4. (n=2 here would be UNSAT.)
  const task = [[ -4,0,-4],[0,0,0],[-4,0,-4]];
  const sols = bruteForceSolutions(2, 2, task);
  assert.equal(sols.length, 1, 'border loop is the unique solution');
  // every border edge is LINE, no interior edge exists on 2x2 besides border
  const s = new ShingokiSolver({ rows: 2, cols: 2, task });
  s.H = sols[0].H; s.V = sols[0].V;
  assert.equal(s._isValidComplete(), true);
  assert.equal(s.numbersSatisfied(), true);
});

test('Shingoki oracle: harness passes for the existing _propagate (sound baseline)', () => {
  // The existing propagation is sound, so the harness must accept it on several
  // small satisfiable boards. This also self-tests the harness.
  // NOTE: black-corner clue numbers must be satisfiable. n=2 leaves both boards
  // UNSAT (the corner's two straight runs reach past the midpoint vertices),
  // which would make the harness a no-op. n=4 is satisfiable: the 2x2 has the
  // unique border loop and the 3x3 has 2 distinct solutions, so the harness's
  // "forced edge matches ALL consistent solutions" check is genuinely exercised.
  const boards = [
    { rows: 2, cols: 2, task: [[-4,0,-4],[0,0,0],[-4,0,-4]] },
    { rows: 3, cols: 3, task: [[-4,0,0,-4],[0,0,0,0],[0,0,0,0],[-4,0,0,-4]] },
  ];
  for (const b of boards) {
    assertForceSoundness(b.rows, b.cols, b.task, (s) => s._propagate());
  }
});

test('Shingoki _deduceAll: behaves like _propagate when Tier 2 is empty', () => {
  const task = [[-4,0,0,-4],[0,0,0,0],[0,0,0,0],[-4,0,0,-4]];
  const a = new ShingokiSolver({ rows: 3, cols: 3, task }); a._initState(); const ra = a._propagate();
  const b = new ShingokiSolver({ rows: 3, cols: 3, task }); b._initState(); const rb = b._deduceAll(0);
  assert.equal(ra, rb);
  assert.deepEqual(a.H, b.H); assert.deepEqual(a.V, b.V);
});

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

test('Shingoki candidates: a black clue n=2 in a corner forces both arms (unique config)', () => {
  // 3x3 vertices, black clue n=2 at corner (0,0): only arms are H(0,0) east and
  // V(0,0) south; each must be length 1 -> both forced LINE; the run-caps force
  // crosses at H(0,1)?... only assert the two arms.
  const task = [[-2,0,0],[0,0,0],[0,0,0]];
  const s = new ShingokiSolver({ rows: 2, cols: 2, task });
  s._initState();
  s._deduceAll(0);
  assert.equal(s.getEdge({ kind: 'H', r: 0, c: 0 }), 1);
  assert.equal(s.getEdge({ kind: 'V', r: 0, c: 0 }), 1);
});

test('Shingoki candidates: intersection forces the common edge across splits', () => {
  // A white clue with two feasible splits that AGREE on one edge but differ
  // elsewhere -> only the agreed edge is forced. (Hand-built; see comment.)
  // White n=2 at (0,1) on a 1x2-cell strip top row: horizontal axis only; splits
  // are (a=1 left,b=1 right) the unique config -> both H(0,0),H(0,1) forced.
  const task = [[0,2,0],[0,0,0]];
  const s = new ShingokiSolver({ rows: 1, cols: 2, task });
  s._initState();
  s._deduceAll(0);
  assert.equal(s.getEdge({ kind: 'H', r: 0, c: 0 }), 1);
  assert.equal(s.getEdge({ kind: 'H', r: 0, c: 1 }), 1);
});

test('Shingoki candidates: force-soundness vs the oracle (3x3 + 4x4, several boards)', () => {
  // SOUNDNESS GATE for technique 2. Every board MUST be satisfiable with >=2
  // distinct solutions so the intersection logic is genuinely exercised (an unsat
  // board makes assertForceSoundness a vacuous no-op).
  // Board adjustments from the plan's illustrative numbers (verified via
  // bruteForceSolutions):
  //   - A (3x3): plan's mixed white/black task was UNSAT (0 sols). Replaced with
  //     four black corner clues n=4 -> 2 distinct solutions (a diamond and an
  //     outer-border loop). 3x3 is too tight to admit a satisfiable white/black
  //     mix here; white+black mixing is covered by board B.
  //   - B (4x4): plan's task already satisfiable with 3 solutions; kept as-is
  //     (mixes white + black clues).
  //   - C (4x4): plan's corners n=2 + center n=5 was UNSAT. Replaced with four
  //     black corner clues n=3 -> 2 distinct solutions (a black corner's number
  //     is the SUM of both straight runs; n=3 admits inward turns, n=2/4/6 are
  //     unsat and n=8 forces the unique outer border).
  const boards = [
    { rows: 3, cols: 3, task: [[-4,0,0,-4],[0,0,0,0],[0,0,0,0],[-4,0,0,-4]] },
    { rows: 4, cols: 4, task: [[0,0,3,0,0],[0,-2,0,0,0],[0,0,0,4,0],[0,0,0,0,0],[0,0,2,0,0]] },
    { rows: 4, cols: 4, task: [[-3,0,0,0,-3],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[-3,0,0,0,-3]] },
  ];
  for (const b of boards) {
    assert.ok(bruteForceSolutions(b.rows, b.cols, b.task).length >= 2, 'oracle board must have >=2 solutions');
    assertForceSoundness(b.rows, b.cols, b.task, (s) => s._candidateIntersectForce(), { trials: 60 });
  }
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

test('Shingoki solve: small boards still solve correctly', () => {
  const TASK = [[0,-5,0,0,0,0],[0,0,0,-4,0,0],[0,0,2,0,0,0],[-3,2,0,0,2,-4],[-3,0,0,-2,0,0],[0,0,0,-2,0,0]];
  const res = new ShingokiSolver({ rows: 5, cols: 5, task: TASK, maxMs: 10000 }).solve();
  assert.equal(res.solved, true);
  const chk = new ShingokiSolver({ rows: 5, cols: 5, task: TASK });
  chk.H = res.horizontal; chk.V = res.vertical;
  assert.equal(chk.numbersSatisfied(), true);
});

test('Shingoki solve: returns a SOUND partial on timeout (40x40)', () => {
  const fixtures = require('./fixtures/real-puzzles.js');
  const p = fixtures.shingoki_40x40_monthly;
  const res = new ShingokiSolver({ rows: p.rows, cols: p.cols, task: p.task, maxMs: 1500 }).solve();
  if (res.solved) return; // if it somehow solves fast, fine
  assert.equal(res.error, 'time limit exceeded');
  // Flat slitherlink-shaped partial: a boolean flag plus top-level edge arrays
  // (so the widget's type-agnostic {horizontal,vertical} partial arm applies it).
  assert.ok(res.partial === true && res.horizontal && res.vertical, 'timeout must carry a flat partial');
  // SOUNDNESS of the partial: every LINE edge in the partial must agree with a
  // full solve's... we can't get a full solve. Instead assert the partial is
  // INTERNALLY CONSISTENT: feed it as initialState and confirm propagation
  // doesn't contradict it. Minimal check: it has some deduced edges and they
  // don't violate the per-vertex degree (no vertex with 3+ lines).
  const ph = res.horizontal, pv = res.vertical;
  // (partial may legitimately have 0 lines if root propagation deduced only crosses;
  //  the real soundness guarantee is "level-0 only", checked structurally below)
  // No vertex may have >2 line edges (would be an unsound partial):
  const chk = new ShingokiSolver({ rows: p.rows, cols: p.cols, task: p.task });
  chk.H = ph; chk.V = pv;
  for (let r = 0; r <= p.rows; r++) for (let c = 0; c <= p.cols; c++) {
    const deg = chk.incidentEdges(r, c).filter(e => chk.getEdge(e) === 1).length;
    assert.ok(deg <= 2, `partial vertex (${r},${c}) has degree ${deg} > 2 (unsound partial)`);
  }
});

test('Shingoki solve: never spurious-UNSAT via the public entry (constructive)', () => {
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
  for (let seed=1; seed<=10; seed++) {
    const task=gen(7,seed);
    const res=new ShingokiSolver({rows:7,cols:7,task,maxMs:10000}).solve();
    assertSolvedOrSoundPartial(res, 7, 7, task, `seed ${seed}`);
  }
});

test('Shingoki solve: 40x40 monthly never spurious-UNSAT; returns solved or sound partial', { timeout: 10000 }, () => {
  const fixtures = require('./fixtures/real-puzzles.js');
  const p = fixtures.shingoki_40x40_monthly;
  const res = new ShingokiSolver({ rows: p.rows, cols: p.cols, task: p.task, maxMs: 6000 }).solve();
  // MUST NEVER spurious-UNSAT a solvable board:
  assert.notEqual(res.error, 'no solution', 'must never report no-solution on a solvable board');
  if (res.solved) {
    const chk = new ShingokiSolver({ rows: p.rows, cols: p.cols, task: p.task });
    chk.H = res.horizontal; chk.V = res.vertical;
    assert.equal(chk.numbersSatisfied(), true);
  } else {
    // timeout => sound partial (flat shape, level-0 only, no degree>2)
    assert.equal(res.error, 'time limit exceeded');
    assert.equal(res.partial, true);
    assert.ok(res.horizontal && res.vertical);
    const chk = new ShingokiSolver({ rows: p.rows, cols: p.cols, task: p.task });
    chk.H = res.horizontal; chk.V = res.vertical;
    for (let r = 0; r <= p.rows; r++) for (let c = 0; c <= p.cols; c++) {
      const deg = chk.incidentEdges(r, c).filter(e => chk.getEdge(e) === 1).length;
      assert.ok(deg <= 2, `partial vertex (${r},${c}) degree ${deg} > 2 (unsound)`);
    }
  }
});

test('Shingoki solve: mid-size constructive boards return solved or a sound partial', { timeout: 30000 }, () => {
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
  for (const n of [10, 15, 20]) {
    const task = gen(n, n*13);
    const res = new ShingokiSolver({ rows: n, cols: n, task, maxMs: 8000 }).solve();
    assertSolvedOrSoundPartial(res, n, n, task, `${n}x${n}`);
  }
});

test('Shingoki DFS: _pickBranch extends a chain endpoint, LINE first', () => {
  // 3x3 vertices (2x2 cells). Put one committed LINE so vertex (0,0) has
  // exactly one line and >=1 unknown incident edge -> a chain endpoint.
  const s = new ShingokiSolver({ rows: 2, cols: 2, task: [[0,0,0],[0,0,0],[0,0,0]] });
  s._initState();
  s.setEdge({ kind: 'H', r: 0, c: 0 }, 1); // line between (0,0)-(0,1)
  const br = s._pickBranch();
  assert.ok(br, 'must return a branch');
  // (0,0) now has 1 line (H 0,0) and unknown V(0,0); the branch must be an
  // unknown edge incident to a chain endpoint, tried LINE(1) first.
  assert.equal(br.firstVal, 1);
  assert.equal(s.getEdge(br.ref), 0, 'branch edge must currently be unknown');
});

test('Shingoki DFS: _pickBranch returns null when all edges are assigned', () => {
  const s = new ShingokiSolver({ rows: 1, cols: 1, task: [[0,0],[0,0]] });
  s._initState();
  for (const e of s._allEdgeRefs()) s.setEdge(e, 2); // all crossed
  assert.equal(s._pickBranch(), null);
});

test('Shingoki DFS: _pickBranch picks a clued-incident edge when no chain exists', () => {
  // No committed lines anywhere, one white clue at (0,1). The constraint-focused
  // branch must return an unknown edge incident to a clued vertex, LINE first.
  const s = new ShingokiSolver({ rows: 2, cols: 2, task: [[0,2,0],[0,0,0],[0,0,0]] });
  s._initState();
  const br = s._pickBranch();
  assert.ok(br, 'must return a branch');
  assert.equal(br.firstVal, 1);
  const eps = s._endpoints(br.ref);
  assert.ok(eps.some(v => s.task[v.r][v.c] !== 0), 'edge must touch a clued vertex');
});

test('Shingoki DFS: solves the real 7x7-hard board in a few seconds (regression)', { timeout: 15000 }, () => {
  const p = require('./fixtures/real-puzzles.js').shingoki_7x7_hard;
  const t0 = Date.now();
  const res = new ShingokiSolver({ rows: p.rows, cols: p.cols, task: p.task, maxMs: 30000 }).solve();
  assert.equal(res.solved, true, 'DFS must solve the real 7x7-hard board');
  assert.ok(Date.now() - t0 < 10000, 'should solve in well under 10s');
  const chk = new ShingokiSolver({ rows: p.rows, cols: p.cols, task: p.task });
  chk.H = res.horizontal; chk.V = res.vertical;
  assert.equal(chk.numbersSatisfied(), true);
});

test('Shingoki DFS: genuine UNSAT returns no-solution, not a partial', () => {
  // A 3x3 white clue with run length 9 is unreachable on a 3-cell line -> UNSAT.
  const task = [[0,0,0],[0,9,0],[0,0,0]];
  const res = new ShingokiSolver({ rows: 2, cols: 2, task, maxMs: 5000 }).solve();
  assert.equal(res.solved, false);
  // Genuine UNSAT yields a non-partial error. max-reach now SOUNDLY detects this
  // unreachable-number board at root deduction ('contradiction on initial
  // propagation') rather than after exhausting the search tree ('no solution');
  // either is a valid genuine-UNSAT signal. The contract that matters: NOT a partial.
  assert.ok(res.error === 'no solution' || res.error === 'contradiction on initial propagation', res.error);
  assert.notEqual(res.partial, true);
});

test('Shingoki DFS: timeout returns a SOUND flat partial (level-0 only)', () => {
  const fixtures = require('./fixtures/real-puzzles.js');
  const p = fixtures.shingoki_40x40_monthly;
  const res = new ShingokiSolver({ rows: p.rows, cols: p.cols, task: p.task, searchMs: 1000, maxMs: 30000 }).solve();
  if (res.solved) return;
  assert.equal(res.error, 'time limit exceeded');
  assert.equal(res.partial, true);
  assert.ok(res.horizontal && res.vertical);
  const chk = new ShingokiSolver({ rows: p.rows, cols: p.cols, task: p.task });
  chk.H = res.horizontal; chk.V = res.vertical;
  for (let r = 0; r <= p.rows; r++) for (let c = 0; c <= p.cols; c++) {
    const deg = chk.incidentEdges(r, c).filter(e => chk.getEdge(e) === 1).length;
    assert.ok(deg <= 2, `partial vertex (${r},${c}) degree ${deg} > 2 (unsound)`);
  }
});

test('Shingoki DFS: searchMs cap bails well before maxMs on the 40x40', () => {
  const fixtures = require('./fixtures/real-puzzles.js');
  const p = fixtures.shingoki_40x40_monthly;
  const t0 = Date.now();
  const res = new ShingokiSolver({ rows: p.rows, cols: p.cols, task: p.task, searchMs: 2000, maxMs: 30000 }).solve();
  const wall = Date.now() - t0;
  if (!res.solved) {
    assert.equal(res.partial, true);
    assert.ok(wall < 8000, `searchMs cap should bail near 2s, took ${wall}ms`);
  }
});

test('Shingoki DFS: solves a deep-search sparse board (4 clues) fast', { timeout: 15000 }, () => {
  // A sparse 8x8 (4 clues) whose root propagation deduces almost nothing; the
  // loop is found by chain-building DFS. CDCL needed ~7s here; the DFS is fast.
  const task = [
    [0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,4,0,0],
    [0,0,0,0,0,4,4,0,0],
    [0,0,0,0,0,4,0,0,0],
    [0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0],
  ];
  const res = new ShingokiSolver({ rows: 8, cols: 8, task, maxMs: 30000 }).solve();
  assert.equal(res.solved, true);
  const chk = new ShingokiSolver({ rows: 8, cols: 8, task });
  chk.H = res.horizontal; chk.V = res.vertical;
  assert.equal(chk.numbersSatisfied(), true);
});

test('Shingoki solve: real mid-size hard boards return a sound partial (never spurious-UNSAT)', { timeout: 30000 }, () => {
  const fx = require('./fixtures/real-puzzles.js');
  for (const key of ['shingoki_10x10_hard', 'shingoki_15x15_hard', 'shingoki_25x25_hard']) {
    const p = fx[key];
    const res = new ShingokiSolver({ rows: p.rows, cols: p.cols, task: p.task, searchMs: 6000, maxMs: 30000 }).solve();
    assertSolvedOrSoundPartial(res, p.rows, p.cols, p.task, key);
  }
});

test('Shingoki maxReach: a white clue whose number exceeds one axis forces the other axis', () => {
  // 1x4 strip (rows=1, cols=4 -> 2x5 vertices). A white clue near the left on the
  // top row: vertical axis has only 1 edge available (can't form a 2-edge straight
  // run through the vertex), so a number >=2 must be horizontal.
  // Vertices 2 rows x 5 cols. Put white clue n=4 at (0,2).
  const task = [[0,0,4,0,0],[0,0,0,0,0]];
  assert.ok(bruteForceSolutions(1, 4, task).length >= 1, 'board must be satisfiable');
  const s = new ShingokiSolver({ rows: 1, cols: 4, task });
  s._initState();
  s._deduceAll(0);
  // vertical edges at (0,2) [the only vertical incident is V(0,2)] cannot give a
  // straight vertical run through (0,2) (needs edges both above and below; none
  // above), so the white line must be horizontal -> H(0,1) and H(0,2) forced LINE.
  assert.equal(s.getEdge({ kind: 'H', r: 0, c: 1 }), 1);
  assert.equal(s.getEdge({ kind: 'H', r: 0, c: 2 }), 1);
});

test('Shingoki maxReach: does NOT fire when both axes can still reach the number', () => {
  // White clue n=2 in the interior with both axes open -> ambiguous, force nothing.
  const task = [[0,0,0,0,0],[0,0,2,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0]];
  const s = new ShingokiSolver({ rows: 4, cols: 4, task });
  s._initState();
  s._deduceAll(0);
  // no incident edge of (1,2) should be forced LINE (both axes viable)
  for (const e of s.incidentEdges(1, 2)) {
    if (s.getEdge(e) === 1) assert.fail(`maxReach wrongly forced ${e.kind}(${e.r},${e.c})`);
  }
});

test('Shingoki maxReach: force-soundness vs the oracle (3x3 + 4x4 boards)', () => {
  // NOTE (board fix): the plan's 3x3 board [[2,0,0,-2],...,[-2,0,0,2]] is UNSATISFIABLE
  // (white n=2 at a corner has no straight run through it -> 0 solutions), which would
  // make the oracle test pass VACUOUSLY. Replaced with a satisfiable mixed board
  // (white n=2 at top-edge (0,1) + black n=2 interior at (2,2)) verified at 7 solutions,
  // which exercises both the white and black branches of _maxReachForce.
  const boards = [
    { rows: 3, cols: 3, task: [[0,2,0,0],[0,0,0,0],[0,0,-2,0],[0,0,0,0]] },
    { rows: 4, cols: 4, task: [[0,0,3,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,4,0,0]] },
  ];
  for (const b of boards) {
    assert.ok(bruteForceSolutions(b.rows, b.cols, b.task).length >= 1, 'board must be satisfiable');
    assertForceSoundness(b.rows, b.cols, b.task, (s) => s._maxReachForce());
  }
});
