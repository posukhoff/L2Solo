'use strict';

// The economy model's game-data snapshot: one plain JSON per rate preset that
// the model's engine and rules read instead of the server's modules (no
// World, no database). It is read from the owners themselves: the spot
// table's hours (SpotValueTable), the drop and spoil rule (itemDropYield over
// ProgressionRates), recipes (C4RecipeItems), kits (BotGear), NPC shops
// (NpcShopBuyLists), today's static stores (MerchantStoreConfigs), seated MP
// and craft skills (ColdRest, CraftEligibility), a twin's max MP
// (ColdCombatProfile) and store slots (PrivateStoreLimits), the hour without
// shots (SpotValueTable.value with shots off) and firing Blessed
// Spiritshots (with shots 2), each line's race (class
// templates), the design's per-kill yields (rules/dropRule at the
// design's rates of the preset), a servitor's item upkeep (the cold fight's
// summon choice, the skill data, SummonControl's life rule) and the arrow of
// each bow grade (ArrowStock).
//
//   node scripts/economy-model/inputs.js [--preset x1,x10,x50] [--out <dir>] [--spots <save.sqlite>]
//
// --spots adds the hours at the spots a save's bots start at (spotHours), so
// a model run that starts from that save hunts where its bots hunted.
//
// Writes <out>/inputs-<preset>-<revision>-<fingerprint>.json (default
// tmp/economy-model in the tree): the git revision, "-dirty" with uncommitted
// code or data, beside the hunt tables' hash (TableFingerprint 'hunt'). The
// header repeats both and adds the notes a reader of the numbers needs and
// the stamp a run reads the snapshot by (Boot.dataStamp): the hunt tables'
// hash, the spot table's own fingerprint and the contents of every tree file
// the extract loaded or read (sourceFiles: the static stores, fares, bags,
// market towns, inputs.js itself, config/default.ini, the extractable items
// csv and the hunt tables' files among them). A config layer outside the
// tree (L2NODE_CONFIG_FILE and the like) is not stamped.

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const Boot = require('./boot');
const Capacity = require('./capacity');
const Cohort = require('./cohort');
const DesignIncome = require('./design-income');
const { DESIGN_RATES } = require('./rules/dropRule');
const KitHours = require('./kit-hours');
const common = require('../hunt-tables/common');

const SCHEMA = 1;
const LEVELS = Object.freeze([1, common.MAX_LEVEL]);
const { TOP_SPOTS } = KitHours;
const TWIN_LEVELS = Object.freeze([1, common.MAX_LEVEL]);
// Private store types (PrivateStoreLimits.tradeLimit) and Expand Trade, the skill that adds slots.
const STORE_SELL = 1, STORE_BUY = 3, EXPAND_TRADE = 1370, DWARF = 4;
// The fields of an hour without shots (SpotValueTable.value(spot, line, level, false)).
const SHOTLESS_FIELDS = Object.freeze(['kills', 'exp', 'adena', 'dropLoot', 'spoilLoot', 'loot']);
// The fields of an hour firing Blessed Spiritshots (SpotValueTable.value(spot, line, level, 2)).
const BLESSED_FIELDS = Object.freeze([...SHOTLESS_FIELDS, 'shots']);
// Spots that yield a shot recipe's scroll a main's occupation may also rank
// (ours): per scroll, line and level, the few that give the most scrolls an
// hour. Scrolls of gear recipes drop at nearly every spot, so the top spots
// carry them already; a shot recipe's scroll drops at few.
const SCROLL_SPOTS = 3;
// NPC levels around a scroll spot's own where a line's rows are searched.
const SCROLL_LEVEL_REACH = 12;
// The grades a path covers, D to S (GearGradeRule), and the Luxury shop NPCs (C4 multisell 7097, 7098).
const GRADE_NAMES = Object.freeze(['d', 'c', 'b', 'a', 's']);
const LUXURY_NPCS = Object.freeze([7097, 7098]);
// The skill that adds bag slots (InventoryLimits.forActor).
const EXPAND_INVENTORY = 1372;
// Spot hours of a save's bot at its level and this many levels above it: a
// bot of the real runs gains at most 10 levels in a 25-minute window.
const SPOT_LEVELS_AHEAD = 10;
const HOUR_FIELDS = Object.freeze(['spotId', 'kills', 'deaths', 'exp', 'adena', 'dropLoot', 'spoilLoot', 'loot',
    'shots', 'potions', 'busyShare']);
