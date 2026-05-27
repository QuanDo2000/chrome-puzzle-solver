'use strict';

// Hashi puzzle module — Stage C migration.
//
// Hashi is the most cross-file shape-specific migration so far because its
// solution shape is `{ edges: [...] }` instead of a 2D grid. Several
// preview/widget branches key on that and stay inline (Stage D concerns):
//   * preview.js's dynamic-layer bridge-rendering block (isHashi arm) —
//     no per-cell hook makes sense for the edges shape.
//   * preview.js's geometry block at the top of renderPreview (rows/cols
//     come from puzzleData, not the grid).
//   * widget.js's recordSolveSuccess / previewGridFromResult shape arms —
//     the worker result has `{ edges }`, other puzzles have `{ grid }`.
//   * widget.js's hint apply path and post-loop endComplete ternary.
//
// Hooks consumed by the Stage-B dispatchers (cache.js, preview.js,
// widget.js, content.js):
//   cacheKey         — FNV-1a over (nameplate, rows, cols, sorted islands);
//                      'H' nameplate keeps keys disjoint from neighbouring
//                      puzzles.
//   staticSig        — contributes the island-set signature to the
//                      preview's static-layer cache key (`hi=…`).
//   drawStaticLayer  — paints the numbered island circles into the static
//                      layer by delegating to a module-local copy of
//                      preview.js's `drawHashiIslandsOn`.
//   hintStatusNodes  — describes a Hashi hint: either the named stepwise
//                      rule (.description) or a "draw a bridge between
//                      island A and island B" message.
//   solveExtraData   — extra payload for the solver worker: rows, cols,
//                      and the islands list.
//   loopDoneCheck    — defers to the bundle-scope `hashiDoneCheck`
//                      helper (kept in widget.js because the post-loop
//                      endComplete site and the in-loop done-check both
//                      call it).
//   partialResultArm — wraps `applyHashiPartialResult` (a closure-local in
//                      makeWidget, passed via ctx) so the Stage-B
//                      applyPartialResult dispatcher can route hashi's
//                      partial-solve timeouts into its dedicated UI.
//                      Hashi has its own partial-apply (NOT
//                      applyGridPartialResult) because the partial shape
//                      is `{ edges }`, not `{ grid }`.
//   skipAutoSolveGate — Hashi's hintDispatch reads bridge state from the
//                      live board via solver.getStepwiseHint; it doesn't
//                      need puzzleData.solution, so the Hint chain should
//                      not block on the background autoSolve.
//
// No drawPreviewCell hook: Hashi doesn't render anything per-cell — the
// bridges are drawn in the inline isHashi block in renderPreview (kept).

