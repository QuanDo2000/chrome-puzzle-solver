# Heyawake puzzle support — design

Date: 2026-05-24
Status: approved (pending spec review)

Adds `/heyawake/*` to the eight existing puzzle types. Follows the standard
Binairo / Yin-Yang shape: cell-state encoding, propagate-then-backtrack
solver with top-level 1-step lookahead, full feature parity (Solve / Hint /
Loop / preview / mistake diff / cache / dump).

## 1. Page recon

Live captures from `https://www.puzzles-mobile.com/heyawake/random/6x6-easy`
on 2026-05-24:

- `G.puzzleHeight`, `G.puzzleWidth` — board dimensions.
- `G.slug === 'heyawake'`. URL path is `/heyawake/`.
- `G.areas` — 2D `int[H][W]`. Each entry is the room id (0..K-1) for that
  cell. The 6×6 sample partitions into 11 rooms.
- `G.areaPoints` — `Array<{row, col}>[K]`. Cells belonging to each room.
- `G.areaTask` — `int[K]`. Required black count per room, or `-1` for
  "no clue".
- `G.currentState.cellStatus` — 2D `int[H][W]`. Encoding **identical to
  Binairo**: `0 = empty / unknown, 1 = black, 2 = white`. Verified
  against a solved capture: rooms with target=0 had cells set to 2;
  rooms with target=1 of size 1 had that cell set to 1.
- `G.currentState.cellColor` — 2D `int[H][W]`, all zeros in the sample.
  Not used by the solver.
- `G.currentState.autoX` — sparse 2D, empty in the sample. Not used.
- `G.setCellState(cell, e)` — `cellStatus[cell.row][cell.col] = e` when
  `e !== -1`. Plain write, no validation. Suitable for our apply path,
  though we'll write `cellStatus` directly to stay symmetric with the
  other cell-state puzzles.
