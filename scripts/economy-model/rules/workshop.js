'use strict';

// workshop (economy design, account plane): which recipes a crafter account
// holds, what its twin crafts and the twin's store mode, by adena per MP for
// crafts and adena per seat-hour between modes, read from open bids and its
// own deals. Liquid goods (shots, crystals, intermediates) are made ahead;
// gear at most one unsold piece per recipe; a margin that turned negative
// stops that recipe. Also the twin's seat (seat), the account warehouse's
// money (pool) and what a pair's main leaves its twin (depositFor).
// Pure: the twin, the game data, the books it reaches and its memory arrive
// as plain data (view); it returns a decision the engine commits. Runs at
// the account's wakes: a line filled, a craft batch done, its main's arrival
// in a town.
const Bounds = require('./bounds');
const Knowledge = require('./knowledge');

// C4 DwarfRecipeLimit (Lisvus Other.properties): recipes in a dwarf's book.
// No src owner holds the limit.
const RECIPE_BOOK_LIMIT = 50;
const GRADES = Object.freeze(['d', 'c', 'b', 'a', 's']);

const isGear = item => /^(Weapon|Armor)/.test(item?.kind || '');
const gradeOf = item => String(item?.grade || 'NONE').toLowerCase();

// The twin's MP at now: seated regen from its last mark, held at max MP; a
// running batch takes all regen.
function mpAt(twin, now) {
    if (twin.batch) return 0;
    return Math.min(twin.maxMp, twin.mp + twin.regen * Math.max(0, now - twin.mpAt));
}

// The recipes a twin crafts: its book, and the A/S quest recipes its Create
// Item level gives without a slot (ours: the quests do not run).
function heldRecipes(twin, game) {
    const out = new Set(twin.recipes);
    for (const id of game.questRecipes) if (game.recipes[id].level <= twin.createItem) out.add(id);
    return out;
}

// The price a crafted good fetches. Its own price: its last deal, else its
// first price (firstPriceOf); while it holds unsold units, no more than its
// own last ask (ours: an unsold good is worth what it asks, so a margin turns
// negative as its ask steps down to the floor). config.productPrice
// 'bid_first' (the reading "read from open bids" as written): the best open
// bid in reach when there is one, else its own price; 'bid_or_own' (ours,
// pending the maintainer): the dearer of the two, since a buyer's WTB starts
// under what it will pay and steps up at its looks.
function productPrice(item, view, held) {
    const { bestBid } = Knowledge.reach(view.place, view.books, item, view.self, view.ads);
    if (bestBid !== null && view.config.productPrice !== 'bid_or_own') return bestBid;
    const price = Knowledge.known(view.memory, item) ?? firstPriceOf(item, view, held);
    const ask = (view.twin.stock[item] || 0) > 0 ? view.twin.asks?.[item] : undefined;
    const own = ask !== undefined && price !== null ? Math.min(ask, price) : price;
    return bestBid !== null && (own === null || bestBid > own) ? bestBid : own;
}

// The first price of a good the twin crafts from a recipe it holds.
// firstPriceCraft 'inputs' (the design's text): the game's first price, its
// inputs' cheapest routes with no MP term, so its margin is at most zero.
// 'inputs_plus_mp' (ours, pending the maintainer): its inputs at the twin's
// own unit costs plus the chain's MP times the twin's value of an MP
// (mpValue). Any other good: the game's first price. null when none.
function firstPriceOf(item, view, held) {
    const first = view.game.firstPrice[item] ?? null;
    if (view.config.firstPriceCraft !== 'inputs_plus_mp') return first;
    const own = craftOf(item, view, held, 0);
    return own ? own.cost + own.mp * mpValue(view, held) : first;
}

// What one MP of the twin is worth (ours): the best margin per MP among the
// held recipes whose product it has sold, at its last deal, never under 0;
// with no such deal, the config's mpStartValue. Memoized per view.
const mpValues = new WeakMap();
function mpValue(view, held) {
    if (mpValues.has(view)) return mpValues.get(view);
    let best = null;
    for (const id of held) {
        const recipe = view.game.recipes[id], price = Knowledge.known(view.memory, recipe.productId);
        if (price === null) continue;
        const m = marginAt(recipe, price, view, held);
        if (m && (best === null || m.perMp > best)) best = m.perMp;
    }
    const value = best === null ? view.config.mpStartValue : Math.max(0, best);
    mpValues.set(view, value);
    return value;
}

