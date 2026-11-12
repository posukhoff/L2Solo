'use strict';

// The economy design's market of mains on inline fixtures: path spends the
// refill reserve before its pieces and an unarmed main's weapon before the
// reserve; acquire takes the cheapest of the routes, its hours charged at
// what the main gives up; trip goes at the earliest of its situations and
// holds a shot situation with no seller until an offer comes; visit turns a
// want with no line into a WTB, gives one line to its first claimer, reads
// every line it reaches and keeps every price between its floor and cap; a
// WTB two looks at a worth cap is parked, at a route cap takes the route;
// occupation moves only at its situations and ranks by known prices and
// open WTBs; the hunt cycle's worth is bounded where the hour without the
// piece is near zero.
const assert = require('node:assert/strict');
const { path } = require('../scripts/economy-model/rules/path');
const { acquire } = require('../scripts/economy-model/rules/acquire');
const { trip } = require('../scripts/economy-model/rules/trip');
const { visit } = require('../scripts/economy-model/rules/visit');
const { occupation } = require('../scripts/economy-model/rules/occupation');
const Worth = require('../scripts/economy-model/rules/worth');

// path: the money queue.
{
    const kit = [{ selfId: 10, slot: 7 }, { selfId: 20, slot: 10 }, { selfId: 30, slot: 6 }];
    const view = { kit, weapons: { 10: true }, routes: { 10: { route: 'npc', cost: 1000 }, 20: { route: 'npc', cost: 100 }, 30: { route: 'buy', cost: 500 } },
        worth: { 10: 2000, 20: 1000, 30: 100 }, reserve: 300 };
    const armed = path({ kit: { 7: 0, 10: 0, 6: 30 }, weapon: 99 }, view);
    assert.deepEqual(armed.order.map(row => row.kind === 'reserve' ? 'reserve' : row.selfId), ['reserve', 20, 10], 'the reserve first, then worth per adena (20: 10, 10: 2); a worn piece left out');
    const unarmed = path({ kit: { 7: 0, 10: 0, 6: 0 }, weapon: 0 }, view);
    assert.deepEqual(unarmed.order.map(row => row.kind === 'reserve' ? 'reserve' : row.selfId), [10, 'reserve', 20, 30], 'the unarmed main\'s weapon before the reserve');
    assert.equal(unarmed.reserve, 300);
}

// acquire: the cheapest route, hours charged at the own hour less the farm spot's.
{
    const view = { cap: 5000, ownHour: 1000, hourCost: 'opportunity', lines: [{ price: 6000, kind: 'line', where: 'Giran' }],
        npc: [{ town: 'Giran', price: 1500, fare: 0 }], farm: { hours: 2, spotHour: 900, where: 's9' },
        order: { recipeId: 7, fee: 400, mp: 40, units: 1, materials: [{ selfId: 200, amount: 2, held: 0, sale: 5, line: 300, npc: null, farmHours: 0 }] },
        exchange: { town: 'Giran', fare: 0, options: [{ grade: 'd', amount: 10, price: 160 }] } };
    const opportunity = acquire({ selfId: 1 }, view);
    assert.equal(opportunity.route, 'farm', 'two hours at a spot paying 900 against its 1000: 200');
    assert.equal(opportunity.cost, 200);
    assert.deepEqual(opportunity.routes.map(row => row.route), ['farm', 'order', 'npc', 'exchange'], 'the line above the cap is no route');
    assert.equal(opportunity.routeCost, 200);
    const literal = acquire({ selfId: 1 }, { ...view, hourCost: 'literal' });
    assert.equal(literal.route, 'order', 'the design\'s text charges the whole own hour: farming costs 2000');
    assert.equal(literal.cost, 1000);
    const bought = acquire({ selfId: 1 }, { ...view, lines: [{ price: 150, kind: 'ad', where: 'ad' }] });
    assert.equal(bought.route, 'buy');
    assert.equal(bought.routeCost, 200, 'the cap\'s own route is the cheapest that is not a player\'s line');
    assert.equal(acquire({ selfId: 1 }, { ...view, stalled: ['farm'] }).route, 'order', 'a stalled route is not offered');
    assert.equal(acquire({ selfId: 1 }, { cap: 1, ownHour: 1, lines: [], npc: [] }), null);
}

