'use strict';
// Board line claims: a bot that decides a trip for board lines (ColdMarketService.acquire,
// an errand to the seller's town) claims what it will buy of each, as a C4 buyer tells
// the seller "taking it, coming" and the seller holds it; other bots' purchase decisions
// read those units as gone (unclaimed: main's planPurchase, the worker's purchase
// preparation, through OfferQuery's countOf). A claim ends with its errand (bought on
// arrival, refused or lapsed: the errand leaves the bot's state) or the bot's death. First come wins; a player buys as
// ever. Main owns the claims and publishes them as the 'board_claims' table (one row a
// line: { key, claims: [[ownerId, units, errandAt]] }); the worker reads the table.
const { isMainThread } = require('node:worker_threads');
const CombinedErrands = require('../Population/CombinedErrandPolicy');
const TableChannel = require('../Population/ColdTableChannel').shared;

const lineKey = line => `${Number(line.recordId)}:${Number(line.lineId)}`;
// The units of a line other bots' errands claim, as the row reads at timestamp: a claim
// past its errand's life (CombinedErrands.ERRAND_MS) holds nothing.
function claimed(row, ownerId, timestamp) {
    let units = 0;
    for (const [owner, count, at] of row?.claims || []) {
        if (owner !== Number(ownerId) && timestamp - at < CombinedErrands.ERRAND_MS) units += count;
    }
    return units;
}

// Main: the rows by line key, and each owner's claimed lines by its errand.
const rows = new Map(), owners = new Map();
let unsubscribe = null;
// The worker: the mirrored table (useRows).
let readRows = () => rows;

// The units of a line this buyer may take: its count less other bots' claims (0: gone).
function unclaimed(line, ownerId, timestamp = Date.now()) {
    const row = readRows().get(lineKey(line));
    return Math.max(0, Number(line.count) - (row ? claimed(row, ownerId, timestamp) : 0));
}

function publish(key) {
    const row = rows.get(key);
    TableChannel.changed('board_claims', row || { key, removed: true });
}

// A decided errand's board lines (entries { line, count }: the purchase plan's): claimed
// for its owner until the errand ends.
function claim(ownerId, errand, entries, counted = () => {}) {
    const id = Number(ownerId), errandKey = `${CombinedErrands.key(errand)}@${Number(errand.at)}`;
    const lines = (entries || []).filter(entry => entry?.line?.recordId && Number(entry.count) > 0);
    if (!lines.length) return;
    release(id, errandKey);
    for (const { line, count } of lines) {
        const key = lineKey(line), row = rows.get(key) || { key, claims: [] };
        rows.set(key, { key, claims: [...row.claims, [id, Number(count), Number(errand.at)]] });
        publish(key);
    }
    if (!owners.has(id)) owners.set(id, new Map());
    owners.get(id).set(errandKey, { errand, keys: lines.map(entry => lineKey(entry.line)) });
    counted('board:claim:taken');
    // lazy: cycle BotLifeState loads the market modules.
    unsubscribe ||= invoke('GameServer/Bot/Population/BotLifeState').subscribeChanges(state => ownerChanged(state, counted));
}

function release(ownerId, errandKey, counted = () => {}) {
    const held = owners.get(ownerId), entry = held?.get(errandKey);
    if (!entry) return;
    held.delete(errandKey);
    if (!held.size) owners.delete(ownerId);
    for (const key of entry.keys) {
        const row = rows.get(key);
        if (!row) continue;
        const claims = row.claims.filter(([owner, , at]) => owner !== ownerId || at !== Number(entry.errand.at));
        if (claims.length) rows.set(key, { key, claims }); else rows.delete(key);
        publish(key);
    }
    counted('board:claim:released');
}

// A claiming bot's state changed (main's life state): the claims of an errand it no
// longer holds, or of a dead bot, end.
function ownerChanged(state, counted = () => {}) {
    const id = Number(state?.characterId), held = owners.get(id);
    if (!held) return;
    const live = state.activity === 'dead' ? [] : CombinedErrands.pending(state);
    for (const [errandKey, { errand }] of [...held]) {
        if (!live.some(other => CombinedErrands.key(other) === CombinedErrands.key(errand) && Number(other.at) === Number(errand.at))) {
            release(id, errandKey, counted);
        }
    }
}

if (isMainThread) TableChannel.register('board_claims', { key: row => row.key, allRows: () => [...rows.values()] });

module.exports = { unclaimed, claim, ownerChanged, useRows: reader => { readRows = reader; },
    size: () => ({ lines: rows.size, owners: owners.size }) };
