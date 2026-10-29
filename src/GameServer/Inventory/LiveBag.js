// A live actor's bag (a player or a hot bot): memory owns it and the database
// follows through CharacterWriteQueue deltas. Rows a database job read or
// wrote for it (a DB trade, a craft, a workshop order, an NPC basket) apply
// in place: each row plus the bag's changes that read missed
// (CharacterWriteQueue.unread), so a shot used or Adena paid while the job ran
// stays, and so does the job's change. A worn item that leaves the bag (a
// job took it, or the body used it up) comes off its slot here.
// The cold worker loads callers of this module; the queue (it loads Database),
// items and the body's refresh are needed only where a live bag is.
// lazy: worker the worker must not load Database
const writes = () => invoke('GameServer/Persistence/CharacterWriteQueue');
// lazy: worker loaded with the queue, only where a live bag is
const items = () => invoke('GameServer/Item/Item');
// lazy: worker a live body's refresh (main), only where a worn item left
const actors = () => invoke(path.actor);
// lazy: worker a live body's refresh (main), only where a worn item left
const toggles = () => invoke('GameServer/Skills/ToggleSkills');
// lazy: worker a live body's refresh (main), only where a worn item left
const response = () => invoke('GameServer/Network/Response');

// The bag's item list changed (an item left or came in).
function relist(backpack, list, item) {
    backpack.items = list;
    items().bindInventory(backpack);
    backpack.inventoryRevision = Number(backpack.inventoryRevision || 0) + 1;
    backpack.onInventoryChange?.(item.fetchSelfId());
}

// A worn item leaving the bag comes off its slot; worn collects it for
// wornLeft.
function takeOff(backpack, item, worn) {
    if (!item.fetchEquipped?.()) return;
    backpack.unequipPaperdoll(item.fetchSlot());
    item.setEquipped(false);
    worn.push(item);
}

// An item the bag does not hold (a row just inserted that it did not take)
// leaves the list as it is.
function drop(actor, item, worn) {
    const list = actor.backpack.fetchItems();
    if (!list.includes(item)) return;
    takeOff(actor.backpack, item, worn);
    relist(actor.backpack, list.filter(entry => entry !== item), item);
}

// Worn items left the bag: a live body's (a player's or hot bot's bag)
// stats, toggles and look follow once per change (a dead body's at its
// revival). The bag change is done and its delta queued by then: a refresh
// fault is logged, it neither loses the change nor fails the job that made it.
function wornLeft(actor, worn) {
    const session = actor.session, backpack = actor.backpack;
    if (!worn.length || !session || !actor.fetchMaxHp || !backpack.unequipGear || actor.isDead?.()) return;
    try {
        for (const item of worn) {
            backpack.announceUnequipped(session, item);
            // A legacy duplicate worn in the same slot comes off with it (and
            // durably), as at an explicit unequip.
            backpack.unequipGear(session, item.fetchSlot(), { syncToggles: false });
        }
        actors().calculateStats(session, actor);
        toggles().syncEquipment(session, actor);
        session.dataSendToMe?.(response().userInfo(actor));
        session.dataSendToOthers?.(response().charInfo(actor), actor);
    } catch (error) {
        utils.infoWarn('LiveBag', 'worn item refresh failed for character %s: %s', actor.fetchId(), error?.message || error);
    }
}

// The row's amount as the bag holds it now. marked: the read-marked rows (or
// row) the row came in (Database.markedRows).
function amountOf(actor, row, marked = row) {
    return Number(row.amount) + (writes().unread(actor.fetchId(), marked).get(Number(row.id)) || 0);
}

function put(actor, row, marked, worn) {
    if (!row) return;
    const amount = amountOf(actor, row, marked);
    const item = actor.backpack.fetchItems().find(entry => Number(entry.fetchId()) === Number(row.id));
    if (!item) {
        if (amount > 0 && row.selfId) actor.backpack.insertItem(Number(row.id), Number(row.selfId), { ...row, amount });
        return;
    }
    if (amount > 0) item.setAmount(amount);
    else drop(actor, item, worn);
}