// What an input costs the twin to replace: the lowest of its own buy line
// (a crystal's: its crystallizer bid), the NPC in its town (x1), the
// cheapest NPC gear route per crystal it reaches (the fare included), and
// what it paid for the units it holds. An input no NPC here sells and it
// has no line for is priced at its known price, else its first price (ours:
// no free margin for a recipe whose input nobody offers). null when nothing
// prices it.
// Replacement prices memoized per view object: a view is built for one
// decision and never edited, so it is exactly the prices' inputs.
const replacements = new WeakMap();
function replacement(item, view) {
    let memo = replacements.get(view);
    if (!memo) { memo = new Map(); replacements.set(view, memo); }
    if (!memo.has(item)) memo.set(item, replacementOf(item, view));
    return memo.get(item);
}

function replacementOf(item, view) {
    const { twin, game } = view;
    const prices = [], grade = game.crystalGrade[item];
    for (const line of twin.lines) if (line.side === 'buy' && line.item === item) prices.push(line.price);
    if (grade) for (const bid of twin.bids || []) if (bid.item === grade) prices.push(bid.price);
    if (view.npcSell[item] > 0) prices.push(view.npcSell[item]);
    if (grade && view.crystalReach[grade]) prices.push(view.crystalReach[grade].perCrystal);
    if (!prices.length) {
        const start = Knowledge.known(view.memory, item) ?? game.firstPrice[item];
        if (start !== undefined && start !== null) prices.push(start);
    }
    if ((twin.stock[item] || 0) > 0 && twin.paid[item] !== undefined) prices.push(twin.paid[item]);
    return prices.length ? Math.min(...prices) : null;
}

// An input's cost per unit and MP per unit: its replacement, or its own craft
// when the twin holds a recipe for it and that is cheaper (one level deep:
// the chain of a gear piece through the twin's own recipes).
function unitCost(item, view, held, depth = 0) {
    const bought = replacement(item, view);
    const best = bought === null ? null : { cost: bought, mp: 0 };
    if (depth > 0) return best;
    const own = craftOf(item, view, held, depth);
    return own && (!best || own.cost < best.cost) ? own : best;
}

// The cheapest own craft of an item per unit made: its inputs at their unit
// cost (one level deeper) and the chain's MP, over the expected units of the
// held recipe. null when it holds no recipe for it or an input has no supply.
function craftOf(item, view, held, depth) {
    let best = null;
    for (const id of view.game.byProduct[item] || []) {
        if (!held.has(id)) continue;
        const recipe = view.game.recipes[id], made = recipe.productCount * recipe.successRate / 100;
        let cost = 0, mp = recipe.mpCost;
        for (const material of recipe.materials) {
            const part = unitCost(material.selfId, view, held, depth + 1);
            if (!part) { cost = null; break; }
            cost += material.amount * part.cost;
            mp += material.amount * part.mp;
        }
        if (cost !== null && (!best || cost / made < best.cost)) best = { cost: cost / made, mp: mp / made };
    }
    return best;
}

// Adena per MP of a recipe: (price x count x success - inputs at their unit
// cost) / MP of the whole chain. null when the product has no price or an
// input has no supply.
function margin(recipe, view, held) {
    return marginAt(recipe, productPrice(recipe.productId, view, held), view, held);
}

function marginAt(recipe, price, view, held) {
    if (price === null) return null;
    const revenue = price * recipe.productCount * recipe.successRate / 100;
    let cost = 0, mp = recipe.mpCost;
    for (const material of recipe.materials) {
        const part = unitCost(material.selfId, view, held);
        if (!part) return null;
        cost += material.amount * part.cost;
        mp += material.amount * part.mp;
    }
    return { perMp: (revenue - cost) / mp, revenue, cost, mp };
}

// The most an input is worth to a recipe: the price at which the recipe's
// margin falls to zero with the other inputs at their unit cost.
function useValue(recipe, item, view, held) {
    const m = margin(recipe, view, held), material = recipe.materials.find(row => row.selfId === item);
    if (!m || !material) return 0;
    const own = unitCost(item, view, held);
    return Math.max(0, (m.revenue - m.cost + material.amount * (own?.cost || 0)) / material.amount);
}

// Recipes a twin may learn: dwarven, within its Create Item level, not held,
// not a quest variant; all of them at its main's arrival, else only those
// whose scroll it holds (a fill or a batch brings no new recipe to rank).
function candidates(view, held) {
    const { twin, game } = view, out = [];
    const ids = view.rankRecipes ? game.dwarven : Object.keys(twin.stock).map(item => game.byScroll[item]).filter(id => id && twin.stock[game.recipes[id].recipeItemId] > 0);
    for (const id of ids) {
        const recipe = game.recipes[id];
        if (recipe.level > twin.createItem || held.has(id) || recipe.quest) continue;
        const m = margin(recipe, view, held);
        if (m && m.perMp > 0) out.push({ id, perMp: m.perMp });
    }
    return out.sort((a, b) => b.perMp - a.perMp || a.id - b.id);
}

