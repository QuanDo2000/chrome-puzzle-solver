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
    // Strip the importScripts line; solver.js is now inlined above it.
    const workerEntry = workerSrc.replace(/^\s*importScripts\([^)]*\);?\s*$/m, '');
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

function firstMismatch(grid, solution) {
  if (!grid || !solution) return null;
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      if (grid[r][c] !== 0 && solution[r]?.[c] !== grid[r][c]) {
        return { row: r, col: c };
      }
    }
  }
  return null;
}

// Per-type path through a solver-produced solution: a deterministic ordered
// list of "chunks" (sets of cells/lines) the fallback hint emits one chunk
// per call. Memoized on the solution object so repeated Hint calls reuse
// the same walk. Pattern mirrors galaxies' getGalaxyPath, generalised:
//   galaxies: chunks = galaxies, smallest first, each chunk's "cells" are
//             boundary lines (orientation/row/col).
//   aquarium: chunks = regions, smallest first, each chunk's cells are the
//             {row, col, value} of every cell in that region.
//   nonogram: chunks = rows, in index order, each chunk's cells are the
//             {row, col, value} for that row.

function getAquariumPath(solution, regionMap) {
  if (solution._aquariumPath) return solution._aquariumPath;
  if (!Array.isArray(regionMap)) return [];
  const byRegion = new Map();
  for (let r = 0; r < regionMap.length; r++) {
    const row = regionMap[r] || [];
    for (let c = 0; c < row.length; c++) {
      const id = row[c];
      if (id === undefined) continue;
      let g = byRegion.get(id);
      if (!g) { g = []; byRegion.set(id, g); }
      g.push({ row: r, col: c, value: solution[r]?.[c] });
    }
  }
  const path = [...byRegion.entries()]
    .map(([id, cells]) => ({ id, size: cells.length, cells }))
    .sort((a, b) => a.size - b.size || a.id - b.id);
  solution._aquariumPath = path;
  return path;
}

function getNonogramPath(solution) {
  if (solution._nonogramPath) return solution._nonogramPath;
  const path = [];
  for (let r = 0; r < solution.length; r++) {
    const row = solution[r] || [];
    const cells = [];
    for (let c = 0; c < row.length; c++) {
      if (row[c] === 1 || row[c] === -1) cells.push({ row: r, col: c, value: row[c] });
    }
    if (cells.length) path.push({ id: r, size: cells.length, cells });
  }
  solution._nonogramPath = path;
  return path;
}

// Convert a flat array of {row, col, value} cells (the next chunk in a path)
// into the row-hint shape the rest of the pipeline expects: first cell becomes
// the row anchor, same-row cells become hint.cells, the rest go in extraCells.
// hintAbsoluteCells/applyHintCells handle both lists, so all cells get applied.
function hintFromCellChunk(cells) {
  if (!cells.length) return null;
  const base = cells[0];
  const sameRow = [];
  const others = [];
  for (const c of cells) {
    if (c.row === base.row) sameRow.push({ index: c.col, value: c.value });
    else others.push({ row: c.row, col: c.col, value: c.value });
  }
  return {
    type: 'row',
    index: base.row,
    clue: null,
    cells: sameRow,
    extraCells: others,
    count: cells.length,
  };
}

// Pick the next chunk from a path with any cells still empty in `grid`.
function nextChunkHint(grid, path) {
  for (const chunk of path) {
    const needed = chunk.cells.filter(c => grid[c.row]?.[c.col] === 0);
    if (!needed.length) continue;
    return hintFromCellChunk(needed);
  }
  return null;
}

function cloneGalaxiesLines(lines) {
  return {
    horizontal: (lines?.horizontal || []).map(row => row.slice()),
    vertical: (lines?.vertical || []).map(row => row.slice()),
  };
}

function getGalaxiesHint(grid, stars) {
  const current = grid?.galaxies;
  if (!current || !stars?.length) return null;
  const rows = grid.length;
  const cols = grid[0].length;
  const seedOwner = buildGalaxiesSeedOwner(stars, rows, cols);
  const components = getGalaxiesComponents(grid, stars, seedOwner);
  const reachable = computeReachableStars(stars, rows, cols, seedOwner, current);

  propagateAllConstraints(components, grid, rows, cols, current, stars);

  // Iterative per-cell forced-star propagation. Start from the per-cell
  // possible-star sets (perCell ∩ reachable ∩ mirror-component) and repeat:
  // if cell c has exactly one possible star X, X's mirror partner of c
  // must also be X (galaxies are mirror-symmetric). Intersect the mirror
  // cell's set to {X}, which may narrow further cells through subsequent
  // iterations. Catches cases the one-shot narrowing misses.
  const cellPossible = propagateForcedCells(grid, stars, rows, cols, seedOwner, reachable);

  const makeHint = (selected) => {
    const lines = cloneGalaxiesLines(current);
    for (const item of selected) lines[item.orientation][item.row][item.col] = 1;
    return {
      type: 'galaxies',
      orientation: selected[0].orientation,
      row: selected[0].row,
      col: selected[0].col,
      lines,
      lineHints: selected,
      count: selected.length
    };
  };

  const candidates = [];
  const addCandidate = (orientation, row, col, aCell, bCell) => {
    const aComp = components.get(grid[aCell.row]?.[aCell.col]);
    const bComp = components.get(grid[bCell.row]?.[bCell.col]);
    // cellPossible already absorbs perCell, reachable, and mirror-component
    // narrowing, plus the forced-mirror propagation loop. Use it as the
    // per-cell baseline.
    let aNodes = new Set(cellPossible.get(aCell.row + ',' + aCell.col) || []);
    let bNodes = new Set(cellPossible.get(bCell.row + ',' + bCell.col) || []);
    if (aComp?.possibleNodes?.size) aNodes = intersectSets(aNodes, aComp.possibleNodes);
    if (bComp?.possibleNodes?.size) bNodes = intersectSets(bNodes, bComp.possibleNodes);
    if (aNodes.size === 0 || bNodes.size === 0) return;
    if (setsIntersect(aNodes, bNodes)) return;
    const nodeIds = new Set([...aNodes, ...bNodes]);
    const score = (aComp?.cells.length || 1) + (bComp?.cells.length || 1);
    candidates.push({ orientation, row, col, nodeIds, currentIds: new Set([aComp?.id, bComp?.id]), score });
  };

  for (let r = 1; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (current.horizontal?.[r]?.[c] === 1) continue;
      addCandidate('horizontal', r, c, { row: r - 1, col: c }, { row: r, col: c });
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 1; c < cols; c++) {
      if (current.vertical?.[r]?.[c] === 1) continue;
      addCandidate('vertical', r, c, { row: r, col: c - 1 }, { row: r, col: c });
    }
  }
  if (candidates.length) {
    const nodeRegions = getGalaxiesNodeRegions(grid, stars);
    let bestNode = null;
    let bestNodeScore = -1;
    for (const node of nodeRegions) {
      const nodeCandidates = candidates.filter(c => c.nodeIds.has(node.index));
      if (!nodeCandidates.length) continue;
      const score = nodeCandidates.length * 10 + node.currentSize / 100;
      if (score > bestNodeScore) {
        bestNodeScore = score;
        bestNode = { ...node, candidates: nodeCandidates };
      }
    }
    const selected = bestNode ? bestNode.candidates : candidates;
    selected.sort((a, b) => b.score - a.score || a.row - b.row || a.col - b.col);
    return makeHint(selected.slice(0, Math.min(100, selected.length)));
  }

  const emptyHints = findEmptyCompHints(components, grid, stars, reachable);
  if (emptyHints) return makeHint(emptyHints);

  return null;
}

// Per-galaxy boundary-line path through a solver-produced solution. Lines are
// grouped by the galaxy id they belong to (each line borders one or two
// galaxies; both get the line). Galaxies are emitted smallest-first so the
// loop completes simple regions before tackling large ones — same order the
// heuristic itself prefers, which keeps the UX consistent across the
// heuristic→solver handoff.
//
// Memoized on the solution object via solution._galaxyPath so repeated
// Hint calls within a session don't re-walk the grid.
function getGalaxyPath(solution) {
  if (solution._galaxyPath) return solution._galaxyPath;
  const target = solution?.galaxies;
  const solGrid = solution?.grid || solution;
  if (!target || !Array.isArray(solGrid) || !solGrid[0]) return [];
  const rows = solGrid.length, cols = solGrid[0].length;

  const byGalaxy = new Map();
  const add = (id, line, key) => {
    if (!id) return;
    let g = byGalaxy.get(id);
    if (!g) { g = { lines: [], seen: new Set() }; byGalaxy.set(id, g); }
    if (g.seen.has(key)) return;
    g.seen.add(key);
    g.lines.push(line);
  };
  for (let r = 0; r < target.horizontal.length; r++) {
    const row = target.horizontal[r] || [];
    for (let c = 0; c < row.length; c++) {
      if (row[c] !== 1) continue;
      const line = { orientation: 'horizontal', row: r, col: c };
      const key = 'h:' + r + ':' + c;
      add(solGrid[r - 1]?.[c], line, key);
      add(solGrid[r]?.[c], line, key);
    }
  }
  for (let r = 0; r < target.vertical.length; r++) {
    const row = target.vertical[r] || [];
    for (let c = 0; c < row.length; c++) {
      if (row[c] !== 1) continue;
      const line = { orientation: 'vertical', row: r, col: c };
      const key = 'v:' + r + ':' + c;
      add(solGrid[r]?.[c - 1], line, key);
      add(solGrid[r]?.[c], line, key);
    }
  }

  const sizes = new Map();
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const id = solGrid[r][c];
    sizes.set(id, (sizes.get(id) || 0) + 1);
  }

  const path = [...byGalaxy.entries()]
    .map(([id, g]) => ({ id, size: sizes.get(id) || 0, lines: g.lines }))
    .sort((a, b) => a.size - b.size || a.id - b.id);

  solution._galaxyPath = path;
  return path;
}

// Hint built from the solver-derived path: emit the next galaxy's undrawn
// boundary lines (one galaxy per call). Returns null when every galaxy on
// the path is complete.
function nextGalaxyHint(grid, solution) {
  const current = grid?.galaxies;
  if (!current) return null;
  const path = getGalaxyPath(solution);
  for (const entry of path) {
    const undrawn = entry.lines.filter(l => current[l.orientation][l.row]?.[l.col] !== 1);
    if (!undrawn.length) continue;
    const lineHints = undrawn.map(lh => ({ ...lh, score: entry.size }));
    const lines = {
      horizontal: current.horizontal.map(row => row.slice()),
      vertical: current.vertical.map(row => row.slice()),
    };
    for (const lh of lineHints) lines[lh.orientation][lh.row][lh.col] = 1;
    return {
      type: 'galaxies',
      orientation: lineHints[0].orientation,
      row: lineHints[0].row,
      col: lineHints[0].col,
      lines,
      lineHints,
      count: lineHints.length,
    };
  }
  return null;
}

function firstGalaxiesMismatch(grid, solution) {
  const current = grid?.galaxies;
  const target = solution?.galaxies;
  if (!current || !target) return null;
  for (let r = 1; r < target.horizontal.length - 1; r++) {
    for (let c = 0; c < target.horizontal[r].length; c++) {
      if (current.horizontal?.[r]?.[c] === 1 && target.horizontal[r][c] !== 1) {
        return { orientation: 'horizontal', row: r, col: c };
      }
    }
  }
  for (let r = 0; r < target.vertical.length; r++) {
    for (let c = 1; c < target.vertical[r].length - 1; c++) {
      if (current.vertical?.[r]?.[c] === 1 && target.vertical[r][c] !== 1) {
        return { orientation: 'vertical', row: r, col: c };
      }
    }
  }
  return null;
}

function buildGalaxiesSeedOwner(stars, rows, cols) {
  const owner = new Map();
  for (let i = 0; i < stars.length; i++) {
    for (const cell of GalaxiesSolver.seedCellsForStar(stars[i], rows, cols)) {
      const key = cell.row + ',' + cell.col;
      owner.set(key, owner.has(key) ? -1 : i);
    }
  }
  return owner;
}

function getGalaxiesComponents(grid, stars, seedOwner) {
  const rows = grid.length;
  const cols = grid[0].length;
  const comps = new Map();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const id = grid[r][c];
      let comp = comps.get(id);
      if (!comp) {
        comp = { id, cells: [], seedNodes: new Set(), possibleNodes: new Set() };
        comps.set(id, comp);
      }
      comp.cells.push({ row: r, col: c });
      const owner = seedOwner.get(r + ',' + c);
      if (owner >= 0) comp.seedNodes.add(owner);
    }
  }
  for (const comp of comps.values()) {
    const candidates = comp.seedNodes.size === 1
      ? Array.from(comp.seedNodes)
      : stars.map((_, i) => i);
    for (const nodeIndex of candidates) {
      const star = stars[nodeIndex];
      // For star X to own this whole component, every cell must satisfy the
      // geometric check (mirror in bounds + seedOwner compatible) AND the
      // mirror of every cell must lie in the SAME line-bounded component.
      // Galaxies are connected, so a cell and its mirror-partner can't end
      // up on opposite sides of a drawn line.
      if (comp.cells.every(cell =>
        galaxyCellCanBelong(cell.row, cell.col, nodeIndex, stars, rows, cols, seedOwner)
        && grid[star.row - cell.row]?.[star.col - cell.col] === comp.id
      )) {
        comp.possibleNodes.add(nodeIndex);
      }
    }
  }
  return comps;
}

function galaxyCellCanBelong(row, col, nodeIndex, stars, rows, cols, seedOwner) {
  const star = stars[nodeIndex];
  const mr = star.row - row;
  const mc = star.col - col;
  if (mr < 0 || mc < 0 || mr >= rows || mc >= cols) return false;
  const ownerA = seedOwner.get(row + ',' + col);
  const ownerB = seedOwner.get(mr + ',' + mc);
  return (ownerA === undefined || ownerA === nodeIndex) &&
    (ownerB === undefined || ownerB === nodeIndex);
}

function possibleGalaxiesNodesForCell(row, col, stars, rows, cols, seedOwner) {
  const out = new Set();
  for (let i = 0; i < stars.length; i++) {
    if (galaxyCellCanBelong(row, col, i, stars, rows, cols, seedOwner)) out.add(i);
  }
  return out;
}

function computeReachableStars(stars, rows, cols, seedOwner, current) {
  const reachable = Array.from({ length: rows }, () => Array.from({ length: cols }, () => new Set()));
  for (let i = 0; i < stars.length; i++) {
    const seeds = GalaxiesSolver.seedCellsForStar(stars[i], rows, cols);
    const q = [];
    const seen = new Set();
    for (const seed of seeds) {
      const key = seed.row + ',' + seed.col;
      if (seed.row < 0 || seed.col < 0 || seed.row >= rows || seed.col >= cols || seen.has(key)) continue;
      if (!galaxyCellCanBelong(seed.row, seed.col, i, stars, rows, cols, seedOwner)) continue;
      seen.add(key);
      reachable[seed.row][seed.col].add(i);
      q.push({ row: seed.row, col: seed.col });
    }
    for (let qi = 0; qi < q.length; qi++) {
      const p = q[qi];
      for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nr = p.row + d[0], nc = p.col + d[1];
        const key = nr + ',' + nc;
        if (nr < 0 || nc < 0 || nr >= rows || nc >= cols || seen.has(key)) continue;
        if (d[0] === 1 && current.horizontal?.[nr]?.[nc] === 1) continue;
        if (d[0] === -1 && current.horizontal?.[p.row]?.[p.col] === 1) continue;
        if (d[1] === 1 && current.vertical?.[nr]?.[nc] === 1) continue;
        if (d[1] === -1 && current.vertical?.[p.row]?.[p.col] === 1) continue;
        if (!galaxyCellCanBelong(nr, nc, i, stars, rows, cols, seedOwner)) continue;
        seen.add(key);
        reachable[nr][nc].add(i);
        q.push({ row: nr, col: nc });
      }
    }
  }
  return reachable;
}

function intersectSets(a, b) {
  const out = new Set();
  for (const v of a) if (b.has(v)) out.add(v);
  return out;
}

// Drop stars X from `possibleSet` where the cell's mirror under X lives in
// a different line-bounded BFS component than the cell itself. Galaxies are
// connected within a single line-bounded region, so cell C and mirror(C, X)
// must share a component or X can't own C.
function narrowByMirrorComponent(cellRow, cellCol, possibleSet, stars, grid) {
  if (!possibleSet.size) return possibleSet;
  const cellComp = grid[cellRow]?.[cellCol];
  if (cellComp === undefined) return possibleSet;
  const out = new Set();
  for (const X of possibleSet) {
    const star = stars[X];
    if (grid[star.row - cellRow]?.[star.col - cellCol] === cellComp) out.add(X);
  }
  return out;
}

// Build per-cell possible-star sets, iteratively narrowed via mirror-forcing.
// Initial set = perCell ∩ reachable ∩ mirror-component. Then repeatedly:
// if a cell is forced (popcount 1) to star X, the mirror cell under X is
// also forced to X — intersect its set to {X}. Continues to fixed point.
// Catches forced-cell chains that the one-shot narrowing in addCandidate
// misses. Returns Map<'r,c', Set<starIndex>>.
function propagateForcedCells(grid, stars, rows, cols, seedOwner, reachable) {
  const possible = new Map();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const perCell = possibleGalaxiesNodesForCell(r, c, stars, rows, cols, seedOwner);
      const rch = reachable[r]?.[c] || new Set();
      let pos = intersectSets(perCell, rch);
      pos = narrowByMirrorComponent(r, c, pos, stars, grid);
      possible.set(r + ',' + c, pos);
    }
  }
  // Forced-mirror propagation. Bounded by total cells × stars; in practice
  // it converges in a handful of passes because each step strictly shrinks
  // the union of all sets.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [key, pos] of possible) {
      if (pos.size !== 1) continue;
      const X = pos.values().next().value;
      const star = stars[X];
      const [rs, cs] = key.split(',');
      const mr = star.row - +rs, mc = star.col - +cs;
      if (mr < 0 || mc < 0 || mr >= rows || mc >= cols) continue;
      const mirrorKey = mr + ',' + mc;
      const mirrorPos = possible.get(mirrorKey);
      if (!mirrorPos || mirrorPos.size === 1) continue;
      if (!mirrorPos.has(X)) continue; // contradiction; skip narrowing
      possible.set(mirrorKey, new Set([X]));
      changed = true;
    }
  }
  return possible;
}

function setsIntersect(a, b) {
  for (const v of a) if (b.has(v)) return true;
  return false;
}

function buildComponentAdjacency(grid, rows, cols, current) {
  const adj = new Map();
  const addEdge = (id1, id2) => {
    if (id1 === id2) return;
    if (!adj.has(id1)) adj.set(id1, new Set());
    if (!adj.has(id2)) adj.set(id2, new Set());
    adj.get(id1).add(id2);
    adj.get(id2).add(id1);
  };
  for (let r = 1; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (current.horizontal?.[r]?.[c] === 1) addEdge(grid[r - 1][c], grid[r][c]);
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 1; c < cols; c++) {
      if (current.vertical?.[r]?.[c] === 1) addEdge(grid[r][c - 1], grid[r][c]);
    }
  }
  return adj;
}

function propagateAllConstraints(components, grid, rows, cols, current, stars) {
  const adj = buildComponentAdjacency(grid, rows, cols, current);
  // NOTE: an earlier version eliminated a star from a component's possibleNodes
  // when certain[star] + comp.cells.length > Math.ceil(rows*cols / stars.length).
  // That bound is the AVERAGE galaxy size, not an upper bound — on puzzles with
  // variable galaxy sizes (e.g. the 30x30 monthly: max galaxy = 30 cells, average
  // = 5) it eliminates correct stars and produces phantom must-draw hints. The
  // elimination is unsound; soundness > pruning. Only the uniqueness rule below
  // (a forced star can't also be a neighbour's option) remains.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [, comp] of components) {
      if (comp.possibleNodes.size !== 1) continue;
      const forcedStar = comp.possibleNodes.values().next().value;
      const neighbors = adj.get(comp.id);
      if (!neighbors) continue;
      for (const nid of neighbors) {
        const nComp = components.get(nid);
        if (!nComp || !nComp.possibleNodes.has(forcedStar)) continue;
        nComp.possibleNodes.delete(forcedStar);
        changed = true;
      }
    }
  }
  // Touch unused params to keep them in the signature for the explicit
  // call contract (and silence the linter if it cares).
  void stars;
}

