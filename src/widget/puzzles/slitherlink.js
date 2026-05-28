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
//   canvasDims       — rows/cols come from puzzleData when present, with
//                      a fallback to grid.horizontal's dimensions (the
//                      H/V arrays imply them). Stage D Task 5.
//
// No drawPreviewCell hook: Slitherlink is edge-based and doesn't render
// per-cell. The inline `isSlitherlink` edge-rendering branch in
// renderPreview stays.
//
// === Encoding ===
//
// `/loop/*` has dedicated `SlitherlinkSolver` + `slitherlinkHandler`. Named
// "slitherlink" in code to avoid colliding with the Loop button; URL matcher
// keys on `/loop/`.
//
// Page encoding (edge-based, like Galaxies):
// - `task` — 2D `int[H][W]`: `-1`=no clue, `0/1/2/3`=clue.
// - `cellHorizontalStatus` — `(H+1) × W`: `0`=empty, `1`=line, **`2`=× ("not
//   loop edge")**.
// - `cellVerticalStatus` — `H × (W+1)`, same encoding.
//
// Internal edges: `0=UNKNOWN, 1=LINE, 2=EMPTY` (direct passthrough to page
// encoding). **× supported end-to-end** — read extracts page `2`s as EMPTY,
// `_emit` outputs `2`s, apply writes `2`s back, `drawPreview`'s slitherlink arm
// renders ×s in muted gray on the LINE layer. Don't reintroduce "ignore page
// `2`" — the solver gets meaningful signal from user-drawn ×s, and deduced ×s
// shrink the manual residue on hard boards.
//
// MAIN-world: `readSlitherlinkData/readSlitherlinkState/applySlitherlinkState`,
// twins of Galaxies but without flood-fill region-build (raw H/V only). Apply
// calls `saveState(true)` then falls through `drawCurrentState → render →
// redraw → draw`. Both read+apply preserve `0/1/2` encoding.
//
// === Diff, loop done-check, partial routing ===
//
// Diff is **edge-based** — `computePuzzleDiff('slitherlink', board, solution)`
// returns `[{orientation, r, c}, ...]`. Mismatch: `board[r][c] !== 0 &&
// board[r][c] !== solution[r][c]` — flags both wrong-LINEs and wrong-×s.
// UNKNOWN (`0`) never flagged. `drawPreview`'s mistake overlay and
// `applyHintHandler`/`applyAndRunLoop` branch on `puzzleData.type ===
// 'slitherlink'` for the edge shape. Loop done-check: "every solution LINE
// edge is also on the board" (Slitherlink never fills all cells).
//
// **Partial in content.js.** `solveHandler` routes `{partial: true, ...}` to
// `applyPartialResult` instead of `applySolveResult` — enters confirm mode
// with `"Partial only: N edges deduced..."` and deliberately does NOT call
// `recordSolveSuccess` (caching a partial in `puzzleData.solution` would
// mis-trigger Loop's done-check and the mistake overlay).
// `previewGridFromResult(result)` returns the right shape for both slitherlink
// (`{horizontal, vertical}`) and other types (`result.grid`).
//
// `puzzleData.solution` for slitherlink is `{horizontal, vertical}` (not 2D),
// so `getCachedGridSolution/cacheGridSolution` carry a slitherlink-specific
// shape branch. localStorage prefix `slitherlink-solution:`. `gridDataSig`
// early-bail hashes H+V directly; `staticSig` gains `|sl=`.
//
// Hint **skips the `await pendingAutoSolve` gate** for slitherlink — `getHint`
// propagates from live board, so on a hard 30×30 daily where autoSolve takes
// 30 s Hint still returns instantly. Other types still await (their hint
// heuristics consult cached solution).
//
// See `src/solvers/slitherlink.js` for the propagation fixpoint, CDCL search,
// lookahead/CDCL composition constraints, partial-result strategy, and the
// performance envelope.

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

  canvasDims(pd, { grid }) {
    return {
      rows: pd?.rows || (grid.horizontal ? grid.horizontal.length - 1 : 0),
      cols: pd?.cols || (grid.horizontal ? (grid.horizontal[0] || []).length : 0),
    };
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

  // Slitherlink's worker result has { solved, horizontal, vertical } instead
  // of { solved, grid }. recordSolveSuccess and previewGridFromResult both
  // delegate here to get the puzzleData.solution / preview shape. The fields
  // are passed through unconditionally — downstream consumers (loop done
  // check, mistake-diff, drawPreview's edge arm) use `?.` access and skip on
  // undefined, matching the pre-hook behavior.
  solutionFromResult(result) {
    return { horizontal: result?.horizontal, vertical: result?.vertical };
  },

  // Cache-shape hooks (Stage D Task 4). The cache.js dispatcher serializes
  // whatever this returns and stamps `savedAt` itself. Returning null skips
  // the write / treats the read as a miss. The read path defensively clones
  // rows so the caller can't mutate the parsed object back into the cache.
  solutionToCacheJson(solution) {
    if (!solution || !solution.horizontal || !solution.vertical) return null;
    return { horizontal: solution.horizontal, vertical: solution.vertical };
  },

  solutionFromCacheJson(parsed) {
    if (!parsed?.horizontal || !parsed?.vertical) return null;
    return {
      horizontal: parsed.horizontal.map(row => row.slice()),
      vertical: parsed.vertical.map(row => row.slice()),
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
    let decided = 0;
    let total = 0;
    for (const row of result.horizontal) {
      for (const v of row) {
        total++;
        if (v === 1) lines++;
        if (v !== 0) decided++;
      }
    }
    for (const row of result.vertical) {
      for (const v of row) {
        total++;
        if (v === 1) lines++;
        if (v !== 0) decided++;
      }
    }
    const pct = total > 0 ? Math.round(100 * decided / total) : 0;
    setStatus(
      `Partial only: ${lines} edges deduced (${pct}% of board, too hard for full solve). Apply, then finish manually.`,
      'info',
    );
    drawPreview({ horizontal: result.horizontal, vertical: result.vertical });
  },

  // Hint dispatch for Slitherlink. Re-reads raw H/V edge state from MAIN
  // world (the `grid` argument from readGridState is the flood-fill cell
  // grid, not the edge arrays the solver needs). Carries _curH/_curV on
  // the hint so applyHintHandler / loop can overlay without re-reading.
  // Mirrors the previous inline arm in content.js's getHint verbatim.
  async hintDispatch(ctx) {
    const { detectedGrid, grid, solution, rows, cols, callMainWorld } = ctx;
    const edgeState = await callMainWorld('readSlitherlinkState', [rows, cols]);
    const curH = edgeState?.horizontal
      || Array.from({ length: rows + 1 }, () => new Array(cols).fill(0));
    const curV = edgeState?.vertical
      || Array.from({ length: rows },     () => new Array(cols + 1).fill(0));
    const solver = new SlitherlinkSolver({
      width: cols, height: rows, task: detectedGrid.task,
      initialState: { horizontal: curH, vertical: curV },
    });
    solver.maxMs = 5000;
    const hint = solver.getHint(curH, curV);
    if (!hint) {
      return { success: false, error: 'No more edges can be deduced from the current state. Click Solve to finish.' };
    }
    hint._curH = curH;
    hint._curV = curV;
    return { success: true, hint, grid, solution };
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
