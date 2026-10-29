'use strict';
// T115: a bot whose class is not the one the table measured its role with
// reads the role's rows with its own class's damage (the hunt tables'
// rotation d1): its fight and rest run at the measured class's rate over
// its own, the idle time between kills stays.
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Table = invoke('GameServer/Bot/AI/SpotValueTable');
const rotation = require('../data/Bots/hunt/rotation.json');

const level = 50;
assert.equal(Table.roleFor({ level, stats: { classId: 2 } }), 'dps', 'the measured class reads the role');
assert.equal(Table.roleFor({ level, stats: { classId: 88 } }), 'dps', 'its third class too');
assert.equal(Table.roleFor({ level, stats: { classId: 46 } }), 'dps#46', 'a Destroyer reads the dps rows as itself');
assert.equal(Table.roleClass('dps#46', level), 46);

const d1 = classId => {
    const rows = rotation.rows[classId], want = Math.floor(level / rotation.bandLevels);
    const band = Object.keys(rows).map(Number).reduce((best, b) => Math.abs(b - want) < Math.abs(best - want) ? b : best);
    return rows[band][rotation.fields.indexOf('d1')];
};
let checked = 0;
for (const spotId of Table.rankedSpotIds('dps', level, { shots: 0, potions: 0 })) {
    const cycle = Table.cycle(spotId, 'dps', level, true);
    if (!cycle || !(cycle.kph < cycle.cap / 2)) continue;
    const perKill = 3600 / cycle.kph, busy = Math.min(perKill, cycle.fight + cycle.rest);
    const expected = Math.min(cycle.cap, 3600 / (busy * d1(2) / d1(46) + perKill - busy));
    const own = Table.value(spotId, 'dps#46', level, true), base = Table.value(spotId, 'dps', level, true);
    assert(Math.abs(own.kills - expected) < 1e-6 * expected, `${spotId}: ${own.kills} vs ${expected}`);
    assert.notEqual(Math.round(own.kills), Math.round(base.kills), 'the class changes the kills');
    if (++checked >= 3) break;
}
assert(checked > 0, 'an uncapped dps row at 50');
console.log('PASS class correction of the table rows');
