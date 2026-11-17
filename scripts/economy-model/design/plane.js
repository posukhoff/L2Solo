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
//   death    the respawn town (the town of the row it died at) runs the same chain.
// The held spot is the outing spot rule's (OutingSpot): taken at its birth and
// the end of each town chain (an outing's start), kept while it fits, re-picked
// among the spots that fit when it stops fitting (or by a min-maxer persona);
// a new level never moves it unless the spot has no row at that level. Called
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
const BagClearing = require('../../../src/GameServer/Bot/Economy/BagClearing');
const Attention = require('./attention');
const Catalog = require('./catalog');
const Needs = require('./needs');
const ConsumableTarget = require('../../../src/GameServer/Bot/Economy/ConsumableTarget');
const Value = require('./value');
const Supply = require('./supply');
const LIMITS = require('./limits');
const OutingSpot = require('../../../src/GameServer/Bot/AI/OutingSpot');
const { slotsConflict } = require('../kit-hours');

// The report's frame: levels 1-19 are the design's, 20 and above are counted apart.
const LOW_LEVEL_LAST = 19;
// The stuck reason of a main whose level has no spot row for its line.
const NO_SPOT_ROW = 'no_spot_row';
const classOf = level => (level <= LOW_LEVEL_LAST ? 'low' : 'high');
// The level bands the spot choice report holds stints by (the level a spot was taken at).
const bandOf = level => (level <= 9 ? '1-9' : level <= 19 ? '10-19' : level <= 39 ? '20-39' : '40+');

// The facts the plane raises, each a test on what just happened.
const FACTS = Object.freeze({
    // A new character entered the world (the birth visit).
    born: visitInfo => visitInfo.born === true,
    // The hunt spent the last of the shots it fires.
    out: (main, delta) => delta.shotId > 0 && delta.shotsUsed > 0 && !(main.shots[delta.shotId] > 0),
    // A level changed the shot it fires to one it holds none of while it held what it fired before (the orc mystic's
    // class at 20 fires Soulshots; its Spiritshots for Beginners charge none of them): the same run-out as a hunt's, heard as out.
    outAtLevel: (heldBefore, heldNow, fires) => fires && heldBefore > 0 && heldNow === 0,
    // The bag reached the full rule now and was not full before.
    bag: (wasFull, full) => !wasFull && full,
    // It arrived in a town (a trip's end, a birth or a respawn).
    town: town => town !== null,
    // It died (the respawn town's arrival follows).
    died: visitInfo => visitInfo.died === true
});

// The held spot's town (the spot card's town at the level), null without one.
const townOf = (view, main) => Engine.townOfRow(view, Engine.spotRowOf(view, main), main.level);

// What it holds of the shot its hour fires at its level: the weapon's grade, the beginner shots that charge it count;
// 0 where its hour fires none.
function heldFired(view, main) {
    const hour = Engine.hourOf(view, main), shot = hour?.shotId ? Engine.shotOf(view, main, hour) : 0;
    return shot ? Engine.heldOf(main, { id: shot, beginner: Engine.beginnerOf(view, shot) }) : 0;
}

// The rows the held spot is chosen among and the form it hunts them in: its line's rows it hunts with shots (the game's
// best, the top and the others: spots of its top at earlier levels still in their range, the scroll spots) when it holds
// the shots it fires (the weapon's grade; the beginner shots that charge them count: Engine.heldOf), else those it hunts
// without them (bareTop at the levels of the model's hunting table; above them the game's rows, its bare answer bareBest
// and the shots candidates); none bare, the shots rows. The held spot's own row joins them while it has one at the
// level. Only rows it kills in that form.
// { form, rows } or null without an hour.
function candidateRows(view, main, held) {
    const hour = Engine.hourOf(view, main);
    if (!hour) return null;
    const own = held === null ? null : Engine.spotRowOf(view, { ...main, spot: held, occupied: null });
    const unique = rows => rows.filter((row, at) => row && rows.findIndex(other => other && String(other.spotId) === String(row.spotId)) === at);
    const killed = (rows, form) => unique(rows).filter(row => Engine.rowIn(row, form).kills > 0);
    const withOwn = (rows, form) => killed([...rows, own && String(own.spotId) === held ? own : null], form);
    const shotsRows = [hour.best, ...hour.top || [], ...hour.others || []], bareRows = hour.bareTop || [hour.bareBest, ...shotsRows];
    const form = heldFired(view, main) > 0 || !killed(bareRows, 'bare').length ? 'shots' : 'bare';
    return { form, rows: withOwn(form === 'shots' ? shotsRows : bareRows, form) };
}

