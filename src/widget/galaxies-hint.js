'use strict';

// Galaxies hint helpers — content-script side of the Galaxies puzzle.
//
// === Shared statics on `GalaxiesSolver` ===
//
// `GalaxiesSolver.seedCellsForStar(star, rows, cols)` and
// `GalaxiesSolver.regionsToLines(grid, rows, cols)` are static, used by
// solver, this file (hint), and `handler.js` (DOM lines). Don't reintroduce
// per-file copies — they drifted before.

function cloneGalaxiesLines(lines) {
  return {
    horizontal: (lines?.horizontal || []).map(row => row.slice()),
    vertical: (lines?.vertical || []).map(row => row.slice()),
  };
}

function getGalaxiesHint(grid, stars) {
  const current = grid?.galaxies;
  if (!current || !stars?.length) return null;
  const rows = grid.length;
  const cols = grid[0].length;
  const seedOwner = buildGalaxiesSeedOwner(stars, rows, cols);
  const components = getGalaxiesComponents(grid, stars, seedOwner);
  const reachable = computeReachableStars(stars, rows, cols, seedOwner, current);

  propagateAllConstraints(components, grid, rows, cols, current, stars);

  // Iterative per-cell forced-star propagation. Start from the per-cell
  // possible-star sets (perCell ∩ reachable ∩ mirror-component) and repeat:
  // if cell c has exactly one possible star X, X's mirror partner of c
  // must also be X (galaxies are mirror-symmetric). Intersect the mirror
  // cell's set to {X}, which may narrow further cells through subsequent
  // iterations. Catches cases the one-shot narrowing misses.
  const cellPossible = propagateForcedCells(grid, stars, rows, cols, seedOwner, reachable);

  const makeHint = (selected) => {
    const lines = cloneGalaxiesLines(current);
    for (const item of selected) lines[item.orientation][item.row][item.col] = 1;
    return {
      type: 'galaxies',
      orientation: selected[0].orientation,
      row: selected[0].row,
      col: selected[0].col,
      lines,
      lineHints: selected,
      count: selected.length
    };
  };

  const candidates = [];
  const addCandidate = (orientation, row, col, aCell, bCell) => {
    const aComp = components.get(grid[aCell.row]?.[aCell.col]);
    const bComp = components.get(grid[bCell.row]?.[bCell.col]);
    // cellPossible already absorbs perCell, reachable, and mirror-component
    // narrowing, plus the forced-mirror propagation loop. Use it as the
    // per-cell baseline.
    let aNodes = new Set(cellPossible.get(aCell.row + ',' + aCell.col) || []);
    let bNodes = new Set(cellPossible.get(bCell.row + ',' + bCell.col) || []);
    if (aComp?.possibleNodes?.size) aNodes = intersectSets(aNodes, aComp.possibleNodes);
    if (bComp?.possibleNodes?.size) bNodes = intersectSets(bNodes, bComp.possibleNodes);
    if (aNodes.size === 0 || bNodes.size === 0) return;
    if (setsIntersect(aNodes, bNodes)) return;
    const nodeIds = new Set([...aNodes, ...bNodes]);
    const score = (aComp?.cells.length || 1) + (bComp?.cells.length || 1);
    candidates.push({ orientation, row, col, nodeIds, currentIds: new Set([aComp?.id, bComp?.id]), score });
  };

  for (let r = 1; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (current.horizontal?.[r]?.[c] === 1) continue;
      addCandidate('horizontal', r, c, { row: r - 1, col: c }, { row: r, col: c });
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 1; c < cols; c++) {
      if (current.vertical?.[r]?.[c] === 1) continue;
      addCandidate('vertical', r, c, { row: r, col: c - 1 }, { row: r, col: c });
    }
  }
  if (candidates.length) {
    const nodeRegions = getGalaxiesNodeRegions(grid, stars);
    let bestNode = null;
    let bestNodeScore = -1;
    for (const node of nodeRegions) {
      const nodeCandidates = candidates.filter(c => c.nodeIds.has(node.index));
      if (!nodeCandidates.length) continue;
      const score = nodeCandidates.length * 10 + node.currentSize / 100;
      if (score > bestNodeScore) {
        bestNodeScore = score;
        bestNode = { ...node, candidates: nodeCandidates };
      }
    }
    const selected = bestNode ? bestNode.candidates : candidates;
    selected.sort((a, b) => b.score - a.score || a.row - b.row || a.col - b.col);
    return makeHint(selected.slice(0, Math.min(100, selected.length)));
  }

  const emptyHints = findEmptyCompHints(components, grid, stars, reachable);
  if (emptyHints) return makeHint(emptyHints);

  return null;
}

