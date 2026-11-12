'use strict';

// workshop (economy design, account plane): which recipes a crafter account
// holds, what its twin crafts and the twin's store mode, by adena per MP for
// crafts and adena per seat-hour between modes, read from open bids and its
// own deals. Liquid goods (shots, crystals, intermediates) are made ahead;
// gear at most one unsold piece per recipe; a margin that turned negative
// stops that recipe. Also the twin's seat (seatByMode), the account warehouse's
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
// margin falls to zero with the other inputs at their unit cost; price: the
// product's (its own main's worth of it for a batch its main needs), else
// the workshop's product price.
function useValue(recipe, item, view, held, price = null) {
    const m = price === null ? margin(recipe, view, held) : marginAt(recipe, price, view, held), material = recipe.materials.find(row => row.selfId === item);
    if (!m || !material) return 0;
    const own = unitCost(item, view, held);
    return Math.max(0, (m.revenue - m.cost + material.amount * (own?.cost || 0)) / material.amount);
}

// Its own main's worth of one unit of an item (view.own: the shot it fires,
// the path pieces it does not wear), null when its main does not need it.
function ownWorth(view, item) {
    const own = view.own;
    if (!own) return null;
    if (own.shot && own.shot.id === item && own.shot.worth > 0) return own.shot.worth;
    const piece = (own.pieces || []).find(row => row.selfId === item);
    return piece && piece.worth > 0 ? piece.worth : null;
}

// Adena per MP of a recipe to its account (ours): the better of the market
// margin and the margin at its own main's worth of the product (a pair's twin
// learns the shot its main fires and the recipe of a path piece no NPC sells
// though no buyer bids for them). null when neither prices.
function recipeValue(recipe, view, held) {
    const m = margin(recipe, view, held), worth = ownWorth(view, recipe.productId);
    const own = worth === null ? null : marginAt(recipe, worth, view, held);
    if (!own) return m;
    return !m || own.perMp > m.perMp ? own : m;
}

// What its own twin's craft of a piece costs its account (ours): of the
// recipes the twin can follow now (one it holds, or whose scroll the
// account's warehouse holds, within its Create Item level, every input in
// its stock for one craft, at the NPC or NPC gear for a crystal in its town,
// or on another owner's sell line there), the least per piece: the inputs at
// their unit cost over the pieces one craft makes. hours: the craft's MP per
// piece over the twin's regen. null when none fits: the piece keeps its
// money routes. view: { twin, game, npcSell, crystalReach, memory, books
// (the town books), self (the account) }.
function ownCraft(view, selfId) {
    const { twin, game } = view, held = heldRecipes(twin, game);
    if (!(twin.createItem >= 1) || !(twin.regen > 0)) return null;
    const obtainable = material => (twin.stock[material.selfId] || 0) >= material.amount || view.npcSell[material.selfId] > 0
        || (game.crystalGrade[material.selfId] && view.crystalReach[game.crystalGrade[material.selfId]])
        || Knowledge.reach({ town: twin.town }, view.books || {}, material.selfId, view.self).rivalSell !== null;
    let best = null;
    for (const id of game.byProduct[selfId] || []) {
        const recipe = game.recipes[id], has = held.has(id), made = recipe.productCount * recipe.successRate / 100;
        if (!(made > 0) || (!has && (recipe.type !== 'dwarven' || recipe.quest || recipe.level > twin.createItem || !((twin.stock[recipe.recipeItemId] || 0) > 0)))) continue;
        if (!recipe.materials.every(obtainable)) continue;
        const m = marginAt(recipe, 0, view, held);
        if (!m) continue;
        const cost = m.cost / made;
        if (!best || cost < best.cost) best = { recipeId: id, cost, hours: m.mp / made / twin.regen, held: has };
    }
    return best;
}