function bfsComponentSide(startRow, startCol, barrierOrient, barrierRow, barrierCol, grid, current) {
  const rows = grid.length, cols = grid[0].length;
  const visited = new Set();
  const q = [{ row: startRow, col: startCol }];
  const key = startRow + ',' + startCol;
  visited.add(key);
  for (let qi = 0; qi < q.length; qi++) {
    const { row, col } = q[qi];
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nr = row + dr, nc = col + dc;
      if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
      const nk = nr + ',' + nc;
      if (visited.has(nk)) continue;
      if (dr === 1 && barrierOrient === 'horizontal' && barrierRow === row + 1 && barrierCol === col) continue;
      if (dr === -1 && barrierOrient === 'horizontal' && barrierRow === row && barrierCol === col) continue;
      if (dc === 1 && barrierOrient === 'vertical' && barrierRow === row && barrierCol === col + 1) continue;
      if (dc === -1 && barrierOrient === 'vertical' && barrierRow === row && barrierCol === col) continue;
      if (dr === 1 && current.horizontal?.[row + 1]?.[col] === 1) continue;
      if (dr === -1 && current.horizontal?.[row]?.[col] === 1) continue;
      if (dc === 1 && current.vertical?.[row]?.[col + 1] === 1) continue;
      if (dc === -1 && current.vertical?.[row]?.[col] === 1) continue;
      if (grid[row][col] !== grid[nr][nc]) continue;
      visited.add(nk);
      q.push({ row: nr, col: nc });
    }
  }
  return visited;
}

function intersectBitset(cellKeys, bitsets) {
  let result = 0n;
  let first = true;
  for (const key of cellKeys) {
    const b = bitsets.get(key);
    if (!b) return 0n;
    if (first) { result = b; first = false; }
    else result &= b;
    if (!result) return 0n;
  }
  return result;
}

function findEmptyCompHints(components, grid, stars, reachable) {
  const current = grid?.galaxies;
  if (!current) return null;
  const rows = grid.length, cols = grid[0].length;
  const seedOwner = buildGalaxiesSeedOwner(stars, rows, cols);
  const emptyComps = [];
  for (const [, comp] of components) {
    if (!comp.possibleNodes.size && comp.cells.length > 10) emptyComps.push(comp);
  }
  if (!emptyComps.length) return null;

  const bitsets = new Map();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const perCell = possibleGalaxiesNodesForCell(r, c, stars, rows, cols, seedOwner);
      const rch = reachable[r]?.[c] || new Set();
      const nodes = intersectSets(perCell, rch);
      let bits = 0n;
      for (const s of nodes) bits |= (1n << BigInt(s));
      bitsets.set(r + ',' + c, bits);
    }
  }

  // Per-star seed cells, used by the closed-galaxy check below.
  const seedCellsByStar = stars.map(s => GalaxiesSolver.seedCellsForStar(s, rows, cols));

  const compCellSets = new Map();
  for (const comp of emptyComps) {
    const s = new Set();
    for (const cell of comp.cells) s.add(cell.row + ',' + cell.col);
    compCellSets.set(comp.id, s);
  }

  // Returns the index of a star X for which `sideCells` IS X's galaxy: X's
  // seed cells are entirely in sideCells, NO other star's seed cells are in
  // sideCells, and every cell in sideCells has its mirror under X also in
  // sideCells. These three conditions together are sufficient to conclude
  // that sideCells = galaxy(X) in the unique solution, so drawing a line
  // that isolates sideCells is sound even if the rest of the component has
  // no single-owner bitset yet.
  // Returns -1 if no such star.
  const closedGalaxyOwner = (sideCells, sideBits) => {
    if (!sideBits) return -1;
    starLoop: for (let i = 0; i < stars.length; i++) {
      if (!(sideBits & (1n << BigInt(i)))) continue;
      for (const s of seedCellsByStar[i]) {
        if (!sideCells.has(s.row + ',' + s.col)) continue starLoop;
      }
      for (let j = 0; j < stars.length; j++) {
        if (j === i) continue;
        for (const s of seedCellsByStar[j]) {
          if (sideCells.has(s.row + ',' + s.col)) continue starLoop;
        }
      }
      const star = stars[i];
      for (const key of sideCells) {
        const [r, c] = key.split(',');
        const mr = star.row - +r, mc = star.col - +c;
        if (mr < 0 || mc < 0 || mr >= rows || mc >= cols || !sideCells.has(mr + ',' + mc)) continue starLoop;
      }
      return i;
    }
    return -1;
  };

  const hints = [];
  const tried = new Set();
  const process = (orientation, row, col, aId, bId) => {
    if (aId !== bId) return;
    const comp = components.get(aId);
    if (!comp || comp.possibleNodes.size || comp.cells.length <= 10) return;
    const tKey = orientation + ':' + row + ':' + col;
    if (tried.has(tKey)) return;
    tried.add(tKey);
    const aCell = orientation === 'horizontal' ? { row: row - 1, col } : { row, col: col - 1 };
    const sideA = bfsComponentSide(aCell.row, aCell.col, orientation, row, col, grid, current);
    if (sideA.size === comp.cells.length || sideA.size === 0) return;
    const compSet = compCellSets.get(comp.id);
    if (!compSet) return;
    const sideBkeys = [];
    for (const key of compSet) if (!sideA.has(key)) sideBkeys.push(key);
    if (!sideBkeys.length) return;
    const aBits = intersectBitset(sideA, bitsets);
    const bBits = intersectBitset(sideBkeys, bitsets);
    // Acceptance criteria — both are sound:
    //   1. Both sides have a candidate star (the original check; covers
    //      "split into two parts that can each become galaxies later").
    //   2. One side is a closed galaxy for a specific star X (catches
    //      isolate-the-final-galaxy cases where the other side is a big
    //      messy remainder, e.g. the 30x30 monthly at step ~95).
    // The earlier 'aBits || bBits' version was unsound — it accepted splits
    // that stranded a side with no possible owner. The new criterion 2
    // proves a specific owner exists, so it doesn't strand anything.
    if (aBits && bBits) {
      hints.push({ orientation, row, col, score: sideA.size + sideBkeys.length });
      return;
    }
    const sideBSet = new Set(sideBkeys);
    if (closedGalaxyOwner(sideA, aBits) >= 0 || closedGalaxyOwner(sideBSet, bBits) >= 0) {
      hints.push({ orientation, row, col, score: sideA.size + sideBkeys.length });
    }
  };

  for (let r = 1; r < rows; r++)
    for (let c = 0; c < cols; c++)
      if (current.horizontal?.[r]?.[c] !== 1) process('horizontal', r, c, grid[r - 1][c], grid[r][c]);
  for (let r = 0; r < rows; r++)
    for (let c = 1; c < cols; c++)
      if (current.vertical?.[r]?.[c] !== 1) process('vertical', r, c, grid[r][c - 1], grid[r][c]);
  if (!hints.length) return null;
  hints.sort((a, b) => b.score - a.score || a.row - b.row || a.col - b.col);
  return hints.slice(0, Math.min(100, hints.length));
}

function getGalaxiesNodeRegions(grid, stars) {
  const sizes = new Map();
  for (const row of grid || []) {
    for (const id of row || []) sizes.set(id, (sizes.get(id) || 0) + 1);
  }
  return (stars || []).map((star, index) => {
    const currentIds = new Set();
    for (const cell of GalaxiesSolver.seedCellsForStar(star, grid.length, grid[0]?.length || 0)) {
      const id = grid[cell.row]?.[cell.col];
      if (id) currentIds.add(id);
    }
    let currentSize = 0;
    for (const id of currentIds) currentSize += sizes.get(id) || 0;
    return { index, currentIds, currentSize };
  });
}

function solveExtraData() {
  const data = detectedGrid;
  if (!data) return null;
  if (data.type === 'binairo') {
    return {
      rows: data.rows,
      cols: data.cols,
      givens: data.givens,
      comparisonClues: data.comparisonClues || [],
    };
  }
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
  if (data.type === 'hitori') {
    return { rows: data.rows, cols: data.cols, task: data.task };
  }
  if (data.type === 'kakurasu') {
    return { rows: data.rows, cols: data.cols, rowClues: data.rowClues, colClues: data.colClues };
  }
  if (data.type === 'kurodoko') {
    return { rows: data.rows, cols: data.cols, task: data.task };
  }
  if (data.type === 'mosaic') {
    return { rows: data.rows, cols: data.cols, task: data.task };
  }
  return null;
}

// Solution-cache hygiene. Each cached entry stores `savedAt: Date.now()`.
// Two cleanup paths cooperate:
//   * TTL on read: entries older than SOLUTION_TTL_MS are evicted at the
//     read site and treated as a miss. Self-healing — a stale entry
//     vanishes the next time anyone tries to read it.
//   * Prune on write: after each cache write, scan all *-solution:* keys,
//     drop any past TTL, and if we still exceed SOLUTION_CACHE_MAX, evict
//     the oldest by savedAt until we fit. Bounds the cache against
//     localStorage quota (~5 MB per origin).
const SOLUTION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SOLUTION_CACHE_MAX = 50;
const SOLUTION_KEY_PREFIXES = ['galaxies-solution:', 'aquarium-solution:', 'nonogram-solution:', 'binairo-solution:', 'shikaku-solution:', 'yinyang-solution:', 'slitherlink-solution:', 'hashi-solution:', 'heyawake-solution:', 'hitori-solution:', 'kakurasu-solution:', 'kurodoko-solution:', 'mosaic-solution:'];

function isSolutionCacheKey(key) {
  return typeof key === 'string' && SOLUTION_KEY_PREFIXES.some(p => key.startsWith(p));
}

function pruneSolutionCache() {
  try {
    const now = Date.now();
    const entries = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!isSolutionCacheKey(key)) continue;
      let savedAt = 0;
      try {
        const parsed = JSON.parse(localStorage.getItem(key) || 'null');
        savedAt = parsed?.savedAt || 0;
      } catch { /* unparseable → treat as ancient, evict below */ }
      entries.push({ key, savedAt });
    }
    // TTL: drop anything past the window. Entries with no savedAt (or a
    // corrupted JSON above) get savedAt=0, so they always fall here first.
    const fresh = [];
    for (const e of entries) {
      if (now - e.savedAt > SOLUTION_TTL_MS) {
        try { localStorage.removeItem(e.key); } catch { /* ignore */ }
      } else {
        fresh.push(e);
      }
    }
    // LRU: oldest-first eviction until we fit.
    if (fresh.length > SOLUTION_CACHE_MAX) {
      fresh.sort((a, b) => a.savedAt - b.savedAt);
      const removeCount = fresh.length - SOLUTION_CACHE_MAX;
      for (let i = 0; i < removeCount; i++) {
        try { localStorage.removeItem(fresh[i].key); } catch { /* ignore */ }
      }
    }
  } catch { /* localStorage not available; nothing to prune */ }
}

function isFreshSolutionEntry(parsed) {
  if (!parsed || typeof parsed.savedAt !== 'number') return false;
  return Date.now() - parsed.savedAt <= SOLUTION_TTL_MS;
}

function galaxiesCacheKey(data) {
  if (!data || data.type !== 'galaxies') return null;
  const stars = (data.stars || []).map(s => s.row + ',' + s.col).join(';');
  return 'galaxies-solution:' + data.rows + 'x' + data.cols + ':' + stars;
}

function galaxiesPartialKey(data) {
  const key = galaxiesCacheKey(data);
  return key ? key.replace('galaxies-solution:', 'galaxies-partial:') : null;
}

function galaxiesFailedKey(data) {
  const key = galaxiesCacheKey(data);
  return key ? key.replace('galaxies-solution:', 'galaxies-failed:') : null;
}

function getCachedGalaxiesSolution(data) {
  const key = galaxiesCacheKey(data);
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.grid || !parsed?.galaxies) return null;
    if (!isFreshSolutionEntry(parsed)) {
      try { localStorage.removeItem(key); } catch { /* ignore */ }
      return null;
    }
    const grid = parsed.grid.map(row => row.slice());
    grid.galaxies = {
      horizontal: parsed.galaxies.horizontal.map(row => row.slice()),
      vertical: parsed.galaxies.vertical.map(row => row.slice()),
    };
    return grid;
  } catch {
    return null;
  }
}

function cacheGalaxiesSolution(data, grid) {
  const key = galaxiesCacheKey(data);
  if (!key || !grid?.galaxies) return;
  try {
    localStorage.setItem(key, JSON.stringify({ grid, galaxies: grid.galaxies, savedAt: Date.now() }));
    pruneSolutionCache();
  } catch { /* quota or unavailable; pruneSolutionCache would no-op anyway */ }
}

// Aquarium + nonogram cache. Same shape as galaxies (stable key derived from
// puzzle definition + 2D grid in localStorage), without the galaxies-lines
// side-property. Lets the loop / Hint button reuse a once-solved puzzle
// across reloads, and also fuels the per-type path fallbacks below.
function aquariumCacheKey(data) {
  if (!data || data.type !== 'aquarium') return null;
  const r = (data.rowClues || []).join(',');
  const c = (data.colClues || []).join(',');
  const m = (data.regionMap || []).map(row => row.join('-')).join(';');
  return 'aquarium-solution:' + data.rows + 'x' + data.cols + ':' + r + ':' + c + ':' + m;
}

function nonogramCacheKey(data) {
  if (!data || data.type !== 'nonogram') return null;
  const r = (data.rowClues || []).map(rc => rc.join('-')).join(';');
  const c = (data.colClues || []).map(cc => cc.join('-')).join(';');
  return 'nonogram-solution:' + data.rows + 'x' + data.cols + ':' + r + ':' + c;
}

function binairoCacheKey(data) {
  if (data?.type !== 'binairo') return null;
  // FNV-1a over (type, rows, cols, flattened givens, comparison clues).
  let h = 0x811c9dc5;
  const mix = (n) => { h ^= n; h = Math.imul(h, 0x01000193) >>> 0; };
  mix(0x42); // 'B' nameplate so binairo keys can't collide with nonogram keys
  mix(data.rows | 0);
  mix(data.cols | 0);
  const g = data.givens || [];
  for (let r = 0; r < data.rows; r++) {
    const row = g[r] || [];
    for (let c = 0; c < data.cols; c++) mix((row[c] | 0) + 2);
  }
  // Mix comparison clues so binairo and binairo-plus boards with identical
  // givens hash to distinct keys. Sparse 2D — outer row index, inner col
  // index, value or 0 for missing. Length sentinels up front keep zero-
  // comparison and 1-comparison-of-flag-0 cases distinguishable.
  const cc = Array.isArray(data.comparisonClues) ? data.comparisonClues : [];
  mix(cc.length);
  for (let r = 0; r < cc.length; r++) {
    const row = Array.isArray(cc[r]) ? cc[r] : [];
    mix(row.length);
    for (let c = 0; c < row.length; c++) mix((row[c] | 0) + 1);
  }
  return 'binairo-solution:' + (h >>> 0).toString(16);
}

function shikakuCacheKey(data) {
  if (data?.type !== 'shikaku') return null;
  let h = 0x811c9dc5;
  const mix = (n) => { h ^= n; h = Math.imul(h, 0x01000193) >>> 0; };
  mix(0x53); // 'S' nameplate
  mix(data.rows | 0);
  mix(data.cols | 0);
  const clues = Array.isArray(data.clues) ? data.clues : [];
  mix(clues.length);
  const sorted = clues.slice().sort((a, b) =>
    a.row - b.row || a.col - b.col || a.area - b.area);
  for (const k of sorted) {
    mix(k.row | 0);
    mix(k.col | 0);
    mix(k.area | 0);
  }
  return 'shikaku-solution:' + (h >>> 0).toString(16);
}

function hashiCacheKey(data) {
  if (data?.type !== 'hashi') return null;
  // FNV-1a over (nameplate, rows, cols, sorted islands flattened).
  let h = 0x811c9dc5;
  const mix = (n) => { h ^= n; h = Math.imul(h, 0x01000193) >>> 0; };
  mix(0x48); // 'H' nameplate so hashi keys can't collide with other types
  mix(data.rows | 0);
  mix(data.cols | 0);
  const islands = Array.isArray(data.islands) ? data.islands : [];
  mix(islands.length);
  const sorted = islands.slice().sort((a, b) =>
    a.row - b.row || a.col - b.col || a.number - b.number);
  for (const i of sorted) {
    mix(i.row | 0);
    mix(i.col | 0);
    mix(i.number | 0);
  }
  return 'hashi-solution:' + (h >>> 0).toString(16);
}

function yinYangCacheKey(data) {
  if (data?.type !== 'yinyang') return null;
  // FNV-1a over (type nameplate, rows, cols, flattened task).
  let h = 0x811c9dc5;
  const mix = (n) => { h ^= n; h = Math.imul(h, 0x01000193) >>> 0; };
  mix(0x59); // 'Y' nameplate so yin-yang keys can't collide with other types
  mix(data.rows | 0);
  mix(data.cols | 0);
  const t = data.task || [];
  for (let r = 0; r < data.rows; r++) {
    const row = t[r] || [];
    for (let c = 0; c < data.cols; c++) mix((row[c] | 0) + 2);
  }
  return 'yinyang-solution:' + (h >>> 0).toString(16);
}

function slitherlinkCacheKey(data) {
  if (data?.type !== 'slitherlink') return null;
  // FNV-1a over (nameplate, rows, cols, flattened task).
  let h = 0x811c9dc5;
  const mix = (n) => { h ^= n; h = Math.imul(h, 0x01000193) >>> 0; };
  mix(0x4C); // 'L' nameplate (Loop) so slitherlink keys don't collide
  mix(data.rows | 0);
  mix(data.cols | 0);
  const t = data.task || [];
  for (let r = 0; r < data.rows; r++) {
    const row = t[r] || [];
    for (let c = 0; c < data.cols; c++) mix((row[c] | 0) + 2);
  }
  return 'slitherlink-solution:' + (h >>> 0).toString(16);
}

