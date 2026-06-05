# Star Battle puzzle support — design

**Status:** approved (brainstorm)
**Date:** 2026-06-05
**Site:** puzzles-mobile.com `/star-battle/` (slug `starbattle`).

## Summary

Add full Star Battle support (Detect / Solve / Hint / Loop), wired as a cell-state
CSP puzzle (like Light Up). Place exactly `k` stars in every row, column, and —
for the shaped variant — every region, with no two stars 8-adjacent. The shapeless
variant replaces regions with blocked **wall** cells. The solver ports the page
`getErrors` as its validity oracle, propagates count + adjacency deductions, MRV-
backtracks, and returns a sound partial on timeout. The puzzle has a unique
solution (the page checks against a fixed solution/hash). Supports any star count
and both variants. Real-board outcome (full solve vs sound partial) measured before
the plan ships.

## Recon: the page encoding (ground truth, from `window.Game`)

- **slug** `starbattle`; board is N×N where N = `puzzleWidth` = `puzzleHeight` =
  `puzzleWH`. (Captured board: 14×14.)
- **`task` is empty `[]`** on `window.Game`; the puzzle structure is parsed into
  `window.Game.areas` and `window.Game.walls` by `parseTask` from the closure
  config `f.task`.
  - **Shaped:** `areas` = N×N region map (values `0..N-1`); `walls` = `[]`.
  - **Shapeless:** `walls` = N×N `0/1` (1 = blocked cell); `areas` = N×N all-0.
- **`currentState.cellStatus`** = N×N: `0` empty · `1` star · `2` X-marker.
- **Star count `k`** = the closure `f.stars`, NOT on `window.Game`. Read it by
  scraping the page text: `document.body.innerText` contains the title
  `"14x14 / 3★ Hard Star Battle"` → match `/(\d+)★/` → `k = 3`.
- **Neighbour offsets** `dr = [-1,-1,-1,0,1,1,1,0]`, `dc = [-1,0,1,1,1,0,-1,-1]`
  (the 8 surrounding cells).

### Validity rules (decoded from `getErrors`; verbatim source in the plan Appendix)
`getErrors(t)` (t = full-check flag): counts stars per row (`s[n]`), column
(`r[c]`), and region (`i[area]`); flags **8-adjacent star pairs** (`"proximate"`);
then per index `h`: `s[h]>k`/`r[h]>k`/`i[h]>k` (shaped) → too-many; `s[h]<k`/
`r[h]<k`/`i[h]<k` (shaped) with the group full → too-few. Region checks are skipped
when `f.shapeless`. So a complete board is valid iff every row, column, and region
(shaped) has exactly `k` stars, and no two stars are 8-adjacent. The shapeless
`walls[n][c]` term marks blocked cells (stars go only on non-wall cells in the
unique solution).

## Architecture & files

Cell-state CSP puzzle wired like Light Up; both variants share one solver/handler.

**New**
- `src/solvers/starbattle.js` — `StarBattleSolver` (pure logic): ported oracle
  (`_isValid`), count + adjacency + region/wall propagation, MRV backtracking, sound
  partial. Returns `{ solved, cells, partial?, error? }`, `cells[r][c] ∈ { 1 star,
  0 no-star, 9 UNK }`.
- `src/widget/puzzles/starbattle.js` — registry module (cacheKey, canvasDims,
  staticSig, drawStaticLayer = region borders (shaped) / wall cells (shapeless),
  drawPreviewCell = star glyph, solveExtraData, solutionFromResult, hintDispatch,
  loopDoneCheck, applyHint, partialResultArm).
- `tests/starbattle.test.js` (oracle + brute-force soundness gate + solve), a
  `starbattle_14x14` fixture in `tests/fixtures/real-puzzles.js`,
  `tests/bench-starbattle.js`.

**Modified (standard wiring touchpoints)**
- `solver.worker.js` — `else if (type === 'starbattle')` dispatch (`maxMs:30000`).
- `scripts/build-solver-bundle.js` — `starbattle.js` in FILES, `StarBattleSolver`
  in EXPORTS.
- `scripts/build-content-bundle.js` — `puzzles/starbattle.js` in WIDGET_FILES
  (before `puzzles/index.js`).
- `handler.js` — `starbattleHandler` (matches `/star-battle/`; detect/readState/
  applySolution) + `registerHandler`.
- `main-world.js` — `readStarBattleData` / `readStarBattleState` /
  `applyStarBattleState` + `/star-battle/` dump branch.
- `background.js` — three names in `EXEC_MAIN_ALLOWLIST`; `globals.d.ts` —
  `StarBattleSolver` decl + three `MainWorldFn` entries; `eslint.config.js` —
  `StarBattleSolver`/`starbattle` readonly globals.
