'use strict';

// The economy model's engine: one main per account, driven by a seeded queue
// of the named situations, over the game-data snapshot (inputs.js) alone: no
// server module, no World, no database, no clock.
//
// Between two situations a main hunts analytically at its spot: the spot a
// cohort account stood at while the snapshot has that spot's hour for its line
// and level (spotHours), else its line's best spot for its level. It earns
// the hour times the hunting hours (wall hours times its stage band's hunting
// share). Items with a mean count under 5 are drawn whole (Poisson), larger
// counts round by a draw on the fraction, so rare recipes and gear arrive as
// pieces. Situations:
//   level_up      the exp of the next level is reached (from exp per hour);
//                 the kit plan and shot grade follow the new level, and a
//                 main whose spot has no hour at it moves to its line's best.
//   arrived_town  the main is in town: sells its bag, restocks shots (an
//                 outing of the hunting hours since its last visit), buys
//                 the kit pieces its plan names. When it comes is the run's
//                 nextArrival(main, view) alone: asked at the start and after
//                 each committed event that changes the main (a visit, a
//                 level-up), its answer is the one pending arrival (replaced,
//                 or dropped by null). Today's mode gives a fitted periodic
//                 rule, the design mode the situations that send a bot to town.
//   report        every simulated hour: counters only, never a decision.
// In the design mode (simulate's design: design.js) the run also holds the
// account plane: crafter twins seated in towns, woken by account_wake (a line
// filled, an order, its main's arrival) and batch_done (a craft batch's MP
// deadline); mains hunt at the design's yields and, without shots of their
// grade, at the hour without shots, at the spot their occupation chose; the
// design's trip is the arrival rule and its visits are the design's.
//
// hunt and visit are pure: they take a main and the view and return the new
// main with the flows it caused; the engine commits both. Rolls are seeded per
// (run seed, account id, the account's situation counter).
const { hash, mulberry } = require('../hunt-tables/common');
const Ledger = require('./ledger');

const ADENA = 57;
// Counts drawn whole below this mean, rounded by a draw above it.
const WHOLE_DRAW_MEAN = 5;
// Today's shot restock (EconomyContext.kitReader, ShotStock.restockPlan):
// below one hunting hour of use a bot buys up to an outing's use, never
// under one hour.
const SHOT_LINE_HOURS = 1;

// The Blessed Spiritshots' place in the snapshot's shot families (soulshot,
// spiritshot, blessed spiritshot).
const BLESSED_FAMILY = 2;

const isGear = item => /^(Weapon|Armor)/.test(item?.kind || '');
const isWeapon = item => /^Weapon/.test(item?.kind || '');

// The snapshot read once into what the rules look up. options.market:
// { buy: { town: { item: price } }, sell: { town: { item: price } } }, the
// fixed stores a mode adds (none by default). options.npcPrices: 'preset' (the
// game's NPC prices at the snapshot's rate) or 'x1'.
function viewOf(snapshot, options = {}) {
    const npcTable = snapshot.npcOffers[options.npcPrices || 'preset'];
    const market = { buy: options.market?.buy || {}, sell: options.market?.sell || {} };
    // item -> [{ town, price, channel }] cheapest first: the NPC shops and the fixed sell lines.
    const offers = new Map();
    const offer = (id, row) => { if (!offers.has(id)) offers.set(id, []); offers.get(id).push(row); };
    for (const [id, rows] of Object.entries(npcTable || {})) for (const row of rows) offer(Number(id), { town: row.town, price: row.price, channel: 'npc_buy' });
    for (const [town, lines] of Object.entries(market.sell)) for (const [id, price] of Object.entries(lines)) offer(Number(id), { town, price, channel: 'fixed_wts' });
    for (const rows of offers.values()) rows.sort((a, b) => a.price - b.price);
    const recipeGrade = {};
    for (const row of snapshot.recipes || []) recipeGrade[row.recipeItemId] = String(snapshot.items[row.productId]?.grade || 'NONE').toLowerCase();
    return {
        hours: snapshot.hours, kits: snapshot.kits, yields: snapshot.yields, items: snapshot.items, exp: snapshot.exp,
        maxLevel: Math.min(snapshot.header.levels[1], snapshot.exp.length), fares: snapshot.fares || {},
        shotFamilies: snapshot.shotFamilies || null, offers, market, recipeGrade, yieldRows: new Map(),
        spotHours: snapshot.spotHours?.rows || null, yieldsDesign: snapshot.yieldsDesign || null, spotLevels: snapshot.spotLevels || null,
        blessedShots: new Set(snapshot.shotFamilies?.ids?.[BLESSED_FAMILY] || [])
    };
}

