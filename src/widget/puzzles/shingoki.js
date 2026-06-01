/**
 * Shingoki widget module — detect / solve / hint / loop hooks.
 *
 * EDGE MODEL
 * ----------
 * Shingoki is a loop-on-edges puzzle structurally identical to Slitherlink.
 * The board is an R×C grid of cells whose *edges* form a single closed loop.
 * Horizontal edges: (R+1) rows × C cols. Vertical edges: R rows × (C+1) cols.
 * Each edge is 0 (unknown), 1 (line / part of loop), or 2 (cross / no line).
 * The solver returns { horizontal, vertical } as 2-D arrays of those codes.
 *
 * CLUES AT VERTICES
 * -----------------
 * Unlike Slitherlink (per-cell digits), Shingoki clues live at the (R+1)×(C+1)
 * grid *vertices* and are drawn as circles: a signed integer where >0 is a
 * white (corner) circle, <0 is a black (straight) circle, abs() is the path
 * length, and 0 means no clue. The vertex-circle preview rendering is wired in
 * Task 10 (preview.js); THIS module provides only the data hooks.
 *
 * HINT MODEL (differs from Slitherlink)
 * -------------------------------------
 * Slitherlink re-runs its solver against the live board for a propagation
 * hint. Shingoki has no solver-driven hint; instead it caches the full
 * solution (edge arrays) and the hint reveals the next batch of solution LINE
 * edges not yet on the board. hintDispatch re-reads the current board edges via
 * callMainWorld('readShingokiState', [rows, cols]) (mirroring slitherlink's
 * loopDoneCheck) and diffs them against the cached solution.
 *
 * Because the hint NEEDS the cached solution, this module does NOT set
 * skipAutoSolveGate — the hint path awaits autoSolve so the solution is present
 * ("Solve then Hint" works).
 *
 * PAGE INTERACTION
 * ----------------
 * Read edge state via callMainWorld('readShingokiState', [rows, cols]); write
 * via callMainWorld('applyShingokiState', [{ horizontal, vertical }]).
 */
'use strict';

const { hashFNV1a } = require('../shared.js');

// Per-click hint batch cap (see MEMORY: hint batch scales with board for Loop).
function hintBatchCap(rows, cols) {
  return Math.max(4, Math.ceil((rows * cols) / 30));
}

