'use strict';
// Population census by what is worn (main thread only; the workers read its
// `d:` rows through MarketDemand): how many bots wear what, per cell (class,
// slot group, worn grade, level grade; MarketDemand.wornCell) and the town
// where they buy for it. Each bot is counted in one cell; a publication moves
// it by -1/+1 only when its cell or its home market moved, from plain
// field reads, never by a pass over the world or a per-bot income read. Fed
// by the life-state cache publications (BotLifeState.subscribePublications:
// far commits, hot admission and release, removal); the first put follows
// the replay of the loaded bots, then the changed cells go to the 'market'
// table at most once per PUBLISH_MS (O(changed cells)).
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Channel = require('../Population/ColdTableChannel');
const MarketDemand = require('./MarketDemand');
const MarketTownPolicy = require('./MarketTownPolicy');
const RecipeProductionIndex = require('./RecipeProductionIndex');
const Diagnostics = require('./EconomyDiagnostics');

const PUBLISH_MS = 5 * 60 * 1000;
const NO_TOWNS = new Map();

// characterId -> { key, town }: the cell the bot is counted in.
const owners = new Map();
// cell key -> town -> wearers
const counts = new Map();
const dirty = new Set();
let timer = null, publishedAt = -Infinity, replaying = false, unsubscribe = null;

function count(key, town, step) {
    let towns = counts.get(key);
    if (!towns) counts.set(key, towns = new Map());
    const next = (towns.get(town) || 0) + step;
    if (next > 0) towns.set(town, next); else towns.delete(town);
    if (!towns.size) counts.delete(key);
    dirty.add(key);
}
// The cell key holds class, worn grade and level grade, so an unchanged key
// and home market is an unchanged bot: nothing is written (the cell key is
// still derived per publication). Every bot is counted.
function move(id, state) {
    const held = owners.get(id), cell = state ? MarketDemand.wornCell(state) : null;
    // The bot's home market (karma: Floran; else its D market): the grade of
    // each good maps it to the good's town at read (MarketTownPolicy.gradeTown).
    const town = cell ? MarketTownPolicy.homeMarket(state) : null;
    if (held && cell && held.key === cell.key && held.town === town) return;
    if (held) { count(held.key, held.town, -1); owners.delete(id); }
    if (!cell) return;
    owners.set(id, { key: cell.key, town });
    count(cell.key, town, 1);
}
// One publication of the life-state cache: { characterId, state, kind }.
function observe({ characterId, state, kind }) {
    if (kind === 'reset') { for (const id of [...owners.keys()]) move(id, null); }
    else move(Number(characterId), state || null);
    schedule();
}
function schedule() {
    if (timer || replaying || !dirty.size) return;
    timer = setTimeout(flush, Math.max(0, publishedAt + PUBLISH_MS - Date.now()));
    timer.unref?.();
}
// Puts the changed cells: one `d:` row per cell whose counts moved. The
// PUBLISH_MS delay is the cap on main's cost: a cell moved by many bots in
// five minutes is put once, and the workers' readers wake once for it.
function flush() {
    if (timer) clearTimeout(timer);
    timer = null;
    publishedAt = Date.now();
    let put = 0;
    for (const key of dirty) {
        const row = MarketDemand.putCensus(key, counts.get(key) || NO_TOWNS);
        if (!row) continue;
        Channel.shared.changed('market', row);
        put++;
    }
    dirty.clear();
    if (!put) return;
    // Main's recipe index admits the products the census buys now.
    RecipeProductionIndex.censusMoved();
    if (Diagnostics.active()) Diagnostics.count('census', 'rows_published', 'put', put);
}
function start(life = LifeState) {
    if (unsubscribe) return;
    // The census's table use, read once at boot (no read pays a spot search).
    MarketDemand.warmUse();
    // The first put waits for the replay of every loaded bot, then goes at once.
    replaying = true;
    unsubscribe = life.subscribePublications(observe, { replay: true, onReplayed: () => { replaying = false; flush(); } });
}
function stop() {
    unsubscribe?.();
    unsubscribe = null;
    replaying = false;
    if (timer) clearTimeout(timer);
    timer = null;
}
module.exports = { start, stop, observe, flush };
