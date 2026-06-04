# Light Up (Akari) puzzle support — design

**Status:** approved (brainstorm)
**Date:** 2026-06-04
**Site:** puzzles-mobile.com `/light-up/` (slug `lightup`).

## Summary

Add full Light Up (Akari) support — Detect / Solve / Hint / Loop — mirroring the
other 18 puzzles. Each white cell is a bulb / no-bulb variable; constraints are
coverage (every white cell lit), no-collision (no two bulbs see each other), and
numbered-black clue counts. A propagation + backtracking CSP, with the page's
`getErrors`/`taskMarkedCount` ported as the validity oracle. Akari propagates
strongly, so the 25×25 has a real chance of fully solving.

## Recon: the page encoding (ground truth, from `window.Game`)

### `task` (givens), `puzzleHeight × puzzleWidth` int grid
- `-1` = **white** / open cell (may hold a bulb).
- `-2` = **black** cell, no number (a wall, blocks light).
- `0..4` = **black** cell **with a number clue** (also a wall).

### `currentState.cellStatus`, same dims — the player's moves
- `0` = empty (no bulb, undecided).
- `1` = **bulb** (lightbulb).
- `2` = **X** marker (no bulb here).
(`currentState.autoX` is an auto-cross helper, not needed by the solver.)

### Rule 1 — number clues (`taskMarkedCount`, ported verbatim)
Counts orthogonal neighbours (W,E,N,S, in-range) whose `cellStatus == 1` (a bulb).
A numbered black cell with clue `k` requires `taskMarkedCount == k` in the final
solution. `taskEmptyCount` counts white neighbours that are not bulbs and not yet
lit (still bulb-able); `getErrors` uses `bulbs > k` or `bulbs + empty < k` as
mid-solve infeasibility.

### Rule 2 + 3 + 4 — illumination / collision / coverage (`getErrors`, ported)
For each bulb (`cellStatus == 1`): mark its own cell lit, then walk right, left,
down, up, marking each WHITE cell (`task` undefined for that DOM cell — i.e.
`task[r][c] == -1` in solver space) as lit until a black cell blocks; if any cell
in those segments also holds a bulb → **lightCollision**. Numbered cells:
`taskMarkedCount != k` (final) / `> k` / `+empty < k` → **taskViolation**. Black
cells count as covered. Finally every cell must be lit, else **hasEmpty**.

