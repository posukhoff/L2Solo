'use strict';
// The one owner of "units rivals' plans in flight already commit to an exit"
// (crowdfloor 2026-10-25). An exit is a buyer's line (record, line) or a
// product's listing in one town. The same owner holds "who takes a unit of
// this town's asks before me" (gearstuck 2026-10-25): a bot whose active
// leaf buys an item from players' asks (kind buy, sourceType afk) holds its
// units on the item in the quote's town (`t:<item>:<town code>`, takerRow),
// read by a buyer sizing its own wait (rivalTakerUnits, WishProviders) and
// by its wake row (DecisionSections TAKERS). Written in the worker only,
// from each bot's wish build (WishNetwork.build: the producer rows {key
// 'resale:<id>', amount, exit} it can produce without waiting for money,
// exitRows, and the leaf's taker row), replaced whole at the bot's next
// build (a dropped plan leaves with it), restored from the bot's held card
// at its first load (ColdSimulationKernel RetainedStateMap.set ->
// ColdEconomyDecision.heldProducers: the card keeps the leaf only, so a
// restored bot commits that leaf's root and taker row until its first
// build) and removed when the bot unloads (RetainedStateMap.delete/clear).
// Exits are read only by producer reads (a bot sizing goods it would make
// or farm), the rivals' units, never the reader's own:
// PriceDecision.bidSale/bidLots and MarketDemand.forecast with their
// `producer` option. A holder selling goods it already has reads no cut.
// Main writes nothing, so its readers see no commitment. Cost: O(producer
// rows + 1) per build, O(1) per read; memory grows with the bots holding a
// producer plan or an ask buy.
const { isMainThread } = require('worker_threads');

// exit key -> { total, owners: Map(botId -> units), item }; a listing is
// held per town (`l:<item>:<town code>`, item: its item id, 0 for a line).
const byExit = new Map();
// itemId -> towns with a committed listing of it: a read of an item nobody
// lists ends before the town lookup.
const listedTowns = new Map();
// botId -> [exit keys] the bot commits to
const byBot = new Map();
const counts = { entries: 0, takers: 0, refused: 0 };

