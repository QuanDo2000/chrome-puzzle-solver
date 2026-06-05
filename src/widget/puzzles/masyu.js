'use strict';

const { hashFNV1a } = require('../shared.js');

// Masyu widget module — detect / solve / hint / loop / preview hooks.
//
// EDGE MODEL: a single closed loop through CELL CENTRES. The solver returns
// { horizontal, vertical } edge tri-state arrays (0 unknown, 1 line, 2 cross) with
// Masyu dims (horizontal rows x (cols-1), vertical (rows-1) x cols). solutionFromResult
// returns { horizontal, vertical } so the preview edge renderer, the generic edge-diff,
// and the cache all share the loop shape. drawStaticLayer renders the white/black pearls
// at cell centres; preview.js draws the loop edges between centres (its Masyu arm).
//
// HINT (deductive): hintDispatch reads the live edge state, runs MasyuSolver._deduceForced
// to get the next batch of forced LINE edges, batch-caps them, and falls back to revealing
// the next batch of cached-solution line-edges. applyHint overlays ONLY the hint line-edges.

function hintBatchCap(rows, cols) { return Math.max(6, Math.ceil((rows * cols) / 30)); }

const masyu = {
  type: 'masyu',
  label: 'Masyu',
  url: 'https://www.puzzles-mobile.com/masyu/',
  solutionKeyPrefix: 'masyu-solution:',
  // Hints carry edges (not cells); set so the Loop driver's cells-length guard
  // (widget.js) doesn't break the loop immediately — same as shingoki/slitherlink.
  hasAbsoluteHintCells: true,

  cacheKey(data) {
    if (!data || data.type !== 'masyu' || !data.task) return null;
    // FNV-1a over (nameplate, rows, cols, flattened task). 'M'=0x4D nameplate;
    // map "W"->1, "B"->2, empty->0 for hashing.
    const h = hashFNV1a((mix) => {
      mix(0x4D); mix(data.rows | 0); mix(data.cols | 0);
      const task = data.task || [];
      for (let r = 0; r < task.length; r++) { const row = task[r] || []; for (let c = 0; c < row.length; c++) mix(row[c] === 'W' ? 1 : row[c] === 'B' ? 2 : 0); }
    });
    return 'masyu-solution:' + h.toString(16);
  },

  staticSig(data) { return 'ma=' + _masyuTaskSig(data?.type === 'masyu' ? data?.task : null); },

  canvasDims(pd, { grid }) {
    return {
      rows: pd?.rows || (Array.isArray(grid && grid.horizontal) ? grid.horizontal.length : 0),
      cols: pd?.cols || (Array.isArray(grid && grid.vertical) && grid.vertical[0] ? grid.vertical[0].length : 0),
      marginCells: 0,
    };
  },

  // Static layer: white pearls (ring) and black pearls (disc) at cell centres + border.
  drawStaticLayer(ctx, { rows, cols, cellSize, pd }) {
    const task = (pd && pd.task) || [];
    ctx.save();
    const rad = Math.max(3, Math.floor(cellSize / 3));
    for (let r = 0; r < rows; r++) {
      const row = task[r] || [];
      for (let c = 0; c < cols; c++) {
        const v = row[c];
        if (v !== 'W' && v !== 'B') continue;
        const cx = (c + 0.5) * cellSize, cy = (r + 0.5) * cellSize;
        ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2);
        if (v === 'B') { ctx.fillStyle = '#1f2937'; ctx.fill(); }
        else { ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.lineWidth = Math.max(1.5, cellSize / 12); ctx.strokeStyle = '#1f2937'; ctx.stroke(); }
      }
    }
    const borderW = Math.max(2, Math.floor(cellSize / 5));
    ctx.strokeStyle = '#1f2937'; ctx.lineWidth = borderW; ctx.lineCap = 'square';
    ctx.strokeRect(borderW / 2, borderW / 2, cols * cellSize - borderW, rows * cellSize - borderW);
    ctx.restore();
  },

  solveExtraData(data) { return { rows: data.rows, cols: data.cols, task: data.task }; },
  solutionFromResult(result) { return (result && result.horizontal && result.vertical) ? { horizontal: result.horizontal, vertical: result.vertical } : null; },
  solutionToCacheJson(solution) { return (solution && solution.horizontal) ? { horizontal: solution.horizontal.map(r => r.slice()), vertical: solution.vertical.map(r => r.slice()) } : null; },
  solutionFromCacheJson(parsed) { return (parsed && parsed.horizontal) ? { horizontal: parsed.horizontal.map(r => r.slice()), vertical: parsed.vertical.map(r => r.slice()) } : null; },

  hintStatusNodes(h, { bold }) {
    const n = (h.edges || []).length;
    if (!n) return ['No hint available'];
    return [bold(String(n)), n === 1 ? ' loop edge can be deduced' : ' loop edges can be deduced'];
  },

  // Deductive hint. ctx: { callMainWorld, solution, rows, cols, detectedGrid, grid, firstMismatch }.
  async hintDispatch(ctx) {
    const { callMainWorld, solution, rows, cols, detectedGrid, grid } = ctx;
    const task = detectedGrid && detectedGrid.task;
    // Wrong-state guard. NOTE: the generic firstMismatch helper only handles 2-D cell
    // grids; Masyu's grid/solution are { horizontal, vertical } edge objects, so we
    // compare edges directly (a committed line where the solution has none, or a cross
    // where it has a line, means the player has erred — a deductive hint would build on it).
    if (solution && _masyuEdgeMismatch(grid, solution)) {
      return { success: false, error: 'Current game state is wrong.' };
    }
    // 1) Deductive: forced line-edges from the live board.
    if (task) {
      try {
        const state = await callMainWorld('readMasyuState', [rows, cols]);
        if (state && state.horizontal && state.vertical) {
          const Solver = (typeof MasyuSolver !== 'undefined') ? MasyuSolver : require('../../solvers/masyu.js').MasyuSolver;
          const solver = new Solver({ task, rows, cols, maxMs: 1500 });
          const forced = solver._deduceForced(state.horizontal, state.vertical);
          if (forced && forced.length) {
            const batch = forced.slice(0, hintBatchCap(rows, cols)).map(f => ({ orientation: f.type, r: f.r, c: f.c }));
            return { success: true, hint: { type: 'masyu', edges: batch, count: batch.length }, grid, solution };
          }
        }
      } catch { /* fall through */ }
    }
    // 2) Fallback: reveal next batch of cached-solution line-edges not yet on the board.
    if (!solution || !solution.horizontal) return { success: false, error: 'No solution available' };
    const cap = hintBatchCap(rows, cols); const edges = [];
    const bh = (grid && grid.horizontal) || [], bv = (grid && grid.vertical) || [];
    for (let r = 0; r < solution.horizontal.length && edges.length < cap; r++) for (let c = 0; c < solution.horizontal[r].length && edges.length < cap; c++) if (solution.horizontal[r][c] === 1 && (!bh[r] || bh[r][c] !== 1)) edges.push({ orientation: 'h', r, c });
    for (let r = 0; r < solution.vertical.length && edges.length < cap; r++) for (let c = 0; c < solution.vertical[r].length && edges.length < cap; c++) if (solution.vertical[r][c] === 1 && (!bv[r] || bv[r][c] !== 1)) edges.push({ orientation: 'v', r, c });
    if (!edges.length) return { success: false, error: 'No hint available' };
    return { success: true, hint: { type: 'masyu', edges, count: edges.length }, grid, solution };
  },

  // Apply hint: overlay ONLY the hint line-edges onto the live board (set to 1), leaving
  // everything else untouched. Reads current state, writes line edges, writes back.
  async applyHint(hint, { callMainWorld, puzzleData }) {
    const rows = puzzleData ? puzzleData.rows : 0, cols = puzzleData ? puzzleData.cols : 0;
    const state = await callMainWorld('readMasyuState', [rows, cols]);
    const H = (state && state.horizontal) ? state.horizontal.map(r => r.slice()) : Array.from({ length: rows }, () => new Array(cols - 1).fill(0));
    const V = (state && state.vertical) ? state.vertical.map(r => r.slice()) : Array.from({ length: rows - 1 }, () => new Array(cols).fill(0));
    for (const e of (hint.edges || [])) { if (e.orientation === 'h') { if (H[e.r]) H[e.r][e.c] = 1; } else { if (V[e.r]) V[e.r][e.c] = 1; } }
    const ok = await callMainWorld('applyMasyuState', [{ horizontal: H, vertical: V }]);
    return ok === true;
  },

  // Done when every solution LINE edge is on the board.
  loopDoneCheck(ctx) {
    const { boardState, solution } = ctx;
    if (!solution || !solution.horizontal || !boardState || !boardState.horizontal) return false;
    const bh = boardState.horizontal, bv = boardState.vertical, sh = solution.horizontal, sv = solution.vertical;
    for (let r = 0; r < sh.length; r++) for (let c = 0; c < sh[r].length; c++) if (sh[r][c] === 1 && (!bh[r] || bh[r][c] !== 1)) return false;
    for (let r = 0; r < sv.length; r++) for (let c = 0; c < sv[r].length; c++) if (sv[r][c] === 1 && (!bv[r] || bv[r][c] !== 1)) return false;
    return true;
  },

  // Partial-Solve UI: solver timed out and returned { partial:true, horizontal, vertical }
  // (the sound root-deduction snapshot). Show it + finish-manually status. Does NOT call
  // recordSolveSuccess (a partial is a subset of the real loop).
  partialResultArm(result, { clearPendingHint, setStatus, drawPreview, setConfirming, setLoopConfirming, setSolveBtnText }) {
    setLoopConfirming(false); clearPendingHint(); setSolveBtnText('Confirm'); setConfirming(true);
    let lines = 0; for (const row of (result.horizontal || [])) for (const v of row) if (v === 1) lines++; for (const row of (result.vertical || [])) for (const v of row) if (v === 1) lines++;
    setStatus(`Partial only: ${lines} loop edges deduced (too hard for a full solve). Apply, then finish manually.`, 'info');
    drawPreview({ horizontal: result.horizontal, vertical: result.vertical });
  },
};

// True if the live board has a committed edge that contradicts the solution:
// a line where the solution has none, or a cross where the solution has a line.
function _masyuEdgeMismatch(grid, solution) {
  if (!grid || !grid.horizontal || !grid.vertical || !solution || !solution.horizontal) return false;
  const check = (b, s) => {
    for (let r = 0; r < s.length; r++) {
      const br = b[r] || [], sr = s[r] || [];
      for (let c = 0; c < sr.length; c++) { if (br[c] === 1 && sr[c] !== 1) return true; if (br[c] === 2 && sr[c] === 1) return true; }
    }
    return false;
  };
  return check(grid.horizontal, solution.horizontal) || check(grid.vertical, solution.vertical);
}

function _masyuTaskSig(task) {
  if (!Array.isArray(task)) return '0';
  const h = hashFNV1a((mix) => { for (const row of task) for (const v of row) mix(v === 'W' ? 1 : v === 'B' ? 2 : 0); });
  return h.toString(16);
}

if (typeof module !== 'undefined' && module.exports) { module.exports = masyu; }
