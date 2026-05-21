# Auto-Solve on Detect + Live Mistake Highlighting — Design

**Date:** 2026-05-21
**Status:** Approved

## Goal

When a puzzle is detected, automatically solve it in the background and cache
the result so every other feature (Solve, Hint, Loop, Apply) reuses it
instead of re-solving. Additionally, compare the player's current board to
the solution and highlight the cells they have placed incorrectly.

Applies to all six puzzle types: Nonogram, Aquarium, Galaxies, Binairo,
Shikaku, Yin-Yang.

## Background (current behaviour)

- `detectHandler()` in `content.js`: detects the puzzle, sets `puzzleData`,
  enables the buttons, reads the board, draws the preview, starts the
  state-watch. It does **not** solve.
- `solveHandler()`: if `puzzleData.solution` is already set it jumps straight
  to the "Preview ready" confirm step; otherwise it runs the worker solve
  (`runSolve`) and, on success, calls `recordSolveSuccess(result)`.
- `recordSolveSuccess(result)`: sets `puzzleData.solution`, writes the
  localStorage solution caches (`cacheGridSolution`, `cacheGalaxiesSolution`),
  clears partials.
- `runSolve(...)`: posts to the Web Worker, returns a Promise.
- `startStateWatch()`: re-reads the board and redraws the preview roughly
  every 200 ms.
- Hint is per-type: Binairo/Yin-Yang are pure deduction; Nonogram/Aquarium
  deduce then fall back to a full solution; Shikaku solves and reveals a
  rectangle.

So the *reuse* machinery (`puzzleData.solution`, the localStorage caches,
`solveHandler`'s fast path) already exists. The new work is triggering the
solve automatically on detect, bridging the race window, and the diff.

## Approach

Fire-and-forget background solve after Detect (Approach 1 of three
considered; the alternatives — blocking Detect until the solve finishes, or
solving lazily on first feature use — were rejected for contradicting "in
the background" and "Detect should check the board" respectively).

## Section 1 — Auto-solve on Detect

A new `autoSolve()` function in `content.js`. `detectHandler()`, after
finishing its existing UI work, calls `autoSolve()` **without awaiting it**,
so Detect returns to the user instantly.

`autoSolve()`:
1. If `puzzleData.solution` is already set → return.
2. **Cache-first:** check `getCachedGridSolution` / `getCachedGalaxiesSolution`
   (localStorage). On a hit — a puzzle solved on a previous visit — set
   `puzzleData.solution` from it, redraw the preview, return. No worker call.
3. Otherwise run the worker solve via `runSolve(..., initialGrid = null, ...)`.
   `initialGrid = null` is deliberate: solve from the puzzle's givens so the
   result is the *canonical* solution, never biased or broken by the
   player's possibly-incorrect moves.
4. On `result.solved` → `recordSolveSuccess(result)` (sets
   `puzzleData.solution`, writes the caches, clears partials) → redraw the
   preview so mistakes appear.
5. On failure (unsolvable / timeout / error) → silent: `puzzleData.solution`
   stays unset, the diff simply does not show, Solve/Hint still work on
   demand. Logged to console only — a background task must not surface an
   error dialog.

**Staleness guard:** `autoSolve` captures the `puzzleData` object it started
for; if a later Detect has replaced `puzzleData` by the time the worker
resolves, the stale result is discarded (it must not write to the new
`puzzleData`).

`autoSolve` runs on both the Detect button and the page-load auto-detect —
both benefit (background, cached, non-blocking).

## Section 2 — Reuse across features

A `pendingAutoSolve` variable (module/closure scope) holds the in-flight
`autoSolve()` promise, or null when none is running.

Uniform reuse rule: any feature that would solve first checks
`puzzleData.solution`; if it is unset but `pendingAutoSolve` is in flight,
the feature awaits that shared solve rather than starting a duplicate; only
if there is genuinely no solution and none pending does it run its own solve
(the existing on-demand path, kept unchanged as the fallback).

- **Solve** — `solveHandler` already jumps straight to "Preview ready" when
  `puzzleData.solution` is set, so after a successful auto-solve, clicking
  Solve is instant. Add the await-pending bridge for when the user clicks
  Solve before the background solve finishes: show "Solving…", await
  `pendingAutoSolve`, re-check `puzzleData.solution`, then preview.
- **Hint** — keeps its per-type behaviour. The only change: where a Hint
  path already falls back to a full solution, it uses `puzzleData.solution`
  (populated by auto-solve) instead of solving fresh; if the solution is not
  yet available it awaits `pendingAutoSolve`.
- **Loop** — reuses `puzzleData.solution` the same way for its intermediate
  solve.
- **Apply** — already applies `puzzleData.solution`; unchanged.

Net effect: after auto-solve completes, Solve / Hint-fallbacks / Loop are
instant; in the race window they wait on the single shared solve; no feature
ever double-solves. The Solve → "Preview ready" → Confirm → Apply flow is
otherwise unchanged.

## Section 3 — Live mistake highlighting

`drawPreview(grid, hint)` gains a mistake overlay. When `puzzleData.solution`
is set, a pure helper `computePuzzleDiff` (see Section 4) returns the cells
where the player's board disagrees with the solution, and `drawPreview`
draws a red marker on each.

**Per-type diff:**
- **Cell-state puzzles** (Nonogram, Aquarium, Binairo, Yin-Yang) and
  **Galaxies**: direct comparison — a cell is a mistake if it is *placed*
  (non-empty value / assigned region) and its value differs from the
  solution's. Page and solver encodings align for these (Galaxies region ids
  are star-indexed in both the read board and the solution).
- **Shikaku**: owner indices do not align (page draw-order vs solver
  clue-order), so the diff compares **rectangle geometry** — derive each
  cell's rectangle (its owner's bounding box) from the board and from the
  solution, and flag a cell if it is assigned and the two rectangles' corners
  differ.