// Items the generated hunt sources lack or leave without a drop row: shots,
// ore, shot and arrow recipes, potions, scrolls, arrows, the D crystal.
const OTHER_GAP_IDS = Object.freeze([1785, 3031, 1804, 1805, 3953, 1060, 736, 17, 1666, 1458]);
// The hunt time a servitor's casts are counted over: some summon ranks wait 6
// hours to be cast again, so their casts are averaged over a day of hunting.
const UPKEEP_WINDOW_S = 24 * 3600;
const NOTES = Object.freeze([
    'best (SpotValueTable.best) and top[0] (rankedIncome) are two owners and differ on some line-levels: read best for the income of the hour, top for the candidates a bot ranks.',
    'Per-kill item yields (yields) are taken at the spot\'s spawn mix; the hour\'s income (best, top) uses the kill mix the spot table measured for the line.',
    'spotHours (with --spots): spotHours.rows[line][level][spotId] is the spot table\'s hour at the spot a save\'s bot starts at (Cohort.savedBots: the spot it stands at, else its travel\'s, else its stay\'s), for the line the model draws for it, null where that line may fight nothing there.',
    'rates are today\'s presets as the game applies them, not the design\'s per-kind rates; yieldsDesign holds the per-kill yields at the design\'s rates of the preset (rules/dropRule), at the same spawn mix and Spoil level as yields.',
    'hours[line][level].others: rows of spots outside the top at that level that a main may hold (a spot of its top at an earlier level, while the level stays in the spot\'s range) or rank for a shot recipe\'s scroll (scrolls: the ones it yields); spotLevels[line][spotId] is the lowest and highest level the spot table has a row for the line there.',
    'An hour row\'s shotless holds the same spot\'s hour for the same line and level hunting without shots (SpotValueTable.value with shots off).',
    'An hour row\'s blessed holds the same spot\'s hour for the same line and level firing Blessed Spiritshots (SpotValueTable.value with shots 2); only a line the spot table measures firing them there (a spiritshot class) has it, and the row itself is the hour firing its plain shot.',
    'tradeTowns is the game\'s trade town of a lot (MarketTownPolicy): grade[item] the market grade of each graded item, none[spotId] the no-grade market nearest the spot card\'s centre, d the D markets (a bot picks among them), higher the town of a lot with C and above.',
    'upkeep[line][level] lists the items a line\'s servitor costs a player per hunt hour (the game spares bots): [{ id, perHour, what: { skill, level, name } }], the summons its reference bot\'s cold fight casts, at the busy share of the level\'s best row; a line or level without such a cost has no entry.',
    'arrowIds is the arrow of each bow grade (ArrowStock.BY_RANK).',
    'gearLadder.lines[line] holds per level band the gear table\'s ladder rungs of the band\'s grade and below (rungs[group], best first), the band\'s middle level and grade, its best spot and scale (the design\'s money per kill over today\'s there: a kit\'s hunt hour, read through kit-hours.js at the middle level, times scale is in the design\'s money); gearLadder.slots holds each rung\'s own slot.'
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
// the line fights nothing there without shots) and, for a line the spot
// table measures firing Blessed Spiritshots there, its hour firing them
// (absent for any other line).
function hourRowWithForms(row, line, level, Table) {
    const out = hourRow(row), bare = Table.value(String(row.spotId), String(line), level, false), blessed = Table.value(String(row.spotId), String(line), level, 2);
    out.shotless = bare && bare.kills > 0 ? Object.fromEntries(SHOTLESS_FIELDS.map(field => [field, bare[field]])) : null;
    if (blessed && blessed.kills > 0) out.blessed = Object.fromEntries(BLESSED_FIELDS.map(field => [field, blessed[field]]));
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
        Roles: invoke('GameServer/Bot/AI/BotRoles'),
        StoreLimits: require('../../src/GameServer/PrivateStoreLimits'),
        Inventory: require('../../src/GameServer/Inventory/InventoryLimits'),
        Valuation: invoke('GameServer/Bot/Economy/EconomicValuation'),
        Grades: require('../../src/GameServer/Bot/AI/GearGradeRule'),
        Exchange: require('../../src/GameServer/World/Generics/NpcExchangeShopLists'),
        Towns: require('../../src/GameServer/World/TownRespawn')
    };
}

// A line's bag: its slots (InventoryLimits.capacity by race and Expand
// Inventory level in its class's tree at 40) and its max load
// (Formulas.calcMaxLoad of its class template's CON).
function bagRow(line, owners) {
    const { Data, Table, Profile, Inventory, Formulas } = owners;
    const classId = Table.roleClass(line, 40), template = Data.classTemplates.find(row => Number(row.classId) === Number(classId));
    const race = Number(template?.template?.race), expand = Profile.skillsFor({ level: 40, stats: { classId } }, classId, 40).find(skill => Number(skill.selfId) === EXPAND_INVENTORY)?.level || 0;
    return { race, slots: Inventory.capacity(race, expand), maxLoad: Math.round(Formulas.calcMaxLoad(Number(template?.base?.con))) };
}

// The items a line's servitor costs a player over a hunt hour (C4 skill data;
// the game spares bots: C4SkillEffects.consumeSkillItems, SummonControl.startLifetime
// and the cold resolver charge them nothing). The summons are the ones its
// reference bot's cold fight casts (HuntCycle.referenceState, the cold
// combat profile): ColdCombatProfile.summonSkills, and a Necromancer's corpse
// summons, in the cold's order (the cold resolver's castable summon: the first
// whose reuse is over and whose MP the bot has, here at full MP); cubics are
// never cast by a bot. Each cast pays its rank's itemCount of itemId and,
// over the servitor's life, itemConsumeSteps payments of itemCountOT of
// itemIdOT (SummonControl's item schedule). The life is the game's own rule
// (SummonControl's life): each second out it loses
// timeLostActive ms while fighting, timeLostIdle ms otherwise (1000 when
// unset; active as idle when unset), so at the hunt row's busy share it lasts
// totalLifeTime / (busy × active + (1 − busy) × idle) seconds. This is the
// upkeep of a servitor kept for its whole life and cast again the moment its
// life ends (or once a reuse ends); a servitor's death in a fight is not
// counted (our reading). Over UPKEEP_WINDOW_S of hunting, a cast whose life
// runs past the window counts by the part inside it, so with one summon
// perHour = 3600 × (itemCount + steps × itemCountOT) / life.
// [{ id, perHour, what: { skill, level, name } }]; [] without a servitor that
// costs items or without a hunt row (busyShare unknown).
function upkeepRow(owners, line, level, busyShare) {
    if (!(busyShare >= 0)) return [];
    const { Table, HuntCycle, Profile, Roles, Data, Index } = owners;
    const classId = Table.roleClass(line, level), profile = Profile.profileFor(HuntCycle.referenceState(classId, level, { line: Number(line) }), 0);
    const casts = [...Profile.summonSkills(profile), ...(Roles.isNecromancer(classId) ? Profile.corpseSummonSkills(profile) : [])]
        .filter(skill => Number(skill.mp || 0) <= Number(profile.maxMp || 0))
        .map(skill => {
            const row = Profile.summonDetails(skill), idle = Number(row.timeLostIdle) || 1000, active = Number(row.timeLostActive) || idle;
            const life = Number(row.totalLifeTime) > 0 ? Number(row.totalLifeTime) / (busyShare * active + (1 - busyShare) * idle) : Infinity;
            const what = { skill: row.skillId, level: row.skillLevel, name: Index.find(Data.skills, row.skillId)?.template?.name || null };
            return { life, reuse: Math.max(0, Number(skill.reuse || 0)) / 1000, what, pays: [[row.itemId, row.itemCount], [row.itemIdOT, row.itemConsumeSteps * row.itemCountOT]] };
        });
    if (!casts.length || casts.some(cast => cast.life === Infinity)) return [];
    const readyAt = casts.map(() => 0), paid = new Map();
    for (let at = 0; at < UPKEEP_WINDOW_S;) {
        const pick = casts.findIndex((_, i) => readyAt[i] <= at);
        if (pick < 0) { at = Math.min(...readyAt); continue; }
        const cast = casts[pick], share = Math.min(1, (UPKEEP_WINDOW_S - at) / cast.life);
        readyAt[pick] = at + cast.reuse;
        for (const [id, count] of cast.pays) if (id > 0 && count > 0) {
            const key = `${id}:${cast.what.skill}`, held = paid.get(key);
            paid.set(key, { id, units: (held?.units || 0) + share * count, what: cast.what });
        }
        at += cast.life;
    }
    return [...paid.values()].map(({ id, units, what }) => ({ id, perHour: units * 3600 / UPKEEP_WINDOW_S, what }));
}

// The level bands of the gear ladder: five levels, cut at each grade's first
// level (GearGradeRule); a band's kit hours are read at its middle level.
function ladderBands(owners) {
    const cuts = [1, ...GRADE_NAMES.map(grade => owners.Grades.levelForGrade(grade)), LEVELS[1] + 1], out = [];
    for (let at = 0; at + 1 < cuts.length; at++) for (let from = cuts[at]; from < cuts[at + 1]; from += 5) out.push([from, Math.min(from + 4, cuts[at + 1] - 1)]);
    return out;
}

// A line's gear ladder per level band (the hunt tables' gear table: each
// class's per-slot ladder without dominated pieces, best first): the rungs a
// main of the band may buy (its grade and below), the band's middle level
// and grade, the line's best spot there (its money scales the band's kit
// hours to the design's, extract).
// [{ from, to, level, grade, best, rungs: { group: [selfId] } }].
function gearLadder(line, owners, gearTable, bands) {
    const { Table, Grades } = owners, out = [];
    const rankOf = new Map(gearTable.items.map(row => [Number(row[0]), Grades.rankOf(row[4])]));
    for (const [from, to] of bands) {
        const level = Math.floor((from + to) / 2), grade = Grades.gradeForLevel(level), rank = Grades.rankOf(grade);
        const best = Table.best(line, level, true, 'income'), gearClass = gearTable.classes.find(row => Number(row.classId) === Number(Table.roleClass(line, level)));
        if (!best || !gearClass) continue;
        const rungs = {};
        for (const [group, ladder] of Object.entries(gearClass.slots)) rungs[group] = ladder.map(([selfId]) => Number(selfId)).filter(selfId => rankOf.get(selfId) <= rank);
        out.push({ from, to, level, grade, best: String(best.spotId), rungs });
    }
    return out;
}

// Luxury (C4 multisell 7097, 7098 where the NPC is spawned): each item's
// crystals, all paid together (the C4 row takes C and D crystals in one
// exchange), and the town the NPC stands in. item -> { npcId, town,
// crystals: [{ selfId, amount }] }.
function luxuryOptions(owners) {
    const { Data, Exchange, Towns } = owners, out = {};
    for (const zone of Data.npcSpawns || []) for (const spawn of zone.spawns || [zone]) {
        const npcId = Number(spawn.selfId), loc = spawn.coords?.[0];
        if (!LUXURY_NPCS.includes(npcId) || !(Number(spawn.total) > 0) || !loc) continue;
        const town = Towns.getClosestTown(loc.locX, loc.locY, loc.locZ)?.name || null;
        for (const row of Exchange.fetchForNpc(npcId)) {
            out[row.result.selfId] ||= { npcId, town, crystals: row.required.map(part => ({ selfId: Number(part.selfId), amount: Number(part.amount) })) };
        }
    }
    return out;
}

// The hours of a death's walk back from each spot (WalkBack over the hunt
// tables' spot centers, design-income.walkBackHours): spotId -> hours.
function walkBack(spots) {
    return Object.fromEntries([...spots.keys()].map(id => [id, DesignIncome.walkBackHours(id, {})]));
}

// The game's trade town of a lot (MarketTownPolicy.targetTownForItems) as
// plain data: each item's market grade (MarketCounters.gradeOf: gear by its
// rank, shots, crystals and gemstones by name, recipes by their product,
// recipe parts by their product's grade; only the graded ones kept), the
// no-grade market of each spot (the policy's rule over the spot card's own
// centre: the nearest of its starter-village markets, nearestNoGradeMarket),
// the policy's D markets (every town its D rule names: a bot picks among
// them by its trip rule) and the town of a lot holding anything of C and
// above. Karma's town is left out (no main of the model has karma).
function tradeTowns(itemIds) {
    const Policy = invoke('GameServer/Bot/Economy/MarketTownPolicy'), Counters = invoke('GameServer/Bot/Economy/MarketCounters');
    const table = readJson('data/Bots/hunt/spots.json'), centerAt = table.spotFields.indexOf('center');
    const grade = {}, none = {}, d = [];
    for (const id of itemIds) { const at = Counters.gradeOf(id); if (at !== 'none') grade[id] = at; }
    for (const row of table.spots) {
        const center = row[centerAt];
        if (!center) throw new Error(`spot card ${row[0]} has no centre: its no-grade market is unknown`);
        none[String(row[0])] = Policy.nearestNoGradeMarket({ locX: center[0], locY: center[1] })?.name || Policy.targetTownForItems({ stats: {} }, [{ rank: 'c' }]);
    }
    for (let bucket = 0; bucket < 100; bucket++) {
        const town = Policy.targetTownForItems({ characterId: bucket, stats: {} }, [{ rank: 'd' }]);
        if (!d.includes(town)) d.push(town);
    }
    return { grade, none, d, higher: Policy.targetTownForItems({ stats: {} }, [{ rank: 'c' }]) };
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
        races: lineRaces(Data), arrowIds: { ...invoke('GameServer/Inventory/ArrowStock').BY_RANK }, crystalIds: { ...owners.Enchant.CRYSTAL_IDS }, luxuryOptions: luxuryOptions(owners), walkBack: walkBack(spots) };
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
// The hours at the spots a save's bots start at (Cohort.savedBots' spotId: the
// spot it stands at, else its travel's, else its stay's): for
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
            at[spotId] = row && row.kills > 0 ? hourRowWithForms({ ...row, spotId }, line, level, Table) : null;
            if (!at[spotId]) continue;
            const key = `${spotId}@${level}`, held = pairs.get(key), skill = Table.roleSpoilLevel(line, level);
            pairs.set(key, { spotId, level, spoilSkill: Math.max(held?.spoilSkill || 0, skill) });
        }
    }
    return { source: save, levelsAhead: SPOT_LEVELS_AHEAD, rows };
}