// The exp at which a level starts (the table's index 0 is level 1).
const expAt = (view, level) => view.exp[level - 1];
function levelOf(view, exp, from = 1) {
    let level = from;
    while (level < view.maxLevel && exp >= expAt(view, level + 1)) level++;
    return level;
}

function bandOf(bands, level) {
    let name = bands[0][0];
    for (const [band, from] of bands) if (level >= from) name = band;
    return name;
}

const hourOf = (view, main) => view.hours[main.line]?.[main.level] || null;
const ownRow = (view, line, level, spot) => (spot ? view.spotHours?.[line]?.[level]?.[spot] || null : null);

// The spot row a main hunts: the spot its occupation chose (the design
// mode's, among its line's top spots at its level or the other rows it may
// hold there), else its own spot's hour, else its line's best.
function spotRowOf(view, main) {
    const hour = main.occupied ? hourOf(view, main) : null, chosen = row => String(row.spotId) === main.occupied;
    const occupied = hour ? hour.top?.find(chosen) || hour.others?.find(chosen) || null : null;
    return occupied || ownRow(view, main.line, main.level, main.spot) || hourOf(view, main)?.best || null;
}

// The shot a main fires: the hour's kind of shot at the grade of the weapon
// in its hand (C4: the shot's grade is the weapon's), the hour's shot when
// it holds no weapon the snapshot grades.
function shotOf(view, main, hour) {
    const family = view.shotFamilies?.ids.find(ids => ids.includes(hour.shotId));
    const at = family ? view.shotFamilies.grades.indexOf(view.items[main.weapon]?.grade) : -1;
    return at >= 0 ? family[at] : hour.shotId;
}

// The form of its spot row a main hunts firing a shot (0: none): 'bare' the
// row's hour without shots, 'blessed' its hour firing Blessed Spiritshots,
// 'shots' the row itself (its plain shot: a soulshot or a Spiritshot).
function formOf(view, shotId) {
    return !shotId ? 'bare' : view.blessedShots.has(Number(shotId)) ? 'blessed' : 'shots';
}

// A spot row's hour in a form (formOf): the row with the form's fields over
// it, the row itself where it has no such hour (no hour without shots: the
// line fights nothing there without shots; no blessed hour: the spot table
// measured no such fight there, where a main fires its plain shot and the
// design plane's firing offers no Blessed Spiritshots).
function rowIn(row, form) {
    const over = form === 'bare' ? row?.shotless : form === 'blessed' ? row?.blessed : null;
    return over ? { ...row, ...over } : row;
}

// The kill-mix correction of a spot row: { drop, spoil }. The snapshot's
// per-kill yields are one row per spot and level, at the spot's spawn mix and
// the highest Spoil level of any line there; the row's loot is at the species
// its line kills (the spot table's kill mix, which the snapshot does not
// carry) and its line's own Spoil. Drop items scale by the row's drop loot
// over the spawn mix's drop value at the NPC's price, spoil items by its spoil
// loot over the spoil value (0 for a line without Spoil); 1 where the spawn
// mix is worth nothing. One factor per kind: one factor for both would hand a
// line without Spoil the spoiler's materials and shrink its gear drops.
function killMixCorrection(view, row, level) {
    const yields = row && view.yields[`${row.spotId}@${level}`];
    const valueOf = table => Object.entries(table || {}).reduce((sum, [id, perKill]) => sum + (Number(id) === ADENA ? 0 : perKill * (view.items[id]?.npcBuy || 0)), 0) * (row?.kills || 0);
    const drop = valueOf(yields?.drop), spoil = valueOf(yields?.spoil);
    return { drop: drop > 0 ? row.dropLoot / drop : 1, spoil: spoil > 0 ? row.spoilLoot / spoil : 1 };
}

// [[item, per kill]] of a spot row at a level, adena apart (the row's own
// adena), at the kill-mix correction. One list per line, level and spot.
function yieldRows(view, line, level, row) {
    const key = `${line}@${level}@${row.spotId}`;
    if (view.yieldRows.has(key)) return view.yieldRows.get(key);
    const yields = view.yields[`${row.spotId}@${level}`], factor = killMixCorrection(view, row, level), rows = [];
    for (const kind of yields ? ['drop', 'spoil'] : []) {
        for (const [id, perKill] of Object.entries(yields[kind])) if (Number(id) !== ADENA) rows.push([Number(id), perKill * factor[kind]]);
    }
    view.yieldRows.set(key, rows);
    return rows;
}

