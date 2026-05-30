'use strict';

// cachekey-parity.test.js — Characterization test for every FNV-1a cache key.
//
// Records the CURRENT _cacheKey() value for each solver and the CURRENT
// cacheKey()/staticSig() value for each FNV-using widget module, then
// asserts them against a GOLDEN snapshot. If any value changes here it means
// the FNV-extraction swap (Tasks 8–9) altered a key → cached solutions would
// miss silently for users.
//
// EXCLUDED (deliberately not covered):
//   - AquariumSolver._cacheKey     — deliberate string-concat, not FNV, not being swapped.
//   - aquarium.cacheKey (widget)   — same; the CLAUDE.md spec says to exclude it.
//   - BinairoSolver._cacheKey uses `h ^= n` (no & 0xff) — included: the parity
//     test is the whole point of catching whether the masked shared helper
//     changes any key.
//   - ShikakuSolver / YinYangSolver / SlitherlinkSolver / BinairoSolver also
//     use unmasked `h ^= n` — included for same reason.
//
// To regenerate GOLDEN after an intentional key change:
//   RECORD=1 node --test tests/cachekey-parity.test.js 2>&1 | grep -A9999 "^GOLDEN ="

const test = require('node:test');
const assert = require('node:assert/strict');

// ── solver exports ──────────────────────────────────────────────────────────
const {
  BinairoSolver,
  HashiSolver,
  HeyawakeSolver,
  HitoriSolver,
  KakurasuSolver,
  KurodokoSolver,
  MosaicSolver,
  NorinoriSolver,
  NurikabeSolver,
  ShikakuSolver,
  SlitherlinkSolver,
  YinYangSolver,
} = require('../solver.js');

// ── fixtures ────────────────────────────────────────────────────────────────
const fixtures = require('./fixtures/puzzles.js');

// ── widget modules (require stubs before loading modules that reference them)
global.hashiDoneCheck = () => false;
global.galaxiesCacheKey = () => null;
global.galaxiesHintLineDesc = () => '';
global.getCachedGalaxiesPartial = () => null;
global.getFailedGalaxiesPartials = () => [];

const binairoW    = require('../src/widget/puzzles/binairo.js');
const hashiW      = require('../src/widget/puzzles/hashi.js');
const heyawakeW   = require('../src/widget/puzzles/heyawake.js');
const hitoriW     = require('../src/widget/puzzles/hitori.js');
const kakurasuW   = require('../src/widget/puzzles/kakurasu.js');
const kurodokoW   = require('../src/widget/puzzles/kurodoko.js');
const mosaicW     = require('../src/widget/puzzles/mosaic.js');
const norinoriW   = require('../src/widget/puzzles/norinori.js');
const nurikabeW   = require('../src/widget/puzzles/nurikabe.js');
const shikakuW    = require('../src/widget/puzzles/shikaku.js');
const slitherlinkW = require('../src/widget/puzzles/slitherlink.js');
const yinyangW    = require('../src/widget/puzzles/yinyang.js');

// ── helpers for building solver instances from fixtures ─────────────────────

// HeyawakeSolver needs rooms: [{cells:[{r,c}], target}], same as solver.test.js.
function heyawakeRoomsFromFixture(fixture) {
  const { rows, cols, areas, areaTask } = fixture;
  const cellsPerRoom = {};
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const k = areas[r][c];
      if (!cellsPerRoom[k]) cellsPerRoom[k] = [];
      cellsPerRoom[k].push({ r, c });
    }
  }
  return areaTask.map((target, k) => ({ cells: cellsPerRoom[k], target }));
}

// NorinoriSolver needs rooms: [{cells:[{r,c}]}], same as solver.test.js.
function norinoriRoomsFromFixture(fixture) {
  const cellsByRoom = {};
  for (let r = 0; r < fixture.rows; r++) {
    for (let c = 0; c < fixture.cols; c++) {
      const k = fixture.areas[r][c];
      if (!cellsByRoom[k]) cellsByRoom[k] = [];
      cellsByRoom[k].push({ r, c });
    }
  }
  return Object.keys(cellsByRoom)
    .sort((a, b) => +a - +b)
    .map(k => ({ cells: cellsByRoom[k] }));
}

