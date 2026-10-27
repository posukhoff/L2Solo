'use strict';
const assert = require('node:assert/strict');
const { Worker, isMainThread, parentPort } = require('node:worker_threads');
require('./helpers/databaseIsolation');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Crystals = invoke('GameServer/Bot/Economy/BotCrystallization');
const Evidence = invoke('GameServer/Bot/Economy/WishPurchaseEvidence');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Gear = invoke('GameServer/Bot/AI/BotGear');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const Generation = require('../src/GameServer/Bot/Population/RecomputeGeneration');
// A context holds only by its event proof, which needs the warehouse rows
// and a recompute generation; without them every request builds anew.
invoke('GameServer/Bot/Economy/PersonalWarehouseIndex').useRowSource(() => null, () => true);
Generation.configure({ code: '1'.repeat(40), config: '2'.repeat(64) });
const inventory = {};
for (const row of Gear.planFor({ classId: 46, level: 20 }).items) {
    if ([7, 14].includes(row.slot)) continue;
    const held = inventory[row.selfId];
    inventory[row.selfId] = { ...row, amount: Number(held?.amount || 0) + 1,
        equipped: true, equippedCount: Number(held?.equippedCount || 0) + 1,
        equippedSlots: [...held?.equippedSlots || [], row.slot] };
}
inventory[86] = { selfId: 86, amount: 1, slot: 7, equipped: true, equippedCount: 1, equippedSlots: [7] };
// A stack under the survival floor's weight line: bought inputs need bag room.
inventory[1463] = { selfId: 1463, amount: 10000 };
inventory[1458] = { selfId: 1458, amount: 141 };
const timestamp = 1791741600000;
let state = { characterId: 990771, level: 49, adena: 3632378, inventory,
    phase: 'cold', activity: 'hunting', currentRegion: 'Giran',
    loc: { locX: 83396, locY: 147904, locZ: -3400 },
    stats: { classId: 46, exp: Data.experience[48] } };
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
// The class tree has no Crystallize: this bot never breaks gear itself.
const unskilled = { ...state, stats: { ...state.stats,
    coldCombat: Profile.legacySnapshot(state, Profile.skillRecordsFromTree(46, 49), timestamp) } };
// The same bot with its own Crystallize skill (248) at a level for D and C.
const withCrystallize = (from, level) => ({ ...from, stats: { ...from.stats, coldCombat: { ...from.stats.coldCombat,
    skills: [...from.stats.coldCombat.skills, ...Profile.skillSnapshotsFromRecords([{ selfId: 248, level }])] } } });
state = withCrystallize(unskilled, 2);
const before = structuredClone(state);
const board = new BoardIndex();
function offer(id, price, count = 1, town = 'Giran') {
    board.put({ id, ownerId: 991000 + id, storeType: 1, kind: 'shop', town,
        lines: [{ lineId: id, selfId: id, count, enchant: 0, price }] });
}
let routeFees = 0;
const trip = () => routeFees;
trip.details = () => ({ known: true, hours: 0, fees: routeFees });
// A reader keeps each item's first quote for its build (WishPurchaseEvidence
// queries): every read below is a fresh build over the board as it is now.
const purchase = id => Evidence.reader(state, { board, trip }, { npcOffersFor: () => [] })(id);
const kit = () => invoke('GameServer/Bot/Population/ColdCombatProfile').profileFor(state, Date.now());
offer(90, 1909712);
assert.equal(Crystals.choices(state, purchase, 0, 'd', null, kit)[0].selfId, 90);
offer(166, 206926);
let choices = Crystals.choices(state, purchase, 0, 'd', null, kit);
assert.equal(choices[0].selfId, 166, 'a real cheap quote outside the old catalogue shortlist wins');
assert.equal(choices[0].net, 743, 'own skill: the whole crystal count, no service fee');
assert.equal(choices[0].batchLimit, 1, 'a one-copy quote never permits a larger physical order');
assert(choices.length <= 2, 'only two crystallization paths enter the native graph');
routeFees = 1000000;
assert.equal(Crystals.choices(state, purchase, 0, 'd', null, kit)[0].selfId, 90,
    'travel is paid for each input errand and can change the cheapest crystal source');
