'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
Data.init();
// R2 (user rule, one owner MarketPricing.disposition): the board when it pays
// more than the NPC, else the NPC; unknown demand lists at the belief's ask
// when that is above the NPC, but a real bid over the NPC buy-back is
// answered instead; the board slots go to the highest gain over the NPC and
// the rest take their next answer.
{
    const Pricing = invoke('GameServer/Bot/Economy/MarketPricing');
    const Listing = invoke('GameServer/Bot/Economy/MarketListingPolicy');
    const Price = invoke('GameServer/Bot/Economy/PriceDecision');
    const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
    const ORE = 1869, COAL = 1870, now = 1800000000000;
    const gear = Data.items.find(item => /^Weapon\./.test(item.template?.kind || '') && item.etc?.rank === 'd');
    assert(gear, 'datapack fixture');
    // A foreign ask well over the NPC raises each item's belief there.
    const board = new BoardIndex();
    [[ORE, 2000], [COAL, 2000], [gear.selfId, Price.buyback(gear.selfId) * 10]].forEach(([selfId, price], at) =>
        board.put({ id: 9690000 + at, ownerId: 9691000 + at, kind: 'sell_ad', storeType: 1, town: 'Giran', revision: 1,
            lines: [{ lineId: 9692000 + at, selfId, count: 1, price }] }));
    const trip = () => 0; trip.details = () => ({ known: true, hours: 0, fees: 0 });
    const economy = { hourAdena: 1000, moneyPrice: .001, network: {}, worth: () => 0,
        persona: { traits: {}, understanding: .3 }, stock: () => ({ itemId: 1060, target: 0 }) };
    const demand = units => id => ({ known: true, origin: 'fixture', authority: { id: 1 }, selfId: id,
        applicableUnits: units, delayHours: 0, availability: { from: now, until: now + 1 } });
    const adventurer = { characterId: 4341, level: 40, adena: 50000, activity: 'shopping', currentRegion: 'Dion',
        stats: {}, inventory: {} };
    const options = (demandFor, extra = {}) => ({ now, board, economy, tripCost: trip, demandFor,
        npcOffersFor: () => [], ...extra });
    const decide = (selfId, count, demandFor) => Pricing.disposition({ selfId, count, enchant: 0 },
        Listing.traderContext(adventurer, options(demandFor)), { town: 'Dion', room: 0, rollKey: ['r2', selfId] });

    const sells = decide(ORE, 40, demand(1000));
    assert.equal(sells.action, 'list', 'the board pays more than the NPC: list');
    assert(sells.priced.ask.price > Price.buyback(ORE), 'at an ask over the NPC buy-back');
    assert.equal(decide(ORE, 40, demand(0)).action, 'npc', 'no buyer on the board: the NPC pays more');
    const quote = decide(gear.selfId, 1, () => null);
    assert.equal(quote.action, 'list', 'unknown demand, a belief above the NPC: list, not the NPC');
    assert(quote.priced.ask.price > Price.buyback(gear.selfId), 'at the belief\'s ask over the NPC');
    board.put({ id: 9690010, ownerId: 9691010, kind: 'buy_ad', storeType: 3, town: 'Dion', custodyPolicy: 0, revision: 1,
        lines: [{ lineId: 9692010, selfId: gear.selfId, count: 1, price: Price.buyback(gear.selfId) * 3 }] });
    assert.equal(decide(gear.selfId, 1, () => null).action, 'ad',
        'a real bid over the NPC buy-back beats a listing of unknown demand');
    board.remove(9690010);

    const two = { ...adventurer, inventory: { [ORE]: { selfId: ORE, amount: 40, kind: 'Other.Material' },
        [COAL]: { selfId: COAL, amount: 1, kind: 'Other.Material' } } };
    const sale = Listing.evaluate(two, options(demand(1000), { slots: 1 }));
    assert.deepEqual(sale.listings.map(row => Number(row.selfId)), [ORE], 'the one slot goes to the higher gain over the NPC');
    assert.equal(sale.decisions.find(row => Number(row.item.selfId) === COAL).action, 'npc',
        'the stock without a slot takes its next answer: an adventurer sells it to the NPC');
}

