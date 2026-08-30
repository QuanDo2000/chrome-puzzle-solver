# Shingoki puzzle support — design

**Status:** approved (brainstorm)
**Date:** 2026-05-31
**Target page:** https://www.puzzles-mobile.com/shingoki/random/5x5-easy (and larger dailies)

## Summary

Add full support for the **Shingoki** (a.k.a. "Shingoki / Loop") puzzle to the
Chrome MV3 extension: Detect + Solve + Hint + Loop, any board size. Shingoki is
a single-closed-loop puzzle on a grid of vertices; topologically it is the same
edge-on-lattice structure as our existing Slitherlink, so the widget/page layer
mirrors Slitherlink, while the solver is a fresh `ShingokiSolver` because the
clue semantics (vertex straight/turn + run length) differ from Slitherlink's
cell edge-counts.

## Verified page encoding (from live console probes)

- **Board dims:** `G.puzzleWidth` / `G.puzzleHeight` are CELL dims (5×5). The
  loop runs on a **(rows+1)×(cols+1) vertex lattice** (6×6 for 5×5).
- **`G.task`** is a 6×6 vertex-clue grid:
  - `task[r][c] > 0` → **white** circle (loop passes straight through), value =
    the number.
  - `task[r][c] < 0` → **black** circle (loop turns here), `abs(value)` = the
    number. (`G.blacks === -1` confirms negative ⇒ black.)
  - `task[r][c] === 0` → no circle.
- **Loop edge state** in `G.currentState`:
  - `cellHorizontalStatus` — `(rows+1) × cols` (6×5): edge between vertex
    `(r,c)` and `(r,c+1)`.
  - `cellVerticalStatus` — `rows × (cols+1)` (5×6): edge between vertex `(r,c)`
    and `(r+1,c)`.
  - Values: `1` = line present, `2` = cross/X, `0` = unknown. (Confirmed by
    `lineStatus` source: `1 == cellHorizontalStatus[t][e]` etc.)
- **No client-side validation oracle:** `G.getErrors` is stubbed
  (`function(t){return!0}`) and the solution is hashed (`getHashedSolution`).
  So correctness cannot be cross-checked against the page; see Validation Gate.

## Shingoki rules (as encoded by this design)

1. **Single closed loop.** Drawn edges form exactly one closed loop — every
   vertex has loop-degree 0 or 2, no opens, no crossings, no separate sub-loops.
2. **White circle** (`task>0`): the loop passes **straight through** the vertex
   (its two edges are collinear) AND at least one of the two adjacent vertices
   one step away along that line is a **turn** (standard white rule).
3. **Black circle** (`task<0`): the loop **turns** at the vertex (one
   horizontal + one vertical edge) AND goes **straight** at both vertices one
   step away along each arm.
4. **Number = sum of both straight runs.** From the circle, measure the
   straight-line segment length (in edges) in each of the loop's two directions
   until it turns; the clue equals their total. White: one collinear line, both
   directions sum. Black: two perpendicular arms sum.

## Architecture & file layout

New files (per-puzzle pattern):

| File | Role |
|---|---|
| `src/solvers/shingoki.js` | `ShingokiSolver` — pure logic: edge variables, vertex constraints, propagation + backtracking + single-loop connectivity. Returns `{ solved, horizontal, vertical, error? }`. |
| `src/widget/puzzles/shingoki.js` | widget module: detect/read/apply hooks, edge preview, hint/loop/applyHint hooks, cacheKey + cache JSON. |
| `tests/shingoki.test.js` | unit (per-rule) + small constructive solves + captured 5×5 golden. |
| `tests/shingoki-fuzz.test.js` | constructive loop-generation fuzz across sizes, wall-clock bounded. |
| `docs/superpowers/specs/2026-05-31-shingoki-design.md` | this spec. |

Wiring edits (same touch-points as Pipes):
`src/solvers/index.js`, `solver.worker.js` (dispatch + 30 s `maxMs`), both
bundler FILE lists (`scripts/build-solver-bundle.js`,
`scripts/build-content-bundle.js`), `handler.js` (register `shingokiHandler`),
`main-world.js` (`readShingokiData` / `readShingokiState` /
`applyShingokiState` + `/shingoki/` dump branch), `background.js`
`EXEC_MAIN_ALLOWLIST`, `globals.d.ts` `MainWorldFn`, `src/widget/cache.js`
(`shingoki-solution:` prefix), AGENTS.md puzzle list.

## Solver (`ShingokiSolver`)

**Model.** Variables = lattice edges, tri-state `unknown / line / cross`:
`H` horizontal `(rows+1)×cols`, `V` vertical `rows×(cols+1)`.

**Propagation (arc-consistency to fixpoint):**
- Degree rule: vertex with 2 lines crosses out remaining incident edges; vertex
  where (4 − crosses) == 2 forces remaining to lines; >2 lines or impossible
  degree → contradiction.
