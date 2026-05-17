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

  // 2x2 aquarium from test_instrument.js (known working input).
  aquariumTiny: {
    rowClues: [0, 2],
    colClues: [1, 1],
    regionMap: [[0, 1], [0, 1]],
    rows: 2,
    cols: 2,
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
};
