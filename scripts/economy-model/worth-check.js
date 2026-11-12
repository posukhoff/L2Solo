#!/usr/bin/env node
'use strict';

// The two worth formulas (rules/worth.js) against the author's cold combat:
// which ranks gear pieces closer to the income they add. Per class line and
// level (20, 30, 40, 52, 61) two cases: the reference bot (the author's kit)
// with its weapon stepped down, and with one armour piece stepped down (body
// first), each to the piece its kit had some levels earlier (removed where it
// had none). A piece's worth per hour (the share of the bot's hour it adds)
// by today's gear gain, by the hunt cycle, and by the simulated fight
// (scripts/generate-spot-table.js hunt, the spot table's own measurement,
// common random numbers with and without the piece). The hours to the end of
// the grade stage multiply all three alike, so the ranks are taken per hour.
//
// The held spot of a line and level: of the spot table's first spots by
// income for the line and level, the one where a short simulated probe of
// the reference kit dies most often (the table's order on a tie; none dying:
// its first), so the cases include spots where the bot dies; of those where
// the probe kills at least a mob an hour and nets at least half the best
// probe's hour, a spot a bot holds (a spot that nets nothing makes a share of
// its hour meaningless); the full run of the reference kit confirms it nets
// a quarter of its gross hour or more, else the next spot. The hunt cycle
// weighs the held spot with its own. A kill earns the spot table's expected
// money per kill at the spot (the drops are a lottery a run's hours do not
// average out); a death costs the exp it loses over the exp per hour plus
// the walk back from the held spot (WalkBack over the hunt tables' spot
// centers, design-income.walkBackHours).
//
// The noise: at each line and level the reference kit runs again under
// another seed (the generator seeds a run by its spot id, class and level;
// the spot's id gets a suffix); the gain between the two identical kits is
// the noise of a simulated gain. A gain counts where it is above the noise's
// 90th percentile.
//
//   node scripts/economy-model/worth-check.js [--hours 60] [--probe 3] [--lines 46,9] [--levels 20,40]
//
// Prints per case the simulated gain and the two formulas, the noise, and the
// Spearman rank correlation of each formula with the simulated gain, with
// its 95 % interval (Fisher z, Fieller's 1.06 / (n - 3) variance), for
// weapons, armour and all, over all cases and over the counted gains; and the
// share of counted cases whose formula / simulated gain lies outside
// 0.85-1.15 (a reading of the agreement, not the design's threshold for the
// hunt cycle against resolveSolo). Progress per case to stderr. Game data at x1.

const fs = require('fs');
const path = require('path');
const Boot = require('./boot');
const Worth = require('./rules/worth');
const Generator = require('../generate-spot-table');
const Income = require('./design-income');

const LINES = Object.freeze(['46', '9', '40', '55', '2', '8', '5', '12']);
const LEVELS = Object.freeze([20, 30, 40, 52, 61]);
// The armour slots in the order a case takes them: body, legs, helmet,
// gloves, boots, shield.
const ARMOUR_SLOTS = Object.freeze([10, 11, 6, 9, 12, 8]);
const STEP_DOWN = Object.freeze([10, 15, 20]);
const AGREE = Object.freeze([0.85, 1.15]);
const PROBE_SPOTS = 6, PROBE_NET_SHARE = 0.5;
// The least share of its gross hour a kit nets for a share of its net hour
// to be read: nearer 0 a gain of a few kills reads as a multiple.
const NET_OF_GROSS = 0.25;
const pays = sim => sim.hour >= NET_OF_GROSS * sim.gross && sim.hour > 0;
const NOISE_QUANTILE = 0.9;

// Ranks with ties at their mean rank.
function ranks(values) {
    const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
    const out = new Array(values.length);
    for (let at = 0; at < order.length;) {
        let end = at;
        while (end + 1 < order.length && order[end + 1].value === order[at].value) end++;
        for (let k = at; k <= end; k++) out[order[k].index] = (at + end) / 2 + 1;
        at = end + 1;
    }
    return out;
}

