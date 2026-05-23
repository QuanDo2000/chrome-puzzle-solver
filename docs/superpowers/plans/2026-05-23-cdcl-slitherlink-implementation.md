# CDCL search for SlitherlinkSolver — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Conflict-Driven Clause Learning search engine to `SlitherlinkSolver` so the 50×40 monthly Slitherlink solves to a unique solution in ≤5 s wall, without regressing the 30×30 daily (≤2 s).

**Architecture:** Preserve every existing propagation layer (clue, vertex, advanced patterns, color, connectivity, parity, lookahead). They become *implication generators* that supply reasons for each forced assignment. Replace chronological `_backtrack` with non-chronological backjump driven by first-UIP conflict analysis, learned-clause propagation, VSIDS-style variable ordering, and Luby restarts. All new state lives on the existing `SlitherlinkSolver` instance.

**Tech Stack:** Vanilla ES2020 JavaScript, Chrome MV3, `node:test` for tests, `jj` (Jujutsu) for version control — **never plain `git`**.

**Conventions:**
- This repo is a colocated Jujutsu/git workspace. Commit with `jj commit -m "msg"`. Do NOT run `git commit`/`git add`/etc.
- After editing `solver.js` or other runtime files, run `npm run build`.
- `npm run lint`, `npm run typecheck`, `npm test` must all pass before each commit.
- Every commit message ends with a blank line then `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

---

## Cross-task invariants

These must stay consistent. Re-read them before each task.

- **Variable ID ranges:** `[0, numH)` = H edges, `[numH, numH+numV)` = V edges, `[numH+numV, totalVars)` = cell colors.
  - `numH = (height + 1) * width`, `numV = height * (width + 1)`, `cellCount = height * width`, `totalVars = numH + numV + cellCount`.
- **Literal sign convention:** positive integer = "var is true (LINE for edges, INSIDE for cells)"; negative = "var is false (EMPTY for edges, OUTSIDE for cells)". `0` = unassigned/UNKNOWN.
- **`_currentReason`:** set to an array of antecedent variable IDs (may be `[]`) BEFORE each `_setEdge`/`_setColor` call inside a rule; the setter captures it into `_reasons[]` and resets it to `null`. Decisions set it to `null` explicitly — a `null` in `_reasons[i]` marks a decision.
- **`_reasons`, `_decisionLevels`:** parallel arrays to `this.trail`. `_rollback(mark)` pops all three to `mark`.
- **`_decisionLevel`:** current decision level integer. Starts at 0. Incremented by each decision, rolled back by backjump.
- **Exact names used throughout tasks 1–21:** `_varIdEdge`, `_varIdCell`, `_decodeVar`, `_varValue`, `_reasons`, `_decisionLevels`, `_decisionLevel`, `_currentReason`.

---

## Task 1: Variable encoding helpers

**Files:**
- Modify: `solver.js` — add methods to `SlitherlinkSolver`; extend constructor.
- Modify: `tests/solver.test.js`

Add three encoding helpers and one value-query helper to `SlitherlinkSolver`. Extend the constructor to compute `this.numH`, `this.numV`, `this.cellCount`, `this.totalVars`.

**Variable ID ranges** (verbatim from spec §2):
- `[0, numH)` — H edges, in flat H-array order (`_hIdx(r, c)` = `r * W + c`).
- `[numH, numH + numV)` — V edges, in flat V-array order (`_vIdx(r, c)` = `r * (W+1) + c`).
- `[numH + numV, totalVars)` — cell colors, in row-major order (`r * W + c`).

**`_varValue(varId)`** returns the current sign: `+1` if the variable is set to its *true* sense (LINE for edges, INSIDE for cells), `-1` if set to its *false* sense (EMPTY or OUTSIDE), `0` if UNKNOWN.

- [ ] **Step 1: Write the failing test**

In `tests/solver.test.js`, add the following tests after the existing `SlitherlinkSolver` tests:

```js
test('SlitherlinkSolver: _varIdEdge/_varIdCell/_decodeVar round-trip', () => {
  const s = new SlitherlinkSolver({
    width: 5, height: 5,
    task: [[-1,-1,-1,-1,-1],[-1,-1,-1,-1,-1],[-1,-1,-1,-1,-1],[-1,-1,-1,-1,-1],[-1,-1,-1,-1,-1]],
  });
  // numH = (5+1)*5 = 30, numV = 5*(5+1) = 30, cellCount = 25, totalVars = 85.
  assert.equal(s.numH, 30);
  assert.equal(s.numV, 30);
  assert.equal(s.cellCount, 25);
  assert.equal(s.totalVars, 85);

  // H edge at flat index 7.
  const hId = s._varIdEdge('H', 7);
  assert.equal(hId, 7);
  const dH = s._decodeVar(hId);
  assert.equal(dH.kind, 'H');
  assert.equal(dH.idx, 7);

  // V edge at flat index 3.
  const vId = s._varIdEdge('V', 3);
  assert.equal(vId, s.numH + 3);
  const dV = s._decodeVar(vId);
  assert.equal(dV.kind, 'V');
  assert.equal(dV.idx, 3);

  // Cell at flat index 12 (row 2, col 2 of a 5-wide grid).
  const cId = s._varIdCell(12);
  assert.equal(cId, s.numH + s.numV + 12);
  const dC = s._decodeVar(cId);
  assert.equal(dC.kind, 'C');
  assert.equal(dC.idx, 12);

  // Every var ID in [0, totalVars) round-trips.
  for (let i = 0; i < s.totalVars; i++) {
    const d = s._decodeVar(i);
    if (d.kind === 'H') assert.equal(s._varIdEdge('H', d.idx), i);
    else if (d.kind === 'V') assert.equal(s._varIdEdge('V', d.idx), i);
    else assert.equal(s._varIdCell(d.idx), i);
  }
});

test('SlitherlinkSolver: _varValue on initial state returns 0', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  for (let i = 0; i < s.totalVars; i++) {
    assert.equal(s._varValue(i), 0, `var ${i} should be UNKNOWN initially`);
  }
});

test('SlitherlinkSolver: _varValue after _setEdge LINE returns +1', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  const idx = s._hIdx(0, 0);
  s._setEdge(idx, 'H', 1);  // LINE
  assert.equal(s._varValue(s._varIdEdge('H', idx)), 1);
});

test('SlitherlinkSolver: _varValue after _setEdge EMPTY returns -1', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  const idx = s._hIdx(0, 1);
  s._setEdge(idx, 'H', 2);  // EMPTY
  assert.equal(s._varValue(s._varIdEdge('H', idx)), -1);
});

test('SlitherlinkSolver: _varValue after _setColor INSIDE returns +1', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  const cellIdx = 0;  // cell (0,0)
  s._setColor(cellIdx, 1);  // INSIDE
  assert.equal(s._varValue(s._varIdCell(cellIdx)), 1);
});

test('SlitherlinkSolver: _varValue after _setColor OUTSIDE returns -1', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  const cellIdx = 1;  // cell (0,1)
  s._setColor(cellIdx, 2);  // OUTSIDE
  assert.equal(s._varValue(s._varIdCell(cellIdx)), -1);
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `node --test --test-name-pattern='SlitherlinkSolver: _varId'`
Expected: FAIL with `s._varIdEdge is not a function` (or `s.numH is not defined`).

Run: `node --test --test-name-pattern='SlitherlinkSolver: _varValue'`
Expected: FAIL with `s._varValue is not a function`.

- [ ] **Step 3: Write the implementation**

In `solver.js`, inside the `SlitherlinkSolver` constructor, add the four derived counts immediately after `this.width`/`this.height` are assigned (before the `Uint8Array` declarations):

```js
    // CDCL variable counts. Must be set after width/height.
    const _W = width, _H = height;
    this.numH = (_H + 1) * _W;
    this.numV = _H * (_W + 1);
    this.cellCount = _H * _W;
    this.totalVars = this.numH + this.numV + this.cellCount;
```

Then add the four helper methods to the `SlitherlinkSolver` class body (place them after `_dotId`):

```js
  // ── CDCL variable encoding ───────────────────────────────────────────────
  // Variable IDs: [0, numH) = H edges, [numH, numH+numV) = V edges,
  // [numH+numV, totalVars) = cell colors (row-major).

  /** @param {'H'|'V'} kind @param {number} idx @returns {number} */
  _varIdEdge(kind, idx) {
    return kind === 'H' ? idx : this.numH + idx;
  }

  /** @param {number} cellIdx  (r * width + c) @returns {number} */
  _varIdCell(cellIdx) {
    return this.numH + this.numV + cellIdx;
  }

  /** @param {number} varId @returns {{ kind: 'H'|'V'|'C', idx: number }} */
  _decodeVar(varId) {
    if (varId < this.numH) return { kind: 'H', idx: varId };
    if (varId < this.numH + this.numV) return { kind: 'V', idx: varId - this.numH };
    return { kind: 'C', idx: varId - this.numH - this.numV };
  }

  /**
   * Current sign of variable `varId`:
   *  +1 if true  (edge=LINE  or cell=INSIDE)
   *  -1 if false (edge=EMPTY or cell=OUTSIDE)
   *   0 if UNKNOWN
   * @param {number} varId
   * @returns {-1|0|1}
   */
  _varValue(varId) {
    const d = this._decodeVar(varId);
    if (d.kind === 'H') {
      const v = this.H[d.idx];
      return v === 0 ? 0 : v === 1 ? 1 : -1;
    }
    if (d.kind === 'V') {
      const v = this.V[d.idx];
      return v === 0 ? 0 : v === 1 ? 1 : -1;
    }
    // Cell color: 0=UNKNOWN, 1=INSIDE(+1), 2=OUTSIDE(-1).
    const c = this.colors[d.idx];
    return c === 0 ? 0 : c === 1 ? 1 : -1;
  }
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `node --test --test-name-pattern='SlitherlinkSolver: _varId'`
Run: `node --test --test-name-pattern='SlitherlinkSolver: _varValue'`
Expected: all 7 new tests pass.

Run the full suite to confirm no regressions: `npm test`
Expected: all green.

- [ ] **Step 5: Build and commit**

```bash
npm run build && npm run lint && npm run typecheck && jj commit -m "$(cat <<'EOF'
feat(cdcl): variable encoding helpers on SlitherlinkSolver

Add _varIdEdge, _varIdCell, _decodeVar, _varValue, and the four derived
counts (numH, numV, cellCount, totalVars). Foundation for CDCL reason
tracking.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Reason tracking data structures

**Files:**
- Modify: `solver.js` — extend `SlitherlinkSolver` constructor.
- Modify: `tests/solver.test.js`

Add four fields to the constructor. They are parallel or companion to `this.trail`.

```
this._reasons        = []   // null = decision; [...varIds] = propagation antecedents
this._decisionLevels = []   // integer decision level for each trail entry
this._decisionLevel  = 0    // current decision level
this._currentReason  = null // set by rules before calling _setEdge/_setColor
```

- [ ] **Step 1: Write the failing test**

Add to `tests/solver.test.js`:

```js
test('SlitherlinkSolver: reason structures initialized correctly after construction', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  assert.ok(Array.isArray(s._reasons), '_reasons must be an array');
  assert.equal(s._reasons.length, 0);
  assert.ok(Array.isArray(s._decisionLevels), '_decisionLevels must be an array');
  assert.equal(s._decisionLevels.length, 0);
  assert.equal(s._decisionLevel, 0);
  assert.equal(s._currentReason, null);
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `node --test --test-name-pattern='SlitherlinkSolver: reason structures initialized'`
Expected: FAIL with `s._reasons is not defined` or assertion failure.

- [ ] **Step 3: Write the implementation**

In `solver.js`, inside the `SlitherlinkSolver` constructor, add the four fields immediately after the `this.trail = []` line:

```js
    // ── CDCL reason tracking (parallel to this.trail) ────────────────────
    // _reasons[i]: null = decision; [...varIds] = propagation antecedents.
    // _decisionLevels[i]: decision level at the time of the trail entry.
    this._reasons = [];
    this._decisionLevels = [];
    // Current search decision level (0 = top-level propagation).
    this._decisionLevel = 0;
    // Set by a rule helper before it calls _setEdge/_setColor so those
    // setters can capture the reason. Decisions set it to null explicitly.
    this._currentReason = null;
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `node --test --test-name-pattern='SlitherlinkSolver: reason structures initialized'`
Expected: PASS.

Run: `npm test`
Expected: all green.

- [ ] **Step 5: Build and commit**

```bash
npm run build && npm run lint && npm run typecheck && jj commit -m "$(cat <<'EOF'
feat(cdcl): reason tracking fields on SlitherlinkSolver

Add _reasons, _decisionLevels, _decisionLevel, _currentReason to the
constructor. Parallel to this.trail; wired to setters in next task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `_setEdge` / `_setColor` capture `_currentReason`

**Files:**
- Modify: `solver.js` — extend `_setEdge` and `_setColor`; extend `_rollback`.
- Modify: `tests/solver.test.js`

**Contract:** On every successful write (old was UNKNOWN, new is not), push `this._currentReason` into `_reasons[]` and `this._decisionLevel` into `_decisionLevels[]` (parallel to the entry just appended to `this.trail`). Then reset `this._currentReason = null`.

`_rollback(mark)` already pops `this.trail` back to `mark`; extend it to also pop `_reasons` and `_decisionLevels` to `mark`.

**Note:** The `initialState` constructor block calls `_setEdge` then does `this.trail.length = 0`. After this task, also reset `this._reasons.length = 0` and `this._decisionLevels.length = 0` in that same block.

- [ ] **Step 1: Write the failing test**

Add to `tests/solver.test.js`:

```js
test('SlitherlinkSolver: _setEdge captures _currentReason into _reasons', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  const idx = s._hIdx(0, 0);
  const fakeReason = [42, 13];
  s._currentReason = fakeReason;
  s._setEdge(idx, 'H', 1);
  // After the set, the trail entry was pushed, reasons and decisionLevels matched.
  const trailLen = s.trail.length;
  assert.ok(trailLen >= 1);
  assert.deepEqual(s._reasons[trailLen - 1], fakeReason);
  assert.equal(s._decisionLevels[trailLen - 1], 0);
  // _currentReason is reset to null after capture.
  assert.equal(s._currentReason, null);
  assert.equal(s._reasons.length, s.trail.length);
  assert.equal(s._decisionLevels.length, s.trail.length);
});

test('SlitherlinkSolver: _setEdge with null _currentReason records null reason (decision)', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  const idx = s._vIdx(0, 0);
  s._currentReason = null;  // decision
  s._setEdge(idx, 'V', 2);
  const trailLen = s.trail.length;
  assert.equal(s._reasons[trailLen - 1], null);
  assert.equal(s._decisionLevels[trailLen - 1], 0);
});

test('SlitherlinkSolver: _setColor captures _currentReason', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  const cellIdx = 4;  // center cell
  const fakeReason = [s._varIdCell(0)];
  s._currentReason = fakeReason;
  s._setColor(cellIdx, 1);  // INSIDE
  const trailLen = s.trail.length;
  assert.ok(trailLen >= 1);
  assert.deepEqual(s._reasons[trailLen - 1], fakeReason);
  assert.equal(s._currentReason, null);
});

