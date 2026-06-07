'use strict';

// Convert a solved pipe mask back into the number of page rotation steps to
// apply to the given task mask. Parametrised by page rotation direction
// (pageCW) so the live probe only sets a flag. Returns the smallest k in 0..3
// (smallest matters for symmetric pieces, which match at multiple k).
function rotationCount(taskMask, solvedMask, pageCW) {
  // CW step: N->E->S->W (== ((m<<1)|(m>>3))&0xF). CCW step: the inverse.
  const stepCW = (m) => ((m << 1) | (m >> 3)) & 0xF;
  const stepCCW = (m) => ((m >> 1) | (m << 3)) & 0xF;
  const step = pageCW ? stepCW : stepCCW;
  let m = taskMask & 0xF;
  for (let k = 0; k < 4; k++) {
    if (m === (solvedMask & 0xF)) return k;
    m = step(m);
  }
  return 0; // unreachable for a valid rotation pair; 0 is a safe no-op
}

// Rotate a 4-bit pipe mask `count` page-steps. pageCW selects the per-step bit
// transform (must match rotationCount): CW = ((m<<1)|(m>>3))&0xF, CCW inverse.
// This is the forward direction of rotationCount — used to compare a cell's
// CURRENT shape against its solved shape by mask, so symmetric pieces that match
// at multiple counts are judged by what they look like, not by their count.
function rotateMask(taskMask, count, pageCW) {
  const stepCW = (m) => ((m << 1) | (m >> 3)) & 0xF;
  const stepCCW = (m) => ((m >> 1) | (m << 3)) & 0xF;
  const step = pageCW ? stepCW : stepCCW;
  let m = taskMask & 0xF;
  const turns = ((count % 4) + 4) % 4;
  for (let t = 0; t < turns; t++) m = step(m);
  return m;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { rotationCount, rotateMask };
}
