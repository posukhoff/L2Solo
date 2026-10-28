'use strict';

const Data = invoke('GameServer/DataCache');
const Rates = invoke('GameServer/ProgressionRates');
const Index = require('../../Item/ItemTemplateIndex');
const Drops = require('../Population/BackgroundDropResolver');
const Kill = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Formulas = invoke('GameServer/Formulas');
const Diagnostics = require('./EconomyDiagnostics');

const MAX_NPC_VALUES = 16384;
const MAX_SPOT_VALUES = 32768;
// The inputs the held values were computed from; module variables, no array per check.
let heldRates, heldNpcs, heldNpcCount, heldRewards, heldRewardCount, heldItems, heldItemCount, heldSkills, heldSkillCount;
let revisionId = 0;
let compositions = new WeakMap();
let spotValues = new WeakMap();
let spotValueCount = 0;
// The held spot rows in insertion order, as [rows, key] pairs flat: at the
// cap the oldest one row leaves, not all of them (a wipe re-measured the
// whole atlas at once). At most 2 x MAX_SPOT_VALUES slots, ~512 KB.
let spotValueOrder = [];
let spotValueNext = 0;
let rewardGroups = new WeakMap();
const npcValues = new Map();
const NO_ENTRIES = Object.freeze([]);

// rates: the profile a caller read a moment earlier in the same synchronous
// call (SpotValueTable), so one rate read serves both revision checks (L75).
function refresh(rates = Rates.profile()) {
    if (rates === heldRates && Data.npcs === heldNpcs && Data.npcs?.length === heldNpcCount
        && Data.npcRewards === heldRewards && Data.npcRewards?.length === heldRewardCount
        && Data.items === heldItems && Data.items?.length === heldItemCount
        && Data.skills === heldSkills && Data.skills?.length === heldSkillCount) return;
    heldRates = rates; heldNpcs = Data.npcs; heldNpcCount = Data.npcs?.length;
    heldRewards = Data.npcRewards; heldRewardCount = Data.npcRewards?.length;
    heldItems = Data.items; heldItemCount = Data.items?.length;
    heldSkills = Data.skills; heldSkillCount = Data.skills?.length;
    revisionId++;
    compositions = new WeakMap();
    spotValues = new WeakMap();
    spotValueCount = 0;
    spotValueOrder = [];
    spotValueNext = 0;
    rewardGroups = new WeakMap();
    npcValues.clear();
}

// Use the same defeated-NPC reward mapping as native cold kills, including
// world/datapack ID aliases. Never choose a reward variant by a field name.
// One row per spot: the entries the cold kill picks from
// (ColdCombatProfile.npcForSpot: huntable, no protected raid), each with the
// reward row its kill rolls (BackgroundDropResolver.rewardDataForSpot: own
// id, else same name) and its share of an untargeted kill
// (ColdCombatProfile.killDraw/killChances), the share per reward row
// (killShare) and the targeted shares read so far (one per reward row).
// Planning knows no hunter: no matchup filter, efficiency 1 (the roll
// weighs an entry by the hunters' matchup efficiency squared, and drops the
// ones they cannot fight); a targeted share is exact but for that filter.
function heldComposition(spot) {
    let held = compositions.get(spot);
    if (held) return held;
    const Policy = invoke('GameServer/Bot/AI/BotHuntingTargetPolicy');
    const entries = spot.npcEntries?.length ? spot.npcEntries
        : (spot.npcSelfIds || []).map(selfId => ({ selfId, count: 1 }));
    const nativeSpot = spot.npcNames?.length ? spot : { ...spot, npcNames: entries
        .map(entry => Index.find(Data.npcs, entry.selfId)?.template?.name).filter(Boolean) };
    const rows = entries.flatMap(entry => {
        const npc = Index.find(Data.npcs, entry.selfId);
        if (!npc || !Policy.canHunt(npc)
            || invoke('GameServer/Bot/AI/BotRaidSafety').isProtectedRaidEntity(npc)) return [];
        return [{ selfId: Number(entry.selfId), level: Number(npc.template?.level || 1),
            count: Math.max(1, Number(entry.count) || 1), share: 0,
            reward: Drops.rewardDataForSpot(nativeSpot, () => 0, entry.selfId) }];
    });
    const chances = Kill.killChances(Kill.killDraw(rows, rows));
    for (const { entry, chance } of chances) entry.share += chance;
    held = { entries: rows, byReward: sharesByReward(chances), targeted: new Map() };
    compositions.set(spot, held);
    return held;
}

function sharesByReward(chances) {
    const shares = new Map();
    for (const { entry, chance } of chances) {
        if (entry.reward) shares.set(entry.reward, (shares.get(entry.reward) || 0) + chance);
    }
    return shares;
}

// The NPCs a kill at the spot is drawn from, as the cold kill draws:
// [{ selfId, level, count, share, reward }], share = the entry's chance to be
// an untargeted kill.
function composition(spot) {
    if (!spot || typeof spot !== 'object') return NO_ENTRIES;
    refresh();
    return heldComposition(spot).entries;
}