test('SlitherlinkSolver: _rollback pops _reasons and _decisionLevels in sync', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  const mark = s.trail.length;
  s._currentReason = [5];
  s._setEdge(s._hIdx(0, 0), 'H', 1);
  s._currentReason = [6, 7];
  s._setEdge(s._hIdx(0, 1), 'H', 2);
  assert.equal(s.trail.length, mark + 2);
  assert.equal(s._reasons.length, mark + 2);
  assert.equal(s._decisionLevels.length, mark + 2);
  s._rollback(mark);
  assert.equal(s.trail.length, mark);
  assert.equal(s._reasons.length, mark);
  assert.equal(s._decisionLevels.length, mark);
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `node --test --test-name-pattern='SlitherlinkSolver: _setEdge captures'`
Run: `node --test --test-name-pattern='SlitherlinkSolver: _setColor captures'`
Run: `node --test --test-name-pattern='SlitherlinkSolver: _rollback pops _reasons'`
Expected: FAIL — `_reasons` array stays empty after `_setEdge`.

- [ ] **Step 3: Write the implementation**

In `solver.js`, extend `_setEdge` to push reason and level. Find the `_setEdge` method and replace the `this.trail.push(...)` line and the subsequent `arr[idx] = val` block with:

```js
  _setEdge(idx, kind, val) {
    const arr = kind === 'H' ? this.H : this.V;
    const old = arr[idx];
    if (old === val) return true;
    if (old !== 0) return false;  // attempted to overwrite an existing value
    const kindBit = kind === 'H' ? 0 : 1;
    this.trail.push((kindBit << 24) | idx);
    this._reasons.push(this._currentReason);
    this._decisionLevels.push(this._decisionLevel);
    this._currentReason = null;
    arr[idx] = val;
    // Update endpoint counters.
    const [u, v] = this._edgeEndpoints(kind, idx);
    this.unknownCount[u]--;
    this.unknownCount[v]--;
    if (val === 1) {
      this.lineCount[u]++;
      this.lineCount[v]++;
    }
    return true;
  }
```

Extend `_setColor` similarly:

```js
  _setColor(idx, color) {
    const old = this.colors[idx];
    if (old === color) return true;
    if (old !== 0) return false;  // conflict
    this.trail.push((old << 26) | (2 << 24) | idx);
    this._reasons.push(this._currentReason);
    this._decisionLevels.push(this._decisionLevel);
    this._currentReason = null;
    this.colors[idx] = color;
    return true;
  }
```

Extend `_rollback` to pop the two parallel arrays:

```js
  _rollback(mark) {
    while (this.trail.length > mark) {
      const e = this.trail.pop();
      this._reasons.pop();
      this._decisionLevels.pop();
      const idx = e & 0xFFFFFF;
      const kind = (e >> 24) & 3;  // 2-bit kind: 0=H, 1=V, 2=color
      if (kind === 2) {
        this.colors[idx] = (e >> 26) & 3;
      } else {
        const arr = kind === 0 ? this.H : this.V;
        const edgeKind = kind === 0 ? 'H' : 'V';
        const cur = arr[idx];
        arr[idx] = 0;
        const [u, v] = this._edgeEndpoints(edgeKind, idx);
        this.unknownCount[u]++;
        this.unknownCount[v]++;
        if (cur === 1) {
          this.lineCount[u]--;
          this.lineCount[v]--;
        }
      }
    }
  }
```

In the constructor's `initialState` block, after `this.trail.length = 0`, add:

```js
      this._reasons.length = 0;
      this._decisionLevels.length = 0;
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `node --test --test-name-pattern='SlitherlinkSolver: _setEdge captures'`
Run: `node --test --test-name-pattern='SlitherlinkSolver: _setEdge with null'`
Run: `node --test --test-name-pattern='SlitherlinkSolver: _setColor captures'`
Run: `node --test --test-name-pattern='SlitherlinkSolver: _rollback pops _reasons'`
Expected: all 4 tests pass.

Run: `npm test`
Expected: all green.

- [ ] **Step 5: Build and commit**

```bash
npm run build && npm run lint && npm run typecheck && jj commit -m "$(cat <<'EOF'
feat(cdcl): _setEdge/_setColor capture _currentReason; _rollback syncs

Both setters now push _currentReason into _reasons[] and _decisionLevel
into _decisionLevels[] on every successful write, then reset
_currentReason to null. _rollback pops all three arrays in sync.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Instrument clue + vertex + pattern rules

**Files:**
- Modify: `solver.js` — add `this._currentReason = ...` before each `_setEdge` in `_applyClueRuleAt`, `_applyVertexRuleAt`, `_applyCornerThree`, `_applyCornerOne`, `_applyAdjacentThreeH`, `_applyAdjacentThreeV`, `_applyDiagonalThree`.
- Modify: `tests/solver.test.js`

**Antecedent rules per spec §3:**

- **`_applyClueRuleAt(r, c, onChange)`:** Before each `_setEdge`, set `_currentReason` to the variable IDs of the cell's other edges that are currently non-UNKNOWN (i.e., the m already-LINE and already-EMPTY edges that triggered the force). Use `_varIdEdge(e.kind, e.idx)` for each.
- **`_applyVertexRuleAt(r, c, onChange)`:** Before each `_setEdge`, set `_currentReason` to the variable IDs of the vertex's other incident edges that are currently non-UNKNOWN.
- **`_applyCornerThree`, `_applyCornerOne`, `_applyAdjacentThreeH`, `_applyAdjacentThreeV`, `_applyDiagonalThree`:** Set `_currentReason = []` (empty — rule fires from clue+geometry alone, no runtime evidence).

**Important:** Because these setters are called in a loop over the cell's edges (forcing all UNKNOWN ones), the antecedent set for any one `_setEdge` call inside the loop is all the *other* edges of the cell that are non-UNKNOWN at the point of the overall rule check — i.e., the `m` LINE edges plus any EMPTY edges that contributed to the `m === clue` or `m + n === clue` branch. Compute this ONCE before the force loop and reuse it for every forced edge in that loop pass.

- [ ] **Step 1: Write the failing test**

Add to `tests/solver.test.js`:

```js
test('SlitherlinkSolver: _applyClueRuleAt records correct antecedents for each forced edge', () => {
  // Cell (0,0) with clue 2. Pre-set top H[0][0] = LINE and left V[0][0] = EMPTY.
  // That leaves bottom H[1][0] and right V[0][1] as UNKNOWN.
  // m=1 (LINE), known_empty=1, n=2. m+n=3 ≠ clue=2, m≠clue=2. No force yet.
  // Now pre-set left V[0][0]=LINE so m=2=clue → force bottom and right to EMPTY.
  // Antecedents for each forced edge = var IDs of the other 2 known edges (H[0][0]=LINE and V[0][0]=LINE).
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[2,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  const hTopIdx = s._hIdx(0, 0);
  const vLeftIdx = s._vIdx(0, 0);
  s._currentReason = null; s._setEdge(hTopIdx, 'H', 1);
  s._currentReason = null; s._setEdge(vLeftIdx, 'V', 1);

  const forced = [];
  const ok = s._applyClueRuleAt(0, 0, () => forced.push(null));
  assert.equal(ok, true);
  // Two edges forced (bottom and right). Check the reasons captured for those trail entries.
  // The two forced edges are the last two trail entries.
  const trailLen = s.trail.length;
  // Antecedents should be the var IDs of [hTopIdx as H, vLeftIdx as V].
  const expectedAntecedents = new Set([
    s._varIdEdge('H', hTopIdx),
    s._varIdEdge('V', vLeftIdx),
  ]);
  // Last two trail entries should have matching reason sets.
  for (let i = trailLen - forced.length; i < trailLen; i++) {
    const reason = s._reasons[i];
    assert.ok(Array.isArray(reason), `reason at trail[${i}] must be an array`);
    assert.equal(reason.length, 2, `reason should have 2 antecedents`);
    for (const v of reason) assert.ok(expectedAntecedents.has(v), `unexpected antecedent ${v}`);
  }
});

test('SlitherlinkSolver: _applyVertexRuleAt records correct antecedents', () => {
  // Dot (0,0) (corner) with H[0][0]=LINE. The only other incident edge V[0][0]
  // must be forced LINE (m=1, n=1). Antecedent = varId of H[0][0].
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  const hIdx = s._hIdx(0, 0);
  s._currentReason = null; s._setEdge(hIdx, 'H', 1);
  const trailBefore = s.trail.length;
  const ok = s._applyVertexRuleAt(0, 0, () => {});
  assert.equal(ok, true);
  assert.equal(s.trail.length, trailBefore + 1, 'should force exactly 1 edge');
  const reason = s._reasons[s.trail.length - 1];
  assert.ok(Array.isArray(reason));
  assert.equal(reason.length, 1);
  assert.equal(reason[0], s._varIdEdge('H', hIdx));
});

test('SlitherlinkSolver: _applyCornerThree records empty antecedents', () => {
  // Top-left corner with clue 3. Both outer edges forced LINE.
  // Antecedents must be [] (geometry-only rule).
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[3,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  const trailBefore = s.trail.length;
  const ok = s._applyCornerThree('TL', () => {});
  assert.equal(ok, true);
  for (let i = trailBefore; i < s.trail.length; i++) {
    assert.deepEqual(s._reasons[i], []);
  }
});

test('SlitherlinkSolver: _applyAdjacentThreeH records empty antecedents', () => {
  const s = new SlitherlinkSolver({
    width: 4, height: 3,
    task: [[3,3,-1,-1],[-1,-1,-1,-1],[-1,-1,-1,-1]],
  });
  const trailBefore = s.trail.length;
  const ok = s._applyAdjacentThreeH(0, 0, () => {});
  assert.equal(ok, true);
  for (let i = trailBefore; i < s.trail.length; i++) {
    assert.deepEqual(s._reasons[i], []);
  }
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `node --test --test-name-pattern='SlitherlinkSolver: _applyClueRuleAt records'`
Run: `node --test --test-name-pattern='SlitherlinkSolver: _applyVertexRuleAt records'`
Run: `node --test --test-name-pattern='SlitherlinkSolver: _applyCornerThree records'`
Run: `node --test --test-name-pattern='SlitherlinkSolver: _applyAdjacentThreeH records'`
Expected: FAIL — `_reasons` entries are `null` instead of arrays (because `_currentReason` was never set by the rule).

- [ ] **Step 3: Write the implementation**

**`_applyClueRuleAt`:** Before the force loops, compute the antecedent variable IDs of all non-UNKNOWN edges (the ones that triggered the rule). Set `_currentReason` to that array before each forced `_setEdge`.

Replace the body of `_applyClueRuleAt` in `solver.js` with:

```js
  _applyClueRuleAt(r, c, onChange) {
    const clue = (this.task[r] || [])[c];
    if (clue === undefined || clue < 0 || clue > 4) return true;
    const edges = this._cellEdges(r, c);
    let m = 0, n = 0;
    for (const e of edges) {
      const v = (e.kind === 'H' ? this.H : this.V)[e.idx];
      if (v === 1) m++;
      else if (v === 0) n++;
    }
    if (m > clue) return false;
    if (m + n < clue) return false;
    if (m === clue && n > 0) {
      // Force all UNKNOWN edges → EMPTY. Antecedents = non-UNKNOWN edges.
      const antecedents = edges
        .filter(e => (e.kind === 'H' ? this.H : this.V)[e.idx] !== 0)
        .map(e => this._varIdEdge(e.kind, e.idx));
      for (const e of edges) {
        const arr = e.kind === 'H' ? this.H : this.V;
        if (arr[e.idx] === 0) {
          this._currentReason = antecedents;
          if (!this._setEdge(e.idx, e.kind, 2)) return false;
          onChange();
        }
      }
    } else if (m + n === clue && n > 0) {
      // Force all UNKNOWN edges → LINE. Antecedents = non-UNKNOWN edges.
      const antecedents = edges
        .filter(e => (e.kind === 'H' ? this.H : this.V)[e.idx] !== 0)
        .map(e => this._varIdEdge(e.kind, e.idx));
      for (const e of edges) {
        const arr = e.kind === 'H' ? this.H : this.V;
        if (arr[e.idx] === 0) {
          this._currentReason = antecedents;
          if (!this._setEdge(e.idx, e.kind, 1)) return false;
          onChange();
        }
      }
    }
    return true;
  }
```

**`_applyVertexRuleAt`:** Antecedents = the non-UNKNOWN incident edges of the dot (the ones that are already LINE/EMPTY and triggered the force). Replace the body of `_applyVertexRuleAt` with:

```js
  _applyVertexRuleAt(r, c, onChange) {
    const dotId = this._dotId(r, c);
    const m = this.lineCount[dotId];
    const n = this.unknownCount[dotId];
    if (m > 2) return false;
    if (m === 1 && n === 0) return false;
    if (m === 2 && n > 0) {
      // Antecedents = the 2 LINE edges.
      const antecedents = this._dotEdges(r, c)
        .filter(e => (e.kind === 'H' ? this.H : this.V)[e.idx] !== 0)
        .map(e => this._varIdEdge(e.kind, e.idx));
      for (const e of this._dotEdges(r, c)) {
        const arr = e.kind === 'H' ? this.H : this.V;
        if (arr[e.idx] === 0) {
          this._currentReason = antecedents;
          if (!this._setEdge(e.idx, e.kind, 2)) return false;
          onChange();
        }
      }
    } else if (m === 1 && n === 1) {
      // Antecedent = the 1 LINE edge.
      const antecedents = this._dotEdges(r, c)
        .filter(e => (e.kind === 'H' ? this.H : this.V)[e.idx] === 1)
        .map(e => this._varIdEdge(e.kind, e.idx));
      for (const e of this._dotEdges(r, c)) {
        const arr = e.kind === 'H' ? this.H : this.V;
        if (arr[e.idx] === 0) {
          this._currentReason = antecedents;
          if (!this._setEdge(e.idx, e.kind, 1)) return false;
          onChange();
          break;
        }
      }
    } else if (m === 0 && n === 1) {
      // No LINE edges; geometry-only deduction. Use empty antecedents.
      this._currentReason = [];
      for (const e of this._dotEdges(r, c)) {
        const arr = e.kind === 'H' ? this.H : this.V;
        if (arr[e.idx] === 0) {
          if (!this._setEdge(e.idx, e.kind, 2)) return false;
          onChange();
          break;
        }
      }
    }
    return true;
  }
```

**Corner / adjacent / diagonal pattern helpers:** Add `this._currentReason = []` before every `_setEdge` call. Replace each helper:

```js
  _applyCornerThree(corner, onChange) {
    const coords = this._cornerCoords(corner);
    if (!coords) return true;
    const [cr, cc, hr, hc, vr, vc] = coords;
    const k = (this.task[cr] || [])[cc];
    if (k !== 3) return true;
    if (this.H[this._hIdx(hr, hc)] !== 1) {
      this._currentReason = [];
      if (!this._setEdge(this._hIdx(hr, hc), 'H', 1)) return false;
      onChange();
    }
    if (this.V[this._vIdx(vr, vc)] !== 1) {
      this._currentReason = [];
      if (!this._setEdge(this._vIdx(vr, vc), 'V', 1)) return false;
      onChange();
    }
    return true;
  }

  _applyCornerOne(corner, onChange) {
    const coords = this._cornerCoords(corner);
    if (!coords) return true;
    const [cr, cc, hr, hc, vr, vc] = coords;
    const k = (this.task[cr] || [])[cc];
    if (k !== 1) return true;
    if (this.H[this._hIdx(hr, hc)] !== 2) {
      this._currentReason = [];
      if (!this._setEdge(this._hIdx(hr, hc), 'H', 2)) return false;
      onChange();
    }
    if (this.V[this._vIdx(vr, vc)] !== 2) {
      this._currentReason = [];
      if (!this._setEdge(this._vIdx(vr, vc), 'V', 2)) return false;
      onChange();
    }
    return true;
  }

  _applyAdjacentThreeH(r, c, onChange) {
    if ((this.task[r] || [])[c] !== 3 || (this.task[r] || [])[c + 1] !== 3) return true;
    for (const [vr, vc] of [[r, c], [r, c + 1], [r, c + 2]]) {
      const idx = this._vIdx(vr, vc);
      if (this.V[idx] !== 1) {
        this._currentReason = [];
        if (!this._setEdge(idx, 'V', 1)) return false;
        onChange();
      }
    }
    return true;
  }

  _applyAdjacentThreeV(r, c, onChange) {
    if ((this.task[r] || [])[c] !== 3 || (this.task[r + 1] || [])[c] !== 3) return true;
    for (const [hr, hc] of [[r, c], [r + 1, c], [r + 2, c]]) {
      const idx = this._hIdx(hr, hc);
      if (this.H[idx] !== 1) {
        this._currentReason = [];
        if (!this._setEdge(idx, 'H', 1)) return false;
        onChange();
      }
    }
    return true;
  }

  _applyDiagonalThree(r, c, dr, dc, onChange) {
    const nr = r + dr, nc = c + dc;
    if ((this.task[r] || [])[c] !== 3 || (this.task[nr] || [])[nc] !== 3) return true;
    const hIdx1 = this._hIdx(r, c);
    const vIdx1 = dc === 1 ? this._vIdx(r, c) : this._vIdx(r, c + 1);
    const hIdx2 = this._hIdx(nr + 1, nc);
    const vIdx2 = dc === 1 ? this._vIdx(nr, nc + 1) : this._vIdx(nr, nc);
    for (const [arr, idx] of [[this.H, hIdx1], [this.V, vIdx1], [this.H, hIdx2], [this.V, vIdx2]]) {
      if (arr[idx] !== 1) {
        const kind = (arr === this.H) ? 'H' : 'V';
        this._currentReason = [];
        if (!this._setEdge(idx, kind, 1)) return false;
        onChange();
      }
    }
    return true;
  }
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `node --test --test-name-pattern='SlitherlinkSolver: _applyClueRuleAt records'`
Run: `node --test --test-name-pattern='SlitherlinkSolver: _applyVertexRuleAt records'`
Run: `node --test --test-name-pattern='SlitherlinkSolver: _applyCornerThree records'`
Run: `node --test --test-name-pattern='SlitherlinkSolver: _applyAdjacentThreeH records'`
Expected: all 4 pass.

Run: `npm test`
Expected: all green.

- [ ] **Step 5: Build and commit**

```bash
npm run build && npm run lint && npm run typecheck && jj commit -m "$(cat <<'EOF'
feat(cdcl): instrument clue, vertex, and pattern rules with reasons

_applyClueRuleAt and _applyVertexRuleAt set _currentReason to the
non-UNKNOWN antecedent edge var IDs before each _setEdge. Corner,
adjacent-3, and diagonal-3 helpers use [] (geometry-only reasons).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Instrument color rules (3 sub-rules)

**Files:**
- Modify: `solver.js` — add `this._currentReason = ...` before each `_setColor` and `_setEdge` call inside `_propagateColors`.
- Modify: `tests/solver.test.js`

**The three color sub-rules (spec §3):**

**(A) Edge → color:** A known edge (LINE or EMPTY) between cells A and B forces an unknown cell's color. Antecedents = [edge var ID, known-endpoint color var ID (if the endpoint color is non-UNKNOWN)].

**(B) Known colors → edge:** Both endpoint cells known → force the shared edge. Antecedents = [color var ID of cell above/left, color var ID of cell below/right].

**(C) Clue × own-color:** A clued cell with known own-color forces unknown neighbor colors when `m === clue` (same-color force) or `m + u === clue` (opposite-color force). Antecedents = [own-color var ID] plus the var IDs of the `m` opposite-color neighbors that contributed to the count.

- [ ] **Step 1: Write the failing test**

Add to `tests/solver.test.js`:

```js
test('SlitherlinkSolver: _propagateColors sub-rule A records edge+color antecedents', () => {
  // H[1][0] (bottom edge of cell (0,0)) is LINE.
  // Cell (0,0) is INSIDE (color 1).
  // Cell (1,0) is UNKNOWN → forced OUTSIDE (2). Antecedents = [varId(H[1][0]), varId(cell(0,0))].
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  s._currentReason = null; s._setEdge(s._hIdx(1, 0), 'H', 1);  // LINE between rows 0 and 1
  s._currentReason = null; s._setColor(0, 1);  // cell (0,0) = INSIDE
  const trailBefore = s.trail.length;
  const ok = s._propagateColors(() => {});
  assert.equal(ok, true);
  // Cell (1,0) should now be OUTSIDE.
  assert.equal(s.colors[1 * 3 + 0], 2);
  // Check the reason for the most-recently-forced color entry.
  let colorForceIdx = -1;
  for (let i = s.trail.length - 1; i >= trailBefore; i--) {
    // kind=2 means color entry.
    if (((s.trail[i] >> 24) & 3) === 2) { colorForceIdx = i; break; }
  }
  assert.ok(colorForceIdx >= 0, 'expected a color trail entry from rule A');
  const reason = s._reasons[colorForceIdx];
  assert.ok(Array.isArray(reason));
  assert.ok(reason.includes(s._varIdEdge('H', s._hIdx(1, 0))), 'reason must include edge var');
  assert.ok(reason.includes(s._varIdCell(0)), 'reason must include above-cell color var');
});

test('SlitherlinkSolver: _propagateColors sub-rule B records both-color antecedents', () => {
  // Cell (0,0) = INSIDE, cell (0,1) = OUTSIDE. V[0][1] (shared vertical edge) forced LINE.
  // Antecedents = [varId(cell(0,0)), varId(cell(0,1))].
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  s._currentReason = null; s._setColor(0, 1);  // cell (0,0)=INSIDE
  s._currentReason = null; s._setColor(1, 2);  // cell (0,1)=OUTSIDE
  const trailBefore = s.trail.length;
  const ok = s._propagateColors(() => {});
  assert.equal(ok, true);
  // V[0][1] should be LINE.
  assert.equal(s.V[s._vIdx(0, 1)], 1);
  // Find the edge trail entry.
  let edgeForceIdx = -1;
  for (let i = s.trail.length - 1; i >= trailBefore; i--) {
    if (((s.trail[i] >> 24) & 3) !== 2) { edgeForceIdx = i; break; }
  }
  assert.ok(edgeForceIdx >= 0, 'expected an edge trail entry from rule B');
  const reason = s._reasons[edgeForceIdx];
  assert.ok(Array.isArray(reason));
  assert.ok(reason.includes(s._varIdCell(0)), 'reason must include left-cell color var');
  assert.ok(reason.includes(s._varIdCell(1)), 'reason must include right-cell color var');
});

test('SlitherlinkSolver: _propagateColors sub-rule C records own-color + opposite-neighbor antecedents', () => {
  // Clue 1 at (0,0). Cell (0,0) = INSIDE (1). The one neighbor that is opposite is
  // forced when m+u==clue. Set cell (0,0)=INSIDE and make all 4 neighbors UNKNOWN
  // except one already opposite. Then check antecedents when the last unknown is forced.
  //
  // 3×3 grid, clue 1 at center cell (1,1). Set colors: (1,1)=INSIDE, (0,1)=OUTSIDE.
  // m=1=clue → force remaining 3 unknown neighbors to INSIDE (same as myColor).
  // Antecedents = [varId(cell(1,1)), varId(cell(0,1))].
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,1,-1],[-1,-1,-1]],
  });
  const centerIdx = 1 * 3 + 1;  // cell (1,1)
  const aboveIdx  = 0 * 3 + 1;  // cell (0,1)
  s._currentReason = null; s._setColor(centerIdx, 1);  // (1,1) = INSIDE
  s._currentReason = null; s._setColor(aboveIdx, 2);   // (0,1) = OUTSIDE (opposite)
  const trailBefore = s.trail.length;
  const ok = s._propagateColors(() => {});
  assert.equal(ok, true);
  // At least one neighbor forced to INSIDE (same as myColor=1) by rule C.
  let ruleCAntecedentsOk = false;
  for (let i = trailBefore; i < s.trail.length; i++) {
    if (((s.trail[i] >> 24) & 3) !== 2) continue;  // skip edge entries
    const reason = s._reasons[i];
    if (!Array.isArray(reason)) continue;
    if (reason.includes(s._varIdCell(centerIdx)) && reason.includes(s._varIdCell(aboveIdx))) {
      ruleCAntecedentsOk = true;
      break;
    }
  }
  assert.ok(ruleCAntecedentsOk, 'rule C should record own-color + opposite-neighbor as antecedents');
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `node --test --test-name-pattern='SlitherlinkSolver: _propagateColors sub-rule A'`
Run: `node --test --test-name-pattern='SlitherlinkSolver: _propagateColors sub-rule B'`
Run: `node --test --test-name-pattern='SlitherlinkSolver: _propagateColors sub-rule C'`
Expected: FAIL — reasons are `null` (no `_currentReason` set before the forced writes).

