'use strict';

const { SELL } = require('../../AfkTrade/BoardIndex');
const { personalOfferAllowed } = require('../Population/PartyAdmission');
const { fill } = require('./OfferQuery');
const { MAX_INSPECTED, preparedLeaf } = require('./ReadyTradeChoice');
const FixedShots = require('./FixedShotOffers');
const { heldBid } = require('./PriceDecision');
const DemandPrice = invoke('GameServer/Bot/Economy/DemandPrice');

// A quote is an outside option only for a whole, affordable purchase over a
// known route. Reserved shop stock is public authority. A conditional ad
// (meeting-only, custody 1) needs the buyer's already prepared executable
// purchase to be an outside purchase (`ceiling`); an advertised count alone
// cannot promise another owner's stock or consent.
// Apart, the least unit price whose whole bid funds the lot its shops ask in
// the meeting town itself (`own`, no NPC units, no meeting-only ad: a bid
// does not yield to a meeting, supply-driven market 10-27, T76): a bid at or
// over it stands crossed. The lot is filled the way the wish buy fills it
// (OfferQuery.fill in board order, as the quote: WishPurchaseEvidence
// sizedQuote). The meeting town's lines (and the unplaced ones) are read in
// order until a fill holds the lot; other towns within the first
// MAX_INSPECTED lines of the item.
const NONE = Object.freeze({ ceiling: Infinity, own: Infinity });
function outside(selfId, ctx, { units = 1, town, money, enchant = 0 } = {}) {
    if (!Number.isSafeInteger(units) || units < 1 || !(money >= 0)
        || typeof ctx.travelDetails !== 'function' || !Number.isFinite(ctx.hour) || ctx.hour < 0) return NONE;
    const routeFor = where => {
        const route = ctx.travelDetails(where);
        return route?.known && [route.hours, route.fees].every(n => Number.isFinite(n) && n >= 0) ? route : null;
    };
    const meeting = routeFor(town);
    if (!meeting) return NONE;
    if (meeting.fees > money) return { ceiling: 0, own: Infinity };
    const groups = new Map();
    const group = where => {
        if (!where) return null;
        if (!groups.has(where)) groups.set(where, { lines: [], npcPrice: 0 });
        return groups.get(where);
    };
    const planned = ctx.economy?.network?.activity;
    const backed = line => line.custodyPolicy !== 1 || preparedLeaf(line, planned, units, selfId);
    const usable = line => line.ownerId !== ctx.characterId && Number(line.enchant || 0) === enchant
        && Number.isSafeInteger(line.price) && line.price > 0
        && Number.isSafeInteger(line.count) && line.count > 0 && line.available !== false
        && line.executable !== false && personalOfferAllowed(line, ctx.state);
    const lines = ctx.board?.list(selfId, SELL) || [];
    for (let at = 0; at < lines.length && at < MAX_INSPECTED; at++) {
        const line = lines[at];
        if (line.town && line.town !== town && usable(line) && backed(line)) group(line.town).lines.push(line);
    }
    group(town);
    // The meeting town's lines, read lazily: each fill stops once it holds the lot.
    function* here() {
        for (const line of ctx.board?.lines?.(selfId, SELL, town) || []) if (usable(line)) yield line;
    }
    if (!enchant) for (const offer of FixedShots.npcOffers(selfId, ctx.purchaseNpcOffersFor || ctx.npcOffersFor)) {
        if (offer.sourceType !== 'npc' || offer.available === false || offer.executable === false || !(offer.price > 0)
            || !Number.isSafeInteger(offer.price) || offer.count < units || offer.availableUnits < units) continue;
        const entry = group(offer.town);
        if (entry) entry.npcPrice = entry.npcPrice ? Math.min(entry.npcPrice, offer.price) : offer.price;
    }
    let ceiling = Infinity, own = Infinity;
    for (const [where, entry] of groups) {
        const route = routeFor(where);
        if (!route || route.fees > money) continue;
        const terms = { npcPrice: entry.npcPrice, money: money - route.fees, ordered: true };
        if (where === town) {
            const lot = fill(here(), units, { ...terms, accept: line => line.custodyPolicy !== 1 });
            if (lot.units === units && !lot.npc) own = Math.ceil(lot.cost / units);
        }
        const purchase = fill(where === town ? here() : entry.lines, units, { ...terms, accept: backed });
        if (purchase.units !== units) continue;
        // Subtract routes before monetising: identical trips cancel exactly,
        // without a spurious one-Adena discount from floating-point totals.
        const extraTrip = route.fees - meeting.fees + (route.hours - meeting.hours) * ctx.hour;
        const unit = Math.max(0, Math.floor((purchase.cost + extraTrip) / units));
        ceiling = Math.min(ceiling, unit);
    }
    return { ceiling, own };
}
// A bid's ceiling. 0 (withdraw) only for a standing bid whose unit `price`
// is at or over the whole lot its own town's shops ask (outside's `own`); a
// new bid (no `price`) is never withdrawn here. Else the least whole
// purchase, kept under that ask so a reprice never lands on it. The wish's
// source choice (TradeIntent,
// canTradeRemotely) is another question. A partial cross (the town asks
// fewer units than the bid): when that buy is the bot's chosen step, it buys
// the units on sale and its bid holds only the rest (TradeIntent
// .preparedProject), so this whole-lot rule judges that rest (partialcross
// 2026-10-25).
// A recipe scroll's bid also stays at or under the recipe's shared worth to
// its learner (DemandPrice.recipeWorth, decisions 10-28): a new bid, a
// standing line's look and reprice and the worker's line limits read it here.
function cap(selfId, ctx, { price, ...terms }) {
    const { ceiling, own } = outside(selfId, ctx, terms);
    const limit = !Number.isFinite(own) ? ceiling : price >= own ? 0 : Math.min(ceiling, own - 1);
    const worth = DemandPrice.recipeWorth(selfId, ctx.characterId);
    if (worth === null || !(worth < limit)) return limit;
    DemandPrice.stats.capped++;
    return worth;
}

