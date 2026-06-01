'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyHintToGrid } = require('../src/widget/hint.js');

// applyHintToGrid merges a hint into the in-memory grid so the Loop step can
// re-apply the advanced board. Edge-loop puzzles (slitherlink, shingoki) carry
// a { edges: [{orientation,r,c}] } hint against a { horizontal, vertical } grid;
// if their branch is missed the edges never merge, applySolution re-applies the
// unchanged board, and Loop stalls after one step. Regression for the shingoki
// Loop-stall bug.

function emptyEdgeGrid(rows, cols) {
  return {
    horizontal: Array.from({ length: rows + 1 }, () => new Array(cols).fill(0)),
    vertical: Array.from({ length: rows }, () => new Array(cols + 1).fill(0)),
  };
}

test('applyHintToGrid: shingoki edge hint merges lines into the edge grid', () => {
  const grid = emptyEdgeGrid(2, 2);
  const hint = {
    type: 'shingoki',
    edges: [
      { orientation: 'h', r: 0, c: 1 },
      { orientation: 'v', r: 1, c: 0 },
    ],
  };
  applyHintToGrid(grid, hint);
  assert.equal(grid.horizontal[0][1], 1, 'horizontal edge merged as a line');
  assert.equal(grid.vertical[1][0], 1, 'vertical edge merged as a line');
  // untouched edges stay 0
  assert.equal(grid.horizontal[0][0], 0);
  assert.equal(grid.vertical[0][0], 0);
});

test('applyHintToGrid: slitherlink edge hint still merges (shared branch)', () => {
  const grid = emptyEdgeGrid(2, 2);
  applyHintToGrid(grid, { type: 'slitherlink', edges: [{ orientation: 'h', r: 2, c: 0 }] });
  assert.equal(grid.horizontal[2][0], 1);
});
