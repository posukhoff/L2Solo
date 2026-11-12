'use strict';

// The design mode of the economy model: the account plane with crafter twins
// beside today's engine. The pure rules decide (rules/workshop, ownLines,
// knowledge, bounds, priceStep); this module builds their views from the
// run's state, commits their answers, keeps the town books (books.js) and
// counts what the design asks the model to print.
//
// Crafter accounts: every Bounty Hunter main and DESIGN.crafterShare of all
// accounts among the other mains (seeded per account). A twin is never
// stepped: an Artisan below 40 and a Warsmith from 40 at its main's highest
// level (ours), seated in a town, its MP a function of time. It acts at its
// account's wakes: its main's arrival in a town, a fill of one of its lines,
// the end of its craft batch (the one deadline the engine holds besides the
// mains' situations).
//
// Stand-ins until the mains' own market rules exist (each named in the
// printed footer): a main comes to town at the fitted periodic arrivals
// (Today.nextArrival), buys its kit pieces at the NPC (x1) as today's
// engine does, sells its stock to crafter buy lines in the town it visits
// (else the NPC) and its gear to a crystallizer bid in reach (else the NPC),
// and buys shots of its grade from twin sell lines in its town at or under a
// shot's worth to it, else hunts without them.
const Engine = require('./engine');
const Ledger = require('./ledger');
const Books = require('./books');
const Bounds = require('./rules/bounds');
const Knowledge = require('./rules/knowledge');
const Workshop = require('./rules/workshop');
const { ownLines } = require('./rules/ownLines');
const { hash, mulberry } = require('../hunt-tables/common');
const Weights = require('./weights');

// What the design leaves unsaid, and four readings of its text, at the
// values the model runs with. Every field is read by the code and printed
// with the run; a sweep varies them without code changes.
const DESIGN = Object.freeze({
    // Unsaid in the design: ours. The share of all accounts, among the mains
    // other than Bounty Hunters, whose twin is a crafter.
    crafterShare: Weights.PATIENT_CRAFTER_SHARE,
    // Unsaid in the design: ours. A craft batch is the crafts of one recipe
    // that this many hours of seated regen cover, at least one.
    batchHours: 1,
    // Unsaid in the design: ours (high sensitivity). An applied batch's units
    // start a new sell line at the known price with its step reset, the
    // unsold remainder keeps its step ('new_line'); or they join the unsold
    // line and its step ('continue').
    restockLine: 'new_line',
    // Unsaid in the design: ours. A twin re-seats at its main's arrival in a
    // town whose open buy lines for what it crafts reach this times its own
    // town's; it starts in the respawn town of its main's spot (late start)
    // or its main's race's starter village (fresh start).
    reseatFactor: 1.25,
    // Unsaid in the design: ours (high sensitivity). The crystallizer bid
    // (one standing bid per grade, P per crystal for any gear piece of the
    // grade, the only form built) asks for the crystals this many hours of
    // its best crystal recipe use.
    crystalStockHours: 10,
    // A dropped item's first price. 'band_hour' (the design's text): the
    // hours to farm one at the best row that drops it x that row's hour, so
    // a whole hour lands on each by-product. 'npc_floor': the NPC buy price.
    // 'hour_share' (ours, pending the maintainer): its NPC buy price x (the
    // row's hour / the NPC value of that hour's loot): the hour spread over
    // its loot by value, so one hour's drops at first prices sum to its income.
    firstPriceDrop: 'hour_share',
    // A crafted good's first price. 'inputs' (the design's text): its inputs'
    // cheapest routes with no MP term, so a new good's margin is at most
    // zero. 'inputs_plus_mp' (ours, pending the maintainer): the inputs plus
    // the chain's MP x a value per MP: for the twin that crafts it, the best
    // margin per MP among the goods it has sold, else mpStartValue; in the
    // game's table, mpStartValue.
    firstPriceCraft: 'inputs_plus_mp',
    // Adena per MP before a twin has sold anything (ours): Soulshot D's
    // margin per MP when it sells at the median D hunter's shot worth at x1
    // (12.5 a shot) against its inputs in Giran (3 Soul Ore at 275 and a D
    // crystal at ~600 through NPC gear: 9.1 a shot): (12.5 - 9.1) x 156 / 40.
    mpStartValue: 13,
    // What a look does to a seller's ask. 'every_look' (the design's text):
    // an arrival, a filled or an undercut line each step the ask down, and a
    // restocked line starts at the last deal. 'unsold_look' (ours, pending
    // the maintainer): the ask steps down only at a look where its stock
    // stayed unsold since the previous look; a fill holds it; a line that
    // sold out restarts one step up toward its starting price.
    sellerLook: 'unsold_look',
    // A crafter's floor. false (the design's text): max(npcBuy, the best
    // crystallizer bid in reach), and a negative margin stops the recipe.
    // true (ours, pending the maintainer): its ask never goes under its input
    // cost at its own unit costs; the line parks there, counted.
    askFloorAtCost: true,
    // Unsaid in the design: ours. A crafter account prices as the patient
    // crafter it stands for: the floor at the 5th look, the buyer starting at
    // 0.7 of its known price or cap.
    crafterPersona: Object.freeze({ looksToFloor: 5, buyerStart: 0.7 })
});
// The readings of the design's text and ours, by field (printed with the run).
const READINGS = Object.freeze({
    firstPriceDrop: Object.freeze({ text: 'band_hour', ours: 'hour_share' }),
    firstPriceCraft: Object.freeze({ text: 'inputs', ours: 'inputs_plus_mp' }),
    sellerLook: Object.freeze({ text: 'every_look', ours: 'unsold_look' }),
    askFloorAtCost: Object.freeze({ text: false, ours: true })
});
// C4 warehouse deposit fee per stack (Lisvus SendWareHouseDepositList).
const DEPOSIT_FEE = 30;
// A race's starter village (C4 newbie towns), by the template's race id.
const STARTER_VILLAGE = Object.freeze({ 0: 'Talking Island', 1: 'Elven Village', 2: 'Dark Elven Village', 3: 'Orc Village', 4: 'Dwarven Village' });
const BOUNTY_HUNTER = String(Weights.BOUNTY_HUNTER);
const STAND_INS = Object.freeze([
    'arrivals: a main comes to town at the fitted periodic rule (Today.nextArrival), not at the design\'s trip situations',
    'kit: a main buys its kit pieces at the NPC (x1) as today\'s engine does; no gear is bought from twins or other mains',
    'stock: a main sells materials and recipes to crafter buy lines in the town it visits, else the NPC; gear to a crystallizer bid in reach, else the NPC (no WTS/WTB ads)',
    'shots: a main buys shots of its grade from twin sell lines in its town at or under a shot\'s worth to it, else hunts without them',
    'mains post no WTB: no buyer line rises for want of shots, gear or anything else',
    'no twin buys from another twin: intermediates, crystals and scrolls move only from mains to twins',
    'arrows and intermediates have no buyer: they stay on the twin\'s shelf',
    'a crafted gear piece has no buyer yet: it stays shelved (one per recipe)',
    'no orders, so no manufacture mode: a twin sells or buys',
    'a twin re-seats only on other twins\' buy lines (no main\'s demand draws it)'
]);

