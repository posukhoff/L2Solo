'use strict';

// Version 1 of the board command's typed root certificate. This is a view
// of the wish graph, never a second wallet or a persistent acquisition plan.
const roots = [null, 'power', 'stock', 'book', 'enchant', 'sa', 'henna', 'status', 'resale'];
const stockKinds = [null, 'shots', 'potions', 'scrolls'];
const Funding = require('./PurchaseFunding');
// WishNetwork loads this module at its top (lazy below).
let Network = null;
const integer = n => Number.isSafeInteger(n) && n >= 0;
const nonnegative = value => Math.max(0, Number(value) || 0);
// Selected NPC and configured shot quotes already have a native purchase owner.
// Public BUY ads describe alternative player supply, not a duplicate store job.
const isNativeSource = source => source === 'npc' || source === 'configured_store';
const nativePurchase = plan => isNativeSource(plan?.sourceType) && plan.quoted === true && plan.executable === true;
// Only completed preparation can retire public supply. A different root may
// still project player supply for the same item, so keep that alternative.
function npcOwnsPurchase(economy, selfId) {
    return !economy?.intentPending
        && nativePurchase(economy?.network?.plans?.get?.(`item:${Number(selfId)}`))
        && Array.isArray(economy.watchList)
        && !economy.watchList.some(row => Number(row.itemId) === Number(selfId));
}
function rootTuple(key) {
    const parts = String(key).split(':'), kind = roots.indexOf(parts[0]);
    if (kind < 1) throw Error('trade_intent_unknown_root');
    const arity = [1, 4, 5].includes(kind) ? 3 : 2;
    if (parts.length !== arity) throw Error('trade_intent_invalid_root');
    const a = kind === 2 ? stockKinds.indexOf(parts[1]) : Number(parts[1]);
    const b = arity === 3 ? Number(parts[2]) : 0;
    if (!integer(a) || a <= 0 || !integer(b) || arity === 3 && b <= 0) throw Error('trade_intent_invalid_root');
    return [kind, a, b];
}
function rootKey(kind, a, b) {
    if (!roots[kind] || !integer(a) || a <= 0 || !integer(b)) throw Error('trade_intent_invalid_root');
    const key = kind === 2 ? `stock:${stockKinds[a]}`
        : `${roots[kind]}:${a}${[1, 4, 5].includes(kind) ? `:${b}` : ''}`;
    const tuple = rootTuple(key);
    if (tuple[0] !== kind || tuple[1] !== a || tuple[2] !== b) throw Error('trade_intent_invalid_root');
    return key;
}
function decode(row) {
    if (!Array.isArray(row) || row.length !== 9) throw Error('trade_intent_invalid_certificate');
    const [itemId, amount, price, kind, a, b, recipeId, valueHours, valueRate] = row;
    if (![itemId, amount, price].every(n => integer(n) && n > 0) || !integer(recipeId)
        || !Number.isSafeInteger(amount * price) || ![valueHours, valueRate].every(n => Number.isFinite(n) && n >= 0)) {
        throw Error('trade_intent_invalid_certificate');
    }
    return { itemId, amount, price, key: rootKey(kind, a, b), recipeId, valueHours, valueRate };
}
function encode(row) {
    const tuple = [Number(row.itemId ?? row.selfId), Number(row.amount ?? row.count), Number(row.price),
        ...rootTuple(row.key), Number(row.recipeId || 0), Number(row.valueHours), Number(row.valueRate)];
    decode(tuple);
    return tuple;
}
// A buy ad's certificate at the bid's new price: the owner's own look
// repriced the bid, and its consent follows it.
function atPrice(tuple, price) {
    return encode({ ...decode(tuple), price });
}
// Whether a decoded certificate covers a meeting line: the same item, at
// least the line's count, at the line's price.
function covers(intent, { selfId, count, price }) {
    return intent.itemId === selfId && intent.amount >= count && intent.price === price;
}

