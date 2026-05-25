'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { NurikabeSolver, computePuzzleDiff } = require('../solver.js');

test('NurikabeSolver: constructor sets clue cells WHITE and builds clues list', () => {
  const s = new NurikabeSolver({
    rows: 3, cols: 3,
    task: [[1, -1, -1], [-1, -1, -1], [-1, -1, 2]],
  });
  assert.equal(s.rows, 3);
  assert.equal(s.cols, 3);
  assert.equal(s.clues.length, 2);
  assert.deepEqual(s.clues.map(c => ({idx: c.idx, size: c.size})), [
    {idx: 0, size: 1},
    {idx: 8, size: 2},
  ]);
  assert.equal(s.expectedBlacks, 6);
  assert.equal(s.cellStatus[0], 2);
  assert.equal(s.cellStatus[8], 2);
});

test('NurikabeSolver: _set / _rollback round-trip', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[1, -1, -1]],
  });
  const mark = s.trail.length;
  assert.equal(s._set(1, 1), true);
  assert.equal(s.cellStatus[1], 1);
  s._rollback(mark);
  assert.equal(s.cellStatus[1], 0);
});

test('NurikabeSolver: _set overwriting same value is no-op (true)', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[1, -1, -1]],
  });
  assert.equal(s._set(0, 2), true);
});

test('NurikabeSolver: _set overwriting different non-zero → false', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[1, -1, -1]],
  });
  assert.equal(s._set(0, 1), false);
});

test('NurikabeSolver: constructor pre-check rejects when a clue can not reach its size', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[5, -1, -1]],
  });
  assert.equal(s.contradiction, true);
});

test('NurikabeSolver: two adjacent clue cells set contradiction at construction', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 2,
    task: [[1, 1]],
  });
  assert.equal(s.contradiction, true);
});

test('NurikabeSolver._applyClueAdjacency: cell with 2 clue neighbours → BLACK', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[1, -1, 1]],
  });
  assert.equal(s.contradiction, false);
  assert.equal(s._applyClueAdjacency(), true);
  assert.equal(s.cellStatus[1], 1);
});

test('NurikabeSolver._applyClueAdjacency: cell with one clue neighbour stays unknown', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[1, -1, -1]],
  });
  assert.equal(s._applyClueAdjacency(), true);
  assert.equal(s.cellStatus[1], 0);
});

test('NurikabeSolver._applyUnreachable: cell out of all clue reach → BLACK', () => {
  const s = new NurikabeSolver({
    rows: 5, cols: 5,
    task: [
      [1, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1],
      [-1, -1, -1, -1, 1],
    ],
  });
  assert.equal(s._applyUnreachable(), true);
  assert.equal(s.cellStatus[12], 1);
});

test('NurikabeSolver._applyUnreachable: cell within Manhattan-but-not-BFS-distance still gets forced', () => {
  const s = new NurikabeSolver({
    rows: 3, cols: 3,
    task: [[2, -1, -1], [-1, -1, -1], [-1, -1, -1]],
  });
  assert.equal(s._applyUnreachable(), true);
  assert.equal(s.cellStatus[8], 1);
});

test('NurikabeSolver._applyUnreachable: cell within reach stays unknown', () => {
  const s = new NurikabeSolver({
    rows: 3, cols: 3,
    task: [[-1, -1, -1], [-1, 4, -1], [-1, -1, -1]],
  });
  assert.equal(s._applyUnreachable(), true);
  assert.equal(s.cellStatus[0], 0);
});

test('NurikabeSolver._applyIslandComplete: white component == N forces UNKNOWN frontier to BLACK', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[2, -1, -1]],
  });
  s._set(1, 2);
  assert.equal(s._applyIslandComplete(), true);
  assert.equal(s.cellStatus[2], 1);
});