const shingoki = {
  type: 'shingoki',
  label: 'Shingoki',
  url: 'https://www.puzzles-mobile.com/shingoki/random/5x5-easy',
  solutionKeyPrefix: 'shingoki-solution:',
  hasAbsoluteHintCells: true,

  cacheKey(data) {
    if (!data || data.type !== 'shingoki' || !data.task) return null;
    // FNV-1a over (nameplate, rows, cols, flattened task). The feed-callback
    // form mirrors slitherlink's cacheKey — widget/shared.js's hashFNV1a takes
    // a function that receives the `mix` accumulator, not a flat array.
    const h = hashFNV1a((mix) => {
      mix(0x53); // 'S' nameplate so shingoki keys stay disjoint from neighbours
      mix(data.rows | 0);
      mix(data.cols | 0);
      const task = data.task || [];
      for (let r = 0; r < task.length; r++) {
        const row = task[r] || [];
        for (let c = 0; c < row.length; c++) {
          // clues are signed (>0 white, <0 black); +64 keeps them non-negative
          // for the hash.
          mix((row[c] | 0) + 64);
        }
      }
    }, false);
    return 'shingoki-solution:' + h.toString(16);
  },

  // rows/cols come from puzzleData when present, else inferred from the
  // {horizontal, vertical} edge arrays (horizontal has rows+1 rows of cols
  // entries). Mirrors slitherlink's canvasDims so renderPreview's geometry
  // block sizes the edge-loop board correctly.
  canvasDims(pd, { grid }) {
    return {
      rows: pd?.rows || (grid.horizontal ? grid.horizontal.length - 1 : 0),
      cols: pd?.cols || (grid.horizontal ? (grid.horizontal[0] || []).length : 0),
      // Clue circles are centred ON the lattice vertices, so the border row and
      // column sit on the canvas edge. Reserve a half-cell gutter on all sides
      // (preview.js translates everything in by it) so those circles and their
      // numbers aren't clipped.
      marginCells: 0.5,
    };
  },

  // Vertex clue circles live on the cached static layer (puzzle-shape only,
  // never changes as the board fills). Invalidate it when the clue set
  // changes via this signature.
  staticSig(data) {
    return 'sg=' + _shingokiCluesSig(data?.type === 'shingoki' ? data?.task : null);
  },

  // Vertex clue circles at the (rows+1)×(cols+1) lattice points. task[r][c]
  // is a signed integer: >0 = white (corner) circle, <0 = black (straight)
  // circle, abs() is the path-length number, 0 = no clue. Circle centered at
  // canvas (c*cellSize, r*cellSize) — the same origin the slitherlink edge
  // arm uses for its corner dots.
  drawStaticLayer(ctx, { rows, cols, cellSize, pd }) {
    const task = (pd && pd.task) || [];
    // ~⅓-cell radius: large enough to read the number, small enough that two
    // clued vertices one cell apart still leave a visible gap. The half-cell
    // gutter (canvasDims.marginCells) keeps border circles from clipping.
    const radius = Math.max(5, Math.floor(cellSize / 3));
    const fontPx = Math.max(8, Math.floor(cellSize * 0.46));
    ctx.save();
    ctx.font = `bold ${fontPx}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = Math.max(1.5, cellSize / 10);
    for (let r = 0; r <= rows; r++) {
      const row = task[r] || [];
      for (let c = 0; c <= cols; c++) {
        const v = row[c] | 0;
        if (v === 0) continue;
        const cx = c * cellSize;
        const cy = r * cellSize;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        if (v < 0) {
          // Black (straight) circle: filled dark disc, white number.
          ctx.fillStyle = '#1f2937';
          ctx.fill();
          ctx.strokeStyle = '#1f2937';
          ctx.stroke();
          ctx.fillStyle = '#fff';
        } else {
          // White (corner) circle: open ring, black number.
          ctx.fillStyle = '#fff';
          ctx.fill();
          ctx.strokeStyle = '#1f2937';
          ctx.stroke();
          ctx.fillStyle = '#1f2937';
        }
        ctx.fillText(String(Math.abs(v)), cx, cy);
      }
    }
    ctx.restore();
  },

  solveExtraData(data) {
    return { rows: data.rows, cols: data.cols, task: data.task };
  },

  solutionFromResult(result) {
    return { horizontal: result?.horizontal, vertical: result?.vertical };
  },

  solutionToCacheJson(solution) {
    if (!solution) return null;
    return { horizontal: solution.horizontal, vertical: solution.vertical };
  },

  solutionFromCacheJson(parsed) {
    if (!parsed || !parsed.horizontal || !parsed.vertical) return null;
    return {
      horizontal: parsed.horizontal.map((row) => row.slice()),
      vertical: parsed.vertical.map((row) => row.slice()),
    };
  },

  hintStatusNodes(hint, { bold }) {
    const n = hint?.edges?.length || 0;
    return ['Revealing ', bold(String(n)), n === 1 ? ' edge' : ' edges'];
  },

  // ctx from hint.js getHint: { detectedGrid, grid, solution, rows, cols,
  // callMainWorld, ... } — rows/cols are top-level, NOT under a puzzleData
  // field (which getHint's ctx doesn't supply). The live board edge state is
  // re-read via callMainWorld (the `grid` from handler.readState is the same
  // {horizontal,vertical}, but re-reading keeps this resilient to shape drift,
  // mirroring slitherlink's hintDispatch).
  async hintDispatch(ctx) {
    const { callMainWorld, solution, rows, cols, detectedGrid } = ctx;
    const board = await callMainWorld('readShingokiState', [rows, cols]);
    if (!board) return { success: false, error: 'Could not read board' };

    // 1) Deductive hint: forced edges from the live board via the solver.
    //    `ShingokiSolver` is a content-script global (solver.js loads first);
    //    require()'d under Node for tests. Guarded so a solver throw can't break
    //    Hint — fall through to the solution diff.
    const task = detectedGrid && detectedGrid.task;
    if (task) {
      try {
        const Solver = (typeof ShingokiSolver !== 'undefined')
          ? ShingokiSolver
          : require('../../solvers/shingoki.js').ShingokiSolver;
        const solver = new Solver({ rows, cols, task, maxMs: 5000 });
        const deduced = solver.getStepwiseHint(board.horizontal, board.vertical);
        if (deduced && deduced.edges.length) {
          return { success: true, hint: { type: 'shingoki', edges: deduced.edges }, grid: board, solution };
        }
      } catch { /* fall through to solution diff */ }
    }

    // 2) Fallback: reveal the next correct LINE edges from the cached solution.
    if (!solution || !solution.horizontal || !solution.vertical) {
      return { success: false, error: 'No solution available' };
    }
    const cap = hintBatchCap(rows, cols);
    const edges = [];
    const { horizontal, vertical } = solution;
    for (let r = 0; r < horizontal.length && edges.length < cap; r++) {
      for (let c = 0; c < horizontal[r].length && edges.length < cap; c++) {
        if (horizontal[r][c] === 1 && board.horizontal[r][c] !== 1) edges.push({ orientation: 'h', r, c });
      }
    }
    for (let r = 0; r < vertical.length && edges.length < cap; r++) {
      for (let c = 0; c < vertical[r].length && edges.length < cap; c++) {
        if (vertical[r][c] === 1 && board.vertical[r][c] !== 1) edges.push({ orientation: 'v', r, c });
      }
    }
    if (!edges.length) return { success: false, error: 'No hint available' };
    return { success: true, hint: { type: 'shingoki', edges }, grid: board, solution };
  },

  // ctx from widget.js runLoop: { boardState, solution, puzzleData }. boardState
  // IS the live {horizontal,vertical} edge state (no callMainWorld in this ctx —
  // do NOT destructure it, or it shadows the bundle global as undefined and
  // throws). Mirrors slitherlink's loopDoneCheck contract.
  loopDoneCheck(ctx) {
    const { boardState, solution } = ctx;
    if (!solution || !boardState) return false;
    const board = boardState;
    const { horizontal, vertical } = solution;
    for (let r = 0; r < horizontal.length; r++) {
      for (let c = 0; c < horizontal[r].length; c++) {
        if (horizontal[r][c] === 1 && board.horizontal[r][c] !== 1) return false;
      }
    }
    for (let r = 0; r < vertical.length; r++) {
      for (let c = 0; c < vertical[r].length; c++) {
        if (vertical[r][c] === 1 && board.vertical[r][c] !== 1) return false;
      }
    }
    return true;
  },

  async applyHint(hint, { callMainWorld, puzzleData }) {
    const rows = puzzleData.rows;
    const cols = puzzleData.cols;
    const board = await callMainWorld('readShingokiState', [rows, cols]);
    if (!board) return false;
    const horizontal = board.horizontal.map((row) => row.slice());
    const vertical = board.vertical.map((row) => row.slice());
    for (const edge of hint.edges) {
      if (edge.orientation === 'h') {
        horizontal[edge.r][edge.c] = 1;
      } else {
        vertical[edge.r][edge.c] = 1;
      }
    }
    const ok = await callMainWorld('applyShingokiState', [{ horizontal, vertical }]);
    return ok === true;
  },
};

// Clue-set signature for the static-layer cache. The task is the
// (rows+1)×(cols+1) signed vertex-clue array; +64 keeps signed values
// non-negative for the hash (matching cacheKey's offset).
function _shingokiCluesSig(task) {
  if (!Array.isArray(task)) return '';
  const h = hashFNV1a((mix) => {
    for (let r = 0; r < task.length; r++) {
      const row = task[r] || [];
      for (let c = 0; c < row.length; c++) {
        mix((row[c] | 0) + 64);
      }
    }
  }, false);
  return h.toString(16);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = shingoki;
}
