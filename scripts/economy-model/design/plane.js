'use strict';

// The design's engine plane: a solo bot in an NPC world, driven by the facts
// of its own state. Each account keeps one fact queue (attention.js); the
// plane raises a fact where it happens (a hunt that spends the last shot, a
// bag that reaches the game's full rule, a birth, an arrival, a death), and
// the facts heard where the bot stands run the supply decision (supply.js)
// in the run's variant. Between facts the bot hunts its held spot: the
// engine reads it at the hour of its next expected fact (its shots' end, its
// bag's fill), and nothing else wakes it: no timer.
//   birth    a visit at hour 0 in the held spot's town, then the walk out;
//   out/bag  read on the hunted state: go to the town that sells its shots
//            (the walk to town is the arrival's away hours), stay, or no
//            action (it hunts on);
//   arrival  the town chain: sell to the NPC, buy to the outing's target,
//            walk back (the visit's afterHours);
//   death    the respawn town (the held spot's town) runs the same chain.
// The held spot is the line's best row at the level in the form the bot can
// hunt (heldSpot), taken at its birth and the end of each town chain. Called
// by the engine (the only module of the design that touches the engine
// contract); pure on the view and the main except the account
// queues it holds by main index.
// Its report (finish) is bookkeeping the decisions never read: trips, road
// and stuck hours at levels 1-19 apart from 20 and above, the supply decision
// of the other variant on every field decision, the bare hours before a line's
// first shot purchase.
const Engine = require('../engine');
const Today = require('../today');
const SurvivalFloor = require('../../../src/GameServer/Bot/Population/SurvivalFloor');
const Attention = require('./attention');
const Catalog = require('./catalog');
const Needs = require('./needs');
const Value = require('./value');
const Supply = require('./supply');

// The report's frame: levels 1-19 are the design's, 20 and above are counted apart.
const LOW_LEVEL_LAST = 19;
// The stuck reason of a main whose level has no spot row for its line.
const NO_SPOT_ROW = 'no_spot_row';
const classOf = level => (level <= LOW_LEVEL_LAST ? 'low' : 'high');

// The facts the plane raises, each a test on what just happened.
const FACTS = Object.freeze({
    // A new character entered the world (the birth visit).
    born: visitInfo => visitInfo.born === true,
    // The hunt spent the last of the shots it fires.
    out: (main, delta) => delta.shotId > 0 && delta.shotsUsed > 0 && !(main.shots[delta.shotId] > 0),
    // The bag reached the full rule now and was not full before.
    bag: (wasFull, full) => !wasFull && full,
    // It arrived in a town (a trip's end, a birth or a respawn).
    town: town => town !== null,
    // It died (the respawn town's arrival follows).
    died: visitInfo => visitInfo.died === true
});

// The held spot's town (the spot card's town at the level), null without one.
const townOf = (view, main) => Engine.townOfRow(view, Engine.spotRowOf(view, main), main.level);

// The held spot: its line's best row at the level in the form the bot can hunt, taken at its birth and at the end of each
// town chain and held between (the engine keeps it while its row exists at the level): the best row with shots when it
// holds the shots it fires (the weapon's grade), else the best row without them (bareBest: the game's own answer for a
// line hunting without shots, SpotValueTable.best with shots off, often another spot than the one a gate closes).
// A snapshot with no bareBest row holds the best row.
function heldSpot(view, main) {
    const hour = Engine.hourOf(view, main), shot = hour?.shotId ? Engine.shotOf(view, main, hour) : 0;
    const row = shot && main.shots[shot] > 0 ? hour.best : hour?.bareBest || hour?.best;
    return row ? String(row.spotId) : null;
}

