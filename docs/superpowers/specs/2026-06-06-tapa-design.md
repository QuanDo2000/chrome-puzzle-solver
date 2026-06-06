# Tapa puzzle support — design

**Status:** approved (brainstorm)
**Date:** 2026-06-06
**Site:** puzzles-mobile.com `/tapa/` (slug `tapa`).

## Summary

Add full Tapa support (Detect / Solve / Hint / Loop), wired as a **cell-state shading CSP**
puzzle (the Nurikabe/Heyawake family). Shade non-clue cells so that: every clue cell's
shaded-neighbour run pattern matches its clue, all shaded cells form one orthogonally-connected
group, and no 2×2 block is fully shaded. The page `getErrors` is a **real oracle** (decoded
verbatim, including `getNeighbourCount`) and the ruleset is **brute-force-gated**. The solver
enumerates each clue's valid neighbour patterns, propagates (clue-pattern arc-consistency +
no-2×2), backtracks on the first undecided shadeable cell with a leaf connectivity check, and
returns a sound partial on timeout. The real 6×6-hard board full-solves uniquely in ~0ms.

## Recon: the page encoding (ground truth, from `window.Game`)

- **slug** `tapa`; board N×N (`puzzleWidth`/`puzzleHeight`; captured boards 6×6 and 20×20).
- **`dr=[-1,-1,-1,0,1,1,1,0]`, `dc=[-1,0,1,1,1,0,-1,-1]`** — the 8 neighbours in clockwise
  order; this cyclic order is what clue runs read around.
- **`task[r][c]`** (parsed by `parseTask` into an N×N int grid):
  - `-1` — empty, **shadeable**.
  - `≥ 0` — a **clue cell** (never shaded). The integer's **decimal digits are the run
    lengths**: `113` ⇒ runs `[1,1,3]`, `24` ⇒ `[2,4]`, `5` ⇒ `[5]`, `0` ⇒ no shaded
    neighbour. (`parseTask` concatenates consecutive numeric chars; each run length is a single
    digit 0–8.)
  - `-2` — a `"B"` clue cell (never shaded, **no count constraint**; absent from normal boards).
- **`currentState.cellStatus[r][c]`** (`statesMap = ["n","y","x"]`): `0` unknown · `1` shaded ·
  `2` X (marked-not-shaded). Clue cells are **not tracked** in `cellStatus` (the page renders the
  clue from `task`) — they stay `0`.
- **`serializeSolution`** = `cellStatus===1 ? "y" : "n"` over the grid — the solution is exactly
  the set of shaded (`1`) cells.

### Validity rules (ported from `getErrors` → `check2x2` / `checkDisconnected` / `checkTask` + `getNeighbourCount`)
`getErrors(true)` returns no error iff all three hold:
1. **No 2×2 fully shaded** (`check2x2`).
2. **All shaded cells form one orthogonally-connected component** (`checkDisconnected`).
3. **Every clue cell matches** (`checkTask`): `getNeighbourCount(r,c)[1]` loose-`==` `task[r][c]`.
   - `getNeighbourCount`: build an 8-bit mask of shaded neighbours (off-grid ⇒ unshaded). If the
     mask isn't all-ones, rotate it until bit 0 is a gap (`while (mask & 1) mask = rotate(mask)`)
     — this resolves the cyclic wrap. Count maximal runs of consecutive set bits, **sort
     ascending**, and `join("")`. Compare with loose `==` to the clue (so `""`-empty matches
     clue `0`; `"8"` matches the all-8 case). Clue/off-grid neighbours never contribute a run.

Clue cells (`task ≥ 0` or `-2`) are never shaded.

## Architecture & files

Cell-state shading puzzle, wired like Nurikabe/Heyawake. It reuses the default cell-state preview
cell-loop, the default per-cell mistake-diff, undo/redo, and the solution cache.

