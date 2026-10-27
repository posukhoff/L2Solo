// One pricing decision for selling and buying (group E, user 2026-10-05;
// market-sim step 3.3, tools/market-sim/n0/step33/groupE: e10 belief, e12
// loss, e13 competition): the best expected outcome over a grid of prices on
// the bot's belief (PriceBelief), one roll among the near-best ones. One
// module for the main thread and the cold worker.
//
// Selling at p uses a declared finite demand segment. The belief gives its
// willingness at p; finite cheaper stock is deducted once before clipping
// the physical owned stock. The NPC alternative retains perception width.
// Receipts are discounted by the segment's known delay; unsold goods retain
// their physical exit value. Missing demand evidence stays unknown. Traits
// are parameters only: assertiveness is the
// optimism of the centre, caution the loss aversion against the bot's own
// value (a sale below it is a loss weighted 1 + caution; waiting is no loss,
// only a delay), commitment the patience on the discount. Buying mirrors it.
const TendencyRoll = require('../AI/TendencyRoll');
const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const { SELL, BUY } = require('../../AfkTrade/BoardIndex');
const DataCache = invoke('GameServer/DataCache');
const NpcSellRules = invoke('GameServer/Items/NpcSellRules');
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
const PriceBelief = invoke('GameServer/Bot/Economy/PriceBelief');
const CommittedExits = require('./CommittedExits');

// 19 prices from 2 widths under the centre to 2.5 over it.
const GRID = Object.freeze(Array.from({ length: 19 }, (_, at) => -2 + at * 0.25));
const NEAR_BEST = 0.02;
// How differently buyers see the same offers (e13: their understanding error).
const PERCEPTION = 0.08;
const RIVALS_SEEN = 20;
// Waiting costs the gap's urgency spread over that wish's own horizon (1/hour).
// 76797 adena/hour * 3.235e-5 hours/adena / 59.1 hours = .042/hour.
function waitRate({ hourAdena, moneyPrice, gapHorizonHours } = {}) {
    return gapHorizonHours > 0 ? Math.max(0, Number(hourAdena) || 0)
        * Math.max(0, Number(moneyPrice) || 0) / gapHorizonHours : 0;
}
function traderOf(persona, economy) {
    const traits = persona?.traits || {};
    return { wait: waitRate(economy) * (1.5 - Number(traits.commitment ?? 0.5)),
        assertiveness: Number(traits.assertiveness ?? 0.5), caution: Number(traits.caution ?? 0.5),
        understanding: Number(persona?.understanding ?? 0.3) };
}

// Standard normal distribution function (Abramowitz and Stegun 7.1.26).
function phi(z) {
    const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
    const tail = (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592)
        * t * Math.exp(-z * z / 2);
    return z >= 0 ? 1 - tail / 2 : tail / 2;
}

// A sale below the bot's own value is a loss weighted 1 + caution.
function saleUtility(price, reference, caution) {
    return price >= reference ? price : reference + (1 + caution) * (price - reference);
}
// A purchase above it is a loss the same way.
function purchaseCost(price, reference, caution) {
    return price <= reference ? price : reference + (1 + caution) * (price - reference);
}

function buyback(selfId) {
    const item = ItemTemplateIndex.find(DataCache.items, Number(selfId));
    return NpcSellRules.npcBuyPrice(Number(item?.template?.price || 0));
}

// The one NPC floor of the board: an ask or a bid counts only above the
// item's NPC buy-back (at or below it the NPC pays as much, so no ask goes
// there and a bid there never fills). `floor`: the buy-back; none bounds nothing.
function aboveBuyback(price, floor) {
    return Number(price) > (Number(floor) || 0);
}

// What a held bid becomes under a ceiling (an outside purchase, the cash):
// null = it stands, 0 = withdraw, else the lower price. A bid that cannot
// fill (aboveBuyback) is withdrawn; a ceiling never lowers it to the buy-back.
function heldBid(selfId, price, ceiling) {
    const floor = buyback(selfId);
    if (!aboveBuyback(price, floor)) return 0;
    const limit = Math.floor(ceiling);
    if (!Number.isSafeInteger(limit) || limit < 0 || limit >= price) return null;
    return aboveBuyback(limit, floor) ? limit : 0;
}

