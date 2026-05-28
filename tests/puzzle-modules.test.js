'use strict';

// Per-puzzle hook unit tests. Each module in src/widget/puzzles/*.js
// declares hooks consumed by the Stage-B dispatchers in widget.js /
// preview.js / cache.js / content.js. Before this file, those hooks were
// only exercised transitively via the solver integration tests in
// solver.test.js — the Stage D duplicate-dispatcher binairo bug slipped
// through that net (caught only by a user report on a specific 30×30
// weekly).
//
// Scope: PURE hooks only — `cacheKey`, `staticSig`, `solveExtraData`,
// `hintStatusNodes`, `loopDoneCheck`, `solutionFromResult`,
// `solutionToCacheJson`, `solutionFromCacheJson`, `canvasDims`. These
// have no I/O and no side effects, so a direct shape/stability assertion
// is sufficient. Side-effect-heavy hooks (`hintDispatch`, `applyHint`,
// `partialResultArm`, `drawXxx`) need ~10× more scaffolding for marginal
// value because integration tests already cover them.
//
// Loader: each module's CJS export footer (`module.exports = <name>`) is
// stripped by the bundler but kept active under `require`. A few modules
// reference closure helpers defined in widget.js (`hashiDoneCheck`,
// `galaxiesCacheKey`, `galaxiesHintLineDesc`, `getCachedGalaxiesPartial`,
// `getFailedGalaxiesPartials`). We inject minimal stubs as Node globals
// BEFORE `require`-ing each module that needs them.

const test = require('node:test');
const assert = require('node:assert/strict');

// Stub closure helpers (declared in widget.js as bundle-scope consts)
// before any puzzle module that references them is loaded. Each stub
// returns a deterministic, distinguishable shape so tests can assert
// "the hook called through to the helper" without binding to the
// helper's real implementation (those are exercised elsewhere).
global.hashiDoneCheck = (boardState, solution) => {
  // Mimic the real helper's "all-solution-edges-match" semantics with a
  // toy comparator: every solution edge must appear on the board with the
  // same bridge count. Lets loopDoneCheck tests assert both "done" and
  // "not done" cases without spinning up the full HashiSolver.
  if (!solution?.edges || !boardState?.edges) return false;
  for (const e of solution.edges) {
    const m = boardState.edges.find(b => b.a === e.a && b.b === e.b);
    if (!m || m.bridges !== e.bridges) return false;
  }
  return true;
};
global.galaxiesCacheKey = (data) => {
  if (data?.type !== 'galaxies') return null;
  const s = (data.stars || []).map(s => `${s.row},${s.col}`).join('|');
  return `galaxies-solution:${data.rows}x${data.cols}:${s}`;
};
global.galaxiesHintLineDesc = (h) => `line@${h?.orientation || '?'}:${h?.row ?? '?'},${h?.col ?? '?'}`;
global.getCachedGalaxiesPartial = (_data) => null;
global.getFailedGalaxiesPartials = (_data) => [];

const aquarium    = require('../src/widget/puzzles/aquarium.js');
const binairo     = require('../src/widget/puzzles/binairo.js');
const galaxies    = require('../src/widget/puzzles/galaxies.js');
const hashi       = require('../src/widget/puzzles/hashi.js');
const heyawake    = require('../src/widget/puzzles/heyawake.js');
const hitori      = require('../src/widget/puzzles/hitori.js');
const kakurasu    = require('../src/widget/puzzles/kakurasu.js');
const kurodoko    = require('../src/widget/puzzles/kurodoko.js');
const mosaic      = require('../src/widget/puzzles/mosaic.js');
const nonogram    = require('../src/widget/puzzles/nonogram.js');
const norinori    = require('../src/widget/puzzles/norinori.js');
const nurikabe    = require('../src/widget/puzzles/nurikabe.js');
const shikaku     = require('../src/widget/puzzles/shikaku.js');
const slitherlink = require('../src/widget/puzzles/slitherlink.js');
const yinyang     = require('../src/widget/puzzles/yinyang.js');

// Helper stubs passed into hintStatusNodes via the `helpers` bag. `bold`
// is the only one widget.js passes; we tag the returned object so tests
// can identify which segments were bolded.
const bold = (s) => ({ tag: 'b', text: String(s) });

// Convenience: assert a hintStatusNodes return is an array of mixed
// strings and bold-tagged objects (no DOM nodes, no nulls).
function assertNodeArray(nodes) {
  assert.ok(Array.isArray(nodes), `expected an array, got ${typeof nodes}`);
  for (const n of nodes) {
    const ok = typeof n === 'string' || (n && typeof n === 'object' && 'tag' in n);
    assert.ok(ok, `expected string or bold-object, got: ${JSON.stringify(n)}`);
  }
}

