const Database = invoke('Database');

const FLUSH_INTERVAL_MS = 750;
const pending = new Map();
// Snapshots are field patches. The latest one per character handed to a
// database write that has not settled yet (restore merges into it).
const queued = new Map();
let timer = null;
let flushing = Promise.resolve();
// A live bag's item writes are deltas (UPDATE amount = amount + ?), so a DB
// trade committed meanwhile is never overwritten. Per character and item:
// the deltas queued and those the database has applied (Database calls
// applied() inside the write). Rows read from the database carry the applied
// sums at their read (markRead), so unread() names the bag's changes missing
// from those rows (LiveBag.applyRows).
const ledger = new Map();
// A settled entry (all its deltas applied) unchanged this long leaves the
// ledger: a read mark lives for one database job's wait, never this long.
const LEDGER_SETTLED_MS = 10 * 60 * 1000;
let ledgerPrunedAt = 0;
const appliedStates = new WeakSet();
const readMarks = new WeakMap();

function stateFor(characterId) {
    const id = Number(characterId || 0);
    if (!id) return null;
    if (!pending.has(id)) pending.set(id, { character: {}, items: {} });
    return pending.get(id);
}

function schedule() {
    if (timer) return;
    timer = setTimeout(() => {
        timer = null;
        flushAll().catch((error) => utils.infoWarn('DB', 'buffered persistence flush failed: %s', error.message));
    }, FLUSH_INTERVAL_MS);
    timer.unref?.();
}

function merge(characterId, fields) {
    const state = stateFor(characterId);
    if (!state) return;
    Object.assign(state.character, fields);
    schedule();
}

function ledgerEntry(characterId, id) {
    if (!ledger.has(characterId)) ledger.set(characterId, new Map());
    const items = ledger.get(characterId);
    if (!items.has(id)) items.set(id, { queued: 0, applied: 0, at: 0 });
    const entry = items.get(id);
    entry.at = Date.now();
    return entry;
}

// At most once a minute, at a flush.
function pruneLedger(now = Date.now()) {
    if (now - ledgerPrunedAt < 60 * 1000) return;
    ledgerPrunedAt = now;
    for (const [characterId, items] of ledger) {
        for (const [id, entry] of items) {
            if (entry.queued === entry.applied && now - entry.at > LEDGER_SETTLED_MS) items.delete(id);
        }
        if (!items.size) ledger.delete(characterId);
    }
}

function withRow(entry, row) {
    if (row) entry.row = row;
    return entry;
}

// row: the item's own fields ({ selfId, name, enchant }): a gain whose row
// a database job removed meanwhile writes the row again (Database).
function queueItemDelta(characterId, id, delta, row = null) {
    const state = stateFor(characterId);
    if (!state || !id || !Number.isFinite(Number(delta))) return;
    const itemId = Number(id);
    const previous = state.items[itemId];
    state.items[itemId] = withRow({ id: itemId, delta: Number(previous?.delta || 0) + Number(delta) }, row || previous?.row);
    ledgerEntry(Number(characterId), itemId).queued += Number(delta);
    schedule();
}

// Database, inside the transaction that wrote the state's item deltas.
function applied(characterId, state) {
    const items = Object.values(state?.items || {});
    if (!items.length || appliedStates.has(state)) return;
    appliedStates.add(state);
    for (const item of items) ledgerEntry(Number(characterId), Number(item.id)).applied += Number(item.delta || 0);
}

// Database, in the synchronous read of a character's item rows. newest: the
// highest item id in the database at the read (a whole-bag read passes it).
function markRead(characterId, rows, newest = null) {
    if (!rows || typeof rows !== 'object') return rows;
    const items = ledger.get(Number(characterId));
    const applied = new Map(), now = Date.now();
    // A marked entry stays (pruneLedger) while its mark may still be merged.
    for (const [id, entry] of items || []) {
        applied.set(id, entry.applied);
        entry.at = now;
    }
    readMarks.set(rows, { applied, newest });
    return rows;
}

