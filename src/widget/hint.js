'use strict';

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

// Top-level hint dispatcher invoked by the listener and the widget shell.
// Registry-first: every migrated puzzle module declares a `hintDispatch`
// hook that owns the full {success, hint, grid, solution} contract.
// Nonogram is the lone fallback below — its hints work through
// per-line solveLine narrowing first, then fall back to the cached /
// freshly-solved solution row-by-row.
//
// Bundle order: depends on `detectedGrid` (state.js), `getActiveHandler`
// (handler.js), `detectPuzzle` (handlers.js), `runSolve` (worker.js),
// `firstMismatch` / `nextChunkHint` / `getNonogramPath` (above in this
// file), `getCachedGridSolution` / `cacheGridSolution` (cache.js),
// `firstGalaxiesMismatch` / `nextGalaxyHint` / `getGalaxiesHint`
// (galaxies-hint.js), `solveExtraData` (handlers.js), `PUZZLES` (puzzles/
// index.js). Concatenated AFTER puzzles/index.js so the registry lookup
// is populated.

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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    firstMismatch, getAquariumPath, getNonogramPath, hintFromCellChunk,
    nextChunkHint, hintAbsoluteCells, applyHintToGrid, addAquariumRegionHints,
    getHint,
  };
}
