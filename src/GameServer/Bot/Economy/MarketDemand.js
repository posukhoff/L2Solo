'use strict';
// Customer demand per item and town, from two sources: the population census
// by what is worn (DemandCensus on main puts one `d:` row per cell, the
// workers read the mirror) and completed public board purchases of the item
// (deal, `h:` rows). A cell is (class, slot group, worn grade, level grade);
// a shot product maps to the weapon cells whose class loads it at that grade,
// and its burn is the cell's wearers x the class's table use at the level
// grade (SpotValueTable.bandUse, static game data warmed once per thread by
// warmUse), never a per-bot read. Gear: the wearers who reach a grade's band
// (or sit in it below its grade) per hour, spread over the class's wished kit
// items of that grade. A material (crystal, crafted part) has no census: its
// demand is its trades and buy lines.
const Uptime = require('../Population/Uptime');
const TendencyRoll = require('../AI/TendencyRoll');
const PriceLearning = invoke('GameServer/Bot/Economy/PriceLearning');
const TownRespawn = require('../../World/TownRespawn');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const SpotValueTable = invoke('GameServer/Bot/AI/SpotValueTable');
const BotRoles = require('../AI/BotRoles');
const GearGradeRule = require('../AI/GearGradeRule');
const { gradeForLevel, GRADE_SAMPLE_LEVEL } = GearGradeRule;
const DataCache = invoke('GameServer/DataCache');
const Sources = require('../../Items/ItemAcquisitionCatalog');
const Equipment = require('../AI/BotEquipmentCompatibility');
const BotGear = invoke('GameServer/Bot/AI/BotGear');
const ProgressionRates = invoke('GameServer/ProgressionRates');
const { recipeCatalog } = require('./RecipeProductionIndex');
const CommittedExits = require('./CommittedExits');
const HOUR_MS = 3600000;
const LEVEL_GRADES = GearGradeRule.GRADES;
const GRADES = LEVEL_GRADES.slice(1);
const history = new Map();
// cell key -> its `d:` row [key, revision, town, wearers, ...]: the census
// counts DemandCensus last put (main thread).
const census = new Map();
// shot id -> its weapon cells [{ key, classId, levelGrade }] (game data, once).
const shotCells = new Map();
// item id -> { byTown, revision }: its census rate per hour by town, built at
// its first read after censusChanged (any `d:` row moved) or a kit move
// (kitsMoved), so a read is one lookup. gearHeld: every wished gear item's
// rate, from one walk over the `d:` rows (gearRates), dropped with `held`.
const held = new Map();
let gearHeld = null;
const NONE = Object.freeze({ byTown: new Map(), revision: 0 });
// classId -> [[itemId, rank index, units per wearer]]: the class's wished kit
// (BotGear.wishKitsFor), each grade of a slot group split evenly; dropped
// when the items, the item sources or the rate profile move (kitsMoved).
const classShares = new Map();
let kitGuard = null;
// Every class's wished kit items (hasCensusSource): game data, dropped with
// the class shares (kitsMoved).
let kitItems = null;
// The dwarven products the census counts now (censusOf > 0) and how many a
// craft level makes (demandedCount): one walk of the recipe rows, dropped
// with every held rate (censusChanged).
let demandedNow = null;
let mirror = null;
let townsByName;

