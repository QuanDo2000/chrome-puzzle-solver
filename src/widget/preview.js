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

function buildLatticeLayer(rows, cols, cellSize, w, h, pd) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.strokeStyle = '#d1d5db';
  ctx.lineWidth = 0.5;
  // Nurikabe boards can have wall cells (task[r][c] === -2) — off-board
  // regions that the page renders blank. Draw per-edge so wall areas have
  // no grid lines through them; edges between a wall and a real cell are
  // still drawn (showing the board boundary).
  const isWall = (r, cc) =>
    pd?.type === 'nurikabe' &&
    r >= 0 && r < rows && cc >= 0 && cc < cols &&
    pd.task?.[r]?.[cc] === -2;
  if (pd?.type === 'nurikabe') {
    ctx.beginPath();
    for (let r = 0; r < rows; r++) {
      for (let cc = 0; cc < cols; cc++) {
        if (isWall(r, cc)) continue;
        const x = cc * cellSize;
        const y = r * cellSize;
        // Top edge: draw if cell above is wall or out of bounds, OR always
        // draw (the neighbouring non-wall cell will also draw it — overlap
        // is harmless).
        ctx.moveTo(x, y); ctx.lineTo(x + cellSize, y);
        // Left edge.
        ctx.moveTo(x, y); ctx.lineTo(x, y + cellSize);
        // Bottom edge.
        ctx.moveTo(x, y + cellSize); ctx.lineTo(x + cellSize, y + cellSize);
        // Right edge.
        ctx.moveTo(x + cellSize, y); ctx.lineTo(x + cellSize, y + cellSize);
      }
    }
    ctx.stroke();
    return c;
  }
  ctx.beginPath();
  for (let r = 0; r <= rows; r++) {
    ctx.moveTo(0, r * cellSize);
    ctx.lineTo(w, r * cellSize);
  }
  for (let cc = 0; cc <= cols; cc++) {
    ctx.moveTo(cc * cellSize, 0);
    ctx.lineTo(cc * cellSize, h);
  }
  ctx.stroke();
  return c;
}

