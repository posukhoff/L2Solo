'use strict';

// A stub of the gnome trade, the maintainer's design for the model (ours, not C4's rule: in C4 any player buys the
// graded shots at an NPC; here the hidden store stands for the dwarf craft and resale a C4 server runs on).
// Gnomes are the mains of the dwarf lines (spoilers and crafters). Only they buy D+ shots, C+ gear and the weapon
// enchant scrolls from the hidden store (the configured stores' fixed_wts lines), at the wholesale price: share x
// the market price, never below the store's price (ref). Every other main buys those goods from a gnome at the
// market price in a town with gnome supply (a gnome whose last town chain or held spot is that town); without one
// where it stands it buys from the cheapest seller in reach: a gnome town by its fare, or for D+ shots only the
// hidden store at the safety valve (2 x ref); C+ gear and scrolls without a gnome in reach wait (decision 468). The gnome keeps market - wholesale per unit: the town's margin of an
// hour is split among the town's gnomes at the hour's close and credited at each gnome's next visit (the plane
// holds it until then). Scrolls come from a capped server stock per grade (refilled each hour, at most two hours'
// worth). Market prices float at each hour's close, 5 % up when the hour's demand exceeds the gnome supply, else
// 5 % down, between ref x1 and the ceiling: shots per (grade, town), gear and scrolls per grade. The gnome supply
// is the wallets of the gnomes that serve the market (ours: the adena they can front at wholesale; demand is the
// wholesale value they fronted); for scrolls the hour's stock against the units wanted. Materials: another main
// sells the materials of the gnome goods' recipes to a gnome in its town at the gnome bid (between the NPC
// buy-back and the fixed buyer's 1.5 x the NPC buy-back, start 1.2 x), else to the NPC; the gnome sells them on to
// the fixed buyer (the faucet) and keeps the spread. The bid falls 5 % in an hour when the materials offered exceed
// the town's gnome wallets, else rises.
const { GRADE_ORDER } = require('../gear');
const Engine = require('../engine');

const START = 1.3, STEP = 1.05, VALVE = 2, SCROLL_CEILING = 5;
const BID = { low: 1, high: 1.5, start: 1.2, buyer: 1.5 };
const SCROLLS_PER_HOUR = Object.freeze({ C: 20, B: 10, A: 5 });
const STOCK_HOURS = 2;

