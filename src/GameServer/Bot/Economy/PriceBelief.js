// A fresh price estimate from the indexed board, with a stable personal
// error for (bot, item). There is no saved per-item price book: observations
// belong to the author's open board line, and own experience to a counter.
const TendencyRoll = require('../AI/TendencyRoll');
const { SELL, BUY } = require('../../AfkTrade/BoardIndex');
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
const PriceLearning = invoke('GameServer/Bot/Economy/PriceLearning');
const BotPersona = require('../AI/BotPersona');
const Diagnostics = require('./EconomyDiagnostics');
// One scalar mixture per item: no owner, state, wallet or offer references.
const MIXTURE_LIMIT = 1024;
const mixtures = new Map();
const MarketDemand = invoke('GameServer/Bot/Economy/MarketDemand');

const S0 = 0.6;
const K_MAX = 60;
const PASSED_MAX = 10;
const DEALS_WEIGHT_MAX = 10;
const errorOf = PriceLearning.errorOf;

function sigma(belief) {
    return S0 / Math.sqrt(1 + belief.K);
}

// The index alone: the counter's buyers per hour and clock are not read here.
function counterIndex(selfId) {
    return MarketCounters.indexOf(MarketCounters.counterOf(selfId));
}

// The one scalar mixture of an item's public sources (deals, the first ask,
// the first bid but for wished gear, the first price on the counter's index,
// the first price), kept per item while every source equals the kept one. A
// recipe scroll mixes no derived worth: its shared worth
// (DemandPrice.recipeWorth) only caps a learner's bid (decisions 10-28).
// excludeOwner: the reader's own lines are no source of its belief.
function mixtureOf(id, { board, timestamp, excludeOwner = undefined }) {
    const deals = MarketCounters.itemPriceEvidence(id);
    // Always re-read permitted sources and the owner's excluded offers. Only
    // their pure numeric combination is reusable, never a spending decision.
    const ask = board?.first(id, SELL, { excludeOwner, enchant: 0 });
    // A wished piece's bid is its buyer's tool (T84, decisions 10-27 and
    // 10-28): one bot's bid is never every bot's price.
    const bid = board && !MarketDemand.forecastOnly(id) ? board.first(id, BUY, { excludeOwner, enchant: 0 }) : null;
    const first = MarketCounters.firstPrice(id, timestamp);
    const index = counterIndex(id);
    const inputs = [deals.logMedian, Math.min(DEALS_WEIGHT_MAX, deals.deals),
        ask?.price > 0 ? Number(ask.price) : 0, bid?.price > 0 ? Number(bid.price) : 0,
        first, index];
    let mixture = mixtures.get(id);
    if (!mixture || !inputs.every((value, at) => Object.is(value, mixture.inputs[at]))) {
        const observations = [];
        if (deals.logMedian !== null) observations.push([deals.logMedian, inputs[1]]);
        if (inputs[2] > 0) observations.push([Math.log(inputs[2]), 1]);
        if (inputs[3] > 0) observations.push([Math.log(inputs[3]), 1]);
        if (first > 0 && index !== null) observations.push([Math.log(first) + index, 0.5]);
        if (first > 0) observations.push([Math.log(first), 0.3]);
        let weight = 0, sum = 0;
        for (const [value, w] of observations) { weight += w; sum += value * w; }
        mixture = { inputs, mu: sum / weight, K: weight, known: observations.length > 0 };
        mixtures.delete(id); mixtures.set(id, mixture);
        if (mixtures.size > MIXTURE_LIMIT) mixtures.delete(mixtures.keys().next().value);
        if (Diagnostics.active()) Diagnostics.count('price_mixture', 'build', 'sources_changed');
    } else {
        mixtures.delete(id); mixtures.set(id, mixture);
        if (Diagnostics.active()) Diagnostics.count('price_mixture', 'hit', 'same_sources');
    }
    return mixture;
}

// The market's shared price of an item: the centre of its public sources,
// no personal error, 0 when nothing is known. The
// recipe market facts (RecipeProductionIndex marketFacts) price products and
// inputs by it, once per market change.
function marketPrice(selfId, { board = null, timestamp = Date.now() } = {}) {
    const mixture = mixtureOf(Number(selfId), { board, timestamp });
    return mixture.known ? Math.exp(mixture.mu) : 0;
}

// The one "is it traded" question: the item has deal evidence. An item
// known only by asks, bids or its first price has no market price a seller
// can count on (reader soldPrice).
function traded(selfId) {
    return MarketCounters.itemPriceEvidence(Number(selfId)).logMedian !== null;
}

// The reader's own error on an item's centre: a signed fraction from its
// understanding and its trades of the item's counter, 0 with knowledge off.
function biasOf(id, ctx) {
    const counter = MarketCounters.counterOf(id);
    const enabled = ctx.knowledgeEnabled ?? PriceLearning.knowledgeEnabled();
    const experience = Math.max(0, Number(ctx.marketTrades?.[counter]) || 0);
    return enabled
        ? (2 * TendencyRoll.roll('n45e', ctx.characterId, id) - 1) * errorOf(ctx.understanding, experience, counter)
        : 0;
}

