'use strict';
// Canvas-rendering helpers for the puzzle-preview overlay. Extracted
// from content.js's makeWidget closure (Stage A of the Phase 2
// refactor — see docs/superpowers/specs/2026-05-25-content-js-split-
// phase-2-stage-a-design.md). Stage A0 lands the sig hashers; Stage
// A1 follows with the canvas-layer builders; Stage A2 promotes
// drawPreview.

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {};
}