// Per-galaxy boundary-line path through a solver-produced solution. Lines are
// grouped by the galaxy id they belong to (each line borders one or two
// galaxies; both get the line). Galaxies are emitted smallest-first so the
// loop completes simple regions before tackling large ones — same order the
// heuristic itself prefers, which keeps the UX consistent across the
// heuristic→solver handoff.
//
// Memoized on the solution object via solution._galaxyPath so repeated
// Hint calls within a session don't re-walk the grid.
function getGalaxyPath(solution) {
  if (solution._galaxyPath) return solution._galaxyPath;
  const target = solution?.galaxies;
  const solGrid = solution?.grid || solution;
  if (!target || !Array.isArray(solGrid) || !solGrid[0]) return [];
  const rows = solGrid.length, cols = solGrid[0].length;

  const byGalaxy = new Map();
  const add = (id, line, key) => {
    if (!id) return;
    let g = byGalaxy.get(id);
    if (!g) { g = { lines: [], seen: new Set() }; byGalaxy.set(id, g); }
    if (g.seen.has(key)) return;
    g.seen.add(key);
    g.lines.push(line);
  };
  for (let r = 0; r < target.horizontal.length; r++) {
    const row = target.horizontal[r] || [];
    for (let c = 0; c < row.length; c++) {
      if (row[c] !== 1) continue;
      const line = { orientation: 'horizontal', row: r, col: c };
      const key = 'h:' + r + ':' + c;
      add(solGrid[r - 1]?.[c], line, key);
      add(solGrid[r]?.[c], line, key);
    }
  }
  for (let r = 0; r < target.vertical.length; r++) {
    const row = target.vertical[r] || [];
    for (let c = 0; c < row.length; c++) {
      if (row[c] !== 1) continue;
      const line = { orientation: 'vertical', row: r, col: c };
      const key = 'v:' + r + ':' + c;
      add(solGrid[r]?.[c - 1], line, key);
      add(solGrid[r]?.[c], line, key);
    }
  }

  const sizes = new Map();
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const id = solGrid[r][c];
    sizes.set(id, (sizes.get(id) || 0) + 1);
  }

  const path = [...byGalaxy.entries()]
    .map(([id, g]) => ({ id, size: sizes.get(id) || 0, lines: g.lines }))
    .sort((a, b) => a.size - b.size || a.id - b.id);

  solution._galaxyPath = path;
  return path;
}

// Hint built from the solver-derived path: emit the next galaxy's undrawn
// boundary lines (one galaxy per call). Returns null when every galaxy on
// the path is complete.
function nextGalaxyHint(grid, solution) {
  const current = grid?.galaxies;
  if (!current) return null;
  const path = getGalaxyPath(solution);
  for (const entry of path) {
    const undrawn = entry.lines.filter(l => current[l.orientation][l.row]?.[l.col] !== 1);
    if (!undrawn.length) continue;
    const lineHints = undrawn.map(lh => ({ ...lh, score: entry.size }));
    const lines = {
      horizontal: current.horizontal.map(row => row.slice()),
      vertical: current.vertical.map(row => row.slice()),
    };
    for (const lh of lineHints) lines[lh.orientation][lh.row][lh.col] = 1;
    return {
      type: 'galaxies',
      orientation: lineHints[0].orientation,
      row: lineHints[0].row,
      col: lineHints[0].col,
      lines,
      lineHints,
      count: lineHints.length,
    };
  }
  return null;
}

function firstGalaxiesMismatch(grid, solution) {
  const current = grid?.galaxies;
  const target = solution?.galaxies;
  if (!current || !target) return null;
  for (let r = 1; r < target.horizontal.length - 1; r++) {
    for (let c = 0; c < target.horizontal[r].length; c++) {
      if (current.horizontal?.[r]?.[c] === 1 && target.horizontal[r][c] !== 1) {
        return { orientation: 'horizontal', row: r, col: c };
      }
    }
  }
  for (let r = 0; r < target.vertical.length; r++) {
    for (let c = 1; c < target.vertical[r].length - 1; c++) {
      if (current.vertical?.[r]?.[c] === 1 && target.vertical[r][c] !== 1) {
        return { orientation: 'vertical', row: r, col: c };
      }
    }
  }
  return null;
}

