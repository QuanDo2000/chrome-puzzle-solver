# `solver.js` Per-Puzzle Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mechanically extract the 15 puzzle-solver classes and `computePuzzleDiff` from the monolithic `solver.js` (12,016 lines) into one source file per puzzle under `src/solvers/`, replace the root `solver.js` with a 1-line shim, and add a small concatenation script that produces `dist/solver.js` for the extension.

**Architecture:** Pure refactor — no class or logic changes. The shim at the root keeps every existing `require('../solver.js')` working. The bundler script regenerates `dist/solver.js` from the split sources. Test suite must show identical pass count before and after.

**Reference spec:** `docs/superpowers/specs/2026-05-25-solver-js-split-design.md`

`jj commit` not git. Repo `/home/quando/documents/chrome-puzzle-solver/`.

---

## File-extraction template

Every extracted file follows the same shape. Replace `ClassName` and paste the class body verbatim:

```js
'use strict';

class ClassName {
  // (verbatim class body from solver.js)
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ClassName };
}
```

`diff.js` uses the same shape but exports `{ computePuzzleDiff }` and wraps the bare function instead of a class.

## Class line ranges in `solver.js`

| Class | Lines (start..end) | Output file |
| --- | --- | --- |
| `NonogramSolver` | 17 – 482 | `src/solvers/nonogram.js` |
| `GalaxiesSolver` | 483 – 1303 | `src/solvers/galaxies.js` |
| `AquariumSolver` | 1304 – 2467 | `src/solvers/aquarium.js` |
| `BinairoSolver` | 2468 – 3473 | `src/solvers/binairo.js` |
| `ShikakuSolver` | 3474 – 3781 | `src/solvers/shikaku.js` |
| `YinYangSolver` | 3782 – 4434 | `src/solvers/yinyang.js` |
| `SlitherlinkSolver` | 4435 – 6934 | `src/solvers/slitherlink.js` |
| `computePuzzleDiff` | 6935 – 7010 | `src/solvers/diff.js` |
| `HashiSolver` | 7011 – 7751 | `src/solvers/hashi.js` |
| `HeyawakeSolver` | 7752 – 8334 | `src/solvers/heyawake.js` |
| `HitoriSolver` | 8335 – 8849 | `src/solvers/hitori.js` |
| `KakurasuSolver` | 8850 – 9276 | `src/solvers/kakurasu.js` |
| `KurodokoSolver` | 9277 – 9751 | `src/solvers/kurodoko.js` |
| `MosaicSolver` | 9752 – 10294 | `src/solvers/mosaic.js` |
| `NorinoriSolver` | 10295 – 10718 | `src/solvers/norinori.js` |
| `NurikabeSolver` | 10719 – 12012 | `src/solvers/nurikabe.js` |

(End-of-class lines verified empirically: each ends at the line immediately before the next class declaration, or for NurikabeSolver immediately before the trailing `if (typeof module ...)` block at 12013.)

---

## Task 1: Set up `src/solvers/` + extract `NonogramSolver` (pilot)

**Files:**
- Create: `src/solvers/nonogram.js`

This task establishes the extraction pattern. Subsequent tasks repeat it.

- [ ] **Step 1: Create the directory**

```bash
mkdir -p src/solvers
```

- [ ] **Step 2: Read `solver.js` lines 17-482**

Use the Read tool with `offset: 17, limit: 466` against `/home/quando/documents/chrome-puzzle-solver/solver.js`.

- [ ] **Step 3: Write `src/solvers/nonogram.js`**

The file content must be exactly:

```
'use strict';

<the slice from step 2 — class body verbatim, starting with "class NonogramSolver {" and ending with the matching closing brace at line 482>

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { NonogramSolver };
}
```

Strip any trailing blank lines from the slice before adding the export footer; preserve one blank line between the class closing brace and the export block.

- [ ] **Step 4: Verify the file loads cleanly**

```bash
node -e "const m = require('./src/solvers/nonogram.js'); if (typeof m.NonogramSolver !== 'function') { console.error('export missing'); process.exit(1); } console.log('ok');"
```

Expected: `ok` on stdout, exit 0.

- [ ] **Step 5: Commit**

