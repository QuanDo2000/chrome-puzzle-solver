// ── Handler registry ──────────────────────────────────────────

const handlers = [];

function isPuzzlesMobilePage() {
  return window.location.hostname === 'www.puzzles-mobile.com';
}

function registerHandler(h) {
  handlers.push(h);
  handlers.sort((a, b) => (b.priority || 0) - (a.priority || 0));
}

// Used by content.js — content scripts share scope but lint files in
// isolation, so the cross-file consumer is invisible here.
// eslint-disable-next-line no-unused-vars
function getActiveHandler() {
  return handlers.find(h => h.matches()) || null;
}

// ── callMainWorld: bridge to MAIN world via background script ─

// MAIN-world poll functions (readGameClues, readGalaxiesData) wait up to ~10s
// for window.Game to populate. The MV3 service worker can be killed at 30s
// idle; if that happens before sendResponse fires, the sendMessage callback
// never resolves and the UI hangs. Race against a wall-clock timeout so the
// caller always gets a result (null on timeout) within a bounded window.
const CALL_MAIN_WORLD_TIMEOUT_MS = 15000;

function callMainWorld(funcName, args) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => settle(null), CALL_MAIN_WORLD_TIMEOUT_MS);
    try {
      if (typeof chrome?.runtime?.sendMessage !== 'function') {
        clearTimeout(timer);
        settle(null);
        return;
      }
      chrome.runtime.sendMessage({
        action: 'execMain',
        funcName: funcName,
        args: args || []
      }, (response) => {
        clearTimeout(timer);
        settle(response);
      });
    } catch {
      clearTimeout(timer);
      settle(null);
    }
  });
}

// `genericGetCellState` / `genericSetCellDOM` (defined below) are still used
// as DOM fallbacks by the puzzles-mobile handler. The previous "generic"
// catch-all puzzle handler was never registered and has been removed.

// ── Shared task parser ────────────────────────────────────────

function parsePuzzleTask() {
  const scripts = document.querySelectorAll('script');
  let task = null;
  let width = 30;
  let height = 30;
  for (const script of scripts) {
    const text = script.textContent || '';
    const taskMatch = text.match(/var\s+task\s*=\s*'([^']+)'/);
    if (taskMatch) task = taskMatch[1];
    const wMatch = text.match(/puzzleWidth\s*:\s*(\d+)/);
    const hMatch = text.match(/puzzleHeight\s*:\s*(\d+)/);
    if (wMatch) width = parseInt(wMatch[1], 10);
    if (hMatch) height = parseInt(hMatch[1], 10);
  }
  return { task, width, height };
}

function parseGalaxiesTask(task, width, height) {
  const stars = [];
  if (!task) return stars;
  const cols = 2 * width - 1;
  const rows = 2 * height - 1;
  let pos = 0;
  for (let i = 0; i < task.length; i++) {
    if (task[i] === 'z') {
      pos += 25;
      continue;
    }
    pos += task.charCodeAt(i) - 97;
    const row = Math.floor(pos / cols);
    const col = pos % cols;
    if (row >= rows) break;
    stars.push({ row, col });
    pos++;
  }
  return stars;
}

// ── Galaxies handler (puzzles-mobile.com/galaxies/) ───────────

const galaxiesHandler = {
  name: 'puzzles-mobile-galaxies',
  priority: 25,

  matches() {
    return isPuzzlesMobilePage() &&
           window.location.pathname.includes('/galaxies/');
  },

  async detect() {
    const result = { found: false, rows: 0, cols: 0, rowClues: [], colClues: [] };
    let { task, width, height } = parsePuzzleTask();
    const gameData = await callMainWorld('readGalaxiesData', []);
    if (gameData) {
      task = gameData.task || task;
      width = gameData.width || width;
      height = gameData.height || height;
    }
    const stars = gameData?.stars?.length ? gameData.stars : parseGalaxiesTask(task, width, height);
    if (!stars.length) return { ...result, error: 'No Galaxies dots found' };
    const gameEl = document.getElementById('game') ||
      document.querySelector('#stage, [class*="game"], [class*="puzzle"]');
    return {
      found: true,
      type: 'galaxies',
      rows: height,
      cols: width,
      rowClues: [],
      colClues: [],
      stars,
      task,
      _cells: [],
      _element: gameEl,
    };
  },

  async readState(ctx) {
    const state = await callMainWorld('readGalaxiesState', [ctx.rows, ctx.cols]);
    if (state?.grid) {
      state.grid.galaxies = state.lines;
      return state.grid;
    }
    return Array.from({ length: ctx.rows }, () => Array(ctx.cols).fill(0));
  },

  async applySolution(solution, ctx) {
    const lines = solution?.type === 'galaxies-lines'
      ? solution.lines
      : solution?.galaxies || GalaxiesSolver.regionsToLines(solution, ctx.rows, ctx.cols);
    const ok = await callMainWorld('applyGalaxiesState', [lines]);
    return ok
      ? { success: true }
      : { success: false, error: 'Galaxies apply failed (no window.Game or MAIN-world timeout)' };
  },
};

