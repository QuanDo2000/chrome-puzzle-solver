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
const { computePuzzleDiff } = require('./diff.js');

module.exports = {
  NonogramSolver, AquariumSolver, GalaxiesSolver, BinairoSolver,
  ShikakuSolver, YinYangSolver, SlitherlinkSolver, HashiSolver,
  HeyawakeSolver, HitoriSolver, KakurasuSolver, KurodokoSolver,
  MosaicSolver, NorinoriSolver, NurikabeSolver, computePuzzleDiff,
};
