'use strict';

// Cross-puzzle dispatch glue between the per-puzzle registry (PUZZLES /
// handler.js) and the widget's user-facing actions. These functions used
// to live at the top of content.js; they're factored out so the listener
// (src/widget/listener.js) and the widget shell (src/widget/widget.js)
// can call them by name without reaching into a single mega-file.
//
// Bundle order: this file is concatenated AFTER state.js (for detectedGrid
// / undoStack / mutatingOp helpers) and AFTER puzzles/index.js (for the
// PUZZLES registry — solveExtraData consults it). It does NOT depend on
// hint.js (getHint lives in hint.js and references handlers.js, not the
// reverse).

async function detectPuzzle() {
  const handler = getActiveHandler();
  if (!handler) return { found: false, error: 'No handler available for this page' };
  const result = await handler.detect();
  if (result && result.found) detectedGrid = result;
  return result;
}

async function readGridState() {
  if (!detectedGrid) {
    const d = await detectPuzzle();
    if (!d.found) return { success: false, error: d.error || 'No puzzle detected' };
  }
  const handler = getActiveHandler();
  if (!handler) return { success: false, error: 'No handler available' };
  const grid = await handler.readState(detectedGrid);
  if (grid) return { success: true, grid, rows: detectedGrid.rows, cols: detectedGrid.cols };
  return { success: false, error: 'Cannot read grid state' };
}

// `internal=true` is set by undo/redo, which already own the mutex; skipping
// the acquire/release here lets the nested apply run without the caller having
// to drop the mutex (which previously opened a race window for a fresh click).
async function applySolution(solution, skipUndo = false, internal = false) {
  if (!internal) {
    if (mutatingOp) {
      return { success: false, error: `Busy (${mutatingOp}); try again in a moment` };
    }
    setMutatingOp('apply');
  }
  try {
    if (!detectedGrid) {
      const d = await detectPuzzle();
      if (!d.found) return { success: false, error: 'No puzzle detected' };
    }
    if (!skipUndo) {
      const currentState = await readGridState();
      if (currentState?.success) {
        undoStack.push(currentState.grid);
        if (undoStack.length > MAX_UNDO) undoStack.shift();
        redoStack = [];
      }
    }
    const handler = getActiveHandler();
    if (!handler) return { success: false, error: 'No handler for this page' };
    suppressStateWatch = true;
    let handlerResult;
    try {
      handlerResult = await handler.applySolution(solution, detectedGrid);
    } finally {
      suppressStateWatch = false;
    }
    // Backwards-compat: an older handler that still returns true (or nothing)
    // is treated as success — but the three handlers in this repo now all
    // return { success, error? }.
    if (handlerResult === true || handlerResult == null) return { success: true };
    return handlerResult;
  } finally {
    if (!internal) clearMutatingOp();
  }
}

// Per-puzzle "extra payload" passed to the solver worker. Registry-first:
// each puzzles/<type>.js exposes a `solveExtraData(detectedGrid)` hook that
// returns whatever the type's solver needs (e.g. binairo's comparison
// clues, aquarium's region map). Returns null if no registry entry or no
// active grid.
function solveExtraData() {
  const data = detectedGrid;
  if (!data) return null;
  const reg = (typeof PUZZLES !== 'undefined' && PUZZLES) ? PUZZLES[data?.type] : null;
  if (reg?.solveExtraData) return reg.solveExtraData(data);
  return null;
}

async function handleHistory(direction) {
  const fromStack = direction === 'undo' ? undoStack : redoStack;
  const toStack = direction === 'undo' ? redoStack : undoStack;
  if (mutatingOp) {
    return { success: false, error: `Busy (${mutatingOp}); try again in a moment` };
  }
  if (fromStack.length === 0) return { success: false, error: `Nothing to ${direction}` };
  setMutatingOp(direction);
  try {
    const currentState = await readGridState();
    if (!currentState?.success) return { success: false, error: 'Cannot read current state' };
    toStack.push(currentState.grid);
    const nextState = fromStack.pop();
    await applySolution(nextState, true, true);
    return { success: true, grid: nextState, undoCount: undoStack.length, redoCount: redoStack.length };
  } finally {
    clearMutatingOp();
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    detectPuzzle, readGridState, applySolution, solveExtraData, handleHistory,
  };
}
