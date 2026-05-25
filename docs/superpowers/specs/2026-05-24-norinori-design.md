# Norinori puzzle support — design

Date: 2026-05-24
Status: approved (pending spec review)

Adds `/norinori/*` to the existing puzzle solvers. 14th puzzle type.
Same cell encoding as Heyawake-family (0/1/2). Region-partitioned (like
Heyawake) but with a totally different rule set: **per-region domino +
cross-region isolation**. The `_set` adjacency cascade becomes context-
sensitive — blacks can (and must) touch within a region, but cannot
touch across regions.

## 1. Page recon

From `/norinori/random/6x6-normal`:

- `G.slug === 'norinori'`. URL `/norinori/`. `puzzleWidth × puzzleHeight = 6 × 6`.
- `G.task` — empty `[]`. The puzzle data lives in `areas` / `areaPoints`.
- `G.areas` — 2D `int[H][W]`, region id per cell. 8 regions in this 6×6 fixture.
- `G.areaPoints[k]` — `{row, col}[]` cells in each region.
- **No `areaTask`** — every region has the same target (exactly 2 blacks).
- `G.currentState.cellStatus` — 2D ints, encoding `0=unknown, 1=black, 2=white-mark`. Same as Hitori/Mosaic.
- `setCellState` is the plain version. No clue-cell branch (every cell is a regular cell).

## 2. Rules

1. **Per region: exactly 2 black cells, and those 2 must be orthogonally adjacent (a domino).**
2. **No two black cells from different regions may be orthogonally adjacent** — each region's domino is isolated from every other.

No clues, no connectivity rule.

## 3. Solver — `NorinoriSolver` in `solver.js`

### Inputs

```js
new NorinoriSolver({
  rows, cols,
  rooms: [{cells: [{r, c}]}],          // no targets — every region needs exactly 2 blacks
  initialState?: 2D int (0/1/2),
  maxMs?,
})
```

### Internal state

- `cellStatus: Uint8Array(rows*cols)` — flat, 0/1/2.
- `roomCells: Int32Array[K]` — flat cell indices per region.
- `cellToRoom: Int32Array(rows*cols)` — region id per cell. Used by both `_set`'s cross-region cascade and per-region propagation.
- `dominoCandidates: Array<Int32Array>[K]` — for each region, all adjacent same-region cell pairs encoded as `[idx_a, idx_b]` (idx_a < idx_b). Precomputed at construction.
- Trail and meta — same shape as Heyawake (`idx | (oldValue << 24)`, `_depth`, `_inLookahead`, `maxMs`, `_startedAt`).

### `_set(idx, value)` with cross-region adjacency cascade

```js
_set(idx, value) {
  const old = this.cellStatus[idx];
  if (old === value) return true;
  if (old !== 0) return false;
  this.trail.push(idx | (old << 24));
  this.cellStatus[idx] = value;
  if (value === 1) {
    const r = (idx / this.cols) | 0;
    const c = idx - r * this.cols;
    const ownRoom = this.cellToRoom[idx];
    // Cross-region adjacency: black writes force CROSS-REGION 4-neighbours
    // to white. SAME-REGION neighbours are unconstrained (they may be the
    // domino partner).
    const ns = [];
    if (r > 0) ns.push(idx - this.cols);
    if (r < this.rows - 1) ns.push(idx + this.cols);
    if (c > 0) ns.push(idx - 1);
    if (c < this.cols - 1) ns.push(idx + 1);
    for (let i = 0; i < ns.length; i++) {
      const ni = ns[i];
      if (this.cellToRoom[ni] === ownRoom) continue;
      const nv = this.cellStatus[ni];
      if (nv === 1) return false; // cross-region black-on-black → contradiction
      if (nv === 0) {
        if (!this._set(ni, 2)) return false;
      }
    }
  }
  return true;
}
```

### Rule 1: `_applyDominoes` (per-region domino + count = 2)

For each region with cells `R`:

1. Count `nB` (cellStatus === 1 in R) and `nU` (cellStatus === 0 in R).
2. If `nB > 2` → contradiction.
3. If `nB === 2`:
   - Find the two black cells. They must be 4-adjacent → if not, contradiction.
   - All other cells in R (unknowns) → forced white.
4. If `nB === 1`:
   - Find the black cell. Its domino partner must be a same-region 4-neighbour that's not white.
   - Enumerate candidate partners (same-region 4-neighbours with cellStatus !== 2).
   - If 0 candidates → contradiction.
   - If 1 candidate → force it black.
   - All cells in R that aren't {known black, candidates} → forced white.
