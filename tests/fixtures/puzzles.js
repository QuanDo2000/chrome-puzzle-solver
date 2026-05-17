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
};
