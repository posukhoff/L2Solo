'use strict';
// Customer demand of a shot in a town: the population census by what is worn
// (wearers per cell x the class's table use) and completed public trades; the
// larger one per town is the forecast, read by each bot through its own market
// error, less the units rivals' plans in flight commit to the listing.
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Demand = require('../src/GameServer/Bot/Economy/MarketDemand');
const Census = require('../src/GameServer/Bot/Economy/DemandCensus');
const MarketTownPolicy = require('../src/GameServer/Bot/Economy/MarketTownPolicy');
const Recipes = require('../src/GameServer/Items/C4RecipeItems');
const Sections = require('../src/GameServer/Bot/Economy/DecisionSections');
const Committed = require('../src/GameServer/Bot/Economy/CommittedExits');
const SalePolicy = require('../src/GameServer/Bot/Economy/ShotSalePolicy');
const ShotCraft = require('../src/GameServer/Bot/Economy/ShotCraftPolicy');
const { SELL } = require('../src/GameServer/AfkTrade/BoardIndex');
const Persona = invoke('GameServer/Bot/AI/BotPersona');

const now = Date.now();
const SHOT_D = 1463, SHOT_C = 1464;
// A fighter with an equipped D weapon (Bastard Sword); no spot needed.
const fighter = (characterId, extra = {}) => ({ characterId, level: 30, stats: { classId: 0 }, adena: 10000,
    inventory: { 69: { selfId: 69, amount: 1, equipped: true, slot: 7 } }, ...extra });
const put = state => { Census.observe({ characterId: state.characterId, state, kind: 'put' }); Census.flush(); };
const remove = characterId => { Census.observe({ characterId, state: null, kind: 'remove' }); Census.flush(); };
const total = () => Demand.forecast(SHOT_D, null, now)?.applicableUnits || 0;

// The first put waits for the replay of the loaded bots, then goes at once.
const first = fighter(900001);
const town = MarketTownPolicy.targetTownForItems(first, [{ selfId: SHOT_D }]);
assert.ok(town, 'the fighter buys its shots in a town');
let replayEnd = null;
Census.start({ subscribePublications(listener, options) {
    assert.equal(options.replay, true);
    listener({ characterId: first.characterId, state: first, kind: 'put' });
    replayEnd = options.onReplayed;
    return () => {};
} });
assert.equal(Demand.forecast(SHOT_D, null, now), null, 'nothing is put while the replay runs');
assert.equal(Sections.marketCrossed({ first: () => null }, [[SHOT_D, Sections.CENSUS, 50, .2]], 1), false,
    'no census put yet is no crossing');
assert.equal(Sections.marketCrossed({ first: () => null }, [[SHOT_D, Sections.CENSUS, 0, .2]], 1), false,
    'a wake row waits for the first put');
replayEnd();
assert.equal(Sections.marketCrossed({ first: () => null }, [[SHOT_D, Sections.CENSUS, 0, .2]], 1), true,
    'a crafter built before the first put (reference 0) wakes on the first burn');
const one = Demand.forecast(SHOT_D, town, now);
assert.ok(one?.applicableUnits > 0, 'the census of what is worn alone gives a forecast, off a spot too');
assert.equal(one.origin, 'census');
assert.equal(one.repeatable, false);
assert.equal(Demand.forecast(SHOT_D, null, now).applicableUnits, one.applicableUnits);
assert.equal(Demand.forecast(SHOT_D, town === 'Giran' ? 'Dion' : 'Giran', now), null, 'the wearers buy in their own town');
assert.equal(Demand.forecast(SHOT_C, null, now), null, 'a D wearer burns no C shots');
assert.equal(one.delayHours, .5);
assert.equal(Math.floor(Demand.censusOf(SHOT_D) * one.delayHours), one.applicableUnits,
    'a half-hour of the burn the soft point reads');

