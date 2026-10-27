const Sources = require('../../Items/ItemAcquisitionCatalog');
const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const NpcShopPriceScale = require('../../World/Generics/NpcShopPriceScale');
const DataCache = invoke('GameServer/DataCache');
const ProgressionRates = invoke('GameServer/ProgressionRates');
const PriceDecision = require('./PriceDecision');
const CrystalCatalog = require('../../Knowledge/CrystalCatalog');
const BotMarketPricing = invoke('GameServer/Bot/Economy/BotMarketPricing');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const HuntEfficiency = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const SpotValueTable = invoke('GameServer/Bot/AI/SpotValueTable');
const C4RecipeItems = invoke('GameServer/Items/C4RecipeItems');

// The first price of an item nobody has traded yet (design 15.4): the
// cheapest way to hunt or make it. Hunted: the hours a bot hunts to obtain
// one times what an hour of bots of that level earns (Where, How long);
// made: Made below. Not below the NPC buy-back, not above the NPC price
// (withinWalls).
//
// Where (design: the best spot with the item): on every ordinary spot where
// a monster drops (or, for the spoiler, spoils) the item, items per hour =
// kills per hour from the spot table x the units one kill there yields
// (GearAcquisitionPlanner.sourcePerKill: the monster's loot table's share of
// the spot's kills x the expected amount per kill at the server's rate, the
// author's itemDropYield, with the deep-blue rule at the level the table
// rates the spot at; a spoil x the landing of that level's Spoil). The spot with the most items per hour wins; its level is the
// item's level.
//
// How long: the kills needed there, 1 / (share x amount per kill), at the
// kill rate of the bots of that level, the same bots whose hour prices the
// hour (BotHuntEfficiency.huntIncome). Their hour over their income per kill
// is their kills per hour, so hours x hour = kills needed x their income per
// kill. The table's own kill rate does not enter the hours: it is the bot in
// the author's planned kit, counted per hour of combat and recovery, several
// times the kill rate behind the bots' measured hour, and mixing the two
// would put every common drop at the buy-back.
//
// Made (group E, user 2026-10-05): a crafted item costs its materials (each
// at the NPC price when an NPC sells it, else at its own first price) plus
// the labour, the craft time (its MP over the seated MP regeneration of the
// lowest crafter able to make it) at that crafter's hour, over the recipe's
// success rate; a crystal costs the cheapest dropped gear of its grade per
// crystal it breaks into. The lowest of hunted, crafted and crystal wins (a
// tie keeps that order). An item with none of them: a no-grade shot the NPC
// price; anything else the NPC buy-back. Every price stays inside the NPC
// walls. Adena and items without a base price have none (null).
// Kills per hour of the roles able to hunt the spot alone, each at the
// level the table rates the spot at for it, and the mean of those levels.
function hunt(spotId, roles) {
    let kills = 0;
    let levels = 0;
    let count = 0;
    for (const role of roles) {
        const level = SpotValueTable.referenceLevel(spotId, role, true);
        const hour = level === null ? null : SpotValueTable.value(spotId, role, level, true);
        if (!hour) continue;
        kills += hour.kills;
        levels += level;
        count += 1;
    }
    return count ? { kills: kills / count, level: Math.round(levels / count) } : null;
}

function dropPrice(id, item, spots, timestamp) {
    let best = null;
    for (const source of GearAcquisitionPlanner.sourceIndexFor(spots).get(id) || []) {
        if (source.spot?.raidBoss === true) continue;
        const where = hunt(source.spot.id, source.kind === 'spoil' ? ['spoiler'] : SpotValueTable.roles());
        if (!where) continue;
        const { expectedYield } = GearAcquisitionPlanner.itemDropYield(source.reward, id, source.kind,
            { npcLevel: source.npcLevel, killerLevel: where.level });
        const spoiler = source.kind === 'spoil'
            ? { level: where.level, skillLevel: SpotValueTable.roleSpoilLevel('spoiler', where.level) } : null;
        const perKill = GearAcquisitionPlanner.sourcePerKill(source, Number(expectedYield || 0), spoiler);
        const perHour = where.kills * perKill;
        if (!(perHour > 0) || (best && perHour <= best.perHour)) continue;
        best = { perHour, perKill, level: where.level, spotId: source.spot.id, npcId: Number(source.reward.selfId), kind: source.kind };
    }
    if (!best) return null;
    const kills = 1 / best.perKill;
    const hour = HuntEfficiency.huntIncome({ level: best.level, stats: {} }, timestamp);
    return { price: withinWalls(item, kills * hour.perKill), kills, hours: kills * hour.perKill / hour.perHour,
        spotId: best.spotId, npcId: best.npcId, kind: best.kind, level: best.level, hourSource: hour.source, source: 'drop' };
}

