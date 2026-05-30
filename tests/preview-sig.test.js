'use strict';
// Characterization test for preview.js's redraw early-bail signature hashes
// (regionMapSig, gridDataSig). These are session-only equality hashes, but we
// pin their exact output so the FNV-1a dedup (routing them through the shared
// hashFNV1a) stays byte-identical. Golden values captured from the pre-dedup
// inline implementations.

const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../src/widget/preview.js');

test('regionMapSig is unchanged (signed int, unmasked, row separators)', () => {
  assert.equal(p.regionMapSig(null), 0);
  assert.equal(p.regionMapSig([[0, 1, 1], [0, 2, 2]]), -1146191785);
  // Region ids > 255 exercise the unmasked path (must NOT be & 0xff masked).
  assert.equal(p.regionMapSig([[300, 1], [1, 300]]), 489471715);
});

test('gridDataSig is unchanged across all branches', () => {
  // Default grid branch → signed number.
  assert.equal(p.gridDataSig([[1, -1, 0], [0, 1, -1]]), 127739917);
  const g = [[1, -1], [0, 1]];
  g.galaxies = { horizontal: [[1, 0]], vertical: [[0, 1]] };
  assert.equal(p.gridDataSig(g), 905401023);
  // Hashi edges branch (masked) → hex string.
  assert.equal(p.gridDataSig({ edges: [{ a: 0, b: 1, bridges: 2 }, { a: 1, b: 5, bridges: 1 }] }), '4a65e5d1');
  // Slitherlink branch (unmasked) → hex string.
  assert.equal(p.gridDataSig({ horizontal: [[1, 0], [0, 1]], vertical: [[0, 1], [1, 0]] }), 'c420c51a');
  const s = { horizontal: [[1]], vertical: [[0]] };
  s.galaxies = { horizontal: [[1]], vertical: [[0]] };
  assert.equal(p.gridDataSig(s), '4d90ee4e');
});
