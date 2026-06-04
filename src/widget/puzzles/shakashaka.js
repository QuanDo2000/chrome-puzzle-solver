'use strict';

const { hashFNV1a } = require('../shared.js');

// Shakashaka widget module — detect / solve / hint / loop / preview hooks.
//
// CELL MODEL
// ----------
// Shakashaka's solution is a per-CELL board-state grid (NOT edges): for each
// cell, the value is -1 = black (fixed wall, where task[r][c] !== -1), 0 =
// white (open cell left blank), 1..4 = a triangle in one of four orientations.
// (UNK=9 appears only inside solver partials for still-undecided open cells.)
//
// The solver returns { solved, cells, partial?, error? } where `cells` is that
// board-state grid. solutionFromResult returns the BARE 2-D cells array so that
// — like every other cell-state puzzle — the preview cell-loop, the default
// per-cell mistake-diff, undo/redo, and the solution cache all share one shape.
// The handler's readState likewise returns a bare board-state grid (derived
// from cellStatus + task); applySolution wraps it as { cells } for the
// MAIN-world writer applyShakashakaState (triangles -> cellStatus 1..4, white
// -> 5).
//
// HINT MODEL (deductive)
// ----------------------
// hintDispatch reads the live cellStatus via callMainWorld('readShakashakaState')
// and runs the solver's _deduceOnly() seeded from the current board: cells the
// player has already decided constrain the deduction, and the propagation
// reports any newly-forced open cells (white or a specific triangle). That batch
// is capped per the Loop scaling rule (<= ~30 clicks). When pure propagation is
// exhausted it falls back to revealing the next batch of cells from the cached
// full solution. Because the fallback needs the cached solution, this module
// does NOT set skipAutoSolveGate — "Solve then Hint" keeps the solution present.
//
// TRIANGLE PREVIEW GEOMETRY (best-effort — confirmed at live-verify, Task 6)
// -------------------------------------------------------------------------
// Each triangle fills HALF the cell along a diagonal; the right-angle corner is
// at one corner of the cell and the hypotenuse runs across the opposite
// diagonal. Derived from the page's hasNonRect edge-matching, the starting
// mapping is: T1 right-angle at TOP-LEFT, T2 TOP-RIGHT, T3 BOTTOM-RIGHT, T4
// BOTTOM-LEFT. THIS IS A GUESS — see the TODO(live-verify) in drawPreviewCell;
// Task 6 corrects it against the page CSS classes cell-1..cell-4.

// Per-click hint batch cap (see MEMORY: hint batch scales with board for Loop).
function hintBatchCap(rows, cols) {
  return Math.max(4, Math.ceil((rows * cols) / 30));
}

