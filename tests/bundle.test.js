'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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

// Directory-driven so the bundler's FILES list can't silently drift from the
// solver directory — a solver added to src/solvers/ but forgotten in the
// bundler would ship a runtime-missing puzzle in the actual extension (the
// dangerous drift axis that solvers-index.test.js does NOT cover). The PRODUCTION
// bundle, not index.js, is the source of truth checked here.
test('solver bundle exports every *Solver class in src/solvers/', () => {
  const bundled = loadBundledSolvers();
  const dir = path.join(__dirname, '..', 'src', 'solvers');
  const SKIP = new Set(['index.js', 'shared.js', 'diff.js']);
  const missing = [];
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.js') && !SKIP.has(f))) {
    for (const name of Object.keys(require(path.join(dir, file)))) {
      if (name.endsWith('Solver') && typeof bundled[name] !== 'function') missing.push(`${name} (${file})`);
    }
  }
  assert.deepEqual(missing, [], `bundle is missing solver classes: ${missing.join(', ')}`);
  assert.equal(typeof bundled.computePuzzleDiff, 'function', 'computePuzzleDiff missing from bundle');
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

test('bundled PipesSolver solves the captured 4x4', () => {
  const bundled = loadBundledSolvers();
  const task = [[8,3,2,6],[8,7,1,10],[10,13,13,11],[6,3,1,8]];
  const res = new bundled.PipesSolver({ rows: 4, cols: 4, task, wrap: false }).solve();
  assert.equal(res.solved, true);
});

test('content bundle parses without SyntaxError (catches bad strip / redeclaration)', () => {
  const src = buildContentBundle();
  // new Function compiles the body immediately but does not run it, so this
  // catches syntax errors (a surviving require, a duplicate declaration)
  // without needing a DOM/chrome environment.
  assert.doesNotThrow(() => new Function(src));
});

test('content bundle has exactly one "use strict" directive (no per-file leftovers)', () => {
  const src = buildContentBundle();
  // The bundler emits one top-of-file directive and strips every per-file
  // 'use strict'; (widget files AND content.js). A leftover in the middle is a
  // stale strip — harmless but a sign the strip regex drifted from its source.
  const count = (src.match(/'use strict';/g) || []).length;
  assert.equal(count, 1, `expected one 'use strict'; directive, found ${count}`);
  // ...and it must be the very first statement, or the whole bundle isn't in
  // strict mode (count===1 alone would pass even if the top directive vanished
  // while a stray mid-bundle one survived).
  assert.ok(src.trimStart().startsWith("'use strict';"), 'bundle must open with the directive');
});

test('solver bundle has exactly one "use strict" directive at the top', () => {
  // Both bundlers share stripLeadingUseStrict (scripts/build-utils.js); guard the
  // solver bundle too so the shared helper can't regress for one and not the other.
  const src = buildSolverBundle();
  const count = (src.match(/'use strict';/g) || []).length;
  assert.equal(count, 1, `expected one 'use strict'; directive, found ${count}`);
  assert.ok(src.trimStart().startsWith("'use strict';"), 'bundle must open with the directive');
});
