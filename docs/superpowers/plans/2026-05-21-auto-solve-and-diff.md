# Auto-Solve on Detect + Live Mistake Highlighting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a puzzle is detected, auto-solve it in the background, cache the result for every feature to reuse, and highlight the cells the player has placed incorrectly.

**Architecture:** A pure `computePuzzleDiff` function in `solver.js` does the player-board-vs-solution comparison. `content.js` gains an `autoSolve()` that `detectHandler` fires non-blocking; it populates `puzzleData.solution` + the existing localStorage caches (which Solve/Hint/Loop already read). `drawPreview` overlays a red marker on each mistake, recomputed every redraw so it stays live.

**Tech Stack:** Vanilla ES2020 JavaScript, Chrome MV3, `node:test`, `jj` (Jujutsu) for version control — **never plain `git`**.

**Conventions:**
- Colocated Jujutsu/git workspace. Commit with `jj commit -m "msg"`. Never run `git commit`/`git add`/etc.
- After editing `solver.js` or `content.js`, run `npm run build`. Test/doc edits don't need a rebuild.
- `npm run lint`, `npm run typecheck`, `npm test` must all pass before each commit.
- TDD where there's a unit test: failing test → run → implement → run → commit.

## Background

- `detectHandler()` (content.js) detects, sets `puzzleData`, enables buttons, reads the board, `drawPreview`, `startStateWatch()`. It does NOT solve.
- `solveHandler()`: if `puzzleData.solution` is set it jumps straight to the "Preview ready" confirm step; else `runSolve(...)` then `recordSolveSuccess(result)`.
- `recordSolveSuccess(result)`: sets `puzzleData.solution`, writes the localStorage caches (`cacheGridSolution`, `cacheGalaxiesSolution`), clears partials.
- `runSolve(rowClues, colClues, initialGrid, solverType, extraData)`: posts to the Web Worker, returns a Promise.
- `getCachedGridSolution(data)` / `getCachedGalaxiesSolution(data)`: read the localStorage caches.
- `startStateWatch()`: re-reads the board and `drawPreview`s ~5×/sec.
- `drawPreview(grid, hint)` ends with `if (staticLayer) ctx.drawImage(staticLayer, 0, 0); }`.
- `solveExtraData()` builds the worker `extraData` from the module global `detectedGrid`.
- Puzzle cell encodings: Nonogram/Aquarium/Binairo/Yin-Yang use `0` = empty; Galaxies uses `0` = unassigned region; Shikaku uses `-1` = unassigned (owner index otherwise).

## File Structure

| File | Change |
| --- | --- |
| `solver.js` | New pure `computePuzzleDiff` (+ `_shikakuDiff` helper); add `computePuzzleDiff` to `module.exports` |
| `globals.d.ts` | `declare function computePuzzleDiff(...)` so tsc sees the cross-file use |
| `eslint.config.js` | Add `computePuzzleDiff` to the content-script globals |
| `tests/solver.test.js` | Unit tests for `computePuzzleDiff` |
| `content.js` | `drawPreview` mistake overlay; `autoSolve()` + `detectHandler` call + `pendingAutoSolve`; reuse bridges in `solveHandler`/`hintHandler`/`loopHandler` |
| `CLAUDE.md` | Document the auto-solve + diff behaviour |

---

## Task 1: `computePuzzleDiff` pure diff function

**Files:**
- Modify: `solver.js` — add `computePuzzleDiff` + `_shikakuDiff`, extend `module.exports`
- Modify: `globals.d.ts`, `eslint.config.js`
- Test: `tests/solver.test.js`

- [ ] **Step 1: Write the failing tests**

Add to `tests/solver.test.js` (the file destructures from `../solver.js` on line 3 — extend that import to include `computePuzzleDiff`):

