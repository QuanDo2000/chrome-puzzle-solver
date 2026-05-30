'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const solverShared = require('../src/solvers/shared.js');

test('solver hashFNV1a matches a hand-computed FNV-1a value', () => {
  // FNV-1a over bytes [1, 2]: h=0x811c9dc5; for each b: h^=b; h=imul(h,0x01000193)>>>0
  let h = 0x811c9dc5;
  for (const b of [1, 2]) { h ^= b & 0xff; h = Math.imul(h, 0x01000193) >>> 0; }
  const expected = h >>> 0;
  const got = solverShared.hashFNV1a((mix) => { mix(1); mix(2); });
  assert.equal(got, expected);
});

test('solver hashFNV1a is deterministic and order-sensitive', () => {
  const a = solverShared.hashFNV1a((mix) => { mix(3); mix(7); });
  const b = solverShared.hashFNV1a((mix) => { mix(3); mix(7); });
  const c = solverShared.hashFNV1a((mix) => { mix(7); mix(3); });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('solver hashFNV1a mask=false leaves bytes >= 256 unmasked (differs from masked)', () => {
  const feed = (mix) => { mix(300); mix(1); };
  // masked folds 300 -> 300 & 0xff (44); unmasked XORs the full value.
  assert.notEqual(solverShared.hashFNV1a(feed, true), solverShared.hashFNV1a(feed, false));
});

test('solver hashFNV1a mask=true equals mask=false when all bytes < 256', () => {
  const feed = (mix) => { mix(5); mix(200); mix(0); };
  assert.equal(solverShared.hashFNV1a(feed, true), solverShared.hashFNV1a(feed, false));
});

const widgetShared = require('../src/widget/shared.js');

test('widget hashFNV1a matches the solver implementation for the same feed', () => {
  const feed = (mix) => { mix(5); mix(9); mix(0); };
  assert.equal(widgetShared.hashFNV1a(feed), solverShared.hashFNV1a(feed));
});

test('widget hashFNV1a mask flag matches solver helper (both modes)', () => {
  const feedBig = (mix) => { mix(300); mix(1); };
  assert.equal(widgetShared.hashFNV1a(feedBig, true), solverShared.hashFNV1a(feedBig, true));
  assert.equal(widgetShared.hashFNV1a(feedBig, false), solverShared.hashFNV1a(feedBig, false));
  assert.notEqual(widgetShared.hashFNV1a(feedBig, true), widgetShared.hashFNV1a(feedBig, false));
});

test('emitGrid rebuilds a 1-D cellStatus into a 2-D grid', () => {
  const cs = [1, 2, 0, 0, 1, 2]; // 2 rows × 3 cols
  assert.deepEqual(solverShared.emitGrid(cs, 2, 3), [[1, 2, 0], [0, 1, 2]]);
});

test('cloneSolveResult deep-copies grid and preserves flags', () => {
  const src = { solved: true, grid: [[1, 2], [0, 1]], partial: true };
  const out = solverShared.cloneSolveResult(src);
  assert.deepEqual(out, src);
  out.grid[0][0] = 9;
  assert.equal(src.grid[0][0], 1); // deep copy, not shared
  assert.ok(!('error' in solverShared.cloneSolveResult({ solved: false, grid: null })));
});

test('timeUp: unlimited when maxMs <= 0, else compares elapsed', () => {
  assert.equal(solverShared.timeUp(0, 0), false);
  assert.equal(solverShared.timeUp(-1, 0), false);
  assert.equal(solverShared.timeUp(1000, Date.now()), false);     // just started
  assert.equal(solverShared.timeUp(10, Date.now() - 1000), true); // long over
});