// acquire's order: the main's own materials (those it holds at what they
// would sell for, the rest each by its own cheapest route) + the fee, per
// piece the craft makes (a 60 % recipe can fail: its materials are lost,
// the fee kept).
{
    const materials = [{ selfId: 200, amount: 10, held: 4, sale: 5, line: 30, npc: 50, farmHours: 0 },
        { selfId: 201, amount: 2, held: 0, sale: 8, line: null, npc: null, farmHours: 0.5, spotHour: 800 }];
    const view = { cap: 1e9, ownHour: 1000, hourCost: 'opportunity', lines: [], npc: [], order: { recipeId: 7, fee: 520, mp: 40, units: 0.6, materials } };
    const order = acquire({ selfId: 1 }, view);
    assert.equal(order.route, 'order');
    assert.deepEqual(order.materials.map(row => [row.selfId, row.via, row.price]), [[200, 'line', 30], [201, 'gather', 100]], 'six bought on a line at 30 (under the NPC\'s 50); two gathered in an hour that gives up 200');
    assert.equal(order.adena, 520 + 6 * 30, 'the money one craft takes: the fee and what it buys');
    assert.equal(order.cost, (520 + 4 * 5 + 180 + 200) / 0.6, 'per piece of a 60 % craft');
    assert.equal(order.hours, 1 / 0.6);
    assert.equal(acquire({ selfId: 1 }, { ...view, hourCost: 'literal' }).cost, (520 + 20 + 180 + 1000) / 0.6, 'the design\'s text charges the whole own hour');
    assert.equal(acquire({ selfId: 1 }, { ...view, order: { ...view.order, materials: [materials[0], { ...materials[1], farmHours: 0 }] } }), null, 'a material nothing supplies: no order');
}

// trip: the earliest situation; a shot situation with no seller waits for an offer.
{
    const base = { now: 10, since: 10, huntShare: 0.5, tripHours: 0.02, town: 'Giran', stockLowHours: 1 / 6, loadShare: 2 / 3, ownHour: 1000,
        shots: { held: 600, perHour: 300, waiting: false }, bag: { slots: 80, used: 10, weight: 0, maxLoad: 1000, items: [{ rate: 10, weight: 10, stack: true, held: false }] },
        goal: { need: 5000, have: 1000, perHour: 1000, fresh: false } };
    const first = trip({}, base);
    assert.equal(first.reason, 'stock_low:shots', '600 shots at 300 an hour run low at 1.83 hunting hours');
    assert.ok(Math.abs(first.at - (10 + (600 - 50) / 300 / 0.5 + 0.02)) < 1e-9, `wall hours over the hunting share, plus the walk: ${first.at}`);
    const loaded = trip({}, { ...base, bag: { ...base.bag, items: [{ rate: 100, weight: 10, stack: true, held: false }] } });
    assert.equal(loaded.reason, 'bag_full', '1000 load an hour reaches 2/3 of 1000 in 0.67 hunting hours');
    const rich = trip({}, { ...base, goal: { ...base.goal, have: 5000, fresh: true } });
    assert.equal(rich.reason, 'goal_affordable', 'a new goal it can pay sends it now');
    assert.equal(rich.at, 10.02);
    const parked = trip({}, { ...base, shots: { held: 0, perHour: 300, waiting: true }, goal: null, bag: null });
    assert.equal(parked.at, null, 'no seller known: no shot situation, nothing else pending');
    assert.equal(parked.parked, true, 'the held-back shot situation is counted');
    const offer = trip({}, { ...base, shots: { held: 0, perHour: 300, waiting: true }, goal: null, bag: null, event: 'offer_posted', deal: { gain: 500 } });
    assert.equal(offer.reason, 'offer_posted', 'a line in reach worth more than the walk sends it now');
    assert.equal(trip({}, { ...base, shots: { held: 0, perHour: 300, waiting: true }, goal: null, bag: null, event: 'offer_posted', deal: { gain: 10 } }).at, null,
        'a gain under the trip\'s 0.02 h x 1000 waits for its next visit');
}

