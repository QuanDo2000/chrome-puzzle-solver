// Regression test for getGalaxiesHint and its helpers (propagateAllConstraints,
// findEmptyCompHints, etc.) Lives in content.js with no Node-side CommonJS
// export, so this test loads content.js + handler.js + solver.js into a vm
// context with browser-API stubs, then walks the auto-loop hint chain and
// verifies every suggested line is present in the full solver's ground-truth
// solution.
//
// Pre-fix (a4e774b4 fix(galaxies-hint): …), step ~95 on the 30x30 monthly
// produced 21 lineHints with 19 lines NOT in ground truth — driven by the
// maxTarget-as-upper-bound bug in propagateAllConstraints + the 'aBits ||
// bBits' acceptance in findEmptyCompHints. This test catches a regression of
// either.

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const { GalaxiesSolver } = require('../solver.js');
const fixtures = require('./fixtures/real-puzzles.js');

const REPO = path.join(__dirname, '..');

// Browser stubs sufficient to evaluate content.js's top-level statements
// without throwing. content.js calls chrome.runtime.onMessage.addListener at
// module load and the bottom `if (document.readyState === ...)` block also
// runs; both must be no-ops here. None of the puzzle logic touches the DOM,
// so once loaded, getGalaxiesHint is callable directly.
function makeBrowserContext() {
  const stub = () => undefined;
  const stubObserver = () => ({ observe: stub, disconnect: stub, takeRecords: () => [] });
  return {
    document: {
      readyState: 'complete',
      addEventListener: stub,
      removeEventListener: stub,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({
        style: {},
        classList: { add: stub, remove: stub, toggle: stub },
        appendChild: stub,
        addEventListener: stub,
        setAttribute: stub,
        dataset: {},
      }),
      getElementById: () => null,
      body: { appendChild: stub },
      head: { appendChild: stub },
      createTextNode: (s) => ({ nodeValue: s }),
    },
    window: {
      location: { hostname: 'localhost', pathname: '/galaxies/' },
      addEventListener: stub,
      removeEventListener: stub,
    },
    chrome: {
      runtime: { id: 'test', onMessage: { addListener: stub }, sendMessage: stub },
    },
    Worker: function () { return { postMessage: stub, terminate: stub, addEventListener: stub }; },
    Blob: function () {},
    URL: { createObjectURL: () => '', revokeObjectURL: stub },
    MutationObserver: stubObserver,
    HTMLElement: function () {},
    HTMLCanvasElement: function () {},
    Path2D: function () {},
    Image: function () {},
    Event: function () {},
    CustomEvent: function () {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: stub,
    fetch: () => Promise.reject(new Error('fetch stub')),
    alert: stub,
    navigator: { clipboard: { writeText: stub } },
    getComputedStyle: () => ({}),
    localStorage: { getItem: () => null, setItem: stub, removeItem: stub },
    Node: function () {},
    console,
  };
}

function loadWidgetSources() {
  const ctx = makeBrowserContext();
  ctx.globalThis = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  // Solver source files
  const solverDir = path.join(REPO, 'src', 'solvers');
  const solverFiles = fs.readdirSync(solverDir)
    .filter(f => f.endsWith('.js') && f !== 'index.js')
    .map(f => path.join(solverDir, f));
  for (const fullPath of solverFiles) {
    vm.runInContext(fs.readFileSync(fullPath, 'utf8'), ctx,
      { filename: path.basename(fullPath) });
  }
  // Widget source files (extracted by Phase 1 / Phase 2 of the
  // content.js split). Order matches the bundler.
  const widgetDir = path.join(REPO, 'src', 'widget');
  const widgetOrder = ['state.js', 'worker.js', 'cache.js',
                        'galaxies-hint.js', 'hint.js', 'preview.js',
                        'widget.js',
                        'puzzles/nonogram.js',
                        'puzzles/binairo.js',
                        'puzzles/hitori.js',
                        'puzzles/kakurasu.js',
                        'puzzles/kurodoko.js',
                        'puzzles/mosaic.js',
                        'puzzles/norinori.js',
                        'puzzles/nurikabe.js',
                        'puzzles/heyawake.js',
                        'puzzles/yinyang.js',
                        'puzzles/index.js'];
  for (const f of widgetOrder) {
    const fp = path.join(widgetDir, f);
    if (!fs.existsSync(fp)) continue;
    vm.runInContext(fs.readFileSync(fp, 'utf8'), ctx, { filename: f });
  }
  for (const file of ['handler.js', 'content.js']) {
    vm.runInContext(fs.readFileSync(path.join(REPO, file), 'utf8'), ctx,
      { filename: file });
  }
  return ctx;
}

// Mirror of main-world.js readGalaxiesState's BFS: each cell gets a region id
// derived from the line-bounded BFS group it belongs to. content.js's
// getGalaxiesHint reads cells through this region grid, so the simulation has
// to compute it the same way.
function gridFromLines(rows, cols, lines) {
  const grid = Array.from({ length: rows }, () => Array(cols).fill(0));
  let id = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (grid[r][c]) continue;
      id++;
      const q = [{ row: r, col: c }];
      grid[r][c] = id;
      for (let qi = 0; qi < q.length; qi++) {
        const { row, col } = q[qi];
        const neighbors = [
          { r: row - 1, c: col, blocked: lines.horizontal[row]?.[col] === 1 },
          { r: row + 1, c: col, blocked: lines.horizontal[row + 1]?.[col] === 1 },
          { r: row, c: col - 1, blocked: lines.vertical[row]?.[col] === 1 },
          { r: row, c: col + 1, blocked: lines.vertical[row]?.[col + 1] === 1 },
        ];
        for (const n of neighbors) {
          if (n.blocked || n.r < 0 || n.c < 0 || n.r >= rows || n.c >= cols || grid[n.r][n.c]) continue;
          grid[n.r][n.c] = id;
          q.push({ row: n.r, col: n.c });
        }
      }
    }
  }
  grid.galaxies = lines;
  return grid;
}

