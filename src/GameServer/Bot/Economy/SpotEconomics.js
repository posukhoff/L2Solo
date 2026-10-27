'use strict';
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const Production = require('./RecipeProductionIndex');
// Resolved at the first call (cycles); a require per call is a path lookup (L73).
let SpotRewardExpectation = null;
// Shared table evaluation: native facts, own samples and, for the recipe
// scrolls a spot drops or spoils, the shared recipe market facts
// (RecipeProductionIndex.scrollValue, which read no spot value). It never
// reads Context or a bot's pricing, so route and wish readers cannot
// recurse. The scroll gain is real income: it enters the row's loot, so the
// income route (EquipmentIncomeRoute.select) and the hour value read it.
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
// board: the market recipe scrolls are priced at (a build's watched board,
// a board or its getter; EconomyContext.marketBoard resolves an absent one);
// read: the build's input hook, every item the scroll's facts read joins
// its reads (as WishProviders admission keeps them), so a held build and
// the hour value it priced rebuild when one moves.
function create(state, { timestamp = Date.now(), mode, persona, deathHours, moneyWeight: weight = moneyWeight(state), price, hunt, board, read } = {}) {
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
    const rewardOptions = { spoilSkillLevel: (SpotRewardExpectation ||= require('./SpotRewardExpectation')).spoilSkillLevel(state) };
    // The recipe scrolls a kill yields (drops for every hunter, spoils by the
    // spoil skill's landing; the table's units per kill, held with its row)
    // are worth what one craft of their recipe earns at the market
    // (RecipeProductionIndex.scrollValue: the board's held facts, the
    // reader's own lines out) over the NPC price their loot already counts.
    // One scrollValue per distinct scroll per evaluator (scrollValues: a
    // spoiler's 64 spots carry 370-650 scroll rows of 50-100 scrolls; measured
    // 0.4-0.8 ms per build uncached). Its key is the scroll id: board, clock,
    // reader and read hook are this evaluator's constants. Each value keeps
    // the facts items it read and reads them again on a hit: a gear
    // candidate's scratch arena keeps only a surviving candidate's reads, so
    // a value first read by a cut candidate still joins the kept one's (a
    // move of one rebuilds the build and drops this evaluator with its values).
    let market = null, filling = null;
    const scrollValues = new Map();
    const scrollLoot = (spot, shots) => {
        let extra = 0;
        for (const [id, units, npcPrice] of Table.recipeScrolls(spot.id, tableRole, state.level, shots, rewardOptions)) {
            let entry = scrollValues.get(id);
            if (entry === undefined) {
                // lazy: cycle EconomyContext loads this module at its top
                market ||= { board: invoke('GameServer/Bot/Economy/EconomyContext').marketBoard(board), timestamp,
                    characterId: state.characterId, read: read && (item => { filling.push(item); read(item); }) };
                filling = [];
                scrollValues.set(id, entry = { value: Production.scrollValue(id, market) || 0, items: filling });
                filling = null;
            } else if (read) for (const item of entry.items) read(item);
            extra += units * Math.max(0, entry.value - npcPrice);
        }
        return extra;
    };
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
        const loot = base.loot + base.kills * scrollLoot(spot, shots);
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
        row.valueHours = row.exp / Math.max(1, hunt.expPerHour) * (1 - weight)
            + row.income / hourAdena * weight - row.riskHours;
        return row;
    };
    return value;
}
module.exports = { create, moneyWeight };
