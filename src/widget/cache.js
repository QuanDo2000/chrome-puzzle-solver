'use strict';

// Solution-cache hygiene. Each cached entry stores `savedAt: Date.now()`.
// Two cleanup paths cooperate:
//   * TTL on read: entries older than SOLUTION_TTL_MS are evicted at the
//     read site and treated as a miss. Self-healing — a stale entry
//     vanishes the next time anyone tries to read it.
//   * Prune on write: after each cache write, scan all *-solution:* keys,
//     drop any past TTL, and if we still exceed SOLUTION_CACHE_MAX, evict
//     the oldest by savedAt until we fit. Bounds the cache against
//     localStorage quota (~5 MB per origin).
const SOLUTION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SOLUTION_CACHE_MAX = 50;
const SOLUTION_KEY_PREFIXES = ['galaxies-solution:', 'aquarium-solution:', 'nonogram-solution:', 'binairo-solution:', 'shikaku-solution:', 'yinyang-solution:', 'slitherlink-solution:', 'hashi-solution:', 'heyawake-solution:', 'hitori-solution:', 'kakurasu-solution:', 'kurodoko-solution:', 'mosaic-solution:', 'norinori-solution:', 'nurikabe-solution:'];

function isSolutionCacheKey(key) {
  return typeof key === 'string' && SOLUTION_KEY_PREFIXES.some(p => key.startsWith(p));
}

function pruneSolutionCache() {
  try {
    const now = Date.now();
    const entries = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!isSolutionCacheKey(key)) continue;
      let savedAt = 0;
      try {
        const parsed = JSON.parse(localStorage.getItem(key) || 'null');
        savedAt = parsed?.savedAt || 0;
      } catch { /* unparseable → treat as ancient, evict below */ }
      entries.push({ key, savedAt });
    }
    // TTL: drop anything past the window. Entries with no savedAt (or a
    // corrupted JSON above) get savedAt=0, so they always fall here first.
    const fresh = [];
    for (const e of entries) {
      if (now - e.savedAt > SOLUTION_TTL_MS) {
        try { localStorage.removeItem(e.key); } catch { /* ignore */ }
      } else {
        fresh.push(e);
      }
    }
    // LRU: oldest-first eviction until we fit.
    if (fresh.length > SOLUTION_CACHE_MAX) {
      fresh.sort((a, b) => a.savedAt - b.savedAt);
      const removeCount = fresh.length - SOLUTION_CACHE_MAX;
      for (let i = 0; i < removeCount; i++) {
        try { localStorage.removeItem(fresh[i].key); } catch { /* ignore */ }
      }
    }
  } catch { /* localStorage not available; nothing to prune */ }
}

function isFreshSolutionEntry(parsed) {
  if (!parsed || typeof parsed.savedAt !== 'number') return false;
  return Date.now() - parsed.savedAt <= SOLUTION_TTL_MS;
}

function galaxiesCacheKey(data) {
  if (!data || data.type !== 'galaxies') return null;
  const stars = (data.stars || []).map(s => s.row + ',' + s.col).join(';');
  return 'galaxies-solution:' + data.rows + 'x' + data.cols + ':' + stars;
}

function galaxiesPartialKey(data) {
  const key = galaxiesCacheKey(data);
  return key ? key.replace('galaxies-solution:', 'galaxies-partial:') : null;
}

function galaxiesFailedKey(data) {
  const key = galaxiesCacheKey(data);
  return key ? key.replace('galaxies-solution:', 'galaxies-failed:') : null;
}

function getCachedGalaxiesSolution(data) {
  const key = galaxiesCacheKey(data);
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.grid || !parsed?.galaxies) return null;
    if (!isFreshSolutionEntry(parsed)) {
      try { localStorage.removeItem(key); } catch { /* ignore */ }
      return null;
    }
    const grid = parsed.grid.map(row => row.slice());
    grid.galaxies = {
      horizontal: parsed.galaxies.horizontal.map(row => row.slice()),
      vertical: parsed.galaxies.vertical.map(row => row.slice()),
    };
    return grid;
  } catch {
    return null;
  }
}

function cacheGalaxiesSolution(data, grid) {
  const key = galaxiesCacheKey(data);
  if (!key || !grid?.galaxies) return;
  try {
    localStorage.setItem(key, JSON.stringify({ grid, galaxies: grid.galaxies, savedAt: Date.now() }));
    pruneSolutionCache();
  } catch { /* quota or unavailable; pruneSolutionCache would no-op anyway */ }
}

