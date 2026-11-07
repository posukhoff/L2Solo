'use strict';
// Board line claims: a bot that decides a trip for board lines claims what it will buy
// of each, as a C4 buyer tells the seller "taking it, coming" and the seller holds it;
// other bots' purchase decisions read those units as gone (unclaimed: main's
// planPurchase, the worker's purchase preparation, through OfferQuery's countOf). Two
// trips claim: an errand to the seller's town (ColdMarketService.acquire) and a gear
// purchase's town visit (GoalExecutor.beginMarketTravel). A claim lives while its trip
// does in the bot's state, read at every write of it (main's life state publications):
// it ends when the errand leaves the state (bought or refused on arrival, replaced, or
// lapsed: CombinedErrands.pending), the visit completes or is replaced, the bot dies,
// goes near (hot) or is removed. First come wins; a player buys as ever. Main owns the
// claims and publishes them as the 'board_claims' table (one row a line: { key, claims:
// [[ownerId, units, trip]] }, trip: the claiming trip's key); the worker reads the table.
const { isMainThread } = require('node:worker_threads');
const CombinedErrands = require('../Population/CombinedErrandPolicy');
const TableChannel = require('../Population/ColdTableChannel').shared;

const lineKey = line => `${Number(line.recordId)}:${Number(line.lineId)}`;
// A trip's identity: an errand's (its kind and decision time), a visit's (its town and start).
const errandTrip = errand => `${CombinedErrands.key(errand)}@${Number(errand.at)}`;
const visitTrip = visit => `visit:${visit.town}@${Number(visit.startedAt)}`;
// The claiming trips a bot's state holds: its pending errands and its open gear visit;
// none for a dead, near or removed bot.
function heldTrips(state) {
    const trips = new Set();
    if (state?.phase !== 'cold' || state.activity === 'dead') return trips;
    for (const errand of CombinedErrands.pending(state)) trips.add(errandTrip(errand));
    const visit = state.stats?.townVisit;
    if (visit?.reason === 'upgrade_gear' && visit.completed !== true) trips.add(visitTrip(visit));
    return trips;
}

// Main: the rows by line key, and each owner's claiming trips (trip -> line keys).
const rows = new Map(), owners = new Map();
let unsubscribe = null;
// Counted with the situations (taken, released: in flight is the difference).
// lazy: cycle Situations loads the economy modules.
const note = key => invoke('GameServer/Bot/Situations').note(key);
// The worker: the mirrored table (useRows).
let readRows = () => rows;

// The units of a line this buyer may take: its count less other bots' claims (0: gone).
function unclaimed(line, ownerId) {
    const row = readRows().get(lineKey(line));
    let claimed = 0;
    for (const [owner, count] of row?.claims || []) if (owner !== Number(ownerId)) claimed += count;
    return Math.max(0, Number(line.count) - claimed);
}

function publish(key) {
    TableChannel.changed('board_claims', rows.get(key) || { key, removed: true });
}

// A decided trip's board lines (entries { line, count }: the purchase plan's): claimed for
// its owner while the trip lasts.
function claim(ownerId, trip, entries) {
    const id = Number(ownerId);
    const lines = (entries || []).filter(entry => entry?.line?.recordId && Number(entry.count) > 0);
    if (!lines.length) return;
    release(id, trip);
    for (const { line, count } of lines) {
        const key = lineKey(line), row = rows.get(key) || { key, claims: [] };
        rows.set(key, { key, claims: [...row.claims, [id, Number(count), trip]] });
        publish(key);
    }
    if (!owners.has(id)) owners.set(id, new Map());
    owners.get(id).set(trip, lines.map(entry => lineKey(entry.line)));
    note('board:claim:taken');
    // lazy: cycle BotLifeState loads the market modules.
    unsubscribe ||= invoke('GameServer/Bot/Population/BotLifeState').subscribePublications(published);
}
// An errand's lines (ColdMarketService.acquire, its saved state holding the errand).
const claimErrand = (ownerId, errand, entries) => claim(ownerId, errandTrip(errand), entries);
// A gear purchase's visit (travel: the trip's state, its town visit begun): the cheapest
// lines of the item in the visit's town at most the goal's unit price, as many units as
// the goal orders, less what other trips claim (what the bot buys on arrival).
function claimVisit(travel, goal, board) {
    const visit = travel?.stats?.townVisit, id = Number(travel?.characterId), itemId = Number(goal?.target?.itemId);
    const most = Number(goal?.target?.adena), wanted = Math.max(1, Math.ceil(Number(goal?.target?.amount) || 1));
    if (!visit || !(most > 0) || !(itemId > 0) || !heldTrips(travel).has(visitTrip(visit))) return;
    const entries = [];
    let left = wanted;
    for (const line of board.lines(itemId, 1, visit.town)) {
        if (left <= 0 || Number(line.price) > most) break;
        const count = Math.min(left, line.ownerId === id ? 0 : unclaimed(line, id));
        if (count > 0) { entries.push({ line, count }); left -= count; }
    }
    claim(id, visitTrip(visit), entries);
}

function release(ownerId, trip) {
    const held = owners.get(ownerId), keys = held?.get(trip);
    if (!keys) return;
    held.delete(trip);
    if (!held.size) owners.delete(ownerId);
    for (const key of keys) {
        const row = rows.get(key);
        if (!row) continue;
        const claims = row.claims.filter(([owner, , at]) => owner !== ownerId || at !== trip);
        if (claims.length) rows.set(key, { key, claims }); else rows.delete(key);
        publish(key);
    }
    note('board:claim:released');
}

// A claiming bot's state written (state null: removed): the claims of a trip it no
// longer holds end.
function ownerChanged(characterId, state) {
    const id = Number(characterId), held = owners.get(id);
    if (!held) return;
    const live = heldTrips(state);
    for (const trip of [...held.keys()]) if (!live.has(trip)) release(id, trip);
}
function published({ characterId, state, kind }) {
    if (kind === 'reset') { for (const id of [...owners.keys()]) ownerChanged(id, null); return; }
    ownerChanged(characterId, state);
}

if (isMainThread) TableChannel.register('board_claims', { key: row => row.key, allRows: () => [...rows.values()] });

module.exports = { unclaimed, claimErrand, claimVisit, ownerChanged, useRows: reader => { readRows = reader; },
    size: () => ({ lines: rows.size, owners: owners.size, trips: [...owners.values()].reduce((sum, held) => sum + held.size, 0) }) };