function heyawakeCacheKey(data) {
  if (data?.type !== 'heyawake') return null;
  // FNV-1a over (nameplate, rows, cols, flattened areas 2-D room-ID map).
  let h = 0x811c9dc5;
  const mix = (n) => { h ^= n & 0xff; h = Math.imul(h, 0x01000193) >>> 0; };
  mix(0x57); // 'W' nameplate (heWawake) so heyawake keys can't collide
  mix(data.rows | 0);
  mix(data.cols | 0);
  const areas = data.areas || [];
  for (let r = 0; r < data.rows; r++) {
    const row = areas[r] || [];
    for (let c = 0; c < data.cols; c++) mix((row[c] | 0) + 1);
  }
  if (data.rooms) {
    for (const room of data.rooms) {
      const t = room.target;
      h ^= (t + 1) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return 'heyawake-solution:' + (h >>> 0).toString(16);
}

function hitoriCacheKey(data) {
  if (data?.type !== 'hitori' || !data.task) return null;
  let h = 0x811c9dc5;
  const mix = (n) => { h ^= n & 0xff; h = Math.imul(h, 0x01000193) >>> 0; };
  mix(0x49); // 'I' nameplate
  mix(data.rows); mix(data.cols);
  for (const row of data.task) for (const v of row) mix(v + 1);
  return 'hitori-solution:' + (h >>> 0).toString(16);
}

function kakurasuCacheKey(data) {
  if (data?.type !== 'kakurasu' || !data.rowClues || !data.colClues) return null;
  let h = 0x811c9dc5;
  const mix = (n) => { h ^= n & 0xff; h = Math.imul(h, 0x01000193) >>> 0; };
  mix(0x4B); // 'K' nameplate
  mix(data.rows); mix(data.cols);
  for (const v of data.rowClues) mix(v + 1);
  for (const v of data.colClues) mix(v + 1);
  return 'kakurasu-solution:' + (h >>> 0).toString(16);
}

function kurodokoCacheKey(data) {
  if (data?.type !== 'kurodoko' || !data.task) return null;
  let h = 0x811c9dc5;
  const mix = (n) => { h ^= n & 0xff; h = Math.imul(h, 0x01000193) >>> 0; };
  mix(0x44); // 'D' nameplate (kuroDoko)
  mix(data.rows); mix(data.cols);
  for (const row of data.task) for (const v of row) mix(v + 1);
  return 'kurodoko-solution:' + (h >>> 0).toString(16);
}

function mosaicCacheKey(data) {
  if (data?.type !== 'mosaic' || !data.task) return null;
  let h = 0x811c9dc5;
  const mix = (n) => { h ^= n & 0xff; h = Math.imul(h, 0x01000193) >>> 0; };
  mix(0x4D); // 'M' nameplate
  mix(data.rows); mix(data.cols);
  for (const row of data.task) for (const v of row) mix(v + 1);
  return 'mosaic-solution:' + (h >>> 0).toString(16);
}

function getCachedGridSolution(data) {
  const key = data?.type === 'aquarium' ? aquariumCacheKey(data)
    : data?.type === 'nonogram' ? nonogramCacheKey(data)
    : data?.type === 'binairo' ? binairoCacheKey(data)
    : data?.type === 'shikaku' ? shikakuCacheKey(data)
    : data?.type === 'yinyang' ? yinYangCacheKey(data)
    : data?.type === 'slitherlink' ? slitherlinkCacheKey(data)
    : data?.type === 'hashi' ? hashiCacheKey(data)
    : data?.type === 'heyawake' ? heyawakeCacheKey(data)
    : data?.type === 'hitori' ? hitoriCacheKey(data)
    : data?.type === 'kakurasu' ? kakurasuCacheKey(data)
    : data?.type === 'kurodoko' ? kurodokoCacheKey(data)
    : data?.type === 'mosaic' ? mosaicCacheKey(data)
    : null;
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!isFreshSolutionEntry(parsed)) {
      try { localStorage.removeItem(key); } catch { /* ignore */ }
      return null;
    }
    if (data.type === 'slitherlink') {
      if (!parsed?.horizontal || !parsed?.vertical) return null;
      return {
        horizontal: parsed.horizontal.map(row => row.slice()),
        vertical: parsed.vertical.map(row => row.slice()),
      };
    }
    if (data.type === 'hashi') {
      if (!Array.isArray(parsed?.edges)) return null;
      return { edges: parsed.edges.map(e => ({ ...e })) };
    }
    if (!Array.isArray(parsed?.grid)) return null;
    return parsed.grid.map(row => row.slice());
  } catch {
    return null;
  }
}

function cacheGridSolution(data, grid) {
  const key = data?.type === 'aquarium' ? aquariumCacheKey(data)
    : data?.type === 'nonogram' ? nonogramCacheKey(data)
    : data?.type === 'binairo' ? binairoCacheKey(data)
    : data?.type === 'shikaku' ? shikakuCacheKey(data)
    : data?.type === 'yinyang' ? yinYangCacheKey(data)
    : data?.type === 'slitherlink' ? slitherlinkCacheKey(data)
    : data?.type === 'hashi' ? hashiCacheKey(data)
    : data?.type === 'heyawake' ? heyawakeCacheKey(data)
    : data?.type === 'hitori' ? hitoriCacheKey(data)
    : data?.type === 'kakurasu' ? kakurasuCacheKey(data)
    : data?.type === 'kurodoko' ? kurodokoCacheKey(data)
    : data?.type === 'mosaic' ? mosaicCacheKey(data)
    : null;
  if (!key) return;
  try {
    if (data?.type === 'slitherlink') {
      if (!grid || !grid.horizontal || !grid.vertical) return;
      localStorage.setItem(key, JSON.stringify({
        horizontal: grid.horizontal, vertical: grid.vertical, savedAt: Date.now(),
      }));
    } else if (data?.type === 'hashi') {
      if (!grid || !Array.isArray(grid.edges)) return;
      localStorage.setItem(key, JSON.stringify({
        edges: grid.edges, savedAt: Date.now(),
      }));
    } else {
      if (!Array.isArray(grid)) return;
      localStorage.setItem(key, JSON.stringify({ grid, savedAt: Date.now() }));
    }
    pruneSolutionCache();
  } catch { /* quota or unavailable */ }
}

function puzzlePartialKey(data) {
  if (!data) return null;
  if (data.type === 'galaxies') return galaxiesPartialKey(data);
  const base = [data.type || 'nonogram', data.rows, data.cols];
  if (data.type === 'aquarium') {
    base.push((data.rowClues || []).join(','), (data.colClues || []).join(','));
    base.push((data.regionMap || []).map(row => row.join(',')).join(';'));
  } else {
    base.push(JSON.stringify(data.rowClues || []), JSON.stringify(data.colClues || []));
  }
  return 'puzzle-partial:' + base.join('|');
}

function getCachedPartial(data) {
  const key = puzzlePartialKey(data);
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.grid) return null;
    return parsed.grid.map(row => row.slice());
  } catch {
    return null;
  }
}

function cachePartial(data, grid, filled) {
  const key = puzzlePartialKey(data);
  if (!key || !grid) return;
  try {
    const nextFilled = filled || countKnownCells(grid);
    const raw = localStorage.getItem(key);
    if (raw) {
      const current = JSON.parse(raw);
      if ((current?.filled || 0) > nextFilled) return;
    }
    localStorage.setItem(key, JSON.stringify({ grid, filled: nextFilled, savedAt: Date.now() }));
  } catch {}
}

function clearPartial(data) {
  const key = puzzlePartialKey(data);
  if (!key) return;
  try { localStorage.removeItem(key); } catch {}
}

function countKnownCells(grid) {
  let n = 0;
  for (const row of grid || []) for (const v of row || []) if (v !== 0) n++;
  return n;
}

function chooseInitialGrid(data, currentGrid) {
  const partial = getCachedPartial(data);
  if (!partial) return currentGrid || null;
  return countKnownCells(partial) > countKnownCells(currentGrid) ? partial : (currentGrid || partial);
}

function getCachedGalaxiesPartial(data) {
  return getCachedPartial(data);
}

function getFailedGalaxiesPartials(data) {
  const key = galaxiesFailedKey(data);
  if (!key) return [];
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(grid => grid.map(row => row.slice()));
  } catch {
    return [];
  }
}

function cacheFailedGalaxiesPartial(data, grid) {
  const key = galaxiesFailedKey(data);
  if (!key || !grid) return;
  try {
    const failed = getFailedGalaxiesPartials(data);
    const sig = JSON.stringify(grid);
    if (!failed.some(g => JSON.stringify(g) === sig)) failed.push(grid.map(row => row.slice()));
    while (failed.length > 20) failed.shift();
    localStorage.setItem(key, JSON.stringify(failed));
  } catch {}
}

function clearFailedGalaxiesPartials(data) {
  const key = galaxiesFailedKey(data);
  if (!key) return;
  try { localStorage.removeItem(key); } catch {}
}

function hintAbsoluteCells(hint) {
  if (!hint) return [];
  const out = [];
  for (const cell of hint.cells || []) {
    out.push({
      row: hint.type === 'row' ? hint.index : cell.index,
      col: hint.type === 'row' ? cell.index : hint.index,
      value: cell.value,
    });
  }
  for (const cell of hint.extraCells || []) out.push(cell);
  return out;
}

function applyHintToGrid(grid, hint) {
  if (hint?.type === 'galaxies') {
    grid.galaxies = hint.lines;
    return;
  }
  if (hint?.type === 'slitherlink') {
    // grid is { horizontal, vertical } from slitherlinkHandler.readState.
    for (const e of (hint.edges || [])) {
      if (e.orientation === 'h' && grid.horizontal?.[e.r]) grid.horizontal[e.r][e.c] = 1;
      else if (e.orientation === 'v' && grid.vertical?.[e.r]) grid.vertical[e.r][e.c] = 1;
    }
    return;
  }
  if (hint?.type === 'hashi') {
    // grid is { edges } from hashiHandler.readState. Each hint edge overrides
    // the matching grid edge by min-max endpoint key; edges not present in the
    // grid are pushed as new entries. Mirrors the merge in applyHintHandler /
    // applyAndRunLoop, but mutates the in-memory grid (no MAIN-world apply)
    // so callers can re-check completion off the merged shape.
    if (!Array.isArray(grid.edges)) grid.edges = [];
    const overrideMap = new Map();
    for (const e of (hint.edges || [])) {
      const a = Math.min(e.a, e.b), b = Math.max(e.a, e.b);
      overrideMap.set(`${a}-${b}`, e);
    }
    for (let i = 0; i < grid.edges.length; i++) {
      const a = Math.min(grid.edges[i].a, grid.edges[i].b);
      const b = Math.max(grid.edges[i].a, grid.edges[i].b);
      const key = `${a}-${b}`;
      if (overrideMap.has(key)) {
        grid.edges[i] = overrideMap.get(key);
        overrideMap.delete(key);
      }
    }
    for (const remaining of overrideMap.values()) grid.edges.push(remaining);
    return;
  }
  for (const cell of hintAbsoluteCells(hint)) {
    if (grid[cell.row] !== undefined) grid[cell.row][cell.col] = cell.value;
  }
}

function addAquariumRegionHints(hint, grid, solution, regionMap) {
  if (!hint || !regionMap) return hint;
  const base = hintAbsoluteCells(hint);
  const seen = new Set(base.map(c => c.row + ',' + c.col));
  const extra = [];
  const add = (row, col, value) => {
    const key = row + ',' + col;
    if (seen.has(key) || grid[row]?.[col] !== 0) return;
    if (solution && solution[row]?.[col] !== value) return;
    seen.add(key);
    extra.push({ row, col, value });
  };

  for (const cell of base) {
    const id = regionMap[cell.row]?.[cell.col];
    if (id === undefined) continue;
    for (let r = 0; r < regionMap.length; r++) {
      for (let c = 0; c < regionMap[r].length; c++) {
        if (regionMap[r][c] !== id) continue;
        if (cell.value === 1 && r >= cell.row) add(r, c, 1);
        if (cell.value === -1 && r <= cell.row) add(r, c, -1);
      }
    }
  }

  if (extra.length === 0) return hint;
  return { ...hint, extraCells: extra, count: (hint.count || 0) + extra.length };
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
  { name: 'Nonogram',     url: 'https://www.puzzles-mobile.com/nonograms/' },
  { name: 'Shikaku',      url: 'https://www.puzzles-mobile.com/shikaku/' },
  { name: 'Slitherlink',  url: 'https://www.puzzles-mobile.com/loop/' },
  { name: 'Yin-Yang',     url: 'https://www.puzzles-mobile.com/yin-yang/' },
];

// Reference set by makeWidget() so the top-level message listener (for the
// toolbar-icon click → expandWidget action) can drive the widget without
// reaching into its closure.
let widgetExpandFn = null;

function loadWidgetPref() {
  try {
    const v = localStorage.getItem(WIDGET_STORAGE_KEY);
    return v ? JSON.parse(v) : {};
  } catch { return {}; }
}

function saveWidgetPref(pref) {
  try { localStorage.setItem(WIDGET_STORAGE_KEY, JSON.stringify(pref)); } catch {}
}

