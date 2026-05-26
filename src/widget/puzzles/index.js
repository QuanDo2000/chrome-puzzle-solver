'use strict';
// Per-puzzle registry. Populated by Phase 3 of the content.js split —
// each src/widget/puzzles/<type>.js will export a module that gets
// registered here. Empty by default; the registry-first fallback
// dispatchers in cache.js / preview.js / widget.js skip the lookup
// when PUZZLES[type] is undefined.
const PUZZLES = {};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PUZZLES };
}
