'use strict';

const { hashFNV1a } = require('./shared.js');

// BinairoSolver — pure logic for Binairo and Binairo Plus.
//
// Internal grid encoding: `0=empty, 1=one, 2=zero` (cellStatus polarity).
// Givens (page-native `-1=blank, 0=given-zero, 1=given-one`) are translated
// at construction; downstream code never sees the `-1/0/1` triad. See
// `src/widget/puzzles/binairo.js` for the page-side encoding and the Binairo
// Plus comparison-clue contract.
//
// === Triples inline, duplicates at completion ===
//
// `_applyBalance` and `_applyUniqueness` call `_wouldCreateTriple` before each
// write; `_backtrack` calls it before branch assign. Propagation cannot produce
// a triple-bearing state, so `_gridHasTriple()` post-validation in `_backtrack`
// is gone. `_hasDuplicateLines()` IS still called at completion (only on full
// grid) because backtracking can complete a line into a duplicate, and
// uniqueness only catches duplicates when one line has exactly 2 empty cells.
// `solve()` calls `_gridHasTriple()` once up-front to reject invalid givens
// (no-triples rule scans empty cells only). Covered by
// `tests/binairo-fuzz.test.js`.
//
// === Lookahead ===
//
// After local rules (no-triples, balance, uniqueness) exhaust at top level,
// 1-step lookahead: probe each empty cell with each value, run lookahead-free
// `propagate()`, force survivor if exactly one. `_inLookahead` prevents
// recursion; `_depth` ensures lookahead only at depth 0. Without lookahead the
// 30×30 weekly was effectively unsolvable (minutes); with lookahead ~75 ms.
//
// === `maxMs` budget ===
//
// `BinairoSolver` accepts instance `maxMs` (default 0 = no limit). When set,
// `_backtrack` and `_applyLookahead` check elapsed between iterations; over
// budget returns `{solved: false, error: 'timed out'}`. UI should always set
// `maxMs` to avoid minute-long hangs. `tests/solver.test.js` has a `maxMs=1`
// regression that asserts bail within 500 ms.

class BinairoSolver {
  /**
   * @param {{ rows: number, cols: number, givens: number[][], initialState?: number[][], comparisonClues?: (number|null)[][] }} opts
   *   `givens`          2D array, page-native encoding (-1=blank, 0=given-zero, 1=given-one).
   *   `initialState`    optional 2D in cellStatus encoding (0=empty, 1=one, 2=zero);
   *                     defaults to givens-translated state.
   *   `comparisonClues` optional sparse 2D of flag integers (1=R-EQ, 2=R-NE, 4=D-EQ, 8=D-NE);
   *                     omitted or undefined produces standard (unconstrained) Binairo.
   */
  constructor({ rows, cols, givens, initialState, comparisonClues }) {
    if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows <= 0 || cols <= 0) {
      throw new Error('BinairoSolver: rows/cols must be positive integers');
    }
    if (rows % 2 !== 0 || cols % 2 !== 0) {
      throw new Error('BinairoSolver: rows/cols must be even (Binairo requires N/2 of each value per line)');
    }
    if (!Array.isArray(givens)) {
      throw new Error('BinairoSolver: givens must be an array');
    }
    this.rows = rows;
    this.cols = cols;
    this.rowHalf = cols / 2;     // half-count target for any single row
    this.colHalf = rows / 2;     // half-count target for any single column
    this.givens = givens.map(row => (Array.isArray(row) ? row.slice() : []));

    // Internal grid: 0=empty, 1=one, 2=zero. Flat Int8Array for fast access.
    this.grid = new Int8Array(rows * cols);

    // Per-line known-value counts. Maintained incrementally by _assign / _rollback.
    this.rowOnes  = new Int32Array(rows);
    this.rowZeros = new Int32Array(rows);
    this.colOnes  = new Int32Array(cols);
    this.colZeros = new Int32Array(cols);

    // Trail entries packed as (idx << 2) | oldValue. oldValue ∈ {0, 1, 2}.
    this.trail = [];

    // Solve-time control. maxMs=0 disables the budget.
    this.maxMs = 0;
    this._startedAt = 0;
    this._timedOut = false;
    // Depth tracking so lookahead only fires at the top level — at deeper
    // backtrack depths the per-cell probing cost outweighs the pruning win.
    this._depth = 0;
    this._inLookahead = false;

    // Comparison-clue normalization: page-native sparse 2D of flag integers
    // collapses to a flat list of canonical pairwise constraints. Empty/
    // undefined `comparisonClues` produces an empty list (standard Binairo).
    this.compConstraints = this._decodeComparison(comparisonClues);

    // Standard Binairo enforces all-rows-distinct + all-cols-distinct.
    // Binairo Plus (puzzles-mobile.com /binairo-plus/) replaces uniqueness
    // with the comparison constraints — solutions with duplicate lines are
    // accepted (and some puzzles have NO solution under strict uniqueness).
    // Discriminate by presence of comparison constraints.
    this._strictUniqueness = this.compConstraints.length === 0;

