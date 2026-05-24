# Project conventions for Claude Code

A Chrome MV3 extension that solves Nonogram, Aquarium, Galaxies, Binairo,
Binairo Plus, Shikaku, Yin-Yang, and Slitherlink puzzles on puzzles-mobile.com.
Seven solver classes in `solver.js`, a content-script widget in `content.js`,
and a small service worker in `background.js`.

## Version control: use `jj`, never plain `git`

Colocated Jujutsu + git workspace. Always use `jj` — never `git commit`, `git
add`, `git status`, `git log`, `git checkout`, etc.

Common commands: `jj status`, `jj log`, `jj diff`, `jj commit -m "msg"`, `jj
describe -m "msg"`, `jj new`, `jj edit <change-id>`, `jj restore --from
<change-id> <path>`, `jj file show -r <change-id> <path>`.

When dispatching subagents that commit, tell them explicitly to use `jj`.

## File responsibilities

| File | Role | Runs in |
| --- | --- | --- |
| `solver.js` | All solver classes — pure logic, no DOM | Content script + Web Worker + Node tests |
| `solver.worker.js` | Worker entry: imports solver.js + dispatches by puzzle type | Web Worker (inlined Blob — see Worker note) |
| `content.js` | Widget UI, message dispatch, `runSolve` (Worker proxy), `drawPreview` | Content script |
| `handler.js` | Per-puzzle-type handlers | Content script |
| `background.js` | `chrome.runtime.onMessage` listener + `importScripts('main-world.js')` | MV3 service worker |
| `main-world.js` | Functions serialized via `chrome.scripting.executeScript({world:'MAIN', func})` and run in the page context. Reference `window.Game`, `document`, `localStorage` — none exist in the SW. | Page MAIN world (per call) |

## Build output (`dist/`)

`dist/` is the minimized folder Chrome loads — only files referenced by
`manifest.json` plus `main-world.js`. Gitignored, rebuilt by `npm run build`.

**Run `npm run build` after editing**: `manifest.json`, `background.js`,
`main-world.js`, `content.js`, `handler.js`, `solver.js`, `solver.worker.js`,
or any `icons/` referenced by `manifest.json`. Tests/lint/docs/`package.json`
edits don't need a rebuild.

## Architectural notes (the non-obvious bits)