// The share of the spot's kills credited to one reward row (a native
// npcRewards row): how often a kill here rolls this loot table, read from
// the kill draw's owner (ColdCombatProfile.killDraw). targeted: the kill
// aims at the row's NPC (reward.selfId) as a direct-drop plan or a material
// party does (npcForSpot preferredNpcId); a row whose NPC is not on the spot
// (found by name only) gets the untargeted share, as the roll does. 0 for a
// row no huntable NPC of the spot rolls.
function killShare(spot, reward, { targeted = false } = {}) {
    if (!spot || typeof spot !== 'object' || !reward) return 0;
    refresh();
    const held = heldComposition(spot);
    if (!targeted) return held.byReward.get(reward) || 0;
    let share = held.targeted.get(reward);
    if (share === undefined) {
        share = sharesByReward(Kill.killChances(Kill.killDraw(held.entries, held.entries,
            { preferredNpcId: reward.selfId }))).get(reward) || 0;
        held.targeted.set(reward, share);
    }
    return share;
}

// The chance a spoiler's Spoil (skill 254 at its learned level) lands on an
// NPC of npcLevel: the cold kill's roll (ColdKillRewards) as an expectation.
function spoilLanding(skillLevel, spoilerLevel, npcLevel) {
    return Formulas.spoilSuccessChance({ skillId: 254, skillLevel, attackerLevel: spoilerLevel, targetLevel: npcLevel });
}

function itemPrice(itemId) {
    return !sellable(itemId) ? 0
        // lazy: cycle PriceDecision's chain loads this module
        : invoke('GameServer/Bot/Economy/PriceDecision').buyback(itemId);
}

// An item a hunter can sell: known and no quest item (ItemDisposition.isQuestItem).
function sellable(itemId) {
    const item = Index.find(Data.items, itemId);
    // lazy: cycle ItemDisposition's chain loads this module
    return !!item && !invoke('GameServer/Bot/Economy/ItemDisposition').isQuestItem({ selfId: itemId }, item);
}

function groupsFor(reward) {
    if (!reward) return [];
    let groups = rewardGroups.get(reward);
    if (groups) return groups;
    groups = [];
    for (const kind of ['drop', 'spoil']) for (const group of reward[kind === 'drop' ? 'rewards' : 'spoils'] || []) {
        const rate = Rates.groupRate(group, kind), items = group.items || [];
        const total = kind === 'drop' ? items.reduce((sum, item) =>
            sum + Rates.dropItemSelectionWeight(group, item, rate), 0) : 0;
        // rows: every item a drop or spoil group yields but adena and quest
        // items, [id, units] per landed roll (game data; their NPC price is
        // in items, the demand premium over it is lootPremium's).
        const expected = { group, kind, adena: 0, items: 0, rows: null };
        for (const item of items) {
            let share, amount;
            if (kind === 'drop') {
                share = total > 0 ? Rates.dropItemSelectionWeight(group, item, rate) / total : 0;
                amount = Rates.expectedDropAmount(group, item, rate);
            } else {
                // The group's amountMultiplier is applied by npcValue.
                share = Rates.spoilItemChance(item);
                const min = Math.max(1, Math.floor(Number(item.min) || 1));
                amount = (min + Math.max(min, Math.floor(Number(item.max) || min))) / 2;
            }
            if (kind === 'drop' && Number(item.selfId) === 57) expected.adena += share * amount;
            else expected.items += share * amount * itemPrice(item.selfId);
            if (share > 0 && Number(item.selfId) !== 57 && sellable(item.selfId))
                (expected.rows ||= []).push(Number(item.selfId), share * amount);
        }
        groups.push(expected);
    }
    rewardGroups.set(reward, groups);
    return groups;
}

// Analytical expectation of the native group roll, category selection and
// high-rate amount overflow. One pass per group; no random draws or combat.
function npcValue(entry, killerLevel) {
    const rule = Rates.deepBlueRule({ npcLevel: entry.level, killerLevel });
    const key = `${entry.selfId}:${entry.reward?.selfId || 0}:${rule.active ? rule.penaltyPercent : 0}`;
    let held = npcValues.get(key);
    if (held) return held;
    // drop / spoil items: id, units per kill pairs per roll that lands
    // (spoils before the spoiler's landing chance, heldValue).
    held = { adena: 0, drop: 0, spoil: 0, dropItems: null, spoilItems: null };
    for (const expected of groupsFor(entry.reward)) {
        const roll = Rates.rewardGroupRoll(expected.group, expected.kind,
            { npcLevel: entry.level, killerLevel }, () => 0);
        const chance = roll.chance / 100;
        held.adena += chance * expected.adena;
        held[expected.kind] += chance * expected.items * (expected.kind === 'spoil' ? roll.amountMultiplier : 1);
        const kept = expected.kind === 'spoil' ? 'spoilItems' : 'dropItems';
        const rows = expected.rows || [];
        for (let at = 0; at < rows.length; at += 2)
            (held[kept] ||= []).push(rows[at], chance * rows[at + 1] * (expected.kind === 'spoil' ? roll.amountMultiplier : 1));
    }
    if (npcValues.size >= MAX_NPC_VALUES) npcValues.delete(npcValues.keys().next().value);
    npcValues.set(key, held);
    return held;
}

