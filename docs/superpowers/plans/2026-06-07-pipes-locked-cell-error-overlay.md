# Pipes Locked-Cell Error Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ring locked (pinned) pipes cells that are at the wrong rotation, in the widget's preview canvas, live-refreshing and errors-only.

**Architecture:** A pipes registry hook (`lockedMistakes`) computes wrong-locked cells using widget-layer rotation math; the state-watch reads the page's `pinned` lock layer and stashes it on `puzzleData`; the preview's existing red-ring mistake renderer draws the returned cells. `computePuzzleDiff` (solver layer) is untouched — it can't reach the rotation helpers.

**Tech Stack:** Chrome MV3 extension, plain JS, `node:test`. Version control is **`jj`** (never plain `git`). Design spec: `docs/superpowers/specs/2026-06-07-pipes-locked-cell-error-overlay-design.md`.

> **Project conventions:** Use `jj commit -m "..."` for every commit step. After editing `main-world.js`, `background.js`, `widget/`, `preview.js`, or `pipes.js`, a `npm run build` is required before the extension reflects the change (verified in Task 6). `dist/` is gitignored, so it is never committed.

---

### Task 1: `rotateMask` helper in `pipes-rotation.js`

Forward rotation primitive: rotate a 4-bit pipe mask by `count` page-steps. Mirrors the `step` logic already inside `rotationCount`. Needed so `lockedMistakes` can compare by resulting mask (handles rotationally-symmetric pieces).

**Files:**
- Modify: `src/widget/pipes-rotation.js`
- Test: `tests/pipes-rotation.test.js`

- [ ] **Step 1: Write the failing tests**

Append these three tests to the end of `tests/pipes-rotation.test.js` (after the last existing test, before EOF). The file already imports `rotationCount` and `PipesSolver`; add `rotateMask` to the existing destructure on line 4 so it reads:

```js
const { rotationCount, rotateMask } = require('../src/widget/pipes-rotation.js');
```

Then append:

```js
// rotateMask(taskMask, count, pageCW) rotates a 4-bit mask `count` page-steps.
// pageCW=true is a clockwise quarter-turn per step (== PipesSolver.rotateCW),
// false is counter-clockwise. It is the forward inverse of rotationCount.
test('rotateMask applies the CW page step count times (matches PipesSolver.rotateCW)', () => {
  for (const base of [0, 1, 3, 5, 6, 7, 15]) {
    for (let k = 0; k < 4; k++) {
      assert.equal(rotateMask(base, k, true), PipesSolver.rotateCW(base, k), `base=${base} k=${k}`);
    }
  }
});

test('rotateMask round-trips with rotationCount', () => {
  for (const base of [1, 3, 5, 6, 7]) {
    for (let k = 0; k < 4; k++) {
      const solved = PipesSolver.rotateCW(base, k);
      assert.equal(rotateMask(base, rotationCount(base, solved, true), true), solved, `base=${base} k=${k}`);
    }
  }
});

test('rotateMask honours CCW direction', () => {
  assert.equal(rotateMask(1, 1, false), 8); // N(1) one CCW step -> W(8)
  assert.equal(rotateMask(1, 3, false), 2); // three CCW steps -> E(2)
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/pipes-rotation.test.js`
Expected: FAIL — `rotateMask is not a function` (TypeError) on the new tests; the three existing `rotationCount` tests still pass.

- [ ] **Step 3: Implement `rotateMask`**

In `src/widget/pipes-rotation.js`, add the function after `rotationCount` and before the `module.exports` block, then add `rotateMask` to the exports.

```js
// Rotate a 4-bit pipe mask `count` page-steps. pageCW selects the per-step bit
// transform (must match rotationCount): CW = ((m<<1)|(m>>3))&0xF, CCW inverse.
// This is the forward direction of rotationCount — used to compare a cell's
// CURRENT shape against its solved shape by mask, so symmetric pieces that match
// at multiple counts are judged by what they look like, not by their count.
function rotateMask(taskMask, count, pageCW) {
  const stepCW = (m) => ((m << 1) | (m >> 3)) & 0xF;
  const stepCCW = (m) => ((m >> 1) | (m << 3)) & 0xF;
  const step = pageCW ? stepCW : stepCCW;
  let m = taskMask & 0xF;
  const turns = ((count % 4) + 4) % 4;
  for (let t = 0; t < turns; t++) m = step(m);
  return m;
}
```

