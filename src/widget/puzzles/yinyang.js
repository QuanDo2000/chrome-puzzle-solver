'use strict';

// Yin-Yang puzzle module — Stage C migration.
//
// Hooks consumed by the Stage-B dispatchers (cache.js, preview.js,
// widget.js, content.js):
//   cacheKey         — FNV-1a over (nameplate, rows, cols, flattened
//                      task); 'Y' nameplate keeps keys disjoint from
//                      neighbouring puzzles.
//   drawPreviewCell  — v=1 = black square; v=2 = white square (inset
//                      with a 1.5-px outline so it reads against the
//                      lattice). Given cells (`task` is sparse with
//                      -1=no-given, 0=white-given, 1=black-given) get
//                      a small contrasting centre square.
//   hintStatusNodes  — describes a Yin-Yang hint as "must be black /
//                      white" for a single deduced cell. The hint
//                      payload uses {type, index, cells} (row/col +
//                      cells[].index) OR {extraCells} (absolute
//                      {row, col, value}) — the helper bridges both.
//   solveExtraData   — extra payload for the solver worker:
//                      rows/cols/task.
//
// No staticSig / drawStaticLayer / partialResultArm / skipAutoSolveGate:
// Yin-Yang's static layer is just the grid (lattice + givens are
// rendered per-cell), there's no partial-result fallback path, and the
// hint chain doesn't fast-bypass autoSolve.

const yinyang = {
  type: 'yinyang',
  label: 'Yin-Yang',
  url: 'https://www.puzzles-mobile.com/yin-yang/',
  solutionKeyPrefix: 'yinyang-solution:',

  cacheKey(data) {
    if (data?.type !== 'yinyang') return null;
    // FNV-1a over (type nameplate, rows, cols, flattened task).
    let h = 0x811c9dc5;
    const mix = (n) => { h ^= n; h = Math.imul(h, 0x01000193) >>> 0; };
    mix(0x59); // 'Y' nameplate so yin-yang keys can't collide with other types
    mix(data.rows | 0);
    mix(data.cols | 0);
    const t = data.task || [];
    for (let r = 0; r < data.rows; r++) {
      const row = t[r] || [];
      for (let c = 0; c < data.cols; c++) mix((row[c] | 0) + 2);
    }
    return 'yinyang-solution:' + (h >>> 0).toString(16);
  },

  drawPreviewCell(ctx, { r, c, v, x, y, cellSize, puzzleData }) {
    // cellStatus 1 renders light, 2 renders dark — matching the game
    // (Yin-Yang shares Binairo's cell encoding/polarity).
    const yyInset = Math.max(1, Math.floor(cellSize * 0.15));
    const yySide = cellSize - 2 * yyInset;
    const sx = x + yyInset, sy = y + yyInset;
    if (v === 1) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(sx, sy, yySide, yySide);
      ctx.strokeStyle = '#1f2937';
      ctx.lineWidth = Math.max(1.5, cellSize / 14);
      ctx.strokeRect(sx, sy, yySide, yySide);
    } else if (v === 2) {
      ctx.fillStyle = '#1f2937';
      ctx.fillRect(sx, sy, yySide, yySide);
    }
    // Given cells get a small contrasting centre square.
    const given = puzzleData?.task?.[r]?.[c];
    if (given === 0 || given === 1) {
      const dotSide = Math.max(2, Math.floor(cellSize * 0.2));
      ctx.fillStyle = v === 1 ? '#1f2937' : '#fff';
      ctx.fillRect(x + (cellSize - dotSide) / 2, y + (cellSize - dotSide) / 2, dotSide, dotSide);
    }
  },

  drawHintCell(ctx, { cell, cx, cy, cellSize }) {
    // Draw the hint square in its colour, ringed blue to mark the hint.
    if (cell.value === 1 || cell.value === 2) {
      const inset = Math.max(1, Math.floor(cellSize * 0.15));
      const side = cellSize - 2 * inset;
      const sx = cx + inset, sy = cy + inset;
      ctx.fillStyle = cell.value === 1 ? '#fff' : '#1f2937';
      ctx.fillRect(sx, sy, side, side);
      ctx.strokeStyle = '#2e86de';
      ctx.lineWidth = Math.max(2, Math.floor(cellSize / 9));
      ctx.strokeRect(sx, sy, side, side);
    }
  },

  hintStatusNodes(h, { bold }) {
    const total = (h.cells?.length || 0) + (h.extraCells?.length || 0);
    if (total === 0) return ['No hint available'];
    if (total === 1) {
      const cell = h.cells?.[0] || h.extraCells?.[0];
      const row = h.cells?.length ? h.index : cell.row;
      const col = h.cells?.length ? cell.index : cell.col;
      // Yin-Yang cellStatus: 1 = black, 2 = white.
      const valueStr = cell.value === 1 ? 'black' : 'white';
      return [
        'Cell ', bold(`(row ${row + 1}, col ${col + 1})`),
        ' must be ', bold(valueStr),
      ];
    }
    if (h._fullCount && h._fullCount > total) {
      return [bold(String(total)), ` (of ${h._fullCount}) cells can be deduced`];
    }
    return [bold(String(total)), ' cells can be deduced'];
  },

  solveExtraData(data) {
    return { rows: data.rows, cols: data.cols, task: data.task };
  },

  // Hint dispatch for Yin-Yang. Pure deduction by design (no solve fallback)
  // — propagation exhaustion surfaces a "click Solve" error. Mirrors the
  // previous inline arm in content.js's getHint verbatim.
  hintDispatch(ctx) {
    const { detectedGrid, grid, solution, rows, cols, firstMismatch } = ctx;
    if (solution && firstMismatch(grid, solution)) {
      return { success: false, error: 'Current game state is wrong.' };
    }
    const solver = new YinYangSolver({
      rows, cols, task: detectedGrid.task, initialState: grid,
    });
    const hint = solver.getHint(grid);
    if (!hint) {
      return { success: false, error: 'No more cells can be deduced from the current state. Click Solve to finish.' };
    }
    return { success: true, hint, grid, solution };
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = yinyang;
}
