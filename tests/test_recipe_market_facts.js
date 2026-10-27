'use strict';
// The shared market facts of a recipe (RecipeProductionIndex.marketFacts):
// what one craft earns over its inputs at the market's shared prices, the
// same for every crafter, following the board; a scroll's derived demand
// (PriceBelief.demandValue) reads that margin.
const assert = require('assert');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
const PriceBelief = invoke('GameServer/Bot/Economy/PriceBelief');
const Production = invoke('GameServer/Bot/Economy/RecipeProductionIndex');
const Profit = invoke('GameServer/Bot/Economy/CraftProfitPolicy');
const { BoardIndex, SELL, BUY } = require('../src/GameServer/AfkTrade/BoardIndex');

const now = 1800000000000;
MarketCounters.reset();
// Chakram: scroll 2311, product 263, a dwarven recipe with market inputs.
const recipe = Recipes.resolveByRecipeId(204);
assert(recipe && Number(recipe.productId) === 263, 'Chakram recipe in the game data');
const inputs = [...Profit.requirements(recipe, 1)];
const count = Number(recipe.productCount || 1);

let record = 0;
const list = (board, ownerId, storeType, selfId, price) => board.put({ id: ++record, ownerId, storeType, town: 'Giran',
    lines: [{ lineId: record, selfId, count: 5, price }] });
const marketBoard = (inputPrice) => {
    const board = new BoardIndex({ groupOf: MarketCounters.counterOf });
    list(board, 900, BUY, 263, 3000000);
    for (const [input] of inputs) list(board, 901, SELL, input, inputPrice(input));
    return board;
};

// The input a recipe needs most of.
const [heaviest] = inputs.reduce((best, row) => row[1] > best[1] ? row : best);
const scrollId = Number(recipe.recipeItemId);

// 1. A reader's own line is no source of its own facts: a crafter's own bid
// on an input leaves the scroll demand it reads where the others' lines put
// it (no bid -> facts move -> rebuild -> bid withdrawn loop); another
// reader sees the bid.
{
    const board = marketBoard(() => 100);
    const demand = characterId => PriceBelief.demandValue(scrollId, { characterId, board, timestamp: now });
    const before = demand(77);
    assert(before > 0, 'cheap inputs: the scroll has a derived demand');
    list(board, 77, BUY, heaviest, 50);
    assert(Math.abs(demand(77) - before) < 1e-6, 'its own bid does not move its own scroll demand');
    assert(Math.abs(demand(78) - before) > 1e-6, 'another reader sees the bid');
}

// 2. The facts follow the market through a build's view of the board (an
// object whose prototype is the board, as EconomyContext's watched board):
// a cheaper input on the board (the worker's board path, index.update)
// raises the margin every crafter reads, and a scroll's price read in a
// build joins its recipe's items to the build's reads, also when the facts
// are held.
{
    const board = marketBoard(() => 50000);
    const index = Production.forBoard(board, { censusBuyer: () => false });
    const view = Object.assign(Object.create(board), {
        first: (...args) => board.first(...args), list: (...args) => board.list(...args) });
    const before = Production.marketFacts(recipe, { board: view, timestamp: now }).margin;
    list(board, 902, SELL, heaviest, 1);
    index.update(heaviest);
    const after = Production.marketFacts(recipe, { board: view, timestamp: now }).margin;
    assert(after > before, 'a cheaper input raises the recipe margin');
    const reads = new Set();
    PriceBelief.reader({ state: { characterId: 5 }, persona: { understanding: 0.5 }, board: view, timestamp: now,
        knowledgeEnabled: false, read: id => reads.add(id) }).price(scrollId);
    assert(inputs.every(([input]) => reads.has(Number(input))), "a scroll's price reads its recipe's inputs");
}

// 2b. Main: a deal of an input (MarketCounters.deal, main's market hook)
// moves the facts of the board's index as a board line does.
{
    const board = marketBoard(() => 50000);
    Production.forBoard(board, { censusBuyer: () => false });
    const before = Production.marketFacts(recipe, { board, timestamp: now }).margin;
    for (let at = 0; at < 5; at++) MarketCounters.deal(heaviest, 1, 10, now);
    const after = Production.marketFacts(recipe, { board, timestamp: now }).margin;
    assert(after > before, 'cheap deals of an input raise the held recipe margin');
    MarketCounters.reset();
}

