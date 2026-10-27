// The one offer query (U20): the best sell offer for a buyer, from the board
// (a BoardIndex) and the caller's other sources (NPC shops, the configured
// city merchants), in the one order of OfferOrder (price plus the trip to the
// offer's town, a player before a bot, an NPC last, a stable id). A buyer
// asks it through bestBuyerOffer (MarketOpportunity.bestOffer on main, the
// planning workers over the index they build from the board table). Static
// code only.
const { SELL, offerFields, settlesAtOnce } = require('../../AfkTrade/BoardIndex');
const OfferOrder = require('./OfferOrder');
const Diagnostics = require('./EconomyDiagnostics');

// The purchases a bot makes on an errand, not on a wish: a craft's scroll and
// inputs, a shot crafter's crystal gear, a clan's buy, a reserved raid's
// shots (RaidSupplyPolicy.shotQuote and its fence-time purchase). They buy
// only lines that sell at once (BoardIndex.settlesAtOnce): a conditional line
// sells through a trade meeting whose buyer consent is rebuilt from the funded
// wish network (TradeIntent.meetingPurchase), where an errand is not, so the
// bot would wait in town until the errand (or the raid's reservation) lapses.
// Goal buys ('supply', 'stock') are wish buys with that consent and keep
// meeting lines.
const ERRAND_PURPOSES = new Set(['wealth_craft', 'recipe', 'craft_input', 'clan', 'raid_supply']);
const settledOnlyFor = purpose => ERRAND_PURPOSES.has(purpose);

// options: towns (a list; null: every town), excludeOwner (the buyer's own
// records), budget, cost (OfferOrder.tripCost), accept(offer) (the caller's
// own test, such as a minimum price), toOffer(line, town) (the thread's offer
// of a board line; offerFields by default), others (offers of the other
// sources, already in the buyer's towns), purpose (an errand purpose takes
// only lines that settle at once, settledOnlyFor).
function bestSellOffer(index, selfId, options = {}) {
    const budget = Number.isFinite(Number(options.budget)) ? Number(options.budget) : Infinity;
    const towns = options.towns || null;
    const town = towns?.length === 1 ? towns[0] : null;
    const toOffer = options.toOffer || offerFields;
    const accept = settledOnlyFor(options.purpose)
        ? offer => settlesAtOnce(offer) && (!options.accept || options.accept(offer)) : options.accept || null;
    const offers = [];
    // The best line of each town within budget: the lists are in price order,
    // so the trip decides only between towns.
    for (const line of index ? index.heads(selfId, SELL, {
        towns,
        maxInspected: options.maxInspected,
        excludeOwner: options.excludeOwner,
        accept: (candidate) => candidate.price <= budget && (!accept || accept(offerFields(candidate, town)))
    }) : []) {
        const offer = toOffer(line, town);
        if (offer) offers.push(offer);
    }
    for (const offer of options.others || []) {
        if (!accept || accept(offer)) offers.push(offer);
    }
    return OfferOrder.best(offers, { budget, cost: options.cost || null });
}

// The one rule for "this bot's deal on this line was refused": a meeting on
// the line at this ad revision was refused (TradeMeetingService.traderRefused
// keeps [lineId, revision] on the bot's row); the ad's next revision is a new
// deal. `line` is a board line or its offer (BoardIndex.offerFields names
// the revision expectedRevision). Read by every picker of a board line:
// bestBuyerOffer, ReadyTradeChoice (executable, buyerExitOpen, purchase),
// ColdMarketService.planPurchase, ColdMarketBuyStoreService.sellToBestBuyer,
// MarketOpportunity.findBuyOffers, ColdWealthCraftService's arrival sale.
function meetingRefused(line, state) {
    const refused = state?.stats?.meetingRefused;
    return Array.isArray(refused) && refused[0] === Number(line.lineId)
        && refused[1] === Number(line.revision ?? line.expectedRevision);
}