// Every caller passes a quantity-prepared network (EconomyContext.forState
// builds it with a stock reader). A network without one has no remaining
// amounts to project: defer the command instead of subtracting stock here.
function project(state, network, projection, limit = 3, onCut = null) {
    return network?.quantityPrepared ? preparedProject(network, limit, onCut) : null;
}
// The cash a requirement row adds to its parent's price, as WishNetwork's
// solve counted it: the child's plan.basePrice (or `price`) times its batches
// (one batch of missing units when allocated, a quantity-prepared network), 0
// when unpriced.
function rowCash(row, allocated, price = row.plan?.basePrice) {
    const batches = allocated ? 1 : Math.ceil(row.amount / Number(row.plan?.productCount || 1));
    const cash = Number(price) * batches;
    return Number.isFinite(cash) && cash > 0 ? cash : 0;
}
// A buyer's-line producer's weights (bidsInputs, preparedProject): a row
// weighs what its leaves cost at the least each fills at, a sold leaf its ask
// (basePrice), an unsold one its NPC buy-back (plan.bidFloor, WishNetwork),
// a crafted input the sum of its own inputs, not its belief. The same total
// WishNetwork earns tests (asks + floors), so an unsold input's share of the
// line clears its buy-back exactly when earns holds. One walk per root: the
// weights live in the caller's map for that root's visit only.
function lineCash(weights) {
    const cash = (row, allocated) => {
        if (weights.has(row)) return weights.get(row);
        const plan = row.plan;
        const requirements = (plan?.execution || plan)?.requirements || [];
        let sum = 0;
        if (!requirements.length) sum = rowCash(row, allocated, plan?.kind === 'buy' && plan.bidFloor > 0 ? plan.bidFloor : plan?.basePrice);
        else for (const child of requirements) sum += cash(child, allocated);
        weights.set(row, sum);
        return sum;
    };
    return cash;
}
// How a parent's value splits between its inputs, the one rule of
// WishNetwork.flow (demands, so the economy's own worth) and preparedProject
// (the buy intent's worth): by the cash each input adds to the parent's
// price (rowCash; a buyer's line: lineCash), not by unit count, so a recipe
// scroll x1 among hundreds of cheap materials keeps its price's share. A row
// with no positive price (a free path, awaited delivery) weighs the priced
// rows' mean unit price; with none priced, every unit weighs the same.
// inputShare(row, split) is a row's fraction of the parent's value.
function inputSplit(requirements, allocated = true, cash = rowCash) {
    let pricedCash = 0, pricedUnits = 0, units = 0;
    for (const row of requirements) {
        units += row.amount;
        const weight = cash(row, allocated);
        if (weight > 0) { pricedCash += weight; pricedUnits += row.amount; }
    }
    const unit = pricedUnits > 0 ? pricedCash / pricedUnits : 1;
    return { allocated, cash, unit, total: pricedCash + (units - pricedUnits) * unit || 1 };
}
// A crafter with the recipe buys the inputs: a craft path whose recipe is
// still to learn, its scroll (the once row) not held, buys the scroll alone.
// Its inputs (and their sub-recipes) wait until the scroll is in the bag;
// such a root holds only the scroll's cash in the money queue
// (WishNetwork.cashCharge).
function scrollFirst(path, requirements) {
    return path?.requiresRecipeLearning === true && requirements.some(row => row.once);
}

function inputShare(row, split) {
    return (split.cash(row, split.allocated) || row.amount * split.unit) / split.total;
}
// What a transformation (craft, exchange, crystallize, unseal) passes down to
// its inputs before inputSplit: its value, at most its input ceiling cap (in
// adena) times scale (adena to the value's unit: the network's moneyPrice for
// an hour value, 1 / hourAdena for a shot's own use). The ceiling is the
// solve's (WishNetwork plan.inputCap: output at the market price, less the
// step's own cash; none under a buyer's line) or, for a shot's own use, the
// shot's market price (PriceBelief soldPrice). No ceiling or scale (0,
// unknown) keeps the value. Readers: preparedProject, WishNetwork.flow, ShotCraftPolicy's
// 'use' exit; the solve's verdict compares the same plan.inputCap.
function inputValue(value, cap, scale) {
    const limit = Number(cap) * Number(scale);
    return Number(cap) > 0 && Number(scale) > 0 && limit < value ? limit : value;
}
// What a root passes down to its inputs (preparedProject, WishNetwork.flow):
// its own value in hours, never the money queue's progression floor
// (WishNetwork.moneyQueue keeps the own value as ownValueHours when the floor
// raised it). The floor orders and funds the root; an input worth read from
// it would follow the input's own price (price -> worth -> bid -> price).
function rootValue(wish) {
    return wish.ownValueHours ?? wish.valueHours;
}
// A buyer's-line producer root's line in adena (WishProviders bidsInputs:
// the lot's gross), 0 for any other root.
function lineOf(root) {
    return Number(root?.bidsInputs) > 0 ? Number(root.bidsInputs) : 0;
}

