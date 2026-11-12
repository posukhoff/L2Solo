'use strict';
// The economy design's worth of a gear piece on inline kit numbers: today's
// gear gain carried over and the hunt cycle's income difference, in hours of
// the bot's own hour and in adena, and the buyer's cap it sets against the
// seller's floor.
const assert = require('node:assert/strict');
const Worth = require('../scripts/economy-model/rules/worth');
const Bounds = require('../scripts/economy-model/rules/bounds');
const { priceStep } = require('../scripts/economy-model/rules/priceStep');

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)), `${message}: ${actual} vs ${expected}`);
const kit = { pAtk: 200, mAtk: 120, pDef: 300, mDef: 200 };
const betterWeapon = { ...kit, pAtk: 300 };
const view = { before: kit, after: betterWeapon, caster: false, threatMask: 3, deathHours: 2, horizonHours: 100, ownHour: 30000 };

// A better weapon is worth its attack gain over the hours to the end of the
// stage, in adena at the own hour.
const weapon = Worth.gearWorth(view);
near(weapon.perHour, 0.5, 'P.Atk 200 -> 300 adds half the hour');
near(weapon.hours, 50, 'over 100 hours to the end of the stage');
near(weapon.adena, 1.5e6, 'at 30k an hour');
assert.ok(Worth.huntCycleWorth({ incomeWith: 36000, incomeWithout: 30000, horizonHours: 100 }).adena > 0, 'the hunt cycle agrees it is worth something');
// A caster reads M.Atk; armour its defence times the hours a death costs, P.Def alone against a threat that only hits.
near(Worth.gearWorth({ ...view, caster: true }).perHour, 0, 'a P.Atk weapon adds nothing to a caster');
const armour = { ...kit, pDef: 400, mDef: 250 };
near(Worth.gearWorth({ ...view, after: armour }).perHour, 0.25 * 2, 'the better of 1 - 300/400 and 1 - 200/250, times 2 death hours');
near(Worth.gearWorth({ ...view, after: { ...kit, mDef: 250 }, threatMask: 1 }).perHour, 0, 'M.Def is worth nothing against hits alone');
near(Worth.gearWorth({ ...view, after: { ...kit, pDef: 310, mDef: 250 } }).perHour, 0.2 * 2, 'a jewel whose M.Def gain beats its P.Def gain: the M.Def gain against a threat that may cast');

// Worth in adena scales with the own hour (the gear gain is in hours); the
// hunt cycle's is the income difference itself.
near(Worth.gearWorth({ ...view, ownHour: 1.5e6 }).adena, 50 * weapon.adena, 'a 50x own hour, a 50x worth');
near(Worth.huntCycleWorth({ incomeWith: 36000, incomeWithout: 30000, horizonHours: 100 }).adena, 6000 * 100, 'income difference times the hours');
near(Worth.huntCycleWorth({ incomeWith: 36000, incomeWithout: 30000, horizonHours: 100 }).perHour, 0.2, 'a fifth of the hour without the piece');
near(Worth.huntCycleWorth({ incomeWith: 25000, incomeWithout: 30000, horizonHours: 100 }).adena, 0, 'a piece that costs income is worth nothing');

// A piece the class cannot use is worth nothing, whatever its numbers.
assert.deepEqual(Worth.gearWorth({ ...view, usable: false }), { perHour: 0, hours: 0, adena: 0 });

// A cap under the floor is reported as it is: the buyer's line never climbs
// over its cap, the seller's never drops under its floor, and no deal meets.
const small = Worth.gearWorth({ ...view, after: { ...kit, pAtk: 202 }, horizonHours: 2 });
const cap = Bounds.cap({ worth: small.adena, npcSell: 70000 }), floor = Bounds.floor({ npcBuy: 30000, crystallizerBids: [33000] });
assert.deepEqual(cap, { cap: small.adena, by: 'worth' }, 'the worth caps the buyer');
assert.ok(cap.cap < floor, `cap ${cap.cap} under floor ${floor}`);
const persona = { looksToFloor: 3, buyerStart: 0.8 };
let buy = priceStep({ side: 'buy' }, { look: 0, cap: cap.cap, capBy: cap.by, first: 60000, persona });
let sell = priceStep({ side: 'sell' }, { look: 0, floor, first: 60000, persona });
for (let look = 1; look <= 4; look++) {
    buy = priceStep(buy, { look, cap: cap.cap, capBy: cap.by, persona });
    sell = priceStep(sell, { look, floor, persona });
    assert.ok(buy.price <= cap.cap && sell.price >= floor && buy.price < sell.price, `look ${look}: no deal under the floor`);
}
assert.equal(buy.close, 'parked', 'the want is parked after two looks at its worth');

// The worth's gear gain is today's (WishProviders.gearGain) on a reference
// bot: a Hawkeye-line archer at 40 in its author's kit, a better bow, a
// chest piece and a necklace (M.Def only).
{
    const Boot = require('../scripts/economy-model/boot');
    const Data = Boot.boot('x1');
    const Index = require('../src/GameServer/Item/ItemTemplateIndex');
    const Table = invoke('GameServer/Bot/AI/SpotValueTable'), HuntCycle = invoke('GameServer/Bot/AI/HuntCycle');
    const Wish = invoke('GameServer/Bot/Economy/WishProviders'), Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
    const Equipment = require('../src/GameServer/Bot/AI/BotEquipmentCompatibility');
    const caster = invoke('GameServer/Bot/Economy/BotImprovementPolicy').isCaster;
    const state = HuntCycle.referenceState(Table.roleClass('9', 40), 40, { line: 9 });
    const candidates = Profile.candidateProfiles(state, 0, {});
    for (const [selfId, part] of [[283, 'attack'], [60, 'defence'], [119, 'defence']]) {
        const item = Index.find(Data.items, selfId), slot = Number(item.etc.slot);
        const after = candidates.after({ free: worn => Equipment.equipmentReplacementConflict(slot, worn), wear: { selfId, enchant: 0, slot } });
        const at = deathHours => Worth.gearWorth({ before: candidates.before, after, caster: caster(state), threatMask: 3, deathHours, horizonHours: 1, ownHour: 1 }).perHour;
        const today = Wish.gearGain(state, item, 0, 3);
        assert.ok(today[part] > 0, `${item.template.name} adds ${part} today`);
        near(at(0), today.attack, `${item.template.name}: attack gain as today's`);
        near(at(1) - at(0), today.defence, `${item.template.name}: defence gain as today's`);
    }
}

console.log('test_economy_model_worth: ok');