const isMaterial = item => !Engine.isGear(item) && item?.kind !== 'Other.Recipe' && item?.kind !== 'Other.Shot';
const gradeOf = item => String(item?.grade || 'NONE').toLowerCase();
const median = values => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// The game data the rules read, built once per run from the snapshot and
// the design view: recipes indexed, NPC prices and the NPC gear route per
// town (x1), from each town the cheapest gear route it reaches with the
// gatekeeper fare (one piece: (fare + price) / crystals, the nearest seller
// as Engine.sellerOf finds it, or any town), the items something drops, and
// every item's first price.
function gameOf(snapshot, view, config = DESIGN) {
    const recipes = {}, byProduct = {}, byScroll = {}, dwarven = [], questRecipes = [];
    for (const row of snapshot.recipes) {
        recipes[row.recipeId] = row;
        (byProduct[row.productId] ||= []).push(row.recipeId);
        if (row.type !== 'dwarven') continue;
        if (row.quest) questRecipes.push(row.recipeId);
        else { dwarven.push(row.recipeId); byScroll[row.recipeItemId] = row.recipeId; }
    }
    const crystalIds = snapshot.crystalIds, crystalGrade = Object.fromEntries(Object.entries(crystalIds).map(([grade, id]) => [id, grade.toLowerCase()]));
    const sourced = Object.fromEntries(Object.entries(snapshot.sources || {}).filter(([, row]) => row.drop.length || row.spoil.length).map(([id]) => [id, true]));
    const npcByTown = {}, routeByTown = {}, npcMin = {}, routeMin = {};
    for (const [key, rows] of Object.entries(snapshot.npcOffers.x1)) {
        const id = Number(key), item = snapshot.items[id], grade = gradeOf(item);
        for (const { town, price } of rows) {
            (npcByTown[town] ||= {})[id] = Math.min(npcByTown[town][id] ?? Infinity, price);
            npcMin[id] = Math.min(npcMin[id] ?? Infinity, price);
            if (!Engine.isGear(item) || !(item.crystals > 0) || !crystalIds[grade.toUpperCase()]) continue;
            const perCrystal = price / item.crystals, held = (routeByTown[town] ||= {})[grade];
            if (!held || perCrystal < held.perCrystal) routeByTown[town][grade] = { perCrystal, gearId: id, price, crystals: item.crystals };
            routeMin[grade] = Math.min(routeMin[grade] ?? Infinity, perCrystal);
        }
    }
    const reachByTown = {};
    for (const from of Object.keys(view.fares)) {
        for (const [to, routes] of Object.entries(routeByTown)) {
            const fare = from === to ? 0 : view.fares[from]?.[to];
            if (fare === null || fare === undefined) continue;
            for (const [grade, route] of Object.entries(routes)) {
                const perCrystal = (fare + route.price) / route.crystals, held = (reachByTown[from] ||= {})[grade];
                if (!held || perCrystal < held.perCrystal) reachByTown[from][grade] = { perCrystal, town: to, fare };
            }
        }
    }
    return { recipes, byProduct, byScroll, dwarven, questRecipes, items: snapshot.items, crystalIds, crystalGrade, sourced, npcByTown, routeByTown, reachByTown,
        firstPrice: firstPrices(snapshot, view, { recipes, byProduct, crystalGrade, npcMin, routeMin, sourced, config }) };
}

// The first price of every item (bounds.firstPrice): its cheapest supplying
// route among farming it (config.firstPriceDrop, at the best line-level row
// that drops it), crafting it (its inputs at their first prices over the
// expected units, plus the MP at mpStartValue with firstPriceCraft
// 'inputs_plus_mp') and the NPC (x1); for a crystal also the NPC gear route.
function firstPrices(snapshot, view, { recipes, byProduct, crystalGrade, npcMin, routeMin, sourced, config }) {
    const farm = {}, dropAt = config.firstPriceDrop;
    if (dropAt === 'npc_floor') for (const id of Object.keys(sourced)) farm[id] = { farmHours: 1, bandHour: snapshot.items[id]?.npcBuy || 0 };
    for (const [line, byLevel] of dropAt === 'band_hour' || dropAt === 'hour_share' ? Object.entries(view.hours) : []) {
        for (const [key, hour] of Object.entries(byLevel)) {
            const row = hour.best, level = Number(key);
            if (!row || !(row.kills > 0)) continue;
            const per = Engine.designYieldRows(view, line, level, row, false).map(([id, perKill]) => [id, perKill * row.kills]);
            const loot = per.reduce((sum, [id, count]) => sum + count * (view.items[id]?.npcBuy || 0), 0);
            const income = row.adena * Engine.designAdenaFactor(view, row, level) + loot;
            for (const [id, count] of per) {
                // band_hour: 1 / count hours each; hour_share: the item's share of the loot's value per unit.
                const hours = dropAt === 'band_hour' ? 1 / count : loot > 0 ? (view.items[id]?.npcBuy || 0) / loot : 0;
                if (count > 0 && hours > 0 && (!farm[id] || income * hours < farm[id].bandHour * farm[id].farmHours)) farm[id] = { farmHours: hours, bandHour: income };
            }
        }
    }
    const mpWorth = config.firstPriceCraft === 'inputs_plus_mp' ? config.mpStartValue : 0;
    const gearByGrade = {};
    for (const [key, item] of Object.entries(snapshot.items)) {
        if (Engine.isGear(item) && item.crystals > 0) (gearByGrade[gradeOf(item)] ||= []).push({ id: Number(key), crystals: item.crystals });
    }
    const memo = {}, busy = new Set();
    const priceOf = id => {
        if (id in memo) return memo[id];
        if (busy.has(id)) return null;
        busy.add(id);
        let craft = null;
        for (const recipeId of byProduct[id] || []) {
            const recipe = recipes[recipeId];
            let cost = recipe.mpCost * mpWorth;
            for (const material of recipe.materials) {
                const price = priceOf(material.selfId);
                if (price === null) { cost = null; break; }
                cost += material.amount * price;
            }
            if (cost !== null) craft = Math.min(craft ?? Infinity, cost / (recipe.productCount * recipe.successRate / 100));
        }
        // A crystal also comes from crystallizing any gear piece of its grade.
        let route = crystalGrade[id] ? routeMin[crystalGrade[id]] ?? null : null;
        for (const piece of crystalGrade[id] ? gearByGrade[crystalGrade[id]] || [] : []) {
            const price = priceOf(piece.id);
            if (price !== null) route = Math.min(route ?? Infinity, price / piece.crystals);
        }
        busy.delete(id);
        const craftCost = craft === null ? route : route === null ? craft : Math.min(craft, route);
        memo[id] = Bounds.firstPrice({ farmHours: farm[id]?.farmHours ?? null, bandHour: farm[id]?.bandHour ?? null, craftCost, npcSell: npcMin[id] ?? null }).price;
        return memo[id];
    };
    const out = {};
    for (const id of Object.keys(snapshot.items)) { const price = priceOf(Number(id)); if (price !== null) out[id] = price; }
    return out;
}