// The cell every bot is counted in, from plain fields (class, level, the
// equipped weapon's grade, 'none' without one; the weapon grade stands for
// every slot): { key, shotId }, shotId null without a weapon that loads a
// craftable shot. The shot is part of the key, so a weapon that takes no
// shots (perAction 0) never sits in a shot's cell.
function wornCell(state) {
    const plan = ShotStock.planForState(state);
    const classId = Number(state.stats?.classId || state.classId || 0);
    const shot = plan.rank !== 'none' && plan.perAction > 0 && ShotStock.gradedShopShot(plan.selfId);
    const shotId = shot ? Number(plan.selfId) : null;
    return { key: cellKey(classId, plan.rank, gradeForLevel(state.level), shotId), shotId };
}
// The town a cell's wearers buy goods of a grade in, from the cell row's
// home market (DemandCensus).
function itemTown(rank, home) {
    // lazy: cycle MarketTownPolicy loads MarketCounters, which requires this file at load.
    return invoke('GameServer/Bot/Economy/MarketTownPolicy').gradeTown(rank, home);
}
function cellKey(classId, wornGrade, levelGrade, shotId) { return `d:${classId}:w:${wornGrade}:${levelGrade}:${shotId || 0}`; }
function cellsOf(id) {
    id = Number(id);
    let cells = shotCells.get(id);
    if (cells) return cells;
    cells = [];
    if (ShotStock.gradedShopShot(id)) {
        for (const template of DataCache.classTemplates || []) {
            const classId = Number(template.classId);
            for (const grade of GRADES) {
                if (ShotStock.planFor({ classId, rank: grade }).selfId !== id) continue;
                for (const levelGrade of LEVEL_GRADES) cells.push({ key: cellKey(classId, grade, levelGrade, id), classId, grade, levelGrade });
            }
        }
    }
    shotCells.set(id, cells);
    return cells;
}
// Shots one wearer of the cell burns per hour: its class's table use at the
// level grade's band level (SpotValueTable.shotsUse, warmed by warmUse).
function cellUse(cell) {
    return Math.max(0, SpotValueTable.shotsUse(BotRoles.tableRoleFor({ classId: cell.classId }), GRADE_SAMPLE_LEVEL[cell.levelGrade]));
}
// Reads every table role's use at every level grade once (a thread's start:
// main before the census starts, the worker after it is ready), so no census
// read pays a best-spot search. tableRoleFor of a class is always one of the
// table's roles.
function warmUse() {
    const started = performance.now();
    let cells = 0;
    for (const role of SpotValueTable.roles()) {
        for (const grade of LEVEL_GRADES) { SpotValueTable.bandUse(role, GRADE_SAMPLE_LEVEL[grade]); cells++; }
    }
    console.info('census: use table %d cells in %d ms', cells, Math.round(performance.now() - started));
}

