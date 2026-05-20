// MAIN-world functions: passed by value to chrome.scripting.executeScript
// (`world: 'MAIN'`) and executed inside the page context, NOT in this service
// worker. They reference `window.Game`, `document`, `localStorage` etc., which
// don't exist here — the SW only ever forwards them. Loaded into the SW via
// importScripts so the listener in background.js can resolve them by name.
//
// Every top-level function here is invoked reflectively via
// globalThis[request.funcName] — ESLint can't see those call sites, so
// disable no-unused-vars for the file rather than annotating each function.
// ts-nocheck because window.Game's shape is the page's, not ours — typing it
// would just be `any` everywhere.
// @ts-nocheck
/* eslint-disable no-unused-vars */

function readGameState(rows, cols) {
  try {
    var cs = null;
    if (window.Game && window.Game.currentState && window.Game.currentState.cellStatus) {
      cs = window.Game.currentState.cellStatus;
    }
    if (!cs) return null;

    var out = [];
    for (var r = 0; r < rows && r < cs.length; r++) {
      out[r] = [];
      for (var c = 0; c < cols && c < cs[r].length; c++) {
        var v = cs[r][c];
        out[r][c] = v === 1 ? 1 : v === 2 ? -1 : 0;
      }
    }
    return out;
  } catch (e) {
    return null;
  }
}

function readGameClues() {
  var maxAttempts = 20;
  var pollMs = 250;

  function doRead() {
    try {
      if (!window.Game || window.Game.loaded === false) return null;

      var dims = readDimensions();
      var width = dims.width;
      var height = dims.height;

      // Try each known clue source in priority order. Earlier sources are
      // more authoritative when present.
      var result =
           readTaskString()
        || readArrayTaskWithAreas(width, height)
        || readColumnsRowsTask(width, height)
        || readFlatStateClues(width, height);
      return result;
    } catch (e) {
      return null;
    }
  }

  function readDimensions() {
    var width = window.Game.puzzleWidth || null;
    var height = window.Game.puzzleHeight || null;
    if (typeof window.Game.getSetting === 'function') {
      if (!width) width = window.Game.getSetting('puzzleWidth');
      if (!height) height = window.Game.getSetting('puzzleHeight');
    }
    return { width: width, height: height };
  }

  // 1. Pre-serialized task string from currentState.task or Game.task.
  function readTaskString() {
    var taskStr = null;
    if (window.Game.currentState && typeof window.Game.currentState.task === 'string'
        && window.Game.currentState.task.length > 0) {
      taskStr = window.Game.currentState.task;
    } else if (typeof window.Game.task === 'string' && window.Game.task.length > 0) {
      taskStr = window.Game.task;
    }
    if (!taskStr) return null;
    var dims = readDimensions();
    return { task: taskStr, width: dims.width, height: dims.height };
  }

  // 2. Game.task is a flat array of clues, Game.areas is the region map —
  //    encode them into the same task-string format the site uses.
  function readArrayTaskWithAreas(width, height) {
    if (!(width && height && Array.isArray(window.Game.task)
        && window.Game.task.length >= width + height
        && Array.isArray(window.Game.areas) && window.Game.areas.length >= height)) {
      return null;
    }
    var clues = [];
    for (var i = 0; i < width + height; i++) clues.push(window.Game.task[i]);
    var regions = [];
    for (var r = 0; r < height; r++) {
      if (!Array.isArray(window.Game.areas[r]) || window.Game.areas[r].length < width) return null;
      for (var c = 0; c < width; c++) regions.push(window.Game.areas[r][c] + 1);
    }
    return { task: clues.join('_') + ';' + regions.join(','), width: width, height: height };
  }

  // 3. Game.task is an object with separate .columns / .rows arrays of per-line clues.
  function readColumnsRowsTask(width, height) {
    var t = window.Game.task;
    if (!(t && t.columns && t.rows && t.columns.length > 0 && t.rows.length > 0)) return null;
    var cols = t.columns, rows = t.rows;
    if (!width) width = cols.length;
    if (!height) height = rows.length;
    if (!(width && height)) return null;
    var colClues = [], rowClues = [];
    for (var i = 0; i < width && i < cols.length; i++) colClues.push(normalizeClueArray(cols[i]));
    for (var i = 0; i < height && i < rows.length; i++) rowClues.push(normalizeClueArray(rows[i]));
    return { colClues: colClues, rowClues: rowClues, width: width, height: height };
  }

  // 4. Game.currentState.colors / .clues — flat per-line array where indices
  //    [0..width) are columns and [width..width+height) are rows.
  function readFlatStateClues(width, height) {
    var state = window.Game.currentState;
    if (!state) return null;

    function splitFlatClues(c) {
      var cc = [], rc = [];
      for (var i = 0; i < width; i++) cc.push(normalizeClueArray(c[i]));
      for (var i = width; i < width + height; i++) rc.push(normalizeClueArray(c[i]));
      return { colClues: cc, rowClues: rc, width: width, height: height };
    }

    if (state.colors && Array.isArray(state.colors) && state.colors.length > 0) {
      if (width && height && state.colors.length >= width + height) return splitFlatClues(state.colors);
      return { colors: state.colors, width: width, height: height };
    }
    if (state.clues && Array.isArray(state.clues) && state.clues.length > 0
        && width && height && state.clues.length >= width + height) {
      return splitFlatClues(state.clues);
    }
    return null;
  }

  return new Promise(function(resolve) {
    function poll() {
      try {
        var r = doRead();
        if (r) { resolve(r); return; }
      } catch(e) {}
      maxAttempts--;
      if (maxAttempts <= 0) { resolve(null); return; }
      setTimeout(poll, pollMs);
    }
    poll();
    // Fallback timeout at 10s
    setTimeout(function() { resolve(null); }, 10000);
  });

  function normalizeClueArray(arr) {
    if (!arr) return [];
    if (typeof arr === 'number') return [arr];
    if (typeof arr === 'string') {
      var n = parseInt(arr, 10);
      return isNaN(n) ? [] : [n];
    }
    if (Array.isArray(arr)) {
      return arr.map(function(v) {
        if (typeof v === 'number') return v;
        if (typeof v === 'string') {
          var n = parseInt(v, 10);
          if (!isNaN(n)) return n;
        }
        if (v && typeof v.run === 'number') return v.run;
        if (v && v.runs && Array.isArray(v.runs) && v.runs.length > 0) return v.runs[0];
        return NaN;
      }).filter(function(v) { return !isNaN(v); });
    }
    if (typeof arr === 'object' && arr !== null && typeof arr.run === 'number') {
      return [arr.run];
    }
    return [];
  }
}

