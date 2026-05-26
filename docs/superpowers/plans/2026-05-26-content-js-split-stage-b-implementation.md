# content.js split — Stage B (registry-first dispatchers) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire registry-first checks at every dispatcher site so the (currently empty) `PUZZLES` registry can take over per-puzzle logic incrementally during Stage C. Behavior is unchanged at every commit because `PUZZLES` stays empty until Stage C — every registry check returns null and falls through to the existing inline switch.

**Architecture:** Four task groups, one commit each, organized by file: T1 cache.js (1 hook), T2 preview.js (4 hooks), T3 widget.js (4 hooks), T4 content.js (1 hook). Each registry check has the same shape:

```js
const reg = PUZZLES?.[data?.type];
if (reg?.HOOK) return reg.HOOK(args);
// ... existing inline switch / branch arm unchanged ...
```

For draw hooks (`drawPreviewCell`, `drawStaticLayer`, `drawLattice`) the pattern is the same but the registry hook may also coexist with the inline arm (the hook PARTICIPATES rather than replaces — e.g., `reg.drawPreviewCell?.(ctx, args)` is called UNCONDITIONALLY, and the inline arm runs ONLY when no registry hook is present). The exact shape per hook is in §3 of `docs/superpowers/specs/2026-05-25-content-js-split-design.md`.

**Reference spec:** `docs/superpowers/specs/2026-05-25-content-js-split-design.md` §3 (per-puzzle module interface) + §7 (migration strategy / Phase 2).

`jj commit` not git. Repo `/home/quando/documents/chrome-puzzle-solver/`.

---

## Common verification gate (run after EVERY task)

```bash
cd /home/quando/documents/chrome-puzzle-solver
npm test 2>&1 | tail -5
npm run lint 2>&1 | tail -5
npm run typecheck 2>&1 | tail -5
npm run build 2>&1 | tail -3
```

Expected at EVERY commit: tests 448/448, lint clean, typecheck clean, build emits dist/content.js. PUZZLES is empty so behavior MUST be identical to pre-Stage-B.

If any gate fails, STOP. The registry check has a logic bug (e.g., calling the hook unconditionally instead of as a fallthrough, or passing wrong args).

---

## Task 1: cache.js cacheKey dispatcher

**Files:**
- Modify: `src/widget/cache.js`

The `getCachedGridSolution(data)` and `cacheGridSolution(data, grid)` functions both contain a 14-arm ternary chain dispatching to per-type cacheKey helpers (`aquariumCacheKey`, `nonogramCacheKey`, ..., `nurikabeCacheKey`). Add a registry-first prefix to each.

- [ ] **Step 1: Locate the dispatch sites**

```bash
cd /home/quando/documents/chrome-puzzle-solver
grep -n "function getCachedGridSolution\|function cacheGridSolution\|aquariumCacheKey(data)" src/widget/cache.js | head -5
```

Expected: `function getCachedGridSolution` near line 309, `function cacheGridSolution` near line 352. Both contain the same ternary chain starting `data?.type === 'aquarium' ? aquariumCacheKey(data)`.

- [ ] **Step 2: Wire registry check into getCachedGridSolution**

Read the function (~309-350). Find the `const key = data?.type === 'aquarium' ? ...` chain. Insert BEFORE it:

```js
  const reg = (typeof PUZZLES !== 'undefined' && PUZZLES) ? PUZZLES[data?.type] : null;
  let key = reg?.cacheKey ? reg.cacheKey(data) : null;
  if (!key) {
    key = data?.type === 'aquarium' ? aquariumCacheKey(data)
      : data?.type === 'nonogram' ? nonogramCacheKey(data)
      ...
      : null;
  }
```

Concretely: change `const key = data?.type === ...` to `key = data?.type === ...` (drop `const`, since `key` is now declared above), wrap the whole ternary in `if (!key) { ... }`.

NB: `PUZZLES` is a bundle-scope global from `src/widget/puzzles/index.js`. The `typeof PUZZLES !== 'undefined'` guard is defensive against vm-context test scenarios where the bundle order might not have loaded puzzles/index.js yet — though in practice it should always be loaded before cache.js consumers run. Belt-and-suspenders.

- [ ] **Step 3: Wire registry check into cacheGridSolution**