// ── nonogram ────────────────────────────────────────────────────────

test('nonogram: cacheKey is stable and uses nonogram-solution prefix', () => {
  const data = { type: 'nonogram', rows: 4, cols: 5,
    rowClues: [[1, 2], [3], [2], [1]], colClues: [[1], [2], [1], [2], [1]] };
  const k1 = nonogram.cacheKey(data);
  const k2 = nonogram.cacheKey(data);
  assert.equal(typeof k1, 'string');
  assert.ok(k1.startsWith('nonogram-solution:'));
  assert.equal(k1, k2);
});

test('nonogram: cacheKey returns null for non-nonogram data', () => {
  assert.equal(nonogram.cacheKey({ type: 'aquarium' }), null);
  assert.equal(nonogram.cacheKey(null), null);
});

test('nonogram: loopDoneCheck true iff every cell non-zero', () => {
  assert.equal(nonogram.loopDoneCheck({ boardState: [[1, 1], [1, -1]] }), true);
  assert.equal(nonogram.loopDoneCheck({ boardState: [[1, 0], [1, 1]] }), false);
  assert.equal(nonogram.loopDoneCheck({ boardState: null }), false);
});

test('nonogram: hintStatusNodes formats row hint with filled and crossed cells', () => {
  const nodes = nonogram.hintStatusNodes({
    type: 'row', index: 2, clue: [1, 3],
    cells: [{ index: 0, value: 1 }, { index: 1, value: 1 },
            { index: 3, value: -1 }],
  }, { bold });
  assertNodeArray(nodes);
  // The first node is bold "Row 3"; the clue string follows.
  assert.deepEqual(nodes[0], { tag: 'b', text: 'Row 3' });
  assert.ok(nodes.some(n => typeof n === 'string' && n.includes('clue: 1, 3')));
});

// ── binairo ─────────────────────────────────────────────────────────

test('binairo: cacheKey is stable and uses binairo-solution prefix', () => {
  const data = { type: 'binairo', rows: 6, cols: 6,
    givens: Array.from({ length: 6 }, () => Array(6).fill(-1)),
    comparisonClues: [] };
  const k1 = binairo.cacheKey(data);
  const k2 = binairo.cacheKey(data);
  assert.equal(typeof k1, 'string');
  assert.ok(k1.startsWith('binairo-solution:'));
  assert.equal(k1, k2);
});

test('binairo: cacheKey differs when comparisonClues differ', () => {
  const base = { type: 'binairo', rows: 6, cols: 6,
    givens: Array.from({ length: 6 }, () => Array(6).fill(-1)),
    comparisonClues: [] };
  const k1 = binairo.cacheKey(base);
  const k2 = binairo.cacheKey({ ...base, comparisonClues: [[4]] });
  assert.notEqual(k1, k2);
});

test('binairo: solveExtraData passes through rows, cols, givens, comparisonClues', () => {
  const data = { type: 'binairo', rows: 6, cols: 6,
    givens: [[0, 1]], comparisonClues: [[4]] };
  const x = binairo.solveExtraData(data);
  assert.equal(x.rows, 6);
  assert.equal(x.cols, 6);
  assert.equal(x.givens, data.givens);
  assert.equal(x.comparisonClues, data.comparisonClues);
});

test('binairo: hintStatusNodes describes a single-cell "must be" hint', () => {
  const nodes = binairo.hintStatusNodes(
    { cells: [], extraCells: [{ row: 0, col: 1, value: 1 }] },
    { bold });
  assertNodeArray(nodes);
  assert.ok(nodes.some(n => typeof n === 'string' && n.includes('must be')));
  // bold should contain the value "1"
  assert.ok(nodes.some(n => n?.tag === 'b' && n.text === '1'));
});

test('binairo: staticSig emits cc= segment', () => {
  const sig = binairo.staticSig({ comparisonClues: [[4]] });
  assert.equal(typeof sig, 'string');
  assert.ok(sig.startsWith('cc='));
});

// ── hitori ──────────────────────────────────────────────────────────

test('hitori: cacheKey is stable, uses hitori-solution prefix', () => {
  const data = { type: 'hitori', rows: 4, cols: 4,
    task: [[1, 2, 3, 4], [2, 3, 4, 1], [3, 4, 1, 2], [4, 1, 2, 3]] };
  const k1 = hitori.cacheKey(data);
  const k2 = hitori.cacheKey(data);
  assert.equal(typeof k1, 'string');
  assert.ok(k1.startsWith('hitori-solution:'));
  assert.equal(k1, k2);
});