// The book: with a free slot any recipe with a positive margin is taken;
// with a full book one is taken only when it beats the worst held, which is
// forgotten. A taken recipe is learned from a scroll the twin holds, else its
// scroll is wanted (a buy line); the line closes when it is learned.
// Returns { learn: [recipeId], forget: [recipeId], want: [{ id, gain }] }.
function decideRecipes(view, held) {
    const { twin, game } = view;
    const book = twin.recipes.map(id => ({ id, perMp: margin(game.recipes[id], view, held)?.perMp ?? -Infinity }))
        .sort((a, b) => a.perMp - b.perMp || b.id - a.id);
    let free = RECIPE_BOOK_LIMIT - book.length;
    const learn = [], forget = [], want = [], ranked = candidates(view, held);
    const inStock = candidate => (twin.stock[game.recipes[candidate.id].recipeItemId] || 0) > 0;
    // Scrolls it holds are learned first; the worst held goes only for a better one learned.
    for (const candidate of ranked.filter(inStock)) {
        if (free > 0) { free--; learn.push(candidate.id); } else if (book.length && candidate.perMp > book[0].perMp) { learn.push(candidate.id); forget.push(book.shift().id); } else break;
    }
    if (!view.rankRecipes) return { learn, forget, want: (twin.wants || []).filter(row => !held.has(row.id) && !learn.includes(row.id)) };
    for (const candidate of ranked.filter(row => !inStock(row))) {
        if (free > 0) { free--; want.push({ id: candidate.id, gain: candidate.perMp }); } else if (book.length && candidate.perMp > book[0].perMp) want.push({ id: candidate.id, gain: candidate.perMp - book[0].perMp });
        else break;
    }
    return { learn, forget, want };
}

// The value of a crystal of a grade to the twin: its last deal, else the
// cheapest NPC gear route it reaches, else the crystal's first price.
function crystalValue(grade, view) {
    const id = view.game.crystalIds[grade.toUpperCase()];
    return Knowledge.known(view.memory, id) ?? view.crystalReach[grade]?.perCrystal ?? view.game.firstPrice[id] ?? 0;
}

// Pieces in stock it crystallizes: gear of a grade it can crystallize, not
// the products of its own recipes (they stay shelved), whose crystals are
// worth more than the piece's best sale (its last deal, else the NPC).
function crystallizeList(view, held) {
    const { twin, game } = view, out = [];
    if (!twin.crystallize) return out;
    const top = GRADES.indexOf(twin.crystallize), own = new Set([...held].map(id => game.recipes[id].productId));
    for (const [key, count] of Object.entries(twin.stock)) {
        const id = Number(key), item = game.items[id], grade = gradeOf(item);
        if (!(count > 0) || !isGear(item) || !(item.crystals > 0) || own.has(id) || GRADES.indexOf(grade) < 0 || GRADES.indexOf(grade) > top) continue;
        if (item.crystals * crystalValue(grade, view) > (Knowledge.known(view.memory, id) ?? item.npcBuy ?? 0)) out.push({ selfId: id, count, grade, crystals: item.crystals });
    }
    return out;
}

