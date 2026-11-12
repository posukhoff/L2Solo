'use strict';
// The economy model's game-data snapshot carries the server's own numbers:
// a spot hour as the spot table gives it, and per-item yields that price to
// the spot value's drop and spoil money per kill.
const assert = require('node:assert/strict');
const os = require('os');

// Started from another folder, the snapshot still finds the recipe data
// (read relative to the working directory).
process.chdir(os.tmpdir());
const Boot = require('../scripts/economy-model/boot');
const Inputs = require('../scripts/economy-model/inputs');
Boot.boot('x50');

const line = '55', level = 30;
const snapshot = Inputs.extract({ preset: 'x50', lines: [line], levels: [level, level] });
assert.equal(snapshot.header.rates.drop, 50, 'the preset\'s rates');
assert.ok(snapshot.recipes.length > 700, 'recipes are read wherever the script starts');
const ssd = snapshot.recipes.find(row => row.productId === 1463);
assert.equal(ssd.productCount / ssd.mpCost, 3.9);

const Table = invoke('GameServer/Bot/AI/SpotValueTable');
const hour = snapshot.hours[line][level];
const best = Table.best(line, level, true, 'income');
for (const field of Inputs.HOUR_FIELDS) assert.equal(hour.best[field], best[field], `best ${field}`);
const ranked = Table.rankedIncome(line, level);
assert.equal(hour.top.length, 3);
hour.top.forEach((row, i) => assert.equal(row.spotId, ranked[i].spotId, `top ${i} is the ranked income's`));
assert.equal(hour.top[0].adena, ranked[0].adena);
assert.equal(hour.shotId, 1463, 'a Bounty Hunter at 30 fires Soulshot D');
assert.ok(snapshot.kits[line][level].length > 0, 'the reference kit');

// Spot value (SpotRewardExpectation) against the snapshot's per-item yields at the npcBuy price.
const Rewards = invoke('GameServer/Bot/Economy/SpotRewardExpectation');
const spots = Inputs.rewardSpots();
const close = (a, b, what) => assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)), `${what}: ${a} against ${b}`);
const keys = Object.keys(snapshot.yields);
assert.ok(keys.length >= 3, 'yields for the spots of the hour');
let spoiled = 0;
for (const key of keys) {
    const row = snapshot.yields[key];
    const value = Rewards.value(spots.get(row.spotId), row.level, { spoilSkillLevel: row.spoilSkill });
    const priced = yields => Object.entries(yields).reduce((sum, [id, count]) => sum + (Number(id) === 57 ? 0 : count * snapshot.items[id].npcBuy), 0);
    close(priced(row.drop), value.drop, `${key} drop money per kill`);
    close(priced(row.spoil), value.spoil, `${key} spoil money per kill`);
    if (snapshot.compositions[row.spotId].npcs.every(npc => npc.rewardId !== null)) close(row.drop[57] || 0, value.adena, `${key} adena per kill`);
    if (value.spoil > 0) spoiled++;
}
assert.ok(spoiled > 0, 'a Bounty Hunter spoils at its spots');

// Rates move the yields: a group item at x50 against x1.
const x1 = Inputs.extract({ preset: 'x1', lines: [line], levels: [level, level] });
const key = keys.find(k => x1.yields[k]);
assert.ok(Object.values(snapshot.yields[key].drop).reduce((a, b) => a + b, 0)
    > Object.values(x1.yields[key].drop).reduce((a, b) => a + b, 0), 'more items per kill at x50');
assert.deepEqual(snapshot.npcOffers.x1[1785], x1.npcOffers.preset[1785], 'NPC offers at x1 in every snapshot');
assert.ok(snapshot.npcOffers.preset[1785][0].price > 2 * x1.npcOffers.preset[1785][0].price, 'and today\'s x50 NPC prices scaled up');

console.log('PASS economy model inputs snapshot');