test('NurikabeSolver._applyIslandComplete: capacity == N forces reachable UNKNOWNs to WHITE', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[2, -1, -1]],
  });
  s._set(2, 1);
  assert.equal(s._applyIslandComplete(), true);
  assert.equal(s.cellStatus[1], 2);
});

test('NurikabeSolver._applyIslandComplete: white component > N → contradiction', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[1, -1, -1]],
    initialState: [[2, 2, 0]],
  });
  assert.equal(s._applyIslandComplete(), false);
});

test('NurikabeSolver._applyIslandComplete: capacity < N → contradiction', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[3, -1, -1]],
    initialState: [[2, 0, 1]],
  });
  assert.equal(s._applyIslandComplete(), false);
});

test('NurikabeSolver._apply2x2: 4 blacks in 2x2 → contradiction', () => {
  const s = new NurikabeSolver({
    rows: 2, cols: 2,
    task: [[-1, -1], [-1, -1]],
    initialState: [[1, 1], [1, 1]],
  });
  assert.equal(s._apply2x2(), false);
});

test('NurikabeSolver._apply2x2: 3 blacks + 1 unknown in 2x2 → unknown forced WHITE', () => {
  const s = new NurikabeSolver({
    rows: 2, cols: 2,
    task: [[-1, -1], [-1, -1]],
    initialState: [[1, 1], [1, 0]],
  });
  assert.equal(s._apply2x2(), true);
  assert.equal(s.cellStatus[3], 2);
});

test('NurikabeSolver._applyBlackCount: too many blacks → contradiction', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[2, -1, -1]],
    initialState: [[2, 1, 1]],
  });
  assert.equal(s._applyBlackCount(), false);
});

test('NurikabeSolver._applyBlackCount: nB + nU == expected → all unknowns BLACK', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[1, -1, -1]],
    initialState: [[2, 0, 1]],
  });
  assert.equal(s._applyBlackCount(), true);
  assert.equal(s.cellStatus[1], 1);
});

test('NurikabeSolver._applySeaConnectivity: two BLACKs separated only by all-WHITE → contradiction', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[-1, 1, -1]],
    initialState: [[1, 2, 1]],
  });
  assert.equal(s._applySeaConnectivity(), false);
});

test('NurikabeSolver._applySeaConnectivity: connected via UNKNOWN is fine', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[-1, -1, -1]],
    initialState: [[1, 0, 1]],
  });
  assert.equal(s._applySeaConnectivity(), true);
});

test('NurikabeSolver._propagate: fixpoint solves trivial 1x2 clue 2', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 2,
    task: [[2, -1]],
  });
  assert.equal(s._propagate(), true);
  assert.equal(s.cellStatus[0], 2);
  assert.equal(s.cellStatus[1], 2);
});

test('NurikabeSolver._propagate: returns false on inherent contradiction', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[1, 1, -1]],
  });
  assert.equal(s.contradiction, true);
});

test('NurikabeSolver.solve: solves trivial 1x2 clue 2', () => {
  NurikabeSolver.clearSolutionCache();
  const s = new NurikabeSolver({
    rows: 1, cols: 2,
    task: [[2, -1]],
    maxMs: 5000,
  });
  const r = s.solve();
  assert.equal(r.solved, true);
  assert.deepEqual(r.grid, [[2, 2]]);
});

test('NurikabeSolver.solve: solves unsat returning {solved:false, grid:null}', () => {
  NurikabeSolver.clearSolutionCache();
  const s = new NurikabeSolver({
    rows: 1, cols: 2,
    task: [[1, 1]],
    maxMs: 5000,
  });
  const r = s.solve();
  assert.equal(r.solved, false);
  assert.equal(r.grid, null);
});

test('NurikabeSolver._solutionCache: cache hit returns deep copy', () => {
  NurikabeSolver.clearSolutionCache();
  const opts = { rows: 1, cols: 2, task: [[2, -1]] };
  const a = new NurikabeSolver(opts).solve();
  a.grid[0][0] = 99;
  const b = new NurikabeSolver(opts).solve();
  assert.notEqual(b.grid[0][0], 99);
});

