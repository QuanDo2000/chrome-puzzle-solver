# content.js split — Stage D (collapse remaining inline per-puzzle chains) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lift the remaining inline per-puzzle if-chains and special-case arms in widget.js / preview.js / cache.js / content.js into dispatcher hooks on the per-puzzle modules. After Stage D, content.js + the shared widget shell are puzzle-agnostic (or close to it).

**Architecture:** Each task adds a new dispatcher in the appropriate file + the corresponding hook on each puzzle module that needs it + deletes the inline arm. Tasks are independent; can execute in priority order.

**Reference spec:** `docs/superpowers/specs/2026-05-25-content-js-split-design.md` §7 Phase 4 (Remove fallback paths).

`jj commit` not git. Repo `/home/quando/documents/chrome-puzzle-solver/`.

---

## Tasks (priority order — biggest LOC reductions first)

### T1: `applyHint` dispatcher hook

**Goal:** Collapse the 5-arm pendingHint-apply chain in `applyAndRunLoop` (widget.js around line 758) and the duplicated chain in `applyHintHandler` (around line 1036) into a single registry dispatcher with per-puzzle `applyHint` hooks.

**Current shape (widget.js ~758-810):**
```js
if (puzzleData.pendingHint.type === 'galaxies') {
  const r = await applySolution({ type: 'galaxies-lines', lines: puzzleData.pendingHint.lines });
  ok = !!r?.success;
} else if (puzzleData.type === 'shikaku') {
  ... shikaku-specific applyShikakuState call ...
} else if (puzzleData.type === 'slitherlink') {
  ... slitherlink-specific applySlitherlinkState call ...
} else if (puzzleData.type === 'hashi') {
  const r = await applyHashiHintEdges(puzzleData.pendingHint);
  ...
} else {
  const hintCells = hintAbsoluteCells(puzzleData.pendingHint);
  ok = !!(await callMainWorld('applyHintCells', [hintCells]));
}
```

**Target hook signature:** `async applyHint(hint, ctx)` where `ctx` provides `applySolution`, `callMainWorld`, `applyHashiHintEdges`, `hintAbsoluteCells`, and `puzzleData`.

**Per-puzzle hooks:**
- `galaxies.applyHint(hint, ctx)` — `return ctx.applySolution({type:'galaxies-lines', lines: hint.lines});`
- `shikaku.applyHint(hint, ctx)` — calls `applyShikakuState` via MAIN world.
- `slitherlink.applyHint(hint, ctx)` — calls `applySlitherlinkState`.
- `hashi.applyHint(hint, ctx)` — calls `applyHashiHintEdges`.
- All cell-state puzzles (binairo/hitori/mosaic/etc.) — generic `ctx.callMainWorld('applyHintCells', [ctx.hintAbsoluteCells(hint)])`. Could be a shared default; provide as a module-level helper or just bake into the dispatcher's fallback.