// One craft batch (ours): the crafts of the best positive-margin recipe whose
// inputs are held or bought here (the NPC in its town, crystals through NPC
// gear) that one hour of seated regen covers, at least one; gear one at a
// time and only with no unsold piece on its shelf. deadline = now + (crafts x
// MP cost - MP held) / regen. null when nothing pays or no input is at hand.
function planBatch(view, held, stock, ranked) {
    const { twin, game, now } = view, mp = mpAt(twin, now), counters = { gearCapped: 0, stopped: [] };
    for (const { id, m } of ranked) {
        const recipe = game.recipes[id];
        if (!(m.perMp > 0)) { counters.stopped.push(id); continue; }
        if (isGear(game.items[recipe.productId]) && (stock[recipe.productId] || 0) > 0) { counters.gearCapped++; continue; }
        let crafts = isGear(game.items[recipe.productId]) ? 1 : Math.max(1, Math.floor((mp + twin.regen * view.config.batchHours) / recipe.mpCost));
        // Each input: units held, then the NPC in town, then NPC gear for crystals.
        let costPerCraft = 0;
        const shortPerCraft = [];
        for (const material of recipe.materials) {
            const have = stock[material.selfId] || 0, grade = game.crystalGrade[material.selfId];
            const price = view.npcSell[material.selfId] > 0 ? view.npcSell[material.selfId] : grade && view.crystalRoute[grade] ? view.crystalRoute[grade].perCrystal : null;
            if (price === null) { crafts = Math.min(crafts, Math.floor(have / material.amount)); continue; }
            shortPerCraft.push({ material, have, price, grade: game.crystalGrade[material.selfId] && !(view.npcSell[material.selfId] > 0) ? grade : null });
            costPerCraft += material.amount * price;
        }
        if (crafts < 1) continue;
        // Bought inputs within the wallet: the units held come first; NPC gear comes in whole pieces.
        const spendOf = count => shortPerCraft.reduce((sum, row) => {
            const need = Math.max(0, count * row.material.amount - row.have);
            return sum + (row.grade ? Math.ceil(need / view.crystalRoute[row.grade].crystals) * view.crystalRoute[row.grade].price : need * row.price);
        }, 0);
        while (crafts >= 1) {
            if (spendOf(crafts) <= twin.wallet) break;
            crafts = Math.max(0, Math.min(crafts - 1, Math.floor(twin.wallet / Math.max(1, costPerCraft))));
        }
        if (crafts < 1) continue;
        const npcBuys = [], routeBuys = [];
        for (const row of shortPerCraft) {
            const need = Math.max(0, crafts * row.material.amount - row.have);
            if (!need) continue;
            if (!row.grade) { npcBuys.push({ selfId: row.material.selfId, count: need, price: row.price }); continue; }
            const route = view.crystalRoute[row.grade], pieces = Math.ceil(need / route.crystals);
            routeBuys.push({ selfId: route.gearId, count: pieces, price: route.price, crystals: route.crystals, grade: row.grade });
        }
        const deadline = now + Math.max(0, crafts * recipe.mpCost - mp) / twin.regen;
        return { batch: { recipeId: id, crafts, deadline, mpAtStart: mp, perMp: m.perMp, orderId: null }, npcBuys, routeBuys, counters };
    }
    return { batch: null, npcBuys: [], routeBuys: [], counters };
}

// The batch of an order: one craft of its recipe from the buyer's
// materials, at the twin's MP; deadline = now + (MP cost - MP held) / regen.
function orderBatch(view, { order, id, perMp }) {
    const { twin, game, now } = view, mp = mpAt(twin, now), recipe = game.recipes[id];
    return { batch: { recipeId: id, crafts: 1, deadline: now + Math.max(0, recipe.mpCost - mp) / twin.regen, mpAtStart: mp, perMp, orderId: order.id },
        npcBuys: [], routeBuys: [], counters: { gearCapped: 0, stopped: [] } };
}

// The goods a mode would put on offer, as one key (sorted item ids).
const offerKey = rows => rows.map(row => row.item).sort((a, b) => a - b).join(',');

// Store mode (ours): adena per seat-hour of selling and of buying from its
// last stint in each mode (units filled per seat-hour over the goods that
// stint offered); a mode with no stint over the goods it would offer now
// counts one batch of its best recipe. sell = sum over sell lines of
// min(stock, rate) x (price - what it paid); buy = sum over wanted inputs of
// min(want, rate) x (use value - price), a scroll counting its margin gain
// over one seat-hour of regen (its cap holds the gain to the next grade).
// manufacture = the fee of the best open order it takes (ours: one order
// per seat-hour). The highest wins; a tie keeps the current mode.
// The mode memory: the running stint (twin.stint { since, units (filled on
// its own store's lines), goods }) ends when the mode or the goods on offer
// change, and is kept only when something was on offer and something filled
// (an unfilled stint says nothing of a rate: it would score its mode 0 for
// ever); a kept stint is forgotten once its mode would offer other goods
// (not while it would offer none).
// Returns { mode, values, stint (the running one), stints (the kept),
// stintEnded: null | 'kept' | 'unfilled' }.
function chooseMode(view, sells, buys, batchUnits, manufacture = 0) {
    const { twin, now } = view, offer = { sell: offerKey(sells), buy: offerKey(buys), manufacture: '' };
    const kept = memory => Object.fromEntries(Object.entries(memory).filter(([mode, stint]) => (stint.goods === offer[mode] || !offer[mode]) && stint.hours > 0));
    let stints = kept(twin.stints || {});
    const rate = mode => (stints[mode]?.goods === offer[mode] ? stints[mode].units / stints[mode].hours : Math.max(1, batchUnits));
    const sellRate = rate('sell'), buyRate = rate('buy');
    const sell = sells.reduce((sum, row) => sum + Math.min(row.qty, sellRate) * Math.max(0, row.price - row.cost), 0);
    const buy = buys.reduce((sum, row) => sum + (row.hourValue ?? Math.min(row.qty, buyRate) * Math.max(0, row.value - row.price)), 0);
    const values = { sell, buy, manufacture };
    let mode = twin.mode;
    for (const option of ['sell', 'buy', 'manufacture']) if (values[option] > values[mode]) mode = option;
    let stint = twin.stint || { since: now, units: 0, goods: '' }, stintEnded = null;
    if (mode !== twin.mode || offer[mode] !== stint.goods) {
        if (stint.goods && now > stint.since) {
            stintEnded = stint.units > 0 ? 'kept' : 'unfilled';
            if (stint.units > 0) stints = kept({ ...stints, [twin.mode]: { hours: now - stint.since, units: stint.units, goods: stint.goods } });
        }
        stint = { since: now, units: 0, goods: offer[mode] };
    }
    return { mode, values, stint, stints, stintEnded };
}

