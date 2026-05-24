# Hashi ("Bridges") puzzle support — design

**Date:** 2026-05-23
**Status:** Approved design, pre-implementation
**Puzzle URL:** `https://www.puzzles-mobile.com/hashi/random/7x7-easy`

## 1. Summary

Add support for the Hashi (Hashiwokakero / Bridges) puzzle on
puzzles-mobile.com. Full feature parity with the seven existing puzzle types:
Detect, Solve, Hint, Loop (iterative), Apply, live preview, Dump button,
solution cache, and auto-solve-on-detect with live mistake highlighting.

The puzzle is named **hashi** everywhere in code (`HashiSolver`,
`hashiHandler`, `type: 'hashi'`, `readHashiData` / `readHashiState` /
`applyHashiState`), matching the URL path. The page's internal `slug` is
`"bridges"` but that's not exposed in any user-facing surface.

## 2. The puzzle

A `W×H` grid of cells. Some cells contain **islands** (numbered circles).
Connect islands with **bridges** (straight horizontal or vertical lines)
such that:

1. The number on each island equals the total count of bridges connected to it.
2. Between any two islands there are 0, 1, or 2 bridges (no more).
3. Bridges run only horizontally or vertically and go between two islands
   with no other island in between.
4. Bridges cannot cross each other.
5. All islands form a single orthogonally-connected network.

## 3. Recon — page data model

`window.Game` is a jQuery object the site extended with the game logic.
Captured from the 7×7-easy page.

### Givens — `window.Game.task`

Flat array of island objects:

```
[
  { index: 0, number: "4", row: 0, col: 1 },
  { index: 1, number: "3", row: 0, col: 6 },
  ...
]
```

`number` is a **string** (`"1".."8"`); parse to int at the read boundary.
`index` is the canonical island id (used throughout state); positions in the
array match `index`.

### State — `window.Game.currentState.cellStatus`

Array indexed by island id, parallel to `task`. Each entry:

| Field | Meaning |
| --- | --- |
| `row`, `col` | Position (duplicated from task) |
| `right: {index, col, bridges}` | Bridge slot to the nearest right-neighbour island. `bridges ∈ {0,1,2}`. When no right neighbour, this is the sentinel `{index: 0, col: 0, bridges: 0}` — **detect via `br === -1`, never via `right.index === 0`** (island 0 is a real island id). |
| `bottom: {index, row, bridges}` | Same, downward |
| `bl` | Left side bridge count, or `-1` if no left neighbour. Equals partner's `right.bridges`. |
| `bt` | Top side, or `-1`. Equals partner's `bottom.bridges`. |
| `bb` | Bottom side, or `-1`. Equals own `bottom.bridges`. |
| `br` | Right side, or `-1`. Equals own `right.bridges`. |
| `total` | Sum of bridges currently connected (== `target` when island is satisfied). |

`cellHorizontalStatus` / `cellVerticalStatus` are not used by hashi (`undefined`).

### Confirmed by a second dump with bridges drawn

- Island 3 (target 1) → island 7: `bottom.bridges: 1`, `bb: 1`, partner `bt: 1`, `total: 1` ✓
- Island 6 (target 4) → island 7: `right.bridges: 2`, `br: 2`, partner `bl: 2`, `total: 2` ✓
- Island 7 (target 2): `bl: 2` (from 6) + `bt: 1` (from 3), `total: 3` (over-target, mid-play state, not solved) ✓

### Page methods touched by apply

`applyCurrentMoveToState`, `performMove`, `saveState`, `drawCurrentState`,
`drawIslandBridges` / `drawIslandBridgesBottom` / `drawIslandBridgesRight`,
`render`, `redraw`. Apply contract uses the standard save-then-render-ladder
already in `applyShikakuState`.

## 4. Solver — `HashiSolver` in `solver.js`

Modeled on `ShikakuSolver` (graph problem, not cell-state).

### Construction

From `{rows, cols, islands: [{index, row, col, number}]}` build:

