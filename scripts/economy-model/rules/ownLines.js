'use strict';

// own_lines (economy design, account plane): the prices of a crafter twin's
// store lines. A twin's lines move only at its main's arrival in a town and
// at a fill of one of its lines (two seated twins would otherwise undercut
// each other to the floor in minutes); an applied craft batch opens the
// lines of its products. Every price comes from the price step
// (rules/priceStep) between the line's floor (rules/bounds.floor) and cap
// (rules/bounds.cap). Pure: lines, the workshop's wanted lines, bounds and
// the roll arrive as plain data; it returns new line objects.
const { hash, mulberry } = require('../../hunt-tables/common');
const { priceStep, PRICE_STEP } = require('./priceStep');

// The wakes at which own_lines runs; at any other reason the lines stay as they are.
const REASONS = Object.freeze(new Set(['main_arrived', 'fill', 'batch_applied']));
// The wakes that are a look of the owner.
const LOOKS = Object.freeze(new Set(['main_arrived', 'fill']));

// What a look does to a seller's line. 'every_look' (the design's text): an
// arrival, a filled or an undercut line each step every open line once.
// 'unsold_look' (ours, pending the maintainer): a line steps down only at a
// look where its stock stayed unsold since the previous look; a line that
// sold since then holds its price. A buyer's line steps at every look.
const stepsAtLook = (line, sellerLook) => !(sellerLook === 'unsold_look' && line.side === 'sell' && line.sold > 0);

// lines: the twin's open lines { id, side, item, qty, start, look, price,
// atBound, bound, floorBy, sold (units filled since its last look) }. view:
// { wanted: [{ side, item, qty, lineId, resume }] (the workshop's lines;
// lineId names the open line it continues, null for a new one: a batch's
// products start a new line with its step reset, the unsold remainder keeps
// its own: ours; resume { start, look }: a new line restarts one look back
// on a line of the good that sold out), prices: { 'side:item': { floor,
// floorBy, cap, capBy, rival, known, first } }, persona { looksToFloor,
// buyerStart }, sellerLook, roll: a seeded number of the wake, which also
// names a new line }. prices may carry bid (the best standing WTB or buy
// line it sees) and gear (a crafted piece). Returns { lines, closed: [{ line,
// why: 'withdrawn' | 'no_market' | 'own_route' | 'parked' | 'floor' (to the
// NPC) }] }.
function ownLines(lines, view, reason) {
    if (!REASONS.has(reason)) return { lines, closed: [] };
    const look = LOOKS.has(reason), out = [], closed = [], kept = new Set();
    for (const want of view.wanted || []) {
        const bounds = view.prices[`${want.side}:${want.item}`] || {};
        const held = want.lineId ? lines.find(line => line.id === want.lineId) : null;
        const roll = mulberry(hash(`${view.roll}:${want.side}:${want.item}:${want.lineId || 'new'}`))();
        const stepView = { ...bounds, persona: view.persona, roll };
        let priced;
        if (!held && want.resume) priced = priceStep({ side: want.side, start: want.resume.start }, { ...stepView, look: Math.max(0, want.resume.look - 1) });
        else if (!held) priced = priceStep({ side: want.side }, { ...stepView, look: 0 });
        // A standing WTB above a seller's ask restarts its line from the bid
        // (the only way up a seller's ask has besides a sold-out restart),
        // unless the line started at that bid already; and no step takes an
        // ask under a standing bid: it holds at the bid while the bid stands.
        // The workshop passes a bid only with sellerSeesBids (ours).
        else if (look && want.side === 'sell' && Number.isFinite(bounds.bid) && bounds.bid > held.price && bounds.bid !== held.start) priced = priceStep({ side: 'sell', start: bounds.bid }, { ...stepView, look: 0 });
        else if (look) {
            priced = priceStep(held, { ...stepView, look: held.look + (stepsAtLook(held, view.sellerLook) ? 1 : 0) });
            if (want.side === 'sell' && Number.isFinite(bounds.bid) && priced.price !== null && priced.price < bounds.bid) priced = { ...priced, price: Math.ceil(bounds.bid), bound: null, atBound: 0 };
        } else priced = held;
        const line = { ...priced, id: held ? held.id : `${view.roll}:${want.side}:${want.item}`, side: want.side, item: want.item, qty: want.qty,
            floorBy: priced.bound === 'floor' ? bounds.floorBy ?? null : null, sold: held && !look ? held.sold || 0 : 0 };
        if (held) kept.add(held.id);
        if (priced.noMarket) closed.push({ line, why: 'no_market' });
        else if (priced.close) closed.push({ line, why: priced.close });
        // An ask at its market floor for two looks goes to the NPC (liquid
        // goods; a crafted piece stays shelved, and an ask held at its input
        // cost stays parked there).
        else if (want.side === 'sell' && !bounds.gear && priced.bound === 'floor' && line.floorBy !== 'cost' && priced.atBound >= PRICE_STEP.looksAtCapToClose) closed.push({ line, why: 'floor' });
        else out.push(line);
    }
    for (const line of lines) if (!kept.has(line.id)) closed.push({ line, why: 'withdrawn' });
    return { lines: out, closed };
}

module.exports = { ownLines, REASONS, LOOKS };
