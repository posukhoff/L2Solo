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
const state = { characterId: 1, level: 40, inventory: {}, stats: { recipes: [301] },
    activity: 'shopping', currentRegion: 'Giran', loc: { locX: 81100, locY: 148000, locZ: -3466 } };
const board = new BoardIndex();
const persona = { primaryDrive: 'progression', understanding: 1,
    traits: { commitment: 0, caution: 0, ambition: 0 } };
let allowCraft = false, ownCraft = true, spotReads = 0, recipeVariants = [recipe];
const adapters = {
    'GameServer/DataCache': { items: [item] },
    'GameServer/Progression/ProgressionCap': { effectiveLevelCap: () => 40 },
    'GameServer/Bot/AI/KnowledgeLearning': { stages: () => [{ grade: 'c', maxLevel: 51 }], gradeOfLevel: () => 'c' },
    'GameServer/Bot/AI/BotGear': { wishKitsFor: require('../src/GameServer/Bot/AI/BotGear').wishKitsFor },
    'GameServer/Bot/AI/GearAcquisitionPlanner': { sourceGround: () => null, sourceRouteReader: () => () => true, roleFor: () => 'melee', gradeForLevel: () => 'c',
        suitable: () => true, considerable: () => true, itemScore: () => 1, withReadiness: fn => fn(),
        equipmentCandidate: () => true, equipmentItemBetter: (item, current) => !current },
    'GameServer/Bot/Population/ColdCombatProfile': { skillsFor: () => [], candidateProfiles: () => ({
        before: { pAtk: 100, pDef: 100, mDef: 100 }, after: () => ({ pAtk: 200, pDef: 100, mDef: 100 }) }) },
    'GameServer/Bot/Economy/BotImprovementPolicy': { opportunities: () => [], crystalPath: () => null },
    'GameServer/Items/C4RecipeItems': { resolveVariantsByProductId: id => allowCraft ? recipeVariants.filter(row => row.productId === Number(id)) : [],
        resolveByRecipeId: id => recipeVariants.find(row => row.recipeId === Number(id)) || null },
    'GameServer/Items/C4DualSwordCombinations': { resolveByProductId: () => null, resolveByRecipeId: () => null },
    'GameServer/Items/SoulCrystalProgression': require('../src/GameServer/Items/SoulCrystalProgression'),
    'GameServer/Bot/Economy/CraftShopService': { canCraft: () => ownCraft, isServiceCrafter: () => false, marketProducer: () => false },
    'GameServer/Skills/SkillBookCatalog': { missingBooks: () => [] },
    'GameServer/Bot/Economy/MarketCounters': { moveOf: () => 0, counterOf: () => 'armor c' },
    // No sellable inventory: the liquidation money path stays out of these routes.
    'GameServer/Bot/Economy/ItemDisposition': { saleCandidates: () => [] },
    'GameServer/Inventory/ShotStock': { keptAmounts: () => ({}) },
    'GameServer/Bot/AI/HealingPotionStock': { keptAmounts: () => ({}) },
    'GameServer/Bot/Travel/ScrollStock': { keptAmounts: () => ({}) }
};
// Liquidation funding reads the shared sale and kept-stock readers (f75b6525); this
// fixture sells nothing, so no inventory row is a sale candidate.
Object.assign(adapters, { 'GameServer/Bot/Economy/PersonalWarehouseIndex': { saleState: state => state },
    'GameServer/Bot/Economy/ItemDisposition': { saleCandidates: () => [], reservedEquipmentAmounts: () => ({}) },
    'GameServer/Inventory/ShotStock': { keptAmounts: () => ({}) },
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
    if (name === './CommittedExits') return require('../src/GameServer/Bot/Economy/CommittedExits');
    if (name === './EconomicValuation') return valuation;
    if (name.endsWith('TendencyRoll')) return tendency;
    if (name.endsWith('Fnv1a')) return { fnv1a32: () => 1 };
    throw Error(name);
});
const provider = load('WishProviders.js', name => {
    if (name === '../../Items/SoulCrystalProgression') return adapters['GameServer/Items/SoulCrystalProgression'];
    if (name === '../../Items/C4DualSwordCombinations') return adapters['GameServer/Items/C4DualSwordCombinations'];
    if (name === './PurchaseFunding') return require('../src/GameServer/Bot/Economy/PurchaseFunding');
    // This isolated routing fixture supplies admitted synthetic origins.
    if (name.endsWith('ItemAcquisitionCatalog')) return { revision: () => 1, hasSource: () => true, hasNonRaidSource: () => true, allowsRecipe: () => true };
    if (name === './CraftProfitPolicy') return require('../src/GameServer/Bot/Economy/CraftProfitPolicy');
    if (name === './TwinCluster') return require('../src/GameServer/Bot/Economy/TwinCluster');
    if (name === './EconomyDiagnostics') return { active: () => false, laps: () => null };
    if (name === './EconomicValuation') return valuation;
    if (name === './WishNetwork') return network;
    if (name === '../AI/PersonalGearProgression') return { assess: () => ({ required: false, gaps: new Map() }), preparation: () => null, priority: () => 0, personal: () => false, allowsCGradeAcquisition: () => false,
        isCGradeHelmet: require('../src/GameServer/Bot/AI/PersonalGearProgression').isCGradeHelmet };
    if (name === '../AI/BotEquipmentCompatibility') return require('../src/GameServer/Bot/AI/BotEquipmentCompatibility');
    if (name === '../../Item/ItemTemplateIndex') return require('../src/GameServer/Item/ItemTemplateIndex');
    if (name.endsWith('BoardIndex')) return { SELL: 1 };
    if (name === './BotLuxuryExchange') return { recipes: () => new Map() };
    if (name === './WishPurchaseEvidence') return require('../src/GameServer/Bot/Economy/WishPurchaseEvidence');
    if (name === './EconomicTrip') return require('../src/GameServer/Bot/Economy/EconomicTrip');
    // A buy's wait (buyWait): the town code, rival takers, observed supply.
    if (['./ShotCraftPolicy', './CommittedExits', './MarketDemand'].includes(name)) return require(path.resolve(root, name));
    if (name === './WealthCraftDecision') return { freeAmount: (state, row) => Number(row.amount || 0), learnsRecipe: () => true };
    throw Error(name);
}, invokeAdapter);
const context = { timestamp: 1, persona, board, hunt: { perHour: 100, expPerHour: 0 }, hourAdena: 100, wallet: 1000, deathHours: 0,
    price: id => id === 101 ? 100 : 1, buyback: () => 0,
    stock: () => ({ itemId: 900, missing: 0 }), spotValue: () => { spotReads++; return {}; } };
