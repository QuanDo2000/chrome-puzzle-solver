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
  s.g[1][1] = 1; // a tent at centre (set directly for the test)
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
