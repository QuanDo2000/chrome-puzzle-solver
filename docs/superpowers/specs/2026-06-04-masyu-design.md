# Masyu puzzle support — design

**Status:** approved (brainstorm)
**Date:** 2026-06-04
**Site:** puzzles-mobile.com `/masyu/` (slug `masyu`).

## Summary

Add full Masyu support (Detect / Solve / Hint / Loop), wired like the other 19
puzzles and mirroring the Slitherlink/Shingoki loop infrastructure. Masyu is a
single-closed-loop puzzle whose loop runs through **cell centres**; white and
black pearls constrain how the loop passes through their cells. The solver ports
the page `getErrors` as its validity oracle, propagates the pearl + loop rules,
DFS-searches with connectivity pruning, and returns a sound partial on timeout.
User decision: **push for a full 25×25 solve, with a guaranteed sound-partial
floor**; measure and report the real board honestly.

## Recon: the page encoding (ground truth, from `window.Game`)

### `task[r][c]` (givens), `puzzleHeight × puzzleWidth`
- `"W"` = white pearl · `"B"` = black pearl · `-1` = empty (no pearl). 25×25.

### Loop edges live in `currentState` (cell-centre topology — confirmed by dims)
- `cellHorizontalStatus`: **`rows × (cols−1)`** = 25×24. `H[r][c]` connects cell
  `(r,c)` ↔ `(r,c+1)`.
- `cellVerticalStatus`: **`(rows−1) × cols`** = 24×25. `V[r][c]` connects cell
  `(r,c)` ↔ `(r+1,c)`.
- Edge tri-state: `0` unknown · `1` line · `2` cross. (Confirmed: `getMarkedCount`
  treats `==1` as a line; `taskXCount` treats `==2` as a cross.)
- A cell `(r,c)`'s four incident edges: `left=H[r][c−1]`, `right=H[r][c]`,
  `top=V[r−1][c]`, `bottom=V[r][c]` (border cells have fewer).

### Validity rules (decoded from `getErrors`; verbatim source in the plan Appendix)
`getErrors(t)` (t = full-check flag) iterates every cell and enforces:
- **Single closed loop:** at each cell, count incident line-edges `h`. `h>2` →
  `"branch"`; `h==1` → `"loseend"`; all line-edges must form ONE connected
  component (`getLineRecursion` trace; a second component → `"2lines"`). The loop
  need NOT cover every cell (empty cells may have `h==0`).
- **White pearl** (`"taskViolationWhite"`): the loop must go **straight through**
  — error if it turns at the pearl (any horizontal-edge AND vertical-edge both
  present); AND it must **turn in ≥1 adjacent cell** — error if 4 collinear edges
  run centred on the pearl (`H[r][l−2]&H[r][l−1]&H[r][l]&H[r][l+1]`, or the
  vertical equivalent).
- **Black pearl** (`"taskViolationBlack"`): the loop must **turn at** the pearl —
  error if it goes straight through (`H[r][l]&H[r][l−1]` or `V[r][l]&V[r−1][l]`);
  AND **both arms continue straight** one cell — error if an arm turns in the
  immediately adjacent cell (the 8-condition block).
- Every pearl is **on the loop** — error if a pearl cell has 0 incident line-edges.

## Architecture & files

Mirrors the established puzzle-addition shape; no changes to existing puzzles.

**New**
- `src/solvers/masyu.js` — `MasyuSolver` (pure logic): ported oracle + propagation
  + DFS + connectivity; returns `{ solved, horizontal, vertical, partial?, error? }`
  (edge tri-state; `horizontal` `rows×(cols−1)`, `vertical` `(rows−1)×cols`).
- `src/widget/puzzles/masyu.js` — registry module (cacheKey, canvasDims, staticSig,
  drawStaticLayer for pearls, solveExtraData, solutionFromResult, hintDispatch,
  loopDoneCheck, applyHint, partialResultArm).
- `tests/masyu.test.js` (oracle + brute-force soundness gate + solve), a
  `masyu_25x25` fixture in `tests/fixtures/real-puzzles.js`, `tests/bench-masyu.js`.

**Modified (standard wiring touchpoints)**
- `solver.worker.js` — `else if (type === 'masyu')` dispatch (`maxMs:30000`).
- `scripts/build-solver-bundle.js` — `masyu.js` in FILES, `MasyuSolver` in EXPORTS.
- `scripts/build-content-bundle.js` — `puzzles/masyu.js` in WIDGET_FILES (before
  `puzzles/index.js`).
- `handler.js` — `masyuHandler` (matches `/masyu/`; detect/readState/applySolution)
  + `registerHandler`.
- `main-world.js` — `readMasyuData` / `readMasyuState` / `applyMasyuState` +
  `/masyu/` dump branch.
- `background.js` — three names in `EXEC_MAIN_ALLOWLIST`; `globals.d.ts` —
  `MasyuSolver` decl + three `MainWorldFn` entries; `eslint.config.js` —
  `MasyuSolver`/`masyu` readonly globals.
