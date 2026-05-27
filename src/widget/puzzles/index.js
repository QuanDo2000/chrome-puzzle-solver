'use strict';
// Per-puzzle registry. Populated as Phase 3 of the content.js split
// progresses — each src/widget/puzzles/<type>.js file declares its module
// as a bundle-scope `const <type> = { ... }` and is concatenated before
// this file by scripts/build-content-bundle.js. The typeof guard here
// keeps the file loadable both in the bundle (where prior siblings
// supply the consts) and in vm-context Node tests (where this file may
// be loaded standalone — the registry stays empty in that case).
const PUZZLES = {};
if (typeof nonogram !== 'undefined') PUZZLES[nonogram.type] = nonogram;
if (typeof binairo !== 'undefined') PUZZLES[binairo.type] = binairo;
if (typeof hitori !== 'undefined') PUZZLES[hitori.type] = hitori;
if (typeof kakurasu !== 'undefined') PUZZLES[kakurasu.type] = kakurasu;
if (typeof kurodoko !== 'undefined') PUZZLES[kurodoko.type] = kurodoko;
if (typeof mosaic !== 'undefined') PUZZLES[mosaic.type] = mosaic;
if (typeof norinori !== 'undefined') PUZZLES[norinori.type] = norinori;
if (typeof nurikabe !== 'undefined') PUZZLES[nurikabe.type] = nurikabe;
if (typeof heyawake !== 'undefined') PUZZLES[heyawake.type] = heyawake;
if (typeof yinyang !== 'undefined') PUZZLES[yinyang.type] = yinyang;
if (typeof aquarium !== 'undefined') PUZZLES[aquarium.type] = aquarium;
if (typeof shikaku !== 'undefined') PUZZLES[shikaku.type] = shikaku;
if (typeof hashi !== 'undefined') PUZZLES[hashi.type] = hashi;

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PUZZLES };
}