// ── golden snapshot ─────────────────────────────────────────────────────────
// Captured by running with RECORD=1. Paste printed object here when regenerating.
const GOLDEN = {
  "solver:binairo": "255968349",
  "solver:hashi": 3773866861,
  "solver:heyawake": 3663608240,
  "solver:hitori": 1345386128,
  "solver:kakurasu": 592851891,
  "solver:kurodoko": 1321565370,
  "solver:mosaic": 3466376412,
  "solver:norinori": 4096190198,
  "solver:nurikabe": 292056280,
  "solver:shikaku": "651502470",
  "solver:slitherlink": "3367742636",
  "solver:yinyang": "196326990",
  "widget:binairo:cacheKey": "binairo-solution:71ba4f9d",
  "widget:binairo:staticSig": "cc=0",
  "widget:hashi:cacheKey": "hashi-solution:1d73eae3",
  "widget:hashi:staticSig": "hi=1r32xcd",
  "widget:heyawake:cacheKey": "heyawake-solution:9d390bd8",
  "widget:heyawake:staticSig": "hy=3pqhg5",
  "widget:hitori:cacheKey": "hitori-solution:3f65ae82",
  "widget:hitori:staticSig": "hi=24cb6b5e",
  "widget:kakurasu:cacheKey": "kakurasu-solution:eb384c2c",
  "widget:kakurasu:staticSig": "ka=5be7f703",
  "widget:kurodoko:cacheKey": "kurodoko-solution:34f3c810",
  "widget:kurodoko:staticSig": "kd=7a760eb0",
  "widget:mosaic:cacheKey": "mosaic-solution:af08b503",
  "widget:mosaic:staticSig": "mc=989e7e2",
  "widget:norinori:cacheKey": "norinori-solution:edefcde6",
  "widget:norinori:staticSig": "nn=b28be6f2",
  "widget:nurikabe:cacheKey": "nurikabe-solution:84459eaf",
  "widget:nurikabe:staticSig": "nu=2013d54e",
  "widget:shikaku:cacheKey": "shikaku-solution:9363cf69",
  "widget:shikaku:staticSig": "sk=oukt4d",
  "widget:slitherlink:cacheKey": "slitherlink-solution:c8bbacac",
  "widget:slitherlink:staticSig": "sl=25daffc4",
  "widget:yinyang:cacheKey": "yinyang-solution:2a47b033"
};