Same pattern, line ~352. The ternary chain shape is identical.

- [ ] **Step 4: Run verification gate** (see "Common verification gate" above).

- [ ] **Step 5: Commit**

```bash
jj commit -m "refactor(content): wire registry-first cacheKey dispatch in cache.js

PUZZLES[type]?.cacheKey(data) is checked first; fall through to the
existing 14-arm ternary when the registry is empty. Behavior unchanged
until Stage C populates the registry per-puzzle."
```

---

## Task 2: preview.js draw/sig dispatchers

**Files:**
- Modify: `src/widget/preview.js`

Four dispatch sites:
1. **drawPreviewCell** — the per-cell render arm inside `renderPreview`'s nested r/c loop (~ preview.js line 192-onwards). Currently a series of `if (pd?.type === 'nurikabe')` ... `else if (pd?.type === 'binairo')` etc.
2. **drawStaticLayer** — inside `buildStaticLayer`, after the lattice borders are drawn (~line 70+). Per-type calls to `drawComparisonCluesOn` / `drawShikakuCluesOn` / `drawHashiIslandsOn` / `drawHeyawakeRoomsOn` / `drawRegionBordersOn` / `drawNonogramGuidesOn`.
3. **drawLattice** — inside `buildLatticeLayer` (~line 225). Currently only Nurikabe has special lattice (walls); other puzzles use the default grid.
4. **staticSig** — the per-puzzle signature segment built into `staticLayerSig` (search for `staticSig` in preview.js to find its construction). Per-type segments like `'nu=' + nurikabeTaskSig(...)`, `'cc=' + comparisonCluesSig(...)`, etc.

- [ ] **Step 1: Locate all 4 dispatch sites**

```bash
cd /home/quando/documents/chrome-puzzle-solver
grep -nE "pd\?\.type === '|puzzleData\?\.type === '" src/widget/preview.js | head -20
```

Use the output to identify the cluster of type-checks for each of the 4 dispatch concerns. Some clusters span 10+ lines per concern.

- [ ] **Step 2: Wire `drawPreviewCell`**

Inside `renderPreview`'s cell loop (~line 200ish, inside the `for (r) { for (c) { ... } }` body). Find where the per-cell per-type rendering starts (typically `const v = grid[r][c]; if (pd?.type === 'nurikabe') { ... }`).

INSERT before the existing per-type render arms:

```js
const reg = PUZZLES?.[pd?.type];
if (reg?.drawPreviewCell) {
  reg.drawPreviewCell(ctx, { r, c, v, taskVal: pd?.task?.[r]?.[c], x, y, cellW, cellH, hint, puzzleData: pd, isSlitherlink, xPad });
} else {
  // ... existing per-type render arms unchanged ...
}
```

Wrap the existing render-arm chain in the `else` block. `x`, `y`, `cellW`, `cellH`, `isSlitherlink`, `xPad` are locals from the surrounding scope — they must already be defined where the original render arms read them.

