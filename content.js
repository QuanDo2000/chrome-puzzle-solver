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
    case 'clickCell':
      clickCell(request.row, request.col, request.state).then(sendResponse).catch(() => sendResponse({ success: false, error: 'Click failed' }));
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

function solveExtraData() {
  const data = detectedGrid;
  if (!data) return null;
  const reg = (typeof PUZZLES !== 'undefined' && PUZZLES) ? PUZZLES[data?.type] : null;
  if (reg?.solveExtraData) return reg.solveExtraData(data);
  return null;
}

async function getHint(request = {}) {
  try {
    if (!detectedGrid) {
      const d = await detectPuzzle();
      if (!d.found) return { success: false, error: 'No puzzle detected' };
    }
    const { rows, cols, rowClues, colClues } = detectedGrid;
    const handler = getActiveHandler();
    const grid = handler ? await handler.readState(detectedGrid) : null;
    if (!grid) return { success: false, error: 'Cannot read grid state' };
    const solution = request.solution || null;
    let hintSolution = solution;
    let hint = null;
    // Per-puzzle hintDispatch (Stage D Task 7). Migrated modules return the
    // full {success, hint, grid, solution} shape and bypass the inline chain
    // below entirely. Unmigrated puzzles fall through.
    const reg = (typeof PUZZLES !== 'undefined' && PUZZLES) ? PUZZLES[detectedGrid.type] : null;
    if (reg?.hintDispatch) {
      const ctx = {
        detectedGrid, grid, solution, hintSolution,
        rows, cols, rowClues, colClues,
        firstMismatch, firstGalaxiesMismatch,
        getCachedGridSolution, cacheGridSolution,
        getCachedGalaxiesSolution, cacheGalaxiesSolution,
        runSolve, callMainWorld, solveExtraData,
        nextChunkHint, nextGalaxyHint, getGalaxiesHint,
        getAquariumPath, getNonogramPath,
        addAquariumRegionHints,
      };
      return await reg.hintDispatch(ctx);
    }
    // Nonogram fallback (unmigrated by Stage D Task 7 — task spec keeps
    // nonogram on this generic cell-state path since its hints work via
    // the solution-grid path rather than an inline solver call).
    if (solution && firstMismatch(grid, solution)) {
      return { success: false, error: 'Current game state is wrong.' };
    }
    const solver = new NonogramSolver(rowClues, colClues);
    hint = solver.getHint(grid);
    // Same fallback pattern for nonogram: if the per-line solveLine
    // narrowing dries up, fall back to the cached / freshly-solved
    // solution and emit one row at a time. The 50x50 monthly finishes
    // via the heuristic alone, but harder puzzles can stall.
    if (!hint) {
      let sol = hintSolution || getCachedGridSolution(detectedGrid);
      if (!sol) {
        const result = await runSolve(rowClues, colClues, grid, 'nonogram', solveExtraData());
        if (result?.solved && result.grid) {
          cacheGridSolution(detectedGrid, result.grid);
          sol = result.grid;
        }
      }
      if (sol) {
        if (firstMismatch(grid, sol)) {
          return { success: false, error: 'Current game state is wrong.' };
        }
        hintSolution = sol;
        hint = nextChunkHint(grid, getNonogramPath(sol));
      }
    }
    if (!hint) return { success: false, error: 'No hint available' };
    return { success: true, hint, grid, solution: hintSolution };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function clickCell(row, col, _state) {
  if (!detectedGrid) {
    await detectPuzzle();
  }
  if (!detectedGrid) return { success: false, error: 'No puzzle detected' };
  const { _cells: cells, cols } = detectedGrid;
  const idx = row * cols + col;
  if (idx >= cells.length) return { success: false, error: 'Cell out of range' };
  cells[idx].click();
  return { success: true };
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

// ── Floating widget ──────────────────────────────────────────

const WIDGET_STORAGE_KEY = 'ns_widget_state';

// Puzzle types the widget knows how to solve. Used by the "no puzzle here"
// status to point users at a sample URL for each supported type.
const SUPPORTED_PUZZLES = [
  { name: 'Aquarium',     url: 'https://www.puzzles-mobile.com/aquarium/' },
  { name: 'Binairo',      url: 'https://www.puzzles-mobile.com/binairo/' },
  { name: 'Binairo Plus', url: 'https://www.puzzles-mobile.com/binairo-plus/' },
  { name: 'Galaxies',     url: 'https://www.puzzles-mobile.com/galaxies/' },
  { name: 'Hashi',        url: 'https://www.puzzles-mobile.com/hashi/' },
  { name: 'Heyawake',    url: 'https://www.puzzles-mobile.com/heyawake/' },
  { name: 'Hitori',       url: 'https://www.puzzles-mobile.com/hitori/' },
  { name: 'Kakurasu',     url: 'https://www.puzzles-mobile.com/kakurasu/' },
  { name: 'Kurodoko',     url: 'https://www.puzzles-mobile.com/kurodoko/' },
  { name: 'Mosaic',       url: 'https://www.puzzles-mobile.com/mosaic/' },
  { name: 'Norinori',     url: 'https://www.puzzles-mobile.com/norinori/' },
  { name: 'Nurikabe',     url: 'https://www.puzzles-mobile.com/nurikabe/' },
  { name: 'Nonogram',     url: 'https://www.puzzles-mobile.com/nonograms/' },
  { name: 'Shikaku',      url: 'https://www.puzzles-mobile.com/shikaku/' },
  { name: 'Slitherlink',  url: 'https://www.puzzles-mobile.com/loop/' },
  { name: 'Yin-Yang',     url: 'https://www.puzzles-mobile.com/yin-yang/' },
];

function loadWidgetPref() {
  try {
    const v = localStorage.getItem(WIDGET_STORAGE_KEY);
    return v ? JSON.parse(v) : {};
  } catch { return {}; }
}

function saveWidgetPref(pref) {
  try { localStorage.setItem(WIDGET_STORAGE_KEY, JSON.stringify(pref)); } catch {}
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    if (getActiveHandler()) makeWidget();
  });
} else {
  if (getActiveHandler()) makeWidget();
}