function buildGalaxiesSeedOwner(stars, rows, cols) {
  const owner = new Map();
  for (let i = 0; i < stars.length; i++) {
    for (const cell of GalaxiesSolver.seedCellsForStar(stars[i], rows, cols)) {
      const key = cell.row + ',' + cell.col;
      owner.set(key, owner.has(key) ? -1 : i);
    }
  }
  return owner;
}

function getGalaxiesComponents(grid, stars, seedOwner) {
  const rows = grid.length;
  const cols = grid[0].length;
  const comps = new Map();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const id = grid[r][c];
      let comp = comps.get(id);
      if (!comp) {
        comp = { id, cells: [], seedNodes: new Set(), possibleNodes: new Set() };
        comps.set(id, comp);
      }
      comp.cells.push({ row: r, col: c });
      const owner = seedOwner.get(r + ',' + c);
      if (owner >= 0) comp.seedNodes.add(owner);
    }
  }
  for (const comp of comps.values()) {
    const candidates = comp.seedNodes.size === 1
      ? Array.from(comp.seedNodes)
      : stars.map((_, i) => i);
    for (const nodeIndex of candidates) {
      const star = stars[nodeIndex];
      // For star X to own this whole component, every cell must satisfy the
      // geometric check (mirror in bounds + seedOwner compatible) AND the
      // mirror of every cell must lie in the SAME line-bounded component.
      // Galaxies are connected, so a cell and its mirror-partner can't end
      // up on opposite sides of a drawn line.
      if (comp.cells.every(cell =>
        galaxyCellCanBelong(cell.row, cell.col, nodeIndex, stars, rows, cols, seedOwner)
        && grid[star.row - cell.row]?.[star.col - cell.col] === comp.id
      )) {
        comp.possibleNodes.add(nodeIndex);
      }
    }
  }
  return comps;
}

function galaxyCellCanBelong(row, col, nodeIndex, stars, rows, cols, seedOwner) {
  const star = stars[nodeIndex];
  const mr = star.row - row;
  const mc = star.col - col;
  if (mr < 0 || mc < 0 || mr >= rows || mc >= cols) return false;
  const ownerA = seedOwner.get(row + ',' + col);
  const ownerB = seedOwner.get(mr + ',' + mc);
  return (ownerA === undefined || ownerA === nodeIndex) &&
    (ownerB === undefined || ownerB === nodeIndex);
}

function possibleGalaxiesNodesForCell(row, col, stars, rows, cols, seedOwner) {
  const out = new Set();
  for (let i = 0; i < stars.length; i++) {
    if (galaxyCellCanBelong(row, col, i, stars, rows, cols, seedOwner)) out.add(i);
  }
  return out;
}

function computeReachableStars(stars, rows, cols, seedOwner, current) {
  const reachable = Array.from({ length: rows }, () => Array.from({ length: cols }, () => new Set()));
  for (let i = 0; i < stars.length; i++) {
    const seeds = GalaxiesSolver.seedCellsForStar(stars[i], rows, cols);
    const q = [];
    const seen = new Set();
    for (const seed of seeds) {
      const key = seed.row + ',' + seed.col;
      if (seed.row < 0 || seed.col < 0 || seed.row >= rows || seed.col >= cols || seen.has(key)) continue;
      if (!galaxyCellCanBelong(seed.row, seed.col, i, stars, rows, cols, seedOwner)) continue;
      seen.add(key);
      reachable[seed.row][seed.col].add(i);
      q.push({ row: seed.row, col: seed.col });
    }
    for (let qi = 0; qi < q.length; qi++) {
      const p = q[qi];
      for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nr = p.row + d[0], nc = p.col + d[1];
        const key = nr + ',' + nc;
        if (nr < 0 || nc < 0 || nr >= rows || nc >= cols || seen.has(key)) continue;
        if (d[0] === 1 && current.horizontal?.[nr]?.[nc] === 1) continue;
        if (d[0] === -1 && current.horizontal?.[p.row]?.[p.col] === 1) continue;
        if (d[1] === 1 && current.vertical?.[nr]?.[nc] === 1) continue;
        if (d[1] === -1 && current.vertical?.[p.row]?.[p.col] === 1) continue;
        if (!galaxyCellCanBelong(nr, nc, i, stars, rows, cols, seedOwner)) continue;
        seen.add(key);
        reachable[nr][nc].add(i);
        q.push({ row: nr, col: nc });
      }
    }
  }
  return reachable;
}