function getCachedGridSolution(data) {
  const reg = (typeof PUZZLES !== 'undefined' && PUZZLES) ? PUZZLES[data?.type] : null;
  const key = reg?.cacheKey ? reg.cacheKey(data) : null;
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!isFreshSolutionEntry(parsed)) {
      try { localStorage.removeItem(key); } catch { /* ignore */ }
      return null;
    }
    if (data.type === 'slitherlink') {
      if (!parsed?.horizontal || !parsed?.vertical) return null;
      return {
        horizontal: parsed.horizontal.map(row => row.slice()),
        vertical: parsed.vertical.map(row => row.slice()),
      };
    }
    if (data.type === 'hashi') {
      if (!Array.isArray(parsed?.edges)) return null;
      return { edges: parsed.edges.map(e => ({ ...e })) };
    }
    if (!Array.isArray(parsed?.grid)) return null;
    return parsed.grid.map(row => row.slice());
  } catch {
    return null;
  }
}

function cacheGridSolution(data, grid) {
  const reg = (typeof PUZZLES !== 'undefined' && PUZZLES) ? PUZZLES[data?.type] : null;
  const key = reg?.cacheKey ? reg.cacheKey(data) : null;
  if (!key) return;
  try {
    if (data?.type === 'slitherlink') {
      if (!grid || !grid.horizontal || !grid.vertical) return;
      localStorage.setItem(key, JSON.stringify({
        horizontal: grid.horizontal, vertical: grid.vertical, savedAt: Date.now(),
      }));
    } else if (data?.type === 'hashi') {
      if (!grid || !Array.isArray(grid.edges)) return;
      localStorage.setItem(key, JSON.stringify({
        edges: grid.edges, savedAt: Date.now(),
      }));
    } else {
      if (!Array.isArray(grid)) return;
      localStorage.setItem(key, JSON.stringify({ grid, savedAt: Date.now() }));
    }
    pruneSolutionCache();
  } catch { /* quota or unavailable */ }
}

function puzzlePartialKey(data) {
  if (!data) return null;
  if (data.type === 'galaxies') return galaxiesPartialKey(data);
  const base = [data.type || 'nonogram', data.rows, data.cols];
  if (data.type === 'aquarium') {
    base.push((data.rowClues || []).join(','), (data.colClues || []).join(','));
    base.push((data.regionMap || []).map(row => row.join(',')).join(';'));
  } else {
    base.push(JSON.stringify(data.rowClues || []), JSON.stringify(data.colClues || []));
  }
  return 'puzzle-partial:' + base.join('|');
}

function getCachedPartial(data) {
  const key = puzzlePartialKey(data);
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.grid) return null;
    return parsed.grid.map(row => row.slice());
  } catch {
    return null;
  }
}

function cachePartial(data, grid, filled) {
  const key = puzzlePartialKey(data);
  if (!key || !grid) return;
  try {
    const nextFilled = filled || countKnownCells(grid);
    const raw = localStorage.getItem(key);
    if (raw) {
      const current = JSON.parse(raw);
      if ((current?.filled || 0) > nextFilled) return;
    }
    localStorage.setItem(key, JSON.stringify({ grid, filled: nextFilled, savedAt: Date.now() }));
  } catch {}
}

function clearPartial(data) {
  const key = puzzlePartialKey(data);
  if (!key) return;
  try { localStorage.removeItem(key); } catch {}
}

function countKnownCells(grid) {
  let n = 0;
  for (const row of grid || []) for (const v of row || []) if (v !== 0) n++;
  return n;
}

function chooseInitialGrid(data, currentGrid) {
  const partial = getCachedPartial(data);
  if (!partial) return currentGrid || null;
  return countKnownCells(partial) > countKnownCells(currentGrid) ? partial : (currentGrid || partial);
}

function getCachedGalaxiesPartial(data) {
  return getCachedPartial(data);
}

function getFailedGalaxiesPartials(data) {
  const key = galaxiesFailedKey(data);
  if (!key) return [];
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(grid => grid.map(row => row.slice()));
  } catch {
    return [];
  }
}

function cacheFailedGalaxiesPartial(data, grid) {
  const key = galaxiesFailedKey(data);
  if (!key || !grid) return;
  try {
    const failed = getFailedGalaxiesPartials(data);
    const sig = JSON.stringify(grid);
    if (!failed.some(g => JSON.stringify(g) === sig)) failed.push(grid.map(row => row.slice()));
    while (failed.length > 20) failed.shift();
    localStorage.setItem(key, JSON.stringify(failed));
  } catch {}
}

function clearFailedGalaxiesPartials(data) {
  const key = galaxiesFailedKey(data);
  if (!key) return;
  try { localStorage.removeItem(key); } catch {}
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SOLUTION_TTL_MS, SOLUTION_CACHE_MAX, SOLUTION_KEY_PREFIXES,
    isSolutionCacheKey, pruneSolutionCache, isFreshSolutionEntry,
    galaxiesCacheKey, galaxiesPartialKey, galaxiesFailedKey,
    getCachedGalaxiesSolution, cacheGalaxiesSolution,
    getCachedGridSolution, cacheGridSolution,
    puzzlePartialKey, getCachedPartial, cachePartial, clearPartial,
    countKnownCells, chooseInitialGrid,
    getCachedGalaxiesPartial, getFailedGalaxiesPartials,
    cacheFailedGalaxiesPartial, clearFailedGalaxiesPartials,
  };
}