routeFees = 0;
offer(166, 206926, 0);
assert.equal(Crystals.choices(state, purchase, 0, 'd', null, kit)[0].selfId, 90, 'sold-out stock is not a source');
offer(166, 206926);
offer(86, 1, 16);
assert(!Crystals.choices(state, purchase, 0, 'd', null, kit).some(row => row.selfId === 86), 'worn gear stays protected');
const held = { ...state, inventory: { ...state.inventory,
    166: { selfId: 166, amount: 2, equipped: false } } };
const owned = Crystals.choices(held, () => null)[0];
assert.equal(owned.selfId, 166, 'physical spares work without a market quote');
assert.equal(owned.batchLimit, 2);
assert.deepEqual(Crystals.choices(unskilled, purchase), [], 'without Crystallize no quote is a crystal source');
assert.deepEqual(Crystals.choices({ ...unskilled, inventory: held.inventory }, () => null), [],
    'without Crystallize held spares are not a crystal source either');
{
    // A crystal preparation saved before the own-skill rule: the bot cannot
    // break its gear, so the gear is neither kept from sale nor bought for it.
    const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
    const equipmentPlan = { strategy: 'craft', status: 'active', target: { selfId: 78, slot: 7 },
        materials: [{ selfId: 1459, amount: 10 }], crystalPreparation: { materials: [{ selfId: 166, amount: 2 }] } };
    const planned = from => ({ ...from, inventory: held.inventory, stats: { ...from.stats, equipmentPlan } });
    assert.equal(Disposition.reservedEquipmentAmounts(planned(state))[166], 2, 'a skilled bot keeps its inputs');
    assert.equal(Crystals.inputAmount(planned(state), 166), 2, 'a skilled bot may buy its inputs');
    assert(!Disposition.reservedEquipmentAmounts(planned(unskilled))[166], 'without Crystallize the gear is free to sell');
    assert.equal(Crystals.inputAmount(planned(unskilled), 166), 0, 'without Crystallize no purchase is admitted as input');
    // An older luxury exchange plan lists its gear inputs among its materials:
    // without the skill that gear is free too, the exchange crystals stay held.
    const exchange = invoke('GameServer/Bot/Economy/BotLuxuryExchange').recipes().get(161);
    const luxury = from => ({ ...from, inventory: held.inventory, stats: { ...from.stats, equipmentPlan: {
        strategy: 'luxury_exchange', status: 'active', target: { selfId: 161, slot: 7 }, exchange,
        materials: [...exchange.materials.map(row => ({ ...row })), { selfId: 166, amount: 2 }] } } });
    assert.equal(Disposition.reservedEquipmentAmounts(luxury(state))[166], 2, 'a skilled bot keeps its luxury inputs');
    assert(!Disposition.reservedEquipmentAmounts(luxury(unskilled))[166], 'without Crystallize luxury gear is free to sell');
    assert(Disposition.reservedEquipmentAmounts(luxury(unskilled))[exchange.materials[0].selfId] > 0,
        'the exchange crystals stay held');
}
{
    const Network = invoke('GameServer/Bot/Economy/WishNetwork');
    const Providers = invoke('GameServer/Bot/Economy/WishProviders');
    const quantities = Network.createQuantityInputs();
    const captured = Crystals.choices(held, () => null, 0, 'd', quantities);
    assert.deepEqual(captured, Crystals.choices(held, () => null),
        'native quantity capture preserves every ranked crystallization choice');
    const proof = quantities.finish();
    assert(proof, 'actual held native inputs fit the bounded owner proof');
    assert(Network.quantityInputsHold(proof, Providers.quantityReaders(held)));
    const consumed = { ...held, inventory: { ...held.inventory, 166: { ...held.inventory[166], amount: 1 } } };
    assert.equal(Crystals.choices(consumed, () => null)[0].batchLimit, 1,
        'native current free stock reduces the executable crystal batch');
    assert.equal(Network.quantityInputsHold(proof, Providers.quantityReaders(consumed)), false,
        'physical crystal inputs stay exact even while bag IDs, presence and gear capability are unchanged');
}
assert.deepEqual(state, before, 'source selection never mutates the live kit');