function spearman(a, b) {
    const ra = ranks(a), rb = ranks(b), n = a.length;
    const mean = (n + 1) / 2;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) { num += (ra[i] - mean) * (rb[i] - mean); da += (ra[i] - mean) ** 2; db += (rb[i] - mean) ** 2; }
    return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

// The 95 % interval of a Spearman correlation of n pairs (Fisher z with
// Fieller, Hartley and Pearson's variance 1.06 / (n - 3)).
function interval(rho, n) {
    if (n < 5) return [NaN, NaN];
    const z = Math.atanh(Math.max(-0.999999, Math.min(0.999999, rho))), half = 1.96 * Math.sqrt(1.06 / (n - 3));
    return [Math.tanh(z - half), Math.tanh(z + half)];
}

function quantile(values, q) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : NaN;
}

function owners() {
    return {
        Data: invoke('GameServer/DataCache'),
        Index: require('../../src/GameServer/Item/ItemTemplateIndex'),
        Table: invoke('GameServer/Bot/AI/SpotValueTable'),
        HuntCycle: invoke('GameServer/Bot/AI/HuntCycle'),
        Profile: invoke('GameServer/Bot/Population/ColdCombatProfile'),
        Hunt: invoke('GameServer/Bot/AI/BotHuntEfficiency'),
        BotGear: invoke('GameServer/Bot/AI/BotGear'),
        Equipment: require('../../src/GameServer/Bot/AI/BotEquipmentCompatibility'),
        Valuation: invoke('GameServer/Bot/Economy/EconomicValuation'),
        Rewards: invoke('GameServer/Bot/Economy/SpotRewardExpectation'),
        Caster: invoke('GameServer/Bot/Economy/BotImprovementPolicy')
    };
}

function kitPiece(kit, slot, Equipment) {
    return kit.find(row => slot === 'weapon' ? Equipment.isWeaponSlot(row.slot) : Number(row.slot) === slot) || null;
}

// The case's piece and what replaces it: the reference kit's piece in the
// slot and the first different one its kit had STEP_DOWN levels earlier
// (null: none, the slot stays empty). null when the kit has no such piece.
function stepDown(o, line, level, slot) {
    const classId = Generator.classFor(line, level), lineClass = Generator.lineClassFor(line);
    const kitAt = at => {
        const atClass = Generator.classFor(line, at);
        return o.BotGear.planFor({ classId: atClass, level: at, characterId: o.HuntCycle.referenceId(atClass, lineClass) }).items;
    };
    const piece = kitPiece(kitAt(level), slot, o.Equipment);
    if (!piece) return null;
    for (const down of STEP_DOWN) {
        const lower = level - down >= 1 ? kitPiece(kitAt(level - down), slot, o.Equipment) : null;
        if (lower && Number(lower.selfId) !== Number(piece.selfId)) return { classId, lineClass, piece, lower };
    }
    return { classId, lineClass, piece, lower: null };
}

// Mutates a reference bot's worn kit: the piece's slot (a weapon both hands
// and, for a two-handed one, the shield) gives way to the lower piece.
function kitBefore(o, { piece, lower }) {
    const weapon = o.Equipment.isWeaponSlot(piece.slot);
    return bot => {
        const lowerSlot = lower ? Number(lower.slot) : null;
        const free = weapon ? [7, 14, ...(lowerSlot === 14 ? [8] : [])] : [Number(piece.slot)];
        for (const [key, row] of Object.entries(bot.inventory)) {
            if (!row.equippedSlots?.some(worn => free.includes(Number(worn)))) continue;
            const left = row.equippedSlots.filter(worn => !free.includes(Number(worn)));
            if (!left.length) delete bot.inventory[key];
            else bot.inventory[key] = { ...row, amount: left.length, equippedCount: left.length, equippedSlots: left, slot: left[0] };
        }
        if (lower) bot.inventory[`kit-${lower.selfId}`] = { selfId: Number(lower.selfId), amount: 1, equipped: true, equippedCount: 1, equippedSlots: [lowerSlot], slot: lowerSlot };
    };
}