function poisson(mean, random) {
    const limit = Math.exp(-mean);
    let count = 0, product = random();
    while (product > limit) { count++; product *= random(); }
    return count;
}

function wholeCount(mean, random) {
    if (!(mean > 0)) return 0;
    if (mean < WHOLE_DRAW_MEAN) return poisson(mean, random);
    const whole = Math.floor(mean);
    return whole + (random() < mean - whole ? 1 : 0);
}

const emptyFlows = () => ({ huntCold: 0, npcSales: 0, fixedBuyers: 0, npcBuys: 0, fixedSellers: 0, fares: 0 });

// Hunting for huntHours at the main's spot: adena, exp, items into the bag,
// shots fired from the stock of the hour's shot (a main without shots keeps
// hunting; the shots it missed are counted).
function hunt(main, view, huntHours, random) {
    const hour = hourOf(view, main), best = spotRowOf(view, main), flows = emptyFlows();
    const delta = { flows, exp: 0, drops: [], shotsUsed: 0, shotsWanted: 0, noSpot: 0, huntHours: 0, ownSpot: false, spoilUnyielded: 0 };
    if (!best || !(huntHours > 0)) { delta.noSpot = best ? 0 : 1; return { main, delta }; }
    const kills = best.kills * huntHours;
    delta.huntHours = huntHours;
    // Spoil loot the row has but the snapshot has no spoil yields to carry: lost, so counted.
    if (best.spoilLoot > 0 && !Object.keys(view.yields[`${best.spotId}@${main.level}`]?.spoil || {}).length) delta.spoilUnyielded = kills;
    delta.ownSpot = best === ownRow(view, main.line, main.level, main.spot);
    flows.huntCold = Math.round(best.adena * huntHours);
    delta.exp = best.exp * huntHours;
    const bag = { ...main.bag };
    for (const [id, perKill] of yieldRows(view, main.line, main.level, best)) {
        const count = wholeCount(perKill * kills, random);
        if (!count) continue;
        bag[id] = (bag[id] || 0) + count;
        delta.drops.push([id, count]);
    }
    const shotId = shotOf(view, main, hour), wanted = Math.round(best.shots * huntHours), held = main.shots[shotId] || 0;
    delta.shotsWanted = wanted;
    delta.shotsUsed = Math.min(held, wanted);
    const shots = delta.shotsUsed ? { ...main.shots, [shotId]: held - delta.shotsUsed } : main.shots;
    const exp = main.exp + delta.exp;
    return { main: { ...main, exp, level: levelOf(view, exp, main.level), money: main.money + flows.huntCold, bag, shots }, delta };
}

// The design's adena per kill over today's at a spot row's spawn mix (1
// where today's yields carry no adena).
function designAdenaFactor(view, row, level) {
    const key = `${row.spotId}@${level}`, today = view.yields[key]?.drop?.[ADENA] || 0, design = view.yieldsDesign?.[key]?.drop?.[ADENA] || 0;
    return today > 0 ? design / today : 1;
}

// [[item, per kill]] at the design's yields for a spot row's hour in a form
// (row: rowIn's of that form), at that hour's own kill-mix correction.
function designYieldRows(view, line, level, row, form) {
    const key = `design@${line}@${level}@${row.spotId}@${form}`;
    if (view.yieldRows.has(key)) return view.yieldRows.get(key);
    const yields = view.yieldsDesign?.[`${row.spotId}@${level}`], factor = killMixCorrection(view, row, level), rows = [];
    for (const kind of yields ? ['drop', 'spoil'] : []) {
        for (const [id, perKill] of Object.entries(yields[kind])) if (Number(id) !== ADENA) rows.push([Number(id), perKill * factor[kind]]);
    }
    view.yieldRows.set(key, rows);
    return rows;
}

