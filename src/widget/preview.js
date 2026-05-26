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
  const reg = (typeof PUZZLES !== 'undefined' && PUZZLES) ? PUZZLES[pd?.type] : null;
  if (reg?.customLattice && reg.drawLattice) {
    reg.drawLattice(ctx, { rows, cols, cellSize, w, h, pd });
    return c;
  }
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
  const reg = (typeof PUZZLES !== 'undefined' && PUZZLES) ? PUZZLES[pd?.type] : null;
  if (reg?.drawStaticLayer) {
    reg.drawStaticLayer(ctx, { rows, cols, cellSize, w, h, pd });
    return c;
  }
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

// drawPreview's two-layer cache. Lifted from inside makeWidget at Stage
// A2 so renderPreview can be a top-level function. Single-widget-per-page
// is assumed; if a second widget ever appears, give each its own cache
// or pass it in via args.
let latticeLayer = null;
let staticLayer = null;
let staticLayerSig = null;
let lastDrawSig = null;
let previewWrap = null;

function renderPreview(canvas, puzzleData, grid, hint, bodyWidth) {
  const isSlitherlink = puzzleData?.type === 'slitherlink';
  const isHashi = puzzleData?.type === 'hashi';
  // Hashi's "grid" is { edges }: no 2D extent, so rows/cols come from
  // puzzleData.{rows,cols}. Slitherlink also takes rows/cols from puzzleData
  // when present (the H/V arrays imply them, but pd is authoritative).
  let rows, cols;
  if (isHashi) {
    rows = puzzleData?.rows || 0;
    cols = puzzleData?.cols || 0;
  } else if (isSlitherlink) {
    rows = puzzleData?.rows || (grid.horizontal ? grid.horizontal.length - 1 : 0);
    cols = puzzleData?.cols || (grid.horizontal ? (grid.horizontal[0] || []).length : 0);
  } else {
    rows = grid.length;
    cols = grid[0].length;
  }
  const isKakurasu = puzzleData?.type === 'kakurasu';
  // Kakurasu needs a (cols+1)×(rows+1) canvas: N×N play grid plus a right
  // column for row clues and a bottom row for column clues.
  const cellSizeDenC = isKakurasu ? cols + 1 : cols;
  const cellSizeDenR = isKakurasu ? rows + 1 : rows;
  const cellSize = Math.min(Math.floor((bodyWidth - 4) / cellSizeDenC), Math.floor(350 / cellSizeDenR), 24);
  const w = cols * cellSize, h = rows * cellSize;
  const wFull = isKakurasu ? (cols + 1) * cellSize : w;
  const hFull = isKakurasu ? (rows + 1) * cellSize : h;

  // Idempotent: ensure the preview is visible whether or not we redraw.
  previewWrap.classList.add('ns-visible');

  // Early bail: if everything that affects pixels is identical to the
  // previous draw, skip the entire redraw. The state-watch MutationObserver
  // fires on every DOM tick (~200ms) — most of those don't change cell values.
  const pd = puzzleData;
  const sig = rows + 'x' + cols + '@' + cellSize + '|t=' + (pd?.type || '') +
              '|rm=' + regionMapSig(pd?.regionMap) +
              '|st=' + (pd?.stars ? pd.stars.map(s => s.row + ',' + s.col).join(';') : '') +
              '|g=' + gridDataSig(grid) +
              '|h=' + hintSig(hint) +
              '|sol=' + (pd?.solution ? '1' : '0');
  if (sig === lastDrawSig) return;
  lastDrawSig = sig;

  // (Re)build the static layers if puzzle shape or size changed.
  const staticSigReg = (typeof PUZZLES !== 'undefined' && PUZZLES) ? PUZZLES[pd?.type] : null;
  let staticSig;
  if (staticSigReg?.staticSig) {
    staticSig = rows + 'x' + cols + '@' + cellSize + '|t=' + (pd?.type || '') +
                '|rm=' + regionMapSig(pd?.regionMap) +
                '|st=' + (pd?.stars ? pd.stars.map(s => s.row + ',' + s.col).join(';') : '') +
                '|' + staticSigReg.staticSig(pd);
  } else {
    staticSig = rows + 'x' + cols + '@' + cellSize + '|t=' + (pd?.type || '') +
                      '|rm=' + regionMapSig(pd?.regionMap) +
                      '|st=' + (pd?.stars ? pd.stars.map(s => s.row + ',' + s.col).join(';') : '') +
                      '|cc=' + comparisonCluesSig(pd?.comparisonClues) +
                      '|sk=' + shikakuCluesSig(pd?.type === 'shikaku' ? pd.clues : null) +
                      '|sl=' + slitherlinkCluesSig(pd?.type === 'slitherlink' ? pd.task : null) +
                      '|hi=' + hashiIslandsSig(pd?.type === 'hashi' ? pd.islands : null) +
                      '|hy=' + heyawakeAreasSig(pd?.type === 'heyawake' ? pd.areas : null, pd?.type === 'heyawake' ? pd.rooms : null) +
                      '|hi=' + hitoriTaskSig(pd?.type === 'hitori' ? pd.task : null) +
                      '|ka=' + kakurasuCluesSig(pd?.type === 'kakurasu' ? pd.rowClues : null, pd?.type === 'kakurasu' ? pd.colClues : null) +
                      '|kd=' + kurodokoTaskSig(pd?.type === 'kurodoko' ? pd.task : null) +
                      '|mc=' + mosaicTaskSig(pd?.type === 'mosaic' ? pd.task : null) +
                      '|nn=' + norinoriAreasSig(pd?.type === 'norinori' ? pd.areas : null) +
                      '|nu=' + nurikabeTaskSig(pd?.type === 'nurikabe' ? pd.task : null);
  }
  if (staticSig !== staticLayerSig) {
    latticeLayer = buildLatticeLayer(rows, cols, cellSize, wFull, hFull, pd);
    staticLayer = buildStaticLayer(rows, cols, cellSize, wFull, hFull, pd);
    staticLayerSig = staticSig;
  }

  canvas.width = wFull; canvas.height = hFull;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, wFull, hFull);
  // Lattice goes UNDER dynamic fills so filled cells hide the grey
  // cell-border lines inside them. Region borders + galaxy stars come
  // from the second static layer below, painted on top.
  if (latticeLayer) ctx.drawImage(latticeLayer, 0, 0);

  // Empty-cell X marks are batched into one stroke pass so their shared
  // strokeStyle/lineWidth set up only once.
  const galaxiesColors = ['#dbeafe', '#fee2e2', '#dcfce7', '#fef3c7', '#ede9fe', '#cffafe', '#fce7f3', '#e5e7eb'];
  const xPad = Math.max(1, Math.floor(cellSize / 5));
  const isShikaku = puzzleData?.type === 'shikaku';
  const isBinairo = puzzleData?.type === 'binairo';
  const isYinYang = puzzleData?.type === 'yinyang';
  const isHitori = puzzleData?.type === 'hitori';
  const isKurodoko = puzzleData?.type === 'kurodoko';
  const isMosaic = puzzleData?.type === 'mosaic';
  const isNorinori = puzzleData?.type === 'norinori';
  const isNurikabe = puzzleData?.type === 'nurikabe';
  const discR = isBinairo ? Math.max(2, Math.floor(cellSize * 0.35)) : 0;
  if (isSlitherlink) {
    ctx.save();
    ctx.strokeStyle = '#1f2937';
    ctx.lineWidth = Math.max(2, Math.floor(cellSize / 6));
    ctx.lineCap = 'round';
    const hg = grid.horizontal || [];
    for (let r = 0; r <= rows; r++) {
      const row = hg[r] || [];
      for (let c = 0; c < cols; c++) {
        if (row[c] === 1) {
          ctx.beginPath();
          ctx.moveTo(c * cellSize, r * cellSize);
          ctx.lineTo((c + 1) * cellSize, r * cellSize);
          ctx.stroke();
        }
      }
    }
    const vg = grid.vertical || [];
    for (let r = 0; r < rows; r++) {
      const row = vg[r] || [];
      for (let c = 0; c <= cols; c++) {
        if (row[c] === 1) {
          ctx.beginPath();
          ctx.moveTo(c * cellSize, r * cellSize);
          ctx.lineTo(c * cellSize, (r + 1) * cellSize);
          ctx.stroke();
        }
      }
    }
    // × marks for EMPTY (=2) edges. Half the LINE thickness, in a muted gray
    // so they're visually subordinate to the loop itself.
    ctx.strokeStyle = '#9aa0a6';
    ctx.lineWidth = Math.max(1, Math.floor(cellSize / 12));
    ctx.lineCap = 'round';
    const xMarkSize = Math.max(3, Math.floor(cellSize / 5));
    for (let r = 0; r <= rows; r++) {
      const row = (hg)[r] || [];
      for (let c = 0; c < cols; c++) {
        if (row[c] !== 2) continue;
        const midX = (c + 0.5) * cellSize;
        const midY = r * cellSize;
        ctx.beginPath();
        ctx.moveTo(midX - xMarkSize / 2, midY - xMarkSize / 2);
        ctx.lineTo(midX + xMarkSize / 2, midY + xMarkSize / 2);
        ctx.moveTo(midX + xMarkSize / 2, midY - xMarkSize / 2);
        ctx.lineTo(midX - xMarkSize / 2, midY + xMarkSize / 2);
        ctx.stroke();
      }
    }
    for (let r = 0; r < rows; r++) {
      const row = (vg)[r] || [];
      for (let c = 0; c <= cols; c++) {
        if (row[c] !== 2) continue;
        const midX = c * cellSize;
        const midY = (r + 0.5) * cellSize;
        ctx.beginPath();
        ctx.moveTo(midX - xMarkSize / 2, midY - xMarkSize / 2);
        ctx.lineTo(midX + xMarkSize / 2, midY + xMarkSize / 2);
        ctx.moveTo(midX + xMarkSize / 2, midY - xMarkSize / 2);
        ctx.lineTo(midX - xMarkSize / 2, midY + xMarkSize / 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  } else if (isHashi) {
    // Hashi bridges. Single bridges render as one centered line; double
    // bridges as two parallel lines offset ±bridgeOffset perpendicular to
    // the bridge direction. The island circles in the static layer cover
    // each line's endpoints, so we stroke from island-center to
    // island-center and let the circles mask the inner stubs.
    const islands = puzzleData?.islands || [];
    const bridgeOffset = Math.max(2, Math.floor(cellSize / 7));
    ctx.save();
    ctx.strokeStyle = '#1a73e8';
    ctx.lineWidth = Math.max(2, Math.floor(cellSize / 9));
    ctx.lineCap = 'butt';
    const edges = grid?.edges || [];
    for (const e of edges) {
      if (!e || !e.bridges) continue;
      const ia = islands[e.a], ib = islands[e.b];
      if (!ia || !ib) continue;
      const ax = ia.col * cellSize + cellSize / 2;
      const ay = ia.row * cellSize + cellSize / 2;
      const bx = ib.col * cellSize + cellSize / 2;
      const by = ib.row * cellSize + cellSize / 2;
      if (e.orientation === 'H') {
        if (e.bridges === 1) {
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.moveTo(ax, ay - bridgeOffset);
          ctx.lineTo(bx, by - bridgeOffset);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(ax, ay + bridgeOffset);
          ctx.lineTo(bx, by + bridgeOffset);
          ctx.stroke();
        }
      } else {
        if (e.bridges === 1) {
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.moveTo(ax - bridgeOffset, ay);
          ctx.lineTo(bx - bridgeOffset, by);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(ax + bridgeOffset, ay);
          ctx.lineTo(bx + bridgeOffset, by);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  } else {
    let xMarkPath = null;
    ctx.fillStyle = '#1f2937';
    const cellReg = (typeof PUZZLES !== 'undefined' && PUZZLES) ? PUZZLES[pd?.type] : null;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = grid[r][c];
        if (v === 0 && !isShikaku && !isHitori && !isKakurasu && !isKurodoko && !isMosaic && !isNorinori && !isNurikabe) continue;
        if (v === -1 && isShikaku) continue;
        const x = c * cellSize, y = r * cellSize;
        if (cellReg?.drawPreviewCell) {
          cellReg.drawPreviewCell(ctx, {
            r, c, v, taskVal: pd?.task?.[r]?.[c],
            x, y, cellW: cellSize, cellH: cellSize, hint,
            puzzleData: pd,
            xPad,
            cellSize,
            discR,
            galaxiesColors,
          });
          continue;
        }
        if (isShikaku) {
          if (v >= 0) {
            ctx.fillStyle = galaxiesColors[v % galaxiesColors.length];
            ctx.fillRect(x + 1, y + 1, cellSize - 2, cellSize - 2);
          }
        } else if (isBinairo) {
          // cellStatus encoding: 1 = "one" cells (page shows as light/outlined),
          // 2 = "zero" cells (page shows as dark/filled). Match that polarity.
          const cx = x + cellSize / 2, cy = y + cellSize / 2;
          if (v === 1) {
            ctx.fillStyle = '#fff';
            ctx.strokeStyle = '#1f2937';
            ctx.lineWidth = Math.max(1.5, cellSize / 14);
            ctx.beginPath();
            ctx.arc(cx, cy, discR, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          } else if (v === 2) {
            ctx.fillStyle = '#1f2937';
            ctx.beginPath();
            ctx.arc(cx, cy, discR, 0, Math.PI * 2);
            ctx.fill();
          }
        } else if (isYinYang) {
          // cellStatus 1 renders light, 2 renders dark — matching the game
          // (Yin-Yang shares Binairo's cell encoding/polarity).
          const yyInset = Math.max(1, Math.floor(cellSize * 0.15));
          const yySide = cellSize - 2 * yyInset;
          const sx = x + yyInset, sy = y + yyInset;
          if (v === 1) {
            ctx.fillStyle = '#fff';
            ctx.fillRect(sx, sy, yySide, yySide);
            ctx.strokeStyle = '#1f2937';
            ctx.lineWidth = Math.max(1.5, cellSize / 14);
            ctx.strokeRect(sx, sy, yySide, yySide);
          } else if (v === 2) {
            ctx.fillStyle = '#1f2937';
            ctx.fillRect(sx, sy, yySide, yySide);
          }
          // Given cells get a small contrasting centre square.
          const given = puzzleData?.task?.[r]?.[c];
          if (given === 0 || given === 1) {
            const dotSide = Math.max(2, Math.floor(cellSize * 0.2));
            ctx.fillStyle = v === 1 ? '#1f2937' : '#fff';
            ctx.fillRect(x + (cellSize - dotSide) / 2, y + (cellSize - dotSide) / 2, dotSide, dotSide);
          }
        } else if (puzzleData?.type === 'galaxies' && v > 0) {
          ctx.fillStyle = galaxiesColors[(v - 1) % galaxiesColors.length];
          ctx.fillRect(x + 1, y + 1, cellSize - 2, cellSize - 2);
        } else if (puzzleData?.type === 'heyawake') {
          // cellStatus 1 = black cell; 2 = white-marked (not black, confirmed
          // empty). Render black as a solid dark fill; white-marker as a small
          // grey dot at the cell centre so the player can see deduced empties.
          if (v === 1) {
            ctx.fillStyle = '#1f2937';
            ctx.fillRect(x, y, cellSize, cellSize);
          } else if (v === 2) {
            const dotR = Math.max(2, Math.floor(cellSize * 0.15));
            ctx.fillStyle = '#9ca3af';
            ctx.beginPath();
            ctx.arc(x + cellSize / 2, y + cellSize / 2, dotR, 0, Math.PI * 2);
            ctx.fill();
          }
        } else if (isHitori) {
          // Hitori: every cell shows its clue digit. Reversed convention —
          // unshaded cells (v=2) get the dark fill (digit in light colour),
          // shaded cells (v=1) stay light with a dark digit. Unknown (v=0)
          // stays light/neutral so the initial board is fully readable.
          if (v === 2) {
            ctx.fillStyle = '#1f2937';
            ctx.fillRect(x, y, cellSize, cellSize);
          }
          const clueVal = pd?.task?.[r]?.[c] ?? 0;
          const ch = (clueVal >= 10 && clueVal <= 35)
            ? String.fromCharCode(clueVal + 87)
            : String(clueVal);
          ctx.font = `bold ${Math.floor(cellSize * 0.55)}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = v === 2 ? '#f3f4f6' : '#1f2937';
          ctx.fillText(ch, x + cellSize / 2, y + cellSize / 2);
        } else if (isKakurasu) {
          // Kakurasu: v=1 filled (dark square inset), v=2 crossed (two
          // diagonal strokes), v=0 unknown (empty — handled by early-bail
          // check above but also fine to fall through to nothing).
          if (v === 1) {
            const pad = Math.max(2, Math.floor(cellSize * 0.1));
            ctx.fillStyle = '#1f2937';
            ctx.fillRect(x + pad, y + pad, cellSize - 2 * pad, cellSize - 2 * pad);
          } else if (v === 2) {
            const pad = Math.max(3, Math.floor(cellSize * 0.25));
            ctx.strokeStyle = '#9ca3af';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(x + pad, y + pad);
            ctx.lineTo(x + cellSize - pad, y + cellSize - pad);
            ctx.moveTo(x + cellSize - pad, y + pad);
            ctx.lineTo(x + pad, y + cellSize - pad);
            ctx.stroke();
          }
        } else if (isKurodoko) {
          // Kurodoko: every cell shows clue digit if it's a clue cell.
          // v=1 = black cell (solid dark fill); v=2 = confirmed white/empty
          // (× cross so the player can see deduced whites); v=0 = unknown
          // (blank — skipped by early-bail unless clue cell).
          const taskVal = (pd?.task?.[r]?.[c] ?? -1);
          if (taskVal !== -1) {
            // Clue cell: show the number. If also marked black, fill dark
            // first so the digit renders in light colour on top.
            ctx.font = `bold ${Math.floor(cellSize * 0.5)}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            if (v === 1) {
              ctx.fillStyle = '#1f2937';
              ctx.fillRect(x, y, cellSize, cellSize);
              ctx.fillStyle = '#f3f4f6';
            } else {
              ctx.fillStyle = '#1f2937';
            }
            ctx.fillText(String(taskVal), x + cellSize / 2, y + cellSize / 2);
          } else if (v === 1) {
            ctx.fillStyle = '#1f2937';
            ctx.fillRect(x, y, cellSize, cellSize);
          } else if (v === 2) {
            const pad = Math.max(3, Math.floor(cellSize * 0.25));
            ctx.strokeStyle = '#9ca3af';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(x + pad, y + pad);
            ctx.lineTo(x + cellSize - pad, y + cellSize - pad);
            ctx.moveTo(x + cellSize - pad, y + pad);
            ctx.lineTo(x + pad, y + cellSize - pad);
            ctx.stroke();
          }
          // v === 0 non-clue → blank (already excluded by early-bail above)
        } else if (isMosaic) {
          const taskVal = (pd?.task?.[r]?.[c] ?? -1);
          // Background fill based on cellStatus.
          if (v === 1) {
            ctx.fillStyle = '#1f2937';
            ctx.fillRect(x, y, cellSize, cellSize);
          } else if (v === 2) {
            const pad = Math.max(3, Math.floor(cellSize * 0.25));
            ctx.strokeStyle = '#9ca3af';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(x + pad, y + pad);
            ctx.lineTo(x + cellSize - pad, y + cellSize - pad);
            ctx.moveTo(x + cellSize - pad, y + pad);
            ctx.lineTo(x + pad, y + cellSize - pad);
            ctx.stroke();
          }
          // Clue digit overlay (light text on dark fill, dark otherwise).
          if (taskVal !== -1) {
            ctx.font = `bold ${Math.floor(cellSize * 0.5)}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = (v === 1) ? '#f3f4f6' : '#1f2937';
            ctx.fillText(String(taskVal), x + cellSize / 2, y + cellSize / 2);
          }
        } else if (isNorinori) {
          // Norinori: v=1 = black cell (solid dark fill inset); v=2 = crossed
          // empty (diagonal cross in muted gray); v=0 = unknown (blank).
          if (v === 1) {
            const pad = Math.max(2, Math.floor(cellSize * 0.1));
            ctx.fillStyle = '#1f2937';
            ctx.fillRect(x + pad, y + pad, cellSize - 2 * pad, cellSize - 2 * pad);
          } else if (v === 2) {
            const pad = Math.max(3, Math.floor(cellSize * 0.25));
            ctx.strokeStyle = '#9ca3af';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(x + pad, y + pad);
            ctx.lineTo(x + cellSize - pad, y + cellSize - pad);
            ctx.moveTo(x + cellSize - pad, y + pad);
            ctx.lineTo(x + pad, y + cellSize - pad);
            ctx.stroke();
          }
        } else if (isNurikabe) {
          // Skip clue cells — page renders them as their own DOM node.
          // Skip wall cells (task === -2) — off-board, page renders them inert.
          const taskVal = puzzleData?.task?.[r]?.[c];
          if (typeof taskVal === 'number' && (taskVal > 0 || taskVal === -2)) {
            // leave page's clue/wall cell visible (no overdraw)
          } else if (v === 1) {
            const pad = Math.max(2, Math.floor(cellSize * 0.1));
            ctx.fillStyle = '#1f2937';
            ctx.fillRect(x + pad, y + pad, cellSize - 2 * pad, cellSize - 2 * pad);
          } else if (v === 2) {
            const pad = Math.max(3, Math.floor(cellSize * 0.25));
            ctx.strokeStyle = '#9ca3af';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(x + pad, y + pad);
            ctx.lineTo(x + cellSize - pad, y + cellSize - pad);
            ctx.moveTo(x + cellSize - pad, y + pad);
            ctx.lineTo(x + pad, y + cellSize - pad);
            ctx.stroke();
          }
        } else if (v === 1) {
          ctx.fillStyle = '#1f2937';
          ctx.fillRect(x, y, cellSize, cellSize);
        } else if (v === -1) {
          if (!xMarkPath) xMarkPath = new Path2D();
          xMarkPath.moveTo(x + xPad, y + xPad);
          xMarkPath.lineTo(x + cellSize - xPad, y + cellSize - xPad);
          xMarkPath.moveTo(x + cellSize - xPad, y + xPad);
          xMarkPath.lineTo(x + xPad, y + cellSize - xPad);
        }
      }
    }
    if (xMarkPath) {
      ctx.strokeStyle = '#999';
      ctx.lineWidth = 1;
      ctx.stroke(xMarkPath);
    }
  }

  if (puzzleData?.type === 'galaxies') {
    ctx.save();
    ctx.strokeStyle = '#1f2937';
    ctx.lineWidth = Math.max(2, Math.floor(cellSize / 8));
    const glines = grid.galaxies;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = c * cellSize, y = r * cellSize;
        if (c + 1 < cols && (grid[r][c + 1] !== grid[r][c] || glines?.vertical?.[r]?.[c + 1] === 1)) {
          ctx.beginPath(); ctx.moveTo(x + cellSize, y); ctx.lineTo(x + cellSize, y + cellSize); ctx.stroke();
        }
        if (r + 1 < rows && (grid[r + 1][c] !== grid[r][c] || glines?.horizontal?.[r + 1]?.[c] === 1)) {
          ctx.beginPath(); ctx.moveTo(x, y + cellSize); ctx.lineTo(x + cellSize, y + cellSize); ctx.stroke();
        }
      }
    }
    // Stars themselves are part of the cached static layer (puzzle-shape only).
    ctx.restore();
  }

  if (puzzleData?.type === 'shikaku') {
    ctx.save();
    ctx.strokeStyle = '#1f2937';
    ctx.lineWidth = Math.max(2, Math.floor(cellSize / 8));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = c * cellSize, y = r * cellSize;
        const v = grid[r][c];
        if (c + 1 < cols && grid[r][c + 1] !== v) {
          ctx.beginPath(); ctx.moveTo(x + cellSize, y); ctx.lineTo(x + cellSize, y + cellSize); ctx.stroke();
        }
        if (r + 1 < rows && grid[r + 1][c] !== v) {
          ctx.beginPath(); ctx.moveTo(x, y + cellSize); ctx.lineTo(x + cellSize, y + cellSize); ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  if (isSlitherlink && hint && Array.isArray(hint.edges)) {
    ctx.save();
    ctx.strokeStyle = '#2e86de';
    ctx.lineWidth = Math.max(3, Math.floor(cellSize / 5));
    ctx.lineCap = 'round';
    for (const e of hint.edges) {
      if (e.orientation === 'h') {
        ctx.beginPath();
        ctx.moveTo(e.c * cellSize, e.r * cellSize);
        ctx.lineTo((e.c + 1) * cellSize, e.r * cellSize);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.moveTo(e.c * cellSize, e.r * cellSize);
        ctx.lineTo(e.c * cellSize, (e.r + 1) * cellSize);
        ctx.stroke();
      }
    }
    ctx.restore();
  } else if (hint) {
    const highlightColor = 'rgba(46, 134, 222, 0.25)';
    const fillColor = 'rgba(46, 134, 222, 0.45)';
    const crossColor = 'rgba(230, 57, 70, 0.45)';
    if (hint.type === 'galaxies') {
      ctx.save();
      ctx.strokeStyle = '#2e86de';
      ctx.lineWidth = Math.max(4, Math.floor(cellSize / 5));
      ctx.lineCap = 'round';
      for (const item of hint.lineHints || [hint]) {
        ctx.beginPath();
        if (item.orientation === 'horizontal') {
          ctx.moveTo(item.col * cellSize + 2, item.row * cellSize);
          ctx.lineTo((item.col + 1) * cellSize - 2, item.row * cellSize);
        } else {
          ctx.moveTo(item.col * cellSize, item.row * cellSize + 2);
          ctx.lineTo(item.col * cellSize, (item.row + 1) * cellSize - 2);
        }
        ctx.stroke();
      }
      ctx.restore();
    } else if (puzzleData?.type === 'shikaku') {
      // Shikaku hints reveal a rectangle, not a row/column — skip the
      // band highlight; the per-cell loop below paints each hint cell.
    } else if (puzzleData?.type === 'heyawake') {
      // Heyawake hints are absolute cells (extraCells) — no row/column
      // band; the per-cell loop below paints each hint cell.
    } else if (puzzleData?.type === 'hitori') {
      // Hitori hints are absolute cells (extraCells) — no row/column band.
    } else if (isKakurasu) {
      // Kakurasu hints are absolute cells (extraCells) — no row/column band.
    } else if (isKurodoko) {
      // Kurodoko hints are absolute cells (extraCells) — no row/column band.
    } else if (isMosaic) {
      // Mosaic hints are absolute cells (extraCells) — no row/column band.
    } else if (isNorinori) {
      // Norinori hints are absolute cells (extraCells) — no row/column band.
    } else if (isNurikabe) {
      // Nurikabe hints are absolute cells (extraCells) — no row/column band.
    } else if (hint.type === 'hashi') {
      // Hashi hint edges are already merged into grid.edges by
      // applyHintToGrid and painted by the dynamic-bridges branch above.
      // No row/column band highlight, no per-cell loop applies.
    } else if (hint.type === 'row') {
      ctx.fillStyle = highlightColor;
      ctx.fillRect(0, hint.index * cellSize, w, cellSize);
    } else {
      ctx.fillStyle = highlightColor;
      ctx.fillRect(hint.index * cellSize, 0, cellSize, h);
    }
    // hintAbsoluteCells normalizes hint.cells (row/col-indexed via
    // hint.type+hint.index) and hint.extraCells (already absolute) into one
    // {row, col, value} list, so the paint logic stays single-source.
    for (const cell of hintAbsoluteCells(hint)) {
      const cx = cell.col * cellSize;
      const cy = cell.row * cellSize;
      if (puzzleData?.type === 'shikaku' && cell.value >= 0) {
        // Shikaku hint cell: paint it in its owning rectangle's colour
        // (so the rectangle visibly takes shape) with a blue ring to
        // mark it as the newly-revealed hint.
        ctx.fillStyle = galaxiesColors[cell.value % galaxiesColors.length];
        ctx.fillRect(cx + 1, cy + 1, cellSize - 2, cellSize - 2);
        ctx.strokeStyle = '#2e86de';
        ctx.lineWidth = Math.max(2, Math.floor(cellSize / 7));
        ctx.strokeRect(cx + 2, cy + 2, cellSize - 4, cellSize - 4);
      } else if (puzzleData?.type === 'yinyang' && (cell.value === 1 || cell.value === 2)) {
        // Draw the hint square in its colour, ringed blue to mark the hint.
        const inset = Math.max(1, Math.floor(cellSize * 0.15));
        const side = cellSize - 2 * inset;
        const sx = cx + inset, sy = cy + inset;
        ctx.fillStyle = cell.value === 1 ? '#fff' : '#1f2937';
        ctx.fillRect(sx, sy, side, side);
        ctx.strokeStyle = '#2e86de';
        ctx.lineWidth = Math.max(2, Math.floor(cellSize / 9));
        ctx.strokeRect(sx, sy, side, side);
      } else if (puzzleData?.type === 'heyawake' && (cell.value === 1 || cell.value === 2)) {
        // Heyawake hint: value 1 = must be black (dark fill + blue ring),
        // value 2 = must be white/empty (translucent overlay + blue ring).
        const inset = Math.max(1, Math.floor(cellSize * 0.1));
        const side = cellSize - 2 * inset;
        const sx = cx + inset, sy = cy + inset;
        ctx.fillStyle = cell.value === 1 ? 'rgba(31, 41, 55, 0.6)' : 'rgba(255,255,255,0.5)';
        ctx.fillRect(sx, sy, side, side);
        ctx.strokeStyle = '#2e86de';
        ctx.lineWidth = Math.max(2, Math.floor(cellSize / 9));
        ctx.strokeRect(sx, sy, side, side);
      } else if (puzzleData?.type === 'hitori' && (cell.value === 1 || cell.value === 2)) {
        // Hitori hint (reversed convention): value 2 = must be unshaded
        // (dark cell), so use the darker blue ring; value 1 = must be
        // shaded (light cell), so use the lighter blue ring.
        ctx.strokeStyle = cell.value === 2 ? '#3b82f6' : '#60a5fa';
        ctx.lineWidth = Math.max(2, Math.floor(cellSize / 9));
        ctx.strokeRect(cx + 2, cy + 2, cellSize - 4, cellSize - 4);
      } else if (isKakurasu && (cell.value === 1 || cell.value === 2)) {
        // Kakurasu hint: value 1 = must be filled (darker blue ring),
        // value 2 = must be crossed (lighter blue ring).
        ctx.strokeStyle = cell.value === 1 ? '#3b82f6' : '#60a5fa';
        ctx.lineWidth = Math.max(2, Math.floor(cellSize / 9));
        ctx.strokeRect(cx + 2, cy + 2, cellSize - 4, cellSize - 4);
      } else if (isKurodoko && (cell.value === 1 || cell.value === 2)) {
        // Kurodoko hint: value 1 = must be black (darker blue ring),
        // value 2 = must be white/empty (lighter blue ring).
        ctx.strokeStyle = cell.value === 1 ? '#3b82f6' : '#60a5fa';
        ctx.lineWidth = Math.max(2, Math.floor(cellSize / 9));
        ctx.strokeRect(cx + 2, cy + 2, cellSize - 4, cellSize - 4);
      } else if (isMosaic && (cell.value === 1 || cell.value === 2)) {
        // Mosaic hint: value 1 = must be black (darker blue ring),
        // value 2 = must be white/empty (lighter blue ring).
        ctx.strokeStyle = cell.value === 1 ? '#3b82f6' : '#60a5fa';
        ctx.lineWidth = Math.max(2, Math.floor(cellSize / 9));
        ctx.strokeRect(cx + 2, cy + 2, cellSize - 4, cellSize - 4);
      } else if (isNorinori && (cell.value === 1 || cell.value === 2)) {
        // Norinori hint: value 1 = must be black (darker blue ring),
        // value 2 = must be empty/crossed (lighter blue ring).
        ctx.strokeStyle = cell.value === 1 ? '#3b82f6' : '#60a5fa';
        ctx.lineWidth = Math.max(2, Math.floor(cellSize / 9));
        ctx.strokeRect(cx + 2, cy + 2, cellSize - 4, cellSize - 4);
      } else if (isNurikabe && (cell.value === 1 || cell.value === 2)) {
        // Nurikabe hint: value 1 = must be sea/black; value 2 = must be island/white.
        ctx.strokeStyle = cell.value === 1 ? '#3b82f6' : '#60a5fa';
        ctx.lineWidth = Math.max(2, Math.floor(cellSize / 9));
        ctx.strokeRect(cx + 2, cy + 2, cellSize - 4, cellSize - 4);
      } else if (puzzleData?.type === 'binairo' && (cell.value === 1 || cell.value === 2)) {
        // For binairo hints, draw a translucent disc matching the target value
        // — outlined blue = "play a 1 here", full blue fill = "play a 0 here".
        const ccx = cx + cellSize / 2;
        const ccy = cy + cellSize / 2;
        const hr = Math.max(2, Math.floor(cellSize * 0.35));
        ctx.fillStyle = fillColor;
        ctx.beginPath();
        ctx.arc(ccx, ccy, hr, 0, Math.PI * 2);
        ctx.fill();
        if (cell.value === 1) {
          ctx.strokeStyle = '#2e86de';
          ctx.lineWidth = Math.max(1.5, cellSize / 14);
          ctx.stroke();
        }
      } else if (cell.value === 1) {
        ctx.fillStyle = fillColor;
        ctx.fillRect(cx + 2, cy + 2, cellSize - 4, cellSize - 4);
      } else if (cell.value === -1) {
        ctx.fillStyle = crossColor;
        ctx.fillRect(cx + 2, cy + 2, cellSize - 4, cellSize - 4);
        ctx.strokeStyle = '#e63946';
        ctx.lineWidth = 1.5;
        const p = Math.max(1, Math.floor(cellSize / 5));
        ctx.beginPath();
        ctx.moveTo(cx + p, cy + p);
        ctx.lineTo(cx + cellSize - p, cy + cellSize - p);
        ctx.moveTo(cx + cellSize - p, cy + p);
        ctx.lineTo(cx + p, cy + cellSize - p);
        ctx.stroke();
      }
    }
  }

  // Region borders + nonogram-5 guides + galaxies stars sit ON TOP of fills
  // and hints (the lattice layer painted at the start of this function
  // already covers the under-fill case).
  if (staticLayer) ctx.drawImage(staticLayer, 0, 0);

  // Mistake overlay: when the auto-solved solution is known, ring every
  // cell the player has placed wrong. Recomputed each redraw, so it tracks
  // the board live as the state-watch refreshes the preview.
  if (puzzleData?.solution) {
    const mistakes = computePuzzleDiff(
      puzzleData.type, grid, puzzleData.solution, puzzleData.stars);
    if (mistakes.length) {
      ctx.save();
      ctx.strokeStyle = '#e63946';
      ctx.lineWidth = Math.max(2, Math.floor(cellSize / 8));
      if (puzzleData.type === 'slitherlink') {
        ctx.lineCap = 'round';
        ctx.lineWidth = Math.max(3, Math.floor(cellSize / 5));
        for (const em of /** @type {any[]} */ (mistakes)) {
          ctx.beginPath();
          if (em.orientation === 'h') {
            ctx.moveTo(em.c * cellSize, em.r * cellSize);
            ctx.lineTo((em.c + 1) * cellSize, em.r * cellSize);
          } else {
            ctx.moveTo(em.c * cellSize, em.r * cellSize);
            ctx.lineTo(em.c * cellSize, (em.r + 1) * cellSize);
          }
          ctx.stroke();
        }
      } else if (puzzleData.type === 'hashi') {
        // Re-stroke wrong bridges in red between the two island centres.
        // computePuzzleDiff returns {a, b, orientation, expected, actual}
        // for each mis-drawn bridge (wrong count or unwanted bridge).
        ctx.lineCap = 'round';
        ctx.lineWidth = Math.max(3, Math.floor(cellSize / 5));
        const islands = puzzleData?.islands || [];
        for (const m of /** @type {any[]} */ (mistakes)) {
          const ia = islands[m.a], ib = islands[m.b];
          if (!ia || !ib) continue;
          ctx.beginPath();
          ctx.moveTo(ia.col * cellSize + cellSize / 2, ia.row * cellSize + cellSize / 2);
          ctx.lineTo(ib.col * cellSize + cellSize / 2, ib.row * cellSize + cellSize / 2);
          ctx.stroke();
        }
      } else {
        for (const m of /** @type {any[]} */ (mistakes)) {
          const mx = m.col * cellSize, my = m.row * cellSize;
          ctx.fillStyle = 'rgba(230, 57, 70, 0.22)';
          ctx.fillRect(mx, my, cellSize, cellSize);
          ctx.strokeRect(mx + 1, my + 1, cellSize - 2, cellSize - 2);
        }
      }
      ctx.restore();
    }
  }
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
    latticeLayer, staticLayer, staticLayerSig,
    renderPreview,
  };
}
