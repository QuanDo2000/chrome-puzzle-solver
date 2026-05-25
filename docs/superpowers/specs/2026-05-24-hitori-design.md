# Hitori puzzle support — design

Date: 2026-05-24
Status: approved (pending spec review)

Adds `/hitori/*` to the existing puzzle solvers. Structurally identical to
Heyawake's solver shape — same cellStatus encoding, same no-adjacent-blacks
rule, same white-connectivity rule — with Rule 1 swapped: row/column
uniqueness on the digit clues among unshaded cells, plus the static
sandwich/triplet pre-deduction.

## 1. Page recon

Captures from `/hitori/random/5x5-easy` on 2026-05-24:

- `G.slug === 'hitori'`. URL `/hitori/`. `G.jigsaw === false`.
- `G.puzzleWidth`, `G.puzzleHeight` — dims.
- `G.task` — 2D `int[H][W]` of clue values. Digits `1..9` are themselves; letters `a..z` are encoded as `charCode - 87` (so `10..35`) per the page's `parseTask`. No -1 sentinel in this puzzle's `task` (every cell is clued).
- `G.currentState.cellStatus` — 2D `int[H][W]`. Encoding **identical to Heyawake**: `0 = empty, 1 = black/shaded, 2 = white/unshaded`. Verified against the dump's `solved: true` state.
- `G.currentState.cellColor` — all zeros, unused.
- `G.setCellState(cell, e)` — `cellStatus[row][col] = e when e !== -1`. Same as Heyawake.
- `G.dr / G.dc` — `[-1, 0, 1, 0] / [0, 1, 0, -1]`.
- `G.blacks: -1` — sentinel; not used by the solver.

## 2. Rules

1. **Uniqueness**: in each row and each column, no digit appears more than once among unshaded cells.
2. **No adjacent blacks**: no two black/shaded cells share an edge (orthogonal 4-neighbour). Identical to Heyawake.
3. **White connectivity**: all unshaded cells form one orthogonally-connected component. Identical to Heyawake.

## 3. Solver — `HitoriSolver` in `solver.js`

### Inputs

```js
new HitoriSolver({
  rows, cols,
  task: 2D int[H][W],          // clue per cell (1..35)
  initialState?: 2D int (0/1/2),
  maxMs?: number,
})
```

### Internal state

- `cellStatus: Uint8Array(rows*cols)` — flat, 0/1/2.
- `task: Int32Array(rows*cols)` — flat, clue per cell.
- `trail: number[]` — `idx | (oldValue << 24)` entries, like Heyawake's.
- `_depth`, `_inLookahead`, `_startedAt`, `maxMs` — same conventions.

### Precomputed structures

At construction time:

- **`staticForcedWhites: Int32Array`** — list of cell indices forced white by the sandwich/triplet rule. Built by scanning each row at positions `1..cols-2` (and each column at `1..rows-2`): if the two flanking cells have the same `task` value, the middle cell is forced white. Both `X-Y-X` (sandwich) and `X-X-X` (triplet) collapse to this single predicate. Stored row-major then column-major.

- **`rowBuckets[r]: Map<value, Int32Array>`** and **`colBuckets[c]: Map<value, Int32Array>`** — for each (row, value) and (col, value), the list of cell indices with that value. Used by the uniqueness propagation rule.

### Propagation rules (cheapest first)

