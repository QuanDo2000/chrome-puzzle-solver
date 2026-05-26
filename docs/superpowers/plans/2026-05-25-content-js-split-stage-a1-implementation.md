# content.js split — Stage A1 (canvas-layer builders) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the 8 canvas-layer builders (~395 LOC, content.js lines 1044-1438) from inside makeWidget into the top level of `src/widget/preview.js`. Same mechanical extraction pattern as Stage A0.

**Architecture:** Each builder takes `ctx` + data args and is pure. After Stage A1, makeWidget's `drawPreview` still calls these by name — resolved via the bundle's flat scope. No closure surgery required.

**Reference spec:** `docs/superpowers/specs/2026-05-25-content-js-split-phase-2-stage-a-design.md` §3 (sub-stage A1).

`jj commit` not git. Repo `/home/quando/documents/chrome-puzzle-solver/`.

---

## What gets extracted

8 functions, all currently inside makeWidget at 2-space indent:

| Function | Inputs |
| --- | --- |
| `buildLatticeLayer` | rows, cols, cellSize, w, h, pd |
| `buildStaticLayer` | rows, cols, cellSize, w, h, pd |
| `drawComparisonCluesOn` | ctx, cellSize, comparisonClues |
| `drawShikakuCluesOn` | ctx, cellSize, clues |
| `drawHashiIslandsOn` | ctx, cellSize, islands |
| `drawHeyawakeRoomsOn` | ctx, rows, cols, cellSize, areas, rooms |
| `drawRegionBordersOn` | ctx, rows, cols, cellSize, rm |
| `drawNonogramGuidesOn` | ctx, rows, cols, cellSize, w, h, pd |

Verified pure: no `staticLayer` / `latticeLayer` / `staticLayerSig` / `puzzleData` references inside the slice. `buildStaticLayer` calls 6 of the 7 helpers; since they all move together, the call chain stays intact.

---

## Task 1: Extract the 8 builders into preview.js

**Files:**
- Modify: `content.js` (remove ~395-line slice from inside makeWidget)
- Modify: `src/widget/preview.js` (append the de-indented slice + extend module.exports)

- [ ] **Step 1: Find boundaries**

```bash
cd /home/quando/documents/chrome-puzzle-solver
grep -n "^  function buildLatticeLayer\|^  function drawNonogramGuidesOn\|^  function drawPreview" content.js
```

Expected: `buildLatticeLayer` opens the slice (~line 1044). `drawNonogramGuidesOn` is the last builder in the block. `drawPreview` is the function immediately AFTER the slice (it stays in content.js for now). The slice ends at the closing `}` of `drawNonogramGuidesOn`, one line before `function drawPreview`.

- [ ] **Step 2: Read the slice**

Use the Read tool on `content.js` with `offset` = line of `buildLatticeLayer` and `limit` = (line of `drawPreview` − 1) − (line of `buildLatticeLayer`) + 1. ~395 lines.

- [ ] **Step 3: Strip the leading 2-space indent**

Same shape as the Stage A0 extraction. Remove the outer 2 spaces from every non-empty line. Blank lines stay blank.

- [ ] **Step 4: Append the de-indented slice to `src/widget/preview.js`**

`preview.js` already contains Stage A0's 14 sig helpers + the `if (typeof module ...)` export footer at the bottom. Insert the de-indented slice BEFORE that export footer. Update the `module.exports` block to add the 8 new names.

Final `src/widget/preview.js` structure:

```
'use strict';
// Canvas-rendering helpers for the puzzle-preview overlay.
// ... existing header ...

// === Stage A0: sig helpers (unchanged from previous commit) ===
let hintIdCounter = 0;
const hintIdCache = new WeakMap();
function hintSig(hint) { ... }
// ... 14 sig functions + FNV constants ...

// === Stage A1: canvas-layer builders (new) ===
function buildLatticeLayer(...) { ... }
function buildStaticLayer(...) { ... }
function drawComparisonCluesOn(...) { ... }
function drawShikakuCluesOn(...) { ... }
function drawHashiIslandsOn(...) { ... }
function drawHeyawakeRoomsOn(...) { ... }
function drawRegionBordersOn(...) { ... }
function drawNonogramGuidesOn(...) { ... }

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    // Stage A0
    hintIdCounter, hintIdCache,
    hintSig, FNV_OFFSET, FNV_PRIME,
    regionMapSig, comparisonCluesSig, shikakuCluesSig,
    slitherlinkCluesSig, hashiIslandsSig, hitoriTaskSig,
    kakurasuCluesSig, kurodokoTaskSig, mosaicTaskSig,
    norinoriAreasSig, nurikabeTaskSig, heyawakeAreasSig,
    gridDataSig,
    // Stage A1
    buildLatticeLayer, buildStaticLayer,
    drawComparisonCluesOn, drawShikakuCluesOn, drawHashiIslandsOn,
    drawHeyawakeRoomsOn, drawRegionBordersOn, drawNonogramGuidesOn,
  };
}
```

