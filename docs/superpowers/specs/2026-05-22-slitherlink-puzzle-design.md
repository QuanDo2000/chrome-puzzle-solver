# Slitherlink ("Loop") puzzle support — design

**Date:** 2026-05-22
**Status:** Approved design, pre-implementation
**Puzzle URL:** `https://www.puzzles-mobile.com/loop/random/5x5-normal`

## 1. Summary

Add support for the "Loop" puzzle on puzzles-mobile.com — this is **Slitherlink**
(a.k.a. Loop the Loop / Fences). Full feature parity with the six existing puzzle
types: Detect, Solve, Hint, Loop (iterative), Apply, live preview, Dump, solution
cache, and auto-solve-on-detect with live mistake highlighting.

The puzzle is named **Slitherlink** everywhere in code (`SlitherlinkSolver`,
`slitherlinkHandler`, `type: 'slitherlink'`, `readSlitherlinkData` /
`readSlitherlinkState` / `applySlitherlinkState`) — chosen over "loop" to avoid
colliding with the existing Loop button feature (`loopHandler` in `content.js`,
the `loop` button action). `matches()` still keys on the `/loop/` URL path.

## 2. The puzzle

A `W×H` grid of cells. Some cells carry a clue `0–3`. Draw a single closed loop
along cell edges such that each clued cell has exactly that many of its 4 edges on
the loop. The loop never branches or crosses, and there is exactly one loop.

## 3. Recon — page data model

`window.Game` is a jQuery object the site extended with the game logic. Relevant
fields, captured from the live 5×5 page:

### Clues — `window.Game.task`

2D `int[H][W]`. `-1` = no clue; `0/1/2/3` = clue value. Captured 5×5:

```
[[-1,-1,-1,-1, 3],
 [-1, 2,-1,-1,-1],
 [-1, 2,-1, 0, 3],
 [-1, 1,-1,-1, 3],
 [-1, 2, 3, 1,-1]]
```

### Edge state — `window.Game.currentState`

| Field | Shape | Meaning |
| --- | --- | --- |
| `cellHorizontalStatus` | `(H+1) × W` | horizontal edges; `0` = empty, `1` = line; `2` = × (UI mark, unconfirmed) |
| `cellVerticalStatus` | `H × (W+1)` | vertical edges; same encoding |
| `cellHatch` | `H × W` | per-cell hatch UI helper — solver ignores |
| `autoXH`, `autoXV` | arrays | auto-cross marks — solver ignores |
| `solved`, `index`, `lastMove`, `solvedTime` | — | bookkeeping |

This is the **same edge encoding as Galaxies** (`cellHorizontalStatus` /
`cellVerticalStatus`, `1` = line), so the apply + handler paths mirror Galaxies
closely. `puzzleWidth` / `puzzleHeight` give the cell-grid dimensions. Render
functions available: `drawCurrentState`, `redraw`, `draw`.

### Edge ↔ index conventions

- Horizontal edge `H[r][c]` (`r` in `0..H`, `c` in `0..W-1`) joins dot `(r,c)` to
  dot `(r,c+1)`. It borders cell `(r-1,c)` above and cell `(r,c)` below.
- Vertical edge `V[r][c]` (`r` in `0..H-1`, `c` in `0..W`) joins dot `(r,c)` to
  dot `(r+1,c)`. It borders cell `(r,c-1)` left and cell `(r,c)` right.
- Cell `(r,c)`'s 4 edges: top `H[r][c]`, bottom `H[r+1][c]`, left `V[r][c]`,
  right `V[r][c+1]`.
- Dot `(r,c)`'s incident edges: `H[r][c-1]`, `H[r][c]`, `V[r-1][c]`, `V[r][c]`
  (those in range).

## 4. Solver — `SlitherlinkSolver` (solver.js)

Approach: **edge-variable propagation + backtracking**, modeled on
`GalaxiesSolver`.

*Rejected alternatives:* a cell inside/outside 2-coloring model (the
single-loop / no-checkerboard connectivity conditions are fiddlier and it does
not mirror the existing solvers); SAT / brute-force (needs a dependency or is
exponential).

### State

- Constructor `{ task, width, height, maxMs = 0 }`.
- Edge variables: each H/V edge ∈ `{ UNKNOWN, EMPTY, LINE }`.
- Trail-based undo: assignments push onto a trail; backtracking rolls back
  (mirrors `GalaxiesSolver` / `NonogramSolver`).
