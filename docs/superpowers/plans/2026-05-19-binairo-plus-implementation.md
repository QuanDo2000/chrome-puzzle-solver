# Binairo Plus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add support for Binairo Plus (`/binairo-plus/*`) — Binairo + comparison-clue markers (`=` / `≠` between adjacent cells) — by extending the existing `BinairoSolver` and `binairoHandler` rather than introducing a parallel class.

**Architecture:** `BinairoSolver` gets an optional `comparisonClues` constructor parameter, a `_decodeComparison` helper that flattens the page's sparse 2D flag format into a canonical array of constraints, and a new `_applyComparison` propagation rule run between balance and uniqueness. `binairoHandler` matches both `/binairo/` and `/binairo-plus/`, drops the "not supported" refusal, and threads `comparisonClues` through `detect()` → `solveExtraData` → worker → solver. Canvas preview renders `=`/`≠` glyphs in the cached static layer. `puzzleData.type` stays `'binairo'` for both paths; the differentiation lives in the data.

**Tech Stack:** Vanilla JS (ES2022 in `content.js`/`solver.js`/`handler.js`, ES5-ish in `main-world.js`). Tests use `node:test` + `node:assert/strict`. Version control is **jj (Jujutsu)** — never plain `git` per `CLAUDE.md`.

**Spec:** `docs/superpowers/specs/2026-05-19-binairo-plus-design.md`

**Convention reminders:**
- After editing any file referenced by `manifest.json`, run `npm run build` so Chrome's `dist/` reflects changes.
- Commit with `jj commit -m "..."`. Never `git commit`.
- Encoding: page-native `cellStatus` is `0=empty, 1=one, 2=zero`; givens are `-1=blank, 0=given-zero, 1=given-one`. Comparison flags: `1=R-EQ, 2=R-NE, 4=D-EQ, 8=D-NE` (OR-able).
- Functions in `main-world.js` are serialized via `fn.toString()` — no outer-scope references. (Not relevant for this plan; no main-world changes.)

---

## File overview

| Status | File | Purpose |
| --- | --- | --- |
| Modify | `solver.js` | `BinairoSolver` ctor + `_decodeComparison` + `_applyComparison` + `_cacheKey` mix-in + static `compConstraintsFromFlags`. |
| Modify | `solver.worker.js` | `case 'binairo'` passes `comparisonClues` through. |
| Modify | `handler.js` | `binairoHandler.matches()` covers both paths; `detect()` drops refusal, returns `comparisonClues`. |
| Modify | `content.js` | `solveExtraData` + `binairoCacheKey` + `SUPPORTED_PUZZLES` + `drawPreview` staticLayer + `staticSig`. |
| Modify | `tests/fixtures/puzzles.js` | New `binairoPlus6x6` fixture. |
| Modify | `tests/capture.js` | `solveBinairo` passes `comparisonClues`. |
| Modify | `tests/golden.js` | Regenerated. |
| Modify | `tests/solver.test.js` | Comparison-rule tests + golden test. |
| Modify | `tests/binairo-fuzz.test.js` | `verifyBinairoRules` takes optional `comparisonClues`; constructive fuzz block. |
| Modify | `tests/fixtures/real-puzzles.js` | New `binairoPlusReal6x6_a`. |
| Modify | `CLAUDE.md` | Binairo Plus + comparison-clue documentation. |

---

## Task 1: `_decodeComparison` helper + constructor parameter

**Files:**
- Modify: `/home/quando/documents/chrome-puzzle-solver/solver.js` — `BinairoSolver` ctor + new private method + static helper.
- Modify: `/home/quando/documents/chrome-puzzle-solver/tests/solver.test.js` — append two tests.

The decoder turns the page's sparse 2D into a flat list of constraints. Each non-null entry `flag` at `(r, c)` may set up to 4 bits:

| Bit | Constant | Constraint |
| --- | --- | --- |
| `1` | `FLAG_RIGHT_EQ` | `(r,c) == (r,c+1)` |
| `2` | `FLAG_RIGHT_NE` | `(r,c) != (r,c+1)` |
| `4` | `FLAG_DOWN_EQ`  | `(r,c) == (r+1,c)` |
| `8` | `FLAG_DOWN_NE`  | `(r,c) != (r+1,c)` |

Out-of-grid constraints (e.g. `R-EQ` on the last column) are silently dropped.

- [ ] **Step 1: Add the failing tests** to `tests/solver.test.js` (append at end, after the last `test(...)`):

```js
test('BinairoSolver: _decodeComparison expands flags into pairwise constraints', () => {
  const s = new BinairoSolver({
    rows: 6, cols: 6,
    givens: Array.from({ length: 6 }, () => new Array(6).fill(-1)),
    comparisonClues: [
      [4],                       // (0,0): D-EQ → ((0,0), (1,0), same)
      [null, null, null, 2],     // (1,3): R-NE → ((1,3), (1,4), diff)
      [null, null, 10, 4],       // (2,2): 10=8|2 → R-NE + D-NE
                                 // (2,3): 4=D-EQ → ((2,3), (3,3), same)
    ],
  });
  // Sort for stable comparison.
  const got = s.compConstraints.slice().sort((a, b) =>
    (a.aR - b.aR) || (a.aC - b.aC) || (a.bR - b.bR) || (a.bC - b.bC) ||
    (Number(a.sameSign) - Number(b.sameSign)));
  const expected = [
    { aR: 0, aC: 0, bR: 1, bC: 0, sameSign: true  },  // D-EQ at (0,0)
    { aR: 1, aC: 3, bR: 1, bC: 4, sameSign: false },  // R-NE at (1,3)
    { aR: 2, aC: 2, bR: 2, bC: 3, sameSign: false },  // R-NE at (2,2)
    { aR: 2, aC: 2, bR: 3, bC: 2, sameSign: false },  // D-NE at (2,2)
    { aR: 2, aC: 3, bR: 3, bC: 3, sameSign: true  },  // D-EQ at (2,3)
  ].sort((a, b) =>
    (a.aR - b.aR) || (a.aC - b.aC) || (a.bR - b.bR) || (a.bC - b.bC) ||
    (Number(a.sameSign) - Number(b.sameSign)));
  assert.deepEqual(got, expected);
});

test('BinairoSolver: _decodeComparison drops out-of-grid constraints', () => {
  const s = new BinairoSolver({
    rows: 4, cols: 4,
    givens: Array.from({ length: 4 }, () => new Array(4).fill(-1)),
    comparisonClues: [
      [null, null, null, 1],  // R-EQ on last column → drop
      [null, null, null, 4],  // D-EQ on last column but valid downward → keep
      [null, null, null, null],
      [4, null, null, null],  // D-EQ on last row → drop
    ],
  });
  // Only the (1,3) D-EQ survives.
  assert.equal(s.compConstraints.length, 1);
  assert.deepEqual(s.compConstraints[0],
    { aR: 1, aC: 3, bR: 2, bC: 3, sameSign: true });
});
```

