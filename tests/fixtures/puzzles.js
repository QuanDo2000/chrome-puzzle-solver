// Small, deterministic puzzles. Each must complete well under solver timeouts
// so the recorded golden output is stable across machines.

module.exports = {
  // 5x5 nonogram: a "1" per row, "1" per col. Solver picks one of the
  // permutation matrices deterministically — fine for snapshot testing.
  nonogramDiagonal5: {
    rowClues: [[1], [1], [1], [1], [1]],
    colClues: [[1], [1], [1], [1], [1]],
  },

  // 3x3 nonogram with a known unique solution:
  //   X . X
  //   . X .
  //   X . X
  nonogramCorners3: {
    rowClues: [[1, 1], [1], [1, 1]],
    colClues: [[1, 1], [1], [1, 1]],
  },

  // 2x2 aquarium with row clues [0,2], col clues [1,1], and two vertical
  // single-column regions. The unique solution fills the bottom row.
  aquariumTiny: {
    rowClues: [0, 2],
    colClues: [1, 1],
    regionMap: [[0, 1], [0, 1]],
    rows: 2,
    cols: 2,
  },

  // 15x15 aquarium with ~37 irregular regions. Generated from a fixed seed
  // (see tests/dump-aquarium-seed42.js if regenerating) so the puzzle is
  // reproducible. Solves via DP preprocessing (0 search nodes) but the DP
  // itself does enough work to be measurable for benchmarking — ~40ms on
  // baseline. Used for golden coverage AND as the bench puzzle.
  aquariumLarge: {
    rowClues: [6, 6, 1, 4, 8, 11, 11, 6, 9, 11, 12, 14, 8, 9, 12],
    colClues: [8, 9, 11, 8, 10, 11, 8, 10, 7, 4, 10, 10, 10, 5, 7],
    regionMap: [
      [24, 24,  8,  8, 17, 17, 17, 17, 16, 16, 30, 30, 30, 30, 23],
      [24, 11,  8,  8, 17, 17, 17, 17, 16, 16, 30, 30, 23, 23, 23],
      [11, 11, 11, 11, 10, 10, 10, 17, 16, 16, 13, 13, 13, 31, 31],
      [11, 11, 21, 11, 10, 10, 10,  3, 36, 16, 13, 13, 13, 15, 31],
      [12, 21, 21, 11, 10, 10, 10,  3,  3, 16, 13, 13, 13, 15, 15],
      [12, 21, 21, 11, 10, 10,  3,  3,  3, 19, 28, 25, 25, 15, 15],
      [12, 27, 27, 11, 10, 10,  3,  3, 19, 19, 19,  2, 25,  6,  6],
      [34, 27, 27, 26, 26, 10,  5,  5, 32, 32, 32,  2,  6,  6,  6],
      [34, 34, 27, 26, 26, 10,  5,  5, 32, 32,  2,  2,  2,  6,  6],
      [34,  9,  9,  9, 26, 10,  5, 20, 20, 32,  2,  2,  2,  6,  6],
      [34, 34, 33, 33, 33, 10,  5, 20, 20, 20,  2,  2,  2,  6,  6],
      [34, 33, 33, 33, 33, 22, 22, 20, 20, 20,  2,  2,  2,  0,  6],
      [ 4,  4,  4, 33, 14, 22, 22,  1, 29, 29, 18, 18,  0,  0,  0],
      [35, 14,  4, 14, 14,  1,  1,  1, 29, 29, 18, 18,  0,  0,  0],
      [14, 14, 14, 14, 14,  1,  1, 29, 29, 29, 18,  7,  7,  7,  0],
    ],
    rows: 15,
    cols: 15,
  },

  // 4x4 galaxies with two stars. Doubled-coord grid is (2*4-1) x (2*4-1) = 7x7,
  // so star coords range 0..6. Odd coord = between cells, even = cell center.
  // Stars at (1,3) and (5,3) sit between top two rows and between bottom two
  // rows respectively, partitioning the grid into 2 galaxies of 8 cells each.
  galaxiesTiny: {
    stars: [
      { row: 1, col: 3 },   // between rows 0-1, between cols 1-2
      { row: 5, col: 3 },   // between rows 2-3, between cols 1-2
    ],
    rows: 4,
    cols: 4,
  },

  // 7x7 galaxies, 3 stars positioned to force _search to actually recurse
  // (5 nodes per probe). Used to exercise the trail-based undo path —
  // galaxiesTiny solves via propagation alone and never triggers rollback.
  // Doubled coords for 7x7 range 0..12; even = cell center, odd = between.
  galaxiesSmall: {
    stars: [
      { row: 6, col: 6 },     // cell center (3,3) — middle of the grid
      { row: 2, col: 2 },     // cell center (1,1)
      { row: 10, col: 10 },   // cell center (5,5)
    ],
    rows: 7,
    cols: 7,
  },

  // 6x6 Binairo captured from puzzles-mobile.com/binairo/random/6x6-easy on
  // 2026-05-18. Givens: -1=blank, 0=given-zero, 1=given-one.
  binairo6x6: {
    rows: 6,
    cols: 6,
    givens: [
      [-1,  1, -1,  1, -1, -1],
      [-1, -1,  0, -1, -1, -1],
      [ 0,  0, -1, -1,  0, -1],
      [-1, -1, -1,  0, -1, -1],
      [ 0,  1, -1, -1,  0, -1],
      [ 0, -1, -1, -1, -1, -1],
    ],
  },

  // Binairo Plus 6x6 captured from puzzles-mobile.com/binairo-plus/random/
  // 6x6-easy on 2026-05-19. Flag encoding per the page engine:
  //   1=R-EQ, 2=R-NE, 4=D-EQ, 8=D-NE (OR-able).
  // Recon dump showed only the first 3 rows of comparisonClues; the
  // remaining rows are empty arrays which decode to zero constraints.
  // The captured task data is the full 6x6 givens.
  binairoPlus6x6: {
    rows: 6,
    cols: 6,
    givens: [
      [-1, -1, -1, -1,  1,  1],
      [-1,  1, -1, -1, -1, -1],
      [-1,  0, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1, -1],
    ],
    comparisonClues: [
      [4],
      [null, null, null, 2],
      [null, null, 10, 4],
      [],
      [],
      [],
    ],
  },

  // 5x5 Shikaku captured from puzzles-mobile.com/shikaku/random/5x5 on
  // 2026-05-19. 9 clues, areas summing to 25 (= 5×5).
  shikaku5x5: {
    rows: 5,
    cols: 5,
    clues: [
      { row: 0, col: 0, area: 4 },
      { row: 0, col: 3, area: 2 },
      { row: 1, col: 1, area: 2 },
      { row: 2, col: 2, area: 3 },
      { row: 2, col: 3, area: 4 },
      { row: 3, col: 1, area: 2 },
      { row: 3, col: 3, area: 2 },
      { row: 4, col: 3, area: 4 },
      { row: 4, col: 4, area: 2 },
    ],
  },

  // 6x6 Yin-Yang captured from puzzles-mobile.com/yin-yang/random/6x6-easy
  // on 2026-05-20. task: -1=no given, 0=given white, 1=given black.
  yinyang6x6: {
    rows: 6,
    cols: 6,
    task: [
      [-1, -1, -1,  1, -1,  0],
      [-1, -1,  0, -1,  1, -1],
      [-1,  0, -1, -1, -1, -1],
      [-1, -1,  0,  1, -1, -1],
      [-1, -1,  0, -1, -1, -1],
      [ 1, -1, -1, -1, -1, -1],
    ],
  },

  // 5x5 Slitherlink captured from puzzles-mobile.com/loop/random/5x5-normal
  // on 2026-05-22. task: -1=no clue, 0/1/2/3=count of loop edges around cell.
  slitherlink5x5: {
    rows: 5,
    cols: 5,
    task: [
      [-1, -1, -1, -1,  3],
      [-1,  2, -1, -1, -1],
      [-1,  2, -1,  0,  3],
      [-1,  1, -1, -1,  3],
      [-1,  2,  3,  1, -1],
    ],
  },

  // Tiny 3x3 Hashi sanity puzzle with a unique solution: four corner islands
  // forming a 1-2-2-1 cycle (single bridges around the loop).
  hashi3x3Tiny: {
    rows: 3, cols: 3,
    islands: [
      { index: 0, row: 0, col: 0, number: 1 },
      { index: 1, row: 0, col: 2, number: 2 },
      { index: 2, row: 2, col: 0, number: 2 },
      { index: 3, row: 2, col: 2, number: 1 },
    ],
  },

  // 7x7 Hashi captured from a real recon dump. Exercises both single and
  // double bridges plus crossing exclusion.
  hashi7x7Easy: {
    rows: 7, cols: 7,
    islands: [
      { index: 0, row: 0, col: 1, number: 4 },
      { index: 1, row: 0, col: 6, number: 3 },
      { index: 2, row: 1, col: 0, number: 2 },
      { index: 3, row: 1, col: 5, number: 1 },
      { index: 4, row: 2, col: 3, number: 1 },
      { index: 5, row: 5, col: 1, number: 4 },
      { index: 6, row: 5, col: 3, number: 4 },
      { index: 7, row: 5, col: 5, number: 2 },
      { index: 8, row: 6, col: 0, number: 3 },
      { index: 9, row: 6, col: 6, number: 2 },
    ],
  },
};