const preparedTrip = town => town === 'Giran' ? 0 : Infinity;
preparedTrip.details = town => ({ known: town === 'Giran', hours: 0, fees: 0 });
context.trip = preparedTrip;
function run(craft, extra = {}) {
    allowCraft = craft;
    const projection = provider.build(state, { ...context, ...extra.context }, { board, ...(extra.deps || {}) });
    const result = new network.WishNetwork().build({ actorKey: 'character:1', inputKey: String(craft),
        characterId: 1, nodes: projection.nodes, roots: projection.roots,
        wallet: extra.wallet ?? 1000, hourAdena: 100, persona, remembered: false });
    return { publicOffers: 0, nodes: projection.nodes, focus: result.focus,
        queue: result.queue.map(row => ({ key: row.key, funded: row.funded, price: row.price })),
        plans: [...result.plans], activity: result.activity, spotReads };
}
const buy = run(false), craft = run(true);
const savedBook = state.stats.recipes;
state.stats.recipes = [];
const nativeBook = run(true, { deps: { knownRecipes: [{ recipeId: 301 }] } });
const nativeCraft = nativeBook.nodes.find(row => row.key === 'item:101').paths.find(row => row.kind === 'craft');
assert(nativeCraft, 'prepared native book enables ingredient collection without a second recipe scroll');
assert.equal(nativeCraft.requiresRecipeLearning, false);
assert.equal(nativeCraft.grossRequirements.length, 1);
assert.equal(nativeCraft.grossRequirements[0].key, 'item:202');
const unknownBook = run(true).nodes.find(row => row.key === 'item:101').paths.find(row => row.kind === 'craft');
assert(unknownBook?.requiresRecipeLearning, 'an unknown recipe remains a preparation goal');
assert(unknownBook.grossRequirements.some(row => row.key === 'item:401' && row.once),
    'the goal acquires a real scroll without inventing recipe knowledge');
state.stats.recipes = savedBook;
assert.equal(run(true, { deps: { knownRecipes: [] } }).nodes.find(row => row.key === 'item:101')
    .paths.find(row => row.kind === 'craft').requiresRecipeLearning, true,
    'an authoritative empty book overrides stale compatibility knowledge');
let safeScroll = true, scrollKind = 'drop', raidScroll = false;
const planner = adapters['GameServer/Bot/AI/GearAcquisitionPlanner'];
planner.sourceIndexFor = () => new Map([[401, [{ kind: scrollKind,
    spot: { id: 'scroll-source', raidBoss: raidScroll }, reward: { selfId: 501 } }]]]);
planner.sourceYieldReaderFor = () => () => ({ expectedYield: 1 });
planner.soloSafeForSource = () => safeScroll;
adapters['GameServer/Bot/AI/BotRoles'] = { isSpoiler: () => false };
const farmScroll = () => run(true, { deps: { knownRecipes: [], spots: [{}] },
    context: { spotValue: () => ({ kills: 1000 }) } });
const farmedBook = farmScroll();
const preparingRecipe = farmedBook.nodes.find(row => row.key === 'item:101').paths.find(row => row.kind === 'craft');
assert(preparingRecipe?.requiresRecipeLearning, 'known safe scroll drop admits recipe preparation with no scroll seller');
assert(preparingRecipe.grossRequirements.some(row => row.key === 'item:401' && row.amount === 1 && row.once));
assert.equal(farmedBook.activity.activity, 'hunting');
assert.equal(farmedBook.activity.itemId, 401, 'the acquisition leaf farms the actual scroll, not the product');
const hasCraft = result => result.nodes.find(row => row.key === 'item:101').paths.some(row => row.kind === 'craft');
safeScroll = false;
const unsafeScroll = farmScroll();
assert(hasCraft(unsafeScroll), 'unsafe ground does not delete the future recipe purchase goal');
assert.equal(unsafeScroll.plans.find(([key]) => key === 'item:401')[1].executable, false,
    'unsafe recipe farming cannot execute');
safeScroll = true; raidScroll = true;
assert.notEqual(farmScroll().activity?.kind, 'raid', 'a raid scroll source is not a solo route');
raidScroll = false; scrollKind = 'spoil';
assert.notEqual(farmScroll().activity?.kind, 'spoil', 'a crafter cannot obtain a spoil-only recipe by ordinary hunting');
assert.equal(buy.activity, null, 'known price with no offer preserves wish without shopping');
assert(buy.queue.length && buy.focus, 'unknown future supply does not erase the desired gear');
// A reference estimate is not an offer: the purchase cannot execute and the
// wish keeps its queue place without money.
assert.equal(buy.plans.find(([key]) => key === 'item:101')[1].executable, false, 'an estimate without an offer cannot pay');
assert.equal(buy.queue[0].funded, false, 'an unexecutable purchase draws no money');
assert.equal(craft.activity, null, 'missing ingredient forecast cannot execute shopping/craft');
assert.equal(craft.plans.find(([key]) => key === 'item:202')[1].executable, false);
assert.equal(spotReads, 0, 'gear gain still has no hypothetical best-spot evaluation');
function stock(id, amount, ownerId = 2, enchant = 0) {
    board.put({ id: 11, ownerId, storeType: 1, kind: 'sell_ad', town: 'Giran', revision: 1,
        lines: [{ lineId: 11, selfId: id, count: amount, price: 1, enchant }] });
}
stock(202, 6);
const partial = run(true);
assert.equal(partial.activity.activity, 'shopping');
assert.equal(partial.activity.object, 202);
assert.equal(partial.activity.amount, 6, 'partial source cannot purchase the unavailable remainder');
assert.equal(partial.plans.find(([key]) => key === 'item:101')[1].executable, false);
// The 4 units the town lacks are dear (200 a unit at the bot's price) and the
// wallet holds 100: the step now (6 at 1) is paid, the units it lacks only
// weigh in the route choice (componentroute 2026-10-25).
const tight = run(true, { wallet: 100, context: { price: id => id === 101 ? 100 : 200 } });
assert.equal(tight.activity?.activity, 'shopping', 'a tight wallet still pays the part on sale now');
assert.equal(tight.activity.amount, 6);
stock(202, 10);
const full = run(true);
assert.equal(full.activity.activity, 'shopping', 'ingredients must be acquired before crafting');
assert.equal(full.activity.amount, 10);
assert.equal(full.plans.find(([key]) => key === 'item:101')[1].executable, true);
stock(202, 10, 1);
assert.equal(run(true).activity, null, 'own standing stock does not establish external buying supply');
stock(202, 10, 2, 1);
assert.equal(run(true).activity, null, 'enchanted item is not a normal recipe ingredient');
// A buy is priced for the amount the craft needs: Giran's cheaper head holds
// 2 of 45, Dion's asks hold all 45 (20 at 2, 25 at 3), so the craft can run
// and the bot shops in Dion.
const deepBoard = new BoardIndex();
deepBoard.put({ id: 21, ownerId: 2, storeType: 1, kind: 'sell_ad', town: 'Giran',
    lines: [{ lineId: 21, selfId: 202, count: 2, price: 1 }] });
