// Paste the body of this IIFE into your browser DevTools console while on a
// puzzles-mobile.com puzzle page. It logs a JSON snippet matching the
// tests/fixtures/puzzles.js format. Copy the JSON and share it back.
//
// Run it on each puzzle you want to include in the bench. Aim for a mix —
// 2-3 nonograms, 2-3 aquariums, 2-3 galaxies, varied sizes.
(() => {
  const g = window.Game;
  if (!g) {
    console.error('window.Game not found — open the puzzle page first, then run this.');
    return;
  }

  const width = g.puzzleWidth || (g.getSetting && g.getSetting('puzzleWidth'));
  const height = g.puzzleHeight || (g.getSetting && g.getSetting('puzzleHeight'));
  if (!width || !height) {
    console.error('Could not determine puzzle dimensions from window.Game.');
    return;
  }
  const path = location.pathname;

  function normalizeClue(arr) {
    if (arr == null) return [];
    if (typeof arr === 'number') return [arr];
    if (typeof arr === 'string') {
      const n = parseInt(arr, 10);
      return Number.isNaN(n) ? [] : [n];
    }
    if (Array.isArray(arr)) {
      return arr.map(v => {
        if (typeof v === 'number') return v;
        if (typeof v === 'string') { const n = parseInt(v, 10); return Number.isNaN(n) ? NaN : n; }
        if (v && typeof v.run === 'number') return v.run;
        if (v && Array.isArray(v.runs) && v.runs.length > 0) return v.runs[0];
        return NaN;
      }).filter(v => !Number.isNaN(v));
    }
    if (typeof arr === 'object' && typeof arr.run === 'number') return [arr.run];
    return [];
  }

  function extractDualClueArrays() {
    // 1. Game.task = { columns: [...], rows: [...] }
    if (g.task && Array.isArray(g.task.columns) && Array.isArray(g.task.rows)) {
      return {
        colClues: g.task.columns.slice(0, width).map(normalizeClue),
        rowClues: g.task.rows.slice(0, height).map(normalizeClue),
      };
    }
    // 2. Game.currentState.{colors,clues} as a single flat array [cols..., rows...]
    const flat = g.currentState && (g.currentState.colors || g.currentState.clues);
    if (Array.isArray(flat) && flat.length >= width + height) {
      const colClues = [], rowClues = [];
      for (let i = 0; i < width; i++) colClues.push(normalizeClue(flat[i]));
      for (let i = width; i < width + height; i++) rowClues.push(normalizeClue(flat[i]));
      return { colClues, rowClues };
    }
    return null;
  }

  let out;
  if (path.includes('/galaxies/')) {
    // Galaxies: encoded star positions on the doubled-coord grid (see
    // handler.js parseGalaxiesTask). Game.task is normally a string.
    const taskStr =
      (g.currentState && typeof g.currentState.task === 'string' && g.currentState.task) ||
      (typeof g.task === 'string' ? g.task : null);
    if (!taskStr) {
      console.error('Galaxies: no task string found on window.Game.');
      return;
    }
    const cols = 2 * width - 1;
    const rows = 2 * height - 1;
    const stars = [];
    let pos = 0;
    for (let i = 0; i < taskStr.length; i++) {
      if (taskStr[i] === 'z') { pos += 25; continue; }
      pos += taskStr.charCodeAt(i) - 97;
      const r = Math.floor(pos / cols);
      const c = pos % cols;
      if (r >= rows) break;
      stars.push({ row: r, col: c });
      pos++;
    }
    out = { type: 'galaxies', rows: height, cols: width, stars };
  } else if (path.includes('/aquarium/')) {
    // Aquarium: rowClues/colClues are flat ints (water-cell counts per line),
    // regionMap is the area/region id per cell.
    const clues = extractDualClueArrays();
    if (!clues) { console.error('Aquarium: could not extract row/col clues.'); return; }
    // Aquarium clues are single integers per line, not arrays of runs.
    const flatten = a => a.map(v => Array.isArray(v) ? (v[0] || 0) : (v | 0));
    const regions = g.areas || g.currentState?.areas;
    if (!Array.isArray(regions) || regions.length < height) {
      console.error('Aquarium: regionMap (window.Game.areas) not found.'); return;
    }
    const regionMap = [];
    for (let r = 0; r < height; r++) regionMap.push(regions[r].slice(0, width));
    out = {
      type: 'aquarium',
      rows: height, cols: width,
      rowClues: flatten(clues.rowClues),
      colClues: flatten(clues.colClues),
      regionMap,
    };
  } else {
    // Nonogram
    const clues = extractDualClueArrays();
    if (!clues) { console.error('Nonogram: could not extract row/col clues.'); return; }
    out = {
      type: 'nonogram',
      rows: height, cols: width,
      rowClues: clues.rowClues,
      colClues: clues.colClues,
    };
  }

  // Pretty-print to console + also drop on `window.__bench` for easy copy.
  console.log('// ' + path);
  console.log(JSON.stringify(out, null, 2));
  window.__bench = out;
  console.log('Saved to window.__bench. To copy to clipboard: copy(JSON.stringify(window.__bench))');
})();
