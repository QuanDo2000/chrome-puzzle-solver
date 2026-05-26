'use strict';

// Nonogram puzzle module — first migrated puzzle in Stage C of the
// content.js split. Bundle-concatenated; ends with a CJS export footer
// the bundler strips before emit.
//
// Hooks consumed by the Stage-B dispatchers (cache.js, preview.js,
// widget.js, content.js):
//   cacheKey         — solution localStorage key for this puzzle.
//   drawStaticLayer  — paints the every-5 row/col guides onto the
//                      preview's static layer.
//   loopDoneCheck    — "all cells non-zero" sentinel; same condition the
//                      generic cell-state fallback uses, lifted here.
//   hintStatusNodes  — row/col chunk-style hint description, returned as
//                      an array of strings + DOM nodes ready for
//                      setStatusNodes('info', prefix, ...nodes).
//
// `solveExtraData` and `hintDispatch` are intentionally omitted —
// nonogram doesn't need extra-data (solver gets rowClues/colClues from
// runSolve's positional args) and its hint flow runs through content.js's
// generic getHint() which already type-dispatches internally.
//
// Helpers consumed from bundle scope (concatenated globals):
//   bold (passed via helpers bag) — closure helper from widget.js.
//   (No other closure references; logic is otherwise self-contained.)

const nonogram = {
  type: 'nonogram',
  label: 'Nonogram',
  url: 'https://www.puzzles-mobile.com/nonograms/',
  solutionKeyPrefix: 'nonogram-solution:',

  cacheKey(data) {
    if (!data || data.type !== 'nonogram') return null;
    const r = (data.rowClues || []).map(rc => rc.join('-')).join(';');
    const c = (data.colClues || []).map(cc => cc.join('-')).join(';');
    return 'nonogram-solution:' + data.rows + 'x' + data.cols + ':' + r + ':' + c;
  },

  drawStaticLayer(ctx, { rows, cols, cellSize, w, h, pd }) {
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
  },

  loopDoneCheck({ boardState }) {
    if (!boardState) return false;
    return boardState.every(row => row.every(c => c !== 0));
  },

  hintStatusNodes(h, { bold }) {
    const label = h.type === 'row' ? 'Row' : 'Column';
    const clueStr = Array.isArray(h.clue) ? h.clue.join(', ') : null;
    const filled = h.cells.filter(c => c.value === 1).map(c => c.index + 1);
    const crossed = h.cells.filter(c => c.value === -1).map(c => c.index + 1);
    const extra = h.extraCells || [];

    const nodes = [bold(`${label} ${h.index + 1}`),
                   clueStr !== null ? ` (clue: ${clueStr}): ` : ': '];
    const segments = [];
    if (filled.length) segments.push(['cells ', bold(_fmtList(filled)), ' must be filled']);
    if (crossed.length) segments.push(['cells ', bold(_fmtList(crossed)), ' must be empty']);
    if (extra.length) {
      segments.push([bold(String(extra.length)),
        ' related aquarium cell' + (extra.length === 1 ? '' : 's') + ' can also be filled']);
    }
    for (let i = 0; i < segments.length; i++) {
      if (i > 0) nodes.push(', ');
      for (const seg of segments[i]) nodes.push(seg);
    }
    return nodes;
  },
};

// Local copy of widget.js's fmtList — only used by hintStatusNodes above.
// Inlined here (not via helpers bag) so the module is self-contained for
// row/col chunk formatting. Logic identical to the closure-scoped version.
function _fmtList(nums) {
  if (nums.length <= 2) return nums.join(', ');
  const runs = [];
  let s = nums[0], e = nums[0];
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] === e + 1) { e = nums[i]; continue; }
    runs.push(s === e ? '' + s : s + '-' + e);
    s = e = nums[i];
  }
  runs.push(s === e ? '' + s : s + '-' + e);
  return runs.join(', ');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = nonogram;
}