// Recipes a twin may learn: dwarven, within its Create Item level, not held,
// not a quest variant; all of them at its main's arrival, else only those
// whose scroll it holds (a fill or a batch brings no new recipe to rank).
// Ranked by their value to the account (recipeValue).
function candidates(view, held) {
    const { twin, game } = view, out = [];
    const ids = view.rankRecipes ? game.dwarven : Object.keys(twin.stock).map(item => game.byScroll[item]).filter(id => id && twin.stock[game.recipes[id].recipeItemId] > 0);
    for (const id of ids) {
        const recipe = game.recipes[id];
        if (recipe.level > twin.createItem || held.has(id) || recipe.quest) continue;
        const m = recipeValue(recipe, view, held);
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
    const book = twin.recipes.map(id => ({ id, perMp: recipeValue(game.recipes[id], view, held)?.perMp ?? -Infinity }))
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
// gear) that one hour of seated regen covers, at least one, and no more than
// a row's maxCrafts (its own main's shortfall); gear one at a time and only
// with no unsold piece on its shelf. deadline = now + (crafts x MP cost - MP
// held) / regen. use names whom it crafts for ('own' | 'shelf'). need: the
// adena the bought inputs of the first recipe with inputs at hand take at its
// full size, whatever the wallet holds (the money it asks of its account).
// batch null when nothing pays or no input is at hand. shelfStock 'by_sales'
// (ours; the design's text 'unbounded': liquid goods are made ahead): a
// shelf batch of a liquid good waits while the twin's unsold units of it
// exceed shelfStockFactor times what left its shelf (sold, or drawn by its
// own main) since its last batch of it (counted: shelfFull).
function planBatch(view, held, stock, ranked, use = 'shelf') {
    const { twin, game, now, config } = view, mp = mpAt(twin, now), counters = { gearCapped: 0, stopped: [], shelfFull: 0 };
    let need = null;
    for (const { id, m, maxCrafts } of ranked) {
        const recipe = game.recipes[id];
        if (!(m.perMp > 0)) { counters.stopped.push(id); continue; }
        if (isGear(game.items[recipe.productId]) && (stock[recipe.productId] || 0) > 0) { counters.gearCapped++; continue; }
        if (use === 'shelf' && config.shelfStock === 'by_sales' && !isGear(game.items[recipe.productId])
            && (stock[recipe.productId] || 0) > config.shelfStockFactor * (twin.sinceBatch?.[recipe.productId] || 0)) { counters.shelfFull++; continue; }
        let crafts = isGear(game.items[recipe.productId]) ? 1 : Math.max(1, Math.floor((mp + twin.regen * view.config.batchHours) / recipe.mpCost));
        if (maxCrafts !== undefined) crafts = Math.min(crafts, maxCrafts);
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
            const short = Math.max(0, count * row.material.amount - row.have);
            return sum + (row.grade ? Math.ceil(short / view.crystalRoute[row.grade].crystals) * view.crystalRoute[row.grade].price : short * row.price);
        }, 0);
        if (need === null) need = spendOf(crafts);
        while (crafts >= 1) {
            if (spendOf(crafts) <= twin.wallet) break;
            crafts = Math.max(0, Math.min(crafts - 1, Math.floor(twin.wallet / Math.max(1, costPerCraft))));
        }
        if (crafts < 1) continue;
        const npcBuys = [], routeBuys = [];
        for (const row of shortPerCraft) {
            const short = Math.max(0, crafts * row.material.amount - row.have);
            if (!short) continue;
            if (!row.grade) { npcBuys.push({ selfId: row.material.selfId, count: short, price: row.price }); continue; }
            const route = view.crystalRoute[row.grade], pieces = Math.ceil(short / route.crystals);
            routeBuys.push({ selfId: route.gearId, count: pieces, price: route.price, crystals: route.crystals, grade: row.grade });
        }
        const deadline = now + Math.max(0, crafts * recipe.mpCost - mp) / twin.regen;
        return { batch: { recipeId: id, crafts, deadline, mpAtStart: mp, perMp: m.perMp, orderId: null, use }, npcBuys, routeBuys, counters, need: need || 0 };
    }
    return { batch: null, npcBuys: [], routeBuys: [], counters, need: need || 0 };
}