// One completed public purchase (a board deal or a fixed-store receipt). Only
// a plain item is its item's demand (enchant 0; null = unknown quality of an
// enchantable item). A receipt older than the town's last one (the boot replay
// interleaves two journals) adds its own decayed share.
function deal(id, quantity, town, timestamp, enchant = 0) {
    id = Number(id);
    townsByName ||= new Set(Object.values(TownRespawn.towns).map(row => row.name));
    if (!Number.isSafeInteger(id) || id <= 0 || id === 57 || enchant !== 0 || !townsByName.has(town)
        || !Number.isSafeInteger(quantity) || quantity <= 0 || !Number.isFinite(timestamp)) return null;
    let item = history.get(id);
    if (!item) history.set(id, item = { deals: 0, towns: new Map() });
    const previous = item.towns.get(town) || { units: 0, arrivals: 0, at: timestamp };
    const at = Math.max(previous.at, timestamp);
    const decay = Math.exp(-Uptime.between(previous.at, at) / HOUR_MS);
    const receiptDecay = Math.exp(-Uptime.between(timestamp, at) / HOUR_MS);
    item.towns.set(town, { units: previous.units * decay + quantity * receiptDecay,
        arrivals: previous.arrivals * decay + receiptDecay, at });
    item.deals++;
    return row(id, item);
}
function row(id, item) {
    const result = [`h:${id}`, item.deals];
    for (const [town, value] of item.towns) result.push(town, value.units, value.arrivals, value.at);
    return result;
}
// Main: the wearers of one cell (town -> count). The row goes to the
// workers; null when the counts equal the row already put.
function putCensus(key, towns) {
    const current = census.get(key);
    const next = [key, (current?.[1] || 0) + 1];
    for (const [town, count] of towns) if (count > 0) next.push(town, count);
    if (current && current.length === next.length && next.every((value, at) => at < 2 || value === current[at])) return null;
    census.set(key, next);
    censusChanged(key);
    return next;
}
// A `d:` row was put or removed (main: putCensus; worker: its mirror of the
// 'market' table; no key = the whole table was replaced): every held rate
// goes, as gear rates sum cells of many classes.
function censusChanged() { held.clear(); gearHeld = null; demandedNow = null; }
// Gear rates read the class kits (game items, their sources) and the exp per
// hour (rate profile): a move of any drops every held rate and share.
function kitsMoved() {
    const items = DataCache.items, revision = Sources.revision(), rates = ProgressionRates.profile();
    if (kitGuard && kitGuard[0] === items && kitGuard[1] === revision && kitGuard[2] === rates) return;
    kitGuard = [items, revision, rates];
    classShares.clear();
    kitItems = null;
    censusChanged();
}
function rows() { return [...[...history].map(([id, item]) => row(id, item)), ...census.values()]; }
function tradeRow(id) {
    return mirror ? mirror().get(`h:${id}`) : history.has(id) ? row(id, history.get(id)) : null;
}
function censusRow(key) { return mirror ? mirror().get(key) : census.get(key); }
// The exact census rate of an item per hour by town (town -> units) and the
// sum of its cells' revisions; read by the forecast and, summed, by the soft
// point's watch rows (censusOf, DecisionSections.marketCrossed). A class's
// table use (cellUse) is read again at the item's next census change. Gear
// on both threads from the same `d:` rows (main's own, the worker's mirror),
// so a crafter's forecast is one answer hot and cold (T74). Any other item:
// NONE.
function censusTowns(id) {
    const shot = ShotStock.gradedShopShot(id);
    if (!shot) kitsMoved();
    let sums = held.get(id);
    if (sums) return sums;
    sums = shot ? sumCensus(id) : gearRates().get(id) || NONE;
    held.set(id, sums);
    return sums;
}
// Hours a wearer of the class spends in a level grade's band: the band's exp
// over the exp per hour of its table role's best spot at the band level.
function bandHours(classId, levelGrade) {
    const exp = SpotValueTable.bandUse(BotRoles.tableRoleFor({ classId }), GRADE_SAMPLE_LEVEL[levelGrade]).exp;
    return exp > 0 ? bandExp(levelGrade) / exp : 0;
}
// Level grade -> exp from its band's first level to the next band (the last
// band ends at the table's last level); game data, once per thread.
let bandSpans = null;
function bandExp(levelGrade) {
    if (!bandSpans) {
        const table = DataCache.experience || [], first = new Map(), last = new Map();
        for (let level = 1; level <= table.length; level++) {
            const grade = gradeForLevel(level);
            if (!first.has(grade)) first.set(grade, level);
            last.set(grade, level);
        }
        bandSpans = new Map([...first].map(([grade, min]) =>
            [grade, Number(table[Math.min(last.get(grade), table.length - 1)]) - Number(table[min - 1])]));
    }
    return bandSpans.get(levelGrade) || 0;
}
// Every wished gear item's rate: per class and grade the wearers per hour who
// reach the grade's band (one level grade below) or sit in it below its grade,
// in the town of the item grade (itemTown), times the class's kit share.
function gearRates() {
    if (gearHeld) return gearHeld;
    gearHeld = new Map();
    const flows = new Map();
    let revision = 0;
    for (const [key, value] of mirror ? mirror() : census) {
        if (!String(key).startsWith('d:')) continue;
        const [, classText, , worn, levelGrade] = key.split(':');
        const classId = Number(classText), level = LEVEL_GRADES.indexOf(levelGrade);
        revision += Number(value[1]) || 0;
        const hours = level >= 0 ? bandHours(classId, levelGrade) : 0;
        if (!(hours > 0)) continue;
        for (const rank of [level + 1, level > 0 && LEVEL_GRADES.indexOf(worn) < level ? level : 0]) {
            if (rank < 1 || rank >= LEVEL_GRADES.length) continue;
            let flow = flows.get(`${classId}:${rank}`);
            if (!flow) flows.set(`${classId}:${rank}`, flow = { classId, rank, byTown: new Map() });
            for (let at = 2; at + 1 < value.length; at += 2) {
                const town = value[at + 1] > 0 && itemTown(LEVEL_GRADES[rank], value[at]);
                if (town) flow.byTown.set(town, (flow.byTown.get(town) || 0) + value[at + 1] / hours);
            }
        }
    }
    for (const { classId, rank, byTown } of flows.values()) {
        if (!byTown.size) continue;
        for (const [itemId, itemRank, units] of classShare(classId)) {
            if (itemRank !== rank) continue;
            let sums = gearHeld.get(itemId);
            if (!sums) gearHeld.set(itemId, sums = { byTown: new Map(), revision });
            for (const [town, rate] of byTown) sums.byTown.set(town, (sums.byTown.get(town) || 0) + rate * units);
        }
    }
    return gearHeld;
}
// A class's wished kit as units per wearer: a slot group (the weapon slots
// share one) splits each grade evenly over its items; a paired slot without
// its own kit (Equipment.pairedSlot) counts its kit twice.
function classShare(classId) {
    let share = classShares.get(classId);
    if (share) return share;
    // lazy: cycle GearAcquisitionPlanner loads the economy, which requires this file at load.
    const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
    const kits = BotGear.wishKitsFor(DataCache.items, Sources.revision(), classId,
        Planner.roleFor({ classId, stats: { classId } }), Planner, Sources);
    const groups = new Map();
    for (const [slot, kit] of kits) {
        const units = Equipment.pairedSlot(slot) && !kits.get(Equipment.pairedSlot(slot)) ? 2 : 1;
        for (let at = 0; at < kit.length; at++) {
            const group = `${Equipment.equipmentSlotKey(slot)}:${kit.rankAt(at)}`;
            if (!groups.has(group)) groups.set(group, []);
            groups.get(group).push([Number(kit.itemAt(at).selfId), kit.rankAt(at), units]);
        }
    }
    share = [];
    for (const list of groups.values()) for (const [itemId, rank, units] of list) share.push([itemId, rank, units / list.length]);
    classShares.set(classId, share);
    return share;
}
function sumCensus(id) {
    const byTown = new Map();
    let revision = 0;
    for (const cell of cellsOf(id)) {
        const value = censusRow(cell.key);
        if (!value) continue;
        revision += Number(value[1]) || 0;
        let use = -1;
        for (let at = 2; at + 1 < value.length; at += 2) {
            if (!(value[at + 1] > 0)) continue;
            if (use < 0) use = cellUse(cell);
            const town = use > 0 && itemTown(cell.grade, value[at]);
            if (town) byTown.set(town, (byTown.get(town) || 0) + value[at + 1] * use);
        }
    }
    return { byTown, revision };
}
// The dwarven products a craft level makes (their recipe's level at most
// it) that the census counts now: the crafter's wake row (EconomyContext)
// wakes when the count rises; the recipe index admits them (censusBuys).
function demanded() {
    kitsMoved();
    if (demandedNow) return demandedNow;
    const lowest = new Map(), products = new Set(), byLevel = new Uint16Array(10);
    for (const recipe of recipeCatalog().rows) {
        const id = Number(recipe.productId);
        if (!(lowest.get(id) <= recipe.level)) lowest.set(id, recipe.level);
    }
    for (const [id, level] of lowest) {
        if (!(censusOf(id) > 0)) continue;
        products.add(id);
        for (let at = level; at <= 9; at++) byLevel[at]++;
    }
    return demandedNow = { products, byLevel };
}
function demandedCount(level) {
    return demanded().byLevel[Math.max(0, Math.min(9, Math.floor(Number(level) || 0)))];
}
// Whether the census buys the product now (the recipe index's fixed buyer):
// a shot some class loads always, any other item while its census rate is
// above zero (its wearers or kit wishes).
function censusBuys(id) {
    id = Number(id);
    return ShotStock.gradedShopShot(id) ? hasCensusSource(id) : demanded().products.has(id);
}
// Whether the census can ever count the item: a shot some class loads or an
// item of some class's wished kit. Fixed game data.
function hasCensusSource(id) {
    id = Number(id);
    kitsMoved();
    if (ShotStock.gradedShopShot(id)) return cellsOf(id).length > 0;
    if (!kitItems) {
        kitItems = new Set();
        for (const template of DataCache.classTemplates || []) {
            for (const [itemId] of classShare(Number(template.classId))) kitItems.add(itemId);
        }
    }
    return kitItems.has(id);
}
// Whether a product sells to its census forecast only (T74; docs/game-decisions.md:
// a gear bid is no crafter signal): wished kit gear, not a shot (a shot's
// buyer lines still count) nor a material (its buyers are its bid lines).
function forecastOnly(id) {
    return !ShotStock.gradedShopShot(Number(id)) && hasCensusSource(id);
}
// The exact census rate of an item per hour over every town; null while no
// cell of it was ever put (main has not published since a restart), 0 once
// its last wearer left.
function censusOf(id) {
    const sums = censusTowns(Number(id));
    if (!sums.revision) return null;
    if (sums.total === undefined) {
        sums.total = 0;
        for (const value of sums.byTown.values()) sums.total += value;
    }
    return sums.total;
}
// Units per hour of the trade row in a town: the decayed units of an
// hour-long exponential window, read at `timestamp`.
function tradedIn(value, at, timestamp) {
    const decay = Math.exp(-Uptime.between(value[at + 3], timestamp) / HOUR_MS);
    const units = value[at + 1] * decay, arrivals = value[at + 2] * decay;
    return units >= 1 && arrivals >= .1 ? { units, arrivals } : null;
}
// The item's observed supply: units sold per hour over every town, the
// decayed units of the trade row's hour-long window read at `timestamp`,
// whatever their count (a rare piece's slow flow too: one deal an hour ago
// reads ~0.37/h); 0 with no trade row. The buy wait's rate
// (WishPurchaseEvidence.unitWait).
function supplyPerHour(id, timestamp = Date.now()) {
    const value = tradeRow(Number(id));
    let units = 0;
    for (let at = 2; value && at + 3 < value.length; at += 4)
        units += value[at + 1] * Math.exp(-Uptime.between(value[at + 3], timestamp) / HOUR_MS);
    return units > 0 ? units : 0;
}
// The deals that make a flow: one deal is no flow. The trade row counts once
// it holds them.
const FLOW_DEALS = 2;
function tradeEvidence(id) {
    const value = tradeRow(id);
    return value && value[1] >= FLOW_DEALS ? value : null;
}
function tradedTown(value, town, timestamp) {
    for (let at = 2; value && at + 3 < value.length; at += 4) if (value[at] === town) return tradedIn(value, at, timestamp);
    return null;
}
// The bot's stable read of the census: its market error for the item's
// counter, one roll per (bot, item), as PriceBelief.prior reads prices.
function perceived(id, ctx) {
    if (!ctx?.characterId || !(ctx.knowledgeEnabled ?? PriceLearning.knowledgeEnabled())) return 1;
    // lazy: cycle MarketCounters requires this file at load.
    const counter = invoke('GameServer/Bot/Economy/MarketCounters').counterOf(id);
    const experience = Math.max(0, Number(ctx.marketTrades?.[counter]) || 0);
    return 1 + (2 * TendencyRoll.roll('census', ctx.characterId, id) - 1)
        * PriceLearning.errorOf(ctx.understanding, experience, counter);
}
// A conservative half-hour (DELAY_HOURS) of the larger of the two hourly
// flows, per town; summed over the towns when no town is given. ctx:
// { characterId, understanding, marketTrades } of the reading bot, whose
// census read carries its error, and, for a producer read
// (`producer`: the id of a bot sizing goods it would make, never a holder
// selling goods in hand), less the units its rivals' plans in flight already
// commit to the product's listing in the town (CommittedExits; none
// without a town); without ctx, exact and whole.
const DELAY_HOURS = .5;
// Gross per hour of a sale that takes delayHours (a forecast's; a bid,
// static or NPC exit without one sells within DELAY_HOURS): the rank of a
// crafter's products, so a slow high-priced good does not crowd out a fast
// cheap one (WishProviders producer admission and finalists). A loss (value
// <= 0) ranks by its total, not per hour: a slow sale must not make it look
// smaller.
function perHour(value, delayHours) {
    return value > 0 ? value / Math.max(DELAY_HOURS, Number(delayHours) || DELAY_HOURS) : value;
}
function forecast(id, town = null, timestamp = Date.now(), ctx = null) {
    id = Number(id);
    const trades = tradeEvidence(id), counted = censusTowns(id);
    if (!trades && !counted?.byTown.size) return null;
    const scale = counted?.byTown.size ? perceived(id, ctx) : 1;
    let fromCensus = 0, fromTrades = 0, arrivals = 0;
    const add = (burn, traded) => {
        const units = traded?.units || 0;
        arrivals += traded?.arrivals || 0;
        if (burn > units) fromCensus += burn; else fromTrades += units;
    };
    if (town) add((counted?.byTown.get(town) || 0) * scale, tradedTown(trades, town, timestamp));
    else {
        for (const [where, burn] of counted?.byTown || []) add(burn * scale, tradedTown(trades, where, timestamp));
        for (let at = 2; trades && at + 3 < trades.length; at += 4)
            if (!counted?.byTown.has(trades[at])) add(0, tradedIn(trades, at, timestamp));
    }
    // The horizon: a half-hour of the world's rate, or as long as its first
    // unit takes when a half-hour holds less than one. Rivals' committed
    // units sell first; the reader's are the rest, its last one at the end
    // of the horizon.
    const rate = fromCensus + fromTrades;
    const worldUnits = rate > 0 ? Math.max(1, Math.floor(rate * DELAY_HOURS)) : 0;
    const rivals = worldUnits > 0 && ctx?.producer > 0 ? CommittedExits.rivalListingUnits(id, town, ctx.producer) : 0;
    const applicableUnits = worldUnits - rivals;
    if (rivals > 0 && applicableUnits <= 0) CommittedExits.refused();
    return applicableUnits > 0 ? { known: true, selfId: id, enchant: 0, town,
        origin: fromCensus > fromTrades ? 'census' : 'public_trades',
        // The trade revision only: census rows restart at 1 with every main
        // start, so a held exit (ColdShotEconomyService) compares deals.
        authority: { selfId: id, revision: trades?.[1] || 0 },
        applicableUnits, arrivalsPerHour: arrivals, delayHours: Math.max(DELAY_HOURS, worldUnits / rate),
        observedAt: timestamp, availability: { from: timestamp, until: timestamp },
        guaranteed: false, repeatable: false } : null;
}
function towns(id, timestamp = Date.now()) {
    id = Number(id);
    const trades = tradeEvidence(id), result = [];
    for (const [town, burn] of censusTowns(id).byTown) if (burn > 0) result.push(town);
    for (let at = 2; trades && at + 3 < trades.length; at += 4)
        if (!result.includes(trades[at]) && tradedIn(trades, at, timestamp)) result.push(trades[at]);
    return result;
}
// The board's replay reloads trade evidence; census rows stay with their owner.
function reset() { history.clear(); mirror = null; censusChanged(); }
module.exports = { DELAY_HOURS, deal, putCensus, censusChanged, rows, forecast, perHour, supplyPerHour, towns, reset, wornCell,
    censusOf, demandedCount, censusBuys, hasCensusSource, forecastOnly, warmUse, useTable: source => { mirror = source; censusChanged(); } };