deepBoard.put({ id: 22, ownerId: 3, storeType: 1, kind: 'sell_ad', town: 'Dion',
    lines: [{ lineId: 22, selfId: 202, count: 20, price: 2 }, { lineId: 23, selfId: 202, count: 25, price: 3 }] });
const twoTowns = town => ['Giran', 'Dion'].includes(town) ? 0 : Infinity;
twoTowns.details = town => ({ known: ['Giran', 'Dion'].includes(town), hours: 0, fees: 0 });
recipeVariants = [{ ...recipe, materials: [{ selfId: 202, amount: 45 }] }];
const deep = run(true, { deps: { board: deepBoard }, context: { board: deepBoard, trip: twoTowns } });
recipeVariants = [recipe];
assert.equal(deep.plans.find(([key]) => key === 'item:101')[1].executable, true, 'the deeper town supplies the whole craft');
assert.equal(deep.activity?.activity, 'shopping');
assert.equal(deep.activity.town, 'Dion', 'the bot shops where the amount it needs is sold');
assert.equal(deep.activity.amount, 45);
stock(101, 1);
board.put({ id: 11, ownerId: 2, storeType: 1, kind: 'sell_ad', town: 'Giran',
    lines: [{ lineId: 11, selfId: 101, count: 1, price: 1200 }] });
const expensive = run(false);
assert.equal(expensive.queue[0].price, 1200, 'observed ask replaces the optimistic 100-adena forecast in the purse');
assert.equal(expensive.queue[0].funded, false);
assert.equal(expensive.activity, null, 'an unaffordable actual ask cannot execute shopping');
const paidTrip = town => town === 'Giran' ? 6 : Infinity;
// The road inside the horizon: a path past it waits (E212), this case is the fees.
paidTrip.details = town => ({ known: town === 'Giran', hours: 0.5, fees: 400 });
const travelTooDear = run(false, { wallet: 1500, context: { trip: paidTrip, wallet: 1500, persona: { ...persona, traits: { ...persona.traits, commitment: 0.5 } } } });
assert.equal(travelTooDear.queue[0].price, 1600, 'the purse includes actual future road fees');
assert.equal(travelTooDear.queue[0].funded, false);
assert.equal(travelTooDear.activity, null);
assert.equal(run(false, { context: { trip: undefined } }).activity, null,
    'unprepared route keeps desire but cannot synchronously prove supply');

// Two ingredients share one prepared visit. Price and effort charge its fee
// once for the complete craft, while individual leaves retain their own trip.
const basketNodes = [{ key: 'gear', need: 'power', price: 1, valueHours: 100,
    paths: [{ kind: 'craft', activity: 'crafting', price: 0, requirements: [
        { key: 'a', amount: 10 }, { key: 'b', amount: 4 }] }] },
...['a', 'b'].map(key => ({ key, paths: [{ kind: 'buy', activity: 'shopping', price: 2,
    executable: true, quoted: true, availableUnits: 20, town: 'Giran', tripFees: 100, tripHours: 3 }] }))];
const basket = new network.WishNetwork().build({ actorKey: 'basket', inputKey: 'basket', nodes: basketNodes,
    roots: ['gear'], wallet: 128, hourAdena: 100, persona, remembered: false });
assert.equal(basket.queue[0].price, 128, '28 adena of ingredients plus one 100-adena trip');
assert.equal(basket.queue[0].effort, 4.28, 'ingredient work plus one three-hour trip and cash cost');
assert.equal(basket.queue[0].funded, true);
const memberNodes = [{ key: 'group', need: 'power', valueHours: 100,
    paths: [{ requirements: [{ key: 'first', amount: 1 }, { key: 'second', amount: 1 }] }] },
...['first', 'second'].map(key => ({ key, paths: [{ kind: 'buy', activity: 'shopping', quoted: true,
    price: 100, town: 'Giran', tripScope: key, tripFees: 900, tripHours: 1 }] }))];
const memberBasket = new network.WishNetwork().build({ actorKey: 'group', inputKey: 'members',
    nodes: memberNodes, roots: ['group'], wallet: 1900, hourAdena: 100, persona, remembered: false });
assert.equal(memberBasket.queue[0].price, 2000, 'different members pay their own same-town trips');
assert.equal(memberBasket.queue[0].funded, false, 'a group cannot afford two trips with only one trip in its purse');
const manyNodes = [{ key: 'crowd', need: 'power', valueHours: 1000, paths: [{
    requirements: Array.from({ length: 39 }, (_, index) => ({ key: `member:${index}`, amount: 1 })) }] },
...Array.from({ length: 39 }, (_, index) => ({ key: `member:${index}`, paths: [{ kind: 'buy',
    activity: 'shopping', quoted: true, price: 100, town: 'Giran', tripScope: `member:${index}`,
    tripFees: 900, tripHours: 1 }] }))];
const crowdBasket = new network.WishNetwork().build({ actorKey: 'crowd', inputKey: 'crowd', nodes: manyNodes,
    roots: ['crowd'], wallet: 39000, hourAdena: 100, persona, remembered: false });
assert.equal(crowdBasket.queue[0].price, 39000, 'all bounded graph scopes survive beyond seventeen towns and thirty-two mask bits');
assert.equal(crowdBasket.plans.get('crowd').tripEntries.length, 39);
const zeroIncome = new network.WishNetwork().build({ actorKey: 'zero', inputKey: 'zero', nodes: basketNodes,
    roots: ['gear'], wallet: 128, hourAdena: 0, persona, remembered: false });
assert.equal(zeroIncome.queue[0].effort, Infinity, 'unknown hour conversion is infinite, never NaN');
const freeNodes = [{ key: 'free', need: 'power', valueHours: 10, paths: [{ kind: 'buy', activity: 'shopping',
    price: 0, quoted: true, town: 'Giran', tripFees: 0, tripHours: 3 }] }];
const freeVisit = new network.WishNetwork().build({ actorKey: 'free', inputKey: 'free', nodes: freeNodes,
    roots: ['free'], wallet: 0, hourAdena: 0, persona, remembered: false });
assert.equal(freeVisit.plans.get('free').effort, 3, 'zero cash is not multiplied by an unknown hour price');

const ColdDecision = require('../src/GameServer/Bot/Population/ColdEconomyDecision');
const decoded = ColdDecision.compact({ echo: [1, 0, null], updatedAt: 1, riskWeight: 1,
    activity: { activity: 'shopping', itemId: 202, amount: 6, price: 106, unitPrice: 1,
        rootKey: 'gear', town: 'Giran', sourceType: 'npc' } }).activity;
