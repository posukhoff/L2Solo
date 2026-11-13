'use strict';

// The economy design's market of mains on inline fixtures: path spends the
// refill reserve before its pieces and an unarmed main's weapon before the
// reserve; acquire takes the cheapest of the routes, its hours charged at
// what the main gives up; trip goes at the earliest of its situations, takes
// its shot situations from its stock and use alone and reads the sellers of
// the shot only while it is low or out; visit turns a
// want with no line into a WTB, gives one line to its first claimer, reads
// every line it reaches and keeps every price between its floor and cap; a
// WTB two looks at a worth cap is parked, at a route cap takes the route;
// occupation moves only at its situations and ranks by known prices and
// open WTBs; the hunt cycle's worth is bounded where the hour without the
// piece is near zero.
const assert = require('node:assert/strict');
const { path } = require('../scripts/economy-model/rules/path');
const { acquire } = require('../scripts/economy-model/rules/acquire');
const { trip, goalOf, shotTown } = require('../scripts/economy-model/rules/trip');
const { visit } = require('../scripts/economy-model/rules/visit');
const { occupation, stayHours } = require('../scripts/economy-model/rules/occupation');
const { refillHours } = require('../scripts/economy-model/rules/path');
const Knowledge = require('../scripts/economy-model/rules/knowledge');
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} against ${expected}`);
const Worth = require('../scripts/economy-model/rules/worth');
const Bounds = require('../scripts/economy-model/rules/bounds');

// path: the money queue.
{
    const slot = (at, selfId, worn) => ({ slot: at, group: String(at), worn, held: false, candidates: worn === selfId ? [] : [{ selfId, slot: at }] });
    const view = { weapons: { 10: true }, routes: { 10: { route: 'npc', cost: 1000 }, 20: { route: 'npc', cost: 100 }, 30: { route: 'buy', cost: 500 } },
        worth: { 10: 2000, 20: 1000, 30: 100 }, reserve: 300 };
    const armed = path({ weapon: 99 }, { ...view, kit: [slot(7, 10, 99), slot(10, 20, 0), slot(6, 30, 30)] });
    assert.deepEqual(armed.order.map(row => row.kind === 'reserve' ? 'reserve' : row.selfId), ['reserve', 20, 10], 'the reserve first, then worth per adena (20: 10, 10: 2); a worn piece left out');
    const unarmed = path({ weapon: 0 }, { ...view, kit: [slot(7, 10, 0), slot(10, 20, 0), slot(6, 30, 0)] });
    assert.deepEqual(unarmed.order.map(row => row.kind === 'reserve' ? 'reserve' : row.selfId), [10, 'reserve', 20, 30], 'the unarmed main\'s weapon before the reserve');
    assert.equal(unarmed.reserve, 300);
}

// acquire: the cheapest route; the own twin's wait is charged at the piece's use
// (100 an hour) under the opportunity hour and at the whole own hour under the literal one.
{
    const view = { cap: 5000, ownHour: 1000, hourCost: 'opportunity', useHour: 100, lines: [{ price: 6000, kind: 'line', where: 'Giran' }],
        npc: [{ town: 'Giran', price: 1500, fare: 0 }], twin: { recipeId: 7, cost: 1000, hours: 2 },
        exchange: { town: 'Giran', fare: 0, crystals: [{ selfId: 1458, amount: 10, perCrystal: 160, own: 0, lines: [{ id: 'd', price: 160, qty: 10 }] }] } };
    const opportunity = acquire({ selfId: 1 }, view);
    assert.equal(opportunity.route, 'twin', 'the inputs 1000 and two hours of its use: 1200');
    assert.equal(opportunity.cost, 1200);
    assert.deepEqual(opportunity.routes.map(row => row.route), ['twin', 'npc', 'exchange'], 'the line above the cap is no route');
    assert.equal(opportunity.routeCost, 1200);
    assert.equal(acquire({ selfId: 1 }, { ...view, hourCost: 'literal' }).route, 'npc', 'the design\'s text charges the whole own hour: the twin costs 3000');
    const bought = acquire({ selfId: 1 }, { ...view, lines: [{ price: 150, kind: 'ad', where: 'ad' }] });
    assert.equal(bought.route, 'buy');
    assert.equal(bought.routeCost, 1200, 'the cap\'s own route is the cheapest that is not a player\'s line');
    assert.equal(acquire({ selfId: 1 }, { ...view, stalled: ['twin'] }).route, 'npc', 'a stalled route is not offered');
    assert.equal(acquire({ selfId: 1 }, { cap: 1, ownHour: 1, lines: [], npc: [] }), null);
}

// trip: the earliest situation. A shot situation comes from the main's
// stock and its use alone: trip names it to be read at its hour, and there a
// seller sends it.
{
    const here = { ownHeld: false, npcAsk: 10, money: 1000, towns: [] };
    const base = { now: 10, since: 10, huntShare: 0.5, toHours: 0.02, backHours: 0.01, town: 'Giran', stockLowHours: 1 / 6, loadShare: 2 / 3, ownHour: 1000,
        shots: { held: 600, perHour: 300 }, shotTowns: here, bag: { slots: 80, used: 10, weight: 0, maxLoad: 1000, items: [{ rate: 10, weight: 10, stack: true, held: false }] },
        goal: { need: 5000, have: 1000, perHour: 1000, fresh: false } };
    const first = trip({}, base), lowAt = 10 + (600 - 50) / 300 / 0.5;
    assert.deepEqual([first.reason, first.read], ['stock_low:shots', true], '600 shots at 300 an hour run low at 1.83 hunting hours: read then');
    assert.ok(Math.abs(first.at - lowAt) < 1e-9, `wall hours over the hunting share: ${first.at}`);
    const then = trip({}, { ...base, now: first.at });
    assert.equal(then.reason, 'stock_low:shots');
    assert.ok(Math.abs(then.at - (lowAt + 0.02)) < 1e-9, `read at its hour with a seller where it stands: it goes, plus the walk: ${then.at}`);
    const loaded = trip({}, { ...base, bag: { ...base.bag, items: [{ rate: 100, weight: 10, stack: true, held: false }] } });
    assert.equal(loaded.reason, 'bag_full', '1000 load an hour reaches 2/3 of 1000 in 0.67 hunting hours');
    const rich = trip({}, { ...base, goal: { ...base.goal, have: 5000, fresh: true } });
    assert.equal(rich.reason, 'goal_affordable', 'a new goal it can pay sends it now');
    assert.deepEqual([rich.at, rich.away], [10.02, 0.02], 'it leaves now and is away its trip into town (its way back is the visit\'s)');
    const out = trip({}, { ...base, shots: { held: 0, perHour: 300 }, goal: null, bag: null });
    assert.deepEqual([out.reason, out.at], ['shots_out', 10.02], 'out of shots with a seller where it stands: it goes now');
    const offer = trip({}, { ...base, goal: null, bag: null, event: 'offer_posted', deal: { gain: 500 } });
    assert.equal(offer.reason, 'offer_posted', 'a line in reach worth more than the walk sends it now');
    const dealAt = gain => trip({}, { ...base, shots: null, goal: null, bag: null, event: 'offer_posted', deal: { gain } }).at;
    assert.deepEqual([dealAt(25), dealAt(35)], [null, 10.02], 'a gain under the trip there and back (0.02 + 0.01 h) x 1000 waits for its next visit, one over it goes');
}

// A shot restock goes where a seller of the shot stands now: where the main
// stands when its own twin holds the shot or its NPC sells it at its worth;
// else, of the trade towns of the shot's grade (and above) holding a line at
// or under its worth whose fare there and back it can pay, the one it stands
// in, else the nearest by fare. With no seller standing at a shot situation
// there is no trip: the next one is read at its hour. Asked at any event
// while low or out, it reads its sellers and goes to one that stands.
{
    const towns = [{ town: 'Gludio', fare: 2000, ask: null, cap: 20 }, { town: 'Dion', fare: 1500, ask: null, cap: 20 }, { town: 'Giran', fare: 3000, ask: 15, cap: 20 }];
    const heine = { here: 'Heine', ownHeld: false, npcAsk: null, money: 100000, towns };
    assert.equal(shotTown(heine), 'Giran', 'the cheap line stands only in the farther town: it goes there');
    assert.equal(shotTown({ ...heine, towns: towns.map(row => ({ ...row, ask: 15 })) }), 'Dion', 'lines in all three: the least fare');
    assert.equal(shotTown({ ...heine, towns: towns.map(row => ({ ...row, ask: row.town === 'Giran' ? 25 : null })) }), null, 'a line over its worth is no seller');
    assert.equal(shotTown({ ...heine, money: 5000 }), null, 'a fare there and back it cannot pay is no seller');
    assert.equal(shotTown({ ...heine, here: 'Giran', towns: [...towns.slice(0, 2), { town: 'Giran', fare: 0, ask: 15, cap: 20 }] }), 'Giran', 'standing in the town of the line: it stays');
    assert.equal(shotTown({ ...heine, npcAsk: 10 }), 'Heine', 'the NPC here sells it at its worth: no fare');
    assert.equal(shotTown({ ...heine, ownHeld: true, towns: [] }), 'Heine', 'its own twin holds it: where it stands');
    assert.equal(shotTown({ ...heine, towns: [] }), null, 'no town reached: no seller');
    const base = { now: 10, since: 10, huntShare: 0.5, toHours: 0.02, backHours: 0.01, town: 'Heine', stockLowHours: 1 / 6, loadShare: 2 / 3, ownHour: 1000,
        shots: { held: 600, perHour: 300 }, bag: null, goal: null, shotTowns: { ownHeld: false, npcAsk: null, money: 100000, towns } };
    const lowAt = 10 + (600 - 50) / 300 / 0.5, low = trip({}, { ...base, now: lowAt });
    assert.deepEqual([low.reason, low.town], ['stock_low:shots', 'Giran'], 'a main low on shots goes to the only town holding a line at its worth');
    assert.ok(Math.abs(low.at - (lowAt + 0.02)) < 1e-9, `it arrives in its own town after its trip there (the hop on to Giran is the visit's): ${low.at}`);
    assert.equal(low.away, 0.02, 'away before the arrival: its trip into its own town only');
    assert.equal(trip({}, { ...base, shots: { held: 0, perHour: 300 } }).town, 'Giran', 'shots_out too');
    const bag = { slots: 80, used: 10, weight: 0, maxLoad: 1000, items: [{ rate: 100, weight: 10, stack: true, held: false }] };
    const full = trip({}, { ...base, bag });
    assert.deepEqual([full.reason, full.town], ['bag_full', 'Heine'], 'any other reason keeps its town');
    assert.equal(trip({}, { ...base, now: lowAt, shotTowns: { ...base.shotTowns, npcAsk: 10 } }).town, 'Heine');
    const bare = { ...base, shotTowns: { ...base.shotTowns, towns: towns.map(row => ({ ...row, ask: null })) } };
    const ahead = trip({}, bare);
    assert.deepEqual([ahead.reason, ahead.read], ['stock_low:shots', true], 'no line anywhere now: its stock_low is still read at its hour');
    const unsold = trip({}, { ...bare, now: lowAt });
    assert.deepEqual([unsold.reason, unsold.read, unsold.at], ['shots_out', true, 14], 'no line at its stock_low: no trip, its shots_out read next');
    assert.equal(trip({}, { ...bare, now: 12, shots: { held: 0, perHour: 300 } }).at, null, 'out of shots, read again with still no line: none planned');
    // Low (held under its mark of 50 since 10), with no situation of its own
    // until it runs out: asked at any event, it reads its sellers.
    const lowNow = { ...base, now: 10.1, shots: { held: 40, perHour: 300 } };
    for (const event of ['level_up', 'visit', 'offer_posted']) {
        const asked = trip({}, { ...lowNow, event });
        assert.deepEqual([asked.reason, asked.town, asked.read], ['stock_low:shots', 'Giran', undefined], `low, asked at ${event}: the line in Giran is read and it goes`);
    }
    const lowBare = trip({}, { ...bare, now: 10.1, shots: { held: 40, perHour: 300 }, event: 'level_up' });
    assert.deepEqual([lowBare.reason, lowBare.read], ['shots_out', true], 'low with no seller: its shots_out read next');
    assert.equal(trip({}, { ...base, event: 'offer_posted' }).read, true, 'with shots to spare a posted line sends it nowhere');
}

