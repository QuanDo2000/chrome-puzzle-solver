# Kurodoko puzzle support — design

Date: 2026-05-24
Status: approved (pending spec review)

Adds `/kurodoko/*` to the existing puzzle solvers. 12th puzzle type.
Same cell encoding as Heyawake/Hitori (0=unknown, 1=black, 2=white) with
identical adjacency + connectivity rules. The distinguishing rule is the
visibility-sum clue: each numbered cell counts the total white cells
visible from it in the 4 cardinal directions (plus itself) up to the
nearest black cell or edge.

## 1. Page recon

From `/kurodoko/random/5x5`:

- `G.slug === 'kurodoko'`. URL `/kurodoko/`. Dimensions `puzzleWidth × puzzleHeight`.
- `G.task` — 2D `int[H][W]`. `-1` = no clue. Positive integer = the
  visibility-sum clue for that cell.
- `G.currentState.cellStatus` — 2D ints. Same encoding as Hitori:
  `0=unknown, 1=black, 2=white`. **Clue cells stay at 0 in cellStatus**
  for the page's lifetime — the page renders them as the clue number,
  and any "edit" on a clue cell is routed via a separate `taskStatus`
  array (see `setCellState` source below).
- `setCellState`:
  ```js
  function(t,e) {
    if (-1 != e) {
      if (t.clueNumber && void 0 !== this.currentState.taskStatus) {
        this.currentState.taskStatus[t.row][t.col] = e;
      } else {
        this.currentState.cellStatus[t.row][t.col] = e;
      }
    }
  }
  ```
  ⇒ clue cells write to `taskStatus`; non-clue cells write to `cellStatus`.
- `G.blacks: -1` — sentinel, unused by solver.
- `G.dr: array[8]`, `G.dc: array[8]` — page tracks 8 directions
  internally for visibility-arm rendering. **Solver only needs the 4
  cardinals.**

## 2. Rules

1. **Numbered cells stay white** — they're givens. Always cellStatus 2
   internally; never shaded.
2. **Visibility sum** — for each clue cell with value `K`, the count of
   white cells visible from it (in the 4 cardinal directions, plus
   itself) equals `K`. Black cells or the grid edge stop visibility.
3. **No adjacent blacks** — no two black cells share an edge.
4. **White connectivity** — all white cells form one orthogonally-
   connected component.

## 3. Solver — `KurodokoSolver` in `solver.js`

### Inputs

```js
new KurodokoSolver({
  rows, cols,
  task: 2D int[H][W],           // -1 = no clue, ≥1 = clue value
  initialState?: 2D int (0/1/2),
  maxMs?,
})
```

### Internal state

- `cellStatus: Uint8Array(rows*cols)` — flat, 0/1/2.
- `task: Int32Array(rows*cols)` — flat copy of the clue grid; -1 outside
  clue positions.
- `clues: Int32Array` — flat indices of clue cells.
- `clueValues: Int32Array` — parallel to `clues`.
- Trail and `_depth`/`_inLookahead`/`maxMs`/`_startedAt` — same as Hitori.

Constructor:
1. Copy task into `this.task` flat.
2. Build `clues` + `clueValues` from non-`-1` task entries.
3. Copy `initialState` into `cellStatus` (default 0).
4. **Force every clue cell to cellStatus=2** via `_set(idx, 2)`. The
   adjacency cascade in `_set` will fire automatically for any
   black-adjacent clue cell (rare on a fresh board, but defensive).

### Propagation rules

**Rule 2 (visibility)** — `_applyVisibility()`:

For each clue cell at flat index `idx` with value `K`:

1. Compute `(r0, c0)` from `idx`.
2. For each of 4 directions `[(-1,0),(1,0),(0,-1),(0,1)]` (up, down, left, right):
   - Walk outward from `(r0, c0)` collecting cells until first known-black
     or edge. The collected cell flat-indices go into `cellsByDir[d]`.
   - `lower[d]` = count of consecutive **known-white** cells from the
     start of the walk (stops at first unknown or black).
   - `upper[d]` = `cellsByDir[d].length` (cells until first known-black or
     edge — includes whites and unknowns).
3. `totalLower = Σ lower[d] + 1`. `totalUpper = Σ upper[d] + 1`. (`+1`
   accounts for the clue cell itself.)