// Expected units of one item per kill at a spot for a killer of the level:
// its drops by the drop rule and its spoils at the Spoil level times the
// landing chance (spotYields for one item).
function itemYield(entries, id, killerLevel, spoilSkillLevel, owners) {
    const { Planner, Formulas } = owners, total = entries.reduce((sum, entry) => sum + entry.count, 0);
    let out = 0;
    for (const entry of entries) {
        const share = entry.count / total, context = { npcLevel: entry.level, killerLevel };
        out += share * (Planner.itemDropYield(entry.reward, id, 'drop', context).expectedYield || 0);
        if (spoilSkillLevel > 0) {
            const landed = Formulas.spoilSuccessChance({ skillId: 254, skillLevel: spoilSkillLevel, attackerLevel: killerLevel, targetLevel: entry.level });
            out += share * (Planner.itemDropYield(entry.reward, id, 'spoil', context).expectedYield || 0) * landed;
        }
    }
    return out;
}

// The shot recipes' scrolls and the spots whose NPCs drop or spoil each:
// scroll -> [spotId], with each spot's NPC level span.
function scrollSpots(fixed, spots, owners) {
    const { Data, Index } = owners, shotScrolls = new Set();
    for (const row of fixed.recipes) if (Index.find(Data.items, row.productId)?.template?.kind === 'Other.Shot') shotScrolls.add(Number(row.recipeItemId));
    const bySpot = {}, byScroll = {};
    for (const [spotId, spot] of Object.entries(fixed.compositions)) {
        if (!spots.has(spotId)) continue;
        for (const npc of spot.npcs) {
            const reward = fixed.rewards[npc.rewardId];
            if (!reward) continue;
            for (const group of [...reward.rewards, ...reward.spoils]) for (const item of group.items || []) {
                const id = Number(item.selfId);
                if (!shotScrolls.has(id)) continue;
                (byScroll[id] ||= new Set()).add(spotId);
                (bySpot[spotId] ||= new Set()).add(id);
            }
        }
    }
    const span = spotId => { const levels = fixed.compositions[spotId].npcs.map(npc => npc.level); return [Math.min(...levels), Math.max(...levels)]; };
    return { byScroll: Object.fromEntries(Object.entries(byScroll).map(([id, set]) => [id, [...set].sort()])),
        bySpot: Object.fromEntries(Object.entries(bySpot).map(([id, set]) => [id, [...set].sort((a, b) => a - b)])), span };
}