- `src/widget/puzzles/index.js` — register `masyu`.
- `src/widget/preview.js` — Masyu edge-drawing arm (cell-centre geometry) + Masyu
  mistake-stroke case; `src/solvers/diff.js` — register `masyu` to reuse the
  generic edge-diff (`_slitherlinkDiff`).

## Solver model & method

**Edge representation:** `H` (`rows×(cols−1)`), `V` (`(rows−1)×cols)`, tri-state
`0/1/2`. Bounds-safe `_line(r,c,type)` returns whether that edge is a line (false
out of range).

**Oracle `_isValid(H,V)`** — the page `getErrors` ported to pure logic:
(1) every cell degree 0 or 2; (2) all line-edges form ONE connected cycle (no
sub-loops); (3) white pearl straight-through + turn in ≥1 adjacent cell; (4) black
pearl turn + both arms straight one cell; (5) every pearl on the loop. This is the
spec and the soundness ground-truth.

**Propagation (sound, to a fixpoint):**
- **Degree 0/2:** a 2nd incident line forces the rest cross; a single line with one
  undecided edge left forces it line; a pearl (degree-2 required) with one line
  forces a second; over-degree / under-capacity → contradiction.
- **White-pearl forcing:** no turn at the pearl — any incident line forces its
  collinear partner line and the perpendicular pair cross; the adjacent-turn rule
  prunes the straight-for-4 continuation.
- **Black-pearl forcing:** must turn (opposite-edge pairs can't both be line); each
  chosen arm forces the next cell straight (the strong rule; border black pearls
  fix orientation for lack of straight room).
- **Connectivity:** union-find over line-edges forbids closing a premature
  sub-loop (the Slitherlink technique).

**Search + partial:** DFS over undecided edges (branch line-first, propagate,
snapshot/trail undo) under `maxMs`, with connectivity pruning. On timeout return
the **sound root-propagation snapshot** (forced edges; undecided left `0`) — never
speculative mid-search state.

**Soundness gate:** brute-force all edge assignments on tiny hand-built boards
(2^edges), keep those passing `_isValid`, and assert: propagation never prunes a
value some solution uses; solver-solved ⟺ brute-force-nonempty; every forced edge
holds in all solutions; `solve()` output always passes the oracle. (Each tiny board
verified satisfiable with a throwaway run before the plan ships.)

## Widget integration

- **Detect/Solve:** handler matches `/masyu/`; `readMasyuData` → `{rows,cols,task}`;
  worker `MasyuSolver`; preview → `applyMasyuState`.
- **MAIN-world** (mirrors `applyShingokiState`): `readMasyuState(rows,cols)` →
  `{horizontal,vertical}`; `applyMasyuState`: `saveState(true)` before, write edges
  `1→1/2→2/else 0`, `currentState.solved=false`, render ladder after, never
  `check()`; self-contained for MV3 serialization. Plus `/masyu/` dump branch.
- **Preview (cell-centre geometry):** pearls on the STATIC layer at cell centres
  `((c+0.5)·cs,(r+0.5)·cs)` — white ring, black disc (radius ≈ cs/3). Loop line-edges
  on the DYNAMIC layer between centres: `H[r][c]` centre(r,c)→centre(r,c+1),
  `V[r][c]` centre(r,c)→centre(r+1,c); cross marks at edge midpoints.
  `canvasDims marginCells: 0`. Mistakes: a Masyu case strokes the disagreeing edge
  red between centres; `computePuzzleDiff` registers `masyu` to reuse
  `_slitherlinkDiff`.
- **Hint/Loop:** `hintDispatch` runs propagation against the live board edges and
  returns the next batch of forced line-edges; falls back to revealing the next
  batch of cached-solution line-edges (so NOT `skipAutoSolveGate`). Batch-capped
  (≤ ~30 clicks). `applyHint` overlays ONLY the hinted line-edges (no full edge-set
  — no over-commit). `loopDoneCheck` true when every solution line-edge is on board.

## Testing & verification

- **Oracle units:** white-pearl (straight + adjacent-turn), black-pearl (turn +
  straight-continuation), degree-0/2, single-loop vs two-loops.
- **Brute-force soundness gate (the gate):** as above, on tiny boards.
- **Fixtures:** real `masyu_25x25` capture; small hand-built unique boards.
- **Performance:** bench the real 25×25; report full-solve vs sound partial honestly.
  Lint/typecheck/build gated.

## Open items (non-blockers, resolved at live-verify)

- Pearl glyph style (ring/disc radius + stroke) on the live page.
- Confirm the page accepts an applied edge-set (`cellHorizontalStatus`/
  `cellVerticalStatus`) as a solve.

## Out of scope (YAGNI)

- Any change to other puzzles / shared infra beyond the registry/allowlist/preview
  additions.
- Variants/sizes not served by `/masyu/`.
- Changing the ported oracle (it is the spec).
