# Mosaic puzzle support — design

Date: 2026-05-24
Status: approved (pending spec review)

Adds `/mosaic/*` to the existing puzzle solvers. 13th puzzle type. Same
cell encoding as Heyawake-family (0/1/2). Simpler than its neighbours:
**single propagation rule** — each clue counts blacks in its 3×3
neighborhood (clamped to grid). No adjacency rule, no connectivity rule.

## 1. Page recon

From `/mosaic/random/5x5-easy`:

- `G.slug === 'mosaic'`. URL `/mosaic/`. Dimensions `puzzleWidth × puzzleHeight`.
- `G.task` — 2D `int[H][W]`. `-1` = no clue. Integer 0..9 = clue value.
- `G.currentState.cellStatus` — 2D ints. `0=unknown, 1=black, 2=white-mark`. Same as Hitori.
- `setCellState`: `function(t,e){-1!=e&&(this.currentState.cellStatus[t.row][t.col]=e)}` — **no clue-cell branch**. Clue cells live in `cellStatus` like any other.
- `G.blacks: -1` — sentinel; unused.

## 2. Rules

For each clue cell `(r, c)` with value `K`: the count of black cells in
the 3×3 neighborhood centered at `(r, c)` — clamped to grid bounds and
**including `(r, c)` itself** — equals `K`. Corner clues have 4-cell
neighborhoods, edge clues 6-cell, interior 9-cell.

No adjacency rule. No connectivity rule. Clue cells participate in
their own neighborhood like any other cell.

Domain per cell: black, white-mark, unknown. Output requires all cells
determined (`cellStatus !== 0`).

## 3. Solver — `MosaicSolver` in `solver.js`

### Inputs

```js
new MosaicSolver({
  rows, cols,
  task: 2D int[H][W],     // -1 = no clue, 0..9 = clue value
  initialState?: 2D int (0/1/2),
  maxMs?,
})
```

### Internal state

- `cellStatus: Uint8Array(rows*cols)` — flat, 0/1/2.
- `task: Int32Array(rows*cols)` — flat copy.
- `clues: Int32Array(K)` — flat indices of clue cells.
- `clueValues: Int32Array(K)` — corresponding clue values.
- `clueNeighborhood: Int32Array[K]` — precomputed at construction. For
  each clue `i`, the flat indices of cells in its 3×3 neighborhood
  (clamped). Length 4 (corner), 6 (edge), or 9 (interior).
- `cellToClues: Int32Array[rows*cols]` — reverse index: for each cell,
  the list of clue indices whose neighborhood contains it. Used by
  future propagation queue optimization but not strictly required for
  the v1 implementation (which iterates all clues per propagation tick).
- Trail and meta — `idx | (oldValue << 24)`, `_depth`, `_inLookahead`,
  `maxMs`, `_startedAt`. Same as Hitori.

### `_set` (simpler than Heyawake-family)

```js
_set(idx, value) {
  const old = this.cellStatus[idx];
  if (old === value) return true;
  if (old !== 0) return false;
  this.trail.push(idx | (old << 24));
  this.cellStatus[idx] = value;
  return true;
}
```

No adjacency cascade — Mosaic has no adjacency rule.

### `_applyClues` propagation

For each clue index `i`:

1. Get the neighborhood `cells = clueNeighborhood[i]`.
2. Walk: count `nB` (cellStatus === 1), `nW` (cellStatus === 2),
   `nU` (cellStatus === 0).
3. If `nB > K` → contradiction.
4. If `nB + nU < K` → contradiction.
5. If `nB === K && nU > 0`: force all unknowns in neighborhood to
   cellStatus = 2 (white) via `_set`.
6. If `nB + nU === K && nU > 0`: force all unknowns to cellStatus = 1
   (black) via `_set`.

Return true on success, false on contradiction.

### `_propagate`

```js
_propagate() {
  let changed = true;
  while (changed) {
    if (this._timeUp()) return true;
    changed = false;
    const mark = this.trail.length;
    if (!this._applyClues()) return false;
    if (this.trail.length > mark) changed = true;
  }
  if (this._depth === 0 && !this._inLookahead) {
    if (!this._applyLookahead()) return false;
  }
  return true;
}
```

### Lookahead + backtracking + caches

Standard pattern — see Hitori for the exact shape. Most-constrained
variable pick: prefer cells whose participating clues have the
smallest remaining slack. Branch [1, 2].

### Cache

`_cacheKey`: FNV-1a of `(rows, cols, task[])`. 50-entry solution LRU +
20-entry partial LRU.

### `_emit`

Returns `cellStatus` 2D as-is. **No clue-cell special-case** — Mosaic
clue cells participate in cellStatus normally.