test('hitori: cacheKey null when task missing', () => {
  assert.equal(hitori.cacheKey({ type: 'hitori', rows: 4, cols: 4 }), null);
  assert.equal(hitori.cacheKey({ type: 'binairo' }), null);
});

test('hitori: solveExtraData passes through rows, cols, task', () => {
  const data = { type: 'hitori', rows: 4, cols: 4, task: [[1]] };
  const x = hitori.solveExtraData(data);
  assert.equal(x.rows, 4);
  assert.equal(x.cols, 4);
  assert.equal(x.task, data.task);
});

test('hitori: hintStatusNodes single-cell shaded/unshaded message', () => {
  const shadedNodes = hitori.hintStatusNodes(
    { extraCells: [{ row: 0, col: 0, value: 1 }] }, { bold });
  assertNodeArray(shadedNodes);
  assert.ok(shadedNodes.some(n => n?.tag === 'b' && n.text === 'shaded'));

  const unshadedNodes = hitori.hintStatusNodes(
    { extraCells: [{ row: 2, col: 3, value: 2 }] }, { bold });
  assert.ok(unshadedNodes.some(n => n?.tag === 'b' && n.text === 'unshaded'));
});

// ── kakurasu ────────────────────────────────────────────────────────

test('kakurasu: cacheKey is stable, uses kakurasu-solution prefix', () => {
  const data = { type: 'kakurasu', rows: 4, cols: 4,
    rowClues: [1, 2, 3, 4], colClues: [4, 3, 2, 1] };
  const k1 = kakurasu.cacheKey(data);
  const k2 = kakurasu.cacheKey(data);
  assert.equal(typeof k1, 'string');
  assert.ok(k1.startsWith('kakurasu-solution:'));
  assert.equal(k1, k2);
});

test('kakurasu: cacheKey null when clues missing', () => {
  assert.equal(kakurasu.cacheKey({ type: 'kakurasu', rows: 4, cols: 4 }), null);
});

test('kakurasu: canvasDims returns padded dimensions', () => {
  const grid = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const dims = kakurasu.canvasDims({ type: 'kakurasu' }, { grid });
  assert.equal(dims.rows, 3);
  assert.equal(dims.cols, 3);
  assert.equal(dims.padRight, 1);
  assert.equal(dims.padBottom, 1);
});

test('kakurasu: hintStatusNodes single-cell filled/empty message', () => {
  const filled = kakurasu.hintStatusNodes(
    { extraCells: [{ row: 1, col: 2, value: 1 }] }, { bold });
  assertNodeArray(filled);
  assert.ok(filled.some(n => n?.tag === 'b' && n.text === 'filled'));

  const empty = kakurasu.hintStatusNodes(
    { extraCells: [{ row: 0, col: 0, value: 2 }] }, { bold });
  assert.ok(empty.some(n => n?.tag === 'b' && n.text === 'empty'));
});

// ── kurodoko ────────────────────────────────────────────────────────

test('kurodoko: cacheKey is stable, uses kurodoko-solution prefix', () => {
  const data = { type: 'kurodoko', rows: 4, cols: 4,
    task: [[-1, 2, -1, -1], [-1, -1, -1, -1], [-1, -1, 3, -1], [-1, -1, -1, -1]] };
  const k1 = kurodoko.cacheKey(data);
  const k2 = kurodoko.cacheKey(data);
  assert.equal(typeof k1, 'string');
  assert.ok(k1.startsWith('kurodoko-solution:'));
  assert.equal(k1, k2);
});

test('kurodoko: cacheKey null when task missing', () => {
  assert.equal(kurodoko.cacheKey({ type: 'kurodoko', rows: 4, cols: 4 }), null);
});

test('kurodoko: solveExtraData passes through task', () => {
  const data = { type: 'kurodoko', rows: 4, cols: 4, task: [[1, -1]] };
  const x = kurodoko.solveExtraData(data);
  assert.equal(x.rows, 4);
  assert.equal(x.task, data.task);
});

test('kurodoko: hintStatusNodes single-cell shaded/unshaded message', () => {
  const nodes = kurodoko.hintStatusNodes(
    { extraCells: [{ row: 0, col: 0, value: 1 }] }, { bold });
  assertNodeArray(nodes);
  assert.ok(nodes.some(n => n?.tag === 'b' && n.text === 'shaded'));
});