// ── key collection ──────────────────────────────────────────────────────────
function currentKeys() {
  const out = {};

  // ── SOLVERS ────────────────────────────────────────────────────────────────
  // Each solver is constructed from the corresponding fixture, mirroring the
  // exact constructor call used in tests/solver.test.js and the per-type
  // test files. _cacheKey() reads constructor-time state (task, rows, cols,
  // etc.), so construction alone suffices — no need to run solve().

  // BinairoSolver: { rows, cols, givens, comparisonClues? }
  // Uses unmasked `h ^= n` — included to detect masking changes.
  {
    BinairoSolver.clearSolutionCache();
    const p = fixtures.binairo6x6;
    out['solver:binairo'] = new BinairoSolver({
      rows: p.rows, cols: p.cols, givens: p.givens,
    })._cacheKey();
  }

  // HashiSolver: { rows, cols, islands: [{row, col, number}] }
  {
    HashiSolver.clearSolutionCache();
    const p = fixtures.hashi3x3Tiny;
    out['solver:hashi'] = new HashiSolver({
      rows: p.rows, cols: p.cols, islands: p.islands,
    })._cacheKey();
  }

  // HeyawakeSolver: { rows, cols, rooms: [{cells:[{r,c}], target}] }
  {
    const p = fixtures.heyawake6x6Easy;
    const rooms = heyawakeRoomsFromFixture(p);
    out['solver:heyawake'] = new HeyawakeSolver({
      rows: p.rows, cols: p.cols, rooms,
    })._cacheKey();
  }

  // HitoriSolver: { rows, cols, task }
  {
    const p = fixtures.hitori5x5Easy;
    out['solver:hitori'] = new HitoriSolver({
      rows: p.rows, cols: p.cols, task: p.task,
    })._cacheKey();
  }

  // KakurasuSolver: { rows, cols, rowClues, colClues }
  {
    const p = fixtures.kakurasu4x4Easy;
    out['solver:kakurasu'] = new KakurasuSolver({
      rows: p.rows, cols: p.cols, rowClues: p.rowClues, colClues: p.colClues,
    })._cacheKey();
  }

  // KurodokoSolver: { rows, cols, task }
  {
    const p = fixtures.kurodoko5x5Easy;
    out['solver:kurodoko'] = new KurodokoSolver({
      rows: p.rows, cols: p.cols, task: p.task,
    })._cacheKey();
  }

  // MosaicSolver: { rows, cols, task }
  {
    const p = fixtures.mosaic5x5Easy;
    out['solver:mosaic'] = new MosaicSolver({
      rows: p.rows, cols: p.cols, task: p.task,
    })._cacheKey();
  }

  // NorinoriSolver: { rows, cols, rooms: [{cells:[{r,c}]}] }
  {
    const p = fixtures.norinori6x6Normal;
    const rooms = norinoriRoomsFromFixture(p);
    out['solver:norinori'] = new NorinoriSolver({
      rows: p.rows, cols: p.cols, rooms,
    })._cacheKey();
  }

  // NurikabeSolver: { rows, cols, task }
  {
    const p = fixtures.nurikabe5x5Easy;
    out['solver:nurikabe'] = new NurikabeSolver({
      rows: p.rows, cols: p.cols, task: p.task,
    })._cacheKey();
  }

  // ShikakuSolver: { rows, cols, clues }
  // Uses unmasked `h ^= n` — included to detect masking changes.
  {
    ShikakuSolver.clearSolutionCache();
    const p = fixtures.shikaku5x5;
    out['solver:shikaku'] = new ShikakuSolver({
      rows: p.rows, cols: p.cols, clues: p.clues,
    })._cacheKey();
  }

  // SlitherlinkSolver: { width, height, task } — note width/height, not rows/cols.
  // Uses unmasked `h ^= n` — included to detect masking changes.
  {
    SlitherlinkSolver.clearSolutionCache();
    const p = fixtures.slitherlink5x5;
    out['solver:slitherlink'] = new SlitherlinkSolver({
      width: p.cols, height: p.rows, task: p.task,
    })._cacheKey();
  }

  // YinYangSolver: { rows, cols, task } — uses unmasked `h ^= n`.
  {
    YinYangSolver.clearSolutionCache();
    const p = fixtures.yinyang6x6;
    out['solver:yinyang'] = new YinYangSolver({
      rows: p.rows, cols: p.cols, task: p.task,
    })._cacheKey();
  }

  // ── WIDGET cacheKey ────────────────────────────────────────────────────────
  // Data shapes mirror exactly what puzzle-modules.test.js uses for each type.

  // binairo widget: cacheKey + staticSig
  {
    const p = fixtures.binairo6x6;
    const data = {
      type: 'binairo', rows: p.rows, cols: p.cols,
      givens: p.givens, comparisonClues: [],
    };
    out['widget:binairo:cacheKey'] = binairoW.cacheKey(data);
    out['widget:binairo:staticSig'] = binairoW.staticSig(data);
  }

  // hashi widget: cacheKey + staticSig
  {
    const p = fixtures.hashi3x3Tiny;
    const data = { type: 'hashi', rows: p.rows, cols: p.cols, islands: p.islands };
    out['widget:hashi:cacheKey'] = hashiW.cacheKey(data);
    out['widget:hashi:staticSig'] = hashiW.staticSig(data);
  }

  // heyawake widget: cacheKey + staticSig
  {
    const p = fixtures.heyawake6x6Easy;
    const rooms = heyawakeRoomsFromFixture(p);
    const data = { type: 'heyawake', rows: p.rows, cols: p.cols, areas: p.areas, rooms };
    out['widget:heyawake:cacheKey'] = heyawakeW.cacheKey(data);
    out['widget:heyawake:staticSig'] = heyawakeW.staticSig(data);
  }

  // hitori widget: cacheKey + staticSig
  {
    const p = fixtures.hitori5x5Easy;
    const data = { type: 'hitori', rows: p.rows, cols: p.cols, task: p.task };
    out['widget:hitori:cacheKey'] = hitoriW.cacheKey(data);
    out['widget:hitori:staticSig'] = hitoriW.staticSig(data);
  }

  // kakurasu widget: cacheKey + staticSig
  {
    const p = fixtures.kakurasu4x4Easy;
    const data = { type: 'kakurasu', rows: p.rows, cols: p.cols,
      rowClues: p.rowClues, colClues: p.colClues };
    out['widget:kakurasu:cacheKey'] = kakurasuW.cacheKey(data);
    out['widget:kakurasu:staticSig'] = kakurasuW.staticSig(data);
  }

  // kurodoko widget: cacheKey + staticSig
  {
    const p = fixtures.kurodoko5x5Easy;
    const data = { type: 'kurodoko', rows: p.rows, cols: p.cols, task: p.task };
    out['widget:kurodoko:cacheKey'] = kurodokoW.cacheKey(data);
    out['widget:kurodoko:staticSig'] = kurodokoW.staticSig(data);
  }

  // mosaic widget: cacheKey + staticSig
  {
    const p = fixtures.mosaic5x5Easy;
    const data = { type: 'mosaic', rows: p.rows, cols: p.cols, task: p.task };
    out['widget:mosaic:cacheKey'] = mosaicW.cacheKey(data);
    out['widget:mosaic:staticSig'] = mosaicW.staticSig(data);
  }

  // norinori widget: cacheKey + staticSig
  {
    const p = fixtures.norinori6x6Normal;
    const data = { type: 'norinori', rows: p.rows, cols: p.cols, areas: p.areas };
    out['widget:norinori:cacheKey'] = norinoriW.cacheKey(data);
    out['widget:norinori:staticSig'] = norinoriW.staticSig(data);
  }

  // nurikabe widget: cacheKey + staticSig
  {
    const p = fixtures.nurikabe5x5Easy;
    const data = { type: 'nurikabe', rows: p.rows, cols: p.cols, task: p.task };
    out['widget:nurikabe:cacheKey'] = nurikabeW.cacheKey(data);
    out['widget:nurikabe:staticSig'] = nurikabeW.staticSig(data);
  }

  // shikaku widget: cacheKey + staticSig
  {
    const p = fixtures.shikaku5x5;
    const data = { type: 'shikaku', rows: p.rows, cols: p.cols, clues: p.clues };
    out['widget:shikaku:cacheKey'] = shikakuW.cacheKey(data);
    out['widget:shikaku:staticSig'] = shikakuW.staticSig(data);
  }

  // slitherlink widget: cacheKey + staticSig
  {
    const p = fixtures.slitherlink5x5;
    const data = { type: 'slitherlink', rows: p.rows, cols: p.cols, task: p.task };
    out['widget:slitherlink:cacheKey'] = slitherlinkW.cacheKey(data);
    out['widget:slitherlink:staticSig'] = slitherlinkW.staticSig(data);
  }

  // yinyang widget: cacheKey only (no staticSig on this module)
  {
    const p = fixtures.yinyang6x6;
    const data = { type: 'yinyang', rows: p.rows, cols: p.cols, task: p.task };
    out['widget:yinyang:cacheKey'] = yinyangW.cacheKey(data);
  }

  return out;
}

// ── test ────────────────────────────────────────────────────────────────────
test('cache keys are unchanged (FNV parity)', () => {
  const keys = currentKeys();

  if (process.env.RECORD === '1') {
    console.log('GOLDEN =', JSON.stringify(keys, null, 2));
    return;
  }

  for (const [name, val] of Object.entries(keys)) {
    assert.equal(val, GOLDEN[name], `cache key changed for ${name}`);
  }

  // Fail if GOLDEN has an entry that currentKeys() no longer produces.
  for (const name of Object.keys(GOLDEN)) {
    assert.ok(name in keys, `GOLDEN has ${name} but currentKeys() does not produce it`);
  }
});
