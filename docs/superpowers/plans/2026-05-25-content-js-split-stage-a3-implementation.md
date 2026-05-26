# content.js split — Stage A3 (makeWidget shell into widget.js) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move what's left of `makeWidget` (~1,450 LOC, content.js lines 529-1977) plus the `widgetExpandFn` cross-file ref into `src/widget/widget.js`. After A3, content.js is ~500 lines: chrome.runtime.onMessage listener, `solveExtraData`, `SUPPORTED_PUZZLES`/`WIDGET_STORAGE_KEY`/prefs, and a 6-line DOM-ready bootstrap.

**Architecture:** Three sub-tasks: T1 scaffolds widget.js + wires bundler/test-loader; T2 mechanically moves makeWidget + widgetExpandFn (uses EXHAUSTIVE closure-leak detection per [[closure-extraction-check]] — every free identifier in the slice gets accounted for); T3 registers new cross-file globals in eslint/globals.d.ts, runs final verification, and pushes.

**Reference spec:** `docs/superpowers/specs/2026-05-25-content-js-split-phase-2-stage-a-design.md` §5 (sub-stage A3) + §6 steps A3.1/A3.2/A3.3.

`jj commit` not git. Repo `/home/quando/documents/chrome-puzzle-solver/`.

---

## What changes

Before A3, content.js is 1,985 lines:

```
1-100       chrome.runtime.onMessage listener
101-487     solveExtraData
488-511     WIDGET_STORAGE_KEY + SUPPORTED_PUZZLES
513-516     widgetExpandFn (cross-file ref set by makeWidget)
518-527     loadWidgetPref + saveWidgetPref
529-1977    makeWidget   <-- moves to widget.js
1979-1985   DOM-ready bootstrap
```

After A3, content.js is ~500 lines (the slice above MINUS lines 513-516 and 529-1977 — those move out). widget.js holds:

- The full `makeWidget` body (now with `widgetExpandFn` assignment writing to a module-scope binding).
- The `widgetExpandFn` declaration at module scope (replaces content.js:516).

The DOM-ready bootstrap at 1979-1985 STAYS in content.js — it references `getActiveHandler()` (from handler.js, already a cross-file global) and `makeWidget()` (now a cross-file global, registered in T3).

`loadWidgetPref` / `saveWidgetPref` / `WIDGET_STORAGE_KEY` / `SUPPORTED_PUZZLES` STAY in content.js — they're called by makeWidget but the spec keeps them there because Stage B/C migrates `SUPPORTED_PUZZLES` to the registry. Keeping prefs in content.js keeps the migration boundary clean.

---

## Task 1 (A3.1): Scaffold widget.js + wire bundler/test loader

**Files:**
- Create: `src/widget/widget.js`
- Modify: `scripts/build-content-bundle.js`
- Modify: `tests/galaxies-hint.test.js`

This is the same scaffolding pattern Stage A0 used for preview.js. Empty file, then wire it into the bundle order and the vm test loader. Tests must stay green at the scaffold step (no functional change yet — the bundle still contains everything via content.js).

- [ ] **Step 1: Create the placeholder file**

Write `/home/quando/documents/chrome-puzzle-solver/src/widget/widget.js`:

```js
'use strict';

// Widget shell: makeWidget() factory + widgetExpandFn cross-file
// reference. The ~1,450-line makeWidget body and its `widgetExpandFn`
// assignment will land here in Stage A3 Task 2.
//
// Until Task 2 runs, this file is intentionally empty — the placeholder
// exists so the bundler's WIDGET_FILES order is stable.

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {};
}
```

- [ ] **Step 2: Wire into the bundle**

Open `scripts/build-content-bundle.js`. Find the `WIDGET_FILES` array. Append `'widget.js'` after `'preview.js'` and BEFORE `'puzzles/index.js'`:

```js
const WIDGET_FILES = [
  'state.js',
  'worker.js',
  'cache.js',
  'galaxies-hint.js',
  'hint.js',
  'preview.js',
  'widget.js',          // <-- NEW
  'puzzles/index.js',
];
```

Order matters: widget.js must come AFTER preview.js (it uses `renderPreview`) and BEFORE content.js (content.js will reference `makeWidget` and `widgetExpandFn` after T2).

- [ ] **Step 3: Wire into the vm test loader**

Open `tests/galaxies-hint.test.js`. Find the `widgetOrder` array (mirrors `WIDGET_FILES`). Add `'widget.js'` in the same position.

```bash
grep -n "widgetOrder" tests/galaxies-hint.test.js | head -3
```

