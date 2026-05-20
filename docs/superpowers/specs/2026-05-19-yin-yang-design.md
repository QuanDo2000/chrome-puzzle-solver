# Yin-Yang Support — Design

**Date:** 2026-05-19
**Status:** Approved
**Target page:** `https://www.puzzles-mobile.com/yin-yang/random/<size>`

## Goal

Add Yin-Yang as the 6th solver class in the Chrome puzzle-solver extension,
with full feature parity to the existing puzzle types: Detect, Solve, Hint,
Loop, Apply, live preview, Dump support, and solution caching.

## Puzzle rules

Yin-Yang is a two-coloring puzzle. Every cell is one of two colors (black or
white). A valid solution satisfies:

1. **Connectivity** — all black cells form one orthogonally-connected region;
   all white cells form one orthogonally-connected region.
2. **2×2 rule** — no 2×2 block of cells may be monochrome (4 of the same
   color) *or* a diagonal checkerboard (the two diagonals being opposite
   colors, BW/WB). The checkerboard is forbidden because the two diagonal
   same-color pairs cannot both connect to the rest of their regions without
   their connecting paths crossing.

Some cells are pre-filled as givens; the solver assigns the rest.

## Page encoding (from live recon)

The page exposes the puzzle on `window.Game`, identical in shape to Binairo:

- `window.Game.task` — 2D array (`puzzleHeight × puzzleWidth`) of **givens**:
  `-1` = no given, `0` = given white, `1` = given black.
- `window.Game.currentState.cellStatus` — 2D array of **current state**:
  `0` = empty, `1` = black, `2` = white.
- Translation givens → cellStatus: `-1→0, 0→2, 1→1`.
- `window.Game.puzzleWidth` / `puzzleHeight` — dimensions.
- Render functions present: `drawCurrentState`, `redraw`, `draw`, `loadGame`,
  `getSaved`, `saveState`, `check`, `check2x2`.

This is byte-for-byte the encoding `BinairoSolver` already uses, so the
integration layer mirrors Binairo. The solver algorithm is new (Binairo's
rules — balance, no-triples, uniqueness — do not apply; connectivity does).

## Architecture

Yin-Yang follows the established puzzle-addition pattern. `puzzleData.type`
is `'yinyang'`.

| File | Change |
| --- | --- |
| `solver.js` | New `YinYangSolver` class; added to `module.exports` |
| `solver.worker.js` | Dispatch arm for `type === 'yinyang'` |
| `main-world.js` | `readYinYangData`, `readYinYangState`, `applyYinYangState` |
| `background.js` | 3 new `EXEC_MAIN_ALLOWLIST` entries (→ 17 total) |
| `globals.d.ts` | Mirror the 3 names in the `MainWorldFn` union |
| `handler.js` | `yinYangHandler` — matches `/yin-yang/`, priority 30 |
| `content.js` | `solveExtraData` arm, `yinYangCacheKey`, `getHint` branch, hint-status nodes, `drawPreview` rendering, `SUPPORTED_PUZZLES` entry |
| `CLAUDE.md` | Yin-Yang encoding subsection |
| `tests/` | `yinyang6x6` fixture + golden, solver tests, `yinyang-fuzz.test.js`, real-puzzle capture, `bench-yinyang.js` |

The Loop done-check needs no special arm — Yin-Yang uses `0` = empty like the
other cell-state puzzles, so the generic "done when no `0`" check works
(unlike Shikaku, which needed a `-1` sentinel).

## YinYangSolver

### Encoding boundary

The constructor takes `{ rows, cols, task }` where `task` is the 2D givens
(`-1/0/1`). It translates givens → internal `cellStatus` encoding at the
boundary (`-1→0` empty, `0→2` white, `1→1` black) and works internally in
`0/1/2`, mirroring `BinairoSolver`. The internal grid is a flat `Uint8Array`.
Undo is trail-based (push/rollback flat triples), matching `NonogramSolver`
and `GalaxiesSolver`.

### propagate()

Iterates two sound rules to a fixpoint. Returns `false` on contradiction,
`true` otherwise.

1. **2×2 rule.** For every 2×2 window, a fully-placed window is illegal if
   monochrome or a diagonal checkerboard. When 3 of the 4 cells are placed,
   eliminate any 4th-cell value that would complete an illegal window:
   0 legal values remaining → contradiction; exactly 1 → force it.

2. **Connectivity-cut probe.** For each color X:
   - BFS the placed-X cells through the graph `{X cells ∪ empty cells}`. If
     they are not all mutually reachable → contradiction.
   - For each empty cell `e`, if removing `e` from that graph disconnects the
     placed-X cells, force `e` to X. (Sound: in any solution the X cells must
     connect, and if every X-path between two X cells runs through `e`, then
     `e` must be X.)

Both rules are **sound but intentionally incomplete** — propagation may stall
before the board is full. Backtracking is the completeness guarantee, as with
the other solvers.

### solve()

1. Translate givens, seed the grid.
2. `propagate()`. If it returns `false`, the puzzle is contradictory.
3. If the grid is full, it is solved.
4. Otherwise **backtrack**: pick the empty cell adjacent to the most
   non-empty cells (keeps the search frontier tight so the connectivity rule
   prunes hard), try black then white with trail undo, `propagate()` after
   each assignment, recurse.

A full grid that passes `propagate()` is a valid solution: on a full grid the
empty set is `∅`, so the connectivity check "placed-X connected through
`{X ∪ empty}`" reduces to "X is connected". No separate completion check is
needed.

