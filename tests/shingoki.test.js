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