// A simulated run: kills, deaths, money and consumables spent. seed: a
// suffix of the spot id the generator seeds by ('' the table's own seed).
function simulate(o, spot, line, level, classId, lineClass, hours, kit, seed = '') {
    const sum = Generator.hunt(seed ? { ...spot, id: `${spot.id}${seed}` } : spot, line, level, 1, hours, undefined, kit, classId);
    const bot = o.HuntCycle.referenceState(classId, level, { line: lineClass });
    if (kit) kit(bot);
    const prices = o.Hunt.consumablePrices(bot);
    return { kills: sum.kills, deaths: sum.deaths, money: sum.adena + sum.loot, spent: sum.shots * prices.shots + sum.potions * prices.potions };
}

// The simulated gain of b over a, a share of a's hour. The spot's drops are a
// lottery (one rare piece moves a run's loot several times over): both runs
// earn the spot table's expected money per kill at the spot (perKill), where
// the table has none the money per kill of the two runs together; a death
// costs its hours of a's gross hour.
function simulatedGain(a, b, hours, deathHours, perKill = (a.money + b.money) / Math.max(1, a.kills + b.kills)) {
    const gross = a.kills * perKill / hours;
    const net = side => (side.kills * perKill - side.spent - side.deaths * deathHours * gross) / hours;
    const base = net(a);
    return { gain: base > 0 ? (net(b) - base) / base : 0, hour: base, gross };
}

// A line and level's held spot and noise, and its weapon and armour cases.
function runLevel(o, profiles, line, level, hours, probeHours) {
    const classId = Generator.classFor(line, level), lineClass = Generator.lineClassFor(line);
    const reference = o.HuntCycle.referenceState(classId, level, { line: lineClass });
    const tableRow = o.Table.best(line, level, true, 'income');
    const expPerHour = tableRow?.exp || 0;
    const spoilSkillLevel = o.Rewards.spoilSkillLevel(reference);
    const perKill = spotId => o.Table.cycle(spotId, line, level, true, { spoilSkillLevel })?.money;
    const deathAt = (state, spotId) => o.Valuation.deathHours(state, { expPerHour, walkBackHours: Income.walkBackHours(spotId, state) });
    const ranked = o.Table.rankedIncome(line, level).map(row => row.spotId).filter(id => profiles.has(id)).slice(0, PROBE_SPOTS);
    const probes = ranked.map(spotId => {
        const probe = simulate(o, profiles.get(spotId), line, level, classId, lineClass, probeHours, null);
        return { spotId, deaths: probe.deaths, kills: probe.kills, net: simulatedGain(probe, probe, probeHours, deathAt(reference, spotId), perKill(spotId)).hour };
    });
    const bestNet = Math.max(0, ...probes.map(probe => probe.net));
    const holds = probe => probe.kills >= probeHours && probe.net > 0 && probe.net >= PROBE_NET_SHARE * bestNet;
    // The deadliest first; the full run confirms the spot nets its share, else the next.
    const order = probes.filter(holds).sort((a, b) => b.deaths - a.deaths || probes.indexOf(a) - probes.indexOf(b));
    let held = null, full = null, deathHours = 0;
    for (const probe of order) {
        deathHours = deathAt(reference, probe.spotId);
        full = simulate(o, profiles.get(probe.spotId), line, level, classId, lineClass, hours, null);
        if (full.kills >= hours && pays(simulatedGain(full, full, hours, deathHours, perKill(probe.spotId)))) { held = probe; break; }
    }
    if (!held) return { probes };
    const spot = profiles.get(held.spotId);
    const again = simulate(o, spot, line, level, classId, lineClass, hours, null, '#noise');
    const noise = simulatedGain(full, again, hours, deathHours, perKill(spot.id)).gain;
    const cases = [];
    for (const group of ['weapon', 'armour']) {
        const slots = group === 'weapon' ? ['weapon'] : ARMOUR_SLOTS;
        for (const slot of slots) {
            const row = runCase(o, { line, level, slot, group, spot, deathHours, full, hours, classId, lineClass, perKill: perKill(spot.id) });
            if (row) { cases.push(row); break; }
        }
    }
    return { spotId: held.spotId, probeDeaths: held.deaths, noise, deathHours, cases };
}

