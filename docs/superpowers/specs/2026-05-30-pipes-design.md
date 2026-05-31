# Pipes puzzle support — design

**Date:** 2026-05-30
**Status:** Approved (pending implementation plan)
**Target:** `https://www.puzzles-mobile.com/pipes/<mode>/<WxH>` (e.g. `/pipes/random/4x4`, `/pipes/quest/4x4`)

## Problem

Add support for the **Pipes** (a.k.a. Net) puzzle: a grid where each cell holds a
fixed pipe piece with 1–4 arms, and the player **rotates** each piece until every
arm meets a neighbor's arm, nothing points off the board, and all pipes form one
connected network. This is the 16th puzzle type and the first **rotation** puzzle
— structurally unlike the existing cell-fill, line/edge, and region/graph types.

The user requested: **any board size**, **wrap (toroidal) variant supported**,
and **full widget parity** (Solve + Hint + Loop).

## Recon (captured from the live page)

From `window.Game` on `/pipes/quest/4x4`:

- `Game.task` — `rows×cols` array of integers. Each integer is a **4-bit
  direction mask**: which of the cell's 4 sides has an arm, in the *given*
  orientation. Captured 4×4:
  ```
  [[8,3,2,6],[8,7,1,10],[10,13,13,11],[6,3,1,8]]
  ```
  Popcounts 1–3 (endpoints / straights+elbows / T-pieces); total arms = 30
  (even, as a valid network requires).
- `Game.currentState.cellStatus` — `rows×cols` of **rotation counts** the player
  has applied (0 = as-given). Fresh board = all 0.
- `Game.puzzleWidth` / `puzzleHeight` = dims.
- Relevant `Game` methods present: `getNextStatus`, `getCurrentStatus`,
  `decodeTaskFormat`, `toChar`/`decodeChar`, `setCellState`, `performMove`.

A brute-force over the captured `task` confirms a **unique** solution and that
solving is **mapping-agnostic**: edge-matching only needs "my arm on side X meets
neighbor's arm on the opposite side," so the solver need not know which bit is
North. The exact bit→direction labels and rotation direction matter **only** to
*write* the solution back (convert solved mask → page rotation count); this is
resolved by a one-time live probe during implementation (see "Live probe").

## Solver: `PipesSolver` (constraint propagation + backtracking)

Pure logic in `src/solvers/pipes.js`; no DOM; runs in Node tests + Web Worker
bundle.

**Internal convention (mapping-agnostic):** the solver uses its own canonical bit
labels `N=1, E=2, S=4, W=8` throughout. Input `task` masks pass through verbatim.
`rotateCW(mask, k)` cycles arms; consistency is all that matters.

**Constructor:** `new PipesSolver({ rows, cols, task, wrap, maxMs })`.

**Candidate generation:** per cell, the set of distinct rotation-masks
`{ rotateCW(task[r][c], k) : k=0..3 }` (2-arm straight → 2 distinct; 4-arm cross
→ 1).

**Propagation (arc-consistency over edges):** maintain a surviving candidate set
per cell. Repeatedly, until fixpoint or contradiction:
- **Border rule (non-wrap only):** drop candidates with an arm pointing
  off-board.
- **Edge agreement:** for each pair of orthogonal neighbors, the shared edge is
  *forced-on* if every surviving candidate of one side has that arm, *forced-off*
  if none does; prune the neighbor's candidates that disagree. Under **wrap**, the
  neighbor on a border side is the opposite-edge cell (N↔S, E↔W); there are no
  border walls.
- Dirty-cell queue: re-examine only cells whose neighbor changed.
- A cell's candidate set emptying → contradiction → backtrack.

**Search:** when propagation stalls with ambiguous cells, pick the
**most-constrained** cell (fewest candidates > 1), branch on each candidate with
per-cell trail-based undo, recurse. `timeUp(maxMs, startedAt)` (shared helper)
guards runtime. Note: state is candidate-sets, not a `cellStatus` byte array, so
this uses a lightweight pipes-specific trail rather than the shared
`trailPush`/`rollbackTrail` (which assume the byte-array shape).

**Global connectivity (separate final pass):** a fully-assigned grid can satisfy
all edge-matches yet form **multiple disconnected loops**. On a complete
assignment, BFS from any armed cell along lit edges and require **every armed cell
reachable** (one network). 0-arm cells, if any, are exempt. Reject and continue
search otherwise.

**Return:** `{ solved, grid }` where `grid[r][c]` is the solved **mask** (solver
convention). `{ solved:false, grid:null, error }` on contradiction/timeout —
matches existing solvers.

**Performance:** border + edge propagation usually solves small boards with zero
branching; most-constrained-variable keeps larger boards cheap. Uniqueness is not
required by the solver but holds for the site's puzzles.

## Registration surface (the 7-touchpoint pattern)

| File | Change |
|---|---|
| `src/solvers/pipes.js` | **Create** `PipesSolver`. |
| `solver.worker.js` | Add `else if (type === 'pipes' && extraData)` dispatch. |
| `scripts/build-solver-bundle.js` | Add `'pipes.js'` to `FILES`, `PipesSolver` to `EXPORTS`. |
| `src/solvers/index.js` | Re-export `PipesSolver` (Node path). |
| `main-world.js` | `readPipesData`, `readPipesState`, `applyPipesState`; add `/pipes/` branch to `dumpPuzzleForBench`. |
| `background.js` | Add the three MAIN-world fns to `EXEC_MAIN_ALLOWLIST`. |
| `globals.d.ts` | Add the same three to `MainWorldFn` (kept in sync with allowlist). |
| `handler.js` | `pipesHandler` (detect `/pipes/`, read, solveExtraData, applySolution) + `registerHandler`. |
| `src/widget/puzzles/pipes.js` | **Create** widget module (hooks below). |
| `src/widget/puzzles/index.js` | Register `pipes` into `PUZZLES`. |
| `tests/` | `pipes-fuzz.test.js`, `tests/fixtures/pipes.js`, cache-key parity + bundle entries. |