**Rule 1: Static sandwich/triplet** (`_applyStaticForcedWhites`)
For each idx in `staticForcedWhites`: if `cellStatus[idx] === 0`, set to 2.
If any returns false (only possible if user has already drawn black there — which is a contradiction with the puzzle's forced structure), return false.

This rule only fires once-ish per solve — the writes are stable, the rule
becomes a no-op after the first pass. But it must be in the fixpoint loop
so it interleaves with rules that may force adjacent blacks (which would
then make the static-white write conflict — also a contradiction).

**Rule 2: Uniqueness** (`_applyUniqueness`)
For each `rowBuckets[r][value]`:
- Count whites (`cellStatus === 2`) and unknowns.
- If whites > 1 → contradiction.
- If whites === 1 and unknowns > 0 → force each unknown black via `_set(idx, 1)`.
Same for `colBuckets[c][value]`.

(Eager adjacency rule fires from each black write via `_set`; that's the
"pair-isolates-region" deduction asked for in the design questionnaire.)

**Rule 3: No adjacent blacks** (eager in `_set`)
Identical to Heyawake's implementation: black writes force 4-neighbours
to white; contradiction if any neighbour is already black.

**Rule 4: White connectivity** (`_applyConnectivity`)
Two-tier BFS-then-iterative-Tarjan articulation. **Code-clone of
`HeyawakeSolver._applyConnectivity`** verbatim — the rule is identical
(white = cellStatus 2, black = 1) so the implementation transfers without
modification. Skipped inside lookahead via `_inLookahead` guard.

### Lookahead

`_applyLookahead` — at `_depth === 0 && !_inLookahead`, probe each unknown
cell with each value, force the survivor if exactly one passes. Identical
shape to Heyawake's.

### Backtracking

Most-constrained-variable pick. Score each unknown by:
- `uniquenessTightness`: max over the cell's (row-bucket, col-bucket) of
  `1 / (unknowns_in_bucket + 1)` — tighter buckets weighted higher.
- `adjacencyTension`: count of 4-neighbours already determined.

Score = `uniquenessTightness * 4 + adjacencyTension`. Pick highest.
Branch `[1, 2]` (black first — propagates harder via adjacency cascade).

### Stepwise `getHint`

Same shape as `HeyawakeSolver.getHint` (just shipped):

1. Apply `staticForcedWhites` — emit cells changed (first call usually
   emits a batch from this).
2. Per `(row, value)` bucket, then per `(col, value)`, apply uniqueness;
   stop at the first bucket that yields a write.
3. Run `_applyConnectivity`; emit any forced whites.
4. Single lookahead probe; emit forced cell.

Returns `[{row, col, value}, ...]` (positive cells only) or `null`.

### `solve()` and caches

```js
solve() {
  const key = this._cacheKey();
  const cached = HitoriSolver._solutionCache.get(key)
              || HitoriSolver._partialCache.get(key);
  if (cached) return this._cloneResult(cached);
  this._startedAt = Date.now();
  // ... propagate → complete? → backtrack → emit
  // Cache stores solved or partial results; deep-copy on store+read.
}
```

`_cacheKey`: FNV-1a of `(rows, cols, task[])`. 50-entry solution LRU +
20-entry partial LRU. `_cloneResult` deep-copies the 2D grid.

### `_isComplete` / `_emit`

Identical to Heyawake's: complete when no cell is 0; emit converts the
flat `Uint8Array` to a 2D `number[][]`.

## 4. MAIN-world functions — `main-world.js`

Three new functions:

```js
function readHitoriData() {
  // Returns { rows, cols, task: 2D copy of G.task }.
  // Defensive: clamps row length to cols; returns null on missing fields.
}

function readHitoriState(rows, cols) {
  // 2D copy of G.currentState.cellStatus. Defensive: pads short rows
  // with zeros (mirrors readHeyawakeState's shape).
}

function applyHitoriState(grid) {
  // saveState(true) → write cellStatus → render ladder (drawCurrentState →
  // render → redraw). Same contract as the other cell-state apply fns.
}
```

`dumpPuzzleForBench` gets a hitori branch (matches `/hitori/` path or
`g.slug === 'hitori'`): emits `{type: 'hitori', rows, cols, task}` inline,
mirroring the heyawake dump fix (no outer-scope helper calls).

Hint apply reuses the generic `applyHintCells` — encoding matches.

## 5. Handler — `handler.js`

```js
registerHandler({
  type: 'hitori',
  priority: 30,
  matches: () => isPuzzlesMobilePage() && location.pathname.includes('/hitori/'),
  detect: async () => {
    const data = await callMainWorld('readHitoriData', []);
    if (!data) return { found: false, error: 'No Hitori task data found' };
    return { found: true, type: 'hitori', rows: data.rows, cols: data.cols,
             task: data.task, rowClues: [], colClues: [], _cells: [] };
  },
  readState: ctx => callMainWorld('readHitoriState', [ctx.rows, ctx.cols]),
  applySolution: grid => callMainWorld('applyHitoriState', [grid]),
});
```

## 6. Worker — `solver.worker.js`

```js
} else if (type === 'hitori' && extraData) {
  const s = new HitoriSolver({
    rows: extraData.rows,
    cols: extraData.cols,
    task: extraData.task,
    initialState: initialGrid || null,
    maxMs: 30000,
  });
  result = s.solve();
}
```

Add `HitoriSolver` to the `/* global */` directive and the SW catch block
shape (grid: null is already the right shape for unsat).

## 7. Content.js touchpoints

- `SUPPORTED_PUZZLES` — add `{name:'Hitori', url:'.../hitori/'}` between Heyawake and Nonogram (alphabetical).
- `SOLUTION_KEY_PREFIXES` — add `'hitori-solution:'`.
- `solveExtraData` — hitori arm returns `{rows, cols, task}`.
- `getCachedGridSolution / cacheGridSolution` — `hitoriCacheKey(data)` builds FNV-1a from `(rows, cols, task)`; standard 2D grid cache shape works downstream.
- `gridDataSig` / `staticSig` — append `|hi=` segment with task-grid hash.
- `drawPreview` — new hitori arm:
  - Static layer (`|hi=`-keyed): outer border only (no internal regions). No clue numbers on the static layer (clues are dynamic, see below).
  - Dynamic layer: for each cell:
    - If `cellStatus === 1` (shaded): fill cell with dark color, draw the digit in light color.
    - Else (white or unknown): light/no fill, draw the digit in dark color.
  - Hint overlay: ring forced cells (blue) with same per-value styling as Heyawake (dark fill + ring for value=1, white fill + ring for value=2).
  - Mistake overlay: red ring via `computePuzzleDiff('hitori', board, solution)` — the cell-state generic arm covers it.
- `getHint` dispatch — new hitori arm:
  ```js
  } else if (detectedGrid.type === 'hitori') {
    const solver = new HitoriSolver({ rows, cols, task: detectedGrid.task });
    const hintCells = solver.getHint(grid);
    if (!hintCells || !hintCells.length) {
      return { success: false, error: 'No more cells can be deduced ...' };
    }
    hint = { type: 'hitori', extraCells: hintCells, count: hintCells.length };
  }
  ```
- `setHintStatus` — add hitori arm calling new `hitoriHintStatusNodes(h)` (clone of `heyawakeHintStatusNodes`; cellStatus encoding identical).
- `solveHandler` partial arm — add a third condition:
  ```js
  if (result?.partial && puzzleData?.type === 'hitori' && Array.isArray(result.grid)) {
    applyGridPartialResult(result);
    return;
  }
  ```
  (`applyGridPartialResult` already exists from the heyawake work.)
- `pendingAutoSolve` gate — extend `skipAutoSolveGate` to include hitori.
- `runLoop` done-check — generic "every cell !== 0" path already covers hitori.

## 8. Background.js + globals.d.ts

Add three entries to `EXEC_MAIN_ALLOWLIST` and three to `MainWorldFn`:
`readHitoriData`, `readHitoriState`, `applyHitoriState`.

`HitoriSolver` added to `globals.d.ts` (alongside `HeyawakeSolver`).

ESLint globals — `HitoriSolver` added to the `solverClasses` block in `eslint.config.js`.

## 9. Tests

- **`tests/fixtures/puzzles.js`** — `hitori5x5Easy` with the recon's task.
- **`tests/golden.js`** — `hitori5x5Easy` snapshot.
- **`tests/fixtures/real-puzzles.js`** — `hitori5x5EasyReal` (same task; expected solution from the recon's solved cellStatus).
- **`tests/hitori.test.js`** — solver unit tests:
  - Constructor mirrors `task`/`cellStatus`.
  - `_set` adjacency cascade (already covered by encoding match; verify once).
  - Sandwich rule fires on `X-Y-X` row.
  - Triplet rule fires on `X-X-X` column.
  - Uniqueness: two whites with same value in row → contradiction.
  - Uniqueness: one white + one unknown with same value → unknown forced black.
  - Connectivity: blacks splitting whites → contradiction.
  - `solve()` finds the recon's solution.
  - Stepwise `getHint`: returns ≤ small-batch per call.
  - Cache deep-copy.
- **`tests/hitori-fuzz.test.js`** — random Hitori puzzles, validate 3 rules on each solved result.
- **`tests/bench-hitori.js`** — bench on the 5×5 real fixture.
- **`tests/solver.test.js`** — integration test (fixture → golden).
- **`tests/bench-real.js`** — hitori arm.
- **`.github/workflows/bench-nightly.yml`** — Bench Hitori step.

## 10. Performance envelope

| Board | Wall-time target |
| --- | --- |
| 5×5 easy real | < 5 ms |
| 10×10 medium | < 100 ms |
| 15×15 hard | < 1 s |
| 25×25 (if site goes that big) | partial on timeout, 30 s budget |

## 11. Out of scope

- CDCL — same reasoning as Heyawake; binary-cell domain with strong local rules is well-served by propagate + lookahead + backtracking.
- Letter-clue UX beyond render fidelity (clues `a-z` simply render as the literal character; the solver treats them as numeric values 10-35 just like the page does).
- Per-rule hint naming — keep flat `extraCells` shape; no rule-attribution UI.

## 12. Migration / rollout

Single chain of commits on top of `main`. No data migration, no backwards-
compat — new puzzle type, no shared state with existing ones (except the
already-extracted helpers like `applyGridPartialResult`).

End of design.
