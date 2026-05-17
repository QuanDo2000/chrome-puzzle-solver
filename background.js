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
      if (!window.Game) return null;
      if (window.Game.loaded === false) return null;

      var width = null;
      var height = null;
      if (window.Game.puzzleWidth) width = window.Game.puzzleWidth;
      if (window.Game.puzzleHeight) height = window.Game.puzzleHeight;
      if (typeof window.Game.getSetting === 'function') {
        if (!width) width = window.Game.getSetting('puzzleWidth');
        if (!height) height = window.Game.getSetting('puzzleHeight');
      }

      var taskStr = null;
      if (window.Game.currentState && window.Game.currentState.task
          && typeof window.Game.currentState.task === 'string'
          && window.Game.currentState.task.length > 0) {
        taskStr = window.Game.currentState.task;
      } else if (window.Game.task && typeof window.Game.task === 'string'
                 && window.Game.task.length > 0) {
        taskStr = window.Game.task;
      }
      if (taskStr) {
        return { task: taskStr, width: width, height: height };
      }

      if (width && height && Array.isArray(window.Game.task)
          && window.Game.task.length >= width + height
          && Array.isArray(window.Game.areas) && window.Game.areas.length >= height) {
        var clues = [];
        for (var i = 0; i < width + height; i++) clues.push(window.Game.task[i]);
        var regions = [];
        for (var r = 0; r < height; r++) {
          if (!Array.isArray(window.Game.areas[r]) || window.Game.areas[r].length < width) return null;
          for (var c = 0; c < width; c++) regions.push(window.Game.areas[r][c] + 1);
        }
        return { task: clues.join('_') + ';' + regions.join(','), width: width, height: height };
      }

      if (window.Game.task && window.Game.task.columns && window.Game.task.rows
          && window.Game.task.columns.length > 0 && window.Game.task.rows.length > 0) {
        var cols = window.Game.task.columns;
        var rows = window.Game.task.rows;
        if (!width) width = cols.length;
        if (!height) height = rows.length;
        if (width && height) {
          var colClues = [];
          var rowClues = [];
          for (var i = 0; i < width && i < cols.length; i++) {
            colClues.push(normalizeClueArray(cols[i]));
          }
          for (var i = 0; i < height && i < rows.length; i++) {
            rowClues.push(normalizeClueArray(rows[i]));
          }
          return { colClues: colClues, rowClues: rowClues, width: width, height: height };
        }
      }

      if (window.Game.currentState) {
        var state = window.Game.currentState;
        if (state.colors && Array.isArray(state.colors) && state.colors.length > 0) {
          var c = state.colors;
          if (width && height && c.length >= width + height) {
            var colClues = [];
            var rowClues = [];
            for (var i = 0; i < width; i++) {
              colClues.push(normalizeClueArray(c[i]));
            }
            for (var i = width; i < width + height; i++) {
              rowClues.push(normalizeClueArray(c[i]));
            }
            return { colClues: colClues, rowClues: rowClues, width: width, height: height };
          }
          return { colors: c, width: width, height: height };
        }
        if (state.clues && Array.isArray(state.clues) && state.clues.length > 0) {
          var c = state.clues;
          if (width && height && c.length >= width + height) {
            var colClues = [];
            var rowClues = [];
            for (var i = 0; i < width; i++) {
              colClues.push(normalizeClueArray(c[i]));
            }
            for (var i = width; i < width + height; i++) {
              rowClues.push(normalizeClueArray(c[i]));
            }
            return { colClues: colClues, rowClues: rowClues, width: width, height: height };
          }
        }
      }

      return null;
    } catch (e) {
      return null;
    }
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
  try {
    if (!window.Game || !window.Game.currentState || !lines) return;
    var hs = window.Game.currentState.cellHorizontalStatus;
    var vs = window.Game.currentState.cellVerticalStatus;
    if (!hs || !vs || !lines.horizontal || !lines.vertical) return;
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
      syncGameTimerForCheck();
      window.Game.solved = false;
      window.Game.currentState.solved = false;
      await window.Game.check(false, true);
    }
  } catch (e) {
    console.warn('Galaxies apply failed:', e);
  }
}

function applyGameState(solution) {
  try {
    var rows = solution.length;
    var cols = solution[0].length;
    if (window.Game && window.Game.currentState && window.Game.currentState.cellStatus) {
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
        syncGameTimerForCheck();
        window.Game.solved = false;
        window.Game.currentState.solved = false;
        window.Game.check(false, true);
      }
    }
  } catch (e) {
    console.warn('Game API injection failed:', e);
  }
}