// One row ({ id, amount, selfId }) a database job committed for the bag: the
// item takes the amount plus the bag's changes since and leaves at 0, or
// (absent) comes in from the row's selfId and its template
// (Backpack.insertItem). A row the job emptied stays while the bag gained on
// it meanwhile: the gain's delta writes the row again (Database).
function applyRow(actor, row, marked = row) {
    const worn = [];
    put(actor, row, marked, worn);
    wornLeft(actor, worn);
}

function applyAmounts(actor, rows) {
    const worn = [];
    for (const row of rows || []) put(actor, row, rows, worn);
    wornLeft(actor, worn);
}

// Equip and slot are the live body's own (an equip queued behind the read
// is newer than the row).
function sameRow(item, row) {
    return Number(item.fetchSelfId()) === Number(row.selfId)
        && Number(item.fetchEnchantLevel?.() || 0) === Number(row.enchant || 0);
}

function heldRow(item, amount) {
    return { id: Number(item.fetchId()), selfId: item.fetchSelfId(), amount, enchant: item.fetchEnchantLevel?.() || 0,
        equipped: item.fetchEquipped?.() ? 1 : 0, slot: item.fetchSlot?.() || 0 };
}

// All of the actor's rows (amount > 0, as Database.fetchItems reads them).
// An item with an id above the newest at the read was written after it and
// stays as the bag holds it; one at or below it the rows lack was removed
// (it stays with what the bag gained on it since, as in applyRow).
// Returns the rows as the bag now holds them (a cold life summary reads them):
// the read rows plus the bag's changes, and the items above the mark.
function applyRows(actor, rows) {
    const backpack = actor?.backpack;
    if (!backpack || !Array.isArray(rows)) return rows;
    const missing = writes().unread(actor.fetchId(), rows);
    const held = backpack.fetchItems();
    const byId = new Map(held.map(item => [Number(item.fetchId()), item]));
    const newest = writes().newestAtRead(rows) ?? rows.reduce((max, row) => Math.max(max, Number(row.id)), 0);
    const kept = [], changed = [], fresh = [], merged = [], listed = new Set();
    for (const row of rows) {
        listed.add(Number(row.id));
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
        if (listed.has(id)) continue;
        const amount = id > newest ? Number(item.fetchAmount()) : (missing.get(id) || 0);
        if (amount <= 0) continue;
        kept.push(item);
        if (Number(item.fetchAmount()) !== amount) changed.push([item, amount]);
        merged.push(heldRow(item, amount));
    }
    const stays = new Set(kept), present = new Set(fresh.map(row => Number(row.id))), worn = [];
    for (const item of held) {
        if (!stays.has(item) && !present.has(Number(item.fetchId()))) takeOff(backpack, item, worn);
    }
    backpack.items = kept;
    items().bindInventory(backpack);
    for (const [item, amount] of changed) item.setAmount(amount);
    for (const row of fresh) backpack.insertItem(Number(row.id), Number(row.selfId), row);
    backpack.inventoryRevision = Number(backpack.inventoryRevision || 0) + 1;
    for (const item of held) if (!stays.has(item)) backpack.onInventoryChange?.(item.fetchSelfId());
    wornLeft(actor, worn);
    return merged;
}

// A change the actor makes to its own bag (a shot fired, a payment, a
// restock's stock): memory first, then the delta to the database, then the
// body's refresh for worn gear used up. A gain carries the item's fields: its
// row may have to be written again.
function add(actor, item, delta) {
    const next = Number(item.fetchAmount()) + Number(delta);
    // A list only where the item leaves (a shot fired allocates none).
    const worn = next > 0 ? null : [];
    if (worn) drop(actor, item, worn);
    else {
        item.setAmount(next);
        if (delta) actor.backpack.inventoryRevision = Number(actor.backpack.inventoryRevision || 0) + 1;
    }
    if (actor.session?.persistenceMode !== 'ephemeral') {
        if (delta > 0) writes().itemDelta(actor.fetchId(), item.fetchId(), delta,
            { selfId: item.fetchSelfId(), name: item.fetchName?.() || '', enchant: item.fetchEnchantLevel?.() || 0 });
        else writes().itemDelta(actor.fetchId(), item.fetchId(), delta);
    }
    if (worn) wornLeft(actor, worn);
    return Math.max(0, next);
}

module.exports = { amountOf, applyRow, applyAmounts, applyRows, add };
