// Dedicated Worker that owns puzzle solving. Loaded via chrome.runtime.getURL
// from content.js. Receives { id, type, rowClues, colClues, initialGrid, extraData }
// and posts back { id, result }.
importScripts('solver.js');
/* global NonogramSolver, GalaxiesSolver, AquariumSolver, BinairoSolver, ShikakuSolver, YinYangSolver, SlitherlinkSolver */

self.onmessage = function (e) {
  const { id, type, rowClues, colClues, initialGrid, extraData } = e.data || {};
  // Without a real integer id the response can't be correlated back to a
  // pending awaiter on the content-script side (solverPending.get on null /
  // NaN / undefined returns nothing), so the originating promise would hang
  // forever. Reply on a synthetic id so any debug listener can see it, but
  // don't pretend to dispatch. (typeof NaN === 'number' so the prior check
  // would have let NaN through.)
  if (!Number.isInteger(id)) {
    self.postMessage({
      id: null,
      result: { solved: false, grid: null, error: 'worker received message without id' },
    });
    return;
  }
  let result;
  try {
    if (type === 'galaxies' && extraData) {
      const s = new GalaxiesSolver(extraData.stars, extraData.rows, extraData.cols);
      result = s.solve(extraData.partialGrid || null, {
        forbiddenPartials: extraData.failedPartials || [],
      });
    } else if (type === 'aquarium' && extraData) {
      const s = new AquariumSolver(
        extraData.rowCluesFlat || rowClues,
        extraData.colCluesFlat || colClues,
        extraData.regionMap,
        extraData.rows,
        extraData.cols
      );
      result = s.solve(initialGrid || null);
    } else if (type === 'binairo' && extraData) {
      const s = new BinairoSolver({
        rows: extraData.rows,
        cols: extraData.cols,
        givens: extraData.givens,
        comparisonClues: extraData.comparisonClues || [],
        initialState: initialGrid || null,
      });
      result = s.solve();
    } else if (type === 'shikaku' && extraData) {
      const s = new ShikakuSolver({
        rows: extraData.rows,
        cols: extraData.cols,
        clues: extraData.clues,
        initialState: initialGrid || null,
      });
      result = s.solve();
    } else if (type === 'yinyang' && extraData) {
      const s = new YinYangSolver({
        rows: extraData.rows,
        cols: extraData.cols,
        task: extraData.task,
        initialState: initialGrid || null,
      });
      s.maxMs = 30000;
      result = s.solve();
    } else if (type === 'slitherlink' && extraData) {
      const s = new SlitherlinkSolver({
        width: extraData.cols,
        height: extraData.rows,
        task: extraData.task,
        initialState: extraData.initialGrid || null,
      });
      // 10 s instead of 30 s: propagate + lookahead caps at ~3 s on a 50×40,
      // and our backtracking past that point is rarely productive on hard
      // boards. solve() now returns the propagation snapshot as a partial
      // on timeout, so capping shorter just makes the wait reasonable —
      // user gets the deducible portion sooner instead of waiting 30 s.
      s.maxMs = 10000;
      result = s.solve();
    } else {
      const s = new NonogramSolver(rowClues, colClues);
      result = s.solve(initialGrid || null);
    }
  } catch (err) {
    // Preserve stack so content.js can console.error it. Plain Error objects
    // don't survive structured cloning intact; copy the fields we need.
    result = {
      solved: false,
      grid: null,
      error: (err && err.message) ? err.message : String(err),
      stack: err && err.stack ? String(err.stack) : undefined,
      errorName: err && err.name ? err.name : undefined,
    };
  }
  self.postMessage({ id, result });
};
