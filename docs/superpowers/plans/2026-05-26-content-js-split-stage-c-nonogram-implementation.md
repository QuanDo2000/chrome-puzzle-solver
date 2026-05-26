# content.js split — Stage C (Nonogram migration, template for the other 14) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the first puzzle (Nonogram) into the registry pattern. Create `src/widget/puzzles/nonogram.js` with all the puzzle's hooks; register it in `puzzles/index.js`; delete the now-dead inline branches from cache.js / preview.js / widget.js / content.js. After this commit, `PUZZLES['nonogram']` is non-empty and the Stage-B registry-first dispatchers handle nonogram entirely through it. The inline switch arms for OTHER 14 puzzles remain as fallback.

**Architecture:** This plan doubles as a **template** for migrating the other 14 puzzles. The structure is the same per-puzzle: identify inline branches → create module → register → delete branches → verify. Future puzzle migration plans will follow this same shape, only changing the puzzle name and the per-puzzle quirks.

**Reference spec:** `docs/superpowers/specs/2026-05-25-content-js-split-design.md` §3 (per-puzzle module interface) + §7 Phase 3 (per-puzzle migration).

`jj commit` not git. Repo `/home/quando/documents/chrome-puzzle-solver/`.

---

## Pre-survey: Nonogram's footprint

Before editing, confirm Nonogram's inline footprint with this grep:

```bash
cd /home/quando/documents/chrome-puzzle-solver
echo "=== cache.js ===" && grep -nE "'nonogram'|nonogramCacheKey" src/widget/cache.js
echo "=== preview.js ===" && grep -nE "'nonogram'|nonogramTaskSig|drawNonogramGuidesOn" src/widget/preview.js
echo "=== widget.js ===" && grep -nE "'nonogram'|isNonogram" src/widget/widget.js
echo "=== content.js ===" && grep -nE "'nonogram'|isNonogram" content.js
```

Known footprint (from prior survey):
- **cache.js**: `nonogramCacheKey` function (lines ~120-124), one inline ternary arm in `getCachedGridSolution` (~line 314) and `cacheGridSolution` (~line 361), `'nonogram-solution:'` entry in `SOLUTION_KEY_PREFIXES`, `'nonogram'` literal in `puzzlePartialKey`'s base (~line 399), module.exports entry for `nonogramCacheKey`.
- **preview.js**: `drawNonogramGuidesOn` function (~line 596), one call site in `buildStaticLayer` (~line 286), module.exports entry.
- **widget.js**: `'nonogram'` arms in `setHintStatus` (within the fallback after the Stage B registry check), `loopHandler`'s done check, `hintHandler`'s pre-solve gate (~line 1197). Hint-related: `setHintLabel` for nonogram (~line 180 comment + actual code).
- **content.js**: `'nonogram'` solver-type string passed to `runSolve(..., 'nonogram', solveExtraData())` (~line 433) — this is NOT a per-type branch, just the solver-type identifier; it stays.
- **content.js `solveExtraData`**: probably has a Nonogram arm in the 15-arm switch. Confirm with `grep -nA 10 "if (data.type === 'nonogram')" content.js`.
- **content.js `SUPPORTED_PUZZLES`**: has a `{ name: 'Nonogram', url: '.../nonogram/' }` entry. **STAYS for now** — moving SUPPORTED_PUZZLES to puzzles/index.js requires ALL 15 puzzles to be migrated (Stage D). For Stage C, the entry stays in content.js and the puzzle module's `label`/`url` fields are exposed but not yet wired into SUPPORTED_PUZZLES.

---

## Task 1: Create src/widget/puzzles/nonogram.js with all hooks

**Files:**
- Create: `src/widget/puzzles/nonogram.js`

The module exports a single object with the puzzle's identity + hooks. Field shape per spec §3.

- [ ] **Step 1: Read the existing inline code that will be migrated**

For each hook, read the existing inline code so the module-internal logic is byte-for-byte equivalent:

```bash
cd /home/quando/documents/chrome-puzzle-solver
# cacheKey
sed -n '120,125p' src/widget/cache.js
# drawNonogramGuidesOn (full function)
sed -n '596,/^}/p' src/widget/preview.js | head -60
# hintStatusNodes (the nonogram arm inside setHintStatus's fallback)
grep -nA 10 "puzzleData\?.type === 'nonogram'" src/widget/widget.js | head -40
# loopDoneCheck (the nonogram arm inside loopHandler's fallback)
grep -nA 8 "puzzleData\.type === 'nonogram'" src/widget/widget.js | head -30
# solveExtraData (the nonogram arm)
grep -nA 8 "data\.type === 'nonogram'" content.js | head -20
# hintHandler pre-solve gate
sed -n '1195,1215p' src/widget/widget.js
```

