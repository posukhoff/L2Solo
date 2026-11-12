'use strict';

// The economy model's game-data snapshot: one plain JSON per rate preset that
// the model's engine and rules read instead of the server's modules (no
// World, no database). It is read from the owners themselves: the spot
// table's hours (SpotValueTable), the drop and spoil rule (itemDropYield over
// ProgressionRates), recipes (C4RecipeItems), kits (BotGear), NPC shops
// (NpcShopBuyLists), today's static stores (MerchantStoreConfigs), seated MP
// and craft skills (ColdRest, CraftEligibility), a twin's max MP
// (ColdCombatProfile) and store slots (PrivateStoreLimits), the hour without
// shots (SpotValueTable.value with shots off), each line's race (class
// templates) and the design's per-kill yields (rules/dropRule at the
// design's rates of the preset).
//
//   node scripts/economy-model/inputs.js [--preset x1,x10,x50] [--out <dir>] [--spots <save.sqlite>]
//
// --spots adds the hours at the spots a save's bots stand at (spotHours), so
// a model run that starts from that save hunts where its bots hunted.
//
// Writes <out>/inputs-<preset>-<revision>-<fingerprint>.json (default
// tmp/economy-model in the tree). The snapshot reads more than the hunt tables'
// input hash covers (static stores, craft eligibility, NPC price scale, the
// town catalogue, the spot table's own rows), so the file name carries the
// git revision, "-dirty" with uncommitted code or data, beside the hunt
// tables' hash (TableFingerprint 'hunt'). The header repeats both and adds
// the spot table's own fingerprint and the notes a reader of the numbers needs.

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const Boot = require('./boot');
const Capacity = require('./capacity');
const Cohort = require('./cohort');
const DesignIncome = require('./design-income');
const { DESIGN_RATES } = require('./rules/dropRule');
const common = require('../hunt-tables/common');

const SCHEMA = 1;
const LEVELS = Object.freeze([1, common.MAX_LEVEL]);
const TWIN_LEVELS = Object.freeze([1, common.MAX_LEVEL]);
// Private store types (PrivateStoreLimits.tradeLimit) and Expand Trade, the skill that adds slots.
const STORE_SELL = 1, STORE_BUY = 3, EXPAND_TRADE = 1370, DWARF = 4;
// The fields of an hour without shots (SpotValueTable.value(spot, line, level, false)).
const SHOTLESS_FIELDS = Object.freeze(['kills', 'exp', 'adena', 'dropLoot', 'spoilLoot', 'loot']);
const TOP_SPOTS = 3;
// Spot hours of a save's bot at its level and this many levels above it: a
// bot of the real runs gains at most 10 levels in a 25-minute window.
const SPOT_LEVELS_AHEAD = 10;
const HOUR_FIELDS = Object.freeze(['spotId', 'kills', 'deaths', 'exp', 'adena', 'dropLoot', 'spoilLoot', 'loot',
    'shots', 'potions', 'busyShare']);
// Items the generated hunt sources lack or leave without a drop row: shots,
// ore, shot and arrow recipes, potions, scrolls, arrows, the D crystal.
const OTHER_GAP_IDS = Object.freeze([1785, 3031, 1804, 1805, 3953, 1060, 736, 17, 1666, 1458]);
const NOTES = Object.freeze([
    'best (SpotValueTable.best) and top[0] (rankedIncome) are two owners and differ on some line-levels: read best for the income of the hour, top for the candidates a bot ranks.',
    'Per-kill item yields (yields) are taken at the spot\'s spawn mix; the hour\'s income (best, top) uses the kill mix the spot table measured for the line.',
    'spotHours (with --spots): spotHours.rows[line][level][spotId] is the spot table\'s hour at the spot a save\'s bot stood at, for the line the model draws for it, null where that line may fight nothing there.',
    'rates are today\'s presets as the game applies them, not the design\'s per-kind rates; yieldsDesign holds the per-kill yields at the design\'s rates of the preset (rules/dropRule), at the same spawn mix and Spoil level as yields.',
    'An hour row\'s shotless holds the same spot\'s hour for the same line and level hunting without shots (SpotValueTable.value with shots off).'
]);