// 2c. A crafter's input cost from the shared facts is the price its input
// nodes read (PriceBelief.reader price: its own error, its own lines left
// out): one input cost per build.
{
    const board = marketBoard(input => 1000 + Number(input));
    list(board, 31, SELL, heaviest, 400);
    const reader = PriceBelief.reader({ state: { characterId: 31, marketTrades: {} }, persona: { understanding: 0 },
        board, timestamp: now, knowledgeEnabled: true });
    const own = PriceBelief.reader({ state: { characterId: 31, marketTrades: {} }, persona: { understanding: 0 },
        board, timestamp: now, knowledgeEnabled: true });
    const facts = Production.marketFacts(recipe, { board, timestamp: now });
    const cost = Production.inputCostFor(facts, 31, reader.fromShared);
    const nodes = inputs.reduce((sum, [input, amount]) => sum + amount * own.price(input), 0);
    assert(Math.abs(cost - nodes) < 1e-6 * nodes, 'admission pays the inputs at the price its nodes read');
}

// 3. A scroll's derived demand is its recipe's margin of one craft: a
// recipe that earns lifts its scroll's price; one that loses adds nothing.
{
    const earning = marketBoard(() => 1);
    const losing = marketBoard(() => 10000000);
    const ctx = board => ({ characterId: 1, understanding: 0.5, timestamp: now, board, knowledgeEnabled: false, marketTrades: {} });
    const margin = Production.marketFacts(recipe, { board: earning, timestamp: now }).margin;
    assert(margin > 0, 'cheap inputs: the recipe earns');
    assert(Math.abs(PriceBelief.demandValue(Number(recipe.recipeItemId), ctx(earning)) - margin) < 1e-6,
        'an earning recipe gives its scroll a derived demand of one craft margin');
    assert.strictEqual(PriceBelief.demandValue(Number(recipe.recipeItemId), ctx(losing)), null,
        'a losing recipe gives its scroll no derived demand');
    assert(PriceBelief.prior(Number(recipe.recipeItemId), ctx(earning)).mu
        > (PriceBelief.prior(Number(recipe.recipeItemId), ctx(losing))?.mu ?? -Infinity),
        'the scroll of an earning recipe is worth more');
}

// 5. A spoiler's spot values the recipe scrolls it spoils at what their
// recipe earns over the NPC price: the same spot is worth more when the
// spoiled scroll's recipe earns than when it loses.
{
    const Economics = invoke('GameServer/Bot/Economy/SpotEconomics');
    const Table = invoke('GameServer/Bot/AI/SpotValueTable');
    const Rewards = invoke('GameServer/Bot/Economy/SpotRewardExpectation');
    const Config = invoke('GameServer/Bot/Population/PopulationConfig');
    // Bounty Hunter (class 55) learns Spoil (skill 254) level 6 at level 49
    // (data/Skills/Tree/tree.json); a bot's skills are its saved combat kit.
    const spoiler = { characterId: 990301, level: 50, adena: 3000, stats: { classId: 55, money: [3719, 0.0001, 1000, 900000],
        coldCombat: { classId: 55, skillSource: 'database', skills: [{ selfId: 254, level: 6 }] } } };
    const skill = Rewards.spoilSkillLevel(spoiler);
    assert(skill > 0, 'a level 50 Bounty Hunter spoils');
    const boardFor = (scrollRecipe, inputPrice) => {
        const board = new BoardIndex({ groupOf: MarketCounters.counterOf });
        list(board, 900, BUY, Number(scrollRecipe.productId), 50000000);
        for (const [input] of Profit.requirements(scrollRecipe, 1) || []) list(board, 901, SELL, input, inputPrice);
        return board;
    };
    // A spot of the game data whose spoil list holds an earning scroll.
    let found = null;
    const spots = JSON.parse(require('fs').readFileSync(require('path').resolve(__dirname, '../data/Bots/spot-reward-npcs.json'), 'utf8')).rows;
    for (const [spotId] of spots) {
        for (const [scrollId, units, npcPrice] of Table.recipeScrolls(spotId, 'spoiler', 50, true, { spoilSkillLevel: skill })) {
            const scrollRecipe = Recipes.resolve(scrollId);
            if (!scrollRecipe || !(units > 0)) continue;
            const earning = boardFor(scrollRecipe, 1);
            if (Production.scrollValue(scrollId, { board: earning, timestamp: now }) > npcPrice) {
                found = { spotId, scrollRecipe, earning, losing: boardFor(scrollRecipe, 100000000), worse: boardFor(scrollRecipe, 1000000000) };
                break;
            }
        }
        if (found) break;
    }
    assert(found, 'the game data has a spot that spoils an earning recipe scroll');
    const saved = Config.knowledgeErrorsEnabled;
    try {
        Config.knowledgeErrorsEnabled = false;
        // The spot's measured combat hour (offline table) and the bot's own hunt.
        const options = (board, read) => ({ persona: { traits: {}, understanding: 0.5 }, deathHours: 0, moneyWeight: 1, timestamp: now, board, read });
        const earning = Economics.create(spoiler, options(found.earning))({ id: found.spotId });
        const losing = Economics.create(spoiler, options(found.losing))({ id: found.spotId });
        assert(earning.valueHours > losing.valueHours, 'an earning spoiled scroll raises the spot value');
        const worse = Economics.create(spoiler, options(found.worse))({ id: found.spotId });
        assert.strictEqual(worse.loot, losing.loot, 'a losing scroll adds nothing over its NPC price, however much it loses');
        // Every value reports the scroll facts it priced to its build's read
        // hook, also a second value of the same scroll: a gear candidate's
        // arena keeps only a retained candidate's reads, so a value first read
        // by a cut candidate must still enter the retained one's.
        let reads = new Set();
        const value = Economics.create(spoiler, options(found.earning, id => reads.add(Number(id))));
        value({ id: found.spotId });
        reads = new Set();
        value({ id: found.spotId });
        const items = Production.marketFacts(found.scrollRecipe, { board: found.earning, timestamp: now }).items;
        assert(items.length > 0 && items.every(id => reads.has(Number(id))), 'a second value of a scroll reads its facts items again');
    } finally {
        Config.knowledgeErrorsEnabled = saved;
    }
}

