const { isMainThread } = require('node:worker_threads');
const Valuation = require('./EconomicValuation');
const { fnv1a32 } = require('../Fnv1a');
const Diagnostics = require('./EconomyDiagnostics');
const { packetRowWishes, rootRatio } = require('./PurchaseFunding');
const TradeIntent = require('./TradeIntent');
const Bytes = require('./CompactBytes');
const CommittedExits = require('./CommittedExits');
const NEEDS = Object.freeze(['power', 'status', 'care', 'scores']);
// The one bound of nodes a wish network holds: the build (WishProviders),
// admission and validation all read it.
const MAX_NODES = 64;
// The one bound of paths a node holds: 4 of its own (WishProviders cut) and
// the second buy past them (an ask rival takers hold leaves the rest of the
// market, WishProviders itemNode); the solver rejects a node over it.
const MAX_PATHS = 5;
// The buys priced again for the units a node orders (WishProviders
// sizedBuyFor): path -> (n => the path for n units). Held off the path, so
// every buy keeps one shape and no copy of a path carries a function. An
// entry is one build's (its reader's quotes and the build's waits): it ends
// with the build's last solve (endSizedBuys) or dies with its path.
const SIZED_BUYS = new WeakMap();
function sizedBuy(path, forAmount) {
    SIZED_BUYS.set(path, forAmount);
    return path;
}
// The build's last solve is over (EconomyContext forState, after its own
// network build): a kept projection holds no sized pricing, so its buys no
// longer hold the build's buy reader, whose board watch holds the build
// context (partyheap, the worker heap 10-25: ~0.6 MB per party bot). A later
// solve over a kept projection reads copies of its paths (EconomyContext
// forGroup), which never carried one.
function endSizedBuys(nodes) {
    for (const node of nodes || []) for (const path of node.paths || []) SIZED_BUYS.delete(path);
}
const MAX_ROOTS = 12;
// B craft -> C crystals -> Luxury C item -> D crystals -> NPC D input.
// MAX_NODES still bounds the complete graph.
const MAX_DEPTH = 6;
// One attempt of a chosen path keeps at most this many exact outcomes
// (EconomicValuation.OUTCOME_LIMIT); a larger composition is unresolved.
const MAX_BRANCHES = 8;
const nonnegative = value => Math.max(0, Number(value) || 0);
// Native stock questions, before owned children disappear from a plan. Exact
// answers also preserve the prior claims in every subsequent allocation pass.
// This is one build's bounded evidence, never a second allocation or bag index.
// It is held packed (the codec below, ~3-6 B a row); the rows exist only
// while a build records them and while one verdict reads them. The byte cap
// bounds the packed form, the one form that is held, saved and sent.
const QUANTITY_INPUT_LIMIT = 2048;
const QUANTITY_INPUT_BYTES = 8192;
const QUANTITY_SCALARS = new Set(['physical', 'present', 'freePresent', 'incoming', 'free', 'crystalFree']);
const QUANTITY_KINDS = Object.freeze([...QUANTITY_SCALARS, 'stock', 'stockPhysical']);
// Exact transport of the native read list: no rows are merged, inferred or
// discarded. Each id, root and root literal is written once, at its first
// use (an id as the signed delta from the previous new id), and
// as its first-use index after that. Values 0 and 1 live in the row header.
// The saved decision codec treats this owner's bytes opaquely.
function packQuantityInputs(proof) {
    if (proof?.version !== 1 || !Array.isArray(proof.rows) || proof.rows.length > QUANTITY_INPUT_LIMIT) return null;
    try {
        const write = Bytes.writer(), ids = new Map(), roots = new Map(), literals = new Map();
        let lastId = 0;
        const numberTag = value => {
            if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw Error('quantity value');
            return Object.is(value, -0) || !Number.isSafeInteger(value) ? 3 : value <= 1 ? value : 2;
        };
        const number = (value, tag) => {
            if (tag === 2) write.uint(value);
            else if (tag === 3) write.double(value);
        };
        const literal = text => {
            if (literals.has(text)) { write.uint(literals.get(text)); return; }
            write.uint(literals.size); literals.set(text, literals.size); write.text(text);
        };
        write.byte(3); write.uint(proof.rows.length);
        for (const row of proof.rows) {
            if (!Array.isArray(row)) return null;
            const kind = QUANTITY_KINDS.indexOf(row[0]), rooted = kind >= 6;
            if (kind < 0 || row.length !== (kind === 6 ? 5 : kind === 7 ? 4 : 3)) return null;
            const id = row[rooted ? 2 : 1], value = row[rooted ? 3 : 2];
            if (!Number.isSafeInteger(id) || id <= 0 || rooted && typeof row[1] !== 'string') return null;
            const first = numberTag(value), second = kind === 6 ? numberTag(row[4]) : 0, fresh = !ids.has(id);
            write.byte(kind + first * 8 + second * 32 + (fresh ? 128 : 0));
            if (fresh) {
                write.signed(id - lastId);
                ids.set(id, ids.size); lastId = id;
            } else write.uint(ids.get(id));
            if (rooted) {
                const root = row[1];
                if (roots.has(root)) write.uint(roots.get(root));
                else {
                    write.uint(roots.size); roots.set(root, roots.size);
                    // Tag 1: the root embeds this row's own id between two literals.
                    const decimal = String(id), at = root.indexOf(decimal);
                    if (at < 0) { write.byte(0); literal(root); }
                    else { write.byte(1); literal(root.slice(0, at)); literal(root.slice(at + decimal.length)); }
                }
            }
            number(value, first);
            if (kind === 6) number(row[4], second);
        }
        const bytes = write.finish();
        return bytes.length <= QUANTITY_INPUT_BYTES ? bytes : null;
    } catch (_) { return null; }
}
// The one decoder: calls visit(row, index) for each row in order. False on a
// malformed or over-cap stream, or when visit returns false; a reader
// error inside visit is not a codec refusal and propagates.
function eachQuantityRow(value, visit) {
    if (!(value instanceof Uint8Array) || value.byteLength > QUANTITY_INPUT_BYTES) return false;
    let visiting = false;
    try {
        const read = Bytes.reader(value);
        const number = tag => {
            if (tag <= 1) return tag;
            if (tag === 2) { const result = read.uint(); if (result <= 1) throw Error('quantity integer tag'); return result; }
            const result = read.double();
            if (!Number.isFinite(result) || result < 0 || Number.isSafeInteger(result) && !Object.is(result, -0)) throw Error('quantity value');
            return result;
        };
        const literals = [], seenLiterals = new Set();
        const literal = () => {
            const index = read.uint();
            if (index < literals.length) return literals[index];
            if (index > literals.length) throw Error('quantity literal');
            const text = read.text();
            if (seenLiterals.has(text)) throw Error('quantity literal');
            seenLiterals.add(text); literals.push(text);
            return text;
        };
        if (read.byte() !== 3) return false;
        const count = read.uint();
        if (count > QUANTITY_INPUT_LIMIT) return false;
        const ids = [], seenIds = new Set(), roots = [], seenRoots = new Set();
        let lastId = 0;
        for (let i = 0; i < count; i++) {
            const header = read.byte(), kind = header % 8, first = Math.floor(header / 8) % 4, second = Math.floor(header / 32) % 4;
            if (kind !== 6 && second) return false;
            let id;
            if (header >= 128) {
                id = lastId + read.signed();
                if (!Number.isSafeInteger(id) || id <= 0 || seenIds.has(id)) return false;
                seenIds.add(id); ids.push(id); lastId = id;
            } else {
                const index = read.uint();
                if (index >= ids.length) return false;
                id = ids[index];
            }
            let row;
            if (kind >= 6) {
                const index = read.uint();
                if (index > roots.length) return false;
                if (index === roots.length) {
                    const tag = read.byte();
                    if (tag > 1) return false;
                    const text = tag ? literal() + String(id) + literal() : literal();
                    if (seenRoots.has(text) || Buffer.byteLength(text) > QUANTITY_INPUT_BYTES) return false;
                    seenRoots.add(text); roots.push(text);
                }
                row = kind === 6 ? [QUANTITY_KINDS[kind], roots[index], id, number(first), number(second)]
                    : [QUANTITY_KINDS[kind], roots[index], id, number(first)];
            } else row = [QUANTITY_KINDS[kind], id, number(first)];
            visiting = true;
            if (visit(row, i) === false) return false;
            visiting = false;
        }
        return read.done();
    } catch (error) {
        if (visiting) throw error;
        return false;
    }
}
// One row's identity in a proof: a rooted row by its root and item, a
// scalar row by its item.
const quantityRowKey = row => row[0] === 'stock' || row[0] === 'stockPhysical'
    ? `${row[0]}:${row[1]}:${row[2]}` : `${row[0]}:${row[1]}`;
