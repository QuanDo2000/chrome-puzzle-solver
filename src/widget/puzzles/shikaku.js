'use strict';

const { hashFNV1a } = require('../shared.js');

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
// === Encoding ===
//
// `/shikaku/*` has dedicated `ShikakuSolver` + `shikakuHandler` (partitions
// grid into rectangles — no overlap with cell-state puzzles).
//
// `window.Game.task` is 2D ints: non-zero cells are clues (value = required
// rectangle area), zero = non-clue. `currentState.cellStatus` is `rows×cols`:
// `-1 = unassigned`, else owner clue index. `currentState.areas` is the
// rectangle list indexed by owner id.
//
// Each area MUST match the page's `currentMove` shape:
// `{cells:[{row,col}], cellStatus:id, invert:false, startPoint:{row,col},
// endPoint:{row,col}}`. Field names are load-bearing — three page functions
// each crash on a mismatch: `drawCurrentStateInternal` reads
// `startPoint/endPoint`, `removeArea` reads `cells[].row/col` (NOT
// `cellList[].r/c`), `applyCurrentMoveToState` stores at
// `areas[move.cellStatus]` (every area's `cellStatus` MUST equal its index).
// Partial-hint clues with no cells left as `undefined` — page's
// `void 0 !== areas[t]` guards skip those.
//
// Worker→content→MAIN shape: 2D `number[][]` of owner indices (0..K-1) or `-1`.
// `applyHintHandler`/`applyAndRunLoop` in `content.js` have shikaku-specific arms;
// generic `applyHintCells` assumes cell-state encoding. Loop done-check uses
// `-1` as unassigned (unlike other puzzles where `0` means unassigned).
//
// Preview colors cells by owner index (`galaxiesColors`), thick borders between
// distinct owners, clue numbers overlaid as bold text in cached `staticLayer`;
// `staticSig` includes `|sk=`.
//
// See `src/solvers/shikaku.js` for the rectangle-enumeration algorithm.
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
  renderEmptyCells: true,

  cacheKey(data) {
    if (data?.type !== 'shikaku') return null;
    const h = hashFNV1a((mix) => {
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
    }, false);
    return 'shikaku-solution:' + h.toString(16);
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

  async applyHint(hint, { callMainWorld, hintAbsoluteCells, puzzleData }) {
    // Shikaku uses owner-index cellStatus + currentState.areas; the
    // generic applyHintCells writer doesn't know that shape. Read the
    // current state, overlay the hint cells, re-apply via the dedicated
    // shikaku function.
    const hintCells = hintAbsoluteCells(hint);
    const cur = await callMainWorld('readShikakuState', [puzzleData.rows, puzzleData.cols]);
    const grid = cur || Array.from({ length: puzzleData.rows }, () => new Array(puzzleData.cols).fill(-1));
    for (const cell of hintCells) grid[cell.row][cell.col] = cell.value;
    return !!(await callMainWorld('applyShikakuState', [grid, puzzleData.clues]));
  },

  // Hint dispatch for Shikaku. No "current state is wrong" pre-check —
  // owner-index grids don't compare with firstMismatch (cell-state-only).
  // Mirrors the previous inline arm in content.js's getHint verbatim.
  hintDispatch(ctx) {
    const { detectedGrid, grid, solution, rows, cols } = ctx;
    const solver = new ShikakuSolver({
      rows, cols, clues: detectedGrid.clues, initialState: grid,
    });
    const hint = solver.getHint(grid);
    if (!hint) {
      return { success: false, error: 'No more cells can be deduced from the current state. Click Solve to finish.' };
    }
    return { success: true, hint, grid, solution };
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
  const h = hashFNV1a((mix) => {
    for (const k of clues) {
      mix((k.row | 0) * 65537 + (k.col | 0) * 31 + (k.area | 0));
    }
  }, false);
  return h.toString(36);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = shikaku;
}