function readGalaxiesData() {
  var maxAttempts = 20;
  var pollMs = 250;

  function doRead() {
    try {
      if (!window.Game || window.Game.loaded === false) return null;
      var width = window.Game.puzzleWidth ? window.Game.puzzleWidth - 1 : null;
      var height = window.Game.puzzleHeight ? window.Game.puzzleHeight - 1 : null;
      if ((!width || !height) && typeof window.Game.getSetting === 'function') {
        width = width || window.Game.getSetting('puzzleWidth');
        height = height || window.Game.getSetting('puzzleHeight');
      }
      var task = null;
      if (typeof window.Game.rawTask === 'string' && window.Game.rawTask) task = window.Game.rawTask;
      if (!task && typeof window.Game.taskString === 'string' && window.Game.taskString) task = window.Game.taskString;
      var stars = [];
      if (Array.isArray(window.Game.task) && window.Game.task.length) stars = readGalaxiesStarsFromMatrix(window.Game.task);
      if (!stars.length && window.Game.dom && window.Game.dom.task) stars = readGalaxiesStarsFromMatrix(window.Game.dom.task);
      if (!stars.length) stars = readGalaxiesStarsFromDom();
      if (!task && stars.length) task = encodeGalaxiesTask(stars, width, height);
      if ((task || stars.length) && width && height) return { task: task, stars: stars, width: width, height: height };
      return null;
    } catch (e) {
      return null;
    }
  }

  return new Promise(function(resolve) {
    function poll() {
      var r = doRead();
      if (r) { resolve(r); return; }
      maxAttempts--;
      if (maxAttempts <= 0) { resolve(null); return; }
      setTimeout(poll, pollMs);
    }
    poll();
    setTimeout(function() { resolve(null); }, 10000);
  });

  function readGalaxiesStarsFromDom() {
    var dots = document.querySelectorAll('#game .dot-white');
    if (!dots.length) return [];
    var coords = [];
    for (var i = 0; i < dots.length; i++) {
      if (typeof dots[i].row === 'number' && typeof dots[i].col === 'number') {
        coords.push({ row: dots[i].row, col: dots[i].col });
      }
    }
    return coords;
  }

  function readGalaxiesStarsFromMatrix(source) {
    var coords = [];
    if (!source) return coords;
    for (var r = 0; r < source.length; r++) {
      if (!source[r]) continue;
      for (var c = 0; c < source[r].length; c++) {
        if (!source[r][c]) continue;
        coords.push({ row: r, col: c });
      }
    }
    return coords;
  }

  function encodeGalaxiesTask(source, width, height) {
    if (!source || !width || !height) return '';
    var coords = [];
    if (Array.isArray(source)) {
      for (var r = 0; r < source.length; r++) {
        if (!source[r]) continue;
        for (var c = 0; c < source[r].length; c++) {
          if (source[r][c]) coords.push({ row: r, col: c });
        }
      }
    } else {
      coords = source;
    }
    coords.sort(function(a, b) { return a.row === b.row ? a.col - b.col : a.row - b.row; });
    var cols = 2 * width - 1;
    var out = '';
    var pos = 0;
    for (var i = 0; i < coords.length; i++) {
      var next = coords[i].row * cols + coords[i].col;
      var gap = next - pos + 1;
      while (gap > 26) { out += 'z'; gap -= 25; }
      out += String.fromCharCode(96 + gap);
      pos = next + 1;
    }
    return out;
  }
}