// The game's trade towns of a lot (MarketTownPolicy as data): anything of
// C and above in Giran, else anything of D in either D market (the account
// weighs them), else the market nearest the spot.
{
    const trade = { grade: { 1463: 'd', 71: 'c' }, none: { s1: 'Gludin' }, d: ['Gludio', 'Dion'], higher: 'Giran' };
    assert.deepEqual(Knowledge.tradeTowns(trade, { items: [200, 1463, 71], spotId: 's1' }), ['Giran']);
    assert.deepEqual(Knowledge.tradeTowns(trade, { items: [200, 1463], spotId: 's1' }), ['Gludio', 'Dion'], 'both D markets, no split by the bot\'s id');
    assert.deepEqual(Knowledge.tradeTowns(trade, { items: [200], spotId: 's1' }), ['Gludin']);
    assert.deepEqual(Knowledge.tradeTowns(trade, { items: [1463], spotId: 's1', andAbove: true }), ['Gludio', 'Dion', 'Giran'], 'a D lot also reaches the town of the grades above');
    assert.deepEqual(Knowledge.tradeTowns(trade, { items: [71], spotId: 's1', andAbove: true }), ['Giran']);
    assert.deepEqual(Knowledge.tradeTowns(trade, { items: [200], spotId: 's1', andAbove: true }), ['Gludin'], 'a no-grade lot has no grade above');
    assert.deepEqual(Knowledge.tradeTowns(undefined, { items: [200], spotId: 's1' }), [], 'no trade data: no hub');
}

// The refill (the kit rule's): 'outing' carries shots for outingHours of
// hunting, so the next outing (ended at stock_low:shots) is as long whatever
// the last one was; 'last_outing' (the model before) carries the last
// outing's hours, so an outing's length copies itself (at least an hour).
{
    const nextOuting = (refill, lastOuting) => {
        const held = Math.ceil(300 * refillHours({ refill, outingHours: 2, minHours: 1, lastOuting }));
        const out = trip({}, { now: 0, since: 0, huntShare: 1, toHours: 0, backHours: 0, town: 'Gludio', stockLowHours: 1 / 6, loadShare: 2 / 3, ownHour: 0,
            shots: { held, perHour: 300 }, shotTowns: { ownHeld: false, npcAsk: 10, money: 0, towns: [] }, bag: null, goal: null });
        assert.deepEqual([out.reason, out.read], ['stock_low:shots', true]);
        return out.at;
    };
    near(nextOuting('outing', 0.5), 2 - 1 / 6, 'after a half-hour outing');
    near(nextOuting('outing', 5), 2 - 1 / 6, 'after a five-hour outing');
    near(nextOuting('last_outing', 5), 5 - 1 / 6, 'the model before: five hours again');
    near(nextOuting('last_outing', 0.5), 1 - 1 / 6, 'at least an hour');
}