function buildStaticLayer(rows, cols, cellSize, w, h, pd) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  drawRegionBordersOn(ctx, rows, cols, cellSize, pd?.regionMap);
  drawNonogramGuidesOn(ctx, rows, cols, cellSize, w, h, pd);
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
  if (pd?.type === 'binairo' && Array.isArray(pd.comparisonClues)) {
    drawComparisonCluesOn(ctx, cellSize, pd.comparisonClues);
  }
  if (pd?.type === 'shikaku' && Array.isArray(pd.clues)) {
    drawShikakuCluesOn(ctx, cellSize, pd.clues);
  }
  if (pd?.type === 'hashi' && Array.isArray(pd.islands)) {
    drawHashiIslandsOn(ctx, cellSize, pd.islands);
  }
  if (pd?.type === 'slitherlink') {
    const dotR = Math.max(1.5, cellSize / 14);
    ctx.fillStyle = '#1f2937';
    for (let r = 0; r <= rows; r++) {
      for (let c = 0; c <= cols; c++) {
        ctx.beginPath();
        ctx.arc(c * cellSize, r * cellSize, dotR, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    const fontPx = Math.max(8, Math.floor(cellSize * 0.55));
    ctx.font = `bold ${fontPx}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#1f2937';
    const task = pd.task || [];
    for (let r = 0; r < rows; r++) {
      const row = task[r] || [];
      for (let c = 0; c < cols; c++) {
        const v = row[c];
        if (v === 0 || v === 1 || v === 2 || v === 3) {
          ctx.fillText(String(v), c * cellSize + cellSize / 2, r * cellSize + cellSize / 2);
        }
      }
    }
  }
  if (pd?.type === 'heyawake' && Array.isArray(pd.areas)) {
    drawHeyawakeRoomsOn(ctx, rows, cols, cellSize, pd.areas, pd.rooms);
  }
  if (pd?.type === 'norinori' && Array.isArray(pd.areas)) {
    // Norinori has the same room-boundary structure as Heyawake but no
    // target numbers — call the shared helper with rooms=null.
    drawHeyawakeRoomsOn(ctx, rows, cols, cellSize, pd.areas, null);
  }
  if (pd?.type === 'hitori') {
    // Outer border only — clue digits are on the dynamic layer (shading
    // changes text colour, so they can't be cached here).
    const borderW = Math.max(2, Math.floor(cellSize / 5));
    ctx.strokeStyle = '#1f2937';
    ctx.lineWidth = borderW;
    ctx.lineCap = 'square';
    ctx.strokeRect(borderW / 2, borderW / 2, cols * cellSize - borderW, rows * cellSize - borderW);
  }
  if (pd?.type === 'kakurasu' && Array.isArray(pd.rowClues) && Array.isArray(pd.colClues)) {
    // Outer border of the N×N playing area.
    const borderW = Math.max(2, Math.floor(cellSize / 5));
    ctx.strokeStyle = '#1f2937';
    ctx.lineWidth = borderW;
    ctx.lineCap = 'square';
    ctx.strokeRect(borderW / 2, borderW / 2, cols * cellSize - borderW, rows * cellSize - borderW);
    // Row clues on the right edge: cell at (r, cols).
    const fontPx = Math.max(8, Math.floor(cellSize * 0.5));
    ctx.font = `bold ${fontPx}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#1f2937';
    for (let r = 0; r < rows; r++) {
      const cx = cols * cellSize + cellSize / 2;
      const cy = r * cellSize + cellSize / 2;
      ctx.fillText(String(pd.rowClues[r]), cx, cy);
    }
    // Column clues on the bottom edge: cell at (rows, c).
    for (let cc = 0; cc < cols; cc++) {
      const cx = cc * cellSize + cellSize / 2;
      const cy = rows * cellSize + cellSize / 2;
      ctx.fillText(String(pd.colClues[cc]), cx, cy);
    }
  }
  if (pd?.type === 'kurodoko') {
    // Outer border only — clue digits are on the dynamic layer (cell
    // shading changes text colour, so they can't be pre-rendered here).
    const borderW = Math.max(2, Math.floor(cellSize / 5));
    ctx.strokeStyle = '#1f2937';
    ctx.lineWidth = borderW;
    ctx.lineCap = 'square';
    ctx.strokeRect(borderW / 2, borderW / 2, cols * cellSize - borderW, rows * cellSize - borderW);
  }
  if (pd?.type === 'mosaic') {
    // Outer border + light interior grid lines. Clue digits go on the
    // dynamic layer because cell shading changes text colour.
    const borderW = Math.max(2, Math.floor(cellSize / 5));
    ctx.strokeStyle = '#1f2937';
    ctx.lineWidth = borderW;
    ctx.lineCap = 'square';
    ctx.strokeRect(borderW / 2, borderW / 2, cols * cellSize - borderW, rows * cellSize - borderW);
  }
  return c;
}

function drawComparisonCluesOn(ctx, cellSize, comparisonClues) {
  const fontSize = Math.max(8, Math.floor(cellSize * 0.45));
  ctx.save();
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#fff';
  ctx.fillStyle = '#1f2937';
  for (let r = 0; r < comparisonClues.length; r++) {
    const row = comparisonClues[r];
    if (!Array.isArray(row)) continue;
    for (let c = 0; c < row.length; c++) {
      const flag = row[c];
      if (typeof flag !== 'number' || flag === 0) continue;
      // Right edge (between (r,c) and (r,c+1))
      if (flag & 3) {
        const x = (c + 1) * cellSize;
        const y = r * cellSize + cellSize / 2;
        const ch = (flag & 1) ? '=' : '×';
        ctx.strokeText(ch, x, y);
        ctx.fillText(ch, x, y);
      }
      // Bottom edge (between (r,c) and (r+1,c))
      if (flag & 12) {
        const x = c * cellSize + cellSize / 2;
        const y = (r + 1) * cellSize;
        const ch = (flag & 4) ? '=' : '×';
        ctx.strokeText(ch, x, y);
        ctx.fillText(ch, x, y);
      }
    }
  }
  ctx.restore();
}

function drawShikakuCluesOn(ctx, cellSize, clues) {
  const fontSize = Math.max(10, Math.floor(cellSize * 0.5));
  ctx.save();
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#fff';
  ctx.fillStyle = '#111827';
  for (const k of clues) {
    const x = k.col * cellSize + cellSize / 2;
    const y = k.row * cellSize + cellSize / 2;
    const ch = String(k.area);
    ctx.strokeText(ch, x, y);
    ctx.fillText(ch, x, y);
  }
  ctx.restore();
}

// Numbered island circles for hashi. Cached in the static layer (island set
// changes only on a fresh detect). Bridges paint in the dynamic layer, so
// re-drawing the circles AFTER bridges in the main loop keeps the centre
// disc covering any bridge stubs that might otherwise poke through.
function drawHashiIslandsOn(ctx, cellSize, islands) {
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

// Thick black borders between distinct room IDs + room-target clue numbers
// for heyawake. Drawn once into the cached static layer; reused until the
// puzzle shape changes.  `areas` is the 2-D room-ID map; `rooms` is the
// parallel array of { cells, target } metadata indexed by room ID.
function drawHeyawakeRoomsOn(ctx, rows, cols, cellSize, areas, rooms) {
  if (!areas) return;
  ctx.save();

  // Outer border — thick black frame around the entire grid.
  const borderW = Math.max(2, Math.floor(cellSize / 5));
  ctx.strokeStyle = '#1f2937';
  ctx.lineWidth = borderW;
  ctx.lineCap = 'square';
  ctx.strokeRect(borderW / 2, borderW / 2, cols * cellSize - borderW, rows * cellSize - borderW);

  // Interior room borders: draw on the shared edge whenever the two
  // adjacent cells belong to different rooms.
  ctx.lineWidth = borderW;
  ctx.beginPath();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const id = (areas[r] || [])[c] || 0;
      // right neighbour
      if (c + 1 < cols && ((areas[r] || [])[c + 1] || 0) !== id) {
        const x = (c + 1) * cellSize;
        const y = r * cellSize;
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + cellSize);
      }
      // bottom neighbour
      if (r + 1 < rows && ((areas[r + 1] || [])[c] || 0) !== id) {
        const x = c * cellSize;
        const y = (r + 1) * cellSize;
        ctx.moveTo(x, y);
        ctx.lineTo(x + cellSize, y);
      }
    }
  }
  ctx.stroke();

  // Clue numbers: one per room, at the top-left cell of the room (the
  // first cell encountered in row-major order whose room has target >= 0).
  const fontSize = Math.max(8, Math.floor(cellSize * 0.5));
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const seen = new Set();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const id = (areas[r] || [])[c] || 0;
      if (seen.has(id)) continue;
      seen.add(id);
      const room = Array.isArray(rooms) ? rooms[id] : null;
      if (!room || room.target < 0) continue;
      const pad = Math.max(1, Math.floor(cellSize * 0.1));
      // White stroke for legibility on dark/filled cells.
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = Math.max(2, Math.floor(cellSize / 8));
      ctx.strokeText(String(room.target), c * cellSize + pad, r * cellSize + pad);
      ctx.fillStyle = '#1f2937';
      ctx.fillText(String(room.target), c * cellSize + pad, r * cellSize + pad);
    }
  }

  ctx.restore();
}