assert.equal(decoded.town, 'Giran'); assert.equal(decoded.sourceType, 'npc');
assert.equal(decoded.heldAtDecision, undefined, 'optional town fields do not manufacture held inventory');
const goalsModule = { exports: {} };
new Function('require', 'invoke', 'module', 'exports', fs.readFileSync(path.join(root, '../Goals/NeedsEvaluator.js'), 'utf8'))(
    name => name.includes('ItemTemplateIndex') ? { find: () => null }
        : name.endsWith('Fnv1a') ? { fnv1a32: () => 1 }
        : name.endsWith('ColdEconomyDecision') ? ColdDecision : (() => { throw Error(name); })(),
    name => name.endsWith('SurvivalFloor') ? { forState: () => null }
        : name.endsWith('EconomyContext') ? { survivalReserve: () => 0 }
        : name.endsWith('PurchaseFunding') ? { rootRatio: () => 0, leafRatio: () => 0 }
        : name.endsWith('MarketTownPolicy') ? { saleTown: () => ({ town: 'Giran' }) }
        : name.endsWith('DataCache') ? { items: [] } : (() => { throw Error(name); })(),
    goalsModule, goalsModule.exports);
const otherTownBoard = new BoardIndex();
otherTownBoard.put({ id: 2, ownerId: 3, storeType: 1, town: 'Dion', kind: 'sell_ad',
    lines: [{ lineId: 2, selfId: 202, price: 1, count: 20 }] });
const goal = goalsModule.exports.evaluate(state, { errand: null, board: otherTownBoard, npcOffersFor: () => [],
    economy: { network: { activity: decoded }, inputKey: 'city' } })[0];
assert.equal(goal.plan.marketTown, 'Giran', 'execution keeps the selected reachable city instead of first public head');
assert.equal(goal.plan.sourceType, 'npc', 'execution keeps the chosen source class');
assert.equal(goal.target.adena, 1, 'travel fee cannot inflate the executable unit quote');
assert.equal(goal.plan.estimatedCost, 106, 'the complete monetary estimate retains its future trip');
const wideDecision = ColdDecision.compact({ echo: [65, 57, null], updatedAt: 1, riskWeight: 1,
    usefulness: Array.from({ length: 80 }, (_, i) => i + 1),
    watch: Array.from({ length: 3 }, (_, i) => [200 + i, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 3]),
    materials: Array.from({ length: 8 }, (_, i) => [300 + i, Number.MAX_SAFE_INTEGER]),
    wish: [0, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    activity: { ...decoded, town: 'DarkElf', amount: Number.MAX_SAFE_INTEGER, price: Number.MAX_SAFE_INTEGER,
        unitPrice: Number.MAX_SAFE_INTEGER, heldAtDecision: Number.MAX_SAFE_INTEGER } });
assert(require('node:v8').serialize(wideDecision).byteLength <= ColdDecision.MAX_BYTES,
    'selected source and exact unit quote retain the existing 800-byte compact wire bound');
console.log('PASS actual prices/road funding, one basket trip, zero-hour arithmetic, compact and native goal city/source');
console.log('PASS actual provider/network: unknown wish retained, no unsupported activity, finite partial/full sources, prerequisite acquisition, owner/enchant restrictions');
const Evidence = require('../src/GameServer/Bot/Economy/WishPurchaseEvidence');
const knownNpc = Evidence.reader(state, context, { board: new BoardIndex(), npcOffersFor: () => [
    { sourceType: 'npc', selfId: 202, town: 'Giran', price: 3, available: true }] })(202);
assert.equal(knownNpc.availableUnits, Infinity, 'permitted static NPC source is unlimited');
assert.equal(Evidence.reader(state, context, { board: new BoardIndex(), tripCost: () => 0,
    npcOffersFor: () => [{ sourceType: 'npc', selfId: 202, town: 'Giran', price: 3 }] })(202), null,
    'a generic scalar cost without separate prepared cash/time cannot claim a free road');
const unknownTown = Evidence.reader(state, context, { board: new BoardIndex(), npcOffersFor: () => [
    { sourceType: 'npc', selfId: 202, town: 'Unknown', price: 3 }] })(202);
assert.equal(unknownTown, null, 'unknown route is not an executable quote');
console.log('PASS source evidence: native quote query, allowed NPC, unknown route');

// Native producer -> compact transport -> main consumer. A rich buyer loses
// benefit while waiting even when no earning gap remains in its saved packet.
const NativeData = invoke('GameServer/DataCache'); NativeData.init();
const NativeEconomy = invoke('GameServer/Bot/Economy/EconomyContext');
const nativeKit = {};
for (const row of invoke('GameServer/Bot/AI/BotGear').planFor({ classId: 1, level: 40 }).items) {
    const equippedSlots = [...nativeKit[row.selfId]?.equippedSlots || [], row.slot];
    nativeKit[row.selfId] = { ...row, amount: equippedSlots.length, equipped: true,
        equippedCount: equippedSlots.length, equippedSlots };
}
const nativeState = { ...state, characterId: 90110, phase: 'cold', adena: 1e12,
    inventory: { ...nativeKit, 57: { selfId: 57, amount: 1e12 } },
    stats: { classId: 1, exp: NativeData.experience[39] + 1 },
    vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 } };
const nativeDeps = { board: new BoardIndex(), spots: [], npcOffersFor: () => [], tripCost: preparedTrip,
    persona, timestamp: 1000, nodes: [{ key: 'fixture:power', need: 'power', valueHours: 1e9,
        object: { itemId: 101 }, paths: [{ kind: 'owned', price: 100, costHours: 1 }] }] };
const richNative = NativeEconomy.forState(nativeState, nativeDeps);
assert.equal(richNative.network.gap, null);
assert.equal(richNative.statsPacket.money[3], 0);
assert(richNative.gapHorizonHours > 0);
const committedRich = { ...nativeState, stats: { ...nativeState.stats, ...richNative.statsPacket } };
const richTransport = ColdDecision.compact(structuredClone(ColdDecision.capture(richNative, committedRich, nativeState)));
const richView = ColdDecision.view(committedRich, richTransport, nativeDeps);
assert.equal(richView.gapHorizonHours, richNative.gapHorizonHours, 'funded wish urgency reaches the native main-thread consumer');
assert(invoke('GameServer/Bot/Economy/PriceDecision').waitRate(richView) > 0,
    'zero earning gap cannot make waiting free for a rich buyer');
const waitingTransport = ColdDecision.capture({ ...richNative, network: { ...richNative.network, activity: null } }, committedRich);
assert.equal(ColdDecision.view(committedRich, waitingTransport, nativeDeps).gapHorizonHours, richView.gapHorizonHours,
    'waiting for prepared source evidence does not remove an existing wish urgency');