// 6. A crafter that can learn the recipe values the scroll at the crafts its
// open units sell over the horizon; every other reader keeps one craft's
// margin (the scroll's derived demand). No open units past this lot: the
// crafter keeps only what later sales carry of the price.
{
    const board = marketBoard(() => 1);
    const margin = Production.scrollValue(Number(recipe.recipeItemId), { board, timestamp: now });
    assert(margin > 0, 'cheap inputs: the scroll earns');
    const crafter = Profit.keptRecipeValue({ price: 0, share: 0, margin, perCraft: count, units: count,
        ratePerHour: 0.5, horizonHours: 40, tripCost: 1000 });
    assert(crafter > margin, 'a crafter with open units bids more than one craft is worth to others');
    const saturated = Profit.keptRecipeValue({ price: 0, share: 0, margin, perCraft: count, units: 20 * count,
        ratePerHour: 0.5, horizonHours: 40, tripCost: 1000 });
    assert(saturated < crafter, 'a crafter whose open units this lot already takes values the scroll below one with units left');
}

// 7. May a recipe scroll be sold: not while its holder would learn it. A
// crafter's unknown scroll (in its bag or back from its own line) is no sale
// candidate; once known, or for a bot that cannot craft it, it is.
{
    const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
    const scrollId = Number(recipe.recipeItemId);
    const holder = craftLevel => ({ characterId: 990302, level: 60, craftLevel, stats: { classId: 57 },
        inventory: { [scrollId]: { selfId: scrollId, amount: 1, name: 'Recipe' } } });
    const sells = (state, options = {}) => Disposition.saleCandidates(state, { unlimited: true, keptAmounts: {},
        preparedReservations: {}, ...options }).some(row => row.selfId === scrollId);
    assert.strictEqual(sells(holder(9)), false, 'a crafter keeps a scroll it would learn');
    assert.strictEqual(sells(holder(9), { knownRecipes: [Number(recipe.recipeId)] }), true, 'a known recipe\'s scroll is sold');
    assert.strictEqual(sells(holder(0)), true, 'a bot that cannot craft it sells it');
}