- `G.dr / G.dc` — `[-1,0,1,0]` / `[0,1,0,-1]` (up, right, down, left).
- Rooms are **always rectangular** per the page's `parseTask` source:
  each room is parsed as `"<n>,<w>,<h>"` (or `"b,<w>,<h>"` for "no
  clue"), placed at the next unfilled row-major position. Solver
  exploits the rectangle property only for hint-status / preview cosmetics;
  the propagation rules treat rooms as arbitrary cell sets so the code
  doesn't depend on rectangularity surviving page changes.

## 2. Rules

Heyawake's four constraints — all enforced:

1. **Room count.** For every room with `target ≥ 0`, the number of black
   cells in that room equals `target`.
2. **No adjacent blacks.** No two black cells share an edge (orthogonal
   4-neighbour).
3. **White connectivity.** All white cells form a single orthogonally-
   connected region. (Equivalent to "blacks do not partition the white
   cells".)
4. **No 3-rooms straight white line.** In any row or column, a maximal
   contiguous run of white cells must not touch 3 or more distinct rooms.
   Stated as a positive constraint: every minimal contiguous horizontal-
   or-vertical span of cells covering 3+ distinct rooms contains at least
   one black.

## 3. Solver — `HeyawakeSolver` in `solver.js`

### Inputs

```js
new HeyawakeSolver({
  rows, cols,
  rooms: [{cells: [{r, c}], target}],
  initialState?: 2D int (0/1/2),
  maxMs?: number,
})
```

- `rooms` is the canonical input. The constructor builds:
  - `cellToRoom: Int32Array(rows*cols)` — flat lookup.
  - `roomCells: Int32Array[K]` — cell indices per room (flat).
  - `target: Int32Array(K)` — copy of `rooms[k].target`.
- `initialState` seeds `cellStatus` for incremental solves (Hint path).

### Internal state

- `cellStatus: Uint8Array(rows*cols)` — flat, 0/1/2.
- `trail: Int32Array` growable — each entry encodes `cellIdx | (oldValue << 24)`.
  `_set(idx, value)` pushes the trail entry **only** if a real change
  happens (matches Binairo's `_assign`). `_rollback(mark)` pops back to
  `mark`.
- `_depth`, `_inLookahead`, `_startedAt`, `maxMs` — same conventions as
  Binairo / Yin-Yang.

### Precomputed rule data

At construction time:

- `roomTargetLines: { roomId, target }[]` — only rooms with `target ≥ 0`.
  `target = -1` rooms get no count constraint (any black count valid)
  but still participate in rules 2, 3, 4.
- `lineConstraints: Int32Array[]` — one entry per minimal 3-rooms span.
  Built by scanning each row left-to-right and each column top-to-bottom:
  - Walk the row maintaining a sliding window of `(start, room1Start,
    room2Start, currentRoom)` such that the window contains exactly 3
    distinct rooms. Emit the minimal window covering exactly 3 rooms.
  - Same for columns.
  - Stored as flat `Int32Array` of cell indices for the span.
- `lineConstraintsByCell: Int32Array[rows*cols]` — for each cell, list
  of line-constraint indices it participates in. Lets the incremental
  propagator only re-check constraints involving recently-changed cells.

### Propagation — `_propagate()`

Iterates rules to fixpoint, cheapest first. Each rule returns `false` on
contradiction; the outer loop tracks "did anything change" via
`this.trail.length` mark.

**Rule 1: Room saturation** (`_applyRoomCounts`)
For each `roomTargetLines` entry:

- Count blacks `nB` and unknowns `nU` in the room.
- If `nB > target` → contradiction.
- If `nB + nU < target` → contradiction.
- If `nB === target && nU > 0` → all unknowns force white.
- If `nB + nU === target && nU > 0` → all unknowns force black.

**Rule 2: No adjacent blacks** (`_applyAdjacency`)
Triggered by black writes. Implemented eagerly: every `_set(idx, 1)`
inside the propagator walks the four neighbours and forces white. Done
in-line in `_set` rather than as a separate scan to avoid re-walking the
grid each iteration. Contradiction if a neighbour is already black.

**Rule 3: No-3-rooms line** (`_applyLineConstraints`)
For each line constraint (cell-index list):

- Count blacks `nB` and unknowns `nU` in the span.
- If `nB === 0 && nU === 0` → contradiction (all white).
- If `nB === 0 && nU === 1` → the unknown cell forces black.
- (No tighter deduction without sub-spans; the minimal spans are
  generated tight enough that one-unknown forcing is the main lever.)

**Rule 4: White connectivity** (`_applyConnectivity`)
Two-tier:

(a) **Reachability BFS.** Pick the lowest-index `white` cell as anchor.
BFS through `{white ∪ unknown}` cells. Any `white` cell not visited
forces every `unknown` on the only path between them to be `white`.
Implementation: BFS twice — once from anchor, once from each isolated
white island — find cut cells. Cheaper variant: only the BFS-from-anchor
sees unreachable whites, then we don't have a forced deduction unless
articulation analysis runs.

(b) **Articulation analysis.** If (a) deduced nothing this iteration,
run iterative Tarjan over the `{white ∪ unknown}` graph rooted at any
white. An articulation cell whose removal would disconnect two known-
white cells must itself be white — force it. Mirrors
`YinYangSolver._applyCut`.

Rule 4 is the most expensive; runs last in the iteration and is skipped
inside `_applyLookahead` probes (the `_inLookahead` guard).

### Lookahead

`_applyLookahead` runs only at `_depth === 0` and outside lookahead. For
each empty cell, probe each value (black, white). If exactly one probe
survives, force the survivor. Same structure as
`BinairoSolver._applyLookahead` / `YinYangSolver._applyLookahead`.

### Backtracking

Most-constrained-variable pick. For each unknown cell, compute a
"tightness" score where higher = more constrained:

- `roomTightness` — in the cell's room, smaller `min(target - blacks,
  unknowns - (target - blacks))` means a more strained budget. Take
  `1 / (slack + 1)` so a tight room scores high (no division-by-zero;
  rooms with `target = -1` get `slack = unknowns`, low tightness).
- `adjacencyTension` — count of 4-neighbours that are already
  determined (each one removes a free variable in its row/col line
  constraints touching this cell).
- `lineTension` — count of line constraints touching this cell that
  have ≤ 1 unknown remaining (excluding this one).

Score = `roomTightness * 4 + adjacencyTension + lineTension`. Pick
highest. Branch order `[black, white]` (black writes propagate harder
via rule 2's eager adjacency rule-out).

After each branch: `_assign`, `_propagate`, recurse, `_rollback` on
failure. Standard.

### `solve()`

```js
solve() {
  const key = this._cacheKey();
  const cached = HeyawakeSolver._solutionCache.get(key);
  if (cached) return this._cloneResult(cached);
  this._startedAt = Date.now();
  let result;
  if (!this._propagate()) {
    this._rollback(0);
    result = { solved: false, grid: null };
  } else if (this._isComplete()) {
    result = { solved: true, grid: this._emit() };
  } else if (!this._backtrack()) {
    const partial = this._emit();
    result = this._timeUp()
      ? { solved: false, grid: partial, error: 'timed out', partial: true }
      : { solved: false, grid: null };
  } else {
    result = { solved: true, grid: this._emit() };
  }
  this._storeInCache(key, result);
  return result;
}
```

- `_emit()` returns a 2D `Array<Array<int>>` of the current `cellStatus`
  (translated from the flat `Uint8Array`).
- `partial: true` flag is set only on timeout — content.js's existing
  partial-result arm already handles `2D` grids (extended in this PR
  from slitherlink-only).
- The contradiction path rolls back before emitting (Hashi fix #6
  precedent; don't leak mid-propagation state into the cache).

### `getHint(initialState)`

Same shape as `BinairoSolver.getHint` / `YinYangSolver.getHint`:
returns `[{row, col, value}, ...]` of forced cells, or `null` if nothing
deducible.

- Construct a fresh `HeyawakeSolver` with the live `cellStatus` as
  `initialState`.
- Run `_propagate()` (no lookahead — too expensive per click). Collect
  cells that became 1 or 2.
- If nothing forced: run a single `_applyLookahead` step (gated by
  `_inLookahead`).
- If still nothing: return `null`.

`getHint` propagates from live state, so it does NOT consult
`puzzleData.solution`. The `pendingAutoSolve` gate (content.js fix #8)
extends to heyawake.

### Caches

Two static caches on `HeyawakeSolver`:

```js
static _solutionCache = new Map();      // 50-entry LRU, full solutions
static _maxSolutionCache = 50;
static _partialCache = new Map();       // 20-entry LRU, timeout snapshots
static _maxPartialCache = 20;
static clearSolutionCache() {           // clears BOTH (tests depend on it)
  HeyawakeSolver._solutionCache.clear();
  HeyawakeSolver._partialCache.clear();
}
```

Key: FNV-1a hash of `(rows, cols, target.toString(), areas-flat.toString())`.
Mirrors `BinairoSolver._cacheKey`.

`_cloneResult` deep-copies the grid (`grid.map(row => row.slice())`) on
both store and read. Mirrors `HashiSolver._cloneResult` after fix #6.

## 4. MAIN-world functions — `main-world.js`

Three new functions, each `try`-wrapped, returning `null` on failure
(extractor) or `false` on failure (apply):

```js
function readHeyawakeData() {
  // Extracts rows, cols, areas (2D copy), rooms ({cells, target}).
  // Builds rooms by iterating G.areaPoints and pairing with G.areaTask.
}

function readHeyawakeState(rows, cols) {
  // Returns 2D copy of G.currentState.cellStatus.
  // Defensive: clamps row length to cols, fills missing rows/cells with 0.
}

function applyHeyawakeState(grid) {
  // 1. Game.saveState(true)  — BEFORE writes (mandatory per CLAUDE.md)
  // 2. cellStatus[r][c] = grid[r][c] for every cell
  // 3. Render ladder: drawCurrentState → render → redraw → draw
}
```

Hint apply reuses the generic `applyHintCells(cells)` — the encoding
matches Binairo / Yin-Yang exactly. Loop's per-tick apply uses
`applyHeyawakeState` for full-board writes.

`dumpPuzzleForBench` gets a heyawake arm: emits
`{type:'heyawake', rows, cols, areas, areaTask, cellStatus}` so test
fixtures can be captured. The arm checks `slug === 'heyawake'` or
`/heyawake/`.

## 5. Handler — `handler.js`

```js
registerHandler({
  type: 'heyawake',
  matches: url => url.includes('/heyawake/'),
  readData: () => callMainWorld('readHeyawakeData', []),
  readState: (rows, cols) => callMainWorld('readHeyawakeState', [rows, cols]),
  applySolution: grid => callMainWorld('applyHeyawakeState', [grid]),
});
```

## 6. Worker — `solver.worker.js`

```js
} else if (type === 'heyawake' && extraData) {
  const s = new HeyawakeSolver({
    rows: extraData.rows,
    cols: extraData.cols,
    rooms: extraData.rooms,
    initialState: initialGrid || null,
  });
  s.maxMs = 30000;
  result = s.solve();
}
```

The catch block already returns `grid: null, edges: type==='hashi'?[]:undefined`.
Heyawake's grid-shape error path is already covered (grid: null is the
expected shape).

## 7. Content.js touchpoints

Concrete edits (each is a small arm, 1-10 lines):

- **`SUPPORTED_PUZZLES`** — add `{name:'Heyawake', url:'.../heyawake/'}`,
  alphabetically between Hashi and Nonogram.
- **`SOLUTION_KEY_PREFIXES`** — add `'heyawake-solution:'`.
- **`getCachedGridSolution` / `cacheGridSolution`** — generic 2D arm
  already covers heyawake; localStorage key prefix above is the only
  addition needed.
- **`gridDataSig`** — generic 2D arm covers it. `staticSig` gains a
  `|hy=` segment built from `areas`.
- **`drawPreview`** — new heyawake arm. Paints:
  - Filled black cells with solid fill.
  - Filled white cells with a small dot / circle marker (distinguishes
    "forced white" from "unknown"; reuse the yin-yang convention).
  - Room borders: thick black lines between distinct `areas[r][c]`
    values, painted on the static layer (cached, `|hy=` sig keyed off
    `areas`).
  - Room number clues: rooms with `target ≥ 0` get the target value
    overlaid on the static layer at the top-left cell of the room
    (the page renders them there too). `target = -1` rooms render no
    number.
  - Hint overlay: rings cells flagged by `computePuzzleDiff`.
- **`computePuzzleDiff`** — generic cell-arm: for each cell where
  `board[r][c] !== 0 && board[r][c] !== solution[r][c]`, emit
  `{row, col, expected, actual}`. Same shape as nonogram / aquarium.
- **`getHint`** — new arm constructs `HeyawakeSolver` with
  `initialState = grid`, calls `solver.getHint(grid)`. Returns same
  shape as Binairo/YinYang hints.
- **`hintHandler`** — `skipAutoSolveGate` (fix #8) gains heyawake.
- **`solveHandler`** partial arm — add a third branch alongside
  `applyPartialResult` (slitherlink, `{horizontal, vertical}`) and
  `applyHashiPartialResult` (hashi, `{edges}`): new
  `applyGridPartialResult(result)` handles `{grid: 2D}` shape. Heyawake
  is the first caller; the helper is also available if other cell-state
  puzzles ever want partials. Status text: `Partial only: N cells
  deduced (board too hard for full solve). Apply, then finish manually.`
  where N counts non-zero cells. Deliberately does NOT call
  `recordSolveSuccess` (matches the slitherlink/hashi precedent — caching
  a partial would mis-trigger Loop done-check and the mistake overlay).
- **`runLoop` done-check** — generic "every cell !== 0" arm covers
  heyawake.
- **`recordSolveSuccess` / `previewGridFromResult`** — generic
  `result.grid` arm covers heyawake; no per-type branch needed.

## 8. Background.js + globals.d.ts

Add three entries to `EXEC_MAIN_ALLOWLIST` (background.js) and three
to `MainWorldFn` (globals.d.ts), both lists kept symmetric:

- `readHeyawakeData`
- `readHeyawakeState`
- `applyHeyawakeState`

(CLAUDE.md note already updated to not pin a count — fix #15.)

## 9. Tests

- **`tests/fixtures/puzzles.js`** — `heyawake6x6Easy` and a smaller
  deterministic 3-room toy.
- **`tests/golden.js`** — golden snapshots for both fixtures.
- **`tests/fixtures/real-puzzles.js`** — full 6×6 easy from the recon
  dump (the cellStatus is the published solution; fixture stores
  `areas + areaTask` as the puzzle and the solved cellStatus as the
  expected solution).
- **`tests/heyawake.test.js`** — solver unit tests:
  - Per-rule minimal fixtures (one for each of the 4 rules — a board
    that's unsolvable without that single rule but solvable with).
  - Round-trip: solve then re-apply, expect the same grid.
  - `getHint` returns at least one forced cell on the easy fixture.
  - `getHint` returns `null` on a fully solved board.
  - `solve()` partial flag on a contrived `maxMs=1` setup.
  - Cache deep-copy: mutating a returned grid does not corrupt the
    cache (the Hashi cache regression test pattern).
- **`tests/heyawake-fuzz.test.js`** — random puzzle generator (place
  K random rectangular rooms, generate a satisfying assignment, set
  `target` from it, sometimes drop targets). For each generated
  puzzle: solve, assert the solution satisfies all 4 rules (room
  counts, no adjacent blacks, white connectivity via BFS, no-3-rooms
  line via scan).
- **`tests/bench-heyawake.js`** — `process.exit(1)` on unsolved.
- **`tests/solver.test.js`** — integration arm.
- **`bench-real.js`** — heyawake arm.
- **`.github/workflows/bench-nightly.yml`** — heyawake bench step.

## 10. Performance envelope (target)

| board | path | wall-time target |
| --- | --- | --- |
| 6×6 real | propagate alone | < 5 ms |
| 10×10 synthetic | propagate + 1 backtrack level | < 100 ms |
| 15×15 weekly | propagate + lookahead + backtracking | < 1 s |
| 25×25 monthly | propagate + lookahead; partial on timeout | budget 30 s, partial preview |

Lookahead is the main lever for >15×15. If 25×25 doesn't solve within
budget, the partial-return path activates (mirrors Slitherlink monthly).

## 11. Things explicitly NOT in scope

- **CDCL.** Slitherlink-style CDCL is unjustified for binary-cell
  domains with strong local rules. Revisit only if a monthly board
  proves consistently unsolvable within budget.
- **Room-rectangularity-specific deductions.** The page guarantees
  rectangular rooms via `parseTask`, but the solver treats rooms as
  arbitrary cell sets. The line-constraint precomputation is the only
  place that depends on the grid being rectangular at all (rows and
  columns are scanned), which is a board-shape assumption, not a room-
  shape assumption.
- **Per-rule hint naming** (the Hashi `stepwise` rule labels). Heyawake
  hints follow the Binairo/Yin-Yang pattern: a flat list of forced cells
  with no rule attribution. Stepwise hints are a per-puzzle feature; can
  be added later if requested.
- **Heyawake "spotlight" variants.** Some Heyawake variants add no-
  2x2-all-white or similar rules; the URL `/heyawake/` is standard, so
  these are out of scope.

## 12. Migration / rollout

- Single PR: solver + MAIN-world + handler + worker + content arms +
  tests + bench + CI step.
- No data migration (new puzzle type, no shared state).
- No backwards-compat: existing puzzle types untouched.

## 13. Open questions / risks

- **Rule 4 implementation cost.** Articulation analysis is the most
  expensive rule. The two-tier (BFS first) keeps the common case fast,
  but worst-case is O(unknowns) per propagation tick. Acceptable for
  ≤15×15; needs measurement at 25×25.
- **Line-constraint precomputation correctness.** Minimal 3-rooms spans
  must be generated such that they're TIGHT (one fewer cell would touch
  only 2 rooms). Fuzz test will catch off-by-one errors.
- **Backtracking variable order.** The MC pick scoring is a heuristic;
  if 15×15 weekly proves slow, may need profiling. Not blocking.

End of design.
