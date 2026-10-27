'use strict';
const assert = require('node:assert/strict');
const { useRate } = require('./helpers/progressionRate');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Sources = require('../src/GameServer/Bot/Population/ColdOccupationSources');
const Trip = require('../src/GameServer/Bot/Population/ColdTrip');
const Towns = require('../src/GameServer/World/TownRespawn');
const Config = require('../src/GameServer/Bot/Population/PopulationConfig');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
Sources.initialise();
function drain(iterator) {
    const stages = []; let next;
    do { next = iterator.next(); if (!next.done) stages.push(next.value); } while (!next.done);
    return { value: next.value, stages };
}
assert(Sources.npcOffersFor(1785).length > 0);
assert(Sources.npcOffersFor(1785).every(row => row.sourceId > 0 && row.town && row.price > 0));
const Catalogue = require('../src/GameServer/Knowledge/GameDataCatalogue').native();
const startupOffers = Sources.npcOffersFor(1785), sharedView = Catalogue.npcTownOffers();
assert.strictEqual(startupOffers, sharedView.offersFor(1785), 'cold reader borrows the shared item/town stock');
const originalRate = process.env.L2NODE_PROGRESSION_RATE;
try {
    useRate('x50');
    assert.notStrictEqual(Catalogue.npcTownOffers(), sharedView, 'a current shared query can read a revised rate');
    assert.strictEqual(Sources.npcOffersFor(1785), startupOffers,
        'the cold occupation contract retains its original startup-time prices');
} finally {
    useRate(originalRate);
}
assert(Object.isFrozen(Towns.regionIndex.zones[0].points[0]));
for (const loc of [Towns.towns.giran_town, Towns.towns.floran_village,
    { locX: 112000, locY: -15000, locZ: 0 }, { locX: 0, locY: 240000, locZ: -4000 },
    { locX: 500000, locY: 500000, locZ: 0 }]) {
    const regional = drain(Sources.regionalTown(loc));
    assert.strictEqual(regional.value, Towns.getClosestTown(loc.locX, loc.locY, loc.locZ));
    assert(regional.stages.length > 0);
}
const state = { characterId: 900004, phase: 'cold', activity: 'hunting', level: 40,
    adena: 1000000, loc: { locX: 117000, locY: 76000, locZ: -2800 }, currentRegion: "Hunter's Village",
    inventory: { 736: { selfId: 736, amount: 1 }, 1864: { selfId: 1864, amount: 100 } },
    stats: { classId: 57, money: [1000, .001, 0, 0] } };
const savedHonest = Config.coldHonestTravel;
try {
    for (const honest of [false, true]) {
        Config.coldHonestTravel = honest;
        const streamed = drain(Sources.tripDetails(state, 'Giran'));
        const destination = Towns.towns.giran_town;
        const forward = Trip.townPlan(state, destination);
        const back = Trip.spotTripMs({ ...state, loc: Trip.point(destination) }, state.loc);
        assert.equal(streamed.value.hours, (forward.durationMs + back) / 3600000);
        assert.equal(streamed.value.fees, forward.route.fee);
        if (honest) assert(streamed.stages.filter(stage => stage === 'edge').length >= Sources.catalogCounts().teleportEdges);
    }
} finally { Config.coldHonestTravel = savedHonest; }
const board = new BoardIndex();
for (let at = 0; at < 6; at++) board.put({ id: 200 + at, ownerId: 400 + at, storeType: 1,
    kind: 'sell_ad', town: 'Giran', revision: 1,
    lines: [{ lineId: 300 + at, selfId: 1864, count: 1, price: 100 + at }] });
const read = new Set();
const owner = { ...state, activity: 'shopping', currentRegion: 'Giran', loc: Towns.towns.giran_town };
const prepared = drain(Sources.prepare(owner, { board, timestamp: 1000, read: id => read.add(id) })).value;
assert(prepared && read.has(1864));
assert.equal(prepared.options.ownStock.get(1864).count, 100);
const bounded = drain(prepared.options.preparePurchase(owner, 1864, 6, { npc: false }));
assert.equal(bounded.value.units, 5, 'native purchase view admits only the first five indexed rows');
assert.equal(bounded.value.whole, false);
assert.equal(drain(prepared.options.preparePurchase(owner, 1785, 1, { npc: false })).value, null);
const npc = drain(prepared.options.preparePurchase(owner, 1785, 1, { npc: true })).value;
assert(npc.whole && npc.npc === 1 && npc.town);
// A held unit is worth the bot's own price belief (user 2026-10-22), not
// what it gets selling one unit now: neither the others' top bid nor NPC
// buyback, and two bots holding the same stack on the same board value it
// each through their own error.
const bids = new BoardIndex();
bids.put({ id: 700, ownerId: owner.characterId, storeType: 3, kind: 'buy_ad', town: 'Giran', revision: 1,
    lines: [{ lineId: 800, selfId: 1864, count: 1, price: 900 }] });
