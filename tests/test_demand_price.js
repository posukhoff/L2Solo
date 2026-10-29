'use strict';
// The market's one demand price per item (DemandPrice, decisions 10-28): a
// wished piece, the parts of its recipe and the recipe's scroll are worth
// more than the NPC buy-back only while the census asks for more pieces than
// the board holds; trades and bids never move it; a hunter's spot values its
// loot by it (SpotValueTable.marketLoot), and no spot key keeps item rows.
const assert = require('assert');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Demand = invoke('GameServer/Bot/Economy/MarketDemand');
const DemandPrice = invoke('GameServer/Bot/Economy/DemandPrice');
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
const EconomyContext = invoke('GameServer/Bot/Economy/EconomyContext');
const Production = invoke('GameServer/Bot/Economy/RecipeProductionIndex');
const Profit = invoke('GameServer/Bot/Economy/CraftProfitPolicy');
const Price = invoke('GameServer/Bot/Economy/PriceDecision');
const Table = invoke('GameServer/Bot/AI/SpotValueTable');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const DataCache = invoke('GameServer/DataCache');
const { BoardIndex, SELL, BUY } = require('../src/GameServer/AfkTrade/BoardIndex');

const now = 1800000000000;
const town = 'Giran';
MarketCounters.reset();
Demand.reset();
const board = new BoardIndex({ groupOf: MarketCounters.counterOf });
EconomyContext.configure({ board });
// The world's spot catalog (a fixture of the game data): items drop
// somewhere, so a scroll's first price is its hunt within the NPC walls.
const catalog = JSON.parse(require('fs').readFileSync(require('path').resolve(__dirname, '../data/Bots/spot-reward-npcs.json'), 'utf8')).rows
    .map(([id, entries, adenaMin, adenaMax]) => ({ id, npcEntries: entries.map(([selfId, count]) => ({ selfId, count })), rewards: { adenaMin, adenaMax } }));
MarketCounters.useSpots(() => catalog);
invoke('GameServer/Bot/AI/SpotValueTable').useSpots(catalog);
let record = 0;
const list = (ownerId, storeType, selfId, count, price) => board.put({ id: ++record, ownerId, storeType, town,
    lines: [{ lineId: record, selfId, count, price }] });

// No census: every item at its buy-back.
const before = DemandPrice.revision();
const recipes = Production.recipeCatalog().rows;
assert(recipes.every(recipe => DemandPrice.premium(recipe.productId) === 0 && DemandPrice.premium(recipe.recipeItemId) === 0),
    'with no census nothing is worth more than its buy-back');

// Level 20-39 wearers in no grade: every class wants its D kit.
const classes = (DataCache.classTemplates || []).map(template => Number(template.classId));
const cells = classes.map(classId => `d:${classId}:w:none:d:0`);
for (const key of cells) Demand.putCensus(key, new Map([[town, 20]]));
const needed = Demand.neededGear();
assert(needed.size > 0, 'the census asks for D pieces');
const moved = DemandPrice.revision();
assert(moved !== before, 'a census publication moves the table');

// A wished piece of a dwarven recipe whose parts and scroll the demand prices.
let found = null;
for (const recipe of recipes) {
    const productId = Number(recipe.productId);
    if (!needed.has(productId)) continue;
    const parts = [...(Profit.requirements(recipe, 1) || new Map()).keys()].map(Number).filter(id => DemandPrice.premium(id) > 0);
    if (parts.length && DemandPrice.premium(recipe.recipeItemId) > 0) { found = { recipe, productId, part: parts[0] }; break; }
}
// The piece itself is worth its first price (the cheapest way to get it; a D
// piece's hunt is below the NPC buy-back, so it sits there).
assert(found, 'a wished piece prices one of its parts and its scroll above the buy-back');
const { recipe, productId, part } = found;
const scroll = Number(recipe.recipeItemId);
// A part costs no more than its own first price (making it or the NPC shop).
assert(DemandPrice.premium(part) <= MarketCounters.firstPrice(part, now) - Price.buyback(part) + 1e-9,
    'a part is capped by its own first price');
assert.strictEqual(DemandPrice.price(productId), Price.buyback(productId) + DemandPrice.premium(productId));
// The table leans an item toward what it costs to get, never past it: no
// scroll is worth its product's whole unmet craft wages (decisions 10-28:
// C/B scrolls stood at 10-58M on the shared worth).
const over = recipes.map(row => Number(row.recipeItemId)).filter(id => DemandPrice.premium(id)
    > Math.max(0, (Number(MarketCounters.firstPrice(id, now)) || 0) - Price.buyback(id)) + 1e-6);