function readGalaxiesState(rows, cols) {
  try {
    if (!window.Game || !window.Game.currentState) return null;
    var hs = window.Game.currentState.cellHorizontalStatus;
    var vs = window.Game.currentState.cellVerticalStatus;
    if (!hs || !vs) return null;
    var lines = { horizontal: [], vertical: [] };
    for (var hr = 0; hr < rows + 1; hr++) {
      lines.horizontal[hr] = [];
      for (var hc = 0; hc < cols; hc++) lines.horizontal[hr][hc] = hs[hr] && hs[hr][hc] === 1 ? 1 : 0;
    }
    for (var vr = 0; vr < rows; vr++) {
      lines.vertical[vr] = [];
      for (var vc = 0; vc < cols + 1; vc++) lines.vertical[vr][vc] = vs[vr] && vs[vr][vc] === 1 ? 1 : 0;
    }
    var grid = Array.from({ length: rows }, function() { return Array(cols).fill(0); });
    var id = 0;
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        if (grid[r][c]) continue;
        id++;
        var q = [{ row: r, col: c }];
        grid[r][c] = id;
        for (var qi = 0; qi < q.length; qi++) {
          var p = q[qi];
          var neigh = [
            { row: p.row - 1, col: p.col, blocked: hs[p.row] && hs[p.row][p.col] === 1 },
            { row: p.row + 1, col: p.col, blocked: hs[p.row + 1] && hs[p.row + 1][p.col] === 1 },
            { row: p.row, col: p.col - 1, blocked: vs[p.row] && vs[p.row][p.col] === 1 },
            { row: p.row, col: p.col + 1, blocked: vs[p.row] && vs[p.row][p.col + 1] === 1 }
          ];
          for (var i = 0; i < neigh.length; i++) {
            var n = neigh[i];
            if (n.blocked || n.row < 0 || n.col < 0 || n.row >= rows || n.col >= cols || grid[n.row][n.col]) continue;
            grid[n.row][n.col] = id;
            q.push({ row: n.row, col: n.col });
          }
        }
      }
    }
    return { grid: grid, lines: lines };
  } catch (e) {
    return null;
  }
}

async function applyGalaxiesState(lines) {
  // Nested because this function is serialized via fn.toString() into the page
  // MAIN world — closure to outer-scope helpers is lost in transit.
  // Keep in sync with the syncTimer copy in applyGameState below.
  function syncTimer() {
    try {
      if (!window.Game) return;
      var now = new Date().getTime();
      var elapsed = null;
      if (typeof window.startTime === 'number' && window.startTime > 0) {
        elapsed = Math.max(0, now - window.startTime);
      } else if (typeof window.Game.tickTimer === 'function' && typeof window.Game.getTimer === 'function') {
        window.Game.tickTimer();
        elapsed = window.Game.getTimer();
      }
      if (typeof elapsed !== 'number' || !isFinite(elapsed)) return;
      window.Game.accumulated = elapsed;
      window.Game.lastTrackedTime = now;
      if (typeof window.Game.getSaveIdent === 'function') {
        localStorage.setItem('timer-' + window.Game.getSaveIdent(), elapsed);
      }
    } catch (e) {
      console.warn('Timer sync failed:', e);
    }
  }
  try {
    if (!window.Game || !window.Game.currentState || !lines) return false;
    var hs = window.Game.currentState.cellHorizontalStatus;
    var vs = window.Game.currentState.cellVerticalStatus;
    if (!hs || !vs || !lines.horizontal || !lines.vertical) return false;
    for (var r = 0; r < hs.length && r < lines.horizontal.length; r++) {
      for (var c = 0; c < hs[r].length && c < lines.horizontal[r].length; c++) {
        hs[r][c] = lines.horizontal[r][c] ? 1 : 0;
      }
    }
    for (var r = 0; r < vs.length && r < lines.vertical.length; r++) {
      for (var c = 0; c < vs[r].length && c < lines.vertical[r].length; c++) {
        vs[r][c] = lines.vertical[r][c] ? 1 : 0;
      }
    }
    window.Game.currentState.solved = false;
    window.Game.solved = false;
    if (typeof window.Game.drawCurrentState === 'function') window.Game.drawCurrentState();
    else if (typeof window.Game.render === 'function') window.Game.render();
    if (lines.check !== false && typeof window.Game.check === 'function') {
      await new Promise(function(resolve) { setTimeout(resolve, 0); });
      syncTimer();
      window.Game.solved = false;
      window.Game.currentState.solved = false;
      await window.Game.check(false, true);
    }
    return true;
  } catch (e) {
    console.warn('Galaxies apply failed:', e);
    return false;
  }
}