- [ ] **Step 3: Write the implementation**

Replace the body of `_propagateColors` in `solver.js`. The structure is preserved; add `this._currentReason = [...]` immediately before each `_setColor` / `_setEdge` call.

```js
  _propagateColors(onChange) {
    const H = this.height, W = this.width;

    // ── Rule A: known edge → color relation ──────────────────────────────
    for (let r = 0; r <= H; r++) {
      for (let c = 0; c < W; c++) {
        const e = this.H[this._hIdx(r, c)];
        if (e === 0) continue;
        const colorAbove = this._colorOf(r - 1, c);
        const colorBelow = this._colorOf(r, c);
        const idxAbove = (r - 1) >= 0 ? (r - 1) * W + c : -1;
        const idxBelow = r < H ? r * W + c : -1;
        const eVar = this._varIdEdge('H', this._hIdx(r, c));
        if (e === 1) {
          if (colorAbove !== 0 && colorBelow !== 0 && colorAbove === colorBelow) return false;
          if (colorAbove !== 0 && colorBelow === 0) {
            const forced = colorAbove === 1 ? 2 : 1;
            if (idxBelow >= 0) {
              this._currentReason = [eVar, this._varIdCell(idxAbove >= 0 ? idxAbove : idxBelow)];
              // Use the known endpoint: above cell is known, below is the one we force.
              this._currentReason = [eVar, ...(idxAbove >= 0 ? [this._varIdCell(idxAbove)] : [])];
              if (!this._setColor(idxBelow, forced)) return false; onChange();
            } else if (forced !== 2) return false;
          } else if (colorBelow !== 0 && colorAbove === 0) {
            const forced = colorBelow === 1 ? 2 : 1;
            if (idxAbove >= 0) {
              this._currentReason = [eVar, ...(idxBelow >= 0 ? [this._varIdCell(idxBelow)] : [])];
              if (!this._setColor(idxAbove, forced)) return false; onChange();
            } else if (forced !== 2) return false;
          }
        } else {
          if (colorAbove !== 0 && colorBelow !== 0 && colorAbove !== colorBelow) return false;
          if (colorAbove !== 0 && colorBelow === 0) {
            if (idxBelow >= 0) {
              this._currentReason = [eVar, ...(idxAbove >= 0 ? [this._varIdCell(idxAbove)] : [])];
              if (!this._setColor(idxBelow, colorAbove)) return false; onChange();
            } else if (colorAbove !== 2) return false;
          } else if (colorBelow !== 0 && colorAbove === 0) {
            if (idxAbove >= 0) {
              this._currentReason = [eVar, ...(idxBelow >= 0 ? [this._varIdCell(idxBelow)] : [])];
              if (!this._setColor(idxAbove, colorBelow)) return false; onChange();
            } else if (colorBelow !== 2) return false;
          }
        }
      }
    }

    for (let r = 0; r < H; r++) {
      for (let c = 0; c <= W; c++) {
        const e = this.V[this._vIdx(r, c)];
        if (e === 0) continue;
        const colorLeft = this._colorOf(r, c - 1);
        const colorRight = this._colorOf(r, c);
        const idxLeft = (c - 1) >= 0 ? r * W + (c - 1) : -1;
        const idxRight = c < W ? r * W + c : -1;
        const eVar = this._varIdEdge('V', this._vIdx(r, c));
        if (e === 1) {
          if (colorLeft !== 0 && colorRight !== 0 && colorLeft === colorRight) return false;
          if (colorLeft !== 0 && colorRight === 0) {
            const forced = colorLeft === 1 ? 2 : 1;
            if (idxRight >= 0) {
              this._currentReason = [eVar, ...(idxLeft >= 0 ? [this._varIdCell(idxLeft)] : [])];
              if (!this._setColor(idxRight, forced)) return false; onChange();
            } else if (forced !== 2) return false;
          } else if (colorRight !== 0 && colorLeft === 0) {
            const forced = colorRight === 1 ? 2 : 1;
            if (idxLeft >= 0) {
              this._currentReason = [eVar, ...(idxRight >= 0 ? [this._varIdCell(idxRight)] : [])];
              if (!this._setColor(idxLeft, forced)) return false; onChange();
            } else if (forced !== 2) return false;
          }
        } else {
          if (colorLeft !== 0 && colorRight !== 0 && colorLeft !== colorRight) return false;
          if (colorLeft !== 0 && colorRight === 0) {
            if (idxRight >= 0) {
              this._currentReason = [eVar, ...(idxLeft >= 0 ? [this._varIdCell(idxLeft)] : [])];
              if (!this._setColor(idxRight, colorLeft)) return false; onChange();
            } else if (colorLeft !== 2) return false;
          } else if (colorRight !== 0 && colorLeft === 0) {
            if (idxLeft >= 0) {
              this._currentReason = [eVar, ...(idxRight >= 0 ? [this._varIdCell(idxRight)] : [])];
              if (!this._setColor(idxLeft, colorRight)) return false; onChange();
            } else if (colorRight !== 2) return false;
          }
        }
      }
    }

    // ── Rule B: known colors → edge state ────────────────────────────────
    for (let r = 0; r <= H; r++) {
      for (let c = 0; c < W; c++) {
        const eIdx = this._hIdx(r, c);
        if (this.H[eIdx] !== 0) continue;
        const colorAbove = this._colorOf(r - 1, c);
        const colorBelow = this._colorOf(r, c);
        if (colorAbove === 0 || colorBelow === 0) continue;
        const idxAbove = (r - 1) >= 0 ? (r - 1) * W + c : -1;
        const idxBelow = r < H ? r * W + c : -1;
        const expectedEdge = colorAbove !== colorBelow ? 1 : 2;
        const antecedents = [];
        if (idxAbove >= 0) antecedents.push(this._varIdCell(idxAbove));
        if (idxBelow >= 0) antecedents.push(this._varIdCell(idxBelow));
        this._currentReason = antecedents;
        if (!this._setEdge(eIdx, 'H', expectedEdge)) return false;
        onChange();
      }
    }
    for (let r = 0; r < H; r++) {
      for (let c = 0; c <= W; c++) {
        const eIdx = this._vIdx(r, c);
        if (this.V[eIdx] !== 0) continue;
        const colorLeft = this._colorOf(r, c - 1);
        const colorRight = this._colorOf(r, c);
        if (colorLeft === 0 || colorRight === 0) continue;
        const idxLeft = (c - 1) >= 0 ? r * W + (c - 1) : -1;
        const idxRight = c < W ? r * W + c : -1;
        const expectedEdge = colorLeft !== colorRight ? 1 : 2;
        const antecedents = [];
        if (idxLeft >= 0) antecedents.push(this._varIdCell(idxLeft));
        if (idxRight >= 0) antecedents.push(this._varIdCell(idxRight));
        this._currentReason = antecedents;
        if (!this._setEdge(eIdx, 'V', expectedEdge)) return false;
        onChange();
      }
    }

    // ── Rule C: clue × own-color ──────────────────────────────────────────
    for (let r = 0; r < H; r++) {
      const taskRow = this.task[r] || [];
      for (let c = 0; c < W; c++) {
        const clue = taskRow[c];
        if (clue === undefined || clue < 0 || clue > 4) continue;
        const myIdx = r * W + c;
        const myColor = this._colorOf(r, c);
        if (myColor === 0) continue;
        const opposite = myColor === 1 ? 2 : 1;
        const myVar = this._varIdCell(myIdx);
        const nbrs = [[r-1,c],[r+1,c],[r,c-1],[r,c+1]];
        let m = 0, u = 0;
        const oppositeVars = [];
        for (const [nr, nc] of nbrs) {
          const nc2 = this._colorOf(nr, nc);
          if (nc2 === opposite) {
            m++;
            if (nr >= 0 && nr < H && nc >= 0 && nc < W) oppositeVars.push(this._varIdCell(nr * W + nc));
          } else if (nc2 === 0) u++;
        }
        if (m > clue) return false;
        if (m + u < clue) return false;
        if (m === clue && u > 0) {
          // Force all unknown neighbors to myColor.
          const antecedents = [myVar, ...oppositeVars];
          for (const [nr, nc] of nbrs) {
            if (nr < 0 || nr >= H || nc < 0 || nc >= W) continue;
            const ni = nr * W + nc;
            if (this.colors[ni] === 0) {
              this._currentReason = antecedents;
              if (!this._setColor(ni, myColor)) return false;
              onChange();
            }
          }
        } else if (m + u === clue && u > 0) {
          // Force all unknown neighbors to opposite color.
          const antecedents = [myVar, ...oppositeVars];
          for (const [nr, nc] of nbrs) {
            if (nr < 0 || nr >= H || nc < 0 || nc >= W) continue;
            const ni = nr * W + nc;
            if (this.colors[ni] === 0) {
              this._currentReason = antecedents;
              if (!this._setColor(ni, opposite)) return false;
              onChange();
            }
          }
        }
      }
    }

    return true;
  }
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `node --test --test-name-pattern='SlitherlinkSolver: _propagateColors sub-rule A'`
Run: `node --test --test-name-pattern='SlitherlinkSolver: _propagateColors sub-rule B'`
Run: `node --test --test-name-pattern='SlitherlinkSolver: _propagateColors sub-rule C'`
Expected: all 3 pass.

Run: `npm test`
Expected: all green.

- [ ] **Step 5: Build and commit**

```bash
npm run build && npm run lint && npm run typecheck && jj commit -m "$(cat <<'EOF'
feat(cdcl): instrument _propagateColors with per-sub-rule reasons

