'use strict';

// A hunting hour's income under the design's drop rule and rates against
// today's, from the economy model's snapshots: per level band, class-weighted,
// at each line's best spot of today's preset, adena and loot at the NPC's buy
// price (x1). And the rare drop question: recipe scrolls dropped and spoiled
// per hunting hour today against the rule.
//
//   node scripts/economy-model/design-income.js [--dir <snapshots>] [--preset x1,x10,x50]
//
// The snapshots are inputs.js's (default tmp/economy-model in the tree). Today
// is read twice: the spot table's hour (its measured kill mix) and the
// snapshot's per-kill yields at the spot's spawn mix times the hour's kills.
// The design is computed at that spawn mix and those kills, so "design/today"
// compares like with like. The spots hold normal NPCs only (the snapshot's
// compositions leave raid bosses, epics and their minions out, as the spot
// value does), so every NPC here rolls at the normal rates.
//
// Last, recipes per other dropped item over every normal NPC (one kill each,
// no deep blue): today at x1 and x50 against the rule, which keeps the x1
// share at any rate.

const fs = require('fs');
const path = require('path');
const Boot = require('./boot');
const Weights = require('./weights');
const { fmt } = require('./capacity');
const { dropRule, npcKind, DESIGN_RATES } = require('./rules/dropRule');

// Where inputs.js writes the snapshots by default.
const SNAPSHOT_DIR = path.join(Boot.root, 'tmp', 'economy-model');
const BANDS = Object.freeze([[20, 29], [30, 39], [40, 51], [52, 60], [61, 75]]);
const ADENA = 57, SPOIL_SKILL = 254;