// Its own main's shortfall it can craft (ownUseFirst, ours): the shot its
// main fires up to the kit rule's refill (what its main took at its last
// visit) less what the warehouse holds, and the path pieces it holds a
// recipe for and does not hold. Inside an account there is no price: a unit
// is crafted for its main when the main's worth of it reaches the best bid
// in reach (else a buyer values it above its own main) and pays its inputs.
// Rows ranked by the margin at the main's worth, each held to the crafts its
// shortfall takes. view.own: { shot: { id, amount, worth } | null, pieces:
// [{ selfId, worth }] }. Returns { rows, kept: { item: units } (what its
// main will draw: the shortfall of every target no buyer values above its
// main, kept off the twin's sell lines) }.
function ownRows(view, after, held, stock) {
    const own = view.own || {}, targets = [], rows = [], kept = {};
    if (own.shot) targets.push({ item: own.shot.id, amount: own.shot.amount - (stock[own.shot.id] || 0), want: own.shot.amount, worth: own.shot.worth });
    for (const piece of own.pieces || []) targets.push({ item: piece.selfId, amount: 1 - (stock[piece.selfId] || 0), want: 1, worth: piece.worth });
    for (const { item, amount, want, worth } of targets) {
        if (!(worth > 0)) continue;
        const { bestBid } = Knowledge.reach(view.place, view.books, item, view.self, view.ads);
        if (bestBid !== null && bestBid > worth) continue;
        kept[item] = (kept[item] || 0) + want;
        if (!(amount > 0)) continue;
        for (const id of view.game.byProduct[item] || []) {
            if (!held.has(id)) continue;
            const recipe = view.game.recipes[id], m = marginAt(recipe, worth, after, held);
            if (m && m.perMp > 0) rows.push({ id, m, worth, maxCrafts: Math.ceil(amount / (recipe.productCount * recipe.successRate / 100)) });
        }
    }
    return { rows: rows.sort((a, b) => b.m.perMp - a.m.perMp || a.id - b.id), kept };
}

// What a twin must bring to an order (supplied: the units the customer left
// to the crafter): from its stock, else bought at its town's NPC, crystals
// through the NPC gear route. null when a unit has none of the three or its
// wallet with the fee cannot pay them. Returns { npcBuys, routeBuys, cost
// (the adena the buys take) }.
function suppliedBuys(view, supplied, fee) {
    const { twin, game } = view, npcBuys = [], routeBuys = [];
    let cost = 0;
    for (const [key, count] of Object.entries(supplied || {})) {
        const item = Number(key), short = Math.max(0, count - (twin.stock[item] || 0)), grade = game.crystalGrade[item];
        if (!short) continue;
        if (view.npcSell[item] > 0) { npcBuys.push({ selfId: item, count: short, price: view.npcSell[item] }); cost += short * view.npcSell[item]; continue; }
        const route = grade ? view.crystalRoute[grade] : null;
        if (!route) return null;
        const pieces = Math.ceil(short / route.crystals);
        routeBuys.push({ selfId: route.gearId, count: pieces, price: route.price, crystals: route.crystals, grade });
        cost += pieces * route.price;
    }
    return cost <= twin.wallet + fee ? { npcBuys, routeBuys, cost } : null;
}

