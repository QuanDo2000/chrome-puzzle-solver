# Solvers (solver.js)

Three solver classes sharing a common interface: constructor, solve(initialGrid), getHint(currentGrid).

## NonogramSolver (lines 1-365)

Standard backtracking line solver.

**Constructor**: rowClues, colClues. Sets maxIterations=1000, maxFrontier, maxMs.

**solve(initialGrid)**: Applies initial grid, propagates, backtracks. Respects time/frontier limits. Returns partial grid on failure.

**propagate()**: Iterative constraint propagation. For each dirty row/col, calls solveLine which runs a DP to find forced cells (must fill, must cross).

**backtrack(depth)**: Picks most-constrained unknown cell, guesses 1 then -1, propagates, recurses.

**getHint(grid)**: Scans all rows/cols with solveLine, returns the line with most newly-forced cells.

---

## GalaxiesSolver (lines 367-1047)

Cell-backtracking solver for Galaxies/Tentai Show puzzles. Each cell is assigned to a star; regions must be 180-degree rotationally symmetric.

**Constructor**: stars, rows, cols. Builds staticCandidates (per-cell possible stars via symmetry). Has solution cache, partial/frontier caching for incremental solving.

**solve(initialGrid, options)**: Tries exact-cover for small grids (< 20x20). Otherwise processes frontier from previous runs, then _search.

**_search(grid, checkStars)**: DFS propagation + backtracking with star-based candidate set. Assigns cell+mirror pairs. Checks dead cache, pushes frontier branches.

**Large board handling** (>= 400 cells): 8-second budget, persists partial + frontier for retry.

### Galaxies Data Model
- Internal grid: -1 (unassigned), 0..n (star index + 1 for assigned)
- Output grid: 1..n+1 with .galaxies horizontal/vertical boundary arrays
- Lines format: horizontal[row+1][col] and vertical[row][col+1]

---

## AquariumSolver (lines 1049-2212)

See AQUARIUM_SOLVER.md for full details.

### Aquarium Data Model
- waterLevel[aqId]: -1 (unassigned) or 0..maxLvl (water fills from bottom)
- d[aqId] = { mn, mx }: min/max possible water level
- _kc: Int8Array flat grid of known cells (0=unknown, 1=water, -1=air)

### Solve Pipeline
1. _initRange (known cells narrow initial ranges)
2. _propagate (constraint propagation)
3. _dpPreprocess + _dpPairwise (DP narrowing, with guard)
4. _solveRepair (stochastic min-conflicts)
5. _backtrack (DFS with nogood/dead-cache/DP)

### Hint Pipeline
1. _findForcedCells (propagation-based forced cells)
2. Row/col completion (clue met or deficit exact)
