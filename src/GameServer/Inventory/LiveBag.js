// A live actor's bag (a player or a hot bot): memory owns it and the database
// follows through CharacterWriteQueue deltas. Rows a database job read or
// wrote for it (a DB trade, a craft, a workshop order, an NPC basket) apply
// in place: each row plus the bag's changes that read missed
// (CharacterWriteQueue.unread), so a shot used or Adena paid while the job ran
// stays, and so does the job's change.
// The cold worker loads callers of this module; the queue (it loads Database)
// and items are needed only where a live bag is.
// lazy: worker the worker must not load Database
const writes = () => invoke('GameServer/Persistence/CharacterWriteQueue');
// lazy: worker loaded with the queue, only where a live bag is
const items = () => invoke('GameServer/Item/Item');

// The bag's item list changed (an item left or came in).
function relist(backpack, list, item) {
    backpack.items = list;
    items().bindInventory(backpack);
    backpack.inventoryRevision = Number(backpack.inventoryRevision || 0) + 1;
    backpack.onInventoryChange?.(item.fetchSelfId());
}

// An item the bag does not hold (a row just inserted that it did not take)
// leaves the list as it is.
function remove(actor, item) {
    const list = actor.backpack.fetchItems();
    if (list.includes(item)) relist(actor.backpack, list.filter(entry => entry !== item), item);
}

// The row's amount as the bag holds it now. marked: the read-marked rows (or
// row) the row came in (Database.markedRows).
function amountOf(actor, row, marked = row) {
    return Number(row.amount) + (writes().unread(actor.fetchId(), marked).get(Number(row.id)) || 0);
}

// One row ({ id, amount }) a database job committed for the bag: the item
// takes the amount plus the bag's changes since, leaves at 0, or (absent,
// with data: the new item's fields, or a function giving them) comes in.
function applyRow(actor, row, marked = row, data = null) {
    if (!row) return;
    const amount = amountOf(actor, row, marked);
    const item = actor.backpack.fetchItems().find(entry => Number(entry.fetchId()) === Number(row.id));
    if (!item) {
        const fields = amount > 0 && (typeof data === 'function' ? data() : data);
        if (!fields) return;
        const added = new (items())(row.id, { ...fields, amount });
        relist(actor.backpack, [...actor.backpack.fetchItems(), added], added);
        return;
    }
    if (amount > 0) item.setAmount(amount);
    else remove(actor, item);
}

function applyAmounts(actor, rows) {
    for (const row of rows || []) applyRow(actor, row, rows);
}

// Equip and slot are the live body's own (an equip queued behind the read
// is newer than the row).
function sameRow(item, row) {
    return Number(item.fetchSelfId()) === Number(row.selfId)
        && Number(item.fetchEnchantLevel?.() || 0) === Number(row.enchant || 0);
}

// All of the actor's rows (amount > 0, as Database.fetchItems reads them).
// An item with an id above the newest at the read was written after it and
// stays as the bag holds it; one at or below it the rows lack was removed.
// Returns the rows as the bag now holds them (a cold life summary reads them):
// the read rows plus the bag's changes, and the items above the mark.
function applyRows(actor, rows) {
    const backpack = actor?.backpack;
    if (!backpack || !Array.isArray(rows)) return rows;
    const missing = writes().unread(actor.fetchId(), rows);
    const held = backpack.fetchItems();
    const byId = new Map(held.map(item => [Number(item.fetchId()), item]));
    const newest = writes().newestAtRead(rows) ?? rows.reduce((max, row) => Math.max(max, Number(row.id)), 0);
    const kept = [], changed = [], fresh = [], merged = [];
    for (const row of rows) {
        const amount = Number(row.amount) + (missing.get(Number(row.id)) || 0);
        if (amount <= 0) continue;
        merged.push(amount === Number(row.amount) ? row : { ...row, amount });
        const item = byId.get(Number(row.id));
        if (item && sameRow(item, row)) {
            kept.push(item);
            if (Number(item.fetchAmount()) !== amount) changed.push([item, amount]);
        } else fresh.push({ ...row, amount });
    }
    for (const [id, item] of byId) {
        if (id <= newest) continue;
        kept.push(item);
        merged.push({ id, selfId: item.fetchSelfId(), amount: item.fetchAmount(), enchant: item.fetchEnchantLevel?.() || 0,
            equipped: item.fetchEquipped?.() ? 1 : 0, slot: item.fetchSlot?.() || 0 });
    }
    const stays = new Set(kept);
    backpack.items = kept;
    items().bindInventory(backpack);
    for (const [item, amount] of changed) item.setAmount(amount);
    for (const row of fresh) backpack.insertItem(Number(row.id), Number(row.selfId), row);
    backpack.inventoryRevision = Number(backpack.inventoryRevision || 0) + 1;
    for (const item of held) if (!stays.has(item)) backpack.onInventoryChange?.(item.fetchSelfId());
    return merged;
}

// A change the actor makes to its own bag (a restock's payment or stock):
// memory first, then the delta to the database.
function add(actor, item, delta) {
    const next = Number(item.fetchAmount()) + Number(delta);
    if (next > 0) {
        item.setAmount(next);
        if (delta) actor.backpack.inventoryRevision = Number(actor.backpack.inventoryRevision || 0) + 1;
    } else remove(actor, item);
    if (actor.session?.persistenceMode !== 'ephemeral') writes().itemDelta(actor.fetchId(), item.fetchId(), delta);
    return Math.max(0, next);
}

module.exports = { amountOf, applyRow, applyAmounts, applyRows, add };