**Value-spaces (don't conflate; mirrors the [[project_starbattle_support]] "empty stays empty" fix):**
- **Solver `grid`**: `1` shaded, `0` not-shaded, `9` UNK (partials only).
- **preview / solution / apply space**: `0` empty, `1` shaded, `2` X (explicit not-shaded marker),
  `9` UNK (= empty). `solutionFromResult` converts solver → this space (`1→1`, not-shaded `0→2`,
  UNK `9→0`), so a full Solve previews & applies shaded cells PLUS an X on every white cell, while
  an untouched board / a partial's undecided cells stay blank. `drawPreviewCell` paints `1`→shaded
  fill, `2`→X, draws nothing for `0`/`9` (EMPTY CELLS MUST RENDER EMPTY — never X a `0`).
  `applyTapaState` writes `cellStatus 1` (shaded) / `2` (X), skips `0`/`9` and all clue cells.
- **handler.readState**: normalized `{1 shaded, else 0}` (X reads as 0, clue cells 0) so the default
  per-cell diff / firstMismatch flag only wrongly-shaded cells.
- The page's `serializeSolution` only reads `cellStatus===1`, so X (`2`) and empty (`0`) both count
  as "not shaded" — X'ing the white cells is a correct, complete board.

**New**
- `src/solvers/tapa.js` — `TapaSolver` (pure logic): the ported oracle (`_isValid` via
  `check2x2`/connectivity/`_runString`), per-clue valid-pattern enumeration, clue-pattern +
  no-2×2 propagation, backtracking with a leaf connectivity check, sound partial, and
  `_deduceForced` (hint). Returns `{ solved, grid, partial?, error? }`, `grid[r][c] ∈ {1 shaded,
  0 not}` (full solve) / `{1, 0, 9 UNK}` (partial).
- `src/widget/puzzles/tapa.js` — registry module (cacheKey, canvasDims, staticSig,
  drawStaticLayer = clue digits, drawPreviewCell = shaded fill, solveExtraData, solutionFromResult,
  hintDispatch, applyHint, loopDoneCheck, partialResultArm).
- `tests/tapa.test.js` (oracle + brute-force gate + solve + `_deduceForced`), a `tapa_6x6`
  fixture in `tests/fixtures/real-puzzles.js`, `tests/bench-tapa.js`.

**Modified (standard wiring touchpoints)**
- `solver.worker.js` — `else if (type === 'tapa')` dispatch (`maxMs:30000`).
- `scripts/build-solver-bundle.js` — `tapa.js` in FILES, `TapaSolver` in EXPORTS.
- `scripts/build-content-bundle.js` — `puzzles/tapa.js` in WIDGET_FILES (before `puzzles/index.js`).
- `handler.js` — `tapaHandler` (matches `/tapa/`; detect/readState/applySolution) + `registerHandler`.
- `main-world.js` — `readTapaData` / `readTapaState` / `applyTapaState` + `/tapa/` dump branch.
- `background.js` — three names in `EXEC_MAIN_ALLOWLIST`; `globals.d.ts` — `TapaSolver` decl +
  three `MainWorldFn` entries; `eslint.config.js` — `TapaSolver`/`tapa` readonly globals.
- `src/widget/puzzles/index.js` — register `tapa`.

No `preview.js`/`diff.js`/`hint.js` changes: shading puzzles use the default cell-state arms.

## Solver model & method

**Model.** Each `-1` cell binary (shaded / not). Clue cells fixed unshaded. Internal grid `g`:
`9` unknown, `0` unshaded, `1` shaded.

**Per-clue valid patterns.** For each clue cell, compute `forbidden` = the 8 directions that are
off-grid or non-shadeable (clue) cells. Enumerate `m ∈ [0,256)` with `m & forbidden === 0`; keep
those whose `_runString(m)` loose-`==` the clue. (Empty clue `0` ⇒ mask `0`.)

**Oracle `_isValid(grid)`** — ported `getErrors`: no 2×2 fully shaded; one connected shaded
component; every clue cell's `_runString` loose-`==` its clue; clue cells unshaded.

**Propagation (sound, to a fixpoint):**
- **Clue-pattern arc-consistency:** for each clue, keep the patterns consistent with its already-
  decided neighbours; none left ⇒ contradiction; a shadeable neighbour direction agreed by all
  surviving patterns ⇒ force it.
- **No-2×2:** a 2×2 with 4 shaded ⇒ contradiction; with 3 shaded + 1 unknown ⇒ force the unknown
  unshaded.

**Search + partial.** Backtrack on the first undecided shadeable cell (try shaded, then unshaded),
propagate, recurse. **Connectivity is checked at each complete leaf** via `_isValid` (sound;
unpropagated). Under `maxMs`; on timeout return the **root-propagation snapshot** (UNK ⇒ 9),
captured after root propagation, before search.

**Soundness gate (the gate).** For ~4,000 random tiny boards (3×3…4×4, ~30% clue cells, clues
derived from a random seed shading): brute-force all shadings passing `_isValid`; assert
solver-solved ⟺ brute-nonempty, solver output passes the oracle, and uniqueness agrees.
**Validated: 3,976 tested, 0 failures.**

**Measured (prototype).** Real 6×6-hard: full-solve **~0ms**, oracle-valid, **unique** (23 shaded).

**Honest perf ceiling.** Connectivity is only leaf-checked (not propagated), so — like
Nurikabe/Masyu — large boards (the captured **20×20**) may exhaust the budget and return a sound
partial rather than a full solve. The plan records the measured outcome; 6×6 (and likely up to
~10×10) full-solve.

## Widget integration

- **Detect/Solve:** handler matches `/tapa/`; `readTapaData` → `{rows, cols, task}`; worker
  `TapaSolver`; solution `{grid}`.
- **MAIN-world** (self-contained): `readTapaData` (the `task` clue grid); `readTapaState` → raw
  `{cellStatus}` (0/1/2, for the hint); `applyTapaState` → write `cellStatus[r][c] = 1` (shaded) /
  `2` (X) for `-1` cells (per the value-space above: `1→1`, `2→2`, skip `0`/`9`), leave clue cells
  `0`; render ladder; never `check()`. Plus the `/tapa/` dump branch.
- **Rendering:** `drawStaticLayer` draws each clue cell's digits (the run sequence; `-2` ⇒ a
  marker) and the outer border; `drawPreviewCell` fills shaded cells (`1`) and X-marks not-shaded
  (`2`), nothing for `0`/`9`. `canvasDims marginCells: 0`.