### Stepwise `getHint`

Per clue (iteration order), apply the count rule; stop at first clue
that yields a forced write. If no clue fires, run single lookahead probe.
Returns `[{row, col, value}, ...]` or null.

## 4. MAIN-world functions

```js
function readMosaicData() {
  // Returns { rows, cols, task: 2D copy of G.task }.
}

function readMosaicState(rows, cols) {
  // 2D copy of G.currentState.cellStatus.
}

function applyMosaicState(grid) {
  // saveState(true) → cellStatus = grid (every cell, including clue cells —
  // no skip) → render ladder.
}
```

`dumpPuzzleForBench` gets a mosaic branch — emits
`{type: 'mosaic', rows, cols, task}` inline.

Hint apply reuses generic `applyHintCells`.

## 5. Handler — `handler.js`

Standard shape; matches `/mosaic/`; priority 30.

## 6. Worker — `solver.worker.js`

```js
} else if (type === 'mosaic' && extraData) {
  const s = new MosaicSolver({
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

Same shape as Kurodoko / Hitori / Kakurasu, with one rendering
nuance: **a clue cell can also be black or white** in the solution.
The drawPreview arm must render the clue digit AND the shading
together. When the cell is black (cellStatus=1), digit text is light
(`#f3f4f6`) on the dark fill; when white-mark or unknown, digit text
is dark (`#1f2937`).

- `SUPPORTED_PUZZLES` — insert alphabetically (between Mosaic comes
  between Kurodoko and Nonogram; final order: ... Kurodoko, Mosaic,
  Nonogram, Shikaku, Slitherlink, Yin-Yang).
- `SOLUTION_KEY_PREFIXES` — `'mosaic-solution:'`.
- `solveExtraData` — mosaic arm `{rows, cols, task}`.
- `mosaicCacheKey(data)` — FNV-1a of (rows, cols, task[]).
- `gridDataSig` / `staticSig` — `|mc=` segment with task hash.
- `drawPreview` — new mosaic arm:
  - Static layer (`|mc=`-keyed): outer border + light grid lines.
  - Dynamic layer per cell:
    - If `task[r][c] !== -1`: render the clue digit. Text color depends
      on `cellStatus[r][c]`: light text on dark fill (`cellStatus=1`),
      dark text otherwise.
    - If `cellStatus === 1` (and no clue): solid dark inset.
    - If `cellStatus === 2`: small X mark.
    - If `cellStatus === 0` (and no clue): empty.
  - Hint overlay: blue ring on forced cells.
  - Mistake rings via `computePuzzleDiff('mosaic', ...)` — extend the
    generic cell-state arm to include `mosaic`.
- `getHint` dispatch — mosaic arm constructs `MosaicSolver`, calls
  `getHint`, packs as `{type:'mosaic', extraCells, count}`.
- `setHintStatus` — mosaic arm calling `mosaicHintStatusNodes(h)` (clone
  of kurodoko's; label text "shaded" / "unshaded").
- `solveHandler` partial arm — mosaic branch for 2D-grid partials.
- `pendingAutoSolve` gate — extend `skipAutoSolveGate` to include mosaic.
- Loop early-break — add mosaic to the type list.
- `drawNonogramGuidesOn` rect-bail — add mosaic.

## 8. Background.js + globals.d.ts + eslint.config.js

Three entries each:
- `readMosaicData`, `readMosaicState`, `applyMosaicState` in
  `EXEC_MAIN_ALLOWLIST` and `MainWorldFn`.
- `MosaicSolver` in `globals.d.ts` and `eslint.config.js` solverClasses.

## 9. Tests

- `tests/fixtures/puzzles.js` — `mosaic5x5Easy` from the recon.
- `tests/golden.js` — solved snapshot.
- `tests/fixtures/real-puzzles.js` — `mosaic5x5EasyReal`.
- `tests/mosaic.test.js` — solver unit tests:
  - Constructor builds clueNeighborhood correctly for corner/edge/interior.
  - `_applyClues`: K=0 forces neighborhood to white.
  - `_applyClues`: K=neighborhood-size forces all to black.
  - `_applyClues`: contradiction when impossible.
  - `solve()` on the recon.
  - Stepwise `getHint` returns small batches.
  - Cache deep-copy.
- `tests/mosaic-fuzz.test.js` — random shading → derive clues by
  walking 3×3 neighborhoods → verify solver recovers solution
  satisfying every clue.
- `tests/bench-mosaic.js`, `tests/bench-real.js` arm, nightly workflow step.

## 10. Out of scope

- Per-clue propagation order optimization (priority queue by slack).
  Standard iteration-to-fixpoint is fast enough at this puzzle size.
- Multi-solution detection.

End of design.
