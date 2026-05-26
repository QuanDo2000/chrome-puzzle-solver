'use strict';

// Bounding box of every distinct owner value on a board (skipping `empty`).
// Returns a Map: ownerValue -> { r1, c1, r2, c2 }.
function _ownerBoxes(board, rows, cols, empty) {
  const m = new Map();
  for (let r = 0; r < rows; r++) {
    const row = board[r] || [];
    for (let c = 0; c < cols; c++) {
      const v = row[c];
      if (v === empty || v === undefined) continue;
      const b = m.get(v);
      if (!b) {
        m.set(v, { r1: r, c1: c, r2: r, c2: c });
      } else {
        if (r < b.r1) b.r1 = r;
        if (r > b.r2) b.r2 = r;
        if (c < b.c1) b.c1 = c;
        if (c > b.c2) b.c2 = c;
      }
    }
  }
  return m;
}

// Shikaku diff: owner ids differ between the page board and the solver
// solution, so compare rectangle GEOMETRY — a placed cell is a mistake when
// its owner's bounding box does not match the solution rectangle covering it.
function _shikakuDiff(grid, solution) {
  const out = [];
  const rows = Math.min(grid.length, solution.length);
  if (rows === 0) return out;
  const cols = Math.min((grid[0] || []).length, (solution[0] || []).length);
  const gBox = _ownerBoxes(grid, rows, cols, -1);
  const sBox = _ownerBoxes(solution, rows, cols, -1);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const gv = grid[r][c];
      if (gv === -1 || gv === undefined) continue; // unassigned — not a mistake
      const gb = gBox.get(gv);
      const sb = sBox.get(solution[r][c]);
      if (!gb || !sb ||
          gb.r1 !== sb.r1 || gb.c1 !== sb.c1 ||
          gb.r2 !== sb.r2 || gb.c2 !== sb.c2) {
        out.push({ row: r, col: c });
      }
    }
  }
  return out;
}

// Galaxies diff: region ids are numbered differently by the solver (star
// order) and the page (flood-fill order), so map both to star indices and
// compare. The page flood-fills the WHOLE grid into regions — there is no
// "unassigned" cell — so a region the player has not yet split still holds
// multiple stars. Only flag cells in a region the player has committed to
// exactly ONE star; a region with 0 or 2+ stars is incomplete, not wrong
// (this is why a blank board rings nothing). Stars are in doubled
// coordinates — star (R,C) anchors to real cell (R>>1, C>>1).
function _galaxiesDiff(grid, solution, stars) {
  const out = [];
  if (!Array.isArray(stars)) return out;
  const rows = Math.min(grid.length, solution.length);
  if (rows === 0) return out;
  const cols = Math.min((grid[0] || []).length, (solution[0] || []).length);

  const solStar = new Map();      // solution region id -> star index
  const userStar = new Map();     // player region id -> a star index in it
  const userStarCount = new Map(); // player region id -> how many stars it holds
  for (let i = 0; i < stars.length; i++) {
    const ar = stars[i].row >> 1, ac = stars[i].col >> 1;
    if (ar < 0 || ar >= rows || ac < 0 || ac >= cols) continue;
    const sRid = solution[ar] && solution[ar][ac];
    if (sRid > 0) solStar.set(sRid, i);
    const gRid = grid[ar] && grid[ar][ac];
    if (gRid > 0) {
      userStar.set(gRid, i);
      userStarCount.set(gRid, (userStarCount.get(gRid) || 0) + 1);
    }
  }

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const gv = grid[r][c];
      if (!(gv > 0)) continue;
      // Skip cells whose region is not yet committed to exactly one star.
      if (userStarCount.get(gv) !== 1) continue;
      if (userStar.get(gv) !== solStar.get(solution[r][c])) {
        out.push({ row: r, col: c });
      }
    }
  }
  return out;
}

// Slitherlink diff: edge-based, not cell-based. A mistake is a committed
// LINE edge (board value === 1) where the solution disagrees. UNKNOWN/empty
// edges on the board are never flagged.
function _slitherlinkDiff(board, solution) {
  const out = [];
  if (!board || !solution) return out;
  const bh = board.horizontal || [];
  const sh = solution.horizontal || [];
  const rowsH = Math.min(bh.length, sh.length);
  for (let r = 0; r < rowsH; r++) {
    const br = bh[r] || [], sr = sh[r] || [];
    const cols = Math.min(br.length, sr.length);
    for (let c = 0; c < cols; c++) {
      if (br[c] === 0) continue;             // UNKNOWN never flagged
      if (br[c] !== sr[c]) out.push({ orientation: 'h', r, c });
    }
  }
  const bv = board.vertical || [];
  const sv = solution.vertical || [];
  const rowsV = Math.min(bv.length, sv.length);
  for (let r = 0; r < rowsV; r++) {
    const br = bv[r] || [], sr = sv[r] || [];
    const cols = Math.min(br.length, sr.length);
    for (let c = 0; c < cols; c++) {
      if (br[c] === 0) continue;
      if (br[c] !== sr[c]) out.push({ orientation: 'v', r, c });
    }
  }
  return out;
}

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
