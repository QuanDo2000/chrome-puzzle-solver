'use strict';

// Star Battle solver — pure logic, no DOM.
//
// PAGE ENCODING (recon, ground truth)
//   N x N grid; cellStatus 0 empty, 1 star, 2 X-marker. Star count k = f.stars (scraped from page text).
//   Shaped: areas[r][c] = region id (0..N-1). Shapeless: walls[r][c] = 1 for blocked cells.
//
// VALIDITY (ported from the page getErrors; see the plan doc):
//   exactly k stars per row, per column, per region (shaped); no two stars 8-adjacent; no star on a wall (shapeless).
//
// METHOD: count + adjacency propagation, then MRV backtracking (branch the tightest group's candidate cells).
// On maxMs timeout returns the SOUND root-propagation snapshot (UNK=9). Soundness is brute-force-gated in
// tests/starbattle.test.js. The real 14x14 hard 3-star full-solves in ~0.8s (unique).
//
// Internal working grid g[r][c]: 0 unknown, 1 star, 2 no-star. Output cells: 1 star, 0 no-star, 9 UNK.

const STAR_DR = [-1, -1, -1, 0, 1, 1, 1, 0];
const STAR_DC = [-1, 0, 1, 1, 1, 0, -1, -1];

class StarBattleSolver {
  constructor({ rows, cols, stars, areas = null, walls = null, maxMs = 30000 } = {}) {
    this.rows = rows; this.cols = cols; this.k = stars; this.areas = areas; this.walls = walls; this.maxMs = maxMs;
    // Groups that each need exactly k stars: every row, every column, and (shaped) every region.
    this.groups = [];
    for (let r = 0; r < rows; r++) { const g = []; for (let c = 0; c < cols; c++) g.push([r, c]); this.groups.push(g); }
    for (let c = 0; c < cols; c++) { const g = []; for (let r = 0; r < rows; r++) g.push([r, c]); this.groups.push(g); }
    if (areas) {
      const byId = {};
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const a = areas[r][c]; (byId[a] = byId[a] || []).push([r, c]); }
      for (const id in byId) this.groups.push(byId[id]);
    }
  }

  // Full-board validity oracle (port of getErrors). cells fully decided: 1 star, 0 no-star.
  _isValid(cells) {
    const { rows, cols, k, areas, walls } = this;
    const rowc = new Array(rows).fill(0), colc = new Array(cols).fill(0);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (cells[r][c] === 1) {
      rowc[r]++; colc[c]++;
      if (walls && walls[r][c]) return false; // star on a wall
    }
    for (let r = 0; r < rows; r++) if (rowc[r] !== k) return false;
    for (let c = 0; c < cols; c++) if (colc[c] !== k) return false;
    if (areas) {
      const ac = {}, ids = new Set();
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { ids.add(areas[r][c]); if (cells[r][c] === 1) { const a = areas[r][c]; ac[a] = (ac[a] || 0) + 1; } }
      for (const id of ids) if ((ac[id] || 0) !== k) return false;
    }
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (cells[r][c] === 1) {
      for (let u = 0; u < 8; u++) { const nr = r + STAR_DR[u], nc = c + STAR_DC[u]; if (nr >= 0 && nc >= 0 && nr < rows && nc < cols && cells[nr][nc] === 1) return false; }
    }
    return true;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { StarBattleSolver };
}