function saleOutcome({ units, applicableUnits, willingUnits, cheaperUnits, price,
    residualUnitValue = 0, delayHours = 0, discountRate = 0 } = {}) {
    if (!Number.isSafeInteger(units) || units < 0 || !Number.isSafeInteger(cheaperUnits) || cheaperUnits < 0
        || ![applicableUnits, willingUnits, price, residualUnitValue, delayHours, discountRate]
            .every(value => Number.isFinite(value) && value >= 0)) {
        return { known: false, sold: NaN, residual: NaN, receipts: NaN, residualValue: NaN };
    }
    const demand = Math.max(0, Math.min(applicableUnits, willingUnits) - cheaperUnits);
    const sold = Math.min(units, demand), residual = units - sold;
    const receipts = sold * price * Math.exp(-discountRate * delayHours);
    const residualValue = residual * residualUnitValue;
    return Number.isFinite(receipts) && Number.isFinite(residualValue)
        ? { known: true, sold, residual, receipts, residualValue }
        : { known: false, sold: NaN, residual: NaN, receipts: NaN, residualValue: NaN };
}

// The finite willingness of an ask's buyers (a bid states its own count: prospectiveExit).
function willingUnitsAt(belief, trader, { price, applicableUnits, landed = price, npcLanded = Infinity }) {
    const width = PriceBelief.sigma(belief);
    const centre = belief.mu + (trader.assertiveness - 0.5) * width;
    const wants = 1 - phi((Math.log(price) - centre) / width);
    const chosen = Number.isFinite(npcLanded) ? 1 - phi(Math.log(landed / npcLanded) / PERCEPTION) : 1;
    return applicableUnits * wants * chosen;
}

// An unbacked bid is interest, not money: sell into it only if that sells
// more than what is already held. Re-read its exact native record
// so a withdrawn or edited bid cannot support a stale exit. The line states
// its price and count, so it takes its count at its price (G2, user
// 2026-10-23): the seller's own belief of the item does not discount it.
// The one owner of how many units a buyer's bid takes from a seller.
function prospectiveExit(state, exit, { board, timestamp = Date.now() } = {}) {
    const unsupported = () => {
        const rest = { ...exit };
        delete rest.prospective;
        return rest;
    };
    const offer = exit?.offer;
    const ownerId = Number(offer?.ownerId ?? offer?.sourceId);
    const id = Number(offer?.selfId);
    const revision = offer?.revision ?? offer?.expectedRevision;
    if (!(exit?.conditional || offer?.conditional || offer?.custodyPolicy === 1)
        || !board?.records || !Number.isSafeInteger(id) || id <= 0
        || !Number.isSafeInteger(ownerId) || ownerId <= 0 || ownerId === Number(state?.characterId)
        || Number(offer?.enchant || 0) || !Number.isSafeInteger(Number(offer?.count)) || Number(offer.count) <= 0
        || !(Number(offer?.price) > 0) || !Number.isFinite(Number(offer.price))
        || Number(exit.price) !== Number(offer.price) || Number(exit.count) !== Number(offer.count)) return unsupported();
    const line = board.records.get(Number(offer.recordId))?.find(row => Number(row.lineId) === Number(offer.lineId));
    if (!line || line.storeType !== BUY || line.custodyPolicy !== 1 || line.ownerId !== ownerId
        || line.selfId !== id || Number(line.enchant || 0) || line.price !== Number(offer.price)
        || line.count !== Number(offer.count) || line.revision !== revision) return unsupported();
    return { ...exit, trial: true, residualUnitValue: buyback(id), prospective: {
        known: true, origin: 'public_bid', authority: { recordId: line.recordId, lineId: line.lineId, revision: line.revision },
        applicableUnits: line.count, willingUnits: line.count, observedAt: timestamp } };
}

// The asks of one board list a trader inspects.
const QUOTE_DEPTH = 5;