// A bid and its later consent price the same remaining goal. The generic
// item estimate can be lower than this goal's allocated usefulness (a kit
// piece or craft input); it is only the fallback before money is prepared.
// A row's cap (rootRows) bounds both.
function purchaseWorth(intent, moneyPrice) {
    return intent?.key && moneyPrice > 0
        ? Math.min(Number(intent.valueHours) / Math.max(1, Number(intent.amount)) / moneyPrice, Number(intent.cap ?? Infinity))
        : Number(intent?.worth);
}
// A quantitative network already owns allocation and batch rounding. Readers
// only project that result; they never subtract physical stock a second time.
// A row's worth is one unit's share of its root in adena (its valueHours over
// its amount at its root's money price, WishNetwork.rootMoneyPrice): what a buy ad of the intent may
// pay (BuyAdPolicy.bidFor, MarketPricing.look) and a meeting purchase's
// consent (meetingPurchase), 0 without a money price.
// A buyer's-line producer (bidsInputs: the line in adena) splits that line,
// not its queue value, by lineCash: a row's worth is its share of the line
// over its amount, without the money price.
// The limit's slots: every funded root's, the funding gap's and a buyer's-line
// producer's (funded or not; it bids every input not bought from an NPC, a
// sold one too, at its share of the line) first row first (a root still missing its recipe: the scroll), in queue
// order, so an earning root bids beside the missing gear on equal terms, and
// the gear the money waits for keeps its row; then the remaining rows in
// queue order.
// onCut: called once per bid row cut to its town's shortfall (EconomyContext
// .forState passes WishProviders.countShortBid, summary line shortBids=).
function preparedProject(network, limit, onCut = null) {
    const watched = new Set(), farmIds = new Set(), rooted = [], firsts = [], gapKey = network.gap?.key;
    const moneyPrice = Number(network.moneyPrice);
    for (const wish of network.queue || []) {
        if (!wish.object?.itemId && !wish.object?.materials) continue;
        try { rootTuple(wish.key); } catch (_) { return null; }
        const { rows, farms, line } = rootRows(network, wish, onCut);
        let first = wish.funded === true || wish.key === gapKey || line > 0;
        for (const [id, row] of rows) if (!watched.has(id)) {
            watched.add(id);
            (first ? firsts : rooted).push(row);
            first = false;
        }
        // A root's farmed rows follow its other rows, never a first slot;
        // an item another row bids for keeps that row (checked below).
        if (moneyPrice > 0) for (const row of farms.values()) if (!farmIds.has(row.itemId)) {
            farmIds.add(row.itemId);
            rooted.push(row);
        }
    }
    const result = firsts.slice(0, limit);
    for (const row of rooted) if (result.length < limit && !(row.farm && watched.has(row.itemId))) result.push(row);
    return result;
}
// One root's bid rows before the item deduplication across roots
// (preparedProject's rule): rows, its buy leaves by item, each with its worth
// (and, for an executable player quote, that quote: price, town, units), and
// farms, the gear recipe materials it farms (worth set with a money price).
// Readers: preparedProject (standing bids) and meetingPurchase (each funded
// root's own quantity at consent, which the deduplication may have dropped).
function rootRows(network, wish, onCut = null) {
    // lazy: cycle WishNetwork requires TradeIntent at load.
    const { shortOf, MAX_DEPTH, rootMoneyPrice } = Network ||= require('./WishNetwork');
    const step = network.activity, moneyPrice = rootMoneyPrice(network, wish);
    const rows = new Map(), farms = new Map();
    const line = lineOf(wish);
    const cash = line ? lineCash(new Map()) : rowCash;
    // Only the path the network chose bids (WishNetwork solve, buy
    // against craft against farm; user 2026-10-24): a transformation
    // (craft, exchange, crystallize) bids its missing inputs, never its
    // product; a buy leaf bids the item itself; a farm leaf (hunting)
    // bids nothing, the bot farms it, except a material of a gear
    // root's recipe (not its scroll): the plan bids for it while
    // farming, at most what farming the missing units costs it (the
    // path's hours per unit, no held units or trip; user 2026-10-25,
    // T30), after the root's other rows. The inputs are an AND split of
    // the node's value after its input ceiling (inputValue, the solve's
    // plan.inputCap; inputShare), so the root's rows sum to at most its worth.
    const visit = (key, plan, value, recipeId = 0, depth = 0, once = false) => {
        if (!plan || depth > MAX_DEPTH || !(plan.missingAmount > 0) || !(value > 0)) return;
        const command = plan.execution || plan;
        if (!(plan.grossRequirements || plan.requirements || []).length) {
            const id = key.startsWith('item:') ? Number(key.slice(5)) : 0;
            if (!id || nativePurchase(plan)) return;
            if (command.activity === 'hunting') {
                const farmCost = Number(command.costHours) * plan.missingAmount;
                if (line || !recipeId || once || !wish.key.startsWith('power:') || !(farmCost > 0)) return;
                const previous = farms.get(id);
                farms.set(id, { itemId: id, amount: plan.missingAmount + (previous?.amount || 0), worth: 0,
                    kind: wish.object?.kind, key: wish.key, recipeId,
                    valueHours: Math.min(value, farmCost) + (previous?.valueHours || 0), valueRate: Funding.significant(wish.ratio) });
                return;
            }
            // A short buy whose step runs now (the build's chosen leaf,
            // network.activity: this root, this node, this activity; its
            // town sells part: WishNetwork.shortOf, the one test; the leaf
            // buys those units) bids only the units the town lacks, at the
            // same unit worth (partialcross 2026-10-25). Any other buy, a
            // whole lot or a waiting one, bids every missing unit:
            // BidPurchaseAlternative.cap holds it under the town's asks.
            const short = step?.rootKey === wish.key && step.nodeKey === key && step.activity === command.activity
                ? shortOf(command, plan.missingAmount) : 0;
            const amount = short > 0 ? short : plan.missingAmount;
            if (short > 0) { value *= short / plan.missingAmount; onCut?.(); }
            // The bid's cap (user 10-27, T53): the unit at the bot's price
            // belief (the step's basePrice: its missing units at belief,
            // before trips) plus this row's share of what the root's wait
            // costs (waitValueHours, at the money price): no money price,
            // however cheap, bids above it. An unpriced step has no cap.
            const belief = nonnegative(plan.basePrice) / plan.missingAmount;
            const saved = Number(network.moneyPrice) > 0 && rootValue(wish) > 0
                ? nonnegative(wish.waitValueHours) * value / rootValue(wish) / Number(network.moneyPrice) : 0;
            const capCash = belief > 0 ? belief * amount + saved : Infinity;
            const previous = rows.get(id);
            const quote = plan.kind === 'buy' && plan.sourceType === 'afk' && plan.quoted === true
                && plan.executable === true && integer(plan.unitPrice) && plan.unitPrice > 0 && plan.town
                ? { price: plan.unitPrice, town: plan.town,
                    amount: Math.min(plan.missingAmount, Number(plan.availableUnits)) } : null;
            rows.set(id, { itemId: id, amount: amount + (previous?.amount || 0), worth: 0,
                kind: wish.object?.kind, key: wish.key, recipeId, valueHours: value + (previous?.valueHours || 0),
                valueRate: Funding.significant(wish.ratio), capCash: capCash + (previous?.capCash ?? 0),
                ...(wish.heldCash > 0 ? { held: true } : {}),
                ...(quote && integer(quote.amount) && quote.amount > 0 ? { quote } : {}) });
            return;
        }
        const requirements = command.requirements || [];
        // The units its step covers now (WishNetwork.shortOf, the one test).
        const share = plan.execution ? 1 - shortOf(command, plan.missingAmount) / plan.missingAmount : 1;
        if (!requirements.length) return;
        value = inputValue(value, plan.inputCap, moneyPrice);
        const split = inputSplit(requirements, true, cash);
        // The scroll alone keeps its share of the root (scrollFirst).
        const scrollOnly = scrollFirst(plan, requirements);
        for (const row of requirements) if (!scrollOnly || row.once) visit(row.key, row.plan, value * share * inputShare(row, split),
            plan.recipeId || recipeId, depth + 1, !!row.once);
    };
    visit(wish.key, wish.plan, line || rootValue(wish));
    for (const row of rows.values()) {
        if (line) { row.worth = row.valueHours / row.amount; row.valueHours *= moneyPrice > 0 ? moneyPrice : 0; row.line = true; }
        else {
            if (Number.isFinite(row.capCash)) row.cap = row.capCash / row.amount;
            row.worth = moneyPrice > 0 ? purchaseWorth(row, moneyPrice) : 0;
        }
        delete row.capCash;
    }
    // A farmed material bids at most its farm hours at the money price
    // earned (hunting is earning), never at a held price.
    const farmPrice = Number(network.moneyPrice);
    if (farmPrice > 0) for (const row of farms.values()) { row.worth = row.valueHours / row.amount / farmPrice; row.farm = true; }
    return { rows, farms, line };
}

