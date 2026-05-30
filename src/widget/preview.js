'use strict';

const { hashFNV1a } = require('./shared.js');

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

// FNV-1a 32-bit hashes via the shared hashFNV1a. Called per state-watch tick
// (every ~200ms) for grids up to 50×50; the prior O(N²) string concat
// dominated the early-bail check these feed. Cell values are shifted into a
// non-negative range before mixing. regionMapSig and the default gridDataSig
// branch feed bytes UNMASKED (mask=false) and return a signed int
// (`hashFNV1a(...) | 0`) to stay byte-identical with the original inline hashes
// (whose ids/values can exceed 255, so masking would change the result).

function regionMapSig(rm) {
  if (!rm) return 0;
  return hashFNV1a((mix) => {
    for (let r = 0; r < rm.length; r++) {
      const row = rm[r];
      for (let c = 0; c < row.length; c++) mix(row[c]);
      // Row separator so [[1,2],[3]] and [[1],[2,3]] don't collide.
      mix(0xff);
    }
  }, false) | 0;
}

function gridDataSig(grid) {
  // Hashi grids: { edges: [...] }. No 2D state — bridges encode everything
  // visible. (No .horizontal/.vertical, so test before the slitherlink arm.)
  if (grid && Array.isArray(grid.edges) && !grid.horizontal) {
    return hashFNV1a((mix) => {
      for (const e of grid.edges) { mix(e.a | 0); mix(e.b | 0); mix(e.bridges | 0); }
    }).toString(16);
  }
  if (grid && grid.horizontal && grid.vertical) {
    return hashFNV1a((mix) => {
      for (const row of grid.horizontal) for (const v of row) mix(v | 0);
      mix(0xFF);
      for (const row of grid.vertical) for (const v of row) mix(v | 0);
      if (grid.galaxies) {
        mix(0xEE);
        for (const row of grid.galaxies.horizontal || []) for (const v of row) mix(v | 0);
        for (const row of grid.galaxies.vertical   || []) for (const v of row) mix(v | 0);
      }
    }, false).toString(16);
  }
  return hashFNV1a((mix) => {
    for (let r = 0; r < grid.length; r++) {
      const row = grid[r];
      // shift {-1, 0, 1, star indices} into positives
      for (let c = 0; c < row.length; c++) mix(row[c] + 2);
    }
    if (grid.galaxies) {
      const g = grid.galaxies;
      if (g.horizontal) {
        for (const row of g.horizontal) {
          for (const v of row) mix(v + 2);
          mix(0xfe);
        }
      }
      if (g.vertical) {
        for (const row of g.vertical) {
          for (const v of row) mix(v + 2);
          mix(0xfd);
        }
      }
    }
  }, false) | 0;
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
  const reg = (typeof PUZZLES !== 'undefined' && PUZZLES) ? PUZZLES[pd?.type] : null;
  if (reg?.drawStaticLayer) {
    reg.drawStaticLayer(ctx, { rows, cols, cellSize, w, h, pd });
    return c;
  }
  return c;
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
  // Stage D Task 5: canvasDims hook collapses the geometry chain.
  // Non-default modules (hashi, slitherlink, kakurasu) provide a
  // canvasDims(pd, { grid }) returning {rows, cols, padRight?, padBottom?}.
  // padRight/padBottom (default 0) are EXTRA cells added to the canvas —
  // kakurasu uses padRight=1, padBottom=1 for its (N+1)×(N+1) clue rim.
  const dimsReg = (typeof PUZZLES !== 'undefined' && PUZZLES) ? PUZZLES[puzzleData?.type] : null;
  const dims = dimsReg?.canvasDims
    ? dimsReg.canvasDims(puzzleData, { grid })
    : { rows: grid.length, cols: grid[0]?.length || 0, padRight: 0, padBottom: 0 };
  const rows = dims.rows;
  const cols = dims.cols;
  const padRight = dims.padRight || 0;
  const padBottom = dims.padBottom || 0;
  const cellSizeDenC = cols + padRight;
  const cellSizeDenR = rows + padBottom;
  const cellSize = Math.min(Math.floor((bodyWidth - 4) / cellSizeDenC), Math.floor(350 / cellSizeDenR), 24);
  const w = cols * cellSize, h = rows * cellSize;
  const wFull = (cols + padRight) * cellSize;
  const hFull = (rows + padBottom) * cellSize;
  // Type-discriminator consts still consumed at other sites in renderPreview
  // (cell-loop gates, dynamic-render arms, mistake-overlay branches).
  const isSlitherlink = puzzleData?.type === 'slitherlink';
  const isHashi = puzzleData?.type === 'hashi';

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
                '|st=' + (pd?.stars ? pd.stars.map(s => s.row + ',' + s.col).join(';') : '');
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
  // renderEmptyCells: hand-listed chain "shikaku/hitori/kakurasu/kurodoko/
  // mosaic/norinori/nurikabe" need to render v===0 cells (clue digits, walls,
  // region borders, etc.). Lifted to a per-module flag so adding a new
  // empty-rendering puzzle stays a one-file change in src/widget/puzzles/.
  const renderEmpty = !!(typeof PUZZLES !== 'undefined'
    && PUZZLES?.[puzzleData?.type]?.renderEmptyCells);
  const discR = puzzleData?.type === 'binairo' ? Math.max(2, Math.floor(cellSize * 0.35)) : 0;
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
        if (v === 0 && !renderEmpty) continue;
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
        if (puzzleData?.type === 'galaxies' && v > 0) {
          ctx.fillStyle = galaxiesColors[(v - 1) % galaxiesColors.length];
          ctx.fillRect(x + 1, y + 1, cellSize - 2, cellSize - 2);
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
    const bandReg = (typeof PUZZLES !== 'undefined' && PUZZLES) ? PUZZLES[puzzleData?.type] : null;
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
    } else if (bandReg?.hintBandSkip || hint.type === 'hashi') {
      // Per-puzzle hint shapes that don't paint a row/column band; the
      // per-cell loop below paints each hint cell (or, for hashi, edges
      // already merged into grid.edges by applyHintToGrid).
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
    // Per-puzzle modules own their hint-cell render via drawHintCell; the
    // default branch covers the nonogram-shape arms (value=1 fill,
    // value=-1 red cross) that don't belong to any per-puzzle module.
    const hintCellReg = (typeof PUZZLES !== 'undefined' && PUZZLES) ? PUZZLES[puzzleData?.type] : null;
    for (const cell of hintAbsoluteCells(hint)) {
      const cx = cell.col * cellSize;
      const cy = cell.row * cellSize;
      if (hintCellReg?.drawHintCell) {
        hintCellReg.drawHintCell(ctx, { cell, cx, cy, cellSize, galaxiesColors, fillColor });
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
    hintSig,
    regionMapSig,
    gridDataSig,
    buildLatticeLayer, buildStaticLayer,
    drawHeyawakeRoomsOn, drawRegionBordersOn,
    latticeLayer, staticLayer, staticLayerSig,
    renderPreview,
  };
}
