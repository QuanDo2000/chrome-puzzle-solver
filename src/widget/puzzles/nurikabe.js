'use strict';

// Nurikabe puzzle module — Stage C migration.
//
// Hooks consumed by the Stage-B dispatchers (cache.js, preview.js,
// widget.js, content.js):
//   cacheKey         — FNV-1a over puzzle.task (the clue/wall grid; values
//                      include 0+ clue counts and -2 wall sentinels); 'O'
//                      nameplate (0x4F) keeps keys disjoint from Norinori (0x4E).
//   staticSig        — contributes the task signature to the preview's
//                      static-layer cache key.
//   customLattice    — flag the Stage-B buildLatticeLayer dispatcher so it
//                      forwards to drawLattice instead of running its default
//                      full-grid pass.
//   drawLattice      — wall-aware per-edge grid drawing. Nurikabe boards may
//                      contain wall cells (task[r][c] === -2) which the page
//                      renders blank; we draw lattice edges around real cells
//                      only so wall areas have no grid lines through them.
//   drawPreviewCell  — non-hint cell render. Clue cells (task > 0) and wall
//                      cells (task === -2) are left untouched so the page's
//                      DOM nodes for them stay visible. Otherwise v=1 = sea
//                      (dark inset fill), v=2 = island (× cross), v=0 = blank.
//   hintStatusNodes  — describes a Nurikabe hint as "must be sea (black) /
//                      island (white)" for a single deduced cell.
//   solveExtraData   — extra payload for the solver worker: rows/cols plus
//                      task (which carries clue numbers AND -2 wall sentinels).
//   partialResultArm — wraps applyGridPartialResult so the Stage-B
//                      applyPartialResult dispatcher can route nurikabe
//                      partial-solve timeouts into the generic grid partial UI.
//
// Nurikabe has no drawStaticLayer hook: the lattice IS the static layer
// (clue digits live on page DOM nodes, not on the canvas).

const nurikabe = {
  type: 'nurikabe',
  label: 'Nurikabe',
  url: 'https://www.puzzles-mobile.com/nurikabe/',
  solutionKeyPrefix: 'nurikabe-solution:',
  skipAutoSolveGate: true,
  hasAbsoluteHintCells: true,
  hintBandSkip: true,
  customLattice: true,
  renderEmptyCells: true,

  cacheKey(data) {
    if (data?.type !== 'nurikabe' || !data.task) return null;
    let h = 0x811c9dc5;
    const mix = (n) => { h ^= n & 0xff; h = Math.imul(h, 0x01000193) >>> 0; };
    mix(0x4F); // distinct from Norinori (0x4E)
    mix(data.rows); mix(data.cols);
    for (const row of data.task) for (const v of row) { mix(v & 0xff); mix((v >>> 8) & 0xff); }
    return 'nurikabe-solution:' + (h >>> 0).toString(16);
  },

  staticSig(data) {
    return 'nu=' + _nurikabeTaskSig(data?.task);
  },

  drawLattice(ctx, { rows, cols, cellSize, pd }) {
    // Nurikabe boards can have wall cells (task[r][c] === -2) — off-board
    // regions that the page renders blank. Draw per-edge so wall areas have
    // no grid lines through them; edges between a wall and a real cell are
    // still drawn (showing the board boundary).
    const isWall = (r, cc) =>
      pd?.type === 'nurikabe' &&
      r >= 0 && r < rows && cc >= 0 && cc < cols &&
      pd.task?.[r]?.[cc] === -2;
    ctx.beginPath();
    for (let r = 0; r < rows; r++) {
      for (let cc = 0; cc < cols; cc++) {
        if (isWall(r, cc)) continue;
        const x = cc * cellSize;
        const y = r * cellSize;
        // Top edge: draw if cell above is wall or out of bounds, OR always
        // draw (the neighbouring non-wall cell will also draw it — overlap
        // is harmless).
        ctx.moveTo(x, y); ctx.lineTo(x + cellSize, y);
        // Left edge.
        ctx.moveTo(x, y); ctx.lineTo(x, y + cellSize);
        // Bottom edge.
        ctx.moveTo(x, y + cellSize); ctx.lineTo(x + cellSize, y + cellSize);
        // Right edge.
        ctx.moveTo(x + cellSize, y); ctx.lineTo(x + cellSize, y + cellSize);
      }
    }
    ctx.stroke();
  },

  drawPreviewCell(ctx, { r, c, v, x, y, cellSize, puzzleData }) {
    // Skip clue cells — page renders them as their own DOM node.
    // Skip wall cells (task === -2) — off-board, page renders them inert.
    const taskVal = puzzleData?.task?.[r]?.[c];
    if (typeof taskVal === 'number' && (taskVal > 0 || taskVal === -2)) {
      // leave page's clue/wall cell visible (no overdraw)
    } else if (v === 1) {
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
    // Nurikabe hint: value 1 = must be sea/black; value 2 = must be island/white.
    if (cell.value === 1 || cell.value === 2) {
      ctx.strokeStyle = cell.value === 1 ? '#3b82f6' : '#60a5fa';
      ctx.lineWidth = Math.max(2, Math.floor(cellSize / 9));
      ctx.strokeRect(cx + 2, cy + 2, cellSize - 4, cellSize - 4);
    }
  },

  hintStatusNodes(h, { bold }) {
    // Nurikabe hints carry absolute cells in extraCells.
    // cellStatus 1 = sea (black), 2 = island (white).
    const cells = h.extraCells || [];
    if (cells.length === 0) return ['No hint available'];
    if (cells.length === 1) {
      const cell = cells[0];
      const valueStr = cell.value === 1 ? 'sea (black)' : 'island (white)';
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
    return { rows: data.rows, cols: data.cols, task: data.task };
  },

  partialResultArm(result, { applyGridPartialResult }) {
    applyGridPartialResult(result);
  },

  // Hint dispatch for Nurikabe. hintCells from the solver is absolute
  // {row, col, value} packed as extraCells. Mirrors the previous inline arm
  // in content.js's getHint verbatim.
  hintDispatch(ctx) {
    const { detectedGrid, grid, solution, rows, cols, firstMismatch } = ctx;
    if (solution && firstMismatch(grid, solution)) {
      return { success: false, error: 'Current game state is wrong.' };
    }
    const solver = new NurikabeSolver({
      rows, cols, task: detectedGrid.task,
    });
    const hintCells = solver.getHint(grid);
    if (!hintCells || hintCells.length === 0) {
      return { success: false, error: 'No more cells can be deduced from the current state. Click Solve to finish.' };
    }
    const hint = { type: 'nurikabe', extraCells: hintCells, count: hintCells.length };
    return { success: true, hint, grid, solution };
  },
};

// Local copy of preview.js's nurikabeTaskSig — only used by staticSig
// above. Inlined here (matches hitori's `_hitoriTaskSig` pattern) so
// the module is self-contained.
function _nurikabeTaskSig(task) {
  if (!task) return '0';
  let h = 0x811c9dc5;
  for (const row of task) for (const v of row) {
    h ^= v & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
    h ^= (v >>> 8) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = nurikabe;
}