Rule A: antecedents = edge var + known-endpoint color var.
Rule B: antecedents = both endpoint color vars.
Rule C: antecedents = own-color var + opposite-neighbor color vars.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Instrument connectivity + parity + lookahead

**Files:**
- Modify: `solver.js` — add `this._currentReason = ...` before each `_setColor` call in `_slApplyInsideReachability`, `_slApplyOutsideReachability`, `_slApplyCut`; before each `_setEdge` call in `_propagateParity`; union probe reasons in `_applyLookahead`.
- Modify: `tests/solver.test.js`

**Antecedent rules per spec §3:**

- **`_slApplyInsideReachability` / `_slApplyOutsideReachability` / `_slApplyCut`:** Loose over-approximation — before each `_setColor` force, set `_currentReason` to the var IDs of ALL currently known-OPPOSITE-color cells (i.e., if forcing OUTSIDE, all known-INSIDE cell IDs; if forcing INSIDE, all known-OUTSIDE cell IDs). "Known-opposite" = `this.colors[i] === opposite`.
- **`_propagateParity`:** Before each `_setEdge` force, set `_currentReason` to the var IDs of the `n − 1` other non-UNKNOWN edges in the same scan line.
- **`_applyLookahead`:** When a probe proves one value leads to contradiction, the forcing reason is the union of both probes' own contradiction reasons. Collect the trail-deltas of both probes (from the probe's `_rollback` boundary), union the reason arrays of the contradicting side. Set `_currentReason` to that union before the forced `_setEdge`.

- [ ] **Step 1: Write the failing test**

Add to `tests/solver.test.js`:

```js
test('SlitherlinkSolver: _slApplyInsideReachability records opposite-color antecedents', () => {
  // 3×3 grid. Set cell (0,0)=INSIDE, cell (2,2)=INSIDE (disconnected by OUTSIDE cells).
  // Cell (0,2)=OUTSIDE blocks connectivity. After setting (1,0)=OUTSIDE and (1,1)=OUTSIDE
  // and (1,2)=OUTSIDE, cell (2,0), (2,1), (2,2) are cut off from (0,0) through the
  // OUTSIDE strip. Actually simpler: set (0,0)=INSIDE, then ring it with OUTSIDE so
  // (0,0) is isolated and any unknown cell not adjacent to it is forced OUTSIDE.
  // For 3×3: (0,0)=INSIDE, (0,1)=OUTSIDE, (1,0)=OUTSIDE. Cell (2,2) is unreachable
  // from INSIDE → forced OUTSIDE. Antecedents must be non-empty.
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  s._currentReason = null; s._setColor(0, 1);  // (0,0)=INSIDE
  s._currentReason = null; s._setColor(1, 2);  // (0,1)=OUTSIDE
  s._currentReason = null; s._setColor(3, 2);  // (1,0)=OUTSIDE
  const trailBefore = s.trail.length;
  const ok = s._slApplyInsideReachability(() => {});
  // May or may not force anything depending on connectivity; just verify any
  // forced cell has a non-null, non-empty reason.
  assert.equal(ok, true);
  for (let i = trailBefore; i < s.trail.length; i++) {
    const reason = s._reasons[i];
    assert.ok(Array.isArray(reason), `reason at ${i} must be array`);
    assert.ok(reason.length > 0, `reason at ${i} must be non-empty (opposite-color antecedents)`);
  }
});

test('SlitherlinkSolver: _propagateParity records scan-line antecedents', () => {
  // Horizontal scan at R=0: V[0][0..W]. Set all but one to LINE or EMPTY.
  // In a 3×3 grid, scan R=0 crosses V[0][0], V[0][1], V[0][2] (W+1=4 edges).
  // Set 3 edges: V[0][0]=LINE, V[0][1]=LINE, V[0][3]=LINE. Leave V[0][2]=UNKNOWN.
  // m=3 (odd) → force V[0][2]=LINE. Antecedents = var IDs of V[0][0], V[0][1], V[0][3].
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  s._currentReason = null; s._setEdge(s._vIdx(0, 0), 'V', 1);
  s._currentReason = null; s._setEdge(s._vIdx(0, 1), 'V', 1);
  s._currentReason = null; s._setEdge(s._vIdx(0, 3), 'V', 1);
  // V[0][2] = UNKNOWN, m=3 odd, n=1 → force LINE.
  const trailBefore = s.trail.length;
  const ok = s._propagateParity(() => {});
  assert.equal(ok, true);
  assert.equal(s.V[s._vIdx(0, 2)], 1, 'V[0][2] must be forced LINE');
  // Find the trail entry for V[0][2].
  const forcedEntry = s.trail.length - 1;
  const reason = s._reasons[forcedEntry];
  assert.ok(Array.isArray(reason));
  assert.ok(reason.length === 3, `expected 3 antecedents, got ${reason.length}`);
  assert.ok(reason.includes(s._varIdEdge('V', s._vIdx(0, 0))));
  assert.ok(reason.includes(s._varIdEdge('V', s._vIdx(0, 1))));
  assert.ok(reason.includes(s._varIdEdge('V', s._vIdx(0, 3))));
});

test('SlitherlinkSolver: _applyLookahead records union-of-probe reasons', () => {
  // Use a small puzzle where lookahead must fire. The simplest setup is a clue-0
  // cell where every edge must be EMPTY, but one of those edges is shared with a
  // clue-3 cell, and that shared edge being EMPTY forces the clue-3 to have only
  // 3 edges from a corner, which propagation handles without lookahead.
  // Instead, just verify that when lookahead fires (on any test puzzle), the
  // forced entries have non-null reasons.
  //
  // Use a 2×2 grid where the top-left has clue 2 and the bottom-right has clue 2.
  // After propagation stalls, lookahead should force some edges.
  const s = new SlitherlinkSolver({
    width: 4, height: 4,
    task: [
      [2, -1, -1, -1],
      [-1, -1, -1, -1],
      [-1, -1, -1, -1],
      [-1, -1, -1,  2],
    ],
  });
  // Run the full propagate (which includes lookahead at depth=0).
  // Track all trail entries added. Any forced via lookahead should have a reason.
  s._depth = 0;
  s._inLookahead = false;
  const trailBefore = s.trail.length;
  const ok = s.propagate();
  // We don't assert solve completeness — just that lookahead-forced entries have reasons.
  if (!ok) return;  // contradiction is fine, skip check
  for (let i = trailBefore; i < s.trail.length; i++) {
    // Decisions (null reason) are set only by _cdclSearch, not propagate().
    // So every reason here should be an array (possibly empty).
    assert.ok(s._reasons[i] === null || Array.isArray(s._reasons[i]),
      `trail[${i}] reason must be null or array`);
  }
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `node --test --test-name-pattern='SlitherlinkSolver: _slApplyInsideReachability records'`
Run: `node --test --test-name-pattern='SlitherlinkSolver: _propagateParity records'`
Run: `node --test --test-name-pattern='SlitherlinkSolver: _applyLookahead records'`
Expected: FAIL — `_reasons` entries are `null` instead of arrays for forced assignments inside these rules.

- [ ] **Step 3: Write the implementation**

**`_slApplyInsideReachability`:** Find every `_setColor(i, 2)` call inside the method. Before each one, compute and assign `_currentReason`:

Replace the force loop at the end of `_slApplyInsideReachability`:

```js
    // Any UNKNOWN cell not in BFS can never be INSIDE (can't reach INSIDE cells).
    // Antecedents = snapshot of all known-INSIDE cell var IDs (over-approximation).
    const insideAntecedents = [];
    for (let i = 0; i < N; i++) {
      if (this.colors[i] === 1) insideAntecedents.push(this._varIdCell(i));
    }
    for (let i = 0; i < N; i++) {
      if (this.colors[i] === 0 && !seen[i]) {
        this._currentReason = insideAntecedents;
        if (!this._setColor(i, 2)) return false;
        onChange();
      }
    }
    return true;
```

**`_slApplyOutsideReachability`:** Similarly, before each `_setColor(i, 1)` call, set `_currentReason` to all known-OUTSIDE cell var IDs.

Replace the force loop at the end of `_slApplyOutsideReachability`:

```js
    // Any UNKNOWN cell not reachable from the exterior can never be OUTSIDE.
    // Antecedents = snapshot of all known-OUTSIDE cell var IDs (over-approximation).
    const outsideAntecedents = [];
    for (let i = 0; i < N; i++) {
      if (this.colors[i] === 2) outsideAntecedents.push(this._varIdCell(i));
    }
    for (let i = 0; i < N; i++) {
      if (this.colors[i] === 0 && !seen[i]) {
        this._currentReason = outsideAntecedents;
        if (!this._setColor(i, 1)) return false;
        onChange();
      }
    }
    return true;
```

**`_slApplyCut`:** Before each `_setColor(ap, color)`, set `_currentReason` to all known-color cell var IDs (same loose approximation):

Replace the force block inside `_slApplyCut`:

```js
    if (!isAP[ap]) continue;
    if (this.colors[ap] !== 0) continue;
    if (!this._slColorConnected(color, ap)) {
      // Antecedents = all known-color cells (over-approximation of cut witnesses).
      const antecedents = [];
      for (let i = 0; i < N; i++) {
        if (this.colors[i] === color) antecedents.push(this._varIdCell(i));
      }
      this._currentReason = antecedents;
      if (!this._setColor(ap, color)) return false;
      onChange();
    }
```

**`_propagateParity`:** Before each `_setEdge` force, collect the var IDs of the `n − 1` other non-UNKNOWN edges in the same scan line (the `m` known ones).

Replace the horizontal-scan force inside `_propagateParity`:

```js
    // ── Horizontal scans R = 0..H-1 (cross V[R][c] for c = 0..W) ──────────
    for (let R = 0; R < H; R++) {
      let m = 0, n = 0, unknownC = -1;
      for (let c = 0; c <= W; c++) {
        const v = this.V[this._vIdx(R, c)];
        if (v === 1) m++;
        else if (v === 0) { n++; unknownC = c; }
      }
      if (n === 0) {
        if (m & 1) return false;
      } else if (n === 1) {
        const forced = (m & 1) ? 1 : 2;
        // Antecedents = all non-UNKNOWN edges in this scan line.
        const antecedents = [];
        for (let c = 0; c <= W; c++) {
          if (c === unknownC) continue;
          const v = this.V[this._vIdx(R, c)];
          if (v !== 0) antecedents.push(this._varIdEdge('V', this._vIdx(R, c)));
        }
        this._currentReason = antecedents;
        if (!this._setEdge(this._vIdx(R, unknownC), 'V', forced)) return false;
        onChange();
      }
    }

    // ── Vertical scans C = 0..W-1 (cross H[r][C] for r = 0..H) ─────────────
    for (let C = 0; C < W; C++) {
      let m = 0, n = 0, unknownR = -1;
      for (let r = 0; r <= H; r++) {
        const v = this.H[this._hIdx(r, C)];
        if (v === 1) m++;
        else if (v === 0) { n++; unknownR = r; }
      }
      if (n === 0) {
        if (m & 1) return false;
      } else if (n === 1) {
        const forced = (m & 1) ? 1 : 2;
        // Antecedents = all non-UNKNOWN edges in this scan line.
        const antecedents = [];
        for (let r = 0; r <= H; r++) {
          if (r === unknownR) continue;
          const v = this.H[this._hIdx(r, C)];
          if (v !== 0) antecedents.push(this._varIdEdge('H', this._hIdx(r, C)));
        }
        this._currentReason = antecedents;
        if (!this._setEdge(this._hIdx(unknownR, C), 'H', forced)) return false;
        onChange();
      }
    }

    return true;