// The one owner of "the first ask not inspected bounds the rest of the
// book": the asks are sorted by price (BoardIndex SELL ascending), so every
// ask from index `inspected` on costs at least this; Infinity when none is left.
function uninspectedFrom(asks, inspected) {
    return inspected < asks.length ? Number(asks[inspected].price) : Infinity;
}

// The cheaper competition a seller meets at a bid price: of the first
// QUOTE_DEPTH asks of the whole board list (the seller's own included, as
// every trader sees it), those foreign, of the same enchant and below it.
// `tail`: the sixth ask is cheaper too, so the competition behind the
// inspected ones is unknown. Board lines carry ownerId, quotes sourceId.
function cheaperAsks(asks, { ownerId, price, enchant = 0 }) {
    let cheaperUnits = 0;
    for (let at = 0; at < asks.length && at < QUOTE_DEPTH; at++) {
        const line = asks[at];
        if (Number(line.ownerId ?? line.sourceId) !== Number(ownerId) && Number(line.enchant || 0) === Number(enchant)
            && line.price < price) cheaperUnits += Number(line.count);
    }
    return { cheaperUnits, tail: uninspectedFrom(asks, QUOTE_DEPTH) < price };
}

// The competition of one exit of `count` units, one reader for the planner,
// its recheck and bidSale: `limit` when the uninspected cheaper tail may
// cover the bid, so its demand is unknown.
function exitCompetition(asks, { ownerId, price, enchant = 0, count }) {
    const { cheaperUnits, tail } = cheaperAsks(asks, { ownerId, price, enchant });
    return { cheaperUnits, limit: tail && cheaperUnits < count };
}

// One finite sale of `units` more goods into one bid (MVP-5). A bid buys
// its count at its price (prospectiveExit for a conditional one). Cheaper
// foreign asks serve the buyer first and the seller's own unsold goods
// (`oldUnits`) are counted once, so `gross` is only the gain of the new
// units. `producer` (the id of a bot sizing goods it would make or farm,
// never a holder selling goods in hand): the units its rivals' plans in
// flight already commit to the line (CommittedExits) are theirs, its demand
// is what they leave. `limit`: an uninspected cheaper tail may cover the bid.
// `floor`: a bid at or under the item's NPC buy-back is no buyer, the
// seller's NPC exit beats it (aboveBuyback, user 10-27); the units past a
// buyer's demand still count at `residualUnitValue`.
function bidSale(state, offer, { board, timestamp = Date.now(), asks = [], oldUnits = 0, units,
    residualUnitValue, producer = 0 } = {}) {
    if (!aboveBuyback(offer.price, buyback(offer.selfId))) return { status: 'floor' };
    let exit = { conditional: offer.custodyPolicy === 1, price: offer.price, count: offer.count, offer };
    exit = prospectiveExit(state, exit, { board, timestamp });
    let forecast = exit.prospective
        || (!exit.conditional ? { known: true, applicableUnits: offer.count, willingUnits: offer.count } : null);
    if (!forecast?.known) return { status: 'unknown', exit };
    const rivals = producer > 0 ? CommittedExits.rivalLineUnits(offer.recordId, offer.lineId, producer) : 0;
    if (rivals > 0) {
        const open = Math.max(0, forecast.applicableUnits - rivals);
        if (!open && forecast.applicableUnits > 0) CommittedExits.refused();
        forecast = { ...forecast, applicableUnits: open, willingUnits: Math.min(forecast.willingUnits, open) };
    }
    const { cheaperUnits, limit } = exitCompetition(asks, { ownerId: state?.characterId, price: offer.price, enchant: Number(offer.enchant || 0),
            count: forecast.applicableUnits });
    if (limit) return { status: 'limit', exit, forecast, cheaperUnits };
    const input = { applicableUnits: forecast.applicableUnits, willingUnits: forecast.willingUnits, cheaperUnits, price: offer.price,
        residualUnitValue: Number(residualUnitValue ?? exit.residualUnitValue ?? 0) };
    const before = saleOutcome({ ...input, units: oldUnits });
    const after = saleOutcome({ ...input, units: oldUnits + units });
    if (!before.known || !after.known) return { status: 'unknown', exit, forecast, cheaperUnits };
    return { status: 'ready', exit, forecast, cheaperUnits, before, after,
        gross: after.receipts + after.residualValue - before.receipts - before.residualValue };
}

