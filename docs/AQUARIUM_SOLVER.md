# AquariumSolver (solver.js lines 1049-2212)

## Data Model

Each aquarium from regionMap is modeled as:
- id: region ID
- groups: [{ row, count, cells }] sorted by row (bottom = lowest index)
- maxLvl: number of groups (= height in rows)
- contribs: [{ rc: {}, cc: {} }] length = maxLvl+1; per-row/col water counts per level
- tRows, tCols: set of rows/cols this aquarium touches

Key state:
- waterLevel[aqId]: -1 (unassigned) or 0..maxLvl (water fills from bottom)
- d[aqId] = { mn, mx }: min/max possible water level
- _kc: Int8Array of known cells (0=unknown, 1=water, -1=air)

## Solve Flow (line 1121)

_initRange > _propagate > _rememberPartial
  (if not all assigned)
_dpPreprocess > _dpPairwise > _propagate > _rememberPartial
  (DP guard: if _propagate fails, restore pre-DP state and re-propagate)
  (if not all assigned)
_solveRepair (stochastic local search, 80 restarts x 12000 steps)
  (if repair fails)
_backtrack (DFS with nogood learning, dead-state cache, DP pruning, 50000 node limit)
_withPartial (returns best partial grid on failure)

## Key Methods

### _propagate() (line 1252)
Constraint propagation. Iterates up to 100 times:
1. Compute base row/col contributions from assigned aquariums
2. For each unassigned aquarium and each row/col:
   - otherLo = other aquariums at minimum
   - otherHi = other aquariums at maximum
   - needed = how much this aquarium MUST contribute
   - avail = how much this aquarium CAN contribute at most
   - Narrow mn/mx to levels satisfying both bounds
   - INTERSECT (not replace) new ranges with current ranges
3. Auto-assign singletons (mn == mx)

### _dpPreprocess() (line 1375)
1D DP for each row and column. Forward DP computes reachable clue sums. Backward pass narrows per-aquarium ranges. Cached. Up to 5 passes.

### _dpPairwise() (line 1505)
2D DP for adjacent row/column pairs. Forward+backward DP to find level combinations satisfying both clues. Narrows per-variable mn/mx. Results cached.

### _solveRepair() (line 1895)
Stochastic min-conflicts: random assignment within [mn,mx], then greedy improvement (pick worst row/col, find best level change). 5% random moves. Returns on zero violations.

### _backtrack() (line 2018)
DFS with _levelOrder branching (lo, hi, lo+1, hi-1, ...). Picks most-constrained variable. Checks dead-cache and nogood-set. Calls _propagate, _dpPreprocess, _dpPairwise at each node.

### getHint() (line 2155)
1. _findForcedCells: creates temp solver, propagates, identifies cells forced by narrowed ranges
2. Row/col completion: filled==clue means remaining must be empty; clue-filled==empty_count means remaining must be filled

## Propagation Fixes Made

| Line(s) | Fix |
|---------|-----|
| 1281-1282, 1301-1302 | Swapped mn/mx in otherLo/otherHi (was subtracting max for min bound) |
| 1284, 1304 | avail < 0 to avail <= 0 (zero-avail case was skipped) |
| 1287, 1307 | Added || 0 to c/ccv (undefined contributions broke comparisons) |
| 1293-1299 | Row/col ranges now INTERSECT (Math.max/min) instead of overwriting |
| 1149-1157 | DP guard: if _propagate fails after DP, restore state and re-propagate |
| 1104 | _maxSearchNodes: 10000 to 50000 |