// One case: the piece stepped down at the held spot; null where the kit has
// no piece in the slot, or the hunt cycle has no row for the held spot.
function runCase(o, { line, level, slot, group, spot, deathHours, full, hours, classId, lineClass, perKill }) {
    const step = stepDown(o, line, level, slot);
    if (!step) return null;
    const mutate = kitBefore(o, step);
    const state = o.HuntCycle.referenceState(classId, level, { line: lineClass });
    mutate(state);
    const item = o.Index.find(o.Data.items, step.piece.selfId), slotOf = Number(step.piece.slot);
    const candidates = o.Profile.candidateProfiles(state, 0, {});
    const before = candidates.before;
    const after = candidates.after({ free: worn => o.Equipment.equipmentReplacementConflict(slotOf, worn), wear: { selfId: Number(item.selfId), enchant: 0, slot: slotOf } });
    const reader = o.HuntCycle.reader(state, { deathHours, hunt: { spotId: spot.id } });
    const at = reader.spotIds.indexOf(spot.id);
    if (at < 0) return null;
    const caster = o.Caster.isCaster(state);
    const gear = Worth.gearWorth({ before, after, caster, threatMask: 3, deathHours, horizonHours: 1, ownHour: reader.income(before) });
    const cycle = Worth.huntCycleWorth({ incomeWith: reader.hourAt(after, at).income, incomeWithout: reader.hourAt(before, at).income, horizonHours: 1 });
    const without = simulate(o, spot, line, level, classId, lineClass, hours, mutate);
    const sim = simulatedGain(without, full, hours, deathHours, perKill);
    const name = id => o.Index.find(o.Data.items, id)?.template?.name || String(id);
    return { line, level, slot, group, spotId: spot.id, piece: name(step.piece.selfId), lower: step.lower ? name(step.lower.selfId) : '(none)',
        deathHours, deaths: without.deaths + full.deaths, truth: sim.gain, simWithout: sim.hour, pays: pays(sim), gear: gear.perHour, cycle: cycle.perHour };
}

