'use strict';

// Shared, dependency-free helpers for the widget layer. Concatenated FIRST
// into dist/content.js by scripts/build-content-bundle.js. Consumer files
// import these helpers via a relative require of this module, which the
// bundler strips (in the bundle the helpers are already top-level globals).
// Kept per-layer (a separate copy from src/solvers/shared.js) so each bundler
// stays self-contained — see the Track-A design spec.

// FNV-1a 32-bit hash — identical to the solver-layer copy.
function hashFNV1a(feed, mask = true) {
  let h = 0x811c9dc5;
  const mix = mask
    ? (n) => { h ^= n & 0xff; h = Math.imul(h, 0x01000193) >>> 0; }
    : (n) => { h ^= n; h = Math.imul(h, 0x01000193) >>> 0; };
  feed(mix);
  return h >>> 0;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { hashFNV1a };
}
