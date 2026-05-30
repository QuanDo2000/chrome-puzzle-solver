# Widget helper dedup (drawCrossCell / absoluteCellHintStatus / makeSimpleHintDispatch) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract three duplicated widget-module patterns into `src/widget/shared.js`: the grey `×` confirmed-empty glyph (`drawCrossCell`), the single-cell hint-status template (`absoluteCellHintStatus`), and the simple synchronous hint dispatcher (`makeSimpleHintDispatch`).

**Architecture:** `src/widget/shared.js` already exists (exports `hashFNV1a`) and is wired into `build-content-bundle.js` (concatenated first; consumer `require('../shared.js')` stripped; fail-loud guards). Puzzle modules (`src/widget/puzzles/*.js`) are consumed two ways: Node `require` (tests/puzzle-modules.test.js) and concatenation into `dist/content.js`. `absoluteCellHintStatus` is exercised by puzzle-modules.test.js (pure `hintStatusNodes` hook); `drawCrossCell` and `makeSimpleHintDispatch` are side-effect hooks not unit-tested today, so this plan adds dedicated unit tests for them plus relies on the content-bundle parse check (`tests/bundle.test.js`).

**Tech Stack:** Node.js (`node:test`), CommonJS, `build-content-bundle.js` concatenator. Version control: **`jj`, never `git`**.

**Source spec:** `docs/superpowers/specs/2026-05-29-solver-shared-utils-design.md` (the widget-layer helpers).

**Critical constraint — lazy solver reference.** `manifest.json` content_scripts load `["solver.js", "content.js"]`, so solver classes (`HitoriSolver`, …) are content-script globals. But the puzzle modules are also `require`d standalone by tests/puzzle-modules.test.js, where those globals do NOT exist. The current `hintDispatch(ctx) { … new HitoriSolver(…) }` is safe because the class is only referenced when the method is CALLED (never in those tests). `makeSimpleHintDispatch` MUST preserve this: it takes a `makeSolver(ctx)` **thunk** (e.g. `(ctx) => new HitoriSolver(…)`) so the class is referenced only at call time, not at module load. Passing a bare class reference would throw `ReferenceError` when puzzle-modules.test.js requires the module.

**Established facts (from grounding):**
- The `×` block (`drawPreviewCell` `v === 2` arm) is byte-identical across kurodoko, mosaic, norinori, nurikabe, kakurasu, heyawake:
  ```js
  const pad = Math.max(3, Math.floor(cellSize * 0.25));
  ctx.strokeStyle = '#9ca3af';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x + pad, y + pad);
  ctx.lineTo(x + cellSize - pad, y + cellSize - pad);
  ctx.moveTo(x + cellSize - pad, y + pad);
  ctx.lineTo(x + pad, y + cellSize - pad);
  ctx.stroke();
  ```
  (hitori is EXCLUDED — its `v===2` is a light-grey fill, not the `×`.)
- The single-cell `hintStatusNodes` template is identical modulo the two labels (hitori `shaded`/`unshaded`, kurodoko `black`/`white`, …):
  ```js
  hintStatusNodes(h, { bold }) {
    const cells = h.extraCells || [];
    if (cells.length === 0) return ['No hint available'];
    if (cells.length === 1) {
      const cell = cells[0];
      const valueStr = cell.value === 1 ? '<V1>' : '<V2>';
      return ['Cell ', bold(`(row ${cell.row + 1}, col ${cell.col + 1})`), ' must be ', bold(valueStr)];
    }
    if (h._fullCount && h._fullCount > cells.length) {
      return [bold(String(cells.length)), ` (of ${h._fullCount}) cells can be deduced`];
    }
    return [bold(String(cells.length)), ' cells can be deduced'];
  }
  ```
