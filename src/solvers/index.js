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

// NOTE: keep this aggregator in sync with src/solvers/*.js — every solver class
// in the directory must be re-exported here. tests/solvers-index.test.js guards
// against drift (the production bundle uses the bundler's own FILES list, so a
// stale index.js fails only for require('../solver.js') consumers).
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
const { PipesSolver } = require('./pipes.js');
const { ShingokiSolver } = require('./shingoki.js');
const { ShakashakaSolver } = require('./shakashaka.js');
const { LightUpSolver } = require('./lightup.js');
const { MasyuSolver } = require('./masyu.js');
const { SlantSolver } = require('./slant.js');
const { StarBattleSolver } = require('./starbattle.js');
const { StitchesSolver } = require('./stitches.js');
const { TapaSolver } = require('./tapa.js');
const { TentsSolver } = require('./tents.js');
const { ThermometersSolver } = require('./thermometers.js');
const { LollipopsSolver } = require('./lollipops.js');
const { computePuzzleDiff } = require('./diff.js');

module.exports = {
  NonogramSolver, AquariumSolver, GalaxiesSolver, BinairoSolver,
  ShikakuSolver, YinYangSolver, SlitherlinkSolver, HashiSolver,
  HeyawakeSolver, HitoriSolver, KakurasuSolver, KurodokoSolver,
  MosaicSolver, NorinoriSolver, NurikabeSolver, PipesSolver, ShingokiSolver,
  ShakashakaSolver, LightUpSolver, MasyuSolver, SlantSolver, StarBattleSolver,
  StitchesSolver, TapaSolver, TentsSolver, ThermometersSolver, LollipopsSolver,
  computePuzzleDiff,
};