// A line's rows beyond its top spots. Each spot of its top at some level,
// and the scroll spots, keep a row at every level from the first level it is
// a candidate up to the last level the spot table has a row for the line
// there: a main holds the spot it chose until its level leaves the spot's
// range (spot_left). range[spotId] = [lowest, highest] level with a row.
// Returns { others: { level: [row] }, range }.
function moreRows(line, levels, hours, scrolls, owners) {
    const { Table } = owners, rowAt = (spotId, level) => { const row = Table.value(spotId, line, level, true); return row && row.kills > 0 ? row : null; };
    const first = new Map(), range = {};
    for (let level = levels[0]; level <= levels[1]; level++) {
        const hour = hours[level];
        for (const row of [hour.best, ...hour.top]) if (row && !first.has(String(row.spotId))) first.set(String(row.spotId), level);
    }
    // The scroll spots: per scroll and level, the SCROLL_SPOTS that give the most scrolls an hour.
    const entries = new Map(), entriesOf = spotId => { if (!entries.has(spotId)) entries.set(spotId, composition(owners.spots.get(spotId), owners)); return entries.get(spotId); };
    for (const [id, spotIds] of Object.entries(scrolls.byScroll)) {
        const best = {};
        for (const spotId of spotIds) {
            const [low, high] = scrolls.span(spotId);
            for (let level = Math.max(levels[0], low - SCROLL_LEVEL_REACH); level <= Math.min(levels[1], high + SCROLL_LEVEL_REACH); level++) {
                const row = rowAt(spotId, level);
                if (!row) continue;
                const perHour = row.kills * itemYield(entriesOf(spotId), Number(id), level, Table.roleSpoilLevel(line, level), owners);
                if (perHour > 0) (best[level] ||= []).push({ spotId, perHour });
            }
        }
        for (const [level, rows] of Object.entries(best)) {
            for (const { spotId } of rows.sort((a, b) => b.perHour - a.perHour || (a.spotId < b.spotId ? -1 : 1)).slice(0, SCROLL_SPOTS)) {
                if (!first.has(spotId) || first.get(spotId) > Number(level)) first.set(spotId, Number(level));
            }
        }
    }
    const others = {};
    for (const [spotId, from] of first) {
        let low = from, high = from;
        while (low > LEVELS[0] && rowAt(spotId, low - 1)) low--;
        while (high < LEVELS[1] && rowAt(spotId, high + 1)) high++;
        if (!rowAt(spotId, from)) continue;
        range[spotId] = [low, high];
        for (let level = from; level <= Math.min(high, levels[1]); level++) {
            const hour = hours[level];
            if (hour.top.some(row => String(row.spotId) === spotId)) continue;
            const row = hourRowWithForms({ ...rowAt(spotId, level), spotId }, line, level, Table);
            (others[level] ||= []).push(scrolls.bySpot[spotId] ? { ...row, scrolls: scrolls.bySpot[spotId] } : row);
        }
    }
    return { others, range };
}