4. If `totalLower > K` or `totalUpper < K` → return false (contradiction).
5. **Per-direction tightening.** For each direction d:
   - `otherSumUpper = totalUpper - 1 - upper[d]` (everything except this
     direction; `-1` removes the clue cell from the sum).
   - `otherSumLower = totalLower - 1 - lower[d]`.
   - `vis_d_min = max(lower[d], (K - 1) - otherSumUpper)`.
   - `vis_d_max = min(upper[d], (K - 1) - otherSumLower)`.
   - If `vis_d_min > vis_d_max` → return false.
   - Force cells `cellsByDir[d][0..vis_d_min - 1]` to white.
   - If `vis_d_min === vis_d_max && vis_d_max < cellsByDir[d].length`:
     force `cellsByDir[d][vis_d_max]` to black (the stopping cell).

This is sound but not complete — some achievable-visibility values may
have gaps (e.g. `cells = [unknown, known-white, unknown]` admits
`vis = 0, 2, 3` but not 1). Sound deductions are made; lookahead +
backtracking fills any gaps the per-direction tightening misses.

**Rule 3 (no adjacent blacks)** — eager in `_set` (clone from
Heyawake/Hitori).

**Rule 4 (white connectivity)** — `_applyConnectivity` is a direct
code-clone from `HeyawakeSolver._applyConnectivity`: BFS reachability
through `{white ∪ unknown}` for contradiction detection; iterative
Tarjan articulation analysis to force critical unknowns to white.
Guarded by `_inLookahead` (skip articulation inside probes).

### Lookahead

`_applyLookahead` at `_depth === 0 && !_inLookahead`. Probe each unknown
cell with each value `[1, 2]`; force survivor if exactly one passes.
Identical shape to Hitori's.

### Backtracking

