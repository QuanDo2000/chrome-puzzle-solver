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

  async hintDispatch(ctx) {
    const { puzzleData, callMainWorld, solution } = ctx;
    if (!solution || !solution.horizontal || !solution.vertical) {
      return { success: false, error: 'No solution available' };
    }
    const rows = puzzleData.rows;
    const cols = puzzleData.cols;
    const board = await callMainWorld('readShingokiState', [rows, cols]);
    if (!board) return { success: false, error: 'Could not read board' };

    const cap = hintBatchCap(rows, cols);
    const edges = [];
    const { horizontal, vertical } = solution;
    for (let r = 0; r < horizontal.length && edges.length < cap; r++) {
      for (let c = 0; c < horizontal[r].length && edges.length < cap; c++) {
        if (horizontal[r][c] === 1 && board.horizontal[r][c] !== 1) {
          edges.push({ orientation: 'h', r, c });
        }
      }
    }
    for (let r = 0; r < vertical.length && edges.length < cap; r++) {
      for (let c = 0; c < vertical[r].length && edges.length < cap; c++) {
        if (vertical[r][c] === 1 && board.vertical[r][c] !== 1) {
          edges.push({ orientation: 'v', r, c });
        }
      }
    }
    if (!edges.length) return { success: false, error: 'No hint available' };
    return {
      success: true,
      hint: { type: 'shingoki', edges },
      grid: board,
      solution,
    };
  },

  async loopDoneCheck(ctx) {
    const { puzzleData, callMainWorld, solution } = ctx;
    if (!solution) return false;
    const rows = puzzleData.rows;
    const cols = puzzleData.cols;
    const board = await callMainWorld('readShingokiState', [rows, cols]);
    if (!board) return false;
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

module.exports = shingoki;