registerHandler(galaxiesHandler);

// ── Aquarium handler (puzzles-mobile.com/aquarium/) ───────────

const aquariumHandler = {
  name: 'puzzles-mobile-aquarium',
  priority: 20,

  matches() {
    return isPuzzlesMobilePage() &&
           window.location.pathname.includes('/aquarium/');
  },

  async detect() {
    const result = { found: false, rows: 0, cols: 0, rowClues: [], colClues: [] };
    let task, width, height;
    const parsed = parsePuzzleTask();
    task = parsed.task;
    width = parsed.width;
    height = parsed.height;

    if (task) {
      return this._processAquariumTask(result, task, width, height);
    }

    const gameData = await callMainWorld('readGameClues', []);
    if (gameData && gameData.task) {
      return this._processAquariumTask(result, gameData.task,
        gameData.width || width, gameData.height || height);
    }

    return { ...result, error: 'No aquarium task data found' };
  },

  _processAquariumTask(result, task, width, height) {
    const parts = task.split(';');
    if (parts.length !== 2) {
      return { ...result, error: 'Expected aquarium task format: clues;regions' };
    }

    const clueVals = parts[0].split('_').map(Number);
    const totalClues = height + width;
    if (clueVals.length < totalClues) {
      return { ...result, error: `Expected ${totalClues} clues, got ${clueVals.length}` };
    }

    const colClues = clueVals.slice(0, width);
    const rowClues = clueVals.slice(width, width + height);

    const regionIds = parts[1].split(',').map(Number);
    if (regionIds.length < width * height) {
      return { ...result, error: `Expected ${width * height} region IDs, got ${regionIds.length}` };
    }

    const regionMap = [];
    for (let r = 0; r < height; r++) {
      regionMap[r] = [];
      for (let c = 0; c < width; c++) {
        regionMap[r][c] = regionIds[r * width + c];
      }
    }

    const gameEl = document.getElementById('game') ||
      document.querySelector('#stage, [class*="game"], [class*="puzzle"]');

    return {
      found: true,
      type: 'aquarium',
      rows: height,
      cols: width,
      rowClues,
      colClues,
      regionMap,
      _cells: [],
      _element: gameEl,
    };
  },

  async readState(ctx) {
    const state = await callMainWorld('readGameState', [ctx.rows, ctx.cols]);
    return state || null;
  },

  async applySolution(solution, _ctx) {
    const ok = await callMainWorld('applyGameState', [solution]);
    return ok
      ? { success: true }
      : { success: false, error: 'Aquarium apply failed (no window.Game or MAIN-world timeout)' };
  },
};

registerHandler(aquariumHandler);

// ── Binairo handler (puzzles-mobile.com/binairo/) ─────────────

const binairoHandler = {
  name: 'puzzles-mobile-binairo',
  priority: 30,

  matches() {
    return isPuzzlesMobilePage() && (
      window.location.pathname.includes('/binairo/') ||
      window.location.pathname.includes('/binairo-plus/')
    );
  },

  async detect() {
    const result = { found: false, rows: 0, cols: 0, rowClues: [], colClues: [] };
    const data = await callMainWorld('readBinairoData', []);
    if (!data) return { ...result, error: 'No Binairo task data found' };
    const stageEl = document.getElementById('stage') ||
                    document.getElementById('game') ||
                    document.querySelector('[class*="game"], [class*="puzzle"]');
    return {
      found: true,
      type: 'binairo',
      rows: data.height,
      cols: data.width,
      givens: data.task,
      comparisonClues: data.comparisonClues || [],
      rowClues: [],
      colClues: [],
      _cells: [],
      _element: stageEl,
    };
  },

  async readState(ctx) {
    const state = await callMainWorld('readBinairoState', [ctx.rows, ctx.cols]);
    if (state) return state;
    return Array.from({ length: ctx.rows }, () => new Array(ctx.cols).fill(0));
  },

  async applySolution(solution, _ctx) {
    const ok = await callMainWorld('applyBinairoState', [solution]);
    return ok
      ? { success: true }
      : { success: false, error: 'Binairo apply failed (no window.Game or MAIN-world timeout)' };
  },
};

registerHandler(binairoHandler);

// ── Puzzles-mobile handler ────────────────────────────────────

