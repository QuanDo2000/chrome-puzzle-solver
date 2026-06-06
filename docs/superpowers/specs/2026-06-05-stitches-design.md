# Stitches puzzle support — design

**Status:** approved (brainstorm)
**Date:** 2026-06-05
**Site:** puzzles-mobile.com `/stitches/` (slug `stitches`).

## Summary

Add full Stitches support (Detect / Solve / Hint / Loop), wired as an **edge/matching
CSP** puzzle. Connect each pair of adjacent jigsaw regions with exactly **K** stitches
(K from the URL), where a stitch joins two orthogonally-adjacent cells in *different*
regions, every cell is the endpoint of at most one stitch, and each row/column has a
clued number of stitch-endpoints. The solver enumerates candidate border edges,
propagates region-pair / cell-degree / line-count deductions to a fixpoint, backtracks,
and returns a sound partial on timeout. The page `getErrors` is a **no-op stub**, so the
ruleset is decoded from the page's `highlightErrors`/`setCellState`/`updateCounters`
logic and soundness is **brute-force-gated** (1,261 tiny boards, validated). The real
15×15-3 board full-solves in ~0.4s with a unique solution.

## Recon: the page encoding (ground truth, from `window.Game`)

- **slug** `stitches`; board N×N (`puzzleWidth`=`puzzleHeight`=15). `jigsaw = true`.
- **`task` parse** (`parseTask`): `C.task` = `"<clues>;<areacsv>"`. `task = clues.split("_")`
  (length `W+H` = 30), `areas[r][c] = areacsv[r*W+c] - 1` (region ids 0-based).
- **`areas`** — N×N region map (region ids `0..R-1`; the real board has 8 regions).
- **`task` line clues** — `task[0..W-1]` = **column** hole-counts (`verticalCounters`),
  `task[W..W+H-1]` = **row** hole-counts (`horizontalCounters`). String values; parse to
  int. A clue is the number of stitch-**endpoint cells** in that line.
- **State (three arrays)**: `currentState.cellStatus[r][c]` (player dot/cross marker: 0/1/2
  — **NOT part of the solution**), `cellHorizontalStatus[r][c]` (stitch `(r,c)–(r,c+1)`:
  1 stitch / 2 blocked-border-X / 0 none), `cellVerticalStatus[r][c]` (stitch
  `(r,c)–(r+1,c)`: same encoding).
- **`serializeSolution`** = for every cell `cellHorizontalStatus==1?"y":"n"` (H grid), then
  `cellVerticalStatus==1?"y":"n"` (V grid). **This is the solution shape.**
- **`getErrors` = `function(t){return !0}`** — a no-op. The page validates the player's
  `serializeSolution()` against a hidden stored `C.solution` (or server). No oracle to port.
- **Stitch count K** = `C.stitches` (closure constant, **not** on `window.Game`). Read from
  the **URL path** `/stitches/random/{W}x{H}-{K}-{difficulty}` (e.g. `15x15-3-hard` → K=3),
  with the page title (`"15x15 / 3… Hard Stitches"`, scrape the number after the slash,
  `/\/\s*(\d+)/`) as a fallback.
- `dr=[-1,-1,-1,0,1,1,1,0]`, `dc=[-1,0,1,1,1,0,-1,-1]` (unused — stitches are 4-directional
  between cells, not 8-neighbour).

### Rules (decoded from `highlightErrors` + `setCellState`; the spec, since getErrors is a stub)
1. A **stitch** joins two orthogonally-adjacent cells in **different regions** (crosses a
   region border). `setCellState`/`findNearestCell` only allow stitch placement where
   `areas` differ.
2. Each pair of **adjacent regions** (sharing ≥1 border) is joined by **exactly K** stitches
   (`highlightErrors` flags `regionPair.count > C.stitches`; the unique solution has exactly
   K per pair).
3. Each cell is an **endpoint of at most one** stitch (degree ≤ 1) — `setCellState` clears
   conflicting stitches when one is placed.