// Hunting in the design mode: the design's adena and items (rules/dropRule at
// the preset's design rates) at the kills and kill mix of the spot row's
// hour of the kind it fires (formOf: its plain shot the row, Blessed
// Spiritshots the row's blessed hour); the shots the main fires (firing:
// { id, perHour }, the design plane's answer, perHour that hour's shots at
// its weapon's count; null fires none) last shots held / shots per hour,
// and past them, or firing none, it hunts at the same spot's hour without
// shots (fewer kills, less exp and loot) until it restocks. delta as
// hunt's, with shotId and huntBare.
function huntDesign(main, view, huntHours, random, firing = null) {
    const best = spotRowOf(view, main), flows = emptyFlows();
    const delta = { flows, exp: 0, drops: [], shotsUsed: 0, shotsWanted: 0, noSpot: 0, huntHours: 0, ownSpot: false, spoilUnyielded: 0, shotId: 0, huntBare: 0 };
    if (!best || !(huntHours > 0)) { delta.noSpot = best ? 0 : 1; return { main, delta }; }
    delta.huntHours = huntHours;
    delta.ownSpot = best === ownRow(view, main.line, main.level, main.spot);
    const shotId = firing?.id || 0, held = shotId ? main.shots[shotId] || 0 : 0, perHour = shotId ? firing.perHour || 0 : 0;
    const shotHours = perHour > 0 ? Math.min(huntHours, held / perHour) : 0;
    const form = formOf(view, shotId), adenaFactor = designAdenaFactor(view, best, main.level);
    const bag = { ...main.bag }, counts = new Map();
    for (const [at, hours] of [[form, shotHours], ['bare', huntHours - shotHours]]) {
        if (!(hours > 0)) continue;
        const row = rowIn(best, at);
        flows.huntCold += row.adena * adenaFactor * hours;
        delta.exp += row.exp * hours;
        for (const [id, perKill] of designYieldRows(view, main.line, main.level, row, at)) counts.set(id, (counts.get(id) || 0) + perKill * row.kills * hours);
    }
    flows.huntCold = Math.round(flows.huntCold);
    for (const [id, mean] of counts) {
        const count = wholeCount(mean, random);
        if (!count) continue;
        bag[id] = (bag[id] || 0) + count;
        delta.drops.push([id, count]);
    }
    delta.shotId = shotId;
    delta.shotsWanted = Math.round(perHour * huntHours);
    delta.shotsUsed = Math.min(held, delta.shotsWanted);
    delta.huntBare = huntHours - shotHours;
    const shots = delta.shotsUsed ? { ...main.shots, [shotId]: held - delta.shotsUsed } : main.shots;
    const exp = main.exp + delta.exp;
    return { main: { ...main, exp, level: levelOf(view, exp, main.level), money: main.money + flows.huntCold, bag, shots }, delta };
}

// Where the main can buy an item: the offer in town, else the town with a
// seller the fewest fare away (null when no town sells it or no route leads there).
function sellerOf(view, id, town) {
    const rows = view.offers.get(Number(id));
    if (!rows) return null;
    const here = rows.find(row => row.town === town);
    if (here) return { ...here, fare: 0 };
    let best = null;
    for (const row of rows) {
        const fare = view.fares[town]?.[row.town];
        if (fare === null || fare === undefined) continue;
        if (!best || fare < best.fare || (fare === best.fare && row.price < best.price)) best = { ...row, fare };
    }
    return best;
}

// The main's errands in town, in its wallet's order: the shot restock, then
// the kit plan's pieces it does not wear, by slot.
function errands(main, view, hour, context) {
    const out = [], row = spotRowOf(view, main);
    if (row && hour?.shotId) {
        const shotId = shotOf(view, main, hour), perHour = row.shots, held = main.shots[shotId] || 0;
        const target = Math.ceil(perHour * Math.max(SHOT_LINE_HOURS, context.outingHours || 0));
        if (held < perHour * SHOT_LINE_HOURS && target > held) out.push({ kind: 'shots', id: shotId, amount: target - held });
    }
    for (const piece of view.kits[main.line]?.[main.level] || []) {
        if (main.kit[piece.slot] !== piece.selfId) out.push({ kind: 'piece', id: piece.selfId, slot: piece.slot, amount: 1 });
    }
    return out;
}