// ── mosaic ──────────────────────────────────────────────────────────

test('mosaic: cacheKey is stable, uses mosaic-solution prefix', () => {
  const data = { type: 'mosaic', rows: 3, cols: 3,
    task: [[-1, 5, -1], [-1, -1, -1], [-1, 3, -1]] };
  const k1 = mosaic.cacheKey(data);
  const k2 = mosaic.cacheKey(data);
  assert.equal(typeof k1, 'string');
  assert.ok(k1.startsWith('mosaic-solution:'));
  assert.equal(k1, k2);
});

test('mosaic: solveExtraData passes through task', () => {
  const data = { type: 'mosaic', rows: 3, cols: 3, task: [[1, 2, 3]] };
  const x = mosaic.solveExtraData(data);
  assert.equal(x.rows, 3);
  assert.equal(x.cols, 3);
  assert.equal(x.task, data.task);
});

test('mosaic: hintStatusNodes single-cell shaded message', () => {
  const nodes = mosaic.hintStatusNodes(
    { extraCells: [{ row: 1, col: 2, value: 1 }] }, { bold });
  assertNodeArray(nodes);
  assert.ok(nodes.some(n => n?.tag === 'b' && n.text === 'shaded'));
});

// ── norinori ────────────────────────────────────────────────────────

test('norinori: cacheKey is stable, uses norinori-solution prefix', () => {
  const data = { type: 'norinori', rows: 3, cols: 3,
    areas: [[0, 0, 1], [0, 1, 1], [2, 2, 1]] };
  const k1 = norinori.cacheKey(data);
  const k2 = norinori.cacheKey(data);
  assert.equal(typeof k1, 'string');
  assert.ok(k1.startsWith('norinori-solution:'));
  assert.equal(k1, k2);
});

test('norinori: cacheKey differs when areas differ', () => {
  const a = { type: 'norinori', rows: 2, cols: 2, areas: [[0, 0], [1, 1]] };
  const b = { type: 'norinori', rows: 2, cols: 2, areas: [[0, 1], [0, 1]] };
  assert.notEqual(norinori.cacheKey(a), norinori.cacheKey(b));
});

test('norinori: solveExtraData passes through rooms', () => {
  const data = { type: 'norinori', rows: 3, cols: 3,
    areas: [[0]], rooms: [{ cells: [{ r: 0, c: 0 }] }] };
  const x = norinori.solveExtraData(data);
  assert.equal(x.rows, 3);
  assert.equal(x.rooms, data.rooms);
});

test('norinori: hintStatusNodes multi-cell summary', () => {
  const nodes = norinori.hintStatusNodes(
    { extraCells: [
      { row: 0, col: 0, value: 1 },
      { row: 0, col: 1, value: 2 },
      { row: 1, col: 0, value: 1 },
    ] }, { bold });
  assertNodeArray(nodes);
  assert.ok(nodes.some(n => n?.tag === 'b' && n.text === '3'));
  assert.ok(nodes.some(n => typeof n === 'string' && n.includes('deduced')));
});

// ── nurikabe ────────────────────────────────────────────────────────

test('nurikabe: cacheKey is stable, uses nurikabe-solution prefix', () => {
  const data = { type: 'nurikabe', rows: 3, cols: 3,
    task: [[-1, 3, -1], [-1, -1, -1], [-1, -2, 2]] };
  const k1 = nurikabe.cacheKey(data);
  const k2 = nurikabe.cacheKey(data);
  assert.equal(typeof k1, 'string');
  assert.ok(k1.startsWith('nurikabe-solution:'));
  assert.equal(k1, k2);
});

test('nurikabe: cacheKey null when task missing', () => {
  assert.equal(nurikabe.cacheKey({ type: 'nurikabe' }), null);
});

test('nurikabe: hintStatusNodes single-cell sea/island message', () => {
  const sea = nurikabe.hintStatusNodes(
    { extraCells: [{ row: 0, col: 0, value: 1 }] }, { bold });
  assertNodeArray(sea);
  assert.ok(sea.some(n => n?.tag === 'b' && n.text === 'sea (black)'));

  const island = nurikabe.hintStatusNodes(
    { extraCells: [{ row: 2, col: 2, value: 2 }] }, { bold });
  assert.ok(island.some(n => n?.tag === 'b' && n.text === 'island (white)'));
});

// ── heyawake ────────────────────────────────────────────────────────

