'use strict';

// The town books of the economy model's design mode: per town the open sell
// lines (cheapest first), buy lines (dearest first) and crystallizer bids
// (per grade, dearest first) of the crafter twins seated there; a second
// instance holds the mains' WTS and WTB ads under one name (global until
// the regional chat). Read by the
// rules as plain data ({ town: { sell: { item: [entry] }, buy, bids } }, an
// entry { owner, id, price, qty }); written only by the design plane's commit of an
// account's decision, which replaces all the account's entries at once.
// Claims are first come: the event that reads a line first takes it.

function create() {
    return { towns: {}, placed: new Map() };
}

function remove(books, owner) {
    for (const { town, side, key, entry } of books.placed.get(owner) || []) {
        const rows = books.towns[town][side][key], at = rows.indexOf(entry);
        if (at >= 0) rows.splice(at, 1);
        if (!rows.length) delete books.towns[town][side][key];
    }
    books.placed.delete(owner);
}

// The account's lines and bids in its twin's town, replacing what it had.
function place(books, owner, town, lines, bids) {
    remove(books, owner);
    const placed = [], book = books.towns[town] ||= { sell: {}, buy: {}, bids: {} };
    const add = (side, key, line) => {
        if (!(line.qty > 0)) return;
        // An ad keeps the town it was posted in, a WTS its floor.
        const entry = { owner, id: line.id, price: line.price, qty: line.qty, town: line.town || town, floor: line.floor ?? null }, rows = book[side][key] ||= [];
        rows.push(entry);
        rows.sort(side === 'sell' ? (a, b) => a.price - b.price || a.owner - b.owner : (a, b) => b.price - a.price || a.owner - b.owner);
        placed.push({ town, side, key, entry });
    };
    for (const line of lines) add(line.side, line.item, line);
    for (const bid of bids) add('bids', bid.item, bid);
    books.placed.set(owner, placed);
}

const rowsOf = (books, town, side, key) => books.towns[town]?.[side]?.[key] || [];

module.exports = { create, place, remove, rowsOf };
