// Ambient declarations for cross-file references and platform globals.
// Content scripts share a single execution scope at runtime (solver.js,
// handler.js, content.js are loaded as siblings per manifest.json's
// content_scripts.js entry), so a function in one file is a free global in
// the others — but tsc lints each file in isolation and can't see those.
// Service worker similarly resolves globals from main-world.js via
// importScripts. Declare the cross-file consumers here so typecheck doesn't
// fail on legitimate cross-file usage while still catching typos.

declare const chrome: any;

// Solver classes from solver.js (used by content.js, handler.js, solver.worker.js).
declare const NonogramSolver: any;
declare const AquariumSolver: any;
declare const GalaxiesSolver: any;
declare const BinairoSolver: any;
declare const ShikakuSolver: any;
declare const YinYangSolver: any;
declare const SlitherlinkSolver: any;
declare const HashiSolver: any;
declare const HeyawakeSolver: any;
declare const HitoriSolver: any;
declare const KakurasuSolver: any;
declare const KurodokoSolver: any;
declare const MosaicSolver: any;
declare const NorinoriSolver: any;
declare const NurikabeSolver: any;

// JSDoc typedefs referenced by per-puzzle solver files in src/solvers/.
// The originals lived as JSDoc @typedef in the old monolithic solver.js
// header; declaring them here keeps tsc clean after the split.
type SolveResult = any;
type Star = any;

// Helpers from handler.js.
// MainWorldFn mirrors EXEC_MAIN_ALLOWLIST in background.js — a typo in
// callMainWorld('readGameClue', ...) typechecks against `string` but silently
// returns null at runtime because the SW's allowlist rejects unknown names.
// Keep this union in sync with EXEC_MAIN_ALLOWLIST.
type MainWorldFn =
  | 'readGameState'
  | 'readGameClues'
  | 'readGalaxiesData'
  | 'readGalaxiesState'
  | 'applyGalaxiesState'
  | 'readBinairoData'
  | 'readBinairoState'
  | 'applyBinairoState'
  | 'readShikakuData'
  | 'readShikakuState'
  | 'applyShikakuState'
  | 'readYinYangData'
  | 'readYinYangState'
  | 'applyYinYangState'
  | 'readSlitherlinkData'
  | 'readSlitherlinkState'
  | 'applySlitherlinkState'
  | 'readHashiData'
  | 'readHashiState'
  | 'applyHashiState'
  | 'readHeyawakeData'
  | 'readHeyawakeState'
  | 'applyHeyawakeState'
  | 'readHitoriData'
  | 'readHitoriState'
  | 'applyHitoriState'
  | 'readKakurasuData'
  | 'readKakurasuState'
  | 'applyKakurasuState'
  | 'readKurodokoData'
  | 'readKurodokoState'
  | 'applyKurodokoState'
  | 'readMosaicData'
  | 'readMosaicState'
  | 'applyMosaicState'
  | 'readNorinoriData'
  | 'readNorinoriState'
  | 'applyNorinoriState'
  | 'readNurikabeData'
  | 'readNurikabeState'
  | 'applyNurikabeState'
  | 'applyGameState'
  | 'applyHintCells'
  | 'dumpPuzzleForBench';
declare function computePuzzleDiff(type: string, grid: any, solution: any, stars?: any): ({ row: number, col: number } | { orientation: 'h' | 'v', r: number, c: number } | { a: number, b: number, orientation: any, expected: any, actual: any })[];
declare function callMainWorld(funcName: MainWorldFn, args?: unknown[]): Promise<any>;
declare function getActiveHandler(): any;
declare function parsePuzzleTask(): any;
declare function parseGalaxiesTask(task: string | null, width: number, height: number): any;

