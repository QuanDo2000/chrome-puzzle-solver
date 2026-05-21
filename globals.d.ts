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
  | 'applyGameState'
  | 'applyHintCells'
  | 'dumpPuzzleForBench';
declare function computePuzzleDiff(type: string, grid: any, solution: any): { row: number, col: number }[];
declare function callMainWorld(funcName: MainWorldFn, args?: unknown[]): Promise<any>;
declare function getActiveHandler(): any;
declare function parsePuzzleTask(): any;
declare function parseGalaxiesTask(task: string | null, width: number, height: number): any;

// Page MAIN-world globals reachable from main-world.js functions (which run
// in the page after fn.toString() injection). main-world.js itself is under
// @ts-nocheck for this reason.
interface Window {
  Game?: any;
  startTime?: number;
}
