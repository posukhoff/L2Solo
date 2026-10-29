'use strict';
// The market's shortage per item (decisions 10-28, 'the demand table gives a
// shortage, not a price'; docs/market-picture.md 'Дефицит, а не цена'): how
// much of what the bots need is not held or listed (0..1), as a lean of the
// item's value from the NPC buy-back toward what it costs to get. The bots set
// their own prices from it; the table never says what a buyer pays. Trades
// and bids never move it: a bid is its buyer's tool, not the hunter's signal.
// One table per thread, built by the same code on main (its census) and in the
// worker (its mirror), lagged: at the first read after the census or the
// first prices moved (a census publication, <= 1 per 5 min, DemandCensus),
// never per deal.
//
// - A wished piece (MarketDemand.neededGear) with unmet units (needed - listed
//   on the board): premium = shortage (unmet / needed) x (its first price -
//   buy-back) (FirstPrice: the cheapest way to hunt or make it, inside the NPC
//   walls).
// - A part of a demanded product: the same lean toward what that product's
//   crafter can pay for it (the product's value over the craft's other inputs
//   at their first price, per unit), never above its own first price; its
//   needed units are the product's unmet crafts x its amount. The tree is
//   walked down from the pieces, every demander of a part before it.
// - A shot: its wearers' burn over one forecast window (MarketDemand.censusOf
//   x DELAY_HOURS) is its needed units; its parts and its recipe scrolls
//   follow as a piece's do (an ore whose first price is its buy-back gets no
//   premium).
// - A recipe scroll: its product's shortage over (holders + learners + 1) x
//   (the scroll's first price - buy-back) (holders: public workshops of the
//   recipe; learners: the scroll's buyers on the board).
// Readers: the hunter's loot (premium over the buy-back its loot already
// counts, SpotValueTable.marketLoot) and the money spot shortlist.
// recipeWorth (the world's unmet crafts x margin over the sharers) still caps
// a learner's bid and is what a learned recipe keeps (WishProviders' scroll
// row) until T89 parts 2+3 give the learner a value of its own (decisions
// 10-28 cancel the shared worth).
const Profit = require('./CraftProfitPolicy');
const { SELL, BUY } = require('../../AfkTrade/BoardIndex');
const PriceDecision = require('./PriceDecision');
const MarketDemand = invoke('GameServer/Bot/Economy/MarketDemand');
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
const FirstPrice = invoke('GameServer/Bot/Economy/FirstPrice');
const Recipes = invoke('GameServer/Bot/Economy/RecipeProductionIndex');
const EconomyContext = invoke('GameServer/Bot/Economy/EconomyContext');
const ShotStock = invoke('GameServer/Inventory/ShotStock');

// The part tree is a few floors deep (FirstPrice's MAX_CRAFT_DEPTH); a deeper
// or cyclic walk stops here.
const MAX_DEPTH = 5;
// item id -> price over its buy-back (> 0 only), the held table.
let premiums = new Map();
let heldCensus = -1, heldFirst = -1;
// Moves when a premium moved: a reader holding values made of the table
// (SpotValueTable's spot loot) compares it.
let generation = 0;
// scroll id -> { pot, holders, owners }: its best recipe's unmet crafts x
// margin, the workshops offering it and the owners of the scroll's BUY lines
// (recipeWorth splits the pot among them, the reader's own line left out).
let pots = new Map();
// The scrolls the table prices (priceableScrolls), from the last build.
let scrolls = null;
// Builds, moved builds, the build time (ms) and the bid caps the recipe
// worth lowered (BidPurchaseAlternative.cap) since start (worker heartbeat).
const stats = { builds: 0, moves: 0, ms: 0, capped: 0, shots: 0 };
// recipeId -> the workshops offering it on this thread, whatever their MP now
// (CraftWorkshopService's records on main, ColdSimulationWorker's mirror in
// the worker); none elsewhere.
let holdersOf = () => 0;
// A build in flight: a read it causes (FirstPrice -> the spot table) reads
// the held table.
let building = false;