function intersectSets(a, b) {
  const out = new Set();
  for (const v of a) if (b.has(v)) out.add(v);
  return out;
}

// Drop stars X from `possibleSet` where the cell's mirror under X lives in
// a different line-bounded BFS component than the cell itself. Galaxies are
// connected within a single line-bounded region, so cell C and mirror(C, X)
// must share a component or X can't own C.
function narrowByMirrorComponent(cellRow, cellCol, possibleSet, stars, grid) {
  if (!possibleSet.size) return possibleSet;
  const cellComp = grid[cellRow]?.[cellCol];
  if (cellComp === undefined) return possibleSet;
  const out = new Set();
  for (const X of possibleSet) {
    const star = stars[X];
    if (grid[star.row - cellRow]?.[star.col - cellCol] === cellComp) out.add(X);
  }
  return out;
}

// Build per-cell possible-star sets, iteratively narrowed via mirror-forcing.
// Initial set = perCell ∩ reachable ∩ mirror-component. Then repeatedly:
// if a cell is forced (popcount 1) to star X, the mirror cell under X is
// also forced to X — intersect its set to {X}. Continues to fixed point.
// Catches forced-cell chains that the one-shot narrowing in addCandidate
// misses. Returns Map<'r,c', Set<starIndex>>.
function propagateForcedCells(grid, stars, rows, cols, seedOwner, reachable) {
  const possible = new Map();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const perCell = possibleGalaxiesNodesForCell(r, c, stars, rows, cols, seedOwner);
      const rch = reachable[r]?.[c] || new Set();
      let pos = intersectSets(perCell, rch);
      pos = narrowByMirrorComponent(r, c, pos, stars, grid);
      possible.set(r + ',' + c, pos);
    }
  }
  // Forced-mirror propagation. Bounded by total cells × stars; in practice
  // it converges in a handful of passes because each step strictly shrinks
  // the union of all sets.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [key, pos] of possible) {
      if (pos.size !== 1) continue;
      const X = pos.values().next().value;
      const star = stars[X];
      const [rs, cs] = key.split(',');
      const mr = star.row - +rs, mc = star.col - +cs;
      if (mr < 0 || mc < 0 || mr >= rows || mc >= cols) continue;
      const mirrorKey = mr + ',' + mc;
      const mirrorPos = possible.get(mirrorKey);
      if (!mirrorPos || mirrorPos.size === 1) continue;
      if (!mirrorPos.has(X)) continue; // contradiction; skip narrowing
      possible.set(mirrorKey, new Set([X]));
      changed = true;
    }
  }
  return possible;
}

function setsIntersect(a, b) {
  for (const v of a) if (b.has(v)) return true;
  return false;
}

function buildComponentAdjacency(grid, rows, cols, current) {
  const adj = new Map();
  const addEdge = (id1, id2) => {
    if (id1 === id2) return;
    if (!adj.has(id1)) adj.set(id1, new Set());
    if (!adj.has(id2)) adj.set(id2, new Set());
    adj.get(id1).add(id2);
    adj.get(id2).add(id1);
  };
  for (let r = 1; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (current.horizontal?.[r]?.[c] === 1) addEdge(grid[r - 1][c], grid[r][c]);
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 1; c < cols; c++) {
      if (current.vertical?.[r]?.[c] === 1) addEdge(grid[r][c - 1], grid[r][c]);
    }
  }
  return adj;
}

function propagateAllConstraints(components, grid, rows, cols, current, stars) {
  const adj = buildComponentAdjacency(grid, rows, cols, current);
  // NOTE: an earlier version eliminated a star from a component's possibleNodes
  // when certain[star] + comp.cells.length > Math.ceil(rows*cols / stars.length).
  // That bound is the AVERAGE galaxy size, not an upper bound — on puzzles with
  // variable galaxy sizes (e.g. the 30x30 monthly: max galaxy = 30 cells, average
  // = 5) it eliminates correct stars and produces phantom must-draw hints. The
  // elimination is unsound; soundness > pruning. Only the uniqueness rule below
  // (a forced star can't also be a neighbour's option) remains.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [, comp] of components) {
      if (comp.possibleNodes.size !== 1) continue;
      const forcedStar = comp.possibleNodes.values().next().value;
      const neighbors = adj.get(comp.id);
      if (!neighbors) continue;
      for (const nid of neighbors) {
        const nComp = components.get(nid);
        if (!nComp || !nComp.possibleNodes.has(forcedStar)) continue;
        nComp.possibleNodes.delete(forcedStar);
        changed = true;
      }
    }
  }
  // Touch unused params to keep them in the signature for the explicit
  // call contract (and silence the linter if it cares).
  void stars;
}