test('computePuzzleDiff nurikabe: flags wrong-color non-clue cells', () => {
  const solution = [[2, 1], [1, 2]];
  const board = [[2, 2], [1, 2]];
  const diff = computePuzzleDiff('nurikabe', board, solution);
  assert.equal(diff.length, 1);
  assert.deepEqual(diff[0], { row: 0, col: 1, expected: 1, actual: 2 });
});

test('NurikabeSolver.getHint: 1x2 clue 2 yields the other white as a hint', () => {
  NurikabeSolver.clearSolutionCache();
  const s = new NurikabeSolver({
    rows: 1, cols: 2,
    task: [[2, -1]],
  });
  const hint = s.getHint([[2, 0]]);
  assert.ok(Array.isArray(hint));
  assert.ok(hint.some(h => h.row === 0 && h.col === 1 && h.value === 2));
});

test('NurikabeSolver.getHint: null on already-solved board', () => {
  NurikabeSolver.clearSolutionCache();
  const s = new NurikabeSolver({
    rows: 1, cols: 2,
    task: [[2, -1]],
  });
  assert.equal(s.getHint([[2, 2]]), null);
});

test('NurikabeSolver: wall cells (task=-2) are off-board, excluded from expectedBlacks', () => {
  // 2x2: top-left clue size 2, top-right wall, bottom both blank.
  // Board cells: 3 (excluding the wall). Clue value = 2. So expectedBlacks = 3 - 2 = 1.
  const s = new NurikabeSolver({
    rows: 2, cols: 2,
    task: [[2, -2], [-1, -1]],
  });
  assert.equal(s.contradiction, false);
  assert.equal(s.isWall[1], 1);
  assert.equal(s.isWall[0], 0);
  assert.equal(s.expectedBlacks, 1);
  const r = s.solve();
  assert.equal(r.solved, true);
  // Wall stays 0; clue stays WHITE; one more WHITE; one BLACK.
  assert.equal(r.grid[0][1], 0);
});

test('NurikabeSolver: walls disable 2x2 black violation', () => {
  // 2x2 with a wall at top-right. Force the other 3 cells BLACK — shouldn't be a violation.
  const s = new NurikabeSolver({
    rows: 2, cols: 2,
    task: [[-1, -2], [-1, -1]],
    initialState: [[1, 0], [1, 1]],
  });
  assert.equal(s._apply2x2(), true);
});

test('NurikabeSolver: walls block BFS reach', () => {
  // 1x4 with clue 2 at (0,0), wall at (0,1), blanks at (0,2)(0,3).
  // Clue's reach = just itself (wall blocks). Capacity < 2 → contradiction.
  const s = new NurikabeSolver({
    rows: 1, cols: 4,
    task: [[2, -2, -1, -1]],
  });
  assert.equal(s.contradiction, true);
});

test('NurikabeSolver._applyFrontierForce: single frontier cell forces WHITE', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 4,
    task: [[2, -1, -1, -1]],
    initialState: [[2, 0, 1, 0]],
  });
  assert.equal(s._buildClaimedBy(), true);
  assert.equal(s._applyFrontierForce(), true);
  assert.equal(s.cellStatus[1], 2);
});

test('NurikabeSolver._applyFrontierForce: empty frontier with unfinished island → contradiction', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[2, -1, -1]],
    initialState: [[2, 1, 0]],
  });
  assert.equal(s._buildClaimedBy(), true);
  assert.equal(s._applyFrontierForce(), false);
});

test('NurikabeSolver._applyFrontierForce: multiple frontier cells → no forcing', () => {
  const s = new NurikabeSolver({
    rows: 2, cols: 2,
    task: [[2, -1], [-1, -1]],
  });
  assert.equal(s._buildClaimedBy(), true);
  assert.equal(s._applyFrontierForce(), true);
  assert.equal(s.cellStatus[1], 0);
  assert.equal(s.cellStatus[2], 0);
});