// The snapshot of a preset whose stamp equals the live game data's
// (Boot.stampMatches): the file named, else the first such in dir by name.
// None: the run refuses, with the command that builds one.
function loadSnapshot(dir, preset, file = null) {
    const build = `node scripts/economy-model/inputs.js --preset ${preset}`;
    const files = file ? [path.resolve(file)] : (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
        .filter(name => name.startsWith(`inputs-${preset}-`) && name.endsWith('.json')).sort().map(name => path.join(dir, name));
    for (const candidate of files) {
        const snapshot = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (Boot.stampMatches(snapshot.header)) return { file: candidate, snapshot };
    }
    throw new Error(file ? `${file} is not a snapshot of the live game data (its stamp differs); build one: ${build}`
        : `no inputs-${preset}-*.json in ${dir} is a snapshot of the live game data (${files.length} with another stamp); build one: ${build}`);
}

// The game's deep-blue penalty and spoil landing, the drop rule's arguments.
// Needs Boot.boot().
function gameRules() {
    const Rates = invoke('GameServer/ProgressionRates'), Formulas = invoke('GameServer/Formulas');
    const landed = new Map();
    return {
        penalty: (npcLevel, killerLevel) => Rates.deepBlueRule({ npcLevel, killerLevel }),
        landed: (skillLevel, attackerLevel, targetLevel) => {
            const key = `${skillLevel}:${attackerLevel}:${targetLevel}`;
            if (!landed.has(key)) landed.set(key, Formulas.spoilSuccessChance({ skillId: SPOIL_SKILL, skillLevel, attackerLevel, targetLevel }));
            return landed.get(key);
        }
    };
}

// The hours a death's walk back from a spot takes: the server's own
// WalkBack.hours (the landing town's run to the spot) over the hunt tables'
// spot centers (data/Bots/hunt/spots.json, built with geodata). Offline there
// is no live spot catalogue, so WalkBack's default answers 0. 0 for a spot
// without a center.
let walkSpots = null;
function walkBackHours(spotId, state = {}) {
    if (!walkSpots) {
        const table = JSON.parse(fs.readFileSync(path.join(Boot.root, 'data', 'Bots', 'hunt', 'spots.json'), 'utf8'));
        const at = table.spotFields.indexOf('center');
        walkSpots = table.spots.filter(row => row[at]).map(row => ({ id: row[0], center: { locX: row[at][0], locY: row[at][1], locZ: row[at][2] } }));
    }
    return require('../../src/GameServer/Bot/Economy/WalkBack').hours(spotId, state, walkSpots);
}

// Expected items per kill at a spot under the design rule: { drop, spoil }
// item -> count, the spot's spawns weighted by count, spoils with Spoil
// landed at the spoiler's skill level (0: none).
function designYields(snapshot, spotId, level, spoilSkill, rates, game) {
    const spot = snapshot.compositions[spotId], drop = {}, spoil = {};
    if (!spot) return null;
    const npcs = spot.npcs.filter(npc => npc.rewardId !== null && snapshot.rewards[npc.rewardId]);
    const total = npcs.reduce((sum, npc) => sum + npc.count, 0);
    for (const npc of npcs) {
        const reward = snapshot.rewards[npc.rewardId], share = npc.count / total, penalty = game.penalty(npc.level, level);
        for (const group of reward.rewards) {
            for (const [id, count] of Object.entries(dropRule({ group, kind: 'drop', rates, penalty }))) drop[id] = (drop[id] || 0) + share * count;
        }
        if (!(spoilSkill > 0)) continue;
        const landed = game.landed(spoilSkill, level, npc.level);
        for (const group of reward.spoils) {
            for (const [id, count] of Object.entries(dropRule({ group, kind: 'spoil', rates, penalty }))) spoil[id] = (spoil[id] || 0) + share * count * landed;
        }
    }
    return { drop, spoil };
}

// Adena, loot at the NPC's buy price and recipe scrolls of per-kill yields.
function money(yields, items) {
    const out = { adena: 0, loot: 0, recipesDrop: 0, recipesSpoil: 0 };
    for (const kind of ['drop', 'spoil']) for (const [id, count] of Object.entries(yields[kind])) {
        if (Number(id) === ADENA) { out.adena += count; continue; }
        const item = items[id];
        out.loot += count * (item?.npcBuy || 0);
        if (item?.kind === 'Other.Recipe') out[kind === 'drop' ? 'recipesDrop' : 'recipesSpoil'] += count;
    }
    return out;
}

// Recipe scrolls per other item (adena left out) dropped and spoiled over
// every normal NPC's reward, one kill each without deep blue: today
// (GearAcquisitionPlanner.itemDropYield, the spot value's yield) at the
// presets given and the rule at the design's x1 and x50. Switches the
// preset; leaves x1.
function recipeShares(presets) {
    const Data = invoke('GameServer/DataCache'), Index = require('../../src/GameServer/Item/ItemTemplateIndex');
    const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
    const rewards = Data.npcRewards.filter(reward => { const npc = Index.find(Data.npcs, reward.selfId); return npc && npcKind(npc) === 'normal'; });
    const recipe = id => Index.find(Data.items, id)?.template?.kind === 'Other.Recipe';
    const share = yieldOf => {
        const sum = { drop: [0, 0], spoil: [0, 0] };
        for (const reward of rewards) for (const kind of ['drop', 'spoil']) {
            for (const [id, count] of Object.entries(yieldOf(reward, kind))) if (Number(id) !== ADENA) sum[kind][recipe(Number(id)) ? 0 : 1] += count;
        }
        return { drop: sum.drop[0] / sum.drop[1], spoil: sum.spoil[0] / sum.spoil[1], normal: rewards.length };
    };
    const today = {}, rule = {};
    for (const preset of presets) {
        Boot.usePreset(preset);
        today[preset] = share((reward, kind) => {
            const out = {};
            for (const group of reward[kind === 'spoil' ? 'spoils' : 'rewards'] || []) for (const item of group.items || []) out[item.selfId] ??= Planner.itemDropYield(reward, item.selfId, kind, {}).expectedYield;
            return out;
        });
    }
    Boot.usePreset('x1');
    for (const preset of ['x1', 'x50']) rule[preset] = share((reward, kind) => {
        const out = {};
        for (const group of reward[kind === 'spoil' ? 'spoils' : 'rewards'] || []) {
            for (const [id, count] of Object.entries(dropRule({ group, kind, rates: DESIGN_RATES[preset] }))) out[id] = (out[id] || 0) + count;
        }
        return out;
    });
    return { today, rule };
}

const scale = (row, factor) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value * factor]));

// One line's hunting hour at a level: today's best spot at the snapshot's
// preset; table (the spot table's adena and loot), today and design (per-kill
// yields at the spawn mix times the hour's kills). null without a spot row.
function designHour(snapshot, line, level, rates, game) {
    const best = snapshot.hours[line]?.[level]?.best;
    const today = best && snapshot.yields[`${best.spotId}@${level}`];
    if (!today) return null;
    const design = designYields(snapshot, best.spotId, level, today.spoilSkill, rates, game);
    if (!design) return null;
    return { spotId: best.spotId, kills: best.kills, exp: best.exp, table: { adena: best.adena, loot: best.loot },
        today: scale(money(today, snapshot.items), best.kills), design: scale(money(design, snapshot.items), best.kills) };
}

