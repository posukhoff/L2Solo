'use strict';
// The model's hunt table reader: a bot hunts only the species of a spot that
// kill it at most once in so many kills (the limit moves the row without a
// rebuild, and a spot with none reads 'cannot hunt here'); the species it
// hunts combine on time (the walk at their own density, kills capped by their
// production as the game caps a cold solo bot), not by summing their kills; the hour's exp carries the C4
// level-gap penalty once per species and the preset's exp rate; and one best
// ranks the same rows for the row a bot holds and its candidates.
const assert = require('node:assert/strict');
const HuntRows = require('../scripts/economy-model/rules/hunt-rows');
const { gapFactor } = require('../src/GameServer/Progression/MobExperience');

const FIELDS = ['kills', 'deaths', 'fight', 'rest', 'other', 'walk', 'exp', 'shots', 'potions', 'pull'];
const NONE = [0, null, null, null, null, null, null, null, null, null];
// Per form [bare, shots]: kills an hour, then per kill deaths, fight, rest, other, walk (s), exp, shots, potions, pull.
const file = {
    fields: FIELDS, forms: ['bare', 'shots'],
    bodies: { 'k|10|7/54': { classId: 10, runSpd: 120, reach: 40, point: { attack: 7, defence: 54 } } },
    spots: {
        a: { area: 1e6, density: 20, species: { 1: { level: 8, count: 3, production: 600 }, 2: { level: 2, count: 1, production: 200 },
            9: { level: 30, count: 1, production: 100 } } },
        b: { area: 1e6, density: 10, species: { 3: { level: 10, count: 2, production: 30 } } }
    },
    cells: { 'k|10|7/54': {
        a: { 1: [[70, 0.1, 15, 25, 5, 6, 100, 0, 0.2, 1], [90, 0.1, 10, 20, 5, 6, 100, 1.5, 0.1, 1]],
            2: [[80, 0.5, 6, 8, 2, 4, 30, 0, 0, 2], [150, 0.2, 4, 6, 2, 4, 30, 1, 0, 2]] },
        b: { 3: [NONE, [120, 0, 3, 3, 0, 6, 50, 1, 0, 1]] }
    } }
};
const walked = [];
// The walk to the next engagement: 6 s at any density (the game's soloWalkMs is passed in the same way).
const walkMs = (density, runSpd, area, reach) => {
    walked.push({ density, runSpd, area, reach });
    return 6000;
};
const speciesYields = {
    '1@10@0': { drop: { 57: 10, 100: 0.5 }, spoil: {} },
    '2@10@0': { drop: { 57: 2 }, spoil: { 200: 1 } },
    '3@10@0': { drop: { 57: 100 }, spoil: {} }
};
const items = { 100: { npcBuy: 40 }, 200: { npcBuy: 7 } };
const rates = { exp: 3 };
const lines = limit => HuntRows.lineRows({ file, key: 'k', level: 10, point: { attack: 7, defence: 54 }, limit, rates, speciesYields,
    spoilLevel: 0, items, gapFactor, walkMs });
const read = limit => lines(limit).rows;
const close = (actual, expected, what) => assert(Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)), `${what}: ${actual} vs ${expected}`);
const spotA = { spot: file.spots.a, cells: file.cells['k|10|7/54'].a, body: file.bodies['k|10|7/54'], fields: FIELDS, walkMs };

// Species 1 kills a bot once in 10 kills, species 2 once in 5 (firing shots).
assert.deepEqual(HuntRows.spotHour({ ...spotA, form: 1, limit: 0.05 }), { hour: null, reason: 'cannot_hunt' }, 'every species over the limit: cannot hunt here');
assert.deepEqual(read(0.05).map(row => row.spotId), ['b'], 'no row for a spot the bot cannot hunt in either form');
assert.deepEqual(lines(0.05).cannot, [{ spotId: 'a', form: 'shots', reason: 'cannot_hunt' }, { spotId: 'a', form: 'bare', reason: 'cannot_hunt' },
    { spotId: 'b', form: 'bare', reason: 'cannot_hunt' }], 'each spot and form it cannot hunt, with the reason');
assert.throws(() => HuntRows.lineRows({ file, key: 'k', level: 11, point: { attack: 7, defence: 54 }, rates, speciesYields, spoilLevel: 0, items, gapFactor, walkMs }),
    /no body k\|11\|7\/54/, 'a body the table lacks is refused, not read as no spot');