- Per-vertex incidence counters (`lineCount`, `unknownCount`) maintained
  incrementally on assign/rollback.
- Union-find over dots joined by `LINE` edges; total `LINE`-edge count tracked.

### Propagation (`_propagate` → fixpoint, bool return)

Two sound rules iterated to a fixpoint over a dirty-edge queue:

1. **Clue forcing.** For a clued cell with clue `k`, `lineCount` `m`,
   `unknownCount` `n` among its 4 edges: `m > k` or `m+n < k` → contradiction;
   `m == k` → all unknown → `EMPTY`; `m+n == k` → all unknown → `LINE`.
2. **Vertex forcing.** Every dot has loop-degree ∈ `{0,2}`. With `lineCount` `m`,
   `unknownCount` `n`: `m > 2` → contradiction; `m == 2` → unknown → `EMPTY`;
   `m == 1, n == 0` → contradiction; `m == 1, n == 1` → that unknown → `LINE`;
   `m == 0, n == 1` → that unknown → `EMPTY`.

### Subloop prevention

When an edge is assigned `LINE` joining dots `u, v`: if `find(u) == find(v)`, a
cycle just closed. This is valid **only** if it completes the whole puzzle —
checked by: every clue exactly satisfied, no `UNKNOWN` edges remain, and the
closed loop contains *all* `LINE` edges (loop length == total `LINE` count). If
the closure leaves `LINE` edges outside it → contradiction (premature subloop).

### Search (`_backtrack`)

When propagation stalls with `UNKNOWN` edges left: pick the most-constrained
`UNKNOWN` edge (adjacent to the tightest clue / a vertex with `lineCount == 1`),
branch `LINE` then `EMPTY`, recurse. `maxMs` checked between nodes; on timeout
return `{ solved: false, error: 'timed out' }`.

### Completion

A fully-decided grid with all clues satisfied, all vertices degree 0/2, and all
`LINE` edges in one loop is a valid solution — guaranteed by the propagation
invariants plus the subloop check, so no separate full re-validation is needed.
The fuzz test independently cross-checks this.

### Output / hint / cache

- `solve()` → `{ solved, horizontal: int[H+1][W], vertical: int[H][W+1], error? }`
  (`0` = empty, `1` = line).
- `getHint(curH, curV)` → seed edges from the current board, run propagation,
  return the newly-forced `LINE` edges; if propagation deduces nothing, solve and
  reveal one `LINE` edge. The result is a list of edge entries
  `{ orientation: 'h' | 'v', r, c }`; `content.js` wraps it into the
  cross-puzzle hint object (mirroring the Galaxies line-hint shape:
  `{ type: 'slitherlink', edges, count, ... }`). Hint reveals `LINE` edges only
  (parity with Galaxies; `×` marks are out of scope — see §12).
- Static `_solutionCache`, FNV-1a keyed on `(width, height, task)`, 50-entry LRU;
  static `clearSolutionCache()` for test determinism.
- `module.exports` adds `SlitherlinkSolver`.

## 5. Worker — `solver.worker.js`

Add a `slitherlink` dispatch case passing `{ task, width, height }` to
`new SlitherlinkSolver({ ..., maxMs: 30000 })`. 30 s budget so large weekly
boards solve fully by deduction.

## 6. Handler — `slitherlinkHandler` (handler.js)

Mirror `galaxiesHandler`, registered via `registerHandler`:

- `matches()` → `isPuzzlesMobilePage() && location.pathname.includes('/loop/')`.
- `detect()` → `callMainWorld('readSlitherlinkData')` → `{ type: 'slitherlink',
  task, width, height }`.
- `readState()` → `callMainWorld('readSlitherlinkState', [h, w])` →
  `{ horizontal, vertical }`.
- `applySolution(solution)` → `callMainWorld('applySlitherlinkState',
  [{ horizontal, vertical }])`; returns `{ success, error? }`.
- `applyHint(hint)` → apply the hint's edges via `applySlitherlinkState`.

## 7. MAIN-world — main-world.js / background.js / globals.d.ts