Most-constrained variable: prefer cells whose row/col contains many
unknowns that contribute to a clue's visibility-arm. Simple heuristic:
score by (# of clue cells visible from this cell × inverse-of-clue-slack).
Branch [1, 2] (black first).

### `solve()` / caches

Standard pattern — `_isComplete`, `_emit`, static `_solutionCache` (50)
and `_partialCache` (20), FNV-1a key over `(rows, cols, task[])`.

**`_emit()` behavior**: for clue cells, emit 0 (not 2). For non-clue
cells, emit `cellStatus[idx]`. This keeps the apply path simple: when
`applyKurodokoState` writes the grid, clue cells get written as 0 which
matches the page's invariant ("clue cells stay at 0 in cellStatus").

### Stepwise `getHint`

Same shape as Hitori's:
1. Per clue cell, run visibility tightening; stop at first clue that
   yields a forced write.
2. Run connectivity; emit any forced whites.
3. Single lookahead probe.

**Filter clue cells out of the changed-cell diff** — their forced-to-2
status is the constructor's initialization, not a user-facing hint.

### Cache

`_cacheKey`: FNV-1a of `(rows, cols, task[])`. Mirrors Hitori's.

## 4. MAIN-world functions — `main-world.js`

```js
function readKurodokoData() {
  // Returns { rows, cols, task: 2D copy of G.task }.
}

function readKurodokoState(rows, cols) {
  // 2D copy of G.currentState.cellStatus.
}

function applyKurodokoState(grid) {
  // saveState(true) → for each cell: if task[r][c] === -1, write cs[r][c] = grid[r][c].
  // Skip clue cells (their cellStatus stays 0 per page convention).
  // Render ladder: drawCurrentState → render → redraw.
}
```

The `applyKurodokoState` function needs access to `task` to decide which
cells to write. It can read `window.Game.task` directly in MAIN world.

`dumpPuzzleForBench` gets a kurodoko branch — emits
`{type: 'kurodoko', rows, cols, task}` inline (no outer-function calls).

Hint apply uses generic `applyHintCells`: value=1 → cellStatus=1
(filled), value=2 → cellStatus=2 (cross/white-mark). Solver's getHint
filters out clue cells from the hint set, so `applyHintCells` never
writes to a clue cell.

## 5. Handler — `handler.js`

```js
registerHandler({
  type: 'kurodoko',
  priority: 30,
  matches: () => isPuzzlesMobilePage() && location.pathname.includes('/kurodoko/'),
  detect: async () => {
    const data = await callMainWorld('readKurodokoData', []);
    if (!data) return { found: false, error: 'No Kurodoko task data' };
    return { found: true, type: 'kurodoko', rows: data.rows, cols: data.cols,
             task: data.task, _cells: [] };
  },
  readState: ctx => callMainWorld('readKurodokoState', [ctx.rows, ctx.cols]),
  applySolution: grid => callMainWorld('applyKurodokoState', [grid]),
});
```

## 6. Worker — `solver.worker.js`

```js
} else if (type === 'kurodoko' && extraData) {
  const s = new KurodokoSolver({
    rows: extraData.rows,
    cols: extraData.cols,
    task: extraData.task,
    initialState: initialGrid || null,
    maxMs: 30000,
  });
  result = s.solve();
}
```

## 7. Content.js touchpoints

- `SUPPORTED_PUZZLES` — insert alphabetically (between Kakurasu and Nonogram).
- `SOLUTION_KEY_PREFIXES` — `'kurodoko-solution:'`.
- `solveExtraData` — kurodoko arm: `{rows, cols, task}`.
- `kurodokoCacheKey(data)` — FNV-1a of rows/cols/task. Wire alongside
  kakurasuCacheKey at the dispatch sites.
- `gridDataSig` / `staticSig` — `|kd=` segment (hash of task).
- `drawPreview` — new kurodoko arm:
  - Static layer (`|kd=`-keyed): outer border + light grid lines + clue
    numbers rendered at their cells.
  - Dynamic layer: for non-clue cells:
    - `cellStatus === 1` (filled): solid dark inset.
    - `cellStatus === 2` (cross/white): small X mark.
    - `cellStatus === 0`: empty.
  - Clue cells: render the number; never paint over them with shading.
  - Hint overlay: blue ring on forced cells.
  - Mistake rings: `computePuzzleDiff('kurodoko', board, solution)` via
    the generic cell-state arm (extend the existing
    `'heyawake' || 'hitori' || 'kakurasu'` arm to also include kurodoko).
- `getHint` dispatch — kurodoko arm constructs `KurodokoSolver` with
  task, calls `solver.getHint(grid)`, packs as `{type:'kurodoko',
  extraCells, count}`.
- `setHintStatus` — add kurodoko arm calling `kurodokoHintStatusNodes(h)`
  (clone of hitori's; same `extraCells` shape, label text "shaded" /
  "unshaded").
- `solveHandler` partial arm — add a kurodoko 2D-grid branch.
- `pendingAutoSolve` gate — extend `skipAutoSolveGate` to include kurodoko.
- Loop early-break exclusion — add `kurodoko` to the type list.
- `drawNonogramGuidesOn` rect-bail — add kurodoko.

## 8. Background.js + globals.d.ts + eslint.config.js

Three entries each:
- `readKurodokoData`, `readKurodokoState`, `applyKurodokoState` in
  `EXEC_MAIN_ALLOWLIST` and `MainWorldFn`.
- `KurodokoSolver` declared in `globals.d.ts` + listed in `eslint.config.js`
  solverClasses block.

## 9. Tests

- `tests/fixtures/puzzles.js` — `kurodoko5x5Easy` from the recon.
- `tests/golden.js` — solved snapshot (solver-derived).
- `tests/fixtures/real-puzzles.js` — `kurodoko5x5EasyReal`.
- `tests/kurodoko.test.js` — unit tests:
  - Constructor forces clue cells to white.
  - `_applyVisibility`: K=1 forces 4 neighbours black.
  - `_applyVisibility`: K=max forces all in-line cells white.
  - `_applyVisibility`: per-direction tightening (e.g., K=3 in a corner).
  - Connectivity unchanged from Hitori (one regression test).
  - `solve()` on the recon fixture.
  - Stepwise `getHint` returns small batches.
  - Cache deep-copy.
- `tests/kurodoko-fuzz.test.js` — generate random valid solutions
  (random shading respecting adjacency + connectivity), derive clues by
  walking visibility arms from chosen clue positions, verify solver
  recovers a solution satisfying all 4 rules.
- `tests/bench-kurodoko.js`, `tests/bench-real.js` arm, nightly
  workflow step.

## 10. Out of scope

- The more aggressive "visibility-with-gaps" deduction (capturing
  achievable-visibility set rather than [lower, upper] interval). Sound
  baseline + lookahead is sufficient for typical 5×5 to 15×15 puzzles.
- Multi-solution detection.
- Clue cells with K = 0 (degenerate / impossible — every clue cell
  counts itself, so K ≥ 1 always).

End of design.