- [ ] **Step 2: Run, confirm both tests fail**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm test -- --test-name-pattern='_decodeComparison'`

Expected: 2 failures — either `compConstraints` is undefined or `TypeError: Cannot read properties of undefined`.

- [ ] **Step 3: Add the constructor parameter + decoder to `BinairoSolver` in `solver.js`.**

Find the existing constructor signature (search for `constructor({ rows, cols, givens, initialState })`):

```js
  constructor({ rows, cols, givens, initialState }) {
```

Replace with:

```js
  constructor({ rows, cols, givens, initialState, comparisonClues }) {
```

Find the seed-from-initialState block near the bottom of the ctor:

```js
    // Seed the grid from initialState if provided, else from givens.
    const init = initialState || this._initialFromGivens(givens);
```

Insert immediately BEFORE that block:

```js
    // Comparison-clue normalization: page-native sparse 2D of flag integers
    // collapses to a flat list of canonical pairwise constraints. Empty/
    // undefined `comparisonClues` produces an empty list (standard Binairo).
    this.compConstraints = this._decodeComparison(comparisonClues);

```

Add the decoder method. Insert immediately AFTER `_initialFromGivens(givens) { ... }`:

```js
  _decodeComparison(comparisonClues) {
    const out = [];
    if (!Array.isArray(comparisonClues)) return out;
    const R = this.rows, C = this.cols;
    for (let r = 0; r < comparisonClues.length && r < R; r++) {
      const row = comparisonClues[r];
      if (!Array.isArray(row)) continue;
      for (let c = 0; c < row.length && c < C; c++) {
        const flag = row[c];
        if (typeof flag !== 'number' || flag === 0) continue;
        if ((flag & 1) && c + 1 < C) out.push({ aR: r, aC: c, bR: r, bC: c + 1, sameSign: true });
        if ((flag & 2) && c + 1 < C) out.push({ aR: r, aC: c, bR: r, bC: c + 1, sameSign: false });
        if ((flag & 4) && r + 1 < R) out.push({ aR: r, aC: c, bR: r + 1, bC: c, sameSign: true });
        if ((flag & 8) && r + 1 < R) out.push({ aR: r, aC: c, bR: r + 1, bC: c, sameSign: false });
      }
    }
    return out;
  }

  // Public static so tests can construct compConstraints without an instance.
  static compConstraintsFromFlags(rows, cols, comparisonClues) {
    const stub = Object.create(BinairoSolver.prototype);
    stub.rows = rows;
    stub.cols = cols;
    return stub._decodeComparison(comparisonClues);
  }
```

- [ ] **Step 4: Run, confirm tests pass**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm test -- --test-name-pattern='_decodeComparison'`

Expected: 2 passes. No regressions in the rest of the suite — verify with `npm test 2>&1 | tail -3`.

- [ ] **Step 5: Lint + typecheck**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm run lint && npm run typecheck`

Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
cd /home/quando/documents/chrome-puzzle-solver && jj commit -m "feat(binairo): _decodeComparison + comparisonClues ctor parameter"
```

---

## Task 2: `_applyComparison` rule — EQ direction

**Files:**
- Modify: `solver.js` — add rule method, wire it into `propagate()`.
- Modify: `tests/solver.test.js` — append one test.

EQ constraint: cells must hold the same value. When exactly one of the pair is known, force the other.

- [ ] **Step 1: Add the failing test** to `tests/solver.test.js`:

```js
test('BinairoSolver: _applyComparison EQ forces same value', () => {
  // 4x4 board: only constraint is (0,0) D-EQ (0,0)≡(1,0). Place 1 at (0,0)
  // via givens; propagation should force (1,0) to 1 also.
  const givens = Array.from({ length: 4 }, () => new Array(4).fill(-1));
  givens[0][0] = 1;
  const s = new BinairoSolver({
    rows: 4, cols: 4, givens,
    comparisonClues: [[4]], // D-EQ at (0,0)
  });
  let changed = false;
  const ok = s._applyComparison(() => { changed = true; });
  assert.equal(ok, true);
  assert.equal(changed, true);
  assert.equal(s._get(1, 0), 1, 'cell (1,0) must be forced to match (0,0)=1');
});
```

- [ ] **Step 2: Run, confirm it fails**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm test -- --test-name-pattern='_applyComparison EQ'`

Expected: `TypeError: s._applyComparison is not a function`.

- [ ] **Step 3: Add the rule method** to `BinairoSolver`. Insert immediately AFTER `_applyBalance` (search for the end of `_applyBalance` — the closing `}` of the method):

```js
  // Comparison-clue propagation. For each pairwise constraint:
  // - if both sides are known, verify consistency (else contradiction);
  // - if exactly one side is known, force the other so the constraint holds.
  // Validates no-triples on each forced assignment so the post-validation
  // gap in _backtrack stays closed.
  _applyComparison(onChange) {
    for (const k of this.compConstraints) {
      const a = this._get(k.aR, k.aC);
      const b = this._get(k.bR, k.bC);
      if (a !== 0 && b !== 0) {
        const equal = a === b;
        if (equal !== k.sameSign) return false;
        continue;
      }
      if (a === 0 && b === 0) continue;
      const known = a !== 0 ? a : b;
      const target = k.sameSign ? known : (known === 1 ? 2 : 1);
      const r = a !== 0 ? k.bR : k.aR;
      const c = a !== 0 ? k.bC : k.aC;
      if (this._wouldCreateTriple(r, c, target)) return false;
      if (this._assign(r, c, target)) onChange();
    }
    return true;
  }
```

- [ ] **Step 4: Wire it into `propagate()`**. Find the existing rule chain (search for `_applyBalance` callsite in `propagate`):

```js
      if (!this._applyNoTriples(() => { changed = true; })) return false;
      if (!this._applyBalance(() => { changed = true; }))   return false;
      if (!this._applyUniqueness(() => { changed = true; })) return false;
      if (!this._applySingleRemaining(() => { changed = true; })) return false;
```

Insert `_applyComparison` between balance and uniqueness:

```js
      if (!this._applyNoTriples(() => { changed = true; })) return false;
      if (!this._applyBalance(() => { changed = true; }))   return false;
      if (!this._applyComparison(() => { changed = true; })) return false;
      if (!this._applyUniqueness(() => { changed = true; })) return false;
      if (!this._applySingleRemaining(() => { changed = true; })) return false;
```

- [ ] **Step 5: Run, confirm it passes + suite stays green**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm test 2>&1 | tail -5`

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
cd /home/quando/documents/chrome-puzzle-solver && jj commit -m "feat(binairo): _applyComparison propagates EQ constraints"
```

---

## Task 3: `_applyComparison` — NE direction + contradiction detection

The same method already handles NE (the `sameSign: false` branch picks the opposite value). The contradiction case (both sides known and inconsistent) is also already coded. We only need tests.

**Files:**
- Modify: `tests/solver.test.js` — append two tests.

- [ ] **Step 1: Append both tests**

```js
test('BinairoSolver: _applyComparison NE forces opposite value', () => {
  // R-NE between (0,0) and (0,1): flag = 2 at (0,0).
  const givens = Array.from({ length: 4 }, () => new Array(4).fill(-1));
  givens[0][0] = 1;
  const s = new BinairoSolver({
    rows: 4, cols: 4, givens,
    comparisonClues: [[2]],
  });
  let changed = false;
  const ok = s._applyComparison(() => { changed = true; });
  assert.equal(ok, true);
  assert.equal(changed, true);
  assert.equal(s._get(0, 1), 2, 'cell (0,1) must be forced opposite to (0,0)=1');
});

test('BinairoSolver: _applyComparison flags inconsistent prefill as contradiction', () => {
  // R-EQ between (0,0) and (0,1), but givens contradict it.
  const givens = Array.from({ length: 4 }, () => new Array(4).fill(-1));
  givens[0][0] = 1;
  givens[0][1] = 0;
  const s = new BinairoSolver({
    rows: 4, cols: 4, givens,
    comparisonClues: [[1]],
  });
  const ok = s._applyComparison(() => {});
  assert.equal(ok, false, 'should report contradiction when EQ holds 1 vs 0');
});
```

- [ ] **Step 2: Run, confirm both pass** (rule already does this)

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm test -- --test-name-pattern='_applyComparison'`

Expected: 3 passes (the EQ test from Task 2 + 2 new).

- [ ] **Step 3: Commit**

```bash
cd /home/quando/documents/chrome-puzzle-solver && jj commit -m "test(binairo): _applyComparison NE forcing + contradiction"
```

---

## Task 4: `_cacheKey` mixes comparison clues

Two puzzles with identical givens but different comparison clues must NOT share the same solution cache slot. Mix the clue bytes into FNV after the givens.

**Files:**
- Modify: `solver.js` — extend `_cacheKey`.
- Modify: `tests/solver.test.js` — append one test.

- [ ] **Step 1: Add the failing test**

```js
test('BinairoSolver: _cacheKey differs when comparisonClues differ', () => {
  const givens = Array.from({ length: 4 }, () => new Array(4).fill(-1));
  const a = new BinairoSolver({ rows: 4, cols: 4, givens, comparisonClues: [] });
  const b = new BinairoSolver({ rows: 4, cols: 4, givens, comparisonClues: [[1]] });
  const c = new BinairoSolver({ rows: 4, cols: 4, givens, comparisonClues: [[2]] });
  assert.notEqual(a._cacheKey(), b._cacheKey(), 'empty vs R-EQ must differ');
  assert.notEqual(b._cacheKey(), c._cacheKey(), 'R-EQ vs R-NE must differ');
});
```

- [ ] **Step 2: Run, confirm it fails**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm test -- --test-name-pattern='_cacheKey differs'`

Expected: assertion failure — current `_cacheKey` ignores `compConstraints`, so all three keys are identical.

- [ ] **Step 3: Extend `_cacheKey`** in `solver.js`. Find the existing method (search for `_cacheKey()`):

```js
  _cacheKey() {
    let h = 0x811c9dc5;
    const mix = (n) => { h ^= n; h = Math.imul(h, 0x01000193) >>> 0; };
    mix(this.rows);
    mix(this.cols);
    for (let r = 0; r < this.rows; r++) {
      const row = this.givens[r] || [];
      for (let c = 0; c < this.cols; c++) mix((row[c] | 0) + 2);
    }
    return String(h >>> 0);
  }
```

Replace with:

```js
  _cacheKey() {
    let h = 0x811c9dc5;
    const mix = (n) => { h ^= n; h = Math.imul(h, 0x01000193) >>> 0; };
    mix(this.rows);
    mix(this.cols);
    for (let r = 0; r < this.rows; r++) {
      const row = this.givens[r] || [];
      for (let c = 0; c < this.cols; c++) mix((row[c] | 0) + 2);
    }
    // Mix comparison constraints. Stable ordering is _decodeComparison's
    // emission order: outer row then col, with bit order (R-EQ, R-NE,
    // D-EQ, D-NE). Length sentinel up front so an empty list still mixes.
    mix(this.compConstraints.length);
    for (const k of this.compConstraints) {
      mix(k.aR); mix(k.aC); mix(k.bR); mix(k.bC);
      mix(k.sameSign ? 1 : 0);
    }
    return String(h >>> 0);
  }
```

- [ ] **Step 4: Run, confirm test passes + suite green**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm test 2>&1 | tail -5`

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd /home/quando/documents/chrome-puzzle-solver && jj commit -m "feat(binairo): _cacheKey mixes comparison-clue bytes"
```

---

## Task 5: Worker dispatch threads `comparisonClues`

**Files:**
- Modify: `solver.worker.js`

- [ ] **Step 1: Edit** `/home/quando/documents/chrome-puzzle-solver/solver.worker.js`. Find the existing binairo arm:

```js
    } else if (type === 'binairo' && extraData) {
      const s = new BinairoSolver({
        rows: extraData.rows,
        cols: extraData.cols,
        givens: extraData.givens,
        initialState: initialGrid || null,
      });
      result = s.solve();
    } else {
```

Replace with:

```js
    } else if (type === 'binairo' && extraData) {
      const s = new BinairoSolver({
        rows: extraData.rows,
        cols: extraData.cols,
        givens: extraData.givens,
        comparisonClues: extraData.comparisonClues || [],
        initialState: initialGrid || null,
      });
      result = s.solve();
    } else {
```

- [ ] **Step 2: Smoke test parses**

Run: `cd /home/quando/documents/chrome-puzzle-solver && node -e "require('./solver.js'); require('./solver.worker.js')" 2>&1 | head -3`

Expected: a `ReferenceError: importScripts is not defined` (normal under Node — the file uses MV3-only globals). Any `SyntaxError` would mean a typo.

- [ ] **Step 3: Lint + typecheck + tests**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm run lint && npm run typecheck && npm test 2>&1 | tail -3`

Expected: all clean.

- [ ] **Step 4: Commit**

```bash
cd /home/quando/documents/chrome-puzzle-solver && jj commit -m "feat(binairo): worker dispatch threads comparisonClues to BinairoSolver"
```

---

## Task 6: `binairoHandler` matches both paths + drops refusal

**Files:**
- Modify: `handler.js` — extend `matches()`, drop comparison-clue refusal, return `comparisonClues`.

- [ ] **Step 1: Edit `matches()`** (search for `name: 'puzzles-mobile-binairo'`):

```js
  matches() {
    return isPuzzlesMobilePage() &&
           window.location.pathname.includes('/binairo/');
  },
```

Replace with:

```js
  matches() {
    return isPuzzlesMobilePage() && (
      window.location.pathname.includes('/binairo/') ||
      window.location.pathname.includes('/binairo-plus/')
    );
  },
```

- [ ] **Step 2: Edit `detect()`** in the same handler. Find the refusal block:

```js
    const data = await callMainWorld('readBinairoData', []);
    if (!data) return { ...result, error: 'No Binairo task data found' };
    // Page pre-allocates comparisonClues as one empty array per row even on
    // the standard variant. Treat as active only if some row has markers.
    const hasComparisonClues = Array.isArray(data.comparisonClues) &&
      data.comparisonClues.some(row => Array.isArray(row) && row.length > 0);
    if (hasComparisonClues) {
      return { ...result, error: 'Binairo comparison-clue variant not yet supported' };
    }
```

Replace with (only the refusal is removed — keep the data fetch):

```js
    const data = await callMainWorld('readBinairoData', []);
    if (!data) return { ...result, error: 'No Binairo task data found' };
```

- [ ] **Step 3: Edit the return shape** in the same `detect()`. Find:

```js
    return {
      found: true,
      type: 'binairo',
      rows: data.height,
      cols: data.width,
      givens: data.task,
      rowClues: [],
      colClues: [],
      _cells: [],
      _element: stageEl,
    };
```

Replace with (one extra field):

```js
    return {
      found: true,
      type: 'binairo',
      rows: data.height,
      cols: data.width,
      givens: data.task,
      comparisonClues: data.comparisonClues || [],
      rowClues: [],
      colClues: [],
      _cells: [],
      _element: stageEl,
    };
```

- [ ] **Step 4: Lint + typecheck + tests**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm run lint && npm run typecheck && npm test 2>&1 | tail -3`

Expected: all clean.

- [ ] **Step 5: Commit**

```bash
cd /home/quando/documents/chrome-puzzle-solver && jj commit -m "feat(binairo-plus): handler matches both paths, threads comparisonClues"
```

---

## Task 7: `content.js` — `solveExtraData` + `binairoCacheKey` + supported puzzles

**Files:**
- Modify: `content.js` — three localized edits.

- [ ] **Step 1: `solveExtraData`.** Find the binairo branch at content.js:908:

```js
  if (data.type === 'binairo') {
    return {
      rows: data.rows,
      cols: data.cols,
      givens: data.givens,
    };
  }
```

Replace with:

```js
  if (data.type === 'binairo') {
    return {
      rows: data.rows,
      cols: data.cols,
      givens: data.givens,
      comparisonClues: data.comparisonClues || [],
    };
  }
```

- [ ] **Step 2: `binairoCacheKey`.** Find the existing function at content.js:1057:

```js
function binairoCacheKey(data) {
  if (data?.type !== 'binairo') return null;
  // FNV-1a over (type, rows, cols, flattened givens).
  let h = 0x811c9dc5;
  const mix = (n) => { h ^= n; h = Math.imul(h, 0x01000193) >>> 0; };
  mix(0x42); // 'B' nameplate so binairo keys can't collide with nonogram keys
  mix(data.rows | 0);
  mix(data.cols | 0);
  const g = data.givens || [];
  for (let r = 0; r < data.rows; r++) {
    const row = g[r] || [];
    for (let c = 0; c < data.cols; c++) mix((row[c] | 0) + 2);
  }
  return 'binairo-solution:' + (h >>> 0).toString(16);
}
```

Replace with (extra block mixing comparisonClues):

```js
function binairoCacheKey(data) {
  if (data?.type !== 'binairo') return null;
  // FNV-1a over (type, rows, cols, flattened givens, comparison clues).
  let h = 0x811c9dc5;
  const mix = (n) => { h ^= n; h = Math.imul(h, 0x01000193) >>> 0; };
  mix(0x42); // 'B' nameplate so binairo keys can't collide with nonogram keys
  mix(data.rows | 0);
  mix(data.cols | 0);
  const g = data.givens || [];
  for (let r = 0; r < data.rows; r++) {
    const row = g[r] || [];
    for (let c = 0; c < data.cols; c++) mix((row[c] | 0) + 2);
  }
  // Mix comparison clues so binairo and binairo-plus boards with identical
  // givens hash to distinct keys. Sparse 2D — outer row index, inner col
  // index, value or 0 for missing. Length sentinels up front keep zero-
  // comparison and 1-comparison-of-flag-0 cases distinguishable.
  const cc = Array.isArray(data.comparisonClues) ? data.comparisonClues : [];
  mix(cc.length);
  for (let r = 0; r < cc.length; r++) {
    const row = Array.isArray(cc[r]) ? cc[r] : [];
    mix(row.length);
    for (let c = 0; c < row.length; c++) mix((row[c] | 0) + 1);
  }
  return 'binairo-solution:' + (h >>> 0).toString(16);
}
```

- [ ] **Step 3: Supported puzzles.** Find `SUPPORTED_PUZZLES` at content.js:1414:

```js
const SUPPORTED_PUZZLES = [
  { name: 'Nonogram', url: 'https://www.puzzles-mobile.com/nonograms/' },
  { name: 'Aquarium', url: 'https://www.puzzles-mobile.com/aquarium/' },
  { name: 'Galaxies', url: 'https://www.puzzles-mobile.com/galaxies/' },
  { name: 'Binairo',  url: 'https://www.puzzles-mobile.com/binairo/' },
];
```

Replace with:

```js
const SUPPORTED_PUZZLES = [
  { name: 'Nonogram',     url: 'https://www.puzzles-mobile.com/nonograms/' },
  { name: 'Aquarium',     url: 'https://www.puzzles-mobile.com/aquarium/' },
  { name: 'Galaxies',     url: 'https://www.puzzles-mobile.com/galaxies/' },
  { name: 'Binairo',      url: 'https://www.puzzles-mobile.com/binairo/' },
  { name: 'Binairo Plus', url: 'https://www.puzzles-mobile.com/binairo-plus/' },
];
```

- [ ] **Step 4: Lint + typecheck + tests**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm run lint && npm run typecheck && npm test 2>&1 | tail -3`

Expected: all clean.

- [ ] **Step 5: Commit**

```bash
cd /home/quando/documents/chrome-puzzle-solver && jj commit -m "feat(binairo-plus): solveExtraData, cache key, supported puzzles list"
```

---

## Task 8: Canvas preview — `=` / `≠` glyphs in staticLayer

The static layer is rebuilt only when puzzle shape changes (`staticSig`). Adding `comparisonClues` to `staticSig` and a render call inside `buildStaticLayer` gets us cached, zero-per-tick glyphs.

**Files:**
- Modify: `content.js` — `staticSig` includes a clue hash; `buildStaticLayer` calls a new `drawComparisonCluesOn`.

- [ ] **Step 1: Add a sig helper.** Find the `staticSig` line at content.js:1951:

```js
    const staticSig = rows + 'x' + cols + '@' + cellSize + '|t=' + (pd?.type || '') +
                      '|rm=' + regionMapSig(pd?.regionMap) +
                      '|st=' + (pd?.stars ? pd.stars.map(s => s.row + ',' + s.col).join(';') : '');
```

Replace with (add `|cc=` segment):

```js
    const staticSig = rows + 'x' + cols + '@' + cellSize + '|t=' + (pd?.type || '') +
                      '|rm=' + regionMapSig(pd?.regionMap) +
                      '|st=' + (pd?.stars ? pd.stars.map(s => s.row + ',' + s.col).join(';') : '') +
                      '|cc=' + comparisonCluesSig(pd?.comparisonClues);
```

- [ ] **Step 2: Add `comparisonCluesSig` near the other sig helpers.** Find `regionMapSig` (search for `function regionMapSig`):

```bash
grep -n "function regionMapSig\|function gridDataSig" /home/quando/documents/chrome-puzzle-solver/content.js
```

Insert immediately after `function regionMapSig(...)` (whichever block defines it):

```js
  // Sparse comparison-clue stable signature. FNV-like rolling number so a
  // change anywhere in the sparse 2D invalidates the static-layer cache.
  function comparisonCluesSig(cc) {
    if (!Array.isArray(cc) || cc.length === 0) return '0';
    let h = 0x811c9dc5;
    for (let r = 0; r < cc.length; r++) {
      const row = Array.isArray(cc[r]) ? cc[r] : [];
      for (let c = 0; c < row.length; c++) {
        h ^= r * 65537 + c * 31 + ((row[c] | 0) + 1);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
    }
    return (h >>> 0).toString(36);
  }
```

- [ ] **Step 3: Render the glyphs.** Find `buildStaticLayer` at content.js:1826:

```js
  function buildStaticLayer(rows, cols, cellSize, w, h, pd) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    drawRegionBordersOn(ctx, rows, cols, cellSize, pd?.regionMap);
    drawNonogramGuidesOn(ctx, rows, cols, cellSize, w, h, pd);
    if (pd?.type === 'galaxies' && pd.stars) {
      ctx.fillStyle = '#111827';
      for (const star of pd.stars) {
        const cx = ((star.col + 1) / 2) * cellSize;
        const cy = ((star.row + 1) / 2) * cellSize;
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(3, cellSize / 7), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    return c;
  }
```

Replace with (add comparison-clue render call):

```js
  function buildStaticLayer(rows, cols, cellSize, w, h, pd) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    drawRegionBordersOn(ctx, rows, cols, cellSize, pd?.regionMap);
    drawNonogramGuidesOn(ctx, rows, cols, cellSize, w, h, pd);
    if (pd?.type === 'galaxies' && pd.stars) {
      ctx.fillStyle = '#111827';
      for (const star of pd.stars) {
        const cx = ((star.col + 1) / 2) * cellSize;
        const cy = ((star.row + 1) / 2) * cellSize;
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(3, cellSize / 7), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (pd?.type === 'binairo' && Array.isArray(pd.comparisonClues)) {
      drawComparisonCluesOn(ctx, cellSize, pd.comparisonClues);
    }
    return c;
  }

  function drawComparisonCluesOn(ctx, cellSize, comparisonClues) {
    const fontSize = Math.max(8, Math.floor(cellSize * 0.45));
    ctx.save();
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#fff';
    ctx.fillStyle = '#1f2937';
    for (let r = 0; r < comparisonClues.length; r++) {
      const row = comparisonClues[r];
      if (!Array.isArray(row)) continue;
      for (let c = 0; c < row.length; c++) {
        const flag = row[c];
        if (typeof flag !== 'number' || flag === 0) continue;
        // Right edge (between (r,c) and (r,c+1))
        if (flag & 3) {
          const x = (c + 1) * cellSize;
          const y = r * cellSize + cellSize / 2;
          const ch = (flag & 1) ? '=' : '≠';
          ctx.strokeText(ch, x, y);
          ctx.fillText(ch, x, y);
        }
        // Bottom edge (between (r,c) and (r+1,c))
        if (flag & 12) {
          const x = c * cellSize + cellSize / 2;
          const y = (r + 1) * cellSize;
          const ch = (flag & 4) ? '=' : '≠';
          ctx.strokeText(ch, x, y);
          ctx.fillText(ch, x, y);
        }
      }
    }
    ctx.restore();
  }
```

- [ ] **Step 4: Build + lint + typecheck + tests**

```bash
cd /home/quando/documents/chrome-puzzle-solver && npm run lint && npm run typecheck && npm test 2>&1 | tail -3 && npm run build
```

Expected: all clean. `dist/` repopulated.

- [ ] **Step 5: Commit**

```bash
cd /home/quando/documents/chrome-puzzle-solver && jj commit -m "feat(binairo-plus): render =/≠ glyphs in preview staticLayer"
```

---

## Task 9: Deterministic fixture + golden + solver test

**Files:**
- Modify: `tests/fixtures/puzzles.js`
- Modify: `tests/capture.js`
- Modify: `tests/golden.js` (auto-regenerated)
- Modify: `tests/solver.test.js`

This task uses the recon's three-row sample. The implementer can later swap this for a complete capture, but the three-row example is enough to lock in `comparisonClues` plumbing.

- [ ] **Step 1: Append fixture** to `tests/fixtures/puzzles.js`. Find the existing `binairo6x6` entry and insert AFTER it:

```js
  // Binairo Plus 6x6 captured from puzzles-mobile.com/binairo-plus/random/
  // 6x6-easy on 2026-05-19. Flag encoding per the page engine:
  //   1=R-EQ, 2=R-NE, 4=D-EQ, 8=D-NE (OR-able).
  // Recon dump showed only the first 3 rows of comparisonClues; the
  // remaining rows are empty arrays which decode to zero constraints.
  // The captured task data is the full 6x6 givens.
  binairoPlus6x6: {
    rows: 6,
    cols: 6,
    givens: [
      [-1, -1, -1, -1,  1,  1],
      [-1,  1, -1, -1, -1, -1],
      [-1,  0, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1, -1],
    ],
    comparisonClues: [
      [4],
      [null, null, null, 2],
      [null, null, 10, 4],
      [],
      [],
      [],
    ],
  },
```

- [ ] **Step 2: Edit `tests/capture.js`** to pass `comparisonClues` to `solveBinairo`. Find:

```js
function solveBinairo(p) {
  BinairoSolver.clearSolutionCache();
  return new BinairoSolver({ rows: p.rows, cols: p.cols, givens: p.givens }).solve();
}
```

Replace with:

```js
function solveBinairo(p) {
  BinairoSolver.clearSolutionCache();
  return new BinairoSolver({
    rows: p.rows, cols: p.cols, givens: p.givens,
    comparisonClues: p.comparisonClues || [],
  }).solve();
}
```

Add `binairoPlus6x6` to the `raw` map. Find:

```js
const raw = {
  nonogramDiagonal5: solveNonogram(fixtures.nonogramDiagonal5),
  nonogramCorners3:  solveNonogram(fixtures.nonogramCorners3),
  aquariumTiny:      solveAquarium(fixtures.aquariumTiny),
  aquariumLarge:     solveAquarium(fixtures.aquariumLarge),
  galaxiesTiny:      solveGalaxies(fixtures.galaxiesTiny),
  galaxiesSmall:     solveGalaxies(fixtures.galaxiesSmall),
  binairo6x6:        solveBinairo(fixtures.binairo6x6),
};
```

Replace with (one entry appended):

```js
const raw = {
  nonogramDiagonal5: solveNonogram(fixtures.nonogramDiagonal5),
  nonogramCorners3:  solveNonogram(fixtures.nonogramCorners3),
  aquariumTiny:      solveAquarium(fixtures.aquariumTiny),
  aquariumLarge:     solveAquarium(fixtures.aquariumLarge),
  galaxiesTiny:      solveGalaxies(fixtures.galaxiesTiny),
  galaxiesSmall:     solveGalaxies(fixtures.galaxiesSmall),
  binairo6x6:        solveBinairo(fixtures.binairo6x6),
  binairoPlus6x6:    solveBinairo(fixtures.binairoPlus6x6),
};
```

- [ ] **Step 3: Regenerate goldens**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm run capture`

Expected output: `Wrote tests/golden.js with 8 entries.` and `binairoPlus6x6: solved=true`.

If `solved=false` for the binairoPlus6x6: the fixture's comparisonClues may be inconsistent with its givens, or the rule has a bug. Inspect `node tests/capture.js` output for the `error` field. Do NOT proceed with a `solved=false` golden — debug first.

- [ ] **Step 4: Add solver test** in `tests/solver.test.js` (append):

```js
test('BinairoSolver: binairoPlus6x6 fixture matches golden', () => {
  BinairoSolver.clearSolutionCache();
  const p = fixtures.binairoPlus6x6;
  const result = clean(
    new BinairoSolver({
      rows: p.rows, cols: p.cols, givens: p.givens,
      comparisonClues: p.comparisonClues,
    }).solve()
  );
  assert.deepEqual(result, golden.binairoPlus6x6);
});
```

- [ ] **Step 5: Run, confirm all pass**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm test 2>&1 | tail -3`

Expected: all green.

- [ ] **Step 6: Commit**

```bash
cd /home/quando/documents/chrome-puzzle-solver && jj commit -m "test(binairo-plus): 6x6 fixture + golden snapshot + matching solver test"
```

---

## Task 10: Real-puzzles fixture for bench

`bench-binairo.js` iterates every entry in `tests/fixtures/real-puzzles.js` whose `type === 'binairo'` and now spreads `comparisonClues` into the constructor. Adding a Binairo Plus entry exercises the new code path under bench.

**Files:**
- Modify: `tests/fixtures/real-puzzles.js`
- Modify: `tests/bench-binairo.js` (spread `comparisonClues`)

- [ ] **Step 1: Append real-puzzles entry.** Find the end of `tests/fixtures/real-puzzles.js` (the closing `}` of the module exports):

```js
  binairoRealWeekly30x30_a: {
    type: 'binairo',
    rows: 30,
    cols: 30,
    givens: [
      // ... (existing data) ...
    ],
    comparisonClues: [],
  },
};
```

Replace the trailing `};` (keep the existing 30x30 entry intact) with the new Binairo Plus entry inserted before it:

```js
  binairoRealWeekly30x30_a: {
    // ... unchanged ...
  },

  // Binairo Plus 6x6 captured from puzzles-mobile.com/binairo-plus/random/
  // 6x6-easy on 2026-05-19. Mirrors fixtures.binairoPlus6x6 in shape; this
  // copy lives in real-puzzles.js so bench-binairo.js exercises the
  // comparison-rule code path.
  binairoPlusReal6x6_a: {
    type: 'binairo',
    rows: 6,
    cols: 6,
    givens: [
      [-1, -1, -1, -1,  1,  1],
      [-1,  1, -1, -1, -1, -1],
      [-1,  0, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1, -1],
      [-1, -1, -1, -1, -1, -1],
    ],
    comparisonClues: [
      [4],
      [null, null, null, 2],
      [null, null, 10, 4],
      [],
      [],
      [],
    ],
  },
};
```

- [ ] **Step 2: Edit `bench-binairo.js`.** Find the constructor calls (search for `new BinairoSolver`):

```bash
grep -n "new BinairoSolver" /home/quando/documents/chrome-puzzle-solver/tests/bench-binairo.js
```

Both instantiations look like:

```js
new BinairoSolver({ rows: puzzle.rows, cols: puzzle.cols, givens: puzzle.givens }).solve();
```

Replace each with:

```js
new BinairoSolver({
  rows: puzzle.rows, cols: puzzle.cols, givens: puzzle.givens,
  comparisonClues: puzzle.comparisonClues || [],
}).solve();
```

- [ ] **Step 3: Run the bench**

Run: `cd /home/quando/documents/chrome-puzzle-solver && node tests/bench-binairo.js`

Expected: three lines of output (6x6, plus 6x6, weekly 30x30), each `solved: true`. Plus 6x6 is tiny, sub-1ms.

- [ ] **Step 4: Lint + tests**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm run lint && npm test 2>&1 | tail -3`

Expected: all clean.

- [ ] **Step 5: Commit**

```bash
cd /home/quando/documents/chrome-puzzle-solver && jj commit -m "test(binairo-plus): real-puzzle bench fixture + ctor spread"
```

---

## Task 11: Fuzz extension — comparison-clue constructive trials

Extend `verifyBinairoRules` to also verify comparison constraints. Add a constructive fuzz block that builds a known-solved grid, samples a subset of its borders as comparison clues (consistent by construction), partially obscures cells, and asserts the solver returns a grid satisfying all the rules.

**Files:**
- Modify: `tests/binairo-fuzz.test.js`

- [ ] **Step 1: Edit `verifyBinairoRules`.** Find the function (early in the file). Replace its signature and body:

```js
function verifyBinairoRules(grid, R, C) {
  // ... existing body ...
}
```

with:

```js
function verifyBinairoRules(grid, R, C, comparisonClues) {
  for (let r = 0; r < R; r++) {
    const line = lineFromGrid(grid, 'row', r, C);
    if (violatesTriples(line))            return `row ${r}: three in a row`;
    if (violatesBalance(line, C / 2))     return `row ${r}: unbalanced`;
  }
  for (let c = 0; c < C; c++) {
    const line = lineFromGrid(grid, 'col', c, R);
    if (violatesTriples(line))            return `col ${c}: three in a row`;
    if (violatesBalance(line, R / 2))     return `col ${c}: unbalanced`;
  }
  const rowKeys = new Set();
  for (let r = 0; r < R; r++) {
    const k = lineKey(lineFromGrid(grid, 'row', r, C));
    if (rowKeys.has(k)) return `duplicate row: ${k}`;
    rowKeys.add(k);
  }
  const colKeys = new Set();
  for (let c = 0; c < C; c++) {
    const k = lineKey(lineFromGrid(grid, 'col', c, R));
    if (colKeys.has(k)) return `duplicate col: ${k}`;
    colKeys.add(k);
  }
  if (Array.isArray(comparisonClues)) {
    for (let r = 0; r < comparisonClues.length && r < R; r++) {
      const row = comparisonClues[r];
      if (!Array.isArray(row)) continue;
      for (let c = 0; c < row.length && c < C; c++) {
        const flag = row[c];
        if (typeof flag !== 'number' || flag === 0) continue;
        const v = grid[r][c];
        if (v === 0) continue;
        if ((flag & 1) && c + 1 < C) {
          if (grid[r][c + 1] !== v) return `R-EQ violated at (${r},${c})`;
        }
        if ((flag & 2) && c + 1 < C) {
          if (grid[r][c + 1] === v) return `R-NE violated at (${r},${c})`;
        }
        if ((flag & 4) && r + 1 < R) {
          if (grid[r + 1][c] !== v) return `D-EQ violated at (${r},${c})`;
        }
        if ((flag & 8) && r + 1 < R) {
          if (grid[r + 1][c] === v) return `D-NE violated at (${r},${c})`;
        }
      }
    }
  }
  return null;
}
```

This keeps the existing call sites working (the new parameter defaults to `undefined` → comparison check skipped).

- [ ] **Step 2: Add constructive fuzz block.** Append at the end of `tests/binairo-fuzz.test.js`:

```js
function constructiveSolvedGrid(rand, R, C) {
  // Use the solver itself to produce a known-solved grid from random givens
  // we know are solvable: empty givens + repeated solves until one succeeds.
  // Empty givens admit many solutions; backtracking returns one
  // deterministically.
  BinairoSolver.clearSolutionCache();
  const givens = Array.from({ length: R }, () => new Array(C).fill(-1));
  // Stir randomness in by pre-placing a couple of random hints.
  for (let i = 0; i < 2; i++) {
    const r = Math.floor(rand() * R);
    const c = Math.floor(rand() * C);
    givens[r][c] = rand() < 0.5 ? 0 : 1;
  }
  const r = new BinairoSolver({ rows: R, cols: C, givens }).solve();
  if (!r.solved) return null;
  return { grid: r.grid, givens };
}

function sampleComparisonClues(rand, grid, R, C, density) {
  // For each interior border, with probability `density`, attach a flag
  // (EQ if the two sides are equal in the solved grid, NE otherwise).
  const cc = Array.from({ length: R }, () => []);
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      let flag = 0;
      if (c + 1 < C && rand() < density) {
        flag |= (grid[r][c] === grid[r][c + 1]) ? 1 : 2;
      }
      if (r + 1 < R && rand() < density) {
        flag |= (grid[r][c] === grid[r + 1][c]) ? 4 : 8;
      }
      if (flag !== 0) cc[r][c] = flag;
      else if (cc[r].length <= c) cc[r].length = c + 1;
    }
    // Trim trailing undefined.
    while (cc[r].length > 0 && (cc[r][cc[r].length - 1] === undefined ||
                                 cc[r][cc[r].length - 1] === 0)) {
      cc[r].pop();
    }
  }
  return cc;
}

