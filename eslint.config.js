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
  global: 'readonly',
};

const solverClasses = {
  NonogramSolver: 'readonly',
  AquariumSolver: 'readonly',
  GalaxiesSolver: 'readonly',
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
  { ignores: ['node_modules/', 'icons/', 'docs/', 'tests/snapshots/'] },

  // solver.js: pure logic, runs in Node tests + Web Worker + content script.
  // Keep its globals minimal (just JS + `module` for the CommonJS export tail).
  {
    files: ['solver.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { module: 'readonly', console: 'readonly' },
    },
    rules: sharedRules,
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
    files: ['content.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...browserGlobals,
        ...solverClasses,
        chrome: 'readonly',
        // Defined in handler.js, called from content.js.
        getActiveHandler: 'readonly',
        callMainWorld: 'readonly',
      },
    },
    rules: sharedRules,
  },

  // Sibling content script. Defines handler functions used by content.js.
  {
    files: ['handler.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...browserGlobals,
        ...solverClasses,
        chrome: 'readonly',
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