const puzzlesMobileHandler = {
  name: 'puzzles-mobile',
  priority: 10,

  matches() {
    return isPuzzlesMobilePage();
  },

  async detect() {
    const result = { found: false, rows: 0, cols: 0, rowClues: [], colClues: [] };
    const { task, width, height } = parsePuzzleTask();

    if (task) {
      return this._processTaskString(result, task, width, height);
    }

    return await this._detectFromGameAPI(result, width, height);
  },

  async readState(ctx) {
    const state = await callMainWorld('readGameState', [ctx.rows, ctx.cols]);
    if (state) return state;

    const { rows, cols, _cells: cells } = ctx;
    if (!cells || cells.length < rows * cols) return null;
    const grid = Array.from({ length: rows }, () => Array(cols).fill(0));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        if (idx < cells.length) grid[r][c] = genericGetCellState(cells[idx]);
      }
    }
    return grid;
  },

  async applySolution(solution, ctx) {
    const { rows, cols, _cells: cells } = ctx;
    const haveCells = cells && cells.length >= rows * cols;
    if (haveCells) {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const idx = r * cols + c;
          if (idx >= cells.length) continue;
          if (!solution[r] || solution[r][c] === undefined) continue;
          genericSetCellDOM(cells[idx], solution[r][c]);
        }
      }
    }
    const ok = await callMainWorld('applyGameState', [solution]);
    // DOM-click fallback counts as success: if window.Game isn't available
    // the DOM mutations are the actual user-visible apply. Either path
    // succeeding is enough.
    return (ok || haveCells)
      ? { success: true }
      : { success: false, error: 'No cells to click and MAIN-world apply failed' };
  },

  _processTaskString(result, task, width, height) {
    const segments = task.split('/');
    const expected = width + height;
    if (segments.length < expected) {
      return { ...result, error: `Expected ${expected} clue groups, got ${segments.length}` };
    }
    const colClues = segments.slice(0, width).map(s =>
      s.split('.').map(Number).filter(n => !isNaN(n))
    );
    const rowClues = segments.slice(width, width + height).map(s =>
      s.split('.').map(Number).filter(n => !isNaN(n))
    );
    const ctx = this._buildContext({ element: null, rows: height, cols: width, rowClues, colClues });
    return {
      found: true, type: 'nonogram', rows: height, cols: width, rowClues, colClues,
      _cells: ctx._cells, _element: ctx._element,
      note: ctx._cells.length < height * width
        ? 'Grid cells not fully found — clues extracted, state reading may be limited'
        : undefined,
    };
  },

  async _detectFromGameAPI(result, fallbackWidth, fallbackHeight) {
    const gameData = await callMainWorld('readGameClues', []);
    if (!gameData) return { ...result, error: 'No puzzle task data or game clues found' };

    let width = fallbackWidth;
    let height = fallbackHeight;
    let colClues, rowClues;

    if (gameData.colClues && gameData.rowClues) {
      colClues = gameData.colClues;
      rowClues = gameData.rowClues;
      if (gameData.width) width = gameData.width;
      if (gameData.height) height = gameData.height;
    } else if (gameData.task) {
      return this._processTaskString(result, gameData.task, gameData.width || width, gameData.height || height);
    } else if (gameData.colors && gameData.colors.length > 0) {
      if (!width || !height) {
        if (gameData.width) width = gameData.width;
        if (gameData.height) height = gameData.height;
      }
      if (width && height && gameData.colors.length >= width + height) {
        const normalize = a => (Array.isArray(a) ? a : [a]).map(v =>
          typeof v === 'number' ? v : (v && typeof v.run === 'number' ? v.run : NaN)
        ).filter(v => !isNaN(v));
        colClues = gameData.colors.slice(0, width).map(normalize);
        rowClues = gameData.colors.slice(width, width + height).map(normalize);
      } else {
        return { ...result, error: 'Could not determine puzzle dimensions from game API' };
      }
    } else {
      return { ...result, error: 'No puzzle task data found on puzzles-mobile.com' };
    }

    if (colClues && rowClues && width && height) {
      const ctx = this._buildContext({ element: null, rows: height, cols: width, rowClues, colClues });
      return {
        found: true, type: 'nonogram', rows: height, cols: width, rowClues, colClues,
        _cells: ctx._cells, _element: ctx._element,
        note: ctx._cells.length < height * width
          ? 'Grid cells not fully found — clues extracted, state reading may be limited'
          : undefined,
      };
    }

    return { ...result, error: 'Could not parse puzzle clues from game API' };
  },

  _buildContext(base) {
    const gameEl = document.getElementById('game') ||
      document.querySelector('#stage, [class*="game"], [class*="puzzle"]');
    const cells = this._findPluginGridCells(gameEl, base.rows, base.cols);
    return { ...base, _element: gameEl, _cells: cells };
  },

  _findPluginGridCells(container, rows, cols) {
    if (!container) return [];
    const gridBack = container.querySelector('.nonograms-cell-back');
    if (gridBack) {
      const rowEls = gridBack.querySelectorAll('.row');
      const cells = [];
      for (const rowEl of rowEls) {
        const rowCells = rowEl.querySelectorAll('.cell');
        if (rowCells.length > 0) cells.push(...rowCells);
      }
      if (cells.length >= rows * cols) return cells;
    }
    const tables = container.querySelectorAll('table');
    for (const table of tables) {
      const tds = table.querySelectorAll('td');
      if (tds.length >= rows * cols) return Array.from(tds);
    }
    const rowEls = container.querySelectorAll('[class*="row"]');
    if (rowEls.length >= rows) {
      const cells = [];
      for (const rowEl of rowEls) {
        const rowCells = rowEl.querySelectorAll('[class*="cell"]');
        if (rowCells.length > 0) cells.push(...rowCells);
        else cells.push(...rowEl.children);
      }
      if (cells.length >= rows * cols) return cells;
    }
    const allCells = container.querySelectorAll('[class*="cell"]');
    if (allCells.length >= rows * cols) return Array.from(allCells);
    const divs = container.querySelectorAll('div');
    const cellDivs = Array.from(divs).filter(d => d.children.length === 0 && d.parentElement === container);
    if (cellDivs.length >= rows * cols) return cellDivs;
    return [];
  },
};