function runComparisonTrial(seed, R, C) {
  const rand = rng(seed);
  const built = constructiveSolvedGrid(rand, R, C);
  if (!built) return; // skip — couldn't build a base solution
  const comparisonClues = sampleComparisonClues(rand, built.grid, R, C, 0.2);
  // Knock out a random subset of givens to make the puzzle non-trivial.
  const givens = built.givens.map(row => row.slice());
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      if (givens[r][c] !== -1 && rand() < 0.5) givens[r][c] = -1;
    }
  }
  BinairoSolver.clearSolutionCache();
  const result = new BinairoSolver({ rows: R, cols: C, givens, comparisonClues }).solve();
  if (!result.solved) return;
  const violation = verifyBinairoRules(result.grid, R, C, comparisonClues);
  assert.equal(violation, null,
    `seed=${seed} R=${R} C=${C}: solver returned solved=true but violates ${violation}. ` +
    `givens=${JSON.stringify(givens)} cc=${JSON.stringify(comparisonClues)} grid=${JSON.stringify(result.grid)}`);
}

test('BinairoSolver: comparison-clue constructive fuzz 4x4 (30 trials)', () => {
  for (let seed = 500; seed <= 529; seed++) runComparisonTrial(seed, 4, 4);
});

test('BinairoSolver: comparison-clue constructive fuzz 6x6 (30 trials)', () => {
  for (let seed = 600; seed <= 629; seed++) runComparisonTrial(seed, 6, 6);
});
```

- [ ] **Step 3: Run**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm test -- --test-name-pattern='comparison-clue constructive fuzz'`