- The simple `hintDispatch` is identical modulo solver construction + `type` across **7** modules (hitori, kurodoko, mosaic, norinori, nurikabe, kakurasu, heyawake). **binairo and yinyang are EXCLUDED**: their `getHint` returns a hint *object* directly (`const hint = solver.getHint(grid); if (!hint) …; return { success: true, hint, … }`) rather than a cell *array* that gets wrapped in `{ type, extraCells, count }` — a different shape that `makeSimpleHintDispatch` does not cover. The cohort below is the array-wrapping form:
  ```js
  hintDispatch(ctx) {
    const { detectedGrid, grid, solution, rows, cols, firstMismatch } = ctx;
    if (solution && firstMismatch(grid, solution)) {
      return { success: false, error: 'Current game state is wrong.' };
    }
    const solver = new <Solver>({ … from ctx … });
    const hintCells = solver.getHint(grid);
    if (!hintCells || hintCells.length === 0) {
      return { success: false, error: 'No more cells can be deduced from the current state. Click Solve to finish.' };
    }
    const hint = { type: '<type>', extraCells: hintCells, count: hintCells.length };
    return { success: true, hint, grid, solution };
  }
  ```

---

## Task 1: Extract `drawCrossCell`

**Files:** Modify `src/widget/shared.js`, the 6 `×`-drawing puzzle modules, `tests/shared-utils.test.js`.

- [ ] **Step 1: Add the helper to `src/widget/shared.js`** (before the CJS export tail).
```js
// Grey diagonal × for a confirmed-empty cell — the shared "v===2" glyph used by
// the cell-state puzzle previews (kurodoko, mosaic, norinori, nurikabe,
// kakurasu, heyawake). Hitori intentionally does NOT use this (its v=2 is a
// light fill).
function drawCrossCell(ctx, x, y, cellSize) {
  const pad = Math.max(3, Math.floor(cellSize * 0.25));
  ctx.strokeStyle = '#9ca3af';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x + pad, y + pad);
  ctx.lineTo(x + cellSize - pad, y + cellSize - pad);
  ctx.moveTo(x + cellSize - pad, y + pad);
  ctx.lineTo(x + pad, y + cellSize - pad);
  ctx.stroke();
}
```
Add `drawCrossCell` to `module.exports`.

- [ ] **Step 2: Unit test** (mock ctx records the call sequence). Append to `tests/shared-utils.test.js`:
```js
test('drawCrossCell draws a padded diagonal cross', () => {
  const calls = [];
  const ctx = {
    set strokeStyle(v) { calls.push(['strokeStyle', v]); },
    set lineWidth(v) { calls.push(['lineWidth', v]); },
    beginPath() { calls.push(['beginPath']); },
    moveTo(a, b) { calls.push(['moveTo', a, b]); },
    lineTo(a, b) { calls.push(['lineTo', a, b]); },
    stroke() { calls.push(['stroke']); },
  };
  widgetShared.drawCrossCell(ctx, 0, 0, 20); // pad = max(3, floor(5)) = 5
  assert.deepEqual(calls, [
    ['strokeStyle', '#9ca3af'], ['lineWidth', 2], ['beginPath'],
    ['moveTo', 5, 5], ['lineTo', 15, 15],
    ['moveTo', 15, 5], ['lineTo', 5, 15],
    ['stroke'],
  ]);
});
```
(`widgetShared` is already required at the top of the file.) Run `node --test tests/shared-utils.test.js` → all pass.