function extract({ preset, lines = null, levels = LEVELS, x1Offers = null, base = null, spots: save = null } = {}) {
    const owners = gameOwners(), { Table, Data, Index, Enchant, Sell, Rates } = owners;
    if (!x1Offers) { Boot.usePreset('x1'); x1Offers = npcOffers(owners); }
    Boot.usePreset(preset);
    const spots = rewardSpots(), fixed = base || staticInputs(owners, spots);
    const hours = {}, kits = {}, pairs = new Map(), bags = {}, ladders = {}, spotLevels = {}, upkeep = {};
    const scrolls = scrollSpots(fixed, spots, owners), more = { ...owners, spots };
    const gearTable = readJson('data/Bots/hunt/gear.json'), bands = ladderBands(owners).filter(([from, to]) => to >= levels[0] && from <= levels[1]);
    for (const line of lines || Table.roles()) {
        hours[line] = {}; kits[line] = {};
        bags[line] = bagRow(line, owners);
        ladders[line] = gearLadder(line, owners, gearTable, bands);
        for (const row of ladders[line]) {
            const key = `${row.best}@${row.level}`, held = pairs.get(key);
            pairs.set(key, { spotId: row.best, level: row.level, spoilSkill: Math.max(held?.spoilSkill || 0, Table.roleSpoilLevel(line, row.level)) });
        }
        for (let level = levels[0]; level <= levels[1]; level++) {
            const best = Table.best(line, level, true, 'income');
            const top = Table.rankedIncome(line, level).slice(0, TOP_SPOTS);
            const classId = Table.roleClass(line, level);
            kits[line][level] = KitHours.lineKit(owners, line, level);
            hours[line][level] = { classId, shotId: Capacity.referenceShot(classId, level, line),
                best: best && hourRowWithForms(best, line, level, Table), top: top.map(row => hourRowWithForms(row, line, level, Table)) };
            const due = upkeepRow(owners, line, level, best?.busyShare);
            if (due.length) (upkeep[line] ||= {})[level] = due;
            const skill = Table.roleSpoilLevel(line, level);
            for (const row of [best, ...top]) if (row) {
                const key = `${row.spotId}@${level}`, held = pairs.get(key);
                pairs.set(key, { spotId: String(row.spotId), level, spoilSkill: Math.max(held?.spoilSkill || 0, skill) });
            }
        }
        const { others, range } = moreRows(line, levels, hours[line], scrolls, more);
        spotLevels[line] = range;
        for (const [key, rows] of Object.entries(others)) {
            const level = Number(key), skill = Table.roleSpoilLevel(line, level);
            hours[line][level].others = rows;
            for (const row of rows) {
                const pair = `${row.spotId}@${level}`, held = pairs.get(pair);
                pairs.set(pair, { spotId: String(row.spotId), level, spoilSkill: Math.max(held?.spoilSkill || 0, skill) });
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
    for (const rows of Object.values(ladders)) for (const row of rows) for (const ids of Object.values(row.rungs)) ids.forEach(add);
    for (const byLevel of Object.values(hours)) for (const hour of Object.values(byLevel)) add(hour.shotId);
    Object.keys(offers).forEach(add); Object.keys(x1Offers).forEach(add);
    Object.values(Enchant.CRYSTAL_IDS).forEach(add);
    Object.values(fixed.arrowIds).forEach(add);
    for (const byLevel of Object.values(upkeep)) for (const rows of Object.values(byLevel)) rows.forEach(row => add(row.id));
    const items = {};
    for (const id of [...ids].sort((a, b) => a - b)) {
        const item = Index.find(Data.items, id);
        if (!item) continue;
        const ref = Number(item.template?.price || 0), kind = item.template?.kind || null;
        // An NPC buys no quest item (copies the unexported itemPrice of SpotRewardExpectation).
        items[id] = { name: item.template?.name || null, kind, grade: item.etc?.rank ? Enchant.gradeOf(item.etc) : 'NONE', ref,
            npcBuy: kind === 'Other.Quest' ? 0 : Sell.npcBuyPrice(ref), crystals: Enchant.crystalCount(item.etc), weight: Number(item.template?.mass || 0) };
    }
    // A band's scale: the design's money per kill over today's at the band's
    // best spot (adena and loot at the NPC's buy price; 1 where today's is 0),
    // which turns the band's kit hours at the preset into the design's money.
    const moneyOf = row => Object.entries(row?.drop || {}).concat(Object.entries(row?.spoil || {}))
        .reduce((sum, [id, count]) => sum + count * (Number(id) === 57 ? 1 : items[id]?.npcBuy || 0), 0);
    const gearLadders = {};
    for (const [line, rows] of Object.entries(ladders)) {
        gearLadders[line] = rows.map(row => {
            const key = `${row.best}@${row.level}`, today = moneyOf(yields[key]), scale = today > 0 && yieldsDesign[key] ? moneyOf(yieldsDesign[key]) / today : 1;
            return { ...row, scale };
        });
    }
    const slots = {};
    for (const row of gearTable.items) if (items[row[0]]) slots[row[0]] = Number(row[3]);
    const { quests, ...kept } = fixed;
    const trade = tradeTowns(Object.keys(items).map(Number));
    return {
        header: { schema: SCHEMA, preset, rates: Rates.profile(), levels: [levels[0], levels[1]], quests, notes: NOTES },
        hours, spotLevels, kits, yields, yieldsDesign, items, npcOffers: { preset: offers, x1: x1Offers }, ...kept, ...(spotRows ? { spotHours: spotRows } : {}), bags, upkeep, gearLadder: { bands, slots, lines: gearLadders }, tradeTowns: trade,
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

// The tree files read through fs are part of the stamp beside the modules
// loaded: reads are recorded from before the boot to the last extract.
function main(argv) {
    const reads = Boot.recordReads();
    try { build(argv, reads); } finally { reads.stop(); }
}

function build(argv, reads) {
    const presets = Boot.presetsOption(argv);
    const out = path.resolve(Boot.option(argv, 'out', path.join(Boot.root, 'tmp', 'economy-model')));
    Boot.boot('x1');
    const startedAt = Date.now();
    const revision = gitRevision();
    const owners = gameOwners();
    // NPC prices at x1 ride in every snapshot: the design's NPC prices at every preset.
    const x1Offers = npcOffers(owners), base = staticInputs(owners, rewardSpots());
    fs.mkdirSync(out, { recursive: true });
    for (const preset of presets) {
        const began = Date.now();
        const snapshot = extract({ preset, x1Offers, base, spots: Boot.option(argv, 'spots', null) });
        // The files the extract has loaded or read by now are the ones it
        // used: the stamp a run checks the live game data against.
        const sourceFiles = [...new Set([...Boot.loadedFiles(), ...reads.files()])].sort(), { fingerprint, spotTable, sources } = Boot.dataStamp(sourceFiles);
        snapshot.header = { ...snapshot.header, fingerprint, spotTable, sources, sourceFiles, revision };
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

module.exports = { extract, rewardSpots, spotYields, composition, HOUR_FIELDS, SHOTLESS_FIELDS, BLESSED_FIELDS, SCHEMA };