function lineIdOf(twin, side, item) {
    return twin.lines.find(line => line.side === side && line.item === item)?.id || null;
}

// The decision at one wake. view: { now, self, place { town, twinTown },
// books, memory, persona, config, twin { level, createItem, crystallize, mp,
// mpAt, maxMp, regen, recipes, stock, paid, wallet, mode, batch, stints,
// storeSlots { sell, buy }, lines, bids, parked }, game { recipes, dwarven,
// questRecipes, byProduct, items, crystalIds, crystalGrade, firstPrice,
// sourced }, npcSell { item: price in its town }, crystalRoute { grade:
// { perCrystal, gearId, price, crystals } in its town }, crystalReach { grade:
// { perCrystal (price + fare over crystals), town, fare } the cheapest it
// reaches }, applied { item, units } after a batch, hoursToGrade,
// rankRecipes: rank every recipe it could learn (its main's arrival) }.
// Returns { learn, forget, want, wants, crystallize, batch, npcBuys,
// routeBuys, mode, modeValues, stint, stints, stintEnded, wanted, prices,
// bidWanted, bidPrices, counters }.
function workshop(view) {
    const { twin, game, config } = view;
    let held = heldRecipes(twin, game);
    const recipes = decideRecipes(view, held);
    const book = twin.recipes.filter(id => !recipes.forget.includes(id)).concat(recipes.learn);
    held = heldRecipes({ ...twin, recipes: book }, game);
    const stock = { ...twin.stock };
    for (const id of recipes.learn) stock[game.recipes[id].recipeItemId]--;
    const crystallize = crystallizeList({ ...view, twin: { ...twin, stock } }, held);
    for (const piece of crystallize) {
        stock[piece.selfId] -= piece.count;
        const crystal = game.crystalIds[piece.grade.toUpperCase()];
        stock[crystal] = (stock[crystal] || 0) + piece.count * piece.crystals;
    }
    const after = { ...view, twin: { ...twin, recipes: book, stock } };
    const ranked = [...held].map(id => ({ id, m: margin(game.recipes[id], after, held) })).filter(row => row.m)
        .sort((a, b) => b.m.perMp - a.m.perMp || a.id - b.id);
    // Orders it can take (a buyer's "craft X for me" from the buyer's own
    // materials, first come): a recipe it holds, ranked by the fee per MP of
    // one craft; one is worth taking when that reaches the margin per MP of
    // the batch it would craft otherwise (the MP's other work). The best order's fee is
    // manufacture's value.
    const idle = { batch: null, npcBuys: [], routeBuys: [], counters: { gearCapped: 0, stopped: [] } };
    const plan = twin.batch ? idle : planBatch(after, held, stock, ranked);
    const orders = [], ownBest = plan.batch ? plan.batch.perMp : 0;
    for (const order of view.orders || []) {
        if (!held.has(order.recipeId)) continue;
        const perMp = order.fee / game.recipes[order.recipeId].mpCost;
        if (perMp > 0 && perMp >= ownBest) orders.push({ order, id: order.recipeId, perMp });
    }
    orders.sort((a, b) => b.perMp - a.perMp || a.order.id.localeCompare(b.order.id));
    const orderPlan = twin.batch || !orders.length ? idle : orderBatch(view, orders[0]);
    const prices = {}, sells = [], buys = [];
    // The recipe it would craft next and one batch of its inputs, kept off its sell lines.
    const best = ranked.find(row => row.m.perMp > 0 && !(isGear(game.items[game.recipes[row.id].productId]) && (stock[game.recipes[row.id].productId] || 0) > 0));
    const bestCrafts = best ? Math.max(1, Math.floor((twin.maxMp + twin.regen * config.batchHours) / game.recipes[best.id].mpCost)) : 0;
    const reserve = {};
    if (best) for (const material of game.recipes[best.id].materials) reserve[material.selfId] = bestCrafts * material.amount;
    // Sell lines: goods of its own recipes beyond that, dearest stock first.
    // The floor: max(npcBuy, the best crystallizer bid in reach) (the
    // design's text); with askFloorAtCost (ours, pending the maintainer)
    // also its input cost per unit at its own unit costs, where the line
    // parks instead of selling under what the inputs cost.
    const products = new Set([...held].map(id => game.recipes[id].productId));
    for (const [key, count0] of Object.entries(stock)) {
        const item = Number(key), count = count0 - (reserve[item] || 0);
        if (!(count > 0) || !products.has(item)) continue;
        const piece = game.items[item], grade = gradeOf(piece);
        const bid = isGear(piece) && piece.crystals > 0 ? Knowledge.bestCrystalBid(view.place, view.books, grade, view.self) : null;
        const market = Bounds.floor({ npcBuy: piece?.npcBuy || 0, crystallizerBids: bid ? [bid * piece.crystals] : [] });
        const inputs = config.askFloorAtCost ? craftOf(item, after, held, 0)?.cost ?? 0 : 0;
        const floor = Math.max(market, inputs), floorBy = inputs > market ? 'cost' : 'market';
        // sellerSeesBids (ours): a standing WTB above its ask is where its ask
        // starts and restarts; the design's text: its known price is rival
        // lines and its own deals only.
        const { rivalSell, bestBid } = Knowledge.reach(view.place, view.books, item, view.self, view.ads);
        const known = Knowledge.known(view.memory, item), first = firstPriceOf(item, after, held) ?? floor;
        prices[`sell:${item}`] = { floor, floorBy, rival: rivalSell, known, first, bid: config.sellerSeesBids ? bestBid : null, gear: isGear(piece) };
        const listed = twin.lines.find(line => line.side === 'sell' && line.item === item);
        sells.push({ item, qty: count, price: listed?.price ?? known ?? first, cost: twin.paid[item] ?? 0 });
    }
    sells.sort((a, b) => b.qty * b.price - a.qty * a.price || a.item - b.item);
    // Buy lines: the inputs its best recipe lacks that no NPC here sells (one
    // batch's worth), then the scrolls of recipes it decided to add.
    let budget = twin.wallet - plan.npcBuys.reduce((sum, row) => sum + row.count * row.price, 0) - plan.routeBuys.reduce((sum, row) => sum + row.count * row.price, 0)
        - orderPlan.npcBuys.reduce((sum, row) => sum + row.count * row.price, 0) - orderPlan.routeBuys.reduce((sum, row) => sum + row.count * row.price, 0);
    if (best) {
        const recipe = game.recipes[best.id], crafts = bestCrafts;
        for (const material of recipe.materials) {
            const item = material.selfId, short = crafts * material.amount - (stock[item] || 0);
            const grade = game.crystalGrade[item];
            if (short <= 0 || view.npcSell[item] > 0 || (grade && view.crystalRoute[grade]) || twin.parked[item]) continue;
            // A crystal's cap is also the cheapest NPC gear route it reaches, the fare included.
            const value = useValue(recipe, item, after, held), capped = Bounds.cap({ worth: value, routeCost: grade ? view.crystalReach[grade]?.perCrystal ?? null : null });
            if (!(capped.cap >= 1)) continue;
            buys.push({ item, qty: short, value, cap: capped.cap, capBy: capped.by });
        }
    }
    // A scroll is worth its margin gain (over the worst held with a full book) x
    // MP per hour x the hours to its main's next grade (ours).
    for (const { id, gain } of recipes.want) {
        const item = game.recipes[id].recipeItemId;
        if (twin.parked[item]) continue;
        const capped = Bounds.cap({ worth: gain * twin.regen * Math.max(1, view.hoursToGrade || 1) });
        if (!(capped.cap >= 1)) continue;
        buys.push({ item, qty: 1, value: capped.cap, cap: capped.cap, capBy: capped.by, hourValue: gain * twin.regen });
    }
    const buyLines = [];
    for (const row of buys) {
        if (buyLines.length >= twin.storeSlots.buy) break;
        const qty = Math.min(row.qty, Math.floor(budget / row.cap));
        if (qty < 1) continue;
        budget -= qty * row.cap;
        const known = Knowledge.known(view.memory, row.item);
        prices[`buy:${row.item}`] = { cap: row.cap, capBy: row.capBy, floor: 0, known, first: game.firstPrice[row.item] ?? row.cap };
        const listed = twin.lines.find(line => line.side === 'buy' && line.item === row.item);
        buyLines.push({ ...row, qty, price: listed?.price ?? Math.min(known ?? row.cap, row.cap) * view.persona.buyerStart });
    }
    const batchUnits = best ? bestCrafts * game.recipes[best.id].productCount : 0;
    const offered = sells.slice(0, twin.storeSlots.sell);
    const manufacture = orderPlan.batch ? orders[0].order.fee : 0;
    const { mode, values, stint, stints, stintEnded } = chooseMode(view, offered, buyLines, batchUnits, manufacture);
    const chosen = mode === 'manufacture' && orderPlan.batch ? orderPlan : plan;
    // Its buy lines first take what other twins' sell lines in its town offer
    // at or under the line's cap (first come), within its wallet.
    const claims = [];
    let cash = twin.wallet - chosen.npcBuys.reduce((sum, row) => sum + row.count * row.price, 0) - chosen.routeBuys.reduce((sum, row) => sum + row.count * row.price, 0);
    for (const row of buyLines) {
        for (const entry of view.books[view.place.twinTown]?.sell?.[row.item] || []) {
            if (row.qty <= 0 || entry.price > row.cap) break;
            if (entry.owner === view.self) continue;
            const units = Math.min(row.qty, entry.qty, Math.floor(cash / entry.price));
            if (units <= 0) break;
            claims.push({ owner: entry.owner, id: entry.id, item: row.item, units, price: entry.price });
            cash -= units * entry.price; row.qty -= units;
        }
    }
    const wanted = [];
    // A new sell line of a good whose last line sold out resumes that line's
    // step one look back (sellerLook 'unsold_look', ours); otherwise it
    // starts afresh at its known price (the design's text).
    const resumeOf = item => (config.sellerLook === 'unsold_look' ? twin.soldOut?.[item] ?? null : null);
    if (mode === 'sell') {
        for (const row of offered) {
            const lineId = lineIdOf(twin, 'sell', row.item), fresh = view.applied?.item === row.item ? view.applied.units : 0;
            // A batch's units start a new line beside the unsold remainder when a
            // slot is free (restockLine 'new_line'), or join the unsold line and its step ('continue').
            if (config.restockLine === 'new_line' && lineId && fresh > 0 && fresh < row.qty && wanted.length + 1 < twin.storeSlots.sell) {
                wanted.push({ side: 'sell', item: row.item, qty: row.qty - fresh, lineId });
                wanted.push({ side: 'sell', item: row.item, qty: fresh, lineId: null, resume: resumeOf(row.item) });
            } else {
                const id = config.restockLine === 'new_line' && fresh > 0 && fresh >= row.qty ? null : lineId;
                wanted.push({ side: 'sell', item: row.item, qty: row.qty, lineId: id, resume: id ? null : resumeOf(row.item) });
            }
        }
    } else if (mode === 'buy') {
        for (const row of buyLines) if (row.qty > 0) wanted.push({ side: 'buy', item: row.item, qty: row.qty, lineId: lineIdOf(twin, 'buy', row.item) });
    }
    // Crystallizer bids (ours): one standing bid per grade it crystallizes and
    // uses, P per crystal for any gear of the grade, up to min(its use value,
    // the cheapest NPC gear route it reaches, the fare included), for the
    // crystals of its crystal-stock hours.
    const bidWanted = [], bidPrices = {};
    const top = twin.crystallize ? GRADES.indexOf(twin.crystallize) : -1;
    for (const grade of GRADES.slice(0, top + 1)) {
        const crystal = game.crystalIds[grade.toUpperCase()];
        const user = ranked.find(row => row.m.perMp > 0 && game.recipes[row.id].materials.some(material => material.selfId === crystal));
        if (!user) continue;
        const recipe = game.recipes[user.id], perCraft = recipe.materials.find(material => material.selfId === crystal).amount;
        const want = Math.ceil(twin.regen / recipe.mpCost * perCraft * config.crystalStockHours) - (stock[crystal] || 0);
        const capped = Bounds.cap({ worth: useValue(recipe, crystal, after, held), routeCost: view.crystalReach[grade]?.perCrystal ?? null });
        const qty = Math.min(want, Math.floor(budget / Math.max(1, capped.cap)));
        if (qty < 1 || !(capped.cap >= 1)) continue;
        budget -= qty * capped.cap;
        bidPrices[`buy:${grade}`] = { cap: capped.cap, capBy: capped.by, floor: 0, known: Knowledge.known(view.memory, crystal), first: game.firstPrice[crystal] ?? capped.cap };
        bidWanted.push({ side: 'buy', item: grade, qty, lineId: twin.bids.find(bid => bid.item === grade)?.id || null });
    }
    return { learn: recipes.learn, forget: recipes.forget, want: recipes.want.map(row => row.id), wants: recipes.want, crystallize, batch: chosen.batch, npcBuys: chosen.npcBuys, routeBuys: chosen.routeBuys,
        mode, modeValues: values, stint, stints, stintEnded, wanted, prices, bidWanted, bidPrices, counters: chosen.counters, claims, order: chosen === orderPlan && orderPlan.batch ? orders[0].order.id : null };
}

