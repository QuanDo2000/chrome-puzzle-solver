'use strict';

// Shikaku puzzle module — Stage C migration.
//
// More complex than the prior cell-state migrations because Shikaku uses
// owner-id encoding (not 0/1/2 cellStatus): `-1` is "unassigned", any
// non-negative integer is the index of the owning clue. Several preview
// branches and the loop done-check key on that sentinel rather than `0`.
//
// Hooks consumed by the Stage-B dispatchers (cache.js, preview.js,
// widget.js, content.js):
//   cacheKey         — FNV-1a over (nameplate, rows, cols, sorted clues);
//                      'S' nameplate keeps keys disjoint from neighbouring
//                      puzzles.
//   staticSig        — contributes the clue-set signature to the preview's
//                      static-layer cache key (`sk=…`).
//   drawStaticLayer  — paints the bold clue numbers onto the static layer
//                      by delegating to a module-local copy of preview.js's
//                      `drawShikakuCluesOn`.
//   drawPreviewCell  — v >= 0 = owner-coloured cell (picks from the shared
//                      `galaxiesColors` palette by owner index). Gating to
//                      skip v === -1 stays in the preview cell loop (it's
//                      a continue-guard, not a render branch).
//   hintStatusNodes  — describes a Shikaku hint as the rectangle to draw
//                      for a named clue.
//   solveExtraData   — extra payload for the solver worker: rows, cols,
//                      and the full clues list.
//   loopDoneCheck    — "every cell has an owner" sentinel (i.e. no cell is
//                      still `-1`). Note this dispatches the in-loop check
//                      only; the post-loop endComplete site stays inline.
//
// No partialResultArm / skipAutoSolveGate / hintDispatch: Shikaku doesn't
// have a partial-result fallback path, the hint chain awaits autoSolve like
// the other cell-state puzzles, and its hint logic lives in content.js's
// generic getHint() arm.
//
// Two paint branches in preview.js stay inline as Stage D concerns:
//   * The post-cell-loop rectangle-border arm (~lines 664-683) draws thick
//     black borders between cells with different owner ids. That's not a
//     per-cell render — it runs after the cell loop and is not covered by
//     the Stage-B drawPreviewCell dispatcher.
//   * The hint-cell ring arm (`puzzleData?.type === 'shikaku' && cell.value
//     >= 0`) paints the freshly-revealed hint rectangle with its colour +
//     blue ring. No hint-cell dispatcher exists yet.
// The apply-pendingHint paths at widget.js:829 and :1110 also stay inline:
// Shikaku has a dedicated MAIN-world `applyShikakuState` function (owner-id
// encoding + `currentState.areas`), and lifting that into a hook is a
// Stage-D concern.

const shikaku = {
  type: 'shikaku',
  label: 'Shikaku',
  url: 'https://www.puzzles-mobile.com/shikaku/',
  solutionKeyPrefix: 'shikaku-solution:',
  hintBandSkip: true,

  cacheKey(data) {
    if (data?.type !== 'shikaku') return null;
    let h = 0x811c9dc5;
    const mix = (n) => { h ^= n; h = Math.imul(h, 0x01000193) >>> 0; };
    mix(0x53); // 'S' nameplate
    mix(data.rows | 0);
    mix(data.cols | 0);
    const clues = Array.isArray(data.clues) ? data.clues : [];
    mix(clues.length);
    const sorted = clues.slice().sort((a, b) =>
      a.row - b.row || a.col - b.col || a.area - b.area);
    for (const k of sorted) {
      mix(k.row | 0);
      mix(k.col | 0);
      mix(k.area | 0);
    }
    return 'shikaku-solution:' + (h >>> 0).toString(16);
  },

  staticSig(data) {
    return 'sk=' + _shikakuCluesSig(data?.clues);
  },

  drawStaticLayer(ctx, { cellSize, pd }) {
    if (Array.isArray(pd?.clues)) _drawShikakuCluesOn(ctx, cellSize, pd.clues);
  },

  drawPreviewCell(ctx, { v, x, y, cellSize, galaxiesColors }) {
    if (v >= 0) {
      ctx.fillStyle = galaxiesColors[v % galaxiesColors.length];
      ctx.fillRect(x + 1, y + 1, cellSize - 2, cellSize - 2);
    }
  },

  drawHintCell(ctx, { cell, cx, cy, cellSize, galaxiesColors }) {
    // Shikaku hint cell: paint it in its owning rectangle's colour
    // (so the rectangle visibly takes shape) with a blue ring to
    // mark it as the newly-revealed hint.
    if (cell.value >= 0) {
      ctx.fillStyle = galaxiesColors[cell.value % galaxiesColors.length];
      ctx.fillRect(cx + 1, cy + 1, cellSize - 2, cellSize - 2);
      ctx.strokeStyle = '#2e86de';
      ctx.lineWidth = Math.max(2, Math.floor(cellSize / 7));
      ctx.strokeRect(cx + 2, cy + 2, cellSize - 4, cellSize - 4);
    }
  },

  hintStatusNodes(h, { bold }) {
    const total = (h.cells?.length || 0) + (h.extraCells?.length || 0);
    if (total === 0) return ['No hint available'];
    if (h.clue) {
      return [
        'Draw the ', bold(`${h.clue.area}`), '-cell rectangle for the clue at ',
        bold(`(row ${h.clue.row + 1}, col ${h.clue.col + 1})`),
      ];
    }
    return [bold(String(total)), ' cells can be deduced'];
  },

  solveExtraData(data) {
    return { rows: data.rows, cols: data.cols, clues: data.clues };
  },

  loopDoneCheck({ boardState }) {
    if (!boardState) return false;
    // Shikaku's boardState is a 2D grid of owner indices (not 0/1/2). The
    // unassigned sentinel is -1, not 0, so the cell-state default check
    // would return done as soon as any owner index = 0 appears.
    return boardState.every(row => row.every(c => c !== -1));
  },
};

// Local copy of preview.js's drawShikakuCluesOn — only used by
// drawStaticLayer above. Inlined here (matches heyawake's
// `_heyawakeAreasSig` pattern) so the module is self-contained.
function _drawShikakuCluesOn(ctx, cellSize, clues) {
  const fontSize = Math.max(10, Math.floor(cellSize * 0.5));
  ctx.save();
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#fff';
  ctx.fillStyle = '#111827';
  for (const k of clues) {
    const x = k.col * cellSize + cellSize / 2;
    const y = k.row * cellSize + cellSize / 2;
    const ch = String(k.area);
    ctx.strokeText(ch, x, y);
    ctx.fillText(ch, x, y);
  }
  ctx.restore();
}

// Local copy of preview.js's shikakuCluesSig — only used by staticSig above.
function _shikakuCluesSig(clues) {
  if (!Array.isArray(clues) || clues.length === 0) return '0';
  let h = 0x811c9dc5;
  for (const k of clues) {
    h ^= (k.row | 0) * 65537 + (k.col | 0) * 31 + (k.area | 0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(36);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = shikaku;
}
