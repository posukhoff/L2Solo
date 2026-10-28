'use strict';
// The shared market facts of a recipe (RecipeProductionIndex.marketFacts):
// what one craft earns over its inputs at the market's shared prices, the
// same for every crafter, following the board; a scroll's price mixes no
// derived demand (its shared worth is DemandPrice's, test_demand_price).
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

// 2. The facts follow the market through a build's view of the board (an
// object whose prototype is the board, as EconomyContext's watched board):
// a cheaper input on the board (the worker's board path, index.update)
// raises the margin every crafter reads.
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

// 3. A scroll's price is its public sources only (decisions 10-28: no
// per-crafter recipe value, the shared worth only caps a learner's bid): an
// earning recipe and a losing one give its scroll the same belief.
{
    const earning = marketBoard(() => 1);
    const losing = marketBoard(() => 10000000);
    const ctx = board => ({ characterId: 1, understanding: 0.5, timestamp: now, board, knowledgeEnabled: false, marketTrades: {} });
    assert(Production.marketFacts(recipe, { board: earning, timestamp: now }).margin > 0, 'cheap inputs: the recipe earns');
    assert.strictEqual(PriceBelief.prior(scrollId, ctx(earning))?.mu, PriceBelief.prior(scrollId, ctx(losing))?.mu,
        'the recipe\'s margin does not move its scroll\'s price');
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