function makeWidget() {
  const pref = loadWidgetPref();
  let expanded = pref.expanded !== false;
  let puzzleData = null;
  let confirming = false;
  let loopConfirming = false;
  let looping = false;
  let stopLooping = false;
  let stopLoopWait = null;  // set to a cancellation fn while the loop is sleeping
  let pendingAutoSolve = null;
  let solveBtn = null;
  let loopBtn = null;

  const shadow = document.createElement('div');
  shadow.id = 'ns-widget-shadow';

  const style = document.createElement('style');
  style.textContent = `
#ns-widget {
  all: initial;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 14px;
  color: #1a1a2e;
  position: fixed;
  z-index: 2147483647;
  bottom: 16px;
  left: 16px;
  width: 380px;
  background: rgba(248, 249, 250, 0.92);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid rgba(222, 226, 230, 0.6);
  border-radius: 10px;
  box-shadow: 0 4px 24px rgba(0,0,0,.15);
  overflow: hidden;
  transition: height .2s, width .2s;
}
#ns-widget.ns-collapsed {
  width: 48px;
  height: 48px;
  border-radius: 24px;
  cursor: pointer;
}
#ns-widget.ns-collapsed .ns-header {
  width: 48px; height: 48px; padding: 0;
  border-radius: 24px; justify-content: center;
}
#ns-widget.ns-collapsed .ns-label { display: none; }
#ns-widget.ns-collapsed .ns-ico {
  font-size: 26px;
  display: flex; align-items: center; justify-content: center;
  width: 48px; height: 48px;
}
#ns-widget .ns-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: rgba(28, 126, 214, 0.88);
  color: #fff;
  cursor: pointer;
  user-select: none;
}
#ns-widget .ns-title { font-weight: 700; font-size: 16px; }
#ns-widget .ns-body { padding: 10px 14px 14px; }
#ns-widget .ns-btns { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
#ns-widget .ns-btn-row { display: flex; flex-wrap: wrap; gap: 6px; }
#ns-widget .ns-btns button {
  padding: 6px 10px; border: none; border-radius: 5px;
  font-size: 13px; font-weight: 600; cursor: pointer;
  background: #e9ecef; color: #495057;
}
#ns-widget .ns-btns button:hover { opacity: .8; }
#ns-widget .ns-btns button:disabled { opacity: .4; cursor: not-allowed; }
#ns-widget .ns-btns .ns-primary { background: #1c7ed6; color: #fff; }
#ns-widget .ns-btns .ns-success { background: #2b8a3e; color: #fff; }
#ns-widget .ns-status {
  padding: 7px 10px; border-radius: 6px; font-size: 13px;
  margin-bottom: 8px; background: #e9ecef; color: #495057;
  line-height: 1.3;
}
#ns-widget .ns-status.ns-info { background: #d0ebff; color: #1c7ed6; }
#ns-widget .ns-status.ns-error { background: #ffe0e0; color: #c92a2a; }
#ns-widget .ns-status.ns-success { background: #d3f9d8; color: #2b8a3e; }
#ns-widget canvas {
  display: block; border: 1px solid #dee2e6; border-radius: 4px;
  max-width: 100%; width: 100%; height: auto;
}
#ns-widget .ns-ico { font-size: 22px; line-height: 1; }
#ns-widget .ns-sr-only {
  position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0);
}
#ns-widget .ns-preview-wrap { display: none; }
#ns-widget .ns-preview-wrap.ns-visible { display: block; }
`;

  shadow.appendChild(style);

  const html = `
<div id="ns-widget" class="${expanded ? '' : 'ns-collapsed'}">
  <div class="ns-header">
    <span class="ns-title"><span class="ns-ico">🧩</span><span class="ns-label"> Solver</span></span>
  </div>
  <div class="ns-body">
    <div class="ns-btns">
      <div class="ns-btn-row">
        <button data-action="detect" class="ns-primary">Detect</button>
        <button data-action="solve" disabled>Solve</button>
        <button data-action="loop" disabled>Loop</button>
        <button data-action="hint" disabled>Hint</button>
        <button data-action="applyHint" disabled>Apply</button>
      </div>
      <div class="ns-btn-row">
        <button data-action="undo" disabled>↩ Undo</button>
        <button data-action="redo" disabled>↪ Redo</button>
        <button data-action="dump">📋 Dump</button>
      </div>
    </div>
    <div class="ns-status" id="ns-status">Ready</div>
    <div class="ns-preview-wrap" id="ns-preview-wrap">
      <canvas id="ns-canvas"></canvas>
    </div>
  </div>
</div>`;
  shadow.insertAdjacentHTML('beforeend', html);
  document.documentElement.appendChild(shadow);

  const root = shadow.querySelector('#ns-widget');

  function q(sel) { return shadow.querySelector(sel); }

  const statusEl = q('#ns-status');
  const canvas = q('#ns-canvas');
  const previewWrap = q('#ns-preview-wrap');
  solveBtn = q('[data-action="solve"]');
  loopBtn = q('[data-action="loop"]');

  function setHintLabel(text) {
    q('[data-action="hint"]').textContent = text;
  }

  // Reset the "pending hint" UI state in one call: clear the cached hint,
  // restore the button label, and disable Apply Hint. Replaces the three-line
  // pattern that used to appear scattered through the handlers (sometimes with
  // accidental duplication).
  function clearPendingHint() {
    if (puzzleData) puzzleData.pendingHint = null;
    setHintLabel('Hint');
    q('[data-action="applyHint"]').disabled = true;
  }

  // Human-readable description of a Galaxies hint's boundary line(s).
  function galaxiesHintLineDesc(h) {
    const lines = h.lineHints || [h];
    if (lines.length !== 1) return `${lines.length} boundary lines`;
    const l = lines[0];
    return l.orientation === 'horizontal'
      ? `horizontal boundary below row ${l.row}, column ${l.col + 1}`
      : `vertical boundary at row ${l.row + 1}, after column ${l.col}`;
  }

  // Returns an array of DOM nodes / strings describing a row/col nonogram hint,
  // for use with setStatusNodes(). Replaces the old html-string approach so we
  // never pass dynamic content through innerHTML.
  // Write the status text for a hint (galaxies → "Draw the X.", others →
  // hintStatusNodes). Optional `prefix` is prepended verbatim — the loop body
  // uses `Step N: ` so it threads through one branch.
  function setHintStatus(h, prefix = '') {
    if (h.type === 'galaxies') {
      setStatusNodes('info', prefix, 'Draw the ', bold(galaxiesHintLineDesc(h)), '.');
    } else if (puzzleData?.type === 'binairo') {
      setStatusNodes('info', prefix, ...binairoHintStatusNodes(h));
    } else if (puzzleData?.type === 'shikaku') {
      setStatusNodes('info', prefix, ...shikakuHintStatusNodes(h));
    } else if (puzzleData?.type === 'yinyang') {
      setStatusNodes('info', prefix, ...yinYangHintStatusNodes(h));
    } else if (puzzleData?.type === 'slitherlink') {
      setStatusNodes('info', prefix, ...slitherlinkHintStatusNodes(h));
    } else if (puzzleData?.type === 'hashi') {
      setStatusNodes('info', prefix, ...hashiHintStatusNodes(h));
    } else if (puzzleData?.type === 'heyawake') {
      setStatusNodes('info', prefix, ...heyawakeHintStatusNodes(h));
    } else if (puzzleData?.type === 'hitori') {
      setStatusNodes('info', prefix, ...hitoriHintStatusNodes(h));
    } else if (puzzleData?.type === 'kakurasu') {
      setStatusNodes('info', prefix, ...kakurasuHintStatusNodes(h));
    } else if (puzzleData?.type === 'kurodoko') {
      setStatusNodes('info', prefix, ...kurodokoHintStatusNodes(h));
    } else {
      setStatusNodes('info', prefix, ...hintStatusNodes(h));
    }
  }

  function binairoHintStatusNodes(h) {
    const total = (h.cells?.length || 0) + (h.extraCells?.length || 0);
    if (total === 0) return ['No hint available'];
    if (total === 1) {
      const cell = h.cells?.[0] || h.extraCells?.[0];
      const row = h.cells?.length ? h.index : cell.row;
      const col = h.cells?.length ? cell.index : cell.col;
      // Binairo cellStatus: 1 = "one", 2 = "zero". Translate for display.
      const valueStr = cell.value === 1 ? '1' : '0';
      return [
        'Cell ', bold(`(row ${row + 1}, col ${col + 1})`),
        ' must be ', bold(valueStr),
      ];
    }
    return [bold(String(total)), ' cells can be deduced'];
  }

  // Heyawake hints carry absolute cells in extraCells (no row/column index
  // — every hint is a flat list of forced cells from propagation).
  // cellStatus 1 = black, 2 = white-mark; same encoding as Yin-Yang.
  function heyawakeHintStatusNodes(h) {
    const cells = h.extraCells || [];
    if (cells.length === 0) return ['No hint available'];
    if (cells.length === 1) {
      const cell = cells[0];
      const valueStr = cell.value === 1 ? 'black' : 'white';
      return [
        'Cell ', bold(`(row ${cell.row + 1}, col ${cell.col + 1})`),
        ' must be ', bold(valueStr),
      ];
    }
    return [bold(String(cells.length)), ' cells can be deduced'];
  }

  // Hitori hints carry absolute cells in extraCells.
  // cellStatus 1 = shaded (black), 2 = unshaded (circled/white).
  function hitoriHintStatusNodes(h) {
    const cells = h.extraCells || [];
    if (cells.length === 0) return ['No hint available'];
    if (cells.length === 1) {
      const cell = cells[0];
      const valueStr = cell.value === 1 ? 'shaded' : 'unshaded';
      return [
        'Cell ', bold(`(row ${cell.row + 1}, col ${cell.col + 1})`),
        ' must be ', bold(valueStr),
      ];
    }
    return [bold(String(cells.length)), ' cells can be deduced'];
  }

  // Kakurasu hints carry absolute cells in extraCells.
  // cellStatus 1 = filled (black), 2 = empty (white).
  function kakurasuHintStatusNodes(h) {
    const cells = h.extraCells || [];
    if (cells.length === 0) return ['No hint available'];
    if (cells.length === 1) {
      const cell = cells[0];
      const valueStr = cell.value === 1 ? 'filled' : 'empty';
      return [
        'Cell ', bold(`(row ${cell.row + 1}, col ${cell.col + 1})`),
        ' must be ', bold(valueStr),
      ];
    }
    return [bold(String(cells.length)), ' cells can be deduced'];
  }

  // Kurodoko hints carry absolute cells in extraCells.
  // cellStatus 1 = shaded (black), 2 = unshaded (white).
  function kurodokoHintStatusNodes(h) {
    const cells = h.extraCells || [];
    if (cells.length === 0) return ['No hint available'];
    if (cells.length === 1) {
      const cell = cells[0];
      const valueStr = cell.value === 1 ? 'shaded' : 'unshaded';
      return [
        'Cell ', bold(`(row ${cell.row + 1}, col ${cell.col + 1})`),
        ' must be ', bold(valueStr),
      ];
    }
    return [bold(String(cells.length)), ' cells can be deduced'];
  }

  function yinYangHintStatusNodes(h) {
    const total = (h.cells?.length || 0) + (h.extraCells?.length || 0);
    if (total === 0) return ['No hint available'];
    if (total === 1) {
      const cell = h.cells?.[0] || h.extraCells?.[0];
      const row = h.cells?.length ? h.index : cell.row;
      const col = h.cells?.length ? cell.index : cell.col;
      // Yin-Yang cellStatus: 1 = black, 2 = white.
      const valueStr = cell.value === 1 ? 'black' : 'white';
      return [
        'Cell ', bold(`(row ${row + 1}, col ${col + 1})`),
        ' must be ', bold(valueStr),
      ];
    }
    return [bold(String(total)), ' cells can be deduced'];
  }

  function shikakuHintStatusNodes(h) {
    const total = (h.cells?.length || 0) + (h.extraCells?.length || 0);
    if (total === 0) return ['No hint available'];
    if (h.clue) {
      return [
        'Draw the ', bold(`${h.clue.area}`), '-cell rectangle for the clue at ',
        bold(`(row ${h.clue.row + 1}, col ${h.clue.col + 1})`),
      ];
    }
    return [bold(String(total)), ' cells can be deduced'];
  }

  function slitherlinkHintStatusNodes(h) {
    const total = h?.edges?.length || 0;
    if (total === 0) return ['No hint available'];
    if (total === 1) {
      const e = h.edges[0];
      const desc = e.orientation === 'h'
        ? `the top of cell (row ${e.r + 1}, col ${e.c + 1}) / bottom of (row ${e.r}, col ${e.c + 1})`
        : `the left of cell (row ${e.r + 1}, col ${e.c + 1}) / right of (row ${e.r + 1}, col ${e.c})`;
      return ['Draw a line along ', bold(desc), '.'];
    }
    return [bold(String(total)), ' edges can be deduced'];
  }

  function hashiHintStatusNodes(h) {
    // Hashi hints are an array of { a, b, orientation, bridges } edges; bridges
    // is the deduced count (1 or 2, or 0 for "this connection is impossible").
    // Stepwise hints carry a .description naming the rule that fired — show it
    // verbatim so the user sees the logical reason for the deduction.
    const total = h?.edges?.length || 0;
    if (total === 0) return ['No hint available'];
    if (h.description) {
      return [bold(h.description)];
    }
    const islands = puzzleData?.islands || [];
    const fmtIsland = (idx) => {
      const isl = islands[idx];
      if (!isl) return `island ${idx}`;
      return `(row ${isl.row + 1}, col ${isl.col + 1})`;
    };
    if (total === 1) {
      const e = h.edges[0];
      const bridgeWord = e.bridges === 1 ? 'single bridge'
        : e.bridges === 2 ? 'double bridge'
        : `${e.bridges} bridges`;
      return [
        'Draw a ', bold(bridgeWord),
        ' between ', bold(fmtIsland(e.a)),
        ' and ', bold(fmtIsland(e.b)), '.',
      ];
    }
    return [bold(String(total)), ' bridges can be deduced'];
  }

  // Status + preview after a freshly computed hint. Used by hintHandler,
  // previewFirstLoopStep, and the state-watch debounce. Per-caller state
  // (pendingHint, applyHint button enable, puzzleData.solution updates)
  // stays at the call site.
  function renderHintStatusAndPreview(h, grid) {
    setHintStatus(h);
    if (grid) {
      // Hashi's drawPreview arm reads bridges from grid.edges; the hint
      // edges must be merged in first since hashi has no separate hint-
      // overlay branch (slitherlink/galaxies/cell-based hints paint via
      // dedicated overlay paths in drawPreview).
      if (h?.type === 'hashi') applyHintToGrid(grid, h);
      drawPreview(grid, h);
    }
  }

  function hintStatusNodes(h) {
    const label = h.type === 'row' ? 'Row' : 'Column';
    const clueStr = Array.isArray(h.clue) ? h.clue.join(', ') : null;
    const filled = h.cells.filter(c => c.value === 1).map(c => c.index + 1);
    const crossed = h.cells.filter(c => c.value === -1).map(c => c.index + 1);
    const extra = h.extraCells || [];

    const nodes = [bold(`${label} ${h.index + 1}`),
                   clueStr !== null ? ` (clue: ${clueStr}): ` : ': '];
    const segments = [];
    if (filled.length) segments.push(['cells ', bold(fmtList(filled)), ' must be filled']);
    if (crossed.length) segments.push(['cells ', bold(fmtList(crossed)), ' must be empty']);
    if (extra.length) {
      segments.push([bold(String(extra.length)),
        ' related aquarium cell' + (extra.length === 1 ? '' : 's') + ' can also be filled']);
    }
    for (let i = 0; i < segments.length; i++) {
      if (i > 0) nodes.push(', ');
      for (const seg of segments[i]) nodes.push(seg);
    }
    return nodes;
  }

  function setStatus(msg, type) {
    statusEl.textContent = msg;
    statusEl.className = 'ns-status' + (type ? ' ns-' + type : '');
  }

  // Safer replacement for the old setStatusHtml: appends DOM nodes directly,
  // never sets innerHTML. Strings become text nodes (HTML chars are not parsed).
  // Use bold() to wrap text in a <b>; pass arrays to splat-merge.
  function setStatusNodes(type, ...parts) {
    while (statusEl.firstChild) statusEl.removeChild(statusEl.firstChild);
    for (const p of parts) {
      if (p instanceof Node) statusEl.appendChild(p);
      else statusEl.appendChild(document.createTextNode(String(p)));
    }
    statusEl.className = 'ns-status' + (type ? ' ns-' + type : '');
  }

  function bold(text) {
    const b = document.createElement('b');
    b.textContent = text;
    return b;
  }

  // Render the "no puzzle detected" status with a clickable list of the
  // puzzle types this extension supports. Same content on the homepage
  // and on any unrecognized page within puzzles-mobile.com.
  function showSupportedPuzzles(detectError) {
    while (statusEl.firstChild) statusEl.removeChild(statusEl.firstChild);
    statusEl.className = 'ns-status ns-info';

    const header = document.createElement('div');
    header.appendChild(bold(detectError ? `No puzzle here: ${detectError}` : 'No puzzle on this page.'));
    statusEl.appendChild(header);

    const sub = document.createElement('div');
    sub.textContent = 'Supported puzzles:';
    sub.style.marginTop = '4px';
    statusEl.appendChild(sub);

    const list = document.createElement('ul');
    list.style.cssText = 'margin:2px 0 0 0;padding-left:18px;';
    for (const p of SUPPORTED_PUZZLES) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = p.url;
      a.textContent = p.name;
      a.style.color = 'inherit';
      li.appendChild(a);
      list.appendChild(li);
    }
    statusEl.appendChild(list);
  }

  // Cached state for drawPreview's incremental rendering.
  // - lastDrawSig: full signature of the last successful draw. Identical input
  //   skips the entire redraw (state-watch fires every 200ms even when nothing
  //   visually changed).
  // - latticeLayer: offscreen canvas with just the gray cell-border lattice.
  //   Drawn FIRST so dynamic fills paint over it (a black filled cell hides
  //   the gray border within its area, matching the pre-refactor look).
  // - staticLayer: offscreen canvas with region borders, nonogram every-5
  //   guides, and galaxies stars — pixels that should sit ON TOP of fills.
  //   Both rebuilt only when cellSize / regionMap / stars change.
  let lastDrawSig = null;
  let latticeLayer = null;
  let staticLayer = null;
  let staticLayerSig = null;

  // Identity-based hint signature: hints are typically replaced wholesale, not
  // mutated, so reference identity is a safe proxy for "same hint as last
  // tick". WeakMap+counter avoids JSON.stringify of the entire hint object
  // (galaxies hints can carry hundreds of lineHints) on every 200ms tick.
  let hintIdCounter = 0;
  const hintIdCache = new WeakMap();
  function hintSig(hint) {
    if (!hint) return '';
    let id = hintIdCache.get(hint);
    if (id === undefined) {
      id = ++hintIdCounter;
      hintIdCache.set(hint, id);
    }
    return id;
  }

  // FNV-1a 32-bit hash. Called per state-watch tick (every ~200ms) for grids
  // up to 50×50; the prior O(N²) string concat dominated the early-bail check
  // it fed. Cell values are shifted into a non-negative range before mixing.
  const FNV_OFFSET = 0x811c9dc5 | 0;
  const FNV_PRIME = 16777619;

  function regionMapSig(rm) {
    if (!rm) return 0;
    let h = FNV_OFFSET;
    for (let r = 0; r < rm.length; r++) {
      const row = rm[r];
      for (let c = 0; c < row.length; c++) {
        h ^= row[c];
        h = Math.imul(h, FNV_PRIME);
      }
      // Row separator so [[1,2],[3]] and [[1],[2,3]] don't collide.
      h ^= 0xff;
      h = Math.imul(h, FNV_PRIME);
    }
    return h;
  }

  // Sparse comparison-clue stable signature. FNV-like rolling number so a
  // change anywhere in the sparse 2D invalidates the static-layer cache.
  function comparisonCluesSig(cc) {
    if (!Array.isArray(cc) || cc.length === 0) return '0';
    let h = 0x811c9dc5;
    for (let r = 0; r < cc.length; r++) {
      const row = Array.isArray(cc[r]) ? cc[r] : [];
      for (let c = 0; c < row.length; c++) {
        h ^= r * 65537 + c * 31 + ((row[c] | 0) + 1);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
    }
    return (h >>> 0).toString(36);
  }

  function shikakuCluesSig(clues) {
    if (!Array.isArray(clues) || clues.length === 0) return '0';
    let h = 0x811c9dc5;
    for (const k of clues) {
      h ^= (k.row | 0) * 65537 + (k.col | 0) * 31 + (k.area | 0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return (h >>> 0).toString(36);
  }

  function slitherlinkCluesSig(task) {
    if (!Array.isArray(task)) return '';
    let h = 0x811c9dc5;
    for (let r = 0; r < task.length; r++) {
      const row = task[r] || [];
      for (let c = 0; c < row.length; c++) {
        h ^= (row[c] | 0) + 2;
        h = Math.imul(h, 0x01000193) >>> 0;
      }
    }
    return (h >>> 0).toString(16);
  }

  // Island-set stable signature for the hashi static layer (circles + numbers).
  // Bridge counts live in the dynamic layer / gridDataSig, NOT here.
  function hashiIslandsSig(islands) {
    if (!Array.isArray(islands) || islands.length === 0) return '0';
    let h = 0x811c9dc5;
    for (const i of islands) {
      h ^= (i.row | 0) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
      h ^= (i.col | 0) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
      h ^= (i.number | 0) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
    }
    return (h >>> 0).toString(36);
  }

  function hitoriTaskSig(task) {
    if (!task) return '0';
    let h = 0x811c9dc5;
    for (const row of task) for (const v of row) {
      h ^= v & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
    }
    return (h >>> 0).toString(16);
  }

  function kakurasuCluesSig(rowClues, colClues) {
    if (!rowClues || !colClues) return '0';
    let h = 0x811c9dc5;
    for (const v of rowClues) { h ^= v & 0xff; h = Math.imul(h, 0x01000193) >>> 0; }
    for (const v of colClues) { h ^= v & 0xff; h = Math.imul(h, 0x01000193) >>> 0; }
    return (h >>> 0).toString(16);
  }

  function kurodokoTaskSig(task) {
    if (!task) return '0';
    let h = 0x811c9dc5;
    for (const row of task) for (const v of row) {
      h ^= (v + 1) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
    }
    return (h >>> 0).toString(16);
  }

  function mosaicTaskSig(task) {
    if (!task) return '0';
    let h = 0x811c9dc5;
    for (const row of task) for (const v of row) {
      h ^= (v + 1) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
    }
    return (h >>> 0).toString(16);
  }

  // Room-boundary (areas) + target-numbers stable signature for the heyawake static layer.
  function heyawakeAreasSig(areas, rooms) {
    if (!Array.isArray(areas) || areas.length === 0) return '0';
    let h = 0x811c9dc5;
    for (const row of areas) {
      for (const v of row) {
        h ^= (v + 1) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
      }
    }
    if (Array.isArray(rooms)) {
      for (const room of rooms) {
        const t = room.target;
        h ^= (t + 1) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
      }
    }
    return (h >>> 0).toString(36);
  }

  function gridDataSig(grid) {
    // Hashi grids: { edges: [...] }. No 2D state — bridges encode everything
    // visible. (No .horizontal/.vertical, so test before the slitherlink arm.)
    if (grid && Array.isArray(grid.edges) && !grid.horizontal) {
      let h = 0x811c9dc5;
      for (const e of grid.edges) {
        h ^= (e.a | 0) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
        h ^= (e.b | 0) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
        h ^= (e.bridges | 0) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
      }
      return (h >>> 0).toString(16);
    }
    if (grid && grid.horizontal && grid.vertical) {
      let h = 0x811c9dc5;
      const mix = (n) => { h ^= n; h = Math.imul(h, 0x01000193) >>> 0; };
      for (const row of grid.horizontal) for (const v of row) mix(v | 0);
      mix(0xFF);
      for (const row of grid.vertical) for (const v of row) mix(v | 0);
      if (grid.galaxies) {
        mix(0xEE);
        for (const row of grid.galaxies.horizontal || []) for (const v of row) mix(v | 0);
        for (const row of grid.galaxies.vertical   || []) for (const v of row) mix(v | 0);
      }
      return (h >>> 0).toString(16);
    }
    let h = FNV_OFFSET;
    for (let r = 0; r < grid.length; r++) {
      const row = grid[r];
      for (let c = 0; c < row.length; c++) {
        h ^= (row[c] + 2);  // shift {-1, 0, 1, star indices} into positives
        h = Math.imul(h, FNV_PRIME);
      }
    }
    if (grid.galaxies) {
      const g = grid.galaxies;
      if (g.horizontal) {
        for (const row of g.horizontal) {
          for (const v of row) {
            h ^= (v + 2);
            h = Math.imul(h, FNV_PRIME);
          }
          h ^= 0xfe;
          h = Math.imul(h, FNV_PRIME);
        }
      }
      if (g.vertical) {
        for (const row of g.vertical) {
          for (const v of row) {
            h ^= (v + 2);
            h = Math.imul(h, FNV_PRIME);
          }
          h ^= 0xfd;
          h = Math.imul(h, FNV_PRIME);
        }
      }
    }
    return h;
  }

  // Cell-border lattice — batched into one Path2D so the offscreen build is
  // O(rows + cols) strokes instead of the rows*cols strokeRects the old
  // per-tick code did.
  function buildLatticeLayer(rows, cols, cellSize, w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.strokeStyle = '#d1d5db';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (let r = 0; r <= rows; r++) {
      ctx.moveTo(0, r * cellSize);
      ctx.lineTo(w, r * cellSize);
    }
    for (let cc = 0; cc <= cols; cc++) {
      ctx.moveTo(cc * cellSize, 0);
      ctx.lineTo(cc * cellSize, h);
    }
    ctx.stroke();
    return c;
  }

  function buildStaticLayer(rows, cols, cellSize, w, h, pd) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    drawRegionBordersOn(ctx, rows, cols, cellSize, pd?.regionMap);
    drawNonogramGuidesOn(ctx, rows, cols, cellSize, w, h, pd);
    if (pd?.type === 'galaxies' && pd.stars) {
      ctx.fillStyle = '#111827';
      for (const star of pd.stars) {
        const cx = ((star.col + 1) / 2) * cellSize;
        const cy = ((star.row + 1) / 2) * cellSize;
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(3, cellSize / 7), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (pd?.type === 'binairo' && Array.isArray(pd.comparisonClues)) {
      drawComparisonCluesOn(ctx, cellSize, pd.comparisonClues);
    }
    if (pd?.type === 'shikaku' && Array.isArray(pd.clues)) {
      drawShikakuCluesOn(ctx, cellSize, pd.clues);
    }
    if (pd?.type === 'hashi' && Array.isArray(pd.islands)) {
      drawHashiIslandsOn(ctx, cellSize, pd.islands);
    }
    if (pd?.type === 'slitherlink') {
      const dotR = Math.max(1.5, cellSize / 14);
      ctx.fillStyle = '#1f2937';
      for (let r = 0; r <= rows; r++) {
        for (let c = 0; c <= cols; c++) {
          ctx.beginPath();
          ctx.arc(c * cellSize, r * cellSize, dotR, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      const fontPx = Math.max(8, Math.floor(cellSize * 0.55));
      ctx.font = `bold ${fontPx}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#1f2937';
      const task = pd.task || [];
      for (let r = 0; r < rows; r++) {
        const row = task[r] || [];
        for (let c = 0; c < cols; c++) {
          const v = row[c];
          if (v === 0 || v === 1 || v === 2 || v === 3) {
            ctx.fillText(String(v), c * cellSize + cellSize / 2, r * cellSize + cellSize / 2);
          }
        }
      }
    }
    if (pd?.type === 'heyawake' && Array.isArray(pd.areas)) {
      drawHeyawakeRoomsOn(ctx, rows, cols, cellSize, pd.areas, pd.rooms);
    }
    if (pd?.type === 'hitori') {
      // Outer border only — clue digits are on the dynamic layer (shading
      // changes text colour, so they can't be cached here).
      const borderW = Math.max(2, Math.floor(cellSize / 5));
      ctx.strokeStyle = '#1f2937';
      ctx.lineWidth = borderW;
      ctx.lineCap = 'square';
      ctx.strokeRect(borderW / 2, borderW / 2, cols * cellSize - borderW, rows * cellSize - borderW);
    }
    if (pd?.type === 'kakurasu' && Array.isArray(pd.rowClues) && Array.isArray(pd.colClues)) {
      // Outer border of the N×N playing area.
      const borderW = Math.max(2, Math.floor(cellSize / 5));
      ctx.strokeStyle = '#1f2937';
      ctx.lineWidth = borderW;
      ctx.lineCap = 'square';
      ctx.strokeRect(borderW / 2, borderW / 2, cols * cellSize - borderW, rows * cellSize - borderW);
      // Row clues on the right edge: cell at (r, cols).
      const fontPx = Math.max(8, Math.floor(cellSize * 0.5));
      ctx.font = `bold ${fontPx}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#1f2937';
      for (let r = 0; r < rows; r++) {
        const cx = cols * cellSize + cellSize / 2;
        const cy = r * cellSize + cellSize / 2;
        ctx.fillText(String(pd.rowClues[r]), cx, cy);
      }
      // Column clues on the bottom edge: cell at (rows, c).
      for (let cc = 0; cc < cols; cc++) {
        const cx = cc * cellSize + cellSize / 2;
        const cy = rows * cellSize + cellSize / 2;
        ctx.fillText(String(pd.colClues[cc]), cx, cy);
      }
    }
    if (pd?.type === 'kurodoko') {
      // Outer border only — clue digits are on the dynamic layer (cell
      // shading changes text colour, so they can't be pre-rendered here).
      const borderW = Math.max(2, Math.floor(cellSize / 5));
      ctx.strokeStyle = '#1f2937';
      ctx.lineWidth = borderW;
      ctx.lineCap = 'square';
      ctx.strokeRect(borderW / 2, borderW / 2, cols * cellSize - borderW, rows * cellSize - borderW);
    }
    return c;
  }

  function drawComparisonCluesOn(ctx, cellSize, comparisonClues) {
    const fontSize = Math.max(8, Math.floor(cellSize * 0.45));
    ctx.save();
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#fff';
    ctx.fillStyle = '#1f2937';
    for (let r = 0; r < comparisonClues.length; r++) {
      const row = comparisonClues[r];
      if (!Array.isArray(row)) continue;
      for (let c = 0; c < row.length; c++) {
        const flag = row[c];
        if (typeof flag !== 'number' || flag === 0) continue;
        // Right edge (between (r,c) and (r,c+1))
        if (flag & 3) {
          const x = (c + 1) * cellSize;
          const y = r * cellSize + cellSize / 2;
          const ch = (flag & 1) ? '=' : '×';
          ctx.strokeText(ch, x, y);
          ctx.fillText(ch, x, y);
        }
        // Bottom edge (between (r,c) and (r+1,c))
        if (flag & 12) {
          const x = c * cellSize + cellSize / 2;
          const y = (r + 1) * cellSize;
          const ch = (flag & 4) ? '=' : '×';
          ctx.strokeText(ch, x, y);
          ctx.fillText(ch, x, y);
        }
      }
    }
    ctx.restore();
  }

  function drawShikakuCluesOn(ctx, cellSize, clues) {
    const fontSize = Math.max(10, Math.floor(cellSize * 0.5));
    ctx.save();
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#fff';
    ctx.fillStyle = '#111827';
    for (const k of clues) {
      const x = k.col * cellSize + cellSize / 2;
      const y = k.row * cellSize + cellSize / 2;
      const ch = String(k.area);
      ctx.strokeText(ch, x, y);
      ctx.fillText(ch, x, y);
    }
    ctx.restore();
  }

  // Numbered island circles for hashi. Cached in the static layer (island set
  // changes only on a fresh detect). Bridges paint in the dynamic layer, so
  // re-drawing the circles AFTER bridges in the main loop keeps the centre
  // disc covering any bridge stubs that might otherwise poke through.
  function drawHashiIslandsOn(ctx, cellSize, islands) {
    const radius = cellSize * 0.35;
    const fontSize = Math.max(8, Math.floor(cellSize * 0.5));
    ctx.save();
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const i of islands) {
      const cx = i.col * cellSize + cellSize / 2;
      const cy = i.row * cellSize + cellSize / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = '#1f2937';
      ctx.lineWidth = Math.max(1.5, cellSize / 14);
      ctx.stroke();
      ctx.fillStyle = '#1f2937';
      ctx.fillText(String(i.number), cx, cy);
    }
    ctx.restore();
  }

  // Thick black borders between distinct room IDs + room-target clue numbers
  // for heyawake. Drawn once into the cached static layer; reused until the
  // puzzle shape changes.  `areas` is the 2-D room-ID map; `rooms` is the
  // parallel array of { cells, target } metadata indexed by room ID.
  function drawHeyawakeRoomsOn(ctx, rows, cols, cellSize, areas, rooms) {
    if (!areas) return;
    ctx.save();

    // Outer border — thick black frame around the entire grid.
    const borderW = Math.max(2, Math.floor(cellSize / 5));
    ctx.strokeStyle = '#1f2937';
    ctx.lineWidth = borderW;
    ctx.lineCap = 'square';
    ctx.strokeRect(borderW / 2, borderW / 2, cols * cellSize - borderW, rows * cellSize - borderW);

    // Interior room borders: draw on the shared edge whenever the two
    // adjacent cells belong to different rooms.
    ctx.lineWidth = borderW;
    ctx.beginPath();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const id = (areas[r] || [])[c] || 0;
        // right neighbour
        if (c + 1 < cols && ((areas[r] || [])[c + 1] || 0) !== id) {
          const x = (c + 1) * cellSize;
          const y = r * cellSize;
          ctx.moveTo(x, y);
          ctx.lineTo(x, y + cellSize);
        }
        // bottom neighbour
        if (r + 1 < rows && ((areas[r + 1] || [])[c] || 0) !== id) {
          const x = c * cellSize;
          const y = (r + 1) * cellSize;
          ctx.moveTo(x, y);
          ctx.lineTo(x + cellSize, y);
        }
      }
    }
    ctx.stroke();

    // Clue numbers: one per room, at the top-left cell of the room (the
    // first cell encountered in row-major order whose room has target >= 0).
    const fontSize = Math.max(8, Math.floor(cellSize * 0.5));
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const seen = new Set();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const id = (areas[r] || [])[c] || 0;
        if (seen.has(id)) continue;
        seen.add(id);
        const room = Array.isArray(rooms) ? rooms[id] : null;
        if (!room || room.target < 0) continue;
        const pad = Math.max(1, Math.floor(cellSize * 0.1));
        // White stroke for legibility on dark/filled cells.
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = Math.max(2, Math.floor(cellSize / 8));
        ctx.strokeText(String(room.target), c * cellSize + pad, r * cellSize + pad);
        ctx.fillStyle = '#1f2937';
        ctx.fillText(String(room.target), c * cellSize + pad, r * cellSize + pad);
      }
    }

    ctx.restore();
  }

  function drawRegionBordersOn(ctx, rows, cols, cellSize, rm) {
    if (!rm) return;
    ctx.save();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = Math.max(3, Math.floor(cellSize / 5));
    ctx.lineCap = 'square';
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = c * cellSize, y = r * cellSize;
        const id = rm[r][c];
        if (c + 1 < cols && rm[r][c + 1] !== id) {
          ctx.beginPath();
          ctx.moveTo(x + cellSize, y);
          ctx.lineTo(x + cellSize, y + cellSize);
          ctx.stroke();
        }
        if (r + 1 < rows && rm[r + 1][c] !== id) {
          ctx.beginPath();
          ctx.moveTo(x, y + cellSize);
          ctx.lineTo(x + cellSize, y + cellSize);
          ctx.stroke();
        }
      }
    }
    ctx.strokeStyle = '#6b7280';
    ctx.lineWidth = Math.max(1, Math.floor(cellSize / 12));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = c * cellSize, y = r * cellSize;
        const id = rm[r][c];
        if (c + 1 < cols && rm[r][c + 1] !== id) {
          ctx.beginPath();
          ctx.moveTo(x + cellSize, y);
          ctx.lineTo(x + cellSize, y + cellSize);
          ctx.stroke();
        }
        if (r + 1 < rows && rm[r + 1][c] !== id) {
          ctx.beginPath();
          ctx.moveTo(x, y + cellSize);
          ctx.lineTo(x + cellSize, y + cellSize);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  function drawNonogramGuidesOn(ctx, rows, cols, cellSize, w, h, pd) {
    if (pd?.regionMap || pd?.type === 'galaxies' || pd?.type === 'binairo' || pd?.type === 'shikaku' || pd?.type === 'yinyang' || pd?.type === 'slitherlink' || pd?.type === 'hashi' || pd?.type === 'heyawake' || pd?.type === 'hitori' || pd?.type === 'kakurasu' || pd?.type === 'kurodoko' || pd?.type === 'mosaic') return;
    ctx.save();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = Math.max(3, Math.floor(cellSize / 5));
    ctx.lineCap = 'square';
    for (let c = 5; c < cols; c += 5) {
      ctx.beginPath();
      ctx.moveTo(c * cellSize, 0);
      ctx.lineTo(c * cellSize, h);
      ctx.stroke();
    }
    for (let r = 5; r < rows; r += 5) {
      ctx.beginPath();
      ctx.moveTo(0, r * cellSize);
      ctx.lineTo(w, r * cellSize);
      ctx.stroke();
    }
    ctx.strokeStyle = '#6b7280';
    ctx.lineWidth = Math.max(1, Math.floor(cellSize / 12));
    for (let c = 5; c < cols; c += 5) {
      ctx.beginPath();
      ctx.moveTo(c * cellSize, 0);
      ctx.lineTo(c * cellSize, h);
      ctx.stroke();
    }
    for (let r = 5; r < rows; r += 5) {
      ctx.beginPath();
      ctx.moveTo(0, r * cellSize);
      ctx.lineTo(w, r * cellSize);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawPreview(grid, hint) {
    const isSlitherlink = puzzleData?.type === 'slitherlink';
    const isHashi = puzzleData?.type === 'hashi';
    // Hashi's "grid" is { edges }: no 2D extent, so rows/cols come from
    // puzzleData.{rows,cols}. Slitherlink also takes rows/cols from puzzleData
    // when present (the H/V arrays imply them, but pd is authoritative).
    let rows, cols;
    if (isHashi) {
      rows = puzzleData?.rows || 0;
      cols = puzzleData?.cols || 0;
    } else if (isSlitherlink) {
      rows = puzzleData?.rows || (grid.horizontal ? grid.horizontal.length - 1 : 0);
      cols = puzzleData?.cols || (grid.horizontal ? (grid.horizontal[0] || []).length : 0);
    } else {
      rows = grid.length;
      cols = grid[0].length;
    }
    const isKakurasu = puzzleData?.type === 'kakurasu';
    const bodyWidth = q('.ns-body').clientWidth || 300;
    // Kakurasu needs a (cols+1)×(rows+1) canvas: N×N play grid plus a right
    // column for row clues and a bottom row for column clues.
    const cellSizeDenC = isKakurasu ? cols + 1 : cols;
    const cellSizeDenR = isKakurasu ? rows + 1 : rows;
    const cellSize = Math.min(Math.floor((bodyWidth - 4) / cellSizeDenC), Math.floor(350 / cellSizeDenR), 24);
    const w = cols * cellSize, h = rows * cellSize;
    const wFull = isKakurasu ? (cols + 1) * cellSize : w;
    const hFull = isKakurasu ? (rows + 1) * cellSize : h;

    // Idempotent: ensure the preview is visible whether or not we redraw.
    previewWrap.classList.add('ns-visible');

    // Early bail: if everything that affects pixels is identical to the
    // previous draw, skip the entire redraw. The state-watch MutationObserver
    // fires on every DOM tick (~200ms) — most of those don't change cell values.
    const pd = puzzleData;
    const sig = rows + 'x' + cols + '@' + cellSize + '|t=' + (pd?.type || '') +
                '|rm=' + regionMapSig(pd?.regionMap) +
                '|st=' + (pd?.stars ? pd.stars.map(s => s.row + ',' + s.col).join(';') : '') +
                '|g=' + gridDataSig(grid) +
                '|h=' + hintSig(hint) +
                '|sol=' + (pd?.solution ? '1' : '0');
    if (sig === lastDrawSig) return;
    lastDrawSig = sig;

    // (Re)build the static layers if puzzle shape or size changed.
    const staticSig = rows + 'x' + cols + '@' + cellSize + '|t=' + (pd?.type || '') +
                      '|rm=' + regionMapSig(pd?.regionMap) +
                      '|st=' + (pd?.stars ? pd.stars.map(s => s.row + ',' + s.col).join(';') : '') +
                      '|cc=' + comparisonCluesSig(pd?.comparisonClues) +
                      '|sk=' + shikakuCluesSig(pd?.type === 'shikaku' ? pd.clues : null) +
                      '|sl=' + slitherlinkCluesSig(pd?.type === 'slitherlink' ? pd.task : null) +
                      '|hi=' + hashiIslandsSig(pd?.type === 'hashi' ? pd.islands : null) +
                      '|hy=' + heyawakeAreasSig(pd?.type === 'heyawake' ? pd.areas : null, pd?.type === 'heyawake' ? pd.rooms : null) +
                      '|hi=' + hitoriTaskSig(pd?.type === 'hitori' ? pd.task : null) +
                      '|ka=' + kakurasuCluesSig(pd?.type === 'kakurasu' ? pd.rowClues : null, pd?.type === 'kakurasu' ? pd.colClues : null) +
                      '|kd=' + kurodokoTaskSig(pd?.type === 'kurodoko' ? pd.task : null) +
                      '|mc=' + mosaicTaskSig(pd?.type === 'mosaic' ? pd.task : null);
    if (staticSig !== staticLayerSig) {
      latticeLayer = buildLatticeLayer(rows, cols, cellSize, wFull, hFull);
      staticLayer = buildStaticLayer(rows, cols, cellSize, wFull, hFull, pd);
      staticLayerSig = staticSig;
    }

    canvas.width = wFull; canvas.height = hFull;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, wFull, hFull);
    // Lattice goes UNDER dynamic fills so filled cells hide the grey
    // cell-border lines inside them. Region borders + galaxy stars come
    // from the second static layer below, painted on top.
    if (latticeLayer) ctx.drawImage(latticeLayer, 0, 0);

    // Empty-cell X marks are batched into one stroke pass so their shared
    // strokeStyle/lineWidth set up only once.
    const galaxiesColors = ['#dbeafe', '#fee2e2', '#dcfce7', '#fef3c7', '#ede9fe', '#cffafe', '#fce7f3', '#e5e7eb'];
    const xPad = Math.max(1, Math.floor(cellSize / 5));
    const isShikaku = puzzleData?.type === 'shikaku';
    const isBinairo = puzzleData?.type === 'binairo';
    const isYinYang = puzzleData?.type === 'yinyang';
    const isHitori = puzzleData?.type === 'hitori';
    const isKurodoko = puzzleData?.type === 'kurodoko';
    const discR = isBinairo ? Math.max(2, Math.floor(cellSize * 0.35)) : 0;
    if (isSlitherlink) {
      ctx.save();
      ctx.strokeStyle = '#1f2937';
      ctx.lineWidth = Math.max(2, Math.floor(cellSize / 6));
      ctx.lineCap = 'round';
      const hg = grid.horizontal || [];
      for (let r = 0; r <= rows; r++) {
        const row = hg[r] || [];
        for (let c = 0; c < cols; c++) {
          if (row[c] === 1) {
            ctx.beginPath();
            ctx.moveTo(c * cellSize, r * cellSize);
            ctx.lineTo((c + 1) * cellSize, r * cellSize);
            ctx.stroke();
          }
        }
      }
      const vg = grid.vertical || [];
      for (let r = 0; r < rows; r++) {
        const row = vg[r] || [];
        for (let c = 0; c <= cols; c++) {
          if (row[c] === 1) {
            ctx.beginPath();
            ctx.moveTo(c * cellSize, r * cellSize);
            ctx.lineTo(c * cellSize, (r + 1) * cellSize);
            ctx.stroke();
          }
        }
      }
      // × marks for EMPTY (=2) edges. Half the LINE thickness, in a muted gray
      // so they're visually subordinate to the loop itself.
      ctx.strokeStyle = '#9aa0a6';
      ctx.lineWidth = Math.max(1, Math.floor(cellSize / 12));
      ctx.lineCap = 'round';
      const xMarkSize = Math.max(3, Math.floor(cellSize / 5));
      for (let r = 0; r <= rows; r++) {
        const row = (hg)[r] || [];
        for (let c = 0; c < cols; c++) {
          if (row[c] !== 2) continue;
          const midX = (c + 0.5) * cellSize;
          const midY = r * cellSize;
          ctx.beginPath();
          ctx.moveTo(midX - xMarkSize / 2, midY - xMarkSize / 2);
          ctx.lineTo(midX + xMarkSize / 2, midY + xMarkSize / 2);
          ctx.moveTo(midX + xMarkSize / 2, midY - xMarkSize / 2);
          ctx.lineTo(midX - xMarkSize / 2, midY + xMarkSize / 2);
          ctx.stroke();
        }
      }
      for (let r = 0; r < rows; r++) {
        const row = (vg)[r] || [];
        for (let c = 0; c <= cols; c++) {
          if (row[c] !== 2) continue;
          const midX = c * cellSize;
          const midY = (r + 0.5) * cellSize;
          ctx.beginPath();
          ctx.moveTo(midX - xMarkSize / 2, midY - xMarkSize / 2);
          ctx.lineTo(midX + xMarkSize / 2, midY + xMarkSize / 2);
          ctx.moveTo(midX + xMarkSize / 2, midY - xMarkSize / 2);
          ctx.lineTo(midX - xMarkSize / 2, midY + xMarkSize / 2);
          ctx.stroke();
        }
      }
      ctx.restore();
    } else if (isHashi) {
      // Hashi bridges. Single bridges render as one centered line; double
      // bridges as two parallel lines offset ±bridgeOffset perpendicular to
      // the bridge direction. The island circles in the static layer cover
      // each line's endpoints, so we stroke from island-center to
      // island-center and let the circles mask the inner stubs.
      const islands = puzzleData?.islands || [];
      const bridgeOffset = Math.max(2, Math.floor(cellSize / 7));
      ctx.save();
      ctx.strokeStyle = '#1a73e8';
      ctx.lineWidth = Math.max(2, Math.floor(cellSize / 9));
      ctx.lineCap = 'butt';
      const edges = grid?.edges || [];
      for (const e of edges) {
        if (!e || !e.bridges) continue;
        const ia = islands[e.a], ib = islands[e.b];
        if (!ia || !ib) continue;
        const ax = ia.col * cellSize + cellSize / 2;
        const ay = ia.row * cellSize + cellSize / 2;
        const bx = ib.col * cellSize + cellSize / 2;
        const by = ib.row * cellSize + cellSize / 2;
        if (e.orientation === 'H') {
          if (e.bridges === 1) {
            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.lineTo(bx, by);
            ctx.stroke();
          } else {
            ctx.beginPath();
            ctx.moveTo(ax, ay - bridgeOffset);
            ctx.lineTo(bx, by - bridgeOffset);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(ax, ay + bridgeOffset);
            ctx.lineTo(bx, by + bridgeOffset);
            ctx.stroke();
          }
        } else {
          if (e.bridges === 1) {
            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.lineTo(bx, by);
            ctx.stroke();
          } else {
            ctx.beginPath();
            ctx.moveTo(ax - bridgeOffset, ay);
            ctx.lineTo(bx - bridgeOffset, by);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(ax + bridgeOffset, ay);
            ctx.lineTo(bx + bridgeOffset, by);
            ctx.stroke();
          }
        }
      }
      ctx.restore();
    } else {
      let xMarkPath = null;
      ctx.fillStyle = '#1f2937';
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const v = grid[r][c];
          if (v === 0 && !isShikaku && !isHitori && !isKakurasu && !isKurodoko) continue;
          if (v === -1 && isShikaku) continue;
          const x = c * cellSize, y = r * cellSize;
          if (isShikaku) {
            if (v >= 0) {
              ctx.fillStyle = galaxiesColors[v % galaxiesColors.length];
              ctx.fillRect(x + 1, y + 1, cellSize - 2, cellSize - 2);
            }
          } else if (isBinairo) {
            // cellStatus encoding: 1 = "one" cells (page shows as light/outlined),
            // 2 = "zero" cells (page shows as dark/filled). Match that polarity.
            const cx = x + cellSize / 2, cy = y + cellSize / 2;
            if (v === 1) {
              ctx.fillStyle = '#fff';
              ctx.strokeStyle = '#1f2937';
              ctx.lineWidth = Math.max(1.5, cellSize / 14);
              ctx.beginPath();
              ctx.arc(cx, cy, discR, 0, Math.PI * 2);
              ctx.fill();
              ctx.stroke();
            } else if (v === 2) {
              ctx.fillStyle = '#1f2937';
              ctx.beginPath();
              ctx.arc(cx, cy, discR, 0, Math.PI * 2);
              ctx.fill();
            }
          } else if (isYinYang) {
            // cellStatus 1 renders light, 2 renders dark — matching the game
            // (Yin-Yang shares Binairo's cell encoding/polarity).
            const yyInset = Math.max(1, Math.floor(cellSize * 0.15));
            const yySide = cellSize - 2 * yyInset;
            const sx = x + yyInset, sy = y + yyInset;
            if (v === 1) {
              ctx.fillStyle = '#fff';
              ctx.fillRect(sx, sy, yySide, yySide);
              ctx.strokeStyle = '#1f2937';
              ctx.lineWidth = Math.max(1.5, cellSize / 14);
              ctx.strokeRect(sx, sy, yySide, yySide);
            } else if (v === 2) {
              ctx.fillStyle = '#1f2937';
              ctx.fillRect(sx, sy, yySide, yySide);
            }
            // Given cells get a small contrasting centre square.
            const given = puzzleData?.task?.[r]?.[c];
            if (given === 0 || given === 1) {
              const dotSide = Math.max(2, Math.floor(cellSize * 0.2));
              ctx.fillStyle = v === 1 ? '#1f2937' : '#fff';
              ctx.fillRect(x + (cellSize - dotSide) / 2, y + (cellSize - dotSide) / 2, dotSide, dotSide);
            }
          } else if (puzzleData?.type === 'galaxies' && v > 0) {
            ctx.fillStyle = galaxiesColors[(v - 1) % galaxiesColors.length];
            ctx.fillRect(x + 1, y + 1, cellSize - 2, cellSize - 2);
          } else if (puzzleData?.type === 'heyawake') {
            // cellStatus 1 = black cell; 2 = white-marked (not black, confirmed
            // empty). Render black as a solid dark fill; white-marker as a small
            // grey dot at the cell centre so the player can see deduced empties.
            if (v === 1) {
              ctx.fillStyle = '#1f2937';
              ctx.fillRect(x, y, cellSize, cellSize);
            } else if (v === 2) {
              const dotR = Math.max(2, Math.floor(cellSize * 0.15));
              ctx.fillStyle = '#9ca3af';
              ctx.beginPath();
              ctx.arc(x + cellSize / 2, y + cellSize / 2, dotR, 0, Math.PI * 2);
              ctx.fill();
            }
          } else if (isHitori) {
            // Hitori: every cell shows its clue digit. Reversed convention —
            // unshaded cells (v=2) get the dark fill (digit in light colour),
            // shaded cells (v=1) stay light with a dark digit. Unknown (v=0)
            // stays light/neutral so the initial board is fully readable.
            if (v === 2) {
              ctx.fillStyle = '#1f2937';
              ctx.fillRect(x, y, cellSize, cellSize);
            }
            const clueVal = pd?.task?.[r]?.[c] ?? 0;
            const ch = (clueVal >= 10 && clueVal <= 35)
              ? String.fromCharCode(clueVal + 87)
              : String(clueVal);
            ctx.font = `bold ${Math.floor(cellSize * 0.55)}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = v === 2 ? '#f3f4f6' : '#1f2937';
            ctx.fillText(ch, x + cellSize / 2, y + cellSize / 2);
          } else if (isKakurasu) {
            // Kakurasu: v=1 filled (dark square inset), v=2 crossed (two
            // diagonal strokes), v=0 unknown (empty — handled by early-bail
            // check above but also fine to fall through to nothing).
            if (v === 1) {
              const pad = Math.max(2, Math.floor(cellSize * 0.1));
              ctx.fillStyle = '#1f2937';
              ctx.fillRect(x + pad, y + pad, cellSize - 2 * pad, cellSize - 2 * pad);
            } else if (v === 2) {
              const pad = Math.max(3, Math.floor(cellSize * 0.25));
              ctx.strokeStyle = '#9ca3af';
              ctx.lineWidth = 2;
              ctx.beginPath();
              ctx.moveTo(x + pad, y + pad);
              ctx.lineTo(x + cellSize - pad, y + cellSize - pad);
              ctx.moveTo(x + cellSize - pad, y + pad);
              ctx.lineTo(x + pad, y + cellSize - pad);
              ctx.stroke();
            }
          } else if (isKurodoko) {
            // Kurodoko: every cell shows clue digit if it's a clue cell.
            // v=1 = black cell (solid dark fill); v=2 = confirmed white/empty
            // (× cross so the player can see deduced whites); v=0 = unknown
            // (blank — skipped by early-bail unless clue cell).
            const taskVal = (pd?.task?.[r]?.[c] ?? -1);
            if (taskVal !== -1) {
              // Clue cell: show the number. If also marked black, fill dark
              // first so the digit renders in light colour on top.
              ctx.font = `bold ${Math.floor(cellSize * 0.5)}px sans-serif`;
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              if (v === 1) {
                ctx.fillStyle = '#1f2937';
                ctx.fillRect(x, y, cellSize, cellSize);
                ctx.fillStyle = '#f3f4f6';
              } else {
                ctx.fillStyle = '#1f2937';
              }
              ctx.fillText(String(taskVal), x + cellSize / 2, y + cellSize / 2);
            } else if (v === 1) {
              ctx.fillStyle = '#1f2937';
              ctx.fillRect(x, y, cellSize, cellSize);
            } else if (v === 2) {
              const pad = Math.max(3, Math.floor(cellSize * 0.25));
              ctx.strokeStyle = '#9ca3af';
              ctx.lineWidth = 2;
              ctx.beginPath();
              ctx.moveTo(x + pad, y + pad);
              ctx.lineTo(x + cellSize - pad, y + cellSize - pad);
              ctx.moveTo(x + cellSize - pad, y + pad);
              ctx.lineTo(x + pad, y + cellSize - pad);
              ctx.stroke();
            }
            // v === 0 non-clue → blank (already excluded by early-bail above)
          } else if (v === 1) {
            ctx.fillStyle = '#1f2937';
            ctx.fillRect(x, y, cellSize, cellSize);
          } else if (v === -1) {
            if (!xMarkPath) xMarkPath = new Path2D();
            xMarkPath.moveTo(x + xPad, y + xPad);
            xMarkPath.lineTo(x + cellSize - xPad, y + cellSize - xPad);
            xMarkPath.moveTo(x + cellSize - xPad, y + xPad);
            xMarkPath.lineTo(x + xPad, y + cellSize - xPad);
          }
        }
      }
      if (xMarkPath) {
        ctx.strokeStyle = '#999';
        ctx.lineWidth = 1;
        ctx.stroke(xMarkPath);
      }
    }

    if (puzzleData?.type === 'galaxies') {
      ctx.save();
      ctx.strokeStyle = '#1f2937';
      ctx.lineWidth = Math.max(2, Math.floor(cellSize / 8));
      const glines = grid.galaxies;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = c * cellSize, y = r * cellSize;
          if (c + 1 < cols && (grid[r][c + 1] !== grid[r][c] || glines?.vertical?.[r]?.[c + 1] === 1)) {
            ctx.beginPath(); ctx.moveTo(x + cellSize, y); ctx.lineTo(x + cellSize, y + cellSize); ctx.stroke();
          }
          if (r + 1 < rows && (grid[r + 1][c] !== grid[r][c] || glines?.horizontal?.[r + 1]?.[c] === 1)) {
            ctx.beginPath(); ctx.moveTo(x, y + cellSize); ctx.lineTo(x + cellSize, y + cellSize); ctx.stroke();
          }
        }
      }
      // Stars themselves are part of the cached static layer (puzzle-shape only).
      ctx.restore();
    }

    if (puzzleData?.type === 'shikaku') {
      ctx.save();
      ctx.strokeStyle = '#1f2937';
      ctx.lineWidth = Math.max(2, Math.floor(cellSize / 8));
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = c * cellSize, y = r * cellSize;
          const v = grid[r][c];
          if (c + 1 < cols && grid[r][c + 1] !== v) {
            ctx.beginPath(); ctx.moveTo(x + cellSize, y); ctx.lineTo(x + cellSize, y + cellSize); ctx.stroke();
          }
          if (r + 1 < rows && grid[r + 1][c] !== v) {
            ctx.beginPath(); ctx.moveTo(x, y + cellSize); ctx.lineTo(x + cellSize, y + cellSize); ctx.stroke();
          }
        }
      }
      ctx.restore();
    }

    if (isSlitherlink && hint && Array.isArray(hint.edges)) {
      ctx.save();
      ctx.strokeStyle = '#2e86de';
      ctx.lineWidth = Math.max(3, Math.floor(cellSize / 5));
      ctx.lineCap = 'round';
      for (const e of hint.edges) {
        if (e.orientation === 'h') {
          ctx.beginPath();
          ctx.moveTo(e.c * cellSize, e.r * cellSize);
          ctx.lineTo((e.c + 1) * cellSize, e.r * cellSize);
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.moveTo(e.c * cellSize, e.r * cellSize);
          ctx.lineTo(e.c * cellSize, (e.r + 1) * cellSize);
          ctx.stroke();
        }
      }
      ctx.restore();
    } else if (hint) {
      const highlightColor = 'rgba(46, 134, 222, 0.25)';
      const fillColor = 'rgba(46, 134, 222, 0.45)';
      const crossColor = 'rgba(230, 57, 70, 0.45)';
      if (hint.type === 'galaxies') {
        ctx.save();
        ctx.strokeStyle = '#2e86de';
        ctx.lineWidth = Math.max(4, Math.floor(cellSize / 5));
        ctx.lineCap = 'round';
        for (const item of hint.lineHints || [hint]) {
          ctx.beginPath();
          if (item.orientation === 'horizontal') {
            ctx.moveTo(item.col * cellSize + 2, item.row * cellSize);
            ctx.lineTo((item.col + 1) * cellSize - 2, item.row * cellSize);
          } else {
            ctx.moveTo(item.col * cellSize, item.row * cellSize + 2);
            ctx.lineTo(item.col * cellSize, (item.row + 1) * cellSize - 2);
          }
          ctx.stroke();
        }
        ctx.restore();
      } else if (puzzleData?.type === 'shikaku') {
        // Shikaku hints reveal a rectangle, not a row/column — skip the
        // band highlight; the per-cell loop below paints each hint cell.
      } else if (puzzleData?.type === 'heyawake') {
        // Heyawake hints are absolute cells (extraCells) — no row/column
        // band; the per-cell loop below paints each hint cell.
      } else if (puzzleData?.type === 'hitori') {
        // Hitori hints are absolute cells (extraCells) — no row/column band.
      } else if (isKakurasu) {
        // Kakurasu hints are absolute cells (extraCells) — no row/column band.
      } else if (isKurodoko) {
        // Kurodoko hints are absolute cells (extraCells) — no row/column band.
      } else if (hint.type === 'hashi') {
        // Hashi hint edges are already merged into grid.edges by
        // applyHintToGrid and painted by the dynamic-bridges branch above.
        // No row/column band highlight, no per-cell loop applies.
      } else if (hint.type === 'row') {
        ctx.fillStyle = highlightColor;
        ctx.fillRect(0, hint.index * cellSize, w, cellSize);
      } else {
        ctx.fillStyle = highlightColor;
        ctx.fillRect(hint.index * cellSize, 0, cellSize, h);
      }
      // hintAbsoluteCells normalizes hint.cells (row/col-indexed via
      // hint.type+hint.index) and hint.extraCells (already absolute) into one
      // {row, col, value} list, so the paint logic stays single-source.
      for (const cell of hintAbsoluteCells(hint)) {
        const cx = cell.col * cellSize;
        const cy = cell.row * cellSize;
        if (puzzleData?.type === 'shikaku' && cell.value >= 0) {
          // Shikaku hint cell: paint it in its owning rectangle's colour
          // (so the rectangle visibly takes shape) with a blue ring to
          // mark it as the newly-revealed hint.
          ctx.fillStyle = galaxiesColors[cell.value % galaxiesColors.length];
          ctx.fillRect(cx + 1, cy + 1, cellSize - 2, cellSize - 2);
          ctx.strokeStyle = '#2e86de';
          ctx.lineWidth = Math.max(2, Math.floor(cellSize / 7));
          ctx.strokeRect(cx + 2, cy + 2, cellSize - 4, cellSize - 4);
        } else if (puzzleData?.type === 'yinyang' && (cell.value === 1 || cell.value === 2)) {
          // Draw the hint square in its colour, ringed blue to mark the hint.
          const inset = Math.max(1, Math.floor(cellSize * 0.15));
          const side = cellSize - 2 * inset;
          const sx = cx + inset, sy = cy + inset;
          ctx.fillStyle = cell.value === 1 ? '#fff' : '#1f2937';
          ctx.fillRect(sx, sy, side, side);
          ctx.strokeStyle = '#2e86de';
          ctx.lineWidth = Math.max(2, Math.floor(cellSize / 9));
          ctx.strokeRect(sx, sy, side, side);
        } else if (puzzleData?.type === 'heyawake' && (cell.value === 1 || cell.value === 2)) {
          // Heyawake hint: value 1 = must be black (dark fill + blue ring),
          // value 2 = must be white/empty (translucent overlay + blue ring).
          const inset = Math.max(1, Math.floor(cellSize * 0.1));
          const side = cellSize - 2 * inset;
          const sx = cx + inset, sy = cy + inset;
          ctx.fillStyle = cell.value === 1 ? 'rgba(31, 41, 55, 0.6)' : 'rgba(255,255,255,0.5)';
          ctx.fillRect(sx, sy, side, side);
          ctx.strokeStyle = '#2e86de';
          ctx.lineWidth = Math.max(2, Math.floor(cellSize / 9));
          ctx.strokeRect(sx, sy, side, side);
        } else if (puzzleData?.type === 'hitori' && (cell.value === 1 || cell.value === 2)) {
          // Hitori hint (reversed convention): value 2 = must be unshaded
          // (dark cell), so use the darker blue ring; value 1 = must be
          // shaded (light cell), so use the lighter blue ring.
          ctx.strokeStyle = cell.value === 2 ? '#3b82f6' : '#60a5fa';
          ctx.lineWidth = Math.max(2, Math.floor(cellSize / 9));
          ctx.strokeRect(cx + 2, cy + 2, cellSize - 4, cellSize - 4);
        } else if (isKakurasu && (cell.value === 1 || cell.value === 2)) {
          // Kakurasu hint: value 1 = must be filled (darker blue ring),
          // value 2 = must be crossed (lighter blue ring).
          ctx.strokeStyle = cell.value === 1 ? '#3b82f6' : '#60a5fa';
          ctx.lineWidth = Math.max(2, Math.floor(cellSize / 9));
          ctx.strokeRect(cx + 2, cy + 2, cellSize - 4, cellSize - 4);
        } else if (isKurodoko && (cell.value === 1 || cell.value === 2)) {
          // Kurodoko hint: value 1 = must be black (darker blue ring),
          // value 2 = must be white/empty (lighter blue ring).
          ctx.strokeStyle = cell.value === 1 ? '#3b82f6' : '#60a5fa';
          ctx.lineWidth = Math.max(2, Math.floor(cellSize / 9));
          ctx.strokeRect(cx + 2, cy + 2, cellSize - 4, cellSize - 4);
        } else if (puzzleData?.type === 'binairo' && (cell.value === 1 || cell.value === 2)) {
          // For binairo hints, draw a translucent disc matching the target value
          // — outlined blue = "play a 1 here", full blue fill = "play a 0 here".
          const ccx = cx + cellSize / 2;
          const ccy = cy + cellSize / 2;
          const hr = Math.max(2, Math.floor(cellSize * 0.35));
          ctx.fillStyle = fillColor;
          ctx.beginPath();
          ctx.arc(ccx, ccy, hr, 0, Math.PI * 2);
          ctx.fill();
          if (cell.value === 1) {
            ctx.strokeStyle = '#2e86de';
            ctx.lineWidth = Math.max(1.5, cellSize / 14);
            ctx.stroke();
          }
        } else if (cell.value === 1) {
          ctx.fillStyle = fillColor;
          ctx.fillRect(cx + 2, cy + 2, cellSize - 4, cellSize - 4);
        } else if (cell.value === -1) {
          ctx.fillStyle = crossColor;
          ctx.fillRect(cx + 2, cy + 2, cellSize - 4, cellSize - 4);
          ctx.strokeStyle = '#e63946';
          ctx.lineWidth = 1.5;
          const p = Math.max(1, Math.floor(cellSize / 5));
          ctx.beginPath();
          ctx.moveTo(cx + p, cy + p);
          ctx.lineTo(cx + cellSize - p, cy + cellSize - p);
          ctx.moveTo(cx + cellSize - p, cy + p);
          ctx.lineTo(cx + p, cy + cellSize - p);
          ctx.stroke();
        }
      }
    }

    // Region borders + nonogram-5 guides + galaxies stars sit ON TOP of fills
    // and hints (the lattice layer painted at the start of this function
    // already covers the under-fill case).
    if (staticLayer) ctx.drawImage(staticLayer, 0, 0);

    // Mistake overlay: when the auto-solved solution is known, ring every
    // cell the player has placed wrong. Recomputed each redraw, so it tracks
    // the board live as the state-watch refreshes the preview.
    if (puzzleData?.solution) {
      const mistakes = computePuzzleDiff(
        puzzleData.type, grid, puzzleData.solution, puzzleData.stars);
      if (mistakes.length) {
        ctx.save();
        ctx.strokeStyle = '#e63946';
        ctx.lineWidth = Math.max(2, Math.floor(cellSize / 8));
        if (puzzleData.type === 'slitherlink') {
          ctx.lineCap = 'round';
          ctx.lineWidth = Math.max(3, Math.floor(cellSize / 5));
          for (const em of /** @type {any[]} */ (mistakes)) {
            ctx.beginPath();
            if (em.orientation === 'h') {
              ctx.moveTo(em.c * cellSize, em.r * cellSize);
              ctx.lineTo((em.c + 1) * cellSize, em.r * cellSize);
            } else {
              ctx.moveTo(em.c * cellSize, em.r * cellSize);
              ctx.lineTo(em.c * cellSize, (em.r + 1) * cellSize);
            }
            ctx.stroke();
          }
        } else if (puzzleData.type === 'hashi') {
          // Re-stroke wrong bridges in red between the two island centres.
          // computePuzzleDiff returns {a, b, orientation, expected, actual}
          // for each mis-drawn bridge (wrong count or unwanted bridge).
          ctx.lineCap = 'round';
          ctx.lineWidth = Math.max(3, Math.floor(cellSize / 5));
          const islands = puzzleData?.islands || [];
          for (const m of /** @type {any[]} */ (mistakes)) {
            const ia = islands[m.a], ib = islands[m.b];
            if (!ia || !ib) continue;
            ctx.beginPath();
            ctx.moveTo(ia.col * cellSize + cellSize / 2, ia.row * cellSize + cellSize / 2);
            ctx.lineTo(ib.col * cellSize + cellSize / 2, ib.row * cellSize + cellSize / 2);
            ctx.stroke();
          }
        } else {
          for (const m of /** @type {any[]} */ (mistakes)) {
            const mx = m.col * cellSize, my = m.row * cellSize;
            ctx.fillStyle = 'rgba(230, 57, 70, 0.22)';
            ctx.fillRect(mx, my, cellSize, cellSize);
            ctx.strokeRect(mx + 1, my + 1, cellSize - 2, cellSize - 2);
          }
        }
        ctx.restore();
      }
    }
  }

  function setExpanded(val) {
    expanded = val;
    root.classList.toggle('ns-collapsed', !val);
    saveWidgetPref({ expanded: val });
  }
  widgetExpandFn = setExpanded;

  root.addEventListener('click', (e) => {
    if (!expanded) {
      setExpanded(true);
      return;
    }

    const btn = e.target.closest('[data-action]');
    if (!btn) {
      if (e.target.closest('.ns-header')) setExpanded(false);
      return;
    }
    const action = btn.dataset.action;

    if (action === 'detect') detectHandler();
    else if (action === 'solve') solveHandler();
    else if (action === 'loop') loopHandler();
    else if (action === 'hint') hintHandler();
    else if (action === 'applyHint') applyHintHandler();
    else if (action === 'undo' || action === 'redo') historyHandler(action);
    else if (action === 'dump') dumpHandler();
  });

  async function detectHandler() {
    setStatus('Detecting...', 'info');
    const result = await detectPuzzle();
    if (!result || !result.found) {
      showSupportedPuzzles(result?.error);
      return;
    }
    puzzleData = result;
    confirming = false;
    loopConfirming = false;
    looping = false;
    q('[data-action="solve"]').disabled = false;
    q('[data-action="solve"]').textContent = 'Solve';
    q('[data-action="loop"]').disabled = false;
    loopBtn.textContent = 'Loop';
    q('[data-action="hint"]').disabled = false;
    clearPendingHint();

    const stateResult = await readGridState();
    const label = (result.type || 'puzzle').charAt(0).toUpperCase() + (result.type || 'puzzle').slice(1);
    if (stateResult?.success) {
      drawPreview(stateResult.grid);
      setStatus(`Found ${result.rows}×${result.cols} ${label}.`, 'success');
    } else {
      setStatus(`Found ${result.rows}×${result.cols} ${label}.`, 'success');
    }
    updateUndoRedoButtons();
    startStateWatch();
    pendingAutoSolve = autoSolve();
  }

  async function solveHandler() {
    if (!puzzleData) { setStatus('Detect first.', 'error'); return; }

    if (confirming) {
      confirming = false;
      solveBtn.textContent = 'Solve';
      setStatus('Applying...', 'info');
      const applyResult = await applySolution(puzzleData.solution);
      if (applyResult?.success) {
        setStatus('Solved!', 'success');
        const newState = await readGridState();
        if (newState?.success) drawPreview(newState.grid);
      } else {
        setStatus('Apply failed.', 'error');
      }
      updateUndoRedoButtons();
      return;
    }

    const cached = getCachedGalaxiesSolution(puzzleData);
    if (!puzzleData.solution && cached) puzzleData.solution = cached;

    if (!puzzleData.solution && pendingAutoSolve) {
      setStatus('Solving...', 'info');
      await pendingAutoSolve;
    }

    if (puzzleData.solution) {
      loopConfirming = false;
      clearPendingHint();
      solveBtn.textContent = 'Confirm';
      confirming = true;
      setStatus('Preview ready.', 'info');
      drawPreview(puzzleData.solution);
      return;
    }

    setStatus('Solving...', 'info');
    const stateResult = await readGridState();
    const initialGrid = chooseInitialGrid(puzzleData, stateResult?.success ? stateResult.grid : null);
    const result = await runSolve(puzzleData.rowClues, puzzleData.colClues, initialGrid,
      puzzleData.type, solveExtraData());
    if (puzzleData.type === 'galaxies' && result?.error === 'invalid partial state') {
      clearPartial(puzzleData);
      const retry = await runSolve(puzzleData.rowClues, puzzleData.colClues, stateResult?.success ? stateResult.grid : null,
        puzzleData.type, solveExtraData());
      if (retry?.solved) {
        applySolveResult(retry);
        return;
      }
      setStatus(formatSolveError(retry), 'error');
      return;
    }
    if (!result || !result.solved) {
      // Slitherlink-style partial: solver hit the budget during backtracking
      // but propagation + lookahead determined a useful chunk of the loop.
      // Show that as a preview rather than just reporting "timed out".
      if (result?.partial && result.horizontal && result.vertical) {
        applyPartialResult(result);
        return;
      }
      // Hashi partial: HashiSolver.solve emits {partial:true, edges:[...]}
      // on timeout. Show the deduced bridges as a preview instead of
      // dropping them.
      if (result?.partial && puzzleData?.type === 'hashi' && Array.isArray(result.edges)) {
        applyHashiPartialResult(result);
        return;
      }
      // Generic 2D-grid partial: any cell-state puzzle (heyawake, hitori)
      // that emits {partial:true, grid:[...]} on timeout.
      if (result?.partial && puzzleData?.type === 'heyawake' && Array.isArray(result.grid)) {
        applyGridPartialResult(result);
        return;
      }
      if (result?.partial && puzzleData?.type === 'hitori' && Array.isArray(result.grid)) {
        applyGridPartialResult(result);
        return;
      }
      if (result?.partial && puzzleData?.type === 'kakurasu' && Array.isArray(result.grid)) {
        applyGridPartialResult(result);
        return;
      }
      if (result?.partial && puzzleData?.type === 'kurodoko' && Array.isArray(result.grid)) {
        applyGridPartialResult(result);
        return;
      }
      if (result?.partialGrid) {
        cachePartial(puzzleData, result.partialGrid, result.partialFilled);
      } else if (result?.error === 'partial state exhausted') {
        if (puzzleData.type === 'galaxies' && result.failedPartialGrid) {
          cacheFailedGalaxiesPartial(puzzleData, result.failedPartialGrid);
        }
        clearPartial(puzzleData);
      }
      setStatus(formatSolveError(result), 'error');
      return;
    }
    applySolveResult(result);
  }

  // Background solve kicked off by Detect. Non-blocking: detectHandler does
  // not await it. Populates puzzleData.solution + the localStorage caches so
  // Solve/Hint/Loop reuse it, and triggers the mistake overlay. Solves from
  // the puzzle's givens (initialGrid = null) so the result is the canonical
  // solution, not biased by the player's possibly-wrong moves. Background
  // failures are silent — features still solve on demand.
  async function autoSolve() {
    const pd = puzzleData; // capture — a later Detect must not be clobbered
    if (!pd || pd.solution) return;
    const cached = pd.type === 'galaxies'
      ? getCachedGalaxiesSolution(pd)
      : getCachedGridSolution(pd);
    if (cached) {
      if (puzzleData === pd) { pd.solution = cached; await afterAutoSolve(pd); }
      return;
    }
    const result = await runSolve(pd.rowClues, pd.colClues, null, pd.type, solveExtraData());
    if (puzzleData !== pd) return; // a newer Detect superseded this solve
    if (result && result.solved) {
      recordSolveSuccess(result);
      await afterAutoSolve(pd);
    } else {
      console.warn('[puzzle-solver] background auto-solve did not solve:', result && result.error);
    }
  }

  // After the auto-solve lands: redraw the preview (so mistakes show) and, if
  // the widget is still idle on the post-detect message, note the count.
  async function afterAutoSolve(pd) {
    const state = await readGridState();
    if (puzzleData !== pd || !pd.solution) return;
    const grid = state && state.success ? state.grid : null;
    if (!grid) return;
    drawPreview(grid);
    if (!confirming && !looping && !loopConfirming && !puzzleData.pendingHint) {
      const mistakes = computePuzzleDiff(pd.type, grid, pd.solution, pd.stars);
      const label = (pd.type || 'puzzle').charAt(0).toUpperCase() + (pd.type || 'puzzle').slice(1);
      const note = mistakes.length
        ? `${mistakes.length} mistake${mistakes.length === 1 ? '' : 's'}`
        : 'no mistakes';
      setStatus(`Found ${pd.rows}×${pd.cols} ${label} — ${note}.`, 'success');
    }
  }

  // Cache solver outputs so subsequent operations (apply, hint, loop) can
  // reuse them. Stops short of the confirm-mode UI transition — applies
  // anywhere we record a successful solve, including paths that aren't going
  // into "preview ready" mode (e.g., loopHandler's own intermediate solve).
  function recordSolveSuccess(result) {
    // Slitherlink's result is { solved, horizontal, vertical }; hashi's result
    // is { solved, edges }; every other puzzle type returns { solved, grid }.
    // Keep puzzleData.solution in the same shape readState returns, so
    // downstream consumers (gsComplete, endComplete, mistake-diff) can compare
    // directly without re-checking.
    if (puzzleData?.type === 'slitherlink') {
      puzzleData.solution = { horizontal: result.horizontal, vertical: result.vertical };
    } else if (puzzleData?.type === 'hashi') {
      puzzleData.solution = { solved: result.solved, edges: result.edges };
    } else {
      puzzleData.solution = result.grid;
    }
    cacheGalaxiesSolution(puzzleData, result.grid);
    cacheGridSolution(puzzleData, puzzleData.solution);
    clearPartial(puzzleData);
    clearFailedGalaxiesPartials(puzzleData);
  }

  // Move from "solving" into "ready to apply": record the solve and put the
  // widget into confirm mode showing a preview. Used by the fresh-solve and
  // retry paths.
  function applySolveResult(result) {
    loopConfirming = false;
    recordSolveSuccess(result);
    clearPendingHint();
    solveBtn.textContent = 'Confirm';
    confirming = true;
    setStatus('Preview ready.', 'info');
    drawPreview(previewGridFromResult(result));
  }

  // For slitherlink the worker result has { horizontal, vertical } instead of
  // .grid; for hashi it has { edges }. drawPreview expects the matching shape
  // (same shape readState returns for the puzzle type). Other puzzle types
  // still pass result.grid through unchanged.
  function previewGridFromResult(result) {
    if (puzzleData?.type === 'slitherlink' && result?.horizontal && result?.vertical) {
      return { horizontal: result.horizontal, vertical: result.vertical };
    }
    if (puzzleData?.type === 'hashi' && result?.edges) {
      return { edges: result.edges };
    }
    return result?.grid;
  }

  // Partial-solution preview for slitherlink: when solve() times out on a
  // hard board (e.g. the 50×40 monthly), the solver returns what propagation
  // + lookahead could deduce as a partial. We show that as a preview the
  // user can apply, with a clear "partial — continue manually" status.
  // We deliberately do NOT call recordSolveSuccess: the partial is a subset
  // of the real solution, so caching it would mis-trigger Loop's done-check
  // and the mistake overlay.
  function applyPartialResult(result) {
    loopConfirming = false;
    clearPendingHint();
    solveBtn.textContent = 'Confirm';
    confirming = true;
    let lines = 0;
    for (const row of result.horizontal) for (const v of row) if (v === 1) lines++;
    for (const row of result.vertical)   for (const v of row) if (v === 1) lines++;
    setStatus(
      `Partial only: ${lines} edges deduced (board too hard for full solve). Apply, then finish manually.`,
      'info',
    );
    drawPreview({ horizontal: result.horizontal, vertical: result.vertical });
  }

  // Hashi twin of applyPartialResult. Deliberately does NOT call
  // recordSolveSuccess: a partial cached as the canonical solution would
  // mis-trigger hashiDoneCheck (which would treat partial as the full
  // solution).
  function applyHashiPartialResult(result) {
    loopConfirming = false;
    clearPendingHint();
    solveBtn.textContent = 'Confirm';
    confirming = true;
    setStatus(
      `Partial only: ${result.edges.length} bridges deduced (board too hard for full solve). Apply, then finish manually.`,
      'info',
    );
    drawPreview({ edges: result.edges });
  }

  // Generic 2D-grid partial result handler. Heyawake is the first caller;
  // any future cell-state puzzle that supports partials can use it.
  // Deliberately does NOT call recordSolveSuccess (matches the slitherlink/
  // hashi precedent — caching a partial would mis-trigger Loop done-check
  // and the mistake overlay).
  function applyGridPartialResult(result) {
    loopConfirming = false;
    clearPendingHint();
    solveBtn.textContent = 'Confirm';
    confirming = true;
    let filled = 0;
    for (const row of result.grid) {
      for (const v of row) if (v !== 0) filled++;
    }
    setStatus(
      `Partial only: ${filled} cells deduced (board too hard for full solve). Apply, then finish manually.`,
      'info',
    );
    drawPreview(result.grid);
  }

  // Apply a hashi hint by merging its edges into the live board and calling
  // applyHashiState. Prefers `hint.edges` (the named stepwise deduction the
  // user was just shown — bypassing this in favor of solution diffing was a
  // regression that decoupled the apply path from the previewed rule).
  // Falls back to solution.edges diffing only when no pendingHint is present
  // (Loop's first auto-step, or a stale invocation). Returns
  // { success: true } / { success: false, error }.
  async function applyHashiHintEdges(hint) {
    const current = await callMainWorld('readHashiState', []);
    if (!current) return { success: false, error: 'Hashi state read failed' };
    let toApply;
    if (hint?.edges?.length) {
      toApply = hint.edges;
    } else {
      const solution = puzzleData.solution;
      if (!solution?.edges) return { success: false, error: 'Hashi solution not available' };
      const curMap = new Map();
      for (const e of current.edges) {
        const a = Math.min(e.a, e.b), b = Math.max(e.a, e.b);
        curMap.set(`${a}-${b}`, e.bridges);
      }
      const numIslands = (puzzleData.islands || []).length;
      const minLines = Math.max(1, Math.ceil(numIslands / 10));
      toApply = [];
      for (const e of solution.edges) {
        const a = Math.min(e.a, e.b), b = Math.max(e.a, e.b);
        if (curMap.get(`${a}-${b}`) !== e.bridges) {
          toApply.push(e);
          if (toApply.length >= minLines) break;
        }
      }
    }
    if (toApply.length === 0) return { success: true };
    // Merge: start with current edges, swap in any toApply override that
    // matches an existing edge by endpoint pair, push any remaining
    // toApply entries that didn't appear in current.
    const merged = current.edges.slice();
    const overrideMap = new Map();
    for (const e of toApply) {
      const a = Math.min(e.a, e.b), b = Math.max(e.a, e.b);
      overrideMap.set(`${a}-${b}`, e);
    }
    for (let i = 0; i < merged.length; i++) {
      const a = Math.min(merged[i].a, merged[i].b);
      const b = Math.max(merged[i].a, merged[i].b);
      const key = `${a}-${b}`;
      if (overrideMap.has(key)) {
        merged[i] = overrideMap.get(key);
        overrideMap.delete(key);
      }
    }
    for (const remaining of overrideMap.values()) merged.push(remaining);
    const ok = await callMainWorld('applyHashiState', [merged]);
    return ok ? { success: true } : { success: false, error: 'Hashi hint apply failed' };
  }

  // Hashi done-check helper: every solution edge's bridge count matches the
  // current board state AND no extra bridges exist on pairs absent from the
  // solution. Edge keys are min-max normalized so the comparison is
  // direction-independent. _emit() filters bridges=0 out of solution.edges,
  // so iterating only solution.edges would miss user-drawn extras on
  // solution-0 pairs — hence the second loop over currentState.edges.
  function hashiDoneCheck(currentState, solution) {
    if (!currentState || !solution || !solution.edges) return false;
    const solMap = new Map();
    for (const e of solution.edges) {
      const a = Math.min(e.a, e.b), b = Math.max(e.a, e.b);
      solMap.set(`${a}-${b}`, e.bridges);
    }
    const curMap = new Map();
    for (const e of currentState.edges) {
      const a = Math.min(e.a, e.b), b = Math.max(e.a, e.b);
      curMap.set(`${a}-${b}`, e.bridges);
    }
    for (const [key, want] of solMap) {
      if (curMap.get(key) !== want) return false;
    }
    for (const [key, have] of curMap) {
      if (!have) continue; // 0 means "no bridge drawn" — not an extra
      if (!solMap.has(key)) return false; // user drew a bridge on a solution-0 pair
    }
    return true;
  }

  // The Loop button cycles through three states. loopHandler dispatches; the
  // per-state work lives in dedicated helpers below.
  async function loopHandler() {
    if (!puzzleData) { setStatus('Detect first.', 'error'); return; }
    if (looping) { stopLoop(); return; }
    if (loopConfirming) { await applyAndRunLoop(); return; }
    await previewFirstLoopStep();
  }

  // Branch 1 — user clicked Loop while looping. Cancel the inter-step sleep
  // if any so Stop is instant; the loop body checks stopLooping each iter.
  function stopLoop() {
    stopLooping = true;
    loopBtn.disabled = true;
    loopBtn.textContent = 'Stopping...';
    if (stopLoopWait) stopLoopWait();
  }

  // Cancellable inter-step pause. Settles as soon as the user clicks Stop
  // instead of waiting out the full delay.
  function sleepWithStop(ms) {
    return new Promise(resolve => {
      const timer = setTimeout(() => { stopLoopWait = null; resolve(); }, ms);
      stopLoopWait = () => { clearTimeout(timer); stopLoopWait = null; resolve(); };
    });
  }

  // Branch 2 — user clicked Confirm. Apply the pending hint, then enter the
  // auto-loop body. If the apply fails we bail before starting, because
  // running the loop from an inconsistent state would just mask the real
  // error and likely fail every subsequent step.
  async function applyAndRunLoop() {
    confirming = false;
    solveBtn.textContent = 'Solve';
    loopConfirming = false;

    if (puzzleData.pendingHint) {
      setStatus('Applying...', 'info');
      let ok;
      if (puzzleData.pendingHint.type === 'galaxies') {
        const r = await applySolution({ type: 'galaxies-lines', lines: puzzleData.pendingHint.lines });
        ok = !!r?.success;
      } else if (puzzleData.type === 'shikaku') {
        const hintCells = hintAbsoluteCells(puzzleData.pendingHint);
        const cur = await callMainWorld('readShikakuState', [puzzleData.rows, puzzleData.cols]);
        const grid = cur || Array.from({ length: puzzleData.rows }, () => new Array(puzzleData.cols).fill(-1));
        for (const cell of hintCells) grid[cell.row][cell.col] = cell.value;
        ok = !!(await callMainWorld('applyShikakuState', [grid, puzzleData.clues]));
      } else if (puzzleData.type === 'slitherlink') {
        const cur = await callMainWorld('readSlitherlinkState', [puzzleData.rows, puzzleData.cols]);
        const horizontal = (cur?.horizontal || Array.from({ length: puzzleData.rows + 1 },
          () => new Array(puzzleData.cols).fill(0))).map(row => row.slice());
        const vertical   = (cur?.vertical   || Array.from({ length: puzzleData.rows },
          () => new Array(puzzleData.cols + 1).fill(0))).map(row => row.slice());
        for (const e of (puzzleData.pendingHint.edges || [])) {
          if (e.orientation === 'h' && horizontal[e.r]) horizontal[e.r][e.c] = 1;
          else if (e.orientation === 'v' && vertical[e.r]) vertical[e.r][e.c] = 1;
        }
        ok = !!(await callMainWorld('applySlitherlinkState', [{ horizontal, vertical }]));
      } else if (puzzleData.type === 'hashi') {
        const r = await applyHashiHintEdges(puzzleData.pendingHint);
        ok = !!r?.success;
      } else {
        const hintCells = hintAbsoluteCells(puzzleData.pendingHint);
        ok = !!(await callMainWorld('applyHintCells', [hintCells]));
      }
      if (!ok) {
        setStatus('Hint apply failed; loop aborted.', 'error');
        return;
      }
    }
    clearPendingHint();
    await runLoop();
  }

  async function runLoop() {
    looping = true;
    stopLooping = false;
    loopBtn.textContent = 'Stop';
    setButtonsDisabled(true);
    // The Loop button doubles as Stop while looping — keep it clickable.
    loopBtn.disabled = false;
    setStatus('Step 1', 'info');
    let steps = 1;
    const state1 = await readGridState();
    if (state1?.success) drawPreview(state1.grid);

    while (true) {
      if (stopLooping) break;
      const gs = await readGridState();
      if (!gs?.success) break;
      let gsComplete;
      if (puzzleData.type === 'slitherlink') {
        const sol = puzzleData.solution;
        if (sol?.horizontal && sol?.vertical) {
          const edgeState = await callMainWorld('readSlitherlinkState', [puzzleData.rows, puzzleData.cols]);
          const bh = edgeState?.horizontal || [];
          const bv = edgeState?.vertical || [];
          gsComplete = true;
          outer: for (let r = 0; r < sol.horizontal.length; r++) {
            for (let c = 0; c < (sol.horizontal[r]?.length || 0); c++) {
              if (sol.horizontal[r][c] === 1 && bh[r]?.[c] !== 1) { gsComplete = false; break outer; }
            }
          }
          if (gsComplete) {
            outer2: for (let r = 0; r < sol.vertical.length; r++) {
              for (let c = 0; c < (sol.vertical[r]?.length || 0); c++) {
                if (sol.vertical[r][c] === 1 && bv[r]?.[c] !== 1) { gsComplete = false; break outer2; }
              }
            }
          }
        } else {
          gsComplete = false;
        }
      } else if (puzzleData.type === 'shikaku') {
        gsComplete = gs.grid.every(row => row.every(c => c !== -1));
      } else if (puzzleData.type === 'hashi') {
        // gs.grid for hashi is { edges } from hashiHandler.readState, not a
        // 2D cell array; route through hashiDoneCheck (matches the post-loop
        // endComplete check below).
        gsComplete = hashiDoneCheck(gs.grid, puzzleData.solution);
      } else {
        gsComplete = gs.grid.every(row => row.every(c => c !== 0));
      }
      if (puzzleData.type !== 'galaxies' && gsComplete) break;

      const hr = await getHint({ solution: puzzleData.solution });
      if (!hr?.success) break;
      if (hr.hint?.type !== 'galaxies' && hr.hint?.type !== 'slitherlink' && hr.hint?.type !== 'hashi' && hr.hint?.type !== 'heyawake' && hr.hint?.type !== 'hitori' && hr.hint?.type !== 'kakurasu' && hr.hint?.type !== 'kurodoko' && !hr.hint?.cells?.length) break;

      const h = hr.hint;
      // getHint may lazily solve as a fallback (galaxies + aquarium);
      // persist the returned solution so subsequent iterations skip the
      // solver call. Galaxies attaches a memoized _galaxyPath; aquarium
      // reuses sol directly for row-by-row diffs.
      if (hr.solution) puzzleData.solution = hr.solution;
      applyHintToGrid(gs.grid, h);
      const ar = h.type === 'galaxies'
        ? await applySolution({ type: 'galaxies-lines', lines: h.lines })
        : await applySolution(gs.grid);
      if (!ar?.success) break;

      steps++;
      setHintStatus(h, `Step ${steps}: `);
      const ss = await readGridState();
      // Loop's per-step refresh: just the updated grid, no hint overlay.
      if (ss?.success) drawPreview(ss.grid);
      await sleepWithStop(300);
    }
    stopLoopWait = null;

    loopBtn.textContent = 'Loop';
    loopBtn.disabled = false;
    looping = false;
    setButtonsDisabled(false);
    updateUndoRedoButtons();
    setHintLabel('Hint');
    if (stopLooping) {
      setStatus(`Stopped after ${steps} step${steps !== 1 ? 's' : ''}.`, 'info');
    } else {
      const end = await readGridState();
      if (end?.success) drawPreview(end.grid);
      let endComplete = false;
      if (end?.grid) {
        // Dispatch on type FIRST. For slitherlink, end.grid is
        // { horizontal, vertical } (not a 2D array), so the cell-grid
        // `.every` check below would TypeError. Even if solution is missing
        // (auto-solve failed or still running), stay in the slitherlink arm
        // and report not-complete instead of crashing.
        if (puzzleData.type === 'slitherlink') {
          if (puzzleData.solution?.horizontal && puzzleData.solution?.vertical) {
            const edgeState = await callMainWorld('readSlitherlinkState', [puzzleData.rows, puzzleData.cols]);
            const bh = edgeState?.horizontal || [];
            const bv = edgeState?.vertical || [];
            endComplete = true;
            for (let r = 0; endComplete && r < puzzleData.solution.horizontal.length; r++) {
              for (let c = 0; c < (puzzleData.solution.horizontal[r]?.length || 0); c++) {
                if (puzzleData.solution.horizontal[r][c] === 1 && bh[r]?.[c] !== 1) { endComplete = false; break; }
              }
            }
            for (let r = 0; endComplete && r < puzzleData.solution.vertical.length; r++) {
              for (let c = 0; c < (puzzleData.solution.vertical[r]?.length || 0); c++) {
                if (puzzleData.solution.vertical[r][c] === 1 && bv[r]?.[c] !== 1) { endComplete = false; break; }
              }
            }
          } else {
            endComplete = false;
          }
        } else {
          endComplete = puzzleData.type === 'shikaku'
            ? end.grid.every(row => row.every(c => c !== -1))
            : puzzleData.type === 'hashi'
              ? hashiDoneCheck(end.grid, puzzleData.solution)
              : end.grid.every(row => row.every(c => c !== 0));
        }
      }
      const done = end?.grid && puzzleData.type !== 'galaxies' && endComplete;
      setStatus(done ? 'Solved!' : 'No more hints available.', done ? 'success' : 'info');
    }
    stopLooping = false;
  }

  // Branch 3 — fresh Loop press. Compute one hint, show its preview, switch
  // the button to Confirm. The actual loop doesn't start until the user
  // approves by clicking Confirm.
  async function previewFirstLoopStep() {
    confirming = false;
    solveBtn.textContent = 'Solve';
    // Loop has its own commit path (the Confirm state on the Loop button),
    // so the Apply button must be disabled — otherwise a stale Hint-click
    // Apply remains enabled while Loop preview is active.
    clearPendingHint();

    // Load any cached solution for this puzzle before deciding whether to
    // pre-solve. Galaxies / aquarium / nonogram each have their own cache
    // shape; getCachedGridSolution dispatches by type for the latter two.
    if (!puzzleData.solution) {
      const cached = puzzleData.type === 'galaxies'
        ? getCachedGalaxiesSolution(puzzleData)
        : getCachedGridSolution(puzzleData);
      if (cached) puzzleData.solution = cached;
    }

    if (!puzzleData.solution && pendingAutoSolve) {
      // Mirror hintHandler: show "Solving..." while we wait for the background
      // auto-solve, otherwise the Loop button looks dead for the duration of
      // the await. Status gets overwritten by "Computing hint..." or the
      // nonogram pre-solve below as soon as the await returns.
      setStatus('Solving...', 'info');
      await pendingAutoSolve;
    }

    // Nonogram pre-solves so the loop's getHint can compare against the
    // solution. With a cache hit we skip the solve; otherwise solve once
    // up front and cache the result.
    if (puzzleData.type === 'nonogram' && !puzzleData.solution) {
      setStatus('Solving...', 'info');
      const stateResult = await readGridState();
      const initialGrid = chooseInitialGrid(puzzleData, stateResult?.success ? stateResult.grid : null);
      const result = await runSolve(puzzleData.rowClues, puzzleData.colClues, initialGrid,
        puzzleData.type, solveExtraData());
      if (!result?.solved) {
        setStatus(formatSolveError(result), 'error');
        return;
      }
      recordSolveSuccess(result);
      cacheGridSolution(puzzleData, result.grid);
    }

    setStatus('Computing hint...', 'info');
    const hintResult = await getHint({ solution: puzzleData.solution });
    if (!hintResult?.success) {
      setStatus(`Hint failed: ${hintResult?.error || 'Unknown error'}`, 'error');
      return;
    }
    const h = hintResult.hint;
    puzzleData.pendingHint = h;

    if (hintResult.solution) puzzleData.solution = hintResult.solution;
    renderHintStatusAndPreview(h, hintResult.grid);

    loopBtn.textContent = 'Confirm';
    loopConfirming = true;
  }

  async function hintHandler() {
    if (!puzzleData) { setStatus('Detect first.', 'error'); return; }
    confirming = false;
    loopConfirming = false;
    solveBtn.textContent = 'Solve';
    loopBtn.textContent = 'Loop';
    // Slitherlink's getHint and Hashi's getStepwiseHint propagate from the
    // live board state without touching puzzleData.solution, so don't block
    // on pendingAutoSolve — on hard 30×30 dailies that solve can take >30 s,
    // while the propagation hint returns in ~1 ms. Other puzzle types still
    // need the cached solution for mistake comparison.
    const skipAutoSolveGate = puzzleData.type === 'slitherlink' || puzzleData.type === 'hashi' || puzzleData.type === 'heyawake' || puzzleData.type === 'hitori' || puzzleData.type === 'kakurasu' || puzzleData.type === 'kurodoko' || puzzleData.type === 'mosaic';
    if (!skipAutoSolveGate && !puzzleData.solution && pendingAutoSolve) {
      setStatus('Solving...', 'info');
      await pendingAutoSolve;
    }
    setStatus('Computing hint...', 'info');
    const result = await getHint({ solution: puzzleData.solution });
    if (!result?.success) {
      clearPendingHint();
      setStatus(`Hint failed: ${result?.error || 'Unknown error'}`, 'error');
      return;
    }
    const h = result.hint;
    if (result.solution) puzzleData.solution = result.solution;
    puzzleData.pendingHint = h;
    q('[data-action="applyHint"]').disabled = false;
    renderHintStatusAndPreview(h, result.grid);
  }

  async function applyHintHandler() {
    if (!puzzleData?.pendingHint) return;
    setStatus('Applying hint...', 'info');
    let result;
    if (puzzleData.pendingHint.type === 'galaxies') {
      result = await applySolution({ type: 'galaxies-lines', lines: puzzleData.pendingHint.lines });
    } else if (puzzleData.type === 'shikaku') {
      // Shikaku uses owner-index cellStatus + currentState.areas; the
      // generic applyHintCells writer doesn't know that shape. Read the
      // current state, overlay the hint cells, re-apply via the dedicated
      // shikaku function.
      const hintCells = hintAbsoluteCells(puzzleData.pendingHint);
      const cur = await callMainWorld('readShikakuState', [puzzleData.rows, puzzleData.cols]);
      const grid = cur || Array.from({ length: puzzleData.rows }, () => new Array(puzzleData.cols).fill(-1));
      for (const cell of hintCells) grid[cell.row][cell.col] = cell.value;
      const ok = await callMainWorld('applyShikakuState', [grid, puzzleData.clues]);
      result = ok ? { success: true } : { success: false, error: 'Shikaku hint apply failed' };
    } else if (puzzleData.type === 'slitherlink') {
      // Read the current edge state, overlay the hint's LINE edges, apply.
      const cur = await callMainWorld('readSlitherlinkState', [puzzleData.rows, puzzleData.cols]);
      const horizontal = (cur?.horizontal || Array.from({ length: puzzleData.rows + 1 },
        () => new Array(puzzleData.cols).fill(0))).map(row => row.slice());
      const vertical   = (cur?.vertical   || Array.from({ length: puzzleData.rows },
        () => new Array(puzzleData.cols + 1).fill(0))).map(row => row.slice());
      for (const e of (puzzleData.pendingHint.edges || [])) {
        if (e.orientation === 'h' && horizontal[e.r]) horizontal[e.r][e.c] = 1;
        else if (e.orientation === 'v' && vertical[e.r]) vertical[e.r][e.c] = 1;
      }
      const ok = await callMainWorld('applySlitherlinkState', [{ horizontal, vertical }]);
      result = ok ? { success: true } : { success: false, error: 'Slitherlink hint apply failed' };
    } else if (puzzleData.type === 'hashi') {
      result = await applyHashiHintEdges(puzzleData.pendingHint);
    } else {
      const hintCells = hintAbsoluteCells(puzzleData.pendingHint);
      const ok = await callMainWorld('applyHintCells', [hintCells]);
      result = ok ? { success: true } : { success: false, error: 'Hint apply failed' };
    }
    if (result?.success) {
      clearPendingHint();
      setStatus('Hint applied!', 'success');
      const newState = await readGridState();
      if (newState?.success) drawPreview(newState.grid);
    } else {
      setStatus('Apply failed.', 'error');
      if (result?.error) setStatus('Apply failed: ' + result.error, 'error');
    }
    updateUndoRedoButtons();
  }

  function fmtList(nums) {
    if (nums.length <= 2) return nums.join(', ');
    const runs = [];
    let s = nums[0], e = nums[0];
    for (let i = 1; i < nums.length; i++) {
      if (nums[i] === e + 1) { e = nums[i]; continue; }
      runs.push(s === e ? '' + s : s + '-' + e);
      s = e = nums[i];
    }
    runs.push(s === e ? '' + s : s + '-' + e);
    return runs.join(', ');
  }

  function formatSolveError(result) {
    const saved = result?.partialFilled ? ` Saved partial state (${result.partialFilled} cells) for a later retry.` : '';
    if (result?.error === 'search limit exceeded') {
      if (puzzleData?.type === 'galaxies') return 'This Galaxies puzzle is too large for the current solver search limit.';
      if (puzzleData?.type === 'aquarium') return 'This Aquarium puzzle is too large for the current solver search limit.' + saved;
      return 'Search limit reached.' + saved;
    }
    if (result?.error === 'time limit exceeded') {
      return 'This puzzle is too large to solve quickly in the browser.' + saved;
    }
    if (result?.error === 'partial state exhausted') {
      return 'Saved partial Galaxies state could not be continued. It was saved as a failed branch and cleared; try Solve again to search another branch.';
    }
    if (result?.error === 'invalid partial state') {
      return 'Saved partial state was invalid and has been cleared. Try Solve again.';
    }
    return result?.error || 'Solve failed.';
  }

  function setButtonsDisabled(disabled) {
    for (const a of ['detect', 'solve', 'hint', 'loop', 'applyHint', 'undo', 'redo']) {
      q(`[data-action="${a}"]`).disabled = disabled;
    }
  }

  function updateUndoRedoButtons() {
    q('[data-action="undo"]').disabled = undoStack.length === 0;
    q('[data-action="redo"]').disabled = redoStack.length === 0;
    q('[data-action="applyHint"]').disabled = !puzzleData?.pendingHint;
  }

  let stateObserver = null;
  let watchDebounce = null;

  function startStateWatch() {
    stopStateWatch();
    const el = detectedGrid?._element;
    if (!el) return;
    const target = el.querySelector('.nonograms-cell-back') || el;
    stateObserver = new MutationObserver(() => {
      if (suppressStateWatch) return;
      clearTimeout(watchDebounce);
      watchDebounce = setTimeout(async () => {
        if (!puzzleData) return;
        const state = await readGridState();
        if (!state?.success) return;
        drawPreview(state.grid);

        if (!puzzleData.pendingHint) return;
        const hintResult = await getHint({ solution: puzzleData.solution });
        if (!hintResult?.success) {
          clearPendingHint();
          return;
        }
        const h = hintResult.hint;
        puzzleData.pendingHint = h;
        q('[data-action="applyHint"]').disabled = false;
        renderHintStatusAndPreview(h, state.grid);
      }, 200);
    });
    stateObserver.observe(target, { attributes: true, attributeFilter: ['class', 'style'], subtree: true });
  }

  function stopStateWatch() {
    if (stateObserver) { stateObserver.disconnect(); stateObserver = null; }
    clearTimeout(watchDebounce);
  }

  // `direction` ∈ {'undo','redo'}. Wordforms: Undo+ing=Undoing, Undo+ne=Undone.
  async function historyHandler(direction) {
    const cap = direction === 'undo' ? 'Undo' : 'Redo';
    setStatus(`${cap}ing...`, 'info');
    const result = await handleHistory(direction);
    if (result?.success) {
      clearPendingHint();
      if (result.grid) drawPreview(result.grid);
      updateUndoRedoButtons();
      setStatus(`${cap}ne.`, 'success');
    } else {
      const detail = result?.error ? `${cap} failed: ${result.error}` : `${cap} failed.`;
      setStatus(detail, 'error');
    }
  }

  // Capture the current puzzle in tests/fixtures/puzzles.js format and copy it
  // to the clipboard for pasting into a bench fixture. Logs to console too so
  // it's recoverable if the clipboard write fails.
  async function dumpHandler() {
    setStatus('Dumping puzzle...', 'info');
    const data = await callMainWorld('dumpPuzzleForBench', []);
    if (!data || data.error) {
      const msg = data?.error ? `Dump failed: ${data.error}` : 'Dump failed.';
      setStatus(msg, 'error');
      const errJson = formatDump(data);
      console.warn('[puzzle-solver dump] ' + errJson);
      try { await navigator.clipboard.writeText(errJson); } catch {}
      return;
    }
    const json = formatDump(data);
    console.log('[puzzle-solver dump] ' + json);
    try {
      await navigator.clipboard.writeText(json);
      setStatus(`Dumped ${data.type} ${data.rows}×${data.cols} to clipboard.`, 'success');
    } catch {
      setStatus(`Dumped ${data.type} ${data.rows}×${data.cols} to console (clipboard blocked).`, 'info');
    }
  }

  // Compact-but-line-friendly JSON formatter for dumps. Top-level keys go
  // on one line each; arrays of primitives stay flat (no per-element
  // newlines); 2D arrays put each inner row on its own line so the grid
  // structure remains visible when pasted into a fixture file.
  function formatDump(data) {
    if (!data || typeof data !== 'object') return JSON.stringify(data);
    const flatJSON = (v) => JSON.stringify(v);
    const is2D = (v) => Array.isArray(v) && v.length > 0 && Array.isArray(v[0]);
    const parts = [];
    for (const k of Object.keys(data)) {
      const v = data[k];
      if (is2D(v)) {
        const rows = v.map(r => '  ' + flatJSON(r)).join(',\n');
        parts.push(`  ${flatJSON(k)}: [\n${rows}\n  ]`);
      } else {
        parts.push(`  ${flatJSON(k)}: ${flatJSON(v)}`);
      }
    }
    return '{\n' + parts.join(',\n') + '\n}';
  }

  // Tear down observers and the worker on page unload. Most page-loads
  // recycle everything anyway, but puzzles-mobile SPA-navigates between
  // puzzles within the same document, so the observer would otherwise keep
  // watching stale DOM and the worker would linger unused.
  window.addEventListener('pagehide', (e) => {
    // event.persisted=true means the page is entering the back-forward cache
    // and may be restored later. Tearing down the worker / observer would
    // leave the widget non-functional after restore (Solve buttons exist but
    // worker is dead). Skip cleanup; Chrome reclaims the worker if the page
    // is actually evicted from BFCache.
    if (e.persisted) return;
    stopStateWatch();
    if (solverWorker) {
      // Resolve any in-flight solves before tearing down the worker —
      // otherwise their awaiters hang forever and the widget gets stuck
      // on "Solving..." if the user comes back to the page.
      for (const pending of solverPending.values()) {
        pending.resolve({ solved: false, grid: null, error: 'page unloaded' });
      }
      solverPending.clear();
      try { solverWorker.terminate(); } catch {}
      solverWorker = null;
      solverWorkerInit = null;
    }
  });

  // BFCache eviction is invisible to JS — Chrome terminates dedicated workers
  // during BFCache regardless, but pagehide(persisted=true) bypasses our
  // teardown. On restore, the cached solverWorker reference is dead and the
  // next runSolve would throw on .postMessage. Null it out so getSolverWorker
  // rebuilds lazily. pageshow always fires on the restore path.
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    if (solverWorker) {
      try { solverWorker.terminate(); } catch {}
      solverWorker = null;
      solverWorkerInit = null;
    }
  });

  detectHandler().catch(() => {});

}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    if (getActiveHandler()) makeWidget();
  });
} else {
  if (getActiveHandler()) makeWidget();
}