### MV3 Worker cross-origin gotcha
Content scripts share the page's origin, so `new
Worker(chrome.runtime.getURL('solver.worker.js'))` is blocked as cross-origin
**even when web-accessible**. `content.js` works around it by `fetch`-ing
`solver.js` and `solver.worker.js` as text, stripping the worker's
`importScripts(...)` line, and constructing the Worker from a same-origin
`Blob` URL. See `getSolverWorker()` in `content.js`.

### MAIN-world function dispatch
`callMainWorld(funcName, args)` in `handler.js` → SW does `globalThis[funcName]`
(declared in `main-world.js`, loaded via `importScripts`) → `chrome.scripting
.executeScript({func, args, world:'MAIN'})`. The function is **serialized as
source via `fn.toString()`**, so:
- No outer-scope helpers — nested helpers must live inside the function body.
- No references to other `main-world.js` functions — only MAIN-world globals
  (`window.Game`, `document`, etc.).

### MAIN-world write functions: save + render ladder
Any function mutating `window.Game.currentState` (`applyGameState`,
`applyGalaxiesState`, `applyHintCells`) must:
1. Call `window.Game.saveState(true)` **before** writes — without it, aquarium
   silently keeps prior visible state even though `cellStatus` updated.
2. Fall through `Game.render → Game.redraw → Game.redrawGrid →
   getSaved+loadGame` **after** writes. `Game.render` isn't universal; aquarium
   needs `redraw`/`redrawGrid`.

`applyGameState` is the reference shape. Never call `window.Game.check()` — the
site flags an instant solve as a DNF.

### Binairo encoding gotcha

Two integer encodings on `window.Game`:
- `task` — 2D **givens**: `-1=blank, 0=given-zero, 1=given-one`.
- `currentState.cellStatus` — 2D **state**: `0=empty, 1=filled-one (black),
  2=filled-zero (white)`.
- Translation givens → cellStatus: `-1→0, 0→2, 1→1`.

`BinairoSolver` works internally in cellStatus encoding and translates givens
at the constructor; everything downstream uses `0/1/2`. Don't reintroduce the
`-1/0/1` triad — it's input-only. `BinairoSolver.getHint(grid)` requires
cellStatus encoding; `binairoHandler.readState()` returns it directly.

Note: the page pre-allocates `comparisonClues` as one empty array per row even
on standard Binairo (so outer length always equals `puzzleHeight`); code
distinguishing "clues present" from "structure exists" must count markers
inside, not check outer length.

### Binairo Plus / comparison-clue support

`/binairo-plus/*` shares `binairoHandler` + `BinairoSolver` with one extra
rule. `puzzleData.type === 'binairo'` for both paths — discriminator is
`puzzleData.comparisonClues` (empty for standard, populated sparse 2D for plus).

Page exposes `window.Game.comparisonClues` as sparse 2D of flag integers.
Bits: `FLAG_RIGHT_EQ=1, FLAG_RIGHT_NE=2, FLAG_DOWN_EQ=4, FLAG_DOWN_NE=8`
(OR-able). E.g. `10 = 8|2` is "down ≠ AND right ≠". Preview renders NE as `×`.

`_decodeComparison` flattens to canonical `{aR, aC, bR, bC, sameSign}` array
in `this.compConstraints`. Out-of-grid borders silently dropped.
`_applyComparison(onChange)` runs in `propagate()` between balance and
uniqueness: both-sides-known + inconsistent → contradiction; one-side-known →
force other (with `_wouldCreateTriple` pre-check); neither known → skip.
Successful `propagate()` ⇒ no comparison violations, so no separate completion
check needed (unlike `_hasDuplicateLines`, which IS still needed because
uniqueness has a gap on lines with >2 empty cells).

Cache key (`binairoCacheKey` and `BinairoSolver._cacheKey`) mixes
comparison-clue bytes. Preview renders `=` / `×` glyphs at cell-boundary
midpoints in cached `staticLayer`; `staticSig` includes a `|cc=` segment.

### Shikaku encoding

`/shikaku/*` has dedicated `ShikakuSolver` + `shikakuHandler` (partitions
grid into rectangles — no overlap with cell-state puzzles).

`window.Game.task` is 2D ints: non-zero cells are clues (value = required
rectangle area), zero = non-clue. `currentState.cellStatus` is `rows×cols`:
`-1 = unassigned`, else owner clue index. `currentState.areas` is the
rectangle list indexed by owner id.

Each area MUST match the page's `currentMove` shape:
`{cells:[{row,col}], cellStatus:id, invert:false, startPoint:{row,col},
endPoint:{row,col}}`. Field names are load-bearing — three page functions
each crash on a mismatch: `drawCurrentStateInternal` reads
`startPoint/endPoint`, `removeArea` reads `cells[].row/col` (NOT
`cellList[].r/c`), `applyCurrentMoveToState` stores at
`areas[move.cellStatus]` (every area's `cellStatus` MUST equal its index).
Partial-hint clues with no cells left as `undefined` — page's
`void 0 !== areas[t]` guards skip those.

Solver: per-clue enumerate rectangle candidates (axis-aligned, correct area,
no other clue inside, fits grid); single-candidate forcing + most-constrained
backtracking. `getHint` runs propagation → forward-checking → solve-and-reveal.
Static `_solutionCache` keyed on FNV-1a of `(rows, cols, clues sorted)`,
50-entry LRU.

Worker→content→MAIN shape: 2D `number[][]` of owner indices (0..K-1) or `-1`.
`applyHintHandler`/`applyAndRunLoop` in `content.js` have shikaku-specific arms;
generic `applyHintCells` assumes cell-state encoding. Loop done-check uses
`-1` as unassigned (unlike other puzzles where `0` means unassigned).

Preview colors cells by owner index (`galaxiesColors`), thick borders between
distinct owners, clue numbers overlaid as bold text in cached `staticLayer`;
`staticSig` includes `|sk=`.

### Yin-Yang encoding

`/yin-yang/*` has dedicated `YinYangSolver` + `yinYangHandler`. Same cell
encoding as Binairo (givens `-1`=none, `0`=white, `1`=black; state
`0`=empty, `1`=black, `2`=white; translation `-1→0, 0→2, 1→1`). Internal
work in cellStatus encoding, mirroring Binairo.

Rules: every cell black or white; each colour orthogonally-connected; no 2×2
window monochrome OR diagonal checkerboard (checkerboard would make both
colours' diagonal pairs uncrossable).

Solver: `propagate()` iterates four local rules to fixpoint —
`_apply2x2` (no 2×2 mono / checkerboard), `_applyReachability` (BFS the
`{colour ∪ empty}` graph; empty cells unreachable from a colour's placed cells
forced to the other), `_applyCut` (articulation points whose removal severs a
colour's placed cells forced to that colour; iterative Tarjan), `_applyBorderArc`
(perimeter cycle has ≤2 colour transitions; ≥4 is contradiction, cell whose
wrong colour would create a 3rd arc forced). After local rules stall, at
top-level only (`_depth === 0`, with `_inLookahead` re-entry guard) runs
1-step lookahead (`_applyLookahead`). Then most-constrained backtracking.
On a complete grid a successful `propagate()` IS the validity proof.

`getHint` runs local rules only first (`_localHint`, fast); falls back to
`_lookaheadStepHint` (single lookahead deduction + the local cascade it
triggers — not the whole solvable remainder) so Hint never dead-ends while
the puzzle is still solvable. Static `_solutionCache` keyed on FNV-1a of
`(rows, cols, task)`, 50-entry LRU. Worker `maxMs=30s` (35×35 weekly solves
by deduction in ~5 s).

MAIN-world: `readYinYangData/readYinYangState/applyYinYangState`, twins of
Binairo. Hints reuse generic `applyHintCells` (cell-state encoding). Loop
done-check needs no special arm.

### Slitherlink encoding

`/loop/*` has dedicated `SlitherlinkSolver` + `slitherlinkHandler`. Named
"slitherlink" in code to avoid colliding with the Loop button; URL matcher
keys on `/loop/`.

Page encoding (edge-based, like Galaxies):
- `task` — 2D `int[H][W]`: `-1`=no clue, `0/1/2/3`=clue.
- `cellHorizontalStatus` — `(H+1) × W`: `0`=empty, `1`=line, **`2`=× ("not
  loop edge")**.
- `cellVerticalStatus` — `H × (W+1)`, same encoding.

Internal edges: `0=UNKNOWN, 1=LINE, 2=EMPTY` (direct passthrough to page
encoding). **× supported end-to-end** — read extracts page `2`s as EMPTY,
`_emit` outputs `2`s, apply writes `2`s back, `drawPreview`'s slitherlink arm
renders ×s in muted gray on the LINE layer. Don't reintroduce "ignore page
`2`" — the solver gets meaningful signal from user-drawn ×s, and deduced ×s
shrink the manual residue on hard boards.

Trail-based undo uses a 2-bit kind field per entry: `(kind << 24) | idx` for
edges (`kind` 0=H, 1=V), or `(oldColor << 26) | (2 << 24) | idx` for cell
color writes. `_rollback` dispatches on `(e >> 24) & 3`. Edge writes don't
trail old value (`_setEdge` rejects overwrite of non-UNKNOWN); color writes
do (need to know which slot to restore).

Propagation fixpoint (cheapest first):

1. `_propagateClues` — `m > k` or `m + n < k` → contradiction; `m == k` →
   remaining UNKNOWN → EMPTY; `m + n == k` → remaining UNKNOWN → LINE.
2. `_propagateVertices` — every dot's loop-degree ∈ {0, 2}; per-dot
   `lineCount`/`unknownCount` (Int16Array) maintained incrementally.
3. `_propagateAdvanced` — corner-3, corner-1, adjacent 3-3 (H+V), diagonal
   3-3 (all 4 orientations). Each via per-instance helper (so
   `_findNextHintDeduction` can dispatch individually).
4. `_propagateColors` — inside/outside cell coloring (`this.colors`
   `Uint8Array(H*W)`, 0=UNKNOWN/1=INSIDE/2=OUTSIDE; out-of-grid = OUTSIDE).
   Sub-rules: (a) known edge → adjacent cells differ iff LINE; (b) known
   colors → edge state; (c) clue × own-color → forced opposite/same colors
   on neighbours. Writes via `_setColor` (trailed).
5. `_propagateConnectivity` — `_slApplyInsideReachability` BFS-floods from
   known-INSIDE through `{INSIDE ∪ UNKNOWN}` forcing unreachable cells to
   OUTSIDE; `_slApplyOutsideReachability` from virtual exterior root
   (border cells); `_slApplyCut` iterative-Tarjan articulation analysis
   **INSIDE only** — OUTSIDE-cut is unsound (OUTSIDE can connect via plane
   exterior even when cell-graph-disconnected; rectangle-loop
   counterexample). All guarded by `!_inLookahead` to keep inner probe cheap.
6. `_propagateParity` — every straight scan line crosses the loop an even
   number of times. Horizontal scan at `y=R+0.5` crosses `V[R][.]` edges;
   vertical at `x=C+0.5` crosses `H[.][C]`. 0 unknowns + odd LINE →
   contradiction; 1 unknown → forced to make even.

Subloop prevention via union-find over LINE-edge endpoints. DSU **rebuilt
from scratch** at the two callsites needing it (`propagate()` post-fixpoint,
`_backtrack()` at completion) — incremental maintenance under backtracking
is fiddly, rebuild is O(LINE_count). Multi-loop detection at fixpoint is
deferred to final completion check (unknowns may remain legitimately in
degree-0 disconnected regions); final check enforces all clues exact, no
UNKNOWN edges, every dot degree 0/2, all LINE edges in one component.

After fixpoint, `propagate()` runs **1-step lookahead** (`_applyLookahead`) at
`_depth === 0` and `!_inLookahead` — probe each candidate UNKNOWN edge (and
selected cells), run lookahead-free inner propagate, force surviving value on
single-side contradictions. Candidate filter: edges adjacent to tight
dots/clues only.

Most-constrained variable pick at backtrack: score each UNKNOWN edge as
`10 * max(lineCount[u], lineCount[v]) - min(unknownCount[u], unknownCount[v])`
(higher = more constrained). Init `bestScore = -Infinity` (blank-board scores
are negative). Branch LINE first, then EMPTY.

**Partial results.** Hard boards (e.g. 50×40 monthly) time out but
propagation gives a useful chunk. `solve()` returns `{solved: false, partial:
true, horizontal, vertical, error: 'timed out'}` on either timeout. Two
static caches: `_solutionCache` (50-entry LRU, full solutions, keyed FNV-1a
of `(width, height, task)`); `_partialCache` (20-entry LRU, partial
snapshots, same key — partial cache hit short-circuits propagate, saves 3–7
s per Hint/Loop on monthly-class after the first timeout).
`clearSolutionCache()` clears BOTH (keep tests deterministic).

Worker budget is **10 s** (not 30) — partial-return fires sooner on too-hard
boards so the user gets visible progress in ~10 s.

`getHint(curH, curV)` seeds probe solver from live edge state, runs
`_findNextHintDeduction(minLines)` where `minLines = max(3, ceil(H*W/30))`
(scales batch with area so Loop completes in ~10 s wall regardless of size;
see [[hint-batch-scaling-for-loop]]). Inner propagate at `_depth = 1` (skips
lookahead — too expensive per click); collects forced LINE edges from trail
until reaching `minLines`, then rolls back. Falls back to tight-budget
`solve()` (capped `min(this.maxMs, 5000)` ms) returning partial. Probe sets
`_startedAt = Date.now()` so inherited `maxMs` doesn't fire spuriously.

MAIN-world: `readSlitherlinkData/readSlitherlinkState/applySlitherlinkState`,
twins of Galaxies but without flood-fill region-build (raw H/V only). Apply
calls `saveState(true)` then falls through `drawCurrentState → render →
redraw → draw`. Both read+apply preserve `0/1/2` encoding.

Diff is **edge-based** — `computePuzzleDiff('slitherlink', board, solution)`
returns `[{orientation, r, c}, ...]`. Mismatch: `board[r][c] !== 0 &&
board[r][c] !== solution[r][c]` — flags both wrong-LINEs and wrong-×s.
UNKNOWN (`0`) never flagged. `drawPreview`'s mistake overlay and
`applyHintHandler`/`applyAndRunLoop` branch on `puzzleData.type ===
'slitherlink'` for the edge shape. Loop done-check: "every solution LINE
edge is also on the board" (Slitherlink never fills all cells).

**Partial in content.js.** `solveHandler` routes `{partial: true, ...}` to
`applyPartialResult` instead of `applySolveResult` — enters confirm mode
with `"Partial only: N edges deduced..."` and deliberately does NOT call
`recordSolveSuccess` (caching a partial in `puzzleData.solution` would
mis-trigger Loop's done-check and the mistake overlay).
`previewGridFromResult(result)` returns the right shape for both slitherlink
(`{horizontal, vertical}`) and other types (`result.grid`).

`puzzleData.solution` for slitherlink is `{horizontal, vertical}` (not 2D),
so `getCachedGridSolution/cacheGridSolution` carry a slitherlink-specific
shape branch. localStorage prefix `slitherlink-solution:`. `gridDataSig`
early-bail hashes H+V directly; `staticSig` gains `|sl=`.

Hint **skips the `await pendingAutoSolve` gate** for slitherlink — `getHint`
propagates from live board, so on a hard 30×30 daily where autoSolve takes
30 s Hint still returns instantly. Other types still await (their hint
heuristics consult cached solution).

### Slitherlink CDCL search

`solve()` calls `_cdclSearch()` (CDCL with first-UIP, non-chronological
backjumping, VSIDS branching, LRU learned-clause storage cap 5000, Luby
restarts RESTART_UNIT=100). `_backtrack` kept as dead code for reference;
don't delete without first replacing `_cdclSearch`.

- **Variable encoding** — `_varIdEdge('H'|'V', idx)`, `_varIdCell(idx)`,
  `_decodeVar`. H edges `[0, numH)`, V `[numH, numH+numV)`, cells
  `[numH+numV, totalVars)`.
- **Literals** — `~lit` convention: `lit >= 0` is positive (LINE/INSIDE),
  `lit < 0` is negative (EMPTY/OUTSIDE), `varId = lit >= 0 ? lit : ~lit`.
  **Never `Math.abs(lit)` or `-lit`** — variable 0 is real and arithmetic
  negation is ambiguous.
- **Reason tracking** — `_setEdge/_setColor` push `_currentReason` (set by
  rule helpers before forcing) into `_reasons[]` parallel to `this.trail`.
  Decisions push `null`. `_decisionLevels[]` tracks level.
- **Conflict analysis** — `_analyzeConflict` is classic first-UIP plus two
  non-textbook additions: (1) subsumption pre-pass — current-level conflict
  vars whose reasons reference other current-level conflict vars marked
  "subsumed" so they don't double-count toward `pathCount`; (2) rescue path —
  if all current-level vars are subsumed (seeding leaves `pathCount === 0`),
  walk trail backward to most recent current-level seen var and clear its
  subsumed flag. Without rescue, lookahead-driven contradictions produce
  empty-but-not-empty learned clauses that backjump-to-0 incorrectly.
- **VSIDS** — `Float32Array` scores, decay 0.95 every 256 conflicts.
  `_pickDecisionLiteral()` returns highest-score unassigned. **Caller MUST
  `_allEdgesAssigned()`-check separately** — literal 0 is valid (H-edge
  0/LINE), so can't be used as "all-assigned" sentinel.
- **Luby restarts** — `_lubyNext(idx)` returns the canonical Luby sequence
  (Knuth AofA Vol 4A §7.2.2.2): `[1,1,2,1,1,2,4,1,1,2,1,1,2,4,8,...]`.
  Standard 1-indexed recurrence (the spec's iterative formula
  non-terminates on `idx===1`). Restarts pop trail to level 0, keep
  learned clauses + VSIDS.

**Performance envelope** (2026-05-23):

| board | path | wall time |
| --- | --- | --- |
| 5×5 real | propagate alone | ~0.6 ms median |
| 30×30 synthetic-rect | propagate alone | ~200 ms |
| 50×40 monthly real | times out, partial | 30 s (budget) |

50×40 monthly currently **does not solve** within 10 s (or 30 s in bench).
Returns partial with ~38% edges deduced. Bottleneck: `_applyLookahead` ~750
ms per call caps CDCL at ~40 conflicts/s — too few for a 2000-edge puzzle.

Fixture `slitherlinkRealMonthly50x40_a` carries `expectSolved: false` so
bench records timing without failing. The `tests/solver.test.js` integration
test asserts only **soundness** (not spurious `error: 'no solution found'`),
not solvedness. Tighten when a real perf fix lands.

**Lookahead/CDCL composition constraint.** `_applyLookahead`'s double-fail
(both LINE and EMPTY probes contradict) **cannot** use probe-collected
antecedents as a CDCL conflict reason: those vars are rolled back below the
analysis point, so `_analyzeConflict` sees them as level 0 and learns
nothing. Instead, the double-fail handler blames **the most recent
current-level decision** (chronological-backtrack semantics). Learned
clause `~lastDecision`, backjump pops one level, next propagate forces
opposite sense. Rule-level conflicts (with well-formed reasons that survive
rollback) still drive normal first-UIP learning.

### Approaches ruled out for the Slitherlink monthly perf gap

Tried during CDCL build (2026-05-23):

- **Disable lookahead inside `_cdclSearch` (`_depth = 1`)**: per-propagate
  cheap (~5 ms), CDCL accumulates hundreds of conflicts. But rule set
  without lookahead is too weak — converges to *spurious UNSAT*
  (`error: 'no solution found'`) on known-solvable boards.
- **Use probe-collected antecedents as CDCL conflict reason on
  double-fail**: vars rolled back below `_analyzeConflict`'s reach, UIP
  walk learns empty clauses. Source of the spurious UNSAT pre-fix.
- **Use "all current-level decisions" as conflict reason on double-fail**:
  wide learned clauses `~d1 ∨ ~d2 ∨ ... ∨ ~dk` prune huge swaths; CDCL
  falsely concludes UNSAT after ~10 conflicts.
- **Per-edge `_lookaheadClean` cache + adjacent-cell dirty tracking**:
  unsound — parity scans full rows/columns and connectivity BFSes across
  the entire cell graph. Far-away edge changes flip probe outcomes
  without dirtying any cell adjacent to the probed edge, so cache-skip
  admits stale results. Manifests as fuzz failures and false UNSAT.

### Binairo: triples inline, duplicates at completion

`_applyBalance` and `_applyUniqueness` call `_wouldCreateTriple` before each
write; `_backtrack` calls it before branch assign. Propagation cannot produce
a triple-bearing state, so `_gridHasTriple()` post-validation in `_backtrack`
is gone. `_hasDuplicateLines()` IS still called at completion (only on full
grid) because backtracking can complete a line into a duplicate, and
uniqueness only catches duplicates when one line has exactly 2 empty cells.
`solve()` calls `_gridHasTriple()` once up-front to reject invalid givens
(no-triples rule scans empty cells only). Covered by
`tests/binairo-fuzz.test.js`.

### Binairo: lookahead

After local rules (no-triples, balance, uniqueness) exhaust at top level,
1-step lookahead: probe each empty cell with each value, run lookahead-free
`propagate()`, force survivor if exactly one. `_inLookahead` prevents
recursion; `_depth` ensures lookahead only at depth 0. Without lookahead the
30×30 weekly was effectively unsolvable (minutes); with lookahead ~75 ms.

### `maxMs` budget

`BinairoSolver` accepts instance `maxMs` (default 0 = no limit). When set,
`_backtrack` and `_applyLookahead` check elapsed between iterations; over
budget returns `{solved: false, error: 'timed out'}`. UI should always set
`maxMs` to avoid minute-long hangs. `tests/solver.test.js` has a `maxMs=1`
regression that asserts bail within 500 ms.

### Galaxies geometry: shared statics on `GalaxiesSolver`
`GalaxiesSolver.seedCellsForStar(star, rows, cols)` and
`GalaxiesSolver.regionsToLines(grid, rows, cols)` are static, used by solver,
`content.js` (hint), and `handler.js` (DOM lines). Don't reintroduce per-file
copies — they drifted before.

### `handler.js` Node-only export tail
`handler.js` has `if (typeof module !== 'undefined' && module.exports) {
module.exports = { parseGalaxiesTask }; }` so tests can `require` the parser.
`registerHandler(...)` calls run under Node `require` but only push to a local
array. **Don't add a top-level statement that touches `document`/`window`/
`chrome` outside a function body** or Node-side `require()` will throw.

### Performance patterns used
- **Trail-based undo** in `NonogramSolver` and `GalaxiesSolver` — replaces
  per-recursion grid cloning.
- **Forward + backward line DP** in `NonogramSolver.solveLine` — single
  O(L·N·block) pass.
- **Bitmap canEmpty intersection** in `solveLine` — `bf[c] & bb[c+1]`
  answers per-cell can-be-empty in O(1); requires N ≤ 31 (asserted).
- **Incremental `rowKnown`/`colKnown`** in `NonogramSolver` — Int32Array
  maintained in `_set`/`_assign`/`_rollback` so backtrack picks variable
  in O(R+C).
- **Dirty-cell queue** in `GalaxiesSolver._propagate` — enqueue only cells
  whose mirror landed on the changed cell.
- **Inlined `_mirror`** at hottest sites — skip per-call `{row, col}` alloc.
- **Flat-int `Map` keys** for `GalaxiesSolver.owner` (was `"r,c"`).
- **`String.fromCharCode.apply`** for `_stateKey` hash keys.
- **`Uint8Array`-backed BFS visited sets** in `_regionReachable`.
- **Dense `Int32Array` contribs** in `AquariumSolver`.
- **Static `_solutionCache`** on `GalaxiesSolver` — bypassed when
  `initialGrid` or `forbiddenPartials` set. Use
  `GalaxiesSolver.clearSolutionCache()` in tests.
- **Canvas two-layer cache** in `content.js drawPreview` — `latticeLayer`
  (grey borders) UNDER dynamic fills; `staticLayer` (region borders /
  nonogram guides / stars) ON TOP. Both rebuilt only on shape changes.
- **FNV-1a numeric hashes** for `gridDataSig`/`regionMapSig` early-bail.

### Widget conventions
- `setStatusNodes(type, ...parts)` + `bold(text)` build status DOM via
  `appendChild`. Never `innerHTML` for dynamic content.
- `clearPendingHint()` resets pending-hint UI state in one call.
- `recordSolveSuccess(result)` caches solver output (solution, galaxies
  cache, partial clears). Shared by `applySolveResult` and `loopHandler`.
- `applySolveResult(result)` = `recordSolveSuccess` + confirm-mode UI
  transition.
- `applySolution(solution, skipUndo, internal)`: undo/redo pass
  `internal=true` so nested apply doesn't drop the mutex (outer caller owns
  it). All `handler.applySolution` impls return `{success, error?}`;
  `applySolution` propagates that, never lies about success.
- `mutatingOp` token serializes apply/undo/redo.
- Loop button repurposes as Stop while looping — `setButtonsDisabled(true)`
  must be followed by `loopBtn.disabled = false`. The inter-step 300 ms
  sleep is cancellable via `stopLoopWait` so Stop is instant.
- Lifecycle: `pagehide(persisted=false)` drains `solverPending`, terminates
  worker, stops state-watch observer. `pagehide(persisted=true)` no-ops
  (BFCache). `pageshow(persisted=true)` nulls the dead worker so next call
  rebuilds lazily.
- `detectHandler` fires `autoSolve()` (non-blocking) after successful
  detect: cache-check, then background worker solve from givens, populating
  `puzzleData.solution` + localStorage caches. `pendingAutoSolve` bridges
  the race when a feature is clicked before solve lands. `drawPreview`
  rings cells where board disagrees with solution (`computePuzzleDiff`),
  recomputed each redraw. Shikaku/Galaxies diffs are geometry- or
  star-normalized (owner/region ids don't align board↔solver).

## Capturing new real puzzles

Click the widget's **📋 Dump** button. Writes a JSON snippet (matching
`real-puzzles.js` format) to clipboard and `console.log` prefixed
`[puzzle-solver dump]`. On extractor failure the snippet includes a
`diagnostic` block — paste back to patch `dumpPuzzleForBench()` in
`main-world.js`.

## MV3 hardening contract

- `background.js`'s `onMessage` rejects `sender.id !== chrome.runtime.id`
  and gates `execMain` `funcName` against `EXEC_MAIN_ALLOWLIST` (20
  entries). TS-side mirror is `MainWorldFn` in `globals.d.ts`; keep in sync.
- `callMainWorld` has a 15 s wall-clock timeout via `Promise.race` — if SW
  dies mid-call, caller resolves `null` instead of hanging.
- `execMain` targets `sender.tab.id`, not the active tab — handles
  tab-switch mid-call.
- `manifest.json` permissions list is minimal (`scripting` only). Don't add
  `activeTab`/`storage` without concrete need.

## Tests and benches

- `npm test` runs `node:test` suite under `tests/`. `npm run lint`,
  `npm run typecheck` gated in CI.
- `tests/fixtures/puzzles.js` — small deterministic puzzles; golden
  snapshots in `tests/golden.js`. Regenerate via `npm run capture`.
- `tests/fixtures/real-puzzles.js` — full-size captures via 📋 Dump. Used
  by `tests/bench-real.js`.
- `tests/solveline.test.js` — brute-force cross-check; small (N≤3) and
  large (N=4..7, bitmap fast-path) fuzz.
- Bench scripts discard 2 warmup iterations. `bench-galaxies.js`,
  `bench-aquarium.js`, `bench-real.js` `process.exit(1)` on unsolved.
  `bench.js`'s synthetic nonogram is intentionally ambiguous so
  `solved=false` is expected.
- Compare perf vs prior revision: `jj file show -r <change-id> solver.js >
  /tmp/solver-baseline.js`, swap in, bench, swap back.
- Nightly CI `.github/workflows/bench-nightly.yml` runs all four; no
  `continue-on-error`.

## Things explicitly removed (don't reintroduce)

- `utils.js` (held `PUZZLE_SELECTORS` only used by never-registered
  `genericHandler`).
- `genericHandler` in `handler.js` (was never registered).
- `solveLineValid` in `NonogramSolver` (merged into `solveLine`).
- `console.log` breadcrumbs from `AquariumSolver.solve` and galaxies hint
  failure path.
- `setStatusHtml(html, type)` + `hintStatusText` (replaced by
  `setStatusNodes`/`hintStatusNodes`).
- `clone()` and `isContradiction()` in `NonogramSolver` (trail-based undo +
  bool from `propagate`).
- `AquariumSolver._solveMinConflicts` (random-restart heuristic, never
  called).
- `solveLine` N>31 fallback scan (bitmap is only path; real puzzles cap
  at N≈12).
- `sendToContent` action in `background.js` (unused).
- `syncGameTimerForCheck` top-level in `main-world.js` (closure lost when
  serialized; inlined as nested `syncTimer` in each caller).
- `tests/snapshots/` directory + its eslint ignore (dead infrastructure).