Caching: a static `_solutionCache` keyed on an FNV-1a hash of
`(rows, cols, task)`, 50-entry LRU with a 7-day TTL, consistent with the
existing solution caches. An instance-level `maxMs` budget lets the worker
abort a degenerate input instead of hanging; exceeding it returns
`{ solved: false, error: 'timed out' }`.

### getHint(grid)

Clone the solver with the current board as givens, run `propagate()` only
(no backtracking), and return every cell that propagation forced from empty
to placed. This is "all logically-certain cells" — no guessing. If
propagation forces nothing, the hint reports that the board cannot be
advanced by pure deduction.

## MAIN-world functions

Three functions in `main-world.js`, mirroring Binairo's:

- `readYinYangData()` — polls for `Game.task` (2D array) and
  `puzzleWidth`/`puzzleHeight`; returns `{ task, width, height }`.
- `readYinYangState()` — returns `Game.currentState.cellStatus` as-is
  (`0/1/2`).
- `applyYinYangState(solution, isFull)` — calls `Game.saveState(true)`,
  writes `cellStatus`, then falls through the render ladder
  (`drawCurrentState → redraw → draw → getSaved+loadGame`). When `isFull` is
  true, also sets `currentState.solved = true` and calls `Game.check()`
  (full-solution-only, like `applyGameState`). Used for both Solve-apply
  (`isFull = true`) and Hint-apply (`isFull = false`), so the render path is
  defined and verified in one place.

`background.js`'s `EXEC_MAIN_ALLOWLIST` and `globals.d.ts`'s `MainWorldFn`
union both gain the three names and stay in sync.

## Handler

`yinYangHandler` in `handler.js`:

- `priority: 30` (same tier as Binairo and Shikaku).
- `matches()` — `isPuzzlesMobilePage() && location.pathname.includes('/yin-yang/')`.
- `detect()` — calls `callMainWorld('readYinYangData', [])`, returns
  `{ found: true, type: 'yinyang', rows, cols, task, _element }` (or a
  `found: false` error result if no task data).
- `readState()` — `callMainWorld('readYinYangState', [])`.
- `applySolution(solution)` — `callMainWorld('applyYinYangState', [solution, true])`.

## content.js integration

- `solveExtraData` — yin-yang arm passing `{ rows, cols, task }` to the
  worker.
- `yinYangCacheKey` — cache key mixing the task givens' bytes.
- `getHint` — yin-yang branch constructing a `YinYangSolver` and calling
  `getHint(grid)`.
- `yinYangHintStatusNodes` — status text: "N cells can be deduced", or a
  message that no cells are deducible by pure logic.
- Hint-apply — the yin-yang arm calls `applyYinYangState(hintGrid, false)`
  for a self-contained, verified render path (rather than depending on the
  generic `applyHintCells` render ladder).
- `drawPreview` — yin-yang rendering (see below).
- `SUPPORTED_PUZZLES` — a Yin-Yang entry.

`solver.worker.js` gains a dispatch arm: `type === 'yinyang'` →
`new YinYangSolver({ rows, cols, task }).solve()` with `maxMs` set.

## Preview rendering

The `drawPreview` yin-yang arm renders the classic black/white stones. Each
filled cell is a disc: `cellStatus 1` → dark disc, `2` → light disc with a
grey outline (so a white stone reads against the white canvas). Empty cells
stay blank. Given cells get a small centered dot to distinguish them from
solver-filled cells. Hint cells get a blue ring around the disc, matching
Binairo's hint styling.

The two-layer canvas cache is used as elsewhere: the `staticLayer` holds the
cell-border lattice plus the givens dots; `staticSig` includes a `|yy=`
segment over the task givens so the layer rebuilds when the puzzle changes.

## Testing

- `tests/fixtures/puzzles.js` — `yinyang6x6`, the exact 6×6 puzzle from the
  recon capture; golden solution snapshot in `tests/golden.js`.
- `tests/solver.test.js` — `YinYangSolver` cases: solves the 6×6 fixture;
  the 2×2 rule forces the 4th cell for both a monochrome-3 and a
  checkerboard-3 window; the connectivity-cut probe forces a cell; a
  contradiction is reported on an unsolvable board without crashing;
  `getHint` returns forced cells and returns `null` at a fixed point;
  a `maxMs` bail-out regression asserting the solver returns within 500 ms.
- `tests/yinyang-fuzz.test.js` — two layers:
  1. **Soundness** — many random given-subsets; every `solved` result is
     independently validated (both colors connected, no illegal 2×2, givens
     respected).
  2. **Completeness cross-check** — on 4×4 boards, brute-force all `2^16`
     two-colorings to enumerate the valid solutions, and assert the solver
     finds a valid solution exactly when one exists. (5×5 and larger are too
     large to brute-force exhaustively, hence 4×4.)
- `tests/fixtures/real-puzzles.js` — full-size puzzles captured from
  puzzles-mobile.com via the widget's Dump button.
- `tests/bench-yinyang.js` — benchmark; `process.exit(1)` on any unsolved
  puzzle. `package.json` gains a `bench:yinyang` script.

## Out of scope

- A lookahead / proof-by-contradiction fallback for Hint. Hint reveals only
  cells forced by the propagation rules, as chosen. If the user later wants a
  deeper Hint, it can be added then (as happened for Binairo).
- Stronger connectivity propagation rules (e.g. enclosed-pocket forcing).
  The two rules above are sufficient for correctness; backtracking covers the
  rest. Additional rules can be added if benchmarking shows they are needed.