```bash
jj commit -m "refactor(solver): extract NonogramSolver into src/solvers/nonogram.js"
```

---

## Task 2: Extract 3 more solvers — galaxies, aquarium, binairo

**Files:**
- Create: `src/solvers/galaxies.js`
- Create: `src/solvers/aquarium.js`
- Create: `src/solvers/binairo.js`

Same procedure as Task 1, repeated for each.

- [ ] **Step 1: Extract `GalaxiesSolver`**

Read `solver.js` with `offset: 483, limit: 821`. Write `src/solvers/galaxies.js` with the per-puzzle template (class name `GalaxiesSolver`).

- [ ] **Step 2: Extract `AquariumSolver`**

Read `solver.js` with `offset: 1304, limit: 1164`. Write `src/solvers/aquarium.js` (class name `AquariumSolver`).

- [ ] **Step 3: Extract `BinairoSolver`**

Read `solver.js` with `offset: 2468, limit: 1006`. Write `src/solvers/binairo.js` (class name `BinairoSolver`).

- [ ] **Step 4: Verify all three load**

```bash
node -e "
const g = require('./src/solvers/galaxies.js');
const a = require('./src/solvers/aquarium.js');
const b = require('./src/solvers/binairo.js');
if (typeof g.GalaxiesSolver !== 'function') { console.error('GalaxiesSolver missing'); process.exit(1); }
if (typeof a.AquariumSolver !== 'function') { console.error('AquariumSolver missing'); process.exit(1); }
if (typeof b.BinairoSolver !== 'function') { console.error('BinairoSolver missing'); process.exit(1); }
console.log('ok');
"
```

Expected: `ok`.

- [ ] **Step 5: Commit**

```bash
jj commit -m "refactor(solver): extract Galaxies/Aquarium/Binairo into src/solvers/"
```

---

## Task 3: Extract 4 more — shikaku, yinyang, slitherlink, hashi

**Files:**
- Create: `src/solvers/shikaku.js`
- Create: `src/solvers/yinyang.js`
- Create: `src/solvers/slitherlink.js`
- Create: `src/solvers/hashi.js`

- [ ] **Step 1: Extract `ShikakuSolver`**

Read `solver.js` with `offset: 3474, limit: 308`. Write `src/solvers/shikaku.js` (class name `ShikakuSolver`).

- [ ] **Step 2: Extract `YinYangSolver`**

Read `solver.js` with `offset: 3782, limit: 653`. Write `src/solvers/yinyang.js` (class name `YinYangSolver`).

- [ ] **Step 3: Extract `SlitherlinkSolver`**

Read `solver.js` with `offset: 4435, limit: 2500`. Write `src/solvers/slitherlink.js` (class name `SlitherlinkSolver`).

- [ ] **Step 4: Extract `HashiSolver`**

Read `solver.js` with `offset: 7011, limit: 741`. Write `src/solvers/hashi.js` (class name `HashiSolver`).

- [ ] **Step 5: Verify all four load**

```bash
node -e "
const s = require('./src/solvers/shikaku.js');
const y = require('./src/solvers/yinyang.js');
const l = require('./src/solvers/slitherlink.js');
const h = require('./src/solvers/hashi.js');
if (typeof s.ShikakuSolver !== 'function') { console.error('Shikaku missing'); process.exit(1); }
if (typeof y.YinYangSolver !== 'function') { console.error('YinYang missing'); process.exit(1); }
if (typeof l.SlitherlinkSolver !== 'function') { console.error('Slitherlink missing'); process.exit(1); }
if (typeof h.HashiSolver !== 'function') { console.error('Hashi missing'); process.exit(1); }
console.log('ok');
"
```

Expected: `ok`.

- [ ] **Step 6: Commit**

```bash
jj commit -m "refactor(solver): extract Shikaku/YinYang/Slitherlink/Hashi into src/solvers/"
```

---

## Task 4: Extract 4 more — heyawake, hitori, kakurasu, kurodoko

**Files:**
- Create: `src/solvers/heyawake.js`
- Create: `src/solvers/hitori.js`
- Create: `src/solvers/kakurasu.js`
- Create: `src/solvers/kurodoko.js`

