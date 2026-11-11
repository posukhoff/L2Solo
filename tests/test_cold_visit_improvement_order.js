'use strict';
// A far bot's town visit collects what it banked for its held exchange before it trades:
// the luxury exchange it came for is made on that visit from the bag the warehouse
// release filled, and what the exchange does not use stays banked (no refusal, no
// withdraw-then-deposit of the same crystals).
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('cold-visit-improvement-order');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const DB = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const Native = require('./helpers/nativeMarketFixture');
const Gear = invoke('GameServer/Bot/AI/BotGear');
const Index = invoke('GameServer/Bot/Economy/PersonalWarehouseIndex');
const location = { locX: 83396, locY: 147904, locZ: -3400 };
const id = 9661, CRYSTAL = 1458;
async function run() {
    let rows = [];
    try {
        fixture.assertConfigured(options.default);
        await DB.init(); await Life.init();
        await Native.character(DB, id, 'BankedExchange', 'bot_banked_exchange', location);
        await DB.execute(['UPDATE characters SET level=33,classId=54,race=4,exp=? WHERE id=?', [Data.experience[32], id]]);
        await DB.setItem(id, { selfId: 57, name: 'Adena', amount: 30000000 });
        for (const row of Gear.planFor({ classId: 54, level: 20 }).items)
            await DB.setItem(id, { ...row, amount: 1, equipped: true, enchant: 0,
                name: Data.items.find(item => item.selfId === row.selfId).template.name });
        await DB.setItem(id, { selfId: CRYSTAL, name: 'Crystal: D-Grade', amount: 50, stackable: true });
        await DB.execute(['INSERT INTO warehouse_items(characterId,selfId,name,amount,enchant) VALUES(?,?,?,?,0)',
            [id, CRYSTAL, 'Crystal: D-Grade', 245]]);
        Index.useRowSource(owner => Number(owner) === id ? Index.prepareRow([id, 1, rows]) : undefined, () => true);
        rows = [[CRYSTAL, 245, 0]];

        const Luxury = invoke('GameServer/Bot/Economy/BotLuxuryExchange');
        const earring = { kind: 'luxury_exchange', ...Luxury.recipes().get(852) };
        assert.deepEqual(earring.materials, [{ selfId: CRYSTAL, amount: 195 }], 'the earring costs 195 D crystals');
        let state = await Life.upsertState({ characterId: id, accountName: 'bot_banked_exchange', name: 'BankedExchange',
            phase: 'cold', activity: 'shopping', level: 33, exp: Data.experience[32], adena: 30000000,
            currentRegion: 'Giran', loc: location, inventory: Life.inventorySummaryFromItems(await DB.fetchItems(id)), timing: {},
            vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 }, stats: { classId: 54, money: [0, 0, 0, 0],
                equipmentPlan: { strategy: 'luxury_exchange', status: 'active', target: { selfId: 852, slot: 1 },
                    exchange: earring, materials: earring.materials } } }, 'banked_exchange_fixture');
        assert(Luxury.eligible(state, earring), 'the bot may take the C earring');

        const Decision = invoke('GameServer/Bot/Population/ColdEconomyDecision');
        const Population = invoke('GameServer/Bot/Population/PopulationService');
        const visit = await Population.resolveColdState(state, {
            precomputedPlan: { previousPlan: state.stats.equipmentPlan, acquisitionPlan: state.stats.equipmentPlan,
                economyDecision: Decision.capture({ riskWeight: 1, network: { activity: {
                    activity: 'improving', kind: 'luxury_exchange', improvement: earring, town: 'Giran' } } }, state) },
            precomputedResult: { patch: {}, events: [], materialize: { exp: 0, sp: 0, adena: 0, items: [] },
                nextResolveAt: Date.now() + 30000, debug: {} }
        });
        assert(visit.ok, 'the visit applies');
        const bag = await DB.fetchItems(id), bank = await DB.fetchWarehouseItems(id);
        assert.equal(Native.amount(bag, 852), 1, 'the exchange is made on the visit that collects its banked crystals');
        assert.equal(visit.state.stats.lastImprovement?.kind, 'luxury_exchange');
        assert.equal(Native.amount(bag, CRYSTAL), 0, 'the bag paid 50 of its own and 145 collected from the bank');
        assert.equal(Native.amount(bank, CRYSTAL), 100, 'the 100 crystals the exchange does not use stay banked');
        assert(!(visit.state.stats.lastWarehouseDeposit?.items || []).some(item => Number(item.selfId) === CRYSTAL),
            'no collected crystal is deposited back on the same visit');
        console.log('Cold visit improvement order: a banked exchange input is collected before the exchange passed');
    } finally {
        Index.useRowSource();
        await DB.close(); fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