function applyGameState(solution) {
  // Nested because this function is serialized via fn.toString() into the page
  // MAIN world — closure to outer-scope helpers is lost in transit.
  // Keep in sync with the syncTimer copy in applyGalaxiesState above.
  function syncTimer() {
    try {
      if (!window.Game) return;
      var now = new Date().getTime();
      var elapsed = null;
      if (typeof window.startTime === 'number' && window.startTime > 0) {
        elapsed = Math.max(0, now - window.startTime);
      } else if (typeof window.Game.tickTimer === 'function' && typeof window.Game.getTimer === 'function') {
        window.Game.tickTimer();
        elapsed = window.Game.getTimer();
      }
      if (typeof elapsed !== 'number' || !isFinite(elapsed)) return;
      window.Game.accumulated = elapsed;
      window.Game.lastTrackedTime = now;
      if (typeof window.Game.getSaveIdent === 'function') {
        localStorage.setItem('timer-' + window.Game.getSaveIdent(), elapsed);
      }
    } catch (e) {
      console.warn('Timer sync failed:', e);
    }
  }
  try {
    var rows = solution.length;
    var cols = solution[0].length;
    if (!(window.Game && window.Game.currentState && window.Game.currentState.cellStatus)) {
      return false;
    }
    var cs = window.Game.currentState.cellStatus;

    if (typeof window.Game.saveState === 'function') {
      window.Game.saveState(true);
    }

    for (var r = 0; r < rows && r < cs.length; r++) {
      for (var c = 0; c < cols && c < cs[r].length; c++) {
        cs[r][c] = solution[r][c] === 1 ? 1 : solution[r][c] === -1 ? 2 : 0;
      }
    }
    window.Game.currentState.solved = true;

    if (typeof window.Game.render === 'function') {
      window.Game.render();
    } else if (typeof window.Game.redraw === 'function') {
      window.Game.redraw();
    } else if (typeof window.Game.redrawGrid === 'function') {
      window.Game.redrawGrid();
    } else if (window.Game.getSaved && window.Game.loadGame) {
      var saved = window.Game.getSaved();
      if (saved) window.Game.loadGame(saved);
    }

    var hasUnknown = false;
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        if (solution[r][c] === 0) { hasUnknown = true; break; }
      }
      if (hasUnknown) break;
    }
    if (!hasUnknown && typeof window.Game.check === 'function') {
      syncTimer();
      window.Game.solved = false;
      window.Game.currentState.solved = false;
      window.Game.check(false, true);
    }
    return true;
  } catch (e) {
    console.warn('Game API injection failed:', e);
    return false;
  }
}

function applyHintCells(hintCells) {
  try {
    if (!window.Game || !window.Game.currentState || !window.Game.currentState.cellStatus) return false;
    const cs = window.Game.currentState.cellStatus;

    // Commit pre-write state into the page's internal model so the mutations
    // below register as real changes. Without this, aquarium silently keeps
    // its prior visible state even though cs[r][c] is updated. applyGameState
    // (the full-solution path that works for aquarium) does the same dance.
    if (typeof window.Game.saveState === 'function') {
      window.Game.saveState(true);
    }

    for (let i = 0; i < hintCells.length; i++) {
      const cell = hintCells[i];
      if (cell.row !== undefined && cell.col !== undefined && cell.row < cs.length && cell.col < cs[cell.row].length) {
        // value=1 → cellStatus 1 (nonogram filled / binairo "one")
        // value=2 → cellStatus 2 (binairo "zero")
        // value=-1 → cellStatus 2 (nonogram cross)
        // anything else → cellStatus 0 (empty)
        const v = cell.value;
        cs[cell.row][cell.col] = v === 1 ? 1 : (v === 2 || v === -1) ? 2 : 0;
      }
    }

    // Render fallback: Game.render isn't present (or doesn't redraw cells) on
    // every puzzle type — aquarium needs Game.redraw / Game.redrawGrid. Mirror
    // applyGameState's fallback ladder.
    if (typeof window.Game.render === 'function') {
      window.Game.render();
    } else if (typeof window.Game.redraw === 'function') {
      window.Game.redraw();
    } else if (typeof window.Game.redrawGrid === 'function') {
      window.Game.redrawGrid();
    } else if (window.Game.getSaved && window.Game.loadGame) {
      const saved = window.Game.getSaved();
      if (saved) window.Game.loadGame(saved);
    }
    return true;
  } catch (e) {
    console.warn('Hint apply failed:', e);
    return false;
  }
}

