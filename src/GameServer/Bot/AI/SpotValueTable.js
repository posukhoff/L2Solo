const fs = require('fs');
const KillRewards = invoke('GameServer/Bot/Population/ColdKillRewards');
const path = require('path');
const ProgressionRates = invoke('GameServer/ProgressionRates');
const Rewards = require('../Economy/SpotRewardExpectation');
const SpotIndex = require('./SpotIndex');
const DiagnosticConfig = require('../Population/PopulationConfig');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');

// The world spot table (market-sim step 3.3(c), N44): what an hour of solo
// hunting on a spot gives a bot of a role and level, with shots or without.
// scripts/generate-spot-table.js measures it offline with the author's cold
// combat and writes data/Bots/spot-table.json; each thread (main and the cold
// worker) loads that file once on first use. A lookup is O(1).
//
// Per spot, role and shots the file keeps one row measured at a reference
// level; per role and spot level band a curve says how each value changes
// with the bot's level over the spot's level. Kills are capped by what the
// spot's monster count allows. Values are at rate x1; the server's rates are
// applied here. Reward amounts/chances come from NPC groups; the measured
// drop-rate response is retained only for physical bag growth.
const DEFAULT_FILE = path.resolve(__dirname, '../../../../data/Bots/spot-table.json');
const REWARD_FILE = path.resolve(__dirname, '../../../../data/Bots/spot-reward-npcs.json');
let offlineSpots = null;

function rewardSpot(spotId) {
    // Main and worker prefer their actual, immutable period catalogs. A
    // standalone lookup has a compact authored spawn catalog, never a World.
    const actual = SpotIndex.spotById(rewardSpots, spotId);
    if (actual) return actual;
    if (!offlineSpots) offlineSpots = new Map(JSON.parse(fs.readFileSync(REWARD_FILE, 'utf8')).rows.map(
        ([id, entries, adenaMin, adenaMax]) => [id, { id, npcEntries: entries.map(([selfId, count]) => ({ selfId, count })),
            rewards: { adenaMin, adenaMax } }]));
    return offlineSpots.get(String(spotId)) || null;
}

let table = null;
let file = DEFAULT_FILE;
const bestRows = new Map();
const incomeRows = new Map();
const incomeBases = new Map();
// Three doubles and one index per cell, a fourth double once a money search ranks the band (its market
// column): at most 9 MiB per thread.
const MAX_INCOME_BASE_CELLS = 262144;
let incomeBaseCells = 0;
// Cache use for the cold worker heartbeat (L104); counted only with developer diagnostics.
// memoEvictions, incomeEvictions, baseEvictions count the oldest-row drops at their caps; resets the
// wholesale clears that dropped rows (catalog, table or rate change).
// marketSums (always counted, at most one per slot per demand table move): spot loot sums (marketLoot);
// marketRanks (always counted): market columns summed with some premium in them (rankedSpotIds).
const stats = { memoHits: 0, memoMisses: 0, memoEvictions: 0, incomeEvictions: 0, baseEvictions: 0, resets: 0,
    bestHits: 0, bestMisses: 0, incomeHits: 0, incomeMisses: 0, spotIdRanks: 0, marketSums: 0, marketRanks: 0 };
function countReset(rows) { DiagnosticConfig.developerDiagnostics && rows && (stats.resets += 1); }
function cachedRows() { return valueMemo.size + bestRows.size + incomeRows.size + incomeBases.size; }
function cacheStats() {
    return { memo: valueMemo.size, best: bestRows.size, income: incomeRows.size, bases: incomeBases.size,
        cells: incomeBaseCells, ...stats };
}
let incomeTable, incomeRates;
const EMPTY_SPOTS = [];
let spotSource = () => EMPTY_SPOTS;
let rewardSpots = EMPTY_SPOTS, rewardSpotCount = 0;
let rewardRevision = 0;
// Moves whenever the table's rows are dropped (spot catalog, rewards, rates, table file): a reader keeping
// values computed from the table keeps them while it holds (FirstPrice).
let tableRevision = 0;
const spoilLevels = new Map();

function useSpots(source) {
    spotSource = typeof source === 'function' ? source : () => source || EMPTY_SPOTS;
}

// rates: the profile the caller has just read (one rate read per call, L75).
function refreshCatalog(rates) {
    const spots = spotSource() || EMPTY_SPOTS;
    const revision = Rewards.revision(rates);
    if (catalogMoved(spots) || revision !== rewardRevision) {
        rewardSpots = spots; rewardSpotCount = spots.length;
        rewardRevision = revision;
        dropRows();
        spoilLevels.clear();
    }
}

function catalogMoved(spots) {
    return spots !== rewardSpots || spots.length !== rewardSpotCount;
}

// The table's computed rows go with the inputs they came from.
function dropRows() {
    tableRevision++;
    countReset(cachedRows());
    clearValueMemo(); bestRows.clear(); incomeRows.clear();
    clearIncomeBases();
}