4. **Row/column clues**: row `r` endpoint-count == `task[W+r]`; col `c` endpoint-count ==
   `task[c]`. An endpoint ("hole") is a cell of degree exactly 1.

## Architecture & files

Edge/matching CSP puzzle. Solution shape `{ horizontal, vertical }` (two `H×W` 0/1 grids;
`horizontal[r][c]` meaningful for `c<W-1`, `vertical[r][c]` for `r<H-1`) — same shape as
Slitherlink, so it reuses the existing `{partial, horizontal, vertical}` Solve-partial
dispatch branch in `widget.js`.

**New**
- `src/solvers/stitches.js` — `StitchesSolver` (pure logic): candidate-edge enumeration,
  `_isValid` oracle (the decoded ruleset), region-pair + cell-degree + line-count
  propagation, backtracking, sound partial, `_deduceForced` (hint). Returns
  `{ solved, horizontal, vertical, partial?, error? }`.
- `src/widget/puzzles/stitches.js` — registry module (cacheKey, canvasDims, staticSig,
  drawStaticLayer = region borders + clue gutters, drawPreview/drawPreviewCell = stitch
  segments + endpoint holes, solveExtraData, solutionFromResult, computeDiff, hintDispatch,
  applyHint, loopDoneCheck, partialResultArm).
- `tests/stitches.test.js` (oracle + brute-force soundness gate + solve + `_deduceForced`),
  `stitches_15x15` fixture in `tests/fixtures/real-puzzles.js`, `tests/bench-stitches.js`.

**Modified (standard wiring touchpoints)**
- `solver.worker.js` — `else if (type === 'stitches')` dispatch (`maxMs:30000`).
- `scripts/build-solver-bundle.js` — `stitches.js` in FILES, `StitchesSolver` in EXPORTS.
- `scripts/build-content-bundle.js` — `puzzles/stitches.js` in WIDGET_FILES (before
  `puzzles/index.js`).
- `handler.js` — `stitchesHandler` (matches `/stitches/`; detect/readState/applySolution) +
  `registerHandler`.
- `main-world.js` — `readStitchesData` / `readStitchesState` / `applyStitchesState` +
  `/stitches/` dump branch.
- `background.js` — three names in `EXEC_MAIN_ALLOWLIST`; `globals.d.ts` — `StitchesSolver`
  decl + three `MainWorldFn` entries; `eslint.config.js` — `StitchesSolver`/`stitches`
  readonly globals.
- `src/widget/puzzles/index.js` — register `stitches`.
- `src/widget/hint.js` — a `stitches` branch in `applyHintToGrid` (edge-hint path) so Loop
  applies stitch hints (the Masyu Loop lesson).

## Solver model & method

**Candidate edges.** For every orthogonally-adjacent cell pair in different regions, one
edge: `H(r,c)` for `c<W-1`, `V(r,c)` for `r<H-1`. Index cells→incident-edges, and
edges→region-pair (`min-max` region ids). Real board: 152 edges, 14 region pairs.

**Oracle `_isValid(horizontal, vertical)`** — the decoded ruleset: every region-pair has
exactly K stitches; every cell degree ≤ 1; every row/col endpoint-count equals its clue.

**Propagation (sound, to a fixpoint)** — edge state ∈ {unknown, selected, rejected}:
- **Region-pair**: with `s` selected, `u` undecided in a pair — `s>K` or `s+u<K` →
  contradiction; `s==K` → reject the rest; `s+u==K` → select the rest.
- **Cell degree**: a cell with a selected incident edge → reject its other incident edges;
  ≥2 selected → contradiction.
- **Line count**: per row/col, count known-endpoint cells (one selected incident) and
  possible-endpoint cells (degree 0 with an undecided incident). `known>clue` or
  `known+possible<clue` → contradiction; `known==clue` → force every possible cell to
  degree 0 (reject its undecided incident edges).

