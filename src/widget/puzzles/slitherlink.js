'use strict';

// Slitherlink puzzle module — Stage C migration.
//
// Slitherlink is one of the two most cross-file shape-specific migrations
// alongside Hashi. Its solution shape is `{ horizontal, vertical }` — two
// 2D edge arrays — instead of the cell grid every other puzzle uses. Many
// preview/widget sites stay inline (Stage D concerns) because no per-cell
// dispatcher applies to edge rendering:
//   * preview.js's `isSlitherlink` geometry block at the top of
//     renderPreview (rows/cols come from puzzleData or grid.horizontal).
//   * preview.js's edge-rendering arm (~lines 398-461) which draws LINE
//     edges + × marks on EMPTY edges.
//   * preview.js's hint-edges rendering arm (~line 601) which paints the
//     blue hint LINE overlay.
//   * preview.js's mistake-overlay edge branch (~line 791).
//   * widget.js's recordSolveSuccess shape arm (`solution = { horizontal,
//     vertical }`) and previewGridFromResult shape arm.
//   * widget.js's apply-pendingHint paths for slitherlink (via
//     callMainWorld('applySlitherlinkState', ...)).
//   * widget.js's post-loop endComplete edge-shape arm.
//   * widget.js's hint-loop multi-puzzle type check.
//   * content.js's detection-and-hint path for slitherlink (re-reads edge
//     state, instantiates SlitherlinkSolver, calls getHint).
//
// Hooks consumed by the Stage-B dispatchers (cache.js, preview.js,
// widget.js, content.js):
//   cacheKey         — FNV-1a over (nameplate, rows, cols, flattened task);
//                      'L' nameplate (Loop) keeps keys disjoint from
//                      neighbouring puzzles.
//   staticSig        — contributes the clue-set signature to the preview's
//                      static-layer cache key (`sl=…`).
//   drawStaticLayer  — paints the corner dots and the bold clue digits onto
//                      the static layer by inlining preview.js's
//                      slitherlink branch from buildStaticLayer.
//   hintStatusNodes  — describes a Slitherlink hint as the edge(s) to draw.
//   solveExtraData   — extra payload for the solver worker: rows, cols,
//                      and the task (2D clue array, -1=blank).
//   loopDoneCheck    — "every solution LINE edge is present on the board"
//                      via a fresh `readSlitherlinkState` call. Async (the
//                      MAIN-world read returns a promise).
//   partialResultArm — wraps the partial-result UI: status + drawPreview
//                      of the {horizontal, vertical} partial. Does NOT
//                      call recordSolveSuccess.
//   skipAutoSolveGate — Slitherlink's getHint propagates from the live
//                      board state without touching puzzleData.solution,
//                      so the Hint chain should not block on the
//                      background autoSolve (which can take 30 s on hard
//                      30×30 dailies while propagation returns in ~1 ms).
//
// No drawPreviewCell hook: Slitherlink is edge-based and doesn't render
// per-cell. The inline `isSlitherlink` edge-rendering branch in
// renderPreview stays.

