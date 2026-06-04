'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { LightUpSolver } = require('../src/solvers/lightup.js');

// task: -1 white, -2 black-no-number, 0..4 numbered black.
function mk(task) { return new LightUpSolver({ task }); }

test('LightUp oracle: taskMarkedCount counts orthogonal bulbs', () => {
  // [white, clue, white]; cells: bulb, black, bulb
  const s = mk([[-1, 2, -1]]);
  assert.equal(s._taskMarkedCount([[1, -1, 1]], 0, 1), 2);
  assert.equal(s._taskMarkedCount([[1, -1, 0]], 0, 1), 1);
  assert.equal(s._taskMarkedCount([[0, -1, 0]], 0, 1), 0);
});

test('LightUp oracle: a single bulb lights its full unblocked segment', () => {
  const s = mk([[-1, -1, -1]]);          // 1x3 all white
  assert.equal(s._isValid([[1, 0, 0]]), true);   // bulb at left lights all three
  assert.equal(s._isValid([[0, 1, 0]]), true);
});

test('LightUp oracle: two bulbs seeing each other is invalid (collision)', () => {
  const s = mk([[-1, -1, -1]]);
  assert.equal(s._isValid([[1, 0, 1]]), false);  // both in one segment
});

test('LightUp oracle: a black wall blocks light and splits segments', () => {
  const s = mk([[-1, 2, -1]]);           // white | clue2 | white
  // each white cell is its own segment; both must be bulbs; clue 2 satisfied
  assert.equal(s._isValid([[1, -1, 1]]), true);
  // unlit cell -> invalid
  assert.equal(s._isValid([[0, -1, 1]]), false); // (0,0) unlit
  // clue mismatch -> invalid
  const s0 = mk([[-1, 0, -1]]);          // clue 0 forbids both -> but then unlit -> invalid anyway
  assert.equal(s0._isValid([[1, -1, 1]]), false); // clue 0 violated (marked=2)
});

test('LightUp oracle: numbered clue must match exactly', () => {
  const s = mk([[-1, 1, -1]]);
  assert.equal(s._isValid([[1, -1, 1]]), false); // marked 2 != 1
});

test('LightUp propagation: isolated white cells are forced to bulbs', () => {
  const s = mk([[-1, 2, -1]]);  // each white cell is its own segment
  s._initDomains(); s._buildSegments();
  assert.equal(s._propagate(), true);
  assert.equal(s._dom[0][0], 2); // forced bulb
  assert.equal(s._dom[0][2], 2); // forced bulb
});

test('LightUp propagation: clue 0 forbids all adjacent bulbs', () => {
  // clue 0 at (1,2); its four neighbours have length-2 arms so they can still be
  // lit from further down the arm — the board stays satisfiable (no contradiction),
  // but every clue-neighbour loses the bulb option.
  const s = mk([
    [-2, -1, -1, -1, -2],
    [-1, -1,  0, -1, -1],
    [-2, -1, -1, -1, -2],
  ]);
  s._initDomains(); s._buildSegments();
  assert.equal(s._propagate(), true);
  assert.equal(s._dom[0][2] & 2, 0); // above the clue: cannot be a bulb
  assert.equal(s._dom[2][2] & 2, 0); // below
  assert.equal(s._dom[1][1] & 2, 0); // left
  assert.equal(s._dom[1][3] & 2, 0); // right
});

test('LightUp propagation: a placed bulb forbids bulbs along its segment', () => {
  const s = mk([[-1, -1, -1]]);
  s._initDomains(); s._buildSegments();
  s._dom[0][0] = 2;                 // pin a bulb at the left
  assert.equal(s._propagate(), true);
  assert.equal(s._dom[0][1], 1);    // cannot be a bulb (lit, same segment)
  assert.equal(s._dom[0][2], 1);
});

test('LightUp propagation: detects collision contradiction', () => {
  const s = mk([[-1, -1, -1]]);
  s._initDomains(); s._buildSegments();
  s._dom[0][0] = 2; s._dom[0][2] = 2; // two bulbs in one segment
  assert.equal(s._propagate(), false);
});

