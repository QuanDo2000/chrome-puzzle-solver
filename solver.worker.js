// Dedicated Worker that owns puzzle solving. Loaded via chrome.runtime.getURL
// from content.js. Receives { id, type, rowClues, colClues, initialGrid, extraData }
// and posts back { id, result }.
importScripts('solver.js');

self.onmessage = function (e) {
  const { id, type, rowClues, colClues, initialGrid, extraData } = e.data || {};
  let result;
  try {
    if (type === 'galaxies' && extraData) {
      const s = new GalaxiesSolver(extraData.stars, extraData.rows, extraData.cols);
      result = s.solve(extraData.partialGrid || null, {
        forbiddenPartials: extraData.failedPartials || [],
        frontierGrids: extraData.frontierGrids || [],
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
    } else {
      const s = new NonogramSolver(rowClues, colClues);
      result = s.solve(initialGrid || null);
    }
  } catch (err) {
    result = { solved: false, grid: null, error: err && err.message ? err.message : String(err) };
  }
  self.postMessage({ id, result });
};
