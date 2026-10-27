'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker, MessageChannel } = require('node:worker_threads');
require('../src/Global');
const Geodata = require('../src/GameServer/Geodata/GeodataEngine');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const Codec = require('../src/GameServer/AfkTrade/TradeMeetingCodec');
const TradeIntent = require('../src/GameServer/Bot/Economy/TradeIntent');

// Fix only wish usefulness and NPC stock. The bilateral worker, route
// preparation, funding, transport and decision to return consent run their real code.
// heldBuild: a bot's own step build (the real one, remembered as its held
// build) wanting the given rows.
const source = `
const { workerData } = require('node:worker_threads');
require(workerData.workerPath);
const Economy = invoke('GameServer/Bot/Economy/EconomyContext'), build = Economy.forState;
let heldRows = null;
workerData.heldBuild.on('message', ({ state, rows }) => {
    heldRows = rows;
    try { build(state, { timestamp: Date.now() }); workerData.heldBuild.postMessage({ ok: true }); }
    catch (error) { workerData.heldBuild.postMessage({ error: String(error.stack) }); }
    finally { heldRows = null; }
});
Economy.forState = (state, options) => ({
    network: { quantityPrepared: true, queue: [] }, projection: {}, hourAdena: 1000, worth: () => 34454032, price: () => 34454032,
    trip: invoke('GameServer/Bot/Economy/EconomicTrip').preparedReader(options.routeRows, { hourAdena: 1000 }),
    kitCost: () => 0
});
invoke('GameServer/Bot/Economy/TradeIntent').project = () => heldRows || [{
    itemId: 413, amount: 2, worth: 34454032, key: 'resale:413', valueHours: 20, valueRate: 100
}];
invoke('GameServer/Bot/Population/ColdOccupationSources').npcOffersFor = id => id === 413
    ? [{ sourceType: 'npc', town: 'Giran', price: 80000 }]
    : id === 736 ? [{ sourceType: 'npc', town: 'Giran', price: 400 }] : [];
`;