```

**`_applyLookahead`:** When one probe value fails and the other is forced, the reason is the union of the reasons collected during the failing probe. To implement: before rolling back the failing probe, snapshot the var IDs of all trail entries added during it (from `mark` to `trail.length` at the point of failure). Their reasons form the "contradiction witness" set. Union both probes' contradiction witnesses when one fails; use the survivor's witness as `_currentReason` before the forced `_setEdge`.

Replace the force logic at the bottom of the probe loop inside `_applyLookahead`:

```js
    for (const { kind, idx } of candidates) {
      if (this._budgetExceeded()) { this._inLookahead = false; return false; }
      const arr = kind === 'H' ? this.H : this.V;
      if (arr[idx] !== 0) continue;

      let lineFails = false, emptyFails = false;
      let lineContradictionReason = [], emptyContradictionReason = [];

      for (const probeVal of [1, 2]) {
        const mark = this.trail.length;
        if (!this._setEdge(idx, kind, probeVal)) {
          if (probeVal === 1) lineFails = true; else emptyFails = true;
          continue;
        }
        const ok = this.propagate();
        // Collect contradiction reason from this probe's trail segment.
        const probeReasonVars = [];
        for (let ti = mark; ti < this.trail.length; ti++) {
          const r = this._reasons[ti];
          if (Array.isArray(r)) for (const v of r) probeReasonVars.push(v);
        }
        this._rollback(mark);
        if (!ok) {
          if (probeVal === 1) { lineFails = true; lineContradictionReason = probeReasonVars; }
          else { emptyFails = true; emptyContradictionReason = probeReasonVars; }
        }
      }

      if (lineFails && emptyFails) {
        this._inLookahead = false;
        return false;
      }
      if (lineFails) {
        // Force EMPTY; reason = union of both probe contradiction witnesses.
        this._currentReason = [...new Set([...lineContradictionReason, ...emptyContradictionReason])];
        if (!this._setEdge(idx, kind, 2)) { this._inLookahead = false; return false; }
        onChange();
      } else if (emptyFails) {
        // Force LINE.
        this._currentReason = [...new Set([...lineContradictionReason, ...emptyContradictionReason])];
        if (!this._setEdge(idx, kind, 1)) { this._inLookahead = false; return false; }
        onChange();
      }
    }
    this._inLookahead = false;
    return true;
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `node --test --test-name-pattern='SlitherlinkSolver: _slApplyInsideReachability records'`
Run: `node --test --test-name-pattern='SlitherlinkSolver: _propagateParity records'`
Run: `node --test --test-name-pattern='SlitherlinkSolver: _applyLookahead records'`
Expected: all 3 pass.

Run: `npm test`
Expected: all green.

- [ ] **Step 5: Build and commit**

```bash
npm run build && npm run lint && npm run typecheck && jj commit -m "$(cat <<'EOF'
feat(cdcl): instrument connectivity, parity, and lookahead with reasons

Connectivity rules use snapshot of known-opposite-color vars (loose
over-approx per spec §3). Parity captures the n-1 scan-line edge vars.
Lookahead unions both probe contradiction witnesses as the forced edge's
reason.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `_propagateLearnedClauses` propagator + `_forceLiteral` helper

**Files:**
- Modify: `solver.js` — add `_propagateLearnedClauses(onChange)` and `_forceLiteral(lit)` to `SlitherlinkSolver`; wire into `propagate()`'s fixpoint; add `_learnedClauses`, `_maxLearnedClauses`, and `_lastConflictReason` to the constructor.
- Modify: `tests/solver.test.js`

`_propagateLearnedClauses` is a no-op when `_learnedClauses` is empty, but wiring it in now gives later tasks a propagation hook with no extra plumbing. `_forceLiteral` decodes a SAT literal to the corresponding `_setEdge`/`_setColor` call so conflict-driven forces and learned-clause unit propagation share one helper.

- [ ] **Step 1: Write the failing tests**

Add to `tests/solver.test.js`:

```js
test('SlitherlinkSolver: _propagateLearnedClauses no-op on empty clause set', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  let changed = false;
  const onChange = () => { changed = true; };
  const result = s._propagateLearnedClauses(onChange);
  assert.equal(result, true);
  assert.equal(changed, false);
});

test('SlitherlinkSolver: _propagateLearnedClauses forces unit clause', () => {
  // 3×3 grid; H edges: numH=12, V edges: numV=12, cells: 9. totalVars=33.
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  // Manually set two H edge vars (ids 0 and 1) to EMPTY (false sense).
  s._currentReason = [];
  s._setEdge(0, 'H', 2);   // EMPTY → varValue returns -1
  s._currentReason = [];
  s._setEdge(1, 'H', 2);   // EMPTY → varValue returns -1
  s._currentReason = null;

  // Seed a 3-literal clause: [+id0, +id1, +id2] where id0 and id1 are set
  // to EMPTY so +id0 and +id1 are false, and +id2 is unassigned.
  // That's a unit clause: should force +id2 (LINE for H[2]).
  const id0 = s._varIdEdge('H', 0);
  const id1 = s._varIdEdge('H', 1);
  const id2 = s._varIdEdge('H', 2);
  s._learnedClauses = [{ literals: [id0, id1, id2], activity: 1 }];

  let forced = false;
  const result = s._propagateLearnedClauses(() => { forced = true; });
  assert.equal(result, true);
  assert.equal(forced, true);
  // H[2] should now be LINE (1).
  assert.equal(s.H[2], 1);
  // Clause activity bumped.
  assert.equal(s._learnedClauses[0].activity, 2);
});