for (let at = 1; at < 7; at++) bids.put({ id: 700 + at, ownerId: 500 + at, storeType: 3, kind: 'buy_ad',
    town: 'Giran', revision: 1, lines: [{ lineId: 800 + at, selfId: 1864, count: 1, price: 500 - at }] });
const heldWorth = holder => drain(Sources.prepare(holder, { board: bids, timestamp: 1000 })).value.options.ownStock.get(1864).unitValue;
const PriceBelief = require('../src/GameServer/Bot/Economy/PriceBelief');
const worth = heldWorth(owner);
assert(worth > 0);
assert.equal(worth, PriceBelief.reader({ state: owner, board: bids, timestamp: 1000 }).price(1864),
    'the held unit reads the bot price reader');
assert.notEqual(worth, 499, 'the best bid of others is not the held worth');
assert.notEqual(worth, require('../src/GameServer/Bot/Economy/PriceDecision').buyback(1864), 'NPC buyback is not the held worth');
assert.notEqual(heldWorth({ ...owner, characterId: 900010 }), heldWorth({ ...owner, characterId: 900011 }),
    'two bots holding the same stack on the same board value it through their own error');
const EconomicTrip = require('../src/GameServer/Bot/Economy/EconomicTrip');
const routeRows = drain(EconomicTrip.prepare(state)).value;
const routeKey = EconomicTrip.key(state);
const reusedSources = drain(Sources.prepare(state, { board, timestamp: 1000, economy: { routeKey, routeRows } })).value;
const freshSources = drain(Sources.prepare(state, { board, timestamp: 1000 })).value;
const reusedPurchase = drain(reusedSources.options.preparePurchase(state, 1864, 1, { npc: false }));
const freshPurchase = drain(freshSources.options.preparePurchase(state, 1864, 1, { npc: false }));
assert.deepEqual(reusedPurchase.value, freshPurchase.value, 'occupation/actions share the accepted wish route table');
assert(freshPurchase.stages.includes('edge') && !reusedPurchase.stages.includes('edge'),
    'the ready shared table removes repeated geometry, not source or spending revalidation');
const staleSources = drain(Sources.prepare(state, { board, timestamp: 1000,
    economy: { routeKey: 'obsolete', routeRows } })).value;
assert(drain(staleSources.options.preparePurchase(state, 1864, 1, { npc: false })).stages.includes('edge'),
    'a changed route key cannot suppress actual route preparation');
const protectedState = { ...owner, stats: { ...owner.stats, equipmentPlan: { strategy: 'craft', status: 'active',
    target: { selfId: 3000 }, materials: [{ selfId: 1864, amount: 40 }] } } };
assert.equal(drain(Sources.reservations(protectedState)).value[1864], 40);
const listed = new BoardIndex();
listed.put({ id: 1, ownerId: owner.characterId, storeType: 1, kind: 'sell_ad', town: 'Giran', revision: 2,
    lines: [{ lineId: 1, selfId: 1864, count: 10, price: 100 }] });
const allocated = { ...protectedState, inventory: { 1864: { selfId: 1864, amount: 20 } } };
const mask = drain(Sources.feasibility(allocated, { board: listed })).value;
const Look = require('../src/GameServer/Bot/Economy/BoardLook');
const lines = listed.ownerLines(owner.characterId);
assert.equal(Look.feasibilityPredicate(allocated, lines, mask)(lines[0]), false,
    'a deep captured ingredient reservation protects the listed stock on a natural look');
const Publication = require('../src/GameServer/Bot/Population/ColdEconomyDecision');
const publication = Publication.compact(structuredClone(Publication.capture({ workshop: { known: false, feasibility: mask } }, allocated)));
assert.deepEqual(publication.feasibility, mask);
assert.equal(Look.feasibilityPredicate(allocated, [{ ...lines[0], revision: 3 }], mask)(lines[0]), undefined,
    'a changed physical line does not reuse an accepted old protection mask');