So a complete board is **valid** iff: every numbered clue's adjacent-bulb count
equals its number; no bulb lies in another bulb's unblocked segment; and every
white cell is lit (is a bulb or has a bulb in its row/column segment up to the
first black cell). (Verbatim source in the plan's Appendix — port from that.)

## Architecture & files (the established puzzle-addition shape)

- **`src/solvers/lightup.js`** — pure `LightUpSolver` (no DOM): the CSP solver +
  ported `getErrors`-equivalent / `taskMarkedCount` validity oracle. `solve()`
  returns `{ solved, cells, error?, partial? }` where `cells[r][c]` is `-1` black,
  `0` no-bulb, `1` bulb (or `9` UNK in partials); partial-on-timeout.
- **`src/widget/puzzles/lightup.js`** — registry hooks: `cacheKey`,
  `solveExtraData`, `solutionFromResult`, `hintDispatch` (deductive),
  `loopDoneCheck`, `applyHint`, `drawStaticLayer`/preview, `canvasDims`,
  `staticSig`, `partialResultArm`.
- **`main-world.js`** — `readLightUpData`, `readLightUpState`, `applyLightUpState`
  (self-contained; bulb→cellStatus 1, UNK-skip), `/light-up/` dump branch
  (inlined). All `fn.toString()`-serialized: no outer-scope/sibling refs.
- **`background.js`** + **`globals.d.ts`** — add the three fn names to
  `EXEC_MAIN_ALLOWLIST` and `MainWorldFn`; add `LightUpSolver` decl.
- **`solver.worker.js`** dispatch branch; **`handler.js`** registration; the two
  bundlers (`build-solver-bundle.js` FILES/EXPORTS, `build-content-bundle.js`
  WIDGET_FILES) + `src/widget/puzzles/index.js` registration.
- **Tests** — `tests/lightup.test.js`, a `real-puzzles.js` `lightup_25x25` fixture,
  a bench. `manifest.json` already matches `puzzles-mobile.com/*`.

## Solver model & method

**Variables:** each white cell, domain ⊆ {0 no-bulb, 1 bulb}, UNK undecided.
Black cells fixed (−1).

**Constraints:** ported coverage + no-collision + clue counts (the oracle).

**Solve = propagation + MRV backtracking + trail undo:**
- **Clue forcing:** numbered cell with `b` decided bulbs, `a` undecided white
  neighbours — `b == k` → undecided neighbours no-bulb; `b + a == k` → all
  undecided neighbours bulbs; `b > k` or `b + a < k` → contradiction.
- **No-collision propagation:** placing a bulb marks every cell in its
  unblocked row/column segment *lit* and *no-bulb*.
- **Coverage forcing:** for an unlit non-bulb white cell, its *lighter set* =
  cells that could still host a bulb to light it (itself + segment cells still
  bulb-able); one remaining → force that bulb; zero → contradiction.
- MRV branch when propagation stalls; recurse with trail/snapshot undo.
- `maxMs` budget; **sound partial on timeout** = the propagation-determined cells
  (the root snapshot, NOT speculative mid-search state — the Shakashaka lesson).

**Soundness (absolute gate):** the ported oracle is ground truth. Propagation
never prunes a value some valid solution uses, never accepts an invalid board,
never spurious-UNSAT. Verified by a brute-force cross-check — binary domains mean
`2^open`, so the cross-check covers larger small boards cheaply (every forced cell
holds in every solution; solver-solved ⟺ brute-force non-empty; output passes the
oracle). Real Akari are unique, so any valid full assignment is the solution.

## Widget integration

- **Detect** on `/light-up/`; `readLightUpData` → `{ task, rows, cols }`.
- **Solve→Confirm:** solver → preview → `applyLightUpState`.
- **Hint (deductive):** `hintDispatch` returns forced cells (bulbs `1` AND
  no-bulbs `0`) from the current board via propagation, batch-capped; falls back
  to the cached-solution diff.
- **Loop:** apply hint batches. **`applyHint` writes ONLY the hint cells**
  (UNK=9 elsewhere); **`applyLightUpState` SKIPS UNK** (preserves current
  cellStatus) — the Shakashaka over-commit fix, baked in from the start.
- **Preview:** black cells (+ numbers) on the static layer; bulbs (glyph) +
  X markers on the dynamic layer; optional lit-cell tint. (Trivial geometry.)
- **Write contract:** bulb → cellStatus `1`; no-bulb → `2` (X) [or blank —
  confirm at live-verify which reads as "solved"]; UNK → skip. `saveState(true)`
  before, render ladder after, never `check()`.

## Testing & verification

- **Ported-oracle units:** pin `taskMarkedCount` (adjacent bulbs) and the
  illumination/collision/coverage check with hand cases.
- **Brute-force cross-check (the gate):** enumerate all valid bulb placements on
  small boards (2^open); assert the solver never prunes a value a solution uses,
  never spurious-UNSAT, output always passes the oracle, forced cells hold in
  every solution. Mutation-tested harness (same discipline as Shakashaka).
- **Fixtures:** the captured 25×25; small hand-built unique boards.
- **Performance:** measure solve time on the real 25×25; report full-solve vs.
  sound partial honestly. Lint/typecheck/build gated.

## Open items (non-blockers, resolved at live-verify)

- Whether no-bulb cells need explicit X (cellStatus 2) vs blank (0) to register as
  solved on the live page.

## Out of scope (YAGNI)

- Any change to the other puzzles / shared infra beyond registry/allowlist adds.
- Solving sizes/variants not served by `/light-up/`.
- Changing the ported oracle (it is the spec).
