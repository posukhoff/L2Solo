'use strict';

// visit (economy design, character plane): in town, what the main sells,
// buys, restocks and orders. It reads every line of the books it reaches
// (its town's book, its twin's town's, the ads: the chat it hears), first
// come; a want with no line becomes a WTB, or its route names another town.
// Gear: a standing WTB it can reach, else its own WTS (an ad met by a
// meeting), which at its floor goes to the NPC or a crystallizer's bid.
// Stock: a crafter's buy line (any amount) or a WTB, else the NPC. Then the
// money queue: the refill reserve and path's pieces in path order, each
// from a line at or under its cap, else its WTB, which after two looks at
// its cap takes the cap's own route or is parked; its own twin's craft and a
// piece used for fewer than two more visits take the route at once. A
// parked want opens again when its cap rises above the cap it was parked
// at, or when its money first reaches the piece's route. An order at a workshop is
// placed from its own materials: it buys or gathers what it lacks, then
// leaves the materials and the fee with the order. Situations:
// arrived_town, goal_done:visit, goal_failed:visit. Pure: the main and the
// books it reaches arrive as plain data (no other account's money: a sale
// to a buy line, a WTB or a bid is paid at the meeting, which fails when its
// buyer cannot pay); it returns the new main, the claims the engine commits
// in order (a claim on a twin's line, a crystallizer's bid or a hunting
// main's ad, met at once: no travel in the model) and its stops in the
// shape { kind, target, items }.
const { priceStep, PRICE_STEP } = require('./priceStep');
const Bounds = require('./bounds');
const { pool } = require('./workshop');
const { hash, mulberry } = require('../../hunt-tables/common');

const isGear = item => /^(Weapon|Armor)/.test(item?.kind || '');
// Paperdoll slots: one-handed and two-handed weapons, the shield.
const WEAPON_SLOTS = Object.freeze([7, 14]), TWO_HANDED = 14, SHIELD = 8;
const isShot = item => item?.kind === 'Other.Shot';

// The best crystallizer bid per crystal of a grade it reaches (its own
// twin's included).
const bestBid = (book, grade) => (book.bids?.[grade] || []).filter(entry => entry.qty > 0).reduce((best, entry) => (!best || entry.price > best.price ? entry : best), null);

