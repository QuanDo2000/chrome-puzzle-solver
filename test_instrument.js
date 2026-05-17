const { AquariumSolver } = require('./solver.js');

// Create solver and instrument _propagate
const regionMap = [[0, 1], [0, 1]];
const solver = new AquariumSolver([0, 2], [1, 1], regionMap, 2, 2);

// Re-init ranges
for (const aq of solver.aquariums) solver._initRange(aq);

console.log('Before propagate:');
for (const aq of solver.aquariums) console.log(` aq${aq.id} mn=${solver.d[aq.id].mn} mx=${solver.d[aq.id].mx}`);

// Monkey-patch d to track all updates
const orig = {};
for (const aq of solver.aquariums) {
    const id = aq.id;
    orig[id] = { mn: solver.d[id].mn, mx: solver.d[id].mx };
    Object.defineProperty(solver.d[id], 'mn', {
        set(v) { console.log(`SET aq${id}.mn = ${v} (was ${orig[id].mn})`); orig[id].mn = v; },
        get() { return orig[id].mn; }
    });
    Object.defineProperty(solver.d[id], 'mx', {
        set(v) { console.log(`SET aq${id}.mx = ${v} (was ${orig[id].mx})`); orig[id].mx = v; },
        get() { return orig[id].mx; }
    });
}

const p = solver._propagate();
console.log('\npropagate:', p);
console.log('final:');
for (const aq of solver.aquariums) console.log(` aq${aq.id} mn=${aq.id === '0' ? orig[0].mn : orig[1].mn} mx=${aq.id === '0' ? orig[0].mx : orig[1].mx}`);