// The one buyer's offer search (MarketOpportunity.bestOffer on main; the
// planning workers' copies: ColdSimulationWorker's MarketOpportunity,
// ColdNpcPlanningCatalog.findMarketOffer, ClanPlanningWorker's market) over
// `index`: options as MarketOpportunity.bestOffer (town or towns,
// buyerCharacterId, budget, cost, purpose, accept); the thread's source:
// buyerState (the buyer's row: a line whose meeting it was refused,
// meetingRefused, is never its offer), allowed(offer) (the thread's own
// admission, such as the party rule), toOffer, others(towns) (its other
// sources in those towns).
function bestBuyerOffer(index, selfId, options = {}, source = {}) {
    const towns = options.town ? [options.town] : options.towns || null;
    return bestSellOffer(index, selfId, {
        towns,
        excludeOwner: options.buyerCharacterId,
        budget: options.budget,
        cost: options.cost,
        purpose: options.purpose,
        accept: offer => !meetingRefused(offer, source.buyerState) && (!source.allowed || source.allowed(offer))
            && (!options.accept || options.accept(offer)),
        toOffer: source.toOffer,
        others: source.others ? source.others(towns) : []
    });
}

// What `amount` units cost from sell lines (best first, the board's order)
// at or under `maxPrice` and no dearer than the NPC (its stock never runs
// out: a dearer line is never taken), then the NPC at `npcPrice` for the
// rest, within `money`: { lines: [{ line, count, price }], npc (units from the NPC),
// units, cost }. One rule for the purchase of a stack (a shot restock,
// materials): ShotStock.restockPlan and cheapestTown. settledOnly: only lines
// that sell at once (inspectedLines), on the uncut list too. ordered: the
// lines are a board list (BoardIndex order, cheapest first), so the first
// line dearer than the limits ends the fill.
const LINE_STOP = 0, LINE_SKIP = 1, LINE_TAKE = 2;
// One line's rule for fill and the ladder (extendLadder), in the order they
// apply it: STOP the walk when an ordered list reaches a line dearer than
// maxPrice or the NPC, SKIP a line that does not sell at once (settledOnly),
// the buyer's own line (before the caller's accept: never read as an offer),
// one the caller's accept refuses or one without a usable price or count,
// else TAKE it. `price` is Number(line.price).
function lineStep(line, price, npcPrice, maxPrice, ordered, options) {
    if (ordered && (price > maxPrice || (npcPrice > 0 && price > npcPrice))) return LINE_STOP;
    if (options.settledOnly && !settlesAtOnce(line)) return LINE_SKIP;
    if (options.excludeOwner && Number(line.ownerId ?? line.sourceId) === Number(options.excludeOwner)) return LINE_SKIP;
    if (options.accept && !options.accept(line)) return LINE_SKIP;
    if (!(price > 0) || price > maxPrice || (npcPrice > 0 && price > npcPrice) || !(Number(line.count) > 0)) return LINE_SKIP;
    return LINE_TAKE;
}
function fill(lines, amount, options = {}) {
    const { npcPrice = 0, money = Infinity, maxPrice = Infinity, ordered = false } = options;
    let left = Math.max(0, Math.floor(Number(amount) || 0));
    let budget = Math.max(0, Number(money));
    const taken = [];
    let cost = 0;
    for (const line of lines || []) {
        if (left <= 0) break;
        const price = Number(line.price);
        const step = lineStep(line, price, npcPrice, maxPrice, ordered, options);
        if (step === LINE_STOP) break;
        if (step === LINE_SKIP) continue;
        const count = Math.min(left, Number(line.count), Math.floor(budget / price));
        if (count <= 0) break;
        taken.push({ line, count, price });
        left -= count;
        budget -= count * price;
        cost += count * price;
    }
    const npc = npcPrice > 0 && npcPrice <= maxPrice ? Math.max(0, Math.min(left, Math.floor(budget / npcPrice))) : 0;
    cost += npc * npcPrice;
    let units = npc;
    for (const entry of taken) units += entry.count;
    return { lines: taken, npc, units, cost };
}

