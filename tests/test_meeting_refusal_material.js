'use strict';
// meetmaterial: no cold shopper stays in town forever. A material buyer whose
// meeting was refused does not stage the same refused deal again on its next
// step (its arrival buy skips the refused line, ReadyTradeChoice.meetingRefused),
// and a clan shopper whose party is gone and who kept no way back leaves the
// town for a hunting spot.
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Meetings = invoke('GameServer/AfkTrade/TradeMeetingService');
const Market = invoke('GameServer/Bot/Economy/ColdMarketService');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const buyer = 730271, seller = 730272, clanShopper = 730273, SKIN = 1867;
const GIRAN = { locX: 83396, locY: 147904, locZ: -3400 };
const FIELD = { locX: 86000, locY: 152000, locZ: -3500 };
const flush = async () => { for (let n = 0; n < 24; n++) await new Promise(resolve => setImmediate(resolve)); };

async function bot(id, stats = {}) {
    await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 120000, slot: 0 });
    if (id === seller) await Database.setItem(id, { selfId: SKIN, name: 'Animal Skin', amount: 10, slot: 0 });
    await Life.upsertState({ characterId: id, phase: 'cold', activity: 'shopping', level: 30, adena: 120000,
        inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)), loc: GIRAN, currentRegion: 'Giran',
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
        stats: { money: [100, 0, 1000, 0], ...stats }, timing: {} }, 'fixture');
}

(async () => {
    const world = await createWorld([buyer, seller, clanShopper].map(id => ({ id, level: 30 })), 'meeting-refusal-material');
    const prepare = Coordinator.requestMeetingPreparation, refresh = Coordinator.requestEconomyRefresh;
    try {
        await Database.createAccount('bot_meeting_material_fixture', 'test');
        await Database.execute(["UPDATE characters SET username='bot_meeting_material_fixture' WHERE id IN (?,?,?)", [buyer, seller, clanShopper]]);
        await Life.init();
        await bot(buyer, { marketReturn: { loc: FIELD, regionName: 'Giran Territory', spotId: null } });
        await bot(seller);
        const source = (await Database.fetchItems(seller)).find(row => row.selfId === SKIN);
        await Database.replaceBoardRecords(seller, 'sell_ad', [{ storeType: Afk.SELL, title: 'Fixture sale', town: 'Giran', ...GIRAN,
            lines: [{ objectId: source.id, selfId: SKIN, name: 'Animal Skin', count: 10, price: 100, stackable: true }] }], { expected: {} });
        Afk.refreshRecord((await Database.fetchAfkTradeShops(seller))[0]);

        // The seller refuses every meeting; the coordinator is the edge.
        Coordinator.requestEconomyRefresh = () => true;
        Coordinator.requestMeetingPreparation = id => id === seller
            ? Promise.reject(Error('trade_meeting_route')) : Promise.resolve({ characterId: id });
        const goal = { type: 'buy_craft_material', status: 'active', target: { itemId: SKIN, itemName: 'Animal Skin', amount: 1, adena: 100 },
            plan: { expectedBenefit: 'market_buy_craft_material', marketTown: 'Giran', purpose: 'supply', valueRate: 1 } };

        const first = await Market.tryPurchase(Life.cachedState(buyer), goal);
        await flush();
        assert.equal(first.pending, true, 'the material buyer stages a meeting on the board line');
        for (let n = 0; n < 40 && !Life.cachedState(buyer).stats?.meetingRefused; n++) await flush();
        const refused = await Market.tryPurchase(Life.cachedState(buyer), goal);
        await flush();
        assert.notEqual(refused.pending, true, 'the next step does not ask the refused line again');
        assert.equal(Meetings.hasPreparation(buyer), false, 'no new meeting is staged');

        // A clan shopper whose party is gone and who kept no marketReturn: its
        // market step ends the visit at a hunting spot (it shopped forever).
        await bot(clanShopper, { partyMarketReturn: { partyId: 987654321, characterId: clanShopper, objective: {} } });
        const shopping = Life.cachedState(clanShopper);
        const done = await Population.finishColdMarketStep(shopping, null, null, null,
            { state: shopping, closed: true }, { state: shopping, purchased: false }, null);
        const left = Life.cachedState(clanShopper) || done;
        assert.notEqual(left.activity, 'shopping', 'the clan shopper with no way back leaves the town');
        assert.equal(left.stats?.partyMarketReturn ?? null, null, 'its dead party\'s return is cleared');
        console.log('PASS a refused material line is not asked again; a shopper with no return leaves town');
    } finally {
        Coordinator.requestMeetingPreparation = prepare; Coordinator.requestEconomyRefresh = refresh;
        await flush(); Meetings.reset(); Afk._resetForTests();
        await world.close();
    }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