assert.deepStrictEqual(over, [], 'every scroll stays under what it costs to get');
const scrollPremium = DemandPrice.premium(scroll), partPremium = DemandPrice.premium(part);

// Trades and bids are no hunter's signal: the table does not move.
MarketCounters.deal(part, 100 * Math.max(1, Price.buyback(part)), 5, now - 60000, 903);
list(904, BUY, part, 50, 100 * Math.max(1, Price.buyback(part)));
list(905, BUY, productId, 5, 1e8);
assert.strictEqual(DemandPrice.revision(), moved, 'a deal or a bid does not move the table');
assert.strictEqual(DemandPrice.premium(part), partPremium);

// A learner's bid for the scroll and a holder split the recipe's worth at
// the next census publication.
list(906, BUY, scroll, 1, 1);
DemandPrice.useHolders(id => Number(id) === Number(recipe.recipeId) ? 2 : 0);
Demand.putCensus(cells[0], new Map([[town, 21]]));
assert(DemandPrice.premium(scroll) + Price.buyback(scroll) < scrollPremium + Price.buyback(scroll),
    'holders and learners lower the recipe\'s worth');
DemandPrice.useHolders(null);

// The worth caps a learner's bid (decisions 10-28), not the scroll's price:
// deals far over it move the learner's belief, never the worth, and its bid
// stays at or under the worth (MarketPricing.bid's purchase cap).
{
    const Pricing = invoke('GameServer/Bot/Economy/MarketPricing');
    const worth = DemandPrice.recipeWorth(scroll);
    assert(worth > Price.buyback(scroll), 'the unmet crafts give the scroll a worth over its buy-back');
    assert.strictEqual(DemandPrice.recipeWorth(productId), null, 'a piece is no recipe scroll');
    // The learner with a BUY line (906) is not a second learner of its own
    // worth: its share is the one a newcomer gets once it bids.
    assert(DemandPrice.recipeWorth(scroll, 906) > worth, 'a learner\'s own line does not split its own worth');
    for (let at = 0; at < 10; at++) MarketCounters.deal(scroll, Math.round(10 * worth), 1, now - 1000 * at, 920 + at);
    assert.strictEqual(DemandPrice.recipeWorth(scroll), worth, 'deals do not move the worth');
    const learner = { characterId: 990310, activity: 'hunting', stats: {} };
    const ctx = { state: learner, characterId: learner.characterId, hour: 10000, adena: 1e9, board, timestamp: now,
        travelDetails: () => ({ known: true, hours: 0, fees: 0 }), npcOffersFor: () => [], understanding: 0.5,
        knowledgeEnabled: false, marketTrades: {}, trader: { wait: 0, assertiveness: 0.5, caution: 0.5 } };
    const belief = invoke('GameServer/Bot/Economy/PriceBelief').prior(scroll, ctx);
    assert(Math.exp(belief.mu) > 2 * worth, 'the deals lift the learner\'s belief far over the worth');
    const bid = Pricing.bid(scroll, ctx, { units: 1, worth: 100 * worth, cap: 100 * worth, town, money: 1e9, rollKey: ['learner'] });
    assert(bid, 'the learner bids');
    assert(bid.price <= worth && bid.purchaseCap <= worth, `the learner bids at most the recipe's worth (${bid.price} > ${worth})`);
    // A standing line over the worth (bid before the worth fell) is lowered
    // or withdrawn by the same cap (BidPurchaseAlternative.lineLimit: the
    // look's reprice and the cold plan's line limits).
    const Alternative = require('../src/GameServer/Bot/Economy/BidPurchaseAlternative');
    const limit = Alternative.lineLimit({ selfId: scroll, price: Math.round(2 * worth), count: 1, town, enchant: 0, custodyPolicy: 0 }, ctx);
    assert(limit !== null && limit <= worth, `a standing scroll bid over the worth is lowered or withdrawn (${limit})`);
}

// Pieces listed past the census's need: nothing unmet, every price at its buy-back.
list(907, SELL, productId, Math.ceil(needed.get(productId)) + 1, 1);
Demand.putCensus(cells[0], new Map([[town, 20]]));
assert.strictEqual(DemandPrice.premium(productId), 0, 'a piece the board covers is worth its buy-back');
assert.strictEqual(DemandPrice.premium(scroll), 0, 'its scroll too: no craft of it is unmet');