// The build also notes, per row, the counts a decision compared the row's
// value with, each as "value >= t" (a strict "> t" on a count is t + 1):
// a held build keeps a moved row while it stays on the same side of each
// (EconomyContext heldBuildVerdict). Every read of a row either notes the
// thresholds it compares with (atLeast) or marks the row untracked (a read
// used as an amount, or a compare not noted): an untracked row, one past
// the cap or one never noted stays exact, whatever else noted it.
const QUANTITY_THRESHOLDS = 32;
// A build that noted none shares this one.
const NO_THRESHOLDS = Object.freeze([]);
const ascending = (a, b) => a - b;
// One stock fact, one row: a stock read whose answer does not depend on its
// root (stock(id, rootKey, value, fact) with fact '': EconomyContext
// ownStockRow) is one row of the item under the root '' for every root that
// reads it, its thresholds the union of theirs (any untracked or unnoted
// reader, or more than QUANTITY_THRESHOLDS, keeps it exact): it moves past
// a threshold exactly when one of their own rows would have. finish(own)
// keeps the leaf root's row of its own item apart (the verdict skips it:
// own outputs are not inputs, EconomyContext ownQuantityRow).
function createQuantityInputs() {
    // seen: row key -> row index; noted: a reader's row key (keyOf) ->
    // thresholds or null (untracked); readers: a shared stock row's index ->
    // the roots that read it.
    const rows = [], seen = new Map(), noted = new Map(), readers = new Map();
    // invalid: '' or the first reason the proof is void (diagnostics name it).
    let invalid = '', finished = false, packed = null, thresholds = null;
    // The row's index, -1 once the proof is void or finished.
    const record = row => {
        if (invalid || finished) return -1;
        const key = quantityRowKey(row);
        const previous = seen.get(key);
        if (previous !== undefined) {
            for (let at = 0; at < row.length; at++) if (rows[previous][at] !== row[at]) invalid ||= 'conflict';
            return invalid ? -1 : previous;
        }
        if (rows.length >= QUANTITY_INPUT_LIMIT) { invalid = 'rows'; return -1; }
        seen.set(key, rows.length); rows.push(row);
        return rows.length - 1;
    };
    const scalar = kind => (id, value) => {
        if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0 || !Number.isFinite(nonnegative(value))) invalid ||= 'value';
        if (kind === 'incoming' && Number(value || 0) < 0) invalid ||= 'value';
        record([kind, Number(id), kind === 'present' || kind === 'freePresent' ? Number(nonnegative(value) > 0) : nonnegative(value)]);
        return value;
    };
    // A row's key (quantityRowKey) by its reader's arguments; the last one
    // is kept: a reader notes its thresholds in a run of calls on one row.
    let lastKind = '', lastId = 0, lastRoot = null, lastKey = '';
    const keyOf = (kind, id, rootKey) => {
        if (kind !== lastKind || id !== lastId || rootKey !== lastRoot) {
            lastKind = kind; lastId = id; lastRoot = rootKey;
            lastKey = kind === 'stock' ? `stock:${rootKey}:${Number(id)}` : `${kind}:${Number(id)}`;
        }
        return lastKey;
    };
    // A shared stock row's thresholds: the union of its readers' notes, null
    // (exact) when one reader noted none or the union passes the cap.
    const sharedSides = (roots, id) => {
        let union = null;
        for (const root of roots) {
            const sides = noted.get(`stock:${root}:${id}`);
            if (!sides) return null;
            if (!union) union = [...sides];
            else for (const side of sides) if (!union.includes(side)) union.push(side);
            if (union.length > QUANTITY_THRESHOLDS) return null;
        }
        return union;
    };
    // The leaf root's read of its own item (finish(own)) leaves the shared
    // row: its own row replaces it when no other root read it, else follows
    // the rows.
    const splitOwn = own => {
        const at = seen.get(`stock::${Number(own?.itemId)}`), roots = at === undefined ? null : readers.get(at);
        if (!roots?.has(own.rootKey)) return;
        const shared = rows[at], row = ['stock', own.rootKey, shared[2], shared[3], shared[4]];
        roots.delete(own.rootKey);
        if (!roots.size) { readers.delete(at); seen.delete(quantityRowKey(shared)); seen.set(quantityRowKey(row), at); rows[at] = row; }
        else if (record(row) < 0) invalid ||= 'rows';
    };
    // The noted thresholds, one flat frozen list (no array per row; integer
    // entries stay unboxed in a packed frozen array): [row index, count,
    // t1 < ... < t_count, ...] by ascending row index; a threshold <= 0 is
    // dropped (a count is never below it).
    const compact = () => {
        const list = [];
        for (let index = 0; index < rows.length; index++) {
            const roots = readers.get(index);
            const sides = roots ? sharedSides(roots, rows[index][2]) : noted.get(quantityRowKey(rows[index]));
            if (!sides) continue;
            const at = list.length;
            list.push(index, 0);
            for (const side of sides.sort(ascending)) if (side > 0) list.push(side);
            list[at + 1] = list.length - at - 2;
        }
        return list.length ? Object.freeze(list) : NO_THRESHOLDS;
    };
    return {
        // fact: the row's root, '' when the answer is the same for every
        // root (one shared row of the item).
        stock(id, rootKey, value, fact = rootKey) {
            if (typeof rootKey !== 'string' || fact !== rootKey && fact !== '' || !Number.isSafeInteger(Number(id)) || Number(id) <= 0
                || !Number.isFinite(nonnegative(value?.owned)) || !Number.isFinite(nonnegative(value?.incoming))) invalid ||= 'value';
            const at = record(['stock', String(fact), Number(id), nonnegative(value?.owned), nonnegative(value?.incoming)]);
            if (at >= 0 && fact !== rootKey) {
                const roots = readers.get(at);
                if (roots) roots.add(rootKey); else readers.set(at, new Set([rootKey]));
            }
            return value;
        },
        stockPhysical(rootKey, id, value) {
            if (typeof rootKey !== 'string' || !Number.isSafeInteger(Number(id)) || Number(id) <= 0
                || !Number.isFinite(nonnegative(value))) invalid ||= 'value';
            record(['stockPhysical', rootKey, Number(id), nonnegative(value)]);
            return value;
        },
        physical: scalar('physical'), present: scalar('present'), freePresent: scalar('freePresent'),
        incoming: scalar('incoming'), free: scalar('free'), crystalFree: scalar('crystalFree'),
        unsupported() { invalid ||= 'unsupported'; },
        // A threshold the build compared the row (kind, id; a stock row also
        // its root) with.
        atLeast(kind, id, threshold, rootKey = null) {
            if (finished || !Number.isFinite(threshold)) return;
            const key = keyOf(kind, id, rootKey), sides = noted.get(key);
            if (sides === null) return;
            if (sides === undefined) { noted.set(key, [threshold]); return; }
            if (sides.includes(threshold)) return;
            if (sides.length >= QUANTITY_THRESHOLDS) noted.set(key, null);
            else sides.push(threshold);
        },
        // A read of the row that notes no threshold: the row stays exact.
        untracked(kind, id, rootKey = null) { if (!finished) noted.set(keyOf(kind, id, rootKey), null); },
        // The packed proof (eachQuantityRow reads it) or null.
        // own: the leaf's { rootKey, itemId } (splitOwn) or null.
        finish(own = null) {
            if (!finished) {
                if (own && !invalid) splitOwn(own);
                finished = true;
                if (!invalid) packed = packQuantityInputs({ version: 1, rows });
                if (!invalid && !packed) invalid = 'bytes';
                if (!invalid) thresholds = compact();
                // Diagnostics: why a completed build has no quantity proof.
                if (invalid && Diagnostics.active()) Diagnostics.count('context', 'quantity_invalid', invalid);
                seen.clear(); noted.clear(); readers.clear(); rows.length = 0;
            }
            return packed;
        },
        // The noted thresholds of the packed rows (compact above) after
        // finish, null before or without a proof.
        thresholds: () => thresholds
    };
}
// Whether every row of the packed proof still answers the same; skip(row)
// true leaves a row out. Rows come from the decoder, so their shape and
// values are already valid; a missing reader is never quiet. A moved
// answer pushes 'quantity' to why; false without it is a stream the
// codec refuses (or a missing reader). stockFor gets the row it answers.
// tolerate(row, index, value, incoming) is handed each moved row (its index
// in the stream, its current comparable value, a stock row also its
// incoming): true keeps it, as if it had not moved.
function quantityInputsHold(packed, readers, normalizeStock = null, skip = null, why = null, tolerate = null) {
    const moved = (row, index, value, incoming) => {
        if (tolerate?.(row, index, value, incoming)) return true;
        why?.push('quantity');
        return false;
    };
    return eachQuantityRow(packed, (row, index) => {
        if (skip?.(row)) return true;
        if (row[0] === 'stock') {
            if (typeof readers?.stockFor !== 'function') return false;
            const stock = readers.stockFor(row[2], row[1], row);
            const owned = nonnegative(stock?.owned), incoming = nonnegative(stock?.incoming);
            const comparable = normalizeStock ? normalizeStock('stock', row[1], row[2], owned, row[3]) : owned;
            return comparable === row[3] && incoming === row[4] || moved(row, index, comparable, incoming);
        }
        if (row[0] === 'stockPhysical') {
            if (typeof readers?.physical !== 'function') return false;
            const owned = nonnegative(readers.physical(row[2]));
            const comparable = normalizeStock ? normalizeStock('stockPhysical', row[1], row[2], owned, row[3]) : owned;
            return comparable === row[3] || moved(row, index, comparable);
        }
        const read = row[0] === 'present' ? readers?.physical : row[0] === 'freePresent' ? readers?.free : readers?.[row[0]];
        if (typeof read !== 'function') return false;
        const raw = read(row[1]);
        if (row[0] === 'incoming' && (!Number.isFinite(Number(raw || 0)) || Number(raw || 0) < 0)) return moved(row, index, NaN);
        const value = nonnegative(raw), comparable = row[0] === 'present' || row[0] === 'freePresent' ? Number(value > 0) : value;
        return comparable === row[2] || moved(row, index, comparable);
    });
}
// Native commands for `batches`: a path without perCommand runs one batch each.
const commands = (batches, perCommand) => Math.ceil(batches / (Number(perCommand) >= 1 ? Number(perCommand) : 1));
// A trip is one row per town: a quoted seller or workshop, or a farm spot
// away from the bot (its hours and fees are paid once, not per unit).
const travels = path => !!path.town && (path.quoted || path.activity === 'hunting');

// The one quantity reader (MVP-3). Accepted incoming is a native obligation:
// it removes the amount to order, not the amount still to deliver.
function remainingQuantity({ required = 0, freePhysical = 0, acceptedIncoming = 0 } = {}) {
    const free = nonnegative(required) - nonnegative(freePhysical);
    return { toOrder: Math.max(0, free - nonnegative(acceptedIncoming)), toExecute: Math.max(0, free) };
}
// Independent identical batches merged by success count: a multiset of k
// outcomes out of B kinds, C(B + k - 1, k). Two kinds give k + 1.
function mergedBranches(kinds, batches) {
    if (kinds <= 1 || batches <= 0) return 1;
    let total = 1;
    for (let at = 1; at <= batches && total <= MAX_BRANCHES; at++) total = total * (kinds - 1 + at) / at;
    return Math.round(total);
}
// MVP-1: money is held only behind a path with a step now (or awaiting a
// native accepted incoming); an unresolved outcome holds none either.
const fundable = wish => wish.supported !== false && wish.resolved !== false;
// The path order's first key (WishNetwork solve): a path that is ever ready
// before a never one (a buy no unit comes for, WishPurchaseEvidence.unitWait).
const readyFirst = (a, b) => Number(a.never === true) - Number(b.never === true);
// The units of `amount` a path's step does not cover now (its availableUnits:
// a town's asks, a workshop's capacity, a crystallize batch; none = all), 0
// when it covers them: the one test of a partial step (the parent's test in
// solve, WishProviders buyWait and sizedBuyFor, componentroute 2026-10-25).
const shortOf = (plan, amount) => Math.max(0, Number(amount) - Number(plan?.availableUnits ?? Infinity)) || 0;
// A root whose chosen plan is never ready (plan.never): the active priority,
// the focus choice and the money queue's gap pass it while another goal can
// be reached; off focus it keeps its whole value (build), so its queue row
// and bid stand whatever the bot's loyalty.
const neverReady = wish => wish.plan?.never === true;
// A craft plan still to learn its recipe, its scroll not held, takes one
// step now: the scroll (TradeIntent.scrollFirst). flow follows only that row.
const scrollStep = plan => TradeIntent.scrollFirst(plan, (plan?.execution || plan)?.requirements || []);
// The cash of that step (its once rows, each with its own trip fees),
// undefined when the root's whole plan is its step or a scroll is still in
// delivery (its row then costs 0 and holds nothing). Set beside the root's
// price (rootWish, allocate) and held with it in the compact queue, which
// keeps no plan to read it from.
const scrollCash = plan => {
    if (!scrollStep(plan)) return undefined;
    const once = (plan.execution || plan).requirements.filter(row => row.once);
    return once.some(row => row.plan?.awaitingIncoming) ? undefined
        : once.reduce((sum, row) => sum + nonnegative(row.plan?.price), 0);
};
// The units an allocated plan claims of what the bot holds, added into
// claims by item id: the whole need on the chosen path of each input it
// holds a part of (requestedAmount: the bag between two stock thresholds
// moves, the need does not; a reader caps it by the bag it reads) and the
// inputs held whole (heldInputs: they leave the requirements). An input it
// holds none of claims nothing: its first unit crosses its prior+1 stock
// threshold, a quantity event. own=false (a stock root): its own consumable
// is no claim (ItemDisposition keeps it, keptAmounts), its inputs are.
// The one answer of "which held items a goal keeps" (heldClaims).
function addHeldClaims(plan, claims, depth = 0, own = true) {
    if (!plan || depth > MAX_DEPTH) return;
    if (own) for (const [id, units] of plan.heldInputs || []) claims.set(id, (claims.get(id) || 0) + units);
    for (const row of plan.requirements || []) {
        const id = String(row.key).startsWith('item:') ? Number(String(row.key).slice(5)) : 0;
        const requested = nonnegative(row.plan?.requestedAmount);
        if (own && id && requested > nonnegative(row.plan?.missingAmount)) claims.set(id, (claims.get(id) || 0) + requested);
        addHeldClaims(row.plan, claims, depth + 1);
    }
}
// A finite sale of the bag (a liquidate money path's `sale` rows: [id, units
// for sale, units in the bag past the clan's, NPC cash per unit]; an item's
// enchant groups are rows of one id) as what it pays and the items it sells:
// of an item only the bag past what this build's goals claim (claims:
// heldClaims, per unit; ItemDisposition.heldAmounts holds claim + clan), so a
// sale never funds a gap with a goal's held inputs.
function bagSale(rows, claims) {
    let cash = 0;
    const items = [], left = new Map();
    for (const [id, units, bag, unitCash] of rows || []) {
        if (!left.has(id)) left.set(id, Math.max(0, bag - (claims?.get(id) || 0)));
        const free = Math.min(units, left.get(id));
        if (!(free > 0)) continue;
        left.set(id, left.get(id) - free);
        cash += free * unitCash;
        if (!items.includes(id)) items.push(id);
    }
    return { cash, items };
}
// The claims as [id, units] rows: the activity root's own inputs first, then
// by value (units at the item's belief price), dearest first, so a reader
// keeping only a few (the card) keeps the focused goal's inputs, then the
// ones worth most.
function claimRows(claims, byKey, rootKey, plans) {
    const value = ([id, units]) => units * nonnegative(byKey.get(`item:${id}`)?.price);
    const own = new Map();
    if (rootKey && plans?.has(rootKey)) addHeldClaims(plans.get(rootKey), own, 0, !String(rootKey).startsWith('stock:'));
    return [...claims].sort((a, b) => Number(own.has(b[0])) - Number(own.has(a[0])) || value(b) - value(a) || a[0] - b[0]);
}
// Cash the money queue holds for a wish (open item q): a fundable root
// still to learn its recipe holds only its scroll, the one step it can take
// now; its place and ratio stay its whole price. An unsupported root (an
// awaiting gap) keeps its whole charge. A stock root's survival tranche is
// already held by the survival reserve (kitCost), never a second time.
const cashCharge = wish => fundable(wish) && wish.scrollCash !== undefined ? wish.scrollCash
    : Math.max(0, nonnegative(wish.price) - nonnegative(wish.reserved));
