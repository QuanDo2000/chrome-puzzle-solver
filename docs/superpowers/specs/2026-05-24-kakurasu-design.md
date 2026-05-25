# Kakurasu puzzle support — design

Date: 2026-05-24
Status: approved (pending spec review)

Adds `/kakurasu/*` to the existing puzzle solvers. Different rule family
from the prior 10 puzzles: subset-sum-per-line constraints with edge
clues. Cell domain is just filled/empty/cross, but the propagation engine
is per-line mask narrowing — closer to Nonogram than to Heyawake/Hitori.

## 1. Page recon

From `/kakurasu/random/4x4-easy`:

- `G.slug === 'kakurasu'`. URL `/kakurasu/`.
- `G.puzzleWidth`, `G.puzzleHeight` — dimensions (e.g. 4×4).
- `G.task` — `{ vertical: number[], horizontal: number[] }`:
  - `vertical[c]` — target sum for column `c` (the bottom-edge clue).
  - `horizontal[r]` — target sum for row `r` (the right-edge clue).
- `G.currentState.cellStatus` — 2D `int[H][W]`. Page accepts any int (no
  `-1` guard in `setCellState`). Encoding likely `0 = empty/unknown,
  1 = filled, 2 = cross/X-mark`; matches the broader cell-state family.
- `G.horizontalCounters / verticalCounters` — page-internal running sums.
  Not used by the solver.
- `G.blacks: -1` — sentinel; unused.

## 2. Rules

For each row `r`:
- Σ over filled cells `(c+1)` (1-indexed column weight) == `rowClues[r]`.

For each column `c`:
- Σ over filled cells `(r+1)` (1-indexed row weight) == `colClues[c]`.

That's the whole rule set. No adjacency, no connectivity. Each row and
each column is an independent subset-sum constraint.

Verified the recon's puzzle has a unique solution by hand:
```
. X . .   row 0 sum = 2  (col 1: weight 2)
. . X X   row 1 sum = 7  (cols 2+3: 3+4)
. X X X   row 2 sum = 9  (cols 1+2+3: 2+3+4)
X X X .   row 3 sum = 6  (cols 0+1+2: 1+2+3)
```
Col sums: 0=4, 1=8, 2=9, 3=5 — matches `vertical: [4,8,9,5]`. ✓

## 3. Solver — `KakurasuSolver` in `solver.js`

### Inputs

```js
new KakurasuSolver({
  rows, cols,
  rowClues: number[],          // page's task.horizontal
  colClues: number[],          // page's task.vertical
  initialState?: 2D int (0/1/2),
  maxMs?: number,
})
```

### Internal state

- `cellStatus: Uint8Array(rows*cols)` — flat, `0=unknown, 1=filled, 2=cross/empty`.
- `rowClues: Int32Array(rows)`, `colClues: Int32Array(cols)`.
- `rowMasks: Array(rows)` — per row, an array of bitmasks (each bitmask
  over `{0..cols-1}`); the bitmask `m` is valid iff
  `Σ_c (c+1) where bit c of m is set === rowClues[r]`. Built once at
  construction by subset-sum DP (`2^cols ≤ 4096` for any sane board).
- `colMasks: Array(cols)` — per column, bitmasks over `{0..rows-1}`,
  filtered analogously.
- `rowMasksActive: Array(rows)` of `Set<int>` (or `Int32Array`) — the
  current per-row domain (subset of `rowMasks[r]`) as propagation
  narrows. Same for `colMasksActive`.
- `trail: number[]` — Same `idx | (oldValue << 24)` encoding as Heyawake.
  Plus a tag-bit for mask-list edits so `_rollback` can restore them.
  See trail format below.

### Trail format

Two kinds of trail entries (distinguishable by top-bits since cell
indices fit in 24 bits for any sane board):

- **Cell write**: `idx | (oldValue << 24)`. Top bits 24-25 are `oldValue`
  (0/1/2 fits in 2 bits).
- **Mask drop**: `(maskValue << 24) | (lineIndex & 0xff) | TAG`. We use
  the high bit (`0x80000000`) to distinguish a mask-drop trail entry
  from a cell write.

Wait — simpler: keep two parallel trails (`cellTrail`, `maskTrail`) and
roll back both. Simpler to read than a tagged single trail.

Final shape:
- `cellTrail: number[]` — `(idx) | (oldValue << 24)` per cell write.
- `maskTrail: {axis: 0|1, lineIdx: int, mask: int}[]` — `axis=0` means
  row, `axis=1` means col. On rollback, push the dropped mask back into
  the active set for that line.

`_rollback(cellMark, maskMark)` rewinds both.

### Propagation

**Rule: line forcing.** For each row `r`:

1. Filter `rowMasksActive[r]` to drop any mask `m` that disagrees with
   currently known cells in row `r`:
   - If `cellStatus[r*cols+c] === 1` (filled) and bit `c` of `m` is 0,
     drop `m`.
   - If `cellStatus[r*cols+c] === 2` (cross) and bit `c` of `m` is 1,
     drop `m`.
2. If `rowMasksActive[r]` is empty → contradiction.
3. Compute `intersection = m1 & m2 & ... & mk` over remaining masks.
   For each bit `c` set in `intersection`, force cell `(r,c)` to filled.
4. Compute `union = m1 | m2 | ... | mk`. For each bit `c` UNSET in
   `union`, force cell `(r,c)` to cross.

Same for each column `c` (using bit-c over rows).

Cell writes from row processing trigger column re-filter, and vice
versa. Iterate to fixpoint.

**Lookahead** at `_depth === 0 && !_inLookahead` — probe each unknown
cell with each value (1, 2); force survivor if exactly one passes.

**Backtracking** — most-constrained: pick the unknown cell whose row OR
column has the fewest active masks (tightest line). Branch `[1, 2]`.

### `solve()`

```js
solve() {
  const key = this._cacheKey();
  const cached = KakurasuSolver._solutionCache.get(key)
              || KakurasuSolver._partialCache.get(key);
  if (cached) return this._cloneResult(cached);
  this._startedAt = Date.now();
  let result;
  if (!this._propagate()) {
    this._rollback(0, 0);
    result = { solved: false, grid: null };
  } else if (this._isComplete()) {
    result = { solved: true, grid: this._emit() };
  } else if (this._backtrack()) {
    result = { solved: true, grid: this._emit() };
  } else {
    const partial = this._emit();
    result = this._timeUp()
      ? { solved: false, grid: partial, error: 'timed out', partial: true }
      : { solved: false, grid: null };
  }
  if (result.solved || result.partial) this._storeInCache(key, result);
  return result;
}
```

### Stepwise `getHint`

- Per-row: filter masks; if intersection or union-complement yields new
  forced cells, return them.
- Per-col: same.
- Then connectivity-style fallback isn't needed (Kakurasu has no
  connectivity), so go straight to single lookahead probe.

Returns `[{row, col, value}, ...]` (value is 1 or 2) or null.

### Cache

`_cacheKey`: FNV-1a of `(rows, cols, rowClues[], colClues[])`. Static
caches: 50-entry solution LRU, 20-entry partial LRU. `_cloneResult`
deep-copies the 2D grid. Same shape as Hitori's.

### Performance

| Board | Approx wall-time |
| --- | --- |
| 4×4 easy | < 1 ms (per-line domains ≤ 16 each; propagation hits fixpoint in 1-2 passes) |
| 8×8 | < 10 ms |
| 10×10 | < 100 ms (per-line domains up to 1024; pruning is aggressive) |

If site ships larger boards, partial-on-timeout at the worker's 30 s budget keeps the UX responsive.

## 4. MAIN-world functions — `main-world.js`

```js
function readKakurasuData() {
  // Returns { rows, cols, rowClues: G.task.horizontal[], colClues: G.task.vertical[] }.
  // Defensive: returns null on missing fields.
}

function readKakurasuState(rows, cols) {
  // 2D copy of G.currentState.cellStatus.
}

function applyKakurasuState(grid) {
  // saveState(true) → cellStatus = grid (preserving 0/1/2) → render ladder.
}
```

`dumpPuzzleForBench` gets a kakurasu branch — emits
`{type: 'kakurasu', rows, cols, rowClues, colClues}` inline (no
outer-function calls per the MAIN-world contract).

Hint apply uses generic `applyHintCells` — value=1 → cellStatus=1
(filled), value=2 → cellStatus=2 (cross). Encoding matches.

## 5. Handler — `handler.js`

```js
registerHandler({
  type: 'kakurasu',
  priority: 30,
  matches: () => isPuzzlesMobilePage() && location.pathname.includes('/kakurasu/'),
  detect: async () => {
    const data = await callMainWorld('readKakurasuData', []);
    if (!data) return { found: false, error: 'No Kakurasu task data' };
    return { found: true, type: 'kakurasu', rows: data.rows, cols: data.cols,
             rowClues: data.rowClues, colClues: data.colClues,
             _cells: [] };
  },
  readState: ctx => callMainWorld('readKakurasuState', [ctx.rows, ctx.cols]),
  applySolution: grid => callMainWorld('applyKakurasuState', [grid]),
});
```

## 6. Worker — `solver.worker.js`

