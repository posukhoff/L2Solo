// Native providers/network with controlled gear/recipe facts and an actual board.
// Source evidence is the same shared reader as production, no live DB.
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
require('../src/Global');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const root = path.resolve(__dirname, '../src/GameServer/Bot/Economy');
function load(file, requireAdapter, invokeAdapter = () => { throw Error('unexpected invoke'); }) {
    const module = { exports: {} };
    new Function('require', 'invoke', 'module', 'exports', fs.readFileSync(path.join(root, file), 'utf8'))(
        requireAdapter, invokeAdapter, module, module.exports);
    return module.exports;
}
const item = { selfId: 101, etc: { slot: 7 }, template: { price: 100, kind: 'Armor.Chest' } };
const recipe = { recipeId: 301, productId: 101, productCount: 1, recipeItemId: 401,
    mpCost: 1, successRate: 100, materials: [{ selfId: 202, amount: 10 }] };
const state = { characterId: 1, level: 40, craftLevel: 1, inventory: {}, stats: { recipes: [301] },
    activity: 'shopping', currentRegion: 'Giran', loc: { locX: 81100, locY: 148000, locZ: -3466 } };
const board = new BoardIndex();
const persona = { primaryDrive: 'progression', understanding: 1,
    traits: { commitment: 0, caution: 0, ambition: 0 } };
let allowCraft = false, ownCraft = true;
const adapters = {
    'GameServer/DataCache': { items: [item] },
    'GameServer/Progression/ProgressionCap': { effectiveLevelCap: () => 40 },
    'GameServer/Bot/AI/KnowledgeLearning': { stages: () => [{ grade: 'c', maxLevel: 51 }], gradeOfLevel: () => 'c' },
    'GameServer/Bot/AI/BotGear': { wishKitsFor: require('../src/GameServer/Bot/AI/BotGear').wishKitsFor },
    'GameServer/Bot/AI/GearAcquisitionPlanner': { sourceGround: () => null, sourceRouteReader: () => () => true, roleFor: () => 'melee', gradeForLevel: () => 'c',
        suitable: () => true, considerable: () => true, itemScore: () => 1, withReadiness: fn => fn() },
    'GameServer/Bot/Population/ColdCombatProfile': { candidateProfiles: () => ({
        before: { pAtk: 100, pDef: 100, mDef: 100 }, after: () => ({ pAtk: 200, pDef: 100, mDef: 100 }) }) },
    'GameServer/Bot/Economy/BotImprovementPolicy': { opportunities: () => [], crystalPath: () => null },
    'GameServer/Items/C4RecipeItems': { resolveVariantsByProductId: id => allowCraft && id === 101 ? [recipe] : [], resolveByRecipeId: id => id === 301 ? recipe : null },
    'GameServer/Items/C4DualSwordCombinations': { resolveByProductId: () => null, resolveByRecipeId: () => null },
    'GameServer/Items/SoulCrystalProgression': require('../src/GameServer/Items/SoulCrystalProgression'),
    'GameServer/Bot/Economy/CraftShopService': { canCraft: () => ownCraft,
        marketProducer: state => invoke('GameServer/Bot/Economy/CraftEligibility').marketProducer(state) },
    'GameServer/Skills/SkillBookCatalog': { missingBooks: () => [] },
    'GameServer/Bot/Economy/MarketCounters': { moveOf: () => 0, counterOf: () => 'armor c' },
    'GameServer/Bot/Economy/ItemDisposition': { saleCandidates: () => [] },
    'GameServer/Inventory/ShotStock': { keptAmounts: () => ({}), gradedShopShot: () => false },
    'GameServer/Bot/AI/HealingPotionStock': { keptAmounts: () => ({}) },
    'GameServer/Bot/Travel/ScrollStock': { keptAmounts: () => ({}) }
};
// Liquidation funding reads the shared sale and kept-stock readers (f75b6525); this
// fixture sells nothing, so no inventory row is a sale candidate.
Object.assign(adapters, { 'GameServer/Bot/Economy/PersonalWarehouseIndex': { saleState: state => state },
    'GameServer/Bot/Economy/ItemDisposition': { saleCandidates: () => [], reservedEquipmentAmounts: () => ({}) },
    'GameServer/Inventory/ShotStock': { keptAmounts: () => ({}), gradedShopShot: () => false },
    'GameServer/Bot/AI/HealingPotionStock': { keptAmounts: () => ({}) },
    'GameServer/Bot/Travel/ScrollStock': { keptAmounts: () => ({}) } });
// Task 2 readers: MP per hour, combat profile and spoil
// eligibility come from their own modules (one reader each).
Object.assign(adapters, {
    'GameServer/Bot/Population/ColdOccupationSources': {
        craftLabour: state => ({ executor: state.phase === 'hot' ? 'hot' : 'cold', mpCapacity: 1000, mpPerHour: 120000 }) },
    'GameServer/Bot/Population/ColdKillRewards': { spoilerFor: () => false } });
