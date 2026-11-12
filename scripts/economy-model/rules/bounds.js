'use strict';

// The bounds of a price in the economy design (ours, no C4 source): the
// seller's floor, the buyer's cap and an item's first price. Pure: every
// price, bid and worth arrives as plain data, already filtered to what the
// owner knows (its town's book, its twin's town's book, its own memory).
// A cap may fall under a floor: then no deal is possible, and the caller
// counts it; neither bound is moved to meet the other.

function value(price) {
    return price !== null && price !== undefined && Number.isFinite(Number(price)) ? Number(price) : null;
}

// The least a seller takes: the NPC's buy price or the best crystallizer bid
// in reach (the town visited and the twin's town), whichever is higher. Only
// Artisans and Warsmiths crystallize, so the bids are theirs.
function floor({ npcBuy = 0, crystallizerBids = [] }) {
    return Math.max(value(npcBuy) || 0, ...crystallizerBids.map(bid => value(bid) || 0));
}

// The most a buyer pays: its worth (bounds the want), its own route's cost
// and the NPC's sell price where an NPC sells the item, whichever is lowest.
// by names the binding one: at a cap set by a route the buyer takes that
// route; at a cap set by its worth the want is parked.
function cap({ worth, routeCost = null, npcSell = null }) {
    let out = { cap: Math.max(0, value(worth) || 0), by: 'worth' };
    if (value(routeCost) !== null && value(routeCost) < out.cap) out = { cap: value(routeCost), by: 'route' };
    if (value(npcSell) !== null && value(npcSell) < out.cap) out = { cap: value(npcSell), by: 'npc' };
    return out;
}

// The price of an item nobody has seen traded: its cheapest supplying route
// (farm hours times the band's hour, the craft cost, the NPC's sell price).
// route null when none supplies it.
function firstPrice({ farmHours = null, bandHour = null, craftCost = null, npcSell = null }) {
    const routes = [
        ['farm', value(farmHours) !== null && value(bandHour) !== null ? value(farmHours) * value(bandHour) : null],
        ['craft', value(craftCost)],
        ['npc', value(npcSell)]
    ].filter(([, price]) => price !== null);
    if (!routes.length) return { price: null, route: null };
    const [route, price] = routes.reduce((best, row) => row[1] < best[1] ? row : best);
    return { price, route };
}

module.exports = { floor, cap, firstPrice };