test('heyawake: cacheKey is stable, uses heyawake-solution prefix', () => {
  const data = { type: 'heyawake', rows: 3, cols: 3,
    areas: [[0, 0, 1], [0, 1, 1], [2, 2, 1]],
    rooms: [{ target: 1 }, { target: 2 }, { target: -1 }] };
  const k1 = heyawake.cacheKey(data);
  const k2 = heyawake.cacheKey(data);
  assert.equal(typeof k1, 'string');
  assert.ok(k1.startsWith('heyawake-solution:'));
  assert.equal(k1, k2);
});

test('heyawake: cacheKey differs when rooms target differs', () => {
  const base = { type: 'heyawake', rows: 2, cols: 2,
    areas: [[0, 0], [0, 0]], rooms: [{ target: 1 }] };
  const k1 = heyawake.cacheKey(base);
  const k2 = heyawake.cacheKey({ ...base, rooms: [{ target: 2 }] });
  assert.notEqual(k1, k2);
});

test('heyawake: solveExtraData passes through rooms', () => {
  const data = { type: 'heyawake', rows: 3, cols: 3,
    areas: [[0]], rooms: [{ target: 1 }] };
  const x = heyawake.solveExtraData(data);
  assert.equal(x.rows, 3);
  assert.equal(x.cols, 3);
  assert.equal(x.rooms, data.rooms);
});

test('heyawake: hintStatusNodes single-cell black/white message', () => {
  const black = heyawake.hintStatusNodes(
    { extraCells: [{ row: 0, col: 0, value: 1 }] }, { bold });
  assertNodeArray(black);
  assert.ok(black.some(n => n?.tag === 'b' && n.text === 'black'));

  const white = heyawake.hintStatusNodes(
    { extraCells: [{ row: 0, col: 0, value: 2 }] }, { bold });
  assert.ok(white.some(n => n?.tag === 'b' && n.text === 'white'));
});

// ── yinyang ─────────────────────────────────────────────────────────

test('yinyang: cacheKey is stable, uses yinyang-solution prefix', () => {
  const data = { type: 'yinyang', rows: 4, cols: 4,
    task: [[-1, 0, -1, 1], [-1, -1, -1, -1], [1, -1, -1, -1], [-1, -1, 0, -1]] };
  const k1 = yinyang.cacheKey(data);
  const k2 = yinyang.cacheKey(data);
  assert.equal(typeof k1, 'string');
  assert.ok(k1.startsWith('yinyang-solution:'));
  assert.equal(k1, k2);
});

test('yinyang: cacheKey returns null for non-yinyang data', () => {
  assert.equal(yinyang.cacheKey({ type: 'binairo' }), null);
});

test('yinyang: solveExtraData passes through task', () => {
  const data = { type: 'yinyang', rows: 4, cols: 4, task: [[-1]] };
  const x = yinyang.solveExtraData(data);
  assert.equal(x.rows, 4);
  assert.equal(x.task, data.task);
});

test('yinyang: hintStatusNodes single-cell black/white via extraCells', () => {
  const black = yinyang.hintStatusNodes(
    { extraCells: [{ row: 2, col: 1, value: 1 }] }, { bold });
  assertNodeArray(black);
  assert.ok(black.some(n => n?.tag === 'b' && n.text === 'black'));

  const white = yinyang.hintStatusNodes(
    { extraCells: [{ row: 0, col: 0, value: 2 }] }, { bold });
  assert.ok(white.some(n => n?.tag === 'b' && n.text === 'white'));
});

// ── aquarium ────────────────────────────────────────────────────────

test('aquarium: cacheKey is stable, uses aquarium-solution prefix', () => {
  const data = { type: 'aquarium', rows: 4, cols: 4,
    rowClues: [1, 2, 3, 4], colClues: [2, 2, 2, 4],
    regionMap: [[0, 0, 1, 1], [0, 0, 1, 1], [2, 2, 3, 3], [2, 2, 3, 3]] };
  const k1 = aquarium.cacheKey(data);
  const k2 = aquarium.cacheKey(data);
  assert.equal(typeof k1, 'string');
  assert.ok(k1.startsWith('aquarium-solution:'));
  assert.equal(k1, k2);
});

test('aquarium: cacheKey null for non-aquarium', () => {
  assert.equal(aquarium.cacheKey({ type: 'binairo' }), null);
});