adapters['GameServer/Bot/Population/ColdCombatProfile'].profileFor = () => ({ maxMp: 1000 });
// The farm path reads Planner.sourceFacts (its hunt rules are pinned in
// test_source_facts.js); this stand-in maps the fixture's index rows by
// the same reasons: raid, spoil skill, solo safety. As the planner does
// with options.readyOnly, a refusal is only counted (options.counts), not returned.
adapters['GameServer/Bot/AI/GearAcquisitionPlanner'].sourceFacts = function* (state, itemId, units, options) {
    const planner = adapters['GameServer/Bot/AI/GearAcquisitionPlanner'];
    const rows = planner.sourceIndexFor?.(options.spots)?.get(Number(itemId)) || [];
    const counted = fact => { options.counts?.set(fact.reason || 'ready', (options.counts.get(fact.reason || 'ready') || 0) + 1); return fact; };
    return rows.map(entry => counted((() => {
        const reason = entry.spot.raidBoss ? 'raid' : entry.kind === 'spoil' && !options.spoiler ? 'spoil_skill'
            : !planner.soloSafeForSource() ? 'party_needed' : null;
        const perHour = Number(options.spotValue(entry.spot)?.kills || 0) * planner.sourceYieldReaderFor()().expectedYield;
        return { kind: entry.kind, spotId: entry.spot.id, npcId: entry.reward?.selfId, itemId: Number(itemId), units,
            status: reason ? 'ineligible' : 'ready', reason, perHour, hours: units / perHour, netHourCost: 1 };
    })())).filter(fact => !(options.readyOnly || options.counts) || fact.status === 'ready');
};
const invokeAdapter = name => { assert(name in adapters, name); return adapters[name]; };
const valuation = load('EconomicValuation.js', name => require(path.resolve(root, name)), invokeAdapter);
const tendency = { MIN: 0.02, roll: () => 0.5 };
const network = load('WishNetwork.js', name => {
    // WishNetwork reads the thread kind (c3a6771d); this fixture is the main thread.
    if (name === 'node:worker_threads') return require('node:worker_threads');
    if (name === './EconomyDiagnostics') return { active: () => false };
    if (name === './PurchaseFunding') return require('../src/GameServer/Bot/Economy/PurchaseFunding');
    if (name === './TradeIntent') return require('../src/GameServer/Bot/Economy/TradeIntent');
    if (name === './CompactBytes') return require('../src/GameServer/Bot/Economy/CompactBytes');
    if (name === './EconomicValuation') return valuation;
    if (name.endsWith('TendencyRoll')) return tendency;
    if (name.endsWith('Fnv1a')) return { fnv1a32: () => 1 };
    throw Error(name);
});
let supported = true;
// A gear gap the bot must close (PersonalGearProgression.assess): its earning roots fund it.
let progressionRequired = false;
// The progression priority of every gear item (PersonalGearProgression.priority).
let gearPriority = 0;
// Recipe scrolls with no non-raid source (every other origin is admitted).
const sourceless = new Set();
// A listing exit (a forecast of public sales) is set only by the recipe
// learning case below; every other case sells to bids.
let listingDemand = null, listingExits = [];
const realDemand = require('../src/GameServer/Bot/Economy/MarketDemand');
const marketDemand = { ...realDemand, forecast: (...args) => listingDemand || realDemand.forecast(...args) };
adapters['GameServer/Items/NpcSellRules'] = { npcBuyPrice: () => 0 };
adapters['GameServer/Bot/Economy/PriceBelief'] = { prior: () => ({ mu: Math.log(100) }), sigma: () => 0.3 };
const nativePrice = load('PriceDecision.js', name => require(path.resolve(root, name)), invokeAdapter);
const producerPrice = { ...nativePrice, bidSale: (...args) => supported ? nativePrice.bidSale(...args) : { status: 'unknown' } };
const provider = load('WishProviders.js' , name => {
    if (name === '../../Items/SoulCrystalProgression') return adapters['GameServer/Items/SoulCrystalProgression'];
    if (name === '../../Items/C4DualSwordCombinations') return adapters['GameServer/Items/C4DualSwordCombinations'];
    if (name === './PurchaseFunding') return require('../src/GameServer/Bot/Economy/PurchaseFunding');
    // Admitted synthetic origins (a missing recipe is never admitted, as in the real
    // catalogue) and the shared equipment rule (82e5323c, d300b1b7).
    if (name.endsWith('ItemAcquisitionCatalog')) return { revision: () => 1, hasSource: () => true,
        hasNonRaidSource: id => !sourceless.has(Number(id)), allowsRecipe: recipe => !!recipe };
    if (name === '../AI/PersonalGearProgression') return {
        assess: () => ({ required: progressionRequired, gaps: new Map() }),
        isCGradeHelmet: require('../src/GameServer/Bot/AI/PersonalGearProgression').isCGradeHelmet,
        preparation: () => null, priority: () => gearPriority, personal: () => false, allowsCGradeAcquisition: () => false };
    if (name === './BotLuxuryExchange') return { recipes: () => new Map() };
    if (name === '../AI/BotEquipmentCompatibility') return require('../src/GameServer/Bot/AI/BotEquipmentCompatibility');
    if (name === '../../Item/ItemTemplateIndex') return require('../src/GameServer/Item/ItemTemplateIndex');
    if (name === './PriceDecision') return producerPrice;
    if (name === './CraftProfitPolicy') return require('../src/GameServer/Bot/Economy/CraftProfitPolicy');
    if (name === './MarketDemand') return marketDemand;
    if (name === './EconomyDiagnostics') return { active: () => false, laps: () => null };
    if (name === './EconomicValuation') return valuation;
    if (name === './WishNetwork') return network;
    if (name.endsWith('BoardIndex')) return { SELL: 1 };
    if (name.endsWith('ItemTemplateIndex')) return require('../src/GameServer/Item/ItemTemplateIndex');
    if (name === './BotImprovementPolicy') return { isCaster: () => false };
    if (name === './WishPurchaseEvidence') return require('../src/GameServer/Bot/Economy/WishPurchaseEvidence');
    if (name === './ShotSalePolicy') return { exits: function* () { yield 'exit'; return listingExits.map(row => ({ ...row })); } };
    if (name === './WealthCraftPolicy') return require('../src/GameServer/Bot/Economy/WealthCraftPolicy');
    if (name === './ShotCraftPolicy') return require('../src/GameServer/Bot/Economy/ShotCraftPolicy');
    // The learner takes every scroll here (ItemDisposition.recipeDisposition is not under test).
    if (name === './WealthCraftDecision') return { freeAmount: (state, row) => Number(row.amount || 0), learnsRecipe: () => true };
    if (name === './BotCrystallization') return require('../src/GameServer/Bot/Economy/BotCrystallization');
    if (name === '../../Items/C4EnchantRules') return require('../src/GameServer/Items/C4EnchantRules');
    throw Error(name);
}, invokeAdapter);
const context = { timestamp: 1, persona, board, hunt: { perHour: 100, expPerHour: 0 }, deathHours: 0,
    price: id => id === 101 ? 100 : 1, buyback: () => 0,
    stock: () => ({ itemId: 900, missing: 0 }), spotValue: () => ({}) };
const preparedTrip = town => town === 'Giran' ? 0 : Infinity;
preparedTrip.details = town => ({ known: town === 'Giran', hours: 0, fees: 0 });
context.trip = preparedTrip;