// visit: lines, first come, WTBs and bounds.
const items = {
    100: { kind: 'Weapon.Sword', grade: 'D', npcBuy: 500, crystals: 10 },
    101: { kind: 'Armor.Body', grade: 'D', npcBuy: 300, crystals: 5 },
    200: { kind: 'Other.Material', grade: 'NONE', npcBuy: 5 },
    300: { kind: 'Other.Shot', grade: 'NONE', npcBuy: 1 }
};
const mainOf = (patch = {}) => ({ index: 0, money: 20000, bag: {}, shots: {}, kit: { 7: 0 }, weapon: 0, ads: { wts: [], wtb: [] }, wants: {}, incoming: {}, ...patch });
const viewOf = (patch = {}) => ({
    now: 1, town: 'Giran', adId: 'a1', persona: { looksToFloor: 3, buyerStart: 0.8 }, roll: 7, items,
    book: { sell: {}, buy: {}, bids: {} }, npcSell: {}, known: {}, firstPrice: { 100: 4000, 300: 10 }, deposit: {}, depositFee: 30, twin: null, firing: 300,
    reserve: null, fares: {}, waitVisits: 2,
    pieces: { 100: { selfId: 100, slot: 7, grade: 'd', weapon: true, cap: 5000, capBy: 'npc', routes: [{ route: 'npc', adena: 5000, cost: 5000, where: 'Giran' }] } },
    order: [{ kind: 'piece', selfId: 100, slot: 7 }, { kind: 'reserve' }],
    ...patch
});
{
    // The shots its worn weapon fires (fires) stay in the bag whatever kind it
    // buys this visit; a shot of another grade goes to the NPC (3 an item).
    const shotItems = { ...items, 301: { kind: 'Other.Shot', grade: 'NONE', npcBuy: 3 }, 302: { kind: 'Other.Shot', grade: 'NONE', npcBuy: 2 } };
    const held = mainOf({ bag: { 302: 100 }, shots: { 302: 400, 301: 40 } });
    const out = visit(held, viewOf({ items: shotItems, fires: [300, 302], firing: 300, order: [], pieces: {} }));
    assert.deepEqual([out.main.bag[302], out.main.shots[302], out.main.shots[301]], [100, 400, undefined], 'the fireable shots stay, the other grade is sold');
    assert.equal(out.flows.npcSales, 120, '40 x 3 for the unfireable shots only');
}
{
    // A want with no line becomes a WTB, priced under its cap.
    const out = visit(mainOf({ money: 4000 }), viewOf());
    assert.equal(out.main.ads.wtb.length, 1, 'a WTB for the sword');
    const ad = out.main.ads.wtb[0];
    assert.equal(ad.item, 100);
    assert.ok(ad.price >= 0 && ad.price <= 5000, `inside [0, cap]: ${ad.price}`);
    assert.equal(ad.price, Math.floor(4000 * 0.8), 'buyer start: min(first price, cap) x 0.8');
    assert.equal(out.main.wants[100].state, 'wtb');
    // A line in reach at or under the cap is bought, the cheapest first.
    const lines = [{ owner: 5, id: 'L5', price: 4500, qty: 1, kind: 'line' }, { owner: 6, id: 'L6', price: 4800, qty: 1, kind: 'ad' }];
    const bought = visit(mainOf(), viewOf({ book: { sell: { 100: lines }, buy: {}, bids: {} } }));
    assert.deepEqual(bought.claims.map(row => [row.kind, row.owner, row.price]), [['buy_line', 5, 4500]]);
    assert.equal(bought.main.kit[7], 100, 'worn');
    assert.deepEqual(bought.obtained, [{ selfId: 100, grade: 'd', route: 'buy' }]);
    // Two buyers, one line: the first claimer takes it; the second reads the
    // next line of the book (every line is read), and with none left posts a WTB.
    const book = { sell: { 100: [lines[0]] }, buy: {}, bids: {} };
    const first = visit(mainOf(), viewOf({ book }));
    const after = { sell: { 100: [{ ...lines[0], qty: lines[0].qty - first.claims[0].units }] }, buy: {}, bids: {} };
    const second = visit(mainOf({ index: 1, money: 4000 }), viewOf({ book: after }));
    assert.equal(first.claims[0].owner, 5);
    assert.equal(second.claims.length, 0, 'the line went to the first claimer');
    assert.equal(second.main.ads.wtb.length, 1);
    // A piece on its own twin's shelf comes through the account warehouse first.
    const own = visit(mainOf(), viewOf({ book: { sell: { 100: lines }, buy: {}, bids: {} }, pieces: { 100: { ...viewOf().pieces[100], own: 1 } } }));
    assert.deepEqual([own.claims.map(row => row.kind), own.obtained[0].route, own.main.money], [['own_stock'], 'twin', 20000]);
    const deeper = visit(mainOf({ money: 4900 }), viewOf({ book: { sell: { 100: [{ ...lines[0], qty: 0 }, lines[1]] }, buy: {}, bids: {} } }));
    assert.deepEqual(deeper.claims.map(row => [row.kind, row.owner]), [['buy_wts', 6]], 'the empty first line is passed for the next one: a hunting main\'s ad');
}
{
    // A paired item (two rings) is wanted twice: one piece a slot, worn in both with the money for two.
    const ring = { selfId: 102, slot: 4, grade: 'd', weapon: false, cap: 900, capBy: 'npc', routes: [{ route: 'npc', adena: 800, cost: 800, where: 'Giran' }] };
    const pair = { pieces: { 102: ring }, order: [{ kind: 'piece', selfId: 102, slot: 4 }, { kind: 'piece', selfId: 102, slot: 5 }], firstPrice: { 102: 800 } };
    const rich = visit(mainOf({ money: 5000, kit: { 4: 0, 5: 0 } }), viewOf(pair));
    assert.deepEqual([rich.main.kit[4], rich.main.kit[5], rich.main.money], [102, 102, 3400], 'two rings worn for two prices');
    const one = visit(mainOf({ money: 1000, kit: { 4: 0, 5: 0 } }), viewOf(pair));
    assert.deepEqual([one.main.kit[4], one.main.kit[5] || 0, Object.keys(one.main.wants)], [102, 0, ['102']], 'money for one: one worn, one open want');
    // One ring on its own twin's shelf is taken once: worn in one slot, the other bought, no unit from nothing.
    const shelf = visit(mainOf({ money: 5000, kit: { 4: 0, 5: 0 } }), viewOf({ ...pair, pieces: { 102: { ...ring, own: 1 } } }));
    assert.deepEqual([shelf.claims.filter(row => row.kind === 'own_stock').length, shelf.main.kit[4], shelf.main.kit[5], shelf.main.money], [1, 102, 102, 4200],
        'one unit from the shelf, the second ring for its price');
    // No seller: one WTB, stepped once a visit, not once a slot.
    const wtbPair = { ...pair, pieces: { 102: { ...ring, routes: [] } } };
    let main = mainOf({ money: 100, kit: { 4: 0, 5: 0 } });
    const looks = [];
    for (let visits = 0; visits < 3; visits++) { main = visit(main, viewOf(wtbPair)).main; looks.push([main.ads.wtb.length, main.ads.wtb[0].look]); }
    assert.deepEqual(looks, [[1, 0], [1, 1], [1, 2]], 'one WTB, one look a visit');
}
{
    // A WTB steps up to its cap and holds two looks there; then a route cap
    // takes the route, a worth cap parks the want.
    let main = mainOf({ money: 4000 }), seen = [];
    for (let look = 0; look < 6 && main.ads.wtb.length + (look === 0 ? 1 : 0); look++) {
        const out = visit(look === 4 ? { ...main, money: 20000 } : main, viewOf());
        main = out.main;
        if (main.ads.wtb[0]) seen.push(main.ads.wtb[0].price);
        if (main.kit[7] === 100) { seen.push('npc'); break; }
    }
    assert.deepEqual(seen, [3200, 3800, 4400, 5000, 'npc'], 'cap 5000 by the NPC: up a third of the gap each look, then the NPC at the second look at the cap');
    assert.ok(seen.slice(0, -1).every(price => price <= 5000));
    main = mainOf();
    const worthCapped = viewOf({ pieces: { 100: { ...viewOf().pieces[100], capBy: 'worth', cap: 3000 } } });
    for (let look = 0; look < 5; look++) main = visit(main, worthCapped).main;
    assert.equal(main.wants[100].state, 'parked', 'a worth cap parks the want');
    assert.equal(main.kit[7], 0, 'and buys nothing');
    assert.equal(main.ads.wtb.length, 0, 'its WTB closed');
    const parkedAgain = visit(main, worthCapped);
    assert.equal(parkedAgain.main.ads.wtb.length, 0, 'a parked want posts nothing until grade_changed or an offer');
}
{
    // Gear it does not wear: a standing WTB at or above its floor first; else
    // its own WTS, never under its floor, which at the floor for two looks
    // goes to the floor's channel (the NPC here).
    const wtb = [{ owner: 9, id: 'W9', price: 900, qty: 1, kind: 'ad' }];
    const sold = visit(mainOf({ kit: { 7: 100 }, weapon: 100, bag: { 101: 1 } }), viewOf({ book: { sell: {}, buy: { 101: wtb }, bids: {} }, order: [] }));
    assert.deepEqual(sold.claims.map(row => [row.kind, row.owner, row.price, row.adena]), [['sell_wtb', 9, 900, 900]], 'met by its buyer');
    assert.deepEqual([sold.main.money, sold.main.bag[101]], [20000, undefined], 'the piece goes to the meeting, paid there (the rule reads no other account\'s money)');
    let main = mainOf({ kit: { 7: 100 }, weapon: 100, bag: { 101: 1 } }), prices = [];
    const lone = viewOf({ order: [], firstPrice: { 101: 2000 } });
    for (let look = 0; look < 6; look++) {
        const out = visit(main, lone);
        main = out.main;
        if (main.ads.wts[0]) prices.push(main.ads.wts[0].price); else { prices.push(out.flows.npcSales); break; }
    }
    assert.deepEqual(prices, [2000, 1434, 867, 300, 300], 'from the first price down to the 300 floor in three looks (persona), then to the NPC');
    assert.ok(prices.slice(0, -1).every(price => price >= 300));
    // A crystallizer's bid above the NPC lifts the floor.
    const bid = { owner: 4, id: 'B4', price: 100, qty: 50, kind: 'line' };
    const floored = visit(mainOf({ kit: { 7: 100 }, weapon: 100, bag: { 101: 1 } }), viewOf({ order: [], book: { sell: {}, buy: {}, bids: { d: [bid] } } }));
    assert.equal(floored.main.ads.wts[0].floor, 500, 'five crystals at 100 over the NPC\'s 300');
    // Stock to the dearest buy line at or above the NPC price, the rest to the NPC.
    const stock = visit(mainOf({ bag: { 200: 10 } }), viewOf({ order: [], book: { sell: {}, buy: { 200: [{ owner: 3, id: 'T3', price: 8, qty: 6, kind: 'line' }] }, bids: {} } }));
    assert.deepEqual(stock.claims.map(row => [row.kind, row.units, row.adena]), [['sell_line', 6, 48]]);
    assert.equal(stock.flows.npcSales, 20, 'four to the NPC at 5');
}
{
    // Shots: a line at or under the shot's worth; with none, no WTB is posted
    // (it goes for shots only where a seller stands).
    const reserve = { id: 300, amount: 100, cap: 8, own: 0 };
    const line = [{ owner: 2, id: 'S2', price: 7, qty: 60, kind: 'line' }];
    const got = visit(mainOf(), viewOf({ reserve, order: [{ kind: 'reserve' }], book: { sell: { 300: line }, buy: {}, bids: {} } }));
    assert.equal(got.main.shots[300], 60);
    const none = visit(mainOf(), viewOf({ reserve, order: [{ kind: 'reserve' }] }));
    assert.deepEqual([none.main.shots[300], none.main.ads.wtb.length], [undefined, 0], 'no line: no shots and no WTB for them');
    assert.ok(!none.waits.some(row => row.wait === 'wtb'), 'no WTB wait opened');
}