Expected: 2 passes (each runs 30 internal trials).

- [ ] **Step 4: Lint + full suite**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm run lint && npm test 2>&1 | tail -3`

Expected: all clean.

- [ ] **Step 5: Commit**

```bash
cd /home/quando/documents/chrome-puzzle-solver && jj commit -m "test(binairo-plus): rule-validity fuzz now covers comparison clues"
```

---

## Task 12: CLAUDE.md update

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the top description.** Find the very first paragraph:

```markdown
A Chrome MV3 extension that solves Nonogram, Aquarium, Galaxies, and Binairo
puzzles on puzzles-mobile.com. Four solver classes in `solver.js`, a
content-script widget in `content.js`, and a small service worker in
`background.js`.
```

Replace with (one extra clause about Binairo Plus):

```markdown
A Chrome MV3 extension that solves Nonogram, Aquarium, Galaxies, Binairo,
and Binairo Plus puzzles on puzzles-mobile.com. Four solver classes in
`solver.js` (Binairo Plus reuses `BinairoSolver` with the comparison-clue
rule enabled), a content-script widget in `content.js`, and a small
service worker in `background.js`.
```

- [ ] **Step 2: Add a subsection** under "Architectural notes". Find the existing `### Binairo encoding gotcha` subsection. Insert IMMEDIATELY AFTER it (before the next `###`):

