# Stronger Nurikabe solver — design

Date: 2026-05-25
Status: approved

Adds three new propagation rules and a smarter branching heuristic to
`NurikabeSolver`, targeting the 20×20 monthly puzzles that the current
solver cannot finish within the 30 s worker budget. The current solver
determines about 150 / 320 cells on the May 25 monthly via propagation
and then stalls in backtracking. The new rules push propagation
further so backtracking has materially fewer branching points.

## 1. Goal

- Solve all monthly Nurikabe puzzles on puzzles-mobile.com inside the
  existing 30 s worker budget.
- Stay within the existing `NurikabeSolver` class — no new files, no
  SAT/CDCL machinery.
- Preserve the rule soundness invariants already established by the
  fuzz suite (`tests/nurikabe-fuzz.test.js`).

## 2. Reference puzzle

The 20×20 monthly captured 2026-05-25 (saved as
`nurikabe20x20MonthlyReal` once committed). With the current solver:

- Propagation reaches 150 / 320 cells in ~1 s.
- Backtracking does not finish in 5 minutes.
- The hard clues are 12, 7, 13, and a number of size 3-4 clues
  clustered around the cross-shaped board.

Acceptance test: this puzzle must solve in ≤ 30 s wall time.

## 3. New rules

### 3.1 `_applyFrontierForce`

For each clue `C` with white-component size `S < N`, walk the
component (BFS through `cellStatus === 2`, blocked by BLACK, walls,
other clue cells, and cells claimed by other clues via `_claimedBy`),
collecting the **frontier**: UNKNOWN cells orthogonally adjacent to
any member, excluding cells claimed by other clues.

- `frontier.length === 0` → contradiction (the island cannot grow).
- `frontier.length === 1` → the single frontier cell must be WHITE.
- otherwise → no inference.

Composes with the existing `_buildClaimedBy` pre-pass; runs once per
propagate iteration.

### 3.2 `_applySeaArticulation`

UNKNOWN cells whose removal from the `{BLACK ∪ UNKNOWN} \ walls` graph
would split the current BLACK cells into more than one component must
be BLACK.

Algorithm (iterative Tarjan, mirrors `YinYangSolver._applyCut`):

1. Build the implicit graph on `{BLACK ∪ UNKNOWN}` cells, skipping
   walls. Root the DFS at any currently-BLACK cell. If no BLACK cells
   exist, return immediately.
2. Iterative DFS computes `disc[]` and `low[]`. UNKNOWN cell `u` is an
   articulation point if some DFS child `v` has `low[v] >= disc[u]`.
3. For each articulation UNKNOWN `u`, verify the cut actually strands
   a BLACK component: if removing `u` leaves BLACK cells in different
   components, force `u` BLACK via `_set`.

Gating:

- Skip when `_inLookahead` (matches the existing
  `_applySeaConnectivity` guard — keeps per-cell probes cheap).
- Tracks a `_dirtySea` boolean: set to true whenever `_set(i, 1)`
  fires. Cleared when this rule runs without finding any cell to
  force. Lets a stable fixpoint short-circuit the rule.

Cost: O(N) per call.

### 3.3 `_applyShapeEnumeration`

For each clue, enumerate the valid island shapes given the current
state and intersect to force per-clue inferences.

**Per-clue procedure** for clue `C` with target `N`:

1. Compute current members `M` (size `S`) and the local search domain:
   cells reachable from `M` through `{WHITE ∪ UNKNOWN}`, blocked by
   BLACK, walls, other clue cells, and cells claimed by other clues.
2. DFS-enumerate every connected superset of `M` of size exactly `N`
   inside the search domain. The enumeration grows the candidate
   shape by popping a frontier cell, recursing, and rolling back.
3. Validate each candidate against:
   - **No-merge**: no UNKNOWN cell *in* the candidate shape is
     orthogonally adjacent to a WHITE cell claimed by another clue.
     (If it were, marking the candidate cell WHITE would extend this
     clue's island into the other clue's component.)
   - **2×2 forced-BLACK avoidance**: the UNKNOWN cells orthogonally
     adjacent to the shape but not in it are forced BLACK by clue
     isolation; that set, unioned with the current BLACK cells and
     walls, must not contain a 2×2 all-black block.