const slitherlink = {
  type: 'slitherlink',
  label: 'Slitherlink',
  url: 'https://www.puzzles-mobile.com/loop/',
  solutionKeyPrefix: 'slitherlink-solution:',
  skipAutoSolveGate: true,
  hasAbsoluteHintCells: true,

  cacheKey(data) {
    if (data?.type !== 'slitherlink') return null;
    // FNV-1a over (nameplate, rows, cols, flattened task).
    let h = 0x811c9dc5;
    const mix = (n) => { h ^= n; h = Math.imul(h, 0x01000193) >>> 0; };
    mix(0x4C); // 'L' nameplate (Loop) so slitherlink keys don't collide
    mix(data.rows | 0);
    mix(data.cols | 0);
    const t = data.task || [];
    for (let r = 0; r < data.rows; r++) {
      const row = t[r] || [];
      for (let c = 0; c < data.cols; c++) mix((row[c] | 0) + 2);
    }
    return 'slitherlink-solution:' + (h >>> 0).toString(16);
  },

  staticSig(data) {
    return 'sl=' + _slitherlinkCluesSig(data?.type === 'slitherlink' ? data?.task : null);
  },

  drawStaticLayer(ctx, { rows, cols, cellSize, pd }) {
    const dotR = Math.max(1.5, cellSize / 14);
    ctx.fillStyle = '#1f2937';
    for (let r = 0; r <= rows; r++) {
      for (let c = 0; c <= cols; c++) {
        ctx.beginPath();
        ctx.arc(c * cellSize, r * cellSize, dotR, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    const fontPx = Math.max(8, Math.floor(cellSize * 0.55));
    ctx.font = `bold ${fontPx}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#1f2937';
    const task = pd.task || [];
    for (let r = 0; r < rows; r++) {
      const row = task[r] || [];
      for (let c = 0; c < cols; c++) {
        const v = row[c];
        if (v === 0 || v === 1 || v === 2 || v === 3) {
          ctx.fillText(String(v), c * cellSize + cellSize / 2, r * cellSize + cellSize / 2);
        }
      }
    }
  },

  hintStatusNodes(h, { bold }) {
    const total = h?.edges?.length || 0;
    if (total === 0) return ['No hint available'];
    if (total === 1) {
      const e = h.edges[0];
      const desc = e.orientation === 'h'
        ? `the top of cell (row ${e.r + 1}, col ${e.c + 1}) / bottom of (row ${e.r}, col ${e.c + 1})`
        : `the left of cell (row ${e.r + 1}, col ${e.c + 1}) / right of (row ${e.r + 1}, col ${e.c})`;
      return ['Draw a line along ', bold(desc), '.'];
    }
    return [bold(String(total)), ' edges can be deduced'];
  },

  solveExtraData(data) {
    return {
      rows: data.rows,
      cols: data.cols,
      task: data.task,
    };
  },

  async loopDoneCheck({ solution, puzzleData }) {
    if (!solution?.horizontal || !solution?.vertical) return false;
    const edgeState = await callMainWorld('readSlitherlinkState', [puzzleData.rows, puzzleData.cols]);
    const bh = edgeState?.horizontal || [];
    const bv = edgeState?.vertical || [];
    for (let r = 0; r < solution.horizontal.length; r++) {
      for (let c = 0; c < (solution.horizontal[r]?.length || 0); c++) {
        if (solution.horizontal[r][c] === 1 && bh[r]?.[c] !== 1) return false;
      }
    }
    for (let r = 0; r < solution.vertical.length; r++) {
      for (let c = 0; c < (solution.vertical[r]?.length || 0); c++) {
        if (solution.vertical[r][c] === 1 && bv[r]?.[c] !== 1) return false;
      }
    }
    return true;
  },

  async applyHint(hint, { callMainWorld, puzzleData }) {
    // Read the current edge state, overlay the hint's LINE edges, apply.
    const cur = await callMainWorld('readSlitherlinkState', [puzzleData.rows, puzzleData.cols]);
    const horizontal = (cur?.horizontal || Array.from({ length: puzzleData.rows + 1 },
      () => new Array(puzzleData.cols).fill(0))).map(row => row.slice());
    const vertical   = (cur?.vertical   || Array.from({ length: puzzleData.rows },
      () => new Array(puzzleData.cols + 1).fill(0))).map(row => row.slice());
    for (const e of (hint.edges || [])) {
      if (e.orientation === 'h' && horizontal[e.r]) horizontal[e.r][e.c] = 1;
      else if (e.orientation === 'v' && vertical[e.r]) vertical[e.r][e.c] = 1;
    }
    return !!(await callMainWorld('applySlitherlinkState', [{ horizontal, vertical }]));
  },

  partialResultArm(result, {
    clearPendingHint, setStatus, drawPreview,
    setConfirming, setLoopConfirming, setSolveBtnText,
  }) {
    setLoopConfirming(false);
    clearPendingHint();
    setSolveBtnText('Confirm');
    setConfirming(true);
    let lines = 0;
    for (const row of result.horizontal) for (const v of row) if (v === 1) lines++;
    for (const row of result.vertical)   for (const v of row) if (v === 1) lines++;
    setStatus(
      `Partial only: ${lines} edges deduced (board too hard for full solve). Apply, then finish manually.`,
      'info',
    );
    drawPreview({ horizontal: result.horizontal, vertical: result.vertical });
  },
};

// Local copy of preview.js's slitherlinkCluesSig — only used by staticSig
// above. Inlined here (matches the heyawake/shikaku pattern) so the module
// is self-contained.
function _slitherlinkCluesSig(task) {
  if (!Array.isArray(task)) return '';
  let h = 0x811c9dc5;
  for (let r = 0; r < task.length; r++) {
    const row = task[r] || [];
    for (let c = 0; c < row.length; c++) {
      h ^= (row[c] | 0) + 2;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return (h >>> 0).toString(16);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = slitherlink;
}