const intent = require('../src/GameServer/Bot/Economy/TradeIntent');
adapters['GameServer/Bot/AI/GearAcquisitionPlanner'].considerable = () => false;
context.hourAdena = 100;
allowCraft = true;
state.adena = 1000;
state.phase = 'cold';
function put(id, itemId, count, price, side = 1, ownerId = 2) {
    board.put({ id, ownerId, storeType: side, town: 'Giran', revision: 1,
        kind: side === 3 ? 'buy_ad' : 'sell', custodyPolicy: side === 3 ? 1 : 0,
        lines: [{ lineId: id, selfId: itemId, count, price, enchant: 0 }] });
}
put(20, 101, 1, 100, 3);
put(21, 202, 4, 1);
function prepare({ wallet = 1000, reserve = 0, deps = {} } = {}) {
    const projection = provider.build(state, context, { board, knownRecipes: [301], ...deps });
    const result = buildNetwork(projection, wallet, reserve);
    return { projection, result, watch: intent.project(state, result, projection) };
}
function buildNetwork(projection, wallet = 1000, reserve = 0) {
    return new network.WishNetwork().build({ actorKey: 'producer:1', inputKey: 'producer',
        ...projection, characterId: 1, wallet, survivalReserve: reserve, hourAdena: 100, persona, remembered: false,
        stockFor: id => ({ owned: Math.max(0, Number(state.inventory[id]?.amount || 0) - Number(state.inventory[id]?.protectedAmount || 0)),
            incoming: Number(state.acceptedIncoming?.[id] || 0) }) });
}
const serviceCraft = adapters['GameServer/Bot/Economy/CraftShopService'];
state.craftLevel = 0;
assert(!prepare().projection.roots.includes('resale:101'), 'fighter common craft cannot create an unsupported producer purchase path');
state.craftLevel = 1;
state.stats.craftStationId = 'fixed';
assert(!prepare().projection.roots.includes('resale:101'), 'stationary crafter is outside autonomous producer nomination');
delete state.stats.craftStationId;
state.accountName = 'bot_craft_1';
assert(!prepare().projection.roots.includes('resale:101'), 'stationary service account cannot nominate autonomous production');
delete state.accountName;
let prepared = prepare();
let rootWish = prepared.result.queue.find(row => row.key === 'resale:101');
assert(rootWish, 'conditional public interest creates a finite producer goal before whole ingredient supply');
assert.equal(rootWish.plan.kind, 'craft');
assert.equal(rootWish.plan.batches, 1);
assert.equal(rootWish.plan.executable, false);
assert.deepEqual(prepared.watch.map(row => [row.itemId, row.amount, row.recipeId]), [[202, 10, 301]],
    'material demand is retained; finished product never becomes preparatory BUY');
assert.equal(prepared.result.activity.activity, 'shopping');
assert.equal(prepared.result.activity.amount, 4, 'only finite available material supply executes');
assert.equal(prepared.projection.moneyPaths.some(path => path.kind === 'production'), false);
assert.equal(prepared.result.hourAdena, 100);
// Unpriced interest (the bot's own WTB signal) creates no money and no
// revenue: the producer root keeps the value of the priced bids alone.
const producerValue = () => prepare().projection.nodes.find(row => row.key === 'resale:101')?.valueHours;
const unpriced = producerValue();
state.stats.marketWanted = { itemId: 101, itemName: 'product', lastTradeAdAt: 1, lastMissingAt: 1 };
assert(unpriced > 0);
assert.equal(producerValue(), unpriced, 'an own wanted signal does not change the producer root value');
delete state.stats.marketWanted;
// An unbacked bid line (custody 1) takes its full count: a producer facing a
// 29-unit line with buyable inputs plans the 29 units, not one trial lot.
const varnish = { recipeId: 35, productId: 1887, productCount: 1, recipeItemId: 1804,
    mpCost: 1, successRate: 100, materials: [{ selfId: 1864, amount: 3 }] };
put(40, 1887, 29, 29227, 3); put(41, 1864, 200, 1);
prepared = prepare({ deps: { knownRecipes: [301, 35], producerRecipes: [varnish] } });
assert.equal(prepared.projection.nodes.find(row => row.key === 'resale:1887')?.object.amount, 29,
    'an unbacked bid line sizes the producer root at its full count');
assert(prepared.result.queue.some(row => row.key === 'resale:1887'), 'the network keeps the bid-sized producer root');
// The line takes from this producer only what a cheaper foreign ask and its
// own held unit leave: 29 - 1 - 1 = 27 units, no inputs bought for the rest.
put(42, 1887, 1, 4050, 1, 4);
state.inventory[1887] = { selfId: 1887, amount: 1 };
prepared = prepare({ deps: { knownRecipes: [301, 35], producerRecipes: [varnish] } });
assert.equal(prepared.projection.nodes.find(row => row.key === 'resale:1887')?.object.amount, 27,
    'a bid exit is sized past cheaper asks and the units already held');
board.remove(42); delete state.inventory[1887];
board.remove(40); board.remove(41);
supported = false;
assert(!prepare().projection.roots.includes('resale:101'), 'an unsupported conditional forecast admits no production');
supported = true;
state.inventory[101] = { selfId: 101, amount: 1 };
assert(!prepare().projection.roots.includes('resale:101'), 'owned output exhausts the finite snapshot demand');
const originalBuyback = context.buyback;
context.buyback = () => 100;
assert(!prepare().projection.roots.includes('resale:101'), 'a profitable NPC residual cannot renew exhausted conditional interest');
context.buyback = originalBuyback;
delete state.inventory[101];
put(22, 101, 1, 100, 1, 1);
assert(!prepare().projection.roots.includes('resale:101'), 'backed own SELL output participates in the same finite cap');
board.remove(22);
state.acceptedIncoming = { 101: 1 };
assert(!prepare().projection.roots.includes('resale:101'), 'actual accepted incoming output also consumes remaining demand');
state.acceptedIncoming = { 202: 2 };
state.inventory[202] = { selfId: 202, amount: 4, protectedAmount: 2 };
prepared = prepare();
assert.equal(prepared.watch[0].amount, 6, 'incoming/free materials are allocated once; protected stock is unavailable');
delete state.inventory[202]; delete state.acceptedIncoming;
prepared = prepare({ wallet: 9, reserve: 5 });
assert.equal(prepared.result.queue.find(row => row.key === 'resale:101').funded, false);
assert.notEqual(prepared.result.activity?.activity, 'shopping', 'survival reserve cannot fund production purchases');
put(23, 401, 1, 1);
prepared = prepare({ deps: { knownRecipes: [], producerRecipes: [recipe] } });
rootWish = prepared.result.queue.find(row => row.key === 'resale:101');
assert(rootWish?.plan.requiresRecipeLearning, 'an unknown indexed recipe joins the preparation');
assert(prepared.watch.some(row => row.itemId === 401 && row.amount === 1), 'physical recipe scroll gets one requirement');
board.remove(23);
const planner = adapters['GameServer/Bot/AI/GearAcquisitionPlanner'];
planner.sourceIndexFor = () => new Map([[401, [{ kind: 'drop',
    spot: { id: 'scroll-source' }, reward: { selfId: 501 } }]]]);