// Counts move by difference: a second wearer adds its burn, its removal takes
// it back, the same state adds nothing, a level grade move replaces the cell.
const second = fighter(900002);
put(second);
assert.ok(Math.abs(total() - 2 * one.applicableUnits) <= 1, 'two equal wearers burn twice');
remove(second.characterId);
assert.ok(Math.abs(total() - one.applicableUnits) <= 1, 'removal subtracts the wearer');
put(first);
assert.ok(Math.abs(total() - one.applicableUnits) <= 1, 'the same state adds nothing');
const older = fighter(900001, { level: 45 });
put(older);
const moved = total();
remove(older.characterId);
assert.equal(total(), 0, 'the move left nothing in the old cell');
put(fighter(900003, { level: 45 }));
assert.ok(moved > 0 && Math.abs(total() - moved) <= 1, 'a level grade move replaces the wearer\'s burn');
remove(900003);
put(fighter(900004, { inventory: {} }));
assert.equal(Demand.forecast(SHOT_D, null, now), null, 'no weapon, no shots worn');
remove(900004);

// Trades alone give a forecast in the town of the deals; material purchases
// are trade evidence too.
Demand.deal(1864, 400, 'Dion', now - 900000);
assert.equal(Demand.forecast(1864, 'Dion', now), null, 'one material deal is no flow');
Demand.deal(1864, 400, 'Dion', now - 600000);
assert.ok(Demand.forecast(1864, 'Dion', now)?.applicableUnits > 0, 'material purchases are trade demand');
Demand.deal(SHOT_C, 400, 'Dion', now - 900000);
assert.equal(Demand.forecast(SHOT_C, 'Dion', now), null, 'one deal is no flow');
Demand.deal(SHOT_C, 400, 'Dion', now - 600000);
const traded = Demand.forecast(SHOT_C, 'Dion', now);
assert.ok(traded?.applicableUnits > 0 && traded.applicableUnits < 800, 'two deals give a half-hour of their flow');
assert.equal(traded.origin, 'public_trades');
assert.equal(Demand.forecast(SHOT_C, 'Giran', now), null, 'demand stays in the traded town');
assert.equal(Demand.forecast(SHOT_C, 'Dion', now + 24 * 3600000), null, 'old trades decay away');

// Rivals' plans in flight (CommittedExits) already serve part of a product's
// listing in a town: a producer's units are what they leave; its own plan
// takes none, a rival's plan for another town takes none of this one.
const reader = (characterId, extra = {}) => ({ characterId, understanding: 0, marketTrades: {}, knowledgeEnabled: false, ...extra });
const noBoard = { list: () => [] };
const producer = characterId => ({ ...reader(characterId), board: noBoard, producer: characterId });
const listingOf = (units, botId, where = 'Dion', id = SHOT_C) =>
    Committed.commit(botId, [{ key: `resale:${id}`, amount: units, exit: [-2, ShotCraft.townCode(where), 10, 0] }]);
assert.equal(Demand.forecast(SHOT_C, 'Dion', now, producer(1)).applicableUnits,
    traded.applicableUnits, 'no rival plan: the whole demand');
listingOf(1, 7);
listingOf(traded.applicableUnits, 1);
assert.equal(Demand.forecast(SHOT_C, 'Dion', now, producer(1))?.applicableUnits || 0,
    traded.applicableUnits - 1, 'a rival\'s committed unit is served; the reader\'s own plan is not subtracted');
listingOf(traded.applicableUnits, 7, 'Giran');
assert.equal(Demand.forecast(SHOT_C, 'Dion', now, producer(1)).applicableUnits,
    traded.applicableUnits, 'a rival\'s Giran units do not close the Dion listing');
assert.equal(Demand.forecast(SHOT_C, null, now, producer(1))?.applicableUnits,
    Demand.forecast(SHOT_C, null, now).applicableUnits, 'a read of no town takes no rival plan');