// The batch of an order: one craft of its recipe from the buyer's
// materials and what the twin brings, at the twin's MP; deadline = now +
// (MP cost - MP held) / regen.
function orderBatch(view, { order, id, perMp, buys }) {
    const { twin, game, now } = view, mp = mpAt(twin, now), recipe = game.recipes[id];
    return { batch: { recipeId: id, crafts: 1, deadline: now + Math.max(0, recipe.mpCost - mp) / twin.regen, mpAtStart: mp, perMp, orderId: order.id, use: 'order' },
        npcBuys: buys?.npcBuys || [], routeBuys: buys?.routeBuys || [], counters: { gearCapped: 0, stopped: [], shelfFull: 0 }, need: 0 };
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
// per seat-hour). The highest wins; a tie keeps the current mode. With a
// buyer twin (buyer) the buy lines are its store: the crafter twin chooses
// between sell and manufacture.
// The mode memory: the running stint (twin.stint { since, units (filled on
// its own store's lines), goods }) ends when the mode or the goods on offer
// change, and is kept only when something was on offer and something filled
// (an unfilled stint says nothing of a rate: it would score its mode 0 for
// ever); a kept stint is forgotten once its mode would offer other goods
// (not while it would offer none).
// Returns { mode, values, stint (the running one), stints (the kept),
// stintEnded: null | 'kept' | 'unfilled' }.
function chooseMode(view, sells, buys, batchUnits, manufacture = 0, buyer = false) {
    const { twin, now } = view, offer = { sell: offerKey(sells), buy: offerKey(buys), manufacture: '' };
    const kept = memory => Object.fromEntries(Object.entries(memory).filter(([mode, stint]) => (stint.goods === offer[mode] || !offer[mode]) && stint.hours > 0));
    let stints = kept(twin.stints || {});
    const rate = mode => (stints[mode]?.goods === offer[mode] ? stints[mode].units / stints[mode].hours : Math.max(1, batchUnits));
    const sellRate = rate('sell'), buyRate = rate('buy');
    const sell = sells.reduce((sum, row) => sum + Math.min(row.qty, sellRate) * Math.max(0, row.price - row.cost), 0);
    const buy = buys.reduce((sum, row) => sum + (row.hourValue ?? Math.min(row.qty, buyRate) * Math.max(0, row.value - row.price)), 0);
    const values = { sell, buy, manufacture };
    const options = buyer ? ['sell', 'manufacture'] : ['sell', 'buy', 'manufacture'];
    let mode = options.includes(twin.mode) ? twin.mode : options[0];
    for (const option of options) if (values[option] > values[mode]) mode = option;
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
// storeSlots { sell, buy, buyer (a buyer twin's buy slots) }, lines, bids, parked }, game { recipes, dwarven,
// questRecipes, byProduct, items, crystalIds, crystalGrade, firstPrice,
// sourced }, npcSell { item: price in its town }, crystalRoute { grade:
// { perCrystal, gearId, price, crystals } in its town }, crystalReach { grade:
// { perCrystal (price + fare over crystals), town, fare } the cheapest it
// reaches }, applied { item, units } after a batch, hoursToGrade,
// rankRecipes: rank every recipe it could learn (its main's arrival), own
// (its main's shortfall, ownRows) }.
// Returns { learn, forget, want, wants, crystallize, batch (use: 'own' |
// 'order' | 'shelf'), npcBuys, routeBuys, mode, modeValues, stint, stints,
// stintEnded, buyer (the account holds a buyer twin: config.buyerTwin, opened
// at the first wake with buy lines while its crafter twin has goods to sell;
// it shows the buy lines, stock only, never gear: crystallizer bids stay
// the crafter twin's), wanted, prices, bidWanted, bidPrices, counters, needs { item:
// count } (what its main keeps for it), surplus { item: count } (what its
// main takes out of the warehouse to sell), inputMoney }.
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
    // Its own main first (ownUseFirst, ours): a batch for its main's
    // shortfall, then orders, then the shelf.
    const idle = { batch: null, npcBuys: [], routeBuys: [], counters: { gearCapped: 0, stopped: [], shelfFull: 0 }, need: 0 };
    const ownPass = config.ownUseFirst ? ownRows(view, after, held, stock) : { rows: [], kept: {} }, own = ownPass.rows;
    const ownPlan = own.length ? planBatch(after, held, stock, own, 'own') : idle, shelf = planBatch(after, held, stock, ranked);
    const plan = twin.batch ? idle : ownPlan.batch ? ownPlan : shelf;
    // Orders it can take (a buyer's "craft X for me" from the buyer's own
    // materials, first come): a recipe it holds, ranked by the fee per MP of
    // one craft; one is worth taking when that reaches the margin per MP of
    // the batch it would craft otherwise (the MP's other work). The best order's fee is
    // manufacture's value.
    const orders = [], ownBest = plan.batch ? plan.batch.perMp : 0;
    for (const order of plan.batch?.use === 'own' ? [] : view.orders || []) {
        if (!held.has(order.recipeId)) continue;
        // What it must bring is paid out of the fee: the fee less those buys per MP.
        const buys = suppliedBuys(after, order.supplied, order.fee);
        if (!buys) continue;
        const perMp = (order.fee - buys.cost) / game.recipes[order.recipeId].mpCost;
        if (perMp > 0 && perMp >= ownBest) orders.push({ order, id: order.recipeId, perMp, buys });
    }
    orders.sort((a, b) => b.perMp - a.perMp || a.order.id.localeCompare(b.order.id));
    const orderPlan = twin.batch || !orders.length ? idle : orderBatch(view, orders[0]);
    const prices = {}, sells = [], buys = [];
    // The recipe it would craft next (its own main's first) and one batch of
    // its inputs, kept off its sell lines.
    const capped = row => isGear(game.items[game.recipes[row.id].productId]) && (stock[game.recipes[row.id].productId] || 0) > 0;
    const best = own.find(row => !capped(row)) || ranked.find(row => row.m.perMp > 0 && !capped(row));
    const batchOf = recipe => (isGear(game.items[recipe.productId]) ? 1 : Math.max(1, Math.floor((twin.maxMp + twin.regen * config.batchHours) / recipe.mpCost)));
    const bestCrafts = best ? Math.max(1, Math.floor((twin.maxMp + twin.regen * config.batchHours) / game.recipes[best.id].mpCost)) : 0;
    const reserve = {};
    if (best) for (const material of game.recipes[best.id].materials) reserve[material.selfId] = bestCrafts * material.amount;
    // What its own main will draw through the warehouse stays off its lines
    // too, unless a buyer in reach values it above its main.
    for (const [item, units] of Object.entries(ownPass.kept)) reserve[item] = (reserve[item] || 0) + units;
    // What one batch of each recipe it holds with a positive margin or
    // decided to add asks, the most any one asks per input: the inputs its
    // main keeps for it (needs, less what it holds) and the crafted inputs it
    // keeps off its lines.
    const asks = {};
    for (const id of [...ranked.filter(row => row.m.perMp > 0).map(row => row.id), ...recipes.want.map(row => row.id)]) {
        const recipe = game.recipes[id];
        for (const material of recipe.materials) asks[material.selfId] = Math.max(asks[material.selfId] || 0, batchOf(recipe) * material.amount);
    }
    const needs = {};
    for (const [item, amount] of Object.entries(asks)) if (amount > (stock[item] || 0)) needs[item] = amount - (stock[item] || 0);
    // Materials in the warehouse no recipe it holds or decided to add uses
    // (one dropped or never learned): surplus its main takes out and sells.
    const uses = new Set([...held].map(id => game.recipes[id].productId)), surplus = {};
    for (const id of [...held, ...recipes.want.map(row => row.id)]) for (const material of game.recipes[id].materials) uses.add(material.selfId);
    for (const [key, count] of Object.entries(stock)) {
        const item = Number(key);
        if (count > 0 && !uses.has(item) && !isGear(game.items[item]) && game.items[item]?.kind !== 'Other.Shot' && !game.crystalGrade[item] && !game.byScroll[item]) surplus[item] = count;
    }
    // Crystals of a grade it uses, kept off its lines and asked for by its
    // crystallizer bid. crystalStock 'queued' (ours): what its queued
    // batches take (the next batch, one batch of each recipe it holds with a
    // positive margin or decided to add, the most any one asks); 'hours' (the
    // model before): what crystalStockHours of its best recipe using them take.
    const top = twin.crystallize ? GRADES.indexOf(twin.crystallize) : -1, crystalUse = {};
    for (const grade of GRADES.slice(0, top + 1)) {
        const crystal = game.crystalIds[grade.toUpperCase()];
        const user = own.find(row => game.recipes[row.id].materials.some(material => material.selfId === crystal))
            || ranked.find(row => row.m.perMp > 0 && game.recipes[row.id].materials.some(material => material.selfId === crystal));
        if (!user) continue;
        const recipe = game.recipes[user.id], perCraft = recipe.materials.find(material => material.selfId === crystal).amount;
        const keep = config.crystalStock === 'hours' ? Math.ceil(twin.regen / recipe.mpCost * perCraft * config.crystalStockHours)
            : Math.max(reserve[crystal] || 0, asks[crystal] || 0, batchOf(recipe) * perCraft);
        crystalUse[grade] = { crystal, recipe, keep, price: user.worth ?? null };
    }
    // Sell lines: goods of its own recipes beyond that, dearest stock first,
    // and the liquid goods of its store (the design's sell store): crystals
    // of the grades it crystallizes beyond its crystal stock, and the crafted
    // inputs of the recipes it holds beyond one batch of each.
    // The floor: max(npcBuy, the best crystallizer bid in reach) (the
    // design's text); with askFloorAtCost (ours, pending the maintainer)
    // also its input cost per unit at its own unit costs (a good it did not
    // craft: what it paid), where the line parks instead of selling under
    // what the inputs cost.
    const products = new Set([...held].map(id => game.recipes[id].productId)), crystalGrades = {};
    for (const grade of GRADES.slice(0, top + 1)) crystalGrades[game.crystalIds[grade.toUpperCase()]] = grade;
    const keepOf = item => (products.has(item) ? reserve[item] || 0
        : crystalGrades[item] ? Math.max(reserve[item] || 0, crystalUse[crystalGrades[item]]?.keep || 0) : Math.max(reserve[item] || 0, asks[item] || 0));
    for (const [key, count0] of Object.entries(stock)) {
        const item = Number(key), count = count0 - keepOf(item);
        if (!(count > 0) || !(products.has(item) || crystalGrades[item] || (asks[item] && game.byProduct[item]))) continue;
        const piece = game.items[item], grade = gradeOf(piece);
        const bid = isGear(piece) && piece.crystals > 0 ? Knowledge.bestCrystalBid(view.place, view.books, grade, view.self) : null;
        const market = Bounds.floor({ npcBuy: piece?.npcBuy || 0, crystallizerBids: bid ? [bid * piece.crystals] : [] });
        const inputs = config.askFloorAtCost ? craftOf(item, after, held, 0)?.cost ?? (products.has(item) ? 0 : twin.paid[item] ?? 0) : 0;
        const floor = Math.max(market, inputs), floorBy = inputs > market ? 'cost' : 'market';
        // sellerSeesBids (ours): a standing WTB above its ask is where its ask
        // starts and restarts; the design's text: its known price is rival
        // lines and its own deals only.
        const { rivalSell, bestBid, bidUnits } = Knowledge.reach(view.place, view.books, item, view.self, view.ads);
        const known = Knowledge.known(view.memory, item), first = firstPriceOf(item, after, held) ?? floor;
        prices[`sell:${item}`] = { floor, floorBy, rival: rivalSell, known, first, bid: config.sellerSeesBids ? bestBid : null, bidUnits, gear: isGear(piece) };
        const listed = twin.lines.find(line => line.side === 'sell' && line.item === item);
        // Its store's value of the line (the mode and the seat read it): its
        // price, or with sellerSeesBids the units the standing bid in reach
        // takes at that bid when it is above it (its ask starts there) and
        // the rest at its price: price is the line's value per unit, a
        // town's demand counts in the seat.
        const own = listed?.price ?? known ?? first;
        const atBid = config.sellerSeesBids && bestBid > own ? Math.min(count, bidUnits) : 0;
        sells.push({ item, qty: count, price: (atBid * bestBid + (count - atBid) * own) / count, cost: twin.paid[item] ?? 0 });
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
            const value = useValue(recipe, item, after, held, best.worth ?? null), capped = Bounds.cap({ worth: value, routeCost: grade ? view.crystalReach[grade]?.perCrystal ?? null : null });
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
    // With a buyer twin (one open, or one it opens now: goods on offer) the
    // buy lines take its slots (storeSlots.buyer), else the crafter twin's.
    const offered = sells.slice(0, twin.storeSlots.sell);
    const buyerStore = !!twin.buyer || (config.buyerTwin === true && offered.length > 0);
    const buySlots = buyerStore ? twin.storeSlots.buyer : twin.storeSlots.buy;
    const buyLines = [];
    for (const row of buys) {
        if (buyLines.length >= buySlots) break;
        const qty = Math.min(row.qty, Math.floor(budget / row.cap));
        if (qty < 1) continue;
        budget -= qty * row.cap;
        const known = Knowledge.known(view.memory, row.item);
        prices[`buy:${row.item}`] = { cap: row.cap, capBy: row.capBy, floor: 0, known, first: game.firstPrice[row.item] ?? row.cap };
        const listed = twin.lines.find(line => line.side === 'buy' && line.item === row.item);
        buyLines.push({ ...row, qty, price: listed?.price ?? Math.min(known ?? row.cap, row.cap) * view.persona.buyerStart });
    }
    const batchUnits = best ? bestCrafts * game.recipes[best.id].productCount : 0;
    const manufacture = orderPlan.batch ? orders[0].order.fee : 0;
    const buyer = !!twin.buyer || (config.buyerTwin === true && buyLines.length > 0 && offered.length > 0);
    const { mode, values, stint, stints, stintEnded } = chooseMode(view, offered, buyLines, batchUnits, manufacture, buyer);
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
    }
    if (mode === 'buy' || buyer) {
        for (const row of buyLines) if (row.qty > 0) wanted.push({ side: 'buy', item: row.item, qty: row.qty, lineId: lineIdOf(twin, 'buy', row.item) });
    }
    // Crystallizer bids (ours): one standing bid per grade it crystallizes and
    // uses, P per crystal for any gear of the grade, up to min(its use value,
    // the cheapest NPC gear route it reaches, the fare included), for the
    // crystals of its crystal-stock hours.
    const bidWanted = [], bidPrices = {};
    for (const grade of GRADES.slice(0, top + 1)) {
        if (!crystalUse[grade]) continue;
        const { crystal, recipe, keep, price } = crystalUse[grade];
        const want = keep - (stock[crystal] || 0);
        const capped = Bounds.cap({ worth: useValue(recipe, crystal, after, held, price), routeCost: view.crystalReach[grade]?.perCrystal ?? null });
        const qty = Math.min(want, Math.floor(budget / Math.max(1, capped.cap)));
        if (qty < 1 || !(capped.cap >= 1)) continue;
        budget -= qty * capped.cap;
        bidPrices[`buy:${grade}`] = { cap: capped.cap, capBy: capped.by, floor: 0, known: Knowledge.known(view.memory, crystal), first: game.firstPrice[crystal] ?? capped.cap };
        bidWanted.push({ side: 'buy', item: grade, qty, lineId: twin.bids.find(bid => bid.item === grade)?.id || null });
    }
    // What its main reads at a visit: the adena its next batches' bought
    // inputs take (own use, then one batch to sell: the money order ranks it).
    return { learn: recipes.learn, forget: recipes.forget, want: recipes.want.map(row => row.id), wants: recipes.want, crystallize, batch: chosen.batch, npcBuys: chosen.npcBuys, routeBuys: chosen.routeBuys,
        mode, modeValues: values, stint, stints, stintEnded, buyer, wanted, prices, bidWanted, bidPrices, counters: chosen.counters, claims, order: chosen === orderPlan && orderPlan.batch ? orders[0].order.id : null,
        needs, surplus, inputMoney: ownPlan.need + shelf.need };
}

// The seat as part of the mode choice (ours): at its main's arrival in
// another town the twin moves when its best store there, weighed on that
// town's book, beats its best store here by more than the gatekeeper fare.
// here, there: the workshop's mode values ({ sell, buy, manufacture },
// adena per seat-hour) seated in each town. One twin holds one mode: the
// best of the three; with a buyer twin (buyer) the buy lines are its store
// beside the crafter twin's: max(sell, manufacture) + buy. seatGain returns
// the gain net of the fare; seatByMode returns true to move (the net gain is
// above 0).
function seatGain({ here, there, fare, buyer = false }) {
    const best = values => (buyer ? Math.max(0, values?.sell || 0, values?.manufacture || 0) + Math.max(0, values?.buy || 0) : Math.max(0, ...Object.values(values || {})));
    return best(there) - best(here) - fare;
}
function seatByMode(seat) {
    return seatGain(seat) > 0;
}

// The account warehouse's money at a main's arrival (ours): the account
// pools its money; the twin's open buy lines and bids keep their cost, the
// main keeps what its next outing (reserve) and next kit piece (piece)
// need, the rest funds the twin's wallet. workshopMoney 'after_path' (the
// design's money order has no place for it: the model before): the
// workshop's inputs come after both. 'with_reserve' (ours): the inputs its
// next batches take (inputs) rank beside the reserve, before the piece.
// Returns { main, wallet, moved }.
function pool({ main, wallet, escrow, reserve = 0, piece = 0, inputs = 0, workshopMoney = 'after_path' }) {
    const total = main + wallet, free = Math.max(0, total - escrow);
    let toMain;
    if (workshopMoney === 'with_reserve') {
        const kept = Math.min(Math.ceil(reserve), free), funded = Math.min(Math.ceil(inputs), free - kept);
        toMain = kept + Math.min(Math.ceil(piece), free - kept - funded);
    } else toMain = Math.max(0, Math.min(Math.ceil(reserve + piece), total - escrow));
    return { main: toMain, wallet: total - toMain, moved: Math.abs(main - toMain) };
}

// What a pair's main leaves its twin from its bag (ours). keepRule
// 'sell_all_but_kit' (the model before the keep rule): every material of the
// twin's held and decided recipes. 'account_needs' (ours): the materials the
// workshop's last answer needs (twin.needs), up to its amounts. Both: one
// copy of each recipe scroll its Create Item level allows that the twin
// neither holds nor has in stock (a recipe is learned once; the main sells
// the other copies). Returns { item: count }.
function depositFor(bag, twin, game, decided = [], keepRule = 'sell_all_but_kit') {
    const held = heldRecipes(twin, game), wanted = new Set();
    if (keepRule !== 'account_needs') for (const id of [...held, ...decided]) for (const material of game.recipes[id].materials) wanted.add(material.selfId);
    const out = {};
    for (const [key, count] of Object.entries(bag)) {
        const item = Number(key), recipeId = game.byScroll[item], recipe = recipeId ? game.recipes[recipeId] : null;
        if (!(count > 0)) continue;
        if (keepRule === 'account_needs' && twin.needs?.[item] > 0) out[item] = Math.min(count, twin.needs[item]);
        else if (wanted.has(item)) out[item] = count;
        else if (recipe && recipe.type === 'dwarven' && !recipe.quest && !held.has(recipeId) && recipe.level <= twin.createItem && !(twin.stock[item] > 0)) out[item] = 1;
    }
    return out;
}

module.exports = { workshop, margin, useValue, replacement, productPrice, mpAt, heldRecipes, decideRecipes, crystallizeList, planBatch,
    chooseMode, seatByMode, seatGain, pool, depositFor, crystalValue, ownRows, ownCraft, recipeValue, RECIPE_BOOK_LIMIT, GRADES, isGear };