- `islands[K]` — `{r, c, target}`, indexed by id.
- `byPos[r*W+c]` → island id.
- `edges[E]` — array of `{a, b, orientation, span}` where:
  - `a < b` are island ids
  - `orientation ∈ {'H','V'}`
  - `span` is the inclusive `[startCell, endCell]` interior the bridge crosses
  - Owner is the lower-index endpoint (matches page's "right from left,
    bottom from upper" convention).
- `incident[K][]` — edges adjacent to each island.
- `crosses[E][]` — list of edges this one physically crosses (precomputed
  once at construction; expensive at runtime otherwise).

### State

Trail-based undo (mirrors `NonogramSolver` / `GalaxiesSolver`):

- `lo[E]: Int8Array` — current minimum bridge count, `0` initially.
- `hi[E]: Int8Array` — current maximum bridge count, initially
  `min(2, target[a], target[b])` so a `1`-island edge starts capped at 1.
- `_assign(e, oldLo, oldHi)` push to trail; `_rollback(mark)` restores.

Solved when `lo[E] === hi[E]` for all edges and rules pass.

### Propagation (cheapest-first fixpoint)

1. **Crossing exclusion**: if `lo[e] ≥ 1`, set `hi[e'] := 0` for every
   `e' ∈ crosses[e]`. Contradiction if any `lo[e'] > 0`.
2. **Degree forcing per island**: for each island `i`, let
   `degMin = Σ_{e ∈ incident[i]} lo[e]`, `degMax = Σ hi[e]`. If
   `degMin > target[i]` or `degMax < target[i]` → contradiction. Per
   edge `e ∈ incident[i]`: `lo[e] := max(lo[e], target[i] - (degMax - hi[e]))`
   and `hi[e] := min(hi[e], target[i] - (degMin - lo[e]))`.
3. **Two-1s isolation**: an edge `(a, b)` where both `target[a] === 1`
   and `target[b] === 1` is forced to `hi := 0` (1 bridge would saturate
   both endpoints, creating an isolated 2-island component) — **unless**
   the puzzle has exactly those two islands (degenerate case).
4. **Connectivity cut**: union-find over edges with `lo ≥ 1`. For each
   undecided edge `e`, if forcing `hi[e] := 0` would render some island
   subset unreachable from the rest via remaining `hi ≥ 1` edges, then
   `lo[e] := 1`. (Cheap: only run when ≤1 component remains; full
   articulation-style analysis is overkill for typical hashi sizes.)
5. **1-step lookahead** at `_depth === 0`, guarded by `_inLookahead`: for
   each undecided edge, probe each value in `[lo[e], hi[e]]`, run a
   lookahead-free inner propagate, force the only survivor. Mirrors the
   pattern in `BinairoSolver` / `YinYangSolver`.

### Search

Most-constrained variable: pick the undecided edge whose tightest
endpoint has the largest `(target - degMin) / (degMax - degMin)` ratio
(largest pressure). Branch high → low (try 2, then 1, then 0).

### Completion check

After all edges decided:
1. Every island `Σ bridges == target`.
2. No two `bridges ≥ 1` edges cross (already enforced by propagation but
   re-verify cheaply).
3. Single connected component over edges with `bridges ≥ 1` (union-find).

### Hint / getHint

Mirrors Shikaku's three-tier:
1. Propagate from current board state; emit any newly-forced edge.
2. Forward-checking single-step (lookahead) if propagation alone deduced
   nothing.
3. Fallback: solve fully, return one (or N) edges from the gap to the
   solution. `minLines = max(1, ceil(numIslands / 10))` to scale Loop to
   ~10s wall on larger puzzles (per
   `[[hint-batch-scaling-for-loop]]` memory).

### Cache

`HashiSolver._solutionCache` — 50-entry LRU keyed on FNV-1a hash of
`(rows, cols, islands sorted by (row, col, number))`.
`HashiSolver.clearSolutionCache()` for test determinism.

### `maxMs` budget

Worker sets 10s. 7×7-easy expected <10ms; harder hashi (up to ~25×25 on
the site) should be well within budget.

## 5. Worker → content shape

The solution shape passed across `worker → content → MAIN` is:

```js
{
  type: 'hashi',
  solved: true,
  edges: [
    { a: 0, b: 1, orientation: 'H', bridges: 2 },
    { a: 0, b: 5, orientation: 'V', bridges: 2 },
    ...
  ]
}
```

Flat edge list (not parallel H/V arrays like Slitherlink) — simpler and
matches the graph nature. `a < b` always.

## 6. MAIN-world functions in `main-world.js`

### `readHashiData()`

Returns `{rows, cols, islands: [{index, row, col, number}]}`. `number`
parsed to int.

### `readHashiState()`

Returns the current edges, in the same shape as the solver output:

```js
{ edges: [{ a, b, orientation, bridges }] }
```

Built by walking `currentState.cellStatus`: for each island, emit its
`right` link (if `br !== -1`) and `bottom` link (if `bb !== -1`),
canonicalize so `a < b`.

### `applyHashiState(edges)`

For each `{a, b, orientation, bridges}`:
1. Let `owner = cellStatus[min(a,b)]`, `partner = cellStatus[max(a,b)]`.
2. If `orientation === 'H'`: set `owner.right.bridges = bridges`,
   `owner.br = bridges`, `partner.bl = bridges`.
3. If `orientation === 'V'`: set `owner.bottom.bridges = bridges`,
   `owner.bb = bridges`, `partner.bt = bridges`.

After all edge writes, recompute each island's `total` as the sum of its
four side mirrors with `-1` clamped to `0`:
`total = max(0, bl) + max(0, bt) + max(0, bb) + max(0, br)`.

Then standard ladder: `saveState(true)` BEFORE writes, fall through
`render → redraw → drawCurrentState → drawCellStatus` AFTER. Per the
CLAUDE.md MAIN-world write contract, never call `Game.check()`.

Field names are **load-bearing** — three page functions read them
(`drawCurrentStateInternal`, `drawCellStatus`, `checkFinished`) and any
mismatch silently breaks rendering or completion detection. Mirror the
Shikaku precedent: end-to-end verify in implementation by drawing a
known solution and confirming the page accepts it.

### `dumpPuzzleForBench` extension

Add a `hashi` branch at `main-world.js:912`: when `slug === 'bridges'`
or the path matches `/hashi/`, emit:

```js
{
  type: 'hashi',
  rows: Game.puzzleHeight,
  cols: Game.puzzleWidth,
  islands: Game.task.map(i => ({
    index: i.index, row: i.row, col: i.col, number: parseInt(i.number, 10)
  })),
}
```

## 7. Handler in `handler.js` — `hashiHandler`

Mirrors `shikakuHandler`. Registered after `slitherlinkHandler` and
before `puzzlesMobileHandler` (around line 460–640):

```js
const hashiHandler = {
  matches: () => location.pathname.startsWith('/hashi/'),
  detect: async () => {
    const data = await callMainWorld('readHashiData');
    return data ? { type: 'hashi', ...data } : null;
  },
  readState: () => callMainWorld('readHashiState'),
  applySolution: async (solution) => {
    const ok = await callMainWorld('applyHashiState', [solution.edges]);
    return ok ? { success: true } : { success: false, error: 'apply failed' };
  },
};
registerHandler(hashiHandler);
```

## 8. Content.js wiring

### `solver.worker.js`

Dispatch arm for `type === 'hashi'`: construct `HashiSolver(data)` with
`maxMs: 10_000`, call `solve()`, post `{type: 'hashi', solved, edges,
error?}`.

### `content.js`

- **`runSolve`**: pass `{type: 'hashi', rows, cols, islands}` through to
  worker as-is.
- **`solveHandler`**, **`applySolveResult`**, **`recordSolveSuccess`**:
  store result in `puzzleData.solution`. localStorage cache key prefix
  `hashi-solution:`. Serialize as JSON of the `edges` array.
- **`applyHintHandler`** + **`applyAndRunLoop`** hashi arms:
  1. Read current state via `hashiHandler.readState()`.
  2. Diff against `puzzleData.solution.edges` — find edges where current
     bridges differ from solution bridges.
  3. Take first `minLines` differences (where `minLines = max(1,
     ceil(numIslands / 10))`), apply them via `applyHashiState` with the
     merged edge list (existing edges with corrections applied).
  4. Loop done-check: every solution edge `e` has `current[e].bridges
     === e.bridges`.
- **`computePuzzleDiff('hashi', boardEdges, solutionEdges)`**: return
  `[{a, b, orientation, expected, actual}]` for edges where
  `actual !== 0 && actual !== expected`. UNKNOWN (board says 0) never
  flagged. Mistake overlay paints wrong bridges in red.
- **`drawPreview`** hashi arm:
  - `staticLayer`: numbered island circles (white fill, black border, bold
    number centered).
  - dynamic layer: bridges as 1 or 2 parallel line segments. Doubles
    offset by ~3 px each side of centerline.
  - `gridDataSig`: FNV-1a hash of the edges array (a, b, bridges
    concatenated).
  - `staticSig` gains `|h=` segment encoding islands list (rebuilds layer
    when puzzle changes).
- **`drawNonogramGuidesOn` guard** at `content.js:2239`: add `hashi` to
  the exclusion list (already excludes galaxies/aquarium/binairo/shikaku/
  yin-yang/slitherlink — hashi doesn't have nonogram side guides).
- **Loop done-check**: as above — every solution edge matches the board.
  Hashi never fills cells, so the empty-cell completion heuristic doesn't
  apply (same as Slitherlink).

## 9. MV3 hardening

Add to `EXEC_MAIN_ALLOWLIST` in `background.js` (currently 20 entries):

- `readHashiData`
- `readHashiState`
- `applyHashiState`

Mirror in the `MainWorldFn` union type in `globals.d.ts`. Note: existing
list grows from 20 → 23.

## 10. Tests

- `tests/hashi.test.js` — `node:test` suite:
  - Tiny hand-crafted fixtures: 2-island, 4-island, the captured 7×7.
  - Assert `solved: true` and bridges match expected (where puzzle has a
    unique solution).
  - Contradiction test: impossible givens (e.g. isolated `1`-`1` pair
    with a third island) → `solved: false`.
  - Connectivity-pruning test: a configuration where 2 bridges would
    satisfy degrees but isolate a component, force the alternative.
  - Crossing-exclusion test: two crossing candidate edges, one forced,
    other must be blocked.
- `tests/hashi-fuzz.test.js` — generate small random connected hashi
  puzzles (5×5 to 10×10), solve, verify all rules (degree, ≤2 bridges,
  no crossings, single component).
- `tests/fixtures/puzzles.js` — add a small hashi fixture with golden
  snapshot in `tests/golden.js`. Regenerate via `npm run capture`.
- `tests/fixtures/real-puzzles.js` — add `hashiReal7x7_a` from this
  dump.
- `tests/bench-hashi.js` — bench script following the existing pattern
  (2 warmup discarded, `process.exit(1)` on unsolved).
- `tests/solver.test.js` — integration arm asserting `HashiSolver` solves
  the 7×7-easy.
- `.github/workflows/bench-nightly.yml` — add `node tests/bench-hashi.js`
  to the nightly job (no `continue-on-error`).

## 11. CLAUDE.md update

Add a `### Hashi encoding` section after `### Slitherlink encoding`
documenting:
- Page model (`task` flat array of islands, `currentState.cellStatus`
  parallel array with `right`/`bottom`/`bl`/`bt`/`bb`/`br` fields).
- The sentinel detection rule (use `br === -1`, NOT `right.index === 0`).
- The apply contract (owner writes `right.bridges`/`br`, partner mirror
  on `bl`/`bt`, recompute `total`s, save+render ladder).
- Solver shape (edge variables with `lo`/`hi`, crossing/degree/
  isolation/connectivity rules, lookahead at `_depth === 0`).
- Solution shape (`edges: [{a, b, orientation, bridges}]`, `a < b`).
- localStorage cache prefix `hashi-solution:`.
- Loop done-check ("every solution edge matches", not empty-cell heuristic).

## 12. Build & verify

After every source-file edit run `npm run build` (per CLAUDE.md). Final
verify checklist:
- `npm test` clean
- `npm run lint`, `npm run typecheck` clean
- `node tests/bench-hashi.js` solves the 7×7 in <50ms wall
- Manual end-to-end on the live `/hashi/random/7x7-easy` page: Detect →
  Solve → Apply → page accepts (no rendering errors, `checkFinished`
  returns true)
- Manual end-to-end on a partial board: draw a few wrong bridges →
  preview rings them in red; Hint adds correct ones; Loop completes
- Manual end-to-end Dump: 📋 button copies a valid hashi snippet

## 13. Out of scope

- The page exposes hashi in multiple sizes (`5x5-easy` through to
  `25x25-extreme` presumably). This design covers all sizes via the
  same code path. No size-specific optimizations until a real bench
  shows them needed.
- No CDCL search for hashi. Hashi's constraint structure (degree + small
  domain + cheap connectivity) makes plain propagation + backtracking
  with lookahead solve any site puzzle in well under 1s. CDCL is
  warranted only if a real puzzle times out.
- The page's per-move `performMove(currentMove)` apply path is NOT
  used — bulk state rebuild (Shikaku precedent) is simpler and avoids
  needing to construct a `currentMove` per bridge.

## 14. Execution

Subagent-driven per `[[puzzle-addition-workflow]]`. After this spec is
approved, hand off to the `writing-plans` skill to produce a step-by-step
plan, then dispatch implementation tasks via
`subagent-driven-development`. Commit via `jj` (never `git`).