- [ ] **Step 1: Extract `HeyawakeSolver`**

Read `solver.js` with `offset: 7752, limit: 583`. Write `src/solvers/heyawake.js` (class name `HeyawakeSolver`).

- [ ] **Step 2: Extract `HitoriSolver`**

Read `solver.js` with `offset: 8335, limit: 515`. Write `src/solvers/hitori.js` (class name `HitoriSolver`).

- [ ] **Step 3: Extract `KakurasuSolver`**

Read `solver.js` with `offset: 8850, limit: 427`. Write `src/solvers/kakurasu.js` (class name `KakurasuSolver`).

- [ ] **Step 4: Extract `KurodokoSolver`**

Read `solver.js` with `offset: 9277, limit: 475`. Write `src/solvers/kurodoko.js` (class name `KurodokoSolver`).

- [ ] **Step 5: Verify all four load**

```bash
node -e "
const heya = require('./src/solvers/heyawake.js');
const hit = require('./src/solvers/hitori.js');
const k = require('./src/solvers/kakurasu.js');
const ku = require('./src/solvers/kurodoko.js');
if (typeof heya.HeyawakeSolver !== 'function') { console.error('Heyawake missing'); process.exit(1); }
if (typeof hit.HitoriSolver !== 'function') { console.error('Hitori missing'); process.exit(1); }
if (typeof k.KakurasuSolver !== 'function') { console.error('Kakurasu missing'); process.exit(1); }
if (typeof ku.KurodokoSolver !== 'function') { console.error('Kurodoko missing'); process.exit(1); }
console.log('ok');
"
```

Expected: `ok`.

- [ ] **Step 6: Commit**

```bash
jj commit -m "refactor(solver): extract Heyawake/Hitori/Kakurasu/Kurodoko into src/solvers/"
```

---

## Task 5: Extract last 4 — mosaic, norinori, nurikabe + computePuzzleDiff

**Files:**
- Create: `src/solvers/mosaic.js`
- Create: `src/solvers/norinori.js`
- Create: `src/solvers/nurikabe.js`
- Create: `src/solvers/diff.js`

- [ ] **Step 1: Extract `MosaicSolver`**

Read `solver.js` with `offset: 9752, limit: 543`. Write `src/solvers/mosaic.js` (class name `MosaicSolver`).

- [ ] **Step 2: Extract `NorinoriSolver`**

Read `solver.js` with `offset: 10295, limit: 424`. Write `src/solvers/norinori.js` (class name `NorinoriSolver`).

- [ ] **Step 3: Extract `NurikabeSolver`**

Read `solver.js` with `offset: 10719, limit: 1294`. Write `src/solvers/nurikabe.js` (class name `NurikabeSolver`).

- [ ] **Step 4: Extract `computePuzzleDiff`**

Read `solver.js` with `offset: 6935, limit: 76`. Write `src/solvers/diff.js` using this template (NOT the class template — wrap the bare function):

```js
'use strict';

<the slice from step 4 — starts with "function computePuzzleDiff(...) {" and ends with the matching closing brace at line 7010>

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { computePuzzleDiff };
}
```

- [ ] **Step 5: Verify all four load**

```bash
node -e "
const m = require('./src/solvers/mosaic.js');
const no = require('./src/solvers/norinori.js');
const nu = require('./src/solvers/nurikabe.js');
const d = require('./src/solvers/diff.js');
if (typeof m.MosaicSolver !== 'function') { console.error('Mosaic missing'); process.exit(1); }
if (typeof no.NorinoriSolver !== 'function') { console.error('Norinori missing'); process.exit(1); }
if (typeof nu.NurikabeSolver !== 'function') { console.error('Nurikabe missing'); process.exit(1); }
if (typeof d.computePuzzleDiff !== 'function') { console.error('computePuzzleDiff missing'); process.exit(1); }
console.log('ok');
"
```

Expected: `ok`.

- [ ] **Step 6: Commit**

```bash
jj commit -m "refactor(solver): extract Mosaic/Norinori/Nurikabe + computePuzzleDiff"
```

---

## Task 6: Write `src/solvers/index.js` + replace root `solver.js` with shim

