'use strict';
const assert = require('node:assert/strict');
const { Worker, isMainThread, parentPort } = require('node:worker_threads');
require('./helpers/databaseIsolation');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Progression = invoke('GameServer/Bot/AI/PersonalGearProgression');
const Gear = invoke('GameServer/Bot/AI/BotGear');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Providers = invoke('GameServer/Bot/Economy/WishProviders');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const Reservations = invoke('GameServer/Bot/Economy/CraftInputReservations');
const Listing = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
const BotRoute = invoke('GameServer/Bot/Population/BotRoute');
const { beginHuntingTrip } = invoke('GameServer/Bot/Population/HuntingTravel');
const ColdEconomyDecision = invoke('GameServer/Bot/Population/ColdEconomyDecision');
const { WishNetwork, createSolver } = require('../src/GameServer/Bot/Economy/WishNetwork');
const Trip = require('../src/GameServer/Bot/Economy/EconomicTrip');
const SavedStats = require('../src/GameServer/Bot/SavedStats');
const timestamp = 1791335800000;
function inventoryFor(items) {
    const inventory = {};
    for (const entry of items) {
        const old = inventory[entry.selfId];
        const equippedSlots = [...(old?.equippedSlots || []), entry.slot];
        inventory[entry.selfId] = { ...entry, amount: Number(old?.amount || 0) + 1,
            equipped: true, equippedCount: equippedSlots.length, equippedSlots };
    }
    return inventory;
}
function bot(classId, level, inventory = {}) {
    const state = { characterId: 990120, level, adena: 1000000, phase: 'cold', activity: 'hunting',
        currentRegion: 'Giran', loc: { locX: 81100, locY: 148000, locZ: -3466 }, stats: { classId }, inventory };
    state.stats.coldCombat = Profile.legacySnapshot(state, Profile.skillRecordsFromTree(classId, level), timestamp);
    return state;
}
// A reward spot of the bots' spot table at `center`, for a level range.
function rewardSpot(id, minLevel, maxLevel, center) {
    const npcs = require('../data/Bots/spot-reward-npcs.json').rows.find(row => row[0] === id)[1];
    return { id, name: id, minLevel, maxLevel, avgLevel: minLevel, capacity: 8, density: 6, tags: [], center,
        npcEntries: npcs.map(([selfId, count]) => ({ selfId, count,
            level: Data.npcs.find(npc => npc.selfId === selfId).template.level })),
        npcSelfIds: npcs.map(([selfId]) => selfId) };
}
// Held inputs a goal keeps from sale: the network's split of held stock
// (heldClaims), published with the decision's stats packet (stats.heldClaims)
// and read by CraftInputReservations. Runs before verify(), which stops at
// its own red cases.
function verifyHeldInputs() {
    const kit = inventoryFor(Gear.planFor({ classId: 0, level: 10 }).items);
    Economy.reset();
    const ctx = Economy.forState(bot(0, 10, kit), { spots: [], board: new BoardIndex(), timestamp, npcOffersFor: () => [],
        routeRows: Array.from({ length: Trip.towns.length }, () => [true, 0, 0]) });
    const sell = state => Listing.evaluate(state, { board: new BoardIndex(), now: timestamp, slots: 0,
        keptAmounts: {}, economy: ctx });
    // The state after the decision's packet (BotLifeState merges it), saved
    // and loaded as the bot's mind (SavedStats) and sent across the threads.
    const ipc = (network, state) => {
        const { body, mind } = SavedStats.split({ ...state.stats,
            heldClaims: Reservations.heldCraftRows(state, network.heldClaims, Infinity) });
        return structuredClone({ ...state, stats: SavedStats.merge(JSON.stringify(body), JSON.stringify(mind)) });
    };
    const material = { selfId: 1864, amount: 10, kind: 'Other.Material', basePrice: 100 };
    const withLogs = amount => bot(0, 10, { ...kit, 1864: { ...material, amount } });
    const producer = { key: 'resale:101', need: 'power', object: { itemId: 101, amount: 1, kind: 'resale' },
        progressionFunding: true, valueHours: 10, paths: [{ kind: 'craft', activity: 'crafting',
            quoted: true, costHours: .1, grossRequirements: [{ key: 'item:1864', amount: 8 }] }] };
    const wood = { key: 'item:1864', object: 1864, price: 10, paths: [{ kind: 'buy', activity: 'shopping', price: 10 }] };
    const logsBuild = owned => new WishNetwork().build({ actorKey: 'holds', inputKey: `holds:${owned}`, remembered: false,
        nodes: [producer, wood], roots: [producer.key], wallet: 1000, hourAdena: 1000,
        stockFor: id => ({ owned: id === 1864 ? owned : 0, incoming: 0 }) });
    // Of 10 held logs the craft keeps the 8 it uses.
    const spare = ipc(logsBuild(10), withLogs(10));
    assert.equal(Reservations.reservedAmounts(spare)[1864], 8,
        'active profitable craft protects only its actual inputs, across a save and the worker IPC');
    assert.equal(sell(spare).npc.find(row => row.selfId === 1864)?.count, 2,
        'the market sells only the unused ingredient surplus');
    // The claim is the need, the bag caps it at the read: built holding 1 of
    // 8, the decision keeps 6 once the bot holds 6.
    const early = ipc(logsBuild(1), withLogs(1));
    const grown = { ...early, inventory: withLogs(6).inventory };
    assert.equal(Reservations.reservedAmounts(grown)[1864], 6, 'logs gathered after the build stay with the craft');
    assert(!sell(grown).npc.some(row => row.selfId === 1864),
        'the decision made at 1 log keeps all 6 out of the town sale');
    // A goal out of focus keeps its held inputs (bot 2003035 sold 8 x 1894 at
    // the town visit where its focus moved to shots): the gloves craft holds
    // its 8 parts while the shot stock, a higher priority, takes the focus.
    const gloves = { key: 'power:2453', need: 'power', object: { itemId: 2453, slot: 10 }, progressionPriority: 2,
        valueHours: 100, price: 24000, paths: [{ kind: 'craft', activity: 'crafting', quoted: true, costHours: .1,
            grossRequirements: [{ key: 'item:1894', amount: 8 }], requirements: [{ key: 'item:1894', amount: 8 }] }] };
    const parts = { key: 'item:1894', object: 1894, price: 3000, paths: [{ kind: 'npc', activity: 'shopping',
        itemId: 1894, price: 3000, costHours: .01, quoted: true }] };
    const shotStock = { key: 'stock:shots', need: 'power', object: { itemId: 1835, amount: 100, kind: 'shots' },
        progressionPriority: 3, valueHours: 10, price: 1000, paths: [{ requirements: [{ key: 'item:1835', amount: 100 }] }] };
    const shotItem = { key: 'item:1835', object: 1835, price: 10, paths: [{ kind: 'npc', activity: 'shopping',
        itemId: 1835, price: 10, costHours: .01, quoted: true }] };
    const outOfFocus = new WishNetwork().build({ actorKey: 'gloves', inputKey: 'gloves', remembered: false,
        nodes: [gloves, parts, shotStock, shotItem], roots: [shotStock.key, gloves.key], wallet: 5000, hourAdena: 1000,
        stockFor: id => ({ owned: id === 1894 ? 8 : 0, incoming: 0 }) });
    assert.equal(outOfFocus.focus?.[0], shotStock.key, 'the shot stock holds the focus');
    const holder = bot(0, 10, { ...kit, 1894: { selfId: 1894, amount: 8, kind: 'Other.Material' },
        1864: { ...material, amount: 2 } });
    const holderSale = sell(ipc(outOfFocus, holder));
    assert(!holderSale.candidates.some(row => row.selfId === 1894) && !holderSale.npc.some(row => row.selfId === 1894),
        'the live gloves goal keeps all 8 parts out of the town sale');
    assert.equal(holderSale.npc.find(row => row.selfId === 1864)?.count, 2,
        'an item no live goal claims goes through the sale decision as before');
    // The decision keeps every claimed item in the bag (the card cuts its
    // rows at 8, the stats packet does not): the focused craft's cheap logs
    // and another live goal's 8 dearer parts.
    const logCraft = { key: 'power:2454', need: 'power', object: { itemId: 2454, slot: 10 }, progressionPriority: 3,
        valueHours: 100, price: 24000, paths: [{ kind: 'craft', activity: 'crafting', quoted: true, costHours: .1,
            grossRequirements: [{ key: 'item:1864', amount: 8 }], requirements: [{ key: 'item:1864', amount: 8 }] }] };
    const partIds = [1865, 1866, 1867, 1868, 1869, 1870, 1871, 1872];
    const dearCraft = { key: 'power:2455', need: 'power', object: { itemId: 2455, slot: 9 }, progressionPriority: 2,
        valueHours: 100, price: 48000, paths: [{ kind: 'craft', activity: 'crafting', quoted: true, costHours: .1,
            grossRequirements: partIds.map(id => ({ key: `item:${id}`, amount: 1 })),
            requirements: partIds.map(id => ({ key: `item:${id}`, amount: 1 })) }] };
    const partNodes = partIds.map(id => ({ key: `item:${id}`, object: id, price: 3000, paths: [{ kind: 'npc',
        activity: 'shopping', itemId: id, price: 3000, costHours: .01, quoted: true }] }));
    const crowded = new WishNetwork().build({ actorKey: 'crowded', inputKey: 'crowded', remembered: false,
        nodes: [logCraft, dearCraft, wood, ...partNodes], roots: [logCraft.key, dearCraft.key], wallet: 5000, hourAdena: 1000,
        stockFor: id => ({ owned: id === 1864 ? 8 : partIds.includes(id) ? 1 : 0, incoming: 0 }) });
    assert.equal(crowded.activity?.rootKey, logCraft.key, 'the log craft holds the activity');
    const crowdedBag = bot(0, 10, { ...kit, 1864: { ...material, amount: 8 },
        ...Object.fromEntries(partIds.map(id => [id, { selfId: id, amount: 1, kind: 'Other.Material', basePrice: 3000 }])) });
    const crowdedHeld = Reservations.reservedAmounts(ipc(crowded, crowdedBag));
    assert.equal(crowdedHeld[1864], 8, 'the focused craft keeps its logs');
    assert(partIds.every(id => crowdedHeld[id] === 1), 'the other live goal keeps its 8 parts');
    assert(!sell(ipc(crowded, crowdedBag)).npc.some(row => [1864, ...partIds].includes(row.selfId)),
        'no claimed item goes to the town sale');
}
// A committed farm line (its resale root the focus or a preempted goal,
// goalhold2) stays a root beside the best ready one: neither the 8-line
// pre-cut nor the one root per build decides the bot's hold, nor the first
// unit it farmed (the line sizes past the units held). Runs before verify(),
// which stops at its own red cases.
function verifyFarmHold() {
    const farmer = bot(1, 22, inventoryFor(Gear.planFor({ classId: 1, level: 20 }).items));
    const farmSpot = rewardSpot('28_-33', 19, 23, { locX: 82000, locY: 149000, locZ: -3466 });
    const potion = 6035, thread = 1868, board = new BoardIndex();
    Economy.reset();
    const context = Economy.forState(farmer, { board, timestamp, spots: [], npcOffersFor: () => [],
        routeRows: Array.from({ length: Trip.towns.length }, () => [true, 0, 0]) });
    board.put({ id: 200, ownerId: 990121, storeType: 3, kind: 'buy_ad', town: 'Giran',
        lines: [{ lineId: 200, selfId: potion, count: 2, enchant: 0, price: 200000 }] });
    board.put({ id: 299, ownerId: 990199, storeType: 3, kind: 'buy_ad', town: 'Giran',
        lines: [{ lineId: 299, selfId: thread, count: 50, enchant: 0, price: context.buyback(thread) + 10000 }] });
    const farmRoots = build => build.nodes.filter(row => build.roots.includes(row.key) && row.paths[0]?.kind === 'farm_sale');
    const build = (state, committedKeys) => Providers.build(state, { ...context, committedKeys }, { spots: [farmSpot] });
    const best = farmRoots(build(farmer, [])).map(row => row.key);
    assert.equal(best.length, 1, 'fixture: one farm root of two ready lines');
    const other = best[0] === `resale:${thread}` ? `resale:${potion}` : `resale:${thread}`;
    assert.deepEqual(farmRoots(build(farmer, [other])).map(row => row.key).sort(), [best[0], other].sort(),
        'a committed farm line stays a root beside the best ready one');
    // One potion farmed of the line's 2: the committed line farms the other.
    const holder = { ...farmer, inventory: { ...farmer.inventory, [potion]: { selfId: potion, amount: 1 } } };
    assert(!farmRoots(build(holder, [])).some(row => row.key === `resale:${potion}`),
        'fixture: a held item is no new farm line');
    const held = farmRoots(build(holder, [`resale:${potion}`])).find(row => row.key === `resale:${potion}`);
    assert(held, 'a committed farm line stays a root once its first unit is in the bag');
    assert.equal(held.object.amount, 1, 'it farms only the units the line takes past the ones held');
    // One count of old units for every line: units on the bot's own sell
    // line size the line alike committed or not, so a commitment never
    // flips the root away and back at the next build.
    board.put({ id: 300, ownerId: farmer.characterId, storeType: 1, kind: 'shop', town: 'Giran', custodyPolicy: 0,
        lines: [{ lineId: 300, selfId: potion, count: 1, enchant: 0, price: 400000 }] });
    board.remove(299);
    const lineOf = keys => farmRoots(build(farmer, keys)).find(row => row.key === `resale:${potion}`)?.object.amount;
    assert.equal(lineOf([`resale:${potion}`]), 1, 'a committed line counts the units on its own sell line');
    assert.equal(lineOf([]), 1, 'an uncommitted line counts them alike');
}
// A gear bid is no farm goal (supply-driven market, T76): a line for
// Bronze Breastplate (26, a drop of the farm spot) paying more per kill
// than Thread's, within a horizon long enough to farm it, leaves Thread
// the farm root.
function verifyGearBidFarm() {
    const farmer = bot(1, 22, inventoryFor(Gear.planFor({ classId: 1, level: 20 }).items));
    const farmSpot = rewardSpot('28_-33', 19, 23, { locX: 82000, locY: 149000, locZ: -3466 });
    const thread = 1868, gear = 26, board = new BoardIndex();
    Economy.reset();
    const context = Economy.forState(farmer, { board, timestamp, spots: [], npcOffersFor: () => [],
        routeRows: Array.from({ length: Trip.towns.length }, () => [true, 0, 0]) });
    board.put({ id: 299, ownerId: 990199, storeType: 3, kind: 'buy_ad', town: 'Giran',
        lines: [{ lineId: 299, selfId: thread, count: 50, enchant: 0, price: context.buyback(thread) + 10000 }] });
    board.put({ id: 500, ownerId: 990500, storeType: 3, kind: 'buy_ad', town: 'Giran',
        lines: [{ lineId: 500, selfId: gear, count: 1, enchant: 0, price: context.buyback(gear) + 10000000 }] });
    const roots = Providers.build(farmer, { ...context, horizonHours: 1e6 }, { spots: [farmSpot] });
    assert.deepEqual(roots.nodes.filter(row => roots.roots.includes(row.key) && row.paths[0]?.kind === 'farm_sale')
        .map(row => row.key), [`resale:${thread}`], 'a gear bid is no farm root; the material line is');
}
function verify() {
    const starter = inventoryFor(Data.newbieItems.find(row => row.classId === 0).items.filter(row => row.equipped)
        .map(row => ({ ...row, slot: Data.items.find(item => item.selfId === row.selfId).etc.slot })));
    const first = bot(0, 1, starter);
    assert(Progression.assess(first).required, 'starter clothes are never a completed working kit');
    assert(Progression.assess(first).gaps.get(7), 'starter weapon still needs replacement');
    for (const classId of [0, 10, 18, 25, 38, 49, 50, 53, 54, 56]) {
        const state = bot(classId, 10, inventoryFor(Gear.planFor({ classId, level: 10 }).items));
        assert.equal(Progression.assess(state).required, false, `working NG kit closes class ${classId}`);
        assert.equal(Progression.assess({ ...state, level: 19 }).required, false,
            'a completed working NG kit stays complete until the D milestone');
        assert(Progression.assess({ ...state, level: 20 }).required, 'NG kit opens D milestone at 20');
        const d = bot(classId, 20, inventoryFor(Gear.planFor({ classId, level: 20 }).items));
        assert.equal(Progression.assess(d).required, false, `full usable D kit closes class ${classId}`);
        assert.equal(Progression.assess({ ...d, stats: { ...d.stats, clanId: 1 } }).required, false,
            `full usable D kit also closes clan member class ${classId}`);
    }
    for (const membership of [{ clanId: 1 }, { stats: { ...first.stats, clanId: 1 } }]) {
        const member = { ...first, ...membership };
        assert.deepEqual([...Progression.assess(member).gaps], [...Progression.assess(first).gaps],
            'clan membership does not remove the working kit milestone');
        assert.equal(Progression.personal(member), true, 'without a warehouse membership preserves personal progression');
    }
    assert.equal(Progression.assess({ ...first, stats: { ...first.stats, craftStationId: 1 } }).required, false,
        'stationary craft services remain outside adventurer equipment progression');
    const richArtisan = bot(56, 31, inventoryFor([
        { selfId: 2370, slot: 7 }, { selfId: 102, slot: 8 }, { selfId: 26, slot: 10 },
        { selfId: 30, slot: 11 }, { selfId: 44, slot: 6 }, { selfId: 37, slot: 12 },
        { selfId: 605, slot: 9 }, { selfId: 878, slot: 4 }
    ]));
    richArtisan.adena = 35000000;
    richArtisan.stats.clanId = 1;
    const artisanGaps = Progression.assess(richArtisan).gaps;
    assert.equal(artisanGaps.size, 11, 'rich clan Artisan has every NG/empty slot debt except its D gloves');
    assert([1, 2, 3, 5].every(slot => artisanGaps.get(slot)?.priority === 2),
        'both earrings, necklace and missing second ring precede existing-slot upgrades');

    const kit = inventoryFor(Gear.planFor({ classId: 0, level: 10 }).items);
    const ear = Object.values(kit).find(row => row.equippedSlots.includes(2));
    kit[ear.selfId] = { ...ear, amount: 1, equippedCount: 1, equippedSlots: [1], slot: 1 };
    const paired = bot(0, 10, kit);
    assert.deepEqual([...Progression.assess(paired).gaps.keys()], [2]);
    const board = new BoardIndex();
    board.put({ id: 1, ownerId: 990121, storeType: 1, kind: 'shop', town: 'Giran',
        lines: [{ lineId: 1, selfId: ear.selfId, count: 2, enchant: 0, price: 100 }] });
    Economy.reset();
    const ctx = Economy.forState(paired, { spots: [], board, timestamp, npcOffersFor: () => [],
        routeRows: Array.from({ length: require('../src/GameServer/Bot/Economy/EconomicTrip').towns.length },
            () => [true, 0, 0]) });
    assert(ctx.projection.roots.includes(`power:${ear.selfId}:2`), 'same-template second earring is an acquisition root');
    assert(!ctx.projection.roots.some(key => key.startsWith('level:')), 'XP goal waits for the working kit');
    const clanMember = { ...paired, stats: { ...paired.stats, clanId: 1 } };
    const clanCtx = Economy.forState(clanMember, { spots: [], board, timestamp, npcOffersFor: () => [],
        routeRows: Array.from({ length: require('../src/GameServer/Bot/Economy/EconomicTrip').towns.length },
            () => [true, 0, 0]) });
    assert(clanCtx.projection.roots.includes(`power:${ear.selfId}:2`),
        'a clan member with its own money still acquires an empty equipment slot');
    assert.equal(clanCtx.network.activity.rootKey, `power:${ear.selfId}:2`,
        'an affordable clan member kit piece precedes optional profit goals');
    const selected = Planner.preferredTarget(paired, { wishTargetId: ear.selfId, wishSlot: 2 });
    assert.equal(selected?.item.selfId, ear.selfId, 'native target planner accepts the second identical copy');
    const receipt = Planner.equipInventoryUpgrades(paired, { ...kit, [ear.selfId]: { ...kit[ear.selfId], amount: 2 } });
    assert(receipt[ear.selfId].equippedSlots.includes(2), 'native receipt equips both sides');
    assert.equal(Progression.assess({ ...paired, inventory: receipt }).required, false);

    const material = { selfId: 1864, amount: 10, kind: 'Other.Material', basePrice: 100 };
    const spare = bot(0, 10, { ...paired.inventory, 1864: material,
        1049: { selfId: 1049, amount: 2, name: 'Spellbook: Ice Bolt' } });
    const sale = Listing.evaluate(spare, { board: new BoardIndex(), now: timestamp, slots: 0,
        keptAmounts: {}, knowledgeEnabled: false });
    assert.equal(sale.warehouse.length, 0, 'surplus never becomes personal warehouse clutter');
    assert(sale.npc.some(row => row.selfId === 1864 && row.count === 10));
    assert(sale.npc.some(row => row.selfId === 1049 && row.count === 2));
    assert.equal(Disposition.warehouseCandidates(spare).length, 0);
    const clanSurplus = { ...spare, stats: { ...spare.stats, clanId: 1 } };
    assert.equal(Disposition.warehouseCandidates(clanSurplus).length, 0,
        'membership alone never hoards personal surplus');
    assert.equal(Disposition.isNpcOnlyItem(clanSurplus.inventory[1049], undefined, clanSurplus), true,
        'without a clan warehouse the ordinary personal book rule still applies');
    const amulet = Data.items.find(item => /^Amulet/.test(item.template?.name || '')
        && require('../src/GameServer/Items/ItemAcquisitionCatalog').hasSource(item.selfId));
    assert(amulet);
    const orcLoot = { ...spare, inventory: { [amulet.selfId]: { selfId: amulet.selfId, amount: 1 } } };
    assert.equal(Listing.classify(orcLoot, Disposition.saleCandidates(orcLoot, { keptAmounts: {} })[0]).action, 'npc');

    assert.equal(Hunt.netIncome({ adena: 1000, loot: 500, shots: 100, potions: 2 }, { shots: 10, potions: 100 }), 300);
    const sampled = Hunt.bestIncome([{ spotId: 'gross', adena: 1000, loot: 0, costs: 900, kills: 10, exp: 100, cycleMs: 60000 },
        { spotId: 'net', adena: 800, loot: 0, costs: 100, kills: 10, exp: 50, cycleMs: 60000 }]);
    assert.equal(sampled.spotId, 'net', 'shots and potions can reverse the preferred earning spot');
    const poorOrc = bot(44, 7, first.inventory);
    const Table = invoke('GameServer/Bot/AI/SpotValueTable');
    const nativeRankedIncome = Table.rankedIncome;
    // This fixture has no profitable charged camp; the alternative retains
    // its real NPC rewards and the native uncharged combat measurements.
    Table.rankedIncome = (...args) => args[4] === false ? nativeRankedIncome(...args) : [];
    const noShots = Hunt.huntIncome(poorOrc, timestamp);
    assert(noShots.perHour > 0 && noShots.useShots === false,
        'negative paid-shot margins fall back to a positive native uncharged hunt');
    const poorEconomy = Economy.basics(poorOrc, { timestamp });
    assert.equal(poorEconomy.stock('shots').ownedUsePerHour, 0,
        'the fallback disables charges at the existing native consumption boundary');
    assert.equal(invoke('GameServer/Inventory/ShotStock').usePolicy(poorOrc, { timestamp }).usePerHour, 0,
        'the native combat preparation also respects the uncharged fallback');
    let losingOrc = poorOrc;
    for (let at = 0; at < 3; at++) losingOrc = { ...losingOrc, stats: { ...losingOrc.stats,
        huntEfficiency: Hunt.record(losingOrc, { spotId: noShots.spotId, timestamp, cycleMs: 60000,
            adena: 100, costs: 1000, exp: 100, kills: 10 }) } };
    const retry = Hunt.huntIncome(losingOrc, timestamp);
    assert(retry.perHour > 0 && retry.useShots === false, 'an observed loss cannot lock out a profitable fallback');
    const uncharged = invoke('GameServer/Bot/Economy/SpotEconomics').create(losingOrc,
        { timestamp, moneyWeight: 1 })({ id: retry.spotId, density: 1 }, false);
    assert(uncharged.income > 0, 'charged observations are not reused for an uncharged earning route');
    Table.rankedIncome = nativeRankedIncome;
    const Route = invoke('GameServer/Bot/Economy/EquipmentIncomeRoute');
    const spots = ['poor', 'rich'].map((id, at) => ({ id, avgLevel: 10, minLevel: 10, maxLevel: 10,
        density: 10, tagsAuthoritative: true, tags: ['starter'], npcEntries: [],
        center: { locX: -80000 + at * 1000, locY: 250000, locZ: 0 } }));
    let earning = { ...paired, spotId: 'poor', loc: spots[0].center };
    for (let at = 0; at < 3; at++) for (const spot of spots) earning = { ...earning, stats: { ...earning.stats,
        huntEfficiency: Hunt.record(earning, { spotId: spot.id, timestamp, cycleMs: 60000,
            adena: spot.id === 'poor' ? 1000 : 800, costs: spot.id === 'poor' ? 900 : 100,
            loot: 0, exp: 100, kills: 10 }) } };
    assert.equal(Route.select(earning, { spots, timestamp, required: true }).spot.id, 'rich',
        'a suitable current spot does not pin the bot when another has better net profit');
    let weak = { ...earning, level: 25, stats: { ...earning.stats, huntEfficiency: [] } };
    for (let at = 0; at < 3; at++) weak = { ...weak, stats: { ...weak.stats,
        huntEfficiency: Hunt.record(weak, { spotId: 'rich', timestamp, cycleMs: 60000,
            adena: 800, costs: 100, loot: 0, exp: 10, kills: 10 }) } };
    assert.equal(Route.select(weak, { spots, timestamp, required: true }).spot.id, 'rich',
        'a kit goal can use easier safe ground when the normal earning band has no profitable spot');
    for (const clanLevel of [0, 1, 5]) for (const grade of ['none', 'd', 'c', 'b', 'a', 's']) {
        const member = { ...weak, clanId: clanLevel ? 1 : 0, clanLevel,
            stats: { ...weak.stats, clanId: clanLevel ? 1 : 0, wishFocus: ['power:200:14', 1, 1000000],
                equipmentPlan: { status: 'active', grade, strategy: 'market' } } };
        assert.equal(Route.economicHunt(member), true,
            `ordinary earning band is independent of clan level ${clanLevel} and target grade ${grade}`);
        assert.equal(Route.select(member, { spots, timestamp, required: true })?.spot.id, 'rich',
            `clan level ${clanLevel} and target grade ${grade} preserve the better net-income camp`);
        const tooLow = spots.map(spot => ({ ...spot, minLevel: 9, maxLevel: 9, avgLevel: 9 }));
        assert.equal(Route.select(member, { spots: tooLow, timestamp, required: true }), null,
            'economic hunts still reject a camp more than fifteen levels below the character');
    }
    for (const service of [{ stats: { ...weak.stats, craftStationId: 1 } },
        { activity: 'crafting', stats: { ...weak.stats, craftShop: {}, generatedIndex: 10000 } }]) {
        const stationary = { ...weak, ...service };
        assert.equal(Route.select(stationary, { spots, timestamp, required: true }), null,
            'stationary services do not enter ordinary farming');
    }
    const clanFunding = { ...earning, clanId: 1, clanLevel: 1,
        stats: { ...earning.stats, clanId: 1, wishFocus: ['power:200:14', 1, 1000000],
            equipmentPlan: { status: 'active', strategy: 'luxury_exchange',
                clanGoal: { clanId: 1, goalKey: 'member-equipment' } } } };
    assert.equal(invoke('GameServer/Bot/Population/SpotProfiles').findForState(clanFunding,
        { profiles: spots, occupancy: {}, timestamp })?.id, 'rich',
        'a clan-owned purchase plan without a hunting assignment still uses the best ordinary earning route');

    const item = { key: 'item:1', price: 1000, paths: [
        { kind: 'drop', activity: 'hunting', spotId: 'rare', costHours: 0, readyHours: 10 },
        { kind: 'npc', activity: 'shopping', itemId: 1, price: 1000, costHours: 0.01, quoted: true }] };
    const required = { key: 'power:1:7', need: 'power', object: { itemId: 1, slot: 7 }, progressionPriority: 3,
        valueHours: .1, price: 1000, paths: [{ requirements: [{ key: item.key, amount: 1 }] }] };
    const xp = { key: 'level:11', need: 'power', valueHours: 1000, price: 0,
        paths: [{ activity: 'hunting', kind: 'experience', costHours: .01 }] };
    const result = new WishNetwork().build({ actorKey: 'stage', inputKey: 'one', remembered: false,
        nodes: [item, required, xp], roots: [required.key, xp.key], wallet: 0, hourAdena: 1000,
        moneyPaths: [{ activity: 'hunting', kind: 'money', spotId: 'profit', incomePerHour: 1000 }] });
    assert.equal(result.focus[0], required.key, 'XP cannot outbid missing equipment');
    assert.equal(result.activity.spotId, 'profit', 'one hour earning cash beats a ten-hour rare drop');
    assert.equal(result.plans.get(item.key).kind, 'npc');
    assert.equal(result.gap.key, required.key, 'necessary kit stays funded below the ordinary return floor');
    const waitingPlan = invoke('GameServer/Bot/AI/GearPlanSelection').selectAcquisitionPlan(first,
        { status: 'active', strategy: 'direct_drop', next: { spotId: 'rare' } },
        { timestamp, preparedEconomy: { network: result } });
    assert.equal(waitingPlan.acquisitionPlan.next, null, 'cash farming is not replaced by an old direct-drop plan');
    const paid = new WishNetwork().build({ actorKey: 'paid', inputKey: 'paid', remembered: false,
        nodes: [item, required, xp], roots: [required.key, xp.key], wallet: 1000, hourAdena: 1000 });
    const Funding = require('../src/GameServer/Bot/Economy/PurchaseFunding');
    const packet = Funding.packetFor(paid, 1000, 0);
    assert.equal(Funding.spendable({ adena: 1000, stats: { money: packet } }, 0, { itemId: 1 }), 1000,
        'a funded mandatory purchase is payable through the native money packet');
    const ordinary = { ...required, key: 'optional', progressionPriority: 0 };
    const shared = createSolver({ nodes: [item, required, ordinary], wallet: 0, hourAdena: 1000 });
    assert.equal(shared.rootWish(required.key).plan.requirements[0].plan.kind, 'npc');
    assert.equal(shared.rootWish(ordinary.key).plan.requirements[0].plan.kind, 'drop',
        'completion-time choices do not contaminate the ordinary source memo');
    assert.equal(shared.rootWish(required.key).plan.requirements[0].plan.kind, 'npc');
    const producer = { key: 'resale:101', need: 'power', object: { itemId: 101, amount: 1, kind: 'resale' },
        progressionFunding: true, valueHours: 10, paths: [{ kind: 'craft', activity: 'crafting',
            quoted: true, costHours: .1, grossRequirements: [{ key: 'item:1864', amount: 8 }] }] };
    const wood = { key: 'item:1864', object: 1864, price: 10, paths: [{ kind: 'buy', activity: 'shopping', price: 10 }] };
    const produce = wallet => new WishNetwork().build({ actorKey: 'produce', inputKey: 'produce', remembered: false,
        nodes: [item, required, producer, wood], roots: [required.key, producer.key], wallet, hourAdena: 1000,
        stockFor: id => ({ owned: id === 1864 ? 8 : 0, incoming: 0 }) });
    assert.equal(produce(0).activity.rootKey, producer.key, 'profitable native craft can fund an unaffordable kit');
    const paidKit = produce(1000);
    assert.equal(paidKit.activity.rootKey, producer.key,
        'with money for a missing kit piece the earning craft stays active at the gear priority');
    assert(paidKit.queue.some(wish => wish.key === required.key && wish.funded),
        'the affordable kit piece stays funded beside the earning craft');
    const shots = { ...producer, key: 'resale:1835', object: { itemId: 1835, amount: 100, kind: 'resale' },
        progressionPriority: 3, paths: [{ ...producer.paths[0], grossRequirements: [{ key: 'item:1458', amount: 2 }] }] };
    const crystal = { key: 'item:1458', object: 1458, price: 10, paths: [{ kind: 'buy', activity: 'shopping', price: 10 }] };
    const beside = new WishNetwork().build({ actorKey: 'shots', inputKey: 'shots', remembered: false,
        nodes: [shots, crystal, producer, wood], roots: [shots.key, producer.key], wallet: 1000, hourAdena: 1000,
        stockFor: () => ({ owned: 0, incoming: 0 }) });
    assert(beside.queue.some(wish => wish.key === producer.key),
        'a gear craft for sale stays in the money queue beside an active shot root');
    // Any farmer, not only a spoiler, may leave its route to farm a drop a
    // buyer bids above NPC buy-back for, when the line pays more than the
    // farm hours cost (user 2026-10-24). A warrior at level 22; Magic Haste
    // Potion drops (never spoils) at spot 28_-33, which is not its spot.
    const farmer = bot(1, 22, inventoryFor(Gear.planFor({ classId: 1, level: 20 }).items));
    const farmSpot = rewardSpot('28_-33', 19, 23, { locX: 82000, locY: 149000, locZ: -3466 });
    const potion = 6035, farmBoard = new BoardIndex();
    const bid = (price, count = 2) => farmBoard.put({ id: 200, ownerId: 990121, storeType: 3, kind: 'buy_ad', town: 'Giran',
        lines: [{ lineId: 200, selfId: potion, count, enchant: 0, price }] });
    const farmContext = Economy.forState(farmer, { board: farmBoard, timestamp, spots: [], npcOffersFor: () => [], routeRows: ctx.routeRows });
    const farmBuild = () => Providers.build(farmer, farmContext, { spots: [farmSpot] });
    bid(200000);
    let demand = farmBuild();
    assert(demand.roots.includes(`resale:${potion}`), 'a line paying more than the farm hours becomes a farm root');
    const farmRoot = demand.nodes.find(row => row.key === `resale:${potion}`);
    assert.equal(farmRoot.object.amount, 2, 'the farm is bounded by the line\'s demand');
    assert.equal(farmRoot.paths[0].kind, 'farm_sale');
    const leaf = demand.nodes.find(row => row.key === farmRoot.paths[0].requirements[0].key).paths[0];
    assert.deepEqual([leaf.kind, leaf.activity, leaf.spotId], ['drop', 'hunting', '28_-33'], 'it hunts the source spot for the drop');
    // A buyer's line takes from me what the cheaper asks leave
    // (PriceDecision.bidLots): none when cheaper asks cover the whole line.
    farmBoard.put({ id: 201, ownerId: 990122, storeType: 1, kind: 'shop', town: 'Giran',
        lines: [{ lineId: 201, selfId: potion, count: 2, enchant: 0, price: 150000 }] });
    assert(!farmBuild().roots.includes(`resale:${potion}`), 'a line the cheaper asks cover farms nothing');
    farmBoard.remove(201);
    bid(farmContext.buyback(potion));
    assert(!farmBuild().roots.includes(`resale:${potion}`), 'a bid at NPC buy-back is no reason to farm');
    farmBoard.remove(200);
    assert(!farmBuild().roots.includes(`resale:${potion}`), 'withdrawing the buyer retires speculative farming');
    // The farm lines ranked by gain per kill, not by line size: a 1-unit
    // bid far above buy-back on a rare drop (a recipe at ~1e-4 per kill)
    // does not crowd out a deep line on a common part (Thread, ~1.4e-2 per
    // kill) at the same spot, though each rare line's total is larger.
    const thread = 1868, rare = [2256, 1801, 736, 909, 878, 846, 1105, 876, 1102, 9, 154];
    rare.forEach((id, at) => farmBoard.put({ id: 300 + at, ownerId: 990200 + at, storeType: 3, kind: 'buy_ad', town: 'Giran',
        lines: [{ lineId: 300 + at, selfId: id, count: 1, enchant: 0, price: farmContext.buyback(id) + 600000 }] }));
    farmBoard.put({ id: 299, ownerId: 990199, storeType: 3, kind: 'buy_ad', town: 'Giran',
        lines: [{ lineId: 299, selfId: thread, count: 50, enchant: 0, price: farmContext.buyback(thread) + 10000 }] });
    demand = farmBuild();
    assert(demand.roots.includes(`resale:${thread}`), 'the deep common line is farmed beside rare high bids');
    const farmRoots = build => build.nodes.filter(row => build.roots.includes(row.key) && row.paths[0]?.kind === 'farm_sale');
    assert.equal(farmRoots(demand).length, 1, 'a build roots one farm line, the best ready one');
    // Its rank counts the farm hours, but it is kept while its value beats
    // the net cost of those hours: a spot paying most of the hour leaves a
    // line worth less than its farm hours still worth farming.
    const solver = createSolver({ nodes: demand.nodes, hourAdena: farmContext.hourAdena, wallet: farmer.adena });
    const threadRoot = solver.rootWish(`resale:${thread}`);
    assert(threadRoot.valueHours < threadRoot.plan.hours, 'the fixture line is worth less than its farm hours');
    assert(solver.earns(threadRoot), 'a farm the spot mostly pays for is kept');
    // The pre-cut ranks by the bot's own reachable records: 8 lines whose
    // only sources lie at a level-70 spot this level-22 bot may not hunt,
    // richer by gain per kill there (as is Thread's own record there), do
    // not crowd its reachable line out.
    const highSpot = rewardSpot('15_-11', 70, 72, { locX: 150000, locY: -60000, locZ: -3000 });
    [1344, 1895, 1876, 6670, 4043, 4042, 4040, 5536].forEach((id, at) => farmBoard.put({ id: 400 + at, ownerId: 990300 + at,
        storeType: 3, kind: 'buy_ad', town: 'Giran',
        lines: [{ lineId: 400 + at, selfId: id, count: 1, enchant: 0, price: farmContext.buyback(id) + 3000000 }] }));
    demand = Providers.build(farmer, farmContext, { spots: [farmSpot, highSpot] });
    assert.deepEqual(farmRoots(demand).map(row => row.key), [`resale:${thread}`],
        'unreachable sources leave the bot\'s reachable line in the pre-cut');
    // A farm lot fits the bot's horizon like a gear drop path: item 26
    // drops at the farm spot at ~1.9e-5 per kill, so its source hours for
    // one unit pass the level-22 bot's horizon, and a 1-unit line paying
    // more per kill than Thread is a lottery, not its farm plan.
    farmBoard.put({ id: 500, ownerId: 990500, storeType: 3, kind: 'buy_ad', town: 'Giran',
        lines: [{ lineId: 500, selfId: 26, count: 1, enchant: 0, price: farmContext.buyback(26) + 10000000 }] });
    assert.deepEqual(farmRoots(farmBuild()).map(row => row.key), [`resale:${thread}`],
        'a line the bot expects no unit of in its horizon is no farm root');
    // The lot is what the source path delivers in the horizon at its hours
    // per unit after the plan's trips (EconomicValuation.horizonUnits, the
    // gear verdict's withinHorizon), not what the bot's own kill rate
    // suggests: its own hunt kills a hundred times faster (each kill paying
    // a hundredth), the source spot does not.
    const threadLot = build => {
        const root = build.nodes.find(row => row.key === `resale:${thread}`);
        return root && { amount: root.object.amount, sale: root.paths[0],
            path: build.nodes.find(row => row.key === root.paths[0].requirements[0].key).paths[0] };
    };
    const threadNow = threadLot(farmBuild()), unitHours = threadNow.path.readyHours;
    // The plan's trip hours: to the source spot, then to the buyer's town.
    const tripHours = (threadNow.path.tripHours || 0)
        + (threadNow.path.town !== threadNow.sale.town ? threadNow.sale.tripHours || 0 : 0);
    const fastHunt = { ...farmContext.hunt, perKill: farmContext.hunt.perKill / 100 };
    const lotWithin = units => threadLot(Providers.build(farmer,
        { ...farmContext, hunt: fastHunt, horizonHours: tripHours + (units + 0.5) * unitHours }, { spots: [farmSpot] }))?.amount;
    assert.equal(lotWithin(3), 3, 'a slow source farms for the units its horizon delivers');
    assert.equal(lotWithin(60), 50, 'a source faster than the horizon needs farms for the whole line');
    // Hours a plan spends travelling are hours of the horizon: a unit whose
    // kill hours fit it but not with the trips (the farm spot is not the
    // bot's own) is no farm root. farmContext's routes take 0 hours, so this
    // case reads routes of a quarter unit to every town.
    const routeContext = { ...farmContext, trip: Trip.preparedReader(Trip.towns.map(() => [true, 0.25 * unitHours, 0]),
        { hourAdena: farmContext.hourAdena }) };
    const routeLot = horizonHours => threadLot(Providers.build(farmer, { ...routeContext, horizonHours }, { spots: [farmSpot] }));
    const routed = routeLot(100 * unitHours);
    const routeTrips = (routed.path.tripHours || 0) + (routed.path.town !== routed.sale.town ? routed.sale.tripHours || 0 : 0);
    assert(routeTrips > 0, 'the fixture farm needs a trip');
    assert.equal(routeLot(routeTrips + 1.5 * unitHours)?.amount, 1, 'a unit that fits with its trips is farmed');
    assert.equal(routeLot(routeTrips + 0.99 * unitHours), undefined, 'the trips count in the lot\'s hours');
    // Lottery lines keep no pre-cut slot: 8 one-unit lines paying far more
    // per kill than Thread, whose first unit each takes the whole horizon,
    // leave Thread its farm root.
    const bidRare = spread => rare.slice(0, 8).forEach((id, at) => farmBoard.put({ id: 300 + at, ownerId: 990200 + at,
        storeType: 3, kind: 'buy_ad', town: 'Giran',
        lines: [{ lineId: 300 + at, selfId: id, count: 1, enchant: 0, price: farmContext.buyback(id) + spread }] }));
    bidRare(10000000);
    assert.deepEqual(farmRoots(Providers.build(farmer, { ...farmContext, horizonHours: tripHours + 3.5 * unitHours },
        { spots: [farmSpot] })).map(row => row.key), [`resale:${thread}`], 'lottery lines leave the feasible line in the pre-cut');
    bidRare(600000);
    // A farm leaf whose spot has no room when its trip starts: the route
    // takes the bot elsewhere (or nowhere) and marks the spot "was full",
    // so the next build farms no line there instead of choosing the same
    // full spot again, until the mark expires (the step after next).
    const farmLeaf = build => {
        const root = farmRoots(build)[0];
        const path = root && build.nodes.find(row => row.key === root.paths[0].requirements[0].key).paths[0];
        return path && { ...path, rootKey: root.key, amount: root.object.amount };
    };
    const spots2 = [farmSpot, highSpot];
    const threadLeaf = farmLeaf(Providers.build(farmer, farmContext, { spots: spots2 }));
    assert(ColdEconomyDecision.materialHunt(threadLeaf) && threadLeaf.spotId === '28_-33', 'fixture: the farm hunts Thread at 28_-33');
    const fullTrip = BotRoute.trip({}, farmer, threadLeaf, { spots: spots2, timestamp, hasRoom: id => id !== '28_-33' });
    const afterTrip = beginHuntingTrip(farmer, fullTrip, timestamp) || farmer;
    const farmSpotOf = build => farmLeaf(build)?.spotId ?? null;
    assert.notEqual(farmSpotOf(Providers.build(afterTrip, farmContext, { spots: spots2 })), '28_-33',
        'the build after a full farm spot does not choose that spot again');
    const stepped = steps => ({ ...afterTrip, stats: { ...afterTrip.stats, stepCount: (afterTrip.stats.stepCount || 0) + steps } });
    assert.notEqual(farmSpotOf(Providers.build(stepped(1), farmContext, { spots: spots2 })), '28_-33',
        'the next decision point still skips the full spot');
    assert.equal(farmSpotOf(Providers.build(stepped(2), farmContext, { spots: spots2 })), '28_-33',
        'the spot is the farm\'s again once the mark expires');
    // Spoils are a spoiler's source only, in the pre-cut too: 8 lines on
    // items that only spoil at 28_-33 (~7e-3 to 2.2e-2 per kill), each
    // paying more per kill than Thread, do not fill the warrior's 8 farm
    // candidates; a level-22 scavenger farms one of them.
    const spoils = [2176, 2177, 1897, 2152, 2143, 1931, 1929, 1922];
    spoils.forEach((id, at) => farmBoard.put({ id: 600 + at, ownerId: 990600 + at, storeType: 3, kind: 'buy_ad', town: 'Giran',
        lines: [{ lineId: 600 + at, selfId: id, count: 20, enchant: 0, price: farmContext.buyback(id) + 100000 }] }));
    assert.deepEqual(farmRoots(Providers.build(farmer, farmContext, { spots: spots2 })).map(row => row.key), [`resale:${thread}`],
        'lines only a spoil supplies leave a bot that cannot spoil its own farm line');
    const scavenger = bot(54, 22, inventoryFor(Gear.planFor({ classId: 54, level: 20 }).items));
    const scavengerContext = Economy.forState(scavenger, { board: farmBoard, timestamp, spots: [], npcOffersFor: () => [], routeRows: ctx.routeRows });
    assert(spoils.some(id => farmRoots(Providers.build(scavenger, scavengerContext, { spots: spots2 }))[0]?.key === `resale:${id}`),
        'a spoiler farms a line its spoil supplies');
    spoils.forEach((id, at) => farmBoard.remove(600 + at));
    // The farmer's wake when its line is sold (its build's SOLD watch row,
    // referenced at the plain line it farms for): the soft point crosses
    // when that line closes, though a bid for an enchanted unit (no buyer
    // of a farmed one) stays.
    farmBoard.put({ id: 298, ownerId: 990198, storeType: 3, kind: 'buy_ad', town: 'Giran',
        lines: [{ lineId: 298, selfId: thread, count: 5, enchant: 3, price: farmContext.buyback(thread) + 50000 }] });
    const watch = [[thread, 3, farmContext.buyback(thread) + 10000, 0.1, Sections.SOLD]];
    assert.equal(Sections.marketCrossed(farmBoard, watch, farmer.characterId), false, 'an open line wakes nobody');
    farmBoard.remove(299);
    assert.equal(Sections.marketCrossed(farmBoard, watch, farmer.characterId), true, 'the sold line wakes its farmer');
    farmBoard.remove(298);
    // User 2026-10-24: a bot's gear target is the strongest step stronger
    // than worn it can reach, valued over its stage's hours; the level's grade
    // weights that horizon only. A lower step loses the benefit it would bring
    // after a stronger reachable row is ready.
    const staffBoard = new BoardIndex();
    staffBoard.put({ id: 700, ownerId: 990700, storeType: 1, kind: 'shop', town: 'Giran',
        lines: [{ lineId: 700, selfId: 90, count: 1, enchant: 0, price: 1400000 },
            { lineId: 701, selfId: 192, count: 1, enchant: 0, price: 6190000 }] });
    const mystic = (characterId, weapon, adena, level = 40, armour = Gear.planFor({ classId: 12, level: 20 }).items) => ({
        ...bot(12, level, inventoryFor([...armour.filter(row => ![7, 14].includes(Number(row.slot))), { selfId: weapon, slot: 14 }])),
        characterId, adena });
    const rootsOf = (state, board) => Economy.forState(state, { spots: [], board, timestamp, npcOffersFor: () => [],
        routeRows: ctx.routeRows }).projection.roots;
    const weaponRoots = (state, board = staffBoard) => rootsOf(state, board).filter(key => /^power:\d+:(7|14)$/.test(key));
    const staff = id => Data.items.find(item => item.selfId === id);
    const staffScore = id => Planner.itemScore(staff(id), 'mage', 12);
    const rankOf = key => staff(Number(key.split(':')[1])).etc.rank;
    // (a) Both staffs are stronger than the worn D staff and paid now: the
    // stronger one is the root.
    assert(staffScore(192) > staffScore(90) && staffScore(90) > staffScore(183), 'fixture: 183 < 90 (D) < 192 (C)');
    assert.deepEqual(weaponRoots(mystic(990702, 183, 8000000)), ['power:192:14'],
        'the strongest reachable stronger staff wins over a weaker one');
    // (b) The level-grade staff is out of reach (its funding takes most of
    // the stage): a lower-grade staff stronger than worn is the step.
    const farRoots = weaponRoots(mystic(990701, 183, 2000000));
    assert.equal(farRoots.length, 1, 'one weapon root');
    assert(rankOf(farRoots[0]) === 'd' && staffScore(Number(farRoots[0].split(':')[1])) > staffScore(183),
        `a D staff stronger than the worn one is the step while the C staff is out of reach (${farRoots[0]})`);
    const dBoard = price => { const index = new BoardIndex();
        index.put({ id: 720, ownerId: 990720, storeType: 1, kind: 'shop', town: 'Giran',
            lines: [{ lineId: 720, selfId: 90, count: 1, enchant: 0, price }] });
        return index; };
    assert.deepEqual(weaponRoots(mystic(990721, 183, 2000000), dBoard(1400000)), ['power:90:14'],
        'a D step that pays is the root while no C staff has a path');
    assert.deepEqual(weaponRoots(mystic(990722, 183, 2000000), dBoard(60000000)).filter(key => key === 'power:90:14'), [],
        'a D step that never pays its effort is no root');
    // (c) The C staff is ready soon (a small shortfall): the D step would
    // serve only until then, its tail is cut and it loses.
    const soonRoots = weaponRoots(mystic(990703, 183, 6100000));
    assert(!soonRoots.includes('power:90:14'), `a D step loses to a C staff ready soon (${soonRoots.join(',')})`);
    assert(soonRoots.includes('power:192:14'), `the C staff ready soon is the root (${soonRoots.join(',')})`);
    const offers = lines => { const index = new BoardIndex();
        index.put({ id: 740, ownerId: 990740, storeType: 1, kind: 'shop', town: 'Giran',
            lines: lines.map(([selfId, price], at) => ({ lineId: 740 + at, selfId, count: 1, enchant: 0, price })) });
        return index; };
    // (c2) A stronger staff that never pays its own effort (its funding
    // takes most of the stage) is never taken, so it cuts nothing: the D
    // step that pays over the whole stage stays the root.
    assert.deepEqual(weaponRoots(mystic(990741, 183, 2000000), offers([[90, 1900000], [192, 6190000]])), ['power:90:14'],
        'a stronger staff that is never the root does not cut the D step');
    // (c2b) A chain of three steps: the middle one pays uncut but, cut by the
    // strongest taken step, never pays, so it cuts nothing; the weakest step
    // keeps its hours until the strongest is ready and wins its family.
    const chainRow = (key, benefitPerHour, readyHours, valueHours, effort) => ({ status: 'evaluated',
        node: { key, benefitPerHour, horizonHours: 100, notBeforeHours: 0 }, wish: { readyHours, valueHours, effort } });
    const chain = [chainRow('c1', 0.1, 0, 10, 1), chainRow('c2', 0.2, 10, 18, 5), chainRow('c3', 0.3, 30, 21, 20.5)];
    const chainNets = Providers.gearStepNets(chain);
    assert.deepEqual(chain.map(row => Math.round(chainNets.get(row) * 100) / 100), [2, -1, 0.5],
        'a step cut only by a stronger step that is itself taken');
    // (c3) A preparing bot (level 20, D kit worn) wears the C staff only from
    // 40: its tail cut starts there, so the D staff wearable now keeps its
    // hours until 40 and is the step.
    assert.deepEqual(weaponRoots(mystic(990742, 183, 8000000, 20), offers([[90, 400000], [192, 6190000]])), ['power:90:14'],
        'a C staff wearable only from 40 does not cut the D step before 40');
    // (d) The worn staff is the strongest D one (90 scores the same): no D or
    // lower staff is a step, an equal score included.
    assert(staffScore(188) >= staffScore(90), 'fixture: 188 is at least as strong as 90');
    assert.deepEqual(weaponRoots(mystic(990704, 188, 8000000), dBoard(1400000)).filter(key => ['none', 'd'].includes(rankOf(key))), [],
        'no staff stronger than worn on offer leaves no gear root');
    // (e) Armour follows the same rule: a level-40 mystic in D armour, a C
    // staff worn (no weapon gap), is offered the C piece of a slot and a
    // weaker piece of the same slot; the stronger reachable piece is the root,
    // the weaker one never is.
    const dKit = Gear.planFor({ classId: 12, level: 20 }).items, cKit = Gear.planFor({ classId: 12, level: 40 }).items;
    const ngKit = Gear.planFor({ classId: 12, level: 10 }).items;
    const pieceOf = (kit, slot) => kit.find(row => Number(row.slot) === slot);
    const armourSlot = [12, 9, 11, 10, 15].find(slot => pieceOf(dKit, slot) && pieceOf(cKit, slot) && pieceOf(ngKit, slot)
        && pieceOf(cKit, slot).selfId !== pieceOf(dKit, slot).selfId && pieceOf(ngKit, slot).selfId !== pieceOf(dKit, slot).selfId);
    assert(armourSlot, 'fixture: an armour slot with NG, D and C kit pieces');
    const strongPiece = pieceOf(cKit, armourSlot).selfId, weakPiece = pieceOf(ngKit, armourSlot).selfId;
    const armourBoard = new BoardIndex();
    armourBoard.put({ id: 730, ownerId: 990730, storeType: 1, kind: 'shop', town: 'Giran',
        lines: [{ lineId: 730, selfId: strongPiece, count: 1, enchant: 0, price: 2000000 },
            { lineId: 731, selfId: weakPiece, count: 1, enchant: 0, price: 50000 }] });
    const armourRoots = rootsOf(mystic(990731, 192, 8000000, 40, dKit), armourBoard)
        .filter(key => new RegExp(`^power:\\d+:${armourSlot}$`).test(key));
    assert.deepEqual(armourRoots, [`power:${strongPiece}:${armourSlot}`],
        `the strongest reachable armour piece is the root, the weaker one is none (${armourRoots.join(',')})`);
    console.log(`PASS personal gear: starter, NG/D classes, clan boundary, paired native receipt, liquidation, net income and completion time ${isMainThread ? 'main' : 'worker'}`);
}
verifyHeldInputs();
verifyFarmHold();
verifyGearBidFarm();
verify();
if (isMainThread) {
    const worker = new Worker(__filename);
    worker.on('error', error => { console.error(error); process.exitCode = 1; });
    worker.on('exit', code => { if (code) process.exitCode = code; });
} else parentPort.postMessage('verified');