// `made`: the price comes from making the item (a crafted one, a crystal), not
// from hunting it. The floor is the NPC buy-back for every item. The ceiling
// is the NPC shop price, and a made item has it only where an NPC sells it: the
// NPC is then the buyer's other source. A D+ shot or a crystal that no NPC
// sells has no ceiling (E91, user 2026-10-07: the market balances it); with
// the ceiling at the NPC price scaled by the rate, a D shot was clamped to 20
// while its cost is 58. A hunted item keeps the rate-scaled ceiling even when
// no NPC sells it: there it is no NPC price but a guard on the hunt estimate,
// which charges the whole hunting hour to one drop (lift it with that fix).
function withinWalls(item, price, { made = false } = {}) {
    const base = Number(item.template?.price || 0);
    if (base > 0) {
        const floor = PriceDecision.buyback(item.selfId);
        const open = made && !Number.isFinite(BotMarketPricing.npcPrice({ selfId: item.selfId }));
        const ceiling = open ? Infinity : NpcShopPriceScale.price(base, ProgressionRates.profile().multiplier);
        price = Math.min(ceiling, Math.max(floor, price));
    }
    return Math.max(1, Math.round(price));
}

// The lowest crafter level with each craft level (the dwarf lines: Dwarven
// Fighter, Artisan from 20, Warsmith from 40) and its seated MP per second,
// static tables built once.
let crafterLevels = null;
function crafterLevel(craftLevel) {
    if (!crafterLevels) {
        const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');
        crafterLevels = new Map();
        for (let level = 1; level <= 80; level++) {
            const found = CraftShopService.craftLevelFor({ classId: crafterClass(level), level });
            if (found && !crafterLevels.has(found)) crafterLevels.set(found, level);
        }
    }
    for (let wanted = Math.max(1, Number(craftLevel) || 1); wanted <= 10; wanted++) {
        if (crafterLevels.has(wanted)) return crafterLevels.get(wanted);
    }
    return null;
}
function crafterClass(level) {
    return level >= 40 ? 57 : level >= 20 ? 56 : 53;
}
const mpPerSecond = new Map();
function seatedMpPerSecond(level) {
    if (!mpPerSecond.has(level)) {
        const ms = invoke('GameServer/Bot/Population/ColdRest').estimateRestMs(
            { level, stats: { classId: crafterClass(level) } },
            { hp: 1000, maxHp: 1000, mp: 0, maxMp: 10000 }, { requireMana: true });
        mpPerSecond.set(level, 10000 / Math.max(1, ms / 1000));
    }
    return mpPerSecond.get(level);
}

const MAX_CRAFT_DEPTH = 5;
// The cheapest admitted recipe of the product (a product can have several:
// other chances, inputs and books; a tie keeps the data's order).
function craftPrice(id, item, options, depth) {
    let best = null;
    for (const recipe of C4RecipeItems.resolveVariantsByProductId(id)) {
        if (!Sources.allowsRecipe(recipe)) continue;
        if (depth >= MAX_CRAFT_DEPTH) {
            // Cut short: what is priced from here is no full price to keep.
            options.cut = true;
            return null;
        }
        const found = recipePrice(recipe, item, options, depth);
        if (found && (!best || found.price < best.price)) best = found;
    }
    return best;
}

function recipePrice(recipe, item, options, depth) {
    let materials = 0;
    for (const material of recipe.materials || []) {
        const npc = BotMarketPricing.npcPrice({ selfId: material.selfId });
        const unit = Number.isFinite(npc) ? npc : cachedFirstPrice(material.selfId, options, depth + 1);
        if (!(unit > 0)) return null;
        materials += unit * Number(material.amount || 0);
    }
    const level = crafterLevel(recipe.level);
    if (!level) return null;
    const seconds = Number(recipe.mpCost || 0) / seatedMpPerSecond(level);
    const hour = HuntEfficiency.huntIncome({ level, stats: {} }, options.timestamp);
    const labour = seconds / 3600 * hour.perHour;
    // A failed craft loses its materials and labour: one product costs the tries it takes.
    const perProduct = Math.max(1, Number(recipe.productCount || 1)) * Number(recipe.successRate) / 100;
    return { price: withinWalls(item, (materials + labour) / perProduct, { made: true }), materials: materials / perProduct,
        labour: labour / perProduct, crafterLevel: level, source: 'craft' };
}

// The gear that breaks into each crystal, with its crystal count: crystal
// selfId -> [{ gear, crystals }], the one crystallizable-gear catalogue
// (CrystalCatalog.byGrade) under the item sources, kept per Sources.revision.
let gearByCrystal = null;
let crystalRevision = -1;
function crystalSources(id) {
    const revision = Sources.revision();
    if (!gearByCrystal || crystalRevision !== revision) {
        crystalRevision = revision;
        gearByCrystal = new Map();
        for (const rows of CrystalCatalog.byGrade(DataCache.items).values()) for (const { gear, crystals, crystalId } of rows) {
            if (!Sources.hasSource(gear.selfId)) continue;
            if (!gearByCrystal.has(crystalId)) gearByCrystal.set(crystalId, []);
            gearByCrystal.get(crystalId).push({ gear, crystals });
        }
    }
    return gearByCrystal.get(id) || null;
}

