'use strict';

const { hashFNV1a } = require('../shared.js');

// Star Battle widget module — detect / solve / hint / loop / preview hooks.
//
// HINT (deductive): hintDispatch reads the raw cellStatus (1 star, 2 X, 0 unknown), runs
// StarBattleSolver._deduceForced, reports newly-forced cells (stars AND no-stars), batch-capped;
// falls back to revealing the next cached-solution stars.
//
// VALUE-SPACES (don't conflate):
//   * solver cells (StarBattleSolver): 1 star, 0 no-star, 9 UNK (partials only).
//   * preview / solution / apply space: 0 empty, 1 star, 2 X (no-star marker), 9 UNK (= empty).
//     solutionFromResult converts solver -> this space (no-star 0 -> X 2; UNK 9 -> empty 0), so a full
//     Solve previews and applies stars PLUS an X on every no-star, while an untouched board or the
//     undecided part of a partial stays blank. drawPreviewCell paints 1 -> star, 2 -> X, else nothing;
//     applyStarBattleState writes 1 -> cellStatus 1, 2 -> cellStatus 2, and skips 0/9. EMPTY CELLS
//     MUST RENDER EMPTY — never draw an X for value 0.
//   * handler.readState returns a normalized {0 not-star, 1 star} board (X reads as 0), so the default
//     per-cell mistake-diff / firstMismatch (guarded by grid !== 0) flag only wrongly-placed stars.
//   * hint extraCells / _deduceForced: {1 star, 2 no-star}; applyHint writes only those (rest 9).
// loopDoneCheck and the hint fallback test === 1 (stars) only, so the no-star 0-vs-2 distinction is
// moot there. Region borders come from puzzleData.regionMap (the shaped areas) via the preview infra.

function hintBatchCap(rows, cols) { return Math.max(4, Math.ceil((rows * cols) / 30)); }