planner.sourceYieldReaderFor = () => () => ({ expectedYield: 1 });
planner.soloSafeForSource = () => true;
context.spotValue = () => ({ kills: 1000 });
prepared = prepare({ deps: { knownRecipes: [], producerRecipes: [recipe], spots: [{}] } });
// A scroll nobody sells that drops on a ready spot: the producer farms it
// when the farm costs less than the scroll at its price (user 2026-10-24).
assert(prepared.projection.roots.includes('resale:101'), 'a scroll that only drops admits its producer');
const scrollPlan = prepared.result.queue.find(row => row.key === 'resale:101').plan.requirements.find(row => row.key === 'item:401')?.plan;
assert.equal(scrollPlan?.activity, 'hunting', 'the producer farms the scroll the farm pays for');
assert(!prepared.watch.some(row => row.itemId === 401), 'a scroll the producer farms gets no bid');
// R3: inputs that net a gain at their price (10 x 5 < bid 100) admit the
// producer; the network then acquires them by the cheapest path (a farm here).
board.remove(21);
const priorPrice = context.price;
context.price = id => id === 202 ? 5 : priorPrice(id);
planner.sourceIndexFor = () => new Map([[202, [{ kind: 'drop',
    spot: { id: 'material-source' }, reward: { selfId: 502 } }]]]);
prepared = prepare({ deps: { spots: [{}] } });
assert(prepared.projection.roots.includes('resale:101'), 'inputs that net a gain at their price admit the producer');
assert.equal(prepared.result.activity?.activity, 'hunting', 'the shared graph chooses the cheap physical material source');
assert.equal(prepared.result.activity?.itemId, 202);
assert.equal(prepared.result.plans.get('resale:101').price, 0,
    'real farm acquisition has no imaginary input cash charge');
// Inputs dearer than the sale: admission nets them at their price (R3), no producer root and no material BUY.
const farm = planner.sourceIndexFor;
planner.sourceIndexFor = () => new Map();
context.price = id => id === 202 ? 10000 : priorPrice(id);
put(21, 202, 10, 10000);
prepared = prepare();
assert(!prepared.projection.roots.includes('resale:101'), 'a sale whose inputs cost more is no producer root');
assert(!prepared.watch.some(row => row.itemId === 202), 'a rejected production path creates no material BUY');
board.remove(21);
planner.sourceIndexFor = farm;
context.price = priorPrice;
const originalTrip = context.trip;
const distantTrip = town => town === 'Giran' ? 205 : Infinity;
distantTrip.details = town => ({ known: town === 'Giran', hours: 2, fees: 5 });
context.trip = distantTrip;
prepared = prepare({ deps: { spots: [{}] } });
const salePath = prepared.result.plans.get('resale:101');
assert.equal(salePath.price, 5, 'sale travel fees enter the same cash path once');
assert.equal(salePath.tripEntries.length, 1);
assert(salePath.effort >= 2, 'the future selling trip remains part of production effort');
assert(!prepared.watch.some(row => row.key === 'resale:101'), 'an unprofitable remote sale cannot fund material acquisition');
put(21, 202, 10, 1);
prepared = prepare();
assert.equal(prepared.result.plans.get('resale:101').price, 15, 'buy and sale in one town share their route fee');
assert.equal(prepared.result.plans.get('resale:101').tripEntries.length, 1);
context.trip = originalTrip;
put(24, 101, 1, 1);
assert(!prepare().projection.roots.includes('resale:101'), 'cheaper competitive output exhausts the finite remaining interest');
board.remove(24); board.remove(20);
assert(!prepare().projection.roots.includes('resale:101'), 'withdrawn public demand retires production preparation');
// Admission ranks by net rate (R3): the exit (head bid or forecast price)
// less the inputs and the scroll at their price. NPC buyback alone is no
// exit (it only values the units a bid leaves): it takes no priced place.
put(20, 101, 1, 100, 3);
const npcOnly = Array.from({ length: 12 }, (_, at) => ({ recipeId: 320 + at, productId: 120 + at, productCount: 1,
    recipeItemId: 420 + at, mpCost: 1, successRate: 100, materials: [{ selfId: 202, amount: 1 }] }));
context.buyback = id => id >= 120 && id < 132 ? 1000 : 0;
let roots = prepare({ deps: { knownRecipes: [301, ...npcOnly.map(row => row.recipeId)], producerRecipes: npcOnly } }).projection.roots;
assert(roots.includes('resale:101'), 'rows with only an NPC buyback leave the priced places to a bid exit');
context.buyback = originalBuyback;
const dear = { recipeId: 302, productId: 102, productCount: 1, recipeItemId: 402, mpCost: 1, successRate: 100,
    materials: [{ selfId: 203, amount: 1 }] };
put(30, 102, 1, 1000, 3); put(31, 203, 1, 5000);
context.price = id => id === 203 ? 5000 : priorPrice(id);
roots = prepare({ deps: { knownRecipes: [301, 302], producerRecipes: [dear] } }).projection.roots;
assert(roots.includes('resale:101') && !roots.includes('resale:102'), 'the higher gross that nets a loss yields to the net gain');
context.price = priorPrice; board.remove(30); board.remove(31);
// A recipe whose scroll is neither known, held, sold nor sourced is no candidate: it takes no finalist place.
const unlearnable = [103, 104, 105].map(id => ({ recipeId: id + 200, productId: id, productCount: 1, recipeItemId: id + 300,
    mpCost: 1, successRate: 100, materials: [{ selfId: 202, amount: 1 }] }));