Only *placed* cells are ever flagged — empty cells are left alone (the
chosen "wrong cells only" behaviour).

**Marker:** a red ring plus a faint red tint on the cell, drawn on top of the
cell's normal fill — distinct from the blue hint highlight, and the two may
appear together without conflict. When the user clicks Solve the preview
shows `puzzleData.solution` itself, so `grid === solution` yields zero
mistakes and no red, naturally.

**Live, for free:** `startStateWatch` already redraws the preview ~5×/sec
from a fresh board read. Because `computePuzzleDiff` runs *inside*
`drawPreview` on every call, the highlighting is automatically live — a
corrected cell clears on the next tick, a new mistake appears. No extra
wiring.

**Status:** when the background solve completes, the post-detect status
notes the count once — e.g. "Found 6×6 Binairo — 2 mistakes" / "— no
mistakes." The red overlay is the live part; the status line is a one-time
note (it is not continuously rewritten by the state-watch, to avoid
clobbering other statuses).

**No solution available:** if auto-solve failed, `puzzleData.solution` is
unset, `drawPreview` skips the diff, no red — graceful.

## Section 4 — Testing

Most of this feature is content-script logic (`detectHandler`, `autoSolve`,
the reuse wiring, `drawPreview`) and depends on `chrome`, the DOM, the
canvas, and async timing — not reachable by the `node:test` suite, which
only loads `solver.js`.

The one pure, intricate piece is extracted and unit-tested:

- **`computePuzzleDiff(type, grid, solution)`** — a pure function added to
  `solver.js` (the "pure logic, no DOM" file the test suite already requires
  and that the content script already loads as a sibling). It returns the
  set of mistake cells; the per-type "empty" sentinel (`-1` for Shikaku, `0`
  otherwise) and comparison rule are selected from `type`, so no extra
  metadata argument is needed. `drawPreview` calls it. Unit tests in
  `tests/solver.test.js`:
  - cell-state diff — a wrongly-placed cell is flagged; a correct cell and an
    empty cell are not;
  - Galaxies region diff;
  - Shikaku geometry diff — a cell in a wrongly-*shaped* rectangle is flagged
    and a cell in a correct rectangle is not, despite page/solver owner
    indices not aligning.

- The auto-solve / reuse / fire-and-forget / staleness-guard wiring is
  content-script + async + `chrome` — not unit-testable. It is covered by a
  **live smoke test** (the acceptance criterion below).

- Existing solver tests, fuzz, and benches stay green — the change is purely
  additive (a new exported pure function plus content-script wiring; the
  solver classes are untouched).

## Acceptance criterion

Load `dist/` in Chrome and, on a real puzzle page:
1. Click Detect — Detect returns immediately; shortly after, the status
   notes the mistake count and (if the board has wrong cells) red highlights
   appear.
2. Click Solve — it jumps straight to the "Preview ready" confirm step with
   no solving wait (the auto-solve result is reused).
3. Deliberately misplace a cell — the red highlight appears within ~200 ms;
   correct it — the highlight clears.
4. On a puzzle the solver cannot crack within budget, Detect and the other
   features still behave normally; no error dialog from the background
   solve.

## Out of scope

- Changing any feature's core behaviour. Hint keeps its per-type deduction
  design; Solve keeps the Preview → Confirm → Apply flow. Auto-solve only
  removes waits and feeds the diff.
- Highlighting empty cells or "verified-correct" cells (the chosen diff
  scope is wrong cells only).
- A continuously-updated status mistake count (the visual overlay is the
  live indicator; the status notes the count once when the solve lands).
