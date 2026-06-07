'use strict';

const { hashFNV1a } = require('../shared.js');

// Lollipops widget module — cell-state puzzle, clue cells are in-grid FIXED shapes (not tracked in
// cellStatus — the clue-cells-not-in-cellStatus family). Value-space: cellStatus 0 unknown / 1 candy
// / 2 v-stick / 3 h-stick / 4 cross. Solver grid: clue cells 0, free cells 1/2/3/4. readState is RAW
// so the default per-cell diff applies. drawStaticLayer renders the given clue shapes from pd.task;
// drawPreviewCell renders placed shapes. NO preview.js/diff.js/hint.js changes. applyHint is custom
// (the generic applyHintCells binary-clamps, destroying h(3)/cross(4) — same as pipes). hintDispatch
// has a cached-solution fallback.

function hintBatchCap(rows, cols) { return Math.max(6, Math.ceil((rows * cols) / 30)); }

// Shared glyph drawing for a shape value in a cell box (x,y,cellSize). color overrides the fill.
function drawShape(ctx, v, x, y, cellSize, color) {
  const cx = x + cellSize / 2, cy = y + cellSize / 2;
  ctx.fillStyle = color;
  if (v === 1) { ctx.beginPath(); ctx.arc(cx, cy, cellSize * 0.3, 0, Math.PI * 2); ctx.fill(); }
  else if (v === 2) { ctx.fillRect(cx - cellSize * 0.12, y + cellSize * 0.16, cellSize * 0.24, cellSize * 0.68); }
  else if (v === 3) { ctx.fillRect(x + cellSize * 0.16, cy - cellSize * 0.12, cellSize * 0.68, cellSize * 0.24); }
}