**Files:**
- Create: `src/solvers/index.js`
- Modify: `solver.js` (replace entire file)

- [ ] **Step 1: Write `src/solvers/index.js`**

Exactly this content:

```js
'use strict';

/**
 * Solver result envelope. Cell value conventions are solver-specific:
 *   NonogramSolver: 1 = filled, -1 = empty, 0 = unknown
 *   AquariumSolver: 1 = water,  -1 = dry,   0 = unknown
 *   GalaxiesSolver: cell value = (star index + 1), 0 = unassigned (unsolved
 *     only). The grid array also has a `.galaxies` property: lines between
 *     adjacent cells that belong to different stars.
 *
 * @typedef {Object} SolveResult
 * @property {boolean} solved
 * @property {number[][] | null} [grid]
 * @property {string} [error]
 * @property {number[][]} [partialGrid]
 * @property {number} [partialFilled]
 */

const { NonogramSolver } = require('./nonogram.js');
const { AquariumSolver } = require('./aquarium.js');
const { GalaxiesSolver } = require('./galaxies.js');
const { BinairoSolver } = require('./binairo.js');
const { ShikakuSolver } = require('./shikaku.js');
const { YinYangSolver } = require('./yinyang.js');
const { SlitherlinkSolver } = require('./slitherlink.js');
const { HashiSolver } = require('./hashi.js');
const { HeyawakeSolver } = require('./heyawake.js');
const { HitoriSolver } = require('./hitori.js');
const { KakurasuSolver } = require('./kakurasu.js');
const { KurodokoSolver } = require('./kurodoko.js');
const { MosaicSolver } = require('./mosaic.js');
const { NorinoriSolver } = require('./norinori.js');
const { NurikabeSolver } = require('./nurikabe.js');
const { computePuzzleDiff } = require('./diff.js');

module.exports = {
  NonogramSolver, AquariumSolver, GalaxiesSolver, BinairoSolver,
  ShikakuSolver, YinYangSolver, SlitherlinkSolver, HashiSolver,
  HeyawakeSolver, HitoriSolver, KakurasuSolver, KurodokoSolver,
  MosaicSolver, NorinoriSolver, NurikabeSolver, computePuzzleDiff,
};
```

- [ ] **Step 2: Replace root `solver.js`**

Overwrite the entire 12,016-line file with this:

```js
'use strict';
module.exports = require('./src/solvers/index.js');
```

- [ ] **Step 3: Verify the shim chain resolves**

```bash
node -e "
const m = require('./solver.js');
const names = ['NonogramSolver','AquariumSolver','GalaxiesSolver','BinairoSolver','ShikakuSolver','YinYangSolver','SlitherlinkSolver','HashiSolver','HeyawakeSolver','HitoriSolver','KakurasuSolver','KurodokoSolver','MosaicSolver','NorinoriSolver','NurikabeSolver'];
for (const n of names) {
  if (typeof m[n] !== 'function') { console.error(n + ' missing'); process.exit(1); }
}
if (typeof m.computePuzzleDiff !== 'function') { console.error('computePuzzleDiff missing'); process.exit(1); }
console.log('shim ok');
"
```

Expected: `shim ok`.

- [ ] **Step 4: Run the full test suite**

```bash
npm test 2>&1 | tail -6
```

Expected: `pass 448 / fail 0` (same as before the refactor). If any test fails, an extraction is incorrect — investigate.

- [ ] **Step 5: Commit**

```bash
jj commit -m "refactor(solver): src/solvers/index.js + reduce root solver.js to shim"
```

---

## Task 7: Write `scripts/build-solver-bundle.js`

**Files:**
- Create: `scripts/build-solver-bundle.js`

- [ ] **Step 1: Create the directory and write the script**

```bash
mkdir -p scripts
```

Write `scripts/build-solver-bundle.js`:

