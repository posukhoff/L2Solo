'use strict';
// meetstuck: where two trade parties meet when one has karma (user 10-25: a
// bot with karma trades outside town or in Floran; Karma.townFor), and what a
// refused meeting does: the owner's deal refusal keeps the refused line on
// every refused trader's row, so its planners skip that line until the ad's
// revision moves; the trader's own refusal and a refusal of the
// moment (a busy worker) record nothing.
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Meetings = invoke('GameServer/AfkTrade/TradeMeetingService');
const Market = invoke('GameServer/Bot/Economy/ColdMarketService');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const ColdTrip = require('../src/GameServer/Bot/Population/ColdTrip');
const Ready = require('../src/GameServer/Bot/Economy/ReadyTradeChoice');
const Karma = require('../src/GameServer/Karma');
const GearPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const NpcCatalog = require('../src/GameServer/Bot/Population/ColdNpcPlanningCatalog');
const Evidence = require('../src/GameServer/Bot/Economy/WishPurchaseEvidence');
const { SELL } = require('../src/GameServer/AfkTrade/BoardIndex');
const buyer = 730261, karmaSeller = 730262, seller = 730263, buyer2 = 730264, SKIN = 1867;
const GIRAN = { locX: 83396, locY: 147904, locZ: -3400 };
const FLORAN = { locX: 17144, locY: 170156, locZ: -3504 };
const DION = { locX: 15670, locY: 142983, locZ: -2705 };
const flush = async () => { for (let n = 0; n < 24; n++) await new Promise(resolve => setImmediate(resolve)); };
const settle = async done => { for (let n = 0; n < 40 && !done(); n++) await flush(); };

async function bot(id, karma = 0) {
    await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 120000, slot: 0 });
    if (id !== buyer && id !== buyer2) await Database.setItem(id, { selfId: SKIN, name: 'Animal Skin', amount: 10, slot: 0 });
    await Life.upsertState({ characterId: id, phase: 'cold', activity: 'shopping', level: 30, adena: 120000,
        inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)), loc: GIRAN, currentRegion: 'Giran',
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
        stats: { money: [100, 0, 1000, 0], ...(karma ? { karma } : {}) }, timing: {} }, 'fixture');
}
async function sellAd(id, price = 100) {
    const source = (await Database.fetchItems(id)).find(row => row.selfId === SKIN);
    await Database.replaceBoardRecords(id, 'sell_ad', [{ storeType: Afk.SELL, title: 'Fixture sale', town: 'Giran', ...GIRAN,
        lines: [{ objectId: source.id, selfId: SKIN, name: 'Animal Skin', count: 10, price, stackable: true }] }], { expected: {} });
    Afk.refreshRecord((await Database.fetchAfkTradeShops(id))[0]);
    return Afk.boardIndex().ownerLines(id)[0];
}

