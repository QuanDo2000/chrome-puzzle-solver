'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyLoopStep } = require('../src/widget/widget.js');

// runLoop applies each Loop step's hint to the page. For most puzzles it writes
// the full read-back grid via applySolution(grid) — undecided cells round-trip
// as empty, so re-applying the whole grid is harmless. But shakashaka's
// read↔apply round-trip is NOT identity: readState maps every undecided open
// cell to 0, and applyShakashakaState maps 0 to a COMMITTED white (cellStatus 5).
// Applying the full grid therefore over-commits every still-undecided cell to
// white, corrupting the board and misleading the next deductive hint. Puzzles
// with that property opt into reg.loopApplyViaHint and must apply ONLY the hint
// delta through the custom applyHint hook (dispatchApplyHint), never the full
// grid. Regression for the incomplete shakashaka over-commit fix (commit 3da71ee
// only patched the Hint button / pending-hint apply, not the Loop's per-step
// apply).

function spies() {
  const calls = [];
  const applySolution = async (arg) => { calls.push(['applySolution', arg]); return { success: true }; };
  const dispatchApplyHint = async (hint) => { calls.push(['dispatchApplyHint', hint]); return true; };
  const applyHintToGrid = (grid, hint) => { calls.push(['applyHintToGrid', grid, hint]); };
  return { calls, applySolution, dispatchApplyHint, applyHintToGrid };
}

test('applyLoopStep: a full-grid puzzle merges the hint then applies the read-back grid', async () => {
  const { calls, ...deps } = spies();
  const grid = [[0, 1], [2, 0]];
  const hint = { type: 'tents', cells: [] };
  const ar = await applyLoopStep({}, hint, grid, deps);
  assert.deepEqual(ar, { success: true });
  assert.deepEqual(calls, [['applyHintToGrid', grid, hint], ['applySolution', grid]]);
});

test('applyLoopStep: a loopApplyViaHint puzzle applies only the hint delta — never merges or applies the full grid', async () => {
  const { calls, ...deps } = spies();
  const grid = [[0, 0], [0, 0]];
  const hint = { type: 'shakashaka', extraCells: [{ row: 0, col: 0, value: 1 }] };
  const ar = await applyLoopStep({ loopApplyViaHint: true }, hint, grid, deps);
  assert.deepEqual(ar, { success: true });
  assert.deepEqual(calls, [['dispatchApplyHint', hint]]);
  // crucially, the full grid is neither merged nor applied — that is what
  // over-commits every undecided cell to white/X.
  assert.ok(!calls.some(c => c[0] === 'applySolution'), 'full grid must not be applied');
  assert.ok(!calls.some(c => c[0] === 'applyHintToGrid'), 'grid must not even be built');
});

test('applyLoopStep: a galaxies hint applies its computed lines without touching the grid', async () => {
  const { calls, ...deps } = spies();
  const ar = await applyLoopStep({}, { type: 'galaxies', lines: ['L'] }, [], deps);
  assert.deepEqual(ar, { success: true });
  assert.deepEqual(calls, [['applySolution', { type: 'galaxies-lines', lines: ['L'] }]]);
});

// Boundary guard: loopApplyViaHint must be set by EXACTLY the puzzles whose
// apply*State writer commits the undecided sentinel (0) to a real value —
// shakashaka (0 -> white) and lightup (0 -> X). Those are the puzzles that
// over-commit if Loop re-applies the full read-back grid. lollipops/pipes have
// custom applyHint hooks too, but their writers leave undecided cells untouched
// (lollipops) / use rotation counts (pipes), so they must NOT set the flag.
// Without this guard, a missed flag is a silent board-corruption bug no other
// test catches (it was missed for lightup in the first pass).
test('loopApplyViaHint is set for exactly the over-committing puzzles', () => {
  const reg = (t) => require(`../src/widget/puzzles/${t}.js`);
  assert.equal(reg('shakashaka').loopApplyViaHint, true, 'shakashaka over-commits 0->white');
  assert.equal(reg('lightup').loopApplyViaHint, true, 'lightup over-commits 0->X');
  assert.equal(reg('lollipops').loopApplyViaHint, undefined, 'lollipops leaves undecided untouched');
  assert.equal(reg('pipes').loopApplyViaHint, undefined, 'pipes writes rotation counts, no undecided sentinel');
});