assert.equal(drain(Sources.prepare({ ...owner, stats: {} }, { board })).value, null);
// A product already made counts its own plain sell lines; an enchanted one
// (the exits are enchant 0) and a conditional one are not units held.
const madeBoard = new BoardIndex();
madeBoard.put({ id: 2, ownerId: owner.characterId, storeType: 1, kind: 'sell_ad', town: 'Giran', revision: 1,
    lines: [{ lineId: 2, selfId: 159, count: 2, price: 900 }, { lineId: 3, selfId: 159, enchant: 4, count: 1, price: 5000 }] });
madeBoard.put({ id: 3, ownerId: owner.characterId, storeType: 1, kind: 'sell_ad', town: 'Giran', revision: 1,
    custodyPolicy: 1, lines: [{ lineId: 4, selfId: 159, count: 3, price: 900 }] });
assert.equal(drain(Sources.prepare(owner, { board: madeBoard, timestamp: 1000 })).value.options.existing(159), 2,
    'only the plain enchant-0 sell line of a made product is held');
const Plan = require('../src/GameServer/Bot/Population/ColdEconomyPlan');
const Shots = require('../src/GameServer/Bot/Economy/ShotCraftPolicy');
const selected = { craft: { recipeId: 25, batches: 64, exit: [200, 1000001, 1000, 9999],
    gear: [247, 0, 201, 1000002, 100, 9999], ownReserve: 3000 } };
const step = Plan.decideShot(owner, null, { preparedCraft: selected });
assert.equal(step.unknown, undefined, 'an ordinary selected source survives the inclusive command budget');
assert(Buffer.byteLength(JSON.stringify(step)) + Publication.COMMAND_HEADER_BYTES <= Plan.MAX_SHOT_BYTES);
const decoded = Shots.unpackStep(step);
assert.deepEqual(decoded.craft.exit, [null, 1000001, null, 9999]);
assert.deepEqual(decoded.craft.gear, [247, 0, null, 1000002, null, 9999]);
assert.equal(decoded.craft.ownReserve, 3000);
const packedDecision = Publication.compact(structuredClone(Publication.capture({ shot: step,
    workshop: { known: true, recipeId: 25, productId: 1864, incomePerHour: 0.1, cycleHours: 0.01 } }, owner)));
assert.deepEqual(packedDecision.shot, step);
assert.equal(Plan.MAX_PLAN_PAYLOAD_BYTES + Publication.COMMAND_HEADER_BYTES + 32 + 8, Plan.MAX_BYTES);
console.log('PASS native town/NPC authority parity, streamed routes/reservations and five-quote purchase view');

// Public wishes keep all quotes; the executable worker sources use current
// party admission without changing the bounded five-row view.
const Admission = require('../src/GameServer/Bot/Population/PartyAdmission');
let sourceOwner = { characterId: 701, party: { partyId: 'busy-party' } };
Admission.configureTradeAdmission(id => Number(id) === 701 ? sourceOwner : null);
const admissionBoard = new BoardIndex();
admissionBoard.put({ id: 701, ownerId: 701, storeType: 1, custodyPolicy: 1, kind: 'sell_ad', town: 'Giran', revision: 1,
    lines: [{ lineId: 7010, selfId: 1864, count: 10, price: 1 }] });
admissionBoard.put({ id: 702, ownerId: 702, storeType: 1, kind: 'shop', town: 'Giran', revision: 1,
    lines: [{ lineId: 7020, selfId: 1864, count: 10, price: 100 }] });
admissionBoard.put({ id: 703, ownerId: 701, storeType: 3, custodyPolicy: 1, kind: 'buy_ad', town: 'Giran', revision: 1,
    lines: [{ lineId: 7030, selfId: 1882, count: 10, price: 10000 }] });
admissionBoard.put({ id: 704, ownerId: 702, storeType: 3, kind: 'shop', town: 'Giran', revision: 1,
    lines: [{ lineId: 7040, selfId: 1882, count: 10, price: 9000 }] });
const admittedSources = drain(Sources.prepare(owner, { board: admissionBoard, timestamp: 1000 })).value;
const admittedPurchase = drain(admittedSources.options.preparePurchase(owner, 1864, 1, { npc: false })).value;
assert.equal(admittedPurchase.lines[0].line.recordId, 702, 'a cheaper party personal ask cannot start ingredient travel');
const leatherRecipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(25);
const leatherTemplate = Data.items.find(item => Number(item.selfId) === Number(leatherRecipe.productId));
const admittedExits = drain(admittedSources.options.prepareExits(owner, leatherRecipe, leatherTemplate)).value;
assert(!admittedExits.some(exit => exit.offer?.recordId === 703), 'a party personal bid is not an executable craft exit');
assert(admittedExits.some(exit => exit.offer?.recordId === 704), 'a backed shop remains an executable exit');
const crystalGear = Data.items.find(item => Number(item.etc?.cristals) > 0
    && /^(Weapon|Armor)\./.test(String(item.template?.kind || '')));