## Detection & read

- **Detect:** `pipesHandler` matches `location.pathname` containing `/pipes/`
  (covers `/pipes/random/...`, `/pipes/quest/...`). Dims from
  `Game.puzzleWidth`/`puzzleHeight`.
- **`readPipesData()`** → `{ type:'pipes', rows, cols, task, wrap }`. `task` =
  deep copy of `Game.task`. `wrap` resolution: until the probe pins a clean
  signal, the detector/solve path **tries non-wrap first, then wrap**; both are
  validated by the connectivity check, so a wrong guess fails cleanly rather than
  producing a wrong solution. The successful mode is recorded (and used for the
  cache key).
- **`readPipesState()`** → deep copy of `cellStatus` (rotation counts), for
  Hint/Loop diffing.
- **`solveExtraData(data)`** → `{ rows, cols, task, wrap }` for the worker. When
  `wrap` is unknown (probe not yet pinned a clean signal), it passes
  `wrap: 'auto'`; the worker dispatch then runs `PipesSolver` non-wrap first and,
  if unsolved, wrap, returning whichever succeeds plus the resolved `wrap`
  boolean. Once the probe pins a signal, `wrap` is a plain boolean and no retry
  is needed.
- All MAIN-world reads use only nested helpers (no outer-scope refs —
  `fn.toString()` serialization constraint).

## Apply, preview, Hint/Loop

**mask → rotation-count conversion (widget/handler layer, Node-testable):** the
solver returns solved masks (solver convention); the page stores rotation counts.
The widget computes per cell the count `k ∈ {0,1,2,3}` that turns the page's given
`task[r][c]` into the solved orientation, **in the page's own convention and
rotation direction** (pinned by the live probe). Because `k` is derived from the
page's current given mask, it is idempotent and correct even mid-rotation. This
logic lives in the widget/handler layer (unit-tested), keeping
`applyPipesState` a dumb writer.

**`applyPipesState(rotations)` (MAIN world):** follows the save+render ladder
contract — `saveState(true)` before writes (unless the probe shows Pipes is a
galaxies-style exception), set `cellStatus[r][c] = k`, then the canonical render
ladder (`drawCurrentState → render → redraw → redrawGrid → draw →
getSaved+loadGame`). Never call `Game.check()`.

**Preview (`drawPreviewCell` + new `drawPipeCell` helper):** draw the cell's
**solved** arms as segments from center to each lit edge, with a center node and a
filled endpoint node for 1-arm pieces. `computePuzzleDiff` rings cells whose
current rotation ≠ solved rotation.

**Hint / Loop (full parity):**
- `hintDispatch`: compute solved masks → diff against current rotations → return
  a batch of cells needing rotation `{ type:'pipes', extraCells:[{row,col,
  value:targetK}], count }`, capped by the existing hint-batch scaling rule used
  by the other puzzles (per-click `minLines = max(<small floor>,
  ceil(rows*cols/30))`, sized so Loop finishes in ~10 s). (No "wrong state" gate
  applies the way it does to fill puzzles — any rotation is legal; the only
  question is distance-to-solution.)
- Hint applies rotations to just those cells.
- `loopDoneCheck`: solved when every cell's current rotation equals its solved
  rotation (no diffs remain).
- `hintStatusNodes`: phrasing like "Rotate N cells to their correct orientation."

## Live probe (one-time, during implementation)

Resolve, from the live page (console snippet, adapted to output — no guessing
committed to code):
1. **Bit→direction labels + rotation direction** — read `Game.getNextStatus` /
   rotation source; cross-check by rotating one cell once and diffing `cellStatus`
   (0→1) + observing visual turn. Fixes mask→k conversion exactly.
2. **Wrap signal** — whether a wrap board exposes a `Game` flag or distinct URL
   segment; until then the solver-arbitrated non-wrap→wrap fallback keeps it
   correct.

## Testing & verification

- **`tests/pipes-fuzz.test.js`** (behavior oracle): constructive trials —
  generate a random connected network, derive masks, apply random rotations to
  form `task`, assert the solver returns a grid that matches all edges, is fully
  connected, and equals the known solution when unique. Include **wrap** variants.
- **Brute-force cross-check** on ≤4×4: solver solution-set size matches
  exhaustive enumeration (validates connectivity rejection).
- **`tests/fixtures/pipes.js`:** the captured 4×4 as a golden with its unique
  solution.
- **mask→rotation-count conversion:** Node unit test.
- **`cachekey-parity.test.js`:** add a `pipes` entry.
- **`tests/bundle.test.js`:** assert the concatenated bundle exposes
  `PipesSolver`.
- **Per-step gate:** `npm run build` → `npm test` → `npm run lint` →
  `npm run typecheck` green; allowlist ↔ `MainWorldFn` in sync.
- **Final live verification (user):** load a `/pipes/.../4x4` board; Solve
  completes it; Hint rotates a batch; Loop finishes. (MAIN-world apply isn't
  unit-testable — same as every other puzzle.)

## Out of scope

- Non-`/pipes/` puzzle types.
- Any rendering beyond the per-cell pipe glyph + diff rings.
- CDCL/SAT solving (propagation + backtracking suffices; YAGNI).