let shortCalls = 0;
// E303: the quote depth cap of 5 (cheapestTown quoteDepth). Counts the check, and the cut with the lines it
// dropped; returns whether it cut. cap:quotes:short (cheapestTown) is a cut call whose result is not whole;
// of the short calls of callers with pure callbacks (options.sampleWhole: the sample runs accept, cost and
// moneyForTown over every town), one in 64 (`sampled`) is priced again over the whole list, `lost` counts
// those it fills. Developer diagnostics only; its route reads warm the caller's trip cache.
function noteQuoteCut(length, depth) {
    if (!Diagnostics.active()) return false;
    Diagnostics.count('cap', 'quotes', 'check');
    if (length <= depth) return false;
    Diagnostics.count('cap', 'quotes', 'cut');
    Diagnostics.count('cap', 'quotes', 'dropped', length - depth);
    return true;
}

// The town where a buyer gets `amount` units of an item for the least, its
// trip there included (б5, D1; user Q1 A for shots): in each town the board's
// lines there and the NPC shop there as one more offer (fill), plus the
// buyer's round trip (`cost`, OfferOrder.tripCost; 0 for its own town). A
// town that fills the whole amount comes first, then the least landed price
// a unit. options: towns (null: every town with lines or an NPC), npcOffers
// ([{ town, price }]), money, maxPrice, excludeOwner, cost, quoteDepth (only
// the first lines of the item's board list, the ones a trader inspects,
// PriceDecision.QUOTE_DEPTH; each in its own town). Returns { town,
// lines, npc, npcPrice, units, cost, trip, landed } or null. O(T log n + k)
// over the towns with offers.
function cheapestTown(index, selfId, options = {}) {
    const amount = Math.max(1, Math.floor(Number(options.amount) || 1));
    const view = boardView(index, selfId, options);
    const cut = view.inspected ? noteQuoteCut(view.board.length, options.quoteDepth) : false;
    // One pass over the towns, no table: most callers price one amount.
    let best = null;
    for (const town of new Set(options.towns || [...view.listed, ...view.npcPrice.keys()])) {
        if (!town) continue;
        const trip = options.cost ? Number(options.cost(town)) : 0;
        if (!Number.isFinite(trip)) continue;
        best = betterOffer(best, options, amount, town, trip, view.npcPrice.get(town) || 0,
            view.inspected ? view.inspected.get(town) || [] : index ? index.list(selfId, SELL, town) : []);
    }
    return noteShort(index, selfId, options, amount, cut, best);
}

// The first `depth` lines of a price-ordered list, the ones a trader inspects
// (PriceDecision.QUOTE_DEPTH). settledOnly: an errand purchase (settledOnlyFor)
// counts only lines that sell at once (BoardIndex.settlesAtOnce),
// so conditional lines above a shop line never push it out of the depth.
function* inspectedLines(lines, depth, settledOnly = false) {
    let taken = 0;
    for (const line of lines || []) {
        if (taken >= depth) return;
        if (settledOnly && !settlesAtOnce(line)) continue;
        taken++;
        yield line;
    }
}

// The board part of a query: the cheapest NPC price per town and, under a
// quote cap, the inspected lines by town (inspectedLines, options.settledOnly).
// The cap is counted by the pricing call (cheapestTown, cheapestIn), once per
// amount, never by a table build.
function boardView(index, selfId, options) {
    const npcPrice = new Map();
    for (const offer of options.npcOffers || []) {
        const price = Number(offer.price);
        if (offer.town && price > 0 && (!npcPrice.has(offer.town) || price < npcPrice.get(offer.town))) npcPrice.set(offer.town, price);
    }
    const inspected = options.quoteDepth > 0 ? new Map() : null;
    const board = inspected ? index ? index.list(selfId, SELL) : [] : null;
    if (inspected) for (const line of inspectedLines(board, options.quoteDepth, options.settledOnly === true)) {
        if (!inspected.has(line.town)) inspected.set(line.town, []);
        inspected.get(line.town).push(line);
    }
    return { npcPrice, inspected, board, listed: inspected ? inspected.keys() : index ? index.towns(selfId, SELL) : [] };
}

// The offer a fill takes first: its first line, else the town's NPC.
const firstTaken = filled => filled.lines.length ? offerFields(filled.lines[0].line) : { sourceType: 'npc' };

