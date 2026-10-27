'use strict';
// A far buyer's review command takes a conditional sale line. The seller's and
// the buyer's worker consent arrive only after the command has ended (main
// waits the command queue before asking the worker), so the meeting accept
// writes after the review is over. It is judged by its own preparation proofs.
// Nothing the build read moved: the buyer leaves on its meeting route. A
// board line of another item of the same market counter changed between the
// consent and the accept (a deal of that item changes its line): the build read
// the counter's group, the accept is refused.
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Meetings = require('../src/GameServer/AfkTrade/TradeMeetingService');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const Intent = require('../src/GameServer/Bot/Economy/TradeIntent');
const EconomyCommit = require('../src/GameServer/Bot/Economy/EconomyCommit');
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
const Workshops = invoke('GameServer/Bot/Economy/CraftWorkshopService');
const Codec = require('../src/GameServer/AfkTrade/TradeMeetingCodec');
const other = 730250, point = { locX: 83396, locY: 147904, locZ: -3400 };
const SCENARIOS = [{ buyer: 730241, seller: 730242, moves: false }, { buyer: 730243, seller: 730244, moves: true }];
const flush = async () => { for (let n = 0; n < 24; n++) await new Promise(resolve => setImmediate(resolve)); };
async function scenario({ buyer, seller, moves }) {
    for (const id of [buyer, seller]) {
        await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 120000, slot: 0 });
        if (id === seller) await Database.setItem(id, { selfId: 1867, name: 'Animal Skin', amount: 10, slot: 0 });
        await Life.upsertState({ characterId: id, phase: 'cold', activity: 'shopping', level: 30,
            adena: 120000, inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
            loc: id === seller ? point : { ...point, locX: point.locX + 10000 }, currentRegion: 'Giran',
            vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, stats: { money: [100, 0, 1000, 0] }, timing: {} }, 'fixture');
    }
    const source = (await Database.fetchItems(seller)).find(row => row.selfId === 1867);
    await Database.replaceBoardRecords(seller, 'sell_ad', [{ storeType: Afk.SELL, title: 'Fixture sale', town: 'Giran', ...point,
        lines: [{ objectId: source.id, selfId: 1867, name: 'Animal Skin', count: 10, price: 100, stackable: true }] }], { expected: {} });
    Afk.refreshRecord((await Database.fetchAfkTradeShops(seller))[0]);
    const line = Afk.boardIndex().ownerLines(seller)[0];
    // The worker's consent is the edge: both sides approve, only once the
    // review command has returned, with the proof main checks at accept.
    let consent, moved = false;
    const consented = new Promise(resolve => { consent = resolve; });
    const scope = MarketCounters.counterOf(1867), STEM = 1864;
    assert.equal(MarketCounters.counterOf(STEM), scope, 'the other item shares the skin\'s market counter');
    Coordinator.requestMeetingPreparation = async (id, request) => {
        await consented;
        const side = request.actorA === id ? 0 : 1;
        const dependencies = [[1867, Codec.dependencyToken(Afk.boardIndex().groupFingerprint(scope), Workshops.publicScopeDigest(scope))]];
        if (moves && !moved) {
            // Another item of the counter is sold on the board after this side consented: its line changes.
            moved = true;
            await Database.setItem(other, { selfId: STEM, name: 'Stem', amount: 5, slot: 0 });
            const stem = (await Database.fetchItems(other)).find(row => row.selfId === STEM);
            await Database.replaceBoardRecords(other, 'sell_ad', [{ storeType: Afk.SELL, title: 'Other sale', town: 'Giran', ...point,
                lines: [{ objectId: stem.id, selfId: STEM, name: 'Stem', count: 5, price: 50, stackable: true }] }], { expected: {} });
            Afk.refreshRecord((await Database.fetchAfkTradeShops(other))[0]);
        }
        return { approved: true, token: request.token, characterId: id, sequence: request.parties[side].sequence,
            epoch: Coordinator.workerEpoch, worker: Coordinator.worker,
            authority: EconomyCommit.authority(Life.cachedState(id)), dependencies, sources: [[line.recordId, line.revision]],
            route: request.parties[side].route, certificates: request.lines.map(row => row.payer === side
                ? Intent.encode({ itemId: row.selfId, amount: row.count, price: row.price,
                    key: `resale:${row.selfId}`, recipeId: 0, valueHours: 2, valueRate: 100 }) : null) };
    };

    const coordinator = new ColdSimulationCoordinator();
    const answers = [];
    coordinator.worker = { postMessage: message => message.type === 'command_ack' && answers.push(...message.payload.results) };
    coordinator.workerEpoch = 'review-meeting:test';
    const review = async (n, economyPlan) => {
        coordinator.handleCommandRequest({ msgId: `review:${n}`, payload: { requests: [{
            characterId: buyer, kind: 'review', commandId: `review:${buyer}:${n}`,
            commandCheckpoint: Protocol.commandCheckpoint(Life.cachedState(buyer)), economyPlan }] } });
        await coordinator.commandTail;
    };
    // The fixture row's first review saves the buyer once; the next card is made on that row.
    await review(0, {});
    await review(1, { take: [Afk.SELL, 1867, 4, line.recordId, line.lineId, line.revision, line.price] });
    assert.equal(answers.at(-1)?.ok, true, 'the review command itself succeeds');
    assert.equal(await Database.fetchTradeMeetingForOwner(buyer), null, 'no meeting before the worker consents');

    consent();
    await flush();
    const meeting = await Database.fetchTradeMeetingForOwner(buyer);
    if (!moves) {
        assert.equal(meeting?.state, 'accepted', 'the meeting prepared by the review is accepted after the command ended');
        assert.equal(Life.cachedState(buyer).activity, 'traveling', 'the buyer starts its meeting route');
    } else {
        assert.equal(meeting, null, 'a changed line of the group the build read refuses the meeting');
        assert.notEqual(Life.cachedState(buyer).activity, 'traveling', 'the buyer does not leave');
    }
    coordinator.unsubscribeWishRemovals();
    await flush(); Meetings.reset(); Afk._resetForTests();
}
(async () => {
    const world = await createWorld([other, ...SCENARIOS.flatMap(row => [row.buyer, row.seller])].map(id => ({ id, level: 30 })), 'review-meeting-accept');
    const prepare = Coordinator.requestMeetingPreparation;
    try {
        await Database.createAccount('bot_review_meeting_fixture', 'test');
        await Database.execute(["UPDATE characters SET username='bot_review_meeting_fixture' WHERE id IN (?,?,?,?)", SCENARIOS.flatMap(row => [row.buyer, row.seller])]);
        await Life.init();
        for (const row of SCENARIOS) await scenario(row);
        console.log('PASS review meeting accept: a meeting prepared by a review command is accepted after the command ended, refused when a line of the read group moved');
    } finally {
        await flush(); Meetings.reset(); Afk._resetForTests();
        Coordinator.requestMeetingPreparation = prepare;
        await world.close();
    }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