```js
'use strict';
// Concatenate src/solvers/*.js into a single dist/solver.js bundle. The
// extension's Blob worker requires solver.js as one self-contained text
// file (per content.js getSolverWorker — see CLAUDE.md "MV3 Worker
// cross-origin gotcha"). Run from `npm run build`.

const fs = require('fs');
const path = require('path');

// Order is for readability only — classes don't reference each other at
// file scope. `diff.js` is listed last because computePuzzleDiff is the
// cross-puzzle helper.
const FILES = [
  'aquarium.js', 'binairo.js', 'galaxies.js', 'hashi.js',
  'heyawake.js', 'hitori.js', 'kakurasu.js', 'kurodoko.js',
  'mosaic.js', 'nonogram.js', 'norinori.js', 'nurikabe.js',
  'shikaku.js', 'slitherlink.js', 'yinyang.js',
  'diff.js',
];
const EXPORTS = [
  'NonogramSolver', 'AquariumSolver', 'GalaxiesSolver', 'BinairoSolver',
  'ShikakuSolver', 'YinYangSolver', 'SlitherlinkSolver', 'HashiSolver',
  'HeyawakeSolver', 'HitoriSolver', 'KakurasuSolver', 'KurodokoSolver',
  'MosaicSolver', 'NorinoriSolver', 'NurikabeSolver', 'computePuzzleDiff',
];

// Strip the trailing CommonJS export block from a per-puzzle source. The
// block is the LAST `if (typeof module ...) { module.exports = {...} }`
// in each file; we anchor on the closing `}` of the file to avoid
// matching a stray literal in a class body.
const EXPORT_RE =
  /\n\s*if\s*\(\s*typeof\s+module[\s\S]*?module\.exports\s*=\s*\{[\s\S]*?\}\s*;?\s*\}\s*$/;

const srcDir = path.join(__dirname, '..', 'src', 'solvers');
const parts = [
  "'use strict';",
  "// Generated by scripts/build-solver-bundle.js — do not edit by hand.",
  "",
];

for (const file of FILES) {
  const fullPath = path.join(srcDir, file);
  let body = fs.readFileSync(fullPath, 'utf8');
  // Drop the per-file 'use strict' to avoid duplication at the top.
  body = body.replace(/^\s*'use strict';\s*\n/, '');
  // Drop the per-file CommonJS export block. If the regex fails to match,
  // throw — the bundle would be subtly broken otherwise.
  const stripped = body.replace(EXPORT_RE, '');
  if (stripped === body) {
    throw new Error(`Could not strip CJS export block from ${file}; check the file's footer`);
  }
  parts.push(`// ── ${file} ──`);
  parts.push(stripped.trim());
  parts.push("");
}

parts.push("if (typeof module !== 'undefined' && module.exports) {");
parts.push(`  module.exports = { ${EXPORTS.join(', ')} };`);
parts.push("}");
parts.push("");

