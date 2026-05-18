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

// Helpers from handler.js.
declare function callMainWorld(funcName: string, args?: unknown[]): Promise<any>;
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
