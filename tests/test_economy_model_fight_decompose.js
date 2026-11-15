'use strict';
// The fight decomposition watches the hunt table's own hunt without changing
// it: its cell is the builder's cell, its wall-clock parts (fight, walk, rest,
// death recovery, other; a round's combat in the interval before its
// timestamp, the one the resolver budgets it from) tile the hunt's hours from
// the first round's budget to the hunt-end tail, its fatal fights are the
// hunt's deaths, the rest the builder reads is the rest the rounds set, and
// every cell names the term that carries the mean path's error.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('../src/Global');
const Generator = require('../scripts/generate-spot-table');
const HuntTable = require('../scripts/economy-model/hunt-table');
const Lift = require('../scripts/economy-model/hunt-lift');
const Decompose = require('../scripts/economy-model/fight/decompose');

const GREMLIN_SPOT = '-12_43';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fight-decompose-test-'));
try {
    const catalogue = path.join(dir, 'catalogue.json');
    const built = Generator.buildCatalogue();
    fs.writeFileSync(catalogue, JSON.stringify({ spots: built.spots, profiles: built.profiles }));
    Generator.loadSimulation(catalogue);
    const spot = built.profiles.find(one => String(one.id) === GREMLIN_SPOT);
    assert(spot, `the catalogue has the gremlin spot ${GREMLIN_SPOT}`);
    const selfId = Number(spot.npcEntries[0].selfId), line = '51', level = 1, form = 0, hours = 1;
    const classId = Generator.classFor(line, level);
    Lift.lift(true);
    try {
        const plain = HuntTable.cellOf(Generator.hunt(Decompose.speciesSpot(spot, selfId), line, level, form, hours, undefined,
            Decompose.creationKit(classId), classId), hours);
        const out = Decompose.decompose({ spot, selfId, line, level, form, hours });
        const { asIs, terms } = out;
        assert.deepEqual(asIs.cell, plain, 'watching the hunt does not change its cell');
        assert(asIs.mobs > 0, 'the lifted mystic kills gremlins');
        assert.deepEqual(Object.keys(out).sort(), ['asIs', 'terms'], 'one hunt, no variant with the rest moved');
        const w = asIs.wallMs, { before, tail } = asIs.edgeMs;
        assert.deepEqual(Object.keys(w).sort(), ['death', 'fight', 'other', 'rest', 'walk'], 'no overlap part: fight and rest do not share a second');
        assert(w.rest > 0 && w.fight > 0, `the hunt fights and rests (${JSON.stringify(w)})`);
        const total = w.fight + w.walk + w.rest + w.death + w.other;
        assert.equal(before, 60000, 'the first round is credited the builder\'s first interval before the hunt\'s start');
        assert(tail >= 0 && tail <= 120000, `the hunt-end tail is at most one hunt cycle (${tail})`);
        assert(Math.abs(total - (hours * 3600000 + before - tail)) < 1e-3, `the parts tile the clock from the first budget to the hunt-end tail (${total})`);
        assert.equal(asIs.fatal.length, asIs.deaths, 'each death is one fatal fight');
        const read = asIs.reportedRestMs / 1000 / asIs.mobs;
        assert(Math.abs(asIs.cell[3] - read) <= 1e-3 * Math.max(1, read), `the cell's rest is the rest the rounds set (${asIs.cell[3]} vs ${read})`);
        assert(terms.named.length >= 1 && ['mpAtStart', 'rotation'].includes(terms.named[0]), `a term is named (${terms.named})`);
        assert(terms.meanRested && terms.meanAtStart, 'the mean path runs from the rested line and from the measured start');
    } finally {
        Lift.lift(false);
    }
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}
console.log('test_economy_model_fight_decompose: ok');