Edit the array to match the bundler. If the array already contains `'puzzles/index.js'`, insert `'widget.js'` immediately before it (and after `'preview.js'`).

- [ ] **Step 4: Verify**

```bash
cd /home/quando/documents/chrome-puzzle-solver
node -e "require('./src/widget/widget.js'); console.log('widget.js parses');"
npm test 2>&1 | tail -5
npm run build 2>&1 | tail -3
grep -c "src/widget/widget.js" dist/content.js
```

Expected: widget.js parses, tests pass 448/448, build emits `Wrote dist/content.js`. The grep should return `1` — exactly one bundle-marker line for widget.js (`// ===== src/widget/widget.js =====` or similar, depending on build-content-bundle.js's marker format).

- [ ] **Step 5: Commit**

```bash
jj commit -m "build(content): widget.js scaffold + bundler + test loader wiring (Stage A3 setup)"
```

---

## Task 2 (A3.2): Move makeWidget + widgetExpandFn into widget.js

**Files:**
- Modify: `content.js` (remove ~1,453 lines: 513-516 widgetExpandFn block + 529-1977 makeWidget)
- Modify: `src/widget/widget.js` (replace placeholder with the moved code)

This is the largest mechanical move of the project so far. Per the [[closure-extraction-check]] lesson, the closure-leak audit is NON-NEGOTIABLE — exhaustive identifier enumeration, not hand-picked names.

- [ ] **Step 1: Read the slice boundaries**

```bash
cd /home/quando/documents/chrome-puzzle-solver
grep -n "^let widgetExpandFn\|^function makeWidget\|^if (document.readyState" content.js
```

Expected output:
```
516:let widgetExpandFn = null;
529:function makeWidget() {
1979:if (document.readyState === 'loading') {
```

The slice to extract is in TWO disjoint parts:
1. Lines 513-516: the comment block (`// Reference set by makeWidget()...`) + `let widgetExpandFn = null;` declaration.
2. Lines 529-1977: the entire `function makeWidget() { ... }` body.

The `function makeWidget()` opener is at 529; its closing `}` is at 1977 (one line before the blank at 1978 and the bootstrap at 1979).

- [ ] **Step 2: EXHAUSTIVE closure-leak enumeration**

This is the most important step. The Stage A2 plan failed here by hand-picking 6 closure refs; code review found 2 missing identifiers that would have crashed at runtime. Don't repeat that mistake.

Run a full free-identifier scan on the makeWidget slice:

```bash
cd /home/quando/documents/chrome-puzzle-solver
# Extract makeWidget body (lines 529-1977) into a temp file.
sed -n '529,1977p' content.js > /tmp/makewidget-slice.js

# Tokenize all identifiers, count unique ones.
grep -oE "\b[a-zA-Z_$][a-zA-Z0-9_$]*\b" /tmp/makewidget-slice.js | sort -u > /tmp/makewidget-idents.txt
wc -l /tmp/makewidget-idents.txt
```

Expected: a few hundred unique identifiers (variable names, function names, property names, keywords).

Now build the "known scope" set — identifiers that have valid resolution sources OTHER than the makeWidget closure:

1. **JS built-ins / keywords**: `true`, `false`, `null`, `undefined`, `let`, `const`, `var`, `function`, `if`, `else`, `for`, `while`, `do`, `switch`, `case`, `break`, `continue`, `return`, `try`, `catch`, `finally`, `throw`, `new`, `delete`, `typeof`, `instanceof`, `in`, `of`, `class`, `extends`, `this`, `super`, `async`, `await`, `yield`, `from`, `import`, `export`, `default`, plus globals: `Object`, `Array`, `String`, `Number`, `Boolean`, `Math`, `JSON`, `Date`, `Promise`, `Map`, `Set`, `WeakMap`, `WeakSet`, `Symbol`, `RegExp`, `Error`, `TypeError`, `RangeError`, `console`, `setTimeout`, `clearTimeout`, `setInterval`, `requestAnimationFrame`, `cancelAnimationFrame`, `fetch`, `Blob`, `URL`, `Worker`, `MutationObserver`, `window`, `document`, `localStorage`, `navigator`, `location`, `alert`, `Node`, `HTMLElement`, `HTMLCanvasElement`, `Path2D`, `Image`, `Event`, `CustomEvent`, `getComputedStyle`, `Int8Array`/`Uint8Array`/etc., `chrome` (MV3 global).

2. **Bundle-scope globals** (visible after widget.js is concatenated by the bundler): everything in `eslint.config.js`'s content.js globals block. Generate this list:
   ```bash
   grep -E "^\s+[a-zA-Z_$][a-zA-Z0-9_$]*:" eslint.config.js | grep -oE "^\s+[a-zA-Z_$][a-zA-Z0-9_$]*" | sort -u > /tmp/bundle-globals.txt
   ```

3. **makeWidget's own parameters and inner declarations**: the function takes no parameters. Inner `let`/`const`/`function`/`class` declarations inside makeWidget become local to widget.js's makeWidget body — same scoping. Extract them:
   ```bash
   grep -oE "(let|const|function|class)\s+[a-zA-Z_$][a-zA-Z0-9_$]*" /tmp/makewidget-slice.js | awk '{print $NF}' | sort -u > /tmp/makewidget-decls.txt
   ```

4. **Property accesses** (after `.` or as object keys): these are NOT free identifiers — they resolve via the object. Filter them out:
   ```bash
   # Identifiers that appear AFTER a dot. Crude but effective.
   grep -oE "\.[a-zA-Z_$][a-zA-Z0-9_$]*" /tmp/makewidget-slice.js | sed 's/^\.//' | sort -u > /tmp/property-names.txt
   ```

Now compute the residue — identifiers in the slice that are NOT in any "known scope" set:

```bash
# Combine all "known" identifiers into one sorted file.
cat /tmp/bundle-globals.txt /tmp/makewidget-decls.txt /tmp/property-names.txt | sort -u > /tmp/known-idents.txt

# Add JS keywords/builtins (hand-listed above) — write them to /tmp/js-builtins.txt one per line.
# Use this seed list:
cat > /tmp/js-builtins.txt <<'EOF'
true false null undefined let const var function if else for while do switch case break continue return try catch finally throw new delete typeof instanceof in of class extends this super async await yield from import export default
Object Array String Number Boolean Math JSON Date Promise Map Set WeakMap WeakSet Symbol RegExp Error TypeError RangeError SyntaxError ReferenceError
console setTimeout clearTimeout setInterval clearInterval requestAnimationFrame cancelAnimationFrame
fetch Blob URL Worker MutationObserver
window document localStorage navigator location alert
Node HTMLElement HTMLCanvasElement Path2D Image Event CustomEvent getComputedStyle
Int8Array Uint8Array Int16Array Uint16Array Int32Array Uint32Array Float32Array Float64Array
chrome globalThis
arguments
EOF
tr ' ' '\n' < /tmp/js-builtins.txt | sort -u > /tmp/js-builtins-sorted.txt
mv /tmp/js-builtins-sorted.txt /tmp/js-builtins.txt

cat /tmp/known-idents.txt /tmp/js-builtins.txt | sort -u > /tmp/all-known.txt

# The residue:
comm -23 /tmp/makewidget-idents.txt /tmp/all-known.txt > /tmp/residue.txt
wc -l /tmp/residue.txt
cat /tmp/residue.txt
```

For EVERY name in the residue, classify it as one of:
- **(a) String literal content / template string fragment** (not a real identifier — false positive from the tokenizer). Examples: text inside HTML strings.
- **(b) Object-literal key / destructuring target** (resolves locally to the object). E.g., `{name, url}` in a destructure.
- **(c) Comment text** (false positive). E.g., a word inside `// ...` or `/* ... */`.
- **(d) Legitimate closure reference** — needs handling.

For (a)/(b)/(c), grep the slice for the name in context to confirm it's a false positive:
```bash
grep -nE "(^|[^a-zA-Z0-9_$])NAME([^a-zA-Z0-9_$]|$)" /tmp/makewidget-slice.js | head -5
```

For (d), every legitimate closure reference must have a resolution plan. In the makeWidget case, the spec promises there are essentially zero closure references EXCEPT:
- `widgetExpandFn` — moves to module scope in widget.js alongside makeWidget.
- (Possibly a few sibling top-level names in content.js that DON'T appear in eslint.config.js globals — flag any such finding as a `BLOCKED` status.)

If the residue contains identifiers NOT in any of (a)/(b)/(c)/(d), STOP. Report as BLOCKED. The plan needs amendment before proceeding.

If the residue is clean (all classifiable as a/b/c or the known (d) case `widgetExpandFn`), proceed.

- [ ] **Step 3: Move the slice into widget.js**

Read content.js lines 513-1977 (the two slices combined: comment + `widgetExpandFn` + blank + prefs + makeWidget). Actually — lines 513-516 (widgetExpandFn) move, lines 518-527 (prefs) STAY, lines 529-1977 (makeWidget) move. Two non-contiguous moves.

Replace the placeholder in widget.js with:

```js
'use strict';

// Widget shell. The makeWidget() factory builds the DOM, wires button
// handlers, mounts the state-watch MutationObserver, and wires lifecycle
// hooks (pagehide/pageshow). widgetExpandFn is assigned by makeWidget
// so the top-level chrome.runtime.onMessage listener in content.js can
// drive widget expansion without reaching into the closure.
//
// Bundle order: this file is concatenated AFTER preview.js (so it sees
// renderPreview / latticeLayer / etc. at module scope) and BEFORE
// content.js (so content.js's listener and DOM-ready bootstrap can
// reference makeWidget and widgetExpandFn).

let widgetExpandFn = null;

function makeWidget() {
  <verbatim body from content.js:529-1977, stripped of OUTER-function indent
   if any — makeWidget is already at top-level indent (no leading spaces
   on `function makeWidget()`), so no de-indent is needed for the body>
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { makeWidget };
}
```

Notice: `widgetExpandFn` is at top of widget.js (module scope), and `makeWidget` is the only export. The function body is moved VERBATIM — no de-indentation needed because `function makeWidget()` was already at content.js's top level (column 0).

If the body is too large for a single Edit/Write, split into two Write operations to a temp file and concatenate, or do two Edits in sequence (e.g., write the file header + first half, then append the second half with a second Edit). The body is ~1,450 lines — the Write tool should handle it in one call.

- [ ] **Step 4: Remove the slice from content.js**

Two Edits:

Edit A: `old_string` = lines 513-516 (the 4-line block: comment + `let widgetExpandFn = null;` + trailing blank), `new_string` = empty.

```
// Reference set by makeWidget() so the top-level message listener (for the
// toolbar-icon click → expandWidget action) can drive the widget without
// reaching into its closure.
let widgetExpandFn = null;
```

Edit B: `old_string` = the entire makeWidget function body (`function makeWidget() {` through its matching closing `}` at line 1977), `new_string` = empty.

If Edit B's `old_string` exceeds the tool's per-call limit, split into two passes: first edit removes the first ~700 lines (find a stable midpoint inside makeWidget — e.g., a top-level inner `function` declaration like `function setStatus(...)`), then second edit removes the rest.

After both edits, content.js ends with `loadWidgetPref` / `saveWidgetPref` at lines ~518-527, then jumps directly to the DOM-ready bootstrap (originally lines 1979-1985).

- [ ] **Step 5: Verify**

```bash
cd /home/quando/documents/chrome-puzzle-solver
node -e "require('./src/widget/widget.js'); console.log('widget.js parses');"
node -e "require('./content.js'); console.log('content.js parses');" 2>&1 | tail -3
wc -l content.js
npm test 2>&1 | tail -5
npm run build 2>&1 | tail -3
grep -c "^function makeWidget\|^let widgetExpandFn" dist/content.js
```

Expected:
- widget.js parses standalone.
- content.js: may emit a "module is not defined" or similar warning under Node because content.js was never designed to load standalone — that's pre-existing behavior. As long as it doesn't `SyntaxError`, the parse is good. (If it does syntax-error, the Edit boundaries were wrong.)
- content.js shrinks from 1,985 to ~535 lines.
- npm test: pass 448 / fail 0.
- Build emits `Wrote dist/content.js`.
- Grep returns `2` (one `function makeWidget` declaration, one `let widgetExpandFn`).

If a test fails with `ReferenceError`, the closure-leak audit (Step 2) missed something. Identify the missing name from the test stack trace and re-classify per Step 2's (a)/(b)/(c)/(d) rubric.

- [ ] **Step 6: Commit**

```bash
jj commit -m "refactor(content): move makeWidget shell + widgetExpandFn into src/widget/widget.js

content.js shrinks ~1,450 lines: the makeWidget factory and the
widgetExpandFn cross-file ref both move to widget.js. content.js
retains the chrome.runtime.onMessage listener, solveExtraData, prefs,
and the DOM-ready bootstrap. SUPPORTED_PUZZLES / WIDGET_STORAGE_KEY /
solveExtraData stay in content.js (they migrate in Stage B/C, not A)."
```

---

## Task 3 (A3.3): Register new globals + final lint/typecheck/push

**Files:**
- Modify: `eslint.config.js`
- Modify: `globals.d.ts`

content.js now references `makeWidget` and `widgetExpandFn` as cross-file globals (from widget.js). widget.js references `renderPreview` (already registered in Stage A2) and the various bundle-scope helpers (state, worker, cache, hint, etc., all already registered for content.js — and widget.js is in the same globals scope per eslint.config.js's `files: ['content.js', 'src/widget/**/*.js']`).

So only TWO new names need registration: `makeWidget` and `widgetExpandFn`.

- [ ] **Step 1: Update eslint.config.js**

Open `eslint.config.js`. Find the `// src/widget/preview.js` globals group (ends with `previewWrap: 'writable',`). Add a new section after it:

```js
        // src/widget/widget.js
        makeWidget: 'readonly',
        widgetExpandFn: 'writable',
```

(`widgetExpandFn` is `writable` because makeWidget mutates it. `makeWidget` is `readonly` — it's a function declaration.)

- [ ] **Step 2: Update globals.d.ts**

Open `globals.d.ts`. Find the `declare let previewWrap: any;` line (last Stage A2 entry). Append a new group after it:

```ts
// src/widget/widget.js
declare function makeWidget(): any;
declare let widgetExpandFn: any;
```

- [ ] **Step 3: Verify**

```bash
cd /home/quando/documents/chrome-puzzle-solver
npm run lint 2>&1 | tail -10
npm run typecheck 2>&1 | tail -5
npm test 2>&1 | tail -5
npm run build 2>&1 | tail -3
```

Expected: lint clean, typecheck clean, tests 448/448, build emits `Wrote dist/content.js`.

If lint or typecheck reports an undeclared symbol other than `makeWidget` / `widgetExpandFn`, the closure-leak audit in Task 2 Step 2 missed a (d)-class identifier. Report as BLOCKED — return to Task 2 to fix.

- [ ] **Step 4: Manual browser smoke (recommended before push)**

Per the lesson from [[closure-extraction-check]]: tests don't exercise the browser DOM-touching paths, so a runtime closure leak would survive `npm test` AND `npm run lint` (the latter only if the leak resolves to a declared-but-out-of-scope global). The defence: load the extension in Chrome and verify each major path manually.

1. Reload `chrome://extensions/` → click reload on chrome-puzzle-solver.
2. Open any puzzle URL (e.g., `https://www.puzzles-mobile.com/nonogram/random/5x5-easy`).
3. Confirm the widget appears in the page corner.
4. Confirm the Detect / Solve / Hint / Loop buttons all work.
5. Confirm the chrome toolbar icon click expands the widget (this tests the `widgetExpandFn` cross-file ref path).
6. Confirm the preview canvas renders (this tests `renderPreview` indirectly + the makeWidget→widget.js move).
7. Open DevTools console; confirm no `ReferenceError` in red.

If anything fails, do not push. Diagnose the closure leak via console error, fix in widget.js, and re-test.

- [ ] **Step 5: Commit + push**

```bash
jj commit -m "lint(content): makeWidget + widgetExpandFn globals in eslint + globals.d.ts"
jj log -r 'main..@-' --no-graph -T 'commit_id.short() ++ "  " ++ description.first_line() ++ "\n"'
jj bookmark set main -r @-
jj git push --bookmark main 2>&1 | tail -3
```

Expected jj log output: 3 commits ahead of main (Task 1 scaffold, Task 2 move, Task 3 lint).

Push succeeds; origin/main advances to the new tip.

---

## Self-review notes

**Spec coverage (Stage A3 from §5 + §6 steps 5-8):**
- A3.1 (widget.js scaffold + bundler + test loader) → Task 1. ✓
- A3.2 (move makeWidget body + lifecycle + widgetExpandFn) → Task 2. ✓
- A3.3 (eslint + globals.d.ts) → Task 3. ✓
- §6 step 8 (lint, typecheck, npm test, npm run build, manual browser smoke, push to main) → Task 3 Steps 3-5. ✓

**Lifecycle hooks:** §5 says they move "with the widget." Verified by reading content.js lines 1960-1977 — the `window.addEventListener('pagehide'/'pageshow', ...)` registrations are INSIDE the makeWidget function body (at the bottom of the function), so they automatically move with makeWidget. No separate handling needed.

**DOM-ready bootstrap:** §5 says "Maybe a one-line `if (document.readyState === ...) makeWidget()` bootstrap." Lines 1979-1985 of content.js are this bootstrap; they're at top-level (outside makeWidget) and STAY in content.js. `getActiveHandler()` and `makeWidget()` resolve as cross-file globals.

**Placeholder scan:** No "TBD" / "implement later". Step 2's closure-leak audit is the most prescriptive section because that's where Stage A2 failed — the prescription is intentional. Boundaries are grep-discovered.

**Type consistency:** `makeWidget` (readonly in eslint, `declare function` in tsc) and `widgetExpandFn` (writable in eslint, `declare let` in tsc) — matches Stage A0/A1/A2 conventions for function vs mutable-state globals.

End of plan.