function drawRegionBordersOn(ctx, rows, cols, cellSize, rm) {
  if (!rm) return;
  ctx.save();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = Math.max(3, Math.floor(cellSize / 5));
  ctx.lineCap = 'square';
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * cellSize, y = r * cellSize;
      const id = rm[r][c];
      if (c + 1 < cols && rm[r][c + 1] !== id) {
        ctx.beginPath();
        ctx.moveTo(x + cellSize, y);
        ctx.lineTo(x + cellSize, y + cellSize);
        ctx.stroke();
      }
      if (r + 1 < rows && rm[r + 1][c] !== id) {
        ctx.beginPath();
        ctx.moveTo(x, y + cellSize);
        ctx.lineTo(x + cellSize, y + cellSize);
        ctx.stroke();
      }
    }
  }
  ctx.strokeStyle = '#6b7280';
  ctx.lineWidth = Math.max(1, Math.floor(cellSize / 12));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * cellSize, y = r * cellSize;
      const id = rm[r][c];
      if (c + 1 < cols && rm[r][c + 1] !== id) {
        ctx.beginPath();
        ctx.moveTo(x + cellSize, y);
        ctx.lineTo(x + cellSize, y + cellSize);
        ctx.stroke();
      }
      if (r + 1 < rows && rm[r + 1][c] !== id) {
        ctx.beginPath();
        ctx.moveTo(x, y + cellSize);
        ctx.lineTo(x + cellSize, y + cellSize);
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}

function drawNonogramGuidesOn(ctx, rows, cols, cellSize, w, h, pd) {
  if (pd?.regionMap || pd?.type === 'galaxies' || pd?.type === 'binairo' || pd?.type === 'shikaku' || pd?.type === 'yinyang' || pd?.type === 'slitherlink' || pd?.type === 'hashi' || pd?.type === 'heyawake' || pd?.type === 'hitori' || pd?.type === 'kakurasu' || pd?.type === 'kurodoko' || pd?.type === 'mosaic' || pd?.type === 'norinori' || pd?.type === 'nurikabe') return;
  ctx.save();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = Math.max(3, Math.floor(cellSize / 5));
  ctx.lineCap = 'square';
  for (let c = 5; c < cols; c += 5) {
    ctx.beginPath();
    ctx.moveTo(c * cellSize, 0);
    ctx.lineTo(c * cellSize, h);
    ctx.stroke();
  }
  for (let r = 5; r < rows; r += 5) {
    ctx.beginPath();
    ctx.moveTo(0, r * cellSize);
    ctx.lineTo(w, r * cellSize);
    ctx.stroke();
  }
  ctx.strokeStyle = '#6b7280';
  ctx.lineWidth = Math.max(1, Math.floor(cellSize / 12));
  for (let c = 5; c < cols; c += 5) {
    ctx.beginPath();
    ctx.moveTo(c * cellSize, 0);
    ctx.lineTo(c * cellSize, h);
    ctx.stroke();
  }
  for (let r = 5; r < rows; r += 5) {
    ctx.beginPath();
    ctx.moveTo(0, r * cellSize);
    ctx.lineTo(w, r * cellSize);
    ctx.stroke();
  }
  ctx.restore();
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
    buildLatticeLayer, buildStaticLayer,
    drawComparisonCluesOn, drawShikakuCluesOn, drawHashiIslandsOn,
    drawHeyawakeRoomsOn, drawRegionBordersOn, drawNonogramGuidesOn,
  };
}