function roleSpoilLevel(role, level) {
    if (roleName(role) !== 'spoiler') return 0;
    if (!spoilLevels.has(level)) spoilLevels.set(level, KillRewards.spoilLevelOf({ level,
        stats: { classId: roleClass('spoiler', level) } }));
    return spoilLevels.get(level);
}
// value() is a pure function of the table, the rate profile and its four
// arguments; every bot of a role and level asks the same spots. One bounded
// answer per argument set, dropped when the table or the profile changes
// (ProgressionRates keeps one profile object while the rates are equal).
const MAX_VALUE_MEMO = 32768;
const valueMemo = new Map();
// ARCH-NOTE: PERF valueMemo's keys by slot, a ring in insertion order; valueMemoTail is the next
// slot to fill, at the cap the oldest row's, so the drop at the cap reads the oldest key here.
// Asking the Map for its first key walks every slot an earlier drop left empty (4.3 s per 131k
// drops at the cap).
const valueMemoOrder = [];
let valueMemoTail = 0;
function clearValueMemo() { valueMemo.clear(); valueMemoOrder.length = 0; valueMemoTail = 0; }
// The Map holds a key's slot; the row lives at that slot as 12 numbers in a slab and a flag
// byte. A new row drops the key filed at its slot, so a slot holds its key's row while the key
// lives. L104: at the cap (x10, 24k real rows) the memo held 7.0 MB of the cold worker heap
// with object rows, 1.0 MB so, plus the slab's 3 MB outside the JS heap (arrayBuffers). The ring fills
// its slots in order before it wraps, so the slab grows by doubling and a small memo stays small.
// Two more numbers per slot keep its market loot (marketLoot): the premium
// per kill and the demand table's revision it was summed at, plus one (0:
// none yet).
const ROW_NUMBERS = 14;
const NO_ROW = 1, NO_STACKS = 2, NO_REWARDS = 4;
const ADENA = 4, LOOT = 7, SHOTS = 8, POTIONS = 9, MARKET = 12, MARKET_AT = 13;
let memoNumbers = new Float64Array(0), memoFlags = new Uint8Array(0);
function growSlab() {
    const rows = Math.min(MAX_VALUE_MEMO, Math.max(1024, memoFlags.length * 2));
    const numbers = new Float64Array(rows * ROW_NUMBERS), flags = new Uint8Array(rows);
    numbers.set(memoNumbers);
    flags.set(memoFlags);
    memoNumbers = numbers;
    memoFlags = flags;
}
function storeRow(slot, row) {
    if (slot >= memoFlags.length) growSlab();
    memoNumbers[slot * ROW_NUMBERS + MARKET_AT] = 0;
    if (!row) { memoFlags[slot] = NO_ROW; return; }
    const n = memoNumbers, at = slot * ROW_NUMBERS;
    n[at] = row.kills; n[at + 1] = row.deaths; n[at + 2] = row.exp; n[at + 3] = row.sp; n[at + ADENA] = row.adena;
    n[at + 5] = row.dropLoot; n[at + 6] = row.spoilLoot; n[at + LOOT] = row.loot; n[at + SHOTS] = row.shots;
    n[at + POTIONS] = row.potions; n[at + 10] = row.stacks ?? 0; n[at + 11] = row.busyShare;
    memoFlags[slot] = (row.stacks === null ? NO_STACKS : 0) | (row.rewardSource === 'npc_rewards' ? 0 : NO_REWARDS);
}
// A fresh row of computeValue's shape and key order, or null.
function rowAt(slot) {
    const flags = memoFlags[slot];
    if (flags & NO_ROW) return null;
    const n = memoNumbers, at = slot * ROW_NUMBERS;
    return { kills: n[at], deaths: n[at + 1], exp: n[at + 2], sp: n[at + 3], adena: n[at + ADENA], dropLoot: n[at + 5],
        spoilLoot: n[at + 6], loot: n[at + LOOT], rewardSource: flags & NO_REWARDS ? 'unavailable' : 'npc_rewards',
        shots: n[at + SHOTS], potions: n[at + POTIONS], stacks: flags & NO_STACKS ? null : n[at + 10], busyShare: n[at + 11] };
}
let valueMemoTable = null, valueMemoRates = null;
function refreshValueMemo(t, rates) {
    if (t !== valueMemoTable || rates !== valueMemoRates) {
        countReset(valueMemo.size);
        clearValueMemo();
        valueMemoTable = t;
        valueMemoRates = rates;
    }
}
function clearIncomeBases() { incomeBases.clear(); incomeBaseCells = 0; }

// A curve with no value at a gap (no curve spot hunts there) takes the
// nearest higher gap's value, else the nearest lower one.
function filled(values, neutral) {
    const out = values.slice();
    for (let i = 0; i < out.length; i++) {
        if (out[i] !== null) continue;
        let j = i + 1;
        while (j < out.length && values[j] === null) j++;
        if (j < out.length) { out[i] = values[j]; continue; }
        j = i - 1;
        while (j >= 0 && values[j] === null) j--;
        out[i] = j >= 0 ? values[j] : neutral;
    }
    return out;
}

// A role key (T115): a table role, or `${role}#${classId}` for a bot whose
// class is not the one the table measured the role with at its level
// (roleFor): its kills follow its own class's damage (classKills).
function roleName(role) {
    const text = String(role), at = text.indexOf('#');
    return at < 0 ? role : text.slice(0, at);
}
function roleClassOf(role) {
    const text = String(role), at = text.indexOf('#');
    return at < 0 ? 0 : Number(text.slice(at + 1)) || 0;
}
function roleSlot(t, role) {
    return t.roleIndex.get(roleName(role));
}

// The table role key of a bot (BotRoles.tableRoleFor, with its class when the
// table measured the role with another class at its level and the hunt
// tables know both classes' damage).
function roleFor(state = {}) {
    const role = BotRoles.tableRoleFor(state), level = Number(state.level) || 1;
    const classId = BotRoles.roleClassId(state.stats?.classId ?? state.classId ?? null);
    const measured = roleClass(role, level);
    if (!Number.isInteger(classId) || measured === null || classId === measured) return role;
    const rot = rotation();
    return rot.rows[classId] && rot.rows[measured] ? `${role}#${classId}` : role;
}

