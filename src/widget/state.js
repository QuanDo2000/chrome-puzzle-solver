'use strict';

let detectedGrid = null;
let suppressStateWatch = false;

let undoStack = [];
let redoStack = [];
const MAX_UNDO = 50;

// Serializes apply / undo / redo so concurrent invocations (e.g. user clicks
// Undo while the solver is mid-apply) can't interleave their grid reads with
// each other's grid writes. Each operation sets this to its name on entry and
// clears it on exit (try/finally). Other operations bail with a clear error.
let mutatingOp = null;
let mutatingOpTimer = null;
const MUTATING_OP_TIMEOUT_MS = 30000;

// Wrappers so a handler that throws past the try/finally — or a hung Worker
// that never resolves — cannot leave the flag stuck and lock out every
// subsequent action until reload.
function setMutatingOp(name) {
  mutatingOp = name;
  if (mutatingOpTimer) clearTimeout(mutatingOpTimer);
  mutatingOpTimer = setTimeout(() => {
    console.warn(`[puzzle-solver] mutatingOp '${mutatingOp}' stuck >${MUTATING_OP_TIMEOUT_MS}ms; clearing`);
    mutatingOp = null;
    mutatingOpTimer = null;
  }, MUTATING_OP_TIMEOUT_MS);
}

function clearMutatingOp() {
  mutatingOp = null;
  if (mutatingOpTimer) { clearTimeout(mutatingOpTimer); mutatingOpTimer = null; }
}

// ── Widget storage prefs ──────────────────────────────────────
//
// Tiny per-user localStorage layer so the widget remembers whether it was
// expanded/collapsed across reloads. Kept here rather than in widget.js so
// other modules (and tests) can read the prefs key without pulling in the
// whole DOM-building shell.

const WIDGET_STORAGE_KEY = 'ns_widget_state';

function loadWidgetPref() {
  try {
    const v = localStorage.getItem(WIDGET_STORAGE_KEY);
    return v ? JSON.parse(v) : {};
  } catch { return {}; }
}

function saveWidgetPref(pref) {
  try { localStorage.setItem(WIDGET_STORAGE_KEY, JSON.stringify(pref)); } catch {}
}

// ── Dispatcher contract assertions ────────────────────────────
//
// Each registry hook (`hintDispatch`, `loopDoneCheck`, `applyHint`,
// `partialResultArm`, `cacheKey`) is called via a dispatcher that builds a
// ctx object from widget closure state. When a dispatcher silently passes
// an incomplete ctx, the puzzle's hook destructures undefined and produces
// hard-to-debug downstream failures (e.g. Stage D T7's duplicate-dispatcher
// where the binairo hook silently propagated from givens-only because grid
// was missing). assertCtxHas surfaces those bugs at the dispatcher boundary
// — devs see the warn AND the surrounding try/catch (in hintHandler,
// applyHintHandler, etc.) catches the throw so the user sees an error
// message instead of a crash.
function assertCtxHas(ctx, fields, hookName) {
  for (const f of fields) {
    if (!ctx || ctx[f] === undefined) {
      const msg = `Dispatcher contract violation: ${hookName} missing ctx.${f}`;
      console.warn('[puzzle-solver]', msg);
      throw new Error(msg);
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    detectedGrid, suppressStateWatch, undoStack, redoStack, MAX_UNDO,
    mutatingOp, mutatingOpTimer, MUTATING_OP_TIMEOUT_MS,
    setMutatingOp, clearMutatingOp,
    WIDGET_STORAGE_KEY, loadWidgetPref, saveWidgetPref,
    assertCtxHas,
  };
}
