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
const caster = '12';
const snapshot = Inputs.extract({ preset: 'x50', lines: [line, '2', caster], levels: [level, level] });
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
// A line that fires spiritshots carries each row's hour firing Blessed
// Spiritshots (the spot table's with shots 2); a soulshot line has none.
const rowsOf = at => [at.best, ...at.top, ...(at.others || [])].filter(Boolean);
const casterRows = rowsOf(snapshot.hours[caster][level]);
assert.ok(casterRows.length > 1, 'the caster\'s rows');
for (const row of casterRows) {
    const blessed = Table.value(String(row.spotId), caster, level, 2);
    assert.deepEqual(row.blessed, Object.fromEntries(Inputs.BLESSED_FIELDS.map(field => [field, blessed[field]])), `${row.spotId}: the blessed hour`);
}
assert.ok(casterRows.some(row => row.blessed.exp > row.exp && row.blessed.adena > row.adena), 'blessed shots earn and level faster at some spot');
for (const other of [line, '2']) assert.ok(rowsOf(snapshot.hours[other][level]).every(row => !('blessed' in row)), `line ${other} fires soulshots: no blessed hour`);
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
// shots and both Luxury crystal options.
const Inventory = require('../src/GameServer/Inventory/InventoryLimits');
const Formulas = invoke('GameServer/Formulas');
assert.deepEqual(snapshot.bags[line], { race: 4, slots: Inventory.capacity(4, 0), maxLoad: Math.round(Formulas.calcMaxLoad(45)) }, 'a dwarf\'s 100 slots and the CON 45 load');
assert.equal(snapshot.walkBack[hour.best.spotId], DesignIncome.walkBackHours(hour.best.spotId, {}));
assert.ok(snapshot.walkBack[hour.best.spotId] > 0, 'a spot with a center has a walk back');
const topBare = Table.value(String(hour.top[9].spotId), line, level, false);
assert.equal(hour.top[9].shotless?.kills ?? null, topBare && topBare.kills > 0 ? topBare.kills : null, 'the tenth spot carries its hour without shots');
assert.deepEqual(snapshot.luxuryOptions[71], { npcId: 7097, town: 'Giran', c: 573, d: 2865 }, 'Flamberge for 573 C or 2865 D crystals');

// The gear ladder: a Scavenger's (the Bounty Hunter at 30) band 30-34 holds
// the gear table's D weapon rungs and the no-grade ones below, none above D,
// its best spot, its scale to the design's money and its caster mark (a
// Scavenger weighs a piece's attack by P.Atk); a kit's hours are read
// through kit-hours.js, not stored.
const name = id => snapshot.items[id]?.name;
const band = snapshot.gearLadder.lines[line];
assert.deepEqual(band.map(row => [row.from, row.to, row.level, row.grade, row.caster]), [[30, 34, 32, 'd', false]], 'the band of the levels asked, read at its middle');
const weapons = band[0].rungs.weapon, club = weapons.find(id => name(id) === 'Spiked Club');
for (const wanted of ['Hand Axe', 'Tomahawk', 'Spiked Club']) assert.ok(weapons.some(id => name(id) === wanted), `${wanted} is a rung`);
assert.ok(weapons.every(id => ['D', 'NONE'].includes(snapshot.items[id].grade)), 'no rung above the band\'s grade');
assert.equal(band[0].best, String(Table.best(line, 32, true, 'income').spotId), 'the band\'s best spot');
assert.ok(band[0].scale > 0 && band[0].scale < 1, `x50 design money under today's: ${band[0].scale}`);
assert.ok(!('hour' in band[0]) && !('gear' in band[0]), 'no kit hour stored');
assert.equal(snapshot.gearLadder.slots[club], 7, 'a rung\'s own slot');

