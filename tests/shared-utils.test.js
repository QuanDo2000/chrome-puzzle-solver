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

test('lruSet evicts the oldest entry at capacity', () => {
  const m = new Map();
  solverShared.lruSet(m, 2, 'a', 1);
  solverShared.lruSet(m, 2, 'b', 2);
  solverShared.lruSet(m, 2, 'c', 3); // evicts 'a'
  assert.deepEqual([...m.keys()], ['b', 'c']);
  assert.equal(m.get('c'), 3);
  solverShared.lruSet(m, 2, 'b', 20); // update existing at capacity
  assert.equal(m.get('b'), 20);
});

test('whiteConnectivity: connected ok, split fails, forces a cut cell', () => {
  // cellStatus 1=black 2=white 0=unknown.
  // Split: white at both ends, black wall in middle → a known white is unreachable.
  assert.equal(solverShared.whiteConnectivity([2, 0, 1, 0, 2], 1, 5, true, () => true), false);
  // Connected (in lookahead): two whites with unknowns between → fine.
  assert.equal(solverShared.whiteConnectivity([2, 0, 0, 0, 2], 1, 5, true, () => true), true);
  // Articulation forcing (outside lookahead): the lone unknown bridging two whites
  // in [2,0,2] must be forced white via set().
  const board = [2, 0, 2];
  const forced = [];
  const res = solverShared.whiteConnectivity(board, 1, 3, false,
    (idx, v) => { forced.push([idx, v]); board[idx] = v; return true; });
  assert.equal(res, true);
  assert.deepEqual(forced, [[1, 2]]);
});

test('trailPush + rollbackTrail round-trip cell values', () => {
  const trail = [];
  const cs = [5, 7, 9];
  solverShared.trailPush(trail, 0, cs[0]); cs[0] = 1;
  solverShared.trailPush(trail, 2, cs[2]); cs[2] = 1;
  assert.deepEqual(cs, [1, 7, 1]);
  solverShared.rollbackTrail(trail, cs, 1); // undo back to mark 1
  assert.deepEqual(cs, [1, 7, 9]);
  solverShared.rollbackTrail(trail, cs, 0);
  assert.deepEqual(cs, [5, 7, 9]);
  assert.equal(trail.length, 0);
});

test('collectChangedCells reports 0→nonzero cells as {row,col,value}', () => {
  const before = new Uint8Array([0, 0, 1, 0]); // 2×2
  const after  = [0, 2, 1, 1];                 // idx1: 0→2, idx3: 0→1; idx2 already 1
  assert.deepEqual(solverShared.collectChangedCells(after, before, 2), [
    { row: 0, col: 1, value: 2 },
    { row: 1, col: 1, value: 1 },
  ]);
});