// The one reading of the priority a root stands at: the active (top)
// priority of its rows, and an earning root (progressionFunding: craft,
// spoil or crystals for sale) pays for that goal, so it stands at it.
// Root admission (WishProviders) ranks by it, the build keeps only it.
// A never root (neverReady) sets it only when no other root can be reached:
// a weapon no unit comes for never hides the armour the bot can buy now.
const activePriority = rows => {
    const reachable = rows.filter(row => !neverReady(row));
    return Math.max(0, ...(reachable.length ? reachable : rows).map(row => nonnegative(row.progressionPriority)));
};
const standingPriority = (row, active) => row.progressionFunding ? active : nonnegative(row.progressionPriority);
// The one priority order of roots (root admission in WishProviders, free
// stock allocation in build): the priority it stands at, then the needed
// root before the earning roots that fund it, so a producer never takes
// the node budget or the held inputs of the goal it pays for.
const priorityOrder = (a, b, active) => standingPriority(b, active) - standingPriority(a, active)
    || Number(!!a.progressionFunding) - Number(!!b.progressionFunding);
// The one order goals claim held stock in (build's settle, the gear
// admission's shared-stock pass in WishProviders): a root the bot can reach
// before a never root (a buy no unit comes for: the reachable goal keeps
// what the bag holds, never re-buys it), then priorityOrder at `standing`,
// a completion, the goals of `order` in their order (the committed ones, or
// the focus first once a rival outscored the held goal: they count as free
// in a rival's score, the rival pays for them), full value per price, key.
const claimOrder = (standing, completionKey, order) => {
    const rank = wish => { const at = order.indexOf(wish.key); return at < 0 ? order.length : at; };
    return (a, b) => Number(neverReady(a)) - Number(neverReady(b))
        || priorityOrder(a, b, standing)
        || Number(b.key === completionKey) - Number(a.key === completionKey)
        || rank(a) - rank(b)
        || b.fullValueHours / Math.max(1, b.price) - a.fullValueHours / Math.max(1, a.price) || a.key.localeCompare(b.key);
};
// The one pin of a committed goal (committedKeys) in a cut (user 10-25: a
// committed goal survives every cut until the bot finishes or drops it): a
// committed root standing at the priority it competes at goes before every
// other root there, so no rival or deeper tree cuts the goal the bot
// pursues (gear admission in WishProviders, the clan's root cut; the
// review's root cut reads priorityOrder, then committed first). A committed
// root below it keeps its place behind the roots the build keeps; one a cap
// then leaves out stays committed (build `capped`).
const pinned = (node, committed, active) => committed.has(node.key) && standingPriority(node, active) >= active;
// The one worth of a solved wish (a root or an activity leaf): its value
// per hour of effort. The build's focus and activity choice, gear admission
// and the review's root cut (WishProviders) all rank by it.
const score = wish => wish.valueHours / Math.max(1 / 3600, wish.effort);
// The goals the bot is committed to, in the order it holds them: the focus,
// then the progression goals a higher-priority root preempted (the build's
// 'preempted' dormant rows, newest first). The one reading of the saved
// focus/dormant packet: build resumes the first one live at the active
// priority and lets it claim its held inputs first; every goal source
// (WishProviders.committedOf) keeps their roots past its caps while valid,
// so the hold here sees them.
function committedKeys(previous) {
    const keys = [];
    if (previous?.focus?.[0]) keys.push(previous.focus[0]);
    for (const row of previous?.dormant || []) {
        if (Array.isArray(row) && row[1] === 'preempted' && row[0] && !keys.includes(row[0])) keys.push(row[0]);
    }
    return keys;
}

// The one pick of a focus or a step when nothing holds one (user 10-25: no
// roulette): the top score, ties by key, so equal inputs give one answer.
function topScore(rows) {
    let best = null;
    for (const row of rows) if (!best || score(row) > score(best)
        || score(row) === score(best) && row.key < best.key) best = row;
    return best;
}

// A root that turns money into money (a craft, crystals or a farm for sale;
// its object's kind, also under a group's member-prefixed key): its value is
// adena at the hunt rate, so its price stays at the hunt rate too.
const resale = row => row?.object?.kind === 'resale';
// The hours a cash price costs a bot holding `held` adena (user 10-27, T53):
// the part the wallet covers at the held money's price (`heldPrice`, its
// best other use: moneyQueue's savingPrice), never above the price of money
// earned (`huntPrice`, hours per adena: money spent can be earned again);
// the part it lacks at the price of money earned. A bot holding nothing
// pays as before, and more money held never costs more hours. Reader: the
// solver's root effort; cashFor is its inverse.
function cashHours(cash, held, heldPrice, huntPrice) {
    const covered = Math.min(nonnegative(cash), nonnegative(held)), lacking = nonnegative(cash) - covered;
    return covered * Math.min(nonnegative(heldPrice), huntPrice) + (lacking > 0 ? lacking * huntPrice : 0);
}
// The most cash `valueHours` is worth to a bot holding `held` adena: held
// money first at its own price, the rest at the price of money still to
// earn (cashHours' inverse).
function cashFor(valueHours, held, heldPrice, huntPrice) {
    const value = nonnegative(valueHours), rate = Math.min(nonnegative(heldPrice), huntPrice);
    const heldHours = nonnegative(held) * rate;
    if (value <= heldHours && rate > 0) return value / rate;
    return nonnegative(held) + (huntPrice > 0 ? (value - heldHours) / huntPrice : 0);
}
// The money price a queue root's rows turn hours into adena at (TradeIntent
// bids and consent, a clan's hall bid): its own value over the cash it is
// worth with the money held at its queue place (moneyQueue: heldCash) at
// the held price, the rest at the money price. No held money: the money
// price, as before.
const rootMoneyPrice = (network, root) => {
    const moneyPrice = Number(network?.moneyPrice), held = nonnegative(root?.heldCash);
    const value = TradeIntent.rootValue(root || {});
    if (!(held > 0) || !(value > 0) || !(network?.heldPrice >= 0)) return moneyPrice;
    const cash = cashFor(value, held, network.heldPrice, moneyPrice);
    return cash > 0 ? value / cash : moneyPrice;
};
// The queue's rows and order (moneyQueue). A progression root stands at least at its price in hours (the floor): its
// queue place and funding read that raised value. What it passes down to its
// inputs stays its own value (TradeIntent.rootValue, kept as ownValueHours
// when the floor raised it): an input's bid must not climb with the price it
// sets (1459 under a kit C gear root: price -> worth -> bid -> price).
// A queue row passed again (EconomyContext.view reprices funding) floors its
// own value, not the raised one.
function queueRows(wishes, floor) {
    return wishes.filter(wish => wish.valueHours > 0 && wish.price > 0)
        .map(wish => {
            const own = TradeIntent.rootValue(wish);
            const valueHours = wish.progressionPriority > 0 ? Math.max(own, wish.price * floor) : own;
            const row = { ...wish, valueHours, ratio: valueHours / wish.price };
            if (valueHours !== own) row.ownValueHours = own;
            else delete row.ownValueHours;
            return row;
        })
        .sort((a, b) => nonnegative(b.progressionPriority) - nonnegative(a.progressionPriority)
            || b.ratio - a.ratio || a.key.localeCompare(b.key));
}
const ownRatio = row => TradeIntent.rootValue(row) / row.price;
// Money the wallet holds is priced by its best other use (heldPrice: the
// build's savingPrice); only money still to earn (the funding gap, a resale
// root) must beat the hunt rate (`floor`). A spending row is funded when the
// money at its place covers it and its own value per adena beats the held
// price; a progression row or one above the floor whenever covered, as
// before. moneyPrice: the price of the next adena earned (the gap's, at
// least the floor). heldCash: the money held at a row's place (before the
// cutoff, a spending row's), what rootMoneyPrice prices at heldPrice.
// heldMoney false (a clan's purse, the author's: a large purse alone does
// not make a residence worth it) prices every row at the floor, as before.
// savingPrice: the price of the money a bot holds (hours per adena; user
// 10-27, T53, docs/game-decisions.md), its best other use among these roots
// (the build's kept ones, the next stage's too: notBefore roots valued later
// and discounted by the wait). The wallet goes down the queue's order; the
// first root it cannot cover is what it saves for: a gap worth earning (a
// progression root, or above the hunt rate) makes it as dear as money
// earned (max(floor, its ratio)), any other root its own value per adena
// (never a floor-raised one). A root no seller offers yet still holds its
// cash (the bot saves for it); a never root and a resale root below the
// floor hold none. A wallet covering them all has no other use for the
// rest: 0, and each bid stops at its price belief (TradeIntent.rootRows).
function moneyQueue(wishes, wallet, survivalReserve = 0, floor = 0, heldPrice = floor, heldMoney = true) {
    let available = Math.max(0, nonnegative(wallet) - nonnegative(survivalReserve));
    const queue = queueRows(wishes, floor);
    let moneyPrice = nonnegative(floor), cutoffFound = false, gap = null, awaitingKit = null;
    let saving = available, savingPrice = null;
    for (const wish of queue) {
        const earned = wish.progressionPriority > 0 || wish.ratio >= floor, spends = heldMoney && !resale(wish);
        if (savingPrice === null && (earned || spends) && !neverReady(wish)) {
            if (cashCharge(wish) > saving) savingPrice = earned ? Math.max(nonnegative(floor), wish.ratio) : ownRatio(wish);
            else saving -= cashCharge(wish);
        }
        // The money held at its place: what it pays with, or bids with while
        // no seller lets it be funded (rootMoneyPrice).
        wish.heldCash = !cutoffFound && spends ? available : 0;
        // A resale root below the floor is no use of money at all.
        if (!earned && !spends && heldMoney) { wish.funded = false; continue; }
        // An unsupported wish keeps its place and interest, never the money.
        if (!fundable(wish)) {
            wish.funded = false;
            // A never root is no gap: earning more never brings its unit.
            if (wish.progressionPriority > 0 && !awaitingKit && !neverReady(wish)) awaitingKit = wish;
            continue;
        }
        // The first gap holds the marginal price of money. Smaller desires
        // do not spend the money earmarked toward that first missing goal.
        const worth = earned || spends && ownRatio(wish) >= heldPrice;
        wish.funded = !cutoffFound && worth && cashCharge(wish) <= available;
        if (wish.funded) available -= cashCharge(wish);
        else if (!cutoffFound) {
            if (earned) { moneyPrice = Math.max(floor, wish.ratio); gap = wish; }
            cutoffFound = true;
        }
    }
    return { queue, moneyPrice, heldPrice: heldMoney ? Math.min(heldPrice, moneyPrice) : moneyPrice, available, gap: gap || awaitingKit,
        savingPrice: savingPrice ?? 0 };
}
// The build's held-money price (moneyQueue's savingPrice) of `wishes`.
const heldPriceOf = (wishes, wallet, survivalReserve = 0, floor = 0) => moneyQueue(wishes, wallet, survivalReserve, floor, 0).savingPrice;

