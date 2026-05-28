'use strict';

// Top-level chrome.runtime.onMessage listener and DOM-ready bootstrap.
//
// Both used to live at the top/bottom of content.js. They're factored
// out into their own file (and concatenated LAST by the bundler) so the
// listener and bootstrap reach all upstream functions — detectPuzzle,
// readGridState, applySolution, runSolve, getHint, handleHistory,
// widgetExpandFn, makeWidget, getActiveHandler — without forward-
// reference order hazards.
//
// The bootstrap runs SYNCHRONOUSLY when document.readyState !== 'loading',
// which is the common case for MV3 content scripts injected at
// document_idle. Putting it at the bundle's tail guarantees every symbol
// it touches (and every symbol every later-called callback touches) is
// already defined.

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.action) {
    case 'detect':
      detectPuzzle().then(sendResponse).catch(() => sendResponse({ found: false, error: 'Detection failed' }));
      return true;
    case 'readState':
      readGridState().then(sendResponse).catch(() => sendResponse({ success: false, error: 'State read failed' }));
      return true;
    case 'solve':
      runSolve(request.rowClues, request.colClues, request.initialGrid,
        request.solverType, request.extraData)
        .then(sendResponse)
        .catch((e) => sendResponse({ solved: false, grid: null, error: e.message }));
      return true;
    case 'applySolution':
      applySolution(request.solution).then(sendResponse).catch(() => sendResponse({ success: false, error: 'Apply failed' }));
      return true;
    case 'hint':
      getHint(request).then(sendResponse).catch(() => sendResponse({ success: false, error: 'Hint failed' }));
      return true;
    case 'undo':
    case 'redo':
      handleHistory(request.action).then(sendResponse).catch(() => sendResponse({ success: false, error: `${request.action[0].toUpperCase()}${request.action.slice(1)} failed` }));
      return true;
    case 'getUndoRedoState':
      sendResponse({ undoCount: undoStack.length, redoCount: redoStack.length });
      break;
    case 'expandWidget':
      widgetExpandFn?.(true);
      sendResponse({ ok: !!widgetExpandFn });
      break;
  }
  return true;
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    if (getActiveHandler()) makeWidget();
  });
} else {
  if (getActiveHandler()) makeWidget();
}
