'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Guard: src/solvers/index.js (re-exported by the root solver.js shim) must
// re-export EVERY solver class living in src/solvers/. The production bundle
// uses the bundler's own FILES list, not index.js, so a stale index.js breaks
// silently — any consumer doing `const { FooSolver } = require('../solver.js')`
// gets undefined. This test keeps the two aggregators from drifting again.

const SOLVERS_DIR = path.join(__dirname, '..', 'src', 'solvers');
const SKIP = new Set(['index.js', 'shared.js', 'diff.js']);

test('src/solvers/index.js re-exports every *Solver class in the directory', () => {
  const index = require('../src/solvers/index.js');
  const files = fs.readdirSync(SOLVERS_DIR).filter(f => f.endsWith('.js') && !SKIP.has(f));

  const missing = [];
  for (const file of files) {
    const mod = require(path.join(SOLVERS_DIR, file));
    for (const name of Object.keys(mod)) {
      if (!name.endsWith('Solver')) continue; // skip extra helper exports (e.g. tapaRunString)
      if (index[name] !== mod[name]) missing.push(`${name} (from ${file})`);
    }
  }

  assert.deepEqual(missing, [], `index.js is missing solver exports: ${missing.join(', ')}`);
});

test('src/solvers/index.js still re-exports computePuzzleDiff', () => {
  const index = require('../src/solvers/index.js');
  const { computePuzzleDiff } = require('../src/solvers/diff.js');
  assert.equal(index.computePuzzleDiff, computePuzzleDiff);
});
