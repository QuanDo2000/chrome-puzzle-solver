'use strict';

// Binairo puzzle module — second migrated puzzle in Stage C of the
// content.js split. Bundle-concatenated; ends with a CJS export footer
// the bundler strips before emit. Covers both standard Binairo
// (`/binairo/`) and Binairo Plus (`/binairo-plus/`) — they share the
// same puzzleData.type === 'binairo' discriminator; Plus is identified
// by a populated `comparisonClues` array.
//
// Hooks consumed by the Stage-B dispatchers (cache.js, preview.js,
// widget.js, content.js):
//   cacheKey         — FNV-1a over givens + comparison clues; nameplate
//                      keeps it disjoint from other puzzle hashes.
//   staticSig        — contributes the comparison-clues segment to the
//                      preview's static-layer cache key.
//   drawStaticLayer  — overlays comparison `=` / `×` glyphs (Binairo
//                      Plus only). Standard Binairo has no clues to draw.
//   drawPreviewCell  — solved-cell rendering: outlined disc for `1`,
//                      filled dark disc for `2`. Translates the
//                      cellStatus encoding (1=one, 2=zero) into the
//                      page's visual polarity.
//   hintStatusNodes  — describes a Binairo hint as "must be 1/0" for a
//                      single deduced cell, or N-cells-deducible.
//   solveExtraData   — extra payload for the solver worker: rows/cols
//                      plus `givens` and `comparisonClues` (the solver
//                      reconstructs the BinairoSolver from these).
//
// === Encoding gotcha ===
//
// Two integer encodings on `window.Game`:
// - `task` — 2D **givens**: `-1=blank, 0=given-zero, 1=given-one`.
// - `currentState.cellStatus` — 2D **state**: `0=empty, 1=filled-one (black),
//   2=filled-zero (white)`.
// - Translation givens → cellStatus: `-1→0, 0→2, 1→1`.
//
// `BinairoSolver` works internally in cellStatus encoding and translates givens
// at the constructor; everything downstream uses `0/1/2`. Don't reintroduce the
// `-1/0/1` triad — it's input-only. `BinairoSolver.getHint(grid)` requires
// cellStatus encoding; `binairoHandler.readState()` returns it directly.
//
// Note: the page pre-allocates `comparisonClues` as one empty array per row even
// on standard Binairo (so outer length always equals `puzzleHeight`); code
// distinguishing "clues present" from "structure exists" must count markers
// inside, not check outer length.
//
// === Binairo Plus / comparison-clue support ===
//
// `/binairo-plus/*` shares `binairoHandler` + `BinairoSolver` with one extra
// rule. `puzzleData.type === 'binairo'` for both paths — discriminator is
// `puzzleData.comparisonClues` (empty for standard, populated sparse 2D for plus).
//
// Page exposes `window.Game.comparisonClues` as sparse 2D of flag integers.
// Bits: `FLAG_RIGHT_EQ=1, FLAG_RIGHT_NE=2, FLAG_DOWN_EQ=4, FLAG_DOWN_NE=8`
// (OR-able). E.g. `10 = 8|2` is "down ≠ AND right ≠". Preview renders NE as `×`.
//
// `_decodeComparison` flattens to canonical `{aR, aC, bR, bC, sameSign}` array
// in `this.compConstraints`. Out-of-grid borders silently dropped.
// `_applyComparison(onChange)` runs in `propagate()` between balance and
// uniqueness: both-sides-known + inconsistent → contradiction; one-side-known →
// force other (with `_wouldCreateTriple` pre-check); neither known → skip.
// Successful `propagate()` ⇒ no comparison violations, so no separate completion
// check needed (unlike `_hasDuplicateLines`, which IS still needed because
// uniqueness has a gap on lines with >2 empty cells).
//
// Cache key (`binairoCacheKey` and `BinairoSolver._cacheKey`) mixes
// comparison-clue bytes. Preview renders `=` / `×` glyphs at cell-boundary
// midpoints in cached `staticLayer`; `staticSig` includes a `|cc=` segment.
//
// See `src/solvers/binairo.js` for solver-internal details (lookahead,
// triples-inline propagation, maxMs budget).