**Subtask structure:**
1. Add the dispatcher in widget.js (both sites: `applyAndRunLoop` + `applyHintHandler`).
2. Add `applyHint` hooks to: galaxies, shikaku, slitherlink, hashi. (Cell-state puzzles use the dispatcher's fallback for now.)
3. Delete inline arms.
4. Verify tests + browser smoke (apply a hint on each migrated type).

Net: ~80 LOC of inline chain removed across both sites; new code ~30 LOC.

---

### T2: `drawHintCell` dispatcher hook

**Goal:** Collapse the ~10-arm hint-cell ring-rendering chain in preview.js's hint-cells loop (around lines 758-870) into a single registry dispatcher.

**Current shape (preview.js ~758-870):**
```js
for (const cell of hintAbsoluteCells(hint)) {
  if (puzzleData?.type === 'shikaku' && cell.value >= 0) {
    ... fill rectangle owner color + blue ring ...
  } else if (puzzleData?.type === 'yinyang' && (cell.value === 1 || cell.value === 2)) {
    ... white/black square + blue ring ...
  } else if (puzzleData?.type === 'heyawake' && (cell.value === 1 || cell.value === 2)) {
    ...
  } else if (puzzleData?.type === 'hitori' && (cell.value === 1 || cell.value === 2)) {
    ...
  } else if (isKakurasu && (cell.value === 1 || cell.value === 2)) { ... }
  else if (isKurodoko && (cell.value === 1 || cell.value === 2)) { ... }
  else if (isMosaic && (cell.value === 1 || cell.value === 2)) { ... }
  else if (isNorinori && (cell.value === 1 || cell.value === 2)) { ... }
  else if (isNurikabe && (cell.value === 1 || cell.value === 2)) { ... }
  else if (puzzleData?.type === 'binairo' && (cell.value === 1 || cell.value === 2)) { ... }
  else { ... default: just paint blue ring ... }
}
```

**Target hook signature:** `drawHintCell(ctx, args)` where `args = { cell, cx, cy, cellSize, galaxiesColors }`.

**Per-puzzle hooks:** all cell-state puzzles + shikaku + yinyang get this hook; default is the generic blue ring (for puzzles that don't define it).

**Subtask structure:**
1. Add the dispatcher in preview.js's hint-cells loop.
2. Add `drawHintCell` hook to: shikaku, yinyang, heyawake, hitori, kakurasu, kurodoko, mosaic, norinori, nurikabe, binairo.
3. Also: the pre-paint band-skip chain at preview.js:791-815 (where each puzzle has `else if (isXxx) { /* no row/column band */ }` no-ops) — collapse via a `hintBandSkip` flag on each module (already documented in spec §3).
4. Delete inline arms.
5. Verify.

Net: ~100 LOC of inline chain removed; new code ~30 LOC (10 modules × ~3 lines each).

---

### T3: `solutionShape` hook + `recordSolveSuccess` collapse

**Goal:** Collapse the 3-arm solution-shape chain in `recordSolveSuccess` (widget.js around line 581) and the matching `previewGridFromResult` (line 612) using a `solutionShape` hook that returns the appropriate solution object from a worker result.

**Current shape (widget.js ~581):**
```js
if (puzzleData?.type === 'slitherlink') {
  puzzleData.solution = { horizontal: result.horizontal, vertical: result.vertical };
} else if (puzzleData?.type === 'hashi') {
  puzzleData.solution = { solved: result.solved, edges: result.edges };
} else {
  puzzleData.solution = result.grid;
}
```

**Target hook:** `solutionFromResult(result)` — returns the solution object in the puzzle's native shape.

**Per-puzzle hooks:** slitherlink, hashi. (Default: `result.grid`.)

**Subtask structure:**
1. Add the dispatcher in `recordSolveSuccess` and `previewGridFromResult`.
2. Add `solutionFromResult` hook to slitherlink + hashi.
3. Delete inline arms.

Net: ~30 LOC removed; new code ~10 LOC.

---

### T4: Cache-shape lift (`cacheGridSolution` / `getCachedGridSolution`)

**Goal:** Collapse the slitherlink and hashi shape-specific persistence in cache.js (lines 140/167 area). Define `solutionToCacheJson(solution)` and `solutionFromCacheJson(json)` hooks; the cache layer delegates serialization to the module.

**Subtask structure:**
1. Add cache.js dispatchers using the hooks.
2. Add `solutionToCacheJson` / `solutionFromCacheJson` hooks to slitherlink + hashi.
3. Delete inline arms.

Net: ~30 LOC removed; new code ~10 LOC.

---

### T5: Geometry hook (`canvasDims`) for non-standard canvas shapes

**Goal:** Collapse the `isKakurasu`/`isHashi`/`isSlitherlink` geometry blocks at the top of `renderPreview` (preview.js ~315-330) into a `canvasDims(pd, bodyWidth)` hook.

**Subtask structure:**
1. Add a `canvasDims` registry dispatcher in `renderPreview` setup.
2. Add hooks to: kakurasu (returns `(N+1)×(N+1)`), hashi (returns puzzleData.rows×cols), slitherlink (returns rows×cols, derives from horizontal if needed).
3. Delete the `isKakurasu`/`cellSizeDenC/cellSizeDenR/wFull/hFull` block and the `isHashi`/`isSlitherlink` else-if chain.

Net: ~40 LOC removed; new code ~30 LOC.

---

### T6: Simple flag lifts

**Goal:** Collapse the simple AND chains using existing per-puzzle flag fields.

**Subtasks:**
1. **`skipAutoSolveGate` chain** (widget.js line 1051) — replace `const skipAutoSolveGate = puzzleData.type === 'slitherlink' || ... ;` with `const skipAutoSolveGate = !!PUZZLES[puzzleData.type]?.skipAutoSolveGate;`. Every migrated module already declares the flag.
2. **Hint-loop multi-puzzle check** (widget.js line 881) — replace the `hr.hint?.type !== 'galaxies' && hr.hint?.type !== ... && !hr.hint?.cells?.length` chain with `const reg = PUZZLES[hr.hint?.type]; if (!reg?.hasAbsoluteHintCells && !hr.hint?.cells?.length) break;`. Add `hasAbsoluteHintCells: true` to each puzzle that uses absolute extraCells. Same effect, no hand-list.
3. **Pre-paint band-skip chain** (preview.js ~791-815) — collapse via the existing `hintBandSkip` flag (already in spec §3). Each module already has it (or should). Add the flag where missing.

Net: ~30 LOC of hand-lists removed.

---

### T7: Detection-and-hint path migration (content.js)

**Goal:** Move the 12-arm detection-and-hint dispatch in content.js's `getHint` (around line 131-396) into per-puzzle `hintDispatch` hooks.

**This is the largest task** — ~250 LOC of dispatching across 12 puzzle types. Each puzzle's hint computation lives inline. Move each into the puzzle module's `hintDispatch` hook (Stage B already wired the dispatcher at hintHandler, but it's separate from this content.js path).

**Subtask structure:** Migrate one puzzle's content.js hint arm per commit. Use the existing Stage-B `hintDispatch` hook (some modules already have it skeleton-defined).

This is essentially Stage C for the content.js detection-and-hint path. ~12 commits.

---

## Execution order

Per priority (biggest wins / lowest risk first):
- T6 (flag lifts) — small, low-risk, immediate win.
- T2 (drawHintCell) — biggest single LOC reduction.
- T1 (applyHint) — eliminates the duplicated pendingHint chain at two call sites.
- T3 (solutionShape) — small but clean.
- T4 (cache-shape) — small.
- T5 (canvasDims) — small but touches preview.js setup.
- T7 (detection-and-hint) — largest, can do incrementally one puzzle per commit.

Some tasks can be combined into one commit per dispatcher concern. Subagents are dispatched one task at a time.

---

## Verification gate (per commit)

```bash
cd /home/quando/documents/chrome-puzzle-solver
npm test 2>&1 | tail -5
npm run lint 2>&1 | tail -3
npm run typecheck 2>&1 | tail -3
npm run build 2>&1 | tail -3
```

All four green. Push to main after each task lands.

**Browser smoke** strongly recommended after T1, T2, T7 (the touch most visible UI paths).

End of plan.