Section comment headers (`// === Stage A0 ===` and `// === Stage A1 ===`) are optional — include them if they help navigation.

- [ ] **Step 5: Remove the slice from content.js**

Use the Edit tool: `old_string` = the verbatim slice (with the original 2-space indent), `new_string` = empty.

If the slice is too long for a single Edit, split into two passes (e.g., `buildLatticeLayer`..`drawHashiIslandsOn` in one, `drawHeyawakeRoomsOn`..`drawNonogramGuidesOn` in another).

- [ ] **Step 6: Verify**

```bash
cd /home/quando/documents/chrome-puzzle-solver
npm test 2>&1 | tail -5
npm run build 2>&1 | tail -3
grep -c "function buildLatticeLayer\|function buildStaticLayer\|function drawNonogramGuidesOn" dist/content.js
```

Expected: tests `pass 448 / fail 0`. Build emits `Wrote dist/content.js`. `grep -c` returns `3` (each function appears exactly once in the bundle).

If a test fails with `ReferenceError: <name> is not defined`, the test loader is fine (preview.js is already in widgetOrder from Stage A0), so the failure is more likely a syntax error from incorrect de-indentation in preview.js. Inspect with `node -e "require('./src/widget/preview.js')"` — Node will report the first parse error.

- [ ] **Step 7: Commit**

```bash
cd /home/quando/documents/chrome-puzzle-solver && jj commit -m "refactor(content): extract canvas-layer builders from makeWidget into preview.js"
```

---

## Task 2: Update lint + globals.d.ts + push

**Files:**
- Modify: `eslint.config.js`
- Modify: `globals.d.ts`

makeWidget now references `buildLatticeLayer`, `buildStaticLayer`, and the 6 `draw*On` helpers as if they're in scope (they are, via the bundle). eslint and tsc need explicit declarations.

- [ ] **Step 1: Update eslint config**

Open `eslint.config.js`. Find the `// src/widget/preview.js` block of globals (added in Stage A0). Append after the `gridDataSig: 'readonly',` line:

```js
        buildLatticeLayer: 'readonly',
        buildStaticLayer: 'readonly',
        drawComparisonCluesOn: 'readonly',
        drawShikakuCluesOn: 'readonly',
        drawHashiIslandsOn: 'readonly',
        drawHeyawakeRoomsOn: 'readonly',
        drawRegionBordersOn: 'readonly',
        drawNonogramGuidesOn: 'readonly',
```

- [ ] **Step 2: Update globals.d.ts**

Open `globals.d.ts`. Find the `// src/widget/preview.js` group from Stage A0 (the `declare function gridDataSig(...)` line is the last entry). Append after it:

```ts
declare function buildLatticeLayer(rows: any, cols: any, cellSize: any, w: any, h: any, pd?: any): any;
declare function buildStaticLayer(rows: any, cols: any, cellSize: any, w: any, h: any, pd?: any): any;
declare function drawComparisonCluesOn(ctx: any, cellSize: any, comparisonClues: any): any;
declare function drawShikakuCluesOn(ctx: any, cellSize: any, clues: any): any;
declare function drawHashiIslandsOn(ctx: any, cellSize: any, islands: any): any;
declare function drawHeyawakeRoomsOn(ctx: any, rows: any, cols: any, cellSize: any, areas: any, rooms?: any): any;
declare function drawRegionBordersOn(ctx: any, rows: any, cols: any, cellSize: any, rm: any): any;
declare function drawNonogramGuidesOn(ctx: any, rows: any, cols: any, cellSize: any, w: any, h: any, pd?: any): any;
```

- [ ] **Step 3: Verify**

```bash
cd /home/quando/documents/chrome-puzzle-solver
npm run lint 2>&1 | tail -3
npm run typecheck 2>&1 | tail -3
npm test 2>&1 | tail -5
npm run build 2>&1 | tail -3
```

Expected: all clean. tests `448/448`. build prints `Wrote dist/content.js`.

- [ ] **Step 4: Commit and push**

```bash
cd /home/quando/documents/chrome-puzzle-solver
jj commit -m "lint(content): preview.js canvas-builder globals in eslint + globals.d.ts"
jj log -r 'main..@-' --no-graph -T 'commit_id.short() ++ "  " ++ description.first_line() ++ "\n"'
jj bookmark set main -r @-
jj git push --bookmark main 2>&1 | tail -3
```

Expected: 2 commits ahead of main (Tasks 1 and 2); clean push.

---

## Self-review notes

**Spec coverage (Stage A1 only):**
- Spec §3 sub-stage A1 (canvas-layer builders into preview.js) → Task 1. ✓
- Spec §7 (npm test green at every commit) → verified at end of each task. ✓

**Out of this plan** (future Stage A2 / A3):
- `drawPreview` itself — stays inside makeWidget for now.
- makeWidget shell extraction to `widget.js`.

**Placeholder scan:** No "TBD" / "implement later". Each step has a concrete command or code block. Boundaries use grep.

**Type consistency:** Names in eslint, globals.d.ts, and module.exports all match the 8 function declarations.

End of plan.
