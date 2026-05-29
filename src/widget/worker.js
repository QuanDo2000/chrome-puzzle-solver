'use strict';

let solverWorker = null;
let solverWorkerInit = null;
let solverNextId = 1;
const solverPending = new Map();

// Chrome MV3 content scripts run in the host page's origin (puzzles-mobile.com),
// not the extension's. `new Worker('chrome-extension://...')` is blocked as
// cross-origin even when the resource is web-accessible. Workaround: fetch the
// script text and load it via a Blob URL, which inherits the page's origin.
// The worker's `importScripts('solver.js')` would hit the same cross-origin
// wall, so we inline solver.js into the blob ahead of the worker entry point.
function getSolverWorker() {
  if (solverWorker) return Promise.resolve(solverWorker);
  if (solverWorkerInit) return solverWorkerInit;
  solverWorkerInit = (async () => {
    const [solverSrc, workerSrc] = await Promise.all([
      fetch(chrome.runtime.getURL('solver.js')).then(r => r.text()),
      fetch(chrome.runtime.getURL('solver.worker.js')).then(r => r.text()),
    ]);
    // Strip the importScripts line; solver.js is now inlined above it. The
    // pattern tolerates whitespace before `(` and before `;`. If it fails to
    // match, the importScripts call survives into the blob and re-declares
    // every solver class (since solverSrc is already prepended), so the worker
    // dies with a SyntaxError. Warn loudly rather than ship a silently broken
    // worker — mirrors build-solver-bundle.js's fail-on-no-strip stance.
    const importScriptsRe = /^\s*importScripts\s*\([^)]*\)\s*;?\s*$/m;
    const workerEntry = workerSrc.replace(importScriptsRe, '');
    if (workerEntry === workerSrc) {
      console.warn('[puzzle-solver] solver.worker.js: no importScripts line found to strip; worker may fail to load solver.js');
    }
    const blob = new Blob([solverSrc + '\n' + workerEntry], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const w = new Worker(url);
    // The Worker keeps its own internal reference to the script; the blob URL
    // is only needed for construction. Revoke immediately so the Blob can be
    // collected — otherwise it leaks per worker spawn (one per onerror restart).
    URL.revokeObjectURL(url);
    w.onmessage = (e) => {
      const { id, result } = e.data || {};
      const pending = solverPending.get(id);
      if (!pending) return;
      solverPending.delete(id);
      if (result && result.stack) {
        console.error(`[puzzle-solver] worker reported ${result.errorName || 'error'}: ${result.error}\n${result.stack}`);
      }
      pending.resolve(result);
    };
    w.onerror = (err) => {
      // ErrorEvent carries filename/lineno/colno but not a JS stack — log the
      // whole event so DevTools shows the trace, and surface a useful summary.
      console.error('[puzzle-solver] worker onerror:', err);
      const where = err.filename ? ` (${err.filename}:${err.lineno}:${err.colno})` : '';
      const summary = (err.message || 'worker error') + where;
      for (const pending of solverPending.values()) {
        pending.resolve({ solved: false, grid: null, error: summary });
      }
      solverPending.clear();
      try { w.terminate(); } catch {}
      solverWorker = null;
      solverWorkerInit = null;
    };
    solverWorker = w;
    return w;
  })().catch((e) => {
    solverWorkerInit = null;
    throw e;
  });
  return solverWorkerInit;
}

function runSolve(rowClues, colClues, initialGrid, solverType, extraData) {
  return new Promise((resolve) => {
    const id = solverNextId++;
    solverPending.set(id, { resolve });
    getSolverWorker()
      .then((w) => w.postMessage({
        id, type: solverType, rowClues, colClues, initialGrid, extraData,
      }))
      .catch((e) => {
        console.error('[puzzle-solver] worker init/post failed:', e);
        solverPending.delete(id);
        resolve({ solved: false, grid: null, error: (e && e.message) || String(e) });
      });
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    solverWorker, solverWorkerInit, solverNextId, solverPending,
    getSolverWorker, runSolve,
  };
}