// The game's inventory full rule (SurvivalFloor.evaluate: its slots or the
// first weight penalty) on counts { id: count } of what it carries (the worn
// kit, its shots and its bag): a stack takes one slot, a piece of gear one
// each. bags: the line's { slots, maxLoad }.
function fullOf(view, bags, counts) {
    let slots = 0, load = 0;
    for (const [id, count] of counts) {
        if (!(count > 0)) continue;
        const item = view.items[id];
        slots += Engine.isGear(item) ? count : count >= 1 ? 1 : 0;
        load += item?.weight ? count * item.weight : 0;
    }
    return SurvivalFloor.evaluate({ slots, slotLimit: bags.slots, load, maxLoad: bags.maxLoad }) !== null;
}

function carried(main) {
    const counts = new Map(), add = (id, count) => counts.set(Number(id), (counts.get(Number(id)) || 0) + count);
    for (const id of Object.values(main.kit)) if (id) add(id, 1);
    for (const [id, count] of Object.entries(main.shots)) add(id, count);
    for (const [id, count] of Object.entries(main.bag)) add(id, count);
    return counts;
}

// The hunting hours until its expected bag reaches the full rule: its shots
// form for the hours its shots last, then bare, at the spot row's item rates
// per hunting hour times the worn kit's kills in each form (a stack counted
// held once its expected count reaches 1). Infinity when it never fills.
function hoursToFull(view, bags, main, row, phases) {
    const held = carried(main), rates = new Map();
    phases.forEach(({ form, kills }, at) => {
        for (const item of Engine.rowItems(view, main, row, form).items) {
            const pair = rates.get(item.id) || [0, 0];
            pair[at] += item.rate * kills;
            rates.set(item.id, pair);
        }
    });
    const end = phases[0].hours;
    const countsAt = hours => {
        const counts = new Map(held);
        for (const [id, [first, then]] of rates) {
            const mean = first * Math.min(hours, end) + (then > 0 ? then * Math.max(0, hours - end) : 0);
            counts.set(id, (counts.get(id) || 0) + mean);
        }
        return counts;
    };
    if (!fullOf(view, bags, countsAt(Infinity))) return Infinity;
    let low = 0, high = 1;
    while (!fullOf(view, bags, countsAt(high))) { low = high; high *= 2; }
    for (let step = 0; step < 50; step++) {
        const mid = (low + high) / 2;
        if (fullOf(view, bags, countsAt(mid))) high = mid; else low = mid;
    }
    return high;
}