for (const row of unlearnable) { sourceless.add(row.recipeItemId); put(row.productId + 200, row.productId, 1, 1000, 3); }
roots = prepare({ deps: { producerRecipes: unlearnable } }).projection.roots;
assert(roots.includes('resale:101') && !roots.some(key => ['resale:103', 'resale:104', 'resale:105'].includes(key)),
    'a recipe the bot cannot learn leaves the finalists to one it can craft');
for (const row of unlearnable) { sourceless.delete(row.recipeItemId); board.remove(row.productId + 200); }
// A higher net whose scroll nobody sells and no ready spot drops: the
// producer bids for the scroll at its share of the recipe's worth (user
// 2026-10-24) beside the known recipe; another bot's ask makes it a buy
// (the step crafts the known one first: WealthCraftDecision.producerStep
// takes an unknown recipe only with its scroll held).
const dropOnly = { recipeId: 303, productId: 106, productCount: 1, recipeItemId: 403, mpCost: 1, successRate: 100,
    materials: [{ selfId: 202, amount: 1 }] };
put(32, 106, 1, 1000, 3);
prepared = prepare({ deps: { producerRecipes: [dropOnly] } });
assert(['resale:101', 'resale:106'].every(key => prepared.projection.roots.includes(key)), 'a scroll nobody sells admits its producer beside the known recipe');
assert(prepared.watch.find(row => row.itemId === 403)?.worth > 0, 'the producer bids for the scroll nobody sells');
put(33, 403, 1, 10);
prepared = prepare({ deps: { producerRecipes: [dropOnly] } });
assert(['resale:101', 'resale:106'].every(key => prepared.projection.roots.includes(key)), "another bot's ask for the scroll makes both producers");
assert(!prepared.result.queue.find(row => row.key === 'resale:101').plan.requiresRecipeLearning
    && prepared.result.queue.find(row => row.key === 'resale:106').plan.requiresRecipeLearning, 'only the unknown recipe waits for its scroll');
board.remove(32); board.remove(33);
// The producer places count the recipes the bot can craft now: four
// higher-net unknown recipes whose scrolls another bot sells take one place,
// the best by net, and leave the known recipe a producer the step crafts
// (recipeReady, WishProviders scrollSource; WealthCraftDecision.producerStep).
const scrollHunt = [141, 142, 143, 144].map(id => ({ recipeId: id + 200, productId: id, productCount: 1, recipeItemId: id + 300,
    mpCost: 1, successRate: 100, materials: [{ selfId: 202, amount: 1 }] }));
scrollHunt.forEach((row, at) => { put(row.productId + 200, row.productId, 1, 5000 + at * 1000, 3); put(row.productId + 300, row.recipeItemId, 1, 10); });
prepared = prepare({ deps: { producerRecipes: scrollHunt } });
assert.deepEqual(prepared.result.producers.map(row => [row.key, row.recipeReady]).sort(),
    [['resale:101', true], ['resale:144', false]], 'a scroll hunt takes one producer place, the known recipe keeps its own');
// A scroll offered only in a town of unknown trip is no purchase
// (WishPurchaseEvidence); a non-raid one is still found (user 2026-10-24):
// its recipe takes the scroll place and the bot bids for it (no ready
// spot drops it here), never buys it from that offer.
scrollHunt.forEach(row => board.remove(row.productId + 300));
board.put({ id: 444, ownerId: 2, storeType: 1, town: 'Dion', revision: 1, kind: 'sell', custodyPolicy: 0,
    lines: [{ lineId: 444, selfId: 444, count: 1, price: 10 }] });
prepared = prepare({ deps: { producerRecipes: scrollHunt } });
assert(['resale:101', 'resale:144'].every(key => prepared.projection.roots.includes(key)), 'a scroll sold only beyond a known trip still admits its producer');
const remoteScroll = prepared.result.queue.find(row => row.key === 'resale:144').plan.requirements.find(row => row.key === 'item:444')?.plan;
assert(!((remoteScroll?.execution || remoteScroll)?.activity === 'shopping' && (remoteScroll?.execution || remoteScroll)?.executable),
    'a scroll sold only beyond a known trip is never bought from that offer');
assert(prepared.watch.find(row => row.itemId === 444)?.worth > 0, 'the producer bids for the scroll sold only beyond a known trip');
board.remove(444); scrollHunt.forEach(row => board.remove(row.productId + 200));
// One root per product: a better variant of the known recipe's product (fewer
// inputs, like a 100% recipe beside the known 70% one) whose scroll is on sale
// never displaces the known recipe: resale:101 stays ready, crafted by the step.
const variant = { recipeId: 351, productId: 101, productCount: 1, recipeItemId: 451, mpCost: 1, successRate: 100,
    materials: [{ selfId: 202, amount: 1 }] };
put(45, 451, 1, 10);
prepared = prepare({ deps: { producerRecipes: [variant] } });
assert.deepEqual(prepared.result.producers.filter(row => row.key === 'resale:101').map(row => [row.recipeId, row.recipeReady]),
    [[301, true]], 'a scroll to buy never displaces the ready recipe of the same product');
board.remove(45);
// A producer row carries the ratio its cash inputs spend at: its root's
// money-queue ratio when the root owns a money-packet row, else 0.
const Funding = require('../src/GameServer/Bot/Economy/PurchaseFunding');
prepared = prepare();
const fundedRoot = prepared.result.queue.find(row => row.key === 'resale:101');
assert(fundedRoot.funded && prepared.result.producers.find(row => row.key === 'resale:101').r === Funding.significant(fundedRoot.ratio),
    "a funded producer root's row carries its money-queue ratio");
assert.strictEqual(prepare({ wallet: 0 }).result.producers.find(row => row.key === 'resale:101').r, 0,
    'an unfunded producer root spends no cash');