walked.length = 0;
const alone = read(0.15).find(row => row.spotId === 'a');
close(alone.kills, 3600 / (10 + 20 + 5 + 6 / 1), 'species 1 alone: its own time a kill and the walk');
assert.deepEqual(alone.mix, { 1: 1 });
close(walked[0].density, 20 * 3 / 5, 'the walk at species 1\'s own density');

walked.length = 0;
const rows = read(0.25), both = rows.find(row => row.spotId === 'a');
const kills = 3600 / (0.75 * (10 + 20 + 5) + 0.25 * (4 + 6 + 2) + 6 / (0.75 * 1 + 0.25 * 2));
close(both.kills, kills, 'two species combine on time, drawn by their share');
assert.notEqual(Math.round(both.kills), 90 + 150, 'not their kills summed');
close(walked[0].density, 20 * 4 / 5, 'the walk at the admitted species\' density');
close(both.deaths, kills * (0.75 * 0.1 + 0.25 * 0.2), 'deaths an hour');
assert.deepEqual(both.mix, { 1: 0.75, 2: 0.25 });
close(both.exp, kills * (0.75 * 100 * gapFactor(2) + 0.25 * 30 * gapFactor(8)) * 3, 'exp: the level-gap penalty per species once, times the exp rate');
assert(gapFactor(8) < 1 && gapFactor(2) === 1, 'the gap of 8 is penalised');
close(both.adena, kills * (0.75 * 10 + 0.25 * 2), 'adena from the species\' yields');
close(both.dropLoot, kills * 0.75 * 0.5 * 40, 'drops at the NPC\'s price');
close(both.spoilLoot, kills * 0.25 * 7, 'spoils at the NPC\'s price');
close(both.loot, both.dropLoot + both.spoilLoot, 'loot');
close(both.shots, kills * (0.75 * 1.5 + 0.25 * 1), 'shots an hour');
close(both.busyShare, Math.min(1, kills * (0.75 * 30 + 0.25 * 10 + 6 / 1.25) / 3600), 'busy share');
// Bare, species 2 kills it once in 2 kills: the bare hour is species 1 alone, with its own deaths.
close(both.shotless.kills, 3600 / (15 + 25 + 5 + 6), 'the bare hour hunts species 1 alone');
close(both.shotless.deaths, both.shotless.kills * 0.1, 'the bare hour carries its own deaths');
assert.deepEqual(both.shotless.mix, { 1: 1 });
assert.notDeepEqual(alone, both, 'the limit moved the row on the same file');

const capped = rows.find(row => row.spotId === 'b');
assert.equal(capped.kills, 30, 'kills capped by the species\' production');
assert.equal(capped.shotless.kills, 0, 'the zero hour where the bot kills nothing bare');

// The cap as the game's soloShareMobs: a species without production adds none and does not lift the cap; a spot
// whose production is 0 (no respawn data) is not capped.
const one = [1, 0, 3, 3, 0, 6, 50, 1, 0, 1];
const capOf = species => HuntRows.combine({ spot: { area: 1e6, density: 10, species }, cells: { 3: [one, one], 4: [one, one] },
    body: file.bodies['k|10|7/54'], form: 1, fields: FIELDS, admitted: ['3', '4'], walkMs }).kills;
assert.equal(capOf({ 3: { level: 10, count: 1, production: 30 }, 4: { level: 10, count: 1, production: null } }), 30, 'a species without production keeps the cap');
close(capOf({ 3: { level: 10, count: 1, production: 0 }, 4: { level: 10, count: 1, production: 0 } }), 3600 / 12, 'production 0: no cap');

// One best for the held row and the candidates, by income an hour in the form.
const shots = HuntRows.best(rows, 'income', 'shots'), bare = HuntRows.best(rows, 'income', 'bare');
assert.equal(shots.best.spotId, 'b', 'firing shots: spot b earns 3000 an hour');
assert.deepEqual(shots.top.map(row => row.spotId), ['b', 'a']);
assert.equal(bare.best.spotId, 'a', 'bare: spot a, the only one the bot hunts bare');
assert.deepEqual(bare.top.map(row => row.spotId), ['a']);
assert.equal(shots.best, shots.top[0], 'the held row is the first candidate');

console.log('economy model hunt rows ok');
