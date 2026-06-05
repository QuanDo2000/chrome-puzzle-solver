'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { StarBattleSolver } = require('../src/solvers/starbattle.js');

// k stars per row/col/region (shaped: areas), no two stars 8-adjacent, no star on a wall (shapeless).
function mk(opts) { return new StarBattleSolver(opts); }
const QUAD = [[0, 0, 1, 1], [0, 0, 1, 1], [2, 2, 3, 3], [2, 2, 3, 3]]; // 4 quadrant regions

test('StarBattle oracle: a valid 4x4 k=1 board (1 star per row/col/region, no adjacency)', () => {
  const s = mk({ rows: 4, cols: 4, stars: 1, areas: QUAD });
  assert.equal(s._isValid([[0, 1, 0, 0], [0, 0, 0, 1], [1, 0, 0, 0], [0, 0, 1, 0]]), true);
});

test('StarBattle oracle: two 8-adjacent stars are invalid', () => {
  const s = mk({ rows: 4, cols: 4, stars: 1, areas: QUAD });
  assert.equal(s._isValid([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 0, 1], [0, 0, 1, 0]]), false); // (0,0)&(1,1) diagonal
});

test('StarBattle oracle: a wrong row count is invalid', () => {
  const s = mk({ rows: 4, cols: 4, stars: 1, areas: QUAD });
  assert.equal(s._isValid([[1, 0, 1, 0], [0, 1, 0, 0], [0, 0, 0, 1], [0, 0, 0, 0]]), false); // row 0 has 2
});

test('StarBattle oracle: a wrong region count is invalid', () => {
  const s = mk({ rows: 4, cols: 4, stars: 1, areas: QUAD });
  assert.equal(s._isValid([[0, 0, 1, 0], [0, 0, 0, 1], [1, 0, 0, 0], [0, 1, 0, 0]]), false); // region 0 has 0 stars
});

test('StarBattle oracle (shapeless): a star on a wall cell is invalid', () => {
  const s = mk({ rows: 4, cols: 4, stars: 1, walls: [[0, 0, 0, 0], [0, 1, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] });
  assert.equal(s._isValid([[0, 0, 0, 1], [0, 1, 0, 0], [1, 0, 0, 0], [0, 0, 1, 0]]), false); // star at (1,1) wall
});

test('StarBattle propagation: a placed star crosses its 8 neighbours', () => {
  // 5x5 k=1, no regions: a star at (2,2) is feasible, so propagation succeeds and crosses all 8 neighbours.
  const s = mk({ rows: 5, cols: 5, stars: 1 });
  s._initGrid(); s.g[2][2] = 1; // a star at the centre
  assert.equal(s._propagate(), true);
  for (const [r, c] of [[1,1],[1,2],[1,3],[2,1],[2,3],[3,1],[3,2],[3,3]]) assert.equal(s.g[r][c], 2);
});

test('StarBattle propagation: a group with all-but-k crossed forces the rest to stars', () => {
  // row 0, k=1: cross 3 cells -> the 4th is forced a star.
  const s = mk({ rows: 4, cols: 4, stars: 1, areas: QUAD });
  s._initGrid(); s.g[0][0] = 2; s.g[0][1] = 2; s.g[0][2] = 2;
  assert.equal(s._propagate(), true);
  assert.equal(s.g[0][3], 1); // forced star
});

test('StarBattle propagation: over-filled row is a contradiction', () => {
  const s = mk({ rows: 4, cols: 4, stars: 1, areas: QUAD });
  s._initGrid(); s.g[0][0] = 1; s.g[0][2] = 1; // two stars in a k=1 row
  assert.equal(s._propagate(), false);
});
