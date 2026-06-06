# Tents puzzle support — design

**Status:** approved (brainstorm)
**Date:** 2026-06-06
**Site:** puzzles-mobile.com `/tents/` (slug `tents`).

## Summary

Add full Tents support (Detect / Solve / Hint / Loop), wired as a **cell-state** puzzle (the
Tapa/Nurikabe family). Trees are fixed givens; place tents on non-tree cells so every row/column
has its clued tent count, no two tents touch (8-adjacency), and there is a 1:1 matching between
trees and orthogonally-adjacent tents. The page `getErrors` is a real oracle; the **perfect
tree↔tent matching subsumes it** (so no `getCamps` port is needed), and the ruleset is
brute-force-gated. The solver propagates count + adjacency + tree-coverage deductions, prunes on
matching-feasibility, backtracks, and returns a sound partial on timeout. The real 15×15-hard
board solves uniquely in ~22ms.

## Recon: the page encoding (ground truth, from `window.Game`)

- **slug** `tents`; board N×N (`puzzleWidth`/`puzzleHeight` = 15). `dr/dc` = 8 neighbours,
  `dr4=[-1,1,0,0]`/`dc4=[0,0,-1,1]` = 4 orthogonal neighbours.
- **`trees`** — N×N grid, `1` = tree (givens). Tree cells are NOT tracked in `cellStatus` (the page
  renders the tree); their `cellStatus` stays `0`.
- **`task`** (after `parseTask` shifts off the leading tree-encoding token) = `W+H` clue strings:
  `task[0..W-1]` = **column** tent-counts, `task[W..W+H-1]` = **row** tent-counts. Parse to int.
- **`currentState.cellStatus`** (`statesMap = ["n","y","x"]`): `0` unknown · `1` tent · `2` grass
  (not-tent).
- **`serializeSolution`** = `cellStatus===1 ? "y" : "n"` — the solution is the set of tent (`1`)
  cells.
- The solver reads `G.trees` directly (the tree grid) — no need to decode `parseTask`/`decodeChar`.

### Validity rules (ported from `getErrors`; the perfect matching subsumes the `camp` proxy)
`getErrors(true)` returns no error iff:
1. **No two tents 8-adjacent** ("proximate").
2. **Row/column tent counts equal the clues** (`s[row]`/`r[col]` vs `task`).
3. Every **tree** has ≥1 orthogonally-adjacent tent ("soleTree"); every **tent** has ≥1
   orthogonally-adjacent tree ("soleTent").
4. Per **camp** (`getCamps`: a connected component of trees+tents) `#trees == #tents` ("camp").

3+4 together encode a **1:1 tree↔tent matching** (each tree adjacent to exactly one matched tent,
bijection). A perfect bipartite matching (tree ↔ orthogonally-adjacent tent) implies all of
soleTree/soleTent/camp-equality (a matched pair is adjacent → same camp; counts balance per camp),
so the solver uses the matching as its oracle. Tents go only on non-tree cells, and
`#tents == #trees == sum(colClues) == sum(rowClues)`.

## Architecture & files

Cell-state puzzle, wired like Tapa/Nurikabe. Tree cells behave like clue cells (untracked in
`cellStatus`, re-asserted in `getHint`). Reuses the default cell-state preview cell-loop, the
default per-cell mistake-diff, undo/redo, and the solution cache — NO `preview.js`/`diff.js`/
`hint.js` changes.

**New**
- `src/solvers/tents.js` — `TentsSolver` (pure logic): the matching oracle (`_isValid`),
  count + 8-adjacency + tree-coverage propagation, a Kuhn bipartite matching used for both the
  feasibility prune and the leaf check, backtracking, sound partial, and `getHint`. Returns
  `{ solved, grid, partial?, error? }`, `grid[r][c] ∈ {0 unknown, 1 tent, 2 grass}`.
- `src/widget/puzzles/tents.js` — registry module (cacheKey, canvasDims, staticSig,
  drawStaticLayer = tree glyphs + row/col clue numbers, drawPreviewCell = tent / grass,
  solveExtraData, solutionFromResult, hintDispatch with cached-solution fallback, partialResultArm).
- `tests/tents.test.js` (oracle + brute-force gate + solve + getHint), a `tents_15x15` fixture in
  `tests/fixtures/real-puzzles.js`, `tests/bench-tents.js`.

**Modified (standard wiring touchpoints)**
- `solver.worker.js` — `else if (type === 'tents')` dispatch (`maxMs:30000`).
- `scripts/build-solver-bundle.js` — `tents.js` in FILES, `TentsSolver` in EXPORTS.
- `scripts/build-content-bundle.js` — `puzzles/tents.js` in WIDGET_FILES (before `puzzles/index.js`).
- `handler.js` — `tentsHandler` (matches `/tents/`; detect/readState/applySolution) + `registerHandler`.
- `main-world.js` — `readTentsData` / `readTentsState` / `applyTentsState` + `/tents/` dump branch.
- `background.js` — three names in `EXEC_MAIN_ALLOWLIST`; `globals.d.ts` — `TentsSolver` decl +
  three `MainWorldFn` entries; `eslint.config.js` — `TentsSolver`/`tents` readonly globals.