// Spawn-weighted rewards per kill. The NPC's own level controls Deep Blue;
// the spoiler's learned skill controls landing, independently of the killer.
function value(spot, killerLevel, options) {
    const held = heldValue(spot, killerLevel, options);
    return held ? { ...held } : null;
}
function heldValue(spot, killerLevel, { spoilSkillLevel = 0, spoilerLevel = killerLevel } = {}) {
    if (!spot || typeof spot !== 'object') return null;
    const rates = Rates.profile();
    refresh(rates);
    const key = `${killerLevel}:${spoilSkillLevel}:${spoilSkillLevel > 0 ? spoilerLevel : 0}`;
    let rows = spotValues.get(spot);
    if (rows?.has(key)) return rows.get(key);
    const { entries } = heldComposition(spot);
    if (!entries.length) return null;
    const held = { adena: 0, drop: 0, spoil: 0 };
    eachEntry(entries, killerLevel, spoilSkillLevel, spoilerLevel, (entry, reward, spoilShare) => {
        // Native ColdKillRewards uses this fallback only when no reward data
        // exists. It must not fabricate ordinary loot for that NPC.
        held.adena += entry.share * (entry.reward ? reward.adena
            : (Number(spot.rewards?.adenaMin || 0) + Number(spot.rewards?.adenaMax || 0)) / 2 * rates.adena);
        held.drop += entry.share * reward.drop;
        held.spoil += spoilShare * reward.spoil;
    });
    if (spotValueCount >= MAX_SPOT_VALUES) {
        // A ring: the slot of the oldest held row takes the new one.
        spotValueOrder[spotValueNext].delete(spotValueOrder[spotValueNext + 1]);
        spotValueCount--;
        Diagnostics.count('spot_reward', 'evict', 'oldest');
    }
    if (!rows) { rows = new Map(); spotValues.set(spot, rows); }
    rows.set(key, held);
    spotValueCount++;
    spotValueOrder[spotValueNext] = rows;
    spotValueOrder[spotValueNext + 1] = key;
    spotValueNext = (spotValueNext + 2) % (2 * MAX_SPOT_VALUES);
    return held;
}

// The spot's NPCs as a kill rolls them, for heldValue and lootPremium alike:
// visit(entry, reward, spoilShare) with the entry's rewards at killerLevel
// (npcValue) and the share of the spot's kills its spoil lands on (its share
// x the spoiler's landing; 0 with no Spoil).
function eachEntry(entries, killerLevel, spoilSkillLevel, spoilerLevel, visit) {
    for (const entry of entries) visit(entry, npcValue(entry, killerLevel),
        spoilSkillLevel > 0 ? entry.share * spoilLanding(spoilSkillLevel, spoilerLevel, entry.level) : 0);
}

// What one kill's items fetch over their NPC price, as value() rolls them:
// each drop (and, by the spoiler's landing, spoil) item's units x
// premiumOf(id) (DemandPrice: the demand price over the buy-back). The item
// rows live per NPC (npcValue), none per spot key: the caller keeps the sum
// (SpotValueTable.marketLoot).
function lootPremium(spot, killerLevel, premiumOf, { spoilSkillLevel = 0, spoilerLevel = killerLevel } = {}) {
    if (!spot || typeof spot !== 'object') return 0;
    refresh();
    let total = 0;
    const add = (rows, scale) => {
        for (let at = 0; rows && scale > 0 && at < rows.length; at += 2) {
            const premium = premiumOf(rows[at]);
            if (premium > 0) total += scale * rows[at + 1] * premium;
        }
    };
    eachEntry(heldComposition(spot).entries, killerLevel, spoilSkillLevel, spoilerLevel, (entry, reward, spoilShare) => {
        add(reward.dropItems, entry.share);
        add(reward.spoilItems, spoilShare);
    });
    return total;
}

// One raid boss kill's expected adena and item value for the party (the boss
// is left out of value(): a protected raid entity), the same group rolls and
// Deep Blue rule at `killerLevel`; held in npcValues like every NPC.
function raidReward(spot, killerLevel) {
    const id = Number(spot?.raidBossTemplateId);
    if (!(id > 0)) return 0;
    refresh();
    const npc = Index.find(Data.npcs, id);
    const reward = npc ? Drops.rewardDataForSpot(spot, () => 0, id) : null;
    if (!reward) return 0;
    const held = npcValue({ npcId: id, level: Number(npc.template?.level || 1), reward }, killerLevel);
    return held.adena + held.drop;
}

function spoilSkillLevel(state) {
    return Number(invoke('GameServer/Bot/Population/ColdCombatProfile').skillsFor(state)
        .find(skill => Number(skill.selfId) === 254)?.level || 0);
}

module.exports = { value, lootPremium, itemPrice, composition, killShare, spoilLanding, raidReward, spoilSkillLevel, revision(rates) { refresh(rates); return revisionId; }, MAX_NPC_VALUES, MAX_SPOT_VALUES };