4. Survivors update per-cell counters:
   - `inAny[i]` ← 1 if at least one shape includes `i`.
   - `inAll[i]` ← 1 if every shape includes `i`.
5. Apply forcings for clue `C`:
   - `inAll[i] && cellStatus[i] === 0` → `_set(i, 2)` (WHITE).

Per-clue exclusion sets `excludedFrom[C][i]` (cells in `C`'s reach but
absent from `inAny`) accumulate. After all clues are enumerated:

- For each UNKNOWN cell `i`: if `i` is excluded from every clue whose
  reach contains it, `_set(i, 1)` (BLACK). This generalizes
  `_applyUnreachable`, which approximates reach by Manhattan distance.

**Caps** (constants in the rule):

- `MAX_SHAPES_PER_CLUE = 2000`. If hit, abort enumeration for this
  clue this pass (no inference). Record in a debug-only counter for
  future tuning.
- `MAX_ENUMERATED_CLUE_SIZE = 12`. Skip clues with `N > 12`; their
  enumeration explodes and the cheaper rules cover them.
- Check `_timeUp()` between shape candidates; abort gracefully if
  the wall budget elapses mid-enumeration.

**Gating**:

- Runs only at `_depth === 0 && !_inLookahead`, after all cheaper
  propagation rules reach fixpoint and before `_applyLookahead`.
- In `getHint`, runs as the last rule, after the cheaper rules and
  the frontier/cut additions but before single-cell lookahead probe.
- Per-clue dirty bit `_dirtyShape[k]`: if no cell within clue `k`'s
  reach changed since the last enumeration pass for `k`, skip
  enumeration for that clue (same answer would result).

**Cost estimate**: 20×20 monthly with ~20 candidate clues averaging
~50 surviving shapes each → ~1000 shape validations × ~20 cells per
shape ≈ 20 000 ops per full enumeration pass. Single-digit
milliseconds. Cap guards against pathological cases.

**Implementation**: iterative DFS using an explicit stack to avoid
recursion-limit issues on the largest clues. Frontier maintained as
a sparse array of UNKNOWN cells adjacent to the current shape, with
membership tracked in a `Uint8Array` to deduplicate.

## 4. Smarter branching — `_pickBestUnknown`

Replace the existing "count known neighbors" score with a composite:

| Component | Bonus | Rationale |
| --- | --- | --- |
| Known/wall 4-neighbor | +1 each | original heuristic |
| In exactly one clue's BFS-reach | +3 | branching here pins the cell's island assignment |
| In reach of the clue with smallest `N - S` | +5 | finishing nearly-complete islands cascades hard |
| Adjacent to any cell in some clue's white component | +2 | locks the next ring of context |

Pick max score; tie-break by lowest index. Value ordering stays
`[BLACK, WHITE]` — already biases toward fail-fast on dense puzzles.

All inputs reuse `_bfsReachable`, `_claimedBy`, and the clue list
already populated by the previous fixpoint. Cost: O(N · numClues)
per call (numClues is small).

## 5. `_propagate` order

```
_propagate():
  fixpoint:
    _applyClueAdjacency
    _buildClaimedBy
    _applyIslandMerge
    _applyFrontierForce          ← NEW
    _applyUnreachable
    _applyIslandComplete
    _apply2x2
    _applySeaConnectivity
    _applySeaArticulation        ← NEW
    _applyBlackCount
  if (_depth === 0 && !_inLookahead):
    _applyShapeEnumeration       ← NEW
    _applyLookahead
```

`_applyShapeEnumeration` runs before `_applyLookahead` because its
forcings reduce the per-cell probe count.

`getHint` mirrors the order: cheaper rules first, then frontier, then
cut, then shape enumeration, then a single lookahead probe.

## 6. Internal state additions

Inside the constructor:

- `_dirtySea: boolean = true` — set by `_set(i, 1)`, cleared at the
  start of `_applySeaArticulation` on a no-op pass.
