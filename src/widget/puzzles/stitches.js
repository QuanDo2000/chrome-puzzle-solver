'use strict';

const { hashFNV1a } = require('../shared.js');

// Stitches widget module — detect / solve / hint / loop / preview hooks.
//
// EDGE MODEL: stitches join orthogonally-adjacent cells in DIFFERENT regions. The solver
// returns { horizontal, vertical } two rows x cols 0/1 grids (1 = stitch); horizontal[r][c]
// joins (r,c)-(r,c+1) (c<cols-1), vertical[r][c] joins (r,c)-(r+1,c) (r<rows-1) — the page's
// cellHorizontalStatus/cellVerticalStatus shape. solutionFromResult returns { horizontal,
// vertical } so the preview stitches-arm, _slitherlinkDiff, and the cache share one shape.
// drawStaticLayer draws region borders (via regionMap) + the row/col clue numbers in margin
// gutters; preview.js draws stitch segments between cell centres + endpoint holes (its
// stitches arm).
//
// HINT (deductive): hintDispatch reads the raw tri-state stitch arrays, runs
// StitchesSolver._deduceForced for the next batch of forced STITCH edges, batch-caps them,
// and falls back to revealing the next batch of cached-solution stitches. applyHint overlays
// ONLY the hint stitch edges. hasAbsoluteHintCells:true + a 'stitches' branch in hint.js
// applyHintToGrid (the Masyu Loop trap — both required).

function hintBatchCap(rows, cols) { return Math.max(6, Math.ceil((rows * cols) / 30)); }