function readJson(relative) {
    return JSON.parse(fs.readFileSync(path.join(Boot.root, relative), 'utf8'));
}

// The git revision of the tree, "-dirty" with uncommitted code or data. Copies
// gitRevision of scripts/hunt-tables/common.js (not exported), over the paths
// this snapshot reads.
function gitRevision() {
    try {
        const run = command => childProcess.execSync(command, { cwd: Boot.root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        const head = run('git rev-parse --short=9 HEAD');
        return run('git status --porcelain -- src data scripts') ? `${head}-dirty` : head;
    } catch (_) {
        return 'unknown';
    }
}

function hourRow(row) {
    const out = {};
    for (const field of HOUR_FIELDS) out[field] = row[field];
    return out;
}

// An hour row with the same spot's hour without shots beside it (null where
// the line fights nothing there without shots).
function hourRowWithShotless(row, line, level, Table) {
    const out = hourRow(row), bare = Table.value(String(row.spotId), String(line), level, false);
    out.shotless = bare && bare.kills > 0 ? Object.fromEntries(SHOTLESS_FIELDS.map(field => [field, bare[field]])) : null;
    return out;
}

// The spots as the spot table prices them offline (copies the unexported
// rewardSpot of SpotValueTable):
// spot-reward-npcs.json's spawns and adena range, with the hunt tables' town.
function rewardSpots() {
    const table = readJson('data/Bots/hunt/spots.json'), townAt = table.spotFields.indexOf('town');
    const towns = new Map(table.spots.map(row => [String(row[0]), row[townAt]]));
    return new Map(readJson('data/Bots/spot-reward-npcs.json').rows.map(([id, entries, adenaMin, adenaMax]) => [String(id),
        { id, npcEntries: entries.map(([selfId, count]) => ({ selfId, count })), rewards: { adenaMin, adenaMax }, town: towns.get(String(id)) ?? null }]));
}

// The NPCs a bot kills at a spot and the reward each gives, as the spot
// value's composition admits them (SpotRewardExpectation): huntable, not a
// protected raid, reward data by the native kill mapping (world/datapack id
// aliases by name included). Copies the unexported composition of
// SpotRewardExpectation.
function composition(spot, owners) {
    const { Data, Index, Policy, Raid, Drops } = owners;
    const nativeSpot = { ...spot, npcNames: spot.npcEntries.map(entry => Index.find(Data.npcs, entry.selfId)?.template?.name).filter(Boolean) };
    return spot.npcEntries.flatMap(entry => {
        const npc = Index.find(Data.npcs, entry.selfId);
        if (!npc || !Policy.canHunt(npc) || Raid.isProtectedRaidEntity(npc)) return [];
        return [{ npcId: Number(entry.selfId), level: Number(npc.template?.level || 1), count: Math.max(1, Number(entry.count) || 1),
            reward: Drops.rewardDataForSpot(nativeSpot, () => 0, entry.selfId) }];
    });
}

function rewardItemIds(reward, kind) {
    return [...new Set((reward?.[kind === 'spoil' ? 'spoils' : 'rewards'] || []).flatMap(group => (group.items || []).map(item => Number(item.selfId))))];
}

// Expected items per kill at a spot for a killer of the level: drops by the
// drop rule (itemDropYield, deep blue at each NPC's level), spoils at the
// killer's Spoil skill level (the spot table's own rule for its line and level, roleSpoilLevel) times its landing chance (0 without Spoil).
// Adena is item 57 of the drops. The NPCs are the spot's spawns; the spot
// table's hour prices the species a line fights there at its level (its
// measured kill mix), so the two moneys per kill differ where they differ.
function spotYields(entries, killerLevel, spoilSkillLevel, owners) {
    const { Planner, Formulas } = owners;
    const total = entries.reduce((sum, entry) => sum + entry.count, 0), drop = {}, spoil = {};
    for (const entry of entries) {
        const share = entry.count / total, context = { npcLevel: entry.level, killerLevel };
        for (const id of rewardItemIds(entry.reward, 'drop')) {
            const { expectedYield } = Planner.itemDropYield(entry.reward, id, 'drop', context);
            if (expectedYield > 0) drop[id] = (drop[id] || 0) + share * expectedYield;
        }
        if (!(spoilSkillLevel > 0)) continue;
        const landed = Formulas.spoilSuccessChance({ skillId: 254, skillLevel: spoilSkillLevel, attackerLevel: killerLevel, targetLevel: entry.level });
        for (const id of rewardItemIds(entry.reward, 'spoil')) {
            const { expectedYield } = Planner.itemDropYield(entry.reward, id, 'spoil', context);
            if (expectedYield > 0) spoil[id] = (spoil[id] || 0) + share * expectedYield * landed;
        }
    }
    return { drop, spoil };
}

function gameOwners() {
    return {
        Data: invoke('GameServer/DataCache'),
        Index: require('../../src/GameServer/Item/ItemTemplateIndex'),
        Table: invoke('GameServer/Bot/AI/SpotValueTable'),
        Policy: invoke('GameServer/Bot/AI/BotHuntingTargetPolicy'),
        Raid: invoke('GameServer/Bot/AI/BotRaidSafety'),
        Drops: invoke('GameServer/Bot/Population/BackgroundDropResolver'),
        // Loads the World module's code (no world is built), as the spot table generator does.
        Planner: invoke('GameServer/Bot/AI/GearAcquisitionPlanner'),
        Formulas: invoke('GameServer/Formulas'),
        Rates: invoke('GameServer/ProgressionRates'),
        Recipes: invoke('GameServer/Items/C4RecipeItems'),
        Enchant: invoke('GameServer/Items/C4EnchantRules'),
        Sell: invoke('GameServer/Items/NpcSellRules'),
        Shops: invoke('GameServer/World/Generics/NpcShopBuyLists'),
        Stores: invoke('GameServer/Bot/MerchantStoreConfigs'),
        BotGear: invoke('GameServer/Bot/AI/BotGear'),
        HuntCycle: invoke('GameServer/Bot/AI/HuntCycle'),
        Profile: invoke('GameServer/Bot/Population/ColdCombatProfile'),
        StoreLimits: require('../../src/GameServer/PrivateStoreLimits')
    };
}

// item -> [{ town, price }] of every NPC offer at the current rate.
function npcOffers(owners) {
    const view = owners.Shops.townOffers(), out = {};
    for (const item of owners.Data.items) {
        const rows = view?.offersFor(item.selfId) || [];
        if (rows.length) out[item.selfId] = rows.map(row => ({ town: row.town, price: row.price }));
    }
    return out;
}

// The rate-free part: recipes, static stores, Luxury, exp, twins, rewards.
function staticInputs(owners, spots) {
    const { Data, Recipes, Stores } = owners;
    const questScrolls = new Set(readJson('data/Recipes/c4_high_grade_recipe_quests.json').flatMap(quest => (quest.exchanges || [])
        .flatMap(exchange => (exchange.outcomes || []).flatMap(outcome => (outcome.items || []).map(item => Number(item.selfId))))));
    // A/S recipes the quests give: in the first version a crafter twin gets them by its Create Item level (ours).
    const recipes = Recipes.nativeSource().rows.map(row => ({ ...row, quest: questScrolls.has(row.recipeItemId) }));
    const stores = Object.entries(Stores).filter(([, store]) => store && Array.isArray(store.items))
        .map(([name, store]) => ({ name, title: store.title, town: store.town, storeType: store.storeType,
            items: store.items.map(({ selfId, priceRate, count }) => ({ selfId, priceRate, count })) }));
    const sources = readJson('data/Bots/hunt/sources.json'), luxuryAt = sources.itemFields.findIndex(field => field.startsWith('luxury'));
    const luxury = {};
    for (const row of sources.items) if (row[luxuryAt]?.length) {
        luxury[row[0]] = { npcId: row[luxuryAt][0], crystals: row[luxuryAt][1].map(([selfId, amount]) => ({ selfId, amount })) };
    }
    const world = Capacity.gameWorld(), twins = {};
    for (let level = TWIN_LEVELS[0]; level <= TWIN_LEVELS[1]; level++) twins[level] = twinRow(world.twin(level), level, owners);
    // Reward groups by reward id and each spot's NPCs: the drop rule's inputs.
    const rewards = {}, compositions = {};
    for (const [id, spot] of spots) {
        const entries = composition(spot, owners);
        compositions[id] = { town: spot.town, adenaMin: spot.rewards.adenaMin, adenaMax: spot.rewards.adenaMax,
            npcs: entries.map(entry => ({ npcId: entry.npcId, level: entry.level, count: entry.count, rewardId: entry.reward ? Number(entry.reward.selfId) : null })) };
        for (const entry of entries) if (entry.reward) rewards[entry.reward.selfId] ||= { rewards: entry.reward.rewards || [], spoils: entry.reward.spoils || [] };
    }
    const quests = { scrolls: questScrolls.size, withRecipe: recipes.filter(row => row.quest).length };
    return { recipes, stores, luxury, exp: [...Data.experience], twins, rewards, compositions, quests, fares: gatekeeperFares(), shotFamilies: shotFamilies(),
        races: lineRaces(Data), crystalIds: { ...owners.Enchant.CRYSTAL_IDS } };
}

// A crafter twin at a level: its seated MP per hour, Create Item level and
// crystallize grade (Capacity.gameWorld().twin), its max MP (the cold combat
// profile of its class, bare) and its private store slots (a dwarf, at its
// Expand Trade level from its class's skill tree).
function twinRow(twin, level, owners) {
    const state = { level, stats: { classId: twin.classId } };
    const expand = owners.Profile.skillsFor(state, twin.classId, level).find(skill => Number(skill.selfId) === EXPAND_TRADE)?.level || 0;
    return { ...twin, maxMp: owners.Profile.profileFor(state, 0).maxMp,
        storeSlots: { sell: owners.StoreLimits.tradeLimit(DWARF, expand, STORE_SELL), buy: owners.StoreLimits.tradeLimit(DWARF, expand, STORE_BUY) } };
}

// The race of every class (its template's race: 0 human, 1 elf, 2 dark elf,
// 3 orc, 4 dwarf), by class id; a line's race is its final class's.
function lineRaces(Data) {
    return Object.fromEntries(Data.classTemplates.map(row => [String(row.classId), Number(row.template?.race)]));
}

// The shot of each kind by weapon grade (ShotStock's tables, by rank none, d,
// c, b, a, s): a bot fires the shot of its weapon's grade.
function shotFamilies() {
    const shots = invoke('GameServer/Inventory/ShotStock');
    return { grades: ['NONE', 'D', 'C', 'B', 'A', 'S'], ids: [shots.SOULSHOT_IDS, shots.SPIRITSHOT_IDS, shots.BLESSED_SPIRITSHOT_IDS].map(ids => [...ids]) };
}

// The gatekeeper fee of a trip from one town into another, by town name: the
// trip rule's own route (TravelRoutes.between, Floran through Dion), null
// without a route. C4 fees, the same at every rate.
function gatekeeperFares() {
    const towns = Object.values(invoke('GameServer/World/TownRespawn').towns), routes = invoke('GameServer/Bot/Travel/TravelRoutes');
    const point = town => ({ locX: town.locX, locY: town.locY, locZ: town.locZ }), fares = {};
    for (const from of towns) {
        fares[from.name] = {};
        for (const to of towns) fares[from.name][to.name] = routes.between(point(from), point(to)).route?.fee ?? null;
    }
    return fares;
}

// Every NPC's drops and spoils of an item from the raw reward data, at a
// killer of the NPC's level: item -> { drop: [{ npcId, yield }], spoil: [{ npcId, yield }] }, a spoil's
// yield with Spoil landed.
function rawSources(owners, itemIds) {
    const { Data, Index, Planner } = owners, out = {};
    for (const reward of Data.npcRewards) {
        const level = Number(Index.find(Data.npcs, reward.selfId)?.template?.level || 1);
        for (const kind of ['drop', 'spoil']) for (const id of rewardItemIds(reward, kind)) {
            if (!itemIds.has(id)) continue;
            const { expectedYield } = Planner.itemDropYield(reward, id, kind, { npcLevel: level, killerLevel: level });
            if (expectedYield > 0) ((out[id] ||= { drop: [], spoil: [] })[kind]).push({ npcId: Number(reward.selfId), yield: expectedYield });
        }
    }
    return out;
}

// One preset's snapshot. lines, levels: a subset (tests); by default every
// spot-table line at levels 1-78.
// The hours at the spots a save's bots stand at (bot_life_state.spotId): for
// the line the cohort gives each bot (Cohort.lineOf, the same seeded draw), at
// its level and SPOT_LEVELS_AHEAD above it, the spot table's value of the
// spot, null where the line may fight nothing there. Each found spot-level is
// added to pairs, so its yields are written too.
function spotHours(save, hours, levels, owners, pairs) {
    const { Table } = owners, rows = {}, byClass = Cohort.linesByClass({ hours });
    for (const bot of Cohort.savedBots(save).bots) {
        const picked = !bot.station && bot.spotId ? Cohort.lineOf(Number(bot.classId), bot.characterId, { hours }, byClass) : null;
        if (!picked) continue;
        const spotId = String(bot.spotId), line = picked.line;
        for (let level = Number(bot.level); level <= Math.min(levels[1], Number(bot.level) + SPOT_LEVELS_AHEAD); level++) {
            const at = ((rows[line] ||= {})[level] ||= {});
            if (at[spotId] !== undefined) continue;
            const row = Table.value(spotId, line, level, true);
            at[spotId] = row && row.kills > 0 ? hourRowWithShotless({ ...row, spotId }, line, level, Table) : null;
            if (!at[spotId]) continue;
            const key = `${spotId}@${level}`, held = pairs.get(key), skill = Table.roleSpoilLevel(line, level);
            pairs.set(key, { spotId, level, spoilSkill: Math.max(held?.spoilSkill || 0, skill) });
        }
    }
    return { source: save, levelsAhead: SPOT_LEVELS_AHEAD, rows };
}

function extract({ preset, lines = null, levels = LEVELS, x1Offers = null, base = null, spots: save = null } = {}) {
    const owners = gameOwners(), { Table, Data, Index, Enchant, Sell, Rates } = owners;
    if (!x1Offers) { Boot.usePreset('x1'); x1Offers = npcOffers(owners); }
    Boot.usePreset(preset);
    const spots = rewardSpots(), fixed = base || staticInputs(owners, spots);
    const hours = {}, kits = {}, pairs = new Map();
    for (const line of lines || Table.roles()) {
        hours[line] = {}; kits[line] = {};
        for (let level = levels[0]; level <= levels[1]; level++) {
            const best = Table.best(line, level, true, 'income');
            const top = Table.rankedIncome(line, level).slice(0, TOP_SPOTS);
            const classId = Table.roleClass(line, level);
            const kit = owners.BotGear.planFor({ classId, level, characterId: owners.HuntCycle.referenceId(classId, Number(line)) }).items;
            kits[line][level] = kit.map(({ selfId, slot }) => ({ selfId: Number(selfId), slot: Number(slot) }));
            hours[line][level] = { classId, shotId: Capacity.referenceShot(classId, level, line),
                best: best && hourRowWithShotless(best, line, level, Table), top: top.map(hourRow) };
            const skill = Table.roleSpoilLevel(line, level);
            for (const row of [best, ...top]) if (row) {
                const key = `${row.spotId}@${level}`, held = pairs.get(key);
                pairs.set(key, { spotId: String(row.spotId), level, spoilSkill: Math.max(held?.spoilSkill || 0, skill) });
            }
        }
    }
    const spotRows = save ? spotHours(save, hours, levels, owners, pairs) : null;
    const yields = {}, yieldsDesign = {}, game = DesignIncome.gameRules();
    for (const [key, { spotId, level, spoilSkill }] of pairs) {
        const spot = spots.get(spotId);
        if (!spot) continue;
        yields[key] = { spotId, level, town: spot.town, spoilSkill, ...spotYields(composition(spot, owners), level, spoilSkill, owners) };
        const design = DesignIncome.designYields(fixed, spotId, level, spoilSkill, DESIGN_RATES[preset], game);
        if (design) yieldsDesign[key] = design;
    }
    const offers = npcOffers(owners);
    const ids = new Set();
    const add = id => { if (Number(id) > 0) ids.add(Number(id)); };
    for (const row of fixed.recipes) { add(row.recipeItemId); add(row.productId); row.materials.forEach(m => add(m.selfId)); }
    for (const store of fixed.stores) store.items.forEach(item => add(item.selfId));
    for (const [id, row] of Object.entries(fixed.luxury)) { add(id); row.crystals.forEach(crystal => add(crystal.selfId)); }
    for (const reward of Object.values(fixed.rewards)) for (const group of [...reward.rewards, ...reward.spoils]) (group.items || []).forEach(item => add(item.selfId));
    for (const byLevel of Object.values(kits)) for (const kit of Object.values(byLevel)) kit.forEach(row => add(row.selfId));
    for (const byLevel of Object.values(hours)) for (const hour of Object.values(byLevel)) add(hour.shotId);
    Object.keys(offers).forEach(add); Object.keys(x1Offers).forEach(add);
    Object.values(Enchant.CRYSTAL_IDS).forEach(add);
    const items = {};
    for (const id of [...ids].sort((a, b) => a - b)) {
        const item = Index.find(Data.items, id);
        if (!item) continue;
        const ref = Number(item.template?.price || 0), kind = item.template?.kind || null;
        // An NPC buys no quest item (copies the unexported itemPrice of SpotRewardExpectation).
        items[id] = { name: item.template?.name || null, kind, grade: item.etc?.rank ? Enchant.gradeOf(item.etc) : 'NONE', ref,
            npcBuy: kind === 'Other.Quest' ? 0 : Sell.npcBuyPrice(ref), crystals: Enchant.crystalCount(item.etc), weight: Number(item.template?.mass || 0) };
    }
    const { quests, ...kept } = fixed;
    return {
        header: { schema: SCHEMA, preset, rates: Rates.profile(), levels: [levels[0], levels[1]], quests, notes: NOTES },
        hours, kits, yields, yieldsDesign, items, npcOffers: { preset: offers, x1: x1Offers }, ...kept, ...(spotRows ? { spotHours: spotRows } : {}),
        sources: rawSources(owners, ids)
    };
}

function sourceGaps(snapshot) {
    const hunt = readJson('data/Bots/hunt/sources.json'), rows = new Map(hunt.items.map(row => [row[0], row]));
    const dropsAt = hunt.itemFields.findIndex(field => field.startsWith('drops')), spoilsAt = hunt.itemFields.findIndex(field => field.startsWith('spoils'));
    const lacking = Object.keys(snapshot.sources).filter(id => { const row = rows.get(Number(id)); return !row || !(row[dropsAt]?.length || row[spoilsAt]?.length); });
    // The D and C shots come from ShotStock's tables (index 0 is no-grade, 1 D, 2 C).
    const shots = invoke('GameServer/Inventory/ShotStock');
    const gapIds = [...[shots.SOULSHOT_IDS, shots.SPIRITSHOT_IDS, shots.BLESSED_SPIRITSHOT_IDS].flatMap(table => table.slice(1, 3)), ...OTHER_GAP_IDS];
    const named = gapIds.map(id => {
        const raw = snapshot.sources[id], row = rows.get(id);
        return `${snapshot.items[id]?.name || id} (${id}): hunt sources ${row ? `${row[dropsAt]?.length || 0} drop/${row[spoilsAt]?.length || 0} spoil` : 'no row'}, `
            + `raw ${raw?.drop.length || 0} drop/${raw?.spoil.length || 0} spoil NPCs, NPC towns ${snapshot.npcOffers.x1[id]?.length || 0}`;
    });
    return { lacking: lacking.length, named };
}

function main(argv) {
    const presets = Boot.presetsOption(argv);
    const out = path.resolve(Boot.option(argv, 'out', path.join(Boot.root, 'tmp', 'economy-model')));
    Boot.boot('x1');
    const startedAt = Date.now();
    const fingerprint = invoke('GameServer/Bot/AI/TableFingerprint').fingerprint('hunt').hash, revision = gitRevision();
    const spotTable = readJson('data/Bots/spot-table.json').header?.fingerprint?.hash || null;
    const owners = gameOwners();
    // NPC prices at x1 ride in every snapshot: the design's NPC prices at every preset.
    const x1Offers = npcOffers(owners), base = staticInputs(owners, rewardSpots());
    fs.mkdirSync(out, { recursive: true });
    for (const preset of presets) {
        const began = Date.now();
        const snapshot = extract({ preset, x1Offers, base, spots: Boot.option(argv, 'spots', null) });
        snapshot.header = { ...snapshot.header, fingerprint, spotTable, revision };
        const file = path.join(out, `inputs-${preset}-${revision}-${fingerprint}.json`), text = `${JSON.stringify(snapshot)}\n`;
        fs.writeFileSync(file, text);
        const gaps = sourceGaps(snapshot), lineCount = Object.keys(snapshot.hours).length;
        const empty = Object.values(snapshot.hours).reduce((sum, byLevel) => sum + Object.values(byLevel).filter(hour => !hour.best).length, 0);
        console.log(`[${preset}] ${file} (${(text.length / 1e6).toFixed(1)} MB, ${((Date.now() - began) / 1000).toFixed(1)} s); fingerprint ${fingerprint}, spot table ${spotTable}, revision ${revision}`);
        console.log(`  lines ${lineCount} x levels ${snapshot.header.levels.join('-')} (${empty} without a spot row); spot-level yields ${Object.keys(snapshot.yields).length}; `
            + `items ${Object.keys(snapshot.items).length}; recipes ${snapshot.recipes.length} (${snapshot.header.quests.withRecipe} of ${snapshot.header.quests.scrolls} quest scrolls with a row); `
            + `NPC-offered items ${Object.keys(snapshot.npcOffers.preset).length}; static stores ${snapshot.stores.length}; Luxury items ${Object.keys(snapshot.luxury).length}; `
            + `spots ${Object.keys(snapshot.compositions).length}; reward rows ${Object.keys(snapshot.rewards).length}; twin levels ${Object.keys(snapshot.twins).length}`);
        if (snapshot.spotHours) {
            const cells = Object.values(snapshot.spotHours.rows).flatMap(byLevel => Object.values(byLevel).flatMap(Object.values));
            console.log(`  spot hours from ${snapshot.spotHours.source}: ${cells.filter(Boolean).length} rows, ${cells.filter(row => !row).length} spot-levels where the line fights nothing`);
        }
        if (preset !== presets[0]) continue;
        console.log(`  raw sources for ${Object.keys(snapshot.sources).length} items, ${gaps.lacking} of them without a drop or spoil row in the hunt sources table:`);
        for (const line of gaps.named) console.log(`    ${line}`);
    }
    console.log('notes:');
    for (const note of NOTES) console.log(`  ${note}`);
    console.log(`done in ${((Date.now() - startedAt) / 1000).toFixed(1)} s, heap ${Math.round(process.memoryUsage().heapUsed / 1e6)} MB`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { extract, spotHours, rewardSpots, spotYields, composition, HOUR_FIELDS, SHOTLESS_FIELDS, SCHEMA, SPOT_LEVELS_AHEAD };
