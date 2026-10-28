const assert = require('node:assert/strict');
const { createWorld, Database, DataCache } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const BuyAds = invoke('GameServer/Bot/Economy/BuyAdPolicy');
const Pricing = invoke('GameServer/Bot/Economy/MarketPricing');
const Plan = require('../src/GameServer/Bot/Population/ColdEconomyPlan');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const StateWire = require('../src/GameServer/Bot/Population/ColdStateWire');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const { fnv1a32 } = require('../src/GameServer/Bot/Fnv1a');
const id = 730061, restores = [];
function stub(object, key, value) { const previous = object[key]; restores.push(() => object[key] = previous); object[key] = value; }
(async () => {
    const world = await createWorld([{ id, classId: 0, level: 30 }], 'economy-plan-execution');
    try {
        await Life.init();
        await Database.createAccount('bot_plan_execution', 'fixture');
        await Database.execute(['UPDATE characters SET username=? WHERE id=?', ['bot_plan_execution', id]]);
        await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 100000, slot: 0 });
        await Database.setItem(id, { selfId: 1867, name: 'Animal Skin', amount: 20, slot: 0 });
        let state = await Life.upsertState({ characterId: id, accountName: 'bot_plan_execution', name: 'PlanSeller',
            level: 30, exp: Number(DataCache.experience[29]), phase: 'cold', activity: 'hunting', adena: 100000,
            loc: { locX: 83396, locY: 147904, locZ: -3400 }, currentRegion: 'Giran',
            vitals: { hp: 187, maxHp: 187, mp: 74, maxMp: 74 },
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)), stats: { classId: 0 },
            timing: { lastResolvedAt: Date.now() - 10000, nextResolveAt: Date.now() + 60000 } }, 'plan_fixture');
        const record = await Database.openBoardRecords(id, 'sell_ad', [{ storeType: 1, town: 'Giran',
            lines: [{ selfId: 1867, name: 'Animal Skin', count: 10, price: 100, enchant: 0, stackable: true }] }]);
        for (const row of record.opened) Afk.refreshRecord(row);
        state = await Life.refreshInventory(state);
        const line = Afk.boardIndex().ownerLines(id)[0]; assert(line);
        const messages = [];
        const originalReprice = Database.repriceBoardLines;
        let boardMoves = true;
        stub(Database, 'repriceBoardLines', async (...args) => {
            if (boardMoves) await Database.execute(['UPDATE afk_trade_shops SET revision=revision+1 WHERE id=?', [line.recordId]]);
            return originalReprice.apply(Database, args);
        });
        stub(invoke('GameServer/Bot/Population/PopulationConfig'), 'developerDiagnostics', true);
        const coordinator = new ColdSimulationCoordinator();
        coordinator.worker = { postMessage: message => messages.push(message) }; coordinator.workerEpoch = 'plan:test';
        coordinator.tableChannel.flush = () => {};
        coordinator.reviewCommittedEconomy = async value => value;
        stub(invoke('GameServer/Bot/Goals/GoalService'), 'review', async () => null);
        stub(Life, 'enqueueEquipmentGoalAdvanceForState', () => {});
        stub(invoke('GameServer/Bot/Population/BotLifeEvents'), 'recordMany', async () => {});
        stub(invoke('GameServer/Bot/Population/BotGlobalChat'), 'maybeAnnounce', () => {});
        const proposal = { revision: 0,
            nextState: state, result: { events: [] }, economyEdges: 1,
            economyPlan: { sell: [], withdraw: [line.lineId], buyAds: [], buyTown: 'Giran', travel: null } };
        const result = { ok: true, characterId: id, nextState: state, proposal };
        // The worker's side of a commit: it flushes the proposal, takes main's
        // commit ack and sends the review command the ack names; main answers it.
        const sent = [];
        const kernel = new ColdSimulationKernel({ resolveSolo: () => null,
            emit: (type, payload) => { sent.push({ type, payload }); return true; } });
        const fromMain = (type, from) => StateWire.unpackPayload(type, messages.slice(from).find(message => message.type === type).payload);
        let steps = 0;
        const commit = async (fields = {}) => {
            // Each commit is its own step: a distinct start, so a distinct proposal id.
            const startedAt = Date.now() + steps++;
            const flushed = { ...proposal, ...fields, proposalId: `${id}:${startedAt}`, characterId: id, priority: 'P1',
                enqueuedAt: Date.now() };
            kernel.upsert({ state: Life.cachedState(id) });
            kernel.inFlight.set(id, { state: Life.cachedState(id), startedAt });
            kernel.dirty.set(id, flushed);
            kernel.flush(null, true);
            const committed = { ...result, nextState: Life.cachedState(id),
                proposal: sent.findLast(message => message.type === 'proposal_batch').payload.proposals[0] };
            const from = messages.length, before = sent.length;
            await coordinator.afterCommit(committed);
            await coordinator.handleCommitResults([committed]);
            const ack = fromMain('commit_ack', from);
            kernel.onCommitAck(ack);
            return { ack: ack.results[0],
                review: sent.slice(before).find(message => message.type === 'command_request')?.payload.requests[0] || null };
        };
        const review = async request => {
            const from = messages.length;
            coordinator.handleCommandRequest({ msgId: `review:${from}`, payload: { requests: [request] } });
            await coordinator.commandTail;
            const answer = fromMain('command_ack', from).results[0];
            kernel.completeCommand(answer);
            return answer;
        };
        const onBoard = () => Afk.boardIndex().ownerLines(id).some(row => row.lineId === line.lineId);
        const stale = await commit();
        assert.equal(stale.ack.ok, true, 'a stale post-commit board step cannot reject an accepted resolve');
        assert(stale.review, 'a commit with a plan is followed by its review command');
        assert.equal((await review(stale.review)).ok, true, 'a failed plan step does not refuse the review');
        assert.equal((await Database.execute(['SELECT count FROM afk_trade_lines WHERE id=?', [line.lineId]]))[0].count, 10,
            'the changed record keeps its physical stock');
        // The board takes the record as the moved writes left it.
        boardMoves = false;
        for (const row of await Database.fetchAfkTradeShops(id)) Afk.refreshRecord(row);
        // A main write between the ack and the review moves the row: the review
        // is refused and its plan does not run on the moved row.
        const moved = await commit();
        await Database.execute(['UPDATE bot_life_state SET simulationRevision=simulationRevision+1 WHERE characterId=?', [id]]);
        Life.acceptLifecycleRow((await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]))[0]);
        // The step stamped the plan as sent (ColdSimulationWorker economyPlanHash).
        const sentHash = fnv1a32(JSON.stringify(proposal.economyPlan));
        Object.assign(kernel.states.get(id), { economyPending: 1, economyPlanHash: sentHash });
        coordinator.ready = true;
        const beforeRefused = messages.length;
        const refused = await review(moved.review);
        assert.equal(refused.ok, false);
        assert.equal(refused.reason, 'stale_command');
        assert.equal(onBoard(), true, 'a refused review withdraws nothing');
        // The refused plan is no longer the one sent: the worker's refresh that
        // reproduces it sends it again (ColdSimulationWorker publish), and main
        // asks for that refresh after the ack that made the worker forget it.
        assert.equal(kernel.states.get(id).economyPlanHash, null, 'the refused review forgets the plan as sent');
        assert.equal(kernel.states.get(id).economyPending, 1, 'the next state still asks for a refresh');
        const after = messages.slice(beforeRefused).map(message => message.type === 'snapshot_page'
            ? (message.payload.economyOwnerId === id && message.payload.reconcile === true ? 'refresh' : 'page') : message.type);
        assert(after.indexOf('refresh') > after.indexOf('command_ack') && after.indexOf('command_ack') >= 0,
            'main asks for the refresh after the refused ack');
        coordinator.ready = false;
        // The next step proposes the same plan again and its review runs it.
        const applied = await commit();
        assert.equal((await review(applied.review)).ok, true);
        assert.equal(onBoard(), false, 'the review command executes the committed plan');
        const heavy = coordinator.reviewCommittedEconomy;
        coordinator.reviewCommittedEconomy = () => { throw Error('ordinary_loot_main_pass'); };
        assert.equal((await commit({ economyPlan: undefined, economyEdges: 0 })).review, null,
            'an ordinary commit with nothing to review sends no review command');
        coordinator.reviewCommittedEconomy = heavy;
        state = await Life.upsertState({ ...(Life.cachedState(id) || state), stats: { ...state.stats,
            money: [10000, .0001, 100, 0, .001, 2000, 1867] } }, 'plan_funded_packet');
        const walletBefore = state.adena;
        const funded = await Market.executePlan(state, { sell: [], withdraw: [], buyAds: [[1867, 5, 110]], buyTown: 'Giran', travel: null },
            { beforeWrite: () => {}, step: work => coordinator.step('economyPlan', id, work) });
        const boughtAd = Afk.ownerRecords(id).find(row => row.kind === 'buy_ad');
        assert(boughtAd, 'main publishes the worker quoted buy ad');
        assert.equal(boughtAd.lines[0].count, 5); assert.equal(boughtAd.lines[0].price, 110);
        assert.equal(funded.state.adena + boughtAd.escrowAdena, walletBefore, 'native writer conserves wallet plus escrow');
        await Market.executePlan(Life.cachedState(id), { sell: [], withdraw: [],
            buyAds: [[1867, 1000, 90, 1, 76, 7, 0, 1, .001]], buyTown: 'Giran', travel: null }, { step: work => work() });
        const resized = Afk.ownerRecords(id).find(row => row.kind === 'buy_ad');
        assert.equal(resized.id, boughtAd.id, 'quantity review retains the standing native record');
        assert.equal(resized.lines[0].price, 110, 'quantity review does not author a lower opening price');
        assert.equal(resized.lines[0].count, Math.floor((walletBefore - 100) / 110),
            'quantity fits the retained price after protecting the survival reserve');
        assert.deepEqual(resized.lines[0].pricing, boughtAd.lines[0].pricing,
            'quantity review preserves the native repricing cursors');
        assert.equal(JSON.parse(resized.lines[0].intentJson)[1], resized.lines[0].count,
            'the root certificate carries the actual advertised quantity');
        assert.equal(JSON.parse(resized.lines[0].intentJson)[2], 110);
        assert.equal(Life.cachedState(id).adena, walletBefore, 'resizing a conditional bid moves no money');
        await Market.executePlan(Life.cachedState(id), { sell: [], withdraw: [],
            buyAds: [[1867, 1000, 90, 1, 76, 7, 0, 1, .001]], buyTown: 'Giran', travel: null }, { step: work => work() });
        assert.deepEqual(Afk.ownerRecords(id).find(row => row.kind === 'buy_ad'), resized,
            'the same bounded quantity is a native no-op on the next review');
        const packetBefore = Life.cachedState(id).stats.money;
        const priorityState = await Life.upsertState({ ...Life.cachedState(id), stats: { ...Life.cachedState(id).stats,
            money: [10000, .0001, 10000, 0, .002, 50000, 76, .001, 60000, 1867] } }, 'priority_bid_fixture');
        await Market.executePlan(priorityState, { sell: [], withdraw: [],
            buyAds: [[1867, 400, 90, 1, 76, 7, 0, 1, .001]], buyTown: 'Giran', travel: null }, { step: work => work() });
        assert.equal(Afk.ownerRecords(id).find(row => row.kind === 'buy_ad').lines[0].count,
            Math.floor((walletBefore - 10000 - 50000) / 110),
            'publication also protects higher-priority money when the desired quantity shrinks');
        await Life.upsertState({ ...Life.cachedState(id), stats: { ...Life.cachedState(id).stats,
            money: packetBefore } }, 'restore_bid_packet');
        await Market.executePlan(Life.cachedState(id), { sell: [], withdraw: [], buyAds: [[1867, 5, 100]], buyTown: 'Giran',
            buyCaps: [105], travel: null }, { step: work => work() });
        assert.equal(Afk.ownerRecords(id).find(row => row.kind === 'buy_ad').lines[0].price, 100,
            'a same-quantity standing bid cannot retain a price above the worker prepared purchase limit');
        await assert.rejects(Market.executePlan(Life.cachedState(id), { sell: [], withdraw: [],
            buyAds: [[1867, 5, 110]], buyTown: 'Giran', buyCaps: [105], travel: null }, { step: work => work() }),
        /economy_plan_bid_cap/, 'native publication rejects a quote above its prepared limit');
        const standing = Afk.ownerRecords(id).find(row => row.kind === 'buy_ad');
        // A lifecycle command (its path has no look): the worker's plan carries
        // the bid limits and main lowers the bid once after the command, also
        // while a meeting preparation stands (a quote, checked at acceptance).
        stub(coordinator, 'population', { executeWorkerLifecycleCommand: async value => ({ ok: true, state: value }) });
        const lifecycle = async (commandId, bidLimits) => {
            const identity = { characterId: id, commandId,
                commandCheckpoint: Protocol.commandCheckpoint(Life.cachedState(id)) };
            coordinator.commandInflight.set(id, Promise.resolve());
            try { return await coordinator.executeLifecycleCommand({ precomputedPlan: { bidLimits } }, identity, () => true); }
            finally { coordinator.commandInflight.delete(id); }
        };
        const beforeLife = Afk.ownerRecords(id).find(row => row.id === standing.id);
        const lifeRow = [beforeLife.lines[0].id, beforeLife.id, beforeLife.revision,
            beforeLife.lines[0].count, beforeLife.lines[0].price, 80];
        const Meeting = invoke('GameServer/AfkTrade/TradeMeetingService'), preparation = Meeting.hasPreparation;
        let lifeResult;
        try {
            Meeting.hasPreparation = () => true;
            lifeResult = await lifecycle('life:bid', [lifeRow]);
        } finally { Meeting.hasPreparation = preparation; }
        assert.equal(lifeResult.ok, true);
        assert.equal(Afk.ownerRecords(id).find(row => row.id === standing.id).lines[0].price, 80,
            'a lifecycle command lowers an overpriced standing bid to the worker ceiling, a preparation does not freeze it');
        assert.equal(Life.cachedState(id).adena, walletBefore,
            'lowering a conditional standing bid does not invent escrow or move the wallet');
        const again = await lifecycle('life:bid-again', [lifeRow]);
        assert.equal(again.ok, true, 'a stale bid row does not fail the lifecycle command');
        assert.equal(Afk.ownerRecords(id).find(row => row.id === standing.id).lines[0].price, 80,
            'the same rows apply once: the moved line skips them');
        const limited = await commit({ economyPlan: { sell: [[1867, 3, 150, 'Giran', 0]], withdraw: [], travel: null } });
        assert(limited.review, 'a commit with a plan is followed by its review command');
        assert.equal((await review(limited.review)).ok, true);
        assert(Afk.boardIndex().ownerLines(id).some(row => row.storeType === Afk.SELL && row.selfId === 1867),
            'the plan sale lines are published in the same review');
        assert.equal(Life.cachedState(id).adena, walletBefore);
        const prepared = Life.cachedState(id);
        await Database.execute(['UPDATE bot_life_state SET simulationRevision=simulationRevision+1 WHERE characterId=?', [id]]);
        const actual = Life.acceptLifecycleRow((await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]))[0]);
        const preserved = await Database.fetchAfkTradeShops(id);
        const deferred = await Market.executePlan(actual, { sell: [], withdraw: [], buyAds: [], buyTown: 'Giran', travel: null },
            { preparedState: prepared, step: work => work() });
        assert.equal(deferred.buyPending, true, 'a changed own native revision keeps the whole buy batch pending');
        assert.deepEqual(await Database.fetchAfkTradeShops(id), preserved,
            'stale complete-empty is not fresh consent to withdraw the old ads');
        const Commit = require('../src/GameServer/Bot/Economy/EconomyCommit');
        const expected = Object.fromEntries(preserved.filter(row => row.kind === 'buy_ad').map(row => [row.id, row.revision]));
        await assert.rejects(Database.replaceBoardRecords(id, 'buy_ad', [], {
            expected, expectedAuthority: Commit.authority(prepared)
        }), /economy_plan_need_changed/, 'the SQL transaction fences even an unchanged/stale main cache');
        assert.deepEqual(await Database.fetchAfkTradeShops(id), preserved);
        await Market.executePlan(actual, { sell: [], withdraw: [], buyAds: [], buyTown: 'Giran', travel: null },
            { preparedState: actual, step: work => work() });
        assert.equal((await Database.fetchAfkTradeShops(id)).filter(row => row.kind === 'buy_ad').length, 0,
            'a freshly prepared complete-empty batch closes obsolete unaccepted ads');
        // Each bid row stands on its own certificate: a row whose line moved
        // (here repriced; a fill moves it the same way) is skipped and never
        // written, the other rows of the same plan still apply.
        await Market.executePlan(Life.cachedState(id), { sell: [], withdraw: [],
            buyAds: [[1867, 5, 100, 1, 76, 7, 0, 1, .001], [1868, 5, 100, 1, 76, 7, 0, 1, .001]], buyTown: 'Giran', travel: null }, { step: work => work() });
        const pair = Afk.ownerRecords(id).filter(row => row.kind === 'buy_ad');
        assert.equal(pair.length, 2, 'two bids stand on two records');
        const rowOf = (ad, ceiling) => [ad.lines[0].id, ad.id, ad.revision, ad.lines[0].count, ad.lines[0].price, ceiling];
        const pairRows = [rowOf(pair[0], 80), rowOf(pair[1], 80)];
        await Afk.repriceBot(id, pair[0].lines[0].id, 99, pair[0].revision);
        const oneMoved = await lifecycle('life:one-moved', pairRows);
        assert.equal(oneMoved.ok, true);
        const priceOf = ad => Afk.ownerRecords(id).find(row => row.id === ad.id).lines[0].price;
        assert.equal(priceOf(pair[0]), 99, 'the moved line keeps its own price');
        assert.equal(priceOf(pair[1]), 80, 'the other row still applies');
        // A market trip withdraws every buy ad before the lifecycle plan's
        // rows apply: nothing stands, nothing is refused, nothing is written.
        const lastRows = [rowOf(Afk.ownerRecords(id).find(row => row.id === pair[1].id), 70)];
        await Market.withdrawBuyAds(id, null);
        assert.equal(Afk.ownerRecords(id).filter(row => row.kind === 'buy_ad').length, 0);
        const shopsWithdrawn = await Database.fetchAfkTradeShops(id), adenaWithdrawn = Life.cachedState(id).adena;
        const afterTrip = await lifecycle('life:withdrawn', lastRows);
        assert.equal(afterTrip.ok, true, 'withdrawn ads then apply: the command stays ok');
        assert.deepEqual(await Database.fetchAfkTradeShops(id), shopsWithdrawn, 'withdrawn ads then apply: nothing written');
        assert.equal(Life.cachedState(id).adena, adenaWithdrawn);
        // The escrow store's money is not cash: a meeting bid is paid from the
        // wallet the store left. Main's certificate refuses a plan row above
        // that cash (a stale plan); a plan within it lands.
        const cash = Life.cachedState(id).adena, storePrice = Math.floor(cash / 10);
        const storeRow = [1868, 6, storePrice, 1, 76, 7, 0, 1, .001];
        await Market.executePlan(Life.cachedState(id), { sell: [], withdraw: [], buyAds: [storeRow], buyStore: 1,
            buyTown: 'Giran', travel: null }, { step: work => work() });
        assert.equal(Life.cachedState(id).adena, cash - 6 * storePrice, 'the store holds its escrow');
        await assert.rejects(Market.executePlan(Life.cachedState(id), { sell: [], withdraw: [], buyStore: 1, buyTown: 'Giran',
            travel: null, buyAds: [storeRow, [1867, 1, Math.floor(cash * .8), 1, 76, 7, 0, 1, .001]] }, { step: work => work() }),
        /economy_plan_bid_unfunded/, 'a meeting bid above the cash the store leaves is a stale plan');
        await Market.executePlan(Life.cachedState(id), { sell: [], withdraw: [], buyStore: 1, buyTown: 'Giran', travel: null,
            buyAds: [storeRow, [1869, 1, Math.floor(cash * .3), 1, 76, 7, 0, 1, .001]] }, { step: work => work() });
        const ads = Afk.ownerRecords(id).filter(row => row.kind === 'buy_ad');
        assert.deepEqual(ads.map(ad => [ad.lines[0].selfId, ad.custodyPolicy]).sort((a, b) => a[0] - b[0]), [[1868, 0], [1869, 1]],
            'the store and the bid the remaining cash covers stand');
        assert.equal(Life.cachedState(id).adena, cash - 6 * storePrice, 'a meeting bid holds no money');
        // One money rule, worker -> main -> DB: closes, then the escrow store
        // (growth only, a shrink's escrow back first), then meeting bids on
        // the bag the store leaves, their funding on that bag. A plan the
        // worker builds lands whole. Packet [10000, .0001, reserve, 0]; a
        // twin workshop makes the bot a producer (recipe inputs go to store).
        const quotes = {};
        stub(Pricing, 'bid', selfId => quotes[selfId]);
        const fund = async (wallet, reserve) => {
            await Market.withdrawBuyAds(id, null);
            await Database.execute(['DELETE FROM items WHERE characterId=? AND selfId=57', [id]]);
            await Database.setItem(id, { selfId: 57, name: 'Adena', amount: wallet, slot: 0 });
            await Life.upsertState({ ...Life.cachedState(id), adena: wallet, stats: { ...Life.cachedState(id).stats,
                money: [10000, .0001, reserve, 0], twin: { workshop: [{ recipeId: 1 }] } } }, 'fund_fixture');
            assert.equal(Life.cachedState(id).adena, wallet);
        };
        // The worker's buy step (ColdEconomyPlan: linesFor on wallet + escrow,
        // buyBatch) and main's execution of it. rows: [itemId, count, price,
        // recipeId, worth = price]; the worth is the bid's purchase cap.
        const buyStep = async rows => {
            for (const [itemId, count, price] of rows) quotes[itemId] = { price, count, purchaseCap: Infinity, pricing: {} };
            const state = Life.cachedState(id);
            const escrow = Afk.ownerRecords(id).reduce((sum, ad) => sum + Number(ad.escrowAdena || 0), 0);
            const lines = BuyAds.linesFor({ ...state, adena: state.adena + escrow }, null, { board: Afk.boardIndex(),
                townFor: () => 'Giran', watchList: rows.map(([itemId, amount, price, recipeId, worth = price]) => ({ itemId, amount,
                    key: `power:${itemId}:7`, recipeId, worth, valueHours: 1, valueRate: .1 })) });
            await Market.executePlan(Life.cachedState(id), { sell: [], withdraw: [], travel: null,
                ...Plan.buyBatch(lines, 'Giran') }, { step: work => work() });
        };
        const bids = () => Afk.ownerRecords(id).filter(ad => ad.kind === 'buy_ad')
            .map(ad => [ad.lines[0].selfId, ad.lines[0].count, ad.lines[0].price, ad.custodyPolicy, Number(ad.escrowAdena || 0)])
            .sort((a, b) => a[0] - b[0]);
        // 1. A held store line keeps its higher price while its worth covers
        // it: the store is split at the price the DB holds, so the third root
        // becomes a meeting bid.
        await fund(10000, 1000);
        await buyStep([[1867, 6, 1000, 1]]);
        assert.deepEqual(bids(), [[1867, 6, 1000, 0, 6000]]);
        await buyStep([[1867, 6, 800, 1, 1000], [1868, 2, 1000, 1], [1869, 2, 1000, 1]]);
        assert.deepEqual(bids(), [[1867, 6, 1000, 0, 6000], [1868, 2, 1000, 0, 2000], [1869, 1, 1000, 1, 0]],
            'the store fits the money queue at held prices; the meeting bid fits the bag left');
        assert.equal(Life.cachedState(id).adena, 2000);
        // 1b. Its worth below the held price: the plan lowers the store line
        // (its escrow comes back) and the rest of the batch lands in the same
        // plan; the reprice's own revision does not refuse the replace.
        await fund(10000, 1000);
        await buyStep([[1867, 6, 1000, 1]]);
        await buyStep([[1867, 6, 800, 1], [1868, 2, 1000, 1], [1869, 2, 1000, 1]]);
        assert.deepEqual(bids(), [[1867, 6, 800, 0, 4800], [1868, 2, 1000, 0, 2000], [1869, 2, 1000, 0, 2000]],
            'the lowered store line frees escrow the queue then spends on the other roots');
        assert.equal(Life.cachedState(id).adena, 1200);
        // 2. A meeting bid's funding is on the bag the kept store leaves, not
        // on wallet + escrow: it shrinks to what that bag funds.
        await fund(2000, 100);
        await buyStep([[1867, 1, 1000, 1]]);
        await buyStep([[1867, 1, 1000, 1], [1868, 2, 500, 0]]);
        assert.deepEqual(bids(), [[1867, 1, 1000, 0, 1000], [1868, 1, 500, 1, 0]]);
        assert.equal(Life.cachedState(id).adena, 1000);
        // 3. A growing kept store line is backed by its own escrow: only the
        // growth leaves the bag.
        await fund(7000, 100);
        await buyStep([[1867, 5, 1000, 1]]);
        assert.equal(Life.cachedState(id).adena, 2000);
        await buyStep([[1867, 6, 1000, 1]]);
        assert.deepEqual(bids(), [[1867, 6, 1000, 0, 6000]]);
        assert.equal(Life.cachedState(id).adena, 1000);
        // 4. A store line shrinking in the same step frees its escrow before
        // the meeting bids: one may use it.
        await fund(6000, 100);
        await buyStep([[1867, 5, 1000, 1]]);
        await buyStep([[1867, 2, 1000, 1], [1868, 1, 3000, 0]]);
        assert.deepEqual(bids(), [[1867, 2, 1000, 0, 2000], [1868, 1, 3000, 1, 0]]);
        assert.equal(Life.cachedState(id).adena, 4000);
        console.log('test_cold_economy_plan_execution: review command runs the committed plan; stale review refused; ack ok');
    } finally { for (const restore of restores.reverse()) restore(); await world.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