// The game's inventory full rule (SurvivalFloor.evaluate: its slots or the
// first weight penalty) on counts { id: count } of what it carries (the worn
// kit, its shots and its bag): a stack takes one slot, a piece of gear one
// each. bags: the line's { slots, maxLoad }.
function fullOf(view, bags, counts, held = { load: 0, slots: 0 }) {
    let load = held.load;
    for (const [id, count] of counts) if (count > 0) load += loadOf(view, id, count);
    return SurvivalFloor.evaluate({ slots: held.slots + slotsOf(view, counts), slotLimit: bags.slots, load, maxLoad: bags.maxLoad }) !== null;
}

const loadOf = (view, id, count) => (view.items[id]?.weight ? count * view.items[id].weight : 0);
const slotOf = (view, id, count) => (Engine.isGear(view.items[id]) ? count : count >= 1 ? 1 : 0);

// The slots counts { id: count } take: a stack one, a piece of gear one each.
function slotsOf(view, counts) {
    let slots = 0;
    for (const [id, count] of counts) if (count > 0) slots += slotOf(view, id, count);
    return slots;
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
    // What it holds of the items the hunt adds none of weighs and takes the same at every hour: summed once.
    const still = { load: 0, slots: 0 };
    for (const [id, count] of held) if (count > 0 && !rates.has(id)) { still.load += loadOf(view, id, count); still.slots += slotOf(view, id, count); }
    const countsAt = hours => {
        const counts = new Map();
        for (const [id, [first, then]] of rates) {
            const mean = first * Math.min(hours, end) + (then > 0 ? then * Math.max(0, hours - end) : 0);
            counts.set(id, (held.get(id) || 0) + mean);
        }
        return counts;
    };
    const fullAt = hours => fullOf(view, bags, countsAt(hours), still);
    if (!fullAt(Infinity)) return Infinity;
    let low = 0, high = 1;
    while (!fullAt(high)) { low = high; high *= 2; }
    for (let step = 0; step < 50; step++) {
        const mid = (low + high) / 2;
        if (fullAt(mid)) high = mid; else low = mid;
    }
    return high;
}

// The worn kit's factors on a row of the kit it was measured with: none.
const UNIT = Object.freeze({ kills: 1, shots: 1, deaths: 1 }), UNITS = Object.freeze({ bare: UNIT, shots: UNIT, blessed: UNIT });