- `_dirtyShape: boolean = true` — coarse "any cell changed since the
  last shape-enumeration pass" flag. Set by `_set`, cleared by
  `_applyShapeEnumeration` on entry after capturing the current
  state. Avoids re-enumerating when called twice in a row with no
  intervening change (e.g., across a no-op lookahead probe). Per-clue
  granularity is YAGNI — the coarse bit is enough to prevent the
  obvious redundancy, and re-enumeration is bounded by `MAX_SHAPES_PER_CLUE`.
- `_shapeMembers: Uint8Array(N)` and `_shapeFrontier: Int32Array(N)`
  scratch buffers for shape DFS.
- `_inAny: Uint8Array(N)`, `_inAll: Uint8Array(N)` per-clue counters,
  reused across clues (filled per call).
- `_excludedFromAny: Uint8Array(N)` — counter of clues whose reach
  contains the cell but whose enumerated shapes all exclude it.
  Compared against `_reachCount[i]` (computed alongside reach):
  equality means the cell is in no valid shape of any reaching clue
  → BLACK.

## 7. Tests

### 7.1 Per-rule unit tests (`tests/nurikabe.test.js`)

- `_applyFrontierForce`:
  - 1×3 with clue 2 at (0,0) and BLACK at (0,2): frontier is `{(0,1)}`
    → forced WHITE.
  - 1×3 with clue 2 at (0,0), BLACK at (0,1): frontier empty,
    `size < N` → contradiction.
- `_applySeaArticulation`:
  - 1×3 with BLACKs at (0,0) and (0,2), UNKNOWN at (0,1): articulation
    → forced BLACK.
  - 1×3 with single BLACK at (0,0): no articulation, returns true.
- `_applyShapeEnumeration`:
  - 2×2 with clue 2 at (0,0): two valid shapes `{(0,0),(0,1)}` and
    `{(0,0),(1,0)}`. The common cell (0,0) is the clue (already
    WHITE); no further forcing. Negative test asserts the rule does
    not mis-force when shapes diverge.
  - 1×3 with clue 3 at (0,0): single valid shape `{(0,0),(0,1),(0,2)}`
    → all three cells WHITE.
  - 2×3 with clue 3 at (0,0) and BLACK at (0,2): two shapes
    `{(0,0),(0,1),(1,0)}` and `{(0,0),(0,1),(1,1)}`. Both include
    (0,1) → (0,1) forced WHITE.

### 7.2 Integration test (`tests/solver.test.js`)

- Add `nurikabe20x20Monthly` to `tests/fixtures/puzzles.js` with
  matching real-fixture `nurikabe20x20MonthlyReal` in
  `tests/fixtures/real-puzzles.js`.
- Assert solver returns `solved: true` within 30 s and the grid is
  valid against all four Nurikabe rules.

### 7.3 Fuzz (`tests/nurikabe-fuzz.test.js`)

No changes required — existing fuzz validates rule soundness against
random valid boards. The new rules are sound by construction, so the
fuzz remains the safety net.

### 7.4 Bench (`tests/bench-nurikabe.js`)

Append a `nurikabe20x20MonthlyReal` bench entry to track regressions
on the hard case. Nightly CI step unchanged (already includes the
bench script).

## 8. Performance budget

| Stage | Per-pass cost (target) | Where it runs |
| --- | --- | --- |
| `_applyFrontierForce` | < 0.5 ms | every fixpoint iter |
| `_applySeaArticulation` | < 1 ms (with dirty bit) | every fixpoint iter outside lookahead |
| `_applyShapeEnumeration` | < 50 ms (single pass) | depth 0 only |
| `_pickBestUnknown` | < 0.1 ms | per backtrack node |

20×20 monthly target breakdown: ≤ 2 s of propagation (10× more than
today, mostly shape enumeration), ≤ 20 s of backtracking after the
new heuristic narrows the search.

## 9. Caches

No new caches. The existing `_solutionCache` (50-entry LRU keyed on
`task` bytes) and `_partialCache` cover repeated solves. Shape
enumeration is recomputed each call but is bounded by the caps in
§3.3.

## 10. Out of scope

- CDCL / VSIDS / restart machinery (rejected during scoping).
- Multi-step lookahead deeper than the existing one-step.
- Persisted clue-shape catalogs across solver instances.
- Re-running shape enumeration inside backtracking (only at depth 0).

End of design.
