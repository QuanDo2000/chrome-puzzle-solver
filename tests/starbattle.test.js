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