- White-circle shape: forbid the 4 "turn" incident-edge pairs (the two edges
  must be collinear).
- Black-circle shape: forbid the 2 "straight" collinear pairs (the two edges
  must be perpendicular); force straight at the one-step neighbors along each
  arm.
- Number-bound: a straight run that reaches the clue length forces a turn/cross
  at its end; a run that cannot reach the clue → contradiction.

**Backtracking:** most-constrained-edge selection when propagation stalls.

**Connectivity / single-loop:** prune partials that close a loop while edges
remain elsewhere (premature sub-loop) DURING search — not only at the leaf
(the Pipes lesson: check connectivity in-search to avoid blowup). At a complete
assignment, verify exactly one loop.

**Time cap:** `maxMs` (worker passes 30 000, like every other solver — no
uncapped path; oversized/unsolvable boards fail gracefully).

**Output:** `{ solved: true, horizontal, vertical }` or
`{ solved: false, error }`. Edge shape matches Slitherlink so the widget reuses
edge conventions.

## Widget & page-interaction layer

- **Detect** (`readShingokiData`): `{ rows, cols, task }` (rows/cols = cell
  dims). Handler gates on `/shingoki/` + `!data` (hitori/pipes pattern).
- **Read** (`readShingokiState`): `{ horizontal, vertical }`, `1`=line `2`=cross
  `0`=unknown (Slitherlink reader shape).
- **Apply** (`applyShingokiState`): write both edge arrays via `saveState(true)`
  + canonical render ladder. Never `Game.check()`.
- **Solver↔widget boundary:** `puzzleData.solution = { horizontal, vertical }`;
  `solutionFromResult(result)` returns that directly — no conversion layer
  (unlike Pipes counts-vs-masks).
- **Preview:** draw loop edges, crosses, and vertex circles (white = open ring,
  black = filled) with numbers; reuse Slitherlink edge-rendering helpers where
  available. Geometry-aware diff ringing.
- **Hint** (`hintDispatch`): reveal next batch of solved edges not yet matching
  the board; unit = edge. Batch-capped `max(floor, ceil(edgeCount/30))` so Loop
  drips moves rather than one-shotting the loop (Pipes Loop lesson).
- **Apply-hint** (`applyHint`): overlay hint edges onto live edge state, write
  via `applyShingokiState` — a DEDICATED hook (the generic `applyHintCells`
  binary-clamps and is cell-state-only; this pre-empts the trap that broke
  Pipes Hint-Apply). Mirrors Slitherlink's `applyHint`.
- **Loop done** (`loopDoneCheck`): board edges == solution edges.
- **Cache:** `shingoki-solution:` prefix; `cacheKey` = FNV of
  `{nameplate, rows, cols, task}`; `solutionToCacheJson` /
  `solutionFromCacheJson` persist `{horizontal, vertical}` (Slitherlink shape).

## Testing

- **`tests/shingoki.test.js`:** per-rule unit tests (white forbids turn-pairs,
  black forbids straight-pairs, degree-2 closes a vertex, number-run forces a
  turn at clue length, premature sub-loop rejected); small constructive solves
  (known 3×3 and 5×5 loops); captured 5×5-easy `task` golden — solver must find
  a single-loop solution satisfying all clues.
- **`tests/shingoki-fuzz.test.js`:** generate a random closed loop, derive
  white/black/number clues from it, assert the solver returns a valid solution
  (one loop, all vertex rules hold, all numbers match) across 5×5/8×8/10×10 with
  a wall-clock bound (fuzz the hard sizes up front — the wrap-board lesson).
- **Integration (`tests/puzzle-modules.test.js`):** registry hooks present and
  correctly shaped; solved edge state round-trips through read/apply.
- **Cache-parity (`tests/cachekey-parity.test.js`):** golden
  `shingoki:cacheKey`.
- **Bundle test:** built bundle exposes `ShingokiSolver`; widget registers
  `shingoki`.

## Error handling

- Solver → `{solved:false, error}` on contradiction / time-limit / no-solution;
  widget shows a status message (no hang; 30 s cap).
- `readShingokiData`/`readShingokiState` → `null` on missing `Game`; handler
  detect fails cleanly, readState returns an empty edge grid.

## Validation Gate (carried risk)

The site's `getErrors` is stubbed and the solution is hashed, so we CANNOT
cross-check against the page. Correctness rests on:
1. Constructive fuzz tests proving the solver against known-valid loops.
2. Live end-to-end: solve the real 5×5-easy, apply, confirm the page accepts it.

This is the same gate used successfully for Pipes.

## Out of scope (YAGNI)

- No reuse/refactor of the Slitherlink solver (kept separate; fresh solver).
- No speculative perf work (trail-undo etc.) — measure first if a size proves
  slow, per the Pipes loop-prune experience.
