# Shakashaka puzzle support — design

**Status:** approved (brainstorm)
**Date:** 2026-06-03
**Site:** puzzles-mobile.com `/shakashaka/` (slug `shakashaka`).

## Summary

Add full Shakashaka support to the extension — Detect / Solve / Hint / Loop —
mirroring the other 16 puzzles. Shakashaka here is a **CSP with purely local
constraints**: each open cell takes one of {white, 4 triangle orientations},
subject to local edge-matching (the page's `hasNonRect`) plus number clues (the
page's `taskMarkedCount`). Solved by propagation + backtracking, with the ported
page predicates as the ground-truth validity oracle.

## Recon: the page encoding (ground truth, captured from `window.Game`)

### `task` (the givens), a `puzzleHeight × puzzleWidth` int grid
- `-1` = **open** cell (player may place a triangle or leave white).
- `-2` = **black** cell, no number (a fixed wall).
- `0..4` = **black** cell **with a number clue** (also a fixed wall).

(Dimensions come from the `task` array — `Game.rows/cols` are undefined; the
page uses `p.puzzleHeight`/`p.puzzleWidth`. The captured board is 25×25 even
though the URL said `5x5`.)

### `currentState.cellStatus`, same dims — the player's moves
- `0` = empty / undecided.
- `1,2,3,4` = the four **triangle orientations**.
- `5` = **explicit white** marker (no triangle).
- (`currentState.autoX` is an auto-cross helper, not needed by the solver.)

### `getBoardCellSt(t,e)` — the board-state mapping the rules use
```
if task[t][e] != -1        -> -1   (black cell / wall)
else if cellStatus == 5    ->  0   (white)
else                       ->  cellStatus   (0 white, or 1..4 triangle)
```
So **white = cellStatus 0 OR 5** (both map to board-state 0); the solver works
in board-state space: black = -1 (fixed), open ∈ {0,1,2,3,4}.

### Rule 1 — number clues (`taskMarkedCount(t,e)`, ported verbatim)
Counts the orthogonal neighbors (W,E,N,S, in-range) whose `cellStatus` is `1..4`
(a triangle). A numbered black cell with clue `k` requires `taskMarkedCount == k`
in the final solution (and `> k` is an immediate error mid-solve).

### Rule 2 — rectangle rule (`hasNonRect()`, ported verbatim)
A **per-cell local predicate** over each open cell (`task == -1`) and its
neighbors; returns the first offending `[t,e]` or `false`. Let
`i = getBoardCellSt(t,e)` (0 white, 1..4 triangle). The exact logic (decoded from
source — this is the spec to port):

- **White cell (`i==0`):** at each diagonal corner, if the two orthogonal
  neighbors toward that corner are both white (board-state 0/falsy) but the
  diagonal neighbor `o` is non-white (truthy: triangle or black) AND `o` is not
  the corner's matching triangle type → violation. Matching types:
  up-left→1, up-right→2, down-right→3, down-left→4.
- **Triangle `i==1`:** right neighbor must be `2` (if non-white) else (white) the
  up-right must be `1`; AND down neighbor must be `4` (if non-white) else (white)
  the down-left must be `1`; border on the required side → violation.
- **Triangle `i==2`:** left neighbor `1` (else up-left must be `2`); down neighbor
  `3` (else down-right must be `2`); borders → violation.
- **Triangle `i==3`:** left neighbor `4` (else down-left must be `3`); up neighbor
  `2` (else up-right must be `3`); borders → violation.
- **Triangle `i==4`:** right neighbor `3` (else down-right must be `4`); up
  neighbor `1` (else up-left must be `4`); borders → violation.

(`rr(t,e)=(t+e+3)%4+1` is the page's rotation helper used in
`getPossibleTriangles`, the page's own per-cell triangle deduction — a useful
cross-check reference, NOT required to port.)

A complete assignment is **valid** iff `hasNonRect()` returns false AND every
numbered clue's `taskMarkedCount` equals its number.

## Architecture & files (the established puzzle-addition shape)

- **`src/solvers/shakashaka.js`** — pure `ShakashakaSolver` (no DOM). Holds the
  CSP solver, the ported `hasNonRectAt`/`taskMarkedCount` validity oracle, and
  `solve()` returning `{ solved, cells, error?, partial? }` where `cells` is the
  per-cell board-state grid (−1 black, 0 white, 1..4 triangle); partial-on-timeout.
- **`src/widget/puzzles/shakashaka.js`** — registry hooks: `cacheKey`,
  `solveExtraData`, `solutionFromResult`, `hintDispatch` (deductive),
  `loopDoneCheck`, `applyHint`, `drawStaticLayer`/preview, `canvasDims`,
  `staticSig`.
- **`main-world.js`** — `readShakashakaData`, `applyShakashakaState`, and a
  `/shakashaka/` dump branch (extraction **inlined**). Self-contained
  (`fn.toString()` serialized): no outer-scope/sibling refs.
- **`background.js`** + **`globals.d.ts`** — add both fn names to
  `EXEC_MAIN_ALLOWLIST` and `MainWorldFn` (kept in sync).
- **`solver.worker.js`** — a `shakashaka` dispatch branch.
- **`handler.js`** — register the handler.
- **Tests** — `tests/shakashaka.test.js`, a `real-puzzles.js` fixture (the 25×25),
  a bench.
- **`manifest.json`** — content script already matches `puzzles-mobile.com/*`
  (confirm; likely no change). `npm run build` after solver/widget/main-world/
  handler/worker edits.

## Solver model & method

**Variables:** each open cell, domain ⊆ {0,1,2,3,4} (white + 4 triangles).
Black cells fixed at −1.

**Constraints:** ported `taskMarkedCount` (number clues) + ported `hasNonRect`
local predicate (rectangle rule).

**Solve = propagation + MRV backtracking + trail undo:**
- Per-cell domains. **Forward-checking / local consistency:** prune a candidate
  value at a cell when, combined with already-decided neighbors, it makes some
  cell's local `hasNonRect` predicate unsatisfiable (no completion of that cell's
  still-open neighbors satisfies it), or when number-clue counting around a
  numbered cell is already exceeded / can no longer be reached.
