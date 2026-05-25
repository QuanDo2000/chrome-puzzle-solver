# Nurikabe puzzle support — design

Date: 2026-05-25
Status: approved

Adds `/nurikabe/*` to the existing puzzle solvers. 15th puzzle type.
Cell-state encoding (0=unknown, 1=black, 2=white) like Heyawake-family
— but constraints come from numeric clues, not regions. The site's
rules were verified by reading `getErrors` in the cloudfront JS bundle
(`nurikabe-*.js`) before designing.

## 1. Page recon

From `/nurikabe/random/5x5-easy`:

- `G.slug === 'nurikabe'`. URL `/nurikabe/`. `puzzleWidth × puzzleHeight = 5 × 5`.
- `G.task` — 2D `int[H][W]`. `-1` = blank, `>0` = clue value (island size).
  Sample: `[[2,-1,-1,1,-1],[-1,-1,-1,-1,-1],[3,-1,-1,-1,1],[-1,-1,-1,-1,-1],[-1,2,-1,-1,2]]`.
- `G.currentState.cellStatus` — 2D ints, `0=unknown, 1=black, 2=white`.
  Same encoding as Hitori / Mosaic / Heyawake / Norinori.
- Clue cells are rendered by the page as a separate DOM (`nurikabe-task-cell`).
  They're not user-toggleable. Their cellStatus is irrelevant to the page; the
  site's `getWhiteCount` traverses them as part of the white region when
  scanning from a different clue.
- No `areas` / `areaPoints` / `areaTask`.

## 2. Rules (per the site's `getErrors`)

1. Each clue cell `N` anchors an orthogonally-connected white island of
   exactly `N` cells (the clue cell itself counts).
2. Each island contains exactly one clue cell (`_getWhiteCount` returns -1
   if its BFS encounters another clue).
3. All black cells form a single orthogonally-connected component
   (`checkDisconnected` flags >1 black component or a single component
   smaller than `this.blacks`).
4. No 2×2 of black cells (`check2x2`).
5. Total black count = `rows*cols - sum(clueValues)` (the site stores it as
   `n.check` and uses it in `checkDisconnected`; we compute it).

There is no "wall" marker in the loaded `task` (the parser's `-2` decoder
output is for the encoded task string, not the runtime 2D).

## 3. Solver — `NurikabeSolver` in `solver.js`

### Inputs

```js
new NurikabeSolver({
  rows, cols,
  task,            // 2D int[H][W], -1 or positive
  initialState?,   // 2D cellStatus, 0/1/2
  maxMs?,
})
```

### Internal state

- `cellStatus: Uint8Array(rows*cols)`.
- `task: Int32Array(rows*cols)` — flat clues.
- `clues: Array<{idx, size}>` — list of clue cells, populated at construction.
- `expectedBlacks: number` — precomputed `rows*cols - sum(clueValues)`.
- `trail`, `_depth`, `_inLookahead`, `maxMs`, `_startedAt` — same shape as
  Heyawake.

At construction: every clue cell is forced to `cellStatus = 2` (WHITE)
via `_set`. Pre-check: each clue's reachable area (BFS through
{non-BLACK, non-other-clue}) ≥ N, else contradiction.

### `_set(idx, value)`

Plain trail-record assign. No cascade — cascades live in propagation
passes. Trail entry: `idx | (oldValue << 24)`.

### Rule 1: `_applyClueAdjacency`

For each unknown or white cell `c`, count distinct clue-cell 4-neighbours
of `c`. If two or more distinct clues are adjacent to `c`, `c` must be
BLACK (otherwise it would merge two islands). Additionally, if two clue
cells are themselves orthogonally adjacent, that's an immediate
contradiction (no possible solution can keep their islands separate
when their clue cells touch).

### Rule 2: `_applyUnreachable`