const lollipops = {
  type: 'lollipops',
  label: 'Lollipops',
  url: 'https://www.puzzles-mobile.com/lollipops/',
  solutionKeyPrefix: 'lollipops-solution:',
  skipAutoSolveGate: true,
  hasAbsoluteHintCells: true,
  hintBandSkip: true,
  renderEmptyCells: true,

  cacheKey(data) {
    if (data?.type !== 'lollipops' || !data.task) return null;
    const h = hashFNV1a((mix) => { mix(0x6c); mix(data.rows); mix(data.cols); for (const row of data.task) for (const v of row) mix((v | 0) + 2); });
    return 'lollipops-solution:' + h.toString(16);
  },

  staticSig(data) { return 'll=' + _lolliSig(data?.type === 'lollipops' ? data : null); },

  canvasDims(pd, { grid }) {
    return { rows: pd?.rows || (Array.isArray(grid) ? grid.length : 0), cols: pd?.cols || (Array.isArray(grid) && grid[0] ? grid[0].length : 0), marginCells: 0.15 };
  },

  // Static layer: given clue shapes (from pd.task) in a distinct colour + grid border.
  drawStaticLayer(ctx, { rows, cols, cellSize, pd }) {
    const task = (pd && pd.task) || [];
    ctx.save();
    for (let r = 0; r < rows; r++) { const row = task[r] || []; for (let c = 0; c < cols; c++) { const v = row[c]; if (v === 1 || v === 2 || v === 3) drawShape(ctx, v, c * cellSize, r * cellSize, cellSize, '#7c3aed'); } }
    const borderW = Math.max(2, Math.floor(cellSize / 6));
    ctx.strokeStyle = '#1f2937'; ctx.lineWidth = borderW; ctx.lineCap = 'square';
    ctx.strokeRect(borderW / 2, borderW / 2, cols * cellSize - borderW, rows * cellSize - borderW);
    ctx.restore();
  },

  // Dynamic: placed shapes (candy/v/h) in red; cross (4) -> faint x; unknown/clue -> nothing.
  drawPreviewCell(ctx, { v, x, y, cellSize, r, c, puzzleData }) {
    if (puzzleData?.task?.[r]?.[c] >= 0) return; // clue cell drawn by the static layer
    if (v === 1 || v === 2 || v === 3) drawShape(ctx, v, x, y, cellSize, '#dc2626');
    else if (v === 4) { ctx.strokeStyle = 'rgba(100,116,139,0.5)'; ctx.lineWidth = Math.max(1, cellSize * 0.04); const p = cellSize * 0.36; ctx.beginPath(); ctx.moveTo(x + p, y + p); ctx.lineTo(x + cellSize - p, y + cellSize - p); ctx.moveTo(x + cellSize - p, y + p); ctx.lineTo(x + p, y + cellSize - p); ctx.stroke(); }
  },

  drawHintCell(ctx, { cell, cx, cy, cellSize }) {
    if ([1, 2, 3, 4].includes(cell.value)) { ctx.strokeStyle = '#dc2626'; ctx.lineWidth = Math.max(2, Math.floor(cellSize / 9)); ctx.strokeRect(cx + 2, cy + 2, cellSize - 4, cellSize - 4); }
  },

  hintStatusNodes(h, { bold }) {
    const cells = h.extraCells || [];
    if (!cells.length) return ['No hint available'];
    const name = { 1: 'a candy', 2: 'a vertical stick', 3: 'a horizontal stick', 4: 'empty' };
    if (cells.length === 1) { const cell = cells[0]; return ['Cell ', bold(`(row ${cell.row + 1}, col ${cell.col + 1})`), ' is ', bold(name[cell.value] || '?')]; }
    return [bold(String(cells.length)), ' cells can be deduced'];
  },

  solveExtraData(data) { return { rows: data.rows, cols: data.cols, task: data.task }; },
  solutionFromResult(result) { return (result && result.grid) ? result.grid : null; },
  solutionToCacheJson(solution) { return Array.isArray(solution) ? { grid: solution.map((row) => row.slice()) } : null; },
  solutionFromCacheJson(parsed) { return (parsed && Array.isArray(parsed.grid)) ? parsed.grid.map((row) => row.slice()) : null; },

  partialResultArm(result, { applyGridPartialResult }) { applyGridPartialResult(result); },

  // Custom apply: the generic applyHintCells binary-clamps (h(3)/cross(4) -> 0). Read the live board,
  // overlay the hint's raw values, and apply through applyLollipopsState (the path Loop uses).
  async applyHint(hint, { callMainWorld, puzzleData, hintAbsoluteCells }) {
    const rows = puzzleData.rows, cols = puzzleData.cols;
    const cur = await callMainWorld('readLollipopsState', [rows, cols]);
    const grid = (cur || Array.from({ length: rows }, () => new Array(cols).fill(0))).map((row) => row.slice());
    for (const cell of hintAbsoluteCells(hint)) { if (grid[cell.row]) grid[cell.row][cell.col] = cell.value | 0; }
    return !!(await callMainWorld('applyLollipopsState', [grid]));
  },

  hintDispatch(ctx) {
    const { grid, solution, rows, cols, detectedGrid, firstMismatch } = ctx;
    if (solution && firstMismatch && firstMismatch(grid, solution)) {
      return { success: false, error: 'Current game state is wrong.' };
    }
    const dg = detectedGrid;
    if (dg && Array.isArray(dg.task)) {
      const Solver = (typeof LollipopsSolver !== 'undefined') ? LollipopsSolver : require('../../solvers/lollipops.js').LollipopsSolver;
      const forced = new Solver({ rows, cols, task: dg.task, maxMs: 1500 }).getHint(grid);
      if (forced && forced.length) {
        const batch = forced.slice(0, hintBatchCap(rows, cols));
        return { success: true, hint: { type: 'lollipops', extraCells: batch, count: batch.length }, grid, solution };
      }
    }
    if (!Array.isArray(solution)) return { success: false, error: 'No more cells can be deduced. Click Solve to finish.' };
    const cap = hintBatchCap(rows, cols); const cells = [];
    const task = dg && dg.task;
    for (let r = 0; r < rows && cells.length < cap; r++) for (let c = 0; c < cols && cells.length < cap; c++) {
      if (task && task[r] && task[r][c] >= 0) continue; // skip clue cells
      const sv = solution[r] ? solution[r][c] : 0;
      if (sv !== 1 && sv !== 2 && sv !== 3 && sv !== 4) continue;
      const cur = grid && grid[r] ? grid[r][c] : 0;
      if (cur === sv) continue;
      cells.push({ row: r, col: c, value: sv });
    }
    if (!cells.length) return { success: false, error: 'No hint available' };
    return { success: true, hint: { type: 'lollipops', extraCells: cells, count: cells.length }, grid, solution };
  },
};

function _lolliSig(data) {
  if (!data) return '0';
  const h = hashFNV1a((mix) => { for (const row of (data.task || [])) for (const v of row) mix((v | 0) + 2); });
  return h.toString(16);
}

if (typeof module !== 'undefined' && module.exports) { module.exports = lollipops; }
