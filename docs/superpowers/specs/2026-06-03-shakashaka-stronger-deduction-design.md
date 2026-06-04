# Shakashaka stronger deduction — design

**Status:** approved (brainstorm)
**Date:** 2026-06-03
**Builds on:** the base Shakashaka solver
(`docs/superpowers/specs/2026-06-03-shakashaka-design.md`, shipped) and the
Shingoki two-tier deduction architecture
(`docs/superpowers/specs/2026-06-02-shingoki-stronger-deduction-design.md`).

## Summary

Strengthen `ShakashakaSolver`'s deduction so it solves more boards and produces
far stronger partials. Replace the current conservative propagation (which only
prunes when a cell's whole neighbourhood is already decided — ~0% reach from an
empty board) with a two-tier engine: **GAC arc-consistency** (cheap Tier-1) +
**bifurcation 1-ply probing** (heavy Tier-2), run to a joint fixpoint by a
`_deduceAll` driver. The ported `hasNonRect`/`taskMarkedCount` are the
ground-truth validity oracle; a brute-force cross-check gates soundness.

## Why (measured)

The base solver's `_consistent` flags a value impossible only when the cell's
full 3×3 neighbourhood is decided, so from an empty board it determines almost
nothing and falls into a huge search. On the real 25×25 it returns a sound
partial (~95/518, mostly via blind search) and times out. Measured reach of the
candidate techniques on the 25×25:

| Technique | reach | note |
| --- | --- | --- |
| current conservative propagation | ~0% (pure) | the 95 came from search |
| **GAC** (arc-consistency) | **~8%** | ~15 ms |
| **GAC + bifurcation** | **~23%** | ~8 s, triples GAC |
| GAC + search | times out | 7.2M nodes / 60 s |

## Honest expectation (read first)

This is the Shingoki situation: Shakashaka's local edge-matching + sparse clues
determine little by deduction, and the residual search is astronomical. Pushing
hard on Shingoki reached 15×15, never the 25×25/40×40. Shakashaka's 25×25 looks
at least as hard (23% reach + a 7M-node search explosion). So:

- **Small / medium boards** (the real 5×5; likely up to ~12–15) become solvable.
- **The 25×25 very likely stays a much-better partial** (~23%+, vs the weak
  current partial), NOT a full solve.
- This is still a real win: stronger partials, a wider solvable range, and far
  stronger Hint/Loop. Measure-and-stop at diminishing returns; do not pre-promise
  a 25×25 full solve.

## Architecture (mirrors Shingoki's two-tier)

All in `src/solvers/shakashaka.js`. A `_deduceAll(budget)` driver replaces the
direct `_propagate` calls in `solve()`/the search and in the Hint path:

- **Tier-1 — GAC (`_gacPropagate`)**, cheap, always-on. For each open cell X and
  candidate value v in its domain, prune v if **either**:
  1. No assignment of X's still-open *read-neighbours* (from their current
     domains) makes `_hasNonRectAt(X, v)` pass — bounded enumeration of the
     neighbours the predicate actually reads (≤4 for a triangle; the 4 corner
     triples for white), with a small cap so it stays cheap (when more neighbours
     than the cap are open, conservatively do NOT prune — sound); **or**
  2. A number clue around X is infeasible (`_clueFeasibleAround`: decided
     triangles already exceed the clue, or the clue is unreachable even if every
     still-open orthogonal neighbour becomes a triangle).
  Returns false on a domain wipeout (contradiction). Runs to fixpoint.
- **Tier-2 — bifurcation (`_bifurcate`)**, heavy, gated. For each *frontier* open
  cell (adjacent to a decided cell) with a non-singleton domain, probe each
  candidate value: clone the domains, pin the value, run `_gacPropagate`; if it
  wipes out, prune that value (it provably leads to contradiction). Cost-gated:
  frontier-only, time-bounded by the deduction deadline, and size-gated off for
  large boards on the interactive Hint path.