- `readSlitherlinkData()` → `{ task, width: puzzleWidth, height: puzzleHeight }`.
- `readSlitherlinkState(rows, cols)` → `{ horizontal: cellHorizontalStatus,
  vertical: cellVerticalStatus }` (deep-copied).
- `applySlitherlinkState(lines)` → near-clone of `applyGalaxiesState`:
  `saveState(true)`, write `cellHorizontalStatus` / `cellVerticalStatus` from
  `lines.horizontal` / `lines.vertical` (`1` for line, `0` else), fall through the
  `drawCurrentState → render → redraw` ladder. No `Game.check()` call (consistent
  with the rest of the extension).
- `background.js`: add `readSlitherlinkData`, `readSlitherlinkState`,
  `applySlitherlinkState` to `EXEC_MAIN_ALLOWLIST` (17 → 20 entries).
- `globals.d.ts`: add the three names to the `MainWorldFn` union.

## 8. content.js wiring

- `runSolve` — slitherlink arm building the worker payload and unpacking
  `{ horizontal, vertical }`.
- `recordSolveSuccess` — cache the edge solution; add a `slitherlinkCacheKey`
  (FNV-1a over `task`) localStorage entry, mirroring the galaxies cache, so
  Solve/Hint/Loop reuse it.
- `autoSolve` / `detectHandler` — already generic; slitherlink rides the existing
  background-solve path.
- Loop button done-check — slitherlink arm: "done" when every solution `LINE`
  edge is present on the board.
- `applyHintHandler` / `applyAndRunLoop` — slitherlink arms: re-read edge state,
  overlay the hint's `LINE` edges, apply via `applySlitherlinkState` (the generic
  cell-state `applyHintCells` path does not apply — this mirrors the
  shikaku/galaxies special arms).

## 9. Preview & diff

### `drawPreview` slitherlink arm

- `staticLayer` (rebuilt on shape change; `staticSig` gains a `|sl=` segment):
  the dot lattice + clue numbers centered in cells.
- Dynamic layer: loop `LINE` edges drawn as thick segments between dots.
- Reuse the existing two-layer cache pattern.

### `computePuzzleDiff` slitherlink arm — edge-based

Slitherlink mistakes are on **edges**, not cells, so the diff deviates from the
"ring cells" pattern: compare the board's `horizontal` / `vertical` against the
cached solution edge-by-edge; return the set of mismatched edges. `drawPreview`
paints wrong edges in the warning color. Only edges the board has actually
committed (non-empty) are compared, so a blank board flags nothing.

## 10. Tests & bench

- `tests/fixtures/puzzles.js` — a small deterministic Slitherlink puzzle (e.g.
  3×3) with a unique solution; golden snapshot in `tests/golden.js`, regenerable
  via `npm run capture`.
- `tests/solver.test.js` — `SlitherlinkSolver` unit tests: clue forcing, vertex
  forcing, subloop rejection, a full solve, `maxMs` bail-out, hint correctness,
  cache reuse.
- `tests/slitherlink-fuzz.test.js` — generate solvable boards; assert every
  solved board is a single closed loop satisfying all clues; small-grid
  completeness cross-check.
- `tests/fixtures/real-puzzles.js` — the captured 5×5; the user can Dump larger
  boards once `dumpPuzzleForBench` supports the type.
- `tests/bench-slitherlink.js` — mirror `bench-galaxies.js` (2 warmup discards,
  `process.exit(1)` on unsolved); add to `.github/workflows/bench-nightly.yml`.

## 11. Easy-to-miss

- `dumpPuzzleForBench` (main-world.js) needs a `slitherlink` branch emitting the
  `real-puzzles.js` shape.
- `drawNonogramGuidesOn` must exclude `slitherlink`.
- No `manifest.json` change — no new runtime files (the solver class lives in
  `solver.js`, the handler in `handler.js`, etc.).
- `npm run build` after editing source files; `npm test` / `npm run lint` /
  `npm run typecheck` must pass.

## 12. Out of scope (future)

- `×` (cross / definitely-not-loop) marks: neither apply nor hint write `2`. A
  complete loop does not need them, and the `2` encoding is unconfirmed.
  Revealing forced-`EMPTY` edges as `×` hints would need a one-line recon to
  confirm `2`, and is a clean follow-up.
- A 1-step lookahead phase (like Binairo / Yin-Yang): added only if a real-puzzle
  bench shows backtracking is too slow.