// The hunt tables' rotation (scripts/hunt-tables, table 4): per class and
// level band the reference kit's damage rate x defence (d1), its rotation
// of skills included.
let rotationTable = null;
function rotation() {
    return rotationTable ||= JSON.parse(fs.readFileSync(path.join(path.dirname(DEFAULT_FILE), 'hunt', 'rotation.json'), 'utf8'));
}
function rotationRate(classId, level) {
    const rot = rotation(), rows = rot.rows[classId];
    if (!rows) return 0;
    const want = Math.floor(level / rot.bandLevels);
    const bands = Object.keys(rows).map(Number);
    const band = bands.reduce((best, b) => Math.abs(b - want) < Math.abs(best - want) ? b : best, bands[0]);
    return Number(rows[band]?.[rot.fields.indexOf('d1')]) || 0;
}
// The kills per hour of a bot of classId on a row measured with the role's
// class: its fight and rest (the rest refills what the fight took) run at
// the measured class's damage rate over its own, the idle time between
// kills stays.
function classKills(t, r, row, curve, refGap, gap, level, classId, measured) {
    const own = rotationRate(classId, level), reference = rotationRate(roleClass(t.roles[r], level), level);
    if (!(own > 0) || !(reference > 0) || !(measured > 0) || t.f.fight < 0) return measured;
    const perKill = 3600 / measured;
    const along = values => values ? ratio(values, t.gaps, refGap, gap) : 1;
    const busy = Math.min(perKill, row[t.f.fight] * along(curve.fight) + row[t.f.rest] * along(curve.rest));
    return 3600 / (busy * reference / own + perKill - busy);
}

// A row's shots state: 0 none, 1 the weapon's shots (true), 2 Blessed
// Spiritshot (the generator's SHOTS; a table before it has no 2).
function shotKey(shots) {
    return shots === 2 ? 2 : shots ? 1 : 0;
}

function load() {
    if (table) return table;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const field = (fields, name) => {
        const index = fields.indexOf(name);
        if (index < 0) throw new Error(`spot table: missing field ${name}`);
        return index;
    };
    const roleIndex = new Map(raw.roles.map((role, index) => [role, index]));
    const spotIndex = new Map(raw.spots.map((spot, index) => [String(spot[0]), index]));
    // A role without any measured curve keeps its rows' values at every gap.
    const neutral = Object.fromEntries(raw.curveFields.map((name) => [name, raw.gaps.map(() => (name === 'deaths' ? 0 : 1))]));
    const maxBand = Math.max(0, ...raw.spots.map((spot) => Math.floor(spot[1] / raw.header.inputs.bandLevels)));
    // curves[role][band]: every band takes its own curve, else the nearest
    // measured band of the role, lower first.
    const curves = raw.roles.map((role) => {
        const measured = raw.curves[role] || {};
        const byBand = new Map(Object.entries(measured).map(([band, curve]) => [Number(band), Object.fromEntries(
            raw.curveFields.map((name) => [name, filled(curve[name], name === 'deaths' ? 0 : 1)]))]));
        const out = [];
        for (let band = 0; band <= maxBand; band++) {
            let curve = null;
            for (let distance = 0; !curve && distance <= maxBand + 1; distance++) {
                curve = byBand.get(band - distance) || byBand.get(band + distance) || null;
            }
            out.push(curve || neutral);
        }
        return out;
    });
    table = {
        header: raw.header,
        roles: raw.roles,
        roleIndex,
        spotIndex,
        spots: raw.spots,
        rows: raw.rows,
        curves,
        gaps: raw.gaps,
        shotsIndex: new Map(raw.shots.map((shots, index) => [shotKey(shots), index])),
        bandLevels: raw.header.inputs.bandLevels,
        maxLevel: raw.header.inputs.maxLevel,
        f: {
            minGap: field(raw.rowFields, 'minGap'), refGap: field(raw.rowFields, 'refGap'), kph: field(raw.rowFields, 'kph'),
            busy: field(raw.rowFields, 'busy'), deaths: field(raw.rowFields, 'deaths'), exp: field(raw.rowFields, 'exp'),
            sp: field(raw.rowFields, 'sp'), adena: field(raw.rowFields, 'adena'), loot: field(raw.rowFields, 'loot'),
            shots: field(raw.rowFields, 'shots'), potions: field(raw.rowFields, 'potions'),
            stacks: raw.rowFields.indexOf('stacks'),
            // The hunt cycle columns (cycle); a table before them has none.
            fight: raw.rowFields.indexOf('fight'), rest: raw.rowFields.indexOf('rest'), taken: raw.rowFields.indexOf('taken'),
            spellTaken: raw.rowFields.indexOf('spellTaken'),
            // Per-mob rows (pull, cap, mix); a table before them counts fights.
            pull: raw.rowFields.indexOf('pull'), cap: raw.rowFields.indexOf('cap'), mix: raw.rowFields.indexOf('mix'),
            // The gate per curve gap (cap and admitted mix); a table before it reads the reference's.
            gate: raw.rowFields.indexOf('gate'),
            hpLost: raw.rowFields.indexOf('hpLost'), mpLost: raw.rowFields.indexOf('mpLost')
        }
    };
    return table;
}

// A curve's value at any gap: linear between the measured gaps, flat beyond.
function at(values, gaps, gap) {
    if (gap <= gaps[0]) return values[0];
    const last = gaps.length - 1;
    if (gap >= gaps[last]) return values[last];
    const step = gaps[1] - gaps[0];
    const index = Math.floor((gap - gaps[0]) / step);
    const share = (gap - gaps[index]) / step;
    return values[index] + (values[index + 1] - values[index]) * share;
}

// Loot does not grow in proportion to the drop rate (a group stops at 100%
// and then drops one item): the spot keeps its loot at drop rate 10 and 50
// over rate x its loot at rate 1; other rates take the log-linear blend.
function lootRateFactor(spot, dropRate) {
    const [, , , , , at10, at50] = spot;
    if (!(dropRate > 1)) return 1;
    if (dropRate <= 10) return 1 + (at10 - 1) * Math.log10(dropRate);
    if (dropRate <= 50) return at10 + (at50 - at10) * Math.log(dropRate / 10) / Math.log(5);
    return at50;
}