const stitches = {
  type: 'stitches',
  label: 'Stitches',
  url: 'https://www.puzzles-mobile.com/stitches/',
  solutionKeyPrefix: 'stitches-solution:',
  hasAbsoluteHintCells: true,

  cacheKey(data) {
    if (!data || data.type !== 'stitches' || !data.areas) return null;
    const h = hashFNV1a((mix) => {
      mix(0x53); mix(data.rows | 0); mix(data.cols | 0); mix((data.stitches | 0) + 1);
      for (const row of data.areas) for (const v of row) mix((v | 0) + 1);
      for (const v of (data.colClue || [])) mix((v | 0) + 1);
      for (const v of (data.rowClue || [])) mix((v | 0) + 1);
    });
    return 'stitches-solution:' + h.toString(16);
  },

  staticSig(data) { return 'st=' + _stitchesSig(data?.type === 'stitches' ? data : null); },

  canvasDims(pd, { grid }) {
    return {
      rows: pd?.rows || (Array.isArray(grid && grid.horizontal) ? grid.horizontal.length : 0),
      cols: pd?.cols || (Array.isArray(grid && grid.horizontal) && grid.horizontal[0] ? grid.horizontal[0].length : 0),
      marginCells: 0.6,
    };
  },

  drawStaticLayer(ctx, { rows, cols, cellSize, pd }) {
    const colClue = (pd && pd.colClue) || [], rowClue = (pd && pd.rowClue) || [];
    ctx.save();
    ctx.fillStyle = '#1f2937';
    ctx.font = `${Math.max(8, Math.floor(cellSize * 0.45))}px sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const g = cellSize * 0.6;
    for (let c = 0; c < cols; c++) ctx.fillText(String(colClue[c] ?? ''), (c + 0.5) * cellSize, -g / 2);
    for (let r = 0; r < rows; r++) ctx.fillText(String(rowClue[r] ?? ''), -g / 2, (r + 0.5) * cellSize);
    const borderW = Math.max(2, Math.floor(cellSize / 6));
    ctx.strokeStyle = '#1f2937'; ctx.lineWidth = borderW; ctx.lineCap = 'square';
    ctx.strokeRect(borderW / 2, borderW / 2, cols * cellSize - borderW, rows * cellSize - borderW);
    ctx.restore();
  },

  solveExtraData(data) { return { rows: data.rows, cols: data.cols, areas: data.areas, colClue: data.colClue, rowClue: data.rowClue, stitches: data.stitches }; },
  solutionFromResult(result) { return (result && result.horizontal && result.vertical) ? { horizontal: result.horizontal, vertical: result.vertical } : null; },
  solutionToCacheJson(solution) { return (solution && solution.horizontal) ? { horizontal: solution.horizontal.map((r) => r.slice()), vertical: solution.vertical.map((r) => r.slice()) } : null; },
  solutionFromCacheJson(parsed) { return (parsed && parsed.horizontal) ? { horizontal: parsed.horizontal.map((r) => r.slice()), vertical: parsed.vertical.map((r) => r.slice()) } : null; },

  hintStatusNodes(h, { bold }) {
    const n = (h.edges || []).length;
    if (!n) return ['No hint available'];
    return [bold(String(n)), n === 1 ? ' stitch can be deduced' : ' stitches can be deduced'];
  },

  async hintDispatch(ctx) {
    const { callMainWorld, solution, rows, cols, detectedGrid, grid } = ctx;
    if (solution && _stitchEdgeMismatch(grid, solution)) {
      return { success: false, error: 'Current game state is wrong.' };
    }
    if (detectedGrid && Array.isArray(detectedGrid.areas) && typeof detectedGrid.stitches === 'number') {
      try {
        const state = await callMainWorld('readStitchesState', [rows, cols]);
        if (state && state.horizontal && state.vertical) {
          const Solver = (typeof StitchesSolver !== 'undefined') ? StitchesSolver : require('../../solvers/stitches.js').StitchesSolver;
          const solver = new Solver({ rows, cols, areas: detectedGrid.areas, colClue: detectedGrid.colClue, rowClue: detectedGrid.rowClue, stitches: detectedGrid.stitches, maxMs: 1500 });
          const forced = solver._deduceForced(state.horizontal, state.vertical);
          if (forced && forced.length) {
            const batch = forced.slice(0, hintBatchCap(rows, cols)).map((f) => ({ orientation: f.type === 'horizontal' ? 'h' : 'v', r: f.r, c: f.c }));
            return { success: true, hint: { type: 'stitches', edges: batch, count: batch.length }, grid, solution };
          }
        }
      } catch { /* fall through */ }
    }
    if (!solution || !solution.horizontal) return { success: false, error: 'No solution available' };
    const cap = hintBatchCap(rows, cols); const edges = [];
    const bh = (grid && grid.horizontal) || [], bv = (grid && grid.vertical) || [];
    for (let r = 0; r < solution.horizontal.length && edges.length < cap; r++) for (let c = 0; c < solution.horizontal[r].length && edges.length < cap; c++) if (solution.horizontal[r][c] === 1 && (!bh[r] || bh[r][c] !== 1)) edges.push({ orientation: 'h', r, c });
    for (let r = 0; r < solution.vertical.length && edges.length < cap; r++) for (let c = 0; c < solution.vertical[r].length && edges.length < cap; c++) if (solution.vertical[r][c] === 1 && (!bv[r] || bv[r][c] !== 1)) edges.push({ orientation: 'v', r, c });
    if (!edges.length) return { success: false, error: 'No hint available' };
    return { success: true, hint: { type: 'stitches', edges, count: edges.length }, grid, solution };
  },

  async applyHint(hint, { callMainWorld, puzzleData }) {
    const rows = puzzleData ? puzzleData.rows : 0, cols = puzzleData ? puzzleData.cols : 0;
    const state = await callMainWorld('readStitchesState', [rows, cols]);
    const H = (state && state.horizontal) ? state.horizontal.map((r) => r.map((v) => (v === 1 ? 1 : 0))) : Array.from({ length: rows }, () => new Array(cols).fill(0));
    const V = (state && state.vertical) ? state.vertical.map((r) => r.map((v) => (v === 1 ? 1 : 0))) : Array.from({ length: rows }, () => new Array(cols).fill(0));
    for (const e of (hint.edges || [])) { if (e.orientation === 'h') { if (H[e.r]) H[e.r][e.c] = 1; } else { if (V[e.r]) V[e.r][e.c] = 1; } }
    const ok = await callMainWorld('applyStitchesState', [{ horizontal: H, vertical: V }]);
    return ok === true;
  },

  loopDoneCheck(ctx) {
    const { boardState, solution } = ctx;
    if (!solution || !solution.horizontal || !boardState || !boardState.horizontal) return false;
    const bh = boardState.horizontal, bv = boardState.vertical, sh = solution.horizontal, sv = solution.vertical;
    for (let r = 0; r < sh.length; r++) for (let c = 0; c < sh[r].length; c++) if (sh[r][c] === 1 && (!bh[r] || bh[r][c] !== 1)) return false;
    for (let r = 0; r < sv.length; r++) for (let c = 0; c < sv[r].length; c++) if (sv[r][c] === 1 && (!bv[r] || bv[r][c] !== 1)) return false;
    return true;
  },

  partialResultArm(result, { clearPendingHint, setStatus, drawPreview, setConfirming, setLoopConfirming, setSolveBtnText }) {
    setLoopConfirming(false); clearPendingHint(); setSolveBtnText('Confirm'); setConfirming(true);
    let n = 0; for (const row of (result.horizontal || [])) for (const v of row) if (v === 1) n++; for (const row of (result.vertical || [])) for (const v of row) if (v === 1) n++;
    setStatus(`Partial only: ${n} stitches deduced (too hard for a full solve). Apply, then finish manually.`, 'info');
    drawPreview({ horizontal: result.horizontal, vertical: result.vertical });
  },
};

function _stitchEdgeMismatch(grid, solution) {
  if (!grid || !grid.horizontal || !solution || !solution.horizontal) return false;
  const check = (b, s) => { for (let r = 0; r < s.length; r++) { const br = b[r] || [], sr = s[r] || []; for (let c = 0; c < sr.length; c++) if (br[c] === 1 && sr[c] !== 1) return true; } return false; };
  return check(grid.horizontal, solution.horizontal) || check(grid.vertical, solution.vertical);
}

function _stitchesSig(data) {
  if (!data) return '0';
  const grid = data.areas || [];
  const h = hashFNV1a((mix) => { mix((data.stitches | 0) + 1); for (const row of grid) for (const v of row) mix(((v | 0) + 1) & 0xff); for (const v of (data.colClue || [])) mix((v | 0) + 1); for (const v of (data.rowClue || [])) mix((v | 0) + 1); });
  return h.toString(16);
}

if (typeof module !== 'undefined' && module.exports) { module.exports = stitches; }