// The one owner of "how many lots a buyer's line takes from me" (decision
// (b), 2026-10-24: an unbacked bid is a real buyer sized at what it takes).
// Units: the line's demand past the cheaper foreign asks (saleOutcome) less
// the seller's `oldUnits` held, incoming or listed, which bidSale sells into
// it first; offering the whole count reads that as after.sold - before.sold.
// Lots: those units plus the `reserve` a batch fills first for the seller's
// own stock (ShotSalePolicy.exit counts it the same) in whole lots of
// `perLot`, at least one, at most `cap`; 0 when the line takes nothing from
// this seller or its demand is unknown. `producer` as bidSale's.
function bidLots(state, offer, { board, timestamp = Date.now(), asks = [], oldUnits = 0, reserve = 0, perLot = 1,
    cap = Infinity, producer = 0 } = {}) {
    const sale = bidSale(state, offer, { board, timestamp, asks, oldUnits, units: Number(offer?.count), producer });
    const units = sale.status === 'ready' ? sale.after.sold - sale.before.sold : 0;
    return units > 0 && perLot > 0 ? Math.max(1, Math.min(cap, Math.floor((units + reserve) / perLot))) : 0;
}

// The one owner of "units of an item the seller already has to sell": the
// `oldUnits` bidSale and bidLots sell into first and ShotSalePolicy's
// `existing`. The free units the caller's context counts (its reservations),
// the accepted incoming and the units on its own plain sell lines
// (plainSale) of that item.
function heldUnits(free, incoming, ownSales = []) {
    let units = Number(free || 0) + Number(incoming || 0);
    for (const line of ownSales) units += Number(line.count);
    return units;
}
// A seller's own sell line whose units count as held for sale: on sale now
// (not a conditional custody-1 line) and of enchant 0, as the exits are.
const plainSale = line => line.storeType === SELL && line.custodyPolicy !== 1 && !Number(line.enchant || 0);

