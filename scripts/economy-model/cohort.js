'use strict';

// The accounts a model run starts from, as plain records the engine reads:
// { id, station, classId, line, level, exp, money, spot, shots: { selfId: count },
//   held: [selfId], worn: { slot: selfId } }; spot is the spot the bot stood
// at in the save (null without one).
//
// fromSave reads a real run's start save read-only (the economy ledger names
// it in inputs.start.db); savedBots is the model's only reader of a save's
// bots (the snapshot's spot hours read it too). A main's line (its final class, the spot table's role) is its class
// when that class is a line; a first-profession main's line is drawn among
// the lines that pass through its class, by the class weights (seeded by its
// id), because the save does not keep the branch a bot will take.
// synthetic builds a cohort from the class weights alone.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const { hash, mulberry } = require('../hunt-tables/common');
const Weights = require('./weights');

// The craft-station crafters of today's world: they hunt nothing and hold the
// money they started with. Both constants copy the ledger's own
// (scripts/economy/ledger-rules.js owns them; a test fails if they differ).
const STATION_ACCOUNT_PREFIX = 'bot_craft_';
const MERCHANT_ACTIVITY = 'merchant';
const ADENA = 57;
// The seeder's starting adena per level (GeneratedColdSeeder: level x 85).
const SEEDER_ADENA_PER_LEVEL = 85;

// class -> the lines whose kit passes through it at some level.
function linesByClass(snapshot) {
    const out = new Map();
    for (const [line, byLevel] of Object.entries(snapshot.hours)) {
        for (const hour of Object.values(byLevel)) {
            if (!out.has(hour.classId)) out.set(hour.classId, new Set());
            out.get(hour.classId).add(line);
        }
    }
    return out;
}

function weightedPick(lines, random) {
    const weights = lines.map(line => Weights.CLASS_WEIGHTS[line] || 0);
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    if (!(total > 0)) return lines[Math.floor(random() * lines.length)];
    let roll = random() * total;
    for (let i = 0; i < lines.length; i++) if ((roll -= weights[i]) < 0) return lines[i];
    return lines[lines.length - 1];
}

// The line of a main of the class: exact when the class is a line, else
// drawn among the lines through it. Null when no line passes through it.
function lineOf(classId, id, snapshot, byClass) {
    if (snapshot.hours[String(classId)]) return { line: String(classId), exact: true };
    const lines = [...(byClass.get(classId) || [])].sort((a, b) => Number(a) - Number(b));
    if (!lines.length) return null;
    return { line: weightedPick(lines, mulberry(hash(`line:${id}`))), exact: false };
}

// A save's bots, read-only: { characterId, accountName, level, exp, activity,
// spotId, classId, station, partyIds } without the merchants (partyIds: the
// member ids of the active background party the bot is in, else null); with
// items, every item row.
function savedBots(file, { items = false } = {}) {
    if (!fs.existsSync(file)) throw new Error(`missing start save ${file}`);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
        const bots = db.prepare(`SELECT b.characterId, b.accountName, b.level, b.exp, b.activity, b.spotId, c.classId
            FROM bot_life_state b JOIN characters c ON c.id = b.characterId ORDER BY b.characterId`).all()
            .filter(bot => bot.activity !== MERCHANT_ACTIVITY)
            .map(bot => ({ ...bot, station: String(bot.accountName || '').startsWith(STATION_ACCOUNT_PREFIX) }));
        const parties = new Map();
        for (const row of db.prepare(`SELECT memberIdsJson FROM bot_background_parties WHERE status = 'active'`).all()) {
            const ids = JSON.parse(row.memberIdsJson || '[]').map(Number);
            for (const id of ids) parties.set(id, ids);
        }
        for (const bot of bots) bot.partyIds = parties.get(bot.characterId) || null;
        return { bots, items: items ? db.prepare('SELECT characterId, selfId, amount, equipped, slot FROM items').all() : [] };
    } finally {
        db.close();
    }
}

// The party a bot starts in, from the save: the start levels of its members
// the save holds as bots and the bot's own place among them; null alone.
function partyOf(bot, levelOf) {
    const ids = (bot.partyIds || []).filter(id => levelOf.has(id));
    return ids.length > 1 ? { levels: ids.map(id => levelOf.get(id)), self: ids.indexOf(bot.characterId) } : null;
}

