const assert = require('assert');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('fx-npc-kit-offer');
const fixtureFs = require('node:fs');
require('../src/Global');
fixture.assertConfigured(options.default);
process.on('exit', () => fixtureFs.rmSync(fixture.directory, { recursive: true, force: true }));
const Data = invoke('GameServer/DataCache');
Data.init();
const Gear = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Market = invoke('GameServer/Bot/Economy/MarketOpportunity');
const OfferQuery = require('../src/GameServer/Bot/Economy/OfferQuery');

// R1 (user 2026-10-24): a bot buys its NPC kit item where it lands cheapest,
// the NPC or a visible bot line, each with its trip; one price rule for every
// bot. Live: bots paid the Giran NPC 3.08M for D weapons a bot line sold at
// ~0.74M. The planner's market is the caller's (the worker's
// ColdNpcPlanningCatalog: NPC rows plus the board through OfferQuery).
const trip = (town) => (town === 'Dion' ? 50000 : 0);
const npcOffer = (target) => OfferQuery.bestSellOffer(null, Number(target.selfId),
    { cost: trip, others: Market.npcOffersAll(target.selfId) });
const marketWith = (lines) => ({
    findNpcOffer: npcOffer,
    findMarketOffer: (target) => OfferQuery.bestSellOffer(null, Number(target.selfId), {
        cost: trip,
        others: [...Market.npcOffersAll(target.selfId), ...lines.filter((line) => line.selfId === Number(target.selfId))]
    })
});
// Level-30 archer still carrying the dagger of its former class: its kit buys a D weapon.
const archer = {
    characterId: 9400101, level: 30, adena: 20000000, stats: { classId: 37, role: 'archer' },
    inventory: {
        223: { selfId: 223, amount: 1, equipped: true, equippedSlots: [7], slot: 7 },
        57: { selfId: 57, amount: 20000000 }
    }
};

// No bot line: the NPC sells the kit weapon.
const npcOnly = Gear.staticNpcUpgradePlan(archer, marketWith([]));
assert(npcOnly?.target?.selfId, 'fixture: the kit buys a weapon');
assert.strictEqual(npcOnly.market.sourceType, 'npc', 'with no bot line the kit is bought from the NPC');
const npcPrice = Number(npcOnly.market.price);
const weaponId = Number(npcOnly.target.selfId);

// A bot line of the same weapon at a quarter of the NPC price in Dion, a
// reachable town: it lands cheaper with its trip, so the bot buys it there.
const line = { sourceType: 'afk_bot_store', sourceId: 9400999, recordId: 1, lineId: 1, town: 'Dion',
    selfId: weaponId, price: Math.floor(npcPrice / 4), count: 1, available: true };
const withLine = Gear.staticNpcUpgradePlan(archer, marketWith([line]));
assert.strictEqual(Number(withLine?.target?.selfId), weaponId, 'the same kit weapon');
assert.notStrictEqual(withLine.market.sourceType, 'npc', 'the cheaper bot line wins over the NPC');
assert.strictEqual(withLine.market.town, 'Dion');
assert.strictEqual(Number(withLine.market.price), line.price);

// The same rule for the unarmed bot's weapon bridge.
const bridge = Gear.npcWeaponBridgePlan(archer, marketWith([line]));
assert.strictEqual(Number(bridge?.target?.selfId), weaponId);
assert.strictEqual(bridge.market.town, 'Dion', 'the weapon bridge takes the cheaper bot line too');

// The bridge's budget is the trip gate's (PurchaseFunding.tripEscrow): the
// bot's own buy-order escrow counts only for an NPC purchase. Wallet half the
// cheapest NPC bridge P, escrow P, a bot line of that weapon at 0.8P: the
// wallet cannot pay the line, wallet plus escrow pays the NPC, so the bot
// buys that same weapon from the NPC at P (not a dearer weapon, not the line
// it would only save for).
{
    const Funding = invoke('GameServer/Bot/Economy/PurchaseFunding');
    const cheapest = Gear.npcWeaponBridgePlan(archer, marketWith([]));
    assert.strictEqual(cheapest?.market?.sourceType, 'npc', 'fixture: an NPC bridge weapon');
    const price = Number(cheapest.market.price), wallet = Math.floor(price / 2), escrow = price;
    const poor = { ...archer, adena: wallet, inventory: { ...archer.inventory, 57: { selfId: 57, amount: wallet } } };
    const below = { ...line, town: 'Gludio', selfId: Number(cheapest.target.selfId), price: Math.floor(price * 0.8) };
    const plan = Gear.npcWeaponBridgePlan(poor, { ...marketWith([below]), buyOrderEscrow: escrow });
    assert(plan?.weaponBridge, 'the unarmed bot plans a bridge weapon');
    assert.strictEqual(Number(plan.target?.selfId), Number(cheapest.target.selfId), 'the cheapest bridge weapon itself');
    assert.strictEqual(plan.market.sourceType, 'npc', 'the line the wallet cannot pay loses to the NPC the escrow pays');
    assert.strictEqual(Number(plan.market.price), price, 'bought at the NPC price');
    assert(Funding.budget(poor, Funding.tripEscrow(plan, escrow)) >= price,
        'the planned bridge passes the trip gate: the bot buys, it does not stay unarmed');
}

console.log('npc kit cheapest offer OK');