function bfsComponentSide(startRow, startCol, barrierOrient, barrierRow, barrierCol, grid, current) {
  const rows = grid.length, cols = grid[0].length;
  const visited = new Set();
  const q = [{ row: startRow, col: startCol }];
  const key = startRow + ',' + startCol;
  visited.add(key);
  for (let qi = 0; qi < q.length; qi++) {
    const { row, col } = q[qi];
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nr = row + dr, nc = col + dc;
      if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
      const nk = nr + ',' + nc;
      if (visited.has(nk)) continue;
      if (dr === 1 && barrierOrient === 'horizontal' && barrierRow === row + 1 && barrierCol === col) continue;
      if (dr === -1 && barrierOrient === 'horizontal' && barrierRow === row && barrierCol === col) continue;
      if (dc === 1 && barrierOrient === 'vertical' && barrierRow === row && barrierCol === col + 1) continue;
      if (dc === -1 && barrierOrient === 'vertical' && barrierRow === row && barrierCol === col) continue;
      if (dr === 1 && current.horizontal?.[row + 1]?.[col] === 1) continue;
      if (dr === -1 && current.horizontal?.[row]?.[col] === 1) continue;
      if (dc === 1 && current.vertical?.[row]?.[col + 1] === 1) continue;
      if (dc === -1 && current.vertical?.[row]?.[col] === 1) continue;
      if (grid[row][col] !== grid[nr][nc]) continue;
      visited.add(nk);
      q.push({ row: nr, col: nc });
    }
  }
  return visited;
}

function intersectBitset(cellKeys, bitsets) {
  let result = 0n;
  let first = true;
  for (const key of cellKeys) {
    const b = bitsets.get(key);
    if (!b) return 0n;
    if (first) { result = b; first = false; }
    else result &= b;
    if (!result) return 0n;
  }
  return result;
}