const binairo = {
  type: 'binairo',
  label: 'Binairo',
  url: 'https://www.puzzles-mobile.com/binairo/',
  solutionKeyPrefix: 'binairo-solution:',

  cacheKey(data) {
    if (data?.type !== 'binairo') return null;
    // FNV-1a over (type, rows, cols, flattened givens, comparison clues).
    let h = 0x811c9dc5;
    const mix = (n) => { h ^= n; h = Math.imul(h, 0x01000193) >>> 0; };
    mix(0x42); // 'B' nameplate so binairo keys can't collide with nonogram keys
    mix(data.rows | 0);
    mix(data.cols | 0);
    const g = data.givens || [];
    for (let r = 0; r < data.rows; r++) {
      const row = g[r] || [];
      for (let c = 0; c < data.cols; c++) mix((row[c] | 0) + 2);
    }
    // Mix comparison clues so binairo and binairo-plus boards with identical
    // givens hash to distinct keys. Sparse 2D — outer row index, inner col
    // index, value or 0 for missing. Length sentinels up front keep zero-
    // comparison and 1-comparison-of-flag-0 cases distinguishable.
    const cc = Array.isArray(data.comparisonClues) ? data.comparisonClues : [];
    mix(cc.length);
    for (let r = 0; r < cc.length; r++) {
      const row = Array.isArray(cc[r]) ? cc[r] : [];
      mix(row.length);
      for (let c = 0; c < row.length; c++) mix((row[c] | 0) + 1);
    }
    return 'binairo-solution:' + (h >>> 0).toString(16);
  },

  staticSig(data) {
    return 'cc=' + _comparisonCluesSig(data?.comparisonClues);
  },

  drawStaticLayer(ctx, { cellSize, pd }) {
    if (!Array.isArray(pd?.comparisonClues)) return;
    const comparisonClues = pd.comparisonClues;
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
  },

  drawPreviewCell(ctx, { v, x, y, cellSize, discR }) {
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
  },

  drawHintCell(ctx, { cell, cx, cy, cellSize, fillColor }) {
    // For binairo hints, draw a translucent disc matching the target value
    // — outlined blue = "play a 1 here", full blue fill = "play a 0 here".
    if (cell.value === 1 || cell.value === 2) {
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
    }
  },

  hintStatusNodes(h, { bold }) {
    const total = (h.cells?.length || 0) + (h.extraCells?.length || 0);
    if (total === 0) return ['No hint available'];
    if (total === 1) {
      const cell = h.cells?.[0] || h.extraCells?.[0];
      const row = h.cells?.length ? h.index : cell.row;
      const col = h.cells?.length ? cell.index : cell.col;
      // Binairo cellStatus: 1 = "one", 2 = "zero". Translate for display.
      const valueStr = cell.value === 1 ? '1' : '0';
      return [
        'Cell ', bold(`(row ${row + 1}, col ${col + 1})`),
        ' must be ', bold(valueStr),
      ];
    }
    if (h._fullCount && h._fullCount > total) {
      return [bold(String(total)), ` (of ${h._fullCount}) cells can be deduced`];
    }
    return [bold(String(total)), ' cells can be deduced'];
  },

  solveExtraData(data) {
    return {
      rows: data.rows,
      cols: data.cols,
      givens: data.givens,
      comparisonClues: data.comparisonClues || [],
    };
  },

  // Hint dispatch for Binairo. Pure deduction by design — when propagation
  // exhausts, the hook surfaces an error pointing the user at Solve instead
  // of falling back to the solver (which could hang for minutes on a 30×30).
  // Mirrors the previous inline arm in content.js's getHint verbatim.
  hintDispatch(ctx) {
    const { detectedGrid, grid, solution, rows, cols, firstMismatch } = ctx;
    if (solution && firstMismatch(grid, solution)) {
      return { success: false, error: 'Current game state is wrong.' };
    }
    const solver = new BinairoSolver({
      rows, cols, givens: detectedGrid.givens, initialState: grid,
      comparisonClues: detectedGrid.comparisonClues || [],
    });
    const hint = solver.getHint(grid);
    if (!hint) {
      return { success: false, error: 'No more cells can be deduced from the current state. Click Solve to finish.' };
    }
    return { success: true, hint, grid, solution };
  },
};

// Sparse comparison-clue stable signature. FNV-like rolling number so a
// change anywhere in the sparse 2D invalidates the static-layer cache.
// Inlined from preview.js so this module is self-contained.
function _comparisonCluesSig(cc) {
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = binairo;
}