For each unknown cell `c`: compute whether ANY clue can reach `c`. "Reach"
is a BFS through `{WHITE ∪ UNKNOWN}` starting from the clue cell (or its
already-claimed white component), skipping BLACK cells and skipping other
clue cells, with path length ≤ N - 1 (where N is the clue's size). If no
clue can reach `c`, `c` must be BLACK.

Cheap pre-filter: Manhattan distance from `c` to every clue > N - 1 →
unreachable without running BFS.

### Rule 3: `_applyIslandComplete`

For each clue with current white-component size W (BFS through
`cellStatus === 2` from the clue cell, blocked by BLACK and by other
clues):

- W > N → contradiction (island too big).
- Reachable capacity `cap` (BFS through `{WHITE ∪ UNKNOWN}` from the
  white component, blocked by BLACK and other clues, counting unique
  cells) < N → contradiction.
- W == N → every UNKNOWN orthogonal frontier cell of the island is BLACK.
- cap == N (the island has exactly enough reachable cells to fit) → all
  reachable UNKNOWNs in `cap` are WHITE.

### Rule 4: `_apply2x2`

For each 2×2 box: count BLACKs. >3 → contradiction. ==3 with one UNKNOWN
→ UNKNOWN forced WHITE.

### Rule 5: `_applySeaConnectivity`

BFS the graph `{BLACK ∪ UNKNOWN}` from any BLACK cell.

- If multiple BLACK components exist in the BLACK-only graph and they
  can't be merged through UNKNOWN cells (i.e. there is no path through
  `{BLACK ∪ UNKNOWN}` connecting them) → contradiction.
- Articulation analysis: an UNKNOWN cell whose removal would disconnect
  the `{BLACK ∪ UNKNOWN}` graph in a way that strands a BLACK component
  from the rest of the BLACKs must be BLACK. (Iterative Tarjan over the
  combined graph rooted at any BLACK, like Yin-Yang's `_applyCut`.)

Guarded by `!_inLookahead` to keep inner probes cheap.

### Rule 6: `_applyBlackCount`

Count current BLACKs (`nB`) and UNKNOWNs (`nU`) globally.

- `nB > expectedBlacks` → contradiction.
- `nB + nU < expectedBlacks` → contradiction.
- `nB == expectedBlacks` → all remaining UNKNOWNs forced WHITE.
- `nB + nU == expectedBlacks` → all remaining UNKNOWNs forced BLACK.

### `_propagate`

```js
_propagate() {
  let changed = true;
  while (changed) {
    if (this._timeUp()) return true;
    changed = false;
    const mark = this.trail.length;
    if (!this._applyClueAdjacency()) return false;
    if (!this._applyUnreachable()) return false;
    if (!this._applyIslandComplete()) return false;
    if (!this._apply2x2()) return false;
    if (!this._applySeaConnectivity()) return false;
    if (!this._applyBlackCount()) return false;
    if (this.trail.length > mark) changed = true;
  }
  if (this._depth === 0 && !this._inLookahead) {
    if (!this._applyLookahead()) return false;
  }
  return true;
}
```

### Lookahead + backtracking + caches

Standard pattern, mirroring Yin-Yang / Heyawake / Norinori:

- `_applyLookahead` at top level: probe each unknown both values, run
  lookahead-free `_propagate`, force survivor on single-side
  contradiction. `_inLookahead` re-entry guard.
- `_pickBestUnknown` scores by known-neighbour count (more known
  neighbours = more constraints = pick first).
- Branch BLACK first, then WHITE.

### Completion check

After backtracking returns and all cells are set, verify:

- Every clue has an exact-size island.
- All BLACKs form one component.
- No 2×2 BLACK.
- Total BLACKs = `expectedBlacks`.

In practice a successful `_propagate` on a fully-assigned grid already
proves all of these (rules 1-6 collectively); the explicit check is a
defensive guard.

### Caches

`_cacheKey`: FNV-1a of `(rows, cols, task)` flat. 50-entry solution LRU +
20-entry partial LRU. Deep-copy via `_cloneResult` on store and get.

### `getHint(initialState)`

Per-rule stepwise. For each rule in `_propagate` order: apply rule once,
collect the new writes (cells whose status changed from 0), return them
as `[{row, col, value}]` if non-empty. Fall back to one lookahead probe.
Returns `null` on solved or stuck.

## 4. MAIN-world functions

```js
function readNurikabeData() {
  // { rows, cols, task: 2D int[H][W] }
  // null on missing G.task / dims.
}

function readNurikabeState(rows, cols) { /* 2D cellStatus */ }

function applyNurikabeState(grid) {
  // saveState(true)
  // For r,c where task[r][c] === -1: cellStatus[r][c] = grid[r][c]
  //   (skip clue cells — they're rendered separately and not toggleable)
  // drawCurrentState → render → redraw
}
```

`dumpPuzzleForBench` gets a nurikabe branch — inline extraction:

```js
return {
  type: 'nurikabe',
  rows: g.puzzleHeight,
  cols: g.puzzleWidth,
  task: <copied 2D>,
  cellStatus: <copied 2D, or null>,
  path: path
};
```

Hint apply: reuses generic `applyHintCells`. Solver's `getHint` already
omits clue cells (their cellStatus starts at 2 internally, so a diff from
0 never includes them).

## 5. Handler / Worker

Standard registration at `/nurikabe/`, priority 30. Worker arm with
`maxMs: 30000`. Mirrors Heyawake's shape (read data → construct → solve →
return grid).

