'use strict';
// An NPC's share of a spot's kills is counted the way the cold kill rolls it:
// only NPCs a bot hunts, each spawn entry at least 1, and a kill credited to
// the loot table it really rolls (own id, else the same name). Every reader of
// units per kill (the planner, first prices, material camps, party item hours)
// gets the same answer as the spot's reward expectation; a kill aimed at one
// monster gets the share the roll gives it.
const assert = require('node:assert/strict');
const path = require('node:path');
const { useRate } = require('./helpers/progressionRate');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Rewards = require('../src/GameServer/Bot/Economy/SpotRewardExpectation');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const FirstPrice = invoke('GameServer/Bot/Economy/FirstPrice');
const Table = invoke('GameServer/Bot/AI/SpotValueTable');
const Material = require('../src/GameServer/Bot/Population/CraftMaterialParty');
const PartyIncome = require('../src/GameServer/Bot/Population/PartyIncomeComparison');
const Sources = require('../src/GameServer/Knowledge/SourceCatalog');
const Policy = invoke('GameServer/Bot/AI/BotHuntingTargetPolicy');
const Formulas = invoke('GameServer/Formulas');

const close = (a, b, message) => assert(Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(b)), `${message}: ${a} != ${b}`);
// A: Cat's Eye Bandit (262), its own loot table. X: 5038, a world id of the
// same monster whose loot is found by name. The castle NPC 12009 is never hunted.
const A = 262, X = 5038, CASTLE = 12009;
const npcOf = id => Data.npcs.find(npc => Number(npc.selfId) === id);
assert.equal(npcOf(X).template.name, npcOf(A).template.name, 'X is the same monster as A by name');
assert(Policy.canHunt(npcOf(A)) && !Policy.canHunt(npcOf(CASTLE)), 'A is hunted, the castle NPC is not');
const reward = Sources.rewardForNpc(A), npcLevel = Number(npcOf(A).template.level);
// Spot S of the hand-made table (tests/fixtures/spot_table.json): A x3, the castle NPC x1, X x1.
const mixed = { id: 'S', avgLevel: 18, density: 30, npcEntries: [
    { selfId: A, count: 3 }, { selfId: CASTLE, count: 1 }, { selfId: X, count: 1 }] };
const pure = { id: 'pure', avgLevel: 18, npcEntries: [{ selfId: A, count: 1 }] };
const spots = [mixed];
const dropIds = [...new Set((reward.rewards || []).flatMap(group => (group.items || []).map(item => Number(item.selfId))))]
    .filter(id => id !== 57);