const hashi = {
  type: 'hashi',
  label: 'Hashi',
  url: 'https://www.puzzles-mobile.com/hashi/',
  solutionKeyPrefix: 'hashi-solution:',
  skipAutoSolveGate: true,
  hasAbsoluteHintCells: true,

  cacheKey(data) {
    if (data?.type !== 'hashi') return null;
    // FNV-1a over (nameplate, rows, cols, sorted islands flattened).
    let h = 0x811c9dc5;
    const mix = (n) => { h ^= n; h = Math.imul(h, 0x01000193) >>> 0; };
    mix(0x48); // 'H' nameplate so hashi keys can't collide with other types
    mix(data.rows | 0);
    mix(data.cols | 0);
    const islands = Array.isArray(data.islands) ? data.islands : [];
    mix(islands.length);
    const sorted = islands.slice().sort((a, b) =>
      a.row - b.row || a.col - b.col || a.number - b.number);
    for (const i of sorted) {
      mix(i.row | 0);
      mix(i.col | 0);
      mix(i.number | 0);
    }
    return 'hashi-solution:' + (h >>> 0).toString(16);
  },

  staticSig(data) {
    return 'hi=' + _hashiIslandsSig(data?.islands);
  },

  drawStaticLayer(ctx, { cellSize, pd }) {
    if (Array.isArray(pd?.islands)) _drawHashiIslandsOn(ctx, cellSize, pd.islands);
  },

  hintStatusNodes(h, { bold, puzzleData }) {
    // Hashi hints are an array of { a, b, orientation, bridges } edges; bridges
    // is the deduced count (1 or 2, or 0 for "this connection is impossible").
    // Stepwise hints carry a .description naming the rule that fired — show it
    // verbatim so the user sees the logical reason for the deduction.
    const total = h?.edges?.length || 0;
    if (total === 0) return ['No hint available'];
    if (h.description) {
      return [bold(h.description)];
    }
    const islands = puzzleData?.islands || [];
    const fmtIsland = (idx) => {
      const isl = islands[idx];
      if (!isl) return `island ${idx}`;
      return `(row ${isl.row + 1}, col ${isl.col + 1})`;
    };
    if (total === 1) {
      const e = h.edges[0];
      const bridgeWord = e.bridges === 1 ? 'single bridge'
        : e.bridges === 2 ? 'double bridge'
        : `${e.bridges} bridges`;
      return [
        'Draw a ', bold(bridgeWord),
        ' between ', bold(fmtIsland(e.a)),
        ' and ', bold(fmtIsland(e.b)), '.',
      ];
    }
    return [bold(String(total)), ' bridges can be deduced'];
  },

  solveExtraData(data) {
    return {
      rows: data.rows,
      cols: data.cols,
      islands: data.islands,
    };
  },

  // Hashi's worker result has { solved, edges } instead of { solved, grid }.
  // recordSolveSuccess and previewGridFromResult both delegate here to get
  // the puzzleData.solution / preview shape. Fields are passed through
  // unconditionally — downstream consumers (hashiDoneCheck, mistake-diff,
  // drawPreview's edges arm) use `?.` access and skip on undefined,
  // matching the pre-hook behavior.
  solutionFromResult(result) {
    return { solved: result?.solved, edges: result?.edges };
  },

  // Cache-shape hooks (Stage D Task 4). Only the edges list is persisted —
  // the `solved` flag from solutionFromResult is a runtime worker artifact
  // that doesn't need to be stored. solutionFromCacheJson defensively clones
  // each edge so a caller mutating one entry can't bleed back into the
  // cached array.
  solutionToCacheJson(solution) {
    if (!solution || !Array.isArray(solution.edges)) return null;
    return { edges: solution.edges };
  },

  solutionFromCacheJson(parsed) {
    if (!parsed || !Array.isArray(parsed.edges)) return null;
    return { edges: parsed.edges.map(e => ({ ...e })) };
  },

  loopDoneCheck({ boardState, solution }) {
    return hashiDoneCheck(boardState, solution);
  },

  partialResultArm(result, { applyHashiPartialResult }) {
    applyHashiPartialResult(result);
  },

  async applyHint(hint, { applyHashiHintEdges }) {
    const r = await applyHashiHintEdges(hint);
    return !!r?.success;
  },
};

// Local copy of preview.js's drawHashiIslandsOn — only used by
// drawStaticLayer above. Inlined here (matches heyawake's
// `_heyawakeAreasSig` pattern) so the module is self-contained.
function _drawHashiIslandsOn(ctx, cellSize, islands) {
  const radius = cellSize * 0.35;
  const fontSize = Math.max(8, Math.floor(cellSize * 0.5));
  ctx.save();
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const i of islands) {
    const cx = i.col * cellSize + cellSize / 2;
    const cy = i.row * cellSize + cellSize / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.strokeStyle = '#1f2937';
    ctx.lineWidth = Math.max(1.5, cellSize / 14);
    ctx.stroke();
    ctx.fillStyle = '#1f2937';
    ctx.fillText(String(i.number), cx, cy);
  }
  ctx.restore();
}

// Local copy of preview.js's hashiIslandsSig — only used by staticSig above.
function _hashiIslandsSig(islands) {
  if (!Array.isArray(islands) || islands.length === 0) return '0';
  let h = 0x811c9dc5;
  for (const i of islands) {
    h ^= (i.row | 0) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
    h ^= (i.col | 0) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
    h ^= (i.number | 0) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(36);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = hashi;
}