// itemId -> the bag's deltas missing from `rows` (a read without a mark:
// those not yet applied).
function unread(characterId, rows) {
    const items = ledger.get(Number(characterId));
    const result = new Map();
    if (!items) return result;
    const mark = rows && typeof rows === 'object' ? readMarks.get(rows) : null;
    for (const [id, entry] of items) {
        const missing = entry.queued - (mark ? (mark.applied.get(id) || 0) : entry.applied);
        if (missing) result.set(id, missing);
    }
    return result;
}

// The highest item id at the read of `rows`: an id above it was inserted
// after the read; null when the read did not record it.
function newestAtRead(rows) {
    return (rows && typeof rows === 'object' ? readMarks.get(rows)?.newest : null) ?? null;
}

function take(characterId) {
    const id = Number(characterId || 0);
    const state = pending.get(id);
    if (!state) return null;
    pending.delete(id);
    return state;
}

function databaseReady() {
    return typeof Database.isReady !== 'function' || Database.isReady();
}

// A failed write puts its snapshots back: under a newer snapshot already
// queued behind it, or into pending (fields merged since then win), where the
// flush timer retries them.
function restore(entries) {
    let requeued = false;
    for (const [id, state] of entries) {
        // Applied inside a transaction that then rolled back.
        if (appliedStates.delete(state)) {
            for (const item of Object.values(state.items || {})) ledgerEntry(Number(id), Number(item.id)).applied -= Number(item.delta || 0);
        }
        const later = queued.get(id);
        const target = later && later !== state ? later : pending.get(id);
        if (!target) {
            pending.set(id, state);
            requeued = true;
            continue;
        }
        target.character = { ...state.character, ...target.character };
        const items = { ...state.items };
        for (const [itemId, item] of Object.entries(target.items)) {
            items[itemId] = withRow({ id: item.id, delta: Number(items[itemId]?.delta || 0) + Number(item.delta || 0) },
                item.row || items[itemId]?.row);
        }
        target.items = items;
        if (target === pending.get(id)) requeued = true;
    }
    if (requeued) schedule();
}

// The returned write rejects when it fails; the shared chain does not, so one
// failure does not block the flushes and dependent work queued after it.
function write(entries, apply) {
    const result = flushing.then(apply)
        .catch((error) => {
            restore(entries);
            throw error;
        })
        .finally(() => {
            for (const [id, state] of entries) {
                if (queued.get(id) === state) queued.delete(id);
            }
        });
    for (const [id, state] of entries) queued.set(id, state);
    flushing = result.catch(() => null);
    return result;
}

function flushCharacter(characterId) {
    if (!databaseReady()) {
        schedule();
        return flushing;
    }
    const id = Number(characterId || 0);
    const state = take(id);
    // The character's snapshot is still being written: wait for it, then
    // write a snapshot it may have put back on failure, before the caller's
    // dependent work (which would otherwise be overwritten by the retry).
    if (!state) return queued.has(id) ? flushing.then(() => flushCharacter(id)) : flushing;
    return write([[id, state]], () => Database.applyBufferedCharacterState(id, state));
}

function flushAll() {
    if (!databaseReady()) {
        schedule();
        return flushing;
    }
    pruneLedger();
    const entries = [...pending.keys()]
        .map((id) => [id, take(id)])
        .filter(([, state]) => state);
    if (!entries.length) return flushing;
    return write(entries, () => Database.applyBufferedCharacterStates(entries));
}

function ledgerSize() {
    let size = 0;
    for (const items of ledger.values()) size += items.size;
    return size;
}

function pendingCount() {
    return pending.size;
}

Database.registerCharacterWriteFlush?.(flushCharacter);
Database.registerItemLedger?.({ applied, markRead });

module.exports = {
    itemDelta: queueItemDelta,
    applied,
    markRead,
    unread,
    newestAtRead,
    experience(characterId, level, exp, sp) { merge(characterId, { level, exp, sp }); },
    location(characterId, coords = {}) { merge(characterId, { locX: coords.locX, locY: coords.locY, locZ: coords.locZ, head: coords.head ?? -1 }); },
    vitals(characterId, hp, maxHp, mp, maxMp) { merge(characterId, { hp, maxHp, mp, maxMp }); },
    karma(characterId, pvp, pk, karma) { merge(characterId, { pvp, pk, karma }); },
    flushCharacter,
    flushAll,
    pendingCount,
    pruneLedger,
    ledgerSize
};