```js
test('computePuzzleDiff: flags a wrongly-placed cell, ignores correct and empty', () => {
  const solution = [[1, 2], [1, 2]];
  const grid = [[0, 1], [1, 0]]; // (0,1)=1 vs solution 2 -> mistake; (1,0) ok; (0,0),(1,1) empty
  assert.deepEqual(computePuzzleDiff('binairo', grid, solution), [{ row: 0, col: 1 }]);
});

test('computePuzzleDiff: galaxies compares region ids directly', () => {
  const solution = [[1, 1], [2, 2]];
  const grid = [[1, 2], [0, 2]]; // (0,1)=2 vs solution 1 -> mistake
  assert.deepEqual(computePuzzleDiff('galaxies', grid, solution), [{ row: 0, col: 1 }]);
});

test('computePuzzleDiff: shikaku flags a wrongly-shaped rectangle, not a correct one', () => {
  // 2x4 solution: clue 0 owns the left 2x2, clue 1 owns the right 2x2.
  const solution = [[0, 0, 1, 1], [0, 0, 1, 1]];
  // Player board with page owner ids (7/9/5) that DON'T match solver indices:
  // owner 7 = the correct left 2x2; owners 9 and 5 = wrong 2x1 columns.
  const grid = [[7, 7, 9, 5], [7, 7, 9, 5]];
  const set = new Set(computePuzzleDiff('shikaku', grid, solution).map(d => d.row + ',' + d.col));
  assert.equal(set.has('0,0'), false, 'correct left rectangle not flagged');
  assert.equal(set.has('1,1'), false);
  assert.equal(set.has('0,2'), true, 'wrong-shaped right rectangle flagged');
  assert.equal(set.has('0,3'), true);
  assert.equal(set.has('1,2'), true);
  assert.equal(set.has('1,3'), true);
});

test('computePuzzleDiff: shikaku ignores unassigned (-1) cells', () => {
  assert.deepEqual(computePuzzleDiff('shikaku', [[-1, -1], [-1, -1]], [[0, 0], [0, 0]]), []);
});

test('computePuzzleDiff: returns empty when grids are missing', () => {
  assert.deepEqual(computePuzzleDiff('binairo', null, [[1]]), []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test --test-name-pattern='computePuzzleDiff'`
Expected: FAIL with `computePuzzleDiff is not defined`.

- [ ] **Step 3: Implement**

In `solver.js`, add these two functions just before the `if (typeof module !== 'undefined' ...)` export block:

```js
// Bounding box of every distinct owner value on a board (skipping `empty`).
// Returns a Map: ownerValue -> { r1, c1, r2, c2 }.
function _ownerBoxes(board, rows, cols, empty) {
  const m = new Map();
  for (let r = 0; r < rows; r++) {
    const row = board[r] || [];
    for (let c = 0; c < cols; c++) {
      const v = row[c];
      if (v === empty || v === undefined) continue;
      const b = m.get(v);
      if (!b) {
        m.set(v, { r1: r, c1: c, r2: r, c2: c });
      } else {
        if (r < b.r1) b.r1 = r;
        if (r > b.r2) b.r2 = r;
        if (c < b.c1) b.c1 = c;
        if (c > b.c2) b.c2 = c;
      }
    }
  }
  return m;
}

// Shikaku diff: owner ids differ between the page board and the solver
// solution, so compare rectangle GEOMETRY — a placed cell is a mistake when
// its owner's bounding box does not match the solution rectangle covering it.
function _shikakuDiff(grid, solution) {
  const out = [];
  const rows = Math.min(grid.length, solution.length);
  if (rows === 0) return out;
  const cols = Math.min((grid[0] || []).length, (solution[0] || []).length);
  const gBox = _ownerBoxes(grid, rows, cols, -1);
  const sBox = _ownerBoxes(solution, rows, cols, -1);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const gv = grid[r][c];
      if (gv === -1 || gv === undefined) continue; // unassigned — not a mistake
      const gb = gBox.get(gv);
      const sb = sBox.get(solution[r][c]);
      if (!gb || !sb ||
          gb.r1 !== sb.r1 || gb.c1 !== sb.c1 ||
          gb.r2 !== sb.r2 || gb.c2 !== sb.c2) {
        out.push({ row: r, col: c });
      }
    }
  }
  return out;
}

/**
 * Compare a player's board to the puzzle's solution; return the cells the
 * player has PLACED incorrectly (empty cells are never flagged). Pure — no
 * DOM. Used by the widget preview to highlight mistakes.
 *
 * @param {string} type   'nonogram'|'aquarium'|'binairo'|'yinyang'|'galaxies'|'shikaku'
 * @param {number[][]} grid      the player's current board
 * @param {number[][]} solution  the solved board
 * @returns {{row:number, col:number}[]}
 */
function computePuzzleDiff(type, grid, solution) {
  const out = [];
  if (!Array.isArray(grid) || !Array.isArray(solution)) return out;
  if (type === 'shikaku') return _shikakuDiff(grid, solution);
  // Cell-state puzzles and galaxies: a cell is a mistake when it is placed
  // (non-empty; the empty sentinel is 0 for all of these) and its value
  // differs from the solution.
  const rows = Math.min(grid.length, solution.length);
  for (let r = 0; r < rows; r++) {
    const gRow = grid[r] || [], sRow = solution[r] || [];
    const cols = Math.min(gRow.length, sRow.length);
    for (let c = 0; c < cols; c++) {
      const g = gRow[c];
      if (g !== 0 && g !== undefined && g !== sRow[c]) {
        out.push({ row: r, col: c });
      }
    }
  }
  return out;
}
```

