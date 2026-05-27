'use strict';

// Mosaic puzzle module — Stage C migration.
//
// Hooks consumed by the Stage-B dispatchers (cache.js, preview.js,
// widget.js, content.js):
//   cacheKey         — FNV-1a over puzzle.task (the grid of clue
//                      digits); 'M' nameplate keeps keys disjoint.
//   staticSig        — contributes the task signature to the preview's
//                      static-layer cache key.
//   drawStaticLayer  — paints the outer border + light interior grid
//                      lines. (Clue digits themselves are on the
//                      dynamic layer because cell shading changes text
//                      colour.)
//   drawPreviewCell  — clue cells show their digit (light on dark fill
//                      when v=1, dark otherwise); v=1 fills the cell
//                      dark; v=2 renders a faint × cross marking
//                      confirmed white/empty; v=0 non-clue stays blank.
//   hintStatusNodes  — describes a Mosaic hint as "must be shaded /
//                      unshaded" for a single deduced cell.
//   solveExtraData   — extra payload for the solver worker: rows/cols
//                      plus task (the clue-digit grid).
//   partialResultArm — wraps applyGridPartialResult so the Stage-B
//                      applyPartialResult dispatcher can route mosaic
//                      partial-solve timeouts into the generic grid
//                      partial UI.

const mosaic = {
  type: 'mosaic',
  label: 'Mosaic',
  url: 'https://www.puzzles-mobile.com/mosaic/',
  solutionKeyPrefix: 'mosaic-solution:',
  skipAutoSolveGate: true,
  hasAbsoluteHintCells: true,
  hintBandSkip: true,

  cacheKey(data) {
    if (data?.type !== 'mosaic' || !data.task) return null;
    let h = 0x811c9dc5;
    const mix = (n) => { h ^= n & 0xff; h = Math.imul(h, 0x01000193) >>> 0; };
    mix(0x4D); // 'M' nameplate
    mix(data.rows); mix(data.cols);
    for (const row of data.task) for (const v of row) mix(v + 1);
    return 'mosaic-solution:' + (h >>> 0).toString(16);
  },

  staticSig(data) {
    return 'mc=' + _mosaicTaskSig(data?.task);
  },

  drawStaticLayer(ctx, { rows, cols, cellSize }) {
    // Outer border + light interior grid lines. Clue digits go on the
    // dynamic layer because cell shading changes text colour.
    const borderW = Math.max(2, Math.floor(cellSize / 5));
    ctx.strokeStyle = '#1f2937';
    ctx.lineWidth = borderW;
    ctx.lineCap = 'square';
    ctx.strokeRect(borderW / 2, borderW / 2, cols * cellSize - borderW, rows * cellSize - borderW);
  },

  drawPreviewCell(ctx, { r, c, v, x, y, cellSize, puzzleData }) {
    const pd = puzzleData;
    const taskVal = (pd?.task?.[r]?.[c] ?? -1);
    // Background fill based on cellStatus.
    if (v === 1) {
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
    // Clue digit overlay (light text on dark fill, dark otherwise).
    if (taskVal !== -1) {
      ctx.font = `bold ${Math.floor(cellSize * 0.5)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = (v === 1) ? '#f3f4f6' : '#1f2937';
      ctx.fillText(String(taskVal), x + cellSize / 2, y + cellSize / 2);
    }
  },

  hintStatusNodes(h, { bold }) {
    // Mosaic hints carry absolute cells in extraCells.
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
};

// Local copy of preview.js's mosaicTaskSig — only used by staticSig
// above. Inlined here (matches hitori's `_hitoriTaskSig` pattern) so
// the module is self-contained.
function _mosaicTaskSig(task) {
  if (!task) return '0';
  let h = 0x811c9dc5;
  for (const row of task) for (const v of row) {
    h ^= (v + 1) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = mosaic;
}