```markdown
### Binairo Plus / comparison-clue support

The `/binairo-plus/*` path is served by the same `binairoHandler` and
`BinairoSolver` as standard Binairo, with one extra rule and one extra
constructor field.

Page exposes comparison clues at `window.Game.comparisonClues` as a sparse
2D of flag integers. Each non-null entry `flag` at `(r, c)` decodes via
bit positions exported on `Game` as `FLAG_RIGHT_EQ=1`, `FLAG_RIGHT_NE=2`,
`FLAG_DOWN_EQ=4`, `FLAG_DOWN_NE=8` (OR-able). A flag of `10` (= `8|2`)
encodes "down ≠ AND right ≠" on that cell.

`BinairoSolver._decodeComparison(comparisonClues)` flattens the sparse
2D into a canonical array of `{ aR, aC, bR, bC, sameSign }` constraints
stored as `this.compConstraints`. Out-of-grid borders are silently
dropped during decode.

`_applyComparison(onChange)` runs in `propagate()` between balance and
uniqueness. For each constraint:
- both sides known + inconsistent → contradiction (`return false`);
- exactly one side known → force the other (with `_wouldCreateTriple`
  pre-check so the assign-time triple invariant from the rest of the
  solver still holds);
- neither side known → skip.

Because `_applyComparison` validates both-sides-known pairs every pass, a
successful `propagate()` guarantees no comparison violations — no
separate `_hasComparisonViolation` check is needed at completion
(unlike `_hasDuplicateLines`, which IS still needed because uniqueness
has a real gap on lines with > 2 empty cells).

`puzzleData.type === 'binairo'` for both paths — the discriminator lives
in `puzzleData.comparisonClues` (empty array for standard binairo,
populated sparse 2D for plus). The cache key (`binairoCacheKey` and
`BinairoSolver._cacheKey`) mixes comparison-clue bytes so two boards
with identical givens but different clues don't share cache slots.

Preview canvas renders `=` / `≠` glyphs at cell-boundary midpoints in the
cached `staticLayer`; `staticSig` includes a `|cc=` segment so the
layer rebuilds when the clue set changes.
```

- [ ] **Step 3: Verify the file is well-formed**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm run lint && npm run typecheck`

Expected: both exit 0 (CLAUDE.md is markdown — neither tool checks it; the run verifies you didn't accidentally edit something else).

- [ ] **Step 4: Commit**

```bash
cd /home/quando/documents/chrome-puzzle-solver && jj commit -m "docs(claude): Binairo Plus + comparison-clue subsection"
```

---

## Final verification

After all tasks complete:

- [ ] **Step 1: Full quality gate**

Run: `cd /home/quando/documents/chrome-puzzle-solver && npm run lint && npm run typecheck && npm test && npm run build`

Expected: all green.

- [ ] **Step 2: Bench**

Run: `cd /home/quando/documents/chrome-puzzle-solver && node tests/bench-binairo.js`

Expected: three lines reporting solved=true.

- [ ] **Step 3: Live smoke test** (user-side; this plan can't drive a browser):
- Reload the unpacked extension from `dist/`.
- Visit `https://www.puzzles-mobile.com/binairo-plus/random/6x6-easy`.
- Detect → expects "Detected Binairo 6x6".
- Solve → expects board filled correctly, comparison-rule glyphs visible on the preview.
- Visit `https://www.puzzles-mobile.com/` (homepage) → "Supported puzzles" list shows Binairo Plus.

- [ ] **Step 4: `jj log` review**

Run: `cd /home/quando/documents/chrome-puzzle-solver && jj log -n 14 --no-graph -T 'commit_id.short() ++ " " ++ description.first_line() ++ "\n"'`

Expected commits, in order (oldest at bottom):
- `docs(claude): Binairo Plus + comparison-clue subsection`
- `test(binairo-plus): rule-validity fuzz now covers comparison clues`
- `test(binairo-plus): real-puzzle bench fixture + ctor spread`
- `test(binairo-plus): 6x6 fixture + golden snapshot + matching solver test`
- `feat(binairo-plus): render =/≠ glyphs in preview staticLayer`
- `feat(binairo-plus): solveExtraData, cache key, supported puzzles list`
- `feat(binairo-plus): handler matches both paths, threads comparisonClues`
- `feat(binairo): worker dispatch threads comparisonClues to BinairoSolver`
- `feat(binairo): _cacheKey mixes comparison-clue bytes`
- `test(binairo): _applyComparison NE forcing + contradiction`
- `feat(binairo): _applyComparison propagates EQ constraints`
- `feat(binairo): _decodeComparison + comparisonClues ctor parameter`
- `docs(binairo-plus): design spec for comparison-clue variant support`

---

## Notes for the executing engineer

- **`puzzleData.type` stays `'binairo'`.** Don't introduce a `'binairo-plus'` type tag — every site of `type === 'binairo'` already handles the new code paths through the optional `comparisonClues` field. Adding a new type tag would force duplicate handling everywhere (preview, cache key, dispatch).
- **Comparison decode is one-shot at construction.** Don't re-decode in `propagate()` — `compConstraints` is canonical and immutable for the solver's lifetime.
- **Static layer rebuild on clue change.** `staticSig` includes the comparison-clue hash; the layer rebuilds automatically. Don't try to mutate the cached canvas in place.
- **No new MAIN-world fns.** `readBinairoData` already returns `comparisonClues` (added during the original Binairo work). The plumbing for that field has been dormant; this plan activates it.
- **jj, not git.** Every commit step uses `jj commit -m "..."`. The repo is colocated; running `git commit` silently misroutes the change.