If the existing render arms reference closure locals that aren't in the args bag spec'd in design §3, ADD them to the bag (the spec's args bag is a baseline, not exhaustive). Stage C will adapt each puzzle module to the bag shape that arrives.

- [ ] **Step 3: Wire `drawStaticLayer`**

Inside `buildStaticLayer` (line ~60-onwards). After the lattice's borders are drawn (the per-cell border loop) and BEFORE the per-puzzle clue/decoration drawing, INSERT:

```js
const reg = PUZZLES?.[pd?.type];
if (reg?.drawStaticLayer) {
  reg.drawStaticLayer(ctx, { rows, cols, cellSize, w, h, pd });
} else {
  // ... existing per-type drawXxx calls (drawComparisonCluesOn,
  //     drawShikakuCluesOn, drawHashiIslandsOn, etc.) unchanged ...
}
```

Wrap the existing per-type calls in the `else` block.

- [ ] **Step 4: Wire `drawLattice` (customLattice flag)**

Inside `buildLatticeLayer` (line ~225). Check if there's existing per-type lattice handling (Nurikabe walls). If yes, INSERT at the top of the function body:

```js
const reg = PUZZLES?.[pd?.type];
if (reg?.customLattice && reg.drawLattice) {
  reg.drawLattice(ctx, { rows, cols, cellSize, w, h, pd });
  return canvas;  // or whatever the existing function returns
}
// ... existing default-lattice + per-type customizations unchanged ...
```

NB: `customLattice` is a boolean flag on the puzzle module that signals "do NOT call the default lattice builder; use my drawLattice instead." This is spec §3's pattern for Nurikabe walls.

If the existing function only has default-lattice handling (no Nurikabe-specific arm yet), still wire the dispatcher — it's a no-op until Stage C registers Nurikabe.

- [ ] **Step 5: Wire `staticSig`**

Find where `staticLayerSig` is built (likely a concatenated string). Look for `staticSig` or `staticLayerSig =` near the top of `renderPreview` or in a helper.

INSERT a registry contribution:

```js
let staticSig = gridDataSig(...) + '|' + ...;
const reg = PUZZLES?.[pd?.type];
if (reg?.staticSig) {
  staticSig += '|' + reg.staticSig(pd);
} else {
  // ... existing per-type sig contributions (|cc=, |sk=, |sl=, etc.) unchanged ...
}
```

Wrap the existing per-type segment-appending in the `else` block.

- [ ] **Step 6: Run verification gate.**

- [ ] **Step 7: Commit**

```bash
jj commit -m "refactor(content): wire registry-first draw/sig dispatchers in preview.js

drawPreviewCell, drawStaticLayer, drawLattice, and staticSig now check
PUZZLES[type] first; existing per-type render arms become fallback
branches. Behavior unchanged until Stage C populates the registry."
```

---

## Task 3: widget.js hint/loop/status dispatchers

**Files:**
- Modify: `src/widget/widget.js`

Four dispatch sites:
1. **hintDispatch** — inside `hintHandler` (~line 1204). Per-puzzle hint logic.
2. **loopDoneCheck** — inside `loopHandler` (~line 941). Per-puzzle "is the puzzle solved?" check.
3. **hintStatusNodes** — inside `renderHintStatusAndPreview` (~line 424) and/or `setHintStatus` (~line 186). Per-puzzle status-text rendering.
4. **partialResultArm** — inside `applyPartialResult` (~line 803). Currently slitherlink-specific.

- [ ] **Step 1: Locate dispatch sites**

```bash
cd /home/quando/documents/chrome-puzzle-solver
grep -nE "function (renderHintStatus|setHintStatus|hintHandler|loopHandler|applyPartialResult)\b" src/widget/widget.js
```

- [ ] **Step 2: Wire `hintDispatch` (in hintHandler)**

Find the per-puzzle hint logic block inside `hintHandler`. Wrap with:

```js
const reg = PUZZLES?.[puzzleData?.type];
let hint = null;
if (reg?.hintDispatch) {
  hint = reg.hintDispatch({
    boardState, detectedGrid, rows, cols, solution,
    firstMismatch, getCached: getCachedGridSolution,
  });
} else {
  // ... existing per-type hint logic unchanged ...
  // (the per-type block already assigns to `hint` or returns; preserve that)
}
```

If the existing hint block sets locals and returns rather than producing a single `hint` variable, you may need to refactor slightly to make the registry path symmetric. Keep that refactor minimal — Stage B is wiring, not restructuring.

- [ ] **Step 3: Wire `loopDoneCheck` (in loopHandler)**

Find the per-puzzle done-check inside `loopHandler`. Wrap:

```js
const reg = PUZZLES?.[puzzleData?.type];
let done;
if (reg?.loopDoneCheck) {
  done = reg.loopDoneCheck({ boardState, solution, puzzleData });
} else {
  done = /* ... existing per-type done check ... */;
}
```

- [ ] **Step 4: Wire `hintStatusNodes` (in renderHintStatusAndPreview or setHintStatus)**

Find the per-puzzle hint-status-text rendering. Inject:

```js
const reg = PUZZLES?.[puzzleData?.type];
if (reg?.hintStatusNodes) {
  const nodes = reg.hintStatusNodes(hint, { bold });
  setStatusNodes('hint', ...nodes);
} else {
  // ... existing per-type status rendering unchanged ...
}
```

`bold` is the helper that wraps text in a `<b>` element; pass it through the `helpers` bag per spec §3.

- [ ] **Step 5: Wire `partialResultArm` (in applyPartialResult)**

Currently `applyPartialResult` has slitherlink-specific code. Inject:

```js
const reg = PUZZLES?.[puzzleData?.type];
if (reg?.partialResultArm) {
  reg.partialResultArm(result, { applyPartialGrid, applyPartialEdges, /* etc */ });
} else {
  // ... existing slitherlink branch unchanged ...
}
```

Pass whatever helpers the existing arm uses through `ctx`.

- [ ] **Step 6: Run verification gate.**

- [ ] **Step 7: Commit**

```bash
jj commit -m "refactor(content): wire registry-first hint/loop/status dispatchers in widget.js

hintDispatch, loopDoneCheck, hintStatusNodes, and partialResultArm
now check PUZZLES[type] first; existing per-type code becomes fallback.
Behavior unchanged until Stage C populates the registry."
```

---

## Task 4: content.js solveExtraData dispatcher

**Files:**
- Modify: `content.js`

The `solveExtraData()` function in content.js has a 15-arm switch returning per-puzzle extras.

- [ ] **Step 1: Locate**

```bash
cd /home/quando/documents/chrome-puzzle-solver
grep -n "^function solveExtraData\|^async function solveExtraData" content.js
```

- [ ] **Step 2: Wire registry check**

INSERT at top of function body:

```js
const data = puzzleData;
const reg = (typeof PUZZLES !== 'undefined' && PUZZLES) ? PUZZLES[data?.type] : null;
if (reg?.solveExtraData) return reg.solveExtraData(data);
// ... existing 15-arm switch unchanged ...
```

If `puzzleData` isn't the local name in this function, use whatever variable holds the current puzzle data (the function may receive it as a parameter or read it from a closure / module-scope var).

- [ ] **Step 3: Run verification gate.**

- [ ] **Step 4: Commit**

```bash
jj commit -m "refactor(content): wire registry-first solveExtraData dispatch in content.js

PUZZLES[type]?.solveExtraData(data) is checked first; existing 15-arm
switch becomes fallback. Behavior unchanged until Stage C."
```

---

## Task 5: Final push

**No file changes.** Just push the 4-commit Stage B series to main.

- [ ] **Step 1: Final verification gate (full)**

```bash
cd /home/quando/documents/chrome-puzzle-solver
npm test 2>&1 | tail -5
npm run lint 2>&1 | tail -5
npm run typecheck 2>&1 | tail -5
npm run build 2>&1 | tail -3
```

All four green.

- [ ] **Step 2: Inspect commit series**

```bash
jj log -r 'main..@-' --no-graph -T 'commit_id.short() ++ "  " ++ description.first_line() ++ "\n"'
```

Expected 4 commits ahead of main (T1-T4 each).

- [ ] **Step 3: Push**

```bash
jj bookmark set main -r @-
jj git push --bookmark main 2>&1 | tail -3
```

origin/main advances to T4's commit.

- [ ] **Step 4: Manual browser smoke (recommended)**

Reload extension, open a puzzle, run Solve / Hint / Loop. Verify nothing regressed. Per [[closure-extraction-check]] memory: tests can't catch all browser-DOM-only failures.

---

## Self-review notes

**Spec coverage (Stage B = spec §7 Phase 2):**
- Spec §7 Phase 2 (wire dispatchers with registry-first fallback) → T1-T4. ✓
- Spec §3 (per-puzzle module interface) → each task's hook signatures align with the spec's listed args bags. ✓
- Spec §7 Phase 1 (build infrastructure) → already complete via prior Stage A. Not in scope here. ✓
- Spec §7 Phase 3 (per-puzzle migration) → out of scope; that's Stage C. ✓

**Out of scope:**
- Migrating any puzzle to the registry. Stage C does that, one puzzle per commit.
- Removing the fallback branches. Stage D does that.
- Refactoring the hint/loop/preview shells beyond adding the registry-check prefix.

**Placeholder scan:** No "TBD" / "implement later". Each step has a concrete code template + grep command.

**Type consistency:** Hook names (`cacheKey`, `drawPreviewCell`, etc.) match spec §3 exactly. Args bag names match spec §3.

**Risk:** Some dispatch sites may have closure-scope locals that aren't in the spec's args bag. Per Task 2 Step 2 note: ADD them to the bag rather than restructuring the surrounding code. Stage C migrators adapt to whatever bag arrives.

End of plan.
