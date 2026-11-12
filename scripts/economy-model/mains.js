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
const { path } = require('./rules/path');
const { acquire } = require('./rules/acquire');
const { trip } = require('./rules/trip');
const { visit } = require('./rules/visit');
const { occupation } = require('./rules/occupation');
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
    const lastLevel = grade => {
        const at = grades.findIndex(([name]) => name === grade);
        if (at < 0) return grades[0][1] - 1;
        return at + 1 < grades.length ? grades[at + 1][1] - 1 : view.maxLevel;
    };
    const pathKit = main => view.kits[main.line]?.[Math.min(view.maxLevel, lastLevel(gradeOfLevel(main.level)))] || [];
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
    // Hunting hours to the end of the main's grade stage.
    const horizonOf = main => {
        const next = grades.find(([, from]) => from > main.level), row = Engine.spotRowOf(view, main);
        if (!(row?.exp > 0)) return 0;
        return Math.max(0, Engine.expAt(view, Math.min(next ? next[1] : view.maxLevel, view.maxLevel)) - main.exp) / row.exp;
    };
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

    // The routes of one piece (acquire) and its cap, for a main standing in town.
    const routesOf = (index, main, town, book, piece, grade) => {
        const account = accounts[index], memory = account.memory, hour = ownHour(main, memory), selfId = piece.selfId;
        const npc = (view.offers.get(selfId) || []).filter(row => row.channel === 'npc_buy').map(row => ({ town: row.town, price: row.price, fare: fareOf(town, row.town) }))
            .filter(row => row.fare !== null);
        const recipe = orderRecipe(selfId);
        const order = recipe ? { recipeId: recipe.recipeId, fee: recipe.mpCost * config.orderFeePerMp, mp: recipe.mpCost, units: recipe.productCount * recipe.successRate / 100,
            materials: recipe.materials.map(row => {
                const farm = farmRoute(main, memory, row.selfId);
                return { selfId: row.selfId, amount: row.amount, held: main.bag[row.selfId] || 0, sale: Knowledge.known(memory, row.selfId) ?? view.items[row.selfId]?.npcBuy ?? 0,
                    line: book.sell[row.selfId]?.[0]?.price ?? null, npc: game.npcByTown[town]?.[row.selfId] ?? null, farmHours: farm?.hours || 0, spotHour: farm?.spotHour || 0 };
            }) } : null;
        const lux = snapshot.luxuryOptions?.[selfId];
        const exchange = lux && fareOf(town, lux.town) !== null ? { town: lux.town, fare: fareOf(town, lux.town),
            options: [['c', lux.c], ['d', lux.d]].filter(([, amount]) => amount > 0).map(([g, amount]) => ({ grade: g, amount, price: priceToMain(memory, book, game.crystalIds[g.toUpperCase()]) })) } : null;
        const own = { cap: Infinity, ownHour: hour, hourCost: config.hourCost, lines: [], npc, order, farm: farmRoute(main, memory, selfId), exchange, stalled: account.market.stalled[selfId] || [] };
        const routes = acquire(piece, own);
        stats.routes.priced++;
        if (routes?.routeCost === 0) stats.routes.zero++;
        const capped = capOf(main, memory, selfId, grade, routes?.routeCost ?? null, game.npcByTown[town]?.[selfId] ?? null, hour);
        const lines = (book.sell[selfId] || []).map(entry => ({ price: entry.price, kind: entry.kind, where: entry.kind === 'ad' ? 'ad' : entry.town }));
        return { ...capped, acquired: lines.length ? acquire(piece, { ...own, cap: capped.cap, lines }) : routes };
    };
    // A piece's cap: min(worth, own route, the NPC here); both formulas' caps
    // for the cap-against-floor count. A piece no path row names is capped by
    // its routes alone.
    const capOf = (main, memory, selfId, grade, routeCost, npcSell, hour) => {
        const row = snapshot.pieceWorth?.[main.line]?.[grade]?.pieces?.[selfId] || null, horizon = horizonOf(main), caps = {};
        let chosen = null;
        for (const formula of FORMULAS) {
            const worth = Worth.pieceWorth({ formula, row, horizonHours: horizon, ownHour: hour, gainBound: config.huntCycleGainBound });
            const capped = Bounds.cap({ worth: worth.adena ?? Number.MAX_SAFE_INTEGER, routeCost, npcSell });
            caps[formula] = capped.cap;
            if (formula === config.worth) chosen = { cap: capped.cap, capBy: capped.by, bounded: worth.bounded, worth: worth.adena ?? null };
        }
        return { ...chosen, caps };
    };

    // The shots the next outing takes: its hours, never under one (ours).
    const reserveOf = (main, outingHours) => {
        const hour = Engine.hourOf(view, main), row = Engine.spotRowOf(view, main);
        if (!hour?.shotId || !(row?.shots > 0)) return null;
        const id = Engine.shotOf(view, main, hour), held = main.shots[id] || 0;
        const amount = Math.max(0, Math.ceil(row.shots * Math.max(config.refillMinHours, outingHours || 0)) - held);
        return { id, amount, held, perHour: row.shots };
    };

    // path: at its situations, from the routes acquire gives in the town the
    // main stands in. Returns the main with what withdrawn orders gave back.
    function pathOf(index, main, town) {
        const kit = pathKit(main), grade = gradeOfLevel(main.level);
        const book = reachBook(index, town, [...new Set(kit.map(piece => piece.selfId))], []);
        const routes = {}, worth = {}, weapons = {};
        for (const piece of kit) {
            if (main.kit[piece.slot] === piece.selfId || piece.selfId in routes) continue;
            const priced = routesOf(index, main, town, book, piece, gradeOfItem(view.items[piece.selfId]) === 'none' ? grade : gradeOfItem(view.items[piece.selfId]));
            routes[piece.selfId] = priced.acquired ? { route: priced.acquired.route, cost: priced.acquired.cost } : null;
            worth[piece.selfId] = priced.worth;
            if (Engine.isWeapon(view.items[piece.selfId])) weapons[piece.selfId] = true;
        }
        const reserve = reserveOf(main, rateOf(main.band).huntShare);
        const reserveAdena = reserve ? reserve.amount * (Knowledge.known(accounts[index].memory, reserve.id) ?? game.firstPrice[reserve.id] ?? 0) : 0;
        const answer = path(main, { kit, weapons, routes, worth, reserve: reserveAdena });
        stats.paths++;
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
            if (want.state !== 'wtb') endWait({ parked: 'parkedWant', farm: 'farm', order: 'order', route: 'route' }[want.state], key, outgrown(Number(key)));
            if (want.state === 'order') back = refund(back, want.orderId);
        }
        const wtb = market.ads.wtb.filter(ad => keep.has(ad.item) || ad.item === reserve?.id);
        for (const ad of market.ads.wtb) if (!wtb.includes(ad)) endWait('wtb', ad.item, outgrown(ad.item));
        setMarket(index, { path: answer, pathDirty: false, goalFresh: true, wants, ads: { ...market.ads, wtb } });
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
        const index = main.index, account = accounts[index], town = townOf(main);
        const flows = { huntCold: 0, npcSales: 0, fixedBuyers: 0, npcBuys: 0, fixedSellers: 0, fares: 0, warehouseFees: 0 };
        const delta = { flows, towns: [], gearToNpc: 0, gearBought: 0, shotsBoughtFixed: 0, shotsBoughtNpc: 0, shotsSoldNpc: 0, unsold: 0, missingPieces: 0, missingShots: 0, noTown: 0 };
        if (!town) { delta.noTown = 1; return { main, delta }; }
        delta.towns.push(town);
        put(index, { lastTown: town });
        stats.trips[account.market.tripReason || 'start'] = (stats.trips[account.market.tripReason || 'start'] || 0) + 1;
        if (account.market.pathDirty || !account.market.path) main = pathOf(index, main, town);
        setMarket(index, { visits: (marketOf(index).visits || 0) + 1 });
        const market = marketOf(index), twin = accounts[index].twin;
        const reserve = reserveOf(main, outingHours);
        const pieces = {}, ids = new Set(Object.keys(main.bag).map(Number));
        for (const row of market.path.order) if (row.kind === 'piece') ids.add(row.selfId);
        if (reserve) ids.add(reserve.id);
        for (const id of Object.values(game.crystalIds)) ids.add(id);
        const gearGrades = new Set(Object.keys(main.bag).map(id => gradeOfItem(view.items[id])));
        const book = reachBook(index, town, ids, [...gearGrades]);
        const grade = gradeOfLevel(main.level);
        for (const row of market.path.order) {
            if (row.kind !== 'piece' || main.kit[row.slot] === row.selfId || pieces[row.selfId]) continue;
            const pieceGrade = gradeOfItem(view.items[row.selfId]) === 'none' ? grade : gradeOfItem(view.items[row.selfId]);
            const priced = routesOf(index, main, town, book, row, pieceGrade);
            if (priced.bounded) stats.worthBounded++;
            pieces[row.selfId] = { selfId: row.selfId, slot: row.slot, grade: gradeOfItem(view.items[row.selfId]), weapon: Engine.isWeapon(view.items[row.selfId]),
                cap: priced.cap, capBy: priced.capBy, caps: priced.caps, routes: priced.acquired ? priced.acquired.routes : [], own: twin?.stock[row.selfId] || 0 };
        }
        const memory = account.memory, known = {};
        for (const deal of memory) known[deal.item] = deal.price;
        const firing = reserve?.id ?? 0;
        const shotCap = reserve ? Bounds.cap({ worth: shotWorth(main), npcSell: game.npcByTown[town]?.[reserve.id] ?? null }) : null;
        const escrow = twin ? twin.lines.filter(line => line.side === 'buy').reduce((sum, line) => sum + line.qty * line.price, 0) + twin.bids.reduce((sum, bid) => sum + bid.qty * bid.price, 0) : 0;
        const before = market.ads, deposit = twin ? Workshop.depositFor(main.bag, twin, game, twin.decided) : {};
        // Its expected visits left in its grade: the hours to the next grade at its own visits per hour so far.
        const toGrade = ctx.hoursToGrade(main), visitsLeft = toGrade > 0 ? toGrade * marketOf(index).visits / Math.max(1, now) : Infinity;
        const out = visit({ index, money: main.money, bag: main.bag, shots: main.shots, kit: main.kit, weapon: main.weapon, ads: market.ads, wants: market.wants,
            incoming: market.incoming, shotWait: market.shotWait }, {
            now, town, adId: `${seed}:${index}:${main.counter}`, persona: account.persona, roll: hash(`${seed}:visit:${index}:${main.counter}`), items: view.items,
            crystalIds: game.crystalIds, book, npcSell: game.npcByTown[town] || {}, known, firstPrice: game.firstPrice,
            deposit, depositFee, twin: twin ? { wallet: twin.wallet, escrow } : null, firing,
            reserve: reserve && reserve.amount > 0 ? { id: reserve.id, amount: reserve.amount, cap: shotCap.cap, capBy: shotCap.by, own: twin?.stock[reserve.id] || 0 } : null,
            pieces, order: market.path.order, fares: view.fares[town] || {}, waitVisits: config.waitVisits, feeStep: config.orderFeeStepPerMp,
            ladder: { mode: config.buyerLadder, visitsLeft } });
        ctx.commitVisit(index, now, out, deposit);
        // Sales are paid at their meeting; a sale whose buyer cannot pay gives its units back.
        let money = out.main.money, bag = out.main.bag;
        for (const claim of out.claims) {
            const paid = claim.kind === 'sell_wtb' || claim.kind === 'buy_wts' ? meet(claim, index, now) : ctx.claimOnTwin(index, claim, now);
            if (claim.adena === undefined) continue;
            if (paid === null) bag = { ...bag, [claim.item]: (bag[claim.item] || 0) + claim.units }; else money += claim.adena;
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
            shotNeed: reserve?.amount || 0, stalled, pathDirty: out.gearChanged || out.stalled.length > 0, goalFresh: false, tripReason: null });
        for (const row of out.obtained) stats.obtained(row.grade, row.route);
        for (const wait of out.waits) {
            const kind = stats.waits[wait.wait] || (stats.waits[wait.wait] = ctx.wait());
            kind[wait.end === 'opened' ? 'opened' : wait.end]++;
        }
        for (const [field, adena] of Object.entries(out.flows)) flows[field] = (flows[field] || 0) + adena;
        delta.gearBought += out.obtained.filter(row => row.route === 'npc').length;
        for (const stop of out.stops) if (stop.kind === 'gatekeeper') delta.towns.push(stop.target);
        placeAds(index, now, before);
        indexWants(index);
        if (out.main.shotWait === null && reserve && reserve.amount > 0 && !(out.main.shots[reserve.id] > 0)) delta.missingShots++;
        if (twin) wakeAt(index, now, 'main_arrived');
        return { main: { ...main, money, bag, shots: out.main.shots, kit: out.main.kit, weapon: out.main.weapon }, delta };
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
    const openOrders = () => [...orders.values()].map(order => ({ id: order.id, item: order.item, recipeId: order.recipeId, fee: order.fee }));

    // trip: when the main comes to town, from its state after each committed event.
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
        const next = market.path?.pieces.find(piece => main.kit[piece.slot] !== piece.selfId && !market.wants[piece.selfId]);
        const reserve = reserveOf(main, rateOf(main.band).huntShare);
        const reserveAdena = reserve ? reserve.amount * (Knowledge.known(account.memory, reserve.id) ?? game.firstPrice[reserve.id] ?? 0) : 0;
        const bagValue = bagItems.reduce((sum, [id, count]) => sum + count * (view.items[id]?.npcBuy || 0), 0);
        const deal = (ev.event === 'offer_posted' || ev.event === 'bid_posted') ? market.deal : null;
        const answer = trip(main, {
            now: ev.now, since: main.since, huntShare: ev.huntShare, tripHours: 2 * (snapshot.walkBack?.[row.spotId] || 0), town: townOf(main),
            stockLowHours: config.stockLowMinutes / 60, loadShare: config.loadShare,
            shots: shotId && row.shots > 0 ? { held: main.shots[shotId] || 0, perHour: row.shots, waiting: market.shotWait !== null } : null,
            bag: bagRow ? { slots: bagRow.slots, maxLoad: bagRow.maxLoad, used, weight, items: at.items.map(item => ({ ...item, held: (main.bag[item.id] || 0) > 0 })) } : null,
            goal: next ? { need: next.cost + reserveAdena, have: main.money + bagValue, perHour: at.npc, fresh: market.goalFresh } : null,
            event: ev.event, deal, ownHour: ownHour(main, account.memory) });
        if (deal) setMarket(index, { deal: null });
        if (answer.parked && !market.parked) stats.trips.shotsParked = (stats.trips.shotsParked || 0) + 1;
        if (answer.parked !== market.parked || answer.reason !== market.tripReason) setMarket(index, { parked: answer.parked, tripReason: answer.reason });
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
            if (market.shotWait === 'parked' || market.shotWait === 'unwanted') { if (market.shotWait === 'parked') stats.waits.parkedShots.withdrawn++; setMarket(index, { shotWait: null }); }
            indexWants(index);
        }
        const situation = gradeChanged ? 'grade_changed' : left ? 'spot_left' : null;
        if (situation) next = occupy(main, situation);
        setMarket(index, { spotHeld: !!next.spot });
        return next;
    }
    // occupation at a situation: the main with the spot it hunts.
    function occupy(main, situation) {
        const index = main.index, account = accounts[index], hour = Engine.hourOf(view, main), town = townOf(main), bids = {}, prices = {};
        const rowOf = row => { const at = rowItems(main, row, false); return { spotId: String(row.spotId), adena: at.adena, items: at.items.map(item => [item.id, item.rate]), scrolls: row.scrolls || [] }; };
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
        const spot = occupation({ spot: main.occupied || null }, { situation, rows, others, prices, bids, wants, roll });
        if (spot === main.occupied) return main;
        stats.occupation[situation] = (stats.occupation[situation] || 0) + 1;
        if (others.some(row => row.spotId === spot)) stats.occupation.scrollSpot++;
        if (Object.keys(wants).length && spot !== occupation({ spot: main.occupied || null }, { situation, rows, others, prices, bids, wants: {}, roll })) { stats.occupation.forScroll++; stats.scrollMains.add(index); }
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
    return { visitMain, nextArrival, levelUp, recipeWanted, scrollRoute, claimOrder, deliver, openOrders, orderEscrow, offerPosted, adsBook,
        start: (index, main) => setMarket(index, { spotHeld: !!main.spot }) };
}

// A main's market state at the start.
function marketStart() {
    return { ads: { wts: [], wtb: [] }, wants: {}, incoming: {}, shotWait: null, shotId: null, shotCap: null, shotNeed: 0, path: null, pathDirty: true, goalFresh: true,
        stalled: {}, deal: null, tripReason: null, parked: false, indexed: [], spotHeld: false, visits: 0 };
}

module.exports = { mainsSide, marketStart, FORMULAS };