function fromSave(file, snapshot) {
    const { bots, items } = savedBots(file, { items: true });
    const byOwner = new Map();
    for (const row of items) {
        if (!byOwner.has(row.characterId)) byOwner.set(row.characterId, []);
        byOwner.get(row.characterId).push(row);
    }
    const byClass = linesByClass(snapshot), shotIds = new Set(Object.entries(snapshot.items)
        .filter(([, item]) => item.kind === 'Other.Shot').map(([id]) => Number(id)));
    const accounts = [], counts = { exact: 0, drawn: 0, noLine: 0, stations: 0 };
    const levelOf = new Map(bots.map(bot => [bot.characterId, Number(bot.level)]));
    for (const bot of bots) {
        const station = bot.station;
        const picked = station ? null : lineOf(Number(bot.classId), bot.characterId, snapshot, byClass);
        if (station) counts.stations++;
        else if (!picked) counts.noLine++;
        else counts[picked.exact ? 'exact' : 'drawn']++;
        const own = byOwner.get(bot.characterId) || [], shots = {}, worn = {};
        let money = 0;
        for (const row of own) {
            const selfId = Number(row.selfId), amount = Number(row.amount) || 0;
            if (selfId === ADENA) money += amount;
            else if (shotIds.has(selfId)) shots[selfId] = (shots[selfId] || 0) + amount;
            if (Number(row.equipped) === 1 && row.slot !== null) worn[Number(row.slot)] = selfId;
        }
        accounts.push({ id: bot.characterId, station: station || !picked, classId: Number(bot.classId), line: picked?.line ?? null,
            level: Number(bot.level), exp: Number(bot.exp), money, spot: bot.spotId ? String(bot.spotId) : null, party: partyOf(bot, levelOf), shots, held: [...new Set(own.map(row => Number(row.selfId)))], worn });
    }
    return { accounts, source: file, lines: counts };
}

// count accounts, lines by the class weights, levels uniform in [low, high],
// each fully kitted for its level, no money and no shots.
function synthetic({ count, low, high, seed = 1 }, snapshot) {
    const random = mulberry(hash(`cohort:${seed}`));
    const lines = Object.keys(snapshot.hours).filter(line => Weights.CLASS_WEIGHTS[line] > 0);
    const accounts = [];
    for (let i = 0; i < count; i++) {
        const line = weightedPick(lines, random);
        const level = low + Math.floor(random() * (high - low + 1));
        const kit = snapshot.kits[line]?.[level] || [];
        accounts.push({ id: i + 1, station: false, classId: snapshot.hours[line][level]?.classId ?? Number(line), line, level,
            exp: snapshot.exp[level - 1], money: 0, spot: null, shots: {}, held: kit.map(piece => piece.selfId),
            worn: Object.fromEntries(kit.map(piece => [piece.slot, piece.selfId])) });
    }
    return { accounts, source: `synthetic ${count} accounts, levels ${low}-${high}, class weights`, lines: { exact: 0, drawn: count, noLine: 0, stations: 0 } };
}

// A new world's start level of the bot at an index: copies the unexported
// level rule of GeneratedColdSeeder.profileForIndex (index % 20: 2-3 for two
// in twenty, 4-8 for nine, 8-12 for seven, 13-16 for two).
function seederLevel(index) {
    const roll = index % 20;
    if (roll < 2) return 2 + (index % 2);
    if (roll < 11) return 4 + (index % 5);
    if (roll < 18) return 8 + (index % 5);
    return 13 + (index % 4);
}

// A fresh world: count accounts at the seeder's start levels, lines by the
// class weights, each kitted for its level, with the seeder's level x 85 adena and no shots.
function fresh({ count, seed = 1 }, snapshot) {
    const random = mulberry(hash(`fresh:${seed}`));
    const lines = Object.keys(snapshot.hours).filter(line => Weights.CLASS_WEIGHTS[line] > 0);
    const accounts = [];
    for (let i = 0; i < count; i++) {
        const line = weightedPick(lines, random), level = seederLevel(i), kit = snapshot.kits[line]?.[level] || [];
        accounts.push({ id: i + 1, station: false, classId: snapshot.hours[line][level]?.classId ?? Number(line), line, level,
            exp: snapshot.exp[level - 1], money: level * SEEDER_ADENA_PER_LEVEL, spot: null, shots: {}, held: kit.map(piece => piece.selfId),
            worn: Object.fromEntries(kit.map(piece => [piece.slot, piece.selfId])) });
    }
    return { accounts, source: `fresh ${count} accounts at the seeder's levels, class weights`, lines: { exact: 0, drawn: count, noLine: 0, stations: 0 } };
}

module.exports = { fromSave, savedBots, synthetic, fresh, seederLevel, lineOf, linesByClass, STATION_ACCOUNT_PREFIX, MERCHANT_ACTIVITY };