listingOf(traded.applicableUnits, 7);
assert.equal(Demand.forecast(SHOT_C, 'Dion', now, producer(1)), null, 'every unit committed by rivals: no demand left');
Committed.remove(7);
assert.equal(Demand.forecast(SHOT_C, 'Dion', now, producer(1)).applicableUnits,
    traded.applicableUnits, 'the rival\'s plan dropped: the demand is open again');
Committed.clear();

// A lone producer of a slow item (under two units an hour) still gets its
// first unit, over as long as that unit takes to sell; a holder of the item
// (no producer read, as MarketPricing.traderContext) still sells its unit
// while a rival plans one, the producer's demand is gone.
Demand.deal(1879, 1, 'Dion', now - 1200000);
Demand.deal(1879, 1, 'Dion', now - 600000);
const slow = Demand.forecast(1879, 'Dion', now, producer(1));
assert.equal(slow?.applicableUnits, 1, 'a slow item still gives one unit');
assert.ok(slow.delayHours > .5, 'over longer than the half-hour');
listingOf(1, 7, 'Dion', 1879);
assert.equal(Demand.forecast(1879, 'Dion', now, { ...reader(1), board: noBoard })?.applicableUnits, 1,
    'a holder\'s read keeps its one unit beside a rival\'s plan');
assert.equal(Demand.forecast(1879, 'Dion', now, producer(1)), null, 'the producer\'s one unit is the rival\'s');
Committed.clear();

// Both: the larger source per town is the forecast.
put(first);
const burn = Demand.forecast(SHOT_D, town, now).applicableUnits;
Demand.deal(SHOT_D, Math.max(1, Math.floor(burn / 4)), town, now);
assert.equal(Demand.forecast(SHOT_D, town, now).applicableUnits, burn, 'census above trades: census');
assert.equal(Demand.forecast(SHOT_D, town, now).origin, 'census');

// Board stock does not cut the census: only rivals' plans in flight come off
// a producer's read (CommittedExits, above).
const hourly = Demand.censusOf(SHOT_D);
Demand.deal(SHOT_D, 1, town, now);
const sold = Math.max(1, Math.floor(burn / 4)) + 1;
assert.ok(sold < hourly / 4, 'the sales stay under a quarter of the census');
const stock = lines => ({ list: (id, storeType, where) => Number(id) === SHOT_D && storeType === SELL
    && where === town ? lines.map(([ownerId, count]) => ({ ownerId, count, price: 1 })) : [] });
const stocked = view => Demand.forecast(SHOT_D, town, now, { ...reader(1), board: view }).applicableUnits;
assert.equal(Demand.forecast(SHOT_D, town, now).applicableUnits, burn, 'two deals under the census: census');
assert.equal(stocked(stock([[7, sold * 10], [8, 1]])), burn, 'rival stock on the board keeps the census');
const selling = Math.ceil(hourly * .6);
assert.ok(selling > hourly / 4 && selling < hourly);
Demand.deal(SHOT_D, selling - sold, town, now);
assert.equal(Demand.forecast(SHOT_D, town, now).applicableUnits, burn, 'sales under the census: census');
Demand.deal(SHOT_D, burn * 6, town, now);
const both = Demand.forecast(SHOT_D, town, now);
assert.ok(both.applicableUnits > burn * 3, 'trades above census: trades');
assert.equal(both.origin, 'public_trades');

// The worker mirror reads the same rows.
const rows = new Map(Demand.rows().map(row => [row[0], row]));
Demand.useTable(() => rows);
assert.deepEqual(Demand.forecast(SHOT_D, town, now), both, 'the worker mirror gives the same forecast');
// A copy of the table in several pages: a read before the copy is whole sees
// no rows; the copy's end (censusChanged(), the worker's table_page) makes
// the next read whole.
const wholeBurn = Demand.censusOf(SHOT_D);
let copy = new Map();
Demand.useTable(() => copy);
assert.equal(Demand.censusOf(SHOT_D), null, 'a read during the copy sees no census');
copy = rows;
Demand.censusChanged();
assert.equal(Demand.censusOf(SHOT_D), wholeBurn, 'the copy\'s end reads the whole census');
assert.deepEqual(Demand.forecast(SHOT_D, town, now), both);
Demand.reset();