- **Mistakes:** the default per-cell diff (board `1`/`0` vs solution `1`/`0`). `handler.readState`
  returns a normalized grid: shadeable cell `cellStatus 1 → 1` else `0`; clue cells `0`.
- **Hint/Loop:** `hintDispatch` reads raw `cellStatus`, seeds `_deduceForced` (1 = shaded, 2 =
  unshaded, 0 = unknown) **re-asserting clue cells as unshaded from `task`** (the Nurikabe-family
  trait — clue cells aren't in `cellStatus`, so without this Loop never terminates,
  [[project_clue_cells_not_in_cellstatus]]), returns the newly-forced cells `{row, col, value}`
  (value `1` shaded → cellStatus 1 / value `2` unshaded → cellStatus 2 X), batch-capped; falls back
  to revealing the next cached-solution shaded cells. `applyHint` writes ONLY the hint cells.
  `loopDoneCheck` true when every solution-shaded cell is on the board.

## Testing & verification

- **Oracle units:** 2×2 rejection, connectivity rejection, clue run-string match (incl. clue 0,
  all-8, edge/corner cells, multi-run cyclic-wrap).
- **Brute-force soundness gate (the gate):** tiny boards, differential vs full enumeration.
- **Fixtures:** the captured real 6×6-hard; small hand-built boards.
- **Performance:** bench the real 6×6; report full-solve vs sound partial honestly.
  Lint/typecheck/build gated.

## Open items (non-blockers, resolved at live-verify)

- Clue-digit rendering layout in clue cells (the run sequence) and the shaded fill on the live page.
- The `applyTapaState` cellStatus writes + render ladder — verify on the live board after first deploy.
- The `-2`/"B" clue semantics (none in normal boards; handled conservatively as unshaded/no-count).

## Out of scope (YAGNI)

- Any change to other puzzles / shared infra beyond the registry/allowlist additions (no
  preview.js/diff.js/hint.js changes — default cell-state arms suffice).
- Non-`/tapa/` variants/sizes.
- Propagated connectivity (leaf-checked is sound; revisit only if larger boards must full-solve).
