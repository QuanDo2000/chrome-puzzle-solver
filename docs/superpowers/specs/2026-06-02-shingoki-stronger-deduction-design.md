# Shingoki stronger deduction engine — design

**Status:** approved (brainstorm)
**Date:** 2026-06-02
**Builds on:** the adaptive-DFS engine
(`docs/superpowers/specs/2026-06-02-shingoki-adaptive-dfs-design.md`, shipped to
`main` at `262029ef`).

## Summary

Strengthen `ShingokiSolver`'s deduction so it determines far more edges per board
(today's propagation stalls at ~9–16 edges on real 10×10+ boards), shrinking the
search space enough that deduction + the existing DFS solves real hard boards.
Targets the real captured fixtures up to 25×25. New techniques live in the
**shared** propagation pipeline so they upgrade `solve()`, `getStepwiseHint`
(Hint), and Loop together. Measure-driven and soundness-gated: each technique is
verified against a brute-force reference oracle before it ships.

## Why (measured baseline)

Real hard boards ≥10×10 are unsolvable by search alone — the deduction engine
(degree / white-black shape / axis-forcing / weak run-cap) determines only ~9
edges on a real 10×10 before stalling (15×15: ~16), and the residual search
space is astronomical. CDCL, plain DFS, and iterated 1-step lookahead all time
out (see the adaptive-DFS spec's revised success criteria). Real Shingoki are
human-solvable by *deduction*; the current rules barely use the number=run-length
constraint. The fix is to encode the real solving techniques so the loop is
*deduced*, with search only finishing a much smaller residual.

## Goal & honest expectation

**Goal:** the real captured fixtures (7×7 / 10×10 / 15×15 / 25×25 hard) solve in
a few seconds via deduction + DFS; Hint/Loop gain the same deductive reach.

**Honest expectation:** this is research-grade and may not reach 25×25. Every
technique is an independent, sound, shippable improvement to solver + Hint + Loop,
so progress banks at each step regardless of the final ceiling. The post-step
measurement on the real fixtures is the truth, not a hoped-for endpoint.

## Shingoki rules (reference for the techniques)

Single closed loop on a (rows+1)×(cols+1) vertex lattice. A circle's **number** =
the total length (in edges) of the straight segment(s) the loop travels through
that circle:
- **White** circle: loop goes STRAIGHT through (the two arms are collinear, one
  axis). Number = length of the run one way + length the other way, until each
  end turns.
- **Black** circle: loop TURNS (the two arms are perpendicular). Number = the
  straight-run length in arm direction 1 (until it turns) + arm direction 2.

## Techniques (ranked; added in this order, measure-and-stop between each)

1. **Max-reach number forcing.** Per clued vertex, compute the maximum achievable
   straight run in each direction (consecutive non-crossed edges to the border).
   - White: if neither axis can reach the number → contradiction; if only one
     axis can → force that axis (its two edges LINE, the perpendicular pair
     CROSS). If a direction must contribute a minimum run to reach the number
     (because the opposite direction is capped short) → force those LINE edges.
   - Black: each arm is on a distinct axis; if an arm's only viable direction
     can't supply its minimum required length → contradiction / force.
   Cheap (Tier 1, in `_propagate`).

2. **Per-clue candidate-configuration intersection** (heaviest hitter). Factor a
   `clueCandidates(r, c)` helper that enumerates every feasible configuration for
   the clue and filters against the current board:
   - White: axis ∈ {H, V} × split (a, b), a+b = N, a,b ≥ 1 (a = run one way,
     b = the other). Feasible iff all a+b run edges are in-board and not CROSS,
     and each end can turn (the straight-continuation edge past the run end is
     not forced LINE; a perpendicular turn edge is available).
   - Black: 4 turn orientations (which H arm × which V arm) × split (a, b),
     a+b = N. Feasible under the same in-board/not-crossed/turnable checks.
   Intersect the implied edge states over all surviving candidates: an edge LINE
   in EVERY candidate → force LINE; CROSS in every → force CROSS. Zero surviving
   candidates → contradiction. Heavy (Tier 2). Subsumes technique 1, but 1 ships
   first as a cheap always-on rule.

3. **Stronger connectivity.**
   - Open-endpoint reachability: a partial chain's open endpoint must be able to
     reach every still-required (clued, not-yet-on-loop) vertex via non-CROSS
     edges; if a clued vertex is unreachable from the loop's frontier →
     contradiction.
   - Forbidden-closing edge: an unknown edge whose LINE value would close the
     loop while a clued vertex (or another line component) remains outside →
     force CROSS.
   Tier 2 (extends the existing `_deadByConnectivity` from checker to forcer).

4. **Bounded bifurcation as deduction.** Extend the existing 1-step lookahead: for
   a candidate unknown edge, tentatively assign LINE then CROSS and run the full
   Tier1+Tier2 deduction on a probe; if one value yields a contradiction, force
   the other. Cost-gated (only on a bounded set of frontier edges; time-capped).

5. **Loop-parity / region arguments** (only if 1–4 don't reach 25×25). Even-
   crossing parity of the loop across a region boundary constrains unknown
   boundary edges. Deferred unless needed; a separate decision if reached.

## Architecture

Two-tier deduction run to a joint fixpoint, all in `src/solvers/shingoki.js`.

- **Tier 1 (cheap):** the existing `_propagate` rules + technique 1 (max-reach).
  Runs at every search node; fast.
- **Tier 2 (heavy):** `_deduceHeavy()` — techniques 2, 3, 4. A driver
  `_deduceAll()` alternates `_propagate` to fixpoint → one `_deduceHeavy` pass →
  loop while anything changed (mirrors the deleted `_propagateAll` shape:
  propagate + secondary loop). Returns false on any contradiction.
- **`clueCandidates(r, c)`** — the reusable per-clue feasible-configuration model,
  queried by techniques 2–4. One clear unit: *what configurations remain possible
  for this clue, given the board?*

**Three entry points, one engine, different budgets:**
- `solve()` / `_dfs`: full `_deduceAll()` at the root and at search nodes; Tier 2
  gated by depth/time so deep nodes don't re-run the expensive pass needlessly.
- `getStepwiseHint` (Hint/Loop): `_deduceAll()` with a per-call time cap so a
  single Hint stays interactive (well under ~1 s). If Tier 2 is too slow on the
  largest boards, Hint runs Tier 1 + a bounded Tier-2 slice; the solver always
  uses the full pass.

No widget / worker / handler / bundler / manifest changes. `solve()` and
`getStepwiseHint` keep their signatures and call sites. (`solver.js` rebuild via
`npm run build` after editing, per project convention.)

## Verification (centerpiece)

**Brute-force reference oracle (the soundness backbone).** A dead-simple
exhaustive Shingoki solver — enumerate every valid loop on small boards (≤6×6),
optimized for obvious correctness, not speed — added as a test helper.

> **The master invariant for every deductive rule:** on many small random boards,
> from arbitrary partial states, every edge the rule forces to LINE must be LINE
> in EVERY complete solution the brute force enumerates (CROSS likewise); and the
> rule signals contradiction only when the brute force finds zero completions.
> A force some valid solution contradicts = instant red.

This catches the subtle unsoundness the constructive fuzz misses (a rule that
excludes some valid solutions while passing others through on non-unique boards).

**Layered guards (run after every technique):**
- Constructive fuzz (5×5 / 8×8 / 10×10) stays the master no-spurious-UNSAT /
  valid-solve guard.
- Per-rule unit tests: positive (fires and forces the right edges on a hand-built
  board) and negative (does NOT fire when ambiguous).
- Differential vs the brute force on all small boards: the real solver's solution
  is always a loop the brute force confirms valid.
- Reach + solve-time measurement on the real 7×7 / 10×10 / 15×15 / 25×25 fixtures
  — the progress metric, recorded per technique.

## Files

- `src/solvers/shingoki.js` — all new techniques, `clueCandidates`, `_deduceHeavy`,
  `_deduceAll`; `solve()`/`_dfs` and `getStepwiseHint` switch from `_propagate` to
  `_deduceAll` (with their respective budgets).
- `tests/shingoki.test.js` — per-rule unit tests + the brute-force oracle helper +
  the master force-soundness invariant test + differential.
- `tests/shingoki-fuzz.test.js` — unchanged in shape; stays green as the
  master guard.
- `tests/bench-shingoki.js` — reach + solve measurement across the real fixtures
  (extend to print determined-edge counts, not just solved/time).
- `tests/fixtures/real-puzzles.js` — already has the 7×7/10×10/15×15/25×25/40×40
  fixtures; no change unless more captures are added.

## Risk gates (explicit stop conditions)

- **Solved-enough:** the real 25×25 solves in budget → STOP, skip remaining
  techniques (YAGNI).
- **Diminishing returns:** a technique adds no meaningful reach/solve gain on the
  real fixtures → STOP and report the curve (the user decided "push hard," but the
  measurement is surfaced for a call).
- **Soundness wall (absolute):** any rule the brute-force oracle catches forcing a
  wrong edge, or that produces a spurious UNSAT, and that can't be made sound, is
  REVERTED — never shipped. Soundness always beats reach.
- **Interactivity wall:** if Tier-2 makes a single Hint too slow on big boards,
  Hint uses a bounded Tier-2 slice; the solver keeps the full pass.

## Execution

Subagent-driven, one technique per task, in ranked order. Each task: implement →
brute-force-oracle invariant + fuzz + unit tests → spec-compliance review →
adversarial soundness review (reviewer tries to construct a board+state where the
rule forces a wrong edge) → measure reach + solve on the real fixtures → record →
decide if the next technique is still needed. Build the brute-force oracle FIRST
(task 0) so every subsequent technique can be verified against it.

## Out of scope (YAGNI)

- Widget / Hint-UI / Loop-UI / worker / handler / bundler / manifest changes.
- A general CSP-solver rewrite (the layered approach reuses the working
  propagator; a rewrite is higher-risk and non-incremental).
- Loop-parity / region arguments unless techniques 1–4 fall short of 25×25.
- Changing `solve()`/`getStepwiseHint` signatures or call sites.
- Re-introducing CDCL / clause learning (proven the wrong tool).
