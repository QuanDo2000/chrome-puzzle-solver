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