// One town's fill for `amount` against the best so far: a whole fill first,
// then the least landed price a unit, then the seller of the first offer
// taken (OfferOrder.compareSellers: a player before a bot, an NPC last),
// then the town name.
// held, row: a table's held fills (heldFills) and the town's row: the fill
// is read from the row's ladder (ladderFill) where one serves it.
function betterOffer(best, options, amount, town, trip, price, lines, held = null, row = null) {
    const money = options.moneyForTown ? options.moneyForTown(town, price, lines) : options.money ?? Infinity;
    const filled = (held && ladderFill(held, options, row, amount, money)) || fill(lines, amount, {
        npcPrice: price, money, maxPrice: options.maxPrice ?? Infinity,
        excludeOwner: options.excludeOwner, accept: options.accept, settledOnly: options.settledOnly === true, ordered: true
    });
    if (!filled.units) return best;
    const landed = filled.cost + trip;
    const whole = filled.units >= amount;
    const better = !best || (whole !== best.whole ? whole
        : landed / filled.units < best.landed / best.units || (landed / filled.units === best.landed / best.units
            && (OfferOrder.compareSellers(firstTaken(filled), firstTaken(best)) || String(town).localeCompare(best.town)) < 0));
    return better ? { town, ...filled, npcPrice: price, trip, landed, whole, spendBudget: money } : best;
}

function noteShort(index, selfId, options, amount, cut, best) {
    if (cut && !best?.whole) {
        Diagnostics.count('cap', 'quotes', 'short');
        if (options.sampleWhole && Diagnostics.active() && (++shortCalls & 63) === 0) {
            Diagnostics.count('cap', 'quotes', 'sampled');
            if (cheapestTown(index, selfId, { ...options, amount, quoteDepth: 0, sampleWhole: false })?.whole) Diagnostics.count('cap', 'quotes', 'lost');
        }
    }
    return best;
}

// The amount-free part of cheapestTown: each town's trip, NPC price and
// lines, in the query's town order. A buyer that prices one item for several
// amounts within one plan (craft batches 1..64 over one board snapshot) reads
// the board and the trips once and fills each amount from this table.
// options.acceptFixed: the caller's accept answers the same for a line as
// long as the table lives (a table of one build), so cheapestIn need not
// test it again on every call.
function townTable(index, selfId, options = {}) {
    const view = boardView(index, selfId, options);
    const rows = [];
    for (const town of new Set(options.towns || [...view.listed, ...view.npcPrice.keys()])) {
        if (!town) continue;
        const trip = options.cost ? Number(options.cost(town)) : 0;
        if (!Number.isFinite(trip)) continue;
        rows.push({ town, trip, price: view.npcPrice.get(town) || 0,
            lines: view.inspected ? view.inspected.get(town) || [] : index ? index.list(selfId, SELL, town) : [] });
    }
    return { index, selfId, options, listed: view.board ? view.board.length : 0, rows };
}

// The fills a table holds while they stay true (cheapestIn's fills by
// amount, the rows' ladders): for the table's life, and by the item's
// admission revision while options.accept reads the seller's half of the
// party rule live (the buyer's half is fixed for the table:
// PartyAdmission.offerAdmission reads it once); a table whose accept answers
// the same for its life (options.acceptFixed: a table of one build) holds
// on nothing more. Null: nothing is held (moneyForTown, read per town, or a
// board that keeps no admission revision: main's).
// Reads of a held fill: the rows (town, NPC price, lines: fixed for the
// table), options (accept, acceptFixed, excludeOwner, maxPrice, money,
// settledOnly: fixed for the table) and the admission revision (the guard).
function heldFills(table) {
    const options = table.options;
    // No board: no line for accept to read.
    const admission = !options.accept || options.acceptFixed || !table.index ? 0
        : table.index.admissionRevision?.(table.selfId) ?? null;
    if (options.moneyForTown || admission === null) return null;
    const held = table.held ||= { admission, byAmount: new Map(), ladders: new Map() };
    if (held.admission !== admission) {
        held.byAmount.clear();
        held.ladders.clear();
        held.admission = admission;
    }
    return held;
}

