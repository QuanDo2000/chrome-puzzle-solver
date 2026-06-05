'use strict';

const { hashFNV1a } = require('../shared.js');

// Slant (Gokigen Naname) widget module — detect / solve / hint / loop / preview hooks.
//
// CELL MODEL: per-cell board-state grid; each cell is 1 = '\' or 2 = '/' (0 empty, UNK=9
// in solver partials). The solver returns { solved, cells, partial?, error? };
// solutionFromResult returns the bare 2-D cells array so the preview cell-loop, the default
// per-cell mistake-diff, undo/redo, and the cache share one shape. The handler's readState
// returns the live cellStatus grid; applySolution wraps it as { cells } for applySlantState.
// `task` (passed via detect) is the (rows+1)x(cols+1) VERTEX clue grid, drawn on the static layer.
//
// HINT (deductive): hintDispatch reads the live cellStatus, runs SlantSolver._deduceForced,
// reports newly-forced cells, batch-capped; falls back to revealing cached-solution cells.

function hintBatchCap(rows, cols) { return Math.max(4, Math.ceil((rows * cols) / 30)); }

const slant = {
  type: 'slant',
  label: 'Slant',
  url: 'https://www.puzzles-mobile.com/slant/',
  solutionKeyPrefix: 'slant-solution:',
  hasAbsoluteHintCells: true,
  hintBandSkip: true,
  renderEmptyCells: true,

  cacheKey(data) {
    if (!data || data.type !== 'slant' || !data.task) return null;
    // FNV-1a over (nameplate 'S'=0x53, rows, cols, flattened vertex-clue grid). +2 keeps
    // -1 non-negative.
    const h = hashFNV1a((mix) => {
      mix(0x53); mix(data.rows | 0); mix(data.cols | 0);
      const task = data.task || [];
      for (let t = 0; t < task.length; t++) { const row = task[t] || []; for (let e = 0; e < row.length; e++) mix((row[e] | 0) + 2); }
    });
    return 'slant-solution:' + h.toString(16);
  },

  // grid is the bare cells grid (rows x cols); rows/cols come from puzzleData. A 0.5-cell
  // gutter keeps the border-vertex clue discs from clipping.
  canvasDims(pd, { grid }) {
    return {
      rows: pd?.rows || (Array.isArray(grid) ? grid.length : 0),
      cols: pd?.cols || (Array.isArray(grid) && grid[0] ? grid[0].length : 0),
      marginCells: 0.5,
    };
  },

  staticSig(data) { return 'sl=' + _slantTaskSig(data?.type === 'slant' ? data?.task : null); },

  // Static layer: the outer border + vertex clue numbers on small discs at lattice points.
  drawStaticLayer(ctx, { rows, cols, cellSize, pd }) {
    const task = (pd && pd.task) || [];
    ctx.save();
    const borderW = Math.max(2, Math.floor(cellSize / 6));
    ctx.strokeStyle = '#1f2937'; ctx.lineWidth = borderW; ctx.lineCap = 'square';
    ctx.strokeRect(borderW / 2, borderW / 2, cols * cellSize - borderW, rows * cellSize - borderW);
    const rad = Math.max(6, Math.floor(cellSize * 0.3));
    for (let t = 0; t <= rows; t++) {
      const row = task[t] || [];
      for (let e = 0; e <= cols; e++) {
        const k = row[e];
        if (typeof k !== 'number' || k < 0) continue;
        const x = e * cellSize, y = t * cellSize;
        ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2);
        ctx.fillStyle = '#1f2937'; ctx.fill();
        ctx.fillStyle = '#f3f4f6';
        ctx.font = `bold ${Math.floor(cellSize * 0.42)}px sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(k), x, y);
      }
    }
    ctx.restore();
  },

  // Dynamic per-cell render: the diagonal (1 = '\', 2 = '/').
  drawPreviewCell(ctx, { v, x, y, cellSize }) {
    if (v === 1 || v === 2) _drawDiagonal(ctx, x, y, cellSize, v, '#374151');
  },

  // Hint highlight: the forced diagonal in the hint colour.
  drawHintCell(ctx, { cell, cx, cy, cellSize }) {
    _drawDiagonal(ctx, cx, cy, cellSize, cell.value, 'rgba(46, 134, 222, 0.85)');
  },

  hintStatusNodes(h, { bold }) {
    const cells = h.extraCells || [];
    if (cells.length === 0) return ['No hint available'];
    if (cells.length === 1) {
      const cell = cells[0];
      const label = cell.value === 1 ? '\\' : '/';
      return ['Cell ', bold(`(row ${cell.row + 1}, col ${cell.col + 1})`), ' is ', bold(label)];
    }
    return [bold(String(cells.length)), ' cells can be deduced'];
  },

  solveExtraData(data) { return { task: data.task, rows: data.rows, cols: data.cols }; },
  solutionFromResult(result) { return result && result.cells ? result.cells : null; },
  solutionToCacheJson(solution) { return Array.isArray(solution) ? { cells: solution.map((row) => row.slice()) } : null; },
  solutionFromCacheJson(parsed) { return (parsed && Array.isArray(parsed.cells)) ? parsed.cells.map((row) => row.slice()) : null; },

  // Deductive hint. ctx: { detectedGrid, grid, solution, rows, cols, callMainWorld, firstMismatch }.
  async hintDispatch(ctx) {
    const { callMainWorld, solution, rows, cols, detectedGrid, grid, firstMismatch } = ctx;
    const task = detectedGrid && detectedGrid.task;
    if (solution && firstMismatch && firstMismatch(grid, solution)) {
      return { success: false, error: 'Current game state is wrong.' };
    }
    if (task) {
      try {
        const state = await callMainWorld('readSlantState', []);
        const cs = state && state.cellStatus;
        if (Array.isArray(cs)) {
          const Solver = (typeof SlantSolver !== 'undefined') ? SlantSolver : require('../../solvers/slant.js').SlantSolver;
          const solver = new Solver({ task, rows, cols, maxMs: 1500 });
          const forced = solver._deduceForced(cs);
          if (forced && forced.length) {
            const batch = forced.slice(0, hintBatchCap(rows, cols));
            return { success: true, hint: { type: 'slant', extraCells: batch, count: batch.length }, grid, solution };
          }
        }
      } catch { /* fall through to solution diff */ }
    }
    if (!Array.isArray(solution)) return { success: false, error: 'No solution available' };
    const cap = hintBatchCap(rows, cols);
    const cells = [];
    for (let r = 0; r < solution.length && cells.length < cap; r++) {
      const sRow = solution[r] || [];
      for (let c = 0; c < sRow.length && cells.length < cap; c++) {
        const cur = grid && grid[r] ? grid[r][c] : 0;
        if ((sRow[c] === 1 || sRow[c] === 2) && cur !== sRow[c]) cells.push({ row: r, col: c, value: sRow[c] });
      }
    }
    if (!cells.length) return { success: false, error: 'No hint available' };
    return { success: true, hint: { type: 'slant', extraCells: cells, count: cells.length }, grid, solution };
  },

  // ctx: { boardState, solution, puzzleData }. Done when every solution cell is on the board.
  loopDoneCheck(ctx) {
    const { boardState, solution } = ctx;
    if (!Array.isArray(solution) || !Array.isArray(boardState)) return false;
    for (let r = 0; r < solution.length; r++) {
      const sRow = solution[r] || [], bRow = boardState[r] || [];
      for (let c = 0; c < sRow.length; c++) {
        if ((sRow[c] === 1 || sRow[c] === 2) && bRow[c] !== sRow[c]) return false;
      }
    }
    return true;
  },

  // Apply a hint batch: write ONLY the hint cells (UNK=9 elsewhere; applySlantState skips UNK).
  async applyHint(hint, { callMainWorld, puzzleData }) {
    const rows = puzzleData ? puzzleData.rows : 0;
    const cols = puzzleData ? puzzleData.cols : 0;
    const cells = [];
    for (let r = 0; r < rows; r++) cells.push(new Array(cols).fill(9));
    for (const cell of (hint.extraCells || [])) {
      if (cells[cell.row]) cells[cell.row][cell.col] = cell.value;
    }
    const ok = await callMainWorld('applySlantState', [{ cells }]);
    return ok === true;
  },

  // Partial-Solve UI: solver timed out and returned { partial:true, cells } (UNK=9 where open).
  // Does NOT call recordSolveSuccess (a partial is a subset of the real solution).
  partialResultArm(result, {
    clearPendingHint, setStatus, drawPreview, setConfirming, setLoopConfirming, setSolveBtnText,
  }) {
    setLoopConfirming(false); clearPendingHint(); setSolveBtnText('Confirm'); setConfirming(true);
    const cells = (result.cells || []).map((row) => row.map((v) => (v === 1 || v === 2) ? v : 0));
    let placed = 0, total = 0;
    for (const row of result.cells || []) for (const v of row) { total++; if (v === 1 || v === 2) placed++; }
    const pct = total > 0 ? Math.round(100 * placed / total) : 0;
    setStatus(`Partial only: ${placed} cells deduced (${pct}% of cells, too hard for a full solve). Apply, then finish manually.`, 'info');
    drawPreview(cells);
  },
};

// Draw the cell diagonal: v=1 '\' (TL->BR), v=2 '/' (TR->BL).
function _drawDiagonal(ctx, x, y, size, v, color) {
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = Math.max(2, Math.floor(size / 8)); ctx.lineCap = 'round';
  ctx.beginPath();
  if (v === 1) { ctx.moveTo(x, y); ctx.lineTo(x + size, y + size); }
  else { ctx.moveTo(x + size, y); ctx.lineTo(x, y + size); }
  ctx.stroke(); ctx.restore();
}

function _slantTaskSig(task) {
  if (!Array.isArray(task)) return '0';
  const h = hashFNV1a((mix) => { for (const row of task) for (const v of row) mix(((v | 0) + 2) & 0xff); });
  return h.toString(16);
}

if (typeof module !== 'undefined' && module.exports) { module.exports = slant; }
