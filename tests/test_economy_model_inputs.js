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
assert.equal(hour.top.length, 10, 'the ten spots an occupation ranks');
hour.top.forEach((row, i) => assert.equal(row.spotId, ranked[i].spotId, `top ${i} is the ranked income's`));
assert.equal(hour.top[0].adena, ranked[0].adena);
assert.equal(hour.shotId, 1463, 'a Bounty Hunter at 30 fires Soulshot D');
assert.ok(snapshot.kits[line][level].length > 0, 'the reference kit');

// Each spot a main may hold carries the levels the spot table has a row for
// the line there (spot_left fires outside them); the rows outside the top
// are spots it may keep or rank for a shot recipe's scroll, never a top spot.
const ranges = snapshot.spotLevels[line];
for (const row of hour.top) {
    const [low, high] = ranges[String(row.spotId)];
    assert.ok(low <= level && level <= high, `top spot ${row.spotId} in its range ${low}-${high}`);
    assert.ok(Table.value(String(row.spotId), line, low, true)?.kills > 0 && !(Table.value(String(row.spotId), line, high + 1, true)?.kills > 0), `${row.spotId}: the table's own rows bound the range`);
}
const ssdScroll = 1804;
for (const row of hour.others || []) {
    assert.ok(!hour.top.some(top => top.spotId === row.spotId), `${row.spotId} is not a top spot`);
    assert.ok(row.scrolls === undefined || row.scrolls.every(id => snapshot.recipes.some(recipe => recipe.recipeItemId === id && snapshot.items[recipe.productId]?.kind === 'Other.Shot')), 'scrolls named are shot recipes\' scrolls');
}
const low = Inputs.extract({ preset: 'x50', lines: [line], levels: [22, 22] });
assert.ok((low.hours[line][22].others || []).some(row => row.scrolls?.includes(ssdScroll)), 'at 22 a spot that yields the Soulshot D recipe is a candidate outside the top');

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

// Every line carries the Spoil level the spot table gives it, not the Bounty
// Hunter's alone: line 57 at level 30 spoils exactly as the table says.
const other = Inputs.extract({ preset: 'x50', lines: ['57'], levels: [30, 30] });
const owed = Table.roleSpoilLevel('57', 30);
assert.ok(owed > 0, 'the table gives line 57 a Spoil level at 30');
const spoilers = Object.values(other.yields).filter(row => row.spoilSkill === owed);
assert.ok(spoilers.length > 0, 'its spots are priced at that Spoil level');
assert.ok(spoilers.some(row => Object.keys(row.spoil).length > 0), 'and carry spoil yields');

// Rates move the yields: a group item at x50 against x1.
const x1 = Inputs.extract({ preset: 'x1', lines: [line], levels: [level, level] });
const key = keys.find(k => x1.yields[k]);
assert.ok(Object.values(snapshot.yields[key].drop).reduce((a, b) => a + b, 0)
    > Object.values(x1.yields[key].drop).reduce((a, b) => a + b, 0), 'more items per kill at x50');
assert.deepEqual(snapshot.npcOffers.x1[1785], x1.npcOffers.preset[1785], 'NPC offers at x1 in every snapshot');
assert.ok(snapshot.npcOffers.preset[1785][0].price > 2 * x1.npcOffers.preset[1785][0].price, 'and today\'s x50 NPC prices scaled up');

// The design mode's additions, each the owner's own number: the hour without
// shots, a twin's max MP and store slots, a line's race, the crystal ids and
// the per-kill yields at the design's rates.
Boot.usePreset('x50');
const bare = Table.value(String(hour.best.spotId), line, level, false);
for (const field of Inputs.SHOTLESS_FIELDS) assert.equal(hour.best.shotless[field], bare[field], `shotless ${field}`);
assert.ok(hour.best.shotless.kills < hour.best.kills, 'fewer kills without shots');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
assert.equal(snapshot.twins[30].maxMp, Profile.profileFor({ level: 30, stats: { classId: 56 } }, 0).maxMp, 'an Artisan at 30');
assert.equal(snapshot.twins[55].classId, 57, 'a Warsmith from 40');
assert.deepEqual(snapshot.twins[30].storeSlots, { sell: 4, buy: 5 }, 'a dwarf\'s store slots');
assert.equal(snapshot.twins[10].createItem, 1, 'twins below 20 are read too');
assert.equal(snapshot.races['55'], 4, 'a Bounty Hunter is a dwarf');
assert.equal(snapshot.crystalIds.D, 1458);
const DesignIncome = require('../scripts/economy-model/design-income');
const { DESIGN_RATES } = require('../scripts/economy-model/rules/dropRule');
const designKey = keys[0], designRow = snapshot.yields[designKey];
assert.deepEqual(snapshot.yieldsDesign[designKey], DesignIncome.designYields(snapshot, designRow.spotId, designRow.level, designRow.spoilSkill, DESIGN_RATES.x50, DesignIncome.gameRules()),
    'the design yields are the drop rule at the design\'s x50 rates');
assert.ok(snapshot.yieldsDesign[designKey].drop[57] < snapshot.yields[designKey].drop[57], 'design adena at 25 under today\'s 50');

// The market's additions, each the owner's own number: a line's bag slots
// and max load, the walk back from a spot, each top spot's hour without
// shots, both Luxury crystal options and the inputs of both worth formulas.
const Inventory = require('../src/GameServer/Inventory/InventoryLimits');
const Formulas = invoke('GameServer/Formulas');
assert.deepEqual(snapshot.bags[line], { race: 4, slots: Inventory.capacity(4, 0), maxLoad: Math.round(Formulas.calcMaxLoad(45)) }, 'a dwarf\'s 100 slots and the CON 45 load');
assert.equal(snapshot.walkBack[hour.best.spotId], DesignIncome.walkBackHours(hour.best.spotId, {}));
assert.ok(snapshot.walkBack[hour.best.spotId] > 0, 'a spot with a center has a walk back');
const topBare = Table.value(String(hour.top[9].spotId), line, level, false);
assert.equal(hour.top[9].shotless?.kills ?? null, topBare && topBare.kills > 0 ? topBare.kills : null, 'the tenth spot carries its hour without shots');
assert.deepEqual(snapshot.luxuryOptions[71], { npcId: 7097, town: 'Giran', c: 573, d: 2865 }, 'Flamberge for 573 C or 2865 D crystals');
const HuntCycle = invoke('GameServer/Bot/AI/HuntCycle'), BotGear = invoke('GameServer/Bot/AI/BotGear');
const dRow = snapshot.pieceWorth[line].d, kit39 = BotGear.planFor({ classId: Table.roleClass(line, 39), level: 39, characterId: HuntCycle.referenceId(Table.roleClass(line, 39), 55) }).items;
assert.equal(dRow.level, 20);
assert.equal(dRow.last, 39);
assert.deepEqual(Object.keys(dRow.pieces).map(Number).sort((a, b) => a - b), [...new Set(kit39.map(row => Number(row.selfId)))].sort((a, b) => a - b), 'the pieces of the kit at 39');
const weapon = kit39.find(row => [7, 14].includes(Number(row.slot)));
const piece = dRow.pieces[weapon.selfId];
assert.ok(piece.gear > 0 && piece.with > piece.without, 'the D weapon raises both the gear gain and the hunt cycle\'s hour');
assert.equal(snapshot.pieceWorth[line].s.last, 78, 'S runs to the last level');

console.log('PASS economy model inputs snapshot');