const moneyForLine = (line, ctx) => ctx.adena + (line.custodyPolicy === 1 ? 0 : line.price * line.count);
function cashCap(line, ctx) {
    const route = ctx.travelDetails?.(line.town);
    const fees = route?.known && Number.isFinite(route.fees) ? Math.max(0, route.fees) : 0;
    return Math.max(0, Math.floor((moneyForLine(line, ctx) - fees) / Math.max(1, line.count)));
}
const lineTerms = (line, ctx) => ({ units: line.count, town: line.town, enchant: Number(line.enchant || 0),
    money: moneyForLine(line, ctx), price: line.price });
function forLine(line, ctx) {
    return cap(line.selfId, ctx, lineTerms(line, ctx));
}
// An own standing bid now (PriceDecision.heldBid under the outside purchase
// and the cash): null = it stands, 0 = withdraw, else the lower price. A
// caller that already holds the line's outside purchase cap passes it.
function lineLimit(line, ctx, cap = forLine(line, ctx)) {
    return heldBid(line.selfId, line.price, Math.min(cap, cashCap(line, ctx)));
}

// Recheck consent over the complete agreed quantity, including physical
// stacks split by the native meeting. Use fresh own cash/routes/sources;
// neither an old WTB price nor a high wish value authorizes overpayment.
// A buy from a sell ad only: an own buy-ad fill keeps the bid its owner
// published (its certificate), repriced at the owner's own look.
function assertMeetingPurchase(lines, payer, town, ctx, money = ctx.adena) {
    const purchases = new Map();
    for (const line of lines) if (line.payer === payer) {
        const key = `${line.selfId}:${line.enchant || 0}`;
        let purchase = purchases.get(key);
        if (!purchase) purchases.set(key, purchase = { selfId: line.selfId, enchant: line.enchant || 0, units: 0, cost: 0 });
        purchase.units += line.count; purchase.cost += line.count * line.price;
    }
    if (!purchases.size) return;
    const route = ctx.travelDetails?.(town);
    if (!route?.known || ![route.hours, route.fees, ctx.hour].every(n => Number.isFinite(n) && n >= 0))
        throw Error('trade_meeting_route');
    const total = [...purchases.values()].reduce((sum, purchase) => sum + purchase.cost, 0);
    for (const purchase of purchases.values()) {
        // An agreed meeting buy is bounded by the price, not withdrawn.
        const { ceiling } = outside(purchase.selfId, ctx, { ...purchase, town,
            money: Math.max(0, money - (total - purchase.cost)) });
        if (purchase.cost > ceiling * purchase.units) throw Error('trade_meeting_purchase_price_changed');
    }
}
module.exports = { cap, forLine, cashCap, lineLimit, assertMeetingPurchase };
