'use strict';
const assert = require('node:assert/strict');
const { createWorld, Database, DataCache } = require('./helpers/c4QuestHarness');
const nativeDecision = require('./helpers/workerEconomyDecision');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const Town = invoke('GameServer/Bot/Economy/MarketTownPolicy');
const Price = invoke('GameServer/Bot/Economy/PriceDecision');
const id = 730183;
const sellerId = 730184;
const doneSellerId = 730185;
const cleanerId = 730186;
const STATIC_BOUGHT = [1864, 1865, 1866, 1867, 1868, 1869, 1870, 1871];
const TRADED = [1786, 1792, 1793, 1800, 1803, 2143, 2151, 2173, 2174, 2175, 1867, 1869, 1870, 1871, 1872, 1873, 1880, 1897];

(async () => {
    const world = await createWorld([{ id, classId: 0, level: 20 }, { id: sellerId, classId: 0, level: 20 },
        { id: doneSellerId, classId: 0, level: 20 }, { id: cleanerId, classId: 0, level: 20 }], 'native-afk-visit');
    try {
        await Life.init();
        await Database.createAccount('bot_native_afk_visit', 'fixture');
        await Database.execute(['UPDATE characters SET username=? WHERE id=?', ['bot_native_afk_visit', id]]);
        await Database.setItem(id, { selfId: 57, amount: 1000000, slot: 0 });
        await Database.setItem(id, { selfId: 1, amount: 1, equipped: 1, slot: 7 });
        for (const enchant of [0, 1, 3]) await Database.setItem(id, {
            selfId: 626, amount: 1, enchant, equipped: enchant === 3 ? 1 : 0, slot: enchant === 3 ? 8 : 0
        });
        const shieldsBefore = (await Database.fetchItems(id)).filter(row => row.selfId === 626);
        // Small stacks: one unit each, so the spare shields keep their slots
        // (the 1000-unit stacks below are the sale trip's).
        for (const selfId of TRADED) await Database.setItem(id, { selfId, amount: 1, slot: 0 });
        const place = Town.marketTown('Elven Village').center;
        const spot = invoke('GameServer/Bot/Population/SpotProfiles').ensure().filter(row => row.center)
            .sort((a, b) => Math.hypot(a.center.locX - place.locX, a.center.locY - place.locY)
                - Math.hypot(b.center.locX - place.locX, b.center.locY - place.locY))[0];
        const state = await Life.upsertState({ characterId: id, accountName: 'bot_native_afk_visit',
            name: 'NativeTownSeller', level: 20, exp: Number(DataCache.experience[19]),
            phase: 'cold', activity: 'shopping', currentRegion: 'Elven Village', spotId: String(spot.id),
            adena: 1000000, loc: place, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
            stats: { classId: 0, generatedCold: true, classProgressionClassId: 0, classProgressionLevel: 20,
                // On its market trip the bot's store town is its twin's (TwinCluster.storeTown).
                twin: { town: 'Elven Village' },
                marketReturn: { spotId: String(spot.id), regionName: spot.name, loc: spot.center } },
            timing: { activityStartedAt: Date.now(), lastResolvedAt: Date.now() - 1000, nextResolveAt: Date.now() }
        }, 'ordinary_town_visit_fixture');
        assert.equal(Population.marketListingIntent(state, { type: 'restock' }).shouldOpen, true);
        assert.equal(Population.marketListingIntent(state, { type: 'restock' }).saleVisit, false);
        // Real worker pricing and native lifecycle planning; no supplied sale,
        // price, demand or sell_inventory goal. Its usual purchase leaf must
        // not prevent the town's independent showcase publication.
        // The board traded each bag item twice in Giran at its first price: a
        // forecast flow, so a store line may offer it (MarketPricing.quotable),
        // its price belief stays.
        // Main and the worker read the same market rows.
        const Counters = invoke('GameServer/Bot/Economy/MarketCounters');
        for (const selfId of [626, ...TRADED])
            for (const ago of [2, 1]) Counters.deal(selfId, Counters.firstPrice(selfId), 1, Date.now() - ago, cleanerId, 'Giran');
        let marketRows = [];
        Counters.publish({ register: (name, source) => { marketRows = source.allRows(); }, changed: () => {} });
        const tablePages = [{ tables: [
            { name: 'board', from: null, to: 0, full: true, rows: [], removed: [], last: true },
            { name: 'market', from: null, to: 0, full: true, rows: marketRows.map(row => [row[0], row]), removed: [], last: true }
        ] }];
        const visitAt = Date.now();
        const native = await nativeDecision(state, { townVisit: true, tablePages, timestamp: visitAt });
        const plan = native.plan.economyPlan;
        assert(plan, 'an ordinary shopping command carries its market publication');
        assert.equal(plan.shop, 'Elven Village', 'open in the town actually visited');
        assert(plan.sell.length >= 4, `an adventurer quotes surplus without an existing buyer: ${JSON.stringify(plan)}`);
        assert.equal(plan.take, undefined, 'town errands retain their own purchase executor');
        assert.equal(plan.buyAds, undefined);
        assert.equal(plan.travel, null);
        const shieldPlans = plan.sell.filter(row => row[0] === 626);
        assert(shieldPlans.some(row => row[4] === 1),
            `the native worker quotes the +1 spare despite a +0 copy in the bag: ${JSON.stringify(plan.sell)}`);
        assert(!shieldPlans.some(row => row[4] === 3), 'the worn shield stays reserved');
        // Board lines by gain over the NPC buy-back times units (user
        // 2026-10-23), the sale owner's gain (MarketPricing.disposition: the
        // Adena the stock is expected to bring over the buy-back), read from
        // the same sale decision on main at the worker's decision point. The
        // deals are Giran's and demand is per town (MarketDemand.forecast, the
        // author's split kept in R3): in Elven Village every line is a quote
        // of unknown demand, gain 0, and the slots go by the owner's next key.
        const sale = invoke('GameServer/Bot/Economy/MarketListingPolicy').evaluate(state, { now: visitAt,
            board: Afk.boardIndex(), economy: invoke('GameServer/Bot/Economy/EconomyContext').forState(state, { timestamp: visitAt }) });
        const owned = new Map(sale.listings.map(row => [`${row.selfId}:${row.enchant || 0}`, row]));
        const quoted = plan.sell.map(([selfId, , price, , enchant]) => {
            const listing = owned.get(`${selfId}:${enchant}`);
            assert.equal(listing?.price, price, `main and the worker price ${selfId}+${enchant} alike`);
            return listing;
        });
        assert.deepEqual(quoted, invoke('GameServer/Bot/Economy/MarketListingPolicy').prioritizeListings(quoted),
            'the largest gain over the NPC price is quoted first');
        const Economy = invoke('GameServer/Bot/Economy/EconomyContext'), saved = Economy.forState;
        let outcome;
        try {
            Economy.forState = () => { throw Error('the town handoff must not rebuild worker pricing on main'); };
            outcome = await Population.resolveColdState(state, { precomputedPlan: native.plan,
                precomputedResult: { patch: {}, events: [], materialize: { exp: 0, sp: 0, adena: 0, items: [] },
                    nextResolveAt: Date.now() + 30000, debug: {} } });
        } finally { Economy.forState = saved; }
        assert(outcome.ok);
        const shop = Afk.findOwnerProjection(id)?.shop;
        assert(shop, `the real town lifecycle executes the prepared showcase before departure: ${JSON.stringify({ plan,
            activity: outcome.state.activity, debug: outcome.debug, lastReason: outcome.state.stats.lastReason,
            records: Afk.ownerRecords(id).map(row => ({ kind: row.kind, town: row.town, items: row.lines.map(line => line.selfId) })) })}`);
        assert.equal(shop.town, 'Elven Village');
        assert.deepEqual(shop.lines.map(row => row.selfId), plan.sell.slice(0, 3).map(row => row[0]));
        const ads = Afk.ownerRecords(id).filter(row => row.kind === 'sell_ad');
        assert(ads.length > 0 && ads.length <= 5, 'overflow becomes conditional board ads');
        const own = Afk.boardIndex().ownerLines(id);
        assert.equal(new Set(own.map(line => `${line.selfId}:${line.enchant}`)).size, own.length);
        assert(!own.some(line => line.selfId === 1), 'the worn weapon cannot be offered');
        assert(shieldPlans.length > 0, 'a spare shield is published');
        for (const row of shieldPlans) {
            const line = own.find(line => line.selfId === 626 && line.enchant === row[4]);
            assert(line, 'the town lifecycle publishes the worker selected enchant without an ambiguous-copy failure');
            assert.equal(line.price, row[2]);
            const source = shieldsBefore.find(item => item.enchant === row[4]);
            const recordLine = Afk.ownerRecords(id).flatMap(record => record.lines).find(row => row.id === line.lineId);
            assert.equal(recordLine.sourceObjectId, source.id, 'native custody selects the exact physical enchant');
        }
        const worn = (await Database.fetchItems(id)).find(row => row.selfId === 626 && row.enchant === 3);
        assert.equal(worn.id, shieldsBefore.find(row => row.enchant === 3).id);
        assert.equal(worn.equipped, 1);
        assert(!own.some(line => line.selfId === 626 && line.enchant === 3));
        assert(Buffer.byteLength(JSON.stringify(plan)) <= require('../src/GameServer/Bot/Population/ColdEconomyPlan').MAX_PLAN_PAYLOAD_BYTES);
        console.log('PASS native ordinary town visit: real worker prices, mixed enchants, physical custody, reserved equipment, main handoff');

        // E304: the same visit on a sale trip (the departure marker says it came to
        // sell). The worker showcase must not skip open: the junk sale and the
        // 30-min sale retry exist only there; no static buyer takes a bot's item.
        await Database.createAccount('bot_native_sale_visit', 'fixture');
        await Database.execute(['UPDATE characters SET username=? WHERE id=?', ['bot_native_sale_visit', sellerId]]);
        await Database.setItem(sellerId, { selfId: 57, amount: 1000000, slot: 0 });
        await Database.setItem(sellerId, { selfId: 1, amount: 1, equipped: 1, slot: 7 });
        for (const enchant of [0, 1, 3]) await Database.setItem(sellerId, {
            selfId: 626, amount: 1, enchant, equipped: enchant === 3 ? 1 : 0, slot: enchant === 3 ? 8 : 0
        });
        for (const selfId of TRADED)
            await Database.setItem(sellerId, { selfId, amount: 1000, slot: 0 });
        const bagOf = async () => (await Database.fetchItems(sellerId)).reduce((sum, row) => {
            sum[row.selfId] = (sum[row.selfId] || 0) + Number(row.amount || 0);
            return sum;
        }, {});
        const startedAt = Date.now() - 60000;
        const saleState = await Life.upsertState({ characterId: sellerId, accountName: 'bot_native_sale_visit',
            name: 'NativeTripSeller', level: 20, exp: Number(DataCache.experience[19]),
            phase: 'cold', activity: 'shopping', currentRegion: 'Elven Village', spotId: String(spot.id),
            adena: 1000000, loc: place, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(sellerId)),
            stats: { classId: 0, generatedCold: true, classProgressionClassId: 0, classProgressionLevel: 20,
                townVisit: { town: 'Elven Village', startedAt, reason: 'sell_inventory' }, twin: { town: 'Elven Village' },
                marketReturn: { spotId: String(spot.id), regionName: spot.name, loc: spot.center } },
            timing: { activityStartedAt: Date.now(), lastResolvedAt: Date.now() - 1000, nextResolveAt: Date.now() }
        }, 'sale_town_visit_fixture');
        const saleIntent = Population.marketListingIntent(saleState, { type: 'restock' });
        assert.equal(saleIntent.shouldOpen, true);
        assert.equal(saleIntent.saleVisit, true, 'the departure marker, not the re-reviewed goal, marks a sale trip');
        const saleNative = await nativeDecision(saleState, { townVisit: true, tablePages });
        const salePlan = saleNative.plan.economyPlan;
        assert(salePlan && salePlan.sell.length >= 3, `a sale trip still carries the worker showcase: ${JSON.stringify(salePlan)}`);
        const bagBefore = await bagOf();
        const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService'), executePlan = Market.executePlan;
        const Listing = invoke('GameServer/Bot/Economy/ColdMarketListingService'), open = Listing.open;
        const opens = [];
        let showcaseRuns = 0, saleOutcome;
        try {
            Market.executePlan = (...args) => { showcaseRuns++; return executePlan.apply(Market, args); };
            Listing.open = (...args) => open.apply(Listing, args).then((result) => {
                opens.push(result);
                return result;
            });
            saleOutcome = await Population.resolveColdState(saleState, { precomputedPlan: saleNative.plan,
                precomputedResult: { patch: {}, events: [], materialize: { exp: 0, sp: 0, adena: 0, items: [] },
                    nextResolveAt: Date.now() + 30000, debug: {} } });
        } finally { Market.executePlan = executePlan; Listing.open = open; }
        assert(saleOutcome.ok);
        assert.notEqual(saleOutcome.state.stats.lastReason, 'market_batch_continue',
            'the fixture must reach the listing gate, not the purchase batch return');
        assert.equal(showcaseRuns, 0, 'a sale trip skips the worker showcase: open alone decides the bag');
        const bagAfter = await bagOf();
        const savedSeller = await Life.findByCharacterId(sellerId);
        assert(Number(saleOutcome.state.stats.marketSellRetryAfter || savedSeller?.stats?.marketSellRetryAfter || 0) > Date.now(),
            'the sale trip wrote its 30-min retry, so the next trip waits for it');
        assert.equal(opens.length, 1);
        assert.equal(opens[0].listed, true, `open listed the rest: ${opens[0].reason}`);
        const saleShop = Afk.findOwnerProjection(sellerId)?.shop;
        assert(saleShop && Number(saleShop.storeType) === Afk.SELL && saleShop.town === 'Elven Village', 'open opened the sell shop');
        const sold = new Set((opens[0].market?.npc || []).map(row => Number(row.selfId)));
        const offered = Afk.ownerRecords(sellerId).filter(row => row.kind === 'sell_ad').flatMap(row => row.lines)
            .concat(saleShop.lines);
        const unbacked = offered.filter(line => sold.has(Number(line.selfId)));
        assert.deepEqual(unbacked.map(line => line.selfId), [], 'nothing sold on this visit is still offered on the board');
        const gone = STATIC_BOUGHT.filter(selfId => (bagAfter[selfId] || 0) < (bagBefore[selfId] || 0));
        assert.deepEqual(gone.filter(selfId => !sold.has(selfId) && !offered.some(line => Number(line.selfId) === selfId)), [],
            'a static-bought material leaves the bag only to an NPC or the board, never to a static buyer');
        console.log('PASS native sale town visit: worker showcase skipped, no static buyer, sale retry written, open listed the rest');

        assert.equal(Population.marketListingIntent({ ...saleState, stats: { ...saleState.stats,
            townVisit: { ...saleState.stats.townVisit, town: 'Gludin Village' } } }, { type: 'restock' }).saleVisit, false,
        'a sale marker for another town does not make this visit a sale trip');
        // Controls on the same bag: the worker showcase still runs on a finished
        // sale visit and on a forced cleanup (the author's path, E306).
        const showcaseRunsFor = async (characterId, label, stats) => {
            const account = `bot_native_${label}`;
            await Database.createAccount(account, 'fixture');
            await Database.execute(['UPDATE characters SET username=? WHERE id=?', [account, characterId]]);
            await Database.setItem(characterId, { selfId: 57, amount: 1000000, slot: 0 });
            await Database.setItem(characterId, { selfId: 1, amount: 1, equipped: 1, slot: 7 });
            for (const selfId of TRADED)
                await Database.setItem(characterId, { selfId, amount: 1000, slot: 0 });
            const visitState = await Life.upsertState({ characterId, accountName: account,
                name: `Native${label}`, level: 20, exp: Number(DataCache.experience[19]),
                phase: 'cold', activity: 'shopping', currentRegion: 'Elven Village', spotId: String(spot.id),
                adena: 1000000, loc: place, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
                inventory: Life.inventorySummaryFromItems(await Database.fetchItems(characterId)),
                stats: { classId: 0, generatedCold: true, classProgressionClassId: 0, classProgressionLevel: 20,
                    twin: { town: 'Elven Village' },
                    marketReturn: { spotId: String(spot.id), regionName: spot.name, loc: spot.center }, ...stats },
                timing: { activityStartedAt: Date.now(), lastResolvedAt: Date.now() - 1000, nextResolveAt: Date.now() }
            }, `${label}_fixture`);
            const decided = await nativeDecision(visitState, { townVisit: true });
            assert(decided.plan.economyPlan, `${label}: the worker plan carries a showcase`);
            let runs = 0;
            try {
                Market.executePlan = (...args) => { runs++; return executePlan.apply(Market, args); };
                const result = await Population.resolveColdState(visitState, { precomputedPlan: decided.plan,
                    precomputedResult: { patch: {}, events: [], materialize: { exp: 0, sp: 0, adena: 0, items: [] },
                        nextResolveAt: Date.now() + 30000, debug: {} } });
                assert(result.ok);
            } finally { Market.executePlan = executePlan; }
            return { visitState, runs };
        };
        const done = await showcaseRunsFor(doneSellerId, 'done_sale_visit',
            { townVisit: { town: 'Elven Village', startedAt, reason: 'sell_inventory', completed: true } });
        assert.equal(Population.marketListingIntent(done.visitState, { type: 'restock' }).saleVisit, false);
        assert.equal(done.runs, 1, 'a finished sale visit reaches the worker showcase, so the sale case skip is the predicate');
        const cleanup = await showcaseRunsFor(cleanerId, 'cleanup_visit', {
            townVisit: { town: 'Elven Village', startedAt, reason: 'sell_inventory' },
            forcedMarketCleanup: { cleanupReason: 'inventory_capacity', itemCount: 18, npcOnlySlots: 0, startedAt } });
        assert.equal(cleanup.runs, 1, 'a forced cleanup keeps the worker showcase (the author path)');
        console.log('PASS sale visit controls: finished and other-town sale markers, forced cleanup keeps the showcase');
    } finally { await world.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
