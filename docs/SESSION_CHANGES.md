# Session Progress & Fixes

## Aquarium Solver Fixes (solver.js)

All fixes in `_propagate()` method:

1. **Swapped mn/mx in otherLo/otherHi** (lines 1281-1282, 1301-1302)
   - Was: otherLo = rowLo - contribs[mx] (subtracting max for "others at minimum")
   - Now: otherLo = rowLo - contribs[mn] (subtracting min for "others at minimum")
   - Was: otherHi = rowHi - contribs[mn] (subtracting min for "others at maximum")
   - Now: otherHi = rowHi - contribs[mx] (subtracting max for "others at maximum")
   - Old code was over-conservative, missing narrowing opportunities

2. **avail < 0 -> avail <= 0** (lines 1284, 1304)
   - When avail == 0, only c=0 is valid (contributions are non-negative)
   - Old code skipped this case, missing narrowing

3. **Added || 0 to c and ccv** (lines 1287, 1307)
   - aq.contribs[l].rc[r] can be undefined when aquarium doesn't contribute to this row
   - undefined >= needed evaluates to false, incorrectly excluding valid levels
   - c = aq.contribs[l].rc[r] || 0 fixes the comparison

4. **Range intersection instead of replacement** (lines 1293-1299)
   - Each row/col propagation was REPLACING d[aq.id] instead of INTERSECTING
   - Now uses Math.max(current, new) and Math.min(current, new)
   - Prevents later rows from overwriting earlier rows' narrowing

5. **DP guard** (lines 1149-1157)
   - _dpPairwise can partially modify ranges then return false on inconsistency
   - If _propagate returns false after DP, restore all state and re-propagate from scratch

6. **Search budget** (line 1104)
   - _maxSearchNodes: 10000 to 50000

7. **Error reporting** (line 1178, 2006)
   - _withPartial defaults error to 'no solution found'
   - _backtrack nogood hit returns 'contradiction' error

## Galaxies Hint Fixes (content.js)

1. **findEmptyCompHints wired in** (line 224)
   - Function existed but was never called
   - Now called after regular candidates, before transitive hints

2. **aBits || bBits fix** (line 580)
   - Was: aBits && bBits (required BOTH sides of split to have valid star)
   - Now: aBits || bBits (either side works; other side gets further splits)

## Loop / Hint Flow Changes (content.js)

1. **Loop handler** reimplemented:
   - Click Loop -> compute hint -> show preview -> button says "Confirm"
   - Click Confirm -> apply hint -> auto-loop starts (button "Stop")
   - Auto-loop: get hint -> apply -> 300ms delay -> repeat
   - Click Stop to interrupt

2. **Hint and Loop buttons** independent:
   - Hint: single hint -> Apply button
   - Loop: hint preview -> Confirm -> auto-loop

3. **Unified hint status text** (hintStatusText helper at line 1125)
   - Same format across Hint, Loop first-click, and Loop auto-loop

## Timer Fix (background.js + content.js)

- Added fixGameTimer() in background.js (line 426): restores elapsed time from localStorage, startTime, or accumulated; clears DNF flags; sets currentState.solvedTime; forces DOM timer elements; triggers Game.check for server submission
- Added "Fix Timer" button in widget (data-action="fixTimer")
- Added timerFixHandler in content.js (line 1874)

## UI Changes (content.js)

- Widget restricted to supported puzzle paths via shouldShowWidget
- "Solve failed" now includes error message from solver
- Console diagnostics on solver failure ([AquariumSolver] logs)
