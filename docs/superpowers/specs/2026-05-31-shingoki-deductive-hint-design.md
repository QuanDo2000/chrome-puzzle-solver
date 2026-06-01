# Shingoki deductive Hint — design

**Status:** approved (brainstorm)
**Date:** 2026-05-31
**Builds on:** `docs/superpowers/specs/2026-05-31-shingoki-design.md` (the base Shingoki feature)

## Summary

Make Shingoki's **Hint** (and **Loop**) reveal the next edge that *pure logic*
forces from the current board, instead of revealing the next correct edge from
the cached full solution. When logic is exhausted, silently fall back to the
existing solution-diff hint so Hint/Loop always work. This is a **solver-side**
addition that reuses the existing widget/hint plumbing — no page-interaction,
manifest, bundler, or handler changes.

## Motivation & measured starting point

A solution-based hint spoils; a deduction-based hint teaches. But the current
`ShingokiSolver._propagate` only has degree + white/black **shape** rules, which
fire off *existing* lines/crosses. Measured on the captured 5×5 from an empty
board: **propagation determines 0 of 60 edges, and 1-step lookahead forces 0.**
The solver finds answers by backtracking search, not human-style logic. So a
deductive hint requires adding the missing **clue/number** propagation rules.

## Decisions (from brainstorming)

- **No prose reasons.** Hint highlights the forced edge(s) with a generic status
  ("Reveal N edges"), like Slitherlink. Each rule has an internal name we could
  surface later, but per-edge sentences are out of scope.
- **Depth: propagation + 1-step lookahead, then fall back.** Implement the
  clue/number rules + the existing degree/shape rules, plus one level of
  try-an-edge lookahead. No multi-step search for hints.
- **Silent fallback.** When logic forces nothing, reveal the next correct
  edge(s) from the cached solution exactly as today — no visible difference.
- **Both Hint and Loop use it.** Loop calls the same dispatch each step, so it
  plays out by deduction and falls back only when stuck. One code path.

## Architecture

Entirely solver-side + a small widget dispatch change.

**New core:** `ShingokiSolver.getStepwiseHint(curH, curV)` — modeled on
`SlitherlinkSolver.getHint(curH, curV)`:
1. Seed a probe `ShingokiSolver` from the live board edge state
   (`{horizontal, vertical}`, 0/1/2). The probe sets `_startedAt = Date.now()`
   so the inherited `maxMs` doesn't fire spuriously.
2. `_propagate()` to fixpoint.
3. If no new LINE edges resulted, run ONE round of 1-step lookahead.
4. Collect newly-forced LINE edges (board was 0, now 1) up to
   `batchCap = max(4, ceil(rows*cols/30))` (the documented Loop-batch scaling).
5. Return `{ edges: [{orientation:'h'|'v', r, c}] }` if ≥1, else `null`.

**Purity:** operates on a probe copy; never mutates the caller's arrays. Only
LINE edges are surfaced (forced crosses aid deduction internally but the board /
Loop only act on lines).

**Widget integration** (`src/widget/puzzles/shingoki.js hintDispatch`): mirror
Slitherlink — instantiate a `ShingokiSolver` from the detected task + live edge
state, call `getStepwiseHint`. If it returns edges, return
`{ success: true, hint: { type:'shingoki', edges } }`. If `null`, fall through
to the EXISTING solution-diff code (reveal next correct edge from
`puzzleData.solution`). Loop already calls `hintDispatch` each step, so it
inherits the behavior. `applyHintToGrid` + `applyHint` already merge
`{ edges }`, so the apply path is unchanged.

**Files:**
- `src/solvers/shingoki.js` — new clue/number propagation rules + 1-step
  lookahead helper + `getStepwiseHint`.
- `src/widget/puzzles/shingoki.js` — `hintDispatch` tries deduction first,
  falls back to solution-diff.
- `tests/shingoki.test.js` / `tests/puzzle-modules.test.js` — per-rule + hint
  tests.

No changes to `main-world.js`, `handler.js`, `background.js`, `globals.d.ts`,
the bundlers, or `manifest.json`.

