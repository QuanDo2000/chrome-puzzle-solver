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
// PIPE_PAGE_CW selects which per-increment bit transform a cellStatus step
// applies. MEASURED live (/pipes/quest/4x4, task=8: cellStatus 1 → mask 1=E,
// 2 → mask 2=N): each +1 increment advances bits via (m<<1)|(m>>3), i.e. the
// solver's rotateCW. So rotationCount(task, solved, true) gives the number of
// page increments that turn the given mask into the solved mask. (This is
// proven by applying the counts through the real page transform and recovering
// the solved grid; see the pipes fuzz/integration tests.)

const PIPE_PAGE_CW = true;

// Smallest Loop batch on tiny boards: with ceil(rows*cols/30), a 4x4 would emit
// 1 cell/step (16 steps). A floor of 4 keeps tiny boards to a few brisk steps
// while ceil(rows*cols/30) dominates on large boards (~30 steps max).
const PIPE_HINT_FLOOR = 4;

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
      // Nameplate version. 0x50 ('P') = original; 0x51 = post-geometry-fix;
      // 0x52 = solution now cached as rotation COUNTS (not masks). Bump on any
      // change to the cached solution's encoding so stale entries are ignored.
      mix(0x52);
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

  // THE conversion boundary. The solver returns solved arm MASKS, but the page
  // (and readState/cellStatus, the board grid drawPreview renders) speak rotation
  // COUNTS. Per the widget contract (recordSolveSuccess: "keep puzzleData.solution
  // in the same shape readState returns"), convert masks→counts ONCE here so every
  // downstream consumer — preview, apply, hint, loopDoneCheck, cache — uniformly
  // sees counts and needs no per-site conversion. Falls back to the raw grid if
  // puzzleData/task isn't available (keeps the hook null-safe).
  solutionFromResult(result, puzzleData) {
    const grid = result && result.grid;
    if (!grid || !puzzleData || !puzzleData.task) return grid;
    return pipes.solutionToRotations(puzzleData.task, grid, puzzleData.rows, puzzleData.cols);
  },

  // Draw each cell in its CURRENT page orientation so the preview mirrors the
  // board. preview.js passes v = grid[r][c] = the cell's rotation COUNT and
  // taskVal = the given arm mask. The displayed mask is the task mask stepped
  // `v` times. Page convention (verified live on /pipes/quest/4x4, task=8 at
  // count 0/1/2 points S/E/N): bit→side map is 1=East, 2=North, 4=West,
  // 8=South, and one cellStatus step advances bits via (m<<1)|(m>>3).
  drawPreviewCell(ctx, { v, taskVal, x, y, cellSize }) {
    const E = 1, N = 2, W = 4, S = 8;
    const step = (m) => ((m << 1) | (m >> 3)) & 0xF;
    let mask = (taskVal | 0) & 0xF;
    for (let k = 0; k < (((v | 0) % 4) + 4) % 4; k++) mask = step(mask);
    if (!mask) return;
    const cx = x + cellSize / 2, cy = y + cellSize / 2;
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = Math.max(2, Math.floor(cellSize / 8));
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (mask & N) { ctx.moveTo(cx, cy); ctx.lineTo(cx, y); }
    if (mask & E) { ctx.moveTo(cx, cy); ctx.lineTo(x + cellSize, cy); }
    if (mask & S) { ctx.moveTo(cx, cy); ctx.lineTo(cx, y + cellSize); }
    if (mask & W) { ctx.moveTo(cx, cy); ctx.lineTo(x, cy); }
    ctx.stroke();
    const arms = (mask & N ? 1 : 0) + (mask & E ? 1 : 0) + (mask & S ? 1 : 0) + (mask & W ? 1 : 0);
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

  // hintDispatch(ctx): ctx = { grid, solution, rows, cols, ... }. Both grid (live
  // board) and solution are rotation-COUNT grids (solution was converted by
  // solutionFromResult), so compare them directly — no mask→count conversion.
  //
  // Batch cap: return only the next `batchSize` mismatched cells, NOT all of
  // them. This is the documented Loop convention (see CLAUDE.md hint-batch
  // scaling): Loop calls hintDispatch each step, so an uncapped hint would
  // rotate the whole board in a single programmatic move — which both makes
  // Loop pointless (identical to Solve) and applies a from-scratch full solve
  // in one shot. Capping makes Loop take ceil(mismatched/batchSize) small
  // steps (~10 s total), mirroring how every other puzzle's Loop drips moves
  // in. batchSize = max(PIPE_HINT_FLOOR, ceil(rows*cols/30)) so big boards
  // still finish in ~30 steps while tiny boards reveal a sensible chunk.
  hintDispatch(ctx) {
    const { grid, solution, rows, cols } = ctx;
    if (!solution) return { success: false, error: 'No solution available yet. Click Solve first.' };
    const cells = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const cur = (grid && grid[r] && grid[r][c]) | 0;
      const target = (solution[r] && solution[r][c]) | 0;
      if (cur !== target) cells.push({ row: r, col: c, value: target });
    }
    if (cells.length === 0) return { success: false, error: 'Already solved. Nothing to rotate.' };
    const batchSize = Math.max(PIPE_HINT_FLOOR, Math.ceil((rows * cols) / 30));
    const batch = cells.slice(0, batchSize);
    return { success: true, hint: { type: 'pipes', extraCells: batch, count: batch.length }, grid, solution };
  },

  // loopDoneCheck(ctx): SINGLE ctx arg { boardState, solution, puzzleData }.
  // boardState and solution are both rotation-COUNT grids — compare directly.
  loopDoneCheck(ctx) {
    const boardState = ctx && ctx.boardState;
    const solution = ctx && ctx.solution;
    const pd = ctx && ctx.puzzleData;
    if (!solution || !pd) return false;
    const rows = pd.rows, cols = pd.cols;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const cur = (boardState && boardState[r] && boardState[r][c]) | 0;
      const target = (solution[r] && solution[r][c]) | 0;
      if (cur !== target) return false;
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