const lineKey = (recordId, lineId) => `b:${Number(recordId)}:${Number(lineId)}`;
const listingKey = (itemId, townCode) => `l:${Number(itemId)}:${Number(townCode)}`;
const takerKey = (itemId, townCode) => `t:${Number(itemId)}:${Number(townCode)}`;
// lazy: cycle ShotCraftPolicy -> PriceDecision -> this file; the owner of a town's code.
const townCode = town => require('./ShotCraftPolicy').townCode(town);
// The exit keys of a producer row's packed exit (ShotCraftPolicy.exitTuple:
// a line [record, line, ...], own use [-1, ...], a listing [-2, town code,
// ...]); own use serves no market demand and commits nothing.
function keysOf(itemId, exit) {
    if (!Array.isArray(exit)) return null;
    if (Number(exit[0]) > 0 && Number(exit[1]) > 0) return [lineKey(exit[0], exit[1])];
    return Number(exit[0]) === -2 && itemId > 0 && Number(exit[1]) > 0
        ? [listingKey(itemId, exit[1])] : null;
}
// The producer rows a bot commits: every row it can produce without
// waiting for money, i.e. each ready row the cold craft step may take
// (recipeReady, WealthCraftDecision.producerStep's gate; canCraft held when
// WishProviders admitted the row) and its active leaf's root unless that
// leaf earns the root's money (funding). WishNetwork.build passes its
// producers and activity; ColdEconomyDecision.heldProducers the card's one
// known row (its leaf's root) and leaf.
function exitRows(producers, leaf) {
    const root = leaf?.rootKey && !leaf.funding ? leaf.rootKey : null;
    return (producers || []).filter(row => row.recipeReady === true || row.key === root);
}
// One (bot, exit) entry; a taker entry (`t:`) is counted apart (stats takers).
const count = (key, step) => {
    if (key[0] === 't') counts.takers += step;
    else counts.entries += step;
};
function remove(botId) {
    botId = Number(botId);
    const keys = byBot.get(botId);
    if (!keys) return;
    byBot.delete(botId);
    for (const key of keys) {
        const exit = byExit.get(key);
        const units = exit?.owners.get(botId);
        if (units === undefined) continue;
        exit.owners.delete(botId);
        exit.total -= units;
        count(key, -1);
        if (exit.owners.size) continue;
        byExit.delete(key);
        if (!exit.item) continue;
        const towns = listedTowns.get(exit.item) - 1;
        if (towns > 0) listedTowns.set(exit.item, towns); else listedTowns.delete(exit.item);
    }
}
// The taker row of an activity leaf (the build's leaf or the held card's,
// both carry kind, itemId, amount, town, sourceType): a buy from players'
// asks in a known town; null for any other leaf. A leaf waiting for money
// (funding) takes nothing yet.
function takerRow(leaf) {
    if (leaf?.kind !== 'buy' || leaf.sourceType !== 'afk' || leaf.funding || !(Number(leaf.itemId) > 0)) return null;
    const code = leaf.town ? townCode(leaf.town) : 0;
    return code > 0 ? { key: `take:${Number(leaf.itemId)}`, amount: leaf.amount, town: code } : null;
}
// A row's exit keys: a taker row's `t:` key, a producer row's exit keys
// (itemId: the producer row's item, 0 for any other row).
function rowKeys(row, itemId) {
    const key = String(row?.key || '');
    if (key.startsWith('take:')) return Number(key.slice(5)) > 0 && Number(row.town) > 0 ? [takerKey(key.slice(5), row.town)] : null;
    return itemId > 0 ? keysOf(itemId, row.exit) : null;
}
// The bot's whole commitment, replacing the one it held: producer rows {key
// 'resale:<itemId>', amount (units), exit (packed tuple)} and its taker row
// {key 'take:<itemId>', amount, town (code)} (takerRow).
function commit(botId, rows) {
    botId = Number(botId);
    remove(botId);
    if (!(botId > 0)) return;
    const keys = [];
    for (const row of rows || []) {
        const itemId = String(row?.key || '').startsWith('resale:') ? Number(row.key.slice(7)) : 0;
        const units = Math.floor(Number(row?.amount) || 0);
        for (const key of (units > 0 && rowKeys(row, itemId)) || []) {
            let exit = byExit.get(key);
            if (!exit) {
                byExit.set(key, exit = { total: 0, owners: new Map(), item: key[0] === 'l' ? itemId : 0 });
                if (exit.item) listedTowns.set(itemId, (listedTowns.get(itemId) || 0) + 1);
            }
            const before = exit.owners.get(botId);
            if (before === undefined) { keys.push(key); count(key, 1); }
            exit.owners.set(botId, (before || 0) + units);
            exit.total += units;
        }
    }
    if (keys.length) byBot.set(botId, keys);
}
// The worker's write from a build (main builds commit nothing: one planning
// copy, in the worker).
function commitBuild(botId, rows) {
    if (!isMainThread) commit(botId, rows);
}
function rivalUnits(key, readerId) {
    const exit = byExit.get(key);
    return exit ? exit.total - (exit.owners.get(Number(readerId)) || 0) : 0;
}
// Units rivals of `readerId` commit to a buyer's line / a product's listing
// in `town` (a town name; null: none, no reader sizes for every town).
const rivalLineUnits = (recordId, lineId, readerId) => rivalUnits(lineKey(recordId, lineId), readerId);
function rivalListingUnits(itemId, town, readerId) {
    if (!town || !listedTowns.has(Number(itemId))) return 0;
    const code = townCode(town);
    return code > 0 ? rivalUnits(listingKey(itemId, code), readerId) : 0;
}
// Units rivals of `readerId` take from the item's asks in the town (its
// code, ShotCraftPolicy.townCode) before the reader: a buyer's wait
// (WishPurchaseEvidence.unitWait) and its wake row (DecisionSections TAKERS).
const rivalTakerUnits = (itemId, code, readerId) => rivalUnits(takerKey(itemId, code), readerId);
// A reader's exit with room before the rivals' units and none after.
function refused() { counts.refused++; }
function clear() { byExit.clear(); byBot.clear(); listedTowns.clear(); counts.entries = 0; counts.takers = 0; }
// Heartbeat: committed (bot, exit) entries now, (bot, ask) taker entries now,
// exits refused for no room since start.
function stats() { return { entries: counts.entries, takers: counts.takers, refused: counts.refused }; }

module.exports = { commit, commitBuild, exitRows, takerRow, remove, clear, rivalLineUnits, rivalListingUnits, rivalTakerUnits, refused, stats };