function readBinairoData() {
  var maxAttempts = 20;
  var pollMs = 250;

  function deepCopy2D(g) {
    if (!Array.isArray(g)) return null;
    var out = [];
    for (var r = 0; r < g.length; r++) {
      if (!Array.isArray(g[r])) return null;
      out[r] = g[r].slice();
    }
    return out;
  }

  function doRead() {
    try {
      if (!window.Game || window.Game.loaded === false) return null;
      if (!Array.isArray(window.Game.task)) return null;
      var width = window.Game.puzzleWidth;
      var height = window.Game.puzzleHeight;
      if (!width || !height) return null;
      var task = deepCopy2D(window.Game.task);
      if (!task) return null;
      var comparison = Array.isArray(window.Game.comparisonClues)
        ? window.Game.comparisonClues : [];
      return { task: task, width: width, height: height, comparisonClues: comparison };
    } catch (e) {
      return null;
    }
  }

  return new Promise(function(resolve) {
    function poll() {
      var r = doRead();
      if (r) { resolve(r); return; }
      maxAttempts--;
      if (maxAttempts <= 0) { resolve(null); return; }
      setTimeout(poll, pollMs);
    }
    poll();
    setTimeout(function() { resolve(null); }, 10000);
  });
}

function readBinairoState(rows, cols) {
  try {
    if (!window.Game || !window.Game.currentState) return null;
    var cs = window.Game.currentState.cellStatus;
    if (!Array.isArray(cs)) return null;
    var out = [];
    for (var r = 0; r < rows && r < cs.length; r++) {
      var row = cs[r];
      if (!Array.isArray(row)) return null;
      out[r] = [];
      for (var c = 0; c < cols && c < row.length; c++) {
        var v = row[c];
        out[r][c] = (v === 1 || v === 2) ? v : 0;
      }
    }
    return out;
  } catch (e) {
    return null;
  }
}

function applyBinairoState(solution) {
  try {
    if (!solution || !Array.isArray(solution)) return false;
    if (!(window.Game && window.Game.currentState && window.Game.currentState.cellStatus)) {
      return false;
    }
    var cs = window.Game.currentState.cellStatus;
    var rows = solution.length;

    // saveState(true) BEFORE writes — this engine matches aquarium's pattern
    // where direct cellStatus mutation needs to be committed to the page's
    // internal model first. See CLAUDE.md "MAIN-world write functions: save +
    // render ladder" and the prior aquarium bug fix (7df9fa5).
    if (typeof window.Game.saveState === 'function') {
      window.Game.saveState(true);
    }

    for (var r = 0; r < rows && r < cs.length; r++) {
      var srcRow = solution[r] || [];
      var dstRow = cs[r];
      if (!Array.isArray(dstRow)) continue;
      var cols = srcRow.length;
      for (var c = 0; c < cols && c < dstRow.length; c++) {
        var v = srcRow[c];
        dstRow[c] = (v === 1 || v === 2) ? v : 0;
      }
    }

    if (typeof window.Game.redraw === 'function') {
      window.Game.redraw();
    } else if (typeof window.Game.render === 'function') {
      window.Game.render();
    } else if (window.Game.getSaved && window.Game.loadGame) {
      var saved = window.Game.getSaved();
      if (saved) window.Game.loadGame(saved);
    }
    return true;
  } catch (e) {
    console.warn('Binairo apply failed:', e);
    return false;
  }
}

