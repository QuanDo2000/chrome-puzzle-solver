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
    this.rows = rows; this.cols = cols; this.k = stars; this.maxMs = maxMs;
    // Normalize areas/walls: the page (and callers) pass [] for "none" — shaped boards
    // carry walls:[], shapeless boards carry areas all-0 or absent. Treat anything that
    // isn't a proper 2D grid as null so _initGrid/_isValid never index an empty array
    // (walls:[] -> walls[r] is undefined -> a throw that strands the worker mid-solve).
    this.areas = (Array.isArray(areas) && areas.length && Array.isArray(areas[0])) ? areas : null;
    this.walls = (Array.isArray(walls) && walls.length && Array.isArray(walls[0])) ? walls : null;
    // Groups that each need exactly k stars: every row, every column, and (shaped) every region.
    this.groups = [];
    for (let r = 0; r < rows; r++) { const g = []; for (let c = 0; c < cols; c++) g.push([r, c]); this.groups.push(g); }
    for (let c = 0; c < cols; c++) { const g = []; for (let r = 0; r < rows; r++) g.push([r, c]); this.groups.push(g); }
    if (this.areas) {
      const byId = {};
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const a = this.areas[r][c]; (byId[a] = byId[a] || []).push([r, c]); }
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

  _initGrid() {
    this.g = Array.from({ length: this.rows }, () => new Array(this.cols).fill(0));
    if (this.walls) for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) if (this.walls[r][c]) this.g[r][c] = 2;
  }

  // Set cell (r,c) to val (1 star / 2 no-star). Returns false on a conflicting prior value.
  _set(r, c, val) {
    if (this.g[r][c] === val) return true;
    if (this.g[r][c] !== 0) return false;
    this.g[r][c] = val; this._dirty = true; return true;
  }

  // Adjacency + group-count forcing to a fixpoint. Returns false on contradiction.
  _propagate() {
    this._dirty = true;
    while (this._dirty) {
      this._dirty = false;
      // Adjacency: every star crosses its 8 neighbours; two adjacent stars = contradiction.
      for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) if (this.g[r][c] === 1) {
        for (let u = 0; u < 8; u++) {
          const nr = r + STAR_DR[u], nc = c + STAR_DC[u];
          if (nr >= 0 && nc >= 0 && nr < this.rows && nc < this.cols) {
            if (this.g[nr][nc] === 1) return false;
            if (this.g[nr][nc] === 0) { this.g[nr][nc] = 2; this._dirty = true; }
          }
        }
      }
      // Group count: each row/col/region needs exactly k stars.
      for (const grp of this.groups) {
        let s = 0; const unk = [];
        for (const [r, c] of grp) { const v = this.g[r][c]; if (v === 1) s++; else if (v === 0) unk.push([r, c]); }
        if (s > this.k) return false;
        if (s + unk.length < this.k) return false;
        if (s === this.k && unk.length) { for (const [r, c] of unk) if (!this._set(r, c, 2)) return false; }
        else if (s + unk.length === this.k && unk.length) { for (const [r, c] of unk) if (!this._set(r, c, 1)) return false; }
      }
    }
    return true;
  }

  _snapshot() { return this.g.map(r => r.slice()); }
  _restore(s) { this.g = s.map(r => r.slice()); }

  // Pick a candidate cell from the group (row/col/region) with the fewest unknowns that still needs stars.
  _pick() {
    let best = null, bestN = Infinity;
    for (const grp of this.groups) {
      let s = 0; const unk = [];
      for (const [r, c] of grp) { const v = this.g[r][c]; if (v === 1) s++; else if (v === 0) unk.push([r, c]); }
      if (s < this.k && unk.length && unk.length < bestN) { bestN = unk.length; best = unk; }
    }
    return best ? best[0] : null;
  }

  _search() {
    if (Date.now() > this._deadline) { this._timedOut = true; return null; }
    const cell = this._pick();
    if (!cell) { const cells = this.g.map(r => r.map(v => v === 1 ? 1 : 0)); return this._isValid(cells) ? cells : null; }
    const [r, c] = cell;
    for (const val of [1, 2]) {
      const snap = this._snapshot();
      if (this._set(r, c, val) && this._propagate()) { const res = this._search(); if (res) return res; }
      this._restore(snap);
    }
    return null;
  }

  // Hint engine: seed the solver with the live cellStatus (1 star, 2 X/no-star, 0 unknown), deduce to a fixpoint,
  // and return the newly-forced cells as { row, col, value } (value 1 = star, 2 = no-star). Returns [] if the live
  // board is contradictory (caller falls back to the cached-solution diff).
  _deduceForced(curCells) {
    this._initGrid();
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) {
      const v = curCells[r][c];
      if (v === 1) { if (!this._set(r, c, 1)) return []; }
      else if (v === 2) { if (!this._set(r, c, 2)) return []; }
    }
    this._deadline = Date.now() + (this.maxMs || 2000);
    if (!this._propagate()) return [];
    const forced = [];
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) {
      if (curCells[r][c] === 1 || curCells[r][c] === 2) continue;
      const v = this.g[r][c];
      if (v === 1) forced.push({ row: r, col: c, value: 1 });
      else if (v === 2) forced.push({ row: r, col: c, value: 2 });
    }
    return forced;
  }

  solve() {
    this._initGrid();
    this._deadline = Date.now() + this.maxMs; this._timedOut = false;
    if (!this._propagate()) return { solved: false, error: 'No solution (contradiction in givens)' };
    const root = this.g.map(r => r.map(v => v === 1 ? 1 : (v === 2 ? 0 : 9)));
    const res = this._search();
    if (res) return { solved: true, cells: res.map(r => r.slice()) };
    if (this._timedOut) return { solved: false, partial: true, cells: root };
    return { solved: false, error: 'No solution found' };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { StarBattleSolver };
}