// Ten funded producer roots (a bot keeps at most three ready producers: the
// rows are copies of resale:101's), ranked by worth: the roots past the
// money packet's own rows (the merged tail) wait.
const producerNode = prepared.projection.nodes.find(row => row.key === 'resale:101');
const inputNodes = producerNode.paths[0].grossRequirements.map(need => prepared.projection.nodes.find(row => row.key === need.key));
const tenRoots = Array.from({ length: 10 }, (_, at) => ({ ...producerNode, key: `resale:${170 + at}`,
    object: { ...producerNode.object, itemId: 170 + at }, valueHours: 50 - at,
    paths: producerNode.paths.map(row => ({ ...row, itemId: 170 + at })) }));
const tenFunded = buildNetwork({ ...prepared.projection, nodes: [...inputNodes, ...tenRoots], roots: tenRoots.map(row => row.key) }, 100000);
const fundedKeys = tenFunded.queue.filter(row => row.funded).map(row => row.key);
const producerRatio = key => tenFunded.producers.find(row => row.key === key)?.r;
assert.strictEqual(fundedKeys.length, 10, 'every producer root is funded');
assert(fundedKeys.slice(0, Funding.PACKET_ROWS - 1).every(key => producerRatio(key) > 0)
    && fundedKeys.slice(Funding.PACKET_ROWS - 1).every(key => producerRatio(key) === 0),
'a funded producer root in the merged packet tail waits: its row spends no cash');
// A finalist without a craft path (its inputs over the node budget) leaves its place: the next three earning rows root.
const ranked = [110, 111, 112, 113].map((id, at) => ({ recipeId: id + 200, productId: id, productCount: 1, recipeItemId: id + 300,
    mpCost: 1, successRate: 100, materials: at ? [{ selfId: 202, amount: 1 }]
        : Array.from({ length: network.MAX_NODES }, (_, k) => ({ selfId: 600 + k, amount: 1 })) }));
ranked.forEach((row, at) => put(row.productId + 200, row.productId, 1, 5000 - at * 1000, 3));
roots = prepare({ deps: { knownRecipes: [301, ...ranked.map(row => row.recipeId)], producerRecipes: ranked } }).projection.roots;
assert(!roots.includes('resale:110') && ['resale:111', 'resale:112', 'resale:113'].every(key => roots.includes(key)),
    'a pathless top row leaves the finalist places to the next three');
// A crafter's gear and its producers share one node bound: a needed gear
// root whose tree fills 40 nodes leaves room for all three producers funding it.
const gearTree = Array.from({ length: 39 }, (_, k) => ({ key: `item:${700 + k}`, object: 700 + k, price: 1,
    paths: [{ kind: 'buy', activity: 'shopping', price: 1, itemId: 700 + k, amount: 1, available: true, executable: true }] }));
gearTree.push({ key: 'power:700:7', need: 'power', object: { itemId: 700, slot: 7 }, valueHours: 1000, price: 39,
    progressionPriority: 3, paths: [{ requirements: gearTree.map(node => ({ key: node.key, amount: 1 })) }] });
const earning = ranked.slice(1);
progressionRequired = true;
prepared = prepare({ deps: { knownRecipes: [301, ...earning.map(row => row.recipeId)], producerRecipes: earning, nodes: gearTree } });
assert.deepEqual(prepared.result.producers.map(row => row.key).sort(), ['resale:111', 'resale:112', 'resale:113'],
    'gear filling 40 nodes leaves every earning producer in the network');
progressionRequired = false;
// A craft path that fails at a later input takes back the nodes its earlier
// inputs added: they hold no place in the node bound of the next finalist.
const halfSourced = { recipeId: 414, productId: 114, productCount: 1, recipeItemId: 514, mpCost: 1, successRate: 100,
    materials: [...Array.from({ length: network.MAX_NODES - 2 }, (_, k) => ({ selfId: 801 + k, amount: 1 })), { selfId: 899, amount: 1 }] };
const nextFinalist = { recipeId: 415, productId: 115, productCount: 1, recipeItemId: 515, mpCost: 1, successRate: 100,
    materials: [{ selfId: 202, amount: 1 }, { selfId: 203, amount: 1 }] };
sourceless.add(899); put(314, 114, 1, 5000, 3); put(315, 115, 1, 4000, 3);
roots = prepare({ deps: { knownRecipes: [301, 414, 415], producerRecipes: [halfSourced, nextFinalist] } }).projection.roots;
assert(!roots.includes('resale:114') && roots.includes('resale:115'), 'a failed craft path leaves its node bound to the next finalist');
sourceless.delete(899); board.remove(314); board.remove(315);
for (const row of ranked) board.remove(row.productId + 200);
board.remove(20);
// Gear and producers meet in the one value cut: a needed gear root, admitted
// after the producers filled the node bound, keeps its place; the producer
// whose inputs no longer fit beside it is cut.
const filling = { recipeId: 416, productId: 116, productCount: 1, recipeItemId: 516, mpCost: 1, successRate: 100,
    materials: Array.from({ length: network.MAX_NODES - 3 }, (_, k) => ({ selfId: 900 + k, amount: 1 })) };
const small = { recipeId: 417, productId: 117, productCount: 1, recipeItemId: 517, mpCost: 1, successRate: 100,
    materials: [{ selfId: 202, amount: 1 }] };
put(316, 116, 1, 5000, 3); put(317, 117, 1, 4000, 3);
progressionRequired = true; gearPriority = 2;
Object.assign(planner, { considerable: () => true, equipmentCandidate: () => true, equipmentItemBetter: (item, current) => !current });
roots = prepare({ deps: { knownRecipes: [301, 416, 417], producerRecipes: [filling, small] } }).projection.roots;
assert(roots.includes('power:101:7') && roots.includes('resale:117') && !roots.includes('resale:116'),
    'a needed gear root built after the producers keeps its place in the value cut');
progressionRequired = false; gearPriority = 0; planner.considerable = () => false;
delete planner.equipmentCandidate; delete planner.equipmentItemBetter;
board.remove(316); board.remove(317);
// A path that fills the bound to the last node leaves no slot for its own
// root: it takes its nodes back and the next finalist roots.
const brimming = { recipeId: 418, productId: 118, productCount: 1, recipeItemId: 518, mpCost: 1, successRate: 100,
    materials: [...Array.from({ length: network.MAX_NODES - 2 }, (_, k) => ({ selfId: 1000 + k, amount: 1 })), { selfId: 101, amount: 1 }] };
