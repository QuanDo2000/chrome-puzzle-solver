'use strict';

let detectedGrid = null;
let suppressStateWatch = false;

let undoStack = [];
let redoStack = [];
const MAX_UNDO = 50;

// Serializes apply / undo / redo so concurrent invocations (e.g. user clicks
// Undo while the solver is mid-apply) can't interleave their grid reads with
// each other's grid writes. Each operation sets this to its name on entry and
// clears it on exit (try/finally). Other operations bail with a clear error.
let mutatingOp = null;
let mutatingOpTimer = null;
const MUTATING_OP_TIMEOUT_MS = 30000;

// Wrappers so a handler that throws past the try/finally — or a hung Worker
// that never resolves — cannot leave the flag stuck and lock out every
// subsequent action until reload.
function setMutatingOp(name) {
  mutatingOp = name;
  if (mutatingOpTimer) clearTimeout(mutatingOpTimer);
  mutatingOpTimer = setTimeout(() => {
    console.warn(`[puzzle-solver] mutatingOp '${mutatingOp}' stuck >${MUTATING_OP_TIMEOUT_MS}ms; clearing`);
    mutatingOp = null;
    mutatingOpTimer = null;
  }, MUTATING_OP_TIMEOUT_MS);
}

function clearMutatingOp() {
  mutatingOp = null;
  if (mutatingOpTimer) { clearTimeout(mutatingOpTimer); mutatingOpTimer = null; }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    detectedGrid, suppressStateWatch, undoStack, redoStack, MAX_UNDO,
    mutatingOp, mutatingOpTimer, MUTATING_OP_TIMEOUT_MS,
    setMutatingOp, clearMutatingOp,
  };
}
