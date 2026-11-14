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
// The held spot is the line's best row at the level, kept while its row
// exists. Called by the engine (the only module of the design that touches
// the engine contract); pure on the view and the main except the account
// queues it holds by main index.
const Engine = require('../engine');
const Today = require('../today');
const SurvivalFloor = require('../../../src/GameServer/Bot/Population/SurvivalFloor');
const Attention = require('./attention');
const Catalog = require('./catalog');
const Needs = require('./needs');
const Value = require('./value');
const Supply = require('./supply');

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

// The held spot: the one it holds (the engine keeps it while its row exists at the level), else its line's best row.
const heldSpot = (view, main) => main.spot || (Engine.hourOf(view, main)?.best ? String(Engine.hourOf(view, main).best.spotId) : null);

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
        start({ ledger }) {
            ledger.counters.stuckNoBareHour = 0;
            const states = new Map();
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
            const decisionState = (main, row, place, town, spotTown) => {
                const state = supplyState(main, row, place, town, spotTown);
                if (variant !== 'formula') return state;
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
                if (!chain.length || !Catalog.woken(chain).includes('supply') || !row || !spotTown) return { state: next, actions: [], row, spotTown };
                return { state: next, actions: Supply.supplyChoice(chain, decisionState(main, row, account.place, town, spotTown)), row, spotTown };
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
                    const { state, actions, row } = decide(main, stateOf(main), null);
                    const go = actions.find(action => action.kind === 'go');
                    if (go) {
                        const away = Engine.toHoursOf(view, row.spotId);
                        put(main, placed({ ...state, stuck: false }, 'road'));
                        return { at: now + away, away };
                    }
                    for (const action of actions) if (action.kind === 'stay') EXECUTORS.stay(main, action);
                    const hours = nextFactHours(main, state);
                    if (Number.isFinite(hours) && huntShare > 0) {
                        put(main, { ...state, stuck: false });
                        return { at: now + hours / huntShare, read: true };
                    }
                    // No fact will come. Stuck is the supply rule's state (no shots of its need, nothing to pay with or sell, nothing
                    // killed bare), however it came there (a birth, a run-out, a respawn); one episode counts once, until the state ends.
                    const stuck = !!row && Supply.stuck(supplyState(main, row, 'hunt', null, townOf(view, main)));
                    if (stuck && !state.stuck) ledger.counters.stuckNoBareHour++;
                    put(main, { ...state, stuck });
                    return null;
                },
                hunt(main, delta) {
                    let state = stateOf(main);
                    if (FACTS.out(main, delta)) state = queueFact(state, 'out', main, main.since);
                    const bags = view.bags?.[main.line], full = bags ? fullOf(view, bags, carried(main)) : false;
                    if (FACTS.bag(state.full, full)) state = queueFact(state, 'bag', main, main.since);
                    put(main, { ...state, full });
                },
                visit(main, now, visitInfo) {
                    let state = stateOf(main), at = main;
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
                    const done = executed(at, actions, town, row ? Engine.backHoursOf(view, row.spotId, town) : 0);
                    // It walks back and hunts again from the visit's end.
                    put(done.main, { ...placed(heard, 'hunt'), full: fullOf(view, bagsOf(done.main), carried(done.main)) });
                    return done;
                },
                levelUp: main => (main.spot ? main : { ...main, spot: heldSpot(view, main) }),
                event(event) { throw new Error(`an event of an unknown kind: ${event.kind}`); },
                hour: () => 0,
                finish: () => ({})
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
