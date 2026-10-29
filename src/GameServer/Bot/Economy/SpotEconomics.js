'use strict';
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const SpotRewardExpectation = require('./SpotRewardExpectation');
const KillRewards = invoke('GameServer/Bot/Population/ColdKillRewards');
// Shared table evaluation: native facts, own samples and the market's demand
// price of the items a spot drops or spoils (SpotValueTable.marketLoot:
// DemandPrice over the NPC price, decisions 10-28). It never reads Context,
// a board or a bot's pricing, so route and wish readers cannot recurse, and
// no build subscribes to an item's price. The premium is real income: it
// enters the row's loot, so the income route (EquipmentIncomeRoute.select)
// and the hour value read it.
function moneyWeight(state) {
    const packet = state.stats?.money;
    if (Array.isArray(packet)) {
        const gapPrice = Number(packet[3]);
        return Number.isFinite(gapPrice) && gapPrice > 0 ? 1 : 0;
    }
    const focus = state.stats?.wishFocus;
    const price = Array.isArray(focus) ? Number(focus[2]) : 0;
    return Number.isFinite(price) && price > Math.max(0, Number(state.adena) || 0) ? 1 : 0;
}

// hunt: the build's own hunt (EconomyContext), so one build reads one hour;
// a caller outside a build leaves it out and gets the bot's bare hunt.
function create(state, { timestamp = Date.now(), mode, persona, deathHours, moneyWeight: weight = moneyWeight(state), price, hunt } = {}) {
    const Table = invoke('GameServer/Bot/AI/SpotValueTable');
    const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
    const Learning = invoke('GameServer/Bot/AI/KnowledgeLearning');
    const Valuation = invoke('GameServer/Bot/Economy/EconomicValuation');
    const Tendency = invoke('GameServer/Bot/AI/TendencyRoll');
    const positive = value => Math.max(0, Number(value) || 0);
    persona ||= invoke('GameServer/Bot/AI/BotPersona').of(state) || { traits: {}, understanding: 0.3 };
    const tableRole = BotRoles.tableRoleFor(state);
    hunt ??= Hunt.huntIncome(state, timestamp, mode);
    const hourAdena = Hunt.hourValue(state, timestamp, { hunt }).perHour;
    deathHours ??= Valuation.deathHours(state, hunt);
    const riskWeight = Valuation.riskWeight(state, persona);
    const costs = Hunt.consumablePrices(state, price);
    const rewardOptions = { spoilSkillLevel: KillRewards.spoilLevelOf(state) };
    const own = Hunt.sampledRows(state, timestamp, mode);
    const calibrations = own.flatMap(row => {
        const base = Table.value(row.spotId, tableRole, state.level, true, rewardOptions);
        return base?.exp > 0 ? [Math.max(0, row.exp) / row.cycleMs * 3600000 / base.exp] : [];
    });
    const calibration = calibrations.length ? calibrations.reduce((sum, value) => sum + value, 0) / calibrations.length : 1;
    const incomeError = Learning.knowledgeEnabled() ? Learning.stageError(0.03 + 0.25 * (1 - Number(persona.understanding ?? 0.3)),
        0.03, state.stats?.lifelongKills ?? state.stats?.fightsWon ?? 0, Learning.gradeOfLevel(state.level)) : 0;
    const value = (spot, shots = hunt.useShots !== false) => {
        // Charged observations cannot estimate a deliberately uncharged hunt.
        const observed = shots ? own.find(row => row.spotId === spot.id) : null;
        const rate = observed ? 3600000 / observed.cycleMs : 0;
        const theoretical = Table.value(spot.id, tableRole, state.level, shots, rewardOptions);
        const base = observed ? {
            exp: observed.exp * rate, adena: observed.adena * rate, loot: observed.loot * rate,
            kills: observed.kills * rate, deaths: theoretical?.deaths || 0, costs: Number(observed.costs || 0) * rate
        } : theoretical;
        if (!base) return null;
        const bias = 1 + incomeError * (2 * Tendency.roll('spot-income', state.characterId, spot.id) - 1);
        const scale = observed ? 1 : calibration;
        // No crowd divisor: the bot's own observed row already carries the share it got (ARCH-08-b).
        const loot = base.loot + base.kills * Table.marketLoot(spot.id, tableRole, state.level, shots, rewardOptions);
        const row = { ...base, useShots: shots, exp: base.exp * scale * bias,
            adena: base.adena * scale * bias, loot: loot * scale * bias,
            kills: base.kills * scale };
        // Own deaths calibrate danger independently, then receive the same
        // learned personal evaluation floor as income.
        const sample = state.stats?.spotRisk?.spotId === spot.id ? state.stats.spotRisk : null;
        if (sample?.windowFights > 0) row.deaths = row.kills * positive(sample.windowDeaths) / sample.windowFights;
        const riskBias = 1 + incomeError * (2 * Tendency.roll('spot-danger', state.characterId, spot.id) - 1);
        row.deaths *= riskBias;
        row.riskHours = row.deaths * deathHours * riskWeight;
        row.costs = observed ? Number(observed.costs || 0) * rate
            : (Number(base.shots || 0) * costs.shots + Number(base.potions || 0) * costs.potions) * calibration;
        row.income = row.adena + row.loot - row.costs;
        // Value hours one adena of loot at the row's kills adds (valueHoursWithout).
        row.lootHours = weight * bias / hourAdena;
        row.valueHours = row.exp / Math.max(1, hunt.expPerHour) * (1 - weight)
            + row.income / hourAdena * weight - row.riskHours;
        return row;
    };
    return value;
}
// One item's own loot out of a spot row's hour value: a source farming that
// item for a goal counts it once, as the goal, not also as the hour's income
// (GearAcquisitionPlanner sourceFacts). The item as the row's loot counts it:
// every NPC's drop and, by the bot's Spoil, spoil (SpotRewardExpectation
// lootPremium's walk), a unit at its NPC price and its demand premium
// (SpotValueTable.marketLoot). ownLoot(state, itemId): read once per caller;
// it keeps the per-kill loot of each spot it is asked for.
function ownLoot(state, itemId) {
    const id = Number(itemId);
    return { id, level: Number(state.level) || 1, skill: KillRewards.spoilLevelOf(state), perKill: new Map(),
        // lazy: cycle DemandPrice -> FirstPrice -> SpotValueTable -> this module
        price: SpotRewardExpectation.itemPrice(id) + invoke('GameServer/Bot/Economy/DemandPrice').premium(id) };
}
function valueHoursWithout(row, spot, own) {
    if (!(own.price > 0) || !(row.lootHours > 0)) return row.valueHours;
    let perKill = own.perKill.get(spot);
    if (perKill === undefined) own.perKill.set(spot, perKill = SpotRewardExpectation.lootPremium(spot, own.level,
        id => id === own.id ? own.price : 0, { spoilSkillLevel: own.skill }));
    return row.valueHours - row.kills * perKill * row.lootHours;
}
module.exports = { create, moneyWeight, ownLoot, valueHoursWithout };