**Search + partial.** Branch on the first undecided edge of the tightest region-pair (fewest
undecided, still needs stitches); try selected then rejected, propagate, backtrack — under
`maxMs`. On timeout return the **sound root-propagation snapshot** (edges still undecided →
0 in both grids). Captured AFTER root propagation, BEFORE search.

**Soundness gate (the gate — no page oracle).** For ~1,300 random tiny boards (2×2…3×3,
2–3 regions, K∈{1,2}): enumerate all edge subsets; derive clues from a random
structurally-valid config; brute-force the full solution set; assert solver-solved ⟺
brute-nonempty, solver output passes the oracle, and uniqueness agrees (count==1 ⟺ brute
has one). **Validated: 1,261 tested, 0 failures.**

**Measured (prototype).** Real 15×15-3 board: full-solve **~0.4s**, oracle-valid, **unique**
(42 stitches = 14 pairs × 3).

## Widget integration

- **Detect/Solve:** handler matches `/stitches/`; `readStitchesData` →
  `{rows, cols, areas, colClue, rowClue, stitches:K}` (K from URL path, title fallback);
  pass `areas` as `regionMap`; worker `StitchesSolver`; solution `{horizontal, vertical}`.
- **MAIN-world** (self-contained): `readStitchesData` (incl. K parse); `readStitchesState` →
  raw `{cellHorizontalStatus, cellVerticalStatus}` (for the live-board hint); `applyStitchesState`
  → `saveState(true)`, write `cellHorizontalStatus[r][c]=1` / `cellVerticalStatus[r][c]=1`
  for stitches (0 elsewhere), render ladder, never `check()`. Plus the `/stitches/` dump.
- **Rendering:** `drawStaticLayer` draws region borders (via `regionMap` reuse) + row/col
  clue numbers in margin gutters; `drawPreview` draws each stitch as a segment between the
  two cell centres with a filled hole-dot at each endpoint. `canvasDims marginCells` sized
  for the clue gutters.
- **Mistakes:** custom edge diff — flag stitches placed on the board that the solution does
  NOT contain (a wrong stitch). A solution stitch not yet placed is "incomplete", not a
  mistake, so it is not flagged — mirroring every other puzzle's diff. The default per-cell
  diff does not apply (edges, not cells).
- **Hint/Loop:** `hintDispatch` reads the raw stitch arrays, seeds `_deduceForced`
  (selected = live `==1`, rejected = live `==2`/same-region), returns newly-forced stitch
  edges `{row, col, type:'horizontal'|'vertical', value:1}`, batch-capped; falls back to
  revealing the next cached-solution stitches. `applyHint` writes ONLY the hint edges.
  `loopDoneCheck` true when every solution stitch is on the board. `hasAbsoluteHintCells:
  true` AND a `stitches` branch in `hint.js applyHintToGrid` (both required — the Masyu Loop
  trap).

## Testing & verification

- **Oracle units:** region-pair exactly-K, cell degree ≤ 1, row/col endpoint-count.
- **Brute-force soundness gate (the gate):** tiny boards, differential vs full enumeration.
- **Fixtures:** the captured real 15×15-3 (8 regions); small hand-built boards.
- **Performance:** bench the real 15×15; report full-solve vs sound partial honestly.
  Lint/typecheck/build gated.

## Open items (non-blockers, resolved at live-verify)

- The K-from-URL parse (with the title scrape as defence) on the live page.
- Stitch-segment + hole rendering and the clue-gutter layout; the `applyStitchesState`
  array writes + render ladder — verify on the live board after first deploy.

## Out of scope (YAGNI)

- Any change to other puzzles / shared infra beyond the registry/allowlist/regionMap reuse
  and the one `hint.js` edge-branch addition.
- The player's `cellStatus` dot/cross markers (not part of the solution).
- Non-`/stitches/` variants/sizes.
- Reconstructing/altering the (nonexistent) page oracle.