for (const id of Crystals.catalog()) if (![90, 166, 86].includes(id)) offer(id, 10000000);
choices = Crystals.choices(state, purchase, 0, 'd', null, kit);
assert.equal(choices[0].selfId, 166, 'a full market still ranks the cheapest safe input first');
assert.equal(choices[1].selfId, 90);
for (const id of Crystals.catalog()) if (![90, 166, 86].includes(id)) board.remove(id);
board.remove(86); board.remove(166);
const deps = { board, spots: [], timestamp, npcOffersFor: () => [],
    routeRows: Array.from({ length: require('../src/GameServer/Bot/Economy/EconomicTrip').towns.length },
        () => [true, 0, 0]), workshop: { known: true, recipeId: 0, incomePerHour: 0 } };
const crystalPaths = context => (context.projection.nodes.find(row => row.key === 'item:1458')?.paths || [])
    .filter(row => row.kind === 'crystallize');
const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
assert.deepEqual(state, before);
Economy.reset();
assert.deepEqual(crystalPaths(Economy.forState(unskilled, deps)), [],
    'a bot without Crystallize gets no crystallize path, at an NPC or anywhere');
{
    // Crystallize for sale: a crafter (Create Item) breaks spare gear of its
    // own Crystallize grade and sells the crystals like a product, to other
    // owners' crystal buy ads and to the forecast demand (MarketDemand).
    const Catalog = invoke('GameServer/Items/ItemAcquisitionCatalog');
    const Templates = invoke('GameServer/Item/ItemTemplateIndex');
    const Demand = invoke('GameServer/Bot/Economy/MarketDemand');
    const CRYSTAL = invoke('GameServer/Items/C4EnchantRules').CRYSTAL_IDS;
    // The board as the server builds it: its group lists are the C-S sweep's walk.
    const ads = new BoardIndex({ groupOf: invoke('GameServer/Bot/Economy/MarketCounters').counterOf }), crystal = CRYSTAL.C;
    // A crafter as the world makes one: Create Item and a stored persona
    // (its read of the market demand).
    const persona = invoke('GameServer/Bot/AI/BotPersona').generate({ characterId: state.characterId });
    const crafterAt = level => ({ ...state, persona,
        stats: { ...withCrystallize(unskilled, level).stats, dwarvenCraftLevel: 1 } });
    const crafter = crafterAt(2);
    const bag = (rows, from = crafter) => ({ ...from, inventory: { ...from.inventory,
        ...Object.fromEntries(rows.map(([selfId, amount]) => [selfId, { selfId, amount, equipped: false }])) } });
    // Breakable spares of a grade: a held item source, ranked first alone.
    const sparesOf = (rank, from) => Crystals.catalog(rank).filter(id => Catalog.hasSource(id))
        .map(id => Crystals.choices(bag([[id, 1]], from), () => null, 0, rank)[0]).filter(Boolean);
    const spares = sparesOf('c', crafter);
    const small = spares.filter(row => row.net >= 30).sort((a, b) => a.net - b.net || a.selfId - b.selfId)[0];
    const weapon = spares.filter(row => String(Templates.find(Data.items, row.selfId)?.template?.kind).startsWith('Weapon'))
        .sort((a, b) => b.net - a.net || a.selfId - b.selfId)[0];
    assert(small && weapon && weapon.net > 6 * small.net, 'the fixture has a small spare and a big spare weapon');
    const adDeps = { ...deps, board: ads };
    const ad = (ownerId, selfId, price, count = 30) => ads.put({ id: ownerId, ownerId, storeType: 3, kind: 'shop', town: 'Giran',
        lines: [{ lineId: ownerId, selfId, count, enchant: 0, price }] });
    const resale = (context, id = crystal) => context.projection.nodes.find(row => row.key === `resale:${id}`);
    const decide = from => { Economy.reset(); return Economy.forState(from, adDeps); };
    // Two Giran deals of an item: its trade flow, the forecast's evidence.
    const traded = (id, units) => { Demand.deal(id, units, 'Giran', timestamp); Demand.deal(id, units, 'Giran', timestamp); };
    const both = bag([[small.selfId, 1], [weapon.selfId, 1]]);
    const quiet = decide(both);
    // A stationed crafter with the same skill and spares never roots the sale.
    const stationed = decide({ ...both, stats: { ...both.stats, craftStationId: 'fixed' } });
    assert.equal(resale(quiet), undefined, 'no crystal buy ad, no forecast: the spare gear is not broken for sale');
    ad(both.characterId, crystal, 9000);
    assert.equal(resale(decide(both)), undefined, 'the bot does not fill its own buy ad');
    ad(992001, crystal, 9000);
    assert(Sections.marketCrossed(ads, quiet.statsPacket.wishSections.marketWatch, both.characterId),
        'a new crystal buy ad wakes the bot that holds spare gear of its grade');
    assert(!Sections.marketCrossed(ads, stationed.statsPacket.wishSections.marketWatch, both.characterId),
        'the bot that may not root the crystal sale does not watch the crystal');
    const filled = decide(both);
    assert(resale(filled), 'another owner\'s crystal buy ad makes the crystallize-for-sale root');
    const leaf = filled.network.activity;
    assert.equal(leaf?.rootKey, `resale:${crystal}`, 'filling the ad is the chosen step');
    assert.equal(leaf.improvement.kind, 'crystallize', 'the existing crystallize command executes it');
    assert.equal(leaf.improvement.items.length, 1, 'one spare type, one command');
    const broken = leaf.improvement.items[0].selfId;
    // The held decision keeps the piece out of a town sale until it is broken.
    const Reservations = invoke('GameServer/Bot/Economy/CraftInputReservations');
    // The decision's claims travel with its stats packet (stats.heldClaims,
    // CraftInputReservations' one reader).
    const published = { ...both, stats: { ...both.stats, ...filled.statsPacket } };
    assert.equal(Reservations.reservedAmounts(published)[broken], 1,
        'the piece chosen for the crystals is reserved from sale');
    assert.equal(Economy.forState(published, adDeps).network.activity?.rootKey, `resale:${crystal}`, 'the decision is held');
    // Of two spare types of the grade, the one whose crystals cost least by
    // the bot's own price of the gear (the held item node's price the solver
    // charges) is broken, even when the other covers the ad with fewer
    // crystals left over; the other stays free.
    const perCrystal = row => filled.price(row.selfId) / row.net;
    const cheapest = spares.reduce((best, row) => perCrystal(row) < perCrystal(best) ? row : best);
    assert(cheapest.net > small.net && perCrystal(cheapest) < perCrystal(small),
        'the fixture has a spare with cheaper crystals beside the small one');
    const pair = bag([[small.selfId, 1], [cheapest.selfId, 1]]);
    const picked = decide(pair);
    assert.deepEqual(picked.network.activity?.improvement?.items, [{ selfId: cheapest.selfId, amount: 1 }],
        'the spare with the cheapest crystals is broken');
    const pickedState = { ...pair, stats: { ...pair.stats, ...picked.statsPacket } };
    assert.equal(Reservations.reservedAmounts(pickedState)[cheapest.selfId], 1, 'fixture: the broken spare is reserved');
    assert(!Reservations.reservedAmounts(pickedState)[small.selfId], 'the other spare stays free');
    // Only the bot's own skill of the grade breaks gear for an ad.
    assert.equal(resale(decide(bag([[small.selfId, 1], [weapon.selfId, 1]], { ...crafter, stats: { ...unskilled.stats,
        dwarvenCraftLevel: 1 } }))), undefined, 'without Crystallize the spare gear is not broken for the ad');
    assert.equal(resale(decide(bag([[small.selfId, 1], [weapon.selfId, 1]], crafterAt(1)))), undefined,
        'a D-level Crystallize cannot break C gear');
    // A bot holding the crystal already sells that instead.
    assert.equal(resale(decide(bag([[small.selfId, 1], [crystal, 30]]))), undefined,
        'a held crystal fills the ad, no gear is broken');
    // The gear is charged at its exit value: a buyer paying more for the
    // piece itself than its crystals bring keeps it whole.
    ad(992002, small.selfId, 2000000000, 1);
    const kept = decide(bag([[small.selfId, 1]]));
    assert(resale(kept), 'the crystal ad still offers the root');
    assert.notEqual(kept.network.activity?.rootKey, `resale:${crystal}`, 'a dearer exit for the gear wins over its crystals');
    ads.remove(992002);
    // Leftover crystals count nothing: a small ad never breaks a big weapon.
    ads.remove(992001);
    ad(992001, crystal, 9000, 6);
    const whole = decide(bag([[weapon.selfId, 1]]));
    assert.notEqual(whole.network.activity?.rootKey, `resale:${crystal}`, 'six crystals do not pay for a weapon of many more');
    assert.deepEqual(both.inventory[weapon.selfId], { selfId: weapon.selfId, amount: 1, equipped: false });
    // A buyer's line takes the pieces whose crystals it takes from me
    // (PriceDecision.bidLots): its count less a cheaper ask and the crystals
    // already held, in whole pieces, up to the spares.
    ads.remove(992001);
    ad(992001, crystal, 9000, 3 * small.net + 2);
    ads.put({ id: 992003, ownerId: 992003, storeType: 1, kind: 'shop', town: 'Giran',
        lines: [{ lineId: 992003, selfId: crystal, count: 1, enchant: 0, price: 8000 }] });
    assert.equal(resale(decide(bag([[small.selfId, 4], [crystal, 2]])))?.object.amount, 2 * small.net,
        'the line takes 3 pieces\' crystals less 3 units: two pieces are broken for it');
    ads.remove(992003);
    ads.remove(992001); ads.remove(both.characterId);
    // No buy ad at all: the forecast demand of the crystal is its exit.
    traded(crystal, 40);
    const forecast = decide(bag([[small.selfId, 1]]));
    assert(resale(forecast), 'a forecast exit with no buy ad makes the crystallize-for-sale root');
    assert.equal(resale(forecast).object.kind, 'resale');
    // Crystals already held cover the forecast: no gear is broken for it.
    assert.equal(resale(decide(bag([[small.selfId, 1], [crystal, 10000]]))), undefined,
        'held crystals that cover the forecast leave the gear whole');
    // Any grade the skill reaches: B gear needs Crystallize 3.
    const bSpare = sparesOf('b', crafterAt(3)).sort((a, b) => a.net - b.net || a.selfId - b.selfId)[0];
    assert(bSpare, 'the fixture has a B spare');
    traded(CRYSTAL.B, 40);
    assert(resale(decide(bag([[bSpare.selfId, 1]], crafterAt(3))), CRYSTAL.B),
        'Crystallize 3 breaks B gear for its crystals\' forecast');
    assert.equal(resale(decide(bag([[bSpare.selfId, 1]], crafterAt(2))), CRYSTAL.B), undefined,
        'Crystallize 2 cannot break B gear');
    // An empty bag: the crafter buys NPC gear and breaks it for a D
    // crystal buy ad that pays more than the gear's landed cost per crystal
    // (BotCrystallization.choices, the input ranker of the own-need node
    // too); an ad that pays less roots nothing.
    {
        const empty = { ...crafter, inventory: { ...crafter.inventory } };
        delete empty.inventory[CRYSTAL.D];
        const emptyKit = () => Profile.profileFor(empty, timestamp);
        const quote = { price: 1000, tripFees: 0, tripHours: 0, town: 'Giran', sourceType: 'npc', availableUnits: 1000000 };
        // A D piece the bot would not wear: the owner keeps worn upgrades out.
        const gear = Crystals.catalog('d').find(id => Crystals.choices(empty, other => other === id ? quote : null,
            0, 'd', null, emptyKit)[0]?.selfId === id);
        assert(gear, 'the fixture has a D piece the bot may break');
        const net = Crystals.reward(Templates.find(Data.items, gear)).net;
        const sellAt = (perCrystal, from = empty) => {
            Economy.reset();
            return Economy.forState(from, { ...adDeps, npcOffersFor: id => id === gear
                ? [{ selfId: gear, price: perCrystal * net, count: Infinity, town: 'Giran', sourceType: 'npc' }] : [] });
        };
        ad(992020, CRYSTAL.D, 5000, 2 * net);
        const cheap = sellAt(100);
        assert.equal(cheap.network.activity?.rootKey, `resale:${CRYSTAL.D}`,
            'crystals that sell above the gear\'s landed cost root the sale with an empty bag');
        assert.equal(cheap.network.activity?.itemId, gear, 'the first step buys the NPC gear to break');
        assert.notEqual(sellAt(50000).network.activity?.rootKey, `resale:${CRYSTAL.D}`,
            'crystals that sell below the gear\'s landed cost root nothing');
        // A held spare whose crystals cost more by the bot's own price than
        // the NPC gear's landed cost does not hide that route: the root
        // breaks the bought gear, the spare stays whole.
        const netOf = id => Crystals.reward(Templates.find(Data.items, id))?.net || 0;
        const dear = Crystals.catalog('d').find(id => id !== gear
            && Crystals.choices(bag([[id, 1]], empty), () => null, 0, 'd')[0]?.selfId === id && cheap.price(id) / netOf(id) > 200);
        assert(dear, 'the fixture has a D spare dearer per crystal than the NPC gear');
        const holding = sellAt(100, bag([[dear, 1]], empty));
        assert.equal(resale(holding, CRYSTAL.D)?.paths[0].improvement.items[0].selfId, gear,
            'the cheaper NPC gear is the input, not the dear held spare');
        ads.remove(992020);
    }
    // A D producer that is neither a luxury nor a crystal supply bot (level
    // 25): with a D crystal ad its sale root's sweep reads Giran's NPC for
    // the whole D catalogue, yet its own D gear, the piece the root breaks
    // included, keeps the quote the same bot without Crystallize (no sweep)
    // reads: a cheaper board ask, not the NPC.
    {
        const base = crafterAt(1), young = { ...base, level: 25, inventory: { ...base.inventory },
            stats: { ...base.stats, exp: Data.experience[24] } };
        delete young.inventory[CRYSTAL.D];
        const dIds = Crystals.catalog('d');
        ads.put({ id: 992030, ownerId: 992030, storeType: 1, kind: 'shop', town: 'Giran',
            lines: dIds.map((selfId, at) => ({ lineId: 993000 + at, selfId, count: 5, enchant: 0, price: 50000 })) });
        const npc = new Set(dIds);
        const build = from => { Economy.reset(); return Economy.forState(from, { ...adDeps, npcOffersFor: id => npc.has(Number(id))
            ? [{ selfId: Number(id), price: 100000, count: Infinity, town: 'Giran', sourceType: 'npc' }] : [] }); };
        const buyOf = (context, key) => context.projection.nodes.find(row => row.key === key)?.paths?.find(path => path.kind === 'buy');
        const gearKeys = context => context.projection.nodes.map(row => row.key)
            .filter(key => /^item:\d+$/.test(key) && npc.has(Number(key.slice(5))));
        ad(992021, CRYSTAL.D, 5000, 1000);
        const without = build({ ...young, stats: { ...young.stats, coldCombat: unskilled.stats.coldCombat } });
        const swept = build(young);
        assert(resale(swept, CRYSTAL.D), 'the D crystal ad roots the sale: the sweep ran');
        const shared = gearKeys(without).filter(key => gearKeys(swept).includes(key));
        assert(shared.length, 'the fixture builds an own D gear node in both decisions');
        for (const key of shared) {
            const [old, now] = [buyOf(without, key), buyOf(swept, key)];
            assert.deepEqual([now?.price, now?.town, now?.sourceType], [old?.price, old?.town, old?.sourceType],
                `${key}: the crystal sweep never reprices the bot's own gear`);
        }
        ads.remove(992021); ads.remove(992030);
    }
    // A luxury bot (an adventurer of level 40-51) prices its own gear by the
    // one rule of every bot (R1): a D weapon a bot line sells in Dion at a
    // quarter of Giran's NPC price is quoted at that line, not at the NPC.
    {
        const lux = { ...unskilled, level: 45, stats: { ...unskilled.stats, exp: Data.experience[44] } };
        const dIds = Crystals.catalog('d'), npc = new Set(dIds);
        const lines = new BoardIndex();
        lines.put({ id: 992040, ownerId: 992040, storeType: 1, kind: 'shop', town: 'Dion',
            lines: dIds.map((selfId, at) => ({ lineId: 994000 + at, selfId, count: 5, enchant: 0, price: 25000 })) });
        Economy.reset();
        const context = Economy.forState(lux, { ...deps, board: lines, npcOffersFor: id => npc.has(Number(id))
            ? [{ selfId: Number(id), price: 100000, count: Infinity, town: 'Giran', sourceType: 'npc' }] : [] });
        const weapons = context.projection.nodes.filter(row => /^item:\d+$/.test(row.key) && npc.has(Number(row.key.slice(5)))
            && String(Templates.find(Data.items, Number(row.key.slice(5)))?.template?.kind).startsWith('Weapon'));
        assert(weapons.length, 'the fixture builds a D weapon node for the luxury bot');
        for (const node of weapons) {
            const buy = node.paths.find(path => path.kind === 'buy');
            assert.deepEqual([buy?.town, buy?.sourceType === 'npc'], ['Dion', false],
                `${node.key}: the luxury bot buys its D weapon at the cheaper bot line`);
        }
    }
    // C crystals from board gear (no NPC sells C-S gear): a crafter with
    // Crystallize 2 and no C piece buys a board C piece whose crystals a C
    // crystal buy ad takes above the piece's ask, and breaks it; an ask above
    // the crystals' bid roots nothing; no board C gear, no C crystal sale.
    {
        const empty = { ...crafter, inventory: { ...crafter.inventory } };
        const emptyKit = () => Profile.profileFor(empty, timestamp);
        const quote = { price: 1000, tripFees: 0, tripHours: 0, town: 'Giran', sourceType: 'board', availableUnits: 1 };
        // A C piece the bot would not wear: the owner keeps worn upgrades out.
        const piece = Crystals.catalog('c').find(id => Crystals.choices(empty, other => other === id ? quote : null,
            0, 'c', null, emptyKit)[0]?.selfId === id);
        assert(piece, 'the fixture has a C piece the bot may break');
        const net = Crystals.reward(Templates.find(Data.items, piece)).net, bid = 5000;
        const seller = ask => ads.put({ id: 992060, ownerId: 992060, storeType: 1, kind: 'shop', town: 'Giran',
            lines: [{ lineId: 992060, selfId: piece, count: 1, enchant: 0, price: ask }] });
        ad(992050, crystal, bid, 2 * net);
        seller(net * 200);
        const cheap = decide(empty);
        assert.equal(resale(cheap)?.paths[0]?.improvement?.items?.[0]?.selfId, piece,
            'the board C piece is the input of the C crystal sale');
        assert.equal(cheap.network.activity?.rootKey, `resale:${crystal}`, 'crystals that sell above the piece\'s ask root the sale');
        assert.equal(cheap.network.activity?.itemId, piece, 'the first step buys the board piece to break');
        seller(2 * net * bid);
        assert.notEqual(decide(empty).network.activity?.rootKey, `resale:${crystal}`,
            'an ask above the crystals\' bid roots nothing');
        ads.remove(992060);
        assert.equal(resale(decide(empty)), undefined, 'no board C gear: no C crystal sale root');
        ads.remove(992050);
    }
    Demand.reset();
}
console.log(`PASS crystallization market sources: own skill only, live quotes, trips, finite stock, protected gear and context invalidation ${isMainThread ? 'main' : 'worker'}`);
if (isMainThread) {
    const worker = new Worker(__filename);
    worker.on('error', error => { console.error(error); process.exitCode = 1; });
    worker.on('exit', code => { if (code) process.exitCode = code; });
} else parentPort.postMessage('verified');