const starbattle = {
  type: 'starbattle',
  label: 'Star Battle',
  url: 'https://www.puzzles-mobile.com/star-battle/',
  solutionKeyPrefix: 'starbattle-solution:',
  hasAbsoluteHintCells: true,
  hintBandSkip: true,
  renderEmptyCells: true,

  cacheKey(data) {
    if (!data || data.type !== 'starbattle') return null;
    // FNV-1a over (nameplate 'B'=0x42, rows, cols, stars, flattened areas|walls).
    const h = hashFNV1a((mix) => {
      mix(0x42); mix(data.rows | 0); mix(data.cols | 0); mix((data.stars | 0) + 1);
      const grid = data.areas || data.walls || [];
      for (let r = 0; r < grid.length; r++) { const row = grid[r] || []; for (let c = 0; c < row.length; c++) mix((row[c] | 0) + 1); }
    });
    return 'starbattle-solution:' + h.toString(16);
  },

  canvasDims(pd, { grid }) {
    return {
      rows: pd?.rows || (Array.isArray(grid) ? grid.length : 0),
      cols: pd?.cols || (Array.isArray(grid) && grid[0] ? grid[0].length : 0),
      marginCells: 0,
    };
  },

  staticSig(data) { return 'sb=' + _starbattleSig(data?.type === 'starbattle' ? data : null); },

  // Static layer: outer border + wall cells (shapeless). Region borders (shaped) are drawn from
  // puzzleData.regionMap by preview.js's shared region-border renderer.
  drawStaticLayer(ctx, { rows, cols, cellSize, pd }) {
    ctx.save();
    const walls = pd && pd.walls;
    if (Array.isArray(walls)) {
      ctx.fillStyle = '#1f2937';
      for (let r = 0; r < rows; r++) { const row = walls[r] || []; for (let c = 0; c < cols; c++) if (row[c] === 1) ctx.fillRect(c * cellSize, r * cellSize, cellSize, cellSize); }
    }
    const borderW = Math.max(2, Math.floor(cellSize / 6));
    ctx.strokeStyle = '#1f2937'; ctx.lineWidth = borderW; ctx.lineCap = 'square';
    ctx.strokeRect(borderW / 2, borderW / 2, cols * cellSize - borderW, rows * cellSize - borderW);
    ctx.restore();
  },

  // Dynamic per-cell render (value-space 0 empty / 1 star / 2 X / 9 UNK): a star glyph for 1, an X for
  // an explicit no-star marker (2). Empty (0) and UNK (9) draw NOTHING — an untouched or partly-deduced
  // board stays blank; only solved/marked cells get a glyph.
  drawPreviewCell(ctx, { v, x, y, cellSize }) {
    if (v === 1) _drawStar(ctx, x, y, cellSize, '#f59e0b');
    else if (v === 2) _drawCross(ctx, x, y, cellSize, 'rgba(120, 124, 130, 0.65)');
  },

  drawHintCell(ctx, { cell, cx, cy, cellSize }) {
    if (cell.value === 1) _drawStar(ctx, cx, cy, cellSize, 'rgba(46, 134, 222, 0.85)');
    else { // forced no-star: a light ring
      ctx.save(); ctx.strokeStyle = '#60a5fa'; ctx.lineWidth = Math.max(2, Math.floor(cellSize / 9));
      ctx.strokeRect(cx + 2, cy + 2, cellSize - 4, cellSize - 4); ctx.restore();
    }
  },

  hintStatusNodes(h, { bold }) {
    const cells = h.extraCells || [];
    if (cells.length === 0) return ['No hint available'];
    if (cells.length === 1) {
      const cell = cells[0];
      const label = cell.value === 1 ? 'a star' : 'no star';
      return ['Cell ', bold(`(row ${cell.row + 1}, col ${cell.col + 1})`), ' is ', bold(label)];
    }
    return [bold(String(cells.length)), ' cells can be deduced'];
  },

  solveExtraData(data) { return { rows: data.rows, cols: data.cols, stars: data.stars, areas: data.areas, walls: data.walls }; },
  // Convert solver cells (1 star / 0 no-star / 9 UNK) into the preview/apply space (1 star / 2 X /
  // 0 empty): a full solution becomes stars + an X on every no-star; a partial's UNK (9) -> empty (0).
  solutionFromResult(result) {
    return result && result.cells
      ? result.cells.map((row) => row.map((v) => (v === 1 ? 1 : (v === 9 ? 0 : 2))))
      : null;
  },
  solutionToCacheJson(solution) { return Array.isArray(solution) ? { cells: solution.map((row) => row.slice()) } : null; },
  solutionFromCacheJson(parsed) { return (parsed && Array.isArray(parsed.cells)) ? parsed.cells.map((row) => row.slice()) : null; },

  // Deductive hint. ctx: { detectedGrid, grid, solution, rows, cols, callMainWorld, firstMismatch }.
  async hintDispatch(ctx) {
    const { callMainWorld, solution, rows, cols, detectedGrid, grid, firstMismatch } = ctx;
    if (solution && firstMismatch && firstMismatch(grid, solution)) {
      return { success: false, error: 'Current game state is wrong.' };
    }
    if (detectedGrid && typeof detectedGrid.stars === 'number') {
      try {
        const state = await callMainWorld('readStarBattleState', []);
        const cs = state && state.cellStatus;
        if (Array.isArray(cs)) {
          const Solver = (typeof StarBattleSolver !== 'undefined') ? StarBattleSolver : require('../../solvers/starbattle.js').StarBattleSolver;
          const solver = new Solver({ rows, cols, stars: detectedGrid.stars, areas: detectedGrid.areas, walls: detectedGrid.walls, maxMs: 1500 });
          const forced = solver._deduceForced(cs);
          if (forced && forced.length) {
            const batch = forced.slice(0, hintBatchCap(rows, cols));
            return { success: true, hint: { type: 'starbattle', extraCells: batch, count: batch.length }, grid, solution };
          }
        }
      } catch { /* fall through */ }
    }
    if (!Array.isArray(solution)) return { success: false, error: 'No solution available' };
    const cap = hintBatchCap(rows, cols);
    const cells = [];
    for (let r = 0; r < solution.length && cells.length < cap; r++) {
      const sRow = solution[r] || [];
      for (let c = 0; c < sRow.length && cells.length < cap; c++) {
        const cur = grid && grid[r] ? grid[r][c] : 0;
        if (sRow[c] === 1 && cur !== 1) cells.push({ row: r, col: c, value: 1 });
      }
    }
    if (!cells.length) return { success: false, error: 'No hint available' };
    return { success: true, hint: { type: 'starbattle', extraCells: cells, count: cells.length }, grid, solution };
  },

  // ctx: { boardState, solution, puzzleData }. Done when every solution star is on the board.
  loopDoneCheck(ctx) {
    const { boardState, solution } = ctx;
    if (!Array.isArray(solution) || !Array.isArray(boardState)) return false;
    for (let r = 0; r < solution.length; r++) {
      const sRow = solution[r] || [], bRow = boardState[r] || [];
      for (let c = 0; c < sRow.length; c++) { if (sRow[c] === 1 && bRow[c] !== 1) return false; }
    }
    return true;
  },

  // Apply a hint batch: write ONLY the hint cells (UNK=9 elsewhere; applyStarBattleState skips UNK).
  async applyHint(hint, { callMainWorld, puzzleData }) {
    const rows = puzzleData ? puzzleData.rows : 0;
    const cols = puzzleData ? puzzleData.cols : 0;
    const cells = [];
    for (let r = 0; r < rows; r++) cells.push(new Array(cols).fill(9));
    for (const cell of (hint.extraCells || [])) { if (cells[cell.row]) cells[cell.row][cell.col] = cell.value; }
    const ok = await callMainWorld('applyStarBattleState', [{ cells }]);
    return ok === true;
  },

  // Partial-Solve UI: solver timed out and returned { partial:true, cells } (UNK=9 where open).
  partialResultArm(result, {
    clearPendingHint, setStatus, drawPreview, setConfirming, setLoopConfirming, setSolveBtnText,
  }) {
    setLoopConfirming(false); clearPendingHint(); setSolveBtnText('Confirm'); setConfirming(true);
    const cells = (result.cells || []).map((row) => row.map((v) => (v === 1 ? 1 : (v === 9 ? 0 : 2))));
    let placed = 0, total = 0;
    for (const row of result.cells || []) for (const v of row) { total++; if (v === 1 || v === 0) placed++; }
    const pct = total > 0 ? Math.round(100 * placed / total) : 0;
    setStatus(`Partial only: ${placed} cells deduced (${pct}% of cells, too hard for a full solve). Apply, then finish manually.`, 'info');
    drawPreview(cells);
  },
};

// Draw a star glyph (the ★ character) centred in the cell.
function _drawStar(ctx, x, y, size, fill) {
  ctx.save();
  ctx.fillStyle = fill;
  ctx.font = `${Math.floor(size * 0.8)}px serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('★', x + size / 2, y + size / 2 + size * 0.04);
  ctx.restore();
}

// Draw a small X (the no-star marker) centred in the cell.
function _drawCross(ctx, x, y, size, stroke) {
  const m = size * 0.3; // inset from the cell edge
  ctx.save();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = Math.max(1, size * 0.07);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x + m, y + m); ctx.lineTo(x + size - m, y + size - m);
  ctx.moveTo(x + size - m, y + m); ctx.lineTo(x + m, y + size - m);
  ctx.stroke();
  ctx.restore();
}

function _starbattleSig(data) {
  if (!data) return '0';
  const grid = data.areas || data.walls || [];
  const h = hashFNV1a((mix) => { mix((data.stars | 0) + 1); for (const row of grid) for (const v of row) mix(((v | 0) + 1) & 0xff); });
  return h.toString(16);
}

if (typeof module !== 'undefined' && module.exports) { module.exports = starbattle; }
