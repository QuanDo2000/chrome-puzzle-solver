// Targeted tests for NonogramSolver.solveLine. Cross-checks the forward+
// backward DP implementation against a brute-force enumerator on small lines.
// Brute force is correct by construction but exponential; solveLine is O(L·N).

const test = require('node:test');
const assert = require('node:assert/strict');
const { NonogramSolver } = require('../solver.js');

// Generate all 2^L completions of `line` (replacing 0 cells with -1 or 1).
function* completions(line) {
  const unknowns = [];
  for (let i = 0; i < line.length; i++) if (line[i] === 0) unknowns.push(i);
  const n = unknowns.length;
  const out = line.slice();
  for (let mask = 0; mask < (1 << n); mask++) {
    for (let b = 0; b < n; b++) out[unknowns[b]] = (mask >> b) & 1 ? 1 : -1;
    yield out;
  }
}

// Extract the run-length encoding of filled cells (1s) in a fully-known line.
function runs(line) {
  const r = [];
  let count = 0;
  for (const v of line) {
    if (v === 1) count++;
    else if (count > 0) { r.push(count); count = 0; }
  }
  if (count > 0) r.push(count);
  return r;
}

function arrayEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Brute-force solveLine: returns null if no valid completion, else per-cell
// forced values (0 = unknown, 1 = forced filled, -1 = forced empty).
function bruteSolveLine(clues, line) {
  const validConfigs = [];
  for (const c of completions(line)) {
    if (arrayEqual(runs(c), clues)) validConfigs.push(c.slice());
  }
  if (validConfigs.length === 0) return null;
  const result = new Array(line.length);
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== 0) { result[i] = line[i]; continue; }
    const seenFilled = validConfigs.some(c => c[i] === 1);
    const seenEmpty = validConfigs.some(c => c[i] === -1);
    if (seenFilled && !seenEmpty) result[i] = 1;
    else if (seenEmpty && !seenFilled) result[i] = -1;
    else result[i] = 0;
  }
  return result;
}

function check(clues, line) {
  const solver = new NonogramSolver([clues], [[]]);  // dummy rowClues
  const dp = solver.solveLine(clues, line);
  const brute = bruteSolveLine(clues, line);
  assert.deepEqual(dp, brute,
    `solveLine(${JSON.stringify(clues)}, ${JSON.stringify(line)}) differs from brute force`);
}

test('mandatory-gap cell is recognized as can-be-empty (regression)', () => {
  // clues=[1,1], L=4: in config (0,2) the cell at index 1 is the mandatory
  // gap, empty. solveLine must not force it to 1.
  check([1, 1], [0, 0, 0, 0]);
});

test('solveLine matches brute force on small unconstrained lines', () => {
  const cases = [
    [[1], [0, 0, 0]],
    [[2], [0, 0, 0, 0, 0]],
    [[3], [0, 0, 0, 0, 0]],
    [[1, 1], [0, 0, 0, 0]],
    [[1, 1], [0, 0, 0, 0, 0]],
    [[2, 1], [0, 0, 0, 0, 0, 0]],
    [[1, 2], [0, 0, 0, 0, 0, 0]],
    [[2, 2], [0, 0, 0, 0, 0, 0]],
    [[1, 1, 1], [0, 0, 0, 0, 0, 0, 0]],
    [[2, 1, 1], [0, 0, 0, 0, 0, 0, 0]],
    [[3, 2], [0, 0, 0, 0, 0, 0, 0]],
  ];
  for (const [clues, line] of cases) check(clues, line);
});

test('solveLine matches brute force when some cells are pre-set', () => {
  check([2], [0, 1, 0, 0, 0]);
  check([2], [-1, 0, 0, 0, 0]);
  check([1, 1], [1, 0, 0, 0]);
  check([1, 1], [0, 0, 1, 0]);
  check([2, 1], [0, 0, 0, -1, 0, 0]);
  check([3], [0, 1, 0, 0, 0]);
});

test('solveLine returns null for unsolvable lines', () => {
  assert.equal(new NonogramSolver([[]], [[]]).solveLine([3], [0, 0]), null);
  assert.equal(new NonogramSolver([[]], [[]]).solveLine([1, 1], [0, 0]), null);
  assert.equal(new NonogramSolver([[]], [[]]).solveLine([2], [-1, 0, -1, 0, -1]), null);
});

test('solveLine returns all-empty for empty clue', () => {
  const r = new NonogramSolver([[]], [[]]).solveLine([], [0, 0, 0, 0]);
  assert.deepEqual(r, [-1, -1, -1, -1]);
});

test('solveLine rejects pre-filled cell with empty clue', () => {
  const r = new NonogramSolver([[]], [[]]).solveLine([], [0, 1, 0]);
  assert.equal(r, null);
});

// Shared puzzle generator. Bounded by (Lmax, Nmax) and the per-block size cap.
function genFuzzCase(rand, Lmin, Lspan, Nmin, Ncap, blockCap) {
  const L = Lmin + (rand() % Lspan);
  const N = Nmin + (rand() % Math.min(Ncap, Math.floor(L / 2) + 1));
  const clues = [];
  let remaining = L - (N - 1);
  for (let k = 0; k < N; k++) {
    const maxBlock = Math.max(1, remaining - (N - k - 1));
    const block = 1 + (rand() % Math.min(maxBlock, blockCap));
    clues.push(block);
    remaining -= block;
    if (remaining <= 0) break;
  }
  const line = new Array(L);
  for (let i = 0; i < L; i++) {
    const r = rand() % 5;
    line[i] = r === 0 ? 1 : (r === 1 ? -1 : 0);
  }
  return { clues, line };
}

test('fuzz: random small lines and clues', () => {
  let rng = 1;
  const rand = () => { rng = (rng * 1664525 + 1013904223) >>> 0; return rng; };
  for (let trial = 0; trial < 200; trial++) {
    const { clues, line } = genFuzzCase(rand, 3, 6, 1, 3, 3);
    check(clues, line);
  }
});

// Exercises the solveLine bitmap fast-path (N >= 4) — the small-fuzz above
// caps N at 3, so a bitmap bug at the higher k bits would never trip it.
// Real puzzles run with N up to ~12 on 50×50 boards; this covers up to N=7.
test('fuzz: larger lines exercise the bitmap canEmpty path', () => {
  let rng = 42;
  const rand = () => { rng = (rng * 1664525 + 1013904223) >>> 0; return rng; };
  for (let trial = 0; trial < 80; trial++) {
    const { clues, line } = genFuzzCase(rand, 10, 5, 4, 4, 3);
    check(clues, line);
  }
});
