'use strict';

// Shared, dependency-free helpers for the solver layer. Concatenated FIRST
// into dist/solver.js by scripts/build-solver-bundle.js. Consumer files import
// these helpers via a relative require of this module, which the bundler
// strips (in the bundle the helpers are already top-level globals). See
// docs/superpowers/specs/2026-05-29-solver-shared-utils-design.md.

// FNV-1a 32-bit hash. Callers feed bytes via the `mix` callback so each
// call site keeps its own byte sequence; this preserves byte-identical keys
// versus the previous per-solver inline implementations.
function hashFNV1a(feed, mask = true) {
  let h = 0x811c9dc5;
  const mix = mask
    ? (n) => { h ^= n & 0xff; h = Math.imul(h, 0x01000193) >>> 0; }
    : (n) => { h ^= n; h = Math.imul(h, 0x01000193) >>> 0; };
  feed(mix);
  return h >>> 0;
}

// Rebuild a 1-D cellStatus array into a rows×cols 2-D grid (the shape every
// grid solver's _emit() returns).
function emitGrid(cellStatus, rows, cols) {
  const grid = [];
  for (let r = 0; r < rows; r++) {
    const row = new Array(cols);
    for (let c = 0; c < cols; c++) row[c] = cellStatus[r * cols + c];
    grid.push(row);
  }
  return grid;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { hashFNV1a, emitGrid };
}