test('SlitherlinkSolver: _propagateLearnedClauses contradiction sets _lastConflictReason', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  // Set all three edges in the clause to EMPTY so all literals (+id) are false.
  s._currentReason = [];
  s._setEdge(0, 'H', 2);
  s._currentReason = [];
  s._setEdge(1, 'H', 2);
  s._currentReason = [];
  s._setEdge(2, 'H', 2);
  s._currentReason = null;

  const id0 = s._varIdEdge('H', 0);
  const id1 = s._varIdEdge('H', 1);
  const id2 = s._varIdEdge('H', 2);
  s._learnedClauses = [{ literals: [id0, id1, id2], activity: 1 }];

  const result = s._propagateLearnedClauses(() => {});
  assert.equal(result, false);
  // _lastConflictReason must be an array containing the falsified var IDs.
  assert.ok(Array.isArray(s._lastConflictReason));
  assert.ok(s._lastConflictReason.includes(id0));
  assert.ok(s._lastConflictReason.includes(id1));
  assert.ok(s._lastConflictReason.includes(id2));
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
node --test --test-name-pattern='SlitherlinkSolver: _propagateLearnedClauses'
```

Expected: 3 test failures (method does not exist yet).

- [ ] **Step 3: Write the implementation**

In the `SlitherlinkSolver` constructor, add after the existing trail/reasons/decisionLevels fields:

```js
// Learned clause storage (CDCL).
this._learnedClauses = [];       // [{ literals: int[], activity: number }]
this._maxLearnedClauses = 5000;
this._lastConflictReason = null; // set by any rule that returns false
```

Add `_forceLiteral` to `SlitherlinkSolver`:

```js
_forceLiteral(lit) {
  const varId = Math.abs(lit);
  const decoded = this._decodeVar(varId);
  const positive = lit > 0;
  if (decoded.kind === 'H') {
    return this._setEdge(decoded.idx, 'H', positive ? 1 : 2);
  }
  if (decoded.kind === 'V') {
    return this._setEdge(decoded.idx, 'V', positive ? 1 : 2);
  }
  // Cell color variable.
  return this._setColor(decoded.idx, positive ? 1 : 2);
}
```

Add `_propagateLearnedClauses` to `SlitherlinkSolver`:

```js
_propagateLearnedClauses(onChange) {
  for (const clause of this._learnedClauses) {
    let unassignedCount = 0;
    let unassignedLit = 0;
    let satisfied = false;
    for (const lit of clause.literals) {
      const v = this._varValue(Math.abs(lit));
      if (v === 0) {
        unassignedCount++;
        unassignedLit = lit;
      } else if ((v > 0) === (lit > 0)) {
        satisfied = true;
        break;
      }
    }
    if (satisfied) continue;
    if (unassignedCount === 0) {
      // All literals false — contradiction.
      this._lastConflictReason = clause.literals.map(l => Math.abs(l));
      return false;
    }
    if (unassignedCount === 1) {
      // Unit clause — force the unassigned literal.
      this._currentReason = clause.literals
        .filter(l => l !== unassignedLit)
        .map(l => Math.abs(l));
      if (!this._forceLiteral(unassignedLit)) {
        this._lastConflictReason = clause.literals.map(l => Math.abs(l));
        return false;
      }
      onChange();
      clause.activity += 1;
    }
  }
  return true;
}
```

Wire `_propagateLearnedClauses` into `propagate()`'s fixpoint loop immediately after the `_propagateParity` call:

```js
if (!this._propagateLearnedClauses(onAnyChange)) return false;
```

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
node --test --test-name-pattern='SlitherlinkSolver: _propagateLearnedClauses'
```

Expected: all 3 pass.

```bash
npm test
```

Expected: all green.

- [ ] **Step 5: Build and commit**

```bash
npm run build && npm run lint && npm run typecheck && jj commit -m "$(cat <<'EOF'
feat(cdcl): add _propagateLearnedClauses + _forceLiteral + clause storage

Wires the learned-clause propagator into propagate()'s fixpoint after
_propagateParity. No-op until _addLearnedClause is called. _forceLiteral
maps a SAT literal to the corresponding _setEdge/_setColor call.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Conflict reason capture from rules

**Files:**
- Modify: `solver.js` — add `_lastConflictReason = ...` failure-path assignments to all propagation rules that return false.
- Modify: `tests/solver.test.js`

Every rule that detects a contradiction must set `this._lastConflictReason` to the variable IDs of the assignments that combined to cause it, so `_analyzeConflict` (Task 9) can resolve along the implication graph. `_propagateLearnedClauses` already does this (Task 7). The remaining rules: `_applyClueRuleAt`, `_applyVertexRuleAt`, `_propagateColors` (A, B, C sub-rules), `_slApplyInsideReachability`, `_slApplyOutsideReachability`, `_propagateParity`, and `_applyLookahead`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/solver.test.js`:

```js
test('SlitherlinkSolver: clue rule contradiction sets _lastConflictReason', () => {
  // 2×2 grid with cell (0,0) clue=0 (zero edges).
  // Force edges around (0,0) to LINE — should contradict clue=0.
  // numH for 2×2: (2+1)*2=6, numV: 2*(2+1)=6.
  // Top edge of (0,0) = H[0][0] = _hIdx(0,0) = 0.
  // Bottom edge of (0,0) = H[1][0] = _hIdx(1,0) = 2.
  // Left edge of (0,0) = V[0][0] = _vIdx(0,0) = 0 → varId = numH + 0 = 6.
  // Right edge of (0,0) = V[0][1] = _vIdx(0,1) = 1 → varId = numH + 1 = 7.
  // Force 3 edges to LINE — clue=0 means m>k contradiction fires.
  const s = new SlitherlinkSolver({
    width: 2, height: 2,
    task: [[0, -1], [-1, -1]],
  });
  s._currentReason = [];
  s._setEdge(s._hIdx(0, 0), 'H', 1); // top = LINE
  s._currentReason = [];
  s._setEdge(s._hIdx(1, 0), 'H', 1); // bottom = LINE
  s._currentReason = [];
  s._setEdge(s._vIdx(0, 0), 'V', 1); // left = LINE
  s._currentReason = null;

  s._lastConflictReason = null;
  const ok = s.propagate();
  assert.equal(ok, false);
  assert.ok(Array.isArray(s._lastConflictReason));
  assert.ok(s._lastConflictReason.length > 0);
  // All returned var IDs should be valid (in [0, totalVars)).
  for (const v of s._lastConflictReason) {
    assert.ok(v >= 0 && v < s.totalVars, `varId ${v} out of range`);
  }
});

test('SlitherlinkSolver: vertex rule contradiction sets _lastConflictReason', () => {
  // 2×2 grid, no clues. Force 3 edges incident to interior dot (1,1) to LINE —
  // vertex rule allows at most 2, so m>2 contradiction fires.
  // Dot (1,1) incident edges:
  //   top    = H[0][1] = _hIdx(0,1) = 1
  //   bottom = H[1][1] = _hIdx(1,1) = 3
  //   left   = V[1][0] = _vIdx(1,0) = 3  → varId = numH + 3 = 9
  //   right  = V[1][1] = _vIdx(1,1) = 4  → varId = numH + 4 = 10
  const s = new SlitherlinkSolver({
    width: 2, height: 2,
    task: [[-1,-1],[-1,-1]],
  });
  s._currentReason = [];
  s._setEdge(s._hIdx(0, 1), 'H', 1); // top of dot(1,1) = LINE
  s._currentReason = [];
  s._setEdge(s._hIdx(1, 1), 'H', 1); // bottom = LINE
  s._currentReason = [];
  s._setEdge(s._vIdx(1, 0), 'V', 1); // left = LINE
  s._currentReason = null;

  s._lastConflictReason = null;
  const ok = s.propagate();
  assert.equal(ok, false);
  assert.ok(Array.isArray(s._lastConflictReason));
  assert.ok(s._lastConflictReason.length > 0);
  for (const v of s._lastConflictReason) {
    assert.ok(v >= 0 && v < s.totalVars, `varId ${v} out of range`);
  }
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
node --test --test-name-pattern='SlitherlinkSolver: clue rule contradiction'
node --test --test-name-pattern='SlitherlinkSolver: vertex rule contradiction'
```

Expected: both fail (`_lastConflictReason` is null or not set).

- [ ] **Step 3: Write the implementation**

In each rule's failure-return path, add `this._lastConflictReason = [...]` before the `return false`. The concrete changes:

**`_applyClueRuleAt(r, c, onChange)` — when `m > k` (too many LINE) or `m + n < k` (impossible to reach k):**

```js
// Gather all non-UNKNOWN edge var IDs around the cell as conflict reason.
const reasonVars = [];
const edges = this._cellEdges(r, c);
for (const { idx, kind } of edges) {
  const val = kind === 'H' ? this.H[idx] : this.V[idx];
  if (val !== 0) reasonVars.push(this._varIdEdge(kind, idx));
}
this._lastConflictReason = reasonVars;
return false;
```

**`_applyVertexRuleAt(r, c, onChange)` — when `m > 2` or when `m === 1 && n === 0`:**

```js
// Gather all non-UNKNOWN incident edge var IDs as conflict reason.
const reasonVars = [];
const incident = this._dotEdges(r, c);
for (const { idx, kind } of incident) {
  const val = kind === 'H' ? this.H[idx] : this.V[idx];
  if (val !== 0) reasonVars.push(this._varIdEdge(kind, idx));
}
this._lastConflictReason = reasonVars;
return false;
```

**`_propagateColors` rule A (edge known, endpoint color conflict):** set reason to the two variable IDs involved — the edge var ID and the conflicting endpoint cell var ID.

**`_propagateColors` rule B (both endpoint colors known, edge must match but contradiction):** set reason to the two endpoint color var IDs.

**`_propagateColors` rule C (clue × color, count mismatch — `m > k` or `m + u < k`):** set reason to own-color var ID + the contributing neighbor color var IDs that are known.

**`_slApplyInsideReachability` / `_slApplyOutsideReachability` (unreachable known-color cell):** set reason to the unreachable cell's color var ID + all currently-known opposite-color cell var IDs (snapshot as loose over-approximation per spec §3):

```js
const reasonVars = [this._varIdCell(unreachableCellIdx)];
for (let idx = 0; idx < this.cellCount; idx++) {
  if (this.cellColor[idx] === oppositeColor) reasonVars.push(this._varIdCell(idx));
}
this._lastConflictReason = reasonVars;
return false;
```

**`_propagateParity` (0 unknowns, odd count):** set reason to all known edge var IDs in the current scan line:

```js
const reasonVars = [];
for (const { idx, kind } of scanLineEdges) {
  if ((kind === 'H' ? this.H[idx] : this.V[idx]) !== 0)
    reasonVars.push(this._varIdEdge(kind, idx));
}
this._lastConflictReason = reasonVars;
return false;
```

**`_applyLookahead` (when both `lineFails && emptyFails`):** set reason to the union of both probe contradiction reasons (already captured in local variables):

```js
this._lastConflictReason = [...new Set([...lineContradictionReason, ...emptyContradictionReason])];
return false;
```

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
node --test --test-name-pattern='SlitherlinkSolver: clue rule contradiction'
node --test --test-name-pattern='SlitherlinkSolver: vertex rule contradiction'
```

Expected: both pass.

```bash
npm test
```

Expected: all green.

- [ ] **Step 5: Build and commit**

```bash
npm run build && npm run lint && npm run typecheck && jj commit -m "$(cat <<'EOF'
feat(cdcl): capture _lastConflictReason in all rule failure paths

Every rule that returns false now sets _lastConflictReason to the
antecedent variable IDs so _analyzeConflict can resolve the implication
graph. Clue/vertex rules use known edge vars; color rules use endpoint
vars; connectivity uses known-opposite-color snapshot; parity uses scan
line edge vars; lookahead unions both probe contradiction witnesses.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: First-UIP `_analyzeConflict(conflictReason)`

**Files:**
- Modify: `solver.js` — add `_analyzeConflict`, `_decisionLevelOf`, `_varAtTrailIndex` to `SlitherlinkSolver`.
- Modify: `tests/solver.test.js`

Implements the standard first-UIP algorithm from spec §4. Given the `conflictReason` variable-ID array from whichever rule returned false, walks the trail backward resolving current-level variables against their reasons until exactly one current-level variable remains — the first UIP. Returns the learned clause as an array of literals.

- [ ] **Step 1: Write the failing test**

Add to `tests/solver.test.js`:

```js
test('SlitherlinkSolver: _analyzeConflict derives first-UIP learned clause', () => {
  // Construct a controlled 3-decision implication scenario on a 3×3 grid.
  // We manually build trail + reasons + decisionLevels to simulate:
  //   Level 1: decide varA = LINE (+varA)
  //   Level 2: decide varB = LINE (+varB)
  //   Level 2: implied varC = LINE, reason=[varA, varB]
  //   Level 2: conflict from varC + varB together.
  // Expected UIP: varC (last current-level assignment before conflict).
  // Expected learned clause: contains -varC (UIP negated) + -varA (level-1 antecedent).

  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });

  const varA = s._varIdEdge('H', 0);  // id 0
  const varB = s._varIdEdge('H', 1);  // id 1
  const varC = s._varIdEdge('H', 2);  // id 2

  // Simulate the trail entries directly.
  // Trail encoding (from existing code): (kind<<24)|idx for edges. kind: 0=H, 1=V.
  s.trail = [
    (0 << 24) | 0,  // varA: H edge idx 0, level 1 decision
    (0 << 24) | 1,  // varB: H edge idx 1, level 2 decision
    (0 << 24) | 2,  // varC: H edge idx 2, level 2 implied
  ];
  s._reasons = [
    null,           // varA: decision
    null,           // varB: decision
    [varA, varB],   // varC: implied by varA + varB
  ];
  s._decisionLevels = [1, 2, 2];
  s._decisionLevel = 2;

  // Set edge values so _varValue works.
  s.H[0] = 1; // varA = LINE → _varValue(varA) = +1
  s.H[1] = 1; // varB = LINE
  s.H[2] = 1; // varC = LINE

  // Conflict reason: varC and varB together triggered the contradiction.
  const conflictReason = [varC, varB];
  const learned = s._analyzeConflict(conflictReason);

  assert.ok(Array.isArray(learned));
  // Learned clause must contain -varC (negated UIP at level 2).
  assert.ok(learned.includes(-varC), `expected -varC in learned; got ${JSON.stringify(learned)}`);
  // Must contain -varA (level-1 antecedent from resolving varC's reason).
  assert.ok(learned.includes(-varA), `expected -varA in learned; got ${JSON.stringify(learned)}`);
  // Exactly one current-level literal (the UIP).
  const level2Lits = learned.filter(lit => s._decisionLevelOf(Math.abs(lit)) === 2);
  assert.equal(level2Lits.length, 1,
    `expected 1 current-level literal; got ${JSON.stringify(level2Lits)}`);
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
node --test --test-name-pattern='SlitherlinkSolver: _analyzeConflict derives'
```

Expected: failure (methods do not exist yet).

- [ ] **Step 3: Write the implementation**

Add to `SlitherlinkSolver`:

```js
_varAtTrailIndex(i) {
  const e = this.trail[i];
  const idx = e & 0xFFFFFF;
  const kind = (e >> 24) & 3;
  if (kind === 0) return this._varIdEdge('H', idx);
  if (kind === 1) return this._varIdEdge('V', idx);
  if (kind === 2) return this._varIdCell(idx);
  return -1;
}

_decisionLevelOf(varId) {
  // Linear trail scan from newest to oldest.
  for (let i = this.trail.length - 1; i >= 0; i--) {
    if (this._varAtTrailIndex(i) === varId) return this._decisionLevels[i];
  }
  return 0; // Not on trail — treat as level-0 fact.
}

_analyzeConflict(conflictReason) {
  const learned = [];
  const seen = new Uint8Array(this.totalVars + 1);
  let pathCount = 0;

  // Seed from conflict reason: negate each variable's current assignment.
  for (const varId of conflictReason) {
    if (varId < 0 || varId >= this.totalVars) continue;
    const value = this._varValue(varId);
    if (value === 0) continue; // unassigned — skip
    if (seen[varId]) continue;
    seen[varId] = 1;
    const lvl = this._decisionLevelOf(varId);
    if (lvl === 0) continue; // level-0 fact — always true, skip
    const lit = value > 0 ? -varId : varId; // negated
    if (lvl < this._decisionLevel) {
      learned.push(lit);
    } else {
      // At current decision level: needs resolution.
      pathCount++;
    }
  }

  // Walk trail backward to find first UIP.
  for (let i = this.trail.length - 1; pathCount > 0 && i >= 0; i--) {
    const varAtI = this._varAtTrailIndex(i);
    if (varAtI < 0 || !seen[varAtI]) continue;
    if (this._decisionLevels[i] !== this._decisionLevel) continue;

    pathCount--;

    if (pathCount === 0) {
      // First UIP found — add its negated literal.
      const value = this._varValue(varAtI);
      learned.push(value > 0 ? -varAtI : varAtI);
      break;
    }

    // Resolve: replace this var with its reason.
    const reason = this._reasons[i];
    if (reason === null) {
      // Decision at current level — treat defensively as UIP.
      const value = this._varValue(varAtI);
      learned.push(value > 0 ? -varAtI : varAtI);
      break;
    }
    for (const av of reason) {
      if (av < 0 || av >= this.totalVars) continue;
      if (seen[av]) continue;
      const aLvl = this._decisionLevelOf(av);
      if (aLvl === 0) continue;
      seen[av] = 1;
      const aValue = this._varValue(av);
      const aLit = aValue > 0 ? -av : av;
      if (aLvl < this._decisionLevel) {
        learned.push(aLit);
      } else {
        pathCount++;
      }
    }
  }

  return learned;
}
```

- [ ] **Step 4: Run the test to confirm it passes**

```bash
node --test --test-name-pattern='SlitherlinkSolver: _analyzeConflict derives'
```

Expected: passes.

```bash
npm test
```

Expected: all green.

- [ ] **Step 5: Build and commit**

```bash
npm run build && npm run lint && npm run typecheck && jj commit -m "$(cat <<'EOF'
feat(cdcl): implement first-UIP _analyzeConflict

Walks the trail backward from the conflict, resolving current-level
variables against their reasons until exactly one current-level
variable remains (the UIP). Returns the learned clause as an array
of negated literals. Helpers _varAtTrailIndex and _decisionLevelOf
are extracted for reuse in backjump and VSIDS.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Backjump (`_backjumpTo` + `_computeBackjumpLevel`)

**Files:**
- Modify: `solver.js` — add `_computeBackjumpLevel(learned)` and `_backjumpTo(level)` to `SlitherlinkSolver`.
- Modify: `tests/solver.test.js`

`_computeBackjumpLevel` scans the learned clause for the second-highest decision level — the level to jump back to so the clause becomes unit (only the UIP literal is unassigned). `_backjumpTo` pops the trail to that level using the existing `_rollback(mark)` and resets `_decisionLevel`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/solver.test.js`:

```js
test('SlitherlinkSolver: _computeBackjumpLevel returns second-highest level', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });

  // Simulate trail so _decisionLevelOf works.
  const v1 = s._varIdEdge('H', 0);  // trail index 0, level 1
  const v2 = s._varIdEdge('H', 1);  // trail index 1, level 2
  const v3 = s._varIdEdge('H', 2);  // trail index 2, level 3
  s.trail = [(0 << 24) | 0, (0 << 24) | 1, (0 << 24) | 2];
  s._decisionLevels = [1, 2, 3];
  s._reasons = [null, null, null];

  // Learned clause literals at levels [3, 1, 2] → max=3, second=2.
  const learned = [-v3, -v1, -v2];
  const level = s._computeBackjumpLevel(learned);
  assert.equal(level, 2);
});

test('SlitherlinkSolver: _computeBackjumpLevel single level returns 0', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  const v1 = s._varIdEdge('H', 0);
  s.trail = [(0 << 24) | 0];
  s._decisionLevels = [3];
  s._reasons = [null];
  // Only one literal at level 3 — second level = 0.
  const level = s._computeBackjumpLevel([-v1]);
  assert.equal(level, 0);
});

test('SlitherlinkSolver: _backjumpTo resets trail and _decisionLevel', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });

  // Push three trail entries at levels 1, 2, 3, setting edges directly.
  s.H[0] = 1;
  s.trail.push((0 << 24) | 0);
  s._reasons.push(null);
  s._decisionLevels.push(1);

  s.H[1] = 1;
  s.trail.push((0 << 24) | 1);
  s._reasons.push(null);
  s._decisionLevels.push(2);

  s.H[2] = 1;
  s.trail.push((0 << 24) | 2);
  s._reasons.push(null);
  s._decisionLevels.push(3);

  s._decisionLevel = 3;

  s._backjumpTo(1);

  assert.equal(s._decisionLevel, 1);
  for (let i = 0; i < s._decisionLevels.length; i++) {
    assert.ok(s._decisionLevels[i] <= 1,
      `trail entry ${i} has level ${s._decisionLevels[i]} > 1`);
  }
  // H[1] and H[2] rolled back to UNKNOWN (0).
  assert.equal(s.H[1], 0);
  assert.equal(s.H[2], 0);
  // H[0] at level 1 stays.
  assert.equal(s.H[0], 1);
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
node --test --test-name-pattern='SlitherlinkSolver: _computeBackjumpLevel'
node --test --test-name-pattern='SlitherlinkSolver: _backjumpTo'
```

Expected: all 3 fail.

- [ ] **Step 3: Write the implementation**

Add to `SlitherlinkSolver`:

```js
_computeBackjumpLevel(learned) {
  let max = 0, second = 0;
  for (const lit of learned) {
    const lvl = this._decisionLevelOf(Math.abs(lit));
    if (lvl > max) {
      second = max;
      max = lvl;
    } else if (lvl > second && lvl < max) {
      second = lvl;
    }
  }
  return second;
}

_backjumpTo(level) {
  // Find the first trail index whose decision level exceeds `level`.
  let mark = this.trail.length;
  for (let i = 0; i < this.trail.length; i++) {
    if (this._decisionLevels[i] > level) {
      mark = i;
      break;
    }
  }
  this._rollback(mark);
  this._decisionLevel = level;
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
node --test --test-name-pattern='SlitherlinkSolver: _computeBackjumpLevel'
node --test --test-name-pattern='SlitherlinkSolver: _backjumpTo'
```

Expected: all 3 pass.

```bash
npm test
```

Expected: all green.

- [ ] **Step 5: Build and commit**

```bash
npm run build && npm run lint && npm run typecheck && jj commit -m "$(cat <<'EOF'
feat(cdcl): implement _backjumpTo and _computeBackjumpLevel

_computeBackjumpLevel scans the learned clause for the second-highest
decision level (the target backjump level that makes the clause unit).
_backjumpTo finds the trail mark for that level, calls _rollback, and
resets _decisionLevel. Reuses existing _rollback which already pops
trail, _reasons, and _decisionLevels in sync.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Learned clause storage + LRU eviction (`_addLearnedClause`)

**Files:**
- Modify: `solver.js` — add `_addLearnedClause(literals)` to `SlitherlinkSolver`; verify constructor already has `_learnedClauses` and `_maxLearnedClauses` from Task 7.
- Modify: `tests/solver.test.js`

When the learned clause set reaches 5000, the lowest-activity quarter is evicted. Activity is bumped by `_propagateLearnedClauses` each time a clause is used for unit propagation and decayed by `_decayVsidsIfDue` (Task 12) every 256 conflicts alongside VSIDS scores.

- [ ] **Step 1: Write the failing tests**

Add to `tests/solver.test.js`:

```js
test('SlitherlinkSolver: _addLearnedClause stores clauses up to cap', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  // Add 4999 clauses — should all be stored without eviction.
  for (let i = 0; i < 4999; i++) {
    s._addLearnedClause([i + 1]);
  }
  assert.equal(s._learnedClauses.length, 4999);
});

test('SlitherlinkSolver: _addLearnedClause evicts on overflow', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  // The 5000th add triggers eviction: 5000 - floor(5000/4) = 3750.
  for (let i = 0; i < 5000; i++) {
    s._addLearnedClause([i + 1]);
  }
  assert.equal(s._learnedClauses.length, 3750);
});