function applyHintCells(hintCells) {
  try {
    if (!window.Game || !window.Game.currentState || !window.Game.currentState.cellStatus) return;
    const cs = window.Game.currentState.cellStatus;
    for (let i = 0; i < hintCells.length; i++) {
      const cell = hintCells[i];
      if (cell.row !== undefined && cell.col !== undefined && cell.row < cs.length && cell.col < cs[cell.row].length) {
        cs[cell.row][cell.col] = cell.value === 1 ? 1 : cell.value === -1 ? 2 : 0;
      }
    }
    if (typeof window.Game.render === 'function') window.Game.render();
  } catch (e) {
    console.warn('Hint apply failed:', e);
  }
}

function syncGameTimerForCheck() {
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

function fixGameTimer() {
  try {
    if (!window.Game) return false;
    var now = new Date().getTime();
    var elapsed = null;

    if (typeof window.Game.getSaveIdent === 'function') {
      var key = 'timer-' + window.Game.getSaveIdent();
      var saved = localStorage.getItem(key);
      if (saved && saved !== 'DNF' && saved !== 'dnf') {
        var n = parseFloat(saved);
        if (n > 0 && isFinite(n)) elapsed = n;
      }
      if (saved === 'DNF' || saved === 'dnf') {
        localStorage.removeItem(key);
      }
    }
    if (!elapsed && typeof window.startTime === 'number' && window.startTime > 0) {
      elapsed = Math.max(0, now - window.startTime);
    }
    if (!elapsed && window.Game.accumulated > 0) {
      elapsed = window.Game.accumulated;
    }
    if (!elapsed && typeof window.Game.getTimer === 'function') {
      if (typeof window.Game.tickTimer === 'function') window.Game.tickTimer();
      var t = window.Game.getTimer();
      if (typeof t === 'number' && isFinite(t) && t > 0) elapsed = t;
    }
    if (!elapsed || elapsed < 0 || !isFinite(elapsed)) elapsed = 0;

    // Clear DNF flags
    if (window.Game.currentState) {
      ['dnf', 'isDnf', 'DNF'].forEach(function(k) {
        if (k in window.Game.currentState) window.Game.currentState[k] = false;
      });
    }
    ['dnf', 'isDnf', 'DNF'].forEach(function(k) {
      if (k in window.Game) window.Game[k] = false;
    });

    // Set the timer state
    window.Game.accumulated = elapsed;
    window.Game.lastTrackedTime = now;

    // Force DOM timer elements
    var display = elapsed > 0
      ? Math.floor(elapsed / 60000) + ':' + ('0' + Math.floor((elapsed % 60000) / 1000)).slice(-2)
      : '0:00';
    var timerEls = document.querySelectorAll('[class*="timer"], [id*="timer"], [class*="time"], [id*="time"]');
    for (var i = 0; i < timerEls.length; i++) {
      var el = timerEls[i];
      if (el.textContent && el.textContent.trim().length <= 5) el.textContent = display;
    }

    if (typeof window.Game.getSaveIdent === 'function') {
      localStorage.setItem('timer-' + window.Game.getSaveIdent(), elapsed);
    }

    // Trigger server submission: must set solved=false first so check() re-validates
    if (typeof window.Game.check === 'function') {
      if (window.Game.currentState) {
        window.Game.currentState.solved = true;
        if ('solvedTime' in window.Game.currentState) window.Game.currentState.solvedTime = elapsed;
      }
      window.Game.solved = false;
      window.Game.check(false, true);
    } else if (typeof window.Game.render === 'function') {
      window.Game.render();
    }

    return true;
  } catch (e) {
    console.warn('fixGameTimer failed:', e);
    return false;
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'execMain') {
    const fn = globalThis[request.funcName];
    if (typeof fn !== 'function') {
      sendResponse(null);
      return;
    }
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab) { sendResponse(null); return; }
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: fn,
        args: request.args || []
      }, (results) => {
        if (chrome.runtime.lastError || !results || !results[0]) {
          sendResponse(null);
        } else {
          sendResponse(results[0].result);
        }
      });
    });
    return true;
  }

  if (request.action === 'sendToContent') {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab) {
        sendResponse({ success: false, error: 'No active tab' });
        return;
      }
      chrome.tabs.sendMessage(tab.id, request.payload, (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse(response);
        }
      });
    });
    return true;
  }
});
