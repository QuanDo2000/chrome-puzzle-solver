# Pipes locked-cell error overlay — design

- **Date:** 2026-06-07
- **Status:** Approved (pending spec review)
- **Scope:** Single feature, one implementation plan.

## Summary

In the widget's preview canvas, ring the **locked (pinned)** pipes cells whose
current rotation produces the **wrong** pipe shape versus the solver's solution.
Errors-only (no marker on correctly-locked cells), live-refreshing as the player
pins / unpins / rotates. Renders in the widget preview thumbnail, not on the live
game board.

## Background

Pipes currently has **no** mistake overlay. `computePuzzleDiff`
(`src/solvers/diff.js`) explicitly returns `[]` for `type === 'pipes'` because:

1. The board stores rotation **counts** (0–3) while the solution stores arm
   **masks** — a naïve per-cell compare lights up every cell.
2. More fundamentally, every pipes cell always has *some* rotation, so there is
   no "the player hasn't committed here" signal (unlike `0 = untouched` in other
   puzzles). Without a commitment signal a full-board diff is meaningless.

The page exposes a per-cell **lock** layer that supplies exactly that missing
commitment signal. Confirmed by live probe of `window.Game`:

- `Game.currentState.pinned[r][c]` — `true` when a cell is locked. Flips to
  `true` at the locked cell; `Game.serializers` includes `serializePinnedState`,
  confirming it is a first-class persisted layer. The page's internal term for
  "locked" is **pinned** (`lastMove.pin: true`).
- `Game.currentState.cellStatus[r][c]` — rotation count (0–3), as already read by
  `readPipesState`.

A locked cell is a genuine player commitment, so scoping error detection to
locked cells is the principled fix for the gap above.

## Design decisions (confirmed with user)

- **Overlay scope:** only **wrong** locked cells. No marker on correctly-locked
  or on unlocked cells.
- **Update trigger:** **live** — recomputed on the preview's existing
  state-watch refresh.
- **Render target:** the **widget preview thumbnail**, reusing the existing
  red-ring mistake rendering. Not the live game board (the page repaints and
  would wipe any overlay, and we do not auto-mutate the page beyond applying
  solutions).

## Correctness notes

- **Compare by resulting mask, not by rotation count.** Rotationally-symmetric
  pieces (straight = period 2, 4-way cross = period 1) match the correct shape at
  more than one count. `puzzleData.solution[r][c]` holds the *smallest* such count
  (`rotationCount` returns the smallest `k`), so a player who locked a straight
  pipe at the equivalent 180° rotation would be falsely flagged by a raw count
  compare. The check is therefore:

  > locked cell `(r,c)` is wrong ⟺ `pinned[r][c]` is set
  > **and** `rotateMask(task[r][c], currentCount) !== rotateMask(task[r][c], solutionCount)`.

- **Rotation direction.** `rotateMask` uses the same `PIPE_PAGE_CW`-selected
  step transform as the existing `rotationCount`, so forward and inverse stay
  consistent with the live page.

- **Degenerate pieces.** A blank cell (`task` mask 0) and a 4-way cross
  (mask 15) are rotation-invariant, so they can never be flagged — correct.

## Components

Five small, isolated pieces:

### 1. `readPipesPinned(rows, cols)` — MAIN-world reader
- New function in `main-world.js`. Returns `currentState.pinned` as a 2D array of
  `0/1` (coerce booleans for clean serialization across the `executeScript`
  boundary). Returns `null` on missing state, mirroring `readPipesState`.
- Register in `background.js` `EXEC_MAIN_ALLOWLIST` and mirror in `globals.d.ts`
  `MainWorldFn` (the two lists must stay in sync).

### 2. `rotateMask(taskMask, count, pageCW)` — rotation helper
- New exported helper in `src/widget/pipes-rotation.js`, beside `rotationCount`.
- Applies the `pageCW`-selected per-step transform (`stepCW`/`stepCCW`) `count`
  times to `taskMask`, returning the resulting 4-bit mask. Factors the same
  `step` logic already inlined in `rotationCount`.

### 3. `lockedMistakes(ctx)` — pipes registry hook
- New hook on the pipes registry object in `src/widget/puzzles/pipes.js` (which
  already requires `pipes-rotation.js`).
