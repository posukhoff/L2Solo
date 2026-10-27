'use strict';
const Sources = require('../../Items/ItemAcquisitionCatalog');
const RecipeCatalog = require('../../Knowledge/RecipeCatalog');
const Profit = require('./CraftProfitPolicy');
const { SELL, BUY } = require('../../AfkTrade/BoardIndex');
const { isMainThread } = require('node:worker_threads');
// lazy: cycle MarketCounters -> MarketDemand -> this module -> PriceBelief -> MarketCounters
const PriceBelief = () => invoke('GameServer/Bot/Economy/PriceBelief');
// lazy: cycle MarketCounters -> MarketDemand -> this module
const MarketCounters = () => invoke('GameServer/Bot/Economy/MarketCounters');
// lazy: cycle FirstPrice -> GearAcquisitionPlanner -> SpotEconomics -> this module
const FirstPrice = () => invoke('GameServer/Bot/Economy/FirstPrice');

// Public candidate admission (rows per craft level) and the shared market
// facts of each recipe (marketFacts: product price, input cost, margin per
// craft at the market's shared prices), computed once per market change of
// one of its items and read by every crafter's admission, the scroll's
// derived demand (scrollValue). Each reader's own step goes on top of them
// (inputCostFor: its own error; ownMargin: its own lines taken out).
// Ownership, funds, exits and the scroll's own price stay per bot.
const boards = new WeakMap();
// Layer-1 facts computed vs read since start (worker heartbeat recipeFacts).
const factStats = { computes: 0, reads: 0 };
let catalog = null;
function recipeCatalog() {
    if (!catalog) {
        const unique = new Map();
        for (const recipe of RecipeCatalog.recipeItemRows(invoke('GameServer/Items/C4RecipeItems'))) {
            if (!Sources.allowsRecipe(recipe) || recipe?.type !== 'dwarven' || !Number.isInteger(Number(recipe.level))
                || recipe.level < 1 || recipe.level > 9 || !(recipe.recipeItemId > 0) || !(recipe.productId > 0)) continue;
            unique.set(Number(recipe.recipeId), recipe);
        }
        const rows = Object.freeze([...unique.values()]);
        const reverse = new Map();
        for (const recipe of rows) for (const id of new Set([Number(recipe.recipeItemId), Number(recipe.productId)])) {
            if (!reverse.has(id)) reverse.set(id, []);
            reverse.get(id).push(recipe);
        }
        for (const rows of reverse.values()) Object.freeze(rows);
        // The items a recipe's market facts read: its product and its inputs.
        const priced = new Map();
        for (const recipe of rows) for (const id of factItems(recipe)) {
            if (!priced.has(id)) priced.set(id, []);
            priced.get(id).push(recipe);
        }
        catalog = Object.freeze({ rows, reverse, priced });
    }
    return catalog;
}
function factItems(recipe) {
    const items = [Number(recipe.productId)];
    for (const input of (Profit.requirements(recipe, 1) || new Map()).keys()) if (!items.includes(Number(input))) items.push(Number(input));
    return items;
}
// One craft's margin: its product value (count x price x success) over its
// inputs' cost. The one formula of the shared facts and of every reader's
// own step (each with its own prices).
function margin(recipe, productPrice, inputCost) {
    return Number(recipe.productCount || 1) * productPrice * Number(recipe.successRate ?? 100) / 100 - inputCost;
}
// One priced item of the facts: its shared price, the owners of its first ask
// and bid (a reader owning one sees another centre: its own lines are no
// source of its belief, PriceBelief.prior excludeOwner) and whether it is a
// recipe scroll (its belief adds a derived demand the shared price leaves out).
function pricedItem(id, amount, price, board) {
    return Object.freeze({ id, amount, price, scroll: isScroll(id),
        owners: Object.freeze([Number(board?.first(id, SELL, { enchant: 0 })?.ownerId) || 0,
            Number(board?.first(id, BUY, { enchant: 0 })?.ownerId) || 0]) });
}
function isScroll(id) {
    return (recipeCatalog().reverse.get(id) || []).some(recipe => Number(recipe.recipeItemId) === id);
}
// One recipe's market facts at the market's shared prices (PriceBelief
// marketPrice: no reader's error, no own line excluded): one craft's
// product value, its inputs' cost and the margin between them, each item
// with its shared price (product, inputs: pricedItem); items: what they read
// (a build that ranks on them reads them through its node inputs,
// ctx.nodeInputs.keep).
function computeFacts(recipe, options) {
    factStats.computes++;
    const Price = PriceBelief(), productId = Number(recipe.productId);
    const product = pricedItem(productId, 1, Price.marketPrice(productId, options), options.board);
    const inputs = [];
    let inputCost = 0;
    for (const [input, amount] of Profit.requirements(recipe, 1) || []) {
        const item = pricedItem(Number(input), amount, Price.marketPrice(input, options), options.board);
        inputCost += amount * item.price;
        inputs.push(item);
    }
    return Object.freeze({ productPrice: product.price, inputCost, margin: margin(recipe, product.price, inputCost),
        product, inputs: Object.freeze(inputs), items: Object.freeze(factItems(recipe)) });
}
class RecipeProductionIndex {
    constructor(board, { censusBuyer = () => false, accept = () => true } = {}) {
        this.board = board; this.censusBuyer = censusBuyer; this.accept = accept;
        this.catalog = recipeCatalog();
        this.rows = Array.from({ length: 10 }, () => new Set());
        this.revisions = new Uint32Array(10);
        // recipeId -> market facts; an entry leaves when one of its items'
        // prices moves (priceMoved, counterMoved, reset) and is computed
        // again at its first read.
        this.facts = new Map();
        // The first prices' generation the held facts read (FirstPrice.revision).
        this.firstPrices = -1;
        this.counters = null;
        // Main: a census publication came since the last row read (censusMoved).
        this.censusStale = false;
        for (const recipe of this.catalog.rows) this.refresh(recipe);
    }
    marketFacts(recipe, timestamp = Date.now()) {
        factStats.reads++;
        const generation = FirstPrice().revision();
        if (generation !== this.firstPrices) { this.facts.clear(); this.firstPrices = generation; }
        const id = Number(recipe.recipeId);
        let held = this.facts.get(id);
        if (!held) { held = computeFacts(recipe, { board: this.board, timestamp }); this.facts.set(id, held); }
        return held;
    }
    // An item's public sources moved (its board lines, its deals): the facts
    // reading it are computed again at their next read.
    priceMoved(id) {
        for (const recipe of this.catalog.priced.get(Number(id)) || []) this.facts.delete(Number(recipe.recipeId));
    }
    // The market table was replaced: every held fact.
    marketReset() { this.facts.clear(); }
    // A counter's index moved (the market's 'c:' row): the facts reading an
    // item of that counter.
    counterMoved(key) {
        if (!this.counters) {
            this.counters = new Map();
            for (const id of this.catalog.priced.keys()) {
                const counter = MarketCounters().counterOf(id);
                if (!this.counters.has(counter)) this.counters.set(counter, []);
                this.counters.get(counter).push(id);
            }
        }
        for (const id of this.counters.get(key) || []) this.priceMoved(id);
    }
    scopeFor(level) { return `recipe-production:${Math.max(0, Math.min(9, Math.floor(Number(level) || 0)))}`; }
    revision(scope) {
        const match = /^recipe-production:([0-9])$/.exec(String(scope));
        return match ? this.revisions[Number(match[1])] : 0;
    }
    rowsFor(level) {
        if (this.censusStale) { this.censusStale = false; this.recheck(); }
        return this.rows[Math.max(0, Math.min(9, Math.floor(Number(level) || 0)))].values(); }
    refresh(recipe, changed = new Set()) {
        if (!this.accept(recipe)) return changed;
        const available = this.board.list(Number(recipe.productId), 3).length > 0 || this.censusBuyer(recipe);
        for (let level = Number(recipe.level); level <= 9; level++) {
            const rows = this.rows[level];
            if (available === rows.has(recipe)) continue;
            if (available) rows.add(recipe); else rows.delete(recipe);
            changed.add(level);
        }
        return changed;
    }
    update(id) {
        this.priceMoved(id);
        const changed = new Set();
        for (const recipe of this.catalog.reverse.get(Number(id)) || []) this.refresh(recipe, changed);
        return this.moved(changed);
    }
    // censusBuyer's answers moved (the census): every recipe rechecked once.
    recheck() {
        const changed = new Set();
        for (const recipe of this.catalog.rows) this.refresh(recipe, changed);
        return this.moved(changed);
    }
    moved(changed) {
        const scopes = [];
        for (const level of changed) { this.revisions[level]++; scopes.push(this.scopeFor(level)); }
        return scopes;
    }
    reset() {
        this.facts.clear();
        const changed = [];
        for (let level = 1; level <= 9; level++) {
            if (!this.rows[level].size) continue;
            // Snapshot replacement clears public bids, while enabled authored
            // buyers still support the same indexed recipes without board rows.
            const rows = this.rows[level]; rows.clear();
            for (const recipe of this.catalog.rows) if (recipe.level <= level && this.accept(recipe) && this.censusBuyer(recipe)) rows.add(recipe);
            this.revisions[level]++;
            changed.push(this.scopeFor(level));
        }
        return changed;
    }
}
// build false: the index only when one is already built (main's live board's
// by EconomyContext.marketBoard, the worker's by its readers). A build's view of a
// board (EconomyContext watchedBoard: an object whose prototype is the
// board) finds the board's index: one index per board, its facts read
// through the raw board.
function forBoard(board, options, build = true) {
    for (let at = board; at && typeof at === 'object'; at = Object.getPrototypeOf(at)) {
        const index = boards.get(at);
        if (index) return index;
    }
    if (!build || !board) return null;
    const index = new RecipeProductionIndex(board, options);
    boards.set(board, index);
    if (isMainThread) followMainMarket(index);
    return index;
}
// Main's indexes, each until its board goes (a test's board).
const mainIndexes = new Set();
// Main: a board deal moves its item's evidence and its counter's index (the
// rows the worker hears as 'i:' and 'c:'), a market reset every row:
// MarketCounters.subscribeChanges is the one hook of them on main. The
// listener ends with its index (a test's board).
function followMainMarket(index) {
    const held = new WeakRef(index);
    mainIndexes.add(held);
    const stop = MarketCounters().subscribeChanges(change => {
        const index = held.deref();
        if (!index) { stop(); mainIndexes.delete(held); }
        else if (change?.reset) index.marketReset();
        else if (change?.key) index.counterMoved(change.key);
    });
}
// Main's census put moved rows (DemandCensus publication): each main index
// rechecks its rows once at its next read (rowsFor: a hot crafter's build),
// as the worker's does at its table page (ColdSimulationWorker recheck).
// O(recipes) per publication read; nothing on main reads the scopes.
function censusMoved() {
    for (const held of mainIndexes) {
        const index = held.deref();
        if (index) index.censusStale = true; else mainIndexes.delete(held);
    }
}
// The one reader of a recipe's market facts: the board's index holds them;
// a board with no index (a main reader's own board, a test) computes them at the read.
function marketFacts(recipe, { board = null, timestamp = Date.now() } = {}) {
    const index = board ? forBoard(board, undefined, false) : null;
    if (index) return index.marketFacts(recipe, timestamp);
    factStats.reads++;
    return computeFacts(recipe, { board, timestamp });
}
// Does `characterId` own a first ask or bid of a priced item: its centre
// then differs from the shared one.
const ownsFirst = (item, characterId) => characterId > 0 && item.owners.includes(characterId);
// One craft's margin as a reader sees the market: the shared one, unless the
// reader owns a first ask or bid of one of its items; that item is priced
// again without the reader's lines (rare: a crafter's own input bid or
// product ask), so a reader's own line never moves its own facts.
function ownMargin(recipe, facts, { characterId = 0, board = null, timestamp = Date.now() } = {}) {
    const owner = Number(characterId);
    if (!ownsFirst(facts.product, owner) && !facts.inputs.some(item => ownsFirst(item, owner))) return facts.margin;
    const priced = item => ownsFirst(item, owner)
        ? PriceBelief().marketPrice(item.id, { board, timestamp, excludeOwner: owner }) : item.price;
    let inputCost = 0;
    for (const item of facts.inputs) inputCost += item.amount * priced(item);
    return margin(recipe, priced(facts.product), inputCost);
}
// One batch's inputs at a reader's own prices: each input's shared price
// under the reader's own error (PriceBelief.reader fromShared, the price its
// network's input nodes read), O(inputs) with no source read; an input whose
// first line is the reader's own or a recipe scroll is read by its belief.
function inputCostFor(facts, characterId, fromShared) {
    const owner = Number(characterId);
    let cost = 0;
    for (const item of facts.inputs) cost += item.amount * fromShared(item.id, item.price, item.scroll || ownsFirst(item, owner));
    return cost;
}
// A recipe scroll's derived demand: what one craft of its best recipe earns
// over its inputs at market prices (a crafter that learns it crafts at least
// once), null for no scroll or no margin. PriceBelief.demandValue's source
// for scroll ids; the market facts read no scroll's demand, so no loop.
// characterId: the reader's own lines are no source (ownMargin); read: the
// reader's build input hook, every item of the facts joins its reads (a
// held build rebuilds when one moves, as a node's inputs).
function scrollValue(selfId, options = {}) {
    let best = 0;
    for (const recipe of recipeCatalog().reverse.get(Number(selfId)) || []) {
        if (Number(recipe.recipeItemId) !== Number(selfId)) continue;
        const facts = marketFacts(recipe, options);
        if (options.read) for (const id of facts.items) options.read(id);
        const value = ownMargin(recipe, facts, options);
        if (value > best) best = value;
    }
    return best > 0 ? best : null;
}
module.exports = { forBoard, censusMoved, recipeCatalog, marketFacts, margin, ownMargin, inputCostFor, scrollValue, factStats };
