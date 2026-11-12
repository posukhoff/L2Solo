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
const { trip, goalOf } = require('../scripts/economy-model/rules/trip');
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
    // A farm at its own spot is not free: the two hours the piece takes to
    // drop cost its use, 600 an hour (opportunity reading): 1200 over the
    // order's 1000.
    const home = { ...view, farm: { hours: 2, spotHour: 1000, where: 's1' }, useHour: 600 };
    assert.deepEqual([acquire({ selfId: 1 }, home).route, acquire({ selfId: 1 }, home).routes[0].cost], ['order', 1000]);
    assert.equal(acquire({ selfId: 1 }, home).routes.find(row => row.route === 'farm').cost, 1200);
    assert.equal(acquire({ selfId: 1 }, { ...home, useHour: 0 }).routeCost, 0, 'without its use the farm costs nothing');
}
// A piece with no worth row (useHour null): its use cannot be stated, so a
// farm at its own spot and an order's gathering are not offered at 0; the
// NPC prices it. The design's literal hour still prices the farm.
{
    const view = { cap: Infinity, ownHour: 1000, hourCost: 'opportunity', useHour: null, lines: [], npc: [{ town: 'Giran', price: 708000, fare: 0 }],
        farm: { hours: 781, spotHour: 1000, where: 's1' },
        order: { recipeId: 7, fee: 400, mp: 40, units: 1, materials: [{ selfId: 200, amount: 2, held: 0, sale: 5, line: null, npc: null, farmHours: 50, spotHour: 1000 }] } };
    const unstated = acquire({ selfId: 1 }, view);
    assert.deepEqual(unstated.routes.map(row => row.route), ['npc'], 'no farm and no gathered order at cost 0');
    assert.equal(unstated.routeCost, 708000);
    assert.equal(acquire({ selfId: 1 }, { ...view, hourCost: 'literal' }).route, 'order', 'the literal hour prices gathering: 100 h x 1000 + 400');
    assert.equal(acquire({ selfId: 1 }, { ...view, useHour: 0 }).routeCost, 0, 'a stated use of 0 is a free farm');
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

// trip's town (tripTown 'by_gain'): a town it knows a book of when what its
// stock sells for there above the nearest town's best price beats the fare
// there and back and the hop hours at its own hour; the gain turning
// positive is a situation of its own (hub_trip). Junk (best known price the
// NPC's) never sends it to a hub.
{
    const giran = { town: 'Giran', fare: 12200, hours: 0.1, bids: { 200: { price: 60, qty: 1000 } }, asks: {} };
    const base = { now: 10, since: 10, huntShare: 0.5, tripHours: 0.02, town: 'Gludio', stockLowHours: 1 / 6, loadShare: 2 / 3, ownHour: 1000,
        shots: { held: 600, perHour: 300, waiting: false }, bag: null, goal: null, tripTown: 'by_gain', money: 100000,
        stock: [{ id: 200, held: 500, rate: 0, npc: 5 }], wants: [], near: { bids: {}, asks: {} }, towns: [giran] };
    const hub = trip({}, base);
    assert.deepEqual([hub.reason, hub.town], ['hub_trip', 'Giran'], '500 x (60 - 5) = 27500 over 2 x 12200 + 2 x 0.1 h x 1000 = 24600');
    assert.ok(Math.abs(hub.at - (10 + 0.02 + 0.1)) < 1e-9, `now, plus the walk and the hop: ${hub.at}`);
    const short = trip({}, { ...base, stock: [{ id: 200, held: 400, rate: 0, npc: 5 }] });
    assert.deepEqual([short.reason, short.town], ['stock_low:shots', 'Gludio'], '400 x 55 = 22000 under 24600: the nearest town at its shot situation');
    const growing = trip({}, { ...base, stock: [{ id: 200, held: 400, rate: 100, npc: 5 }], shots: null });
    assert.equal(growing.reason, 'hub_trip');
    assert.ok(Math.abs(growing.at - (10 + (24600 / 55 - 400) / 100 / 0.5 + 0.12)) < 1e-6, `the gain turns positive at 47.3 more units: ${growing.at}`);
    assert.equal(trip({}, { ...base, near: { bids: { 200: { price: 60, qty: 10 } }, asks: {} } }).town, 'Gludio', 'the nearest town bids as much: no gain');
    assert.equal(trip({}, { ...base, money: 20000 }).town, 'Gludio', 'it cannot pay the fare there and back');
    assert.equal(trip({}, { ...base, tripTown: 'nearest' }).town, 'Gludio', 'the model before: always the nearest');
    const junk = { ...base, stock: [{ id: 200, held: 1e6, rate: 1000, npc: 5 }], towns: [{ ...giran, bids: { 200: { price: 5, qty: 1e9 } } }], bag: { slots: 80, used: 10, weight: 0, maxLoad: 1000, items: [{ rate: 100, weight: 10, stack: true, held: true }] } };
    const dumped = trip({}, junk);
    assert.deepEqual([dumped.reason, dumped.town], ['bag_full', 'Gludio'], 'a bid at the NPC price: junk goes to the nearest NPC however much of it');
    // A want: a line in Giran at 3000 for a piece capped at 5000 that no line or NPC in Gludio sells.
    const wanted = { ...base, stock: [], wants: [{ id: 100, qty: 1, cap: 5000 }], towns: [{ ...giran, fare: 500, asks: { 100: 3000 } }] };
    assert.equal(trip({}, wanted).town, 'Giran', '5000 - 3000 over 2 x 500 + 200');
    assert.equal(trip({}, { ...wanted, near: { bids: {}, asks: { 100: 3500 } } }).town, 'Gludio', 'Gludio sells it at 3500: 500 under the trip\'s 1200');
    assert.equal(trip({}, { ...wanted, money: 3500 }).town, 'Gludio', 'after the fares its money does not reach the line');
}

// hubKnown: a hub it never saw a book of is weighed at its own first prices
// (its last deal, else the game's first price), any quantity: the first trip
// there is a bet on its estimate. An estimate at the NPC's price is junk and
// never pays for the trip. trip names the towns whose gain is not positive
// (refused for want of gain).
{
    const base = { now: 10, since: 10, huntShare: 0.5, tripHours: 0.02, town: 'Gludio', stockLowHours: 1 / 6, loadShare: 2 / 3, ownHour: 1000,
        shots: { held: 600, perHour: 300, waiting: false }, bag: null, goal: null, tripTown: 'by_gain', money: 100000,
        stock: [{ id: 200, held: 500, rate: 0, npc: 5 }], wants: [], near: { bids: {}, asks: {} } };
    const hub = book => ({ town: 'Giran', fare: 12200, hours: 0.1, bids: book.buy, asks: Object.fromEntries(Object.entries(book.sell).map(([id, row]) => [id, row.price])) });
    const guess = Knowledge.estimated([], { 200: 60 }, [200]);
    assert.deepEqual(guess.buy[200], { price: 60, qty: Infinity }, 'the first price, any quantity');
    assert.equal(Knowledge.estimated([{ item: 200, enchant: 0, price: 40 }], { 200: 60 }, [200]).buy[200].price, 40, 'its own last deal before the first price');
    const bet = trip({}, { ...base, towns: [hub(guess)] });
    assert.deepEqual([bet.reason, bet.town, bet.refused], ['hub_trip', 'Giran', []], '500 x (60 - 5) over the trip\'s 24600');
    // Bet on an unseen hub only once: the visit found no line, three refused trips forget the book, the hub is not estimated again.
    {
        const hubs = ['Giran'], firstPrice = { 200: 60 };
        // As mains.tripTowns reads them: a town asleep (forgotten) is out of the view.
        const bookOf = (books, town, asleep = []) => (asleep.includes(town) ? null : books[town] ?? (hubs.includes(town) ? Knowledge.estimated([], firstPrice, [200]) : null));
        const towns = state => [bookOf(state.books, 'Giran', state.asleep)].filter(Boolean).map(hub);
        let state = { books: {}, refusals: {} };
        assert.equal(trip({}, { ...base, towns: [hub(bookOf(state.books, 'Giran'))] }).reason, 'hub_trip', 'never visited: estimated');
        state = { books: { Giran: Knowledge.remembered({ buy: {}, sell: {} }, { bids: [200], asks: [] }, 0).book }, refusals: {} };
        for (let i = 0; i < Knowledge.FORGET_REFUSALS; i++) {
            const answer = trip({}, { ...base, towns: [hub(bookOf(state.books, 'Giran'))] });
            assert.deepEqual([answer.town, answer.refused], ['Gludio', ['Giran']], 'the visited empty book: refused');
            state = Knowledge.afterVisit({ ...state, refused: answer.refused, visited: 'Gludio' });
        }
        const again = trip({}, { ...base, towns: towns(state) });
        assert.deepEqual([again.reason, again.town, state.asleep], ['stock_low:shots', 'Gludio', ['Giran']], 'forgotten: no second bet');
        // Forgotten only until something new is learned: a visit there wakes it (its book replaced by the caller).
        const woken = Knowledge.afterVisit({ ...state, refused: [], visited: 'Giran' });
        assert.deepEqual(woken.asleep, [], 'a visit there wakes it');
        assert.equal(trip({}, { ...base, towns: towns(woken) }).reason, 'hub_trip', 'and the hub is weighed again');
    }
    const junk = trip({}, { ...base, towns: [hub(Knowledge.estimated([], { 200: 5 }, [200]))] });
    assert.deepEqual([junk.reason, junk.town, junk.refused], ['stock_low:shots', 'Gludio', ['Giran']], 'an estimate at the NPC price: no trip, refused');
}

// The game's trade towns of a lot (MarketTownPolicy as data): anything of
// C and above in Giran, else anything of D in either D market (the account
// weighs them), else the market nearest the spot.
{
    const trade = { grade: { 1463: 'd', 71: 'c' }, none: { s1: 'Gludin' }, d: ['Gludio', 'Dion'], higher: 'Giran' };
    assert.deepEqual(Knowledge.tradeTowns(trade, { items: [200, 1463, 71], spotId: 's1' }), ['Giran']);
    assert.deepEqual(Knowledge.tradeTowns(trade, { items: [200, 1463], spotId: 's1' }), ['Gludio', 'Dion'], 'both D markets, no split by the bot\'s id');
    assert.deepEqual(Knowledge.tradeTowns(trade, { items: [200], spotId: 's1' }), ['Gludin']);
    assert.deepEqual(Knowledge.tradeTowns(undefined, { items: [200], spotId: 's1' }), [], 'no trade data: no hub');
}

// A remembered town book holds what trip reads, the asks first, then the
// bids by the adena they take, at most TOWN_BOOK_ROWS rows (the rest counted);
// a town refused for want of gain at three visits in a row is forgotten
// (asleep until a visit there, its twin there or a new grade), a visit there
// or a trip not refused starts its count again.
{
    const book = { buy: { 200: [{ owner: 1, price: 60, qty: 10 }], 201: [{ owner: 1, price: 9, qty: 1000 }], 202: [{ owner: 0, price: 99, qty: 99 }] },
        sell: { 100: [{ owner: 1, price: 3000, qty: 1 }], 200: [{ owner: 1, price: 70, qty: 5 }] } };
    const seen = Knowledge.remembered(book, { bids: [200, 201, 202], asks: [100] }, 0);
    assert.deepEqual(seen, { book: { buy: { 200: { price: 60, qty: 10 }, 201: { price: 9, qty: 1000 } }, sell: { 100: { price: 3000, qty: 1 } } }, dropped: 0 },
        'its own line and the ask of a thing it does not want are not kept');
    const many = { buy: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [300 + i, [{ owner: 1, price: 10 + i, qty: 1 }]])), sell: {} };
    const capped = Knowledge.remembered(many, { bids: Array.from({ length: 40 }, (_, i) => 300 + i), asks: [] }, 0);
    assert.equal(Object.keys(capped.book.buy).length, Knowledge.TOWN_BOOK_ROWS);
    assert.equal(capped.dropped, 40 - Knowledge.TOWN_BOOK_ROWS);
    assert.ok(!capped.book.buy[300] && capped.book.buy[339], 'the bids that take the least adena go');
    let state = { books: { Giran: seen.book, Dion: seen.book }, refusals: {} };
    const step = (refused, visited = 'Gludio') => { state = Knowledge.afterVisit({ ...state, refused, visited }); return state; };
    step(['Giran', 'Dion']); step(['Giran']);
    assert.deepEqual(state.refusals, { Giran: 2 }, 'Dion was not refused at the second visit: its count starts again');
    assert.deepEqual(step(['Giran', 'Dion']).forgotten, ['Giran'], 'the third refusal in a row: forgotten');
    assert.deepEqual([Object.keys(state.books), state.refusals, state.asleep], [['Dion'], { Dion: 1 }, ['Giran']], 'its book goes; it sleeps until something new is learned');
    assert.deepEqual(step(['Dion'], 'Dion').refusals, {}, 'a visit there starts its count again');
}