{
    // An adventurer has no warehouse, so no keep option (user 2026-10-24): an
    // item it values above a bid that pays more than the NPC goes into that
    // bid or onto the market at a market visit, never to the NPC.
    const Listing = invoke('GameServer/Bot/Economy/MarketListingPolicy');
    const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
    const ORE = 1869, now = 1800000000000, RUNS = 20;
    const npc = invoke('GameServer/Bot/Economy/PriceDecision').buyback(ORE);
    const bid = npc * 3;
    const board = new BoardIndex();
    board.put({ id: 9700010, ownerId: 9700011, kind: 'buy_ad', storeType: 3, town: 'Dion', custodyPolicy: 0,
        lines: [{ lineId: 9700012, selfId: ORE, count: 50, price: bid }] });
    const trip = () => 0; trip.details = () => ({ known: true, hours: 0, fees: 0 });
    const economy = { hourAdena: 1000, moneyPrice: .001, network: {}, worth: id => id === ORE ? bid * 4 : 0,
        persona: { traits: {}, understanding: .3 }, stock: () => ({ itemId: 1060, target: 0 }) };
    const demandFor = id => id === ORE ? { known: true, origin: 'fixture', authority: { id: 1 }, selfId: ORE,
        applicableUnits: 20, delayHours: 1, availability: { from: now, until: now + RUNS } } : null;
    const adventurer = { characterId: 4343, level: 40, adena: 50000, activity: 'shopping', currentRegion: 'Dion',
        stats: {}, inventory: { [ORE]: { selfId: ORE, amount: 40, kind: 'Other.Material' } } };
    for (let at = 0; at < RUNS; at++) {
        const sale = Listing.evaluate(adventurer, { now: now + at, timestamp: now + at, board, economy, tripCost: trip, demandFor,
            npcOffersFor: () => [] });
        const ore = sale.decisions.find(row => Number(row.item.selfId) === ORE);
        assert(ore && ['ad', 'list'].includes(ore.action), `an adventurer sells above the NPC, got ${ore?.action}`);
        if (ore.action === 'list') assert(ore.item.price > npc, 'its ask pays more than the NPC');
    }
}
{
    // A book longer than the inspected head (41 foreign asks at 2000, every
    // town a 500 Adena trip): an unseen ask lands at 2000 + 500 at least, so
    // an own ask landing at or below that has a known competition and lists
    // up to 2000 (a raw bound of 2000 would stop it at 1500).
    const Listing = invoke('GameServer/Bot/Economy/MarketListingPolicy');
    const EconomicTrip = invoke('GameServer/Bot/Economy/EconomicTrip');
    const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
    const ORE = 1869, now = 1800000000000, RUNS = 40, UNSEEN = 2000;
    const board = new BoardIndex();
    for (let at = 0; at < 41; at++) board.put({ id: 9710000 + at, ownerId: 9720000 + at, kind: 'sell_ad', storeType: 1,
        town: 'Giran', revision: 1, lines: [{ lineId: 9730000 + at, selfId: ORE, count: 10, price: UNSEEN }] });
    const trip = EconomicTrip.preparedReader(EconomicTrip.towns.map(() => [true, .5, 0]), { hourAdena: 1000 });
    const economy = { hourAdena: 1000, moneyPrice: .001, network: {}, worth: () => 0,
        persona: { traits: {}, understanding: .3 }, stock: () => ({ itemId: 1060, target: 0 }) };
    const demandFor = id => id === ORE ? { known: true, origin: 'fixture', authority: { id: 1 }, selfId: ORE,
        applicableUnits: 1000, delayHours: 1, availability: { from: now, until: now + RUNS } } : null;
    const adventurer = { characterId: 4344, level: 40, adena: 50000, activity: 'shopping', currentRegion: 'Giran',
        stats: {}, inventory: { [ORE]: { selfId: ORE, amount: 40, kind: 'Other.Material' } } };
    const prices = [];
    for (let at = 0; at < RUNS; at++) {
        const sale = Listing.evaluate(adventurer, { now: now + at, timestamp: now + at, board, economy, tripCost: trip,
            demandFor, npcOffersFor: () => [] });
        const ore = sale.decisions.find(row => Number(row.item.selfId) === ORE);
        if (ore?.action === 'list') prices.push(ore.priced.ask.price);
    }
    assert(prices.every(price => price <= UNSEEN), `no ask lands above the cheapest unseen one, got ${prices}`);
    assert(prices.some(price => price > UNSEEN - 500), `the crowded book lists up to the unseen ask, got ${prices}`);
}
{
    // A crafter's shot listing exit on a crowded book: the worker's plan
    // (ColdOccupationSources.prepare -> its exits), with or without a ready
    // route table, finds the exit main's recheck of the same exit finds
    // (ShotSalePolicy.exit over CraftProfitPolicy.tripFor), at one price.
    const Sources = require('../src/GameServer/Bot/Population/ColdOccupationSources');
    const EconomicTrip = invoke('GameServer/Bot/Economy/EconomicTrip');
    const Demand = invoke('GameServer/Bot/Economy/MarketDemand');
    const Profit = invoke('GameServer/Bot/Economy/CraftProfitPolicy');
    const SalePolicy = invoke('GameServer/Bot/Economy/ShotSalePolicy');
    const Recipes = invoke('GameServer/Items/C4RecipeItems');
    const Persona = invoke('GameServer/Bot/AI/BotPersona');
    const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
    Sources.initialise();
    const drain = iterator => { let step; do { step = iterator.next(); } while (!step.done); return step.value; };
    const SHOT_D = 1463, recipe = Recipes.resolveByProductId(SHOT_D), timestamp = Date.now();
    // In the field by Hunter's Village: the nearest town is a trip (about
    // 1400 Adena at this hour) far above the 41 asks at 60 there.
    const crafter = { characterId: 4345, level: 40, classId: 56, adena: 1000000, currentRegion: "Hunter's Village",
        loc: { locX: 117000, locY: 76000, locZ: -2800 }, inventory: { 736: { selfId: 736, amount: 1 } },
        stats: { classId: 56, money: [100000, .001, 0, 0] }, marketTrades: {},
        persona: Persona.generate({ characterId: 4345, classId: 56 }) };
    const routeRows = drain(EconomicTrip.prepare(crafter)), routeKey = EconomicTrip.key(crafter);
    const table = EconomicTrip.preparedReader(routeRows, { hourAdena: 100000 });
    const town = EconomicTrip.towns.reduce((best, name) => table(name) < table(best) ? name : best);
    Demand.deal(SHOT_D, 5000, town, timestamp); Demand.deal(SHOT_D, 5000, town, timestamp);
    const unseen = 60;
    const board = new BoardIndex();
    for (let at = 0; at < 41; at++) board.put({ id: 9740000 + at, ownerId: 9750000 + at, kind: 'sell_ad', storeType: 1,
        town, revision: 1, lines: [{ lineId: 9760000 + at, selfId: SHOT_D, count: 100, price: unseen }] });
    const planned = economy => {
        const prepared = drain(Sources.prepare(crafter, { board, timestamp, ...economy }));
        return drain(prepared.options.prepareExits(crafter, recipe)).find(row => row.type === 'listing' && row.town === town);
    };
    const lot = Number(recipe.productCount);
    assert(table(town) > unseen);
    for (const plan of [planned({ economy: { routeKey, routeRows } }), planned({})]) {
        assert(plan && plan.price <= unseen, 'the plan finds a listing exit at or below the cheapest unseen ask');
        const checked = SalePolicy.exit(crafter, SHOT_D, { board, town, timestamp, current: plan.price, lot,
            trip: Profit.tripFor(crafter, { hourAdena: 100000 }), productionUnits: lot, units: lot,
            npcOffers: Sources.npcOffersFor(SHOT_D) });
        assert.equal(checked?.price, plan.price, 'main\'s recheck finds the planned exit at its price');
    }
    Demand.reset();
}
console.log('Owned-stock quote decisions and native listing slots passed');