const expGapFactor = require('../../Progression/MobExperience').gapFactor;
const NpcIndex = require('../../Item/ItemTemplateIndex');
const DataCache = invoke('GameServer/DataCache');

// What one hour of solo hunting gives: kills, deaths, exp, SP, adena, loot at
// the NPC buy-back, shots and potions used, and the share of the hour spent in
// combat and recovery (the bots' own records count only that share). Null
// when the spot or role is unknown or the bot finds no target it may fight
// alone there at this level.
function value(spotId, role, level, shots = true, rewardOptions = {}) {
    const t = load(), rates = ProgressionRates.profile();
    refreshCatalog(rates);
    refreshValueMemo(t, rates);
    const skill = rewardOptions.spoilSkillLevel ?? roleSpoilLevel(role, level);
    // Callers own the result: a fresh row.
    return rowAt(memoValue(t, rates, spotId, role, level, shots, skill));
}

// What one kill at the spot fetches over the NPC price value()'s loot
// counts, for this role, level and spoil skill: its items at the market's
// demand price (DemandPrice, decisions 10-28; SpotRewardExpectation
// lootPremium), 0 where value() has no row. Kept in value()'s memo slot
// (same key, same drop) with the demand table's revision: summed again only
// when the table moved (a census publication at most), so no bot subscribes
// to an item's price.
function marketLoot(spotId, role, level, shots = true, rewardOptions = {}) {
    // The table first: its build reads the spot table, which may drop the memo.
    const revision = Demand().revision() + 1;
    const t = load(), rates = ProgressionRates.profile();
    refreshCatalog(rates);
    refreshValueMemo(t, rates);
    const skill = rewardOptions.spoilSkillLevel ?? roleSpoilLevel(role, level);
    return slotMarket(t, memoValue(t, rates, spotId, role, level, shots, skill), spotId, role, shots, level, skill, revision);
}
// A memo slot's market loot per kill, summed again when the demand table
// moved. revision: DemandPrice.revision() + 1, read before the slot (its
// build may drop the memo).
function slotMarket(t, slot, spotId, role, shots, level, skill, revision) {
    if (memoFlags[slot] & NO_ROW) return 0;
    const at = slot * ROW_NUMBERS;
    if (memoNumbers[at + MARKET_AT] !== revision) {
        stats.marketSums += 1;
        const row = rowOf(t, spotId, role, shots), s = t.spotIndex.get(String(spotId));
        const mask = gateAt(t, row, Math.min(t.maxLevel, Number(level)) - t.spots[s][1])?.mask ?? ALL_SPECIES;
        memoNumbers[at + MARKET] = Rewards.lootPremium(killSpot(t, row, spotId, mask), Math.min(t.maxLevel, Number(level)),
            Demand().heldPremium, { spoilSkillLevel: skill });
        memoNumbers[at + MARKET_AT] = revision;
    }
    return memoNumbers[at + MARKET];
}
// lazy: cycle DemandPrice -> FirstPrice -> this module
const Demand = () => invoke('GameServer/Bot/Economy/DemandPrice');

// The memo key: one small integer for a known spot, role, an integer level
// and spoil skill (no string per call); any other argument set keeps the
// five-part string. Each part is read as its string, as the string key reads
// it ("5" and 5 share one row), so both forms name the same rows: one Map,
// the same entries and the same oldest-first eviction.
const MEMO_LEVELS = 256, MEMO_SKILLS = 64, MEMO_MAX_KEY = 2 ** 30;
function memoPart(value, limit) {
    if (typeof value === 'number') return Number.isInteger(value) && value >= 0 && value < limit ? value : -1;
    const text = `${value}`, number = Number(text);
    return Number.isInteger(number) && number >= 0 && number < limit && `${number}` === text ? number : -1;
}
function memoKey(t, spotId, role, level, shots, skill) {
    const s = t.spotIndex.get(typeof spotId === 'string' ? spotId : `${spotId}`);
    // A class role key (roleFor) is its own string key: its kills differ from the role's.
    const r = String(role).includes('#') ? undefined : t.roleIndex.get(typeof role === 'string' ? role : `${role}`);
    const l = memoPart(level, MEMO_LEVELS), k = memoPart(skill, MEMO_SKILLS);
    if (s !== undefined && r !== undefined && l >= 0 && k >= 0) {
        const key = (((s * t.roleIndex.size + r) * 3 + shotKey(shots)) * MEMO_LEVELS + l) * MEMO_SKILLS + k;
        if (key < MEMO_MAX_KEY) return key;
    }
    return `${spotId}\u0000${role}\u0000${level}\u0000${shotKey(shots)}\u0000${skill}`;
}
// The slot of the argument set's row; valid until the next memoValue call.
function memoValue(t, rates, spotId, role, level, shots, skill) {
    const key = memoKey(t, spotId, role, level, shots, skill);
    let slot = valueMemo.get(key);
    if (slot === undefined) {
        DiagnosticConfig.developerDiagnostics && (stats.memoMisses += 1);
        const row = computeValue(t, rates, spotId, role, level, shots, skill);
        slot = valueMemoTail;
        valueMemoTail = (valueMemoTail + 1) % MAX_VALUE_MEMO;
        const dropped = valueMemoOrder[slot];
        if (dropped !== undefined && valueMemo.delete(dropped)) DiagnosticConfig.developerDiagnostics && (stats.memoEvictions += 1);
        valueMemoOrder[slot] = key;
        storeRow(slot, row);
        valueMemo.set(key, slot);
    } else DiagnosticConfig.developerDiagnostics && (stats.memoHits += 1);
    return slot;
}