5. If `nB === 0`:
   - Filter `dominoCandidates[region]` to live candidates: pairs where neither cell is cellStatus === 2.
   - If 0 candidates → contradiction.
   - For each cell `c` in R:
     - If `c` is in *every* live candidate → must be black.
     - If `c` is in *no* live candidate → must be white.

### Rule 2: `_applyCrossRegionDominate` (region-pair cascade)

The user-requested "region-pair cascade reasoning upfront". For each
unknown cell `c` and each adjacent region `Y`:

- Let `adjacentCellsY` = cells of `Y` that are 4-neighbours of `c`.
- Filter `Y`'s live domino candidates: a candidate is "touches c" if
  either cell of the candidate is in `adjacentCellsY`.
- If *every* live candidate of `Y` touches `c` (and `Y` has at least one
  live candidate), then `c` must be white — any solution domino in `Y`
  ends up adjacent to `c`.

This catches inferences single-cell propagation misses: even without
any black yet placed in `Y`, if all of `Y`'s remaining domino positions
force a black adjacent to `c`, we can pre-emptively rule `c` out as
black.

### `_propagate`

```js
_propagate() {
  let changed = true;
  while (changed) {
    if (this._timeUp()) return true;
    changed = false;
    const mark = this.trail.length;
    if (!this._applyDominoes()) return false;
    if (!this._applyCrossRegionDominate()) return false;
    if (this.trail.length > mark) changed = true;
  }
  if (this._depth === 0 && !this._inLookahead) {
    if (!this._applyLookahead()) return false;
  }
  return true;
}
```

### Lookahead + backtracking + caches

Standard pattern. Most-constrained variable: prefer cells that
participate in the smallest live-candidate set across regions, since
they trigger the most cascades.

### `_emit`

Returns `cellStatus` 2D as-is. No clue-cell special-case — Norinori has
no clue cells.

### Stepwise `getHint`

Per region, run domino propagation; stop at first that yields a forced
write. Then per-cell cross-region dominate. Then single lookahead probe.

### Cache

`_cacheKey`: FNV-1a of `(rows, cols, cellToRoom[])`. 50-entry solution LRU
+ 20-entry partial LRU.

## 4. MAIN-world functions

```js
function readNorinoriData() {
  // { rows, cols, rooms: [{cells: [{r,c}]}] }
}

function readNorinoriState(rows, cols) { /* 2D cellStatus */ }

function applyNorinoriState(grid) {
  // saveState(true) → cellStatus = grid (every cell, no skip) → render ladder.
}
```

`dumpPuzzleForBench` gets a norinori branch — inline extraction.

Hint apply reuses generic `applyHintCells`.

## 5. Handler / Worker

Standard registration at `/norinori/`, priority 30. Worker arm with
`maxMs: 30000`. Mirrors Heyawake's shape.

## 6. Content.js touchpoints

Same shape as Heyawake / Hitori. The unique parts:

- **`drawPreview`** — clone Heyawake's region-border rendering exactly
  (same `areas` shape, same static-layer caching `|nn=` sig). Dynamic
  layer: `cellStatus === 1` → solid dark fill; `cellStatus === 2` → small
  X cross; `cellStatus === 0` → empty.

Insertion order: alphabetically `Norinori` between `Mosaic` and `Nonogram`.

## 7. Tests

- `tests/fixtures/puzzles.js` — `norinori6x6Normal` from the recon.
- `tests/golden.js` — solved snapshot.
- `tests/fixtures/real-puzzles.js` — `norinori6x6NormalReal`.
- `tests/norinori.test.js` — solver unit tests:
  - Constructor builds rooms + cellToRoom + dominoCandidates.
  - `_set` cross-region cascade.
  - `_applyDominoes` rule 1 (nB=2, nB=1, nB=0 each branch).
  - `_applyCrossRegionDominate` rule 2 (single candidate Y forces cell C white).
  - `solve()` on the recon.
  - Stepwise `getHint` returns small batches.
  - Cache deep-copy.
- `tests/norinori-fuzz.test.js` — random valid puzzles, verify solver recovers a solution satisfying both rules.
- `tests/bench-norinori.js`, `tests/bench-real.js` arm, nightly workflow step.

## 8. Out of scope

- More aggressive region-triple-cascade rules. Region-pair is the
  user-approved level; revisit if larger boards prove slow.
- Multi-solution detection.

End of design.
