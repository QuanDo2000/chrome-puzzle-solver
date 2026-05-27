// ESLint 9+ flat config. Each block scopes rules to the execution context the
// file actually runs in (Node tests, content script, MV3 service worker, Web
// Worker, or the page MAIN world), since the globals available in each are
// different.

const js = require('@eslint/js');

const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  localStorage: 'readonly',
  navigator: 'readonly',
  location: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  MutationObserver: 'readonly',
  Worker: 'readonly',
  Blob: 'readonly',
  URL: 'readonly',
  fetch: 'readonly',
  alert: 'readonly',
  Node: 'readonly',
  HTMLElement: 'readonly',
  HTMLCanvasElement: 'readonly',
  Path2D: 'readonly',
  Image: 'readonly',
  Event: 'readonly',
  CustomEvent: 'readonly',
  getComputedStyle: 'readonly',
};

const nodeGlobals = {
  module: 'readonly',
  require: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  global: 'readonly',
};

const solverClasses = {
  NonogramSolver: 'readonly',
  AquariumSolver: 'readonly',
  GalaxiesSolver: 'readonly',
  BinairoSolver: 'readonly',
  ShikakuSolver: 'readonly',
  YinYangSolver: 'readonly',
  SlitherlinkSolver: 'readonly',
  HashiSolver: 'readonly',
  HeyawakeSolver: 'readonly',
  HitoriSolver: 'readonly',
  KakurasuSolver: 'readonly',
  KurodokoSolver: 'readonly',
  MosaicSolver: 'readonly',
  NorinoriSolver: 'readonly',
  NurikabeSolver: 'readonly',
};

// Rules tuned for this codebase. no-redeclare is off because main-world.js
// uses the legacy `for (var i = 0; ...) {} for (var i = 0; ...) {}` pattern
// throughout — function-scoped re-declarations are intentional, not bugs.
// no-unused-vars is a warning because main-world.js exports many functions by
// being read reflectively (globalThis[funcName]) from background.js, so
// "unused" top-level decls are part of the contract.
const sharedRules = {
  ...js.configs.recommended.rules,
  'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  'no-redeclare': 'off',
  'no-empty': ['warn', { allowEmptyCatch: true }],
  'no-constant-condition': ['warn', { checkLoops: false }],
};