// Every recipe of a demanded product is worth its share, the 70% one beside
// the 100% one (C pieces: level 40-51 wearers in D).
const cCells = classes.map(classId => `d:${classId}:w:d:c:0`);
for (const key of cCells) Demand.putCensus(key, new Map([[town, 20]]));
const twins = recipes.filter(row => Demand.neededGear().has(Number(row.productId))
    && recipes.some(other => other !== row && Number(other.productId) === Number(row.productId)));
assert(twins.length > 0, 'a demanded C piece has two recipes');
assert(twins.some(row => Number(row.successRate) < 100 && DemandPrice.premium(row.recipeItemId) > 0),
    'a demanded piece\'s second recipe is worth its share too');

// Shots by their wearers' burn (cleanup 10-29: no farm root reads a shot
// crafter's bid any more): a burnt shot's recipe scroll gets a premium and a
// worth, the same table's two answers, and loses both with the burn. Its
// crystals have gear demand too, so they prove nothing here.
{
    const Shots = invoke('GameServer/Inventory/ShotStock');
    // D wearers in the D band who load their class's D shot (census cells
    // d:<class>:w:<worn>:<level grade>:<shot>).
    const shotCells = classes.map(classId => Number(Shots.planFor({ classId, rank: 'd' }).selfId))
        .map((shot, at) => Shots.gradedShopShot(shot) ? `d:${classes[at]}:w:d:d:${shot}` : null).filter(Boolean);
    const burnt = [...new Set(shotCells.map(key => Number(key.split(':').pop())))];
    const scrolls = recipes.filter(row => burnt.includes(Number(row.productId))).map(row => Number(row.recipeItemId));
    assert(scrolls.length > 0, 'a burnt D shot has a recipe');
    assert(scrolls.every(id => DemandPrice.premium(id) === 0), 'no burn, no shot scroll premium');
    for (const key of shotCells) Demand.putCensus(key, new Map([[town, 30]]));
    assert(burnt.every(id => Demand.censusOf(id) > 0), 'the D wearers burn their shots');
    assert(scrolls.some(id => DemandPrice.premium(id) > 0), 'a burnt shot\'s scroll is worth more than its buy-back');
    assert(DemandPrice.stats.shots > 0, 'the build counts its rooted shots');
    assert(scrolls.every(id => DemandPrice.recipeWorth(id, 0) !== null),
        'a shot scroll the hunter values is one the learner worth prices too');
    for (const key of shotCells) Demand.putCensus(key, new Map());
    assert(scrolls.every(id => DemandPrice.premium(id) === 0), 'the burn gone, the premium goes');
}