for (const kind of ['shots', 'potions']) {
    const key = `stock:${kind}`, stockWish = { key, object: { kind, amount: 10 }, price: 100 };
    const stockTransport = ColdDecision.capture({ ...richNative, network: {
        queue: [stockWish], focus: [key, 0, 100], gap: null, activity: null } }, committedRich);
    assert.equal(ColdDecision.view(committedRich, stockTransport, nativeDeps).gapHorizonHours,
        NativeEconomy.basics(committedRich, nativeDeps).stock(kind).targetHours,
        'funded stock keeps its own consumption horizon through transport');
}
const emptyTransport = ColdDecision.capture({ ...richNative, network: {
    queue: [], focus: null, gap: null, activity: null } }, committedRich);
assert.equal(ColdDecision.view(committedRich, emptyTransport, nativeDeps).gapHorizonHours, 0,
    'an empty queue has no useful wish urgency');
assert(require('node:v8').serialize(richTransport).byteLength <= ColdDecision.MAX_BYTES);
NativeEconomy.reset();
console.log('PASS native capture/transport/view: rich funded urgency, unknown arrival, stock horizons, empty queue and wire bound');

// Identical facts (Task 2 D2/D3): the wish craft path, CraftProfitPolicy.craftFacts
// and the producer's basket read one recipe through the one labour reader.
{
    const Occupation = invoke('GameServer/Bot/Population/ColdOccupationSources');
    const Basket = require('../src/GameServer/Bot/Economy/WealthCraftPolicy');
    const Profit = require('../src/GameServer/Bot/Economy/CraftProfitPolicy');
    const stub = adapters['GameServer/Bot/Population/ColdOccupationSources'];
    const saved = { labour: stub.craftLabour, mpCost: recipe.mpCost, successRate: recipe.successRate,
        stats: state.stats, vitals: state.vitals, phase: state.phase };
    const whole = (id, units) => ({ whole: true, units, cost: units, landed: units, town: 'Giran' });
    stub.craftLabour = Occupation.craftLabour;
    Object.assign(recipe, { mpCost: 30, successRate: 70 });
    state.stats = { ...state.stats, classId: 1, recipes: [301] };
    state.vitals = { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 };
    try {
        assert.equal(Occupation.craftLabour({ ...state, vitals: {} }, 1, () => ({ maxMp: 600 })).mpCapacity, 600,
            'no stored MP cap: the combat profile supplies it');
        for (const phase of ['cold', 'hot']) {
            state.phase = phase;
            const labour = Occupation.craftLabour(state, 1);
            assert(labour.mpPerHour > 0, phase);
            const path = run(true).nodes.find(row => row.key === 'item:101').paths.find(row => row.kind === 'craft');
            assert(path, phase);
            const direct = Profit.craftFacts(recipe, { batches: 1, ...labour });
            // The producer's own context builder carries the same labour facts.
            const producerContext = Profit.contextFor(state, 1);
            for (const field of ['executor', 'mpCapacity', 'mpPerHour']) assert.equal(producerContext[field], labour[field], `${phase} ${field}`);
            const producer = Basket.basketFor(recipe, whole, () => null, 1, { ...labour, hourAdena: 100 }).facts;
            for (const facts of [direct, producer]) {
                assert.equal(facts.status, 'ready', phase);
                assert.equal(path.successProbability, facts.successProbability, phase);
                assert.equal(path.perCommand, facts.perCommand, phase);
                assert.equal(path.productCount, facts.productCount, phase);
                assert.equal(path.costHours, facts.labourHours, phase);
                assert.deepEqual(path.grossRequirements.map(row => [row.key, row.amount]),
                    [...facts.gross].map(([id, amount]) => [`item:${id}`, amount]), phase);
            }
            // floor(1000 MP / 30 per batch) = 33 batches per cold command; a hot bot crafts one.
            assert.equal(path.perCommand, phase === 'hot' ? 1 : 33, phase);
            assert.equal(path.successProbability, .7, phase);
        }
    } finally {
        stub.craftLabour = saved.labour;
        Object.assign(recipe, { mpCost: saved.mpCost, successRate: saved.successRate });
        Object.assign(state, { stats: saved.stats, vitals: saved.vitals, phase: saved.phase });
        if (saved.vitals === undefined) delete state.vitals;
        if (saved.phase === undefined) delete state.phase;
    }
}
console.log('PASS identical craft facts: wish path = craftFacts = producer basket, cold 33 per command, hot 1');

// A fighter buys a published service instead of pretending to learn a dwarf recipe.
ownCraft = false;
state.stats.recipes = [];
const publicService = { characterId: 2, recipeId: 301, price: 5, entryPrice: 5, revision: 2,
    townName: 'Giran', loc: { locX: 81100, locY: 148000, locZ: -3466 }, capacityBatches: 3 };
const services = rows => ({ workshops: () => rows });
let projected = run(true, { deps: services([publicService]) });
let craftPath = projected.nodes.find(row => row.key === 'item:101').paths.find(row => row.kind === 'craft');
assert(craftPath, 'a real public service makes the same craft transformation feasible for a fighter');
assert.equal(craftPath.requiresRecipeLearning, false);
assert.equal(craftPath.price, 5);
assert(!craftPath.grossRequirements.some(row => row.key === 'item:401'), 'no recipe scroll charged to the customer');
assert.equal(run(true, { deps: services([]) }).nodes.find(row => row.key === 'item:101').paths.some(row => row.kind === 'craft'), false);
assert.equal(run(true, { deps: services([{ ...publicService, capacityBatches: 0 }]) }).nodes.find(row => row.key === 'item:101').paths.some(row => row.kind === 'craft'), false);
assert.equal(run(true, { deps: services([{ ...publicService, townName: 'Unknown' }]) }).nodes.find(row => row.key === 'item:101').paths.some(row => row.kind === 'craft'), false);
const serviceIndex = new (require('../src/GameServer/Bot/Economy/PublicWorkshopIndex').PublicWorkshopIndex)();
for (let i = 0; i < 20; i++) serviceIndex.put(`bad:${i}`, { ...publicService, characterId: i + 2,
    capacityBatches: i % 2 ? 0 : 3, townName: i % 2 ? 'Giran' : 'Unknown' });
serviceIndex.put('usable', { ...publicService, characterId: 22 });
const indexed = { workshops: (recipeId, owner) => serviceIndex.candidates(recipeId, owner.characterId) };
assert.equal(provider.knownWorkshop(recipe, state, context, indexed).characterId, 22,
    'twenty unusable public services cannot hide the next usable source');
serviceIndex.put('cheaper', { ...publicService, characterId: 23, price: 2 });
assert.equal([...serviceIndex.candidates(301)].length, 1, 'only the best usable source per town reaches a customer');
assert.equal(provider.knownWorkshop(recipe, state, context, indexed).characterId, 23);
serviceIndex.remove('cheaper');
assert.equal(provider.knownWorkshop(recipe, state, context, indexed).characterId, 22,
    'withdrawal reveals the next public source without a new crowd scan');