- [ ] **Step 3: Swap the 6 modules.** For EACH of `kurodoko, mosaic, norinori, nurikabe, kakurasu, heyawake` in `src/widget/puzzles/`:
1. Confirm its `drawPreviewCell` `v === 2` arm matches the canonical `×` block above. If it differs, EXCLUDE and report.
2. Ensure the file imports from shared: add `drawCrossCell` to its `const { … } = require('../shared.js');` line (create the require if the module doesn't have one yet — but all 6 already import `hashFNV1a`).
3. Replace the `×` block inside the `} else if (v === 2) {` arm with a single call:
```js
    } else if (v === 2) {
      drawCrossCell(ctx, x, y, cellSize);
    }
```
Keep the surrounding `if (v === 1) { … }` arm and any clue-digit overlay code unchanged.

- [ ] **Step 4: Full gate.**
Run: `npm run build && npm test && npm run lint && npm run typecheck`
Expected: build writes both bundles; `tests/bundle.test.js` content-parse passes (catches a broken content bundle); puzzle-modules.test.js passes; 0 lint errors; typecheck clean.
Also: `grep -c "require('../shared.js')\|require('./shared.js')" dist/content.js` → `0` (all stripped).

- [ ] **Step 5: Commit.**
```bash
jj commit -m "refactor(widget): extract confirmed-empty × glyph to shared drawCrossCell"
```
(End with a blank line then `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.)

---

## Task 2: Extract `absoluteCellHintStatus`

**Files:** Modify `src/widget/shared.js`, the single-cell-hint-status puzzle modules, `tests/shared-utils.test.js`.

- [ ] **Step 1: Add the helper to `src/widget/shared.js`.**
```js
// Single-cell hint-status template for absolute-cell puzzles. `h.extraCells` is
// a flat list of forced {row,col,value} cells; value 1 → v1Label, else v2Label.
function absoluteCellHintStatus(h, { bold }, v1Label, v2Label) {
  const cells = h.extraCells || [];
  if (cells.length === 0) return ['No hint available'];
  if (cells.length === 1) {
    const cell = cells[0];
    const valueStr = cell.value === 1 ? v1Label : v2Label;
    return ['Cell ', bold(`(row ${cell.row + 1}, col ${cell.col + 1})`), ' must be ', bold(valueStr)];
  }
  if (h._fullCount && h._fullCount > cells.length) {
    return [bold(String(cells.length)), ` (of ${h._fullCount}) cells can be deduced`];
  }
  return [bold(String(cells.length)), ' cells can be deduced'];
}
```
Add `absoluteCellHintStatus` to `module.exports`.

- [ ] **Step 2: Unit test.** Append to `tests/shared-utils.test.js`:
```js
test('absoluteCellHintStatus formats single-cell, multi-cell, and partial', () => {
  const bold = (t) => ({ b: t }); // distinguishable marker
  // single cell, value 1 → v1 label
  assert.deepEqual(
    widgetShared.absoluteCellHintStatus({ extraCells: [{ row: 0, col: 2, value: 1 }] }, { bold }, 'black', 'white'),
    ['Cell ', { b: '(row 1, col 3)' }, ' must be ', { b: 'black' }]);
  // single cell, value 2 → v2 label
  assert.deepEqual(
    widgetShared.absoluteCellHintStatus({ extraCells: [{ row: 1, col: 0, value: 2 }] }, { bold }, 'black', 'white'),
    ['Cell ', { b: '(row 2, col 1)' }, ' must be ', { b: 'white' }]);
  // none
  assert.deepEqual(widgetShared.absoluteCellHintStatus({ extraCells: [] }, { bold }, 'black', 'white'), ['No hint available']);
  // multi with fullCount
  assert.deepEqual(
    widgetShared.absoluteCellHintStatus({ extraCells: [{}, {}], _fullCount: 5 }, { bold }, 'black', 'white'),
    [{ b: '2' }, ' (of 5) cells can be deduced']);
  // multi without fullCount
  assert.deepEqual(
    widgetShared.absoluteCellHintStatus({ extraCells: [{}, {}, {}] }, { bold }, 'black', 'white'),
    [{ b: '3' }, ' cells can be deduced']);
});
```
Run `node --test tests/shared-utils.test.js` → all pass.

- [ ] **Step 3: Discover + swap.** Run `grep -rln "must be ', bold" src/widget/puzzles/*.js` to find modules whose `hintStatusNodes` uses this exact template. For EACH (expected: hitori, kurodoko, mosaic, norinori, nurikabe, kakurasu, heyawake — verify):
1. Read its `hintStatusNodes` and confirm it matches the canonical template, noting the two labels (the `cell.value === 1 ? 'X' : 'Y'` strings).
2. Add `absoluteCellHintStatus` to its `require('../shared.js')` destructure.
3. Replace the whole `hintStatusNodes(h, { bold }) { … }` method body with a delegation using THAT module's labels, e.g. for hitori:
```js
  hintStatusNodes(h, ctx) {
    return absoluteCellHintStatus(h, ctx, 'shaded', 'unshaded');
  },
```
(Use each module's actual labels read from source: hitori & kurodoko both `'shaded','unshaded'`; kakurasu `'filled','empty'`; heyawake `'black','white'`; mosaic/norinori/nurikabe — read each.)
4. If a module's `hintStatusNodes` differs structurally (not the absolute-cell template — e.g. binairo/yinyang/aquarium use row/col or chunk descriptions), EXCLUDE it and report.

- [ ] **Step 4: Full gate.**
Run: `npm run build && npm test && npm run lint && npm run typecheck` → all green. `tests/puzzle-modules.test.js` exercises `hintStatusNodes` for each module (real oracle — green means the delegation produces identical node arrays). `grep -c "require('../shared.js')\|require('./shared.js')" dist/content.js` → 0.

- [ ] **Step 5: Commit.**
```bash
jj commit -m "refactor(widget): extract single-cell hint-status to shared absoluteCellHintStatus"
```
(+ trailer.)

---

## Task 3: Extract `makeSimpleHintDispatch`

**Files:** Modify `src/widget/shared.js`, the 9 simple-hintDispatch puzzle modules, `tests/shared-utils.test.js`.

- [ ] **Step 1: Add the factory to `src/widget/shared.js`.**
```js
// Factory for the simple synchronous hint dispatcher shared by the cell-state
// puzzles. `makeSolver(ctx)` is a THUNK that constructs the solver from ctx —
// it MUST defer the solver-class reference to call time so the puzzle module
// stays require-safe under Node (where solver classes aren't globals).
function makeSimpleHintDispatch(type, makeSolver) {
  return function hintDispatch(ctx) {
    const { grid, solution, firstMismatch } = ctx;
    if (solution && firstMismatch(grid, solution)) {
      return { success: false, error: 'Current game state is wrong.' };
    }
    const solver = makeSolver(ctx);
    const hintCells = solver.getHint(grid);
    if (!hintCells || hintCells.length === 0) {
      return { success: false, error: 'No more cells can be deduced from the current state. Click Solve to finish.' };
    }
    return { success: true, hint: { type, extraCells: hintCells, count: hintCells.length }, grid, solution };
  };
}
```
Add `makeSimpleHintDispatch` to `module.exports`.

- [ ] **Step 2: Unit test** (stub makeSolver + ctx; cover all three branches). Append to `tests/shared-utils.test.js`:
```js
test('makeSimpleHintDispatch: wrong-state, no-hint, and success branches', () => {
  const okCtx = { grid: 'G', solution: 'S', firstMismatch: () => false };
  // wrong state
  const wrong = widgetShared.makeSimpleHintDispatch('t', () => { throw new Error('should not construct'); })(
    { grid: 'G', solution: 'S', firstMismatch: () => true });
  assert.deepEqual(wrong, { success: false, error: 'Current game state is wrong.' });
  // no hint
  const none = widgetShared.makeSimpleHintDispatch('t', () => ({ getHint: () => [] }))(okCtx);
  assert.equal(none.success, false);
  assert.match(none.error, /No more cells/);
  // success
  const cells = [{ row: 0, col: 0, value: 1 }];
  const ok = widgetShared.makeSimpleHintDispatch('hitori', () => ({ getHint: () => cells }))(okCtx);
  assert.deepEqual(ok, { success: true, hint: { type: 'hitori', extraCells: cells, count: 1 }, grid: 'G', solution: 'S' });
});
```
Run `node --test tests/shared-utils.test.js` → all pass.

- [ ] **Step 3: Discover + swap.** Run `grep -rln "solver.getHint(grid)" src/widget/puzzles/*.js`. Expected cohort (array-wrapping form): **hitori, kurodoko, mosaic, norinori, nurikabe, kakurasu, heyawake**. For EACH:
1. Read its `hintDispatch(ctx)` and confirm it matches the canonical shape (mismatch check → `new Solver(...)` → `const hintCells = solver.getHint(grid)` → `if (!hintCells || hintCells.length === 0)` → `{ success:true, hint:{type, extraCells: hintCells, count: hintCells.length}, grid, solution }`). Note the solver construction expression and the `type` string. **binairo and yinyang do NOT match** (they do `const hint = solver.getHint(grid); if (!hint) …; return { success:true, hint, … }` — no array wrap) — EXCLUDE them. aquarium/shikaku/slitherlink/hashi/galaxies also excluded (richer/async dispatchers).
2. Add `makeSimpleHintDispatch` to its `require('../shared.js')` destructure.
3. Replace the `hintDispatch(ctx) { … }` method with a property using a `makeSolver` THUNK that reproduces the original construction verbatim, e.g. hitori:
```js
  hintDispatch: makeSimpleHintDispatch('hitori', (ctx) =>
    new HitoriSolver({ rows: ctx.rows, cols: ctx.cols, task: ctx.detectedGrid.task })),
```
   For binairo: `(ctx) => new BinairoSolver({ rows: ctx.rows, cols: ctx.cols, initialGrid: ctx.detectedGrid.grid, compConstraints: ctx.detectedGrid.compConstraints })`. Use EACH module's exact original construction (read it). The thunk references the solver class lazily (only called at runtime), so Node require stays safe.
4. If a module's `hintDispatch` does anything beyond the canonical shape (e.g. extra pre/post logic, async, cache fallback like aquarium), EXCLUDE it and report. (aquarium/shikaku/slitherlink/hashi/galaxies are NOT in the cohort — they have richer dispatchers.)

- [ ] **Step 4: Require-safety check (critical).** Run `node --test tests/puzzle-modules.test.js` → all pass. This REQUIRES every puzzle module in Node; if any `makeSolver` thunk evaluated its solver class at module load, this throws `ReferenceError`. Green confirms the thunks defer correctly.

- [ ] **Step 5: Full gate.**
Run: `npm run build && npm test && npm run lint && npm run typecheck` → all green. `tests/bundle.test.js` content-parse passes. `grep -c "require('../shared.js')\|require('./shared.js')" dist/content.js` → 0.

- [ ] **Step 6: Commit.**
```bash
jj commit -m "refactor(widget): extract simple hint dispatch to shared makeSimpleHintDispatch"
```
(+ trailer.)

---

## Task 4: Docs + final verification

**Files:** Modify `CLAUDE.md`.

- [ ] **Step 1: Extend the shared-utils note.** In `CLAUDE.md`'s "### Shared utilities + bundler require-strip" subsection, add the widget-layer helpers to the list (so it notes the widget `shared.js` now holds `drawCrossCell`, `absoluteCellHintStatus`, `makeSimpleHintDispatch` alongside `hashFNV1a`).

- [ ] **Step 2: Final full gate.**
Run: `npm run build && npm test && npm run lint && npm run typecheck` → all green.
Confirm exports: `node -e "console.log(Object.keys(require('./src/widget/shared.js')).sort().join(','))"` → `absoluteCellHintStatus,drawCrossCell,hashFNV1a,makeSimpleHintDispatch`.

- [ ] **Step 3: Commit.**
```bash
jj commit -m "docs: list widget shared helpers (drawCrossCell/absoluteCellHintStatus/makeSimpleHintDispatch)"
```
(+ trailer.)

---

## Self-Review notes (for the executor)

- **Oracles:** `absoluteCellHintStatus` is covered by tests/puzzle-modules.test.js (`hintStatusNodes` is a tested pure hook). `drawCrossCell` and `makeSimpleHintDispatch` get dedicated unit tests in this plan (mock ctx / stub makeSolver) plus the content-bundle parse check; behavior is also covered by integration paths. Green `npm test` after each swap is the proof.
- **The require-safety check (Task 3 Step 4) is mandatory** — the `makeSolver` thunk is what keeps the modules require-safe in Node; a bare class reference would break puzzle-modules.test.js.
- **Verify-from-source + EXCLUDE** any module that differs (hitori excluded from drawCrossCell; binairo/yinyang/aquarium excluded from absoluteCellHintStatus if their hint-status differs; aquarium/shikaku/slitherlink/hashi/galaxies excluded from makeSimpleHintDispatch).
- **jj only** for commits.