// The keep rule at a visit (account_needs, ours): one piece a slot of its
// next grade's kit stays in its bag (a second copy is offered). The model
// before (sell_all_but_kit) sells them all.
{
    const keep = { keepRule: 'account_needs', order: [] };
    const ahead = visit(mainOf({ kit: { 7: 100 }, weapon: 100, bag: { 101: 1 } }), viewOf({ ...keep, ahead: [{ selfId: 101, slot: 10 }] }));
    assert.equal(ahead.main.bag[101], 1, 'the next grade\'s piece is kept');
    assert.equal(ahead.main.ads.wts.length, 0);
    const two = visit(mainOf({ kit: { 7: 100 }, weapon: 100, bag: { 101: 2 } }), viewOf({ ...keep, ahead: [{ selfId: 101, slot: 10 }] }));
    assert.deepEqual([two.main.bag[101], two.main.ads.wts[0]?.qty], [2, 1], 'one kept for the slot, the second offered on its WTS');
    const before = visit(mainOf({ kit: { 7: 100 }, weapon: 100, bag: { 101: 1 } }), viewOf({ order: [], ahead: [{ selfId: 101, slot: 10 }] }));
    assert.equal(before.main.ads.wts.length, 1, 'the model before offers it');
    const sold = out => out.stops.filter(stop => stop.kind === 'npc_sell').reduce((sum, stop) => sum + stop.items[0].count, 0);
    const emptied = visit(mainOf(), viewOf({ ...keep, twin: { wallet: 0, escrow: 0 }, surplus: { 200: 3 } }));
    assert.deepEqual([sold(emptied), emptied.claims.find(claim => claim.kind === 'own_stock')?.units], [3, 3], 'the warehouse\'s surplus is taken out and sold');
    assert.equal(emptied.claims.find(claim => claim.kind === 'own_stock').surplus, true, 'marked: its sale is not loot sold a second time');
    // Gear reaches its own twin as crystals only through the twin's
    // crystallizer bid, at the floor's channel: never straight to the warehouse.
    const armour = visit(mainOf({ kit: { 7: 100 }, weapon: 100, bag: { 101: 1 } }), viewOf({ ...keep, twin: { wallet: 0, escrow: 0 }, crystallizer: { d: 100 } }));
    assert.deepEqual([armour.stops.filter(stop => stop.kind === 'warehouse' && stop.target === 'deposit').length, armour.main.ads.wts.length], [0, 1], 'offered on its WTS');
}

// buyerLadder: 'looks' (the design's text) climbs to the cap at the third
// look; 'paced' (ours) starts as many steps up as it has fewer visits left
// in its grade than the ladder needs, at its cap with one visit left.
{
    const prices = (ladder, richAt = 3) => {
        let main = mainOf({ money: 4000 });
        const seen = [];
        for (let look = 0; look < 3; look++) { main = visit(look === richAt ? { ...main, money: 20000 } : main, viewOf({ ladder })).main; seen.push(main.ads.wtb[0]?.price ?? null); }
        return seen;
    };
    assert.deepEqual(prices({ mode: 'looks', visitsLeft: 1 }), [3200, 3800, 4400], 'the five-look ladder whatever is left');
    assert.deepEqual(prices({ mode: 'paced', visitsLeft: 10 }), [3200, 3800, 4400], 'enough visits left: the same ladder');
    assert.deepEqual(prices({ mode: 'paced', visitsLeft: 3 }, 2), [4400, 5000, null], 'three visits left: from the third step, then the NPC route');
    assert.equal(prices({ mode: 'paced', visitsLeft: 1 })[0], 5000, 'one visit left: its cap at once');
}

// A line's units go to one claimer within a visit: a buy line of six takes
// six of its ten, whatever else it sells.
{
    const line = { owner: 3, id: 'T3', price: 8, qty: 6, kind: 'line' };
    const out = visit(mainOf({ bag: { 200: 10, 201: 10 } }), viewOf({ items: { ...items, 201: { kind: 'Other.Material', grade: 'NONE', npcBuy: 5 } }, order: [],
        book: { sell: {}, buy: { 200: [line], 201: [line] }, bids: {} } }));
    assert.equal(out.claims.reduce((sum, row) => sum + row.units, 0), 6, 'one line, six units, once');
}

// occupation: only at its situations, by known prices and open WTBs.
{
    const rows = [{ spotId: 'a', adena: 1000, items: [[200, 10]] }, { spotId: 'b', adena: 900, items: [[200, 10], [201, 5]] }];
    const view = { situation: 'grade_changed', rows, prices: { 200: 5, 201: 10 }, bids: {}, roll: 0.3 };
    assert.equal(occupation({ spot: 'x' }, view), 'a', '1050 against 1000');
    assert.equal(occupation({ spot: 'x' }, { ...view, bids: { 201: 40 } }), 'b', 'a WTB at 40 for what b drops: 900 + 50 + 200');
    assert.equal(occupation({ spot: 'x' }, { ...view, situation: 'level_up' }), 'x', 'a level-up inside the grade keeps its spot');
    assert.equal(occupation({ spot: 'x' }, { ...view, situation: 'spot_left' }), 'a', 'its spot left its levels');
    // A scroll its own workshop decided to add counts at the workshop's cap,
    // and a re-choice for it is a situation of its own (recipe_wanted).
    const scroll = [{ spotId: 'a', adena: 1000, items: [] }, { spotId: 'c', adena: 990, items: [[5001, 0.01]] }];
    assert.equal(occupation({ spot: 'x' }, { ...view, situation: 'recipe_wanted', rows: scroll, wants: { 5001: 5000 } }), 'c', '990 + 0.01 x 5000 over 1000');
    assert.equal(occupation({ spot: 'x' }, { ...view, situation: 'recipe_wanted', rows: scroll, prices: { 5001: 50 } }), 'a', 'without the want the scroll is worth its NPC price');
    assert.equal(occupation({ spot: 'x' }, { ...view, rows: [{ spotId: 'n', adena: NaN, items: [] }] }), 'x', 'no row with an income: it keeps its spot');
    // A level-21 spoiler whose workshop wants the Soulshot D recipe: a spot
    // outside its top that spoils the scroll is ranked only for that want
    // (or a bid for the scroll), and wins when the scroll at the workshop's
    // cap beats the income it gives up (0.02 scrolls an hour x 60000 > 1050 - 900).
    const scrollSpot = { spotId: 'sc', adena: 900, items: [[1804, 0.02]], scrolls: [1804] };
    const withWant = { ...view, situation: 'recipe_wanted', others: [scrollSpot] };
    assert.equal(occupation({ spot: 'a' }, { ...withWant, wants: { 1804: 60000 } }), 'sc', '900 + 1200 over 1050');
    assert.equal(occupation({ spot: 'a' }, { ...withWant, wants: {} }), 'a', 'without the want it is no candidate');
    assert.equal(occupation({ spot: 'a' }, { ...withWant, wants: {}, bids: { 1804: 60000 } }), 'sc', 'a bid for the scroll it sees makes it one');
    assert.equal(occupation({ spot: 'a' }, { ...withWant, wants: { 1804: 5000 } }), 'a', 'a scroll worth too little: 900 + 100 under 1050');
    // At its arrival in town (occupationAtTown) it moves only when the gain
    // over the spot it holds, for the hours it expects to stay, beats the
    // move: 'b' with a WTB at 40 earns 1150 against the held 1000; 150 x 4
    // hours = 600 against a move of 500 (fare and walk) or 700.
    const held = { spotId: 'x', adena: 1000, items: [] }, town = { ...view, situation: 'arrived_town', bids: { 201: 40 }, held };
    const priced = move => ({ ...town, rows: rows.map(row => ({ ...row, move, stay: 4 })) });
    assert.equal(occupation({ spot: 'x' }, priced(500)), 'b', '600 over 500');
    assert.equal(occupation({ spot: 'x' }, priced(700)), 'x', '600 under 700: it holds its spot');
    assert.equal(occupation({ spot: 'x' }, { ...priced(0), bids: {} }), 'a', 'without the bid: a, 50 an hour over a free move');
    assert.equal(occupation({ spot: 'x' }, { ...priced(0), held: { ...held, adena: 2000 } }), 'x', 'the held spot earns most');
    const tied = [{ spotId: 'a', adena: 1000, items: [] }, { spotId: 'b', adena: 1000, items: [] }];
    assert.deepEqual([0.2, 0.7].map(roll => occupation({ spot: 'x' }, { ...view, rows: tied, roll })), ['a', 'b'], 'a tie by the seeded share');
}