// What the seller of `units` of an item in `town` competes with: { buyback,
// buyersPerHour, lot, rivals [{ landed, units }], npcLanded, ownTrip }.
// tripCost(town): a buyer's trip there in Adena (OfferOrder.tripCost of the
// trader); npcOffers: the NPC shops selling the item ({ price, town }).
function marketFor(selfId, { board = null, ownerId = 0, town = null, units = 1, tripCost = null,
    npcOffers = [], timestamp = Date.now(), enchant = 0, demand = null, ownUnits = null,
    jointKnown = true } = {}) {
    const id = Number(selfId);
    const bounded = cost => Math.min(Number(cost) || 0, Number.MAX_SAFE_INTEGER);
    const trip = (where) => (tripCost ? bounded(tripCost(where)) : 0);
    const rivals = [];
    // Bound attention as well as retained rivals: 2 * RIVALS_SEEN asks
    // inspected, RIVALS_SEEN foreign ones of the enchant retained. Every ask
    // past them costs at least the first one not inspected or not retained
    // (uninspectedFrom) and lands at least the cheapest trip to any town over
    // that (EconomicTrip least): `seenTo`, the landed price up to which the
    // competition is known; above it unknown, never invented free liquidity
    // (PriceDecision.chooseAsk).
    const source = board ? board.list(id, SELL) : [];
    let inspected = 0;
    for (; inspected < source.length && inspected < 2 * RIVALS_SEEN; inspected++) {
        const line = source[inspected];
        if (line.ownerId === Number(ownerId) || Number(line.enchant || 0) !== Number(enchant)) continue;
        if (rivals.length === RIVALS_SEEN) break;
        rivals.push({ landed: line.price + trip(line.town), units: line.count,
            origin: 'public_ask', authority: { recordId: line.recordId, lineId: line.lineId, revision: line.revision },
            selfId: id, enchant: Number(enchant), observedAt: timestamp, scope: 'board',
            availability: { from: timestamp, until: timestamp } });
    }
    const unseen = uninspectedFrom(source, inspected);
    // A trip reader without a town table (a plain cost) bounds nothing: 0.
    const seenTo = unseen < Infinity ? unseen + (tripCost?.least ? bounded(tripCost.least()) : 0) : Infinity;
    let npcLanded = Infinity;
    for (const offer of enchant > 0 ? [] : npcOffers || []) {
        if (offer?.price > 0) npcLanded = Math.min(npcLanded, Number(offer.price) + trip(offer.town));
    }
    // ARCH-NOTE: the delivered counter tracks kind-level deals, not permitted
    // item arrivals/exposure/lifetime. Dividing by listing count manufactured
    // demand and made split own listings create buyers. No supported producer
    // supplies them from category counters; only explicit item evidence can
    // make the external tail known.
    const supported = Boolean(jointKnown && demand && demand.known !== false && demand.origin && demand.authority
        && Number(demand.selfId ?? id) === id && Number(demand.enchant ?? enchant) === Number(enchant)
        && Number.isFinite(demand.applicableUnits) && demand.applicableUnits >= 0
        && Number.isFinite(demand.availability?.from) && Number.isFinite(demand.availability?.until)
        && demand.availability.from <= timestamp && demand.availability.until >= timestamp);
    return {
        buyback: buyback(id),
        known: supported,
        applicableUnits: supported ? demand.applicableUnits : NaN,
        delayHours: supported ? Number(demand.delayHours ?? 0) : NaN,
        buyersPerHour: supported && Number.isFinite(demand.arrivalsPerHour) ? demand.arrivalsPerHour : NaN,
        lot: Math.max(1, MarketCounters.itemDeals(id).units || 1),
        units: Math.max(1, Number(ownUnits ?? units) || 1),
        rivals,
        npcLanded,
        ownTrip: trip(town),
        sourceRevision: board?.itemRevision(id) ?? null,
        demand: supported ? demand : null,
        truncated: seenTo < Infinity,
        seenTo
    };
}

// The near-best roll: options within 2% of the best value share one roll by
// how far above that line they are.
function nearBest(candidates, rollKey) {
    let best = -Infinity;
    for (const candidate of candidates) best = Math.max(best, candidate.value);
    const floor = best - NEAR_BEST * Math.abs(best);
    const near = candidates.filter((candidate) => candidate.value >= floor);
    let total = 0;
    for (const candidate of near) total += candidate.value - floor + 1e-9;
    let left = TendencyRoll.roll(...rollKey) * total;
    for (const candidate of near) {
        left -= candidate.value - floor + 1e-9;
        if (left <= 0) return candidate;
    }
    return near[near.length - 1];
}