// The soft point: a census row crosses when the census moved by more than the
// bot's error, not before.
const watched = Math.round(Demand.censusOf(SHOT_D));
const crossed = watch => Sections.marketCrossed({ first: () => null }, watch, 1);
assert.equal(crossed([[SHOT_D, Sections.CENSUS, watched, .2]]), false, 'an unmoved census does not cross');
put(fighter(900005));
assert.equal(crossed([[SHOT_D, Sections.CENSUS, watched, .2]]), true, 'a doubled census crosses');
remove(900005);
remove(first.characterId);
assert.equal(crossed([[SHOT_D, Sections.CENSUS, watched, .2]]), true, 'the last wearer leaving crosses');
put(first);

// Perception: each bot reads the census with its own stable error.
const exact = Demand.forecast(SHOT_D, town, now).applicableUnits;
const reads = [1, 2, 3, 4, 5].map(id => Demand.forecast(SHOT_D, town, now, reader(id, { knowledgeEnabled: true })).applicableUnits);
assert.deepEqual([1, 2, 3, 4, 5].map(id => Demand.forecast(SHOT_D, town, now, reader(id, { knowledgeEnabled: true })).applicableUnits),
    reads, 'a bot reads the same value each time');
assert.ok(new Set(reads).size > 1, 'bots read different values');
assert.ok(reads.some(value => value !== exact), 'a bot\'s read carries its error');
assert.equal(Demand.forecast(SHOT_D, town, now, reader(1)).applicableUnits, exact, 'with knowledge off the read is exact');

// A crafter's shot exit (ShotSalePolicy): a listing in the wearers' town sized
// by its read of the census; none once rivals' plans in flight commit every unit.
const recipeD = Recipes.resolveByProductId(SHOT_D);
const crafter = { characterId: 950001, level: 40, classId: 56, stats: { classId: 56 }, adena: 100000, inventory: {},
    persona: Persona.generate({ characterId: 950001, classId: 56 }), marketTrades: {} };
const emptyBoard = { list: () => [], first: () => null, itemRevision: () => 0 };
const trip = Object.assign(() => 0, { details: () => ({ known: true }) });
const terms = view => ({ board: view, town, timestamp: now, trip, units: Number(recipeD.productCount), lot: Number(recipeD.productCount) });
const alone = SalePolicy.exit(crafter, SHOT_D, terms(emptyBoard));
assert.equal(alone?.type, 'listing', 'the census alone gives the crafter a listing exit');
assert.equal(alone.town, town);
assert.equal(alone.forecast.origin, 'census');
listingOf(alone.forecast.applicableUnits, 7, town, SHOT_D);
assert.equal(SalePolicy.exit(crafter, SHOT_D, terms(emptyBoard)), null, 'rivals commit every unit: no listing exit');
Committed.clear();
assert.equal(SalePolicy.exit(crafter, SHOT_D, { ...terms(emptyBoard), town: town === 'Giran' ? 'Dion' : 'Giran' }), null,
    'no exit where no one wears the grade');
// Gear: the wearers one level grade below a grade reach its band at their
// class's exp per hour and ask the class's wished items of that grade, in the
// item grade's town. The fighter (level 30, D weapon) asks C weapons in
// Giran and no D weapon; a no-grade bot of level 10 asks D weapons.
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Sources = require('../src/GameServer/Items/ItemAcquisitionCatalog');
const weapons = invoke('GameServer/Bot/AI/BotGear').wishKitsFor(invoke('GameServer/DataCache').items, Sources.revision(),
    0, Planner.roleFor(first), Planner, Sources).get(7);
