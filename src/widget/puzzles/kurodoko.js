'use strict';

// Kurodoko puzzle module — Stage C migration.
//
// Hooks consumed by the Stage-B dispatchers (cache.js, preview.js,
// widget.js, content.js):
//   cacheKey         — FNV-1a over puzzle.task (the grid of clue
//                      digits); 'D' nameplate (kuroDoko) keeps keys
//                      disjoint.
//   staticSig        — contributes the task signature to the preview's
//                      static-layer cache key.
//   drawStaticLayer  — paints the thick outer border. (Clue digits
//                      themselves are on the dynamic layer because cell
//                      shading changes text colour.)
//   drawPreviewCell  — clue cells show their digit (light on dark fill
//                      when v=1, dark otherwise); v=1 fills the cell
//                      dark; v=2 renders a faint × cross marking
//                      confirmed white/empty; v=0 non-clue stays blank.
//   hintStatusNodes  — describes a Kurodoko hint as "must be shaded /
//                      unshaded" for a single deduced cell.
//   solveExtraData   — extra payload for the solver worker: rows/cols
//                      plus task (the clue-digit grid).
//   partialResultArm — wraps applyGridPartialResult so the Stage-B
//                      applyPartialResult dispatcher can route kurodoko
//                      partial-solve timeouts into the generic grid
//                      partial UI.

const kurodoko = {
  type: 'kurodoko',
  label: 'Kurodoko',
  url: 'https://www.puzzles-mobile.com/kurodoko/',
  solutionKeyPrefix: 'kurodoko-solution:',
  skipAutoSolveGate: true,
  hasAbsoluteHintCells: true,
  hintBandSkip: true,

  cacheKey(data) {
    if (data?.type !== 'kurodoko' || !data.task) return null;
    let h = 0x811c9dc5;
    const mix = (n) => { h ^= n & 0xff; h = Math.imul(h, 0x01000193) >>> 0; };
    mix(0x44); // 'D' nameplate (kuroDoko)
    mix(data.rows); mix(data.cols);
    for (const row of data.task) for (const v of row) mix(v + 1);
    return 'kurodoko-solution:' + (h >>> 0).toString(16);
  },

  staticSig(data) {
    return 'kd=' + _kurodokoTaskSig(data?.task);
  },

  drawStaticLayer(ctx, { rows, cols, cellSize }) {
    // Outer border only — clue digits are on the dynamic layer (cell
    // shading changes text colour, so they can't be pre-rendered here).
    const borderW = Math.max(2, Math.floor(cellSize / 5));
    ctx.strokeStyle = '#1f2937';
    ctx.lineWidth = borderW;
    ctx.lineCap = 'square';
    ctx.strokeRect(borderW / 2, borderW / 2, cols * cellSize - borderW, rows * cellSize - borderW);
  },

  drawPreviewCell(ctx, { r, c, v, x, y, cellSize, puzzleData }) {
    // Kurodoko: every cell shows clue digit if it's a clue cell.
    // v=1 = black cell (solid dark fill); v=2 = confirmed white/empty
    // (× cross so the player can see deduced whites); v=0 = unknown
    // (blank — skipped by early-bail unless clue cell).
    const pd = puzzleData;
    const taskVal = (pd?.task?.[r]?.[c] ?? -1);
    if (taskVal !== -1) {
      // Clue cell: show the number. If also marked black, fill dark
      // first so the digit renders in light colour on top.
      ctx.font = `bold ${Math.floor(cellSize * 0.5)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (v === 1) {
        ctx.fillStyle = '#1f2937';
        ctx.fillRect(x, y, cellSize, cellSize);
        ctx.fillStyle = '#f3f4f6';
      } else {
        ctx.fillStyle = '#1f2937';
      }
      ctx.fillText(String(taskVal), x + cellSize / 2, y + cellSize / 2);
    } else if (v === 1) {
      ctx.fillStyle = '#1f2937';
      ctx.fillRect(x, y, cellSize, cellSize);
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
    // v === 0 non-clue → blank (already excluded by early-bail above)
  },

  drawHintCell(ctx, { cell, cx, cy, cellSize }) {
    // Kurodoko hint: value 1 = must be black (darker blue ring),
    // value 2 = must be white/empty (lighter blue ring).
    if (cell.value === 1 || cell.value === 2) {
      ctx.strokeStyle = cell.value === 1 ? '#3b82f6' : '#60a5fa';
      ctx.lineWidth = Math.max(2, Math.floor(cellSize / 9));
      ctx.strokeRect(cx + 2, cy + 2, cellSize - 4, cellSize - 4);
    }
  },

  hintStatusNodes(h, { bold }) {
    // Kurodoko hints carry absolute cells in extraCells.
    // cellStatus 1 = shaded (black), 2 = unshaded (white).
    const cells = h.extraCells || [];
    if (cells.length === 0) return ['No hint available'];
    if (cells.length === 1) {
      const cell = cells[0];
      const valueStr = cell.value === 1 ? 'shaded' : 'unshaded';
      return [
        'Cell ', bold(`(row ${cell.row + 1}, col ${cell.col + 1})`),
        ' must be ', bold(valueStr),
      ];
    }
    return [bold(String(cells.length)), ' cells can be deduced'];
  },

  solveExtraData(data) {
    return { rows: data.rows, cols: data.cols, task: data.task };
  },

  partialResultArm(result, { applyGridPartialResult }) {
    applyGridPartialResult(result);
  },

  // Hint dispatch for Kurodoko. hintCells from the solver is absolute
  // {row, col, value} packed as extraCells. Mirrors the previous inline arm
  // in content.js's getHint verbatim.
  hintDispatch(ctx) {
    const { detectedGrid, grid, solution, rows, cols, firstMismatch } = ctx;
    if (solution && firstMismatch(grid, solution)) {
      return { success: false, error: 'Current game state is wrong.' };
    }
    const solver = new KurodokoSolver({
      rows, cols, task: detectedGrid.task,
    });
    const hintCells = solver.getHint(grid);
    if (!hintCells || hintCells.length === 0) {
      return { success: false, error: 'No more cells can be deduced from the current state. Click Solve to finish.' };
    }
    const hint = { type: 'kurodoko', extraCells: hintCells, count: hintCells.length };
    return { success: true, hint, grid, solution };
  },
};

// Local copy of preview.js's kurodokoTaskSig — only used by staticSig
// above. Inlined here (matches hitori's `_hitoriTaskSig` pattern) so
// the module is self-contained.
function _kurodokoTaskSig(task) {
  if (!task) return '0';
  let h = 0x811c9dc5;
  for (const row of task) for (const v of row) {
    h ^= (v + 1) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = kurodoko;
}
