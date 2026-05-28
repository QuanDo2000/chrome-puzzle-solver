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
//
// === Encoding ===
//
// `/norinori/*` has `NorinoriSolver` + `norinoriHandler`. Same cell encoding
// as Heyawake-family (0=unknown, 1=black, 2=white). Region-partitioned via
// `G.areas` + `G.areaPoints`, **no `areaTask`** — every region has the
// same target.
//
// **Rules (per the site's bundled `getErrors`, NOT textbook Norinori):**
// 1. Each region has exactly 2 black cells (`r[i] > 2` → blockMany; reachable-
//    count < 2 → blockFew).
// 2. No 3-in-row of blacks (`check3InARow`).
// 3. No 2×2 with 3+ blacks (`check2x2`).
// 4. Every black has at least one black neighbour at completion (`checkSolo`
//    flags a black whose neighbours are all status=2).
//
// Combined, these imply blacks tile in 1×2 / 2×1 dominoes — but **dominoes
// may span regions.** A region's 2 blacks can be 1 internal domino, OR 2
// endpoints of separate cross-region dominoes (each paired with a black in
// an adjacent region). Textbook Norinori's "no cross-region adjacency"
// rule **does not apply** on this site. The 30×30 daily relies on this:
// several rooms (e.g. 2-cell forced-domino regions next to 3-cell L
// regions) become infeasible under strict rules but solvable when
// cross-region pairs are allowed.
//
// MAIN-world: `readNorinoriData/readNorinoriState/applyNorinoriState`, twins
// of Heyawake; hints reuse generic `applyHintCells`. Loop done-check needs no
// special arm. Preview: dynamic cells (1=dark inset, 2=× cross); region
// borders cached in `staticLayer` (`|nn=` segment); diff is per-cell same as
// other cell-state puzzles.
//
// See `src/solvers/norinori.js` for the propagation rules, lookahead, and
// the rules to NOT reintroduce.

const norinori = {
  type: 'norinori',
  label: 'Norinori',
  url: 'https://www.puzzles-mobile.com/norinori/',
  solutionKeyPrefix: 'norinori-solution:',
  skipAutoSolveGate: true,
  hasAbsoluteHintCells: true,
  hintBandSkip: true,
  renderEmptyCells: true,

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

  // Hint dispatch for Norinori. hintCells from the solver is absolute
  // {row, col, value} packed as extraCells. Mirrors the previous inline arm
  // in content.js's getHint verbatim.
  hintDispatch(ctx) {
    const { detectedGrid, grid, solution, rows, cols, firstMismatch } = ctx;
    if (solution && firstMismatch(grid, solution)) {
      return { success: false, error: 'Current game state is wrong.' };
    }
    const solver = new NorinoriSolver({
      rows, cols, rooms: detectedGrid.rooms,
    });
    const hintCells = solver.getHint(grid);
    if (!hintCells || hintCells.length === 0) {
      return { success: false, error: 'No more cells can be deduced from the current state. Click Solve to finish.' };
    }
    const hint = { type: 'norinori', extraCells: hintCells, count: hintCells.length };
    return { success: true, hint, grid, solution };
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