test('aquarium: solveExtraData passes through clues and regionMap', () => {
  const data = { type: 'aquarium', rows: 4, cols: 4,
    rowClues: [1, 2], colClues: [3, 4],
    regionMap: [[0, 1], [0, 1]] };
  const x = aquarium.solveExtraData(data);
  assert.equal(x.rows, 4);
  assert.equal(x.cols, 4);
  assert.equal(x.rowCluesFlat, data.rowClues);
  assert.equal(x.colCluesFlat, data.colClues);
  assert.equal(x.regionMap, data.regionMap);
});

// ── shikaku ─────────────────────────────────────────────────────────

test('shikaku: cacheKey is stable, uses shikaku-solution prefix', () => {
  const data = { type: 'shikaku', rows: 4, cols: 4,
    clues: [{ row: 0, col: 0, area: 4 }, { row: 2, col: 2, area: 4 },
            { row: 0, col: 3, area: 4 }, { row: 3, col: 0, area: 4 }] };
  const k1 = shikaku.cacheKey(data);
  const k2 = shikaku.cacheKey(data);
  assert.equal(typeof k1, 'string');
  assert.ok(k1.startsWith('shikaku-solution:'));
  assert.equal(k1, k2);
});

test('shikaku: cacheKey is order-independent (clues sorted internally)', () => {
  const a = { type: 'shikaku', rows: 4, cols: 4,
    clues: [{ row: 0, col: 0, area: 4 }, { row: 2, col: 2, area: 4 }] };
  const b = { type: 'shikaku', rows: 4, cols: 4,
    clues: [{ row: 2, col: 2, area: 4 }, { row: 0, col: 0, area: 4 }] };
  assert.equal(shikaku.cacheKey(a), shikaku.cacheKey(b));
});

test('shikaku: loopDoneCheck true iff no -1 unassigned cells remain', () => {
  assert.equal(shikaku.loopDoneCheck({ boardState: [[0, 0], [1, 1]] }), true);
  assert.equal(shikaku.loopDoneCheck({ boardState: [[0, -1], [1, 1]] }), false);
  // -1 sentinel for unassigned — NOT 0 as in cell-state puzzles.
  assert.equal(shikaku.loopDoneCheck({ boardState: [[0, 0], [0, 0]] }), true);
  assert.equal(shikaku.loopDoneCheck({ boardState: null }), false);
});

test('shikaku: hintStatusNodes describes rectangle for clue', () => {
  const nodes = shikaku.hintStatusNodes(
    { cells: [{ row: 0, col: 0 }], extraCells: [],
      clue: { row: 0, col: 0, area: 6 } },
    { bold });
  assertNodeArray(nodes);
  assert.ok(nodes.some(n => n?.tag === 'b' && n.text === '6'));
  assert.ok(nodes.some(n => n?.tag === 'b' && n.text.includes('row 1, col 1')));
});

// ── hashi ───────────────────────────────────────────────────────────

test('hashi: cacheKey is stable, uses hashi-solution prefix', () => {
  const data = { type: 'hashi', rows: 5, cols: 5,
    islands: [{ row: 0, col: 0, number: 2 }, { row: 0, col: 4, number: 2 },
              { row: 4, col: 0, number: 2 }, { row: 4, col: 4, number: 2 }] };
  const k1 = hashi.cacheKey(data);
  const k2 = hashi.cacheKey(data);
  assert.equal(typeof k1, 'string');
  assert.ok(k1.startsWith('hashi-solution:'));
  assert.equal(k1, k2);
});

test('hashi: cacheKey is order-independent (islands sorted internally)', () => {
  const a = { type: 'hashi', rows: 5, cols: 5,
    islands: [{ row: 0, col: 0, number: 2 }, { row: 4, col: 4, number: 2 }] };
  const b = { type: 'hashi', rows: 5, cols: 5,
    islands: [{ row: 4, col: 4, number: 2 }, { row: 0, col: 0, number: 2 }] };
  assert.equal(hashi.cacheKey(a), hashi.cacheKey(b));
});

test('hashi: solveExtraData passes through rows/cols/islands', () => {
  const data = { type: 'hashi', rows: 5, cols: 5,
    islands: [{ row: 0, col: 0, number: 2 }] };
  const x = hashi.solveExtraData(data);
  assert.equal(x.rows, 5);
  assert.equal(x.cols, 5);
  assert.equal(x.islands, data.islands);
});

test('hashi: solutionFromResult unwraps edges', () => {
  const r = { solved: true, edges: [{ a: 0, b: 1, orientation: 'H', bridges: 1 }],
              extra: 'ignored' };
  const s = hashi.solutionFromResult(r);
  assert.equal(s.solved, true);
  assert.equal(s.edges, r.edges);
});