function emptyLines(rows, cols) {
  return {
    horizontal: Array.from({ length: rows + 1 }, () => Array(cols).fill(0)),
    vertical: Array.from({ length: rows }, () => Array(cols + 1).fill(0)),
  };
}

test('getGalaxiesHint loop never suggests a line absent from the solver ground truth (30x30 monthly)', () => {
  const fixture = fixtures.galaxies_30x30_monthly;
  const { rows, cols, stars } = fixture;

  // Ground truth.
  GalaxiesSolver.clearSolutionCache();
  const truthResult = new GalaxiesSolver(stars, rows, cols).solve();
  assert.equal(truthResult?.solved, true, 'precondition: solver must solve the monthly puzzle');
  const truthLines = truthResult.grid.galaxies;

  // Widget hint algorithm in a vm.
  const ctx = loadWidgetSources();
  assert.equal(typeof ctx.getGalaxiesHint, 'function', 'getGalaxiesHint must be loaded into the vm context');

  // Walk the auto-apply loop. The heuristic is allowed to give up (return null)
  // before fully solving — what it must NOT do is suggest a line not in ground
  // truth. maxSteps is an upper bound; on a healthy heuristic the loop
  // terminates well before this on either a full solve or a graceful give-up.
  let current = emptyLines(rows, cols);
  const maxSteps = 200;
  for (let step = 1; step <= maxSteps; step++) {
    const grid = gridFromLines(rows, cols, current);
    const hint = ctx.getGalaxiesHint(grid, stars);
    if (!hint) return; // heuristic gave up — acceptable on hard puzzles
    assert.ok(!hint.error, `step ${step}: hint returned error: ${hint.error}`);
    assert.ok(hint.lineHints?.length, `step ${step}: hint has no lineHints`);

    for (const lh of hint.lineHints) {
      const truthVal = truthLines[lh.orientation]?.[lh.row]?.[lh.col];
      assert.equal(
        truthVal, 1,
        `step ${step}: hint suggests ${lh.orientation} r=${lh.row} c=${lh.col} but ground truth has no line there`,
      );
    }
    current = hint.lines;
  }
  assert.fail(`loop ran ${maxSteps} steps without terminating — heuristic is looping or progressing too slowly to be useful`);
});