// A twin's numbers at a level (the snapshot's twins row).
function twinStats(snapshot, level) {
    const row = snapshot.twins[Math.max(1, Math.min(level, Object.keys(snapshot.twins).length))];
    return { level, classId: row.classId, createItem: row.createItem, crystallize: row.crystallize, maxMp: row.maxMp, regen: row.mp, storeSlots: row.storeSlots };
}

// The waits the design counts (liveness): each opened wait ends done,
// withdrawn by its owner, failed, or at its one deadline, or is open at the end.
const WAITS = ['sellLine', 'buyLine', 'bid', 'batch', 'shotless'];
const wait = () => ({ opened: 0, done: 0, withdrawn: 0, failed: 0, deadline: 0 });

// The design plane for Engine.simulate. options: { snapshot, game, config,
// start: 'late' | 'fresh', grades: [[grade, fromLevel]] (D..S) }.
function plane({ snapshot, game, config = DESIGN, start = 'late', grades }) {
    return { sinks: ['warehouseFees'], start: context => startPlane({ snapshot, game, config, start, grades, ...context }) };
}

function startPlane({ snapshot, game, config, start, grades, view, mains, ledger, push, seed, rateOf }) {
    const books = Books.create(), accounts = [];
    const gradeOfLevel = level => grades.reduce((name, [grade, from]) => (level >= from ? grade : name), 'none');
    // A shot's grade is its column in the shot families (shot items carry no grade).
    const shotGrade = id => {
        const family = view.shotFamilies?.ids.find(ids => ids.includes(Number(id)));
        return family ? view.shotFamilies.grades[family.indexOf(Number(id))].toLowerCase() : 'none';
    };
    const stats = {
        goods: {}, shots: {}, shotsByTown: {}, shotWanted: {}, hourly: [], hour: {}, mp: { used: 0, available: 0, lost: 0 },
        seat: { sell: 0, buy: 0, idleSell: 0, idleBuy: 0 }, batchHours: 0, firsts: { crystal: {}, shot: {}, piece: {} },
        pieces: {}, entries: {}, materials: { own: 0, bought: 0, npc: 0 }, crystals: { bids: 0, own: 0, npcRoute: 0, used: 0 },
        recipes: {}, margins: {}, marginHour: {}, waits: Object.fromEntries(WAITS.map(kind => [kind, wait()])), counters: { wakes: 0, reseats: 0, failedCrafts: 0,
            gearCapped: 0, shotsOwn: 0, shotsLine: 0, shotsNpc: 0, visitsWithLine: 0, lineWorthIt: 0, lineAboveWorth: 0, deposits: 0, stintsKept: 0, stintsUnfilled: 0 },
        stopped: new Set(), botToBot: 0
    };
    const goods = (field, id, count) => { if (count) { const row = stats.goods[id] ||= {}; row[field] = (row[field] || 0) + count; } };
    const recipeRow = id => stats.recipes[view.recipeGrade[id] || 'none'] ||= { dropped: 0, soldToTwins: 0, kept: 0, learned: 0, toNpc: 0 };
    const isRecipe = id => view.items[id]?.kind === 'Other.Recipe';

    // An account is replaced, never edited: the plane owns the slot, put
    // writes the new object there and every reader takes accounts[index] afresh.
    const put = (index, patch) => (accounts[index] = { ...accounts[index], ...patch });
    const counterOf = index => put(index, { counter: accounts[index].counter + 1 }).counter;
    // The store's seat state of a twin: its mode while its store shows a
    // line, idle (by mode) while it shows none. Seat-hours accrue per state.
    const seatOf = twin => (twin.lines.length ? twin.mode : twin.mode === 'sell' ? 'idleSell' : 'idleBuy');
    const putTwin = (index, twin, now) => {
        const before = accounts[index].twin, key = seatOf(twin);
        let seat = before ? before.seat : { key, since: now };
        if (seat.key !== key) { stats.seat[seat.key] += now - seat.since; seat = { key, since: now }; }
        return put(index, { twin: { ...twin, seat } });
    };

    // Crafter accounts: every Bounty Hunter, and crafterShare of all accounts among the others by a seeded order.
    const hunting = mains.filter(main => !main.station);
    const others = hunting.filter(main => main.line !== BOUNTY_HUNTER).sort((a, b) => hash(`crafter:${seed}:${a.id}`) - hash(`crafter:${seed}:${b.id}`) || a.id - b.id);
    const chosen = new Set(others.slice(0, Math.round(config.crafterShare * hunting.length)).map(main => main.index));
    for (const main of mains) {
        const crafter = !main.station && (main.line === BOUNTY_HUNTER || chosen.has(main.index));
        let twin = null;
        if (crafter) {
            const row = Engine.spotRowOf(view, main), spotTown = row ? view.yields[`${row.spotId}@${main.level}`]?.town : null;
            const town = start === 'fresh' ? STARTER_VILLAGE[snapshot.races?.[main.line]] || spotTown : spotTown || STARTER_VILLAGE[snapshot.races?.[main.line]];
            twin = { ...twinStats(snapshot, main.level), town, mode: 'sell', stint: { since: 0, units: 0, goods: '' }, stints: {}, lines: [], bids: [], mp: 0, mpAt: 0,
                recipes: [], decided: [], stock: {}, paid: {}, wallet: 0, batch: null, parked: {}, soldOut: {}, mpFrom: 0, highest: main.level, seat: { key: 'idleSell', since: 0 } };
        }
        accounts.push({ index: main.index, crafter, persona: config.crafterPersona, memory: [], twin, counter: 0, lastTown: null, wake: null, shotless: false, level: main.level });
    }
    // Items held at the start (the goods ledger's opening stock).
    const holdings = () => {
        const out = {};
        const add = (id, count) => { if (Number(id) > 0 && count > 0) out[id] = (out[id] || 0) + count; };
        for (const main of mains) {
            if (main.station) continue;
            for (const [id, count] of Object.entries(main.bag)) add(id, count);
            for (const [id, count] of Object.entries(main.shots)) add(id, count);
            for (const id of Object.values(main.kit)) add(id, 1);
            if (main.weapon && !Object.values(main.kit).includes(main.weapon)) add(main.weapon, 1);
        }
        for (const account of accounts) if (account.twin) for (const [id, count] of Object.entries(account.twin.stock)) add(id, count);
        return out;
    };
    const opening = holdings();
    const walletSum = () => accounts.reduce((sum, account) => sum + (account.twin ? account.twin.wallet : 0), 0);
    const moneyStart = walletSum();
    // Money of crafter accounts (main and twin) and of the others at the start.
    const moneyByKind = list => {
        const out = { crafters: { accounts: 0, money: 0 }, others: { accounts: 0, money: 0 } };
        for (const main of list) {
            if (main.station) continue;
            const account = accounts[main.index], row = account.twin ? out.crafters : out.others;
            row.accounts++; row.money += main.money + (account.twin ? account.twin.wallet : 0);
        }
        return out;
    };
    const moneyAtStart = moneyByKind(mains);

    const wakeAt = (index, now, reason) => {
        const account = accounts[index];
        if (!account.twin) return;
        if (account.wake && account.wake.at === now) { put(index, { wake: { at: now, reasons: [...account.wake.reasons, reason] } }); return; }
        put(index, { wake: { at: now, reasons: [reason] } });
        push({ at: now, kind: 'account_wake', who: index });
    };
    const placeLines = index => { const twin = accounts[index].twin; Books.place(books, index, twin.town, twin.lines, twin.bids); };
    // A twin's sell lines never list more than it holds.
    const clampLines = (lines, stock) => {
        const left = { ...stock };
        return lines.map(line => {
            if (line.side !== 'sell') return line;
            const qty = Math.min(line.qty, Math.max(0, left[line.item] || 0));
            left[line.item] = (left[line.item] || 0) - qty;
            return qty === line.qty ? line : { ...line, qty };
        }).filter(line => line.side !== 'sell' || line.qty > 0);
    };
    const firstAt = (table, key, now, extra) => { if (!(key in table)) table[key] = extra ? { h: now, ...extra } : now; };
    const hoursToGrade = main => {
        const next = grades.find(([, from]) => from > main.level), row = Engine.spotRowOf(view, main), share = rateOf(main.band).huntShare;
        if (!next || !(row?.exp > 0) || !(share > 0)) return 0;
        return Math.max(0, Engine.expAt(view, Math.min(next[1], view.maxLevel)) - main.exp) / (row.exp * share);
    };
    const markMp = (twin, now) => { stats.mp.available += twin.regen * Math.max(0, now - twin.mpFrom); return { ...twin, mpFrom: now }; };

    // The rules' view of an account's twin at a wake.
    const viewOf = (index, now, applied = null, rankRecipes = false) => {
        const account = accounts[index], twin = account.twin, main = mains[index];
        return { now, self: index, place: { town: account.lastTown, twinTown: twin.town }, books: books.towns, memory: account.memory, persona: account.persona,
            config, twin, game, npcSell: game.npcByTown[twin.town] || {}, crystalRoute: game.routeByTown[twin.town] || {}, crystalReach: game.reachByTown[twin.town] || {},
            applied, hoursToGrade: hoursToGrade(main), fares: view.fares, rankRecipes };
    };

    // A twin's money moves: its account's flows go to its main's start band.
    const flow = (index, kind, adena) => { if (adena) Ledger.recordFlows(ledger, index, { [kind]: adena }); };

    // One wake of an account: the workshop decides, the engine commits.
    function wake(index, now, reason, applied = null) {
        stats.counters.wakes++;
        let twin = accounts[index].twin;
        const arrivedIn = accounts[index].lastTown;
        if (reason === 'main_arrived' && arrivedIn && arrivedIn !== twin.town) {
            const town = Workshop.seat(viewOf(index, now), arrivedIn);
            if (town !== twin.town) {
                const fare = view.fares[twin.town][town];
                flow(index, 'fares', -fare);
                twin = putTwin(index, { ...twin, town, wallet: twin.wallet - fare }, now).twin;
                stats.counters.reseats++;
            }
        }
        const decision = Workshop.workshop(viewOf(index, now, applied, reason === 'main_arrived'));
        stats.counters.gearCapped += decision.counters.gearCapped;
        for (const id of decision.counters.stopped) stats.stopped.add(`${index}:${id}`);
        const stock = { ...twin.stock }, paid = { ...twin.paid };
        let wallet = twin.wallet;
        const recipes = twin.recipes.filter(id => !decision.forget.includes(id));
        for (const id of decision.learn) {
            const scroll = game.recipes[id].recipeItemId;
            stock[scroll]--;
            goods('learned', scroll, 1);
            recipeRow(scroll).learned++;
            recipes.push(id);
        }
        const crystallize = (piece, count, perPiecePaid, source) => {
            const item = view.items[piece], grade = gradeOf(item), crystal = game.crystalIds[grade.toUpperCase()], made = count * item.crystals;
            goods('crystalIn', piece, count);
            goods('crystalOut', crystal, made);
            stats.crystals[source] += made;
            const before = (stock[crystal] || 0) * (paid[crystal] ?? 0);
            stock[crystal] = (stock[crystal] || 0) + made;
            paid[crystal] = (before + count * perPiecePaid) / stock[crystal];
            firstAt(stats.firsts.crystal, grade, now);
        };
        for (const piece of decision.crystallize) {
            stock[piece.selfId] -= piece.count;
            const source = (twin.bought?.[piece.selfId] || 0) > 0 ? 'bids' : 'own';
            crystallize(piece.selfId, piece.count, paid[piece.selfId] ?? view.items[piece.selfId].npcBuy, source);
        }
        for (const buy of decision.npcBuys) {
            const cost = buy.count * buy.price;
            wallet -= cost;
            flow(index, 'npcBuys', -cost);
            goods('fromNpc', buy.selfId, buy.count);
            stock[buy.selfId] = (stock[buy.selfId] || 0) + buy.count;
            paid[buy.selfId] = buy.price;
            if (isMaterial(view.items[buy.selfId])) stats.materials.npc += buy.count;
        }
        for (const buy of decision.routeBuys) {
            wallet -= buy.count * buy.price;
            flow(index, 'npcBuys', -buy.count * buy.price);
            goods('fromNpc', buy.selfId, buy.count);
            crystallize(buy.selfId, buy.count, buy.price, 'npcRoute');
            stats.materials.npc += buy.count * buy.crystals;
        }
        let batch = twin.batch;
        if (decision.batch) {
            const recipe = game.recipes[decision.batch.recipeId];
            for (const material of recipe.materials) {
                const used = decision.batch.crafts * material.amount;
                stock[material.selfId] -= used;
                goods('craftIn', material.selfId, used);
                if (game.crystalGrade[material.selfId]) stats.crystals.used += used;
            }
            stats.mp.lost += Math.max(0, twin.regen * (now - twin.mpAt) - (twin.maxMp - twin.mp));
            stats.mp.used += decision.batch.crafts * recipe.mpCost;
            batch = { ...decision.batch, start: now };
            stats.waits.batch.opened++;
            push({ at: batch.deadline, kind: 'batch_done', who: index });
            const product = view.items[recipe.productId];
            if (product?.kind === 'Other.Shot') (stats.marginHour[shotGrade(recipe.productId)] ||= []).push(decision.batch.perMp);
        }
        if (decision.stintEnded === 'kept') stats.counters.stintsKept++; else if (decision.stintEnded === 'unfilled') stats.counters.stintsUnfilled++;
        const roll = mulberry(hash(`${seed}:wake:${index}:${counterOf(index)}`))();
        const linesReason = reason === 'batch_done' ? 'batch_applied' : reason;
        const persona = accounts[index].persona;
        const priced = ownLines(twin.lines, { wanted: decision.wanted, prices: decision.prices, persona, sellerLook: config.sellerLook, roll }, linesReason);
        const bids = ownLines(twin.bids, { wanted: decision.bidWanted, prices: decision.bidPrices, persona, sellerLook: config.sellerLook, roll: roll + 0.5 }, linesReason);
        const parked = { ...twin.parked };
        const known = new Set([...twin.lines, ...twin.bids].map(line => line.id));
        for (const [result, kindOf] of [[priced, line => (line.side === 'sell' ? 'sellLine' : 'buyLine')], [bids, () => 'bid']]) {
            for (const line of result.lines) if (!known.has(line.id)) stats.waits[kindOf(line)].opened++;
            for (const { line, why } of result.closed) {
                if (!known.has(line.id)) continue;
                stats.waits[kindOf(line)][why === 'withdrawn' ? 'withdrawn' : 'failed']++;
                if (why === 'parked' || why === 'own_route') parked[line.item] = true;
            }
        }
        // Its last ask per good it still holds (the price the workshop reads for unsold goods).
        const asks = {};
        for (const [item, price] of Object.entries(twin.asks || {})) if ((stock[item] || 0) > 0) asks[item] = price;
        for (const line of priced.lines) if (line.side === 'sell') asks[line.item] = Math.min(line.price, asks[line.item] ?? Infinity);
        // A sold-out line's step is remembered until a line of the good opens again.
        const soldOut = { ...twin.soldOut };
        for (const line of priced.lines) if (line.side === 'sell') delete soldOut[line.item];
        putTwin(index, { ...twin, stock, paid, wallet, recipes, decided: decision.want, wants: decision.wants, batch, mode: decision.mode, stint: decision.stint, stints: decision.stints, parked, asks, soldOut,
            lines: clampLines(priced.lines, stock), bids: bids.lines, bought: {} }, now);
        placeLines(index);
    }

    // The end of a craft batch at its MP deadline: products by a seeded roll
    // per craft (a failed craft destroys its inputs, which the batch's start took).
    function batchDone(index, now) {
        const twin = accounts[index].twin, batch = twin.batch;
        if (!batch || batch.deadline !== now) return;
        const recipe = game.recipes[batch.recipeId], random = mulberry(hash(`${seed}:batch:${index}:${counterOf(index)}`));
        let made = 0;
        for (let i = 0; i < batch.crafts; i++) if (recipe.successRate >= 100 || random() * 100 < recipe.successRate) made++;
        stats.counters.failedCrafts += batch.crafts - made;
        const units = made * recipe.productCount, product = view.items[recipe.productId], grade = gradeOf(product);
        goods('crafted', recipe.productId, units);
        if (units && product?.kind === 'Other.Shot') firstAt(stats.firsts.shot, shotGrade(recipe.productId), now);
        if (units && Engine.isGear(product)) { firstAt(stats.firsts.piece, grade, now, { selfId: recipe.productId }); stats.pieces[grade] = (stats.pieces[grade] || 0) + made; }
        stats.batchHours += now - batch.start;
        stats.waits.batch.deadline++;
        const mp = Math.max(0, batch.mpAtStart + twin.regen * (now - batch.start) - batch.crafts * recipe.mpCost);
        putTwin(index, { ...twin, batch: null, mp: Math.min(twin.maxMp, mp), mpAt: now, stock: { ...twin.stock, [recipe.productId]: (twin.stock[recipe.productId] || 0) + units } }, now);
        wake(index, now, 'batch_done', { item: recipe.productId, units });
    }

    // A main takes units from a twin's line (sell) or fills its buy line or
    // bid: money and goods move between the two accounts, both remember the
    // price, the twin's line shrinks (its units sold since its last look
    // grow) and its account wakes on the fill.
    function deal(buyerOrSeller, owner, entry, side, item, count, price, now) {
        const twin = accounts[owner].twin;
        const lines = side === 'bids' ? twin.bids : twin.lines;
        const line = lines.find(row => row.id === entry.id);
        // A bid's units are crystals: a piece fills its crystals at the price per crystal.
        const units = side === 'bids' ? count * view.items[item].crystals : count, adena = units * price;
        const next = lines.map(row => (row === line ? { ...row, qty: row.qty - units, sold: (row.sold || 0) + units } : row)).filter(row => row.qty > 0);
        const stock = { ...twin.stock }, paid = { ...twin.paid };
        let wallet = twin.wallet, bought = twin.bought || {}, soldOut = twin.soldOut;
        if (side === 'sell') {
            stock[item] -= count; wallet += adena;
            if (line && line.qty - units <= 0) soldOut = { ...soldOut, [item]: { start: line.start, look: line.look } };
        } else {
            stock[item] = (stock[item] || 0) + count;
            paid[item] = adena / count;
            wallet -= adena;
            bought = { ...bought, [item]: (bought[item] || 0) + count };
        }
        const crystalId = side === 'bids' ? game.crystalIds[gradeOf(view.items[item]).toUpperCase()] : item;
        put(owner, { memory: Knowledge.remember(accounts[owner].memory, { item: crystalId, price }) });
        put(buyerOrSeller, { memory: Knowledge.remember(accounts[buyerOrSeller].memory, { item, price: adena / count }) });
        if (line && line.qty - units <= 0) stats.waits[side === 'sell' ? 'sellLine' : side === 'buy' ? 'buyLine' : 'bid'].done++;
        // A stint counts the fills of its own store's lines, not of its bids.
        const stint = side === twin.mode ? { ...twin.stint, units: twin.stint.units + count } : twin.stint;
        putTwin(owner, { ...twin, stock, paid, wallet, bought, stint, soldOut,
            lines: side === 'bids' ? twin.lines : clampLines(next, stock), bids: side === 'bids' ? next : twin.bids }, now);
        placeLines(owner);
        stats.botToBot += adena;
        return adena;
    }

    // A shot's worth to a hunter at its row: (the hour with shots - without) /
    // shots per hour, adena and loot at the NPC's buy price. Memo key: line,
    // level, spot (the row's inputs).
    const worthMemo = new Map();
    const shotWorth = main => {
        const row = Engine.spotRowOf(view, main);
        if (!row || !(row.shots > 0)) return 0;
        const key = `${main.line}@${main.level}@${row.spotId}`;
        if (worthMemo.has(key)) return worthMemo.get(key);
        const income = (r, bare) => r.adena * Engine.designAdenaFactor(view, row, main.level)
            + Engine.designYieldRows(view, main.line, main.level, r, bare).reduce((sum, [id, perKill]) => sum + perKill * r.kills * (view.items[id]?.npcBuy || 0), 0);
        const bare = row.shotless ? { ...row, ...row.shotless } : null;
        const worth = Math.max(0, (income(row, false) - (bare ? income(bare, true) : 0)) / row.shots);
        worthMemo.set(key, worth);
        return worth;
    };

    // At the start: the share of mains, per shot grade, whose shot is worth
    // its first price to them (the price a twin asks before any deal).
    const worthAtStart = {};
    for (const main of hunting) {
        const hour = Engine.hourOf(view, main), row = Engine.spotRowOf(view, main);
        if (!hour?.shotId || !(row?.shots > 0)) continue;
        const id = Engine.shotOf(view, main, hour), grade = shotGrade(id), price = game.firstPrice[id];
        const entry = worthAtStart[grade] ||= { mains: 0, worthAtOrAboveFirstPrice: 0 };
        entry.mains++;
        if (price !== undefined && shotWorth(main) >= price) entry.worthAtOrAboveFirstPrice++;
    }

    // The design visit: a pair's main leaves its twin what it uses, sells the
    // rest to buy lines or the NPC, pools the account's money, takes shots
    // from its twin and buys them from lines, and buys its kit at the NPC.
    function visitMain(main, now, { outingHours }) {
        const index = main.index, hour = Engine.hourOf(view, main), row = Engine.spotRowOf(view, main);
        const town = row ? view.yields[`${row.spotId}@${main.level}`]?.town || null : null;
        const flows = { huntCold: 0, npcSales: 0, fixedBuyers: 0, npcBuys: 0, fixedSellers: 0, fares: 0, warehouseFees: 0 };
        const delta = { flows, towns: [], gearToNpc: 0, gearBought: 0, shotsBoughtFixed: 0, shotsBoughtNpc: 0, shotsSoldNpc: 0, unsold: 0, missingPieces: 0, missingShots: 0, noTown: 0 };
        if (!town) { delta.noTown = 1; return { main, delta }; }
        delta.towns.push(town);
        put(index, { lastTown: town });
        let money = main.money;
        const bag = { ...main.bag };
        const toNpc = (id, count) => {
            const value = Math.round(count * (view.items[id]?.npcBuy || 0));
            if (!(value > 0)) { delta.unsold += count; return; }
            flows.npcSales += value; money += value;
            goods('toNpc', id, count);
            if (Engine.isGear(view.items[id])) delta.gearToNpc += count;
            if (isRecipe(id)) recipeRow(id).toNpc += count;
        };
        // A pair's main leaves its twin what it uses, a deposit fee per stack.
        if (accounts[index].twin) {
            const twin = accounts[index].twin, left = Workshop.depositFor(bag, twin, game, twin.decided);
            const stock = { ...twin.stock }, paid = { ...twin.paid };
            for (const [key, count] of Object.entries(left)) {
                if (money < DEPOSIT_FEE) break;
                const id = Number(key);
                money -= DEPOSIT_FEE; flows.warehouseFees -= DEPOSIT_FEE;
                stock[id] = (stock[id] || 0) + count;
                paid[id] = paid[id] ?? view.items[id]?.npcBuy ?? 0;
                bag[id] -= count;
                if (!bag[id]) delete bag[id];
                stats.counters.deposits++;
                if (isRecipe(id)) recipeRow(id).kept += count; else if (isMaterial(view.items[id])) stats.materials.own += count;
            }
            putTwin(index, { ...twin, stock, paid }, now);
        }
        // Gear goes to the best crystallizer bid in reach above the NPC price
        // (its own twin's through the warehouse), else to the NPC.
        const sellGear = id => {
            const item = view.items[id], grade = gradeOf(item), crystals = item?.crystals || 0;
            const twin = accounts[index].twin;
            let best = null;
            if (crystals > 0) {
                for (const entry of Books.rowsOf(books, town, 'bids', grade)) {
                    if (entry.owner === index || entry.qty < crystals) continue;
                    if (accounts[entry.owner].twin.wallet >= crystals * entry.price && (!best || entry.price > best.entry.price)) best = { entry, own: false };
                }
                const ownBid = twin?.bids.find(bid => bid.item === grade && bid.qty >= crystals);
                if (ownBid && (!best || ownBid.price > best.entry.price)) best = { entry: ownBid, own: true };
            }
            const floor = Bounds.floor({ npcBuy: item?.npcBuy || 0, crystallizerBids: best ? [best.entry.price * crystals] : [] });
            if (!best || !(floor > (item?.npcBuy || 0))) return toNpc(id, 1);
            if (best.own) {
                const bids = twin.bids.map(bid => (bid === best.entry ? { ...bid, qty: bid.qty - crystals } : bid)).filter(bid => bid.qty > 0);
                putTwin(index, { ...twin, bids, stock: { ...twin.stock, [id]: (twin.stock[id] || 0) + 1 }, paid: { ...twin.paid, [id]: item.npcBuy || 0 } }, now);
                placeLines(index);
                return;
            }
            money += deal(index, best.entry.owner, best.entry, 'bids', id, 1, best.entry.price, now);
            wakeAt(best.entry.owner, now, 'fill');
        };
        for (const [key, count] of Object.entries(bag)) {
            const id = Number(key), item = view.items[id];
            if (Engine.isGear(item)) { for (let i = 0; i < count; i++) sellGear(id); continue; }
            let left = count;
            for (const entry of [...Books.rowsOf(books, town, 'buy', id)]) {
                if (left <= 0 || entry.owner === index || entry.price < (item?.npcBuy || 0)) continue;
                const seller = accounts[entry.owner], live = seller.twin.lines.find(line => line.id === entry.id);
                const units = Math.min(left, live?.qty || 0, Math.floor(seller.twin.wallet / entry.price));
                if (units <= 0) continue;
                money += deal(index, entry.owner, entry, 'buy', id, units, entry.price, now);
                wakeAt(entry.owner, now, 'fill');
                left -= units;
                if (isRecipe(id)) recipeRow(id).soldToTwins += units; else if (isMaterial(item)) stats.materials.bought += units;
            }
            if (left > 0) toNpc(id, left);
        }
        // Shots of a grade it no longer fires go to the NPC.
        const firing = Engine.shotOf(view, main, hour), shots = {};
        for (const [key, count] of Object.entries(main.shots)) {
            if (Number(key) === firing || !count) { if (count) shots[key] = count; continue; }
            toNpc(Number(key), count); delta.shotsSoldNpc += count;
        }
        // The account warehouse pools the money: the main keeps its next outing's shots and its next kit piece.
        const errands = Engine.errands({ ...main, shots }, view, hour, { outingHours });
        const shotErrand = errands.find(errand => errand.kind === 'shots');
        const nextPiece = errands.find(errand => errand.kind === 'piece'), piecePrice = nextPiece ? Engine.sellerOf(view, nextPiece.id, town)?.price || 0 : 0;
        const shotPrice = shotErrand ? Knowledge.known(accounts[index].memory, shotErrand.id) ?? Books.rowsOf(books, town, 'sell', shotErrand.id)[0]?.price ?? 0 : 0;
        if (accounts[index].twin) {
            const twin = accounts[index].twin, escrow = twin.lines.filter(line => line.side === 'buy').reduce((sum, line) => sum + line.qty * line.price, 0)
                + twin.bids.reduce((sum, bid) => sum + bid.qty * bid.price, 0);
            const pooled = Workshop.pool({ main: money, wallet: twin.wallet, escrow, keep: (shotErrand ? shotErrand.amount * shotPrice : 0) + piecePrice });
            let wallet = pooled.wallet;
            money = pooled.main;
            if (pooled.moved > 0 && wallet >= DEPOSIT_FEE) { wallet -= DEPOSIT_FEE; flows.warehouseFees -= DEPOSIT_FEE; } else if (pooled.moved > 0 && money >= DEPOSIT_FEE) { money -= DEPOSIT_FEE; flows.warehouseFees -= DEPOSIT_FEE; }
            putTwin(index, { ...twin, wallet }, now);
        }
        // Shots: its twin's stock first, then twin lines in town at or under the shot's worth, then an NPC here.
        if (shotErrand) {
            let need = shotErrand.amount;
            const id = shotErrand.id, twin = accounts[index].twin;
            if (twin && (twin.stock[id] || 0) > 0) {
                const take = Math.min(need, twin.stock[id]), stock = { ...twin.stock, [id]: twin.stock[id] - take };
                putTwin(index, { ...twin, stock, lines: clampLines(twin.lines, stock) }, now);
                placeLines(index);
                shots[id] = (shots[id] || 0) + take; need -= take; stats.counters.shotsOwn += take;
            }
            const worth = shotWorth(main), rows = Books.rowsOf(books, town, 'sell', id).filter(entry => entry.owner !== index);
            if (rows.length) { stats.counters.visitsWithLine++; if (rows[0].price <= worth) stats.counters.lineWorthIt++; else stats.counters.lineAboveWorth++; }
            for (const entry of [...rows]) {
                if (need <= 0 || entry.price > worth || money < entry.price) break;
                const live = accounts[entry.owner].twin.lines.find(line => line.id === entry.id), units = Math.min(need, live?.qty || 0, Math.floor(money / entry.price));
                if (units <= 0) continue;
                money -= deal(index, entry.owner, entry, 'sell', id, units, entry.price, now);
                wakeAt(entry.owner, now, 'fill');
                shots[id] = (shots[id] || 0) + units; need -= units; stats.counters.shotsLine += units;
            }
            const npc = game.npcByTown[town]?.[id];
            if (need > 0 && npc > 0 && npc <= worth) {
                const units = Math.min(need, Math.floor(money / npc));
                if (units > 0) { money -= units * npc; flows.npcBuys -= units * npc; goods('fromNpc', id, units); shots[id] = (shots[id] || 0) + units; need -= units; delta.shotsBoughtNpc += units; stats.counters.shotsNpc += units; }
            }
            if (need > 0) delta.missingShots++;
            const holds = (shots[id] || 0) > 0, shotless = accounts[index].shotless;
            if (!holds && !shotless) { put(index, { shotless: true }); stats.waits.shotless.opened++; } else if (holds && shotless) { put(index, { shotless: false }); stats.waits.shotless.done++; }
        }
        // Kit pieces at the NPC (x1), one onward hop to the nearest town that sells the first one missing.
        const kit = { ...main.kit };
        let weapon = main.weapon;
        const buyPiece = (errand, seller) => {
            if (money < seller.price) return false;
            money -= seller.price; flows.npcBuys -= seller.price; delta.gearBought++;
            goods('fromNpc', errand.id, 1);
            const worn = kit[errand.slot];
            kit[errand.slot] = errand.id;
            if (Engine.isWeapon(view.items[errand.id])) {
                if (weapon && weapon !== worn && !Object.values(main.kit).includes(weapon)) sellGear(weapon);
                weapon = errand.id;
            }
            if (worn) sellGear(worn);
            return true;
        };
        let open = errands.filter(errand => errand.kind === 'piece').filter(errand => {
            const seller = Engine.sellerOf(view, errand.id, town);
            return !(seller?.fare === 0 && buyPiece(errand, seller));
        });
        const first = open.map(errand => ({ errand, seller: Engine.sellerOf(view, errand.id, town) })).find(entry => entry.seller && entry.seller.fare > 0);
        if (first && money >= first.seller.fare + first.seller.price) {
            money -= first.seller.fare; flows.fares -= first.seller.fare;
            delta.towns.push(first.seller.town);
            open = open.filter(errand => { const seller = Engine.sellerOf(view, errand.id, first.seller.town); return !(seller?.fare === 0 && buyPiece(errand, seller)); });
        }
        delta.missingPieces += open.length;
        if (accounts[index].twin) wakeAt(index, now, 'main_arrived');
        return { main: { ...main, money, bag: {}, shots, kit, weapon }, delta };
    }

    return {
        hunt(main, delta) {
            for (const [id, count] of delta.drops) { goods('drop', id, count); if (isRecipe(id)) recipeRow(id).dropped += count; }
            if (!delta.shotId) return;
            goods('used', delta.shotId, delta.shotsUsed);
            stats.shotWanted[delta.shotId] = (stats.shotWanted[delta.shotId] || 0) + delta.shotsWanted;
            const grade = shotGrade(delta.shotId), band = main.band;
            const row = stats.shots[grade] ||= { wanted: 0, fired: 0, byBand: {} }, inBand = row.byBand[band] ||= { wanted: 0, fired: 0 };
            row.wanted += delta.shotsWanted; row.fired += delta.shotsUsed; inBand.wanted += delta.shotsWanted; inBand.fired += delta.shotsUsed;
            const spot = Engine.spotRowOf(view, main), town = spot ? view.yields[`${spot.spotId}@${main.level}`]?.town || '?' : '?';
            const byTown = (stats.shotsByTown[grade] ||= {})[town] ||= { wanted: 0, fired: 0 };
            byTown.wanted += delta.shotsWanted; byTown.fired += delta.shotsUsed;
            const hourRow = stats.hour[grade] ||= { wanted: 0, fired: 0 };
            hourRow.wanted += delta.shotsWanted; hourRow.fired += delta.shotsUsed;
        },
        visit: visitMain,
        levelUp(main, now) {
            const index = main.index, account = accounts[index], seen = account.level, before = account.twin?.highest ?? seen;
            const from = gradeOfLevel(seen), to = gradeOfLevel(main.level);
            put(index, { level: Math.max(seen, main.level) });
            if (to !== from && main.level > seen) stats.entries[to] = (stats.entries[to] || 0) + 1;
            if (!account.twin || main.level <= before) return;
            const twin = markMp(account.twin, now), lifted = twinStats(snapshot, main.level);
            const mp = Workshop.mpAt(twin, now);
            if (!twin.batch) stats.mp.lost += Math.max(0, twin.regen * (now - twin.mpAt) - (twin.maxMp - twin.mp));
            putTwin(index, { ...twin, ...lifted, highest: main.level, mp: twin.batch ? twin.mp : Math.min(lifted.maxMp, mp), mpAt: twin.batch ? twin.mpAt : now,
                parked: gradeOfLevel(before) === to ? twin.parked : {} }, now);
        },
        event(event) {
            const index = event.who, account = accounts[index];
            if (event.kind === 'batch_done') return batchDone(index, event.at);
            if (!account.wake || account.wake.at !== event.at) return;
            const reasons = account.wake.reasons;
            put(index, { wake: null });
            wake(index, event.at, reasons.includes('main_arrived') ? 'main_arrived' : 'fill');
        },
        hour(now) {
            const row = { hour: now, shots: {}, margin: {} };
            for (const [grade, counts] of Object.entries(stats.hour)) row.shots[grade] = { ...counts };
            for (const [grade, values] of Object.entries(stats.marginHour)) row.margin[grade] = { median: median(values), crafts: values.length };
            stats.hourly.push(row);
            stats.hour = {}; stats.marginHour = {};
            return walletSum();
        },
        finish(hours, endMains) {
            for (const account of accounts) {
                if (!account.twin) continue;
                const twin = markMp(account.twin, hours);
                stats.seat[twin.seat.key] += hours - twin.seat.since;
                if (!twin.batch) stats.mp.lost += Math.max(0, twin.regen * (hours - twin.mpAt) - (twin.maxMp - twin.mp));
                put(account.index, { twin: { ...twin, seat: { key: twin.seat.key, since: hours } } });
            }
            return { money: { start: moneyStart, end: walletSum() }, design: report(hours, endMains) };
        }
    };

    // The design's numbers at the end of a run.
    function report(hours, endMains) {
        const closing = {};
        const add = (id, count) => { if (Number(id) > 0 && count > 0) closing[id] = (closing[id] || 0) + count; };
        for (const main of endMains) {
            if (main.station) continue;
            for (const [id, count] of Object.entries(main.bag)) add(id, count);
            for (const [id, count] of Object.entries(main.shots)) add(id, count);
            for (const id of Object.values(main.kit)) add(id, 1);
            if (main.weapon && !Object.values(main.kit).includes(main.weapon)) add(main.weapon, 1);
        }
        for (const account of accounts) if (account.twin) for (const [id, count] of Object.entries(account.twin.stock)) add(id, count);
        const totals = {}, failing = [];
        for (const id of new Set([...Object.keys(opening), ...Object.keys(closing), ...Object.keys(stats.goods)])) {
            const g = stats.goods[id] || {};
            for (const [field, count] of Object.entries(g)) totals[field] = (totals[field] || 0) + count;
            const expected = (opening[id] || 0) + (g.drop || 0) + (g.crafted || 0) + (g.crystalOut || 0) + (g.fromNpc || 0)
                - (g.used || 0) - (g.craftIn || 0) - (g.crystalIn || 0) - (g.learned || 0) - (g.toNpc || 0);
            if (expected !== (closing[id] || 0)) failing.push({ id: Number(id), expected, held: closing[id] || 0 });
        }
        const twins = accounts.filter(account => account.twin);
        const byBand = {}, byClass = {}, byTown = {};
        for (const account of twins) {
            const main = endMains[account.index];
            byBand[main.band] = (byBand[main.band] || 0) + 1;
            byClass[account.twin.classId] = (byClass[account.twin.classId] || 0) + 1;
            byTown[account.twin.town] = (byTown[account.twin.town] || 0) + 1;
        }
        const lines = twins.flatMap(account => [...account.twin.lines, ...account.twin.bids]);
        const openWaits = { sellLine: twins.reduce((sum, account) => sum + account.twin.lines.filter(line => line.side === 'sell').length, 0),
            buyLine: twins.reduce((sum, account) => sum + account.twin.lines.filter(line => line.side === 'buy').length, 0),
            bid: twins.reduce((sum, account) => sum + account.twin.bids.length, 0), batch: twins.filter(account => account.twin.batch).length,
            shotless: accounts.filter(account => account.shotless).length };
        // MP a full shot use would take: the shots wanted x MP per unit of each shot's cheapest recipe.
        let mpNeeded = 0;
        for (const [id, wanted] of Object.entries(stats.shotWanted)) {
            const recipe = (game.byProduct[id] || []).map(rid => game.recipes[rid]).filter(row => !row.quest).sort((a, b) => a.mpCost / a.productCount - b.mpCost / b.productCount)[0];
            if (recipe) mpNeeded += wanted * recipe.mpCost / recipe.productCount;
        }
        return {
            config,
            standIns: STAND_INS,
            crafters: { accounts: hunting.length, crafterAccounts: twins.length, share: twins.length / Math.max(1, hunting.length),
                bountyHunterPairs: twins.filter(account => mains[account.index].line === BOUNTY_HUNTER).length,
                otherPairs: twins.filter(account => mains[account.index].line !== BOUNTY_HUNTER).length, byBand, byClass, byTown },
            shots: { byGrade: Object.fromEntries(Object.entries(stats.shots).map(([grade, row]) => [grade, { ...row, coverage: row.wanted ? row.fired / row.wanted : null,
                byTown: Object.entries(stats.shotsByTown[grade] || {}).map(([town, t]) => ({ town, ...t, coverage: t.wanted ? t.fired / t.wanted : null })).sort((a, b) => b.wanted - a.wanted) }])),
            supply: { own: stats.counters.shotsOwn, lines: stats.counters.shotsLine, npc: stats.counters.shotsNpc },
            worthAtStart,
            worthSeen: { visitsWithLine: stats.counters.visitsWithLine, cheapestAtOrUnderWorth: stats.counters.lineWorthIt, cheapestAboveWorth: stats.counters.lineAboveWorth } },
            mp: { ...stats.mp, neededForFullShots: mpNeeded },
            // Seat-hours by store state: selling or buying while its store shows a line, idle (by
            // the mode chosen) while it shows none; crafting overlaps them (a batch's MP wait).
            twins: { seat: { ...stats.seat }, batchHours: stats.batchHours, mpLost: stats.mp.lost },
            money: { start: moneyAtStart, end: moneyByKind(endMains) },
            firsts: stats.firsts,
            pieces: Object.fromEntries([...new Set([...Object.keys(stats.pieces), ...Object.keys(stats.entries)])].map(grade => [grade,
                { crafted: stats.pieces[grade] || 0, craftedPerHour: (stats.pieces[grade] || 0) / hours, entries: stats.entries[grade] || 0, entriesPerHour: (stats.entries[grade] || 0) / hours }])),
            materials: { ...stats.materials },
            crystals: { ...stats.crystals },
            recipes: stats.recipes,
            liveness: { waits: Object.fromEntries(WAITS.map(kind => [kind, { ...stats.waits[kind], open: openWaits[kind] }])),
                linesAtBound: lines.filter(line => line.bound).length, linesAtBoundThreeLooks: lines.filter(line => line.bound && line.atBound >= 3).length,
                linesAtCost: lines.filter(line => line.floorBy === 'cost').length, linesOpen: lines.length },
            botToBot: stats.botToBot,
            goods: { totals, items: Object.keys(stats.goods).length, failing: failing.length, worst: failing.slice(0, 5) },
            counters: { ...stats.counters, recipesStopped: stats.stopped.size },
            hourly: stats.hourly
        };
    }
}

module.exports = { DESIGN, READINGS, DEPOSIT_FEE, STARTER_VILLAGE, STAND_INS, gameOf, firstPrices, plane, twinStats };