// A row's ladder: fill's walk over the row's lines with no amount and no
// money limit (ordered: up to the first line dearer than the NPC or
// options.maxPrice), kept as the lines it takes in order with the running
// count, the running cost (summed as fill sums it) and the dearest line
// walked so far (reach: where a walk under a lower price limit stops). It is
// walked only as far as an amount or a price asks (extendLadder), so a held
// row never walks more lines than fill would. exact false: a line whose
// count is not a safe integer or price not finite, which a running total does
// not keep exactly; that row is filled by fill.
function ladderOf(held, row) {
    let ladder = held.ladders.get(row);
    if (!ladder) held.ladders.set(row, ladder = { taken: [], counts: [], costs: [], reach: [], walked: -Infinity, next: 0, done: false, exact: true });
    return ladder;
}
function extendLadder(ladder, options, row, units, maxPrice) {
    const lines = row.lines || [], npcPrice = row.price, cap = options.maxPrice ?? Infinity;
    while (!ladder.done && ladder.exact && (ladder.counts.length ? ladder.counts[ladder.counts.length - 1] : 0) < units
        && !(ladder.walked > maxPrice)) {
        if (ladder.next >= lines.length) { ladder.done = true; break; }
        const line = lines[ladder.next++];
        const price = Number(line.price);
        const step = lineStep(line, price, npcPrice, cap, true, options);
        if (step === LINE_STOP) { ladder.done = true; break; }
        if (price > ladder.walked) ladder.walked = price;
        if (step === LINE_SKIP) continue;
        const count = Number(line.count), last = ladder.counts.length - 1;
        const total = (last < 0 ? 0 : ladder.counts[last]) + count;
        if (!Number.isSafeInteger(count) || !Number.isFinite(price) || !Number.isSafeInteger(total)) { ladder.exact = false; break; }
        ladder.taken.push({ line, count, price });
        ladder.counts.push(total);
        ladder.costs.push((last < 0 ? 0 : ladder.costs[last]) + count * price);
        ladder.reach.push(ladder.walked);
    }
    return ladder.exact ? ladder : null;
}

// fill of `amount` units over a held row (ordered, its NPC at row.price, no
// money limit), read from its ladder: the lines before the first whose
// running count reaches the amount whole, that one in part, the NPC for the
// rest. The same result as fill: the same lines and counts, the cost summed
// in the same order. Null where the ladder does not serve (a money limit,
// an amount or a line a running total does not keep exactly).
function ladderFill(held, options, row, amount, money) {
    const left = Math.max(0, Math.floor(Number(amount) || 0));
    if (!row || Math.max(0, Number(money)) !== Infinity || !Number.isSafeInteger(left)) return null;
    const ladder = extendLadder(ladderOf(held, row), options, row, left, Infinity);
    if (!ladder) return null;
    const counts = ladder.counts, size = counts.length;
    // The first line whose running count reaches the amount (size: none).
    let lo = 0, hi = size;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (counts[mid] >= left) hi = mid; else lo = mid + 1;
    }
    const lines = ladder.taken.slice(0, lo);
    let cost = lo ? ladder.costs[lo - 1] : 0, units = lo ? counts[lo - 1] : 0;
    if (lo < size && left > units) {
        const { line, price } = ladder.taken[lo], count = left - units;
        lines.push({ line, count, price });
        cost += count * price;
        units = left;
    }
    const npcPrice = row.price, maxPrice = options.maxPrice ?? Infinity;
    // fill's NPC rule with its budget (no money limit: Infinity).
    const npc = npcPrice > 0 && npcPrice <= maxPrice ? Math.max(0, Math.min(left - units, Math.floor(Infinity / npcPrice))) : 0;
    cost += npc * npcPrice;
    return { lines, npc, units: npc + units, cost };
}