Change the export line from:

```js
  module.exports = { rotationCount };
```

to:

```js
  module.exports = { rotationCount, rotateMask };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/pipes-rotation.test.js`
Expected: PASS — all tests (3 existing + 3 new).

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(pipes): add rotateMask rotation helper"
```

---

### Task 2: `lockedMistakes` hook in the pipes registry

Pure hook returning `[{row,col}]` for every locked cell whose current rotation yields a different mask than the solution.

**Files:**
- Modify: `src/widget/puzzles/pipes.js`
- Test: `tests/pipes-locked.test.js` (create)

- [ ] **Step 1: Write the failing tests**

Create `tests/pipes-locked.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const pipes = require('../src/widget/puzzles/pipes.js');

// pipes.lockedMistakes({ grid, solution, task, pinned }) returns [{row,col}] for
// every LOCKED (pinned) cell whose current rotation produces a different pipe
// MASK than the solution. grid & solution are rotation-COUNT grids; task is the
// scrambled-mask grid; pinned is a 0/1 lock grid. Solution counts are rotations
// FROM task TO solved, so solution=[[0]] means "solved shape == task mask".
// Mask facts (PipesSolver.rotateCW, page-CW): elbow mask 3: k0=3,k1=6.
// straight mask 5: k0=5,k1=10,k2=5 (period 2). cross mask 15: any k = 15.
// end mask 1: k0=1,k1=2.

test('lockedMistakes flags a locked cell at the wrong rotation', () => {
  const m = pipes.lockedMistakes({
    task: [[3]], solution: [[0]], grid: [[1]], pinned: [[1]], // 3 rotated 1 -> 6 != 3
  });
  assert.deepEqual(m, [{ row: 0, col: 0 }]);
});

test('lockedMistakes does NOT flag a correctly-locked cell', () => {
  const m = pipes.lockedMistakes({
    task: [[3]], solution: [[0]], grid: [[0]], pinned: [[1]], // 3 -> 3 == solved
  });
  assert.deepEqual(m, []);
});

test('lockedMistakes does NOT flag an unlocked wrong cell', () => {
  const m = pipes.lockedMistakes({
    task: [[3]], solution: [[0]], grid: [[1]], pinned: [[0]], // wrong but not pinned
  });
  assert.deepEqual(m, []);
});

test('lockedMistakes does NOT flag a symmetric piece locked at an equivalent rotation', () => {
  // straight (mask 5) solved at k0; locked at k2 -> mask 5 again. Counts differ
  // (0 vs 2) but the shape is identical, so it must NOT be flagged.
  const m = pipes.lockedMistakes({
    task: [[5]], solution: [[0]], grid: [[2]], pinned: [[1]],
  });
  assert.deepEqual(m, []);
});

test('lockedMistakes never flags a rotation-invariant cross', () => {
  const m = pipes.lockedMistakes({
    task: [[15]], solution: [[0]], grid: [[3]], pinned: [[1]],
  });
  assert.deepEqual(m, []);
});