const after = { recipeId: 419, productId: 119, productCount: 1, recipeItemId: 519, mpCost: 1, successRate: 100,
    materials: [{ selfId: 203, amount: 1 }] };
put(318, 118, 1, 5000, 3); put(319, 119, 1, 4000, 3);
roots = prepare({ deps: { knownRecipes: [301, 418, 419], producerRecipes: [brimming, after] } }).projection.roots;
assert(!roots.includes('resale:118') && roots.includes('resale:119'), 'a path that leaves no slot for its root frees the bound for the next finalist');
board.remove(318); board.remove(319);
// Only path nodes are bounded: once two producers fill the bound, a root
// with no inputs (the next level) still enters and the one value cut, not
// the build order, decides which roots stay.
const wide = (at, size) => ({ recipeId: 440 + at, productId: 140 + at, productCount: 1, recipeItemId: 540 + at, mpCost: 1,
    successRate: 100, materials: Array.from({ length: size }, (_, k) => ({ selfId: 1100 + 100 * at + k, amount: 1 })) });
state.level = 39; context.hunt.expPerHour = 100; adapters['GameServer/DataCache'].experience = { 39: 1000 };
put(340, 140, 1, 5000, 3); put(341, 141, 1, 4000, 3);
const full = prepare({ deps: { knownRecipes: [301, 440, 441], producerRecipes: [wide(0, 40), wide(1, network.MAX_NODES - 42)] } });
assert(full.projection.roots.includes('level:40') && full.projection.roots.some(key => /^resale:14[01]$/.test(key)),
    'a root with no inputs reaches the value cut after producers fill the node bound');
state.level = 40; context.hunt.expPerHour = 0; delete adapters['GameServer/DataCache'].experience;
board.remove(340); board.remove(341);
// Ordinary gear and a producer share an item but keep their source-choice
// contracts: immediate farm for gear, cheaper unquoted purchase for a producer root.
const plannedNodes = [
    { key: 'item:202', object: 202, price: 1, paths: [
        { kind: 'buy', activity: 'shopping', price: 1, available: true, executable: false, availableUnits: 0 },
        { kind: 'drop', activity: 'hunting', itemId: 202, spotId: 'expensive-farm', costHours: 100 }] },
    { key: 'power:202:7', need: 'power', object: { itemId: 202 }, valueHours: 200,
        paths: [{ requirements: [{ key: 'item:202', amount: 1 }] }] },
    { key: 'resale:501', need: 'power', object: { itemId: 501, kind: 'resale' }, valueHours: 1,
        paths: [{ kind: 'craft', activity: 'crafting', productCount: 1,
            requirements: [{ key: 'item:202', amount: 1 }], grossRequirements: [{ key: 'item:202', amount: 1 }] }] }
];
for (const stockFor of [undefined, () => ({ owned: 0, incoming: 0 })]) {
    const preparedTrial = new network.WishNetwork().build({ actorKey: 'planned-trial', inputKey: String(!!stockFor),
        nodes: plannedNodes, roots: ['power:202:7', 'resale:501'], wallet: 1000, hourAdena: 100,
        persona, remembered: false, stockFor });
    assert(preparedTrial.queue.some(row => row.key === 'resale:501'), 'cheap intended input purchase preserves the producer root');
    const producerPath = preparedTrial.plans.get('resale:501');
    assert.equal(producerPath.executable, false, 'the preparation cannot craft without physical ingredients');
    assert.equal(producerPath.requirements[0].plan.kind, 'buy');
    assert.equal(producerPath.requirements[0].plan.executable, false);
    assert.equal(preparedTrial.plans.get('power:202:7').effort, 100, 'the normal root retains executable-first acquisition');
    const commands = intent.project({}, preparedTrial, { nodes: plannedNodes });
    if (!stockFor) assert.equal(commands, null, 'a network without a stock reader defers its public intentions');
    else assert(commands.some(row => row.itemId === 202), 'the missing material remains a public purchase intention');
    assert.notEqual(preparedTrial.activity?.rootKey, 'resale:501', 'unsupported purchase/craft leaves remain blocked');
}
const sharedTrialNodes = [501, 502].map((id, index) => ({ key: `resale:${id}`, need: 'power',
    object: { itemId: id, kind: 'resale' }, valueHours: index ? 0.5 : 1,
    paths: [{ kind: 'craft', activity: 'crafting', productCount: 1,
        ownInputOpportunityValue: 10, requirements: [], grossRequirements: [{ key: 'item:202', amount: 1 }] }] }));
sharedTrialNodes.push({ key: 'item:202', object: 202, price: 10,
    paths: [{ kind: 'buy', activity: 'shopping', price: 100 }] });
const sharedTrials = new network.WishNetwork().build({ actorKey: 'shared-producer', inputKey: 'shared-producer',
    nodes: sharedTrialNodes, roots: ['resale:501', 'resale:502'], wallet: 1000, hourAdena: 100,
    persona, remembered: false, stockFor: () => ({ owned: 1, incoming: 0 }) });
assert.equal(sharedTrials.activity?.rootKey, 'resale:501');
assert(!sharedTrials.queue.some(row => row.key === 'resale:502'),
    'profitability is checked again when the first producer root takes shared physical stock');