// plane({ view, kitHours, variant, accounts, table }): kitHours, the game's kit-hour
// readers (spotFactors, shotScale); variant, the supply variant ('table' |
// 'formula'); accounts, the run's account records (each main's persona);
// table: the model's hunting table's levels { range: [from, to], creation(line,
// level): the creation kit { slot: selfId }, the one kit point it measured }, or none;
// gear: the game's NPC gear rule (gear.js npcGear: next(main, town, reserve) -> the
// piece funded now or null), or none (no gear is bought).
function plane({ view, kitHours, variant, accounts, table = null, gear = null }) {
    if (variant !== 'table' && variant !== 'formula') throw new Error(`no supply variant '${variant}' (table or formula)`);
    const personas = new Map(accounts.map(account => [account.id, account.persona || null]));
    // At the table's levels a row is the hour of the kit point it measured: the creation kit reads it as it is
    // (factor 1); another worn kit is off the table's grid, read at that one point and counted (offGrid: a main at a level).
    const offGrid = new Set();
    const measured = main => {
        if (!table || main.level < table.range[0] || main.level > table.range[1]) return false;
        const worn = Object.entries(main.kit).filter(([, selfId]) => selfId), creation = table.creation(main.line, main.level);
        if (worn.length !== Object.keys(creation).length || worn.some(([slot, selfId]) => creation[slot] !== Number(selfId))) offGrid.add(`${main.id}@${main.level}`);
        return true;
    };
    const factorsOf = main => {
        const row = Engine.spotRowOf(view, main);
        if (!row) return null;
        return measured(main) ? UNITS : kitHours.spotFactors(main.line, main.level, main.kit, row.spotId);
    };
    // The row's shots are the measured kit's weapon's at the table's levels (factor 1).
    const scaleOf = (main, row, form) => (measured(main) ? 1 : kitHours.shotScale(main.line, main.level, row.spotId, main.weapon, form === 'blessed'));
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
    // The bag's clearing at its fact (BagClearing, the game's rule at bag_full): its rows at the NPC's
    // buy price (the trip's sale), the hour's money at its spot row in the form it hunts (adena and the
    // drop at the NPC's price, at its kit's kills), the walk back from the spot's town (the game's
    // WalkBack leg) and the slots the row fills an hour (a stack at most one, a piece of gear each:
    // our reading of the game's spot-table stacks); a row frees the slots it takes in the bag (slotsOf,
    // the full rule's count: a stack below one unit frees none). It stands when the cleared bag is no longer full;
    // else the bag goes to town. { bag, clear } or null.
    const clearedBag = (main, bags) => {
        const row = Engine.spotRowOf(view, main), factors = factorsOf(main);
        if (!row || !factors) return null;
        const { hunted } = huntedOf(main), kills = factors[hunted]?.kills ?? 1, hour = Engine.rowItems(view, main, row, hunted);
        const rows = Object.entries(main.bag).map(([id, count]) => ({ selfId: Number(id), count,
            slots: slotsOf(view, [[id, count]]), value: count * (view.items[id]?.npcBuy || 0) })).filter(item => item.slots > 0);
        const clear = BagClearing.choose(rows, { hourValue: hour.npc * kills, tripHours: Engine.backHoursOf(view, row.spotId, townOf(view, main)),
            slots: slotsOf(view, carried(main)), slotsPerHour: hour.items.reduce((sum, item) => sum + (item.stack ? Math.min(1, item.rate) : item.rate), 0) * kills });
        if (!clear) return null;
        const bag = { ...main.bag };
        for (const item of clear.items) delete bag[item.selfId];
        return fullOf(view, bags, carried({ ...main, bag })) ? null : { bag, clear };
    };

    return {
        sinks: [],
        deaths: true,
        born: true,
        start({ ledger, mains }) {
            ledger.counters.stuckNoBareHour = 0;
            ledger.counters.fullBagHuntHours = 0;
            ledger.counters.fullBagLostDrop = 0;
            ledger.counters.bagClears = 0;
            ledger.counters.bagClearValue = 0;
            // The gear step: weapons bought (each one a swap of the weapon in hand), adena spent on gear, and the
            // shots sold in a chain whose gear step changed the weapon (the older grade, spare after the swap).
            ledger.counters.weaponSwaps = 0;
            ledger.counters.gearSpent = 0;
            ledger.counters.gearReserve = {};
            ledger.counters.shotsSoldAtSwap = 0;
            // The chains' onward hops (one at most per chain: to a piece's seller, else to its shots' seller) and their fares.
            ledger.counters.hops = 0;
            ledger.counters.hopFares = 0;
            const states = new Map();
            // The run report's tallies (each class by the level at the event's start): wall hours from a clock of
            // the level each main holds since an hour; road hours (the walk out, to town and back); trips by the facts in
            // their chain (an out fact: consumable; a bag fact and no out fact: bag; both) and the consumable ones that bought none of their need; stuck episodes by reason
            // and their hours; the other variant's answers that differ; each main's bare hunting hours until its
            // first purchase of shots.
            const blank = () => ({ wallHours: 0, roadHours: 0, consumableTrips: 0, bagTrips: 0, bothTrips: 0, emptyTrips: 0, stuckEpisodes: {}, stuckHours: 0, stuckHoursByReason: {},
                stuckUnmeasuredEpisodes: 0, stuckUnmeasuredHours: 0, needDecisions: 0, needHours: 0, needBinds: { slots: 0, dropLoad: 0, stockLoad: 0 } });
            const tally = { low: blank(), high: blank() };
            const clocks = new Map(mains.map(main => [main.index, { level: main.level, at: 0 }]));
            const bareFirst = new Map(), differs = new Map(), shadowed = { decisions: 0 };
            // The held spot's answers (by reason; fallback: no spot fit), the unsafe candidates refused, the changes heard at a new level other
            // than a spot with no row there (midFarm: must stay 0), and per main its stint on a spot (the level it took it
            // at, the spots it left, the one before) for the levels held, the returns and the A-B-A returns.
            const spotChoice = { first: 0, kept: 0, unfit: { level_gap: 0, unsafe: 0, no_row: 0 }, minmax: 0,
                fallback: { outleveled: 0, least_risk: 0 }, none: 0, refusedUnsafe: 0, midFarm: 0,
                levelUps: 0, changes: 0, returns: 0, aba: 0, held: [] };
            const stints = new Map();
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

            // The stock rule's inputs at the held spot (fill), on the bag the town chain leaves (it sells every drop) in the
            // form it hunts on the stock (its shots form when it fires, else bare): the slot forecast (hoursToFull with the
            // weight test off, one stack of the shot it fires held), the drop's load an hour, the load left below the first
            // weight step after the worn kit and the shots it keeps but does not size, and the fired shot's mass.
            const fillOf = (main, row, firing) => {
                const bags = bagsOf(main), kills = hunter.kills(main), form = firing ? Engine.firedOf(view, main, firing).form : 'bare';
                const weight = id => view.items[id]?.weight || 0;
                const shots = firing ? { ...main.shots, [firing.id]: Math.max(1, main.shots[firing.id] || 0) } : main.shots;
                const slotHours = hoursToFull(view, { ...bags, maxLoad: Infinity }, { ...main, shots, bag: {} }, row, [{ form, kills: kills[form], hours: Infinity }]);
                const loadPerHour = Engine.rowItems(view, main, row, form).items.reduce((sum, item) => sum + item.rate * item.weight, 0) * kills[form];
                let kept = 0;
                for (const id of Object.values(main.kit)) if (id) kept += weight(id);
                for (const [id, count] of Object.entries(main.shots)) if (!firing || (Number(id) !== firing.id && Number(id) !== firing.beginner)) kept += count * weight(id);
                return { slotHours, loadPerHour, freeLoad: SurvivalFloor.loadLimit(bags.maxLoad) - kept, mass: firing ? weight(firing.id) : 0 };
            };
            // Which term set the need's hours: the slots, else the larger load an hour of the drop's and the stock's own.
            const bindOf = (fill, need) => {
                if (need.hours >= fill.slotHours) return 'slots';
                return need.perHour * fill.mass * (1 + ConsumableTarget.RESERVE) > fill.loadPerHour ? 'stockLoad' : 'dropLoad';
            };
            // The held spot at an outing's start (OutingSpot.choose): held, the spot it holds (null at its birth). A candidate is
            // a row in the form it hunts there: its hour value (no road), the spot card's mean mob level, and the outing's facts
            // OutingSpot checks safety over: its deaths an hour at the worn kit at each level from its level to the level its exp
            // an hour there reaches over the outing's horizon (the supply rule's: the need's hours, else the hours to a full bag),
            // capped at the spot's last row (a level without the spot's row has none; the worn kit's factor is the start
            // level's). A row with no deaths at its level or any later one needs no horizon: its outing deaths are 0.
            // A held spot that fits is checked alone (no ranking). The run report's spotChoice counts each answer and the
            // stints it ends.
            const candidateOf = (main, row, form) => {
                const at = { ...main, spot: String(row.spotId) }, factors = factorsOf(at), avgLevel = view.spotAvgLevel?.[at.spot];
                if (!Number.isFinite(avgLevel)) throw new Error(`no mean mob level for spot ${at.spot} in the snapshot (spotAvgLevel)`);
                const value = Value.hourValue(view, at, form, factors, personas.get(main.id)), hour = Engine.rowIn(row, form);
                const ahead = deathsOf(main.line, at.spot, form), deaths = factors[form].deaths;
                if (!(hour.deaths > 0) && !(ahead.worstFrom[main.level + 1] > 0)) {
                    return { spotId: at.spot, value, avgLevel, members: [{ deathsByLevel: [], reachLevel: main.level, outingHours: 0 }] };
                }
                // members is read lazily, once: OutingSpot reads the outing facts only of the candidates it checks.
                let members = null;
                const factsOf = () => {
                    const firing = hunter.firing(at), fill = fillOf(at, row, firing), need = Needs.consumable(at, firing, fill);
                    const outingHours = need ? need.hours : ConsumableTarget.bagHours({ ...fill, stock: [] });
                    const reached = Engine.levelOf(view, main.exp + Engine.huntExp(at, hour, outingHours * factors[form].kills), main.level);
                    const reachLevel = Math.min(reached, ahead.last), deathsByLevel = { [main.level]: (hour.deaths || 0) * deaths };
                    for (let level = main.level + 1; level <= reachLevel; level++) deathsByLevel[level] = ahead.byLevel[level] * deaths;
                    return [{ deathsByLevel, reachLevel, outingHours }];
                };
                return { spotId: at.spot, value, avgLevel, get members() { return members || (members = factsOf()); } };
            };
            // A spot's deaths an hour by level in a form (its rows' at the reference kit, 0 at a level without its row), the
            // worst from a level to its last row and that last level, per (line, spot, form): the rows are static, built once.
            const deathsIndex = new Map();
            const deathsOf = (line, spot, form) => {
                const key = `${line}|${spot}|${form}`;
                if (deathsIndex.has(key)) return deathsIndex.get(key);
                const byLevel = new Array(view.maxLevel + 2).fill(0), worstFrom = new Array(view.maxLevel + 2).fill(0);
                let last = 0;
                for (let level = 1; level <= view.maxLevel; level++) {
                    const own = Engine.spotRowOf(view, { line, level, spot, occupied: null });
                    if (own && String(own.spotId) === spot) { byLevel[level] = Engine.rowIn(own, form).deaths || 0; last = level; }
                }
                for (let level = view.maxLevel; level >= 1; level--) worstFrom[level] = Math.max(byLevel[level], worstFrom[level + 1]);
                const index = { byLevel, worstFrom, last };
                deathsIndex.set(key, index);
                return index;
            };
            const holdSpot = (main, held) => {
                const pool = candidateRows(view, main, held);
                if (!pool) return null;
                const ask = { held, members: [{ level: main.level }], minMax: OutingSpot.minMaxer(personas.get(main.id)), bound: LIMITS.SAFE_OUTING_DEATHS.value };
                const ownRow = held === null || ask.minMax ? null : pool.rows.find(row => String(row.spotId) === held);
                let picked = ownRow ? OutingSpot.choose({ ...ask, candidates: [candidateOf(main, ownRow, pool.form)] }) : null;
                if (picked?.reason !== 'kept') picked = OutingSpot.choose({ ...ask, candidates: pool.rows.map(row => candidateOf(main, row, pool.form)) });
                const [reason, why] = picked.reason.split(':');
                if (why) spotChoice[reason][why]++; else spotChoice[reason]++;
                spotChoice.refusedUnsafe += picked.refusedUnsafe;
                const stint = stints.get(main.index) || { spot: null, takenAt: main.level, left: new Set(), prev: null, started: false };
                if (!stint.started) stints.set(main.index, { ...stint, spot: picked.spotId, takenAt: main.level, started: true });
                else if (picked.spotId !== stint.spot) {
                    spotChoice.changes++;
                    if (stint.spot !== null) spotChoice.held.push({ band: bandOf(stint.takenAt), levels: main.level - stint.takenAt });
                    const left = stint.spot !== null ? new Set([...stint.left, stint.spot]) : stint.left;
                    if (picked.spotId !== null && left.has(picked.spotId)) { spotChoice.returns++; if (picked.spotId === stint.prev) spotChoice.aba++; }
                    stints.set(main.index, { spot: picked.spotId, takenAt: main.level, left, prev: stint.spot, started: true });
                }
                return picked.spotId;
            };

            // The supply decision's state on the main where it stands (place, the town it is in).
            const supplyState = (main, row, place, town, spotTown) => {
                const firing = hunter.firing(main), fill = fillOf(main, row, firing), need = Needs.consumable(main, firing, fill), surplus = Needs.surplus(main, need);
                const horizon = need ? need.hours : ConsumableTarget.bagHours({ ...fill, stock: [] });
                const npcBuy = Object.fromEntries(surplus.map(([id]) => [id, view.items[id]?.npcBuy || 0]));
                // Who sells its shots: the town it stands in (in the field the held spot's town) when it sells them, else the
                // first other town by price plus the fare (Engine.sellerOf); an NPC sells the no-grade shots in every town, the configured city stores the graded ones.
                const offer = need ? Engine.sellerOf(view, need.id, place === 'town' ? town : spotTown) : null;
                const toHours = Engine.toHoursOf(view, row.spotId), backHours = Engine.backHoursOf(view, row.spotId, spotTown);
                return { place, town, spotTown, need, fill, horizon, surplus, npcBuy, wallet: main.money, roadMoney: 0, toHours, backHours,
                    offers: offer ? { town: offer.town, price: offer.price, channel: offer.channel } : null, fightsBare: Engine.rowIn(row, 'bare').kills > 0, variant };
            };
            // The same with the formula's hour values (the table variant never reads them).
            // A field decision also runs the other variant (the shadow), so its state carries the hour values too.
            const decisionState = (main, row, place, town, spotTown, bagFull) => {
                const state = supplyState(main, row, place, town, spotTown);
                if (variant !== 'formula' && place === 'town') return state;
                const factors = factorsOf(main), persona = personas.get(main.id);
                const { form, held, lasts, hunted } = huntedOf(main), kills = hunter.kills(main);
                // The formula's hour is the hour's value less the price of its deaths (the way back from the held spot's town).
                const valueOf = (at, withoutDrop = false) => Value.hourValue(view, main, at, factors, persona, { withoutDrop }) - Value.deathCost(view, main, at, factors, state.backHours);
                return { ...state, value: { bagFull, hour: valueOf(form), bare: valueOf('bare'), withoutDrop: valueOf(hunted, true),
                    bagHoursBare: hoursToFull(view, bagsOf(main), main, row, [{ form: 'bare', kills: kills.bare, hours: Infinity }]),
                    outHours: held > 0 ? lasts : Infinity, M: Value.bestOf(view, main).npc, moneyWeight: Value.moneyWeight(persona) } };
            };
            // The heard chain where it stands and the supply decision's actions on it.
            const decide = (main, state, town) => {
                const { chain, account } = Attention.heard(state.account), next = { ...state, account };
                const row = Engine.spotRowOf(view, main), spotTown = townOf(view, main);
                if (!chain.length || !Catalog.woken(chain).includes('supply') || !row || !spotTown) return { state: next, actions: [], row, spotTown, chain, need: null, decided: false };
                const deciding = decisionState(main, row, account.place, town, spotTown, state.full);
                if (account.place === 'town') {
                    if (deciding.need) {
                        const book = tally[classOf(main.level)];
                        book.needDecisions++;
                        book.needHours += deciding.need.hours;
                        book.needBinds[bindOf(deciding.fill, deciding.need)]++;
                    }
                    return { state: next, actions: Supply.supplyChoice(chain, deciding), row, spotTown, chain, need: deciding.need, decided: true };
                }
                const seen = Supply.shadow(chain, deciding);
                shadowed.decisions++;
                if (seen.differ) {
                    const key = JSON.stringify([seen.differ.row, seen.differ.reason]);
                    differs.set(key, (differs.get(key) || 0) + 1);
                }
                return { state: next, actions: seen.actions, row, spotTown, chain, need: deciding.need, decided: true };
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
            // The town chain's actions on the main: sales and purchases at the NPC, the walk back (onto the
            // delta of the chain's earlier part when one is given).
            const executed = (main, actions, town, backHours, delta = null, afterHours = 0) => {
                delta ||= { flows: Engine.emptyFlows(), towns: [town], gearToNpc: 0, gearBought: 0, shotsBoughtFixed: 0, shotsBoughtNpc: 0, shotsSoldNpc: 0,
                    unsold: 0, missingPieces: 0, missingShots: 0, noTown: 0 };
                let next = main;
                for (const action of actions) {
                    if (action.kind === 'back') afterHours = backHours;
                    else if (EXECUTORS[action.kind]) next = EXECUTORS[action.kind](next, action, delta, view);
                }
                return { main: next, delta, afterHours };
            };
            // The adena the main keeps from gear: its stock target of the shot it fires at the town's NPC price.
            const reserveOf = (main, row, town, spotTown) => {
                const { need, offers } = supplyState(main, row, 'town', town, spotTown);
                return need && offers ? need.target * offers.price : 0;
            };
            // The town chain: the supply decision's sales; then the gear the game's NPC rule buys with what the
            // wallet holds above the reserve, piece by piece on the state the last purchase left; when it bought any
            // or hopped, the supply decision again on that state where it stands (the older grade is spare now, the
            // new weapon's shots its need), else the first decision's other actions. One onward hop per chain (a
            // gatekeeper teleport, as a human takes): to a funded piece sold in another town, where the gear step goes
            // on (a piece sold in a third town ends it); else, after the gear step, to the seller of the shots it needs
            // when the town it stands in does not sell them and the wallet pays the fare and one unit (Engine.hopSeller). It walks back from where
            // it ends. The chain's answer names that town.
            const townChain = (main, decided, town, spotTown, full) => {
                const { actions, row, chain: facts } = decided, backOf = at => (row ? Engine.backHoursOf(view, row.spotId, at) : 0);
                if (!gear || !decided.decided) return { ...executed(main, actions, town, backOf(town)), town };
                const sold = executed(main, actions.filter(action => action.kind === 'sell'), town, backOf(town));
                let next = sold.main, swapped = false, at = town, hopped = false;
                const hop = seller => {
                    next = { ...next, money: Engine.hopTo(seller, next.money, sold.delta) };
                    at = seller.town;
                    hopped = true;
                    ledger.counters.hops++;
                    ledger.counters.hopFares += seller.fare;
                };
                // The gear rule's own null ends it: each piece costs more than the NPC pays back for what it replaces.
                for (;;) {
                    const buy = gear.next(next, at, reserveOf(next, row, at, spotTown));
                    if (!buy || (buy.town !== at && hopped)) break;
                    if (buy.town !== at) hop(buy);
                    next = EXECUTORS.gear(next, { kind: 'gear', id: buy.selfId, slot: buy.slot, price: buy.price, channel: buy.channel }, sold.delta, view);
                    ledger.counters.gearSpent += buy.price;
                    if (buy.channel === 'fixed_wts') { const grade = view.items[buy.selfId]?.grade || '-'; ledger.counters.gearReserve[grade] = (ledger.counters.gearReserve[grade] || 0) + 1; }
                    if (buy.weapon) { ledger.counters.weaponSwaps++; swapped = true; }
                }
                if (!hopped) {
                    const { need } = supplyState(next, row, 'town', at, spotTown);
                    const seller = need && need.short > 0 ? Engine.hopSeller(view, [need.id], at, next.money) : null;
                    if (seller) hop(seller);
                }
                if (next === sold.main) return { ...executed(next, actions.filter(action => action.kind !== 'sell'), at, backOf(at), sold.delta), town: at };
                const soldBefore = sold.delta.shotsSoldNpc;
                const again = executed(next, Supply.supplyChoice(facts, decisionState(next, row, 'town', at, spotTown, full)), at, backOf(at), sold.delta);
                if (swapped) ledger.counters.shotsSoldAtSwap += again.delta.shotsSoldNpc - soldBefore;
                return { ...again, town: at };
            };

            return {
                firing: hunter.firing,
                kills: hunter.kills,
                // A full bag takes no item drop until a town visit empties it.
                full: main => stateOf(main).full,
                // The worn kit's deaths at its row in the form it hunts.
                deathFactor: main => factorsOf(main)?.[huntedOf(main).hunted]?.deaths ?? 1,
                nextArrival(main, { now, huntShare }) {
                    const { state, actions, row, chain, need } = decide(main, stateOf(main), null);
                    const go = actions.find(action => action.kind === 'go');
                    if (go) {
                        const away = Engine.toHoursOf(view, row.spotId);
                        const trip = { at: now, level: main.level, out: chain.some(fact => fact.kind === 'out'), bag: chain.some(fact => fact.kind === 'bag') };
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
                    if (state.full) ledger.counters.fullBagHuntHours += delta.huntHours;
                    ledger.counters.fullBagLostDrop += Math.round(delta.lostDrop);
                    if (FACTS.out(main, delta)) state = queueFact(state, 'out', main, main.since);
                    const bags = view.bags?.[main.line], full = bags ? fullOf(view, bags, carried(main)) : false;
                    const cleared = FACTS.bag(state.full, full) ? clearedBag(main, bags) : null;
                    if (cleared) {
                        ledger.counters.bagClears++;
                        ledger.counters.bagClearValue += cleared.clear.value;
                        put(main, { ...state, full: false });
                        return cleared.bag;
                    }
                    if (FACTS.bag(state.full, full)) state = queueFact(state, 'bag', main, main.since);
                    put(main, { ...state, full });
                },
                visit(main, now, visitInfo) {
                    let state = stateOf(main), at = main;
                    const trip = state.account.place === 'road' ? state.trip : null;
                    if (FACTS.born(visitInfo)) {
                        at = { ...main, spot: holdSpot(main, null) };
                        state = queueFact(state, 'born', at, now);
                    }
                    if (FACTS.died(visitInfo)) state = queueFact(state, 'died', at, now);
                    // A death's chain runs in the respawn town the engine names (where it died); any other visit's
                    // in the held spot's town.
                    const town = FACTS.died(visitInfo) ? visitInfo.town : townOf(view, at);
                    if (!FACTS.town(town)) {
                        put(at, placed(state, 'hunt'));
                        return { main: at, delta: { ...executed(at, [], null, 0).delta, towns: [], noTown: 1 } };
                    }
                    state = queueFact(placed(state, 'town'), 'town', at, now);
                    const decided = decide(at, state, town), heard = decided.state;
                    const chain = townChain(at, decided, town, decided.spotTown, state.full);
                    // The chain's end is an outing's start: the held spot is kept or re-picked (on the shots it bought; the
                    // purchases were sized on the spot it held, the next visit sizes on a new one) and it walks back to it.
                    const back = { ...chain.main, spot: holdSpot(chain.main, chain.main.spot === null ? null : String(chain.main.spot)) }, heldRow = Engine.spotRowOf(view, back);
                    const done = { ...chain, main: back, afterHours: chain.afterHours > 0 && heldRow ? Engine.backHoursOf(view, heldRow.spotId, chain.town) : chain.afterHours };
                    // It walks back and hunts again from the visit's end.
                    put(done.main, { ...placed(heard, 'hunt'), trip: null, full: fullOf(view, bagsOf(done.main), carried(done.main)) });
                    // The report: the trip that ends here (its road, whether it bought its need) and the road back.
                    if (trip) {
                        const book = tally[classOf(trip.level)];
                        book.roadHours += now - trip.at;
                        if (trip.bag && !trip.out) book.bagTrips++;
                        if (trip.bag && trip.out) book.bothTrips++;
                        if (trip.out) {
                            book.consumableTrips++;
                            if (!(chain.delta.shotsBoughtNpc + chain.delta.shotsBoughtFixed > 0)) book.emptyTrips++;
                        }
                    }
                    tally[classOf(done.main.level)].roadHours += done.afterHours;
                    if (chain.delta.shotsBoughtNpc + chain.delta.shotsBoughtFixed > 0) bareFirst.set(main.index, { hours: bareFirst.get(main.index)?.hours || 0, bought: true });
                    return done;
                },
                levelUp(main, now) {
                    const clock = clocks.get(main.index);
                    tally[classOf(clock.level)].wallHours += now - clock.at;
                    clocks.set(main.index, { level: main.level, at: now });
                    // A new level keeps the held spot; only a spot with no row at this level (the engine's null) is left at once
                    // (it cannot be hunted there).
                    spotChoice.levelUps++;
                    const before = stints.get(main.index)?.spot ?? null, forced = main.spot === null && before !== null;
                    const next = forced ? { ...main, spot: holdSpot(main, before) } : main;
                    if (!forced && (next.spot === null ? null : String(next.spot)) !== before) spotChoice.midFarm++;
                    const firing = hunter.firing(next);
                    if (FACTS.outAtLevel(heldFired(view, { ...next, level: clock.level }), heldFired(view, next), !!firing)) {
                        put(next, queueFact(stateOf(next), 'out', next, now));
                    }
                    return next;
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
                    const quantile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null; };
                    const heldBy = band => { const levels = spotChoice.held.filter(each => band === 'all' || each.band === band).map(each => each.levels);
                        return { stints: levels.length, p10: quantile(levels, 0.1), p50: quantile(levels, 0.5), p90: quantile(levels, 0.9) }; };
                    const open = [...stints.values()].filter(stint => stint.spot !== null);
                    const mains = ended.filter(main => !main.station), botHours = mains.length * hours;
                    // The gear at the end: each main's weapon by its grade, and the shot units it holds of a grade its
                    // weapon cannot fire (a graded shot of another grade than the weapon's).
                    const gradeOf = id => view.items[id]?.grade || 'NONE', families = view.shotFamilies;
                    const weapons = {}, otherGrade = {};
                    for (const main of mains) {
                        weapons[gradeOf(main.weapon)] = (weapons[gradeOf(main.weapon)] || 0) + 1;
                        for (const [id, count] of Object.entries(main.shots)) {
                            const family = families?.ids.find(ids => ids.includes(Number(id)));
                            const grade = family ? families.grades[family.indexOf(Number(id))] : null;
                            if (grade && count > 0 && grade !== gradeOf(main.weapon)) otherGrade[grade] = (otherGrade[grade] || 0) + count;
                        }
                    }
                    const counts = Object.fromEntries(Object.entries(spotChoice).filter(([key]) => key !== 'held'));
                    const spotReport = { ...counts, botHours, changesPerBotHour: botHours > 0 ? spotChoice.changes / botHours : null,
                        returnShare: spotChoice.changes ? spotChoice.returns / spotChoice.changes : null, abaShare: spotChoice.changes ? spotChoice.aba / spotChoice.changes : null,
                        levelsHeld: Object.fromEntries(['all', '1-9', '10-19', '20-39', '40+'].map(band => [band, heldBy(band)])),
                        openStints: open.length, minMaxers: mains.filter(main => OutingSpot.minMaxer(personas.get(main.id))).length, mains: mains.length };
                    return { design: { variant, levels, spotChoice: spotReport, bareBeforeFirstBuy: bare, shadow: { decisions: shadowed.decisions, differ },
                        spotUnstated: kitHours.stats.spotUnstated, offGrid: offGrid.size, levelDistribution: distribution,
                        gear: { weaponSwaps: ledger.counters.weaponSwaps, swapsPerMain: mains.length ? ledger.counters.weaponSwaps / mains.length : null,
                            spent: ledger.counters.gearSpent, reserveBought: ledger.counters.gearReserve, shotsSoldAtSwap: ledger.counters.shotsSoldAtSwap, hops: ledger.counters.hops, hopFares: ledger.counters.hopFares,
                            endWeapons: weapons, heldOtherGrade: otherGrade } } };
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
    // Buy from its seller at its price: the NPC, or a configured city store (a fixed seller).
    buy(main, action, delta) {
        const cost = action.count * action.price;
        if (action.channel === 'fixed_wts') { delta.flows.fixedSellers -= cost; delta.shotsBoughtFixed += action.count; } else { delta.flows.npcBuys -= cost; delta.shotsBoughtNpc += action.count; }
        return { ...main, shots: { ...main.shots, [action.id]: (main.shots[action.id] || 0) + action.count }, money: main.money - cost };
    },
    // Buy a piece of gear from the NPC at its price and wear it in its slot: what it cannot be worn with (the
    // same slot; a two-handed weapon and the one-handed one or the shield; a full armour and the chest or legs)
    // comes off and is sold to the NPC as spare. A weapon bought is the weapon in hand.
    gear(main, action, delta, view) {
        const kit = { ...main.kit };
        let money = main.money - action.price;
        if (action.channel === 'fixed_wts') delta.flows.fixedSellers -= action.price; else delta.flows.npcBuys -= action.price;
        delta.gearBought++;
        for (const [slot, selfId] of Object.entries(kit)) {
            if (!selfId || !slotsConflict(action.slot, Number(slot))) continue;
            kit[slot] = 0;
            const value = view.items[selfId]?.npcBuy || 0;
            money += value;
            delta.flows.npcSales += value;
            delta.gearToNpc++;
        }
        kit[action.slot] = action.id;
        return { ...main, kit, weapon: Engine.isWeapon(view.items[action.id]) ? action.id : main.weapon, money };
    },
    // Stay: it keeps hunting in the state it is in (without the shots); nothing moves.
    stay: main => main
});

module.exports = { plane, FACTS, EXECUTORS, hoursToFull };
