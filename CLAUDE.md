# Project conventions for Claude Code

A Chrome MV3 extension that solves Nonogram, Aquarium, Galaxies, Binairo,
Binairo Plus, Shikaku, Yin-Yang, and Slitherlink puzzles on puzzles-mobile.com.
Seven solver classes in `solver.js`, a content-script widget in `content.js`,
and a small service worker in `background.js`.

## Version control: use `jj`, never plain `git`

This repo is a colocated Jujutsu + git workspace. Always use `jj` for version
control operations. Do NOT run `git commit`, `git add`, `git status`, `git log`,
`git checkout`, or any other plain `git` command.

| Intent | Command |
| --- | --- |
| Show working-copy status | `jj status` |
| Show recent history | `jj log` |
| Show diff of current change | `jj diff` |
| Commit working copy (creates a new empty change on top) | `jj commit -m "msg"` |
| Describe current change without committing | `jj describe -m "msg"` |
| Create a new empty change | `jj new` |
| Move working copy to a specific change | `jj edit <change-id>` |
| Restore a file from a previous change | `jj restore --from <change-id> <path>` |
| Show a file at a specific revision | `jj file show -r <change-id> <path>` |

When dispatching subagents that need to commit work, tell them explicitly to use
`jj` and not `git`.

## File responsibilities