const spoilIds = (reward.spoils || []).flatMap(group => (group.items || []).map(item => Number(item.selfId)));
Table.useFile(path.join(__dirname, 'fixtures', 'spot_table.json'));
Table.useSpots(spots);
const savedRate = process.env.L2NODE_PROGRESSION_RATE;
useRate('x1');
try {
    // Every kill at S rolls A's table: 3 of A and 1 of X, the castle NPC out (old count: 3 of 5).
    close(Rewards.killShare(mixed, reward), 1, 'all hunted kills at S roll A\'s loot table');
    for (const key of ['adena', 'drop', 'spoil']) close(Rewards.value(mixed, npcLevel, { spoilSkillLevel: 3 })[key],
        Rewards.value(pure, npcLevel, { spoilSkillLevel: 3 })[key], `the expectation of S is A's own (${key})`);

    const itemId = dropIds[0];
    const yieldAt = (killerLevel, kind = 'drop', id = itemId) =>
        Planner.itemDropYield(reward, id, kind, { npcLevel, killerLevel }).expectedYield;
    const record = { spot: mixed, reward, kind: 'drop', npcLevel };
    assert(yieldAt(npcLevel) > 0, 'A drops the item');
    close(Planner.sourcePerKill(record, yieldAt(npcLevel)), yieldAt(npcLevel), 'units per kill = yield x 1');

    // A spoil lands by the spoiler's Spoil level against A's level.
    const spoiler = { level: npcLevel + 2, skillLevel: 3 };
    const landing = Formulas.spoilSuccessChance({ skillId: 254, skillLevel: 3, attackerLevel: npcLevel + 2, targetLevel: npcLevel });
    assert(spoilIds.length, 'A has a spoil');
    close(Planner.sourcePerKill({ ...record, kind: 'spoil' }, 2, spoiler), 2 * landing, 'a spoil x its landing');
    close(Planner.sourcePerKill({ ...record, kind: 'spoil' }, 2), 2, 'the static ranking counts a spoil before landing');

    // Material camps: the camp's rate is A's units per kill at the hunter's level.
    const hunter = { characterId: 990301, level: npcLevel, stats: { role: 'dps', classId: 0 } };
    const camp = Material.campsFor(hunter, itemId, spots, null).find(row => row.spotId === 'S');
    assert(camp, 'S is a camp for the item');
    close(camp.rate, yieldAt(npcLevel), 'the camp counts every hunted kill of S for A');

    // Party item hours: hours for one unit = 1 / (kills x units per kill).
    const hours = PartyIncome.itemHours(hunter, mixed, 10, { npcId: A, itemId, sourceKind: 'drop', amount: 1 }, [hunter]);
    close(hours, 1 / (10 * yieldAt(npcLevel)), 'party item hours read the same units per kill');

    // First price: the kills to hunt one unit at S = 1 / units per kill at the table's level.
    const hunted = dropIds.map(id => [id, FirstPrice.firstPrice(id, { spots, timestamp: 1e12 })])
        .find(([, price]) => price?.source === 'drop' && price.spotId === 'S');
    assert(hunted, 'one of A\'s drops is priced by hunting at S');
    close(hunted[1].kills, 1 / yieldAt(hunted[1].level, 'drop', hunted[0]), 'the first price counts every hunted kill of S for A');
    // Five species of equal count: an untargeted kill takes each 1 time in 5. A
    // kill aimed at Poison Spider (38, passive), as a direct-drop plan or a
    // material party aims, takes it unless one of the two aggressive others
    // (43, 44) engages first (1 in 4), never only 1 time in 5 (37 has no loot table).
    const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
    const SPIDER = 38, five = { id: 'five', avgLevel: 19, npcEntries: [37, 38, 39, 43, 44].map(selfId => ({ selfId, count: 2 })) };
    assert.deepEqual([37, 38, 39, 43, 44].filter(id => npcOf(id).template.hostile === true), [43, 44], 'two aggressive species');
    const spiderReward = Sources.rewardForNpc(SPIDER);
    close(Rewards.killShare(five, spiderReward), 1 / 5, 'an untargeted kill takes Poison Spider 1 in 5');
    close(Rewards.killShare(five, spiderReward, { targeted: true }), 0.75, 'an aimed kill takes Poison Spider unless interrupted');
    // The roll gives the planner's shares (fixed-seed draws).
    // mulberry32: 32-bit integer steps (Math.imul), no precision loss, period 2^32.
    let seed = 12345;
    const rng = () => {
        seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const frequency = (options) => {
        let hits = 0;
        for (let i = 0; i < 20000; i++) if (Profile.npcForSpot(five, rng, options)?.selfId === SPIDER) hits++;
        return hits / 20000;
    };
    assert(Math.abs(frequency({}) - 0.2) < 0.015, 'the untargeted roll takes Poison Spider 1 in 5');
    assert(Math.abs(frequency({ preferredNpcId: SPIDER }) - 0.75) < 0.015, 'the aimed roll takes Poison Spider 3 in 4');
    // The roll aims where the planner priced it: a craft plan hunting a
    // material at Poison Spider aims at it like a gear drop plan does.
    const Aim = require('../src/GameServer/Bot/Population/PartyHuntingTarget');
    const hunt = { spotId: 'five', npcId: SPIDER, kind: 'drop', sourceKind: 'drop', itemId: 1, amount: 1 };
    assert.equal(Aim.planTargetNpcId({ status: 'active', strategy: 'craft', next: hunt }), SPIDER, 'a craft material hunt aims at its source');
    assert.equal(Aim.planTargetNpcId({ status: 'active', strategy: 'direct_drop', next: hunt }), SPIDER, 'a gear drop hunt aims at its source');
    assert.equal(Aim.planTargetNpcId({ status: 'active', strategy: 'market', next: null }), 0, 'a market plan aims at nothing');
    // Party item hours aim at the goal's NPC: one unit takes 1 / (kills x yield x 3/4).
    const spiderItem = [...new Set((spiderReward.rewards || []).flatMap(group => (group.items || []).map(item => Number(item.selfId))))]
        .find(id => id !== 57);
    const spiderLevel = Number(npcOf(SPIDER).template.level);
    const spiderHunter = { characterId: 990302, level: spiderLevel, stats: { role: 'dps', classId: 0 } };
    const spiderYield = Planner.itemDropYield(spiderReward, spiderItem, 'drop', { npcLevel: spiderLevel, killerLevel: spiderLevel }).expectedYield;
    assert(spiderYield > 0, 'Poison Spider drops the item');
    close(PartyIncome.itemHours(spiderHunter, five, 10, { npcId: SPIDER, itemId: spiderItem, sourceKind: 'drop', amount: 1 }, [spiderHunter]),
        1 / (10 * spiderYield * 0.75), 'party item hours count the aimed share');
    console.log('PASS spot kill share: hunted NPCs only, aliases credited to their loot table, aimed kills by the roll, one units-per-kill for every reader');
} finally {
    Table.useFile(); Table.useSpots([]);
    useRate(savedRate);
}
