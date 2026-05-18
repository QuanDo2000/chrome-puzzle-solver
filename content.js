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
      handleUndo().then(sendResponse).catch(() => sendResponse({ success: false, error: 'Undo failed' }));
      return true;
    case 'redo':
      handleRedo().then(sendResponse).catch(() => sendResponse({ success: false, error: 'Redo failed' }));
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

function getHandler() {
  return getActiveHandler();
}

async function detectPuzzle() {
  const handler = getHandler();
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
  const handler = getHandler();
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
    const handler = getHandler();
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

  const makeHint = (selected) => {
    const lines = cloneGalaxiesLines(current);
    for (const item of selected) lines[item.orientation][item.row][item.col] = 1;
    lines.check = false;
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
  let stats = { total: 0, drawn: 0, noComp: 0, emptyNodes: 0, intersect: 0, weak: 0, found: 0 };
  const addCandidate = (orientation, row, col, aCell, bCell) => {
    stats.total++;
    const aComp = components.get(grid[aCell.row]?.[aCell.col]);
    const bComp = components.get(grid[bCell.row]?.[bCell.col]);
    const aPerCell = possibleGalaxiesNodesForCell(aCell.row, aCell.col, stars, rows, cols, seedOwner);
    const bPerCell = possibleGalaxiesNodesForCell(bCell.row, bCell.col, stars, rows, cols, seedOwner);
    const aReach = reachable[aCell.row]?.[aCell.col] || new Set();
    const bReach = reachable[bCell.row]?.[bCell.col] || new Set();
    let aNodes = intersectSets(aPerCell, aReach);
    let bNodes = intersectSets(bPerCell, bReach);
    if (aComp?.possibleNodes?.size) aNodes = intersectSets(aNodes, aComp.possibleNodes);
    if (bComp?.possibleNodes?.size) bNodes = intersectSets(bNodes, bComp.possibleNodes);
    if (aNodes.size === 0 || bNodes.size === 0) { stats.emptyNodes++; return; }
    if (aComp && bComp && aComp.id === bComp.id && !aComp.possibleNodes.size) { stats.weak++; }
    if (setsIntersect(aNodes, bNodes)) { stats.intersect++; return; }
    const nodeIds = new Set([...aNodes, ...bNodes]);
    const score = (aComp?.cells.length || 1) + (bComp?.cells.length || 1);
    candidates.push({ orientation, row, col, nodeIds, currentIds: new Set([aComp?.id, bComp?.id]), score });
    stats.found++;
  };

  for (let r = 1; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (current.horizontal?.[r]?.[c] === 1) { stats.drawn++; continue; }
      addCandidate('horizontal', r, c, { row: r - 1, col: c }, { row: r, col: c });
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 1; c < cols; c++) {
      if (current.vertical?.[r]?.[c] === 1) { stats.drawn++; continue; }
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

  const transitiveHints = findTransitiveHints(components, grid, stars);
  if (transitiveHints) return makeHint(transitiveHints);

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
    for (const cell of galaxiesSeedCells(stars[i], rows, cols)) {
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
      if (comp.cells.every(cell => galaxyCellCanBelong(cell.row, cell.col, nodeIndex, stars, rows, cols, seedOwner))) {
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
    const seeds = galaxiesSeedCells(stars[i], rows, cols);
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
  const maxTarget = Math.ceil((rows * cols) / stars.length);
  let changed = true;
  while (changed) {
    changed = false;

    const certain = new Array(stars.length).fill(0);
    for (const [, comp] of components) {
      if (comp.possibleNodes.size === 1) certain[comp.possibleNodes.values().next().value] += comp.cells.length;
    }

    for (const [, comp] of components) {
      if (comp.possibleNodes.size <= 1) continue;
      const s = comp.cells.length;
      for (const star of comp.possibleNodes) {
        if (certain[star] + s > maxTarget) {
          comp.possibleNodes.delete(star);
          changed = true;
        }
      }
    }

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
}

function findTransitiveHints(components, grid, stars) {
  const current = grid?.galaxies;
  if (!current) return null;
  const rows = grid.length;
  const cols = grid[0].length;
  const maxTarget = Math.ceil((rows * cols) / stars.length);
  const certain = new Array(stars.length).fill(0);
  for (const [, comp] of components) {
    if (comp.possibleNodes.size === 1) certain[comp.possibleNodes.values().next().value] += comp.cells.length;
  }
  const hints = [];
  const process = (orientation, row, col, aId, bId) => {
    if (aId === bId) return;
    const aComp = components.get(aId), bComp = components.get(bId);
    if (!aComp || !bComp) return;
    const shared = intersectSets(aComp.possibleNodes, bComp.possibleNodes);
    if (shared.size !== 1) return;
    const star = shared.values().next().value;
    const aSize = aComp.cells.length, bSize = bComp.cells.length;
    let adjCertain = certain[star];
    if (aComp.possibleNodes.size === 1) adjCertain -= aSize;
    if (bComp.possibleNodes.size === 1) adjCertain -= bSize;
    if (adjCertain + aSize + bSize > maxTarget) hints.push({ orientation, row, col, score: aSize + bSize });
  };
  for (let r = 1; r < rows; r++)
    for (let c = 0; c < cols; c++)
      if (current.horizontal?.[r]?.[c] !== 1) process('horizontal', r, c, grid[r - 1][c], grid[r][c]);
  for (let r = 0; r < rows; r++)
    for (let c = 1; c < cols; c++)
      if (current.vertical?.[r]?.[c] !== 1) process('vertical', r, c, grid[r][c - 1], grid[r][c]);
  if (!hints.length) return null;
  const nodeRegions = getGalaxiesNodeRegions(grid, stars);
  let bestNode = null, bestNodeScore = -1;
  for (const node of nodeRegions) {
    const nodeHints = hints.filter(h => {
      const aCell = h.orientation === 'horizontal' ? { row: h.row - 1, col: h.col } : { row: h.row, col: h.col - 1 };
      const bCell = h.orientation === 'horizontal' ? { row: h.row, col: h.col } : { row: h.row, col: h.col };
      const aId = grid[aCell.row][aCell.col], bId = grid[bCell.row][bCell.col];
      return components.get(aId)?.possibleNodes?.has(node.index) || components.get(bId)?.possibleNodes?.has(node.index);
    });
    if (!nodeHints.length) continue;
    const score = nodeHints.length * 10 + node.currentSize / 100;
    if (score > bestNodeScore) { bestNodeScore = score; bestNode = { ...node, candidates: nodeHints }; }
  }
  const selected = bestNode ? bestNode.candidates : hints;
  selected.sort((a, b) => b.score - a.score || a.row - b.row || a.col - b.col);
  return selected.slice(0, Math.min(100, selected.length));
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

  const compCellSets = new Map();
  for (const comp of emptyComps) {
    const s = new Set();
    for (const cell of comp.cells) s.add(cell.row + ',' + cell.col);
    compCellSets.set(comp.id, s);
  }

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
    if (aBits || bBits) {
      hints.push({ orientation, row, col, score: (aBits ? sideA.size : sideBkeys.length) });
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
    for (const cell of galaxiesSeedCells(star, grid.length, grid[0]?.length || 0)) {
      const id = grid[cell.row]?.[cell.col];
      if (id) currentIds.add(id);
    }
    let currentSize = 0;
    for (const id of currentIds) currentSize += sizes.get(id) || 0;
    return { index, currentIds, currentSize };
  });
}

function galaxiesSeedCells(star, rows, cols) {
  const rr = star.row % 2 === 0 ? [star.row / 2] : [(star.row - 1) / 2, (star.row + 1) / 2];
  const cc = star.col % 2 === 0 ? [star.col / 2] : [(star.col - 1) / 2, (star.col + 1) / 2];
  const out = [];
  for (const row of rr) {
    for (const col of cc) {
      if (row >= 0 && col >= 0 && row < rows && col < cols) out.push({ row, col });
    }
  }
  return out;
}

function solveExtraData() {
  const data = detectedGrid;
  if (!data) return null;
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
  return null;
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
  } catch {}
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
    const handler = getHandler();
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
    } else if (detectedGrid.type === 'aquarium') {
      if (solution && firstMismatch(grid, solution)) {
        return { success: false, error: 'Current game state is wrong.' };
      }
      const solver = new AquariumSolver(rowClues, colClues, detectedGrid.regionMap, rows, cols);
      hint = solver.getHint(grid);
    } else if (solution) {
      if (firstMismatch(grid, solution)) {
        return { success: false, error: 'Current game state is wrong.' };
      }
      const solver = new NonogramSolver(rowClues, colClues);
      hint = solver.getHint(grid);
    } else {
      const solver = new NonogramSolver(rowClues, colClues);
      hint = solver.getHint(grid);
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

async function handleUndo() {
  if (mutatingOp) {
    return { success: false, error: `Busy (${mutatingOp}); try again in a moment` };
  }
  if (undoStack.length === 0) return { success: false, error: 'Nothing to undo' };
  setMutatingOp('undo');
  try {
    const currentState = await readGridState();
    if (!currentState?.success) return { success: false, error: 'Cannot read current state' };
    redoStack.push(currentState.grid);
    const prevState = undoStack.pop();
    await applySolution(prevState, true, true);
    return { success: true, grid: prevState, undoCount: undoStack.length, redoCount: redoStack.length };
  } finally {
    clearMutatingOp();
  }
}

async function handleRedo() {
  if (mutatingOp) {
    return { success: false, error: `Busy (${mutatingOp}); try again in a moment` };
  }
  if (redoStack.length === 0) return { success: false, error: 'Nothing to redo' };
  setMutatingOp('redo');
  try {
    const currentState = await readGridState();
    if (!currentState?.success) return { success: false, error: 'Cannot read current state' };
    undoStack.push(currentState.grid);
    const nextState = redoStack.pop();
    await applySolution(nextState, true, true);
    return { success: true, grid: nextState, undoCount: undoStack.length, redoCount: redoStack.length };
  } finally {
    clearMutatingOp();
  }
}

// ── Floating widget ──────────────────────────────────────────

const WIDGET_STORAGE_KEY = 'ns_widget_state';

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
        <button data-action="fixTimer">⏱ Fix Timer</button>
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
  function hintStatusNodes(h) {
    const label = h.type === 'row' ? 'Row' : 'Column';
    const clueStr = h.clue.join(', ');
    const filled = h.cells.filter(c => c.value === 1).map(c => c.index + 1);
    const crossed = h.cells.filter(c => c.value === -1).map(c => c.index + 1);
    const extra = h.extraCells || [];

    const nodes = [bold(`${label} ${h.index + 1}`), ` (clue: ${clueStr}): `];
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

  function gridDataSig(grid) {
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
    return c;
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
    if (pd?.regionMap || pd?.type === 'galaxies') return;
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
    const rows = grid.length;
    const cols = grid[0].length;
    const bodyWidth = q('.ns-body').clientWidth || 300;
    const cellSize = Math.min(Math.floor((bodyWidth - 4) / cols), Math.floor(350 / rows), 24);
    const w = cols * cellSize, h = rows * cellSize;

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
                '|h=' + hintSig(hint);
    if (sig === lastDrawSig) return;
    lastDrawSig = sig;

    // (Re)build the static layers if puzzle shape or size changed.
    const staticSig = rows + 'x' + cols + '@' + cellSize + '|t=' + (pd?.type || '') +
                      '|rm=' + regionMapSig(pd?.regionMap) +
                      '|st=' + (pd?.stars ? pd.stars.map(s => s.row + ',' + s.col).join(';') : '');
    if (staticSig !== staticLayerSig) {
      latticeLayer = buildLatticeLayer(rows, cols, cellSize, w, h);
      staticLayer = buildStaticLayer(rows, cols, cellSize, w, h, pd);
      staticLayerSig = staticSig;
    }

    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    // Lattice goes UNDER dynamic fills so filled cells hide the grey
    // cell-border lines inside them. Region borders + galaxy stars come
    // from the second static layer below, painted on top.
    if (latticeLayer) ctx.drawImage(latticeLayer, 0, 0);

    // Empty-cell X marks are batched into one stroke pass so their shared
    // strokeStyle/lineWidth set up only once.
    const galaxiesColors = ['#dbeafe', '#fee2e2', '#dcfce7', '#fef3c7', '#ede9fe', '#cffafe', '#fce7f3', '#e5e7eb'];
    const xPad = Math.max(1, Math.floor(cellSize / 5));
    let xMarkPath = null;
    ctx.fillStyle = '#1f2937';
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = grid[r][c];
        if (v === 0) continue;
        const x = c * cellSize, y = r * cellSize;
        if (puzzleData?.type === 'galaxies' && v > 0) {
          ctx.fillStyle = galaxiesColors[(v - 1) % galaxiesColors.length];
          ctx.fillRect(x + 1, y + 1, cellSize - 2, cellSize - 2);
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

    if (hint) {
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
      } else if (hint.type === 'row') {
        ctx.fillStyle = highlightColor;
        ctx.fillRect(0, hint.index * cellSize, w, cellSize);
      } else {
        ctx.fillStyle = highlightColor;
        ctx.fillRect(hint.index * cellSize, 0, cellSize, h);
      }
      for (const cell of hint.cells || []) {
        const cx = hint.type === 'row' ? cell.index * cellSize : hint.index * cellSize;
        const cy = hint.type === 'row' ? hint.index * cellSize : cell.index * cellSize;
        if (cell.value === 1) {
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
      for (const cell of hint.extraCells || []) {
        const cx = cell.col * cellSize;
        const cy = cell.row * cellSize;
        if (cell.value === 1) {
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
    else if (action === 'undo') undoHandler();
    else if (action === 'redo') redoHandler();
    else if (action === 'fixTimer') timerFixHandler();
    else if (action === 'dump') dumpHandler();
  });

  async function detectHandler() {
    setStatus('Detecting...', 'info');
    const result = await detectPuzzle();
    if (!result || !result.found) {
      setStatus('No puzzle found.', 'error');
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

  // Cache solver outputs so subsequent operations (apply, hint, loop) can
  // reuse them. Stops short of the confirm-mode UI transition — applies
  // anywhere we record a successful solve, including paths that aren't going
  // into "preview ready" mode (e.g., loopHandler's own intermediate solve).
  function recordSolveSuccess(result) {
    puzzleData.solution = result.grid;
    cacheGalaxiesSolution(puzzleData, result.grid);
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
    drawPreview(result.grid);
  }

  async function loopHandler() {
    if (!puzzleData) { setStatus('Detect first.', 'error'); return; }

    if (looping) {
      stopLooping = true;
      loopBtn.disabled = true;
      loopBtn.textContent = 'Stopping...';
      // If the loop is currently sleeping between steps, wake it up so it
      // checks stopLooping on the next iteration instead of waiting out the
      // remaining 300ms.
      if (stopLoopWait) stopLoopWait();
      return;
    }

    if (loopConfirming) {
      confirming = false;
      solveBtn.textContent = 'Solve';
      loopConfirming = false;

      // Apply the pending hint first. If it fails we bail out before starting
      // the loop — starting auto-solve from an inconsistent state would mask
      // the real error and likely fail every subsequent step too.
      if (puzzleData.pendingHint) {
        setStatus('Applying...', 'info');
        let ok;
        if (puzzleData.pendingHint.type === 'galaxies') {
          const r = await applySolution({ type: 'galaxies-lines', lines: puzzleData.pendingHint.lines });
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

      // Start auto-loop
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
        if (puzzleData.type !== 'galaxies' && gs.grid.every(row => row.every(c => c !== 0))) break;

        const hr = await getHint({ solution: puzzleData.solution });
        if (!hr?.success) break;
        if (hr.hint?.type !== 'galaxies' && !hr.hint?.cells?.length) break;

        const h = hr.hint;
        applyHintToGrid(gs.grid, h);
        const ar = h.type === 'galaxies'
          ? await applySolution({ type: 'galaxies-lines', lines: h.lines })
          : await applySolution(gs.grid);
        if (!ar?.success) break;

        steps++;
        if (h.type === 'galaxies') {
          const line = galaxiesHintLineDesc(h);
          setStatusNodes('info', `Step ${steps}: Draw the `, bold(line), '.');
        } else {
          setStatusNodes('info', `Step ${steps}: `, ...hintStatusNodes(h));
        }
        const ss = await readGridState();
        if (ss?.success) drawPreview(ss.grid);
        // Cancellable 300ms inter-step pause: settle as soon as the user
        // clicks Stop instead of forcing them to wait out the full delay.
        await new Promise(resolve => {
          const timer = setTimeout(() => {
            stopLoopWait = null;
            resolve();
          }, 300);
          stopLoopWait = () => { clearTimeout(timer); stopLoopWait = null; resolve(); };
        });
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
        const done = end?.grid && puzzleData.type !== 'galaxies' && end.grid.every(row => row.every(c => c !== 0));
        setStatus(done ? 'Solved!' : 'No more hints available.', done ? 'success' : 'info');
      }
      stopLooping = false;
      return;
    }

    confirming = false;
    solveBtn.textContent = 'Solve';

    const cached = getCachedGalaxiesSolution(puzzleData);
    if (!puzzleData.solution && cached) puzzleData.solution = cached;

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
    }

    setStatus('Computing hint...', 'info');
    const hintResult = await getHint({ solution: puzzleData.solution });
    if (!hintResult?.success) {
      setStatus(`Hint failed: ${hintResult?.error || 'Unknown error'}`, 'error');
      return;
    }
    const h = hintResult.hint;
    puzzleData.pendingHint = h;

    if (h.type === 'galaxies') {
      if (hintResult.solution) puzzleData.solution = hintResult.solution;
      const line = galaxiesHintLineDesc(h);
      setStatusNodes('info', 'Draw the ', bold(line), '.');
      if (hintResult.grid) drawPreview(hintResult.grid, h);
    } else {
      setStatusNodes('info', ...hintStatusNodes(h));
      if (hintResult.grid) drawPreview(hintResult.grid, h);
    }

    loopBtn.textContent = 'Confirm';
    loopConfirming = true;
  }

  async function hintHandler() {
    if (!puzzleData) { setStatus('Detect first.', 'error'); return; }
    confirming = false;
    loopConfirming = false;
    solveBtn.textContent = 'Solve';
    loopBtn.textContent = 'Loop';
    setStatus('Computing hint...', 'info');
    const result = await getHint({ solution: puzzleData.solution });
    if (!result?.success) {
      clearPendingHint();
      setStatus(`Hint failed: ${result?.error || 'Unknown error'}`, 'error');
      return;
    }
    const h = result.hint;
    if (h.type === 'galaxies') {
      if (result.solution) puzzleData.solution = result.solution;
      puzzleData.pendingHint = h;
      q('[data-action="applyHint"]').disabled = false;
      const line = galaxiesHintLineDesc(h);
      setStatusNodes('info', 'Draw the ', bold(line), '.');
      if (result.grid) drawPreview(result.grid, h);
      return;
    }
    puzzleData.pendingHint = h;
    q('[data-action="applyHint"]').disabled = false;
    setStatusNodes('info', ...hintStatusNodes(h));
    if (result.grid) drawPreview(result.grid, h);
  }

  async function applyHintHandler() {
    if (!puzzleData?.pendingHint) return;
    setStatus('Applying hint...', 'info');
    let result;
    if (puzzleData.pendingHint.type === 'galaxies') {
      result = await applySolution({ type: 'galaxies-lines', lines: puzzleData.pendingHint.lines });
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
        if (h.type === 'galaxies') {
          const line = galaxiesHintLineDesc(h);
          q('[data-action="applyHint"]').disabled = false;
          setStatusNodes('info', 'Draw the ', bold(line), '.');
          drawPreview(state.grid, h);
          return;
        }
        q('[data-action="applyHint"]').disabled = false;
        setStatusNodes('info', ...hintStatusNodes(h));
        drawPreview(state.grid, h);
      }, 200);
    });
    stateObserver.observe(target, { attributes: true, attributeFilter: ['class', 'style'], subtree: true });
  }

  function stopStateWatch() {
    if (stateObserver) { stateObserver.disconnect(); stateObserver = null; }
    clearTimeout(watchDebounce);
  }

  async function undoHandler() {
    setStatus('Undoing...', 'info');
    const result = await handleUndo();
    if (result?.success) {
      clearPendingHint();
      if (result.grid) drawPreview(result.grid);
      updateUndoRedoButtons();
      setStatus('Undone.', 'success');
    } else {
      setStatus('Undo failed.', 'error');
      if (result?.error) setStatus('Undo failed: ' + result.error, 'error');
    }
  }

  async function redoHandler() {
    setStatus('Redoing...', 'info');
    const result = await handleRedo();
    if (result?.success) {
      clearPendingHint();
      if (result.grid) drawPreview(result.grid);
      updateUndoRedoButtons();
      setStatus('Redone.', 'success');
    } else {
      setStatus('Redo failed.', 'error');
      if (result?.error) setStatus('Redo failed: ' + result.error, 'error');
    }
  }

  async function timerFixHandler() {
    setStatus('Fixing timer...', 'info');
    const result = await callMainWorld('fixGameTimer', []);
    if (result) {
      setStatus('Timer fixed!', 'success');
    } else {
      setStatus('Timer fix: no Game API found on this page.', 'info');
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
      console.warn('[puzzle-solver dump]\n' + JSON.stringify(data, null, 2));
      // Also try to copy the diagnostic so the user can paste it back.
      try { await navigator.clipboard.writeText(JSON.stringify(data, null, 2)); } catch {}
      return;
    }
    const json = JSON.stringify(data, null, 2);
    console.log('[puzzle-solver dump]\n' + json);
    try {
      await navigator.clipboard.writeText(json);
      setStatus(`Dumped ${data.type} ${data.rows}×${data.cols} to clipboard.`, 'success');
    } catch {
      setStatus(`Dumped ${data.type} ${data.rows}×${data.cols} to console (clipboard blocked).`, 'info');
    }
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

function shouldShowWidget() {
  // genericHandler was removed (was never registered); any active handler
  // matching the current page now qualifies.
  return !!getActiveHandler();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    if (shouldShowWidget()) makeWidget();
  });
} else {
  if (shouldShowWidget()) makeWidget();
}