// The refill (the kit rule's): 'outing' carries shots for outingHours of
// hunting, so the next outing (ended at stock_low:shots) is as long whatever
// the last one was; 'last_outing' (the model before) carries the last
// outing's hours, so an outing's length copies itself (at least an hour).
{
    const nextOuting = (refill, lastOuting) => {
        const held = Math.ceil(300 * refillHours({ refill, outingHours: 2, minHours: 1, lastOuting }));
        const out = trip({}, { now: 0, since: 0, huntShare: 1, tripHours: 0, town: 'Gludio', stockLowHours: 1 / 6, loadShare: 2 / 3, ownHour: 0,
            shots: { held, perHour: 300, waiting: false }, bag: null, goal: null });
        assert.equal(out.reason, 'stock_low:shots');
        return out.at - 1 / 60;
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
    const ring = { selfId: 102, slot: 4, grade: 'd', weapon: false, cap: 900, capBy: 'npc', caps: null, routes: [{ route: 'npc', adena: 800, cost: 800, where: 'Giran' }] };
    const pair = { pieces: { 102: ring }, order: [{ kind: 'piece', selfId: 102, slot: 4 }, { kind: 'piece', selfId: 102, slot: 5 }], firstPrice: { 102: 800 } };
    const rich = visit(mainOf({ money: 5000, kit: { 4: 0, 5: 0 } }), viewOf(pair));
    assert.deepEqual([rich.main.kit[4], rich.main.kit[5], rich.main.money], [102, 102, 3400], 'two rings worn for two prices');
    const one = visit(mainOf({ money: 1000, kit: { 4: 0, 5: 0 } }), viewOf(pair));
    assert.deepEqual([one.main.kit[4], one.main.kit[5] || 0, Object.keys(one.main.wants)], [102, 0, ['102']], 'money for one: one worn, one open want');
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

// The keep rule at a visit (account_needs, ours): one piece a slot of its
// next grade's kit stays in its bag (a second copy is offered), the
// materials of a piece whose route is an order stay. The model before
// (sell_all_but_kit) sells them all.
{
    const keep = { keepRule: 'account_needs', order: [] };
    const ahead = visit(mainOf({ kit: { 7: 100 }, weapon: 100, bag: { 101: 1 } }), viewOf({ ...keep, ahead: [{ selfId: 101, slot: 10 }] }));
    assert.equal(ahead.main.bag[101], 1, 'the next grade\'s piece is kept');
    assert.equal(ahead.main.ads.wts.length, 0);
    const two = visit(mainOf({ kit: { 7: 100 }, weapon: 100, bag: { 101: 2 } }), viewOf({ ...keep, ahead: [{ selfId: 101, slot: 10 }] }));
    assert.deepEqual([two.main.bag[101], two.main.ads.wts[0]?.qty], [2, 1], 'one kept for the slot, the second offered on its WTS');
    const before = visit(mainOf({ kit: { 7: 100 }, weapon: 100, bag: { 101: 1 } }), viewOf({ order: [], ahead: [{ selfId: 101, slot: 10 }] }));
    assert.equal(before.main.ads.wts.length, 1, 'the model before offers it');
    const route = { route: 'order', adena: 1300, cost: 1500, materials: [{ selfId: 200, amount: 4, via: 'held', price: 0 }] };
    const pieces = { 100: { ...viewOf().pieces[100], routes: [route] } };
    const sold = out => out.stops.filter(stop => stop.kind === 'npc_sell').reduce((sum, stop) => sum + stop.items[0].count, 0);
    assert.equal(sold(visit(mainOf({ bag: { 200: 10 } }), viewOf({ ...keep, pieces }))), 6, 'four for the order stay');
    assert.equal(sold(visit(mainOf({ bag: { 200: 10 } }), viewOf({ order: [], pieces }))), 10);
    const emptied = visit(mainOf(), viewOf({ ...keep, twin: { wallet: 0, escrow: 0 }, surplus: { 200: 3 } }));
    assert.deepEqual([sold(emptied), emptied.claims.find(claim => claim.kind === 'own_stock')?.units], [3, 3], 'the warehouse\'s surplus is taken out and sold');
    assert.equal(emptied.claims.find(claim => claim.kind === 'own_stock').surplus, true, 'marked: its sale is not loot sold a second time');
    // Gear reaches its own twin as crystals only through the twin's
    // crystallizer bid, at the floor's channel: never straight to the warehouse.
    const armour = visit(mainOf({ kit: { 7: 100 }, weapon: 100, bag: { 101: 1 } }), viewOf({ ...keep, twin: { wallet: 0, escrow: 0 }, crystallizer: { d: 100 } }));
    assert.deepEqual([armour.stops.filter(stop => stop.kind === 'warehouse' && stop.target === 'deposit').length, armour.main.ads.wts.length], [0, 1], 'offered on its WTS');
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
// hour and counted; gear_gain (the design's text): the gear shares' gain
// times the own hour.
{
    const rung = { hour: 1500, gear: 0.3 }, worn = { hour: 1000, gear: 0.1 };
    assert.deepEqual(Worth.rungWorth({ formula: 'hunt_cycle', rung, worn, useHours: 10, ownHour: 800, gainBound: 1 }), { adena: 5000, perHour: 500, bounded: false }, '500 an hour x 10 h');
    assert.equal(Worth.rungWorth({ formula: 'gear_gain', rung, worn, useHours: 10, ownHour: 800, gainBound: 1 }).adena, 0.2 * 800 * 10, '0.2 x 800 x 10');
    const thin = Worth.rungWorth({ formula: 'hunt_cycle', rung: { hour: 1000, gear: 0 }, worn: { hour: -20000, gear: 0 }, useHours: 10, ownHour: 500, gainBound: 1, resale: 70 });
    assert.deepEqual([thin.adena, thin.bounded], [5070, true], 'a dying worn kit: the gain held to one own hour an hour, counted');
    // A weak worn kit still earns at an easier spot: 400 an hour, not a share of 10.
    assert.equal(Worth.rungWorth({ formula: 'hunt_cycle', rung: { hour: 410, gear: 0 }, worn: { hour: 10, gear: 0 }, useHours: 10, ownHour: 500, gainBound: 1 }).adena, 4000);
    assert.equal(Worth.rungWorth({ formula: 'hunt_cycle', rung: { hour: 900, gear: 0 }, worn, useHours: 10, ownHour: 500, gainBound: 1 }).adena, 0, 'a rung that lowers the hour');
    assert.deepEqual(Worth.rungWorth({ formula: 'hunt_cycle', rung, worn, useHours: 10, ownHour: 0, gainBound: 1, resale: 70 }), { adena: 70, perHour: 0, bounded: true }, 'no own hour: no gain an hour, the resale');
    assert.equal(Worth.rungWorth({ formula: 'hunt_cycle', rung: null, worn, useHours: 10, ownHour: 500, gainBound: 1 }).adena, null, 'no row, no worth');
}

// worthHorizon: an NPC-sold weapon (NPC 1000k, resale 500k at the NPC's
// buy price) whose hunt-hour gain is 10k an hour. Under the design's text
// its cap falls with the hours left in the grade (to 100k at 10 h, 0 at the
// end); under use_plus_resale it never falls under its resale while the
// main can use it, and reaches the NPC at 50 h of use.
{
    const rung = { hour: 30000, gear: 0 }, worn = { hour: 20000, gear: 0 }, npc = 1000000, resale = 500000;
    const capAt = (reading, hours) => {
        const h = Worth.horizon({ reading, gradeHours: hours, useHours: null, resale });
        return Bounds.cap({ worth: Worth.rungWorth({ formula: 'hunt_cycle', rung, worn, useHours: h.hours, ownHour: 20000, gainBound: 1, resale: h.resale }).adena, npcSell: npc }).cap;
    };
    assert.deepEqual([100, 10, 0].map(hours => capAt('grade_stage', hours)), [npc, 100000, 0], 'the design\'s text: the cap falls to nothing');
    assert.deepEqual([100, 50, 10, 0].map(hours => capAt('use_plus_resale', hours)), [npc, npc, 600000, 500000], 'never under the resale');
    assert.equal(Worth.horizon({ reading: 'use_plus_resale', gradeHours: 8, useHours: 30, resale }).hours, 30, 'worn on past its grade\'s end');
    assert.equal(Worth.horizon({ reading: 'grade_stage', gradeHours: 8, useHours: 30, resale }).hours, 8);
}

// path over the gear ladder: a slot's candidates (best first) are its
// rungs that beat the worn piece; best_priced takes the best a route prices,
// a slot none prices names its best candidate unrouted, after the rest
// (counted). The weapon goes first only for an unarmed main: one that holds
// a weapon below its grade refills its shots first.
{
    const kit = [{ slot: 7, group: 'weapon', worn: 1, held: false, candidates: [{ selfId: 10, slot: 14 }, { selfId: 11, slot: 7 }, { selfId: 12, slot: 7 }] },
        { slot: 10, group: '10', worn: 2, held: false, candidates: [{ selfId: 20, slot: 10 }] }];
    const view = { kit, weapons: { 10: true, 11: true, 12: true }, routes: { 10: null, 11: { route: 'npc', cost: 400, crystals: null }, 12: { route: 'npc', cost: 100 }, 20: null },
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
// queue moves on to the next piece; a cap its own route (a farm) sets takes
// that route at once. 'ladder' (the design's text) starts its WTB low.
{
    const cWeapon = { selfId: 100, slot: 7, grade: 'c', weapon: true, cap: 2400000, capBy: 'worth', caps: null, routes: [], noSeller: true };
    const armour = { selfId: 101, slot: 10, grade: 'c', weapon: false, cap: 6000, capBy: 'npc', caps: null, routes: [{ route: 'npc', adena: 5000, cost: 5000, where: 'Giran' }] };
    const order = [{ kind: 'reserve' }, { kind: 'piece', selfId: 100, slot: 7 }, { kind: 'piece', selfId: 101, slot: 10 }];
    const standingView = viewOf({ pieces: { 100: cWeapon, 101: armour }, order, buyerNoSeller: 'standing', book: { sell: { 101: [{ owner: 5, id: 'L5', price: 4500, qty: 1, kind: 'line' }] }, buy: {}, bids: {} } });
    let out = visit(mainOf(), standingView);
    assert.deepEqual([out.main.ads.wtb.map(ad => [ad.item, ad.price, ad.standing]), out.main.kit[10]], [[[100, 2400000, true]], 101], 'a standing WTB at the cap; the armour bought');
    const again = visit(out.main, standingView);
    assert.deepEqual([again.main.ads.wtb[0].price, again.main.ads.wtb[0].look, again.waits.filter(row => row.wait === 'wtb')], [2400000, 0, []], 'it stands unstepped, no second wait');
    const farmed = visit(mainOf(), viewOf({ pieces: { 100: { ...cWeapon, cap: 300000, capBy: 'route', routes: [{ route: 'farm', adena: 0, hours: 300, cost: 300000, where: 's1' }] } }, order: [order[1]], buyerNoSeller: 'standing' }));
    assert.deepEqual([farmed.main.wants[100].state, farmed.main.ads.wtb.length], ['farm', 1], 'its own route at once, the WTB standing beside it');
    const dropped = visit({ ...farmed.main, bag: { 100: 1 } }, viewOf({ pieces: { 100: { ...cWeapon, capBy: 'route' } }, order: [order[1]], buyerNoSeller: 'standing' }));
    assert.deepEqual(dropped.waits, [{ wait: 'farm', end: 'done' }, { wait: 'wtb', end: 'withdrawn' }], 'the piece came: both waits end');
    const ladder = visit(mainOf(), viewOf({ pieces: { 100: cWeapon }, order: [order[1]], firstPrice: { 100: 2000000 }, buyerNoSeller: 'ladder' }));
    assert.equal(ladder.main.ads.wtb[0].price, Math.floor(2000000 * 0.8), 'the design\'s text: the ladder\'s first look');
}

// The account warehouse keeps the main its next piece's money route: with
// its own twin's route first (no money) and the NPC at 450k next, the main
// keeps 450k and the rest goes to the twin's wallet.
{
    const axe = { selfId: 100, slot: 7, grade: 'd', weapon: true, cap: 500000, capBy: 'route', caps: null,
        routes: [{ route: 'twin', adena: 0, cost: 300000 }, { route: 'npc', adena: 450000, cost: 450000, where: 'Giran' }] };
    const out = visit(mainOf({ money: 600000, kit: { 7: 5 }, weapon: 5 }), viewOf({ pieces: { 100: axe }, order: [{ kind: 'piece', selfId: 100, slot: 7 }], twin: { wallet: 0, escrow: 0, inputs: 0, workshopMoney: 'with_reserve' } }));
    assert.deepEqual([out.main.money, out.wallet], [450000, 150000 - 30], 'the piece\'s 450k stays with the main (the deposit fee from the wallet)');
}

// orderMaterials 'customer_then_crafter': a C piece's order needs a
// crafted intermediate nobody supplies the main; the crafter brings it,
// priced at its first price (4000) into the fee. The design's text
// ('customer') has no order route.
{
    const view = { cap: Infinity, ownHour: 1000, hourCost: 'opportunity', useHour: 100, lines: [], npc: [],
        order: { recipeId: 9, fee: 1300, mp: 100, units: 1, materials: [{ selfId: 200, amount: 2, held: 2, sale: 5, line: null, npc: null, farmHours: 0 },
            { selfId: 201, amount: 1, held: 0, sale: 0, line: null, npc: null, farmHours: 0, crafter: 4000 }] } };
    assert.equal(acquire({ selfId: 1 }, { ...view, orderMaterials: 'customer' }), null, 'from its own materials alone: no route');
    const order = acquire({ selfId: 1 }, { ...view, orderMaterials: 'customer_then_crafter' });
    assert.deepEqual([order.route, order.adena, order.materials[1].via], ['order', 5300, 'crafter']);
    // At its visit it leaves its two units and the fee with the crafter's 4000 in it; the crafter brings the third.
    const piece = { selfId: 100, slot: 7, grade: 'c', weapon: true, cap: 9000, capBy: 'route', caps: null, routes: [{ ...order, where: null }], noSeller: true };
    const placed = visit(mainOf({ bag: { 200: 2 } }), viewOf({ pieces: { 100: piece }, order: [{ kind: 'piece', selfId: 100, slot: 7 }], keepRule: 'account_needs', buyerNoSeller: 'standing' }));
    assert.deepEqual([placed.orders[0].fee, placed.orders[0].materials, placed.orders[0].supplied, placed.main.money], [5300, { 200: 2 }, { 201: 1 }, 20000 - 5300]);
    const atRoute = visit(mainOf({ bag: { 200: 2 }, wants: { 100: { state: 'route', tries: 0 } } }), viewOf({ pieces: { 100: piece }, order: [{ kind: 'piece', selfId: 100, slot: 7 }], keepRule: 'account_needs' }));
    assert.deepEqual(atRoute.orders[0].materials, { 200: 2 }, 'a want at its route keeps the order\'s materials (not sold first)');
}

// Luxury takes its own twin's crystals through the account warehouse: 300 D
// crystals the twin holds, none on a line here, take the exchange.
{
    const piece = { selfId: 100, slot: 7, grade: 'c', weapon: true, cap: 90000, capBy: 'route', caps: null,
        routes: [{ route: 'exchange', adena: 30000, cost: 30000, where: 'Giran', grade: 'd', amount: 300, perCrystal: 100 }] };
    const view = viewOf({ pieces: { 100: piece }, order: [{ kind: 'piece', selfId: 100, slot: 7 }], ownCrystals: { 1458: 300 } });
    const out = visit(mainOf({ wants: { 100: { state: 'route', tries: 0 } } }), view);
    assert.deepEqual([out.main.kit[7], out.claims.map(row => [row.kind, row.item, row.units]), out.main.money], [100, [['own_stock', 1458, 300], ['exchange', 100, 300]], 20000]);
    assert.equal(visit(mainOf({ wants: { 100: { state: 'route', tries: 0 } } }), { ...view, ownCrystals: {} }).main.kit[7], 0, 'no crystals anywhere: no exchange');
}

// visit: a wait ends at its third visit unmet even when nothing caps the
// piece any more (its last route stalled, no worth stated).
{
    const uncapped = { 100: { ...viewOf().pieces[100], cap: null, capBy: 'worth', routes: [] } };
    const out = visit(mainOf({ wants: { 100: { state: 'farm', route: 'farm', seen: 2 } } }), viewOf({ pieces: uncapped }));
    assert.deepEqual([out.waits, out.stalled, out.main.wants[100]], [[{ wait: 'farm', end: 'failed' }], [{ selfId: 100, route: 'farm' }], undefined]);
}

// visit: the refill reserve is never stopped by a piece the main cannot pay.
// A main in grade D with a no-grade weapon, its D weapon's want at its route
// (NPC 1.06M) and 300k in hand buys its 3000 no-grade shots at the NPC (8)
// and leaves the weapon at its route; an unarmed main whose weapon comes
// first in the queue still refills after it.
{
    const weaponRoute = { 100: { selfId: 100, slot: 7, grade: 'd', weapon: true, cap: 1060000, capBy: 'npc', caps: null, routes: [{ route: 'npc', adena: 1060000, cost: 1060000, where: 'Giran' }] } };
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

// visit: an order's material it lacks with no line here waits in a farm
// wait, and is bought at a later visit where a line at or under its route
// price stands; then the order is placed.
{
    const orderRoute = { route: 'order', adena: 1400, cost: 1600, recipeId: 7, fee: 1300, mp: 100, materialsCost: 100, materials: [{ selfId: 200, amount: 10, via: 'line', price: 10 }] };
    const pieces = { 100: { ...viewOf().pieces[100], cap: 1600, capBy: 'route', routes: [orderRoute], visitsLeft: 1 } };
    const away = visit(mainOf(), viewOf({ pieces, order: [{ kind: 'piece', selfId: 100, slot: 7 }] }));
    assert.equal(away.main.wants[100].state, 'farm', 'the line stands in its twin\'s town: it waits');
    const here = visit(away.main, viewOf({ pieces, order: [{ kind: 'piece', selfId: 100, slot: 7 }], book: { sell: { 200: [{ owner: 5, id: 'M', price: 10, qty: 50, kind: 'line' }] }, buy: {}, bids: {} } }));
    assert.deepEqual(here.orders.map(row => row.materials[200]), [10], 'bought where the line stands, the order placed');
}

// stockSale 'accumulate': stock the town it visits does not buy, with a
// known price above the NPC's in another town, goes to the account
// warehouse (30 a stack) instead of the NPC; kept stock is sold at a visit
// where a line takes it; kept stock with no known price above the NPC goes
// to the NPC at the third such visit; units it brings without one go to the NPC now.
{
    const view = patch => viewOf({ pieces: {}, order: [], stockSale: 'accumulate', ...patch });
    const kept = visit(mainOf({ bag: { 200: 10 } }), view({ knownBids: { 200: { price: 40, qty: 100 } } }));
    assert.deepEqual([kept.stash, kept.flows.npcSales, kept.flows.warehouseFees, kept.main.money], [{ 200: 10 }, 0, -30, 20000 - 30], 'to the warehouse, the fee paid');
    assert.equal(visit(mainOf({ bag: { 200: 10 } }), view({ knownBids: { 200: { price: 40, qty: 100 } }, stockSale: 'where_it_stands' })).flows.npcSales, 50, 'the first version: the NPC where it stands');
    assert.equal(visit(mainOf({ bag: { 200: 10 } }), view({ knownBids: { 200: { price: 5, qty: 100 } } })).flows.npcSales, 50, 'a bid at the NPC price elsewhere: junk to the NPC');
    const line = { owner: 7, id: 'B7', price: 40, qty: 10, kind: 'line' };
    const sold = visit(mainOf(), view({ stash: { 200: 10 }, knownBids: {}, book: { sell: {}, buy: { 200: [line] }, bids: {} } }));
    assert.deepEqual(sold.claims.map(row => [row.kind, row.units, row.adena]), [['sell_line', 10, 400]], 'the kept stock sold where a line stands');
    assert.deepEqual([sold.stash, sold.flows.npcSales], [{}, 0]);
    const waiting = visit(mainOf({ bag: { 200: 4 } }), view({ stash: { 200: 10 }, stashLooks: { 200: 1 }, knownBids: {} }));
    assert.deepEqual([waiting.stash, waiting.stashLooks, waiting.flows.npcSales, waiting.flows.warehouseFees], [{ 200: 10 }, { 200: 2 }, 20, 0],
        'the second visit without a known price: the kept ten wait, the four it brought go to the NPC');
    const dumped = visit(mainOf(), view({ stash: { 200: 10 }, stashLooks: { 200: 2 }, knownBids: {} }));
    assert.deepEqual([dumped.stash, dumped.flows.npcSales], [{}, 50], 'the third: to the NPC');
    assert.deepEqual(visit(mainOf(), view({ stash: { 200: 10 }, stashLooks: { 200: 2 }, knownBids: { 200: { price: 40, qty: 100 } } })).stash, { 200: 10 }, 'a known price again: kept, its count reset');
    // Kept only up to the units the known line takes: 5 at 60 elsewhere keeps 5 of 10, the other 5 go to the NPC here.
    const five = visit(mainOf({ bag: { 200: 10 } }), view({ knownBids: { 200: { price: 60, qty: 5 } } }));
    assert.deepEqual([five.stash, five.flows.npcSales, five.flows.warehouseFees, five.main.bag[200] || 0], [{ 200: 5 }, 25, -30, 0], 'five kept, five to the NPC');
    const stale = visit(mainOf(), view({ stash: { 200: 10 }, knownBids: { 200: { price: 60, qty: 5 } } }));
    assert.deepEqual([stale.stash, stale.flows.npcSales, stale.flows.warehouseFees], [{ 200: 5 }, 25, 0], 'the warehouse keeps no more than the line takes');
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
    const view = goalNow => ({ now: 10, since: 10, huntShare: 0.5, tripHours: 0.02, town: 'Giran', stockLowHours: 1 / 6, loadShare: 2 / 3, ownHour: 1000, shots: null, bag: null, goal: goalNow });
    const parked = trip({}, view(goal('parked')));
    assert.equal(parked.reason, 'goal_affordable');
    assert.ok(Math.abs(parked.at - (10 + 2 / 0.5 + 0.02)) < 1e-9, `2000 more at 1000 a hunting hour: ${parked.at}`);
    assert.equal(goal('wtb'), null, 'a WTB stands for it: no goal');
    assert.equal(trip({}, view(goal('wtb'))).at, null);
    assert.equal(goalOf({ pieces, kit: { 7: 100 }, wants: { 100: { state: 'parked' } }, reserve: 0, money: 3000, bagValue: 0, perHour: 1000, fresh: false }), null, 'it wears the piece');
    assert.deepEqual(goal(null), { need: 5000, have: 3000, perHour: 1000, fresh: false }, 'a piece it does not want yet is the goal too');
}

console.log('PASS economy model market rules');