module.exports = [
  { ignores: ['node_modules/', 'icons/', 'docs/', 'dist/'] },

  // solver.js: pure logic, runs in Node tests + Web Worker + content script.
  // Keep its globals minimal (just JS + `module` for the CommonJS export tail).
  // Stricter rules here than the rest of the codebase: solver.js is the
  // perf-critical heart, contributors should stick to === / let / const.
  // main-world.js legitimately needs `var` for legacy compat with the host
  // page's expectations, so we DON'T enforce these globally.
  {
    // Includes:
    //   - Root solver.js shim (CommonJS require → src/solvers/index.js).
    //   - src/solvers/*.js — per-puzzle source files (module.exports each).
    //   - src/solvers/index.js — CommonJS aggregator (require + module).
    //   - scripts/*.js — Node-only build scripts.
    files: ['solver.js', 'src/solvers/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        module: 'readonly', require: 'readonly', console: 'readonly',
        __dirname: 'readonly', __filename: 'readonly', process: 'readonly',
      },
    },
    rules: {
      ...sharedRules,
      'eqeqeq': ['error', 'always'],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
    },
  },

  // Web Worker context. Solver classes loaded via importScripts at runtime;
  // in dev/test the file is fetched as text and stripped — see content.js
  // getSolverWorker().
  {
    files: ['solver.worker.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        self: 'readonly',
        importScripts: 'readonly',
        postMessage: 'readonly',
        onmessage: 'writable',
        console: 'readonly',
        ...solverClasses,
      },
    },
    rules: sharedRules,
  },

  // MV3 service worker.
  {
    files: ['background.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        chrome: 'readonly',
        self: 'readonly',
        globalThis: 'readonly',
        importScripts: 'readonly',
        console: 'readonly',
      },
    },
    rules: sharedRules,
  },

  // Content script: defines functions used internally + by handler.js
  // siblings (which are loaded together via manifest.content_scripts).
  {
    // Includes content.js itself and the per-concern source files under
    // src/widget/ that get concatenated into dist/content.js by the
    // build script. Each file references symbols defined in sibling
    // files via the bundle's flat scope.
    files: ['content.js', 'src/widget/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...browserGlobals,
        ...solverClasses,
        chrome: 'readonly',
        module: 'readonly',
        require: 'readonly',
        // Defined in handler.js, called from content.js.
        getActiveHandler: 'readonly',
        callMainWorld: 'readonly',
        // Defined in solver.js, called from content.js.
        computePuzzleDiff: 'readonly',
        // Defined in src/widget/state.js; visible across all
        // src/widget/*.js + content.js after bundle concatenation.
        detectedGrid: 'writable',
        suppressStateWatch: 'writable',
        undoStack: 'writable',
        redoStack: 'writable',
        MAX_UNDO: 'readonly',
        mutatingOp: 'writable',
        mutatingOpTimer: 'writable',
        MUTATING_OP_TIMEOUT_MS: 'readonly',
        setMutatingOp: 'readonly',
        clearMutatingOp: 'readonly',
        // src/widget/worker.js
        solverWorker: 'writable',
        solverWorkerInit: 'writable',
        solverNextId: 'writable',
        solverPending: 'readonly',
        getSolverWorker: 'readonly',
        runSolve: 'readonly',
        // src/widget/cache.js
        SOLUTION_TTL_MS: 'readonly',
        SOLUTION_CACHE_MAX: 'readonly',
        SOLUTION_KEY_PREFIXES: 'readonly',
        isSolutionCacheKey: 'readonly',
        pruneSolutionCache: 'readonly',
        isFreshSolutionEntry: 'readonly',
        galaxiesCacheKey: 'readonly',
        galaxiesPartialKey: 'readonly',
        galaxiesFailedKey: 'readonly',
        getCachedGalaxiesSolution: 'readonly',
        cacheGalaxiesSolution: 'readonly',
        slitherlinkCacheKey: 'readonly',
        getCachedGridSolution: 'readonly',
        cacheGridSolution: 'readonly',
        puzzlePartialKey: 'readonly',
        getCachedPartial: 'readonly',
        cachePartial: 'readonly',
        clearPartial: 'readonly',
        countKnownCells: 'readonly',
        chooseInitialGrid: 'readonly',
        getCachedGalaxiesPartial: 'readonly',
        getFailedGalaxiesPartials: 'readonly',
        cacheFailedGalaxiesPartial: 'readonly',
        clearFailedGalaxiesPartials: 'readonly',
        // src/widget/galaxies-hint.js
        cloneGalaxiesLines: 'readonly',
        getGalaxiesHint: 'readonly',
        getGalaxyPath: 'readonly',
        nextGalaxyHint: 'readonly',
        firstGalaxiesMismatch: 'readonly',
        buildGalaxiesSeedOwner: 'readonly',
        getGalaxiesComponents: 'readonly',
        galaxyCellCanBelong: 'readonly',
        possibleGalaxiesNodesForCell: 'readonly',
        computeReachableStars: 'readonly',
        intersectSets: 'readonly',
        narrowByMirrorComponent: 'readonly',
        propagateForcedCells: 'readonly',
        setsIntersect: 'readonly',
        buildComponentAdjacency: 'readonly',
        propagateAllConstraints: 'readonly',
        bfsComponentSide: 'readonly',
        intersectBitset: 'readonly',
        findEmptyCompHints: 'readonly',
        getGalaxiesNodeRegions: 'readonly',
        // src/widget/hint.js
        firstMismatch: 'readonly',
        getAquariumPath: 'readonly',
        getNonogramPath: 'readonly',
        hintFromCellChunk: 'readonly',
        nextChunkHint: 'readonly',
        hintAbsoluteCells: 'readonly',
        applyHintToGrid: 'readonly',
        addAquariumRegionHints: 'readonly',
        // src/widget/preview.js
        hintIdCounter: 'writable',
        hintIdCache: 'readonly',
        hintSig: 'readonly',
        FNV_OFFSET: 'readonly',
        FNV_PRIME: 'readonly',
        regionMapSig: 'readonly',
        slitherlinkCluesSig: 'readonly',
        gridDataSig: 'readonly',
        buildLatticeLayer: 'readonly',
        buildStaticLayer: 'readonly',
        drawHeyawakeRoomsOn: 'readonly',
        drawRegionBordersOn: 'readonly',
        renderPreview: 'readonly',
        latticeLayer: 'writable',
        staticLayer: 'writable',
        staticLayerSig: 'writable',
        lastDrawSig: 'writable',
        previewWrap: 'writable',
        // src/widget/widget.js
        makeWidget: 'readonly',
        widgetExpandFn: 'writable',
        hashiDoneCheck: 'readonly',
        // src/widget/puzzles/index.js
        PUZZLES: 'readonly',
        // src/widget/puzzles/nonogram.js — bundle-scope const consumed
        // by puzzles/index.js when assembling the registry.
        nonogram: 'readonly',
        // src/widget/puzzles/binairo.js — bundle-scope const consumed
        // by puzzles/index.js when assembling the registry.
        binairo: 'readonly',
        // src/widget/puzzles/hitori.js — bundle-scope const consumed
        // by puzzles/index.js when assembling the registry.
        hitori: 'readonly',
        // src/widget/puzzles/kakurasu.js — bundle-scope const consumed
        // by puzzles/index.js when assembling the registry.
        kakurasu: 'readonly',
        // src/widget/puzzles/kurodoko.js — bundle-scope const consumed
        // by puzzles/index.js when assembling the registry.
        kurodoko: 'readonly',
        // src/widget/puzzles/mosaic.js — bundle-scope const consumed
        // by puzzles/index.js when assembling the registry.
        mosaic: 'readonly',
        // src/widget/puzzles/norinori.js — bundle-scope const consumed
        // by puzzles/index.js when assembling the registry.
        norinori: 'readonly',
        // src/widget/puzzles/nurikabe.js — bundle-scope const consumed
        // by puzzles/index.js when assembling the registry.
        nurikabe: 'readonly',
        // src/widget/puzzles/heyawake.js — bundle-scope const consumed
        // by puzzles/index.js when assembling the registry.
        heyawake: 'readonly',
        // src/widget/puzzles/yinyang.js — bundle-scope const consumed
        // by puzzles/index.js when assembling the registry.
        yinyang: 'readonly',
        // src/widget/puzzles/aquarium.js — bundle-scope const consumed
        // by puzzles/index.js when assembling the registry.
        aquarium: 'readonly',
        // src/widget/puzzles/shikaku.js — bundle-scope const consumed
        // by puzzles/index.js when assembling the registry.
        shikaku: 'readonly',
        // src/widget/puzzles/hashi.js — bundle-scope const consumed
        // by puzzles/index.js when assembling the registry.
        hashi: 'readonly',
        // content.js top-level (consumed by src/widget/widget.js)
        loadWidgetPref: 'readonly',
        saveWidgetPref: 'readonly',
        SUPPORTED_PUZZLES: 'readonly',
        solveExtraData: 'readonly',
        detectPuzzle: 'readonly',
        readGridState: 'readonly',
        applySolution: 'readonly',
        getHint: 'readonly',
        handleHistory: 'readonly',
      },
    },
    rules: sharedRules,
  },

  // Sibling content script. Defines handler functions used by content.js.
  // Also exports its pure parsers via a CommonJS tail for tests, hence `module`.
  {
    files: ['handler.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...browserGlobals,
        ...solverClasses,
        chrome: 'readonly',
        module: 'readonly',
      },
    },
    rules: sharedRules,
  },

  // Page MAIN world: functions get serialized via fn.toString() and injected
  // into the page, so they see the page's globals (window.Game, etc.).
  {
    files: ['main-world.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...browserGlobals, globalThis: 'readonly' },
    },
    rules: sharedRules,
  },

  // Node tests + benches.
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: nodeGlobals,
    },
    rules: sharedRules,
  },
];