test('lockedMistakes returns [] when any input grid is missing', () => {
  assert.deepEqual(pipes.lockedMistakes({ task: [[3]], solution: [[0]], grid: [[1]] }), []);
  assert.deepEqual(pipes.lockedMistakes({}), []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/pipes-locked.test.js`
Expected: FAIL — `pipes.lockedMistakes is not a function` (TypeError) on the flagging tests.

- [ ] **Step 3: Implement the hook**

In `src/widget/puzzles/pipes.js`, change the top-of-file require (line 4) from:

```js
const { rotationCount } = require('../pipes-rotation.js');
```

to:

```js
const { rotationCount, rotateMask } = require('../pipes-rotation.js');
```

Then insert the `lockedMistakes` hook into the `pipes` registry object, immediately after the `loopDoneCheck` hook's closing `},` (after the line `    return true;\n  },` that ends `loopDoneCheck`) and before the `// Hint Apply MUST use...` comment that precedes `applyHint`:

```js
  // lockedMistakes(ctx): ctx = { grid, solution, task, pinned }. grid & solution
  // are rotation-COUNT grids, task is the scrambled-mask grid, pinned is a 0/1
  // lock grid (Game.currentState.pinned). Returns [{row,col}] for every LOCKED
  // cell whose CURRENT rotation produces a different pipe MASK than the solution.
  // Compared by mask (via rotateMask), not by count, so a symmetric piece locked
  // at an equivalent rotation (a straight at 180 deg) is not falsely flagged.
  // Drives the preview's error overlay (preview.js); errors-only, locked-only.
  lockedMistakes(ctx) {
    const grid = ctx && ctx.grid;
    const solution = ctx && ctx.solution;
    const task = ctx && ctx.task;
    const pinned = ctx && ctx.pinned;
    const out = [];
    if (!grid || !solution || !task || !pinned) return out;
    for (let r = 0; r < task.length; r++) {
      const tRow = task[r] || [];
      for (let c = 0; c < tRow.length; c++) {
        if (!(pinned[r] && pinned[r][c])) continue;
        const t = tRow[c] | 0;
        const curMask = rotateMask(t, (grid[r] && grid[r][c]) | 0, PIPE_PAGE_CW);
        const solMask = rotateMask(t, (solution[r] && solution[r][c]) | 0, PIPE_PAGE_CW);
        if (curMask !== solMask) out.push({ row: r, col: c });
      }
    }
    return out;
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/pipes-locked.test.js`
Expected: PASS — all 6 tests.

- [ ] **Step 5: Run the puzzle-module shape test (no regression)**

Run: `node --test tests/puzzle-modules.test.js`
Expected: PASS — adding a hook doesn't break the pipes registry shape checks.

- [ ] **Step 6: Commit**

```bash
jj commit -m "feat(pipes): lockedMistakes hook flags wrong locked cells by mask"
```

---

### Task 3: `readPipesPinned` MAIN-world reader + allowlist + type mirror

Read `Game.currentState.pinned` as a serializable 0/1 grid. Three files must change together (the allowlist and the type union must stay in sync with the function set).

**Files:**
- Modify: `main-world.js`
- Modify: `background.js`
- Modify: `globals.d.ts`

- [ ] **Step 1: Add the reader to `main-world.js`**

Insert this function immediately after `applyPipesState` (after its closing `}` near the `function readKakurasuData()` line) and before `function readKakurasuData()`:

```js
function readPipesPinned(rows, cols) {
  // Game.currentState.pinned[r][c] === true when a cell is LOCKED. Coerce to 0/1
  // so the array serializes cleanly across the executeScript boundary. Mirrors
  // readPipesState's shape/guards; returns null when the layer is unavailable.
  try {
    var g = window.Game;
    if (!g || !g.currentState || !g.currentState.pinned) return null;
    var ps = g.currentState.pinned;
    var grid = [];
    for (var r = 0; r < rows; r++) {
      var row = ps[r] || [];
      var arr = new Array(cols);
      for (var c = 0; c < cols; c++) arr[c] = row[c] ? 1 : 0;
      grid.push(arr);
    }
    return grid;
  } catch (e) {
    return null;
  }
}
```

- [ ] **Step 2: Add to the `background.js` allowlist**

In `background.js`, in the `EXEC_MAIN_ALLOWLIST`, add `'readPipesPinned',` immediately after the `'applyPipesState',` entry:

```js
  'readPipesData',
  'readPipesState',
  'applyPipesState',
  'readPipesPinned',
```

- [ ] **Step 3: Add to the `globals.d.ts` `MainWorldFn` union**

In `globals.d.ts`, add `| 'readPipesPinned'` immediately after the `| 'applyPipesState'` entry:

```ts
  | 'readPipesData'
  | 'readPipesState'
  | 'applyPipesState'
  | 'readPipesPinned'
```

- [ ] **Step 4: Verify the SW still loads and the allowlist/type mirror are in sync**

Run: `node -e "require('./handler.js'); console.log('handler ok')"`
Expected: prints `handler ok` (no throw — `main-world.js` is not required here, but this confirms no syntax error reached the Node-required path).

Run: `npm run typecheck`
Expected: clean (no errors). This confirms `globals.d.ts` parses and the new union member is valid.

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat(pipes): readPipesPinned MAIN-world reader + allowlist/type mirror"
```

---

### Task 4: live `pinned` read on the state-watch path

Fetch the lock grid for pipes on each preview refresh and stash it on `puzzleData`, so the preview render has it. Pipes-only and refresh-path-only (not the generic `readGridState`).

**Files:**
- Modify: `src/widget/widget.js` (inside `startStateWatch`, ~line 1136-1138)

- [ ] **Step 1: Add the pinned read before `drawPreview`**

In `src/widget/widget.js`, inside the `startStateWatch` MutationObserver debounced callback, change:

```js
        const state = await readGridState();
        if (!state?.success) return;
        drawPreview(state.grid);
```

to:

```js
        const state = await readGridState();
        if (!state?.success) return;
        // Pipes error overlay needs the page's lock layer; read it here (the
        // live-refresh path) only, so the generic readGridState stays cheap.
        if (puzzleData.type === 'pipes') {
          const pinned = await callMainWorld('readPipesPinned', [state.rows, state.cols]);
          if (pinned) puzzleData.pipesPinned = pinned;
        }
        drawPreview(state.grid);
```

- [ ] **Step 2: Verify lint and typecheck**

Run: `npm run lint`
Expected: clean (no errors).

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
jj commit -m "feat(pipes): read pinned lock layer on the state-watch refresh"
```

---

### Task 5: preview render branch for pipes

Route the pipes mistake computation through the registry hook; reuse the existing red ring+fill renderer (pipes mistakes are `{row,col}`, which already fall to the generic renderer).

**Files:**
- Modify: `src/widget/preview.js` (~line 770-772)

- [ ] **Step 1: Branch the mistake computation**

In `src/widget/preview.js`, inside `if (puzzleData?.solution) {`, replace:

```js
    const mistakes = computePuzzleDiff(
      puzzleData.type, grid, puzzleData.solution, puzzleData.stars);
```

with:

```js
    // Pipes can't use the solver-layer computePuzzleDiff (the rotation math lives
    // in the widget layer). Its registry hook rings only LOCKED cells at the
    // wrong rotation, using the pinned grid the state-watch stashed. The returned
    // {row,col} cells fall through to the generic red-ring renderer below.
    let mistakes;
    if (puzzleData.type === 'pipes') {
      const reg = puzzleReg('pipes');
      mistakes = (reg && reg.lockedMistakes && puzzleData.pipesPinned)
        ? reg.lockedMistakes({
            grid,
            solution: puzzleData.solution,
            task: puzzleData.task,
            pinned: puzzleData.pipesPinned,
          })
        : [];
    } else {
      mistakes = computePuzzleDiff(
        puzzleData.type, grid, puzzleData.solution, puzzleData.stars);
    }
```

(`puzzleReg` is already imported at the top of `preview.js`.)

- [ ] **Step 2: Verify lint and typecheck**

Run: `npm run lint`
Expected: clean.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Verify the content bundle still parses (catches bad widget wiring)**

Run: `node --test tests/bundle.test.js`
Expected: PASS — including "content bundle parses without SyntaxError".

- [ ] **Step 4: Commit**

```bash
jj commit -m "feat(pipes): ring wrong locked cells in the preview overlay"
```

---

### Task 6: full verification gate + build

**Files:** none (verification only).

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS — all tests, including the new `tests/pipes-rotation.test.js` and `tests/pipes-locked.test.js`.

- [ ] **Step 2: Lint and typecheck**

Run: `npm run lint && npm run typecheck`
Expected: both clean.

- [ ] **Step 3: Build the extension bundles**

Run: `npm run build`
Expected: prints `Wrote dist/solver.js` and `Wrote dist/content.js` with no error (this is required because `main-world.js`, `background.js`, and the widget files changed).

- [ ] **Step 4: Final commit (if any working-copy changes remain)**

```bash
jj status
```

If `jj status` shows changes (it should be clean — `dist/` is gitignored and all source was committed per task), there is nothing to do. Otherwise commit any stragglers:

```bash
jj commit -m "chore(pipes): finalize locked-cell error overlay"
```

---

## Manual verification (after merge, on the live page)

Not an automated step — record for the human:

1. Open a pipes puzzle, click the widget's **Detect** (auto-solve runs, caching `puzzleData.solution`).
2. Lock (pin) a cell at the **correct** rotation → no ring appears in the preview.
3. Rotate a locked cell to a **wrong** rotation (or lock a wrong one) → a red ring appears on that cell in the preview within ~200 ms.
4. Lock a **straight** pipe at its 180°-equivalent correct rotation → no ring (symmetry handled).
5. Leave a wrong cell **unlocked** → no ring.