function main(argv) {
    const hours = Number(Boot.option(argv, 'hours', 60)), probeHours = Number(Boot.option(argv, 'probe', 3)), startedAt = Date.now();
    const list = (name, all) => { const text = Boot.option(argv, name, null); return text ? text.split(',').map(value => all.find(item => String(item) === value.trim())).filter(Boolean) : all; };
    const lines = list('lines', LINES), levels = list('levels', LEVELS);
    process.chdir(Boot.root);
    process.env.L2NODE_PROGRESSION_RATE = 'x1';
    const catalogue = Generator.buildCatalogue();
    const file = path.join(Boot.root, 'tmp', `worth-check-catalogue-${process.pid}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ spots: catalogue.spots, profiles: catalogue.profiles }));
    try {
        Generator.loadSimulation(file);
        const o = owners(), profiles = new Map(catalogue.profiles.map(spot => [spot.id, spot]));
        const cases = [], noises = [];
        const pct = value => `${(value * 100).toFixed(1)}%`;
        process.stdout.write(`${['line', 'level', 'group', 'piece', 'replaces', 'spot', 'sim hour', 'sim gain', 'gear gain', 'hunt cycle', 'death h', 'deaths'].join('\t')}\n`);
        for (const line of lines) for (const level of levels) {
            const began = Date.now();
            const result = runLevel(o, profiles, line, level, hours, probeHours);
            if (!result.cases) {
                process.stderr.write(`[${line}@${level}] no held spot (probes ${result.probes.map(p => `${p.spotId} k${p.kills} d${p.deaths} net ${Math.round(p.net)}`).join(', ')})\n`);
                continue;
            }
            noises.push(Math.abs(result.noise));
            for (const row of result.cases) {
                cases.push(row);
                process.stdout.write(`${[line, level, row.group, row.piece, row.lower, row.spotId, Math.round(row.simWithout), pct(row.truth), pct(row.gear), pct(row.cycle), row.deathHours.toFixed(3), row.deaths].join('\t')}\n`);
            }
            process.stderr.write(`[${line}@${level}] ${result.spotId} probe deaths ${result.probeDeaths}, noise ${pct(result.noise)}, `
                + `${result.cases.map(row => `${row.group} ${pct(row.truth)} gear ${pct(row.gear)} cycle ${pct(row.cycle)}`).join('; ')} (${((Date.now() - began) / 1000).toFixed(1)} s)\n`);
        }
        const threshold = quantile(noises, NOISE_QUANTILE);
        // A case whose kit without the piece nets under a quarter of its gross hour has no share of an hour to rank.
        const dropped = cases.filter(row => !row.pays).length;
        cases.splice(0, cases.length, ...cases.filter(row => row.pays));
        const counted = cases.filter(row => Math.abs(row.truth) > threshold);
        console.log(`\n${cases.length} cases (${cases.filter(row => row.group === 'weapon').length} weapon, ${cases.filter(row => row.group === 'armour').length} armour; `
            + `${cases.filter(row => row.deaths > 0).length} with deaths; ${dropped} left out, netting under ${NET_OF_GROSS * 100} % of the gross hour without the piece), `
            + `${hours} simulated hours each side; worth per hour as a share of the bot's hour.`);
        console.log(`Noise (identical kits, two seeds, ${noises.length} pairs): median ${pct(quantile(noises, 0.5))}, 90th percentile ${pct(threshold)}; `
            + `${counted.length} cases with a simulated gain above it are counted.`);
        const groups = [['weapon', row => row.group === 'weapon'], ['armour', row => row.group === 'armour'], ['all', () => true]];
        for (const [name, key] of [['gear gain (today)', 'gear'], ['hunt cycle', 'cycle']]) {
            const parts = [];
            for (const [label, take] of groups) for (const [set, rows] of [['all', cases.filter(take)], ['counted', counted.filter(take)]]) {
                const rho = spearman(rows.map(row => row[key]), rows.map(row => row.truth)), [low, high] = interval(rho, rows.length);
                parts.push(`${label}/${set} n ${rows.length} ${rho.toFixed(2)} [${Number.isFinite(low) ? low.toFixed(2) : '-'}, ${Number.isFinite(high) ? high.toFixed(2) : '-'}]`);
            }
            const outside = counted.filter(row => { const ratio = row[key] / row.truth; return !(ratio >= AGREE[0] && ratio <= AGREE[1]); }).length;
            const ratios = counted.map(row => row[key] / row.truth);
            console.log(`${name}: Spearman ${parts.join('; ')}`);
            console.log(`${' '.repeat(name.length)}  formula / simulated gain outside ${AGREE.join('-')} on counted cases: ${outside}/${counted.length}; median ratio ${ratios.length ? quantile(ratios, 0.5).toFixed(2) : '-'}`);
        }
        process.stderr.write(`done in ${((Date.now() - startedAt) / 1000).toFixed(1)} s\n`);
    } finally {
        fs.rmSync(file, { force: true });
    }
    process.exit(0);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { spearman, ranks };