const outDir = path.join(__dirname, '..', 'dist');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'solver.js'), parts.join('\n'));
console.log('Wrote dist/solver.js');
```

- [ ] **Step 2: Run the script**

```bash
node scripts/build-solver-bundle.js
```

Expected: `Wrote dist/solver.js`.

- [ ] **Step 3: Verify the bundle loads and exports everything**

```bash
node -e "
const m = require('./dist/solver.js');
const names = ['NonogramSolver','AquariumSolver','GalaxiesSolver','BinairoSolver','ShikakuSolver','YinYangSolver','SlitherlinkSolver','HashiSolver','HeyawakeSolver','HitoriSolver','KakurasuSolver','KurodokoSolver','MosaicSolver','NorinoriSolver','NurikabeSolver'];
for (const n of names) {
  if (typeof m[n] !== 'function') { console.error(n + ' missing'); process.exit(1); }
}
if (typeof m.computePuzzleDiff !== 'function') { console.error('computePuzzleDiff missing'); process.exit(1); }
console.log('bundle ok');
"
```

Expected: `bundle ok`.

- [ ] **Step 4: Commit**

```bash
jj commit -m "build(solver): add scripts/build-solver-bundle.js"
```

---

## Task 8: Update `package.json` build + final verification

**Files:**
- Modify: `package.json` (change the `build` script)

- [ ] **Step 1: Read the current build script**

Open `package.json`. Find the `"build"` line. It currently reads:

```
"build": "rm -rf dist && mkdir -p dist/icons && cp manifest.json background.js main-world.js content.js handler.js solver.js solver.worker.js dist/ && cp icons/icon-16.png icons/icon-32.png icons/icon-48.png icons/icon-128.png dist/icons/"
```

- [ ] **Step 2: Replace it**

Remove `solver.js` from the `cp` list (it's now generated, not copied). Insert a `node scripts/build-solver-bundle.js` step. The new value:

```
"build": "rm -rf dist && mkdir -p dist/icons && node scripts/build-solver-bundle.js && cp manifest.json background.js main-world.js content.js handler.js solver.worker.js dist/ && cp icons/icon-16.png icons/icon-32.png icons/icon-48.png icons/icon-128.png dist/icons/"
```

- [ ] **Step 3: Run the build**

```bash
npm run build 2>&1 | tail -3
```

Expected: build completes; `dist/solver.js` is the bundle (not a copy of root `solver.js`), and `dist/` contains the usual file set (manifest.json, background.js, main-world.js, content.js, handler.js, solver.js, solver.worker.js, icons/).

- [ ] **Step 4: Verify dist contents**

```bash
ls -la dist/ && head -3 dist/solver.js
```

Expected: 7 JS files + icons/. `dist/solver.js` first lines show `'use strict';` and the bundler header comment.

- [ ] **Step 5: Full test suite via the shim**

```bash
npm test 2>&1 | tail -6
```

Expected: `pass 448 / fail 0`.

- [ ] **Step 6: Lint + typecheck**

```bash
npm run lint 2>&1 | tail -3 && npm run typecheck 2>&1 | tail -3
```

Expected: no errors or warnings.

- [ ] **Step 7: Verify the bundled `dist/solver.js` is independently loadable**

```bash
node -e "
const m = require('./dist/solver.js');
const names = ['NonogramSolver','AquariumSolver','GalaxiesSolver','BinairoSolver','ShikakuSolver','YinYangSolver','SlitherlinkSolver','HashiSolver','HeyawakeSolver','HitoriSolver','KakurasuSolver','KurodokoSolver','MosaicSolver','NorinoriSolver','NurikabeSolver'];
for (const n of names) if (typeof m[n] !== 'function') { console.error(n); process.exit(1); }
if (typeof m.computePuzzleDiff !== 'function') { console.error('computePuzzleDiff'); process.exit(1); }
console.log('dist/solver.js ok');
"
```

Expected: `dist/solver.js ok`.

- [ ] **Step 8: Commit**

```bash
jj commit -m "build(solver): wire build-solver-bundle.js into npm run build"
```

---

## Task 9: Push to main

**Files:** none.

- [ ] **Step 1: Review the commit chain**

```bash
jj log -r 'main..@-' --no-graph -T 'commit_id.short() ++ "  " ++ description.first_line() ++ "\n"'
```

Expected: 8 commits (one per task above) plus the spec from the prior brainstorm.

- [ ] **Step 2: Advance the main bookmark**

```bash
jj bookmark set main -r @-
```

- [ ] **Step 3: Push**

```bash
jj git push --bookmark main 2>&1 | tail -3
```

Expected: `Changes to push to origin: bookmark: main [move forward ...]` then a clean push.

---

## Self-review notes

**Spec coverage:**
- §2 Layout (16 source files + index + scripts) → Tasks 1-5 (15 solvers + diff) + Task 6 (index + shim) + Task 7 (bundle script). ✓
- §3 Per-puzzle file format → file-extraction template at top of plan. ✓
- §4 `src/solvers/index.js` → Task 6 step 1 (full content inline). ✓
- §5 Build script → Task 7 step 1 (full content inline). ✓
- §6 `package.json` build script change → Task 8 step 2 (exact replacement string inline). ✓
- §7 Root `solver.js` shim → Task 6 step 2 (full content inline). ✓
- §8 Tests / `node -e "require('./dist/solver.js')"` check → Task 7 step 3 and Task 8 step 7. ✓
- §9 Migration steps 1-10 → mapped to Tasks 1-8 + Task 9. ✓

**Placeholder scan:** No "TBD" / "implement later" / hand-waving. Every step has either a code block, a Bash command with expected output, or a Read/Write tool description.

**Type consistency:** Class names match spec exactly. File names match spec exactly. `EXPORTS` list in Task 7 matches the spec's bundler output order.

End of plan.