const planned = provider.personalCraftPlan(state, { network: { activity: { rootKey: 'power:101:7', activity: 'crafting' },
    queue: [{ key: 'power:101:7', object: { itemId: 101 }, ratio: 2, plan: craftPath }], plans: new Map() } });
assert.equal(planned.craftProviders[301].characterId, 2);
assert.equal(planned.valueRate, 2, 'paid service inherits the personal root funding rate');
const uncertainVariant = { ...recipe, recipeId: 302, recipeItemId: 402, successRate: 60,
    materials: [{ selfId: 202, amount: 5 }] };
recipeVariants = [uncertainVariant, recipe];
const uncertainService = { ...publicService, characterId: 3, recipeId: 302, price: 3, entryPrice: 3 };
const variantPaths = run(true, { deps: services([publicService, uncertainService]) }).nodes
    .find(row => row.key === 'item:101').paths.filter(row => row.kind === 'craft');
assert.equal(variantPaths.length, 2, 'both feasible native variants enter the shared comparison');
const certain = variantPaths.find(row => row.recipeId === 301), uncertain = variantPaths.find(row => row.recipeId === 302);
assert.equal(certain.successProbability, 1); assert.equal(uncertain.successProbability, .6);
assert.equal(certain.price, 5); assert.equal(uncertain.price, 3);
assert.equal(certain.grossRequirements.find(row => row.key === 'item:202').amount, 10);
assert.equal(uncertain.grossRequirements.find(row => row.key === 'item:202').amount, 5,
    'chance, service fee and inputs stay attached to their own variant');
const onlyPublished = run(true, { deps: services([publicService]) }).nodes.find(row => row.key === 'item:101')
    .paths.filter(row => row.kind === 'craft');
assert.deepEqual(onlyPublished.map(row => row.recipeId), [301],
    'an unavailable first variant cannot hide a later published one');
recipeVariants = [recipe];
console.log('PASS public paid service for fighter, no scroll/phantom source, route and capacity gates, indexed usable choice per known town');

// A craft needs more of an input than the town sells (componentroute
// 2026-10-25): 24 units, 8 on sale at 1 a unit, none coming; a published
// workshop crafts the input from one the town holds whole (2 at 2 a batch,
// fee 1: 5 a unit). The part on sale is priced for all 24: the 16 it lacks
// at the bot's price of the input. At 20 a unit the workshop is cheaper and
// wins, and the gear craft can run; at 1 a unit the buy stays cheaper and
// stays (cost decides buy against craft, user 2026-10-23).
const component = { recipeId: 303, productId: 202, productCount: 1, recipeItemId: 403, mpCost: 1, successRate: 100,
    materials: [{ selfId: 203, amount: 2 }] };
recipeVariants = [{ ...recipe, materials: [{ selfId: 202, amount: 24 }] }, component];
const shortBoard = new BoardIndex();
shortBoard.put({ id: 61, ownerId: 2, storeType: 1, kind: 'sell_ad', town: 'Giran', revision: 1,
    lines: [{ lineId: 61, selfId: 202, count: 8, price: 1 }] });
shortBoard.put({ id: 62, ownerId: 3, storeType: 1, kind: 'sell_ad', town: 'Giran', revision: 1,
    lines: [{ lineId: 62, selfId: 203, count: 48, price: 2 }] });
const componentService = { ...publicService, characterId: 4, recipeId: 303, price: 1, entryPrice: 1, capacityBatches: 30 };
const shortDeps = { board: shortBoard,
    workshops: recipeId => [publicService, componentService].filter(row => row.recipeId === recipeId) };
const routed = run(true, { deps: shortDeps, context: { board: shortBoard, price: id => id === 101 ? 100 : id === 202 ? 20 : 1 } });
const cheapShort = run(true, { deps: shortDeps, context: { board: shortBoard } });
recipeVariants = [recipe];
assert.equal(routed.plans.find(([key]) => key === 'item:202')[1].kind, 'craft',
    'an input the town sells only in part is crafted at the published workshop when that costs less for all units');
assert.equal(routed.plans.find(([key]) => key === 'item:101')[1].executable, true, 'the gear craft runs on the crafted input');
assert.equal(cheapShort.plans.find(([key]) => key === 'item:202')[1].kind, 'buy',
    'a partly sold input that costs less for all units than the workshop stays a buy');
// A gear root ranks by completion: a craft whose input buy is short (its
// units all there in 5 h) finishes after a gear buy ready in 2 h.
const shortInputNodes = [{ key: 'gear', need: 'power', price: 1, valueHours: 100, progressionPriority: 1,
    paths: [{ kind: 'craft', activity: 'crafting', price: 0, costHours: 0.5, requirements: [{ key: 'part', amount: 2 }] },
        { kind: 'buy', activity: 'shopping', price: 10, executable: true, quoted: true, town: 'Giran', costHours: 2 }] },
{ key: 'part', paths: [{ kind: 'buy', activity: 'shopping', price: 1, executable: true, quoted: true,
    availableUnits: 1, town: 'Giran', shortHours: 5 }] }];
const shortInput = new network.WishNetwork().build({ actorKey: 'shortInput', inputKey: 'shortInput', nodes: shortInputNodes,
    roots: ['gear'], wallet: 1000, hourAdena: 100, persona, remembered: false });
assert.equal(shortInput.plans.get('gear').kind, 'buy', 'a short input buy delays its parent craft');
// The same craft when Giran's one ask of the input is held by two rival
// takers (no supply: never) and Dion sells 8 of the 24 at 2: the market
// without Giran's asks (the elsewhere buy) is priced for all 24 like any buy.
// At 20 a unit for the 16 Dion lacks the workshop (5 a unit) wins and the gear
// craft runs; at 3 a unit the Dion buy (2.67 a unit for all 24) stays the
// route, under the workshop, and the bot buys the 8 Dion sells now. Giran's
// held unit is not on sale to the bot (its wait: rivals + 1 - 1 units over no
// supply, never), so even at 2 a unit, where Giran's unit priced for all 24
// (1.96) would cost less than Dion's (2), the bot buys in Dion.
const Exits = require('../src/GameServer/Bot/Economy/CommittedExits');
const heldBoard = new BoardIndex();
heldBoard.put({ id: 71, ownerId: 2, storeType: 1, kind: 'sell_ad', town: 'Giran', revision: 1,
    lines: [{ lineId: 71, selfId: 202, count: 1, price: 1 }] });
heldBoard.put({ id: 72, ownerId: 3, storeType: 1, kind: 'sell_ad', town: 'Dion', revision: 1,
    lines: [{ lineId: 72, selfId: 202, count: 8, price: 2 }] });
heldBoard.put({ id: 73, ownerId: 5, storeType: 1, kind: 'sell_ad', town: 'Giran', revision: 1,
    lines: [{ lineId: 73, selfId: 203, count: 48, price: 2 }] });