// plane({ view, kitHours, variant, accounts }): kitHours, the game's kit-hour
// readers (spotFactors, shotScale); variant, the supply variant ('table' |
// 'formula'); accounts, the run's account records (each main's persona).
function plane({ view, kitHours, variant, accounts }) {
    if (variant !== 'table' && variant !== 'formula') throw new Error(`no supply variant '${variant}' (table or formula)`);
    const personas = new Map(accounts.map(account => [account.id, account.persona || null]));
    const factorsOf = main => {
        const row = Engine.spotRowOf(view, main);
        return row ? kitHours.spotFactors(main.line, main.level, main.kit, row.spotId) : null;
    };
    const scaleOf = (main, row, form) => kitHours.shotScale(main.line, main.level, row.spotId, main.weapon, form === 'blessed');
    const hunter = Today.hunter(view, factorsOf, scaleOf);
    const bagsOf = main => {
        const bags = view.bags?.[main.line];
        if (!bags) throw new Error(`no bag row for line ${main.line} in the snapshot`);
        return bags;
    };
    // The form it hunts now: the one it fires while it holds the shots, else bare.
    const huntedOf = main => {
        const fired = Engine.firedOf(view, main, hunter.firing(main));
        return { ...fired, hunted: fired.held > 0 && fired.perHour > 0 ? fired.form : 'bare' };
    };

    return {
        sinks: [],
        deaths: true,
        born: true,
        start({ ledger, mains }) {
            ledger.counters.stuckNoBareHour = 0;
            const states = new Map();
            // The run report's tallies (each class by the level at the event's start): wall hours from a clock of
            // the level each main holds since an hour; road hours (the walk out, to town and back); trips whose
            // chain had an out fact or a short need and those that bought none of it; stuck episodes by reason
            // and their hours; the other variant's answers that differ; each main's bare hunting hours until its
            // first purchase of shots.
            const blank = () => ({ wallHours: 0, roadHours: 0, consumableTrips: 0, emptyTrips: 0, stuckEpisodes: {}, stuckHours: 0, stuckHoursByReason: {},
                stuckUnmeasuredEpisodes: 0, stuckUnmeasuredHours: 0 });
            const tally = { low: blank(), high: blank() };
            const clocks = new Map(mains.map(main => [main.index, { level: main.level, at: 0 }]));
            const bareFirst = new Map(), differs = new Map(), shadowed = { decisions: 0 };
            // A stuck episode ends: its hours go to the class of the level it began at.
            const unstuck = (state, now) => {
                if (!state.stuck) return state;
                const book = tally[classOf(state.stuck.level)], hours = now - state.stuck.at;
                book.stuckHours += hours;
                book.stuckHoursByReason[state.stuck.reason] = (book.stuckHoursByReason[state.stuck.reason] || 0) + hours;
                if (state.stuck.unmeasured) book.stuckUnmeasuredHours += hours;
                return { ...state, stuck: false };
            };
            const stateOf = main => states.get(main.index) || { account: { id: main.id, led: main.id, place: 'hunt', queue: [] }, full: false, stuck: false };
            const put = (main, state) => states.set(main.index, state);
            const queueFact = (state, kind, main, at) => ({ ...state, account: Attention.push(state.account, { kind, who: main.id, at }) });
            const placed = (state, place) => ({ ...state, account: { ...state.account, place } });

            // The supply decision's state on the main where it stands (place, the town it is in).
            const supplyState = (main, row, place, town, spotTown) => {
                const firing = hunter.firing(main), need = Needs.consumable(main, firing), surplus = Needs.surplus(main, need);
                const npcBuy = Object.fromEntries(surplus.map(([id]) => [id, view.items[id]?.npcBuy || 0]));
                // The NPC of the held spot's town that sells its shots (every starter town's does).
                const offer = need ? (view.offers.get(need.id) || []).find(each => each.town === spotTown && each.channel === 'npc_buy') : null;
                const toHours = Engine.toHoursOf(view, row.spotId), backHours = Engine.backHoursOf(view, row.spotId, spotTown);
                return { place, town, spotTown, need, surplus, npcBuy, wallet: main.money, roadMoney: 0, toHours, backHours,
                    offers: offer ? { town: offer.town, price: offer.price } : null, fightsBare: Engine.rowIn(row, 'bare').kills > 0, variant };
            };
            // The same with the formula's hour values (the table variant never reads them).
            // A field decision also runs the other variant (the shadow), so its state carries the hour values too.
            const decisionState = (main, row, place, town, spotTown) => {
                const state = supplyState(main, row, place, town, spotTown);
                if (variant !== 'formula' && place === 'town') return state;
                const factors = factorsOf(main), persona = personas.get(main.id), way = { wayBackHours: state.backHours };
                const { form, held, lasts, hunted } = huntedOf(main), kills = hunter.kills(main);
                const valueOf = (at, withoutDrop = false) => Value.hourValue(view, main, at, factors, persona, { ...way, withoutDrop });
                return { ...state, value: { hour: valueOf(form), bare: valueOf('bare'), withoutDrop: valueOf(hunted, true),
                    bagHoursBare: hoursToFull(view, bagsOf(main), main, row, [{ form: 'bare', kills: kills.bare, hours: Infinity }]),
                    outHours: held > 0 ? lasts : Infinity, M: Value.bestOf(view, main).npc, moneyWeight: Value.moneyWeight(persona) } };
            };
            // The heard chain where it stands and the supply decision's actions on it.
            const decide = (main, state, town) => {
                const { chain, account } = Attention.heard(state.account), next = { ...state, account };
                const row = Engine.spotRowOf(view, main), spotTown = townOf(view, main);
                if (!chain.length || !Catalog.woken(chain).includes('supply') || !row || !spotTown) return { state: next, actions: [], row, spotTown, chain, need: null };
                const deciding = decisionState(main, row, account.place, town, spotTown);
                if (account.place === 'town') return { state: next, actions: Supply.supplyChoice(chain, deciding), row, spotTown, chain, need: deciding.need };
                const seen = Supply.shadow(chain, deciding);
                shadowed.decisions++;
                if (seen.differ) {
                    const key = JSON.stringify([seen.differ.row, seen.differ.reason]);
                    differs.set(key, (differs.get(key) || 0) + 1);
                }
                return { state: next, actions: seen.actions, row, spotTown, chain, need: deciding.need };
            };
            // The hunting hours to its next fact: its shots' end, else its bag's fill (Infinity: none comes).
            const nextFactHours = (main, state) => {
                const row = Engine.spotRowOf(view, main);
                if (!row) return Infinity;
                const { form, held, lasts, hunted } = huntedOf(main), kills = hunter.kills(main);
                const out = hunted === 'bare' ? Infinity : lasts;
                const bag = state.full ? Infinity : hoursToFull(view, bagsOf(main), main, row,
                    [{ form, kills: kills[form], hours: held > 0 ? lasts : 0 }, { form: 'bare', kills: kills.bare, hours: Infinity }]);
                return Math.min(out, bag);
            };
            // The town chain's actions on the main: sales and purchases at the NPC, the walk back.
            const executed = (main, actions, town, backHours) => {
                const flows = Engine.emptyFlows();
                const delta = { flows, towns: [town], gearToNpc: 0, gearBought: 0, shotsBoughtFixed: 0, shotsBoughtNpc: 0, shotsSoldNpc: 0,
                    unsold: 0, missingPieces: 0, missingShots: 0, noTown: 0 };
                let next = main, afterHours = 0;
                for (const action of actions) {
                    if (action.kind === 'back') afterHours = backHours;
                    else if (EXECUTORS[action.kind]) next = EXECUTORS[action.kind](next, action, delta, view);
                }
                return { main: next, delta, afterHours };
            };

            return {
                firing: hunter.firing,
                kills: hunter.kills,
                // The worn kit's deaths at its row in the form it hunts.
                deathFactor: main => factorsOf(main)?.[huntedOf(main).hunted]?.deaths ?? 1,
                nextArrival(main, { now, huntShare }) {
                    const { state, actions, row, chain, need } = decide(main, stateOf(main), null);
                    const go = actions.find(action => action.kind === 'go');
                    if (go) {
                        const away = Engine.toHoursOf(view, row.spotId);
                        const trip = { at: now, level: main.level, consumable: chain.some(fact => fact.kind === 'out') || need?.short > 0 };
                        put(main, placed({ ...unstuck(state, now), trip }, 'road'));
                        return { at: now + away, away };
                    }
                    for (const action of actions) if (action.kind === 'stay') EXECUTORS.stay(main, action);
                    const hours = nextFactHours(main, state);
                    if (Number.isFinite(hours) && huntShare > 0) {
                        put(main, unstuck(state, now));
                        return { at: now + hours / huntShare, read: true };
                    }
                    // No fact will come. A main with no spot row stands (reason no_spot_row: nothing to hunt, no supply decision to take).
                    // Otherwise stuck is the supply rule's state (no shots of its need, nothing to pay with or sell, nothing
                    // killed bare), however it came there (a birth, a run-out, a respawn); one episode counts once, until the state ends.
                    const standing = row ? supplyState(main, row, 'hunt', null, townOf(view, main)) : null;
                    if (standing && !Supply.stuck(standing)) {
                        put(main, unstuck(state, now));
                        return null;
                    }
                    if (state.stuck) {
                        put(main, state);
                        return null;
                    }
                    const reason = standing ? Supply.stayReason(standing) : NO_SPOT_ROW, unmeasured = !!row?.shotlessUnmeasured, book = tally[classOf(main.level)];
                    if (standing) ledger.counters.stuckNoBareHour++;
                    book.stuckEpisodes[reason] = (book.stuckEpisodes[reason] || 0) + 1;
                    if (unmeasured) book.stuckUnmeasuredEpisodes++;
                    put(main, { ...state, stuck: { at: now, level: main.level, unmeasured, reason } });
                    return null;
                },
                hunt(main, delta) {
                    const first = bareFirst.get(main.index);
                    if (!first?.bought) bareFirst.set(main.index, { hours: (first?.hours || 0) + delta.huntBare, bought: false });
                    let state = stateOf(main);
                    if (FACTS.out(main, delta)) state = queueFact(state, 'out', main, main.since);
                    const bags = view.bags?.[main.line], full = bags ? fullOf(view, bags, carried(main)) : false;
                    if (FACTS.bag(state.full, full)) state = queueFact(state, 'bag', main, main.since);
                    put(main, { ...state, full });
                },
                visit(main, now, visitInfo) {
                    let state = stateOf(main), at = main;
                    const trip = state.account.place === 'road' ? state.trip : null;
                    if (FACTS.born(visitInfo)) {
                        at = { ...main, spot: heldSpot(view, main) };
                        state = queueFact(state, 'born', at, now);
                    }
                    if (FACTS.died(visitInfo)) state = queueFact(state, 'died', at, now);
                    const town = townOf(view, at);
                    if (!FACTS.town(town)) {
                        put(at, placed(state, 'hunt'));
                        return { main: at, delta: { ...executed(at, [], null, 0).delta, towns: [], noTown: 1 } };
                    }
                    state = queueFact(placed(state, 'town'), 'town', at, now);
                    const { state: heard, actions, row } = decide(at, state, town);
                    const chain = executed(at, actions, town, row ? Engine.backHoursOf(view, row.spotId, town) : 0);
                    // The chain's end takes the held spot again (the shots it bought) and it walks back to that spot.
                    const held = { ...chain.main, spot: heldSpot(view, chain.main) }, heldRow = Engine.spotRowOf(view, held);
                    const done = { ...chain, main: held, afterHours: chain.afterHours > 0 && heldRow ? Engine.backHoursOf(view, heldRow.spotId, town) : chain.afterHours };
                    // It walks back and hunts again from the visit's end.
                    put(done.main, { ...placed(heard, 'hunt'), trip: null, full: fullOf(view, bagsOf(done.main), carried(done.main)) });
                    // The report: the trip that ends here (its road, whether it bought its need) and the road back.
                    if (trip) {
                        const book = tally[classOf(trip.level)];
                        book.roadHours += now - trip.at;
                        if (trip.consumable) {
                            book.consumableTrips++;
                            if (!(chain.delta.shotsBoughtNpc > 0)) book.emptyTrips++;
                        }
                    }
                    tally[classOf(done.main.level)].roadHours += done.afterHours;
                    if (chain.delta.shotsBoughtNpc > 0) bareFirst.set(main.index, { hours: bareFirst.get(main.index)?.hours || 0, bought: true });
                    return done;
                },
                levelUp(main, now) {
                    const clock = clocks.get(main.index);
                    tally[classOf(clock.level)].wallHours += now - clock.at;
                    clocks.set(main.index, { level: main.level, at: now });
                    return main.spot ? main : { ...main, spot: heldSpot(view, main) };
                },
                event(event) { throw new Error(`an event of an unknown kind: ${event.kind}`); },
                hour: () => 0,
                finish(hours, ended) {
                    // What is still open at the end: wall hours at the level held, stuck episodes, the walk of a trip
                    // on the road and the part of a way back that falls after the run's last hour.
                    for (const clock of clocks.values()) tally[classOf(clock.level)].wallHours += hours - clock.at;
                    for (const state of states.values()) {
                        unstuck(state, hours);
                        if (state.trip) tally[classOf(state.trip.level)].roadHours += hours - state.trip.at;
                    }
                    for (const main of ended) if (main.since > hours) tally[classOf(main.level)].roadHours -= main.since - hours;
                    const levels = {}, lines = new Map(), distribution = {};
                    for (const [name, book] of Object.entries(tally)) {
                        // The road share is over the wall hours of mains that hold a spot row (the decision's denominator);
                        // roadShareAllMains is over every main's hours.
                        const deciding = book.wallHours - (book.stuckHoursByReason[NO_SPOT_ROW] || 0);
                        levels[name] = { ...book, decidingHours: deciding, roadShare: deciding > 0 ? book.roadHours / deciding : null,
                            roadShareAllMains: book.wallHours > 0 ? book.roadHours / book.wallHours : null,
                            emptyShare: book.consumableTrips > 0 ? book.emptyTrips / book.consumableTrips : null };
                    }
                    for (const main of ended) {
                        if (main.station) continue;
                        distribution[main.level] = (distribution[main.level] || 0) + 1;
                        const first = bareFirst.get(main.index) || { hours: 0, bought: false };
                        const row = lines.get(main.line) || { line: main.line, bots: 0, bought: 0, boughtHours: 0, neverHours: 0 };
                        row.bots++;
                        if (first.bought) { row.bought++; row.boughtHours += first.hours; } else row.neverHours += first.hours;
                        lines.set(main.line, row);
                    }
                    const bare = [...lines.values()].sort((a, b) => a.line - b.line).map(row => ({ line: row.line, bots: row.bots, bought: row.bought,
                        neverBought: row.bots - row.bought, meanHoursBeforeFirstBuy: row.bought ? row.boughtHours / row.bought : null,
                        meanHoursNeverBought: row.bots > row.bought ? row.neverHours / (row.bots - row.bought) : null }));
                    const differ = [...differs].map(([key, count]) => ({ row: JSON.parse(key)[0], reason: JSON.parse(key)[1], count }))
                        .sort((a, b) => b.count - a.count || (a.row + a.reason < b.row + b.reason ? -1 : 1));
                    return { design: { variant, levels, bareBeforeFirstBuy: bare, shadow: { decisions: shadowed.decisions, differ },
                        spotUnstated: kitHours.stats.spotUnstated, levelDistribution: distribution } };
                }
            };
        }
    };
}