// The ask: { price, value, money, npc, known }, and with it the one
// board-or-NPC answer of a sale (user rule R2, 2026-10-24): npc true when no
// ask pays more than the NPC buy-back now (price is then the buy-back).
// money: the Adena a unit brings (the chance to sell from the demand
// evidence, unsold units at the buy-back, receipts discounted by the bot's
// wait over the demand's delay); value: the bot's utility per unit (traits).
// Known demand: among the grid asks that pay more than the NPC, one roll
// among the near-best by utility; `current` (the line's ask now) stands while
// it is still among them (the roll is for a new ask, not a jitter). Unknown
// demand (known false, value and money NaN: no receipts are invented): the
// standing ask over the buy-back, else for a whole book the belief's centre
// exp(mu) over the buy-back (one ask rule for a listing and its review),
// else NPC. A book cut short before any seen price has no ask at or below
// the cheapest unseen one (seenTo): the standing ask, else NPC.
function chooseAsk(belief, market, trader, rollKey, current = 0) {
    const width = PriceBelief.sigma(belief);
    const reference = Math.exp(belief.mu);
    const known = market.known !== false && Number.isFinite(market.applicableUnits)
        && Number.isSafeInteger(market.units) && market.units >= 0 && Number.isFinite(market.delayHours)
        && market.delayHours >= 0;
    const npcValue = saleUtility(market.buyback, reference, trader.caution);
    const npc = (evidence) => ({ price: market.buyback, value: npcValue, money: market.buyback, npc: true, npcValue,
        known: evidence });
    const unknown = () => {
        const price = aboveBuyback(current, market.buyback) ? current
            : market.truncated ? 0 : Math.round(reference);
        return Number.isSafeInteger(price) && aboveBuyback(price, market.buyback)
            ? { price, value: NaN, money: NaN, npc: false, npcValue, known: false } : npc(false);
    };
    if (!known) return unknown();
    // A truncated book: only an ask landing at or below the cheapest landing
    // of an unseen ask has a known competition (PriceDecision.marketFor seenTo).
    const seen = (price) => price + market.ownTrip <= (market.seenTo ?? Infinity);
    const valueAt = (price) => {
        const landed = price + market.ownTrip;
        let ahead = 0;
        for (const rival of market.rivals) if (rival.landed < landed) ahead += rival.units;
        // Finite rival stock occurs only in A. The infinite NPC alternative
        // keeps the existing perception assessment, never a second rival share.
        const outcome = saleOutcome({ units: market.units, applicableUnits: market.applicableUnits,
            willingUnits: willingUnitsAt(belief, trader, { price, applicableUnits: market.applicableUnits,
                landed, npcLanded: market.npcLanded }), cheaperUnits: ahead, price,
            residualUnitValue: market.buyback, delayHours: market.delayHours, discountRate: trader.wait });
        if (!outcome.known) return null;
        const discount = Math.exp(-trader.wait * market.delayHours);
        return { price, value: market.units > 0 ? (outcome.sold * saleUtility(price, reference, trader.caution) * discount
            + outcome.residual * npcValue) / market.units : 0,
        money: market.units > 0 ? (outcome.receipts + outcome.residualValue) / market.units : 0,
        sold: outcome.sold, residual: outcome.residual, known: true };
    };
    const pays = (candidate) => candidate && candidate.money > market.buyback;
    let seenAny = false, last = 0;
    const candidates = [];
    // The grid rises, so a rounded price repeats only right after itself.
    for (const z of GRID) {
        const price = Math.max(1, Math.round(Math.exp(belief.mu + z * width)));
        if (price === last || !aboveBuyback(price, market.buyback) || !seen(price)) continue;
        last = price;
        const candidate = valueAt(price);
        seenAny ||= candidate !== null;
        if (pays(candidate)) candidates.push(candidate);
    }
    if (!seenAny && market.truncated) return unknown();
    if (!candidates.length) return npc(true);
    let bestValue = -Infinity;
    for (const candidate of candidates) bestValue = Math.max(bestValue, candidate.value);
    const standing = aboveBuyback(current, market.buyback) && seen(current) ? valueAt(current) : null;
    if (pays(standing) && standing.value >= bestValue - NEAR_BEST * Math.abs(bestValue)) return { ...standing, npc: false, npcValue };
    const best = nearBest(candidates, rollKey);
    return { ...best, npc: false, npcValue };
}

