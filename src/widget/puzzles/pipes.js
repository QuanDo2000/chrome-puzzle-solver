'use strict';

const { hashFNV1a } = require('../shared.js');
const { rotationCount } = require('../pipes-rotation.js');

// Pipes (Net) rotation puzzle. detectedGrid.task / puzzleData.task = per-cell
// 4-bit arm masks in the page's CURRENT (scrambled) orientation. solution =
// per-cell SOLVED masks (N=1,E=2,S=4,W=8). The board state read back by
// readPipesState = per-cell rotation COUNTS (0..3), NOT masks.
// See docs/superpowers/specs/2026-05-30-pipes-design.md.
//
// Integration points verified against the live dispatchers (Task 8):
//   drawPreviewCell(ctx, {r,c,v,x,y,cellSize,puzzleData,...}) — preview.js
//     (renderPreview) feeds v = grid[r][c] = the BOARD's rotation count, NOT
//     the solved mask. So the per-cell arm overlay is drawn from
//     puzzleData.solution[r][c] (the solved mask), with renderEmptyCells:true
//     so zero-count cells still paint.
//   loopDoneCheck(ctx) — SINGLE ctx arg { boardState, solution, puzzleData }
//     (widget.js runLoop). boardState is the rotation-count grid; task/rows/
//     cols come from puzzleData (NOT a detectedGrid field — it isn't in ctx).
//   hintDispatch(ctx) — SINGLE ctx arg { detectedGrid, grid, solution, rows,
//     cols, firstMismatch, ... } (hint.js getHint). grid is the live
//     rotation-count board.
//
// PIPE_PAGE_CW selects which direction one cellStatus step represents. Verified
// live (Task-9 probe): the page's getNextStatus DECREMENTS the count for a
// clockwise turn (one CW click moved cellStatus 0 -> 3), so cellStatus counts
// COUNTER-CLOCKWISE steps from the given orientation — hence false.
// rotationCount(task, solved, false) yields the count the page needs.

const PIPE_PAGE_CW = false;

const pipes = {
  type: 'pipes',
  label: 'Pipes',
  url: 'https://www.puzzles-mobile.com/pipes/random/4x4',
  solutionKeyPrefix: 'pipes-solution:',
  skipAutoSolveGate: true,
  hasAbsoluteHintCells: true,
  hintBandSkip: true,
  renderEmptyCells: true,

  cacheKey(data) {
    if (!data || data.type !== 'pipes' || !data.task) return null;
    const h = hashFNV1a((mix) => {
      mix(0x50); // 'P' nameplate
      mix(data.rows | 0); mix(data.cols | 0);
      for (const row of data.task) for (const v of row) mix((v | 0) + 1);
    });
    return 'pipes-solution:' + h.toString(16);
  },

  solveExtraData(data) {
    return { rows: data.rows, cols: data.cols, task: data.task, wrap: 'auto' };
  },

  // Convert solver's solved masks to per-cell rotation counts vs the given task.
  solutionToRotations(task, solution, rows, cols) {
    const out = [];
    for (let r = 0; r < rows; r++) {
      const row = new Array(cols);
      for (let c = 0; c < cols; c++) row[c] = rotationCount(task[r][c], solution[r][c], PIPE_PAGE_CW);
      out.push(row);
    }
    return out;
  },

  // preview.js passes v = grid[r][c] = the board's rotation count, so we ignore
  // it and draw the SOLVED arm mask from puzzleData.solution[r][c]. Before a
  // solve lands there is no solution; render nothing for that cell.
  drawPreviewCell(ctx, { r, c, x, y, cellSize, puzzleData }) {
    const sol = puzzleData && puzzleData.solution;
    const v = (sol && sol[r] && sol[r][c]) | 0;
    if (!v) return;
    const cx = x + cellSize / 2, cy = y + cellSize / 2;
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = Math.max(2, Math.floor(cellSize / 8));
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (v & 1) { ctx.moveTo(cx, cy); ctx.lineTo(cx, y); }
    if (v & 2) { ctx.moveTo(cx, cy); ctx.lineTo(x + cellSize, cy); }
    if (v & 4) { ctx.moveTo(cx, cy); ctx.lineTo(cx, y + cellSize); }
    if (v & 8) { ctx.moveTo(cx, cy); ctx.lineTo(x, cy); }
    ctx.stroke();
    const arms = (v & 1 ? 1 : 0) + (v & 2 ? 1 : 0) + (v & 4 ? 1 : 0) + (v & 8 ? 1 : 0);
    ctx.fillStyle = '#2563eb';
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(2, Math.floor(cellSize / (arms === 1 ? 6 : 10))), 0, Math.PI * 2);
    ctx.fill();
  },

  // Hint cells carry a rotation COUNT as `value` (not 1/-1), so the default
  // preview paint (value===1 fill / value===-1 cross) wouldn't draw them.
  // Ring every hint cell in blue to mark "rotate me".
  drawHintCell(ctx, { cx, cy, cellSize }) {
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = Math.max(2, Math.floor(cellSize / 9));
    ctx.strokeRect(cx + 2, cy + 2, cellSize - 4, cellSize - 4);
  },

  hintStatusNodes(h, { bold }) {
    const cells = h.extraCells || [];
    if (cells.length === 0) return ['No rotations needed'];
    if (cells.length === 1) {
      const cell = cells[0];
      return ['Rotate ', bold(`(row ${cell.row + 1}, col ${cell.col + 1})`), ' to its correct orientation'];
    }
    return ['Rotate ', bold(String(cells.length)), ' cells to their correct orientation'];
  },

  // hintDispatch(ctx): ctx = { detectedGrid, grid, solution, rows, cols, ... }.
  // grid is the live rotation-count board; targets are the solved rotation
  // counts. extraCells are the cells whose current rotation != target.
  hintDispatch(ctx) {
    const { detectedGrid, grid, solution, rows, cols } = ctx;
    if (!solution) return { success: false, error: 'No solution available yet. Click Solve first.' };
    const targets = pipes.solutionToRotations(detectedGrid.task, solution, rows, cols);
    const cells = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const cur = (grid && grid[r] && grid[r][c]) | 0;
      if (cur !== targets[r][c]) cells.push({ row: r, col: c, value: targets[r][c] });
    }
    if (cells.length === 0) return { success: false, error: 'Already solved. Nothing to rotate.' };
    return { success: true, hint: { type: 'pipes', extraCells: cells, count: cells.length }, grid, solution };
  },

  // loopDoneCheck(ctx): SINGLE ctx arg { boardState, solution, puzzleData }.
  // boardState is the live rotation-count grid; task/rows/cols come from
  // puzzleData (detectedGrid is NOT threaded into this ctx).
  loopDoneCheck(ctx) {
    const boardState = ctx && ctx.boardState;
    const solution = ctx && ctx.solution;
    const pd = ctx && ctx.puzzleData;
    if (!solution || !pd || !pd.task) return false;
    const rows = pd.rows, cols = pd.cols;
    const targets = pipes.solutionToRotations(pd.task, solution, rows, cols);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const cur = (boardState && boardState[r] && boardState[r][c]) | 0;
      if (cur !== targets[r][c]) return false;
    }
    return true;
  },

  partialResultArm(result, { applyGridPartialResult }) {
    applyGridPartialResult(result);
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = pipes;
}
