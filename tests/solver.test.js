const test = require('node:test');
const assert = require('node:assert/strict');
const { NonogramSolver, AquariumSolver, GalaxiesSolver, BinairoSolver } = require('../solver.js');
const fixtures = require('./fixtures/puzzles.js');
const golden = require('./golden.js');

// Roundtrip through JSON to match the capture script's representation: drops
// non-numeric properties some solvers attach to grid arrays (e.g. Galaxies
// stores its galaxies array as a side-property on the grid).
function clean(result) {
  if (!result || typeof result !== 'object') return result;
  const { solved, grid, error } = result;
  return JSON.parse(JSON.stringify({ solved, grid, error: error || null }));
}

test('NonogramSolver: diagonal 5x5 matches golden', () => {
  const p = fixtures.nonogramDiagonal5;
  const result = clean(new NonogramSolver(p.rowClues, p.colClues).solve(null));
  assert.deepEqual(result, golden.nonogramDiagonal5);
});

test('NonogramSolver: corners 3x3 matches golden', () => {
  const p = fixtures.nonogramCorners3;
  const result = clean(new NonogramSolver(p.rowClues, p.colClues).solve(null));
  assert.deepEqual(result, golden.nonogramCorners3);
});

test('AquariumSolver: tiny 2x2 matches golden', () => {
  const p = fixtures.aquariumTiny;
  const result = clean(
    new AquariumSolver(p.rowClues, p.colClues, p.regionMap, p.rows, p.cols).solve(null)
  );
  assert.deepEqual(result, golden.aquariumTiny);
});

test('AquariumSolver: large 15x15 matches golden (exercises DP machinery)', () => {
  const p = fixtures.aquariumLarge;
  const result = clean(
    new AquariumSolver(p.rowClues, p.colClues, p.regionMap, p.rows, p.cols).solve(null)
  );
  assert.deepEqual(result, golden.aquariumLarge);
});

test('GalaxiesSolver: tiny 4x4 matches golden', () => {
  const p = fixtures.galaxiesTiny;
  const result = clean(new GalaxiesSolver(p.stars, p.rows, p.cols).solve(null));
  assert.deepEqual(result, golden.galaxiesTiny);
});

test('GalaxiesSolver: small 7x7 matches golden (exercises _search backtracking)', () => {
  const p = fixtures.galaxiesSmall;
  const result = clean(new GalaxiesSolver(p.stars, p.rows, p.cols).solve(null));
  assert.deepEqual(result, golden.galaxiesSmall);
});

test('BinairoSolver: constructor accepts givens and exposes rows/cols', () => {
  const p = fixtures.binairo6x6;
  const s = new BinairoSolver({ rows: p.rows, cols: p.cols, givens: p.givens });
  assert.equal(s.rows, p.rows);
  assert.equal(s.cols, p.cols);
});

test('BinairoSolver: no-triples propagation forces opposite when two same in a row', () => {
  // Row: [1, 1, ?, ?, ?, ?] — third cell must be 2 (zero).
  const s = new BinairoSolver({
    rows: 6, cols: 6,
    givens: [
      [1, 1, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1, -1],
    ],
  });
  const ok = s.propagate();
  assert.equal(ok, true);
  assert.equal(s._get(0, 2), 2, 'cell (0,2) must be forced to 2 (zero)');
});

test('BinairoSolver: balance rule fills row when half is reached (6-cell row, 3 ones placed)', () => {
  // Row 0 has three 1s; the remaining three empty cells must all become 2.
  const s = new BinairoSolver({
    rows: 6, cols: 6,
    givens: [
      [1, -1, 1, -1, 1, -1],
      [-1, -1, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1, -1],
    ],
  });
  const ok = s.propagate();
  assert.equal(ok, true);
  for (let c = 0; c < 6; c++) {
    if (c % 2 === 1) assert.equal(s._get(0, c), 2, `row 0 col ${c} should be 2`);
  }
});