Extend the export block:

```js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { NonogramSolver, AquariumSolver, GalaxiesSolver, BinairoSolver, ShikakuSolver, YinYangSolver, computePuzzleDiff };
}
```

Extend line 3 of `tests/solver.test.js`:

```js
const { NonogramSolver, AquariumSolver, GalaxiesSolver, BinairoSolver, ShikakuSolver, YinYangSolver, computePuzzleDiff } = require('../solver.js');
```

In `globals.d.ts`, add alongside the other cross-file `declare function` lines (e.g. near `declare function callMainWorld`):

```ts
declare function computePuzzleDiff(type: string, grid: any, solution: any): { row: number, col: number }[];
```

In `eslint.config.js`, add `computePuzzleDiff` to the content-script globals — read the file and add it to the same globals object/list that already declares `callMainWorld` / `getActiveHandler` / the solver classes as `readonly` (so `content.js` referencing `computePuzzleDiff` doesn't trip `no-undef`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test --test-name-pattern='computePuzzleDiff'` — expect 5 passing.
Run: `npm run lint && npm run typecheck && npm test` — all green.

- [ ] **Step 5: Build and commit**

```bash
npm run build && jj commit -m "feat(diff): computePuzzleDiff — player-board-vs-solution comparison"
```

---

## Task 2: drawPreview mistake overlay

**Files:**
- Modify: `content.js` — `drawPreview`

`drawPreview(grid, hint)` (around line 2137) ends with `if (staticLayer) ctx.drawImage(staticLayer, 0, 0);` followed by the method's closing `}`. Add a mistake overlay as the final, topmost pass.

- [ ] **Step 1: Add the overlay**

In `drawPreview`, immediately AFTER the `if (staticLayer) ctx.drawImage(staticLayer, 0, 0);` line and BEFORE `drawPreview`'s closing `}`, insert:

```js
    // Mistake overlay: when the auto-solved solution is known, ring every
    // cell the player has placed wrong. Recomputed each redraw, so it tracks
    // the board live as the state-watch refreshes the preview.
    if (puzzleData?.solution) {
      const mistakes = computePuzzleDiff(puzzleData.type, grid, puzzleData.solution);
      if (mistakes.length) {
        ctx.save();
        ctx.strokeStyle = '#e63946';
        ctx.lineWidth = Math.max(2, Math.floor(cellSize / 8));
        for (const m of mistakes) {
          const mx = m.col * cellSize, my = m.row * cellSize;
          ctx.fillStyle = 'rgba(230, 57, 70, 0.22)';
          ctx.fillRect(mx, my, cellSize, cellSize);
          ctx.strokeRect(mx + 1, my + 1, cellSize - 2, cellSize - 2);
        }
        ctx.restore();
      }
    }
```

(`grid`, `cellSize`, `ctx` are already in scope in `drawPreview`; `puzzleData` is a closure global; `computePuzzleDiff` is the global from `solver.js`. `#e63946` is the red already used elsewhere in `drawPreview`.)

- [ ] **Step 2: Verify**

Run: `npm run lint && npm run typecheck && npm test` — all green (no unit test for canvas drawing; this confirms nothing broke).
Run: `npm run build` — completes.

- [ ] **Step 3: Commit**

```bash
jj commit -m "feat(diff): drawPreview rings cells that mismatch the solution"
```

---

## Task 3: autoSolve on Detect

**Files:**
- Modify: `content.js` — add `pendingAutoSolve`, `autoSolve()`, `afterAutoSolve()`; call from `detectHandler`

- [ ] **Step 1: Add the `pendingAutoSolve` variable**

In `content.js`, near the other widget state variables (where `puzzleData`, `confirming`, `looping` etc. are declared in the widget closure), add:

```js
  let pendingAutoSolve = null;
```

- [ ] **Step 2: Add `autoSolve` and `afterAutoSolve`**

Add these two functions inside the widget closure (near `solveHandler` / `recordSolveSuccess`):

```js
  // Background solve kicked off by Detect. Non-blocking: detectHandler does
  // not await it. Populates puzzleData.solution + the localStorage caches so
  // Solve/Hint/Loop reuse it, and triggers the mistake overlay. Solves from
  // the puzzle's givens (initialGrid = null) so the result is the canonical
  // solution, not biased by the player's possibly-wrong moves. Background
  // failures are silent — features still solve on demand.
  async function autoSolve() {
    const pd = puzzleData; // capture — a later Detect must not be clobbered
    if (!pd || pd.solution) return;
    const cached = pd.type === 'galaxies'
      ? getCachedGalaxiesSolution(pd)
      : getCachedGridSolution(pd);
    if (cached) {
      if (puzzleData === pd) { pd.solution = cached; await afterAutoSolve(pd); }
      return;
    }
    const result = await runSolve(pd.rowClues, pd.colClues, null, pd.type, solveExtraData());
    if (puzzleData !== pd) return; // a newer Detect superseded this solve
    if (result && result.solved) {
      recordSolveSuccess(result);
      await afterAutoSolve(pd);
    } else {
      console.warn('[puzzle-solver] background auto-solve did not solve:', result && result.error);
    }
  }

  // After the auto-solve lands: redraw the preview (so mistakes show) and, if
  // the widget is still idle on the post-detect message, note the count.
  async function afterAutoSolve(pd) {
    const state = await readGridState();
    if (puzzleData !== pd || !pd.solution) return;
    const grid = state && state.success ? state.grid : null;
    if (!grid) return;
    drawPreview(grid);
    if (!confirming && !looping && !loopConfirming && !puzzleData.pendingHint) {
      const mistakes = computePuzzleDiff(pd.type, grid, pd.solution);
      const label = (pd.type || 'puzzle').charAt(0).toUpperCase() + (pd.type || 'puzzle').slice(1);
      const note = mistakes.length
        ? `${mistakes.length} mistake${mistakes.length === 1 ? '' : 's'}`
        : 'no mistakes';
      setStatus(`Found ${pd.rows}×${pd.cols} ${label} — ${note}.`, 'success');
    }
  }
```

- [ ] **Step 3: Fire it from `detectHandler`**

In `detectHandler`, the function ends with `updateUndoRedoButtons();` then `startStateWatch();`. Immediately after `startStateWatch();`, add:

```js
    pendingAutoSolve = autoSolve();
```

(Not awaited — detectHandler returns immediately; the solve runs in the background.)

- [ ] **Step 4: Verify**

Run: `npm run lint && npm run typecheck && npm test` — all green.
Run: `npm run build` — completes.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(auto-solve): Detect kicks off a background solve and caches it"
```

---

## Task 4: Reuse bridges — Solve, Hint, Loop await the pending solve

**Files:**
- Modify: `content.js` — `solveHandler`, `hintHandler`, `loopHandler`

The localStorage caches + `puzzleData.solution` already make features reuse the auto-solve result once it lands. This task closes the race window: if a feature is invoked while `autoSolve` is still running, it awaits the one shared solve instead of starting a duplicate.

- [ ] **Step 1: Bridge `solveHandler`**

`solveHandler` has a block `if (puzzleData.solution) { ... drawPreview(puzzleData.solution); return; }` (the "Preview ready" fast path), preceded by a `getCachedGalaxiesSolution` check. Immediately BEFORE that `if (puzzleData.solution) {` line, insert:

```js
    if (!puzzleData.solution && pendingAutoSolve) {
      setStatus('Solving...', 'info');
      await pendingAutoSolve;
    }
```

So a Solve clicked mid-auto-solve waits for the shared solve; the existing `if (puzzleData.solution)` block then shows the preview with no re-solve. If the auto-solve failed, `puzzleData.solution` is still unset and `solveHandler` falls through to its existing on-demand `runSolve` path unchanged.

- [ ] **Step 2: Bridge `hintHandler`**

Read `hintHandler` (around line 2729). Before it calls `getHint(...)`, insert the same await bridge and pass the cached solution into the hint request so Hint's per-type solve-fallbacks reuse it:

```js
    if (!puzzleData.solution && pendingAutoSolve) {
      setStatus('Solving...', 'info');
      await pendingAutoSolve;
    }
```

And ensure the `getHint` call passes `puzzleData.solution` as `request.solution` — `getHint(request)` already reads `request.solution` (content.js line 1329) and uses it as `hintSolution`, the seed for its fallbacks. If `hintHandler` currently calls `getHint()` with no/other request, change it to include `solution: puzzleData.solution` in the request object. Do not change Hint's per-type deduction logic — only feed it the cached solution.

- [ ] **Step 3: Bridge `loopHandler`**

Read `loopHandler` (around line 2548). It performs an intermediate solve. Before that solve, insert the same bridge:

```js
    if (!puzzleData.solution && pendingAutoSolve) {
      await pendingAutoSolve;
    }
```

so the Loop reuses the auto-solve's `puzzleData.solution` (via `recordSolveSuccess`, already set) rather than solving again. Leave the rest of `loopHandler` unchanged — if `puzzleData.solution` is set it should already reuse it; the bridge just covers the race window.

- [ ] **Step 4: Verify**

Run: `npm run lint && npm run typecheck && npm test` — all green.
Run: `npm run build` — completes.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(auto-solve): Solve/Hint/Loop reuse the pending auto-solve"
```

---

## Task 5: Document + final verification

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Document the behaviour**

In `CLAUDE.md`, under the "Widget conventions" section, add a bullet:

```
- `detectHandler` fires `autoSolve()` (non-blocking) after a successful
  detect: it cache-checks then runs a background worker solve from the
  puzzle's givens, populating `puzzleData.solution` + the localStorage
  caches so Solve/Hint/Loop reuse it (`pendingAutoSolve` bridges the race
  window). `drawPreview` then rings cells where the board disagrees with
  the solution (`computePuzzleDiff` in `solver.js`); recomputed each redraw
  so it tracks the board live. Shikaku's diff compares rectangle geometry
  (page owner ids ≠ solver clue indices).
```

- [ ] **Step 2: Final verification**

- Run: `npm run lint && npm run typecheck && npm test` — all green.
- Run: `npm run build` — completes.
- Run: `npm run bench:yinyang` (sanity — unaffected, should still pass) and `npm test` once more.
- **Live smoke test** — load `dist/` in Chrome on a real puzzle page:
  1. Click Detect — it returns immediately; shortly after, the status notes the mistake count and (if the board has wrong cells) red rings appear.
  2. Click Solve — it goes straight to "Preview ready" with no solving wait.
  3. Deliberately misplace a cell — a red ring appears within ~200 ms; correct it — the ring clears.
  4. On a puzzle the solver can't crack in budget, Detect and the other features still behave normally; no error dialog from the background solve.

- [ ] **Step 3: Commit**

```bash
jj commit -m "docs: document auto-solve-on-detect and mistake highlighting"
```

## Notes for the implementer

- `autoSolve` deliberately passes `initialGrid = null` to `runSolve` — the canonical solution, independent of the player's board.
- The staleness guard (`if (puzzleData !== pd) return;`) matters: a player can re-Detect or navigate while a background solve is in flight; a stale result must not overwrite the new `puzzleData`.
- Galaxies diff assumes the read board and the solver solution use the same region-id scheme (both star-indexed — the preview already renders both with the same `galaxiesColors` mapping). If the live smoke test shows galaxies mistakes highlighted incorrectly, that assumption is wrong and the galaxies diff needs star-normalization — report it rather than guessing.
- Don't change Hint's per-type deduction behaviour or the Solve → Preview → Confirm → Apply flow; auto-solve only removes waits and feeds the diff.