// What a supply action does to the main (the closed set's executors; go and
// back are the trip's hours, which the plane answers to the engine).
const EXECUTORS = Object.freeze({
    // Sell to the NPC at its buy price: from the bag first, then the shots it spares.
    sell(main, action, delta, view) {
        const bag = { ...main.bag }, shots = { ...main.shots };
        let left = action.count;
        const fromBag = Math.min(bag[action.id] || 0, left);
        if (fromBag) { left -= fromBag; if (bag[action.id] - fromBag > 0) bag[action.id] -= fromBag; else delete bag[action.id]; }
        if (left > 0) { shots[action.id] = (shots[action.id] || 0) - left; delta.shotsSoldNpc += left; }
        const value = action.count * action.price;
        delta.flows.npcSales += value;
        if (Engine.isGear(view.items[action.id])) delta.gearToNpc += action.count;
        return { ...main, bag, shots, money: main.money + value };
    },
    // Buy from the NPC at its price.
    buy(main, action, delta) {
        const cost = action.count * action.price;
        delta.flows.npcBuys -= cost;
        delta.shotsBoughtNpc += action.count;
        return { ...main, shots: { ...main.shots, [action.id]: (main.shots[action.id] || 0) + action.count }, money: main.money - cost };
    },
    // Stay: it keeps hunting in the state it is in (without the shots); nothing moves.
    stay: main => main
});

module.exports = { plane, FACTS, EXECUTORS, hoursToFull };