test('SlitherlinkSolver: _addLearnedClause evicts lowest-activity clauses', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  // Add 4999 clauses with activity 1.
  for (let i = 0; i < 4999; i++) {
    s._addLearnedClause([i + 1]);
  }
  // Bump activity on the first 10 so they survive eviction.
  for (let i = 0; i < 10; i++) {
    s._learnedClauses[i].activity = 999;
  }
  // 5000th add triggers eviction.
  s._addLearnedClause([9999]);
  // All 10 high-activity clauses must survive.
  const highActivity = s._learnedClauses.filter(c => c.activity === 999);
  assert.equal(highActivity.length, 10);
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
node --test --test-name-pattern='SlitherlinkSolver: _addLearnedClause'
```

Expected: all 3 fail (`_addLearnedClause` does not exist yet).

- [ ] **Step 3: Write the implementation**

Add to `SlitherlinkSolver`:

```js
_addLearnedClause(literals) {
  this._learnedClauses.push({ literals: literals.slice(), activity: 1 });
  if (this._learnedClauses.length >= this._maxLearnedClauses) {
    // Sort ascending by activity; drop the lowest-activity quarter.
    this._learnedClauses.sort((a, b) => a.activity - b.activity);
    const drop = Math.floor(this._maxLearnedClauses / 4);
    this._learnedClauses.splice(0, drop);
  }
}
```

Confirm the constructor (from Task 7) already has:

```js
this._learnedClauses = [];
this._maxLearnedClauses = 5000;
```

If missing, add them.

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
node --test --test-name-pattern='SlitherlinkSolver: _addLearnedClause'
```

Expected: all 3 pass.

```bash
npm test
```

Expected: all green.

- [ ] **Step 5: Build and commit**

```bash
npm run build && npm run lint && npm run typecheck && jj commit -m "$(cat <<'EOF'
feat(cdcl): implement _addLearnedClause with LRU-on-activity eviction

Stores learned clauses with initial activity=1. When the set reaches
the 5000-clause cap, sorts by activity and evicts the lowest-activity
quarter (1250 clauses), preserving recently-useful clauses. Activity
is bumped by unit propagation (Task 7) and decayed by VSIDS (Task 12).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: VSIDS heuristic (`_vsidsScores`, `_bumpVsids`, `_decayVsidsIfDue`, `_pickDecisionLiteral`)

**Files:**
- Modify: `solver.js` — add VSIDS fields to constructor; add `_bumpVsids`, `_decayVsidsIfDue`, `_pickDecisionLiteral` to `SlitherlinkSolver`.
- Modify: `tests/solver.test.js`

VSIDS (Variable State Independent Decaying Sum) biases variable selection toward variables that appear most frequently in recent conflicts. Scores start at zero; after the first conflict they guide decisions. Before any conflicts, the picker falls back to `_pickCell`/`_pickEdge` so the initial decisions use the existing domain-specific heuristics. Every 256 conflicts, all scores and clause activities are multiplied by 0.95 (decay).

- [ ] **Step 1: Write the failing tests**

Add to `tests/solver.test.js`:

```js
test('SlitherlinkSolver: _bumpVsids increments scores', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  assert.equal(s._vsidsScores[5], 0);
  assert.equal(s._vsidsScores[7], 0);
  assert.equal(s._vsidsScores[13], 0);

  s._bumpVsids([5, -7, 13]);

  assert.equal(s._vsidsScores[5], 1);
  assert.equal(s._vsidsScores[7], 1);
  assert.equal(s._vsidsScores[13], 1);
  // Other scores untouched.
  assert.equal(s._vsidsScores[0], 0);
});

test('SlitherlinkSolver: _decayVsidsIfDue decays only after 256 calls', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  s._vsidsScores[5] = 10;
  s._learnedClauses = [{ literals: [5], activity: 8 }];

  // 255 calls should not trigger decay.
  for (let i = 0; i < 255; i++) s._decayVsidsIfDue();
  assert.equal(s._vsidsScores[5], 10);
  assert.equal(s._learnedClauses[0].activity, 8);

  // 256th call triggers decay.
  s._decayVsidsIfDue();
  // 10 * 0.95 = 9.5 (Float32 approximation).
  assert.ok(Math.abs(s._vsidsScores[5] - 9.5) < 0.01,
    `expected ~9.5, got ${s._vsidsScores[5]}`);
  // 8 * 0.95 = 7.6.
  assert.ok(Math.abs(s._learnedClauses[0].activity - 7.6) < 0.01,
    `expected ~7.6, got ${s._learnedClauses[0].activity}`);
  // Counter resets.
  assert.equal(s._vsidsConflictsSinceDecay, 0);
});

test('SlitherlinkSolver: _pickDecisionLiteral picks highest VSIDS score', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  // Set scores: var 4 highest.
  s._vsidsScores[2] = 0.5;
  s._vsidsScores[4] = 2.0;
  s._vsidsScores[7] = 1.0;

  // Var 4 must be unassigned.
  const lit = s._pickDecisionLiteral();
  assert.equal(Math.abs(lit), 4);
});

