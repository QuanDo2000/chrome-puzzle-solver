'use strict';

// Aquarium puzzle module — Stage C migration.
//
// Smallest migration so far: Aquarium uses the default cell-state
// rendering (v=1 → solid dark fill via preview.js's default arm) and
// the shared `drawRegionBordersOn` scaffolding (drawn unconditionally
// for any puzzleData carrying a `regionMap`). It also falls through
// to the generic chunk-style `hintStatusNodes` in setHintStatus,
// which already handles aquarium's row/col + extraCells shape.
//
// Hooks consumed by the Stage-B dispatchers (cache.js, content.js):
//   cacheKey         — verbatim copy of the legacy aquariumCacheKey
//                      (rows × cols × rowClues × colClues × regionMap).
//                      Stays a string-concat key (not FNV-1a) because
//                      the legacy `puzzlePartialKey` arm in cache.js
//                      still mirrors the same shape — keeping both
//                      consistent until Stage D collapses them.
//   solveExtraData   — extra payload for the solver worker: row/col
//                      clues, regionMap, and dimensions.
//
// No staticSig / drawStaticLayer / drawPreviewCell / hintStatusNodes /
// partialResultArm / skipAutoSolveGate hooks — Aquarium is the
// minimum-footprint migration because every dispatcher's default
// branch already does the right thing for it.

const aquarium = {
  type: 'aquarium',
  label: 'Aquarium',
  url: 'https://www.puzzles-mobile.com/aquarium/',
  solutionKeyPrefix: 'aquarium-solution:',

  cacheKey(data) {
    if (!data || data.type !== 'aquarium') return null;
    const r = (data.rowClues || []).join(',');
    const c = (data.colClues || []).join(',');
    const m = (data.regionMap || []).map(row => row.join('-')).join(';');
    return 'aquarium-solution:' + data.rows + 'x' + data.cols + ':' + r + ':' + c + ':' + m;
  },

  solveExtraData(data) {
    return {
      rowCluesFlat: data.rowClues, colCluesFlat: data.colClues,
      regionMap: data.regionMap, rows: data.rows, cols: data.cols,
    };
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = aquarium;
}
