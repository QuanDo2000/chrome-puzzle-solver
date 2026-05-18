const test = require('node:test');
const assert = require('node:assert/strict');
const { parseGalaxiesTask, buildGalaxiesLinesFromRegions } = require('../handler.js');

// ── parseGalaxiesTask ─────────────────────────────────────────────
// Encoding: stars on a (2*width-1) × (2*height-1) doubled-coord grid.
// Each letter offsets the running position: 'a'=+0, 'b'=+1, ..., 'y'=+24.
// 'z' is a +25 skip with no star recorded. After a star, position auto-
// advances 1. If position lands beyond `rows`, parsing stops.

test('parseGalaxiesTask: empty / null task returns []', () => {
  assert.deepEqual(parseGalaxiesTask('', 4, 4), []);
  assert.deepEqual(parseGalaxiesTask(null, 4, 4), []);
  assert.deepEqual(parseGalaxiesTask(undefined, 4, 4), []);
});

test('parseGalaxiesTask: single "a" places one star at (0,0)', () => {
  assert.deepEqual(parseGalaxiesTask('a', 4, 4), [{ row: 0, col: 0 }]);
});

test('parseGalaxiesTask: single "b" places one star at (0,1)', () => {
  // cols = 2*4-1 = 7. pos = 0+1 = 1. row = floor(1/7) = 0, col = 1%7 = 1.
  assert.deepEqual(parseGalaxiesTask('b', 4, 4), [{ row: 0, col: 1 }]);
});

test('parseGalaxiesTask: "z" is a +25 skip with no star', () => {
  // Width/height both 4 → cols=7, rows=7. pos starts 0; 'z' advances to 25
  // (row=floor(25/7)=3, col=4) but no star is pushed. Next letter contributes
  // on top. With nothing after 'z', no stars at all.
  assert.deepEqual(parseGalaxiesTask('z', 4, 4), []);
});

test('parseGalaxiesTask: roundtrip galaxiesTiny stars', () => {
  // galaxiesTiny: stars at (1,3) and (5,3) on a 4×4 puzzle, so cols=7, rows=7.
  // Target positions: 1*7+3=10 and 5*7+3=38. Encoding plan:
  //   'k' (offset 10) → pos=10, star at (1,3), pos=11
  //   'z' (skip 25)   → pos=36, no star
  //   'c' (offset 2)  → pos=38, star at (5,3), pos=39
  const stars = parseGalaxiesTask('kzc', 4, 4);
  assert.deepEqual(stars, [{ row: 1, col: 3 }, { row: 5, col: 3 }]);
});

test('parseGalaxiesTask: breaks when row would exceed grid', () => {
  // After the first 'a' at (0,0), pos=1. If we then place an offset that
  // would push past row 7 (rows = 2*4-1 = 7) we break. Pad with enough 'z'
  // skips to overflow: 4 × 'z' = +100 → row >> 7.
  const stars = parseGalaxiesTask('azzzzz', 4, 4);
  assert.equal(stars.length, 1);
  assert.deepEqual(stars[0], { row: 0, col: 0 });
});

// ── buildGalaxiesLinesFromRegions ────────────────────────────────
// Maps a region-id grid (1 per cell) to the implied galaxies-line layout:
// a horizontal line at row r, col c exists iff grid[r-1][c] !== grid[r][c],
// a vertical line at row r, col c exists iff grid[r][c-1] !== grid[r][c].

test('buildGalaxiesLinesFromRegions: null grid returns zero-filled arrays', () => {
  const lines = buildGalaxiesLinesFromRegions(null, 2, 2);
  assert.equal(lines.horizontal.length, 3); // rows+1
  assert.equal(lines.vertical.length, 2);   // rows
  assert.deepEqual(lines.horizontal[0], [0, 0]);
  assert.deepEqual(lines.horizontal[1], [0, 0]);
});

test('buildGalaxiesLinesFromRegions: horizontal split between regions', () => {
  // 2×2 grid, top row in region 1, bottom row in region 2.
  // Horizontal line should appear at row 1 (between the two rows).
  const grid = [[1, 1], [2, 2]];
  const lines = buildGalaxiesLinesFromRegions(grid, 2, 2);
  assert.deepEqual(lines.horizontal[0], [0, 0]); // top edge, no internal line
  assert.deepEqual(lines.horizontal[1], [1, 1]); // between rows: regions differ
  assert.deepEqual(lines.horizontal[2], [0, 0]); // bottom edge
  // No vertical lines: cells in same row are same region.
  assert.deepEqual(lines.vertical[0], [0, 0, 0]);
  assert.deepEqual(lines.vertical[1], [0, 0, 0]);
});

test('buildGalaxiesLinesFromRegions: vertical split between regions', () => {
  // 2×2 grid, left col in region 1, right col in region 2.
  const grid = [[1, 2], [1, 2]];
  const lines = buildGalaxiesLinesFromRegions(grid, 2, 2);
  // No horizontal lines.
  assert.deepEqual(lines.horizontal[1], [0, 0]);
  // Vertical line at col 1 in both rows.
  assert.deepEqual(lines.vertical[0], [0, 1, 0]);
  assert.deepEqual(lines.vertical[1], [0, 1, 0]);
});

test('buildGalaxiesLinesFromRegions: checkerboard regions give a full lattice', () => {
  // 2×2 with diagonally-opposite regions.
  const grid = [[1, 2], [2, 1]];
  const lines = buildGalaxiesLinesFromRegions(grid, 2, 2);
  assert.deepEqual(lines.horizontal[1], [1, 1]);
  assert.deepEqual(lines.vertical[0], [0, 1, 0]);
  assert.deepEqual(lines.vertical[1], [0, 1, 0]);
});