// The twin's seat (ours): at its main's arrival in town X it moves to X when
// X's open buy lines for goods it crafts, valued at what each pays over its
// unit cost, reach the re-seat factor times its own town's and it can pay
// the gatekeeper fare. Returns the town it sits in.
function seat(view, arrivedIn) {
    const { twin, game, books } = view, held = heldRecipes(twin, game);
    if (!arrivedIn || arrivedIn === twin.town) return twin.town;
    const fare = view.fares[twin.town]?.[arrivedIn];
    if (fare === null || fare === undefined || twin.wallet < fare) return twin.town;
    const valueOf = town => {
        let sum = 0;
        for (const id of held) {
            const item = game.recipes[id].productId, cost = unitCost(item, view, held)?.cost;
            if (cost === undefined) continue;
            for (const line of books[town]?.buy?.[item] || []) if (line.owner !== view.self) sum += line.qty * Math.max(0, line.price - cost);
            // The mains' WTBs posted in that town are its demand too.
            for (const ad of view.ads?.buy?.[item] || []) if (ad.owner !== view.self && ad.town === town) sum += ad.qty * Math.max(0, ad.price - cost);
        }
        return sum;
    };
    const there = valueOf(arrivedIn);
    return there > 0 && there >= view.config.reseatFactor * valueOf(twin.town) ? arrivedIn : twin.town;
}

