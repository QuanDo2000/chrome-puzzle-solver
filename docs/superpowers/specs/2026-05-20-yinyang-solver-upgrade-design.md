# Yin-Yang Solver Upgrade — Design

**Date:** 2026-05-20
**Status:** Approved

## Goal

Make `YinYangSolver` fast and strong enough to solve large Yin-Yang puzzles —
specifically the 35×35 weekly special — within a 30-second budget. The current
solver times out on it.

## Problem (from live profiling)

The 35×35 weekly (`/yin-yang/special/weekly`) has 1225 cells, 397 givens.
Profiling `YinYangSolver` on it:

- One `propagate()` takes ~247 ms on the sparse initial board, ~32 ms
  averaged across a solve.
- Propagation alone deduces only 493/1225 cells (40%), leaving ~700 cells for
  backtracking.
- A 15-second solve visited only 475 backtracking nodes and did not finish.

Two compounding causes:

1. **`_applyConnectivity` is O(N²) per sweep.** It loops every empty cell and,
   for each, calls `_colorConnected` (a full BFS) for both colours. This runs
   inside the `propagate()` fixpoint loop, which runs at every backtracking
   node — so the cost compounds badly on a 1225-cell board.
2. **Propagation is too weak.** The two rules (2×2 and the connectivity-cut
   probe) deduce only 40% of a board that is human-solvable (≈100% by logic),
   so backtracking carries far too much of the load.

## Approach

Rewrite `YinYangSolver._applyConnectivity` to be O(N) per sweep and to deduce
more, by replacing the per-empty-cell probe with two sound rules. Keep the 2×2
rule and the overall `propagate()` / `solve()` / `_backtrack()` structure.
Raise the worker's Yin-Yang time budget to 30 s.

The reachability rule is also strictly stronger deduction than the current
solver, so `getHint` (which runs propagation only) improves for free.

## Solver changes (`solver.js`, `YinYangSolver`)

### Rewritten `_applyConnectivity`

For each colour X ∈ {1, 2} (1 = black, 2 = white), against the graph
`G_X = {cells whose value is X or 0 (empty)}` with 4-neighbour adjacency:

**1. Reachability pass.** One BFS of `G_X` starting from a placed-X cell,
recording every cell reached.

- If the colour has ≥2 placed cells and not all placed-X cells are reached →
  contradiction; `_applyConnectivity` returns false. (This subsumes today's
  separate `_colorConnected(color, -1)` contradiction check — the same BFS
  does both.)
- Any **empty** cell not reached can never become X (no path to the X region
  could ever exist) → force it to the other colour, and signal `onChange()`.
- If the colour has 0 placed cells, skip the pass (nothing can be deduced).

Soundness: in any solution an X cell must connect to the rest of X through a
path of X cells; every such cell is currently X or empty, so the path lies
within `G_X`. An empty cell outside the placed-X component of `G_X` therefore
cannot be X.

**2. Cut pass.** Find the articulation points of `G_X` (see below). For each
articulation-point cell that is empty, call the existing
`_colorConnected(X, apIdx)` removal-check; if it returns false (removing that
cell severs the placed-X cells), force that cell to X and signal `onChange()`.

Soundness: if every X-path between two placed-X cells must pass through empty
cell `e`, then `e` must be X.

Ordering within one call does not affect correctness — every individual
deduction is sound on the current grid state, and the `propagate()` fixpoint
loop re-runs `_applyConnectivity` until nothing changes. `_applyConnectivity`
still returns false on any contradiction and calls `onChange()` on every
forced cell, exactly as today.

### Articulation-points DFS

A standard Tarjan articulation-point search over `G_X`:

- Per-cell `disc` (discovery time) and `low` (low-link) arrays.
- A non-root vertex `u` is an articulation point if it has a DFS child `v`
  with `low[v] >= disc[u]`.
- The DFS root is an articulation point if it has ≥2 DFS children.
- Returns the set of articulation-point cells; the cut pass only acts on those
  that are empty.

Implemented as a recursive DFS. Recursion depth is bounded by N (≤1225 for a
35×35 board), well within the Worker's stack limit. Grid graphs are
2-connected, so a real board's `G_X` has few articulation points — the cut
pass stays near-O(N) in practice even though each probed AP costs one
`_colorConnected` call.

### What stays the same

- The 2×2 rule (`_is2x2Illegal`, `_apply2x2`) — unchanged.
- `propagate()` — unchanged structure: fixpoint loop calling `_apply2x2` then
  `_applyConnectivity`, budget check, returns false on contradiction.
- `solve()`, `_backtrack()`, `_pickCell()`, `_isComplete()`, the solution
  cache, `getHint()` — unchanged. `getHint` automatically reveals more cells
  because propagation is stronger.
- `_colorConnected(color, blockIdx)` — unchanged; the cut pass reuses it.
- The constructor, encoding, and public surface — unchanged.

## Worker budget (`solver.worker.js`)

The `yinyang` dispatch arm changes `s.maxMs = 8000` to `s.maxMs = 30000`.
Only the Yin-Yang arm changes; other puzzle types are untouched. The widget
already shows a "Solving..." status during the solve, so no UI work is needed.

## Integration

No other files change. The solver's public API (`solve`, `getHint`,
constructor) is unchanged, so the handler, `content.js`, MAIN-world functions,
and preview keep working as-is.

## Testing

- **35×35 weekly fixture.** Add the captured weekly to
  `tests/fixtures/real-puzzles.js` as a genuine `yinyang` entry, so
  `tests/bench-yinyang.js` picks it up and times it.
- **New `YinYangSolver` unit tests** in `tests/solver.test.js`:
  - the reachability pass forces an unreachable empty cell to the other
    colour;
  - the reachability pass reports a contradiction when a colour's placed
    cells are severed;
  - the articulation-points DFS returns the correct AP set on a small
    hand-built graph;
  - the cut pass still forces the single-bridge case (regression).
- **Existing tests unchanged-green.** All current `YinYangSolver` unit tests
  and `tests/yinyang-fuzz.test.js` must still pass. The new rules are sound,
  so every board the fuzz validator accepts remains valid.
- **Re-profile.** Confirm `propagate()` on the 35×35 drops from ~32 ms to low
  single-digit milliseconds.

## Acceptance criterion

A solver test asserts the 35×35 weekly fixture solves via `solve()` with
`maxMs = 30000`, and that the returned grid is a valid Yin-Yang board (reusing
the validation logic from `yinyang-fuzz.test.js`: fully placed, no illegal
2×2, each colour one connected region, givens respected).

"All unit tests green" is not sufficient — the weekly must demonstrably solve.

## Contingency

If the reachability + AP-filtered-cut rules still leave the weekly short of
solving within 30 s, the documented next lever is the **border-arc rule**:
each colour occupies exactly one contiguous arc of the grid border (a colour
appearing in two separate border segments would force a cross-grid barrier of
the other colour). This is a known-strong Yin-Yang deduction and would be
added as a follow-up. It is recorded here so the contingency is not a
surprise.

## Out of scope

- Search improvements (variable/value ordering, restarts). The bottleneck is
  propagation speed and strength; `_pickCell` and `_backtrack` are left as-is.
- The augmented-Tarjan single-pass cut detection (strict O(N) worst case).
  The AP-filtered probe is fast enough in practice and reuses tested code.
- Graceful "puzzle too large" messaging. The 30 s budget plus the existing
  `{ solved: false, error: 'timed out' }` result is the fallback.