- `src/widget/puzzles/index.js` — register `tents`.

## Solver model & method

**Model.** Each non-tree cell binary: tent / grass (unknown undecided). Tree cells fixed (never
tents). Internal grid `g`: `9` unknown, `1` tent, `2` grass; tree cells `0` (excluded).

**Oracle `_isValid(tent)`** — ported `getErrors`: tents only on non-tree cells; row/col counts ==
clues; no two tents 8-adjacent; a perfect Kuhn matching between trees and placed tents (orthogonal
adjacency) covering all trees (`== #trees == #tents`).

**Propagation (sound, to a fixpoint):**
- **Adjacency:** a tent forces its (≤8) neighbours to grass; two adjacent tents → contradiction.
- **Row/column count forcing:** with `t` placed tents and `u` undecided cells in a line — `t>clue`
  or `t+u<clue` → contradiction; `t==clue` → remaining undecided → grass; `t+u==clue` → remaining
  undecided → tent.
- **Tree coverage:** a tree with no placed adjacent tent and exactly one possible adjacent tent-cell
  → force that cell to a tent; zero possible → contradiction.

**Search + partial.** Backtrack on the first undecided cell (try tent, then grass), propagate. A
**matching-feasibility prune** runs at each node (Kuhn: every tree must still be coverable by a
possible-tent cell — tent or unknown), and the perfect-matching check runs at each complete leaf.
Under `maxMs`; on timeout return the **sound root-propagation snapshot** (UNK ⇒ 0), captured after
root propagation, before search.

**Soundness gate (the gate).** For ~400 random tiny boards (3×3…4×4, ~25% trees, clues derived from
a random structurally-valid placement): brute-force all placements passing the oracle; assert
solver-solved ⟺ brute-nonempty, solver output passes the oracle, and uniqueness agrees.
**Validated: 400 tested, 0 failures.**

**Measured (prototype).** Real 15×15-hard: full-solve **~22ms**, oracle-valid, **unique** (45 tents
= 45 trees).

## Widget integration

- **Detect/Solve:** handler matches `/tents/`; `readTentsData` → `{rows, cols, trees, colClue,
  rowClue}`; worker `TentsSolver`; solution `{grid}`.
- **MAIN-world** (self-contained): `readTentsData` (trees grid + the col/row clues); `readTentsState`
  → raw `{cellStatus}` (0/1/2, for the hint); `applyTentsState` → write `cellStatus[r][c] = 1`
  (tent) / `2` (grass) for non-tree cells (skip tree cells); render ladder; never `check()`. Plus
  the `/tents/` dump branch.
- **Rendering:** `drawStaticLayer` draws a tree glyph in each tree cell + the row/col clue numbers in
  margin gutters; `drawPreviewCell` draws a tent (value 1) and a grass/X mark (value 2) on non-tree
  cells, nothing for `0`/`9`. `canvasDims marginCells` sized for the clue gutters.
- **Mistakes:** the default per-cell diff (board `1`/`0` vs solution `1`/`0`). `handler.readState`
  returns the raw `{0,1,2}` board (tree cells `0`).
- **Hint/Loop:** custom `hintDispatch` — wrong-state guard (firstMismatch), then deductive forced
  cells from `TentsSolver.getHint` (which **re-asserts tree cells as non-tent** from `trees`, the
  Tapa/Nurikabe untracked-clue trait — [[project_clue_cells_not_in_cellstatus]]), then a
  **cached-solution fallback** revealing the next batch of solution cells the board hasn't placed
  (batch-capped). `hasAbsoluteHintCells: true`. `getHint`/forced cells use value `1` (tent) / `2`
  (grass).

## Testing & verification

- **Oracle units:** 8-adjacency rejection, row/col counts, tree-coverage, perfect-matching
  (incl. a placement that fails the matching despite passing counts+adjacency).
- **Brute-force soundness gate (the gate):** tiny boards, differential vs full enumeration.
- **Fixtures:** the captured real 15×15-hard (45 trees); small hand-built boards.
- **Performance:** bench the real 15×15; report full-solve honestly. Lint/typecheck/build gated.

## Open items (non-blockers, resolved at live-verify)

- Tree-glyph + tent/grass rendering and the clue-gutter layout; the `applyTentsState` writes + render
  ladder — verify on the live board after first deploy.

## Out of scope (YAGNI)

- Any change to other puzzles / shared infra beyond the registry/allowlist additions (no
  preview.js/diff.js/hint.js changes — default cell-state arms suffice).
- Non-`/tents/` variants/sizes.
- Porting `getCamps` (the perfect matching subsumes the camp proxy).