    // Seed the grid from initialState if provided, else from givens.
    const init = initialState || this._initialFromGivens(givens);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = init[r] && init[r][c] !== undefined ? init[r][c] : 0;
        if (v !== 0) this._set(r, c, v);
      }
    }
  }

  _initialFromGivens(givens) {
    const out = Array.from({ length: this.rows }, () => new Array(this.cols).fill(0));
    for (let r = 0; r < this.rows; r++) {
      const row = givens[r] || [];
      for (let c = 0; c < this.cols; c++) {
        const g = row[c];
        out[r][c] = g === 1 ? 1 : g === 0 ? 2 : 0;
      }
    }
    return out;
  }

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

  _idx(r, c) { return r * this.cols + c; }

  _get(r, c) { return this.grid[r * this.cols + c]; }

  // Direct write, no trail. Use only for initial seeding.
  _set(r, c, v) {
    const i = r * this.cols + c;
    const old = this.grid[i];
    if (old === v) return;
    this._bumpCounts(r, c, old, v);
    this.grid[i] = v;
  }

  // Trailed write. Returns true iff value changed.
  _assign(r, c, v) {
    const i = r * this.cols + c;
    const old = this.grid[i];
    if (old === v) return false;
    this.trail.push((i << 2) | old);
    this._bumpCounts(r, c, old, v);
    this.grid[i] = v;
    return true;
  }

  _rollback(mark) {
    const t = this.trail;
    const cols = this.cols;
    while (t.length > mark) {
      const entry = t.pop();
      const old = entry & 0b11;
      const i = entry >>> 2;
      const cur = this.grid[i];
      const r = (i / cols) | 0;
      const c = i % cols;
      this._bumpCounts(r, c, cur, old);
      this.grid[i] = old;
    }
  }

  _bumpCounts(r, c, oldV, newV) {
    if (oldV === 1) { this.rowOnes[r]--; this.colOnes[c]--; }
    else if (oldV === 2) { this.rowZeros[r]--; this.colZeros[c]--; }
    if (newV === 1) { this.rowOnes[r]++; this.colOnes[c]++; }
    else if (newV === 2) { this.rowZeros[r]++; this.colZeros[c]++; }
  }

  // Fixed-point loop driving the three local rules, then (top level only)
  // a 1-step lookahead pass. Returns false on contradiction.
  propagate() {
    if (this._timedOut) return false;
    while (true) {
      let changed = false;
      if (!this._applyNoTriples(() => { changed = true; })) return false;
      if (!this._applyBalance(() => { changed = true; }))   return false;
      if (!this._applyComparison(() => { changed = true; })) return false;
      if (!this._applyUniqueness(() => { changed = true; })) return false;
      if (!this._applySingleRemaining(() => { changed = true; })) return false;
      if (changed) continue;
      // Local rules exhausted. Try lookahead — but only at depth 0 (inside
      // backtracking, the recurring per-cell probe cost dwarfs the gain).
      if (this._depth > 0 || this._inLookahead) break;
      let lookChanged = false;
      this._inLookahead = true;
      let lookOK;
      try {
        lookOK = this._applyLookahead(() => { lookChanged = true; });
      } finally {
        this._inLookahead = false;
      }
      if (!lookOK) return false;
      if (!lookChanged) break;
      // Lookahead made progress; re-run local rules to cascade.
    }
    return true;
  }

  // For each empty cell, tentatively assign each value, run a (lookahead-free)
  // propagate, and check whether the assignment leads to a contradiction. If
  // exactly one value survives, force it. If both fail, signal contradiction.
  _applyLookahead(onChange) {
    if (this._checkTimeout()) return false;
    const R = this.rows, C = this.cols;
    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        if (this._get(r, c) !== 0) continue;
        if (this._checkTimeout()) return false;
        const mark = this.trail.length;

        // Probe v=1: an immediate triple short-circuits to failed probe.
        let okOne = false;
        if (!this._wouldCreateTriple(r, c, 1)) {
          if (this._assign(r, c, 1) && this.propagate()) okOne = true;
          this._rollback(mark);
        }

        // Probe v=2
        let okZero = false;
        if (!this._wouldCreateTriple(r, c, 2)) {
          if (this._assign(r, c, 2) && this.propagate()) okZero = true;
          this._rollback(mark);
        }

        if (!okOne && !okZero) return false;
        if (okOne && !okZero) { if (this._assign(r, c, 1)) onChange(); }
        else if (okZero && !okOne) { if (this._assign(r, c, 2)) onChange(); }
      }
    }
    return true;
  }

  _checkTimeout() {
    if (this._timedOut) return true;
    if (this.maxMs > 0 && Date.now() - this._startedAt > this.maxMs) {
      this._timedOut = true;
      return true;
    }
    return false;
  }

  // Per-line enumeration fallback: for each row/column with a tractable
  // number of empty-cell permutations, enumerate every valid completion
  // (respecting balance, no-triples within the line, and comparison
  // constraints involving cells in the line — including cross-axis
  // constraints whose other side is already filled). For each empty cell,
  // if all valid completions agree on its value, force it.
  //
  // Used by getHint as a fallback when local rules deduce nothing. Finds
  // forced moves that the cell-by-cell line lookahead misses, including
  // forces driven by comparison constraints that span multiple empties.
  _applyLineEnumeration(onChange) {
    const R = this.rows, C = this.cols;
    const MAX_COMBOS = 5000;
    for (let r = 0; r < R; r++) {
      if (!this._enumerateLine('row', r, this.rowHalf, MAX_COMBOS, onChange)) return false;
    }
    for (let c = 0; c < C; c++) {
      if (!this._enumerateLine('col', c, this.colHalf, MAX_COMBOS, onChange)) return false;
    }
    return true;
  }

  _enumerateLine(axis, index, halfCount, maxCombos, onChange) {
    const N = axis === 'row' ? this.cols : this.rows;
    const lineVals = new Int8Array(N);
    const empties = [];
    let onesCount = 0;
    for (let i = 0; i < N; i++) {
      const v = axis === 'row' ? this._get(index, i) : this._get(i, index);
      lineVals[i] = v;
      if (v === 0) empties.push(i);
      else if (v === 1) onesCount++;
    }
    if (empties.length === 0) return true;
    const needOnes = halfCount - onesCount;
    const k = empties.length;
    if (needOnes < 0 || needOnes > k) return false;

    // Skip lines whose enumeration would blow the budget — local rules and
    // backtracking handle those instead.
    let combos = 1;
    for (let i = 0; i < Math.min(needOnes, k - needOnes); i++) {
      combos = (combos * (k - i)) / (i + 1);
      if (combos > maxCombos) return true;
    }

    // Restrict comparison constraints to those involving this line.
    const lineConstraints = [];
    for (const cn of this.compConstraints) {
      const aInLine = (axis === 'row' && cn.aR === index) || (axis === 'col' && cn.aC === index);
      const bInLine = (axis === 'row' && cn.bR === index) || (axis === 'col' && cn.bC === index);
      if (aInLine || bInLine) lineConstraints.push(cn);
    }

    // possible[i]: bitmask of values seen at empties[i] across valid completions.
    //   bit 0 (=1) → value 1 reachable; bit 1 (=2) → value 2 reachable.
    const possible = new Int8Array(k);
    const valForEmpty = new Int8Array(k);
    const candidate = new Int8Array(N);
    let validCount = 0;
    const self = this;

    function isValid() {
      for (let i = 0; i < N; i++) candidate[i] = lineVals[i];
      for (let i = 0; i < k; i++) candidate[empties[i]] = valForEmpty[i];
      for (let i = 2; i < N; i++) {
        if (candidate[i] !== 0 &&
            candidate[i] === candidate[i - 1] &&
            candidate[i] === candidate[i - 2]) return false;
      }
      for (const cn of lineConstraints) {
        const valA = (axis === 'row' && cn.aR === index) ? candidate[cn.aC] :
                     (axis === 'col' && cn.aC === index) ? candidate[cn.aR] :
                     self._get(cn.aR, cn.aC);
        const valB = (axis === 'row' && cn.bR === index) ? candidate[cn.bC] :
                     (axis === 'col' && cn.bC === index) ? candidate[cn.bR] :
                     self._get(cn.bR, cn.bC);
        if (valA === 0 || valB === 0) continue;
        if ((valA === valB) !== cn.sameSign) return false;
      }
      return true;
    }

    function recurse(pos, onesLeft, zerosLeft) {
      if (pos === k) {
        if (isValid()) {
          validCount++;
          for (let i = 0; i < k; i++) possible[i] |= valForEmpty[i] === 1 ? 1 : 2;
        }
        return;
      }
      if (zerosLeft > 0) {
        valForEmpty[pos] = 2;
        recurse(pos + 1, onesLeft, zerosLeft - 1);
      }
      if (onesLeft > 0) {
        valForEmpty[pos] = 1;
        recurse(pos + 1, onesLeft - 1, zerosLeft);
      }
    }
    recurse(0, needOnes, k - needOnes);

    if (validCount === 0) return false;

    for (let i = 0; i < k; i++) {
      const forced = possible[i] === 1 ? 1 : possible[i] === 2 ? 2 : 0;
      if (forced === 0) continue;
      const r = axis === 'row' ? index : empties[i];
      const c = axis === 'row' ? empties[i] : index;
      if (this._get(r, c) !== 0) continue;
      if (this._wouldCreateTriple(r, c, forced)) return false;
      if (this._assign(r, c, forced)) onChange();
    }
    return true;
  }

  // Line-restricted lookahead: a single round over rows/columns that need
  // exactly 1 of one value and ≥2 of the other. For each empty cell in
  // such a line, probe both values via local-rule propagation. If exactly
  // one value survives, force it. Cells where both values stay legal are
  // skipped. Used by getHint as a fallback when local rules alone deduce
  // nothing — it picks up forced moves that require case analysis but
  // doesn't unfurl the whole board the way unrestricted lookahead does.
  _applyLineLookahead(onChange) {
    const R = this.rows, C = this.cols, rowHalf = this.rowHalf, colHalf = this.colHalf;

    const targets = [];
    for (let r = 0; r < R; r++) {
      const needOnes  = rowHalf - this.rowOnes[r];
      const needZeros = rowHalf - this.rowZeros[r];
      if ((needOnes === 1 && needZeros >= 2) || (needZeros === 1 && needOnes >= 2)) {
        targets.push({ axis: 'row', index: r });
      }
    }
    for (let c = 0; c < C; c++) {
      const needOnes  = colHalf - this.colOnes[c];
      const needZeros = colHalf - this.colZeros[c];
      if ((needOnes === 1 && needZeros >= 2) || (needZeros === 1 && needOnes >= 2)) {
        targets.push({ axis: 'col', index: c });
      }
    }

    for (const tgt of targets) {
      if (this._checkTimeout()) return false;
      const empties = tgt.axis === 'row'
        ? this._emptyCellsInRow(tgt.index)
        : this._emptyCellsInCol(tgt.index);
      for (const idx of empties) {
        const r = tgt.axis === 'row' ? tgt.index : idx;
        const c = tgt.axis === 'row' ? idx : tgt.index;
        // Skip cells forced earlier in this pass.
        if (this._get(r, c) !== 0) continue;
        const mark = this.trail.length;

        let okOne = false;
        if (!this._wouldCreateTriple(r, c, 1)) {
          if (this._assign(r, c, 1) && this.propagate()) okOne = true;
          this._rollback(mark);
        }

        let okZero = false;
        if (!this._wouldCreateTriple(r, c, 2)) {
          if (this._assign(r, c, 2) && this.propagate()) okZero = true;
          this._rollback(mark);
        }

        if (!okOne && !okZero) return false;
        if (okOne && !okZero) { if (this._assign(r, c, 1)) onChange(); }
        else if (okZero && !okOne) { if (this._assign(r, c, 2)) onChange(); }
        // else (both legal): cell can take either value — skip per spec.
      }
    }
    return true;
  }

  // For each empty cell, check both placements against up to three horizontal
  // and three vertical 3-windows that contain it (boundary windows skipped).
  // If exactly one value is legal, force it. If neither is legal, contradiction.
  _applyNoTriples(onChange) {
    const R = this.rows, C = this.cols;
    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        if (this._get(r, c) !== 0) continue;
        const canOne  = !this._wouldCreateTriple(r, c, 1);
        const canZero = !this._wouldCreateTriple(r, c, 2);
        if (!canOne && !canZero) return false;
        if (canOne && !canZero) { if (this._assign(r, c, 1)) onChange(); }
        else if (canZero && !canOne) { if (this._assign(r, c, 2)) onChange(); }
      }
    }
    return true;
  }

  // Does placing v at (r,c) create v,v,v in any of the four 3-windows that
  // span this cell? Skip windows where any other slot is empty (0) — they
  // can't force a triple yet.
  _wouldCreateTriple(r, c, v) {
    const R = this.rows, C = this.cols;
    // Horizontal windows: (c-2,c-1,c), (c-1,c,c+1), (c,c+1,c+2)
    for (let dc = -2; dc <= 0; dc++) {
      const c0 = c + dc;
      if (c0 < 0 || c0 + 2 >= C) continue;
      const a = (c0     === c) ? v : this._get(r, c0);
      const b = (c0 + 1 === c) ? v : this._get(r, c0 + 1);
      const d = (c0 + 2 === c) ? v : this._get(r, c0 + 2);
      if (a === v && b === v && d === v) return true;
    }
    // Vertical windows: (r-2,r-1,r), (r-1,r,r+1), (r,r+1,r+2)
    for (let dr = -2; dr <= 0; dr++) {
      const r0 = r + dr;
      if (r0 < 0 || r0 + 2 >= R) continue;
      const a = (r0     === r) ? v : this._get(r0, c);
      const b = (r0 + 1 === r) ? v : this._get(r0 + 1, c);
      const d = (r0 + 2 === r) ? v : this._get(r0 + 2, c);
      if (a === v && b === v && d === v) return true;
    }
    return false;
  }

  // When a line needs exactly one more of a given value (rowOnes/rowZeros
  // is one short of the half-target), check each empty cell to see whether
  // it can legally hold that value without creating a triple. If exactly
  // one slot can, force the value there and every other empty in the line
  // to the opposite value. If no slot can, the line is unsolvable —
  // signal contradiction.
  //
  // This catches a class of deductions that no-triples + balance miss:
  // no-triples is cell-local, balance only fires at the half-target, and
  // uniqueness only fires on 2-empty lines. With a longer empty stretch
  // but a single remaining instance of one value, the position is often
  // pinned by triple constraints alone.
  _applySingleRemaining(onChange) {
    const R = this.rows, C = this.cols, rowHalf = this.rowHalf, colHalf = this.colHalf;

    for (let r = 0; r < R; r++) {
      if (this.rowOnes[r] === rowHalf - 1) {
        if (!this._forceSingleInRow(r, 1, onChange)) return false;
      }
      if (this.rowZeros[r] === rowHalf - 1) {
        if (!this._forceSingleInRow(r, 2, onChange)) return false;
      }
    }
    for (let c = 0; c < C; c++) {
      if (this.colOnes[c] === colHalf - 1) {
        if (!this._forceSingleInCol(c, 1, onChange)) return false;
      }
      if (this.colZeros[c] === colHalf - 1) {
        if (!this._forceSingleInCol(c, 2, onChange)) return false;
      }
    }
    return true;
  }

  _forceSingleInRow(r, target, onChange) {
    const empties = this._emptyCellsInRow(r);
    if (empties.length === 0) return true;
    let onlySlot = -1;
    let count = 0;
    for (const c of empties) {
      if (!this._wouldCreateTriple(r, c, target)) {
        if (++count > 1) return true; // more than one slot — can't force
        onlySlot = c;
      }
    }
    if (count === 0) return false; // contradiction: nowhere to place the target
    const other = target === 1 ? 2 : 1;
    if (this._assign(r, onlySlot, target)) onChange();
    for (const c of empties) {
      if (c === onlySlot) continue;
      if (this._wouldCreateTriple(r, c, other)) return false;
      if (this._assign(r, c, other)) onChange();
    }
    return true;
  }

  _forceSingleInCol(c, target, onChange) {
    const empties = this._emptyCellsInCol(c);
    if (empties.length === 0) return true;
    let onlySlot = -1;
    let count = 0;
    for (const r of empties) {
      if (!this._wouldCreateTriple(r, c, target)) {
        if (++count > 1) return true;
        onlySlot = r;
      }
    }
    if (count === 0) return false;
    const other = target === 1 ? 2 : 1;
    if (this._assign(onlySlot, c, target)) onChange();
    for (const r of empties) {
      if (r === onlySlot) continue;
      if (this._wouldCreateTriple(r, c, other)) return false;
      if (this._assign(r, c, other)) onChange();
    }
    return true;
  }

  // If a line already has rowHalf of one value, every empty cell in it must
  // take the other value. Validates no-triples on each assignment so that
  // backtracking doesn't need a separate full-grid triple scan.
  _applyBalance(onChange) {
    const R = this.rows, C = this.cols, rowHalf = this.rowHalf, colHalf = this.colHalf;

    for (let r = 0; r < R; r++) {
      const ones  = this.rowOnes[r];
      const zeros = this.rowZeros[r];
      if (ones > rowHalf || zeros > rowHalf) return false;
      if (ones === rowHalf) {
        for (let c = 0; c < C; c++) {
          if (this._get(r, c) !== 0) continue;
          if (this._wouldCreateTriple(r, c, 2)) return false;
          if (this._assign(r, c, 2)) onChange();
        }
      } else if (zeros === rowHalf) {
        for (let c = 0; c < C; c++) {
          if (this._get(r, c) !== 0) continue;
          if (this._wouldCreateTriple(r, c, 1)) return false;
          if (this._assign(r, c, 1)) onChange();
        }
      }
    }

    for (let c = 0; c < C; c++) {
      const ones  = this.colOnes[c];
      const zeros = this.colZeros[c];
      if (ones > colHalf || zeros > colHalf) return false;
      if (ones === colHalf) {
        for (let r = 0; r < R; r++) {
          if (this._get(r, c) !== 0) continue;
          if (this._wouldCreateTriple(r, c, 2)) return false;
          if (this._assign(r, c, 2)) onChange();
        }
      } else if (zeros === colHalf) {
        for (let r = 0; r < R; r++) {
          if (this._get(r, c) !== 0) continue;
          if (this._wouldCreateTriple(r, c, 1)) return false;
          if (this._assign(r, c, 1)) onChange();
        }
      }
    }
    return true;
  }
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
  // Force a line whose only 2 empty cells admit exactly one completion that
  // (a) keeps balance legal, (b) avoids no-triples, (c) avoids matching any
  // already-completed parallel line.
  _applyUniqueness(onChange) {
    // Binairo Plus relaxes uniqueness — see constructor comment on
    // _strictUniqueness. Skip the rule entirely on relaxed boards.
    if (!this._strictUniqueness) return true;
    const R = this.rows, C = this.cols, rowHalf = this.rowHalf, colHalf = this.colHalf;

    const filledRowMasks = this._filledLineMasks('row');
    for (let r = 0; r < R; r++) {
      const empty = this._emptyCellsInRow(r);
      if (empty.length !== 2) continue;
      // Skip balance-forced rows: _applyBalance will fill them; uniqueness candidates
      // won't include the balance-only completions ([2,2] or [1,1]), so we'd see 0
      // candidates and falsely report a contradiction.
      if (this.rowOnes[r] === rowHalf || this.rowZeros[r] === rowHalf) continue;
      const cands = this._completeLineCandidates(r, 'row', empty, filledRowMasks, rowHalf);
      if (cands.length === 0) return false;
      if (cands.length === 1) {
        const [v0, v1] = cands[0];
        // Cross-axis triple check — _completeLineCandidates only validates
        // no-triples within the line. The two assigns can still create a
        // column-direction triple. Without this guard, the post-validation
        // in _backtrack used to catch it; now we surface it inline.
        if (this._wouldCreateTriple(r, empty[0], v0)) return false;
        if (this._assign(r, empty[0], v0)) onChange();
        if (this._wouldCreateTriple(r, empty[1], v1)) return false;
        if (this._assign(r, empty[1], v1)) onChange();
      }
    }

    const filledColMasks = this._filledLineMasks('col');
    for (let c = 0; c < C; c++) {
      const empty = this._emptyCellsInCol(c);
      if (empty.length !== 2) continue;
      // Skip balance-forced cols for the same reason.
      if (this.colOnes[c] === colHalf || this.colZeros[c] === colHalf) continue;
      const cands = this._completeLineCandidates(c, 'col', empty, filledColMasks, colHalf);
      if (cands.length === 0) return false;
      if (cands.length === 1) {
        const [v0, v1] = cands[0];
        if (this._wouldCreateTriple(empty[0], c, v0)) return false;
        if (this._assign(empty[0], c, v0)) onChange();
        if (this._wouldCreateTriple(empty[1], c, v1)) return false;
        if (this._assign(empty[1], c, v1)) onChange();
      }
    }
    return true;
  }

  _emptyCellsInRow(r) {
    const out = [];
    for (let c = 0; c < this.cols; c++) if (this._get(r, c) === 0) out.push(c);
    return out;
  }

  _emptyCellsInCol(c) {
    const out = [];
    for (let r = 0; r < this.rows; r++) if (this._get(r, c) === 0) out.push(r);
    return out;
  }

  // Encode a fully-filled line as a bitmask of bit-per-cell where 1=one and 0=zero.
  // Returns a Set<number> of all currently-full lines along the given axis.
  _filledLineMasks(axis) {
    const set = new Set();
    if (axis === 'row') {
      for (let r = 0; r < this.rows; r++) {
        let mask = 0, full = true;
        for (let c = 0; c < this.cols; c++) {
          const v = this._get(r, c);
          if (v === 0) { full = false; break; }
          if (v === 1) mask |= (1 << c);
        }
        if (full) set.add(mask);
      }
    } else {
      for (let c = 0; c < this.cols; c++) {
        let mask = 0, full = true;
        for (let r = 0; r < this.rows; r++) {
          const v = this._get(r, c);
          if (v === 0) { full = false; break; }
          if (v === 1) mask |= (1 << r);
        }
        if (full) set.add(mask);
      }
    }
    return set;
  }

  // Try both orderings ([1,2] and [2,1]) for the two empty slots in line `index`.
  // Returns an array of legal completions, each as a 2-tuple of values that
  // would go into the empty slots in their listed order.
  _completeLineCandidates(index, axis, emptySlots, filledMasks, _halfCount) {
    const tryVals = [[1, 2], [2, 1]];
    const out = [];
    for (const [v0, v1] of tryVals) {
      const mask = this._maskWith(index, axis, emptySlots, v0, v1);
      if (mask === null) continue;                // balance / no-triples failed
      if (filledMasks.has(mask)) continue;        // duplicate of a full line
      out.push([v0, v1]);
    }
    return out;
  }

  // Build the would-be completed-line bitmask if (emptySlots[0]=v0, emptySlots[1]=v1).
  // Returns null if the completion violates balance or no-triples.
  _maskWith(index, axis, emptySlots, v0, v1) {
    const N = axis === 'row' ? this.cols : this.rows;
    let mask = 0, ones = 0, zeros = 0;
    const tempVals = new Int8Array(N);
    for (let i = 0; i < N; i++) {
      const v = axis === 'row' ? this._get(index, i) : this._get(i, index);
      tempVals[i] = v;
    }
    tempVals[emptySlots[0]] = v0;
    tempVals[emptySlots[1]] = v1;
    for (let i = 0; i < N; i++) {
      const v = tempVals[i];
      if (v === 1) { mask |= (1 << i); ones++; }
      else if (v === 2) { zeros++; }
      else return null;                           // shouldn't happen for 2-empty lines
      if (i >= 2 && tempVals[i] !== 0 && tempVals[i] === tempVals[i - 1] && tempVals[i] === tempVals[i - 2]) {
        return null;                              // no-triples violation
      }
    }
    const half = axis === 'row' ? this.rowHalf : this.colHalf;
    if (ones !== half || zeros !== half) return null;
    return mask;
  }

  /**
   * @returns {{ solved: boolean, grid: number[][] | null, error?: string }}
   */
  solve() {
    const key = this._cacheKey();
    const cached = BinairoSolver._solutionCache.get(key);
    if (cached) return { solved: true, grid: cached.map(row => row.slice()) };

    this._startedAt = Date.now();
    this._timedOut = false;
    this._depth = 0;

    // Reject invalid givens up-front. Propagation rules only catch triples
    // they create themselves (and the no-triples rule only scans empty cells),
    // so a pre-existing triple in the initial state would otherwise sneak
    // through and produce a triple-bearing "solution".
    if (this._gridHasTriple()) {
      return { solved: false, grid: null, error: 'givens contain a triple' };
    }

    if (!this.propagate()) {
      if (this._timedOut) return { solved: false, grid: null, error: 'timed out' };
      return { solved: false, grid: null, error: 'contradiction on initial propagation' };
    }
    if (this._isComplete()) {
      // Balance + uniqueness propagation now reject triples at assign-time,
      // so a fully-filled state cannot contain triples; only the cross-line
      // duplicate-row/duplicate-col check is still meaningful here.
      if (this._hasDuplicateLines()) {
        return { solved: false, grid: null, error: 'givens produce an invalid Binairo grid' };
      }
      const grid = this._gridTo2D();
      this._storeInCache(key, grid);
      return { solved: true, grid };
    }
    if (this._backtrack()) {
      const grid = this._gridTo2D();
      this._storeInCache(key, grid);
      return { solved: true, grid };
    }
    return { solved: false, grid: null, error: this._timedOut ? 'timed out' : 'no solution found' };
  }

  /**
   * Runs local-rule propagation to fixed point (no-triples, balance,
   * uniqueness, single-remaining). If that produces no deductions, falls
   * back to ONE round of line-restricted lookahead: for each line that
   * has exactly 1 of one value and ≥2 of the other still to place, probe
   * each empty cell in that line — if exactly one value survives the
   * probe, force it. Cells that can take either value are left alone.
   *
   * This avoids the "Hint reveals the whole board" problem that full
   * lookahead has, while still finding forced cells that pure local
   * deduction misses.
   * @param {number[][]} currentGrid  2D in cellStatus encoding (0/1/2).
   */
  getHint(currentGrid) {
    const clone = new BinairoSolver({
      rows: this.rows, cols: this.cols,
      givens: this.givens,
      initialState: currentGrid,
    });
    // Carry comparison constraints onto the clone — the constructor doesn't
    // see them because we only pass `givens` + `initialState`. Without this
    // the clone's `compConstraints` stays empty and `_applyComparison`
    // becomes a no-op inside Hint, so Binairo Plus puzzles look fully
    // deduced when many comparison-driven cells remain forceable. Also
    // sync `_strictUniqueness` — the clone's constructor set it true
    // (no comparisonClues passed), which would falsely enforce uniqueness
    // on Binairo Plus and reject valid duplicate-line solutions, making
    // Hint return null when deductions are actually available.
    clone.compConstraints = this.compConstraints;
    clone._strictUniqueness = this._strictUniqueness;
    // Suppress the propagate()-internal lookahead phase. Hint's only
    // permitted lookahead is the line-restricted fallback below.
    clone._depth = 1;
    const before = new Int8Array(clone.grid);
    let ok = clone.propagate();
    if (!ok) return null;

    // If local rules deduced nothing, progressive fallbacks (cheapest first):
    //   1. Per-line enumeration: enumerate valid completions per row/column
    //      (with comparison-clue awareness), force cells whose value is
    //      consistent across all completions. Fast on lines with tractable
    //      combo counts; skips lines whose enumeration would blow the budget.
    //   2. Unrestricted 1-pass lookahead: for each empty cell, probe both
    //      values via local-rule propagation; force the survivor if exactly
    //      one is legal. Strictly stronger than the older line-restricted
    //      version since it sees forces across all line patterns. Capped at
    //      ONE pass (not iterated to fixed point) so Hint stays bounded —
    //      the iterated form lives in solve()'s propagate() lookahead phase.
    let localChanged = false;
    for (let i = 0; i < before.length; i++) {
      if (before[i] !== clone.grid[i]) { localChanged = true; break; }
    }
    if (!localChanged) {
      ok = clone._applyLineEnumeration(() => {});
      if (!ok) return null;
      // Cascade local rules over enumeration's new forces.
      if (clone.grid.some((v, i) => v !== before[i])) {
        ok = clone.propagate();
        if (!ok) return null;
      }
      // If enumeration found nothing, try unrestricted single-pass lookahead.
      let stillNothing = true;
      for (let i = 0; i < before.length; i++) {
        if (before[i] !== clone.grid[i]) { stillNothing = false; break; }
      }
      if (stillNothing) {
        clone._inLookahead = true;
        try {
          ok = clone._applyLookahead(() => {});
        } finally {
          clone._inLookahead = false;
        }
        if (!ok) return null;
        // Cascade local rules over lookahead's new forces.
        if (clone.grid.some((v, i) => v !== before[i])) {
          ok = clone.propagate();
          if (!ok) return null;
        }
      }
    }

    const forced = [];
    for (let i = 0; i < before.length; i++) {
      if (before[i] === 0 && clone.grid[i] !== 0) {
        const r = (i / clone.cols) | 0;
        const c = i % clone.cols;
        forced.push({ row: r, col: c, value: clone.grid[i] });
      }
    }
    if (forced.length === 0) return null;

    // Anchor on the first cell's row. Same-row cells go in `cells` (indexed
    // by column); the rest go in `extraCells` with absolute (row, col).
    const base = forced[0];
    const cells = [];
    const extraCells = [];
    for (const f of forced) {
      if (f.row === base.row) cells.push({ index: f.col, value: f.value });
      else extraCells.push({ row: f.row, col: f.col, value: f.value });
    }
    return {
      type: 'row',
      index: base.row,
      clue: null,
      cells,
      extraCells,
      count: forced.length,
    };
  }

  _isComplete() {
    for (let i = 0; i < this.grid.length; i++) if (this.grid[i] === 0) return false;
    return true;
  }

  _gridTo2D() {
    const out = [];
    for (let r = 0; r < this.rows; r++) {
      const row = new Array(this.cols);
      for (let c = 0; c < this.cols; c++) row[c] = this.grid[r * this.cols + c];
      out[r] = row;
    }
    return out;
  }

  // Most-constrained empty cell: minimize (rowHalf - rowOnes[r]) + (colHalf - colOnes[c]).
  // Returns [r, c] or null if no empty cell.
  _pickBranchCell() {
    let bestR = -1, bestC = -1, bestScore = Infinity;
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        if (this._get(r, c) !== 0) continue;
        const score = (this.rowHalf - this.rowOnes[r]) + (this.colHalf - this.colOnes[c]);
        if (score < bestScore) { bestScore = score; bestR = r; bestC = c; }
      }
    }
    return bestR === -1 ? null : [bestR, bestC];
  }

  // Scan the entire grid for any three-in-a-row (horizontal or vertical).
  // Returns true if any triple of consecutive identical non-zero values is found.
  // Called after propagation to catch triples that _applyBalance or
  // _applyUniqueness may have introduced (those rules don't verify no-triples
  // for the cells they fill, and propagation only checks *empty* cells).
  _gridHasTriple() {
    const R = this.rows, C = this.cols;
    for (let r = 0; r < R; r++) {
      for (let c = 2; c < C; c++) {
        const v = this._get(r, c);
        if (v !== 0 && v === this._get(r, c - 1) && v === this._get(r, c - 2)) return true;
      }
    }
    for (let c = 0; c < C; c++) {
      for (let r = 2; r < R; r++) {
        const v = this._get(r, c);
        if (v !== 0 && v === this._get(r - 1, c) && v === this._get(r - 2, c)) return true;
      }
    }
    return false;
  }

  // When the grid is complete, verify uniqueness across all rows and cols.
  // Returns true if any two rows (or cols) are identical. Binairo Plus
  // (with comparison clues) relaxes uniqueness — see _strictUniqueness.
  _hasDuplicateLines() {
    if (!this._strictUniqueness) return false;
    const R = this.rows, C = this.cols;
    const rowMasks = new Set();
    for (let r = 0; r < R; r++) {
      let mask = 0;
      for (let c = 0; c < C; c++) if (this._get(r, c) === 1) mask |= (1 << c);
      if (rowMasks.has(mask)) return true;
      rowMasks.add(mask);
    }
    const colMasks = new Set();
    for (let c = 0; c < C; c++) {
      let mask = 0;
      for (let r = 0; r < R; r++) if (this._get(r, c) === 1) mask |= (1 << r);
      if (colMasks.has(mask)) return true;
      colMasks.add(mask);
    }
    return false;
  }

  _backtrack() {
    if (this._checkTimeout()) return false;
    const cell = this._pickBranchCell();
    if (!cell) {
      if (!this._isComplete()) return false;
      return !this._hasDuplicateLines();
    }
    const [r, c] = cell;
    this._depth++;
    try {
      for (const v of [1, 2]) {
        // Pre-check: the branch assignment itself must not create a triple
        // (propagation only catches triples through balance/uniqueness, not
        // through the bare backtrack assign).
        if (this._wouldCreateTriple(r, c, v)) continue;
        const mark = this.trail.length;
        this._assign(r, c, v);
        if (this.propagate()) {
          if (this._isComplete()) {
            if (!this._hasDuplicateLines()) return true;
          } else if (this._backtrack()) {
            return true;
          }
        }
        this._rollback(mark);
        if (this._timedOut) return false;
      }
    } finally {
      this._depth--;
    }
    return false;
  }

  static _solutionCache = new Map();
  static _maxSolutionCache = 50;

  static clearSolutionCache() {
    BinairoSolver._solutionCache.clear();
  }

  _cacheKey() {
    // FNV-1a over (rows, cols, flattened givens). Returns a 32-bit unsigned int as string.
    return String(hashFNV1a((mix) => {
      mix(this.rows);
      mix(this.cols);
      for (let r = 0; r < this.rows; r++) {
        const row = this.givens[r] || [];
        for (let c = 0; c < this.cols; c++) mix((row[c] | 0) + 2); // +2 to map -1..1 to 1..3
      }
      // Mix comparison constraints. Stable ordering is _decodeComparison's
      // emission order: outer row then col, with bit order (R-EQ, R-NE,
      // D-EQ, D-NE). Length sentinel up front so an empty list still mixes.
      mix(this.compConstraints.length);
      for (const k of this.compConstraints) {
        mix(k.aR); mix(k.aC); mix(k.bR); mix(k.bC);
        mix(k.sameSign ? 1 : 0);
      }
    }, false));
  }

  _storeInCache(key, grid) {
    const m = BinairoSolver._solutionCache;
    if (m.size >= BinairoSolver._maxSolutionCache) {
      const first = m.keys().next().value;
      m.delete(first);
    }
    // Store a deep copy so callers can't mutate the cached grid.
    m.set(key, grid.map(row => row.slice()));
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { BinairoSolver };
}
