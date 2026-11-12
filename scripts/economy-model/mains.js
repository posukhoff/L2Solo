'use strict';

// The mains' side of the economy model's design mode (design.js holds the
// account plane): it builds the views of the character plane's rules
// (rules/path, acquire, trip, visit, occupation) from the run's state and
// commits their answers. Each rule answers its own question at its own
// situations: path at grade_changed, gear_changed and source_stalled;
// acquire when path or visit read a piece's routes; trip after every
// committed event of a main and at offer_posted / bid_posted; visit at
// arrived_town; occupation at grade_changed and when the spot leaves the
// main's levels. A main's market state (its ads, wants, path) lives on its
// account; its money, bag, shots, kit and spot on the engine's main.
const Engine = require('./engine');
const Books = require('./books');
const Bounds = require('./rules/bounds');
const Knowledge = require('./rules/knowledge');
const Worth = require('./rules/worth');
const { path, refillHours } = require('./rules/path');
const { acquire } = require('./rules/acquire');
const { trip, goalOf, deathAt } = require('./rules/trip');
const { visit } = require('./rules/visit');
const { occupation, stayHours } = require('./rules/occupation');
const Workshop = require('./rules/workshop');
const { hash, mulberry } = require('../hunt-tables/common');

const ADS = 'ads';
const FORMULAS = Object.freeze(['gear_gain', 'hunt_cycle']);
const gradeOfItem = item => String(item?.grade || 'NONE').toLowerCase();

