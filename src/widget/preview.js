'use strict';
// Canvas-rendering helpers for the puzzle-preview overlay. Extracted
// from content.js's makeWidget closure (Stage A of the Phase 2
// refactor — see docs/superpowers/specs/2026-05-25-content-js-split-
// phase-2-stage-a-design.md). Stage A0 lands the sig hashers; Stage
// A1 follows with the canvas-layer builders; Stage A2 promotes
// drawPreview.

let hintIdCounter = 0;
const hintIdCache = new WeakMap();
function hintSig(hint) {
  if (!hint) return '';
  let id = hintIdCache.get(hint);
  if (id === undefined) {
    id = ++hintIdCounter;
    hintIdCache.set(hint, id);
  }
  return id;
}

// FNV-1a 32-bit hash. Called per state-watch tick (every ~200ms) for grids
// up to 50×50; the prior O(N²) string concat dominated the early-bail check
// it fed. Cell values are shifted into a non-negative range before mixing.
const FNV_OFFSET = 0x811c9dc5 | 0;
const FNV_PRIME = 16777619;

function regionMapSig(rm) {
  if (!rm) return 0;
  let h = FNV_OFFSET;
  for (let r = 0; r < rm.length; r++) {
    const row = rm[r];
    for (let c = 0; c < row.length; c++) {
      h ^= row[c];
      h = Math.imul(h, FNV_PRIME);
    }
    // Row separator so [[1,2],[3]] and [[1],[2,3]] don't collide.
    h ^= 0xff;
    h = Math.imul(h, FNV_PRIME);
  }
  return h;
}

// Sparse comparison-clue stable signature. FNV-like rolling number so a
// change anywhere in the sparse 2D invalidates the static-layer cache.
function comparisonCluesSig(cc) {
  if (!Array.isArray(cc) || cc.length === 0) return '0';
  let h = 0x811c9dc5;
  for (let r = 0; r < cc.length; r++) {
    const row = Array.isArray(cc[r]) ? cc[r] : [];
    for (let c = 0; c < row.length; c++) {
      h ^= r * 65537 + c * 31 + ((row[c] | 0) + 1);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return (h >>> 0).toString(36);
}

function shikakuCluesSig(clues) {
  if (!Array.isArray(clues) || clues.length === 0) return '0';
  let h = 0x811c9dc5;
  for (const k of clues) {
    h ^= (k.row | 0) * 65537 + (k.col | 0) * 31 + (k.area | 0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(36);
}

function slitherlinkCluesSig(task) {
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

// Island-set stable signature for the hashi static layer (circles + numbers).
// Bridge counts live in the dynamic layer / gridDataSig, NOT here.
function hashiIslandsSig(islands) {
  if (!Array.isArray(islands) || islands.length === 0) return '0';
  let h = 0x811c9dc5;
  for (const i of islands) {
    h ^= (i.row | 0) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
    h ^= (i.col | 0) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
    h ^= (i.number | 0) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(36);
}

function hitoriTaskSig(task) {
  if (!task) return '0';
  let h = 0x811c9dc5;
  for (const row of task) for (const v of row) {
    h ^= v & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16);
}

function kakurasuCluesSig(rowClues, colClues) {
  if (!rowClues || !colClues) return '0';
  let h = 0x811c9dc5;
  for (const v of rowClues) { h ^= v & 0xff; h = Math.imul(h, 0x01000193) >>> 0; }
  for (const v of colClues) { h ^= v & 0xff; h = Math.imul(h, 0x01000193) >>> 0; }
  return (h >>> 0).toString(16);
}

function kurodokoTaskSig(task) {
  if (!task) return '0';
  let h = 0x811c9dc5;
  for (const row of task) for (const v of row) {
    h ^= (v + 1) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16);
}

function mosaicTaskSig(task) {
  if (!task) return '0';
  let h = 0x811c9dc5;
  for (const row of task) for (const v of row) {
    h ^= (v + 1) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16);
}

function norinoriAreasSig(areas) {
  if (!areas) return '0';
  let h = 0x811c9dc5;
  for (const row of areas) for (const v of row) {
    h ^= (v + 1) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16);
}

function nurikabeTaskSig(task) {
  if (!task) return '0';
  let h = 0x811c9dc5;
  for (const row of task) for (const v of row) {
    h ^= v & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
    h ^= (v >>> 8) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16);
}

// Room-boundary (areas) + target-numbers stable signature for the heyawake static layer.
function heyawakeAreasSig(areas, rooms) {
  if (!Array.isArray(areas) || areas.length === 0) return '0';
  let h = 0x811c9dc5;
  for (const row of areas) {
    for (const v of row) {
      h ^= (v + 1) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  if (Array.isArray(rooms)) {
    for (const room of rooms) {
      const t = room.target;
      h ^= (t + 1) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return (h >>> 0).toString(36);
}

function gridDataSig(grid) {
  // Hashi grids: { edges: [...] }. No 2D state — bridges encode everything
  // visible. (No .horizontal/.vertical, so test before the slitherlink arm.)
  if (grid && Array.isArray(grid.edges) && !grid.horizontal) {
    let h = 0x811c9dc5;
    for (const e of grid.edges) {
      h ^= (e.a | 0) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
      h ^= (e.b | 0) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
      h ^= (e.bridges | 0) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
    }
    return (h >>> 0).toString(16);
  }
  if (grid && grid.horizontal && grid.vertical) {
    let h = 0x811c9dc5;
    const mix = (n) => { h ^= n; h = Math.imul(h, 0x01000193) >>> 0; };
    for (const row of grid.horizontal) for (const v of row) mix(v | 0);
    mix(0xFF);
    for (const row of grid.vertical) for (const v of row) mix(v | 0);
    if (grid.galaxies) {
      mix(0xEE);
      for (const row of grid.galaxies.horizontal || []) for (const v of row) mix(v | 0);
      for (const row of grid.galaxies.vertical   || []) for (const v of row) mix(v | 0);
    }
    return (h >>> 0).toString(16);
  }
  let h = FNV_OFFSET;
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r];
    for (let c = 0; c < row.length; c++) {
      h ^= (row[c] + 2);  // shift {-1, 0, 1, star indices} into positives
      h = Math.imul(h, FNV_PRIME);
    }
  }
  if (grid.galaxies) {
    const g = grid.galaxies;
    if (g.horizontal) {
      for (const row of g.horizontal) {
        for (const v of row) {
          h ^= (v + 2);
          h = Math.imul(h, FNV_PRIME);
        }
        h ^= 0xfe;
        h = Math.imul(h, FNV_PRIME);
      }
    }
    if (g.vertical) {
      for (const row of g.vertical) {
        for (const v of row) {
          h ^= (v + 2);
          h = Math.imul(h, FNV_PRIME);
        }
        h ^= 0xfd;
        h = Math.imul(h, FNV_PRIME);
      }
    }
  }
  return h;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    hintIdCounter, hintIdCache,
    hintSig, FNV_OFFSET, FNV_PRIME,
    regionMapSig, comparisonCluesSig, shikakuCluesSig,
    slitherlinkCluesSig, hashiIslandsSig, hitoriTaskSig,
    kakurasuCluesSig, kurodokoTaskSig, mosaicTaskSig,
    norinoriAreasSig, nurikabeTaskSig, heyawakeAreasSig,
    gridDataSig,
  };
}
