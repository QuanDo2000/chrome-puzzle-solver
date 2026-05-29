'use strict';

// Shared, dependency-free helpers for the solver layer. Concatenated FIRST
// into dist/solver.js by scripts/build-solver-bundle.js; consumer files
// `require('./shared.js')` and the bundler strips that require line (the
// helpers become bundle-scope globals). See
// docs/superpowers/specs/2026-05-29-solver-shared-utils-design.md.

// FNV-1a 32-bit hash. Callers feed bytes via the `mix` callback so each
// call site keeps its own byte sequence; this preserves byte-identical keys
// versus the previous per-solver inline implementations.
function hashFNV1a(feed) {
  let h = 0x811c9dc5;
  const mix = (n) => { h ^= n & 0xff; h = Math.imul(h, 0x01000193) >>> 0; };
  feed(mix);
  return h >>> 0;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { hashFNV1a };
}