// ctx: the design plane's state and helpers (design.js startPlane).
function mainsSide(ctx) {
    const { snapshot, game, config, view, mains, accounts, books, stats, put, wakeAt, seed, rateOf, gradeOfLevel, grades, shotWorth, depositFee } = ctx;
    const ads = Books.create(), orders = new Map(), wantsByItem = new Map();
    const marketOf = index => accounts[index].market;
    const setMarket = (index, patch) => put(index, { market: { ...accounts[index].market, ...patch } });
    const townOf = main => { const row = Engine.spotRowOf(view, main); return row ? view.yields[`${row.spotId}@${main.level}`]?.town || null : null; };
    const fareOf = (from, to) => (from === to ? 0 : view.fares[from]?.[to] ?? null);
    const firstLevel = grade => grades.find(([name]) => name === grade)?.[1] ?? 1;
    const kitAt = (main, level) => view.kits[main.line]?.[Math.min(view.maxLevel, level)] || [];
    // The gear ladder (the snapshot's gearLadder) of a main's line in the
    // band of its level: the band's rungs and hours, null without one.
    const ladderOf = main => (snapshot.gearLadder?.lines?.[main.line] || []).find(row => main.level >= row.from && main.level <= row.to) || null;
    const groupOf = Worth.ladderGroup;
    // The piece a main wears in a slot (its weapon for either hand), 0 for none.
    const wornIn = (main, slot) => (groupOf(slot) === 'weapon' ? main.weapon || 0 : main.kit[slot] || 0);
    // A piece's ladder row in a band ({ hour, gear }), null without one; a
    // worn piece without a row reads as the empty slot.
    const rungRow = (row, group, selfId) => { const hour = row?.hour[group]?.[selfId]; return hour === undefined ? null : { hour, gear: row.gear[group]?.[selfId] ?? 0 }; };
    const wornRow = (row, group, selfId) => rungRow(row, group, selfId) ?? rungRow(row, group, 0);
    // The slots path aims at, one a ladder group of the main's kit at its own
    // level (both hands one aim, the weapon's first), each with its
    // candidates: the rungs of its band's ladder (its grade and below) whose
    // hunt hour beats the piece it wears there, best first, a weapon rung in
    // its own hand's slot; held: the worn piece is of the main's grade.
    const aimsOf = main => {
        const row = ladderOf(main), grade = gradeOfLevel(main.level), aims = [], seen = new Set();
        if (!row) return aims;
        for (const piece of kitAt(main, main.level)) {
            const group = groupOf(piece.slot), key = group === 'weapon' ? group : String(piece.slot);
            if (seen.has(key)) continue;
            seen.add(key);
            const worn = wornIn(main, piece.slot), floor = wornRow(row, group, worn)?.hour ?? -Infinity;
            const candidates = (row.rungs[group] || []).filter(id => id !== worn && (row.hour[group]?.[id] ?? -Infinity) > floor)
                .map(selfId => ({ selfId, slot: group === 'weapon' ? snapshot.gearLadder.slots?.[selfId] || piece.slot : piece.slot }));
            aims.push({ slot: piece.slot, group, worn, held: worn > 0 && gradeOfItem(view.items[worn]) === grade, candidates });
        }
        return aims.sort((a, b) => (b.group === 'weapon') - (a.group === 'weapon'));
    };
    // The next grade's kit at its first level; none past the last grade.
    const aheadKit = main => {
        const at = grades.findIndex(([name]) => name === gradeOfLevel(main.level)), next = grades[at + 1];
        if (!next) return [];
        return kitAt(main, next[1]).map(piece => ({ selfId: piece.selfId, slot: piece.slot }));
    };
    // Does a grade's ladder of a slot group hold a rung with a priced route
    // for a main standing in a town: an NPC seller it reaches (the route the
    // game fixes; a player's line comes and goes, and the Luxury exchange needs
    // crystals on lines in reach, which a main cannot count on)? Memo key: line,
    // grade, group, town (its inputs).
    const pricedMemo = new Map();
    const gradePriced = (main, group, town, grade) => {
        const key = `${main.line}@${grade}@${group}@${town}`;
        if (pricedMemo.has(key)) return pricedMemo.get(key);
        const first = firstLevel(grade), row = (snapshot.gearLadder?.lines?.[main.line] || []).find(band => first >= band.from && first <= band.to);
        const priced = !!row && (row.rungs[group] || []).some(id => gradeOfItem(view.items[id]) === grade
            && (view.offers.get(id) || []).some(offer => offer.channel === 'npc_buy' && fareOf(town, offer.town) !== null));
        pricedMemo.set(key, priced);
        return priced;
    };
    const priceOfItem = (memory, id) => Knowledge.known(memory, id) ?? view.items[id]?.npcBuy ?? 0;

    // A spot row's items per hunting hour at the design's yields: [{ id, rate,
    // weight, stack }] and its income at the NPC's buy price. Memo key: line,
    // level, spot, with or without shots (the row's inputs).
    const rowMemo = new Map();
    const rowItems = (main, row, bare) => {
        const key = `${main.line}@${main.level}@${row.spotId}@${bare ? 1 : 0}`;
        if (rowMemo.has(key)) return rowMemo.get(key);
        const hour = bare && row.shotless ? { ...row, ...row.shotless } : row;
        const items = Engine.designYieldRows(view, main.line, main.level, hour, bare).map(([id, perKill]) => ({ id, rate: perKill * hour.kills,
            weight: view.items[id]?.weight || 0, stack: !Engine.isGear(view.items[id]) }));
        const adena = hour.adena * Engine.designAdenaFactor(view, row, main.level);
        const out = { items, adena, npc: adena + items.reduce((sum, item) => sum + item.rate * (view.items[item.id]?.npcBuy || 0), 0) };
        rowMemo.set(key, out);
        return out;
    };
    // The own hour: income per hunting hour at its spot at known prices (its
    // memory, else the NPC's buy price), without shots when it holds none.
    // hourAt: the same for any row at its level.
    const holdsShots = main => { const hour = Engine.hourOf(view, main); return !hour?.shotId || (main.shots[Engine.shotOf(view, main, hour)] || 0) > 0; };
    const hourAt = (main, row, memory) => {
        const at = rowItems(main, row, !holdsShots(main));
        let hour = at.npc;
        for (const deal of memory) {
            const item = at.items.find(entry => entry.id === deal.item);
            if (item) hour += item.rate * (deal.price - (view.items[deal.item]?.npcBuy || 0));
        }
        return Math.max(0, hour);
    };
    const ownHour = (main, memory) => { const row = Engine.spotRowOf(view, main); return row ? hourAt(main, row, memory) : 0; };
    // Hunting hours to a level at the main's spot, and to the end of its grade stage.
    const hoursTo = (main, level) => {
        const row = Engine.spotRowOf(view, main);
        if (!(row?.exp > 0)) return 0;
        return Math.max(0, Engine.expAt(view, Math.min(level, view.maxLevel)) - main.exp) / row.exp;
    };
    const horizonOf = main => { const next = grades.find(([, from]) => from > main.level); return hoursTo(main, next ? next[1] : view.maxLevel); };
    // The least a piece sells for: the NPC's buy price or the best
    // crystallizer bid in the book it deals on.
    const resaleOf = (selfId, book) => {
        const item = view.items[selfId], bids = (book.bids?.[gradeOfItem(item)] || []).filter(entry => entry.qty > 0);
        const bid = item?.crystals > 0 && bids.length ? Math.max(...bids.map(entry => entry.price)) * item.crystals : null;
        return Bounds.floor({ npcBuy: item?.npcBuy || 0, crystallizerBids: bid === null ? [] : [bid] });
    };
    // The hunting hours a piece of a slot is worn: to the end of its own
    // grade, and on to the end of the next grade when that grade's piece of
    // the slot has no priced route for the main (gradePriced); never further:
    // a main expects to replace a piece within one grade after its own.
    const useHoursOf = (main, slot, town) => {
        const next = grades.findIndex(([, from]) => from > main.level);
        if (next < 0) return horizonOf(main);
        if (gradePriced(main, groupOf(slot), town, grades[next][0])) return hoursTo(main, grades[next][1]);
        return hoursTo(main, next + 1 < grades.length ? grades[next + 1][1] : view.maxLevel);
    };
    // The hours a piece's gain counts over and its resale (worthHorizon).
    const horizonFor = (main, selfId, slot, book, town) => Worth.horizon({ reading: config.worthHorizon, gradeHours: horizonOf(main),
        useHours: useHoursOf(main, slot, town), resale: resaleOf(selfId, book) });
    // Farm hours of each item at the spot that drops it fastest among the
    // spots the main can hunt at its own level (its line's rows there):
    // item -> { hours, row, where }. Memo key: line, level, shots held (the
    // rows' inputs). The farm spot's hour is read at the main's known prices.
    const farmMemo = new Map();
    const farmOf = main => {
        const bare = !holdsShots(main), key = `${main.line}@${main.level}@${bare ? 1 : 0}`;
        if (farmMemo.has(key)) return farmMemo.get(key);
        const best = new Map(), hour = Engine.hourOf(view, main);
        for (const row of hour ? [hour.best, ...(hour.top || []), ...(hour.others || [])].filter(Boolean) : []) {
            for (const item of rowItems(main, row, bare).items) {
                const held = best.get(item.id);
                if (item.rate > 0 && (!held || item.rate > held.rate)) best.set(item.id, { rate: item.rate, hours: 1 / item.rate, row, where: String(row.spotId) });
            }
        }
        farmMemo.set(key, best);
        return best;
    };
    const farmRoute = (main, memory, id) => { const at = farmOf(main).get(id); return at ? { hours: at.hours, spotHour: hourAt(main, at.row, memory), where: at.where } : null; };

    // What a main deals on: the lines and bids of the town it stands in and
    // the ads (others' only), and its own twin's bids wherever the twin sits
    // (through the account warehouse). Its twin's town's lines it knows
    // without dealing there: seen holds their cheapest sell price per item.
    const reachBook = (index, town, ids, grades) => {
        const twinTown = accounts[index].twin?.town || null;
        const book = { sell: {}, buy: {}, bids: {}, seen: {} };
        for (const id of ids) {
            const sell = [], buy = [];
            for (const entry of Books.rowsOf(books, town, 'sell', id)) if (entry.owner !== index) sell.push({ ...entry, kind: 'line' });
            for (const entry of Books.rowsOf(books, town, 'buy', id)) if (entry.owner !== index) buy.push({ ...entry, kind: 'line' });
            for (const entry of Books.rowsOf(ads, ADS, 'sell', id)) if (entry.owner !== index) sell.push({ ...entry, kind: 'ad' });
            for (const entry of Books.rowsOf(ads, ADS, 'buy', id)) if (entry.owner !== index) buy.push({ ...entry, kind: 'ad' });
            if (sell.length) book.sell[id] = sell.sort((a, b) => a.price - b.price || a.owner - b.owner);
            if (buy.length) book.buy[id] = buy.sort((a, b) => b.price - a.price || a.owner - b.owner);
            if (twinTown && twinTown !== town) {
                const far = Books.rowsOf(books, twinTown, 'sell', id).filter(entry => entry.owner !== index && entry.qty > 0);
                if (far.length) book.seen[id] = Math.min(...far.map(entry => entry.price));
            }
        }
        for (const grade of grades) {
            const bids = [];
            for (const entry of Books.rowsOf(books, town, 'bids', grade)) if (entry.owner !== index) bids.push({ ...entry });
            if (twinTown) for (const entry of Books.rowsOf(books, twinTown, 'bids', grade)) if (entry.owner === index) bids.push({ ...entry, own: true });
            if (bids.length) book.bids[grade] = bids;
        }
        return book;
    };

    // A price to a main: its last deal, else the cheapest line or ad it deals
    // on, else the cheapest line it knows in its twin's town, else the first price.
    const priceToMain = (memory, book, id) => Knowledge.known(memory, id) ?? book.sell[id]?.[0]?.price ?? book.seen[id] ?? game.firstPrice[id] ?? null;
    // The recipe an order names: one a twin can hold (a scroll something
    // drops or spoils, or an A/S quest variant its Create Item level gives),
    // the least MP first. null when none.
    const orderRecipe = selfId => (game.byProduct[selfId] || []).map(id => game.recipes[id])
        .filter(row => row.type === 'dwarven' && (row.quest || game.sourced[row.recipeItemId])).sort((a, b) => a.mpCost - b.mpCost || a.recipeId - b.recipeId)[0] || null;
    // The inputs of a piece's order: the order route reads their lines in town
    // (a crystal or a crafted input only a twin's store sells).
    const orderInputs = selfId => (orderRecipe(selfId)?.materials || []).map(row => row.selfId);

    // The routes of one piece (acquire) and its cap, for a main standing in town.
    const routesOf = (index, main, town, book, piece) => {
        const account = accounts[index], memory = account.memory, hour = ownHour(main, memory), selfId = piece.selfId;
        const npc = (view.offers.get(selfId) || []).filter(row => row.channel === 'npc_buy').map(row => ({ town: row.town, price: row.price, fare: fareOf(town, row.town) }))
            .filter(row => row.fare !== null);
        const recipe = orderRecipe(selfId);
        // A material's line: the cheapest the account knows in reach (the town it stands in, else its twin's town).
        const order = recipe ? { recipeId: recipe.recipeId, fee: recipe.mpCost * config.orderFeePerMp, mp: recipe.mpCost, units: recipe.productCount * recipe.successRate / 100,
            materials: recipe.materials.map(row => {
                const farm = farmRoute(main, memory, row.selfId);
                return { selfId: row.selfId, amount: row.amount, held: main.bag[row.selfId] || 0, sale: Knowledge.known(memory, row.selfId) ?? view.items[row.selfId]?.npcBuy ?? 0,
                    line: book.sell[row.selfId]?.[0]?.price ?? book.seen[row.selfId] ?? null, npc: game.npcByTown[town]?.[row.selfId] ?? null, farmHours: farm?.hours || 0, spotHour: farm?.spotHour || 0,
                    crafter: game.firstPrice[row.selfId] ?? null };
            }) } : null;
        const lux = snapshot.luxuryOptions?.[selfId];
        const exchange = lux && fareOf(town, lux.town) !== null ? { town: lux.town, fare: fareOf(town, lux.town),
            options: [['c', lux.c], ['d', lux.d]].filter(([, amount]) => amount > 0).map(([g, amount]) => ({ grade: g, amount, price: priceToMain(memory, book, game.crystalIds[g.toUpperCase()]) })) } : null;
        // The piece's use per hunting hour (its hunt hour over the worn piece's): what a wait for it costs.
        const ladder = ladderOf(main), group = groupOf(piece.slot), rows = { rung: rungRow(ladder, group, selfId), worn: wornRow(ladder, group, wornIn(main, piece.slot)) };
        const horizon = horizonFor(main, selfId, piece.slot, book, town);
        const used = Worth.rungWorth({ formula: config.worth, ...rows, useHours: horizon.hours, ownHour: hour, gainBound: config.huntCycleGainBound });
        // No ladder row: its use cannot be stated (counted), and acquire offers no farm priced by it.
        if (used.adena === null) stats.routes.noWorth++;
        const own = { cap: Infinity, ownHour: hour, hourCost: config.hourCost, useHour: used.adena === null ? null : used.perHour, lines: [], npc, order, orderMaterials: config.orderMaterials, farm: farmRoute(main, memory, selfId), exchange,
            twin: account.twin ? ctx.ownCraft(index, selfId) : null, stalled: account.market.stalled[selfId] || [] };
        const routes = acquire(piece, own);
        stats.routes.priced++;
        if (routes?.routeCost === 0) stats.routes.zero++;
        const capped = capOf(rows, horizon, routes?.routeCost ?? null, game.npcByTown[town]?.[selfId] ?? null, hour);
        const lines = (book.sell[selfId] || []).map(entry => ({ price: entry.price, kind: entry.kind, where: entry.kind === 'ad' ? 'ad' : entry.town }));
        // What the piece is worth to its account's workshop: the least of its
        // worth and its cheapest route other than a player's line or the own twin.
        const other = routes?.routes.find(option => option.route !== 'buy' && option.route !== 'twin');
        const need = Math.min(capped.worth ?? Infinity, other ? other.cost : Infinity);
        return { ...capped, useHours: horizon.hours, perHour: used.perHour, resale: horizon.resale, need: Number.isFinite(need) ? need : null,
            acquired: lines.length ? acquire(piece, { ...own, cap: capped.cap ?? 0, lines }) : routes };
    };
    // A piece's cap: min(worth, own route, the NPC here); both formulas' caps
    // for the cap-against-floor count. A piece without a ladder row is capped
    // by its routes alone; with no route either it has no cap (null).
    const capOf = (rows, horizon, routeCost, npcSell, hour) => {
        const caps = {};
        let chosen = null;
        for (const formula of FORMULAS) {
            const worth = Worth.rungWorth({ formula, ...rows, useHours: horizon.hours, ownHour: hour, gainBound: config.huntCycleGainBound, resale: horizon.resale });
            const capped = Bounds.cap({ worth: worth.adena ?? Number.MAX_SAFE_INTEGER, routeCost, npcSell });
            const cap = capped.cap >= Number.MAX_SAFE_INTEGER ? null : capped.cap;
            caps[formula] = cap;
            if (formula === config.worth) chosen = { cap, capBy: capped.by, bounded: worth.bounded, worth: worth.adena ?? null };
        }
        return { ...chosen, caps };
    };

    // The hunting hours of its next outing (the kit's refill, config.refill)
    // after an outing of lastOuting hunting hours.
    const nextOuting = lastOuting => refillHours({ refill: config.refill, outingHours: config.outingHours, minHours: config.refillMinHours, lastOuting });
    // The shots the next outing takes.
    const reserveOf = (main, outingHours) => {
        const hour = Engine.hourOf(view, main), row = Engine.spotRowOf(view, main);
        if (!hour?.shotId || !(row?.shots > 0)) return null;
        const id = Engine.shotOf(view, main, hour), held = main.shots[id] || 0;
        const amount = Math.max(0, Math.ceil(row.shots * nextOuting(outingHours)) - held);
        return { id, amount, held, perHour: row.shots };
    };

    // What pathAim 'affordable' reads: the money the main holds, what it
    // nets a hunting hour now (its own hour less the shots it fires), and
    // the worn pieces' resale beside the candidates'.
    function aimView(main, kit, book, uses, shotsPerHour) {
        const resale = { ...uses.resale };
        for (const aim of kit) if (aim.worn && !(aim.worn in resale)) resale[aim.worn] = resaleOf(aim.worn, book);
        return { money: main.money, earn: Math.max(0, ownHour(main, accounts[main.index].memory) - shotsPerHour), perHour: uses.perHour, useHours: uses.useHours, resale };
    }

    // path: at its situations, from the routes acquire gives in the town the
    // main stands in. Returns the main with what withdrawn orders gave back.
    function pathOf(index, main, town) {
        const kit = aimsOf(main), grade = gradeOfLevel(main.level), candidates = kit.flatMap(aim => aim.candidates);
        const book = reachBook(index, town, [...new Set(candidates.flatMap(piece => [piece.selfId, ...orderInputs(piece.selfId)]))], [grade]);
        const routes = {}, worth = {}, weapons = {}, needs = {}, perHour = {}, useHours = {}, resale = {};
        for (const piece of candidates) {
            if (piece.selfId in routes) continue;
            const priced = routesOf(index, main, town, book, piece), got = priced.acquired;
            // A Luxury route names its crystals: its account's workshop counts them as its main's own use.
            routes[piece.selfId] = got ? { route: got.route, cost: got.cost, crystals: got.route === 'exchange' ? { grade: got.grade, amount: got.amount } : null } : null;
            worth[piece.selfId] = priced.worth;
            needs[piece.selfId] = priced.need;
            perHour[piece.selfId] = priced.perHour; useHours[piece.selfId] = priced.useHours; resale[piece.selfId] = priced.resale;
            if (Engine.isWeapon(view.items[piece.selfId])) weapons[piece.selfId] = true;
        }
        const reserve = reserveOf(main, rateOf(main.band).huntShare), memory = accounts[index].memory;
        const shotPrice = reserve ? Knowledge.known(memory, reserve.id) ?? game.firstPrice[reserve.id] ?? 0 : 0;
        const reserveAdena = reserve ? reserve.amount * shotPrice : 0;
        const answer = path(main, { kit, weapons, routes, worth, reserve: reserveAdena, ahead: aheadKit(main),
            aim: config.pathAim === 'affordable' ? aimView(main, kit, book, { perHour, useHours, resale }, reserve ? reserve.perHour * shotPrice : 0) : null });
        stats.paths++;
        stats.unpriced += answer.unpriced.length;
        // Wants of pieces no longer on the path are withdrawn with their
        // WTBs; a want of a piece of a grade the main left fails (outgrown).
        // An order no twin took gives back its materials and fee; one a twin
        // took is crafting and is delivered.
        const market = marketOf(index), keep = new Set(answer.pieces.map(piece => piece.selfId)), wants = {};
        const outgrown = id => { const at = gradeOfItem(view.items[id]); return at !== 'none' && at !== grade; };
        let back = main;
        for (const [key, want] of Object.entries(market.wants)) {
            if (keep.has(Number(key)) || (want.state === 'order' && want.claimed)) { wants[key] = want; continue; }
            // A WTB want ends with its ad, counted below.
            if (want.state !== 'wtb') endWait({ parked: 'parkedWant', farm: 'farm', order: 'order', route: 'route', twin: 'twin' }[want.state], key, outgrown(Number(key)));
            if (want.state === 'order') back = refund(back, want.orderId);
        }
        const wtb = market.ads.wtb.filter(ad => keep.has(ad.item) || ad.item === reserve?.id);
        for (const ad of market.ads.wtb) if (!wtb.includes(ad)) endWait('wtb', ad.item, outgrown(ad.item));
        setMarket(index, { path: answer, needs, pathDirty: false, goalFresh: true, wants, ads: { ...market.ads, wtb } });
        placeAds(index, 0, null);
        return back;
    }
    // A wait its owner ended: withdrawn, or failed when the main left the
    // piece's grade without it (outgrown, counted per grade).
    function endWait(kind, item, outgrown) {
        if (!outgrown) { stats.waits[kind].withdrawn++; return; }
        stats.waits[kind].failed++; stats.waits[kind].outgrown++;
        const grade = gradeOfItem(view.items[item]);
        stats.outgrown[grade] = (stats.outgrown[grade] || 0) + 1;
    }
    // An order withdrawn before a twin took it: its materials and fee go back to the main.
    function refund(main, orderId) {
        const order = orders.get(orderId);
        if (!order) return main;
        orders.delete(orderId);
        const bag = { ...main.bag };
        for (const [id, count] of Object.entries(order.materials)) bag[id] = (bag[id] || 0) + count;
        stats.orders.withdrawn++;
        return { ...main, money: main.money + order.fee, bag };
    }

    // The ads book after a main's ads changed; a new WTS raises offer_posted
    // for the mains that want its item, a new WTB raises bid_posted for the
    // mains that hold a WTS of its item at or under its price.
    function placeAds(index, now, before) {
        const market = marketOf(index);
        Books.place(ads, index, ADS, [...market.ads.wts, ...market.ads.wtb], []);
        if (!before) return;
        const known = new Set([...before.wts, ...before.wtb].map(ad => ad.id));
        for (const ad of market.ads.wts) {
            if (known.has(ad.id)) continue;
            capFloorSeen(ad);
            offerPosted(ad.item, null, ad.price, index, now);
        }
        for (const ad of market.ads.wtb) {
            if (known.has(ad.id)) continue;
            for (const entry of Books.rowsOf(ads, ADS, 'sell', ad.item)) {
                if (entry.owner === index || !(entry.floor <= ad.price)) continue;
                setMarket(entry.owner, { deal: { gain: (ad.price - entry.floor) * Math.min(ad.qty, entry.qty), item: ad.item } });
                stats.events.bidPosted++;
                ctx.rearrive(entry.owner, now, 'bid_posted');
            }
        }
    }
    // A piece offered: is there a buyer in reach (an open WTB) whose cap,
    // under each worth formula, reaches the seller's floor?
    function capFloorSeen(ad) {
        const grade = ad.grade || gradeOfItem(view.items[ad.item]), row = stats.capFloor[grade] ||= { offered: 0, gear_gain: 0, hunt_cycle: 0 };
        row.offered++;
        const bids = Books.rowsOf(ads, ADS, 'buy', ad.item);
        for (const formula of FORMULAS) if (bids.some(entry => entry.caps && entry.caps[formula] >= ad.floor)) row[formula]++;
    }
    // A line of an item entered reach (a twin's line in town, or an ad when
    // town is null): offer_posted for the mains that want it, at the gain
    // over the price at their cap.
    function offerPosted(item, town, price, owner, now) {
        for (const index of wantsByItem.get(item) || []) {
            if (index === owner || mains[index].station) continue;
            if (town !== null && townOf(mains[index]) !== town) continue;
            const market = marketOf(index), want = market.wants[item], cap = want?.cap ?? (item === market.shotId ? market.shotCap : null);
            if (!(cap >= price)) continue;
            const units = want ? 1 : Math.max(1, market.shotNeed || 0);
            if (want?.state === 'parked') {
                const wants = { ...market.wants };
                delete wants[item];
                setMarket(index, { wants });
                stats.waits.parkedWant.done++;
            } else if (item === market.shotId && market.shotWait === 'parked') {
                setMarket(index, { shotWait: null });
                stats.waits.parkedShots.done++;
            }
            setMarket(index, { deal: { gain: (cap - price) * units, item } });
            stats.events.offerPosted++;
            ctx.rearrive(index, now, 'offer_posted');
        }
    }
    const indexWants = index => {
        const market = marketOf(index), items = new Set();
        for (const [key, want] of Object.entries(market.wants)) if (want.state === 'parked' || want.state === 'wtb') items.add(Number(key));
        if (market.shotWait === 'wtb' || market.shotWait === 'parked') items.add(market.shotId);
        for (const item of market.indexed || []) if (!items.has(item)) wantsByItem.get(item)?.delete(index);
        for (const item of items) { if (!wantsByItem.has(item)) wantsByItem.set(item, new Set()); wantsByItem.get(item).add(index); }
        setMarket(index, { indexed: [...items] });
    };

    // A meeting: a claim on a hunting main's ad, met at once (no travel in
    // the model). The other main hunts to now, then pays or is paid. A WTB
    // whose owner cannot pay fails here: no deal, its WTB is withdrawn and
    // the failed meeting counted (C4 holds no money for a WTB). Returns the
    // adena moved, null when it failed.
    function meet(claim, buyer, now) {
        const other = claim.owner, item = view.items[claim.item], adena = claim.units * claim.price;
        const shot = item?.kind === 'Other.Shot';
        if (claim.kind === 'sell_wtb' && buyer !== other && mains[other].money < adena) {
            const market = marketOf(other), ad = market.ads.wtb.find(row => row.id === claim.id);
            const patch = { ads: { ...market.ads, wtb: market.ads.wtb.filter(row => row.id !== claim.id) } };
            if (ad) {
                stats.waits.wtb.failed++;
                if (ad.item === market.shotId) patch.shotWait = null;
                else if (market.wants[ad.item]?.state === 'wtb') { const wants = { ...market.wants }; delete wants[ad.item]; patch.wants = wants; }
            }
            setMarket(other, patch);
            placeAds(other, now, null);
            indexWants(other);
            stats.unfunded.wtb++;
            return null;
        }
        ctx.commit(other, now, main => {
            if (buyer === other) return main;
            if (claim.kind === 'sell_wtb') {
                const bag = shot ? main.bag : { ...main.bag, [claim.item]: (main.bag[claim.item] || 0) + claim.units };
                const shots = shot ? { ...main.shots, [claim.item]: (main.shots[claim.item] || 0) + claim.units } : main.shots;
                return { ...main, money: main.money - adena, bag, shots };
            }
            const bag = { ...main.bag, [claim.item]: main.bag[claim.item] - claim.units };
            if (!bag[claim.item]) delete bag[claim.item];
            return { ...main, money: main.money + adena, bag };
        }, 'deal_met');
        const market = marketOf(other), side = claim.kind === 'sell_wtb' ? 'wtb' : 'wts';
        const adsNow = market.ads[side].map(ad => (ad.id === claim.id ? { ...ad, qty: ad.qty - claim.units } : ad)).filter(ad => ad.qty > 0);
        const closed = adsNow.length < market.ads[side].length;
        if (closed) stats.waits[side].done++;
        const patch = { ads: { ...market.ads, [side]: adsNow } };
        if (claim.kind === 'sell_wtb') {
            if (shot) { if (market.shotWait) patch.shotWait = null; } else {
                patch.incoming = { ...market.incoming, [claim.item]: 'buy' };
                stats.obtained(gradeOfItem(item), 'buy');
                if (market.wants[claim.item]) { const wants = { ...market.wants }; delete wants[claim.item]; patch.wants = wants; }
            }
        }
        setMarket(other, patch);
        put(other, { memory: Knowledge.remember(accounts[other].memory, { item: claim.item, price: claim.price }) });
        put(buyer, { memory: Knowledge.remember(accounts[buyer].memory, { item: claim.item, price: claim.price }) });
        placeAds(other, now, null);
        indexWants(other);
        stats.meetings++;
        stats.botToBot += adena;
        return adena;
    }

    // The visit: the rule decides, the engine and the plane commit.
    function visitMain(main0, now, { outingHours }) {
        let main = main0;
        const index = main.index, account = accounts[index], nearest = townOf(main);
        const flows = { huntCold: 0, npcSales: 0, fixedBuyers: 0, npcBuys: 0, fixedSellers: 0, fares: 0, warehouseFees: 0 };
        const delta = { flows, towns: [], gearToNpc: 0, gearBought: 0, shotsBoughtFixed: 0, shotsBoughtNpc: 0, shotsSoldNpc: 0, unsold: 0, missingPieces: 0, missingShots: 0, noTown: 0 };
        if (!nearest) { delta.noTown = 1; return { main, delta }; }
        // The town trip chose: another town costs the gatekeeper fare there
        // and back (from the nearest), paid as it leaves; short of it, the nearest.
        const chosen = account.market.tripTown, hop = chosen && chosen !== nearest ? fareOf(nearest, chosen) : null;
        const town = hop !== null && main.money >= 2 * hop ? chosen : nearest;
        if (town !== nearest) { main = { ...main, money: main.money - 2 * hop }; flows.fares -= 2 * hop; }
        delta.towns.push(town);
        put(index, { lastTown: town });
        const cause = account.market.tripReason || 'start', refusedTowns = account.market.tripRefused || [];
        stats.trips[cause] = (stats.trips[cause] || 0) + 1;
        const visits = stats.visits, band = visits.byBand[main.band] ||= {};
        band[cause] = (band[cause] || 0) + 1;
        if (town !== nearest) visits.hub[cause] = (visits.hub[cause] || 0) + 1;
        if (account.market.pathDirty || !account.market.path) main = pathOf(index, main, town);
        setMarket(index, { visits: (marketOf(index).visits || 0) + 1 });
        const market = marketOf(index), twin = accounts[index].twin;
        const reserve = reserveOf(main, outingHours);
        const pieces = {}, ids = new Set(Object.keys(main.bag).map(Number));
        for (const row of market.path.order) if (row.kind === 'piece') { ids.add(row.selfId); for (const id of orderInputs(row.selfId)) ids.add(id); }
        if (reserve) ids.add(reserve.id);
        for (const id of Object.values(game.crystalIds)) ids.add(id);
        const grade = gradeOfLevel(main.level);
        const gearGrades = new Set([...Object.keys(main.bag).map(id => gradeOfItem(view.items[id])), grade]);
        const book = reachBook(index, town, ids, [...gearGrades]);
        // Its visits per wall hour so far, and its hunting share: the visits left before a piece stops being used.
        const visitRate = (marketOf(index).visits || 0) / Math.max(1, now), share = rateOf(main.band).huntShare || 1;
        for (const row of market.path.order) {
            if (row.kind !== 'piece' || main.kit[row.slot] === row.selfId || pieces[row.selfId]) continue;
            const priced = routesOf(index, main, town, book, row);
            if (priced.bounded) stats.worthBounded++;
            const routes = priced.acquired ? priced.acquired.routes : [];
            // No seller in the towns it knows: no line or ad in reach, none in its twin's town or a town book it keeps, no NPC, Luxury or own twin.
            const noSeller = !book.sell[row.selfId]?.length && book.seen[row.selfId] === undefined && !Object.values(account.townBooks || {}).some(known => known?.sell?.[row.selfId])
                && !routes.some(option => option.route === 'npc' || option.route === 'exchange' || option.route === 'twin');
            pieces[row.selfId] = { selfId: row.selfId, slot: row.slot, grade: gradeOfItem(view.items[row.selfId]), weapon: Engine.isWeapon(view.items[row.selfId]),
                cap: priced.cap, capBy: priced.capBy, caps: priced.caps, routes, own: twin?.stock[row.selfId] || 0,
                visitsLeft: priced.useHours / share * visitRate, noSeller };
        }
        const memory = account.memory, known = {};
        for (const deal of memory) known[deal.item] = deal.price;
        const firing = reserve?.id ?? 0;
        const shotCap = reserve ? Bounds.cap({ worth: shotWorth(main), npcSell: game.npcByTown[town]?.[reserve.id] ?? null }) : null;
        const escrow = twin ? twin.lines.filter(line => line.side === 'buy').reduce((sum, line) => sum + line.qty * line.price, 0) + twin.bids.reduce((sum, bid) => sum + bid.qty * bid.price, 0) : 0;
        const before = market.ads, deposit = twin ? Workshop.depositFor(main.bag, twin, game, twin.decided, config.keepRule) : {};
        // The dearest buy line it knows in another town for its stock, with
        // the units it takes (stockSale 'accumulate').
        const stash = account.stash || {}, knownBids = {};
        if (config.stockSale === 'accumulate') {
            const stockIds = [...new Set([...Object.keys(main.bag), ...Object.keys(stash)].map(Number))].filter(id => isStock(view.items[id]));
            const elsewhere = new Set([...Object.keys(account.townBooks || {}), twin?.town].filter(other => other && other !== town));
            for (const other of elsewhere) {
                const book = knownBook(index, other, stockIds);
                for (const id of stockIds) if (book?.buy?.[id] && book.buy[id].price > (knownBids[id]?.price || 0)) knownBids[id] = book.buy[id];
            }
        }
        // Its expected visits left in its grade: the hours to the next grade at its own visits per hour so far.
        const toGrade = ctx.hoursToGrade(main), visitsLeft = toGrade > 0 ? toGrade * marketOf(index).visits / Math.max(1, now) : Infinity;
        const out = visit({ index, money: main.money, bag: main.bag, shots: main.shots, kit: main.kit, weapon: main.weapon, ads: market.ads, wants: market.wants,
            incoming: market.incoming, shotWait: market.shotWait }, {
            now, town, adId: `${seed}:${index}:${main.counter}`, persona: account.persona, roll: hash(`${seed}:visit:${index}:${main.counter}`), items: game.items,
            crystalIds: game.crystalIds, book, npcSell: game.npcByTown[town] || {}, known, firstPrice: game.firstPrice,
            deposit, depositFee, twin: twin ? { wallet: twin.wallet, escrow, inputs: twin.inputMoney || 0, workshopMoney: config.workshopMoney } : null, firing,
            keepRule: config.keepRule, stockSale: config.stockSale, stash, stashLooks: account.stashLooks || {}, knownBids, ahead: market.path.ahead || [], surplus: twin ? Object.fromEntries(Object.entries(twin.surplus || {}).map(([id, count]) => [id, Math.min(count, twin.stock[id] || 0)])) : {},
            reserve: reserve && reserve.amount > 0 ? { id: reserve.id, amount: reserve.amount, cap: shotCap.cap, capBy: shotCap.by, own: twin?.stock[reserve.id] || 0 } : null,
            pieces, order: market.path.order, fares: view.fares[town] || {}, waitVisits: config.waitVisits, feeStep: config.orderFeeStepPerMp,
            ladder: { mode: config.buyerLadder, visitsLeft }, buyerNoSeller: config.buyerNoSeller,
            ownCrystals: twin ? Object.fromEntries(Object.values(game.crystalIds).filter(id => twin.stock[id] > 0).map(id => [id, twin.stock[id]])) : {} });
        ctx.commitVisit(index, now, out, deposit);
        put(index, { stash: out.stash, stashLooks: out.stashLooks });
        // Stock sold to lines here (a hub: a town other than the nearest) and to the NPC, kept in the warehouse.
        const sales = stats.stock;
        for (const stop of out.stops) for (const { selfId: id, count } of stop.items) {
            if (stop.kind === 'npc_sell' && isStock(view.items[id])) sales.npc += Math.round(count * (view.items[id]?.npcBuy || 0));
            if (stop.kind === 'warehouse' && stop.target === 'stash') sales.stashed += count;
        }
        // Sales are paid at their meeting; a sale whose buyer cannot pay gives its units back.
        let money = out.main.money, bag = out.main.bag;
        for (const claim of out.claims) {
            const paid = claim.kind === 'sell_wtb' || claim.kind === 'buy_wts' ? meet(claim, index, now) : ctx.claimOnTwin(index, claim, now);
            if (claim.adena === undefined) continue;
            if (paid === null) bag = { ...bag, [claim.item]: (bag[claim.item] || 0) + claim.units }; else money += claim.adena;
            if (paid !== null && (claim.kind === 'sell_line' || claim.kind === 'sell_wtb') && isStock(view.items[claim.item])) sales[town === nearest ? 'nearLines' : 'hubLines'] += claim.adena;
        }
        let back = { ...main, money, bag };
        for (const id of out.withdrawn) back = refund(back, id);
        money = back.money; bag = back.bag;
        for (const order of out.orders) postOrder({ ...order, buyer: index, at: now });
        const stalled = { ...marketOf(index).stalled };
        for (const row of out.stalled) stalled[row.selfId] = [...(stalled[row.selfId] || []), row.route];
        const wants = { ...out.main.wants };
        for (const [key, want] of Object.entries(wants)) if (want.state === 'parked') wants[key] = { ...want, cap: pieces[key]?.cap ?? want.cap };
        // Did it see a line of its shot at or under the shot's worth (the gate count)?
        const lineSeen = reserve ? { grade: ctx.shotGrade(reserve.id), seen: (book.sell[reserve.id] || []).some(entry => entry.price <= shotCap.cap) || (twin?.stock[reserve.id] || 0) > 0 } : marketOf(index).lineSeen;
        setMarket(index, { lineSeen, ads: out.main.ads, wants, incoming: out.main.incoming, shotWait: out.main.shotWait, shotId: reserve?.id ?? null, shotCap: shotCap?.cap ?? null,
            shotNeed: reserve?.amount || 0, stalled, pathDirty: out.gearChanged || out.stalled.length > 0, goalFresh: false, tripReason: null, tripTown: null, tripRefused: [] });
        for (const row of out.obtained) stats.obtained(row.grade, row.route);
        for (const wait of out.waits) {
            const kind = stats.waits[wait.wait] || (stats.waits[wait.wait] = ctx.wait());
            kind[wait.end === 'opened' ? 'opened' : wait.end]++;
        }
        for (const [field, adena] of Object.entries(out.flows)) flows[field] = (flows[field] || 0) + adena;
        delta.gearBought += out.obtained.filter(row => row.route === 'npc').length;
        // The first hour a main wears a weapon of its grade.
        if (out.main.weapon !== main.weapon && gradeOfItem(view.items[out.main.weapon]) === grade) {
            const worn = stats.gradeWeapon[grade] ||= { middle: 0, middleArmed: 0, end: 0, endArmed: 0, first: null };
            if (worn.first === null) worn.first = now;
        }
        for (const stop of out.stops) if (stop.kind === 'gatekeeper') delta.towns.push(stop.target);
        placeAds(index, now, before);
        indexWants(index);
        if (out.main.shotWait === null && reserve && reserve.amount > 0 && !(out.main.shots[reserve.id] > 0)) delta.missingShots++;
        if (twin) wakeAt(index, now, 'main_arrived');
        // What it saw of this town's book, for its next trips, as it stands
        // after its deals: the bids for the stock it carried, keeps or drops
        // at its spot and the asks for what it wants; a town whose trip was
        // refused for want of gain at three visits in a row is forgotten.
        const spotRow = Engine.spotRowOf(view, main), dropped = spotRow ? rowItems(main, spotRow, false).items.map(item => item.id) : [];
        const bidIds = [...new Set([...Object.keys(main.bag).map(Number), ...Object.keys(accounts[index].stash || {}).map(Number), ...dropped])].filter(id => isStock(view.items[id]));
        const seenNow = Knowledge.remembered(books.towns[town], { bids: bidIds, asks: [...new Set(wantsOf(marketOf(index)).map(want => want.id))] }, index);
        stats.counters.bookRowsDropped += seenNow.dropped;
        const kept = Knowledge.afterVisit({ books: accounts[index].townBooks, refusals: accounts[index].bookRefusals, refused: refusedTowns, visited: town, asleep: accounts[index].asleep || [] });
        stats.counters.booksForgotten += kept.forgotten.length;
        put(index, { townBooks: { ...kept.books, [town]: seenNow.book }, bookRefusals: kept.refusals, asleep: kept.asleep });
        const after = { ...main, money, bag, shots: out.main.shots, kit: out.main.kit, weapon: out.main.weapon };
        // occupationAtTown (ours): its spot is re-chosen at its arrival in town too.
        return { main: config.occupationAtTown ? occupy(after, 'arrived_town', outingHours) : after, delta };
    }

    // A buyer's order ("craft X for me") with its materials and fee left
    // with it; a raised fee adds to it. Every twin that holds the order's
    // recipe wakes.
    function postOrder(order) {
        const held = orders.get(order.id);
        if (held) orders.set(order.id, { ...held, fee: order.fee }); else { orders.set(order.id, order); stats.orders.posted++; }
        for (const account of accounts) {
            if (account.twin && Workshop.heldRecipes(account.twin, game).has(order.recipeId)) wakeAt(account.index, order.at, 'order');
        }
    }
    // A twin took an order: its materials and fee go to the twin (the fee
    // before the roll); the buyer's wait is crafting.
    function claimOrder(twinIndex, orderId) {
        const order = orders.get(orderId);
        if (!order) return null;
        orders.delete(orderId);
        stats.orders.claimed++;
        stats.orders.fees += order.fee;
        stats.botToBot += order.fee;
        const market = marketOf(order.buyer), want = market.wants[order.item];
        if (want?.orderId === orderId) setMarket(order.buyer, { wants: { ...market.wants, [order.item]: { ...want, claimed: true } } });
        return order;
    }
    // Open orders' fees and materials: held with the order, the money and goods ledgers count them.
    const orderEscrow = () => {
        let fees = 0;
        const goods = {};
        for (const order of orders.values()) { fees += order.fee; for (const [id, count] of Object.entries(order.materials)) goods[id] = (goods[id] || 0) + count; }
        return { fees, goods };
    };
    // The order's craft ended: the piece goes to the buyer, met at once, or
    // the craft failed (its materials are gone, the fee kept).
    function deliver(order, made, now) {
        // The buyer's order wait ends here unless it ended already (its path moved on).
        const market = marketOf(order.buyer), wants = { ...market.wants }, waiting = wants[order.item]?.state === 'order';
        if (waiting) delete wants[order.item];
        if (!made) {
            stats.orders.failed++;
            if (waiting) stats.waits.order.failed++;
            setMarket(order.buyer, { wants });
            return;
        }
        ctx.commit(order.buyer, now, main => ({ ...main, bag: { ...main.bag, [order.item]: (main.bag[order.item] || 0) + 1 } }), 'order_delivered');
        stats.orders.delivered++;
        if (waiting) stats.waits.order.done++;
        stats.obtained(gradeOfItem(view.items[order.item]), 'order');
        setMarket(order.buyer, { wants, incoming: { ...market.incoming, [order.item]: 'order' }, pathDirty: true });
    }
    // Its main's shortfall the account's workshop serves first (ownUseFirst):
    // the shot it fires up to what its last visit's refill took, and the
    // path pieces it does not wear, each at what the piece is worth to the
    // account (the least of the main's worth and its cheapest route other
    // than a player's line or the own twin, read at path).
    function ownNeeds(index) {
        const market = marketOf(index), main = mains[index];
        const shot = market.shotId && market.shotNeed > 0 ? { id: market.shotId, amount: market.shotNeed, worth: shotWorth(main) } : null;
        const pieces = (market.path?.pieces || []).filter(piece => main.kit[piece.slot] !== piece.selfId)
            .map(piece => ({ selfId: piece.selfId, worth: market.needs?.[piece.selfId] ?? piece.worth })).filter(piece => piece.worth > 0);
        return { shot, pieces };
    }
    const openOrders = () => [...orders.values()].map(order => ({ id: order.id, item: order.item, recipeId: order.recipeId, fee: order.fee, supplied: order.supplied || {} }));

    // Stock: what a main sells to lines and the NPC (not gear, not shots).
    const isStock = item => !!item && !Engine.isGear(item) && item.kind !== 'Other.Shot';
    // A town's book as the account knows it: live for its twin's town, as
    // its main saw it at its last visit for a town it visited, else none.
    const knownBook = (index, town, ids) => (town && town === accounts[index].twin?.town ? Knowledge.seen(books.towns[town], { buy: ids, sell: ids }, index) : accounts[index].townBooks?.[town] || null);
    // A main's open wants with their caps: its WTBs, its parked path pieces
    // and its parked shot restock.
    function wantsOf(market) {
        const wants = [];
        for (const ad of market.ads.wtb) if (ad.cap > 0) wants.push({ id: ad.item, qty: ad.qty, cap: ad.cap });
        for (const [key, want] of Object.entries(market.wants)) if (want.state === 'parked' && (want.cap ?? want.parkedCap) > 0) wants.push({ id: Number(key), qty: 1, cap: want.cap ?? want.parkedCap });
        if (market.shotWait === 'parked' && market.shotId && market.shotCap > 0) wants.push({ id: market.shotId, qty: Math.max(1, market.shotNeed || 0), cap: market.shotCap });
        return wants;
    }
    // trip's view of the towns (tripTown 'by_gain'): the stock it carries
    // (bag and kept stock with their drop rates), its open wants with their
    // caps, the nearest town's known book (with the NPC's sales there) and
    // every other town a gatekeeper reaches that it knows a book of, or
    // that is a hub (hubKnown: a hub with no remembered book at its own
    // first prices, a bet the visit's book then replaces).
    function tripTowns(index, main, nearest, items) {
        const account = accounts[index], market = account.market, stash = account.stash || {};
        const rates = new Map(items.filter(item => isStock(view.items[item.id])).map(item => [item.id, item.rate]));
        const stockIds = new Set([...Object.keys(main.bag).map(Number).filter(id => main.bag[id] > 0 && isStock(view.items[id])), ...Object.keys(stash).map(Number).filter(id => stash[id] > 0), ...rates.keys()]);
        const wants = wantsOf(market);
        // hubTowns 'by_grade': the game's trade town of the stock it carries and of what it wants.
        const hubs = !config.hubKnown ? [] : config.hubTowns !== 'by_grade' ? config.hubTowns
            : [...new Set([[...stockIds], wants.map(want => want.id)].filter(lot => lot.length).flatMap(lot => ctx.tradeTownsOf(index, lot)))];
        const asleep = new Set(account.asleep || []);
        const others = [...new Set([...Object.keys(account.townBooks || {}), account.twin?.town, ...hubs].filter(Boolean))]
            .filter(town => town !== nearest && fareOf(nearest, town) !== null && (!asleep.has(town) || town === account.twin?.town));
        if (!others.length) return { towns: [] };
        const stock = [...stockIds].map(id => ({ id, held: (main.bag[id] || 0) + (stash[id] || 0), rate: rates.get(id) || 0, npc: view.items[id]?.npcBuy || 0 }));
        const ids = [...stockIds, ...wants.map(want => want.id)];
        const askOf = book => Object.fromEntries(Object.entries(book?.sell || {}).map(([id, row]) => [id, row.price]));
        const nearBook = knownBook(index, nearest, ids), npc = game.npcByTown[nearest] || {}, nearAsks = askOf(nearBook);
        for (const want of wants) if (npc[want.id] > 0) nearAsks[want.id] = Math.min(nearAsks[want.id] ?? Infinity, npc[want.id]);
        const towns = [];
        for (const town of others) {
            const book = knownBook(index, town, ids) ?? (hubs.includes(town) ? Knowledge.estimated(account.memory, game.firstPrice, ids) : null);
            if (book) towns.push({ town, fare: fareOf(nearest, town), hours: config.hopHours, bids: book.buy || {}, asks: askOf(book) });
        }
        return { money: main.money, stock, wants, near: { bids: nearBook?.buy || {}, asks: nearAsks }, towns };
    }

    // trip: when the main comes to town, and which town, from its state
    // after each committed event; with deathArrival a death drawn earlier
    // than trip's arrival is the arrival (in the respawn town of its spot).
    function nextArrival(main, ev) {
        const index = main.index, row = Engine.spotRowOf(view, main);
        if (!row) return null;
        // The run's start is path's first situation.
        if (!accounts[index].market.path) pathOf(index, main, townOf(main));
        const account = accounts[index], market = account.market;
        const hour = Engine.hourOf(view, main), shotId = hour?.shotId ? Engine.shotOf(view, main, hour) : null;
        const at = rowItems(main, row, !holdsShots(main));
        const bagItems = Object.entries(main.bag).filter(([, count]) => count > 0);
        const worn = Object.values(main.kit).filter(Boolean);
        const gearHeld = bagItems.filter(([id]) => Engine.isGear(view.items[id])).reduce((sum, [, count]) => sum + count, 0);
        const used = worn.length + gearHeld + bagItems.filter(([id]) => !Engine.isGear(view.items[id])).length + Object.values(main.shots).filter(count => count > 0).length;
        const weight = bagItems.reduce((sum, [id, count]) => sum + count * (view.items[id]?.weight || 0), 0) + worn.reduce((sum, id) => sum + (view.items[id]?.weight || 0), 0);
        const bagRow = snapshot.bags?.[main.line];
        const reserve = reserveOf(main, rateOf(main.band).huntShare);
        const reserveAdena = reserve ? reserve.amount * (Knowledge.known(account.memory, reserve.id) ?? game.firstPrice[reserve.id] ?? 0) : 0;
        const bagValue = bagItems.reduce((sum, [id, count]) => sum + count * (view.items[id]?.npcBuy || 0), 0);
        const deal = (ev.event === 'offer_posted' || ev.event === 'bid_posted') ? market.deal : null;
        const nearest = townOf(main);
        const towns = config.tripTown === 'by_gain' ? tripTowns(index, main, nearest, at.items) : {};
        const own = ownHour(main, account.memory);
        let answer = trip(main, {
            now: ev.now, since: main.since, huntShare: ev.huntShare, tripHours: 2 * (snapshot.walkBack?.[row.spotId] || 0), town: nearest,
            stockLowHours: config.stockLowMinutes / 60, loadShare: config.loadShare,
            shots: shotId && row.shots > 0 ? { held: main.shots[shotId] || 0, perHour: row.shots, waiting: market.shotWait !== null } : null,
            bag: bagRow ? { slots: bagRow.slots, maxLoad: bagRow.maxLoad, used, weight, items: at.items.map(item => ({ ...item, held: (main.bag[item.id] || 0) > 0 })) } : null,
            goal: goalOf({ pieces: market.path?.pieces, kit: main.kit, wants: market.wants, reserve: reserveAdena, money: main.money, bagValue, perHour: at.npc, fresh: market.goalFresh }),
            event: ev.event, deal, ownHour: own, tripTown: config.tripTown, ...towns });
        if (config.deathArrival) {
            const died = deathAt({ since: main.since, huntShare: ev.huntShare, deathsPerHour: row.deaths || 0, roll: ev.roll });
            if (died !== null && died > ev.now && (answer.at === null || died < answer.at)) answer = { ...answer, at: died, reason: 'death', town: nearest, refused: [] };
        }
        if (deal) setMarket(index, { deal: null });
        if (answer.parked && !market.parked) stats.trips.shotsParked = (stats.trips.shotsParked || 0) + 1;
        const refused = answer.refused || [];
        if (answer.parked !== market.parked || answer.reason !== market.tripReason || answer.town !== market.tripTown || refused.join() !== (market.tripRefused || []).join()) {
            setMarket(index, { parked: answer.parked, tripReason: answer.reason, tripTown: answer.town, tripRefused: refused });
        }
        return answer.at;
    }

    // occupation at grade_changed and when its spot leaves its levels (the
    // spot table's range for its line there); path is re-read at grade_changed.
    function levelUp(main, now, gradeChanged) {
        const index = main.index, account = accounts[index], market = account.market;
        const range = main.occupied ? view.spotLevels?.[main.line]?.[main.occupied] : null;
        const outside = main.occupied && (!range || main.level < range[0] || main.level > range[1]);
        // Inside its range the snapshot holds the spot's row; a missing one is counted and left as the range's end.
        const missing = main.occupied && !outside && String(Engine.spotRowOf(view, main)?.spotId) !== main.occupied;
        if (missing) stats.occupation.rowMissing++;
        const left = (market.spotHeld && !main.spot && !main.occupied) || outside || missing;
        let next = main;
        if (gradeChanged) {
            const wants = {}, grade = gradeOfLevel(main.level);
            for (const [key, want] of Object.entries(market.wants)) {
                if (want.state === 'parked') endWait('parkedWant', key, gradeOfItem(view.items[key]) !== 'none' && gradeOfItem(view.items[key]) !== grade); else wants[key] = want;
            }
            setMarket(index, { pathDirty: true, wants, stalled: {} });
            // A new grade is something new about every town: the forgotten ones wake.
            put(index, { asleep: [] });
            if (market.shotWait === 'parked' || market.shotWait === 'unwanted') { if (market.shotWait === 'parked') stats.waits.parkedShots.withdrawn++; setMarket(index, { shotWait: null }); }
            indexWants(index);
        }
        const situation = gradeChanged ? 'grade_changed' : left ? 'spot_left' : null;
        if (situation) next = occupy(main, situation);
        setMarket(index, { spotHeld: !!next.spot });
        return next;
    }
    // occupation at a situation: the main with the spot it hunts. At
    // arrived_town each candidate carries its move (the fare from this town
    // to its town and the extra walk hours at the own hour) and the hunting
    // hours of its next outing there (the last outing's, at least the
    // refill's hours; never past its grade's end or the spot's last level),
    // and the spot it left at its last arrival is no candidate (counted).
    function occupy(main, situation, outingHours = 0) {
        const index = main.index, account = accounts[index], hour = Engine.hourOf(view, main), town = townOf(main), bids = {}, prices = {};
        const atTown = situation === 'arrived_town', own = atTown ? ownHour(main, account.memory) : 0, heldRow = atTown ? Engine.spotRowOf(view, main) : null;
        const gradeHours = atTown ? horizonOf(main) : 0;
        const market = account.market, left = atTown && market.lastSpot && market.visits - (market.movedAt ?? -Infinity) <= 1 ? market.lastSpot : null;
        const rowOf = row => {
            const at = rowItems(main, row, false), out = { spotId: String(row.spotId), adena: at.adena, items: at.items.map(item => [item.id, item.rate]), scrolls: row.scrolls || [] };
            if (!atTown) return out;
            const there = view.yields[`${row.spotId}@${main.level}`]?.town || null, fare = there ? fareOf(town, there) : null;
            const walk = Math.max(0, (snapshot.walkBack?.[row.spotId] || 0) - (snapshot.walkBack?.[heldRow?.spotId] || 0));
            const range = view.spotLevels?.[main.line]?.[String(row.spotId)], last = range ? Math.min(view.maxLevel, range[1] + 1) : null;
            const toEnd = last !== null && row.exp > 0 ? Math.max(0, Engine.expAt(view, last) - main.exp) / row.exp : Infinity;
            return { ...out, move: fare === null ? Infinity : fare + walk * own, stay: stayHours({ outingHours: nextOuting(outingHours), gradeHours, spotHours: toEnd }) };
        };
        const rows = (hour?.top || []).map(rowOf), others = (hour?.others || []).filter(row => row.scrolls?.length).map(rowOf);
        for (const row of [...rows, ...others]) for (const [id] of row.items) {
            prices[id] = priceOfItem(account.memory, id);
            const bid = Math.max(Books.rowsOf(books, town, 'buy', id)[0]?.price || 0, ...Books.rowsOf(ads, ADS, 'buy', id).filter(ad => ad.town === town).map(ad => ad.price));
            if (bid > 0) bids[id] = bid;
        }
        // The scrolls its own workshop decided to add, at the workshop's cap for each.
        const wants = {}, twin = account.twin;
        if (config.occupationRecipeWant && twin) for (const want of twin.wants || []) {
            const cap = want.gain * twin.regen * Math.max(1, ctx.hoursToGrade(main) || 0);
            if (cap > 0) wants[game.recipes[want.id].recipeItemId] = cap;
        }
        const roll = mulberry(hash(`${seed}:occupation:${index}:${main.counter}`))();
        const held = heldRow ? rowOf(heldRow) : null;
        const spot = occupation({ spot: main.occupied || null }, { situation, rows, others, prices, bids, wants, roll, held, left });
        if (left && spot !== left && occupation({ spot: main.occupied || null }, { situation, rows, others, prices, bids, wants, roll, held }) === left) stats.occupation.refusedBack++;
        if (spot === main.occupied) return main;
        stats.occupation[situation] = (stats.occupation[situation] || 0) + 1;
        // A move back to the spot it held before the last one (oscillation).
        if (account.market.lastSpot === spot) stats.occupation.returned++;
        setMarket(index, { lastSpot: main.occupied || null, movedAt: account.market.visits });
        if (others.some(row => row.spotId === spot)) stats.occupation.scrollSpot++;
        if (Object.keys(wants).length && spot !== occupation({ spot: main.occupied || null }, { situation, rows, others, prices, bids, wants: {}, roll, held, left })) { stats.occupation.forScroll++; stats.scrollMains.add(index); }
        // A move a bid it sees for something the new spot yields caused.
        if (Object.keys(bids).length && spot !== occupation({ spot: main.occupied || null }, { situation, rows, others, prices, bids: {}, wants, roll, held, left })) stats.occupation.forBid = (stats.occupation.forBid || 0) + 1;
        return { ...main, occupied: spot };
    }
    // The account's workshop opened or closed a recipe want: its main re-chooses its spot.
    function recipeWanted(index, now) {
        if (mains[index].station) return;
        ctx.commit(index, now, main => occupy(main, 'recipe_wanted'), 'recipe_wanted');
    }
    // How a scroll its main left reached the twin: its spot's drop or spoil
    // list; where: the spot, the NPCs there whose reward lists it (id, level,
    // drop or spoil), the main's line and class.
    function scrollRoute(index, id) {
        const main = mains[index], row = Engine.spotRowOf(view, main), yields = row ? view.yieldsDesign?.[`${row.spotId}@${main.level}`] : null;
        const drop = !!yields?.drop?.[id], spoil = !!yields?.spoil?.[id];
        const from = drop && spoil ? 'its own main\'s drop or spoil' : spoil ? 'its own main\'s spoil' : drop ? 'its own main\'s drop' : 'its own main (an earlier spot)';
        const npcs = [];
        for (const npc of row ? snapshot.compositions?.[row.spotId]?.npcs || [] : []) {
            const reward = snapshot.rewards?.[npc.rewardId], has = groups => (groups || []).some(group => (group.items || []).some(item => Number(item.selfId) === Number(id)));
            if (reward && (has(reward.rewards) || has(reward.spoils))) npcs.push(`${npc.npcId} lv${npc.level} ${has(reward.rewards) ? 'drop' : ''}${has(reward.rewards) && has(reward.spoils) ? '+' : ''}${has(reward.spoils) ? 'spoil' : ''}`);
        }
        return { from, where: { spot: row ? String(row.spotId) : null, level: main.level, line: main.line, classId: Engine.hourOf(view, main)?.classId ?? null, npcs } };
    }

    // The ads book; for a town, only the ads of mains who meet in it (an ad's town).
    const adsBook = (town = null) => {
        const all = ads.towns[ADS] || { sell: {}, buy: {}, bids: {} };
        if (town === null) return all;
        const only = side => Object.fromEntries(Object.entries(all[side] || {}).map(([id, rows]) => [id, rows.filter(row => row.town === town)]).filter(([, rows]) => rows.length));
        return { sell: only('sell'), buy: only('buy'), bids: {} };
    };
    return { visitMain, nextArrival, levelUp, recipeWanted, scrollRoute, claimOrder, deliver, openOrders, orderEscrow, offerPosted, adsBook, ownNeeds,
        start: (index, main) => setMarket(index, { spotHeld: !!main.spot }) };
}

// A main's market state at the start.
function marketStart() {
    return { ads: { wts: [], wtb: [] }, wants: {}, incoming: {}, shotWait: null, shotId: null, shotCap: null, shotNeed: 0, path: null, pathDirty: true, goalFresh: true,
        stalled: {}, deal: null, tripReason: null, tripTown: null, tripRefused: [], parked: false, indexed: [], spotHeld: false, visits: 0, lastSpot: null, movedAt: null, needs: {} };
}

module.exports = { mainsSide, marketStart, FORMULAS };