// cheapestTown for `amount` from a townTable. The quote cap is counted per
// call, as one cheapestTown call counts it.
// ARCH-NOTE: PERF the town loop is memoized per table and amount (heldFills): a craft search prices one input at
// the same amounts again and again (offline, 100 crafters: 71% of cheapestIn calls repeat a (table, amount)), and
// the loop is a pure function of the rows, the options and the amount. A new amount fills each row from its
// ladder (ladderFill): a build prices one item at many distinct amounts (gear evaluate profile 7a50abfa8: the
// sized buy quotes 3.25 % of busy worker time, memo misses), so the lines, accept and the party rule are
// walked once per row, not once per amount. The noteQuoteCut and noteShort counts run on every call, in the
// same order. moneyForTown (read per town) is never held. Consumers copy `best` and only read its lines, so the
// hits share one result object, and fills share the ladder's whole line entries.
function cheapestIn(table, amount) {
    const options = table.options;
    amount = Math.max(1, Math.floor(Number(amount) || 1));
    const cut = options.quoteDepth > 0 ? noteQuoteCut(table.listed, options.quoteDepth) : false;
    const held = heldFills(table);
    let best = held?.byAmount.get(amount);
    if (best === undefined) {
        best = null;
        for (const row of table.rows) best = betterOffer(best, options, amount, row.town, row.trip, row.price, row.lines, held, row);
        held?.byAmount.set(amount, best);
    }
    return noteShort(table.index, table.selfId, options, amount, cut, best);
}

// How many units the town of `best` (a cheapestIn result of `table`) sells
// at or under `maxPrice`, by the rule of a fill (fill): Infinity when its NPC
// sells at or under it. A held row reads its ladder (the lines it takes whose
// walk stayed at or under maxPrice), as fill would walk them.
function townUnits(table, best, maxPrice) {
    const options = table.options, row = table.rows.find(row => row.town === best.town);
    const npcPrice = best.npcPrice;
    const held = row && row.price === npcPrice && typeof maxPrice === 'number' && maxPrice <= (options.maxPrice ?? Infinity)
        ? heldFills(table) : null;
    const ladder = held && extendLadder(ladderOf(held, row), options, row, Infinity, maxPrice);
    // fill's NPC rule with no amount and no money limit: every unit, the
    // lines' counts being finite (an exact ladder).
    if (ladder && npcPrice > 0 && npcPrice <= maxPrice) {
        if (Number.isFinite(npcPrice)) return Infinity;
    } else if (ladder) {
        // The last line taken whose walk stayed at or under maxPrice.
        let lo = 0, hi = ladder.reach.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (ladder.reach[mid] <= maxPrice) lo = mid + 1; else hi = mid;
        }
        return lo ? ladder.counts[lo - 1] : 0;
    }
    return fill(row ? row.lines : [], Infinity, { npcPrice, maxPrice,
        excludeOwner: options.excludeOwner, accept: options.accept, settledOnly: options.settledOnly === true, ordered: true }).units;
}

// The amounts below which `best` (cheapestIn(table, 1)) is also the best fill
// of a table without a money limit, as long as its town fills them at its
// one-unit price: another town's fill costs at least its one-unit price a
// unit, so it lands cheaper only where that price is under best's and the
// longer trip spreads over enough units (betterOffer: a whole fill first, then
// the landed price a unit; at an equal one-unit price and trip the same tie
// break as for one unit). 1: no larger amount is sure.
function unitBestBelow(table, best) {
    const options = table.options;
    if (!best || options.moneyForTown || Number.isFinite(Number(options.money))) return 1;
    const unit = best.cost / best.units;
    let below = Infinity;
    for (const row of table.rows) {
        if (row.town === best.town) continue;
        const one = fill(row.lines, 1, { npcPrice: row.price, maxPrice: options.maxPrice ?? Infinity,
            excludeOwner: options.excludeOwner, accept: options.accept, settledOnly: options.settledOnly === true, ordered: true });
        if (one.units && one.cost < unit) below = Math.min(below, (row.trip - best.trip) / (unit - one.cost));
    }
    return below;
}

// The other sources a buyer sees in `towns` (null: every town): the
// configured merchants there (or without a town), the NPC shops only in a
// named town.
function othersIn(towns, fixed = [], npc = []) {
    return [
        ...fixed.filter((offer) => !towns || !offer.town || towns.includes(offer.town)),
        ...(towns ? npc.filter((offer) => towns.includes(offer.town)) : [])
    ].filter((offer) => offer.available !== false);
}

module.exports = { bestSellOffer, bestBuyerOffer, meetingRefused, cheapestTown, townTable, cheapestIn, townUnits, unitBestBelow, fill, othersIn, inspectedLines, settledOnlyFor };