registerHandler(puzzlesMobileHandler);

// ── Shared DOM helpers (used by multiple handlers) ────────────

function genericGetCellState(cell) {
  const data = cell.dataset.state || cell.dataset.value || '';
  if (data === '1' || data === 'filled' || data === 'black') return 1;
  if (data === '-1' || data === '0' || data === 'cross') return -1;

  const text = cell.textContent.trim();
  if (text === '×' || text === 'X' || text === '✕' || text === '✖') return -1;

  for (const child of cell.children) {
    const c = (child.className || child.tagName || '').toLowerCase();
    if (c.includes('icon-cancel') || c === 'x-mark' || c.includes('cross')) return -1;
    if (c.includes('filled') || c.includes('cell-on') || child.tagName === 'IMG') return 1;
  }

  const bg = window.getComputedStyle(cell).backgroundColor;
  if (bg && bg !== 'transparent' && bg !== 'rgba(0,0,0,0)') {
    const m = bg.match(/\d+/g);
    if (m) {
      const brightness = (+m[0] * 299 + +m[1] * 587 + +m[2] * 114) / 1000;
      if (brightness < 150) return 1;
    }
  }

  const cls = (' ' + cell.className + ' ').toLowerCase();
  if (/ (off|cross|cell-off|x) /i.test(cls)) return -1;
  if (/ (on|filled|black|cell-on) /i.test(cls)) return 1;

  return 0;
}

const FILLED_CLASSES = ['cell-on', 'on', 'filled'];
const CROSS_CLASSES = ['cell-off', 'off', 'cross', 'x'];

function genericSetCellDOM(cell, val) {
  if (val === 1) {
    FILLED_CLASSES.forEach(c => cell.classList.add(c));
    CROSS_CLASSES.forEach(c => cell.classList.remove(c));
    cell.dataset.state = '1';
    cell.dataset.value = 'filled';
    cell.style.backgroundColor = '#000';
  } else if (val === -1) {
    CROSS_CLASSES.forEach(c => cell.classList.add(c));
    FILLED_CLASSES.forEach(c => cell.classList.remove(c));
    cell.dataset.state = '-1';
    cell.dataset.value = 'cross';
    cell.style.backgroundColor = '#fff';
  } else {
    FILLED_CLASSES.forEach(c => cell.classList.remove(c));
    CROSS_CLASSES.forEach(c => cell.classList.remove(c));
    cell.dataset.state = '0';
    cell.dataset.value = '';
    cell.style.backgroundColor = '';
  }

  const prevX = cell.querySelector('.ns-xmark');
  if (prevX) prevX.remove();

  if (val === -1) {
    if (!cell.querySelector('.ns-xmark, .x-mark, [class*="cross"], [class*="cancel"]')) {
      const x = document.createElement('span');
      x.className = 'ns-xmark';
      x.textContent = '\u00D7';
      x.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:inherit;line-height:1;pointer-events:none;';
      cell.style.position = 'relative';
      cell.appendChild(x);
    }
  }

  const input = cell.querySelector('input[type="checkbox"], input[type="radio"]');
  if (input) input.checked = val === 1;
}

// Node-only export for tests. The handler-object literals above register
// themselves via registerHandler() at load time, but those handlers stay
// dormant until getActiveHandler() is called, which tests don't do.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseGalaxiesTask };
}
