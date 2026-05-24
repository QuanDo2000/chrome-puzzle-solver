const test = require('node:test');
const assert = require('node:assert/strict');
const { HashiSolver } = require('../solver.js');

test('HashiSolver: constructor builds islands, edges, crosses', () => {
  // 3-island H+V configuration:
  //   . 1 . . 2
  //   . . . . .
  //   . 2 . . .
  // Island 0 (0,1)=1, island 1 (0,4)=2, island 2 (2,1)=2.
  // Edge candidates: (0,1) horizontal at row 0, (0,2) vertical at col 1.
  // No crossings (different rows/cols).
  const s = new HashiSolver({
    rows: 3, cols: 5,
    islands: [
      { index: 0, row: 0, col: 1, number: 1 },
      { index: 1, row: 0, col: 4, number: 2 },
      { index: 2, row: 2, col: 1, number: 2 },
    ],
  });
  assert.equal(s.islands.length, 3);
  assert.equal(s.edges.length, 2);
  // Edge owner is always lower index → both edges owned by island 0
  const e01 = s.edges.find(e => e.a === 0 && e.b === 1);
  const e02 = s.edges.find(e => e.a === 0 && e.b === 2);
  assert.ok(e01 && e01.orientation === 'H');
  assert.ok(e02 && e02.orientation === 'V');
  // Initial hi capped at min(2, target[a], target[b]):
  // edge(0,1): min(2, 1, 2) = 1
  // edge(0,2): min(2, 1, 2) = 1
  assert.equal(s.hi[s.edges.indexOf(e01)], 1);
  assert.equal(s.hi[s.edges.indexOf(e02)], 1);
  // Crosses empty (parallel directions, different rows/cols)
  assert.deepEqual(s.crosses[0], []);
  assert.deepEqual(s.crosses[1], []);
});

test('HashiSolver: crossing edges detected', () => {
  // Four islands forming a cross at row 1, col 1:
  //   . 1 . .
  //   1 . . 1
  //   . 1 . .
  // Island 0 (0,1)=1, island 1 (1,0)=1, island 2 (1,3)=1, island 3 (2,1)=1.
  // Horizontal edge (1,2) at row 1 from col 0 to col 3; vertical edge (0,3) at col 1 from row 0 to row 2.
  // These cross at (1,1).
  const s = new HashiSolver({
    rows: 3, cols: 4,
    islands: [
      { index: 0, row: 0, col: 1, number: 1 },
      { index: 1, row: 1, col: 0, number: 1 },
      { index: 2, row: 1, col: 3, number: 1 },
      { index: 3, row: 2, col: 1, number: 1 },
    ],
  });
  const eH = s.edges.find(e => e.a === 1 && e.b === 2); // horizontal (1,0)-(1,3)
  const eV = s.edges.find(e => e.a === 0 && e.b === 3); // vertical (0,1)-(2,1)
  assert.ok(eH && eH.orientation === 'H');
  assert.ok(eV && eV.orientation === 'V');
  const iH = s.edges.indexOf(eH);
  const iV = s.edges.indexOf(eV);
  assert.deepEqual(s.crosses[iH].sort(), [iV]);
  assert.deepEqual(s.crosses[iV].sort(), [iH]);
});