- When propagation stalls, branch on the most-constrained open cell; recurse with
  trail-based undo.
- `maxMs` budget; on timeout return a **sound partial** (the propagation-determined
  cells) — same contract/shape as the other puzzles' partials.

**Soundness discipline (absolute):** the ported `hasNonRect` + `taskMarkedCount`
are ground truth. The solver's propagation must NEVER prune a value used by some
valid completion (no spurious UNSAT) and NEVER accept an invalid board. Verified
by a brute-force cross-check (below). Real Shakashaka are unique, so any valid
full assignment is the intended solution.

## Widget integration

- **Detect** on `/shakashaka/`; `readShakashakaData` returns `{ task, rows, cols }`.
  Background auto-solve as for the others.
- **Solve→Confirm:** run solver → preview → `applyShakashakaState`.
- **Hint (deductive):** `hintDispatch` returns a batch of cells the propagation
  forces from the current board (forced triangles AND forced whites), batch-capped
  per the Loop scaling rule; falls back to the cached solution when logic is
  exhausted.
- **Loop:** apply hint batches until `loopDoneCheck` matches the solution.
- **Preview:** draw black cells (+ numbers), white cells, and the 4 triangle
  orientations. The exact half-cell geometry of `cell-1`…`cell-4` is pinned
  against the page CSS during implementation so the preview matches the applied
  result. Diff-ringing reuses the generic cell-diff.
- **Write contract (`applyShakashakaState`):** triangles → cellStatus 1–4, white
  cells → **5** (explicit; confirm 5-vs-0 registers as solved on the live page).
  `saveState(true)` BEFORE writes, then the canonical render ladder; **never**
  `check()`.

## Testing & verification

- **Ported-oracle units:** pin `hasNonRectAt` + `taskMarkedCount` with cases from
  the decoded spec (each triangle type's matching rule; the white-corner rule; a
  numbered cell's adjacent-triangle count).
- **Brute-force cross-check (the soundness gate):** an independent brute-force
  solver enumerating ALL valid assignments on small boards; assert the CSP solver
  (a) never prunes a value some valid solution uses, (b) never outputs a board the
  ported oracle rejects, (c) every cell it reports "forced" holds in EVERY valid
  solution. (Same oracle-gated method as the Shingoki work.)
- **Fixtures:** the captured 25×25 in `real-puzzles.js`; small hand-built unique
  boards.
- **Validity:** every solver output passes the ported oracle.
- **Performance:** measure solve time on the real 25×25; report honest
  full-solve-vs-sound-partial (do not pre-promise a fast 25×25). Lint, typecheck,
  build gated.

## Open items resolved during implementation (not blockers)

- Exact triangle pixel geometry for the preview (matched to the page CSS classes
  `cell-1`…`cell-4`).
- Whether white cells should be applied as `5` (explicit) or `0` (blank) to
  register as solved — confirm on the live page.

## Out of scope (YAGNI)

- Any change to the other 16 puzzles or shared infrastructure beyond the registry/
  allowlist additions.
- Optimizing the 25×25 beyond what propagation+backtracking gives (a separate
  measure-driven effort if needed, like the Shingoki deduction work).
- Solving variants/sizes not served by `/shakashaka/`.