test('NurikabeSolver._applyFrontierForce: frontier cell claimed by another clue is excluded', () => {
  // 1x5: clue 2 at (0,0), clue 1 at (0,3). Initial state: clue (0,0) WHITE,
  // (0,1) UNKNOWN, (0,2) BLACK (separates the two clues), clue (0,3) WHITE,
  // (0,4) UNKNOWN.
  //
  // For clue (0,0) (size 2, current WHITE component = {(0,0)}, size 1):
  // frontier neighbours of (0,0) are only (0,1) (since (0,2) is BLACK and
  // (0,3) is a clue cell — but (0,3) is not adjacent to (0,0) anyway).
  // So frontier = {(0,1)}, count 1, forces (0,1) WHITE.
  //
  // Now the interesting check: for clue (0,3) (size 1, complete with just
  // its own cell — size === N), the rule should skip via `size >= clue.size`
  // and not try to force (0,4) which has no other clue context. Verify
  // (0,4) is left UNKNOWN (no spurious force).
  const s = new NurikabeSolver({
    rows: 1, cols: 5,
    task: [[2, -1, -1, 1, -1]],
    initialState: [[2, 0, 1, 2, 0]],
  });
  assert.equal(s._buildClaimedBy(), true);
  assert.equal(s._applyFrontierForce(), true);
  assert.equal(s.cellStatus[1], 2);
  assert.equal(s.cellStatus[4], 0);
});

test('NurikabeSolver._applyFrontierForce: WHITE cell claimed by another clue blocks frontier', () => {
  // 2x3 with clue 2 at (0,0) and clue 1 at (0,2). Pre-mark (0,1) WHITE so
  // that, in isolation, clue (0,0) could see (0,1) as an extension of its
  // component. But (0,1) is WHITE-adjacent to clue (0,2), so _buildClaimedBy
  // would flag it as owned by (0,2) -- wait, (0,1) is adjacent to both, so
  // _buildClaimedBy would detect the conflict and return false. Let's use
  // a different layout: place (0,1) WHITE adjacent to clue (0,2) only (not
  // to clue (0,0)). E.g. 1x4 with clue 2 at (0,0), BLACK at (0,1), WHITE at
  // (0,2), clue 1 at (0,3). Actually (0,3) has size 1, and (0,2) WHITE
  // claimed by (0,3)? No -- claimedBy traverses WHITE-only from a clue.
  // (0,2) is WHITE; (0,3) is a clue but WHITE in cellStatus; they're
  // adjacent. So _buildClaimedBy claims (0,2) for clue (0,3). Then for
  // clue (0,0) (size 2, component {(0,0)}, BLACK at (0,1)), no frontier
  // (only neighbour is (0,1) which is BLACK). Contradiction.
  //
  // For a cleaner test of the "claimed-by-other" exclusion: 2x3 with clue
  // 3 at (0,0), clue 1 at (1,2). Pre-mark (1,1) WHITE so it could be in
  // (0,0)'s island in isolation, but _buildClaimedBy would not claim (1,1)
  // for clue (1,2) (they're not adjacent — (1,1) and (1,2) ARE adjacent
  // actually). So _buildClaimedBy claims (1,1) for clue (1,2). Then for
  // clue (0,0) the BFS from (0,0): (0,1) UNKNOWN (frontier), (1,0)
  // UNKNOWN (frontier). (1,1) is WHITE but claimed by another clue —
  // excluded. So frontier = {(0,1), (1,0)}, count 2 → no force on either.
  // Verify (0,1) and (1,0) stay UNKNOWN despite (0,0) having size 1 < 3.
  const s = new NurikabeSolver({
    rows: 2, cols: 3,
    task: [[3, -1, -1], [-1, -1, 1]],
    initialState: [[2, 0, 0], [0, 2, 2]],
  });
  assert.equal(s._buildClaimedBy(), true);
  assert.equal(s._applyFrontierForce(), true);
  assert.equal(s.cellStatus[1], 0);
  assert.equal(s.cellStatus[3], 0);
});