// Use the real capability reader at the producer-root boundary. A beginner
// must reach scroll/material intentions, not just pass a standalone skill test.
const nativeCraft = invoke('GameServer/Bot/Economy/CraftEligibility');
invoke('GameServer/DataCache').skillTree = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/Skills/Tree/tree.json')));
delete state.craftLevel;
serviceCraft.canCraft = nativeCraft.canCraft;
state.classId = 53; state.level = 5; state.inventory = {}; state.stats = {}; state.acceptedIncoming = {};
adapters['GameServer/DataCache'].experience = Array.from({ length: 40 }, (_, level) => level * 100);
recipe.level = 1;
put(20, 101, 1, 100, 3); put(21, 202, 10, 1); put(27, 401, 1, 1);
const beginnerDeps = { knownRecipes: [], producerRecipes: [recipe] };
const beginner = prepare({ deps: beginnerDeps });
assert(beginner.projection.roots.includes('resale:101'));
assert(beginner.watch.some(row => row.itemId === 401), 'the native capable beginner asks for its unknown recipe scroll');
state.level = 4;
assert(!prepare({ deps: beginnerDeps }).projection.roots.includes('resale:101'));
state.level = 5; state.craftLevel = 0;
assert(!prepare({ deps: beginnerDeps }).projection.roots.includes('resale:101'), 'native unlearned zero wins over the tree');
console.log('PASS finite producer graph: partial inputs, native conditional forecast, direct materials, own output, incoming/protected stock, funding, unknown book/farm and demand retirement / beginner native skill -> scroll intention first / net-rate admission: input and scroll prices, scroll wait 0, NPC buyback no exit, pathless finalist skipped, gear and producers in one node bound and one value cut, failed or full path frees its nodes');
state.craftLevel = 1; state.inventory = {}; state.stats = {}; state.adena = 1000;
board.remove(20); item.template.kind = 'Armor.Chest';
// A learned recipe is kept: a listing sale carries the recipe's price only
// over the units its forecast sells in the bot's time in grade.
state.inventory = {}; state.stats = {}; state.acceptedIncoming = {}; state.adena = 5000;
board.remove(27);
put(28, 401, 1, 2000);
const learningPrice = context.price;
context.price = id => id === 401 ? 2000 : learningPrice(id);
listingDemand = { known: true, applicableUnits: 10, delayHours: 0.5 };
listingExits = [{ type: 'listing', town: 'Giran', price: 300, count: 10, applicableUnits: 10, willingUnits: 10,
    cheaperUnits: 0, maxBatches: 1, residualUnitValue: 0, delayHours: 0.5 }];
const learning = horizonHours => {
    context.horizonHours = horizonHours;
    try { return prepare({ wallet: 5000, deps: beginnerDeps }); } finally { delete context.horizonHours; }
};
// Margin ~290 per unit, 20 units/h for 50 h: the 2000 scroll is worth learning.
const kept = learning(50);
assert(kept.result.queue.some(row => row.key === 'resale:101'), 'a recipe whose sales in grade repay it gets a producer root');
assert(kept.watch.some(row => row.itemId === 401 && row.amount === 1), 'the producer buys the recipe scroll once');
assert(kept.result.plans.get('resale:101').price >= 2000, 'the scroll is still paid in full cash');
// Sales in grade (20 units/h for 0.04 h) below one batch: the batch carries the whole price.
const oneSale = learning(0.04);
assert(!oneSale.result.queue.some(row => row.key === 'resale:101'), 'a recipe one sale must repay is not learned');
assert(!oneSale.watch.some(row => row.itemId === 401), 'no scroll purchase without a producer root');
// The kept recipe stays whatever the craft roll: a 60 % recipe whose
// sales in grade repay a dear scroll keeps its producer root.
board.remove(28); put(28, 401, 1, 5000);
context.price = id => id === 401 ? 5000 : learningPrice(id);
state.adena = 20000; recipe.successRate = 60;
context.horizonHours = 50;
let chancy;
try { chancy = prepare({ wallet: 20000, deps: beginnerDeps }); } finally { delete context.horizonHours; recipe.successRate = 100; }
assert(chancy.result.queue.some(row => row.key === 'resale:101' && row.valueHours > 0),
    'a recipe kept over its sales is worth its price whether one craft roll fails or not');
// Materials in the bag: the scroll purchase is the only step left, and it names the recipe to learn.
state.inventory = { 202: { selfId: 202, amount: 10 } };
context.horizonHours = 50;
let scrollStep;
try { scrollStep = prepare({ wallet: 20000, deps: beginnerDeps }).result.activity; } finally { delete context.horizonHours; }
assert.equal(scrollStep?.activity, 'shopping'); assert.equal(scrollStep?.itemId, 401);
assert.equal(scrollStep.recipeId, 301, 'the producer root scroll step carries the recipe (stock-allocated build)');
state.inventory = {};
listingDemand = null; listingExits = []; context.price = learningPrice; board.remove(28);
console.log('PASS recipe price spread over listing sales in grade; one-sale recipe refused; kept recipe outside the roll');

// The scroll of a producer root's recipe is learned at purchase: the worker
// tags that shopping leaf with the recipe. A stock root's shot scroll is not
// (ColdShotEconomyService learns it); a dealer's scroll root is resold, not learned.
const scrollLeaf = (rootKey, kind, scrollPaths = [{ kind: 'craft', activity: 'crafting', recipeId: 301, costHours: 0.1,
    requirements: [{ key: 'scroll', amount: 1, once: true }] }]) => new network.WishNetwork().build({
    actorKey: 'learner:1', inputKey: `learn:${rootKey}`, characterId: 1, wallet: 1000, survivalReserve: 0, hourAdena: 100,
    persona, remembered: false, roots: [rootKey],
    nodes: [{ key: rootKey, need: 'power', object: { itemId: 101, amount: 1, kind }, valueHours: 10, price: 100, paths: scrollPaths },
        { key: 'scroll', object: { itemId: 401, amount: 1 }, paths: [{ kind: 'buy', activity: 'shopping', itemId: 401, price: 20, costHours: 0.1 }] }] }).activity;
const gearScroll = scrollLeaf('resale:101', 'resale');
assert.equal(gearScroll?.activity, 'shopping');
assert.equal(gearScroll.recipeId, 301, 'the producer root scroll purchase names the recipe to learn');
const shotScroll = scrollLeaf('stock:shots', 'shots');
assert.equal(shotScroll?.activity, 'shopping');
assert.equal(shotScroll.recipeId, undefined, 'a shot scroll purchase under the stock root names no recipe');
const dealerScroll = scrollLeaf('resale:401', 'resale', [{ kind: 'buy', activity: 'shopping', itemId: 401, price: 20, costHours: 0.1 }]);
assert.equal(dealerScroll?.activity, 'shopping');
assert.equal(dealerScroll.recipeId, undefined, 'a scroll bought to resell names no recipe');
console.log('PASS producer root scroll leaf carries its recipe; stock and dealer scroll leaves do not');