// The bid of a buy ad: { price, value } or null when no bid gains anything.
// worth: what the item is worth to the buyer (its plan's price); cap: the
// most it may pay a unit. Sellers come at the same rate as buyers; a seller
// takes q with the chance the belief gives that he asks no more. Before the
// board shows any seller of the kind, the wait is unknown: a bid is worth its
// gain by that chance alone. `current`: the ad's bid now; it stands while
// it is still among the near-best ones, as an ask does. Every price passes
// aboveBuyback.
function chooseBid(belief, market, trader, { worth, cap }, rollKey, current = 0) {
    // The buyer can buy the whole quantity now for this landed cost. A bid
    // includes its own meeting trip, so it cannot pay more for the same goods.
    cap = Math.min(cap, market.purchaseCap ?? Infinity);
    const least = market.buyback;
    const width = PriceBelief.sigma(belief);
    const reference = Math.exp(belief.mu);
    const centre = belief.mu - (trader.assertiveness - 0.5) * width;
    const deals = Math.ceil(market.units / market.lot);
    const valueAt = (price) => {
        const accepts = phi((Math.log(price) - centre) / width);
        const gain = Number(worth) - purchaseCost(price, reference, trader.caution);
        if (!(gain > 0) || !(accepts > 0)) return null;
        const rate = market.buyersPerHour * accepts;
        return { price, value: rate > 0 ? gain * Math.exp(-trader.wait * (deals + 1) / 2 / rate) : gain * accepts };
    };
    const candidates = [];
    for (const z of GRID) {
        const price = Math.max(1, Math.round(Math.exp(belief.mu + z * width)));
        if (!aboveBuyback(price, least) || price > cap || candidates.some((candidate) => candidate.price === price)) continue;
        const candidate = valueAt(price);
        if (candidate) candidates.push(candidate);
    }
    // The exact outside price need not lie on the belief's coarse grid.
    if (Number.isFinite(market.purchaseCap) && aboveBuyback(Math.floor(cap), least)
        && !candidates.some(candidate => candidate.price === Math.floor(cap))) {
        const candidate = valueAt(Math.floor(cap));
        if (candidate) candidates.push(candidate);
    }
    // One adena over the NPC buy-back is the bid only when no grid or
    // exact-cap price with a gain fits under the cap, and only for an item the
    // NPC buys back. Beside such a price it is no bid: a seller gains nothing
    // over the NPC there, so his every answer would be a coin flip. A bid
    // standing there stands only while it is still the sole candidate.
    const lowest = Number(least) > 0 ? Math.floor(Number(least)) + 1 : null;
    if (!candidates.length && lowest !== null && lowest <= cap) {
        const candidate = valueAt(lowest);
        if (candidate) candidates.push(candidate);
    }
    if (!candidates.length) return null;
    let bestValue = -Infinity;
    for (const candidate of candidates) bestValue = Math.max(bestValue, candidate.value);
    const standing = aboveBuyback(current, least) && current <= cap
        && (current !== lowest || candidates.some(candidate => candidate.price === lowest)) ? valueAt(current) : null;
    if (standing && standing.value >= bestValue - NEAR_BEST * Math.abs(bestValue)) return standing;
    return nearBest(candidates, rollKey);
}

// One roll among options [{ action, value }] in proportion to their values
// (a weighted roll, Q6: variety over the best one): a value at or below 0
// weighs nothing but every option keeps a floor, together TendencyRoll.MIN
// of the whole weight, so none is impossible. When no value is above 0 (all
// are losses), the weights are how much less each loses than the worst.
// null without a finite option.
function chooseByWeight(options, rollKey) {
    const valid = options.filter((option) => Number.isFinite(option.value));
    if (!valid.length) return null;
    let positive = 0;
    let worst = Infinity;
    for (const option of valid) {
        positive += Math.max(0, option.value);
        worst = Math.min(worst, option.value);
    }
    const weightOf = (option) => (positive > 0 ? Math.max(0, option.value) : option.value - worst);
    let total = 0;
    for (const option of valid) total += weightOf(option);
    const floor = total > 0 ? TendencyRoll.MIN * total / valid.length : 1;
    let left = TendencyRoll.roll(...rollKey) * (total + floor * valid.length);
    for (const option of valid) {
        left -= weightOf(option) + floor;
        if (left <= 0) return option;
    }
    return valid[valid.length - 1];
}

module.exports = { GRID, NEAR_BEST, PERCEPTION, waitRate, traderOf, phi, saleUtility, purchaseCost, marketFor, saleOutcome, willingUnitsAt, prospectiveExit, QUOTE_DEPTH, cheaperAsks, exitCompetition, bidSale, bidLots, heldUnits, plainSale,
    buyback, chooseAsk, chooseBid, aboveBuyback, heldBid, chooseByWeight };