// The seat as part of the mode choice (ours): at its main's arrival in
// another town the twin moves when its best mode there, weighed on that
// town's book, beats its best mode here by more than the gatekeeper fare.
// here, there: the workshop's mode values ({ sell, buy, manufacture },
// adena per seat-hour) seated in each town. Returns true to move.
function seatByMode({ here, there, fare }) {
    const best = values => Math.max(0, ...Object.values(values || {}));
    return best(there) - best(here) > fare;
}

// The account warehouse's money at a main's arrival (ours): the account
// pools its money; the main keeps what its next outing and next kit piece
// need (keep), the twin's open buy lines and bids keep their cost, the rest
// funds the twin's wallet. Returns { main, wallet, moved }.
function pool({ main, wallet, escrow, keep }) {
    const total = main + wallet, toMain = Math.max(0, Math.min(keep, total - escrow));
    return { main: toMain, wallet: total - toMain, moved: Math.abs(main - toMain) };
}

// What a pair's main leaves its twin from its bag (ours): the materials of
// the twin's held and decided recipes, and one copy of each recipe scroll
// its Create Item level allows that the twin neither holds nor has in stock
// (a recipe is learned once; the main sells the other copies). Returns
// { item: count }.
function depositFor(bag, twin, game, decided = []) {
    const held = heldRecipes(twin, game), wanted = new Set();
    for (const id of [...held, ...decided]) for (const material of game.recipes[id].materials) wanted.add(material.selfId);
    const out = {};
    for (const [key, count] of Object.entries(bag)) {
        const item = Number(key), recipeId = game.byScroll[item], recipe = recipeId ? game.recipes[recipeId] : null;
        if (!(count > 0)) continue;
        if (wanted.has(item)) out[item] = count;
        else if (recipe && recipe.type === 'dwarven' && !recipe.quest && !held.has(recipeId) && recipe.level <= twin.createItem && !(twin.stock[item] > 0)) out[item] = 1;
    }
    return out;
}

module.exports = { workshop, margin, useValue, replacement, productPrice, mpAt, heldRecipes, decideRecipes, crystallizeList, planBatch,
    chooseMode, seat, seatByMode, pool, depositFor, crystalValue, RECIPE_BOOK_LIMIT, GRADES, isGear };