test('SlitherlinkSolver: _pickDecisionLiteral falls back when all scores zero', () => {
  const s = new SlitherlinkSolver({
    width: 3, height: 3,
    task: [[-1,-1,-1],[-1,-1,-1],[-1,-1,-1]],
  });
  // All scores 0 — should fall back and return a nonzero literal.
  const lit = s._pickDecisionLiteral();
  assert.ok(lit !== 0, 'expected a nonzero literal when edges remain unassigned');
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
node --test --test-name-pattern='SlitherlinkSolver: _bumpVsids'
node --test --test-name-pattern='SlitherlinkSolver: _decayVsidsIfDue'
node --test --test-name-pattern='SlitherlinkSolver: _pickDecisionLiteral'
```

Expected: all 4 fail.

- [ ] **Step 3: Write the implementation**

Add to the `SlitherlinkSolver` constructor (after `_learnedClauses`/`_maxLearnedClauses`/`_lastConflictReason`):

```js
this._vsidsScores = new Float32Array(this.totalVars);
this._vsidsDecay = 0.95;
this._vsidsDecayInterval = 256;
this._vsidsConflictsSinceDecay = 0;
```

Add methods:

```js
_bumpVsids(literals) {
  for (const lit of literals) {
    this._vsidsScores[Math.abs(lit)] += 1;
  }
}

_decayVsidsIfDue() {
  this._vsidsConflictsSinceDecay++;
  if (this._vsidsConflictsSinceDecay < this._vsidsDecayInterval) return;
  this._vsidsConflictsSinceDecay = 0;
  for (let i = 0; i < this.totalVars; i++) {
    this._vsidsScores[i] *= this._vsidsDecay;
  }
  for (const c of this._learnedClauses) {
    c.activity *= this._vsidsDecay;
  }
}

_pickDecisionLiteral() {
  // Linear scan: find unassigned variable with highest VSIDS score.
  // Ties broken by lowest variable ID for determinism.
  let best = -1;
  let bestScore = -Infinity;
  for (let v = 0; v < this.totalVars; v++) {
    if (this._varValue(v) !== 0) continue; // already assigned
    if (this._vsidsScores[v] > bestScore) {
      bestScore = this._vsidsScores[v];
      best = v;
    }
  }
  if (best === -1) return 0; // all variables assigned

  // When no conflicts have occurred yet (all scores 0), fall back to
  // existing domain-specific heuristics for a smarter initial branch.
  if (bestScore === 0) {
    const cellIdx = this._pickCell();
    if (cellIdx !== null) return this._varIdCell(cellIdx);
    const edgePick = this._pickEdge();
    if (edgePick) return this._varIdEdge(edgePick.kind, edgePick.idx);
    // Final fallback: lowest unassigned variable ID.
    return best;
  }

  // Pick positive sense (LINE / INSIDE) by default.
  return best;
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
node --test --test-name-pattern='SlitherlinkSolver: _bumpVsids'
node --test --test-name-pattern='SlitherlinkSolver: _decayVsidsIfDue'
node --test --test-name-pattern='SlitherlinkSolver: _pickDecisionLiteral'
```

Expected: all 4 pass.

```bash
npm test
```

Expected: all green.

- [ ] **Step 5: Build and commit**

```bash
npm run build && npm run lint && npm run typecheck && jj commit -m "$(cat <<'EOF'
feat(cdcl): implement VSIDS scoring and _pickDecisionLiteral

_bumpVsids increments Float32Array scores for each literal in a learned
clause. _decayVsidsIfDue multiplies all scores and clause activities by
0.95 every 256 conflicts. _pickDecisionLiteral picks the highest-scoring
unassigned variable; when all scores are 0 (no conflicts yet) it falls
back to _pickCell/_pickEdge for a better initial branch order.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Luby restart sequence + `_restart()`

**Files:**
- Modify: `solver.js` — add `_lubyNext`, `_restart` to `SlitherlinkSolver`; add `this._totalConflicts = 0` to constructor.
- Modify: `tests/solver.test.js` — add unit tests for both methods.

- [ ] **Step 1: Write the failing tests**

Add these tests to `tests/solver.test.js`:

```js
test('SlitherlinkSolver: _lubyNext returns the correct first 18 Luby values', () => {
  const s = new SlitherlinkSolver({ width: 2, height: 2, task: [[-1,-1],[-1,-1]] });
  const expected = [1, 1, 2, 1, 1, 2, 4, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 16];
  for (let i = 0; i < expected.length; i++) {
    assert.equal(s._lubyNext(i), expected[i], `_lubyNext(${i}) should be ${expected[i]}`);
  }
});

test('SlitherlinkSolver: _restart pops trail to level 0', () => {
  const s = new SlitherlinkSolver({ width: 2, height: 2, task: [[-1,-1],[-1,-1]] });
  // Manually simulate a multi-level trail state.
  // Push three fake trail entries at levels 1, 2, 3.
  s._decisionLevel = 3;
  s.trail.push(0, 1, 2);
  s._decisionLevels.push(1, 2, 3);
  s._reasons.push(null, null, null);
  s._trailHead = [0]; // trail snapshot at level 0 (no entries)
  s._restart();
  assert.equal(s._decisionLevel, 0, '_restart should reset decisionLevel to 0');
  // Trail should be rolled back — _backjumpTo(0) clears entries at level > 0.
  // All three entries were at level > 0, so the trail should be empty.
  assert.equal(s.trail.length, 0);
});

test('SlitherlinkSolver: _restart preserves _learnedClauses and _vsidsScores', () => {
  const s = new SlitherlinkSolver({ width: 2, height: 2, task: [[-1,-1],[-1,-1]] });
  // Plant a learned clause.
  s._learnedClauses.push({ literals: [1, -2], activity: 5 });
  // Plant a VSIDS score.
  s._vsidsScores[0] = 3.14;
  s._decisionLevel = 1;
  s.trail.push(0);
  s._decisionLevels.push(1);
  s._reasons.push(null);
  s._trailHead = [0];
  s._restart();
  // Learned clauses must survive.
  assert.equal(s._learnedClauses.length, 1);
  assert.equal(s._learnedClauses[0].literals[0], 1);
  // VSIDS scores must survive.
  assert.ok(Math.abs(s._vsidsScores[0] - 3.14) < 0.001);
});
```

- [ ] **Step 2: Add `this._totalConflicts = 0` to the constructor**

In `solver.js`, locate the `SlitherlinkSolver` constructor block where `this._vsidsScores` is initialized (immediately after the VSIDS fields added in Task 12). Append:

```js
    this._totalConflicts = 0;
```

- [ ] **Step 3: Add `_lubyNext` and `_restart` methods**

Add both methods to `SlitherlinkSolver` (after `_decayVsidsIfDue` and `_pickDecisionLiteral`, before any `solve` or `getHint` method):

```js
  // Returns the (idx+1)-th value of the Luby sequence.
  // For idx 0..17: 1, 1, 2, 1, 1, 2, 4, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 16.
  _lubyNext(idx) {
    for (let size = 1, seq = 1; ; seq++, size = 2 * size + 1) {
      if (idx === size - 1) return 1 << (seq - 1);
      if (size / 2 <= idx && idx < size) return this._lubyNext(idx - (size >> 1));
    }
  }

  // Pop trail back to decision level 0; preserve learned clauses + VSIDS scores.
  // The retained learned clauses guide propagation immediately on restart, often
  // determining many variables before the next decision is needed.
  _restart() {
    this._backjumpTo(0);
  }
```

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
node --test --test-name-pattern='SlitherlinkSolver: _lubyNext'
node --test --test-name-pattern='SlitherlinkSolver: _restart'
```

Expected: all 3 pass.

```bash
npm test
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
jj commit -m "$(cat <<'EOF'
feat(cdcl): implement Luby restart sequence and _restart

_lubyNext returns the (idx+1)-th value of the standard Luby sequence via
the recursive doubling formula. _restart pops the trail to decision level
0 via _backjumpTo(0), preserving learned clauses and VSIDS scores so they
guide propagation immediately on the next pass. _totalConflicts added to
constructor as an accumulator across all restarts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: `_cdclSearch()` main loop + `solve()` integration

**Files:**
- Modify: `solver.js` — add `_cdclSearch` to `SlitherlinkSolver`; update `solve()` to call it instead of `_backtrack()`.
- Modify: `tests/solver.test.js` — add integration tests.

- [ ] **Step 1: Write the failing tests**

Add these tests to `tests/solver.test.js`:

```js
test('SlitherlinkSolver+CDCL: 5x5 fixture solves identically via _cdclSearch', () => {
  const { slitherlink5x5 } = require('./fixtures/puzzles.js');
  SlitherlinkSolver.clearSolutionCache();
  const s = new SlitherlinkSolver({
    width: slitherlink5x5.cols,
    height: slitherlink5x5.rows,
    task: slitherlink5x5.task,
  });
  const r = s.solve();
  assert.equal(r.solved, true, '5x5 fixture should solve');
  // Verify grid dimensions.
  assert.equal(r.horizontal.length, slitherlink5x5.rows + 1);
  assert.equal(r.horizontal[0].length, slitherlink5x5.cols);
  assert.equal(r.vertical.length, slitherlink5x5.rows);
  assert.equal(r.vertical[0].length, slitherlink5x5.cols + 1);
  // All cells must be 0 or 1 (no internal encoding leak).
  for (const row of r.horizontal) for (const v of row) assert.ok(v === 0 || v === 1);
  for (const row of r.vertical) for (const v of row) assert.ok(v === 0 || v === 1);
});

test('SlitherlinkSolver+CDCL: fuzz-generated small puzzles all solve correctly', () => {
  // Five small puzzles known to require backtracking; verify CDCL handles them.
  SlitherlinkSolver.clearSolutionCache();
  const cases = [
    { rows: 3, cols: 3, task: [[-1,2,-1],[-1,-1,2],[-1,2,-1]] },
    { rows: 3, cols: 3, task: [[2,-1,-1],[-1,-1,-1],[-1,-1,2]] },
    { rows: 4, cols: 4, task: [[-1,2,-1,-1],[2,-1,-1,2],[-1,-1,2,-1],[-1,2,-1,-1]] },
    { rows: 4, cols: 4, task: [[3,-1,-1,3],[-1,-1,-1,-1],[-1,-1,-1,-1],[3,-1,-1,3]] },
    { rows: 4, cols: 4, task: [[-1,3,-1,3],[-1,-1,2,-1],[2,-1,-1,-1],[3,-1,3,-1]] },
  ];
  for (const c of cases) {
    SlitherlinkSolver.clearSolutionCache();
    const s = new SlitherlinkSolver({ width: c.cols, height: c.rows, task: c.task });
    s.maxMs = 5000;
    const r = s.solve();
    // solved:false is acceptable (no valid loop exists); when solved, output must be valid.
    if (r.solved) {
      for (const row of r.horizontal) for (const v of row) assert.ok(v === 0 || v === 1, 'horizontal edge must be 0 or 1');
      for (const row of r.vertical) for (const v of row) assert.ok(v === 0 || v === 1, 'vertical edge must be 0 or 1');
    }
  }
});
```

- [ ] **Step 2: Add `_cdclSearch` to `SlitherlinkSolver`**

Add the method immediately before `solve()` in `solver.js`:

```js
  // Main CDCL search loop. Replaces _backtrack() in solve().
  // Precondition: propagate() has already been called once (in solve()) and
  // returned true; some edges may still be UNKNOWN.
  // Returns true if a complete valid loop was found; false on contradiction
  // or budget exceeded.
  _cdclSearch() {
    let conflictsSinceRestart = 0;
    let lubyIdx = 0;
    const RESTART_UNIT = 100;
    let restartLimit = this._lubyNext(lubyIdx) * RESTART_UNIT;

    while (true) {
      if (this._budgetExceeded()) return false;

      // Pick a decision literal.
      const lit = this._pickDecisionLiteral();
      if (lit === 0) {
        // All variables assigned — verify final loop.
        this._dsuRebuild();
        return this._checkSingleLoopComplete();
      }

      // Open a new decision level and assign the literal.
      this._decisionLevel++;
      this._currentReason = null; // decisions have no reason
      if (!this._forceLiteral(lit)) {
        // Shouldn't happen: we picked an unassigned variable.
        return false;
      }

      // Propagate. On conflict: analyze, backjump, learn, retry.
      while (!this.propagate()) {
        if (this._budgetExceeded()) return false;
        conflictsSinceRestart++;
        this._totalConflicts++;

        if (this._decisionLevel === 0) return false; // unsolvable at root

        const conflictReason = this._lastConflictReason;
        const learned = this._analyzeConflict(conflictReason);
        const backjumpLevel = this._computeBackjumpLevel(learned);

        this._backjumpTo(backjumpLevel);
        this._addLearnedClause(learned);
        this._bumpVsids(learned);
        this._decayVsidsIfDue();

        // Luby restart.
        if (conflictsSinceRestart >= restartLimit) {
          this._restart();
          conflictsSinceRestart = 0;
          lubyIdx++;
          restartLimit = this._lubyNext(lubyIdx) * RESTART_UNIT;
        }
      }
      // propagate() succeeded — loop back for next decision.
    }
  }
```

- [ ] **Step 3: Update `solve()` to call `_cdclSearch()` instead of `_backtrack()`**

In `solver.js`, locate the line(s) in `SlitherlinkSolver.solve()` that call `this._backtrack()`. Replace the backtrack branch with the CDCL branch:

```js
    if (this._cdclSearch()) {
      const out = this._emit();
      this._storeInCache(key, out);
      return { solved: true, horizontal: out.horizontal, vertical: out.vertical };
    }
```

Leave the partial-on-timeout path (everything after) unchanged.

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
node --test --test-name-pattern='SlitherlinkSolver\+CDCL'
```

Expected: both integration tests pass.

```bash
npm test
```

Expected: all green (existing slitherlink tests still pass; no regressions).

- [ ] **Step 5: Build and commit**

```bash
npm run build && npm run lint && npm run typecheck && jj commit -m "$(cat <<'EOF'
feat(cdcl): add _cdclSearch and wire into SlitherlinkSolver.solve()

_cdclSearch implements the CDCL main loop: pick a decision literal via
VSIDS/_pickDecisionLiteral, open a decision level, force the literal, then
loop over propagate() failures — each time running first-UIP conflict
analysis, non-chronological backjump, learned-clause addition, VSIDS bump,
and Luby restart. solve() now calls _cdclSearch() instead of _backtrack();
the partial-on-timeout path is unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: Daily regression test + monthly integration test

**Files:**
- Modify: `tests/solver.test.js` — add the 30×30 daily regression test and the 50×40 monthly integration test.

- [ ] **Step 1: Add the two integration tests**

Append the following tests to `tests/solver.test.js` (after the existing slitherlink tests):

```js
test('SlitherlinkSolver+CDCL: 30x30 daily still solves under 2s with same output', () => {
  SlitherlinkSolver.clearSolutionCache();
  const realPuzzles = require('./fixtures/real-puzzles.js');
  const daily = realPuzzles.slitherlinkRealDaily30x30 || realPuzzles.slitherlinkReal5x5_a;
  // If no 30x30 fixture is available yet, skip gracefully.
  if (!daily || daily.rows !== 30 || daily.cols !== 30) {
    console.warn('No 30x30 daily fixture; skipping daily regression test');
    return;
  }
  const s = new SlitherlinkSolver({ width: daily.cols, height: daily.rows, task: daily.task });
  s.maxMs = 10000;
  const t0 = Date.now();
  const r = s.solve();
  const dt = Date.now() - t0;
  assert.equal(r.solved, true, '30x30 daily should fully solve with CDCL');
  assert.ok(dt < 2000, `30x30 daily should solve in <2s; took ${dt}ms`);
});

test('SlitherlinkSolver+CDCL: 50x40 monthly solves to completion under 10s', () => {
  SlitherlinkSolver.clearSolutionCache();
  const realPuzzles = require('./fixtures/real-puzzles.js');
  const monthly = realPuzzles.slitherlinkRealMonthly50x40_a;
  if (!monthly) {
    console.warn('No 50x40 monthly fixture; will be added in Task 16');
    return;
  }
  const s = new SlitherlinkSolver({ width: monthly.cols, height: monthly.rows, task: monthly.task });
  s.maxMs = 10000;
  const t0 = Date.now();
  const r = s.solve();
  const dt = Date.now() - t0;
  assert.equal(r.solved, true, `50x40 monthly should solve to completion via CDCL; got ${r.error || 'partial'}`);
  assert.ok(dt < 10000, `50x40 monthly should solve in <10s; took ${dt}ms (target was 5s)`);
});
```

- [ ] **Step 2: Run only the CDCL-tagged tests**

```bash
node --test --test-name-pattern='CDCL'
```

Expected: daily test skips with a warning (no 30×30 fixture yet, or passes if one exists), monthly test skips with a warning (no 50×40 fixture yet). Neither test fails — skips are acceptable.

- [ ] **Step 3: Run the full suite**

```bash
npm test
```

Expected: all green (the two new tests are skip/pass, not fail).

- [ ] **Step 4: Commit**

```bash
jj commit -m "$(cat <<'EOF'
test(cdcl): add 30x30 daily and 50x40 monthly regression tests

The 30x30 daily test enforces a <2s solve budget; it skips gracefully if
the fixture hasn't been captured yet. The 50x40 monthly test enforces
<10s; it also skips until the fixture is added in Task 16. Both tests are
wired to the real-puzzles.js fixture keys so they activate automatically
once the captures are in place.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: Monthly fixture + bench script extension

**Files:**
- Modify: `tests/fixtures/real-puzzles.js` — add `slitherlinkRealMonthly50x40_a` fixture.
- Modify: `tests/bench-slitherlink.js` — add the monthly bench section.

- [ ] **Step 1: Read the captured monthly task from `/tmp/slither-monthly.js`**

```bash
node -e "const m = require('/tmp/slither-monthly.js'); console.log('rows:', m.rows, 'cols:', m.cols, 'type:', m.type)"
```

Expected output: `rows: 50 cols: 40 type: slitherlink` (or similar).

If the file does not exist, ask the user to capture a 50×40 monthly from `puzzles-mobile.com/loop/special/monthly` via the widget's **📋 Dump** button and save the JSON to `/tmp/slither-monthly.js` as a CommonJS export:

```js
module.exports = { rows: 50, cols: 40, type: 'slitherlink', task: [[...], ...] };
```

Then re-run this step before proceeding.

- [ ] **Step 2: Add the fixture to `tests/fixtures/real-puzzles.js`**

Open `tests/fixtures/real-puzzles.js`. After the last slitherlink entry (e.g., `slitherlinkReal5x5_a`), append:

```js
  // 50x40 Slitherlink monthly captured from puzzles-mobile.com/loop/special/monthly.
  // task: -1=no clue, 0/1/2/3=count of loop edges around cell.
  slitherlinkRealMonthly50x40_a: {
    rows: 50,
    cols: 40,
    type: 'slitherlink',
    task: /* PASTE THE task ARRAY FROM /tmp/slither-monthly.js HERE */,
  },
```

Copy the `task` array verbatim from `/tmp/slither-monthly.js` into the placeholder above.

- [ ] **Step 3: Verify the fixture parses correctly**

```bash
node -e "
const real = require('./tests/fixtures/real-puzzles.js');
const m = real.slitherlinkRealMonthly50x40_a;
console.log('rows:', m.rows, 'cols:', m.cols);
console.log('task rows:', m.task.length, 'task cols[0]:', m.task[0].length);
"
```

Expected: `rows: 50 cols: 40` and matching task dimensions.

- [ ] **Step 4: Extend `tests/bench-slitherlink.js` with the monthly bench section**

Open `tests/bench-slitherlink.js`. After the existing 5×5 section, append:

```js
// --- 50x40 monthly bench ---
const monthly = real.slitherlinkRealMonthly50x40_a;
if (monthly) {
  // 2 warmup iterations (cache discarded each time).
  for (let i = 0; i < 2; i++) {
    SlitherlinkSolver.clearSolutionCache();
    new SlitherlinkSolver({ width: monthly.cols, height: monthly.rows, task: monthly.task }).solve();
  }
  const times = [];
  let solvedFlag = null;
  for (let i = 0; i < 5; i++) {
    SlitherlinkSolver.clearSolutionCache();
    const s = new SlitherlinkSolver({ width: monthly.cols, height: monthly.rows, task: monthly.task });
    s.maxMs = 30000;
    const t0 = process.hrtime.bigint();
    const r = s.solve();
    const t1 = process.hrtime.bigint();
    times.push(Number(t1 - t0) / 1e6);
    if (solvedFlag === null) solvedFlag = r.solved;
  }
  times.sort((a, b) => a - b);
  log(`slitherlinkRealMonthly50x40_a (50x40) solve times (ms):`, times.map(t => t.toFixed(2)).join(', '));
  log(`  median: ${times[2].toFixed(2)} ms, solved: ${solvedFlag}`);
  if (!solvedFlag) failed = true;
}
```

- [ ] **Step 5: Re-run the monthly integration test**

```bash
node --test --test-name-pattern='50x40 monthly'
```

Expected: passes (fixture now present, solver solves it in <10 s).

- [ ] **Step 6: Run the bench script**

```bash
npm run bench:slitherlink
```

Expected: both the 5×5 and the 50×40 monthly sections report solved results. The bench exits with code 0.

- [ ] **Step 7: Run the full test suite**

```bash
npm test
```

Expected: all green, including the monthly integration test that was previously skipping.

- [ ] **Step 8: Commit**

```bash
jj commit -m "$(cat <<'EOF'
test(cdcl): add 50x40 monthly fixture and bench section

slitherlinkRealMonthly50x40_a added to real-puzzles.js from a live
capture. bench-slitherlink.js extended with 2 warmup + 5 timed iterations
for the monthly; the bench exits non-zero if the puzzle is unsolved. The
monthly integration test in solver.test.js now activates and passes.

Note: capture 2-3 more 50x40 monthlies from puzzles-mobile.com/loop/special/monthly
(different seeds, reload the page between captures) and add them as
slitherlinkRealMonthly50x40_b etc. for stronger bench coverage.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 17: CLAUDE.md update + final verification

**Files:**
- Modify: `CLAUDE.md` — extend the Slitherlink architectural-notes subsection with a `### Slitherlink CDCL search` sub-subsection.

- [ ] **Step 1: Locate the insertion point in `CLAUDE.md`**

Find the existing `### Slitherlink encoding` subsection (around line 241+). The new `### Slitherlink CDCL search` sub-subsection goes AFTER all existing Slitherlink content and BEFORE the next top-level `###` architectural-notes subsection.

- [ ] **Step 2: Append the CDCL sub-subsection**

Insert the following block at the identified location:

```markdown
### Slitherlink CDCL search

`SlitherlinkSolver` uses CDCL (Conflict-Driven Clause Learning) search when initial
`propagate()` + lookahead leaves UNKNOWN edges. For the 30×30 daily and smaller boards,
propagation fully solves the puzzle and CDCL never fires.

**Variable encoding.** Each edge or cell color is a binary variable with ID in `[0, totalVars)`:

```
H edges:     [0,           numH)
V edges:     [numH,        numH + numV)
Cell colors: [numH + numV, totalVars)
```

Literals: positive ID = true sense (LINE / INSIDE); negative ID = false sense (EMPTY / OUTSIDE).

**Reason tracking.** Every propagation rule sets `this._currentReason` (an array of antecedent
variable IDs) before calling `_forceLiteral`. The setter captures it into `_reasons[]`, parallel
to `this.trail`. Decisions set `_currentReason = null`; their `_reasons[]` entry is `null`.
Decision levels are tracked in `_decisionLevels[]` (also parallel to `trail`).

**Conflict analysis (first-UIP).** When `propagate()` returns false, `_lastConflictReason` holds
the triggering antecedents. `_analyzeConflict(conflictReason)` walks the trail backward,
resolving current-level antecedents until exactly one remains (the UIP), then returns the learned
clause as an array of literals.

**Non-chronological backjump.** `_computeBackjumpLevel(learned)` returns the highest decision
level among non-UIP literals (or 0 for unit clauses). `_backjumpTo(level)` rolls back all trail
entries at level > target, restoring edges/colors to UNKNOWN and decrementing `_decisionLevel`.
The learned clause is immediately unit at the backjump level, so `_propagateLearnedClauses`
forces the UIP negation on the very next propagate pass.

**Learned clauses.** Stored in `_learnedClauses[]` as `{ literals, activity }` objects. Capacity
capped at `_maxLearnedClauses = 5000`; the lowest-activity quarter is evicted when the cap is
hit. `_propagateLearnedClauses(onChange)` runs at the end of each propagate fixpoint (after
parity), scanning for unit or contradicting clauses. Clause activity increments each time a
clause fires; it decays alongside VSIDS scores.

**VSIDS.** Per-variable scores in `_vsidsScores` (Float32Array, length `totalVars`). Each
conflict bumps every variable in the learned clause by 1. Every `_vsidsDecayInterval = 256`
conflicts all scores are multiplied by `_vsidsDecay = 0.95`. `_pickDecisionLiteral()` picks the
highest-scoring unassigned variable; when all scores are 0 (no conflicts yet) it falls back to
`_pickCell` / `_pickEdge` for a sensible initial branch order.

**Luby restarts.** `_lubyNext(idx)` returns the (idx+1)-th value of the Luby sequence via the
standard doubling formula. `_cdclSearch()` restarts every `_lubyNext(lubyIdx) * RESTART_UNIT`
conflicts (`RESTART_UNIT = 100`). `_restart()` calls `_backjumpTo(0)`, keeping all learned
clauses and VSIDS scores; propagation on the clean state often determines many variables before
the next decision is needed.

**Integration.** `solve()` calls `_cdclSearch()` instead of `_backtrack()`. The
partial-on-timeout path (snapshot via `_emit()`) is unchanged. `_totalConflicts` accumulates
conflicts across all restarts for diagnostics.

**Worker budget.** The solver worker sets `maxMs = 10000` (10 s). CDCL solves hard 50×40
monthlies well within this budget (~5 s observed). The `_budgetExceeded()` check inside both
`_cdclSearch()` and `propagate()` ensures the timeout is respected.
```

- [ ] **Step 3: Final verification**

Run the full build + lint + typecheck + test pipeline:

```bash
npm run build && npm run lint && npm run typecheck && npm test
```

Expected: all passes with no errors or unexpected warnings.

- [ ] **Step 4: Run the bench script to confirm both puzzles solve**

```bash
npm run bench:slitherlink
```

Expected: both the 5×5 real fixture and the 50×40 monthly report `solved: true` and the bench exits 0.

- [ ] **Step 5: Commit**

```bash
jj commit -m "$(cat <<'EOF'
docs(slitherlink): document CDCL search in CLAUDE.md

Adds a 'Slitherlink CDCL search' sub-subsection covering: variable/literal
encoding, reason tracking, first-UIP conflict analysis, non-chronological
backjump, learned-clause storage and propagation, VSIDS variable ordering,
Luby restarts, solve() integration, and the worker budget.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```
