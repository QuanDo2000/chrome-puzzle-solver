'use strict';

const { hashFNV1a } = require('../shared.js');

// Thermometers widget module — cell-state puzzle (Tapa/Tents family, margin clues). Value-space:
// cellStatus 0 unknown / 1 filled (mercury) / 2 empty. EVERY cell is tracked (no clue cells). Solver
// grid = 1 filled / 2 empty; readState is RAW so the default per-cell diff applies. drawStaticLayer
// renders the thermometer tubes + bulbs + row/col clue gutters; drawPreviewCell draws mercury.
// NO preview.js/diff.js/hint.js changes. hintDispatch has a cached-solution fallback (same as tents).

function hintBatchCap(rows, cols) { return Math.max(6, Math.ceil((rows * cols) / 30)); }

const thermometers = {
  type: 'thermometers',
  label: 'Thermometers',
  url: 'https://www.puzzles-mobile.com/thermometers/',
  solutionKeyPrefix: 'thermometers-solution:',
  skipAutoSolveGate: true,
  hasAbsoluteHintCells: true,
  hintBandSkip: true,
  renderEmptyCells: true,

  cacheKey(data) {
    if (data?.type !== 'thermometers' || !data.thermos) return null;
    const h = hashFNV1a((mix) => { mix(0x54); mix(data.rows); mix(data.cols); for (const therm of data.thermos) { mix(therm.length); for (const cell of therm) { mix(cell.r); mix(cell.c); } } for (const v of (data.colClue || [])) mix((v | 0) + 1); for (const v of (data.rowClue || [])) mix((v | 0) + 1); });
    return 'thermometers-solution:' + h.toString(16);
  },

  staticSig(data) { return 'th=' + _thermoSig(data?.type === 'thermometers' ? data : null); },

  canvasDims(pd, { grid }) {
    return { rows: pd?.rows || (Array.isArray(grid) ? grid.length : 0), cols: pd?.cols || (Array.isArray(grid) && grid[0] ? grid[0].length : 0), marginCells: 0.6 };
  },

  // Static layer: thermometer tubes (grey) with a bulb circle at index 0 + row/col clue gutters + border.
  drawStaticLayer(ctx, { rows, cols, cellSize, pd }) {
    const thermos = (pd && pd.thermos) || [], colClue = (pd && pd.colClue) || [], rowClue = (pd && pd.rowClue) || [];
    ctx.save();
    ctx.strokeStyle = '#cbd5e1'; ctx.fillStyle = '#cbd5e1';
    ctx.lineWidth = cellSize * 0.6; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const therm of thermos) {
      if (!therm || !therm.length) continue;
      const b = therm[0], bx = (b.c + 0.5) * cellSize, by = (b.r + 0.5) * cellSize;
      ctx.beginPath(); ctx.arc(bx, by, cellSize * 0.4, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath();
      for (let i = 0; i < therm.length; i++) { const x = (therm[i].c + 0.5) * cellSize, y = (therm[i].r + 0.5) * cellSize; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
      ctx.stroke();
    }
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

  // Dynamic: filled (1) -> red mercury circle; empty (2) -> bare tube (drawn by static layer).
  drawPreviewCell(ctx, { v, x, y, cellSize }) {
    if (v === 1) { ctx.fillStyle = '#ef4444'; ctx.beginPath(); ctx.arc(x + cellSize / 2, y + cellSize / 2, cellSize * 0.28, 0, Math.PI * 2); ctx.fill(); }
  },

  drawHintCell(ctx, { cell, cx, cy, cellSize }) {
    if (cell.value === 1 || cell.value === 2) { ctx.strokeStyle = cell.value === 1 ? '#ef4444' : '#60a5fa'; ctx.lineWidth = Math.max(2, Math.floor(cellSize / 9)); ctx.strokeRect(cx + 2, cy + 2, cellSize - 4, cellSize - 4); }
  },

  hintStatusNodes(h, { bold }) {
    const cells = h.extraCells || [];
    if (!cells.length) return ['No hint available'];
    if (cells.length === 1) { const cell = cells[0]; return ['Cell ', bold(`(row ${cell.row + 1}, col ${cell.col + 1})`), ' is ', bold(cell.value === 1 ? 'filled' : 'empty')]; }
    return [bold(String(cells.length)), ' cells can be deduced'];
  },

  solveExtraData(data) { return { rows: data.rows, cols: data.cols, thermos: data.thermos, colClue: data.colClue, rowClue: data.rowClue }; },
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
    if (dg && Array.isArray(dg.thermos)) {
      const Solver = (typeof ThermometersSolver !== 'undefined') ? ThermometersSolver : require('../../solvers/thermometers.js').ThermometersSolver;
      const forced = new Solver({ rows, cols, thermos: dg.thermos, colClue: dg.colClue, rowClue: dg.rowClue, maxMs: 1500 }).getHint(grid);
      if (forced && forced.length) {
        const batch = forced.slice(0, hintBatchCap(rows, cols));
        return { success: true, hint: { type: 'thermometers', extraCells: batch, count: batch.length }, grid, solution };
      }
    }
    if (!Array.isArray(solution)) return { success: false, error: 'No more cells can be deduced. Click Solve to finish.' };
    const cap = hintBatchCap(rows, cols); const cells = [];
    for (let r = 0; r < rows && cells.length < cap; r++) for (let c = 0; c < cols && cells.length < cap; c++) {
      const sv = solution[r] ? solution[r][c] : 0;
      if (sv !== 1 && sv !== 2) continue;
      const cur = grid && grid[r] ? grid[r][c] : 0;
      if (cur === sv) continue;
      cells.push({ row: r, col: c, value: sv });
    }
    if (!cells.length) return { success: false, error: 'No hint available' };
    return { success: true, hint: { type: 'thermometers', extraCells: cells, count: cells.length }, grid, solution };
  },
};

function _thermoSig(data) {
  if (!data) return '0';
  const h = hashFNV1a((mix) => { for (const therm of (data.thermos || [])) { mix(therm.length); for (const cell of therm) { mix(cell.r); mix(cell.c); } } for (const v of (data.colClue || [])) mix((v | 0) + 1); for (const v of (data.rowClue || [])) mix((v | 0) + 1); });
  return h.toString(16);
}

if (typeof module !== 'undefined' && module.exports) { module.exports = thermometers; }
