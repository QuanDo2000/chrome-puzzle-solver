'use strict';

const { lruSet } = require('./shared.js');

class AquariumSolver {
  /**
   * @param {number[]} rowClues  Water count per row, top-to-bottom.
   * @param {number[]} colClues  Water count per column, left-to-right.
   * @param {number[][]} regionMap  rows × cols matrix of region IDs. Each
   *   region is one connected aquarium; water within it obeys gravity (if
   *   any cell at row r is water, every cell at row >= r in that region is
   *   too).
   * @param {number} rows
   * @param {number} cols
   */
  constructor(rowClues, colClues, regionMap, rows, cols) {
    this.rows = rows;
    this.cols = cols;
    this.rowClues = rowClues;
    this.colClues = colClues;
    this._cellsCount = rows * cols;
    // Soft wall-clock budget. 0 = unlimited (matches the small-puzzle case in
    // NonogramSolver/GalaxiesSolver). Checked sparsely in the search hot
    // loops to keep Date.now() overhead negligible.
    this.maxMs = rows * cols >= 400 ? 8000 : 0;
    this.startedAt = 0;
    this.timedOut = false;

    const raw = {};
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const id = regionMap[r][c];
        (raw[id] || (raw[id] = [])).push(r * cols + c);
      }

    this.aquariums = [];
    for (const id in raw) {
      const cellList = raw[id];
      const byRow = {};
      for (const idx of cellList) {
        const rr = Math.floor(idx / cols);
        let entry = byRow[rr];
        if (!entry) byRow[rr] = entry = { row: rr, count: 0, cells: [] };
        entry.count++;
        entry.cells.push(idx);
      }
      const groups = Object.values(byRow).sort((a, b) => a.row - b.row);
      const maxLvl = groups.length;
      const tRows = [], tCols = [];
      for (const g of groups) {
        tRows.push(g.row);
        for (const idx of g.cells) { const c = idx % cols; if (tCols.indexOf(c) < 0) tCols.push(c); }
      }

      // contribs[lvl].rc[r] = # cells this aquarium fills in row r at water lvl.
      // contribs[lvl].cc[c] = # cells this aquarium fills in col c at water lvl.
      // Dense Int32Arrays (length rows/cols) rather than sparse objects: faster
      // lookups in the _solveRepair / _dpPreprocess hot loops and no `|| 0`.
      const contribs = [];
      for (let lvl = 0; lvl <= maxLvl; lvl++) {
        const rc = new Int32Array(rows);
        const cc = new Int32Array(cols);
        for (let i = maxLvl - lvl; i < maxLvl; i++) {
          const g = groups[i];
          rc[g.row] += g.count;
          for (const idx of g.cells) cc[idx % cols] += 1;
        }
        contribs.push({ rc, cc });
      }
      this.aquariums.push({ id, idx: this.aquariums.length, groups, maxLvl, contribs, tRows, tCols });
    }