function crystalPrice(id, item, options) {
    const sources = crystalSources(id);
    if (!sources) return null;
    let best = null;
    for (const { gear, crystals } of sources) {
        // The drop price, not the gear's first price: gear recipes consume the grade's crystals, pricing by craft would cycle.
        const drop = dropPrice(Number(gear.selfId), gear, options.spots, options.timestamp);
        if (!drop) continue;
        const unit = drop.price / crystals;
        if (!best || unit < best.unit) best = { unit, gearId: Number(gear.selfId) };
    }
    return best ? { price: withinWalls(item, best.unit, { made: true }), gearId: best.gearId, source: 'crystal' } : null;
}

// A shot of no grade, by the one item classifier (MarketCounters.counterOf).
function noGradeShotPrice(item) {
    if (invoke('GameServer/Bot/Economy/MarketCounters').counterOf(item.selfId) !== 'shot none') return null;
    const npc = BotMarketPricing.npcPrice(item);
    return Number.isFinite(npc) ? { price: Math.max(1, Math.round(npc)), source: 'npc' } : null;
}

function priceOf(id, options, depth) {
    const item = ItemTemplateIndex.find(DataCache.items, id);
    if (!Sources.hasSource(id) || !item || id === 57 || !(Number(item.template?.price) > 0)) return null;
    let best = null;
    for (const found of [dropPrice(id, item, options.spots, options.timestamp), craftPrice(id, item, options, depth), crystalPrice(id, item, options)]) {
        if (found && (!best || found.price < best.price)) best = found;
    }
    return best
        || noGradeShotPrice({ ...item, selfId: id })
        || { price: PriceDecision.buyback(id), source: 'buyback' };
}

// The first prices for the market's readers (PriceBelief, the counters' index)
// and of a recipe's materials, kept while their inputs hold: the item sources
// (Sources.revision), the spot table with its spot catalog
// (SpotValueTable.revision) and the NPC prices (BotMarketPricing.npcRevision).
// Rates and the reward catalog are restart inputs, not read here: the table
// sees them at its own next read, and the clan worker's rate switch arrives
// with its useNpcOfferSnapshot. The kill share of a source
// (SpotRewardExpectation.killShare) reads the spots and the NPC and reward
// tables the source index is built on (Sources.revision); a spoil's landing
// reads the skill table, a restart input too.
// The hunting hour of a price has no own samples, so it reads only the spot
// table under those same inputs. The spots a kept price is asked for are the
// thread's spot catalog, the one the spot table reads (MarketCounters and
// SpotValueTable get the same array on main and in the worker), so the table's
// revision stands for them; firstPrice keeps nothing of its own. A read at the
// top compares the three tokens; one moved drops every kept price and the next
// read of an id prices it again: no clock, a price moves only with its inputs.
// A price whose recipe chain was cut at MAX_CRAFT_DEPTH (deep inside another
// item's materials) is used there but not kept: the item's own price, asked at
// the top, prices its whole chain.
const cache = new Map();
let keptSources = null, keptTable = null, keptNpc = null;
// Moves whenever the kept prices are dropped: a reader that holds values
// made of first prices (RecipeProductionIndex market facts) compares it.
let generation = 0;
function keepFor() {
    const sources = Sources.revision(), table = SpotValueTable.revision(), npc = BotMarketPricing.npcRevision();
    if (sources === keptSources && table === keptTable && npc === keptNpc) return;
    keptSources = sources; keptTable = table; keptNpc = npc;
    cache.clear(); generation++;
}
function revision() { keepFor(); return generation; }

function firstPrice(itemId, { spots = [], timestamp = Date.now() } = {}) {
    keepFor();
    return priceOf(Number(itemId), { spots, timestamp }, 0);
}

// depth > 0: a material of a price being made, whose entry already checked the tokens.
function cachedFirstPrice(itemId, options = {}, depth = 0) {
    if (depth === 0) keepFor();
    const id = Number(itemId);
    // priceOf admits the source; an item without one is kept as a null price (undefined: not kept).
    const held = cache.get(id);
    if (held !== undefined) return held;
    const own = { spots: options.spots || [], timestamp: Number(options.timestamp || Date.now()), cut: false };
    const value = priceOf(id, own, depth)?.price ?? null;
    if (own.cut) options.cut = true;
    else cache.set(id, value);
    return value;
}

module.exports = { firstPrice, cachedFirstPrice, revision, resetCache() { cache.clear(); generation++; } };
