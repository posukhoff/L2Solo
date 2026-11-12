'use strict';

// What an account knows of prices (economy design, ours): its own deals (a
// price memory of 16 rows of { item, enchant, price }), the book of the town
// its main stands in, the book of its twin's town (a player with two
// windows) and, for trip and the sale of kept stock, the books of the towns
// its main visited as they stood at its last visit there (what it saw
// itself), and which towns are hubs (a fact of the game, as a wiki; their
// prices are not). No count of other bots' plans. Pure: the memory and the books
// arrive as plain data; remember returns a new memory. Read by the
// workshop and its lines, and by a main's trip and visit.

// Rows of the price memory (the design's account row).
const MEMORY_ROWS = 16;

// The memory after a deal: the item's row is replaced by the new price and
// becomes the newest; past 16 rows the oldest deal goes.
function remember(memory, { item, enchant = 0, price }) {
    const rest = (memory || []).filter(row => !(row.item === Number(item) && row.enchant === enchant));
    const next = [...rest, { item: Number(item), enchant, price }];
    return next.length > MEMORY_ROWS ? next.slice(next.length - MEMORY_ROWS) : next;
}

// The last price the account dealt the item at, null when it never did.
function known(memory, item, enchant = 0) {
    const row = (memory || []).find(entry => entry.item === Number(item) && entry.enchant === enchant);
    return row ? row.price : null;
}

// The towns whose books an account reads: the town its main stands in and
// its twin's town (crafter accounts), each once.
function reachTowns({ town = null, twinTown = null }) {
    return [...new Set([town, twinTown].filter(Boolean))];
}

// What an account sees of an item in the books it reaches. books: { town:
// { sell: { item: [{ price, qty, owner }] }, buy: { item: [...] }, bids:
// { grade: [{ price, qty, owner }] } } }. self: the account's own index,
// whose lines are not rivals. ads: the mains' WTS and WTB ads ({ sell:
// { item: [entry] }, buy: { item: [entry] } }), heard everywhere until the
// regional chat (the ads are global). Returns { rivalSell: the cheapest other
// sell line's or WTS's price, bestBid: the dearest other buy line's or WTB's
// price } (null without one).
function reach(place, books, item, self = -1, ads = null) {
    let rivalSell = null, bestBid = null;
    const read = book => {
        for (const line of book?.sell?.[item] || []) if (line.owner !== self && line.qty > 0 && (rivalSell === null || line.price < rivalSell)) rivalSell = line.price;
        for (const line of book?.buy?.[item] || []) if (line.owner !== self && line.qty > 0 && (bestBid === null || line.price > bestBid)) bestBid = line.price;
    };
    for (const town of reachTowns(place)) read(books[town]);
    if (ads) read(ads);
    return { rivalSell, bestBid };
}

// The best crystallizer bid per crystal of a grade in reach (null without one).
function bestCrystalBid(place, books, grade, self = -1) {
    let best = null;
    for (const town of reachTowns(place)) {
        for (const bid of books[town]?.bids?.[grade] || []) if (bid.owner !== self && bid.qty > 0 && (best === null || bid.price > best)) best = bid.price;
    }
    return best;
}

// What a main sees of a town's book, other owners' lines only: the buy
// side for the items of `buy`, the sell side for those of `sell`: { buy:
// { item: { price (the dearest), qty (the units at that price) } }, sell:
// { item: { price (the cheapest), qty } } }. book: { sell: { item: [entry] }
// cheapest first, buy: { item: [entry] } dearest first } (books.js).
function seen(book, { buy = [], sell = [] }, self = -1) {
    const out = { buy: {}, sell: {} };
    for (const [side, items] of [['buy', buy], ['sell', sell]]) {
        for (const item of items) {
            let price = null, qty = 0;
            for (const line of book?.[side]?.[item] || []) {
                if (line.owner === self || !(line.qty > 0)) continue;
                if (price === null) price = line.price;
                if (line.price !== price) break;
                qty += line.qty;
            }
            if (price !== null) out[side][item] = { price, qty };
        }
    }
    return out;
}

// Rows a remembered town book keeps (ours: a few stacks of trade notes per
// town; the price memory itself holds 16).
const TOWN_BOOK_ROWS = 32;
// A remembered town book is forgotten after the trip there was refused for
// want of gain at this many visits in a row (ours).
const FORGET_REFUSALS = 3;

// What a main remembers of the town it visits, replaced at its next visit
// there: what trip reads of it (bids for the stock it carries or keeps,
// asks for what it wants), the asks first, then the bids by the adena they
// take (price x qty), at most TOWN_BOOK_ROWS rows. Returns { book, dropped
// (rows past the cap) }.
function remembered(book, { bids, asks }, self = -1) {
    const all = seen(book, { buy: bids, sell: asks }, self);
    const rows = [...Object.entries(all.sell).map(([item, row]) => ['sell', item, row, Infinity]),
        ...Object.entries(all.buy).map(([item, row]) => ['buy', item, row, row.price * row.qty]).sort((a, b) => b[3] - a[3] || a[1] - b[1])];
    const out = { buy: {}, sell: {} };
    for (const [side, item, row] of rows.slice(0, TOWN_BOOK_ROWS)) out[side][item] = row;
    return { book: out, dropped: Math.max(0, rows.length - TOWN_BOOK_ROWS) };
}

// The book a main expects of a hub it has no remembered book of (hubKnown,
// ours: which towns are trade towns is known to all, their prices are not):
// every item at its own first price for it (its last deal, else the game's
// first price, the rule that prices a thing never seen), any quantity.
function estimated(memory, firstPrice, items) {
    const out = { buy: {}, sell: {} };
    for (const item of items) {
        const price = known(memory, item) ?? firstPrice[item] ?? null;
        if (price !== null) out.buy[item] = out.sell[item] = { price, qty: Infinity };
    }
    return out;
}

// The remembered books after a visit: the town visited starts its count
// again (its book is replaced by the caller); a town whose trip was refused
// for want of gain (refused: trip's answer) counts one more refusal and is
// forgotten at FORGET_REFUSALS (its lines go, the empty book stays: the town
// was visited, so it is never estimated as unseen again); any other remembered town starts again.
// books: { town: book }, refusals: { town: count }. Returns { books, refusals, forgotten }.
function afterVisit({ books, refusals, refused, visited }) {
    const outBooks = {}, outRefusals = {}, forgotten = [], no = new Set(refused || []);
    for (const [town, book] of Object.entries(books || {})) {
        const count = town !== visited && no.has(town) ? (refusals?.[town] || 0) + 1 : 0;
        if (count >= FORGET_REFUSALS) { forgotten.push(town); outBooks[town] = { buy: {}, sell: {} }; continue; }
        outBooks[town] = book;
        if (count > 0) outRefusals[town] = count;
    }
    return { books: outBooks, refusals: outRefusals, forgotten };
}

module.exports = { remember, known, reach, bestCrystalBid, seen, remembered, estimated, afterVisit, MEMORY_ROWS, TOWN_BOOK_ROWS, FORGET_REFUSALS };
