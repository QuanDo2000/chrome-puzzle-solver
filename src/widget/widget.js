'use strict';

// Widget shell. The makeWidget() factory builds the DOM, wires button
// handlers, mounts the state-watch MutationObserver, and wires lifecycle
// hooks (pagehide/pageshow). widgetExpandFn is assigned by makeWidget
// so the top-level chrome.runtime.onMessage listener in content.js can
// drive widget expansion without reaching into the closure.
//
// Bundle order: this file is concatenated AFTER preview.js (so it sees
// renderPreview / latticeLayer / etc. at module scope) and BEFORE
// content.js (so content.js's listener and DOM-ready bootstrap can
// reference makeWidget and widgetExpandFn).

// Reference set by makeWidget() so the top-level message listener (for the
// toolbar-icon click → expandWidget action) can drive the widget without
// reaching into its closure.
let widgetExpandFn = null;

function makeWidget() {
  const pref = loadWidgetPref();
  let expanded = pref.expanded !== false;
  let puzzleData = null;
  let confirming = false;
  let loopConfirming = false;
  let looping = false;
  let stopLooping = false;
  let stopLoopWait = null;  // set to a cancellation fn while the loop is sleeping
  let pendingAutoSolve = null;
  let solveBtn = null;
  let loopBtn = null;

  const shadow = document.createElement('div');
  shadow.id = 'ns-widget-shadow';

  const style = document.createElement('style');
  style.textContent = `
#ns-widget {
  all: initial;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 14px;
  color: #1a1a2e;
  position: fixed;
  z-index: 2147483647;
  bottom: 16px;
  left: 16px;
  width: 380px;
  background: rgba(248, 249, 250, 0.92);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid rgba(222, 226, 230, 0.6);
  border-radius: 10px;
  box-shadow: 0 4px 24px rgba(0,0,0,.15);
  overflow: hidden;
  transition: height .2s, width .2s;
}
#ns-widget.ns-collapsed {
  width: 48px;
  height: 48px;
  border-radius: 24px;
  cursor: pointer;
}
#ns-widget.ns-collapsed .ns-header {
  width: 48px; height: 48px; padding: 0;
  border-radius: 24px; justify-content: center;
}
#ns-widget.ns-collapsed .ns-label { display: none; }
#ns-widget.ns-collapsed .ns-ico {
  font-size: 26px;
  display: flex; align-items: center; justify-content: center;
  width: 48px; height: 48px;
}
#ns-widget .ns-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: rgba(28, 126, 214, 0.88);
  color: #fff;
  cursor: pointer;
  user-select: none;
}
#ns-widget .ns-title { font-weight: 700; font-size: 16px; }
#ns-widget .ns-body { padding: 10px 14px 14px; }
#ns-widget .ns-btns { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
#ns-widget .ns-btn-row { display: flex; flex-wrap: wrap; gap: 6px; }
#ns-widget .ns-btns button {
  padding: 6px 10px; border: none; border-radius: 5px;
  font-size: 13px; font-weight: 600; cursor: pointer;
  background: #e9ecef; color: #495057;
}
#ns-widget .ns-btns button:hover { opacity: .8; }
#ns-widget .ns-btns button:disabled { opacity: .4; cursor: not-allowed; }
#ns-widget .ns-btns .ns-primary { background: #1c7ed6; color: #fff; }
#ns-widget .ns-btns .ns-success { background: #2b8a3e; color: #fff; }
#ns-widget .ns-status {
  padding: 7px 10px; border-radius: 6px; font-size: 13px;
  margin-bottom: 8px; background: #e9ecef; color: #495057;
  line-height: 1.3;
}
#ns-widget .ns-status.ns-info { background: #d0ebff; color: #1c7ed6; }
#ns-widget .ns-status.ns-error { background: #ffe0e0; color: #c92a2a; }
#ns-widget .ns-status.ns-success { background: #d3f9d8; color: #2b8a3e; }
#ns-widget canvas {
  display: block; border: 1px solid #dee2e6; border-radius: 4px;
  max-width: 100%; width: 100%; height: auto;
}
#ns-widget .ns-ico { font-size: 22px; line-height: 1; }
#ns-widget .ns-sr-only {
  position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0);
}
#ns-widget .ns-preview-wrap { display: none; }
#ns-widget .ns-preview-wrap.ns-visible { display: block; }
`;

  shadow.appendChild(style);

  const html = `
<div id="ns-widget" class="${expanded ? '' : 'ns-collapsed'}">
  <div class="ns-header">
    <span class="ns-title"><span class="ns-ico">🧩</span><span class="ns-label"> Solver</span></span>
  </div>
  <div class="ns-body">
    <div class="ns-btns">
      <div class="ns-btn-row">
        <button data-action="detect" class="ns-primary">Detect</button>
        <button data-action="solve" disabled>Solve</button>
        <button data-action="loop" disabled>Loop</button>
        <button data-action="hint" disabled>Hint</button>
        <button data-action="applyHint" disabled>Apply</button>
      </div>
      <div class="ns-btn-row">
        <button data-action="undo" disabled>↩ Undo</button>
        <button data-action="redo" disabled>↪ Redo</button>
        <button data-action="dump">📋 Dump</button>
      </div>
    </div>
    <div class="ns-status" id="ns-status">Ready</div>
    <div class="ns-preview-wrap" id="ns-preview-wrap">
      <canvas id="ns-canvas"></canvas>
    </div>
  </div>
</div>`;
  shadow.insertAdjacentHTML('beforeend', html);
  document.documentElement.appendChild(shadow);

  const root = shadow.querySelector('#ns-widget');

  function q(sel) { return shadow.querySelector(sel); }

  const statusEl = q('#ns-status');
  const canvas = q('#ns-canvas');
  previewWrap = q('#ns-preview-wrap');
  solveBtn = q('[data-action="solve"]');
  loopBtn = q('[data-action="loop"]');

  function setHintLabel(text) {
    q('[data-action="hint"]').textContent = text;
  }

  // Reset the "pending hint" UI state in one call: clear the cached hint,
  // restore the button label, and disable Apply Hint. Replaces the three-line
  // pattern that used to appear scattered through the handlers (sometimes with
  // accidental duplication).
  function clearPendingHint() {
    if (puzzleData) puzzleData.pendingHint = null;
    setHintLabel('Hint');
    q('[data-action="applyHint"]').disabled = true;
  }

  // Human-readable description of a Galaxies hint's boundary line(s).
  function galaxiesHintLineDesc(h) {
    const lines = h.lineHints || [h];
    if (lines.length !== 1) return `${lines.length} boundary lines`;
    const l = lines[0];
    return l.orientation === 'horizontal'
      ? `horizontal boundary below row ${l.row}, column ${l.col + 1}`
      : `vertical boundary at row ${l.row + 1}, after column ${l.col}`;
  }

  // Returns an array of DOM nodes / strings describing a row/col nonogram hint,
  // for use with setStatusNodes(). Replaces the old html-string approach so we
  // never pass dynamic content through innerHTML.
  // Write the status text for a hint (galaxies → "Draw the X.", others →
  // hintStatusNodes). Optional `prefix` is prepended verbatim — the loop body
  // uses `Step N: ` so it threads through one branch.
  function setHintStatus(h, prefix = '') {
    const reg = (typeof PUZZLES !== 'undefined' && PUZZLES) ? PUZZLES[puzzleData?.type] : null;
    if (reg?.hintStatusNodes) {
      setStatusNodes('info', prefix, ...reg.hintStatusNodes(h, { bold }));
    } else if (h.type === 'galaxies') {
      setStatusNodes('info', prefix, 'Draw the ', bold(galaxiesHintLineDesc(h)), '.');
    } else if (puzzleData?.type === 'shikaku') {
      setStatusNodes('info', prefix, ...shikakuHintStatusNodes(h));
    } else if (puzzleData?.type === 'yinyang') {
      setStatusNodes('info', prefix, ...yinYangHintStatusNodes(h));
    } else if (puzzleData?.type === 'slitherlink') {
      setStatusNodes('info', prefix, ...slitherlinkHintStatusNodes(h));
    } else if (puzzleData?.type === 'hashi') {
      setStatusNodes('info', prefix, ...hashiHintStatusNodes(h));
    } else if (puzzleData?.type === 'heyawake') {
      setStatusNodes('info', prefix, ...heyawakeHintStatusNodes(h));
    } else if (puzzleData?.type === 'nurikabe') {
      setStatusNodes('info', prefix, ...nurikabeHintStatusNodes(h));
    } else {
      setStatusNodes('info', prefix, ...hintStatusNodes(h));
    }
  }

  // Heyawake hints carry absolute cells in extraCells (no row/column index
  // — every hint is a flat list of forced cells from propagation).
  // cellStatus 1 = black, 2 = white-mark; same encoding as Yin-Yang.
  function heyawakeHintStatusNodes(h) {
    const cells = h.extraCells || [];
    if (cells.length === 0) return ['No hint available'];
    if (cells.length === 1) {
      const cell = cells[0];
      const valueStr = cell.value === 1 ? 'black' : 'white';
      return [
        'Cell ', bold(`(row ${cell.row + 1}, col ${cell.col + 1})`),
        ' must be ', bold(valueStr),
      ];
    }
    return [bold(String(cells.length)), ' cells can be deduced'];
  }

  // Nurikabe hints carry absolute cells in extraCells.
  // cellStatus 1 = sea (black), 2 = island (white).
  function nurikabeHintStatusNodes(h) {
    const cells = h.extraCells || [];
    if (cells.length === 0) return ['No hint available'];
    if (cells.length === 1) {
      const cell = cells[0];
      const valueStr = cell.value === 1 ? 'sea (black)' : 'island (white)';
      return [
        'Cell ', bold(`(row ${cell.row + 1}, col ${cell.col + 1})`),
        ' must be ', bold(valueStr),
      ];
    }
    return [bold(String(cells.length)), ' cells can be deduced'];
  }

  function yinYangHintStatusNodes(h) {
    const total = (h.cells?.length || 0) + (h.extraCells?.length || 0);
    if (total === 0) return ['No hint available'];
    if (total === 1) {
      const cell = h.cells?.[0] || h.extraCells?.[0];
      const row = h.cells?.length ? h.index : cell.row;
      const col = h.cells?.length ? cell.index : cell.col;
      // Yin-Yang cellStatus: 1 = black, 2 = white.
      const valueStr = cell.value === 1 ? 'black' : 'white';
      return [
        'Cell ', bold(`(row ${row + 1}, col ${col + 1})`),
        ' must be ', bold(valueStr),
      ];
    }
    return [bold(String(total)), ' cells can be deduced'];
  }

  function shikakuHintStatusNodes(h) {
    const total = (h.cells?.length || 0) + (h.extraCells?.length || 0);
    if (total === 0) return ['No hint available'];
    if (h.clue) {
      return [
        'Draw the ', bold(`${h.clue.area}`), '-cell rectangle for the clue at ',
        bold(`(row ${h.clue.row + 1}, col ${h.clue.col + 1})`),
      ];
    }
    return [bold(String(total)), ' cells can be deduced'];
  }

  function slitherlinkHintStatusNodes(h) {
    const total = h?.edges?.length || 0;
    if (total === 0) return ['No hint available'];
    if (total === 1) {
      const e = h.edges[0];
      const desc = e.orientation === 'h'
        ? `the top of cell (row ${e.r + 1}, col ${e.c + 1}) / bottom of (row ${e.r}, col ${e.c + 1})`
        : `the left of cell (row ${e.r + 1}, col ${e.c + 1}) / right of (row ${e.r + 1}, col ${e.c})`;
      return ['Draw a line along ', bold(desc), '.'];
    }
    return [bold(String(total)), ' edges can be deduced'];
  }

  function hashiHintStatusNodes(h) {
    // Hashi hints are an array of { a, b, orientation, bridges } edges; bridges
    // is the deduced count (1 or 2, or 0 for "this connection is impossible").
    // Stepwise hints carry a .description naming the rule that fired — show it
    // verbatim so the user sees the logical reason for the deduction.
    const total = h?.edges?.length || 0;
    if (total === 0) return ['No hint available'];
    if (h.description) {
      return [bold(h.description)];
    }
    const islands = puzzleData?.islands || [];
    const fmtIsland = (idx) => {
      const isl = islands[idx];
      if (!isl) return `island ${idx}`;
      return `(row ${isl.row + 1}, col ${isl.col + 1})`;
    };
    if (total === 1) {
      const e = h.edges[0];
      const bridgeWord = e.bridges === 1 ? 'single bridge'
        : e.bridges === 2 ? 'double bridge'
        : `${e.bridges} bridges`;
      return [
        'Draw a ', bold(bridgeWord),
        ' between ', bold(fmtIsland(e.a)),
        ' and ', bold(fmtIsland(e.b)), '.',
      ];
    }
    return [bold(String(total)), ' bridges can be deduced'];
  }

  // Status + preview after a freshly computed hint. Used by hintHandler,
  // previewFirstLoopStep, and the state-watch debounce. Per-caller state
  // (pendingHint, applyHint button enable, puzzleData.solution updates)
  // stays at the call site.
  function renderHintStatusAndPreview(h, grid) {
    setHintStatus(h);
    if (grid) {
      // Hashi's drawPreview arm reads bridges from grid.edges; the hint
      // edges must be merged in first since hashi has no separate hint-
      // overlay branch (slitherlink/galaxies/cell-based hints paint via
      // dedicated overlay paths in drawPreview).
      if (h?.type === 'hashi') applyHintToGrid(grid, h);
      drawPreview(grid, h);
    }
  }

  function hintStatusNodes(h) {
    const label = h.type === 'row' ? 'Row' : 'Column';
    const clueStr = Array.isArray(h.clue) ? h.clue.join(', ') : null;
    const filled = h.cells.filter(c => c.value === 1).map(c => c.index + 1);
    const crossed = h.cells.filter(c => c.value === -1).map(c => c.index + 1);
    const extra = h.extraCells || [];

    const nodes = [bold(`${label} ${h.index + 1}`),
                   clueStr !== null ? ` (clue: ${clueStr}): ` : ': '];
    const segments = [];
    if (filled.length) segments.push(['cells ', bold(fmtList(filled)), ' must be filled']);
    if (crossed.length) segments.push(['cells ', bold(fmtList(crossed)), ' must be empty']);
    if (extra.length) {
      segments.push([bold(String(extra.length)),
        ' related aquarium cell' + (extra.length === 1 ? '' : 's') + ' can also be filled']);
    }
    for (let i = 0; i < segments.length; i++) {
      if (i > 0) nodes.push(', ');
      for (const seg of segments[i]) nodes.push(seg);
    }
    return nodes;
  }

  function setStatus(msg, type) {
    statusEl.textContent = msg;
    statusEl.className = 'ns-status' + (type ? ' ns-' + type : '');
  }

  // Safer replacement for the old setStatusHtml: appends DOM nodes directly,
  // never sets innerHTML. Strings become text nodes (HTML chars are not parsed).
  // Use bold() to wrap text in a <b>; pass arrays to splat-merge.
  function setStatusNodes(type, ...parts) {
    while (statusEl.firstChild) statusEl.removeChild(statusEl.firstChild);
    for (const p of parts) {
      if (p instanceof Node) statusEl.appendChild(p);
      else statusEl.appendChild(document.createTextNode(String(p)));
    }
    statusEl.className = 'ns-status' + (type ? ' ns-' + type : '');
  }

  function bold(text) {
    const b = document.createElement('b');
    b.textContent = text;
    return b;
  }

  // Render the "no puzzle detected" status with a clickable list of the
  // puzzle types this extension supports. Same content on the homepage
  // and on any unrecognized page within puzzles-mobile.com.
  function showSupportedPuzzles(detectError) {
    while (statusEl.firstChild) statusEl.removeChild(statusEl.firstChild);
    statusEl.className = 'ns-status ns-info';

    const header = document.createElement('div');
    header.appendChild(bold(detectError ? `No puzzle here: ${detectError}` : 'No puzzle on this page.'));
    statusEl.appendChild(header);

    const sub = document.createElement('div');
    sub.textContent = 'Supported puzzles:';
    sub.style.marginTop = '4px';
    statusEl.appendChild(sub);

    const list = document.createElement('ul');
    list.style.cssText = 'margin:2px 0 0 0;padding-left:18px;';
    for (const p of SUPPORTED_PUZZLES) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = p.url;
      a.textContent = p.name;
      a.style.color = 'inherit';
      li.appendChild(a);
      list.appendChild(li);
    }
    statusEl.appendChild(list);
  }

  // Cached state for drawPreview's incremental rendering.
  // - lastDrawSig: full signature of the last successful draw. Identical input
  //   skips the entire redraw (state-watch fires every 200ms even when nothing
  //   visually changed).
  // - latticeLayer: offscreen canvas with just the gray cell-border lattice.
  //   Drawn FIRST so dynamic fills paint over it (a black filled cell hides
  //   the gray border within its area, matching the pre-refactor look).
  // - staticLayer: offscreen canvas with region borders, nonogram every-5
  //   guides, and galaxies stars — pixels that should sit ON TOP of fills.
  //   Both rebuilt only when cellSize / regionMap / stars change.

  // Identity-based hint signature: hints are typically replaced wholesale, not
  // mutated, so reference identity is a safe proxy for "same hint as last
  // tick". WeakMap+counter avoids JSON.stringify of the entire hint object
  // (galaxies hints can carry hundreds of lineHints) on every 200ms tick.
  const drawPreview = (grid, hint) =>
    renderPreview(canvas, puzzleData, grid, hint, q('.ns-body').clientWidth || 300);

  function setExpanded(val) {
    expanded = val;
    root.classList.toggle('ns-collapsed', !val);
    saveWidgetPref({ expanded: val });
  }
  widgetExpandFn = setExpanded;

  root.addEventListener('click', (e) => {
    if (!expanded) {
      setExpanded(true);
      return;
    }

    const btn = e.target.closest('[data-action]');
    if (!btn) {
      if (e.target.closest('.ns-header')) setExpanded(false);
      return;
    }
    const action = btn.dataset.action;

    if (action === 'detect') detectHandler();
    else if (action === 'solve') solveHandler();
    else if (action === 'loop') loopHandler();
    else if (action === 'hint') hintHandler();
    else if (action === 'applyHint') applyHintHandler();
    else if (action === 'undo' || action === 'redo') historyHandler(action);
    else if (action === 'dump') dumpHandler();
  });

  async function detectHandler() {
    setStatus('Detecting...', 'info');
    const result = await detectPuzzle();
    if (!result || !result.found) {
      showSupportedPuzzles(result?.error);
      return;
    }
    puzzleData = result;
    confirming = false;
    loopConfirming = false;
    looping = false;
    q('[data-action="solve"]').disabled = false;
    q('[data-action="solve"]').textContent = 'Solve';
    q('[data-action="loop"]').disabled = false;
    loopBtn.textContent = 'Loop';
    q('[data-action="hint"]').disabled = false;
    clearPendingHint();

    const stateResult = await readGridState();
    const label = (result.type || 'puzzle').charAt(0).toUpperCase() + (result.type || 'puzzle').slice(1);
    if (stateResult?.success) {
      drawPreview(stateResult.grid);
      setStatus(`Found ${result.rows}×${result.cols} ${label}.`, 'success');
    } else {
      setStatus(`Found ${result.rows}×${result.cols} ${label}.`, 'success');
    }
    updateUndoRedoButtons();
    startStateWatch();
    pendingAutoSolve = autoSolve();
  }

  async function solveHandler() {
    if (!puzzleData) { setStatus('Detect first.', 'error'); return; }

    if (confirming) {
      confirming = false;
      solveBtn.textContent = 'Solve';
      setStatus('Applying...', 'info');
      const applyResult = await applySolution(puzzleData.solution);
      if (applyResult?.success) {
        setStatus('Solved!', 'success');
        const newState = await readGridState();
        if (newState?.success) drawPreview(newState.grid);
      } else {
        setStatus('Apply failed.', 'error');
      }
      updateUndoRedoButtons();
      return;
    }

    const cached = getCachedGalaxiesSolution(puzzleData);
    if (!puzzleData.solution && cached) puzzleData.solution = cached;

    if (!puzzleData.solution && pendingAutoSolve) {
      setStatus('Solving...', 'info');
      await pendingAutoSolve;
    }

    if (puzzleData.solution) {
      loopConfirming = false;
      clearPendingHint();
      solveBtn.textContent = 'Confirm';
      confirming = true;
      setStatus('Preview ready.', 'info');
      drawPreview(puzzleData.solution);
      return;
    }

    setStatus('Solving...', 'info');
    const stateResult = await readGridState();
    const initialGrid = chooseInitialGrid(puzzleData, stateResult?.success ? stateResult.grid : null);
    const result = await runSolve(puzzleData.rowClues, puzzleData.colClues, initialGrid,
      puzzleData.type, solveExtraData());
    if (puzzleData.type === 'galaxies' && result?.error === 'invalid partial state') {
      clearPartial(puzzleData);
      const retry = await runSolve(puzzleData.rowClues, puzzleData.colClues, stateResult?.success ? stateResult.grid : null,
        puzzleData.type, solveExtraData());
      if (retry?.solved) {
        applySolveResult(retry);
        return;
      }
      setStatus(formatSolveError(retry), 'error');
      return;
    }
    if (!result || !result.solved) {
      // Slitherlink-style partial: solver hit the budget during backtracking
      // but propagation + lookahead determined a useful chunk of the loop.
      // Show that as a preview rather than just reporting "timed out".
      if (result?.partial && result.horizontal && result.vertical) {
        applyPartialResult(result);
        return;
      }
      // Hashi partial: HashiSolver.solve emits {partial:true, edges:[...]}
      // on timeout. Show the deduced bridges as a preview instead of
      // dropping them.
      if (result?.partial && puzzleData?.type === 'hashi' && Array.isArray(result.edges)) {
        applyHashiPartialResult(result);
        return;
      }
      // Generic 2D-grid partial: any cell-state puzzle (heyawake, hitori)
      // that emits {partial:true, grid:[...]} on timeout.
      if (result?.partial && puzzleData?.type === 'heyawake' && Array.isArray(result.grid)) {
        applyGridPartialResult(result);
        return;
      }
      if (result?.partial && puzzleData?.type === 'hitori' && Array.isArray(result.grid)) {
        applyPartialResult(result);
        return;
      }
      if (result?.partial && puzzleData?.type === 'kakurasu' && Array.isArray(result.grid)) {
        applyPartialResult(result);
        return;
      }
      if (result?.partial && puzzleData?.type === 'kurodoko' && Array.isArray(result.grid)) {
        applyPartialResult(result);
        return;
      }
      if (result?.partial && puzzleData?.type === 'mosaic' && Array.isArray(result.grid)) {
        applyPartialResult(result);
        return;
      }
      if (result?.partial && puzzleData?.type === 'norinori' && Array.isArray(result.grid)) {
        applyPartialResult(result);
        return;
      }
      if (result?.partial && puzzleData?.type === 'nurikabe' && Array.isArray(result.grid)) {
        applyGridPartialResult(result);
        return;
      }
      if (result?.partialGrid) {
        cachePartial(puzzleData, result.partialGrid, result.partialFilled);
      } else if (result?.error === 'partial state exhausted') {
        if (puzzleData.type === 'galaxies' && result.failedPartialGrid) {
          cacheFailedGalaxiesPartial(puzzleData, result.failedPartialGrid);
        }
        clearPartial(puzzleData);
      }
      setStatus(formatSolveError(result), 'error');
      return;
    }
    applySolveResult(result);
  }

  // Background solve kicked off by Detect. Non-blocking: detectHandler does
  // not await it. Populates puzzleData.solution + the localStorage caches so
  // Solve/Hint/Loop reuse it, and triggers the mistake overlay. Solves from
  // the puzzle's givens (initialGrid = null) so the result is the canonical
  // solution, not biased by the player's possibly-wrong moves. Background
  // failures are silent — features still solve on demand.
  async function autoSolve() {
    const pd = puzzleData; // capture — a later Detect must not be clobbered
    if (!pd || pd.solution) return;
    const cached = pd.type === 'galaxies'
      ? getCachedGalaxiesSolution(pd)
      : getCachedGridSolution(pd);
    if (cached) {
      if (puzzleData === pd) { pd.solution = cached; await afterAutoSolve(pd); }
      return;
    }
    const result = await runSolve(pd.rowClues, pd.colClues, null, pd.type, solveExtraData());
    if (puzzleData !== pd) return; // a newer Detect superseded this solve
    if (result && result.solved) {
      recordSolveSuccess(result);
      await afterAutoSolve(pd);
    } else {
      console.warn('[puzzle-solver] background auto-solve did not solve:', result && result.error);
    }
  }

  // After the auto-solve lands: redraw the preview (so mistakes show) and, if
  // the widget is still idle on the post-detect message, note the count.
  async function afterAutoSolve(pd) {
    const state = await readGridState();
    if (puzzleData !== pd || !pd.solution) return;
    const grid = state && state.success ? state.grid : null;
    if (!grid) return;
    drawPreview(grid);
    if (!confirming && !looping && !loopConfirming && !puzzleData.pendingHint) {
      const mistakes = computePuzzleDiff(pd.type, grid, pd.solution, pd.stars);
      const label = (pd.type || 'puzzle').charAt(0).toUpperCase() + (pd.type || 'puzzle').slice(1);
      const note = mistakes.length
        ? `${mistakes.length} mistake${mistakes.length === 1 ? '' : 's'}`
        : 'no mistakes';
      setStatus(`Found ${pd.rows}×${pd.cols} ${label} — ${note}.`, 'success');
    }
  }

  // Cache solver outputs so subsequent operations (apply, hint, loop) can
  // reuse them. Stops short of the confirm-mode UI transition — applies
  // anywhere we record a successful solve, including paths that aren't going
  // into "preview ready" mode (e.g., loopHandler's own intermediate solve).
  function recordSolveSuccess(result) {
    // Slitherlink's result is { solved, horizontal, vertical }; hashi's result
    // is { solved, edges }; every other puzzle type returns { solved, grid }.
    // Keep puzzleData.solution in the same shape readState returns, so
    // downstream consumers (gsComplete, endComplete, mistake-diff) can compare
    // directly without re-checking.
    if (puzzleData?.type === 'slitherlink') {
      puzzleData.solution = { horizontal: result.horizontal, vertical: result.vertical };
    } else if (puzzleData?.type === 'hashi') {
      puzzleData.solution = { solved: result.solved, edges: result.edges };
    } else {
      puzzleData.solution = result.grid;
    }
    cacheGalaxiesSolution(puzzleData, result.grid);
    cacheGridSolution(puzzleData, puzzleData.solution);
    clearPartial(puzzleData);
    clearFailedGalaxiesPartials(puzzleData);
  }

  // Move from "solving" into "ready to apply": record the solve and put the
  // widget into confirm mode showing a preview. Used by the fresh-solve and
  // retry paths.
  function applySolveResult(result) {
    loopConfirming = false;
    recordSolveSuccess(result);
    clearPendingHint();
    solveBtn.textContent = 'Confirm';
    confirming = true;
    setStatus('Preview ready.', 'info');
    drawPreview(previewGridFromResult(result));
  }

  // For slitherlink the worker result has { horizontal, vertical } instead of
  // .grid; for hashi it has { edges }. drawPreview expects the matching shape
  // (same shape readState returns for the puzzle type). Other puzzle types
  // still pass result.grid through unchanged.
  function previewGridFromResult(result) {
    if (puzzleData?.type === 'slitherlink' && result?.horizontal && result?.vertical) {
      return { horizontal: result.horizontal, vertical: result.vertical };
    }
    if (puzzleData?.type === 'hashi' && result?.edges) {
      return { edges: result.edges };
    }
    return result?.grid;
  }

  // Partial-solution preview for slitherlink: when solve() times out on a
  // hard board (e.g. the 50×40 monthly), the solver returns what propagation
  // + lookahead could deduce as a partial. We show that as a preview the
  // user can apply, with a clear "partial — continue manually" status.
  // We deliberately do NOT call recordSolveSuccess: the partial is a subset
  // of the real solution, so caching it would mis-trigger Loop's done-check
  // and the mistake overlay.
  function applyPartialResult(result) {
    const reg = (typeof PUZZLES !== 'undefined' && PUZZLES) ? PUZZLES[puzzleData?.type] : null;
    if (reg?.partialResultArm) {
      reg.partialResultArm(result, {
        clearPendingHint, setStatus, drawPreview, applyGridPartialResult,
        setConfirming: (v) => { confirming = v; },
        setLoopConfirming: (v) => { loopConfirming = v; },
        setSolveBtnText: (t) => { solveBtn.textContent = t; },
      });
      return;
    }
    loopConfirming = false;
    clearPendingHint();
    solveBtn.textContent = 'Confirm';
    confirming = true;
    let lines = 0;
    for (const row of result.horizontal) for (const v of row) if (v === 1) lines++;
    for (const row of result.vertical)   for (const v of row) if (v === 1) lines++;
    setStatus(
      `Partial only: ${lines} edges deduced (board too hard for full solve). Apply, then finish manually.`,
      'info',
    );
    drawPreview({ horizontal: result.horizontal, vertical: result.vertical });
  }

  // Hashi twin of applyPartialResult. Deliberately does NOT call
  // recordSolveSuccess: a partial cached as the canonical solution would
  // mis-trigger hashiDoneCheck (which would treat partial as the full
  // solution).
  function applyHashiPartialResult(result) {
    loopConfirming = false;
    clearPendingHint();
    solveBtn.textContent = 'Confirm';
    confirming = true;
    setStatus(
      `Partial only: ${result.edges.length} bridges deduced (board too hard for full solve). Apply, then finish manually.`,
      'info',
    );
    drawPreview({ edges: result.edges });
  }

  // Generic 2D-grid partial result handler. Heyawake is the first caller;
  // any future cell-state puzzle that supports partials can use it.
  // Deliberately does NOT call recordSolveSuccess (matches the slitherlink/
  // hashi precedent — caching a partial would mis-trigger Loop done-check
  // and the mistake overlay).
  function applyGridPartialResult(result) {
    loopConfirming = false;
    clearPendingHint();
    solveBtn.textContent = 'Confirm';
    confirming = true;
    let filled = 0;
    for (const row of result.grid) {
      for (const v of row) if (v !== 0) filled++;
    }
    setStatus(
      `Partial only: ${filled} cells deduced (board too hard for full solve). Apply, then finish manually.`,
      'info',
    );
    drawPreview(result.grid);
  }

  // Apply a hashi hint by merging its edges into the live board and calling
  // applyHashiState. Prefers `hint.edges` (the named stepwise deduction the
  // user was just shown — bypassing this in favor of solution diffing was a
  // regression that decoupled the apply path from the previewed rule).
  // Falls back to solution.edges diffing only when no pendingHint is present
  // (Loop's first auto-step, or a stale invocation). Returns
  // { success: true } / { success: false, error }.
  async function applyHashiHintEdges(hint) {
    const current = await callMainWorld('readHashiState', []);
    if (!current) return { success: false, error: 'Hashi state read failed' };
    let toApply;
    if (hint?.edges?.length) {
      toApply = hint.edges;
    } else {
      const solution = puzzleData.solution;
      if (!solution?.edges) return { success: false, error: 'Hashi solution not available' };
      const curMap = new Map();
      for (const e of current.edges) {
        const a = Math.min(e.a, e.b), b = Math.max(e.a, e.b);
        curMap.set(`${a}-${b}`, e.bridges);
      }
      const numIslands = (puzzleData.islands || []).length;
      const minLines = Math.max(1, Math.ceil(numIslands / 10));
      toApply = [];
      for (const e of solution.edges) {
        const a = Math.min(e.a, e.b), b = Math.max(e.a, e.b);
        if (curMap.get(`${a}-${b}`) !== e.bridges) {
          toApply.push(e);
          if (toApply.length >= minLines) break;
        }
      }
    }
    if (toApply.length === 0) return { success: true };
    // Merge: start with current edges, swap in any toApply override that
    // matches an existing edge by endpoint pair, push any remaining
    // toApply entries that didn't appear in current.
    const merged = current.edges.slice();
    const overrideMap = new Map();
    for (const e of toApply) {
      const a = Math.min(e.a, e.b), b = Math.max(e.a, e.b);
      overrideMap.set(`${a}-${b}`, e);
    }
    for (let i = 0; i < merged.length; i++) {
      const a = Math.min(merged[i].a, merged[i].b);
      const b = Math.max(merged[i].a, merged[i].b);
      const key = `${a}-${b}`;
      if (overrideMap.has(key)) {
        merged[i] = overrideMap.get(key);
        overrideMap.delete(key);
      }
    }
    for (const remaining of overrideMap.values()) merged.push(remaining);
    const ok = await callMainWorld('applyHashiState', [merged]);
    return ok ? { success: true } : { success: false, error: 'Hashi hint apply failed' };
  }

  // Hashi done-check helper: every solution edge's bridge count matches the
  // current board state AND no extra bridges exist on pairs absent from the
  // solution. Edge keys are min-max normalized so the comparison is
  // direction-independent. _emit() filters bridges=0 out of solution.edges,
  // so iterating only solution.edges would miss user-drawn extras on
  // solution-0 pairs — hence the second loop over currentState.edges.
  function hashiDoneCheck(currentState, solution) {
    if (!currentState || !solution || !solution.edges) return false;
    const solMap = new Map();
    for (const e of solution.edges) {
      const a = Math.min(e.a, e.b), b = Math.max(e.a, e.b);
      solMap.set(`${a}-${b}`, e.bridges);
    }
    const curMap = new Map();
    for (const e of currentState.edges) {
      const a = Math.min(e.a, e.b), b = Math.max(e.a, e.b);
      curMap.set(`${a}-${b}`, e.bridges);
    }
    for (const [key, want] of solMap) {
      if (curMap.get(key) !== want) return false;
    }
    for (const [key, have] of curMap) {
      if (!have) continue; // 0 means "no bridge drawn" — not an extra
      if (!solMap.has(key)) return false; // user drew a bridge on a solution-0 pair
    }
    return true;
  }

  // The Loop button cycles through three states. loopHandler dispatches; the
  // per-state work lives in dedicated helpers below.
  async function loopHandler() {
    if (!puzzleData) { setStatus('Detect first.', 'error'); return; }
    if (looping) { stopLoop(); return; }
    if (loopConfirming) { await applyAndRunLoop(); return; }
    await previewFirstLoopStep();
  }

  // Branch 1 — user clicked Loop while looping. Cancel the inter-step sleep
  // if any so Stop is instant; the loop body checks stopLooping each iter.
  function stopLoop() {
    stopLooping = true;
    loopBtn.disabled = true;
    loopBtn.textContent = 'Stopping...';
    if (stopLoopWait) stopLoopWait();
  }

  // Cancellable inter-step pause. Settles as soon as the user clicks Stop
  // instead of waiting out the full delay.
  function sleepWithStop(ms) {
    return new Promise(resolve => {
      const timer = setTimeout(() => { stopLoopWait = null; resolve(); }, ms);
      stopLoopWait = () => { clearTimeout(timer); stopLoopWait = null; resolve(); };
    });
  }

  // Branch 2 — user clicked Confirm. Apply the pending hint, then enter the
  // auto-loop body. If the apply fails we bail before starting, because
  // running the loop from an inconsistent state would just mask the real
  // error and likely fail every subsequent step.
  async function applyAndRunLoop() {
    confirming = false;
    solveBtn.textContent = 'Solve';
    loopConfirming = false;

    if (puzzleData.pendingHint) {
      setStatus('Applying...', 'info');
      let ok;
      if (puzzleData.pendingHint.type === 'galaxies') {
        const r = await applySolution({ type: 'galaxies-lines', lines: puzzleData.pendingHint.lines });
        ok = !!r?.success;
      } else if (puzzleData.type === 'shikaku') {
        const hintCells = hintAbsoluteCells(puzzleData.pendingHint);
        const cur = await callMainWorld('readShikakuState', [puzzleData.rows, puzzleData.cols]);
        const grid = cur || Array.from({ length: puzzleData.rows }, () => new Array(puzzleData.cols).fill(-1));
        for (const cell of hintCells) grid[cell.row][cell.col] = cell.value;
        ok = !!(await callMainWorld('applyShikakuState', [grid, puzzleData.clues]));
      } else if (puzzleData.type === 'slitherlink') {
        const cur = await callMainWorld('readSlitherlinkState', [puzzleData.rows, puzzleData.cols]);
        const horizontal = (cur?.horizontal || Array.from({ length: puzzleData.rows + 1 },
          () => new Array(puzzleData.cols).fill(0))).map(row => row.slice());
        const vertical   = (cur?.vertical   || Array.from({ length: puzzleData.rows },
          () => new Array(puzzleData.cols + 1).fill(0))).map(row => row.slice());
        for (const e of (puzzleData.pendingHint.edges || [])) {
          if (e.orientation === 'h' && horizontal[e.r]) horizontal[e.r][e.c] = 1;
          else if (e.orientation === 'v' && vertical[e.r]) vertical[e.r][e.c] = 1;
        }
        ok = !!(await callMainWorld('applySlitherlinkState', [{ horizontal, vertical }]));
      } else if (puzzleData.type === 'hashi') {
        const r = await applyHashiHintEdges(puzzleData.pendingHint);
        ok = !!r?.success;
      } else {
        const hintCells = hintAbsoluteCells(puzzleData.pendingHint);
        ok = !!(await callMainWorld('applyHintCells', [hintCells]));
      }
      if (!ok) {
        setStatus('Hint apply failed; loop aborted.', 'error');
        return;
      }
    }
    clearPendingHint();
    await runLoop();
  }

  async function runLoop() {
    looping = true;
    stopLooping = false;
    loopBtn.textContent = 'Stop';
    setButtonsDisabled(true);
    // The Loop button doubles as Stop while looping — keep it clickable.
    loopBtn.disabled = false;
    setStatus('Step 1', 'info');
    let steps = 1;
    const state1 = await readGridState();
    if (state1?.success) drawPreview(state1.grid);

    while (true) {
      if (stopLooping) break;
      const gs = await readGridState();
      if (!gs?.success) break;
      let gsComplete;
      const regLoop = (typeof PUZZLES !== 'undefined' && PUZZLES) ? PUZZLES[puzzleData?.type] : null;
      if (regLoop?.loopDoneCheck) {
        gsComplete = await regLoop.loopDoneCheck({
          boardState: gs.grid, solution: puzzleData.solution, puzzleData,
        });
      } else if (puzzleData.type === 'slitherlink') {
        const sol = puzzleData.solution;
        if (sol?.horizontal && sol?.vertical) {
          const edgeState = await callMainWorld('readSlitherlinkState', [puzzleData.rows, puzzleData.cols]);
          const bh = edgeState?.horizontal || [];
          const bv = edgeState?.vertical || [];
          gsComplete = true;
          outer: for (let r = 0; r < sol.horizontal.length; r++) {
            for (let c = 0; c < (sol.horizontal[r]?.length || 0); c++) {
              if (sol.horizontal[r][c] === 1 && bh[r]?.[c] !== 1) { gsComplete = false; break outer; }
            }
          }
          if (gsComplete) {
            outer2: for (let r = 0; r < sol.vertical.length; r++) {
              for (let c = 0; c < (sol.vertical[r]?.length || 0); c++) {
                if (sol.vertical[r][c] === 1 && bv[r]?.[c] !== 1) { gsComplete = false; break outer2; }
              }
            }
          }
        } else {
          gsComplete = false;
        }
      } else if (puzzleData.type === 'shikaku') {
        gsComplete = gs.grid.every(row => row.every(c => c !== -1));
      } else if (puzzleData.type === 'hashi') {
        // gs.grid for hashi is { edges } from hashiHandler.readState, not a
        // 2D cell array; route through hashiDoneCheck (matches the post-loop
        // endComplete check below).
        gsComplete = hashiDoneCheck(gs.grid, puzzleData.solution);
      } else {
        gsComplete = gs.grid.every(row => row.every(c => c !== 0));
      }
      if (puzzleData.type !== 'galaxies' && gsComplete) break;

      const hr = await getHint({ solution: puzzleData.solution });
      if (!hr?.success) break;
      if (hr.hint?.type !== 'galaxies' && hr.hint?.type !== 'slitherlink' && hr.hint?.type !== 'hashi' && hr.hint?.type !== 'heyawake' && hr.hint?.type !== 'hitori' && hr.hint?.type !== 'kakurasu' && hr.hint?.type !== 'kurodoko' && hr.hint?.type !== 'mosaic' && hr.hint?.type !== 'norinori' && hr.hint?.type !== 'nurikabe' && !hr.hint?.cells?.length) break;

      const h = hr.hint;
      // getHint may lazily solve as a fallback (galaxies + aquarium);
      // persist the returned solution so subsequent iterations skip the
      // solver call. Galaxies attaches a memoized _galaxyPath; aquarium
      // reuses sol directly for row-by-row diffs.
      if (hr.solution) puzzleData.solution = hr.solution;
      applyHintToGrid(gs.grid, h);
      const ar = h.type === 'galaxies'
        ? await applySolution({ type: 'galaxies-lines', lines: h.lines })
        : await applySolution(gs.grid);
      if (!ar?.success) break;

      steps++;
      setHintStatus(h, `Step ${steps}: `);
      const ss = await readGridState();
      // Loop's per-step refresh: just the updated grid, no hint overlay.
      if (ss?.success) drawPreview(ss.grid);
      await sleepWithStop(300);
    }
    stopLoopWait = null;

    loopBtn.textContent = 'Loop';
    loopBtn.disabled = false;
    looping = false;
    setButtonsDisabled(false);
    updateUndoRedoButtons();
    setHintLabel('Hint');
    if (stopLooping) {
      setStatus(`Stopped after ${steps} step${steps !== 1 ? 's' : ''}.`, 'info');
    } else {
      const end = await readGridState();
      if (end?.success) drawPreview(end.grid);
      let endComplete = false;
      if (end?.grid) {
        const regEnd = (typeof PUZZLES !== 'undefined' && PUZZLES) ? PUZZLES[puzzleData?.type] : null;
        if (regEnd?.loopDoneCheck) {
          endComplete = await regEnd.loopDoneCheck({
            boardState: end.grid, solution: puzzleData.solution, puzzleData,
          });
        } else if (puzzleData.type === 'slitherlink') {
          // Dispatch on type FIRST. For slitherlink, end.grid is
          // { horizontal, vertical } (not a 2D array), so the cell-grid
          // `.every` check below would TypeError. Even if solution is missing
          // (auto-solve failed or still running), stay in the slitherlink arm
          // and report not-complete instead of crashing.
          if (puzzleData.solution?.horizontal && puzzleData.solution?.vertical) {
            const edgeState = await callMainWorld('readSlitherlinkState', [puzzleData.rows, puzzleData.cols]);
            const bh = edgeState?.horizontal || [];
            const bv = edgeState?.vertical || [];
            endComplete = true;
            for (let r = 0; endComplete && r < puzzleData.solution.horizontal.length; r++) {
              for (let c = 0; c < (puzzleData.solution.horizontal[r]?.length || 0); c++) {
                if (puzzleData.solution.horizontal[r][c] === 1 && bh[r]?.[c] !== 1) { endComplete = false; break; }
              }
            }
            for (let r = 0; endComplete && r < puzzleData.solution.vertical.length; r++) {
              for (let c = 0; c < (puzzleData.solution.vertical[r]?.length || 0); c++) {
                if (puzzleData.solution.vertical[r][c] === 1 && bv[r]?.[c] !== 1) { endComplete = false; break; }
              }
            }
          } else {
            endComplete = false;
          }
        } else {
          endComplete = puzzleData.type === 'shikaku'
            ? end.grid.every(row => row.every(c => c !== -1))
            : puzzleData.type === 'hashi'
              ? hashiDoneCheck(end.grid, puzzleData.solution)
              : end.grid.every(row => row.every(c => c !== 0));
        }
      }
      const done = end?.grid && puzzleData.type !== 'galaxies' && endComplete;
      setStatus(done ? 'Solved!' : 'No more hints available.', done ? 'success' : 'info');
    }
    stopLooping = false;
  }

  // Branch 3 — fresh Loop press. Compute one hint, show its preview, switch
  // the button to Confirm. The actual loop doesn't start until the user
  // approves by clicking Confirm.
  async function previewFirstLoopStep() {
    confirming = false;
    solveBtn.textContent = 'Solve';
    // Loop has its own commit path (the Confirm state on the Loop button),
    // so the Apply button must be disabled — otherwise a stale Hint-click
    // Apply remains enabled while Loop preview is active.
    clearPendingHint();

    // Load any cached solution for this puzzle before deciding whether to
    // pre-solve. Galaxies / aquarium / nonogram each have their own cache
    // shape; getCachedGridSolution dispatches by type for the latter two.
    if (!puzzleData.solution) {
      const cached = puzzleData.type === 'galaxies'
        ? getCachedGalaxiesSolution(puzzleData)
        : getCachedGridSolution(puzzleData);
      if (cached) puzzleData.solution = cached;
    }

    if (!puzzleData.solution && pendingAutoSolve) {
      // Mirror hintHandler: show "Solving..." while we wait for the background
      // auto-solve, otherwise the Loop button looks dead for the duration of
      // the await. Status gets overwritten by "Computing hint..." or the
      // nonogram pre-solve below as soon as the await returns.
      setStatus('Solving...', 'info');
      await pendingAutoSolve;
    }

    // Nonogram pre-solves so the loop's getHint can compare against the
    // solution. With a cache hit we skip the solve; otherwise solve once
    // up front and cache the result.
    if (puzzleData.type === 'nonogram' && !puzzleData.solution) {
      setStatus('Solving...', 'info');
      const stateResult = await readGridState();
      const initialGrid = chooseInitialGrid(puzzleData, stateResult?.success ? stateResult.grid : null);
      const result = await runSolve(puzzleData.rowClues, puzzleData.colClues, initialGrid,
        puzzleData.type, solveExtraData());
      if (!result?.solved) {
        setStatus(formatSolveError(result), 'error');
        return;
      }
      recordSolveSuccess(result);
      cacheGridSolution(puzzleData, result.grid);
    }

    setStatus('Computing hint...', 'info');
    const hintResult = await getHint({ solution: puzzleData.solution });
    if (!hintResult?.success) {
      setStatus(`Hint failed: ${hintResult?.error || 'Unknown error'}`, 'error');
      return;
    }
    const h = hintResult.hint;
    puzzleData.pendingHint = h;

    if (hintResult.solution) puzzleData.solution = hintResult.solution;
    renderHintStatusAndPreview(h, hintResult.grid);

    loopBtn.textContent = 'Confirm';
    loopConfirming = true;
  }

  async function hintHandler() {
    if (!puzzleData) { setStatus('Detect first.', 'error'); return; }
    confirming = false;
    loopConfirming = false;
    solveBtn.textContent = 'Solve';
    loopBtn.textContent = 'Loop';
    // Slitherlink's getHint and Hashi's getStepwiseHint propagate from the
    // live board state without touching puzzleData.solution, so don't block
    // on pendingAutoSolve — on hard 30×30 dailies that solve can take >30 s,
    // while the propagation hint returns in ~1 ms. Other puzzle types still
    // need the cached solution for mistake comparison.
    const skipAutoSolveGate = puzzleData.type === 'slitherlink' || puzzleData.type === 'hashi' || puzzleData.type === 'heyawake' || puzzleData.type === 'hitori' || puzzleData.type === 'kakurasu' || puzzleData.type === 'kurodoko' || puzzleData.type === 'mosaic' || puzzleData.type === 'norinori' || puzzleData.type === 'nurikabe';
    if (!skipAutoSolveGate && !puzzleData.solution && pendingAutoSolve) {
      setStatus('Solving...', 'info');
      await pendingAutoSolve;
    }
    setStatus('Computing hint...', 'info');
    const reg = (typeof PUZZLES !== 'undefined' && PUZZLES) ? PUZZLES[puzzleData?.type] : null;
    let result;
    if (reg?.hintDispatch) {
      result = await reg.hintDispatch({
        boardState: null, detectedGrid,
        rows: puzzleData.rows, cols: puzzleData.cols,
        solution: puzzleData.solution,
        firstMismatch, getCached: getCachedGridSolution,
        puzzleData,
      });
    } else {
      result = await getHint({ solution: puzzleData.solution });
    }
    if (!result?.success) {
      clearPendingHint();
      setStatus(`Hint failed: ${result?.error || 'Unknown error'}`, 'error');
      return;
    }
    const h = result.hint;
    if (result.solution) puzzleData.solution = result.solution;
    puzzleData.pendingHint = h;
    q('[data-action="applyHint"]').disabled = false;
    renderHintStatusAndPreview(h, result.grid);
  }

  async function applyHintHandler() {
    if (!puzzleData?.pendingHint) return;
    setStatus('Applying hint...', 'info');
    let result;
    if (puzzleData.pendingHint.type === 'galaxies') {
      result = await applySolution({ type: 'galaxies-lines', lines: puzzleData.pendingHint.lines });
    } else if (puzzleData.type === 'shikaku') {
      // Shikaku uses owner-index cellStatus + currentState.areas; the
      // generic applyHintCells writer doesn't know that shape. Read the
      // current state, overlay the hint cells, re-apply via the dedicated
      // shikaku function.
      const hintCells = hintAbsoluteCells(puzzleData.pendingHint);
      const cur = await callMainWorld('readShikakuState', [puzzleData.rows, puzzleData.cols]);
      const grid = cur || Array.from({ length: puzzleData.rows }, () => new Array(puzzleData.cols).fill(-1));
      for (const cell of hintCells) grid[cell.row][cell.col] = cell.value;
      const ok = await callMainWorld('applyShikakuState', [grid, puzzleData.clues]);
      result = ok ? { success: true } : { success: false, error: 'Shikaku hint apply failed' };
    } else if (puzzleData.type === 'slitherlink') {
      // Read the current edge state, overlay the hint's LINE edges, apply.
      const cur = await callMainWorld('readSlitherlinkState', [puzzleData.rows, puzzleData.cols]);
      const horizontal = (cur?.horizontal || Array.from({ length: puzzleData.rows + 1 },
        () => new Array(puzzleData.cols).fill(0))).map(row => row.slice());
      const vertical   = (cur?.vertical   || Array.from({ length: puzzleData.rows },
        () => new Array(puzzleData.cols + 1).fill(0))).map(row => row.slice());
      for (const e of (puzzleData.pendingHint.edges || [])) {
        if (e.orientation === 'h' && horizontal[e.r]) horizontal[e.r][e.c] = 1;
        else if (e.orientation === 'v' && vertical[e.r]) vertical[e.r][e.c] = 1;
      }
      const ok = await callMainWorld('applySlitherlinkState', [{ horizontal, vertical }]);
      result = ok ? { success: true } : { success: false, error: 'Slitherlink hint apply failed' };
    } else if (puzzleData.type === 'hashi') {
      result = await applyHashiHintEdges(puzzleData.pendingHint);
    } else {
      const hintCells = hintAbsoluteCells(puzzleData.pendingHint);
      const ok = await callMainWorld('applyHintCells', [hintCells]);
      result = ok ? { success: true } : { success: false, error: 'Hint apply failed' };
    }
    if (result?.success) {
      clearPendingHint();
      setStatus('Hint applied!', 'success');
      const newState = await readGridState();
      if (newState?.success) drawPreview(newState.grid);
    } else {
      setStatus('Apply failed.', 'error');
      if (result?.error) setStatus('Apply failed: ' + result.error, 'error');
    }
    updateUndoRedoButtons();
  }

  function fmtList(nums) {
    if (nums.length <= 2) return nums.join(', ');
    const runs = [];
    let s = nums[0], e = nums[0];
    for (let i = 1; i < nums.length; i++) {
      if (nums[i] === e + 1) { e = nums[i]; continue; }
      runs.push(s === e ? '' + s : s + '-' + e);
      s = e = nums[i];
    }
    runs.push(s === e ? '' + s : s + '-' + e);
    return runs.join(', ');
  }

  function formatSolveError(result) {
    const saved = result?.partialFilled ? ` Saved partial state (${result.partialFilled} cells) for a later retry.` : '';
    if (result?.error === 'search limit exceeded') {
      if (puzzleData?.type === 'galaxies') return 'This Galaxies puzzle is too large for the current solver search limit.';
      if (puzzleData?.type === 'aquarium') return 'This Aquarium puzzle is too large for the current solver search limit.' + saved;
      return 'Search limit reached.' + saved;
    }
    if (result?.error === 'time limit exceeded') {
      return 'This puzzle is too large to solve quickly in the browser.' + saved;
    }
    if (result?.error === 'partial state exhausted') {
      return 'Saved partial Galaxies state could not be continued. It was saved as a failed branch and cleared; try Solve again to search another branch.';
    }
    if (result?.error === 'invalid partial state') {
      return 'Saved partial state was invalid and has been cleared. Try Solve again.';
    }
    return result?.error || 'Solve failed.';
  }

  function setButtonsDisabled(disabled) {
    for (const a of ['detect', 'solve', 'hint', 'loop', 'applyHint', 'undo', 'redo']) {
      q(`[data-action="${a}"]`).disabled = disabled;
    }
  }

  function updateUndoRedoButtons() {
    q('[data-action="undo"]').disabled = undoStack.length === 0;
    q('[data-action="redo"]').disabled = redoStack.length === 0;
    q('[data-action="applyHint"]').disabled = !puzzleData?.pendingHint;
  }

  let stateObserver = null;
  let watchDebounce = null;

  function startStateWatch() {
    stopStateWatch();
    const el = detectedGrid?._element;
    if (!el) return;
    const target = el.querySelector('.nonograms-cell-back') || el;
    stateObserver = new MutationObserver(() => {
      if (suppressStateWatch) return;
      clearTimeout(watchDebounce);
      watchDebounce = setTimeout(async () => {
        if (!puzzleData) return;
        const state = await readGridState();
        if (!state?.success) return;
        drawPreview(state.grid);

        if (!puzzleData.pendingHint) return;
        const hintResult = await getHint({ solution: puzzleData.solution });
        if (!hintResult?.success) {
          clearPendingHint();
          return;
        }
        const h = hintResult.hint;
        puzzleData.pendingHint = h;
        q('[data-action="applyHint"]').disabled = false;
        renderHintStatusAndPreview(h, state.grid);
      }, 200);
    });
    stateObserver.observe(target, { attributes: true, attributeFilter: ['class', 'style'], subtree: true });
  }

  function stopStateWatch() {
    if (stateObserver) { stateObserver.disconnect(); stateObserver = null; }
    clearTimeout(watchDebounce);
  }

  // `direction` ∈ {'undo','redo'}. Wordforms: Undo+ing=Undoing, Undo+ne=Undone.
  async function historyHandler(direction) {
    const cap = direction === 'undo' ? 'Undo' : 'Redo';
    setStatus(`${cap}ing...`, 'info');
    const result = await handleHistory(direction);
    if (result?.success) {
      clearPendingHint();
      if (result.grid) drawPreview(result.grid);
      updateUndoRedoButtons();
      setStatus(`${cap}ne.`, 'success');
    } else {
      const detail = result?.error ? `${cap} failed: ${result.error}` : `${cap} failed.`;
      setStatus(detail, 'error');
    }
  }

  // Capture the current puzzle in tests/fixtures/puzzles.js format and copy it
  // to the clipboard for pasting into a bench fixture. Logs to console too so
  // it's recoverable if the clipboard write fails.
  async function dumpHandler() {
    setStatus('Dumping puzzle...', 'info');
    const data = await callMainWorld('dumpPuzzleForBench', []);
    if (!data || data.error) {
      const msg = data?.error ? `Dump failed: ${data.error}` : 'Dump failed.';
      setStatus(msg, 'error');
      const errJson = formatDump(data);
      console.warn('[puzzle-solver dump] ' + errJson);
      try { await navigator.clipboard.writeText(errJson); } catch {}
      return;
    }
    const json = formatDump(data);
    console.log('[puzzle-solver dump] ' + json);
    try {
      await navigator.clipboard.writeText(json);
      setStatus(`Dumped ${data.type} ${data.rows}×${data.cols} to clipboard.`, 'success');
    } catch {
      setStatus(`Dumped ${data.type} ${data.rows}×${data.cols} to console (clipboard blocked).`, 'info');
    }
  }

  // Compact-but-line-friendly JSON formatter for dumps. Top-level keys go
  // on one line each; arrays of primitives stay flat (no per-element
  // newlines); 2D arrays put each inner row on its own line so the grid
  // structure remains visible when pasted into a fixture file.
  function formatDump(data) {
    if (!data || typeof data !== 'object') return JSON.stringify(data);
    const flatJSON = (v) => JSON.stringify(v);
    const is2D = (v) => Array.isArray(v) && v.length > 0 && Array.isArray(v[0]);
    const parts = [];
    for (const k of Object.keys(data)) {
      const v = data[k];
      if (is2D(v)) {
        const rows = v.map(r => '  ' + flatJSON(r)).join(',\n');
        parts.push(`  ${flatJSON(k)}: [\n${rows}\n  ]`);
      } else {
        parts.push(`  ${flatJSON(k)}: ${flatJSON(v)}`);
      }
    }
    return '{\n' + parts.join(',\n') + '\n}';
  }

  // Tear down observers and the worker on page unload. Most page-loads
  // recycle everything anyway, but puzzles-mobile SPA-navigates between
  // puzzles within the same document, so the observer would otherwise keep
  // watching stale DOM and the worker would linger unused.
  window.addEventListener('pagehide', (e) => {
    // event.persisted=true means the page is entering the back-forward cache
    // and may be restored later. Tearing down the worker / observer would
    // leave the widget non-functional after restore (Solve buttons exist but
    // worker is dead). Skip cleanup; Chrome reclaims the worker if the page
    // is actually evicted from BFCache.
    if (e.persisted) return;
    stopStateWatch();
    if (solverWorker) {
      // Resolve any in-flight solves before tearing down the worker —
      // otherwise their awaiters hang forever and the widget gets stuck
      // on "Solving..." if the user comes back to the page.
      for (const pending of solverPending.values()) {
        pending.resolve({ solved: false, grid: null, error: 'page unloaded' });
      }
      solverPending.clear();
      try { solverWorker.terminate(); } catch {}
      solverWorker = null;
      solverWorkerInit = null;
    }
  });

  // BFCache eviction is invisible to JS — Chrome terminates dedicated workers
  // during BFCache regardless, but pagehide(persisted=true) bypasses our
  // teardown. On restore, the cached solverWorker reference is dead and the
  // next runSolve would throw on .postMessage. Null it out so getSolverWorker
  // rebuilds lazily. pageshow always fires on the restore path.
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    if (solverWorker) {
      try { solverWorker.terminate(); } catch {}
      solverWorker = null;
      solverWorkerInit = null;
    }
  });

  detectHandler().catch(() => {});

}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { makeWidget };
}
