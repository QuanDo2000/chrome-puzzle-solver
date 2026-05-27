'use strict';

// Norinori puzzle module — Stage C migration.
//
// Hooks consumed by the Stage-B dispatchers (cache.js, preview.js,
// widget.js, content.js):
//   cacheKey         — FNV-1a over puzzle.areas (the room-id grid);
//                      'N' nameplate keeps keys disjoint.
//   staticSig        — contributes the areas signature to the preview's
//                      static-layer cache key.
//   drawStaticLayer  — paints the room/area borders by delegating to the
//                      shared `drawHeyawakeRoomsOn` helper (rooms=null
//                      since Norinori has no target numbers). The helper
//                      stays in preview.js because Heyawake (still
//                      unmigrated) consumes it from there as well.
//   drawPreviewCell  — v=1 = black cell (solid dark fill inset); v=2 =
//                      crossed empty (diagonal cross in muted gray);
//                      v=0 = unknown (blank).
//   hintStatusNodes  — describes a Norinori hint as "must be shaded /
//                      unshaded" for a single deduced cell.
//   solveExtraData   — extra payload for the solver worker: rows/cols
//                      plus rooms (the per-room target list).
//   partialResultArm — wraps applyGridPartialResult so the Stage-B
//                      applyPartialResult dispatcher can route norinori
//                      partial-solve timeouts into the generic grid
//                      partial UI.

const norinori = {
  type: 'norinori',
  label: 'Norinori',
  url: 'https://www.puzzles-mobile.com/norinori/',
  solutionKeyPrefix: 'norinori-solution:',
  skipAutoSolveGate: true,
  hasAbsoluteHintCells: true,
  hintBandSkip: true,

  cacheKey(data) {
    if (data?.type !== 'norinori' || !data.areas) return null;
    let h = 0x811c9dc5;
    const mix = (n) => { h ^= n & 0xff; h = Math.imul(h, 0x01000193) >>> 0; };
    mix(0x4E); // 'N' nameplate
    mix(data.rows); mix(data.cols);
    for (const row of data.areas) for (const v of row) mix(v + 1);
    return 'norinori-solution:' + (h >>> 0).toString(16);
  },

  staticSig(data) {
    return 'nn=' + _norinoriAreasSig(data?.areas);
  },

  drawStaticLayer(ctx, { rows, cols, cellSize, pd }) {
    if (Array.isArray(pd?.areas)) drawHeyawakeRoomsOn(ctx, rows, cols, cellSize, pd.areas, null);
  },

  drawPreviewCell(ctx, { v, x, y, cellSize }) {
    // Norinori: v=1 = black cell (solid dark fill inset); v=2 = crossed
    // empty (diagonal cross in muted gray); v=0 = unknown (blank).
    if (v === 1) {
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
    // Norinori hint: value 1 = must be black (darker blue ring),
    // value 2 = must be empty/crossed (lighter blue ring).
    if (cell.value === 1 || cell.value === 2) {
      ctx.strokeStyle = cell.value === 1 ? '#3b82f6' : '#60a5fa';
      ctx.lineWidth = Math.max(2, Math.floor(cellSize / 9));
      ctx.strokeRect(cx + 2, cy + 2, cellSize - 4, cellSize - 4);
    }
  },

  hintStatusNodes(h, { bold }) {
    // Norinori hints carry absolute cells in extraCells.
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
    return { rows: data.rows, cols: data.cols, rooms: data.rooms };
  },

  partialResultArm(result, { applyGridPartialResult }) {
    applyGridPartialResult(result);
  },
};

// Local copy of preview.js's norinoriAreasSig — only used by staticSig
// above. Inlined here (matches hitori's `_hitoriTaskSig` pattern) so
// the module is self-contained.
function _norinoriAreasSig(areas) {
  if (!areas) return '0';
  let h = 0x811c9dc5;
  for (const row of areas) for (const v of row) {
    h ^= (v + 1) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = norinori;
}
