'use strict';

// Kakurasu puzzle module — Stage C migration.
//
// Hooks consumed by the Stage-B dispatchers (cache.js, preview.js,
// widget.js, content.js):
//   cacheKey         — FNV-1a over rowClues + colClues; 'K' nameplate
//                      keeps keys disjoint.
//   staticSig        — contributes a rowClues+colClues signature to the
//                      preview's static-layer cache key.
//   drawStaticLayer  — outer border + row clues painted in the right rim
//                      column + column clues painted along the bottom
//                      rim row.
//   drawPreviewCell  — v=1 fills the cell dark (inset square); v=2
//                      renders a faint × cross marking confirmed empty;
//                      v=0 stays empty (the v===0 gate in preview.js
//                      still excludes kakurasu so unknown cells fall to
//                      the early-bail above the cell-draw loop).
//   hintStatusNodes  — single-cell hints describe "must be filled /
//                      empty"; multi-cell hints summarise the count.
//   solveExtraData   — extra payload for the solver worker: rows, cols,
//                      rowClues, colClues.
//   partialResultArm — wraps applyGridPartialResult so the Stage-B
//                      applyPartialResult dispatcher can route kakurasu
//                      partial-solve timeouts into the generic grid
//                      partial UI.
//   canvasDims       — Kakurasu needs an (N+1)×(N+1) canvas to fit the
//                      clue rim. Returns padRight=1, padBottom=1 so the
//                      preview.js dispatcher expands wFull/hFull
//                      accordingly. Stage D Task 5.

const kakurasu = {
  type: 'kakurasu',
  label: 'Kakurasu',
  url: 'https://www.puzzles-mobile.com/kakurasu/',
  solutionKeyPrefix: 'kakurasu-solution:',
  skipAutoSolveGate: true,
  hasAbsoluteHintCells: true,
  hintBandSkip: true,
  renderEmptyCells: true,

  cacheKey(data) {
    if (data?.type !== 'kakurasu' || !data.rowClues || !data.colClues) return null;
    let h = 0x811c9dc5;
    const mix = (n) => { h ^= n & 0xff; h = Math.imul(h, 0x01000193) >>> 0; };
    mix(0x4B); // 'K' nameplate
    mix(data.rows); mix(data.cols);
    for (const v of data.rowClues) mix(v + 1);
    for (const v of data.colClues) mix(v + 1);
    return 'kakurasu-solution:' + (h >>> 0).toString(16);
  },

  staticSig(data) {
    return 'ka=' + _kakurasuCluesSig(data?.rowClues, data?.colClues);
  },

  canvasDims(pd, { grid }) {
    return { rows: grid.length, cols: grid[0]?.length || 0, padRight: 1, padBottom: 1 };
  },

  drawStaticLayer(ctx, { rows, cols, cellSize, pd }) {
    if (!Array.isArray(pd.rowClues) || !Array.isArray(pd.colClues)) return;
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
  },

  drawPreviewCell(ctx, { v, x, y, cellSize }) {
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
  },

  drawHintCell(ctx, { cell, cx, cy, cellSize }) {
    // Kakurasu hint: value 1 = must be filled (darker blue ring),
    // value 2 = must be crossed (lighter blue ring).
    if (cell.value === 1 || cell.value === 2) {
      ctx.strokeStyle = cell.value === 1 ? '#3b82f6' : '#60a5fa';
      ctx.lineWidth = Math.max(2, Math.floor(cellSize / 9));
      ctx.strokeRect(cx + 2, cy + 2, cellSize - 4, cellSize - 4);
    }
  },

  hintStatusNodes(h, { bold }) {
    // Kakurasu hints carry absolute cells in extraCells.
    // cellStatus 1 = filled (black), 2 = empty (white).
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
    if (h._fullCount && h._fullCount > cells.length) {
      return [bold(String(cells.length)), ` (of ${h._fullCount}) cells can be deduced`];
    }
    return [bold(String(cells.length)), ' cells can be deduced'];
  },

  solveExtraData(data) {
    return { rows: data.rows, cols: data.cols, rowClues: data.rowClues, colClues: data.colClues };
  },

  partialResultArm(result, { applyGridPartialResult }) {
    applyGridPartialResult(result);
  },

  // Hint dispatch for Kakurasu. hintCells from the solver is absolute
  // {row, col, value} packed as extraCells. Mirrors the previous inline arm
  // in content.js's getHint verbatim.
  hintDispatch(ctx) {
    const { detectedGrid, grid, solution, rows, cols, firstMismatch } = ctx;
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
    const hint = { type: 'kakurasu', extraCells: hintCells, count: hintCells.length };
    return { success: true, hint, grid, solution };
  },
};

// Local copy of preview.js's kakurasuCluesSig — only used by staticSig
// above. Inlined here (matches hitori's `_hitoriTaskSig` pattern) so
// the module is self-contained.
function _kakurasuCluesSig(rowClues, colClues) {
  if (!rowClues || !colClues) return '0';
  let h = 0x811c9dc5;
  for (const v of rowClues) { h ^= v & 0xff; h = Math.imul(h, 0x01000193) >>> 0; }
  for (const v of colClues) { h ^= v & 0xff; h = Math.imul(h, 0x01000193) >>> 0; }
  return (h >>> 0).toString(16);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = kakurasu;
}