// A rung's worth from the gear ladder: the hunt hour with it minus the hour
// with the worn piece, in adena an hour (never a share of the worn hour),
// times the hours worn, plus its resale; held to gainBound times the own
// hour and counted.
{
    const rung = { hour: 1500 }, worn = { hour: 1000 };
    assert.deepEqual(Worth.rungWorth({ rung, worn, useHours: 10, ownHour: 800, gainBound: 1 }), { adena: 5000, perHour: 500, bounded: false }, '500 an hour x 10 h');
    const thin = Worth.rungWorth({ rung: { hour: 1000 }, worn: { hour: -20000 }, useHours: 10, ownHour: 500, gainBound: 1, resale: 70 });
    assert.deepEqual([thin.adena, thin.bounded], [5070, true], 'a dying worn kit: the gain held to one own hour an hour, counted');
    // A weak worn kit still earns at an easier spot: 400 an hour, not a share of 10.
    assert.equal(Worth.rungWorth({ rung: { hour: 410 }, worn: { hour: 10 }, useHours: 10, ownHour: 500, gainBound: 1 }).adena, 4000);
    assert.equal(Worth.rungWorth({ rung: { hour: 900 }, worn, useHours: 10, ownHour: 500, gainBound: 1 }).adena, 0, 'a rung that lowers the hour');
    assert.deepEqual(Worth.rungWorth({ rung, worn, useHours: 10, ownHour: 0, gainBound: 1, resale: 70 }), { adena: 70, perHour: 0, bounded: true }, 'no own hour: no gain an hour, the resale');
    assert.equal(Worth.rungWorth({ rung: null, worn, useHours: 10, ownHour: 500, gainBound: 1 }).adena, null, 'no row, no worth');
}

// The worth horizon: an NPC-sold weapon (NPC 1000k, resale 500k at the NPC's
// buy price) whose hunt-hour gain is 10k an hour. Its cap never falls under
// its resale while the main can use it, and reaches the NPC at 50 h of use.
{
    const rung = { hour: 30000 }, worn = { hour: 20000 }, npc = 1000000, resale = 500000;
    const capAt = hours => {
        const h = Worth.horizon({ gradeHours: hours, useHours: null, resale });
        return Bounds.cap({ worth: Worth.rungWorth({ rung, worn, useHours: h.hours, ownHour: 20000, gainBound: 1, resale: h.resale }).adena, npcSell: npc }).cap;
    };
    assert.deepEqual([100, 50, 10, 0].map(capAt), [npc, npc, 600000, 500000], 'never under the resale');
    assert.equal(Worth.horizon({ gradeHours: 8, useHours: 30, resale }).hours, 30, 'worn on past its grade\'s end');
}

// path over the gear ladder: a slot's candidates (best first) are its
// rungs that beat the worn piece; best_priced takes the best a route prices,
// a slot none prices names its best candidate unrouted, after the rest
// (counted). The weapon goes first only for an unarmed main: one that holds
// a weapon below its grade refills its shots first.
{
    const kit = [{ slot: 7, group: 'weapon', worn: 1, held: false, candidates: [{ selfId: 10, slot: 14 }, { selfId: 11, slot: 7 }, { selfId: 12, slot: 7 }] },
        { slot: 10, group: '10', worn: 2, held: false, candidates: [{ selfId: 20, slot: 10 }] }];
    const view = { kit, weapons: { 10: true, 11: true, 12: true }, routes: { 10: null, 11: { route: 'npc', cost: 400 }, 12: { route: 'npc', cost: 100 }, 20: null },
        worth: { 11: 800, 12: 300, 20: 900 }, reserve: 50 };
    const armedBelow = path({ weapon: 1 }, view);
    assert.deepEqual(armedBelow.pieces.map(piece => [piece.selfId, piece.slot, piece.route]), [[11, 7, 'npc'], [20, 10, null]], 'the best priced rung, the unpriced body named last');
    assert.deepEqual(armedBelow.unpriced, [20]);
    assert.deepEqual(armedBelow.order.map(row => row.kind === 'reserve' ? 'reserve' : row.selfId), ['reserve', 11, 20], 'a weapon below its grade: the reserve first, then the weapon');
    const unarmed = path({ weapon: 0 }, { ...view, kit: [{ ...kit[0], worn: 0 }, kit[1]] });
    assert.deepEqual(unarmed.order.map(row => row.kind === 'reserve' ? 'reserve' : row.selfId), [11, 'reserve', 20], 'the unarmed main\'s weapon before the reserve');
    assert.equal(path({ weapon: 10 }, { ...view, kit: [{ ...kit[0], candidates: [] }] }).pieces.length, 0, 'it wears the best rung: nothing more for the slot');
    assert.deepEqual(path({ weapon: 0 }, { ...view, ahead: [{ selfId: 30, slot: 7 }, { selfId: 31, slot: 7 }, { selfId: 40, slot: 10 }] }).ahead,
        [{ selfId: 30, slot: 7 }, { selfId: 40, slot: 10 }], 'one next-grade piece a slot');
}

// pathAim 'affordable': a level-21 mage with 125k whose weapon ladder holds
// Staff of Magic (1097k, 25k an hour over its worn staff), Scroll of Wisdom
// (483k, 12k an hour) and a no-grade staff (40k, 1k an hour), each worn 60
// hunting hours. Netting 20k an hour it waits 17.9 h for the scroll (net
// 12k x 42.1 h + 100k resale - 483k = 122k) and 48.6 h for the staff (25k x
// 11.4 h + 200k - 1097k < 0): it aims at the scroll it pays soon. Netting
// 100k an hour the staff's wait is 9.7 h (net 360k) against the scroll's
// 3.6 h (294k): the better staff repays its wait. Holding and earning
// nothing it waits forever for each: no aim. 'best_priced' (the model before) aims at the
// dearer staff whatever the money.
{
    const routes = { 10: { route: 'npc', cost: 1097000 }, 11: { route: 'npc', cost: 483000 }, 12: { route: 'npc', cost: 40000 } };
    const base = { kit: [{ slot: 7, group: 'weapon', worn: 5, held: false, candidates: [10, 11, 12].map(selfId => ({ selfId, slot: 7 })) }],
        weapons: { 10: true, 11: true, 12: true }, routes, worth: { 10: 2000000, 11: 1500000, 12: 50000 }, reserve: 0 };
    const aim = (money, earn) => ({ money, earn, perHour: { 10: 25000, 11: 12000, 12: 1000 }, useHours: { 10: 60, 11: 60, 12: 60 }, resale: { 10: 200000, 11: 100000, 12: 5000 } });
    assert.equal(path({ weapon: 5 }, base).pieces[0].selfId, 10, 'best_priced: the dearer staff');
    assert.equal(path({ weapon: 5 }, { ...base, aim: aim(125000, 20000) }).pieces[0].selfId, 11, 'the dear staff\'s gain does not repay its wait: the scroll');
    assert.equal(path({ weapon: 5 }, { ...base, aim: aim(125000, 100000) }).pieces[0].selfId, 10, 'its gain repays the wait: the dear staff');
    assert.deepEqual(path({ weapon: 5 }, { ...base, aim: aim(0, 0) }).pieces, [], 'no money held or coming: no aim');
    assert.equal(path({ weapon: 5 }, { ...base, aim: aim(125000, 15000) }).pieces[0].selfId, 11, 'the money held: the scroll waits 24 h');
    assert.equal(path({ weapon: 5 }, { ...base, reserve: 125000, aim: aim(125000, 15000) }).pieces[0].selfId, 12, 'money equal to the shot reserve: the scroll waits its whole price');
}

// pathAim 'affordable', money spent once: with 600k at 20k an hour the
// weapon slot takes the 483k scroll (paid now; the staff nets 25k x 35.2 h +
// 200k - 1097k < 0). Its body slot holds a 300k robe (8k an hour, 50k
// resale) and a 100k tunic (3k an hour, 20k resale), worn 40 h. Alone the
// robe pays now (net 70k against 40k); after the scroll 117k is left, the
// robe waits 9.2 h (net 8k x 30.8 h + 50k - 300k < 0) and the tunic, paid
// now, is the aim.
{
    const weapon = { slot: 7, group: 'weapon', worn: 5, held: false, candidates: [10, 11].map(selfId => ({ selfId, slot: 7 })) };
    const body = { slot: 10, group: '10', worn: 6, held: false, candidates: [20, 21].map(selfId => ({ selfId, slot: 10 })) };
    const view = kit => ({ kit, weapons: { 10: true, 11: true }, worth: {}, reserve: 0,
        routes: { 10: { route: 'npc', cost: 1097000 }, 11: { route: 'npc', cost: 483000 }, 20: { route: 'npc', cost: 300000 }, 21: { route: 'npc', cost: 100000 } },
        aim: { money: 600000, earn: 20000, perHour: { 10: 25000, 11: 12000, 20: 8000, 21: 3000 }, useHours: { 10: 60, 11: 60, 20: 40, 21: 40 }, resale: { 10: 200000, 11: 100000, 20: 50000, 21: 20000 } } });
    assert.deepEqual(path({ weapon: 5 }, view([body])).pieces.map(piece => piece.selfId), [20], 'alone: the robe it pays now');
    assert.deepEqual(path({ weapon: 5 }, view([weapon, body])).pieces.map(piece => piece.selfId).sort(), [11, 21], 'after the scroll: the tunic');
}