const heldTakers = [991, 992];
for (const id of heldTakers) Exits.commit(id, [Exits.takerRow({ kind: 'buy', sourceType: 'afk', itemId: 202, amount: 1, town: 'Giran' })]);
recipeVariants = [{ ...recipe, materials: [{ selfId: 202, amount: 24 }] }, component];
const heldDeps = { ...shortDeps, board: heldBoard };
const heldContext = { board: heldBoard, trip: twoTowns };
const heldRouted = run(true, { deps: heldDeps, context: { ...heldContext, price: id => id === 101 ? 100 : id === 202 ? 20 : 1 } });
const heldCheap = run(true, { deps: heldDeps, context: { ...heldContext, price: id => id === 101 ? 100 : id === 202 ? 3 : 1 } });
const heldCheaper = run(true, { deps: heldDeps, context: { ...heldContext, price: id => id === 101 ? 100 : id === 202 ? 2 : 1 } });
// The same held ask when 3 published workshop variants craft the input
// (wishcap 2026-10-25): the input's node holds 4 own paths (the held buy, 3
// crafts) and the Dion buy past them. The build takes that node (before: 5
// paths, invalid_wish_node, a full rebuild every step) and the bot buys what
// Dion sells now.
const variantServices = [304, 305].map(recipeId => ({ ...componentService, characterId: recipeId, recipeId }));
recipeVariants = [{ ...recipe, materials: [{ selfId: 202, amount: 24 }] }, component,
    ...variantServices.map(row => ({ ...component, recipeId: row.recipeId, recipeItemId: row.recipeId + 100 }))];
const variantWorkshops = recipeId => [publicService, componentService, ...variantServices].filter(row => row.recipeId === recipeId);
const heldVariants = run(true, { deps: { ...heldDeps, workshops: variantWorkshops },
    context: { ...heldContext, price: id => id === 101 ? 100 : id === 202 ? 3 : 1 } });
recipeVariants = [recipe];
for (const id of heldTakers) Exits.remove(id);
assert.deepEqual([heldVariants.activity?.activity, heldVariants.activity?.object, heldVariants.activity?.town, heldVariants.activity?.amount],
    ['shopping', 202, 'Dion', 8], 'an input with 4 own paths keeps the other town\'s buy and the bot buys there now');
assert.equal(heldRouted.plans.find(([key]) => key === 'item:202')[1].kind, 'craft',
    'the workshop wins over another town\'s buy short of the units the craft needs');
assert.equal(heldRouted.plans.find(([key]) => key === 'item:101')[1].executable, true, 'the gear craft runs on the crafted input');
assert.equal(heldCheap.activity?.activity, 'shopping', 'a short buy that costs less for all units stays the route');
assert.deepEqual([heldCheap.activity.object, heldCheap.activity.town, heldCheap.activity.amount], [202, 'Dion', 8],
    'the bot buys what the other town sells now');
assert.deepEqual([heldCheaper.activity?.activity, heldCheaper.activity?.object, heldCheaper.activity?.town, heldCheaper.activity?.amount],
    ['shopping', 202, 'Dion', 8], 'a unit rival takers hold is not bought now, however cheap: the other town\'s buy is the route');
console.log('PASS partial buy: priced and timed for all units, the route that costs less for all of them wins, a short input delays its craft');
// A short buy's completion queues behind every other buyer's bids on the
// item (luxwait 2026-10-25): the craft needs 1075 of an input Giran sells 75
// of, supply 100 a hour, no rival takers. With 40000 units of other bots' bid
// lines on the board (any town) at the planning price (1: price(id), NPC
// buy-back 0) the 1000 units it lacks arrive after theirs:
// (40000 + 1 + 999) / 100 = 410 h. Its own 5000-unit bid line is no rival:
// with only that line on the board the same buy completes in 10 h. Sellers
// fill the higher bid first and the queue is read at the planning price
// max(price(id), buyback) (luxwait2, luxwait3): with a buy-back of 3 the
// others' bids at 2 wait behind it, none ahead: 10 h (410 h when the price
// is not passed). Its own line never sets its place: a line at 1 below the
// others' leaves that 10 h, a line at 5 above them leaves the 410 h.
const Demand = require('../src/GameServer/Bot/Economy/MarketDemand');
Demand.reset();
Demand.deal(202, 100, 'Giran', context.timestamp);
const luxBoard = (othersPrice, ownPrice) => {
    const board = new BoardIndex();
    board.put({ id: 81, ownerId: 2, storeType: 1, kind: 'sell_ad', town: 'Giran', revision: 1,
        lines: [{ lineId: 81, selfId: 202, count: 75, price: 1 }] });
    if (ownPrice) board.put({ id: 82, ownerId: 1, storeType: 3, kind: 'buy_ad', town: 'Giran', revision: 1,
        lines: [{ lineId: 82, selfId: 202, count: 5000, price: ownPrice }] });
    if (othersPrice) {
        board.put({ id: 83, ownerId: 7, storeType: 3, kind: 'buy_ad', town: 'Giran', revision: 1,
            lines: [{ lineId: 83, selfId: 202, count: 20000, price: othersPrice }] });
        board.put({ id: 84, ownerId: 8, storeType: 3, kind: 'buy_ad', town: 'Dion', revision: 1,
            lines: [{ lineId: 84, selfId: 202, count: 20000, price: othersPrice }] });
    }
    return board;
};
recipeVariants = [{ ...recipe, materials: [{ selfId: 202, amount: 1075 }] }];
const luxHours = (othersPrice, ownPrice, buyback = 0) => {
    const board = luxBoard(othersPrice, ownPrice);
    const plan = run(true, { deps: { board }, context: { board, buyback: id => id === 202 ? buyback : 0 } })
        .plans.find(([key]) => key === 'item:202')[1];
    assert.equal(plan.kind, 'buy');
    return plan.shortHours;
};
const queuedHours = luxHours(1, 1), ownHours = luxHours(0, 1), aboveHours = luxHours(1, 5);
const pricedHours = luxHours(2, 0, 3), pricedOwnHours = luxHours(2, 1, 3);
recipeVariants = [recipe];
Demand.reset();
assert.ok(Math.abs(queuedHours - 410) < 1e-6, `the missing units arrive after the other buyers' bids (${queuedHours} h)`);
assert.ok(Math.abs(ownHours - 10) < 1e-6, `the bot's own bid line is no rival (${ownHours} h)`);
assert.ok(Math.abs(pricedHours - 10) < 1e-6, `bids below the planning price are no rivals (${pricedHours} h)`);
assert.ok(Math.abs(pricedOwnHours - 10) < 1e-6, `an own bid below the others' is not its place (${pricedOwnHours} h)`);
assert.ok(Math.abs(aboveHours - 410) < 1e-6, `an own bid above the others' is not its place (${aboveHours} h)`);
console.log('PASS short buy completion: queued behind other buyers\' bids at or above the planning price, own bids excluded');