test('hashi: solutionToCacheJson + solutionFromCacheJson roundtrip', () => {
  const sol = { edges: [{ a: 0, b: 1, orientation: 'H', bridges: 1 }] };
  const json = hashi.solutionToCacheJson(sol);
  assert.ok(json && Array.isArray(json.edges));
  const back = hashi.solutionFromCacheJson(json);
  assert.deepEqual(back.edges, sol.edges);
  // defensive clone — mutating the result must not bleed into sol
  back.edges[0].bridges = 99;
  assert.equal(sol.edges[0].bridges, 1);
});

test('hashi: solutionToCacheJson rejects malformed input', () => {
  assert.equal(hashi.solutionToCacheJson(null), null);
  assert.equal(hashi.solutionToCacheJson({ edges: 'nope' }), null);
});

test('hashi: solutionFromCacheJson rejects malformed input', () => {
  assert.equal(hashi.solutionFromCacheJson(null), null);
  assert.equal(hashi.solutionFromCacheJson({}), null);
});

test('hashi: canvasDims reads rows/cols from puzzleData', () => {
  const dims = hashi.canvasDims({ rows: 7, cols: 9 });
  assert.equal(dims.rows, 7);
  assert.equal(dims.cols, 9);
});

test('hashi: hintStatusNodes describes a single edge', () => {
  const nodes = hashi.hintStatusNodes(
    { edges: [{ a: 0, b: 1, orientation: 'H', bridges: 1 }] },
    { bold, puzzleData: {
      islands: [{ row: 0, col: 0, number: 2 }, { row: 0, col: 3, number: 2 }] } });
  assertNodeArray(nodes);
  assert.ok(nodes.some(n => n?.tag === 'b' && n.text === 'single bridge'));
});

test('hashi: hintStatusNodes uses description when present (stepwise rule)', () => {
  const nodes = hashi.hintStatusNodes(
    { edges: [{ a: 0, b: 1, orientation: 'H', bridges: 1 }],
      description: 'Degree forcing on island (0,0)' },
    { bold, puzzleData: { islands: [] } });
  assertNodeArray(nodes);
  assert.ok(nodes.some(n => n?.tag === 'b' && n.text.includes('Degree forcing')));
});

test('hashi: loopDoneCheck delegates to hashiDoneCheck helper', () => {
  // Stub mirrors "all solution edges match" semantics. Both lists match → done.
  const sol = { edges: [{ a: 0, b: 1, bridges: 2 }] };
  const boardDone = { edges: [{ a: 0, b: 1, bridges: 2 }] };
  const boardNot = { edges: [{ a: 0, b: 1, bridges: 1 }] };
  assert.equal(hashi.loopDoneCheck({ boardState: boardDone, solution: sol }), true);
  assert.equal(hashi.loopDoneCheck({ boardState: boardNot, solution: sol }), false);
});

// ── slitherlink ─────────────────────────────────────────────────────

test('slitherlink: cacheKey is stable, uses slitherlink-solution prefix', () => {
  const data = { type: 'slitherlink', rows: 4, cols: 4,
    task: [[-1, 2, -1, -1], [3, -1, -1, 1], [-1, -1, 2, -1], [-1, -1, -1, 3]] };
  const k1 = slitherlink.cacheKey(data);
  const k2 = slitherlink.cacheKey(data);
  assert.equal(typeof k1, 'string');
  assert.ok(k1.startsWith('slitherlink-solution:'));
  assert.equal(k1, k2);
});

test('slitherlink: cacheKey returns null for non-slitherlink data', () => {
  assert.equal(slitherlink.cacheKey({ type: 'hashi' }), null);
});

test('slitherlink: staticSig emits sl= segment', () => {
  const sig = slitherlink.staticSig({ type: 'slitherlink', task: [[-1, 2]] });
  assert.equal(typeof sig, 'string');
  assert.ok(sig.startsWith('sl='));
});

test('slitherlink: canvasDims prefers puzzleData rows/cols, falls back to grid', () => {
  // Explicit rows/cols in puzzleData
  const dimsPD = slitherlink.canvasDims({ rows: 5, cols: 7 }, { grid: { horizontal: [] } });
  assert.equal(dimsPD.rows, 5);
  assert.equal(dimsPD.cols, 7);
  // Fallback to grid.horizontal shape (H+1 rows × W cols, so rows = h.len-1)
  const dimsG = slitherlink.canvasDims(null, { grid: {
    horizontal: [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]] } });
  assert.equal(dimsG.rows, 3);
  assert.equal(dimsG.cols, 3);
});