// A visit: the main arrives in its spot's town, sells its bag (to a fixed
// buyer of the town when one buys the item, else to the NPC), sells shots of
// a grade it no longer fires to the NPC, then runs its errands where it
// stands; an errand nobody sells here takes it by gatekeeper to the nearest
// town that sells it (one such hop per visit), where it runs what it can.
function visit(main, view, context = {}) {
    const hour = hourOf(view, main), row = spotRowOf(view, main), flows = emptyFlows();
    const town = row ? view.yields[`${row.spotId}@${main.level}`]?.town || null : null;
    const delta = { flows, towns: [], gearToNpc: 0, gearBought: 0, shotsBoughtFixed: 0, shotsBoughtNpc: 0, shotsSoldNpc: 0,
        unsold: 0, missingPieces: 0, missingShots: 0, noTown: 0 };
    if (!town) { delta.noTown = 1; return { main, delta }; }
    delta.towns.push(town);
    let money = main.money;
    const sellToNpc = (id, count) => {
        const value = Math.round(count * (view.items[id]?.npcBuy || 0));
        if (!(value > 0)) return false;
        flows.npcSales += value;
        money += value;
        if (isGear(view.items[id])) delta.gearToNpc += count;
        return true;
    };
    const buyers = view.market.buy[town] || {};
    for (const [key, count] of Object.entries(main.bag)) {
        const id = Number(key), price = buyers[id];
        if (price > 0) { const value = Math.round(price * count); flows.fixedBuyers += value; money += value; } else if (!sellToNpc(id, count)) delta.unsold += count;
    }
    const shots = {}, firing = shotOf(view, main, hour);
    for (const [key, count] of Object.entries(main.shots)) {
        if (Number(key) === firing || !count) { if (count) shots[key] = count; continue; }
        if (sellToNpc(Number(key), count)) delta.shotsSoldNpc += count; else delta.unsold += count;
    }
    const kit = { ...main.kit };
    let weapon = main.weapon;
    const buy = (errand, seller) => {
        if (errand.kind === 'shots') {
            const count = Math.min(errand.amount, Math.floor(money / seller.price));
            if (count <= 0) return false;
            const cost = count * seller.price;
            money -= cost;
            shots[errand.id] = (shots[errand.id] || 0) + count;
            if (seller.channel === 'fixed_wts') { flows.fixedSellers -= cost; delta.shotsBoughtFixed += count; } else { flows.npcBuys -= cost; delta.shotsBoughtNpc += count; }
            return count === errand.amount;
        }
        if (money < seller.price) return false;
        money -= seller.price;
        flows[seller.channel === 'fixed_wts' ? 'fixedSellers' : 'npcBuys'] -= seller.price;
        delta.gearBought++;
        const worn = kit[errand.slot];
        kit[errand.slot] = errand.id;
        if (isWeapon(view.items[errand.id])) weapon = errand.id;
        if (worn) sellToNpc(worn, 1);
        return true;
    };
    let open = [];
    for (const errand of errands(main, view, hour, context)) {
        const seller = sellerOf(view, errand.id, town);
        if (!(seller?.fare === 0 && buy(errand, seller))) open.push(errand);
    }
    // One onward hop: to the nearest seller of the first errand still open.
    const first = open.map(errand => ({ errand, seller: sellerOf(view, errand.id, town) })).find(row => row.seller && row.seller.fare > 0);
    if (first && money >= first.seller.fare + first.seller.price) {
        money -= first.seller.fare;
        flows.fares -= first.seller.fare;
        const there = first.seller.town;
        delta.towns.push(there);
        open = open.filter(errand => {
            const seller = sellerOf(view, errand.id, there);
            return !(seller?.fare === 0 && buy(errand, seller));
        });
    }
    for (const errand of open) delta[errand.kind === 'shots' ? 'missingShots' : 'missingPieces']++;
    return { main: { ...main, money, bag: {}, shots, kit, weapon }, delta };
}

// The engine's opening state of an account record (cohort.js).
function mainOf(account, index, view, bands) {
    const kit = {}, held = new Set(account.held || []), level = Math.min(account.level, view.maxLevel);
    for (const piece of view.kits[account.line]?.[level] || []) kit[piece.slot] = held.has(piece.selfId) ? piece.selfId : 0;
    for (const [slot, selfId] of Object.entries(account.worn || {})) if (!kit[slot] && kit[slot] !== undefined) kit[slot] = selfId;
    // The weapon in hand: the plan's when held, else the one the account wears.
    const planned = Object.values(kit).find(selfId => selfId && isWeapon(view.items[selfId]));
    const weapon = planned || Object.values(account.worn || {}).find(selfId => isWeapon(view.items[selfId])) || 0;
    const station = !!account.station || !view.hours[account.line];
    const spot = ownRow(view, account.line, level, account.spot) ? account.spot : null;
    return { index, id: account.id, station, line: account.line, level, exp: account.exp, money: account.money, weapon, spot,
        bag: {}, shots: { ...(account.shots || {}) }, kit, band: station ? Ledger.STATION : bandOf(bands, level), since: 0, lastVisit: 0, counter: 0 };
}

