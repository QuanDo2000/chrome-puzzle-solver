'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSolverBundle } = require('../scripts/build-solver-bundle.js');
const { buildContentBundle } = require('../scripts/build-content-bundle.js');
const nodeSolvers = require('../solver.js');
const fixtures = require('./fixtures/puzzles.js');

// Eval the concatenated solver bundle the same way the browser worker would
// (single script, no module system) — but capture its CJS export tail.
function loadBundledSolvers() {
  const src = buildSolverBundle();
  const m = { exports: {} };
  new Function('module', 'exports', src)(m, m.exports);
  return m.exports;
}

test('solver bundle evaluates and exports every solver class', () => {
  const bundled = loadBundledSolvers();
  for (const name of ['NonogramSolver', 'AquariumSolver', 'MosaicSolver', 'computePuzzleDiff']) {
    assert.equal(typeof bundled[name], 'function', `${name} missing from bundle`);
  }
});

test('bundled NonogramSolver matches the Node-source path', () => {
  const bundled = loadBundledSolvers();
  const p = fixtures.nonogramCorners3;
  const fromBundle = new bundled.NonogramSolver(p.rowClues, p.colClues).solve(null);
  const fromNode = new nodeSolvers.NonogramSolver(p.rowClues, p.colClues).solve(null);
  assert.deepEqual(fromBundle.grid, fromNode.grid);
  assert.equal(fromBundle.solved, true);
});

test('bundled MosaicSolver solves a fixture (exercises a grid solver in-bundle)', () => {
  const bundled = loadBundledSolvers();
  const p = fixtures.mosaic5x5Easy;
  bundled.MosaicSolver.clearSolutionCache();
  const res = new bundled.MosaicSolver({ rows: p.rows, cols: p.cols, task: p.task }).solve();
  assert.equal(res.solved, true);
});

test('content bundle parses without SyntaxError (catches bad strip / redeclaration)', () => {
  const src = buildContentBundle();
  // new Function compiles the body immediately but does not run it, so this
  // catches syntax errors (a surviving require, a duplicate declaration)
  // without needing a DOM/chrome environment.
  assert.doesNotThrow(() => new Function(src));
});