// Public source weights stay unchanged; every choice reads them again.
// bias is a signed fractional error, so the log centre gains log(1 + bias).
function prior(selfId, ctx) {
    const id = Number(selfId);
    const mixture = mixtureOf(id, { board: ctx.board, timestamp: ctx.timestamp, excludeOwner: ctx.characterId });
    if (!mixture.known) return null;
    const bias = biasOf(id, ctx);
    return { selfId: id, mu: mixture.mu + Math.log1p(bias), K: mixture.K, bias };
}

// The bot's one price reader for a build (Knowledge and error brick): each
// item's belief is resolved once per (build, item) through the bot's own
// error, its price is exp(mu), 0 when nothing is known. Every value of an
// item the bot holds or wants (wish ownValue, crafter inputs, shot stock)
// reads it; a crafter's admission reads its inputs from the shared recipe
// facts through fromShared, the same price. seed: a held build's own prices
// (its plan.prices); read(id): the build's input hook, so a late read still
// joins the build's inputs.
// soldPrice(id): the item has a market price (the one question "is it
// traded"): its price when deals were made (the deal evidence prior mixes),
// 0 when only asks, bids or its first price know it. The input cap of a
// transformation (WishNetwork solve inputCap, ShotCraftPolicy own use)
// judges by it; an untraded intermediate is no replacement the bot can buy.
function reader({ state, persona = null, board = null, timestamp = Date.now(), knowledgeEnabled, read = () => {} },
    prices = new Map()) {
    const ctx = { characterId: state.characterId,
        understanding: (persona || BotPersona.of(state))?.understanding ?? 0.3,
        marketTrades: state.marketTrades, knowledgeEnabled, board, timestamp, read };
    const beliefs = new Map();
    const beliefFor = id => {
        if (!beliefs.has(Number(id))) beliefs.set(Number(id), prior(id, ctx) || null);
        return beliefs.get(Number(id));
    };
    const price = id => {
        read(id);
        if (!prices.has(Number(id))) {
            const belief = beliefFor(id);
            prices.set(Number(id), belief ? Math.exp(belief.mu) : 0);
        }
        return prices.get(Number(id));
    };
    // price(id) from the item's shared price (PriceBelief.marketPrice, held
    // in a recipe's market facts) with no source read: the shared centre
    // under the bot's own error (biasOf). own: the bot's centre differs (its
    // own first ask or bid): price(id) reads it.
    const fromShared = (id, shared, own = false) => {
        id = Number(id);
        if (own || prices.has(id)) return price(id);
        read(id);
        const value = shared > 0 ? shared * (1 + biasOf(id, ctx)) : 0;
        prices.set(id, value);
        return value;
    };
    // price first: its read joins the item to the build's inputs either way.
    const soldPrice = id => {
        const value = price(id);
        return traded(id) ? value : 0;
    };
    return { prices, beliefs, beliefFor, price, fromShared, soldPrice };
}

// Current line observations add weight to the fresh estimate, never to a
// persistent centre. Closing the line discards all its observation state.
function learn(belief, observations) {
    let weight = 0;
    let sum = 0;
    for (const [value, w] of observations) {
        if (!(w > 0) || !Number.isFinite(value)) continue;
        weight += w;
        sum += value * w;
    }
    if (!(weight > 0)) return false;
    belief.mu = (belief.K * belief.mu + sum) / (belief.K + weight);
    belief.K = Math.min(K_MAX, belief.K + weight);
    return true;
}

// Exact own fills belong to this line, not the bounded item-deal tail.
// Other item deals and the current rival already enter the fresh prior.
// Every other deal of its counter passed this line; competing listings do
// not divide that evidence. A gear bid is never passed (supply-driven
// market, docs/game-decisions.md 10-27, T76): its buyer may wait at its
// price, the bid does not climb while unfilled (MarketDemand.forecastOnly).
function lineObservations(line, belief, ctx) {
    const previous = line.pricing;
    const counter = MarketCounters.counter(MarketCounters.counterOf(line.selfId), ctx.timestamp);
    const fills = Math.max(0, Number(line.fills || 0) - Number(previous.seenFills || 0));
    // A line nobody took, seen on a town look, passed once even with no deal
    // on the board, like a deal that went to someone else.
    const unanswered = ctx.visit && fills === 0 ? 1 : 0;
    const passed = line.storeType === BUY && MarketDemand.forecastOnly(line.selfId) ? 0
        : Math.min(PASSED_MAX, Math.max(unanswered, counter.deals - previous.seenCounter - fills));
    const price = Number(previous.price);
    const observations = [];
    if (price > 0) {
        const direction = line.storeType === BUY ? -1 : 1;
        const width = sigma(belief);
        if (fills > 0) observations.push([Math.log(price) + direction * 0.5 * width, fills]);
        if (passed > 0) observations.push([Math.log(price) - direction * 0.5 * width, passed]);
    }
    return observations;
}

module.exports = { S0, K_MAX, sigma, errorOf, prior, marketPrice, traded, reader, learn, lineObservations };