// The hunter: a spot whose kills drop or spoil a demanded item is worth more
// by it (marketLoot, summed again when the table moves); no demand, no premium.
{
    const Economics = invoke('GameServer/Bot/Economy/SpotEconomics');
    const hunter = { characterId: 990303, level: 50, adena: 3000, stats: { classId: 2, money: [3719, 0.0001, 1000, 900000] } };
    // Bounty Hunter (class 55) learns Spoil (skill 254) level 6 at level 49.
    const spoiler = { characterId: 990301, level: 50, adena: 3000, stats: { classId: 55, money: [3719, 0.0001, 1000, 900000],
        coldCombat: { classId: 55, skillSource: 'database', skills: [{ selfId: 254, level: 6 }] } } };
    const skill = invoke('GameServer/Bot/Population/ColdKillRewards').spoilLevelOf(spoiler);
    assert(skill > 0, 'a level 50 Bounty Hunter spoils');
    const role = invoke('GameServer/Bot/AI/BotRoles').tableRoleFor(hunter);
    const spots = JSON.parse(require('fs').readFileSync(require('path').resolve(__dirname, '../data/Bots/spot-reward-npcs.json'), 'utf8')).rows;
    const dropped = spots.find(([id]) => Table.marketLoot(id, role, 50, true, { spoilSkillLevel: 0 }) > 0)?.[0];
    assert(dropped, 'a spot drops an item the demand prices');
    const spoiled = spots.find(([id]) => Table.marketLoot(id, 'spoiler', 50, true, { spoilSkillLevel: skill })
        > Table.marketLoot(id, 'spoiler', 50, true, { spoilSkillLevel: 0 }))?.[0];
    assert(spoiled, 'a spot spoils an item the demand prices: a spoiler gets more of it');
    const saved = Config.knowledgeErrorsEnabled;
    try {
        Config.knowledgeErrorsEnabled = false;
        const options = { persona: { traits: {}, understanding: 0.5 }, deathHours: 0, moneyWeight: 1, timestamp: now };
        const value = Economics.create(hunter, options)({ id: dropped });
        const spoil = Economics.create(spoiler, options)({ id: spoiled });
        assert(value.loot > Table.value(dropped, role, 50, true, { spoilSkillLevel: 0 }).loot, 'the demanded loot raises the spot\'s loot');
        // The money spot shortlist ranks loot at the market price (T89 1e r);
        // rankedIncome, the bot's hour the first prices read, at the NPC's.
        const free = { shots: 0, potions: 0 };
        const marketIds = Table.rankedSpotIds(role, 50, free, -15);
        const hourIds = Table.rankedIncome(role, 50, free, -15).map(row => row.spotId);
        const priced = marketIds.find(id => Table.marketLoot(id, role, 50, true, { spoilSkillLevel: 0 }) > 0);
        assert(priced, 'a shortlisted spot drops a demanded item');
        // A farm source of a demanded drop: the item is the goal, not also
        // the farm hour's income (T89 1e f, GearAcquisitionPlanner sourceFacts).
        const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
        const weapon = DataCache.items.find(row => [7, 14].includes(Number(row.etc?.slot))
            && Planner.suitable(row, hunter, Planner.roleFor(hunter), String(row.etc?.rank || 'none')));
        const armed = { ...hunter, inventory: { [weapon.selfId]: { selfId: weapon.selfId, amount: 1, equipped: true,
            equippedCount: 1, slot: Number(weapon.etc.slot) } } };
        const drops = selfId => (DataCache.npcRewards.find(reward => Number(reward.selfId) === Number(selfId))?.rewards || [])
            .flatMap(group => group.items || []).map(row => Number(row.selfId));
        // The ready drop source of a demanded item at a spot the bot hunts, and
        // the farm hour's value left out of the spot's (null: none there).
        const farmAt = ([id, entries], item) => {
            const spot = { id, npcEntries: entries.map(([selfId, count]) => ({ selfId, count })) }, farmer = { ...armed, spotId: id };
            const reader = Economics.create(farmer, options);
            const iterator = Planner.sourceFacts(farmer, item, 10, { spots: [spot], spotValue: reader, routeAllowed: () => true, timestamp: now });
            let next;
            do next = iterator.next(); while (!next.done);
            const fact = next.value.find(row => row.status === 'ready' && row.kind === 'drop');
            return fact ? reader(spot).valueHours - fact.valueHours : null;
        };
        let farmRow = null, item = 0;
        for (const id of marketIds) {
            const row = spots.find(([spotId]) => spotId === id);
            if (!row || !(Table.marketLoot(id, role, 50, true, { spoilSkillLevel: 0 }) > 0)) continue;
            item = row[1].flatMap(([selfId]) => drops(selfId)).find(drop => DemandPrice.premium(drop) > 0
                && farmAt(row, drop) !== null) || 0;
            if (item) { farmRow = row; break; }
        }
        assert(farmRow, 'a spot the level-50 hunter farms drops a demanded item');
        const ownLoot = farmAt(farmRow, item);
        assert(ownLoot > 0, 'the farm hour gives back the spot\'s value but the item\'s own loot');
        // The census leaves: the loot falls back to the NPC price.
        for (const key of [...cells, ...cCells]) Demand.putCensus(key, new Map());
        assert(farmAt(farmRow, item) < ownLoot, 'the item\'s own loot left out carried its demand premium');
        const npcIds = Table.rankedSpotIds(role, 50, free, -15);
        assert.deepStrictEqual(hourIds, npcIds, 'the hour\'s shortlist keeps the NPC loot');
        assert.notDeepStrictEqual(marketIds, npcIds, 'the demand moves the money shortlist');
        const npcAt = npcIds.indexOf(priced);
        assert(npcAt < 0 || npcAt >= marketIds.indexOf(priced), 'a spot of a demanded drop ranks no lower by it');
        assert.strictEqual(Table.marketLoot(dropped, role, 50, true, { spoilSkillLevel: 0 }), 0, 'no demand, no premium');
        assert(Economics.create(hunter, options)({ id: dropped }).loot < value.loot, 'the hunter\'s spot loses its demand premium');
        assert(Economics.create(spoiler, options)({ id: spoiled }).loot < spoil.loot, 'the spoiler\'s too');
    } finally {
        Config.knowledgeErrorsEnabled = saved;
    }
}
EconomyContext.configure({});
console.log('demand price: ok');