// Providers supply game effects and available paths, never policy priorities.
// One bounded DAG serves individual characters and group actors alike. The
// caller owns its event input key and the small saved focus/dormant packet.
// Per-actor results are a cache, not state: memory per bot is budgeted
// (design 16.26). They serve the several readers of one decision (a commit,
// a resolve, a hot tick); a bot's next decision rebuilds the cheap layer
// anyway (new adena, exp), while the expensive one is kept per kit
// (ColdCombatProfile.profileFor). So few are held, least recently used out.
// Only the main thread holds them (its group solve and repeated readers hit).
// The cold worker keeps the result in the held plan (EconomyContext cache,
// 2048 plans), so a second per-actor copy there never hit and only cost
// copies and evictions.
const ACTOR_LIMIT = 64;
const RETAIN_ACTORS = isMainThread;
function remember(map, key, value, limit = ACTOR_LIMIT) {
    map.delete(key);
    map.set(key, value);
    if (map.size > limit) map.delete(map.keys().next().value);
    return value;
}
// Compare existing bounded results only; no retained diagnostic digest or bot
// history. The input key is deliberately excluded: publication is not a
// changed decision. This traversal is called only with diagnostics active.
function equalValue(left, right, depth = 0) {
    if (Object.is(left, right)) return true;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
    // Native wish data is bounded by four requirement levels. Opaque custom
    // object metadata must never make diagnostics recurse without a limit.
    if (depth > 16) return false;
    if (left instanceof Map || right instanceof Map) {
        if (!(left instanceof Map && right instanceof Map) || left.size !== right.size) return false;
        for (const [key, value] of left) if (!right.has(key) || !equalValue(value, right.get(key), depth + 1)) return false;
        return true;
    }
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!(Array.isArray(left) && Array.isArray(right)) || left.length !== right.length) return false;
        for (let at = 0; at < left.length; at++) if (!equalValue(left[at], right[at], depth + 1)) return false;
        return true;
    }
    for (const key in left) if (Object.hasOwn(left, key)
        && (!Object.hasOwn(right, key) || !equalValue(left[key], right[key], depth + 1))) return false;
    for (const key in right) if (Object.hasOwn(right, key) && !Object.hasOwn(left, key)) return false;
    return true;
}
function sameResult(before, after) {
    return before.moneyPrice === after.moneyPrice && before.heldPrice === after.heldPrice && before.available === after.available
        && before.hourAdena === after.hourAdena && before.decisionSeq === after.decisionSeq
        && before.activityLeaf === after.activityLeaf && equalValue(before.queue, after.queue)
        && equalValue(before.producers, after.producers)
        && equalValue(before.focus, after.focus) && equalValue(before.dormant, after.dormant)
        && equalValue(before.activity, after.activity) && equalValue(before.demands, after.demands)
        && equalValue(before.plans, after.plans);
}
// One solver per node set. build() and the provider's candidate admission
// use the same path facts, quantity reader and root valuation (MVP-6); its
// scratch maps die with the caller's build.
function createSolver({ nodes, hourAdena = 0, riskWeight = 1, stockFor = null, wallet = 0, survivalReserve = 0,
    heldMoney = true, heldPrice = null, diagnostic = false, detail = false, trace = null }) {
    const byKey = new Map();
    for (const node of nodes) {
        if (typeof node?.key !== 'string' || !node.key || byKey.has(node.key)
            || (node.need && !NEEDS.includes(node.need)) || (node.paths?.length || 0) > MAX_PATHS) {
            throw new TypeError('invalid_wish_node');
        }
        byKey.set(node.key, node);
    }
    const plans = new Map(), ordinaryPlans = new Map(), visiting = new Set(), planAmounts = new Map();
    // A producer root may plan a future purchase before a seller appears.
    // Its source choice cannot overwrite ordinary executable-first item
    // plans. These scratch maps are bounded by the graph and depth limit;
    // only the selected root/child plans survive in the bounded result.
    // Each mode keeps at most MAX_DEPTH + 1 plans per node: a shared input
    // can afford a longer source chain when it is nearer the root.
    const producerPlans = new Map();
    const completionPlans = new Map(), producerCompletionPlans = new Map();
    const adenaToHours = hourAdena > 0 ? 1 / hourAdena : Infinity;
    // One route per member and town for the basket. Scratch descriptions
    // die with this build; plans retain bounded entry indices only. Group
    // members visiting the same town do not share each other's paid trips.
    // A buy priced for an amount (sizedBuy) can name another town: its row
    // is added at its first read.
    const trips = new Map(), tripRows = [];
    const tripOf = path => {
        const key = `${path.tripScope || ''}|${path.town}`;
        let row = trips.get(key);
        if (!row) {
            row = { index: tripRows.length, fees: nonnegative(path.tripFees), hours: nonnegative(path.tripHours) };
            trips.set(key, row); tripRows.push(row);
        }
        return row;
    };
    // sized: node key -> its buys priced for an amount (sizedBuy: the buy and
    // its elsewhere buy, adjacent in the node's paths) -> (n => the buy for n
    // units); the node's unit-mode plan depends on the amount asked.
    const sized = new Map();
    for (const node of nodes) for (const path of node.paths || []) {
        if (travels(path)) tripOf(path);
        const forAmount = path.kind === 'buy' && SIZED_BUYS.get(path);
        if (!forAmount) continue;
        let buys = sized.get(node.key);
        if (!buys) sized.set(node.key, buys = new Map());
        buys.set(path, forAmount);
    }
    const tripValue = (entries, field) => {
        let total = 0;
        for (const index of entries) total += tripRows[index][field];
        return total;
    };
    const tripEffort = entries => {
        const fees = tripValue(entries, 'fees');
        return tripValue(entries, 'hours') + (fees > 0 ? fees * adenaToHours : 0);
    };
    // ownInput: the path's own-input value, or 0 where held units are priced
    // by the allocation instead (no copy of the path per call).
    const priceOf = (path, ownInput = path.ownInputOpportunityValue) => {
        if (!Number.isFinite(adenaToHours)) return nonnegative(path.price)
            + nonnegative(ownInput) + nonnegative(path.actualCashFees) > 0 ? Infinity
            : nonnegative(path.costHours) + nonnegative(path.riskHours) * nonnegative(riskWeight);
        const value = Valuation.opportunity({ moneyPrice: adenaToHours, riskWeight }, [{ probability: 1,
            cashNow: nonnegative(path.price), foregoneBenefitHours: nonnegative(path.costHours),
            ownInputOpportunityValue: nonnegative(ownInput),
            actualCashFees: nonnegative(path.actualCashFees), riskHours: nonnegative(path.riskHours) }]);
        return value.known ? -value.valueHours : Infinity;
    };
    // MVP-2: an attempt is valued until success only when every consumed
    // input has a supported repeatable path; held stock alone is not one.
    const repeatables = new Map();
    const repeatable = key => {
        if (repeatables.has(key)) return repeatables.get(key);
        repeatables.set(key, false);
        const node = byKey.get(key);
        const result = !!node?.paths?.some(path => path.available !== false && path.kind !== 'owned'
            && path.repeatable !== false && path.executable !== false && Number(path.availableUnits ?? Infinity) !== 0
            && (path.grossRequirements || path.requirements || []).every(row => row.once || repeatable(row.key)));
        repeatables.set(key, result);
        return result;
    };
    const solve = (key, depth = 0, requested = 1, allocation = null, planning = false, completionFirst = false) => {
        if (visiting.has(key)) throw new TypeError('cyclic_wish_network');
        const node = byKey.get(key);
        if (!node) throw new TypeError('missing_wish_requirement');
        // A source beyond the budget cannot invalidate a shorter alternative
        // (for example buying D gear instead of crafting its raw materials).
        if (depth > MAX_DEPTH) return null;
        const memo = completionFirst ? planning ? producerCompletionPlans : completionPlans : planning ? producerPlans : ordinaryPlans;
        // A sized node's buy priced for this amount (another town, a dearer
        // ask, short of it) is its own plan; at its one-unit paths it is the
        // node's one plan.
        const priced = sized.get(key), pricedUnits = priced && !allocation;
        let moved = false;
        if (pricedUnits) for (const [buy, forAmount] of priced) if (forAmount(requested) !== buy) moved = true;
        const memoKey = moved ? `${depth}:${key}:${requested}` : `${depth}:${key}`;
        if (!allocation && memo.has(memoKey)) {
            if (diagnostic) Diagnostics.count('network', 'node_hit', 'same_build');
            return memo.get(memoKey);
        }
        visiting.add(key);
        const itemId = key.startsWith('item:') ? Number(key.slice(5)) : 0;
        let amount = requested, ownValue = 0, incomingHeld = 0;
        if (allocation && itemId) {
            const prior = allocation.used.get(itemId) || 0;
            // prior, requested: the counts the owned stock is compared with
            // below (the reader notes them as its thresholds).
            const stock = stockFor(itemId, allocation.rootKey, prior, requested) || {};
            const remaining = remainingQuantity({ required: requested,
                freePhysical: Math.max(0, nonnegative(stock.owned) - prior),
                acceptedIncoming: Math.max(0, nonnegative(stock.incoming) - Math.max(0, prior - nonnegative(stock.owned))) });
            const owned = requested - remaining.toExecute;
            incomingHeld = remaining.toExecute - remaining.toOrder;
            amount = remaining.toOrder;
            // Held units are worth the node's price: the bot's own price
            // belief (PriceBelief.reader), not what a buyer bids now.
            ownValue = owned * nonnegative(node.price);
            // A parent's evaluation lends its claims (shared): the first
            // write copies them, so its other paths start from the same claims.
            if (allocation.shared) { allocation.used = new Map(allocation.used); allocation.shared = false; }
            allocation.used.set(itemId, prior + owned + incomingHeld);
            if (!amount) {
                visiting.delete(key);
                return { kind: 'owned', requestedAmount: requested, missingAmount: 0, awaitingIncoming: incomingHeld > 0,
                    executable: incomingHeld === 0, supported: true, resolved: true, successProbability: 1, branches: 1,
                    requirements: [], tripEntries: [], height: 0,
                    basePrice: 0, price: 0, baseHours: 0, hours: 0, baseEffort: ownValue > 0 ? ownValue * adenaToHours : 0,
                    effort: ownValue > 0 ? ownValue * adenaToHours : 0 };
            }
        }
        // alternativeUse: the most each path claimed, the claims a parent
        // carries on; copied from the claims at the first path that claims more.
        const choices = [];
        let alternativeUse = null;
        const paths = node.paths?.length ? node.paths : [{ kind: 'owned', activity: null,
            price: node.price, costHours: node.costHours, riskHours: node.riskHours }];
        if (diagnostic) Diagnostics.count('network', 'path_request', 'known_input', paths.length);
        // Without stock allocation a path counts one unit, so of a sized node
        // only its buys depend on the amount: the other paths' choices are
        // made once per node and mode ([the buys' place among them, choices])
        // and each amount weighs only its buys against them.
        const restKey = pricedUnits ? `${depth}:${key}:rest` : null;
        const rest = restKey ? memo.get(restKey) : undefined;
        let buyAt = -1;
        const buyChoices = restKey && !rest ? [] : null;
        for (const listed of rest ? priced.keys() : paths) {
            // A buy priced for the units this node still orders (amount:
            // requested without allocation, what is left to order with it).
            const forAmount = priced?.get(listed);
            if (forAmount && buyAt < 0) buyAt = choices.length;
            const path = forAmount ? forAmount(amount) : listed;
            if (path.available === false) {
                if (diagnostic) Diagnostics.count('network', 'path_refused', 'source_unavailable');
                continue;
            }
            const successProbability = Number(path.successProbability ?? 1);
            if (!Number.isFinite(successProbability) || successProbability < 0 || successProbability > 1) {
                if (diagnostic) Diagnostics.count('network', 'path_refused', 'invalid_probability');
                continue;
            }
            const valuation = path.outcomes ? Valuation.opportunity({ moneyPrice: adenaToHours, riskWeight }, path.outcomes) : null;
            if (valuation && !valuation.known) {
                if (diagnostic) Diagnostics.count('network', 'path_refused', 'unknown_outcome');
                continue;
            }
            // A unit of the path: a batch of a craft or crystallize, one item
            // of any other step under stock allocation, one batch of its
            // productCount (a per-unit plan, childBatches below) without it.
            // outputPerUnit: the items one allocated unit makes (inputCap).
            const batched = allocation && (path.kind === 'craft' || path.kind === 'crystallize');
            const outputPerUnit = batched ? Number(path.productCount || 1) : 1;
            const units = batched ? Math.ceil(amount / outputPerUnit) : allocation ? amount : 1;
            if (!Number.isSafeInteger(units) || units <= 0) continue;
            // ARCH-NOTE: PERF path-only facts, once per path (both evaluations read them).
            const unitEffort = allocation ? priceOf(path, 0) : priceOf(path);
            const inputs = allocation ? path.grossRequirements || path.requirements || [] : path.requirements || path.grossRequirements || [];
            const leaf = Array.isArray(inputs) && inputs.length === 0;
            // Forecast the complete output first. A native batch limit only
            // bounds the next command, never the materials or price of the goal.
            const evaluate = (units, command = false) => {
                // ARCH-NOTE: PERF a path without inputs solves no child: it claims no stock, so the
                // claims need no copy and no merge back.
                const local = allocation && !leaf ? { rootKey: allocation.rootKey, used: allocation.used, shared: true } : null;
                let price = nonnegative(path.price) * units, effort = unitEffort * units,
                    available = true, height = 0, awaitingIncoming = !command && incomingHeld > 0;
                // A buy short of its n (WishProviders sizedBuyFor): shortCash,
                // what the units its town lacks add over the step's price
                // (signed, at the no-seller price); shortHours, when all n
                // arrive. Both reach the parent (cash like price, hours the
                // latest input) and only the route sort reads them: price and
                // effort stay the step's (funding, leaves, root value).
                let shortCash = (Number(path.shortPrice) || 0) * units, shortHours = nonnegative(path.shortHours);
                if (allocation && !command && ownValue > 0) effort += ownValue * adenaToHours;
                // A consumer's buy that waits for a unit of its own (waitHours,
                // WishPurchaseEvidence.unitWait: rival takers ahead of it on
                // the town's asks) has no step now and is ready only after
                // the wait. never: nothing comes (Infinity), the path is
                // unresolved and its wait enters no hours; a parent of a never
                // child is never too (readyFirst sorts it last). A producer
                // root plans its future source, its own bids bring it: no wait.
                const waited = path.kind === 'buy' && !planning ? nonnegative(path.waitHours) : 0;
                let never = waited === Infinity;
                let executable = path.executable !== false && !(waited > 0);
                // Own step now: a seller, NPC, recipe, workshop capacity, farm.
                let supported = executable && Number(path.availableUnits ?? Infinity) !== 0, resolved = !never;
                let probability = 1, branches = 1, onceCash = 0, onceEffort = 0, onceHours = 0;
                // MVP-4: elapsed hours until the output is ready, in sequence:
                // own labour, inputs, trips. Waiting for accepted incoming has
                // no native delivery time. ARCH-NOTE: counted as zero.
                // A farm's cost is its net hour (D7); its elapsed time is readyHours.
                let hours = nonnegative(path.readyHours ?? path.costHours) * units + (never ? 0 : waited);
                const trip = travels(path) && tripOf(path);
                const tripEntries = trip ? [trip.index] : [];
                let quoted = !!path.quoted;
                if (valuation) {
                    price = nonnegative(valuation.cashNow);
                    effort = Math.max(0, Number(path.ownBenefitHours || 0) - valuation.valueHours);
                    hours = nonnegative(valuation.cycleHours);
                }
                // Purchases no seller offers yet: a root with a buyer's line
                // bids for them at its price's share (earns): their base
                // effort at belief is no cost it pays, their NPC buy-back in
                // adena (the lowest bid that fills, carried by the path,
                // WishProviders) is: bidFloor, also their cash weight in the
                // line's split (TradeIntent.lineCash).
                const bids = !valuation && path.kind === 'buy' && !supported;
                let bidEffort = bids ? unitEffort * units : 0, onceBid = 0;
                let bidFloor = bids ? nonnegative(path.buyback) * units : 0, onceFloor = 0, onceShort = 0;
                const requirements = [];
                // Exact once-per-path inputs (a recipe scroll) are paid once,
                // never per attempt; consumed inputs of one attempt are the rest.
                const untilSuccess = !planning && path.kind === 'craft' && successProbability > 0 && successProbability < 1
                    && (path.grossRequirements || path.requirements || []).every(row => row.once || repeatable(row.key));
                // The step's own repeated cash (a workshop fee), before its inputs add theirs.
                let stepCash = price;
                // Stock allocation: the inputs the bot holds whole leave the
                // requirements; their held units stay on the path (heldClaims).
                let heldInputs = null;
                for (const requirement of inputs) {
                    const amount = nonnegative(requirement.amount ?? 1) * (allocation ? requirement.once ? 1 : units : 1);
                    if (!Number.isSafeInteger(amount) || amount <= 0) { available = false; break; }
                    const child = solve(requirement.key, depth + 1, amount, local, planning, completionFirst);
                    if (!child || !amount) { available = false; break; }
                    // A child's source must hold what it still orders (held
                    // and incoming units are not bought).
                    if (!child.executable || shortOf(child, allocation ? child.missingAmount ?? amount : amount) > 0) executable = false;
                    supported &&= child.supported !== false;
                    resolved &&= child.resolved !== false;
                    never ||= child.never === true;
                    // A per-unit child (no stock allocation) repeats its batch.
                    // One stockless child plan is one batch of its path (E192):
                    // its cost repeats per batch, its chance per native command.
                    const childBatches = allocation ? 1 : Math.ceil(amount / Number(child.productCount || 1));
                    const childDraws = allocation ? 1 : commands(childBatches, child.perCommand);
                    probability *= Number(child.successProbability ?? 1) ** childDraws;
                    branches *= mergedBranches(Number(child.branches || 1), childDraws);
                    const childPrice = child.basePrice * childBatches, childEffort = child.baseEffort * childBatches;
                    const childHours = nonnegative(child.baseHours) * childBatches, childBid = nonnegative(child.bidEffort) * childBatches;
                    const childFloor = nonnegative(child.bidFloor) * childBatches, childShort = (Number(child.shortCash) || 0) * childBatches;
                    if (requirement.once) { onceCash += childPrice; onceEffort += childEffort; onceHours += childHours; onceBid += childBid; onceFloor += childFloor; onceShort += childShort; }
                    else { price += childPrice; effort += childEffort; hours += childHours; bidEffort += childBid; bidFloor += childFloor; shortCash += childShort; }
                    shortHours = Math.max(shortHours, nonnegative(child.shortHours));
                    awaitingIncoming ||= !!child.awaitingIncoming;
                    for (const index of child.tripEntries) if (!tripEntries.includes(index)) tripEntries.push(index);
                    quoted ||= child.quoted;
                    height = Math.max(height, 1 + child.height);
                    if (!allocation || child.missingAmount > 0 || child.awaitingIncoming) {
                        const row = { key: requirement.key, amount: allocation ? child.missingAmount || amount : amount, plan: child };
                        if (requirement.once) row.once = true;
                        requirements.push(row);
                    } else if (requirement.key.startsWith('item:')) (heldInputs ||= []).push([Number(requirement.key.slice(5)), amount]);
                }
                if (untilSuccess) {
                    // ARCH-NOTE: expected attempts 1/p repeat the cash, consumed
                    // inputs and labour of one attempt; the trip is made once.
                    price /= successProbability; effort /= successProbability; hours /= successProbability;
                    bidEffort /= successProbability; bidFloor /= successProbability; stepCash /= successProbability; shortCash /= successProbability;
                } else if (successProbability < 1) {
                    // One native attempt: the parent step runs only when every
                    // child succeeded, so that branch splits into own outcomes.
                    // E190: one draw per native command (D3), not per batch.
                    probability *= successProbability ** commands(units, path.perCommand);
                    branches += mergedBranches(2, commands(units, path.perCommand)) - 1;
                }
                const repeatCash = price;
                price += onceCash; effort += onceEffort; hours += onceHours; bidEffort += onceBid; bidFloor += onceFloor; shortCash += onceShort;
                // inputCap: the most a transformation pays for its inputs, the
                // one rule of every reader (the bids of preparedProject and
                // WishNetwork.flow through TradeIntent.inputValue, this verdict):
                // its output at the item's market price (node.soldPrice, set
                // only for a traded item) less the step's own repeated cash.
                // A step whose inputs cost more has no step now: the bot buys
                // the product (its own buy bids) or waits. Once rows (a recipe
                // scroll) serve later batches too and stay out. Not under a
                // buyer's line (TradeIntent.lineOf): the line prices the inputs.
                // Stock allocation only: its solves are per root, never memoized.
                const inputCap = allocation && itemId && requirements.length && node.soldPrice > 0
                    && !(TradeIntent.lineOf(byKey.get(allocation.rootKey)) > 0)
                    ? units * outputPerUnit * node.soldPrice - stepCash : null;
                if (inputCap !== null && (executable || supported) && repeatCash - stepCash > inputCap) {
                    executable = supported = false;
                    if (diagnostic && !command) Diagnostics.count('network', 'path_unsupported', 'inputs_over_product');
                }
                // E303: counted only where the branch cap itself cuts (not when a child already left the
                // path unresolved, not in the native command pass); no check counter, the denominator is
                // provider:admission:evaluation. The depth cap is counted by provider:admission_pending:evaluation_limit
                // for provider roots; the group path (EconomyContext) depth is not counted.
                const ownCut = resolved && branches > MAX_BRANCHES;
                resolved &&= branches <= MAX_BRANCHES;
                if (ownCut && !command && diagnostic) Diagnostics.count('cap', 'branches', 'cut');
                const basePrice = price, baseEffort = effort, baseHours = hours;
                price += tripValue(tripEntries, 'fees'); effort += tripEffort(tripEntries); hours += tripValue(tripEntries, 'hours');
                // Claims still lent (no child wrote) add nothing to alternativeUse.
                if (available && local && !command && local.used !== allocation.used) {
                    const merged = alternativeUse ||= new Map(allocation.used);
                    local.used.forEach((count, id) => { merged.set(id, Math.max(merged.get(id) || 0, count)); });
                }
                if (available) {
                    // The path's fields, then the plan's, in this order; a
                    // conditional field is set only when present (one literal
                    // per mode: no spread temporaries).
                    const result = allocation ? { ...path, executable, supported, resolved, branches, quoted, tripEntries,
                        successProbability: probability, attemptProbability: successProbability, untilSuccess,
                        requestedAmount: requested, missingAmount: amount, batches: units, awaitingIncoming,
                        basePrice, baseEffort, baseHours, price, effort, hours, requirements, height }
                        : { ...path, executable, supported, resolved, branches, quoted, tripEntries,
                            successProbability: probability, attemptProbability: successProbability, untilSuccess,
                            basePrice, baseEffort, baseHours, price, effort, hours, requirements, height };
                    if (bidEffort > 0 || bidFloor > 0) { result.bidEffort = bidEffort; result.bidFloor = bidFloor; }
                    if (shortCash !== 0) result.shortCash = shortCash;
                    if (shortHours > 0) result.shortHours = shortHours;
                    if (never) result.never = never;
                    if (heldInputs) result.heldInputs = heldInputs;
                    if (inputCap !== null) result.inputCap = inputCap;
                    return result;
                } else if (diagnostic) Diagnostics.count('network', 'path_refused', 'missing_requirement');
                return null;
            };
            const choice = evaluate(units);
            if (!choice) continue;
            if (allocation && path.kind === 'crystallize') {
                const inputs = path.grossRequirements || path.requirements || [];
                const physicalBatches = Math.min(...inputs.map(input => {
                    const id = input.key.startsWith('item:') ? Number(input.key.slice(5)) : 0;
                    const physical = id ? Math.max(0, nonnegative(stockFor(id, allocation.rootKey)?.owned)
                        - (allocation.used.get(id) || 0)) : 0;
                    return input.once ? physical >= Number(input.amount || 1) ? Infinity : 0
                        : Math.floor(physical / Number(input.amount || 1));
                }));
                // Consume held spares now; otherwise prepare one bounded batch.
                // Incoming stock contributes to the forecast, never this test.
                const commandUnits = Math.min(units, Number(path.batchLimit || Infinity), physicalBatches || Infinity);
                if (Number.isSafeInteger(commandUnits) && commandUnits > 0 && commandUnits < units) {
                    choice.execution = evaluate(commandUnits, true);
                    if (choice.execution) choice.execution.availableUnits = Math.min(Number(path.availableUnits ?? Infinity),
                        commandUnits * Number(path.productCount || 1));
                }
            }
            if (forAmount && buyChoices) buyChoices.push(choice);
            choices.push(choice);
        }
        if (rest) choices.splice(0, choices.length, ...rest[1].slice(0, rest[0]), ...choices, ...rest[1].slice(rest[0]));
        else if (restKey) memo.set(restKey, [Math.max(0, buyAt), choices.filter(choice => !buyChoices.includes(choice))]);
        // MVP-1: executable, then supported (saving, preparation, incoming),
        // then effort. A producer root plans its cheapest future source:
        // an unsupported purchase keeps the producer root's queue place and
        // WTB row without cash, never a costlier step now.
        // Cost decides buy against craft (user 2026-10-23), for every grade.
        // In every order a path that is ever ready comes before a never one
        // (readyFirst: a buy no unit comes for, gearstuck).
        // The sort weighs a path by all the units it orders (componentroute
        // 2026-10-25): a buy short of its n, or a path whose input buy is
        // short, costs its shortCash more (routeCash, routeEffort) and is
        // ready when all n arrive (shortHours); the step it takes now keeps
        // its own price for funding and leaves.
        if (choices.length > 1) {
            const routeCash = choice => nonnegative(choice.price + (choice.shortCash || 0));
            const routeEffort = choice => choice.effort + (choice.shortCash && Number.isFinite(adenaToHours) ? choice.shortCash * adenaToHours : 0);
            const completionHours = choice => choice.hours + nonnegative(choice.shortHours) + (adenaToHours > 0
                ? Valuation.fundingDelay({ requiredCash: routeCash(choice), spendableCash: spendable, incomePerHour: hourAdena }) ?? Infinity
                : routeCash(choice) > wallet ? Infinity : 0);
            choices.sort((a, b) => readyFirst(a, b) || (completionFirst
                ? Number(b.supported) - Number(a.supported) || completionHours(a) - completionHours(b) || routeEffort(a) - routeEffort(b)
                : planning
                ? routeEffort(a) - routeEffort(b) || Number(b.supported) - Number(a.supported) || Number(b.executable) - Number(a.executable) || routeCash(a) - routeCash(b)
                : Number(b.executable) - Number(a.executable) || Number(b.supported) - Number(a.supported) || routeEffort(a) - routeEffort(b) || routeCash(a) - routeCash(b)));
        }
        const best = choices[0] || null;
        if (diagnostic) Diagnostics.count('network', 'path_evaluated', 'known_available', choices.length);
        if (detail) for (const choice of choices) Diagnostics.push({ ...trace,
            phase: 'wish_alternative', reason: choice === best ? 'selected_path' : 'evaluated_path',
            wishKey: key, source: choice.sourceType || choice.kind || choice.activity || 'requirement',
            town: choice.town, npcId: choice.npcId, item: choice.itemId,
            recipeId: choice.recipeId, quote: choice.price, tripHours: choice.tripHours,
            tripFees: choice.tripFees, requested: choice.amount });
        if (detail && best?.kind === 'craft') for (const requirement of best.requirements) Diagnostics.push({ ...trace,
            phase: 'craft_requirement', reason: 'selected_recipe_input', source: 'craft_input',
            wishKey: requirement.key, recipeId: best.recipeId, requested: requirement.amount,
            item: requirement.key.startsWith('item:') ? Number(requirement.key.slice(5)) : undefined });
        visiting.delete(key);
        if (allocation) {
            if (alternativeUse) { allocation.used = alternativeUse; allocation.shared = false; }
        } else {
            memo.set(memoKey, best);
            // One plan per item for the readers after the build (TradeIntent,
            // CraftMaterialParty): a sized node keeps the plan of the most
            // units a parent asked, the ask whose town and units bind.
            if (!planning && !(planAmounts.get(key) > requested)) {
                plans.set(key, best);
                if (sized.has(key)) planAmounts.set(key, requested);
            }
        }
        return best;
    };
    // A root that crafts, farms or crystallizes a bounded lot for sale (a
    // shot root's lot is its census remainder). It plans its cheapest future
    // inputs. An input no seller offers yet keeps the root's queue place and
    // becomes its buy ad without cash. The root stays only while its value
    // beats its effort (held inputs at their exit value).
    const farmSale = node => !!node?.paths?.some(path => path.kind === 'farm_sale');
    const finiteProduction = key => {
        const node = byKey.get(key);
        return resale(node) && node.paths?.some(path => ['craft', 'farm_sale', 'crystallize'].includes(path.kind));
    };
    // Whether a root stays (the one test of allocate and build): a producer
    // root only while its value beats its effort. A root with a buyer's line
    // (bidsInputs) pays the inputs nobody sells at least their NPC buy-back,
    // not their belief (user 2026-10-23), the sold ones their ask, so it
    // stays only while the line beats that cost (R3). Its buy ads
    // (TradeIntent.preparedProject) bid every input not bought from an NPC
    // at its share of the line.
    const earns = wish => {
        if (!finiteProduction(wish.key)) return true;
        // A farm_sale root pays its net effort (the plan's), not its rank
        // floor (rootEffort): a farm the spot already pays for costs
        // only its trip.
        const node = byKey.get(wish.key), effort = farmSale(node) ? wish.plan?.effort ?? Infinity : wish.effort;
        const plan = TradeIntent.lineOf(node) > 0 ? wish.plan : null, floor = nonnegative(plan?.bidFloor);
        return wish.valueHours > effort - nonnegative(plan?.bidEffort) + (floor > 0 ? floor * adenaToHours : 0);
    };
    // A direct production root is itself the craft path. Its finite output
    // quantity must enter allocation, just like an item requirement does;
    // otherwise even an eleven-batch goal requests one batch of inputs.
    const rootAmount = node => node?.object?.kind === 'resale'
        && node.paths?.some(path => path.kind === 'craft' && path.trial === true && path.repeatable === false)
        && Number.isSafeInteger(node.object.amount) && node.object.amount > 0 ? node.object.amount : 1;
    // MVP-4: one horizon H per root; a benefit per hour starts when the
    // path is ready (funding delay at net income, then the path's hours).
    // An unknown delay keeps the interest unresolved: no money, no gap.
    const spendable = Math.max(0, nonnegative(wallet) - nonnegative(survivalReserve));
    // keptHours (a learned recipe's unspent price or later crafts' margin,
    // WishProviders producer roots, CraftProfitPolicy.keptRecipeValue) is
    // capital the bot holds whatever this lot's craft rolls give: credited
    // outside the plan's success chance (a producer root's plan draws once
    // per native command, p^commands, WN solve; the later crafts' success
    // is already in their margin, RecipeProductionIndex.margin). In value()
    // its later sales (keptPerHour over the horizon) start only when the
    // root is ready, as a benefit per hour does (readyBenefit).
    // readyHours: when every root is ready (its funding delay, then its
    // path's hours; Infinity with no plan or no income to fund it).
    // WishProviders' gearStepNets reads a stronger gear row's to cut a lower step's tail.
    const value = (wish, node, plan) => {
        const base = nonnegative(node.valueHours) * (1 - Math.min(1, nonnegative(node.progress)));
        wish.resolved = plan?.resolved !== false;
        wish.waitValueHours = 0;
        // A plan that is never ready (a buy no unit comes for: no step now,
        // unresolved, so no money) keeps the root at its full value, as a
        // root no seller offers: its buy bid stands at that value
        // (TradeIntent.preparedProject), the visible demand that brings a
        // seller or a crafter; a bid filled is the item for this wish.
        if (plan?.never) { wish.readyHours = Infinity; wish.valueHours = fullValue(wish, node); return; }
        const delay = plan ? Valuation.fundingDelay({ requiredCash: wish.price, spendableCash: spendable, incomePerHour: hourAdena }) : null;
        wish.readyHours = delay === null ? Infinity : delay + nonnegative(plan.hours);
        const keptRate = nonnegative(node.keptPerHour);
        const kept = keptRate > 0 && delay !== null ? Valuation.readyBenefit({ valueHours: nonnegative(node.keptHours),
            benefitPerHour: keptRate, delayHours: wish.readyHours }) : nonnegative(node.keptHours);
        if (plan && nonnegative(node.benefitPerHour) > 0) {
            const ready = Valuation.readyBenefit({ valueHours: base, benefitPerHour: node.benefitPerHour,
                horizonHours: node.horizonHours, notBeforeHours: node.notBeforeHours,
                delayHours: delay === null ? null : wish.readyHours });
            if (ready === null) wish.resolved = false;
            else {
                const success = Number(plan.successProbability ?? 1);
                wish.valueHours = ready * success + kept;
                // What waiting until ready costs (TradeIntent.rootRows' bid cap: the time a bid saves).
                wish.waitValueHours = nonnegative(Valuation.readyBenefit({ valueHours: base, benefitPerHour: node.benefitPerHour,
                    horizonHours: node.horizonHours, notBeforeHours: node.notBeforeHours }) - ready) * success;
                return;
            }
        }
        wish.valueHours = plan ? base * Number(plan.successProbability ?? 1) + kept : 0;
    };
    // The author's priority value: full benefit, before its ready delay.
    const fullValue = (wish, node) => wish.plan ? nonnegative(node.valueHours) * (1 - Math.min(1, nonnegative(node.progress)))
        * Number(wish.plan.successProbability ?? 1) + nonnegative(node.keptHours) : 0;
    // The rank effort of a root whose hours are committed: a progression
    // root, or a farm_sale root (its farm hours are hours the bot spends on
    // it even where the spot pays for them, so its score is its value per
    // farm hour). At least its elapsed hours plus the cash it lacks at the
    // hour's adena. The one floor of rootWish and allocate; an activity leaf
    // of such a root takes its root's effort (build).
    const committedHours = node => nonnegative(node?.progressionPriority) > 0 || farmSale(node);
    // A spending root's cash is priced as the bot pays it (cashHours): the
    // part the wallet holds at the held money's price (heldRate: the build's
    // heldPriceOf, priceHeld), the part it lacks at the hunt rate; its effort
    // keeps the rest of its plan. Its path choice stays at the hunt rate (one
    // currency between paths); a resale root keeps its whole price.
    // No price given (a caller outside a build: gear admission, the review's
    // root cut): the author's rule, the cash at the hunt rate and its floor
    // counting only the cash the wallet lacks.
    let heldRate = heldPrice;
    const rootEffort = wish => {
        if (!wish.plan) return;
        const price = nonnegative(wish.plan.price), spends = heldMoney && !resale(wish) && heldRate !== null;
        const cash = cashHours(price, spendable, spends ? heldRate : 0, adenaToHours);
        if (spends && Number.isFinite(adenaToHours)) wish.effort = Math.max(0, wish.effort - price * adenaToHours + cash);
        if (committedHours(byKey.get(wish.key))) wish.effort = Math.max(wish.effort, wish.plan.hours + cash);
    };
    // The held money's price once the build has read it (heldPriceOf): every
    // solved root's effort again from its plan's.
    const priceHeld = (rate, wishes) => {
        heldRate = nonnegative(rate);
        for (const wish of wishes) { wish.effort = wish.plan?.effort ?? Infinity; rootEffort(wish); }
    };
    const rootWish = key => {
        const node = byKey.get(key);
        if (!node || !NEEDS.includes(node.need)) throw new TypeError('invalid_wish_root');
        const plan = solve(key, 0, 1, null, finiteProduction(key), node.progressionPriority > 0);
        plans.set(key, plan);
        const wish = { key, need: node.need, object: node.object, plan, supported: plan?.supported !== false, reserved: nonnegative(node.reserved),
            progressionPriority: nonnegative(node.progressionPriority), progressionFunding: !!node.progressionFunding,
            price: plan ? nonnegative(plan.quoted ? plan.price : node.price ?? plan.price) : Infinity, effort: plan?.effort ?? Infinity,
            scrollCash: scrollCash(plan), ...(node.bidsInputs > 0 ? { bidsInputs: node.bidsInputs } : {}) };
        value(wish, node, plan);
        wish.fullValueHours = fullValue(wish, node);
        rootEffort(wish);
        return wish;
    };
    // Shared stock: re-solve one root against the stock already claimed. The
    // returned claims enter the caller's map only when it keeps the root.
    const allocate = (wish, used) => {
        const allocation = { rootKey: wish.key, used: new Map(used) };
        const plan = solve(wish.key, 0, rootAmount(byKey.get(wish.key)), allocation,
            finiteProduction(wish.key), byKey.get(wish.key).progressionPriority > 0);
        wish.progressionPriority = nonnegative(byKey.get(wish.key).progressionPriority);
        wish.progressionFunding = !!byKey.get(wish.key).progressionFunding;
        wish.plan = plan; wish.price = plan?.price ?? Infinity; wish.scrollCash = scrollCash(plan); wish.effort = plan?.effort ?? Infinity;
        wish.supported = plan?.supported !== false;
        value(wish, byKey.get(wish.key), plan);
        wish.fullValueHours = fullValue(wish, byKey.get(wish.key));
        rootEffort(wish);
        // Shared stock can change the full path's cost. A producer root
        // never funds a route whose effort consumes its entire expected
        // benefit; a rejected producer root claims no stock.
        if (!earns(wish)) wish.valueHours = 0;
        plans.set(wish.key, plan);
        return allocation.used;
    };
    return { byKey, plans, earns, committedHours, tripValue, tripEffort, rootWish, allocate, priceHeld };
}
// MVP-6: roots in the caller's rank order while the union of their reachable
// nodes stays within the bound. A root that does not fit is pending (not
// deleted, not zero cost); the smaller roots after it still proceed.
// label 'solo' (a bot's own review, counted in WishProviders as provider:admission_pending) or 'group' (EconomyContext).
function admitRoots(roots, byKey, { rootLimit = MAX_ROOTS, nodeLimit = MAX_NODES, label = 'solo' } = {}) {
    const kept = new Set(), admitted = [], pending = [];
    for (const key of roots) {
        if (admitted.length >= rootLimit) { pending.push({ key, reason: 'root_limit' }); continue; }
        const reach = new Set();
        const visit = at => {
            if (kept.has(at) || reach.has(at) || !byKey.has(at)) return true;
            reach.add(at);
            if (kept.size + reach.size > nodeLimit) return false;
            for (const path of byKey.get(at).paths || []) {
                for (const row of path.requirements || []) if (!visit(row.key)) return false;
                for (const row of path.grossRequirements || []) if (!visit(row.key)) return false;
            }
            return true;
        };
        if (!visit(key)) { pending.push({ key, reason: 'node_limit' }); continue; }
        for (const at of reach) kept.add(at);
        admitted.push(key);
    }
    if (Diagnostics.active()) {
        // E303: how often the caps cut. The solo dropped counts already exist as provider:admission_pending
        // root_limit/node_limit, so solo counts only checks and cuts; the group path has no other counter.
        let rootDropped = 0, nodeDropped = 0;
        for (const row of pending) row.reason === 'root_limit' ? rootDropped++ : nodeDropped++;
        const group = label === 'group';
        Diagnostics.count('cap', group ? 'roots_group' : 'roots_solo', 'check');
        if (rootDropped) {
            Diagnostics.count('cap', group ? 'roots_group' : 'roots_solo', 'cut');
            if (group) Diagnostics.count('cap', 'roots_group', 'dropped', rootDropped);
        }
        if (nodeDropped) {
            Diagnostics.count('cap', group ? 'nodes_group' : 'nodes_solo', 'cut');
            if (group) Diagnostics.count('cap', 'nodes_group', 'dropped', nodeDropped);
        }
    }
    return { roots: admitted, kept, pending };
}
class WishNetwork {
    constructor() { this.cache = new Map(); }
    forget(actorKey, reason = 'owner_release') {
        if (this.cache.delete(actorKey) && Diagnostics.active()) Diagnostics.count('network', 'eviction', reason);
    }
    clear() {
        if (Diagnostics.active() && this.cache.size) Diagnostics.count('network', 'eviction', 'reset', this.cache.size);
        this.cache.clear();
    }

