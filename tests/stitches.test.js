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
