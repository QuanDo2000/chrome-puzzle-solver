# Shingoki Candidate-Strengthening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Raise the Shingoki solver's root deductive reach by dropping per-clue candidate configurations that are impossible due to the clues the candidate's straight runs pass through, shrinking the search and giving 25×25 a real shot.

**Architecture:** Extend `clueCandidates`/`_buildCandidate` (the per-clue candidate model from the deduction work) with two SOUND intermediate-clue drop-rules. No new methods, no architecture change.

**Builds on:** `docs/superpowers/specs/2026-06-02-shingoki-stronger-deduction-design.md` (which listed this as an optional follow-up) and the implemented `clueCandidates`/`_buildCandidate`/`_candidateIntersectForce` (commit `8811d675`).

**IMPORTANT — `jj`, NEVER `git`.** Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## THE SOUNDNESS PRINCIPLE (unchanged, critical)

Dropping a candidate is SOUND only if the candidate is DEFINITELY impossible. The intersection forces edges common to all SURVIVING candidates, so dropping a still-possible candidate (under-approximation) can force a wrong edge. The two new drop-rules below are sound because a vertex strictly INSIDE a candidate's run is passed straight through (the run is the maximal straight segment — both ends are CROSS-capped), which is an unambiguous fact about that candidate. The brute-force oracle (`assertForceSoundness`) is the gate: it catches any wrongly-dropped candidate (it would surface as a wrongly-forced edge). **Oracle test boards must be satisfiable** (verify `bruteForceSolutions(...).length >= 2`); the plan's literal numbers are illustrative — fix if unsat (a black clue's number = sum of both straight runs).

## The two drop-rules

A candidate's run from the clue (r,c) in direction (dr,dc) for `len` edges passes straight through the INTERMEDIATE vertices `v_i = (r+i·dr, c+i·dc)` for `i = 1..len-1` (NOT the clue itself, NOT the turn/end vertex `v_len`). For each intermediate clued vertex:

1. **Black intermediate → drop.** A black clue must TURN; it cannot lie on a straight pass. The candidate is impossible.
2. **White intermediate with wrong number → drop.** A white clue's number = the length of the straight segment it sits on. The candidate places this intermediate white clue on the run's straight segment, so its number must equal that segment's length (`segLen`). A different number → impossible.

`segLen` (the straight-segment length the arm belongs to):
- **White candidate:** both arms are the SAME collinear segment of length `N` (the clue number). `segLen = N` for both arms.
- **Black candidate:** the two arms are PERPENDICULAR, hence different segments; each arm is its own segment. `segLen = ` that arm's own `len`.

---

### Task 1: Intermediate-clue consistency in `_buildCandidate`

**Files:**
- Modify: `src/solvers/shingoki.js` (`_buildCandidate`, and the `clueCandidates` callers to pass `segLen`)
- Test: `tests/shingoki.test.js`

- [ ] **Step 1: Write the failing tests**

```js
test('Shingoki candidates: drops a config whose straight run passes through a black clue', () => {
  // White clue n=4 at (0,2) on a 1-row strip; horizontal axis. A black clue at an
  // INTERMEDIATE vertex of the horizontal run must kill the horizontal candidates,
  // leaving only vertical (which is infeasible on a 1-row strip) -> contradiction
  // OR forcing. Simpler: assert clueCandidates excludes a config crossing a black.
  const task = [[0,0,4,0,0],[0,0,0,0,0]];      // white n=4 at (0,2)
  const s = new ShingokiSolver({ rows: 1, cols: 4, task });
  s._initState();
  // Put a black clue at intermediate (0,1): a horizontal run through (0,1) passes
  // straight through it, which a black clue forbids.
  s.task[0][1] = -2;
  const cands = s.clueCandidates(0, 2);
  // No surviving candidate may have H(0,0) AND H(0,1) both LINE going left through
  // the black at (0,1) as a straight pass... assert every candidate that includes
  // H(0,1) as LINE is gone (the left-horizontal run through the black is dropped).
  for (const cand of cands) {
    if (cand.line.has(s._edgeKey('H', 0, 1)) && cand.line.has(s._edgeKey('H', 0, 0))) {
      assert.fail('a horizontal run straight through the black clue at (0,1) survived');
    }
  }
});

test('Shingoki candidates: drops a config whose run passes through a white clue of a different number', () => {
  // White clue n=4 at (0,2); a white clue n=2 at intermediate (0,1). A horizontal
  // run that puts both on the same length-4 segment is impossible (intermediate
  // white must read 4, not 2). The left-through-(0,1) horizontal candidate drops.
  const task = [[0,2,4,0,0],[0,0,0,0,0]];
  const s = new ShingokiSolver({ rows: 1, cols: 4, task });
  s._initState();
  const cands = s.clueCandidates(0, 2);
  for (const cand of cands) {
    if (cand.line.has(s._edgeKey('H', 0, 1)) && cand.line.has(s._edgeKey('H', 0, 0))) {
      assert.fail('a horizontal run through the inconsistent white clue survived');
    }
  }
});

test('Shingoki candidates: KEEPS a config through a white clue with the matching number', () => {
  // White n=4 at (0,2); white n=4 at intermediate (0,1) — consistent, must survive.
  const task = [[0,4,4,0,0],[0,0,0,0,0]];
  const s = new ShingokiSolver({ rows: 1, cols: 4, task });
  s._initState();
  const cands = s.clueCandidates(0, 2);
  const survives = cands.some(cand => cand.line.has(s._edgeKey('H', 0, 1)) && cand.line.has(s._edgeKey('H', 0, 0)));
  assert.ok(survives, 'a consistent same-number white intermediate must NOT be dropped');
});

test('Shingoki candidates: strengthened force-soundness vs the oracle (multi-clue boards)', () => {
  // Boards with clues that lie on shared lines (so the new rules actually fire).
  // VERIFY each is satisfiable with >=2 solutions before trusting (fix numbers if not).
  const boards = [
    { rows: 3, cols: 3, task: [[-4,0,0,-4],[0,0,0,0],[0,0,0,0],[-4,0,0,-4]] },
    { rows: 4, cols: 4, task: [[-3,0,0,0,-3],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[-3,0,0,0,-3]] },
    { rows: 4, cols: 4, task: [[0,0,4,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,0,0,0],[0,0,4,0,0]] },
  ];
  for (const b of boards) {
    assert.ok(bruteForceSolutions(b.rows, b.cols, b.task).length >= 1, 'board must be satisfiable');
    assertForceSoundness(b.rows, b.cols, b.task, (s) => s._candidateIntersectForce(), { trials: 80 });
  }
});
```

- [ ] **Step 2: Run → FAIL / or the soundness test may pass trivially** (`node --test --test-name-pattern='candidates: drops|KEEPS|strengthened' tests/shingoki.test.js`). The two "drops" tests fail (the runs aren't dropped yet). VERIFY each oracle board is satisfiable first; fix numbers if `bruteForceSolutions` returns [].

- [ ] **Step 3: Implement the intermediate check in `_buildCandidate`**

Add the intermediate-vertex scan inside the arm loop, and `segLen` to the arm specs. Replace `_buildCandidate`:

```js
  _buildCandidate(r, c, arms, perpCrossAtCentre) {
    const line = new Set(), cross = new Set();
    const addLine = (e) => { if (this.getEdge(e) === 2) return false; line.add(this._edgeKey(e.kind, e.r, e.c)); return true; };
    const addCross = (e) => { if (this.getEdge(e) === 1) return false; cross.add(this._edgeKey(e.kind, e.r, e.c)); return true; };
    for (const arm of arms) {
      const run = this._runEdges(r, c, arm.dr, arm.dc, arm.len);
      if (!run) return null;                       // off-board -> impossible
      for (const e of run.edges) if (!addLine(e)) return null;
      // Intermediate-clue consistency: vertices strictly inside the run (i=1..len-1)
      // are passed straight through. A black clue there is impossible; a white clue
      // must share this segment's length (arm.segLen).
      for (let i = 1; i < arm.len; i++) {
        const ir = r + i * arm.dr, ic = c + i * arm.dc;
        const ivClue = ShingokiSolver.decodeClue(this.task[ir][ic]);
        if (!ivClue) continue;
        if (ivClue.color === 'black') return null;          // can't turn on a straight pass
        if (ivClue.n !== arm.segLen) return null;           // same segment -> same number
      }
      const cap = this._capEdge(run.endR, run.endC, arm.dr, arm.dc);
      if (cap && !addCross(cap)) return null;       // run must stop -> cap is CROSS
    }
    for (const e of perpCrossAtCentre) if (!addCross(e)) return null;
    return { line, cross };
  }
```

Update the `clueCandidates` arm specs to include `segLen`:
- White (both blocks): `[{ dr: ..., dc: ..., len: a, segLen: N }, { dr: ..., dc: ..., len: N - a, segLen: N }]`
- Black: `[{ dr: h.dr, dc: h.dc, len: a, segLen: a }, { dr: v.dr, dc: v.dc, len: N - a, segLen: N - a }]`

(Find the four `_buildCandidate(...)` call sites in `clueCandidates` and add `segLen` to each arm object. White H-axis arms both `segLen: N`; white V-axis arms both `segLen: N`; black arms get their own `len` as `segLen`.)

- [ ] **Step 4: Run the technique tests → PASS**

Run: `node --test --test-name-pattern='candidates: drops|KEEPS|strengthened' tests/shingoki.test.js`
Expected: drops tests pass (runs dropped), KEEPS test passes (consistent survives), oracle soundness passes. **If the oracle soundness test FAILS, a drop-rule is wrong (under-approximating)** — re-check: is the `segLen` correct (white=N, black=arm len)? Is the intermediate range right (i=1..len-1, excluding the clue and the end)? Do NOT weaken the oracle test.

- [ ] **Step 5: Full suite + fuzz + MEASURE**

Run: `npm test` → 0 fail (fuzz + all oracle tests green = still sound).
MEASURE (throwaway script; delete after): root-deduction reach (`s._initState(); s._deduceAll(0)`; count non-zero edges) AND full solve() on shingoki_7x7/10x10/15x15/25x25_hard (searchMs:30000, maxMs:60000 — give 15x15/25x25 a large budget to see if the higher reach now solves them). Report reach (det/total) BEFORE vs AFTER this change + solved/partial + wall-time. The question: did root reach rise on 15x15/25x25, and does 25x25 now solve (or 15x15 get faster)?

- [ ] **Step 6: Commit**

```bash
jj commit -m "feat(shingoki): candidate-strengthening — intermediate-clue consistency

Drop per-clue candidates whose straight run passes through a black clue
(can't turn) or a white clue of a different number (same segment -> same
number). Sound (drops only definitely-impossible configs), oracle-gated.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: docs + build (after measuring)

**Files:** `src/solvers/shingoki.js` (header), `CLAUDE.md`, build.

- [ ] **Step 1:** Update the solver module header + CLAUDE.md Shingoki note with the new measured outcome (reach + which sizes solve), honestly. If 25×25 now solves, say so; if not, keep it as a sound-partial limit.
- [ ] **Step 2:** `npm run build` (solver.js changed) → no bundler errors.
- [ ] **Step 3:** `npm test && npm run lint && npm run typecheck` → all green.
- [ ] **Step 4:** Commit: `docs+build(shingoki): candidate-strengthening outcome + rebuild dist`.

## Conditional follow-ups (only if 25×25 still doesn't solve, controller's call)

- **Turn/end-vertex rules:** a run's turn (end) vertex can't be a white clue (white goes straight, can't be the turn). Subtler at borders — design separately if pursued.
- **Forced-turn propagation:** when a clue's surviving candidates all turn the same way at a vertex, force it. Subsumed partly by intersection; revisit if measurement shows a gap.

## Final review

Adversarial soundness review (the drop-rules only drop definitely-impossible configs; oracle confirms), fuzz green, then **superpowers:finishing-a-development-branch**.