// A role's measured row at a spot (null: none, or the spot is not in the table).
function rowOf(t, spotId, role, shots) {
    const s = t.spotIndex.get(String(spotId)), r = roleSlot(t, role);
    return s === undefined || r === undefined ? null : t.rows[s][r * t.shotsIndex.size + t.shotsIndex.get(shotKey(shots))];
}

// A row's measured kills by species ([selfId, share, ...]), or null for a
// table before the mix.
function rowMix(t, row) {
    const mix = t.f.mix < 0 ? null : row?.[t.f.mix];
    return Array.isArray(mix) && mix.length ? mix : null;
}

// A row's gate at a bot's level gap (the generator's rowGate, measured at the
// curve gaps; combat reads it at or above the row's minGap): { cap, mask } at
// the nearest gap at or below it, mask the bits
// of the mix species the bot may fight alone there; null when it may fight
// none; undefined for a table before the gate (the reference's cap and mix).
function gateAt(t, row, gap) {
    const gate = t.f.gate < 0 ? null : row?.[t.f.gate];
    if (!Array.isArray(gate)) return undefined;
    let i = t.gaps.length - 1;
    while (i > 0 && t.gaps[i] > gap) i--;
    // Between a closed gap and an open one, the row's own minGap already
    // says the bot hunts: the open one's.
    let value = Number(gate[i]) || 0;
    if (!value && gap > t.gaps[i] && i + 1 < t.gaps.length) value = Number(gate[i + 1]) || 0;
    return value > 0 ? { cap: Math.floor(value / 256), mask: value % 256 } : null;
}
const ALL_SPECIES = 255;

// The spot a row's kills are priced on (Rewards): the species its bot killed
// in their measured shares (an entry's count is its share: the kill draw
// weighs by count), else the spot's spawns. One per row, so the reward
// memos hold it. User 10-29: a bot kills only what it may fight alone, so a
// spot's other mobs neither pay nor set the level gap.
// mask: the species of the mix the bot may fight at its gap (gateAt). Only
// the measured species the spot spawns in this period count (a live spot of
// other spawns than the table's prices by its own spawns).
const killSpots = new WeakMap();
function killSpot(t, row, spotId, mask = ALL_SPECIES) {
    const base = rewardSpot(spotId), mix = rowMix(t, row);
    if (!mix || !base) return base;
    let byMask = killSpots.get(row);
    if (!byMask) killSpots.set(row, byMask = new Map());
    // Keyed by the live spot too: its spawns of the period decide which of
    // the measured species are there now.
    const key = `${mask}|${base.npcEntries?.length || 0}`;
    let held = byMask.get(key);
    if (!held || held.base !== base) {
        const present = new Set((base.npcEntries || []).map(entry => Number(entry.selfId)));
        const npcEntries = [];
        for (let at = 0; at < mix.length; at += 2) {
            if (!(mask & (1 << (at / 2))) || !present.has(Number(mix[at]))) continue;
            npcEntries.push({ selfId: mix[at], count: Math.max(1, Math.round(mix[at + 1] * 1000)) });
        }
        held = { base, spot: npcEntries.length ? { ...base, npcEntries, npcSelfIds: undefined } : base };
        byMask.set(key, held);
    }
    return held.spot;
}

// The exp level-gap factor of a row's kills for a bot of level: the
// species' own factors (MobExperience) in their measured shares, else the
// spot's mean level's.
const mixLevels = new WeakMap();
function killGapFactor(t, row, level, spotLevel, mask = ALL_SPECIES) {
    const mix = rowMix(t, row);
    if (!mix) return expGapFactor(level - spotLevel);
    let levels = mixLevels.get(row);
    if (!levels) {
        levels = [];
        for (let at = 0; at < mix.length; at += 2)
            levels.push(Number(NpcIndex.find(DataCache.npcs, mix[at])?.template?.level) || spotLevel);
        mixLevels.set(row, levels);
    }
    let factor = 0, weight = 0;
    for (let at = 0; at < mix.length; at += 2) {
        if (!(mask & (1 << (at / 2)))) continue;
        factor += mix[at + 1] * expGapFactor(level - levels[at / 2]);
        weight += mix[at + 1];
    }
    return weight > 0 ? factor / weight : expGapFactor(level - spotLevel);
}

// A row's kills per hour at the bot's gap with the walk of that gap: the
// row measured the walk to its reference's admitted spawns (a cap is 3600 /
// the walk per mob, BackgroundResolver.soloWalkMs); the bot of the gap walks
// to its own (T106). Without a gate, the kills as measured.
function walked(t, row, refGap, gate, kills) {
    const reference = gate && gateAt(t, row, refGap);
    if (!reference || !(kills > 0) || !(gate.cap > 0) || !(reference.cap > 0)) return kills;
    return 3600 / (3600 / kills + 3600 / gate.cap - 3600 / reference.cap);
}

// The mobs per hour a row's kills may reach: its cap at the bot's gap (gate),
// else its own at the reference (the spawns its bot may fight), else the
// spot's for every monster.
function rowCap(t, row, spot, gate) {
    return gate ? gate.cap : t.f.cap >= 0 ? row[t.f.cap] : spot[3] * spot[4];
}