function useHolders(source) { holdersOf = typeof source === 'function' ? source : () => 0; }

function first(id, timestamp) {
    return Number(MarketCounters.firstPrice(id, timestamp)) || PriceDecision.buyback(id);
}
function listed(board, id) {
    let units = 0;
    for (const line of board?.list(id, SELL) || []) units += Number(line.count) || 0;
    return units;
}
function learners(board, id) {
    const owners = new Set();
    for (const line of board?.list(id, BUY) || []) owners.add(Number(line.ownerId));
    return owners;
}
// A product's recipes at first prices (out: units one craft yields on
// average; cost: its inputs; margin: one craft's), the most margin first:
// its crafters make it by the first, every one of them is worth its share.
function recipesOf(id, value, timestamp) {
    const made = [];
    for (const recipe of Recipes.recipeCatalog().reverse.get(id) || []) {
        if (Number(recipe.productId) !== id) continue;
        const inputs = Profit.requirements(recipe, 1);
        const out = Number(recipe.productCount || 1) * Number(recipe.successRate ?? 100) / 100;
        if (!inputs?.size || !(out > 0)) continue;
        let cost = 0;
        for (const [input, amount] of inputs) cost += amount * first(input, timestamp);
        made.push({ recipe, inputs, out, cost, margin: Recipes.margin(recipe, value, cost) });
    }
    return made.sort((a, b) => b.margin - a.margin);
}

