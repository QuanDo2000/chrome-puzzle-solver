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

  // 4x4 galaxies with two stars centered on cell (0,0) and cell (3,3).
  // GalaxiesSolver uses "doubled" star coords: cell center = (2r+1, 2c+1).
  galaxiesTiny: {
    stars: [
      { row: 1, col: 1 },   // center of cell (0, 0)
      { row: 7, col: 7 },   // center of cell (3, 3)
    ],
    rows: 4,
    cols: 4,
  },
};
