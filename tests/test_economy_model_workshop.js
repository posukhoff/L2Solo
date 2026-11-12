'use strict';

// The economy design's account-plane rules on inline fixtures: a crafter
// twin's workshop picks crafts by adena per MP with the success rate, keeps
// at most one unsold gear piece per recipe, stops a recipe whose margin is not
// positive, sizes a batch by the MP it holds and an hour of seated regen,
// keeps its buy lines within its wallet and its store slots, and takes a
// recipe into a full book only over the worst it holds. Its lines move only
// at its own looks; a seller's floor reads crystallizer bids only in the
// towns it reaches; the price memory keeps the 16 newest deals. Its store
// mode remembers only stints in which something filled; its crystallizer
// bid stops at the cheapest gear route it reaches; an input nobody offers
// adds no margin. The readings of the design's text and ours: a crafted
// good's first price with or without its MP, a seller's look, its floor.
const assert = require('node:assert/strict');
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} against ${expected}`);
const Workshop = require('../scripts/economy-model/rules/workshop');
const { ownLines } = require('../scripts/economy-model/rules/ownLines');
const Knowledge = require('../scripts/economy-model/rules/knowledge');

const ORE = 1785, CRYSTAL = 1458, SSD = 1463, RISKY = 9001, SWORD = 2001, BONE = 1872;
const recipe = (recipeId, productId, { level = 2, mpCost = 40, productCount = 156, successRate = 100, materials = [{ selfId: ORE, amount: 3 }, { selfId: CRYSTAL, amount: 1 }] } = {}) =>
    ({ type: 'dwarven', recipeId, recipeItemId: 5000 + recipeId, level, materials, productId, productCount, mpCost, successRate, quest: false });
function gameOf(rows, extraItems = {}, firstPrice = {}) {
    const recipes = Object.fromEntries(rows.map(row => [row.recipeId, row]));
    const items = {
        [ORE]: { kind: 'Other.Material', grade: 'NONE', npcBuy: 125 },
        [CRYSTAL]: { kind: 'Other.Crystal', grade: 'D', npcBuy: 325 },
        [SSD]: { kind: 'Other.Shot', grade: 'D', npcBuy: 5 },
        [RISKY]: { kind: 'Other.Shot', grade: 'D', npcBuy: 5 },
        [SWORD]: { kind: 'Weapon.Sword', grade: 'D', npcBuy: 1000, crystals: 100 },
        [BONE]: { kind: 'Other.Material', grade: 'NONE', npcBuy: 20 },
        ...extraItems
    };
    for (const row of rows) items[row.recipeItemId] ||= { kind: 'Other.Recipe', grade: 'NONE', npcBuy: 50 };
    const byProduct = {};
    for (const row of rows) (byProduct[row.productId] ||= []).push(row.recipeId);
    return { recipes, items, byProduct, byScroll: Object.fromEntries(rows.map(row => [row.recipeItemId, row.recipeId])),
        dwarven: rows.map(row => row.recipeId), questRecipes: [], crystalIds: { D: CRYSTAL }, crystalGrade: { [CRYSTAL]: 'd' },
        sourced: { [ORE]: true, [BONE]: true }, firstPrice: { [SSD]: 10, [RISKY]: 15, [SWORD]: 50000, [CRYSTAL]: 605, [ORE]: 300, [BONE]: 20, ...firstPrice } };
}
// The design's text for the four readings; OURS the model's defaults.
const TEXT = { crystalStockHours: 10, reseatFactor: 1.25, batchHours: 1, restockLine: 'new_line', firstPriceCraft: 'inputs', mpStartValue: 13, sellerLook: 'every_look', askFloorAtCost: false };
const OURS = { ...TEXT, firstPriceCraft: 'inputs_plus_mp', sellerLook: 'unsold_look', askFloorAtCost: true };
const twinOf = overrides => ({ level: 25, createItem: 2, crystallize: 'd', mp: 20, mpAt: 0, maxMp: 188, regen: 400, recipes: [], stock: {}, paid: {},
    wallet: 100000, mode: 'sell', batch: null, stints: {}, storeSlots: { sell: 4, buy: 5 }, lines: [], bids: [], parked: {}, ...overrides });
const viewOf = (game, twin, extra = {}) => ({ now: 0, self: 0, place: { town: 'A', twinTown: 'A' }, books: {}, memory: [], persona: { looksToFloor: 5, buyerStart: 0.7 },
    config: TEXT, rankRecipes: true, twin, game, npcSell: { [ORE]: 300 }, crystalRoute: {}, crystalReach: {}, hoursToGrade: 10, ...extra });

// Adena per MP counts the success rate: SSD (100 %, 10 a shot) beats a 60 %
// shot at 15 a shot ((1560 - 1000) / 40 = 14 against (1404 - 1000) / 40 = 10.1).
{
    const game = gameOf([recipe(1, SSD), recipe(2, RISKY, { successRate: 60 })]);
    const twin = twinOf({ recipes: [1, 2], stock: { [ORE]: 300, [CRYSTAL]: 100 }, paid: { [CRYSTAL]: 100, [ORE]: 300 } });
    const out = Workshop.workshop(viewOf(game, twin));
    assert.equal(out.batch.recipeId, 1, 'the 100 % recipe pays more per MP');
    assert.ok(Math.abs(Workshop.margin(game.recipes[2], viewOf(game, twin), new Set([1, 2])).perMp - 10.1) < 1e-9);
}

// Gear: at most one unsold piece per recipe. The sword pays far more per MP,
// but with one on the shelf the twin crafts shots.
{
    const game = gameOf([recipe(1, SSD), recipe(3, SWORD, { mpCost: 100, productCount: 1, materials: [{ selfId: ORE, amount: 10 }] })]);
    const stock = { [ORE]: 300, [CRYSTAL]: 100 };
    const free = Workshop.workshop(viewOf(game, twinOf({ recipes: [1, 3], stock, paid: { [CRYSTAL]: 100 } })));
    assert.equal(free.batch.recipeId, 3, 'the sword first');
    assert.equal(free.batch.crafts, 1, 'gear one piece at a time');
    const shelved = Workshop.workshop(viewOf(game, twinOf({ recipes: [1, 3], stock: { ...stock, [SWORD]: 1 }, paid: { [CRYSTAL]: 100 } })));
    assert.equal(shelved.batch.recipeId, 1, 'an unsold sword stops the sword');
    assert.equal(shelved.counters.gearCapped, 1);
}

// A margin that is not positive stops the recipe, inputs in stock or not:
// 100 shots at 10 against 900 of ore and a crystal paid 100 is 0 per MP.
{
    const game = gameOf([recipe(1, SSD, { productCount: 100 })]);
    const out = Workshop.workshop(viewOf(game, twinOf({ recipes: [1], stock: { [ORE]: 300, [CRYSTAL]: 100 }, paid: { [CRYSTAL]: 100 } })));
    assert.equal(out.batch, null, 'no craft at a zero margin');
    assert.deepEqual(out.counters.stopped, [1], 'the recipe stopped');
}

// The batch: crafts = max(1, floor((MP held + an hour of regen) / MP cost)) =
// floor(420 / 40) = 10, held to the inputs; deadline = (10 x 40 - 20) / 400 h.
{
    const game = gameOf([recipe(1, SSD)]);
    const twin = twinOf({ recipes: [1], stock: { [ORE]: 30, [CRYSTAL]: 10 }, paid: { [CRYSTAL]: 100 }, mp: 20, mpAt: 2 });
    const out = Workshop.workshop(viewOf(game, twin, { now: 2 }));
    assert.equal(out.batch.crafts, 10);
    assert.ok(Math.abs(out.batch.deadline - (2 + 380 / 400)) < 1e-12, `deadline ${out.batch.deadline}`);
    assert.deepEqual(out.npcBuys, [], 'held inputs are not bought');
    const short = Workshop.workshop(viewOf(game, { ...twin, stock: { [ORE]: 6, [CRYSTAL]: 10 } }, { now: 2 }));
    assert.equal(short.batch.crafts, 10, 'ore the NPC in town sells is bought');
    assert.deepEqual(short.npcBuys, [{ selfId: ORE, count: 24, price: 300 }]);
    assert.equal(Workshop.mpAt({ ...twin, mpAt: 0 }, 1), 188, 'MP stops at max MP between batches');
}

// Buy lines stay within the wallet (at their caps, the most they can cost)
// and within a dwarf's 5 buy slots; sell lines within its 4 sell slots.
{
    const fillers = [];
    for (let i = 0; i < 8; i++) fillers.push(recipe(10 + i, 7000 + i, { productCount: 1, mpCost: 10, materials: [{ selfId: BONE, amount: 1 }] }));
    const extra = Object.fromEntries(fillers.map(row => [row.productId, { kind: 'Other.Material', grade: 'NONE', npcBuy: 1 }]));
    const prices = Object.fromEntries(fillers.map((row, i) => [row.productId, 500 + i]));
    const sword = recipe(3, SWORD, { mpCost: 100, productCount: 1, materials: [{ selfId: BONE, amount: 50 }] });
    const game = gameOf([sword, ...fillers], extra, prices);
    const buying = Workshop.workshop(viewOf(game, twinOf({ recipes: [3], wallet: 5000 })));
    assert.equal(buying.mode, 'buy', 'nothing to sell, inputs to buy');
    assert.ok(buying.wanted.length <= 5, `${buying.wanted.length} buy lines`);
    const cost = buying.wanted.reduce((sum, line) => sum + line.qty * buying.prices[`buy:${line.item}`].cap, 0);
    assert.ok(cost <= 5000, `buy lines cost ${cost} at their caps`);
    assert.ok(buying.wanted.some(line => line.item === BONE), 'the sword\'s missing bones');
    const stock = Object.fromEntries(fillers.map(row => [row.productId, 3]));
    const selling = Workshop.workshop(viewOf(game, twinOf({ recipes: fillers.map(row => row.recipeId), stock, wallet: 0 })));
    assert.equal(selling.mode, 'sell');
    assert.equal(selling.wanted.length, 4, 'four sell lines for eight goods');
}

// A full book takes a recipe only over the worst it holds, which is
// forgotten; a free slot takes any positive margin.
{
    const book = [];
    for (let i = 0; i < Workshop.RECIPE_BOOK_LIMIT; i++) book.push(recipe(100 + i, 8000 + i, { productCount: 1, mpCost: 10, materials: [{ selfId: BONE, amount: 1 }] }));
    const extra = {}, prices = {};
    // Margin per MP of book recipe i: (30 + i - 20) / 10 = 1 + i / 10 (bones at their first price, 20: nobody offers them).
    book.forEach((row, i) => { extra[row.productId] = { kind: 'Other.Material', grade: 'NONE', npcBuy: 1 }; prices[row.productId] = 30 + i; });
    const middle = recipe(300, 8999, { productCount: 1, mpCost: 10, materials: [{ selfId: BONE, amount: 1 }] });
    extra[8999] = { kind: 'Other.Material', grade: 'NONE', npcBuy: 1 };
    const game = gameOf([...book, middle], extra, { ...prices, 8999: 50 });
    const full = twinOf({ recipes: book.map(row => row.recipeId), stock: { [middle.recipeItemId]: 1 } });
    const out = Workshop.workshop(viewOf(game, full));
    assert.deepEqual(out.learn, [300], 'it beats the worst held (margin 3 against 1)');
    assert.deepEqual(out.forget, [100], 'the worst goes');
    const poor = gameOf([...book, middle], extra, { ...prices, 8999: 29 });
    assert.deepEqual(Workshop.workshop(viewOf(poor, full)).learn, [], 'under the worst held: not taken');
    const roomy = twinOf({ recipes: [book[49].recipeId], stock: { [middle.recipeItemId]: 1 } });
    const small = gameOf([book[49], middle], extra, { ...prices, 8999: 29 });
    assert.deepEqual(Workshop.workshop(viewOf(small, roomy)).learn, [300], 'a free slot takes any positive margin (0.9)');
}

// Lines move only at the owner's looks: an hourly report is no reason; a
// fill steps the line; a batch's new units start a line at the known price
// while the unsold remainder keeps its step.
{
    const persona = { looksToFloor: 5, buyerStart: 0.7 };
    const prices = { [`sell:${SSD}`]: { floor: 5, known: 20, first: 10 } };
    const first = ownLines([], { wanted: [{ side: 'sell', item: SSD, qty: 100, lineId: null }], prices, persona, roll: 0.5 }, 'batch_applied');
    const line = first.lines[0];
    assert.equal(line.price, 20, 'a new line starts at the known price');
    assert.equal(ownLines(first.lines, { wanted: [{ side: 'sell', item: SSD, qty: 100, lineId: line.id }], prices, persona, roll: 0.6 }, 'hour').lines, first.lines, 'no look, no move');
    const stepped = ownLines(first.lines, { wanted: [{ side: 'sell', item: SSD, qty: 60, lineId: line.id }], prices, persona, roll: 0.6 }, 'fill').lines[0];
    assert.equal(stepped.price, 17, 'one look of five toward the floor: 20 - 15 / 5');
    const restocked = ownLines([stepped], { wanted: [{ side: 'sell', item: SSD, qty: 60, lineId: stepped.id }, { side: 'sell', item: SSD, qty: 100, lineId: null }],
        prices: { [`sell:${SSD}`]: { floor: 5, known: 17, first: 10 } }, persona, roll: 0.7 }, 'batch_applied').lines;
    assert.deepEqual(restocked.map(row => [row.qty, row.price, row.look]), [[60, 17, 1], [100, 17, 0]], 'the remainder keeps its step, the batch starts afresh');
    const dropped = ownLines([stepped], { wanted: [], prices, persona, roll: 0.8 }, 'main_arrived');
    assert.deepEqual(dropped.closed.map(row => row.why), ['withdrawn']);
}

// A seller's floor: the NPC's price or the best crystallizer bid in the
// towns it reaches (the town visited and its twin's), never a third town's.
{
    const game = gameOf([recipe(3, SWORD, { mpCost: 100, productCount: 1, materials: [{ selfId: ORE, amount: 10 }] })]);
    const books = { A: { bids: { d: [{ owner: 5, price: 10, qty: 1000 }] } }, B: { bids: { d: [{ owner: 6, price: 12, qty: 1000 }] } }, C: { bids: { d: [{ owner: 7, price: 50, qty: 1000 }] } } };
    const out = Workshop.workshop(viewOf(game, twinOf({ recipes: [3], stock: { [SWORD]: 1 }, wallet: 0 }), { place: { town: 'A', twinTown: 'B' }, books }));
    assert.equal(out.prices[`sell:${SWORD}`].floor, 1200, '100 crystals at the best bid in reach (12) over the NPC\'s 1000');
    assert.equal(Knowledge.bestCrystalBid({ town: 'A', twinTown: 'B' }, books, 'd'), 12);
}

// The price memory keeps the 16 newest deals, one row per item.
{
    let memory = [];
    for (let i = 1; i <= 17; i++) memory = Knowledge.remember(memory, { item: i, price: i * 10 });
    assert.equal(memory.length, 16);
    assert.equal(Knowledge.known(memory, 1), null, 'the oldest deal is gone');
    assert.equal(Knowledge.known(memory, 17), 170);
    memory = Knowledge.remember(memory, { item: 2, price: 5 });
    assert.equal(Knowledge.known(memory, 2), 5, 'a new deal replaces the item\'s row');
    assert.equal(memory.length, 16);
}

// The account warehouse: the main keeps its need, the twin's open lines keep
// their cost; a pair's main leaves its twin the inputs of its recipes and the
// scrolls it lacks and can use.
{
    assert.deepEqual(Workshop.pool({ main: 9000, wallet: 1000, escrow: 4000, keep: 3000 }), { main: 3000, wallet: 7000, moved: 6000 });
    assert.deepEqual(Workshop.pool({ main: 1000, wallet: 4000, escrow: 4000, keep: 3000 }), { main: 1000, wallet: 4000, moved: 0 });
    const game = gameOf([recipe(1, SSD), recipe(4, RISKY, { level: 4 })]);
    const left = Workshop.depositFor({ [ORE]: 9, [BONE]: 4, 5001: 1, 5004: 1 }, twinOf({ recipes: [] }), game);
    assert.deepEqual(left, { 5001: 1 }, 'the scroll it can use, not one above its Create Item level');
    assert.deepEqual(Workshop.depositFor({ [ORE]: 9, [BONE]: 4 }, twinOf({ recipes: [1] }), game), { [ORE]: 9 }, 'the ore of a recipe it holds');
    assert.deepEqual(Workshop.depositFor({ 5001: 5 }, twinOf({ recipes: [] }), game), { 5001: 1 }, 'one copy of a scroll: the main sells the rest');
    assert.deepEqual(Workshop.depositFor({ 5001: 2 }, twinOf({ recipes: [], stock: { 5001: 1 } }), game), {}, 'none while a copy waits in its stock');
    assert.deepEqual(Workshop.depositFor({ 5001: 2, [ORE]: 3 }, twinOf({ recipes: [1] }), game), { [ORE]: 3 }, 'none of a recipe it holds');
}

// The store mode's memory: a stint in which nothing filled is not kept, so
// a twin whose shots found no buyer sells again once it holds shots; a kept
// stint rates its mode while the same goods are on offer (or none) and is
// forgotten once other goods are.
{
    const shots = [{ item: SSD, qty: 1000, price: 10, cost: 0 }], scroll = [{ item: 5001, qty: 1, value: 300, price: 100, hourValue: 500 }];
    const at = (twin, now) => ({ now, twin });
    const unfilled = Workshop.chooseMode(at({ mode: 'sell', stint: { since: 0, units: 0, goods: String(SSD) }, stints: {} }, 2), [], scroll, 156);
    assert.equal(unfilled.mode, 'buy', 'sold out: the scroll');
    assert.equal(unfilled.stintEnded, 'unfilled');
    assert.deepEqual(unfilled.stints, {}, 'nothing filled: nothing kept');
    const back = Workshop.chooseMode(at({ mode: 'buy', stint: unfilled.stint, stints: unfilled.stints }, 3), shots, scroll, 156);
    assert.equal(back.mode, 'sell', 'shots again: one batch (156 x 10) over the scroll\'s 500');
    const filled = Workshop.chooseMode(at({ mode: 'sell', stint: { since: 0, units: 40, goods: String(SSD) }, stints: {} }, 2), [], scroll, 156);
    assert.equal(filled.stintEnded, 'kept');
    assert.deepEqual(filled.stints.sell, { hours: 2, units: 40, goods: String(SSD) }, 'kept while it offers nothing');
    const measured = Workshop.chooseMode(at({ mode: 'buy', stint: filled.stint, stints: filled.stints }, 3), shots, scroll, 156);
    assert.equal(measured.mode, 'buy', '20 shots an hour x 10 under the scroll\'s 500');
    const other = Workshop.chooseMode(at({ mode: 'buy', stint: filled.stint, stints: filled.stints }, 3), [{ item: RISKY, qty: 1000, price: 10, cost: 0 }], scroll, 156);
    assert.equal(other.mode, 'sell', 'other goods: the shots\' stint no longer rates the mode');
    assert.deepEqual(other.stints, {}, 'and is forgotten');
}

// A crystallizer bid and a crystal's replacement stop at the cheapest NPC
// gear route the twin reaches, the fare included, also where its own town
// sells no gear (a dear shot puts the crystal's use value far above it).
{
    const game = gameOf([recipe(1, SSD)], {}, { [SSD]: 1000 });
    const twin = twinOf({ recipes: [1], stock: { [ORE]: 300 }, wallet: 1e6 });
    const view = viewOf(game, twin, { crystalReach: { d: { perCrystal: 700, town: 'B', fare: 10000 } } });
    const out = Workshop.workshop(view);
    assert.deepEqual([out.bidPrices['buy:d'].cap, out.bidPrices['buy:d'].capBy], [700, 'route']);
    assert.equal(Workshop.replacement(CRYSTAL, view), 700);
}

// An input nobody offers is priced at its first price (no free margin): a
// good whose first price is that input's cost earns nothing.
{
    const plain = recipe(5, 7100, { productCount: 1, mpCost: 10, materials: [{ selfId: BONE, amount: 1 }] });
    const game = gameOf([plain], { 7100: { kind: 'Other.Material', grade: 'NONE', npcBuy: 1 } }, { 7100: 20 });
    assert.equal(Workshop.margin(plain, viewOf(game, twinOf({ recipes: [5] })), new Set([5])).perMp, 0);
}

// A crafted good's first price: the game's (its inputs, no MP: the design's
// text), or its inputs at the twin's own costs plus the MP at the twin's
// value of an MP (ours): mpStartValue before any deal, then the best margin
// per MP among the goods it sold. Inputs: 3 ore at 300 and a crystal at its
// first price 605 = 1505 for 156 shots.
{
    const game = gameOf([recipe(1, SSD), recipe(2, RISKY)], {}, { [SSD]: 10, [RISKY]: 10 });
    const twin = twinOf({ recipes: [1, 2] }), held = new Set([1, 2]);
    assert.equal(Workshop.productPrice(SSD, viewOf(game, twin), held), 10, 'the design\'s text: the game\'s first price');
    const fresh = viewOf(game, twin, { config: OURS });
    near(Workshop.productPrice(SSD, fresh, held), (1505 + 40 * 13) / 156, 'inputs and 40 MP at the start value');
    near(Workshop.margin(game.recipes[1], fresh, held).perMp, 13, 'a new good earns the value of an MP');
    const sold = viewOf(game, twin, { config: OURS, memory: [{ item: RISKY, enchant: 0, price: 20 }] });
    near(Workshop.productPrice(SSD, sold, held), (1505 + 40 * (20 * 156 - 1505) / 40) / 156, 'the MP at what the sold good earns');
}

// A seller's look. Ours ('unsold_look'): a fill holds the ask, a look with
// its stock unsold since the previous one steps it down, a line of a good
// that sold out restarts one look back toward its starting price. The
// design's text ('every_look'): a fill steps it down too.
{
    const persona = { looksToFloor: 5, buyerStart: 0.7 };
    const prices = { [`sell:${SSD}`]: { floor: 5, known: 20, first: 10 } };
    const lines = (held, sellerLook, reason, wanted = [{ side: 'sell', item: SSD, qty: 100, lineId: held[0]?.id || null }]) =>
        ownLines(held, { wanted, prices, persona, sellerLook, roll: 0.5 }, reason).lines[0];
    const open = lines([], 'unsold_look', 'batch_applied'), sold = { ...open, qty: 60, sold: 40 };
    assert.equal(lines([sold], 'every_look', 'fill').price, 17, 'the design\'s text: a fill steps the ask down');
    const held = lines([sold], 'unsold_look', 'fill');
    assert.equal(held.price, 20, 'ours: a fill holds it');
    const once = lines([held], 'unsold_look', 'main_arrived'), twice = lines([once], 'unsold_look', 'main_arrived');
    assert.deepEqual([once.price, twice.price], [17, 14], 'unsold since the last look: a step down each');
    const resumed = lines([], 'unsold_look', 'batch_applied', [{ side: 'sell', item: SSD, qty: 100, lineId: null, resume: { start: twice.start, look: twice.look } }]);
    assert.equal(resumed.price, 17, 'sold out at the second look: the new line starts at the first');
    const game = gameOf([recipe(1, SSD)]);
    const out = Workshop.workshop(viewOf(game, twinOf({ recipes: [1], stock: { [SSD]: 100 }, wallet: 0, soldOut: { [SSD]: { start: 20, look: 2 } } }), { config: OURS }));
    assert.deepEqual(out.wanted[0].resume, { start: 20, look: 2 }, 'the workshop resumes the sold-out line');
}

// A crafter's floor. Ours (askFloorAtCost): never under its input cost per
// unit at its own costs (1505 / 156), where the line parks, counted; the
// design's text: the NPC's buy price (5).
{
    const game = gameOf([recipe(1, SSD)]);
    const twin = twinOf({ recipes: [1], stock: { [SSD]: 500 }, wallet: 0 });
    assert.equal(Workshop.workshop(viewOf(game, twin)).prices[`sell:${SSD}`].floor, 5);
    const ours = Workshop.workshop(viewOf(game, twin, { config: OURS })), bounds = ours.prices[`sell:${SSD}`];
    near(bounds.floor, 1505 / 156, 'the input cost per shot');
    assert.equal(bounds.floorBy, 'cost');
    const line = ownLines([{ side: 'sell', id: 'l', item: SSD, qty: 500, start: 20, look: 4, price: 12, atBound: 0, sold: 0 }],
        { wanted: [{ side: 'sell', item: SSD, qty: 500, lineId: 'l' }], prices: ours.prices, persona: { looksToFloor: 5, buyerStart: 0.7 }, sellerLook: 'unsold_look', roll: 0.5 }, 'main_arrived').lines[0];
    assert.deepEqual([line.price, line.bound, line.floorBy], [10, 'floor', 'cost'], 'the fifth look parks at the cost, rounded up');
}

console.log('PASS economy model workshop rules');
