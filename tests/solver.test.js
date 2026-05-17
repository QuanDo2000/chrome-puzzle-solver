const test = require('node:test');
const assert = require('node:assert/strict');
const { NonogramSolver, AquariumSolver, GalaxiesSolver } = require('../solver.js');
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

test('GalaxiesSolver: tiny 4x4 matches golden', () => {
  const p = fixtures.galaxiesTiny;
  const result = clean(new GalaxiesSolver(p.stars, p.rows, p.cols).solve(null));
  assert.deepEqual(result, golden.galaxiesTiny);
});
