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
verify();
if (isMainThread) {
    const worker = new Worker(__filename);
    worker.on('error', error => { console.error(error); process.exitCode = 1; });
    worker.on('exit', code => { if (code) process.exitCode = code; });
} else parentPort.postMessage('verified');
