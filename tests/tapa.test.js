'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TapaSolver } = require('../src/solvers/tapa.js');

test('Tapa oracle: clue run-string, no-2x2, connectivity, clue cells never shaded', () => {
  // 3x3, centre clue 1 (one shaded neighbour). Shading just (0,1) -> centre sees run [1].
  const task = [[-1, -1, -1], [-1, 1, -1], [-1, -1, -1]];
  const s = new TapaSolver({ rows: 3, cols: 3, task });
  const sh = (cells) => { const g = [[0,0,0],[0,0,0],[0,0,0]]; for (const [r,c] of cells) g[r][c]=1; return g; };
  assert.equal(s._isValid(sh([[0,1]])), true);            // centre clue sees exactly one run of 1
  assert.equal(s._isValid(sh([[0,0],[0,1]])), false);     // run of 2 -> "2" != "1"
  assert.equal(s._isValid(sh([[1,1]])), false);           // clue cell shaded -> invalid
  // no-2x2: a fully shaded 2x2 is invalid (clue at (1,1) keeps it from being a real board, use 2x2 board)
  const t2 = new TapaSolver({ rows: 2, cols: 2, task: [[-1,-1],[-1,-1]] });
  assert.equal(t2._isValid([[1,1],[1,1]]), false);        // 2x2 all shaded
  // connectivity: two disjoint shaded cells -> invalid
  const t3 = new TapaSolver({ rows: 1, cols: 3, task: [[-1,-1,-1]] });
  assert.equal(t3._isValid([[1,0,1]]), false);            // disconnected
  assert.equal(t3._isValid([[1,1,0]]), true);             // connected
});

test('Tapa clue patterns: a clue enumerates only matching neighbour bitmasks', () => {
  const task = [[-1,-1,-1],[-1,8,-1],[-1,-1,-1]]; // clue 8 = all 8 neighbours shaded
  const s = new TapaSolver({ rows: 3, cols: 3, task });
  const cl = s.clues.find((x) => x.r === 1 && x.c === 1);
  assert.equal(cl.patterns.length, 1);          // only the all-8 mask
  assert.equal(cl.patterns[0], 255);
});