// The table-only part of a spot's hour (no rewards): the measured row, the level curve and the kills, or
// null when the bot finds no target it may fight alone there at this level. s, r: the spot's and role's
// table indexes.
function combat(t, s, r, level, shots, classId = 0) {
    const row = t.rows[s][r * t.shotsIndex.size + t.shotsIndex.get(shotKey(shots))];
    if (!row) return null;
    const spot = t.spots[s], spotLevel = spot[1];
    const botLevel = Math.min(t.maxLevel, Number(level));
    const gap = botLevel - spotLevel;
    if (!(gap >= row[t.f.minGap])) return null;
    const gate = gateAt(t, row, gap);
    if (gate === null) return null;
    const mask = gate?.mask ?? ALL_SPECIES;
    const curve = t.curves[r][Math.floor(spotLevel / t.bandLevels)];
    const refGap = row[t.f.refGap];
    const measured = row[t.f.kph] * ratio(curve.kph, t.gaps, refGap, gap);
    const own = classId ? classKills(t, r, row, curve, refGap, gap, botLevel, classId, measured) : measured;
    const kills = Math.min(walked(t, row, refGap, gate, own), rowCap(t, row, spot, gate));
    if (!(kills > 0)) return null;
    return { row, curve, gap, refGap, kills, gate, mask, expRatio: ratio(curve.exp, t.gaps, refGap, gap),
        busyRatio: ratio(curve.busy, t.gaps, refGap, gap), gapFactor: killGapFactor(t, row, botLevel, spotLevel, mask) };
}
// A curve's value at the bot's gap over its value at the row's reference gap.
function ratio(values, gaps, refGap, gap) {
    const reference = at(values, gaps, refGap);
    return reference > 0 ? at(values, gaps, gap) / reference : 1;
}
// Exp of the hour: kills x the row's exp per kill at the bot's gap x the exp rate.
function hourExp(t, rates, c) {
    return c.kills * (c.row[t.f.exp] * c.expRatio * c.gapFactor) * rates.exp;
}

function computeValue(t, rates, spotId, role, level, shots, skill = roleSpoilLevel(role, level)) {
    const s = t.spotIndex.get(String(spotId));
    const r = roleSlot(t, role);
    if (s === undefined || r === undefined) return null;
    const c = combat(t, s, r, level, shots, roleClassOf(role));
    if (!c) return null;
    const { row, curve, gap, refGap, kills, expRatio, busyRatio, gapFactor, mask } = c;
    // Combat remains an offline measurement. Money comes from the native
    // reward groups at each defeated NPC's level and the current rates.
    // Keep the original multiplication order and return a fresh result.
    const lootFactor = lootRateFactor(t.spots[s], rates.drop);
    const rewards = Rewards.value(killSpot(t, row, spotId, mask), Math.min(t.maxLevel, Number(level)), { spoilSkillLevel: skill });
    const busy = row[t.f.busy] * busyRatio;
    return {
        kills,
        deaths: kills * Math.max(0, row[t.f.deaths] + at(curve.deaths, t.gaps, gap) - at(curve.deaths, t.gaps, refGap)),
        exp: hourExp(t, rates, c),
        sp: kills * row[t.f.sp] * expRatio * gapFactor * rates.sp,
        adena: kills * (rewards?.adena || 0),
        dropLoot: kills * (rewards?.drop || 0),
        spoilLoot: kills * (rewards?.spoil || 0),
        loot: kills * ((rewards?.drop || 0) + (rewards?.spoil || 0)),
        rewardSource: rewards ? 'npc_rewards' : 'unavailable',
        shots: kills * row[t.f.shots] * busyRatio,
        potions: kills * row[t.f.potions] * busyRatio,
        stacks: t.f.stacks < 0 || row[t.f.stacks] === null ? null
            : kills * row[t.f.stacks] * lootFactor,
        busyShare: Math.min(1, kills * busy / 3600)
    };
}

// One kill of the reference bot (the role's class in the author's kit) at the
// spot for the role at the level, the hunt cycle model's input (HuntCycle):
// fight and rest seconds, the mob's damage before heals (taken; spellTaken
// its part from spells, 0 in a table before the column), the HP and
// MP it ends short (hpLost, mpLost), deaths, money (adena and loot at the NPC
// buy-back), shots and potions per kill, all at the bot's level gap (the
// curves; HP lost follows taken, MP lost the fight); kph the kills per hour
// its fights allow, cap the spot's, pull the monsters per pull; the kills'
// mean accuracy and evasion. Null where value() has no row or the table has
// no cycle columns.
function cycle(spotId, role, level, shots = true, rewardOptions = {}) {
    const t = load(), rates = ProgressionRates.profile();
    refreshCatalog(rates);
    refreshValueMemo(t, rates);
    const s = t.spotIndex.get(String(spotId)), r = roleSlot(t, role);
    if (s === undefined || r === undefined || t.f.fight < 0) return null;
    const c = combat(t, s, r, level, shots, roleClassOf(role));
    if (!c) return null;
    const skill = rewardOptions.spoilSkillLevel ?? roleSpoilLevel(role, level);
    const slot = memoValue(t, rates, spotId, role, level, shots, skill);
    if (memoFlags[slot] & NO_ROW) return null;
    const n = memoNumbers, at = slot * ROW_NUMBERS, kills = n[at];
    const { row, curve, gap, refGap } = c, f = t.f, spot = t.spots[s];
    const fight = ratio(curve.fight, t.gaps, refGap, gap), taken = ratio(curve.taken, t.gaps, refGap, gap);
    return { spotId: spot[0], kph: row[f.kph] * ratio(curve.kph, t.gaps, refGap, gap), cap: rowCap(t, row, spot, c.gate), pull: 1,
        fight: row[f.fight] * fight, rest: row[f.rest] * ratio(curve.rest, t.gaps, refGap, gap),
        taken: row[f.taken] * taken, spellTaken: f.spellTaken < 0 ? 0 : row[f.spellTaken] * taken, hpLost: row[f.hpLost] * taken, mpLost: row[f.mpLost] * fight,
        deaths: n[at + 1] / kills, money: (n[at + ADENA] + n[at + LOOT]) / kills,
        shots: n[at + SHOTS] / kills, potions: n[at + POTIONS] / kills,
        mobAccur: Number(spot[7]) || 0, mobEvasion: Number(spot[8]) || 0 };
}

