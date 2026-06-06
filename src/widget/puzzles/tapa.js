'use strict';

const { hashFNV1a, drawCrossCell, absoluteCellHintStatus, makeSimpleHintDispatch } = require('../shared.js');

// Tapa widget module — cell-state shading puzzle (Nurikabe family). Value-space: cellStatus
// 0 unknown / 1 shaded / 2 not-shaded. Clue cells (task >= 0 or -2) are NOT tracked in cellStatus;
// drawStaticLayer renders their run-digits, drawPreviewCell/apply/diff skip them, and the solver's
// getHint re-asserts them not-shaded ([[project_clue_cells_not_in_cellstatus]]). Solution = the
// solver grid (returned as-is); readState is RAW so the default per-cell diff applies and Loop
// preserves marks (no preview.js/diff.js/hint.js changes needed).

const tapa = {
  type: 'tapa',
  label: 'Tapa',
  url: 'https://www.puzzles-mobile.com/tapa/',
  solutionKeyPrefix: 'tapa-solution:',
  skipAutoSolveGate: true,
  hasAbsoluteHintCells: true,
  hintBandSkip: true,
  renderEmptyCells: true,

  cacheKey(data) {
    if (data?.type !== 'tapa' || !data.task) return null;
    const h = hashFNV1a((mix) => { mix(0x54); mix(data.rows); mix(data.cols); for (const row of data.task) for (const v of row) { mix((v + 3) & 0xff); mix(((v + 3) >>> 8) & 0xff); } });
    return 'tapa-solution:' + h.toString(16);
  },

  staticSig(data) { return 'tp=' + _tapaTaskSig(data?.task); },

  canvasDims(pd, { grid }) {
    return { rows: pd?.rows || (Array.isArray(grid) ? grid.length : 0), cols: pd?.cols || (Array.isArray(grid) && grid[0] ? grid[0].length : 0), marginCells: 0 };
  },

  // Static layer: clue-run digits in clue cells + outer border.
  drawStaticLayer(ctx, { rows, cols, cellSize, pd }) {
    const task = (pd && pd.task) || [];
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let r = 0; r < rows; r++) { const row = task[r] || []; for (let c = 0; c < cols; c++) {
      const v = row[c];
      if (typeof v !== 'number' || v === -1) continue;
      const txt = v === -2 ? '?' : String(v);
      const fontPx = Math.max(8, Math.floor(cellSize * (txt.length >= 3 ? 0.34 : txt.length === 2 ? 0.42 : 0.5)));
      ctx.font = `bold ${fontPx}px sans-serif`;
      ctx.fillStyle = '#1f2937';
      ctx.fillText(txt, (c + 0.5) * cellSize, (r + 0.5) * cellSize);
    } }
    const borderW = Math.max(2, Math.floor(cellSize / 6));
    ctx.strokeStyle = '#1f2937'; ctx.lineWidth = borderW; ctx.lineCap = 'square';
    ctx.strokeRect(borderW / 2, borderW / 2, cols * cellSize - borderW, rows * cellSize - borderW);
    ctx.restore();
  },

  // Dynamic: shaded (1) -> dark fill; not-shaded (2) -> cross; clue cells skipped (drawStaticLayer
  // drew the digit); unknown (0) draws nothing.
  drawPreviewCell(ctx, { r, c, v, x, y, cellSize, puzzleData }) {
    const t = puzzleData?.task?.[r]?.[c];
    if (typeof t === 'number' && t !== -1) return; // clue / "B" cell
    if (v === 1) { const pad = Math.max(2, Math.floor(cellSize * 0.1)); ctx.fillStyle = '#1f2937'; ctx.fillRect(x + pad, y + pad, cellSize - 2 * pad, cellSize - 2 * pad); }
    else if (v === 2) { drawCrossCell(ctx, x, y, cellSize); }
  },

  drawHintCell(ctx, { cell, cx, cy, cellSize }) {
    if (cell.value === 1 || cell.value === 2) { ctx.strokeStyle = cell.value === 1 ? '#3b82f6' : '#60a5fa'; ctx.lineWidth = Math.max(2, Math.floor(cellSize / 9)); ctx.strokeRect(cx + 2, cy + 2, cellSize - 4, cellSize - 4); }
  },

  hintStatusNodes(h, ctx) { return absoluteCellHintStatus(h, ctx, 'shaded (black)', 'not shaded (white)'); },

  solveExtraData(data) { return { rows: data.rows, cols: data.cols, task: data.task }; },
  solutionFromResult(result) { return (result && result.grid) ? result.grid : null; },
  solutionToCacheJson(solution) { return Array.isArray(solution) ? { grid: solution.map((row) => row.slice()) } : null; },
  solutionFromCacheJson(parsed) { return (parsed && Array.isArray(parsed.grid)) ? parsed.grid.map((row) => row.slice()) : null; },

  partialResultArm(result, { applyGridPartialResult }) { applyGridPartialResult(result); },

  hintDispatch: makeSimpleHintDispatch('tapa', (ctx) =>
    new TapaSolver({ rows: ctx.rows, cols: ctx.cols, task: ctx.detectedGrid.task })),
};

function _tapaTaskSig(task) {
  if (!task) return '0';
  const h = hashFNV1a((mix) => { for (const row of task) for (const v of row) { mix((v + 3) & 0xff); mix(((v + 3) >>> 8) & 0xff); } });
  return h.toString(16);
}

if (typeof module !== 'undefined' && module.exports) { module.exports = tapa; }
