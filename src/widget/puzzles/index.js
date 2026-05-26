'use strict';
// Per-puzzle registry. Populated as Phase 3 of the content.js split
// progresses — each src/widget/puzzles/<type>.js file declares its module
// as a bundle-scope `const <type> = { ... }` and is concatenated before
// this file by scripts/build-content-bundle.js. The typeof guard here
// keeps the file loadable both in the bundle (where prior siblings
// supply the consts) and in vm-context Node tests (where this file may
// be loaded standalone — the registry stays empty in that case).
const PUZZLES = (typeof nonogram !== 'undefined') ? { [nonogram.type]: nonogram } : {};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PUZZLES };
}