// market({ view, gnomeLines, share, scrolls: { grade: scrollId }, recipes }): the trade's state, mutated by the plane
// in event order (one run, one market).
function market({ view, gnomeLines, share, scrolls, recipes }) {
    const lines = new Set([...gnomeLines].map(String));
    const scrollGrade = new Map(Object.entries(scrolls).map(([grade, id]) => [Number(id), grade]));
    const shotGrade = new Map();
    view.shotFamilies?.ids.forEach(ids => ids.forEach((id, at) => { if ((GRADE_ORDER[view.shotFamilies.grades[at]] ?? 0) >= GRADE_ORDER.D) shotGrade.set(id, view.shotFamilies.grades[at]); }));
    const gradeOfItem = id => String(view.items[id]?.grade || 'NONE').toUpperCase();
    // What the trade covers of an item: { kind, grade } or null.
    const kindOf = id => {
        if (scrollGrade.has(id)) return { kind: 'scroll', grade: scrollGrade.get(id) };
        if (shotGrade.has(id)) return { kind: 'shot', grade: shotGrade.get(id) };
        if (Engine.isGear(view.items[id]) && (GRADE_ORDER[gradeOfItem(id)] ?? 0) >= GRADE_ORDER.C) return { kind: 'gear', grade: gradeOfItem(id) };
        return null;
    };
    const hidden = new Map(), ref = new Map();
    for (const [id, rows] of view.offers) {
        const own = rows.filter(row => row.channel === 'fixed_wts');
        if (own.length && kindOf(id)) { hidden.set(id, own); ref.set(id, Math.min(...own.map(row => row.price))); }
    }
    // The materials of the recipes of the goods the trade covers.
    const materials = new Set();
    for (const recipe of recipes || []) if (kindOf(Number(recipe.productId))) for (const m of recipe.materials) materials.add(Number(m.selfId));

    const isGnome = main => lines.has(String(main.line));
    const mult = new Map(), keyOf = (kind, grade, town) => (kind === 'shot' ? `shot|${grade}|${town}` : `${kind}|${grade}`);
    const multOf = key => mult.get(key) ?? START;
    const bids = new Map(), bidOf = town => bids.get(town) ?? BID.start;
    const stock = Object.fromEntries(Object.entries(SCROLLS_PER_HOUR).map(([grade, n]) => [grade, n]));
    const townsOf = new Map(), latest = new Map(), pending = new Map(), pool = new Map();
    let served = null;
    const servedTowns = () => {
        if (served) return served;
        served = new Map();
        for (const [index, towns] of townsOf) for (const town of towns) { if (!served.has(town)) served.set(town, []); served.get(town).push(index); }
        return served;
    };
    // The hour's books: demand and supply by market key, the margin by town.
    let hour = { demand: new Map(), offered: new Map(), stock: { ...stock } };
    const stats = { shotUnits: { gnome: 0, valve: 0, own: 0 }, gearPieces: { gnome: 0, valve: 0, own: 0 }, scrolls: { supplied: 0, bought: 0, refused: 0, dropUsed: 0 },
        gearWait: { started: 0, ended: [], open: new Map() }, margin: 0, spread: 0, hiddenSpend: { gnomeWholesale: 0, valve: 0, gnomeOwn: 0 }, credited: 0, index: {}, money: {} };
    const add = (map, key, value) => map.set(key, (map.get(key) || 0) + value);
    const priceAt = (id, m) => Math.round(ref.get(id) * m);
    const wholesaleMult = m => Math.max(1, share * m);

    // The offers a main reads (a view for Engine.sellerOf): the trade's goods re-priced for gnome or not.
    const rowsFor = (gnome, id) => {
        const base = view.offers.get(id);
        const what = hidden.has(id) ? kindOf(id) : null;
        if (!what) return base;
        const others = base.filter(row => row.channel !== 'fixed_wts');
        if (gnome) return [...others, ...hidden.get(id).map(row => ({ ...row, price: priceAt(id, wholesaleMult(multOf(keyOf(what.kind, what.grade, row.town)))) }))];
        const towns = servedTowns();
        const gnomeRows = [...towns.keys()].map(town => ({ town, price: priceAt(id, multOf(keyOf(what.kind, what.grade, town))), channel: 'gnome' }));
        const valve = what.kind !== 'shot' ? [] : hidden.get(id).filter(row => !towns.has(row.town)).map(row => ({ ...row, price: Math.round(ref.get(id) * VALVE) }));
        return [...others, ...gnomeRows, ...valve];
    };
    const views = { true: { ...view, offers: { get: id => rowsFor(true, Number(id)) } }, false: { ...view, offers: { get: id => rowsFor(false, Number(id)) } } };

    return {
        isGnome,
        priced: main => views[isGnome(main)],
        kindOf,
        scrollStock: grade => stock[grade] || 0,
        // A main heard at a hook: its money (the KPI's snapshots, a gnome's wallet for the supply); a gnome's towns.
        seen(main, towns = null) {
            latest.set(main.index, { money: main.money, level: main.level, gnome: isGnome(main) });
            if (towns && isGnome(main)) { townsOf.set(main.index, [...new Set(towns.filter(Boolean))]); served = null; }
        },
        // The gnome bid for a main's material sale in a town, or null (a gnome main, no gnome there, not a material).
        bid(main, town, id) {
            if (isGnome(main) || !town || !materials.has(Number(id)) || !servedTowns().has(town)) return null;
            return Math.round((view.items[id]?.npcBuy || 0) * bidOf(town));
        },
        // A sale to the gnome (an executed NPC sale re-booked): the seller got count x bid; the fixed buyer pays the
        // faucet, the spread goes to the town's margin.
        soldToGnome(delta, town, action) {
            const value = action.count * action.price, buyer = action.count * Math.round((view.items[action.id]?.npcBuy || 0) * BID.buyer);
            delta.flows.npcSales -= value;
            delta.flows.fixedBuyers += buyer;
            add(pool, town, buyer - value);
            stats.spread += buyer - value;
            add(hour.offered, town, value);
        },
        // The purchases a chain made at town: gnome channel entries ({ id, count, price }) get their wholesale sink and margin;
        // a gnome's or a valve purchase from the hidden store is counted.
        settle(main, delta, town) {
            for (const entry of delta.gnome.splice(0)) {
                const what = kindOf(entry.id), m = multOf(keyOf(what.kind, what.grade, town)), wholesale = priceAt(entry.id, wholesaleMult(m));
                delta.flows.fixedSellers -= entry.count * wholesale;
                add(pool, town, entry.count * (entry.price - wholesale));
                stats.margin += entry.count * (entry.price - wholesale);
                stats.hiddenSpend.gnomeWholesale += entry.count * wholesale;
                add(hour.demand, keyOf(what.kind, what.grade, town), entry.count * (what.kind === 'scroll' ? 1 : wholesale));
                if (what.kind === 'shot') stats.shotUnits.gnome += entry.count; else if (what.kind === 'gear') stats.gearPieces.gnome += entry.count;
                else { stats.scrolls.bought += entry.count; stock[what.grade] -= entry.count; }
            }
            for (const entry of delta.hidden.splice(0)) {
                const what = hidden.has(entry.id) ? kindOf(entry.id) : null, own = isGnome(main);
                if (!what) continue;
                stats.hiddenSpend[own ? 'gnomeOwn' : 'valve'] += entry.count * entry.price;
                const book = what.kind === 'shot' ? stats.shotUnits : what.kind === 'gear' ? stats.gearPieces : null;
                if (book) book[own ? 'own' : 'valve'] += entry.count;
                else { stats.scrolls.bought += entry.count; stock[what.grade] -= entry.count; add(hour.demand, keyOf('scroll', what.grade), entry.count); }
            }
        },
        // A scroll try refused for an empty stock: the units wanted the market reads.
        refused(grade) { stats.scrolls.refused++; add(hour.demand, keyOf('scroll', grade), 1); },
        // A non-gnome's C+ gear purchase the hidden store would fund but no gnome in reach sells: its wait starts (once).
        gearWaits(main, now) { if (!stats.gearWait.open.has(main.index)) { stats.gearWait.open.set(main.index, now); stats.gearWait.started++; } },
        // A gear piece bought from a gnome ends its wait.
        gearBought(main, now) { const at = stats.gearWait.open.get(main.index); if (at !== undefined) { stats.gearWait.ended.push(now - at); stats.gearWait.open.delete(main.index); } },
        droppedScrollUsed() { stats.scrolls.dropUsed++; },
        // The hour's close: the margins split among each town's gnomes, the prices' drift, the scroll stock's refill.
        close(at) {
            const towns = servedTowns();
            for (const [town, amount] of pool) {
                const gnomes = towns.get(town);
                if (!gnomes?.length || amount <= 0) continue;
                const each = Math.floor(amount / gnomes.length);
                for (const index of gnomes) pending.set(index, (pending.get(index) || 0) + each);
                pool.set(town, amount - each * gnomes.length);
            }
            const wallet = index => latest.get(index)?.money || 0;
            const townWallets = town => (towns.get(town) || []).reduce((sum, index) => sum + wallet(index), 0);
            const allWallets = [...townsOf.keys()].reduce((sum, index) => sum + wallet(index), 0);
            const keys = new Set([...mult.keys(), ...hour.demand.keys()]);
            for (const key of keys) {
                const [kind, grade, town] = key.split('|');
                const supply = kind === 'shot' ? townWallets(town) : kind === 'gear' ? allWallets : hour.stock[grade];
                const ceiling = kind === 'scroll' ? SCROLL_CEILING : VALVE;
                mult.set(key, Math.min(ceiling, Math.max(1, multOf(key) * ((hour.demand.get(key) || 0) > supply ? STEP : 1 / STEP))));
            }
            for (const town of new Set([...bids.keys(), ...hour.offered.keys()])) {
                bids.set(town, Math.min(BID.high, Math.max(BID.low, bidOf(town) * ((hour.offered.get(town) || 0) > townWallets(town) ? 1 / STEP : STEP))));
            }
            for (const [grade, n] of Object.entries(SCROLLS_PER_HOUR)) { stock[grade] = Math.min(STOCK_HOURS * n, stock[grade] + n); stats.scrolls.supplied += n; }
            hour = { demand: new Map(), offered: new Map(), stock: { ...stock } };
            if (at === 20 || at === 50 || at === 100) this.snapshot(at);
        },
        // The KPI at an hour: the price index per grade (shots: the mean over the towns priced) and the money per main by band.
        snapshot(at) {
            const index = {};
            for (const [key, m] of mult) {
                const [kind, grade] = key.split('|'), name = `${kind} ${grade}`;
                (index[name] ||= []).push(m);
            }
            stats.index[at] = Object.fromEntries(Object.entries(index).map(([name, ms]) => [name, ms.reduce((a, b) => a + b, 0) / ms.length]));
            const bands = {};
            for (const [index, row] of latest) {
                const band = row.level <= 19 ? '1-19' : row.level <= 39 ? '20-39' : row.level <= 59 ? '40-59' : '60+';
                const book = bands[band] ||= { gnome: [0, 0], other: [0, 0] }, side = book[row.gnome ? 'gnome' : 'other'];
                side[0] += row.money + (pending.get(index) || 0);
                side[1]++;
            }
            stats.money[at] = bands;
        },
        // A gnome's credited margin at its visit (taken from the plane's holding).
        credit(index) { const amount = pending.get(index) || 0; pending.delete(index); stats.credited += amount; return amount; },
        held: () => [...pool.values(), ...pending.values()].reduce((a, b) => a + b, 0),
        stats
    };
}

module.exports = { market, SCROLLS_PER_HOUR };
