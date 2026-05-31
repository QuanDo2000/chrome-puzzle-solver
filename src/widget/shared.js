'use strict';

// Shared, dependency-free helpers for the widget layer. Concatenated FIRST
// into dist/content.js by scripts/build-content-bundle.js. Consumer files
// import these helpers via a relative require of this module, which the
// bundler strips (in the bundle the helpers are already top-level globals).
// Kept per-layer (a separate copy from src/solvers/shared.js) so each bundler
// stays self-contained — see the Track-A design spec.

// FNV-1a 32-bit hash — identical to the solver-layer copy.
function hashFNV1a(feed, mask = true) {
  let h = 0x811c9dc5;
  const mix = mask
    ? (n) => { h ^= n & 0xff; h = Math.imul(h, 0x01000193) >>> 0; }
    : (n) => { h ^= n; h = Math.imul(h, 0x01000193) >>> 0; };
  feed(mix);
  return h >>> 0;
}

// Grey diagonal × for a confirmed-empty cell — the shared "v===2" glyph used by
// the cell-state puzzle previews (kurodoko, mosaic, norinori, nurikabe,
// kakurasu, heyawake). Hitori intentionally does NOT use this (its v=2 is a
// dark fill, not the × glyph).
function drawCrossCell(ctx, x, y, cellSize) {
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

// Single-cell hint-status template for absolute-cell puzzles. `h.extraCells` is
// a flat list of forced {row,col,value} cells; value 1 → v1Label, else v2Label.
function absoluteCellHintStatus(h, { bold }, v1Label, v2Label) {
  const cells = h.extraCells || [];
  if (cells.length === 0) return ['No hint available'];
  if (cells.length === 1) {
    const cell = cells[0];
    const valueStr = cell.value === 1 ? v1Label : v2Label;
    return ['Cell ', bold(`(row ${cell.row + 1}, col ${cell.col + 1})`), ' must be ', bold(valueStr)];
  }
  if (h._fullCount && h._fullCount > cells.length) {
    return [bold(String(cells.length)), ` (of ${h._fullCount}) cells can be deduced`];
  }
  return [bold(String(cells.length)), ' cells can be deduced'];
}

// Factory for the simple synchronous hint dispatcher shared by the cell-state
// puzzles. `makeSolver(ctx)` is a THUNK that constructs the solver from ctx — it
// MUST defer the solver-class reference to call time so the puzzle module stays
// require-safe under Node (where solver classes aren't globals).
function makeSimpleHintDispatch(type, makeSolver) {
  return function hintDispatch(ctx) {
    const { grid, solution, firstMismatch } = ctx;
    if (solution && firstMismatch(grid, solution)) {
      return { success: false, error: 'Current game state is wrong.' };
    }
    const solver = makeSolver(ctx);
    const hintCells = solver.getHint(grid);
    if (!hintCells || hintCells.length === 0) {
      return { success: false, error: 'No more cells can be deduced from the current state. Click Solve to finish.' };
    }
    return { success: true, hint: { type, extraCells: hintCells, count: hintCells.length }, grid, solution };
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { hashFNV1a, drawCrossCell, absoluteCellHintStatus, makeSimpleHintDispatch };
}