## 6. Content.js touchpoints

Same shape as Heyawake / Hitori. The unique parts:

- **`SUPPORTED_PUZZLES`** — alphabetical insertion between Norinori and
  Shikaku.
- **`SOLUTION_KEY_PREFIXES`** — `'nurikabe-solution:'`.
- **`nurikabeCacheKey`** — FNV-1a of `task` bytes (clues never change),
  nameplate byte to avoid collision with other puzzle caches.
- **`staticSig`** — gains a `|nu=` segment hashing `task`.
- **`drawPreview`** — dynamic layer: `cellStatus===1` → solid dark fill,
  `cellStatus===2` → light fill (skip if cell is a clue cell; the page
  draws its number). Static layer: nothing region-specific.
- **`isNurikabe`** flag + per-cell render arm.
- **`getHint` dispatch** + `nurikabeHintStatusNodes`.
- **Loop done-check** — every solution cell of `value !== 0` matches on
  the board, ignoring clue cells.
- **Hint band** + per-cell ring.

## 7. Tests

- `tests/fixtures/puzzles.js` — `nurikabe5x5Easy` fixture from the recon.
- `tests/golden.js` — solved snapshot.
- `tests/fixtures/real-puzzles.js` — `nurikabe5x5EasyReal`.
- `tests/nurikabe.test.js` — solver unit tests:
  - Constructor sets clue cells WHITE, builds `clues` list, populates
    `expectedBlacks`.
  - Each propagation rule (per-rule small-case test).
  - `solve()` on the 5×5 recon.
  - `getHint` stepwise returns small batches; null on solved.
  - Cache deep-copy.
- `tests/nurikabe-fuzz.test.js` — generate small random valid Nurikabe
  instances (start from a solved board: pick a partition into islands,
  emit clue cells, blacks fill remainder), verify solver recovers a
  solution that satisfies all 5 rules.
- `tests/bench-nurikabe.js` — median over 5 runs.
- `tests/bench-real.js` arm.
- `.github/workflows/bench-nightly.yml` step.

## 8. Out of scope

- Solving 30×30 or larger boards under 1 second. Will revisit if a hard
  daily fails.
- Multi-solution detection.
- Special `-2` wall markers in `task` (parser produces them from the
  encoded task string but they don't appear in the loaded 2D, per recon).

End of design.