// A min-heap of { at, seq, kind, who } by time, then by push order.
function heap() {
    const rows = [];
    const less = (a, b) => a.at < b.at || (a.at === b.at && a.seq < b.seq);
    let seq = 0;
    return {
        get size() { return rows.length; },
        push(event) {
            rows.push({ ...event, seq: seq++ });
            for (let i = rows.length - 1; i > 0;) {
                const parent = (i - 1) >> 1;
                if (!less(rows[i], rows[parent])) break;
                [rows[i], rows[parent]] = [rows[parent], rows[i]];
                i = parent;
            }
        },
        pop() {
            const top = rows[0], last = rows.pop();
            if (rows.length) {
                rows[0] = last;
                for (let i = 0; ;) {
                    const left = 2 * i + 1, right = left + 1;
                    let least = i;
                    if (left < rows.length && less(rows[left], rows[least])) least = left;
                    if (right < rows.length && less(rows[right], rows[least])) least = right;
                    if (least === i) break;
                    [rows[i], rows[least]] = [rows[least], rows[i]];
                    i = least;
                }
            }
            return top;
        }
    };
}

// A run: accounts (cohort.js), the view, the stage bands [[name, fromLevel]],
// per band { huntShare, ... } and nextArrival(main, view): the time of the
// main's next arrival in town (null: none), asked on the main as it is after
// the committed event. view is the plain data a trip rule may read:
//   event     'start' | 'visit' | 'level_up'
//   now       the time of the event, hours
//   pending   the arrival already scheduled (null after a visit or at the start)
//   rate      the main's band's rates
//   roll      a seeded number in [0, 1)
//   hour      the main's spot row: exp, adena, kills, shots, dropLoot, spoilLoot, loot, potions per hunting hour (null without one)
//   shotsPerHour  the row's shots per hunting hour; the main's own bag and shots are on main
//   huntShare the band's share of wall time spent hunting
// The snapshot has no bag capacity or carry weight (items carry a weight, the
// class carry limit is not read), so a rule on "the bag is full" has no number yet.
// design: null (today's and the plain mode) or the design mode's plane
// (design.js plane()): its start({ view, mains, ledger, push, seed, rateOf,
// rearrive, commit }) returns the hooks the run calls (hunt, visit, levelUp,
// event, hour, finish, nextArrival: the design's trip, which replaces the
// nextArrival given; firing(main): the shot a main fires as it hunts,
// huntDesign's). rearrive(index, now, event) asks the arrival rule again
// for a main after a situation raised outside its own events (a line in
// reach, a bid for what it sells); commit(index, now, change) hunts a main to
// now, replaces it by change(main) (a deal met with it while it hunts) and
// asks again. Returns the model ledger.
function simulate({ view, accounts, bands, rates, hours, nextArrival, seed = 1, onProgress = null, inputs = {}, design = null }) {
    if (typeof nextArrival !== 'function' && !design) throw new Error('simulate needs nextArrival(main, view)');
    const rateOf = band => rates[band] || rates.default;
    const mains = accounts.map((account, index) => mainOf(account, index, view, bands));
    const ledger = Ledger.create({ bands, mains, view, extraSinks: design ? design.sinks : [] });
    const queue = heap();
    let arrivalRule = nextArrival;
    const plane = design ? design.start({ view, mains, ledger, push: event => queue.push(event), seed, rateOf,
        rearrive: (index, now, event) => reschedule(mains[index], now, event),
        commit: (index, now, change, event) => { const main = change(huntTo(mains[index], now)); mains[index] = main; reschedule(main, now, event); return main; } }) : null;
    if (plane) arrivalRule = plane.nextArrival;
    const randomFor = main => mulberry(hash(`${seed}:${main.id}:${main.counter}`));
    let events = 0;

    // The level is scheduled at the most exp an hour the main may hunt its
    // spot row at (the design mode's mains: the row or its blessed hour), so
    // the situation never comes after the level is reached; one that comes
    // before it is scheduled again from the exp then held.
    const scheduleLevel = (main, now) => {
        const row = spotRowOf(view, main), share = rateOf(main.band).huntShare, exp = plane ? Math.max(row?.exp || 0, row?.blessed?.exp || 0) : row?.exp;
        if (main.level >= view.maxLevel || !(exp > 0) || !(share > 0)) return;
        // One exp over the next level's start, so the level is reached however the hour's exp rounds.
        const need = expAt(view, main.level + 1) - main.exp + 1;
        queue.push({ at: now + Math.max(0, need) / (exp * share), kind: 'level_up', who: main.index });
    };
    // The one pending arrival per main, replaced by the rule's answer after each committed event.
    const pending = new Map();
    const reschedule = (main, now, event) => {
        const row = spotRowOf(view, main), rate = rateOf(main.band), held = pending.get(main.index) ?? null;
        const at = arrivalRule(main, { event, now, pending: held, rate, roll: mulberry(hash(`${seed}:${main.id}:arrival:${main.counter}`))(),
            hour: row || null, shotsPerHour: row?.shots || 0, huntShare: rate.huntShare });
        const next = Number.isFinite(at) && at > now ? at : null;
        pending.set(main.index, next);
        if (next !== null && next !== held) queue.push({ at: next, kind: 'arrived_town', who: main.index });
    };
    // Hunting from the main's last situation to now, committed.
    const huntTo = (main, now) => {
        const share = rateOf(main.band).huntShare;
        const { main: next, delta } = plane ? huntDesign({ ...main, counter: main.counter + 1, since: now }, view, (now - main.since) * share, randomFor(main), plane.firing(main))
            : hunt({ ...main, counter: main.counter + 1, since: now }, view, (now - main.since) * share, randomFor(main));
        Ledger.recordHunt(ledger, next, delta);
        if (plane) plane.hunt(next, delta, now);
        return next;
    };

    for (const main of mains) {
        if (main.station) continue;
        scheduleLevel(main, 0);
        reschedule(main, 0, 'start');
    }
    for (let hour = 1; hour <= hours; hour++) queue.push({ at: hour, kind: 'report', who: -1 });

    const startedAt = Date.now();
    while (queue.size) {
        const event = queue.pop();
        if (event.at > hours) break;
        events++;
        if (event.kind === 'report') {
            Ledger.recordHour(ledger, mains, event.at, plane ? plane.hour(event.at) : 0);
            if (onProgress && event.at % 10 === 0) onProgress({ hour: event.at, hours, events, seconds: (Date.now() - startedAt) / 1000 });
            continue;
        }
        if (event.kind === 'account_wake' || event.kind === 'batch_done') {
            plane.event(event);
            continue;
        }
        if (event.kind === 'arrived_town') {
            if (pending.get(event.who) !== event.at) continue; // replaced by a later answer
            pending.set(event.who, null);
        }
        let main = huntTo(mains[event.who], event.at);
        if (event.kind === 'level_up') {
            const band = bandOf(bands, main.level), spot = ownRow(view, main.line, main.level, main.spot) ? main.spot : null;
            if (main.spot && !spot) ledger.counters.leftOwnSpot++;
            main = { ...main, band, spot };
            if (plane) main = plane.levelUp(main, event.at);
            scheduleLevel(main, event.at);
            mains[event.who] = main;
            reschedule(main, event.at, 'level_up');
        } else {
            // The restock covers an outing as long as the one just ended.
            const outingHours = (event.at - main.lastVisit) * rateOf(main.band).huntShare;
            const { main: after, delta } = plane ? plane.visit(main, event.at, { outingHours }) : visit(main, view, { outingHours });
            Ledger.recordVisit(ledger, after, delta);
            main = { ...after, lastVisit: event.at };
            mains[event.who] = main;
            reschedule(main, event.at, 'visit');
        }
    }
    for (let i = 0; i < mains.length; i++) if (!mains[i].station) mains[i] = huntTo(mains[i], hours);
    if (!plane) return Ledger.build(ledger, { mains, hours, events, inputs, view });
    const report = plane.finish(hours, mains);
    return { ...Ledger.build(ledger, { mains, hours, events, inputs, view, held: report.money }), design: report.design };
}

module.exports = { viewOf, hunt, huntDesign, visit, errands, sellerOf, mainOf, simulate, levelOf, bandOf, wholeCount, heap, spotRowOf, hourOf, shotOf,
    killMixCorrection, designAdenaFactor, designYieldRows, formOf, rowIn, isGear, isWeapon, expAt, SHOT_LINE_HOURS };
