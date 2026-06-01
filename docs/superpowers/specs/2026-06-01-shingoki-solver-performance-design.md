# Shingoki solver performance (large boards) — design

**Status:** approved (brainstorm)
**Date:** 2026-06-01
**Builds on:** the base Shingoki feature + the deductive-hint feature
(`docs/superpowers/specs/2026-05-30-shingoki-design.md`,
`docs/superpowers/specs/2026-05-31-shingoki-deductive-hint-design.md`).

## Summary

`ShingokiSolver.solve()` times out (30 s) on a real 40×40 monthly board.
Strengthen the solver — propagation-first, measure-driven — so real large
boards fully solve in a few seconds. All work is inside the existing
`ShingokiSolver`; no widget/handler/bundler changes. CDCL is explicitly out of
scope unless the planned layers prove insufficient.

## Measured diagnosis (real 40×40 monthly, captured via Dump)

- 21% of vertices clued (346/1681) — genuinely sparse, as real Shingoki are.
- Pure `_propagate()` from empty determines only **52/3280 edges (~1.6%)**;
  `+1` lookahead round reaches **106 (~3%)**.
- `solve()` then drops into plain DFS over ~3,100 undetermined edges with
  **full-array snapshots per branch** and the single-loop constraint checked
  **only at a complete leaf** → exponential blow-up → 30 s timeout.
- For contrast: `getStepwiseHint` (deductive Hint) on the same board is fast
  (~7 ms, 39 edges) — Hint is NOT the problem; `solve()` is.

## Goal

The captured 40×40 monthly (and comparable real puzzles) solve **fully** within
the worker budget — target a few seconds, the honest bar for "works on large
boards." Full solve is the target; a partial-on-timeout fallback is OUT of scope
for this effort (the solver keeps returning
`{solved:false, error:'time limit exceeded'}` on the rare board it can't crack).

## Approach: four layers, measure-and-stop

Strengthen the solver in layers, re-measuring on the real 40×40 after each, and
**stop as soon as it's under budget** (YAGNI). Expected order of payoff:

### Layer 1 — Trail-based undo
Replace per-branch `this.H = snapshot.map(row => row.slice())` (O(edges)
allocation per node — the dominant cost at 40×40) with a change-trail:
`setEdge` records `{ref, prevValue}`; search records the trail length before
branching and rolls back by popping to that mark (O(changes), zero allocation).
Mirrors `NonogramSolver._set/_rollback` and `GalaxiesSolver`. `_propagate`'s
internal `trySet` already routes through `setEdge`, so propagation forces are
captured too. **Pure perf; behavior identical** (existing suite + fuzz prove it).

### Layer 2 — In-search connectivity pruning (centerpiece)
After each branch's propagation, prune states whose committed LINE edges can
never close into a single loop:
- **Premature subloop:** line edges already form a closed cycle while line edges
  or clued-but-unsatisfied vertices remain OUTSIDE it → dead. (The base
  feature's `_hasPrematureLoop` idea, but run DURING search, not just at the
  leaf — the Pipes lesson applied to Shingoki.)
- **Open-endpoint reachability:** a partial chain whose open endpoints cannot
  reach a still-required vertex (a clued vertex cut off behind crosses) → dead.
  Bounded BFS over non-crossed edges, gated on cheap signals so it doesn't
  dominate.
Both are **sound** — they only prune states with no valid completion.

### Layer 3 — Stronger number propagation (reachability)
Add to `_propagate`: **max-reach** forcing. For a clued vertex, the maximum
achievable straight run in a direction = confirmed lines + reachable unknowns
until a cross/border. If max-reach on the only viable axis < the clue number →
contradiction; if a direction must contribute and its minimum forces specific
edges → force them. (This is the rule the deductive-hint spec deferred to
lookahead; promoting it to real propagation speeds solve AND strengthens Hint.)

### Layer 4 — Branching order
When propagation stalls, branch on the most-constrained unknown edge (incident
to a clued vertex or adjacent to a committed line) rather than scan order.
Cheap MRV-style heuristic; cuts search depth.

**Side benefit:** Layers 2–3 live in `_propagate`/the search, which
`getStepwiseHint` also calls, so Hint's deductive reach grows for free.

## Files

- `src/solvers/shingoki.js` — all four layers.
- `tests/fixtures/real-puzzles.js` — add the captured 40×40 monthly board
  (matching the file's existing format) as the benchmark fixture.
- `tests/shingoki.test.js` — per-layer unit tests (prunes/forcing).
- A bench (mirroring `tests/bench-real.js`) + a bounded CI perf test on the
  40×40.

No changes to `main-world.js`, `handler.js`, the widget, bundlers, or manifest.

## Testing & measurement protocol

**Measurement (drives the effort):**
- Bench script solves the real 40×40, prints wall-clock + solved. Run after
  EACH layer; record the number.
- **Stop rule:** once the 40×40 solves in a few seconds, skip remaining layers
  and report which were needed.
- If still over budget after all four layers → that's the signal CDCL is
  genuinely required; STOP and escalate as a separate decision, do not expand
  scope silently.

**Correctness (the non-negotiable gate):**
- Layer 1: solve() result identical before/after (existing suite covers it;
  trail-undo is behavior-preserving).
- Layer 2: unit tests — a premature-subloop state IS pruned; a valid in-progress
  state is NOT pruned (soundness both ways); a cut-off-clue state IS pruned.
- Layer 3: unit tests — max-reach < clue forces alternative / contradiction;
  does NOT fire when ambiguous.
- **Constructive fuzz (5×5/8×8/10×10) stays green after EVERY layer** — master
  soundness guard; any unsound prune/force breaks it instantly.
- The 40×40 bench asserts `solved === true` AND `numbersSatisfied()` on the
  output (a fast wrong answer is a failure, not a win).
- Bounded CI perf test ("40×40 solves under N seconds") so the gain can't
  silently regress (matches the repo's nightly bench pattern).

**Execution:** subagent-driven, each layer gets two-stage review — spec
compliance + a rigorous ADVERSARIAL soundness review (reviewer tries to
construct a state where a prune/force is wrong) — plus fuzz + the 40×40 bench as
objective gates.

## Out of scope (YAGNI)

- CDCL / clause learning (only if layers 1–4 are insufficient — separate spec).
- Partial-on-timeout return (full solve is the target).
- Any widget/page-interaction/bundler change.
- Optimizing `getStepwiseHint` further (already fast on the real board; it
  benefits incidentally from layers 2–3).