// pathAim 'affordable' while it wears a rung of its grade (Mystic Staff,
// 708k, resale 200k): it re-aims at Staff of Magic (1.06M, 20k an hour over
// the worn staff, paid now) only when that gain over its use beats its cost
// less the worn staff's resale (860k): at 40 h it nets 40k but gains 800k,
// kept; at 50 h it gains 1M, re-aimed.
{
    const kit = [{ slot: 7, group: 'weapon', worn: 11, held: true, candidates: [{ selfId: 10, slot: 7 }] }];
    const base = { kit, weapons: { 10: true, 11: true }, routes: { 10: { route: 'npc', cost: 1060000 } }, worth: { 10: 2000000 }, reserve: 0 };
    const aim = hours => ({ money: 1100000, earn: 20000, perHour: { 10: 20000 }, useHours: { 10: hours }, resale: { 10: 300000, 11: 200000 } });
    assert.deepEqual(path({ weapon: 11 }, { ...base, aim: aim(40) }).pieces, [], 'no re-aim: the gain does not pay the step');
    assert.equal(path({ weapon: 11 }, { ...base, aim: aim(50) }).pieces[0].selfId, 10, '20k x 50 h = 1M beats 860k: re-aim up');
}

// buyerNoSeller 'standing': a C weapon nobody supplies (no line, ad, NPC,
// Luxury or own twin) gets one WTB at its cap that stands unstepped while the
// queue moves on to the next piece. 'ladder' (the design's text) starts its WTB low.
{
    const cWeapon = { selfId: 100, slot: 7, grade: 'c', weapon: true, cap: 2400000, capBy: 'worth', routes: [], noSeller: true };
    const armour = { selfId: 101, slot: 10, grade: 'c', weapon: false, cap: 6000, capBy: 'npc', routes: [{ route: 'npc', adena: 5000, cost: 5000, where: 'Giran' }] };
    const order = [{ kind: 'reserve' }, { kind: 'piece', selfId: 100, slot: 7 }, { kind: 'piece', selfId: 101, slot: 10 }];
    const standingView = viewOf({ pieces: { 100: cWeapon, 101: armour }, order, buyerNoSeller: 'standing', book: { sell: { 101: [{ owner: 5, id: 'L5', price: 4500, qty: 1, kind: 'line' }] }, buy: {}, bids: {} } });
    let out = visit(mainOf(), standingView);
    assert.deepEqual([out.main.ads.wtb.map(ad => [ad.item, ad.price, ad.standing]), out.main.kit[10]], [[[100, 2400000, true]], 101], 'a standing WTB at the cap; the armour bought');
    const again = visit(out.main, standingView);
    assert.deepEqual([again.main.ads.wtb[0].price, again.main.ads.wtb[0].look, again.waits.filter(row => row.wait === 'wtb')], [2400000, 0, []], 'it stands unstepped, no second wait');
    const ladder = visit(mainOf(), viewOf({ pieces: { 100: cWeapon }, order: [order[1]], firstPrice: { 100: 2000000 }, buyerNoSeller: 'ladder' }));
    assert.equal(ladder.main.ads.wtb[0].price, Math.floor(2000000 * 0.8), 'the design\'s text: the ladder\'s first look');
}

// The account warehouse keeps the main its next piece's money route: with
// its own twin's route first (no money) and the NPC at 450k next, the main
// keeps 450k and the rest goes to the twin's wallet.
{
    const axe = { selfId: 100, slot: 7, grade: 'd', weapon: true, cap: 500000, capBy: 'route',
        routes: [{ route: 'twin', adena: 0, cost: 300000 }, { route: 'npc', adena: 450000, cost: 450000, where: 'Giran' }] };
    const out = visit(mainOf({ money: 600000, kit: { 7: 5 }, weapon: 5 }), viewOf({ pieces: { 100: axe }, order: [{ kind: 'piece', selfId: 100, slot: 7 }], twin: { wallet: 0, escrow: 0, inputs: 0, workshopMoney: 'with_reserve' } }));
    assert.deepEqual([out.main.money, out.wallet], [450000, 150000 - 30], 'the piece\'s 450k stays with the main (the deposit fee from the wallet)');
}

// Luxury takes its own twin's crystals through the account warehouse, every
// crystal of the row: 60 C and 300 D the twin holds, none on a line here,
// take the exchange; with the D ones only it takes nothing.
{
    const piece = { selfId: 100, slot: 7, grade: 'c', weapon: true, cap: 90000, capBy: 'route',
        routes: [{ route: 'exchange', adena: 30000, cost: 30000, where: 'Giran', crystals: [{ selfId: 1459, amount: 60, perCrystal: 300 }, { selfId: 1458, amount: 300, perCrystal: 100 }] }] };
    const view = viewOf({ pieces: { 100: piece }, order: [{ kind: 'piece', selfId: 100, slot: 7 }], ownCrystals: { 1459: 60, 1458: 300 } });
    const out = visit(mainOf({ wants: { 100: { state: 'route', tries: 0 } } }), view);
    assert.deepEqual([out.main.kit[7], out.claims.map(row => [row.kind, row.item, row.units]), out.main.money], [100, [['own_stock', 1459, 60], ['own_stock', 1458, 300]], 20000]);
    assert.deepEqual(out.stops.filter(stop => stop.kind === 'exchange').map(stop => [stop.items, stop.piece]), [[[{ selfId: 1459, count: 60 }, { selfId: 1458, count: 300 }], 100]], 'the exchange takes both crystals for the piece');
    const dOnly = visit(mainOf({ wants: { 100: { state: 'route', tries: 0 } } }), { ...view, ownCrystals: { 1458: 300 } });
    assert.deepEqual([dOnly.main.kit[7], dOnly.claims.filter(row => row.kind === 'own_stock')], [0, []], 'no C crystal: no exchange');
}

// A Luxury route path chose whose crystals left ends at that visit without
// barring the route: a line of the piece at 4500 under its 90k cap is
// bought there, nothing is stalled, and path reads the aim again at the
// main's next arrival; with no line, no ladder step is taken.
{
    const piece = { selfId: 100, slot: 7, grade: 'c', weapon: true, cap: 90000, capBy: 'route', routes: [], pathRoute: 'exchange' };
    const line = [{ owner: 5, id: 'L5', price: 4500, qty: 1, kind: 'line' }];
    const out = visit(mainOf({ wants: { 100: { state: 'route', tries: 0 } } }),
        viewOf({ pieces: { 100: piece }, order: [{ kind: 'piece', selfId: 100, slot: 7 }], book: { sell: { 100: line }, buy: {}, bids: {} } }));
    assert.deepEqual([out.main.kit[7], out.stalled, out.pathStale], [100, [], true], 'the line bought where its Luxury route left, the route not stalled');
    // With no line its WTB stands where it was: no ladder step.
    const held = visit(mainOf({ money: 4000 }), viewOf()).main;
    const still = visit(held, viewOf({ pieces: { 100: piece }, order: [{ kind: 'piece', selfId: 100, slot: 7 }] }));
    assert.deepEqual(still.main.ads.wtb, held.ads.wtb, 'no ladder step where its Luxury route left');
}

// Two Luxury routes weighed on the same 300 D crystals at 100 share them at
// one visit: the first takes them, and the second is not paid with the
// crystals at 1000 behind them, above the most its route was weighed to pay
// a crystal (it is weighed again at the next arrival).
{
    const exchange = { route: 'exchange', adena: 30000, cost: 30000, where: 'Giran', crystals: [{ selfId: 1458, amount: 300, perCrystal: 100 }] };
    const pieces = { 100: { selfId: 100, slot: 7, grade: 'c', weapon: true, cap: 90000, capBy: 'route', routes: [exchange] },
        101: { selfId: 101, slot: 10, grade: 'c', weapon: false, cap: 90000, capBy: 'route', routes: [exchange] } };
    const crystals = [{ owner: 5, id: 'C5', price: 100, qty: 300, kind: 'line' }, { owner: 6, id: 'C6', price: 1000, qty: 300, kind: 'line' }];
    const out = visit(mainOf({ money: 1e6, kit: { 7: 0, 10: 0 }, wants: { 100: { state: 'route', tries: 0 }, 101: { state: 'route', tries: 0 } } }),
        viewOf({ pieces, order: [{ kind: 'piece', selfId: 100, slot: 7 }, { kind: 'piece', selfId: 101, slot: 10 }], book: { sell: { 1458: crystals }, buy: {}, bids: {} } }));
    assert.deepEqual([out.main.kit[7], out.main.kit[10], out.main.money], [100, 0, 1e6 - 30000], 'one exchange taken, none at crystals dearer than its route was weighed at');
}