- `src/widget/puzzles/index.js` — register `starbattle`.
- `src/widget/preview.js` — reuse the existing region-border rendering (pass `areas`
  as `regionMap` in puzzleData) for shaped boards; confirm the exact field +
  star-glyph path in the plan.

## Solver model & method

**Model.** Each cell binary: STAR / NO-STAR (UNK undecided). Constructor
`{ rows, cols, stars, areas, walls, maxMs }`. Internal working grid: `0` unknown,
`1` star, `2` no-star. Output `cells`: `1` star, `0` no-star, `9` UNK.

**Oracle `_isValid(cells)`** — ported `getErrors`: exactly `k` stars per row, per
column, per region (shaped); no two stars 8-adjacent; no star on a wall (shapeless).

**Propagation (sound, to a fixpoint):**
- **Adjacency:** a STAR forces its (≤8) neighbours to NO-STAR.
- **Group count forcing** (group = row / column / region): with `s` placed stars and
  `u` still-possible UNK cells — `s == k` → remaining UNK → NO-STAR; `s + u == k` →
  remaining UNK → STAR; `s > k` or `s + u < k` → contradiction.
- **Walls (shapeless):** wall cells init to NO-STAR.
- Adjacency + count interact strongly (a forced star eliminates neighbours, tightening
  other groups).

**Search + partial.** MRV backtracking — branch on the most-constrained group's
candidate star positions (or the tightest UNK cell), propagate, backtrack — under
`maxMs`. On timeout return the **sound root-propagation snapshot** (UNK where
undecided), never speculative state.

**Soundness gate.** Brute-force all `2^cells` placements on tiny boards (4×4, `k=1`,
with regions), keep those passing `_isValid`, and assert: propagation never prunes a
value some solution uses; solver-solved ⟺ brute-force-nonempty; every forced cell
holds in all solutions; output passes the oracle. Validated with a throwaway
prototype (plus the real 14×14) before the plan ships.

**Expectation — measured, not promised.** Star Battle is NP-hard, but real boards
(incl. 14×14 hard 3-star) are designed to be logic-solvable, so propagation +
backtracking should crack them — possibly with real search on the hardest. The plan
records the measured outcome (full solve vs sound partial).

## Widget integration

- **Detect/Solve:** handler matches `/star-battle/`; `readStarBattleData` →
  `{rows,cols,stars,areas,walls}`; worker `StarBattleSolver`; preview →
  `applyStarBattleState`.
- **MAIN-world** (self-contained): `readStarBattleData` (incl. the `(\d+)★` page-text
  scrape for `stars`); `readStarBattleState` → raw `{cellStatus}` (0/1/2);
  `applyStarBattleState`: `saveState(true)` before, write `1→1` (star) / `2→2` (X),
  skip UNK(9), render ladder after, never `check()`. Plus the `/star-battle/` dump.
- **Rendering:** `drawPreviewCell` draws a star glyph for value 1; `drawStaticLayer`
  draws region borders (shaped, via `regionMap` reuse) or fills wall cells
  (shapeless) + the outer border. `canvasDims marginCells: 0`.
- **Mistakes:** `handler.readState` returns a normalized 0/1 board (`cellStatus 1→1`,
  else→0), so the default per-cell diff flags only *wrongly-placed stars*; X-marks /
  blanks / missing stars are never flagged. No diff.js change.
- **Hint/Loop:** `hintDispatch` reads raw `cellStatus`, seeds `_deduceForced`
  (1=star, 2=no-star, 0=unknown), returns forced cells `{row,col,value∈{1,2}}`,
  batch-capped; falls back to revealing cached-solution stars. `applyHint` writes
  ONLY the hint cells (UNK elsewhere). `loopDoneCheck` true when every solution star
  is on the board. `hasAbsoluteHintCells: true` (cell-puzzle Loop pattern — no
  edge-puzzle traps).

## Testing & verification

- **Oracle units:** k per row/column/region, 8-adjacency rejection, wall-avoidance
  (shapeless).
- **Brute-force soundness gate (the gate):** 4×4 `k=1` with regions.
- **Fixtures:** the captured real 14×14 (shaped, 14 regions); small hand-built boards.
- **Performance:** bench the real 14×14; report full-solve vs sound partial honestly.
  Lint/typecheck/build gated.

## Open items (non-blockers, resolved at live-verify)

- The `(\d+)★` star-count scrape on the live page (with the solve-derivation
  fallback as defence); star glyph + region-border rendering.

## Out of scope (YAGNI)

- Any change to other puzzles / shared infra beyond the registry/allowlist/regionMap
  reuse.
- Variants/sizes not served by `/star-battle/`.
- Changing the ported oracle (it is the spec).