// The trade towns are the game's own (MarketTownPolicy): C and above in
// Giran, D in either D market, a no-grade lot in the starter-village market
// nearest the spot card's centre (a Talking Island spot sells there), and
// at least four of the five villages over the spots.
const villages = ['Talking Island', 'Elven Village', 'Dark Elven Village', 'Orc Village', 'Dwarven Village'];
assert.equal(snapshot.tradeTowns.higher, 'Giran');
assert.deepEqual(snapshot.tradeTowns.d, ['Gludio', 'Dion']);
assert.equal(snapshot.tradeTowns.grade[1463], 'd');
const cards = require('../data/Bots/hunt/spots.json'), townAt = cards.spotFields.indexOf('town'), minAt = cards.spotFields.indexOf('minLevel');
const island = cards.spots.find(row => row[townAt] === 'Talking Island' && row[minAt] <= 5);
assert.equal(snapshot.tradeTowns.none[String(island[0])], 'Talking Island', `${island[0]} sells in Talking Island`);
const markets = new Set(Object.values(snapshot.tradeTowns.none));
assert.ok([...markets].every(town => villages.includes(town)) && markets.size >= 4, [...markets].join(', '));

// A servitor costs a player crystals (the game spares bots): the Warlock's
// line at 40 casts the first summon its cold fight lists, each cast paying the
// rank's itemCount and, over the servitor's life, itemConsumeSteps payments of
// itemCountOT; the life loses timeLostActive ms each second it fights and
// timeLostIdle ms otherwise, at the busy share of the level's best row.
const summoner = Inputs.extract({ preset: 'x1', lines: ['14', '2'], levels: [40, 40] });
const HuntCycle = invoke('GameServer/Bot/AI/HuntCycle');
const warlock = Profile.profileFor(HuntCycle.referenceState(Table.roleClass('14', 40), 40, { line: 14 }), 0);
const cast = Profile.summonSkills(warlock)[0], skillRows = require('../data/Skills/Active/active.json');
const summonRow = skillRows.find(row => row.selfId === cast.selfId), rank = summonRow.levels.find(row => row.level === cast.level);
assert.equal(summonRow.template.name, 'Summon Kai the Cat', 'a Warlock at 40 casts Kai the Cat');
const due = summoner.upkeep['14'][40], busy = summoner.hours['14'][40].best.busyShare;
assert.equal(summonRow.summon.itemIdOT, rank.itemId, 'the cast and the upkeep take one crystal');
assert.deepEqual(due.map(row => [row.id, row.what.skill, row.what.level, row.what.name]), [[rank.itemId, cast.selfId, cast.level, 'Summon Kai the Cat']]);
assert.equal(rank.itemId, 1459, 'C crystals');
const life = summonRow.summon.totalLifeTime / (busy * summonRow.summon.timeLostActive + (1 - busy) * summonRow.summon.timeLostIdle);
close(due[0].perHour, 3600 * (rank.itemCount + summonRow.summon.itemConsumeSteps * rank.itemCountOT) / life, 'crystals per hunt hour from the skill data');
// Rank 1: 1 at the cast and 4 steps of 1 over a 1,200,000 ms life lost at 500 ms a second idle, 1000 fighting.
close(due[0].perHour, 3600 * 5 * (500 + 500 * busy) / 1200000, `5 crystals a life at busy share ${busy}`);
assert.equal(summoner.upkeep['2'], undefined, 'a fighter line keeps no servitor');
assert.equal(snapshot.upkeep[line], undefined, 'nor does a Bounty Hunter');
// Below 20 the line's Mage has no summon; from 20 its Wizard casts Mew the
// Cat, then Kat the Cat, and each of their first ranks waits 6 hours to be
// cast again: one cast of each per 6 hours (1 and 3 D crystals).
const early = Inputs.extract({ preset: 'x1', lines: ['14'], levels: [19, 20] });
assert.ok(early.hours['14'][19].best, 'the line hunts at 19');
assert.equal(early.upkeep['14'][19], undefined, 'no summon below 20');
assert.deepEqual(early.upkeep['14'][20].map(row => [row.id, row.what.name, row.perHour]), [[1458, 'Summon Mew the Cat', 1 / 6], [1458, 'Summon Kat the Cat', 3 / 6]]);
// The arrow of each bow grade, as the game's arrow stock names it.
const ArrowStock = invoke('GameServer/Inventory/ArrowStock');
assert.deepEqual(snapshot.arrowIds, { ...ArrowStock.BY_RANK });
assert.equal(snapshot.arrowIds.d, 1341, 'Bone Arrow for a D bow');
assert.equal(snapshot.items[1341]?.name, 'Bone Arrow', 'the arrows ride in items');

console.log('PASS economy model inputs snapshot');