// 5b. Scroll as loot is one answer for every hunter: a non-spoiler's spot
// values the recipe scrolls its kills drop at what their recipe earns, as a
// spoiler's does its spoils.
{
    const Economics = invoke('GameServer/Bot/Economy/SpotEconomics');
    const Table = invoke('GameServer/Bot/AI/SpotValueTable');
    const Roles = invoke('GameServer/Bot/AI/BotRoles');
    const Config = invoke('GameServer/Bot/Population/PopulationConfig');
    const hunter = { characterId: 990303, level: 50, adena: 3000, stats: { classId: 2, money: [3719, 0.0001, 1000, 900000] } };
    const role = Roles.tableRoleFor(hunter);
    const boardFor = (scrollRecipe, inputPrice) => {
        const board = new BoardIndex({ groupOf: MarketCounters.counterOf });
        list(board, 900, BUY, Number(scrollRecipe.productId), 50000000);
        for (const [input] of Profit.requirements(scrollRecipe, 1) || []) list(board, 901, SELL, input, inputPrice);
        return board;
    };
    let found = null;
    const spots = JSON.parse(require('fs').readFileSync(require('path').resolve(__dirname, '../data/Bots/spot-reward-npcs.json'), 'utf8')).rows;
    for (const [spotId] of spots) {
        for (const [scrollId, units, npcPrice] of Table.recipeScrolls(spotId, role, 50, true, { spoilSkillLevel: 0 })) {
            const scrollRecipe = Recipes.resolve(scrollId);
            if (!scrollRecipe || !(units > 0)) continue;
            const earning = boardFor(scrollRecipe, 1);
            if (Production.scrollValue(scrollId, { board: earning, timestamp: now }) > npcPrice) {
                found = { spotId, earning, losing: boardFor(scrollRecipe, 100000000) };
                break;
            }
        }
        if (found) break;
    }
    assert(found, 'the game data has a spot whose kills drop an earning recipe scroll');
    const saved = Config.knowledgeErrorsEnabled;
    try {
        Config.knowledgeErrorsEnabled = false;
        const options = board => ({ persona: { traits: {}, understanding: 0.5 }, deathHours: 0, moneyWeight: 1, timestamp: now, board });
        const earning = Economics.create(hunter, options(found.earning))({ id: found.spotId });
        const losing = Economics.create(hunter, options(found.losing))({ id: found.spotId });
        assert(earning.loot > losing.loot, 'an earning dropped scroll raises a non-spoiler\'s spot loot');
    } finally {
        Config.knowledgeErrorsEnabled = saved;
    }
}

// 9. A producer root's kept recipe value (WishProviders keptHours: the
// learned recipe's later crafts) is the bot's whatever this lot's rolls give:
// a 60% recipe's lot of three batches keeps all of it, less only the hours
// before the root is ready (keptPerHour x ready hours); the lot's own sale
// carries the success chance.
{
    const { WishNetwork } = invoke('GameServer/Bot/Economy/WishNetwork');
    const solve = keptHours => {
        const root = { key: 'resale:101', need: 'power', object: { itemId: 101, amount: 3, kind: 'resale' }, valueHours: 100,
            keptHours, keptPerHour: keptHours / 40, price: 30, paths: [{ kind: 'craft', activity: 'crafting', itemId: 101,
                recipeId: 101, costHours: 0.5, productCount: 3, perCommand: 1, successProbability: 0.6, quoted: true,
                grossRequirements: [{ key: 'item:202', amount: 3 }] }] };
        const material = { key: 'item:202', price: 10, paths: [{ kind: 'buy', activity: 'shopping', price: 10, itemId: 202,
            executable: true, quoted: true, availableUnits: 1000 }] };
        return new WishNetwork().build({ actorKey: 'kept', inputKey: `kept-${keptHours}`, nodes: [root, material], roots: [root.key],
            wallet: 100000, hourAdena: 100, persona: { traits: { commitment: 0 } }, remembered: false })
            .queue.find(wish => wish.key === root.key);
    };
    const without = solve(0), kept = solve(20);
    assert(without && kept && kept.plan.successProbability < 1, 'the lot is a chance');
    const delayed = 20 - 20 / 40 * kept.readyHours;
    assert(Math.abs(kept.valueHours - without.valueHours - delayed) < 1e-9,
        `the kept recipe value is credited whole after the ready delay: ${kept.valueHours - without.valueHours} != ${delayed}`);
}

// 8. The recipes a bot knows are one list on each thread: the given book
// (ids or rows) as it is, else main's workshop cache of the bot's book, so
// a scroll of a recipe known only there is sold by a main reader that
// passes no book.
(async () => {
    const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
    assert.deepStrictEqual(Disposition.knownRecipeIds({}, [301, { recipeId: 301 }, 302, 0, NaN]), [301, 302],
        'a book of ids or rows gives its recipes once each');
    const scrollId = Number(recipe.recipeItemId), characterId = 990304;
    const holder = { characterId, level: 60, craftLevel: 9, stats: { classId: 57 },
        inventory: { [scrollId]: { selfId: scrollId, amount: 1, name: 'Recipe' } } };
    // The database fixture: the bot's learned recipes as main loads them.
    invoke('Database').fetchCharacterRecipes = async () => [{ recipeId: Number(recipe.recipeId) }];
    await invoke('GameServer/Bot/Economy/CraftWorkshopService').knownFor(characterId);
    const sold = Disposition.saleCandidates(holder, { unlimited: true, keptAmounts: {}, preparedReservations: {} })
        .some(row => row.selfId === scrollId);
    assert.strictEqual(sold, true, 'a recipe known in the bot\'s book on main: its scroll is sold');
    console.log('recipe market facts ok');
})().catch(error => { console.error(error); process.exit(1); });
