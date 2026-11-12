'use strict';

// What an account knows of prices (economy design, ours): its own deals (a
// price memory of 16 rows of { item, enchant, price }), the book of the town
// its main stands in and the book of its twin's town (a player with two
// windows). No other town's book, no count of other bots' plans. Pure: the
// memory and the books arrive as plain data; remember returns a new memory.
// Read by the workshop and its lines, and by a main's visit.

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

module.exports = { remember, known, reach, bestCrystalBid, MEMORY_ROWS };