```js
} else if (type === 'kakurasu' && extraData) {
  const s = new KakurasuSolver({
    rows: extraData.rows,
    cols: extraData.cols,
    rowClues: extraData.rowClues,
    colClues: extraData.colClues,
    initialState: initialGrid || null,
    maxMs: 30000,
  });
  result = s.solve();
}
```

`KakurasuSolver` added to the `/* global */` directive and `eslint`
solverClasses block.

## 7. Content.js touchpoints

- **`SUPPORTED_PUZZLES`** — add `{name:'Kakurasu', url:'.../kakurasu/'}` between Hitori and Nonogram (alphabetical).
- **`SOLUTION_KEY_PREFIXES`** — add `'kakurasu-solution:'`.
- **`solveExtraData`** — kakurasu arm: `{rows, cols, rowClues, colClues}`.
- **`kakurasuCacheKey(data)`** — FNV-1a over rows/cols/rowClues/colClues. Wire alongside hitoriCacheKey in the dispatch chain.
- **`gridDataSig` / `staticSig`** — append `|ka=` segment with rowClues+colClues hash.
- **`drawPreview`** — new kakurasu arm:
  - Canvas extent: `(rows + 1) × (cols + 1)` cell units. The N×N grid in the top-left; column N (right edge) holds row clues; row N (bottom edge) holds column clues; cell (N, N) blank.
  - Static layer (`|ka=`-keyed): outer border + row clues (rendered as digits in the right-edge column) + column clues (digits in the bottom-edge row). Rebuilt only when shape/clues change.
  - Dynamic layer: for each cell in the N×N grid:
    - `cellStatus === 1` (filled): solid dark square inset slightly.
    - `cellStatus === 2` (cross): small X drawn with two stroke lines centered in the cell.
    - `cellStatus === 0` (unknown): empty.
  - Hint overlay: ring forced cells in blue.
  - Mistake overlay: red rings via `computePuzzleDiff('kakurasu', board, solution)` — uses the generic cell-state arm; extend the existing `'heyawake' || 'hitori'` arm in `computePuzzleDiff` to include `'kakurasu'`.
- **`getHint` dispatch** — new kakurasu arm: construct solver from `detectedGrid.rowClues/colClues`, call `solver.getHint(grid)`, pack as `{type:'kakurasu', extraCells, count}`.
- **`setHintStatus`** — add kakurasu arm calling new `kakurasuHintStatusNodes(h)` (clone of hitori's — same `extraCells` shape, just different label text: "filled" / "cross").
- **`solveHandler` partial arm** — extend the heyawake/hitori 2D-grid branch to include kakurasu.
- **`pendingAutoSolve` gate** — extend `skipAutoSolveGate` to include kakurasu.
- **Loop early-break exclusion** — add `kakurasu` to the type list so empty `cells` doesn't break the loop.
- **`drawNonogramGuidesOn` rect-bail** — add kakurasu to skip the generic rect-grid renderer.

## 8. Background.js + globals.d.ts + eslint.config.js

Three entries in each:
- `readKakurasuData`, `readKakurasuState`, `applyKakurasuState` in `EXEC_MAIN_ALLOWLIST` and `MainWorldFn`.
- `KakurasuSolver` declared in `globals.d.ts` and listed in `eslint.config.js` solverClasses block.

## 9. Tests

- **`tests/fixtures/puzzles.js`** — `kakurasu4x4Easy` from the recon.
- **`tests/golden.js`** — `kakurasu4x4Easy` golden (4×4 with the hand-verified solution above).
- **`tests/fixtures/real-puzzles.js`** — `kakurasu4x4EasyReal`.
- **`tests/kakurasu.test.js`** — solver unit tests:
  - Constructor builds rowMasks/colMasks correctly for tiny boards.
  - Single-mask row → forced-fill cells.
  - Mask-narrowing under known cells.
  - Solve recon.
  - Stepwise getHint returns small batches.
  - Cache deep-copy.
- **`tests/kakurasu-fuzz.test.js`** — generate random valid solutions
  (random 0/1 grid → compute row+col clues), verify solver recovers a
  solution satisfying both row sums and col sums.
- **`tests/bench-kakurasu.js`** — bench on the real fixture.
- **`tests/solver.test.js`** — integration test.
- **`tests/bench-real.js`** — kakurasu arm.
- **`.github/workflows/bench-nightly.yml`** — Bench Kakurasu step.

## 10. Out of scope

- Multi-solution detection beyond what backtracking naturally enumerates.
  Kakurasu puzzles are typically designed with unique solutions; we
  return the first one we find.
- Cell-toggling behavior (cycling user clicks 0→1→2→0) — not the
  solver's concern.
- Render of clues with multi-digit values requires only enough font size
  scaling; the spec assumes single- or two-digit clues, which the
  drawPreview arm should handle without special-casing.

End of design.
