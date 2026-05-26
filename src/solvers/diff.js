'use strict';

function computePuzzleDiff(type, grid, solution, stars) {
  const out = [];
  if (type === 'slitherlink') return _slitherlinkDiff(grid, solution);
  if (type === 'hashi') {
    // Hashi grids are {islands, edges}, not the 2D / H+V shapes the public
    // signature advertises for the other puzzle types. Cast locally so the
    // rest of this block can read .edges without tsc complaining.
    const board = /** @type {any} */ (grid);
    const sol = /** @type {any} */ (solution);
    const diff = [];
    const boardMap = new Map();
    for (const e of (board.edges || [])) {
      const a = Math.min(e.a, e.b), b = Math.max(e.a, e.b);
      boardMap.set(`${a}-${b}`, e.bridges);
    }
    for (const e of (sol.edges || [])) {
      const a = Math.min(e.a, e.b), b = Math.max(e.a, e.b);
      const actual = boardMap.get(`${a}-${b}`);
      if (actual === undefined || actual === 0) continue;
      if (actual !== e.bridges) {
        diff.push({ a, b, orientation: e.orientation, expected: e.bridges, actual });
      }
    }
    // Also flag bridges drawn that shouldn't exist (solution=0 or missing).
    const solMap = new Map();
    for (const e of (sol.edges || [])) {
      const a = Math.min(e.a, e.b), b = Math.max(e.a, e.b);
      solMap.set(`${a}-${b}`, e.bridges);
    }
    for (const e of (board.edges || [])) {
      if (e.bridges === 0) continue;
      const a = Math.min(e.a, e.b), b = Math.max(e.a, e.b);
      const key = `${a}-${b}`;
      const expected = solMap.get(key) || 0;
      if (expected === 0) {
        diff.push({ a, b, orientation: e.orientation, expected: 0, actual: e.bridges });
      }
    }
    return diff;
  }
  if (!Array.isArray(grid) || !Array.isArray(solution)) return out;
  if (type === 'shikaku') return _shikakuDiff(grid, solution);
  if (type === 'galaxies') return _galaxiesDiff(grid, solution, stars);
  // Heyawake / Hitori: a cell is a mistake when the player has placed something
  // there (its value is not 0 = "not yet placed") and that value differs from the solution.
  if (type === 'heyawake' || type === 'hitori' || type === 'kakurasu' || type === 'kurodoko' || type === 'mosaic' || type === 'norinori' || type === 'nurikabe') {
    const rows = Math.min(grid.length, solution.length);
    for (let r = 0; r < rows; r++) {
      const gRow = grid[r] || [], sRow = solution[r] || [];
      const cols = Math.min(gRow.length, sRow.length);
      for (let c = 0; c < cols; c++) {
        const g = gRow[c], s = sRow[c];
        if (g !== 0 && g !== undefined && g !== s) {
          out.push({ row: r, col: c, expected: s, actual: g });
        }
      }
    }
    return out;
  }
  // Nonogram, Aquarium, Binairo, Yin-Yang: a cell is a mistake when the
  // player has placed something there (its value is not 0 = "not yet
  // placed") and that value differs from the solution.
  const rows = Math.min(grid.length, solution.length);
  for (let r = 0; r < rows; r++) {
    const gRow = grid[r] || [], sRow = solution[r] || [];
    const cols = Math.min(gRow.length, sRow.length);
    for (let c = 0; c < cols; c++) {
      const g = gRow[c];
      if (g !== 0 && g !== undefined && g !== sRow[c]) {
        out.push({ row: r, col: c });
      }
    }
  }
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { computePuzzleDiff };
}