// Class-weighted mean of a band's hours (levels evenly).
function bandHour(snapshot, band, rates, game) {
    const sum = { table: { adena: 0, loot: 0 }, today: {}, design: {} };
    let weight = 0, missing = 0;
    for (let level = band[0]; level <= band[1]; level++) {
        for (const [line, share] of Object.entries(Weights.CLASS_WEIGHTS)) {
            if (!(share > 0)) continue;
            const hour = designHour(snapshot, line, level, rates, game);
            if (!hour) { missing += share; continue; }
            weight += share;
            for (const part of ['table', 'today', 'design']) for (const [key, value] of Object.entries(hour[part])) sum[part][key] = (sum[part][key] || 0) + share * value;
        }
    }
    for (const part of ['table', 'today', 'design']) sum[part] = scale(sum[part], weight > 0 ? 1 / weight : 0);
    return { ...sum, missingShare: missing / (missing + weight || 1) };
}

function main(argv) {
    const dir = path.resolve(Boot.option(argv, 'dir', SNAPSHOT_DIR));
    const presets = Boot.presetsOption(argv), startedAt = Date.now();
    Boot.boot('x1');
    const game = gameRules(), recipes = [];
    console.log('Hunting hour per bot, class-weighted, at each line\'s best spot of today\'s preset; loot at the NPC buy price (x1).');
    console.log('table = the spot table\'s hour; today and design = per-kill yields at the spot\'s spawn mix x the hour\'s kills.');
    for (const preset of presets) {
        const { file, snapshot } = loadSnapshot(dir, preset), rates = DESIGN_RATES[preset];
        process.stderr.write(`[${preset}] ${file}\n`);
        const today = snapshot.header.rates;
        console.log(`\n[${preset}] design rates adena ${rates.adena} drop ${rates.drop} spoil ${rates.spoil}; today adena ${today.adena} drop ${today.drop} spoil ${today.spoil}`);
        console.log('band   table adena+loot | today adena  loot | design adena  loot | design/today adena loot total');
        for (const band of BANDS) {
            const hour = bandHour(snapshot, band, rates, game);
            const ratio = (a, b) => b > 0 ? (a / b).toFixed(2) : '-';
            const totalToday = hour.today.adena + hour.today.loot, totalDesign = hour.design.adena + hour.design.loot;
            console.log(`${band.join('-').padEnd(6)} ${fmt(hour.table.adena)}+${fmt(hour.table.loot)} | ${fmt(hour.today.adena)} ${fmt(hour.today.loot)} | `
                + `${fmt(hour.design.adena)} ${fmt(hour.design.loot)} | ${ratio(hour.design.adena, hour.today.adena)} ${ratio(hour.design.loot, hour.today.loot)} `
                + `${ratio(totalDesign, totalToday)}${hour.missingShare > 0.001 ? ` (no spot row for ${(hour.missingShare * 100).toFixed(1)} % of the weight)` : ''}`);
            recipes.push({ preset, band, today: hour.today, design: hour.design });
        }
    }
    console.log('\nRecipe scrolls per hunting hour per bot (drop + spoil; spoil is the Bounty Hunters\' 8 % of the weight):');
    console.log('band   preset  today drop spoil | rule drop spoil | rule/today drop');
    for (const { preset, band, today, design } of recipes) {
        console.log(`${band.join('-').padEnd(6)} ${preset.padEnd(7)} ${fmt(today.recipesDrop)} ${fmt(today.recipesSpoil)} | ${fmt(design.recipesDrop)} ${fmt(design.recipesSpoil)} | `
            + `${today.recipesDrop > 0 ? (design.recipesDrop / today.recipesDrop).toFixed(2) : '-'}`);
    }
    const shares = recipeShares(['x1', 'x50']), per = value => `${(value * 1000).toFixed(2)}`;
    const ratio = (a, b) => (a / b).toFixed(2);
    console.log(`\nRecipes per 1000 other items over ${shares.today.x1.normal} normal NPCs (one kill each, no deep blue): `
        + `drop today x1 ${per(shares.today.x1.drop)}, today x50 ${per(shares.today.x50.drop)} (${ratio(shares.today.x50.drop, shares.today.x1.drop)} of x1), `
        + `rule ${per(shares.rule.x1.drop)} at x1 and ${per(shares.rule.x50.drop)} at x50 (rule/today at x50 ${ratio(shares.rule.x50.drop, shares.today.x50.drop)}); `
        + `spoil today x1 ${per(shares.today.x1.spoil)}, x50 ${per(shares.today.x50.spoil)}, rule ${per(shares.rule.x1.spoil)} / ${per(shares.rule.x50.spoil)}.`);
    process.stderr.write(`done in ${((Date.now() - startedAt) / 1000).toFixed(1)} s\n`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { designYields, gameRules, loadSnapshot, SNAPSHOT_DIR, walkBackHours };