// Symbols defined in src/widget/*.js (concatenated with content.js by
// scripts/build-content-bundle.js). content.js still references them
// directly after the Phase-1 split.
declare let detectedGrid: any;
declare let suppressStateWatch: any;
declare let undoStack: any;
declare let redoStack: any;
declare const MAX_UNDO: any;
declare let mutatingOp: any;
declare let mutatingOpTimer: any;
declare const MUTATING_OP_TIMEOUT_MS: any;
declare function setMutatingOp(name: any): any;
declare function clearMutatingOp(): any;
declare let solverWorker: any;
declare let solverWorkerInit: any;
declare let solverNextId: any;
declare const solverPending: any;
declare function getSolverWorker(): any;
declare function runSolve(rowClues: any, colClues: any, initialGrid: any, solverType?: any, extraData?: any): any;
declare const SOLUTION_TTL_MS: any;
declare const SOLUTION_CACHE_MAX: any;
declare const SOLUTION_KEY_PREFIXES: any;
declare function isSolutionCacheKey(key: any): any;
declare function pruneSolutionCache(): any;
declare function isFreshSolutionEntry(parsed: any): any;
declare function galaxiesCacheKey(data: any): any;
declare function galaxiesPartialKey(data: any): any;
declare function galaxiesFailedKey(data: any): any;
declare function getCachedGalaxiesSolution(data: any): any;
declare function cacheGalaxiesSolution(data: any, grid: any): any;
declare function shikakuCacheKey(data: any): any;
declare function hashiCacheKey(data: any): any;
declare function yinYangCacheKey(data: any): any;
declare function slitherlinkCacheKey(data: any): any;
declare function getCachedGridSolution(data: any): any;
declare function cacheGridSolution(data: any, grid: any): any;
declare function puzzlePartialKey(data: any): any;
declare function getCachedPartial(data: any): any;
declare function cachePartial(data: any, grid: any, filled?: any): any;
declare function clearPartial(data: any): any;
declare function countKnownCells(grid: any): any;
declare function chooseInitialGrid(data: any, currentGrid: any): any;
declare function getCachedGalaxiesPartial(data: any): any;
declare function getFailedGalaxiesPartials(data: any): any;
declare function cacheFailedGalaxiesPartial(data: any, grid: any): any;
declare function clearFailedGalaxiesPartials(data: any): any;
declare function cloneGalaxiesLines(lines: any): any;
declare function getGalaxiesHint(grid: any, stars: any): any;
declare function getGalaxyPath(solution: any): any;
declare function nextGalaxyHint(grid: any, solution: any): any;
declare function firstGalaxiesMismatch(grid: any, solution: any): any;
declare function buildGalaxiesSeedOwner(stars: any, rows: any, cols: any): any;
declare function getGalaxiesComponents(grid: any, stars: any, seedOwner: any): any;
declare function galaxyCellCanBelong(row: any, col: any, nodeIndex: any, stars: any, rows: any, cols: any, seedOwner: any): any;
declare function possibleGalaxiesNodesForCell(row: any, col: any, stars: any, rows: any, cols: any, seedOwner: any): any;
declare function computeReachableStars(stars: any, rows: any, cols: any, seedOwner: any, current: any): any;
declare function intersectSets(a: any, b: any): any;
declare function narrowByMirrorComponent(cellRow: any, cellCol: any, possibleSet: any, stars: any, grid: any): any;
declare function propagateForcedCells(grid: any, stars: any, rows: any, cols: any, seedOwner: any, reachable: any): any;
declare function setsIntersect(a: any, b: any): any;
declare function buildComponentAdjacency(grid: any, rows: any, cols: any, current: any): any;
declare function propagateAllConstraints(components: any, grid: any, rows: any, cols: any, current: any, stars: any): any;
declare function bfsComponentSide(startRow: any, startCol: any, barrierOrient: any, barrierRow: any, barrierCol: any, grid: any, current: any): any;
declare function intersectBitset(cellKeys: any, bitsets: any): any;
declare function findEmptyCompHints(components: any, grid: any, stars: any, reachable: any): any;
declare function getGalaxiesNodeRegions(grid: any, stars: any): any;
declare function firstMismatch(grid: any, solution: any): any;
declare function getAquariumPath(solution: any, regionMap: any): any;
declare function getNonogramPath(solution: any): any;
declare function hintFromCellChunk(cells: any): any;
declare function nextChunkHint(grid: any, path: any): any;
declare function hintAbsoluteCells(hint: any): any;
declare function applyHintToGrid(grid: any, hint: any): any;
declare function addAquariumRegionHints(hint: any, grid: any, solution: any, regionMap: any): any;
// src/widget/preview.js
declare let hintIdCounter: any;
declare const hintIdCache: any;
declare function hintSig(hint: any): any;
declare const FNV_OFFSET: any;
declare const FNV_PRIME: any;
declare function regionMapSig(rm: any): any;
declare function shikakuCluesSig(clues: any): any;
declare function slitherlinkCluesSig(task: any): any;
declare function hashiIslandsSig(islands: any): any;
declare function gridDataSig(grid: any): any;
declare function buildLatticeLayer(rows: any, cols: any, cellSize: any, w: any, h: any, pd?: any): any;
declare function buildStaticLayer(rows: any, cols: any, cellSize: any, w: any, h: any, pd?: any): any;
declare function drawShikakuCluesOn(ctx: any, cellSize: any, clues: any): any;
declare function drawHashiIslandsOn(ctx: any, cellSize: any, islands: any): any;
declare function drawHeyawakeRoomsOn(ctx: any, rows: any, cols: any, cellSize: any, areas: any, rooms?: any): any;
declare function drawRegionBordersOn(ctx: any, rows: any, cols: any, cellSize: any, rm: any): any;
declare function renderPreview(canvas: any, puzzleData: any, grid: any, hint?: any, bodyWidth?: any): any;
declare let latticeLayer: any;
declare let staticLayer: any;
declare let staticLayerSig: any;
declare let lastDrawSig: any;
declare let previewWrap: any;
// src/widget/widget.js
declare function makeWidget(): any;
declare let widgetExpandFn: any;
declare const PUZZLES: any;

// Page MAIN-world globals reachable from main-world.js functions (which run
// in the page after fn.toString() injection). main-world.js itself is under
// @ts-nocheck for this reason.
interface Window {
  Game?: any;
  startTime?: number;
}
