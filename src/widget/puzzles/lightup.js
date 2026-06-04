'use strict';

const { hashFNV1a } = require('../shared.js');

// Light Up (Akari) widget module — detect / solve / hint / loop / preview hooks.
//
// CELL MODEL: the solution is a per-cell board-state grid: -1 black (fixed wall),
// 0 no-bulb white, 1 bulb. (UNK=9 only inside solver partials.) The solver returns
// { solved, cells, partial?, error? }; solutionFromResult returns the BARE 2-D cells
// array so the preview cell-loop, the default per-cell mistake-diff, undo/redo, and
// the solution cache all share one shape. The handler's readState returns a bare grid
// (bulbs=1, else 0); applySolution wraps it as { cells } for applyLightUpState
// (bulb -> cellStatus 1, no-bulb -> cellStatus 2/X).
//
// HINT (deductive): hintDispatch reads the live cellStatus, seeds the solver with the
// player's decided cells, propagates, and reports newly-forced open cells (bulbs AND
// no-bulbs), batch-capped. Falls back to revealing the next bulbs from the cached
// solution, so this module does NOT set skipAutoSolveGate.

function hintBatchCap(rows, cols) {
  return Math.max(4, Math.ceil((rows * cols) / 30));
}

const lightup = {
  type: 'lightup',
  label: 'Light Up',
  url: 'https://www.puzzles-mobile.com/light-up/',
  solutionKeyPrefix: 'lightup-solution:',
  hasAbsoluteHintCells: true,
  hintBandSkip: true,
  renderEmptyCells: true,

  cacheKey(data) {
    if (!data || data.type !== 'lightup' || !data.task) return null;
    // FNV-1a over (nameplate, rows, cols, flattened task). 'L' (0x4C) nameplate keeps
    // lightup keys disjoint; +2 keeps signed task values (-2 black) non-negative.
    const h = hashFNV1a((mix) => {
      mix(0x4C);
      mix(data.rows | 0);
      mix(data.cols | 0);
      const task = data.task || [];
      for (let r = 0; r < task.length; r++) {
        const row = task[r] || [];
        for (let c = 0; c < row.length; c++) mix((row[c] | 0) + 2);
      }
    });
    return 'lightup-solution:' + h.toString(16);
  },

  canvasDims(pd, { grid }) {
    return {
      rows: pd?.rows || (Array.isArray(grid) ? grid.length : 0),
      cols: pd?.cols || (Array.isArray(grid) && grid[0] ? grid[0].length : 0),
      marginCells: 0,
    };
  },

  staticSig(data) {
    return 'lu=' + _lightupTaskSig(data?.type === 'lightup' ? data?.task : null);
  },

  // Static layer: black walls + number clues + outer border. Bulbs are the dynamic layer.
  drawStaticLayer(ctx, { rows, cols, cellSize, pd }) {
    const task = (pd && pd.task) || [];
    ctx.save();
    for (let r = 0; r < rows; r++) {
      const row = task[r] || [];
      for (let c = 0; c < cols; c++) {
        const v = row[c];
        if (v === -1) continue; // white/open
        const x = c * cellSize, y = r * cellSize;
        ctx.fillStyle = '#1f2937';
        ctx.fillRect(x, y, cellSize, cellSize);
        if (v >= 0) {
          ctx.fillStyle = '#f3f4f6';
          ctx.font = `bold ${Math.floor(cellSize * 0.55)}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(v), x + cellSize / 2, y + cellSize / 2);
        }
      }
    }
    const borderW = Math.max(2, Math.floor(cellSize / 5));
    ctx.strokeStyle = '#1f2937';
    ctx.lineWidth = borderW;
    ctx.lineCap = 'square';
    ctx.strokeRect(borderW / 2, borderW / 2, cols * cellSize - borderW, rows * cellSize - borderW);
    ctx.restore();
  },

  // Dynamic per-cell render. v: -1 black (static layer — skip), 0 no-bulb (blank),
  // 1 bulb (amber filled circle).
  drawPreviewCell(ctx, { v, x, y, cellSize }) {
    if (v === 1) _drawBulb(ctx, x, y, cellSize, '#f59e0b');
  },

  // Hint highlight: bulb glyph for value 1; light ring for a forced no-bulb (value 0).
  drawHintCell(ctx, { cell, cx, cy, cellSize }) {
    ctx.save();
    if (cell.value === 1) {
      _drawBulb(ctx, cx, cy, cellSize, 'rgba(46, 134, 222, 0.7)');
    } else {
      ctx.strokeStyle = '#60a5fa';
      ctx.lineWidth = Math.max(2, Math.floor(cellSize / 9));
      ctx.strokeRect(cx + 2, cy + 2, cellSize - 4, cellSize - 4);
    }
    ctx.restore();
  },

  hintStatusNodes(h, { bold }) {
    const cells = h.extraCells || [];
    if (cells.length === 0) return ['No hint available'];
    if (cells.length === 1) {
      const cell = cells[0];
      const label = cell.value === 1 ? 'a bulb' : 'no bulb';
      return ['Cell ', bold(`(row ${cell.row + 1}, col ${cell.col + 1})`), ' is ', bold(label)];
    }
    return [bold(String(cells.length)), ' cells can be deduced'];
  },

  solveExtraData(data) {
    return { task: data.task };
  },

  solutionFromResult(result) {
    return result && result.cells ? result.cells : null;
  },

  solutionToCacheJson(solution) {
    if (!Array.isArray(solution)) return null;
    return { cells: solution.map((row) => row.slice()) };
  },

  solutionFromCacheJson(parsed) {
    if (!parsed || !Array.isArray(parsed.cells)) return null;
    return parsed.cells.map((row) => row.slice());
  },

  // Deductive hint. ctx: { detectedGrid, grid, solution, rows, cols, callMainWorld, firstMismatch }.
  async hintDispatch(ctx) {
    const { callMainWorld, solution, rows, cols, detectedGrid, grid, firstMismatch } = ctx;
    const task = detectedGrid && detectedGrid.task;
    if (solution && firstMismatch && firstMismatch(grid, solution)) {
      return { success: false, error: 'Current game state is wrong.' };
    }

    // 1) Deductive hint: forced cells from the live board.
    if (task) {
      try {
        const state = await callMainWorld('readLightUpState', []);
        const cs = state && state.cellStatus;
        const Solver = (typeof LightUpSolver !== 'undefined')
          ? LightUpSolver
          : require('../../solvers/lightup.js').LightUpSolver;
        const solver = new Solver({ task });
        // Live cellStatus -> board-state grid: black -1, bulb(1) -> 1, X(2) -> 0,
        // empty(0) -> UNK (untouched, deduction may fill).
        const decided = task.map((row, r) => row.map((tv, c) => {
          if (tv !== -1) return -1;
          const v = cs && cs[r] ? cs[r][c] : 0;
          if (v === 1) return 1;
          if (v === 2) return 0;
          return 9;
        }));
        const forced = solver._deduceOnly(decided);
        if (forced && forced.length) {
          const batch = forced.slice(0, hintBatchCap(rows, cols));
          return { success: true, hint: { type: 'lightup', extraCells: batch, count: batch.length }, grid, solution };
        }
      } catch { /* fall through to solution diff */ }
    }

    // 2) Fallback: reveal the next batch of bulbs from the cached solution.
    if (!Array.isArray(solution)) return { success: false, error: 'No solution available' };
    const cap = hintBatchCap(rows, cols);
    const cells = [];
    for (let r = 0; r < solution.length && cells.length < cap; r++) {
      const sRow = solution[r] || [];
      for (let c = 0; c < sRow.length && cells.length < cap; c++) {
        if (task && task[r] && task[r][c] !== -1) continue;
        const cur = grid && grid[r] ? grid[r][c] : 0;
        if (sRow[c] === 1 && cur !== 1) cells.push({ row: r, col: c, value: 1 });
      }
    }
    if (!cells.length) return { success: false, error: 'No hint available' };
    return { success: true, hint: { type: 'lightup', extraCells: cells, count: cells.length }, grid, solution };
  },

  // ctx: { boardState, solution, puzzleData }. Done when every solution bulb is placed.
  loopDoneCheck(ctx) {
    const { boardState, solution } = ctx;
    if (!Array.isArray(solution) || !Array.isArray(boardState)) return false;
    for (let r = 0; r < solution.length; r++) {
      const sRow = solution[r] || [], bRow = boardState[r] || [];
      for (let c = 0; c < sRow.length; c++) {
        if (sRow[c] === 1 && bRow[c] !== 1) return false;
      }
    }
    return true;
  },

  // Apply a hint batch: write ONLY the hint cells, leaving every other open cell UNK=9
  // (applyLightUpState skips UNK). Writing a full board here would over-commit.
  async applyHint(hint, { callMainWorld, puzzleData }) {
    const task = puzzleData && puzzleData.task;
    const rows = puzzleData ? puzzleData.rows : 0;
    const cols = puzzleData ? puzzleData.cols : 0;
    const cells = [];
    for (let r = 0; r < rows; r++) {
      const row = new Array(cols);
      for (let c = 0; c < cols; c++) row[c] = (task && task[r] && task[r][c] !== -1) ? -1 : 9;
      cells.push(row);
    }
    for (const cell of (hint.extraCells || [])) {
      if (cells[cell.row]) cells[cell.row][cell.col] = cell.value;
    }
    const ok = await callMainWorld('applyLightUpState', [{ cells }]);
    return ok === true;
  },

  // Partial-Solve UI: solver timed out and returned { partial:true, cells } (UNK=9
  // where still open). Show it as a preview + finish-manually status. Deliberately
  // does NOT call recordSolveSuccess (a partial is a subset of the real solution).
  partialResultArm(result, {
    clearPendingHint, setStatus, drawPreview,
    setConfirming, setLoopConfirming, setSolveBtnText,
  }) {
    setLoopConfirming(false);
    clearPendingHint();
    setSolveBtnText('Confirm');
    setConfirming(true);
    const cells = (result.cells || []).map((row) => row.map((v) => (v === 1 ? 1 : (v === -1 ? -1 : 0))));
    let placed = 0, total = 0;
    for (const row of result.cells || []) {
      for (const v of row) {
        if (v === -1) continue;
        total++;
        if (v === 0 || v === 1) placed++;
      }
    }
    const pct = total > 0 ? Math.round(100 * placed / total) : 0;
    setStatus(
      `Partial only: ${placed} cells deduced (${pct}% of open cells, too hard for full solve). Apply, then finish manually.`,
      'info',
    );
    drawPreview(cells);
  },
};

// Draw a bulb glyph (filled circle) centred in the cell.
function _drawBulb(ctx, x, y, size, fill) {
  ctx.save();
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size * 0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// Task signature for the static-layer cache. +2 keeps signed task values non-negative.
function _lightupTaskSig(task) {
  if (!Array.isArray(task)) return '0';
  const h = hashFNV1a((mix) => {
    for (const row of task) for (const v of row) mix(((v | 0) + 2) & 0xff);
  });
  return h.toString(16);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = lightup;
}