// visit: lines, first come, WTBs and bounds.
const items = {
    100: { kind: 'Weapon.Sword', grade: 'D', npcBuy: 500, crystals: 10 },
    101: { kind: 'Armor.Body', grade: 'D', npcBuy: 300, crystals: 5 },
    200: { kind: 'Other.Material', grade: 'NONE', npcBuy: 5 },
    300: { kind: 'Other.Shot', grade: 'NONE', npcBuy: 1 }
};
const mainOf = (patch = {}) => ({ index: 0, money: 20000, bag: {}, shots: {}, kit: { 7: 0 }, weapon: 0, ads: { wts: [], wtb: [] }, wants: {}, incoming: {}, shotWait: null, ...patch });
const viewOf = (patch = {}) => ({
    now: 1, town: 'Giran', adId: 'a1', persona: { looksToFloor: 3, buyerStart: 0.8 }, roll: 7, items, crystalIds: { D: 1458 },
    book: { sell: {}, buy: {}, bids: {} }, npcSell: {}, known: {}, firstPrice: { 100: 4000, 300: 10 }, deposit: {}, depositFee: 30, twin: null, firing: 300,
    reserve: null, fares: {}, waitVisits: 2,
    pieces: { 100: { selfId: 100, slot: 7, grade: 'd', weapon: true, cap: 5000, capBy: 'npc', caps: null, routes: [{ route: 'npc', adena: 5000, cost: 5000, where: 'Giran' }] } },
    order: [{ kind: 'piece', selfId: 100, slot: 7 }, { kind: 'reserve' }],
    ...patch
});
{
    // A want with no line becomes a WTB, priced under its cap.
    const out = visit(mainOf(), viewOf());
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
    const second = visit(mainOf({ index: 1 }), viewOf({ book: after }));
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
    // A WTB steps up to its cap and holds two looks there; then a route cap
    // takes the route, a worth cap parks the want.
    let main = mainOf(), seen = [];
    for (let look = 0; look < 6 && main.ads.wtb.length + (look === 0 ? 1 : 0); look++) {
        const out = visit(main, viewOf());
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
    // Shots: a line at or under the shot's worth, else a WTB; at the worth cap twice, parked.
    const reserve = { id: 300, amount: 100, cap: 8, capBy: 'worth', own: 0 };
    const line = [{ owner: 2, id: 'S2', price: 7, qty: 60, kind: 'line' }];
    const got = visit(mainOf(), viewOf({ reserve, order: [{ kind: 'reserve' }], book: { sell: { 300: line }, buy: {}, bids: {} } }));
    assert.equal(got.main.shots[300], 60);
    assert.equal(got.main.shotWait, null, 'it holds shots: its trip runs on them');
    let main = mainOf();
    const none = viewOf({ reserve, order: [{ kind: 'reserve' }] });
    main = visit(main, none).main;
    assert.equal(main.shotWait, 'wtb', 'no line: a WTB for the shots');
    for (let look = 0; look < 4; look++) main = visit(main, none).main;
    assert.equal(main.shotWait, 'parked', 'two looks at the worth cap park the want');
    assert.equal(visit(mainOf(), viewOf({ reserve: { ...reserve, cap: 0.5 }, order: [{ kind: 'reserve' }] })).main.shotWait, 'unwanted', 'a shot worth under an adena is not wanted');
}

// visit: an order placed from its own materials. It buys what a line or
// the NPC here supplies, leaves the materials and the fee with the order;
// a material it gathers waits in its bag (never sold) until it holds all.
// An order no twin took raises its fee by the step at each visit while under
// the cap, and at the third visit unmet it is withdrawn (its owner gets the
// materials and fee back) and the route stalls.
{
    const orderRoute = { route: 'order', adena: 1400, cost: 1600, recipeId: 7, fee: 1300, mp: 100, materialsCost: 300,
        materials: [{ selfId: 200, amount: 10, via: 'line', price: 10 }, { selfId: 201, amount: 2, via: 'gather', price: 50 }] };
    const pieces = { 100: { ...viewOf().pieces[100], cap: 5000, capBy: 'order', routes: [orderRoute] } };
    const items2 = { ...items, 201: { kind: 'Other.Material', grade: 'NONE', npcBuy: 7 } };
    const line = { owner: 5, id: 'M5', price: 10, qty: 50, kind: 'line' };
    const routeView = viewOf({ items: items2, pieces, order: [{ kind: 'piece', selfId: 100, slot: 7 }], book: { sell: { 200: [line] }, buy: {}, bids: {} }, feeStep: 7 });
    // Two looks of its WTB at the order cap, then the route.
    let main = mainOf(), out;
    for (let look = 0; look < 6 && main.wants[100]?.state !== 'farm'; look++) { out = visit(main, routeView); main = out.main; }
    assert.equal(main.wants[100].state, 'farm', 'it lacks a material it gathers: a farm wait for it');
    assert.equal(main.bag[200], 10, 'the ten it lacked bought on the line');
    assert.equal(out.orders.length, 0);
    main = visit({ ...main, bag: { ...main.bag, 201: 1 } }, routeView).main;
    assert.deepEqual([main.bag[200], main.bag[201]], [10, 1], 'what it gathers for the order stays in its bag, unsold');
    out = visit({ ...main, bag: { ...main.bag, 201: 2 } }, routeView);
    assert.deepEqual(out.orders.map(row => [row.recipeId, row.fee, row.materials[200], row.materials[201]]), [[7, 1300, 10, 2]], 'all held: the order takes the materials and the fee');
    assert.deepEqual([out.main.bag[200], out.main.bag[201], out.main.wants[100].state], [undefined, undefined, 'order']);
    const placed = out.main.money;
    out = visit(out.main, routeView);
    assert.deepEqual(out.orders.map(row => [row.fee, row.add]), [[2000, 700]], 'unclaimed at its next visit: 7 an MP more');
    assert.equal(out.main.money, placed - 700);
    const steep = visit(out.main, { ...routeView, feeStep: 70 });
    assert.equal(steep.orders[0].fee, 4700, 'never over the cap less the materials');
    out = visit(out.main, routeView);
    assert.equal(out.orders[0].fee, 2700);
    out = visit(out.main, routeView);
    assert.deepEqual([out.withdrawn.length, out.stalled[0].route, out.main.wants[100]], [1, 'order', undefined], 'the third visit unmet: withdrawn, the route stalled');
    const crafting = visit({ ...main, wants: { 100: { state: 'order', orderId: 'x', order: { fee: 1300, mp: 100, cap: 5000, materialsCost: 300 }, seen: 5, claimed: true } } }, routeView);
    assert.deepEqual([crafting.withdrawn.length, crafting.orders.length], [0, 0], 'an order a twin took is crafting: no step, no withdrawal');
}

// buyerLadder: 'looks' (the design's text) climbs to the cap at the third
// look; 'paced' (ours) starts as many steps up as it has fewer visits left
// in its grade than the ladder needs, at its cap with one visit left.
{
    const prices = ladder => {
        let main = mainOf();
        const seen = [];
        for (let look = 0; look < 3; look++) { main = visit(main, viewOf({ ladder })).main; seen.push(main.ads.wtb[0]?.price ?? null); }
        return seen;
    };
    assert.deepEqual(prices({ mode: 'looks', visitsLeft: 1 }), [3200, 3800, 4400], 'the five-look ladder whatever is left');
    assert.deepEqual(prices({ mode: 'paced', visitsLeft: 10 }), [3200, 3800, 4400], 'enough visits left: the same ladder');
    assert.deepEqual(prices({ mode: 'paced', visitsLeft: 3 }), [4400, 5000, null], 'three visits left: from the third step, then the NPC route');
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
    const tied = [{ spotId: 'a', adena: 1000, items: [] }, { spotId: 'b', adena: 1000, items: [] }];
    assert.deepEqual([0.2, 0.7].map(roll => occupation({ spot: 'x' }, { ...view, rows: tied, roll })), ['a', 'b'], 'a tie by the seeded share');
}

// The hunt cycle's worth, bounded where the hour without the piece is near zero.
{
    const row = { gear: 0.1, with: 2000, without: 1000 };
    assert.equal(Worth.pieceWorth({ formula: 'hunt_cycle', row, horizonHours: 10, ownHour: 500, gainBound: 1 }).adena, 5000, 'doubles the hour: 1 x 10 h x 500');
    assert.equal(Worth.pieceWorth({ formula: 'gear_gain', row, horizonHours: 10, ownHour: 500, gainBound: 1 }).adena, 500, '0.1 x 10 x 500');
    const thin = Worth.pieceWorth({ formula: 'hunt_cycle', row: { gear: 0, with: 1000, without: 10 }, horizonHours: 10, ownHour: 500, gainBound: 1 });
    assert.deepEqual([thin.adena, thin.bounded], [5000, true], '99 times the hour held to once, counted');
    const dying = Worth.pieceWorth({ formula: 'hunt_cycle', row: { gear: 0, with: 100, without: -500 }, horizonHours: 10, ownHour: 500, gainBound: 1 });
    assert.deepEqual([dying.adena, dying.bounded], [5000, true], 'a kit that loses money without the piece');
    assert.equal(Worth.pieceWorth({ formula: 'hunt_cycle', row: { gear: 0, with: 900, without: 1000 }, horizonHours: 10, ownHour: 500, gainBound: 1 }).adena, 0, 'a piece that lowers the hour');
    assert.equal(Worth.pieceWorth({ formula: 'hunt_cycle', row: null, horizonHours: 10, ownHour: 500, gainBound: 1 }).adena, null, 'no row, no worth');
}

console.log('PASS economy model market rules');