function readShikakuData() {
  var maxAttempts = 20;
  var pollMs = 250;

  function deepCopy2D(g) {
    if (!Array.isArray(g)) return null;
    var out = [];
    for (var r = 0; r < g.length; r++) {
      if (!Array.isArray(g[r])) return null;
      out[r] = g[r].slice();
    }
    return out;
  }

  function doRead() {
    try {
      if (!window.Game || window.Game.loaded === false) return null;
      if (!Array.isArray(window.Game.task)) return null;
      var width = window.Game.puzzleWidth;
      var height = window.Game.puzzleHeight;
      if (!width || !height) return null;
      var task = deepCopy2D(window.Game.task);
      if (!task) return null;
      return { task: task, width: width, height: height };
    } catch (e) {
      return null;
    }
  }

  return new Promise(function(resolve) {
    function poll() {
      var r = doRead();
      if (r) { resolve(r); return; }
      maxAttempts--;
      if (maxAttempts <= 0) { resolve(null); return; }
      setTimeout(poll, pollMs);
    }
    poll();
    setTimeout(function() { resolve(null); }, 10000);
  });
}

function readShikakuState(rows, cols) {
  try {
    if (!window.Game || !window.Game.currentState) return null;
    var cs = window.Game.currentState.cellStatus;
    if (!Array.isArray(cs)) return null;
    var out = [];
    for (var r = 0; r < rows && r < cs.length; r++) {
      var row = cs[r];
      if (!Array.isArray(row)) return null;
      out[r] = [];
      for (var c = 0; c < cols && c < row.length; c++) {
        var v = row[c];
        out[r][c] = (typeof v === 'number' && v >= 0) ? v : -1;
      }
    }
    return out;
  } catch (e) {
    return null;
  }
}

function applyShikakuState(solution, clues) {
  try {
    if (!solution || !Array.isArray(solution)) return false;
    if (!(window.Game && window.Game.currentState && window.Game.currentState.cellStatus)) {
      return false;
    }
    var cs = window.Game.currentState.cellStatus;
    var rows = solution.length;

    if (typeof window.Game.saveState === 'function') {
      window.Game.saveState(true);
    }

    for (var r = 0; r < rows && r < cs.length; r++) {
      var srcRow = solution[r] || [];
      var dstRow = cs[r];
      if (!Array.isArray(dstRow)) continue;
      for (var c = 0; c < srcRow.length && c < dstRow.length; c++) {
        var v = srcRow[c];
        dstRow[c] = (typeof v === 'number' && v >= 0) ? v : -1;
      }
    }

    // Build the areas list from cellStatus, indexed by owner id, matching
    // the shape the page produces itself (a cloned `currentMove`):
    //   { cells: [{row,col}], cellStatus: id, invert: false,
    //     startPoint: {row,col}, endPoint: {row,col} }
    // - drawRect reads startPoint/endPoint (the rectangle's corners).
    // - removeArea iterates `area.cells` and reads each `.row`/`.col` — it
    //   crashes on any other field name, so this MUST be `cells` of
    //   `{row,col}`, not `cellList` of `{r,c}`.
    // - applyCurrentMoveToState stores an area at `areas[move.cellStatus]`,
    //   so each area's `cellStatus` field must equal its own index.
    // A clue with no cells yet (partial hint state) is left `undefined` at
    // its index; the page's `void 0 !== areas[t]` guards skip those.
    if (Array.isArray(clues)) {
      var areas = [];
      for (var i = 0; i < clues.length; i++) {
        var cells = [];
        var minR = Infinity, minC = Infinity, maxR = -Infinity, maxC = -Infinity;
        for (var r2 = 0; r2 < rows && r2 < cs.length; r2++) {
          for (var c2 = 0; c2 < cs[r2].length; c2++) {
            if (cs[r2][c2] === i) {
              cells.push({ row: r2, col: c2 });
              if (r2 < minR) minR = r2;
              if (r2 > maxR) maxR = r2;
              if (c2 < minC) minC = c2;
              if (c2 > maxC) maxC = c2;
            }
          }
        }
        if (cells.length === 0) {
          areas[i] = undefined;
        } else {
          areas[i] = {
            cells: cells,
            cellStatus: i,
            invert: false,
            startPoint: { row: minR, col: minC },
            endPoint: { row: maxR, col: maxC },
          };
        }
      }
      window.Game.currentState.areas = areas;
    }

    if (typeof window.Game.drawCurrentState === 'function') {
      window.Game.drawCurrentState();
    } else if (typeof window.Game.redraw === 'function') {
      window.Game.redraw();
    } else if (typeof window.Game.render === 'function') {
      window.Game.render();
    } else if (window.Game.getSaved && window.Game.loadGame) {
      var saved = window.Game.getSaved();
      if (saved) window.Game.loadGame(saved);
    }
    return true;
  } catch (e) {
    console.warn('Shikaku apply failed:', e);
    return false;
  }
}

