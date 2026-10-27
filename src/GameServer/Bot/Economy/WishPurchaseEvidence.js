'use strict';
// An observed acquisition, including permitted authored unlimited supply.
// Existing quote order, static source authority and marginal route are reused.
const Query = require('./OfferQuery');
const OfferOrder = require('./OfferOrder');
const FixedShots = require('./FixedShotOffers');
const Diagnostics = require('./EconomyDiagnostics');
const { offerAdmission } = require('../Population/PartyAdmission');
const NPC_LIMIT = 17;
// The most units an entry's one-unit quote holds for (a small integer).
const MOST = 2 ** 30 - 1;
const unlimited = offer => offer.sourceType === 'npc' || offer.sourceType === 'configured_store';
// The half of the accept test that reads only the offer; the trip to its town
// and the buyer's own rules (reader: refusal, party) are the buyer's half.
const offerAccepted = row => Number(row.price) > 0 && !Number(row.enchant || 0)
    && (unlimited(row) || Number.isSafeInteger(Number(row.count)) && Number(row.count) > 0)
    && row.available !== false;
// The NPC offers a reader takes from one item's list (the shop owner's,
// ColdOccupationSources.npcOffersFor): at most NPC_LIMIT, of the reader's
// town and only NPCs when it asks so. Read per call; never written to.
function npcCandidates(offers, npcOnly, town) {
    if (!npcOnly && !town) return offers.length <= NPC_LIMIT ? offers : offers.slice(0, NPC_LIMIT);
    return offers.filter(offer => (!npcOnly || offer.sourceType === 'npc')
        && (!town || offer.town === town)).slice(0, NPC_LIMIT);
}
const knownRoute = (cost, town) => {
    const route = cost.details(town);
    return route?.known && Number.isFinite(route.hours) && Number.isFinite(route.fees) ? route : null;
};
function quote(offer, cost) {
    const route = offer && knownRoute(cost, offer.town);
    if (!route) return null;
    return { price: Number(offer.price), unitPrice: Number(offer.price), availableUnits: unlimited(offer) ? Infinity : Number(offer.count),
        town: offer.town, sourceType: unlimited(offer) ? offer.sourceType : 'afk', quoted: true,
        tripHours: route.hours || 0, tripFees: route.fees || 0 };
}
// The buy of `amount` units the way a buyer makes it (user 2026-10-24): the
// town where the amount costs least with its trip (OfferQuery.cheapestIn
// over the item's town table), its asks taken best first, the NPC there for
// the rest. price: the mean a unit; unitPrice: the dearest ask taken (the
// limit the buyer's orders carry); availableUnits: what the town sells at or
// under it (OfferQuery.townUnits over the item's town table; Infinity with
// its NPC); for one unit (no table) the count of the offer taken. best: the
// query's fill of the amount (OfferQuery.cheapestTown or cheapestIn) over
// `options`, whose npcOffers are the accepted NPC and configured offers.
function sizedQuote(best, options, cost, table = null) {
    const route = best && knownRoute(cost, best.town);
    if (!route) return null;
    let unitPrice = best.npc > 0 ? best.npcPrice : 0;
    for (const taken of best.lines) if (taken.price > unitPrice) unitPrice = taken.price;
    const seller = best.lines.length ? null
        : OfferOrder.best(options.npcOffers.filter(offer => offer.town === best.town && Number(offer.price) === best.npcPrice));
    const availableUnits = table ? Query.townUnits(table, best, unitPrice)
        : best.npc > 0 ? Infinity : Number(best.lines[0].line.count);
    return { price: best.cost / best.units, unitPrice, availableUnits,
        town: best.town, sourceType: best.lines.length ? 'afk' : seller?.sourceType || 'npc', quoted: true,
        tripHours: route.hours || 0, tripFees: route.fees || 0 };
}
// One reader is one build's (WishProviders' purchaseFor, the Giran NPC read):
// each item is quoted once in it and the entry serves every later read of the
// build; nothing is kept across builds (quotekeep0 2026-10-25: a kept store
// served 14 % of quotes for ~20 MB of worker heap).
function reader(state, ctx, deps, { npcOnly = false, town = null } = {}) {
    // Preparation belongs to the existing worker. A reader cannot synchronously
    // expand geometry or treat an unprepared trip as free.
    const cost = deps.tripCost || ctx.trip;
    if (typeof cost !== 'function' || typeof cost.details !== 'function') return () => null;
    // The table skips a town of no finite trip. Its accept: the offer's half,
    // then the buyer's, as its executor takes a line (ReadyTradeChoice.purchase):
    // never a line whose meeting it was refused, a meeting ad only where the
    // party rule admits it (PartyAdmission.offerAdmission: the buyer's half
    // read once for the reader's build).
    const admitted = offerAdmission(state);
    const accept = line => offerAccepted(line) && !Query.meetingRefused(line, state) && admitted(line);
    const options = { ...(town ? { towns: [town] } : {}), excludeOwner: state.characterId, cost,
        accept, acceptFixed: true };
    const diagnostic = Diagnostics.active();
    // The context's watched board records an absent item as an input too.
    const board = npcOnly ? null : ctx.board || deps.board;
    const heads = board?.heads ? board : null;
    // The query of each item this reader quotes (its NPC and configured
    // offers) and, for an item asked more than one unit, its town table
    // (OfferQuery.townTable, as the buyer reads the board on arrival; it
    // fills each amount once, cheapestIn): one per item and reader, so a
    // build's amounts of an item share it; never kept with the build.
    const queries = new Map(), tables = new Map();
    // The two parts of FixedShotOffers.staticOffers apart. Read at an item's
    // first query only.
    const npcListOf = id => FixedShots.npcOffers(id, deps.npcOffersFor);
    const queryOf = id => {
        let query = queries.get(id);
        if (!query) {
            const fixed = npcOnly ? null : FixedShots.offers(id);
            const npc = npcCandidates(npcListOf(id), npcOnly, town);
            // Never push onto the shop owner's list.
            queries.set(id, query = { ...options, npcOffers: (fixed?.length ? [...npc, ...fixed] : npc).filter(offerAccepted) });
        }
        return query;
    };
    const tableOf = id => {
        let table = tables.get(id);
        if (!table) tables.set(id, table = Query.townTable(heads, id, queryOf(id)));
        return table;
    };
    // An item's entry: [the quote of one unit|null, the most units that
    // quote is also the sized quote for (its offer holds them and no town
    // lands them cheaper: OfferQuery.unitBestBelow; -1 until an amount over
    // one is asked; 0 for a null quote)].
    const entryOf = id => {
        if (npcOnly && town) {
            // One town, no board, no fixed shots: the trip is the same for
            // every candidate, the one order picks among the accepted ones.
            // An NPC sells any amount.
            const npc = npcCandidates(npcListOf(id), npcOnly, town);
            const kept = npc.length === 1 ? (offerAccepted(npc[0]) ? npc : []) : npc.filter(offerAccepted);
            if (!kept.length || !Number.isFinite(cost(town))) return [null, 0];
            const one = quote(kept.length === 1 ? kept[0] : Query.bestSellOffer(null, id, { cost, others: kept }), cost);
            return [one, one ? Math.min(MOST, one.availableUnits) : 0];
        }
        // One unit: one pass over the towns, no table.
        const query = queryOf(id);
        const one = sizedQuote(Query.cheapestTown(heads, id, query), query, cost);
        return [one, one ? -1 : 0];
    };
    const holdsOf = (id, entry) => {
        const table = tableOf(id);
        const below = Query.unitBestBelow(table, Query.cheapestIn(table, 1));
        return Math.min(MOST, entry[0].availableUnits, Math.ceil(below) - 1);
    };
    // The build's entries. A repeat read on a board tells the context's
    // watch again (ctx.watch), as the board did at the first read, so a node
    // read scope that reads the item second lists it too.
    const entries = new Map();
    const itemEntry = id => {
        let entry = entries.get(id);
        if (entry) {
            if (heads) ctx.watch?.(id);
            return entry;
        }
        if (diagnostic) Diagnostics.count('context', 'purchase_quote', 'quoted');
        entries.set(id, entry = entryOf(id));
        return entry;
    };
    // The same query without one town's players' asks (its NPC and every
    // other town stay): the buy a buyer makes when rival takers hold that
    // town's asks before it (WishProviders buyWait). Its own town table per
    // item and town, never kept with the build: a wait is one build's.
    const elsewhere = new Map();
    const elsewhereOf = (id, taken, amount) => {
        const key = `${id}:${taken}`;
        let table = elsewhere.get(key);
        // A repeat read tells the watch again, as itemEntry does.
        if (table) { if (heads) ctx.watch?.(id); }
        else {
            const query = queryOf(id);
            elsewhere.set(key, table = Query.townTable(heads, id,
                { ...query, accept: line => line.town !== taken && accept(line) }));
        }
        return sizedQuote(Query.cheapestIn(table, amount), table.options, cost, table);
    };
    // The quote of `amount` units: the one-unit quote itself (the same
    // object) while it holds for them, else the sized quote of the reader's
    // town table. taken: a town whose asks are left out (elsewhereOf).
    return (id, amount = 1, taken = null) => {
        amount = Math.max(1, Math.floor(Number(amount) || 1));
        if (taken && !npcOnly) return elsewhereOf(id, taken, amount);
        const entry = itemEntry(id);
        // No offer for one unit is no offer for more.
        if (amount === 1 || !entry[0]) return entry[0];
        if (entry[1] < 0) entry[1] = holdsOf(id, entry);
        if (amount <= entry[1]) return entry[0];
        const table = tableOf(id);
        return sizedQuote(Query.cheapestIn(table, amount), table.options, cost, table);
    };
}
// How long a buyer waits until a unit is its own to buy (gearstuck, user
// 2026-10-25), the buy path's ready hours (WishProviders itemNode): 0 while
// the units free for its ask (the quote's units less the other units it
// asks) exceed the units rival buyers take before it (rivals,
// CommittedExits.rivalTakerUnits in the quote's town); else the units still
// to come for it over the item's observed supply (supply: a reader of
// MarketDemand.supplyPerHour, read only when the ask waits). units <= 0: a
// buy of more units than the town sells (componentroute 2026-10-25), its
// shortfall comes after the rivals' too. Infinity when nothing comes. No
// memory: the wait of one build, read again at the next.
function unitWait({ units = 0, rivals = 0, supply = () => 0 } = {}) {
    const ahead = Math.max(0, Number(rivals) || 0) + 1 - (Number(units) || 0);
    if (!(ahead > 0)) return 0;
    const rate = Math.max(0, Number(supply()) || 0);
    return rate > 0 ? ahead / rate : Infinity;
}
module.exports = { reader, unitWait };