## Deduction rules

All rules are **sound** — they only force a value when the alternative provably
violates a constraint. The constructive fuzz breaks immediately if any rule is
unsound.

**Existing (keep):**
- Degree: every vertex 0 or 2 lines; 2 lines ⇒ cross the rest; 1 line + 1
  unknown ⇒ force the unknown to line; degree-1 dead-end ⇒ contradiction.
- White shape: the two loop edges collinear (straight). Black shape:
  perpendicular (turn). Circled vertex must reach degree 2.

**New — number/run propagation** (the missing piece; fires off the clue number
= sum of the two straight runs in edges):
1. **Run-cap.** Walking out from a clue along a determined straight arm, if the
   confirmed line-run already equals the clue number, force a CROSS at the next
   edge in that direction.
2. **Run-floor / reachability.** If the maximum possible run on a direction
   (line + unknown until a forced cross or border) cannot reach the clue's
   number, that geometry is impossible — force the alternative, or report
   contradiction.
3. **Border/opening rules** (special cases of #2 that fire on a fresh board):
   - White circle on the top/bottom row ⇒ must run HORIZONTALLY; on the
     left/right column ⇒ VERTICALLY. Corner white ⇒ contradiction.
   - A number larger than the space available in a direction bounds that arm,
     often forcing the perpendicular split or specific arm lengths.
4. **Black arm-length split.** A black clue's number splits across its two
   perpendicular arms; when one arm is bounded by a border/cross, the other
   arm's minimum length is forced ⇒ force those line edges.

**Then 1-step lookahead.** For each unknown edge, tentatively set LINE,
propagate; if contradiction, force CROSS (and symmetrically). One level only,
per Hint click (Slitherlink's `_depth = 1` analogue).

## Hint contract

`getStepwiseHint(curH, curV)`:
- Input: live board edge state `{horizontal, vertical}` (0/1/2).
- Output: `{ edges: [{orientation:'h'|'v', r, c}] }` with ≥1 LINE edge, or
  `null` when logic forces nothing new.
- Pure (probe copy); never mutates caller arrays.

`hintDispatch`:
```
const hint = solver.getStepwiseHint(board.horizontal, board.vertical);
if (hint && hint.edges.length) return { success:true, hint:{ type:'shingoki', edges: hint.edges }, ... };
// else: existing solution-diff fallback (unchanged)
```

## Performance

Propagation is O(edges) per fixpoint; 1-step lookahead is O(edges × propagate)
per click — Slitherlink runs the same shape at 30×30 fine. Bound lookahead with
the inherited `maxMs` (probe sets `_startedAt`) so a click can't hang. Measure
on the captured 5×5 and a synthetic large board; if lookahead is too slow, gate
it tighter (measure-first).

## Testing

- **Per-rule unit tests**: each new number/border rule forces the correct edge
  on a hand-built position, AND does NOT fire when the move is ambiguous
  (soundness both ways).
- **`getStepwiseHint` tests**: on the captured 5×5 from an empty board, returns
  a non-empty batch whose every edge matches the known solution; on a complete
  board returns `null`; never mutates the input arrays.
- **Full deductive-solve test**: repeatedly apply `getStepwiseHint` from empty
  until `null`; assert all accumulated edges are correct, and record how far
  pure logic reaches (documents engine power; not asserted to be 100%).
- **Fallback test**: a state where logic is exhausted → `hintDispatch` returns
  solution-diff edges, never throws.
- **Existing constructive fuzz** stays green (unsound rule ⇒ immediate break).
- **Existing hint-batch + apply-merge regressions** cover the Loop path.

## Error handling

If the probe throws or times out, `getStepwiseHint` returns `null` → silent
fallback to solution edges. Hint/Loop never break.

## Out of scope (YAGNI)

- Per-edge worded reasons (decided against; internal rule names only).
- Multi-step search for hints (1-step lookahead only).
- Any change to the solving `solve()` path, page interaction, or bundlers.
- Distinct "this is a guess" status on fallback (silent fallback chosen).