const weaponsOf = rank => Array.from({ length: weapons?.length || 0 }, (_, at) => at)
    .filter(at => weapons.rankAt(at) === rank).map(at => Number(weapons.itemAt(at).selfId));
const [cWeapon] = weaponsOf(2), [dWeapon] = weaponsOf(1);
assert.ok(cWeapon && dWeapon, 'the fighter wishes D and C weapons');
assert.equal(Demand.forecast(cWeapon, 'Giran', now), null, 'main, which has no mirror, counts no gear (its readers count trades)');
assert.ok(Demand.hasCensusSource(cWeapon) && Demand.hasCensusSource(SHOT_D), 'a kit item and a worn shot have a census source');
assert.equal(Demand.hasCensusSource(57), false, 'adena has no census source');
// The worker reads gear from its mirror of the census rows.
let mirror = null;
const sync = () => { mirror = new Map(Demand.rows().map(row => [row[0], row])); Demand.useTable(() => mirror); };
sync();
const gear = Demand.forecast(cWeapon, 'Giran', now);
assert.ok(gear?.applicableUnits >= 1, 'a bot one grade below asks the next grade\'s gear');
assert.equal(gear.origin, 'census');
// Board stock does not cut the gear census either: rival C weapons on
// Giran's board leave the reader the same units over the same wait.
const gearStock = { list: (id, storeType, where) => Number(id) === cWeapon && storeType === SELL && where === 'Giran'
    ? [{ ownerId: 7, count: 10, price: 1 }] : [] };
const stockedGear = Demand.forecast(cWeapon, 'Giran', now, { ...reader(1), board: gearStock });
assert.equal(stockedGear?.applicableUnits, gear.applicableUnits, 'rival gear stock keeps the census units');
assert.equal(stockedGear.origin, 'census');
assert.equal(stockedGear.delayHours, gear.delayHours, 'over the same wait as without the stock');
if (town !== 'Giran') assert.equal(Demand.forecast(cWeapon, town, now), null, 'C gear is asked in Giran, not at home');
assert.equal(Demand.forecast(dWeapon, null, now), null, 'a D wearer in the D band asks no D weapon');
// A crafter's wake row: it wakes when more products of its level have buyers
// than its build saw, not on a count it already saw.
const wakeRow = level => [[level, Sections.DEMANDED, Demand.demandedCount(level), 0]];
const builtWake = wakeRow(9);
assert.ok(builtWake[0][2] > 0, 'the census already asks products of a top crafter');
assert.equal(Sections.marketCrossed({ first: () => null }, builtWake, 1), false, 'the same count does not wake the crafter');
put(fighter(900006, { level: 10, inventory: {} }));
sync();
assert.ok(Demand.forecast(dWeapon, null, now)?.applicableUnits >= 1, 'a no-grade bot asks D weapons');
// The recipe index's fixed buyer: a crafted kit item while the census asks
// it, not once its last asker left; a shot some class loads always.
const craftedD = weaponsOf(1).find(id => Recipes.resolveByProductId(id)?.type === 'dwarven');
assert.ok(craftedD, 'a D weapon of the kit is a dwarven craft');
assert.equal(Demand.censusBuys(craftedD), true, 'a crafted D weapon the census asks has a buyer');
// A crafter ranks its products by gross per hour: the D shots one craft sells
// (156 at most, capped at the forecast's units) at 25 over the shot forecast's
// delay stay above a 1e5 weapon a slow census asks (20 h);
// the same weapon sold within the half-hour floor ranks above the shots.
const shotDelay = Demand.forecast(SHOT_D, null, now).delayHours;
const shotUnits = Math.min(156, Demand.forecast(SHOT_D, null, now).applicableUnits);
assert.ok(Demand.perHour(shotUnits * 25, shotDelay) > Demand.perHour(1e5, 20), 'shots keep their slot over slow gear');
assert.ok(Demand.perHour(1e5, Demand.DELAY_HOURS) > Demand.perHour(shotUnits * 25, shotDelay), 'fast high-priced gear ranks above shots');
// A loss ranks by its total: a small quick loss beats a large slow one, and
// any profit beats any loss.
assert.ok(Demand.perHour(-10, .5) > Demand.perHour(-100, 20), 'a bid losing 10 over 0.5 h beats a listing losing 100 over 20 h');
assert.ok(Demand.perHour(1, 20) > Demand.perHour(-1, .5), 'a profit ranks above any loss');
assert.equal(Demand.perHour(1e5), Demand.perHour(1e5, Demand.DELAY_HOURS), 'a bid without a delay sells within the floor');
assert.equal(Sections.marketCrossed({ first: () => null }, builtWake, 1), true, 'new buyers of its products wake the crafter');
assert.equal(Sections.marketCrossed({ first: () => null }, wakeRow(9), 1), false, 'a rebuilt crafter waits for the next rise');
remove(900006);
sync();
assert.equal(Demand.forecast(dWeapon, null, now), null, 'its removal takes the D demand back');
assert.equal(Demand.censusBuys(craftedD), false, 'a crafted D weapon nobody asks has no buyer');
assert.equal(Demand.censusBuys(SHOT_D), true, 'a shot some class loads always has a buyer');