// Public willingness prices all missing units. The current funded action has
// already accepted a concrete finite quote, which can exceed that estimate
// for a required kit piece. Keep that consent local to meeting preparation;
// it neither raises standing bids nor authorizes a different or larger buy.
function meetingPurchase(network, intents, { selfId, count, price, town, enchant = 0 }, state = null) {
    if (!network?.quantityPrepared) return null;
    // lazy: cycle WishNetwork requires TradeIntent at load.
    Network ||= require('./WishNetwork');
    // Consent at the money price the row's bid used (rootRows): its root's,
    // a farmed material's the money earned.
    const rowPrice = row => row.farm ? Number(network.moneyPrice)
        : Network.rootMoneyPrice(network, network.queue?.find(wish => wish.key === row.key));
    const ordinary = intents?.find(row => row.itemId === selfId && row.amount >= count
        && purchaseWorth(row, rowPrice(row)) >= price);
    const leaf = network.activity;
    const nativeQuote = nativePurchase(leaf) && Number(leaf.valueHours) > 0;
    const actual = (network.queue || []).filter(wish => wish.funded === true)
        .map(wish => rootRows(network, wish).rows.get(selfId)).filter(Boolean);
    // A funded kit may acquire its prerequisites in either order. Use the
    // fresh graph's concrete input quote, not the value apportioned among
    // all ingredients, to consent to that finite required purchase.
    const required = !ordinary && enchant === 0 && integer(count) && count > 0 && integer(price) && price > 0
        && (leaf?.itemId !== selfId || network.queue.some(wish => wish.key === leaf.rootKey && wish.funded === true))
        && actual.find(row => (leaf?.itemId !== selfId || row.key !== leaf.rootKey)
            && row.amount >= count && row.quote?.amount >= count
            && row.quote.town === town && row.quote.price >= price);
    const quoted = required ? { ...required, amount: required.quote.amount, worth: required.quote.price,
        valueHours: required.valueHours * required.quote.amount / required.amount } : null;
    if (!network?.quantityPrepared || leaf?.kind !== 'buy' || leaf.activity !== 'shopping'
        || leaf.sourceType !== 'afk' && !nativeQuote || leaf.quoted !== true || leaf.executable !== true
        || leaf.itemId !== selfId || leaf.town !== town || enchant !== 0
        || !integer(leaf.amount) || leaf.amount <= 0 || !integer(leaf.unitPrice) || leaf.unitPrice <= 0
        || !integer(count) || count <= 0 || count > leaf.amount || !(leaf.availableUnits >= count)
        || !integer(price) || price <= 0 || price > leaf.unitPrice) return ordinary || quoted || null;
    const wish = network.queue?.find(row => row.key === leaf.rootKey && row.funded === true);
    // The executable NPC leaf is deliberately absent from public WTB rows.
    // A cheaper same-town player quote may still fulfill that exact funded
    // purchase; it cannot enlarge the native quantity or price ceiling.
    const intent = wish && (actual.find(row => row.key === wish.key && row.amount >= leaf.amount)
        || nativeQuote && { itemId: selfId, amount: leaf.amount, key: wish.key, recipeId: 0,
            valueHours: Number(leaf.valueHours), valueRate: Funding.significant(wish.ratio) });
    if (!intent) return ordinary || quoted || null;
    // A fresh source review can change the hour estimate while the native
    // row still holds this same goal's funded bucket. Spend at that bucket's
    // stored priority; another goal's reserve cannot authorize this quote.
    const packet = state?.stats?.money;
    let valueRate = intent.valueRate;
    if (state?.stats?.wishFocus?.[0] === wish.key && Array.isArray(packet)) {
        for (let at = 4; at + 2 < packet.length; at += 3) {
            if (Number(packet[at + 2]) === Number(wish.object?.itemId) && packet[at] > 0 && packet[at] >= Funding.spendPrice(packet)) {
                valueRate = Number(packet[at]); break;
            }
        }
    }
    return ordinary?.key === wish.key ? { ...ordinary, valueRate }
        : { ...intent, amount: leaf.amount, worth: leaf.unitPrice, valueRate,
            valueHours: intent.valueHours * leaf.amount / intent.amount };
}
module.exports = { rootTuple, rootKey, encode, decode, atPrice, covers, project, inputSplit, inputShare, inputValue, rootValue, lineOf, scrollFirst, purchaseWorth, meetingPurchase, npcOwnsPurchase, isNativeSource };