// The class the table measured a role with at a level (its header's
// roleClasses: below 20, 20-39, 40 and up), or null for an unknown role.
// A class role key (roleFor) names its own class.
function roleClass(role, level) {
    if (roleClassOf(role)) return roleClassOf(role);
    const classes = load().header.inputs.roleClasses?.[roleName(role)];
    return classes ? classes[level < 20 ? 0 : level < 40 ? 1 : 2] : null;
}

// The level of a spot in the table (its monsters' average), or null.
function spotLevel(spotId) {
    const t = load();
    const s = t.spotIndex.get(String(spotId));
    return s === undefined ? null : t.spots[s][1];
}

// The level the table measured the spot at for the role: where the role
// hunts it in the author's combat.
function referenceLevel(spotId, role, shots = true) {
    const t = load();
    const s = t.spotIndex.get(String(spotId));
    const r = roleSlot(t, role);
    if (s === undefined || r === undefined) return null;
    const row = t.rows[s][r * t.shotsIndex.size + t.shotsIndex.get(shotKey(shots))];
    return row ? t.spots[s][1] + row[t.f.refGap] : null;
}

// Static role/level/shot result, shared by every bot of that role: the row
// of the most exp per hour. Built once per game-data combination, never by
// walking the population.
function best(role, level, shots = true) {
    const t = load(), rates = ProgressionRates.profile();
    refreshCatalog(rates);
    if (t !== incomeTable || rates !== incomeRates) {
        incomeTable = t; incomeRates = rates;
        dropRows();
    }
    const key = `${role}:${level}:${shotKey(shots)}`;
    if (bestRows.has(key)) { DiagnosticConfig.developerDiagnostics && (stats.bestHits += 1); return bestRows.get(key); }
    DiagnosticConfig.developerDiagnostics && (stats.bestMisses += 1);
    // Exp is table-only (no reward groups): the scan reads the table's combat part of each spot, the
    // first spot of the most exp wins, and only the winner's full row is priced. It bypasses the per-bot memo.
    const r = roleSlot(t, role);
    let bestIndex = -1, bestExp = 0;
    for (let s = 0; r !== undefined && s < t.spots.length; s++) {
        const c = combat(t, s, r, level, shots, roleClassOf(role));
        if (!c) continue;
        const exp = hourExp(t, rates, c);
        if (bestIndex < 0 || exp > bestExp) { bestIndex = s; bestExp = exp; }
    }
    const spotId = bestIndex < 0 ? null : t.spots[bestIndex][0];
    const bestRow = bestIndex < 0 ? null : { ...computeValue(t, rates, spotId, role, level, shots), spotId };
    bestRows.set(key, bestRow);
    return bestRow;
}
// The table and rates of one income read, the shared rows reset when either moved.
function incomeSource() {
    const t = load(), rates = ProgressionRates.profile();
    refreshCatalog(rates);
    if (t !== incomeTable || rates !== incomeRates) {
        incomeTable = t; incomeRates = rates;
        dropRows();
    }
    refreshValueMemo(t, rates);
    return { t, rates };
}
// A shared bounded shortlist keeps route reviews from scanning the atlas
// on every actor tick. Final safety, occupancy and travel remain actor facts.
function rankedIncome(role, level, costs = { shots: 0, potions: 0 }, minGap = -7, shots = true, rewardOptions = {}) {
    const { t, rates } = incomeSource();
    const skill = rewardOptions.spoilSkillLevel ?? roleSpoilLevel(role, level);
    const key = `${role}:${level}:${costs.shots}:${costs.potions}:${minGap}:${shotKey(shots)}:${skill}`;
    if (incomeRows.has(key)) {
        DiagnosticConfig.developerDiagnostics && (stats.incomeHits += 1);
        const held = incomeRows.get(key);
        incomeRows.delete(key); incomeRows.set(key, held);
        return held;
    }
    DiagnosticConfig.developerDiagnostics && (stats.incomeMisses += 1);
    const ranked = rankIncome(t, rates, role, level, costs, minGap, shots, skill);
    const result = Object.freeze(ranked.map(({ index, income }) => {
        const spotId = t.spots[index][0];
        return Object.freeze({ ...rowAt(memoValue(t, rates, spotId, role, level, shots, skill)), income, spotId, useShots: shots });
    }));
    if (incomeRows.size >= 128) {
        incomeRows.delete(incomeRows.keys().next().value);
        DiagnosticConfig.developerDiagnostics && (stats.incomeEvictions += 1);
    }
    incomeRows.set(key, result);
    return result;
}
// The spot ids of the shortlist a bot picks a money spot from
// (EquipmentIncomeRoute), loot at its market price (marketLoot, decisions
// 10-28): a spot whose drops the market wants ranks by what they fetch. For
// a caller that prices consumables with the bot's own beliefs: those prices
// are no key of the shared shortlist (every bot would add its own row and
// evict the shared game-data rows), and only the ids are read, so no row
// objects are built. rankedIncome keeps the NPC loot: it prices the bot's
// hour (BotHuntEfficiency.huntIncome), which the first prices read
// (FirstPrice), which the demand table reads; a market rank there would
// close that loop.
function rankedSpotIds(role, level, costs = { shots: 0, potions: 0 }, minGap = -7, shots = true, rewardOptions = {}) {
    // The demand table first: its build reads this table, which may drop the rows.
    const market = Demand().revision() + 1;
    const { t, rates } = incomeSource();
    const skill = rewardOptions.spoilSkillLevel ?? roleSpoilLevel(role, level);
    DiagnosticConfig.developerDiagnostics && (stats.spotIdRanks += 1);
    return rankIncome(t, rates, role, level, costs, minGap, shots, skill, market).map(({ index }) => t.spots[index][0]);
}
// The positive incomes of the role/level band at these consumable prices,
// best first, ties to the spot whose level is closest to the bot's, then by
// spot id; the first 64: [{ index, income }]. One basis per role and level
// spans the widest band any reader asks (BASIS_MIN_GAP, the income route's);
// a narrower minGap filters its rows, so the readers share one basis.
// market: 0 for the NPC loot, else DemandPrice.revision() + 1: the loot at its
// market price, the basis's market column (kills x slotMarket per cell),
// summed again in place when the demand table moved.
const BASIS_MIN_GAP = -15;
function rankIncome(t, rates, role, level, costs, minGap, shots, skill, market = 0) {
    const basisGap = Math.min(minGap, BASIS_MIN_GAP);
    const basisKey = `${role}:${level}:${basisGap}:${shotKey(shots)}:${skill}`;
    let basis = incomeBases.get(basisKey);
    if (basis) {
        incomeBases.delete(basisKey); incomeBases.set(basisKey, basis);
    } else {
        // Keep only the scalars needed to price a band. Retaining full value
        // objects here duplicated the point memo and evicted active bands
        // after 32768 cells, forcing the atlas to be measured again per bot.
        const indexes = new Uint32Array(t.spots.length);
        const values = new Float64Array(t.spots.length * 3);
        let count = 0;
        for (let index = 0; index < t.spots.length; index++) {
            const spot = t.spots[index];
            if (spot[1] - level < basisGap || spot[1] - level > 8) continue;
            const slot = memoValue(t, rates, spot[0], role, level, shots, skill);
            if (memoFlags[slot] & NO_ROW) continue;
            const at = slot * ROW_NUMBERS;
            indexes[count] = index;
            values[count * 3] = memoNumbers[at + ADENA] + memoNumbers[at + LOOT];
            values[count * 3 + 1] = memoNumbers[at + SHOTS];
            values[count * 3 + 2] = memoNumbers[at + POTIONS];
            count++;
        }
        basis = { indexes: indexes.slice(0, count), values: values.slice(0, count * 3), market: null, marketAt: 0 };
        while (incomeBases.size && (incomeBases.size >= 256 || incomeBaseCells + count > MAX_INCOME_BASE_CELLS)) {
            const oldest = incomeBases.keys().next().value;
            incomeBaseCells -= incomeBases.get(oldest).indexes.length;
            incomeBases.delete(oldest);
            DiagnosticConfig.developerDiagnostics && (stats.baseEvictions += 1);
        }
        if (count <= MAX_INCOME_BASE_CELLS) { incomeBases.set(basisKey, basis); incomeBaseCells += count; }
    }
    if (market && basis.marketAt !== market) {
        basis.market ||= new Float64Array(basis.indexes.length);
        let priced = false;
        for (let index = 0; index < basis.indexes.length; index++) {
            const spotId = t.spots[basis.indexes[index]][0];
            const slot = memoValue(t, rates, spotId, role, level, shots, skill);
            basis.market[index] = memoNumbers[slot * ROW_NUMBERS] * slotMarket(t, slot, spotId, role, shots, level, skill, market);
            priced ||= basis.market[index] > 0;
        }
        basis.marketAt = market;
        if (priced) stats.marketRanks += 1;
    }
    // New quotes price compact bands; only the selected spots need complete
    // combat/reward rows. Preserve every candidate, the exact prices and ties.
    const rows = [];
    for (let index = 0; index < basis.indexes.length; index++) {
        if (t.spots[basis.indexes[index]][1] - level < minGap) continue;
        const income = basis.values[index * 3] - basis.values[index * 3 + 1] * costs.shots
            - basis.values[index * 3 + 2] * costs.potions + (market ? basis.market[index] : 0);
        if (income > 0) rows.push({ index: basis.indexes[index], income });
    }
    rows.sort((a, b) => b.income - a.income
        || Math.abs(t.spots[a.index][1] - level) - Math.abs(t.spots[b.index][1] - level)
        || String(t.spots[a.index][0]).localeCompare(String(t.spots[b.index][0])));
    return rows.slice(0, 64);
}
function roles() {
    return load().roles;
}