    // `remembered: false` builds without touching the per-actor cache (a
    // caller that holds the result itself, or a one-off proposal). The worker
    // never retains (RETAIN_ACTORS).
    build({ actorKey, inputKey, characterId, decisionSeq = 0, activityLeaf = 0, nodes, roots, wallet = 0, survivalReserve = 0,
        playedHours = 0, persona = {}, previous = {}, hourAdena = 0, riskWeight = 1, moneyPaths = [], remembered = true,
        caller = 'wish_network', trigger = 'request', stockFor = null, completionKey = null, reconsider = true,
        reconsiderReasons = null, capped = [], heldMoney = true }) {
        const diagnostic = Diagnostics.active();
        if (diagnostic) Diagnostics.count('network', 'request');
        if (typeof actorKey !== 'string' || !actorKey || typeof inputKey !== 'string'
            || !Array.isArray(nodes) || nodes.length > MAX_NODES || !Array.isArray(roots) || roots.length > MAX_ROOTS
            || new Set(roots).size !== roots.length) {
            throw new TypeError('invalid_wish_network_input');
        }
        const individual = Number(characterId) > 0;
        decisionSeq = Math.max(0, Math.trunc(Number(decisionSeq) || 0));
        activityLeaf = Number(activityLeaf) >>> 0;
        const retain = remembered && RETAIN_ACTORS;
        const cached = retain ? this.cache.get(actorKey) : null;
        if (cached?.inputKey === inputKey && cached.decisionSeq === decisionSeq && cached.activityLeaf === activityLeaf
            && cached.completionKey === completionKey && cached.reconsider === reconsider) {
            if (diagnostic) Diagnostics.count('network', 'hit', 'same_inputs');
            return remember(this.cache, actorKey, cached).result;
        }
        const started = diagnostic ? performance.now() : 0;
        const detail = diagnostic && Diagnostics.enabled(characterId);
        const trace = detail ? { owner: Number(characterId), caller, trigger,
            inputHash: fnv1a32(inputKey), decisionSeq, activityLeaf } : null;
        if (diagnostic) Diagnostics.count('network', 'miss', !remembered ? 'uncached_actor' : !retain ? 'held_plan_only' : cached ? 'input_dependency_changed' : 'not_retained');
        const solver = createSolver({ nodes, hourAdena, riskWeight, stockFor, wallet, survivalReserve, heldMoney, diagnostic, detail, trace });
        const { byKey, plans, earns, committedHours, tripValue, tripEffort } = solver;
        const kept = wish => wish.valueHours > 0 && wish.plan && earns(wish);
        let wishes = roots.map(solver.rootWish);
        const floor = hourAdena > 0 ? 1 / hourAdena : 0;
        const committed = committedKeys(previous);
        let heldClaims = null, claimPlans = null, alone = null, claimable = wishes;
        // Wishes whose plan is no longer their alone solve (re-solved on a taken claim).
        const reallocated = new Set();
        if (stockFor) {
            // Existing money priority allocates free stock once. Alternatives of
            // one root evaluate the same baseline and retain the maximum claim.
            // MVP-4: the ready delay follows the cash the allocated path needs,
            // so a root is judged after allocation, as admission judges it; an
            // unquoted market price before it is no reason to drop the root.
            // Paths carry gross inputs, so the stockless pass prices held
            // inputs as purchases. Priority reads each root alone against all
            // free stock; that solve is the allocation while nothing is claimed.
            alone = new Map(wishes.map(wish => [wish, solver.allocate(wish, new Map())]));
            claimable = wishes.filter(wish => wish.plan && wish.fullValueHours > 0);
        }
        // The claim split and the priority filter. `order`: the goals that
        // claim their held inputs before a rival of their priority (they count
        // as free in its score, the rival pays for them): the committed goals,
        // or the focus first once a rival outscored the held goal.
        let live, active, focusWishes;
        const settle = order => {
            wishes = claimable;
            if (stockFor) {
                // A second pass starts from each root's own priority (the
                // filter below rewrote earning roots to the active one).
                for (const wish of wishes) wish.progressionPriority = nonnegative(byKey.get(wish.key).progressionPriority);
                const used = new Map();
                const priority = [...wishes].sort(claimOrder(activePriority(wishes), completionKey, order));
                for (const wish of priority) {
                    // Less free stock off the alone solve's claims only makes its
                    // alternatives dearer, so that solve stands unless a claim is taken.
                    const own = alone.get(wish);
                    let taken = false;
                    for (const id of own.keys()) if (used.has(id)) { taken = true; break; }
                    let claimed = own;
                    if (taken) { claimed = solver.allocate(wish, used); reallocated.add(wish); }
                    else if (reallocated.has(wish)) { claimed = solver.allocate(wish, new Map()); reallocated.delete(wish); }
                    if (wish.valueHours > 0) for (const [id, count] of claimed) used.set(id, count);
                }
                // What the split above gave each live root on its chosen path,
                // before the priority filter below: every goal's held inputs, not
                // only the focused one's (`used` also keeps alternatives' claims).
                heldClaims = new Map(); claimPlans = null;
                for (const wish of wishes) if (wish.valueHours > 0) {
                    addHeldClaims(wish.plan, heldClaims, 0, !wish.key.startsWith('stock:'));
                    (claimPlans ||= new Map()).set(wish.key, wish.plan);
                }
            }
            wishes = wishes.filter(kept);
            // The live goals before the priority filter, with their own priority:
            // a committed progression goal (priority > 0) stays committed while
            // it is live; done or impossible, it leaves the packet.
            live = new Map(wishes.map(wish => [wish.key, nonnegative(wish.progressionPriority)]));
            // Only wishes at the active (top) priority stay: missing gear, shot
            // producer roots (priority 3 with a required gear gap, WishProviders)
            // or survival stock. The earning roots (craft for sale, spoil for
            // sale, crystal exits) pay for that goal, so they always stand beside
            // it at its priority; the money queue and the focus score decide
            // which goes first. A never root above the active priority (it
            // sets it only alone, activePriority) stays beside it: its queue
            // row keeps its bid and its TAKERS wake (moneyQueue, EconomyContext
            // marketWatchRows); it is no focus while a root can be reached.
            active = activePriority(wishes);
            if (active) {
                for (const wish of wishes) wish.progressionPriority = standingPriority(wish, active);
                wishes = wishes.filter(wish => wish.progressionPriority === active
                    || neverReady(wish) && wish.progressionPriority > active);
            }
            const reachable = wishes.some(wish => !neverReady(wish));
            focusWishes = wishes.filter(wish => wish.progressionPriority === active && !(reachable && neverReady(wish)));
        };
        settle(committed);
        // The held money's price over the roots the build keeps (heldPriceOf),
        // before the focus reads their efforts.
        const priceHeld = () => {
            const price = heldMoney ? heldPriceOf(wishes, wallet, survivalReserve, floor) : floor;
            solver.priceHeld(price, wishes);
            return price;
        };
        let heldPrice = priceHeld();
        const loyalty = Math.min(1, nonnegative(persona.traits?.commitment ?? 0.5));
        // Only an event (reconsider: the caller's raised sections or due soft changes)
        // weighs a held choice against the others; an ordinary rebuild keeps it.
        // A held choice survives a reconsideration while no row beats it by the bot's loyalty.
        // Leaf values already carry the off-focus (1 - loyalty) weight; the margin is the same trait.
        const loyal = (choice, rows) => !reconsider || rows.every(row => score(row) <= score(choice) * (1 + loyalty));
        // The held goal: the first committed one live at the active priority
        // (the focus, else a preempted goal the bot resumes).
        // A never root (its buy waits for a unit that never comes: plan.never,
        // WishPurchaseEvidence.unitWait) is out of focusWishes while a goal the
        // bot can reach stands (settle): it keeps its queue place and its bid
        // (TradeIntent.preparedProject reads the queue), never the focus or
        // the funding gap (moneyQueue). Alone, it is the focus.
        const heldKey = committed.find(key => focusWishes.some(wish => wish.key === key));
        const held = heldKey === undefined ? undefined : focusWishes.find(wish => wish.key === heldKey);
        const completing = focusWishes.find(wish => wish.key === completionKey);
        // The held goal stays while loyal; else the top score (no roll).
        const focused = completing || (held && loyal(held, focusWishes) ? held : topScore(focusWishes));
        // A rival that outscored the held goal even paying for its held
        // inputs takes them: the split runs again with the new focus first,
        // so its plan does not buy what the bag already holds.
        if (stockFor && held && !completing && focused && focused !== held) { settle([focused.key, ...committed]); heldPrice = priceHeld(); }
        const resumed = !!held && held === focused && held.key !== previous.focus?.[0];
        const focus = focused ? [focused.key, held === focused && !resumed ? previous.focus[1] : playedHours,
            nonnegative(focused.price)] : null;
        const inputDecisionSeq = decisionSeq, inputActivityLeaf = activityLeaf;
        if (individual && focus?.[0] !== previous.focus?.[0]) { decisionSeq++; activityLeaf = 0; }
        const wasFocus = previous.focus?.[0];
        // A live progression goal pushed below a higher-priority root.
        // A never root set aside for a reachable goal is pushed below too: the
        // bot resumes it once a unit can come (committedKeys).
        // A committed progression root a cap left out (WishProviders `capped`:
        // still valid by its source, no room) is below too, never gone.
        const below = key => live.get(key) > 0 || capped.includes(key);
        const pushedBelow = key => below(key) && !focusWishes.some(wish => wish.key === key);
        // A held goal outscored by more than the loyalty (not a completion) is no longer committed.
        const outscored = held && !completing && focused !== held ? held.key : undefined;
        const rows = (previous.dormant || []).filter(row => Array.isArray(row) && row.length === 6
            && row[0] !== focus?.[0] && row[0] !== wasFocus && (row[1] === 'preempted'
                ? below(row[0]) && row[0] !== outscored
                : !wishes.some(wish => wish.key === row[0])));
        if (wasFocus && wasFocus !== focus?.[0]) rows.unshift([wasFocus, pushedBelow(wasFocus) ? 'preempted' : 'superseded', 0,
            nonnegative(previous.focus[2]), playedHours, loyalty]);
        // Four rows, newest first, the 'preempted' ones before the rest: newer
        // stock or break rows never evict a goal the bot will resume.
        const dormant = [...rows.filter(row => row[1] === 'preempted'), ...rows.filter(row => row[1] !== 'preempted')].slice(0, 4);
        // Diagnostics only: why the focus moved (network:focus).
        if (diagnostic && focus?.[0] !== wasFocus && (resumed || wasFocus)) {
            const holding = () => { const claims = new Map(), plan = claimPlans?.get(wasFocus);
                addHeldClaims(plan, claims, 0, !String(wasFocus).startsWith('stock:')); return claims.size > 0; };
            Diagnostics.count('network', 'focus', resumed ? 'resumed' : pushedBelow(wasFocus) ? 'preempted'
                : !focusWishes.some(wish => wish.key === wasFocus) ? 'gone' : holding() ? 'outscored_holding' : 'outscored');
        }
        // Off focus a root weighs (1 - loyalty); a never root keeps its whole
        // value: unfundable, its row only bids, and a loyalty of 1 must not
        // drop it from the queue (no bid, no SELL/TAKERS wake).
        const weighted = wishes.map(wish => ({ ...wish,
            valueHours: wish.valueHours * (wish === focused || neverReady(wish) ? 1 : 1 - loyalty) }));
        const { queue, moneyPrice, heldPrice: queueHeldPrice, available, gap } = moneyQueue(weighted, wallet, survivalReserve, floor, heldPrice, heldMoney);
        const fundingReason = wish => wish.funded ? 'funded' : wish === gap ? 'first_funding_gap'
            : wish.supported === false ? 'unsupported_path' : wish.resolved === false ? 'unresolved_path'
                : (resale(wish) || !heldMoney) && wish.ratio < floor ? 'below_money_floor'
                    : wish.ratio < floor && TradeIntent.rootValue(wish) / wish.price < heldPrice ? 'below_held_price' : 'priority_held';
        if (diagnostic) for (const wish of queue) {
            Diagnostics.count('network', 'wish_funding', fundingReason(wish));
        }
        if (detail) for (const wish of queue) Diagnostics.push({ ...trace,
            phase: 'wish_funding', reason: fundingReason(wish),
            wishKey: wish.key, item: wish.object?.itemId, requested: wish.object?.amount,
            quote: wish.price, valueHours: wish.valueHours, moneyPrice,
            budget: wish.funded ? cashCharge(wish) : undefined, planned: wish.funded ? wish.object?.amount : undefined,
            reserve: survivalReserve, available, source: wish.plan?.sourceType || wish.plan?.kind,
            recipeId: wish.plan?.recipeId });
        const demands = new Map(), leaves = new Map();
        // learnRecipeId: the recipe a once-only input (its scroll) serves; the
        // shopping leaf carries it so main learns the scroll at purchase. Not
        // under a stock root: shot scrolls are learned by ColdShotEconomyService.
        const flow = (key, value, amount = 1, rootKey = key, prepared = null, learnRecipeId = 0) => {
            const complete = prepared || plans.get(key);
            if (!complete || !value) return;
            const node = byKey.get(key);
            if (!(amount > 0) || stockFor && complete.missingAmount === 0) return;
            demands.set(key, (demands.get(key) || 0) + value / amount);
            const plan = complete.execution || complete;
            const acquired = amount - shortOf(plan, amount), share = complete.execution ? acquired / amount : 1;
            const ready = !['craft', 'luxury_exchange', 'crystallize', 'mammon_unseal'].includes(plan.kind)
                || !plan.awaitingIncoming && !plan.requirements.length;
            if (plan.activity && plan.executable && ready && acquired > 0) {
                const leafKey = `${rootKey}:${key}:${plan.activity}`;
                const leaf = leaves.get(leafKey) || { ...plan, key: leafKey, nodeKey: key, rootKey, activity: plan.activity,
                    ...(learnRecipeId > 0 && plan.activity === 'shopping' && !String(rootKey).startsWith('stock:') ? { recipeId: learnRecipeId } : {}),
                    ...(plan.kind === 'crystallize' ? { improvement: { ...plan.improvement, amount: plan.batches || 1 } } : {}),
                    object: node.object, amount: acquired,
                    price: stockFor ? plan.price * (complete.execution ? 1 : acquired / amount)
                        : plan.basePrice * acquired + tripValue(plan.tripEntries, 'fees'),
                    effort: stockFor ? plan.effort * (complete.execution ? 1 : acquired / amount)
                        : plan.baseEffort * acquired + tripEffort(plan.tripEntries), valueHours: 0 };
                if (committedHours(byKey.get(rootKey))) leaf.effort = wishes.find(wish => wish.key === rootKey)?.effort ?? leaf.effort;
                leaf.valueHours += value * acquired / amount;
                leaves.set(leafKey, leaf);
            }
            if (!plan.requirements.length) return;
            // At most the solve's input ceiling passes down (TradeIntent.inputValue),
            // then the value splits between inputs by the cash each adds (TradeIntent.inputSplit).
            value = TradeIntent.inputValue(value, complete.inputCap, moneyPrice);
            const split = TradeIntent.inputSplit(plan.requirements, !!stockFor);
            const scrollOnly = scrollStep(complete);
            for (const requirement of plan.requirements) if (!scrollOnly || requirement.once) flow(requirement.key,
                value * share * TradeIntent.inputShare(requirement, split), stockFor ? requirement.amount : amount * requirement.amount, rootKey, requirement.plan,
                requirement.once ? Number(plan.recipeId) || 0 : 0);
        };
        for (const wish of weighted) flow(wish.key, TradeIntent.rootValue(wish), 1, wish.key, stockFor ? wish.plan : null);
        // Funding is a path to the first gap, not a second budget or desire.
        const unfunded = gap;
        if (unfunded) for (const path of moneyPaths.slice(0, 3)) {
            const shortfall = Math.max(0, cashCharge(unfunded) - available);
            // A missing seller is not a cash deficit. With its price already
            // covered, earning more cannot advance this acquisition.
            if (!shortfall && byKey.get(unfunded.key)?.personalAcquisition) continue;
            const key = `money:${unfunded.key}:${path.activity}:${path.object || ''}`;
            // A bag can pay part of this gap once. It does not establish an
            // hourly income or promise the entire purchase after more time.
            if (path.repeatable === false) {
                const { sale, ...finite } = path;
                const { cash: capacityCash, items } = bagSale(sale, heldClaims);
                if (finite.available === false || finite.kind !== 'liquidate'
                    || ![capacityCash, finite.cashFees, finite.actionHours].every(Number.isFinite)
                    || capacityCash <= 0 || finite.cashFees < 0 || finite.actionHours < 0) continue;
                const contribution = Math.min(shortfall, Math.max(0, capacityCash - finite.cashFees));
                if (!(contribution > 0)) continue;
                leaves.set(key, { ...finite, capacityCash, items, key, nodeKey: unfunded.key, funding: true,
                    rootKey: unfunded.key, price: 0, shortfall, contribution,
                    effort: path.actionHours + nonnegative(path.riskHours) * nonnegative(riskWeight),
                    valueHours: Math.min(unfunded.valueHours, moneyPrice * contribution) });
                continue;
            }
            const income = nonnegative(path.incomePerHour);
            if (!(income > 0) || path.available === false || path.repeatable === false) continue;
            const effort = Math.max(unfunded.progressionPriority && !fundable(unfunded) ? 1 / 60 : 0, shortfall / income) + nonnegative(path.costHours)
                + nonnegative(path.riskHours) * nonnegative(riskWeight);
            leaves.set(key, { ...path, key, nodeKey: unfunded.key, funding: true,
                rootKey: unfunded.key, price: 0, effort, valueHours: unfunded.valueHours, shortfall });
        }
        // Only funded wishes with their own money-packet row can be paid by
        // every itemId spend site; the merged tail stays protected but waits.
        const funded = new Set(packetRowWishes(queue.filter(wish => wish.funded)).map(wish => wish.key));
        // A step that spends no money stays available toward an unsupported
        // wish (farming its material); only money waits for a step now.
        // Only a root the bot may focus (focusWishes: the active priority
        // without the never roots while a root can be reached) offers steps:
        // a never craft's free farm input is no step toward a goal that never
        // finishes. The funding gap is such a root (moneyQueue: never is no gap).
        const unfundable = new Set(queue.filter(wish => !fundable(wish)).map(wish => wish.key));
        const candidates = [...leaves.values()].filter(leaf => focusWishes.some(wish => wish.key === leaf.rootKey))
            .filter(leaf => leaf.funding || !queue.some(wish => wish.key === leaf.rootKey)
            || funded.has(leaf.rootKey) || leaf.price === 0 && (leaf.rootKey === unfunded?.key || unfundable.has(leaf.rootKey)));
        // A cheap intermediate material cannot claim the whole upgrade's
        // benefit as an instantaneous income. Use the complete chosen path.
        // The step serves the focus: the focus root's steps when it has one,
        // else every candidate (the top-score root's step wins below).
        const focusSteps = focused ? candidates.filter(leaf => leaf.rootKey === focused.key) : [];
        const steps = focusSteps.length ? focusSteps : candidates;
        const heldLeaf = individual && activityLeaf ? steps.find(leaf => fnv1a32(leaf.key) === activityLeaf) : null;
        const heldActivity = heldLeaf && loyal(heldLeaf, steps) ? heldLeaf : null;
        if (individual && activityLeaf && !heldActivity && decisionSeq === inputDecisionSeq) {
            // A completed, impossible, outscored or off-focus step is a new
            // decision: the sequence moves (the echo the held build checks).
            decisionSeq++; activityLeaf = 0;
        }
        const completion = candidates.find(leaf => leaf.rootKey === completionKey && leaf.kind === 'luxury_exchange');
        const activity = completion || heldActivity || topScore(steps);
        // Every producer root (priced, or all inputs owned and so outside the
        // money queue) is a row the cold craft step walks.
        // A row keeps only what that step reads (WealthCraftDecision.producerStep):
        // a resale root without a chosen exit (crystals, spoil) is not crafted;
        // recipeReady is the root's scrollSource verdict (WishProviders); r is
        // the root's place in the money queue (rootRatio), the ratio the
        // step's cash inputs are funded at: 0 unless the root owns a
        // money-packet row (`funded` above; the merged tail waits).
        // A stock root whose item node crafts the item itself (no workshop) is
        // a row too: its exit is own use [-1, units] (ShotCraftPolicy.exitTuple,
        // the units its node still orders), ready once the recipe is known.
        const producers = [];
        const ratio = wish => funded.has(wish.key) ? rootRatio(queue.find(row => row.key === wish.key)) : 0;
        for (const wish of wishes) {
            if (wish.key.startsWith('resale:') && Array.isArray(wish.plan?.exit)) {
                producers.push({ key: wish.key, amount: wish.object?.amount, recipeId: wish.plan.recipeId, exit: wish.plan.exit,
                    recipeReady: wish.plan.recipeReady === true, r: ratio(wish) });
                continue;
            }
            const need = wish.key.startsWith('stock:') ? wish.plan?.requirements?.[0] : null, craft = need?.plan;
            if (craft?.kind === 'craft' && !craft.workshop && need.amount > 0)
                producers.push({ key: wish.key, amount: need.amount, recipeId: craft.recipeId, exit: [-1, need.amount],
                    recipeReady: !craft.requiresRecipeLearning, r: ratio(wish) });
        }
        // The bot's exits in flight replace the ones its last build committed:
        // the rows it can produce without waiting for money
        // (CommittedExits.exitRows: ready rows the cold craft step may take,
        // the active leaf's root unless the leaf earns its money). Rivals
        // read what it serves. A leaf that buys from a town's asks takes its
        // units there before the buyers who wait (CommittedExits.takerRow).
        if (individual) {
            const exitRows = CommittedExits.exitRows(producers, activity);
            const taker = CommittedExits.takerRow(activity);
            if (taker) exitRows.push(taker);
            CommittedExits.commitBuild(characterId, exitRows);
        }
        const result = { inputKey, queue, producers, moneyPrice, heldPrice: queueHeldPrice, available, gap, hourAdena,
            quantityPrepared: !!stockFor,
            ...(heldClaims ? { heldClaims: claimRows(heldClaims, byKey, activity?.rootKey, claimPlans) } : {}),
            focus, dormant, activity, demands, plans, decisionSeq,
            activityLeaf: individual && activity ? fnv1a32(activity.key) : 0 };
        if (diagnostic) {
            Diagnostics.count('network', 'build');
            const outcome = completion ? 'completion' : heldActivity ? 'held'
                : heldLeaf ? 'outscored' : !inputActivityLeaf ? activity ? 'fresh' : 'none'
                : focus?.[0] !== previous.focus?.[0] ? 'focus_moved' : 'gone';
            Diagnostics.count('network', 'activity', outcome);
            // Which event (the caller's reasons, 'quiet' for none) kept or moved a held choice.
            if (reconsiderReasons && (outcome === 'held' || outcome === 'outscored' || outcome === 'focus_moved'))
                for (const reason of reconsiderReasons) Diagnostics.count('network', 'reconsider', `${reason}:${outcome}`);
            Diagnostics.count('network', cached ? sameResult(cached.result, result) ? 'unchanged' : 'changed' : 'comparison_unavailable');
            Diagnostics.duration('network', performance.now() - started);
        }
        if (detail) Diagnostics.push({ ...trace, decisionSeq: result.decisionSeq, activityLeaf: result.activityLeaf,
            phase: 'wish_activity', reason: heldActivity ? 'held_activity' : activity ? 'selected_activity' : 'no_executable_activity',
            wishKey: activity?.rootKey, source: activity?.sourceType || activity?.kind || activity?.activity,
            item: activity?.itemId, planned: activity?.amount, quote: activity?.price,
            npcId: activity?.npcId, town: activity?.town, recipeId: activity?.recipeId,
            valueHours: activity?.valueHours, available, reserve: survivalReserve });
        if (retain) {
            if (diagnostic && !this.cache.has(actorKey) && this.cache.size >= ACTOR_LIMIT)
                Diagnostics.count('network', 'eviction', 'capacity');
            remember(this.cache, actorKey, { inputKey, completionKey, reconsider, decisionSeq: inputDecisionSeq,
                activityLeaf: inputActivityLeaf, result });
        }
        return result;
    }
}

module.exports = { WishNetwork, committedKeys, createSolver, sizedBuy, endSizedBuys, shortOf, createQuantityInputs, quantityInputsHold, eachQuantityRow, admitRoots, activePriority, priorityOrder, claimOrder, pinned, score, moneyQueue, heldPriceOf, cashHours, cashFor, rootMoneyPrice, remainingQuantity, fundable, cashCharge, remember, MAX_NODES, MAX_PATHS, MAX_ROOTS, MAX_DEPTH, QUANTITY_INPUT_LIMIT, QUANTITY_INPUT_BYTES, QUANTITY_THRESHOLDS, NO_THRESHOLDS };