// Two Luxury exchange pieces at one visit weighed on the 300 D crystals the
// twin holds: the first takes them from the twin, the second finds none left
// (the twin's stock never goes below 0).
{
    const exchange = { route: 'exchange', adena: 30000, cost: 30000, where: 'Giran', crystals: [{ selfId: 1458, amount: 300, perCrystal: 100 }] };
    const pieces = { 100: { selfId: 100, slot: 7, grade: 'c', weapon: true, cap: 90000, capBy: 'route', routes: [exchange] },
        101: { selfId: 101, slot: 10, grade: 'c', weapon: false, cap: 90000, capBy: 'route', routes: [exchange] } };
    const out = visit(mainOf({ money: 1e6, kit: { 7: 0, 10: 0 }, wants: { 100: { state: 'route', tries: 0 }, 101: { state: 'route', tries: 0 } } }),
        viewOf({ pieces, order: [{ kind: 'piece', selfId: 100, slot: 7 }, { kind: 'piece', selfId: 101, slot: 10 }], ownCrystals: { 1458: 300 } }));
    assert.equal(out.claims.filter(row => row.kind === 'own_stock').reduce((sum, row) => sum + row.units, 0), 300, 'the twin holds 300 crystals: no more are claimed from it');
    assert.deepEqual([out.main.kit[7], out.main.kit[10]], [100, 0], 'one exchange taken');
}

// Three Luxury exchange pieces at one visit, each needing 300 D crystals, the
// twin holding 450 and the lines the rest: 450 are claimed from the twin in
// all (never the same 450 twice) and all three pieces are worn.
{
    const exchange = { route: 'exchange', adena: 30000, cost: 30000, where: 'Giran', crystals: [{ selfId: 1458, amount: 300, perCrystal: 100 }] };
    const pieces = { 100: { selfId: 100, slot: 7, grade: 'c', weapon: true, cap: 90000, capBy: 'route', routes: [exchange] },
        101: { selfId: 101, slot: 10, grade: 'c', weapon: false, cap: 90000, capBy: 'route', routes: [exchange] },
        102: { selfId: 102, slot: 11, grade: 'c', weapon: false, cap: 90000, capBy: 'route', routes: [exchange] } };
    const lines = [{ owner: 5, id: 'C5', price: 100, qty: 450, kind: 'line' }];
    const out = visit(mainOf({ money: 1e6, kit: { 7: 0, 10: 0, 11: 0 }, wants: { 100: { state: 'route', tries: 0 }, 101: { state: 'route', tries: 0 }, 102: { state: 'route', tries: 0 } } }),
        viewOf({ pieces, order: [{ kind: 'piece', selfId: 100, slot: 7 }, { kind: 'piece', selfId: 101, slot: 10 }, { kind: 'piece', selfId: 102, slot: 11 }], ownCrystals: { 1458: 450 }, book: { sell: { 1458: lines }, buy: {}, bids: {} } }));
    assert.equal(out.claims.filter(row => row.kind === 'own_stock').reduce((sum, row) => sum + row.units, 0), 450, 'the twin holds 450 crystals: 450 claimed in all');
    assert.deepEqual([out.main.kit[7], out.main.kit[10], out.main.kit[11]], [100, 101, 102], 'all three pieces worn');
}

// visit: a wait ends at its third visit unmet even when nothing caps the
// piece any more (its last route stalled, no worth stated).
{
    const uncapped = { 100: { ...viewOf().pieces[100], cap: null, capBy: 'worth', routes: [] } };
    const out = visit(mainOf({ wants: { 100: { state: 'twin', route: 'twin', seen: 2 } } }), viewOf({ pieces: uncapped }));
    assert.deepEqual([out.waits, out.stalled, out.main.wants[100]], [[{ wait: 'twin', end: 'failed' }], [{ selfId: 100, route: 'twin' }], undefined]);
}

// visit: the refill reserve is never stopped by a piece the main cannot pay.
// A main in grade D with a no-grade weapon, its D weapon's want at its route
// (NPC 1.06M) and 300k in hand buys its 3000 no-grade shots at the NPC (8)
// and leaves the weapon at its route; an unarmed main whose weapon comes
// first in the queue still refills after it.
{
    const weaponRoute = { 100: { selfId: 100, slot: 7, grade: 'd', weapon: true, cap: 1060000, capBy: 'npc', routes: [{ route: 'npc', adena: 1060000, cost: 1060000, where: 'Giran' }] } };
    const reserve = { id: 300, amount: 3000, cap: 8, capBy: 'npc', own: 0 };
    const kit = [{ slot: 7, group: 'weapon', worn: 5, held: false, candidates: [{ selfId: 100, slot: 7 }] }];
    const armedView = { kit, weapons: { 100: true }, routes: { 100: { route: 'npc', cost: 1060000 } }, worth: { 100: 2000000 }, reserve: 24000 };
    const order = path({ weapon: 5 }, armedView).order;
    const armed = visit(mainOf({ money: 300000, kit: { 7: 5 }, weapon: 5, wants: { 100: { state: 'route', tries: 0 } } }),
        viewOf({ pieces: weaponRoute, reserve, order, npcSell: { 300: 8 } }));
    assert.deepEqual([armed.main.shots[300], armed.main.money, armed.main.wants[100].state, armed.main.kit[7]], [3000, 276000, 'route', 5], 'shots bought, the weapon still at its route');
    const unarmedOrder = path({ weapon: 0 }, { ...armedView, kit: [{ ...kit[0], worn: 0 }] }).order;
    assert.equal(unarmedOrder[0].kind, 'piece');
    const unarmed = visit(mainOf({ money: 300000, wants: { 100: { state: 'route', tries: 0 } } }), viewOf({ pieces: weaponRoute, reserve, order: unarmedOrder, npcSell: { 300: 8 } }));
    assert.deepEqual([unarmed.main.shots[300], unarmed.main.wants[100].state], [3000, 'route'], 'the weapon it cannot pay stops only the pieces after it');
}

// acquire: its own twin crafts the piece (inputs 900 at its replacement
// cost, the craft's MP taking 2 hours of the twin's regen): no money from
// the main, the wait charged at the piece's use (100 an hour).
{
    const view = { cap: Infinity, ownHour: 1000, hourCost: 'opportunity', useHour: 100, lines: [], npc: [{ town: 'Giran', price: 1500, fare: 0 }], twin: { recipeId: 9, cost: 900, hours: 2 } };
    const own = acquire({ selfId: 1 }, view);
    assert.deepEqual([own.route, own.adena, own.cost, own.recipeId], ['twin', 0, 1100, 9]);
    assert.equal(acquire({ selfId: 1 }, { ...view, stalled: ['twin'] }).route, 'npc', 'a stalled twin route is not offered');
    assert.equal(acquire({ selfId: 1 }, { ...view, twin: null }).route, 'npc', 'no twin, no route');
}

// visit: the own twin's route is taken at the first look (no WTB); its wait
// ends when the twin's shelf holds the piece, or fails at the third visit
// unmet (the route stalled).
{
    const pieces = { 100: { ...viewOf().pieces[100], cap: 1100, capBy: 'route', routes: [{ route: 'twin', adena: 0, cost: 1100, hours: 2 }, { route: 'npc', adena: 5000, cost: 5000, where: 'Giran' }] } };
    const first = visit(mainOf(), viewOf({ pieces }));
    assert.deepEqual([first.main.ads.wtb.length, first.main.wants[100].state, first.main.money], [0, 'twin', 20000], 'no WTB, no money spent: its twin crafts it');
    const done = visit(first.main, viewOf({ pieces: { 100: { ...pieces[100], own: 1 } } }));
    assert.deepEqual([done.main.kit[7], done.obtained[0].route, done.claims[0].kind], [100, 'twin', 'own_stock']);
    let main = first.main, out;
    for (let look = 0; look < 3; look++) { out = visit(main, viewOf({ pieces, waitVisits: 2 })); main = out.main; }
    assert.deepEqual(out.stalled, [{ selfId: 100, route: 'twin' }], 'unmet at its third visit');
    // Unmet at its third visit with a line of the piece at 1000 under its cap: the line is bought there.
    const lined = visit(mainOf({ wants: { 100: { state: 'twin', route: 'twin', seen: 2 } } }),
        viewOf({ pieces, waitVisits: 2, book: { sell: { 100: [{ owner: 5, id: 'L5', price: 1000, qty: 1, kind: 'line' }] }, buy: {}, bids: {} } }));
    assert.deepEqual([lined.main.kit[7], lined.stalled], [100, [{ selfId: 100, route: 'twin' }]], 'the twin\'s wait fails and the line is bought at that visit');
}