function findEmptyCompHints(components, grid, stars, reachable) {
  const current = grid?.galaxies;
  if (!current) return null;
  const rows = grid.length, cols = grid[0].length;
  const seedOwner = buildGalaxiesSeedOwner(stars, rows, cols);
  const emptyComps = [];
  for (const [, comp] of components) {
    if (!comp.possibleNodes.size && comp.cells.length > 10) emptyComps.push(comp);
  }
  if (!emptyComps.length) return null;

  const bitsets = new Map();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const perCell = possibleGalaxiesNodesForCell(r, c, stars, rows, cols, seedOwner);
      const rch = reachable[r]?.[c] || new Set();
      const nodes = intersectSets(perCell, rch);
      let bits = 0n;
      for (const s of nodes) bits |= (1n << BigInt(s));
      bitsets.set(r + ',' + c, bits);
    }
  }

  // Per-star seed cells, used by the closed-galaxy check below.
  const seedCellsByStar = stars.map(s => GalaxiesSolver.seedCellsForStar(s, rows, cols));

  const compCellSets = new Map();
  for (const comp of emptyComps) {
    const s = new Set();
    for (const cell of comp.cells) s.add(cell.row + ',' + cell.col);
    compCellSets.set(comp.id, s);
  }

  // Returns the index of a star X for which `sideCells` IS X's galaxy: X's
  // seed cells are entirely in sideCells, NO other star's seed cells are in
  // sideCells, and every cell in sideCells has its mirror under X also in
  // sideCells. These three conditions together are sufficient to conclude
  // that sideCells = galaxy(X) in the unique solution, so drawing a line
  // that isolates sideCells is sound even if the rest of the component has
  // no single-owner bitset yet.
  // Returns -1 if no such star.
  const closedGalaxyOwner = (sideCells, sideBits) => {
    if (!sideBits) return -1;
    starLoop: for (let i = 0; i < stars.length; i++) {
      if (!(sideBits & (1n << BigInt(i)))) continue;
      for (const s of seedCellsByStar[i]) {
        if (!sideCells.has(s.row + ',' + s.col)) continue starLoop;
      }
      for (let j = 0; j < stars.length; j++) {
        if (j === i) continue;
        for (const s of seedCellsByStar[j]) {
          if (sideCells.has(s.row + ',' + s.col)) continue starLoop;
        }
      }
      const star = stars[i];
      for (const key of sideCells) {
        const [r, c] = key.split(',');
        const mr = star.row - +r, mc = star.col - +c;
        if (mr < 0 || mc < 0 || mr >= rows || mc >= cols || !sideCells.has(mr + ',' + mc)) continue starLoop;
      }
      return i;
    }
    return -1;
  };

  const hints = [];
  const tried = new Set();
  const process = (orientation, row, col, aId, bId) => {
    if (aId !== bId) return;
    const comp = components.get(aId);
    if (!comp || comp.possibleNodes.size || comp.cells.length <= 10) return;
    const tKey = orientation + ':' + row + ':' + col;
    if (tried.has(tKey)) return;
    tried.add(tKey);
    const aCell = orientation === 'horizontal' ? { row: row - 1, col } : { row, col: col - 1 };
    const sideA = bfsComponentSide(aCell.row, aCell.col, orientation, row, col, grid, current);
    if (sideA.size === comp.cells.length || sideA.size === 0) return;
    const compSet = compCellSets.get(comp.id);
    if (!compSet) return;
    const sideBkeys = [];
    for (const key of compSet) if (!sideA.has(key)) sideBkeys.push(key);
    if (!sideBkeys.length) return;
    const aBits = intersectBitset(sideA, bitsets);
    const bBits = intersectBitset(sideBkeys, bitsets);
    // Acceptance criteria — both are sound:
    //   1. Both sides have a candidate star (the original check; covers
    //      "split into two parts that can each become galaxies later").
    //   2. One side is a closed galaxy for a specific star X (catches
    //      isolate-the-final-galaxy cases where the other side is a big
    //      messy remainder, e.g. the 30x30 monthly at step ~95).
    // The earlier 'aBits || bBits' version was unsound — it accepted splits
    // that stranded a side with no possible owner. The new criterion 2
    // proves a specific owner exists, so it doesn't strand anything.
    if (aBits && bBits) {
      hints.push({ orientation, row, col, score: sideA.size + sideBkeys.length });
      return;
    }
    const sideBSet = new Set(sideBkeys);
    if (closedGalaxyOwner(sideA, aBits) >= 0 || closedGalaxyOwner(sideBSet, bBits) >= 0) {
      hints.push({ orientation, row, col, score: sideA.size + sideBkeys.length });
    }
  };

  for (let r = 1; r < rows; r++)
    for (let c = 0; c < cols; c++)
      if (current.horizontal?.[r]?.[c] !== 1) process('horizontal', r, c, grid[r - 1][c], grid[r][c]);
  for (let r = 0; r < rows; r++)
    for (let c = 1; c < cols; c++)
      if (current.vertical?.[r]?.[c] !== 1) process('vertical', r, c, grid[r][c - 1], grid[r][c]);
  if (!hints.length) return null;
  hints.sort((a, b) => b.score - a.score || a.row - b.row || a.col - b.col);
  return hints.slice(0, Math.min(100, hints.length));
}

function getGalaxiesNodeRegions(grid, stars) {
  const sizes = new Map();
  for (const row of grid || []) {
    for (const id of row || []) sizes.set(id, (sizes.get(id) || 0) + 1);
  }
  return (stars || []).map((star, index) => {
    const currentIds = new Set();
    for (const cell of GalaxiesSolver.seedCellsForStar(star, grid.length, grid[0]?.length || 0)) {
      const id = grid[cell.row]?.[cell.col];
      if (id) currentIds.add(id);
    }
    let currentSize = 0;
    for (const id of currentIds) currentSize += sizes.get(id) || 0;
    return { index, currentIds, currentSize };
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    cloneGalaxiesLines, getGalaxiesHint, getGalaxyPath, nextGalaxyHint,
    firstGalaxiesMismatch, buildGalaxiesSeedOwner, getGalaxiesComponents,
    galaxyCellCanBelong, possibleGalaxiesNodesForCell,
    computeReachableStars, intersectSets, narrowByMirrorComponent,
    propagateForcedCells, setsIntersect, buildComponentAdjacency,
    propagateAllConstraints, bfsComponentSide, intersectBitset,
    findEmptyCompHints, getGalaxiesNodeRegions,
  };
}