    this.waterLevel = {};
    this.d = {};
    for (const aq of this.aquariums) {
      this.waterLevel[aq.id] = -1;
      this.d[aq.id] = { mn: 0, mx: aq.maxLvl };
    }
    this._kc = new Int8Array(this._cellsCount);
    this._searchNodes = 0;
    this._maxSearchNodes = 50000;
    this._deadCache = new Map();
    this._deadCacheMax = 200000;
    this._dpCache = new Map();
    this._dpCacheMax = 500000;
    this._nogoods = [];
    this._nogoodSet = new Set();
    this._nogoodIndex = new Map();
    this._nogoodMax = 50000;
    this._nogoodMaxTerms = 18;
    this._bestPartial = null;
    this._bestPartialFilled = 0;
  }

  /**
   * @param {number[][] | null} initialGrid  Optional partial state (1/-1/0).
   * @returns {SolveResult}
   */
  solve(initialGrid) {
    this._searchNodes = 0;
    this._deadCache.clear();
    this._dpCache.clear();
    this._nogoods = [];
    this._nogoodSet.clear();
    this._nogoodIndex.clear();
    this._bestPartial = null;
    this._bestPartialFilled = 0;
    this._kc.fill(0);
    this.startedAt = Date.now();
    this.timedOut = false;
    if (initialGrid)
      for (let r = 0; r < this.rows; r++)
        for (let c = 0; c < this.cols; c++) {
          const v = initialGrid[r][c];
          if (v !== 0) this._kc[r * this.cols + c] = v;
        }

    for (const aq of this.aquariums) this._initRange(aq);
    this._propagate();
    this._rememberPartial();

    if (this._allAssigned()) {
      this._buildGrid();
      if (!this._verify()) return { solved: false, error: 'verification failed' };
      return { solved: true, grid: this.grid };
    }

    this._dpPreprocess();
    if (!this._dpPairwise() || !this._propagate()) {
      // DP may have partially modified ranges — restore to pre-DP state
      this._deadCache.clear();
      this._dpCache.clear();
      this._nogoods = [];
      this._nogoodSet.clear();
      this._nogoodIndex.clear();
      for (const aq of this.aquariums) { this.waterLevel[aq.id] = -1; this._initRange(aq); }
      this._propagate();
    }
    this._rememberPartial();

    if (this._allAssigned()) {
      this._buildGrid();
      if (!this._verify()) return { solved: false, error: 'verification failed' };
      return { solved: true, grid: this.grid };
    }

    const repair = this._solveRepair();
    if (repair?.solved) {
      this._buildGrid();
      if (!this._verify()) return { solved: false, error: 'verification failed' };
      return { solved: true, grid: this.grid };
    }

    const result = this._backtrack();
    if (!result.solved) {
      return this._withPartial(result);
    }
    this._buildGrid();
    if (!this._verify()) return { solved: false, error: 'verification failed' };
    return { solved: true, grid: this.grid };
  }

  _withPartial(result) {
    if (!result.error) result.error = 'no solution found';
    if (this._bestPartial) {
      result.partialGrid = this._bestPartial.map(row => row.slice());
      result.partialFilled = this._bestPartialFilled;
    }
    return result;
  }

  _rememberPartial() {
    this._buildGrid();
    let filled = 0;
    for (const row of this.grid) for (const v of row) if (v !== 0) filled++;
    if (filled > this._bestPartialFilled) {
      this._bestPartialFilled = filled;
      this._bestPartial = this.grid.map(row => row.slice());
    }
  }

  _snap() {
    const N = this.aquariums.length;
    const mn = new Int32Array(N), mx = new Int32Array(N), wl = new Int32Array(N);
    for (let i = 0; i < N; i++) {
      const aq = this.aquariums[i];
      mn[i] = this.d[aq.id].mn; mx[i] = this.d[aq.id].mx; wl[i] = this.waterLevel[aq.id];
    }
    return { mn, mx, wl };
  }

  _restore(s) {
    for (let i = 0; i < this.aquariums.length; i++) {
      const aq = this.aquariums[i];
      this.d[aq.id].mn = s.mn[i]; this.d[aq.id].mx = s.mx[i]; this.waterLevel[aq.id] = s.wl[i];
    }
  }

  _initRange(aq) {
    let mn = 0, mx = aq.maxLvl;
    const kc = this._kc;
    for (let i = 0; i < aq.maxLvl; i++) {
      let water = false, air = false;
      for (const idx of aq.groups[i].cells) {
        const v = kc[idx];
        if (v === 1) water = true;
        else if (v === -1) air = true;
        if (water && air) break;
      }
      if (water) mn = Math.max(mn, aq.maxLvl - i);
      if (air) mx = Math.min(mx, aq.maxLvl - i - 1);
    }
    this.d[aq.id].mn = mn; this.d[aq.id].mx = mx;
  }

  _allAssigned() {
    for (const aq of this.aquariums) if (this.waterLevel[aq.id] < 0) return false;
    return true;
  }

  _propagate() {
    const rowC = this.rows, colC = this.cols;
    const rc = this.rowClues, cc = this.colClues;

    const baseRL = Array(rowC).fill(0), baseRH = Array(rowC).fill(0);
    const baseCL = Array(colC).fill(0), baseCH = Array(colC).fill(0);

    const vars = [];
    for (const aq of this.aquariums) {
      if (this.waterLevel[aq.id] >= 0) {
        const ct = aq.contribs[this.waterLevel[aq.id]];
        for (let r = 0; r < rowC; r++) { const v = ct.rc[r]; baseRL[r] += v; baseRH[r] += v; }
        for (let c = 0; c < colC; c++) { const v = ct.cc[c]; baseCL[c] += v; baseCH[c] += v; }
      } else {
        vars.push(aq);
      }
    }

    // bounds check even when all assigned
    {
      const rowLo = baseRL.slice(), rowHi = baseRH.slice();
      const colLo = baseCL.slice(), colHi = baseCH.slice();
      for (const aq of vars) {
        if (this.waterLevel[aq.id] >= 0) continue;
        const { mn, mx } = this.d[aq.id];
        const clo = aq.contribs[mn], chi = aq.contribs[mx];
        for (let r = 0; r < rowC; r++) { rowLo[r] += clo.rc[r]; rowHi[r] += chi.rc[r]; }
        for (let c = 0; c < colC; c++) { colLo[c] += clo.cc[c]; colHi[c] += chi.cc[c]; }
      }
      for (let r = 0; r < rowC; r++) if (rowLo[r] > rc[r] || rowHi[r] < rc[r]) return false;
      for (let c = 0; c < colC; c++) if (colLo[c] > cc[c] || colHi[c] < cc[c]) return false;
    }
    if (vars.length === 0) return true;

    let it = 0;
    while (it++ < 100) {
      let ch = false;

      const rowLo = baseRL.slice(), rowHi = baseRH.slice();
      const colLo = baseCL.slice(), colHi = baseCH.slice();

      for (const aq of vars) {
        if (this.waterLevel[aq.id] >= 0) continue;
        const { mn, mx } = this.d[aq.id];
        const clo = aq.contribs[mn], chi = aq.contribs[mx];
        for (let r = 0; r < rowC; r++) { rowLo[r] += clo.rc[r]; rowHi[r] += chi.rc[r]; }
        for (let c = 0; c < colC; c++) { colLo[c] += clo.cc[c]; colHi[c] += chi.cc[c]; }
      }

      for (let r = 0; r < rowC; r++) if (rowLo[r] > rc[r] || rowHi[r] < rc[r]) return false;
      for (let c = 0; c < colC; c++) if (colLo[c] > cc[c] || colHi[c] < cc[c]) return false;

      for (const aq of vars) {
        if (this.waterLevel[aq.id] >= 0) continue;
        const { mn, mx } = this.d[aq.id];
        for (let r = 0; r < rowC; r++) {
          const otherLo = rowLo[r] - (aq.contribs[mn].rc[r]);
          const otherHi = rowHi[r] - (aq.contribs[mx].rc[r]);
          const needed = rc[r] - otherHi, avail = rc[r] - otherLo;
          if (needed > 0 || avail <= 0) {
            let nm = mx, nx = mn;
            for (let l = mn; l <= mx; l++) {
              const c = aq.contribs[l].rc[r];
              if (c >= needed && c <= avail) {
                if (l < nm) nm = l;
                if (l > nx) nx = l;
              }
            }
            if (nm !== mn || nx !== mx) {
              const newMn = Math.max(this.d[aq.id].mn, nm);
              const newMx = Math.min(this.d[aq.id].mx, nx);
              if (newMn > newMx) return false;
              if (newMn !== this.d[aq.id].mn || newMx !== this.d[aq.id].mx) {
                this.d[aq.id].mn = newMn; this.d[aq.id].mx = newMx; ch = true;
              }
            }
          }
        }
        const nmn = this.d[aq.id].mn, nmx = this.d[aq.id].mx;
        for (let c = 0; c < colC; c++) {
          const otherLo = colLo[c] - (aq.contribs[nmn].cc[c]);
          const otherHi = colHi[c] - (aq.contribs[nmx].cc[c]);
          const needed = cc[c] - otherHi, avail = cc[c] - otherLo;
          if (needed > 0 || avail <= 0) {
            let nm = nmx, nx = nmn;
            for (let l = nmn; l <= nmx; l++) {
              const ccv = aq.contribs[l].cc[c];
              if (ccv >= needed && ccv <= avail) {
                if (l < nm) nm = l;
                if (l > nx) nx = l;
              }
            }
            if (nm !== nmn || nx !== nmx) {
              this.d[aq.id].mn = nm; this.d[aq.id].mx = nx; ch = true;
              if (nm > nx) return false;
            }
          }
        }
      }

      let vi = 0;
      while (vi < vars.length) {
        const aq = vars[vi];
        if (this.waterLevel[aq.id] >= 0) { vi++; continue; }
        const { mn, mx } = this.d[aq.id];
        if (mn > mx) return false;
        if (mn === mx) {
          this.waterLevel[aq.id] = mn;
          const ct = aq.contribs[mn];
          for (let r = 0; r < rowC; r++) { const v = ct.rc[r]; baseRL[r] += v; baseRH[r] += v; rowLo[r] += v; rowHi[r] += v; }
          for (let c = 0; c < colC; c++) { const v = ct.cc[c]; baseCL[c] += v; baseCH[c] += v; colLo[c] += v; colHi[c] += v; }
          vars.splice(vi, 1);
          ch = true;
          continue;
        }
        vi++;
      }

      if (!ch) break;
    }
    return true;
  }

  _dpPreprocess() {
    const rowC = this.rows, colC = this.cols;
    const rc = this.rowClues, cc = this.colClues;

    for (let pass = 0; pass < 5; pass++) {
      const baseR = Array(rowC).fill(0), baseC = Array(colC).fill(0);
      const vars = [];
      for (const aq of this.aquariums) {
        if (this.waterLevel[aq.id] >= 0) {
          const ct = aq.contribs[this.waterLevel[aq.id]];
          for (let r = 0; r < rowC; r++) { const v = ct.rc[r]; baseR[r] += v; }
          for (let c = 0; c < colC; c++) { const v = ct.cc[c]; baseC[c] += v; }
        } else {
          vars.push(aq);
        }
      }
      if (vars.length < 2) return;

      const rLookup = Array.from({ length: rowC }, () => []);
      const cLookup = Array.from({ length: colC }, () => []);
      for (const aq of vars) {
        for (const r of aq.tRows) rLookup[r].push(aq);
        for (const c of aq.tCols) cLookup[c].push(aq);
      }

      const narrow = (lineVars, getContrib, clue, cachePrefix) => {
        const N = lineVars.length;
        if (N < 2 || clue <= 0) return { ok: true };
        const cacheKey = cachePrefix + ':' + clue + ':' + lineVars.map(aq => {
          const d = this.d[aq.id];
          return aq.id + '=' + d.mn + '-' + d.mx;
        }).join(',');
        const cached = this._cacheGet(cacheKey);
        if (cached !== undefined) {
          if (cached === null) return { ok: false };
          let narrowed = false;
          for (let i = 0; i < N; i++) {
            const aq = lineVars[i];
            const d = this.d[aq.id];
            const [mn, mx] = cached[i];
            if (mn > mx) return { ok: false };
            if (mn !== d.mn || mx !== d.mx) {
              d.mn = mn;
              d.mx = mx;
              narrowed = true;
            }
          }
          return { ok: true, narrowed };
        }
        const stride = clue + 1;
        const dp = new Uint8Array((N + 1) * stride);
        dp[0] = 1;
        for (let i = 0; i < N; i++) {
          const aq = lineVars[i];
          const { mn, mx } = this.d[aq.id];
          const bi = i * stride, ni = (i + 1) * stride;
          let any = 0;
          for (let s = 0; s <= clue; s++) {
            if (!dp[bi + s]) continue;
            for (let l = mn; l <= mx; l++) {
              const c = getContrib(aq, l);
              const ns = s + c;
              if (ns <= clue) { dp[ni + ns] = 1; any = 1; }
            }
          }
          if (!any) { this._cacheSet(cacheKey, null); return { ok: false }; }
        }
        if (!dp[N * stride + clue]) { this._cacheSet(cacheKey, null); return { ok: false }; }

        let narrowed = false;
        const cachedRanges = [];
        for (let i = N - 1; i >= 0; i--) {
          const aq = lineVars[i];
          const d = this.d[aq.id];
          const om = d.mn, ox = d.mx;
          let nm = ox, nx = om;
          const bi = i * stride, ni = (i + 1) * stride;
          for (let s = 0; s <= clue; s++) {
            if (!dp[bi + s]) continue;
            for (let l = om; l <= ox; l++) {
              const c = getContrib(aq, l);
              const ns = s + c;
              if (ns <= clue && dp[ni + ns]) {
                if (l < nm) nm = l;
                if (l > nx) nx = l;
              }
            }
          }
          if (nm > nx) { this._cacheSet(cacheKey, null); return { ok: false }; }
          if (nm !== om || nx !== ox) { d.mn = nm; d.mx = nx; narrowed = true; }
          cachedRanges[i] = [nm, nx];
        }
        this._cacheSet(cacheKey, cachedRanges);
        return { ok: true, narrowed };
      };

      let changed = false;
      for (let r = 0; r < rowC; r++) {
        const adj = rc[r] - baseR[r];
        if (adj < 0) return;
        if (rLookup[r].length > 1 && adj > 0) {
          const nr = narrow(rLookup[r], (aq, l) => aq.contribs[l].rc[r], adj, 'r' + r);
          if (!nr.ok) return;
          if (nr.narrowed) changed = true;
        }
      }
      for (let c = 0; c < colC; c++) {
        const adj = cc[c] - baseC[c];
        if (adj < 0) return;
        if (cLookup[c].length > 1 && adj > 0) {
          const nr = narrow(cLookup[c], (aq, l) => aq.contribs[l].cc[c], adj, 'c' + c);
          if (!nr.ok) return;
          if (nr.narrowed) changed = true;
        }
      }

      // After DP, auto-fix any singletons
      for (const aq of vars) {
        if (this.waterLevel[aq.id] >= 0) continue;
        const { mn, mx } = this.d[aq.id];
        if (mn === mx && mn >= 0) {
          this.waterLevel[aq.id] = mn;
          changed = true;
        }
      }

      if (!changed) break;
    }
  }

  _dpPairwise() {
    const H = this.rows, W = this.cols;
    const rc = this.rowClues, cc = this.colClues;

    const baseR = Array(H).fill(0), baseC = Array(W).fill(0);
    const allVars = [], idMap = {};
    for (const aq of this.aquariums) {
      idMap[aq.id] = allVars.length;
      if (this.waterLevel[aq.id] >= 0) {
        const ct = aq.contribs[this.waterLevel[aq.id]];
        for (let r = 0; r < H; r++) { const v = ct.rc[r]; baseR[r] += v; }
        for (let c = 0; c < W; c++) { const v = ct.cc[c]; baseC[c] += v; }
      } else {
        allVars.push(aq);
      }
    }

    // Build for each row the list of variable indices that have cells in that row
    const rowVars = Array.from({ length: H }, () => []);
    for (let vi = 0; vi < allVars.length; vi++) {
      const aq = allVars[vi];
      for (const r of aq.tRows) rowVars[r].push(vi);
    }

    // Process adjacent row pairs
    for (let r = 0; r < H - 1; r++) {
      const adj1 = rc[r] - baseR[r], adj2 = rc[r + 1] - baseR[r + 1];
      if (adj1 < 0 || adj2 < 0) return false;

      const viSet = new Set([...rowVars[r], ...rowVars[r + 1]]);
      const vList = [...viSet];
      if (vList.length < 2) continue;

      const ranges = [];
      const vars = [];
      for (const vi of vList) {
        const aq = allVars[vi];
        if (this.waterLevel[aq.id] >= 0) continue;
        const { mn, mx } = this.d[aq.id];
        ranges.push(this.d[aq.id]);
        const levels = [];
        for (let l = mn; l <= mx; l++) levels.push(l);
        vars.push({ levels, id: aq.id });
      }
      if (vars.length < 2) continue;

      const getPair = (lvl, id) => {
        const aq = allVars[idMap[id]];
        const ct = aq.contribs[lvl];
        return [(ct.rc[r]), (ct.rc[r + 1])];
      };

      const res = this._narrowLevels(adj1, adj2, vars, getPair, ranges, 'rr' + r);
      if (!res.ok) return false;
    }

    // Process adjacent column pairs
    const colVars = Array.from({ length: W }, () => []);
    for (let vi = 0; vi < allVars.length; vi++) {
      const aq = allVars[vi];
      for (const c of aq.tCols) colVars[c].push(vi);
    }

    for (let c = 0; c < W - 1; c++) {
      const adj1 = cc[c] - baseC[c], adj2 = cc[c + 1] - baseC[c + 1];
      if (adj1 < 0 || adj2 < 0) return false;

      const viSet = new Set([...colVars[c], ...colVars[c + 1]]);
      const vList = [...viSet];
      if (vList.length < 2) continue;

      const ranges = [];
      const vars = [];
      for (const vi of vList) {
        const aq = allVars[vi];
        if (this.waterLevel[aq.id] >= 0) continue;
        const { mn, mx } = this.d[aq.id];
        ranges.push(this.d[aq.id]);
        const levels = [];
        for (let l = mn; l <= mx; l++) levels.push(l);
        vars.push({ levels, id: aq.id });
      }
      if (vars.length < 2) continue;

      const getPair = (lvl, id) => {
        const aq = allVars[idMap[id]];
        const ct = aq.contribs[lvl];
        return [(ct.cc[c]), (ct.cc[c + 1])];
      };

      const res = this._narrowLevels(adj1, adj2, vars, getPair, ranges, 'cc' + c);
      if (!res.ok) return false;
    }

    return true;
  }

  _levelOrder(mn, mx) {
    const order = [];
    let lo = mn, hi = mx;
    while (lo <= hi) {
      order.push(lo);
      if (lo !== hi) order.push(hi);
      lo++; hi--;
    }
    return order;
  }

  // Two-dimensional DP that narrows each variable's water-level range so the
  // pair of clue sums (pairClue1, pairClue2) is still reachable across the
  // adjacent row/col pair. Memoized via _cacheGet / _cacheSet. Extracted from
  // _dpPairwise.
  //   vars     : [{ id, levels: [lvl...] }, ...]
  //   getPair  : (lvl, id) → [contribClue1, contribClue2]
  //   ranges   : aligned with vars; each {mn, mx} gets tightened in place.
  // Returns { ok: false } on contradiction, otherwise { ok: true, changed }.
  _narrowLevels(pairClue1, pairClue2, vars, getPair, ranges, cachePrefix) {
    const n = vars.length;
    if (n === 0) return { ok: true, changed: false };
    const cacheKey = cachePrefix + ':' + pairClue1 + ',' + pairClue2 + ':' + vars.map((v, i) => {
      const d = ranges[i];
      return v.id + '=' + d.mn + '-' + d.mx;
    }).join(',');
    const cached = this._cacheGet(cacheKey);
    if (cached !== undefined) {
      if (cached === null) return { ok: false };
      let changed = false;
      for (let i = 0; i < n; i++) {
        const d = ranges[i];
        const [mn, mx] = cached[i];
        if (mn > mx) return { ok: false };
        if (mn !== d.mn || mx !== d.mx) { d.mn = mn; d.mx = mx; changed = true; }
      }
      return { ok: true, changed };
    }
    const max1 = pairClue1, max2 = pairClue2;
    const sz1 = max1 + 1, sz2 = max2 + 1;

    // Forward DP
    const fwd = new Array(n + 1);
    fwd[0] = new Uint8Array(sz1 * sz2);
    fwd[0][0] = 1;
    for (let i = 0; i < n; i++) {
      const cur = fwd[i];
      const next = new Uint8Array(sz1 * sz2);
      const { levels } = vars[i];
      for (let s = 0; s < sz1 * sz2; s++) {
        if (!cur[s]) continue;
        const s1 = Math.floor(s / sz2), s2 = s % sz2;
        for (const lvl of levels) {
          const [c1, c2] = getPair(lvl, vars[i].id);
          const ns1 = s1 + c1, ns2 = s2 + c2;
          if (ns1 <= max1 && ns2 <= max2) next[ns1 * sz2 + ns2] = 1;
        }
      }
      fwd[i + 1] = next;
    }

    // Backward DP
    const bwd = new Array(n + 1);
    bwd[n] = new Uint8Array(sz1 * sz2);
    bwd[n][0] = 1;
    for (let i = n - 1; i >= 0; i--) {
      const cur = bwd[i + 1];
      const next = new Uint8Array(sz1 * sz2);
      const { levels } = vars[i];
      for (let s = 0; s < sz1 * sz2; s++) {
        if (!cur[s]) continue;
        const s1 = Math.floor(s / sz2), s2 = s % sz2;
        for (const lvl of levels) {
          const [c1, c2] = getPair(lvl, vars[i].id);
          const ns1 = s1 + c1, ns2 = s2 + c2;
          if (ns1 <= max1 && ns2 <= max2) next[ns1 * sz2 + ns2] = 1;
        }
      }
      bwd[i] = next;
    }

    if (!fwd[n][pairClue1 * sz2 + pairClue2]) { this._cacheSet(cacheKey, null); return { ok: false }; }

    // For each variable, check each level
    let changed = false;
    const cachedRanges = [];
    for (let i = 0; i < n; i++) {
      const d = ranges[i];
      const { levels, id } = vars[i];
      let nmn = 999, nmx = -1;
      for (const lvl of levels) {
        const [c1, c2] = getPair(lvl, id);
        const need1 = pairClue1 - c1, need2 = pairClue2 - c2;
        if (need1 < 0 || need2 > max2) continue;
        // Check if fwd[i] + bwd[i+1] can fill need1, need2
        let ok = false;
        const f = fwd[i], b = bwd[i + 1];
        for (let s = 0; s < sz1 * sz2 && !ok; s++) {
          if (!f[s]) continue;
          const s1 = Math.floor(s / sz2), s2 = s % sz2;
          const r1 = need1 - s1, r2 = need2 - s2;
          if (r1 >= 0 && r1 <= max1 && r2 >= 0 && r2 <= max2 && b[r1 * sz2 + r2]) ok = true;
        }
        if (ok) {
          if (lvl < nmn) nmn = lvl;
          if (lvl > nmx) nmx = lvl;
        }
      }
      if (nmn > nmx) { this._cacheSet(cacheKey, null); return { ok: false }; }
      if (nmn !== d.mn || nmx !== d.mx) { d.mn = nmn; d.mx = nmx; changed = true; }
      cachedRanges[i] = [nmn, nmx];
    }
    this._cacheSet(cacheKey, cachedRanges);
    return { ok: true, changed };
  }

  _cacheKey() {
    const parts = [];
    for (const aq of this.aquariums) {
      const lvl = this.waterLevel[aq.id];
      if (lvl >= 0) {
        parts.push(lvl);
      } else {
        const d = this.d[aq.id];
        parts.push(d.mn, ':', d.mx);
      }
      parts.push('|');
    }
    return parts.join('');
  }

  _rememberDead(key) {
    if (this._deadCache.has(key)) return;
    lruSet(this._deadCache, this._deadCacheMax, key, 1);
  }

  _assignmentTokens() {
    const tokens = [];
    for (const aq of this.aquariums) {
      const lvl = this.waterLevel[aq.id];
      if (lvl >= 0) tokens.push(aq.id + '=' + lvl);
    }
    return tokens;
  }

  _learnNogood(tokens) {
    if (!tokens.length || tokens.length > this._nogoodMaxTerms) return;
    const key = tokens.join(',');
    if (this._nogoodSet.has(key)) return;
    if (this._nogoods.length >= this._nogoodMax) {
      const old = this._nogoods.shift();
      this._nogoodSet.delete(old.key);
      const bucket = this._nogoodIndex.get(old.first);
      if (bucket) {
        const idx = bucket.indexOf(old);
        if (idx >= 0) bucket.splice(idx, 1);
        if (bucket.length === 0) this._nogoodIndex.delete(old.first);
      }
    }
    const entry = { key, tokens: tokens.slice(), first: tokens[0] };
    this._nogoods.push(entry);
    this._nogoodSet.add(key);
    let bucket = this._nogoodIndex.get(entry.first);
    if (!bucket) this._nogoodIndex.set(entry.first, bucket = []);
    bucket.push(entry);
  }

  _hasNogood(tokens) {
    if (!tokens.length || this._nogoods.length === 0) return false;
    const tokenSet = new Set(tokens);
    for (const token of tokens) {
      const bucket = this._nogoodIndex.get(token);
      if (!bucket) continue;
      for (const entry of bucket) {
        if (entry.tokens.length > tokens.length) continue;
        let ok = true;
        for (const t of entry.tokens) {
          if (!tokenSet.has(t)) { ok = false; break; }
        }
        if (ok) return true;
      }
    }
    return false;
  }

  _cacheGet(key) {
    return this._dpCache.get(key);
  }

  _cacheSet(key, value) {
    if (this._dpCache.has(key)) return;
    lruSet(this._dpCache, this._dpCacheMax, key, value);
  }

  // Deterministic xorshift32 PRNG seeded from puzzle shape (clues + aquarium
  // sizes), so a re-run on the same puzzle picks the same repair path.
  _makeRepairRng(rc, cc, vars) {
    let seed = 2166136261;
    for (const n of rc.concat(cc)) seed = Math.imul(seed ^ n, 16777619) >>> 0;
    for (const aq of vars) seed = Math.imul(seed ^ (aq.maxLvl + aq.groups.length), 16777619) >>> 0;
    const rand = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 4294967296;
    };
    const pick = arr => arr[Math.floor(rand() * arr.length)];
    return { rand, pick };
  }

  _solveRepair(maxRestarts = 80, maxSteps = 12000) {
    const H = this.rows, W = this.cols;
    const rc = this.rowClues, cc = this.colClues;
    const vars = this.aquariums;

    // levels[aq.idx] = array of possible water levels for that aquarium.
    // Indexed by aq.idx (integer) rather than aq.id (string) — array lookup is
    // faster than object-property lookup in the inner repair loop.
    const levels = new Array(vars.length);
    for (let vi = 0; vi < vars.length; vi++) {
      const aq = vars[vi];
      if (this.waterLevel[aq.id] >= 0) {
        levels[vi] = [this.waterLevel[aq.id]];
      } else {
        const d = this.d[aq.id];
        if (d.mn > d.mx) return null;
        const out = [];
        for (let l = d.mn; l <= d.mx; l++) out.push(l);
        levels[vi] = out;
      }
    }

    // lineVars[line] = aquariums that touch that row/col AND have >1 possible
    // level. Pre-filtering by .length > 1 here (it's constant for this call)
    // saves a .filter() allocation in every step of the inner loop.
    const lineVars = Array.from({ length: H + W }, () => []);
    for (let vi = 0; vi < vars.length; vi++) {
      const aq = vars[vi];
      if (levels[vi].length <= 1) continue;
      for (let i = 0; i < aq.tRows.length; i++) lineVars[aq.tRows[i]].push(aq);
      for (let i = 0; i < aq.tCols.length; i++) lineVars[H + aq.tCols[i]].push(aq);
    }

    const { rand, pick } = this._makeRepairRng(rc, cc, vars);

    const violation = (rowS, colS) => {
      let v = 0;
      for (let r = 0; r < H; r++) v += Math.abs(rowS[r] - rc[r]);
      for (let c = 0; c < W; c++) v += Math.abs(colS[c] - cc[c]);
      return v;
    };

    for (let restart = 0; restart < maxRestarts; restart++) {
      // assign[aq.idx] = current water level. Int32Array vs object: faster
      // indexed access in the inner hot loop.
      const assign = new Int32Array(vars.length);
      const rowS = new Int32Array(H), colS = new Int32Array(W);

      for (let vi = 0; vi < vars.length; vi++) {
        const aq = vars[vi];
        const ls = levels[vi];
        const lvl = pick(ls);
        assign[vi] = lvl;
        const ct = aq.contribs[lvl];
        const ctRc = ct.rc, ctCc = ct.cc;
        for (let r = 0; r < H; r++) rowS[r] += ctRc[r];
        for (let c = 0; c < W; c++) colS[c] += ctCc[c];
      }

      let cur = violation(rowS, colS);
      for (let step = 0; step < maxSteps; step++) {
        if (this.maxMs && (step & 0xFF) === 0 &&
            Date.now() - this.startedAt > this.maxMs) {
          this.timedOut = true;
          return null;
        }
        if (cur === 0) {
          for (let vi = 0; vi < vars.length; vi++) {
            const aq = vars[vi];
            const lvl = assign[vi];
            this.waterLevel[aq.id] = lvl;
            this.d[aq.id].mn = this.d[aq.id].mx = lvl;
          }
          return { solved: true };
        }

        const badLines = [];
        for (let r = 0; r < H; r++) if (rowS[r] !== rc[r]) badLines.push(r);
        for (let c = 0; c < W; c++) if (colS[c] !== cc[c]) badLines.push(H + c);
        if (badLines.length === 0) continue;

        const line = pick(badLines);
        const candidates = lineVars[line];
        if (candidates.length === 0) continue;

        let bestMoves = [];
        let bestV = cur;
        for (let ci = 0; ci < candidates.length; ci++) {
          const aq = candidates[ci];
          const aqIdx = aq.idx;
          const oldLvl = assign[aqIdx];
          const oldCt = aq.contribs[oldLvl];
          const aqLevels = levels[aqIdx];
          const tRows = aq.tRows, tCols = aq.tCols;
          const tRowsLen = tRows.length, tColsLen = tCols.length;
          const oldRc = oldCt.rc, oldCc = oldCt.cc;
          for (let li = 0; li < aqLevels.length; li++) {
            const lvl = aqLevels[li];
            if (lvl === oldLvl) continue;
            const ct = aq.contribs[lvl];
            const ctRc = ct.rc, ctCc = ct.cc;
            let nextV = cur;
            for (let i = 0; i < tRowsLen; i++) {
              const r = tRows[i];
              const before = Math.abs(rowS[r] - rc[r]);
              const after = Math.abs(rowS[r] + ctRc[r] - oldRc[r] - rc[r]);
              nextV += after - before;
            }
            for (let i = 0; i < tColsLen; i++) {
              const c = tCols[i];
              const before = Math.abs(colS[c] - cc[c]);
              const after = Math.abs(colS[c] + ctCc[c] - oldCc[c] - cc[c]);
              nextV += after - before;
            }
            if (nextV < bestV) {
              bestV = nextV;
              bestMoves = [{ aq, aqIdx, lvl, oldCt, ct, nextV }];
            } else if (nextV === bestV) {
              bestMoves.push({ aq, aqIdx, lvl, oldCt, ct, nextV });
            }
          }
        }

        let move = null;
        let moveV = cur;
        if (bestMoves.length > 0 && (bestV < cur || rand() < 0.05)) {
          move = pick(bestMoves);
          moveV = move.nextV;
        } else {
          // Random move — compute its violation incrementally rather than
          // doing the full O(H+W) recompute after applying it.
          const aq = candidates[Math.floor(rand() * candidates.length)];
          const aqIdx = aq.idx;
          const oldLvl = assign[aqIdx];
          const aqLevels = levels[aqIdx];
          // Inline filter+pick to avoid array allocation.
          let pickIdx = Math.floor(rand() * (aqLevels.length - 1));
          let lvl = -1;
          for (let i = 0; i < aqLevels.length; i++) {
            if (aqLevels[i] === oldLvl) continue;
            if (pickIdx === 0) { lvl = aqLevels[i]; break; }
            pickIdx--;
          }
          const oldCt = aq.contribs[oldLvl];
          const ct = aq.contribs[lvl];
          const ctRc = ct.rc, ctCc = ct.cc, oldRc = oldCt.rc, oldCc = oldCt.cc;
          const tRows = aq.tRows, tCols = aq.tCols;
          let nextV = cur;
          for (let i = 0; i < tRows.length; i++) {
            const r = tRows[i];
            const before = Math.abs(rowS[r] - rc[r]);
            const after = Math.abs(rowS[r] + ctRc[r] - oldRc[r] - rc[r]);
            nextV += after - before;
          }
          for (let i = 0; i < tCols.length; i++) {
            const c = tCols[i];
            const before = Math.abs(colS[c] - cc[c]);
            const after = Math.abs(colS[c] + ctCc[c] - oldCc[c] - cc[c]);
            nextV += after - before;
          }
          move = { aq, aqIdx, lvl, oldCt, ct };
          moveV = nextV;
        }

        assign[move.aqIdx] = move.lvl;
        const mRc = move.ct.rc, mCc = move.ct.cc, moRc = move.oldCt.rc, moCc = move.oldCt.cc;
        const mTRows = move.aq.tRows, mTCols = move.aq.tCols;
        for (let i = 0; i < mTRows.length; i++) {
          const r = mTRows[i];
          rowS[r] += mRc[r] - moRc[r];
        }
        for (let i = 0; i < mTCols.length; i++) {
          const c = mTCols[i];
          colS[c] += mCc[c] - moCc[c];
        }
        cur = moveV;
      }
    }

    return null;
  }

  _backtrack() {
    if (++this._searchNodes > this._maxSearchNodes) {
      return { solved: false, error: 'search limit exceeded' };
    }
    // Time check every 1024 nodes — Date.now() is cheap but not free, and
    // 1024 nodes is well below the cost of a single millisecond of search.
    if (this.maxMs && (this._searchNodes & 0x3FF) === 0 &&
        Date.now() - this.startedAt > this.maxMs) {
      this.timedOut = true;
      return { solved: false, error: 'time limit exceeded' };
    }
    const assignedTokens = this._assignmentTokens();
    if (this._hasNogood(assignedTokens)) return { solved: false, error: 'contradiction' };

    let best = null;
    for (const aq of this.aquariums) {
      if (this.waterLevel[aq.id] >= 0) continue;
      const { mn, mx } = this.d[aq.id];
      if (mn > mx) return { solved: false };
      if (!best || (mx - mn) < (this.d[best.id].mx - this.d[best.id].mn)) best = aq;
    }
    if (!best) return { solved: true };

    const cacheKey = this._cacheKey();
    if (this._deadCache.has(cacheKey)) return { solved: false };

    const { mn, mx } = this.d[best.id];
forLoop:
    for (const lvl of this._levelOrder(mn, mx)) {
      const snap = this._snap();
      this.waterLevel[best.id] = lvl;
      this.d[best.id].mn = this.d[best.id].mx = lvl;
      const branchTokens = assignedTokens.concat(best.id + '=' + lvl);
      if (!this._propagate()) { this._learnNogood(branchTokens); this._restore(snap); continue; }
      this._rememberPartial();
      this._dpPreprocess();
      if (!this._dpPairwise()) { this._learnNogood(branchTokens); this._restore(snap); continue forLoop; }
      this._rememberPartial();
      for (const aq of this.aquariums) {
        if (this.waterLevel[aq.id] < 0 && this.d[aq.id].mn > this.d[aq.id].mx)
          { this._learnNogood(branchTokens); this._restore(snap); continue forLoop; }
      }

      if (this._allAssigned()) return { solved: true };

      const r = this._backtrack();
      if (r.solved) return r;
      if (r.error) { this._restore(snap); return r; }
      this._learnNogood(branchTokens);
      this._restore(snap);
    }
    this._learnNogood(assignedTokens);
    this._rememberDead(cacheKey);
    return { solved: false };
  }

  _buildGrid() {
    const cols = this.cols;
    this.grid = Array.from({ length: this.rows }, () => Array(cols).fill(0));
    for (const aq of this.aquariums) {
      const lvl = this.waterLevel[aq.id];
      if (lvl < 0) continue;
      for (let i = 0; i < aq.maxLvl; i++) {
        const isWater = i >= aq.maxLvl - lvl;
        const val = isWater ? 1 : -1;
        for (const idx of aq.groups[i].cells) this.grid[Math.floor(idx / cols)][idx % cols] = val;
      }
    }
  }

  _verify() {
    for (let r = 0; r < this.rows; r++) {
      let n = 0;
      for (let c = 0; c < this.cols; c++) if (this.grid[r][c] === 1) n++;
      if (n !== this.rowClues[r]) return false;
    }
    for (let c = 0; c < this.cols; c++) {
      let n = 0;
      for (let r = 0; r < this.rows; r++) if (this.grid[r][c] === 1) n++;
      if (n !== this.colClues[c]) return false;
    }
    for (const aq of this.aquariums) {
      let seenAir = false;
      for (let i = aq.maxLvl - 1; i >= 0; i--)
        for (const idx of aq.groups[i].cells) {
          const v = this.grid[Math.floor(idx / this.cols)][idx % this.cols];
          if (v === -1) seenAir = true;
          else if (v === 1 && seenAir) return false;
        }
    }
    return true;
  }

  isComplete() {
    for (let r = 0; r < this.rows; r++)
      for (let c = 0; c < this.cols; c++)
        if (this.grid[r][c] === 0) return false;
    return this._verify();
  }

  _findForcedCells(currentGrid) {
    const cm = Array.from({ length: this.rows }, () => Array(this.cols).fill(0));
    for (const aq of this.aquariums)
      for (const g of aq.groups)
        for (const idx of g.cells)
          cm[Math.floor(idx / this.cols)][idx % this.cols] = aq.id;
    const tmp = new AquariumSolver(this.rowClues, this.colClues, cm, this.rows, this.cols);
    const kc = tmp._kc;
    for (let r = 0; r < this.rows; r++)
      for (let c = 0; c < this.cols; c++) {
        const v = currentGrid[r][c];
        if (v !== 0) kc[r * this.cols + c] = v;
      }
    for (const aq of tmp.aquariums) tmp._initRange(aq);
    if (!tmp._propagate()) return null;

    const cellToGroup = new Map();
    for (const aq of tmp.aquariums)
      for (let i = 0; i < aq.maxLvl; i++)
        for (const idx of aq.groups[i].cells)
          cellToGroup.set(idx, { aq, groupIdx: i });

    const forced = [];
    for (const aq of tmp.aquariums) {
      const { mn, mx } = tmp.d[aq.id];
      const forcedWaterFrom = aq.maxLvl - mn;
      for (let i = 0; i < aq.maxLvl; i++) {
        let value = 0;
        if (i >= forcedWaterFrom) value = 1;
        else if (i < aq.maxLvl - mx) value = -1;
        if (value === 0) continue;
        for (const idx of aq.groups[i].cells) {
          const r = Math.floor(idx / this.cols);
          const c = idx % this.cols;
          if (currentGrid[r][c] === 0) forced.push({ row: r, col: c, value });
        }
      }
    }
    return forced.length > 0 ? forced : null;
  }

  getHint(currentGrid) {
    const forced = this._findForcedCells(currentGrid);
    if (forced) {
      const byRow = {};
      for (const f of forced) {
        if (!byRow[f.row]) byRow[f.row] = { cells: [] };
        byRow[f.row].cells.push({ index: f.col, value: f.value });
      }
      let bestR = -1, bestN = 0, bestCells = [];
      for (const r in byRow) {
        const row = parseInt(r);
        if (byRow[row].cells.length > bestN) {
          bestN = byRow[row].cells.length;
          bestR = row;
          bestCells = byRow[row].cells;
        }
      }
      if (bestR >= 0) return { type: 'row', index: bestR, clue: [this.rowClues[bestR]], cells: bestCells, count: bestCells.length };
    }

    let bestR = -1, bestC = -1, bestN = 0, bestCells = [], bestType = 'row';
    for (let r = 0; r < this.rows; r++) {
      let filled = 0, empty = 0;
      const ecells = [];
      for (let c = 0; c < this.cols; c++) {
        if (currentGrid[r][c] === 1) filled++;
        else if (currentGrid[r][c] === 0) { empty++; ecells.push(c); }
      }
      if (filled === this.rowClues[r]) {
        const cells = ecells.map(c => ({ index: c, value: -1 }));
        if (cells.length > bestN) { bestN = cells.length; bestR = r; bestCells = cells; bestType = 'row'; }
      } else if (this.rowClues[r] - filled === empty) {
        const cells = ecells.map(c => ({ index: c, value: 1 }));
        if (cells.length > bestN) { bestN = cells.length; bestR = r; bestCells = cells; bestType = 'row'; }
      }
    }
    for (let c = 0; c < this.cols; c++) {
      let filled = 0, empty = 0;
      const cells = [];
      for (let r = 0; r < this.rows; r++) {
        if (currentGrid[r][c] === 1) filled++;
        else if (currentGrid[r][c] === 0) { empty++; cells.push(r); }
      }
      if (filled === this.colClues[c]) {
        const cs = cells.map(r => ({ index: r, value: -1 }));
        if (cs.length > bestN) { bestN = cs.length; bestC = c; bestCells = cs; bestType = 'col'; }
      } else if (this.colClues[c] - filled === empty) {
        const cs = cells.map(r => ({ index: r, value: 1 }));
        if (cs.length > bestN) { bestN = cs.length; bestC = c; bestCells = cs; bestType = 'col'; }
      }
    }
    if (bestCells.length > 0) {
      return { type: bestType, index: bestType === 'row' ? bestR : bestC, clue: [bestType === 'row' ? this.rowClues[bestR] : this.colClues[bestC]], cells: bestCells, count: bestCells.length };
    }

    return null;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AquariumSolver };
}