// visit: a piece it will use for fewer than two more visits takes its route
// at once (no ladder) while the cap reaches it, and is parked at once when
// its worth caps it under the route. A parked want opens again when its cap
// rises above the parked cap, or when its money first reaches the route.
{
    const piece = { ...viewOf().pieces[100], visitsLeft: 1 };
    const bought = visit(mainOf(), viewOf({ pieces: { 100: piece } }));
    assert.deepEqual([bought.main.kit[7], bought.obtained[0].route, bought.main.ads.wtb.length], [100, 'npc', 0], 'the NPC at the first look');
    const worthCapped = { ...piece, cap: 3000, capBy: 'worth' };
    const parked = visit(mainOf(), viewOf({ pieces: { 100: worthCapped } }));
    assert.deepEqual([parked.main.wants[100].state, parked.main.ads.wtb.length, parked.main.wants[100].parkedCap], ['parked', 0, 3000]);
    const ladder = { ...viewOf().pieces[100], cap: 3000, capBy: 'worth' };
    let main = mainOf({ money: 1000 });
    for (let look = 0; look < 5; look++) main = visit(main, viewOf({ pieces: { 100: ladder } })).main;
    assert.deepEqual([main.wants[100].state, main.wants[100].short], ['parked', true], 'parked at its worth, its money short of the NPC');
    assert.equal(visit(main, viewOf({ pieces: { 100: ladder } })).main.wants[100].state, 'parked', 'nothing changed: it stays parked');
    const risen = visit(main, viewOf({ pieces: { 100: { ...ladder, cap: 5000, capBy: 'npc' } } }));
    assert.equal(risen.main.wants[100].state, 'wtb', 'its cap rose: the want opens again');
    const rich = visit({ ...main, money: 20000 }, viewOf({ pieces: { 100: ladder } }));
    assert.equal(rich.main.wants[100].state, 'wtb', 'its money reached the route: the want opens again');
    assert.ok(rich.waits.some(w => w.wait === 'parkedWant' && w.end === 'withdrawn'), 'the parked wait ends');
}

// visit: a main whose money pays the NPC route that caps its piece buys there
// at the first visit when no line stands; a cheaper line in reach still wins;
// a main short of the route's price posts its WTB and climbs the ladder.
{
    const npc = viewOf().pieces[100];
    const rich = visit(mainOf({ money: 5000 }), viewOf());
    assert.deepEqual([rich.main.kit[7], rich.obtained[0]?.route, rich.main.ads.wtb.length, rich.main.money], [100, 'npc', 0, 0], 'the money pays the NPC: bought at the first visit, no WTB');
    const line = { owner: 5, id: 'L5', price: 4500, qty: 1, kind: 'line' };
    const cheaper = visit(mainOf({ money: 5000 }), viewOf({ book: { sell: { 100: [line] }, buy: {}, bids: {} } }));
    assert.deepEqual([cheaper.obtained[0].route, cheaper.main.money], ['buy', 500], 'a line under the NPC price wins');
    const short = visit(mainOf({ money: 4999 }), viewOf());
    assert.deepEqual([short.main.kit[7], short.main.wants[100].state, short.main.ads.wtb[0].price], [0, 'wtb', 3200], 'one adena short: the WTB at the ladder\'s first step');
    const routeCap = visit(mainOf({ money: 5000 }), viewOf({ pieces: { 100: { ...npc, capBy: 'route' } } }));
    assert.equal(routeCap.main.kit[7], 100, 'a cap its own route sets: the same');
    const worthCapped = visit(mainOf({ money: 5000 }), viewOf({ pieces: { 100: { ...npc, capBy: 'worth', cap: 4000 } } }));
    assert.equal(worthCapped.main.wants[100].state, 'wtb', 'a worth cap under the route: the ladder, not the route');
}

// occupation at arrived_town: the spot it left at its last arrival is no
// candidate, whatever its gain.
{
    const rows = [{ spotId: 'a', adena: 1000, items: [], move: 0, stay: 2 }, { spotId: 'b', adena: 900, items: [], move: 0, stay: 2 }];
    const view = { situation: 'arrived_town', rows, prices: {}, bids: {}, roll: 0.3, held: { spotId: 'c', adena: 500, items: [] } };
    assert.equal(occupation({ spot: 'c' }, view), 'a');
    assert.equal(occupation({ spot: 'c' }, { ...view, left: 'a' }), 'b', 'not back to the spot it just left');
    assert.equal(occupation({ spot: 'c' }, { ...view, situation: 'grade_changed', left: 'a' }), 'a', 'only an arrival refuses it');
}

// occupation at an arrival: with the held row's gain fixed (100 an hour
// over the spot it holds), the move (500) is taken when its next outing's
// hours x that gain beat it and refused when not; the outing is as long as
// the one that just ended (at least an hour), not the 100 hours left in its grade.
{
    const held = { spotId: 'x', adena: 1000, items: [] };
    const moveAfter = outingHours => occupation({ spot: 'x' }, { situation: 'arrived_town', prices: {}, bids: {}, roll: 0, held,
        rows: [{ spotId: 'b', adena: 1100, items: [], move: 500, stay: stayHours({ outingHours: refillHours({ refill: 'last_outing', minHours: 1, lastOuting: outingHours }), gradeHours: 100 }) }] });
    assert.equal(moveAfter(2), 'x', 'a 2-hour outing: 200 under 500');
    assert.equal(moveAfter(6), 'b', 'a 6-hour outing: 600 over 500');
    assert.equal(moveAfter(0.2), 'x', 'a short outing counts its hour at least: 100 under 500');
    assert.equal(stayHours({ outingHours: 6, gradeHours: 4 }), 4, 'never past its grade\'s end');
    assert.equal(stayHours({ outingHours: 6, gradeHours: 100, spotHours: 3 }), 3, 'nor past the spot\'s last level');
}

// goal_affordable: a main whose one path piece is parked comes to town when
// its money (3000 and the bag at the NPC, 1000 an hour) reaches the piece's
// route (5000), where the parked want opens again; a piece it wants by a WTB
// or already wears is no goal.
{
    const pieces = [{ selfId: 100, slot: 7, route: 'npc', cost: 5000 }];
    const goal = state => goalOf({ pieces, kit: { 7: 0 }, wants: state ? { 100: { state } } : {}, reserve: 0, money: 3000, bagValue: 0, perHour: 1000, fresh: false });
    const view = goalNow => ({ now: 10, since: 10, huntShare: 0.5, toHours: 0.02, backHours: 0.01, town: 'Giran', stockLowHours: 1 / 6, loadShare: 2 / 3, ownHour: 1000, shots: null, bag: null, goal: goalNow });
    const parked = trip({}, view(goal('parked')));
    assert.equal(parked.reason, 'goal_affordable');
    assert.ok(Math.abs(parked.at - (10 + 2 / 0.5 + 0.02)) < 1e-9, `2000 more at 1000 a hunting hour: ${parked.at}`);
    assert.equal(goal('wtb'), null, 'a WTB stands for it: no goal');
    assert.equal(trip({}, view(goal('wtb'))).at, null);
    assert.equal(goalOf({ pieces, kit: { 7: 100 }, wants: { 100: { state: 'parked' } }, reserve: 0, money: 3000, bagValue: 0, perHour: 1000, fresh: false }), null, 'it wears the piece');
    assert.deepEqual(goal(null), { need: 5000, have: 3000, perHour: 1000, fresh: false }, 'a piece it does not want yet is the goal too');
}

{
    // A slot's piece takes off what it cannot be worn with, into the bag: a
    // full armour (15) the chest and legs, a chest or legs piece the full armour.
    const armour = slot => ({ selfId: slot * 10, slot, grade: 'd', weapon: false, cap: 900, capBy: 'npc', routes: [] });
    const pieces = { 150: armour(15), 100: viewOf().pieces[100], 101: armour(10), 111: armour(11) };
    const wear = (kit, bag, slot, id) => visit(mainOf({ kit: { 7: 0, ...kit }, bag }), viewOf({ pieces, order: [{ kind: 'piece', selfId: id, slot }] })).main;
    const full = wear({ 10: 101, 11: 111 }, { 150: 1 }, 15, 150);
    assert.equal(full.kit[15], 150, 'the full armour is worn');
    assert.deepEqual([full.kit[10], full.kit[11]], [0, 0], 'the chest and legs are off');
    assert.deepEqual([full.bag[101], full.bag[111]], [1, 1], 'they are in the bag');
    const chest = wear({ 15: 150 }, { 101: 1 }, 10, 101);
    assert.deepEqual([chest.kit[10], chest.kit[15]], [101, 0], 'the chest piece is worn, the full armour off');
    assert.equal(chest.bag[150], 1, 'the full armour is in the bag');
}

console.log('PASS economy model market rules');
