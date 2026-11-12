'use strict';

// The price step of the economy design: the price of one store line at one of
// its owner's looks. A look is a situation its owner raises (an arrival in
// town, a filled or an undercut line); between looks the price holds. The
// seller steps down to its floor and the buyer up to its cap, each look by a
// fixed share of the gap at the start, so the seller reaches the floor at the
// persona's look (5th, 3rd or 2nd) and the buyer the cap at the 3rd. Pure:
// bounds, persona and the roll arrive as arguments (the caller seeds the
// roll); it returns a new line. Our design, no C4 source: C4 players price by
// hand.

// The section's start values (ours).
const PRICE_STEP = Object.freeze({
    // A seller who sees a rival line starts this share under it, a seeded pick.
    undercut: Object.freeze({ min: 0.01, max: 0.05 }),
    buyerLooksToCap: 3,
    // Looks a buy line holds at the cap before it closes: the want goes to
    // its own route (one that sets the cap) or is parked (the cap is its worth).
    looksAtCapToClose: 2
});

function finite(value) {
    return value !== null && value !== undefined && Number.isFinite(Number(value));
}

// The price a new line starts at. Seller: under the cheapest rival line it
// sees, else its known price, else the item's first price; never under the
// floor. With none of the three it throws: the caller supplies the first
// price (an item never seen starts at its cheapest supplying route,
// bounds.firstPrice). Buyer: its known price, else the first price, held to
// the cap, times the persona's start factor; with neither it throws.
function startPrice(side, { floor, cap, rival = null, known = null, first = null, persona, roll = 0 }) {
    if (side === 'sell') {
        const { min, max } = PRICE_STEP.undercut;
        if (!finite(rival) && !finite(known) && !finite(first)) throw new Error('a seller needs a rival line, a known price or the first price');
        const seen = finite(rival) ? Number(rival) * (1 - (min + (max - min) * roll)) : finite(known) ? Number(known) : Number(first);
        return Math.max(floor, seen);
    }
    if (!finite(known) && !finite(first)) throw new Error('a buyer needs a known price or the first price');
    return Math.min(finite(known) ? Number(known) : Number(first), cap) * persona.buyerStart;
}

// line: { side: 'sell' | 'buy', start, atBound } or { side } before its first
// look (look 0 lists it). view: { look, floor (the seller's; a buyer's view
// may carry it too), cap and capBy (the buyer's, bounds.cap; a seller's view
// may carry the cap too), rival, known, first (look 0), persona
// { looksToFloor >= 1, buyerStart }, roll in [0, 1) }. Prices are whole
// adena: a seller's step rounds up and a buyer's down, so neither crosses
// its bound. Returns { side, start, look, price, bound: 'floor' | 'cap' |
// null, atBound: looks in a row at it, close: null | 'own_route' | 'parked',
// noMarket }. noMarket: no whole price lies between the floor and the cap
// (the floor is above the cap): no price, the caller counts it.
function priceStep(line, view) {
    const look = Math.max(0, Math.floor(Number(view.look) || 0));
    const side = line.side;
    const floor = finite(view.floor) ? Number(view.floor) : 0, cap = finite(view.cap) ? Number(view.cap) : Infinity;
    if (Math.ceil(floor) > Math.floor(cap)) return { side, start: null, look, price: null, bound: null, atBound: 0, close: null, noMarket: true };
    if (side === 'sell' && !(Number(view.persona?.looksToFloor) >= 1)) throw new Error(`looksToFloor ${view.persona?.looksToFloor} is under 1`);
    if (side === 'buy' && cap === Infinity) throw new Error('a buyer needs its cap');
    const start = look === 0 || !finite(line.start) ? startPrice(side, { ...view, floor, cap }) : Number(line.start);
    let price, bound;
    if (side === 'sell') {
        const share = Math.min(1, look / view.persona.looksToFloor);
        price = Math.ceil(Math.max(floor, start - (start - floor) * share));
        bound = price <= Math.ceil(floor) ? 'floor' : null;
    } else {
        const share = Math.min(1, look / PRICE_STEP.buyerLooksToCap);
        price = Math.floor(Math.min(cap, start + (cap - start) * share));
        bound = price >= Math.floor(cap) ? 'cap' : null;
    }
    const atBound = bound ? (look === 0 ? 0 : Number(line.atBound) || 0) + 1 : 0;
    const close = bound === 'cap' && atBound >= PRICE_STEP.looksAtCapToClose
        ? (view.capBy === 'worth' ? 'parked' : 'own_route') : null;
    return { side, start, look, price, bound, atBound, close, noMarket: false };
}

module.exports = { priceStep, PRICE_STEP };