// main: { index, money, bag, shots, kit, weapon, ads: { wts, wtb }, wants:
// { selfId: { state: 'wtb' | 'route' | 'parked' | 'farm' | 'order' | 'twin',
// tries, seen, order (an order route's recipe, fee and materials), orderId,
// claimed (a twin took the order), parkedCap and short (a parked want's cap
// and whether its money fell short of the route when it was parked) } },
// incoming: { selfId: route } (pieces that reached its bag by a route already
// counted), shotWait }. view: { now, town, adId, persona, roll, items,
// crystalIds, book: { sell: { item: [entry] } cheapest first, buy: { item:
// [entry] } dearest first, bids: { grade: [entry] } } (entry { owner, id,
// price, qty, kind: 'line' | 'ad', own }: lines of the town it stands in
// and the ads),
// npcSell: { item: price } in town, known: { item: price }, firstPrice,
// deposit: { item: count }, depositFee, twin: { wallet, escrow, inputs (the
// adena its workshop's next batches take), workshopMoney } | null, keepRule,
// ahead: [{ selfId, slot }] (its next grade's kit, one a slot), surplus:
// { item: count } (its twin's warehouse stock the workshop no longer uses),
// firing (the shot it fires), reserve: { id, amount, cap, capBy, own } |
// null, pieces: { selfId: { selfId, slot, grade, weapon, cap (null: nothing
// caps it, no want is posted), capBy, caps, routes, own (units its own twin
// holds), visitsLeft (its expected visits before it stops using the piece) } },
// order: path's money queue, fares: { town: fare },
// waitVisits (an order or a farm wait still unmet at the visit after this
// many fails, and its route is stalled for the piece: ours), feeStep
// (adena an MP of its recipe an unclaimed order's fee rises at each of its
// owner's visits: ours), ladder: { mode: 'looks' | 'paced', visitsLeft (its expected visits
// left in its grade) } }.
// Returns { main, wallet, claims (a sale carries its adena, paid at the
// meeting), stops, flows, orders (posted or with a raised fee: { id, item,
// recipeId, fee, materials, town, add }), withdrawn (orders it gave up),
// stalled: [{ selfId, route }], obtained: [{ selfId, grade, route }], waits:
// [{ wait, end }], gearChanged }.
function visit(main, view) {
    const claims = [], stops = [], orders = [], obtained = [], waits = [], withdrawn = [], stalled = [];
    const flows = { npcSales: 0, npcBuys: 0, fares: 0, warehouseFees: 0 };
    const bag = { ...main.bag }, shots = { ...main.shots }, kit = { ...main.kit }, wants = { ...main.wants }, incoming = { ...main.incoming };
    let money = main.money, weapon = main.weapon, shotWait = main.shotWait ?? null, gearChanged = false, wallet = view.twin ? view.twin.wallet : 0;
    let wts = [...main.ads.wts], wtb = [...main.ads.wtb];
    // Claimed units per book entry (first come: the books are read once).
    const taken = new Map();
    const left = entry => entry.qty - (taken.get(entry.id) || 0);
    // A sale's adena (units x price; a bid's price is per crystal) is paid at the meeting.
    const claim = (kind, entry, item, units, price, adena = null) => {
        taken.set(entry.id, (taken.get(entry.id) || 0) + units);
        claims.push({ kind, owner: entry.owner, id: entry.id, item, units, price, ...(adena === null ? {} : { adena }) });
    };
    const add = (table, id, count) => { table[id] = (table[id] || 0) + count; if (!table[id]) delete table[id]; };
    const toNpc = (id, count) => {
        const value = Math.round(count * (view.items[id]?.npcBuy || 0));
        if (!(value > 0)) return false;
        money += value; flows.npcSales += value;
        stops.push({ kind: 'npc_sell', target: view.town, items: [{ selfId: id, count }] });
        return true;
    };
    const persona = view.persona;
    const step = (line, look, bounds, side) => priceStep(line, { ...bounds, look, persona, roll: mulberry(hash(`${view.roll}:${side}:${bounds.item}`))() });
    // Materials it gathers for an order it will place stay in its bag; with
    // the keep rule (account_needs, ours) so do the materials of a piece
    // whose own route is an order it has not begun.
    const kept = {}, keepNeeds = view.keepRule === 'account_needs';
    for (const want of Object.values(wants)) if (want.state === 'farm' && want.order) for (const row of want.order.materials) kept[row.selfId] = (kept[row.selfId] || 0) + row.amount;
    if (keepNeeds) {
        for (const piece of Object.values(view.pieces)) {
            const route = wants[piece.selfId] ? null : (piece.routes || []).find(option => option.route !== 'buy');
            if (route?.route === 'order') for (const row of route.materials) kept[row.selfId] = (kept[row.selfId] || 0) + row.amount;
        }
    }
    const spare = id => Math.max(0, (bag[id] || 0) - (kept[id] || 0));

    // With the keep rule its main takes out what the workshop no longer uses
    // (surplus: a recipe dropped) and sells it with the rest.
    if (keepNeeds) {
        for (const [key, count] of Object.entries(view.surplus || {})) {
            if (!(count > 0)) continue;
            add(bag, Number(key), count);
            claims.push({ kind: 'own_stock', item: Number(key), units: count, surplus: true });
        }
    }
    // A pair's main leaves its twin what it uses, a deposit fee per stack.
    for (const [key, total] of Object.entries(view.deposit || {})) {
        const id = Number(key), count = Math.min(total, spare(id));
        if (money < view.depositFee || !(count > 0)) continue;
        money -= view.depositFee; flows.warehouseFees -= view.depositFee;
        add(bag, id, -count);
        stops.push({ kind: 'warehouse', target: 'deposit', items: [{ selfId: id, count }] });
    }

    // A path piece in its bag (a drop, or one a deal or an order brought) is worn.
    const equip = (selfId, slot) => {
        const worn = kit[slot];
        kit[slot] = selfId;
        if (view.pieces[selfId]?.weapon) {
            if (weapon && weapon !== worn && !Object.values(main.kit).includes(weapon)) add(bag, weapon, 1);
            weapon = selfId;
            // A weapon takes both hands' slots; a two-handed one the shield's too.
            for (const other of [...WEAPON_SLOTS, ...(slot === TWO_HANDED ? [SHIELD] : [])]) if (other !== slot && kit[other]) { add(bag, kit[other], 1); kit[other] = 0; }
        }
        if (worn) add(bag, worn, 1);
        gearChanged = true;
        const want = wants[selfId];
        if (want) {
            // An order no twin took yet is withdrawn: its materials and fee come back.
            const open = want.state === 'order' && !want.claimed;
            if (open) withdrawn.push(want.orderId);
            waits.push({ wait: { farm: 'farm', order: 'order', parked: 'parkedWant', route: 'route', twin: 'twin' }[want.state] || 'wtb', end: open ? 'withdrawn' : 'done' });
            delete wants[selfId];
        }
        const ad = wtb.find(row => row.item === selfId);
        if (ad) wtb = wtb.filter(row => row !== ad);
    };
    for (const piece of Object.values(view.pieces)) {
        if (!(bag[piece.selfId] > 0) || kit[piece.slot] === piece.selfId) continue;
        add(bag, piece.selfId, -1);
        if (!(piece.selfId in incoming)) obtained.push({ selfId: piece.selfId, grade: piece.grade, route: 'farm' });
        delete incoming[piece.selfId];
        equip(piece.selfId, piece.slot);
    }

    // Stock to the dearest buy line or WTB at or above the NPC's price, the rest to the NPC.
    for (const key of Object.keys(bag)) {
        const id = Number(key), item = view.items[id], count = spare(id);
        if (isGear(item) || !(count > 0)) continue;
        let rest = count;
        if (isShot(item)) { if (id === view.firing) continue; if (toNpc(id, rest)) add(bag, id, -rest); continue; }
        for (const entry of view.book.buy?.[id] || []) {
            if (rest <= 0) break;
            if (entry.price < (item?.npcBuy || 0)) break;
            const units = Math.min(rest, left(entry));
            if (units <= 0) continue;
            claim(entry.kind === 'ad' ? 'sell_wtb' : 'sell_line', entry, id, units, entry.price, units * entry.price);
            rest -= units;
        }
        // An item no NPC buys stays in the bag, unsold.
        add(bag, id, -(rest > 0 && !toNpc(id, rest) ? count - rest : count));
    }
    for (const [key, count] of Object.entries(shots)) {
        if (Number(key) === view.firing || !count) continue;
        if (toNpc(Number(key), count)) delete shots[key];
    }

    // Gear it does not wear: a standing WTB at or above its floor, else its
    // own WTS stepped at this look; at the floor for two looks, the floor's
    // channel (the best crystallizer bid, its own twin's included, else the
    // NPC). With the keep rule (account_needs, ours) one piece a slot of its
    // next grade's kit stays in its bag.
    const aheadKept = {}, aheadSlots = new Set();
    if (keepNeeds) for (const piece of view.ahead || []) if (!aheadSlots.has(piece.slot) && bag[piece.selfId] > 0) { aheadKept[piece.selfId] = 1; aheadSlots.add(piece.slot); }
    const nextWts = [], soldOut = new Set();
    for (const [key, total] of Object.entries(bag)) {
        const id = Number(key), item = view.items[id], count = total - (aheadKept[id] || 0);
        if (!isGear(item) || !(count > 0)) continue;
        const grade = String(item.grade || 'NONE').toLowerCase(), bid = item.crystals > 0 ? bestBid(view.book, grade) : null;
        const floor = Bounds.floor({ npcBuy: item.npcBuy || 0, crystallizerBids: bid ? [bid.price * item.crystals] : [] });
        let rest = count;
        for (const entry of view.book.buy?.[id] || []) {
            if (rest <= 0 || entry.price < floor) break;
            const units = Math.min(rest, left(entry));
            if (units <= 0) continue;
            claim('sell_wtb', entry, id, units, entry.price, units * entry.price);
            rest -= units;
        }
        const held = wts.find(row => row.item === id);
        if (rest <= 0) { if (held) { waits.push({ wait: 'wts', end: 'done' }); soldOut.add(held.id); } add(bag, id, -count); continue; }
        add(bag, id, -(count - rest));
        const rival = (view.book.sell?.[id] || []).find(entry => left(entry) > 0)?.price ?? null;
        const bounds = { floor, rival, known: view.known[id] ?? null, first: view.firstPrice[id] ?? floor, item: id };
        const priced = held ? step(held, held.look + 1, bounds, 'wts') : step({ side: 'sell', item: id }, 0, bounds, 'wts');
        if (priced.bound === 'floor' && priced.atBound >= PRICE_STEP.looksAtCapToClose) {
            // The ask at its floor: the floor's own channel.
            for (let i = 0; i < rest; i++) {
                const best = item.crystals > 0 ? bestBid(view.book, grade) : null;
                if (best && best.price * item.crystals > (item.npcBuy || 0) && left(best) >= item.crystals) {
                    taken.set(best.id, (taken.get(best.id) || 0) + item.crystals - 1);
                    claim(best.own ? 'own_bid' : 'sell_bid', best, id, 1, best.price, best.own ? null : best.price * item.crystals);
                } else toNpc(id, 1);
                add(bag, id, -1);
            }
            if (held) { waits.push({ wait: 'wts', end: 'failed' }); soldOut.add(held.id); }
            continue;
        }
        if (!held) waits.push({ wait: 'wts', end: 'opened' });
        nextWts.push({ ...priced, id: held ? held.id : `${view.adId}:wts:${id}`, side: 'sell', item: id, qty: rest, floor, grade, town: view.town });
    }
    // An ad whose piece left the bag otherwise (worn as a path piece) is withdrawn.
    for (const ad of wts) if (!nextWts.some(row => row.id === ad.id) && bag[ad.item] === undefined && !soldOut.has(ad.id)) waits.push({ wait: 'wts', end: 'withdrawn' });
    wts = nextWts;

    // The account warehouse pools the money: the main keeps its reserve and its next piece.
    const reserve = view.reserve, reservePrice = reserve ? view.known[reserve.id] ?? (view.book.sell?.[reserve.id] || [])[0]?.price ?? view.firstPrice[reserve.id] ?? 0 : 0;
    const next = view.order.find(row => row.kind === 'piece' && kit[row.slot] !== row.selfId);
    if (view.twin) {
        const pooled = pool({ main: money, wallet, escrow: view.twin.escrow, reserve: reserve ? reserve.amount * reservePrice : 0,
            piece: next ? view.pieces[next.selfId]?.routes?.[0]?.adena || 0 : 0, inputs: view.twin.inputs || 0, workshopMoney: view.twin.workshopMoney });
        money = pooled.main; wallet = pooled.wallet;
        if (pooled.moved > 0) {
            if (wallet >= view.depositFee) { wallet -= view.depositFee; flows.warehouseFees -= view.depositFee; } else if (money >= view.depositFee) { money -= view.depositFee; flows.warehouseFees -= view.depositFee; }
            stops.push({ kind: 'warehouse', target: 'pool', items: [] });
        }
    }

    // A buyer's WTB at this look: start at min(known, cap) x its persona's
    // start, up to the cap; two looks at the cap close it. With the paced
    // ladder (ours) a buyer whose expected visits left in its grade are
    // fewer than the looks the ladder still needs starts that many steps up
    // (with one visit left, at its cap).
    const ladderLooks = PRICE_STEP.buyerLooksToCap + PRICE_STEP.looksAtCapToClose;
    const lookOf = held => {
        const look = held ? held.look + 1 : 0;
        if (view.ladder?.mode !== 'paced' || !(view.ladder.visitsLeft < ladderLooks - look)) return look;
        return Math.max(look, Math.min(PRICE_STEP.buyerLooksToCap, ladderLooks - Math.max(1, Math.floor(view.ladder.visitsLeft))));
    };
    const stepWtb = (item, bounds) => {
        const held = wtb.find(row => row.item === item);
        const priced = step(held || { side: 'buy', item }, lookOf(held), bounds, 'wtb');
        wtb = wtb.filter(row => row !== held);
        if (!held) waits.push({ wait: 'wtb', end: 'opened' });
        if (priced.noMarket) { waits.push({ wait: 'wtb', end: 'failed' }); return 'parked'; }
        if (priced.close) { waits.push({ wait: 'wtb', end: 'failed' }); return priced.close; }
        wtb.push({ ...priced, id: held ? held.id : `${view.adId}:wtb:${item}`, side: 'buy', item, qty: bounds.qty, cap: bounds.cap, capBy: bounds.capBy, caps: bounds.caps || null, town: view.town });
        return 'open';
    };
    // The cheapest line or ad at or under the cap it can pay.
    const buyLine = (id, cap, need) => {
        let got = 0;
        for (const entry of view.book.sell?.[id] || []) {
            if (got >= need || entry.price > cap) break;
            const units = Math.min(need - got, left(entry), Math.floor(money / entry.price));
            if (units <= 0) { if (money < entry.price) break; continue; }
            claim(entry.kind === 'ad' ? 'buy_wts' : 'buy_line', entry, id, units, entry.price);
            money -= units * entry.price; got += units;
        }
        return got;
    };

    // An order placed from its own materials: they and the fee go with it.
    const placeOrder = (piece, order) => {
        const orderId = `${view.adId}:order:${piece.selfId}`, materials = {};
        for (const row of order.materials) { materials[row.selfId] = (materials[row.selfId] || 0) + row.amount; add(bag, row.selfId, -row.amount); }
        money -= order.fee;
        orders.push({ id: orderId, item: piece.selfId, recipeId: order.recipeId, fee: order.fee, materials, town: view.town, add: order.fee });
        wants[piece.selfId] = { state: 'order', route: 'order', orderId, order, seen: 0 };
        waits.push({ wait: 'order', end: 'opened' });
    };

    // An order's materials it lacks, bought from a line here at or under that
    // material's own route price (a line it knows in its twin's town is
    // bought at a visit where it stands), else the NPC here; the rest it gathers.
    const lack = row => Math.max(0, row.amount - (bag[row.selfId] || 0));
    const buyMaterials = order => {
        for (const row of order.materials) {
            if (!(lack(row) > 0) || row.via === 'gather' || row.via === 'held' || !(row.price > 0)) continue;
            let need = lack(row);
            const got = buyLine(row.selfId, row.price, need);
            add(bag, row.selfId, got); need -= got;
            const npc = view.npcSell[row.selfId];
            if (need > 0 && npc > 0 && money >= need * npc) {
                money -= need * npc; flows.npcBuys -= need * npc; add(bag, row.selfId, need);
                stops.push({ kind: 'npc_buy', target: view.town, items: [{ selfId: row.selfId, count: need }] });
            }
        }
    };

    let hopped = false;
    // A piece by the cap's own route; false when the money or the route is not there now.
    const byRoute = (piece, route) => {
        if (route.route === 'npc') {
            const fare = route.where === view.town ? 0 : view.fares[route.where];
            if (fare === null || fare === undefined || (fare > 0 && hopped)) return 'unavailable';
            if (money < route.adena) return 'money';
            money -= route.adena; flows.npcBuys -= route.adena - fare; flows.fares -= fare;
            if (fare > 0) { hopped = true; stops.push({ kind: 'gatekeeper', target: route.where, items: [] }); }
            stops.push({ kind: 'npc_buy', target: route.where, items: [{ selfId: piece.selfId, count: 1 }] });
            obtained.push({ selfId: piece.selfId, grade: piece.grade, route: 'npc' });
            equip(piece.selfId, piece.slot);
            return true;
        }
        if (route.route === 'twin') {
            // Its own twin crafts it: the piece comes through the account warehouse when the batch is done.
            wants[piece.selfId] = { state: 'twin', route: 'twin', seen: 0 };
            waits.push({ wait: 'twin', end: 'opened' });
            return true;
        }
        if (route.route === 'order') {
            const order = { recipeId: route.recipeId, fee: Math.ceil(route.fee), materials: route.materials.map(row => ({ selfId: row.selfId, amount: row.amount, via: row.via, price: row.price })),
                mp: route.mp, cap: piece.cap, materialsCost: route.materialsCost };
            const buys = order.materials.filter(row => lack(row) > 0 && row.via !== 'gather' && row.via !== 'held');
            const cost = buys.reduce((sum, row) => sum + lack(row) * row.price, 0);
            if (money < cost + order.fee) return 'money';
            buyMaterials(order);
            if (order.materials.some(row => lack(row) > 0)) {
                wants[piece.selfId] = { state: 'farm', route: 'order', order, seen: 0 };
                waits.push({ wait: 'farm', end: 'opened' });
                return true;
            }
            placeOrder(piece, order);
            return true;
        }
        if (route.route === 'exchange') {
            const crystal = view.crystalIds[route.grade?.toUpperCase()], fare = route.where === view.town ? 0 : view.fares[route.where];
            const lines = (view.book.sell?.[crystal] || []).filter(entry => entry.price <= route.perCrystal);
            const have = lines.reduce((sum, entry) => sum + left(entry), 0);
            if (!crystal || fare === null || fare === undefined || (fare > 0 && hopped) || have < route.amount) return 'unavailable';
            if (money < route.adena) return 'money';
            buyLine(crystal, route.perCrystal, route.amount);
            money -= fare; flows.fares -= fare;
            if (fare > 0) { hopped = true; stops.push({ kind: 'gatekeeper', target: route.where, items: [] }); }
            stops.push({ kind: 'exchange', target: route.where, items: [{ selfId: crystal, count: route.amount }, { selfId: piece.selfId, count: 1 }] });
            claims.push({ kind: 'exchange', item: piece.selfId, crystal, units: route.amount });
            obtained.push({ selfId: piece.selfId, grade: piece.grade, route: 'exchange' });
            equip(piece.selfId, piece.slot);
            return true;
        }
        // farm or gather: it hunts on; the piece comes when it drops.
        wants[piece.selfId] = { state: 'farm', route: route.route, seen: 0 };
        waits.push({ wait: 'farm', end: 'opened' });
        return true;
    };

    // The money queue.
    let stopped = false;
    for (const row of view.order) {
        if (stopped) break;
        if (row.kind === 'reserve') {
            if (!reserve || !(reserve.amount > 0)) continue;
            let need = reserve.amount;
            const own = Math.min(need, reserve.own || 0);
            if (own > 0) { add(shots, reserve.id, own); need -= own; claims.push({ kind: 'own_stock', item: reserve.id, units: own }); }
            if (need > 0 && reserve.cap >= 1) { const got = buyLine(reserve.id, reserve.cap, need); add(shots, reserve.id, got); need -= got; }
            const npc = view.npcSell[reserve.id];
            if (need > 0 && npc > 0 && npc <= reserve.cap) {
                const units = Math.min(need, Math.floor(money / npc));
                if (units > 0) { money -= units * npc; flows.npcBuys -= units * npc; add(shots, reserve.id, units); need -= units; stops.push({ kind: 'npc_buy', target: view.town, items: [{ selfId: reserve.id, count: units }] }); }
            }
            const bought = need < reserve.amount, ad = wtb.find(line => line.item === reserve.id);
            if (bought) {
                if (ad) { wtb = wtb.filter(line => line !== ad); waits.push({ wait: 'wtb', end: 'withdrawn' }); }
                if (shotWait === 'parked') waits.push({ wait: 'parkedShots', end: 'done' });
                shotWait = null;
            } else if (!(reserve.cap >= 1)) shotWait = 'unwanted';
            else if (shotWait !== 'parked') {
                const result = stepWtb(reserve.id, { cap: reserve.cap, capBy: reserve.capBy, floor: 0, known: view.known[reserve.id] ?? null, first: view.firstPrice[reserve.id] ?? reserve.cap, qty: need, item: reserve.id });
                shotWait = result === 'open' ? 'wtb' : 'parked';
                if (shotWait === 'parked') waits.push({ wait: 'parkedShots', end: 'opened' });
            }
            continue;
        }
        const piece = view.pieces[row.selfId];
        if (!piece || kit[piece.slot] === piece.selfId) continue;
        let want = wants[piece.selfId];
        const ownRoute = (piece.routes || []).find(option => option.route !== 'buy');
        // A parked want opens again when its cap rose above the cap it was
        // parked at, or when its money first reaches the piece's route.
        if (want?.state === 'parked') {
            const risen = piece.cap !== null && want.parkedCap !== undefined && piece.cap > want.parkedCap;
            const affordable = want.short && ownRoute && money >= ownRoute.adena;
            if (!risen && !affordable) continue;
            waits.push({ wait: 'parkedWant', end: 'withdrawn' });
            delete wants[piece.selfId];
            want = undefined;
        }
        // Nothing caps a piece no route prices and no worth states: no want is posted.
        if (piece.cap === null) continue;
        // An order a twin took is crafting: its piece comes at the batch's end.
        if (want?.state === 'order' && want.claimed) continue;
        // An order's materials it still lacks are bought where a line or the NPC here has them;
        // all gathered, it places the order now.
        if (want?.state === 'farm' && want.order) buyMaterials(want.order);
        if (want?.state === 'farm' && want.order && want.order.materials.every(row => (bag[row.selfId] || 0) >= row.amount) && money >= want.order.fee) {
            waits.push({ wait: 'farm', end: 'done' });
            placeOrder(piece, want.order);
            continue;
        }
        // An order, a farm or an own-twin wait seen unmet at its third visit
        // fails: the route is stalled for the piece (source_stalled re-reads
        // path). An order no twin took raises its fee by the step at each
        // visit before that, while the order stays under the piece's cap.
        if (want?.state === 'twin' && piece.own > 0) {
            claims.push({ kind: 'own_stock', item: piece.selfId, units: 1 });
            obtained.push({ selfId: piece.selfId, grade: piece.grade, route: 'twin' });
            equip(piece.selfId, piece.slot);
            continue;
        }
        if (want?.state === 'farm' || want?.state === 'order' || want?.state === 'twin') {
            const seen = (want.seen || 0) + 1;
            if (seen <= view.waitVisits) {
                let next = { ...want, seen };
                if (want.state === 'order') {
                    const fee = Math.min(want.order.fee + Math.ceil(view.feeStep * want.order.mp), Math.floor(want.order.cap - want.order.materialsCost));
                    const add = fee - want.order.fee;
                    if (add > 0 && money >= add) {
                        money -= add;
                        next = { ...next, order: { ...want.order, fee } };
                        orders.push({ id: want.orderId, item: piece.selfId, recipeId: want.order.recipeId, fee, town: view.town, add });
                    }
                }
                wants[piece.selfId] = next;
                continue;
            }
            waits.push({ wait: want.state, end: 'failed' });
            if (want.state === 'order') withdrawn.push(`${want.orderId}`);
            stalled.push({ selfId: piece.selfId, route: want.route });
            delete wants[piece.selfId];
            continue;
        }
        // Its own twin's shelf first, through the account warehouse.
        if (piece.own > 0) {
            claims.push({ kind: 'own_stock', item: piece.selfId, units: 1 });
            obtained.push({ selfId: piece.selfId, grade: piece.grade, route: 'twin' });
            equip(piece.selfId, piece.slot);
            continue;
        }
        const sellers = (view.book.sell?.[piece.selfId] || []).filter(entry => entry.price <= piece.cap && left(entry) > 0);
        if (sellers.length) {
            if (money < sellers[0].price) { stopped = true; continue; }
            buyLine(piece.selfId, piece.cap, 1);
            obtained.push({ selfId: piece.selfId, grade: piece.grade, route: 'buy' });
            equip(piece.selfId, piece.slot);
            continue;
        }
        const park = () => {
            wants[piece.selfId] = { state: 'parked', tries: want?.tries || 0, parkedCap: piece.cap, short: !!ownRoute && money < ownRoute.adena };
            waits.push({ wait: 'parkedWant', end: 'opened' });
        };
        // Its own twin's craft needs no market, and a piece it will use for
        // fewer than two more visits has no time for the ladder: the route at
        // once while the cap reaches it, else the want is parked now.
        const atOnce = ownRoute?.route === 'twin' || piece.visitsLeft < 2;
        if (want?.state !== 'route' && atOnce && wtb.some(line => line.item === piece.selfId)) {
            wtb = wtb.filter(line => line.item !== piece.selfId);
            waits.push({ wait: 'wtb', end: 'withdrawn' });
        }
        if (want?.state !== 'route' && atOnce && !(ownRoute && ownRoute.cost <= piece.cap)) { park(); continue; }
        if (want?.state !== 'route' && !atOnce) {
            const result = stepWtb(piece.selfId, { cap: piece.cap, capBy: piece.capBy, caps: piece.caps, floor: 0, known: view.known[piece.selfId] ?? null,
                first: view.firstPrice[piece.selfId] ?? piece.cap, qty: 1, item: piece.selfId });
            if (result === 'open') { wants[piece.selfId] = { state: 'wtb', tries: want?.tries || 0 }; continue; }
            if (result === 'parked') { park(); continue; }
        }
        if (want?.state !== 'route') {
            wants[piece.selfId] = { state: 'route', tries: want?.tries || 0 };
            waits.push({ wait: 'route', end: 'opened' });
        }
        const route = ownRoute;
        const done = route ? byRoute(piece, route) : 'unavailable';
        if (done === 'money') { stopped = true; continue; }
        if (done === 'unavailable') {
            const tries = (wants[piece.selfId]?.tries || 0) + 1;
            wants[piece.selfId] = { state: 'route', tries };
            if (tries >= 2 && route) { stalled.push({ selfId: piece.selfId, route: route.route }); waits.push({ wait: 'route', end: 'failed' }); delete wants[piece.selfId]; }
            continue;
        }
        // An order or a farm wait begins: the route wait is done (a piece
        // bought by its route ended it as it was worn).
        if (['order', 'farm', 'twin'].includes(wants[piece.selfId]?.state)) waits.push({ wait: 'route', end: 'done' });
    }

    return { main: { ...main, money, bag, shots, kit, weapon, wants, incoming, shotWait, ads: { wts, wtb } }, wallet, claims, stops, flows, orders, withdrawn, stalled, obtained, waits, gearChanged };
}

module.exports = { visit };