(async () => {
    const epoch = 'wtb-meeting-limit', received = [], held = new MessageChannel();
    const worker = new Worker(source, { eval: true, transferList: [held.port2], workerData: { sharedGeodata: Geodata.sharedDescriptor(), workerEpoch: epoch,
        workerPath: path.resolve(__dirname, '../src/GameServer/Bot/Population/ColdSimulationWorker.js'), heldBuild: held.port2 } });
    let failure;
    worker.on('error', error => { failure = error; });
    worker.on('message', message => received.push(message));
    const send = (type, payload) => worker.postMessage(Protocol.envelope(type, epoch, payload));
    // Loading the worker (datapack, catalogues) alone can pass ten seconds
    // on a loaded machine; the meeting steps after it keep the short bound.
    const until = async (predicate, limitMs = 10000) => {
        const deadline = Date.now() + limitMs;
        while (!received.some(predicate)) {
            if (failure) throw failure;
            const fault = received.find(message => message.type === 'fault');
            if (fault) throw Error(JSON.stringify(fault.payload));
            if (Date.now() > deadline) throw Error(`meeting timeout: ${received.map(x => x.type).join(',')}`);
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        return received.find(predicate);
    };
    try {
        await until(message => message.type === 'ready' && message.payload.phase === 'loaded', 120000);
        send('catalog_page', { catalog: 'spots', rows: [], done: true });
        send('catalog_page', { catalog: 'npc_offers', rows: [], done: true });
        send('table_page', { tables: [{ name: 'board', from: null, to: 0, full: true, rows: [], removed: [] },
            { name: 'market', from: null, to: 0, full: true, rows: [], removed: [] }] });
        send('init', { config: { loopIntervalMs: 10, flushTargetMs: 10, flushHardMs: 50 } });
        await until(message => message.type === 'ready' && message.payload.phase === 'running');
        const now = Date.now(), point = { locX: 83396, locY: 147904, locZ: -3400 };
        const state = { characterId: 42, name: 'Buyer', accountName: 'bot_meeting_limit', level: 30,
            phase: 'cold', activity: 'shopping', currentRegion: 'Giran', loc: point, inventory: {}, adena: 1000000,
            vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 }, stats: { classId: 0 },
            timing: { lastResolvedAt: now, nextResolveAt: now + 600000 },
            simulation: { revision: 0 } };
        // An owner whose money packet funds a want only at a rate of 0.01 or more.
        const owner = { ...state, characterId: 44, name: 'Owner', accountName: 'bot_meeting_owner',
            stats: { classId: 0, money: [0, 0.01, 0, 0] } };
        send('snapshot_page', { rows: [{ state }, { state: owner }], done: true, ack: true });
        await until(message => message.type === 'ready' && message.payload.phase === 'state_loaded');
        const request = (token, price, selfId = 413, extra = {}, buyer = 42) => ({ token, actorA: buyer, actorB: buyer + 1, seqA: 1, seqB: 1, town: 'Giran', point,
            parties: [0, 1].map(() => ({ phase: 'cold', hotAt: 0,
                revision: 0, sequence: 1, route: { fee: 0, scroll: false, method: 'walk', durationMs: 0 } })),
            lines: [1, 2].map(itemId => ({ payer: 0, selfId, enchant: 0, itemId, count: 1, price, intentRevision: 0, ...extra })) });
        const prepare = input => {
            for (const frame of Codec.pages(input)) send('command_request', { requests: [{
                kind: 'meeting', characterId: input.actorA, commandId: input.token, frame }] });
        };
        // The bot's consent pages, acknowledged as main does: the last
        // acknowledgement frees the bot for its next preparation.
        const consent = async (token, buyer = 42) => {
            const frames = () => received.filter(message => message.type === 'command_request')
                .flatMap(message => message.payload.requests).filter(row => row.commandId === token).map(row => row.frame);
            await until(() => frames().length > 0 && frames().length === frames()[0][3]);
            for (const frame of frames()) send('command_ack', { results: [{ kind: 'meeting', characterId: buyer,
                commandId: token, pageIndex: frame[2], ok: true }] });
            return Codec.fromPages(frames());
        };
        const refusal = async token => (await until(message => message.type === 'command_ack'
            && message.payload.results?.some(row => row.commandId === token))).payload.results.find(row => row.commandId === token);
        // A buy from a sell ad (no certificate): an NPC sells the item at
        // 80000, so the bot refuses to pay more however much it wants it.
        prepare(request('expensive-purchase', 188565));
        const expensive = await until(message => message.type === 'command_ack'
            && message.payload.results?.some(row => row.commandId === 'expensive-purchase'));
        const overpay = expensive.payload.results.find(row => row.commandId === 'expensive-purchase');
        assert.equal(overpay.ok, false);
        assert.equal(overpay.reason, 'trade_meeting_purchase_price_changed');
        assert.equal(received.some(message => message.type === 'command_request'), false,
            'an expensive purchase produces no consent for native reservation');
        prepare(request('affordable-purchase', 80000));
        const affordable = await consent('affordable-purchase');
        assert.equal(affordable.lines.length, 2);
        assert(affordable.lines.every(line => TradeIntent.decode(line.certificate).price === 80000));

        // A seller fills the bot's own buy ad (storeType 3, custodyPolicy 1):
        // main attaches the ad's published certificate. The bot keeps no held
        // build (no step built one) and an NPC sells the item cheaper, yet the
        // owner's bid stands; only its wallet can still refuse.
        const ownAd = { adId: 9001, adRevision: 3 };
        const published = (amount, price) => TradeIntent.encode({ itemId: 736, amount, price, key: 'stock:scrolls',
            recipeId: 0, valueHours: 2, valueRate: 0.001 });
        prepare(request('own-ad-fill', 5000, 736, { ...ownAd, certificate: published(2, 5000) }));
        const filled = await consent('own-ad-fill');
        assert.equal(filled.lines.length, 2);
        assert(filled.lines.every(line => TradeIntent.decode(line.certificate).amount === line.count
            && TradeIntent.decode(line.certificate).price === 5000),
            'each physical stack carries the owner\'s consent for its own count at the ad price');
        assert(filled.parties[0].survivalCost > 0, 'the missing escape scroll is funded as survival stock');
        // The same fill without a certificate (main found it no longer
        // covering the line) is judged by the rebuilt plan, which wants no
        // scrolls: the owner refuses its need.
        prepare(request('own-ad-rebuilt', 5000, 736, { ...ownAd, certificate: null }));
        assert.equal((await refusal('own-ad-rebuilt')).reason, 'trade_meeting_need_changed');
        prepare(request('own-ad-over-wallet', 600000, 736, { ...ownAd, certificate: published(2, 600000) }));
        const overWallet = await refusal('own-ad-over-wallet');
        assert.equal(overWallet.ok, false);
        assert.equal(overWallet.reason, 'trade_meeting_funding');

        // The owner's step built and kept its plan at revision 0: it still
        // wants 2 escape scrolls, at a rate below its money price, and 2
        // stems at a rate above it, and no longer the potion its older ad
        // bids for. Certificates published at revision 0 are judged by that
        // build; one published by a later review (revision 1) is newer than
        // it and stands on its own.
        held.port1.postMessage({ state: owner, rows: [{ itemId: 736, amount: 2, worth: 100000, key: 'stock:scrolls',
            valueHours: 2, valueRate: 0.005 }, { itemId: 1864, amount: 2, worth: 100000, key: 'resale:1864',
            valueHours: 2, valueRate: 0.015 }] });
        const seeded = await new Promise(resolve => held.port1.once('message', resolve));
        assert.equal(seeded.error, undefined, seeded.error);
        const bid = (itemId, price, intentRevision) => ({ ...ownAd, intentRevision, certificate: TradeIntent.encode({ itemId, amount: 2,
            price, key: { 736: 'stock:scrolls', 1060: 'stock:potions' }[itemId] || `resale:${itemId}`, recipeId: 0,
            valueHours: 2, valueRate: 0.02 }) });
        prepare(request('held-row-gone', 100, 1060, bid(1060, 100, 0), 44));
        const gone = await refusal('held-row-gone');
        assert.equal(gone.ok, false);
        assert.equal(gone.reason, 'trade_meeting_need_changed', 'the owner no longer wants what its ad bids for');
        assert.equal(gone.cause, 'held_row', 'the held build refused, not the certificate');
        prepare(request('held-older', 100, 1060, bid(1060, 100, 1), 44));
        assert.equal((await consent('held-older', 44)).lines.length, 2, 'a build older than the certificate does not judge it');
        // Its held rate funds only the survival scroll (100000), not both.
        prepare(request('held-rate', 100000, 736, bid(736, 100000, 0), 44));
        assert.equal((await refusal('held-rate')).reason, 'trade_meeting_funding', 'the held lower rate bounds the funding');
        prepare(request('certificate-rate', 100000, 736, bid(736, 100000, 1), 44));
        assert.equal((await consent('certificate-rate', 44)).lines.length, 2, 'the certificate\'s own rate funds both');
        prepare(request('held-rate-funds', 100000, 1864, bid(1864, 100000, 0), 44));
        assert.equal((await consent('held-rate-funds', 44)).lines.length, 2, 'a held rate above the money price funds the fill');
        console.log('Real meeting worker: a sell-ad buy refuses overpaying an NPC, NPC-equivalent purchase consents; an own buy ad fill keeps its bid, judged by a held build at least as new, and refuses past the wallet');
    } finally { held.port1.close(); await worker.terminate(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