Note each function's logic AND any closure-scope locals it references (e.g., `gridDataSig`, `nonogramTaskSig`, `nextChunkHint`, `bold`, `setStatusNodes`, `readGridState`).

- [ ] **Step 2: Write the module**

`/home/quando/documents/chrome-puzzle-solver/src/widget/puzzles/nonogram.js`:

```js
'use strict';

// Nonogram puzzle module — first migrated puzzle in Stage C.
//
// Hooks consumed by the Stage-B dispatchers:
//   cacheKey, solveExtraData, drawStaticLayer, hintDispatch,
//   loopDoneCheck, hintStatusNodes
//
// Helpers consumed from bundle scope (concatenated globals):
//   fnv1aSig / gridDataSig (preview.js), nextChunkHint /
//   hintAbsoluteCells (hint.js), readGridState (content.js),
//   firstMismatch (hint.js), getCachedGridSolution (cache.js).

const nonogram = {
  type: 'nonogram',
  label: 'Nonogram',
  url: 'https://www.puzzles-mobile.com/nonogram/',
  solutionKeyPrefix: 'nonogram-solution:',

  cacheKey(data) {
    if (!data || data.type !== 'nonogram') return null;
    const r = (data.rowClues || []).flat().join(',');
    const c = (data.colClues || []).flat().join(',');
    return 'nonogram-solution:' + data.rows + 'x' + data.cols + ':' + r + ':' + c;
  },

  // staticSig: nonogram doesn't contribute a unique static-layer sig beyond
  // gridDataSig + size — fold this in when porting if the existing fallback
  // builder includes nonogram-specific cache invalidation. (Confirm by
  // re-reading preview.js's sig builder during the move.)
  // If not needed, omit this field entirely.

  solveExtraData(data) {
    // Copy verbatim from content.js's solveExtraData nonogram arm.
    return {
      rows: data.rows,
      cols: data.cols,
      rowClues: data.rowClues,
      colClues: data.colClues,
    };
  },

  drawStaticLayer(ctx, { rows, cols, cellSize, w, h, pd }) {
    // Body: the current drawNonogramGuidesOn function body, verbatim.
    // (Read the function from preview.js:596 and paste here, replacing
    //  any `pd` references that match the args bag.)
  },

  hintDispatch(args) {
    // Body: nonogram's hint-computation path. Existing fallback in
    // widget.js's hintHandler likely calls nextChunkHint(...). Mirror that.
  },

  loopDoneCheck({ boardState, solution }) {
    // Body: per-cell match check. The fallback in widget.js's loopHandler
    // (line ~1040 + ~1121) compares boardState to solution cell-by-cell.
    // Copy that logic, scoped to the args.
  },

  hintStatusNodes(hint, { bold }) {
    // Body: the row/col chunk-style status text. Existing arm in
    // setHintStatus's fallback. Returns an array of DOM nodes / strings
    // ready for setStatusNodes('hint', ...nodes).
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = nonogram;
}
```

For each hook body, COPY the existing inline code VERBATIM and adapt only the variable references that change because of the move:
- `data` in the args bag replaces closure references to `puzzleData` / `detectedGrid` (use whichever name the bag provides — `puzzleData` for some hooks, `data` for cacheKey/solveExtraData).
- `bold` from the helpers bag replaces the closure-scoped `bold` helper.

DO NOT improve or refactor the logic during the move. Mechanical-only.

- [ ] **Step 3: Run module-parse check**

```bash
node -e "const n = require('./src/widget/puzzles/nonogram.js'); console.log('exports:', Object.keys(n));"
```

Expected: prints `exports: [ 'type', 'label', 'url', 'solutionKeyPrefix', 'cacheKey', 'solveExtraData', 'drawStaticLayer', 'hintDispatch', 'loopDoneCheck', 'hintStatusNodes' ]` (or however many hooks the migration produced).

---

## Task 2: Register Nonogram in puzzles/index.js

**Files:**
- Modify: `src/widget/puzzles/index.js`

Today `puzzles/index.js` exports `const PUZZLES = {}`. After Task 2, it imports nonogram and adds it to the registry.

- [ ] **Step 1: Read current state**

```bash
cat src/widget/puzzles/index.js
```

Expected: a tiny file with `'use strict';`, `const PUZZLES = {};`, and CJS export.

- [ ] **Step 2: Replace with the registry construction**

```js
'use strict';

const nonogram = require('./nonogram.js');

const PUZZLES = {
  [nonogram.type]: nonogram,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PUZZLES };
}
```