// A buy of more units than one ask holds: its quote takes the town's asks up
// to its unit price, the meeting buy takes them ad by ad (the cheaper ad of 20
// first, the rest on a later step) and the leaf check keeps the leaf while
// the town still sells what is left at that price.
const Ready = require('../src/GameServer/Bot/Economy/ReadyTradeChoice');
const meetBoard = new BoardIndex();
meetBoard.put({ id: 31, ownerId: 2, storeType: 1, kind: 'sell_ad', custodyPolicy: 1, revision: 1, town: 'Dion',
    lines: [{ lineId: 31, selfId: 202, count: 20, price: 2 }] });
meetBoard.put({ id: 32, ownerId: 3, storeType: 1, kind: 'sell_ad', custodyPolicy: 1, revision: 1, town: 'Dion',
    lines: [{ lineId: 32, selfId: 202, count: 25, price: 3 }] });
const dionTrip = town => town === 'Dion' ? 0 : Infinity;
dionTrip.details = town => ({ known: town === 'Dion', hours: 0, fees: 0 });
const quote45 = Evidence.reader(state, { ...context, board: meetBoard, trip: dionTrip }, { board: meetBoard, npcOffersFor: () => [] })(202, 45);
assert.deepEqual([quote45.town, quote45.unitPrice, quote45.availableUnits, quote45.price], ['Dion', 3, 45, 115 / 45]);
const leaf45 = { activity: 'shopping', kind: 'buy', sourceType: 'afk', quoted: true, executable: true,
    itemId: 202, amount: 45, unitPrice: 3, town: 'Dion' };
assert(Ready.preparedLeaf(meetBoard.list(202, require('../src/GameServer/AfkTrade/BoardIndex').SELL, 'Dion')[0], leaf45, 20, 202), 'an ask under the quoted unit price is the prepared buy');
assert.deepEqual(Ready.purchase({ characterId: 1, inventory: {} }, { network: { activity: leaf45 } }, meetBoard),
    [1, 202, 20, 31, 31, 1, 2], 'the buy of 45 takes the cheaper ad of 20 first');
const buyer = adena => ({ characterId: 1, level: 40, inventory: {}, stats: {}, adena });
const reserve = NativeEconomy.survivalReserve(buyer(0));
const leafCheck = adena => NativeEconomy.leafCheck(buyer(adena), leaf45,
    { board: meetBoard, tripCost: dionTrip, npcOffersFor: () => [] }, { heldUnits: undefined });
assert.equal(leafCheck(reserve + 120), '', 'the leaf holds while its town sells 45 at most at 3 and the money pays their mean 115 (not 45 x 3)');
// A standing bid for the same lot in Dion is not crossed by the town's
// meeting-only ads (T76: a bid does not yield to a meeting).
const Alternative = require('../src/GameServer/Bot/Economy/BidPurchaseAlternative');
const bidCtx = { travelDetails: dionTrip.details, hour: 0, board: meetBoard, characterId: 1, state: { characterId: 1 },
    npcOffersFor: () => [] };
const bidCap = price => Alternative.cap(202, bidCtx, { units: 45, town: 'Dion', money: 1000000, price });
assert.notEqual(bidCap(Math.ceil(quote45.price)), 0, 'a bid at the mean of the town\'s 45 meeting-only ads stands');
// Twenty cheaper lines the buy never takes (enchanted) leave the town's
// ads to the buy the quote counted.
const hiddenBoard = new BoardIndex();
for (let id = 50; id < 70; id++) hiddenBoard.put({ id, ownerId: id, storeType: 1, kind: 'sell_ad', custodyPolicy: 1, revision: 1,
    town: 'Dion', lines: [{ lineId: id, selfId: 202, enchant: 1, count: 5, price: 1 }] });
hiddenBoard.put({ id: 31, ownerId: 2, storeType: 1, kind: 'sell_ad', custodyPolicy: 1, revision: 1, town: 'Dion',
    lines: [{ lineId: 31, selfId: 202, count: 20, price: 2 }] });
hiddenBoard.put({ id: 32, ownerId: 3, storeType: 1, kind: 'sell_ad', custodyPolicy: 1, revision: 1, town: 'Dion',
    lines: [{ lineId: 32, selfId: 202, count: 25, price: 3 }] });
const hiddenQuote = Evidence.reader(state, { ...context, board: hiddenBoard, trip: dionTrip }, { board: hiddenBoard, npcOffersFor: () => [] })(202, 45);
assert.deepEqual([hiddenQuote.town, hiddenQuote.unitPrice, hiddenQuote.price], ['Dion', 3, 115 / 45]);
assert.deepEqual(Ready.purchase({ characterId: 1, inventory: {} }, { network: { activity: leaf45 } }, hiddenBoard),
    [1, 202, 20, 31, 31, 1, 2], 'the buy reads past lines it never takes, as the quote does');
// A later step: the ad of 20 is gone and 5 of the lot arrived from it; the
// buy takes the ad of 25 for all it holds, the rest on a further step.
meetBoard.remove(31);
assert.deepEqual(Ready.purchase({ characterId: 1, inventory: { 202: { amount: 5 } } },
    { network: { activity: { ...leaf45, heldAtDecision: 0 } } }, meetBoard), [1, 202, 25, 32, 32, 1, 3],
'the rest of the buy takes the next ad');
// The one-unit quote serves larger amounts only while no town lands them
// cheaper: Giran sells 30 at 5 at home, Dion 50 at 4 behind a
// 20-adena trip, cheaper with its trip from 20 units on (the tie goes to Dion
// by name).
const twoBoard = new BoardIndex();
twoBoard.put({ id: 41, ownerId: 2, storeType: 1, kind: 'sell_ad', revision: 1, town: 'Giran', lines: [{ lineId: 41, selfId: 202, count: 30, price: 5 }] });
twoBoard.put({ id: 42, ownerId: 3, storeType: 1, kind: 'sell_ad', revision: 1, town: 'Dion', lines: [{ lineId: 42, selfId: 202, count: 50, price: 4 }] });
const feeTrip = town => town === 'Giran' ? 0 : town === 'Dion' ? 20 : Infinity;
feeTrip.details = town => ({ known: ['Giran', 'Dion'].includes(town), hours: 0, fees: feeTrip(town) });
const twoQuote = Evidence.reader(state, { ...context, board: twoBoard, trip: feeTrip }, { board: twoBoard, npcOffersFor: () => [] });
for (let n = 1; n <= 25; n++) {
    const quoted = twoQuote(202, n);
    assert.deepEqual([quoted.town, quoted.price], n < 20 ? ['Giran', 5] : ['Dion', 4], `the buy of ${n}`);
}
console.log('PASS sized buys: quote = meeting buy ad by ad = leaf check; one-unit quote = full table below its bound');