- `ctx = { grid, solution, task, pinned }` — `grid` and `solution` are count
  grids; `task` is the scrambled-mask grid; `pinned` is the 0/1 lock grid.
- Returns `[{ row, col }]` for every cell where `pinned[r][c]` is truthy and
  `rotateMask(task[r][c], grid[r][c], PIPE_PAGE_CW) !==
   rotateMask(task[r][c], solution[r][c], PIPE_PAGE_CW)`.
- Pure and dependency-light → unit-testable.

### 4. Live read of `pinned`
- On the preview's live-refresh path (the state-watch handler in
  `src/widget/widget.js`), for `type === 'pipes'` fetch `readPipesPinned` and
  stash the result on `puzzleData.pipesPinned` before `drawPreview`.
- Fetched **only** for pipes and **only** on the refresh path — not inside the
  generic `readGridState`, to avoid doubling MAIN-world calls on every
  apply/loop/undo read.
- A one-frame inconsistency between the counts read and the pinned read is
  harmless for a ~200 ms live overlay.

### 5. Preview render
- In `src/widget/preview.js`'s mistake overlay, add a pipes branch: when
  `type === 'pipes'`, `puzzleData.solution` exists, and `puzzleData.pipesPinned`
  exists, call the pipes registry `lockedMistakes(...)` hook and ring the
  returned `{row, col}` cells with the **existing** generic red ring + fill (the
  same path used by nonogram/heyawake/etc.).
- `computePuzzleDiff` is left untouched (still returns `[]` for pipes).

## Data flow

```
state-watch tick
  → readGridState() ............... current rotation counts (grid)
  → readPipesPinned() ............. pinned 0/1 grid  → puzzleData.pipesPinned
  → drawPreview(grid)
       → mistake overlay (pipes branch)
            → reg.lockedMistakes({ grid, solution: puzzleData.solution,
                                   task: puzzleData.task,
                                   pinned: puzzleData.pipesPinned })
            → red rings on returned cells
```

## Graceful degradation

- No `puzzleData.solution` yet (puzzle not auto-solved, or solver could not
  solve within the autoSolve budget) → no overlay. Same behaviour as every other
  puzzle's mistake overlay.
- No `puzzleData.pipesPinned` yet (first paint before a state-watch tick) → no
  overlay.
- No locked cells, or all locked cells correct → empty result → nothing drawn.

## Testing

- **Unit (`lockedMistakes`)**: wrong-locked flagged; correct-locked not flagged;
  unlocked-but-wrong not flagged; symmetric straight pipe locked at the
  equivalent 180° rotation not flagged; 4-way cross never flagged; blank cell
  never flagged.
- **Unit (`rotateMask`)**: forward rotation matches the page step for both
  `pageCW` values; `rotateMask(task, rotationCount(task, solved, cw), cw) ===
  solved` round-trips.
- MAIN-world reader (`readPipesPinned`) is not unit-tested, consistent with the
  other read functions.
- After implementation, `npm test`, `npm run lint`, `npm run typecheck`, and
  `npm run build` must pass. `main-world.js`/`background.js`/`globals.d.ts` and
  the widget bundle change, so a rebuild is required.

## Files touched

| File | Change |
| --- | --- |
| `main-world.js` | add `readPipesPinned` |
| `background.js` | add `readPipesPinned` to `EXEC_MAIN_ALLOWLIST` |
| `globals.d.ts` | add `readPipesPinned` to `MainWorldFn` |
| `src/widget/pipes-rotation.js` | add + export `rotateMask` |
| `src/widget/puzzles/pipes.js` | add `lockedMistakes` hook |
| `src/widget/widget.js` | live `pinned` read on the state-watch path |
| `src/widget/preview.js` | pipes branch in the mistake overlay |
| `tests/pipes-rotation.test.js` (or new) | `rotateMask` + `lockedMistakes` tests |

## Non-goals / out of scope

- Marking correctly-locked cells, or any non-error lock indicator.
- Flagging wrong **unlocked** cells.
- Rendering on the live game board.
- Any change to the pipes solver, the apply/rotate write path, or Loop/Hint.
- Other puzzle types.
