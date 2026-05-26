# content.js split — Stage A0 (sig helpers) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the 14 sig-hash helpers (~215 LOC, content.js lines 1041-1255) from inside the makeWidget closure into a new `src/widget/preview.js`. Pure mechanical extraction — no closure surgery — validates that we can pull functions out of makeWidget before tackling the harder Stage A2 (drawPreview promotion) and Stage A3 (full widget extraction).

**Architecture:** Each sig function is currently nested inside makeWidget at 2-space indent. After Stage A0 they're top-level functions in `preview.js`, visible to makeWidget through the bundle's flat scope. The two FNV constants and the `hintSig` id-cache come along for the ride (they're declared between functions in the slice). Bundler order: `preview.js` slots between `hint.js` and `puzzles/index.js`.

**Reference spec:** `docs/superpowers/specs/2026-05-25-content-js-split-phase-2-stage-a-design.md` (§3 only).

`jj commit` not git. Repo `/home/quando/documents/chrome-puzzle-solver/`.

---

## What gets extracted

content.js lines 1041-1255 (roughly — implementer should re-grep). The block opens with:

```js
  let hintIdCounter = 0;
  const hintIdCache = new WeakMap();

  function hintSig(hint) {
    ...
```

and closes with the final `}` of `gridDataSig` (the last sig function before `buildLatticeLayer`).

The 14 sig functions, their containing module-level helpers, and a comment block:

| Symbol | Type |
| --- | --- |
| `hintIdCounter` | `let` (state for `hintSig`) |
| `hintIdCache` | `const` (WeakMap for `hintSig`) |
| `hintSig` | function |
| `FNV_OFFSET`, `FNV_PRIME` | `const`s (with comment) |
| `regionMapSig` | function |
| `comparisonCluesSig` | function |
| `shikakuCluesSig` | function |
| `slitherlinkCluesSig` | function |
| `hashiIslandsSig` | function |
| `hitoriTaskSig` | function |
| `kakurasuCluesSig` | function |
| `kurodokoTaskSig` | function |
| `mosaicTaskSig` | function |
| `norinoriAreasSig` | function |
| `nurikabeTaskSig` | function |
| `heyawakeAreasSig` | function |
| `gridDataSig` | function |

All are pure (parameter-only inputs). The `hintSig`'s WeakMap/counter state moves with it; nothing else captures closure state from makeWidget.

---

## Task 1: Create `src/widget/preview.js` scaffold + wire bundler + test loader

**Files:**
- Create: `src/widget/preview.js`
- Modify: `scripts/build-content-bundle.js`
- Modify: `tests/galaxies-hint.test.js`

After this task, `preview.js` exists as an empty placeholder. The bundler includes it (no-op while empty); test loader includes it. `npm run build` and `npm test` keep working.

- [ ] **Step 1: Create the placeholder file**

Write `/home/quando/documents/chrome-puzzle-solver/src/widget/preview.js`:

```js
'use strict';
// Canvas-rendering helpers for the puzzle-preview overlay. Extracted
// from content.js's makeWidget closure (Stage A of the Phase 2
// refactor — see docs/superpowers/specs/2026-05-25-content-js-split-
// phase-2-stage-a-design.md). Stage A0 lands the sig hashers; Stage
// A1 follows with the canvas-layer builders; Stage A2 promotes
// drawPreview.

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {};
}
```

- [ ] **Step 2: Add `preview.js` to the bundler's WIDGET_FILES**

Open `scripts/build-content-bundle.js`. Find:

```js
const WIDGET_FILES = [
  'state.js',
  'worker.js',
  'cache.js',
  'galaxies-hint.js',
  'hint.js',
  'puzzles/index.js',
];
```

Insert `'preview.js'` between `'hint.js'` and `'puzzles/index.js'`:

```js
const WIDGET_FILES = [
  'state.js',
  'worker.js',
  'cache.js',
  'galaxies-hint.js',
  'hint.js',
  'preview.js',
  'puzzles/index.js',
];
```

- [ ] **Step 3: Add `preview.js` to the test loader's widgetOrder**

Open `tests/galaxies-hint.test.js`. Find:

```js
  const widgetOrder = ['state.js', 'worker.js', 'cache.js',
                        'galaxies-hint.js', 'hint.js', 'puzzles/index.js'];
```

Replace with:

```js
  const widgetOrder = ['state.js', 'worker.js', 'cache.js',
                        'galaxies-hint.js', 'hint.js', 'preview.js',
                        'puzzles/index.js'];
```

- [ ] **Step 4: Verify**

```bash
cd /home/quando/documents/chrome-puzzle-solver
npm test 2>&1 | tail -5
npm run build 2>&1 | tail -3
ls -la src/widget/preview.js
```

Expected: `pass 448 / fail 0`. Build prints `Wrote dist/content.js`. preview.js is ~10 lines (header + empty exports).

- [ ] **Step 5: Commit**

```bash
jj commit -m "build(content): preview.js scaffold + bundler + test loader wiring (Stage A0 setup)"
```

---

## Task 2: Move the 14 sig helpers from makeWidget to `preview.js`

**Files:**
- Modify: `content.js` (remove ~215-line slice from inside makeWidget)
- Modify: `src/widget/preview.js` (append the slice)

The slice currently sits at 2-space indent inside makeWidget. After extraction it lives at 0-space indent in `preview.js`. makeWidget continues to call these by name — they resolve via the bundle's flat scope.

- [ ] **Step 1: Find boundaries**

```bash
cd /home/quando/documents/chrome-puzzle-solver
grep -n "^  let hintIdCounter\|^  const hintIdCache\|^  function buildLatticeLayer\|^  function gridDataSig" content.js
```

Expected (current line numbers; may shift if you have unrelated edits):
- `let hintIdCounter = 0;` opens the slice.
- `function gridDataSig` is the last sig function in the slice.
- The slice ends at the closing `}` of `gridDataSig` — the line right before `function buildLatticeLayer`.

The slice is roughly 215 lines at 2-space indent.

- [ ] **Step 2: Read the slice**

Use the Read tool on `content.js` with `offset` = line of `let hintIdCounter` and `limit` = (line of `function buildLatticeLayer` - 1) - (line of `let hintIdCounter`) + 1. Should be ~215 lines.

The Read result shows each line with `cat -n`-style prefixes; ignore those and use only the body. The body lines start with 2 spaces.

- [ ] **Step 3: Strip the leading 2-space indent**

In your editor / before writing to preview.js, remove the leading two spaces from every non-empty line of the slice. Blank lines stay blank.

For example, `  function hintSig(hint) {` becomes `function hintSig(hint) {`. `    let id = hintIdCache.get(hint);` becomes `  let id = hintIdCache.get(hint);` (the inner indent is preserved; only the outer 2 spaces strip).

- [ ] **Step 4: Append the de-indented slice to `src/widget/preview.js`**

Replace `preview.js`'s current content with:

```
'use strict';
// Canvas-rendering helpers for the puzzle-preview overlay. Extracted
// from content.js's makeWidget closure (Stage A of the Phase 2
// refactor — see docs/superpowers/specs/2026-05-25-content-js-split-
// phase-2-stage-a-design.md). Stage A0 lands the sig hashers; Stage
// A1 follows with the canvas-layer builders; Stage A2 promotes
// drawPreview.

<de-indented slice from step 3>

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    hintIdCounter, hintIdCache,
    hintSig, FNV_OFFSET, FNV_PRIME,
    regionMapSig, comparisonCluesSig, shikakuCluesSig,
    slitherlinkCluesSig, hashiIslandsSig, hitoriTaskSig,
    kakurasuCluesSig, kurodokoTaskSig, mosaicTaskSig,
    norinoriAreasSig, nurikabeTaskSig, heyawakeAreasSig,
    gridDataSig,
  };
}
```

One blank line between the slice and the export footer.

- [ ] **Step 5: Remove the slice from content.js**

Use the Edit tool: `old_string` = the verbatim slice from step 2 (with the original 2-space indent), `new_string` = empty.

If the slice is too large for one Edit, split into two passes (e.g., one for `hintIdCounter`..`hashiIslandsSig`, another for `hitoriTaskSig`..`gridDataSig`).

- [ ] **Step 6: Verify the symbols still resolve in makeWidget**

```bash
cd /home/quando/documents/chrome-puzzle-solver
npm test 2>&1 | tail -5
npm run build 2>&1 | tail -3
```

Expected: `pass 448 / fail 0`. `Wrote dist/content.js`.

If `npm test` fails with `ReferenceError: hintSig is not defined` (or any similar sig name), the test loader's widgetOrder isn't picking up preview.js, OR the slice in preview.js has a syntax error from incorrect de-indentation.

- [ ] **Step 7: Quick consistency check on dist/content.js**

```bash
grep -c "function hintSig\|function regionMapSig\|function gridDataSig" dist/content.js
```

Expected: `3` (each function appears once in the bundle).

- [ ] **Step 8: Commit**

```bash
jj commit -m "refactor(content): extract sig helpers from makeWidget into src/widget/preview.js"
```

---

## Task 3: Update lint config + globals.d.ts for the new cross-file symbols

**Files:**
- Modify: `eslint.config.js`
- Modify: `globals.d.ts`

After Task 2, makeWidget references `hintSig`, `regionMapSig`, etc. as if they were already in scope — which they are, via the bundle. But eslint and tsc check files in isolation. Add explicit declarations so `npm run lint` and `npm run typecheck` stay clean.

- [ ] **Step 1: Update eslint config**

Open `eslint.config.js`. Find the block that begins `files: ['content.js', 'src/widget/**/*.js']` and lists per-symbol globals. Inside its `globals: { ... }` body, append after the existing `// src/widget/hint.js` group:

```js
        // src/widget/preview.js
        hintIdCounter: 'writable',
        hintIdCache: 'readonly',
        hintSig: 'readonly',
        FNV_OFFSET: 'readonly',
        FNV_PRIME: 'readonly',
        regionMapSig: 'readonly',
        comparisonCluesSig: 'readonly',
        shikakuCluesSig: 'readonly',
        slitherlinkCluesSig: 'readonly',
        hashiIslandsSig: 'readonly',
        hitoriTaskSig: 'readonly',
        kakurasuCluesSig: 'readonly',
        kurodokoTaskSig: 'readonly',
        mosaicTaskSig: 'readonly',
        norinoriAreasSig: 'readonly',
        nurikabeTaskSig: 'readonly',
        heyawakeAreasSig: 'readonly',
        gridDataSig: 'readonly',
```

- [ ] **Step 2: Update globals.d.ts**

Open `globals.d.ts`. Find the `// src/widget/hint.js` ambient-declaration group near the end of the file. Append after the last declaration in that group:

```ts
declare let hintIdCounter: any;
declare const hintIdCache: any;
declare function hintSig(hint: any): any;
declare const FNV_OFFSET: any;
declare const FNV_PRIME: any;
declare function regionMapSig(rm: any): any;
declare function comparisonCluesSig(cc: any): any;
declare function shikakuCluesSig(clues: any): any;
declare function slitherlinkCluesSig(task: any): any;
declare function hashiIslandsSig(islands: any): any;
declare function hitoriTaskSig(task: any): any;
declare function kakurasuCluesSig(rowClues: any, colClues: any): any;
declare function kurodokoTaskSig(task: any): any;
declare function mosaicTaskSig(task: any): any;
declare function norinoriAreasSig(areas: any): any;
declare function nurikabeTaskSig(task: any): any;
declare function heyawakeAreasSig(areas: any, rooms?: any): any;
declare function gridDataSig(grid: any): any;
```

- [ ] **Step 3: Verify**

```bash
cd /home/quando/documents/chrome-puzzle-solver
npm run lint 2>&1 | tail -3
npm run typecheck 2>&1 | tail -3
npm test 2>&1 | tail -5
npm run build 2>&1 | tail -3
```

Expected: all four commands clean (lint: no errors; typecheck: no errors; tests: 448/448 pass; build: `Wrote dist/content.js`).

If lint complains about any sig name not being defined, double-check the spelling in the globals block matches the function declaration in preview.js.

- [ ] **Step 4: Final smoke and push**

```bash
jj log -r 'main..@-' --no-graph -T 'commit_id.short() ++ "  " ++ description.first_line() ++ "\n"'
jj commit -m "lint(content): widget preview.js globals in eslint + globals.d.ts"
jj bookmark set main -r @-
jj git push --bookmark main 2>&1 | tail -3
```

Expected: 3 commits ahead of main (Tasks 1, 2, 3); clean push.

---

## Self-review notes

**Spec coverage (Stage A0 — sig helpers only — out of the larger Stage A spec):**

- Spec §3 Sub-stage A1 sig helpers → Task 2. ✓
- Spec §6 step 1 (preview.js scaffold + bundler + test loader wiring) → Task 1. ✓
- Spec §7 testing (`npm test` green at every commit) → verified at end of each task. ✓
- Spec §8 risks — `hintIdCache`/`hintIdCounter` are explicitly carried with `hintSig` to preserve its memoization state; `FNV_OFFSET`/`FNV_PRIME` likewise. ✓

**Explicitly NOT in this plan** (future Stage A1 / A2 / A3 plans):

- Canvas-layer builders (`buildLatticeLayer`, `buildStaticLayer`, the eight `draw*On` helpers) — they stay inside makeWidget for now.
- `drawPreview` itself — stays inside makeWidget.
- makeWidget shell extraction to `widget.js`.

**Placeholder scan:** No "TBD" / "implement later" — each step has a concrete code block, grep command, or Edit operation. Boundaries are grep-discovered, not hardcoded line numbers, because the slice may shift if content.js is touched between when the plan was written and when it's executed.

**Type consistency:** Identifier names in module.exports, eslint globals, and globals.d.ts declarations all match the function names in the slice (verified against content.js lines 1041-1255).

End of plan.
