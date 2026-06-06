'use strict';

const { hashFNV1a } = require('../shared.js');

// Tents widget module — cell-state matching puzzle (Tapa/Nurikabe family). Value-space: cellStatus
// 0 unknown / 1 tent / 2 grass. Tree cells (trees[r][c]===1) are NOT tracked in cellStatus;
// drawStaticLayer renders the tree + the row/col clue numbers, drawPreviewCell/apply/diff skip
// them, and getHint re-asserts them not-tent ([[project_clue_cells_not_in_cellstatus]]). Solution =
// the solver grid (returned as-is); readState is RAW so the default per-cell diff applies. NO
// preview.js/diff.js/hint.js changes. hintDispatch has a cached-solution fallback (deduction stalls).

function hintBatchCap(rows, cols) { return Math.max(6, Math.ceil((rows * cols) / 30)); }

const tents = {
  type: 'tents',
  label: 'Tents',
  url: 'https://www.puzzles-mobile.com/tents/',
  solutionKeyPrefix: 'tents-solution:',
  skipAutoSolveGate: true,
  hasAbsoluteHintCells: true,
  hintBandSkip: true,
  renderEmptyCells: true,

  cacheKey(data) {
    if (data?.type !== 'tents' || !data.trees) return null;
    const h = hashFNV1a((mix) => { mix(0x45); mix(data.rows); mix(data.cols); for (const row of data.trees) for (const v of row) mix(v ? 1 : 0); for (const v of (data.colClue || [])) mix((v | 0) + 1); for (const v of (data.rowClue || [])) mix((v | 0) + 1); });
    return 'tents-solution:' + h.toString(16);
  },

  staticSig(data) { return 'te=' + _tentsSig(data?.type === 'tents' ? data : null); },

  canvasDims(pd, { grid }) {
    return { rows: pd?.rows || (Array.isArray(grid) ? grid.length : 0), cols: pd?.cols || (Array.isArray(grid) && grid[0] ? grid[0].length : 0), marginCells: 0.6 };
  },

  // Static layer: tree glyphs in tree cells + row/col clue numbers in the margin gutters + border.
  drawStaticLayer(ctx, { rows, cols, cellSize, pd }) {
    const trees = (pd && pd.trees) || [], colClue = (pd && pd.colClue) || [], rowClue = (pd && pd.rowClue) || [];
    ctx.save();
    for (let r = 0; r < rows; r++) { const row = trees[r] || []; for (let c = 0; c < cols; c++) { if (!row[c]) continue; const cx = (c + 0.5) * cellSize, cy = (r + 0.5) * cellSize, s = cellSize * 0.32; ctx.fillStyle = '#15803d'; ctx.beginPath(); ctx.moveTo(cx, cy - s); ctx.lineTo(cx + s, cy + s * 0.6); ctx.lineTo(cx - s, cy + s * 0.6); ctx.closePath(); ctx.fill(); ctx.fillStyle = '#92400e'; ctx.fillRect(cx - cellSize * 0.05, cy + s * 0.6, cellSize * 0.1, cellSize * 0.18); } }
    ctx.fillStyle = '#1f2937'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `bold ${Math.max(8, Math.floor(cellSize * 0.5))}px sans-serif`;
    const g = cellSize * 0.6;
    for (let c = 0; c < cols; c++) ctx.fillText(String(colClue[c] ?? ''), (c + 0.5) * cellSize, -g / 2);
    for (let r = 0; r < rows; r++) ctx.fillText(String(rowClue[r] ?? ''), -g / 2, (r + 0.5) * cellSize);
    const borderW = Math.max(2, Math.floor(cellSize / 6));
    ctx.strokeStyle = '#1f2937'; ctx.lineWidth = borderW; ctx.lineCap = 'square';
    ctx.strokeRect(borderW / 2, borderW / 2, cols * cellSize - borderW, rows * cellSize - borderW);
    ctx.restore();
  },

  // Dynamic: tent (1) -> amber triangle; grass (2) -> small green dot; tree cells & unknown skipped.
  drawPreviewCell(ctx, { r, c, v, x, y, cellSize, puzzleData }) {
    if (puzzleData?.trees?.[r]?.[c]) return; // tree cell (drawStaticLayer drew it)
    if (v === 1) { const cx = x + cellSize / 2, cy = y + cellSize / 2, s = cellSize * 0.3; ctx.fillStyle = '#b45309'; ctx.beginPath(); ctx.moveTo(cx, cy - s); ctx.lineTo(cx + s, cy + s); ctx.lineTo(cx - s, cy + s); ctx.closePath(); ctx.fill(); }
    else if (v === 2) { ctx.fillStyle = 'rgba(34,197,94,0.6)'; ctx.beginPath(); ctx.arc(x + cellSize / 2, y + cellSize / 2, Math.max(2, cellSize * 0.12), 0, Math.PI * 2); ctx.fill(); }
  },

  drawHintCell(ctx, { cell, cx, cy, cellSize }) {
    if (cell.value === 1 || cell.value === 2) { ctx.strokeStyle = cell.value === 1 ? '#b45309' : '#60a5fa'; ctx.lineWidth = Math.max(2, Math.floor(cellSize / 9)); ctx.strokeRect(cx + 2, cy + 2, cellSize - 4, cellSize - 4); }
  },

  hintStatusNodes(h, { bold }) {
    const cells = h.extraCells || [];
    if (!cells.length) return ['No hint available'];
    if (cells.length === 1) { const cell = cells[0]; return ['Cell ', bold(`(row ${cell.row + 1}, col ${cell.col + 1})`), ' is ', bold(cell.value === 1 ? 'a tent' : 'grass')]; }
    return [bold(String(cells.length)), ' cells can be deduced'];
  },

  solveExtraData(data) { return { rows: data.rows, cols: data.cols, trees: data.trees, colClue: data.colClue, rowClue: data.rowClue }; },
  solutionFromResult(result) { return (result && result.grid) ? result.grid : null; },
  solutionToCacheJson(solution) { return Array.isArray(solution) ? { grid: solution.map((row) => row.slice()) } : null; },
  solutionFromCacheJson(parsed) { return (parsed && Array.isArray(parsed.grid)) ? parsed.grid.map((row) => row.slice()) : null; },

  partialResultArm(result, { applyGridPartialResult }) { applyGridPartialResult(result); },

  hintDispatch(ctx) {
    const { grid, solution, rows, cols, detectedGrid, firstMismatch } = ctx;
    if (solution && firstMismatch && firstMismatch(grid, solution)) {
      return { success: false, error: 'Current game state is wrong.' };
    }
    const dg = detectedGrid;
    if (dg && Array.isArray(dg.trees)) {
      const Solver = (typeof TentsSolver !== 'undefined') ? TentsSolver : require('../../solvers/tents.js').TentsSolver;
      const forced = new Solver({ rows, cols, trees: dg.trees, colClue: dg.colClue, rowClue: dg.rowClue, maxMs: 1500 }).getHint(grid);
      if (forced && forced.length) {
        const batch = forced.slice(0, hintBatchCap(rows, cols));
        return { success: true, hint: { type: 'tents', extraCells: batch, count: batch.length }, grid, solution };
      }
    }
    if (!Array.isArray(solution)) return { success: false, error: 'No more cells can be deduced. Click Solve to finish.' };
    const cap = hintBatchCap(rows, cols); const cells = [];
    const trees = dg && dg.trees;
    for (let r = 0; r < rows && cells.length < cap; r++) for (let c = 0; c < cols && cells.length < cap; c++) {
      if (trees && trees[r] && trees[r][c]) continue;
      const sv = solution[r] ? solution[r][c] : 0;
      if (sv !== 1 && sv !== 2) continue;
      const cur = grid && grid[r] ? grid[r][c] : 0;
      if (cur === sv) continue;
      cells.push({ row: r, col: c, value: sv });
    }
    if (!cells.length) return { success: false, error: 'No hint available' };
    return { success: true, hint: { type: 'tents', extraCells: cells, count: cells.length }, grid, solution };
  },
};

function _tentsSig(data) {
  if (!data) return '0';
  const h = hashFNV1a((mix) => { for (const row of (data.trees || [])) for (const v of row) mix(v ? 1 : 0); for (const v of (data.colClue || [])) mix((v | 0) + 1); for (const v of (data.rowClue || [])) mix((v | 0) + 1); });
  return h.toString(16);
}

if (typeof module !== 'undefined' && module.exports) { module.exports = tents; }