// A material has no census: wearers of Soulshot C ask the shot, not its
// Crystal C; the crystal's demand is its trades, the same flow as any other
// traded material's.
const CRYSTAL_C = 1459, OTHER_MATERIAL = 1864;
assert.ok(Recipes.resolveByProductId(SHOT_C).materials.some(row => Number(row.selfId) === CRYSTAL_C), 'Soulshot C is made of Crystal C');
put(fighter(900007, { level: 45, inventory: { [cWeapon]: { selfId: cWeapon, amount: 1, equipped: true, slot: 7 } } }));
sync();
assert.ok(Demand.forecast(SHOT_C, 'Giran', now)?.applicableUnits > 0, 'a C wearer asks Soulshot C in Giran');
assert.equal(Demand.forecast(CRYSTAL_C, 'Giran', now), null, 'no Crystal C trades: no Crystal C demand');
for (const id of [CRYSTAL_C, OTHER_MATERIAL]) {
    Demand.deal(id, 400, 'Giran', now - 900000);
    Demand.deal(id, 400, 'Giran', now - 600000);
}
sync();
const crystalTrades = Demand.forecast(CRYSTAL_C, 'Giran', now);
assert.equal(crystalTrades?.origin, 'public_trades', 'Crystal C trades are its demand');
assert.equal(crystalTrades.applicableUnits, Demand.forecast(OTHER_MATERIAL, 'Giran', now).applicableUnits,
    'the crystal\'s forecast is its trade flow, as for any traded material');
remove(900007);
sync();

// The census change (the worker's mirror moved) reads the moved rows.
const cell = Demand.wornCell(first).key;
const table = new Map(Demand.rows().map(row => [row[0], row]));
Demand.useTable(() => table);
const before = Demand.censusOf(cWeapon);
table.set(cell, table.get(cell).map((value, at) => at === 1 ? value + 1 : at > 2 && at % 2 === 1 ? value * 3 : value));
Demand.censusChanged();
assert.ok(Math.abs(Demand.censusOf(cWeapon) - 3 * before) < 1e-9, 'the census change reads the moved row');
Demand.useTable(null);

Census.observe({ characterId: 0, state: null, kind: 'reset' });
Census.stop();
console.log('PASS census by what is worn: first put at replay end, counts by difference, shot trades alone, rival committed units per town, slow item one-unit floor, a holder unit beside a rival plan, larger source, soft point crossing and wake, stable per-bot read, crafter exit less the units rivals commit, gear from bots one grade below through the mirror, no stock cut on the gear census, the crafter wake count, no census for a material (its trades), the census change reads moved rows');