| File | Role | Runs in |
| --- | --- | --- |
| `solver.js` | `NonogramSolver`, `AquariumSolver`, `GalaxiesSolver`, `BinairoSolver`, `ShikakuSolver` — pure logic, no DOM | Content script + Web Worker (via inlined Blob) + Node tests |
| `solver.worker.js` | Worker entry: imports solver.js + dispatches by puzzle type | Web Worker (inlined into a Blob — see Worker note below) |
| `content.js` | Widget UI, message dispatch, `runSolve` (Worker proxy), `drawPreview` | Content script (isolated world, page's origin) |
| `handler.js` | Per-puzzle-type handlers (galaxies/aquarium/puzzles-mobile fallback) | Content script |
| `background.js` | Service worker entry. Only contains the `chrome.runtime.onMessage` listener + `importScripts('main-world.js')` | MV3 service worker |
| `main-world.js` | Library of functions that get **serialized via `chrome.scripting.executeScript({world: 'MAIN', func})`** and executed in the page context. They reference `window.Game`, `document`, `localStorage` — none of which exist in the service worker. | Page MAIN world (per call) |

## Build output (`dist/`)

`dist/` is the minimized extension folder Chrome loads — only the files referenced by `manifest.json` plus `main-world.js` (which `background.js` `importScripts`). It's gitignored and rebuilt by `npm run build`.

**After editing any of these source files, run `npm run build`** so Chrome picks up the change on the next reload:

- `manifest.json`, `background.js`, `main-world.js`
- `content.js`, `handler.js`, `solver.js`, `solver.worker.js`
- anything under `icons/` that's referenced by `manifest.json`

Edits to tests, lint config, docs, `package.json`, etc. do **not** need a rebuild.

## Architectural notes (the non-obvious bits)

### MV3 Worker cross-origin gotcha
Content scripts share the page's origin, so `new Worker(chrome.runtime.getURL('solver.worker.js'))` is blocked as cross-origin **even when the resource is web-accessible**. `content.js` works around it by `fetch`-ing both `solver.js` and `solver.worker.js` as text, stripping the worker's `importScripts(...)` line, and constructing the Worker from a same-origin `Blob` URL. See `getSolverWorker()` in `content.js`.

### MAIN-world function dispatch
`callMainWorld(funcName, args)` in `handler.js` sends `{action: 'execMain', funcName}` to the SW. The SW does `globalThis[funcName]` to find the function (declared in `main-world.js`, imported via `importScripts`), then calls `chrome.scripting.executeScript({func, args, world: 'MAIN'})`. The function is **serialized as source via `fn.toString()`** and injected into the page, so:
- It cannot reference outer-scope helpers (closure is lost in transit). Nested helpers must live inside the function body.
- It cannot reference functions defined elsewhere in `main-world.js` — only globals available in MAIN world (`window.Game`, `document`, etc.).

### MAIN-world write functions: save + render ladder
Any function in `main-world.js` that mutates `window.Game.currentState` (`applyGameState`, `applyGalaxiesState`, `applyHintCells`) must:
1. Call `window.Game.saveState(true)` **before** the writes. Without it, aquarium silently keeps its prior visible state even though `cellStatus` was updated — symptom: "preview shows hint, board shows no change". `applyHintCells` had this bug pre-2026-05-17.
2. Fall through `Game.render → Game.redraw → Game.redrawGrid → getSaved+loadGame` **after** the writes. `Game.render` isn't universal across puzzle types — aquarium needs `redraw` or `redrawGrid`.

`applyGameState` is the reference shape; `applyHintCells` now mirrors it (minus the `solved=true` flag, which is full-solution-only). Neither calls `window.Game.check()` — the extension never auto-submits a solution, because the site flags an instant solve as a DNF.

### Binairo encoding gotcha

The page exposes two different integer encodings on `window.Game` for the same
cell positions:

- `window.Game.task` — 2D array of **givens**: `-1=blank, 0=given-zero, 1=given-one`.
- `window.Game.currentState.cellStatus` — 2D array of **current state**:
  `0=empty, 1=filled-one (black), 2=filled-zero (white)`.

Translation (givens → initial cellStatus): `-1→0, 0→2, 1→1`.

`BinairoSolver` works internally in **cellStatus encoding** and translates
givens at the constructor boundary; everything downstream (worker dispatch,
preview rendering, MAIN-world apply) uses `0/1/2`. Don't reintroduce the
`-1/0/1` triad into solver/widget code — it's an input-only encoding.

`BinairoSolver.getHint(grid)` requires `grid` in cellStatus encoding. The
`binairoHandler.readState()` call returns it in that encoding directly.

The comparison-clue variant (`/binairo-plus/*`) is now supported — see the
Binairo Plus subsection below. Note: the page pre-allocates
`comparisonClues` as one empty array per row on the standard variant too
(so the outer length always equals `puzzleHeight`); code that distinguishes
"clues present" from "structure exists" must look at marker counts inside,
not just the outer length.

### Binairo Plus / comparison-clue support

The `/binairo-plus/*` path is served by the same `binairoHandler` and
`BinairoSolver` as standard Binairo, with one extra rule and one extra
constructor field.

Page exposes comparison clues at `window.Game.comparisonClues` as a sparse
2D of flag integers. Each non-null entry `flag` at `(r, c)` decodes via
bit positions exported on `Game` as `FLAG_RIGHT_EQ=1`, `FLAG_RIGHT_NE=2`,
`FLAG_DOWN_EQ=4`, `FLAG_DOWN_NE=8` (OR-able). A flag of `10` (= `8|2`)
encodes "down ≠ AND right ≠" on that cell. (The preview canvas renders the
NE marker as `×` rather than `≠` to match the page's in-game display.)

`BinairoSolver._decodeComparison(comparisonClues)` flattens the sparse
2D into a canonical array of `{ aR, aC, bR, bC, sameSign }` constraints
stored as `this.compConstraints`. Out-of-grid borders are silently
dropped during decode.

`_applyComparison(onChange)` runs in `propagate()` between balance and
uniqueness. For each constraint:
- both sides known + inconsistent → contradiction (`return false`);
- exactly one side known → force the other (with `_wouldCreateTriple`
  pre-check so the assign-time triple invariant from the rest of the
  solver still holds);
- neither side known → skip.

Because `_applyComparison` validates both-sides-known pairs every pass, a
successful `propagate()` guarantees no comparison violations — no
separate `_hasComparisonViolation` check is needed at completion
(unlike `_hasDuplicateLines`, which IS still needed because uniqueness
has a real gap on lines with > 2 empty cells).

`puzzleData.type === 'binairo'` for both paths — the discriminator lives
in `puzzleData.comparisonClues` (empty array for standard binairo,
populated sparse 2D for plus). The cache key (`binairoCacheKey` and
`BinairoSolver._cacheKey`) mixes comparison-clue bytes so two boards
with identical givens but different clues don't share cache slots.

Preview canvas renders `=` / `×` glyphs at cell-boundary midpoints in the
cached `staticLayer`; `staticSig` includes a `|cc=` segment so the
layer rebuilds when the clue set changes.

### Shikaku encoding

The `/shikaku/*` path is served by a dedicated `ShikakuSolver` +
`shikakuHandler` because Shikaku's algorithm doesn't overlap with the
cell-state puzzles (it partitions the grid into rectangles).

Page exposes the puzzle at `window.Game.task` as a 2D array of integers.
Non-zero cells are clues — the integer value is the **area** of the
rectangle that must contain that cell. Zero cells are non-clue cells.
`window.Game.currentState.cellStatus` is `rows × cols` of int: `-1` =
unassigned, otherwise the index of the area (rectangle) that owns the
cell. `currentState.areas` holds the rectangle list, indexed by owner id —
`applyShikakuState` in `main-world.js` rebuilds it from `cellStatus`. Each
area MUST match the shape the page builds for its own moves (a cloned
`currentMove`):
`{ cells:[{row,col}], cellStatus:id, invert:false, startPoint:{row,col}, endPoint:{row,col} }`.
The field names are load-bearing — three different page functions touch
areas and each crashes on a mismatch:
- `drawCurrentStateInternal` passes each `areas[t]` to `drawRect`, which
  reads `area.startPoint.{row,col}` / `area.endPoint.{row,col}`.
- `removeArea` (fires when the player draws over an applied area) iterates
  `area.cells` and reads each `.row`/`.col` — so the cell list MUST be
  `cells` of `{row,col}`, NOT `cellList` of `{r,c}`.
- `applyCurrentMoveToState` stores a new area at `areas[move.cellStatus]`,
  so every area's `cellStatus` field must equal its own array index.
A clue with no cells (partial hint state) is left `undefined` at its
index — the page's `void 0 !== areas[t]` guards (in `drawCurrentStateInternal`
and `removeArea`) skip those.

Solver shape: `ShikakuSolver` per-clue enumerates rectangle candidates
(axis-aligned rects containing the clue cell, with the right area, no
other clue inside, fitting the grid). Propagation: single-candidate
forcing places a rectangle and prunes overlapping candidates of other
clues. Most-constrained backtracking when propagation exhausts. `getHint`
runs propagation, then a forward-checking pass, then a final tier that
solves and reveals one rectangle. Static `_solutionCache` keyed on
FNV-1a of `(rows, cols, clues sorted)`, 50-entry LRU.

Solution shape across worker → content → MAIN bridge: 2D `number[][]`
where each cell holds its owning clue's index (0..K-1) or `-1`. The hint
shape is row-anchored like other puzzles; cell values are owner indices,
not 1/2/-1. `applyHintHandler` and `applyAndRunLoop` in `content.js` have
shikaku-specific arms that re-read state, overlay hint cells, and apply
via `applyShikakuState` (the generic `applyHintCells` assumes cell-state
encoding). The Loop done-check uses `-1` as the unassigned sentinel for
shikaku (`0` is a valid owner index), unlike other puzzles where `0`
means unassigned.

Preview canvas colors each cell by owner index (`galaxiesColors`
palette), draws thick borders between distinct owners, and overlays clue
numbers as bold text. The clue overlay lives in the cached `staticLayer`;
`staticSig` includes a `|sk=` segment so the layer rebuilds when the clue
set changes.

### Yin-Yang encoding

The `/yin-yang/*` path is served by a dedicated `YinYangSolver` +
`yinYangHandler`. Yin-Yang shares Binairo's exact cell encoding:

- `window.Game.task` — 2D givens: `-1` = none, `0` = given white,
  `1` = given black.
- `window.Game.currentState.cellStatus` — live state: `0` = empty,
  `1` = black, `2` = white.
- Translation givens → cellStatus: `-1→0, 0→2, 1→1`.

`YinYangSolver` works internally in cellStatus encoding and translates
`task` givens at the constructor boundary, mirroring `BinairoSolver`.

Rules: (1) every cell is black or white; (2) all black cells form one
orthogonally-connected region, all white cells likewise; (3) no 2×2 window
may be monochrome OR a diagonal checkerboard (a checkerboard makes both
colours' diagonal pairs uncrossable, so it is forbidden).

Solver shape: `propagate()` iterates four sound local rules to a fixpoint —
2×2 forcing (`_apply2x2`: no 2×2 monochrome or diagonal checkerboard),
reachability (`_applyReachability`: BFS the `{colour ∪ empty}` graph from a
colour's placed cells; an empty cell the BFS cannot reach can never be that
colour, so force the other), articulation-point cut (`_applyCut` +
`_articulationPoints`: an empty articulation point of the `{colour ∪ empty}`
graph whose removal severs the colour's placed cells is forced to that
colour), and border-arc (`_applyBorderArc`: a valid Yin-Yang has at most 2
border arcs, so the perimeter cycle has at most 2 colour transitions — ≥4 is
a contradiction, and a border cell whose wrong colour would create a 3rd arc
is forced). After the local rules stall, at the top level only (`_depth ===
0`, with an `_inLookahead` guard against re-entry) `propagate()` runs a
1-step lookahead (`_applyLookahead`: probe each empty cell with each colour;
if exactly one colour propagates to a contradiction, force the other). Then
most-constrained backtracking (`_pickCell`). On a complete grid a successful
`propagate()` IS a validity proof — no separate completion check. `getHint`
first runs the local rules only (`_localHint`, fast); if they deduce
nothing it falls back to `_lookaheadStepHint` — a single lookahead
deduction plus the local cascade it triggers, an immediate next step
rather than the whole solvable remainder — so Hint never dead-ends while
the puzzle is still solvable. Static `_solutionCache`
keyed on FNV-1a of `(rows, cols, task)`, 50-entry LRU. Instance `maxMs`
budget; the worker sets 30 s so large weeklies are not cut off (a 35×35
weekly solves fully by deduction in ~5 s).

MAIN-world: `readYinYangData` / `readYinYangState` / `applyYinYangState`,
twins of the Binairo functions. Hints reuse the generic `applyHintCells`
path (Yin-Yang is `0/1/2` cell-state encoding, like Binairo). The Loop
done-check needs no special arm — `0` = empty, like the other cell-state
puzzles.

### Slitherlink encoding

The `/loop/*` path is served by a dedicated `SlitherlinkSolver` +
`slitherlinkHandler`. The puzzle is named "slitherlink" everywhere in code
to avoid colliding with the existing Loop button feature; the URL path
matcher still keys on `/loop/`.

Page encoding (edge-based, same shape as Galaxies):
- `window.Game.task` — 2D `int[H][W]`. `-1` = no clue; `0/1/2/3` = clue
  (count of loop edges around that cell).
- `window.Game.currentState.cellHorizontalStatus` — `(H+1) × W`:
  `0` = empty, `1` = line, **`2` = × (cross / "not a loop edge")**.
- `window.Game.currentState.cellVerticalStatus` — `H × (W+1)`, same
  encoding.

Internal solver edge encoding: `0 = UNKNOWN`, `1 = LINE`, `2 = EMPTY`.
The `1 = LINE` value was chosen so the solver→apply translation is a
direct passthrough (`1` stays `1`, `2` stays `2`, `0` stays `0`). **× is
fully supported end-to-end** — `readSlitherlinkState` extracts page `2`s
as EMPTY, `_emit` outputs `2`s for known EMPTY, `applySlitherlinkState`
writes `2`s back, and `drawPreview`'s slitherlink arm renders ×s in
muted gray on top of the LINE layer. Don't reintroduce "ignore page `2`"
behavior — the solver gets meaningful signal from user-drawn ×s, and
writing back the deduced ×s shrinks the manual residue on hard boards.

Trail-based undo uses a **2-bit kind field** packed into each entry:
`(kind << 24) | idx` for edges (`kind` 0=H, 1=V), or
`(oldColor << 26) | (2 << 24) | idx` for cell-color writes (see below).
`_rollback` dispatches on `(e >> 24) & 3` and restores the appropriate
slot. Edge writes don't trail the old value (`_setEdge` rejects overwrite
of non-UNKNOWN); color writes do (`_setColor` only writes UNKNOWN→known,
but the old/new distinction matters because we need to know which color
slot to restore).

The propagation fixpoint runs five rules in order, cheapest first so
expensive global rules only fire on a saturated local state:

1. **`_propagateClues`** — clue forcing (`m > k` or `m + n < k` →
   contradiction; `m == k` → remaining UNKNOWN edges → EMPTY; `m + n == k`
   → remaining UNKNOWN → LINE).
2. **`_propagateVertices`** — every dot's loop-degree ∈ {0, 2}; per-dot
   `lineCount` / `unknownCount` counters (Int16Array) maintained
   incrementally on assign/rollback.
3. **`_propagateAdvanced`** — classic Slitherlink patterns: corner-3,
   corner-1, adjacent 3-3 (horizontal + vertical), diagonal 3-3 (all 4
   orientations). Each fires via a per-instance helper (`_applyCornerThree`,
   `_applyAdjacentThreeH`, etc.) — the per-instance shape exists so
   `_findNextHintDeduction` can dispatch the same helpers individually.
4. **`_propagateColors`** — inside/outside cell coloring (`this.colors`
   `Uint8Array(H*W)`, 0=UNKNOWN/1=INSIDE/2=OUTSIDE). Out-of-grid is
   implicitly OUTSIDE. Three sub-rules: (a) known edge → relation between
   adjacent cells' colors (LINE iff differ); (b) known colors → edge
   state; (c) clue × own-color → forced opposite/same colors on the cell's
   neighbours. Cell-color writes go through `_setColor` (trailed via the
   2-bit-kind extension above).
5. **`_propagateConnectivity`** — INSIDE/OUTSIDE region connectivity.
   `_slApplyInsideReachability` BFS-floods from a known-INSIDE cell
   through `{INSIDE ∪ UNKNOWN}` and forces unreachable cells to OUTSIDE;
   `_slApplyOutsideReachability` does the same from a virtual exterior
   root that all border cells connect to (a known-OUTSIDE cell trapped
   inside an INSIDE wall is a contradiction). `_slApplyCut` runs an
   iterative-Tarjan articulation-point analysis (recursion would blow JS
   stack on 50×40 boards) **only for INSIDE** — the OUTSIDE-cut rule is
   unsound because OUTSIDE cells can connect via the plane exterior even
   when cell-graph-disconnected (the rectangle-loop counterexample
   demonstrates this). All connectivity is guarded by `!_inLookahead` to
   keep the inner probe cheap.
6. **`_propagateParity`** *(also gated by no further guard, runs every
   pass)* — every straight scan line through the puzzle crosses the
   closed loop an even number of times. A horizontal scan at `y = R+0.5`
   crosses **`V[R][.]`** edges (the vertical edges *in* row R — collinear
   ones don't count); a vertical scan at `x = C+0.5` crosses **`H[.][C]`**
   edges. For each scan: 0 unknowns + odd LINE count → contradiction;
   1 unknown → forced to LINE or EMPTY to make even.

Subloop prevention is via union-find over LINE-edge endpoints. The DSU
is **rebuilt from scratch** at the two callsites that need it
(`propagate()` post-fixpoint, `_backtrack()` at completion) rather than
maintained incrementally — keeping the trail+DSU invariants in sync under
backtracking is fiddly, and rebuild cost is O(LINE_count) which is cheap
relative to per-rule work. When a closed cycle is detected at propagation
fixpoint, the multi-loop check is deferred to `_backtrack`'s final
completion check (the propagation fixpoint may have legitimate unknowns
remaining in degree-0 disconnected regions); the final check enforces
that every clue is satisfied exactly, no UNKNOWN edges remain, every dot
degree 0/2, and all LINE edges are in one connected component.

After the local-rule fixpoint, `propagate()` runs **1-step lookahead**
(`_applyLookahead`) at `_depth === 0` and with `!_inLookahead` — for each
candidate UNKNOWN edge (and selected UNKNOWN cell), probe each value,
run a lookahead-free inner propagate, force the surviving value on
single-side contradictions. Candidate filter: edges adjacent to tight
dots/clues only, to keep the lookahead cost bounded on large boards.

Most-constrained variable pick at backtrack time: score each UNKNOWN edge
as `10 * max(lineCount[u], lineCount[v]) - min(unknownCount[u], unknownCount[v])`
(higher = more constrained). Initialize `bestScore = -Infinity` (scores
on a blank board are negative). Branch LINE first, then EMPTY.

**Partial results.** Hard boards (e.g. the 50×40 monthly) can't be fully
solved within the worker's budget but propagation determines a useful
chunk. `solve()` returns `{ solved: false, partial: true, horizontal,
vertical, error: 'timed out' }` on either propagate-timeout or
backtrack-timeout — the H/V arrays carry whatever the current trail
state contains, which is the deducible portion. Two static caches sit
side-by-side:
- `_solutionCache` (50-entry LRU): complete solutions, keyed by FNV-1a
  of `(width, height, task)`.
- `_partialCache` (20-entry LRU): partial-on-timeout snapshots, same
  key. `solve()` checks both at the start; a partial cache hit short-
  circuits the full propagate (saves 3–7 s per Hint/Loop click on a
  monthly-class board after the first timeout).

`clearSolutionCache()` clears BOTH static caches — keep tests that mix
hard/easy puzzles using it for determinism.

Worker budget is **10 s** (`solver.worker.js`), not 30 s — propagate
caps at ~6 s on a 50×40 with coloring + connectivity, leaving little
backtracking headroom. The shorter budget means the partial-return path
fires sooner on too-hard boards, so the user gets visible progress in
~10 s instead of waiting 30 s for "timed out".

`getHint(curH, curV)` constructs a probe solver seeded from the current
edge state and runs `_findNextHintDeduction(minLines)` where
`minLines = max(3, ceil(H * W / 30))` (scales the per-click batch with
board area so Loop completes in ~10 s wall on any size; see
[[hint-batch-scaling-for-loop]] memory). `_findNextHintDeduction` runs
`propagate()` with `_depth = 1` (skips lookahead — too expensive per
click), collects forced LINE edges from the trail until reaching
`minLines`, and rolls back. If local rules find at least one LINE edge,
returns those; otherwise falls back to a tight-budget `solve()` (capped
at `min(this.maxMs, 5000)` ms) which may return a partial, and pulls up
to `minLines` missing LINE edges from the partial. The probe explicitly
sets `_startedAt = Date.now()` before propagate() so the inherited
`maxMs` doesn't fire spuriously.

MAIN-world: `readSlitherlinkData` / `readSlitherlinkState` /
`applySlitherlinkState`, twins of the Galaxies functions but without the
flood-fill region-build (we only care about the raw H/V arrays).
`applySlitherlinkState` calls `saveState(true)` before writes, then falls
through the `drawCurrentState → render → redraw → draw` ladder. Both
read and apply preserve the `0/1/2` encoding (`2` is × — see top of
this section).

The diff is **edge-based** — `computePuzzleDiff('slitherlink', board,
solution)` returns `[{orientation, r, c}, ...]` entries, not `{row, col}`
entries. A mismatch is `board[r][c] !== 0 && board[r][c] !== solution[r][c]`,
so the diff flags both wrong-LINEs AND wrong-×s (board says ×, solution
says LINE, or vice versa). UNKNOWN board entries (`0`) are never flagged.
Both `drawPreview`'s mistake overlay (paints wrong edges in red) and
`applyHintHandler` / `applyAndRunLoop` branch on
`puzzleData.type === 'slitherlink'` to handle the edge shape. The Loop
done-check is "every solution LINE edge is also on the board", because
Slitherlink boards never get "all cells filled" — the empty-cell
sentinel that other puzzles use to detect completion doesn't apply.

**Partial solutions in content.js.** When `solve()` returns
`{ partial: true, ... }`, `solveHandler` routes to `applyPartialResult`
instead of `applySolveResult`. The partial preview enters confirm mode
with a status like `"Partial only: N edges deduced..."` and deliberately
does NOT call `recordSolveSuccess` — caching a partial in
`puzzleData.solution` would mis-trigger Loop's done-check (Loop would
report "Solved!" when the partial's LINEs land, even though the real
puzzle has more) and the mistake overlay (a missing LINE in the partial
isn't actually wrong, just unknown). `previewGridFromResult(result)`
hands the right shape to `drawPreview` for both slitherlink (`{horizontal,
vertical}`) and other types (`result.grid`).

`puzzleData.solution` for slitherlink is `{horizontal, vertical}` (not a
2D `number[][]`), so `getCachedGridSolution` / `cacheGridSolution` carry
a slitherlink-specific shape branch — straight 2D-grid serialization
would lose the structure. The cache localStorage key prefix is
`slitherlink-solution:`. The `gridDataSig` early-bail in `drawPreview`
hashes the H+V arrays directly; `staticSig` gains a `|sl=` segment so
the static layer rebuilds when the task changes.

Hint (and `hintHandler` in content.js) **skips the `await pendingAutoSolve`
gate** for slitherlink — `getHint` propagates from the live board state
without needing the cached solution, so on a hard 30×30 daily where
autoSolve takes 30 s, Hint still returns instantly (was 30 s before that
fix). Other puzzle types still await because their hint heuristics
consult the cached solution for mistake comparison.

### Slitherlink CDCL search

`SlitherlinkSolver.solve()` no longer calls `_backtrack()` — it calls
`_cdclSearch()`, a CDCL (Conflict-Driven Clause Learning) loop with
first-UIP analysis, non-chronological backjumping, VSIDS branching, LRU
learned-clause storage (cap 5000), and Luby restarts (RESTART_UNIT=100).
`_backtrack` is kept as dead code for reference; do not delete it without
first replacing `_cdclSearch`. The relevant entry points:

- **Variable encoding** — `_varIdEdge('H'|'V', idx)`, `_varIdCell(idx)`,
  `_decodeVar(varId)`. H edges occupy `[0, numH)`, V edges `[numH,
  numH+numV)`, cell colors `[numH+numV, totalVars)`.
- **Literals** — `~lit` convention: `lit >= 0` is positive (LINE /
  INSIDE), `lit < 0` is negative (EMPTY / OUTSIDE), `varId = lit >= 0 ?
  lit : ~lit`. **Never use `Math.abs(lit)` or `-lit`** — variable 0 is a
  real edge and the sign of 0 is ambiguous under arithmetic negation.
- **Reason tracking** — `_setEdge`/`_setColor` push `_currentReason` (set
  by rule helpers before they force) into a `_reasons[]` array parallel to
  `this.trail`. Decisions push `null`. `_decisionLevels[]` tracks the
  level at which each entry was made.
- **Conflict analysis** — `_analyzeConflict(conflictReason)` runs the
  classic first-UIP walk with two non-textbook additions:
  (1) a subsumption pre-pass — current-level conflict vars whose reasons
  reference other current-level conflict vars are marked "subsumed" so
  they don't double-count toward pathCount;
  (2) a rescue path — if all current-level vars in `conflictReason` are
  subsumed (so seeding leaves `pathCount === 0`), walk the trail backward
  to find the most recent current-level seen var and clear its subsumed
  flag. Without this, lookahead-driven contradictions could produce
  empty-but-not-empty learned clauses that backjump-to-0 incorrectly.
- **VSIDS** — `Float32Array` per-variable scores, decay 0.95 every 256
  conflicts. `_pickDecisionLiteral()` returns the highest-score
  unassigned variable. **The caller must `_allEdgesAssigned()`-check
  separately** — literal 0 is a valid literal (H-edge 0 / LINE), so
  `_pickDecisionLiteral` can't use 0 as an "all assigned" sentinel
  unambiguously.
- **Luby restarts** — `_lubyNext(idx)` returns the canonical Luby
  sequence (Knuth, AofA Vol 4A §7.2.2.2): `[1, 1, 2, 1, 1, 2, 4, 1, 1, 2,
  1, 1, 2, 4, 8, ...]`. The original implementation copied a buggy
  iterative formula from the spec that non-terminated on `idx === 1`;
  fixed to the standard 1-indexed recurrence and the test fixture updated.
  Restarts pop trail to level 0, keep all learned clauses + VSIDS scores.

**Slitherlink performance envelope** (as of 2026-05-23):

| board                | path                  | wall time      |
| -------------------- | --------------------- | -------------- |
| 5×5 real             | propagate alone       | ~0.6 ms median |
| 30×30 synthetic-rect | propagate alone       | ~200 ms        |
| 50×40 monthly real   | times out, partial    | 30 s (budget)  |

The 50×40 monthly currently **does not solve** within the worker's 10 s
budget (or even 30 s in a bench). It returns `{ solved: false, partial:
true, error: 'timed out', horizontal, vertical }` with ~38 % of edges
deduced — usable for the Hint/Loop interactive path but not a one-shot
solve. The bottleneck is `_applyLookahead`: each top-level propagate
runs the per-cell probing loop (~750 ms per call on the monthly), which
caps CDCL at ~40 conflicts/s — far too few to drive a 2000-edge puzzle
to completion through branching.

The monthly fixture `slitherlinkRealMonthly50x40_a` in
`tests/fixtures/real-puzzles.js` carries `expectSolved: false` so
`bench-slitherlink.js` records the timing as a baseline without failing.
The corresponding `tests/solver.test.js` integration test asserts only
**soundness** (returns within wall-clock guard; not a spurious
`error: 'no solution found'`), not solvedness. Tighten both once a real
perf fix lands.

**Lookahead/CDCL composition constraint.** `_applyLookahead`'s
double-fail (both LINE and EMPTY probes contradict) cannot use the
probe-collected antecedent set as a CDCL conflict reason: those vars are
forced inside the probe and get rolled back below the analysis point,
so `_analyzeConflict` sees them as level 0 and learns nothing. Instead,
the double-fail handler blames **the most recent current-level decision**
in the trail (chronological-backtrack semantics, same as the legacy
`_backtrack`). `_analyzeConflict` then learns the unit clause
`~lastDecision`, backjump pops to the level below, the next propagate
forces the opposite sense. Rule-level conflicts (which DO have
well-formed reasons that survive rollback) still drive normal first-UIP
CDCL learning.

### Approaches ruled out for the Slitherlink monthly perf gap

Tried during the CDCL build (2026-05-23). Documented so future maintainers
don't re-walk these paths without new insight:

- **Disable lookahead inside `_cdclSearch` (set `_depth = 1`)**: makes
  per-propagate cheap (~5 ms) and lets CDCL accumulate hundreds of
  conflicts. But the rule set without lookahead is too weak — on
  known-solvable boards CDCL converges to a *spurious UNSAT*
  (`error: 'no solution found'`). Without stronger non-probing inference
  rules this trade is unsound.
- **Use probe-collected antecedents as the CDCL conflict reason on
  lookahead double-fail (the original lookahead reason capture)**: as
  above — the vars are rolled back below `_analyzeConflict`'s reach, so
  the UIP walk learns empty clauses. Was the source of the spurious
  UNSAT observed on the monthly before the 2026-05-23 fix.
- **Use "all current-level decisions" as the conflict reason on
  double-fail**: derives wide learned clauses (`~d1 ∨ ~d2 ∨ ... ∨ ~dk`).
  Each one prunes a huge swath of the search space; after ~10 conflicts
  CDCL falsely concludes UNSAT.
- **Per-edge `_lookaheadClean` cache + adjacent-cell dirty tracking**:
  unsound for Slitherlink because parity (`_propagateParity`, scans full
  rows/columns) and connectivity rules (`_propagateConnectivity`, BFS
  across the entire cell graph) are non-local. A far-away edge change
  can flip a probe outcome without dirtying any cell adjacent to the
  probed edge, so the cache-skip lets in stale results. Manifests as
  fuzz-test failures and false UNSAT on the monthly.

### Backtracking validates duplicates at completion; triples validated inline

`BinairoSolver._applyBalance` and `_applyUniqueness` now call
`_wouldCreateTriple` before each write, and `_backtrack` calls it before the
branch assign. As a result, propagation cannot produce a triple-bearing
state, and the previous `_gridHasTriple()` post-validation in `_backtrack` is
gone. `_hasDuplicateLines()` is still called at completion (only when the
grid is fully filled) because backtracking can complete a line into a
duplicate of another full line, and the uniqueness rule only catches
duplicates when one of the two lines has exactly 2 empty cells. `solve()`
also calls `_gridHasTriple()` once up-front to reject invalid givens (the
no-triples rule only scans empty cells, so a pre-existing triple in the
givens would otherwise slip through). Found via fuzz testing during initial
implementation; current covered by `tests/binairo-fuzz.test.js`.

### Lookahead / forward-checking phase

After the three local rules (no-triples, balance, uniqueness) exhaust within
a single `propagate()` call at the top level, `BinairoSolver` runs a
1-step lookahead: for each empty cell, tentatively place each value, run a
lookahead-free `propagate()`, and check whether either assignment leads to
contradiction. If exactly one value survives, force the other. The
`_inLookahead` flag prevents recursive lookahead during the per-probe inner
propagate. The `_depth` field ensures lookahead runs *only* at the top level
(`_backtrack` increments `_depth` so inner propagates skip lookahead) — the
per-cell probing cost is too expensive at deep backtrack levels but
dramatically prunes the search at depth 0. Without lookahead the 30×30
weekly was effectively unsolvable (the original backtrack ran for minutes);
with lookahead it solves in ~75 ms.

### `maxMs` budget

`BinairoSolver` accepts an instance-level `maxMs` field (default 0 = no
limit). When set, `_backtrack` and `_applyLookahead` check elapsed time
between iterations; once exceeded the solver returns `{ solved: false,
error: 'timed out' }`. The UI side should set `maxMs` whenever it dispatches
a solve to avoid minute-long hangs on degenerate inputs (the worker has no
other escape). The `tests/solver.test.js` suite includes a `maxMs=1`
regression test that asserts the solver bails within 500 ms.

### Galaxies geometry: shared statics on `GalaxiesSolver`
`GalaxiesSolver.seedCellsForStar(star, rows, cols)` and `GalaxiesSolver.regionsToLines(grid, rows, cols)` are static methods used by the solver itself, `content.js` (hint computation), and `handler.js` (DOM line writing). Don't reintroduce per-file copies — the three previous near-identical implementations drifted and that's the bug audit item #5 fixed.

### `handler.js` Node-only export tail
`handler.js` carries a `if (typeof module !== 'undefined' && module.exports) { module.exports = { parseGalaxiesTask }; }` tail so `tests/handler-parsers.test.js` can `require` the parser. The three `registerHandler(...)` calls still execute under Node `require`, but they only push handler objects to a local array — nothing touches the DOM until `.matches()` runs, and tests don't call `getActiveHandler()`. **Don't add a top-level statement that touches `document` / `window` / `chrome` outside a function body** or the Node-side `require()` will throw.

### Performance patterns used
- **Trail-based undo** in `NonogramSolver` (`_assign`/`_rollback` pushing flat 3-int groups) and `GalaxiesSolver` (same with 2D tuples) — replaces per-recursion grid cloning.
- **Forward + backward line DP** in `NonogramSolver.solveLine` — single O(L·N·block) pass replaces the old per-cell solveLineValid reruns (was 36× slower on the 50×50 monthly).
- **Bitmap canEmpty intersection** in `solveLine` — `bf[c] & bb[c+1]` k-bit intersection answers the per-cell can-be-empty check in O(1); requires N ≤ 31, asserted in code.
- **Incremental `rowKnown`/`colKnown`** in `NonogramSolver` — Int32Array per-line counts maintained in `_set`/`_assign`/`_rollback` so `backtrack` picks its variable in O(R+C) instead of O(R·C) per recursion.
- **Dirty-cell queue** in `GalaxiesSolver._propagate` — after each assignment, only enqueue cells whose mirror-under-some-star landed on the changed cell. Replaces the prior `while(didChange)` full grid sweep.
- **Inlined `_mirror`** at the hottest sites (`_canAssignPair`, `_assignPair`, `_shapeFrontier`) — skips the per-call `{row, col}` object allocation.
- **Flat-int `Map` keys** for `GalaxiesSolver.owner` (was `"r,c"` strings).
- **`String.fromCharCode.apply`** for state-hash keys in `_stateKey` (was `+= toString(36) + '.'`).
- **`Uint8Array`-backed BFS visited sets** in `_regionReachable`.
- **Dense `Int32Array` contribs** in `AquariumSolver` (was sparse `{row: count}` objects).
- **Static `_solutionCache`** on `GalaxiesSolver` — bypassed when `initialGrid` or `forbiddenPartials` is set (constraints invalidate the unconstrained cached result). Use `GalaxiesSolver.clearSolutionCache()` in tests to keep them order-independent.
- **Canvas: two-layer cache** in `content.js drawPreview` — `latticeLayer` (grey cell-border lines) drawn UNDER dynamic fills; `staticLayer` (region borders / nonogram guides / galaxy stars) drawn ON TOP. Both rebuilt only on puzzle-shape changes. Dynamic fills + X-mark Path2D in between.
- **FNV-1a numeric hashes** for `gridDataSig` / `regionMapSig` early-bail in `drawPreview` (was O(N²) string concat per 200ms tick).

### Widget conventions
- `setStatusNodes(type, ...parts)` + `bold(text)` build status DOM via `appendChild`. Never use `innerHTML` for dynamic content.
- `clearPendingHint()` resets the pending-hint UI state in one call (formerly a scattered 3-line pattern).
- `recordSolveSuccess(result)` caches the solver output (puzzle solution, galaxies cache, partial clears). Shared by both `applySolveResult` and `loopHandler`'s intermediate solve so the cache invariants can't drift.
- `applySolveResult(result)` = `recordSolveSuccess(result)` + the confirm-mode UI transition (status text, button label, preview). Used by fresh-solve and retry paths.
- `applySolution(solution, skipUndo, internal)`: undo/redo pass `internal=true` so the nested apply doesn't drop the mutex (the outer caller already owns it). All three handler.applySolution implementations return `{ success, error? }`; applySolution propagates that, never lies about success.
- `mutatingOp` token serializes apply/undo/redo so they can't interleave.
- The Loop button repurposes as Stop while looping — `setButtonsDisabled(true)` must be followed by `loopBtn.disabled = false`. The inter-step 300ms sleep is cancellable via `stopLoopWait` so Stop is instant.
- Lifecycle: `pagehide(persisted=false)` drains `solverPending`, terminates the worker, stops the state-watch observer. `pagehide(persisted=true)` no-ops (BFCache). `pageshow(persisted=true)` nulls the (now-dead) worker so the next call rebuilds lazily.
- `detectHandler` fires `autoSolve()` (non-blocking) after a successful
  detect: it cache-checks then runs a background worker solve from the
  puzzle's givens, populating `puzzleData.solution` + the localStorage
  caches so Solve/Hint/Loop reuse it (`pendingAutoSolve` bridges the race
  window when a feature is clicked before the solve lands). `drawPreview`
  then rings cells where the board disagrees with the solution
  (`computePuzzleDiff` in `solver.js`), recomputed each redraw so it tracks
  the board live. Shikaku's diff compares rectangle geometry and Galaxies'
  is star-normalized, because their owner/region ids don't align between
  the page board and the solver solution.

## Capturing new real puzzles

Click the widget's **📋 Dump** button on any puzzle page. It writes a JSON snippet (matching the `real-puzzles.js` format) to the clipboard and to `console.log` with prefix `[puzzle-solver dump]`. On extractor failure the snippet includes a `diagnostic` block with the shape of `window.Game` — paste that back to patch `dumpPuzzleForBench()` in `main-world.js`.

## MV3 hardening contract

- `background.js`'s `onMessage` listener rejects anything where `sender.id !== chrome.runtime.id` and gates `execMain` `funcName` against `EXEC_MAIN_ALLOWLIST` (20 entries). The TS-side mirror is `MainWorldFn` in `globals.d.ts`; keep them in sync.
- `callMainWorld` has a 15s wall-clock timeout via `Promise.race` — if the SW dies mid-call, the caller resolves `null` instead of hanging.
- `execMain` targets `sender.tab.id`, not the active tab — handles tab-switch mid-call.
- `manifest.json` permissions list is minimal (`scripting` only). Don't add `activeTab` / `storage` back without a concrete need.

## Tests and benches

- `npm test` runs the `node:test` suite under `tests/`. `npm run lint`, `npm run typecheck` are gated in CI.
- `tests/fixtures/puzzles.js` — small deterministic puzzles with golden snapshots in `tests/golden.js`. Regenerate via `npm run capture`.
- `tests/fixtures/real-puzzles.js` — full-size puzzles captured from puzzles-mobile.com via the widget's **📋 Dump** button. Used by `tests/bench-real.js` only.
- `tests/solveline.test.js` — brute-force cross-check of `solveLine`. Two fuzz tests: small (N≤3) and large (N=4..7, exercises the bitmap fast-path).
- Bench scripts (`tests/bench.js`, `bench-galaxies.js`, `bench-aquarium.js`, `bench-real.js`) discard 2 warmup iterations. `bench-galaxies.js`, `bench-aquarium.js`, and `bench-real.js` `process.exit(1)` on unsolved puzzles; `bench.js`'s synthetic nonogram is intentionally ambiguous so `solved=false` is expected and it does not exit non-zero.
- Comparing perf vs a prior revision: `jj file show -r <change-id> solver.js > /tmp/solver-baseline.js`, swap into place, run bench, swap back.
- Nightly CI workflow (`.github/workflows/bench-nightly.yml`) runs all four; no `continue-on-error`.

## Things explicitly removed (don't reintroduce)

- `utils.js` (held `PUZZLE_SELECTORS` used only by the never-registered `genericHandler`).
- `genericHandler` in `handler.js` (catch-all that was never registered).
- `solveLineValid` in `NonogramSolver` (merged into `solveLine`'s single forward+backward pass).
- `console.log` debug breadcrumbs from `AquariumSolver.solve` and the galaxies hint failure path.
- `setStatusHtml(html, type)` + `hintStatusText` — replaced by `setStatusNodes` + `hintStatusNodes`.
- `clone()` and `isContradiction()` in `NonogramSolver` (replaced by trail-based undo + bool return from `propagate`).
- `AquariumSolver._solveMinConflicts` — random-restart heuristic from an earlier solver iteration; never called.
- `solveLine` N>31 fallback scan — the bitmap path is the only path now (real puzzles cap at N≈12).
- `sendToContent` action in `background.js` — was unused.
- `syncGameTimerForCheck` top-level in `main-world.js` — closure is lost when serialized to MAIN world; inlined as nested `syncTimer` in each caller.
- `tests/snapshots/` directory + its eslint ignore — dead infrastructure.
