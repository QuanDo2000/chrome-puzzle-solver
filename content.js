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
  if (data.type === 'shikaku') {
    return {
      rows: data.rows,
      cols: data.cols,
      clues: data.clues,
    };
  }
  if (data.type === 'hashi') {
    return {
      rows: data.rows,
      cols: data.cols,
      islands: data.islands,
    };
  }
  if (data.type === 'yinyang') {
    return {
      rows: data.rows,
      cols: data.cols,
      task: data.task,
    };
  }
  if (data.type === 'slitherlink') {
    return {
      rows: data.rows,
      cols: data.cols,
      task: data.task,
    };
  }
  if (data.type === 'aquarium') {
    return {
      rowCluesFlat: data.rowClues, colCluesFlat: data.colClues,
      regionMap: data.regionMap, rows: data.rows, cols: data.cols,
    };
  }
  if (data.type === 'galaxies') {
    return {
      stars: data.stars,
      rows: data.rows,
      cols: data.cols,
      partialGrid: getCachedGalaxiesPartial(data),
      failedPartials: getFailedGalaxiesPartials(data),
    };
  }
  if (data.type === 'heyawake') {
    return {
      rows: data.rows,
      cols: data.cols,
      rooms: data.rooms,
    };
  }
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
    if (detectedGrid.type === 'galaxies') {
      if (solution && firstGalaxiesMismatch(grid, solution)) {
        return { success: false, error: 'Current game state is wrong.' };
      }
      hint = getGalaxiesHint(grid, detectedGrid.stars);
      if (hint?.error) return { success: false, error: hint.error };
      // Solver fallback when the heuristic exhausts. Walks a per-galaxy
      // path built from the solver's ground-truth solution: each call emits
      // exactly one galaxy's worth of remaining boundary lines (smallest
      // first), so the loop keeps progressing one galaxy at a time instead
      // of dumping every remaining line at once.
      if (!hint) {
        let sol = hintSolution || getCachedGalaxiesSolution(detectedGrid);
        if (!sol) {
          const result = await runSolve(null, null, null, 'galaxies', solveExtraData());
          if (result?.solved && result.grid) {
            cacheGalaxiesSolution(detectedGrid, result.grid);
            sol = result.grid;
          }
        }
        if (sol) {
          if (firstGalaxiesMismatch(grid, sol)) {
            return { success: false, error: 'Current game state is wrong.' };
          }
          hintSolution = sol;
          hint = nextGalaxyHint(grid, sol);
        }
      }
    } else if (detectedGrid.type === 'aquarium') {
      if (solution && firstMismatch(grid, solution)) {
        return { success: false, error: 'Current game state is wrong.' };
      }
      const solver = new AquariumSolver(rowClues, colClues, detectedGrid.regionMap, rows, cols);
      hint = solver.getHint(grid);
      // Solver fallback when AquariumSolver.getHint exhausts. The aquarium
      // heuristic is purely per-line — on the 30x30 monthly it produces one
      // hint and then stalls with 98% of cells still empty. Use the full
      // solver via localStorage cache → in-memory cache → fresh solve, and
      // emit one region per Hint (smallest first) via the cached path.
      if (!hint) {
        let sol = hintSolution || getCachedGridSolution(detectedGrid);
        if (!sol) {
          const result = await runSolve(rowClues, colClues, grid, 'aquarium', solveExtraData());
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
          hint = nextChunkHint(grid, getAquariumPath(sol, detectedGrid.regionMap));
        }
      }
    } else if (detectedGrid.type === 'binairo') {
      if (solution && firstMismatch(grid, solution)) {
        return { success: false, error: 'Current game state is wrong.' };
      }
      const solver = new BinairoSolver({
        rows, cols, givens: detectedGrid.givens, initialState: grid,
        comparisonClues: detectedGrid.comparisonClues || [],
      });
      hint = solver.getHint(grid);
      // No solve-fallback for binairo: hint is pure deduction by design.
      // When propagation exhausts, the user clicks Solve (which does
      // backtracking) — keeping Hint logic-only avoids minute-long hangs
      // on 30x30 puzzles where backtracking is required.
      if (!hint) {
        return { success: false, error: 'No more cells can be deduced from the current state. Click Solve to finish.' };
      }
    } else if (detectedGrid.type === 'yinyang') {
      if (solution && firstMismatch(grid, solution)) {
        return { success: false, error: 'Current game state is wrong.' };
      }
      const solver = new YinYangSolver({
        rows, cols, task: detectedGrid.task, initialState: grid,
      });
      hint = solver.getHint(grid);
      // Pure deduction by design — no solve fallback. When propagation
      // exhausts, the user clicks Solve (which backtracks).
      if (!hint) {
        return { success: false, error: 'No more cells can be deduced from the current state. Click Solve to finish.' };
      }
    } else if (detectedGrid.type === 'slitherlink') {
      // Re-read edge state. The grid we have is the cell-flood-fill grid
      // produced by readGridState for displays, but slitherlink's solver
      // needs the raw H/V edge arrays.
      const edgeState = await callMainWorld('readSlitherlinkState', [rows, cols]);
      const curH = edgeState?.horizontal
        || Array.from({ length: rows + 1 }, () => new Array(cols).fill(0));
      const curV = edgeState?.vertical
        || Array.from({ length: rows },     () => new Array(cols + 1).fill(0));
      const solver = new SlitherlinkSolver({
        width: cols, height: rows, task: detectedGrid.task,
        initialState: { horizontal: curH, vertical: curV },
      });
      solver.maxMs = 5000;
      hint = solver.getHint(curH, curV);
      if (!hint) {
        return { success: false, error: 'No more edges can be deduced from the current state. Click Solve to finish.' };
      }
      // Carry the current edge state along so applyHintHandler / loop can
      // overlay onto it without re-reading.
      hint._curH = curH;
      hint._curV = curV;
    } else if (detectedGrid.type === 'shikaku') {
      const solver = new ShikakuSolver({
        rows, cols, clues: detectedGrid.clues, initialState: grid,
      });
      hint = solver.getHint(grid);
      if (!hint) {
        return { success: false, error: 'No more cells can be deduced from the current state. Click Solve to finish.' };
      }
    } else if (detectedGrid.type === 'hashi') {
      // grid here is { edges } from hashiHandler.readState. Stepwise hint
      // returns one rule firing at a time {edges, rule, description} so the
      // user (and Loop) sees one logical deduction per click, explained.
      const solver = new HashiSolver({
        rows, cols, islands: detectedGrid.islands,
      });
      const step = solver.getStepwiseHint(grid.edges || []);
      if (step && step.contradiction) {
        return { success: false, error: 'Current bridges conflict with the puzzle — undo, or click Solve to reset.' };
      }
      if (!step || !step.edges || step.edges.length === 0) {
        return { success: false, error: 'No more bridges can be deduced from the current state. Click Solve to finish.' };
      }
      hint = {
        type: 'hashi',
        edges: step.edges,
        count: step.edges.length,
        rule: step.rule,
        description: step.description,
      };
    } else if (detectedGrid.type === 'heyawake') {
      if (solution && firstMismatch(grid, solution)) {
        return { success: false, error: 'Current game state is wrong.' };
      }
      const rooms = detectedGrid.rooms;
      const solver = new HeyawakeSolver({ rows, cols, rooms });
      const hintCells = solver.getHint(grid);
      if (!hintCells || hintCells.length === 0) {
        return { success: false, error: 'No more cells can be deduced from the current state. Click Solve to finish.' };
      }
      // hintCells is [{row, col, value}, ...] — absolute coordinates.
      // Pack as extraCells so hintAbsoluteCells passes them through unchanged
      // (hint.cells uses row/col index arithmetic that breaks for absolute shapes).
      hint = { type: 'heyawake', extraCells: hintCells, count: hintCells.length };
    } else if (detectedGrid.type === 'hitori') {
      if (solution && firstMismatch(grid, solution)) {
        return { success: false, error: 'Current game state is wrong.' };
      }
      const solver = new HitoriSolver({ rows, cols, task: detectedGrid.task });
      const hintCells = solver.getHint(grid);
      if (!hintCells || hintCells.length === 0) {
        return { success: false, error: 'No more cells can be deduced from the current state. Click Solve to finish.' };
      }
      hint = { type: 'hitori', extraCells: hintCells, count: hintCells.length };
    } else if (detectedGrid.type === 'kakurasu') {
      if (solution && firstMismatch(grid, solution)) {
        return { success: false, error: 'Current game state is wrong.' };
      }
      const solver = new KakurasuSolver({
        rows, cols,
        rowClues: detectedGrid.rowClues,
        colClues: detectedGrid.colClues,
      });
      const hintCells = solver.getHint(grid);
      if (!hintCells || hintCells.length === 0) {
        return { success: false, error: 'No more cells can be deduced from the current state. Click Solve to finish.' };
      }
      hint = { type: 'kakurasu', extraCells: hintCells, count: hintCells.length };
    } else if (detectedGrid.type === 'kurodoko') {
      if (solution && firstMismatch(grid, solution)) {
        return { success: false, error: 'Current game state is wrong.' };
      }
      const solver = new KurodokoSolver({
        rows, cols, task: detectedGrid.task,
      });
      const hintCells = solver.getHint(grid);
      if (!hintCells || hintCells.length === 0) {
        return { success: false, error: 'No more cells can be deduced from the current state. Click Solve to finish.' };
      }
      hint = { type: 'kurodoko', extraCells: hintCells, count: hintCells.length };
    } else if (detectedGrid.type === 'mosaic') {
      if (solution && firstMismatch(grid, solution)) {
        return { success: false, error: 'Current game state is wrong.' };
      }
      const solver = new MosaicSolver({
        rows, cols, task: detectedGrid.task,
      });
      const hintCells = solver.getHint(grid);
      if (!hintCells || hintCells.length === 0) {
        return { success: false, error: 'No more cells can be deduced from the current state. Click Solve to finish.' };
      }
      hint = { type: 'mosaic', extraCells: hintCells, count: hintCells.length };
    } else if (detectedGrid.type === 'norinori') {
      if (solution && firstMismatch(grid, solution)) {
        return { success: false, error: 'Current game state is wrong.' };
      }
      const solver = new NorinoriSolver({
        rows, cols, rooms: detectedGrid.rooms,
      });
      const hintCells = solver.getHint(grid);
      if (!hintCells || hintCells.length === 0) {
        return { success: false, error: 'No more cells can be deduced from the current state. Click Solve to finish.' };
      }
      hint = { type: 'norinori', extraCells: hintCells, count: hintCells.length };
    } else if (detectedGrid.type === 'nurikabe') {
      if (solution && firstMismatch(grid, solution)) {
        return { success: false, error: 'Current game state is wrong.' };
      }
      const solver = new NurikabeSolver({
        rows, cols, task: detectedGrid.task,
      });
      const hintCells = solver.getHint(grid);
      if (!hintCells || hintCells.length === 0) {
        return { success: false, error: 'No more cells can be deduced from the current state. Click Solve to finish.' };
      }
      hint = { type: 'nurikabe', extraCells: hintCells, count: hintCells.length };
    } else {
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
    }
    if (detectedGrid.type === 'aquarium') {
      hint = addAquariumRegionHints(hint, grid, hintSolution, detectedGrid.regionMap);
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