(async () => {
    const world = await createWorld([buyer, karmaSeller, seller, buyer2].map(id => ({ id, level: 30 })), 'karma-meeting-refusal');
    const prepare = Coordinator.requestMeetingPreparation, refresh = Coordinator.requestEconomyRefresh;
    try {
        await Database.createAccount('bot_karma_meeting_fixture', 'test');
        await Database.execute(["UPDATE characters SET username='bot_karma_meeting_fixture' WHERE id IN (?,?,?,?)", [buyer, karmaSeller, seller, buyer2]]);
        await Life.init();
        await bot(buyer);
        await bot(karmaSeller, 500);
        await bot(seller);
        await bot(buyer2);

        // A karma seller's Giran ask is met in Floran, the one town it enters:
        // the quote names Floran (every later price of the trip reads it), and
        // both sides have a route there.
        const karmaLine = await sellAd(karmaSeller);
        const karma = await Meetings.prepareTrade(buyer, { shopId: karmaLine.recordId }, SKIN, 1, { lineId: karmaLine.lineId, preview: true });
        assert.equal(karma.town, Karma.TOWN_NAME, 'a karma seller\'s Giran ask is met in Floran');
        assert.deepEqual(karma.point, FLORAN);
        for (const id of [buyer, karmaSeller]) assert(ColdTrip.meetingTownPlan(Life.cachedState(id), karma.point), `${id} has a route to Floran`);

        // An anchored party's earlier meeting counts only in the meeting's town.
        const giranRecord = { town: 'Giran', ...GIRAN };
        assert.deepEqual(Meetings.meetingPoint(giranRecord, [buyer, seller], { town: 'Dion', ...DION }), { town: 'Giran', ...GIRAN },
            'an anchor in another town is ignored: the shop');
        assert.deepEqual(Meetings.meetingPoint(giranRecord, [buyer, karmaSeller], { town: 'Giran', ...GIRAN }), { town: Karma.TOWN_NAME, ...FLORAN },
            'a karma party meets in Floran, not at a Giran anchor');

        // The coordinator is the edge (the worker): its replies are stubbed;
        // the outcome read is the trader's row and its next take.
        Coordinator.requestEconomyRefresh = () => true;
        const refuseBy = (parties, reason) => {
            Coordinator.requestMeetingPreparation = id => parties.includes(id)
                ? Promise.reject(Error(reason)) : Promise.resolve({ characterId: id });
        };
        const ask = async (owner = seller, trader = buyer) => {
            const result = await Market.buyOffer(Life.cachedState(trader), Afk.offerOf(Afk.boardIndex().ownerLines(owner)[0]));
            await flush(); return result;
        };
        const refused = (trader = buyer) => Life.cachedState(trader).stats?.meetingRefused;
        const takes = (row, trader = buyer) => Ready.resolve([SELL, SKIN, 1, row.recordId, row.lineId, row.revision, row.price],
            Afk.boardIndex(), trader)?.lineId === row.lineId;
        // The cheapest Giran ask: every search's first choice until refused.
        const line = await sellAd(seller, 95);
        // The worker gear planner's offer search (its planning options).
        const gearOffer = trader => GearPlanner.marketOfferForTarget({ selfId: SKIN }, Life.cachedState(trader),
            { ...NpcCatalog.createLookup([], () => Afk.boardIndex()).plannerOptions, origin: GIRAN })?.lineId;
        // The wish buy's quote (its leaf takes meeting ads only,
        // ReadyTradeChoice.preparedLeaf): one unit over the board, a Giran trip.
        const giranTrip = () => 0;
        giranTrip.details = town => ({ known: town === 'Giran', hours: 0, fees: 0 });
        const wishQuote = (trader, state = Life.cachedState(trader)) => Evidence.reader(state, { board: Afk.boardIndex(), trip: giranTrip },
            { npcOffersFor: () => [] })(SKIN, 1)?.unitPrice;

        // A refusal of the moment says nothing of the deal.
        refuseBy([seller], 'trade_meeting_dependency_pressure');
        assert.equal((await ask()).pending, true, 'the ask stages a meeting');
        await flush();
        assert.equal(refused(), undefined, 'a busy worker\'s refusal records no refused line');

        // The trader's own deal refusal (its money): the line is not at fault.
        // Nothing is recorded; its next step may take the line.
        refuseBy([buyer], 'trade_meeting_funding');
        assert.equal((await ask()).pending, true);
        await flush(); await flush();
        assert.equal(refused(), undefined, 'the trader\'s own refusal records no refused line');
        assert(takes(line), 'its next step may take the line again');

        // The owner's deal refusal: the trader keeps the refused line and
        // revision; its planned take of that line is not executable.
        refuseBy([seller, karmaSeller], 'trade_meeting_route');
        assert.equal((await ask()).pending, true);
        await settle(() => refused());
        assert.deepEqual(refused(), [line.lineId, line.revision], 'the trader keeps the refused line and revision');
        assert.equal(takes(line), false, 'the trader\'s planned take of the refused line is not executable');
        assert(takes(line, buyer2), 'another trader still takes the line');
        assert.notEqual(gearOffer(buyer), line.lineId, 'the gear planner\'s offer search skips the refused line');
        assert.equal(gearOffer(buyer2), line.lineId, 'another trader\'s gear search still finds the line');
        assert.equal(wishQuote(buyer), 100, 'the wish buy quote skips the refused ad for the next one');
        assert.equal(wishQuote(buyer2), 95, 'another trader\'s wish buy quote still takes the refused ad');
        assert.equal(wishQuote(buyer2, { ...Life.cachedState(buyer2), partyId: 3 }), undefined,
            'a buyer in a party takes no meeting ad');

        // A second trader refused on the same ad revision keeps its own
        // refused line: the first trader's refusal does not use it up.
        assert.equal((await ask(seller, buyer2)).pending, true);
        await settle(() => refused(buyer2));
        assert.deepEqual(refused(buyer2), [line.lineId, line.revision], 'the second refused trader keeps the line and revision');
        assert.equal(takes(line, buyer2), false, 'the line no longer resolves for the second trader');

        // A second owner's refusal keeps that line instead (one per bot); a
        // repeat refusal of the first line's same revision keeps it again.
        assert.equal((await ask(karmaSeller)).pending, true);
        await settle(() => refused()?.[0] === karmaLine.lineId);
        assert.deepEqual(refused(), [karmaLine.lineId, karmaLine.revision], 'the second refused line is kept');
        assert.equal((await ask()).pending, true);
        await settle(() => refused()?.[0] === line.lineId);
        assert.deepEqual(refused(), [line.lineId, line.revision], 'a repeat refusal of the same ad revision is kept again');

        // A new ad revision is a new deal: the take executes, and a refusal
        // of it is kept again.
        await Database.repriceAfkTradeShop(seller, line.lineId, 90, line.revision);
        Afk.refreshRecord((await Database.fetchAfkTradeShops(seller))[0]);
        const next = Afk.boardIndex().ownerLines(seller)[0];
        assert.notEqual(next.revision, line.revision);
        assert(takes(next), 'the new revision of the refused line is executable');
        assert.equal((await ask()).pending, true, 'the buyer asks the new revision');
        await settle(() => refused()?.[1] === next.revision);
        assert.deepEqual(refused(), [next.lineId, next.revision], 'the refusal of the new revision is kept');
        console.log('PASS karma meeting in Floran; an owner\'s refusal keeps the trader off the refused line, its own refusal records nothing');
    } finally {
        Coordinator.requestMeetingPreparation = prepare; Coordinator.requestEconomyRefresh = refresh;
        await flush(); Meetings.reset(); Afk._resetForTests();
        await world.close();
    }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
