'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ThermometersSolver } = require('../src/solvers/thermometers.js');

// Build a solver from thermos given as arrays of [r,c] pairs (compact), bulb first.
function mk(rows, cols, thermosRC, colClue, rowClue, maxMs) {
  const thermos = thermosRC.map((t) => t.map(([r, c]) => ({ r, c })));
  return new ThermometersSolver({ rows, cols, thermos, colClue, rowClue, maxMs });
}
// fill grid (1 filled / 0 empty) from a complete level assignment, for oracle tests.
function fillFromLevels(s, levels) {
  const g = Array.from({ length: s.rows }, () => new Array(s.cols).fill(0));
  for (let t = 0; t < s.T; t++) for (let i = 0; i < levels[t]; i++) { const cell = s.thermos[t][i]; g[cell.r][cell.c] = 1; }
  return g;
}

test('Thermometers oracle: prefix rule + exact counts', () => {
  // 1x3 single horizontal thermometer, bulb at (0,0) filling right.
  const s = mk(1, 3, [[[0, 0], [0, 1], [0, 2]]], [1, 1, 0], [2]);
  assert.equal(s._isValid([[1, 1, 0]]), true);   // prefix of length 2, counts match
  assert.equal(s._isValid([[1, 0, 1]]), false);  // not a prefix (gap) — breaks prefix rule
  assert.equal(s._isValid([[1, 1, 1]]), false);  // counts wrong (row clue 2, got 3)
  // 2x1 vertical thermometer bulb at (0,0): filling must start at the bulb.
  const v = mk(2, 1, [[[0, 0], [1, 0]]], [1], [0, 1]);
  assert.equal(v._isValid([[0], [1]]), false);   // (1,0) filled but bulb (0,0) empty -> not a prefix
});

test('Thermometers propagation: contribution-bound forces a prefix from a column clue', () => {
  // Two vertical thermometers side by side, each length 3, bulbs at top.
  // Col 0 clue 2 -> exactly the first 2 cells of thermo 0 filled. Pure propagation decides it.
  const s = mk(3, 2,
    [[[0, 0], [1, 0], [2, 0]], [[0, 1], [1, 1], [2, 1]]],
    [2, 0], [1, 1, 0]);
  s.lo = new Array(s.T).fill(0); s.hi = s.len.slice();
  assert.equal(s._propagate(), true);
  // thermo 0 (col 0): level forced to exactly 2; thermo 1 (col 1): level forced to 0
  assert.equal(s.lo[0], 2); assert.equal(s.hi[0], 2);
  assert.equal(s.lo[1], 0); assert.equal(s.hi[1], 0);
});

test('Thermometers getHint: returns newly-forced cells (1 filled / 2 empty)', () => {
  const s = mk(3, 2,
    [[[0, 0], [1, 0], [2, 0]], [[0, 1], [1, 1], [2, 1]]],
    [2, 0], [1, 1, 0], 1000);
  const forced = s.getHint([[0, 0], [0, 0], [0, 0]]); // blank board (cellStatus all 0)
  // col-0 thermo: (0,0),(1,0) filled, (2,0) empty; col-1 thermo: all empty
  assert.ok(forced.some((f) => f.row === 0 && f.col === 0 && f.value === 1));
  assert.ok(forced.some((f) => f.row === 2 && f.col === 0 && f.value === 2));
  assert.ok(forced.some((f) => f.row === 0 && f.col === 1 && f.value === 2));
  assert.ok(forced.every((f) => f.value === 1 || f.value === 2));
});

function rng(seed) { let x = seed >>> 0; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; }; }

// Random thermometer tiling via randomized orthogonal chain walks (chain order = bulb->tip).
function randomTiling(rnd, rows, cols) {
  const used = Array.from({ length: rows }, () => new Array(cols).fill(false));
  const D = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  const thermos = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (used[r][c]) continue;
    const chain = [{ r, c }]; used[r][c] = true; let cr = r, cc = c;
    const maxLen = 1 + Math.floor(rnd() * 4);
    while (chain.length < maxLen) {
      const nbrs = [];
      for (const [dr, dc] of D) { const nr = cr + dr, nc = cc + dc; if (nr >= 0 && nc >= 0 && nr < rows && nc < cols && !used[nr][nc]) nbrs.push([nr, nc]); }
      if (!nbrs.length) break;
      const [nr, nc] = nbrs[Math.floor(rnd() * nbrs.length)];
      used[nr][nc] = true; chain.push({ r: nr, c: nc }); cr = nr; cc = nc;
    }
    thermos.push(chain);
  }
  return thermos;
}

test('Thermometers soundness gate: solver matches brute-force across random tiny boards', () => {
  let tested = 0, mismatches = 0;
  for (let iter = 0; iter < 8000 && tested < 300; iter++) {
    const rnd = rng(iter * 2654435761 + 12345);
    const rows = 2 + Math.floor(rnd() * 3), cols = 2 + Math.floor(rnd() * 3); // 2..4
    const thermos = randomTiling(rnd, rows, cols);
    let total = 1; for (const t of thermos) total *= (t.length + 1);
    if (total > 500000) continue;
    // random fill -> derived clues (guarantees >=1 solution)
    const lvl = thermos.map((t) => Math.floor(rnd() * (t.length + 1)));
    const s0 = new ThermometersSolver({ rows, cols, thermos, colClue: new Array(cols).fill(0), rowClue: new Array(rows).fill(0) });
    const g0 = fillFromLevels(s0, lvl);
    const rowClue = new Array(rows).fill(0), colClue = new Array(cols).fill(0);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (g0[r][c]) { rowClue[r]++; colClue[c]++; }
    const s = new ThermometersSolver({ rows, cols, thermos, colClue, rowClue, maxMs: 4000 });
    // brute force: enumerate all level combos, count oracle-valid
    let bf = 0; const lens = thermos.map((t) => t.length); const combo = new Array(s.T).fill(0);
    for (let x = 0; x < total; x++) {
      let y = x; for (let t = 0; t < s.T; t++) { combo[t] = y % (lens[t] + 1); y = (y / (lens[t] + 1)) | 0; }
      if (s._isValid(fillFromLevels(s, combo))) bf++;
    }
    tested++;
    const res = s.solve(true);
    if (!!res.solved !== (bf > 0)) { mismatches++; continue; }
    if (res.solved) {
      const fill = res.grid.map((row) => row.map((v) => (v === 1 ? 1 : 0)));
      if (!s._isValid(fill)) mismatches++;
      if ((res.count === 1) !== (bf === 1)) mismatches++;
    }
  }
  assert.equal(mismatches, 0, `gate mismatches=${mismatches} (tested=${tested})`);
  assert.ok(tested >= 150, `gate exercised too few boards (${tested})`);
});
