# content.js split — Stage A2 (drawPreview promotion) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the ~705-line `drawPreview` function out of makeWidget into `src/widget/preview.js`. The function captures 4 closure refs (`canvas`, `puzzleData`, `q` for body width, and the 3 cache locals `latticeLayer` / `staticLayer` / `staticLayerSig`). Cache locals lift to module scope; the other refs become parameters. makeWidget keeps a 1-line `drawPreview` arrow-wrapper so the 9 call sites stay unchanged.

**Architecture:** Top-level in preview.js: `function renderPreview(canvas, puzzleData, grid, hint, bodyWidth)` — the body verbatim from current drawPreview after de-indentation. Inside makeWidget: `const drawPreview = (grid, hint) => renderPreview(canvas, puzzleData, grid, hint, q('.ns-body').clientWidth || 300);`. Per-puzzle render arms (the giant `if (isNurikabe) ... else if (isBinairo) ...` switch on cellStatus) stay inline inside renderPreview — Stage C migrates them to the registry pattern, not Stage A.

**Reference spec:** `docs/superpowers/specs/2026-05-25-content-js-split-phase-2-stage-a-design.md` §4 (sub-stage A2).

`jj commit` not git. Repo `/home/quando/documents/chrome-puzzle-solver/`.

---

## What changes

Current state inside makeWidget (line numbers may have shifted slightly — always re-grep):

```js
  let latticeLayer = null;            // line ~1033
  let staticLayer = null;             // line ~1034
  let staticLayerSig = null;          // line ~1035

  function drawPreview(grid, hint) {  // line ~1041
    // ... ~705 lines that reference canvas (4×), puzzleData (40×),
    //     q('.ns-body').clientWidth (1×), and the 3 cache locals.
  }                                   // ends at line ~1746
```

After Stage A2:

```js
// src/widget/preview.js (appended after Stage A1's canvas-layer builders)
let latticeLayer = null;
let staticLayer = null;
let staticLayerSig = null;

function renderPreview(canvas, puzzleData, grid, hint, bodyWidth) {
  // ... ~705-line body verbatim, with one targeted replacement:
  //     q('.ns-body').clientWidth || 300   →   bodyWidth
}
```

```js
// content.js inside makeWidget (replaces the original declarations)
const drawPreview = (grid, hint) =>
  renderPreview(canvas, puzzleData, grid, hint, q('.ns-body').clientWidth || 300);
```

Cache locals are now module-scope in preview.js. The single `q('.ns-body').clientWidth || 300` reference inside drawPreview becomes the `bodyWidth` parameter. All 40 `puzzleData` and 4 `canvas` references resolve to the renderPreview parameters. The 9 existing `drawPreview(grid, hint)` call sites inside makeWidget keep working unchanged because the arrow wrapper preserves the original signature.

---

## Task 1: Move drawPreview body to renderPreview in preview.js

**Files:**
- Modify: `content.js` (remove the cache locals declaration + the drawPreview body; add a 1-line arrow wrapper)
- Modify: `src/widget/preview.js` (append cache locals + the renderPreview function)

- [ ] **Step 1: Confirm boundaries**

```bash
cd /home/quando/documents/chrome-puzzle-solver
grep -n "^  let latticeLayer\|^  function drawPreview\|^  function setExpanded" content.js
```

Expected:
- `let latticeLayer = null;` opens the cache-locals block (line ~1033). The next two lines declare `staticLayer` and `staticLayerSig`.
- `function drawPreview(grid, hint) {` opens the body (line ~1041).
- `function setExpanded(val) {` is the function IMMEDIATELY AFTER drawPreview ends — it stays in makeWidget. drawPreview's closing `}` is the line before it.

The slice to extract is:
- **Cache locals**: 3 lines (`let latticeLayer = null;`, `let staticLayer = null;`, `let staticLayerSig = null;`).
- **drawPreview**: lines `function drawPreview` through its closing `}` (just before `function setExpanded`). ~705 lines at 2-space indent.

- [ ] **Step 2: Read the drawPreview body**

Use the Read tool on content.js with `offset` = line of `function drawPreview` and `limit` = (line of `function setExpanded` − 1) − (line of `function drawPreview`) + 1.

Chain multiple Reads if the slice exceeds the tool's single-call limit.

- [ ] **Step 3: Sanity-check the closure-reference inventory**

Before extracting, confirm the slice references exactly the closure symbols we expect:

```bash
cd /home/quando/documents/chrome-puzzle-solver
DP_START=$(grep -n "^  function drawPreview" content.js | head -1 | cut -d: -f1)
DP_END=$(($(grep -n "^  function setExpanded" content.js | head -1 | cut -d: -f1) - 1))
awk -v s=$DP_START -v e=$DP_END 'NR>=s && NR<=e' content.js | \
  grep -oE "\b(canvas|puzzleData|latticeLayer|staticLayer|staticLayerSig|q)\b" | sort | uniq -c
```

Expected counts:
- `canvas`: 4
- `puzzleData`: 40
- `latticeLayer`: 2
- `staticLayer`: 2
- `staticLayerSig`: 2
- `q`: 1

If any other identifier shows up that isn't a parameter of drawPreview (`grid`, `hint`) — escalate as BLOCKED. The extraction would need a different parameter shape.

- [ ] **Step 4: Locate the single `q('.ns-body').clientWidth` reference**

```bash
awk -v s=$DP_START -v e=$DP_END 'NR>=s && NR<=e' content.js | grep -n "q('.ns-body')"
```

Expected: one match showing the line within drawPreview where `q('.ns-body').clientWidth || 300` is evaluated. It's used for `bodyWidth`.

- [ ] **Step 5: Append cache locals + renderPreview to preview.js**

Open `src/widget/preview.js`. Find the `if (typeof module !== 'undefined' && module.exports) {` block at the bottom — that's where the existing exports live. INSERT the following BEFORE that block (and after the last canvas-layer builder from Stage A1):

```js

// drawPreview's two-layer cache. Lifted from inside makeWidget at Stage
// A2 so renderPreview can be a top-level function. Single-widget-per-page
// is assumed; if a second widget ever appears, give each its own cache
// or pass it in via args.
let latticeLayer = null;
let staticLayer = null;
let staticLayerSig = null;

function renderPreview(canvas, puzzleData, grid, hint, bodyWidth) {
<de-indented body of drawPreview from step 2 — every non-empty line
 loses 2 leading spaces. The single `q('.ns-body').clientWidth || 300`
 expression becomes just `bodyWidth`.>
}
```

Extend the `module.exports` block at the bottom to include the new symbols:

```js
  module.exports = {
    // Stage A0 exports (unchanged)
    hintIdCounter, hintIdCache,
    hintSig, FNV_OFFSET, FNV_PRIME,
    regionMapSig, comparisonCluesSig, shikakuCluesSig,
    slitherlinkCluesSig, hashiIslandsSig, hitoriTaskSig,
    kakurasuCluesSig, kurodokoTaskSig, mosaicTaskSig,
    norinoriAreasSig, nurikabeTaskSig, heyawakeAreasSig,
    gridDataSig,
    // Stage A1 exports (unchanged)
    buildLatticeLayer, buildStaticLayer,
    drawComparisonCluesOn, drawShikakuCluesOn, drawHashiIslandsOn,
    drawHeyawakeRoomsOn, drawRegionBordersOn, drawNonogramGuidesOn,
    // Stage A2 (new)
    latticeLayer, staticLayer, staticLayerSig,
    renderPreview,
  };
```

- [ ] **Step 6: Remove cache locals + drawPreview from makeWidget**

Use the Edit tool on content.js:

- First Edit: `old_string` = the three lines
  ```
    let latticeLayer = null;
    let staticLayer = null;
    let staticLayerSig = null;
  ```
  (with their original 2-space indent and any blank lines / comments
  between them — match what step 1's grep showed), `new_string` =
  empty.

- Second Edit: `old_string` = the verbatim drawPreview function from
  step 2 (with original 2-space indent), `new_string` = the arrow
  wrapper:

```
  const drawPreview = (grid, hint) =>
    renderPreview(canvas, puzzleData, grid, hint, q('.ns-body').clientWidth || 300);
```

If the function body is too long for a single Edit, split into two
passes (e.g., first half + second half).

- [ ] **Step 7: Verify**

```bash
cd /home/quando/documents/chrome-puzzle-solver
node -e "require('./src/widget/preview.js'); console.log('preview.js parses');"
npm test 2>&1 | tail -5
npm run build 2>&1 | tail -3
grep -c "function renderPreview\|^let latticeLayer\b\|^let staticLayer\b\|^let staticLayerSig\b" dist/content.js
```

Expected:
- `preview.js parses`.
- npm test: `pass 448 / fail 0`.
- Build emits `Wrote dist/content.js`.
- `grep -c` returns `4` (each of the 4 top-level declarations appears exactly once in the bundle).

If a test fails with `ReferenceError: latticeLayer is not defined` (or similar), the test loader's widgetOrder is fine (preview.js was already added in Stage A0) — likely a syntax error from incorrect de-indentation in preview.js. Inspect with `node -e "require('./src/widget/preview.js')"`.

If a test fails with `ReferenceError: renderPreview is not defined`, the bundler order may be wrong — content.js shouldn't precede preview.js in the bundle. Check `WIDGET_FILES` in `scripts/build-content-bundle.js`: preview.js must come before the trailing `content.js`. (It already does — `preview.js` is in the list, content.js appended at the end.)

- [ ] **Step 8: Commit**

```bash
cd /home/quando/documents/chrome-puzzle-solver && jj commit -m "refactor(content): promote drawPreview into preview.js as renderPreview

Cache locals (latticeLayer / staticLayer / staticLayerSig) lift to
module scope in preview.js. makeWidget keeps a 1-line arrow wrapper
that calls renderPreview with the explicit canvas + puzzleData +
bodyWidth — the 9 existing drawPreview(grid, hint) call sites are
unchanged."
```

---

## Task 2: Update lint + globals.d.ts + push

**Files:**
- Modify: `eslint.config.js`
- Modify: `globals.d.ts`

makeWidget's arrow wrapper now references `renderPreview` as a cross-file global. Cache locals also moved out. Add declarations.

- [ ] **Step 1: Update eslint config**

Open `eslint.config.js`. Find the `// src/widget/preview.js` globals group (added in Stage A0/A1). Append after the existing entries — specifically after `drawNonogramGuidesOn: 'readonly',`:

```js
        renderPreview: 'readonly',
        latticeLayer: 'writable',
        staticLayer: 'writable',
        staticLayerSig: 'writable',
```

(They're `writable` because renderPreview mutates them when it rebuilds the layer cache.)

- [ ] **Step 2: Update globals.d.ts**

Open `globals.d.ts`. Find the `declare function drawNonogramGuidesOn(...)` line (last Stage A1 entry). Append after it:

```ts
declare function renderPreview(canvas: any, puzzleData: any, grid: any, hint?: any, bodyWidth?: any): any;
declare let latticeLayer: any;
declare let staticLayer: any;
declare let staticLayerSig: any;
```

- [ ] **Step 3: Verify**

```bash
cd /home/quando/documents/chrome-puzzle-solver
npm run lint 2>&1 | tail -3
npm run typecheck 2>&1 | tail -3
npm test 2>&1 | tail -5
npm run build 2>&1 | tail -3
```

Expected: all four clean. Tests 448/448. Build prints `Wrote dist/content.js`.

- [ ] **Step 4: Commit and push**

```bash
cd /home/quando/documents/chrome-puzzle-solver
jj commit -m "lint(content): renderPreview + cache-locals globals in eslint + globals.d.ts"
jj log -r 'main..@-' --no-graph -T 'commit_id.short() ++ "  " ++ description.first_line() ++ "\n"'
jj bookmark set main -r @-
jj git push --bookmark main 2>&1 | tail -3
```

Expected: 2 commits ahead of main (Task 1 + Task 2), clean push.

- [ ] **Step 5: Manual browser smoke (recommended)**

Reload the extension at `chrome://extensions`, open any puzzle, run Solve / Hint / Loop. The preview overlay should render correctly: cell fills, region borders, hint highlights, etc. — same behaviour as before Stage A2.

If anything renders blank or stale, the closure-state lift likely broke the cache-invalidation path. Inspect `staticLayerSig` updates inside renderPreview — that's the canary.

---

## Self-review notes

**Spec coverage (Stage A2 only):**
- Spec §4 sub-stage A2 (drawPreview promotion + cache locals lift) → Task 1. ✓
- Spec §7 testing (npm test green at every commit) → verified at end of each task. ✓
- Spec §8 single-widget-per-page caveat → noted inline in preview.js comment. ✓

**Out of this plan** (future Stage A3):
- makeWidget shell extraction to `widget.js`.

**Placeholder scan:** No "TBD" / "implement later". Each step has a concrete command or code block. Boundaries are grep-discovered.

**Type consistency:** `renderPreview`, `latticeLayer`, `staticLayer`, `staticLayerSig` names match across preview.js, eslint config, globals.d.ts, and the makeWidget arrow wrapper. `bodyWidth` parameter naming is consistent.

End of plan.