**Critical:** the bundle is a concatenated single file — `require('./nonogram.js')` won't work at runtime in the bundle (only in vm-context tests). The bundler must either:
- Inline the require (resolve at build time).
- Skip the require (the bundle's flat scope already has `nonogram` available as a bundle-scope global because nonogram.js is concatenated before index.js).

Check `scripts/build-content-bundle.js` to see how it handles inter-widget requires. The current pattern likely strips `require('./...')` calls or substitutes them.

If the bundler doesn't handle it, the workaround is: don't use `require` inside puzzles/index.js's bundle path. Instead, write it as:

```js
'use strict';

// Bundle-scope (concatenated) version: each puzzle's module sets a
// bundle-scope `<type>Module` reference. We collect them here. The
// `require` calls below work in the vm-context tests; in the bundle
// they're replaced by the bundler with no-ops (or rely on flat scope
// from the prior concatenated files).
//
// nonogram.js's module.exports assigns to a bundle-scope variable
// `nonogramModule` via `if (typeof module === 'undefined') globalThis.nonogramModule = ...`?

```

Hmm — the existing puzzles/index.js scaffold was empty so this pattern wasn't tested. Read scripts/build-content-bundle.js to determine the right approach.

If unclear, the SAFEST shape is:

```js
'use strict';

let nonogram;
try { nonogram = require('./nonogram.js'); } catch {}
if (!nonogram && typeof globalThis !== 'undefined' && globalThis.nonogramModule) {
  nonogram = globalThis.nonogramModule;
}

const PUZZLES = nonogram ? { [nonogram.type]: nonogram } : {};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PUZZLES };
}
```

And in nonogram.js, add:
```js
if (typeof module === 'undefined' && typeof globalThis !== 'undefined') {
  globalThis.nonogramModule = nonogram;
}
```

But this is awkward. The CLEANEST path: have the bundler EXPORT `module.exports` from each src/widget/*.js into a flat scope. The Stage A scaffold should have established this — verify.

**ACTION:** read scripts/build-content-bundle.js carefully BEFORE writing the registry code. If the bundler already concatenates `module.exports = nonogram;` from nonogram.js into bundle scope, then the variable `nonogram` is available globally and the index.js code is simply:

```js
const PUZZLES = (typeof nonogram !== 'undefined') ? { [nonogram.type]: nonogram } : {};
```

(Using a guard because nonogram might not be defined in vm-context test scenarios.)

- [ ] **Step 3: Verify the bundle still loads**

```bash
npm run build && node -e "require('./dist/content.js'); console.log('bundle loads');" 2>&1 | tail -5
```

If "bundle loads" prints, the bundling worked. If it throws (e.g., ReferenceError for `nonogram` or `PUZZLES`), the bundle order or the registry shape is wrong.

Also check the test suite: `npm test 2>&1 | tail -5` should still pass 448/448 because tests don't yet load `puzzles/index.js` differently.

---

## Task 3: Delete the now-dead inline branches

**Files:**
- Modify: `src/widget/cache.js` (remove nonogram arm from getCachedGridSolution + cacheGridSolution; consider removing nonogramCacheKey function entirely)
- Modify: `src/widget/preview.js` (remove drawNonogramGuidesOn call from buildStaticLayer's fallback; consider removing drawNonogramGuidesOn function)
- Modify: `src/widget/widget.js` (remove nonogram arms from setHintStatus fallback, loopHandler done-check fallback, hintHandler pre-solve gate, and any setHintLabel arm)
- Modify: `content.js` (remove nonogram arm from solveExtraData's switch)

For each removed arm, the registry will now handle Nonogram because PUZZLES['nonogram'] is non-empty.

- [ ] **Step 1: cache.js**

In `getCachedGridSolution`, remove the `: data?.type === 'nonogram' ? nonogramCacheKey(data)` arm from the ternary chain. In `cacheGridSolution`, same removal.

Decide: keep `nonogramCacheKey` as an exported helper or delete entirely? If no other consumer references it, DELETE. Search for callers:
```bash
grep -nE "nonogramCacheKey" src/widget/ content.js
```

If only cache.js's own ternary and its module.exports reference it, delete the function + the module.exports entry.

`SOLUTION_KEY_PREFIXES` includes `'nonogram-solution:'`. Per spec §4, this list is derived from `Object.values(PUZZLES).map(p => p.solutionKeyPrefix).filter(Boolean)` once ALL puzzles are migrated. For Stage C with 1 puzzle migrated, `SOLUTION_KEY_PREFIXES` stays as the static list — DON'T remove the `'nonogram-solution:'` entry (the other 14 puzzles still rely on this list for prune-loop scoping).

- [ ] **Step 2: preview.js**

In `buildStaticLayer`'s fallback `else` block, remove the `drawNonogramGuidesOn(ctx, rows, cols, cellSize, w, h, pd);` call.

Decide: keep `drawNonogramGuidesOn` as a helper or move into nonogram.js? Per spec §4: per-puzzle helpers that were inline move into their respective `puzzles/*.js` files. So MOVE the function body into nonogram.js's `drawStaticLayer` hook, and DELETE the standalone function from preview.js (+ remove its module.exports entry).

- [ ] **Step 3: widget.js**

Remove the `'nonogram'` arms from:
- `setHintStatus`'s fallback (the `else if (puzzleData?.type === 'nonogram')` arm).
- `loopHandler`'s done-check fallback (both sites — in-loop and post-loop).
- `hintHandler`'s pre-solve gate at line ~1197.
- Any other nonogram-specific arm found in the survey.

- [ ] **Step 4: content.js**

In `solveExtraData`, remove the `if (data.type === 'nonogram') { return { ... }; }` arm.

The `'nonogram'` SOLVER TYPE string passed to `runSolve(...)` at line ~433 STAYS — that's the solver-class identifier, not a per-puzzle branch.

- [ ] **Step 5: Verify**

```bash
cd /home/quando/documents/chrome-puzzle-solver
npm test 2>&1 | tail -5
npm run lint 2>&1 | tail -5
npm run typecheck 2>&1 | tail -5
npm run build 2>&1 | tail -3
```

Tests MUST stay 448/448 — Nonogram's logic is unchanged, just relocated.

Expected: lint may complain about `nonogramCacheKey` / `drawNonogramGuidesOn` if they're declared `readonly` in eslint.config.js but no longer exported / declared. If so, remove their eslint global entries too.

- [ ] **Step 6: Browser smoke (REQUIRED for Stage C)**

Reload extension, open a Nonogram puzzle, run Solve / Hint / Loop. Per the spec's migration §7 Phase 3 step 5: every Stage C migration MUST be smoke-tested in the browser before commit. The lint+test gate can't catch all browser-DOM-only failures.

If anything regresses, debug + fix BEFORE committing.

- [ ] **Step 7: Commit**

```bash
jj commit -m "refactor(content): migrate Nonogram to registry pattern

src/widget/puzzles/nonogram.js exports cacheKey, solveExtraData,
drawStaticLayer, hintDispatch, loopDoneCheck, hintStatusNodes.
Registered in puzzles/index.js. Inline branches deleted from cache.js,
preview.js, widget.js, content.js. SUPPORTED_PUZZLES and
SOLUTION_KEY_PREFIXES stay static until Stage D (all-puzzles-migrated)."
```

---

## Task 4: Update eslint + globals.d.ts

**Files:**
- Modify: `eslint.config.js`
- Modify: `globals.d.ts`

If Task 3 removed `nonogramCacheKey` / `drawNonogramGuidesOn` from preview.js or cache.js, their eslint globals + globals.d.ts entries are now dead. Remove them.

- [ ] **Step 1: Remove dead globals**

```bash
grep -nE "nonogramCacheKey|drawNonogramGuidesOn" eslint.config.js globals.d.ts
```

Edit out those lines if they exist.

- [ ] **Step 2: Re-verify**

```bash
npm run lint 2>&1 | tail -5
npm run typecheck 2>&1 | tail -5
```

Should still be clean.

- [ ] **Step 3: Commit + push**

```bash
jj commit -m "lint(content): drop dead nonogramCacheKey / drawNonogramGuidesOn globals after Nonogram migration"
jj log -r 'main..@-' --no-graph -T 'commit_id.short() ++ "  " ++ description.first_line() ++ "\n"'
jj bookmark set main -r @-
jj git push --bookmark main 2>&1 | tail -3
```

Expected: 2 commits ahead of main (Task 3 + Task 4); push clean.

---

## Self-review notes

**Spec coverage (Stage C / Phase 3 for one puzzle):**
- Spec §3 (per-puzzle module interface) → Task 1. ✓
- Spec §4 (`src/widget/puzzles/index.js` registry construction) → Task 2. ✓
- Spec §7 Phase 3 (per-puzzle migration steps 1-6) → Tasks 1-3. ✓
- Spec §7 Phase 3 step 5 (browser smoke required) → Task 3 Step 6. ✓
- Spec §4 derived `SOLUTION_KEY_PREFIXES` / `SUPPORTED_PUZZLES` → deferred to Stage D (noted inline).

**Open question for Task 2:** how the bundler handles inter-widget `require`s. The plan acknowledges uncertainty and prescribes reading `scripts/build-content-bundle.js` before writing the registry shape. If the bundler can't handle `require`, the workaround pattern is documented.

**Placeholder scan:** Task 1 Step 2's hook bodies are described as "copy verbatim from <location>" rather than written-out code. This is intentional — the existing inline code is the authoritative source, and copying it verbatim is safer than re-deriving it.

**Type consistency:** Hook names match spec §3 (`cacheKey`, `solveExtraData`, `drawStaticLayer`, `hintDispatch`, `loopDoneCheck`, `hintStatusNodes`).

End of plan.