// A recipe's worth to one of its learners: the pot over the holders, the
// other learners and itself (owner: a reader whose own BUY line is not a
// second learner; 0 for the hunter's share, every learner counted).
function share({ pot, holders, owners }, owner = 0) {
    return pot / (holders + owners.size - (owners.has(Number(owner)) ? 1 : 0) + 1);
}
// The items down the recipe tree from `roots` in depth-first post-order
// (every part after the products that take it), at most MAX_DEPTH floors.
function downTree(roots) {
    const order = [], seen = new Set(), catalog = Recipes.recipeCatalog();
    const visit = (id, depth) => {
        if (seen.has(id) || depth > MAX_DEPTH) return;
        seen.add(id);
        for (const recipe of catalog.reverse.get(id) || []) {
            if (Number(recipe.productId) !== id) continue;
            for (const input of (Profit.requirements(recipe, 1) || new Map()).keys()) visit(Number(input), depth + 1);
        }
        order.push(id);
    };
    for (const id of roots) visit(Number(id), 0);
    return order;
}
// The shop shots the table roots (their wearers' burn): the graded ones.
const rootedShots = () => [...ShotStock.SHOP_SHOT_RANK.keys()].filter(id => ShotStock.gradedShopShot(id)).map(Number);
// The scrolls of the recipes the table can price: those whose product is a
// wished kit piece (MarketDemand.forecastOnly), a rooted shot or a part down
// their tree; arrows have no census demand yet. Read again at every build
// (the kits move with the census revision).
function priceableScrolls() {
    const catalog = Recipes.recipeCatalog();
    const products = new Set(downTree([...catalog.rows.map(recipe => Number(recipe.productId))
        .filter(id => MarketDemand.forecastOnly(id)), ...rootedShots()]));
    return new Set(catalog.rows.filter(recipe => products.has(Number(recipe.productId))).map(recipe => Number(recipe.recipeItemId)));
}
function build(board, timestamp) {
    stats.builds++;
    // id -> { units, pay }: the units its demanders need and the most one of
    // them pays per unit.
    const demand = new Map();
    for (const [id, needed] of MarketDemand.neededGear()) demand.set(id, { units: needed, pay: first(id, timestamp) });
    // Shots by their wearers' burn over one forecast window (the census):
    // their parts and scrolls follow as a piece's do.
    stats.shots = 0;
    for (const id of rootedShots()) {
        const burn = Number(MarketDemand.censusOf(id));
        if (burn > 0) { demand.set(id, { units: burn * MarketDemand.DELAY_HOURS, pay: first(id, timestamp) }); stats.shots++; }
    }
    // Every demander of a part before the part: the walk down from the
    // pieces, reversed.
    const order = downTree(demand.keys());
    scrolls = priceableScrolls();
    const next = new Map(), nextPots = new Map();
    for (let at = order.length - 1; at >= 0; at--) {
        const id = order[at], wanted = demand.get(id);
        const unmet = wanted ? wanted.units - listed(board, id) : 0;
        if (!(unmet > 0)) continue;
        // The shortage (0..1) leans the price from the buy-back toward what
        // the item costs to get; the table gives no price of its own.
        const shortage = Math.min(1, unmet / wanted.units);
        const value = Math.min(wanted.pay, first(id, timestamp)), buyback = PriceDecision.buyback(id);
        if (value > buyback) next.set(id, shortage * (value - buyback));
        const made = recipesOf(id, value, timestamp);
        if (!made.length) continue;
        const best = made[0], crafts = unmet / best.out;
        for (const [input, amount] of best.inputs) {
            const part = Number(input), own = first(part, timestamp);
            const pay = (best.out * value - (best.cost - amount * own)) / amount;
            const row = demand.get(part) || { units: 0, pay: 0 };
            row.units += crafts * amount;
            row.pay = Math.max(row.pay, pay);
            demand.set(part, row);
        }
        // Every recipe of the product: the crafts its unmet units take by it.
        for (const { recipe, out, margin } of made) {
            if (!(margin > 0)) continue;
            const scroll = Number(recipe.recipeItemId);
            const row = { pot: unmet / out * margin, holders: holdersOf(Number(recipe.recipeId)), owners: learners(board, scroll) };
            // The scroll's shortage is its product's over the holders and
            // learners and one more: a recipe many know adds little.
            const premium = shortage / (row.holders + row.owners.size + 1)
                * (first(scroll, timestamp) - PriceDecision.buyback(scroll));
            if (premium > (next.get(scroll) || 0)) next.set(scroll, premium);
            // Kept apart from the premium: a learner's own share (its line
            // left out) may clear the buy-back where everyone's does not.
            if (row.pot > (nextPots.get(scroll)?.pot || 0)) nextPots.set(scroll, row);
        }
    }
    pots = nextPots;
    let moved = next.size !== premiums.size;
    for (const [id, premium] of next) if (moved || premiums.get(id) !== premium) { moved = true; break; }
    if (moved) { premiums = next; generation++; stats.moves++; }
}
function fresh(timestamp = Date.now()) {
    if (building) return;
    const census = MarketDemand.censusRevision(), firstPrices = FirstPrice.revision();
    if (census === heldCensus && firstPrices === heldFirst) return;
    building = true;
    const started = performance.now();
    try {
        build(EconomyContext.marketBoard(), timestamp);
        heldCensus = census; heldFirst = firstPrices;
    } finally {
        building = false;
        stats.ms += performance.now() - started;
    }
}
// The item's demand price over its NPC buy-back (0: no unmet demand).
function premium(id) { fresh(); return premiums.get(Number(id)) || 0; }
// The same from the table as it is, for a reader that has just read
// revision() (SpotValueTable.marketLoot: one fresh check per spot sum).
function heldPremium(id) { return premiums.get(Number(id)) || 0; }
// The item's demand price.
function price(id) { return PriceDecision.buyback(id) + premium(id); }
function revision() { fresh(); return generation; }
// A recipe scroll's shared worth to a learner (owner: its own BUY line is
// not another learner): its share of the unmet crafts while it is over the
// buy-back, 0 when no craft is unmet; null for an item the table does not
// price (no recipe scroll, or a product with no census piece demand).
function recipeWorth(id, owner = 0) {
    id = Number(id);
    fresh();
    if (!scrolls?.has(id)) return null;
    const row = pots.get(id), worth = row ? share(row, owner) : 0;
    return worth > PriceDecision.buyback(id) ? worth : 0;
}
module.exports = { premium, heldPremium, price, revision, recipeWorth, useHolders, stats };