const shakashaka = {
  type: 'shakashaka',
  label: 'Shakashaka',
  url: 'https://www.puzzles-mobile.com/shakashaka/',
  solutionKeyPrefix: 'shakashaka-solution:',
  hasAbsoluteHintCells: true,
  hintBandSkip: true,
  renderEmptyCells: true,

  cacheKey(data) {
    if (!data || data.type !== 'shakashaka' || !data.task) return null;
    // FNV-1a over (nameplate, rows, cols, flattened task). task values are
    // signed (-2 black, -1 open, 0..4 numbered black); +2 keeps them
    // non-negative. 'K' nameplate (0x4B) keeps shakashaka keys disjoint.
    const h = hashFNV1a((mix) => {
      mix(0x4B);
      mix(data.rows | 0);
      mix(data.cols | 0);
      const task = data.task || [];
      for (let r = 0; r < task.length; r++) {
        const row = task[r] || [];
        for (let c = 0; c < row.length; c++) mix((row[c] | 0) + 2);
      }
    });
    return 'shakashaka-solution:' + h.toString(16);
  },

  canvasDims(pd, { grid }) {
    return {
      rows: pd?.rows || (Array.isArray(grid) ? grid.length : 0),
      cols: pd?.cols || (Array.isArray(grid) && grid[0] ? grid[0].length : 0),
      marginCells: 0,
    };
  },

  staticSig(data) {
    return 'sk=' + _shakashakaTaskSig(data?.type === 'shakashaka' ? data?.task : null);
  },

  // Static layer: black cells (filled dark) + their number clues + the outer
  // border. White cells / triangles are the DYNAMIC layer (drawPreviewCell).
  drawStaticLayer(ctx, { rows, cols, cellSize, pd }) {
    const task = (pd && pd.task) || [];
    ctx.save();
    // Black walls.
    for (let r = 0; r < rows; r++) {
      const row = task[r] || [];
      for (let c = 0; c < cols; c++) {
        const v = row[c];
        if (v === -1) continue; // open cell
        const x = c * cellSize, y = r * cellSize;
        ctx.fillStyle = '#1f2937';
        ctx.fillRect(x, y, cellSize, cellSize);
        // Numbered clue (0..4): white digit centred in the black cell.
        if (v >= 0) {
          ctx.fillStyle = '#f3f4f6';
          ctx.font = `bold ${Math.floor(cellSize * 0.55)}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(v), x + cellSize / 2, y + cellSize / 2);
        }
      }
    }
    // Outer border.
    const borderW = Math.max(2, Math.floor(cellSize / 5));
    ctx.strokeStyle = '#1f2937';
    ctx.lineWidth = borderW;
    ctx.lineCap = 'square';
    ctx.strokeRect(borderW / 2, borderW / 2, cols * cellSize - borderW, rows * cellSize - borderW);
    ctx.restore();
  },

  // Dynamic per-cell render. grid value v is board-state: -1 black (drawn on the
  // static layer — skip here), 0 white (blank open cell — leave as-is), 1..4 a
  // triangle filling half the cell.
  drawPreviewCell(ctx, { v, x, y, cellSize }) {
    if (v >= 1 && v <= 4) {
      _drawTriangle(ctx, x, y, cellSize, v, '#374151');
    }
    // v === 0 (white) and v === -1 (black, on static layer): nothing to draw.
  },

  // Hint highlight: ring the deduced cell. value 1..4 → triangle outline in the
  // hint colour; value 0 → a light ring marking a forced-white cell.
  drawHintCell(ctx, { cell, cx, cy, cellSize }) {
    ctx.save();
    if (cell.value >= 1 && cell.value <= 4) {
      _drawTriangle(ctx, cx, cy, cellSize, cell.value, 'rgba(46, 134, 222, 0.55)');
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
      const label = (cell.value >= 1 && cell.value <= 4)
        ? `triangle (orientation ${cell.value})`
        : 'white';
      return ['Cell ', bold(`(row ${cell.row + 1}, col ${cell.col + 1})`), ' must be ', bold(label)];
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

  // Deductive hint. ctx from hint.js getHint: { detectedGrid, grid, solution,
  // rows, cols, callMainWorld, firstMismatch, ... }.
  async hintDispatch(ctx) {
    const { callMainWorld, solution, rows, cols, detectedGrid, grid, firstMismatch } = ctx;
    const task = detectedGrid && detectedGrid.task;
    // If we already know the full solution and the live board contradicts it,
    // the deduction below would be unsound — flag the mistake instead.
    if (solution && firstMismatch && firstMismatch(grid, solution)) {
      return { success: false, error: 'Current game state is wrong.' };
    }

    // 1) Deductive hint: forced cells from the live board via the solver.
    //    Read the raw cellStatus and seed the solver with the cells the player
    //    has already decided, then propagate to a fixpoint and report the
    //    newly-forced open cells. Guarded so a solver throw can't break Hint —
    //    fall through to the solution diff.
    if (task) {
      try {
        const state = await callMainWorld('readShakashakaState', []);
        const cs = state && state.cellStatus;
        const Solver = (typeof ShakashakaSolver !== 'undefined')
          ? ShakashakaSolver
          : require('../../solvers/shakashaka.js').ShakashakaSolver;
        const solver = new Solver({ task });
        // Map the live cellStatus into a board-state grid: black -> -1, 1..4 ->
        // triangle, 0/5 -> 0 white. Cells the player hasn't touched are
        // cellStatus 0; treat those as UNDECIDED so the deduction can fill them.
        const decided = task.map((row, r) => row.map((tv, c) => {
          if (tv !== -1) return -1; // black
          const v = cs && cs[r] ? cs[r][c] : 0;
          if (v >= 1 && v <= 4) return v; // committed triangle
          if (v === 5) return 0;          // explicit white
          return 9;                       // UNK (untouched)
        }));
        const forced = _deduceForced(solver, task, decided);
        if (forced && forced.length) {
          const cap = hintBatchCap(rows, cols);
          const batch = forced.slice(0, cap);
          return {
            success: true,
            hint: { type: 'shakashaka', extraCells: batch, count: batch.length },
            grid,
            solution,
          };
        }
      } catch { /* fall through to solution diff */ }
    }

    // 2) Fallback: reveal the next batch of cells from the cached solution.
    if (!Array.isArray(solution)) {
      return { success: false, error: 'No solution available' };
    }
    const cap = hintBatchCap(rows, cols);
    const cells = [];
    for (let r = 0; r < solution.length && cells.length < cap; r++) {
      const sRow = solution[r] || [];
      for (let c = 0; c < sRow.length && cells.length < cap; c++) {
        const sv = sRow[c];
        if (task && task[r] && task[r][c] !== -1) continue; // black
        // Only reveal triangles or explicit whites the board hasn't placed yet.
        const cur = grid && grid[r] ? grid[r][c] : 0;
        if (sv >= 1 && sv <= 4 && cur !== sv) cells.push({ row: r, col: c, value: sv });
      }
    }
    if (!cells.length) return { success: false, error: 'No hint available' };
    return { success: true, hint: { type: 'shakashaka', extraCells: cells, count: cells.length }, grid, solution };
  },

  // ctx from widget.js runLoop: { boardState, solution, puzzleData }. boardState
  // IS the live bare board-state grid (no callMainWorld here — do NOT destructure
  // it or it shadows the bundle global as undefined). Done when every solution
  // triangle is on the board.
  loopDoneCheck(ctx) {
    const { boardState, solution } = ctx;
    if (!Array.isArray(solution) || !Array.isArray(boardState)) return false;
    for (let r = 0; r < solution.length; r++) {
      const sRow = solution[r] || [], bRow = boardState[r] || [];
      for (let c = 0; c < sRow.length; c++) {
        const sv = sRow[c];
        if (sv >= 1 && sv <= 4 && bRow[c] !== sv) return false;
      }
    }
    return true;
  },

  // Apply a hint batch: write ONLY the hint cells, leaving every other open cell
  // untouched (UNK=9, which applyShakashakaState skips). Writing a full board here
  // would over-commit — marking every still-undecided cell white (cellStatus 5),
  // including cells whose answer is a not-yet-revealed triangle — which corrupts
  // the board and makes the next Loop deduction reason from a wrong state.
  async applyHint(hint, { callMainWorld, puzzleData }) {
    const task = puzzleData && puzzleData.task;
    const rows = puzzleData ? puzzleData.rows : 0;
    const cols = puzzleData ? puzzleData.cols : 0;
    const cells = [];
    for (let r = 0; r < rows; r++) {
      const row = new Array(cols);
      for (let c = 0; c < cols; c++) {
        row[c] = (task && task[r] && task[r][c] !== -1) ? -1 : 9; // black, else UNK (leave as-is)
      }
      cells.push(row);
    }
    for (const cell of (hint.extraCells || [])) {
      if (cells[cell.row]) cells[cell.row][cell.col] = cell.value;
    }
    const ok = await callMainWorld('applyShakashakaState', [{ cells }]);
    return ok === true;
  },

  // Partial-Solve UI (mirrors shingoki's edge-shape arm). On a too-hard board the
  // solver times out and returns { partial:true, cells } where `cells` is the
  // propagation-determined board (UNK=9 where still open). Show it as a preview +
  // finish-manually status. Deliberately does NOT call recordSolveSuccess — a
  // partial is a subset of the real solution, so caching it would mis-trigger
  // Loop's done-check and the mistake overlay.
  partialResultArm(result, {
    clearPendingHint, setStatus, drawPreview,
    setConfirming, setLoopConfirming, setSolveBtnText,
  }) {
    setLoopConfirming(false);
    clearPendingHint();
    setSolveBtnText('Confirm');
    setConfirming(true);
    // Sanitize UNK (9) -> 0 (white) for the preview grid so the cell-loop never
    // tries to draw a bogus triangle for an undecided cell.
    const cells = (result.cells || []).map((row) =>
      row.map((v) => (v >= 1 && v <= 4 ? v : (v === -1 ? -1 : 0))));
    let placed = 0, total = 0;
    for (const row of result.cells || []) {
      for (const v of row) {
        if (v === -1) continue; // black wall, not an open cell
        total++;
        if (v >= 0 && v <= 4 && v !== 9) placed++;
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

// Draw a half-cell right-triangle for orientation v (1..4) into [x,y,size].
// TODO(live-verify): confirm triangle orientation 1..4 against the page CSS
// classes cell-1..cell-4. Starting mapping derived from hasNonRect:
//   1 = right-angle at TOP-LEFT     (hypotenuse top-right -> bottom-left)
//   2 = right-angle at TOP-RIGHT    (hypotenuse top-left  -> bottom-right)
//   3 = right-angle at BOTTOM-RIGHT (hypotenuse top-right -> bottom-left)
//   4 = right-angle at BOTTOM-LEFT  (hypotenuse top-left  -> bottom-right)
function _drawTriangle(ctx, x, y, size, v, fill) {
  const tl = [x, y];
  const tr = [x + size, y];
  const br = [x + size, y + size];
  const bl = [x, y + size];
  let pts;
  if (v === 1) pts = [tl, tr, bl];
  else if (v === 2) pts = [tl, tr, br];
  else if (v === 3) pts = [tr, br, bl];
  else pts = [tl, br, bl]; // v === 4
  ctx.save();
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  ctx.lineTo(pts[1][0], pts[1][1]);
  ctx.lineTo(pts[2][0], pts[2][1]);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// Run propagation from the player's already-decided cells and return the list of
// newly-forced open cells as { row, col, value }. `decided` is a board-state
// grid where untouched open cells are UNK (9). We pin every committed cell as a
// singleton domain, propagate to a fixpoint, and collect open cells the solver
// determined that the player hadn't yet placed. Soundness rides on the solver's
// own _consistent guard (it only prunes certain impossibilities); returns []
// when the seeded board is contradictory (the player has erred), so the caller
// falls back to the cached-solution diff.
function _deduceForced(solver, task, decided) {
  solver._initDomains();
  for (let r = 0; r < task.length; r++) {
    const row = task[r] || [];
    for (let c = 0; c < row.length; c++) {
      if (row[c] !== -1) continue; // black: domain stays 0
      const v = decided[r][c];
      if (v >= 0 && v <= 4) solver._dom[r][c] = (1 << v); // pin committed cell
    }
  }
  const board = solver._boardFromDomains();
  if (!solver._propagate(board)) return []; // contradiction from the live board
  const forced = [];
  for (let r = 0; r < task.length; r++) {
    const row = task[r] || [];
    for (let c = 0; c < row.length; c++) {
      if (row[c] !== -1) continue;
      const d = solver._dom[r][c];
      // singleton domain that the player had NOT already committed = newly forced
      if (d && (d & (d - 1)) === 0) {
        let val = 0, m = d;
        while (m > 1) { m >>= 1; val++; }
        if (decided[r][c] === 9) forced.push({ row: r, col: c, value: val });
      }
    }
  }
  return forced;
}

// Task signature for the static-layer cache. +2 keeps signed task values
// (-2 black, -1 open) non-negative, matching cacheKey's offset.
function _shakashakaTaskSig(task) {
  if (!Array.isArray(task)) return '0';
  const h = hashFNV1a((mix) => {
    for (const row of task) for (const v of row) mix(((v | 0) + 2) & 0xff);
  });
  return h.toString(16);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = shakashaka;
}