// Dump the current puzzle in our test/fixtures format, for capturing real
// puzzles to feed into bench-real.js. On failure returns
// { error, diagnostic, path } where `diagnostic` describes the shape of
// window.Game so the extractor can be patched.
function dumpPuzzleForBench() {
  function diagnostic(g) {
    function shape(v, depth) {
      if (v == null) return v === null ? 'null' : 'undefined';
      if (typeof v !== 'object') {
        return typeof v + (typeof v === 'string' ? '(' + v.length + ')' : '');
      }
      if (Array.isArray(v)) {
        var head = v.length > 0 ? (depth > 0 ? shape(v[0], depth - 1) : typeof v[0]) : 'empty';
        return 'array[' + v.length + ' of ' + head + ']';
      }
      return 'object{' + Object.keys(v).slice(0, 20).join(',') + '}';
    }
    if (!g) return { game: 'undefined' };
    return {
      gameKeys: Object.keys(g).slice(0, 50),
      task: shape(g.task, 2),
      taskSample: typeof g.task === 'string' ? g.task.slice(0, 200)
        : (Array.isArray(g.task) ? g.task.slice(0, 8)
        : (g.task && typeof g.task === 'object' ? Object.keys(g.task).slice(0, 20) : null)),
      currentState: shape(g.currentState, 2),
      currentStateKeys: g.currentState ? Object.keys(g.currentState).slice(0, 50) : null,
      areas: shape(g.areas, 1),
      width: g.puzzleWidth, height: g.puzzleHeight,
    };
  }

  try {
    var g = window.Game;
    if (!g) return { error: 'window.Game not found', diagnostic: diagnostic(null), path: location.pathname };
    var width = g.puzzleWidth || (g.getSetting && g.getSetting('puzzleWidth'));
    var height = g.puzzleHeight || (g.getSetting && g.getSetting('puzzleHeight'));
    if (!width || !height) {
      return { error: 'dimensions not found', diagnostic: diagnostic(g), path: location.pathname };
    }
    var path = location.pathname;

    function normalizeClue(arr) {
      if (arr == null) return [];
      if (typeof arr === 'number') return [arr];
      if (typeof arr === 'string') { var n = parseInt(arr, 10); return isNaN(n) ? [] : [n]; }
      if (Array.isArray(arr)) {
        return arr.map(function (v) {
          if (typeof v === 'number') return v;
          if (typeof v === 'string') { var n = parseInt(v, 10); return isNaN(n) ? NaN : n; }
          if (v && typeof v.run === 'number') return v.run;
          if (v && Array.isArray(v.runs) && v.runs.length > 0) return v.runs[0];
          return NaN;
        }).filter(function (v) { return !isNaN(v); });
      }
      if (typeof arr === 'object' && typeof arr.run === 'number') return [arr.run];
      return [];
    }

    function extractDualClueArrays() {
      // 1. g.task = { columns: [...], rows: [...] }
      if (g.task && Array.isArray(g.task.columns) && Array.isArray(g.task.rows)) {
        return {
          colClues: g.task.columns.slice(0, width).map(normalizeClue),
          rowClues: g.task.rows.slice(0, height).map(normalizeClue),
        };
      }
      // 2. g.task = flat array of (width + height) entries — columns first,
      //    then rows. Each entry is a number, string, or array of runs.
      //    (puzzles-mobile.com aquarium uses this shape.)
      if (Array.isArray(g.task) && g.task.length >= width + height) {
        var colClues = [], rowClues = [];
        for (var i = 0; i < width; i++) colClues.push(normalizeClue(g.task[i]));
        for (var i = width; i < width + height; i++) rowClues.push(normalizeClue(g.task[i]));
        return { colClues: colClues, rowClues: rowClues };
      }
      // 3. g.currentState.{colors,clues} = same flat layout as (2).
      var flat = g.currentState && (g.currentState.colors || g.currentState.clues);
      if (Array.isArray(flat) && flat.length >= width + height) {
        var colClues2 = [], rowClues2 = [];
        for (var i = 0; i < width; i++) colClues2.push(normalizeClue(flat[i]));
        for (var i = width; i < width + height; i++) rowClues2.push(normalizeClue(flat[i]));
        return { colClues: colClues2, rowClues: rowClues2 };
      }
      return null;
    }

    if (path.indexOf('/binairo/') !== -1 || path.indexOf('/binairo-plus/') !== -1) {
      if (!Array.isArray(g.task)) {
        return { error: 'binairo: g.task is not a 2D array', diagnostic: diagnostic(g), path: path };
      }
      var givens = [];
      for (var r = 0; r < height; r++) {
        var srcRow = g.task[r] || [];
        var copyRow = [];
        for (var c = 0; c < width; c++) {
          var v = srcRow[c];
          copyRow.push((v === 0 || v === 1) ? v : -1);
        }
        givens.push(copyRow);
      }
      var comparison = Array.isArray(g.comparisonClues) ? g.comparisonClues : [];
      return { type: 'binairo', rows: height, cols: width, givens: givens, comparisonClues: comparison, path: path };
    }

    if (path.indexOf('/shikaku/') !== -1) {
      if (!Array.isArray(g.task)) {
        return { error: 'shikaku: g.task is not a 2D array', diagnostic: diagnostic(g), path: path };
      }
      var clues = [];
      for (var r = 0; r < height; r++) {
        var srcRow = g.task[r] || [];
        for (var c = 0; c < width; c++) {
          var v = srcRow[c];
          if (typeof v === 'number' && v > 0) clues.push({ row: r, col: c, area: v });
        }
      }
      return { type: 'shikaku', rows: height, cols: width, clues: clues, path: path };
    }

    if (path.indexOf('/galaxies/') !== -1) {
      var stars = [];
      // 1. g.task as a sparse 2D matrix of doubled-coord star positions
      //    (puzzles-mobile.com /galaxies/special/monthly uses this shape).
      //    Cell count = (matrix_dim + 1) / 2. puzzleWidth/Height reported by
      //    the site are 1 more than the cell count for this puzzle type.
      if (Array.isArray(g.task) && Array.isArray(g.task[0])) {
        for (var r = 0; r < g.task.length; r++) {
          var row = g.task[r];
          if (!Array.isArray(row)) continue;
          for (var c = 0; c < row.length; c++) {
            if (row[c] === 1) stars.push({ row: r, col: c });
          }
        }
        var dimRows = (g.task.length + 1) / 2;
        // Derive cell-col count from the widest row, fall back to width/(width-1).
        var maxCols = 0;
        for (var r2 = 0; r2 < g.task.length; r2++) {
          if (Array.isArray(g.task[r2]) && g.task[r2].length > maxCols) maxCols = g.task[r2].length;
        }
        var dimCols = (maxCols + 1) / 2;
        return { type: 'galaxies', rows: dimRows, cols: dimCols, stars: stars, path: path };
      }
      // 2. g.task as a task string (existing path).
      var taskStr =
        (g.currentState && typeof g.currentState.task === 'string' && g.currentState.task) ||
        (typeof g.task === 'string' ? g.task : null);
      if (!taskStr) return { error: 'galaxies: no task string or matrix', diagnostic: diagnostic(g), path: path };
      var cellW = (typeof g.puzzleWidth === 'number' && g.puzzleWidth > 1 && Array.isArray(g.task)) ? g.puzzleWidth - 1 : width;
      var cellH = (typeof g.puzzleHeight === 'number' && g.puzzleHeight > 1 && Array.isArray(g.task)) ? g.puzzleHeight - 1 : height;
      var cols = 2 * cellW - 1;
      var rows = 2 * cellH - 1;
      var pos = 0;
      for (var i = 0; i < taskStr.length; i++) {
        if (taskStr[i] === 'z') { pos += 25; continue; }
        pos += taskStr.charCodeAt(i) - 97;
        var sr = Math.floor(pos / cols);
        var sc = pos % cols;
        if (sr >= rows) break;
        stars.push({ row: sr, col: sc });
        pos++;
      }
      return { type: 'galaxies', rows: cellH, cols: cellW, stars: stars, path: path };
    }

    if (path.indexOf('/aquarium/') !== -1) {
      var clues = extractDualClueArrays();
      if (!clues) return { error: 'aquarium: no clues', diagnostic: diagnostic(g), path: path };
      function flatten(a) { return a.map(function (v) { return Array.isArray(v) ? (v[0] || 0) : (v | 0); }); }
      var regions = g.areas || (g.currentState && g.currentState.areas);
      if (!Array.isArray(regions) || regions.length < height) return { error: 'aquarium: no regionMap', diagnostic: diagnostic(g), path: path };
      var regionMap = [];
      for (var r = 0; r < height; r++) regionMap.push(regions[r].slice(0, width));
      return {
        type: 'aquarium', rows: height, cols: width,
        rowClues: flatten(clues.rowClues), colClues: flatten(clues.colClues),
        regionMap: regionMap, path: path,
      };
    }

    var clues2 = extractDualClueArrays();
    if (!clues2) return { error: 'nonogram: no clues', diagnostic: diagnostic(g), path: path };
    return {
      type: 'nonogram', rows: height, cols: width,
      rowClues: clues2.rowClues, colClues: clues2.colClues, path: path,
    };
  } catch (e) {
    return { error: e && e.message ? e.message : String(e) };
  }
}