// Brute-force ALL valid bulb placements over the white cells (2^open).
function bruteForce(task) {
  const s = new LightUpSolver({ task });
  const H = task.length, W = task[0].length;
  const open = [];
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (task[r][c] === -1) open.push([r, c]);
  const cells = task.map(row => row.map(v => (v === -1 ? 0 : -1)));
  const sols = [];
  const rec = (i) => {
    if (i === open.length) { if (s._isValid(cells)) sols.push(cells.map(row => row.slice())); return; }
    const [r, c] = open[i];
    cells[r][c] = 0; rec(i + 1);
    cells[r][c] = 1; rec(i + 1);
    cells[r][c] = 0;
  };
  rec(0);
  return sols;
}

const SOUNDNESS_BOARDS = [
  [[-1, 2, -1]],
  [[-1, -1, -1]],
  [[-1, -1], [-1, -1]],
  [[-2, -1, -2], [-1, 0, -1], [-2, -1, -2]],
  [[-1, -1, -1], [-1, -2, -1], [-1, -1, -1]],
  [[-1, -1, -1], [-1, 1, -1], [-1, -1, -1]],
];

test('LightUp soundness: root propagation never contradicts a real solution', () => {
  for (const task of SOUNDNESS_BOARDS) {
    const sols = bruteForce(task);
    const s = new LightUpSolver({ task });
    s._initDomains(); s._buildSegments();
    const ok = s._propagate();
    if (sols.length === 0) continue; // UNSAT boards may or may not detect here; solve() handles it
    assert.ok(ok, `propagation wrongly contradicted a solvable board: ${JSON.stringify(task)}`);
    // Every singleton domain must agree with EVERY brute-force solution.
    for (let r = 0; r < task.length; r++) for (let c = 0; c < task[0].length; c++) {
      if (task[r][c] !== -1) continue;
      const d = s._dom[r][c];
      if (d === 1 || d === 2) {
        const forced = d === 2 ? 1 : 0;
        for (const sol of sols) {
          assert.equal(sol[r][c], forced,
            `forced (${r},${c})=${forced} but a solution has ${sol[r][c]}: ${JSON.stringify(task)}`);
        }
      }
      // Pruned values must be used by NO solution.
      if ((d & 1) === 0) for (const sol of sols) assert.notEqual(sol[r][c], 0, `pruned no-bulb but a sol uses it (${r},${c})`);
      if ((d & 2) === 0) for (const sol of sols) assert.notEqual(sol[r][c], 1, `pruned bulb but a sol uses it (${r},${c})`);
    }
  }
});

test('LightUp solve: solver-solved iff brute-force has a solution, and output is valid', () => {
  for (const task of SOUNDNESS_BOARDS) {
    const sols = bruteForce(task);
    const res = new LightUpSolver({ task, maxMs: 5000 }).solve();
    if (sols.length === 0) {
      assert.equal(res.solved, false, `solver claimed solve on UNSAT: ${JSON.stringify(task)}`);
    } else {
      assert.equal(res.solved, true, `solver failed a solvable board: ${JSON.stringify(task)}`);
      assert.ok(new LightUpSolver({ task })._isValid(res.cells), 'solver output failed the oracle');
    }
  }
});

test('LightUp solve: a uniquely-solved board returns the unique solution', () => {
  const task = [[-1, 2, -1]];
  const res = new LightUpSolver({ task }).solve();
  assert.equal(res.solved, true);
  assert.deepEqual(res.cells, [[1, -1, 1]]);
});

test('LightUp _deduceOnly: reports newly-forced cells from a seeded board', () => {
  // [-1, 2, -1]: both white cells are forced bulbs with nothing pre-decided.
  const s = mk([[-1, 2, -1]]);
  const decided = [[9, -1, 9]];           // -1 black, 9 UNK
  const forced = s._deduceOnly(decided);
  // both (0,0) and (0,2) forced to bulb (value 1)
  const keys = forced.map(f => `${f.row},${f.col}=${f.value}`).sort();
  assert.deepEqual(keys, ['0,0=1', '0,2=1']);
});

test('LightUp _deduceOnly: contradictory seed returns empty (player erred)', () => {
  const s = mk([[-1, -1, -1]]);
  const decided = [[1, 9, 1]];            // two bulbs seeing each other
  assert.deepEqual(s._deduceOnly(decided), []);
});