test('NurikabeSolver._applySeaArticulation: cut UNKNOWN between two BLACKs → BLACK', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[-1, -1, -1]],
    initialState: [[1, 0, 1]],
  });
  assert.equal(s._applySeaArticulation(), true);
  assert.equal(s.cellStatus[1], 1);
});

test('NurikabeSolver._applySeaArticulation: no BLACK cells yet → returns true, no force', () => {
  const s = new NurikabeSolver({
    rows: 3, cols: 3,
    task: [[1, -1, -1], [-1, -1, -1], [-1, -1, 1]],
  });
  assert.equal(s._applySeaArticulation(), true);
  for (let i = 0; i < 9; i++) {
    if (s.task[i] > 0) assert.equal(s.cellStatus[i], 2);
    else assert.equal(s.cellStatus[i], 0);
  }
});

test('NurikabeSolver._applySeaArticulation: alternative route exists → no force', () => {
  const s = new NurikabeSolver({
    rows: 2, cols: 3,
    task: [[-1, -1, -1], [-1, -1, -1]],
    initialState: [[1, 0, 1], [0, 0, 0]],
  });
  assert.equal(s._applySeaArticulation(), true);
  assert.equal(s.cellStatus[1], 0);
});

test('NurikabeSolver._applySeaArticulation: skipped during lookahead', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[-1, -1, -1]],
    initialState: [[1, 0, 1]],
  });
  s._inLookahead = true;
  assert.equal(s._applySeaArticulation(), true);
  assert.equal(s.cellStatus[1], 0);
});

test('NurikabeSolver._applyShapeEnumeration: 1x3 clue 3 forces all cells WHITE', () => {
  const s = new NurikabeSolver({
    rows: 1, cols: 3,
    task: [[3, -1, -1]],
  });
  assert.equal(s._buildClaimedBy(), true);
  assert.equal(s._applyShapeEnumeration(), true);
  assert.equal(s.cellStatus[0], 2);
  assert.equal(s.cellStatus[1], 2);
  assert.equal(s.cellStatus[2], 2);
});

test('NurikabeSolver._applyShapeEnumeration: 2x2 clue 4 forces every cell WHITE', () => {
  // The only valid size-4 connected shape on a 2x2 board with no
  // restrictions is the entire board. Every cell appears in inAll →
  // every UNKNOWN cell forced WHITE.
  const s = new NurikabeSolver({
    rows: 2, cols: 2,
    task: [[4, -1], [-1, -1]],
  });
  assert.equal(s._buildClaimedBy(), true);
  assert.equal(s._applyShapeEnumeration(), true);
  assert.equal(s.cellStatus[0], 2);
  assert.equal(s.cellStatus[1], 2);
  assert.equal(s.cellStatus[2], 2);
  assert.equal(s.cellStatus[3], 2);
});

test('NurikabeSolver._applyShapeEnumeration: divergent shapes leave shared-only cells unknown', () => {
  const s = new NurikabeSolver({
    rows: 2, cols: 2,
    task: [[2, -1], [-1, -1]],
  });
  assert.equal(s._buildClaimedBy(), true);
  assert.equal(s._applyShapeEnumeration(), true);
  assert.equal(s.cellStatus[1], 0);
  assert.equal(s.cellStatus[2], 0);
});

test('NurikabeSolver._applyShapeEnumeration: skips clues larger than cap', () => {
  const taskArr = [
    [16, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1]
  ];
  const s = new NurikabeSolver({ rows: 4, cols: 4, task: taskArr });
  assert.equal(s._buildClaimedBy(), true);
  assert.equal(s._applyShapeEnumeration(), true);
});
