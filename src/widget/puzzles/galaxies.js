'use strict';

// Galaxies puzzle module — Stage C migration.
//
// Galaxies has the largest inline footprint of any puzzle type
// (region/line preview rendering, hint line-drawing overlay, multiple
// loop/error/cache touchpoints in widget.js) but the smallest
// Stage-B-dispatched footprint. Only four hooks really apply; the rest
// of the per-puzzle behaviour stays inline in preview.js / widget.js /
// content.js because it depends on closures or shapes that the current
// generic dispatchers don't model:
//   * preview.js's `galaxiesColors` palette is also used by Shikaku's
//     cell-render arm and by the hint band/cell paint loop; it stays
//     defined inline.
//   * preview.js's `puzzleData?.type === 'galaxies' && v > 0` cell-render
//     arm depends on the `v > 0` (owner-index) semantics that the generic
//     `drawPreviewCell` dispatcher (cell-state encoded, v ∈ {-1, 0, 1})
//     doesn't model. Keep inline.
//   * preview.js's post-cell-loop galaxies line-rendering arm draws
//     between-region borders directly onto the dynamic layer (not the
//     static layer) because it depends on `grid.galaxies` which changes
//     across hints. Keep inline.
//   * preview.js's `hint.type === 'galaxies'` line-overlay arm (the blue
//     hint highlight) renders to the dynamic layer post-cell-loop, same
//     reason. Keep inline.
//   * preview.js's `|st=` staticSig segment is emitted UNCONDITIONALLY
//     for any puzzleData carrying a `stars` field (treats it as a
//     generic optional field), so Galaxies doesn't need a per-puzzle
//     staticSig hook.
//   * widget.js's setHintStatus dispatch falls through to the
//     `h.type === 'galaxies'` arm (via the `galaxiesHintLineDesc`
//     helper, kept in widget.js as a bundle-scope helper). The
//     hintStatusNodes hook below references it the same way.
//   * widget.js's loop-break check (`if (puzzleData.type !== 'galaxies'
//     && gsComplete) break`) explicitly excludes galaxies — galaxies
//     never breaks via the cell-grid done-check because the underlying
//     game state is line-based, not cell-based. Stays inline.
//   * widget.js's pendingHint apply path dispatches galaxies hints to
//     `applySolution({ type: 'galaxies-lines', lines: ... })` (not via
//     `applyHintCells` like the cell-state puzzles); stays inline.
//   * widget.js's hint cache-load + autoSolve paths key on
//     `puzzleData.type === 'galaxies'` to use the shape-specific
//     `getCachedGalaxiesSolution` rather than `getCachedGridSolution`
//     (parallel keys in localStorage, different value shape). Stays
//     inline.
//   * widget.js's "search limit exceeded" and "partial state exhausted"
//     error-message arms have galaxies-specific copy. Stays inline.
//   * content.js's `getHint` galaxies branch (the per-galaxy fallback
//     path) lives at the heart of the Hint chain. Stays inline.
//
// Hooks consumed by the Stage-B dispatchers (cache.js, preview.js,
// widget.js, content.js):
//   cacheKey         — wraps `galaxiesCacheKey(data)` as a bundle-scope
//                      global call. The function is also used by
//                      `galaxiesPartialKey`, `galaxiesFailedKey`,
//                      `getCachedGalaxiesSolution`, and
//                      `cacheGalaxiesSolution` inside cache.js, so it
//                      stays exported from cache.js. The hook just
//                      reuses it as the shared dispatch entry.
//   drawStaticLayer  — paints the star markers (the per-puzzle
//                      "galaxies" centres) onto the static layer.
//                      Inlined from preview.js's galaxies branch in
//                      buildStaticLayer.
//   hintStatusNodes  — describes a Galaxies hint as the boundary line
//                      to draw, via the bundle-scope
//                      `galaxiesHintLineDesc` helper in widget.js.
//   solveExtraData   — extra payload for the solver worker: stars,
//                      dimensions, and the cached partial + failed-
//                      partial state from cache.js.
//
// No staticSig hook: `|st=` is emitted unconditionally by renderPreview
// for any puzzleData with a `stars` field, so no per-puzzle contribution
// is needed.
//
// No drawPreviewCell hook: the galaxies cell-render arm depends on the
// `galaxiesColors` palette (defined inline in preview.js's renderPreview
// because Shikaku also uses it) and on `v > 0` (owner-index) semantics
// that the generic v ∈ {-1, 0, 1} dispatcher doesn't model.
//
// No loopDoneCheck hook: galaxies never breaks via gsComplete (line 827
// in widget.js explicitly excludes galaxies from the break condition).
//
// No partialResultArm hook: galaxies isn't in the partial-result chain
// (its solver doesn't emit `{partial: true, ...}` shapes; partial state
// for galaxies is handled separately via `cacheFailedGalaxiesPartial`
// at the solver-error layer).
//
// No skipAutoSolveGate flag: galaxies' getHint awaits the cached
// solution like the rest of the cell-state puzzles.

const galaxies = {
  type: 'galaxies',
  label: 'Galaxies',
  url: 'https://www.puzzles-mobile.com/galaxies/',
  hasAbsoluteHintCells: true,
  solutionKeyPrefix: 'galaxies-solution:',

  cacheKey(data) {
    return galaxiesCacheKey(data);
  },

  drawStaticLayer(ctx, { rows: _rows, cols: _cols, cellSize, pd }) {
    if (pd?.type === 'galaxies' && pd.stars) {
      ctx.fillStyle = '#111827';
      for (const star of pd.stars) {
        const cx = ((star.col + 1) / 2) * cellSize;
        const cy = ((star.row + 1) / 2) * cellSize;
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(3, cellSize / 7), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  },

  hintStatusNodes(hint, { bold }) {
    return ['Draw the ', bold(galaxiesHintLineDesc(hint)), '.'];
  },

  solveExtraData(data) {
    return {
      stars: data.stars,
      rows: data.rows,
      cols: data.cols,
      partialGrid: getCachedGalaxiesPartial(data),
      failedPartials: getFailedGalaxiesPartials(data),
    };
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = galaxies;
}