// role:level -> { shots, exp } per hour of the role's best exp spot at the
// level (best(role, level, true)). The exp argmax is rate-invariant (a rate
// profile scales every spot alike) and the shots come from the table alone;
// the exp carries the rate profile, so the use is kept for the loaded table
// and profile: cleared by useFile and by a new profile (bandRates), never by
// a catalogue refresh. Read by the demand census (MarketDemand), whose
// main-thread reads must not rebuild best rows.
const bandUses = new Map();
let bandRates = null;
function bandUse(role, level) {
    const rates = ProgressionRates.profile();
    if (rates !== bandRates) { bandRates = rates; bandUses.clear(); }
    const key = `${role}:${level}`;
    let use = bandUses.get(key);
    if (!use) {
        const row = best(role, level, true);
        bandUses.set(key, use = Object.freeze({ shots: Number(row?.shots) || 0, exp: Number(row?.exp) || 0 }));
    }
    return use;
}
function shotsUse(role, level) { return bandUse(role, level).shots; }

// The table's revision as of now. The spot catalog is checked at once; rates and rewards are seen at the
// table's own next read (rates are a restart input; the clan worker's rate switch comes with its NPC snapshot).
function revision() {
    if (catalogMoved(spotSource() || EMPTY_SPOTS)) incomeSource();
    return tableRevision;
}

// Tests: read another file, or the default one again.
function useFile(next = DEFAULT_FILE) {
    file = next;
    table = null;
    tableRevision++;
    bestRows.clear();
    bandUses.clear();
    clearValueMemo();
    clearIncomeBases();
}

module.exports = { value, cycle, roleClass, roleFor, marketLoot, roleSpoilLevel, spotLevel, referenceLevel, roles, revision, best, bandUse, shotsUse, rankedIncome, rankedSpotIds, useFile, useSpots, expGapFactor, cacheStats, DEFAULT_FILE };