- **`_deduceAll(budget)`:** GAC to fixpoint → if changed, repeat; then one
  bifurcation pass; repeat while anything changed. Returns false on contradiction.
  A `budget` deadline bounds the heavy passes (mirrors Shingoki's `_deduceDeadline`).

**Search & partial:** the existing MRV backtracking now calls `_deduceAll` for
propagation at each node. `solve()` captures the root-deduction snapshot; on
`maxMs`/deadline timeout it returns the **sound partial** (determined cells,
UNK elsewhere) — the partial shape already flows through `partialResultArm` and
the UNK-skipping `applyShakashakaState`.

**Hint/Loop:** `hintDispatch`'s `_deduceForced` calls `_deduceAll` (with an
interactive deadline ~800 ms + size-gating of bifurcation) so a single Hint stays
fast while being much stronger; the cached-solution fallback stays as the
last resort. (The Loop over-commit bug is already fixed — `applyHint` writes only
the hint cells.)

**Size-gating + budgets:** like Shingoki — bifurcation is gated by board size /
time so large boards (e.g. the 25×25) run GAC + a bounded bifurcation slice and
return their strong partial in a few seconds, while small/medium boards get the
full treatment and solve.

## Soundness (absolute gate)

The ported `_hasNonRectAt` + `_taskMarkedCount` are ground truth (byte-faithful,
already reviewed). GAC and bifurcation must be **sound**: never prune a value
some valid solution uses, never accept an invalid board, never spurious-UNSAT.
Verified by extending the existing brute-force cross-check harness:

- On many small boards (mixed open/black/numbered), every value GAC/bifurcation
  prunes holds for NO valid solution; every cell `_deduceAll` reports forced
  holds in EVERY valid solution; solver-solved ⟺ brute-force non-empty; any solve
  passes `_isValid`. Thousands of random boards, mutation-tested harness (same
  discipline that found Shingoki sound across ~150k trials).
- The constructive small-board tests stay green.

GAC is sound by construction (only prunes values no completion can use, by
quantifying over neighbour domains). Bifurcation is sound (a value whose full
sound deduction reaches a contradiction is in no solution). The bounded-cap GAC
under-approximates (skips when too many neighbours open) — sound (weaker), not
unsound.

## Files

- `src/solvers/shakashaka.js` — `_gacPropagate`, `_bifurcate`, `_deduceAll`, the
  read-neighbour helpers; `solve()`/search/`_deduceOnly` switch to `_deduceAll`;
  size-gating + deduction deadline.
- `tests/shakashaka.test.js` — extend the brute-force soundness harness to GAC +
  bifurcation + `_deduceAll`; per-technique unit tests; reach measurement.
- `tests/bench-shakashaka.js` — report reach + solve/partial on the real boards
  (5×5, 25×25) and a size ladder.
- `src/widget/puzzles/shakashaka.js` — only if the Hint deadline/size-gate needs a
  knob threaded (mirror Shingoki's hint budget); no behaviour change otherwise.

## Measurement & stop conditions

- Measure reach + solve/wall-time on the real 5×5 and 25×25 (and a constructive
  size ladder) after GAC, then after bifurcation.
- **Stop** when added technique gives no meaningful reach/solve gain (diminishing
  returns), reporting the curve. The 25×25 is expected to remain a strong partial.
- **Soundness wall (absolute):** any rule the brute-force oracle catches pruning a
  valid value / accepting an invalid board is reverted. Soundness beats reach.
- **Interactivity wall:** if Tier-2 makes a single Hint too slow on big boards,
  size-gate/deadline it (Hint runs GAC + a bounded bifurcation slice).

## Out of scope (YAGNI)

- Shakashaka-specific region-rectangle reasoning (approach C) — a *conditional*
  follow-up only if GAC+bifurcation falls short of the medium range; novel and
  harder to make sound, decided separately if reached.
- Guaranteeing a 25×25 full solve (bounded expectation above).
- Any change to other puzzles or shared infra.
- Changing the ported oracle (it is the spec).