test('slitherlink: solveExtraData passes through task', () => {
  const data = { type: 'slitherlink', rows: 4, cols: 4, task: [[-1]] };
  const x = slitherlink.solveExtraData(data);
  assert.equal(x.rows, 4);
  assert.equal(x.cols, 4);
  assert.equal(x.task, data.task);
});

test('slitherlink: solutionFromResult unwraps horizontal/vertical edges', () => {
  const r = { solved: true, horizontal: [[1, 0]], vertical: [[0, 1]], extra: 'x' };
  const s = slitherlink.solutionFromResult(r);
  assert.equal(s.horizontal, r.horizontal);
  assert.equal(s.vertical, r.vertical);
});

test('slitherlink: solutionToCacheJson + solutionFromCacheJson roundtrip with defensive clone', () => {
  const sol = { horizontal: [[1, 0], [0, 1]], vertical: [[1, 1], [0, 0]] };
  const json = slitherlink.solutionToCacheJson(sol);
  assert.ok(json && Array.isArray(json.horizontal));
  const back = slitherlink.solutionFromCacheJson(json);
  assert.deepEqual(back.horizontal, sol.horizontal);
  assert.deepEqual(back.vertical, sol.vertical);
  // defensive clone — mutating result rows must not bleed into sol
  back.horizontal[0][0] = 99;
  assert.equal(sol.horizontal[0][0], 1);
});

test('slitherlink: solutionToCacheJson rejects partial input', () => {
  assert.equal(slitherlink.solutionToCacheJson(null), null);
  assert.equal(slitherlink.solutionToCacheJson({ horizontal: [[1]] }), null);
  assert.equal(slitherlink.solutionToCacheJson({ vertical: [[1]] }), null);
});

test('slitherlink: solutionFromCacheJson rejects partial input', () => {
  assert.equal(slitherlink.solutionFromCacheJson(null), null);
  assert.equal(slitherlink.solutionFromCacheJson({ horizontal: [[1]] }), null);
});

test('slitherlink: hintStatusNodes describes single edge h or v', () => {
  const h = slitherlink.hintStatusNodes(
    { edges: [{ orientation: 'h', r: 1, c: 2 }] }, { bold });
  assertNodeArray(h);
  assert.ok(h.some(n => n?.tag === 'b' && /top of cell/.test(n.text)));
  const v = slitherlink.hintStatusNodes(
    { edges: [{ orientation: 'v', r: 1, c: 2 }] }, { bold });
  assert.ok(v.some(n => n?.tag === 'b' && /left of cell/.test(n.text)));
});

test('slitherlink: hintStatusNodes summarises multi-edge', () => {
  const nodes = slitherlink.hintStatusNodes(
    { edges: [{ orientation: 'h', r: 0, c: 0 }, { orientation: 'v', r: 0, c: 0 },
              { orientation: 'h', r: 1, c: 1 }] }, { bold });
  assertNodeArray(nodes);
  assert.ok(nodes.some(n => n?.tag === 'b' && n.text === '3'));
});

// ── galaxies ────────────────────────────────────────────────────────

test('galaxies: cacheKey delegates to galaxiesCacheKey (uses galaxies-solution prefix)', () => {
  const data = { type: 'galaxies', rows: 5, cols: 5,
    stars: [{ row: 0, col: 0 }, { row: 4, col: 4 }] };
  const k = galaxies.cacheKey(data);
  assert.equal(typeof k, 'string');
  assert.ok(k.startsWith('galaxies-solution:'));
});

test('galaxies: solveExtraData carries stars and partial/failed-partial hooks', () => {
  const data = { type: 'galaxies', rows: 5, cols: 5,
    stars: [{ row: 0, col: 0 }] };
  const x = galaxies.solveExtraData(data);
  assert.equal(x.rows, 5);
  assert.equal(x.cols, 5);
  assert.equal(x.stars, data.stars);
  // partialGrid + failedPartials come from stubs above
  assert.equal(x.partialGrid, null);
  assert.deepEqual(x.failedPartials, []);
});

test('galaxies: hintStatusNodes wraps galaxiesHintLineDesc', () => {
  const nodes = galaxies.hintStatusNodes(
    { orientation: 'horizontal', row: 1, col: 2 }, { bold });
  assertNodeArray(nodes);
  // Stub returns "line@horizontal:1,2"; assert that string is bolded.
  assert.ok(nodes.some(n => n?.tag === 'b' && n.text === 'line@horizontal:1,2'));
});
