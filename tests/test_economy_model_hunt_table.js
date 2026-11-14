'use strict';
// The model's hunt table measures a bot's own combat per species, with the
// game's solo readiness lifted: a level-1 orc mystic, whom the game's gate
// keeps off every gremlin, gets measured kills, deaths and per-kill times at a
// gremlin spot, in parts that add up to the hunt's time (so species combine on
// time); and the builder refuses to build when the lift no longer reaches the
// fight (a table built then would measure the gate).
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('../src/Global');
const Generator = require('../scripts/generate-spot-table');
const HuntTable = require('../scripts/economy-model/hunt-table');

const GREMLIN_SPOT = '-12_43';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-table-test-'));
const catalogue = path.join(dir, 'catalogue.json');
const built = Generator.buildCatalogue();
fs.writeFileSync(catalogue, JSON.stringify({ spots: built.spots, profiles: built.profiles }));
const gremlins = built.profiles.find(spot => String(spot.id) === GREMLIN_SPOT);
assert(gremlins, `the catalogue has the gremlin spot ${GREMLIN_SPOT}`);
const species = [...new Set(gremlins.npcEntries.map(entry => Number(entry.selfId)))];
assert.equal(species.length, 1, 'one species there');

const key = Generator.botFor('51', 1);
const options = { from: 1, to: 1, hours: 1, children: 1, spots: [GREMLIN_SPOT], keys: [key], catalogue, out: path.join(dir, 'hunt.json'), log: () => {} };

(async () => {
    try {
        const { file, table } = await HuntTable.build(options);
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), table, 'the file holds the table');
        assert.match(table.stamp, /^[0-9a-f]{12}$/);
        const at = Object.fromEntries(table.fields.map((field, index) => [field, index]));
        for (const field of ['kills', 'deaths', 'fight', 'rest', 'walk', 'exp', 'shots', 'pull']) assert(field in at, `a cell carries ${field}`);
        const bodies = Object.keys(table.bodies).filter(body => body.startsWith(`${key}|1|`));
        assert.equal(bodies.length, 1, 'one body: the creation kit\'s point');
        const body = table.bodies[bodies[0]];
        assert(body.runSpd > 0 && body.reach >= 0, 'the body\'s walk inputs');
        const spot = table.spots[GREMLIN_SPOT];
        assert(spot.area > 0 && spot.density > 0 && spot.species[species[0]].count > 0, 'the spot\'s statics');
        const forms = table.cells[bodies[0]][GREMLIN_SPOT][species[0]];
        assert.equal(forms.length, table.forms.length, 'bare and shots');
        for (const [form, cell] of forms.entries()) {
            const name = table.forms[form];
            assert(cell[at.kills] > 0, `${name}: measured kills (the game's gate allows none)`);
            assert(Number.isFinite(cell[at.deaths]) && cell[at.deaths] >= 0, `${name}: measured deaths a kill`);
            assert(cell[at.fight] > 0, `${name}: the fight a kill, without the walk`);
            assert(cell[at.pull] >= 1, `${name}: mobs per engagement`);
            // Time per kill = fight + rest + other + walk: the hour holds kills x that.
            const perKill = cell[at.fight] + cell[at.rest] + cell[at.other] + cell[at.walk];
            assert(Math.abs(perKill * cell[at.kills] - 3600) < 3600 * 0.01, `${name}: the parts make the hour (${perKill} s x ${cell[at.kills]})`);
        }

        // The game ignores the lift's option (a renamed or removed solo-safety switch): the gate stays.
        const TM = invoke('GameServer/Bot/AI/BotTargetMatchup'), CCP = invoke('GameServer/Bot/Population/ColdCombatProfile');
        const real = { spotShares: TM.spotShares, npcForSpot: CCP.npcForSpot };
        TM.spotShares = (profiles, at, more = {}) => real.spotShares(profiles, at, { ...more, soloSafety: true });
        CCP.npcForSpot = (at, roll, more = {}) => real.npcForSpot(at, roll, { ...more, soloSafety: true });
        try {
            await assert.rejects(HuntTable.build({ ...options, out: path.join(dir, 'refused.json') }), /lift no longer reaches/);
            assert(!fs.existsSync(path.join(dir, 'refused.json')), 'nothing written');
        } finally {
            Object.assign(TM, { spotShares: real.spotShares });
            Object.assign(CCP, { npcForSpot: real.npcForSpot });
        }
        console.log('test_economy_model_hunt_table: ok');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exit(1); });
