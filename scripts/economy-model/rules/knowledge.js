'use strict';

// What an account knows of prices (economy design, ours): its own deals (a
// price memory of 16 rows of { item, enchant, price }), the book of the town
// its main stands in, the book of its twin's town (a player with two
// windows), and which towns trade a lot (a fact of the game, as a wiki;
// their prices are not). No count of other bots' plans. Pure: the memory
// and the books arrive as plain data; remember returns a new memory. Read
// by the workshop and its lines, and by a main's visit.

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
// price } (null without one), bidUnits: the units buy lines and WTBs take
// at that price.
function reach(place, books, item, self = -1, ads = null) {
    let rivalSell = null, bestBid = null, bidUnits = 0;
    const read = book => {
        for (const line of book?.sell?.[item] || []) if (line.owner !== self && line.qty > 0 && (rivalSell === null || line.price < rivalSell)) rivalSell = line.price;
        for (const line of book?.buy?.[item] || []) {
            if (line.owner === self || !(line.qty > 0)) continue;
            if (bestBid === null || line.price > bestBid) { bestBid = line.price; bidUnits = line.qty; } else if (line.price === bestBid) bidUnits += line.qty;
        }
    };
    for (const town of reachTowns(place)) read(books[town]);
    if (ads) read(ads);
    return { rivalSell, bestBid, bidUnits };
}

// The best crystallizer bid per crystal of a grade in reach (null without one).
function bestCrystalBid(place, books, grade, self = -1) {
    let best = null;
    for (const town of reachTowns(place)) {
        for (const bid of books[town]?.bids?.[grade] || []) if (bid.owner !== self && bid.qty > 0 && (best === null || bid.price > best)) best = bid.price;
    }
    return best;
}

// The game's trade towns of a lot (MarketTownPolicy.targetTownForItems, a
// fact every account knows): anything of C and above in the lot goes to
// trade.higher, else anything of D to one of the policy's D markets
// (trade.d: the account picks among them by its own rule), else a no-grade
// lot to the market nearest its spot (trade.none[spotId]). trade: the
// snapshot's tradeTowns ({ grade: { item: grade } }); items: item ids (none:
// a no-grade lot). andAbove: a buyer of the lot's grade also reaches the
// towns of every higher grade (a D lot: the D markets and trade.higher).
// Returns the candidate towns, [] without trade data.
function tradeTowns(trade, { items, spotId, andAbove = false }) {
    if (!trade) return [];
    const grades = items.map(id => trade.grade[id] || 'none');
    if (grades.some(grade => grade !== 'none' && grade !== 'd')) return [trade.higher];
    if (grades.includes('d')) return andAbove ? [...trade.d, trade.higher] : [...trade.d];
    return trade.none[spotId] ? [trade.none[spotId]] : [];
}

module.exports = { remember, known, reach, bestCrystalBid, tradeTowns, MEMORY_ROWS };