admissionBoard.put({ id: 705, ownerId: 701, storeType: 1, custodyPolicy: 1, kind: 'sell_ad', town: 'Giran', revision: 1,
    lines: [{ lineId: 7050, selfId: crystalGear.selfId, count: 1, price: 1 }] });
admissionBoard.put({ id: 706, ownerId: 702, storeType: 1, kind: 'shop', town: 'Giran', revision: 1,
    lines: [{ lineId: 7060, selfId: crystalGear.selfId, count: 1, price: 100 }] });
const gearSources = [...admittedSources.options.gearRowsFor(String(crystalGear.etc.rank))].filter(Boolean);
assert(!gearSources.some(row => row.offer?.recordId === 705), 'crystal acquisition cannot use a party personal gear supplier');
assert(gearSources.some(row => row.offer?.recordId === 706), 'backed gear remains a crystal acquisition option');
// A craft buys through an errand: only lines that sell at once, so the cheaper
// conditional ask stays out even when its owner is free to meet.
sourceOwner = { characterId: 701 };
const releasedPurchase = drain(admittedSources.options.preparePurchase(owner, 1864, 1, { npc: false })).value;
assert.equal(releasedPurchase.lines[0].line.recordId, 702, 'a craft input errand skips the conditional ask of a free owner');
const releasedGear = [...admittedSources.options.gearRowsFor(String(crystalGear.etc.rank))].filter(Boolean);
assert(!releasedGear.some(row => row.offer?.recordId === 705), 'crystal gear is not bought from a conditional ask of a free owner');
assert(releasedGear.some(row => row.offer?.recordId === 706), 'backed gear stays the crystal gear source');
// The lines a trader inspects are counted among those that sell at once: a
// quote depth of cheaper conditional asks does not hide the shop behind them.
{
    const deepBoard = new BoardIndex();
    for (let at = 0; at < 5; at++) deepBoard.put({ id: 721 + at, ownerId: 721 + at, storeType: 1, custodyPolicy: 1,
        kind: 'sell_ad', town: 'Giran', revision: 1, lines: [{ lineId: 7210 + at, selfId: 1864, count: 10, price: 1 + at }] });
    deepBoard.put({ id: 726, ownerId: 702, storeType: 1, kind: 'shop', town: 'Giran', revision: 1,
        lines: [{ lineId: 7260, selfId: 1864, count: 10, price: 100 }] });
    const deepSources = drain(Sources.prepare(owner, { board: deepBoard, timestamp: 1000 })).value;
    const deepPurchase = drain(deepSources.options.preparePurchase(owner, 1864, 1, { npc: false })).value;
    assert.equal(deepPurchase?.lines[0].line.recordId, 726, 'a shop under five cheaper conditional asks is still a craft input source');
}
// A craft for sale buys only from lines that sell at once too: the cheaper conditional
// ask waits on its seller's trade meeting, so the wealth step takes the shop
// for the inputs; with the conditional ask alone there is no source and no craft.
{
    const Wealth = invoke('GameServer/Bot/Economy/WealthCraftDecision');
    const crafter = { ...owner, vitals: { mp: 500, maxMp: 500 }, inventory: {} };
    const choose = ({ item, shop }) => {
        const craftBoard = new BoardIndex();
        craftBoard.put({ id: 711, ownerId: 701, storeType: 1, custodyPolicy: 1, kind: 'sell_ad', town: 'Giran', revision: 1,
            lines: [{ lineId: 7110, selfId: item, count: 6, price: 1 }] });
        if (shop) craftBoard.put({ id: 712, ownerId: 702, storeType: 1, kind: 'shop', town: 'Giran', revision: 1,
            lines: [{ lineId: 7120, selfId: item, count: 6, price: 500 }] });
        if (item !== 1867) craftBoard.put({ id: 714, ownerId: 702, storeType: 1, kind: 'shop', town: 'Giran', revision: 1,
            lines: [{ lineId: 7140, selfId: 1867, count: 6, price: 500 }] });
        craftBoard.put({ id: 713, ownerId: 702, storeType: 3, kind: 'shop', town: 'Giran', revision: 1,
            lines: [{ lineId: 7130, selfId: leatherRecipe.productId, count: 1, price: 90000 }] });
        const sources = drain(Sources.prepare(crafter, { board: craftBoard, timestamp: 1000 })).value;
        // The producer root chose the buyer line 713 as the exit; the step sizes the craft on it,
        // spending at the root's money-queue ratio r (2c1810b46; here a funded root).
        const queue = [{ key: `resale:${leatherRecipe.productId}`, amount: leatherRecipe.productCount,
            recipeId: leatherRecipe.recipeId, exit: [713, 7130, 90000, 1], recipeReady: true, r: 1 }];
        const chosen = drain(Wealth.producerStep(crafter, queue, [{ recipeId: leatherRecipe.recipeId }], sources)).value;
        return chosen && chosen.basket.purchases.find(row => Number(row.selfId) === item).lines[0].line.recordId;
    };
    assert.equal(choose({ item: 1867, shop: true }), 712, 'a craft for sale buys its inputs from the shop, not the cheaper conditional ask');
    assert.equal(choose({ item: 1867, shop: false }), null, 'a conditional ask alone is no input source for a craft for sale');
}
// A buyer's line bounds the craft to the units it takes from this crafter:
// a 10-unit bid behind 3 cheaper foreign asks takes 7 leathers, so the step
// crafts 7 batches, not 10 left over at buyback.
{
    const Wealth = invoke('GameServer/Bot/Economy/WealthCraftDecision');
    const crafter = { ...owner, vitals: { mp: 500, maxMp: 500 }, inventory: {} };
    const lotBoard = new BoardIndex();
    lotBoard.put({ id: 731, ownerId: 701, storeType: 3, custodyPolicy: 1, kind: 'buy_ad', town: 'Giran', revision: 1,
        lines: [{ lineId: 7310, selfId: leatherRecipe.productId, count: 10, price: 90000 }] });
    lotBoard.put({ id: 732, ownerId: 702, storeType: 1, kind: 'shop', town: 'Giran', revision: 1,
        lines: [{ lineId: 7320, selfId: leatherRecipe.productId, count: 3, price: 1000 }] });
    lotBoard.put({ id: 733, ownerId: 702, storeType: 1, kind: 'shop', town: 'Giran', revision: 1,
        lines: [{ lineId: 7330, selfId: 1867, count: 600, price: 1 }] });
    const sources = drain(Sources.prepare(crafter, { board: lotBoard, timestamp: 1000 })).value;
    const queue = [{ key: `resale:${leatherRecipe.productId}`, amount: 10 * leatherRecipe.productCount,
        recipeId: leatherRecipe.recipeId, exit: [731, 7310, 90000, 1], recipeReady: true, r: 1 }];
    const chosen = drain(Wealth.producerStep(crafter, queue, [{ recipeId: leatherRecipe.recipeId }], sources)).value;
    assert.equal(chosen?.batches, 7, 'a bid behind cheaper asks is crafted for the units it takes');
}
// OfferQuery.cheapestIn holds a table's fills by the item's admission revision: a seller's party join or leave
// through the rule's write path (PartyAdmission.watchStates, the worker's kernel.states) reprices every held amount.
{
    const OfferQuery = require('../src/GameServer/Bot/Economy/OfferQuery');
    const states = new Map([[701, { characterId: 701 }]]);
    Admission.configureTradeAdmission(id => states.get(Number(id)) || null);
    Admission.watchStates(states, admissionBoard);
    const priceTable = () => OfferQuery.townTable(admissionBoard, 1864, { quoteDepth: 5, excludeOwner: 800,
        accept: Admission.offerAdmission({ characterId: 800 }) });
    const recordsOf = best => best.lines.map(entry => entry.line.recordId);
    const held = priceTable();
    assert.deepEqual(recordsOf(OfferQuery.cheapestIn(held, 5)), [701], 'the free conditional ask wins while its owner is unpartied');
    OfferQuery.cheapestIn(held, 6);
    states.set(701, { characterId: 701, party: { partyId: 'busy-party' } });
    assert.deepEqual(recordsOf(OfferQuery.cheapestIn(held, 5)), [702], 'a held table takes no ask of a seller that joined a party');
    assert.deepEqual(OfferQuery.cheapestIn(held, 6), OfferQuery.cheapestIn(priceTable(), 6), 'every held amount is repriced, as a fresh table');
    states.delete(701);
    assert.deepEqual(recordsOf(OfferQuery.cheapestIn(held, 5)), [701], 'the ask is a source again once its seller left');
}
Admission.configureTradeAdmission(id => invoke('GameServer/Bot/Population/BotLifeState').cachedState(Number(id)),
    id => invoke('GameServer/World/World').registeredActorById(Number(id))?.session);
