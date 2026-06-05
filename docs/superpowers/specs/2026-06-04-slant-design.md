# Slant (Gokigen Naname) puzzle support — design

**Status:** approved (brainstorm)
**Date:** 2026-06-04
**Site:** puzzles-mobile.com `/slant/` (slug `slant`).

## Summary

Add full Slant support (Detect / Solve / Hint / Loop), wired as a per-cell-state
puzzle (like Light Up / Shakashaka — NOT the edge-loop puzzles). Each cell holds
one diagonal (`\` or `/`); each diagonal is an edge between two opposite cell
corners (vertices); vertex clues count incident diagonals; the diagonal graph must
be acyclic (a forest — no loops). The solver ports the page `getErrors` as its
validity oracle, propagates clue-degree + acyclicity (union-find) deductions,
DFS-searches with rollback union-find cycle detection, and returns a sound partial
on timeout. Expectation: small/easy boards solve instantly; the real 20×20 likely
full-solves (Slant deductions are strong and local), with the sound-partial path
as the guaranteed floor — measured honestly before the plan ships.

## Recon: the page encoding (ground truth, from `window.Game`)

### `task` (givens), `(H+1) × (W+1)` vertex-clue grid
- `-1` = no clue at that vertex · `0..4` = required count of diagonals meeting there.
- Captured board: `puzzleWidth = puzzleHeight = 20` → cells 20×20, vertices 21×21,
  `task` is 21×21. (The `/slant/random/5x5-easy` URL loaded a 20×20 board; the
  feature supports any size — 5×5 solves trivially.)

### `currentState.cellStatus`, `H × W` — the player's diagonals
- `0` empty · `1` = `\` (connects top-left↔bottom-right) · `2` = `/`
  (connects top-right↔bottom-left). Confirmed by `taskMarkedCount` + `drawCellStatus`
  (`cell-off`=0, `cell-on`=1, `cell-x`=2).

### Cell ↔ vertex geometry
- Cell `(r,c)` `\` (1): edge between vertex `(r,c)` and `(r+1,c+1)`.
- Cell `(r,c)` `/` (2): edge between vertex `(r,c+1)` and `(r+1,c)`.
- Vertex `(t,e)`'s 4 incident cell-slots (in-grid-guarded): `(t-1,e-1)` points iff `\`;
  `(t,e)` points iff `\`; `(t-1,e)` points iff `/`; `(t,e-1)` points iff `/`.

### Validity rules (decoded from `getErrors`; verbatim source in the plan Appendix)
`getErrors(t)` (t = full-check flag):
1. For every clued vertex `(i,s)`: `taskMarkedCount(i,s)` = incident-diagonal count.
   Violation if (full-check) `count != clue`, or `count > clue`, or
   `taskXCount(i,s) > 4 - clue` (`taskXCount` = the # of the 4 slots that are
   out-of-grid OR decided to the non-pointing diagonal).
2. `getLoopCells()` peels degree-1 leaves repeatedly; any cell still set is part of
   a cycle → error. I.e., the diagonal graph must be **acyclic (a forest)**. The
   forest need NOT be connected.

So a complete board is valid iff every clued vertex's incident-diagonal count equals
its clue and the diagonal graph has no cycle.

## Architecture & files

Wired like the cell-state puzzles (Light Up / Shakashaka); no changes to existing
puzzles or to `preview.js`'s core.

**New**
- `src/solvers/slant.js` — `SlantSolver` (pure logic): ported oracle + clue/acyclicity
  propagation + DFS; returns `{ solved, cells, partial?, error? }` where
  `cells[r][c] ∈ { 1 ('\'), 2 ('/'), 9 UNK }`.
- `src/widget/puzzles/slant.js` — registry module (cacheKey, canvasDims with
  `marginCells` gutter, staticSig, drawStaticLayer = vertex clue numbers,
  drawPreviewCell = diagonal, solveExtraData, solutionFromResult, hintDispatch,
  loopDoneCheck, applyHint, partialResultArm).
- `tests/slant.test.js` (oracle + brute-force soundness gate + solve), a
  `slant_20x20` fixture in `tests/fixtures/real-puzzles.js`, `tests/bench-slant.js`.

**Modified (standard wiring touchpoints)**
- `solver.worker.js` — `else if (type === 'slant')` dispatch (`maxMs:30000`).
- `scripts/build-solver-bundle.js` — `slant.js` in FILES, `SlantSolver` in EXPORTS.
- `scripts/build-content-bundle.js` — `puzzles/slant.js` in WIDGET_FILES (before
  `puzzles/index.js`).
- `handler.js` — `slantHandler` (matches `/slant/`; detect/readState/applySolution)
  + `registerHandler`.
- `main-world.js` — `readSlantData` / `readSlantState` / `applySlantState` +
  `/slant/` dump branch.
- `background.js` — three names in `EXEC_MAIN_ALLOWLIST`; `globals.d.ts` —
  `SlantSolver` decl + three `MainWorldFn` entries; `eslint.config.js` —
  `SlantSolver`/`slant` readonly globals.
- `src/widget/puzzles/index.js` — register `slant`.
- `src/solvers/diff.js` — Slant uses the generic per-cell diff (compare `cells`);
  confirm during the plan whether the default cell-grid path already handles it or
  a `slant` registration is needed.

## Solver model & method

**Model.** Vertices `(t,e)`, `t∈0..H, e∈0..W`, flattened `vid = t·(W+1)+e`. Each cell
binary `\` (1) / `/` (2); `\` = edge `(r,c)–(r+1,c+1)`, `/` = edge `(r,c+1)–(r+1,c)`.

**Oracle `_isValid(cells)`** — ported `getErrors`: (1) every clued vertex's
incident-diagonal count equals the clue; (2) the diagonal-edge graph is acyclic
(union-find: any edge joining two already-connected vertices is a cycle).

**Propagation (sound, to a fixpoint), with an incremental rollback union-find of
committed cells:**
- **Clue forcing:** per clued vertex, count incident pointing / not-pointing /
  undecided cells; `pointing == clue` → force undecided to non-pointing;
  `pointing + undecided == clue` → force undecided to pointing; `pointing > clue`
  or `pointing + undecided < clue` → contradiction. ("Force pointing/not-pointing"
  fixes the cell's diagonal orientation.)
- **Acyclicity forcing:** for each undecided cell, if its `\` edge would join two
  already-connected vertices → force `/`; if `/` would too → force `\`; if both → 
  contradiction. Committing a cell unions its edge into the union-find.
- The union-find supports `mark()`/`rollback(mark)` (a trail of unions) so DFS
  backtracking is O(undone-work).

**Search + partial.** MRV/DFS over undecided cells (branch, propagate, rollback on
backtrack) under `maxMs`; on timeout return the **sound root-propagation snapshot**
(UNK where undecided) — never speculative search state.

**Soundness gate.** Brute-force all `2^cells` assignments on tiny boards, keep those
passing `_isValid`, and assert: propagation never prunes a value some solution uses;
solver-solved ⟺ brute-force-nonempty; every forced cell holds in all solutions;
`solve()` output always passes the oracle. Validated with a throwaway prototype
(plus the real 20×20 reach) before the plan ships.

## Widget integration

- **Detect/Solve:** handler matches `/slant/`; `readSlantData` → `{rows,cols,task}`;
  worker `SlantSolver`; preview → `applySlantState`.
- **MAIN-world** (self-contained): `readSlantState()` → `{cellStatus}`;
  `applySlantState(solution)`: `saveState(true)` before, write `1→1 / 2→2`, skip
  UNK(9), render ladder after, never `check()`. Plus the `/slant/` dump branch.
- **Rendering (standard cell-state hooks):** `drawStaticLayer` draws vertex clue
  numbers at lattice points `(e·cs, t·cs)` on small discs; `canvasDims marginCells:
  0.5` so border-vertex clues aren't clipped. `drawPreviewCell` draws the diagonal
  (`1`=`\` TL→BR, `2`=`/` TR→BL; `0`/UNK nothing). Mistakes use the generic per-cell
  diff (Slant's grid/solution are ordinary 2-D cell grids — `firstMismatch` and the
  default cell-diff work unchanged; none of the Masyu edge-object pitfalls apply).
- **Hint/Loop:** `hintDispatch` runs propagation against the live `cellStatus` and
  returns forced cells `{row,col,value∈{1,2}}`, batch-capped; falls back to revealing
  cached-solution cells. `applyHint` writes ONLY the hint cells (UNK elsewhere).
  `loopDoneCheck` true when every solution cell is on the board. Hints carry `.cells`
  (normal cell shape), so the Loop driver's guard is satisfied with no extra flag.

## Testing & verification

- **Oracle units:** clue-degree exact at corner/edge/interior vertices; a valid
  acyclic board accepted; a 4-cell diagonal cycle rejected.
- **Brute-force soundness gate (the gate):** as above, on tiny boards.
- **Fixtures:** real `slant_20x20` capture; small hand-built unique boards.
- **Performance:** bench the real 20×20; report full-solve vs sound partial honestly.
  Lint/typecheck/build gated.

## Open items (non-blockers, resolved at live-verify)

- Diagonal line direction (`1`=`\` vs `/`) and vertex-clue placement on the live
  page (low-risk — `taskMarkedCount` already pins `1`=`\` / `2`=`/`).

## Out of scope (YAGNI)

- Any change to other puzzles / shared infra beyond the registry/allowlist adds.
- Variants/sizes not served by `/slant/`.
- Changing the ported oracle (it is the spec).
