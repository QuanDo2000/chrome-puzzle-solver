'use strict';

// Heyawake puzzle module — Stage C migration.
//
// Hooks consumed by the Stage-B dispatchers (cache.js, preview.js,
// widget.js, content.js):
//   cacheKey         — FNV-1a over (nameplate, rows, cols, flattened
//                      areas 2-D room-ID map, room targets); 'W'
//                      nameplate (heWawake) keeps keys disjoint from
//                      neighbouring room-based puzzles.
//   staticSig        — contributes the areas + room-targets signature to
//                      the preview's static-layer cache key.
//   drawStaticLayer  — paints the room/area borders + target clue
//                      numbers by delegating to the shared
//                      `drawHeyawakeRoomsOn` helper (which still lives
//                      in preview.js because Norinori also calls it as
//                      a bundle-scope global).
//   drawPreviewCell  — v=1 = black cell (solid dark fill flush);
//                      v=2 = white-marker (small grey dot at centre);
//                      v=0 = unknown (blank).
//   hintStatusNodes  — describes a Heyawake hint as "must be black /
//                      white" for a single deduced cell.
//   solveExtraData   — extra payload for the solver worker: rows/cols
//                      plus rooms (the per-room target list).
//   partialResultArm — wraps applyGridPartialResult so the Stage-B
//                      applyPartialResult dispatcher can route heyawake
//                      partial-solve timeouts into the generic grid
//                      partial UI.

const heyawake = {
  type: 'heyawake',
  label: 'Heyawake',
  url: 'https://www.puzzles-mobile.com/heyawake/',
  solutionKeyPrefix: 'heyawake-solution:',
  skipAutoSolveGate: true,
  hasAbsoluteHintCells: true,
  hintBandSkip: true,

  cacheKey(data) {
    if (data?.type !== 'heyawake') return null;
    // FNV-1a over (nameplate, rows, cols, flattened areas 2-D room-ID map).
    let h = 0x811c9dc5;
    const mix = (n) => { h ^= n & 0xff; h = Math.imul(h, 0x01000193) >>> 0; };
    mix(0x57); // 'W' nameplate (heWawake) so heyawake keys can't collide
    mix(data.rows | 0);
    mix(data.cols | 0);
    const areas = data.areas || [];
    for (let r = 0; r < data.rows; r++) {
      const row = areas[r] || [];
      for (let c = 0; c < data.cols; c++) mix((row[c] | 0) + 1);
    }
    if (data.rooms) {
      for (const room of data.rooms) {
        const t = room.target;
        h ^= (t + 1) & 0xff;
        h = Math.imul(h, 0x01000193) >>> 0;
      }
    }
    return 'heyawake-solution:' + (h >>> 0).toString(16);
  },

  staticSig(data) {
    return 'hy=' + _heyawakeAreasSig(data?.areas, data?.rooms);
  },

  drawStaticLayer(ctx, { rows, cols, cellSize, pd }) {
    if (Array.isArray(pd?.areas)) drawHeyawakeRoomsOn(ctx, rows, cols, cellSize, pd.areas, pd.rooms);
  },

  drawPreviewCell(ctx, { v, x, y, cellSize }) {
    // cellStatus 1 = black cell; 2 = white-marked (not black, confirmed
    // empty). Render black as a solid dark fill; white-marker as the grey
    // diagonal × used by every other cell-state puzzle (kurodoko, mosaic,
    // norinori, nurikabe, kakurasu) for the same confirmed-empty semantic.
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
  },

  drawHintCell(ctx, { cell, cx, cy, cellSize }) {
    // Heyawake hint: value 1 = must be black (dark fill + blue ring),
    // value 2 = must be white/empty (translucent overlay + blue ring).
    if (cell.value === 1 || cell.value === 2) {
      const inset = Math.max(1, Math.floor(cellSize * 0.1));
      const side = cellSize - 2 * inset;
      const sx = cx + inset, sy = cy + inset;
      ctx.fillStyle = cell.value === 1 ? 'rgba(31, 41, 55, 0.6)' : 'rgba(255,255,255,0.5)';
      ctx.fillRect(sx, sy, side, side);
      ctx.strokeStyle = '#2e86de';
      ctx.lineWidth = Math.max(2, Math.floor(cellSize / 9));
      ctx.strokeRect(sx, sy, side, side);
    }
  },

  hintStatusNodes(h, { bold }) {
    // Heyawake hints carry absolute cells in extraCells (no row/column index
    // — every hint is a flat list of forced cells from propagation).
    // cellStatus 1 = black, 2 = white-mark; same encoding as Yin-Yang.
    const cells = h.extraCells || [];
    if (cells.length === 0) return ['No hint available'];
    if (cells.length === 1) {
      const cell = cells[0];
      const valueStr = cell.value === 1 ? 'black' : 'white';
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
    return { rows: data.rows, cols: data.cols, rooms: data.rooms };
  },

  partialResultArm(result, { applyGridPartialResult }) {
    applyGridPartialResult(result);
  },

  // Hint dispatch for Heyawake. hintCells from the solver is absolute
  // {row, col, value} packed as extraCells (hintAbsoluteCells passes them
  // through unchanged). Mirrors the previous inline arm in content.js's
  // getHint verbatim.
  hintDispatch(ctx) {
    const { detectedGrid, grid, solution, rows, cols, firstMismatch } = ctx;
    if (solution && firstMismatch(grid, solution)) {
      return { success: false, error: 'Current game state is wrong.' };
    }
    const rooms = detectedGrid.rooms;
    const solver = new HeyawakeSolver({ rows, cols, rooms });
    const hintCells = solver.getHint(grid);
    if (!hintCells || hintCells.length === 0) {
      return { success: false, error: 'No more cells can be deduced from the current state. Click Solve to finish.' };
    }
    const hint = { type: 'heyawake', extraCells: hintCells, count: hintCells.length };
    return { success: true, hint, grid, solution };
  },
};

// Local copy of preview.js's heyawakeAreasSig — only used by staticSig
// above. Inlined here (matches hitori's `_hitoriTaskSig` pattern) so
// the module is self-contained.
function _heyawakeAreasSig(areas, rooms) {
  if (!Array.isArray(areas) || areas.length === 0) return '0';
  let h = 0x811c9dc5;
  for (const row of areas) {
    for (const v of row) {
      h ^= (v + 1) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  if (Array.isArray(rooms)) {
    for (const room of rooms) {
      const t = room.target;
      h ^= (t + 1) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return (h >>> 0).toString(36);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = heyawake;
}
