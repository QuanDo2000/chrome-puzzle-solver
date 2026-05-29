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
